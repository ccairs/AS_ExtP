// HTML 模板翻译：只处理文本节点与白名单属性值，译文按文本转义后原位插入。
// 与 tools/i18n/scan-keys.js 共用同一实现（collectKeys），保证运行时查询的 key
// 与提取/覆盖率检查的 key 完全一致。
// 跳过 script/style/pre/code/textarea 的子树文本，但这些元素自身的白名单属性仍翻。
// 文本里的 '<'（如代码示例 a < b）不是标签：只有 '<' 后紧跟字母 / '/' / '!' / '?' 才按标签处理。
// 查词典的 key 是实体解码后的文本，与静态 shell 的 translateDom（读到的已是 DOM 解码值）同口径。
(function (global) {
    'use strict';

    var SKIP_TAGS = { script: 1, style: 1, pre: 1, code: 1, textarea: 1 };
    var ATTR_RE = /\s(title|placeholder|aria-label|alt|data-tip)\s*=\s*("([^"]*)"|'([^']*)')/g;

    function escText(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function escAttr(s) {
        // 双引号与单引号属性都可能承载译文，两种引号字符都要转义（撇号在英文译文里常见）
        return escText(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    // 实体解码：数字实体按码位解码，表内命名实体按键名解码，其余原样保留。
    function decodeEntities(s) {
        return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, body) {
            if (body.charAt(0) === '#') {
                var code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
                return isFinite(code) && code > 0 ? String.fromCharCode(code) : m;
            }
            return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
        });
    }

    function trimParts(text) {
        var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(String(text == null ? '' : text));
        return m ? { lead: m[1], core: m[2], tail: m[3] } : null;
    }

    function translateText(text, t) {
        var p = trimParts(text);
        if (!p || !p.core) return text;
        // 查词典用解码后的 key；命中才替换，未命中（含 zh 等值返回）保留原片段与实体写法。
        var key = decodeEntities(p.core);
        var out = t(key);
        if (out == null || out === key) return text;
        return p.lead + escText(out) + p.tail;
    }

    function translateTag(tag, t) {
        if (tag.charAt(1) === '/') return tag;
        return tag.replace(ATTR_RE, function (all, name, quoted, dq, sq) {
            var val = dq !== undefined ? dq : sq;
            // 属性值与文本节点同规则：先裁首尾空白，解码实体后查词典，替换时保留空白。
            var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(String(val));
            if (!m || !m[2]) return all;
            var key = decodeEntities(m[2]);
            var out = t(key);
            if (out == null || out === key) return all;
            var q = quoted.charAt(0);
            return ' ' + name + '=' + q + m[1] + escAttr(out) + m[3] + q;
        });
    }

    // 找到标签结束的 '>'：跳过引号内的 '>'。
    function findTagEnd(s, from) {
        var quote = 0, i = from + 1;
        while (i < s.length) {
            var c = s.charAt(i);
            if (quote) { if (c === quote) quote = 0; }
            else if (c === '"' || c === "'") quote = c;
            else if (c === '>') return i;
            i++;
        }
        return -1;
    }

    // 跳过子树：从 from 起找当前元素的闭标签，返回 { start, end }（找不到返回 null）。
    function findCloseTag(s, from, name) {
        var re = new RegExp('<\\s*/\\s*' + name + '\\s*>', 'ig');
        re.lastIndex = from;
        var m = re.exec(s);
        if (!m) return null;
        return { start: m.index, end: m.index + m[0].length };
    }

    function translateHtml(src, t) {
        if (src == null) return '';
        var s = String(src);
        if (s.indexOf('<') === -1) return translateText(s, t);
        var out = '', i = 0, n = s.length;
        while (i < n) {
            var lt = s.indexOf('<', i);
            if (lt === -1) { out += translateText(s.slice(i), t); break; }
            out += translateText(s.slice(i, lt), t);
            var next = s.charAt(lt + 1);
            // 不是标签起始（文本里的 a < b）：'<' 原样输出，继续当文本处理
            if (!/[a-zA-Z\/!?]/.test(next)) { out += '<'; i = lt + 1; continue; }
            var gt = findTagEnd(s, lt);
            if (gt === -1) { out += s.slice(lt); break; }
            var tag = s.slice(lt, gt + 1);
            // 注释 / DOCTYPE / 处理指令：整段原样输出，内部不翻不改
            if (next === '!' || next === '?') { out += tag; i = gt + 1; continue; }
            var nameM = /^<\s*\/?\s*([a-zA-Z][\w:-]*)/.exec(tag);
            var name = nameM ? nameM[1].toLowerCase() : '';
            out += translateTag(tag, t);
            i = gt + 1;
            // 进入跳过子树：内部文本与标签全部原样输出，直到同名闭标签
            if (SKIP_TAGS[name] && !/^<\s*\//.test(tag)) {
                var close = findCloseTag(s, i, name);
                if (!close) { out += s.slice(i); break; }
                out += s.slice(i, close.end);
                i = close.end;
            }
        }
        return out;
    }

    // 候选 key 提取（供 tools/i18n/scan-keys.js 与覆盖率检查使用）
    function collectKeys(src) {
        var keys = [];
        translateHtml(src, function (k) { keys.push(k); return k; });
        return keys;
    }

    var api = { translateHtml: translateHtml, collectKeys: collectKeys, translateText: translateText };
    if (global.AEI18n) {
        // 面板侧对外只暴露一参形态：AEI18n.html(str) —— 词典由 core 的 t() 按当前语言取，
        // 调用点不需要知道 t 的存在（统一包成 AEI18n.html(<字面量>)）。
        global.AEI18n.html = function (str) { return translateHtml(str, global.AEI18n.t); };
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
