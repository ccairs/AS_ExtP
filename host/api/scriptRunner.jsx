// scriptRunner.jsx — 脚本沙箱执行（由 host.jsx $.evalFile 加载，挂 AE 全局）
// 迁移自 client/modules/agent/engine/executor.js 的 AE_LLM._wrapScriptForAE：
// CEP 渲染进程侧的做法是拼脚本字符串后 evalScript 到 AE；热盒（AEGP）无法访问渲染进程，
// 故把同一沙箱逻辑固化为 ExtendScript 函数，AEGP 经 AEGP_ExecuteScript 直接调用（返回原样字符串）。
// 行为对齐：shadow File/Folder（拦写/删/改名/复制/execute）+ 阻断 system.callSystem/BridgeTalk/Socket
// + finally 恢复 + 可选 undo 组包裹。返回 "SUCCESS" 或 "ERROR:<msg>"。
// 原始引用（__aelS/_OF 等）不再与用户代码同作用域——用户代码经 new Function(转义
// 字面量) 执行（FunctionBody 作用域只含全局，看不到内层 IIFE 的局部 var），并在拼接前做静态
// 黑名单预检；executor.js（CEP 渲染进程侧同源实现）仍为直接拼接形态，仍以拦"无意"脚本为主。
// 拦截文案与 executor.js 刻意不同——热盒（AEGP）路径无条件注入沙箱、
// 无 allowScriptFileWrite 豁免分支（用户指南：「脚本执行一律走沙箱包装，不提供
// 绕过开关」），面板 Agent 设置的「脚本权限」开关只影响 CEP 渲染进程侧的
// executor.js 包装，对热盒路径无效。旧文案 "enable in Agent settings" 指向
// 一条对热盒不存在的出路，误导用户去翻无用的开关。

// 沙箱序言（与 executor.js _buildPreamble 对齐；IIFE 内执行，参数 _OF/_OD 为原始 File/Folder，
// 避免 ES3 var 提升让 __aelF=File 捕获 undefined。只拦写入/删除/系统命令，读取透传。
// File/Folder shadow 由 var 局部改为全局赋值——用户代码改经 new Function 执行
// （FunctionBody 只见全局），var 局部 shadow 对其不可见；静态属性仍在 shadow 前缓存。
// File.open 拦截层用 arguments 全参透传（File.open(mode[,encoding[,type]])），
// 只透传 mode 会丢 encoding——沙箱脚本 open("r","UTF-8") 按系统默认代码页解读，UTF-8 读出乱码。）
var __hotboxPreamble =
    'var __aelF=_OF,__aelD=_OD;\n' +
    'var __ffs=__aelF.fs,__fdecode=__aelF.decode,__fencode=__aelF.encode;\n' +
    'var __fisEnc=__aelF.isEncodingAvailable,__fopenDlg=__aelF.openDialog,__fsaveDlg=__aelF.saveDialog;\n' +
    'var __dfs=__aelD.fs,__ddecode=__aelD.decode,__dencode=__aelD.encode;\n' +
    'var __disEnc=__aelD.isEncodingAvailable,__dselectDlg=__aelD.selectDialog;\n' +
    'var __dtemp=__aelD.temp,__ddesktop=__aelD.desktop,__dmydocs=__aelD.myDocuments;\n' +
    'var __dappdata=__aelD.appData,__dcurrent=__aelD.current,__dstartup=__aelD.startup,__duserdata=__aelD.userData;\n' +
    // 真实例补丁函数（原 File shadow 构造器内联逻辑抽出复用）——静态访问器
    // （Folder.temp 等）不再直接暴露未包装真实例：真实例的
    // .execute()（启动任意可执行文件）/open("w")/remove 全部可用，
    // `var f=Folder.temp.getFiles()[0]; f.execute();` 是黑名单外的 RCE 通道。
    // （getFiles 返回条目现由原型层直接覆盖——逐条包装只在原型层缺席时兜底，
    //   见 __aelPD 内的注释。）
    // __aelPF/__aelPD 命名落在 __ael 黑名单段内：用户代码静态引用即被拒（纵深防御）。
    // getFiles 条目分派用鸭子类型（getFiles/open 方法探测）而非 instanceof——
    // 沙箱窗口内 File/Folder 已被全局 shadow，依赖原始构造器引用做 instanceof
    // 不可靠（IIFE 参数 __aelF/__aelD 调用虽已被现有构造器证明可用，条目分派
    // 保持零构造器依赖更稳）。
    'var __aelPF=function(f){\n' +
    '  var _open=f.open;f.open=function(m){if(m==null)return _open.apply(f,arguments);var s=String(m).toLowerCase();if(/^[a-z+]*$/.test(s)&&/[wea]/.test(s))throw Error("[AE_LLM] File write disabled - hotbox scripts are always sandboxed");return _open.apply(f,arguments);};\n' +
    '  f.remove=function(){throw Error("[AE_LLM] File delete disabled - hotbox scripts are always sandboxed");};\n' +
    '  f.rename=function(){throw Error("[AE_LLM] File rename disabled - hotbox scripts are always sandboxed");};\n' +
    '  f.copy=function(){throw Error("[AE_LLM] File copy disabled - hotbox scripts are always sandboxed");};\n' +
    '  f.execute=function(){throw Error("[AE_LLM] System call disabled - hotbox scripts are always sandboxed");};\n' +
    // changePath 拦截（与静态黑名单/原型补丁三防线同步，对齐 aeTools.jsx）
    '  f.changePath=function(){throw Error("[AE_LLM] changePath disabled - hotbox scripts are always sandboxed");};\n' +
    '  return f;};\n' +
    'var __aelPD=function(d){\n' +
    '  d.remove=function(){throw Error("[AE_LLM] Folder delete disabled - hotbox scripts are always sandboxed");};\n' +
    '  d.create=function(){throw Error("[AE_LLM] Folder create disabled - hotbox scripts are always sandboxed");};\n' +
    '  d.rename=function(){throw Error("[AE_LLM] Folder rename disabled - hotbox scripts are always sandboxed");};\n' +
    '  d.execute=function(){throw Error("[AE_LLM] System call disabled - hotbox scripts are always sandboxed");};\n' +
    '  d.changePath=function(){throw Error("[AE_LLM] changePath disabled - hotbox scripts are always sandboxed");};\n' +
    // getFiles 返回的 File/Folder 条目逐个补丁（ES3 无 Array.map，用循环）——
    // 未包装条目的 .execute()/.open("w") 是静态黑名单外的漏网通道；旧 mock 环境可能
    // 无 getFiles 原型方法，typeof 守卫跳过包装
    // 与 aeTools.jsx 同口径：**仅原型层不可用时**才逐条包装——
    // 逐条包装是 O(条目数) 的（每条 5-6 个闭包），`Folder.temp.getFiles()` 在大目录
    // （真机 74,251 条）上 ⇒ ≈40 万次闭包、AE 卡死数分钟；而条目危险方法与原型层
    // （本 preamble 上方 __aelPT/__aelDT 补丁）覆盖的方法集逐项一致 ⇒ 逐条包装是
    // 冗余的第二层。原型层在位（AE 正常形态）→ 条目透传；缺 prototype 的旧环境
    // → 保留逐条包装兜底。__aelPT/__aelDT 在本函数被调用前已赋值（访问器克隆/构造器
    // 包装均在其后）。
    '  if(typeof d.getFiles==="function"&&!(__aelPT&&__aelDT)){var __aelG=d.getFiles;d.getFiles=function(){var __r=__aelG.apply(d,arguments);if(!__r)return __r;var __o=[],__i;for(__i=0;__i<__r.length;__i++){var __e=__r[__i];if(typeof __e==="object"&&__e!==null&&typeof __e.getFiles==="function")__o.push(__aelPD(__e));else if(typeof __e==="object"&&__e!==null&&typeof __e.open==="function")__o.push(__aelPF(__e));else __o.push(__e);}return __o;};}\n' +
    '  return d;};\n' +
    // 原型层补丁（第二层防线）——实例补丁只覆盖静态访问器克隆/getFiles 条目/
    // 构造器产物，但「返回新实例」通道会泄漏未补丁真实例：.parent 访问器
    // （Folder.temp.parent 返回引擎新建真实 Folder）与对话框静态方法（openDialog/
    // saveDialog/selectDialog）——真实例的 .execute()/open("w")/remove 全部原生可用。
    // 沙箱窗口内同步执行（ExtendScript 单线程），对原始构造器的 prototype 方法补丁 +
    // finally 对称还原：引擎经任何通道新建的实例，危险方法全部委托到被补丁原型而被拦。
    // 无 prototype 的环境（旧 mock）守卫跳过，保留实例补丁层。__ael 前缀命名在静态
    // 黑名单段内：用户代码静态引用即被拒。
    'var __aelPT=(typeof File!=="undefined"&&File&&File.prototype)?File.prototype:null;\n' +
    'var __aelDT=(typeof Folder!=="undefined"&&Folder&&Folder.prototype)?Folder.prototype:null;\n' +
    'var __aelFO=__aelPT?{open:__aelPT.open,remove:__aelPT.remove,rename:__aelPT.rename,copy:__aelPT.copy,execute:__aelPT.execute,changePath:__aelPT.changePath}:null;\n' +
    'var __aelDO=__aelDT?{remove:__aelDT.remove,create:__aelDT.create,rename:__aelDT.rename,execute:__aelDT.execute,changePath:__aelDT.changePath}:null;\n' +
    'if(__aelPT){__aelPT.open=function(m){if(m==null)return __aelFO.open.apply(this,arguments);var s=String(m).toLowerCase();if(/^[a-z+]*$/.test(s)&&/[wea]/.test(s))throw Error("[AE_LLM] File write disabled - hotbox scripts are always sandboxed");return __aelFO.open.apply(this,arguments);};__aelPT.remove=function(){throw Error("[AE_LLM] File delete disabled - hotbox scripts are always sandboxed");};__aelPT.rename=function(){throw Error("[AE_LLM] File rename disabled - hotbox scripts are always sandboxed");};__aelPT.copy=function(){throw Error("[AE_LLM] File copy disabled - hotbox scripts are always sandboxed");};__aelPT.execute=function(){throw Error("[AE_LLM] System call disabled - hotbox scripts are always sandboxed");};__aelPT.changePath=function(){throw Error("[AE_LLM] changePath disabled - hotbox scripts are always sandboxed");};}\n' +
    'if(__aelDT){__aelDT.remove=function(){throw Error("[AE_LLM] Folder delete disabled - hotbox scripts are always sandboxed");};__aelDT.create=function(){throw Error("[AE_LLM] Folder create disabled - hotbox scripts are always sandboxed");};__aelDT.rename=function(){throw Error("[AE_LLM] Folder rename disabled - hotbox scripts are always sandboxed");};__aelDT.execute=function(){throw Error("[AE_LLM] System call disabled - hotbox scripts are always sandboxed");};__aelDT.changePath=function(){throw Error("[AE_LLM] changePath disabled - hotbox scripts are always sandboxed");};}\n' +
    // File/Folder shadow 由 var 局部改为全局赋值（无 var 前缀）——用户代码经
    // new Function 执行只看得到全局，var 局部 shadow 对其不可见；恢复见 finally 的 File=_OF
    // 构造器复用 __aelPF/__aelPD 补丁（拦截条件/文案不变，见上方函数注释）
    'File=function(p){\n' +
    '  return __aelPF(__aelF(p));\n' +
    '  };\n' +
    'File.fs=__ffs;File.decode=__fdecode;File.encode=__fencode;\n' +
    'File.isEncodingAvailable=__fisEnc;File.openDialog=__fopenDlg;File.saveDialog=__fsaveDlg;\n' +
    // 同 File——全局赋值 shadow
    'Folder=function(p){\n' +
    '  return __aelPD(__aelD(p));\n' +
    '  };\n' +
    'Folder.fs=__dfs;Folder.decode=__ddecode;Folder.encode=__dencode;\n' +
    'Folder.isEncodingAvailable=__disEnc;Folder.selectDialog=__dselectDlg;\n' +
    // 静态访问器改返回「打补丁的克隆实例」——直接透传 __dtemp 等缓存真实例
    // 时其 getFiles() 返回未包装真实 File（.execute()/open("w") 全可用）；经 __aelD(fsName)
    // 克隆再补丁，既不污染引擎可能共享的真实静态实例（恢复段只还原构造器，救不回被
    // 原地补丁的实例），又保证只读属性（fsName 等）照常可用
    'Folder.temp=__aelPD(__aelD(__dtemp.fsName||__dtemp.absoluteURI));Folder.desktop=__aelPD(__aelD(__ddesktop.fsName||__ddesktop.absoluteURI));Folder.myDocuments=__aelPD(__aelD(__dmydocs.fsName||__dmydocs.absoluteURI));\n' +
    'Folder.appData=__aelPD(__aelD(__dappdata.fsName||__dappdata.absoluteURI));Folder.current=__aelPD(__aelD(__dcurrent.fsName||__dcurrent.absoluteURI));Folder.startup=__aelPD(__aelD(__dstartup.fsName||__dstartup.absoluteURI));Folder.userData=__aelPD(__aelD(__duserdata.fsName||__duserdata.absoluteURI));\n' +
    'system.callSystem=function(){throw Error("[AE_LLM] System call disabled - hotbox scripts are always sandboxed");};\n' +
    // app.scheduleTask 运行时 shadow——静态 \bscheduleTask\b 可被字符串拼接
    // （app["schedule"+"Task"]）绕过，延迟回调在 finally 恢复 File/Folder/system 之后执行
    // 任意代码（时间窗绕过双层防线）。对齐 aeTools.jsx 闭包安装段 / 核内 _st 写法：
    // 保存原值 + 替换为 throw + finally 对称恢复（__aelST 为 IIFE 局部 var——preamble 内
    // var 提升至 IIFE 作用域，finally 可见；app 未定义的环境跳过 shadow/恢复）。
    // $.evalFile 不需同款 shadow：沙箱窗口内 evalFile 执行的文件内容同样只见被 shadow
    // 的全局（File/Folder/callSystem/BridgeTalk/Socket/scheduleTask），其逃逸面与用户
    // 代码一致；"evalFile 读文件再调 scheduleTask" 链条经本 shadow 即封死。
    'var __aelST=(typeof app!=="undefined"&&app&&app.scheduleTask)?app.scheduleTask:null;\n' +
    'if(__aelST){app.scheduleTask=function(){throw Error("[AE_LLM] scheduleTask disabled - hotbox scripts are always sandboxed");};}\n' +
    'if(typeof BridgeTalk!=="undefined"){BridgeTalk=function(){throw Error("[AE_LLM] BridgeTalk disabled - hotbox scripts are always sandboxed");};}\n' +
    // Socket 是完整 TCP 通道（数据外泄/伪造 bridge 请求），设计铁律无条件禁项——
    // 热盒脚本不经过任何 CEP 侧预检，此处 shadow 是唯一防线（保存/还原参照 BridgeTalk 模式）
    'if(typeof Socket!=="undefined"){Socket=function(){throw Error("[AE_LLM] Socket disabled - hotbox scripts are always sandboxed");};}\n' +
    'var __aelGF2=(typeof $!=="undefined"&&$.global)?$.global.File:null;\n' +
    'var __aelGD2=(typeof $!=="undefined"&&$.global)?$.global.Folder:null;\n' +
    'if(typeof $!=="undefined"&&$.global){$.global.File=File;$.global.Folder=Folder;}\n' +
    'else{$.writeln("[AE_LLM] WARNING: $.global unavailable — sandbox bypass protection inactive");}\n';

// 把用户脚本转义为可嵌入 ES3 双引号字符串字面量的内容（new Function 的参数）。
// 必须转义：反斜杠/双引号（防字面量逃逸改写外层沙箱结构）、LF/CR/U+2028/U+2029
// （ES3 行终止符，裸出现即让整条拼接脚本 SyntaxError）、其余 C0 控制字符与 DEL
// （\xNN 保真转义——不用空格替换，空格会改变用户脚本内字符串字面量的内容）。
// 逐字符循环而非 replace：\u2028/\u2029 需按码位各自展开。
function __aelEscapeScript(t) {
    var s = String(t), out = "", i, c, n, h;
    for (i = 0; i < s.length; i++) {
        c = s.charAt(i);
        n = s.charCodeAt(i);
        if (c === "\\") { out += "\\\\"; }
        else if (c === "\"") { out += "\\\""; }
        else if (n === 10) { out += "\\n"; }
        else if (n === 13) { out += "\\r"; }
        else if (n === 0x2028) { out += "\\u2028"; }
        else if (n === 0x2029) { out += "\\u2029"; }
        else if (n < 32 || n === 127) {
            h = n.toString(16);
            if (h.length < 2) { h = "0" + h; }
            out += "\\x" + h;
        }
        else { out += c; }
    }
    return out;
}

// ── 沙箱执行脚本文本 ──
// args: { scriptText, undoName? }（脚本内容 UTF-8；undoName 可选，传入则整体包一次撤销组）
// 结构改造——若把 __aelS（真实 system.callSystem）等原始引用与拼接的
// 用户代码放在同一层 IIFE 作用域，用户脚本直接写 __aelS("cmd /c ...") 或 new _OF(...)
// 即取得未包装的真实 API（热盒 AEGP 路径对 scriptText 无任何静态预检，该 shadow 是唯一
// 防线）。新结构三层防线：①拼接前静态黑名单预检；②原始引用仍为内层 IIFE 局部 var，但用户
// 代码改经 new Function(转义字面量)() 执行——ExtendScript 直接 eval 不隔离词法作用域（用户
// 代码仍可读外层 var），而 new Function 的 FunctionBody 作用域只含全局，看不到这些局部；
// ③shadow 机制不变（全局赋值 + $.global 镜像，new Function 作用域链含全局，能看到 shadow
// 后的值），恢复逻辑仍在同一内层函数的 finally（新增还原全局 File/Folder）。
function runScriptSandboxed(scriptText, undoName) {
    try {
        // 静态黑名单预检（对齐 aeTools.jsx executeExtendScript 黑名单风格）——
        // 拦沙箱内部标识符（__ael/__aeS*/_OF/_OD）与危险 API 标识符；scheduleTask 延迟
        // 回调在 shadow 恢复后执行（时间窗绕过双层防线）、$.evalFile/runScriptFromFile 在
        // 沙箱外作用域执行文件内容，均须拒绝。undoGroup 不在此列——脚本自带撤销组时跳过
        // 框架包裹（见下方 _userOwnsUndo），撤销语义由脚本自负。运行时 shadow
        // 仍是第二层防线（静态可被字符串拼接绕过）。
        // 黑名单补 \.execute\s*\(（File/Folder.execute 启动任意可执行文件，
        // 与「File operations blocked」承诺一致全拒；app.executeCommand 等不受影响——
        // .execute 后必须紧跟 "("）与 \.getFiles\b\s*\(\s*\)\s*\[（getFiles() 立即索引
        // 形态；先存变量再索引的合法只读遍历不受影响）。静态访问器（Folder.temp 等）
        // 与 getFiles 返回条目在运行时均已包装为只读安全实例，静态形态是纵深防御第一层。
        // 黑名单补 \.changePath\s*\(——AE 对象模型返回的真实 File 实例
        // （app.project.file 等）不经被 shadow 的构造器，changePath 改指任意路径 +
        // open("r")（按设计放行）+ read() 构成敏感读取链（与 aeTools.jsx 同步）。
        if (/__ael|__aeS|_OF\b|_OD\b|\.evalFile|\.global\b|callSystem|BridgeTalk|\bSocket\b|\bscheduleTask\b|\brunScriptFromFile\b|\.execute\s*\(|\.changePath\s*\(|\.getFiles\b\s*\(\s*\)\s*\[/i.test(String(scriptText))) {
            return "ERROR:[AE_LLM] runScriptSandboxed 拒绝执行：脚本含沙箱逃逸/系统调用/网络通信/延迟执行/实例危险操作标识符（__ael/__aeS/_OF/_OD/$.evalFile/$.global/callSystem/BridgeTalk/Socket/scheduleTask/runScriptFromFile/.execute(/.changePath(/.getFiles()[）。热盒脚本一律沙箱执行（hotbox scripts are always sandboxed）：system.callSystem/BridgeTalk/Socket 即使经字符串拼接绕过本预检，运行时 shadow 也会以 System call disabled / BridgeTalk disabled / Socket disabled 拦截。app.scheduleTask 可在 shadow 恢复后延迟执行任意代码（时间窗绕过双层防线），禁止调用；脚本自带撤销组（beginUndoGroup/endUndoGroup）不再拦截——检测到即跳过框架外层包裹，撤销语义由脚本自负。File/Folder 实例的 execute()（启动任意可执行文件）一律拒绝；changePath()（真实例改指任意路径，敏感读取链一环）一律拒绝；Folder.getFiles()[ 立即索引形态拒绝——Folder.temp 等静态访问器与 getFiles 返回条目已包装为只读安全实例（写/删/改名/复制/执行拦截，读放行）。";
        }
        // undoName（热盒功能名，来自 hotbox 数据目录 JSON）可含换行等控制字符，
        // ES3 字符串字面量内裸换行会让整个拼接脚本 SyntaxError 拒执行——
        // 对齐 bootstrap.js createHandler 的清理：控制字符 → 空格，再转义反斜杠/引号
        // U+2028/U+2029 同为 ES3 行终止符（NTFS 文件名合法字符，hotbox 条目名
        // 来自脚本文件名/效果名，可含此类字符），\x00-\x1F 控制字符类覆盖不到，一并替换
        var sName = String(undoName || "")
            .replace(/[\x00-\x1F\x7F]/g, " ")
            .replace(/[\u2028\u2029]/g, " ")
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"');
        // 用户脚本自带撤销组 → 跳过框架外层包裹（用户导入脚本兼容）：AE 对嵌套
        // 撤销组不可靠（框架外层组 + 脚本内层组 → "Undo group mismatch"），检测到
        // 脚本自身 begin/endUndoGroup 即不叠加外层组，撤销语义由脚本自负。
        var _userOwnsUndo = /beginUndoGroup|endUndoGroup/i.test(String(scriptText));
        // scriptText 经转义器嵌入为字符串字面量——用户代码对拼接脚本是惰性
        // 数据（无法逃逸字面量改写外层沙箱结构），由 new Function 在运行时编译执行
        var sCode = __aelEscapeScript(scriptText);
        var s =
            '(function(_OF,_OD){\n' +
            'var __aelS=system.callSystem;\n' +
            'var __aelBT=typeof BridgeTalk!=="undefined"?BridgeTalk:null;\n' +
            'var __aelSK=typeof Socket!=="undefined"?Socket:null;\n' +
            'var __aelGF=(typeof $!=="undefined"&&$.global)?$.global.File:null;\n' +
            'var __aelGD=(typeof $!=="undefined"&&$.global)?$.global.Folder:null;\n' +
            'var __result;\n' +
            'try{\n' +
            __hotboxPreamble + '\n' +
            (sName && !_userOwnsUndo ? 'app.beginUndoGroup("AS_ExtP: ' + sName + '");try{' : '') +
            '(new Function("' + sCode + '"))();\n' +
            '__result="SUCCESS";\n' +
            (sName && !_userOwnsUndo ? '}finally{app.endUndoGroup();}' : '') +
            '}catch(e){__result="ERROR:"+e.toString();}\n' +
            // 恢复补 File=_OF/Folder=_OD——preamble 现在是全局赋值 shadow，
            // finally 必须还原全局构造器（原 var 局部 shadow 无需此项）
            // 恢复补 app.scheduleTask=__aelST——与 shadow 对称（__aelST 为
            // preamble 内 var 提升至 IIFE 作用域；preamble 未执行到赋值行时为
            // undefined，守卫跳过）
            // 恢复补原型方法——只还原构造器救不回被补丁的 prototype 方法，
            // 不还原则沙箱窗口结束后全引擎 File/Folder 危险方法永久残废（读写工具
            // 连锁失效）；__aelFO/__aelDO 为 preamble 内 var 提升至 IIFE 作用域
            'finally{File=_OF;Folder=_OD;if(__aelFO){__aelPT.open=__aelFO.open;__aelPT.remove=__aelFO.remove;__aelPT.rename=__aelFO.rename;__aelPT.copy=__aelFO.copy;__aelPT.execute=__aelFO.execute;__aelPT.changePath=__aelFO.changePath;}if(__aelDO){__aelDT.remove=__aelDO.remove;__aelDT.create=__aelDO.create;__aelDT.rename=__aelDO.rename;__aelDT.execute=__aelDO.execute;__aelDT.changePath=__aelDO.changePath;}system.callSystem=__aelS;if(typeof BridgeTalk!=="undefined"&&__aelBT)BridgeTalk=__aelBT;if(typeof Socket!=="undefined"&&__aelSK)Socket=__aelSK;if(__aelST)app.scheduleTask=__aelST;if(typeof $!=="undefined"&&$&&$.global){if(__aelGF)$.global.File=__aelGF;if(__aelGD)$.global.Folder=__aelGD;}else{$.writeln("[AE_LLM] WARNING: $.global unavailable — sandbox restore skipped");}}\n' +
            'return __result;\n' +
            '})(File,Folder);';
        return eval(s);
    } catch (e) {
        return "ERROR:" + e.toString();
    }
}
