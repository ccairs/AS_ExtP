// ast-gate/reemit.js — AST 编译门：重发射器（estree AST → ES3 代码）+ 门级 parse 封装
// （client/modules/ast-gate/，双端模块：CEP 面板 window / Node globalThis）
//
// 范围（plan Task 4）：语义保真的最小重发射——结构等价即达标，不追求规范化全量规则
// （缩进统一/引号统一是后续的事）。覆盖语料实际出现的全部 estree ES3 节点类型；
// 未覆盖节点类型抛出（显式缺口，供补——fail-closed）。
//
// 括号策略：保守加括号（子表达式优先级低于父上下文要求时包裹）。AST 层面括号透明
// （acorn 不产 ParenthesizedExpression 节点），幂等性不受影响。
//
// gateParse：preprocess → parse → 深度检查（MAX_AST_DEPTH=128）。
(function (global) {
    'use strict';

    var MAX_AST_DEPTH = 128;

    // ── 深度度量 ────────────────────────────────────────────────
    function measureDepth(node) {
        if (node === null || typeof node !== 'object') return 0;
        var max = 0;
        for (var k in node) {
            if (k === 'loc' || k === 'range' || k === 'start' || k === 'end') continue;
            var v = node[k];
            if (Array.isArray(v)) {
                for (var i = 0; i < v.length; i++) {
                    var d = measureDepth(v[i]);
                    if (d > max) max = d;
                }
            } else if (v && typeof v === 'object' && typeof v.type === 'string') {
                var d2 = measureDepth(v);
                if (d2 > max) max = d2;
            }
        }
        return 1 + max;
    }

    // ── 门级 parse 封装 ─────────────────────────────────────────
    // 返回 { ok: true, ast, code }（code=剥离产物）或 { ok: false, error }
    function gateParse(source) {
        var pre = global.AEGate.preprocess(source);
        if (!pre.ok) return pre;
        var acorn = global.AEGate._acorn; // 由 bootstrap 注入（面板端 script 标签序 / Node 端 require）
        var ast;
        try {
            ast = acorn.parse(pre.code, { ecmaVersion: 3 });
        } catch (e) {
            return {
                ok: false,
                error: { status: 'rejected', line: e.loc ? e.loc.line : 0, column: e.loc ? e.loc.column : 0,
                    construct: 'SyntaxError', reason: e.message }
            };
        }
        var depth = measureDepth(ast);
        if (depth > MAX_AST_DEPTH) {
            return {
                ok: false,
                error: { status: 'rejected', line: 0, column: 0,
                    construct: 'ASTDepth', reason: '嵌套深度 ' + depth + ' 超上限 ' + MAX_AST_DEPTH }
            };
        }
        return { ok: true, ast: ast, code: pre.code };
    }

    // ── 重发射器 ────────────────────────────────────────────────
    var INDENT = '    ';

    function emit(ast) {
        var lines = [];
        emitProgram(ast, lines, '');
        return lines.join('\n') + '\n';
    }

    // ──  行映射（产物行 → 原文行，语句级锚点）────────────────
    // 重发射必改行——运行时错误（AE 报错行号 = 产物行号，
    // new Function 形态偏移 0）回指原文行号的数据通道。
    // 锚点 = 每条产物语句的 {el: 产物起始行, sl: 原文起始行}；查找取
    // el ≤ productLine 的最大条目（多行语句内部行归属语句首行）。
    // 函数表达式（emitExpr FunctionExpression 走局部 flines 拼内嵌换行串，
    // 行号不在主 lines 账上）体内语句不记锚点——错误归到包含该函数表达式
    // 的最近外层语句首行（精度取舍：远强于整段错误）；函数声明体走主
    // lines 正常记账。
    var _anchors = null;      // emitWithMap 执行期间非 null（单线程同步段安全，对齐 validate.js _currentPolicy 先例）
    var _fnExprDepth = 0;     // 函数表达式发射深度 >0 时 emitStatement 不记锚点

    var _scanIdx = 0;   // 增量扫描游标：已累计进 _scanEl 的元素个数
    var _scanEl = 0;    // 已累计的「元素数 + 内嵌换行数」＝ lines.length + Σ内嵌 \n
    function _recordAnchor(node, lines) {
        if (!_anchors || _fnExprDepth > 0 || !node.loc) return;
        // 产物行 = 已 push 行数 + 每行内嵌换行数 + 1（元素可能含内嵌 \n——
        // 函数表达式整体作为一个 push 内容）
        //
        // 增量累计：每次记锚点都
        // **重扫全部已发射行并逐字符 charCodeAt** → 门对长脚本 **O(n²)**。实测（真模块）：
        // 400/1600/6400 语句 → emitWithMap 3.2/56/945ms（对照同规模无锚点 `emit` 仅
        // 0.37/0.29/1.49ms，**634×** 定位成因），25601 行块结构 gate **7.35s**；而门跑在
        // **面板 UI 线程同步**、且在 `evalScript` **之前**（AE 侧尚未开始执行）⇒ 面板冻结 1–7 秒。
        // `lines` 在一次 emitWithMap 内**只增不减**（append-only），故只扫新增部分、累计值等价；
        // 若长度意外变小（不该发生）则回退全量重扫，保证 el 仍有正确语义。
        if (lines.length < _scanIdx) { _scanIdx = 0; _scanEl = 0; }
        for (var i = _scanIdx; i < lines.length; i++) {
            var s = lines[i];
            _scanEl++;
            for (var j = 0; j < s.length; j++) {
                if (s.charCodeAt(j) === 10) _scanEl++;
            }
        }
        _scanIdx = lines.length;
        _anchors.push({ el: _scanEl + 1, sl: node.loc.start.line });
    }

    function emitWithMap(ast) {
        _anchors = [];
        _fnExprDepth = 0;
        _scanIdx = 0;
        _scanEl = 0;
        var lines = [];
        emitProgram(ast, lines, '');
        var map = _anchors;
        _anchors = null;
        return { code: lines.join('\n') + '\n', lineMap: map };
    }

    // 产物行 → 原文行（el 单调递增保证二分；未命中/越界取最近锚点，无锚点返回 0）
    function mapProductLine(lineMap, productLine) {
        if (!lineMap || !lineMap.length || !(productLine >= 1)) return 0;
        var lo = 0, hi = lineMap.length - 1, best = 0;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (lineMap[mid].el <= productLine) { best = lineMap[mid].sl; lo = mid + 1; }
            else hi = mid - 1;
        }
        return best;
    }

    function emitProgram(node, lines, ind) {
        for (var i = 0; i < node.body.length; i++) {
            emitStatement(node.body[i], lines, ind);
        }
    }

    function pushStmt(lines, ind, code) {
        lines.push(ind + code);
    }

    function emitStatement(node, lines, ind) {
        _recordAnchor(node, lines);
        switch (node.type) {
            case 'VariableDeclaration':
                pushStmt(lines, ind, emitVariableDeclaration(node, ind, lines));
                break;
            case 'FunctionDeclaration':
                lines.push(ind + 'function ' + node.id.name + '(' + node.params.map(function (p) { return p.name; }).join(', ') + ') {');
                emitBlockBody(node.body, lines, ind + INDENT);
                lines.push(ind + '}');
                break;
            case 'ExpressionStatement': {
                // 语句首非自定界主表达式：产物以 { 开头会被解析为块（({a:1}).a = 2 形态）。
                // 唯一可能的形态是对象字面量（函数表达式已恒包裹），整体括号化即可
                var stmt = emitExpr(node.expression, 0);
                pushStmt(lines, ind, stmt.charAt(0) === '{' ? '(' + stmt + ');' : stmt + ';');
                break;
            }
            case 'IfStatement':
                pushStmt(lines, ind, 'if (' + emitExpr(node.test, 0) + ')');
                emitBodyOrStmt(node.consequent, lines, ind);
                if (node.alternate) {
                    pushStmt(lines, ind, 'else');
                    emitBodyOrStmt(node.alternate, lines, ind);
                }
                break;
            case 'ForStatement':
                // init 统一括号化（声明初始化器/表达式两种）：ES3 语法禁止 for-init
                // 顶层出现 in（ExpressionNoIn）；原文的显式括号（("a" in o)）被
                // 重发射丢弃后 `a = "a" in o` 回解即语法错误（for-in 初值/Assigning
                // to rvalue）。括号复位 NoIn 限制，语义等价
                var init = node.init
                    ? (node.init.type === 'VariableDeclaration' ? emitVariableDeclaration(node.init, null, null, true, true) : '(' + emitExpr(node.init, 0) + ')')
                    : '';
                pushStmt(lines, ind, 'for (' + init + '; ' + (node.test ? emitExpr(node.test, 0) : '') + '; ' +
                    (node.update ? emitExpr(node.update, 0) : '') + ')');
                emitBodyOrStmt(node.body, lines, ind);
                break;
            case 'ForInStatement':
                var left = node.left.type === 'VariableDeclaration'
                    ? emitVariableDeclaration(node.left, null, null, true) : emitExpr(node.left, 0);
                pushStmt(lines, ind, 'for (' + left + ' in ' + emitExpr(node.right, 0) + ')');
                emitBodyOrStmt(node.body, lines, ind);
                break;
            case 'WhileStatement':
                pushStmt(lines, ind, 'while (' + emitExpr(node.test, 0) + ')');
                emitBodyOrStmt(node.body, lines, ind);
                break;
            case 'DoWhileStatement':
                pushStmt(lines, ind, 'do');
                emitBodyOrStmt(node.body, lines, ind);
                pushStmt(lines, ind, 'while (' + emitExpr(node.test, 0) + ');');
                break;
            case 'ReturnStatement':
                pushStmt(lines, ind, node.argument ? 'return ' + emitExpr(node.argument, 0) + ';' : 'return;');
                break;
            case 'BreakStatement':
                pushStmt(lines, ind, node.label ? 'break ' + node.label.name + ';' : 'break;');
                break;
            case 'ContinueStatement':
                pushStmt(lines, ind, node.label ? 'continue ' + node.label.name + ';' : 'continue;');
                break;
            case 'BlockStatement':
                lines.push(ind + '{');
                emitBlockBody(node, lines, ind + INDENT);
                lines.push(ind + '}');
                break;
            case 'EmptyStatement':
                pushStmt(lines, ind, ';');
                break;
            case 'LabeledStatement':
                pushStmt(lines, ind, node.label.name + ':');
                emitStatement(node.body, lines, ind);
                break;
            case 'SwitchStatement':
                pushStmt(lines, ind, 'switch (' + emitExpr(node.discriminant, 0) + ') {');
                for (var c = 0; c < node.cases.length; c++) {
                    var cs = node.cases[c];
                    pushStmt(lines, ind + INDENT, cs.test ? 'case ' + emitExpr(cs.test, 0) + ':' : 'default:');
                    emitBlockBody({ body: cs.consequent }, lines, ind + INDENT + INDENT);
                }
                lines.push(ind + '}');
                break;
            case 'ThrowStatement':
                pushStmt(lines, ind, 'throw ' + emitExpr(node.argument, 0) + ';');
                break;
            case 'TryStatement':
                pushStmt(lines, ind, 'try');
                emitBodyOrStmt(node.block, lines, ind);
                if (node.handler) {
                    pushStmt(lines, ind, 'catch (' + node.handler.param.name + ')');
                    emitBodyOrStmt(node.handler.body, lines, ind);
                }
                if (node.finalizer) {
                    pushStmt(lines, ind, 'finally');
                    emitBodyOrStmt(node.finalizer, lines, ind);
                }
                break;
            case 'WithStatement':
                pushStmt(lines, ind, 'with (' + emitExpr(node.object, 0) + ')');
                emitBodyOrStmt(node.body, lines, ind);
                break;
            case 'DebuggerStatement':
                pushStmt(lines, ind, 'debugger;');
                break;
            default:
                throw new Error('reemit: 未覆盖语句节点类型 ' + node.type + '（不支持该节点类型）');
        }
    }

    function emitBodyOrStmt(node, lines, ind) {
        if (node.type === 'BlockStatement') {
            lines.push(ind + '{');
            emitBlockBody(node, lines, ind + INDENT);
            lines.push(ind + '}');
        } else {
            emitStatement(node, lines, ind + INDENT);
        }
    }

    function emitBlockBody(block, lines, ind) {
        for (var i = 0; i < block.body.length; i++) {
            emitStatement(block.body[i], lines, ind);
        }
    }

    function emitVariableDeclaration(node, ind, lines, noSemi, parenInit) {
        var parts = [];
        for (var i = 0; i < node.declarations.length; i++) {
            var d = node.declarations[i];
            var initOut = d.init ? emitExpr(d.init, 1) : '';
            // parenInit：ForStatement init 专用（ExpressionNoIn——见 ForStatement 注释）
            if (d.init && parenInit) initOut = '(' + initOut + ')';
            parts.push(d.id.name + (d.init ? ' = ' + initOut : ''));
        }
        return node.kind + ' ' + parts.join(', ') + (noSemi ? '' : ';');
    }

    // 二元/逻辑运算符优先级（用于保守括号判定）
    var PREC = {
        '||': 1, '&&': 2,
        '|': 3, '^': 4, '&': 5,
        '==': 6, '!=': 6, '===': 6, '!==': 6,
        '<': 7, '>': 7, '<=': 7, '>=': 7, 'instanceof': 7, 'in': 7,
        '<<': 8, '>>': 8, '>>>': 8,
        '+': 9, '-': 9,
        '*': 10, '/': 10, '%': 10
    };

    // 非自定界主表达式判定（ctxPrec >= 11：成员对象位/callee 等「主表达式自定界」上下文）：
    // ① 无小数点的十进制数字字面量——255.toString 被词法层误读为 255. + toString
    //    （Identifier directly after number）；0xff/1e2/255.0/字符串字面量自身定界（vendored
    //    acorn ES3 实测），不包；
    // ② 对象字面量——成员对象位/语句首的 {...} 被解析为块（非表达式）。
    function needsSelfDelimitParen(node, ctxPrec) {
        if (ctxPrec < 11) return false;
        if (node.type === 'ObjectExpression') return true;
        if (node.type === 'Literal' && typeof node.value === 'number') {
            var raw = (typeof node.raw === 'string') ? node.raw : String(node.value);
            return /^\d+$/.test(raw);
        }
        return false;
    }

    // emitExpr(node, ctxPrec)：ctxPrec = 该上下文要求的最低优先级；低于则加括号
    function emitExpr(node, ctxPrec) {
        switch (node.type) {
            case 'Identifier':
                return node.name;
            case 'Literal': {
                var lit = literal(node);
                return needsSelfDelimitParen(node, ctxPrec) ? '(' + lit + ')' : lit;
            }
            case 'ThisExpression':
                return 'this';
            case 'ArrayExpression':
                var els = [];
                for (var i = 0; i < node.elements.length; i++) {
                    els.push(node.elements[i] === null ? '' : emitExpr(node.elements[i], 0));
                }
                return '[' + els.join(', ') + ']';
            case 'ObjectExpression':
                var props = [];
                for (var p = 0; p < node.properties.length; p++) {
                    var pr = node.properties[p];
                    // 键保持原形态：Identifier 裸名 / 数字字面量保持数字（值类型敏感——
                    // "123" 字符串键 ≠ 123 数字键）/ 字符串键合法标识符裸名否则引号
                    var keyOut;
                    if (pr.key.type === 'Identifier') keyOut = pr.key.name;
                    else if (typeof pr.key.value === 'number') keyOut = String(pr.key.value);
                    else {
                        var ks = String(pr.key.value);
                        keyOut = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ks) ? ks : JSON.stringify(ks);
                    }
                    props.push(keyOut + ': ' + emitExpr(pr.value, 1));
                }
                var objOut = '{' + props.join(', ') + '}';
                return needsSelfDelimitParen(node, ctxPrec) ? '(' + objOut + ')' : objOut;
            case 'FunctionExpression':
                var fparams = node.params.map(function (x) { return x.name; }).join(', ');
                var flines = [];
                flines.push('function' + (node.id ? ' ' + node.id.name : '') + '(' + fparams + ') {');
                if (_anchors) _fnExprDepth++; // flines 局部数组——体内语句不记锚点（行号不在主 lines 账上）
                emitBlockBody(node.body, flines, INDENT);
                if (_anchors) _fnExprDepth--;
                flines.push('}');
                return '(' + flines.join('\n') + ')'; // 函数表达式整体包裹（保守，赋值/调用上下文安全）
            case 'UnaryExpression':
                // argument 上下文取最高优先级（11=成员访问级）——一元运算符右侧
                // 接 BinaryExpression 时必须加括号（!(a instanceof b)），prec<=10 全包裹
                return node.prefix
                    ? '(' + node.operator + ((node.operator === 'typeof' || node.operator === 'delete' || node.operator === 'void') ? ' ' : '') + emitExpr(node.argument, 11) + ')'
                    : '(' + emitExpr(node.argument, 11) + node.operator + ')';
            case 'UpdateExpression':
                return node.prefix
                    ? '(' + node.operator + emitExpr(node.argument, 11) + ')'
                    : '(' + emitExpr(node.argument, 11) + node.operator + ')';
            case 'BinaryExpression': {
                var prec = PREC[node.operator] || 0;
                var s = emitExpr(node.left, prec) + ' ' + node.operator + ' ' + emitExpr(node.right, prec + 1);
                return prec < ctxPrec ? '(' + s + ')' : s;
            }
            case 'LogicalExpression': {
                var lp = PREC[node.operator] || 0;
                var ls = emitExpr(node.left, lp) + ' ' + node.operator + ' ' + emitExpr(node.right, lp + 1);
                return lp < ctxPrec ? '(' + ls + ')' : ls;
            }
            case 'AssignmentExpression':
                return emitExpr(node.left, 0) + ' ' + node.operator + ' ' + emitExpr(node.right, 1);
            case 'ConditionalExpression':
                return '(' + emitExpr(node.test, 0) + ' ? ' + emitExpr(node.consequent, 1) + ' : ' + emitExpr(node.alternate, 1) + ')';
            case 'SequenceExpression': {
                var exprs = [];
                for (var q = 0; q < node.expressions.length; q++) exprs.push(emitExpr(node.expressions[q], 0));
                return '(' + exprs.join(', ') + ')';
            }
            case 'MemberExpression': {
                var obj = emitExpr(node.object, 11); // 成员访问要求主表达式级
                var prop = node.computed
                    ? '[' + emitExpr(node.property, 0) + ']'
                    : '.' + node.property.name;
                return obj + prop;
            }
            case 'CallExpression': {
                var callee = emitExpr(node.callee, 11);
                return callee + '(' + emitArgs(node['arguments']) + ')';
            }
            case 'NewExpression': {
                var cs = 'new ' + emitExpr(node.callee, 11) + '(' + emitArgs(node['arguments']) + ')';
                return ctxPrec > 0 ? '(' + cs + ')' : cs; // new 表达式作子表达式时保守包裹（与 new X() 语义差异防御）
            }
            default:
                throw new Error('reemit: 未覆盖表达式节点类型 ' + node.type + '（不支持该节点类型）');
        }
    }

    function emitArgs(args) {
        var out = [];
        for (var i = 0; i < args.length; i++) out.push(emitExpr(args[i], 1));
        return out.join(', ');
    }

    function literal(node) {
        if (node.raw !== undefined && typeof node.raw === 'string') return node.raw;
        if (node.regex) return '/' + node.regex.pattern + '/' + (node.regex.flags || '');
        var v = node.value;
        if (v === null) return 'null';
        if (typeof v === 'number') return String(v);
        if (typeof v === 'boolean') return String(v);
        return JSON.stringify(v);
    }

    // ── 结构等价比较（幂等断言用；忽略位置字段）──────────────────
    function structEqual(a, b) {
        if (a === b) return true;
        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        if (Array.isArray(a)) {
            if (a.length !== b.length) return false;
            for (var i = 0; i < a.length; i++) if (!structEqual(a[i], b[i])) return false;
            return true;
        }
        var ka = Object.keys(a).filter(function (k) { return k !== 'loc' && k !== 'range' && k !== 'start' && k !== 'end' && k !== 'raw' && k !== 'tail'; });
        var kb = Object.keys(b).filter(function (k) { return k !== 'loc' && k !== 'range' && k !== 'start' && k !== 'end' && k !== 'raw' && k !== 'tail'; });
        if (ka.length !== kb.length) return false;
        for (var j = 0; j < ka.length; j++) {
            if (!Object.prototype.hasOwnProperty.call(b, ka[j])) return false;
            if (!structEqual(a[ka[j]], b[ka[j]])) return false;
        }
        return true;
    }

    global.AEGate = global.AEGate || {};
    global.AEGate.emit = emit;
    global.AEGate.emitWithMap = emitWithMap;     // 产物 + 行映射（产物行 → 原文行）
    global.AEGate.mapProductLine = mapProductLine; // 行映射查找（el 二分，无锚点返回 0）
    global.AEGate.gateParse = gateParse;
    global.AEGate.measureDepth = measureDepth;
    global.AEGate.structEqual = structEqual;
    global.AEGate.MAX_AST_DEPTH = MAX_AST_DEPTH;
})(typeof window !== 'undefined' ? window : globalThis);
