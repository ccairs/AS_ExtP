(function (global) {
    // GLSL 语法高亮（Prism 扩展，基于 clike）。挂载于 AEAgentApp.glslHighlight。
    // 不引入新依赖：复用 index.html 已加载的 prism-core/clike，仅注册 glsl 语言规则。
    // token 名选用主题（prism-tomorrow）已有的 .token.keyword / .token.builtin / .token.function，
    // 确保不额外写配色即有高亮色。
    //
    // 高亮渲染交给统一增量引擎（engine/hl-engine.js，与 script 预览区共用同一套
    // 按行增量逻辑）：本模块仅注入 GLSL 语言与编辑区元素，返回 preview 实例。
    function ensureLanguage() {
        var P = global.Prism;
        if (!P || !P.languages || !P.languages.clike || P.languages.glsl) return;
        P.languages.glsl = P.languages.extend('clike', {
            'keyword': /\b(?:attribute|const|uniform|varying|in|out|inout|precision|highp|mediump|lowp|float|int|uint|double|void|bool|if|else|for|while|do|return|break|continue|discard|struct|switch|case|default|layout|flat|smooth|centroid|invariant|coherent|volatile|restrict|readonly|writeonly|shared|buffer|image|sampler1D|sampler2D|sampler3D|samplerCube|sampler2DArray)\b/,
            'builtin': /\b(?:vec[234]|ivec[234]|bvec[234]|uvec[234]|mat[234]|mat[234]x[234]|dvec[234]|dmat[234]|gl_Position|gl_FragCoord|gl_FragColor|gl_FragData|gl_FragDepth|gl_PointCoord|gl_FrontFacing|gl_VertexID|gl_InstanceID|gl_Layer|uTime|uResolution|uAspect)\b/,
            'function': /\b(?:mainImage|texture2D|texture|mix|clamp|smoothstep|step|fract|mod|pow|sqrt|abs|min|max|floor|ceil|round|sign|sin|cos|tan|asin|acos|atan|exp|log|length|distance|dot|cross|normalize|reflect|refract|transpose|inverse|determinant)\b/
        });
    }

    // 返回高亮后的 HTML；Prism 未就绪或异常时返回空串（调用方据此保持纯文本可见）
    function highlightGlsl(code) {
        ensureLanguage();
        var P = global.Prism;
        if (!P || !P.highlight || !P.languages.glsl) return '';
        try {
            return P.highlight(code || '', P.languages.glsl, 'glsl');
        } catch (_) {
            return '';
        }
    }

    // 统一增量引擎已在引擎层把每行渲染为 .hl-line（跨行 span 逐行闭合/重开），
    // 与 script 预览区一致；GLSL 与 JS 共用同一引擎，差异仅在注入的语言对象。
    function createPreview() {
        var eng = global.AEAgentApp && global.AEAgentApp.hlEngine;
        if (!eng || typeof eng.create !== 'function') return null;
        return eng.create({
            getTextarea: function () { return global.document.getElementById('shaderCodePreview'); },
            getOverlay: function () { return global.document.getElementById('shaderHighlightCode'); },
            getWrap: function () { return global.document.getElementById('shaderCodeWrap'); },
            getStatusEl: function () { return null; },
            getLanguage: function () {
                ensureLanguage();
                return (global.Prism && global.Prism.languages) ? global.Prism.languages.glsl : null;
            },
            getLanguageName: 'glsl'
            // 不传 onPrismMissing：Prism 缺失时引擎保持纯文本（has-highlight 关闭）
        });
    }

    var preview = createPreview();

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.glslHighlight = {
        highlightGlsl: highlightGlsl,
        ensureLanguage: ensureLanguage,
        preview: preview
    };
    // 模块加载即注册语言（index.html 中 Prism 先于本文件加载；highlightGlsl 内保留幂等 ensure）
    ensureLanguage();
})(window);