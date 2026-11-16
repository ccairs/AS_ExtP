(function (global) {
    'use strict';
    function createScriptTranscode() {
        // 转译函数优先委托 AEAgentApp.scriptUtils（scripts/utils.js 单一实现；
        // scripts.manifest.js 加载顺序 utils.js → 本文件 → scriptTools.js，工厂调用时委托
        // 目标已就绪）——消除双实现漂移：旧拷贝缺 protectRegexLiterals 正则字面量保护、
        // let/const 替换的 (^|[^.\w$]) 前缀排除、restoreNewlines 注释保护、模板 \r 转义
        // 四项修复且 alert 拉平为无界正则，LLM 提交链路与预览区行为不一致。utils.js
        // 未注入的独立沙箱（单测直接加载本文件）回退下方本地副本——与 utils.js 逐字
        // 同步，修改需两处同步。
        function _scriptUtils() {
            return (global.AEAgentApp && global.AEAgentApp.scriptUtils) || null;
        }

        // ── 本地兜底副本：与 scripts/utils.js 逐字同步（见顶部说明）──

        // 箭头头部形态：(参数表) 或 单参标识符 后接 =>。
        // 参数表内不允许出现圆括号：((x) => ...) 类外层括号误配、(a = (1)) 类默认值
        // 宁可匹配失败走降级，也不误切参数边界。
        var ARROW_HEAD = /(\(([^()]*)\)|[A-Za-z_$][\w$]*)\s*=>/;

        // 字符串/模板文本段入池前统一转义 U+2028/U+2029——两者是 ES3
        // 字符串字面量内非法的行终止符（纯 ES3 脚本同样中招），残留即断串拒执行。
        function _escapeLineTerms(lit) {
            return lit.replace(/[\u2028\u2029]/g, function (ch) {
                return ch === '\u2028' ? '\\u2028' : '\\u2029';
            });
        }

        // 模板字面量就地转 ES3：文本段（转义未转义双引号、真实换行转 \n；\r 与
        // U+2028/U+2029 一并转义——裸 CR/LS/PS 是行终止符，残留在产出的字符串
        // 字面量内即断串）入保护池，插值段经词法保护后留在代码流中供下方
        // const/let/箭头替换继续处理。若不在此处理，模板内嵌的 " 会被字符串规则
        // 误当边界切走（如 `say "hi"` 产出 "say "hi"" 断串），插值也会被藏匿导致
        // 整体不可转译。插值按花括号配对扫描拆分：${fn({x: 1})} 的嵌套花括号用
        // [^}]* 正则无法配对；插值内字符串里的 } 不计入配对；\${ 为字面文本。
        // 无法安全闭合（嵌套模板等复杂形态）返回 null，由调用方置降级标记后
        // 整段入池原样保留。
        // 插值段就地二次 tokenizeProtect——旧两遍结构里插值段直到正则
        // 保护阶段才被扫描（字符串从未被保护，let/const 替换可污染插值内的字符串
        // 与正则字面量）；单遍扫描合并后在产出前补齐插值段的完整词法保护。
        function _convertTemplate(m, protectedStrs) {
            var inner = m.slice(1, -1);
            var parts = [];
            var buf = '';
            var k = 0;
            while (k < inner.length) {
                var ch = inner.charAt(k);
                if (ch === '\\') {
                    if (inner.charAt(k + 1) === '$' && inner.charAt(k + 2) === '{') {
                        buf += '${';  // \${ 是字面文本（ES6 转义），不是插值
                        k += 3;
                    } else {
                        buf += inner.substring(k, k + 2);  // 转义序列整体过（含 \\）
                        k += 2;
                    }
                } else if (ch === '$' && inner.charAt(k + 1) === '{') {
                    var d = 1, q = null;
                    var j = k + 2;
                    // 插值内正则字面量识别（与 utils.js 主实现逐字同步）——
                    // 正则里的 }（如 ${/}/.test(s)}）被误当花括号闭合 → 插值
                    // 提前截断、产物断裂且配对「成功」不触发降级（转坏不降级）
                    var _lastSig = '(';  // ${ 开启表达式上下文：紧跟的 / 是正则
                    var _word = '';
                    var _KW = /^(?:return|typeof|instanceof|in|new|delete|void|throw|case|do|else)$/;
                    while (j < inner.length && d > 0) {
                        var cj = inner.charAt(j);
                        if (q) {
                            if (cj === '\\') { j += 2; continue; }
                            if (cj === q) { q = null; _lastSig = ')'; _word = ''; }
                        } else if (cj === '"' || cj === "'") {
                            q = cj;
                        } else if (cj === '/' && inner.charAt(j + 1) === '*') {
                            // 插值内块注释——注释里的 } 不计入花括号配对
                            //（不跳过注释时 ${ a /* } */ b } 在注释的 } 处提前闭段，产物
                            // 错位注释吞代码）。未闭合视为插值无法安全配对，降级。
                            var bcEnd = inner.indexOf('*/', j + 2);
                            if (bcEnd === -1) return null;
                            j = bcEnd + 2;
                            _lastSig = '\x00'; _word = '';
                            continue;
                        } else if (cj === '/' && inner.charAt(j + 1) === '/') {
                            // 插值内行注释——同理跳至行尾；注释吞到模板
                            // 末尾（无换行）说明插值必未闭合，降级。
                            var lcEnd = inner.indexOf('\n', j + 2);
                            if (lcEnd === -1) return null;
                            j = lcEnd;
                            _lastSig = '\x00'; _word = '';
                            continue;
                        } else if (cj === '/') {
                            var _rs;
                            if (_lastSig === '') _rs = true;
                            else if (_lastSig === ')' || _lastSig === ']' || _lastSig === '}') _rs = false;
                            else if (/[\w$]/.test(_lastSig)) _rs = _KW.test(_word);
                            else _rs = true;
                            if (_rs) {
                                // 行内配对正则（字符类内 / 不算定界）；未闭合按除号
                                var rj2 = j + 1, inCls = false, closedR = false;
                                while (rj2 < inner.length) {
                                    var rc = inner.charAt(rj2);
                                    if (rc === '\\') { rj2 += 2; continue; }
                                    if (rc === '\n' || rc === '\r') break;
                                    if (inCls) { if (rc === ']') inCls = false; }
                                    else if (rc === '[') inCls = true;
                                    else if (rc === '/') { closedR = true; rj2++; break; }
                                    rj2++;
                                }
                                if (closedR) {
                                    while (rj2 < inner.length && /[a-z]/i.test(inner.charAt(rj2))) rj2++;
                                    j = rj2;
                                    _lastSig = ')'; _word = '';
                                    continue;
                                }
                            }
                            _lastSig = '/'; _word = '';
                        } else if (cj === '{') {
                            d++;
                            _lastSig = '{'; _word = '';
                        } else if (cj === '}') {
                            d--;
                            _lastSig = '}'; _word = '';
                        } else if (/[\w$]/.test(cj)) {
                            _word += cj; _lastSig = cj;
                        } else if (!/\s/.test(cj)) {
                            _lastSig = cj; _word = '';
                        }
                        j++;
                    }
                    if (d !== 0 || q !== null) return null;
                    parts.push(buf); buf = '';
                    parts.push(inner.slice(k + 2, j - 1));
                    k = j;
                } else {
                    buf += ch;
                    k++;
                }
            }
            parts.push(buf);
            var out = '';
            for (var t = 0; t < parts.length; t++) {
                if (t % 2 === 0) {
                    var lit = parts[t].replace(/\\?"/g, function (q) { return q === '"' ? '\\"' : q; }).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
                    if (lit === '') continue;
                    protectedStrs.push(_escapeLineTerms(lit));
                    out += (out ? ' + ' : '') + '"\x00PS' + (protectedStrs.length - 1) + '\x00"';
                } else {
                    out += (out ? ' + (' : '(') + tokenizeProtect(parts[t], protectedStrs, {}) + ')';
                }
            }
            return out === '' ? '""' : out;
        }

        // 单遍统一词法扫描——同一扫描器按出现位置先到先得地识别字符串/
        // 注释/正则/模板四种 token，替换旧「字符串保护与正则保护分两遍先后执行」
        // 的结构。旧结构里正则字面量内的引号（如 s.replace(/["']/g, "")）先被
        // 字符串规则误当边界切走，与后文引号错配出「幻影字符串」吞掉中间代码：
        // 被吞区间内的 let/const 不被转换（ES6 泄漏 → SyntaxError）或区间外代码
        // 错位断裂。除号歧义沿用的保守判定（前一非空白字符 + 关键字表）：
        // 误保护仅少转（安全方向），漏保护才会转坏；判不出的形态维持旧行为。
        // opts.template=true 时模板字面量就地转 ES3（转译场景）；false 时反引号
        // 按普通字符处理（restoreNewlines 场景，对齐旧保护正则不含反引号分支）。
        // 模板插值配对失败经 opts.degraded=true 传出。
        function tokenizeProtect(s, protectedStrs, opts) {
            opts = opts || {};
            var KEYWORDS = { 'return': 1, 'typeof': 1, 'instanceof': 1, 'in': 1, 'new': 1, 'delete': 1, 'void': 1, 'throw': 1, 'case': 1, 'do': 1, 'else': 1 };
            var out = '';
            var lastSig = '';  // 上一个非空白字符（''=串首）
            var word = '';     // 以 lastSig 结尾的标识符
            var i = 0;
            var n = s.length;
            while (i < n) {
                var c = s.charAt(i);
                if (c === '"' || c === "'") {
                    // 字符串字面量：配对到闭合引号（\ 转义整体过；允许跨行，对齐旧
                    // 正则 [^"\\] 含换行的宽松口径）。未闭合当普通字符累积。
                    var se = i + 1;
                    while (se < n) {
                        if (s.charAt(se) === '\\') { se += 2; continue; }
                        if (s.charAt(se) === c) break;
                        se++;
                    }
                    if (se < n) {
                        // 入池时转义 U+2028/U+2029
                        protectedStrs.push(_escapeLineTerms(s.slice(i, se + 1)));
                        out += '\x00PS' + (protectedStrs.length - 1) + '\x00';
                        lastSig = ')';  // 字面量是值：紧随其后的 / 当除号
                        word = '';
                        i = se + 1;
                        continue;
                    }
                } else if (c === '/' && s.charAt(i + 1) === '/') {
                    // 行注释（不含行尾换行，对齐旧正则 //[^\n]*）
                    var lcEnd = s.indexOf('\n', i);
                    if (lcEnd === -1) lcEnd = n;
                    protectedStrs.push(s.slice(i, lcEnd));
                    out += '\x00PS' + (protectedStrs.length - 1) + '\x00';
                    lastSig = '\x00';
                    word = '';
                    i = lcEnd;
                    continue;
                } else if (c === '/' && s.charAt(i + 1) === '*') {
                    // 块注释：配对到 */（未闭合按普通字符流处理，对齐旧正则）
                    var bcEnd = s.indexOf('*/', i + 2);
                    if (bcEnd !== -1) {
                        protectedStrs.push(s.slice(i, bcEnd + 2));
                        out += '\x00PS' + (protectedStrs.length - 1) + '\x00';
                        lastSig = '\x00';
                        word = '';
                        i = bcEnd + 2;
                        continue;
                    }
                } else if (c === '/') {
                    var regexStart;
                    if (lastSig === '') regexStart = true;
                    else if (lastSig === ')' || lastSig === ']' || lastSig === '}') regexStart = false;
                    else if (/[\w$]/.test(lastSig)) regexStart = KEYWORDS[word] === 1;
                    else regexStart = true;
                    if (regexStart) {
                        // 行内配对一个正则字面量 /.../flags（字符类内的 / 不算定界
                        // 符）；行内未闭合当除号处理，宁可漏保护
                        var j = i + 1, inCls = false, closed = false;
                        while (j < n) {
                            var cj = s.charAt(j);
                            if (cj === '\\') { j += 2; continue; }
                            if (cj === '\n' || cj === '\r') break;
                            if (inCls) {
                                if (cj === ']') inCls = false;
                            } else if (cj === '[') {
                                inCls = true;
                            } else if (cj === '/') {
                                closed = true;
                                j++;
                                break;
                            }
                            j++;
                        }
                        if (closed) {
                            var k = j;
                            while (k < n && /[a-z]/i.test(s.charAt(k))) k++;
                            protectedStrs.push(s.slice(i, k));
                            out += '\x00PS' + (protectedStrs.length - 1) + '\x00';
                            lastSig = ')';  // 正则字面量视作值：紧随其后的 / 当除号
                            word = '';
                            i = k;
                            continue;
                        }
                    }
                } else if (c === '`' && opts.template) {
                    // 模板字面量：配对到闭合反引号（\ 转义整体过）。未闭合留在流中
                    // 由反引号残留检测兜底降级（对齐旧正则行为）。
                    var te = i + 1;
                    while (te < n) {
                        if (s.charAt(te) === '\\') { te += 2; continue; }
                        if (s.charAt(te) === '`') break;
                        te++;
                    }
                    if (te < n) {
                        var converted = _convertTemplate(s.slice(i, te + 1), protectedStrs);
                        if (converted === null) {
                            opts.degraded = true;  // 插值配对失败：整段入池，上层降级
                            protectedStrs.push(s.slice(i, te + 1));
                            out += '\x00PS' + (protectedStrs.length - 1) + '\x00';
                        } else {
                            out += converted;
                        }
                        lastSig = ')';  // 模板（或其转译产物）是值
                        word = '';
                        i = te + 1;
                        continue;
                    }
                }
                out += c;
                if (!/\s/.test(c)) {
                    lastSig = c;
                    word = /[\w$]/.test(c) ? word + c : '';
                }
                i++;
            }
            return out;
        }

        function _restoreNewlinesLocal(script) {
            if (!script) return script;
            var lineCount = (script.match(/\n/g) || []).length;
            var semiCount = (script.match(/;/g) || []).length;
            if (lineCount > semiCount * 0.1 || semiCount < 3) return script;

            // 保护字符串字面量/注释/正则字面量，避免其中的 { } ; 被换行替换破坏
            // （ScriptUI resource string、行注释内的 "; " 一旦被切分，注释词会泄漏
            // 成活代码；/[{}]/ 类正则内不允许行终止符）。 改为单遍统一
            // 词法扫描（旧两遍结构里正则内的引号会与字符串规则错配出幻影字符串，
            // 与 transpile 主链路同款缺陷）；字符串入池时同步转义
            // U+2028/U+2029。
            var protectedStrs = [];
            var s = tokenizeProtect(script, protectedStrs, {});

            s = s.replace(/\{ /g, '{\n  ');
            s = s.replace(/ ?\}/g, '\n}');
            s = s.replace(/; /g, ';\n');
            s = s.replace(/\n\s*\n/g, '\n');

            // 还原字符串
            s = s.replace(/\x00PS(\d+)\x00/g, function (m, idx) {
                return protectedStrs[parseInt(idx, 10)] || m;
            });

            return s;
        }

        // 悬空续接运算符判定——运算符结尾的换行不触发 ASI（x => a &&\n b
        // 是合法跨行续接），此时换行不是表达式边界。++/-- 例外：后缀自增/自减是
        // 完整表达式，换行后 ASI 生效（x++\n y 是两条语句），续接会把下一条语句
        // 吞进 return 造成语义漂移。
        function _endsWithDanglingOp(tail) {
            if (/\+\+$|--$/.test(tail)) return false;
            return /(?:&&|\|\||[.+\-*/%<>=&|^])$/.test(tail);
        }

        // 箭头表达式体提取：从 => 之后按圆括号/花括号配对扫描取表达式文本，
        // 修复 [^{;\n]+ 正则的两类断裂（在 { 处腰斩 => ({...})、贪婪吞掉内层箭头与
        // 后半段代码）。块体（=> {）、未闭合括号/引号等无法安全配对的形态返回 null，
        // 交由上层降级处理（fail-safe：宁可少转不可转坏）。
        function extractArrowBody(s, start) {
            var n = s.length;
            var i = start;
            while (i < n && /\s/.test(s.charAt(i))) i++;
            // 跳过被保护的注释/字符串占位符后再判块体（=> /* c */ { 同为块体）
            var probe = i;
            while (probe < n && s.charAt(probe) === '\x00') {
                var phEnd = s.indexOf('\x00', probe + 1);
                if (phEnd === -1) break;
                probe = phEnd + 1;
                while (probe < n && /\s/.test(s.charAt(probe))) probe++;
            }
            if (probe >= n || s.charAt(probe) === '{') return null;
            var depth = 0, brace = 0, brack = 0, quote = null;
            var j = i;
            while (j < n) {
                var ch = s.charAt(j);
                if (quote) {
                    if (ch === '\\') { j += 2; continue; }
                    if (ch === quote) quote = null;
                    j++;
                    continue;
                }
                if (ch === '"' || ch === "'") { quote = ch; j++; continue; }
                if (ch === '(') { depth++; j++; continue; }
                if (ch === ')') { if (depth === 0) break; depth--; j++; continue; }
                if (ch === '{') { brace++; j++; continue; }
                if (ch === '}') { if (brace === 0) break; brace--; j++; continue; }
                if (ch === '[') { brack++; j++; continue; }
                if (ch === ']') { if (brack === 0) break; brack--; j++; continue; }
                // 三元边界——箭头体吞并外层三元的后半段（useA ? x => x * 2 :
                // fallback 产出 "return x * 2 : fallback;" 断裂）与体内自带三元
                //（x => c ? a : b）都无法安全切分，body 顶层 ? /: 一律 return null
                // 降级交 LLM 改写（保守取舍：宁可少转不可转坏）。
                if ((ch === '?' || ch === ':') && depth === 0 && brace === 0 && brack === 0) return null;
                if ((ch === ',' || ch === ';' || ch === '\n' || ch === '\r') && depth === 0 && brace === 0 && brack === 0) {
                    // 运算符结尾的换行不触发 ASI（x => a &&\n b 合法跨行
                    // 续接），旧逻辑无条件以 \n 截断产出 "return a &&; }" 类语法错误
                    // 且无 => 残留不触发降级。已累积 body 尾部（去尾空白）为悬空
                    // 二元/三元运算符时继续跨行扫描；判不出的形态保守截断。
                    // 判定前先剥尾随注释占位符（与 utils.js 主实现逐字
                    // 同步）——词法保护后行注释是 \x00PS<n>\x00，以 \x00 结尾不匹配
                    // 悬空运算符 → 保守截断 → 注释吞 "; }" 产物断裂（转坏不降级）。
                    var _tail = s.slice(i, j).replace(/(?:\x00PS\d+\x00\s*)+$/, '').replace(/\s+$/, '');
                    if ((ch === '\n' || ch === '\r') && _endsWithDanglingOp(_tail)) { j++; continue; }
                    break;
                }
                j++;
            }
            if (quote !== null || depth !== 0 || brace !== 0 || brack !== 0) return null;
            var body = s.slice(i, j);
            if (!body.replace(/\s/g, '')) return null;
            return { body: body, end: j };
        }

        // 单次箭头转换：逐个匹配箭头头部，表达式体配对提取。
        // 替换产物中新暴露的内层箭头（链式调用的后续箭头、柯里化外层）留给下一轮，
        // 由 transpileEs6ToEs3 迭代调用直至无箭头或无进展。
        // ES3 参数表合法性——仅接受标识符列表（空表/单标识符/逗号分隔
        // 多标识符）。解构 ({a})、默认值 (a=1) 等形态转出 function({a})/(a=1) 在
        // ES3 同样非法，校验不过即跳过，交由残留箭头检测降级返回原码。
        function _validEs3Params(p) {
            var t = String(p).replace(/^\s+|\s+$/g, '');
            if (t === '') return true;
            return /^[A-Za-z_$][\w$]*(\s*,\s*[A-Za-z_$][\w$]*)*$/.test(t);
        }

        function convertArrowPass(s) {
            var out = '';
            var pos = 0;
            var re = /(\(([^()]*)\)|[A-Za-z_$][\w$]*)\s*=>/g;
            var m;
            while ((m = re.exec(s)) !== null) {
                var b = extractArrowBody(s, m.index + m[0].length);
                if (b === null) continue;  // 块体（已由块体规则处理）或异常形态：跳过
                var params = m[1].charAt(0) === '(' ? m[2] : m[1];
                if (!_validEs3Params(params)) continue;  // 非法参数表跳过（降级）
                out += s.slice(pos, m.index);
                out += 'function(' + params + ') { return ' + b.body + '; }';
                pos = b.end;
                re.lastIndex = b.end;
            }
            return out + s.slice(pos);
        }

        // for(let/const 头 + 循环体内闭包检测——let→var 把每次迭代的独立
        // 绑定坍缩成单一 var，循环体内创建的箭头/function 闭包全部共享同一变量
        //（经典 for (let i) fns.push(() => i) 的 0/1/2 静默变 3/3/3，产物无语法
        // 错误、纯语义漂移）。命中即降级原样返回交 LLM 改写（IIFE 捕获）；无闭包
        // 的 for-let 照常 let→var（避免大面积误伤）。入参为词法保护后的代码流
        //（字符串/注释已占位，命中只发生在代码位）。
        function _hasForLetClosure(s) {
            var n = s.length;
            var re = /\bfor\s*\(\s*(?:let|const)\b/g;
            var m;
            while ((m = re.exec(s)) !== null) {
                // 括号配对定位 for 头部闭合 )（条件表达式里的调用等内层括号计入深度）
                var d = 1;
                var k = m.index + m[0].length;
                while (k < n && d > 0) {
                    var hc = s.charAt(k);
                    if (hc === '(') d++;
                    else if (hc === ')') d--;
                    k++;
                }
                if (d !== 0) return true;  // 头部未闭合的异常形态：保守降级
                var bodyStart = k;
                while (bodyStart < n && /\s/.test(s.charAt(bodyStart))) bodyStart++;
                var bodyEnd;
                if (s.charAt(bodyStart) === '{') {
                    // 块体：花括号配对到闭合 }
                    var b = 1;
                    var e = bodyStart + 1;
                    while (e < n && b > 0) {
                        var bc = s.charAt(e);
                        if (bc === '{') b++;
                        else if (bc === '}') b--;
                        e++;
                    }
                    if (b !== 0) return true;  // 未闭合：保守降级
                    bodyEnd = e;
                } else {
                    // 单语句体：扫到深度 0 的 ; 或换行
                    var sd = 0;
                    var e2 = bodyStart;
                    while (e2 < n) {
                        var sc = s.charAt(e2);
                        if (sc === '(' || sc === '[' || sc === '{') sd++;
                        else if (sc === ')' || sc === ']' || sc === '}') { if (sd === 0) break; sd--; }
                        else if ((sc === ';' || sc === '\n') && sd === 0) break;
                        e2++;
                    }
                    bodyEnd = e2;
                }
                var body = s.slice(bodyStart, bodyEnd);
                // 检测范围扩到 for 头部（与 utils.js 主实现逐字同步）——
                // for (let f = () => i; ...) 的初始化闭包捕获循环变量时 let→var
                // 同样语义漂移（只扫循环体漏掉头部时）
                var header = s.slice(m.index, bodyStart);
                if (body.indexOf('=>') !== -1 || /\bfunction\b/.test(body) ||
                    header.indexOf('=>') !== -1 || /\bfunction\b/.test(header)) return true;
            }
            return false;
        }

        // 转译核心返回 { out, degraded }——降级标志供 _cleanScriptContentLocal
        // 跳过 restoreNewlines 的二次加工；_transpileEs6ToEs3Local 公开签名不变。
        function _transpileCoreLocal(script) {
            if (!script) return { out: script, degraded: false };
            var s = script;

            // 单遍统一词法扫描入池（字符串/模板/注释/正则一次识别，模板
            // 就地转 ES3）。插值配对失败降级（fail-safe）：嵌套模板等复杂形态宁可
            // 少转不可转坏，直接返回原码，让上层按 ES6 报错而非转坏。
            var protectedStrs = [];
            var topts = { template: true };
            s = tokenizeProtect(s, protectedStrs, topts);
            if (topts.degraded) return { out: script, degraded: true };

            // 反引号错配降级（fail-safe）：保护后仍残留的反引号意味着模板定界符,            // 无法安全闭合（如插值段里的嵌套模板），继续转译会把整段代码错配成,            // 「幻影模板」再转成字符串常量。宁可少转不可转坏——直接返回原码。
            if (/`/.test(s)) return { out: script, degraded: true };

            // for(let/const 头 + 循环体内闭包——let→var 语义漂移无法靠
            // 语法检查兜底（产物合法但闭包共享变量），检测命中降级原样返回。
            if (_hasForLetClosure(s)) return { out: script, degraded: true };

            // 点号后的属性名不参与关键字转译：let 在 ES3 是普通标识符，
            // obj.let 合法而 obj.var 是语法错误——替换正则排除 . 前缀
            s = s.replace(/(^|[^.\w$])const\b/g, '$1var');
            s = s.replace(/(^|[^.\w$])let\b/g, '$1var');
            // 块体箭头先行转换（沿用原规则）
            s = s.replace(/\(([^)]*)\)\s*=>\s*\{/g, function (mm, p) {
                // 参数表仅接受 ES3 合法的标识符列表——解构/默认值形态
                // 转出 function({a})/(a=1) 非法，不替换交由残留箭头检测降级
                return _validEs3Params(p) ? 'function(' + p + ') {' : mm;
            });
            // 块体箭头先行转换（沿用原规则）。 单参正则改为前缀捕获式
            // [A-Za-z_$][\w$]*——旧 \b(\w+) 的 \w 不含 $ 且 \b 无法在 $ 前成立，
            // $el => { 产出「$function(el) {」悬挂美元符语法错乱（LLM 惯用
            // $el/$scope 命名高频命中）；同时排除 . 前缇（对齐 let/const 替换，
            // obj.x => { 类非法形态不匹配、交由下方残留箭头检测降级）
            s = s.replace(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>\s*\{/g, '$1function($2) {');
            // 表达式体箭头：配对提取迭代转换，内层箭头逐次暴露；
            // 上限 10 轮 + 无进展即退出的双重死循环防护
            var round;
            for (round = 0; round < 10; round++) {
                if (!ARROW_HEAD.test(s)) break;
                var next = convertArrowPass(s);
                if (next === s) break;
                s = next;
            }
            // 残留箭头 = 无法安全配对的形态：降级返回原码（fail-safe）。
            // 带默认值/解构参数的箭头头部（(a=(1))=>x、({a})=>x）
            // 含内层括号，ARROW_HEAD 的保守参数表 [^()]* 刻意不匹配——此类
            // 箭头绕过本检查静默漏转，产出「let 已替换而 => 残留」的半处理代码；
            // 补「残留 => 独立扫描」作降级判据（字符串/注释/正则均已入池，流中
            // => 只可能在代码位）。注：参数表括号配对提取不做——默认值/解构参数
            // 转成 function 参数表在 ES3 同样非法，降级报错是唯一正确处置。
            if (ARROW_HEAD.test(s) || s.indexOf('=>') !== -1) return { out: script, degraded: true };

            // 还原被保护的字符串
            s = s.replace(/\x00PS(\d+)\x00/g, function (m, idx) {
                return protectedStrs[parseInt(idx, 10)] || m;
            });

            return { out: s, degraded: false };
        }

        function _transpileEs6ToEs3Local(script) {
            return _transpileCoreLocal(script).out;
        }

        function _cleanScriptContentLocal(script) {
            var cleaned = script || '';

            if (cleaned.includes('```')) {
                // 可选语言标记补 js（与 utils.js 主实现逐字同步）——
                // ```js 围栏下可选组匹配空，两字符 "js" 泄漏进脚本正文
                // 交替分支补 json 且必须排在 js 之前（与 utils.js 主实现
                // 逐字同步）——```json 围栏会先命中 js 前缀，"on" 两字符泄漏进
                // 脚本正文；fallback 分支同步补 json（同样须排在 jsx? 之前）
                // fallback 分支补 javascript（与 utils.js 主实现逐字同步）——
                // jsx? 只匹配 js/jsx，```javascript 围栏未闭合落入 fallback 时首二字
                // "ja" 失配 "js"，剥围栏后 javascript 一词残留为脚本首行裸标识符；
                // 与主分支同序（jsx|javascript|json|js）
                var codeMatch = cleaned.match(/```(?:jsx|javascript|json|js)?\n?([\s\S]*?)```/);
                if (codeMatch) {
                    cleaned = codeMatch[1];
                } else {
                    cleaned = cleaned.replace(/```(?:javascript|json|jsx?)/g, '').replace(/```/g, '');
                }
            }

            // __LINE__ 替换仅在压缩形态下进行——__LINE__ 是 ExtendScript
            // 的行号魔术常量（调试惯用法 alert('at ' + __LINE__)），无条件替换为换行
            // 会破坏其语义（字符串内的 __LINE__ 被换成裸换行更是直接断串）。压缩
            // 形态判定对齐 restoreNewlines 入口条件：明显被压成一行的脚本才把
            // __LINE__ 当换行标记还原，正常多行/少分号脚本保留调试语义。
            var minLc = (cleaned.match(/\n/g) || []).length;
            var minSc = (cleaned.match(/;/g) || []).length;
            if (!(minLc > minSc * 0.1 || minSc < 3)) {
                // __LINE__ 替换先经词法保护池化——裸 replace 连字符串
                // 字面量内的 __LINE__ 文本一并换成裸换行断串（裸 replace 时压缩形态
                // alert("at __LINE__") 直接产出断串 SyntaxError）；只替换代码位，
                // 字符串/注释/正则内的 __LINE__ 保留原样。
                var lineStrs = [];
                var lineS = tokenizeProtect(cleaned, lineStrs, {});
                lineS = lineS.replace(/__LINE__/g, '\n');
                cleaned = lineS.replace(/\x00PS(\d+)\x00/g, function (m, idx) {
                    return lineStrs[parseInt(idx, 10)] || m;
                });
            }

            var tres = _transpileCoreLocal(cleaned);
            cleaned = tres.out;
            // 转译降级时跳过 restoreNewlines——降级合同是「原样返回让
            // 上层按 ES6 报错」，而 restoreNewlines 的换行重排会对降级产物中的
            // 模板字面量二次加工（ES6 模板内换行是字面内容，{ ; 处插换行即改值），
            // 破坏 fail-safe。非降级路径行为不变。
            if (!tres.degraded) {
                cleaned = _restoreNewlinesLocal(cleaned);
            }

            // 拉平只作用于「单个字符串字面量参数」：旧正则 [\s\S]*? 在参数为
            // 拼接表达式（首个引号串闭引号后不是 )）时会越过语句边界，与后文调用的
            // 引号错配，把行注释后的整段调用吞进 alert 字符串再静默删除。限定在单个
            // 字面量内匹配后，拼接/多参形态直接不处理（fail-safe：宁可不拉平不可吞
            // 代码），跨行字符串参数的换行压缩语义保持不变。
            cleaned = cleaned.replace(/alert\(("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\)/g, function (m, str) {
                var q = str.charAt(0);
                return 'alert(' + q + str.slice(1, -1).replace(/\r?\n/g, ' ') + q + ')';
            });

            return cleaned.trim();
        }

        // 统计字符串中某字符出现次数（供 buildSegments 按花/圆括号平衡切分逻辑块）
        function countChar(str, ch) {
            if (!str) return 0;
            var n = 0;
            for (var i = 0; i < str.length; i++) if (str.charAt(i) === ch) n++;
            return n;
        }

        // 按行统计代码位的 {}/() 增量（跨行状态机）——字符串/块注释/
        // 行注释/正则字面量内的括号不计入。buildSegments 裸按字符计数时：
        // 字符串内单边括号（alert("}")）使段提前断开，后续段 startLine/endLine
        // 整体错位，模型据错行号定位就找错段（编辑按内容锚定，行号仍用于读取
        // 与沟通，错位照样误导）。
        // 行号结构与传入 lines 严格一一对应（不池化整文——池化会合并跨行注释
        // 所在行，行号漂移）。字符串/正则视为行内闭合（合法代码的口径）；未
        // 闭合的异常形态保守按普通字符计数（退化到旧行为，不额外误切）。
        // 正则/除号歧义沿用 tokenizeProtect 的上下文判定（前一有效字符 + 关键字表）。
        function _lineBracketCounts(lines) {
            var counts = [];
            var inBlock = false;   // 跨行块注释状态
            var lastSig = '';      // 上一个代码位有效字符（行间延续，供正则判定）
            var word = '';
            var KW = /^(?:return|typeof|instanceof|in|new|delete|void|throw|case|do|else)$/;
            for (var li = 0; li < lines.length; li++) {
                var line = lines[li];
                var b = 0, p = 0;
                var i = 0;
                var n = line.length;
                while (i < n) {
                    var c = line.charAt(i);
                    if (inBlock) {
                        var be = line.indexOf('*/', i);
                        if (be === -1) { i = n; continue; }
                        inBlock = false;
                        i = be + 2;
                        lastSig = '\x00'; word = '';
                        continue;
                    }
                    if (c === '"' || c === "'") {
                        // 行内字符串：配对到闭合引号（\ 转义整体过）；未闭合按普通字符
                        var se = i + 1;
                        var closed = false;
                        while (se < n) {
                            if (line.charAt(se) === '\\') { se += 2; continue; }
                            if (line.charAt(se) === c) { closed = true; break; }
                            se++;
                        }
                        if (closed) { i = se + 1; lastSig = ')'; word = ''; continue; }
                        i++;
                        continue;
                    }
                    if (c === '/' && i + 1 < n && line.charAt(i + 1) === '*') {
                        var be2 = line.indexOf('*/', i + 2);
                        if (be2 === -1) { inBlock = true; i = n; continue; }
                        i = be2 + 2;
                        lastSig = '\x00'; word = '';
                        continue;
                    }
                    if (c === '/' && i + 1 < n && line.charAt(i + 1) === '/') break;   // 行注释：余下行不计
                    if (c === '/') {
                        var rs;
                        if (lastSig === '') rs = true;
                        else if (lastSig === ')' || lastSig === ']' || lastSig === '}') rs = false;
                        else if (/[\w$]/.test(lastSig)) rs = KW.test(word);
                        else rs = true;
                        if (rs) {
                            var rj = i + 1, inCls = false, closedR = false;
                            while (rj < n) {
                                var rc = line.charAt(rj);
                                if (rc === '\\') { rj += 2; continue; }
                                if (inCls) { if (rc === ']') inCls = false; }
                                else if (rc === '[') inCls = true;
                                else if (rc === '/') { closedR = true; rj++; break; }
                                rj++;
                            }
                            if (closedR) {
                                while (rj < n && /[a-z]/i.test(line.charAt(rj))) rj++;
                                i = rj;
                                lastSig = ')'; word = '';
                                continue;
                            }
                        }
                        // 除号（或未闭合按除号）：普通字符
                        lastSig = '/'; word = '';
                    } else if (c === '{') { b++; lastSig = c; word = ''; }
                    else if (c === '}') { b--; lastSig = c; word = ''; }
                    else if (c === '(') { p++; lastSig = c; word = ''; }
                    else if (c === ')') { p--; lastSig = c; word = ''; }
                    else if (/[\w$]/.test(c)) { word += c; lastSig = c; }
                    else if (!/\s/.test(c)) { lastSig = c; word = ''; }
                    i++;
                }
                counts.push({ b: b, p: p });
            }
            return counts;
        }

        // 按逻辑块拆分代码行：从非空行起，跟踪 {} 与 () 平衡，直到两者都归零视为一段。
        // 返回 [{ startLine, endLine, snippet }]（1-based 闭区间），便于 LLM 定位要修改的段。
        function buildSegments(lines) {
            var segs = [];
            var n = lines.length;
            // 括号计数经词法状态机（字符串/注释/正则内不计）——见函数注释
            var counts = _lineBracketCounts(lines);
            var i = 0;
            while (i < n) {
                if (lines[i].trim() === '') { i++; continue; }
                var brace = 0, paren = 0, end = -1;
                for (var j = i; j < n; j++) {
                    brace += counts[j].b;
                    paren += counts[j].p;
                    if (brace <= 0 && paren <= 0) { end = j; break; }
                }
                if (end === -1) end = n - 1;
                var snippet = '';
                for (var k = i; k <= end; k++) {
                    var t = lines[k].trim();
                    if (t) { snippet = t.length > 64 ? t.slice(0, 64) + '…' : t; break; }
                }
                segs.push({ startLine: i + 1, endLine: end + 1, snippet: snippet });
                i = end + 1;
            }
            return segs;
        }

        // 对外转译入口——可用时委托 AEAgentApp.scriptUtils（单一实现），
        // 独立沙箱回退上方逐字同步的本地副本，两条路径行为等价。
        function restoreNewlines(script) {
            var su = _scriptUtils();
            return su ? su.restoreNewlines(script) : _restoreNewlinesLocal(script);
        }

        function transpileEs6ToEs3(script) {
            var su = _scriptUtils();
            return su ? su.transpileEs6ToEs3(script) : _transpileEs6ToEs3Local(script);
        }

        function cleanScriptContent(script) {
            var su = _scriptUtils();
            return su ? su.cleanScriptContent(script) : _cleanScriptContentLocal(script);
        }

        return { restoreNewlines: restoreNewlines, transpileEs6ToEs3: transpileEs6ToEs3, countChar: countChar, buildSegments: buildSegments, cleanScriptContent: cleanScriptContent };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createScriptTranscode = createScriptTranscode;
})(typeof global !== 'undefined' ? global : window);
