// ── 代码预览增量高亮引擎（script/shader 共用）──
// 高亮层是唯一可见文字（textarea 文字透明，见 CSS has-highlight），更新不及时
// = 打字可见延迟；但全量重跑 Prism + innerHTML 重建巨型 span 树在大脚本上
// 700ms+，逐键同步执行会冻结。解决：overlay 改为每行一个 .hl-line div，
// 输入时 diff 出变更行（通常 1~2 行）只对这些行单独跑 Prism（微秒级），
// 其余行直接复用缓存 HTML → 任意大小脚本按键即时着色。
//
// 引擎与语言无关：着色全部委托 Prism.languages[opts.getLanguage()]，调用方通过
// getLanguage/getLanguageName 注入语言（script=javascript，shader=glsl）。
//
// 跨行 token（块注释/模板字符串）的即时正确着色：
// - 全量重建从 token 树记录每行 open（行尾仍未闭合的跨行区域类）
// - 快速路径用单行扫描器（_scanLine）延续区域状态：区域内编辑的行直接
//   按区域类整行着色（颜色即时且正确），无需 Prism
// - 纯区域内编辑渲染按构造正确 → 完全跳过 reconcile（巨型脚本注释内连续
//   打字不再触发空闲全量冻结）；只有出现区域边界（/* */ `）才拼装渲染并
//   短延迟(600ms)全量修正；普通代码行走独立高亮 + 长延迟 reconcile 兜底
// - 全量用 tokenize(全文) + 行拆分序列化器（span 跨行时逐行闭合/重开），
//   着色与整篇单次 highlight 完全一致
// 已知取舍：模板字符串内多行 ${} 插值的内部行会被按模板色渲染（罕见，且
// GLSL 无模板字符串；ExtendScript 亦不支持模板字面量，实际内容不会出现）
(function (global) {
    'use strict';

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function span(cls, text) {
        return '<span class="token ' + cls + '">' + text + '</span>';
    }

    // Token 树 → [{ln, html}]（ln 为相对起始行的偏移，单调不减）。
    // 关键：Token 的 span 跨越换行时，每个涉及行各自闭合/重新打开 span，
    // 保证拆行后的 HTML 每行自闭合、可直接放入独立 div。
    function tokenSegs(tok) {
        if (typeof tok === 'string') {
            const parts = String(tok).split('\n');
            const segs = [];
            for (let i = 0; i < parts.length; i++) segs.push({ ln: i, html: escapeHtml(parts[i]) });
            return segs;
        }
        const inner = Array.isArray(tok.content) ? tok.content : [tok.content];
        const flat = [];
        let lnBase = 0;
        for (let c = 0; c < inner.length; c++) {
            const sub = tokenSegs(inner[c]);
            for (let k = 0; k < sub.length; k++) {
                flat.push({ ln: lnBase + sub[k].ln, html: sub[k].html });
            }
            if (sub.length) lnBase += sub[sub.length - 1].ln;
        }
        const cls = 'token ' + [tok.type].concat(tok.alias || []).join(' ');
        const out = [];
        let cur = -1, buf = [];
        for (let i = 0; i < flat.length; i++) {
            if (flat[i].ln !== cur) {
                if (buf.length) out.push({ ln: cur, html: '<span class="' + cls + '">' + buf.join('') + '</span>' });
                cur = flat[i].ln;
                buf = [];
            }
            buf.push(flat[i].html);
        }
        if (buf.length) out.push({ ln: cur, html: '<span class="' + cls + '">' + buf.join('') + '</span>' });
        return out;
    }

    // token 树的末尾纯文本（取最后 n 字符）：供判断跨行区域 token 是否闭合
    function tokenTailText(tok, n) {
        if (typeof tok === 'string') return tok.slice(-n);
        const inner = Array.isArray(tok.content) ? tok.content : [tok.content];
        let out = '';
        for (let i = inner.length - 1; i >= 0 && out.length < n; i--) {
            out = tokenTailText(inner[i], n) + out;
        }
        return out.slice(-n);
    }

    // token 树的开头纯文本（取前 n 字符）：判别行注释（//）用
    function tokenHeadText(tok, n) {
        if (typeof tok === 'string') return tok.slice(0, n);
        const inner = Array.isArray(tok.content) ? tok.content : [tok.content];
        let out = '';
        for (let i = 0; i < inner.length && out.length < n; i++) {
            out += tokenHeadText(inner[i], n);
        }
        return out.slice(0, n);
    }

    // 吞到 EOF 未闭合的区域 token：Prism 的 comment 规则 (?:\*\/|$) 会把未闭合
    // 块注释匹配到文件末尾（未闭合模板串不匹配 template-string 规则、退化为普通
    // 文本，无需处理）。未闭合 token 的结束行行尾仍在区域内，open 必须标记，
    // 否则在其下行输入时状态链断裂（新行按普通代码着色且 dirty 判据不成立）。
    // 行注释（// 开头）单行自闭合、永不跨行，须直接排除——其 token 结尾恒非
    // `*/`，若按块注释判据会误标为开放区域，下行输入经状态链整行按注释色
    // 渲染（实测缺陷：GLSL/JS 行注释下一行打字全灰，且「纯区域内编辑」
    // 路径不置 standalone、无 reconcile 修正，灰色永不自愈）。
    function isUnclosedRegionToken(tok) {
        if (!tok || tok.type !== 'comment') return false;
        if (tokenHeadText(tok, 2) === '//') return false;
        return tokenTailText(tok, 2) !== '*/';
    }

    // tokenize(全文) 的结果 → {lines, open}（与 value.split('\n') 一一对应）。
    // open[i]: 行 i 结束时有跨行 token 未闭合 → 该 token 类（后写覆盖=取最内层，
    //          作为后续行编辑时的进入状态）
    function linesFromTokens(tokens) {
        const rows = [];
        const open = [];
        let ln = 0;
        for (let t = 0; t < tokens.length; t++) {
            const tok = tokens[t];
            const segs = tokenSegs(tok);
            for (let k = 0; k < segs.length; k++) {
                const abs = ln + segs[k].ln;
                (rows[abs] || (rows[abs] = [])).push(segs[k].html);
            }
            if (tok && tok.type && segs.length) {
                const b = ln + segs[segs.length - 1].ln;
                // 闭合 token：行 b 已闭合，标记 [ln, b)；未闭合（吞到 EOF）：行 b
                // 仍在区域内，标记到 b。单行未闭合（刚输入 /*）同样获得标记。
                const end = b + (isUnclosedRegionToken(tok) ? 1 : 0);
                for (let L = ln; L < end; L++) open[L] = tok.type;
            }
            if (segs.length) ln += segs[segs.length - 1].ln;
        }
        const n = rows.length;
        const lines = new Array(n);
        for (let i = 0; i < n; i++) lines[i] = rows[i] ? rows[i].join('') : '';
        return { lines: lines, open: open };
    }

    // 单行扫描器：给定进入时的跨行区域状态（st），把行拆为 [{cls,text}] 段并
    // 给出离开状态。cls: null=普通代码 / 'comment'（块注释或行注释）/
    // 'template-string'。只追踪块注释与模板字符串两类可跨行结构（JS 其余
    // token 均不跨行）；字符串/行注释在行内自闭合不产生跨行状态。
    // GLSL 无模板字符串，合法代码不含反引号，追踪逻辑无害复用。
    // cross: 本行是否出现块注释/模板边界（开或闭），决定是否走手工拼装渲染。
    function scanLine(src, st) {
        const segs = [];
        let cross = !!st;
        let i = 0;
        const n = src.length;
        let cur = st || null;
        let buf = '';
        let bufCls = cur;
        function flush() {
            if (buf === '') return;
            const last = segs[segs.length - 1];
            if (last && last.cls === bufCls) last.text += buf;
            else segs.push({ cls: bufCls, text: buf });
            buf = '';
        }
        while (i < n) {
            const c = src.charAt(i);
            const c2 = src.charAt(i + 1);
            if (cur === 'comment') {
                if (c === '*' && c2 === '/') {
                    buf += '*/'; i += 2; flush();
                    cur = null; bufCls = null; cross = true;
                } else { buf += c; i++; }
            } else if (cur === 'template-string') {
                if (c === '\\') { buf += src.substr(i, 2); i += 2; }
                else if (c === '`') {
                    buf += '`'; i++; flush();
                    cur = null; bufCls = null; cross = true;
                } else { buf += c; i++; }
            } else if (c === '/' && c2 === '*') {
                flush(); cur = 'comment'; bufCls = 'comment'; buf = '/*'; i += 2; cross = true;
            } else if (c === '/' && c2 === '/') {
                flush(); bufCls = 'comment'; buf = src.slice(i); i = n;
            } else if (c === '`') {
                flush(); cur = 'template-string'; bufCls = 'template-string'; buf = '`'; i++; cross = true;
            } else if (c === "'" || c === '"') {
                flush(); bufCls = null; buf = c; i++;
                while (i < n) {
                    if (src.charAt(i) === '\\') { buf += src.substr(i, 2); i += 2; continue; }
                    buf += src.charAt(i);
                    if (src.charAt(i) === c) { i++; break; }
                    i++;
                }
            } else {
                if (bufCls !== null) flush();
                bufCls = null; buf += c; i++;
            }
        }
        flush();
        return { segs: segs, out: cur, cross: cross };
    }

    // 扫描段 → HTML：区域段按区域类整段着色；普通代码段单独跑 Prism
    function renderSegs(segs, lang, langName) {
        let out = '';
        for (let k = 0; k < segs.length; k++) {
            const seg = segs[k];
            if (!seg.text) continue;
            if (seg.cls) {
                out += span(seg.cls, escapeHtml(seg.text));
            } else {
                try {
                    out += global.Prism.highlight(seg.text, lang, langName);
                } catch (e) {
                    out += escapeHtml(seg.text);
                }
            }
        }
        return out;
    }

    // 创建预览实例。options:
    //   getTextarea(): 编辑区（取 .value / .scrollTop/.scrollLeft）
    //   getOverlay(): 高亮 <code> 元素（写 innerHTML，children 与缓存一一对应）
    //   getWrap(): 容器（切换 has-highlight）
    //   getStatusEl(): Prism 状态元素（可为 null）
    //   getLanguage(): Prism.languages.<name> 对象（未就绪返回 null）
    //   getLanguageName(): 语言名（script=javascript / shader=glsl）
    //   onPrismMissing(cb): Prism 未就绪时策略（script 传 loadPrismJs 重试；shader 不传=纯文本降级）
    function create(options) {
        const $ta = typeof options.getTextarea === 'function' ? function () { return options.getTextarea(); } : function () { return null; };
        const $code = typeof options.getOverlay === 'function' ? function () { return options.getOverlay(); } : function () { return null; };
        const $wrap = typeof options.getWrap === 'function' ? function () { return options.getWrap(); } : function () { return null; };
        const $status = typeof options.getStatusEl === 'function' ? function () { return options.getStatusEl(); } : function () { return null; };
        const langName = options.getLanguageName || 'javascript';

        function prismReady() {
            const p = global.Prism;
            return !!(p && p.languages && p.languages[langName] && typeof p.tokenize === 'function' && typeof p.highlight === 'function');
        }

        let lines = [];           // [{src, html, open}] 与 overlay .hl-line 子元素一一对应
        let timer = 0;            // 大段变更的防抖全量
        let reconcileTimer = 0;   // 停顿后的全量 reconcile（修正跨行 token 错色）
        let lastFullCost = 0;     // 上次全量耗时(ms)，用于 reconcile 延迟分级
        let lastHighlightedCode = '';

        // 全量重建：上下文正确的着色（初始加载/切换脚本/大段粘贴/reconcile）
        function fullRebuild() {
            const ta = $ta();
            const code = $code();
            const wrap = $wrap();
            if (!ta || !code) return;
            const statusEl = $status();
            const value = ta.value;
            if (!value) {
                lines = [];
                lastHighlightedCode = '';
                code.innerHTML = '';
                if (wrap) wrap.classList.remove('has-highlight');
                return;
            }
            if (!prismReady()) {
                if (wrap) wrap.classList.remove('has-highlight');
                if (statusEl) statusEl.textContent = 'Prism: loading...';
                if (options.onPrismMissing) options.onPrismMissing(fullRebuild);
                return;
            }
            const t0 = global.performance.now();
            try {
                const srcArr = value.split('\n');
                const tokens = global.Prism.tokenize(value, options.getLanguage());
                const res = linesFromTokens(tokens);
                lines = res.lines.map((html, i) => ({ src: srcArr[i], html: html, open: res.open[i] || null }));
                code.innerHTML = res.lines.map(h => '<div class="hl-line">' + h + '</div>').join('');
                lastHighlightedCode = value;
                if (wrap) wrap.classList.add('has-highlight');
                if (statusEl) statusEl.textContent = 'Prism: OK';
                syncScroll();
            } catch (e) {
                if (wrap) wrap.classList.remove('has-highlight');
                if (statusEl) statusEl.textContent = 'Prism error: ' + (e && e.message ? e.message : 'unknown');
            }
            lastFullCost = global.performance.now() - t0;
        }

        // overlay DOM 与 lines 一一对应；splice 式最小补丁：
        // [0..s) 不动，[s..overlap) 原位替换 innerHTML，行数增减通过 insert/remove
        // 补齐（绝不能从 s 重建到末尾——编辑首行时会把几千个尾部 div 全部重建，
        // 增量就失去意义了）。
        function patchDom(code, s, eOld, eNew) {
            const kids = code.children;
            const overlap = Math.min(eOld, eNew);
            for (let i = s; i < overlap; i++) {
                kids[i].innerHTML = lines[i].html;
            }
            if (eNew > eOld) {
                const frag = global.document.createDocumentFragment();
                for (let i = eOld; i < eNew; i++) {
                    const d = global.document.createElement('div');
                    d.className = 'hl-line';
                    d.innerHTML = lines[i].html;
                    frag.appendChild(d);
                }
                code.insertBefore(frag, kids[eOld] || null);
            } else if (eNew < eOld) {
                for (let i = eNew; i < eOld; i++) {
                    code.removeChild(kids[eNew]);  // removeChild 后后续自动前移
                }
            }
        }

        // 快速路径：两端 diff 出变更行，用区域状态链逐行构建。返回
        // {dirty, standalone} 或 false（无法增量，交由全量路径）。
        // - dirty: 尾部缓存着色已过期（出口区域状态 ≠ 尾部旧进入状态）→ 短延迟全量修正
        // - standalone: 有行走了独立 Prism 高亮（缺上下文可能有细微偏差）→ 长延迟 reconcile 兜底
        // - 两者皆 false: 渲染按构造正确，无需 reconcile
        function fastPatch(value) {
            if (!lines.length) return false;
            const code = $code();
            // overlay DOM 必须与缓存一一对应（被外部清空时交由全量重建兜底，
            // 避免 patchDom 索引越界崩溃）
            if (!code || code.children.length !== lines.length) return false;
            const newLines = value.split('\n');
            const old = lines;
            let s = 0;
            const m = Math.min(old.length, newLines.length);
            while (s < m && old[s].src === newLines[s]) s++;
            let eOld = old.length, eNew = newLines.length;
            while (eOld > s && eNew > s && old[eOld - 1].src === newLines[eNew - 1]) { eOld--; eNew--; }
            if (Math.max(eOld - s, eNew - s) > 80) return false;
            // 区域状态链基准（必须在平移前捕获：删除行的平移会覆写 [eNew, oldN)
            // 区间的旧条目，其中包含 old[eOld-1]）：
            // - stEntry: 变更区进入状态（未变前缀末行的行尾开放区域）
            // - oldTailEnter: 尾部在旧结构中的进入状态（旧变更区末行的 open；
            //   纯插入时 = stEntry）
            const stEntry = s > 0 ? (old[s - 1].open || null) : null;
            const oldTailEnter = eOld > s
                ? ((old[eOld - 1] && old[eOld - 1].open) || null)
                : stEntry;
            // 行数增减时先把未变尾部平移到位（倒序避免覆盖），再写变更区。
            // 漏掉这步会让中间插入行覆盖/丢失原尾部缓存（数组错位）。
            const delta = eNew - eOld;
            const oldN = old.length;
            if (delta > 0) {
                for (let i = oldN - 1; i >= eOld; i--) lines[i + delta] = lines[i];
            } else if (delta < 0) {
                for (let i = eOld; i < oldN; i++) lines[i + delta] = lines[i];
            }
            lines.length = newLines.length;
            // 逐行构建：变更区全部按状态链即时渲染（按构造正确）。行内的状态
            // 过渡无需标记——只有出口状态影响尾部缓存的有效性（见循环后的判据）
            let st = stEntry;
            let dirty = false;
            let standalone = false;
            for (let i = s; i < eNew; i++) {
                const src = newLines[i];
                let html = '';
                let open = null;
                if (st) {
                    // 行首在跨行区域内：整行按区域类着色（无边界时即完全正确）
                    const r = scanLine(src, st);
                    const clean = (r.out === st) &&
                        (!r.segs.length || (r.segs.length === 1 && r.segs[0].cls === st));
                    if (clean) {
                        html = src ? span(st, escapeHtml(src)) : '';
                        open = st;
                    } else {
                        // 区域边界行：普通代码段仍走独立 Prism，存在细微偏差可能
                        html = renderSegs(r.segs, options.getLanguage(), langName);
                        open = r.out;
                        standalone = true;
                    }
                } else {
                    const r = scanLine(src, null);
                    if (!r.cross) {
                        // 无跨行结构 → 整行独立高亮（保留关键字/字符串等着色质量）
                        if (src) {
                            try {
                                html = global.Prism.highlight(src, options.getLanguage(), langName);
                            } catch (e) {
                                html = escapeHtml(src);
                            }
                        }
                        open = null;
                        standalone = true;
                    } else {
                        // 行内出现区域边界：手工拼装渲染（普通段独立 Prism，
                        // 插值/正则等待上下文的着色可能偏差）
                        html = renderSegs(r.segs, options.getLanguage(), langName);
                        open = r.out;
                        standalone = true;
                    }
                }
                lines[i] = { src: src, html: html, open: open };
                st = open;
            }
            // 尾部缓存有效当且仅当：进入尾部的区域状态与尾部旧进入状态一致。
            // 精确判据同时消灭两类旧缺陷——漏报：删掉 '/* x' 行的注释头（行内无
            // 过渡，尾部吞进注释却无人标记）；误报：在注释开启行内打字（open 恒为
            // comment 与进入态不同，但结构未变，巨型脚本无谓触发 600ms 全量冻结）
            if (eNew < newLines.length && st !== oldTailEnter) dirty = true;
            patchDom(code, s, eOld, eNew);
            const wrap = $wrap();
            if (wrap) wrap.classList.toggle('has-highlight', lines.length > 0);
            return { dirty: dirty, standalone: standalone };
        }

        // 停顿后的全量修正。delay 分级：区域结构变化 600ms（后续行着色过期需尽快
        // 修正）；独立高亮行兜底按脚本体量 1.2s / 3s（巨型脚本全量有可感知成本，
        // 放宽到深度空闲）。
        function scheduleReconcile(delay) {
            clearTimeout(reconcileTimer);
            reconcileTimer = setTimeout(() => {
                const ta = $ta();
                if (!ta || ta.value !== lastHighlightedCode) return;
                fullRebuild();
            }, delay);
        }

        function apply(forceReload) {
            clearTimeout(timer);
            clearTimeout(reconcileTimer);
            if (forceReload) { fullRebuild(); return; }
            const ta = $ta();
            const code = $code();
            if (!ta || !code) return;
            const value = ta.value;
            if (!value) { fullRebuild(); return; }
            // 内容未变且缓存与 overlay DOM 一一对应才可跳过（DOM 被外部清空时全量重建兜底）。
            // 例外：大粘贴后立即撤销回原文——计时器已在入口被清掉，plain-echo 移除的
            // has-highlight 无人恢复，着色会消失到下次编辑；此处补挂回去
            if (value === lastHighlightedCode && lines.length && code.children.length === lines.length) {
                const wrap = $wrap();
                if (wrap && !wrap.classList.contains('has-highlight')) wrap.classList.add('has-highlight');
                return;
            }
            if (!prismReady()) {
                fullRebuild();  // 内部处理 Prism 未就绪的延迟重试
                return;
            }
            if (!lines.length) { fullRebuild(); return; }  // 初次渲染
            const patch = fastPatch(value);
            if (patch) {
                lastHighlightedCode = value;
                if (patch.dirty) {
                    scheduleReconcile(600);
                } else if (patch.standalone) {
                    scheduleReconcile(lastFullCost > 250 ? 3000 : 1200);
                }
                // 纯区域内编辑：渲染按构造正确，无需 reconcile
                return;
            }
            // 大段变更：立即 plain-echo（textarea 文字直接可见，新内容零延迟），
            // 150ms 防抖后全量着色——避免大粘贴触发 700ms+ 同步冻结
            const wrap = $wrap();
            if (wrap) wrap.classList.remove('has-highlight');
            timer = setTimeout(() => fullRebuild(), 150);
        }

        function syncScroll() {
            const ta = $ta();
            const code = $code();
            if (!ta || !code) return;
            // 原生滚动同步（overlay.scrollTop）而非 transform 平移整个代码块：
            // transform 会让巨型高亮层（数万 span）作为整块纹理参与栅格化，
            // CEP 软件渲染下拖拽/滚动时合成器可卡死数秒；原生滚动只栅格化视口附近瓦片。
            // 配合 CSS 里 overlay 层的额外 padding-bottom 补偿 textarea
            // 幽灵换行造成的 scrollHeight 差，避免滚到底时被钳制错位。
            code.style.transform = '';
            const parent = code.parentElement;
            if (parent) {
                parent.scrollTop = ta.scrollTop;
                parent.scrollLeft = ta.scrollLeft;
            }
        }

        return {
            apply: apply,
            syncScroll: syncScroll,
            fullRebuild: fullRebuild
        };
    }

    // 静态全文着色（一次性渲染场景—— 产物 pane）：tokenize(全文) + 行拆分，
    // 与 fullRebuild 同源（跨行块注释等上下文正确——逐行独立 Prism.highlight 做不到）。
    // 返回与 text.split('\n') 等长的 HTML 行数组；Prism 未就绪/异常返回 null
    // （调用方纯文本降级）。
    function highlightLines(text, language) {
        try {
            const p = global.Prism;
            if (!p || !language || typeof p.tokenize !== 'function') return null;
            const tokens = p.tokenize(String(text), language);
            return linesFromTokens(tokens).lines;
        } catch (e) {
            return null;
        }
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.hlEngine = { create: create, highlightLines: highlightLines };
})(window);