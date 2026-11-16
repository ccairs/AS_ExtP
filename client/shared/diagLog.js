/**
 * 诊断日志：面板侧常开落盘 + 一键导出诊断包
 *
 * 目标（用户支持工作流）：用户出问题 → 点「导出诊断日志」→ 把生成的文件发回来 → 直接定位。
 * 为此两件事必须成立：
 *   ① **常开落盘**：不能要求用户「先开 DEBUG 再复现」。且 CEP 面板重载会销毁 JS 上下文，
 *      「崩溃时才 flush」对面板不成立——只能在运行中持续追加。
 *   ② **体积有界**：所有落盘都有上限（保留尾部），长期使用不会无限增长。
 *
 * 落盘口径：
 *   面板日志   <数据目录>\temp\logs\panel.log       1MB 上限 → 超限保留末尾 512KB
 *   诊断包     <数据目录>\temp\diag\diag-<时间戳>.txt 只保留最近 5 份，包内每段只收尾部
 *
 * 为什么是「内存镜像 + 整份重写」而不是 append：
 *   AEFS 公开 API 没有 append 语义（aefs.js 里的 f.open("a") 只是 writeFileBase64
 *   分块写内部实现）。故本模块维护一份内存镜像，按刷新节奏整份重写；为控制 I/O，
 *   刷新有**最小间隔**与**字节阈值**双重节流，内存缓冲本身也有硬上限。
 *
 * 与 logger.js 的分工：
 *   logger.js 负责劫持 console 与底栏渲染（含 debugMode 门控）；
 *   本模块负责落盘与打包，**不受 debugMode 门控**（否则用户复现时没有日志）。
 *   脱敏统一用 logger.js 的 redact（单一实现，本模块不复制一份），**落盘与打包都施加**
 *   ——本地日志可能被用户原样贴出或提交，写入磁盘时即脱敏；打包再脱敏一次（幂等）。
 */
(function () {
    'use strict';

    // ===== 体积与节奏口径 =====
    var LOG_MAX_BYTES = 1024 * 1024;        // panel.log 上限
    var LOG_KEEP_BYTES = 512 * 1024;        // 超限后保留末尾
    var FLUSH_MIN_MS = 3000;                // 刷新最小间隔（节流）
    var FLUSH_THRESHOLD = 32 * 1024;        // 缓冲达此字节即尝试刷新
    var FLUSH_TIMER_MS = 3000;              // 空闲兜底刷新
    var BUF_CAP_BYTES = 256 * 1024;         // 内存缓冲硬上限（超出丢最老）
    var TAIL_BYTES = 64 * 1024;             // 包内每个日志只取尾部
    // 超过此值不读原文，只报大小。注意：AEFS 没有「带偏移读」，取尾部只能整份读入再
    // 截断，所以「读」的代价是按文件大小算的不是按 TAIL_BYTES 算的——导出时最坏会读
    // 入 ~24MB（as_effect_host.log 上限 16MB + trace 4MB + 其余各 1MB），面板会有可感
    // 的停顿（数百毫秒量级，非卡死）。这是用户主动触发的低频动作，故接受并在此写明。
    var MAX_READ_BYTES = 32 * 1024 * 1024;
    var BUNDLE_KEEP = 5;                    // 诊断包保留份数
    var EXT_LOG_MAX_BYTES = 1024 * 1024;    // 外部日志兜底上限（as_hotbox.log 在 C++ 侧根治前的护栏）
    var EXT_LOG_KEEP_BYTES = 512 * 1024;
    var CAP_INTERVAL_MS = 30 * 60 * 1000;

    // ===== 依赖注入（测试用；生产走全局）=====
    var _io = null;              // AEFS 兼容对象
    var _getDataDir = null;
    var _getTempDir = null;
    var _getExtDir = null;
    var _getEnv = null;          // 返回环境信息对象（AE 版本等）
    var _getRing = null;         // 返回面板 verbose 环快照 [{level,text}]
    var _redactFn = null;
    var _timers = [];

    function _win() { return typeof window !== 'undefined' ? window : null; }

    function io() {
        if (_io) return _io;
        var w = _win();
        return (w && w.AEFS) || null;
    }

    function dataDir() {
        try {
            if (_getDataDir) return _asDirString(_getDataDir());
            var w = _win();
            // AEShared.getDataDir() 返回的是对象 { dir }（dataDir.js:455 导出），不是字符串；
            // 且 initDataDir 完成前可能是 { dir:'' }——本函数每次刷新都重新解析，
            // 故数据目录晚就绪时只是前几次刷新跳过，之后自动接上。
            if (w && w.AEShared && typeof w.AEShared.getDataDir === 'function') {
                return _asDirString(w.AEShared.getDataDir());
            }
        } catch (_) {}
        return '';
    }

    // 兼容两种形状：字符串，或 dataDir.js 的 { dir } 结果对象
    function _asDirString(v) {
        if (typeof v === 'string') return v;
        if (v && typeof v.dir === 'string') return v.dir;
        return '';
    }

    function _join(dir, rest) {
        if (!dir) return '';
        return String(dir).replace(/[\\\/]+$/, '') + '\\' + rest;
    }

    function logDir() { return _join(dataDir(), 'temp\\logs'); }
    function logPath() { return _join(logDir(), 'panel.log'); }

    // 日志落点候选：日志已统一写数据目录 temp/logs（面板/bridge/宿主/hotbox
    // 同源）；%TEMP% 仅作**遗留兜底**——老会话/老构建写下的日志仍能被诊断包读到。
    // 存在性判断交给读取本身（io.exists 返回 Promise，同步探测选不了路），
    // 故本函数只产候选列表，由读取循环逐个试、取先读到者（都不存在则报数据目录路径缺失）。
    function _logPathCandidates(fileName, legacyTempDir) {
        var list = [_join(logDir(), fileName)];
        if (legacyTempDir) list.push(_join(legacyTempDir, fileName));
        return list;
    }
    function diagDir() { return _join(dataDir(), 'temp\\diag'); }

    // ===== 运行时目录解析 =====
    //
    // 实机导出的包暴露了三个路径错误，全部源于「猜路径」而不是用项目既有的权威来源：
    //   ① %TEMP%：原用 cep.fs.getSystemPath('temp') —— 实机不生效，导致 as_effect_host.log /
    //      trace / as_hotbox.log / ae_bridge_debug.log **四段全空**（报「路径不可解析」）。
    //      改用 ExtendScript `Folder.temp.fsName`，因此必须是异步的。
    //      日志已统一写数据目录 temp/logs，%TEMP% 降级为**遗留候选**
    //      （老构建写下的日志还在这里，仍要读得到）；本解析仍保留，供兜底与自证。
    //   ② ui_debug.log：原找 `<扩展目录>\effects\` —— 实机扩展装在最外层而
    //      `effects/` 在**数据目录**下（native 侧 effectsDirPath() = dataRootDirPath() + "\effects"，
    //      见 effectState.cpp:226），故一直报「文件不存在」。
    //   ③ 扩展根：原用 __adobe_cep__.getSystemPath('extension')，而 AEFS 判断「是否在扩展目录内」
    //      用的是 window.__ext_root（aefs.js _getExtRoot）。AEFS 对 Program Files 的读取靠
    //      **fetch 兜底**，且要求目标路径落在它认的扩展根之内——路径来源不一致会让兜底不触发，
    //      于是扩展目录内的 CSXS/manifest.xml 读不出来（报「扩展版本: (未解析)」）。
    //      改用 __ext_root，与 AEFS 同源。

    var _extRootFromScript = '';
    var _tempDirResolved = null;    // null=未解析；''=解析失败

    // 载入期同步捕获自身脚本地址：diagLog.js 就由扩展目录加载，去掉 /client/shared/<file>
    // 即得扩展根。必须在 IIFE 执行期读 document.currentScript（异步后它就为 null 了）。
    (function () {
        try {
            var ds = (typeof document !== 'undefined') && document.currentScript;
            if (ds && ds.src) {
                var u = decodeURI(String(ds.src)).replace(/^file:\/\/\//, '');
                var m = u.match(/^(.+)\/client\/shared\/[^\/]+$/);
                if (m) _extRootFromScript = m[1].replace(/\//g, '\\');
            }
        } catch (_) {}
    })();

    function extDir() {
        try {
            if (_getExtDir) return _getExtDir() || '';
            var w = _win();
            // 优先 __ext_root：与 AEFS 同源，读扩展目录内的文件（Program Files，需 fetch 兜底）
            // 才会命中兜底判定。其余为降级来源。
            if (w && w.__ext_root) return String(w.__ext_root);
            if (_extRootFromScript) return _extRootFromScript;
            if (w && w.__adobe_cep__ && typeof w.__adobe_cep__.getSystemPath === 'function') {
                return w.__adobe_cep__.getSystemPath('extension') || '';
            }
        } catch (_) {}
        return '';
    }

    // %TEMP%：同步先试 cep.fs（支持则零成本），不生效再走 ExtendScript（异步，权威）。
    function resolveTempDir() {
        if (_getTempDir) return Promise.resolve(_getTempDir() || '');
        if (_tempDirResolved !== null) return Promise.resolve(_tempDirResolved);
        var w = _win();
        try {
            if (w && w.cep && w.cep.fs && typeof w.cep.fs.getSystemPath === 'function') {
                var t = w.cep.fs.getSystemPath('temp');
                if (t) { _tempDirResolved = t; return Promise.resolve(t); }
            }
        } catch (_) {}
        return new Promise(function (resolve) {
            try {
                if (!w || typeof w.CSInterface === 'undefined') return resolve('');
                new w.CSInterface().evalScript(
                    '(function(){try{return Folder.temp.fsName;}catch(e){return "";}})();',
                    function (res) {
                        var p = String(res == null ? '' : res).replace(/[\r\n]+$/, '').trim();
                        _tempDirResolved = p;
                        resolve(p);
                    }
                );
            } catch (_) { _tempDirResolved = ''; resolve(''); }
        });
    }

    // 同步读取已解析的 %TEMP%（未解析返回空）。仅用于 resolveTempDir 之后的调用点。
    function tempDir() {
        if (_getTempDir) return _getTempDir() || '';
        return _tempDirResolved || '';
    }

    function redact(text) {
        try {
            if (_redactFn) return _redactFn(text);
            var w = _win();
            if (w && w.__aeDebugLogger && typeof w.__aeDebugLogger.redact === 'function') {
                return w.__aeDebugLogger.redact(text);
            }
            // logger.js 未就绪：打包前会再试一次；此处保留原文并留下提示（不静默假装已脱敏）
            return text;
        } catch (_) {
            return text;
        }
    }

    function _redactAvailable() {
        if (_redactFn) return true;
        var w = _win();
        return !!(w && w.__aeDebugLogger && typeof w.__aeDebugLogger.redact === 'function');
    }

    function _stamp() { return new Date().toISOString(); }

    // ===== 常开落盘 =====
    var _buf = [];           // 待落盘行
    var _bufBytes = 0;
    var _mirror = null;      // 文件内容内存镜像（首次刷新时从磁盘播种）
    var _lastFlushAt = 0;
    var _flushing = false;
    var _inflight = null;    // 在途落盘的 Promise（供并发 flush 等待）
    var _pending = false;
    var _suppressUntil = 0;  // 写失败后的静默窗口
    var _dirEnsured = null;  // 最近一次 mkdir 成功过的目录（见 _ensureDir）

    // 体积口径用**真 UTF-8 字节**：上限与「共 N 字节」标签若用
    // content.length（UTF-16 码元数），中文日志的实际字节数约 3 倍——包内清单/段头的数字
    // 与实际不符，上限判定也偏松。文本编码成本只在封顶判定与打包时发生（非每行热路径）。
    function _byteLen(s) {
        if (typeof s !== 'string' || !s.length) return 0;
        try {
            if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
        } catch (_) {}
        var n = 0;
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c < 0x80) n += 1;
            else if (c < 0x800) n += 2;
            else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }   // 代理对（4 字节）
            else n += 3;
        }
        return n;
    }

    function _push(level, text) {
        // 落盘前脱敏：面板日志可能被用户直接贴出（不经诊断包），Key/Token/用户名不进磁盘。
        // redact 在 logger.js 未就绪时原样返回；logger 加载后定义 __aeDebugLogger，此后生效。
        var safeText = redact(String(text));
        var line = _stamp() + ' [' + level + '] ' + safeText.replace(/[\r\n]+$/, '') + '\n';
        _buf.push(line);
        // 缓冲上限按**内存**口径（UTF-16 码元）——这里是每行热路径，不逐行编码
        _bufBytes += line.length;
        // 缓冲硬上限：超出丢最老的，保证内存不随日志量无限增长
        while (_bufBytes > BUF_CAP_BYTES && _buf.length > 1) {
            _bufBytes -= _buf[0].length;
            _buf.shift();
        }
    }

    function _capMirror() {
        // 镜像最终要落成文件 → 按真实字节判定（与 LOG_MAX_BYTES 的「字节」承诺一致）
        if (_mirror && _byteLen(_mirror) > LOG_MAX_BYTES) {
            // 保留尾部：按码元切片（字符串无法按字节切），实际保留量略多于 KEEP 字节
            _mirror = _mirror.slice(_mirror.length - LOG_KEEP_BYTES);
        }
    }

    function _writeMirror(ioRef) {
        _capMirror();
        // AEFS 的写失败契约是 resolve(false) 而非 reject（aefs.js 头注「永不 reject」）。
        // 只挂 reject 回调时，一次没写进去的落盘会落进成功分支——回执失真，且下面的
        // 防放大静默窗口永不生效（写失败 → AEFS 自报一条 WARN → 被本模块收进缓冲 →
        // 下一轮再失败 → 自持环）。
        return Promise.resolve(ioRef.writeFile(logPath(), _mirror)).then(
            function (ok) {
                if (ok === false) return _onMirrorWriteFailed();
                return true;
            },
            function () { return _onMirrorWriteFailed(); }
        );
    }

    function _onMirrorWriteFailed() {
        // 写失败必须静默一段时间：AEFS 失败路径自己会 console.warn，
        // 那行又会被本模块收进来 → 下一轮再失败 → 无限放大。
        _suppressUntil = Date.now() + 60000;
        _dirEnsured = null;   // 失败可能来自目录被清/换盘 → 允许下次重建
        return false;
    }

    function _ensureDir(ioRef, dir) {
        if (!dir || !ioRef || typeof ioRef.mkdir !== 'function') return Promise.resolve(false);
        // 目录建成一次即长期存在（temp 清扫只清文件、不删目录），不必每轮 flush 都重发
        // mkdir。每 3 秒一次 mkdir 时——桥离线时每次都要经 ExtendScript 进一次 AE，且
        // AEFS 的「cep.fs.mkdir 不可用」回退告警会被本模块收进缓冲，形成
        // 「探测 → 告警 → 写告警 → 再探测」的自持环（真机日志实证 1130 条 / 98 分钟）。
        // 只在成功后置位：失败（含真删除过目录）不缓存，仍按原节奏重试。
        if (_dirEnsured === dir) return Promise.resolve(true);
        return Promise.resolve(ioRef.mkdir(dir)).then(
            function () { _dirEnsured = dir; return true; },
            function () { return false; }   // 已存在等错误：忽略
        );
    }

    function _flush(force) {
        var ioRef = io();
        var p = logPath();
        if (!ioRef || !p) return Promise.resolve(false);
        if (_flushing) {
            // 已有一轮落盘在途：**等它结束后再跑一轮**，把期间新入缓冲的行一并写下去。
            // 不能直接 return false——调用方是「导出按钮先 flush 再打包」，拿到 false 会
            // 以为已完成而立即读文件，可能读到写了一半的 panel.log（且新缓冲尚未落盘）。
            var wait = _inflight || Promise.resolve(false);
            return wait.then(function () { return _flush(force); });
        }
        if (!_buf.length) return Promise.resolve(false);

        var now = Date.now();
        if (!force && (now - _lastFlushAt) < FLUSH_MIN_MS) {
            _pending = true;               // 交给定时器，别在节流窗口里抢 I/O
            return Promise.resolve(false);
        }

        var payload = _buf.join('');
        _buf = [];
        _bufBytes = 0;
        _flushing = true;
        _lastFlushAt = now;

        // 首次刷新播种镜像：读一次既有文件，让本次会话接着上一会话继续
        var seed = (_mirror === null)
            ? Promise.resolve(ioRef.exists ? ioRef.exists(p) : true)
                .then(function (has) {
                    if (!has) return '';
                    return Promise.resolve(ioRef.readFile(p)).then(
                        function (content) { return typeof content === 'string' ? content : ''; },
                        function () { return ''; }
                    );
                })
            : Promise.resolve(_mirror);

        _inflight = seed
            .then(function (base) {
                _mirror = base + payload;
                return _ensureDir(ioRef, logDir()).then(function () { return _writeMirror(ioRef); });
            })
            .then(function (ok) {
                _flushing = false;
                if (_pending) { _pending = false; setTimeout(function () { _flush(false); }, FLUSH_MIN_MS); }
                return ok;
            }, function () {
                _flushing = false;
                return false;
            });
        return _inflight;
    }

    function append(level, text) {
        try {
            if (text === undefined || text === null || text === '') return;
            if (Date.now() < _suppressUntil) return;   // 写失败静默窗口内不再堆积
            _push(level, text);
            // 错误类立即落盘（用户可能马上导出）；其余走阈值/定时器
            if (level === 'ERROR') _flush(true);
            else if (_bufBytes >= FLUSH_THRESHOLD) _flush(false);
        } catch (_) {}
    }

    // ===== 外部日志体积收敛（兜底）=====
    // as_hotbox.log 在 C++ 侧根治前的护栏：面板定时检查，超限保留尾部。
    // 只对该文件做（其余 native 日志在 09-11 已有各自上限），避免重复治理。
    // 两个候选都收敛（数据目录新落点 + %TEMP% 遗留文件）：capFile 对不存在的
    // 路径直接返回 false，多一条候选无副作用。
    function externalLogPaths() {
        return _logPathCandidates('as_hotbox.log', tempDir()).map(function (p) {
            return { path: p, max: EXT_LOG_MAX_BYTES, keep: EXT_LOG_KEEP_BYTES };
        });
    }

    function capFile(ioRef, entry) {
        if (!ioRef || !entry || !entry.path) return Promise.resolve(false);
        return Promise.resolve(ioRef.exists ? ioRef.exists(entry.path) : true)
            .then(function (has) {
                if (!has) return false;
                // 用**实际读到的长度**判超限，不用 io.stat().size：本环境该值恒为 0
                //（实机 7 个日志全报 0 字节），据此判体积会失效。
                return Promise.resolve(ioRef.readFile(entry.path)).then(function (content) {
                    if (typeof content !== 'string' || !content.length) return false;
                    // 上限按真 UTF-8 字节（entry.max 的语义就是文件字节）
                    if (_byteLen(content) <= entry.max) return false;   // 未超限：不动文件
                    var tail = _stampTail(content.slice(Math.max(0, content.length - entry.keep)));
                    return Promise.resolve(ioRef.writeFile(entry.path, tail)).then(
                        function () { return true; },
                        function () { return false; }
                    );
                }, function () { return false; });
            })
            .then(function (r) { return r; }, function () { return false; });
    }

    function _stampTail(tail) {
        // 截断后留一条自证记录：否则「日志变短了」无从判断是轮转还是丢失
        if (typeof tail !== 'string' || tail.indexOf('[cap]') === 0) return tail;
        return '[cap] ' + _stamp() + ' 超上限已保留末尾\n' + tail;
    }

    function capExternalLogs() {
        var ioRef = io();
        if (!ioRef) return Promise.resolve(0);
        // 先解析 %TEMP%（异步），再取路径列表——否则列表恒为空、静默不做事
        return resolveTempDir().then(function () {
            var list = externalLogPaths();
            var done = 0;
            return list.reduce(function (chain, entry) {
                return chain.then(function () {
                    return capFile(ioRef, entry).then(function (ok) { if (ok) done++; });
                });
            }, Promise.resolve()).then(function () { return done; });
        });
    }

    // ===== 诊断包 =====
    // 读一段日志并返回结构化结果（供各段与文件清单**共用同一次读取**）。
    // ⚠️ 一切以 content.length 为准，不用 io.stat 的 size：实测本环境（CEP 10 / AE 23.5）
    // AEFS.stat().size **恒为 0**（7 个日志全报 0 字节），既让清单与段头显示错误，
    // 也让 capFile 的体积判断从未生效过（JS 侧兜底成了死代码）。stat 只保留
    // 一个用途——在读之前粗判是否超大文件，避免把 16MB 级文件读进面板。
    function _readSection(ioRef, filePath, note) {
        return Promise.resolve(ioRef.exists ? ioRef.exists(filePath) : true).then(function (has) {
            if (!has) return { path: filePath, missing: true };
            return Promise.resolve(typeof ioRef.stat === 'function' ? ioRef.stat(filePath) : null)
                .then(function (st) { return st && st.size; }, function () { return 0; })
                .then(function (statSize) {
                    if (typeof statSize === 'number' && statSize > MAX_READ_BYTES) {
                        return { path: filePath, oversize: true, size: statSize };
                    }
                    return Promise.resolve(ioRef.readFile(filePath)).then(function (content) {
                        if (typeof content !== 'string') return { path: filePath, readFail: true };
                        var size = _byteLen(content);       // 真实字节 = UTF-8 长度（不是码元数：按码元数中文虚高约 3 倍）
                        // 尾部切片必须按**码元**下标：
                        // 原写法 `content.slice(size - TAIL_BYTES)` 把**字节数**当 slice 下标，而 slice
                        // 用的是码元。中文日志约 1.78 字节/字符 ⇒ `字节 − 码元 ≥ 65536` 成立时该下标
                        // ≥ 串长，切片直接**空**。实测：中文 90000 字符 / 159408 字节 → 段体 **0 字符**；
                        // 50 万码元（panel.log 稳态 `_capMirror` 保留量）/ 924562 字节 → 0 字符
                        //（判据：码元 ≥ ≈84.5K 必然全空）。而段头照旧打印「仅保留末尾 64KB，共 924562
                        // 字节」——**自述与内容相反**，诊断包最关键的 panel.log 段是空的且零提示。
                        // 修法：字节只用于**超限判定**与段头数字，尾部按码元从后往前累计到 TAIL_BYTES 字节。
                        var _tb = 0;
                        var _cut = content.length;
                        while (_cut > 0 && _tb < TAIL_BYTES) {
                            var _cc = content.charCodeAt(_cut - 1);
                            // 代理对按 **4 字节 / 2 码元**整体处理：
                            // 高低代理各按 3 字节计（总 6 字节，虚高 ⇒ 尾部偏短），
                            // 且切点可能落在**高低代理之间** ⇒ 段体首字符是孤立代理（非法 UTF-16，
                            // 写盘/编码后变替换字符）。emoji 密集的日志实测能命中。
                            if (_cc >= 0xDC00 && _cc <= 0xDFFF && _cut >= 2) {
                                var _hi = content.charCodeAt(_cut - 2);
                                if (_hi >= 0xD800 && _hi <= 0xDBFF) { _tb += 4; _cut -= 2; continue; }
                            }
                            _tb += (_cc < 0x80) ? 1 : (_cc < 0x800 ? 2 : 3);
                            _cut--;
                        }
                        var body = size > TAIL_BYTES
                            ? '…（仅保留末尾 ' + Math.round(TAIL_BYTES / 1024) + 'KB，共 ' + size + ' 字节）\n'
                              + content.slice(_cut)
                            : content;
                        return { path: filePath, size: size, body: _collapseRepeats(body) };
                    }, function () { return { path: filePath, readFail: true }; });
                });
        });
    }

    function _sectionText(r) {
        if (!r) return '';
        if (r.ring) return _ringSection() + '\n';
        if (r.skipped) return '(' + r.skipped + ')\n';
        if (r.missing) return '(文件不存在)\n';
        if (r.oversize) return '(超过读取上限 ' + MAX_READ_BYTES + ' 字节，未收录内容；stat 报 ' + r.size + ' 字节)\n';
        if (r.readFail) return '(读取失败)\n';
        return '(文件: ' + r.path + '  (' + r.size + ' 字节))\n' + r.body + '\n';
    }

    function _fileListLines(results) {
        return results.filter(function (r) { return !r.ring; }).map(function (r) {
            if (r.skipped) return r.path || '(路径不可解析)';
            if (r.missing) return r.path + '\t缺失';
            if (r.oversize) return r.path + '\t超过读取上限（stat 报 ' + r.size + ' 字节）';
            if (r.readFail) return r.path + '\t读取失败';
            return r.path + '\t' + r.size + ' 字节';
        });
    }

    function _envSection() {
        var lines = ['生成时间: ' + _stamp(), '数据目录: ' + (dataDir() || '(未解析)')];
        var w = _win();
        try {
            var env = _getEnv ? _getEnv() : (function () {
                if (!w || typeof w.CSInterface === 'undefined') return null;
                return new w.CSInterface().getHostEnvironment();
            })();
            if (env) {
                lines.push('宿主应用: ' + (env.appName || '?') + ' ' + (env.appVersion || '?')
                    + '  语言: ' + (env.appLocale || '?'));
            }
        } catch (_) { lines.push('宿主应用: (读取失败)'); }
        try {
            if (w && w.navigator && w.navigator.userAgent) lines.push('运行环境: ' + w.navigator.userAgent);
        } catch (_) {}
        // 三个状态并列打出来。起因：实机包内只打了「运行时」这一个，而它与底栏开关不一致
        //（运行时 false / 底栏开启），三者各自读哪里需分开确认。
        // 现在把来源也写清楚，这类矛盾一眼可见：
        //   运行时 = AEAgentApp.statusBar.state.debugMode（面板启动按持久化值应用一次；
        //            此后只在「保存全局设置」落盘成功时应用——拨动那个开关不改它）
        //   已保存 = localStorage 权威位置 global.debugMode
        //   底栏   = logger.js 的 isEnabled（加载期按已保存值 latch，之后由调试态应用改写）
        // 读 `statusBar.debugMode` 时——该成员不存在（statusBar
        // 导出的键是 state），`!!undefined` = false，于是「运行时」这一态**恒报 false**，
        // 恰是它要治的那种"报一个错值"的矛盾。
        try {
            lines.push('debugMode(运行时): ' + (w && w.AEAgentApp && w.AEAgentApp.statusBar
                && w.AEAgentApp.statusBar.state
                ? String(!!w.AEAgentApp.statusBar.state.debugMode) : '(未知)'));
        } catch (_) {}
        lines.push('debugMode(已保存): ' + _persistedDebugMode());
        try {
            var d = w && w.__aeDebugLogger;
            lines.push('底栏日志栏: ' + (d && d.isEnabled && d.isEnabled() ? '开启' : '关闭'));
        } catch (_) {}
        lines.push('脱敏: ' + (_redactAvailable() ? '已启用' : '⚠ 未启用（redact 不可用，包内可能含敏感串）'));
        // 自证 %TEMP% 解析结果：日志统一落数据目录 temp/logs，%TEMP% 只剩
        // **遗留候选**（老构建写下的日志）；解析不出来只是少读一处兜底，仍显式报告，
        // 避免"看起来正常其实缺段"（实机曾因 %TEMP% 解析失败导致 4 段全空且包内无提示）。
        var t = tempDir();
        lines.push('遗留日志目录 (%TEMP%): ' + (t || '⚠ 未解析（老构建的宿主/hotbox 日志读不到，新日志不受影响）'));
        return lines.join('\n');
    }

    // 已保存的 debugMode（权威位置 global.debugMode）。把来源一起打出来：
    // 若出现 global 与顶层并存（迁移残留），一眼能看出以哪个为准。
    // 键名字面量在仓库内共三处（settingsStore 为所有者，另两处为 logger.js 与本文件的
    // 加载期读取）；若将来改键，三处需同步——settingsStore.js 的 SETTINGS_KEY 是权威定义。
    function _persistedDebugMode() {
        try {
            var w = _win();
            if (!w || !w.localStorage || typeof w.localStorage.getItem !== 'function') return '(无存储)';
            var raw = w.localStorage.getItem('ae_llm_tool_settings_v3');
            if (!raw) return '(未设置)';
            var p = JSON.parse(raw);
            var hasGlobal = !!(p && p.global && typeof p.global.debugMode === 'boolean');
            var hasTop = !!(p && typeof p.debugMode === 'boolean');
            if (hasGlobal && hasTop && !!p.global.debugMode !== !!p.debugMode) {
                // 迁移残留：两个位置不一致——以 global 为准（logger.js 同口径），并显式标出
                return String(!!p.global.debugMode) + '(global；⚠ 顶层残留 ' + String(!!p.debugMode) + ')';
            }
            if (hasGlobal) return String(!!p.global.debugMode) + '(global)';
            if (hasTop) return String(!!p.debugMode) + '(顶层/迁移前旧形状)';
            return '(未设置)';
        } catch (_) { return '(读取失败)'; }
    }

    function _extVersion() {
        // 尽力从扩展 manifest 取版本（不硬编码常量，避免与 CSXS/manifest.xml 漂移）
        var ioRef = io();
        var d = extDir();
        if (!ioRef || !d || typeof ioRef.readFile !== 'function') return Promise.resolve('');
        var p = _join(d, 'CSXS\\manifest.xml');
        return Promise.resolve(ioRef.readFile(p)).then(function (xml) {
            if (typeof xml !== 'string') return '';
            var m = xml.match(/ExtensionBundleVersion="([^"]+)"/);
            return m ? m[1] : '';
        }, function () { return ''; });
    }

    // ===== 刷屏折叠（包内 96% 是同一行重复）=====
    // 实机包 150KB 中 trace 段占 4227 行，其中 `lc 22` 一个值 1200 行、fopen 探针 1138 行
    // ——真正的信号被淹掉，包也不好读。native 侧已按值去重（治本），这里做**兜底**，
    // 对任何来源的刷屏都生效（面板 / bridge / native / 未来的新探针）。
    //
    // ⚠️ 先试过"只折叠**连续**重复行"，实测效果很差：真实的刷屏行是与其他探针**交错**的
    //（lc 22 / lc 6 / lc 22 / fopen-… 交替），连续段只有几条，于是只压掉一部分、
    // 最后仍靠行数上限截断，等于丢内容而不是去噪。故改为**按签名全局去重**：
    // 同一签名的行整段只保留**首条**并标注总次数与时间跨度，其余丢弃。
    // 这保留了"该行出现过、多少次、什么时间段"（诊断要的），只丢掉逐条重复本身。
    var NOISE_DUP_MIN = 10;        // 同一签名本段出现达到该次数才算刷屏（正常日志不折叠）
    var DUP_SIG_LEN = 200;         // 签名比较长度上限
    var SECTION_MAX_LINES = 800;   // 去重后仍超长则只留尾部（兜底，正常不会再触发）

    function _lineSignature(s) {
        // 去掉行首时间戳（ISO 或 HH:MM:SS）后再比较，否则每行都因时间戳不同而"不重复"
        return String(s)
            .replace(/^\[?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+Z?)?\]?\s*/, '')
            .replace(/^\[?\d{2}:\d{2}:\d{2}\]?\s+/, '')
            .slice(0, DUP_SIG_LEN);
    }

    function _lineStamp(s) {
        var m = String(s).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
             || String(s).match(/^\s*\[?(\d{2}:\d{2}:\d{2})/);
        return m ? (m[1] || m[0]) : '';
    }

    function _collapseRepeats(text) {
        if (!text) return text;
        var lines = String(text).split('\n');
        var stat = {};      // 签名 → { n, first, last }
        var i, sig, s;
        for (i = 0; i < lines.length; i++) {
            sig = _lineSignature(lines[i]);
            if (!sig) continue;                 // 空行/纯时间戳行不参与
            s = stat[sig];
            var stamp = _lineStamp(lines[i]);
            if (!s) { stat[sig] = { n: 1, first: stamp, last: stamp }; continue; }
            s.n++;
            if (stamp) s.last = stamp;
        }

        var emitted = {};
        var out = [];
        for (i = 0; i < lines.length; i++) {
            sig = _lineSignature(lines[i]);
            s = sig ? stat[sig] : null;
            if (!s || s.n < NOISE_DUP_MIN) { out.push(lines[i]); continue; }
            if (emitted[sig]) continue;         // 高频行：只留首条
            emitted[sig] = true;
            out.push(lines[i] + '   ← 本段共 ' + s.n + ' 次'
                + (s.first && s.last && s.first !== s.last ? '（' + s.first + ' → ' + s.last + '）' : ''));
        }
        if (out.length > SECTION_MAX_LINES) {
            var dropped = out.length - SECTION_MAX_LINES;
            return ['…（本段去重后仍过长，已省略前 ' + dropped + ' 行）']
                .concat(out.slice(dropped)).join('\n');
        }
        return out.join('\n');
    }

    function _ringSection() {
        var ring = null;
        try {
            if (_getRing) ring = _getRing();
            else {
                var w = _win();
                if (w && w.__aeDebugLogger && typeof w.__aeDebugLogger.snapshot === 'function') {
                    ring = w.__aeDebugLogger.snapshot();
                }
            }
        } catch (_) {}
        if (!ring || !ring.length) return '（无：debugMode 未开启，或本次会话无 verbose 记录）';
        var out = '共 ' + ring.length + ' 行（debugMode 下的 verbose 环）\n';
        for (var i = 0; i < ring.length; i++) out += ring[i].text + '\n';
        return out;
    }

    function buildBundle() {
        var ioRef = io();
        var parts = [];
        var tasks = [];
        // 先解析 %TEMP%（异步），否则所有走 %TEMP% 的段都会因路径为空而被跳过
        return resolveTempDir().then(function () {
            return _extVersion();
        }).then(function (ver) {
            parts.push([
                '========== AS_ExtP 诊断日志 ==========',
                '扩展版本: ' + (ver || '(未解析)'),
                _envSection(),
                ''
            ].join('\n'));

            var t = tempDir();
            // 路径为空时的提示要能说明原因（实机曾只有一句「路径不可解析」，
            // 看不出是临时目录没解析出来还是代码写错了根）
            var tempNote = t ? '' : '临时目录未解析（见环境头）';
            tasks = [
                ['面板 verbose 环', null, null],
                ['面板日志 (panel.log)', logPath(), '面板日志'],
                ['bridge.log', _join(dataDir(), 'temp\\bridge\\bridge.log'), 'bridge 日志'],
                ['ae_bridge_debug.log (AE 启动链)', _logPathCandidates('ae_bridge_debug.log', t), 'AE 启动链'],
                ['as_effect_host.log', _logPathCandidates('as_effect_host.log', t), '宿主日志'],
                ['as_effect_host_trace.log', _logPathCandidates('as_effect_host_trace.log', t), '宿主 trace'],
                ['as_hotbox.log', _logPathCandidates('as_hotbox.log', t), 'hotbox 日志'],
                ['ui_debug.log', _join(dataDir(), 'effects\\ui_debug.log'), 'ui_debug']
            ];

            // 先收集（含读取），再统一输出：文件清单与各段共用同一次读取，
            // 清单里的体积才是**真实读到的长度**（stat 的 size 本环境恒为 0）
            var results = [];
            return tasks.reduce(function (chain, task) {
                var title = task[0], p = task[1];
                return chain.then(function () {
                    if (title === '面板 verbose 环') {
                        results.push({ title: title, ring: true, path: '(面板内存环)' });
                        return null;
                    }
                    if (!ioRef || !p) {
                        results.push({ title: title, path: p || '(路径不可解析)',
                            skipped: tempNote || '路径不可解析' });
                        return null;
                    }
                    // 候选逐个试：数据目录优先，取第一个「读到了」的（读不到的类型为
                    // missing/readFail 者一律继续试下一个——老构建的日志在 %TEMP%，
                    // 数据目录里那个文件可能压根没建过）
                    var cands = (typeof p === 'string') ? [p] : p;
                    var tryCand = function (ci) {
                        return _readSection(ioRef, cands[ci]).then(function (r) {
                            if (r && (r.missing || r.readFail) && ci + 1 < cands.length) {
                                return tryCand(ci + 1);
                            }
                            // 两处都没有且临时目录没解析出来：把原因写进该段——实机曾只有
                            // 裸的「文件不存在」，看不出是路径没解析还是文件真没有
                            if (r && r.missing && tempNote) r.skipped = tempNote;
                            r.title = title;
                            results.push(r);
                            return null;
                        });
                    };
                    return tryCand(0);
                });
            }, Promise.resolve()).then(function () { return results; });
        }).then(function (results) {
            var list = _fileListLines(results);
            parts.push('[日志文件清单]\n' + (list.length ? list.join('\n') : '(无法枚举)') + '\n');
            results.forEach(function (r) {
                parts.push('========== ' + r.title + ' ==========\n' + _sectionText(r));
            });
            return redact(parts.join('\n'));
        });
    }

    function _compactStamp() {
        return _stamp().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    }

    function pruneBundles(ioRef, dir) {
        if (!ioRef || typeof ioRef.listFiles !== 'function' || typeof ioRef.deleteFile !== 'function') {
            return Promise.resolve(0);
        }
        return Promise.resolve(ioRef.listFiles(dir)).then(function (list) {
            if (!list || !list.length) return 0;
            var names = [];
            for (var i = 0; i < list.length; i++) {
                var item = list[i];
                var name = typeof item === 'string' ? item : (item && (item.name || item.fileName));
                if (name && /^diag-.*\.txt$/i.test(name)) names.push(name);
            }
            names.sort();                                   // 时间戳命名 → 字典序即时间序
            var drop = names.slice(0, Math.max(0, names.length - BUNDLE_KEEP));
            return drop.reduce(function (chain, name) {
                return chain.then(function () {
                    return Promise.resolve(ioRef.deleteFile(_join(dir, name))).then(
                        function () { return 1; }, function () { return 0; }
                    );
                });
            }, Promise.resolve(0));
        }, function () { return 0; });
    }

    function exportBundle() {
        var ioRef = io();
        var dir = diagDir();
        if (!ioRef || !dir) {
            return Promise.resolve({ ok: false, reason: 'AEFS 或数据目录不可用' });
        }
        var filePath = _join(dir, 'diag-' + _compactStamp() + '.txt');
        return buildBundle()
            .then(function (text) {
                return _ensureDir(ioRef, dir).then(function () {
                    return Promise.resolve(ioRef.writeFile(filePath, text)).then(
                        // AEFS 契约——显式 resolve(false) 是写失败（不是成功）。只看
                        // reject，false 落进成功分支 → 诊断包实际未落盘却回执 ok:true/path，
                        // 用户按"已导出"路径找不到文件（支持工作流谎报）。
                        function (ok) {
                            if (ok === false) return { ok: false, reason: '写入失败: ' + filePath };
                            // `bytes` 必须是**字节**：写 text.length
                            // = 码元数，中文包会虚低约一半（同文件别处已用 _byteLen 统一口径）。
                            return { ok: true, path: filePath, bytes: _byteLen(text) };
                        },
                        function () { return { ok: false, reason: '写入失败: ' + filePath }; }
                    );
                });
            })
            .then(function (res) {
                return pruneBundles(ioRef, dir).then(function () { return res; });
            }, function (e) {
                return { ok: false, reason: '打包异常: ' + (e && e.message || e) };
            });
    }

    // ===== 生命周期 =====
    function start() {
        var w = _win();
        if (!w || _timers.length) return;
        _timers.push(setInterval(function () { _flush(false); }, FLUSH_TIMER_MS));
        _timers.push(setInterval(function () { capExternalLogs(); }, CAP_INTERVAL_MS));
        // 启动时先跑一次外部日志收敛，不必等第一个周期
        setTimeout(function () { capExternalLogs(); }, 10 * 1000);
    }

    function stop() {
        for (var i = 0; i < _timers.length; i++) clearInterval(_timers[i]);
        _timers = [];
    }

    var api = {
        start: start,
        stop: stop,
        append: append,
        flush: function () { return _flush(true); },
        buildBundle: buildBundle,
        exportBundle: exportBundle,
        capExternalLogs: capExternalLogs,
        capFile: function (entry) { return capFile(io(), entry); },
        pruneBundles: pruneBundles,
        logPath: logPath,
        diagDir: diagDir,
        // 测试注入：生产不使用
        _configure: function (opts) {
            opts = opts || {};
            if (opts.io !== undefined) _io = opts.io;
            if (opts.getDataDir !== undefined) _getDataDir = opts.getDataDir;
            if (opts.getTempDir !== undefined) _getTempDir = opts.getTempDir;
            if (opts.getExtDir !== undefined) _getExtDir = opts.getExtDir;
            if (opts.getEnv !== undefined) _getEnv = opts.getEnv;
            if (opts.getRing !== undefined) _getRing = opts.getRing;
            if (opts.redact !== undefined) _redactFn = opts.redact;
        },
        _reset: function () {
            _buf = []; _bufBytes = 0; _mirror = null; _lastFlushAt = 0;
            _flushing = false; _inflight = null; _pending = false; _suppressUntil = 0;
            _dirEnsured = null;
            _tempDirResolved = null;
            stop();
        },
        _bufferSize: function () { return _bufBytes; },
        _mirrorLength: function () { return _mirror === null ? -1 : _mirror.length; },
        _dirEnsuredPath: function () { return _dirEnsured; }
    };

    if (typeof window !== 'undefined') window.AEDiagLog = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
