// i18n 运行时。zh-CN 是源文语言：t('源文') 在 zh-CN 下原样返回，
// 其他语言查 locales/<id>.js 注册的字典，未命中回退源文并计入缺 key 统计。
// 语言数据随 scripts.manifest.js 静态加载（CEP 无 Node，不走文件 I/O）。
(function (global) {
    'use strict';

    var SUPPORTED = ['zh-CN', 'en-US', 'ja-JP', 'de-DE', 'ko-KR', 'fr-FR', 'ru-RU'];
    var SOURCE_LOCALE = 'zh-CN';
    var DICT = {};          // id -> { '源文': '译文' }
    var current = SOURCE_LOCALE;
    var missing = Object.create(null);
    var setting = 'auto';
    var LOCALE_KEY = 'ae_ui_locale';
    var SKIP_TAGS = { script: 1, style: 1, textarea: 1, pre: 1, code: 1 };
    var ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-tip'];

    // 语言 id 归一化：下划线→短横线、去大小写差异；只按语言主标签匹配已支持集合。
    function normalizeLocale(raw) {
        var s = String(raw == null ? '' : raw).trim().replace(/_/g, '-').toLowerCase();
        if (!s) return '';
        for (var i = 0; i < SUPPORTED.length; i++) {
            if (SUPPORTED[i].toLowerCase() === s) return SUPPORTED[i];
        }
        var base = s.split('-')[0];
        for (var j = 0; j < SUPPORTED.length; j++) {
            if (SUPPORTED[j].toLowerCase().split('-')[0] === base) return SUPPORTED[j];
        }
        return '';
    }

    // 宿主语言：CEP 的 getHostEnvironment().appLocale；取不到时退回 navigator.language。
    // 返回**原始串**（不在这里判支持与否）——由 resolveLocale 统一归一化，
    // 否则「宿主语言已知但不支持」（es_ES）会被误判成「宿主语言未知」而落到 zh。
    function hostLocale() {
        try {
            if (typeof global.CSInterface === 'function') {
                var env = new global.CSInterface().getHostEnvironment();
                if (env && env.appLocale) return String(env.appLocale);
            }
        } catch (_) {}
        try {
            if (global.navigator && global.navigator.language) return String(global.navigator.language);
        } catch (_) {}
        return '';
    }

    // 'auto'（或空）跟随宿主；显式设置优先；宿主语言已知但不支持时按 en-US，
    // 宿主语言读不到时留在源语言（不猜）。
    function resolveLocale(want, host) {
        var n = normalizeLocale(want);
        if (n) return n;
        var h = normalizeLocale(host);
        if (h) return h;
        return host ? 'en-US' : SOURCE_LOCALE;
    }

    function format(str, params) {
        var s = String(str);
        if (!params) return s;
        return s.replace(/\{(\w+)\}/g, function (m, k) {
            return Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m;
        });
    }

    function t(str, params) {
        if (str == null) return '';
        var key = String(str);
        if (!key) return '';
        var dict = DICT[current];
        var hit = !!(dict && Object.prototype.hasOwnProperty.call(dict, key));
        var out = hit ? dict[key] : key;
        if (!hit && current !== SOURCE_LOCALE) missing[key] = true;
        return format(out, params);
    }

    function register(id, dict) {
        var n = normalizeLocale(id);
        if (!n || n === SOURCE_LOCALE || !dict || typeof dict !== 'object') return false;
        DICT[n] = dict;
        return true;
    }

    // 纯标点片段（「」（）？。之类）不含汉字，不进 keys.json，遂不能走 t()。
    // 调用点给源语言与半角写法：源语言原样返回（zh 输出与改动前逐字节一致），
    // 拉丁语言取半角等价标点；日语同属全角标点，默认沿用源语言写法，
    // 需要日语专有措辞时传第三参（如「行目」「、」）；德语引号是 „…“ 而非半角直引号，
    // 需要德语专有写法时传第四参；韩语引号是 “ ”，传第五参；法语引号是 « »，传第六参；俄语引号是 «»（内侧无空格），传第七参。
    function punct(zh, en, ja, de, ko, fr, ru) {
        if (current === SOURCE_LOCALE || en == null) return String(zh == null ? '' : zh);
        if (current === 'ja-JP') return String(ja == null ? zh : ja);
        if (current === 'de-DE' && de != null) return String(de);
        if (current === 'ko-KR' && ko != null) return String(ko);
        if (current === 'fr-FR' && fr != null) return String(fr);
        if (current === 'ru-RU' && ru != null) return String(ru);
        return String(en);
    }

    function getLocale() { return current; }

    function setLocale(id) {
        // 显式 id 优先；空 / 'auto' / 不支持的值一律按「跟随宿主」解析。
        current = normalizeLocale(id) || resolveLocale('auto', hostLocale());
        applyDocumentLocale();
        return current;
    }

    function getLocaleSetting() {
        try { return global.localStorage.getItem(LOCALE_KEY) || 'auto'; } catch (_) { return 'auto'; }
    }

    function setLocaleSetting(v) {
        setting = String(v || 'auto');
        try { global.localStorage.setItem(LOCALE_KEY, setting); } catch (_) {}
    }

    function applyDocumentLocale() {
        try {
            var el = global.document && global.document.documentElement;
            if (!el) return;
            el.lang = current;
            if (el.setAttribute) el.setAttribute('data-locale', current);
            else if (el.dataset) el.dataset.locale = current;
        } catch (_) {}
    }

    // 静态 DOM 翻译：文本节点 + 白名单属性。zh 下 t() 原样返回，本函数改动数恒为 0。
    // 跳过判定按**祖先链**（与 i18nHtml 的整棵子树语义一致），不是只看直接父节点。
    function inSkippedSubtree(node) {
        var p = node ? node.parentNode : null;
        while (p) {
            if (SKIP_TAGS[String(p.nodeName || '').toLowerCase()]) return true;
            p = p.parentNode;
        }
        return false;
    }

    function translateDom(root) {
        if (!root) return 0;
        var doc = root.ownerDocument || global.document;
        if (!doc) return 0;
        var changed = 0;
        var nodes = [];
        try {
            var walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */, null, false);
            var n;
            while ((n = walker.nextNode())) nodes.push(n);
        } catch (_) { return 0; }
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (inSkippedSubtree(node)) continue;
            var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(node.nodeValue || '');
            if (!m || !m[2]) continue;
            var tr = t(m[2]);
            if (tr === m[2]) continue;
            node.nodeValue = m[1] + tr + m[3];
            changed++;
        }
        try {
            var sel = ATTRS.map(function (a) { return '[' + a + ']'; }).join(',');
            // 属性扫描按 root 作用域；root 不带 querySelectorAll（非 Element 根）时退回 document。
            var els = (root.querySelectorAll ? root : doc).querySelectorAll(sel);
            for (var j = 0; j < els.length; j++) {
                var el = els[j];
                if (inSkippedSubtree(el)) continue;
                for (var k = 0; k < ATTRS.length; k++) {
                    var attr = ATTRS[k];
                    if (!el.hasAttribute || !el.hasAttribute(attr)) continue;
                    var m2 = /^(\s*)([\s\S]*?)(\s*)$/.exec(String(el.getAttribute(attr)));
                    if (!m2 || !m2[2]) continue;
                    var out = t(m2[2]);
                    if (out !== m2[2]) { el.setAttribute(attr, m2[1] + out + m2[3]); changed++; }
                }
            }
        } catch (_) {}
        return changed;
    }

    function init() {
        // 先吸收静态加载的语言包（locales/*.js 在 core 之前执行，用 pending 队列）
        var pending = global.AEI18nPending || [];
        for (var i = 0; i < pending.length; i++) register(pending[i][0], pending[i][1]);
        global.AEI18nPending = [];
        setting = getLocaleSetting();
        current = resolveLocale(setting, hostLocale());
        applyDocumentLocale();
        // 本脚本在 body 中段执行时，其后的静态节点尚未入树：等解析完成再翻一次。
        // 不在解析期先翻一半再补一遍——二次扫描会把已翻译文本当 key，污染缺 key 统计。
        if (global.document) {
            if (global.document.readyState === 'loading') {
                global.document.addEventListener('DOMContentLoaded', function () {
                    translateDom(global.document.body);
                });
            } else if (global.document.body) {
                translateDom(global.document.body);
            }
        }
        return current;
    }

    var api = {
        SUPPORTED: SUPPORTED,
        SOURCE_LOCALE: SOURCE_LOCALE,
        normalizeLocale: normalizeLocale,
        resolveLocale: resolveLocale,
        register: register,
        t: t,
        punct: punct,
        getLocale: getLocale,
        setLocale: setLocale,
        getLocaleSetting: getLocaleSetting,
        setLocaleSetting: setLocaleSetting,
        applyDocumentLocale: applyDocumentLocale,
        translateDom: translateDom,
        missingKeys: function () { return Object.keys(missing); },
        init: init
    };
    // 错误码文案单独成表（client/shared/i18n/errorCodes.js），此处只暴露取文入口：
    api.err = function (code, params, fallback, lang) {
        var table = global.AE_I18N_ERROR_CODES || null;
        var id = normalizeLocale(lang) || current;
        var entry = table && table[String(code || 'UNKNOWN')];
        var text = entry && (entry[id] || entry[SOURCE_LOCALE]);
        if (!text) return format(fallback == null ? String(code || '') : String(fallback), params);
        return format(text, params);
    };
    api.html = function (str, params) { return String(str); };   // 由 i18nHtml.js 覆盖

    global.AEI18n = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    init();
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
