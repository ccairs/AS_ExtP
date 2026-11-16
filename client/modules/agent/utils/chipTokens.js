// 输入区 chip token 语法单一真源：代码行号引用（L5-L34）、图层引用（@compId:layerId[,layerId…]）、
// 项目项引用（@:c123,f456 —— 项目面板里选中的合成/素材）与文件引用（@文件名）。
//
// 三处消费方共用本模块，避免语法副本漂移：
//   · app/main.js                          —— overlay 渲染 + 原子编辑扫描 + 发送解析
//   · engine/view.js                       —— 聊天框气泡里把 token 还原成标签
//   · engine/controller/chatViewHelpers.js —— 编辑重发的解析（与发送路径同款）
//
// 显示口径：两类引用 chip 都是「标签短、hover 给全文」——
//   图层 chip 标签 =「引用 N 个图层」（载荷 @compId:layerId…），名在会话缓存里供 hover；
//   项目项 chip 标签 =「引用 N 个对象」（载荷 @:c<id>,f<id>…），名与类型在会话缓存里供 hover；
//   文件 chip 标签 =「图片1 / 视频1 / 音频1 / 文件1」（类型 + 同类型内文本序编号，
//   fileKind/fileLabel 与本模块的 resolveFileTokens 同源），真名在 hover 浮层与气泡 title。
//   文件载荷仍是文件名（「名即身份」，见 buildFileToken）——显示层改造不动身份/解析链。
//
// 图层 token 的载荷**自描述**（compositionId / layerId 都在 token 文本里）：跨会话粘贴来的
// token 也解析得出 id，不依赖任何内存登记。引用按稳定键 id 定位（索引与名字会变），解析不出 id
// 的引用等于失效——所以自描述是硬要求，不是省事。**载荷里不放图层名**：名只用于显示，而 token
// 文本宽决定 chip 框宽（overlay 必须与 textarea 逐字对齐，见 main.js 的 overlay 注释），名一进
// 载荷，框宽就随用户起名在 100~330px 之间乱跳；名改由 main.js 的会话内缓存供 hover 显示。
// 项目项 token 同理（载荷只有类型字母 + Item.id，名不进载荷）；类型字母是必需的——它决定
// LLM 该用 compositionId（合成）还是 footageId（素材）去定位，去掉就得先猜类型再回查。
//
// token 文本形态（与代码 chip 同款定界）：
//   外部两侧各 2 普通空格 = 框外间隙（换行机会留在这里，chip 整体换行）；
//   \u200b 为零宽定界符；内部两侧内边距用**不换行空格 U+00A0**（普通空格会让 token 从中间断行，
//   而 overlay 的 chip 是 inline-block 不会断，一断就错位），内边距个数按「框宽要盖住标签」推算。
(function (global) {
    'use strict';

    // 代码 chip 标签（与既有实现逐字一致；hover 的行号解析在 main.js，改动须同步）
    var CODE_LABEL = 'L\\d+(?:-L\\d+)?(?:\\(\\d+\\))?';
    var CODE_INNER = ' {2}' + CODE_LABEL + ' {2}';
    // 图层 chip 载荷：@<compositionId>:<layerId>[,<layerId>…][;<compositionId>:…]
    //（相邻同合成合并进一个组，compId 只写一次——chip 框宽 = token 文本宽，载荷少一个字符框就窄
    // 一个字宽；组间顺序即引用顺序，**不许为省字重排**）。
    // 内边距接受普通空格与 U+00A0 两种：粘贴/外部编辑器可能把不换行空格换成普通空格，
    // 那时 token 仍要解析得出（换回普通空格的代价只是可能从中间断行，不是引用失效）。
    var LAYER_PAD = '[ \\u00A0]{2,}';
    var LAYER_IDS = '\\d+';                       // 组内若干 layerId：2,3,4
    var LAYER_GROUP = '\\d+:' + LAYER_IDS + '(?:,' + LAYER_IDS + ')*';
    var LAYER_PAYLOAD = '@(' + LAYER_GROUP + '(?:;' + LAYER_GROUP + ')*)';
    var LAYER_INNER = LAYER_PAD + LAYER_PAYLOAD + LAYER_PAD;
    // 旧形态：载荷带图层名（@compId:layerId:名），且内边距是普通空格。
    // 只为「那版发出去的消息气泡」与「从旧会话粘回来的 chip」仍能渲染/解析而留——新建一律走新形态。
    // 排在新形态之后：新形态能匹配时不会走到这里（`@1:2` 两种都匹配得上，取前者）。
    // 新形态吃不下带名/带逗号的旧载荷：载荷后面必须紧跟内边距，而旧载荷那里是 `:名`——回溯后落到本分支
    //（实测 `@9001:102:Logo,II` 解析成一条、名里的逗号不被当成组内 layerId）。
    // 名的字符类排除零宽定界符（`[^\u200b]*?`）：名不可能含 \u200b（净化会去掉），而允许它会让
    // 半损坏的 token 把**后面的** chip 一起吞进这条（fuzz 实证），连带删掉邻居。
    var LAYER_LEGACY = LAYER_PAD + '@(\\d+):(\\d+)(?::([^\\u200b]*?))?' + LAYER_PAD;
    // 项目项引用 chip 载荷：@:<c|f><id>[,<c|f><id>…]——项目面板里选中的合成（c）/素材（f）。
    // 前缀里的冒号是**冲突隔离**：文件名不可能含冒号（Windows 保留字符），故 `@:c123` 这类载荷与
    // 文件 token 的「@ + 任意名」在真实数据上撞不上（与图层 token 靠「数字:数字」隔离同理）；
    // 分支顺序上本支仍排在文件支之前（三处口径同向：扫描、parseFileToken 的先判、建 token 的回读自检）。
    // 每个条目自带类型字母：LLM 据此用 compositionId（合成）还是 footageId（素材）定位——
    // 类型不进载荷，模型拿到 id 还得先回查一次才知道该填哪个参数。
    var ITEM_ENTRY = '[cf]\\d+';
    var ITEM_PAYLOAD = '@:(' + ITEM_ENTRY + '(?:,' + ITEM_ENTRY + ')*)';
    var ITEM_INNER = LAYER_PAD + ITEM_PAYLOAD + LAYER_PAD;
    // 文件引用 chip 载荷：@<文件名>——**名即身份**（不进 id/序号，理由见下）。
    // 排在两条图层分支之后：图层载荷以「数字:数字」开头，文件形态是「@ + 任意非空名」，两者都能匹配时
    // 必须让图层先拿走——否则图层 token `@1:2` 会被读成「名字叫 1:2 的文件」，
    // 那层引用静默变成一条指向不存在文件的引用。真实文件撞不上：冒号是 Windows 保留字符，
    // 文件名里不可能出现。（构建侧另有回读自检兜底，见 buildFileToken。）
    // 名的字符类排除零宽定界符与换行/制表符：前者会把 token 从中间截断、后者会让 token 跨行而
    // overlay 的 chip 不换行，两者都让 chip 框与 textarea 错位（与旧图层 token 的名同一个坑）。
    // 首字符另排除空白：前导空白会被前面的内边距吃掉，解析回来的名与文件名不等（这类名在
    // buildFileToken 的回读自检处被拒——宁可拒绝，不建半个引用）。
    var FILE_NAME = '[^\\u200b\\s][^\\u200b\\r\\n\\t]*?';
    var FILE_PAYLOAD = '@(' + FILE_NAME + ')';
    var FILE_INNER = LAYER_PAD + FILE_PAYLOAD + LAYER_PAD;
    // 分支顺序是语义的一部分（三处消费方共用本常量）：代码 → 图层(新) → 图层(旧) → 项目项 → 文件。
    // 项目项支必须在文件支之前：文件支的「@ + 任意名」能把 `@:c123` 整条吃成"名字叫 :c123 的文件"。
    // 图层支在项目项支之前无虞（图层载荷以数字开头，项目项载荷以冒号开头，两者不互相匹配）。
    var TOKEN_INNER = '(?:' + CODE_INNER + '|' + LAYER_INNER + '|' + LAYER_LEGACY + '|' + ITEM_INNER + '|' + FILE_INNER + ')';
    // 内边距字符与其最小个数；两侧各 2 个是不带任何补宽时的底色
    var PAD_CHAR = '\u00A0';
    var PAD_MIN = 2;
    // 标签两侧视觉留白（px）：框宽要比标签文字宽出这些，chip 才不显得贴边
    var LABEL_GAP_PX = 6;
    // 名只用于 hover/气泡显示（不进 token 载荷），故只做长度收敛，不参与定位
    var NAME_DISPLAY_MAX = 40;

    // 扫描用（token 本体，不含框外间隙）
    function makeScanRe() {
        return new RegExp('\\u200b' + TOKEN_INNER + '\\u200b', 'g');
    }
    // 原子编辑/整体删除用（含框外两侧 2 空格：间隙属于 chip）。
    // 框外间隙是**可选**的（`(?: {2})?`）：扫描正则从不要求它（它不在 token 本体里），若范围正则
    // 强制要求，两条正则在「框外空格被吃掉/被换成 NBSP」的条目上枚举数就不一致——overlay 的
    // data-order 来自扫描顺序，点击删除却按范围序号重数，于是删错 chip（实测：缺一个框外空格时
    // scan=2 / range=1，点第 1 条删掉的是第 2 条，点最后一条静默无反应）。可选后两条正则的枚举
    // 一一对齐（缺间隙的 token 也照样是原子的，光标不再能停进它内部）。
    function makeRangeRe() {
        return new RegExp('(?: {2})?\\u200b' + TOKEN_INNER + '\\u200b(?: {2})?', 'g');
    }
    // 单 token 解析（非全局：无 lastIndex 状态）。捕获组编号：新形态载荷 = 1；旧形态 compId = 2、
    // layerId = 3、名 = 4（两个分支在同一层交替，故组号按源码顺序排下去）。
    var LAYER_ONLY_RE = new RegExp('^\\u200b(?:' + LAYER_INNER + '|' + LAYER_LEGACY + ')\\u200b$');
    // 单 token 解析（非全局）。捕获组 1 = 项目项载荷（`:` 后的一串「类型字母+id」）。
    var ITEM_ONLY_RE = new RegExp('^\\u200b' + ITEM_INNER + '\\u200b$');
    // 单 token 解析（非全局）。捕获组 1 = 文件名。
    var FILE_ONLY_RE = new RegExp('^\\u200b' + FILE_INNER + '\\u200b$');

    // 名压成单行（hover 浮层与气泡 title 用）：名是用户数据，带换行会把浮层撑成多行
    function sanitizeName(name) {
        var s = String(name == null ? '' : name)
            .replace(/\u200b/g, '')
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
        if (s.length > NAME_DISPLAY_MAX) s = s.slice(0, NAME_DISPLAY_MAX - 1) + '…';
        return s;
    }

    // chip 标签：只说引用了几个图层，不报是哪个（引用了哪几层在 hover 浮层里给）
    function layerLabel(count) {
        var n = Math.floor(Number(count));
        if (!(n > 0)) n = 0;
        return AEI18n.t('引用 {n} 个图层', { n: n });
    }

    // ── 文件引用的显示标签（显示图片1/视频1，不显示真实文件名）──
    // 按扩展名归类，标签 = 类型 + 同类型内的出现序号（编号在渲染/解析处按文本序算，本模块只给
    // 类型与标签拼装）；真名移到 hover 浮层与气泡 title（与图层 chip 的「标签短、hover 给全文」同口径）。
    // 类型只影响显示，不影响身份——载荷仍是文件名（「名即身份」不变，跨会话粘贴/解析链零改动）。
    var FILE_KINDS = {
        '图片': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'tif', 'tiff', 'heic', 'heif', 'svg', 'ico'],
        '视频': ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts'],
        '音频': ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'wma', 'aiff', 'aif', 'opus']
    };
    // 扩展名 → 类型名；无扩展名/未知扩展名 → '文件'。大小写不敏感（PNG/pNg 同判）。
    // 以点开头的名（.gitignore）没有扩展名段，落 '文件'（不是"扩展名 = gitignore"）。
    function fileKind(name) {
        var s = String(name == null ? '' : name);
        var dot = s.lastIndexOf('.');
        if (dot <= 0 || dot === s.length - 1) return '文件';
        var ext = s.slice(dot + 1).toLowerCase();
        var kinds = Object.keys(FILE_KINDS);
        for (var i = 0; i < kinds.length; i++) {
            if (FILE_KINDS[kinds[i]].indexOf(ext) >= 0) return kinds[i];
        }
        return '文件';
    }

    // 标签文本：'图片1' / '视频2' / '文件1'（ordinal 为同类型内的 1-based 序号）
    // 类型名只在显示层翻译：fileKind 的返回值同时用作按类型分列的计数键（main.js/view.js 的
    // ordinal 表），键必须与语言无关，故 fileKind 保持中文内部名。
    function fileKindLabel(kind) {
        if (kind === '图片') return AEI18n.t('图片');
        if (kind === '视频') return AEI18n.t('视频');
        if (kind === '音频') return AEI18n.t('音频');
        return AEI18n.t('文件');
    }
    function fileLabel(name, ordinal) {
        var n = Math.floor(Number(ordinal));
        if (!(n > 0)) n = 1;
        return fileKindLabel(fileKind(name)) + n;
    }

    // 载荷文本（不含定界符与内边距）：建 token 与实际载荷量测共用，保证量的就是框里的东西。
    // 相邻同合成合并进一个组（@1:18,17，compId 只写一次）——只并**相邻**的，绝不跨条重排：
    // 多条引用按顺序对应句子里那处引用（见 buildLayerTokens 的切段注释同款语义）。
    function layerPayload(entries) {
        var groups = [];      // [[compId, [layerId…]], …]
        for (var i = 0; i < entries.length; i++) {
            var compId = String(entries[i].compositionId);
            var last = groups.length ? groups[groups.length - 1] : null;
            if (last && last[0] === compId) last[1].push(entries[i].layerId);
            else groups.push([compId, [entries[i].layerId]]);
        }
        var parts = [];
        for (var g = 0; g < groups.length; g++) {
            parts.push(groups[g][0] + ':' + groups[g][1].join(','));
        }
        return '@' + parts.join(';');
    }

    // 项目项引用载荷：'@:' + 逐条「类型字母 + Item.id」（逗号分隔）——'@:c123,f456'。
    // 类型字母 c=合成 / f=素材（见 ITEM_ENTRY 注释：模型据此选 compositionId / footageId 定位）。
    function itemPayload(entries) {
        var parts = [];
        for (var i = 0; i < entries.length; i++) {
            parts.push((entries[i].type === 'comp' ? 'c' : 'f') + entries[i].id);
        }
        return '@:' + parts.join(',');
    }

    // chip 标签：只说引用了几个对象（合成/素材），不报是哪个（引用了哪些在 hover 浮层里给）
    function itemLabel(count) {
        var n = Math.floor(Number(count));
        if (!(n > 0)) n = 0;
        return AEI18n.t('引用 {n} 个对象', { n: n });
    }

    // 内边距个数推算：框宽 = 2*pad*字宽 + 载荷宽，标签居中画在框里，
    // 故 pad 要满足 2*pad*字宽 + 载荷宽 >= 标签宽 + 2*留白。
    // measure(text) → px（由调用方按 textarea/overlay 的字体量；无度量或量不出时退回最小内边距）。
    function innerPadFor(labelText, payloadText, measure, minPad) {
        var min = (minPad > 0) ? Math.floor(minPad) : PAD_MIN;
        if (typeof measure !== 'function') return min;
        var unit = 0;
        try { unit = Number(measure(PAD_CHAR)); } catch (_) { unit = 0; }
        if (!(unit > 0)) return min;
        var need = 0;
        try {
            need = Number(measure(labelText)) + LABEL_GAP_PX * 2 - Number(measure(payloadText));
        } catch (_) { need = 0; }
        if (!(need > 0)) return min;
        var pads = Math.ceil(need / (2 * unit));
        return pads > min ? pads : min;
    }

    // 建 token 文本（含框外间隙）：内边距按标签宽推算，保证框宽盖得住标签。
    // 图层与项目项两条路径共用（只差载荷与标签文本，避免"内边距推算/框宽量测"各写一份再漂移）。
    function _tokenTextFor(labelText, payloadText, measure, minPad) {
        var pad = innerPadFor(labelText, payloadText, measure, minPad);
        var padText = new Array(pad + 1).join(PAD_CHAR);
        return {
            token: '  \u200b' + padText + payloadText + padText + '\u200b  ',
            payload: payloadText,
            pad: pad
        };
    }

    function tokenTextFor(entries, measure, minPad) {
        return _tokenTextFor(layerLabel(entries.length), layerPayload(entries), measure, minPad);
    }

    // 贪心切段 + 逐段建 token（图层/项目项共用；entries 已归一/去重）。
    // opts.maxWidth（px，输入框一行的可用宽）给定时按它切段，返回**多条** token：
    // 单条 token 宽过一行时 textarea 会从 token 中间断行，而 overlay 的 chip 是 inline-block
    // 不会断——两者行数不一致，chip 框就盖到别的文本上（实测 10 条@300px：textarea 5 行 /
    // overlay 4 行）。切段后每条都装得下一行（单条引用就超宽时无从再切，照原样建一条）。
    function _packTokens(entries, optsSafe, payloadFn, labelFn) {
        var measure = optsSafe.measure;
        var maxWidth = Number(optsSafe.maxWidth) > 0 ? Number(optsSafe.maxWidth) : 0;
        var tokens = [];
        if (!entries.length) return { tokens: tokens, count: 0 };
        function textFor(list) {
            return _tokenTextFor(labelFn(list.length), payloadFn(list), measure, optsSafe.innerPad);
        }
        function widthOf(list) {
            var raw = textFor(list).token.replace(/\u200b/g, '');
            try { return Number(measure(raw)) || 0; } catch (_) { return 0; }
        }
        function makeToken(list) {
            var t = textFor(list);
            return { token: t.token, count: list.length, payload: t.payload, entries: list };
        }
        var cur = [];
        for (var j = 0; j < entries.length; j++) {
            var candidate = cur.concat([entries[j]]);
            if (cur.length && maxWidth && measure && widthOf(candidate) > maxWidth) {
                tokens.push(makeToken(cur));
                cur = [entries[j]];
            } else {
                cur = candidate;
            }
        }
        if (cur.length) tokens.push(makeToken(cur));
        return { tokens: tokens, count: entries.length };
    }

    // 建图层引用 token（含框外间隙）。refs = [{compositionId, layerId, ...}]（多余的字段不进口令）。
    // 缺稳定键的条目**丢弃**并计入 dropped——调用方据此提示；不退回位置键（那是另一层）。
    // 返回 { tokens: [{ token, count, payload, entries }], count, dropped }；
    // 一条有效引用都没有时 tokens 为空数组。
    function buildLayerTokens(refs, opts) {
        var list = Array.isArray(refs) ? refs : (refs ? [refs] : []);
        var entries = [];
        var seen = {};
        var dropped = 0;
        for (var i = 0; i < list.length; i++) {
            var compId = Math.floor(Number(list[i] && list[i].compositionId));
            var layerId = Math.floor(Number(list[i] && list[i].layerId));
            if (!(compId > 0) || !(layerId > 0)) { dropped++; continue; }
            var key = compId + ':' + layerId;
            if (seen[key]) continue;      // 同一层重复选中/重复传入只记一条（计数不能虚报）
            seen[key] = true;
            entries.push({ compositionId: compId, layerId: layerId });
        }
        var packed = _packTokens(entries, opts || {}, layerPayload, layerLabel);
        return { tokens: packed.tokens, count: packed.count, dropped: dropped };
    }

    // 建项目项引用 token（含框外间隙）。refs = [{ itemId, itemType, name? }]（多余的字段不进口令）。
    // itemType 只认 'comp' / 'footage'：文件夹不可引用（工具面没有按文件夹定位/操作的参数，
    // 建出引用等于把模型引向死路），计入 skipped；缺 id 的条目计入 dropped（旧版 AE 无 Item.id）。
    // 返回 { tokens, count, dropped, skipped }；去重按 id（Item.id 全工程唯一）。
    function buildItemTokens(refs, opts) {
        var list = Array.isArray(refs) ? refs : (refs ? [refs] : []);
        var entries = [];
        var seen = {};
        var dropped = 0;
        var skipped = 0;
        for (var i = 0; i < list.length; i++) {
            var type = String((list[i] && list[i].itemType) || '').toLowerCase();
            if (type !== 'comp' && type !== 'footage') { skipped++; continue; }
            var id = Math.floor(Number(list[i] && list[i].itemId));
            if (!(id > 0)) { dropped++; continue; }
            if (seen[id]) continue;      // 同一对象重复选中只记一条（计数不能虚报）
            seen[id] = true;
            entries.push({ type: type, id: id });
        }
        var packed = _packTokens(entries, opts || {}, itemPayload, itemLabel);
        return { tokens: packed.tokens, count: packed.count, dropped: dropped, skipped: skipped };
    }

    // token 文本在输入框字体下的实际宽（零宽定界符不占宽）
    function measureWidthOf(entries, measure, minPad) {
        var raw = tokenTextFor(entries, measure, minPad).token.replace(/\u200b/g, '');
        try { return Number(measure(raw)) || 0; } catch (_) { return 0; }
    }

    // 解析图层 token → { refs: [{compositionId, layerId}] }；不是图层 token 返回 null
    function parseLayerToken(token) {
        if (!token) return null;
        // trim：原子编辑/删除按"含框外间隙"的范围形态匹配，解析须容忍两侧 2 个普通空格
        //（U+200B 不在 JS 的 \s 集合内，trim 不会动到定界符；U+00A0 在 \s 内，但它在定界符内侧，
        // 且是内边距——载荷由捕获组给出，不受 trim 影响）
        var m = LAYER_ONLY_RE.exec(String(token).trim());
        if (!m) return null;
        if (m[1] !== undefined) {          // 新形态：@compId:layerId[,layerId…][;compId:…]
            var groups = String(m[1]).split(';');
            var refs = [];
            for (var i = 0; i < groups.length; i++) {
                var kv = String(groups[i]).split(':');
                var compId = Number(kv[0]);
                var ids = String(kv[1]).split(',');
                for (var k = 0; k < ids.length; k++) {
                    refs.push({ compositionId: compId, layerId: Number(ids[k]) });
                }
            }
            return { refs: refs };
        }
        // 旧形态：一条引用，名只作显示用（定位仍靠 id）
        var one = { compositionId: Number(m[2]), layerId: Number(m[3]) };
        if (m[4]) one.name = String(m[4]);
        return { refs: [one] };
    }

    function isLayerToken(token) {
        return parseLayerToken(token) !== null;
    }

    // 解析项目项 token → { items: [{ type: 'comp'|'footage', id }] }；不是项目项 token 返回 null。
    // 类型字母由载荷自带（见 ITEM_ENTRY 注释）——解析侧不猜类型。
    function parseItemToken(token) {
        if (!token) return null;
        var m = ITEM_ONLY_RE.exec(String(token).trim());
        if (!m) return null;
        var parts = String(m[1]).split(',');
        var items = [];
        for (var i = 0; i < parts.length; i++) {
            var p = String(parts[i]);
            items.push({ type: p.charAt(0) === 'c' ? 'comp' : 'footage', id: Number(p.slice(1)) });
        }
        return { items: items };
    }

    function isItemToken(token) {
        return parseItemToken(token) !== null;
    }

    // 解析文件 token → { name }；不是文件 token 返回 null。
    // **先让图层与项目项解析**：同一 token 多种形态都能匹配时（名形如 `1:2` 或 `:c123`）判为引用 token
    // ——与扫描正则的分支顺序一致，两处口径必须同向，否则 overlay 按一种画、发送按另一种解。
    // （`:c123` 这类名含冒号，Windows 文件名不可能出现；此处的先判是防御性的——畸形/外部构造的
    // 名字宁可判不了文件，也不让它冒充一条会指错对象的引用。）
    function parseFileToken(token) {
        if (!token) return null;
        var s = String(token).trim();
        if (parseLayerToken(s)) return null;
        if (parseItemToken(s)) return null;
        var m = FILE_ONLY_RE.exec(s);
        if (!m) return null;
        return { name: String(m[1]) };
    }

    function isFileToken(token) {
        return parseFileToken(token) !== null;
    }

    // 非代码 token（图层引用 / 项目项引用 / 文件引用）——代码 chip 的登记表只记代码 chip 的下标换算用它，
    // 新 token 类型加进来必须一并归入，否则混排删除会删错一条代码 chip 的 hover 缓存。
    function isRefToken(token) {
        return isLayerToken(token) || isItemToken(token) || isFileToken(token);
    }

    // 建文件引用 token（含框外间隙）。**名即身份**：载荷就是文件名本身，不换成序号/路径——
    //   ① 序号是位置键：删掉前面的附件、或把 token 粘到别的会话，序号会静默指到**别的**文件；
    //   ② 路径是环境键：跨机器/换盘符粘贴即失效，且路径比名长得多（框宽 = token 文本宽，
    //      路径进载荷会让 chip 框宽出输入框一行，而 chip 是 inline-block 不断行 → 与 textarea 错位）；
    //   ③ 名是自描述键：解析得出「用户指的是哪个附件」，附件块（[引用文件]）里有 名→路径 的对应。
    // 解不出名的引用只能靠猜——故解析不出原名就不建 token（返回 null，调用方据此提示且不插 chip）。
    // 内边距固定 PAD_MIN：显示标签（图片N）的编号依赖文本序，建 token 时不可知，无法像图层 chip 那样
    // 按标签宽推算——固定内边距下框宽 = 载荷宽 + 2*PAD_MIN 字宽，常见文件名（含 `@` 与扩展名 ≥6 字符）
    // 足以盖住「图片1」这类 3–5 字符标签；极端短名下标签有 max-width + ellipsis 兜底（main.js/CSS）。
    function buildFileToken(name) {
        var n = String(name == null ? '' : name);
        if (!n || /[\u200b\r\n\t]/.test(n)) return null;
        var padText = new Array(PAD_MIN + 1).join(PAD_CHAR);
        var token = '  \u200b' + padText + '@' + n + padText + '\u200b  ';
        // 回读自检：建出来的 token 必须解析回**同一个名**（名带前导空白、2+ 连续空格的收尾等
        // 边界形态会被内边距吃掉）——宁可拒绝这条引用，也不建一个解析回来是别的名字的 token
        var back = parseFileToken(token);
        if (!back || back.name !== n) return null;
        return { token: token, name: n, payload: '@' + n };
    }

    // 发送/编辑重发时把图层 token 原位替换为引用说明（与代码 chip 的解析同款：不嵌全文，
    // 只给定位键）。编号按文本出现次序，与输入框里看到的顺序一致，便于把句子里的第 N 个引用对上 id。
    // 代码 chip 原样保留（由调用方自己的解析分支处理）。
    function resolveLayerTokens(text) {
        if (!text) return text;
        var ordinal = 0;
        return String(text).replace(makeScanRe(), function (whole) {
            var parsed = parseLayerToken(whole);
            if (!parsed) return whole;
            ordinal++;
            var body = [];
            for (var i = 0; i < parsed.refs.length; i++) {
                body.push('layerId=' + parsed.refs[i].layerId
                    + ', compositionId=' + parsed.refs[i].compositionId);
            }
            if (parsed.refs.length === 1) {
                return '（引用图层' + ordinal + '：' + body[0] + '，用这两个 id 定位）';
            }
            return '（引用图层' + ordinal + '：' + parsed.refs.length + ' 个图层 —— '
                + body.join('；') + '，用这些 id 定位）';
        });
    }

    // 发送/编辑重发时把文件 token 原位替换为引用说明。与图层 token 同款：编号按文本出现次序，
    // 与输入框里看到的顺序一致，便于把句子里的第 N 个引用对上具体附件。
    // **编号按类型分列**（与显示口径统一）：图片1/图片2/视频1…
    // 标签与这里同源（fileLabel），用户说"图片1"、LLM 在消息里看到的也是「引用图片1」。
    // lookup(name) → 路径数组（可选）：输入区还留着附件时给全路径，附件块里的 名→路径 对应就具体到
    // 文件；没有 lookup（编辑重发、跨会话粘贴——附件 chip 早被发送清空）时只给名，
    // 让下游按名字对 [引用文件] 块（够不着路径的就只报名字，不回退猜一个路径）。
    function resolveFileTokens(text, lookup) {
        if (!text) return text;
        var kindOrdinals = {};
        return String(text).replace(makeScanRe(), function (whole) {
            var parsed = parseFileToken(whole);
            if (!parsed) return whole;
            var kind = fileKind(parsed.name);
            kindOrdinals[kind] = (kindOrdinals[kind] || 0) + 1;
            var paths = [];
            if (typeof lookup === 'function') {
                try { paths = lookup(parsed.name) || []; } catch (_) { paths = []; }
            }
            var tail = paths.length ? '，路径 ' + paths.join('；') : '';
            return '（引用' + fileLabel(parsed.name, kindOrdinals[kind]) + '：' + parsed.name + tail + '）';
        });
    }

    // 发送/编辑重发时把项目项 token 原位替换为引用说明。与图层 token 同款：编号按文本出现次序，
    // 与输入框里看到的顺序一致（第 N 条「引用 N 个对象」chip 对得上句子里第 N 处引用）。
    // 文案里**点名类型与参数名**（合成 compositionId / 素材 footageId）：模型据此知道该往哪个
    // 工具的哪个参数里填这个 id——合成与素材的定位参数名不同，不说清就得先回查一次才知道。
    function resolveItemTokens(text) {
        if (!text) return text;
        var ordinal = 0;
        return String(text).replace(makeScanRe(), function (whole) {
            var parsed = parseItemToken(whole);
            if (!parsed) return whole;
            ordinal++;
            var body = [];
            for (var i = 0; i < parsed.items.length; i++) {
                body.push((parsed.items[i].type === 'comp' ? '合成 compositionId=' : '素材 footageId=')
                    + parsed.items[i].id);
            }
            if (parsed.items.length === 1) {
                return '（引用对象' + ordinal + '：' + body[0] + '，用这个 id 定位）';
            }
            return '（引用对象' + ordinal + '：' + parsed.items.length + ' 个对象 —— '
                + body.join('；') + '，用这些 id 定位）';
        });
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.chipTokens = {
        makeScanRe: makeScanRe,
        makeRangeRe: makeRangeRe,
        buildLayerTokens: buildLayerTokens,
        buildItemTokens: buildItemTokens,
        parseLayerToken: parseLayerToken,
        isLayerToken: isLayerToken,
        parseItemToken: parseItemToken,
        isItemToken: isItemToken,
        buildFileToken: buildFileToken,
        parseFileToken: parseFileToken,
        isFileToken: isFileToken,
        isRefToken: isRefToken,
        resolveFileTokens: resolveFileTokens,
        sanitizeName: sanitizeName,
        layerLabel: layerLabel,
        itemLabel: itemLabel,
        fileKind: fileKind,
        fileLabel: fileLabel,
        layerPayload: layerPayload,
        itemPayload: itemPayload,
        innerPadFor: innerPadFor,
        measureWidthOf: measureWidthOf,
        resolveLayerTokens: resolveLayerTokens,
        resolveItemTokens: resolveItemTokens,
        PAD_CHAR: PAD_CHAR,
        PAD_MIN: PAD_MIN,
        LABEL_GAP_PX: LABEL_GAP_PX
    };
})(window);
