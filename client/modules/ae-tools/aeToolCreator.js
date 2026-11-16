/**
 * aeToolCreator.js - LLM 创作 AE 工具的无 UI 核心
 *
 * 职责：
 * 1. 参数校验 -> 构建 toolDef -> 更新 _aeToolsData -> _aeHotReload 持久化+重注册。
 * 2. 注册 createAETool / deleteAETool 两个工具。
 *    （不提供 listAeFunctions 查询工具；扫描在 bootstrap.js / controller.js，
 *      服务面板库函数浏览器。）
 *
 * 复用现有 hotReload 机制（注销旧工具 -> 存盘 -> 重新注册），不引入新的执行路径。
 *
 * 由 bootstrap.js 装配；测试中以 mock 依赖注入。
 */
(function (global) {

    // 剥离正则字面量——/\(/、/\)/ 等正则里的括号会干扰平衡计数，
    // 含正则的合法工具代码被误报为括号不匹配（fail-closed 误拦）。
    // 启发式判定 / 为正则起点还是除号：最近词为关键字（return/typeof/in/of/instanceof/
    // new/delete/void/throw/case/do/else/yield）或前一非空白字符为运算符/分隔符
    // （( [ { } , = ! ? ; & | + - * % ^ ~ < > 或起始）→ 正则起点；
    // 标识符/数字/右圆括号/右方括号后 → 除号（arr[i] / 2、foo() / 2 不误剥）。
    // 正则不跨行（换行仍未闭合则保留原文，不影响计数）；支持 \/ 转义与 [...] 字符类内的 /。
    // 与 view.js 保存校验中的同名函数保持一致（两处同步修复，防逻辑漂移）。
    function stripRegexLiterals(src) {
        var KEYWORDS = { return: 1, typeof: 1, instanceof: 1, in: 1, of: 1, new: 1, delete: 1, void: 1, throw: 1, case: 1, do: 1, else: 1, yield: 1 };
        var out = [];
        var word = '';   // 当前累积的词（跨空白累积："return x / 2" 累积为 "returnx"，非关键字 → 除号，判定恰好正确）
        var lastCh = ''; // 最近一个非空白字符
        var i = 0, len = src.length;
        while (i < len) {
            var ch = src.charAt(i);
            if (ch === '/') {
                var isRegex = false;
                if (word) {
                    isRegex = !!KEYWORDS[word];
                } else {
                    isRegex = lastCh === '' || '([{,=!?;&|+-*%^~<>}'.indexOf(lastCh) >= 0;
                }
                if (isRegex) {
                    var j = i + 1, inClass = false, closed = false;
                    while (j < len) {
                        var c2 = src.charAt(j);
                        if (c2 === '\\') { j += 2; continue; }
                        if (c2 === '\n') break;
                        if (c2 === '[') inClass = true;
                        else if (c2 === ']') inClass = false;
                        else if (c2 === '/' && !inClass) { closed = true; break; }
                        j++;
                    }
                    if (closed) {
                        j++;
                        while (j < len && 'gimsuy'.indexOf(src.charAt(j)) >= 0) j++;
                        out.push(' ');
                        lastCh = '/'; word = '';
                        i = j;
                        continue;
                    }
                }
                // 除号或未闭合的伪正则：保留原文（未闭合段内的括号原样参与计数）
                out.push(ch);
                lastCh = '/'; word = '';
                i++;
                continue;
            }
            out.push(ch);
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
                // 空白不更新状态：关键字与 / 之间、"x" 与 / 之间都可能有空白
            } else if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '$') {
                word += ch;
                lastCh = ch;
            } else {
                word = '';
                lastCh = ch;
            }
            i++;
        }
        return out.join('');
    }

    /**
     * 单趟状态机剥离注释与字符串字面量（代码位保留）。
 * 的「先剥注释再剥字符串」链式替换引入反向缺陷——字符串
     * 字面量内的 //（如 "http://a"、file:///）被当行注释起点，整行后半段连带闭
     * 引号/闭括号被剥掉，括号计数必然失真、合法工具被误拒（旧顺序则被注释撇号
     * 误伤，两个顺序各有盲区）。单趟扫描同时跟踪字符串/注释上下文，两侧都正确：
 * 注释里的撇号不再误配对（修复保持），字符串里的 // 不再被当注释
 * （新修）。未闭合的块注释/字符串保留原文（与旧正则「匹配不上即
     * 保留」行为对齐，保守交给括号计数暴露异常）。
     */
    function _stripCommentsAndStrings(code) {
        var out = [];
        var n = code.length;
        var i = 0;
        while (i < n) {
            var c = code.charAt(i);
            var c2 = (i + 1 < n) ? code.charAt(i + 1) : '';
            if (c === '/' && c2 === '*') {
                var bcEnd = code.indexOf('*/', i + 2);
                if (bcEnd === -1) { out.push(code.slice(i)); break; }   // 未闭合：保留原文
                i = bcEnd + 2;
                continue;
            }
            if (c === '/' && c2 === '/') {
                var nl = code.indexOf('\n', i + 2);
                if (nl === -1) break;   // 行注释吞到末尾
                i = nl;   // 保留换行（行结构不影响计数）
                continue;
            }
            if (c === '"' || c === "'") {
                var j = i + 1;
                while (j < n) {
                    var cj = code.charAt(j);
                    if (cj === '\\') { j += 2; continue; }
                    if (cj === c) break;
                    j++;
                }
                if (j >= n) { out.push(code.slice(i)); break; }   // 未闭合：保留原文
                i = j + 1;
                continue;
            }
            out.push(c);
            i++;
        }
        return out.join('');
    }

    /**
     * ExtendScript 括号平衡检查（与 view.js 保存校验逻辑一致）。
     * 先去掉注释和字符串字面量再做括号计数，避免字符串/注释中的括号干扰判断。
     */
    function checkBracketBalance(code) {
        var cleanCode = _stripCommentsAndStrings(code);
        // 字符串/注释剥离后增补正则字面量剥离（/\(/ 等正则中的括号不再干扰计数）
        cleanCode = stripRegexLiterals(cleanCode);
        var depth = 0;
        for (var i = 0; i < cleanCode.length; i++) {
            var ch = cleanCode[i];
            if (ch === '{' || ch === '(' || ch === '[') depth++;
            else if (ch === '}' || ch === ')' || ch === ']') depth--;
            if (depth < 0) return { ok: false, char: ch };
        }
        if (depth !== 0) return { ok: false, char: null, depth: depth };
        return { ok: true };
    }

    /**
     * 扫描 aeTools.jsx 源码，提取顶层函数定义。
     * 返回 [{ name, params, body, line }]，其中 params 是从函数体中提取的 args.xxx 用法。
     * 跳过以 _ 开头的内部辅助函数。
     * 括号计数时先去掉字符串字面量，避免字符串中的花括号干扰。
     */
    function scanAeFunctions(jsxSource) {
        if (!jsxSource) return [];
        var functions = [];
        var lines = jsxSource.split('\n');
        var i = 0;
        while (i < lines.length) {
            var match = lines[i].match(/^function\s+(\w+)\s*\(([^)]*)\)/);
            if (match) {
                var name = match[1];
                var rawParams = match[2].replace(/\s+/g, ' ').trim();
                if (name.charAt(0) === '_') { i++; continue; }
                // 花括号计数定位函数体结尾
                var startLine = i;
                var braceCount = 0;
                var foundOpen = false;
                var bodyLines = [];
                while (i < lines.length) {
                    var line = lines[i];
                    var cleanLine = line.replace(/(["'])(?:\\.|(?!\1).)*?\1/g, '');
                    for (var j = 0; j < cleanLine.length; j++) {
                        if (cleanLine[j] === '{') { braceCount++; foundOpen = true; }
                        else if (cleanLine[j] === '}') { braceCount--; }
                    }
                    bodyLines.push(line);
                    if (foundOpen && braceCount === 0) break;
                    i++;
                }
                var body = bodyLines.join('\n');
                // 提取 args.xxx 参数名（去重，保持出现顺序）
                var params = [];
                var seen = {};
                var re = /args\.(\w+)/g;
                var pm;
                while ((pm = re.exec(body)) !== null) {
                    if (!seen[pm[1]]) { seen[pm[1]] = true; params.push(pm[1]); }
                }
                functions.push({ name: name, rawParams: rawParams, params: params, body: body, line: startLine + 1 });
            }
            i++;
        }
        return functions;
    }

    /**
     * 创建 AE 工具核心工厂（依赖注入）。
     * deps:
     *   toolRegistry  - 必填，工具注册表
     *   getToolsData  - 可选，返回 _aeToolsData 数组的函数（测试注入 mock）
     *   hotReload     - 可选，热重载函数（测试注入 mock）
     *   getCategories - 可选，返回合法分类列表的函数（测试注入 mock）
     *   onChanged     - 可选，创建/覆盖成功后回调
     */
    function createAEToolCreator(deps) {
        deps = deps || {};
        var toolRegistry = deps.toolRegistry || (global.AE_LLM && global.AE_LLM.toolRegistry) || null;

        function getToolsData() {
            if (typeof deps.getToolsData === 'function') return deps.getToolsData();
            return (global.AE_LLM && global.AE_LLM._aeToolsData) ? global.AE_LLM._aeToolsData : [];
        }

        // 该名字是否被「非 ae-tools 来源」的注册表条目占用（其它模块 bootstrap 注册的内建工具）。
        // 返回条目或 null；注册表无查询能力时返回 null（fail-open：纵深防护的补充，不得打死创建主流程）。
        // 注意这是 controller.isNameTakenByBuiltin 的**孪生实现**（判据必须一致）——两处不能合并成
        // 一处：creator 在 bootstrap 期构造（只拿到 toolRegistry），那时 controller 实例还不存在，
        // 故无法注入。一致性由两条路径断言共同看住。
        function _builtinNameOwner(name) {
            if (!name || !toolRegistry) return null;
            var entry = (typeof toolRegistry.get === 'function') ? toolRegistry.get(name) : null;
            if (!entry && typeof toolRegistry.hasTool === 'function' && toolRegistry.hasTool(name)) {
                entry = { name: name, source: null };
            }
            if (!entry) return null;
            if (entry.source === 'ae-tools') return null;
            return entry;
        }

        function hotReload(registry, toolsArray) {
            if (typeof deps.hotReload === 'function') return deps.hotReload(registry, toolsArray);
            if (global.AE_LLM && typeof global.AE_LLM._aeHotReload === 'function') {
                return global.AE_LLM._aeHotReload(registry, toolsArray);
            }
            return { ok: false, error: 'HOTRELOAD_UNAVAILABLE' };
        }

        function getCategories() {
            if (typeof deps.getCategories === 'function') return deps.getCategories();
            return (global.AE_LLM && global.AE_LLM.AE_CATEGORIES) || [];
        }

        var onChanged = typeof deps.onChanged === 'function' ? deps.onChanged : function () {};

        // 预审查通过缓存：reviewToolCreation 通过后写入，createAETool 据此跳过重复审查。
        // key = JSON.stringify([name, description, extendScript])，避免 LLM 在 createAETool 阶段
        // bait-and-switch 改代码或改描述（description 是提示注入载体，同样入 key）。
        // 用闭包变量而非 args 字段传递，LLM 无法通过 args 注入绕过审查。
        // 每条含完整 ExtendScript 源码（数十 KB 量级），FIFO 上限防长期会话无限增长
        var _preReviewed = {};
        var _preReviewedKeys = [];
        var _PRE_REVIEWED_MAX = 50;
        function _preReviewedSet(key) {
            _preReviewed[key] = true;
            _preReviewedKeys.push(key);
            if (_preReviewedKeys.length > _PRE_REVIEWED_MAX) {
                delete _preReviewed[_preReviewedKeys.shift()];
            }
        }

        // 写操作串行化：与 controller 的 saveTool/deleteTool/toggleToolEnabled 共享同一条
        // Promise 链（经 global.AE_LLM._aeWriteQueue），避免并发写互相覆盖
        // （如 LLM 审查等待期间的 UI 增删改被陈旧快照回滚）。
        function _serializedWrite(fn) {
            var prev = (global.AE_LLM && global.AE_LLM._aeWriteQueue) || Promise.resolve();
            var run = prev.then(fn);
            var next = run.then(function () {}, function () {});
            if (global.AE_LLM) global.AE_LLM._aeWriteQueue = next;
            return run;
        }

        function _fail(code, detail) {
            return { ok: false, error: code, detail: detail || '' };
        }

        // 正则预检：快速拒绝 File/Folder 文件操作（构造即拒）+
        // AE 弹窗类函数 + 系统调用（开关关闭时）
        // AE 工具文件操作一律走参数式工具；禁止弹窗类 API（会阻断 Agent 自动执行）
        // system.callSystem/BridgeTalk 受 allowAEToolsSystemCall 开关控制：开关关闭时拦截，开启时放行
        // gateCovered 标记的文件面条目在 config 在场（AST 门预检已插入）
        // 时跳过——域关由门以 GATE_REJECTED 结构化拒绝（含行号/替代方案），域开/
        // bypass 由门放行（随 file 域演进并入；config 缺席的
        // 旧测试沙箱回落本表 regex——门缺席时 regex 是唯一防线）
        var WRITE_DELETE_PATTERNS = [
            // File/Folder 砍除（构造器整体拒绝）：
            // 落盘自定义工具库零 File/Folder 使用，合法场景已由参数式工具全覆盖
            // （readFile/writeFile/listFolderFiles/importFile/replaceFootage/applyPreset），
            // 构造器整体拒绝不构成能力损失；同时收掉「允许只读」这一绕过
            // _isSensitivePath 的读取通道（读侧姊妹面——fileGuard 只拦写，
            // 恶意工具可 new File 直读敏感文件 return 进 LLM 上下文）。
            // 无 i 标志：ExtendScript 构造器必须大写开头，小写 file( 系用户自定义函数不误伤。
            { pattern: /\b(?:new\s+)?(?:File|Folder)\s*\(/, msg: 'File/Folder 构造（文件能力域未开启——请改用 readFile/writeFile/listFolderFiles/importFile/replaceFootage 参数式工具）', gateCovered: true },
            { pattern: /\.open\s*\(\s*["']w["']/i, msg: 'File.open("w") 文件写入', gateCovered: true },
            { pattern: /\.open\s*\(\s*["']a["']/i, msg: 'File.open("a") 文件追加', gateCovered: true },
            { pattern: /\.open\s*\(\s*["']e["']/i, msg: 'File.open("e") 文件编辑', gateCovered: true },
            // \.save( 豁免 app.project.save()（AE 工程保存合法入口，非文件写入）。
            // 不用 lookbehind（项目无后行断言先例，CEP Chromium 版本不确定），改由
            // _regexPreCheck 命中该条时做行为级豁免：所有 .save( 均为 project.save( 形态才放行。
            { pattern: /\.save\s*\(/i, msg: 'File.save() 保存', allowProjectSave: true, gateCovered: true },
            { pattern: /\.saveAs\s*\(/i, msg: 'saveAs() 另存为', gateCovered: true },
            { pattern: /\.write\s*\(/i, msg: 'file.write() 写入', gateCovered: true },
            { pattern: /\.encoding\s*=/i, msg: 'file.encoding 赋值（配合写入）', gateCovered: true },
            // 原裸 /\.remove\(\)/ 不区分属主——layer.remove()/item.remove()/
            // comp.remove()/effect.remove() 全命中，合法内联 AE 对象删除逻辑的自定义工具
            // 被 fail-closed 误拒。收窄到 File/Folder 构造实例链：构造后 200 字符窗口内的
            // .remove(（覆盖直接链与存变量两形态，对齐表内 Folder(...).create( 的属主
            // 限定写法）。
            // 去掉 new\s+ 前缀要求——ExtendScript 构造器无 new 调用合法
            // （var f = File(p)，本项目 scriptRunner.jsx 即此惯用法），带 new 前缀时
            // 该形态全漏网。真实例链（app.project.file.remove() 删用户当前工程）与超窗
            // 变量间接形态静态不可见，由 bootstrap sandboxBlock 的 File/Folder 原型层
            // 拦截兜底（运行时下沉，对齐 语义）——静态预检 +
            // 运行时原型层双防线。窗口内 AE 对象 .remove() 误报为已知残余（
            // 属主静态不可判定），fail-closed 取向维持。
            { pattern: /(?:new\s+)?(?:File|Folder)\s*\([^)]*\)[\s\S]{0,200}\.remove\s*\(/i, msg: '.remove() 文件删除', gateCovered: true },
            // 补 \.execute(——File/Folder.execute 启动任意可执行文件，
            // 与 executeExtendScript 黑名单对齐；工具代码用到即拒绝创建
            //（硬拒照拦——不随 file 域放行，无 gateCovered）
            { pattern: /\.execute\s*\(/i, msg: '.execute() 启动可执行文件（系统级操作）' },
            { pattern: /Folder\s*\([^)]*\)\s*\.create\s*\(/i, msg: 'Folder.create() 创建文件夹', gateCovered: true },
            { pattern: /\balert\s*\(/i, msg: 'alert() 弹窗会阻断 Agent 自动执行' },
            { pattern: /\bconfirm\s*\(/i, msg: 'confirm() 弹窗会阻断 Agent 自动执行' },
            { pattern: /\bprompt\s*\(/i, msg: 'prompt() 弹窗会阻断 Agent 自动执行' },
            { pattern: /\bnew\s+Window\s*\(/i, msg: 'new Window() 自定义窗口会阻断 Agent 自动执行' }
        ];
        // 沙箱逃逸标识符：无条件拦截（__aeS* 是引擎侧防护安装/门面命名族——防护私有化后
        // 真实 system.callSystem 引用不再进全局，该模式拦字面量引用为纵深）
        // 撤销组不再拦截——工具代码可自写
        // beginUndoGroup/endUndoGroup（dispatcher 检测到即跳过框架外层包裹，避免嵌套
        // mismatch），不写则由 dispatcher 兜底包裹。
        // scheduleTask 同列 SYSCALL——延迟回调在脚本返回、shadow 已恢复之后执行
        // （无沙箱全局作用域 eval 任意代码），时间窗绕过双层沙箱；随开关控制。
        var SANDBOX_ESCAPE_PATTERN = /__aeS|__ael|_cs\b|\.evalFile|\.global\b|\brunScriptFromFile\b|_File\b|_Folder\b|_bt\b|_gFile\b|_gFolder\b|_gBT\b|_alert\b/i;
        // 系统调用：开关关闭时拦截
        var SYSCALL_PATTERN = /\bcallSystem\b|\bBridgeTalk\b|\bSocket\b|\bscheduleTask\b/i;

        function _regexPreCheck(extendScript) {
            var errors = [];
            // config 在场（AST 门预检已插入管线）时，gateCovered 文件面
            // 条目交由门承载——域关由 GATE_REJECTED 结构化拒绝（行号/construct/
            // 替代方案——LLM 自改写输入质量），域开/bypass 放行（能力域语义）
            var _gateFace = !!(global.AEGate && global.AEGate.config);
            for (var i = 0; i < WRITE_DELETE_PATTERNS.length; i++) {
                if (_gateFace && WRITE_DELETE_PATTERNS[i].gateCovered) continue;
                if (WRITE_DELETE_PATTERNS[i].pattern.test(extendScript)) {
                    // \.save( 豁免 app.project.save()——仅当代码中所有 .save( 均为
                    // project.save( 形态（两计数相等）才跳过该条；混入 file.save() 时
                    // 计数不等照常拦截（fail-closed）。
                    if (WRITE_DELETE_PATTERNS[i].allowProjectSave) {
                        var saveAll = (extendScript.match(/\.save\s*\(/gi) || []).length;
                        var saveProject = (extendScript.match(/project\s*\.\s*save\s*\(/gi) || []).length;
                        if (saveAll === saveProject) continue;
                    }
                    errors.push(WRITE_DELETE_PATTERNS[i].msg);
                }
            }
            if (errors.length > 0) {
                return {
                    ok: false,
                    detail: '检测到以下禁止的操作：\n'
                        + errors.map(function (e) { return '  - ' + e; }).join('\n')
                        + '\nFile/Folder 文件操作需用户在「Agent 模块设置 > AST 门能力配置」开启文件能力域；未开启时可改用 readFile/writeFile/listFolderFiles 等参数式工具（自定义工具代码内无法调用）。错误用 return 返回。'
                };
            }
            // 沙箱逃逸标识符：无条件拦截（撤销组不在此列）
            if (SANDBOX_ESCAPE_PATTERN.test(extendScript)) {
                return {
                    ok: false,
                    detail: 'AE 工具禁止使用沙箱逃逸标识符（__aeS*/__ael/_cs/$.evalFile/$.global/runScriptFromFile/_File/_Folder/_bt 等）。'
                };
            }
            // 系统调用：开关关闭时拦截
            // scheduleTask 同列——延迟回调在 shadow 恢复后执行，绕过双层沙箱
            var sysCallAllowed = !!(global.AE_LLM && global.AE_LLM.allowAEToolsSystemCall);
            if (!sysCallAllowed && SYSCALL_PATTERN.test(extendScript)) {
                return {
                    ok: false,
                    detail: 'system.callSystem（系统域）/Socket（网络域）需用户在「Agent 模块设置 > AST 门能力配置」开启对应能力域（默认关闭）；BridgeTalk/app.scheduleTask 无能力域开关，任何情况下禁止。'
                };
            }
            return { ok: true };
        }

        // 创建期门预检（validate-only）——只校验不写回（落盘
        // 原文，reemit 丢注释，「所存即所见」保持；执行期过门每次读盘重发射瞬态
        // 产物——本来就是现行行为）。拒绝以 GATE_REJECTED 结构化错误回喂 LLM
        // 自改写（含行号/construct/替代方案）。bypass['ae-tool'] ON 时 run.js 内部
        // 已把 policy 四域全开（门照跑——免打扰不是免检），调用方无需特殊处理。
        // 门缺席（旧测试沙箱未载 ast-gate）时返回 null 跳过——regex 层兜底。
        function _gatePreCheck(extendScript) {
            if (!(global.AE_LLM && typeof global.AE_LLM._runSandboxedScript === 'function')) {
                return null;
            }
            var _gate = global.AE_LLM._runSandboxedScript(extendScript, { source: 'ae-tool' });
            if (!_gate.ok) {
                var _alt = (_gate.error && _gate.error.alternative)
                    ? ' 替代方案：' + _gate.error.alternative : '';
                return _fail('GATE_REJECTED', (_gate.displayText || 'AST 门拒绝') + _alt);
            }
            // 门侧 AST 判据：没有可执行语句的代码（空块/空循环/只有注释或分号）过门后执行时什么都
            // 不做、宿主却回「执行成功，未返回结果」——创建期就拒掉，免得建出一个"每次调用都回绿"
            // 的工具（判据与 agent 侧 EMPTY_CODE 同一个：门返回的 noExecutableStatement）。
            if (_gate.noExecutableStatement === true) {
                return _fail('EMPTY_CODE', 'extendScript 没有可执行语句（空块、空循环，或只含注释/分号）：'
                    + '这样的工具执行时什么都不做却会回「执行成功」。请补上实际要执行的语句（需给全局 result 赋值）。');
            }
            return null;
        }

        async function _llmReview(name, description, extendScript, deps, isExtCall) {
            // 外接通道跳过面板 LLM 强制审查（理由见 createAETool 头部注释）。
            // 仍然**不跳过**确定性层：调用方在此之前已跑 _regexPreCheck + _gatePreCheck（AST 门）。
            if (isExtCall) {
                console.warn('[ae-tool-creator] 外接通道：跳过面板 LLM 强制审查（AST 门 + 正则预检仍生效）');
                return { ok: true, warnings: [] };
            }
            var llmReviewFn = typeof deps.reviewAeTool === 'function'
                ? deps.reviewAeTool
                : (global.AEEngine && typeof global.AEEngine.reviewAeTool === 'function')
                    ? global.AEEngine.reviewAeTool
                    : null;
            // fail-closed：审查函数未注入时拒绝创建，与 executeExtendScript 审查策略一致
            if (!llmReviewFn) return {
                ok: false,
                error: 'REVIEW_FN_UNAVAILABLE',
                detail: 'LLM 审查函数未注入（reviewAeTool 不可用），已拒绝创建工具以防安全风险。请检查 AEEngine 初始化。'
            };

            var reviewResult;
            try {
                reviewResult = await llmReviewFn({
                    script: extendScript,
                    toolName: name,
                    toolDescription: description
                });
            } catch (reviewErr) {
                return {
                    ok: false,
                    error: 'REVIEW_FAILED',
                    detail: 'LLM 审查请求失败，已拒绝创建工具以防安全风险。错误: '
                        + (reviewErr && reviewErr.message ? reviewErr.message : String(reviewErr))
                };
            }
            if (!reviewResult || reviewResult.valid === false) {
                var reviewErrors = (reviewResult && Array.isArray(reviewResult.errors) ? reviewResult.errors : [])
                    .map(function (e) { return '  - ' + (e.message || e.code || JSON.stringify(e)); });
                return {
                    ok: false,
                    error: 'REVIEW_REJECTED',
                    detail: 'LLM 审查未通过。审查发现的问题：\n'
                        + (reviewErrors.length ? reviewErrors.join('\n') : '  - 未知问题')
                };
            }
            var warnings = [];
            if (reviewResult && Array.isArray(reviewResult.warnings)) {
                reviewResult.warnings.forEach(function (w) {
                    warnings.push('⚠️ ' + (w.message || w.code || '审查警告'));
                });
            }
            return { ok: true, warnings: warnings };
        }

        /**
         * 创建（或覆盖）一个 AE 工具。
         * @param {object} args
         *   name         (string,  必填) 工具名，匹配 ^[a-zA-Z_][a-zA-Z0-9_]*$
         *   description  (string,  必填) LLM 可见的工具描述
         *   extendScript (string,  必填) ExtendScript 代码片段
         *   input_schema (object,  必填) JSON Schema 参数定义
         *   category     (string,  可选) 分类，默认 custom
         *   readOnly     (boolean, 可选) 只读标记，默认 false
         *   overwrite    (boolean, 可选) 同名覆盖，默认 false
         *   enabled      (boolean, 可选) 是否启用，默认 true
         * @returns {Promise<{ok:boolean, error?:string, detail?:string, name?:string, overwritten?:boolean, message?:string}>}
         */
        async function createAETool(args, execCtx) {
            args = args || {};
            // 审查层按**通道**分流：外接（callerId 前缀 `ext:`）跳过面板
            // LLM 强制审查——外接客户端自带模型、面板不必配 LLM，否则外接建工具会被面板配置卡死。
            // 确定性层**不受影响**：`_regexPreCheck` 与 `_gatePreCheck`（AST 门 source='ae-tool'）照跑。
            var _isExtCall = !!(execCtx && typeof execCtx.callerId === 'string'
                && execCtx.callerId.indexOf('ext:') === 0);

            var name = String(args.name === undefined || args.name === null ? '' : args.name).trim();
            var description = String(args.description || '').trim();
            var shortDescription = String(args.shortDescription || '').trim();
            if (shortDescription.length > 30) shortDescription = shortDescription.substring(0, 30);
            var extendScript = String(args.extendScript || '').trim();
            var category = args.category || 'custom';
            var readOnly = args.readOnly === true;
            var scope = args.scope || null;
            var overwrite = args.overwrite === true;
            var enabled = args.enabled !== false;

            // ① 必填校验
            if (!name) return _fail('MISSING_NAME', '工具名称不能为空');
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
                return _fail('INVALID_NAME', '工具名称格式无效：只能包含字母、数字、下划线，以字母或下划线开头');
            }
            // 保留名检查：防止覆盖元工具
            var RESERVED = { createAETool: true, deleteAETool: true, undoLastOperation: true, shader_params: true };
            if (RESERVED[name]) {
                return _fail('RESERVED_NAME', '"' + name + '" 是系统保留名称，不能用作工具名');
            }
            if (!description) return _fail('MISSING_DESCRIPTION', '工具描述不能为空');
            if (!extendScript) return _fail('MISSING_EXTENDSCRIPT', 'ExtendScript 代码不能为空');

            // input_schema 可以是对象或 JSON 字符串
            var input_schema = args.input_schema;
            if (!input_schema) return _fail('MISSING_INPUT_SCHEMA', 'input_schema 不能为空');
            if (typeof input_schema === 'string') {
                try { input_schema = JSON.parse(input_schema); } catch (e) {
                    return _fail('INVALID_INPUT_SCHEMA', 'input_schema JSON 解析失败: ' + e.message);
                }
            }
            if (typeof input_schema !== 'object' || input_schema === null || Array.isArray(input_schema)) {
                return _fail('INVALID_INPUT_SCHEMA', 'input_schema 必须是对象');
            }

            // scope 形状校验：畸形 scope 会被 toolRegistry.parseScope 回退为 global，
            // 使写操作工具在所有模式可见，必须提前拒绝
            if (scope !== null) {
                var scopeValid = false;
                if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
                    if (scope.type === 'global') {
                        scopeValid = true;
                    } else if (scope.type === 'module') {
                        if (Array.isArray(scope.moduleIds) && scope.moduleIds.length > 0) {
                            scopeValid = true;
                            for (var si = 0; si < scope.moduleIds.length; si++) {
                                if (typeof scope.moduleIds[si] !== 'string' || !scope.moduleIds[si]) { scopeValid = false; break; }
                            }
                        } else if (typeof scope.moduleId === 'string' && scope.moduleId) {
                            scopeValid = true;
                        }
                    }
                }
                if (!scopeValid) {
                    return _fail('INVALID_SCOPE', 'scope 格式无效：仅支持 {type:"global"} 或 {type:"module", moduleIds:["agent","script","shader"]}（或 moduleId 单模块形式）');
                }
            }

            // ② 分类校验
            var categories = getCategories();
            if (categories.length > 0) {
                var validCategory = false;
                for (var i = 0; i < categories.length; i++) {
                    if (categories[i] === category) { validCategory = true; break; }
                }
                if (!validCategory) {
                    return _fail('INVALID_CATEGORY', '分类 "' + category + '" 无效，合法值: ' + categories.join(', '));
                }
            }

            // ③ 括号平衡检查（与 view.js 保存校验一致）
            var bracketResult = checkBracketBalance(extendScript);
            if (!bracketResult.ok) {
                var msg = bracketResult.char
                    ? 'ExtendScript 括号不匹配：意外的 "' + bracketResult.char + '"'
                    : 'ExtendScript 括号未配对（差 ' + bracketResult.depth + ' 个开括号）';
                return _fail('BRACKET_MISMATCH', msg);
            }

            // ④ 查重（快速失败：在耗时的 LLM 审查前拦截；最终以审查后的最新数据为准）
            var all = getToolsData().slice();
            var exists = false;
            var existingCreatedBy = null;
            for (var j = 0; j < all.length; j++) {
                if (all[j].name === name) { exists = true; existingCreatedBy = all[j].createdBy || null; break; }
            }
            if (exists && !overwrite) {
                return _fail('DUPLICATE_NAME', '工具 "' + name + '" 已存在。确认覆盖请设 overwrite: true，或换一个 name。');
            }
            if (exists && overwrite && existingCreatedBy !== 'llm') {
                return _fail('PROTECTED_TOOL', '工具 "' + name + '" 由用户手动创建，LLM 无法覆盖。请换一个 name。');
            }
            // ④-b 内建工具名一律拒绝（overwrite 也不例外）：register 按名覆盖，用户工具
            // 会在内建名下注册，外接暴露后外部 Agent 按内建名调用即执行用户代码
            //（外部看不到面板侧的覆盖确认框）。判据与 UI 路径同源（注册表 source 事实）。
            var builtinOwner = _builtinNameOwner(name);
            if (builtinOwner) {
                return _fail('BUILTIN_NAME_TAKEN', '工具名 "' + name + '" 已被内建工具占用'
                    + (builtinOwner.source ? '（来源 ' + builtinOwner.source + '）' : '')
                    + '，不能创建或覆盖同名工具。请换一个 name。');
            }

            // ⑤ 构建 toolDef
            var toolDef = {
                name: name,
                enabled: enabled,
                readOnly: readOnly,
                scope: scope || undefined,
                category: category,
                extendScript: extendScript,
                description: description,
                shortDescription: shortDescription,
                input_schema: input_schema,
                createdBy: 'llm'
            };

            // ⑥ 正则预检 + LLM 强制审查（必须在 hotReload 之前，避免不安全工具被持久化+注册）
            // AE 工具仅允许读取本地文件，禁止写入/删除；禁止弹窗类 API（alert/confirm/prompt/new Window）
            // 若 reviewToolCreation 已预审查通过（_preReviewed 命中），跳过重复审查
            // 用闭包变量传递审查状态，LLM 无法通过 args 注入 _preReviewed 绕过
            var warnings = [];
            // 缓存 key 补 description——审查时看的是 description（提示注入载体），
            // key 不含则可先用无害 description 过审、再换恶意 description 创建，bait-and-switch 绕过审查
            var reviewKey = JSON.stringify([name, description, extendScript]);
            if (!_preReviewed[reviewKey]) {
                var preCheckResult = _regexPreCheck(extendScript);
                if (!preCheckResult.ok) return _fail('UNSAFE_OPERATION', preCheckResult.detail);

                // 创建期门预检（validate-only——_regexPreCheck 后、
                // _llmReview 前；拒即拒建回喂，通过落盘原文不写回 emitted）
                var gateRej = _gatePreCheck(extendScript);
                if (gateRej) return gateRej;

                var llmReviewResult = await _llmReview(name, description, extendScript, deps, _isExtCall);
                if (!llmReviewResult.ok) return _fail(llmReviewResult.error, llmReviewResult.detail);
                if (llmReviewResult.warnings && llmReviewResult.warnings.length > 0) {
                    warnings = llmReviewResult.warnings;
                }
            }

            // ⑦ 串行化写入：重新读取最新工具数据 upsert 后 hotReload（存盘 + 重注册）。
            // 审查是长耗时网络操作，期间 UI（saveTool/deleteTool/toggleToolEnabled）或并发的
            // createAETool/deleteAETool 都可能已修改工具列表，直接写回审查前的快照会回滚这些修改。
            if (!toolRegistry) return _fail('NO_TOOL_REGISTRY', 'toolRegistry 未注入');
            var existsFinal = exists;
            var reloadResult = await _serializedWrite(function () {
                var latest = getToolsData().slice();
                existsFinal = false;
                var createdByNow = null;
                for (var j2 = 0; j2 < latest.length; j2++) {
                    if (latest[j2].name === name) { existsFinal = true; createdByNow = latest[j2].createdBy || null; break; }
                }
                if (existsFinal && !overwrite) {
                    return _fail('DUPLICATE_NAME', '工具 "' + name + '" 已存在（审查期间被创建）。确认覆盖请设 overwrite: true，或换一个 name。');
                }
                if (existsFinal && overwrite && createdByNow !== 'llm') {
                    return _fail('PROTECTED_TOOL', '工具 "' + name + '" 由用户手动创建，LLM 无法覆盖。请换一个 name。');
                }
                // 内建名二次校验（审查是长耗时窗口，其间其它模块可能 bootstrapped 注册了同名工具；
                // 与 ④-b 同判据）
                var builtinNow = _builtinNameOwner(name);
                if (builtinNow) {
                    return _fail('BUILTIN_NAME_TAKEN', '工具名 "' + name + '" 已被内建工具占用'
                        + (builtinNow.source ? '（来源 ' + builtinNow.source + '）' : '')
                        + '，不能创建或覆盖同名工具。请换一个 name。');
                }
                if (existsFinal) {
                    for (var k = 0; k < latest.length; k++) {
                        if (latest[k].name === name) { latest[k] = toolDef; break; }
                    }
                } else {
                    latest.push(toolDef);
                }
                return hotReload(toolRegistry, latest);
            });
            // 仅在关键失败（带 error 字段，如 MISSING_PARAMS）时拒绝；
            // registerToolsFromConfig 的 ok:false 仅表示部分工具注册有误，不影响新工具的创建与持久化
            if (reloadResult && reloadResult.error) {
                // upsert 阶段对最新数据的校验失败，原样透出
                if (reloadResult.error === 'DUPLICATE_NAME' || reloadResult.error === 'PROTECTED_TOOL') {
                    return reloadResult;
                }
                return _fail('HOTRELOAD_FAILED', '热重载失败: ' + reloadResult.error);
            }

            onChanged();

            var message = 'AE 工具 "' + name + '" 已' + (existsFinal ? '覆盖更新' : '创建') + (enabled ? '并注册。' : '（已禁用，未注册）。')
                + (enabled ? '工具将在下一轮对话中对 LLM 可见。' : '启用后将在下一轮对话中对 LLM 可见。')
                + (warnings.length ? '\n' + warnings.join('\n') : '');

            return {
                ok: true,
                name: name,
                overwritten: existsFinal,
                message: message
            };
        }

        // 预审查：在确认弹窗前执行，返回审查结果供 UI 展示
        // 通过后写入 _preReviewed 缓存，createAETool 据此跳过重复审查
        async function reviewToolCreation(args) {
            args = args || {};
            var name = String(args.name || '').trim();
            var description = String(args.description || '').trim();
            var extendScript = String(args.extendScript || '').trim();

            if (!extendScript) return { ok: false, errors: ['ExtendScript 代码为空'] };

            // name 格式校验（与 createAETool 一致，防止含 '|' 等字符的 name 与缓存键产生歧义碰撞）
            if (name && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
                return { ok: false, errors: ['工具名称格式无效：只能包含字母、数字、下划线，以字母或下划线开头'] };
            }

            // 保留名检查（与 createAETool 保持一致，提前拦截避免审查通过后才发现冲突）
            var RESERVED = { createAETool: true, deleteAETool: true, undoLastOperation: true, shader_params: true };
            if (RESERVED[name]) {
                return { ok: false, errors: ['"' + name + '" 是系统保留名称，不能用作工具名'] };
            }

            var preCheckResult = _regexPreCheck(extendScript);
            if (!preCheckResult.ok) {
                return { ok: false, errors: [preCheckResult.detail] };
            }

            // 预审查同款门预检（与 createAETool 同栈——缓存命中时
            // 三层预检（regex/门/LLM 审查）同被跳过，安全性由 reviewKey 绑定同一
            // (name+description+extendScript) 与执行期逐次过门兜底；此处预检目的
            // 仅为让 UI 预审查结果与创建期一致）
            var gateRej = _gatePreCheck(extendScript);
            if (gateRej) {
                return { ok: false, errors: [gateRej.detail] };
            }

            var llmReviewResult = await _llmReview(name, description, extendScript, deps);
            if (!llmReviewResult.ok) {
                return { ok: false, errors: [llmReviewResult.detail] };
            }
            // 审查通过，写入缓存。createAETool 用相同 name+description+extendScript 调用时跳过重复审查
            // key 补 description（与 createAETool 侧 reviewKey 同步，堵 bait-and-switch 绕过审查）
            _preReviewedSet(JSON.stringify([name, description, extendScript]));
            return {
                ok: true,
                warnings: llmReviewResult.warnings || []
            };
        }

        /**
         * 把 createAETool 注册为 LLM 工具。
         * scope 限定 agent 模块：Script 模式的工具过滤器（只放行
         * memory_* / skill / read_image / mcp）会自然排除它。
         * 权限系统通过 FORCE_CONFIRM 确保所有权限档下都需用户确认。
         */
        function registerTool(registry) {
            if (!registry || typeof registry.register !== 'function') return false;
            registry.register({
                name: 'createAETool',
                description: '创建一个新的 AE 工具（After Effects 自动化工具）：生成工具定义并立即注册到工具系统。'
                    + 'name 必须匹配 ^[a-zA-Z_][a-zA-Z0-9_]*$；'
                    + 'description 描述工具用途（LLM 据此决定何时调用）；'
                    + 'extendScript 是 ExtendScript 代码，通过 __args 接收参数、将返回值赋给 result（详见 extendScript 参数描述）；'
                    + 'input_schema 是 JSON Schema 格式的参数定义。'
                    + '同名工具已存在时需 overwrite=true 才会覆盖（仅能覆盖 LLM 创建的工具，用户手动创建的工具无法覆盖）。'
                    + '工具创建后将在下一轮对话中对 LLM 可见。'
                    // 工具沉淀门槛自 Agent 系统提示词归位（经验/策略类归工具描述）
                    + '沉淀门槛：同一操作已执行 ≥2 次，或通用代码 >30 行，才建；一次性任务、项目特定逻辑不建。'
                    + '建前先 tool_search 查看是否已有同类工具，重复不建。'
                    // 安全约束自 Agent overlay 归位（审查行为属工具如何用）
                    + '代码经正则预检 + LLM 审查，规则：BridgeTalk 无能力域开关，任何情况下拦截（跨应用通信）；'
                    + '禁止沙箱内部引用（__aeSGOn/__aeSGDn/__aeSAuth 等）绕过拦截；'
                    + '严重 bug（语法错误/未捕获异常）拒绝创建，轻微问题警告。',
                shortDescription: AEI18n.t('创建新的AE工具'),
                input_schema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: AEI18n.t('工具名称，匹配 ^[a-zA-Z_][a-zA-Z0-9_]*$，如 createTextLayer')
                        },
                        description: {
                            type: 'string',
                            description: AEI18n.t('工具描述，LLM 据此决定何时调用此工具')
                        },
                        shortDescription: {
                            type: 'string',
                            description: AEI18n.t('简短描述（最多30字），stub模式下发给LLM的简短说明。留空则自动截断description。如：获取项目信息')
                        },
                        extendScript: {
                            type: 'string',
                            description: 'ExtendScript 代码，执行约定：'
                                + '①__args 是解析后的 JSON 对象，从中取参数（如 __args.text）；'
                                + '②将返回值赋给 result（如 result = {success: true};）；'
                                + '③ES3 语法：只用 var/function，禁用 let/const/箭头函数/模板字符串；'
                                + '④AE 属性/效果名必须用 matchName（如 "ADBE Opacity" 而非 "Opacity" 或 "不透明度"），不依赖 UI 显示语言；'
                                + '⑤写内联代码操作 AE 对象模型（如 var c = app.project.activeItem; result = {name: c.name};），保持正常换行不要写单行。'
                                + '错误处理：用 return 返回错误信息。'
                        },
                        input_schema: {
                            type: 'object',
                            description: AEI18n.t('JSON Schema 格式的参数定义，含 type/properties/required')
                        },
                        category: {
                            type: 'string',
                            description: AEI18n.t('工具分类，可选值: project, composition, layer, animation, effect, render, utility, custom。默认 custom')
                        },
                        readOnly: {
                            type: 'boolean',
                            description: AEI18n.t('是否为只读工具。true 时执行不包撤销组（适用于查询类工具），且不影响作用域。默认 false')
                        },
                        scope: {
                            type: 'object',
                            description: '工具适用模式（作用域）。两种形式：{type:"global"} 表示所有模式可用；'
                                + '{type:"module", moduleIds:["agent","script","shader"]} 表示仅在列出的模式可用（可多选并集，如 ["agent","script"]）。'
                                + '不传则回退：只读工具全局可用，否则仅 Agent 模式可用。'
                        },
                        overwrite: {
                            type: 'boolean',
                            description: AEI18n.t('同名工具已存在时是否覆盖。默认 false')
                        },
                        enabled: {
                            type: 'boolean',
                            description: AEI18n.t('是否启用。默认 true')
                        }
                    },
                    required: ['name', 'description', 'extendScript', 'input_schema']
                },
                handler: function (args, execCtx) {
                    return createAETool(args, execCtx).then(function (r) {
                        if (!r.ok) {
                            return {
                                success: false, isError: true,
                                content: [{ type: 'text', text: r.error + (r.detail ? ' - ' + r.detail : '') }]
                            };
                        }
                        return {
                            success: true, isError: false,
                            content: [{ type: 'text', text: r.message }]
                        };
                    });
                },
                // createAETool 对外接开放（原 scope 仅 agent
                // ⇒ extTools.scopeAllowsExternal 以 TOOL_SCOPE_EXCLUDES_EXTERNAL 拒）。
                // 它同时落进外接的 ae_meta 组（extPolicy）并**必须过确认**（面板侧本就是
                // FORCE_CONFIRM、每次必确认；外接确认表同口径）。deleteAETool **不放开**（不可逆）。
                scope: { type: 'module', moduleIds: ['agent', 'external-mcp'] },
                stub: true,
                // readOnly 显式布尔（团队模式）。createAETool 是**写**工具
                //（落盘 + 注册新工具，并可能覆盖同名 LLM 工具），显式重操作名单亦含它。
                // 注意：被创建的工具自身的 readOnly 走 toolDef.readOnly（见下方 toolDef 构建处），
                // 经 hotReload → registerToolsFromConfig 注册，不受本处取值影响。
                readOnly: false,
                source: 'ae-tools',
                category: 'utility'
            });
            return true;
        }

        /**
         * 删除一个 LLM 创建的 AE 工具。
         * 只允许删除 createdBy === 'llm' 的工具，保护系统工具和用户手动创建的工具。
         * @param {object} args
         *   name (string, 必填) 工具名
         * @returns {Promise<{ok:boolean, error?:string, detail?:string, name?:string, message?:string}>}
         */
        async function deleteAETool(args) {
            args = args || {};

            var name = String(args.name === undefined || args.name === null ? '' : args.name).trim();

            if (!name) return _fail('MISSING_NAME', '工具名称不能为空');

            // 查找工具
            var all = getToolsData().slice();
            var target = null;
            for (var i = 0; i < all.length; i++) {
                if (all[i].name === name) { target = all[i]; break; }
            }

            if (!target) {
                return _fail('NOT_FOUND', '工具 "' + name + '" 不存在');
            }

            // 只允许删除 LLM 创建的工具
            if (target.createdBy !== 'llm') {
                return _fail('PROTECTED_TOOL', '工具 "' + name + '" 不是 LLM 创建的，无法删除。只能删除 AI 来源的工具。');
            }

            // 串行化写入：重读最新数据后删除 + hotReload，避免与并发写（UI 保存/其他工具创建删除）互相覆盖
            var reloadResult = await _serializedWrite(function () {
                var latest = getToolsData().slice();
                var idx = -1;
                for (var d = 0; d < latest.length; d++) {
                    if (latest[d].name === name) { idx = d; break; }
                }
                if (idx < 0) {
                    // 等待期间已被并发删除，视为成功（幂等）
                    return { ok: true, alreadyDeleted: true };
                }
                if (latest[idx].createdBy !== 'llm') {
                    // 等待期间同名的 LLM 工具被替换为用户工具，不得删除
                    return _fail('PROTECTED_TOOL', '工具 "' + name + '" 已被替换为用户手动创建的工具，无法删除。');
                }
                latest.splice(idx, 1);
                return hotReload(toolRegistry, latest);
            });
            if (reloadResult && reloadResult.error) {
                // 删除阶段对最新数据的校验失败，原样透出
                if (reloadResult.error === 'PROTECTED_TOOL') {
                    return reloadResult;
                }
                return _fail('HOTRELOAD_FAILED', '删除后热重载失败: ' + reloadResult.error);
            }

            onChanged();

            return {
                ok: true,
                name: name,
                message: 'AE 工具 "' + name + '" 已删除。'
            };
        }

        /**
         * 把 deleteAETool 注册为 LLM 工具（Agent 模块专属）。
         * 只能删除 LLM 创建的工具（createdBy === 'llm'）。
         * 通过 FORCE_CONFIRM 确保所有权限档下都需用户确认。
         */
        function registerDeleteTool(registry) {
            if (!registry || typeof registry.register !== 'function') return false;
            registry.register({
                name: 'deleteAETool',
                description: AEI18n.t('删除一个 LLM 创建的 AE 工具。只能删除来源为 AI 的工具，无法删除系统工具或用户手动创建的工具。'),
                shortDescription: AEI18n.t('删除LLM创建的AE工具'),
                input_schema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: AEI18n.t('要删除的工具名称')
                        }
                    },
                    required: ['name']
                },
                handler: function (args) {
                    return deleteAETool(args).then(function (r) {
                        if (!r.ok) {
                            return {
                                success: false, isError: true,
                                content: [{ type: 'text', text: r.error + (r.detail ? ' - ' + r.detail : '') }]
                            };
                        }
                        return {
                            success: true, isError: false,
                            content: [{ type: 'text', text: r.message }]
                        };
                    });
                },
                scope: { type: 'module', moduleId: 'agent' },
                stub: true,
                // readOnly 显式布尔（团队模式）。deleteAETool 是**删除**工具
                //（不可逆），显式重操作名单含它；导演 lane 的元数据判据必须能识别。
                readOnly: false,
                source: 'ae-tools',
                category: 'utility'
            });
            return true;
        }

        return {
            createAETool: createAETool,
            reviewToolCreation: reviewToolCreation,
            deleteAETool: deleteAETool,
            registerTool: registerTool,
            registerDeleteTool: registerDeleteTool,
            checkBracketBalance: checkBracketBalance
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createAEToolCreator = createAEToolCreator;
    global.AE_LLM.scanAeFunctions = scanAeFunctions;

})(window);
