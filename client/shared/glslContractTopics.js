/**
 * glslContractTopics.js — 契约**按主题切分**的可注入单元
 *
 * 存在理由：全量契约约 10k tokens 里只有约四分之一是永远必需的，其余是按特性条件使用的
 * （映射图层/相机/灯光/迭代趟/结算器/输入历史）。切分方式 = 核心常驻 + 按本次用到的特性附上对应小节
 * + 能力索引兜底（首用某特性时模型按索引去拉），于是"用不到的不发"。
 *
 * 单一内容源纪律：**本模块不含任何契约正文**。正文只住 client/shared/glslApiReference.txt，
 * 由调用方读进来后传这里切分。**两个读者面共用本模块**：
 *   · 面板 shader 轮 = prompts.js 读 AEEngine.getShaderContract()（bootstrap 读盘缓存）→
 *     coreText + detectTopics 探测到的节 + indexText([...], 'panel')；
 *     取节入口 = shader_contract 工具（scope 限 shader 轮）。
 *   · 外接 = guideContent.js 读同一个 AEEngine.getShaderContract() → guide('shader') 返回
 *     核心 + indexText([], 'external')；取节入口 = guide('shader:<id>')。
 * 所以改契约只改那一个 txt，主题切分口径由下面的 TABLES 定义。
 *
 * 双环境加载：Node（测试）module.exports / CEP 面板 window.AEGlslContractTopics。
 */
(function (global) {
    'use strict';

    // 可选主题（core 之外的一切）。id 用短名，因为它会出现在模型可见的索引里。
    var OPTIONAL = ['layers', 'camera', 'lights', 'iter', 'solve', 'history'];

    // 可拉取的全部分节 = 可选主题 + 两个非可选（core 给"只想看规则"的场合，
    // js 给 JS 编排路径）。工具 schema 的 enum 与索引都从这里取——单一来源，
    // 防两边各写一份清单漂移。
    var ALL_SECTIONS = ['core'].concat(OPTIONAL, ['js']);

    // 标题 → 主题 id 的**中文回退**规则（标题没带下面的锚点时用）。按**子串**匹配
    // （标题里有「（可选）」「专属内置」这类后缀，全文匹配会被措辞漂移搞坏）。
    // 命中顺序即优先级；都不中 → core。
    var TITLE_RULES = [
        ['映射图层', 'layers'],
        ['相机', 'camera'],
        ['灯光', 'lights'],
        ['迭代趟', 'iter'],
        ['结算器', 'solve'],
        ['输入历史', 'history']
    ];

    // 标题锚点：`<!-- topic:x -->` 优先于中文标题规则，英文契约副本只需带同一锚点。
    // 锚点从注入正文里剥掉（模型看到的标题保持原样）。
    var TOPIC_MARK_RE = /\s*<!--\s*topic:([a-z]+)\s*-->\s*$/;

    function takeMarker(title) {
        var m = TOPIC_MARK_RE.exec(title);
        if (!m) return { title: title, topic: '' };
        return { title: title.slice(0, m.index), topic: m[1] };
    }

    function topicOfTitle(title) {
        for (var i = 0; i < TITLE_RULES.length; i++) {
            if (title.indexOf(TITLE_RULES[i][0]) >= 0) return TITLE_RULES[i][1];
        }
        return 'core';
    }

    // 把全量契约切成块（对外：{ level, title, topic, text }；内部块另带 marker）
    // 归属规则（踩过一次：不能对每个块各自按标题匹配）：
    //   · 每块先取标题锚点（锚点取后从标题里剥掉）；有锚点即用锚点；
    //   · H1 决定"半部"：GLSL / JS（JS 半部整体归 'js'——另一门语言、另一条提交通路）；
    //   · H2 无锚点时按 TITLE_RULES 定主题，未命中 → core；
    //   · **H3 继承所属 H2 的主题**——子节标题五花八门（「结算专属内置」「@solveRes N」
    //     「缓存与失效」都不含"结算器"字样），各自匹配会把它们漏进 core；
    //   · 唯一例外：`## 内置变量` 下的三个 H3（相机/灯光/uAspect）按标题区分。
    function splitSections(text) {
        var lines = String(text == null ? '' : text).split('\n');
        var blocks = [];
        var cur = null;
        function flush() {
            if (cur && (cur.title || cur.lines.join('').trim())) blocks.push(cur);
            cur = null;
        }
        for (var i = 0; i < lines.length; i++) {
            var m = /^(#{1,3})\s+(.*\S)\s*$/.exec(lines[i]);
            if (m) {
                flush();
                var marked = takeMarker(m[2]);
                cur = { level: m[1].length, title: marked.title, lines: [], marker: marked.topic };
            } else {
                if (!cur) cur = { level: 0, title: '', lines: [], marker: '' };   // 首块前的正文
                cur.lines.push(lines[i]);
            }
        }
        flush();

        var h1Title = '';
        var h2Topic = 'core';
        var h2IsBuiltins = false;
        var out = [];
        for (var b = 0; b < blocks.length; b++) {
            var blk = blocks[b];
            var isJs;
            if (blk.level === 1) {
                h1Title = blk.title;
                h2Topic = blk.marker || 'core';
                h2IsBuiltins = blk.marker === 'builtins';
            }
            isJs = blk.marker === 'js' || (blk.level === 1 && blk.title.indexOf('JS') >= 0) ||
                   (h1Title.indexOf('JS') >= 0);
            var topic;
            if (isJs) {
                topic = 'js';
            } else if (blk.level === 1) {
                topic = 'core';
            } else if (blk.level === 2) {
                // 「内置变量」节恒为核心：它的 H2 块是
                // iChannel0/uTime/… 清单与「量纲 / 预览世界模型」两段——**永远必需**。
                // 但标题规则是按**子串**匹配的：标题里只要出现某个可选主题名（实测：为
                // 标"映射图层例外"而在标题里写「映射图层」），整个 H2 块会被判进那个主题
                // → 核心常驻丢节 + 主题串台（单测的串台哨兵会红）。故这里显式兜底：
                // 内置变量节不走标题规则，恒 core（其下 H3 仍按标题分派相机/灯光/uAspect）。
                h2IsBuiltins = blk.marker === 'builtins' || blk.title.indexOf('内置变量') >= 0;
                // builtins 锚点不是主题 id，它只表示"这一节恒 core"。
                h2Topic = h2IsBuiltins ? 'core' : (blk.marker || topicOfTitle(blk.title));
                topic = h2Topic;
            } else {
                // 三级标题：默认继承所属二级标题；仅"内置变量"下的子节按标题区分（相机/灯光/uAspect）
                topic = blk.marker || (h2IsBuiltins ? topicOfTitle(blk.title) : h2Topic);
            }
            var body = blk.lines.join('\n').replace(/^\n+|\n+$/g, '');
            var head = blk.title ? new Array(blk.level + 1).join('#') + ' ' + blk.title : '';
            out.push({
                level: blk.level,
                title: blk.title,
                topic: topic,
                text: (head ? head + (body ? '\n' : '') : '') + body
            });
        }
        return out;
    }

    // 常规注入的正文：core + js 两类的块按原序拼接（js 保持常驻——它是提交通路的契约，
    // 不是"用不用某特性的选择"；面板侧还有 submit_js_effect 描述兜底）。
    function coreText(text) {
        return pick(text, ['core', 'js']).text;
    }

    // 按主题取小节正文（不存在的主题静默跳过）
    function topicsText(text, ids) {
        return pick(text, ids).text;
    }

    function pick(text, ids) {
        var want = {};
        var list = Array.isArray(ids) ? ids : [ids];
        for (var i = 0; i < list.length; i++) want[list[i]] = true;
        var blocks = splitSections(text);
        var parts = [];
        for (var b = 0; b < blocks.length; b++) {
            if (want[blocks[b].topic] && blocks[b].text) parts.push(blocks[b].text);
        }
        return { text: parts.join('\n\n'), topics: Object.keys(want) };
    }

    // 从 shader 源码探测"这一轮用到了哪些可选特性"——注意**宁可多给不要少给**：
    // 注释里提到 @solve 也会命中（多附一节只花 token，少附会让模型写错）。
    var DETECT = [
        ['layers', /iChannel1|iChannel2|iChannel3/],
        ['camera', /uHasCam|uCamFov|uCamPos|uCamMatrix|uWorldMatrix/],
        ['lights', /uHasLights|uLightCount|uLightType|uLightPos|uLightDir|uLightColor|uLightParams/],
        ['iter', /@iterations|iterateImage|uIterCount|\biPrev\b|\buIter\b/],
        ['solve', /@solve(Hz|Res)?\b|\buStep\b|\buDt\b/],
        ['history', /@history|iHistory/]
    ];

    function detectTopics(source) {
        var s = String(source == null ? '' : source);
        var found = [];
        if (!s.trim()) return found;
        for (var i = 0; i < DETECT.length; i++) {
            if (DETECT[i][1].test(s)) found.push(DETECT[i][0]);
        }
        return found;
    }

    // 能力索引：把"还有哪些可选能力"讲清楚，并给出拉详版的入口。
    // 这是按需附节的安全网——首用某特性时源码里还没有它，靠这段让模型知道去哪拿。
    // token 预算 ~280：只列能力 + 入口（layers 行另载两条"首用必知"口径，
    // 属有意的例外——见该行注释与单测 ⑤c）。单测另有 900 字符总长守卫。
    //
    // 每行开头的「」= **节名**，与契约正文的标题（附上该节时可见）同字面。这层桥接是必需的：
    // 常驻的核心契约里存在**跨节指路**（如硬性规则 1「唯一例外：迭代趟入口 iterateImage，
    // 见「迭代趟」节」），而该节按需才附上——没有"名字→section id→入口"这条链，模型在
    // 只拿到核心的那一轮会读到一个查不到的指路（原文写"见上节"，
    // 按需附节时"上"可能整节不在）。
    //
    // reader：取节入口**按读者面分叉**——两个读者面的工具不是同一个
    // （面板 = shader_contract，外接 = guide），索引写错工具名等于指着一个调不到的入口。
    // 默认 'panel'，外接侧由 guideContent 显式传 'external'。
    function indexText(alreadyIncluded, reader) {
        var have = {};
        var list = Array.isArray(alreadyIncluded) ? alreadyIncluded : [];
        for (var i = 0; i < list.length; i++) have[list[i]] = true;
        var howto = function (id) {
            return (reader === 'external')
                ? "guide('shader:" + id + "')"
                : "shader_contract(section='" + id + "')";
        };
        var rows = [
            // 措辞带用户会说的词（蒙版/素材层/另一张图层…）+ 两条"首次使用就必须知道"的口径
            // （必须自己声明、预览不反映它）——这两条只住在按需节里时的失效形态：
            // 而首用那轮源码里还没有 iChannelN → 探测不到 → 节不附上 → 模型把预览黑帧当自己的
            // bug 修（或回"没有这个能力"），正是本次修复要消灭的失效形态。
            ['layers', '「映射图层」iChannel1/2/3：用合成里另一张图当输入（置换/高度图/深度图/蒙版/遮罩/matte/素材层/参考图）——**必须自己声明**；预览里恒为透明黑、或（0.5 居中的置换式）退化成常量偏移，与它是否生效无关（要到 AE 选图层后观察）'],
            ['iter', '「迭代趟」@iterations 帧内多趟迭代（反应扩散/迭代平滑/逐步逼近/多 pass 后处理链）'],
            ['solve', '「结算器」@solve/@solveHz/@solveRes：状态跨帧持久（流体/粒子/波前）'],
            ['history', '「输入历史」@history 拖尾/残影/时间回馈'],
            ['camera', '「相机/3D 变换内置」跟随 AE 合成相机做 raymarch/视差'],
            ['lights', '「灯光内置」跟随 AE 合成灯光做光照']
        ];
        var out = ['## 可选能力（详版按需取，未列出的能力本文档不含；「」内是节名）'];
        for (var r = 0; r < rows.length; r++) {
            out.push('- ' + rows[r][1] + '　→ ' + howto(rows[r][0])
                     + (have[rows[r][0]] ? '（本轮已按当前预览代码附上）' : ''));
        }
        return out.join('\n');
    }

    var api = {
        listTopics: function () { return OPTIONAL.slice(); },
        allSections: function () { return ALL_SECTIONS.slice(); },
        splitSections: splitSections,
        coreText: coreText,
        topicsText: topicsText,
        detectTopics: detectTopics,
        indexText: indexText
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof global !== 'undefined') {
        global.AEGlslContractTopics = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
