(function (global) {
    'use strict';
    // 预览区快照守卫：LLM「先读后写」链路的陈旧内容防护。
    //
    // 问题形态：LLM 读过预览区（get_current_script / get_current_shader）之后、提交
    // （submit_script / submit_shader / submit_js_effect）之前，用户可能手改了预览区
    // （直接编辑、Tab 缩进、从脚本树加载文件等）。提交按**旧内容**做局部合并或整份覆盖，
    // 会把用户的改动静默吃掉——双方在同一块文本上写，只有一方知道对方存在。
    //
    // 机制：读取工具成功读到内容即留存快照；写入工具落笔前比对「当前预览区内容」与
    // 快照，不一致 → 拒绝写入并回喂「先重新读取再提交」；**从未读过**（含空预览区——
    // 「写前必读，就算是首次提交也要」）→ 同样
    // 拒绝，回喂「先读取」。空预览区不再放行：面板重载会回填草稿（previewDraft/shaderDraft），
    // 空与否须以读取结果为准；空读同样留账，读一次即解。
    // 写入成功后按**实际落库内容**刷新快照（script 侧写入要过 cleanScriptContent 规整，
    // 不能按提交原文记，故由调用方读回预览区后回填）。
    //
    // **按（调用方，预览区）分账**：快照分调用方记账，一个调用方的
    // 写入只刷新自己的账，不会替另一个调用方「洗白」其陈旧读。面板内 Agent 与外接客户端
    // 同显一个预览区时，外接写完并不代表面板侧 LLM 就该按它几分钟前读到的旧内容落笔——
    // 面板侧该被拦的照样拦（反之亦然）。调用方身份来自 toolExecutor 透传的执行上下文
    // callerId（外接 dispatch 传 'ext:<clientId>'，面板内为空串）。
    //
    // 与已删除的外接「预览区覆盖保护」的区别：
    //   ① 拒绝是给 LLM 的工具结果（可自纠：读一次后重提），不是给用户的 elicitation
    //      阻断，外接无人值守链路不会因此卡死（外接覆盖保护的阻断主因）；
    //   ①b 不拿「进入模式时的基线」比对遗留内容：只在「本调用方从未读过预览区、且预览区
    //      非空」时拦一次（读一次即解，空预览区放行）。外接覆盖保护的误报主因是把「手改」与
    //      「遗留旧内容 / 面板内模式写入」混为一谈——本守卫不比基线，故无此误报。
    //
    // **按对话分账**：账挂在「对话」上，而不是挂在「当前时刻」——
    // 面板内对话键 = （模式，会话），由 controller 在会话/模式切换成功路径经 setConversation
    // 设入（每个模式各有一套会话上下文，模式不进键会把两个 LLM 上下文当同一个）；外接调用方
    // 恒落独立桶（外接有自己的对话，面板切不切会话与它无关）。切走再切回：内容没变仍认
    // （不重复罚读），内容被改过照常按 STALE_PREVIEW 拦。桶上限 8，LRU 淘汰最久未用——
    // **空对话不建桶、不占配额**（只有真正读过/写过的对话才有账，切换本身不挤掉别人的账）。
    //
    // **按 lane 分槽**：团队模式三条 lane
    // 各跑一个工具循环、并行读写同一个预览区，单槽会让三条 lane 的账互相顶替——
    // lane A 的写入刷新了 lane B 的读账（B 按几分钟前的旧内容落笔不再被拦），或 lane A 的
    // 读账被 lane C 的会话指针带走到别的桶（A 自己反而被判"从未读过"）。分槽两处一起做：
    //   · **会话指针按 lane 存**（activeConvs，按 lane 各一份）：每条 lane 有自己的
    //     「当前对话」，一条 lane 的会话/模式切换不再搬动别条 lane 的账；
    //   · **槽位键带 lane 命名空间**：即使两条 lane 恰有同一个对话键（团队模式下导演与
    //     AE 执行同槽位、共用同一个团队会话 id ⇒ 键相同），账也各记各的。
    // 所有入口（recordRead/recordWrite/get/check/setConversation/getConversation/clear）
    // 末位支持可选 laneId；省略/空串 ⇒ 缺省 lane（'agent'），单 Agent 路径读写的一直是同一
    // 组槽与同一个指针，行为与分槽前逐字节一致。forLane(laneId) 返回绑定该 lane 的视图，
    // 供 scriptTools / shaderTools 的回退点一次绑定、调用点不改。
    //
    // 范围：面板内存态，不落盘、不跨面板重载。注意重载后预览区**可能非空**（草稿回填
    // previewDraft / shaderDraft），而 store 已空 ⇒ 首次写入按「未读 + 非空」拦一次，
    // 读一次即解（接入前的旧行为是"无快照＝放行"）。
    // store 缺席（旧装配 / 测试沙箱未载本文件）时守卫缺席，行为与接入前一致。
    //
    // hash 为 FNV-1a 32 位（8 位十六进制），与 shaderTools.js 的 hashText 同一算法
    // ——两处必须保持一致，否则 get_current_shader 返回的 hash 与拒绝结果里的
    // readHash/currentHash 无法对照。
    // 调用方缺省 id：面板内 Agent（含 handler 直调路径——测试/未显式传 callerId 的调用）。
    // 外接 dispatch 经 toolExecutor 透传 'ext:<clientId>'，与面板内互不顶替对方的快照。
    var DEFAULT_WRITER = 'panel';
    var DEFAULT_LANE = 'agent';     // 缺省 lane：不传 laneId 的调用（单 Agent 路径 / 旧装配）
    var DEFAULT_CONV = 'default';   // 未调 setConversation 时的常量桶（旧装配 / 测试沙箱）
    var EXT_CONV = 'ext';           // 外接调用方恒落此桶：它有独立对话，不随面板会话/模式切换
    var EXT_LANE = 'ext';           // 外接调用方的槽位命名空间（不受 lane 绑定影响，见 laneNsOf）
    var MAX_CONVS = 8;              // 桶数上限（LRU 淘汰最久未用；各 lane 当前桶与外接桶不淘汰）

    // 外接调用方身份 = toolExecutor 透传的 callerId（'ext:<clientId>'），与面板内分账同源
    function isExternalWriter(writer) { return /^ext:/.test(String(writer || '')); }

    function hashText(s) {
        var str = String(s == null ? '' : s);
        var h = 0x811c9dc5;
        for (var i = 0; i < str.length; i++) {
            h = (h ^ str.charCodeAt(i)) >>> 0;
            h = Math.imul(h, 16777619) >>> 0;
        }
        var hex = h.toString(16);
        while (hex.length < 8) hex = '0' + hex;
        return hex;
    }

    function countLines(s) {
        var str = String(s == null ? '' : s);
        return str ? str.split(/\r?\n/).length : 0;
    }

    function createPreviewSnapshotStore() {
        // 桶键 = 对话键：面板内由 controller 在会话/模式切换成功路径设为 "<模式>:<会话>"；
        // 外接调用方恒落 EXT_CONV（不受面板切换影响）。槽位键 = "<lane>\0<调用方>\0<预览区>"。
        // 调用方缺省面板内（'panel'）：handler 直调（测试）、面板内未显式传 callerId 的路径
        // 都落这里；外接 dispatch 传 'ext:<clientId>'。lane 缺省 'agent'（单 Agent 路径）。
        var convs = {};              // 对话键 -> { slots: { <lane>\0<调用方>\0<区>: {content,hash,at,lane,area} }, usedAt }
        var activeConvs = {};        // laneId -> 该 lane 的当前对话键（只登记设过的 lane）
        var clock = 0;

        function laneOf(laneId) {
            return (typeof laneId === 'string' && laneId) ? laneId : DEFAULT_LANE;
        }
        // 槽位命名空间：外接调用方恒落 EXT_LANE——lane 维度对它是常量，不因"哪个 lane 的
        // 工具实例调它"而变（外接有独立对话，与分 lane 无关，行为与分槽前一致）；
        // 面板内按 lane 分。
        function laneNsOf(laneId, writer) {
            return isExternalWriter(writer) ? EXT_LANE : laneOf(laneId);
        }
        // 本 lane 的会话指针：设过用本 lane 的；没设过则继承缺省槽的指针（团队模式下三条 lane
        // 共用同一个团队会话、整组切换 ⇒ 未单独设过指针的 lane 跟着缺省指针走，不会各自停在
        // 旧桶上；lane 之间的**账本**隔离由槽位键承担，不依赖指针）。
        function activeConvFor(laneId) {
            var lane = laneOf(laneId);
            if (Object.prototype.hasOwnProperty.call(activeConvs, lane)) return activeConvs[lane];
            if (Object.prototype.hasOwnProperty.call(activeConvs, DEFAULT_LANE)) return activeConvs[DEFAULT_LANE];
            return DEFAULT_CONV;
        }
        function slotKey(area, writer, laneNs) {
            return String(laneNs) + '\u0000' + String(writer || DEFAULT_WRITER) + '\u0000' + String(area == null ? '' : area);
        }
        // 面板内按（本 lane 的）当前对话记账；外接恒落 EXT_CONV
        function convOf(writer, laneId) { return isExternalWriter(writer) ? EXT_CONV : activeConvFor(laneId); }
        function bucket(conv, create) {
            var b = convs[conv];
            if (!b && create) { b = convs[conv] = { slots: {}, usedAt: 0 }; }
            return b || null;
        }
        // 该桶是否是"在用桶"（某个 lane 的当前桶，或外接桶）——淘汰时保留
        function isProtectedConv(conv) {
            if (conv === EXT_CONV) return true;
            var lanes = Object.keys(activeConvs);
            for (var i = 0; i < lanes.length; i++) {
                if (activeConvs[lanes[i]] === conv) return true;
            }
            return false;
        }
        // 记一次使用并做上限淘汰（只淘汰非在用桶里最久未用的那个）
        function touch(conv) {
            var b = bucket(conv, true);
            b.usedAt = ++clock;
            var keys = Object.keys(convs);
            if (keys.length <= MAX_CONVS) return;
            var victim = null, min = Infinity;
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (isProtectedConv(k)) continue;
                if (convs[k].usedAt < min) { min = convs[k].usedAt; victim = k; }
            }
            if (victim) delete convs[victim];
        }
        function record(area, content, writer, laneId) {
            var laneNs = laneNsOf(laneId, writer);
            var conv = convOf(writer, laneId);
            var b = bucket(conv, true);
            var c = String(content == null ? '' : content);
            b.slots[slotKey(area, writer, laneNs)] = {
                content: c, hash: hashText(c), at: Date.now(),
                lane: laneNs, area: String(area == null ? '' : area)
            };
            touch(conv);
        }
        var api = {
            // 读取工具成功读到时调用（含读到空内容：空快照语义＝「本对话已知当前为空」）
            recordRead: function (area, content, writer, laneId) { record(area, content, writer, laneId); },
            // 写入工具成功写入后调用。传实际落库内容（调用方读回预览区取值）
            recordWrite: function (area, content, writer, laneId) { record(area, content, writer, laneId); },
            get: function (area, writer, laneId) {
                var b = bucket(convOf(writer, laneId), false);
                if (!b) return null;
                return b.slots[slotKey(area, writer, laneNsOf(laneId, writer))] || null;
            },
            // 对话切换（会话/模式变更时由 controller 调用）：换桶＝上一个对话的读取不再替本对话
            // 背书。空/缺省键回落常量桶。**只登记已存在的桶、不新建**——空对话没有"账"，
            // 不该占 LRU 配额（否则连点几个会话就会把别人真实读过的账挤掉，白白多读一次）；
            // 新桶在首次 record 时建立。laneId 缺省 ⇒ 只搬动缺省 lane 的指针（单 Agent 路径
            // 唯一的指针，行为与分槽前一致）；团队模式由各 lane 的 controller 传自己的 laneId，
            // 互不搬动对方的账。
            setConversation: function (key, laneId) {
                var conv = (key == null || String(key) === '') ? DEFAULT_CONV : String(key);
                activeConvs[laneOf(laneId)] = conv;
                if (convs[conv]) touch(conv);
                return conv;
            },
            getConversation: function (laneId) { return activeConvFor(laneId); },
            // 清账：不传 laneId 时与分槽前同语义——指定 area 清掉所有对话（及所有 lane）下该区的
            // 账，不传 area 清全部（含所有 lane 的会话指针复位）。传 laneId 时只清该 lane 的账
            // （该 lane 所有对话里该区的槽；不传 area 则清该 lane 的全部区），并复位该 lane 的指针。
            // 清空后不留空桶——空桶不该继续占 LRU 配额（与 setConversation 不建桶同一口径）。
            clear: function (area, laneId) {
                var lane = (typeof laneId === 'string' && laneId) ? laneId : '';
                if (area == null && !lane) { convs = {}; activeConvs = {}; return; }
                Object.keys(convs).forEach(function (c) {
                    var slots = convs[c].slots;
                    Object.keys(slots).forEach(function (k) {
                        var s = slots[k];
                        if (lane && s.lane !== lane) return;
                        if (area != null && s.area !== String(area)) return;
                        delete slots[k];
                    });
                    if (!Object.keys(slots).length) delete convs[c];
                });
                if (lane) delete activeConvs[lane];
            },
            hashText: hashText,
            // 写前比对（按 lane + 调用方）：ok=true（与快照一致）可写；
            // ok=false 两种拒绝——调用方据此拒绝写入并回喂对应指引：
            //   STALE_PREVIEW：读过，但当前内容已变（用户手改 / 他处写入）
            //   READ_REQUIRED：本调用方从未读过（含空预览区——写前必读，
            //     首次提交也要读；currentEmpty 供调用方选"当前为空/已有内容"文案）
            check: function (area, current, writer, laneId) {
                var cur = String(current == null ? '' : current);
                var b = bucket(convOf(writer, laneId), false);
                var snap = b ? b.slots[slotKey(area, writer, laneNsOf(laneId, writer))] : null;
                if (!snap) {
                    return {
                        ok: false,
                        code: 'READ_REQUIRED',
                        currentEmpty: cur.trim() === '',
                        currentHash: hashText(cur),
                        currentLines: countLines(cur)
                    };
                }
                if (snap.content === cur) return { ok: true, code: 'FRESH' };
                return {
                    ok: false,
                    code: 'STALE_PREVIEW',
                    readHash: snap.hash,
                    readAt: snap.at,
                    readLines: countLines(snap.content),
                    currentHash: hashText(cur),
                    currentLines: countLines(cur)
                };
            },
            // lane 视图（团队模式的唯一接入口）：绑定 laneId 后，本视图上的读写都带该 lane。
            // **不是每 lane 一个单例**——三份互不可见的账本会让"同一个预览区"读出三种真相，
            // 且 panel 侧的 setConversation 只会更新其中一份（另外两份永远停在旧桶）。
            // 视图是轻量对象、不缓存（每次调用新建，随取随用，不构成无上限缓存）。
            // laneId 缺省/空串 → 原样返回本实例（单 Agent 路径零包装，行为逐字节不变）。
            forLane: function (laneId) {
                var lane = laneOf(laneId);
                if (lane === DEFAULT_LANE) return api;
                return {
                    laneId: lane,
                    recordRead: function (area, content, writer) { return api.recordRead(area, content, writer, lane); },
                    recordWrite: function (area, content, writer) { return api.recordWrite(area, content, writer, lane); },
                    get: function (area, writer) { return api.get(area, writer, lane); },
                    check: function (area, current, writer) { return api.check(area, current, writer, lane); },
                    setConversation: function (key) { return api.setConversation(key, lane); },
                    getConversation: function () { return api.getConversation(lane); },
                    clear: function (area) { return api.clear(area, lane); },
                    hashText: hashText,
                    forLane: function () { return api.forLane(lane); }
                };
            }
        };
        return api;
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createPreviewSnapshotStore = createPreviewSnapshotStore;
    // 单例：面板内 script/shader 两族读写工具共用同一实例（按 area + lane 分账），
    // scriptTools / shaderTools 惰性解析（测试可注入自建实例隔离）。
    // **守卫按 lane 判定**：lane 视图一律从这一个实例派生（forLane / previewSnapshotFor），
    // 不新增每 lane 的单例槽——否则三条 lane 各拿一份账本，同一个预览区的"读到什么"会分叉，
    // 且 controller 的 setConversation 只更新其中一份。
    if (!global.AEEngine.previewSnapshot) {
        global.AEEngine.previewSnapshot = createPreviewSnapshotStore();
    }
    // lane 视图解析器（回退点用）：当前单例支持 forLane 时返回绑定该 lane 的视图，
    // 否则原样返回单例（旧装配/测试桩注入的 store 没有 forLane）。laneId 缺省 → 单例本身。
    global.AEEngine.previewSnapshotFor = function (laneId) {
        var ps = (global.AEEngine && global.AEEngine.previewSnapshot) || null;
        var lane = (typeof laneId === 'string' && laneId) ? laneId : '';
        if (ps && lane && typeof ps.forLane === 'function') return ps.forLane(lane);
        return ps;
    };
})(typeof global !== 'undefined' ? global : window);
