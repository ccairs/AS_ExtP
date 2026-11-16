// client/shared/unloadTrace.js — 关面板耗时测量（只测量，不改业务行为）
//
// 背景：关闭面板时 window.beforeunload 里串行执行一整条同步落盘链
// （七条 session store / 画布 / 浮聊 / 桌宠三库），CEP 关闭流程要等渲染进程跑完卸载
// 才回收面板，期间宿主主线程被占住 → AE 短时无响应。但三个 beforeunload 钩子
// 一行日志都没有：panel.log 在关闭后不再写，时间空档法不可用，卡了多久无法取证。
//
// 本模块只负责测量：
//   · 关闭时（beforeunload）：begin(hook) → mark(label)… → commit()，把一条记录**同步**
//     写进 localStorage。全程 try/catch、单条记录只在 commit 时写一次，毫秒级，
//     不新增任何文件 IO，避免测量本身拖慢关闭链。
//   · 下次启动（bootstrap 完成）：reportOnce() 把 localStorage 里的记录追加到
//     <数据目录>\temp\logs\unload-timing.log（JSON Lines），成功后清空。
//   记录字段：v/sessionTs/hook/totalMs/absEnd/marks/桥同步统计。
//
// 约束：
//   · 任何入口失败都静默返回（测量故障不得影响关闭/业务）；
//   · 转存失败时保留 localStorage 记录，下次启动再试；
//   · 同一 sessionTs 的多条记录按 hook 拼接即一次完整关闭的渲染侧耗时。
(function (global) {
    'use strict';

    var KEY = 'ae_extp_unload_trace_v1';
    var MAX_RECORDS = 200;              // localStorage 最多保留记录数（一次关闭 1-3 条）
    var REPORT_MAX_BYTES = 256 * 1024;  // 转存文件保留末尾大小，防无限增长
    var FILE_NAME = 'unload-timing.log';

    var _t0 = null;       // performance.now 基准：首个钩子 begin 时设，跨钩子共享
    var _sessionTs = 0;   // 本次关闭的墙钟时间（毫秒），用于拼接三个钩子
    var _hook = null;     // 当前钩子名
    var _marks = [];      // 当前钩子的分段 [{label, at}]
    var _committed = false;

    function _now() {
        try {
            if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
                return performance.now();
            }
        } catch (_) {}
        return Date.now();
    }

    function _round(v) { return Math.round(v * 100) / 100; }

    function _storage() {
        try {
            if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
        } catch (_) {}
        return null;
    }

    function _readRecords() {
        var st = _storage();
        if (!st) return [];
        try {
            var raw = st.getItem(KEY);
            if (!raw) return [];
            var arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (_) {
            return [];
        }
    }

    function _writeRecords(arr) {
        var st = _storage();
        if (!st) return;
        try { st.setItem(KEY, JSON.stringify(arr)); } catch (_) {}
    }

    // 桥同步 XHR 统计（bridge.js 提供；旧版/测试桩没有则跳过）。只在首次 begin 时清零，
    // 避免第二个钩子的 begin 把第一个钩子的计数冲掉。
    function _resetBridgeStats() {
        try {
            if (global.Bridge && typeof global.Bridge.resetSyncCallStats === 'function') {
                global.Bridge.resetSyncCallStats();
            }
        } catch (_) {}
    }

    function _readBridgeStats() {
        try {
            if (global.Bridge && typeof global.Bridge.getSyncCallStats === 'function') {
                return global.Bridge.getSyncCallStats();
            }
        } catch (_) {}
        return null;
    }

    /** 钩子入口：首个钩子设共享基准；每个钩子重置本钩子分段。 */
    function begin(hook) {
        try {
            if (_t0 === null) {
                _t0 = _now();
                _sessionTs = Date.now();
                _resetBridgeStats();
            }
            _hook = String(hook || 'unknown');
            _marks = [];
            _committed = false;
        } catch (_) {}
    }

    /** 分段标记：at = 距本次关闭首个钩子起的毫秒数（跨钩子可比）。 */
    function mark(label) {
        try {
            if (_committed) return;
            var at = (_t0 === null) ? 0 : (_now() - _t0);
            _marks.push({ label: String(label || ''), at: _round(at) });
        } catch (_) {}
    }

    /** 钩子结束：写一条记录进 localStorage（同步、一次）。 */
    function commit() {
        try {
            if (_committed || _hook === null) return;
            _committed = true;
            var rec = {
                v: 1,
                sessionTs: _sessionTs,
                hook: _hook,
                totalMs: _t0 === null ? 0 : _round(_now() - _t0),
                absEnd: Date.now(),
                marks: _marks.slice()
            };
            var sync = _readBridgeStats();
            if (sync) rec.syncXhr = sync;
            var arr = _readRecords();
            arr.push(rec);
            if (arr.length > MAX_RECORDS) arr = arr.slice(arr.length - MAX_RECORDS);
            _writeRecords(arr);
            _marks = [];
        } catch (_) {}
    }

    function _dataDir() {
        try {
            if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                var d = global.AEShared.getDataDir();
                if (typeof d === 'string' && d) return d;
                if (d && typeof d.dir === 'string' && d.dir) return d.dir;
            }
        } catch (_) {}
        return '';
    }

    function _filePath() {
        var dir = _dataDir();
        if (!dir) return '';
        return String(dir).replace(/[\\\/]+$/, '') + '\\temp\\logs\\' + FILE_NAME;
    }

    /**
     * 面板启动时调用：把上一轮关闭留在 localStorage 的记录转存到 temp/logs/unload-timing.log。
     * @returns {boolean} true = 转存成功（localStorage 已清空）；false = 无数据/通道未就绪/失败（保留待重试）
     */
    function reportOnce() {
        try {
            var arr = _readRecords();
            if (!arr.length) return false;
            var fp = _filePath();
            var io = global.AEFS;
            if (!fp || !io || typeof io.writeFileSync !== 'function') return false;
            var prev = null;
            try {
                if (typeof io.readFileSync === 'function') prev = io.readFileSync(fp);
            } catch (_) {
                prev = null;
            }
            var text = (typeof prev === 'string') ? prev : '';
            if (text.length > REPORT_MAX_BYTES) text = text.slice(text.length - REPORT_MAX_BYTES);
            var i;
            for (i = 0; i < arr.length; i++) {
                try { text += JSON.stringify(arr[i]) + '\n'; } catch (_) {}
            }
            if (io.writeFileSync(fp, text) === false) return false;
            var st = _storage();
            if (st) {
                try { st.removeItem(KEY); } catch (_) {}
            }
            return true;
        } catch (_) {
            return false;
        }
    }

    global.AEUnloadTrace = {
        begin: begin,
        mark: mark,
        commit: commit,
        reportOnce: reportOnce,
        // 诊断/回归用（不参与业务）
        _readRecords: _readRecords,
        _filePath: _filePath,
        _reset: function () {
            _t0 = null;
            _sessionTs = 0;
            _hook = null;
            _marks = [];
            _committed = false;
        }
    };
})(typeof window !== 'undefined' ? window : this);
