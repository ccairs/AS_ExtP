// ast-gate/preprocess.js — AST 编译门：ExtendScript 方言预处理层
// （client/modules/ast-gate/，双端模块：CEP 面板 window / Node globalThis）
//
// 职责：
//   剥离（惰性元数据，剥离后行为等价于无指令）：#target / #strict / #script
//   拒绝（不可信代码注入路径 / 持久会话）：
//     #include / #includepath / #targetengine   —— 行首 # 形态
//     //@include / //@includepath                 —— 注释替代形态（JS Tools Guide 记载的
//                                                    官方等价语法，漏拦即逃逸面）
//
// # 指令是文件加载预处理器特性（JS Tools Guide CC p.233）；
// evalScript 字符串通道语义未实测（PP 侧桥未运行），但被门的设计中性化——
// 剥离/拒绝产物永不含 #，AE 执行的重发射产物同样不含，两种语义下均 fail-safe。
//
// 实现要点：
//   词法感知逐字符扫描（字符串/正则/注释内的 # 是普通字符，不误伤）；
//   剥离行以等长空白填充（保留 \n），行号零漂移——免去行映射表；
//   指令仅认严格行首（列 0）——缩进的 # 形态不被剥离，交由 parser 报 SyntaxError 拒绝（fail-closed）。
(function (global) {
    'use strict';

    // 剥离型指令（惰性元数据）
    var STRIP_DIRECTIVES = { '#target': true, '#strict': true, '#script': true };
    // 拒绝型指令（注入路径/持久会话）
    var REJECT_DIRECTIVES = { '#include': true, '#includepath': true, '#targetengine': true };
    // 注释替代形态（官方等价语法：//@include path）——词法层与 # 形式同权。
    // 长名在前（indexOf 前缀匹配，防 //@include 遮蔽 //@includepath）
    var REJECT_COMMENT_DIRECTIVES = { '//@includepath': true, '//@include': true };

    // 门级深度上限（实测：最大 AST 结构深度 53 / 最大词法括号深度 19，
    // 取 128 为跨环境安全值——CEF 栈深未知，正常脚本嵌套远低于此）。
    // 词法层显式计数的必要性：acorn「Not enough stack space」阈值随 JIT 状态漂移
    // （实测：冷进程 ≈520 层括号即拒、热进程 700 层仍过）——依赖 parser 栈溢出
    // 做防护不可靠，故词法层独立硬拒；parser 栈溢出仅作兜底（gateParse catch）。
    var MAX_AST_DEPTH = 128;

    function reject(line, column, construct, reason) {
        return {
            ok: false,
            error: {
                status: 'rejected',
                line: line,
                column: column,
                construct: construct,
                reason: reason
            }
        };
    }

    // 读指令名：从 # 后取连续字母，返回小写名（#Target 与 #target 同名处理——
    // 引擎预处理器大小写不敏感的保守对齐）
    function readDirectiveName(src, i) {
        var j = i;
        while (j < src.length && /[a-z]/i.test(src.charAt(j))) j++;
        return src.slice(i, j).toLowerCase();
    }

    // 预处理：剥离惰性指令 + 拒绝注入型指令（含注释形态）
    // 返回 { ok: true, code }（code 行号与原文零漂移）或 { ok: false, error }（结构化拒绝）
    function preprocess(source) {
        if (typeof source !== 'string') return { ok: true, code: '' };
        var src = source;
        var out = [];
        var line = 1;          // 当前行（1-based）
        var lineStart = 0;     // 当前行首在 out 中的落点（用于行首判定）
        var i = 0;
        var n = src.length;
        var parenDepth = 0;    // 词法括号嵌套深度（( [ { 计数；字符串/正则/注释内不计数）
        // 词法状态机：normal / string / regex。注释在 normal 内联处理（行注释/块注释）。
        // 前一有效 token 类型——用于区分 / 是除号还是正则字面量开头（标准启发式）。
        var prevType = null;   // 'ident' | 'number' | 'punct-close' | 'keyword' | null(行首)

        function fillTo(end) {
            // 把 src[i..end) 原样追加
            for (; i < end; i++) out.push(src.charAt(i));
        }

        while (i < n) {
            var ch = src.charAt(i);
            var code = src.charCodeAt(i);

            // 换行：行号推进，重置行首状态
            if (ch === '\n' || ch === '\r') {
                out.push(ch);
                if (ch === '\r' && src.charAt(i + 1) === '\n') { out.push('\n'); i++; }
                i++;
                line++;
                lineStart = out.length;
                prevType = null;
                continue;
            }

            // 行首（严格列 0：i 必须是本行第一个字符）遇 #：候选指令。
            // 缩进的 # 形态不在此处理——不剥离，交 parser 报 SyntaxError（fail-closed）。
            if (ch === '#' && prevType === null) {
                var k = i - 1;
                var atLineStart = (k < 0) || (src.charAt(k) === '\n' || src.charAt(k) === '\r');
                if (atLineStart) {
                    var name = '#' + readDirectiveName(src, i + 1);
                    if (REJECT_DIRECTIVES[name]) {
                        return reject(line, 0, name,
                            'ExtendScript 预处理指令 ' + name + ' 在门内禁止（引入未过门代码/持久会话）');
                    }
                    if (STRIP_DIRECTIVES[name]) {
                        // 剥离本指令词（到行尾前保留换行，词长以空白填充，行号零漂移）
                        var j2 = i + name.length;
                        while (j2 < n && src.charAt(j2) !== '\n' && src.charAt(j2) !== '\r') j2++;
                        for (var w = i; w < j2; w++) out.push(w < i + name.length ? ' ' : ' ');
                        i = j2;
                        prevType = null;
                        continue;
                    }
                    // 未收录的 # 形态（如 #ifdef 混淆）：不剥离，交 parser 报 SyntaxError（fail-closed）
                }
            }

            // 行注释：检查 //@include 家族；注释内 # 为普通字符
            if (ch === '/' && src.charAt(i + 1) === '/') {
                var cend = i + 2;
                while (cend < n && src.charAt(cend) !== '\n' && src.charAt(cend) !== '\r') cend++;
                var commentText = src.slice(i, cend);
                var hitCommentDirective = null;
                for (var cd in REJECT_COMMENT_DIRECTIVES) {
                    if (commentText.indexOf(cd) === 0) { hitCommentDirective = cd; break; }
                }
                if (hitCommentDirective) {
                    return reject(line, 0, hitCommentDirective,
                        '注释形态预处理指令 ' + hitCommentDirective + ' 在门内禁止（# 指令的官方替代语法，同权拒绝）');
                }
                fillTo(cend);
                prevType = 'punct-close';
                continue;
            }

            // 块注释：整体复制（内含 # 与换行均原样；换行计数推进）
            if (ch === '/' && src.charAt(i + 1) === '*') {
                var bend = src.indexOf('*/', i + 2);
                if (bend < 0) bend = n; else bend += 2;
                for (var b = i; b < bend; b++) {
                    if (src.charAt(b) === '\n') line++;
                    out.push(src.charAt(b));
                }
                i = bend;
                prevType = 'punct-close';
                continue;
            }

            // 字符串字面量：整体复制，内含 # 与换行均普通字符
            if (ch === '"' || ch === "'") {
                var quote = ch;
                var send = i + 1;
                while (send < n) {
                    if (src.charAt(send) === '\\') send += 2;
                    else if (src.charAt(send) === quote) break;
                    else send++;
                }
                if (send >= n) send = n; else send++;
                fillTo(send);
                prevType = 'ident';
                continue;
            }

            // 正则字面量（启发式：前一有效 token 非标识符/数字/右括号类时，/ 开正则）
            if (ch === '/' && prevType !== 'ident' && prevType !== 'number' && prevType !== 'punct-close') {
                var rend = i + 1;
                var inClass = false;
                while (rend < n) {
                    var rc = src.charAt(rend);
                    if (rc === '\\') rend += 2;
                    else if (rc === '[') { inClass = true; rend++; }
                    else if (rc === ']') { inClass = false; rend++; }
                    else if (rc === '/' && !inClass) break;
                    else if ((rc === '\n' || rc === '\r') && !inClass) break; // 跨行即非正则
                    else rend++;
                }
                if (rend < n && src.charAt(rend) === '/') {
                    rend++;
                    while (rend < n && /[a-z]/i.test(src.charAt(rend))) rend++; // flags
                    fillTo(rend);
                    prevType = 'ident';
                    continue;
                }
                // 否则按除号走
            }

            // 普通字符：空白推进；标识符/数字/符号分类 prevType
            if (ch === ' ' || ch === '\t') {
                out.push(ch);
                i++;
                continue;
            }
            if (/[0-9]/.test(ch)) {
                var dend = i + 1;
                while (dend < n && /[0-9a-fA-FxX.]/.test(src.charAt(dend))) dend++;
                fillTo(dend);
                prevType = 'number';
                continue;
            }
            if (/[A-Za-z_$]/.test(ch)) {
                var iend = i + 1;
                while (iend < n && /[A-Za-z0-9_$]/.test(src.charAt(iend))) iend++;
                fillTo(iend);
                prevType = 'ident';
                continue;
            }
            // 符号
            if (ch === ')' || ch === ']' || ch === '}') {
                prevType = 'punct-close';
                if (parenDepth > 0) parenDepth--;
            } else {
                if (ch === '(' || ch === '[' || ch === '{') {
                    parenDepth++;
                    if (parenDepth > MAX_AST_DEPTH) {
                        return reject(line, out.length - lineStart, 'LexDepth',
                            '词法嵌套深度 ' + parenDepth + ' 超上限 ' + MAX_AST_DEPTH +
                            '（括号深度与 AST 结构深度分别独立检查）');
                    }
                }
                prevType = 'keyword'; // 运算符等
            }
            out.push(ch);
            i++;
        }

        return { ok: true, code: out.join('') };
    }

    global.AEGate = global.AEGate || {};
    global.AEGate.preprocess = preprocess;
    global.AEGate.MAX_AST_DEPTH = MAX_AST_DEPTH;
})(typeof window !== 'undefined' ? window : globalThis);
