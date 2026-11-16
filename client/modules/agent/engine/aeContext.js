(function(global) {

    function _pad2(n) { return (n < 10 ? '0' : '') + n; }

    // 秒 -> 时间码 HH:MM:SS:FF（frameRate 可得时带帧号，否则仅 HH:MM:SS）。
    // 非法输入返回空串（调用方静默跳过）。
    function formatTimecode(seconds, frameRate) {
        if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '';
        var total = Math.floor(seconds);
        var hh = Math.floor(total / 3600);
        var mm = Math.floor((total % 3600) / 60);
        var ss = total % 60;
        var tc = _pad2(hh) + ':' + _pad2(mm) + ':' + _pad2(ss);
        var fps = Number(frameRate);
        if (fps > 0 && isFinite(fps)) {
            var ff = Math.floor((seconds - total) * fps);
            tc += ':' + _pad2(ff);
        }
        return tc;
    }

    // 活动合成行：无 currentTime 字段时输出逐字节不变（回归安全）。
    function formatActiveCompLine(ac) {
        if (!ac) return '';
        var line = 'Active comp: "' + ac.name + '" (' + ac.width + 'x' + ac.height + ', ' + ac.frameRate + 'fps, ' + Math.round(ac.duration) + 's';
        if (typeof ac.currentTime === 'number' && isFinite(ac.currentTime)) {
            var sec = Math.round(ac.currentTime * 100) / 100;
            var tc = formatTimecode(ac.currentTime, ac.frameRate);
            line += ', t=' + sec + 's' + (tc ? ' (' + tc + ')' : '');
        }
        line += ')';
        return line;
    }

    // 选中属性行：属性名 (matchName) (layerIndex=图层号)，超出截断部分带 (+N more)。
    // 无选中/字段缺失返回空串（静默跳过）。
    function formatSelectedPropsLine(ac) {
        if (!ac || !Array.isArray(ac.selectedProperties) || ac.selectedProperties.length === 0) return '';
        var items = [];
        for (var i = 0; i < ac.selectedProperties.length; i++) {
            var p = ac.selectedProperties[i];
            if (!p || !p.name) continue;
            var s = String(p.name);
            if (p.matchName && String(p.matchName) !== String(p.name)) s += ' (' + String(p.matchName) + ')';
            if (typeof p.layerIndex === 'number' && p.layerIndex > 0) s += ' (layerIndex=' + p.layerIndex + ')';
            items.push(s);
        }
        if (!items.length) return '';
        var total = Number(ac.selectedPropertiesTotal) || 0;
        var more = total > items.length ? ' (+' + (total - items.length) + ' more)' : '';
        return 'Selected props: ' + items.join(', ') + more;
    }

    // queryProject(target=project) 结果 → [AE Context] 行数组（纯函数，供单测）。
    function formatProjectInfoLines(projData) {
        var parts = [];
        if (!projData) return parts;
        if (projData.activeComposition) {
            var compLine = formatActiveCompLine(projData.activeComposition);
            if (compLine) parts.push(compLine);
            var propsLine = formatSelectedPropsLine(projData.activeComposition);
            if (propsLine) parts.push(propsLine);
        } else if (projData.compositionCount > 0) {
            parts.push('Project has ' + projData.compositionCount + ' comp(s), none active');
        }
        return parts;
    }

    // queryProject(target=browse) 结果 → 全项目合成数行（纯函数，供单测）。
    // totalComps 受 aeTools.jsx browseProject 的 TOTAL_HARD_LIMIT=200 递归扫描上限保护：
    // 截断时（truncated:true）它只是「已扫描前缀」的计数（该文件注释自认），不得当完整
    // 总数注给模型——用 ≥ 前缀 + 截断标注如实表述；未截断时输出逐字不变（回归安全）。
    function formatProjectTotalCompsLine(projData) {
        if (!projData || typeof projData.totalComps !== 'number' || projData.totalComps <= 0) return '';
        if (projData.truncated) {
            return 'Project has ≥' + projData.totalComps + ' comp(s) (truncated: 总条目超过扫描上限)';
        }
        return 'Project has ' + projData.totalComps + ' comp(s) total';
    }

    function createAeContext(config) {
        config = config || {};
        var toolExecutor = config.toolExecutor || null;
        // promptBuilder 不再使用：snapshot 拼到 system prompt 末尾会导致每次 gather() 后
        // 缓存前缀失效。改为暴露 getSnapshot()，由 controller 拼到当前轮 user 消息前缀，
        // system prompt 保持纯静态，缓存命中率大幅提升。
        //
        // ── 快照按 laneKey 分槽 ──────────────
        // 单槽在团队模式下会被三条 lane 互相顶替：导演 gather 完、AE 执行 lane 也 gather 一次，
        // 后者把前者的快照覆盖掉，随后导演拼上下文时读到的是执行 lane 的工程/选中信息。
        // 分槽键是 laneKey（= lane.id），**不是 moduleIds**：laneKey 只做缓存键，绝不参与作用域
        // 判定（理由见 gather 的注释）。缺省槽 'agent' 承接不传 laneKey 的调用方——单 Agent
        // 路径下所有 gather/getSnapshot 都落这一个槽，行为与分槽前逐字节一致。
        // 槽数有界：lane 集合封闭（director / ae-exec / glsl）+ 缺省槽，每槽就一个字符串与一个
        // 身份记录，不随调用次数增长（不做无上限缓存）。
        var DEFAULT_LANE_KEY = 'agent';
        var EMPTY_SLOT = { snapshot: '', moduleId: null };
        var slots = {};   // laneKey -> { snapshot: string, moduleId: string|string[]|null }

        function _laneKeyOf(laneKey) {
            return (typeof laneKey === 'string' && laneKey) ? laneKey : DEFAULT_LANE_KEY;
        }
        // 取槽。create=false 时**不建槽**（读路径不造状态：getSnapshot 探测任何 lane 都不会
        // 让 slots 长出键）。create=true 只由 gather 使用——它本来就在写状态。
        function _slotOf(laneKey, create) {
            var k = _laneKeyOf(laneKey);
            if (!Object.prototype.hasOwnProperty.call(slots, k)) {
                if (!create) return EMPTY_SLOT;
                slots[k] = { snapshot: '', moduleId: null };
            }
            return slots[k];
        }
        // 身份归一：'agent' / ['agent','team'] → ['agent','team']；空/缺省 → []（= 未带身份）。
        function _idsOf(v) {
            var out = [];
            if (Array.isArray(v)) {
                for (var i = 0; i < v.length; i++) {
                    if (typeof v[i] === 'string' && v[i]) out.push(v[i]);
                }
                return out;
            }
            if (typeof v === 'string' && v) out.push(v);
            return out;
        }
        // 快照身份是否适用于本次询问。与分槽前同语义（单串对单串就是等值比较）：
        //   · 询问未带身份（moduleId 缺省：浮层/单测）→ 命中；
        //   · 快照产出时未带身份（旧调用方）→ 命中；
        //   · 两边都带身份 → 要求 **asked ⊆ produced**（询问方要的每一项都在产出方身份里）。
        // 为什么是「子集」而不是「有交集」（实测）：团队 lane 的身份都含公共成员
        // `'team'`，「有交集」会让 `['shader','team']` 的询问命中 `['agent','team']` 的产出
        // （实测：`getSnapshot(['shader','team'],'director')` 读到了 agent 槽的内容，len=126）
        // ——公共成员把互斥判据破了。子集语义下 `'shader' ∉ ['agent','team']` ⇒ 不命中；
        // 而同一身份族的 `'agent' ⊆ ['agent','team']` 仍命中（导演/执行与单 Agent 同族）。
        // glsl 的身份是 `['shader','team']`，不含 `'agent'` ⇒ 它不产出也不消费 agent 槽的快照。
        // 当前所有 getSnapshot 调用点的 laneKey 与身份同源（同一条 lane 自己的询问），不存在跨槽
        // 读取；若将来引入「用身份反查槽」的调用，需改为以 laneKey 相等为主判据（这里保持现状）。
        function _identityMatches(produced, asked) {
            var askedIds = _idsOf(asked);
            if (!askedIds.length) return true;
            var producedIds = _idsOf(produced);
            if (!producedIds.length) return true;
            for (var i = 0; i < askedIds.length; i++) {
                if (producedIds.indexOf(askedIds[i]) < 0) return false;
            }
            return true;
        }

        // gather(moduleIds, laneKey)：
        //   moduleIds = **工具身份**（'agent' / 'script' / 'shader'，或团队 lane 的集合
        //     ['agent','team'] / ['shader','team']），**原样**作为第三参透传给 toolExecutor，
        //     使三条查询走与模型同一套作用域校验（enabled + 模块禁用 + scope）。由此
        //     「注入 AE 快照 ⇔ 当前轮模块真的能读工程」是同一个判据，本文件不再另维护一份模式
        //     名单：queryProject 的 seed scope 限 agent/script，故**身份不含 `'agent'` 的轮次**
        //     （单 Agent 的 shader 档、团队 glsl lane）三条查询全被 ACCESS_DENIED 拦下（不触达 AE）
        //     → parts 为空 → 快照清空，工程/选中信息不进该轮上下文；身份含 `'agent'` 的轮次
        //     （单 Agent 的 agent/script 档，导演 / AE 执行 / 美术 lane）读到工程并注入自己的槽。
        //     用户在 AE Tools UI 改 scope 后注入行为自动跟随。
        //     不传 moduleIds 时 toolExecutor 跳过作用域检查（其既有约定），行为与本改动前一致
        //     ——单测/未知调用方沿用旧语义。
        //   laneKey = **快照分槽键**（团队 lane 的 laneKey/lane.id），只决定快照落在哪个槽；
        //     省略/空串 ⇒ 缺省槽（单 Agent 路径行为不变）。
        //
        // ⚠ 身份分离：`laneKey` **绝不参与**作用域判定，
        //    也**不得**拿它去顶替 moduleIds。原因不是风格：`toolExecutor.checkAccess` 对
        //    tool.scope.moduleIds 做的是**精确成员匹配**（shared/toolExecutor.js），而
        //    queryProject 等 seed 工具的 scope 里没有 lane 身份（'director' / 'ae-exec' /
        //    'glsl' 都不在），把 laneKey 当 moduleId 传 ⇒ 三条查询全被判 ACCESS_DENIED ⇒
        //    parts 为空 ⇒ **快照恒为空**（面板看似"没内容"，实际是权限拒绝被当成空工程）。
        //    同理 moduleIds 必须按**集合原样**传（不得降成单串、不得只取首个成员）：集合是
        //    lane 的合法作用域（如 ['agent','team']），成员匹配靠的就是它。
        //    一句话：集合合法性决定快照是否为空，laneKey 只决定它进哪个槽。
        //
        // 返回值 = 快照成因，供「当前选中」悬停浮层区分空快照的两种情况（bootstrap 用）：
        //   'injected'  读到内容，快照非空
        //   'no-access' 三条全没读成（作用域/启用被拒，或工具未注册）
        //   'empty'     读到了但工程无内容（无活动合成、无选中对象）
        //   'error'     通道异常
        async function gather(moduleIds, laneKey) {
            // 传给执行器的身份：**原引用原样透传**（字符串或集合都不动），laneKey 不混入。
            var execModuleIds = moduleIds;
            if (!toolExecutor || typeof toolExecutor.call !== 'function') return 'error';
            var okCount = 0;
            var failCount = 0;
            function _tally(r) {
                if (r && r.success) okCount++;
                else failCount++;
            }
            try {
                var parts = [];
                // 项目信息（target=browse 拿活动合成所在的项目结构概览；字段缺失时静默跳过）
                // queryProject 重新设计后无 target=project，改用 browse 获取项目结构。
                // depth=-1 全量递归，browse 侧统计 totalComps（全项目合成数，含文件夹内，
                // 受 TOTAL_HARD_LIMIT=200 防卡死保护，超大项目可能低估但不会误导数量级）。
                var projResult = await toolExecutor.call('queryProject', { target: 'browse', depth: -1, itemLimit: 30 }, execModuleIds);
                _tally(projResult);
                if (projResult && projResult.success && projResult.content) {
                    var projText = projResult.content.map(function(c) { return c.text || ''; }).join('');
                    try {
                        var projData = JSON.parse(projText);
                        // browse 返回 totalComps + truncated；截断时 totalComps 只是已扫描前缀的
                        // 计数（TOTAL_HARD_LIMIT=200），行文案带 ≥ 与截断标注（见纯函数注释）
                        var totalLine = formatProjectTotalCompsLine(projData);
                        if (totalLine) parts.push(totalLine);
                    } catch (_) {}
                }
                // 活动合成摘要（target=active：名称/尺寸/帧率/时长/时间指针/选中属性）。
                // formatProjectInfoLines 输出 Active comp 行 + Selected props 行。
                var activeResult = await toolExecutor.call('queryProject', { target: 'active' }, execModuleIds);
                _tally(activeResult);
                if (activeResult && activeResult.success && activeResult.content) {
                    var activeText = activeResult.content.map(function(c) { return c.text || ''; }).join('');
                    try {
                        var activeData = JSON.parse(activeText);
                        if (activeData && activeData.activeComposition) {
                            var compLines = formatProjectInfoLines(activeData);
                            for (var ci = 0; ci < compLines.length; ci++) parts.push(compLines[ci]);
                        }
                    } catch (_) {}
                }
                // 选中图层（target=selected + scope=timeline，新版 queryProject 协议）。
                // itemLimit 与「当前选中」引用路径（_readSelectedScope）同口径取 100：默认 30 会让
                // 大批量选中被静默截短——文本只列前 30 层，模型据此以为只选了 30 层。
                var selResult = await toolExecutor.call('queryProject', { target: 'selected', scope: 'timeline', itemLimit: 100 }, execModuleIds);
                _tally(selResult);
                if (selResult && selResult.success && selResult.content) {
                    var selText = selResult.content.map(function(c) { return c.text || ''; }).join('');
                    try {
                        var selData = JSON.parse(selText);
                        if (selData.items && selData.items.length > 0) {
                            var layerDescs = selData.items.map(function(l) {
                                var desc = '(layerIndex=' + l.layerIndex + ') "' + l.name + '" (' + (l.layerType || '?') + ')';
                                // 附带 compositionIndex，让 LLM 知道图层所在合成（多合成时必需）
                                if (typeof l.compositionIndex === 'number') desc += ' (compositionIndex=' + l.compositionIndex + ')';
                                return desc;
                            });
                            var selLine = 'Selected layers: ' + layerDescs.join(', ');
                            // 读 totalCount/hasMore：返回条数少于选中总数时显式标注，
                            // 不让「只列了前 N 层」看起来像「一共就 N 层」
                            var selTotal = (typeof selData.totalCount === 'number') ? selData.totalCount : selData.items.length;
                            if (selTotal > selData.items.length) {
                                selLine += '（共 ' + selTotal + ' 层，仅列前 ' + selData.items.length + ' 层）';
                            } else if (selData.hasMore === true) {
                                selLine += '（仅列前 ' + selData.items.length + ' 层，还有更多）';
                            }
                            parts.push(selLine);
                        } else {
                            parts.push('Selected layers: none');
                        }
                    } catch (_) {}
                }
                var slot = _slotOf(laneKey, true);
                slot.snapshot = parts.length > 0 ? '[AE Context]\n' + parts.join('\n') : '';
                slot.moduleId = moduleIds || null;
                if (parts.length > 0) return 'injected';
                // 一条都没读成 = 当前轮模块拿不到 queryProject（shader 轮的常态：scope 限 agent/script）
                return (failCount > 0 && okCount === 0) ? 'no-access' : 'empty';
            } catch (_) {
                var errSlot = _slotOf(laneKey, true);
                errSlot.snapshot = '';
                errSlot.moduleId = moduleIds || null;
                return 'error';
            }
        }

        // 读某一侧选中（scope: 'timeline' | 'project'）的原始条目——两个 gatherSelected* 的公共取数。
        // 返回 { status, items, message }：'ok' 带原始条目；'empty' 读到但无选中；
        // 'no-access' 当前轮模块拿不到 queryProject（ACCESS_DENIED：作用域/禁用被拒——模式决定的常态，
        // 与真失败区分）；'error' 通道异常或返回不可解析（message 带原文，面板要把真原因给用户看）。
        async function _readSelectedScope(scope, moduleId) {
            if (!toolExecutor || typeof toolExecutor.call !== 'function') {
                return { status: 'error', items: [], message: '工具通道不可用' };
            }
            try {
                var r = await toolExecutor.call('queryProject', { target: 'selected', scope: scope, itemLimit: 100 }, moduleId);
                var text = (r && r.content) ? r.content.map(function (c) { return c.text || ''; }).join('') : '';
                if (!r || !r.success) {
                    var deniedCode = (global.AE_LLM && global.AE_LLM.JSON_RPC_ERRORS
                        && global.AE_LLM.JSON_RPC_ERRORS.ACCESS_DENIED) || -32003;
                    var denied = !!(r && r.code === deniedCode);
                    return { status: denied ? 'no-access' : 'error', items: [], message: text || '读取选中失败' };
                }
                var data = null;
                try { data = JSON.parse(text); } catch (_) { data = null; }
                if (!data || typeof data !== 'object') return { status: 'error', items: [], message: '读取结果不可解析' };
                if (data.status !== 'success') return { status: 'error', items: [], message: data.message || '读取选中失败' };
                var items = Array.isArray(data.items) ? data.items : [];
                if (items.length === 0) return { status: 'empty', items: [], message: '' };
                return { status: 'ok', items: items, message: '' };
            } catch (e) {
                return { status: 'error', items: [], message: (e && e.message) ? String(e.message) : '读取选中异常' };
            }
        }

        // 读当前时间轴选中图层，返回**结构化引用项**（与 gather 的文本快照分开——引用要的是
        // 稳定键 id，不是给人看的行）。供「当前选中」点击建引用 chip 用。
        // 返回 { status, refs, message }：
        //   'ok'        读到选中，refs[] = { compositionId, compositionIndex, compositionName,
        //                                   layerId, layerIndex, name, layerType }
        //   'empty'     无活动合成/未选中任何图层
        //   'no-access' 当前轮模块拿不到 queryProject（作用域/禁用被拒）
        //   'error'     通道异常或返回不可解析
        // refs 里 id 可能是 0（该 AE 版本无 Layer.id/Item.id）——id 是否可用于建引用由调用方判定。
        async function gatherSelectedRefs(moduleId) {
            var res = await _readSelectedScope('timeline', moduleId);
            if (res.status !== 'ok') return { status: res.status, refs: [], message: res.message };
            var refs = res.items.map(function (l) {
                return {
                    compositionId: Number(l.compositionId) || 0,
                    compositionIndex: typeof l.compositionIndex === 'number' ? l.compositionIndex : 0,
                    compositionName: typeof l.compositionName === 'string' ? l.compositionName : '',
                    layerId: Number(l.layerId) || 0,
                    layerIndex: typeof l.layerIndex === 'number' ? l.layerIndex : 0,
                    name: l.name ? String(l.name) : '',
                    layerType: l.layerType ? String(l.layerType) : ''
                };
            });
            return { status: 'ok', refs: refs, message: '' };
        }

        // 读**项目面板**选中（scope=project），返回结构化引用项——「当前选中」点击引用合成/素材用。
        // 与 gatherSelectedRefs 同一套三态语义（no-access 区分口径见 _readSelectedScope）。
        // 返回 { status, refs, message }：
        //   'ok'    refs[] = { itemId, itemIndex, itemType, name }（itemType: 'comp'|'footage'|'folder'）
        //   'empty' 项目面板未选中任何对象
        // folder 条目也一并回传：跳过与提示口径在调用方（面板层）——本层只负责取数。
        // itemId 可能是 0（该 AE 版本无 Item.id），是否可建引用由调用方判定。
        async function gatherSelectedItemRefs(moduleId) {
            var res = await _readSelectedScope('project', moduleId);
            if (res.status !== 'ok') return { status: res.status, refs: [], message: res.message };
            var refs = res.items.map(function (o) {
                return {
                    itemId: Number(o.id) || 0,
                    itemIndex: typeof o.index === 'number' ? o.index : 0,
                    itemType: o.type ? String(o.type) : '',
                    name: o.name ? String(o.name) : ''
                };
            });
            return { status: 'ok', refs: refs, message: '' };
        }

        // 返回当前 snapshot 供 controller 拼到 user 消息前缀。
        // moduleId（可选）= 当前轮模块身份：与**该槽**里快照的产出身份不符时返回空（单串比等值、
        // 集合比交集，见 _identityMatches）。理由：不调 gather 的注入通道（执行中追加队列、
        // addUserMessage 等）直接复用上一次快照，身份过滤保证跨模式切换不会把旧模式的工程/
        // 选中信息带进新一轮（如切到 shader 模式后，上一 agent 轮留下的快照不得进 shader 轮）。
        // 不传 moduleId（浮层/单测）或快照产出时未带身份（旧调用方）时无条件返回，保持旧语义。
        // laneKey（可选）= 读哪个槽；省略/空串 ⇒ 缺省槽。团队模式下消费方（messageHelpers 拼
        // 上下文前缀）必须与本 lane 的 gather 传同一个 laneKey，否则读到缺省槽（空）——
        // 分槽后**不会**再用"最后写入的槽"兜底：那正是三条 lane 互相顶替的老毛病。
        function getSnapshot(moduleId, laneKey) {
            var slot = _slotOf(laneKey, false);
            if (!_identityMatches(slot.moduleId, moduleId)) return '';
            return slot.snapshot;
        }

        return { gather: gather, getSnapshot: getSnapshot, gatherSelectedRefs: gatherSelectedRefs, gatherSelectedItemRefs: gatherSelectedItemRefs };
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createAeContext = createAeContext;
    // 纯函数格式化助手（单测直接调用）
    global.AEEngine.formatAeContextProjectInfo = formatProjectInfoLines;
    global.AEEngine.formatAeContextTimecode = formatTimecode;
    global.AEEngine.formatAeContextProjectTotal = formatProjectTotalCompsLine;

})(window);
