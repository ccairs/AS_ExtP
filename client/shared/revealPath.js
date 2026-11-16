(function (global) {
    'use strict';

    // ============================================================
    // 本地路径在 OS 文件管理器中定位（聊天区路径点击的唯一出口）
    //
    // 语义：
    //   · 文件 → 打开所在目录并选中该文件；
    //   · 目录 → 直接打开该目录。
    // 通道顺序：
    //   ① Bridge POST /api/reveal-path —— Node 侧 spawn 数组参数（不经过 shell，
    //      路径里的引号/&/|/% 不会被命令行解释）。Windows = explorer /select,"path"，
    //      macOS = open -R，其余平台打开父目录。
    //   ② ExtendScript Folder.execute —— Bridge 旧版（无该路由）/不可用时回退，
    //      只能打开目录（无法选中文件），结果 mode 如实区分。
    //
    // 为什么不用 cep.util.openURLInDefaultBrowser('file:///…')：那会用默认程序打开文件，
    // 不是定位，也不能选中。
    // 为什么不用 system.callSystem：路径来自聊天文本（LLM 可写），把它拼进命令行是注入面；
    // 且项目在脚本侧禁用系统调用（见 host/api/scriptRunner.jsx 的沙箱口径）。
    //
    // 失败原因（reason）语义：
    //   empty / invalid / unresolved（相对路径但数据根不可用）/ not_found / no_channel /
    //   failed / bridge_timeout
    // ============================================================

    var BRIDGE_TIMEOUT_MS = 5000;

    function _trim(p) {
        return String(p == null ? '' : p).replace(/^\s+|\s+$/g, '');
    }

    function _isAbsolute(p) {
        return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.charAt(0) === '/';
    }

    // 数据根相对路径 → 绝对路径：已是绝对路径原样返回；数据根不可用时返回空串
    //（调用方据此如实报「无法解析」，不猜落点）。
    function toAbsolutePath(p) {
        var s = _trim(p);
        if (!s) return '';
        if (_isAbsolute(s)) return s;
        var abs = '';
        try {
            if (global.AEShared && typeof global.AEShared.fromDataRel === 'function') {
                abs = global.AEShared.fromDataRel(s);
            }
        } catch (_) { abs = ''; }
        if (!abs || !_isAbsolute(abs)) return '';
        // fromDataRelPath 统一以 '/' 拼；Windows 盘符/UNC 路径还原成反斜杠，
        // explorer 的 /select 参数只保证吃反斜杠形态。
        if (/^[A-Za-z]:/.test(abs) || /^\\\\/.test(abs)) abs = abs.replace(/\//g, '\\');
        return abs;
    }

    // 拼进 ExtendScript 字符串字面量：反斜杠/双引号防注入，U+2028/U+2029 是 ES3
    // 字面量行终止符（NTFS 文件名合法字符，不转义会让 evalScript 解析失败）。
    // 与 main.js 的 _openFolderInOS、projectAssetView 的 _escPath 同款转义链。
    function _escScriptString(p) {
        return String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
            .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    }

    function _postReveal(abs) {
        var Bridge = global.Bridge;
        if (!Bridge || typeof Bridge.getBridgeUrl !== 'function' || typeof global.fetch !== 'function') {
            return Promise.resolve(null);
        }
        var url;
        try { url = Bridge.getBridgeUrl() + '/api/reveal-path'; } catch (_) { return Promise.resolve(null); }
        var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
        var timer = null;
        var init = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: abs })
        };
        if (ctrl) {
            init.signal = ctrl.signal;
            timer = setTimeout(function () {
                try { ctrl.abort(); } catch (_) {}
            }, BRIDGE_TIMEOUT_MS);
        }
        return global.fetch(url, init).then(function (res) {
            return (res && typeof res.json === 'function')
                ? res.json().catch(function () { return null; })
                : null;
        }).catch(function () {
            return null;   // Bridge 未启动/半死/超时：交给 ExtendScript 回退
        }).then(function (j) {
            if (timer) { clearTimeout(timer); timer = null; }
            return j;
        });
    }

    // 回退通道：ExtendScript 只能打开目录（Folder.execute），不能选中文件。
    function _fallbackOpenFolder(abs) {
        return new Promise(function (resolve) {
            if (typeof global.CSInterface !== 'function') {
                resolve({ ok: false, reason: 'no_channel', path: abs });
                return;
            }
            var e = _escScriptString(abs);
            var script = '(function(){var f=new File("' + e + '");'
                + 'if(f.exists){var p=f.parent;if(!p||!p.exists){return "NOT_EXISTS";}'
                + 'return p.execute()?"OK":"FAIL";}'
                + 'var d=new Folder("' + e + '");if(!d.exists){return "NOT_EXISTS";}'
                + 'return d.execute()?"OK":"FAIL";})();';
            try {
                new global.CSInterface().evalScript(script, function (res) {
                    var r = String(res == null ? '' : res).trim();
                    if (r === 'OK') resolve({ ok: true, mode: 'open-folder', path: abs });
                    else if (r === 'NOT_EXISTS') resolve({ ok: false, reason: 'not_found', path: abs });
                    else resolve({ ok: false, reason: 'failed', path: abs });
                });
            } catch (_) {
                resolve({ ok: false, reason: 'failed', path: abs });
            }
        });
    }

    /**
     * 打开本地路径（文件 = 所在目录并选中；目录 = 直接打开）。
     * 永不 reject：失败经 { ok:false, reason } 如实返回，调用方据此提示。
     * @param {string} p 绝对路径或数据根相对路径
     * @returns {Promise<{ok:boolean, mode?:string, path:string, reason?:string}>}
     */
    function revealPath(p) {
        var raw = _trim(p);
        if (!raw) return Promise.resolve({ ok: false, reason: 'empty', path: '' });
        // 控制字符：Windows 文件名不可能包含；放进 evalScript 字符串字面量还会破坏语句，
        // 故在任何通道之前直接拒绝。
        if (/[\u0000-\u001f]/.test(raw)) {
            return Promise.resolve({ ok: false, reason: 'invalid', path: raw });
        }
        var abs = toAbsolutePath(raw);
        if (!abs) return Promise.resolve({ ok: false, reason: 'unresolved', path: raw });
        return _postReveal(abs).then(function (j) {
            if (j && j.ok === true) {
                return { ok: true, mode: j.mode || '', path: abs };
            }
            // Bridge 明确判定不存在：不回退（回退只会再报一次不存在）
            if (j && j.error === 'not_found') {
                return { ok: false, reason: 'not_found', path: abs };
            }
            // null（不可用/旧版 404/超时）→ 回退 ExtendScript
            return _fallbackOpenFolder(abs);
        });
    }

    global.AEShared = global.AEShared || {};
    global.AEShared.toAbsolutePath = toAbsolutePath;
    global.AEShared.revealPath = revealPath;
})(window);
