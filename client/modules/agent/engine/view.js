(function (global) {
    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // 剥离 <context>...</context> 块（动态上下文前缀），UI 不展示给用户。
    // 该块由 controller addMessage 注入，用于 DeepSeek 前缀缓存优化。
    function stripContextBlock(text) {
        if (!text) return text;
        return String(text).replace(/^<context>[\s\S]*?<\/context>\s*\n*/, '');
    }

    // 把 markdown 渲染后的 HTML 中的 chip token（\u200b 定界）还原为标签样式。
    // \u200b(8203) 不在 js-xss stripBlankChar 移除范围（仅 c<=31 与 127），渲染后仍保留，可安全替换。
    // 匹配范围不含外部 2 空格（框外间隙由 span 外的普通空格提供），span 内保留内部 2 空格作框内边距。
    function _renderChipTokensToTags(html) {
        return String(html).replace(/\u200b {2}L\d+(?:-L\d+)?(?:\(\d+\))? {2}\u200b/g, function (m) {
            return '<span class="ae-code-token ae-code-token-msg">' + m.replace(/\u200b/g, '') + '</span>';
        });
    }

    // 属性值转义（title 里带用户数据时必须转义引号/尖括号，否则可越出属性）
    function _attrEsc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // 把已写入 innerHTML/textContent 的聊天内容里的本地路径包成可点击 span
    //（识别规则与点击出口见 utils/localPaths.js / shared/revealPath.js）。
    // 渲染期不读盘：是否存在由点击时校验，失败如实用 toast 报错。
    function _linkifyLocalPaths(el) {
        if (!el) return;
        var lp = global.AEAgentApp && global.AEAgentApp.localPaths;
        if (!lp || typeof lp.linkifyDom !== 'function') return;
        try { lp.linkifyDom(el); } catch (_) { /* 识别失败不影响正文渲染 */ }
    }

    // 图层 token 渲染前掩码：token 载荷里的 : ; @ 等字符可能被 markdown 拆进不同元素，
    // 标签就渲染不出来。故先换成无标记占位符，渲染后再换回标签。
    // 标签 = 「引用 N 个图层」（N 来自载荷条数，与输入框里的 chip 同一文案），id 列表进 title
    //（面板气泡里没有图层名——名不在 token 载荷里，见 utils/chipTokens.js 的口径）。
    // 无图层 token 时原样返回，不改既有渲染路径。
    function _maskLayerTokens(text) {
        var ct = global.AEAgentApp && global.AEAgentApp.chipTokens;
        if (!ct || !text) return { text: text, refs: [] };
        var refs = [];
        var out = String(text).replace(ct.makeScanRe(), function (whole) {
            var parsed = ct.parseLayerToken(whole);
            if (!parsed) return whole;   // 代码 chip 留在文本里，由 _renderChipTokensToTags 渲染
            refs.push(parsed);
            return '\u200bLT' + (refs.length - 1) + '\u200b';
        });
        return { text: out, refs: refs };
    }

    function _unmaskLayerTokens(html, refs) {
        if (!refs || !refs.length) return html;
        var ct = global.AEAgentApp && global.AEAgentApp.chipTokens;
        return String(html).replace(/\u200bLT(\d+)\u200b/g, function (m, idx) {
            var parsed = refs[Number(idx)];
            if (!parsed || !parsed.refs || !parsed.refs.length) return m;
            var items = [];
            for (var i = 0; i < parsed.refs.length; i++) {
                items.push('layerId=' + parsed.refs[i].layerId
                    + '，compositionId=' + parsed.refs[i].compositionId);
            }
            var label = ct && typeof ct.layerLabel === 'function'
                ? ct.layerLabel(parsed.refs.length)
                : AEI18n.t('引用 {n} 个图层', { n: parsed.refs.length });
            // title 只给「引用了哪几层」（两个稳定键），不带定位口径说明——那是实现细节
            var title = _attrEsc(label + '：' + items.join('；'));
            return '<span class="ae-layer-token ae-layer-token-msg" title="' + title + '">' + label + '</span>';
        });
    }

    // 文件引用 token 渲染前掩码：文件名里的 `_` `*` `~` 等会被 markdown 拆成强调/删除线
    //（名带下划线的渲染成斜体、字都可能不见），与图层 token 同一个坑：先换无标记占位符，渲染后换回标签。
    // 只在图层 token 已被掩码掉的文本上跑（那批已成了 \u200bLT<n>\u200b，不再匹配），
    // 代码 chip 由 parseFileToken 返回 null 挡掉（留在文本里给 _renderChipTokensToTags）。
    function _maskFileTokens(text) {
        var ct = global.AEAgentApp && global.AEAgentApp.chipTokens;
        if (!ct || !text) return { text: text, refs: [] };
        var refs = [];
        var out = String(text).replace(ct.makeScanRe(), function (whole) {
            var parsed = ct.parseFileToken(whole);
            if (!parsed) return whole;
            refs.push(parsed);
            return '\u200bFT' + (refs.length - 1) + '\u200b';
        });
        return { text: out, refs: refs };
    }

    // 标签 = 类型 + 同类型文本序编号（「图片1/视频1…」，与输入框 chip 及 resolveFileTokens 同源，
    // 不再显示真名）；真名在 title（原生提示）里——标签只有序号，
    // hover 能查到底引的是哪个文件（与图层 chip 的「标签短、title 给全文」同口径）。
    // 名走 _attrEsc（文件名是用户数据，可能带 < > & "）
    function _unmaskFileTokens(html, refs) {
        if (!refs || !refs.length) return html;
        var ct = global.AEAgentApp && global.AEAgentApp.chipTokens;
        var kindOrdinals = {};
        var labels = [];
        var titles = [];
        for (var i = 0; i < refs.length; i++) {
            var nm = String((refs[i] && refs[i].name) || '');
            var label = nm;
            if (nm && ct && typeof ct.fileLabel === 'function') {
                var kind = ct.fileKind(nm);
                kindOrdinals[kind] = (kindOrdinals[kind] || 0) + 1;
                label = ct.fileLabel(nm, kindOrdinals[kind]);
            }
            labels.push(label);
            titles.push(label + '：' + nm);
        }
        return String(html).replace(/\u200bFT(\d+)\u200b/g, function (m, idx) {
            var j = Number(idx);
            var parsed = refs[j];
            if (!parsed || !parsed.name) return m;
            return '<span class="ae-file-token ae-file-token-msg" title="' + _attrEsc(titles[j]) + '">'
                + _attrEsc(labels[j]) + '</span>';
        });
    }

    // 项目项引用 token 渲染前掩码：token 载荷里的 `@ : ,` 可能被 markdown 拆进不同元素，
    // 标签就渲染不出来。与图层/文件 token 同一个坑：先换无标记占位符，渲染后换回标签。
    // 标签 =「引用 N 个对象」（N 来自载荷条数，与输入框里的 chip 同一文案），类型与 id 列表进 title
    //（面板气泡里没有对象名——名不在 token 载荷里，见 utils/chipTokens.js 的口径）。
    // 无项目项 token 时原样返回，不改既有渲染路径。
    function _maskItemTokens(text) {
        var ct = global.AEAgentApp && global.AEAgentApp.chipTokens;
        if (!ct || !text) return { text: text, refs: [] };
        var refs = [];
        var out = String(text).replace(ct.makeScanRe(), function (whole) {
            var parsed = ct.parseItemToken(whole);
            if (!parsed) return whole;   // 代码/图层/文件 token 留在文本里，由各自的分支处理
            refs.push(parsed);
            return '\u200bIT' + (refs.length - 1) + '\u200b';
        });
        return { text: out, refs: refs };
    }

    function _unmaskItemTokens(html, refs) {
        if (!refs || !refs.length) return html;
        var ct = global.AEAgentApp && global.AEAgentApp.chipTokens;
        return String(html).replace(/\u200bIT(\d+)\u200b/g, function (m, idx) {
            var parsed = refs[Number(idx)];
            if (!parsed || !parsed.items || !parsed.items.length) return m;
            var items = [];
            for (var i = 0; i < parsed.items.length; i++) {
                items.push((parsed.items[i].type === 'comp' ? AEI18n.t('合成') : AEI18n.t('素材')) + ' id=' + parsed.items[i].id);
            }
            var label = ct && typeof ct.itemLabel === 'function'
                ? ct.itemLabel(parsed.items.length)
                : AEI18n.t('引用 {n} 个对象', { n: parsed.items.length });
            // title 只给「引用了哪些对象」（类型 + id）——定位参数名属实现细节，不上气泡 title
            var title = _attrEsc(label + '：' + items.join('；'));
            return '<span class="ae-item-token ae-item-token-msg" title="' + title + '">' + label + '</span>';
        });
    }

    // 文本 → 气泡 HTML：引用类 token（图层 / 项目项 / 文件）先掩码（抗 markdown 拆词），
    // 代码 chip 仍走渲染后替换。掩码顺序与 chipTokens 的分支顺序同向（图层 → 项目项 → 文件）。
    // 本地路径在 markdown 之前掩码：路径里的 `\_` `\*` 等会被 markdown 当转义序列吃掉反斜杠
    //（`temp\chat_img` 渲染成 `temp_chat_img`），渲染后再识别就认不出路径。
    // 本地图片语法（`![alt](本地路径)`）必须赶在路径掩码之前整段换占位：路径先被掩码会
    // 破坏 markdown 图片语法；还原放在最后，第三方（chip token / 路径 span）都不碰它。
    function _chipTokensToHtml(text, renderFn) {
        var masked = _maskLayerTokens(text);
        var maskedItems = _maskItemTokens(masked.text);
        var maskedFiles = _maskFileTokens(maskedItems.text);
        var lp = global.AEAgentApp && global.AEAgentApp.localPaths;
        var maskedImages = (lp && typeof lp.maskImages === 'function')
            ? lp.maskImages(maskedFiles.text)
            : { text: maskedFiles.text, refs: [] };
        var maskedPaths = (lp && typeof lp.maskText === 'function')
            ? lp.maskText(maskedImages.text)
            : { text: maskedImages.text, refs: [] };
        var html = _unmaskFileTokens(renderFn(maskedPaths.text), maskedFiles.refs);
        html = _unmaskLayerTokens(_unmaskItemTokens(html, maskedItems.refs), masked.refs);
        if (lp && typeof lp.unmaskImages === 'function') {
            html = lp.unmaskImages(html, maskedImages.refs);
        }
        return (lp && typeof lp.unmaskHtml === 'function')
            ? lp.unmaskHtml(html, maskedPaths.refs)
            : html;
    }

    function createAgentView(options) {
        var opts = options || {};

        // ── 团队模式：本 view 的 DOM id 参数化 ──
        // 每条 lane 一个 view 实例，各自指向自己的容器；缺省值 = 单 Agent 现状 id
        //（逐字节不变）。调用点一律经 _byId，不再硬编码单例 id——否则 lane 的流式气泡
        // 会写进「单 Agent 的隐藏容器」，随后被 renderMessages 清理 ⇒ 内容凭空消失。
        var DOM_DEFAULTS = {
            listId: 'aeAgentMessageList',
            statusId: 'status',
            inlineStatusId: 'aeAgentInlineStatus',
            statusPanelId: 'aeAgentStatusPanel',
            tokenStatsId: 'aeAgentTokenStats'
        };
        var dom = {};
        Object.keys(DOM_DEFAULTS).forEach(function (k) {
            var v = (opts.dom && opts.dom[k]) || '';
            dom[k] = v || DOM_DEFAULTS[k];   // 缺省/空串一律回落现状 id
        });
        // 惰性查询：document 可能在 createView 之后才被挂上（测试环境即如此），
        // 故此处不缓存元素引用，每次调用重新取。
        function _byId(k) { return document.getElementById(dom[k]); }
        // 返回五个键的副本：调用方就地改自己那份不影响内部 dom
        function getDom() {
            return {
                listId: dom.listId,
                statusId: dom.statusId,
                inlineStatusId: dom.inlineStatusId,
                statusPanelId: dom.statusPanelId,
                tokenStatsId: dom.tokenStatsId
            };
        }

        var getDebugMode = typeof opts.getDebugMode === 'function' ? opts.getDebugMode : function () { return false; };
        var lastBusy = false;
        // ── 共用状态栏（团队模式）──
        // 三条 lane 的 statusId / inlineStatusId / statusPanelId 都指向单例
        //（team/lanes.js 的 domFor），lane 内不再各带一条顶栏。
        // 同一时刻只允许**当前 lane** 往这条栏写：非当前 lane 的忙态只记在本地
        //（_laneBusy / _laneBusyText），切到它时由 bootstrap 的 onCurrentLaneChange 调
        // replayBusy() 重放——否则隐藏 lane 的「调用工具: x…」会盖掉用户正在看的那条。
        // 单 Agent 路径（sharedStatus 缺省 false）逐字不变：闸门恒开。
        var _sharedStatus = !!opts.sharedStatus;
        var _isCurrentLaneFn = (typeof opts.isCurrentLane === 'function') ? opts.isCurrentLane : null;
        var _laneBusy = false;
        var _laneBusyText = '';
        function _statusWritable() {
            if (!_sharedStatus) return true;
            if (!_isCurrentLaneFn) return true;
            try { return !!_isCurrentLaneFn(); } catch (_) { return true; }
        }
        var _renderedCount = 0;
        var _renderBatchToken = 0;  // 分批渲染版本号：新渲染请求使旧批次作废
        // 分批渲染进行态（有续帧排队未完成）。分批期间 appendToken /
        // appendReasoningToken / appendLocalMessage 插入的元素比「尚未渲染的历史」
        // 更新，必须排在它们之后——否则后续批次帧 appendChild 的历史消息会把这些
        // 气泡/本地消息埋进历史中间。登记进 _liveTailEls，每帧收尾归位到列表末尾
        var _batchActive = false;
        var _liveTailEls = [];
        // 最近一个已定形、尚未被 renderMessages 认领的思考块。同一轮里正式回答先落地、
        // 剩余思考随后到达时，appendReasoningToken 用它把思考续写回同一块，避免同一轮
        // 出现两个「思考过程」。被认领（或容器重建/清理）后置空。
        var _lastFinalizedReasoning = null;

        function _registerLiveTail(el) {
            if (!el) return;
            for (var i = 0; i < _liveTailEls.length; i++) {
                if (_liveTailEls[i] === el) return;
            }
            _liveTailEls.push(el);
        }

        // 按 DOM 顺序把活尾部元素移回列表末尾（appendChild 对已挂载子元素是移动
        // 语义）；已被移除/已脱离 listEl 的登记项自然跳过
        function _reorderLiveTail(listEl) {
            if (!_liveTailEls.length || !listEl) return;
            var kids = Array.prototype.slice.call(listEl.children || []);
            for (var k = 0; k < kids.length; k++) {
                var child = kids[k];
                for (var m = 0; m < _liveTailEls.length; m++) {
                    if (child === _liveTailEls[m]) {
                        listEl.appendChild(child);
                        break;
                    }
                }
            }
        }

        // ── 子 Agent 内联卡片 ──
        // 卡片是**发起者 lane 的消息流里的活元素**（不在 state.messages 里）：
        //   · 不进消息数组 ⇒ renderMessages 的增量/全量逻辑都不认识它；
        //   · 但全量重置会 listEl.innerHTML = ''（整表重建）——卡片必须像流式气泡一样，在每次
        //     渲染收尾被重新挂回列表尾部。否则「回放一条真实消息」就会把用户刚看到的子 Agent
        //     卡片整块抹掉（chatViewHelpers._LIVE_ELS 拦下重建是同一件事的另一面：那里是别重建，
        //     这里是重建了也得把活元素归位）。
        //   · 节点按 id 复用：状态/耗时/token 就地改文本，不整块重建（1s 一次的兜底轮询若重建
        //     DOM，会把用户正在悬停/划选的那张卡抽掉——真机表现为「卡片一闪一闪」）。
        // 每个 view 实例自带一份卡片表 ⇒ 非当前 lane 的卡片留在它自己的列表里，切 lane 只是
        // 显隐切换，不跨 lane 搬节点（搬过去会让 A 的子 Agent 出现在 B 的消息流里）。
        var _subagentCardEls = [];      // 卡片节点，按登记顺序（= 渲染顺序）
        var _subagentCardIndex = {};    // id -> 节点（复用判据）

        // 文案/类名/耗时/token **全部**来自 taskBoard.deriveSubagentView（唯一一份映射）。
        // 派生面缺席（老包 / manifest 载序错）时不在这里补一套映射：状态显示**原值**、类名
        // is-unknown——与纯函数对未知 state 的兜底同义（「我不认识它」比「假装它空闲」诚实）。
        function _subagentViewOf(info) {
            var api = global.AEAgentTeam;
            if (api && typeof api.deriveSubagentView === 'function') {
                try {
                    var v = api.deriveSubagentView(info);
                    if (v) return v;
                } catch (_) { /* 派生抛错 → 落下面的原值兜底：一条坏数据不该让卡片整块不画 */ }
            }
            var it = info || {};
            var fmt = (api && typeof api.formatElapsed === 'function') ? api.formatElapsed : null;
            return {
                key: (it.id == null) ? '' : String(it.id),
                title: (it.title == null) ? '' : String(it.title),
                stateText: (it.state == null) ? '' : String(it.state),
                stateClass: 'is-unknown',
                elapsedText: fmt ? fmt(it.elapsedMs) : '--',
                tokensText: ''
            };
        }

        // 卡片的元信息行（耗时 · token）：空的那一项不进拼接——否则会留下一个悬空的「· 」。
        // 这里只拼**标签与分隔符**，数字全部来自派生结果（不在这里算秒数/token 数）。
        function _subagentMetaText(view) {
            var parts = [];
            if (view.elapsedText) parts.push(AEI18n.t('耗时 {elapsed}', { elapsed: view.elapsedText }));
            if (view.tokensText) parts.push('token ' + view.tokensText);
            return parts.join(' · ');
        }

        // 卡片文本落 DOM（复用 ⇒ 每个格子**无条件覆盖**，漏一个就会把上一个子 Agent 的值留在这张卡上）
        function _paintSubagentCard(el, info) {
            var v = _subagentViewOf(info);
            el.setAttribute('data-subagent-id', v.key || '');
            if (el.children[0]) el.children[0].textContent = '[' + (v.title || '') + ']';
            if (el.children[1]) {
                el.children[1].textContent = v.stateText || '';
                el.children[1].className = 'ae-agent-subagent-card-state'
                    + (v.stateClass ? ' ' + v.stateClass : '');
            }
            if (el.children[2]) el.children[2].textContent = _subagentMetaText(v);
            return el;
        }

        // 卡片插入锚点：第一张已挂在列表里的卡片。流式气泡/本地消息插到它**之前**，
        // 卡片因此恒在列表尾部（没有卡片时返回 null ⇒ 调用方原样 appendChild，单 Agent 路径不变）。
        function _subagentAnchor(listEl) {
            if (!listEl || !_subagentCardEls.length) return null;
            for (var i = 0; i < _subagentCardEls.length; i++) {
                var el = _subagentCardEls[i];
                if (el && el.parentNode === listEl) return el;
            }
            return null;
        }

        // 渲染收尾归位：整表重建（renderMessages 里的 innerHTML = ''）会把卡片摘掉，这里无条件
        // 把它们按登记序挂回列表尾部。appendChild 对已挂载节点是移动语义，重复调用等价（幂等）。
        function _reattachSubagentCards(listEl) {
            if (!listEl || !_subagentCardEls.length) return;
            for (var i = 0; i < _subagentCardEls.length; i++) listEl.appendChild(_subagentCardEls[i]);
        }

        // 卡片面（冻结签名）：info = { id, title, state, elapsedMs, tokens }。
        // 按 id 复用节点；同一个 id 反复调用只改文本，不新建节点。
        function upsertSubagentCard(info) {
            var it = info || {};
            var id = (it.id == null) ? '' : String(it.id);
            if (!id) return null;      // 没有 id 就没有复用判据：不画（否则每调一次多出一张无主卡片）
            var el = _subagentCardIndex[id] || null;
            if (!el) {
                el = document.createElement('div');
                el.className = 'ae-agent-subagent-card';
                var titleEl = document.createElement('span');
                titleEl.className = 'ae-agent-subagent-card-title';
                var stateEl = document.createElement('span');
                stateEl.className = 'ae-agent-subagent-card-state';
                var metaEl = document.createElement('span');
                metaEl.className = 'ae-agent-subagent-card-meta';
                el.appendChild(titleEl);
                el.appendChild(stateEl);
                el.appendChild(metaEl);
                _subagentCardIndex[id] = el;
                _subagentCardEls.push(el);
            }
            _paintSubagentCard(el, it);
            var listEl = _byId('listId');
            // 列表不在（未挂载/别的模块正显示）时也保留登记：渲染收尾的归位会把它挂上去，
            // 不在这里丢节点——丢了就等于卡片消失，而它对应的子 Agent 还在跑。
            if (listEl) listEl.appendChild(el);
            _scheduleFollow();   // 卡片插入/改文本都可能改变高度
            return el;
        }

        // 移除卡片（池子释放保活/回收后由 UI 调）：返回是否真的移除了。
        // 元素从登记表里一并摘掉，收尾归位不会再把它挂回来。
        function removeSubagentCard(id) {
            var key = (id == null) ? '' : String(id);
            var el = _subagentCardIndex[key] || null;
            if (!el) return false;
            if (el.parentNode) el.parentNode.removeChild(el);
            delete _subagentCardIndex[key];
            for (var i = 0; i < _subagentCardEls.length; i++) {
                if (_subagentCardEls[i] === el) { _subagentCardEls.splice(i, 1); break; }
            }
            _scheduleFollow();
            return true;
        }

        // ── 窗口化挂载（大会话性能根因修复）──
        // 实测（CDP 二分实验）：列表全量挂载 375 个子块（消息/工具组/推理组，约 5800 节点）时，
        // 面板 resize 每帧的重排/绘制调度仍要遍历全部挂载元素，CEF 软件渲染下拖拽卡顿秒级；
        // content-visibility 只优化离屏内容，救不了"挂载总量"。只挂载最近 _MOUNT_CAP 个子元素，
        // 更早的 display:none（DOM 保留，不重渲染）；触顶时按批恢复并锚定滚动位置。
        // 状态挂列表元素上（__mountFloor），跨 view 实例（模块重进）保持一致。
        // CAP 取 150（80 → 150）。a11y 序列化主根因已由 manifest
        // --disable-renderer-accessibility 消除，残留成本只剩纯布局/绘制遍历；
        // 全量挂载在超长会话（数百块）下仍有可感知顿挫（实测确认），故保留窗口化。
        // CAP 放宽到 150（一屏约 5-8 条，≈ 20+ 屏连续阅读），实测 300 仍会顿挫。
        // 注：resize 卡顿的大头是拖选代码激活 a11y 树所致（18k 节点全树序列化
        // ~1.5s/次），与挂载量无关，已另行根治。
        var _MOUNT_CAP = 150;
        var _MOUNT_BATCH = 50;
        var _MOUNT_TOP_THRESHOLD = 24;  // scrollTop 视为"触顶"的阈值(px)

        // ── 自动跟随底部（唯一实现）──
        // 若每条会写 DOM 的路径（renderMessages / appendToken / flush* / 工具卡 /
        // 本地消息…）各自在插入**前**测一次 (scrollHeight - scrollTop - clientHeight) < 30，
        // 命中才滚底。判定是插入前的快照，而块的高度可能在快照之后才变——图片/视频加载、
        // 破图占位替换（120×90）、工具进度行被结果行替换、思考块定形折叠……任何一次这样的
        // 长高都会把「贴底」变成「距底 > 阈值」，此后所有流式 token 都被判成「用户在看历史」
        // → 自动滚动永久失效，要手动滚到底才恢复（真机：系统卡带图时距底 88px 即触发）。
        // 现实现把「是否跟随底部」当状态维护，而不是每次插入前重新猜：
        //   · 用户主动上滚（scrollTop 变小且远离底部）→ 关；滚回贴底 → 开；
        //   · 任何内容/尺寸变化后调 _scheduleFollow()：贴底则统一滚到底（rAF 合并，
        //     一帧最多一次），不管这次变化来自渲染、流式文本还是异步长高；
        //   · 列表内的媒体事件（load/error/loadedmetadata，capture 方式能收到不冒泡的事件）
        //     与列表自身尺寸变化（ResizeObserver，CEF 88 支持）都接同一调度点。
        // 旧判定常量 30 与新阈值不一致会留下缝隙：统一到 _FOLLOW_THRESHOLD。
        var _FOLLOW_THRESHOLD = 24;   // 距底 ≤ 此值视为"贴底"（用户意图判定与跟随状态一致）
        var _followBottom = true;     // 是否跟随底部（新列表/整表重建从贴底开始）
        var _followRaf = 0;           // 跟随调度 rAF（合并同一帧内的多次请求）
        var _lastScrollTop = 0;       // 上一次 scroll 事件里的 scrollTop（判用户滚动方向）

        function _distToBottom(el) {
            return el.scrollHeight - el.scrollTop - el.clientHeight;
        }

        // 跟随状态同步（**唯一判定点**）：用当前 scrollTop 与上次基线比较，而不是只信
        // scroll 事件——CEF 88 里程序性滚动/滚轮滚动的 scroll 事件可能晚于 rAF 回调，
        // 只靠事件判定会出现「用户已上滚、跟随却还是开」的竞态（真机复现：视口被拽回底部）。
        //   · 贴底 + 向下移动           → 跟随
        //   · 向上移动且已离底           → 不跟随（用户在看历史）
        //   · 未移动（st==基线）        → 不改状态：内容长高不能把跟随判成离底（判成离底即跟随失效），
        //     内容收缩也不能把它重新打开（否则用户上翻时一次折叠会把视口拽回底部）
        //   · 向上移动但距底没变大（内容收缩导致的钳制）→ 不关跟随
        function _syncFollow(el) {
            // 列表没有布局盒（模块未显示 / 非当前 lane 的 display:none）：几何量全 0，
            // 「0-0-0=0」会被误判成贴底并把跟随状态静默复位。此态不做判定。
            if (!el.clientHeight) return _followBottom;
            var st = el.scrollTop;
            var dist = _distToBottom(el);
            if (st < _lastScrollTop - 1) {
                if (dist > _FOLLOW_THRESHOLD) _followBottom = false;
            } else if (st > _lastScrollTop + 1) {
                if (dist <= _FOLLOW_THRESHOLD) _followBottom = true;
            }
            _lastScrollTop = st;
            return _followBottom;
        }

        // scroll 事件入口：同步状态 + 判断是否改走触顶/收窗。
        function _noteScroll(el) {
            _syncFollow(el);
        }

        // 滚到底（含窗口化挂载的窗口推进）。follow 状态由调用方决定，本函数只执行动作：
        // 历史浏览模式下尾部 CAP 外的块 display:none，scrollHeight 只反映挂载窗口——直接
        // scrollTop = scrollHeight 会停在窗口底而非会话底，故先推进窗口到最新 CAP 条。
        function _scrollPin(listEl, smooth) {
            var kids = listEl.children;
            var n = kids.length;
            var advanced = false;
            if (n > _MOUNT_CAP) {
                var target = n - _MOUNT_CAP;
                if ((listEl.__mountFloor || 0) < target) {
                    listEl.__topRevealUntil = 0;  // 主动回底，解除触顶静默期
                    // 作废在途的触顶分帧恢复：它剩余帧还会把 [newFloor, 旧 floor) 的块
                    // 逐个显示出来，而那些块已被这次推进藏到窗口外（窗口不变量被破坏、
                    // 挂载量超 CAP，且收窗循环从新 floor 起永远不回收它们）。
                    _revealFrameToken++;
                    _revealFrameActive = false;
                    _applyFloor(listEl, target);
                    advanced = true;
                }
            }
            // 窗口推进（隐藏头部 → scrollHeight 大幅收缩）后禁用 smooth：CEF 88 的
            // 平滑动画与布局剧变互相干扰，终点不可控（实测停在半途）。跨窗口大跳
            // 本就无需动画；仅在已处于尾部窗口时才平滑滚动。
            if (!advanced && smooth && typeof listEl.scrollTo === 'function') {
                listEl.scrollTo({ top: listEl.scrollHeight, behavior: 'smooth' });
            } else {
                listEl.scrollTop = listEl.scrollHeight;
            }
            // 程序性回底后同步滚动基线：否则下一次用户上滚时，scroll 事件会拿"很久以前"
            // 的 scrollTop 做方向比较，把「上滚」误判成「下滚」，跟随关不掉（视口被拽回底部）。
            _lastScrollTop = listEl.scrollTop;
        }

        // 内容/尺寸变化后调用：跟随中则下一帧统一回底。非跟随状态直接返回，不扰动阅读位置。
        // 执行前再对一次状态：调度到执行的这一帧里用户可能已经上滚（滚轮/scroll 事件晚到）。
        function _scheduleFollow() {
            if (!_followBottom || _followRaf) return;
            _followRaf = requestAnimationFrame(function () {
                _followRaf = 0;
                var el = _byId('listId');
                if (!el || !el.clientHeight) return;   // 未渲染/已隐藏：不写滚动也不改状态
                if (!_syncFollow(el)) return;   // 用户已上滚/已离底
                _scrollPin(el, false);
            });
        }

        // 立即回底（流式帧内用，省一次 rAF 延迟；同样只在跟随中生效）。
        function _followNow(listEl) {
            if (!listEl || !listEl.clientHeight) return;   // 布局盒缺席（模块未显示/非当前 lane）
            if (!_syncFollow(listEl)) return;
            _scrollPin(listEl, false);
        }

        // ── 折叠块 transition 延迟恢复（加载性能根因修复）──
        // 若每个工具组/思考块 append 后立即 void offsetHeight 强制同步布局再恢复
        // transition：分批渲染长会话时（数百个折叠块 × 每次强制布局遍历整棵脏树）为
        // O(n²) 累积开销，CEF 软件渲染下加载期任何输入事件（悬停/滚动/点击）都触发
        // 秒级冻结。改为收集后双 rAF 批量恢复：首帧以 transition:none 落收起态并绘制，
        // 次帧恢复 transition（无样式值变化，不触发过渡），全程零强制布局。
        var _pendingTransitionRestore = [];
        var _transitionRestoreScheduled = false;
        function _deferTransitionRestore(el) {
            _pendingTransitionRestore.push(el);
            if (_transitionRestoreScheduled) return;
            _transitionRestoreScheduled = true;
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    _transitionRestoreScheduled = false;
                    var batch = _pendingTransitionRestore;
                    _pendingTransitionRestore = [];
                    for (var i = 0; i < batch.length; i++) batch[i].style.transition = '';
                });
            });
        }

        // 应用挂载窗口：显示 [floor, floor+CAP)，头尾之外全藏。
        // 旧语义只藏头部（floor 之前），触顶展开后尾部不回收，挂载量会涨破 CAP。
        function _applyFloor(listEl, floor) {
            var kids = listEl.children;
            var ceil = floor + _MOUNT_CAP;
            for (var i = 0; i < kids.length; i++) {
                kids[i].style.display = (i >= floor && i < ceil) ? '' : 'none';
            }
            listEl.__mountFloor = floor;
        }

        // 收窗：子元素数量超过上限时只保留最近 CAP 个挂载（含触顶展开后的回收）。
        // 无条件执行——流式期间 tool-group 等会被业务代码重建丢失 display:none，
        // 靠 MutationObserver 在每次变更后重新校准。
        function _enforceMountWindow(listEl) {
            // 触顶恢复静默期：_revealEarlier 刚恢复头部一批后的短时间内不收窗，
            // 避免恢复引发的 scroll 事件立即把刚恢复的历史块藏回。
            if (listEl.__topRevealUntil && Date.now() < listEl.__topRevealUntil) return;
            var kids = listEl.children;
            var n = kids.length;
            var floor = listEl.__mountFloor || 0;
            if (n <= _MOUNT_CAP) {
                if (floor > 0) _applyFloor(listEl, 0);  // 列表清空/重渲染后归位
                return;
            }
            var maxFloor = n - _MOUNT_CAP;
            if (maxFloor <= floor) return;
            // 只有视口贴近窗口底部才推进。上翻阅读历史期间（floor < maxFloor）绝不能
            // 收窗：旧保护条件 scrollTop < hiddenH + 200 在 scrollTop 被瞬时高度/
            // 程序性定位污染时误判，刚恢复的历史被藏回、视口跳变。
            var nearBottom = (listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight) < 60;
            if (!nearBottom) return;
            // 向下推进：与触顶恢复（_revealEarlier）对称的锚定推进，每次只推进一批
            // （BATCH 个）。绝不能一步跳到 n-CAP：多批触顶恢复后（floor 与 n-CAP 相差
            // 超 CAP）目标窗口与当前窗口完全不重叠，会把用户正在看的整个旧窗口连同
            // 视口内容藏掉，且锚定块 kids[target] 处于 display:none（offsetTop=0）、
            // 补偿失效，视口飞走一整页。分批推进保证 target 恒在当前窗口内（可见），
            // 锚定测量有效；用户继续下滚到底后再触发下一批，直到会话真正的底部。
            // 收缩量用首个保留块的 offsetTop 前后差值测量：offsetHeight 不含 margin，
            // 块间 margin 折叠会让"逐块高度求和"偏差数百 px（实测 408px）。
            // stBefore 必须在 display 写入前捕获：头部隐藏使 scrollHeight 收缩的瞬间，
            // 浏览器会把超界的 scrollTop 钳制到新最大值（实测被扣 720px），之后再用
            // 被污染的当前值做减法会双重扣减。
            var target = Math.min(floor + _MOUNT_BATCH, maxFloor);
            var newCeil = target + _MOUNT_CAP;
            var listTop = listEl.getBoundingClientRect().top;
            var headSafe = kids[target - 1].getBoundingClientRect().bottom <= listTop + 1;
            var kept = kids[target];
            var keptTopBefore = kept.offsetTop;  // 集中在写前读（target 在当前窗口内，必可见）
            var stBefore = listEl.scrollTop;
            listEl.__mountFloor = target;
            if (headSafe) {
                for (var i2 = floor; i2 < target; i2++) kids[i2].style.display = 'none';
                for (var j = floor + _MOUNT_CAP; j < newCeil; j++) kids[j].style.display = '';
                var shrink = keptTopBefore - kept.offsetTop;  // 写后一次读（单次强制布局）
                if (shrink > 0) listEl.scrollTop = Math.max(0, stBefore - shrink);
            } else {
                // 罕见：头部块仍与视口相交（窗口整体矮于视口）。只显示尾部、暂不隐藏
                // 头部，挂载量临时超 CAP；设钳制静默期防止 _clampToWindow 立即把
                // 视口内的头块藏掉造成跳变，滚动手窗口自然校准。
                for (var j2 = floor + _MOUNT_CAP; j2 < newCeil; j2++) kids[j2].style.display = '';
                listEl.__downGuardUntil = Date.now() + 400;
            }
        }

        // 触顶加载：滑动窗口——头部恢复一批（BATCH 个）、尾部回收等量块，挂载量恒定 ≤ CAP。
        // 视口锚定：触顶时用户只是在往上翻消息，恢复的历史块插入视口上方，正在看的
        // 内容必须原地不动（跳到新批页首 = 视口飞走一整页）。分帧恢复时每帧
        // 按本帧新增高度补偿 scrollTop，锚定块（旧 floor）始终停在视口顶部。
        // 注意补偿量只算"本帧新显示块的高度"：尾部回收发生在视口下方，不影响锚定，
        // 若混入测量（旧两阶段做法）补偿量会被尾部回收量污染（实测偏差 1.4k px）。
        // 分帧（每帧 3 块）：一次同步恢复 30 块的整批布局+绘制是触顶卡顿主因。
        var _revealFrameToken = 0;
        var _revealFrameActive = false;
        function _revealEarlier(listEl) {
            var floor = listEl.__mountFloor || 0;
            if (floor <= 0) return;
            var kids = listEl.children;
            var newFloor = Math.max(0, floor - _MOUNT_BATCH);
            listEl.__mountFloor = newFloor;  // 先记录：分帧期间 clamp/收窗按新窗口计算
            // 尾部回收同步做：display:none 赋值便宜，且尾部在视口下方不影响锚定
            var ceil = newFloor + _MOUNT_CAP;
            for (var i = ceil; i < kids.length; i++) kids[i].style.display = 'none';
            // 头部分帧恢复 + 逐帧锚定补偿
            var token = ++_revealFrameToken;
            var idx = newFloor;
            _revealFrameActive = true;
            function step() {
                if (token !== _revealFrameToken) return;  // 新一批开始/重渲染使旧批次作废
                var prevH = listEl.scrollHeight;
                var cnt = 0;
                while (idx < floor && cnt < 3) {
                    kids[idx].style.display = '';
                    idx++; cnt++;
                }
                if (cnt > 0) listEl.scrollTop += (listEl.scrollHeight - prevH);
                if (idx < floor) {
                    requestAnimationFrame(step);
                } else {
                    _revealFrameActive = false;  // 本批完成，恢复正常钳制
                }
            }
            step();
            // 静默期：见 _enforceMountWindow 入口注释。分帧恢复耗时更长，相应放宽。
            listEl.__topRevealUntil = Date.now() + 800;
        }

        // 窗口钳制：确保 [floor, floor+CAP) 之外的子元素全部隐藏、窗口内全部可见。
        // 业务代码（工具状态刷新等）会重建 tool-group，新元素不带内联 display:none，
        // 会以可见状态漏在窗口外（用户看到"只有工具记录没有回复"即此因）。
        // _enforceMountWindow 在阅读历史模式下会缓一拍不校准，这里无条件兜底。
        // 分帧恢复期间（_revealFrameActive，见 _revealEarlier）只藏不显：显示由分帧
        // 步进器逐块执行，这里若把窗口内未恢复块一次性全显会绕过分帧。
        function _clampToWindow(listEl) {
            // 向下推进的罕见分支（头部块在视口内，见 _enforceMountWindow）设置的
            // 钳制静默期：立即钳制会把视口内的头块藏掉造成跳变
            if (listEl.__downGuardUntil && Date.now() < listEl.__downGuardUntil) return;
            var floor = listEl.__mountFloor || 0;
            if (floor <= 0 && listEl.children.length <= _MOUNT_CAP) return;
            var kids = listEl.children;
            var ceil = floor + _MOUNT_CAP;
            for (var i = 0; i < kids.length; i++) {
                var inWin = i >= floor && i < ceil;
                if (inWin) {
                    if (!_revealFrameActive && kids[i].style.display === 'none') kids[i].style.display = '';
                } else if (kids[i].style.display !== 'none') {
                    kids[i].style.display = 'none';
                }
            }
        }

        // 回到底部（含窗口推进）：历史浏览模式下尾部 CAP 外的块处于 display:none，
        // scrollHeight 只反映挂载窗口——直接 scrollTo(scrollHeight) 会停在窗口底
        // 而非会话底。先推进窗口到最新 CAP 条，再滚到真正的底部。
        // 挂到列表元素上（__aeScrollToBottom），供"回到最底部"按钮等外部调用。
        // 显式回底 = 恢复跟随（用户按下按钮/发送消息的语义是「我要看最新」）。
        function scrollListToBottom(listEl, smooth) {
            _followBottom = true;
            _scrollPin(listEl, smooth);
        }

        // 挂载窗口的事件登记：view.destroy() 要能精确解绑自己绑上去的
        // 监听/观察者（进出团队会重建 view；不解绑时新 view 会与旧监听并存，或 __mountObs 守卫
        // 让新 view 静默失效）。只登记「本次 view 实例」绑的东西，模块级共享元素仍不销毁。
        var _mountListEl = null;
        var _mountObs = null;
        var _mountFollowRO = null;
        var _mountMediaHandlers = [];   // [{ el, type, fn }]
        var _mountScrollHandler = null;
        var _mountErrorHandler = null;

        function _bindMountWindow(listEl) {
            if (listEl.__mountObs) return;  // 列表元素常驻 DOM，只绑一次
            _mountListEl = listEl;
            listEl.__aeScrollToBottom = function () { scrollListToBottom(listEl, true); };
            _lastScrollTop = listEl.scrollTop;
            var raf = 0;
            _mountObs = new MutationObserver(function () {
                if (raf) return;
                raf = requestAnimationFrame(function () {
                    raf = 0;
                    var el = _byId('listId');
                    if (el) {
                        _enforceMountWindow(el);
                        _clampToWindow(el);  // 兜底：重建的工具组等漏网元素重新收进窗口
                        _scheduleFollow();   // 变更可能让内容长高（如图占位替换），跟随中补一次回底
                    }
                });
            });
            listEl.__mountObs = _mountObs;
            _mountObs.observe(listEl, { childList: true });
            // 媒体异步长高：img/video 的 load/error/loadedmetadata 不冒泡，capture 阶段能收到。
            // 这类长高发生在渲染时的滚动之后（跟随正是在此丢掉），必须重新贴底。
            var _mediaEvents = ['load', 'error', 'loadedmetadata', 'loadstart', 'durationchange'];
            for (var _me = 0; _me < _mediaEvents.length; _me++) {
                (function (type) {
                    var fn = function () { _scheduleFollow(); };
                    listEl.addEventListener(type, fn, true);
                    _mountMediaHandlers.push({ el: listEl, type: type, fn: fn, capture: true });
                })(_mediaEvents[_me]);
            }
            // markdown 本地图片（localPaths.unmaskImages 还原的 file:// 图）加载失败：
            // 换成与附件缩略图同款占位，不留破图。error 不冒泡，用 capture 收；只认本功能
            // 的 class，附件缩略图自理（_attachMissingFallback）。
            _mountErrorHandler = function (e) {
                var t = e && e.target;
                if (!t || t.tagName !== 'IMG' || !t.classList
                    || !t.classList.contains('ae-agent-md-img') || t.__aeMdImgFailed) {
                    return;
                }
                t.__aeMdImgFailed = true;
                var ph = document.createElement('div');
                ph.className = 'ae-agent-attach-missing ae-agent-md-img-missing';
                ph.textContent = AEI18n.t('图片无法显示');
                ph.title = t.getAttribute('data-path') || t.getAttribute('src') || '';
                if (t.parentNode) t.parentNode.replaceChild(ph, t);
                _scheduleFollow();
            };
            listEl.addEventListener('error', _mountErrorHandler, true);
            _mountMediaHandlers.push({ el: listEl, type: 'error', fn: _mountErrorHandler, capture: true });
            // 列表自身尺寸变化（面板拖拽、输入区/提问面板切换显隐）也会改变"距底"：
            // 跟随中要跟到新视口的底部；阅读历史时不动（follow 已关）。
            if (typeof ResizeObserver === 'function') {
                try {
                    _mountFollowRO = new ResizeObserver(function () { _scheduleFollow(); });
                    listEl.__followRO = _mountFollowRO;
                    _mountFollowRO.observe(listEl);
                } catch (_) { /* 观察失败不影响显式调用点的回底 */ }
            }
            _mountScrollHandler = function () {
                // 先更新跟随状态：程序性回底（scrollTop 变大）不会把 follow 关掉，
                // 用户上滚（scrollTop 变小且远离底部）才会。
                _noteScroll(listEl);
                if (listEl.scrollTop <= _MOUNT_TOP_THRESHOLD) {
                    _revealEarlier(listEl);
                } else {
                    // 离开顶部后回收触顶展开的历史块，挂载量回落到 CAP（带视觉位置补偿）
                    _enforceMountWindow(listEl);
                }
            };
            listEl.addEventListener('scroll', _mountScrollHandler);
        }

        // 解绑 _bindMountWindow 绑上去的一切（destroy 的唯一调用点）。幂等。
        function _unbindMountWindow() {
            var listEl = _mountListEl;
            _mountListEl = null;
            if (_followRaf) {
                try { cancelAnimationFrame(_followRaf); } catch (_) { /* 无 rAF 环境 */ }
                _followRaf = 0;
            }
            _revealFrameToken++;   // 作废在途的触顶分帧恢复（回调不再写 DOM）
            _revealFrameActive = false;
            if (_mountObs) {
                try { _mountObs.disconnect(); } catch (_) { /* 已断开 */ }
                _mountObs = null;
            }
            if (_mountFollowRO) {
                try { _mountFollowRO.disconnect(); } catch (_) { /* 已断开 */ }
                _mountFollowRO = null;
            }
            for (var i = 0; i < _mountMediaHandlers.length; i++) {
                var h = _mountMediaHandlers[i];
                try { h.el.removeEventListener(h.type, h.fn, h.capture === true); } catch (_) { /* 已移除 */ }
            }
            _mountMediaHandlers = [];
            _mountErrorHandler = null;
            if (listEl && _mountScrollHandler) {
                try { listEl.removeEventListener('scroll', _mountScrollHandler); } catch (_) { /* 已移除 */ }
            }
            _mountScrollHandler = null;
            if (listEl) {
                // __mountObs 守卫必须摘掉：否则重建的 view 调 _bindMountWindow 会以为已绑过而
                // 静默跳过（风险 12：团队档退出后单 Agent 视图自动滚动/跟随全部失效）。
                try { delete listEl.__mountObs; } catch (_) { listEl.__mountObs = null; }
                try { delete listEl.__followRO; } catch (_) { listEl.__followRO = null; }
            }
        }
        // 消息级操作（编辑）回调，由 bootstrap 注入 controller 方法（晚绑定：view 先于 controller 创建）
        var _msgActionHandlers = null;

        function setMessageActionHandlers(handlers) {
            _msgActionHandlers = handlers || null;
        }

        function isDebug() {
            return !!getDebugMode();
        }

        // 工具入参的展示形态（确认卡片与工具卡片「查看详情」共用同一约定）：
        // executeExtendScript 的 args 是 {"code":"..."} 的 JSON 噪声、用户难看懂，
        // 转成纯代码块 + 中文标签；其它工具保持原 JSON 缩进展示（label 为空，无标题）。
        function formatToolArgsDisplay(toolName, args) {
            if (toolName === 'executeExtendScript') {
                // 展示的是 LLM 传过来的原值（String 化），不跟执行层对齐：非字符串 code 已被执行层
                // 直接拒绝（toolExecutionPipeline 的 EMPTY_CODE），此处照原值显示才便于用户看清 LLM 发了什么
                var _exCode = (args && args.code != null) ? String(args.code) : '';
                return { label: AEI18n.t('待执行代码：'), text: _exCode || AEI18n.t('(空)') };
            }
            var text;
            try { text = JSON.stringify(args || {}, null, 2); } catch (_) { text = String(args || ''); }
            return { label: '', text: text };
        }

        // args 是否值得展示：解析失败（safeParseArgs 返回 {}）与"确实没传参数"都落成 {}，
        // 渲染成空栏（executeExtendScript 更会显示「(空)」）会被读成"LLM 没传代码"，与事实相反
        // ——空对象一律不渲染入参栏，工具自身的报错已说明参数缺失。
        // 假值（'' / 0 / false）同样不渲染：落库层 `args: msg.args || null` 会把它们归一成 null，
        // 此处口径必须一致，否则同一消息当轮显示 `""`、重载后入参栏消失。
        function _hasDisplayableArgs(args) {
            if (!args) return false;
            if (typeof args !== 'object') return true;   // 非对象（数字/字符串等）也算有内容
            return Object.keys(args).length > 0;
        }

        // 「查看详情」里的一栏：小标题 + 等宽 pre（textContent 赋值防注入）
        function _buildDetailSection(label, text) {
            var sec = document.createElement('div');
            sec.className = 'ae-agent-detail-section';
            var lb = document.createElement('div');
            lb.className = 'ae-agent-detail-label';
            lb.textContent = label;
            var pre = document.createElement('pre');
            pre.textContent = text;
            sec.appendChild(lb);
            sec.appendChild(pre);
            return sec;
        }

        function buildToolHeader(m) {
            var isTool = m.role === 'tool';
            var isToolResult = m.role === 'tool-result';
            if (!isTool && !isToolResult) return '';
            if (isTool) {
                var toolName = m.toolName || m.name || '';
                // 审查未通过（agentScriptReview 的 LLM 安全审查拦截）与普通执行失败区分显示
                if (m.reviewRejected) {
                    return AEI18n.html('<span class="ae-agent-tool-header ae-agent-tool-review-rejected"><span class="ae-agent-tool-icon">🛡</span> 审查未通过: <strong>') + escapeHtml(toolName) + '</strong></span>';
                }
                var success = m.success !== false;
                var icon = success ? '✅' : '❌';
                // executeExtendScript 优先显示 action（LLM 填写的操作目的），更直观。
                // action 不单独持久化，历史回放（state.messages 由 cm 重建）时 action 字段缺席，
                // 从持久化的 args.action 回落取——否则重启后只剩「调用工具: executeExtendScript」。
                var action = m.action || ((m.args && typeof m.args.action === 'string') ? m.args.action : '');
                if (toolName === 'executeExtendScript' && action) {
                    return '<span class="ae-agent-tool-header"><span class="ae-agent-tool-icon">' + icon + '</span> ' + AEI18n.t('执行: ') + '<strong>' + escapeHtml(action) + '</strong></span>';
                }
                return '<span class="ae-agent-tool-header"><span class="ae-agent-tool-icon">' + icon + '</span> ' + AEI18n.t('调用工具: ') + '<strong>' + escapeHtml(toolName) + '</strong></span>';
            }
            return '<span class="ae-agent-tool-header">' + escapeHtml(m.text || '') + '</span>';
        }

        // 复制文本到剪贴板：沿用面板既有的 textarea + execCommand 手法（presetView / 外接日志
        // 复制同款），同步返回布尔值——成功/失败能如实区分。不依赖 navigator.clipboard：CEF 88 里
        // 它虽然存在（真机探针实测 navigator.clipboard 非空、isSecureContext 为真），但写入是异步
        // Promise、是否放行受权限与焦点状态影响，回执不如 execCommand 的布尔值直接。
        // 临时 textarea 走 finally 回收：select/execCommand 抛错时也不留一个 fixed 定位的空节点。
        function _copyToClipboard(text) {
            var ta = null;
            try {
                ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
                document.body.appendChild(ta);
                ta.select();
                return document.execCommand('copy') === true;
            } catch (_) {
                return false;
            } finally {
                if (ta && ta.parentNode) {
                    try { ta.parentNode.removeChild(ta); } catch (_) {}
                }
            }
        }

        // 消息可复制正文（原文，不是渲染后的 HTML）：
        // 用户消息优先 displayText——与内联编辑取同一份（含 chip token 的原始输入），
        // 没有时剥离 <context> 动态前缀；助手消息取 markdown 原文，复制后粘回去仍是同一份内容。
        // 口径取舍：带引用 chip 的消息复制的是
        // token 原文（如 `@1:2`），不是气泡里的标签文案（「引用 N 个图层」）——标签不含可定位的
        // 稳定键，粘回输入框也还原不出 chip；token 原文粘回输入框仍能重新解析成 chip。
        // 代价是粘到面板外的纯文本里会带零宽定界符与不换行空格（与内联编辑框所见一致）。
        function _msgCopyText(msg) {
            if (!msg) return '';
            if (msg.role === 'user') {
                return (typeof msg.displayText === 'string' && msg.displayText)
                    ? msg.displayText
                    : stripContextBlock(msg.text || '');
            }
            return msg.text == null ? '' : String(msg.text);
        }

        // ── 消息级 hover 操作：用户消息「编辑」/ 对话泡「复制」/ 助手消息时间戳 ──
        // 入口在 busy 时经 CSS（.ae-agent-list-busy）隐藏；编辑另有 controller 侧 busy/_stopping 守卫，
        // 复制只读剪贴板、不碰会话状态，守卫缺省不影响它。
        // stateIdx 为渲染时 state.messages 下标；编辑/截断后全量重渲染会按新下标重建。
        // 时间戳与按钮同一条，随 .ae-agent-msg-actions 一起收起/展开（默认 0 高度 0 不透明度，
        // 悬停消息 200ms 后展开，见 agent.css）。
        function _buildMsgActions(stateIdx, msg) {
            var wrap = document.createElement('div');
            wrap.className = 'ae-agent-msg-actions';
            // 有没有挂东西（不读 DOM：独立加载 view.js 的最小 DOM 桩未必实现 childNodes）
            var hasChild = false;
            if (msg.role === 'user' && _msgActionHandlers && typeof _msgActionHandlers.onEdit === 'function') {
                var editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'ae-agent-msg-action-btn';
                editBtn.title = AEI18n.t('编辑此消息并重新发送（其后的消息将被移除）');
                editBtn.textContent = '✎ ' + AEI18n.t('编辑');
                editBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var item = editBtn.closest('.ae-agent-message');
                    if (item) _startInlineEdit(item, stateIdx, msg);
                });
                wrap.appendChild(editBtn);
                hasChild = true;
            }
            // 复制：对话泡（用户/助手）正文非空才挂；tool 卡、系统卡、纯图/纯附件消息不挂
            if (msg.role === 'user' || msg.role === 'assistant') {
                var copyText = _msgCopyText(msg);
                if (String(copyText).trim()) {
                    var copyBtn = document.createElement('button');
                    copyBtn.type = 'button';
                    copyBtn.className = 'ae-agent-msg-action-btn ae-agent-msg-copy-btn';
                    copyBtn.title = AEI18n.t('复制此消息文本');
                    copyBtn.textContent = AEI18n.t('复制');
                    copyBtn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        var ok = _copyToClipboard(copyText);
                        var toast = global.AEToast;
                        if (ok) {
                            if (toast && typeof toast.success === 'function') toast.success(AEI18n.t('已复制'));
                        } else if (toast) {
                            if (typeof toast.error === 'function') toast.error(AEI18n.t('复制失败（剪贴板不可用）'));
                            else if (typeof toast.show === 'function') toast.show(AEI18n.t('复制失败（剪贴板不可用）'), 'error');
                        }
                    });
                    wrap.appendChild(copyBtn);
                    hasChild = true;
                }
            }
            // 时间戳恒在最右：先复制后时间（用户消息为「编辑 → 复制 → 时间」，
            // 助手消息为「复制 → 时间」）
            if ((msg.role === 'assistant' || msg.role === 'user') && msg.createdAt) {
                var msgTime = document.createElement('span');
                msgTime.className = 'ae-agent-msg-time';
                msgTime.textContent = _formatMsgTime(msg.createdAt);
                wrap.appendChild(msgTime);
                hasChild = true;
            }
            return hasChild ? wrap : null;
        }

        // 消息时间戳格式化：HH:MM（同日）/ MM-DD HH:MM（跨日）/ YYYY-MM-DD HH:MM（跨年）
        function _formatMsgTime(ts) {
            if (!ts) return '';
            var d = new Date(ts);
            var now = new Date();
            var hh = String(d.getHours()).padStart(2, '0');
            var mi = String(d.getMinutes()).padStart(2, '0');
            var sameYear = d.getFullYear() === now.getFullYear();
            var sameDay = d.getFullYear() === now.getFullYear() &&
                          d.getMonth() === now.getMonth() &&
                          d.getDate() === now.getDate();
            if (sameDay) return hh + ':' + mi;
            var mm = String(d.getMonth() + 1).padStart(2, '0');
            var dd = String(d.getDate()).padStart(2, '0');
            if (sameYear) return mm + '-' + dd + ' ' + hh + ':' + mi;
            return d.getFullYear() + '-' + mm + '-' + dd + ' ' + hh + ':' + mi;
        }

        // 气泡内联编辑：textarea 走 .value 不涉转义；ESC/取消还原 DOM 无数据改动；
        // 保存成功后由 controller 更新数据 + 截断 + 全量重渲染（本 DOM 随之移除）。
        // 全局唯一编辑态：同时只允许一个编辑框。多开时后开者保存
        // 触发截断 + 全量重渲染（listEl.innerHTML=''），会把先开框里未保存的文本静默
        // 清掉；故打开新编辑框前先静默关闭其它编辑态。静默关闭不触发 onEditCancel——
        // 编辑窗口并未结束（新编辑框仍是「活元素」，整表重建闸门继续有效），此刻通知
        // 引擎补做延迟重建反而会把刚建的编辑框一起清掉。
        var _activeEdit = null;   // { close: function(notify) }——当前唯一编辑态的关闭句柄

        function _closeActiveEdit(notify) {
            var prev = _activeEdit;
            _activeEdit = null;
            if (prev && typeof prev.close === 'function') {
                try { prev.close(notify); } catch (_) {}
            }
        }

        function _startInlineEdit(item, stateIdx, msg) {
            if (!_msgActionHandlers || typeof _msgActionHandlers.onEdit !== 'function') return;
            if (item.querySelector('.ae-agent-msg-edit-wrap')) return;
            var body = item.querySelector('.ae-agent-message-body');
            if (!body) return;
            // 打开新编辑框前关闭其它编辑态（含其它消息上的未保存编辑）
            _closeActiveEdit(false);
            var actionsEl = item.querySelector('.ae-agent-msg-actions');

            var wrap = document.createElement('div');
            wrap.className = 'ae-agent-msg-edit-wrap';
            var ta = document.createElement('textarea');
            ta.className = 'ae-agent-msg-edit-textarea';
            // 编辑框剥离 <context> 动态上下文前缀，用户只编辑实际输入内容；
            // 有 displayText（含 chip token 的原始输入）优先用它，编辑重发后仍能还原 chip 语义
            var editText = msg.role === 'user'
                ? (typeof msg.displayText === 'string' && msg.displayText ? msg.displayText : stripContextBlock(msg.text || ''))
                : (msg.text || '');
            ta.value = editText;
            ta.rows = Math.min(14, Math.max(3, String(editText).split('\n').length + 1));
            ta.spellcheck = false;

            var btns = document.createElement('div');
            btns.className = 'ae-agent-msg-edit-actions';
            var hint = document.createElement('span');
            hint.className = 'ae-agent-msg-edit-hint';
            hint.textContent = AEI18n.t('Ctrl+Enter 保存 · Esc 取消');
            var cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'ae-agent-msg-edit-btn cancel';
            cancelBtn.textContent = AEI18n.t('取消');
            var saveBtn = document.createElement('button');
            saveBtn.type = 'button';
            saveBtn.className = 'ae-agent-msg-edit-btn save';
            saveBtn.textContent = AEI18n.t('保存并重发');
            btns.appendChild(hint);
            btns.appendChild(cancelBtn);
            btns.appendChild(saveBtn);
            wrap.appendChild(ta);
            wrap.appendChild(btns);

            body.style.display = 'none';
            if (actionsEl) actionsEl.style.display = 'none';
            // 插到 body 之后、图片缩略图之前：附件 chip 保留可见，仅编辑文本
            if (body.nextSibling) {
                item.insertBefore(wrap, body.nextSibling);
            } else {
                item.appendChild(wrap);
            }
            ta.focus();
            try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {}

            // 编辑态关闭句柄：notify=true（用户取消）才通知引擎编辑窗口结束——
            // 编辑框属于「活元素」，整表重建（调试开关的延迟重建等）会连未保存文本一起
            // 清掉，故重建被闸门挡下，而编辑框消失本身没有事件通知，引擎侧等不到
            // 「窗口结束」的信号；这里补一次让被挡下的重建有机会执行
            //（见 chatViewHelpers.syncView）。切换编辑目标（静默关闭）不通知。
            var editHandle = {
                close: function (notify) {
                    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
                    body.style.display = '';
                    if (actionsEl) actionsEl.style.display = '';
                    if (_activeEdit === editHandle) _activeEdit = null;
                    if (notify && _msgActionHandlers && typeof _msgActionHandlers.onEditCancel === 'function') {
                        _msgActionHandlers.onEditCancel();
                    }
                }
            };
            _activeEdit = editHandle;

            var saving = false;
            function cancelEdit() { editHandle.close(true); }
            function restoreButtons() {
                saving = false;
                saveBtn.disabled = false;
                cancelBtn.disabled = false;
                saveBtn.textContent = AEI18n.t('保存并重发');
            }
            function saveEdit() {
                if (saving) return;
                saving = true;
                saveBtn.disabled = true;
                cancelBtn.disabled = true;
                saveBtn.textContent = AEI18n.t('发送中...');
                Promise.resolve(_msgActionHandlers.onEdit(stateIdx, ta.value))
                    .then(function (res) {
                        // 成功：controller 已截断并全量重渲染，本编辑器 DOM 已被移除；
                        // 清掉唯一编辑态引用（全量重渲染不经 editHandle.close）
                        if (res && res.ok) {
                            if (_activeEdit === editHandle) _activeEdit = null;
                            return;
                        }
                        restoreButtons();
                    })
                    .catch(function () {
                        restoreButtons();
                    });
            }
            saveBtn.addEventListener('click', function (e) { e.stopPropagation(); saveEdit(); });
            cancelBtn.addEventListener('click', function (e) { e.stopPropagation(); cancelEdit(); });
            ta.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelEdit();
                } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    saveEdit();
                }
            });
        }

        // 附图片缺失（被清理/路径失效）时，用"图片已被清理"占位替换破图，
        // 避免之前静默隐藏（display:none）造成"图片还在但看不到"的误导。
        function _attachMissingFallback(thumb) {
            thumb.addEventListener('error', function () {
                var ph = document.createElement('div');
                ph.className = 'ae-agent-attach-missing';
                ph.textContent = AEI18n.t('图片已被清理');
                ph.title = AEI18n.t('该图片缓存已被清理，无法再显示');
                if (thumb.parentNode) thumb.parentNode.replaceChild(ph, thumb);
            });
        }

        // 媒体路径解析：相对路径（agent\temp\...）先拼数据目录，再转 file:// URL（CEP 同协议可直读）
        function _resolveMediaSrc(src) {
            if (!src || src.indexOf('data:') === 0) return src;
            if (!/^[a-zA-Z]:[\\/]/.test(src)) {
                var _rd = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                    ? global.AEShared.getDataDir().dir : '';
                if (_rd) src = _rd.replace(/\\+$/, '') + '\\' + src.replace(/^[\\/]+/, '');
            }
            // 改经 shared/fileUrl.js 统一编码 ?#% 后拼 file:///——手搓拼接遇
            // 文件名含 #（fragment 截断）/?（query 截断）/%（解码错误）时媒体加载失败
            // toFileUrl 不可用时回退旧拼接
            if (global.AEShared && typeof global.AEShared.toFileUrl === 'function') {
                return global.AEShared.toFileUrl(src);
            }
            return 'file:///' + src.replace(/\\/g, '/');
        }

        // 文件/文件夹引用标签：轻量展示名称，悬浮显示完整路径
        function _buildFileRefs(files) {
            var refs = document.createElement('div');
            refs.className = 'ae-agent-attach-refs';
            for (var ri = 0; ri < files.length; ri++) {
                var rf = files[ri];
                var ref = document.createElement('span');
                ref.className = 'ae-agent-attach-ref' + (rf.isFolder ? ' is-folder' : '');
                ref.textContent = (rf.isFolder ? '\uD83D\uDCC1 ' : '\uD83D\uDCC4 ') + (rf.name || '');
                ref.title = rf.path || '';
                refs.appendChild(ref);
            }
            return refs;
        }

        // 附带图片缩略图（含缺失占位与点击放大）
        function _buildImageThumbs(images) {
            var imgs = document.createElement('div');
            imgs.className = 'ae-agent-attach-imgs';
            for (var ai = 0; ai < images.length; ai++) {
                var src = _resolveMediaSrc(images[ai]);
                var thumb = document.createElement('img');
                thumb.className = 'ae-agent-attach-thumb';
                thumb.src = src;
                thumb.style.cursor = 'pointer';
                _attachMissingFallback(thumb);
                (function(s) {
                    thumb.addEventListener('click', function(e) {
                        e.stopPropagation();
                        if (window._openImageLightbox) window._openImageLightbox(s);
                    });
                })(src);
                imgs.appendChild(thumb);
            }
            return imgs;
        }

        // 附带视频预览：交给 shared/videoPreview.js 统一处理——CEF 解不了的编码
        // （如 HEVC/H.265：能读元数据、时间轴照走、画面全黑且不触发 error）走 ffmpeg
        // 转码兜底；控制条为项目自绘，不再用原生 controls（CEF 88 老式白色控件在暗色
        // 面板里又大又突兀）。黑屏静默即因只挂 error 兜底，见该模块头注释。
        function _buildVideoThumbs(videos) {
            var vids = document.createElement('div');
            vids.className = 'ae-agent-attach-videos';
            for (var vi = 0; vi < videos.length; vi++) {
                var vOrig = videos[vi];
                // ComfyUI 结果按数据根相对路径落盘（会话持久化形态）——
                // videoPreview 只吃绝对路径（转码/元数据都按绝对路径读盘），此处先还原
                if (global.AEShared && typeof global.AEShared.fromDataRel === 'function') {
                    vOrig = global.AEShared.fromDataRel(vOrig);
                }
                if (global.AEShared && typeof global.AEShared.createVideoPreview === 'function') {
                    vids.appendChild(global.AEShared.createVideoPreview({ path: vOrig }).el);
                    continue;
                }
                // 降级路径：shared 模块不可用（独立加载 view.js 的测试/极端环境）时
                // 退化为无控制条的最小 video，src 仍经 _resolveMediaSrc 编码
                var vWrap = document.createElement('div');
                vWrap.className = 'ae-agent-attach-video';
                var vTag = document.createElement('video');
                vTag.className = 'ae-agent-vp-el';
                vTag.muted = true;
                vTag.playsInline = true;
                vTag.preload = 'metadata';
                vTag.src = _resolveMediaSrc(vOrig);
                vWrap.appendChild(vTag);
                vids.appendChild(vWrap);
            }
            return vids;
        }

        function resetRenderedCount() {
            _renderedCount = 0;
        }

        // 工具组摘要：折叠成一张卡时把「调了什么」直接写在 summary 上（不展开也能看到）。
        // 同名工具聚合为「name ×N」、按首次出现顺序；名单超 TOOL_GROUP_SUMMARY_MAX_CHARS 字符
        // 就截断并加省略号——侧栏宽度有限，长名单不截会把 summary 撑出可视区。
        // 工具名由注册表校验（字母/数字/下划线），无代理对；缺 toolName 的旧持久化记录回落「未知工具」。
        // 60 是 names 段（不含「🛠 工具调用记录 (N 次) · 」前缀）的上限，约 1 行；改这里即改判据。
        var TOOL_GROUP_SUMMARY_MAX_CHARS = 60;
        function buildToolGroupSummary(toolRun) {
            var order = [];
            var counts = Object.create(null);
            for (var i = 0; i < toolRun.length; i++) {
                var name = (toolRun[i] && typeof toolRun[i].toolName === 'string' && toolRun[i].toolName)
                    ? toolRun[i].toolName : AEI18n.t('未知工具');
                if (!counts[name]) { counts[name] = 0; order.push(name); }
                counts[name]++;
            }
            var parts = [];
            for (var j = 0; j < order.length; j++) {
                parts.push(counts[order[j]] > 1 ? order[j] + ' ×' + counts[order[j]] : order[j]);
            }
            var names = parts.join(', ');
            if (names.length > TOOL_GROUP_SUMMARY_MAX_CHARS) {
                names = names.slice(0, TOOL_GROUP_SUMMARY_MAX_CHARS - 1).replace(/[\s,]+$/, '') + '…';
            }
            return AEI18n.t('🛠 工具调用记录 ({n} 次) · ', { n: toolRun.length }) + names;
        }

        function renderMessages(messages, mode, onDone) {
            var listEl = _byId('listId');
            if (!listEl) { if (typeof onDone === 'function') onDone(); return; }
            _bindMountWindow(listEl);

            // 是否跟随底部由 _followBottom 状态决定（见「自动跟随底部」注释块）：
            // 不在每次渲染前重新测距——插入前的快照会把「渲染后才长高」的块误判成离底，
            // 正是「系统卡一出现自动滚动就失效」的根因。

            // 全量重置（清空会话、消息数异常减少，或新 view 实例首次渲染）。
            // 新 view 实例 _renderedCount 为 0，但 DOM 可能在 unmount 时未被清理，
            // 此处强制清空，避免重新 mount 后同一批历史消息被重复 append。
            if (messages.length === 0 || messages.length < _renderedCount || _renderedCount === 0) {
                listEl.innerHTML = '';
                _renderedCount = 0;
                _lastFinalizedReasoning = null;
                _revealFrameToken++;       // 使在途分帧恢复作废（kids 引用已失效）
                _revealFrameActive = false;
                // 挂载窗口状态一并重置：floor/静默期时间戳挂在 listEl 上跨会话存活，
                // 不重置时切换后首个 observer 帧若 kids > CAP（单帧渲染大量廉价工具消息），
                // 陈旧 floor > maxFloor 会让 _enforceMountWindow 直接 return、
                // _clampToWindow 把窗口外全部块藏掉 → 列表空白；触顶恢复还会对
                // 越界索引取 kids[idx] 抛 TypeError 且 _revealFrameActive 卡死。
                listEl.__mountFloor = 0;
                listEl.__topRevealUntil = 0;
                listEl.__downGuardUntil = 0;
                // 重置前的跟随状态测的是旧会话的滚动位置，对新内容无意义：
                // 上翻历史状态下切换会话应落在最新消息（底部）而非最旧消息（顶部）
                _followBottom = true;
                _lastScrollTop = 0;
            }

            if (_renderedCount >= messages.length) {
                // 无新真实消息：保留在途流式占位气泡（它尚未落入 state.messages），仅滚动。
                // 子 Agent 卡片仍需归位（本分支同样可能紧跟在一次整表重建之后）
                _reattachSubagentCards(listEl);
                _followNow(listEl);
                if (typeof onDone === 'function') onDone();
                return;
            }

            // 有新真实消息要渲染：流式占位气泡的内容已（或即将）由 state.messages 接替，
            // 先移除它，避免与即将渲染的真实 assistant 重复或错位。
            var staleStreams = listEl.querySelectorAll('.ae-agent-message-streaming');
            for (var ss = 0; ss < staleStreams.length; ss++) {
                if (staleStreams[ss].parentNode) staleStreams[ss].parentNode.removeChild(staleStreams[ss]);
            }
            // 同步清理在途的流式思考气泡（streaming）。
            // 注意：不清理 finalized 气泡——它由循环里的 existingFinalized 复用逻辑接管。
            // 若在此处清理 finalized，循环会新建折叠 details，但时序问题可能导致新建失败或位置错乱，
            // 表现为"落定后思考内容消失"。保留 finalized 让循环复用是最稳妥的方案。
            var staleReasoning = listEl.querySelectorAll('.ae-agent-reasoning-streaming');
            for (var sr = 0; sr < staleReasoning.length; sr++) {
                if (staleReasoning[sr].parentNode) staleReasoning[sr].parentNode.removeChild(staleReasoning[sr]);
            }

            var debug = isDebug();
            // 分批渲染：待渲染消息超过阈值时用 rAF 分帧，避免进入模块/切换会话时
            // 全量同步渲染长历史卡死主线程。增量分支（流式落定 1-2 条）不走分批。
            var PENDING = messages.length - _renderedCount;
            var _BATCH_THRESHOLD = 30;
            var i = _renderedCount;
            var myToken = ++_renderBatchToken;
            var useRaf = PENDING > _BATCH_THRESHOLD;
            var _frameStart = Date.now();
            while (i < messages.length) {
                var m = messages[i];

                // 隐藏消息（如压缩上下文摘要前缀）：进 contextManager 供 LLM 使用，但 UI 不渲染
                if (m._hidden) {
                    i++;
                    continue;
                }

                if (m.role === 'system-result') {
                    _renderSystemResult(listEl, m, debug);
                    i++;
                    if (useRaf && (Date.now() - _frameStart > 8)) break;
                    continue;
                }

                if (m.role === 'tool-result' || m.role === 'tool') {
                    var toolRun = [];
                    while (i < messages.length && (messages[i].role === 'tool-result' || messages[i].role === 'tool')) {
                        toolRun.push(messages[i]);
                        i++;
                    }

                    // 单个/多个工具一律折叠成统一的 details 块：
                    // summary = "🛠 工具调用记录 (N 次) · 工具名(×N), …"——不展开也能看出调了什么；
                    // 工具名+结果原文仍藏在 body 里，名单超长由 buildToolGroupSummary 截断。
                    // 与 reasoning 一致：details 永远 open=true，用 data-collapsed 控制收起态，
                    // 避免 details [open] 属性切换触发浏览器重排造成动画末尾卡顿。
                    // 所有工具条目包到 .ae-agent-tool-group-body 容器里，对该容器做 max-height/padding/opacity 过渡。
                    var group = document.createElement('details');
                    group.className = 'ae-agent-tool-group';
                    group.setAttribute('open', '');
                    group.setAttribute('data-collapsed', '1');
                    var summary = document.createElement('summary');
                    summary.className = 'ae-agent-tool-group-summary';
                    summary.textContent = buildToolGroupSummary(toolRun);
                    group.appendChild(summary);

                    var groupBody = document.createElement('div');
                    groupBody.className = 'ae-agent-tool-group-body';
                    // 初始禁用 transition，确保插入 DOM 时直接是收起态，不触发过渡闪烁。
                    // 原因：CSS 的 transition 在元素插入 DOM 时已激活，从"无样式"到 CSS 默认值
                    // (max-height:0/opacity:0) 的瞬间变化会触发 0.18s 过渡，视觉上"先展开再收起"闪一下。
                    // 禁用 transition + 强制 reflow 确保首帧直接落到收起态，同步恢复 transition，
                    // 后续展开/收起动画由 bindToolGroupToggle 内联控制 maxHeight/opacity 正常生效。
                    groupBody.style.transition = 'none';
                    for (var t = 0; t < toolRun.length; t++) {
                        var tr = toolRun[t];
                        var inner = document.createElement('div');
                        inner.className = 'ae-agent-message ' + (tr.role || '');
                        var body = document.createElement('div');
                        body.className = 'ae-agent-message-body';
                        body.innerHTML = buildToolHeader(tr);
                        inner.appendChild(body);

                        // DEBUG 详情区：入参（LLM 传给工具的 args）+ 返回（工具输出）分栏展示。
                        // args 缺席或为空（旧会话记录 / 参数解析失败 / 工具本就不需要参数）时只渲染返回栏。
                        if (debug && (tr.detail || _hasDisplayableArgs(tr.args))) {
                            var det = document.createElement('details');
                            det.className = 'ae-agent-detail';
                            var detSum = document.createElement('summary');
                            detSum.textContent = AEI18n.t('查看详情');
                            det.appendChild(detSum);
                            if (_hasDisplayableArgs(tr.args)) {
                                var _argSec = _buildDetailSection(AEI18n.t('入参'), formatToolArgsDisplay(tr.toolName, tr.args).text);
                                _linkifyLocalPaths(_argSec);
                                det.appendChild(_argSec);
                            }
                            if (tr.detail) {
                                var _retSec = _buildDetailSection(AEI18n.t('返回'), typeof tr.detail === 'string' ? tr.detail : JSON.stringify(tr.detail, null, 2));
                                _linkifyLocalPaths(_retSec);
                                det.appendChild(_retSec);
                            }
                            inner.appendChild(det);
                        }
                        groupBody.appendChild(inner);
                    }
                    group.appendChild(groupBody);
                    listEl.appendChild(group);
                    // 本组的尾部锚点：askUser 结果记录要跟在**整组渲染产物之后**（含图片块），
                    // 不能插在组与图片之间。
                    var _groupTailEl = group;
                    // 工具组外渲染附带图片（如 ComfyUI 生成结果），用户无需展开即可看到
                    var _groupImages = [];
                    for (var gi = 0; gi < toolRun.length; gi++) {
                        if (toolRun[gi].images && toolRun[gi].images.length > 0) {
                            for (var gii = 0; gii < toolRun[gi].images.length; gii++) {
                                _groupImages.push(toolRun[gi].images[gii]);
                            }
                        }
                    }
                    if (_groupImages.length > 0) {
                        var gImgs = document.createElement('div');
                        gImgs.className = 'ae-agent-message tool-images';
                        var gImgsBody = document.createElement('div');
                        gImgsBody.className = 'ae-agent-message-body';
                        var gImgsWrap = document.createElement('div');
                        gImgsWrap.className = 'ae-agent-attach-imgs';
                        for (var gAi = 0; gAi < _groupImages.length; gAi++) {
                            var gSrc = _groupImages[gAi];
                            if (gSrc && gSrc.indexOf('data:') !== 0) {
                                // 统一走 _resolveMediaSrc——相对路径（数据根相对
                                // 落盘形态）先拼数据目录，绝对路径原样，再经 toFileUrl 统一编码
                                // ?#%，防特殊文件名被 fragment/query 截断导致破图
                                gSrc = _resolveMediaSrc(gSrc);
                            }
                            var gThumb = document.createElement('img');
                            gThumb.className = 'ae-agent-attach-thumb';
                            gThumb.src = gSrc;
                            gThumb.style.cursor = 'pointer';
                            // 文件缺失（被清理/路径失效）时替换为"图片已被清理"占位
                            _attachMissingFallback(gThumb);
                            (function(s) {
                                gThumb.addEventListener('click', function(e) {
                                    e.stopPropagation();
                                    if (window._openImageLightbox) window._openImageLightbox(s);
                                });
                            })(gSrc);
                            gImgsWrap.appendChild(gThumb);
                        }
                        gImgsBody.appendChild(gImgsWrap);
                        gImgs.appendChild(gImgsBody);
                        listEl.appendChild(gImgs);
                        _groupTailEl = gImgs;
                    }
                    // askUser 的「已回答 / 未回答」结果记录：排在工具调用记录之后
                    //（提问面在输入区，消息流只留这一行；数据取自工具结果的 detail，整表重建/重载可还原）
                    _appendAskRecords(listEl, toolRun, _groupTailEl);
                    // 确保元素以收起态绘制后再恢复 transition 供后续动画使用（双 rAF 批量恢复，零强制布局）。
                    _deferTransitionRestore(groupBody);
                    bindToolGroupToggle(group);
                    continue;
                }

                if (m.role === 'tool-progress') {
                    var pItem = document.createElement('div');
                    pItem.className = 'ae-agent-message tool-progress';
                    var pBody = document.createElement('div');
                    pBody.className = 'ae-agent-message-body';
                    pBody.innerHTML = '<div class="ae-agent-tool-progress">' +
                        '<span class="ae-agent-tool-icon">⏳</span>' +
                        '<span>' + escapeHtml(m.text || AEI18n.t('正在调用工具...')) + '</span>' +
                        '</div>';
                    pItem.appendChild(pBody);
                    listEl.appendChild(pItem);
                    i++;
                    continue;
                }

                // 跳过无可见内容的空气泡：文本为空或仅空白字符（如 '\n'）且无附带图片的消息
                // 例外：有 reasoningContent 的 assistant 空气泡需先认领 finalized 思考块，
                // 否则流式渲染产生的 .ae-agent-reasoning-finalized 元素无人认领，
                // 后续消息会误认领（内容错位）或全量重建时丢失。
                var _isEmptyText = !m.text || !String(m.text).trim();
                if (_isEmptyText && (!m.images || m.images.length === 0)) {
                    if (m.role === 'assistant' && m.reasoningContent) {
                        // 认领流式产生的 finalized 思考块（复用 DOM，避免全量重渲染时丢失）
                        var _thinkBlock = null;
                        var orphanedFinalized = listEl.querySelector('.ae-agent-reasoning-finalized');
                        if (orphanedFinalized) {
                            orphanedFinalized.classList.remove('ae-agent-reasoning-finalized');
                            if (_lastFinalizedReasoning === orphanedFinalized) _lastFinalizedReasoning = null;
                            _thinkBlock = orphanedFinalized;
                        } else {
                            // 无 finalized 元素可认领（如会话恢复、全量重渲染后）：
                            // 新建折叠思考块，否则 reasoningContent 凭空丢失。
                            var _rGroup = document.createElement('details');
                            _rGroup.className = 'ae-agent-reasoning-group';
                            _rGroup.setAttribute('open', '');
                            _rGroup.setAttribute('data-collapsed', '1');
                            var _rSummary = document.createElement('summary');
                            _rSummary.className = 'ae-agent-reasoning-summary';
                            _rSummary.textContent = AEI18n.t('思考过程');
                            var _rBody = document.createElement('div');
                            _rBody.className = 'ae-agent-reasoning-body';
                            _rBody.textContent = m.reasoningContent;
                            _rBody.style.transition = 'none';
                            _rGroup.appendChild(_rSummary);
                            _rGroup.appendChild(_rBody);
                            listEl.appendChild(_rGroup);
                            _deferTransitionRestore(_rBody);
                            bindReasoningToggle(_rGroup);
                            _thinkBlock = _rGroup;
                        }
                        // thinking-only 的 LLM 回复与普通回复一致挂操作条（时间戳展示）：
                        // 本分支提前 continue 跳过了下方统一的 _buildMsgActions 挂载点，
                        // 不补挂则带 _llm 标记的纯思考回复没有时间戳。
                        // 认领旧块时防重复叠加：已有 actions 不再加。
                        if (m._llm && _thinkBlock && !_thinkBlock.querySelector('.ae-agent-msg-actions')) {
                            var _roActions = _buildMsgActions(i, m);
                            if (_roActions) _thinkBlock.appendChild(_roActions);
                        }
                    }
                    i++;
                    continue;
                }

                // 历史回放：若该 assistant 消息附带 reasoningContent，先插入折叠的思考块（默认折叠）
                // 字段名与 contextManager.normalizeMessage 一致（reasoningContent）
                // 复用优化：若前一轮流式已通过 finalizeReasoningStream 就地生成 finalized 气泡，
                // 直接复用（避免重复新建），并在复用后清除标记，使后续渲染走正常新建分支。
                if (m.role === 'assistant' && m.reasoningContent) {
                    var existingFinalized = listEl.querySelector('.ae-agent-reasoning-finalized');
                    if (existingFinalized) {
                        existingFinalized.classList.remove('ae-agent-reasoning-finalized');
                        if (_lastFinalizedReasoning === existingFinalized) _lastFinalizedReasoning = null;
                    } else {
                        var rGroup = document.createElement('details');
                        rGroup.className = 'ae-agent-reasoning-group';
                        // open 永远设为 true，用 data-collapsed 控制收起态
                        // 避免 details [open] 属性切换触发浏览器重排造成动画卡顿
                        rGroup.setAttribute('open', '');
                        rGroup.setAttribute('data-collapsed', '1');
                        var rSummary = document.createElement('summary');
                        rSummary.className = 'ae-agent-reasoning-summary';
                        rSummary.textContent = AEI18n.t('思考过程');
                        var rBody = document.createElement('div');
                        rBody.className = 'ae-agent-reasoning-body';
                        rBody.textContent = m.reasoningContent;
                        // 初始禁用 transition，确保插入 DOM 时直接是收起态，不触发过渡闪烁
                        rBody.style.transition = 'none';
                        rGroup.appendChild(rSummary);
                        rGroup.appendChild(rBody);
                        listEl.appendChild(rGroup);
                        // 双 rAF 批量恢复 transition（零强制布局），超长内容也不卡
                        _deferTransitionRestore(rBody);
                        bindReasoningToggle(rGroup);
                    }
                }

                var item = document.createElement('div');
                item.className = 'ae-agent-message ' + (m.role || '');
                // 压缩摘要消息：加 modifier class，CSS 用 ::before 渲染顶部细线 + "已压缩早期对话" 提示
                if (m._compactSummary) {
                    item.className += ' ae-agent-message-compact-summary';
                }
                // user 消息剥离 <context> 动态上下文前缀（模型/时间），UI 不展示；
                // 有 displayText（含 chip token 的原始输入）优先用它——聊天框显示 chip 标签而非转换后的行号引用
                var displayText = m.role === 'user'
                    ? (typeof m.displayText === 'string' && m.displayText ? m.displayText : stripContextBlock(m.text || ''))
                    : (m.text || '');
                // 纯附件用户消息（无正文、仅文件/图片/视频）：不渲染空 body，避免"空气泡"；
                // 让下方附件标签/缩略图直接作为气泡内容（正文为空时留空 body 无意义）。
                var _hasAttach = (m.fileRefs && m.fileRefs.length > 0)
                    || (m.images && m.images.length > 0)
                    || (m.videos && m.videos.length > 0);
                if (!(m.role === 'user' && !String(displayText || '').trim() && _hasAttach)) {
                    var body = document.createElement('div');
                    body.className = 'ae-agent-message-body';
                    // 走 markdown 渲染（marked + js-xss 消毒），失败自动回退为纯转义
                    var md = global.AEAgentApp && global.AEAgentApp.markdown;
                    if (md && typeof md.render === 'function') {
                        // 用户消息保留打字时的换行：markdown 默认 breaks:false 会把单个换行当
                        // 空白，多行输入的气泡显示成一行（换行「被忽略」）。assistant 输出仍走
                        // 默认口径，段落由空行分段，不把每个换行都变成 <br>。
                        var _mdOpts = (m.role === 'user') ? { breaks: true } : undefined;
                        body.innerHTML = _chipTokensToHtml(displayText, function (t) { return _renderChipTokensToTags(md.render(t, _mdOpts)); });
                    } else {
                        body.textContent = displayText;
                    }
                    // 正文里的本地路径可点击（打开所在目录并选中文件）
                    _linkifyLocalPaths(body);
                    item.appendChild(body);
                }
                // 附件标签/缩略图随后统一 append 到 item

                // 文件/文件夹引用标签
                if (m.fileRefs && m.fileRefs.length > 0) {
                    item.appendChild(_buildFileRefs(m.fileRefs));
                }

                // 附带图片缩略图
                if (m.images && m.images.length > 0) {
                    item.appendChild(_buildImageThumbs(m.images));
                }

                // 附带视频预览（含加载/播放/状态反馈）
                if (m.videos && m.videos.length > 0) {
                    item.appendChild(_buildVideoThumbs(m.videos));
                }

                if (debug && m.detail) {
                    var detail = document.createElement('details');
                    detail.className = 'ae-agent-detail';
                    var summary = document.createElement('summary');
                    summary.textContent = AEI18n.t('查看详情');
                    var pre = document.createElement('pre');
                    pre.textContent = typeof m.detail === 'string' ? m.detail : JSON.stringify(m.detail, null, 2);
                    detail.appendChild(summary);
                    detail.appendChild(pre);
                    item.appendChild(detail);
                }

                // hover 操作入口：用户消息「编辑」（本地消息不挂；
                // busy 时经 CSS 隐藏，controller 侧另有守卫）
                if ((m.role === 'user' || m.role === 'assistant') && !m._local) {
                    var msgActions = _buildMsgActions(i, m);
                    if (msgActions) item.appendChild(msgActions);
                }

                listEl.appendChild(item);
                i++;
                // 分批渲染：帧预算超限时让出主线程，下帧从 _renderedCount 继续
                if (useRaf && (Date.now() - _frameStart > 8)) break;
            }
            _renderedCount = i;
            // 本帧追加的历史消息可能接在分批期间插入的活尾部元素（流式气泡/
            // 本地消息）之后——每帧收尾按 DOM 顺序把活尾部移回列表末尾
            _reorderLiveTail(listEl);
            // 子 Agent 卡片归位（排在活尾部之后）：卡片恒在列表最尾部。整表重建会把它们摘掉，
            // 这里是唯一无条件兜底点（无论本帧渲染了几条消息、是不是恰好重建过列表）。
            _reattachSubagentCards(listEl);
            _followNow(listEl);
            // 分批未完成：rAF 调度下一批（token 保护：切换会话/新渲染请求使旧批次作废）。
            // 不缓存「近底」判定：跟随状态由 _followBottom 维护，新增高度不会把它打掉。
            if (useRaf && _renderedCount < messages.length) {
                _batchActive = true;
                requestAnimationFrame(function () {
                    if (myToken !== _renderBatchToken) return;
                    renderMessages(messages, mode, onDone);
                });
            } else {
                // 分批渲染完成（首帧即渲染完，或最后一帧补完剩余消息）：
                // 清分批进行态与活尾部登记，通知调用方
                _batchActive = false;
                _liveTailEls = [];
                if (typeof onDone === 'function') onDone();
            }
        }

        // system-result 三区卡片：标题 + 常显区（文本/文件/图片/视频）+ 细节区（默认收起）。
        // 细节区复用 reasoning 的折叠动画（body/summary 复用 reasoning 类名，
        // 具体样式由外层 .ae-agent-system-result-detail 覆盖，见 agent.css）。
        function _renderSystemResult(listEl, m, debug) {
            var card = document.createElement('div');
            card.className = 'ae-agent-system-result-card';

            if (m.title) {
                var title = document.createElement('div');
                title.className = 'ae-agent-system-result-title';
                title.textContent = m.title;
                card.appendChild(title);
            }

            // 常显区：始终可见
            var visible = document.createElement('div');
            visible.className = 'ae-agent-system-result-visible';
            var hasVisible = false;
            if (m.visibleText) {
                var vt = document.createElement('div');
                vt.className = 'ae-agent-system-result-text';
                var md = global.AEAgentApp && global.AEAgentApp.markdown;
                if (md && typeof md.render === 'function') {
                    vt.innerHTML = _chipTokensToHtml(m.visibleText, function (t) { return _renderChipTokensToTags(md.render(t)); });
                } else {
                    vt.textContent = m.visibleText;
                }
                _linkifyLocalPaths(vt);
                visible.appendChild(vt);
                hasVisible = true;
            }
            if (m.visibleFiles && m.visibleFiles.length) { visible.appendChild(_buildFileRefs(m.visibleFiles)); hasVisible = true; }
            // 压缩摘要卡的 visibleImages 是「会话图片清单」（给 LLM 恢复图片路径用），
            // 不是产物缩略图；不在 UI 展开（最多 40 张会撑乱消息流），清单仍照常进请求。
            if (m.visibleImages && m.visibleImages.length && !m._compactSummary) { visible.appendChild(_buildImageThumbs(m.visibleImages)); hasVisible = true; }
            if (m.visibleVideos && m.visibleVideos.length) { visible.appendChild(_buildVideoThumbs(m.visibleVideos)); hasVisible = true; }
            if (hasVisible) card.appendChild(visible);

            // 细节区：默认收起，可展开（收起态视频仍可直接播放）
            var hasDetail = m.detailText
                || (m.detailFiles && m.detailFiles.length)
                || (m.detailImages && m.detailImages.length)
                || (m.detailVideos && m.detailVideos.length);
            if (hasDetail) {
                var detail = document.createElement('details');
                detail.className = 'ae-agent-system-result-detail';
                detail.setAttribute('open', '');
                detail.setAttribute('data-collapsed', '1');
                var dSummary = document.createElement('summary');
                dSummary.className = 'ae-agent-reasoning-summary';
                dSummary.textContent = AEI18n.t('查看详情');
                detail.appendChild(dSummary);
                var dBody = document.createElement('div');
                dBody.className = 'ae-agent-reasoning-body';
                dBody.style.transition = 'none';
                if (m.detailText) {
                    var dt = document.createElement('div');
                    dt.className = 'ae-agent-system-result-detail-text';
                    var dmd = global.AEAgentApp && global.AEAgentApp.markdown;
                    if (dmd && typeof dmd.render === 'function') {
                        dt.innerHTML = _chipTokensToHtml(m.detailText, function (t) { return _renderChipTokensToTags(dmd.render(t)); });
                    } else {
                        dt.textContent = m.detailText;
                    }
                    _linkifyLocalPaths(dt);
                    dBody.appendChild(dt);
                }
                if (m.detailFiles && m.detailFiles.length) dBody.appendChild(_buildFileRefs(m.detailFiles));
                if (m.detailImages && m.detailImages.length) dBody.appendChild(_buildImageThumbs(m.detailImages));
                if (m.detailVideos && m.detailVideos.length) dBody.appendChild(_buildVideoThumbs(m.detailVideos));
                detail.appendChild(dBody);
                card.appendChild(detail);
                _deferTransitionRestore(dBody);
                bindReasoningToggle(detail);
            }

            listEl.appendChild(card);
        }

        // 正式回答流式渲染：token 先入缓冲数组，rAF 帧内批量追加到占位气泡。
        // 相比每 token 同步拼接（textContent 读写 O(n²)）+ 每 token 读取 scrollHeight（强制 reflow），
        // 批量后每帧最多一次文本写入 + 一次布局判定，长内容不卡主线程。
        var _tokenBuf = [];          // 待追加的 content token
        var _tokenFlushRaf = 0;      // content flush rAF 句柄
        function flushContentTokens() {
            _tokenFlushRaf = 0;
            if (!_tokenBuf.length) return;
            var listEl = _byId('listId');
            if (!listEl) { _tokenBuf = []; return; }
            var streamEl = listEl.querySelector('.ae-agent-message-streaming');
            if (!streamEl) { _tokenBuf = []; return; }  // 占位气泡已被 renderMessages 清理：内容由 state.messages 接管
            var body = streamEl.querySelector('.ae-agent-message-body');
            var text = _tokenBuf.join('');
            _tokenBuf = [];
            // 追加后统一回底（跟随状态下）：判定由 _followBottom 维护，不再在追加前/后
            // 各测一次——追加前测距会把「追加后长高」当成用户离底，追加后测距会把
            // 贴底用户判成离底。
            if (body && text) body.appendChild(document.createTextNode(text));
            _followNow(listEl);
        }
        function appendToken(token, accumulated) {
            var listEl = _byId('listId');
            if (!listEl) return;
            // 进入正式回答流式前，先把在途的思考气泡定形为折叠 details（默认折叠）。
            finalizeReasoningStream(listEl);
            var streamEl = listEl.querySelector('.ae-agent-message-streaming');
            if (!streamEl) {
                // 流式占位气泡带 .ae-agent-message-streaming 标记，且【不】计入 _renderedCount——
                // 它代表尚未落入 state.messages 的在途 assistant。
                // 旧的实现把流式气泡计入 _renderedCount，导致它比 state.messages.length 虚高 1，
                // 一旦流式途中触发 syncView→renderMessages，命中“messages.length < _renderedCount”
                // 就 innerHTML='' 把正在流式的气泡连同已累积文字一起清掉 → 回复残缺/丢失。
                // 不复用末条真实 assistant 气泡——会把新一轮流式内容拼到上一条已定型的消息上。
                var lastMsg = document.createElement('div');
                lastMsg.className = 'ae-agent-message assistant ae-agent-message-streaming';
                var body = document.createElement('div');
                body.className = 'ae-agent-message-body';
                lastMsg.appendChild(body);
                // 子 Agent 卡片恒在列表尾部 ⇒ 流式气泡插到第一张卡片之前（没有卡片时就是 append，
                // 单 Agent 路径逐字不变）
                var cardAnchor = _subagentAnchor(listEl);
                if (cardAnchor) listEl.insertBefore(lastMsg, cardAnchor);
                else listEl.appendChild(lastMsg);
                // 分批渲染进行中登记为活尾部，防被后续批次帧的历史消息埋进中间
                if (_batchActive) _registerLiveTail(lastMsg);
                _followNow(listEl);
            }
            // token 入缓冲，rAF 帧内批量追加（每帧一次文本写入 + 滚动更新）
            _tokenBuf.push(token);
            if (!_tokenFlushRaf) {
                _tokenFlushRaf = requestAnimationFrame(flushContentTokens);
            }
        }

        // 思考内容流式渲染：token 先入缓冲数组，rAF 帧内批量追加到 streaming 气泡。
        // 性能：超长思考内容（上万字）若每 token 同步 textContent 拼接（O(n²)）+ 读取 scrollHeight
        // （每次强制 reflow 卡主线程），批量后每帧最多一次文本写入 + 一次布局判定。
        // finalize/清理时强制 flush（见 finalizeReasoningStream），保证折叠块内容完整。
        var _reasoningBuf = [];        // 待追加的 reasoning token
        var _reasoningFlushRaf = 0;    // reasoning flush rAF 句柄
        function flushReasoningTokens() {
            _reasoningFlushRaf = 0;
            if (!_reasoningBuf.length) return;
            var listEl = _byId('listId');
            if (!listEl) { _reasoningBuf = []; return; }
            var streamEl = listEl.querySelector('.ae-agent-reasoning-streaming')
                || listEl.querySelector('.ae-agent-reasoning-finalized');
            if (!streamEl) { _reasoningBuf = []; return; }  // 气泡已被清理：内容由 state.messages 的 reasoningContent 接管
            var body = streamEl.querySelector('.ae-agent-reasoning-body');
            var text = _reasoningBuf.join('');
            _reasoningBuf = [];
            // 每帧只追加本次 chunk 为独立文本节点，避免 `textContent = textContent + text`
            // 每帧重读/重序列化整个已累积思考内容（O(n²)），超长思考会卡死主线程。
            // 外层列表走统一的跟随状态；内层思考框是独立滚动容器，仍需自己的贴底判定
            // （它只受本帧追加影响，不存在异步长高的来源）。
            var bodyNearBottom = body && (body.scrollHeight - body.scrollTop - body.clientHeight) < 30;
            if (body && text) body.appendChild(document.createTextNode(text));
            _followNow(listEl);
            if (bodyNearBottom && body) body.scrollTop = body.scrollHeight;
        }
        function appendReasoningToken(token, accumulated) {
            var listEl = _byId('listId');
            if (!listEl) return;
            var streamEl = listEl.querySelector('.ae-agent-reasoning-streaming');
            if (!streamEl) {
                // 同一次回答里正式回复先落地、剩余思考随后到达（思考流与内容流在收尾处重叠）：
                // 上一段已定形但尚未被 renderMessages 认领的思考块仍属这条回答，重新打开它继续追加，
                // 否则会新建第二个「思考过程」块（认领只取第一块，残余块永久留在列表里）。
                // 判据取 accumulated：它是**单次请求**的累计思考（每次请求从头累计），
                // 只有累计比本次 token 长才说明仍是同一条回答；新回答的首个 token 两者相等。
                var reopen = _lastFinalizedReasoning;
                if (reopen && typeof accumulated === 'string' && accumulated.length > String(token).length
                    && reopen.parentNode === listEl
                    && reopen.classList.contains('ae-agent-reasoning-finalized')) {
                    reopen.classList.remove('ae-agent-reasoning-finalized');
                    reopen.classList.add('ae-agent-reasoning-streaming');
                    // 恢复流式展开态：定形时写过 data-collapsed 与 body 内联 max-height/opacity，
                    // 只换 class 会把「思考中」藏在收起态里（内联样式压过 .streaming 的 CSS）。
                    reopen.removeAttribute('data-collapsed');
                    var reopenedBody = reopen.querySelector('.ae-agent-reasoning-body');
                    if (reopenedBody) {
                        reopenedBody.style.maxHeight = '';
                        reopenedBody.style.opacity = '';
                        reopenedBody.style.overflowY = '';
                    }
                    var reopenedSummary = reopen.querySelector('.ae-agent-reasoning-summary');
                    if (reopenedSummary) reopenedSummary.textContent = AEI18n.t('思考中...');
                    streamEl = reopen;
                }
            }
            if (!streamEl) {
                // 首 token 同步创建气泡（保证 DOM 顺序在 content 气泡之前），内容走 rAF 批量追加。
                // 流式期间也绑定 toggle：防止用户点击 summary 触发浏览器默认切换 open 属性，
                // 导致 details body 被原生 display:none 隐藏，思考内容永久丢失。
                var wrap = document.createElement('details');
                wrap.className = 'ae-agent-reasoning-group ae-agent-reasoning-streaming';
                wrap.setAttribute('open', ''); // 永远保持 open，用 data-collapsed 控制收起态
                wrap.setAttribute('data-toggle-bound', '1'); // 标记已绑定，避免 finalizeReasoningStream 重复绑定
                var summary = document.createElement('summary');
                summary.className = 'ae-agent-reasoning-summary';
                summary.textContent = AEI18n.t('思考中...');
                var body = document.createElement('div');
                body.className = 'ae-agent-reasoning-body';
                wrap.appendChild(summary);
                wrap.appendChild(body);
                // 同 appendToken：插到第一张子 Agent 卡片之前，卡片恒在列表尾部
                var cardAnchorR = _subagentAnchor(listEl);
                if (cardAnchorR) listEl.insertBefore(wrap, cardAnchorR);
                else listEl.appendChild(wrap);
                // 分批渲染进行中登记为活尾部（元素身份跨 streaming→finalized
                // 类名转换保持，finalize 后不再被 611 段清理，最易被历史埋没）
                if (_batchActive) _registerLiveTail(wrap);
                _followNow(listEl);
                bindReasoningToggle(wrap);
            }
            // token 入缓冲，rAF 帧内批量追加（每帧一次文本写入 + 内外滚动更新）
            _reasoningBuf.push(token);
            if (!_reasoningFlushRaf) {
                _reasoningFlushRaf = requestAnimationFrame(flushReasoningTokens);
            }
        }

        // 流式思考气泡在正式回答开始后转为折叠 details 并保留——
        // 打上 .ae-agent-reasoning-finalized 标记，renderMessages 检测到标记就复用此 DOM，
        // 不再新建 details，避免重复。syncView→renderMessages 在 state.messages 落定前可能多次触发，
        // 此标记保证思考内容始终可见，不会"凭空消失"。
        // 转折叠时走收起动画：先锁定当前高度，再过渡到 0，最后移除 open——避免瞬间闪现。
        function finalizeReasoningStream(listEl, collapse) {
            // 先把未 flush 的思考 token 落盘：finalize 后折叠块内容不再更新，
            // 若 buffer 残留会导致折叠块内容残缺（renderMessages 认领时不会覆盖已有文本）。
            if (_reasoningFlushRaf) {
                cancelAnimationFrame(_reasoningFlushRaf);
                _reasoningFlushRaf = 0;
            }
            flushReasoningTokens();
            var el = listEl.querySelector('.ae-agent-reasoning-streaming');
            if (!el) return;
            el.classList.remove('ae-agent-reasoning-streaming');
            el.classList.add('ae-agent-reasoning-finalized');
            // 记下「已定形、待认领」的块：后续思考 token 在同一次回答内到达时续写到它（见 appendReasoningToken）。
            _lastFinalizedReasoning = el;
            // 防御：确保 open 属性存在（streaming 期间若被浏览器移除）
            el.setAttribute('open', '');
            // 避免重复绑定（appendReasoningToken 创建时已绑定）
            if (el.getAttribute('data-toggle-bound') !== '1') {
                bindReasoningToggle(el);
                el.setAttribute('data-toggle-bound', '1');
            }
            var summary = el.querySelector('.ae-agent-reasoning-summary');
            if (summary) summary.textContent = AEI18n.t('思考过程');
            var body = el.querySelector('.ae-agent-reasoning-body');
            if (!body) return;
            // 合并流式期间逐帧 appendChild 产生的碎文本节点（每帧一个，长思考可达数千个）。
            // 碎节点会显著拖慢后续所有 reflow（拖拽调整聊天框/窗口、滚动），normalize
            // 把相邻文本节点合并回单个，内容不变，一次性 O(n)。
            body.normalize();
            // 「只思考不回复」：LLM 正常结束但未输出 content（超长上下文下常见）。
            // 此时不折叠思考内容，仅把「思考中...」定形为展开的「思考过程」并保持内容可见。
            // 调用方在 collapse=false（默认 undefined→true 保持原折叠行为）。
            if (collapse === false) {
                el.removeAttribute('data-collapsed');
                body.style.maxHeight = '';
                body.style.opacity = '';
                body.style.overflowY = '';
                _scheduleFollow();  // 展开态定形后高度可能变化，跟随中重新贴底
                return;
            }
            // 超长内容跳过收起动画（getBoundingClientRect/offsetHeight 对超长 DOM 强制 reflow 会卡死），
            // 直接设为折叠态。短内容保留动画。
            var _reasoningLen = (body.textContent || '').length;
            if (_reasoningLen > 4000) {
                body.style.overflowY = 'hidden';
                el.setAttribute('data-collapsed', '1');
                body.style.maxHeight = '0';
                body.style.opacity = '0';
            } else {
                // streaming 期间 body 受 max-height:280px 限制，用 getBoundingClientRect 获取实际可见高度，
                // 避免 scrollHeight 返回内容完整高度（可能远大于 280）导致锁定时 body 突然撑开。
                body.style.overflowY = 'hidden';
                var currentHeight = body.getBoundingClientRect().height;
                if (currentHeight < 1) currentHeight = body.offsetHeight;
                body.style.maxHeight = Math.max(currentHeight, 1) + 'px';
                void body.offsetHeight; // 强制 reflow 让起始高度生效
                // 在 rAF 内与 maxHeight:0 同一帧设 data-collapsed='1'（与手动收起一致），
                // 让 CSS padding 与 max-height 同步过渡，避免 padding 滞后造成两段感。
                requestAnimationFrame(function () {
                    // 排到帧内时该块可能已重新回到流式（后续思考续写）：此时不能再收起，
                    // 否则正在续写的正文会被压成折叠态。只跳过 streaming 态——被消息认领
                    // （finalized 类已移除）的块照常收起，否则会停在半展开的截断态。
                    if (el.classList.contains('ae-agent-reasoning-streaming')) return;
                    el.setAttribute('data-collapsed', '1');
                    body.style.maxHeight = '0';
                    body.style.opacity = '0';
                });
            }
            _scheduleFollow();  // 定形折叠会让内容变矮，跟随中保持贴底
        }

        // 组内是否还有展开的「查看详情」：决定组体的 max-height 能否回到 400px 上限。
        // 组展开路径与详情 toggle 路径写的是同一份内联 max-height 且互不知情——不查这个状态
        // 就会出现「组收起再展开」「同组另一条详情收起」把仍在展开的详情压回 400px
        //（内容被裁，得靠组体内滚或再点两次详情才恢复）。
        function _hasOpenToolDetail(detailsEl) {
            var list = detailsEl.querySelectorAll('.ae-agent-detail');
            for (var i = 0; i < list.length; i++) {
                if (list[i].open) return true;
            }
            return false;
        }

        // 给 tool-group details 绑定展开/收起动画。
        // 复用 reasoning 的成熟方案：details 永远 open=true，用 data-collapsed 控制收起态，
        // padding 与 max-height 同步从 0 过渡避免卡顿，scrollHeight 补偿 padding 避免内容裁切。
        // 唯一差异：body 容器内是多个 .ae-agent-message 子元素（非纯文本），上限提高到 400。
        function bindToolGroupToggle(detailsEl) {
            var body = detailsEl.querySelector('.ae-agent-tool-group-body');
            var summary = detailsEl.querySelector('.ae-agent-tool-group-summary');
            if (!body || !summary) return;
            var token = 0;
            var animating = false;

            summary.addEventListener('click', function (e) {
                e.preventDefault();
                if (animating) return;
                var myToken = ++token;
                animating = true;

                var isCollapsed = detailsEl.getAttribute('data-collapsed') === '1';

                if (isCollapsed) {
                    // ── 展开 ──
                    detailsEl.removeAttribute('data-collapsed');
                    body.style.opacity = '1';
                    body.style.overflowY = 'hidden';
                    body.style.maxHeight = '0px';
                    void body.offsetHeight;
                    var targetHeight = body.scrollHeight;
                    if (targetHeight < 1) targetHeight = body.offsetHeight;
                    // 补偿 padding 上下 6px×2 = 12px（与 reasoning 同理）：
                    // 此刻 CSS padding 刚从 0 开始向 6px 过渡，scrollHeight 未包含 padding。
                    targetHeight += 12;
                    // 组内有展开的详情时不设上限：它已被 toggle 路径放开过（见下），
                    // 这里再按 400 压回会把刚打开的详情裁掉
                    var finalHeight = _hasOpenToolDetail(detailsEl) ? targetHeight : Math.min(targetHeight, 400);
                    body.style.maxHeight = Math.max(finalHeight, 1) + 'px';
                    setTimeout(function () {
                        if (myToken !== token) { animating = false; return; }
                        // 无条件设 overflowY:auto：
                        // tool-group 内有嵌套的"查看详情" details，展开后内容可能超过 max-height，
                        // 必须允许滚动才能看到完整详情。reasoning 是纯文本，内容不超高时无滚动条，无副作用。
                        body.style.overflowY = 'auto';
                        animating = false;
                    }, 180);
                } else {
                    // ── 收起 ──
                    // 与 reasoning 一致：在 rAF 内与 maxHeight:0 同一帧设 data-collapsed='1'，
                    // 让 CSS padding (6px→0) 与 JS max-height (currentHeight→0) 完全同步过渡。
                    body.style.overflowY = 'hidden';
                    var currentHeight = body.getBoundingClientRect().height;
                    if (currentHeight < 1) currentHeight = body.offsetHeight;
                    body.style.maxHeight = Math.max(currentHeight, 1) + 'px';
                    void body.offsetHeight;
                    requestAnimationFrame(function () {
                        if (myToken !== token) { animating = false; return; }
                        detailsEl.setAttribute('data-collapsed', '1');
                        body.style.maxHeight = '0';
                        body.style.opacity = '0';
                        setTimeout(function () {
                            if (myToken !== token) { animating = false; return; }
                            animating = false;
                        }, 180);
                    });
                }
            });

            // 给嵌套的"查看详情" details 绑定 toggle 监听：
            // 展开时把 group-body 的 max-height 提高到足够容纳详情内容（避免被裁切需滚动），
            // 收起时恢复到默认上限 400px——仅当组内已无展开的详情（否则会把同组仍展开的那条一起压裁）。
            // 仅 group-body 处于展开态时才生效。
            var nestedDetails = detailsEl.querySelectorAll('.ae-agent-detail');
            for (var nd = 0; nd < nestedDetails.length; nd++) {
                (function (det) {
                    det.addEventListener('toggle', function () {
                        // group-body 处于收起态时不干预（max-height:0，嵌套 details 也看不见）
                        if (detailsEl.getAttribute('data-collapsed') === '1') return;
                        if (det.open) {
                            // 展开：根据当前内容实际高度动态调整 max-height
                            var newHeight = body.scrollHeight;
                            if (newHeight < 1) newHeight = body.offsetHeight;
                            // 补偿 padding 12px，设为实际需要的高度（不设上限，方便查看完整详情）
                            body.style.maxHeight = Math.max(newHeight + 12, 1) + 'px';
                        } else {
                            // 收起：组内还有其它展开的详情时保持放开，否则恢复默认上限 400px
                            var restored = _hasOpenToolDetail(detailsEl)
                                ? body.scrollHeight + 12
                                : Math.min(body.scrollHeight + 12, 400);
                            body.style.maxHeight = Math.max(restored, 1) + 'px';
                        }
                    });
                })(nestedDetails[nd]);
            }
        }

        // 给 reasoning details 绑定展开/收起动画。
        // 关键：details 的 toggle 事件不可 cancelable，e.preventDefault() 无效，
        // 浏览器仍会切换 [open]，导致 CSS :not([open]) 瞬间把 body 压到 0，无法制造收起过渡。
        // 解决方案：在 summary 的 click 事件里 preventDefault 阻止 details 默认切换，
        // 用 JS 完全控制 open 属性和 max-height，保证动画期间 [open] 状态稳定。
        function bindReasoningToggle(detailsEl) {
            var body = detailsEl.querySelector('.ae-agent-reasoning-body');
            var summary = detailsEl.querySelector('.ae-agent-reasoning-summary');
            if (!body || !summary) return;
            var token = 0;
            var animating = false;

            summary.addEventListener('click', function (e) {
                e.preventDefault();
                if (animating) return;
                var myToken = ++token;
                animating = true;

                // 用自定义状态判断展开/收起，不依赖 detailsEl.open
                // detailsEl 保持 open=true 永远不移除，避免浏览器对 details [open] 切换的特殊处理造成卡顿
                var isCollapsed = detailsEl.getAttribute('data-collapsed') === '1';

                if (isCollapsed) {
                    // ── 展开 ──
                    detailsEl.removeAttribute('data-collapsed');
                    body.style.opacity = '1';
                    body.style.overflowY = 'hidden';
                    body.style.maxHeight = '0px';
                    void body.offsetHeight;
                    var targetHeight = body.scrollHeight;
                    if (targetHeight < 1) targetHeight = body.offsetHeight;
                    // 补偿 padding 上下 6px×2 = 12px：
                    // 此刻 CSS padding 刚从 0 开始向 6px 过渡，scrollHeight 未包含 padding，
                    // 需补偿展开态 padding 高度，否则 maxHeight 偏小导致内容被裁。
                    // 不临时改 padding/transition，保持 padding 与 max-height 同步从 0 过渡，避免卡顿。
                    targetHeight += 12;
                    var finalHeight = Math.min(targetHeight, 400);
                    body.style.maxHeight = Math.max(finalHeight, 1) + 'px';
                    setTimeout(function () {
                        if (myToken !== token) { animating = false; return; }
                        // 无条件设 overflowY:auto：
                        // tool-group 内有嵌套的"查看详情" details，展开后内容可能超过 max-height，
                        // 必须允许滚动才能看到完整详情。reasoning 是纯文本，内容不超高时无滚动条，无副作用。
                        body.style.overflowY = 'auto';
                        animating = false;
                    }, 180);
                } else {
                    // ── 收起 ──
                    // 关键：在 rAF 内与 maxHeight:0 同一帧设 data-collapsed='1'，
                    // 让 CSS padding (6px→0) 与 JS max-height (currentHeight→0) 完全同步过渡。
                    // 若延迟到 setTimeout(180) 后才设，padding 会滞后 max-height 180ms 开始过渡，
                    // 导致收起末尾 body 仍占 12px (padding 6px 上下)，形成"两段感"和"高度大 35%"的视觉。
                    body.style.overflowY = 'hidden';
                    var currentHeight = body.getBoundingClientRect().height;
                    if (currentHeight < 1) currentHeight = body.offsetHeight;
                    body.style.maxHeight = Math.max(currentHeight, 1) + 'px';
                    void body.offsetHeight;
                    requestAnimationFrame(function () {
                        if (myToken !== token) { animating = false; return; }
                        detailsEl.setAttribute('data-collapsed', '1');
                        body.style.maxHeight = '0';
                        body.style.opacity = '0';
                        setTimeout(function () {
                            if (myToken !== token) { animating = false; return; }
                            animating = false;
                        }, 180);
                    });
                }
            });
        }

        function appendToolProgress(toolName, message, action) {
            var listEl = _byId('listId');
            if (!listEl) return;
            var item = document.createElement('div');
            item.className = 'ae-agent-message tool-progress';
            var body = document.createElement('div');
            body.className = 'ae-agent-message-body';
            // message 可选：用于审查等前置阶段的进度提示（默认"正在调用工具"）。
            var prefix = (typeof message === 'string' && message) ? message : AEI18n.t('正在调用工具');
            // executeExtendScript 优先显示 action（LLM 填写的操作目的）
            var label = (toolName === 'executeExtendScript' && action) ? action : toolName;
            body.innerHTML = '<div class="ae-agent-tool-progress">' +
                '<span class="ae-agent-tool-icon">⏳</span>' +
                '<span>' + escapeHtml(prefix) + ': <strong>' + escapeHtml(label) + '</strong>...</span>' +
                '</div>';
            item.appendChild(body);
            listEl.appendChild(item);
            _followNow(listEl);
            return item;
        }

        function replaceToolProgressWithResult(progressEl, toolName, resultText, action) {
            if (!progressEl) return;
            progressEl.className = 'ae-agent-message tool-result';
            var body = progressEl.querySelector('.ae-agent-message-body');
            if (body) {
                var detailHtml = '';
                if (isDebug()) {
                    detailHtml = '<pre class="ae-agent-tool-output">' + escapeHtml(resultText || '') + '</pre>';
                }
                // executeExtendScript 优先显示 action（LLM 填写的操作目的）
                var label = (toolName === 'executeExtendScript' && action) ? action : toolName;
                var title = (toolName === 'executeExtendScript' && action) ? AEI18n.t('执行') : AEI18n.t('调用工具');
                body.innerHTML = '<div class="ae-agent-tool-result">' +
                    '<span class="ae-agent-tool-header"><span class="ae-agent-tool-icon">✅</span> ' + title + ': <strong>' + escapeHtml(label) + '</strong></span>' +
                    detailHtml +
                    '</div>';
                // debug 详情里的工具输出常含路径：一并可点击
                _linkifyLocalPaths(body);
            }
            _scheduleFollow();  // 进度行 → 结果行的高度变化（可多行/含详情）不该把跟随判定打掉
        }

        function removeToolProgress(progressEl) {
            if (progressEl && progressEl.parentNode) {
                progressEl.parentNode.removeChild(progressEl);
            }
            _scheduleFollow();
        }

        // 工具执行确认——确认卡片即"工具执行条目"的待确认形态（合并显示，不另起条目）。
        // 返回 { el, decision }：el 为条目 DOM（批准/退回/拒绝后由 markToolProgressRunning /
        // markToolRevisionRequested / markToolRejected 原地变形），decision 为
        // Promise<{approved, skipSession, revise?}>。
        // 完整展示工具参数（textContent 赋值防注入）。
        // allowSkip=false：该工具（writeFile 等）不允许"本次会话不再询问"，不渲染 skip 选项。
        function appendToolConfirm(toolName, args, reviewInfo, allowSkip) {
            var listEl = _byId('listId');
            if (!listEl) return { el: null, decision: Promise.resolve({ approved: false, skipSession: false }) };
            var canSkip = allowSkip !== false;
            // 退回修改按钮仅在审查有警告时渲染：没有具体问题可带回时该按钮无内容可发。
            // （审查未通过走的是 errors 分支，不进确认卡片——问题已随工具结果回喂 LLM。）
            var canRevise = !!(reviewInfo && reviewInfo.ok
                && reviewInfo.warnings && reviewInfo.warnings.length > 0);
            var item = document.createElement('div');
            item.className = 'ae-agent-message tool-confirm';
            var body = document.createElement('div');
            body.className = 'ae-agent-message-body';
            body.innerHTML = '<div class="ae-agent-tool-confirm">' +
                AEI18n.html('<div class="ae-agent-tool-confirm-head"><span class="ae-agent-tool-confirm-icon">⚠</span><span class="ae-agent-tool-confirm-title">工具执行确认：</span><strong></strong></div>') +
                '<pre class="ae-agent-tool-confirm-args"></pre>' +
                '<div class="ae-agent-tool-confirm-actions">' +
                AEI18n.html('<button type="button" class="ae-agent-tool-confirm-btn allow">允许执行</button>') +
                (canRevise
                    ? AEI18n.html('<button type="button" class="ae-agent-tool-confirm-btn revise" title="不创建该工具，把上面审查发现的问题交回 AI 修改后重试">按审查意见修改</button>')
                    : '') +
                AEI18n.html('<button type="button" class="ae-agent-tool-confirm-btn deny">拒绝</button>') +
                (canSkip
                    ? AEI18n.html('<label class="ae-agent-tool-confirm-skip toggle-wrap" title="勾选后本会话内此工具不再二次确认"><span>本次会话不再询问</span><input type="checkbox" class="switch-input ae-agent-tool-confirm-skip-cb"><span class="switch-slider" aria-hidden="true"></span></label>')
                    : '') +
                '</div>' +
                '</div>';
            // 标题与参数的用户友好转换：executeExtendScript 名称技术化、args 为 {"code":"..."} JSON 噪声，
            // 用户难看懂；这里转成中文标题 + 纯代码块展示。其它工具保持原 JSON 展示。
            // 参数文本走 formatToolArgsDisplay（与工具卡片「查看详情」的入参栏同一约定）
            var displayTitle = toolName;
            if (toolName === 'executeExtendScript') {
                var _action = (args && typeof args.action === 'string') ? args.action : '';
                displayTitle = _action ? AEI18n.t('执行: {action}', { action: _action }) : AEI18n.t('执行 ExtendScript 代码');
            }
            var _argsDisp = formatToolArgsDisplay(toolName, args);
            var argsText = _argsDisp.text;
            var argsLabel = _argsDisp.label;
            var titleEl = body.querySelector('.ae-agent-tool-confirm-head strong');
            titleEl.textContent = displayTitle;
            if (toolName !== displayTitle) titleEl.title = toolName;  // 原始工具名作为 tooltip，便于高级用户/调试识别
            var argsPre = body.querySelector('.ae-agent-tool-confirm-args');
            if (argsLabel) {
                var labelEl = document.createElement('div');
                labelEl.className = 'ae-agent-tool-confirm-args-label';
                labelEl.textContent = argsLabel;
                argsPre.parentNode.insertBefore(labelEl, argsPre);
            }
            argsPre.textContent = argsText;

            // 审查信息展示
            if (reviewInfo && reviewInfo.ok) {
                var reviewEl = document.createElement('div');
                reviewEl.className = 'ae-agent-tool-confirm-review';
                var reviewHtml = AEI18n.html('<div class="ae-agent-tool-confirm-review-head">✓ LLM 审查通过</div>');
                if (reviewInfo.warnings && reviewInfo.warnings.length > 0) {
                    reviewHtml += '<div class="ae-agent-tool-confirm-review-warnings">';
                    for (var wi = 0; wi < reviewInfo.warnings.length; wi++) {
                        reviewHtml += '<div class="ae-agent-tool-confirm-review-warn">' + escapeHtml(reviewInfo.warnings[wi]) + '</div>';
                    }
                    reviewHtml += '</div>';
                }
                reviewEl.innerHTML = reviewHtml;
                // 插入锚点：若存在 argsLabel（executeExtendScript 场景），插到 label 前保持
                // "label 紧贴代码块"的视觉；否则插到 argsPre 前（其它工具原行为）。
                var reviewAnchor = argsPre.previousSibling && argsPre.previousSibling.className === 'ae-agent-tool-confirm-args-label'
                    ? argsPre.previousSibling
                    : argsPre;
                argsPre.parentNode.insertBefore(reviewEl, reviewAnchor);
            }

            item.appendChild(body);
            // 工具确认卡片是否滚底沿用跟随状态：用户上翻阅读历史时不拽回底部，
            // 跟随中则保证卡片进视野（插入前测距会漏算卡片自身高度）。
            listEl.appendChild(item);
            _followNow(listEl);
            var settled = false;
            var decisionResolve = null;
            var decision = new Promise(function (resolve) {
                decisionResolve = resolve;
                function settle(result) {
                    if (settled) return;               // 已结算/已失效后忽略（含超时/停止后的迟到点击）
                    settled = true;
                    resolve(result);
                }
                function finish(approved, skip) {
                    settle({ approved: approved, skipSession: approved && !!skip });
                }
                body.querySelector('.ae-agent-tool-confirm-btn.allow').addEventListener('click', function () {
                    var skipCb = body.querySelector('.ae-agent-tool-confirm-skip-cb');
                    finish(true, !!(skipCb && skipCb.checked));
                });
                // 退回修改：既不执行也不创建，把审查问题交回 LLM。决策带 revise 标记，
                // 调用方据此区别于普通拒绝（拒绝只回「用户拒绝」，LLM 不知道要改什么）
                var reviseBtn = body.querySelector('.ae-agent-tool-confirm-btn.revise');
                if (reviseBtn) {
                    reviseBtn.addEventListener('click', function () {
                        settle({ approved: false, skipSession: false, revise: true });
                    });
                }
                body.querySelector('.ae-agent-tool-confirm-btn.deny').addEventListener('click', function () {
                    finish(false, false);
                });
            });
            // 失效防护：卡片被标记拒绝/超时/停止后，调用方通过 invalidate() 结算 pending 的
            // decision（避免闭包长期挂起），此后任何迟到点击/批准均被 settled 忽略。
            function invalidate() {
                if (settled) return;
                settled = true;
                if (decisionResolve) decisionResolve({ approved: false, skipSession: false });
            }
            return { el: item, decision: decision, invalidate: invalidate };
        }

        // ── 提问工具（askUser）的输入区问答面板 ──────────────
        // 提问不再画进消息流：问答期间整块替换底部输入区（#aeAgentInputArea 隐藏、
        // #aeAgentAskPanel 显示），结算后面板收起、输入区恢复。面板是 index.html 的
        // 静态共享元素（模块 unmount 不销毁），这里只做显隐、内容填充与事件绑定。
        // 消息流里只留一行「已回答 / 未回答」结果记录，由 renderMessages 按 askUser
        // 工具结果的 detail 渲染——数据随消息持久化，整表重建/重载后照样还原
        //（见 _askRecordOf / _appendAskRecords）。
        var _askPanelEl = null;   // 当前未结算提问的面板节点（单例：同一时刻只允许一条提问）
        function _askEl(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
        // 工具名唯一来源见 engine/askUserTool.js；view 先于它加载，故运行时取（同 team/lanes.js）
        function _askToolName() {
            var api = global.AEEngine && global.AEEngine.askUserTool;
            return (api && typeof api.NAME === 'string' && api.NAME) ? api.NAME : 'askUser';
        }
        // 面板与普通输入区互斥显隐。hidden 的可见性由 CSS 的 [hidden] 规则兜底
        //（面板/输入区都是 flex，作者规则会压过 UA 的 [hidden]，见 agent.css）。
        function _askShowPanel(show) {
            var panel = _askEl('aeAgentAskPanel');
            var area = _askEl('aeAgentInputArea');
            if (panel) panel.hidden = !show;
            if (area) area.hidden = !!show;
            // 普通输入区是 200px 定高（agent.css .ae-agent-input-wrap），提问面板按内容高度
            // 显示（CSS 上限 240px），两者不一致；在场时挂 .has-ask-panel 让输入区按内容
            // 自适应，面板结算后摘掉即恢复（用户拖出来的内联高度不丢）。
            var wrap = _askEl('aeAgentInputWrap');
            if (wrap && wrap.classList) {
                wrap.classList[show ? 'add' : 'remove']('has-ask-panel');
            }
        }
        // 清空面板内容（问题/选项/输入/多选态），避免下一条提问看到上一条的残留
        function _askResetPanel() {
            var panel = _askEl('aeAgentAskPanel');
            var qEl = _askEl('aeAgentAskQuestion');
            var optsEl = _askEl('aeAgentAskOptions');
            var input = _askEl('aeAgentAskInput');
            var modeEl = _askEl('aeAgentAskMode');
            if (qEl) qEl.textContent = '';
            if (optsEl) { optsEl.innerHTML = ''; optsEl.hidden = true; }
            if (input) input.value = '';
            if (modeEl) modeEl.hidden = true;
            // 选项画成单选圆点还是多选方框由面板 data-multi 决定（CSS 一处实现）；
            // 清空时回单选默认态，避免下一条单选提问看到上一条的方框。
            if (panel) panel.setAttribute('data-multi', 'false');
        }

        // 返回 { el, decision, invalidate }。
        // decision 结算形状：
        //   单选：{answered:true, text, answers:[text], optionIndex, optionText}
        //   多选：{answered:true, text, answers:[...], optionIndexes:[...], multi:true}
        //   取消：{answered:false, reason}
        // invalidate(reason)：超时/停止/切会话由调用方结算（迟到的点击由 settled 守卫忽略）。
        // 面板单例：已有未结算提问时再问返回 null（handler 按「提问面不可用」fail-closed）。
        function appendAskUser(payload) {
            var p = payload || {};
            var question = (typeof p.question === 'string') ? p.question : '';
            if (!question) return null;
            if (_askPanelEl) return null;
            var panel = _askEl('aeAgentAskPanel');
            var qEl = _askEl('aeAgentAskQuestion');
            var optsEl = _askEl('aeAgentAskOptions');
            var input = _askEl('aeAgentAskInput');
            var submitBtn = _askEl('aeAgentAskSubmit');
            var cancelBtn = _askEl('aeAgentAskCancel');
            var modeEl = _askEl('aeAgentAskMode');
            var hintEl = _askEl('aeAgentAskHint');
            if (!panel || !qEl || !optsEl || !input || !submitBtn || !cancelBtn) return null;

            var options = Array.isArray(p.options) ? p.options.slice(0, 6) : [];
            var multi = p.multi === true;
            var picked = {};        // optionIndex → true（仅多选）
            var settled = false;
            var resolveDecision = null;
            var decision = new Promise(function (resolve) { resolveDecision = resolve; });

            _askResetPanel();
            panel.setAttribute('data-multi', multi ? 'true' : 'false');
            if (input) {
                // 快捷键只写进 placeholder/title，面板顶部只留一句操作方式（窄栏不撑爆头部）
                input.setAttribute('placeholder', options.length
                    ? (multi ? AEI18n.t('也可补充文字，与勾选项一起提交（Ctrl+Enter）…') : AEI18n.t('也可直接输入回答（Ctrl+Enter 提交）…'))
                    : AEI18n.t('输入回答（Ctrl+Enter 提交）…'));
                input.setAttribute('title', AEI18n.t('Ctrl+Enter 提交，Esc 取消'));
            }
            qEl.textContent = question;
            if (modeEl) modeEl.hidden = !multi;
            if (hintEl) {
                // 文案里保留「点选项 / 勾选」两类动作词：用户识别与测试断言都按这两句走
                hintEl.textContent = !options.length
                    ? AEI18n.t('输入回答后点「回答」')
                    : (multi ? AEI18n.t('可勾选多个选项，选好后点「回答」') : AEI18n.t('点选项即回答'));
            }
            if (options.length) {
                optsEl.hidden = false;
                for (var oi = 0; oi < options.length; oi++) {
                    (function (idx) {
                        var label = String(options[idx] == null ? '' : options[idx]);
                        var ob = document.createElement('button');
                        ob.type = 'button';
                        ob.className = 'ae-agent-ask-option';
                        ob.textContent = label;
                        if (multi) {
                            // 多选：点击切换勾选态，点「回答」才结算（aria-pressed 驱动选中样式）
                            ob.setAttribute('aria-pressed', 'false');
                            ob.addEventListener('click', function () {
                                picked[idx] = !picked[idx];
                                ob.setAttribute('aria-pressed', picked[idx] ? 'true' : 'false');
                            });
                        } else {
                            // 单选：点选项即作答（与改造前一致）
                            ob.addEventListener('click', function () {
                                settle({ answered: true, text: label, answers: [label], optionIndex: idx, optionText: label });
                            });
                        }
                        optsEl.appendChild(ob);
                    })(oi);
                }
            }

            // 汇总当前回答：勾选项（按选项原顺序）+ 自由输入文本（非空时作为最后一项）
            function collectAnswer() {
                var answers = [];
                var indexes = [];
                for (var i = 0; i < options.length; i++) {
                    if (picked[i]) {
                        answers.push(String(options[i] == null ? '' : options[i]));
                        indexes.push(i);
                    }
                }
                var text = String(input.value == null ? '' : input.value).replace(/^\s+|\s+$/g, '');
                if (text) answers.push(text);
                return { answers: answers, indexes: indexes, text: text };
            }
            function submitFromInput() {
                var c = collectAnswer();
                if (!c.answers.length) {
                    // 什么都没选/没输入：不结算（保持等待），把焦点给输入框引导用户
                    if (typeof input.focus === 'function') input.focus();
                    return;
                }
                var joined = c.answers.join('、');
                if (multi) {
                    settle({ answered: true, text: joined, answers: c.answers, optionIndexes: c.indexes, multi: true });
                } else {
                    settle({ answered: true, text: joined, answers: c.answers, optionIndex: null, optionText: null });
                }
            }

            function settle(result) {
                if (settled) return;
                settled = true;
                _askPanelEl = null;
                _askShowPanel(false);      // 输入区立即恢复（问答结束后用户要能直接输入）
                _askResetPanel();
                if (resolveDecision) resolveDecision(result);
            }

            submitBtn.addEventListener('click', submitFromInput);
            cancelBtn.addEventListener('click', function () {
                settle({ answered: false, reason: 'user' });
            });
            input.addEventListener('keydown', function (e) {
                if (!e) return;
                var isEnter = (e.key === 'Enter' || e.keyCode === 13);
                if (isEnter && (e.ctrlKey || e.metaKey)) {
                    if (typeof e.preventDefault === 'function') e.preventDefault();
                    submitFromInput();
                    return;
                }
                // Esc = 取消提问（与「取消」按钮同义）：问答是阻塞态，键盘要有出口
                if (e.key === 'Escape' || e.keyCode === 27) {
                    if (typeof e.preventDefault === 'function') e.preventDefault();
                    settle({ answered: false, reason: 'user' });
                }
            });

            _askPanelEl = panel;
            _askShowPanel(true);
            // 提问是**阻塞用户**的：焦点落到面板输入框，用户可直接打字回答
            if (typeof input.focus === 'function') { try { input.focus(); } catch (_) { /* 测试桩无 focus */ } }

            return {
                el: panel,
                decision: decision,
                invalidate: function (reason) {
                    settle({ answered: false, reason: reason || 'cancelled' });
                }
            };
        }

        // ── askUser 结果记录行（消息流里唯一可见的问答痕迹）──────────────────────
        // 提问面在输入区，消息流只留一行结果：位置在该条工具所在的「工具调用记录」组之后
        //（结果气泡位于工具记录之后）。数据源是工具结果的
        // detail（JSON，随消息持久化）⇒ 整表重建、切会话回来、重载都能还原。
        // 返回 null 表示这条结果不该落记录：没有提问面的 unavailable / invalid_args，
        // 以及属于旧会话的 session_changed（与改造前「切会话直接摘卡」同口径）。
        function _askRecordOf(tr) {
            if (!tr || tr.toolName !== _askToolName()) return null;
            var raw = tr.detail;
            if (typeof raw !== 'string' || !raw) return null;
            var p = null;
            try { p = JSON.parse(raw); } catch (_) { return null; }
            if (!p || typeof p !== 'object') return null;
            var st = String(p.status || '');
            if (st === 'answered') {
                var text = (typeof p.answer === 'string' && p.answer)
                    ? p.answer
                    : (Array.isArray(p.answers) ? p.answers.join('、') : '');
                return { ok: true, text: text };
            }
            if (st === 'timeout') return { ok: false, text: AEI18n.t('超时未回答') };
            // 停止有两条回执形态：handler 自己结算时是 cancelled/stop；管线 Promise.race
            // 先返回时是 stopped（生产常态——race 先返回，handler 的 cancelled 载荷不落到消息里）。
            // 两者都要留一行「未回答」，否则停止场景在消息流里看不到这次提问的结局。
            if (st === 'stopped') return { ok: false, text: AEI18n.t('本轮被中止，未回答') };
            if (st === 'cancelled') {
                if (p.reason === 'session_changed') return null;
                if (p.reason === 'stop') return { ok: false, text: AEI18n.t('本轮被中止，未回答') };
                return { ok: false, text: AEI18n.t('用户取消了提问') };
            }
            return null;
        }

        // 插到 ref 之后（ref 是 listEl 的子节点；浏览器里 children 是 HTMLCollection）
        function _insertAfterChild(listEl, node, ref) {
            var kids = listEl.children;
            var at = (kids && typeof kids.length === 'number') ? Array.prototype.indexOf.call(kids, ref) : -1;
            var next = (at >= 0 && at + 1 < kids.length) ? kids[at + 1] : null;
            listEl.insertBefore(node, next);
        }

        function _buildAskRecordEl(rec) {
            var item = document.createElement('div');
            item.className = 'ae-agent-message tool-result ae-agent-ask-record';
            var body = document.createElement('div');
            body.className = 'ae-agent-message-body';
            var wrap = document.createElement('div');
            wrap.className = 'ae-agent-tool-result';
            var headEl = document.createElement('span');
            headEl.className = 'ae-agent-tool-header';
            var iconEl = document.createElement('span');
            iconEl.className = 'ae-agent-tool-icon';
            iconEl.textContent = rec.ok ? '💬' : '⏸️';
            var labelEl = document.createElement('span');
            labelEl.textContent = rec.ok ? AEI18n.t('已回答: ') : AEI18n.t('未回答: ');
            var strongEl = document.createElement('strong');
            // 回答可能很长（粘贴大段文本）：记录行只摆摘要，全文在工具结果的「返回」里
            var shown = String(rec.text == null ? '' : rec.text);
            if (shown.length > 300) {
                shown = shown.slice(0, 300) + '…';
                strongEl.title = AEI18n.t('回答较长，完整内容见工具结果');
            }
            strongEl.textContent = shown;
            headEl.appendChild(iconEl);
            headEl.appendChild(labelEl);
            headEl.appendChild(strongEl);
            wrap.appendChild(headEl);
            body.appendChild(wrap);
            item.appendChild(body);
            _linkifyLocalPaths(body);
            return item;
        }

        // 本组工具结果里每有一条 askUser 记录，就在组尾之后各追加一行（按结果顺序）
        function _appendAskRecords(listEl, toolRun, tailEl) {
            if (!listEl || !toolRun || !toolRun.length) return;
            var anchor = tailEl || null;
            for (var i = 0; i < toolRun.length; i++) {
                var rec = _askRecordOf(toolRun[i]);
                if (!rec) continue;
                var line = _buildAskRecordEl(rec);
                if (anchor) _insertAfterChild(listEl, line, anchor);
                else listEl.appendChild(line);
                anchor = line;
            }
        }

        // 确认条目 → 执行中形态（与 appendToolProgress 同款外观）
        function markToolProgressRunning(el, toolName, action) {
            if (!el) return;
            el.className = 'ae-agent-message tool-progress';
            var body = el.querySelector('.ae-agent-message-body');
            if (body) {
                // executeExtendScript 优先显示 action（LLM 填写的操作目的）
                var label = (toolName === 'executeExtendScript' && action) ? action : toolName;
                var title = (toolName === 'executeExtendScript' && action) ? AEI18n.t('正在执行') : AEI18n.t('正在调用工具');
                body.innerHTML = '<div class="ae-agent-tool-progress">' +
                    '<span class="ae-agent-tool-icon">⏳</span>' +
                    '<span>' + title + ': <strong>' + escapeHtml(label) + '</strong>...</span>' +
                    '</div>';
            }
            _scheduleFollow();  // 确认卡 → 执行中形态的高度变化，跟随中保持贴底
        }

        // 确认条目 → 已拒绝形态（一行记录，留在消息流作审计痕迹）
        function markToolRejected(el, toolName, action) {
            if (!el) return;
            el.className = 'ae-agent-message tool-result';
            var body = el.querySelector('.ae-agent-message-body');
            if (body) {
                // executeExtendScript 优先显示 action（LLM 填写的操作目的）
                var label = (toolName === 'executeExtendScript' && action) ? action : toolName;
                body.innerHTML = '<div class="ae-agent-tool-result">' +
                    AEI18n.html('<span class="ae-agent-tool-header"><span class="ae-agent-tool-icon">🚫</span> 已拒绝执行: <strong>') + escapeHtml(label) + '</strong></span>' +
                    '</div>';
            }
            _scheduleFollow();
        }

        // 确认条目 → 已按审查意见退回形态（一行记录，留在消息流作审计痕迹）
        // 与 markToolRejected 分开：退回是"带反馈的否决"，拒绝是无反馈的否决，两者在
        // 消息流里须能区分（用户回看时要知道 LLM 是收到了审查意见还是只收到一句拒绝）
        // label：调用方给的显示名（createAETool 传被创建工具的名字——工具名恒定，
        // 不带它则每条退回记录都长一样）；缺省回落到工具名。
        function markToolRevisionRequested(el, toolName, label) {
            if (!el) return;
            el.className = 'ae-agent-message tool-result';
            var body = el.querySelector('.ae-agent-message-body');
            if (body) {
                var shown = label ? String(label) : toolName;
                body.innerHTML = '<div class="ae-agent-tool-result">' +
                    AEI18n.html('<span class="ae-agent-tool-header"><span class="ae-agent-tool-icon">✏️</span> 已按审查意见退回修改: <strong>') + escapeHtml(shown) + '</strong></span>' +
                    '</div>';
            }
            _scheduleFollow();
        }

        // 忙态落 DOM（**只在允许写共用栏时调用**，见 setBusy 的闸门）
        function _writeBusy(isBusy, text) {
            var status = _byId('statusId');
            var inlineStatus = _byId('inlineStatusId');
            var statusPanel = _byId('statusPanelId');
            if (inlineStatus) {
                inlineStatus.textContent = '';
                inlineStatus.className = 'ae-agent-inline-status status-inline';
                inlineStatus.style.display = 'none';
            }
            if (statusPanel) {
                if (isBusy) {
                    if (!lastBusy || !statusPanel.classList.contains('is-generating')) {
                        var cycleMs = 2800;
                        var syncMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) % cycleMs);
                        statusPanel.style.setProperty('--anim-sync-ms', String(syncMs));
                        statusPanel.classList.remove('is-generating');
                        void statusPanel.offsetWidth;
                        statusPanel.classList.add('is-generating');
                    }
                } else if (lastBusy) {
                    statusPanel.classList.remove('is-generating');
                }
                // 提示态（is-hint）与忙态互斥：任何一次真实忙态写入都要摘掉它，否则提示的底色会留在
                // 「正在调用工具…」这种真状态上。
                statusPanel.classList.remove('is-hint');
                statusPanel.classList.remove('is-highlight');
                if (isBusy && !lastBusy) {
                    requestAnimationFrame(function () {
                        statusPanel.classList.add('is-highlight');
                        setTimeout(function () { statusPanel.classList.remove('is-highlight'); }, 560);
                    });
                }
            }
            if (!status) return;
            if (isBusy) {
                var msg = text || AEI18n.t('正在处理，请稍候...');
                var toneClass = /停止/.test(msg) ? 'status-tone-warn' : 'status-tone-safe';
                status.textContent = msg.replace(/\s+/g, ' ').trim();
                status.title = msg;
                status.className = 'status-inline info ' + toneClass;
                status.style.display = 'flex';
                status.style.visibility = 'visible';
            } else {
                status.textContent = '';
                status.title = '';
                status.className = 'status-inline';
                status.style.display = 'none';
            }
            lastBusy = !!isBusy;
        }

        // 忙态入口：本 lane 的忙态先记在本地，再决定要不要落到共用栏上（闸门见 _statusWritable）。
        // 消息列表的 busy 类**不受闸门影响**——那是本 lane 自己的列表，与「当前 lane」无关。
        function setBusy(isBusy, text) {
            _laneBusy = !!isBusy;
            _laneBusyText = (text === undefined || text === null) ? '' : String(text);
            // 真实忙态优先于切 lane 提示：取消未到点的提示计时器，别让提示盖住真状态
            //（clearStatusChrome 与这里各清一次：提示是唯一会「到点自己改写共用栏」的写入方）
            _clearFlash();
            var listForBusy = _byId('listId');
            if (listForBusy) listForBusy.classList.toggle('ae-agent-list-busy', _laneBusy);
            if (!_statusWritable()) return;
            _writeBusy(_laneBusy, _laneBusyText);
        }

        // 切到本 lane 时由 bootstrap 的 onCurrentLaneChange 调：把本 lane 的忙态重放到共用栏。
        // 先清掉上一条 lane 留下的脉冲/高亮，再写本 lane 的忙态。
        // 注：这里的 `lastBusy = false` **不是**「摘脉冲」的手段（上面已显式 remove 过
        // `is-generating`，而 _writeBusy 的判据含 `!contains('is-generating')` ⇒ 归零与否等效）；
        // 它唯一的作用是让 `isBusy && !lastBusy` 那次 `is-highlight` 闪烁在重放时也发生
        //（切到一条正在跑的 lane，栏上闪一下＝用户得到「换人了」的可见反馈）。
        function replayBusy() {
            if (!_sharedStatus) { _writeBusy(_laneBusy, _laneBusyText); return; }
            var panel = _byId('statusPanelId');
            if (panel && panel.classList) {
                panel.classList.remove('is-generating');
                panel.classList.remove('is-highlight');
                panel.classList.remove('is-hint');
            }
            lastBusy = false;
            _writeBusy(_laneBusy, _laneBusyText);
        }

        // 切 lane 的**短暂提示**（切过去时短暂弹一条提示，2~3 秒后自动收起）。
        // 为什么要它：切到一条**空闲** lane 时共用状态栏什么都不弹（`_writeBusy(false,…)` 是隐藏），
        // 用户点完胶囊没有任何可见反馈，不知道到底切过去没有。忙的 lane 有执行文案，闲的没有——
        // 这条提示把「换人了」这件事对两种情况都给足。
        // 契约：
        //   · 写入走**同一条** _writeBusy 路径（脉冲 + is-highlight 闪烁与真实忙态一致）；
        //   · 到点后**回到本 lane 的真实状态**（忙⇒执行文案，闲⇒收起），不留下假文案；
        //   · 闸门照旧（_statusWritable）：非当前 lane / 团队关闭时不写共用栏（单 Agent 路径恒可写）；
        //   · 真实忙态写入（setBusy）会**取消**未到点的计时器——否则提示会盖住
        //     「正在调用工具…」这类真状态，等于在栏上说一句假话。
        var _flashTimer = null;
        function _clearFlash() {
            if (_flashTimer) { clearTimeout(_flashTimer); _flashTimer = null; }
        }
        function flashStatus(text, ms) {
            var msg = (text === undefined || text === null) ? '' : String(text);
            if (!msg) return false;
            _clearFlash();
            if (!_statusWritable()) return false;
            // **不是忙态**（切 Agent 不激活状态栏的运行态动画）：
            // 不能走 `_writeBusy(true, msg)`：切 lane 会给状态栏挂上 `is-generating`
            // ——那是「正在跑」的脉冲（loader 扫光 + 呼吸），等于在栏上说了 2.5s 的假事实。
            // 提示改走独立路径：只写文案 + 一次轻微高亮，不碰忙态类。
            _writeHint(msg);
            var ttl = (typeof ms === 'number' && ms > 0) ? ms : 2500;
            _flashTimer = setTimeout(function () {
                _flashTimer = null;
                if (!_statusWritable()) return;
                _writeBusy(_laneBusy, _laneBusyText);   // 回到真状态（本 lane 的忙态重放）
            }, ttl);
            return true;
        }

        // 提示写入（切 lane 的「已切到 XXX」）：与 _writeBusy 的分工——
        //   · 不设 `is-generating`（不冒充运行态）、不动 `lastBusy`（提示不是忙态，不能污染忙态边沿）；
        //   · 加 `is-hint` + 一次 `is-highlight` 闪烁（换人的可见反馈），文案走中性色（status-tone-hint）；
        //   · 到点由 flashStatus 的定时器调 _writeBusy 回到真实状态（那一步会摘掉 is-hint）。
        function _writeHint(text) {
            var status = _byId('statusId');
            var inlineStatus = _byId('inlineStatusId');
            var statusPanel = _byId('statusPanelId');
            if (inlineStatus) {
                inlineStatus.textContent = '';
                inlineStatus.className = 'ae-agent-inline-status status-inline';
                inlineStatus.style.display = 'none';
            }
            if (statusPanel && statusPanel.classList) {
                statusPanel.classList.remove('is-generating');
                statusPanel.classList.remove('is-highlight');
                statusPanel.classList.add('is-hint');
                requestAnimationFrame(function () {
                    statusPanel.classList.add('is-highlight');
                    setTimeout(function () { statusPanel.classList.remove('is-highlight'); }, 560);
                });
            }
            if (!status) return;
            var msg = String(text || '').replace(/\s+/g, ' ').trim();
            status.textContent = msg;
            status.title = msg;
            status.className = 'status-inline info status-tone-hint';
            status.style.display = 'flex';
            status.style.visibility = 'visible';
        }

        // 清共用栏的文案与脉冲（团队关闭时由 bootstrap 调）。为什么需要：关团队先置
        // `_teamEnabled=false` 再 dispose（bootstrap._disableTeam），而闸门判据 `_isCurrentLane`
        // 在团队关闭时恒 false ⇒ 各 lane 收尾的 `setBusy(false,…)` 全被挡下，栏上会残留
        // 「上一条 lane 还在跑」的文案与脉冲（用户看到的是一句假事实）。这里无条件清干净。
        function clearStatusChrome() {
            _clearFlash();   // 提示计时器一并作废（团队关闭后它不该再把栏写回来）
            var panel = _byId('statusPanelId');
            if (panel && panel.classList) {
                panel.classList.remove('is-generating');
                panel.classList.remove('is-highlight');
                panel.classList.remove('is-hint');
            }
            var status = _byId('statusId');
            if (status) {
                status.textContent = '';
                status.title = '';
                status.className = 'status-inline';
                status.style.display = 'none';
            }
            var inlineStatus = _byId('inlineStatusId');
            if (inlineStatus) {
                inlineStatus.textContent = '';
                inlineStatus.className = 'ae-agent-inline-status status-inline';
                inlineStatus.style.display = 'none';
            }
            lastBusy = false;
        }

        function setMode(mode) {
            void mode;
        }

        // 更新 token 统计显示
        // total 为 tokenStats.getTotal() 返回值，null 时显示 '--'
        // 数字变化时做 odometer 风格的滚动动画（requestAnimationFrame 插值）
        var _tokenAnimState = {
            up: 0,            // 当前已渲染的发送 token 数值
            down: 0,          // 当前已渲染的接收 token 数值
            targetUp: 0,      // 目标发送 token 数值
            targetDown: 0,    // 目标接收 token 数值
            cacheText: '--',  // 缓存命中率文本（不参与动画，随帧同步）
            rafId: null,      // 当前动画帧 id
            hasRendered: false // 是否已首次渲染（用于跳过首次动画）
        };

        function _formatTokenText(val) {
            return val > 0 ? String(val) : '--';
        }

        function _tokenStatsHtml(upVal, downVal, cacheText) {
            // 三个 span 作为 flex 直接子元素，中间不加文本节点，
            // 间距由父级 .ae-agent-token-stats 的 gap 控制
            return '<span class="ae-agent-token-up">↑' + _formatTokenText(upVal) + '</span>'
                + '<span class="ae-agent-token-down">↓' + _formatTokenText(downVal) + '</span>'
                + '<span class="ae-agent-token-cache">' + AEI18n.t('缓存{n}', { n: cacheText }) + '</span>';
        }

        function _renderTokenStatsDom(el, upVal, downVal, cacheText) {
            el.innerHTML = _tokenStatsHtml(upVal, downVal, cacheText);
        }

        // ── token 统计 hover 详情浮层（向下弹出）──
        // 展示累计 token 明细 + 性能指标：首token平均 / tok/s / LLM 运行时间 / 工具运行时间 / 轮次 / 步数
        var _tokenPopover = null;
        var _tokenPopTimer = null;
        var _tokenStatsTotal = null;
        // 团队模式：顶栏用量行在团队模式下是**当前 lane** 的镜像（index.js 的
        // _syncTokenRowToLane 只搬 innerHTML，事件与数据源仍留在这条单 Agent view 上）⇒ 明细
        // 浮层读的是单 Agent 通道的记录（真机：行显示 ↑5,914,987，浮层全 '--'、轮次 0）。
        // 注入的解析器现取当前 lane 的用量快照，让浮层与镜像行同源；单 Agent 路径不注入。
        var _resolveTokenSnapshot = (typeof opts.resolveTokenStatsSnapshot === 'function')
            ? opts.resolveTokenStatsSnapshot : null;

        function _fmtSecText(ms) {
            return (typeof ms === 'number' && isFinite(ms)) ? AEI18n.t('{n} 秒', { n: (ms / 1000).toFixed(2) }) : '--';
        }
        function _fmtTokPerSec(v) {
            return (typeof v === 'number' && isFinite(v)) ? Math.round(v) + ' tok/s' : '--';
        }

        // 「轮次」= 用户回合数：统计当前会话中 role==='user' 的消息条数。
        // 与 token stats 记录无关（那是模型调用/工具执行），故由外部注入 getActiveCm 实时取。
        // `_hidden` 不计：goal 第 1 轮的 `<goal_round>` 指令以隐藏 user 消息承载（UI 不可见），
        // 它不是人类回合；续轮（第 2 轮起）以 system-result 卡承载同样不计——两轮口径一致。
        function _getUserRoundCount() {
            var cm = (typeof opts.getActiveCm === 'function') ? opts.getActiveCm() : null;
            if (!cm || typeof cm.list !== 'function') return 0;
            var msgs = cm.list() || [];
            var n = 0;
            for (var i = 0; i < msgs.length; i++) {
                if (msgs[i] && msgs[i].role === 'user' && msgs[i]._local !== true
                    && msgs[i]._hidden !== true) n++;
            }
            return n;
        }

        function _addPopRow(pop, label, value) {
            var row = document.createElement('div');
            row.className = 'tpop-row';
            var l = document.createElement('span');
            l.className = 'tpop-label';
            l.textContent = label;
            var v = document.createElement('span');
            v.className = 'tpop-value';
            v.textContent = value;
            row.appendChild(l);
            row.appendChild(v);
            pop.appendChild(row);
        }

        function _buildTokenPopover() {
            // 数据源：本 view 自己的记录；团队模式下由 resolveTokenStatsSnapshot 换成
            // 当前 lane 的快照（行是当前 lane 的镜像，浮层必须同源）。解析失败/返回空
            // 时回落本 view 的记录——不给热路径留异常面。
            var total = _tokenStatsTotal;
            var rounds = _getUserRoundCount();
            if (_resolveTokenSnapshot) {
                var snap = null;
                try { snap = _resolveTokenSnapshot(); } catch (_) { snap = null; }
                if (snap && typeof snap === 'object') {
                    total = snap.total || null;
                    if (typeof snap.rounds === 'number' && isFinite(snap.rounds)) rounds = snap.rounds;
                }
            }
            var pop = document.createElement('div');
            pop.className = 'ae-agent-popover ae-agent-token-popover';
            var title = document.createElement('span');
            title.className = 'tpop-title';
            title.textContent = AEI18n.t('当前会话统计');
            pop.appendChild(title);

            if (!total) {
                _addPopRow(pop, AEI18n.t('↑ 发送 tokens'), '--');
                _addPopRow(pop, AEI18n.t('↓ 接收 tokens'), '--');
                _addPopRow(pop, AEI18n.t('缓存命中率'), '--');
                var sep0 = document.createElement('div');
                sep0.className = 'tpop-sep';
                pop.appendChild(sep0);
                _addPopRow(pop, AEI18n.t('轮次'), String(rounds));
                _addPopRow(pop, AEI18n.t('步数'), '--');
                _addPopRow(pop, AEI18n.t('首token平均'), '--');
                _addPopRow(pop, AEI18n.t('生成速度'), '--');
                _addPopRow(pop, AEI18n.t('LLM 运行时间'), '--');
                _addPopRow(pop, AEI18n.t('工具运行时间'), '--');
                return pop;
            }

            var cacheText = '--';
            if (typeof total.cacheHitRate === 'number') cacheText = Math.round(total.cacheHitRate * 100) + '%';
            _addPopRow(pop, AEI18n.t('↑ 发送 tokens'), String(total.promptTokens));
            _addPopRow(pop, AEI18n.t('↓ 接收 tokens'), String(total.completionTokens));
            _addPopRow(pop, AEI18n.t('缓存命中率'), cacheText);
            var sep = document.createElement('div');
            sep.className = 'tpop-sep';
            pop.appendChild(sep);
            _addPopRow(pop, AEI18n.t('轮次'), String(rounds));
            _addPopRow(pop, AEI18n.t('步数'), String(total.llmCalls));
            _addPopRow(pop, AEI18n.t('首token平均'), _fmtSecText(total.avgFirstTokenMs));
            _addPopRow(pop, AEI18n.t('生成速度'), _fmtTokPerSec(total.avgTokPerSec));
            _addPopRow(pop, AEI18n.t('LLM 运行时间'), _fmtSecText(total.llmCalls > 0 ? total.totalLlmMs : null));
            _addPopRow(pop, AEI18n.t('工具运行时间'), _fmtSecText(total.toolCalls > 0 ? total.totalToolMs : null));
            return pop;
        }

        function _hideTokenPopover() {
            if (_tokenPopover) {
                _tokenPopover.remove();
                _tokenPopover = null;
            }
        }

        function _positionTokenPopover(pop, anchor) {
            var r = anchor.getBoundingClientRect();
            var pw = pop.offsetWidth || 300;
            var left = r.left + (r.width - pw) / 2;
            if (left < 8) left = 8;
            if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
            pop.style.left = left + 'px';
            pop.style.top = (r.bottom + 6) + 'px';
        }

        function _showTokenPopover(anchor) {
            _hideTokenPopover();
            var pop = _buildTokenPopover();
            document.body.appendChild(pop);
            _positionTokenPopover(pop, anchor);
            _tokenPopover = pop;
            pop.addEventListener('mouseenter', function () { clearTimeout(_tokenPopTimer); });
            pop.addEventListener('mouseleave', function () { _tokenPopTimer = setTimeout(_hideTokenPopover, 200); });
        }

        // hover 监听按**元素**登记（顶栏 token 行/浮层）：团队档没有 single view，
        // 顶栏共享元素由「当前 lane 的 view」迁绑（bootstrap._bindTopTokenPopover）；同一 view 也会
        // 绑自己 lane 的隐藏用量行。故不能再用「全局只绑一次」的布尔——每个元素各绑一次，
        // destroy / 迁绑时按元素精确解绑。
        var _tokenShowDelay = 500; // 悬停多久后显示浮层（毫秒）
        var _tokenPopoverBindings = [];   // [{ el, enter, leave }]
        function _bindingOf(el) {
            for (var i = 0; i < _tokenPopoverBindings.length; i++) {
                if (_tokenPopoverBindings[i].el === el) return _tokenPopoverBindings[i];
            }
            return null;
        }
        function _ensureTokenPopover(el) {
            if (!el || _bindingOf(el)) return;
            var enter = function () {
                clearTimeout(_tokenPopTimer);
                _tokenPopTimer = setTimeout(function () { _showTokenPopover(el); }, _tokenShowDelay);
            };
            var leave = function () {
                clearTimeout(_tokenPopTimer);
                _tokenPopTimer = setTimeout(_hideTokenPopover, 200);
            };
            el.addEventListener('mouseenter', enter);
            el.addEventListener('mouseleave', leave);
            _tokenPopoverBindings.push({ el: el, enter: enter, leave: leave });
        }
        // 解绑指定的共享元素（迁绑用）；不传 = 解绑本 view 的全部（destroy 用）。
        function unbindTokenPopover(el) {
            for (var i = _tokenPopoverBindings.length - 1; i >= 0; i--) {
                var b = _tokenPopoverBindings[i];
                if (el && b.el !== el) continue;
                try { b.el.removeEventListener('mouseenter', b.enter); } catch (_) { /* 已移除 */ }
                try { b.el.removeEventListener('mouseleave', b.leave); } catch (_) { /* 已移除 */ }
                _tokenPopoverBindings.splice(i, 1);
            }
            if (_tokenPopTimer) { clearTimeout(_tokenPopTimer); _tokenPopTimer = null; }
            _hideTokenPopover();
        }
        // 绑顶栏共享元素（bootstrap 在当前 runtime 切换时调；见 _bindTopTokenPopover）。
        function bindTokenPopover(el) { _ensureTokenPopover(el); }

        function updateTokenStats(total) {
            var el = _byId('tokenStatsId');
            if (!el) return;
            _ensureTokenPopover(el);
            _tokenStatsTotal = total;

            var newUp = total ? (total.promptTokens || 0) : 0;
            var newDown = total ? (total.completionTokens || 0) : 0;
            // 缓存命中率不参与滚动动画：有记录时显示整数百分比，无记录显示占位
            var cacheText = '--';
            if (total && typeof total.cacheHitRate === 'number') {
                cacheText = Math.round(total.cacheHitRate * 100) + '%';
            }

            // 首次渲染（含 null 初始状态）：直接写入，不做动画
            if (!_tokenAnimState.hasRendered) {
                _tokenAnimState.up = newUp;
                _tokenAnimState.down = newDown;
                _tokenAnimState.targetUp = newUp;
                _tokenAnimState.targetDown = newDown;
                _tokenAnimState.cacheText = cacheText;
                _tokenAnimState.hasRendered = true;
                _renderTokenStatsDom(el, newUp, newDown, cacheText);
                return;
            }

            // 值未变化：通常跳过（省掉无意义的重绘）。但 **DOM 可能已被别处改写**：团队模式下
            // 顶栏那行是当前 lane 的镜像（index.js 的 _syncTokenRowToLane 直接写 innerHTML），
            // 切回本模式后本 view 的记录没变，若在这里直接 return，行上留的就是上一条 lane 的
            // 数字（团队模式切到别的模式不更新）。故值没变也核对一次 DOM，
            // 不一致就按本 view 的记录重画；动画在途时交给动画收尾（中途改会跳变）。
            if (newUp === _tokenAnimState.targetUp
                && newDown === _tokenAnimState.targetDown
                && cacheText === _tokenAnimState.cacheText) {
                if (_tokenAnimState.rafId === null
                    && el.innerHTML !== _tokenStatsHtml(newUp, newDown, cacheText)) {
                    _renderTokenStatsDom(el, newUp, newDown, cacheText);
                }
                return;
            }
            _tokenAnimState.targetUp = newUp;
            _tokenAnimState.targetDown = newDown;
            _tokenAnimState.cacheText = cacheText;

            // 已有动画进行中：让它继续，目标值会在下一帧被采用
            if (_tokenAnimState.rafId !== null) return;

            // 启动动画
            var duration = 420;  // ms
            var startTime = -1;
            var startUp = _tokenAnimState.up;
            var startDown = _tokenAnimState.down;

            function tick(ts) {
                if (startTime < 0) startTime = ts;
                var elapsed = ts - startTime;
                var t = elapsed >= duration ? 1 : elapsed / duration;
                // ease-out cubic
                var eased = 1 - Math.pow(1 - t, 3);

                var curUp = Math.round(startUp + (_tokenAnimState.targetUp - startUp) * eased);
                var curDown = Math.round(startDown + (_tokenAnimState.targetDown - startDown) * eased);
                _tokenAnimState.up = curUp;
                _tokenAnimState.down = curDown;
                _renderTokenStatsDom(el, curUp, curDown, _tokenAnimState.cacheText);

                if (t < 1) {
                    _tokenAnimState.rafId = requestAnimationFrame(tick);
                } else {
                    _tokenAnimState.rafId = null;
                }
            }
            _tokenAnimState.rafId = requestAnimationFrame(tick);
        }

        // 强制按本 view 的当前记录重画顶栏用量行。
        // 为什么需要独立出口：切模式 / 切 lane / 关团队后，那行可能仍是上一个模式（团队档是
        // 当前 lane）的镜像内容，而本 view 的记录**没变**——updateTokenStats 的「值未变化」
        // 短路救不回来（真机形态：团队 director 跑过 141558，切到 Agent 档后行还停在
        // ↑141558，而本通道实际是 1868199）。本出口不看新旧值，直接写一次，并复位动画状态
        // （切断在途补间，避免它把刚画好的值又拖回旧目标）。
        function refreshTokenStats() {
            var el = _byId('tokenStatsId');
            if (!el) return false;
            _ensureTokenPopover(el);
            var total = _tokenStatsTotal;
            var up = total ? (total.promptTokens || 0) : 0;
            var down = total ? (total.completionTokens || 0) : 0;
            var cacheText = '--';
            if (total && typeof total.cacheHitRate === 'number') {
                cacheText = Math.round(total.cacheHitRate * 100) + '%';
            }
            if (_tokenAnimState.rafId !== null) {
                if (typeof cancelAnimationFrame === 'function') {
                    try { cancelAnimationFrame(_tokenAnimState.rafId); } catch (_) { /* 已结束的帧 id 无害 */ }
                }
                _tokenAnimState.rafId = null;
            }
            _tokenAnimState.up = up;
            _tokenAnimState.down = down;
            _tokenAnimState.targetUp = up;
            _tokenAnimState.targetDown = down;
            _tokenAnimState.cacheText = cacheText;
            _tokenAnimState.hasRendered = true;
            _renderTokenStatsDom(el, up, down, cacheText);
            return true;
        }

        // 用量快照（团队模式）：本 view 的「行内数字 + 轮次」只读副本。
        // 团队模式下 bootstrap 用它给顶栏那行的浮层提供**当前 lane** 的明细（行是当前 lane
        // 的镜像，见 index.js 的 _syncTokenRowToLane / view 的 resolveTokenStatsSnapshot）。
        function getTokenStatsSnapshot() {
            return { total: _tokenStatsTotal, rounds: _getUserRoundCount() };
        }

        function clearInput() {
            var input = document.getElementById('aeAgentInput');
            if (input) {
                input.value = '';
                input.dispatchEvent(new Event('input'));
            }
            var chips = document.getElementById('aeAgentFileChips');
            if (chips) {
                // 清空前回收视频 chip 的 blob: URL（main.js 拖拽视频用 createObjectURL
                // 生成，不回收则 File 对象长期滞留 = 资源泄漏）
                var vids = chips.querySelectorAll('video');
                for (var ci = 0; ci < vids.length; ci++) {
                    var vs = vids[ci].getAttribute('src') || '';
                    if (vs.indexOf('blob:') === 0 && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                        try { URL.revokeObjectURL(vs); } catch (_) {}
                    }
                }
                chips.innerHTML = '';
            }
        }

        function getInput() {
            var input = document.getElementById('aeAgentInput');
            return input ? input.value.trim() : '';
        }

        function renderPlanToSidebar(containerEl) {
            // 重渲会换掉全部行节点：旧浮层的锚点随旧行作废，先收掉（浮层挂 body，不随容器重写消失）。
            closePlanDetail();
            if (!containerEl) return;
            containerEl.innerHTML = '';
            var bridge = global.AEEngine && global.AEEngine.bridge;
            var plan = bridge && typeof bridge.getActivePlan === 'function' ? bridge.getActivePlan() : null;
            if (!plan || !plan.steps || plan.steps.length === 0) {
                var emptyMsg = document.createElement('div');
                emptyMsg.className = 'plan-sidebar-empty';
                emptyMsg.textContent = AEI18n.t('暂无任务清单');
                containerEl.appendChild(emptyMsg);
                return;
            }
            for (var i = 0; i < plan.steps.length; i++) {
                var step = plan.steps[i];
                var row = document.createElement('div');
                row.className = 'plan-sidebar-step';
                if (step._done) row.classList.add('done');
                if (step._running && !step._done) row.classList.add('running');
                if (row.setAttribute) {
                    // 键盘可达：行可点开详情（与团队任务行同一套 role/tabindex + Enter/Space 语义）
                    row.setAttribute('role', 'button');
                    row.setAttribute('tabindex', '0');
                }

                var numSpan = document.createElement('span');
                numSpan.className = 'plan-sidebar-num';
                numSpan.textContent = (step.number || (i + 1)) + '.';
                row.appendChild(numSpan);

                var descSpan = document.createElement('span');
                descSpan.className = 'plan-sidebar-desc';
                descSpan.textContent = step.description || '';
                row.appendChild(descSpan);

                if (step._done) {
                    var checkIcon = document.createElement('span');
                    checkIcon.className = 'plan-sidebar-check';
                    checkIcon.textContent = '\u2713';
                    row.appendChild(checkIcon);
                } else if (step._running) {
                    var spinner = document.createElement('span');
                    spinner.className = 'plan-sidebar-spinner';
                    row.appendChild(spinner);
                }

                containerEl.appendChild(row);
            }
            // 行点击/键盘入口在容器上委托一次（行节点随每次重渲替换，逐行绑定会叠绑）
            _bindPlanRowsHost(containerEl);
        }

        function clearStreaming() {
            var listEl = _byId('listId');
            if (!listEl) return;
            var stale = listEl.querySelectorAll('.ae-agent-message-streaming');
            for (var s = 0; s < stale.length; s++) {
                if (stale[s].parentNode) stale[s].parentNode.removeChild(stale[s]);
            }
            // 同步清理残留的流式/已定形思考气泡（异常中断、stop 等场景）
            var staleR = listEl.querySelectorAll('.ae-agent-reasoning-streaming, .ae-agent-reasoning-finalized');
            for (var r = 0; r < staleR.length; r++) {
                if (staleR[r].parentNode) staleR[r].parentNode.removeChild(staleR[r]);
            }
            _lastFinalizedReasoning = null;
            // 重置流式渲染 rAF 与 token 缓冲，避免下轮复用陈旧句柄/残留内容
            if (_reasoningFlushRaf) { cancelAnimationFrame(_reasoningFlushRaf); _reasoningFlushRaf = 0; }
            if (_tokenFlushRaf) { cancelAnimationFrame(_tokenFlushRaf); _tokenFlushRaf = 0; }
            _reasoningBuf = [];
            _tokenBuf = [];
            // 取消在途的分批渲染（token 失效后 rAF 回调直接 return）
            _renderBatchToken++;
            // 分批进行态与活尾部登记一并复位（批次已取消，登记失效）
            _batchActive = false;
            _liveTailEls = [];
            _scheduleFollow();  // 气泡被摘除会让内容变矮：跟随中重新贴底（非跟随时不动）
        }

        // 增量追加一条「本地消息」（如 /help 帮助文本）：只进 state.messages 显示，不进 contextManager。
        // 关键：不走全量 renderMessages——那样会移除在途流式气泡造成闪烁。
        // 改为直接 insertBefore 流式气泡（若有），并 _renderedCount++ 对齐 state.messages，
        // 后续 renderMessages 增量不会重复渲染这条，流式气泡也原位保留。
        function appendLocalMessage(role, text) {
            var listEl = _byId('listId');
            if (!listEl) return;
            var item = document.createElement('div');
            item.className = 'ae-agent-message ' + (role || 'assistant');
            var body = document.createElement('div');
            body.className = 'ae-agent-message-body';
            // 本地帮助文本也走 markdown 渲染，保持样式一致
            var md = global.AEAgentApp && global.AEAgentApp.markdown;
            if (md && typeof md.render === 'function') {
                body.innerHTML = md.render(text || '');
            } else {
                body.textContent = text || '';
            }
            _linkifyLocalPaths(body);
            item.appendChild(body);
            var streamEl = listEl.querySelector('.ae-agent-message-streaming');
            if (streamEl) {
                listEl.insertBefore(item, streamEl);
            } else {
                // 无在途流式气泡时同样要避开子 Agent 卡片（卡片恒在列表尾部）
                var cardAnchorL = _subagentAnchor(listEl);
                if (cardAnchorL) listEl.insertBefore(item, cardAnchorL);
                else listEl.appendChild(item);
            }
            // 分批渲染进行中登记为活尾部，防被后续批次帧的历史消息埋进中间
            if (_batchActive) _registerLiveTail(item);
            _renderedCount++;
            // 本地消息由用户动作产生（/help、/goal 回执等）：语义是「我要看最新」，
            // 恢复跟随并回底（含窗口化挂载的窗口推进）。
            scrollListToBottom(listEl, false);
        }

        // 强制滚动到消息列表底部（用户发送消息时调用）。
        // 与渲染路径的条件滚动不同：发送动作意味着用户意图查看回复，
        // 即使正在上滑查看历史也应拉回底部——否则随后弹出的"思考过程"UI
        // 因不贴近底部而跳过自动滚动，用户看不到新内容。
        // 走 scrollListToBottom：历史浏览模式下需先推进挂载窗口到最新 CAP 条，
        // 直接 scrollTop = scrollHeight 只会停在挂载窗口底而非会话底。
        function scrollToBottom() {
            var listEl = _byId('listId');
            if (!listEl) return;
            scrollListToBottom(listEl, false);
        }

        // view 拆除：进出团队时拆/重建 view 的收尾。
        // 只解绑**本实例**绑的事件/观察者/浮层，不销毁 index.html 的静态共享元素（模块 unmount
        // 规则：列表/状态栏/顶栏节点属于骨架，删了重进模块就永久丢失）。
        function destroy() {
            _unbindMountWindow();
            unbindTokenPopover();
            _msgActionHandlers = null;
            // 在途分批渲染与流式 token flush：只解绑事件不够——已排队的 rAF 仍会
            // 在销毁后跑，旧回调会往列表写历史消息/流式文本（重建 view 后表现为重复或错位内容）。
            // 复用 clearStreaming 的取消方式：作废批次 token + 取消两个 flush rAF + 清缓冲。
            _renderBatchToken++;
            if (_reasoningFlushRaf) {
                try { cancelAnimationFrame(_reasoningFlushRaf); } catch (_) { /* 无 rAF 环境 */ }
                _reasoningFlushRaf = 0;
            }
            if (_tokenFlushRaf) {
                try { cancelAnimationFrame(_tokenFlushRaf); } catch (_) { /* 无 rAF 环境 */ }
                _tokenFlushRaf = 0;
            }
            _reasoningBuf = [];
            _tokenBuf = [];
            if (_tokenAnimState.rafId !== null) {
                try { cancelAnimationFrame(_tokenAnimState.rafId); } catch (_) { /* 无 rAF 环境 */ }
                _tokenAnimState.rafId = null;
            }
            _pendingTransitionRestore = [];
            _batchActive = false;
            _liveTailEls = [];
            _lastFinalizedReasoning = null;
            // 子 Agent 内联卡片是**本 view 的**活元素（声明见上）：实例销毁后不再有归位者，
            // 节点从列表里摘掉，避免重建后的新 view 在尾部留着上一条 runtime 的卡片。
            for (var i = 0; i < _subagentCardEls.length; i++) {
                var el = _subagentCardEls[i];
                if (el && el.parentNode) el.parentNode.removeChild(el);
            }
            _subagentCardEls = [];
            _subagentCardIndex = {};
            _renderedCount = 0;
        }

        return {
            getDom: getDom,
            // 拆除：解绑 scroll / 媒体 / ResizeObserver / 挂载窗口 / 消息动作 / token 浮层
            destroy: destroy,
            renderMessages: renderMessages,
            setBusy: setBusy,
            replayBusy: replayBusy,
            clearStatusChrome: clearStatusChrome,
            setMode: setMode,
            updateTokenStats: updateTokenStats,
            // 强制按本 view 的当前记录重绘（切模式 / 切 lane / 关团队后的镜像残留自愈）
            refreshTokenStats: refreshTokenStats,
            // 顶栏用量行浮层的数据源（团队模式：当前 lane 的快照由 bootstrap 现取；见
            // resolveTokenStatsSnapshot 与 getTokenStatsSnapshot 上方注释）
            getTokenStatsSnapshot: getTokenStatsSnapshot,
            clearInput: clearInput,
            getInput: getInput,
            appendToken: appendToken,
            appendReasoningToken: appendReasoningToken,
            finalizeReasoningStream: finalizeReasoningStream,
            clearStreaming: clearStreaming,
            resetRenderedCount: resetRenderedCount,
            appendLocalMessage: appendLocalMessage,
            // 子 Agent 内联卡片：发起者 lane 的消息流里按 id 复用节点
            upsertSubagentCard: upsertSubagentCard,
            removeSubagentCard: removeSubagentCard,
            scrollToBottom: scrollToBottom,
            appendToolProgress: appendToolProgress,
            replaceToolProgressWithResult: replaceToolProgressWithResult,
            removeToolProgress: removeToolProgress,
            appendToolConfirm: appendToolConfirm,
            // 提问工具（askUser）的输入区问答面板（结算/恢复输入区在 settle 内完成）
            appendAskUser: appendAskUser,
            markToolProgressRunning: markToolProgressRunning,
            markToolRejected: markToolRejected,
            markToolRevisionRequested: markToolRevisionRequested,
            renderPlanToSidebar: renderPlanToSidebar,
            setMessageActionHandlers: setMessageActionHandlers,
            // 顶栏 token 浮层的迁移绑定：团队档由 bootstrap 把当前 lane 的
            // view 绑到共享的顶栏用量元素上；换 lane 时先 unbind 旧的再 bind 新的。
            bindTokenPopover: bindTokenPopover,
            unbindTokenPopover: unbindTokenPopover,
            // 切 lane 的短暂提示（实现与契约见 flashStatus 上方注释）
            flashStatus: flashStatus
        };
    }

    // ── 计划行详情浮层（Agent 模式左抽屉的计划行与团队任务行对齐）────────
    // 行上的描述只有一行（CSS ellipsis，长描述看不全）——点击行在右侧弹浮层看全文与状态，
    // 结构/关闭语义与 teamUI 的团队任务行浮层同一套。浮层挂 body（fixed），不受左抽屉裁剪；
    // 模块级单例（团队三条 lane 的 view 共享）。description 来自模型写入的计划，一律 textContent。
    var PLAN_DETAIL_GAP = 8;
    var _planDetail = null;            // 浮层节点（同一时刻最多一个）
    var _planDetailAnchor = null;      // 当前浮层对应的行节点（再点同一行 = 关闭）
    var _planDetailDoc = null;         // 已绑关闭监听的 document（同一 document 只绑一次）
    var _planDetailResizeBound = false; // window resize 关闭监听的幂等位

    // 行状态按类名判定：done 优先（渲染时两类不会同挂，这里仍以 done 为准）。
    function _planStatusOfRow(rowEl) {
        var cls = ' ' + String((rowEl && rowEl.className) || '') + ' ';
        if (cls.indexOf(' done ') >= 0) return 'done';
        if (cls.indexOf(' running ') >= 0) return 'running';
        return 'pending';
    }

    // 状态文案单源在 team/taskBoard.js（加载晚于本文件）⇒ 运行期惰性读；缺失返回空串，
    // 标题不再拼状态段（生产环境 taskBoard 无条件加载，运行时必有文案；空串只出现在单测桩）。
    function _planStatusText(status) {
        var team = global.AEAgentTeam;
        var map = (team && team.TASK_STATUS_TEXT) || null;
        return (map && map[status]) ? map[status] : '';
    }

    // 编号/描述从行节点现读（与 renderPlanToSidebar 的渲染同源），不重算计划。
    function _planDataOfRow(rowEl) {
        if (!rowEl || !rowEl.children || rowEl.children.length < 2) return null;
        var numText = String((rowEl.children[0] && rowEl.children[0].textContent) || '');
        numText = numText.replace(/\.\s*$/, '').replace(/^\s+|\s+$/g, '');
        var status = _planStatusOfRow(rowEl);
        return {
            number: numText,
            description: String((rowEl.children[1] && rowEl.children[1].textContent) || ''),
            status: status,
            statusText: _planStatusText(status)
        };
    }

    // 精确类名 token 匹配（' ' + className + ' ' 上找）：别把 plan-sidebar-num/-desc 当行。
    function _isPlanRow(n) {
        var cls = ' ' + String((n && n.className) || '') + ' ';
        return cls.indexOf(' plan-sidebar-step ') >= 0;
    }

    function _findPlanRow(node, host) {
        var n = node;
        while (n && n !== host) {
            if (_isPlanRow(n)) return n;
            n = n.parentNode;
        }
        return null;
    }

    // 位置：行右侧优先；右侧/下方放不下时夹到视口内。取不到 rect/尺寸时给固定落点
    //（宁可在固定位置显示，不要不显示——单测假 DOM、节流窗口即取不到尺寸）。
    function _positionPlanDetail(pop, anchor) {
        var rect = null;
        try {
            rect = (anchor && typeof anchor.getBoundingClientRect === 'function') ? anchor.getBoundingClientRect() : null;
        } catch (_) { rect = null; }
        if (!rect) {
            pop.style.left = '320px';
            pop.style.top = '120px';
            return;
        }
        var w = (pop.offsetWidth && pop.offsetWidth > 0) ? pop.offsetWidth : 360;
        var h = (pop.offsetHeight && pop.offsetHeight > 0) ? pop.offsetHeight : 240;
        var vw = (typeof global.innerWidth === 'number' && global.innerWidth > 0) ? global.innerWidth : 0;
        var vh = (typeof global.innerHeight === 'number' && global.innerHeight > 0) ? global.innerHeight : 0;
        var left = rect.right + PLAN_DETAIL_GAP;
        if (vw && left + w > vw - PLAN_DETAIL_GAP) left = Math.max(PLAN_DETAIL_GAP, vw - w - PLAN_DETAIL_GAP);
        var top = rect.top;
        if (vh) top = Math.max(PLAN_DETAIL_GAP, Math.min(top, vh - h - PLAN_DETAIL_GAP));
        pop.style.left = Math.round(left) + 'px';
        pop.style.top = Math.round(top) + 'px';
    }

    // 同一 document 只绑一次（捕获阶段）。点空白关闭用 mousedown：打开那一下发生在浮层创建前，
    // 不会自己把自己关掉；点在锚点行上也不关，交给行自己的 click 做开/关切换。
    function _bindPlanDetailDoc(d) {
        if (!d || typeof d.addEventListener !== 'function' || _planDetailDoc === d) return;
        _planDetailDoc = d;
        d.addEventListener('mousedown', function (e) {
            if (!_planDetail) return;
            var t = e && e.target;
            if (_planDetail.contains && _planDetail.contains(t)) return;
            if (_planDetailAnchor && _planDetailAnchor.contains && _planDetailAnchor.contains(t)) return;
            closePlanDetail();
        }, true);
        d.addEventListener('keydown', function (e) {
            if (!e || (e.key !== 'Escape' && e.key !== 'Esc')) return;
            closePlanDetail();
        }, true);
        // 滚动/尺寸变化后锚点坐标失效：直接关闭，避免浮层与行脱开；
        // 浮层**内部**的滚动（长正文超出 max-height）不算。
        d.addEventListener('scroll', function (e) {
            if (!_planDetail) return;
            var t = e && e.target;
            if (_planDetail.contains && _planDetail.contains(t)) return;
            closePlanDetail();
        }, true);
        if (!_planDetailResizeBound && typeof global.addEventListener === 'function') {
            _planDetailResizeBound = true;
            global.addEventListener('resize', closePlanDetail);
        }
    }

    // 幂等：没有浮层时只清状态。
    function closePlanDetail() {
        if (_planDetail && _planDetail.parentNode) {
            try { _planDetail.parentNode.removeChild(_planDetail); } catch (_) { /* 已被摘掉 */ }
        }
        _planDetail = null;
        _planDetailAnchor = null;
    }

    function _openPlanDetail(anchor, data) {
        var d = global.document;
        if (!d || typeof d.createElement !== 'function' || !d.body || typeof d.body.appendChild !== 'function') return false;
        if (_planDetail && _planDetailAnchor === anchor) {   // 同一行再点 = 关闭
            closePlanDetail();
            return false;
        }
        closePlanDetail();
        var pop = d.createElement('div');
        pop.className = 'ae-agent-popover ae-plan-detail';
        if (pop.setAttribute) pop.setAttribute('role', 'dialog');
        var title = d.createElement('span');
        title.className = 'popover-title ae-plan-detail-title';
        title.textContent = AEI18n.t('步骤 {n}', { n: data.number || '?' }) + (data.statusText ? ' · ' + data.statusText : '');
        var desc = d.createElement('div');
        desc.className = 'ae-plan-detail-desc';
        desc.textContent = data.description || AEI18n.t('（无描述）');
        pop.appendChild(title);
        pop.appendChild(desc);
        d.body.appendChild(pop);
        _planDetail = pop;
        _planDetailAnchor = anchor;
        _positionPlanDetail(pop, anchor);
        _bindPlanDetailDoc(d);
        return true;
    }

    function _activatePlanRow(rowEl) {
        var data = _planDataOfRow(rowEl);
        if (!data) return;
        _openPlanDetail(rowEl, data);
    }

    // 行点击/键盘入口：容器上**委托一次**（行节点随每次重渲替换，逐行绑会漏绑/叠绑）。
    function _bindPlanRowsHost(host) {
        if (!host || host.__aePlanRowsBound || typeof host.addEventListener !== 'function') return host;
        host.__aePlanRowsBound = true;
        host.addEventListener('click', function (e) {
            var rowEl = _findPlanRow(e && e.target, host);
            if (!rowEl) return;
            _activatePlanRow(rowEl);
        });
        host.addEventListener('keydown', function (e) {
            var key = e && e.key;
            if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
            if (e.repeat) return;
            var rowEl = _findPlanRow(e && e.target, host);
            if (!rowEl) return;
            if (e.preventDefault) e.preventDefault();
            _activatePlanRow(rowEl);
        });
        return host;
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createView = createAgentView;
    global.AEEngine.closePlanDetail = closePlanDetail;
})(window);
