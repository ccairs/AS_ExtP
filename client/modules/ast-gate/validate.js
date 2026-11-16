// ast-gate/validate.js — AST 编译门：门级管线入口 gate() + 校验引擎
// （client/modules/ast-gate/，双端模块：CEP 面板 window / Node globalThis）
//
// gate() 是接通道的唯一门入口（测试即当前轮调用方）：
// preprocess（方言指令处置 + 词法深度，/4 产物）
//   → parse（ecmaVersion:3 + allowReturnOutsideFunction——114 份 LLM 实证语料
//     全员函数体形态〔bootstrap.js:304 同形态〕，顶层 return 是 authored 代码常态）
// → AST 结构深度（measureDepth，实测）
//   → validate（三张表校验——Task 2 实装，Task 3 增类型表）
// → emit（重发射产物， 产物）
// 返回 {ok:true, ast, emitted, code} 或 {ok:false, error}（4.5 结构化形态：
//   status/line/column/construct/reason——LLM 自修正回路的输入质量在此定型）。
//
// gateParse（parse 级冒烟入口）保留不动——语义不同（不 validate），
// 测试依赖其现行为。
//
// 校验引擎（Task 2）：
//   作用域分析——var/函数名/参数/catch 参数/for-in 左侧收集为「已声明」
//   （脚本级收集，无分支敏感——声明面过近似是安全方向：误纳的只是用户自定义名）。
//   表① 节点类型白名单（WithStatement 拒）+ 动态 delete 拒 + meta-property
//   全局黑名单（constructor/__proto__/prototype… 任何接收者上拒）。
//   表② 标识符白名单——表达式位裸标识符须已声明或在表；赋值目标须用户声明
//   或 result（白名单全局不可篡改——app=Math 会毒化 AE 运行时跨脚本存活）；
//   this 按 GlobalThis 处理（沙箱 wrapper 内 this=global：静态成员按表②核对、
//   computed 拒——this["File"] 与 this.File 同权拒）。
(function (global) {
    'use strict';

    // ── 门级管线入口 ─────────────────────────────────────────────
    var _validateHook = null;

    function gate(source, opts) {
        var pre = global.AEGate.preprocess(source);
        if (!pre.ok) return pre;
        var acorn = global.AEGate._acorn; // 由 bootstrap 注入（面板端 script 标签序 / Node 端 require）
        var ast;
        try {
            ast = acorn.parse(pre.code, {
                ecmaVersion: 3,
                allowReturnOutsideFunction: true, // 函数体形态是 authored 代码执行常态
                locations: true // 结构化拒绝需行列号（4.5）
            });
        } catch (e) {
            return {
                ok: false,
                error: {
                    status: 'rejected',
                    line: e.loc ? e.loc.line : 0,
                    column: e.loc ? e.loc.column : 0,
                    construct: 'SyntaxError',
                    reason: e.message
                }
            };
        }
        var depth = global.AEGate.measureDepth(ast);
        if (depth > global.AEGate.MAX_AST_DEPTH) {
            return {
                ok: false,
                error: {
                    status: 'rejected',
                    line: 0,
                    column: 0,
                    construct: 'ASTDepth',
                    reason: '嵌套深度 ' + depth + ' 超上限 ' + global.AEGate.MAX_AST_DEPTH
                }
            };
        }
        if (_validateHook) {
            // policy/source 经模块级变量传递（单线程同步段安全）——run.js 的
            // 能力域注入挂点 + 弹窗族通道规则（DIALOG_IDS——source 区分用户
            // 手动运行通道与 Agent 自动执行通道）
            _currentPolicy = (opts && opts.policy) || null;
            _currentSource = (opts && opts.source) || null;
            try {
                var verdict = _validateHook(ast);
                if (verdict && !verdict.ok) return verdict;
            } finally {
                _currentPolicy = null;
                _currentSource = null;
            }
        }
        // ── code 类字符串实参递归过门──────────
        // 缺口：门只看 AST 时，**字符串字面量的内容不被检查**。于是
        // `executeExtendScript({code:"<载荷>"})` 这种形态里，外层是白名单宿主函数
        // 的合法裸调用（过门），载荷藏在字符串里 ⇒ 校验与执行不同一（门产物 ≠
        // 所执行的代码）。实测（报告 part-A F-A-1 / part-E E1）：同一载荷**直写**
        // 被拒（ComputedMember:GlobalThis），**塞进字符串**则 4/4 放行。
        // 修法：对「承载可执行代码的宿主函数实参」做**同一套判据的递归过门**——
        // 能静态解析的字符串（字面量，或全字面量拼接）必须自己过门，门拒绝即整体拒。
        // **刻意不做的事（假阳性防线，逐条有据）**：
        //   · 非静态可解析的实参（`__args`、变量、函数调用结果）**不改判**——
        //     面板工具模板正是 `result = executeExtendScript(__args);`（bootstrap
        //     /service.js/quickBarExecutor.js 同形），对这些 fail-closed 会让
        //     **全部** JSON 工具当场不可用（比留一个洞更糟）。故此处只收「藏进
        //     字面量」这一条路，动态拼接面仍由运行时守卫与核侧遮蔽承担（纵深）。
        //   · 空串不改判（交给执行期既有的 NO_EXECUTABLE_CODE 拒绝路径）。
        //   · 内层 `noExecutableStatement` 不在此转拒（内层空代码是调用方自己的
        //     语义，外层代码本身仍然合法）。
        // 递归性天然成立：内层过门时同样执行本段（字符串套字符串同样被剥开）。
        var _codeArgRej = _checkCodeStringArgs(ast, opts || {});
        if (_codeArgRej) return _codeArgRej;

        // emitWithMap 附带行映射（产物行 → 原文行，语句级锚点）——运行时
        // 错误回指的数据通道；产物本身与 emit() 逐字节一致（幂等不变）
        var em = global.AEGate.emitWithMap(ast);
        return {
            ok: true, ast: ast, emitted: em.code, lineMap: em.lineMap, code: pre.code,
            // 产物里有没有可执行语句（见 _hasExecutableStatement）。
            // 调用方（agent 工具管线 / ae-tool handler / createAETool 预检）据此拒绝"空代码"
            // ——否则宿主把「什么都没执行」回成「执行成功」，用户与 LLM 都以为代码生效了。
            noExecutableStatement: !_hasExecutableStatement(ast)
        };
    }

    // ── code 类字符串实参的递归过门───────────
    // 表：宿主函数名 → 该函数的「代码字段」名清单（见 gate() 内注释的假阳性防线）。
    // executeExtendScript 是 ExtendScript 侧的执行核（tables IDENTIFIERS 里的 host-fn）；
    // createAETool 是面板侧自建工具入口——它不在 ExtendScript 的标识符表里（门内代码
    // 调不到它），列在这里是**契约登记**：createAETool 的 extendScript 走的是
    // aeToolCreator 的 _gatePreCheck（source=ae-tool）→ 本函数，同一套判据；若将来
    // 该名字进了门表，这份映射立即生效，不必再改门。
    var _CODE_ARG_FIELDS = {
        executeExtendScript: ['code'],
        createAETool: ['extendScript', 'script', 'code']
    };

    // 静态字符串求值（**只认**字面量与其纯拼接）：
    //   'a'            → 'a'
    //   'a' + 'b'      → 'ab'
    //   其余（标识符/调用/模板/成员）→ null（不改判——见 gate() 内假阳性防线）
    // 拼接也认的理由：`"__ae"+"SGDn"` 这类载荷在**外层**实参上同样会写成拼接——
    // 只认单字面量等于给出一条「拆成两段拼接就绕过」的捷径，而折叠纯字面量拼接
    // 不引入任何假阳性（结果仍是静态确定的一串字符）。
    function _staticStringValue(node) {
        if (!node || typeof node !== 'object') return null;
        if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
        if (node.type === 'BinaryExpression' && node.operator === '+') {
            var l = _staticStringValue(node.left), r = _staticStringValue(node.right);
            if (l === null || r === null) return null;
            return l + r;
        }
        return null;
    }

    // 深度遍历 AST，找 code 类实参里的静态字符串；命中即把该字符串**再送同一套门**。
    // 返回第一条拒绝（结构化形态与 gate 一致，construct 标明来源便于 LLM 自修正），
    // 无命中返回 null。
    // 遍历进入嵌套函数体（载荷完全可以写在 function(){ executeExtendScript(...) } 里）。
    function _checkCodeStringArgs(ast, opts) {
        var bad = null;
        (function walk(node) {
            if (bad || !node || typeof node !== 'object') return;
            if (node.type === 'CallExpression' && node.callee &&
                node.callee.type === 'Identifier' && has(_CODE_ARG_FIELDS, node.callee.name)) {
                var fields = _CODE_ARG_FIELDS[node.callee.name];
                var args = node['arguments'] || [];
                for (var a = 0; a < args.length && !bad; a++) {
                    var arg = args[a];
                    if (!arg || arg.type !== 'ObjectExpression') continue;
                    var props = arg.properties || [];
                    for (var p = 0; p < props.length && !bad; p++) {
                        var prop = props[p];
                        if (!prop || prop.type !== 'Property' || prop.computed) continue;
                        var key = null;
                        if (prop.key && prop.key.type === 'Identifier') key = prop.key.name;
                        else if (prop.key && prop.key.type === 'Literal' && typeof prop.key.value === 'string') key = prop.key.value;
                        if (key === null || fields.indexOf(key) < 0) continue;
                        var srcText = _staticStringValue(prop.value);
                        if (srcText === null) continue;          // 非静态：不改判（假阳性防线）
                        if (!srcText.replace(/\s/g, '').length) continue; // 空/纯空白：交给执行期既有拒绝路径
                        // 内层过门：同 policy / 同 source（能力域与弹窗通道规则一致——
                        // 否则内层会因「源不同」被放宽或收紧，与「同一套判据」不符）
                        var inner = gate(srcText, { policy: opts.policy, source: opts.source });
                        if (inner && inner.ok === true) continue;
                        var ie = (inner && inner.error) || {};
                        var loc = prop.value && prop.value.loc ? prop.value.loc.start : null;
                        bad = {
                            ok: false,
                            error: {
                                status: 'rejected',
                                line: loc ? loc.line : 0,
                                column: loc ? loc.column : 0,
                                construct: 'CodeStringArg:' + node.callee.name + '.' + key,
                                // 拒信文案：只留
                                // 「内层原因 + 两个可执行动作」——去掉「同一套门判据/内层」这类
                                // **门的内部概念**（元话术，对收到拒信的 LLM 无动作价值），
                                // 也去掉「代码不得藏在字符串里绕过门」这类**可推出句**（等于给
                                // 攻击者提示）。
                                reason: '字符串实参里的可执行代码被门拒绝（' + (ie.construct || 'unknown')
                                    + '：' + (ie.reason || '未知')
                                    + '）。请直接执行该代码，或改用对应的参数式工具。',
                                domain: ie.domain
                            }
                        };
                    }
                }
            }
            for (var k in node) {
                if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
                var v = node[k];
                if (Array.isArray(v)) { for (var i2 = 0; i2 < v.length; i2++) walk(v[i2]); }
                else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
            }
        })(ast);
        return bad;
    }

    // 「有无可执行语句」判定：空代码、只有注释或分号的代码，门产物仍是一段合法程序
    // （空块 `{}`、`if (1){}`、`while (false){}`、`try{}catch(e){}`、`for(;;){}` 在 ES3 里
    // 都是合法语句），宿主执行后回「执行成功，未返回结果（工具代码未给 result 赋值）」。
    // 判法：纯容器（程序/块/if/循环/try/switch/标签/with）只按子体递归判定；声明与其它
    // 语句（表达式、return/throw/break/continue…）算可执行。
    // **刻意不覆盖**：`if (1){ var x; }`、`1 + 1;` 这类"有语句但无实际效果"的形态
    //（判它们需要副作用分析/常量折叠，收益远小于复杂度）。
    // 附带收益：`for(;;){}` 这种"空转且会挂死 AE 主线程"的形态也一并被拒。
    function _hasExecutableStatement(node) {
        if (!node || typeof node !== 'object') return false;
        var type = node.type;
        if (type === 'EmptyStatement') return false;
        if (type === 'Program' || type === 'BlockStatement') return _hasExecutableInList(node.body);
        if (type === 'IfStatement') {
            return _hasExecutableStatement(node.consequent) || _hasExecutableStatement(node.alternate);
        }
        if (type === 'WhileStatement' || type === 'DoWhileStatement' || type === 'ForStatement'
            || type === 'ForInStatement' || type === 'LabeledStatement' || type === 'WithStatement') {
            return _hasExecutableStatement(node.body);
        }
        if (type === 'TryStatement') {
            return _hasExecutableStatement(node.block)
                || _hasExecutableStatement(node.handler && node.handler.body)
                || _hasExecutableStatement(node.finalizer);
        }
        if (type === 'SwitchStatement') {
            var cases = node.cases || [];
            for (var i = 0; i < cases.length; i++) {
                if (_hasExecutableInList(cases[i].consequent)) return true;
            }
            return false;
        }
        return true;
    }
    function _hasExecutableInList(list) {
        if (!list || !list.length) return false;
        for (var i = 0; i < list.length; i++) {
            if (_hasExecutableStatement(list[i])) return true;
        }
        return false;
    }

    // 当前门策略/source（gate 调用段内有效；validate 各检查点读取）
    var _currentPolicy = null;
    var _currentSource = null;

    // ──  能力域闸（policy 挂点——表驱动）────────────────────────
    // 域名 → policy 布尔键（run.js 注入的四域统一形态）
    var _DOMAIN_KEYS = {
        system: 'syscallAllowed', socket: 'socketAllowed',
        file: 'fileAllowed', menu: 'menuAllowed'
    };
    function _domainOpen(domain) {
        if (!_currentPolicy) return false;
        var k = _DOMAIN_KEYS[domain];
        return !!(k && _currentPolicy[k] === true);
    }

    // 弹窗族成员闸（dlg 条目标志）——WithDialog 类成员弹系统
    // 对话框，Agent 通道（agent-tool/ae-tool——LLM 自动执行、无人在场）调用会挂起
    // AE 线程；仅 DIALOG_SOURCES（llm-preview 预览区 / user-library 用户库——用户
    // 手动运行的 Script 通道）放行（对齐 DIALOG_IDS 通道规则——弹窗合法性取决于
    // 「执行时有没有人在场」）
    function _dialogSourceOpen() {
        return !!(_currentSource && global.AEGate && global.AEGate.tables
            && has(global.AEGate.tables.DIALOG_SOURCES, _currentSource));
    }

    // ── 校验引擎 ─────────────────────────────────────────────────
    // 字典查找一律 hasOwnProperty：plain object 的 [] 访问会命中
    // Object.prototype 成员（'toString'/'constructor' 等）——两张表都会被原型链
    // 穿透（META 误拒 toString / IDENTIFIERS 误放行 constructor），健全性漏洞
    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function validate(ast) {
        var T = global.AEGate.tables;
        var state = { T: T, declared: {}, err: null, has: has };

        collectDeclarations(ast, state.declared);
        state.env = buildTypeEnv(ast, state); // pass 1：定点迭代建类型环境（Task 3）
        checkNode(ast, state);
        if (state.err) return { ok: false, error: state.err };
        return { ok: true };
    }

    // ═══════════════════════════════════════════════════════════════
    // 类型链推导
    //
    // 类型表示：字符串。联合 = 'a|b|c'；数组 = 'array<X>'；'u' = unknown。
    // 推导策略（计划 Task 3 Step 1，无分支敏感）：
    //   变量 = 声明 init ∪ 全部赋值位 RHS（null/undefined 字面量贡献空）；
    //   用户函数 = return 表达式并集；参数 = 调用点实参类型并集（脚本级合并，
    //   同名参数跨函数并——过近似方向安全：受限类型经否决权兜底）；
    //   联合成员访问 = any-member + 受限类型一票否决（FileHandle 在联合中时
    //   退化为交集——堵 cond ? layer : file 后 .remove() 的逃逸形态）；
    //   unknown 传播：unknown 上成员/调用/计算键一律拒。
    // 定点迭代：类型只增不减（并集），≤4 轮收敛（嵌套调用/递归近似）。
    // ═══════════════════════════════════════════════════════════════

    // 联合拆分须感知 array<> 嵌套：'array<u|string|number>' 是单一类型，
    // 其内的 '|' 不参与顶层联合拆分（否则数组元素联合被拆碎成非法类型名）
    function splitTypes(t) {
        var s = String(t), out = [], depth = 0, cur = '';
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            // 深度计法含花括号：形状串 user-object{k:T|U} 的成员类型
            // 可含联合——花括号内的 '|' 不是顶层分词点
            if (c === '<' || c === '{') { depth++; cur += c; }
            else if (c === '>' || c === '}') { depth--; cur += c; }
            else if (c === '|' && depth === 0) { out.push(cur); cur = ''; }
            else cur += c;
        }
        out.push(cur);
        return out;
    }
    function joinTypes(arr) {
        var seen = {}, out = [];
        for (var i = 0; i < arr.length; i++) {
            var parts = splitTypes(arr[i]);
            for (var j = 0; j < parts.length; j++) {
                if (parts[j] === '' || has(seen, parts[j])) continue;
                seen[parts[j]] = 1;
                out.push(parts[j]);
            }
        }
        // 同族吸收：形状串吸收裸 'user-object'——两者未记录键的语义
        // 完全相同（任意静态键放行、结果 'u'），形状严格更精，留着裸项只会让
        // 定点迭代里「空字面量声明 ∪ 成员赋值形状」叠成 'Layer|u' 这类脏串
        if (out.length > 1) {
            var hasShape = false;
            for (var s = 0; s < out.length; s++) {
                if (isObjShape(out[s])) { hasShape = true; break; }
            }
            if (hasShape) {
                var kept = [];
                for (var k = 0; k < out.length; k++) {
                    if (out[k] !== 'user-object') kept.push(out[k]);
                }
                out = kept;
            }
        }
        return out.length === 1 ? out[0] : (out.length === 0 ? 'u' : out.join('|'));
    }
    function unionList(list) {
        var seen = {}, out = [];
        for (var i = 0; i < list.length; i++) {
            var parts = splitTypes(list[i] === '' ? 'u' : list[i]);
            for (var j = 0; j < parts.length; j++) {
                if (parts[j] === '' || has(seen, parts[j])) continue;
                seen[parts[j]] = 1;
                out.push(parts[j]);
            }
        }
        return out;
    }
    function arrayElemOf(t) {
        if (t === 'array') return 'u';
        var m = /^array<(.+)>$/.exec(t);
        return m ? m[1] : null; // 非 array 类型返回 null
    }

    // ── 对象字面量形状 ─────────────────────────────────
    // 形状类型串形态：user-object{k1:T1,k2:T2}（值类型可为 array<X>/嵌套形状——
    // 嵌套的 {} 与 <> 由深度计法配平，顶层条目以 ',' 分隔、以首个 ':' 分键值）。
    // 设计口径（「只锐化不收紧」）：
    //   · 只对**本脚本字面量**生效——解析结果（JSON.parse 等）仍是裸 'u'，
    //     unknown 二次成员拒的对抗性守卫不受影响；
    //   · 未记录的键（计算键/值为 'u' 的键/动态新增的键）回落与裸 user-object
    //     完全相同的 {t:'u',w:1}——不放宽也不收紧既有判定；
    //   · 值类型原样取自类型表，域闸/受限否决/元属性黑名单全在既有挂点上判定，
    //     形状不携带任何新的放行能力。
    function isObjShape(t) {
        // 单一形状才认（成员类型可含联合——花括号内 '|' 不算顶层分词；
        // 形状的联合串由 unionList/splitTypes 拆分后逐个到达，不在此处理）
        var s = String(t);
        return s.indexOf('user-object{') === 0 && splitTypes(s).length === 1;
    }

    // 形状串 → {键: 类型串}；畸形返回 null（调用方按裸 user-object 回落）
    function parseObjShape(t) {
        var s = String(t), open = s.indexOf('{');
        if (open < 0 || s.charAt(s.length - 1) !== '}') return null;
        var body = s.substring(open + 1, s.length - 1);
        var out = {}, depth = 0, cur = '', entries = [];
        for (var i = 0; i < body.length; i++) {
            var c = body.charAt(i);
            if (c === '{' || c === '<') depth++;
            else if (c === '}' || c === '>') depth--;
            if (c === ',' && depth === 0) { entries.push(cur); cur = ''; continue; }
            cur += c;
        }
        if (cur !== '' || entries.length) entries.push(cur);
        for (var j = 0; j < entries.length; j++) {
            var idx = entries[j].indexOf(':');
            if (idx <= 0) continue;
            var k = entries[j].substring(0, idx);
            if (!has(out, k)) out[k] = entries[j].substring(idx + 1);
        }
        return out;
    }

    // 形状成员读取（含裸 user-object 语义）：命中记真实类型，未命中记 'u'
    function shapeEntry(t, name) {
        if (t === 'user-object') return { t: 'u', w: 1 };
        var shape = parseObjShape(t);
        if (shape && has(shape, name)) return { t: shape[name], w: 1 };
        return { t: 'u', w: 1 };
    }

    // 形状重建（{键: 类型} → 串；空形状回落裸 'user-object'）
    function shapeRebuild(shape) {
        var parts = [];
        for (var k in shape) {
            if (has(shape, k)) parts.push(k + ':' + shape[k]);
        }
        return parts.length ? ('user-object{' + parts.join(',') + '}') : 'user-object';
    }

    // 形状增补（o.prop = expr 事件）：仅当前类型已是单一用户对象/形状时并入成员。
    // 同键异类型 = 类型并集（与变量侧「声明 ∪ 赋值位」同一语义——any-member 放行，
    // 不记成错类型）；值类型为 'u' 时不收录（无信息）
    function shapeWithMember(cur, key, vt) {
        if (cur === '' || cur === 'u') return cur;           // 无类型信息，不凭空造形状
        if (cur !== 'user-object' && !isObjShape(cur)) return cur; // DOM/数组/形状联合等不动
        if (!vt || vt === 'u') return cur;
        var shape = (cur === 'user-object') ? {} : parseObjShape(cur);
        if (!shape) return cur;
        shape[key] = has(shape, key) ? joinTypes([shape[key], vt]) : vt;
        return shapeRebuild(shape);
    }

    // 构造串/错误文案显示名：形状按裸 user-object 呈现（错误信息可读性与既有
    // 断言口径一致——形状是实现细节，不该泄漏进 LLM 自修正回路）
    function displayTypeName(t) {
        var s = String(t), out = '', i = 0, tag = 'user-object';
        while (i < s.length) {
            var at = s.indexOf(tag + '{', i);
            if (at < 0) { out += s.substring(i); break; }
            out += s.substring(i, at) + tag;
            var depth = 0, j = at + tag.length;
            for (; j < s.length; j++) {
                var c = s.charAt(j);
                if (c === '{') depth++;
                else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
            }
            i = j;
        }
        return out;
    }

    // 对象字面量 → 形状类型串（空字面量/无可用键回落裸 'user-object'）
    // 同键重复（{a:1, a:"x"}）→ 类型并集（与变量侧同语义）；值为 'u' 不收录
    function objShapeType(node, state) {
        var shape = {}, order = [];
        for (var i = 0; i < node.properties.length; i++) {
            var p = node.properties[i];
            if (!p || p.type !== 'Property' || p.computed) continue;  // 计算键不可静态命名
            if (!p.key || p.key.type !== 'Identifier') continue;      // 字符串键走计算面
            var key = p.key.name;
            var vt = inferType(p.value, state);
            if (!vt || vt === 'u') continue;                          // 无信息：不收录
            if (has(shape, key)) shape[key] = joinTypes([shape[key], vt]);
            else { shape[key] = vt; order.push(key); }
        }
        if (!order.length) return 'user-object';
        var parts = [];
        for (var j = 0; j < order.length; j++) parts.push(order[j] + ':' + shape[order[j]]);
        return 'user-object{' + parts.join(',') + '}';
    }

    // 单类型上成员条目解析（纯查询，不记错误）：返回 entry 或 null
    // ignoreGate：跳过域闸抑制取原始条目（memberOn 溯源 gated 域用）
    function entryOn(T, typeName, name, ignoreGate) {
        if (typeName === 'u') return null;
        if (typeName === 'user-object' || isObjShape(typeName)) {
            // 用户对象：任意静态键放行，结果 unknown（动态键由 computed 路径处理）
            // 形状形态：已记录键取真实类型（锐化），未记录键照旧 'u'
            return shapeEntry(typeName, name);
        }
        if (typeName === 'ui-object') {
            // ScriptUI 动态面（仅弹窗通道可达——new Window 在
            // 非 DIALOG_SOURCES 被 checkIdentifierUse 拒）：任意静态键可读/写/调，
            // 结果自传播（w.btn.onClick 链式）；META 黑名单在 checkMember 先行
            return { t: 'ui-object', m: 'm', w: 1 };
        }
        var m = arrayElemOf(typeName);
        if (m !== null) {
            var ae = has(T.PRIM.array, name) ? T.PRIM.array[name] : null;
            if (ae) {
                var copy = {};
                for (var k in ae) copy[k] = ae[k];
                if (copy.t === 'self') copy.t = typeName;
                return copy;
            }
            return null;
        }
        if (typeName === 'array') {
            return has(T.PRIM.array, name) ? T.PRIM.array[name] : null;
        }
        if (has(T.PRIM, typeName)) {
            return has(T.PRIM[typeName], name) ? T.PRIM[typeName][name] : null;
        }
        if (has(T.TYPES, typeName)) {
            var tbl = T.TYPES[typeName];
            if (!has(tbl, name)) return null;
            var e = tbl[name];
            // 域闸：条目 d 标志（类型面受控成员——FileHandle/FolderObj 的 file
            // 域条目）或 POLICY_GATED.members 名挂点（executeCommand→menu）——
            // 域关即抑制（现行拒路径保持， 未收录语义不变）
            // dlg 弹窗族闸：WithDialog 类成员仅 Script 通道放行
            // （Agent 通道弹窗挂起 AE——抑制同构域闸）
            if (!ignoreGate) {
                if (e.dlg && !_dialogSourceOpen()) return null;
                var gd = e.d || (has(T.POLICY_GATED.members, name)
                    ? T.POLICY_GATED.members[name].domain : null);
                if (gd && !_domainOpen(gd)) return null;
            }
            return e;
        }
        return null;
    }

    // 联合成员判定（核心语义：any-member + 受限类型否决）
    // 返回 { ok, t, restricted, gated }；flags: {write, call}
    // gated：拒绝由域闸抑制引起时标注域名（error.domain 附注）
    function memberOn(T, recvTypes, name, flags) {
        var restricted = false;
        for (var i = 0; i < recvTypes.length; i++) {
            if (has(T.RESTRICTED_TYPES, recvTypes[i])) { restricted = true; break; }
        }
        var allowCount = 0, denyCount = 0, entries = [];
        var gatedDomain = null, gatedDialog = false;
        // 三态归因——拒绝时区分「成员不存在 / 只读 / 能力域未开启」。
        // 两个标志只在对应类型上置位，供 fail 分支组织文案；判定语义与放行集合不变。
        var missing = false, readonly = false;
        for (var j = 0; j < recvTypes.length; j++) {
            var e = entryOn(T, recvTypes[j], name);
            if (e) {
                if (flags.write && !e.w) e = null;
                if (flags.call && e.m !== 'm') e = null;
            }
            if (e) { allowCount++; entries.push(e); }
            else {
                denyCount++;
                var raw = entryOn(T, recvTypes[j], name, true);
                if (!raw) missing = true;
                else if (flags.write && !raw.w) readonly = true;
                // 域闸/弹窗闸抑制溯源：条目在但被域关/非 Script 通道抑制
                //（否则是未收录/只读——无域）
                if (gatedDomain === null && !gatedDialog) {
                    if (raw && !(flags.write && !raw.w) && !(flags.call && raw.m !== 'm')) {
                        if (raw.dlg && !_dialogSourceOpen()) { gatedDialog = true; }
                        else {
                            var gd2 = raw.d || (has(T.POLICY_GATED.members, name)
                                ? T.POLICY_GATED.members[name].domain : null);
                            if (gd2 && !_domainOpen(gd2)) gatedDomain = gd2;
                        }
                    }
                }
            }
        }
        // 受限否决：联合含受限类型时须全员允许（交集）；否则任一允许（any-member）
        var ok = recvTypes.length === 0 ? false :
            (restricted ? (denyCount === 0) : (allowCount > 0));
        var t = entries.length ? joinTypes(entries.map(function (e2) { return e2.t; })) : 'u';
        return {
            ok: ok, t: t, restricted: restricted, gated: gatedDomain, dlg: gatedDialog,
            missing: missing, readonly: readonly
        };
    }

    // 错名替代：按接收者类型查 tables.MEMBER_ALIAS。
    // 只在命中时返回正确成员名，未命中返回空串——不做通用模糊匹配。
    function aliasFor(T, recvTypes, name) {
        var tbl = T.MEMBER_ALIAS || {};
        for (var i = 0; i < recvTypes.length; i++) {
            var m = tbl[recvTypes[i]];
            if (m && has(m, name)) return m[name];
        }
        return '';
    }

    // 未收录成员的正确官方替代：按接收者类型查 tables.MEMBER_REPLACEMENTS。
    // 只产出诊断文案（{type, text}），**不参与放行判定**——未收录成员照旧拒。
    // 联合接收者（含 'u'）只要有一个具名类型命中即算命中——指路比「unknown 上
    // 成员访问一律拒」的通用解释更具体。
    function memberReplacementFor(T, recvTypes, name) {
        var tbl = T.MEMBER_REPLACEMENTS || {};
        for (var i = 0; i < recvTypes.length; i++) {
            var t = recvTypes[i];
            if (has(tbl, t) && has(tbl[t], name)) return { type: t, text: tbl[t][name] };
        }
        return null;
    }

    // 同名成员的其它接收者类型（三态归因 state ②）：扫种子/增补类型表，找
    // 「本接收者没有、别的类型收录」的成员名，供拒绝文案指路。只做诊断——
    // 候选类型排除受限类型与域闸/弹窗闸条目（那些接收者上调用仍会被拒，
    // 推荐等于制造第二次失败）。
    function otherReceiversFor(T, recvTypes, name) {
        var out = [];
        for (var tn in T.TYPES) {
            if (!has(T.TYPES, tn)) continue;
            if (recvTypes.indexOf(tn) >= 0) continue;
            if (has(T.RESTRICTED_TYPES, tn)) continue;
            var e = T.TYPES[tn];
            if (!has(e, name)) continue;
            var entry = e[name] || {};
            if (entry.d || entry.dlg) continue;
            if (T.POLICY_GATED && T.POLICY_GATED.members && has(T.POLICY_GATED.members, name)) continue;
            out.push(tn);
        }
        return out;
    }

    // 方法引用值上的 apply/call（不做放行，只改诊断）。
    // 门不建模函数值成员（TYPES.function 空表），故「取方法引用再 apply」一律拒；
    // 这里只把原因说清并给可执行重写，不放宽放行面。
    function methodRefApplyHint(T, node, state) {
        if (!node || node.property.type !== 'Identifier') return '';
        var nm = node.property.name;
        if (nm !== 'apply' && nm !== 'call') return '';
        var obj = node.object;
        if (obj && obj.type === 'MemberExpression' && !obj.computed && obj.property.type === 'Identifier') {
            var r2 = unionList([inferType(obj.object, state)]);
            var mv2 = memberOn(T, r2, obj.property.name, { call: true });
            if (mv2.ok) {
                var _label = obj.property.name;
                if (obj.object && obj.object.type === 'Identifier') _label = obj.object.name + '.' + _label;
                return '这是从对象上取下的方法引用（' + _label + '），门不建模函数值成员——'
                    + '请直接写方法调用（如 Math.max(a, b)），对数组求最值用循环比较';
            }
        }
        return '门不建模函数值的 apply/call 成员：若这是方法引用，请直接调用原方法；'
            + '对数组求最值可写 Math.max(a, b) 或循环比较';
    }

    // 零参模态闸溯源（noArgModal 条目标志）：该成员的**零参**形态会弹系统模态时返回 true。
    // 与 dlg 的区别：dlg 是「这条成员一律不能在 Agent 通道用」，本项是「只有零参形态不行」
    //（Project.save(file) 是另存语义、不弹模态）——故判定要看调用实参个数，见调用点。
    function noArgModalOn(T, recvTypes, name) {
        for (var i = 0; i < recvTypes.length; i++) {
            var e = entryOn(T, recvTypes[i], name, true);
            if (e && e.noArgModal) return true;
        }
        return false;
    }

    // 空实参等价判定（零参模态闸用）：零参 | 单个 null/undefined 字面量 | void 表达式——
    // 三者对 AE 都是「没给 file」，与零参同风险（未保存过的工程走「另存为」模态）。
    // 已知边界：`var f = null; save(f)` 这类经变量的空值不在静态判定面内（如实记录，不假装覆盖）。
    function isEmptyArgs(args) {
        if (!args || args.length === 0) return true;
        if (args.length !== 1) return false;
        var a0 = args[0];
        if (!a0) return false;
        if (a0.type === 'Literal' && (a0.value === null || a0.value === undefined)) return true;
        if (a0.type === 'Identifier' && a0.name === 'undefined') return true;
        if (a0.type === 'UnaryExpression' && a0.operator === 'void') return true;
        return false;
    }

    // 计算键策略（④ 分治）：返回 { ok, t }——纯策略查询
    function computedOn(T, recvTypes, propNode) {
        var isStrLit = propNode.type === 'Literal' && typeof propNode.value === 'string';
        var results = [];
        for (var i = 0; i < recvTypes.length; i++) {
            var t = recvTypes[i];
            if (t === 'user-object' || isObjShape(t)) { results.push('u'); continue; } // 动态键放行 → unknown
            // 修复：ScriptUI 计算键仅字面量自传播（w['btnName'] 合法动态子控件），
            // 非字面量（拼接/变量键）降 'u'——原自传播允许任意深度链
            // w['constr'+'uctor']['constr'+'uctor'] 每跳保持 ui-object 过门，
            // 运行时取得 Function；降 'u' 后下一跳 computed 按 unknown 拒（fail-closed）。
            // META 名字面量键（w['constructor']）已在 checkMember 黑名单先行拒。
            if (t === 'ui-object') { results.push(isStrLit ? 'ui-object' : 'u'); continue; }
            // 已登记集合类型（tables.COLLECTIONS）：数值下标返回元素类型；字符串字面量键拒
            if (T.COLLECTIONS && has(T.COLLECTIONS, t)) {
                if (isStrLit) continue;
                results.push(T.COLLECTIONS[t]);
                continue;
            }
            var elem = arrayElemOf(t);
            if (elem !== null) { // 数组：字符串字面量键拒，其余（数值索引假定）放行
                if (isStrLit) continue;
                results.push(elem);
                if (t === 'array') results.push('u');
                continue;
            }
            if (t === 'array') {
                if (!isStrLit) results.push('u');
                continue;
            }
            // DOM / unknown / primitive：computed 一律拒（类型规则才有挂点）
        }
        return { ok: results.length > 0, t: joinTypes(results.length ? results : ['u']) };
    }

    // ── 推导入口（纯函数——错误只在严格 walk 的检查点记录）────────────
    function inferType(node, state) {
        if (!node || typeof node !== 'object') return 'u';
        var T = state.T, env = state.env;
        switch (node.type) {
            case 'Identifier':
                if (has(state.declared, node.name)) {
                    return env.varTypes[node.name] || 'u';
                }
                if (has(T.IDENTIFIERS, node.name)) {
                    var k = T.IDENTIFIERS[node.name];
                    if (k === 'ae-global') return 'app';
                    if (k === 'builtin-object') return node.name; // Math/JSON
                    if (k === 'builtin-call') return 'String-obj';
                    if (k === 'ae-class') return 'AEClass';
                    if (k === 'ae-ctor') return 'AEClass'; // 类对象面密封（成员全拒；实例面走 NewExpression）
                    // builtin-ctor 作值：类型表有同名条目（Date）→ 对象面（静态
                    // 成员 parse/UTC 经表受控）；无条目（Error）→ 'u' 原行为
                    if (k === 'builtin-ctor') return has(T.TYPES, node.name) ? node.name : 'u';
                    return 'u'; // host-fn/builtin-fn/literal作值
                }
                // policy 挂点（数据驱动—— system 特判由表条目承载）：域开按 type
                // 解析进类型链（成员面仍受类型表约束），无 type 按值 'u'（裸调用面）
                if (has(T.POLICY_GATED.identifiers, node.name)) {
                    var pg = T.POLICY_GATED.identifiers[node.name];
                    if (_domainOpen(pg.domain)) return pg.type || 'u';
                    return 'u';
                }
                return 'u';
            case 'ThisExpression':
                return 'GlobalThis';
            case 'Literal':
                if (node.value === null) return '';
                if (node.regex) return 'RegExp';
                if (typeof node.value === 'string') return 'string';
                if (typeof node.value === 'number') return 'number';
                if (typeof node.value === 'boolean') return 'boolean';
                return 'u';
            case 'ArrayExpression': {
                var elems = [];
                for (var i = 0; i < node.elements.length; i++) {
                    elems.push(node.elements[i] ? inferType(node.elements[i], state) : 'u');
                }
                return 'array<' + joinTypes(elems) + '>';
            }
            case 'ObjectExpression':
                // 字面量携带成员类型（objShapeType）——「包装再取用」
                // （把 Layer/数值塞进 {…}、经数组排序后取回成员）是 LLM 高频写法，
                // 一律记裸 user-object 会导致二次成员访问被 fail-closed 误拦
                return objShapeType(node, state);
            case 'FunctionExpression':
                return 'function';
            case 'MemberExpression': {
                var recv = unionList([inferType(node.object, state)]);
                if (node.computed) {
                    return computedOn(T, recv, node.property).t;
                }
                if (node.object.type === 'ThisExpression') {
                    // this.X 已由表②分支核对——类型仅映射内建对象
                    var nm = node.property.name;
                    if (nm === 'Math' || nm === 'JSON') return nm;
                    if (nm === 'app') return 'app';
                    return 'u';
                }
                var v = memberOn(T, recv, node.property.name, {});
                return v.ok ? v.t : 'u';
            }
            case 'CallExpression':
                return inferCall(node, state);
            case 'NewExpression':
                // new Error(...) → ESException（message/name/toString 成员面）
                if (node.callee.type === 'Identifier' && node.callee.name === 'Error') return 'ESException';
                // new Window(...) → ui-object（ScriptUI 动态面——仅弹窗通道可达；
                // 非弹窗通道在 checkIdentifierUse DIALOG 分支拒，此处类型供链式成员）
                if (node.callee.type === 'Identifier' && node.callee.name === 'Window') return 'ui-object';
                // AE 数据构造器（new KeyframeEase/Shape/MarkerValue）→
                // 类型表同名类型（TYPES 条目承载成员面）
                if (node.callee.type === 'Identifier' &&
                    T.IDENTIFIERS[node.callee.name] === 'ae-ctor') return node.callee.name;
                // 内建构造器（new Date）→ 类型表同名类型（Error 先行
                // 特判 ESException，不受本分支影响；无同名条目的 builtin-ctor
                // 保持 'u'）
                if (node.callee.type === 'Identifier' &&
                    T.IDENTIFIERS[node.callee.name] === 'builtin-ctor' &&
                    has(T.TYPES, node.callee.name)) return node.callee.name;
                // 域开构造器（new File/new Socket/new Folder…）按 type 解析
                // 进类型链——下游成员面（f.open("w") 等）经类型表受控
                if (node.callee.type === 'Identifier' &&
                    has(T.POLICY_GATED.identifiers, node.callee.name) &&
                    _domainOpen(T.POLICY_GATED.identifiers[node.callee.name].domain)) {
                    return T.POLICY_GATED.identifiers[node.callee.name].type || 'u';
                }
                return 'u';
            case 'UnaryExpression':
                if (node.operator === 'typeof') return 'string';
                if (node.operator === '!') return 'boolean';
                if (node.operator === 'delete') return 'boolean';
                if (node.operator === 'void') return '';
                return 'number';
            case 'UpdateExpression':
                return 'number';
            case 'BinaryExpression':
                if (node.operator === '+') return 'string|number';
                if (node.operator === '===' || node.operator === '!==' || node.operator === '==' ||
                    node.operator === '!=' || node.operator === '<' || node.operator === '>' ||
                    node.operator === '<=' || node.operator === '>=' ||
                    node.operator === 'in' || node.operator === 'instanceof') return 'boolean';
                return 'number';
            case 'LogicalExpression':
                return joinTypes([inferType(node.left, state), inferType(node.right, state)]);
            case 'ConditionalExpression':
                return joinTypes([inferType(node.consequent, state), inferType(node.alternate, state)]);
            case 'SequenceExpression': {
                var last = node.expressions[node.expressions.length - 1];
                return inferType(last, state);
            }
            case 'AssignmentExpression':
                return inferType(node.right, state);
            default:
                return 'u';
        }
    }

    function inferCall(node, state) {
        var T = state.T, env = state.env;
        var callee = node.callee;
        if (callee.type === 'Identifier') {
            if (has(state.declared, callee.name)) {
                return env.fnReturns[callee.name] || 'u';
            }
            if (has(T.IDENTIFIERS, callee.name)) {
                var k = T.IDENTIFIERS[callee.name];
                if (k === 'builtin-call') return 'string';           // String(x)
                if (k === 'builtin-fn') {
                    // 返回类型数据驱动（tables.BUILTIN_FN_RETURNS——isNaN/isFinite
                    // 均在此表；URI 编解码/AE 原生全局随表维护），缺省 number
                    return (T.BUILTIN_FN_RETURNS && has(T.BUILTIN_FN_RETURNS, callee.name))
                        ? T.BUILTIN_FN_RETURNS[callee.name] : 'number';
                }
                return 'u'; // host-fn / ae-global 调用由严格层拒
            }
            // 无 new 惯用法构造（ExtendScript File("x") 合法形态）——域开
            // 构造器按 type 解析（与 NewExpression 同构）
            if (has(T.POLICY_GATED.identifiers, callee.name) &&
                _domainOpen(T.POLICY_GATED.identifiers[callee.name].domain)) {
                return T.POLICY_GATED.identifiers[callee.name].type || 'u';
            }
            return 'u';
        }
        if (callee.type === 'FunctionExpression') {
            return env.fnRetByNode[callee.__fnId] || 'u';
        }
        if (callee.type === 'MemberExpression') {
            var recv = unionList([inferType(callee.object, state)]);
            if (callee.computed) return 'u';
            var v = memberOn(T, recv, callee.property.name, { call: true });
            return v.ok ? v.t : 'u';
        }
        return 'u';
    }

    // ── pass 1：类型环境（定点迭代）──────────────────────────────
    // 原生数组方法 → 回调参数中的元素位（0 基）：sort 比较器双元素位；
    // forEach/map/filter/some/every 首参元素位；reduce 仅 cur（位 1——acc
    // 聚合类型不可静态知，保持 'u'）。PRIM.array 之外的成员本就在成员检查
    // 拒，此表只管「已收录方法的回调参数注入」（arr.sort(
    // function(a,b){ return a.si - b.si }) 形态回调参数落 'u' 时误拒）。
    var _ITER_CB = {
        'sort': [0, 1], 'forEach': [0], 'map': [0], 'filter': [0],
        'some': [0], 'every': [0], 'reduce': [1]
    };

    function buildTypeEnv(ast, state) {
        var T = state.T;
        var env = {
            varTypes: {},    // 变量名 → 类型
            fnReturns: {},   // 函数名 → return 并集
            fnRetByNode: {}, // 函数节点 id → return 并集（匿名 IIFE）
            fnNodes: {},     // 函数名 → [函数节点]
            callSites: [],   // { fn: name, args: [expr] }——用户函数调用点
            typeEvents: [],  // { name, expr }——声明 init 与赋位按源码顺序（统一事件流）
            cbSites: []      // { name, method, fn|fnName }——原生数组方法回调点（迭代轮内注入元素类型）
        };
        var fnId = 0;

        // 收集函数节点/名字关联 + 调用点 + 类型事件（一次遍历，源码顺序）
        (function collect(node, fnName) {
            if (!node || typeof node !== 'object') return;
            var t = node.type;
            if (t === 'FunctionDeclaration' || t === 'FunctionExpression') {
                node.__fnId = 'f' + (fnId++);
                var name = node.id ? node.id.name : fnName;
                if (name) {
                    env.fnNodes[name] = env.fnNodes[name] || [];
                    env.fnNodes[name].push(node);
                }
                for (var p = 0; node.params && p < node.params.length; p++) {
                    collect(node.params[p], null);
                }
                collect(node.body, name);
                return;
            }
            if (t === 'VariableDeclarator' && node.id && node.id.type === 'Identifier' && node.init) {
                if (node.init.type === 'FunctionExpression') {
                    node.init.__fnId = 'f' + (fnId++);
                    env.fnNodes[node.id.name] = env.fnNodes[node.id.name] || [];
                    env.fnNodes[node.id.name].push(node.init);
                    collect(node.init.body, node.id.name);
                } else {
                    env.typeEvents.push({ name: node.id.name, expr: node.init });
                    collect(node.init, fnName);
                }
                return;
            }
            if (t === 'AssignmentExpression' && node.left.type === 'Identifier' &&
                has(state.declared, node.left.name)) {
                env.typeEvents.push({ name: node.left.name, expr: node.right });
            }
            if (t === 'CallExpression' && node.callee.type === 'Identifier' &&
                has(state.declared, node.callee.name)) {
                env.callSites.push({ fn: node.callee.name, args: node['arguments'] });
            }
            // 数组元素增长：arr.push(x) / arr[i] = x（事件流同源收集）
            if (t === 'CallExpression' && node.callee.type === 'MemberExpression' &&
                !node.callee.computed && node.callee.property.name === 'push' &&
                node.callee.object.type === 'Identifier' && has(state.declared, node.callee.object.name)) {
                env.typeEvents.push({ name: node.callee.object.name, args: node['arguments'] });
            }
            // 原生数组方法回调点：回调为函数表达式（节点直存）或已声明标识符
            //（按名解析 fnNodes——具名函数/函数表达式变量；解析不中则不注入）
            if (t === 'CallExpression' && node.callee.type === 'MemberExpression' &&
                !node.callee.computed && has(_ITER_CB, node.callee.property.name) &&
                node.callee.object.type === 'Identifier' && has(state.declared, node.callee.object.name) &&
                node['arguments'].length > 0) {
                var cbArg = node['arguments'][0];
                if (cbArg.type === 'FunctionExpression') {
                    env.cbSites.push({ name: node.callee.object.name, method: node.callee.property.name, fn: cbArg });
                } else if (cbArg.type === 'Identifier' && has(state.declared, cbArg.name)) {
                    env.cbSites.push({ name: node.callee.object.name, method: node.callee.property.name, fnName: cbArg.name });
                }
            }
            if (t === 'AssignmentExpression' && node.left.type === 'MemberExpression' &&
                node.left.computed && node.left.object.type === 'Identifier' &&
                has(state.declared, node.left.object.name)) {
                env.typeEvents.push({ name: node.left.object.name, elemAssign: node.right });
            }
            // 形状成员增补：o.prop = expr（o 已是用户对象/形状时才并入——DOM/数组不动，
            // 判定在 shapeWithMember 内；同一「包装再取用」家族的赋值式写法）
            if (t === 'AssignmentExpression' && node.left.type === 'MemberExpression' &&
                !node.left.computed && node.left.object.type === 'Identifier' &&
                has(state.declared, node.left.object.name) && node.left.property &&
                node.left.property.type === 'Identifier') {
                env.typeEvents.push({
                    name: node.left.object.name, propName: node.left.property.name, expr: node.right
                });
            }
            for (var k in node) {
                if (k === 'loc' || k === 'range') continue;
                var v = node[k];
                if (Array.isArray(v)) {
                    for (var i = 0; i < v.length; i++) collect(v[i], fnName);
                } else if (v && typeof v === 'object' && typeof v.type === 'string') {
                    collect(v, fnName);
                }
            }
        })(ast, null);

        // 定点迭代（类型只增，≤8 轮；跨轮持久 + 轮内即时写回——源码顺序声明链
        // 一轮即达，跨轮处理前向引用/参数→使用链）。
        // 上限 4→8——三级 helper 链（addStroke → addProperty）
        // 每轮先用前一轮 fnReturns 再算调用点形参，4 轮收不敛时形参停在 unknown，
        // 合法脚本被 fail-closed 误拒。8 轮只补表内类型、不新增成员/能力。
        for (var round = 0; round < 8; round++) {
            // 跨轮持久：前一轮类型是当前轮基线（否则 param 类型轮末即丢，迭代失效）
            var newVarTypes = {};
            var prevTypes = env.varTypes || {};
            for (var pk in prevTypes) {
                if (has(prevTypes, pk)) newVarTypes[pk] = prevTypes[pk];
            }
            env.varTypes = newVarTypes; // 轮内即时可见（推断读到最新类型）

            // catch 参数种子：ESException（e.toString()/e.message 实证形态）
            (function seedCatch(node) {
                if (!node || typeof node !== 'object') return;
                if (node.type === 'CatchClause' && node.param && node.param.type === 'Identifier') {
                    newVarTypes[node.param.name] = joinTypes([newVarTypes[node.param.name] || '', 'ESException']);
                }
                for (var kc in node) {
                    if (kc === 'loc' || kc === 'range') continue;
                    var vc = node[kc];
                    if (Array.isArray(vc)) { for (var ic = 0; ic < vc.length; ic++) seedCatch(vc[ic]); }
                    else if (vc && typeof vc === 'object' && typeof vc.type === 'string') seedCatch(vc);
                }
            })(ast);

            // 类型事件流：源码顺序处理（声明 init 与赋值交错——
            // var comp=null; comp=it; var f=comp.layer(1) 一轮内顺序成立）
            for (var e = 0; e < env.typeEvents.length; e++) {
                var ev = env.typeEvents[e];
                var cur = newVarTypes[ev.name] || '';
                if (ev.args) {
                    // push 事件：元素类型增长（u 容器视作 array<u> 起点）
                    var elem0 = arrayElemOf(cur);
                    if (elem0 === null) elem0 = (cur === '' ? 'u' : 'u');
                    for (var ai = 0; ai < ev.args.length; ai++) {
                        var at = inferType(ev.args[ai], { T: T, declared: state.declared, env: env });
                        elem0 = joinTypes([elem0, at]);
                    }
                    newVarTypes[ev.name] = 'array<' + elem0 + '>';
                } else if (ev.elemAssign) {
                    // 元素赋值事件：仅已是数组类型时增长（用户对象 arr-like 不动）
                    var eaCur = newVarTypes[ev.name] || 'u';
                    if (arrayElemOf(eaCur) !== null) {
                        var at2 = inferType(ev.elemAssign, { T: T, declared: state.declared, env: env });
                        newVarTypes[ev.name] = 'array<' + joinTypes([arrayElemOf(eaCur), at2]) + '>';
                    }
                } else if (ev.propName) {
                    // 形状成员增补事件（o.prop = expr）：仅用户对象/形状时并入
                    var at3 = inferType(ev.expr, { T: T, declared: state.declared, env: env });
                    newVarTypes[ev.name] = shapeWithMember(newVarTypes[ev.name] || '', ev.propName, at3);
                } else {
                    var t2 = inferType(ev.expr, { T: T, declared: state.declared, env: env });
                    newVarTypes[ev.name] = joinTypes([cur, t2]);
                }
            }

            // 原生数组方法回调参数：∪= 数组元素类型（隐式调用建模——回调由原生
            // 方法以元素实参调用，运行时真实性成立）。安全方向：元素含 'u' 时
            // 注入后仍含 'u'（成员访问照拒）；受限类型否决权/域闸均不受影响
            //（仅类型环境更准，拒绝语义不动）。接收者未推导为数组时不注入
            //（回调参数保持 'u'——宁缺勿滥）。
            for (var cb = 0; cb < env.cbSites.length; cb++) {
                var cbs = env.cbSites[cb];
                var elCb = arrayElemOf(newVarTypes[cbs.name] || '');
                if (elCb === null) continue;
                var cbNodes = cbs.fnName ? (env.fnNodes[cbs.fnName] || []) : [cbs.fn];
                for (var cn = 0; cn < cbNodes.length; cn++) {
                    var cbParams = cbNodes[cn].params || [];
                    var cbPos = _ITER_CB[cbs.method];
                    for (var cp = 0; cp < cbPos.length; cp++) {
                        var cbP = cbParams[cbPos[cp]];
                        if (cbP && cbP.type === 'Identifier') {
                            newVarTypes[cbP.name] = joinTypes([newVarTypes[cbP.name] || '', elCb]);
                        }
                    }
                }
            }

            // 函数返回类型：return 表达式并集（按节点 + 按名字）
            var newFnRetByNode = {};
            for (var fname in env.fnNodes) {
                if (!has(env.fnNodes, fname)) continue;
                var nodes = env.fnNodes[fname];
                var acc = '';
                for (var n = 0; n < nodes.length; n++) {
                    var racc = '';
                    (function collectReturns(nd) {
                        if (!nd || typeof nd !== 'object') return;
                        if (nd.type === 'ReturnStatement' && nd.argument) {
                            racc = joinTypes([racc, inferType(nd.argument, { T: T, declared: state.declared, env: env })]);
                        }
                        if (nd.type === 'FunctionDeclaration' || nd.type === 'FunctionExpression') {
                            if (nd !== nodes[n]) return; // 嵌套函数的 return 归其自身
                        }
                        for (var k2 in nd) {
                            if (k2 === 'loc' || k2 === 'range') continue;
                            var v2 = nd[k2];
                            if (Array.isArray(v2)) { for (var i2 = 0; i2 < v2.length; i2++) collectReturns(v2[i2]); }
                            else if (v2 && typeof v2 === 'object' && typeof v2.type === 'string') collectReturns(v2);
                        }
                    })(nodes[n].body);
                    newFnRetByNode[nodes[n].__fnId] = racc;
                    acc = joinTypes([acc, racc]);
                }
                env.fnReturns[fname] = acc;
            }
            env.fnRetByNode = newFnRetByNode;

            // 参数类型：调用点实参并集（并入同名变量类型——参数即脚本级变量）
            for (var c = 0; c < env.callSites.length; c++) {
                var cs = env.callSites[c];
                var fnNodes2 = env.fnNodes[cs.fn];
                if (!fnNodes2 || !fnNodes2.length) continue;
                for (var pn = 0; pn < cs.args.length; pn++) {
                    var argT = inferType(cs.args[pn], { T: T, declared: state.declared, env: env });
                    var param = null;
                    for (var q = 0; q < fnNodes2.length; q++) {
                        if (fnNodes2[q].params && fnNodes2[q].params[pn] && fnNodes2[q].params[pn].type === 'Identifier') {
                            param = fnNodes2[q].params[pn].name; break;
                        }
                    }
                    if (param) {
                        newVarTypes[param] = joinTypes([newVarTypes[param] || '', argT]);
                    }
                }
            }
        }
        return env;
    }

    // domain：policy 拒绝附 error.domain（system/socket/file/menu——
    // llm-preview 域确认弹窗的输入信号）；逃逸形态/硬拒不传（无域）
    // 单条拒信的总长上限。
    // 为什么需要：拒信的 construct/reason 会**回显脚本里的名字**（如 MemberCall 路径把接收者
    // 类型名与成员名各回显两次）——常规类实测 211–413 字符，但脚本里塞一个 2000 字符的成员名时
    // 单条涨到 4244（实测）。面板侧有 32K 工具结果兜底接住，**外接通道不经过该兜底**；
    // 且一次 gate 只回第一条错误（不因多错并发累加），所以只需给单条设界。
    // 上限取 1024：常规拒信最长 413，留 2.4 倍余量——不会碰到任何正常文案，只在病态名字上生效，
    // 且**显式**标注截断（不静默，符合本仓库「宁可啰嗦不可静默」的口径）。
    var ERR_TEXT_MAX = 1024;
    // 整条上限：上面是**每字段**上限——三个字段各 1024 时
    // 「整条」实测 2148（displayText 2254），而外接通道的预算只有 2000 → 尾部**行动指引**
    // （alternative）仍被截掉，即每字段上限未达成目标。这里对整条再收一道：
    // 优先保 construct（类型/成员名，判读关键）与 alternative（行动指引），压缩 reason。
    var ERR_TOTAL_MAX = 1400;
    function _clipErrText(s) {
        s = String(s == null ? '' : s);
        if (s.length <= ERR_TEXT_MAX) return s;
        return s.slice(0, ERR_TEXT_MAX) + '…（本条拒信已截断，原 ' + s.length + ' 字符）';
    }
    function fail(state, node, construct, reason, alternative, domain, flags) {
        if (state.err) return;
        state.err = {
            status: 'rejected',
            line: (node && node.loc) ? node.loc.start.line : 0,
            column: (node && node.loc) ? node.loc.start.column : 0,
            construct: _clipErrText(construct),
            reason: _clipErrText(reason)
        };
        if (alternative) state.err.alternative = _clipErrText(alternative);
        if (domain) state.err.domain = domain;
        // 结构化诊断标记（不影响放行/拒绝判定，只供调用方组织回喂文案）。
        // officialAbsent = 命中 tables.MEMBER_REPLACEMENTS，即「官方 API 无此成员」——
        // run.js 据此把「可提议补表」尾注换成「不要提议补表」（补表会把不存在的成员收进能力表）。
        if (flags && flags.officialAbsent) state.err.officialAbsent = true;
        if (flags && flags.computedDom) state.err.computedDom = true;
        if (flags && flags.computedWrite) state.err.computedWrite = true;
        var total = state.err.construct.length + state.err.reason.length
            + (state.err.alternative ? state.err.alternative.length : 0);
        if (total > ERR_TOTAL_MAX) {
            var keep = ERR_TOTAL_MAX - state.err.construct.length
                - (state.err.alternative ? state.err.alternative.length : 0);
            if (keep < 160) keep = 160;   // 理由至少留一点（宁可整条略超，也不把理由抹成空）
            var m2 = '…（本条拒信已截断：按整条上限压缩）';
            state.err.reason = state.err.reason.slice(0, Math.max(0, keep - m2.length)) + m2;
        }
    }

    // ── 作用域分析（脚本级声明收集）──────────────────────────────
    function collectDeclarations(node, declared) {
        if (!node || typeof node !== 'object') return;
        var t = node.type;
        if (t === 'VariableDeclarator' && node.id && node.id.type === 'Identifier') {
            declared[node.id.name] = true;
        } else if (t === 'FunctionDeclaration' || t === 'FunctionExpression') {
            if (node.id) declared[node.id.name] = true;
            for (var p = 0; node.params && p < node.params.length; p++) {
                if (node.params[p].type === 'Identifier') declared[node.params[p].name] = true;
            }
        } else if (t === 'CatchClause' && node.param && node.param.type === 'Identifier') {
            declared[node.param.name] = true;
        } else if (t === 'ForInStatement' && node.left) {
            if (node.left.type === 'Identifier') declared[node.left.name] = true;
            else if (node.left.type === 'VariableDeclaration') collectDeclarations(node.left, declared);
        }
        for (var k in node) {
            if (k === 'loc' || k === 'range') continue;
            var v = node[k];
            if (Array.isArray(v)) {
                for (var i = 0; i < v.length; i++) collectDeclarations(v[i], declared);
            } else if (v && typeof v === 'object' && typeof v.type === 'string') {
                collectDeclarations(v, declared);
            }
        }
    }

    // ── 节点校验（遍历）──────────────────────────────────────────
    function checkNode(node, state) {
        if (state.err || !node || typeof node !== 'object') return;
        var T = state.T;
        var t = node.type;

        if (!has(T.NODE_TYPES, t)) {
            fail(state, node, 'Node:' + t, '未收录节点类型 ' + t + '（fail-closed，节点白名单外）');
            return;
        }

        switch (t) {
            case 'WithStatement':
                fail(state, node, 'Node:WithStatement',
                    'with 语句禁止（作用域混淆逃逸面）');
                return;

            case 'MemberExpression':
                checkMember(node, state);
                return;

            case 'Identifier':
                checkIdentifierUse(node, state);
                return;

            case 'AssignmentExpression':
                checkTarget(node.left, state);
                checkNode(node.right, state);
                return;

            case 'UpdateExpression':
                checkTarget(node.argument, state);
                return;

            case 'UnaryExpression':
                // delete 是 UnaryExpression（acorn estree 形态，非独立 DeleteExpression 节点）
                if (node.operator === 'delete' &&
                    node.argument.type === 'MemberExpression' && node.argument.computed) {
                    fail(state, node, 'DeleteDynamic', '动态 delete obj[k] 禁止（属性名静态可判定才可删）');
                    return;
                }
                // typeof 对未声明标识符是合法探测（不执行、无能力泄漏）——跳过标识符检查
                if (node.operator === 'typeof' && node.argument.type === 'Identifier') return;
                checkNode(node.argument, state);
                return;

            case 'BinaryExpression':
                if (node.operator === 'instanceof') {
                    checkInstanceofRHS(node.right, state);
                    checkNode(node.left, state);
                } else {
                    checkNode(node.left, state);
                    checkNode(node.right, state);
                }
                return;

            case 'NewExpression':
                if (node.callee.type === 'Identifier') {
                    var kind = has(T.IDENTIFIERS, node.callee.name) ? T.IDENTIFIERS[node.callee.name] : null;
                    if (kind && kind !== 'builtin-ctor' && kind !== 'ae-ctor') {
                        fail(state, node, 'New:' + node.callee.name,
                            'new ' + node.callee.name + ' 禁止（白名单标识符不可作构造器）');
                        return;
                    }
                    checkIdentifierUse(node.callee, state);
                    if (state.err) return;
                } else {
                    checkNode(node.callee, state);
                    if (state.err) return;
                }
                // unknown 类型不可作构造器——NewExpression 不校验
                // 可调用，'u' 变量（constructor 链/动态键产物）运行时可为 Function。
                // 推断 NewExpression 节点本身（callee 标识符的特判——Error→ESException、
                // Window→ui-object、ae-ctor/builtin-ctor 同名类型——挂在 NewExpression
                // 分支；直接推 callee 会把这些已知构造器误判 'u'）
                var newT = unionList([inferType(node, state)]);
                for (var nci = 0; nci < newT.length; nci++) {
                    if (newT[nci] === 'u') {
                        fail(state, node, 'NewUnknown:' + newT.join('|'),
                            'new 目标类型「' + newT.join('|') + '」不可判定（unknown 上 new 一律拒，fail-closed）');
                        return;
                    }
                }
                each(node['arguments'], state, checkNode);
                return;

            case 'CallExpression':
                checkCall(node, state);
                return;

            case 'VariableDeclaration':
                each(node.declarations, state, function (d, st) {
                    if (d.init) checkNode(d.init, st);
                });
                return;

            case 'FunctionDeclaration':
            case 'FunctionExpression':
                // id/params 为声明位（已收集），只校验函数体
                checkNode(node.body, state);
                return;

            case 'CatchClause':
                checkNode(node.body, state);
                return;

            case 'ForInStatement':
                // left 为声明位（已收集）；right/body 为表达式位
                checkNode(node.right, state);
                checkNode(node.body, state);
                return;

            case 'ObjectExpression':
                each(node.properties, state, function (p, st) {
                    if (p.computed) checkNode(p.key, st); // 计算键是表达式；静态键是命名位
                    checkNode(p.value, st);
                });
                return;

            case 'LabeledStatement':
                checkNode(node.body, state); // label 是标签命名空间，非变量引用
                return;

            case 'BreakStatement':
            case 'ContinueStatement':
                return; // label 同上

            case 'Property':
                // 仅经 ObjectExpression 分支到达；防御性直达时按计算键处理
                if (node.computed) checkNode(node.key, state);
                checkNode(node.value, state);
                return;

            default:
                genericRecurse(node, state);
                return;
        }
    }

    function genericRecurse(node, state) {
        for (var k in node) {
            if (k === 'loc' || k === 'range') continue;
            var v = node[k];
            if (Array.isArray(v)) {
                for (var i = 0; i < v.length; i++) {
                    if (v[i] && typeof v[i] === 'object' && typeof v[i].type === 'string') {
                        checkNode(v[i], state);
                        if (state.err) return;
                    }
                }
            } else if (v && typeof v === 'object' && typeof v.type === 'string') {
                checkNode(v, state);
                if (state.err) return;
            }
        }
    }

    function each(arr, state, fn) {
        if (!arr) return;
        for (var i = 0; i < arr.length; i++) {
            fn(arr[i], state);
            if (state.err) return;
        }
    }

    // ── 成员访问校验 ─────────────────────────────────────────────
    // isWrite：该成员为赋值目标（checkTarget 路径）——需要 w 标志
    // asCallee：该成员正处于**调用位**（checkCall 的 callee 分支）——noArgModal 闸据此
    //   区分「调用」与「取引用」（后者会绕过零参判定，见下方引用位禁令）
    function checkMember(node, state, isWrite, asCallee) {
        var T = state.T;

        // meta-property：任何接收者上一律拒（独立于类型系统——表③ 未覆盖的
        // 用户对象/字面量/函数值的成员访问正是逃逸面，规则必须挂「所有类型」）
        if (!node.computed && has(T.META_PROPERTIES, node.property.name)) {
            fail(state, node, 'MetaProperty:' + node.property.name,
                'meta-property「' + node.property.name + '」在任何接收者上禁止（构造器/原型逃逸面）');
            return;
        }
        // 计算键静态命中同名黑名单（obj["constructor"]）： Literal 键可判定，同权拒
        if (node.computed && node.property.type === 'Literal' &&
            typeof node.property.value === 'string' &&
            has(T.META_PROPERTIES, node.property.value)) {
            fail(state, node, 'MetaProperty:' + node.property.value,
                'meta-property「' + node.property.value + '」在任何接收者上禁止（计算键形态）');
            return;
        }

        // this 的成员：GlobalThis 语义（沙箱 wrapper 内 this = global）
        if (node.object.type === 'ThisExpression') {
            if (node.computed) {
                fail(state, node, 'GlobalThisMember',
                    'this 的计算成员访问禁止（this=global，动态键不可判定）');
                return;
            }
            var name = node.property.name;
            if (!has(T.IDENTIFIERS, name)) {
                fail(state, node, 'GlobalThisMember:' + name,
                    'this.' + name + ' 禁止（this=global，成员按标识符白名单核对——' + name + ' 未收录）');
                return;
            }
            return; // 白名单成员（this.Math 等）——不递归（ThisExpression 无子表达式）
        }

        // 宿主函数对象面：readFile.call(...) 等——成员访问拒（防对象面探测）
        if (node.object.type === 'Identifier' &&
            has(T.IDENTIFIERS, node.object.name) && T.IDENTIFIERS[node.object.name] === 'host-fn') {
            fail(state, node, 'HostFnMember:' + node.object.name,
                '宿主函数 ' + node.object.name + ' 仅限裸调用（成员面禁止）');
            return;
        }

        checkNode(node.object, state);
        if (state.err) return;

        // __args：执行环境预注入的 JSON 入参对象（createAETool 说明书教 LLM 用
        // __args.text 取参，而 injected 无类型分支 → 兜底 'u' 曾把这条路全拒死）。
        // 静态键**只读**放行；inferType 不动，故 __args.a 的结果类型仍是 'u'——
        // 放宽只有一层（__args.a.b / __args.a() 仍拒）。写继续拒：__allow/
        // __dataDir/__undoName 等框架字段历史上曾挂在这一对象上、由 bootstrap.js
        // 无条件覆盖注入（三者改走授权帧载荷、args 上
        // 已剥除——写入面仍封死，防载体回流）；且写通道等于给 authored 代码
        // 「改自己入参」的口子——未来任何「从 __args 读框架字段」的改动都会因此
        // 变成新的伪造面。
        // 计算键不在此拦（交 computedOn 拒），meta 键已由本函数顶部拦下。
        // 判 declared：用户 var __args = … 时按正常类型推理，不享注入面放宽
        //（对齐 checkIdentifierUse/checkTarget 的 declared 优先）。
        if (!node.computed && node.object.type === 'Identifier' && node.object.name === '__args'
            && !has(state.declared, '__args')) {
            if (isWrite) {
                fail(state, node, 'MemberWrite:args.' + node.property.name,
                    '__args 的成员不可写（入参是只读数据——框架注入字段曾挂此对象）');
            }
            return;
        }

        // ── 类型化成员访问（表③）───────────────────────
        var recv = unionList([inferType(node.object, state)]);
        // 显示名（形状按裸 user-object 呈现）：仅用于构造串/文案——判定用原始 recv
        var recvName = displayTypeName(recv.join('|'));
        var _collRecv = collectionTypeIn(T, recv);
        if (node.computed) {
            // 集合下标只读：AE 集合无下标赋值 API（写成员请对元素操作）
            if (isWrite && _collRecv) {
                fail(state, node, 'ComputedMemberWrite:' + recvName,
                    '类型「' + recvName + '」的集合下标不可写（AE 集合无下标赋值 API）',
                    '下标只读；写入请对元素操作（如 ' + _collRecv + '[i].member = …）',
                    null, { computedWrite: true });
                return;
            }
            // 计算键分治（④）：用户数组数值索引/用户对象动态键放行；
            // DOM 类型（类型规则挂点）/unknown/字符串字面量数组键一律拒
            var cv = computedOn(T, recv, node.property);
            if (!cv.ok) {
                // 接收者全是已收录命名类型或数组 → computed 策略拒绝（propose 改不了策略）；
                // 混有 unknown/用户对象/UI 对象时不打标记（补表建模仍可救济）
                var _allDom = recv.length > 0;
                for (var _di = 0; _di < recv.length; _di++) {
                    var _dt = recv[_di];
                    if (_dt === 'u' || _dt === 'user-object' || _dt === 'ui-object'
                        || isObjShape(_dt)
                        || !(has(T.TYPES, _dt) || (T.COLLECTIONS && has(T.COLLECTIONS, _dt))
                            || _dt === 'array' || arrayElemOf(_dt) !== null)) {
                        _allDom = false;
                        break;
                    }
                }
                var _hasIndexRecv = !!_collRecv;
                for (var _ai = 0; _ai < recv.length && !_hasIndexRecv; _ai++) {
                    if (recv[_ai] === 'array' || arrayElemOf(recv[_ai]) !== null) _hasIndexRecv = true;
                }
                var _computedAlt = _collRecv
                    ? ('集合取元素用数值下标（如 ' + _collRecv + '[i]）；按名取成员用对应 API'
                        + '（comp.layer(name)/layers.byName(name) 等）；命名类型用静态成员名')
                    : null;
                fail(state, node, 'ComputedMember:' + recvName,
                    '类型「' + recvName + '」上计算成员访问禁止（'
                    + (_hasIndexRecv ? 'DOM/集合须静态成员名或数值下标' : 'DOM 须静态成员名')
                    + '；unknown 上动态键拒）',
                    _computedAlt, null, _allDom ? { computedDom: true } : undefined);
                return;
            }
            checkNode(node.property, state);
            return;
        }
        var mv = memberOn(T, recv, node.property.name, { write: !!isWrite });
        if (!mv.ok) {
            if (mv.dlg) {
                // 弹窗族闸拒绝：定向指引（WithDialog 成员 Agent 通道挂起 AE）
                fail(state, node, 'DialogMember:' + recvName + '.' + node.property.name,
                    '弹窗族成员「' + node.property.name + '」仅 Script 通道（预览区/用户库）可用'
                    + '——Agent 自动执行通道弹系统对话框会挂起 AE',
                    '请在 Script 模式手动运行，或改用非弹窗成员（importFile 等经 file 域）');
            } else if (isWrite) {
                // 三态归因：受限只读 / 域未开 / 只读 / 成员不存在 / 方法不可写。
                // 构造串不变（MemberWrite:Type.name），只换 reason 与 alternative。
                // 写位也查 tables.MEMBER_REPLACEMENTS——「官方 API 无此成员」
                // 读面文案为「不要提议补表」，写位不能再引导 propose（会收不存在的成员进能力表）；
                // 判定与写位三态优先级（受限/域闸/只读/别名）一字不动，只改文案并打同一 officialAbsent 标记。
                var _aliasW = aliasFor(T, recv, node.property.name);
                var _replW = memberReplacementFor(T, recv, node.property.name);
                var _arrOnCollW = !!(_collRecv && has(T.PRIM.array, node.property.name));
                var _officialAbsentW = false;
                var _wReason, _wAlt;
                if (isRestrictedStr(T, recvName)) {
                    _wReason = '类型「' + recvName + '」的属性「' + node.property.name + '」不可写（受限类型只读）';
                    _wAlt = 'AE DOM 只读属性不可赋值；如需修改请检查类型表条目';
                } else if (mv.gated) {
                    _wReason = '类型「' + recvName + '」的属性「' + node.property.name + '」不可写（能力域「' + mv.gated + '」未开启）';
                    _wAlt = '请在「Agent 模块设置 > AST 门能力配置」开启「' + mv.gated + '」能力域后重试';
                } else if (mv.readonly) {
                    _wReason = '类型「' + recvName + '」的属性「' + node.property.name + '」不可写（类型表条目无写位；若官方 API 可写需补表）';
                    _wAlt = 'AE DOM 只读属性不可赋值；如需修改请检查类型表条目';
                } else if (_aliasW) {
                    _wReason = '类型「' + recvName + '」不存在属性「' + node.property.name + '」；可写成员是「' + _aliasW + '」';
                    _wAlt = '把「' + node.property.name + '」改为「' + _aliasW + '」';
                } else if (_replW) {
                    // 官方 API 无此成员：给官方等价写法（写位语义——不可赋值，按替代调用改写），
                    // 同时打 officialAbsent——run.js 尾注据此改口「不要提议补表」。
                    _officialAbsentW = true;
                    _wReason = '类型「' + recvName + '」无属性「' + node.property.name + '」——官方 API 无此成员（写位 fail-closed 未放行）';
                    _wAlt = '该成员不可写：' + _replW.text;
                } else if (_arrOnCollW) {
                    // 集合不继承 Array.prototype：写位同样不引导补表
                    _officialAbsentW = true;
                    _wReason = '类型「' + recvName + '」的集合对象无属性「' + node.property.name
                        + '」（AE 集合不继承 Array.prototype）';
                    _wAlt = '集合不可写该方法；读取用 length 与数值下标（' + _collRecv + '[i]），写入请对元素操作';
                } else {
                    _wReason = '类型「' + recvName + '」不存在属性「' + node.property.name + '」（未收录且非只读）';
                    _wAlt = '检查成员名；未收录成员可用 propose_table_entry 加成员（已有成员判定记错可用 override=true 改写）';
                }
                fail(state, node, 'MemberWrite:' + recvName + '.' + node.property.name, _wReason, _wAlt, mv.gated,
                    _officialAbsentW ? { officialAbsent: true } : null);
            } else {
                // 三态归因（同上）：域未开 / 错名替代 / 方法引用 apply/call / unknown 来源 / 未收录。
                // 未收录再分三态（只改 reason/alternative，放行判定不变）——
                //   ①命中 tables.MEMBER_REPLACEMENTS：官方 API 无此成员，给等价官方调用；
                //   ②同名成员在别的类型表：指路正确接收者（如 addComp 在 ItemCollection）；
                //   ③确实无等价：附 URL 补表 + 参数式工具兜底。
                var _aliasR = aliasFor(T, recv, node.property.name);
                var _applyHint = methodRefApplyHint(T, node, state);
                var _replR = memberReplacementFor(T, recv, node.property.name);
                var _arrOnCollR = !!(_collRecv && has(T.PRIM.array, node.property.name));
                var _officialAbsent = false;
                var _rReason, _rAlt;
                if (mv.gated) {
                    _rReason = '类型「' + recvName + '」的成员「' + node.property.name + '」不可用（能力域「' + mv.gated + '」未开启）';
                    _rAlt = '请在「Agent 模块设置 > AST 门能力配置」开启「' + mv.gated + '」能力域后重试';
                } else if (_aliasR) {
                    _rReason = '类型「' + recvName + '」不存在成员「' + node.property.name + '」；正确成员是「' + _aliasR + '」';
                    _rAlt = '把「' + node.property.name + '」改为「' + _aliasR + '」';
                } else if (_applyHint) {
                    _rReason = '类型「' + recvName + '」未收录成员「' + node.property.name + '」（门不建模函数值成员）';
                    _rAlt = _applyHint;
                } else if (_replR) {
                    // ①官方 API 无此成员（替代表逐条经官方脚本指南核实）：点名正确调用。
                    // 同时打 officialAbsent 标记——run.js 尾部引导据此改口「不要提议补表」。
                    _officialAbsent = true;
                    _rReason = '类型「' + recvName + '」无成员「' + node.property.name + '」——官方 API 无此成员（fail-closed 未放行）';
                    _rAlt = _replR.text;
                } else if (_arrOnCollR) {
                    // 集合不继承 Array.prototype：这些名字来自 T.PRIM.array，补表只会把
                    // 不存在的成员收进能力表——定向给集合用法并打 officialAbsent。
                    _officialAbsent = true;
                    _rReason = '类型「' + recvName + '」的集合对象无成员「' + node.property.name
                        + '」（AE 集合不继承 Array.prototype）';
                    _rAlt = '集合读取用 length 与数值下标（' + _collRecv + '[i]）；按名取元素用对应 API'
                        + '（comp.layer(name)/layers.byName(name)）；不要提议补表';
                } else if (recv.indexOf('u') >= 0) {
                    _rReason = '类型「' + recvName + '」未收录成员「' + node.property.name + '」（unknown 上成员访问一律拒，fail-closed）';
                    _rAlt = '该值类型推不出：动态键取值（obj[key]）与未被调用的 helper 形参会变 unknown'
                        + '——把值存进具名变量、改用已建模 API，或删掉未使用的函数';
                } else {
                    // ②/③：区分「成员属于别的接收者」与「确实无等价」。
                    var _otherRecv = otherReceiversFor(T, recv, node.property.name);
                    if (_otherRecv.length) {
                        var _recvHints = [];
                        var _exTbl = T.TYPE_RECEIVER_EXAMPLES || {};
                        for (var _oi = 0; _oi < _otherRecv.length && _oi < 4; _oi++) {
                            var _ex = has(_exTbl, _otherRecv[_oi]) ? ('（如 ' + _exTbl[_otherRecv[_oi]] + '）') : '';
                            _recvHints.push('「' + _otherRecv[_oi] + '」' + _ex);
                        }
                        var _more = _otherRecv.length > 4 ? ' 等' : '';
                        var _hintText = _recvHints.join('、') + _more;
                        _rReason = '类型「' + recvName + '」无成员「' + node.property.name
                            + '」；同名成员在类型' + _hintText + '上收录';
                        _rAlt = '换用上述类型的对象调用「' + node.property.name + '」：'
                            + _hintText + '；原接收者没有这个成员';
                    } else {
                        _rReason = '类型「' + recvName + '」无成员「' + node.property.name + '」（fail-closed，未收录）';
                        _rAlt = '该成员不在官方 ExtendScript API 中（或属刻意未收录的官方成员）；'
                            + '若确认官方文档存在请附 URL 用 propose_table_entry 补表；'
                            + '文件/系统类需求改用对应参数式工具';
                    }
                }
                fail(state, node, 'Member:' + recvName + '.' + node.property.name, _rReason, _rAlt, mv.gated,
                    _officialAbsent ? { officialAbsent: true } : null);
            }
        }
        if (state.err) return;
        // 零参模态成员的**引用位禁令**（闸的闭环）：该成员只允许出现在调用位。
        // 取引用（var s = app.project.save; s()）与转发（call(app.project.save)）会绕过调用点
        // 的「零参形态」判定，Agent 通道仍会撞上模态/报错（无人通道不能安全执行）。
        // 通道口径同 dlg 闸；赋值目标（isWrite）由上面的写权限路径处理，不在此重复。
        if (!asCallee && !isWrite && !_dialogSourceOpen()
            && noArgModalOn(T, recv, node.property.name)) {
            fail(state, node, 'NoArgModalRef:' + recvName + '.' + node.property.name,
                '「' + node.property.name + '」带零参模态闸，只能出现在**调用位**——'
                + '取引用或转发会让「有没有给 file 参数」静态不可判定',
                '直接调用并带路径：if (app.project.file) app.project.save(app.project.file);');
        }
        if (node.computed) checkNode(node.property, state);
    }

    function isRestrictedStr(T, typeName) {
        var parts = splitTypes(typeName);
        for (var i = 0; i < parts.length; i++) {
            if (has(T.RESTRICTED_TYPES, parts[i])) return true;
        }
        return false;
    }

    // 联合接收者中的已登记集合类型名（无则 null）——集合下标/成员诊断用
    function collectionTypeIn(T, recvTypes) {
        var coll = T.COLLECTIONS || {};
        for (var i = 0; i < recvTypes.length; i++) {
            if (has(coll, recvTypes[i])) return recvTypes[i];
        }
        return null;
    }

    // ── 调用校验（unknown 上调用一律拒；属性不可调用）─────────
    function checkCall(node, state) {
        var T = state.T;
        var callee = node.callee;

        if (callee.type === 'Identifier') {
            if (has(state.declared, callee.name)) {
                // 用户函数调用——但变量已推导出非函数类型时拒（var p = app.project; p()）
                var vt = unionList([state.env.varTypes[callee.name] || 'u']);
                var allCallable = vt.length === 0 ? false : true;
                for (var vi = 0; vi < vt.length; vi++) {
                    if (vt[vi] !== 'function' && vt[vi] !== 'u') { allCallable = false; break; }
                }
                if (!allCallable) {
                    fail(state, node, 'CallNonFunction:' + vt.join('|'),
                        '类型「' + vt.join('|') + '」不可调用（已推导出非函数类型）');
                    return;
                }
            } else if (has(T.IDENTIFIERS, callee.name)) {
                var k = T.IDENTIFIERS[callee.name];
                if (k === 'host-fn' || k === 'builtin-fn' || k === 'builtin-call') {
                    // 宿主函数桩调用 / parseInt 族 / String(x) ✓
                } else {
                    fail(state, node, 'CallGlobal:' + callee.name,
                        '标识符「' + callee.name + '」不可调用（白名单中仅函数/宿主函数/用户函数可调用）');
                    return;
                }
            } else {
                checkIdentifierUse(callee, state); // 未声明——按标识符检查（会拒）
                if (state.err) return;
            }
        } else if (callee.type === 'MemberExpression') {
            checkMember(callee, state, false, true); // 读检查（含 meta/this/hostfn/类型成员；调用位）
            if (state.err) return;
            var recv = unionList([inferType(callee.object, state)]);
            var mv = memberOn(T, recv, callee.property.name, { call: true });
            if (!mv.ok) {
                var mcName = displayTypeName(recv.join('|'));
                fail(state, node, 'MemberCall:' + mcName + '.' + callee.property.name,
                    '类型「' + mcName + '」的「' + callee.property.name + '」不可调用'
                    + '（' + (recv.length === 1 && recv[0] === 'u'
                        ? 'unknown 上调用一律拒——动态键/解析结果不可作函数'
                        : '非方法成员或未收录') + '）',
                    null, mv.gated);
                return;
            }
            // 零参模态闸（noArgModal 条目标志——「只拦零参 save」）：
            // 该成员的**空实参**形态在特定状态下不能在无人通道安全执行（Project.save 对未保存过的
            // 工程会走 AE「另存为」模态，或按官方文档口径直接报错——两种都让本次调用失败）。
            // 判定用 isEmptyArgs（零参 / null / undefined / void）；带参形态不触发，故放行；
            // 通道口径同 dlg 闸（仅 DIALOG_SOURCES 放行）。
            if (!state.err && !_dialogSourceOpen()
                && isEmptyArgs(node.arguments)
                && noArgModalOn(T, recv, callee.property.name)) {
                var naName = displayTypeName(recv.join('|'));
                fail(state, node, 'NoArgModal:' + naName + '.' + callee.property.name,
                    '「' + callee.property.name + '()」空实参形态仅 Script 通道（预览区/用户库）可用'
                    + '——工程从未保存过时该形态会走 AE「另存为」模态（挂起 AE）或直接报错'
                    + '（官方文档口径；实际行为未验证），无人通道不能安全执行',
                    '改为带路径保存：if (app.project.file) app.project.save(app.project.file);'
                    + '（已有工程文件时不弹模态）；从未保存过的工程请在面板手动保存一次');
                return;
            }
        } else {
            // 计算键调用 obj[k]() / this() / 条件表达式调用等
            checkNode(callee, state);
            if (state.err) return;
            var ct = inferType(callee, state);
            var ctList = unionList([ct]);
            var callable = false;
            for (var ci = 0; ci < ctList.length; ci++) {
                if (ctList[ci] === 'function') { callable = true; break; }
            }
            if (!callable) {
                fail(state, node, 'CallUnknown',
                    '该调用目标类型为「' + ct + '」——unknown 上调用一律拒（fail-closed）');
                return;
            }
        }
        each(node['arguments'], state, checkNode);
    }

    // ── 标识符使用校验（表达式位）────────────────────────────────
    function checkIdentifierUse(node, state) {
        if (has(state.declared, node.name)) return;
        // 弹窗族通道规则（tables DIALOG_IDS/DIALOG_SOURCES）：
        // 用户手动运行通道放行（真弹窗），Agent 自动执行通道拒（无人在场，
        // confirm/prompt 会挂起 AE 线程）；缺 source 默认拒（fail-closed）。
        // 用户同名 shadow（var alert = fn）已在上方 declared 分支放行。
        if (has(state.T.DIALOG_IDS, node.name)) {
            if (_currentSource && has(state.T.DIALOG_SOURCES, _currentSource)) return;
            fail(state, node, 'Dialog:' + node.name,
                '「' + node.name + '」弹窗/UI 族标识符仅限用户手动运行的通道（脚本区/脚本树）——'
                + 'Agent 通道由 LLM 自动执行、无人在场，弹窗会挂起 AE（fail-closed）',
                'Agent 通道请用 result 返回值传递信息（工具结果直接回喂 LLM），'
                + '或改用专用参数式工具；UI 面板/弹窗需求请引导用户在 Script 模式运行');
            return;
        }
        if (has(state.T.IDENTIFIERS, node.name)) return;
        // policy 挂点（数据驱动—— system 特判由表条目承载）：域开标识符放行
        //（成员面仍受类型表约束——SystemObj 仅 callSystem、FileHandle 挂 file 域
        // 条目等）；域关走现行拒路径且附 error.domain（llm-preview 域确认弹窗输入）
        if (has(state.T.POLICY_GATED.identifiers, node.name)) {
            var gi = state.T.POLICY_GATED.identifiers[node.name];
            if (_domainOpen(gi.domain)) return;
            fail(state, node, 'Identifier:' + node.name,
                '标识符「' + node.name + '」未声明且不在白名单（' + gi.domain +
                ' 能力域未开启，fail-closed）', null, gi.domain);
            return;
        }
        fail(state, node, 'Identifier:' + node.name,
            '标识符「' + node.name + '」未声明且不在白名单（fail-closed）');
    }

    // ── 赋值/更新目标校验 ─────────────────────────────────────────
    function checkTarget(node, state) {
        var T = state.T;
        if (node.type === 'Identifier') {
            if (has(state.declared, node.name) || node.name === 'result' || node.name === '__args') return;
            var kind = has(T.IDENTIFIERS, node.name) ? T.IDENTIFIERS[node.name] : null;
            if (kind) {
                fail(state, node, 'AssignGlobal:' + node.name,
                    '白名单标识符「' + node.name + '」不可作赋值目标（防环境毒化——AE 全局跨脚本存活）');
                return;
            }
            fail(state, node, 'AssignUndeclared:' + node.name,
                '赋值目标「' + node.name + '」未声明（隐式全局禁止，请先 var 声明）');
            return;
        }
        if (node.type === 'MemberExpression') {
            checkMember(node, state, true); // 赋值目标——成员写权限检查（w 标志）
            return;
        }
        fail(state, node, 'AssignTarget:' + node.type, '非法赋值目标');
    }

    // ── instanceof 右侧校验 ───────────────────────────────────────
    function checkInstanceofRHS(node, state) {
        var _dlgSrc = _currentSource && has(state.T.DIALOG_SOURCES, _currentSource);
        var _msg = 'instanceof 右侧须为白名单类对象（CompItem/FootageItem/FolderItem/TextLayer/AVLayer'
            + '/CameraLayer/LightLayer/ShapeLayer/ThreeDModelLayer/ParametricMeshLayer'
            + (_dlgSrc ? '；脚本区另可用 ScriptUI 类（Window/Panel/Group/Button 等）' : '') + '）';
        if (node.type !== 'Identifier') {
            fail(state, node, 'InstanceofRHS', _msg);
            return;
        }
        if (has(state.T.IDENTIFIERS, node.name)) return;
        // 弹窗族 instanceof（w instanceof Window / this instanceof Panel——ScriptUI
        // 类族判型，随弹窗通道放行）：纯原型链比对——RHS 仅被
        // 读 .prototype，无执行无能力面；限定弹窗通道（与 new Window 同规则——
        // ScriptUI 类标识符不出现在 Agent 代码的通道不变量保持）。
        // 刻意不走 IDENTIFIERS 收录（ae-class 式）：该路径会同时放行 this.Window
        //（checkMember this 分支查 IDENTIFIERS）——构造器引用泄漏到全通道后
        // `var c = this.Window; new c("dialog","x")` 即绕过弹窗通道规则挂起 AE；
        // 且 NewExpression 的 kind 检查会误拒 new Window（非 builtin-ctor 拒）。
        if (has(state.T.DIALOG_IDS, node.name) && _dlgSrc) return;
        fail(state, node, 'InstanceofRHS', _msg);
    }

    // ── 审计模式（user-library 检测层）──────────────────────
    // AEGate.audit(source) → { ok:true, dangers:[{kind,construct,line,column,reason}] }
    //   kind：'capability'（能力域引用）/ 'escape'（逃逸形态）/ 'parse'（不可解析）
    // 语义（user-library 信任根降级）：结构化危险清单供确认层
    // 弹窗「如实陈述」——不重发射（emitted=原文由 run.js user-library 分支处理）、
    // 不硬拒（确认/取消是调用方 UI 职责）。检测面=表驱动危险集（tables.AUDIT）
    // + 结构形态（with/动态 delete/this 计算键/计算键字面量命中）——刻意不复用
    // validate 白名单走查：类型表缺口会淹没信号（确认疲劳即防线失效）。
    function audit(source) {
        var out = [];
        var pre = global.AEGate.preprocess(source);
        if (!pre.ok) {
            var pe = pre.error || {};
            // #include/#targetengine 等（不可信代码注入路径）
            out.push({ kind: 'escape', construct: pe.construct || 'Preprocess',
                line: pe.line || 0, column: pe.column || 0,
                reason: pe.reason || '预处理指令被门拒绝（不可信代码注入路径）' });
            return { ok: true, dangers: out };
        }
        var ast;
        try {
            ast = global.AEGate._acorn.parse(pre.code, {
                ecmaVersion: 3,
                allowReturnOutsideFunction: true,
                locations: true
            });
        } catch (e) {
            out.push({ kind: 'parse', construct: 'SyntaxError',
                line: e.loc ? e.loc.line : 0, column: e.loc ? e.loc.column : 0,
                reason: '脚本无法被审计解析（' + e.message + '）——无法枚举其危险内容' });
            return { ok: true, dangers: out };
        }
        var declared = {};
        collectDeclarations(ast, declared);
        // 保存工程的接收者别名（一级，不追重赋值）：`var p = app.project` 之后 `p.save()`
        // 与 `app.project.save()` 同报（用户库最常见的别名写法）。已知边界：重赋值后
        // （p = 别的对象）会多报一条——审计是「跑之前如实告知」面，多报一条写盘提示
        // 优于静默漏报。
        var projectAliases = {};
        (function collectProjectAliases(n) {
            if (!n || typeof n !== 'object') return;
            if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier'
                && n.init && _projectSaveReceiver(n.init)) {
                projectAliases[n.id.name] = true;
            }
            for (var k in n) {
                if (k === 'loc' || k === 'range' || k === '__fnId') continue;
                var v = n[k];
                if (Array.isArray(v)) {
                    for (var i = 0; i < v.length; i++) collectProjectAliases(v[i]);
                } else if (v && typeof v === 'object' && typeof v.type === 'string') {
                    collectProjectAliases(v);
                }
            }
        })(ast);
        walkAudit(ast, null, null, out, declared, projectAliases);
        // 域过滤（终版矩阵 ON 行 user-library 静默）：域已开的 capability 条目
        // 静默剔除（确认弹窗不再打扰——能力已被授权）；无域危险（$/evalFile/
        // scheduleTask/BridgeTalk/runScriptFromFile）恒报。saveProject
        // 随其全局宿主函数删除一并从 capabilityIds 摘除，不再出现在本列表。
        // config 缺席
        //（模块未载——m2 系测试沙箱）时不过滤，现行行为保持
        if (global.AEGate && global.AEGate.config && global.AEGate.tables &&
            global.AEGate.tables.AUDIT_DOMAINS) {
            var _pol = global.AEGate.config.getEffectivePolicy();
            if (_pol) {
                var _doms = global.AEGate.tables.AUDIT_DOMAINS;
                var _kept = [];
                for (var _ai = 0; _ai < out.length; _ai++) {
                    var _dz = out[_ai];
                    if (_dz.kind === 'capability') {
                        var _nm = String(_dz.construct || '').split(':').pop();
                        var _dom = has(_doms, _nm) ? _doms[_nm] : null;
                        if (_dom && _DOMAIN_KEYS[_dom] && _pol[_DOMAIN_KEYS[_dom]] === true) {
                            continue; // 域开静默
                        }
                    }
                    _kept.push(_dz);
                }
                out = _kept;
            }
        }
        return { ok: true, dangers: out };
    }

    function _auditLoc(node) {
        return {
            line: (node && node.loc && node.loc.start) ? node.loc.start.line : 0,
            column: (node && node.loc && node.loc.start) ? node.loc.start.column : 0
        };
    }

    // 审计走查：全量遍历（不 early-exit），仅报告危险集命中——声明位/键位/
    // 成员名位/标签位的标识符不计（parent+key 判别，非引用即不报）；用户
    // 声明过的名字亦不计（shadow 全局——与门 collectDeclarations 同语义，
    // 深混淆的执行边界是运行时沙箱）
    // 能力类条目的如实陈述标签（表驱动 tables.AUDIT_LABELS；未登记名回落通用措辞
    // ——不声称域名，避免与事实不符）
    function _auditCapLabel(name) {
        var L = global.AEGate.tables.AUDIT_LABELS;
        return (L && has(L, name)) ? L[name] : '能力/写盘类操作';
    }

    // 保存工程的审计接收者判定（把 save 补进审计表的实现）：
    // 纯语法链判定，不做类型推导——**链根必须是 app / this** 且链上出现 project
    //（app.project.save / this.project.save / app["project"].save）。根限定是防误报的
    // 关键：`config.project.save()` 这类用户对象不得被报成保存工程（审计是如实告知面，
    // 宁窄勿假）。**有意不走按名规则**（capabilityMembers）：'save' 是通用词。
    // 接收者别名（var p = app.project; p.save()）由 audit() 侧的一级别名表补上。
    function _projectSaveReceiver(obj) {
        var o = obj, sawProject = false;
        while (o && o.type === 'MemberExpression') {
            // 计算键字面量与静态名同权（对齐审计层既有口径：obj["callSystem"] 与
            // obj.callSystem 同权）——app["project"].save() 也须报
            var pn = null;
            if (!o.computed && o.property && o.property.type === 'Identifier') pn = o.property.name;
            else if (o.computed && o.property && o.property.type === 'Literal'
                && typeof o.property.value === 'string') pn = o.property.value;
            if (pn === null) return false;
            if (pn === 'project') sawProject = true;
            o = o.object;
        }
        var rootOk = !!o && (o.type === 'ThisExpression'
            || (o.type === 'Identifier' && o.name === 'app'));
        return sawProject && rootOk;
    }

    function walkAudit(node, parent, key, out, declared, projectAliases) {
        if (!node || typeof node !== 'object') return;
        var A = global.AEGate.tables.AUDIT;
        var t = node.type;

        if (t === 'Identifier') {
            var isRefPos = !(
                (parent && parent.type === 'Property' && key === 'key' && !parent.computed) ||
                (parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed) ||
                (parent && (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' ||
                    parent.type === 'ContinueStatement')) ||
                (parent && parent.type === 'VariableDeclarator' && key === 'id') ||
                (parent && (parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression') &&
                    (key === 'id' || key === 'params')) ||
                (parent && parent.type === 'CatchClause' && key === 'param') ||
                (parent && parent.type === 'ForInStatement' && key === 'left')
            );
            if (isRefPos && !has(declared, node.name)) {
                var loc = _auditLoc(node);
                if (has(A.capabilityIds, node.name)) {
                    out.push({ kind: 'capability', construct: 'Identifier:' + node.name,
                        line: loc.line, column: loc.column,
                        reason: '引用「' + node.name + '」：' + _auditCapLabel(node.name) });
                } else if (has(A.escapeIds, node.name)) {
                    out.push({ kind: 'escape', construct: 'Identifier:' + node.name,
                        line: loc.line, column: loc.column,
                        reason: '逃逸形态标识符「' + node.name + '」（动态求值/沙箱内部名）' });
                } else {
                    for (var pi = 0; pi < A.escapeIdPrefixes.length; pi++) {
                        if (node.name.indexOf(A.escapeIdPrefixes[pi]) === 0) {
                            out.push({ kind: 'escape', construct: 'Identifier:' + node.name,
                                line: loc.line, column: loc.column,
                                reason: '沙箱内部命名族「' + A.escapeIdPrefixes[pi] + '*」引用' });
                            break;
                        }
                    }
                }
            }
        } else if (t === 'MemberExpression') {
            var mloc = _auditLoc(node);
            var mname = (!node.computed && node.property && node.property.type === 'Identifier')
                ? node.property.name : null;
            if (mname) {
                // 成员名扫描合并标识符集：覆盖 this.File / window.File 形态
                //（property 位不走 Identifier 分支——接收者无关，命中即如实陈述）
                if (has(A.capabilityMembers, mname) || has(A.capabilityIds, mname)) {
                    out.push({ kind: 'capability', construct: 'Member:' + mname,
                        line: mloc.line, column: mloc.column,
                        reason: '成员访问「.' + mname + '」：' + _auditCapLabel(mname) });
                }
                if (has(A.escapeMembers, mname) || has(A.escapeIds, mname)) {
                    out.push({ kind: 'escape', construct: 'Member:' + mname,
                        line: mloc.line, column: mloc.column,
                        reason: '逃逸形态成员「.' + mname + '」（构造器/原型/沙箱内部面）' });
                }
                // 恢复「保存工程（写盘）」的审计信号（saveProject
                // 标识符随宿主函数删除后此面曾归零）。**接收者感知的例外**，不走按名规则：
                // 'save' 是通用词，按名入 capabilityMembers 会把用户对象自己的 myObj.save()
                // 误报成保存工程。判定见 _projectSaveReceiver（链根须为 app/this）与
                // projectAliases（var p = app.project 一级别名）。
                if (mname === 'save' && !has(A.capabilityMembers, mname)
                    && (_projectSaveReceiver(node.object)
                        || (node.object.type === 'Identifier' && has(projectAliases, node.object.name)))) {
                    out.push({ kind: 'capability', construct: 'Member:Project.save',
                        line: mloc.line, column: mloc.column,
                        reason: '成员访问「.save」：' + _auditCapLabel('save') });
                }
            }
            if (node.computed) {
                // 计算键字面量命中（obj["callSystem"] / obj["__proto__"]）与静态名同权
                if (node.property.type === 'Literal' && typeof node.property.value === 'string') {
                    var lv = node.property.value;
                    if (has(A.capabilityMembers, lv) || has(A.capabilityIds, lv)) {
                        out.push({ kind: 'capability', construct: 'ComputedMember:' + lv,
                            line: mloc.line, column: mloc.column,
                            reason: '计算键访问「' + lv + '」：' + _auditCapLabel(lv) });
                    }
                    if (has(A.escapeMembers, lv) || has(A.escapeIds, lv)) {
                        out.push({ kind: 'escape', construct: 'ComputedMember:' + lv,
                            line: mloc.line, column: mloc.column,
                            reason: '计算键访问「' + lv + '」（逃逸形态面）' });
                    }
                    // 保存工程的同权形态：app.project["save"]()（与 .save 同报）
                    if (lv === 'save' && !has(A.capabilityMembers, lv)
                        && (_projectSaveReceiver(node.object)
                            || (node.object.type === 'Identifier' && has(projectAliases, node.object.name)))) {
                        out.push({ kind: 'capability', construct: 'ComputedMember:Project.save',
                            line: mloc.line, column: mloc.column,
                            reason: '计算键访问「save」：' + _auditCapLabel('save') });
                    }
                }
                // this[k]：this=global（沙箱 wrapper 语义），动态键即全局面探测
                if (node.object.type === 'ThisExpression') {
                    out.push({ kind: 'escape', construct: 'ThisComputedMember',
                        line: mloc.line, column: mloc.column,
                        reason: 'this 的计算成员访问（this=global，动态键不可判定）' });
                }
            }
        } else if (t === 'WithStatement') {
            var wloc = _auditLoc(node);
            out.push({ kind: 'escape', construct: 'WithStatement',
                line: wloc.line, column: wloc.column,
                reason: 'with 语句（作用域混淆逃逸面）' });
        } else if (t === 'UnaryExpression' && node.operator === 'delete' &&
            node.argument && node.argument.type === 'MemberExpression' && node.argument.computed) {
            var dloc = _auditLoc(node);
            out.push({ kind: 'escape', construct: 'DeleteDynamic',
                line: dloc.line, column: dloc.column,
                reason: '动态 delete obj[k]（属性名静态不可判定）' });
        }

        for (var k in node) {
            if (k === 'loc' || k === 'range' || k === '__fnId') continue;
            var v = node[k];
            if (Array.isArray(v)) {
                for (var i = 0; i < v.length; i++) {
                    if (v[i] && typeof v[i] === 'object' && typeof v[i].type === 'string') {
                        walkAudit(v[i], node, k, out, declared, projectAliases);
                    }
                }
            } else if (v && typeof v === 'object' && typeof v.type === 'string') {
                walkAudit(v, node, k, out, declared, projectAliases);
            }
        }
    }

    global.AEGate = global.AEGate || {};
    global.AEGate.gate = gate;
    global.AEGate.validate = validate;
    global.AEGate.audit = audit;
    global.AEGate._setValidateHook = function (fn) { _validateHook = fn; };
    global.AEGate._setValidateHook(validate); // 引擎自注册（tables.js 需先于本文件加载）
})(typeof window !== 'undefined' ? window : globalThis);
