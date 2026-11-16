// 平台侧文件工具（通过 bridge/AEFS 实施，供 LLM 调用）。
// 这些工具从 main.js 抽取而来，保持注册时序：由 main.js 在 initAETools 之后调用
// initPlatformFileTools，以覆盖同名 ExtendScript 工具。
//
//   readFile / read_image / read_video — 从 main.js 原样搬移（只读）
//   writeFile — 新增（Agent / Script / Shader 三档可用，支持局部改写，走 AEFS.writeFile 安全链）
//
// 新增工具时请保持同步：
//   1. 此处 toolRegistry.register(...)
//   2. client/shared/toolRegistry.js 的 CORE_TOOL_NAMES（如需始终完整注入）
//   3. client/modules/agent/engine/permissions.js 的 FORCE_CONFIRM / READ_ONLY（如需确认/只读策略）
(function (global) {
    "use strict";

    // 单次写入 content 的大小上限（6MB）。整文件写入与局部改写共用。
    // 旧值 50MB 只是**字符数**广告，从未对齐真实通道——writeFileLlm 走
    // POST /fs/write-llm，body 是 JSON.stringify({path, content}) 的 UTF-8 字节，被
    // bridge-server 的 readBody（MAX_READBODY_SIZE = 40MB）限流；JSON 转义 + UTF-8 的
    // 最坏膨胀是 6 字节/UTF-16 码元（控制字符/lone surrogate → \uXXXX，CJK → 3 字节），
    // 故 50MB 内容里 >40MB 的 ASCII、>约 13MB 的 CJK、>约 6.7MB 的转义密集内容都会在
    // 通道被 400（bodyLimit）拒——工具说能写、实际写不进，回执还露 body_too_large token。
    // 取 40MiB / 6 ≈ 6.67MB 向下折算为 6MiB，给 JSON envelope 留 ~4MiB 余量：**任何**
    // 内容在广告上限内都保证能过通道（不再出现"广告 50MB、通道 40MB"的不一致）。
    // 更大的文本请分次写入或走局部改写（offset/length）。
    var WRITEFILE_MAX_CONTENT_LEN = 6 * 1024 * 1024;

    // 相对路径 → 绝对路径：**非绝对**时拼接当前数据目录
    // 绝对形态有三种：盘符（`C:\`）、UNC（`\\server\share`）、
    // 正斜杠 UNC（`//server/share`）。只认盘符时 UNC/`\\?\` 被当「相对路径」改写：
    //   `\\NAS\share\docs\a.txt` → `<dataDir>\NAS\share\docs\a.txt`（前导 `\\` 被 replace 吃掉）
    // 后果：readFile 对**存在**的文件回「文件不存在…」；writeFile 走 /fs/write-llm（会 mkdir
    // recursive）在数据目录里造出一棵假树并回 `{status:success, filePath:改写后路径}` —— **写到了
    // 别处还说成功**。触发环境无需特殊设置：素材放网络共享、或域环境 %APPDATA% 重定向（数据根
    // 本身就是 UNC，模型从回执里学到的绝对路径就是 UNC，回头再传回工具必命中）。
    // 口径与同仓 `dataDir.js` 的 `_isAbsFsPath` 对齐（盘符 **或** `\\` **或** `//`）。
    // `\\?\` 前缀**原样透传**：AEFS/桥对扩展前缀 fail-closed 拒绝，比悄悄改写安全。
    function _isAbsFsPath(p) {
        return /^[a-zA-Z]:[\\/]/.test(p) || p.indexOf('\\\\') === 0 || p.indexOf('//') === 0;
    }
    function _resolveAbsolute(filePath) {
        if (!_isAbsFsPath(filePath)) {
            var dir = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                ? global.AEShared.getDataDir().dir : '';
            if (dir) filePath = dir.replace(/\\+$/, '') + '\\' + filePath.replace(/^[\\/]+/, '');
        }
        return filePath;
    }

    function _ok(text) {
        return { success: true, content: [{ type: 'text', text: text }] };
    }
    function _err(text) {
        return { success: false, isError: true, content: [{ type: 'text', text: text }] };
    }

    // ====== readFile（从 main.js 抽取） ======

    function _readFileLooksBinary(text) {
        var len = text.length;
        if (len === 0) return false;
        var scanLen = Math.min(len, 8192);
        var nulCount = 0, replCount = 0;
        for (var bi = 0; bi < scanLen; bi++) {
            var bc = text.charCodeAt(bi);
            if (bc === 0) nulCount++;
            else if (bc === 0xFFFD) replCount++;
        }
        if (nulCount > 0) return true;
        if (replCount > 0 && (replCount / scanLen) > 0.10) return true;
        return false;
    }

    var READFILE_SEARCH_MAX_HITS = 20;
    var READFILE_SEARCH_CTX = 120;
    // 正则搜索墙钟预算：与桥侧同口径（见 bridge-server 的
    // PAGE_SEARCH_BUDGET_MS）。面板侧尤其要紧——工具超时是 Promise.race，**救不了同步卡死的
    // 主线程**；100ms 对正常搜索绰绰有余（单文件正文上限 6MB，普通词扫描 ~1ms/百KB 量级）。
    var READFILE_SEARCH_BUDGET_MS = 100;
    // 灾难性回溯的**入口识别**：
    // 我第一版只在「逐次匹配之间」查钟（`(guard & 255) === 0 && Date.now() > deadline`），
    // 实测**无效**：灾难性回溯全部发生在**单次 `re.exec()` 内部**，循环体根本没有机会执行
    //（`/^(a+)+$/` 对 "a"*26+"b" 仍然 2830ms 卡住、标志位未置位）。
    // 真正的可行修法是**在编译前识别危险形状**：形如 `(单原子+)+` / `(单原子*)*` 的嵌套量词
    //（`(a+)+`、`(a*)*`、`([a-z]+)+`）是 ReDoS 的经典族，正常搜索几乎不会写出这种形式。
    // 只匹配「组内是**单个原子**（字面量/转义/字符类）+ 量词」再叠量词，避免误伤
    // `(\d+\.)+\d+` 这类常见的、通常安全的写法。
    function _looksCatastrophicRegex(src) {
        var s = String(src || '');
        // ① 字符类**先整体折叠**成单个原子 x：类内的字面串（`[(a+)+]`）不再被误判成嵌套量词
        //   （该类假阳性已实证）；`([a-z]+)+` 这类仍按「单原子」处理。
        s = s.replace(/\[(?:\\.|[^\]\\])*\]/g, 'x');
        // ② 转义序列换成**互不相同**的单字符占位：`\d` 与 `\s` 不能折成同一个原子，否则
        //   `(?:\d+|\s)+` 会被「分支互为前缀」误判（不同字符集的分支实际不回溯）。
        var _pool = 'yzqwertyuiopasdfghjkl', _pi = 0;
        s = s.replace(/\\./g, function () { return _pool.charAt(_pi++ % _pool.length); });
        var ATOM = '(?:[a-zA-Z0-9._]|x)';
        var QUANT = '(?:[+*]|\\{\\d+,\\d*\\})';
        // 家族一：单原子 + 量词，外面再叠量词 —— (a+)+ / (a*)* / ([a-z]+)+
        if (new RegExp('\\(' + ATOM + QUANT + '\\)\\s*' + QUANT).test(s)) return true;
        // 家族二：`(?:…)` / 多余括号包裹的同款 —— (?:a+)+ / ((a+))+
        //（原判据只认家族一，这三种实测全过闸、Node 侧 n=30 约 7.2s）
        if (new RegExp('\\(' + '\\?:' + ATOM + QUANT + '\\)\\s*' + QUANT).test(s)) return true;
        if (new RegExp('\\(\\(' + ATOM + QUANT + '\\)\\)\\s*' + QUANT).test(s)) return true;
        // 家族三：分支**互为前缀或相等**（比较前先去掉分支尾部量词）+ 整组叠量词 ——
        //   (a|aa)+ / (a|a?)+ / (ab|abc)+ 。判据用「同一原子集」比较，故 `(a|b)+`、`(ab|cd)+`、
        //   `(?:\d+|\s)+`（不同原子集）不命中——这类常见安全写法不能误伤。
        //（(a|aa)+$ / (a|a?)+$ 实测 Node n=30 分别 ~7.2s / 42.8s）
        var _BR = '(?:[a-zA-Z0-9._x](?:(?:[+*?])|\\{\\d+,\\d*\\})?)+';
        var altRe = new RegExp('\\(\\??:?(' + _BR + '(?:\\|' + _BR + ')+' + ')\\)\\s*' + QUANT, 'g'), am;
        while ((am = altRe.exec(s)) !== null) {
            var brs = am[1].split('|');
            for (var bi = 0; bi < brs.length; bi++) {
                brs[bi] = brs[bi].replace(/(?:[+*]|\{\d+,\d*\})$/, '');
            }
            for (var bi2 = 0; bi2 < brs.length; bi2++) {
                for (var bj = 0; bj < brs.length; bj++) {
                    if (bi2 === bj) continue;
                    if (brs[bi2] === brs[bj]) return true;                    // (a|a?)+
                    if (brs[bj].length > brs[bi2].length
                        && brs[bj].indexOf(brs[bi2]) === 0) return true;      // (a|aa)+
                }
            }
        }
        return false;
    }
    // 单个命中片段的上限：片段本应 ≈ 匹配长度 + 2×CTX，但正则命中本身
    // 可以很长（如 /[\s\S]+/ 把整篇当一个命中 → 单条 4 万字符，一页必超自守预算）。截断片段而不是
    // 丢弃命中：丢弃会让 hits=0 且 nextSearchOffset 原地打转（模型重复同一请求）。
    var READFILE_SEARCH_SNIPPET_MAX = 320;
    // 自守预算：工具结果进管线的是 **JSON 序列化后**的文本，而转义会放大体积——
    // 引号/反斜杠/换行各转义成 2 字符、控制字符 \uXXXX 是 6 字符（实测：20000 字符的满页在
    // 转义密集文件里到 40085 字符）。超过工具结果兜底上限（toolExecutionPipeline 的 32K）就会
    // 被管线再截一次：页中段丢失 + 结果被切成非法 JSON（offset/size 等结构化字段全没）。
    // 故这里按**序列化后的长度**再自守一道（24K，给兜底留 8K 余量）；超了就缩短实际返回的
    // 内容并重述截断提示（next offset 按实际返回长度算），模型据此续读。
    var READFILE_PAYLOAD_BUDGET = 24 * 1024;

    // 命中片段：±CTX 字符，再按 SNIPPET_MAX 收顶（正则命中本身很长时片段会跟着长）
    function _clipSnippet(s) {
        return s.length > READFILE_SEARCH_SNIPPET_MAX
            ? (s.slice(0, READFILE_SEARCH_SNIPPET_MAX) + '…')
            : s;
    }

    function _searchFileText(text, keyword, skipHits) {
        var hits = [];
        var total = 0;
        // 显式正则：/pattern/flags（如 /粒子\d+/i、/SaveAs/i）
        var explicit = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(keyword);
        if (explicit) {
            var inner = explicit[1];
            var flags = explicit[2];
            if (flags.indexOf('g') === -1) flags += 'g';   // 保证 exec 循环能前进
            // 危险形状先拒（见 _looksCatastrophicRegex 的注释：逐次查钟拦不住单次 exec 内的回溯）
            if (_looksCatastrophicRegex(inner)) {
                return { hits: hits, total: 0, catastrophic: true };
            }
            var re;
            try { re = new RegExp(inner, flags); }
            catch (e) { return { hits: hits, total: 0, invalid: true }; }
            var guard = 0;
            var _reSlow = false;
            var _reDeadline = Date.now() + READFILE_SEARCH_BUDGET_MS;
            var m;
            while ((m = re.exec(text)) !== null) {
                // 零宽命中需手动前进，否则死循环
                if (typeof m[0] === 'string' && m[0].length === 0) re.lastIndex++;
                if (total >= skipHits && hits.length < READFILE_SEARCH_MAX_HITS) {
                    var s1 = Math.max(0, m.index - READFILE_SEARCH_CTX);
                    var e1 = Math.min(text.length, m.index + (m[0] ? m[0].length : 0) + READFILE_SEARCH_CTX);
                    hits.push({ offset: m.index, snippet: _clipSnippet(text.substring(s1, e1)) });
                }
                total++;
                if (++guard > 200000) break;   // 防海量匹配（如空匹配数万条）拖死
                // 时间预算闸：正则由 LLM 提供，灾难性回溯会把
                // **面板主线程**独占（桥侧同款已加；面板侧工具超时是 Promise.race，救不了同步卡死）。
                // 超时即中止并如实回「正则过慢」，不静默少给也不把面板拖死。
                if ((guard & 255) === 0 && Date.now() > _reDeadline) { _reSlow = true; break; }
            }
            return { hits: hits, total: total, slowRegex: _reSlow };
        }
        // 普通字符串：大小写不敏感（旧 indexOf 区分大小写）。
        // 预 lower 一份，用统一的低case文本 indexOf + 原文本取片段。
        var lowerText = text.toLowerCase();
        var lowerKw = keyword.toLowerCase();
        var idx = lowerText.indexOf(lowerKw);
        // 防洪量匹配闸：**字符串分支同样有闸**，
        // 而上面的正则分支有同款 200k。独立复核（真工具 handler、60MB 文本搜 `e`）：
        // 字符串分支 **989ms / total=7,864,320**（枚举全部命中、无任何标注）
        // vs 正则 `/e/g` 同文本 **18ms / total=200,001**（封顶）——**55×** 不对称。
        // 命中数触闸时如实把 total 降级为下界（`totalIsLowerBound`），不再谎报精确值。
        var _strGuard = 0;
        var _strCapped = false;
        while (idx !== -1) {
            if (total >= skipHits && hits.length < READFILE_SEARCH_MAX_HITS) {
                var s2 = Math.max(0, idx - READFILE_SEARCH_CTX);
                var e2 = Math.min(text.length, idx + Math.max(1, keyword.length) + READFILE_SEARCH_CTX);
                hits.push({ offset: idx, snippet: _clipSnippet(text.substring(s2, e2)) });
            }
            total++;
            if (++_strGuard > 200000) { _strCapped = true; break; }
            idx = lowerText.indexOf(lowerKw, idx + Math.max(1, lowerKw.length));
        }
        return { hits: hits, total: total, totalIsLowerBound: _strCapped };
    }

    // readFile 工具级超时：Bridge 层是同步 XHR（无法设 timeout），若 bridge 对某文档卡住
    //（如超大文本全量解析很慢 / unpdf 异常），工具会一直挂起直到模型侧超时。
    // 故此处用 Promise.race 做保守超时兜底，到点给 LLM 明确反馈而非无限等待。
    var READFILE_TIMEOUT_MS = 30 * 1000;
    var _READFILE_TIMEOUT_SENTINEL = { _readTimeout: true };

    // CEP 扩展目录去向提示：读文件失败且路径落在 CEP 扩展目录下时
    // 给一次「数据目录 ≠ 安装目录」说明——真机曾用 %APPDATA% 猜安装目录连续失败多次。
    // 只对 CEP 扩展目录生效，普通业务路径不追加（避免噪声）。
    function _cepDirHint(p) {
        var norm = String(p || '').replace(/\\/g, '/').toLowerCase();
        if (norm.indexOf('/adobe/cep/extensions/as_extp') < 0) return '';
        return '\n提示：%APPDATA%\\Adobe\\CEP\\extensions\\AS_ExtP 是数据目录（memories/skills/effects 等数据）；'
            + '扩展代码在安装目录（Program Files 公共 CEP extensions 下，只读），不在数据目录内。';
    }

    function _readFileTool(filePath, maxChars, offset, search, searchOffset) {
        if (!global.AEFS || typeof global.AEFS.readFile !== 'function') {
            return Promise.resolve(_err(JSON.stringify({ status: 'error', message: 'AEFS 不可用，无法读取文件' })));
        }
        // 真分页：**非搜索**且能走三态接口时，直接向桥
        // 要「本页」（桥侧**解码后按码元**切片，字节/码元不混用），不再整文件读 + substring 再丢弃——
        // 整读 + 整份过桥的实测代价：60MB 文件每翻一页 142ms、RSS **+162.8MB**，且首页与中间页同量级。
        // 回退安全：AEFS 无 `readFileResult`（旧版/测试桩）时**自动走原路径**，行为与非范围读取一致。
        var _useRange = !search && typeof global.AEFS.readFileResult === 'function';
        var _readPromise = _useRange
            ? global.AEFS.readFileResult(filePath, { charOffset: Number(offset) || 0, charCount: maxChars })
            : global.AEFS.readFile(filePath);
        return Promise.race([
            _readPromise,
            new Promise(function (resolve) { setTimeout(function () { resolve(_READFILE_TIMEOUT_SENTINEL); }, READFILE_TIMEOUT_MS); })
        ]).then(function (text) {
            if (text === _READFILE_TIMEOUT_SENTINEL) {
                return _err(JSON.stringify({ status: 'error', message: '文件读取超时（超过 ' + (READFILE_TIMEOUT_MS / 1000) + ' 秒），可能文件过大或解析卡住：' + filePath + '。可改用 offset/search 分页读取，或换更小的文件' }));
            }
            // 范围读的成功路径：`data` 是本页（按码元切），`totalChars` 是**全文**长度。
            // 用 `_pageBase` 记住本页在全文中的起始位置，供 offset/size/续读提示使用；
            // 非范围路径 `_pageBase = 0`，下面各式与整文读取**逐字等价**。
            var _pageBase = 0;
            var _rangeTotal = null;
            // 保留三态 Result 的 code——若在此把 Result 折叠成
            // data 后丢弃 code，失败分支只能靠 lastError 猜，NOT_FOUND 与通道故障/解析失败
            // 于是混成一句「文件不存在、无法读取或解析失败」。code 用于下面精确分因。
            //
            // 取数层级：
            // AEFS 的 Result 是**嵌套**形状 `{ ok:false, error:{ code, message, channel } }`
            //（aefs.js:74 三态约定与 `_resultErr` aefs.js:95-104；本文件 :737 与其它消费方
            // sessionStore.js:235 / dataDir.js:787 / main.js:1266 都读 `r.error.code`）。
            // 只读**顶层** `text.code` 时恒为 null ⇒ NOT_FOUND / CHANNEL_FAILURE / REJECTED
            // 三个分支与 `_cepDirHint` 全部不可达，真机回执仍是旧的「文件不存在、无法读取或
            // 解析失败」。真机实取：`AEFS.readFileResult('E:\\...\\no-such.txt')` 返回
            // `{"ok":false,"error":{"code":"NOT_FOUND","message":"readFile cep.fs 文件不存在: ...","channel":"cepfs"}}`。
            // 兼容旧桩/降级实现的**扁平**形状 `{ ok:false, code, error:'...' }`：先取嵌套，
            // 嵌套缺失再取顶层。
            var _rangeCode = null, _rangeErr = '';
            if (_useRange) {
                if (!text || text.ok !== true) {
                    var _rangeErrObj = (text && text.error && typeof text.error === 'object') ? text.error : null;
                    _rangeCode = _rangeErrObj && _rangeErrObj.code
                        ? String(_rangeErrObj.code)
                        : ((text && text.code) ? String(text.code) : null);
                    // 原因只取字符串分量：嵌套形状取 `error.message`；`error` 是字符串（扁平旧桩）
                    // 直接用；再回落顶层 `message`。对象不能交给 String()，否则得到 `[object Object]`。
                    var _rangeErrText = _rangeErrObj
                        ? ((_rangeErrObj.message == null) ? '' : String(_rangeErrObj.message))
                        : ((text && typeof text.error === 'string') ? String(text.error) : '');
                    if (!_rangeErrText && text && text.message) _rangeErrText = String(text.message);
                    _rangeErr = _rangeErrText;
                    text = null;
                }
                else {
                    // `_pageBase` 只在**返回的确实是一页**时才能采用：
                    // 范围请求发出去了，不代表回来的就是范围结果。整文返回的成功态有两条路：
                    //   ① 二进制文档走 `Bridge.parseDoc`（aefs.js:1371-1384，忽略 opts、无 range 元数据）；
                    //   ② Bridge 不可用/返回 null 时走 cep.fs/fetch 回退（aefs.js:1407/1410）。
                    // 只判「AEFS 有 readFileResult 函数」就无条件 `_pageBase = 请求 offset` 时，上面两条
                    // 路径会「返回文档开头却自称请求偏移」（offset=10/20 都回同一段开头）⇒ 分页原地打转，
                    // 截断提示还指向同一个 next offset。判据用桥侧回传的显式标记 `range`（见 aefs.js:1398-1404）。
                    if (text.range === true) {
                        // 基准优先用**桥已夹取**的 charOffset（越界请求时请求值 ≠ 实际起点，
                        // 回执再报请求值会让模型据此续读时重复越界）。
                        _pageBase = (typeof text.charOffset === 'number' && isFinite(text.charOffset))
                            ? text.charOffset : (Number(offset) || 0);
                        if (typeof text.totalChars === 'number' && isFinite(text.totalChars)) {
                            _rangeTotal = text.totalChars;
                        }
                    }
                    text = text.data;
                }
            }
            if (text === null || typeof text !== 'string') {
                // 二进制文档（docx/xlsx/pdf 等）解析失败时，把 Bridge 侧具体原因透传给 LLM
                //（如 PDF 加密/结构损坏/解析库异常），否则只报笼统"解析失败"无从定位。
                var _docExt = /\.(docx|doc|xlsx|xls|xlsm|pdf)$/i.test(filePath);
                var _docErr = _docExt
                    ? ((global.AEFS && typeof global.AEFS.getLastDocumentParseError === 'function')
                        ? global.AEFS.getLastDocumentParseError() : '')
                    : '';
                // 路径被数据层拒绝时把**原因**透给模型：
                // 一律回「文件不存在…」时，用户名含撇号的域账户路径（域环境常见）或
                // `100%完成.txt` 这类**合法**路径是被 `aefs._checkPath` 拒的，模型会据此认定
                // 「文件不存在」并让用户去确认一个其实存在（只是不可读）的文件。
                //
                // **必须绑定到本次路径**：
                // `aefs.lastError()` 是**模块级单槽**，而普通「文件不存在」路径**不写**它
                // （桥对不存在返回 500 非 4xx → cep.fs 回退失败也不写）⇒ 上一次调用的拒绝原因
                // 会一直存活、被当成本次失败原因报出去——**路径与原因双错**（实测：先读含 `.` 段的
                // 路径、再读一个真不存在的文件，回执变成「路径含 . 或 .. 段: <上一个路径>」）。
                // 判据：拒绝文本须提到**本次目标路径**（反斜杠/大小写归一后比较），
                // 与同仓 `comfyui/controller.js`、`assets/*/…View.js` 的既有惯例一致。
                var _normP = function (s) { return String(s).replace(/\\/g, '/').toLowerCase(); };
                var _pathErr = (!_docErr && global.AEFS && typeof global.AEFS.lastError === 'function')
                    ? String(global.AEFS.lastError() || '') : '';
                if (_pathErr && _normP(_pathErr).indexOf(_normP(filePath)) < 0) _pathErr = '';   // 陈旧槽：不认
                var _msg = _docErr
                    ? ('文档解析失败（' + _docErr + '）: ' + filePath)
                    : (_pathErr && _pathErr.indexOf('路径被数据层拒绝') === 0
                        ? (_pathErr + '（该路径存在也可能被拒；请改用允许的路径形态）')
                        : (_rangeCode === 'REJECTED'
                            ? ('路径被数据层拒绝: ' + filePath + (_rangeErr ? '（' + _rangeErr + '）' : '') + '（该路径存在也可能被拒；请改用允许的路径形态）')
                            : (_rangeCode === 'NOT_FOUND'
                                ? ('文件不存在: ' + filePath + _cepDirHint(filePath))
                                : (_rangeCode === 'CHANNEL_FAILURE'
                                    ? ('读取失败（通道故障：Bridge 与 cep.fs 均不可用，非文件不存在）: ' + filePath
                                        + (_rangeErr ? ' — ' + _rangeErr : ''))
                                    : ('文件不存在、无法读取或解析失败（二进制文档需 Bridge 支持）: ' + filePath)))));
                return _err(JSON.stringify({ status: 'error', message: _msg }));
            }
            if (_readFileLooksBinary(text)) {
                return _err(JSON.stringify({ status: 'error', message: '该文件为二进制/不支持读取的格式，无法作为文本读取（避免乱码）：' + filePath }));
            }
            // `fullLen` 必须是**全文**长度：范围读时 text 只是本页（`text.length` 会是页长，
            // 用它算 keep 会把第二页算成 0 长度而返回空——独立复核当场抓到）。
            var fullLen = _rangeTotal !== null ? _rangeTotal : text.length;
            if (search) {
                var so = Number(searchOffset) || 0;
                if (so < 0) so = 0;
                var res = _searchFileText(text, search, so);
                if (res.invalid) {
                    return _err(JSON.stringify({ status: 'error', message: '正则表达式无效: ' + search + '。可用普通关键词（大小写不敏感），或以 /pattern/ 形式如 /粒子\\d+/i' }));
                }
                // 危险形状（嵌套单原子量词）：入口即拒，别让面板主线程被灾难性回溯拖死
                if (res.catastrophic) {
                    return _err(JSON.stringify({
                        status: 'error',
                        message: '该正则含嵌套量词（形如 (a+)+ / (a*)*），可能触发灾难性回溯并卡死面板，已拒绝执行。'
                            + '请改写为等价但不嵌套的形式（例如用 (a+) 一次量词、或改用普通关键词搜索）：' + search
                    }));
                }
                // 命中片段长度有界（±READFILE_SEARCH_CTX 字符），只有"正则命中本身很长"（如
                // /[\s\S]+/）时一页才会超自守预算 → 从尾部按比例丢命中，并如实改 hits 与
                // 补 truncated/nextSearchOffset（模型据此续读；不静默少给）。
                var buildSearchPayload = function (arr, truncated) {
                    var o = { status: 'success', filePath: filePath, search: search, searchOffset: so, hits: arr.length, total: res.total, matches: arr };
                    // 命中数触防洪闸时 total 只是**下界**：
                    // 如实标注，别让模型把它当成精确总数（它据此判断"还有多少页"会系统性偏小）。
                    if (res.totalIsLowerBound) { o.totalIsLowerBound = true; o.totalNote = '命中数超过 200000 的枚举上限，total 为下界'; }
                    // 正则过慢被预算闸中止（B-3）：如实告知，别让模型以为「就这么多命中」
                    if (res.slowRegex) { o.slowRegex = true; o.totalIsLowerBound = true; o.note = '正则过慢已中止扫描（超过 ' + READFILE_SEARCH_BUDGET_MS + 'ms），total 为下界；请改用更具体的词/更简单的正则'; }
                    if (truncated) { o.truncated = true; o.nextSearchOffset = so + arr.length; }
                    return JSON.stringify(o);
                };
                var keptHits = res.hits;
                var searchPayload = buildSearchPayload(keptHits, false);
                for (var sp = 0; sp < 4 && searchPayload.length > READFILE_PAYLOAD_BUDGET && keptHits.length > 0; sp++) {
                    var excess = searchPayload.length - READFILE_PAYLOAD_BUDGET;
                    var drop = Math.max(1, Math.ceil(keptHits.length * excess / searchPayload.length));
                    keptHits = keptHits.slice(0, Math.max(0, keptHits.length - drop));
                    searchPayload = buildSearchPayload(keptHits, keptHits.length < res.hits.length);
                }
                return _ok(searchPayload);
            }
            var off = Number(offset) || 0;
            if (off < 0) off = 0;
            // 范围读时 `text` **只是本页**（从全文 `_pageBase` 处开始），故页内偏移用 0、
            // 对外报的偏移与续读位置都加回 `_pageBase`（非范围路径 _pageBase=0 ⇒ 逐字等价）。
            if (_pageBase > 0) off = 0;
            var keep = Math.min(maxChars, Math.max(0, fullLen - _pageBase - off));
            var payload = null;
            // 自守预算见 READFILE_PAYLOAD_BUDGET：每轮按观察到的膨胀比缩短（转义比 ≥ 1，故每
            // 砍掉 1 个原字符至少少 1 个结果字符，几轮内收敛）
            for (var pass = 0; pass < 4; pass++) {
                var result = text.substring(off, off + keep);
                var _absOff = _pageBase + off;
                // `atEof`：本页已到全文末尾（含越界读：offset ≥ 全文长度时结果为空但不再是
                // 「请求值 vs 实际起点」不一致的沉默状态）。
                var _atEof = (_absOff + keep) >= fullLen;
                if (!_atEof) result += '\n... (truncated, total ' + fullLen + ' chars, next offset ' + (_absOff + keep) + ')';
                payload = JSON.stringify({
                    status: 'success', filePath: filePath, offset: _absOff,
                    content: result, size: fullLen, atEof: _atEof
                });
                if (payload.length <= READFILE_PAYLOAD_BUDGET || keep === 0) break;
                keep = Math.max(0, keep - (payload.length - READFILE_PAYLOAD_BUDGET));
            }
            return _ok(payload);
        }).catch(function () {
            return _err(JSON.stringify({ status: 'error', message: '文件不存在或无法读取: ' + filePath }));
        });
    }

    // ====== writeFile（新增，Agent / Script / Shader 三档） ======
    // 走 LLM 专用写通道 AEFS.writeFileLlm → /fs/write-llm：可写任意非系统绝对路径
    //（如工程/导出目录的 .srt），每次调用由面板侧强制用户确认授权。

    // 保护文件名黑名单：门增补表与危险脚本记忆的存储文件只允许经管理面/提议确认
    // 流程写入。writeFile 走 Bridge /fs/write-llm，不经 AE 侧路径黑名单，故在本入口
    // 按 basename 拒绝。匹配形态：精确名、8.3 短名、大小写、尾随点/空格、NTFS ADS
    // 后缀；不按后缀通配（避免误伤普通 json）。
    var _PROTECTED_BASENAMES = ['ast-gate-user-table.json', 'script-danger-memory.json'];
    // 8.3 短名键（与 client/shared/aefs.js 的 _shortNameKey 同构）：name/ext 以位置>0
    // 的最后一个点分界，各去点/空格后取 name 前 6 / ext 前 3；≤8 字符合法名无短名
    // 别名，不生成键（避免普通短名误伤）。
    function _protectedShortNameKey(name) {
        var dot = name.lastIndexOf('.');
        var nm = dot > 0 ? name.substring(0, dot) : name;
        var ext = dot > 0 ? name.substring(dot + 1) : '';
        var n = nm.replace(/[ .]/g, '').substring(0, 6);
        if (!n) return '';
        var plain = name.replace(/[ .]/g, '');
        if (dot !== 0 && name.indexOf(' ') < 0 && plain.length <= 8) return '';
        return n + '|' + (ext ? ext.replace(/[ .]/g, '').substring(0, 3) : '');
    }
    function _protectedFileNameHit(p) {
        if (!p || typeof p !== 'string') return '';
        var norm = p.replace(/\\/g, '/');
        var segs = norm.split('/').filter(function (s) { return s.length > 0; });
        if (!segs.length) return '';
        var base = segs[segs.length - 1].toLowerCase();
        // Win32 路径规范化：剥尾随点/空格；剥 NTFS 备用数据流后缀（::$DATA 打开的是本体）
        base = base.replace(/[. ]+$/, '');
        var ads = base.indexOf(':');
        if (ads >= 0) base = base.substring(0, ads).replace(/[. ]+$/, '');
        for (var i = 0; i < _PROTECTED_BASENAMES.length; i++) {
            if (base === _PROTECTED_BASENAMES[i]) return _PROTECTED_BASENAMES[i];
        }
        // 8.3 短名形态：短名部分可含连字符（实测形态 AST-GA~1.JSO）
        var mk = /^([a-z0-9_-]{1,6})~[0-9]{1,2}(?:\.([a-z0-9_-]{1,3}))?$/.exec(base);
        if (!mk) return '';
        var shortKey = mk[1] + '|' + (mk[2] || '');
        for (var j = 0; j < _PROTECTED_BASENAMES.length; j++) {
            if (_protectedShortNameKey(_PROTECTED_BASENAMES[j]) === shortKey) {
                return _PROTECTED_BASENAMES[j];
            }
        }
        return '';
    }

    // 局部改写：读旧文件 → 按 offset/length 拼接新内容 → 整文件写回
    function _writePartial(filePath, content, offset, length) {
        if (!global.AEFS || typeof global.AEFS.readFile !== 'function' || typeof global.AEFS.writeFileLlm !== 'function') {
            return Promise.resolve(false);
        }
        return global.AEFS.readFile(filePath).then(function (oldText) {
            if (oldText === null || typeof oldText !== 'string') {
                return { ok: false, reason: 'read_failed' };
            }
            // offset 形态校验（与 readFile 同口径）：
            // `Number(offset) || 0` 会把 `"abc"`/`null` 静默当 0（**写到文件开头**）、
            // `-5` 也静默当 0，而回执照样报 `offset:0`——调用方以为写到了指定位置。
            // length 已按 N-4 校验，offset 这条漏了（同一次修复的不对称面）。
            var off;
            if (offset === undefined || offset === null) {
                off = 0;
            } else {
                off = Number(offset);
                if (typeof offset !== 'number' || isNaN(off) || off < 0 || Math.floor(off) !== off) {
                    return { ok: false, reason: 'bad_offset', detail: JSON.stringify(offset) };
                }
            }
            if (off > oldText.length) off = oldText.length;   // 超文件末尾按末尾处理（追加场景宽松）
            // length 形态校验：只按 `isNaN(len) || len < 0` 判定时
            // 一律**静默回落**成 `content.length`（= 替换掉与 content 等长的旧文本），于是
            // `length: 0`（**插入**）、`length: -1`、`length: "abc"` 三种语义完全不同的调用
            // 得到**逐字节相同**的回执 —— 模型本想插入、却永久删掉了后续正文，而回执是绿灯。
            // 现状改为：类型/取值非法 ⇒ 报错点名；合法（含显式 0 = 纯插入）才执行，并在回执里
            // 写明**实际消费的 length** 与是否插入，让「插入 / 替换 / 删除」在回执上可区分。
            var len = null;                 // null = 未指定 ⇒ 替换 content.length 个字符（旧行为）
            if (length !== undefined && length !== null) {
                len = Number(length);
                if (typeof length !== 'number' || isNaN(len) || len < 0 || Math.floor(len) !== len) {
                    return { ok: false, reason: 'bad_length', detail: JSON.stringify(length) };
                }
            }
            var consumed = (len === null) ? content.length : len;
            var merged = oldText.substring(0, off) + content + oldText.substring(off + consumed);
            return global.AEFS.writeFileLlm(filePath, merged).then(function (res) {
                if (res && res.ok) {
                    return {
                        ok: true,
                        offset: off,
                        lengthConsumed: consumed,
                        insert: consumed === 0,
                        contentLength: content.length,
                        fileSize: merged.length
                    };
                }
                return { ok: false, reason: (res && res.reason) || 'write_failed', detail: res && res.detail };
            });
        }).catch(function () {
            return { ok: false, reason: 'read_failed' };
        });
    }

    function _writeFileHandler(args) {
        var filePath = (args && args.filePath) || '';
        var content = (args && typeof args.content === 'string') ? args.content : null;
        if (!filePath) {
            return Promise.resolve(_err(JSON.stringify({ status: 'error', message: '缺少 filePath 参数' })));
        }
        if (content === null) {
            return Promise.resolve(_err(JSON.stringify({ status: 'error', message: '缺少 content 参数（必须为字符串）' })));
        }
        // 配置/安全存储文件拒绝写入（与 AE 内核 file 域、外层路径补丁同一黑名单）。
        // 本入口直落 AEFS.writeFileLlm，不经 AE 侧 _isSensitivePath，故在此按 basename
        // 拦截：大小写无关、剥尾随点/空格与 NTFS ADS 后缀，不挡普通 .json；整文件与
        // 局部改写共用本闸。
        var _protectedHit = _protectedFileNameHit(filePath);
        if (_protectedHit) {
            return Promise.resolve(_err(JSON.stringify({
                status: 'error',
                message: '拒绝写入：' + _protectedHit + ' 是面板配置/安全存储文件，宽通道（writeFile）不可写；'
                    + '如需修改请走管理界面或对应的提议确认流程。'
            })));
        }
        if (!global.AEFS || typeof global.AEFS.writeFileLlm !== 'function') {
            return Promise.resolve(_err(JSON.stringify({ status: 'error', message: 'AEFS 不可用，无法写入文件' })));
        }
        // 单次写入 content 大小上限校验（整文件/局部改写共用）
        if (content.length > WRITEFILE_MAX_CONTENT_LEN) {
            return Promise.resolve(_err(JSON.stringify({
                status: 'error',
                message: '写入内容超过上限（' + WRITEFILE_MAX_CONTENT_LEN + ' 字符），请分次写入或改用局部改写（offset/length）'
            })));
        }
        filePath = _resolveAbsolute(filePath);

        var hasOffset = !(args.offset === undefined || args.offset === null);
        if (hasOffset) {
            // 局部改写：先读旧文件，读失败不创建凭空文件
            return _writePartial(filePath, content, args.offset, args.length).then(function (res) {
                if (!res.ok) {
                    if (res.reason === 'read_failed') {
                        return _err(JSON.stringify({ status: 'error', message: '局部改写失败：无法读取原文件（文件不存在或读取异常），未写入任何内容: ' + filePath }));
                    }
                    if (res.reason === 'bad_offset') {
                        // offset 形态非法必须点名报错——静默当 0 会写到**文件开头**
                        // 而回执报 offset:0，调用方以为写到了指定位置。
                        return _err(JSON.stringify({
                            status: 'error',
                            message: '局部改写失败：offset 形态不对（需要 ≥0 的整数，收到 ' + res.detail
                                + '）。本次未写入任何内容；要追加到末尾请传 offset: <文件字符数>。'
                        }));
                    }
                    if (res.reason === 'bad_length') {
                        // N-4：length 形态非法必须**点名报错**，不得静默回落成「替换等长旧文本」
                        //（那会让本想插入的调用永久删掉后续正文，且回执是绿灯）。
                        return _err(JSON.stringify({
                            status: 'error',
                            message: '局部改写失败：length 形态不对（需要 ≥0 的整数，收到 ' + res.detail
                                + '）。本次未写入任何内容；要**插入**请显式传 length: 0，要替换 N 个字符请传 length: N，'
                                + '省略 length 则替换与 content 等长的旧文本。'
                        }));
                    }
                    return _err(JSON.stringify({ status: 'error', message: '局部改写失败：写入原文件失败（' + _reasonText(res) + '）: ' + filePath }));
                }
                // 回执写明**实际消费的 length**、是否插入、写入后文件长度：
                // 只回 `size: content.length` 且 readFile 的 `size` 是**文件总字符数**——同名字段反义，
                // 且「插入 / 替换 / 删除」在回执上完全不可区分（length:0 / -1 / "abc" 回执逐字节相同）。
                return _ok(JSON.stringify({
                    status: 'success',
                    mode: 'partial',
                    filePath: filePath,
                    offset: res.offset,
                    lengthConsumed: res.lengthConsumed,
                    insert: res.insert,
                    size: res.contentLength,
                    sizeNote: 'size = 本次写入的 content 字符数（readFile 的 size 是文件总字符数）',
                    fileSize: res.fileSize
                }));
            });
        }
        // 整文件写入（走 LLM 专用写通道）
        return global.AEFS.writeFileLlm(filePath, content).then(function (res) {
            if (res && res.ok) {
                // 如实回报编码处理——原文件是 GBK 时要么按原编码写回（preserved），
                // 要么写成了 UTF-8（converted，须让用户/模型知道，避免 .jsx 之类的编码被悄悄换掉）
                var _encNote = res.encodingPreserved ? '，已按原文件编码（GBK）写回' : '';
                return _ok(JSON.stringify({ status: 'success', mode: 'overwrite', filePath: filePath, size: content.length, encodingNote: _encNote || undefined }));
            }
            return _err(JSON.stringify({ status: 'error', message: '写入文件失败（' + _reasonText(res) + '）: ' + filePath }));
        });
    }

    // 将 AEFS.writeFileLlm 返回的错误 reason/detail 归一化为可读文本，透传给 LLM 便于其自我纠正。
    // 非源语言先问 AEFS.displayError（机器码 → 当前语言文案 + 原始详情）；
    // 拿不到本地化文案（码表无对应码 / AEI18n 未装载）时落回下面的源文分支。
    function _reasonText(res) {
        var localized = _localizedReasonText(res);
        if (localized) return localized;
        var reason = res && res.reason;
        switch (reason) {
            case 'denied':
                return '写入被拒绝（' + ((res && res.detail) || '路径不安全或用户拒绝') + ')';
            case 'encoding_unavailable':
                // 目标不是 UTF-8（GBK）且无法按原编码写回——如实说明（绝不静默转码）
                return '目标不是 UTF-8（GBK），按原编码写回失败（ExtendScript 通道不可用或目标是链接）';
            case 'server_error':
                return 'Bridge 服务内部错误（' + ((res && res.detail) || '请稍后重试') + '）';
            case 'sensitive':
                return '目标路径含敏感凭据（.ssh/.env/id_rsa 等）';
            case 'system_dir':
                return '目标位于系统目录/盘根';
            case 'invalid_path':
                return '路径格式非法';
            case 'no_content':
                return '缺少写入内容';
            case 'body_too_large':
                // 无此分支时回执直接露英文 token（body_too_large）。
                // 真实成因是 HTTP 请求体超过 bridge readBody 上限（40MB，含 JSON 转义
                // 与 UTF-8 膨胀），内容未落盘——给模型可自我纠正的中文指引。
                return '写入内容超过通道上限（HTTP 请求体上限 40MB，含 JSON 转义/UTF-8 膨胀余量），内容未落盘；请减小内容、分次写入或改用局部改写（offset/length）';
            case 'unauthorized':
                // 同源 token 泄漏：401 是 token 轮换自愈窗口，不是业务拒绝
                return 'Bridge 鉴权刷新中（401），请稍后重试';
            case 'read_failed':
                return '无法读取原文件';
            case 'write_failed':
                return '写入异常';
            default:
                return reason || '未知错误';
        }
    }

    // 源语言（zh-CN）返回空串：下面的源文分支带码表给不出的可执行指引
    // （分次写入 / 局部改写 / 稍后重试），保留原文即保留这些指引。
    // 其余语言：码表命中就用「本地化文案: 原始详情」，命中不了才回源文。
    function _localizedReasonText(res) {
        if (!global.AEFS || typeof global.AEFS.displayError !== 'function') return '';
        if (!global.AEI18n || typeof global.AEI18n.getLocale !== 'function') return '';
        if (global.AEI18n.getLocale() === 'zh-CN') return '';
        if (typeof global.AEFS.reasonToCode !== 'function') return '';
        if (!global.AEFS.reasonToCode(res && res.reason)) return '';
        return String(global.AEFS.displayError(res) || '');
    }

    // ====== 初始化入口 ======

    function initPlatformFileTools(opts) {
        var toolRegistry = opts && opts.toolRegistry;
        if (!toolRegistry || typeof toolRegistry.register !== 'function') {
            console.warn('[platformTools] 缺少 toolRegistry，跳过平台文件工具注册');
            return;
        }

        // readFile（global，注册于 initAETools 之后以覆盖同名 ExtendScript 版）
        toolRegistry.register({
            name: 'readFile',
            description: '读取本地文件内容（只读）。docx/xlsx/pdf/csv 等自动解析为文本，txt/json/md/js 等直接读取；二进制文件拒绝并提示。',
            input_schema: {
                type: 'object',
                properties: {
                    filePath: {
                        type: 'string',
                        description: '文件绝对路径，如 C:\\Users\\...\\notes.txt'
                    },
                    maxChars: {
                        type: 'number',
                        description: '最大返回字符数，默认 10000，上限 20000。更多内容用 offset 分页'
                    },
                    offset: {
                        type: 'number',
                        description: '字符偏移位置（分页用），默认 0 从头读。返回的 next offset 可续读'
                    },
                    search: {
                        type: 'string',
                        description: '搜索关键词（默认大小写不敏感），返回前 20 个匹配位置的 offset 与上下文片段。支持 /正则/ 形式，如 /粒子\\d+/i 或 /SaveAs/g'
                    },
                    searchOffset: {
                        type: 'number',
                        description: '搜索分页：跳过前 N 条命中（配合 search，每批最多 20 条），用 total 判断是否还有更多'
                    }
                },
                required: ['filePath']
            },
            handler: function (args) {
                // 参数**形态**校验：非法形态不得静默丢弃或改义
                // 在分页器 `codeQuery.js` 修过（注释自陈「静默按『没传』处理，回执却是一整篇，
                // 模型以为读的是它要的区间」）。readFile 侧的静默改义实测：
                //   · `search: 42 / ["a"]` → 静默丢弃搜索、回整页正文（模型以为搜过了）；
                //   · `offset: "xyz"` → 静默当 0 回第 1 页；
                //   · `maxChars: 0` → 整页 10000，而 `maxChars: -5` → **1 个字符**（相邻边界走向相反，
                //     且旧 JSX 版是「NaN 或 ≤0 → 10000」，这个分叉是迁移到平台工具后才有的）；
                //   · `filePath: 123` → 同步抛 `TypeError: p.indexOf is not a function`（JS 内部消息
                //     被当回执喂给模型）。
                // 口径：类型不符**点名参数**报错（不猜、不静默），数值参数要求非负整数。
                var _badArg = function (name, want, got) {
                    return Promise.resolve(_err(JSON.stringify({
                        status: 'error',
                        message: '参数 ' + name + ' 形态不对：需要' + want + '，收到 ' + got
                            + '。' + (name === 'filePath' ? '' : '请去掉该参数或改正后重试（本次未执行读取）。')
                    })));
                };
                // 注意：**缺参**（undefined/null/空串）仍走下面的「缺少 filePath 参数」原文案，
                // 只有**类型不符**（数字/对象…）才在这里点名——否则既有文案口径与回执形态会被改掉。
                if (args && args.filePath !== undefined && args.filePath !== null
                    && typeof args.filePath !== 'string') {
                    return _badArg('filePath', '字符串', typeof args.filePath);
                }
                if (args && args.search !== undefined && args.search !== null && typeof args.search !== 'string') {
                    return _badArg('search', '字符串（普通关键词或 /正则/）', typeof args.search);
                }
                var _numArgs = ['offset', 'maxChars', 'searchOffset'];
                for (var _ni = 0; _ni < _numArgs.length; _ni++) {
                    var _nv = args ? args[_numArgs[_ni]] : undefined;
                    if (_nv === undefined || _nv === null) continue;
                    if (typeof _nv !== 'number' || !isFinite(_nv) || _nv < 0 || Math.floor(_nv) !== _nv) {
                        return _badArg(_numArgs[_ni], '非负整数', JSON.stringify(_nv));
                    }
                    // `maxChars: 0` 显式传 0 也要拒：`Number(0) || 10000` 会静默取整页，
                    // 而 `-5` 走另一条路 → **相邻边界走向相反**（这正是 N-2 报的分叉）。
                    if (_numArgs[_ni] === 'maxChars' && _nv === 0) {
                        return _badArg('maxChars', '≥1 的整数（0 无意义；要整页请省略该参数）', '0');
                    }
                }
                var filePath = (args && args.filePath) || '';
                if (!filePath) {
                    return Promise.resolve(_err(JSON.stringify({ status: 'error', message: '缺少 filePath 参数' })));
                }
                filePath = _resolveAbsolute(filePath);
                var maxChars = Number(args && args.maxChars) || 10000;
                // 单页上限必须**低于**工具结果兜底截断阈值（toolExecutionPipeline 的
                // MAX_TOOL_RESULT_CHARS = 32K 字符）：否则工具自己广告
                // 的"一页"会被兜底再截一次——页中段丢失、结果被切成非法 JSON（filePath/size/
                // nextOffset 等结构化字段全没），模型按工具文档给的粒度读反而要补读一轮。
                // 旧值 200×1024 是按当时 128K 阈值定的，阈值下调后这个等式必须跟着走。
                var READFILE_MAX_CHARS_LIMIT = 20000;
                if (maxChars > READFILE_MAX_CHARS_LIMIT) maxChars = READFILE_MAX_CHARS_LIMIT;
                if (maxChars < 1) maxChars = 1;
                var offset = Number(args && args.offset) || 0;
                var search = (args && typeof args.search === 'string') ? args.search.trim() : '';
                var searchOffset = Number(args && args.searchOffset) || 0;
                return _readFileTool(filePath, maxChars, offset, search, searchOffset);
            },
            scope: { type: 'global' },
            stub: false,
            category: 'utility',
            source: 'platform'
        });
        console.log('[platformTools] readFile 工具已注册 (global, platform)');

        // read_image（global，仅格式/内容探测校验，实际读取+安全检查在 vision hook 走 AEFS）
        toolRegistry.register({
            name: 'read_image',
            description: '读取磁盘图片（PNG/JPG/JPEG）供视觉分析，支持序列渲染产物（如 xxx.png00000）。filePath 为图片绝对路径；purpose 可选，说明本次分析需重点关注的内容',
            input_schema: {
                type: 'object',
                properties: {
                    filePath: {
                        type: 'string',
                        description: '图片文件的绝对路径，如 C:\\Users\\...\\screenshot.png'
                    },
                    purpose: {
                        type: 'string',
                        description: '（可选）本次分析需重点关注的内容，会交给视觉模型围绕此需求输出'
                    }
                },
                required: ['filePath']
            },
            handler: function (args) {
                var filePath = (args && args.filePath) || '';
                if (!filePath) return Promise.resolve(_err('Missing filePath parameter'));
                if (filePath.indexOf('data:') !== 0) filePath = _resolveAbsolute(filePath);
                var ext = filePath.toLowerCase().split('.').pop();
                var plainImage = ['png', 'jpg', 'jpeg'].indexOf(ext) !== -1;
                // 序列渲染产物：AE 输出名形如 X.png00000（标准图片扩展名 + 纯数字帧号后缀）。
                // 扩展名不是白名单项，但内容通常是 PNG/JPEG；放行前必须做一次内容探测，否则
                // 「扩展名像图片、内容不是图片」的文件会被当图片交给视觉侧（工具回 success、
                // 视觉侧静默无图 = 假成功）。
                var seqImage = !plainImage && /^(png|jpg|jpeg)\d+$/.test(ext);
                if (!plainImage && !seqImage) {
                    return Promise.resolve(_err('Unsupported image format: .' + ext + '. Supported: .png, .jpg, .jpeg'));
                }
                // 存在性校验：read_image 仅转发路径，实际读取在视觉 hook。若目标不存在，
                // 提前报错让 LLM 感知，而不是对缺失文件闷头重试（视觉 hook 会反复打 bridge 404 ~6s 后静默失败）。
                // existsResult 三态——NOT_FOUND 才报不存在；通道故障/拒绝跳过
                // 预检交视觉 hook 报真实读取错误（existsSync 折叠 false 会向 LLM 谎报
                // 「图片不存在」，LLM 据此告知用户文件丢失）。旧 mock 无 existsResult
                // 时保持 existsSync 判定。
                var _probe = (global.AEFS && typeof global.AEFS.existsResult === 'function')
                    ? global.AEFS.existsResult(filePath)
                    : Promise.resolve((global.AEFS && typeof global.AEFS.existsSync === 'function' && global.AEFS.existsSync(filePath) === false)
                        ? { ok: false, error: { code: 'NOT_FOUND' } }
                        : { ok: true });
                var payload = JSON.stringify({ filePath: filePath, source: 'read_image' });

                // 白名单扩展名直接放行（行为不变）；序列产物（png00000 等）须经
                // AEFS.readImageBase64 → bridge /api/read-image 按文件头嗅探确认内容确是图片。
                function _finish() {
                    if (!seqImage) return _ok(payload);
                    if (!global.AEFS || typeof global.AEFS.readImageBase64 !== 'function') {
                        // 无内容探测通道（旧宿主/单测 mock）：按原扩展名白名单逻辑拒绝，
                        // 不放行未经内容验证的「形似图片」文件。
                        return _err('Unsupported image format: .' + ext + '. Supported: .png, .jpg, .jpeg');
                    }
                    var _imgProbe;
                    try {
                        _imgProbe = global.AEFS.readImageBase64(filePath);
                    } catch (e) {
                        _imgProbe = null;
                    }
                    function _notImage() {
                        return _err('文件内容不是 PNG/JPEG 图片: ' + filePath
                            + '（扩展名 .' + ext + ' 形似图片，但内容探测未通过）');
                    }
                    return Promise.resolve(_imgProbe).then(function (r) {
                        return (r && r.success === true) ? _ok(payload) : _notImage();
                    }, _notImage);
                }

                return _probe.then(function (_r) {
                    if (_r && _r.ok === false && _r.error && _r.error.code === 'NOT_FOUND') {
                        return _err('图片文件不存在，无法读取: ' + filePath + '。请检查路径是否正确。');
                    }
                    return _finish();
                }, function () {
                    // 存在性通道故障：跳过预检、交视觉 hook 报真实读取错误（原语义）；
                    // 序列产物的内容探测仍执行，不因预检故障放行未验证内容。
                    return _finish();
                });
            },
            scope: { type: 'global' },
            stub: false,
            category: 'utility',
            source: 'platform'
        });
        console.log('[platformTools] read_image 工具已注册 (global, platform)');

        // read_video（global，仅格式校验，实际读取+上传+注入在 video hook 走 AEFS + AE_LLM.uploadVideoFile）
        toolRegistry.register({
            name: 'read_video',
            description: '读取磁盘视频（MP4/MOV/WEBM/M4V/MKV）供视频模型分析。filePath 为视频绝对路径；purpose 可选，说明需重点关注的内容。仅视频模型可用。',
            input_schema: {
                type: 'object',
                properties: {
                    filePath: {
                        type: 'string',
                        description: '视频文件的绝对路径，如 C:\\Users\\...\\output.mp4'
                    },
                    purpose: {
                        type: 'string',
                        description: '（可选）本次分析需重点关注的内容，会交给视频模型围绕此需求输出'
                    }
                },
                required: ['filePath']
            },
            handler: function (args) {
                var filePath = (args && args.filePath) || '';
                if (!filePath) return Promise.resolve(_err('Missing filePath parameter'));
                if (filePath.indexOf('data:') !== 0) filePath = _resolveAbsolute(filePath);
                var ext = filePath.toLowerCase().split('.').pop();
                if (['mp4', 'mov', 'webm', 'm4v', 'mkv'].indexOf(ext) === -1) {
                    return Promise.resolve(_err('Unsupported video format: .' + ext + '. Supported: .mp4, .mov, .webm, .m4v, .mkv'));
                }
                var payload = JSON.stringify({ filePath: filePath, source: 'read_video' });
                return Promise.resolve(_ok(payload));
            },
            scope: { type: 'global' },
            stub: false,
            category: 'utility',
            source: 'platform'
        });
        console.log('[platformTools] read_video 工具已注册 (global, platform)');

        // writeFile（Agent / Script / Shader 三档，整文件写入 + 局部改写）
        toolRegistry.register({
            name: 'writeFile',
            description: '写入/修改本地文本文件。支持整文件覆盖和局部改写。单次最大 ' + (WRITEFILE_MAX_CONTENT_LEN / (1024 * 1024)) + 'MB（对齐 Bridge 请求体上限的保守折算值）。系统/敏感路径、二进制文件、文件夹会被拒绝。每次写入需用户确认。',
            input_schema: {
                type: 'object',
                properties: {
                    filePath: {
                        type: 'string',
                        description: '文件绝对路径，如 C:\\Users\\...\\notes.txt（兼容相对数据目录的相对路径）'
                    },
                    content: {
                        type: 'string',
                        description: '要写入的内容（整文件=全部内容；局部改写=替换/插入的新内容）。单次最大 ' + (WRITEFILE_MAX_CONTENT_LEN / (1024 * 1024)) + 'MB'
                    },
                    offset: {
                        type: 'number',
                        description: '（局部改写）字符偏移，从该处开始写，不传则整文件写入，传末尾可追加'
                    },
                    length: {
                        type: 'number',
                        description: '（局部改写）从 offset 起覆盖的字符数：0=插入；缺省=content.length 替换；超过则删除多余区间'
                    }
                },
                required: ['filePath', 'content']
            },
            handler: _writeFileHandler,
            // Script / Shader 档也要能写产物文件（写脚本产物、导出中间结果）。
            scope: { type: 'module', moduleIds: ['agent', 'script', 'shader'] },
            stub: false,
            category: 'utility',
            source: 'platform'
        });
        console.log('[platformTools] writeFile 工具已注册 (module:agent,script,shader, platform)');
    }

    global.AEShared = global.AEShared || {};
    global.AEShared.initPlatformFileTools = initPlatformFileTools;
    global.AEShared.WRITEFILE_MAX_CONTENT_LEN = WRITEFILE_MAX_CONTENT_LEN;

})(window);