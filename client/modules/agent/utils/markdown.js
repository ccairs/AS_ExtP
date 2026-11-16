(function (global) {
    'use strict';

    // ============================================================
    // Agent 模块 Markdown 渲染工具
    //
    // 工作流：marked.parse -> filterXSS (js-xss) -> HTML 字符串
    //
    // 依赖（由 index.html 全局 script 顺序保证）：
    //   - marked          : window.marked
    //   - filterXSS       : window.filterXSS (js-xss)
    //   - Prism           : window.Prism（已存在的代码高亮）
    //
    // 安全约束：
    //   - 所有 LLM 输出文本必须经此模块处理后才可写入 innerHTML
    //   - 白名单只放行 markdown 实际需要的标签
    //   - 仅允许 class 属性（Prism token 需要），其他危险属性（style/onclick/...）一律剥离
    //   - URL 协议白名单：http/https/mailto/tel/data:image/相对路径/锚点
    // ============================================================

    var _markedOptionsConfigured = false;

    function isReady() {
        return !!(global.marked && typeof global.marked.parse === 'function'
            && global.filterXSS && typeof global.filterXSS === 'function');
    }

    // 配置 marked：开启 GFM 表格、关闭 headerIds/mangle
    function configureMarked() {
        if (_markedOptionsConfigured || !global.marked) return;
        try {
            global.marked.setOptions({
                gfm: true,
                breaks: false,
                headerIds: false,
                mangle: false,
                pedantic: false,
                silent: false
            });
        } catch (e) {
            // 老/新版本 API 差异，忽略具体失败项
        }
        _markedOptionsConfigured = true;
    }

    // 构建收紧的 xss 白名单：只允许 markdown 实际产出的标签
    function buildXssWhiteList() {
        // 不在白名单中的标签会被 escapeHtml（保持可见但失去活性），
        // script/iframe/object 等同理，无 XSS 风险。
        return {
            a: ['href', 'title', 'target'],          // 链接
            abbr: ['title'],
            b: [],
            blockquote: ['cite'],
            br: [],
            code: ['class'],                          // Prism 高亮 token 用 class
            del: [],
            em: [],
            div: ['class'],                          // 表格 wrapper（ae-agent-md-table-wrap）
            h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
            hr: [],
            i: [],
            img: ['src', 'alt', 'title', 'width', 'height'],
            ins: [],
            kbd: [],
            li: [],
            mark: [],
            ol: [],
            p: [],
            pre: ['class'],                           // Prism 父容器 class
            s: [],
            small: [],
            span: ['class'],                          // Prism token
            strong: [],
            sub: [],
            sup: [],
            table: [],
            thead: [],
            tbody: [],
            tfoot: [],
            tr: [],
            th: ['align'],
            td: ['align'],
            ul: []
        };
    }

    function buildXssOptions() {
        return {
            whiteList: buildXssWhiteList(),
            // 只允许 class 属性透传（Prism 需要），其他非白名单属性全部丢弃
            onIgnoreTagAttr: function (tag, name, value, isWhiteAttr) {
                return '';
            },
            // 不覆盖 safeAttrValue：让 js-xss 用默认逻辑
            // 默认 safeAttrValue 已对 href/src 做协议白名单校验
            // （http/https/mailto/tel/data:image/ftp/相对路径/锚点），非法协议返回空串
            // 注意：不能返回 undefined 让 js-xss "走默认处理"——
            // js-xss 把 falsy 返回值当作"属性无值"，会输出 <a href> 而非 <a href="...">，
            // 导致所有链接 href 丢失
            stripIgnoreTag: false,         // 不在白名单的标签保留文本，转义输出
            stripIgnoreTagBody: false,
            allowCommentTag: false,
            stripBlankChar: true
        };
    }

    // 单代码块高亮上限：超长代码（长日志/大文件 dump）跳过 Prism 高亮纯文本输出，
    // 防正则语法高亮卡死主线程。内容零损失，纯视觉降级。
    var MAX_HIGHLIGHT_CHARS = 20 * 1024;

    // 用 Prism 高亮代码块，回退到纯转义
    function highlightCode(code, lang) {
        var Prism = global.Prism;
        if (!Prism || !Prism.highlight) {
            return escapeHtml(code);
        }
        // 当前项目只加载了 clike + javascript，其他语言原样输出避免抛错
        var grammar = (lang && Prism.languages && Prism.languages[lang]) || null;
        if (!grammar || code.length > MAX_HIGHLIGHT_CHARS) {
            // 无对应语法 / 超长代码：纯文本输出（内容零损失）
            return escapeHtml(code);
        }
        try {
            return Prism.highlight(code, grammar, lang);
        } catch (e) {
            return escapeHtml(code);
        }
    }

    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * 把 markdown 文本渲染为安全的 HTML 字符串。
     * 失败时回退为纯转义文本，绝不让原始内容直接进 innerHTML。
     *
     * renderOptions 按次覆盖 marked 选项（全局默认在 configureMarked 里）：
     * 例如用户消息传 { breaks: true } 让单换行渲染成 <br>（默认 breaks:false 会把
     * 单个换行当空白，多行输入的气泡被拼成一行）。
     *
     * @param {string} mdText markdown 源文本
     * @param {Object} [renderOptions] 本次渲染的 marked 选项覆盖
     * @returns {string} 已消毒的 HTML
     */
    function renderMarkdown(mdText, renderOptions) {
        var text = mdText == null ? '' : String(mdText);
        if (!text) return '';

        // 库未就绪：纯转义返回，避免渲染空泡或泄露原始 markdown 语法
        if (!isReady()) {
            return escapeHtml(text);
        }

        // 1. marked 解析为 HTML（本次覆盖项与全局默认合并，marked 负责合并）
        var rawHtml;
        try {
            configureMarked();
            // marked v5+ 使用 marked.parse，v3 及以前用 marked()
            var parse = global.marked.parse || global.marked;
            rawHtml = parse(text, renderOptions || undefined);
        } catch (e) {
            return escapeHtml(text);
        }
        if (!rawHtml) return '';

        // 2. 在代码块上做 Prism 高亮（pre > code）
        //    xss 会在下一步过滤 class，因此先用占位 class 让 js-xss 保留 class 属性，
        //    然后我们再替换回实际高亮 HTML。
        //    实现策略：在 marked 输出后、xss 前扫描 <pre><code> 提取并替换。
        rawHtml = applyPrismToCodeBlocks(rawHtml);

        // 3. 给 table 外包一层 wrapper（横向滚动 + 撑满宽度）
        rawHtml = wrapTables(rawHtml);

        // 4. js-xss 消毒
        var cleanHtml;
        try {
            cleanHtml = global.filterXSS(rawHtml, buildXssOptions());
        } catch (e) {
            // 消毒失败：宁可完全转义也不冒险
            return escapeHtml(text);
        }

        // 5. 给所有链接添加 target="_blank"，防止在 CEP 面板内导航导致扩展重启
        cleanHtml = cleanHtml.replace(/<a\s+/g, '<a target="_blank" rel="noopener noreferrer" ');

        return cleanHtml;
    }

    // 把 marked 输出中的 <table>...</table> 外面包一层
    // <div class="ae-agent-md-table-wrap">，让 wrapper 负责横向滚动，
    // table 自身用 width:100% 撑满 wrapper，避免短表格右边留白。
    function wrapTables(html) {
        // 贪婪匹配到第一个 </table>，避免嵌套（markdown 表格不会嵌套）
        return html.replace(/<table>/g, '<div class="ae-agent-md-table-wrap"><table>')
                   .replace(/<\/table>/g, '</table></div>');
    }

    // 扫描 marked 输出中的 <pre><code class="language-xxx">...</code></pre>，
    // 用 Prism 替换 code 内部 HTML（外层结构保留）。
    // 简单状态机实现，避免引入完整 HTML parser。
    function applyPrismToCodeBlocks(html) {
        var pattern = /<pre><code\s+class="language-([a-zA-Z0-9_-]+)"[^>]*>([\s\S]*?)<\/code><\/pre>/g;
        return html.replace(pattern, function (match, lang, encodedCode) {
            // marked 默认会 HTML-escape 代码内容，先解码回来
            var code = decodeHtmlEntities(encodedCode);
            var highlighted = highlightCode(code, lang);
            // 标记 class 给 js-xss 白名单通过
            return '<pre class="ae-agent-md-pre"><code class="language-' + lang + '">'
                + highlighted
                + '</code></pre>';
        });
    }

    function decodeHtmlEntities(s) {
        // &amp; 必须最后解码：先解会把代码里的字面量 '&lt;'（已被 marked 转义为
        // '&amp;lt;'）二次解码成 '<'，代码块显示内容失真
        return s
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&');
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.markdown = {
        render: renderMarkdown,
        isReady: isReady,
        escapeHtml: escapeHtml
    };
})(window);
