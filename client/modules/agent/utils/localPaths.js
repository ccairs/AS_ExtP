(function (global) {
    'use strict';

    // ============================================================
    // 聊天区本地路径识别（纯扫描 + DOM linkify）
    //
    // 识别两类路径：
    //   ① 绝对路径：盘符 `E:\…` / `E:/…`、UNC `\\server\share\…`
    //   ② 数据根相对路径：`agent\temp\x.png`、`temp/chat_img/y.png`——首段必须是
    //      AEFS.SAFE_NAMESPACES 里的命名空间（白名单唯一来源，不在本文件手抄第二份清单）
    //
    // 边界与歧义：
    //   · 裸文本里的空白即视为路径结束（否则正文会被整段吞掉）；含空格的路径需由
    //     引号（"…" / '…' /「…」）包住才能整段识别。未被包住时只能识别到第一个空白前，
    //     点击会按「路径不存在」如实报错，不猜落点。
    //   · 识别只决定「可不可点」，是否存在由点击时的 revealPath 校验——渲染期不读盘
    //     （每帧同步探测会卡主线程）。
    //   · 尾部句读（. , ; ! ? ) 】等）与尾部路径分隔符一律剥掉再判定。
    // ============================================================

    // 路径字符集：除空白、引号、shell 元字符与中文句读/括号以外的字符。中文命名文件
    // （`E:\素材\测试.png`）是合法路径，故 CJK 汉字本身不在停止集里，只停中文标点。
    var STOP_CLASS = '\\s"\'<>|*?，。；：、（）【】《》「」『』\\u200b\\u2028\\u2029';
    // 引号/书名号包裹的候选：组 2 是包裹内的正文（允许含空格）
    var QUOTED_RE = /(["'「『])([^"'「」『』\r\n]{2,1024})\1/g;

    var _inlineRe = null;
    var _inlineReKey = null;

    // 命名空间白名单 → 正则分支。AEFS 未加载时返回空串（此时不识别相对路径，
    // 不拿第二份手抄清单兜底）。
    function _namespaceAlt() {
        var list = null;
        try { list = global.AEFS && global.AEFS.SAFE_NAMESPACES; } catch (_) { list = null; }
        if (!list || !list.length) return '';
        var parts = [];
        for (var i = 0; i < list.length; i++) {
            var ns = String(list[i] || '');
            if (!ns) continue;
            parts.push(ns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        }
        return parts.join('|');
    }

    function _inlineRegex() {
        var ns = _namespaceAlt();
        if (_inlineRe && _inlineReKey === ns) return _inlineRe;
        _inlineReKey = ns;
        var abs = '(?:[A-Za-z]:[\\\\/]|\\\\\\\\[^\\s\\\\/]+[\\\\/])[^' + STOP_CLASS + ']*';
        var rel = ns ? '(?:' + ns + ')[\\\\/][^' + STOP_CLASS + ']*' : '';
        var body = rel ? '(?:' + abs + '|' + rel + ')' : abs;
        // 前面不能紧贴路径/标识符字符：避免从 URL（file:///E:/x）或长单词中间截一段
        _inlineRe = new RegExp('(?<![A-Za-z0-9_\\\\/])' + body, 'g');
        return _inlineRe;
    }

    function _isAbsPath(s) {
        return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s);
    }

    // 归一候选：剥尾部句读/分隔符，再按「绝对路径 / 白名单命名空间相对路径」校验。
    // 不合格返回空串（不建链接）。
    function _normalizeCandidate(raw) {
        var s = String(raw == null ? '' : raw).replace(/^\s+|\s+$/g, '');
        var tailPunct = '.,;:!?)]}>\'"`';
        while (s && tailPunct.indexOf(s.charAt(s.length - 1)) >= 0) s = s.slice(0, -1);
        while (s && (s.charAt(s.length - 1) === '\\' || s.charAt(s.length - 1) === '/')) s = s.slice(0, -1);
        if (!s) return '';
        if (_isAbsPath(s)) {
            if (/^[A-Za-z]:$/.test(s)) return '';                 // 裸盘符
            if (/^[A-Za-z]:[\\/]$/.test(s)) return '';            // 盘根（太宽，不给点击入口）
            if (/^\\\\[^\\/]+$/.test(s)) return '';               // \\server（缺共享名）
            return s;
        }
        var ns = _namespaceAlt();
        if (!ns) return '';
        if (!new RegExp('^(?:' + ns + ')[\\\\/]').test(s)) return '';
        // 命名空间之后必须有实际内容（`temp\` 这种不算一条路径）
        if (!s.replace(new RegExp('^(?:' + ns + ')[\\\\/]+'), '')) return '';
        return s;
    }

    function _overlaps(list, start, end) {
        for (var i = 0; i < list.length; i++) {
            if (start < list[i].end && end > list[i].start) return true;
        }
        return false;
    }

    /**
     * 扫描一段纯文本里的可点击本地路径（不依赖 DOM，便于单测）。
     * @param {string} text
     * @returns {Array<{start:number,end:number,text:string,quoted?:boolean}>} 按 start 升序
     */
    function scanText(text) {
        var out = [];
        if (!text || typeof text !== 'string') return out;

        // ① 引号/书名号包裹（允许路径内含空格）
        QUOTED_RE.lastIndex = 0;
        var qm;
        while ((qm = QUOTED_RE.exec(text))) {
            var inner = qm[2];
            var norm = _normalizeCandidate(inner);
            if (!norm) continue;
            // 归一可能剥掉引号内的前导空白：起止点要按剥掉后的位置算
            var lead = inner.length - inner.replace(/^\s+/, '').length;
            var qs = qm.index + 1 + lead;
            if (_overlaps(out, qs, qs + norm.length)) continue;
            out.push({ start: qs, end: qs + norm.length, text: norm, quoted: true });
        }

        // ② 裸文本扫描
        var re = _inlineRegex();
        re.lastIndex = 0;
        var m;
        while ((m = re.exec(text))) {
            var raw = m[0];
            var start = m.index;
            var cand = _normalizeCandidate(raw);
            if (cand) {
                var end = start + cand.length;
                if (!_overlaps(out, start, end)) out.push({ start: start, end: end, text: cand });
            }
            if (m.index === re.lastIndex) re.lastIndex++;   // 空匹配防御
        }

        out.sort(function (a, b) { return a.start - b.start; });
        return out;
    }

    function _makePathSpan(doc, raw) {
        var span = doc.createElement('span');
        span.className = 'ae-agent-path';
        span.setAttribute('data-path', raw);
        span.title = AEI18n.t('打开所在位置并选中：') + raw;
        span.textContent = raw;
        return span;
    }

    function _escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    var MASKED_PATH_RE = /\u200bP(\d+)\u200b/g;

    /**
     * markdown 渲染前掩码路径：路径里的 `\_` / `\*` / `` \` `` 会被 markdown 当转义序列
     * 吃掉反斜杠（`temp\chat_img` 渲染成 `temp_chat_img`），渲染后再识别就认不出路径。
     * 占位符用零宽定界（与 chip token 同款，markdown/xss 都不动它）。
     * @param {string} text
     * @returns {{text:string, refs:string[]}}
     */
    function maskText(text) {
        var s = String(text == null ? '' : text);
        var matches = scanText(s);
        if (!matches.length) return { text: s, refs: [] };
        var refs = [];
        var out = '';
        var pos = 0;
        for (var i = 0; i < matches.length; i++) {
            var mt = matches[i];
            out += s.slice(pos, mt.start) + '\u200bP' + refs.length + '\u200b';
            refs.push(mt.text);
            pos = mt.end;
        }
        out += s.slice(pos);
        return { text: out, refs: refs };
    }

    function _restoreMasks(chunk, refs) {
        return chunk.replace(MASKED_PATH_RE, function (m, idx) {
            var raw = refs[Number(idx)];
            if (raw == null) return m;
            var e = _escHtml(raw);
            return '<span class="ae-agent-path" data-path="' + e + '" title="打开所在位置并选中：' + e + '">'
                + e + '</span>';
        });
    }

    /**
     * markdown/xss 渲染后把路径占位符还原成可点击 span（属性一律转义）。
     * 只还原**标签之外**的占位符：占位符若落在标签属性里（如 markdown 链接的 href，
     * `[x](E:\a)` 的路径会被掩码进 href），把 span 标记插进属性会破坏 HTML 结构。
     * @param {string} html
     * @param {string[]} refs maskText 的 refs
     * @returns {string}
     */
    function unmaskHtml(html, refs) {
        if (!refs || !refs.length) return html;
        var s = String(html);
        var out = '';
        var pos = 0;
        var tagRe = /<[^>]*>/g;
        var m;
        while ((m = tagRe.exec(s))) {
            out += _restoreMasks(s.slice(pos, m.index), refs);
            out += m[0];          // 标签/属性原样保留
            pos = tagRe.lastIndex;
        }
        out += _restoreMasks(s.slice(pos), refs);
        return out;
    }

    // ── markdown 图片：本地图片路径 → file:// 图片 ────────────────────────────────
    // 渲染链：正文文本 →（maskImages）→ marked → js-xss →（unmaskImages）。js-xss 的
    // img src 协议白名单只放行 http(s)/ftp/data:image/`./`/`../`/`/`，盘符与数据根相对
    // 路径会被剥成空 src（`<img src alt="x">`）。故先把 `![alt](本地路径)` 整段换成
    // `![alt](./__ae_img__/N)`（`./` 前缀过白名单、内容无特殊字符），渲染后按 refs
    // 还原成 file:// 图片。
    // UNC 不当图片：file:// UNC 会在渲染期自动发起 SMB 网络访问（凭据泄露/面板卡顿），
    // 降级为纯路径文本，由既有路径链接通道处理（点击时才访问）。
    var IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
    // 行内 markdown 图片语法：![alt](dest) / ![alt](<含空格路径>) / 可带 "title"。
    // alt 不含 ] 与换行；dest 不含空白（含空格路径走尖括号形式）。
    var MD_IMAGE_RE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;

    function _isUncPath(s) {
        return /^\\\\/.test(s);
    }

    /**
     * 扫描文本里的本地图片语法（跳过围栏代码块与行内代码，代码示例不得变成图）。
     * @param {string} text
     * @returns {Array<{start:number,end:number,action:string,raw:string,alt:string,original:string}>}
     */
    function scanImages(text) {
        var out = [];
        var s = String(text == null ? '' : text);
        if (!s || s.indexOf('![') < 0) return out;
        var lines = s.split('\n');
        var offset = 0;
        var inFence = false;
        var inIndentedCode = false;
        var prevBlank = true;
        for (var li = 0; li < lines.length; li++) {
            var line = lines[li];
            var lineStart = offset;
            offset += line.length + 1;   // 还原 split 时去掉的 \n（末行多算 1 不影响后续）
            var blank = /^\s*$/.test(line);
            if (/^\s*(```|~~~)/.test(line)) {
                inFence = !inFence;
                prevBlank = blank;
                continue;
            }
            if (inFence) { prevBlank = blank; continue; }
            // 缩进代码块（空行后 4 空格/制表符开头）内不是 markdown 图片，代码示例不渲染成图
            if (/^(?: {4,}|\t)/.test(line) && prevBlank) inIndentedCode = true;
            else if (!blank && !/^(?: {4,}|\t)/.test(line)) inIndentedCode = false;
            if (inIndentedCode) { prevBlank = blank; continue; }
            prevBlank = blank;
            // 行内代码区间：`` `...` `` 内的图片语法不是图片
            var codeRanges = [];
            var codeRe = /`[^`\n]*`/g;
            var cm;
            while ((cm = codeRe.exec(line))) codeRanges.push([cm.index, cm.index + cm[0].length]);
            MD_IMAGE_RE.lastIndex = 0;
            var m;
            while ((m = MD_IMAGE_RE.exec(line))) {
                var inCode = false;
                for (var ci = 0; ci < codeRanges.length; ci++) {
                    if (m.index >= codeRanges[ci][0] && m.index < codeRanges[ci][1]) { inCode = true; break; }
                }
                if (inCode) continue;
                var dest = m[2];
                if (dest.charAt(0) === '<' && dest.charAt(dest.length - 1) === '>') dest = dest.slice(1, -1);
                dest = dest.replace(/^\s+|\s+$/g, '');
                if (!dest || !IMAGE_EXT_RE.test(dest)) continue;   // 非图片扩展名：交回既有链路
                if (_isUncPath(dest)) {
                    out.push({
                        start: lineStart + m.index, end: lineStart + m.index + m[0].length,
                        action: 'path', raw: dest, alt: m[1], original: m[0]
                    });
                    continue;
                }
                var norm = _normalizeCandidate(dest);
                if (!norm || !IMAGE_EXT_RE.test(norm)) continue;
                out.push({
                    start: lineStart + m.index, end: lineStart + m.index + m[0].length,
                    action: 'image', raw: norm, alt: m[1], original: m[0]
                });
            }
        }
        return out;
    }

    /**
     * markdown 渲染前：本地图片语法 → 占位 `![alt](./__ae_img__/N)`；UNC 图片语法降级为
     * 纯路径文本（之后由 maskText 包成可点击路径）。
     * @param {string} text
     * @returns {{text:string, refs:Array<{raw:string,original:string}>}}
     */
    function maskImages(text) {
        var s = String(text == null ? '' : text);
        var matches = scanImages(s);
        if (!matches.length) return { text: s, refs: [] };
        var refs = [];
        var out = '';
        var pos = 0;
        for (var i = 0; i < matches.length; i++) {
            var mt = matches[i];
            out += s.slice(pos, mt.start);
            if (mt.action === 'path') {
                out += mt.raw;
            } else {
                out += '![' + mt.alt + '](./__ae_img__/' + refs.length + ')';
                refs.push({ raw: mt.raw, original: mt.original });
            }
            pos = mt.end;
        }
        out += s.slice(pos);
        return { text: out, refs: refs };
    }

    // 图片路径 → file:// URL（不读盘：绝对路径直转；数据根相对路径补数据目录再转）。
    // 数据目录不可用返回空串，由调用方退回原始 markdown 文本（不留半张破图）。
    function _resolveImageFileUrl(raw) {
        var p = String(raw == null ? '' : raw);
        if (!p) return '';
        var shared = global.AEShared || null;
        if (!shared || typeof shared.toFileUrl !== 'function') return '';
        if (/^[A-Za-z]:[\\/]/.test(p)) return shared.toFileUrl(p);
        var dataDir = '';
        try {
            if (typeof shared.getDataDir === 'function') {
                var d = shared.getDataDir();
                dataDir = (d && d.dir) ? String(d.dir) : '';
            }
        } catch (_) { dataDir = ''; }
        if (!dataDir) return '';
        return shared.toFileUrl(dataDir.replace(/\\+$/, '') + '\\' + p.replace(/^[\\/]+/, ''));
    }

    /**
     * markdown/xss 渲染后：把占位图片还原成真实 file:// 图片（带 lightbox/缺图兜底所需的
     * class 与 data-path）。数据目录不可用时退回原始 markdown 文本。
     * @param {string} html
     * @param {Array<{raw:string,original:string}>} refs maskImages 的 refs
     * @returns {string}
     */
    function unmaskImages(html, refs) {
        if (!refs || !refs.length) return html;
        return String(html).replace(
            /<img\b([^>]*?)\bsrc="\.\/__ae_img__\/(\d+)"([^>]*?)>/gi,
            function (m, pre, idx, post) {
                var ref = refs[Number(idx)];
                if (!ref) return m;
                var url = _resolveImageFileUrl(ref.raw);
                if (!url) return _escHtml(ref.original || '');
                return '<img' + pre + ' src="' + _escHtml(url)
                    + '" data-path="' + _escHtml(ref.raw)
                    + '" class="ae-agent-md-img"' + post + '>';
            });
    }

    // 单个文本节点 → 拆成 [文本][路径 span][文本] 片段后原位替换。
    function _linkifyTextNode(node) {
        var text = node.nodeValue || '';
        var matches = scanText(text);
        if (!matches.length) return 0;
        var doc = node.ownerDocument;
        var parent = node.parentNode;
        if (!doc || !parent) return 0;
        var frag = doc.createDocumentFragment();
        var pos = 0;
        for (var i = 0; i < matches.length; i++) {
            var mt = matches[i];
            if (mt.start > pos) frag.appendChild(doc.createTextNode(text.slice(pos, mt.start)));
            frag.appendChild(_makePathSpan(doc, mt.text));
            pos = mt.end;
        }
        if (pos < text.length) frag.appendChild(doc.createTextNode(text.slice(pos)));
        parent.replaceChild(frag, node);
        return matches.length;
    }

    // 不进入的标签：链接（已由链接委托处理）、脚本/样式容器、按钮/文本域
    var SKIP_TAGS = { A: 1, SCRIPT: 1, STYLE: 1, TEXTAREA: 1, BUTTON: 1 };

    function _walk(node) {
        var child = node.firstChild;
        var count = 0;
        while (child) {
            var next = child.nextSibling;
            if (child.nodeType === 3) {
                count += _linkifyTextNode(child);
            } else if (child.nodeType === 1) {
                var tag = String(child.nodeName || '').toUpperCase();
                var cls = (typeof child.className === 'string') ? child.className : '';
                if (!SKIP_TAGS[tag] && cls.indexOf('ae-agent-path') < 0) {
                    count += _walk(child);
                }
            }
            child = next;
        }
        return count;
    }

    /**
     * 把根节点内所有文本节点里的本地路径包成 `.ae-agent-path`（点击由 engine/bootstrap 的
     * 链接委托处理）。可重复调用：已有 span 的子树会跳过。
     * @param {Element} root
     * @returns {number} 新建的路径节点数
     */
    function linkifyDom(root) {
        if (!root || root.nodeType !== 1 || !root.ownerDocument) return 0;
        try { return _walk(root); } catch (_) { return 0; }
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.localPaths = {
        scanText: scanText,
        linkifyDom: linkifyDom,
        maskText: maskText,
        unmaskHtml: unmaskHtml,
        scanImages: scanImages,
        maskImages: maskImages,
        unmaskImages: unmaskImages
    };
})(window);
