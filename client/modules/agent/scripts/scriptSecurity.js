/**
 * agent/scripts/scriptSecurity.js - 脚本模块共享安全门禁
 *
 * 抽出 script-tree.js 与 agent/app/main.js 中分散的安全/路径校验函数，
 * 供 LLM 工具（script_manager）与 UI（ScriptTree）单点引用，避免双份实现漂移。
 *
 * 暴露：window.AEScriptSecurity
 *   getDefaultScriptDir()                 — 数据目录/agent/scripts（固定，不再支持用户自定义）
 *   normalizeScriptDir(dir)               — 规范化目录路径，必须含 /scripts 段（AEFS _safeForDelete 白名单）
 *   isDangerousScriptDir(dir)             — 危险目录检测（系统目录/浅层 Users/特殊字符/DOS设备名）
 *   _checkPathSafe(p)                     — 轻量路径校验（对齐 AEFS._checkPath，在回退 ExtendScript 之前使用）
 *   inScriptsNamespace(path)              — 必须含 /scripts/ 段且非系统目录
 *   validateName(name)                    — 文件/文件夹名称合法性校验
 */
(function (global) {
    'use strict';

    // ── 默认脚本目录：数据目录/agent/scripts（不再支持用户自定义）──
    function getDefaultScriptDir() {
        if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
            return global.AEShared.getDataDir().dir + '\\agent\\scripts';
        }
        return '';
    }

    // 规范化脚本目录：必须含 scripts 段（AEFS _safeForDelete 白名单要求）
    // 压缩中间连续分隔符——数据目录含 \\ （如 E:\a\\b）时不压缩就会
    // 产出带 // 的基准路径，下游 fwd（已压缩）比较永不相等 → script_manager
    // 全部 mode 报「不在基准下」（fail-closed 瘫痪）。
    function normalizeScriptDir(dir) {
        if (!dir) return '';
        var d = dir.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/g, '');
        // 已以 /scripts 结尾 → 不用改（用压缩后的 d 而非原始 dir，同步清理中间//与尾/）
        if (d.slice(-8) === '/scripts') return d.replace(/\//g, '\\');
        // 否则追加 /scripts
        return (d + '/scripts').replace(/\//g, '\\');
    }

    function isDangerousScriptDir(dir) {
        if (!dir) return false;
        // 特殊字符检测（对齐 AEFS._checkPath）— 防止 ExtendScript 注入
        if (dir.indexOf('%') !== -1) return true;
        for (var k = 0; k < dir.length; k++) {
            var ch = dir.charCodeAt(k);
            if (ch <= 0x1F || ch === 0x7F || ch === 0x22 || ch === 0x27) return true;
        }
        if (/(^|[\\\/\:])\.\.([\\\/\:]|$)/.test(dir)) return true;
        if (/(^|[\\\/\:])\.([\\\/\:]|$)/.test(dir)) return true;

        // ④ 绝对路径验证 + file:/// 规范化（对齐 AEFS._checkPath 步骤④）
        var cleaned = dir.replace(/\\/g, '/').replace(/\/+/g, '/');
        if (/^file:\/+/i.test(cleaned)) {
            cleaned = cleaned.replace(/^file:\/+/i, '');
            if (!/^[A-Za-z][:\|]\//.test(cleaned)) return true;
            cleaned = cleaned.replace(/\|/g, ':');
        } else if (!/^[A-Za-z]:\//.test(cleaned)) {
            return true; // 非绝对路径，拒
        }

        // ⑤ DOS 设备名检测（对齐 AEFS._checkPath 步骤⑤）
        var segs = cleaned.replace(/\/+$/g, '').split('/');
        for (var j = 0; j < segs.length; j++) {
            var upper = segs[j].replace(/\..*$/, '').toUpperCase();
            if (upper === 'NUL' || upper === 'CON' || upper === 'PRN' || upper === 'AUX' ||
                /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) {
                return true;
            }
        }

        var fwd = cleaned.replace(/\/+$/g, '');
        var depth = fwd.replace(/^[A-Za-z]:\//, '').split('/').filter(function(s){return !!s;}).length;
        var lower = fwd.toLowerCase();
        return depth === 0
            || /^[A-Za-z]:$/.test(fwd)
            || /^[a-z]:\/windows(\/|$)/.test(lower)
            || /^[a-z]:\/program files(\/|$)/.test(lower)
            || /^[a-z]:\/program files \(x86\)(\/|$)/.test(lower)
            || /^[a-z]:\/programdata(\/|$)/.test(lower)
            || /^[a-z]:\/users(\/|$)/.test(lower) && depth <= 2;
    }

    // 轻量路径校验（对齐 AEFS._checkPath）— 在回退到 ExtendScript 之前使用
    // Script Tree 与 LLM 工具自己的门禁不依赖 AEFS 内部私有函数
    function _checkPathSafe(p) {
        if (!p || typeof p !== 'string') return false;
        // 拒 %（URL 编码攻击）
        if (p.indexOf('%') !== -1) return false;
        // 拒控制字符和引号。 补拒 U+2028/U+2029——
        // 两者是行终止符，执行侧转义只能兜底已落盘的脚本，
        // 生成侧入口必须拒绝，否则与执行侧转义组合成「创建即不可运行」链
        for (var i = 0; i < p.length; i++) {
            var c = p.charCodeAt(i);
            if (c <= 0x1F || c === 0x7F || c === 0x2028 || c === 0x2029 || c === 0x22 || c === 0x27) return false;
        }
        // 拒 . 和 .. 路径段
        if (/(^|[\\\/\:])\.\.([\\\/\:]|$)/.test(p)) return false;
        if (/(^|[\\\/\:])\.([\\\/\:]|$)/.test(p)) return false;
        // 必须绝对路径
        if (!/^[A-Za-z]:[\\\/]/.test(p) && !/^file:\/+/i.test(p)) return false;
        // 拒 DOS 设备名
        var segs = p.replace(/[\\\/]+/g, '/').replace(/\/+$/, '').split('/');
        for (var j = 0; j < segs.length; j++) {
            var upper = segs[j].replace(/\..*$/, '').toUpperCase();
            if (upper === 'NUL' || upper === 'CON' || upper === 'PRN' || upper === 'AUX' ||
                /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) return false;
        }
        return true;
    }

    function inScriptsNamespace(path) {
        if (!path) return false;
        var fwd = path.replace(/\\/g, '/').toLowerCase();
        // 统一去 file:/// 前缀再判定：URI 形态路径不得绕过下方系统目录
        // 排除（纵深防御，_ensurePathInScriptsNamespace 的基准前缀二次校验仍兜底）。
        // 8.3 短名（如 progra~1）归一需查询文件系统，本模块为纯函数不做，
        // 该形态仍由基准前缀二次校验兜底拦截。
        fwd = fwd.replace(/^file:\/+/, '');
        // 排除系统目录（即使含 /scripts/ 段也不放行）
        if (fwd.indexOf('c:/windows/') === 0 || fwd === 'c:/windows') return false;
        if (fwd.indexOf('c:/program files') === 0) return false;
        // C:/Users 浅层目录排除（深度 ≤ 3），深层（含 /scripts 后缀 + 用户指定子目录或 AppData）放行
        // isDangerousScriptDir 已拦 depth≤2 的 C:/Users 裸路径，此处作为补充防线
        if (fwd.indexOf('c:/users/') === 0) {
            var segs = fwd.split('/').filter(function(s){return !!s;});
            if (segs.length <= 3) return false;
        }
        return fwd.indexOf('/scripts/') !== -1 || fwd.slice(-8) === '/scripts';
    }

    function validateName(name) {
        if (!name || typeof name !== 'string') return false;
        // 补拒 U+2028/U+2029（同 _checkPathSafe，行终止符渗入名称段）
        for (var i = 0; i < name.length; i++) {
            var c = name.charCodeAt(i);
            if (c <= 0x1F || c === 0x7F || c === 0x2028 || c === 0x2029 || c === 0x22 || c === 0x27) return false;
        }
        if (name.indexOf('%') !== -1) return false;  // 对齐 AEFS._checkPath
        if (/[\\\/\:\*\?\"\<\>\|]/.test(name)) return false;
        if (name === '.' || name === '..') return false;
        // Windows 陷阱名：尾随空格/点会被 Win32 API 静默剥离，落盘结果与请求名
        // 不符且该名称难以再次访问
        if (/[ \.]$/.test(name)) return false;
        var upper = name.replace(/\..*$/, '').toUpperCase();
        if (upper === 'NUL' || upper === 'CON' || upper === 'PRN' || upper === 'AUX' || /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) return false;
        return true;
    }

    global.AEScriptSecurity = {
        getDefaultScriptDir: getDefaultScriptDir,
        normalizeScriptDir: normalizeScriptDir,
        isDangerousScriptDir: isDangerousScriptDir,
        _checkPathSafe: _checkPathSafe,
        inScriptsNamespace: inScriptsNamespace,
        validateName: validateName
    };
})(window);
