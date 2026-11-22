(function (global) {
  // shader 模式工具集：submit_shader / get_current_shader / shader_library。
  // 设计参照 submit_script（校验闭环）：扩展只负责产出/保存 GLSL 到效果库，
  // AE 宿主由用户在选择器手动选中文件渲染（无 current.txt 提交即生效通道）。
  // 统一 scope module:shader（另含 external-mcp——外接面不变），
  // 经 toolExecutor + 权限闸门调用。
  // 效果库名（.glsl/.js 文件名）规则：允许 Unicode（中文名可用），与素材库
  // treeView.invalidNameSeg 同口径——禁控制符（含 0x7F，也保护 TAB 分隔的库索引格式）、
  // 引号、路径分隔符、Windows 文件名非法字符、尾随点/空格（Win32 落盘静默剥离会造成
  // 磁盘名与索引脱节）；内部空格/点号不拦。宿主侧扫描/加载/ECW 绘制全链路 UTF-8→宽字符
  //（effectState.cpp scanEffectsDir / glslLoader），面板 AEFS 写走 cep.fs/Bridge（JSON body）
  // 亦 Unicode 安全。与 shaderUI.js 的 validLibName 同一套规则，
  // 一致性由 shader-lib-name-pin 测试固定。
  var SHADER_NAME_ILLEGAL_RE = /[\u0000-\u001f\u007f"'\\/:*?<>|]/;
  function isValidShaderName(s) {
    s = String(s == null ? '' : s).trim();
    if (!s || s.length > 64) return false;
    if (SHADER_NAME_ILLEGAL_RE.test(s)) return false;
    var lastCh = s.charAt(s.length - 1);
    return lastCh !== '.' && lastCh !== ' ';
  }
  function sanitizeName(name) {
    var s = String(name || '').trim();
    return isValidShaderName(s) ? s : '';
  }
  function stripFences(code) {
    if (global.AEEffectLab && typeof global.AEEffectLab.stripFences === 'function') {
      return global.AEEffectLab.stripFences(code);
    }
    return String(code == null ? '' : code).trim();
  }
  // 围栏处理说明：局部编辑的围栏剥离统一走 engine/textEdits.js 的
  // fenceState/stripEditFences——只在整串被围栏包住（或只有开围栏）时剥（原 stripFencesSoft 按
  // 「首尾围栏之间」取内容，遇到正文中部的围栏会丢掉围栏外文本、静默缩小替换范围）。
  // 原地的 hasCodeFence/stripFencesSoft 已随之删除（无调用方，留着会诱导接回旧语义）。
  // 整份提交仍用 stripFences（文档级语义：取第一段围栏 + 整体 trim）。
  function countChar(s, ch) {
    var c = 0;
    for (var i = 0; i < s.length; i++) if (s[i] === ch) c++;
    return c;
  }
  // 按逻辑块拆分 GLSL：顶层语句/函数各成一段——头部 uniform/const/#define 单行自成一
  // 段，函数从签名行（含多行签名/大括号未闭合的行）到闭合大括号为一段。
  // 供 get_current_shader segments 查询，模型据此定位要修改的段（startLine/endLine）。
  function buildSegments(lines) {
    var segs = [];
    var n = lines.length;
    var i = 0;
    while (i < n) {
      if (lines[i].trim() === '') { i++; continue; }
      var brace = 0, paren = 0, end = -1;
      for (var j = i; j < n; j++) {
        brace += countChar(lines[j], '{') - countChar(lines[j], '}');
        paren += countChar(lines[j], '(') - countChar(lines[j], ')');
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

  // ── 代码读取查询：单一实现在 engine/codeQuery.js ──
  // 同类判据若在本文件与 script 侧（controller/scriptTools.js
  // 的 get_current_script）另有第二份平行拷贝——同一族判据两侧不同步的毛病历史上出现过多次。
  // 现三处消费点（get_current_shader / shader_library get / get_current_script）共用一份，
  // 差异走 opts（hash / name / buildSegments / subject）。
  // 惰性解析（与 previewSnapshot / textEdits 同款）：测试沙箱只装需要的那几个模块。
  // 模块缺席时**如实报 infra_error**，不退回整篇读取——静默退回正是这次要消掉的形态
  // （模型以为读的是它要的片段，回执却是一整篇）。
  function resolveCodeQuery() {
    var m = global.AEEngine && global.AEEngine.codeQuery;
    return (m && typeof m.validateCodeQueryArgs === 'function' && typeof m.runCodeQuery === 'function') ? m : null;
  }
  function codeQueryUnavailable() {
    return { success: false, result: JSON.stringify({ status: 'infra_error', message: '内部装配缺失（codeQuery 未加载）：代码读取查询不可用，请在 AE 中重新打开扩展面板后重试。' }) };
  }

  // 生成"按参数写入"的 ExtendScript。槽位可见行（分量0）的 .name 恒为空（行名由
  // 插件自绘），故 param-map 命中时用 propertyIndex；映射缺失时的按名兜底对槽位参数
  // 会得到 NO_PARAM——本函数当前无生产调用方（shader_params 内建工具按 propertyIndex
  // 读写），保留仅为兼容旧调用方。
  //
  // 优先用宿主 param-map 的 propertyIndex 寻址——
  // AE 的参数名是 cosmetic，可能停留在注册态旧名（脚本按名读到旧名、值是选中文件的）。
  // opts（可选）：{ shaderPath, shaderName, shaderSource }，用于在多实例/多文件里
  // 定位映射；缺省时只有"该 uniform 在全部映射里唯一指向同一槽位"才用索引。
  // 映射缺失/过期/有歧义 → 生成与纯按名寻址完全一致的脚本（行为兼容）。
  function buildSetParamScript(uniformName, value, opts) {
    var val = Number(value);
    var propName = JSON.stringify(String(uniformName || ''));
    var target = null;
    try { target = resolveParamMapTarget(uniformName, opts); } catch (_) { target = null; }
    var head = '(function(){try{' +
      'var c=app.project.activeItem;if(!c||!(c instanceof CompItem))return "NO_COMP";' +
      'var l=c.selectedLayers[0];if(!l)return "NO_LAYER";' +
      'var ef=l.property("ADBE Effect Parade");' +
      'for(var i=1;i<=ef.numProperties;i++){var p=ef.property(i);' +
      'if(p.matchName==="AS_Effect_Host"){';
    var findParam;
    if (target) {
      var propIdx = Math.round(Number(target.propertyIndex));
      if (target.libraryIndex != null && target.libraryIndex >= 0) {
        // 141 = kIdxFileIndexParam（宿主 params.h：GLSL 索引）。先核对实例当前
        // 文件索引：不一致说明映射属于另一个 shader（多实例/库位移）→ 按名兜底。
        findParam = 'var fi=p.property(141);' +
          'var sp=(fi&&Math.round(Number(fi.value))===' + Math.round(target.libraryIndex) + ')' +
          '?p.property(' + propIdx + '):p.property(' + propName + ');';
      } else {
        findParam = 'var sp=p.property(' + propIdx + ');';
      }
    } else {
      findParam = 'var sp=p.property(' + propName + ');';
    }
    return head + findParam +
      'if(!sp)return "NO_PARAM";sp.setValue(' + val + ');return "OK";}}' +
      'return "NO_EFFECT";' +
      '}catch(e){return "NO_EFFECT";}})()';
  }

  // ── 效果库索引：宿主内存列表（= ECW 选择器显示的那份）的读取 ──
  // AE 的效果参数没有字符串类型，文件名传不出插件；选择器是 ARBITRARY_DATA，
  // 脚本读不到其条目。故宿主在每次重扫（加效果 / 点 ↻）后把 popupChoices 导出到
  // effects/library-index.txt（native effectState.cpp writeLibraryIndexDump），
  // 本模块读它 —— 这是 LLM 得知"库里有哪几个文件、序号各是几"的唯一通道。
  // 序号即宿主列表的 0 基下标，与 shaderPathForIndex 的钳制口径一致；写
  // kIdxFileIndexParam 时只能用它，不能用磁盘现扫的顺序（宿主列表可能滞后于磁盘）。
  var LIB_INDEX_FILE = 'library-index.txt';

  // _stricmp 等价折算：宿主用 _stricmp 排序（UTF-8 字节按 C locale 折大小写，
  // 非 ASCII 字节不动）。JS 的 toLowerCase 会做 Unicode 折法，对含中文的文件名与
  // 宿主不一致 → 只折 A-Z，保持码元比较（UTF-8 下等价于字节序比较）。
  function asciiFold(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      out += (c >= 65 && c <= 90) ? String.fromCharCode(c + 32) : s.charAt(i);
    }
    return out;
  }
  function hostOrderCmp(a, b) {
    var fa = asciiFold(a), fb = asciiFold(b);
    if (fa < fb) return -1;
    if (fa > fb) return 1;
    return 0;
  }
  function stemOf(f) { return String(f).replace(/\.(glsl|js)$/i, ''); }

  // 内容哈希（FNV-1a 32 位 → 8 位十六进制）。用途单一：回答「两处文本是否同一版本」
  // （预览区 / 效果库 / shader_library get 回读），供 LLM 与工具自己比对，不做抗碰撞承诺、
  // 也不做安全用途。Math.imul 保证 32 位乘法无精度损失（面板与 Node 测试环境均可用）。
  function hashText(s) {
    var str = String(s == null ? '' : s);
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h = (h ^ str.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    var hex = h.toString(16);
    while (hex.length < 8) hex = '0' + hex;
    return hex;
  }

  // 内容等价哈希：不同读取通道（预览区 textarea / AEFS 读盘 / Bridge 往返）可能
  // 在 BOM、换行符、末尾空白上有差异；归一后再算 hash，内容等价即同一指纹。
  function _hashShaderText(s) {
    var str = String(s == null ? '' : s);
    str = str.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    return hashText(str);
  }

  // ── 宿主 param-map：uniform → propertyIndex ──
  // 背景：AE 的参数名是 cosmetic 字段，PF_UpdateParamUI 改的名字不随工程持久化，
  // 脚本侧读到的名字可能仍是注册态旧名（0500/0504/0508）。宿主在 shader 载入/切换
  // 后把「文件 → uniform → 参数索引」写到数据根的 param-map 目录（字段契约见 native
  // paramMap.cpp；路径常量在 shared/shaderParamMap.js，本文件不重复写）。
  // 解析已抽到 shared/shaderParamMap.js（与 ae-tools 内建工具 shader_params 共用一份实现，
  // 防两处各写一套寻址语义漂移）；本文件只保留 AEFS 读盘通道与装配注入。
  // 这里优先按索引寻址；映射缺失/过期/有歧义时回退按名寻址（旧行为，行为兼容）。
  var _paramMapAefs = null;          // 由 createShaderTools 注入（测试可只设 global.AEFS）
  var _paramMapEffectsDir = null;    // () => effects 目录（拼 shaderPath 用）

  function paramMapLib() {
    return global.AEShaderParamMap || null;
  }

  // 与宿主 FNV-1a 32 同算法（按 UTF-8 字节），用于判 param-map 是否过期。
  // 不用 hashText：后者按 UTF-16 码元哈希，含中文注释的 shader 两边结果不同。
  // 模块未装载（旧装配）时返回空串——调用方按「hash 不一致」处理，落回按名寻址。
  function hashUtf8(s) {
    var lib = paramMapLib();
    return lib ? lib.hashUtf8(s) : '';
  }

  function paramMapAefs() {
    return _paramMapAefs || global.AEFS || null;
  }

  function paramMapFilePath() {
    var lib = paramMapLib();
    if (!lib) return '';
    try {
      var dd = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
        ? global.AEShared.getDataDir() : null;
      var dir = dd && dd.dir;
      if (!dir) return '';
      return lib.paramMapPathFor(dir);
    } catch (_) { return ''; }
  }

  // 读并解析 param-map；任何失败（文件缺失/半截/版本不符/AEFS 缺席）返回 null。
  function readParamMapDoc() {
    var lib = paramMapLib();
    if (!lib) return null;
    var aefs = paramMapAefs();
    if (!aefs || typeof aefs.readFileSync !== 'function') return null;
    var p = paramMapFilePath();
    if (!p) return null;
    var text = null;
    try { text = aefs.readFileSync(p, { quietNotFound: true }); } catch (_) { return null; }
    if (!text) return null;
    return lib.parseParamMapDoc(text);
  }

  // 兼容包装（抽出 shared/shaderParamMap.js 后本文件的调用形态不变）：
  // 返回 { propertyIndex, libraryIndex, componentIndex, entry, uniform } 或 null
  // （null = 无映射/映射过期/同名 uniform 落在多个槽位无法判定实例 → 调用方按名寻址）。
  // 共享模块把歧义表达成 { ambiguous: [...] }，这里折回 null——buildSetParamScript 的
  // 回退语义是「拿不到唯一目标就按名写」，不能改成把候选拼进脚本。
  function resolveParamMapTarget(uniformName, opts) {
    opts = opts || {};
    var lib = paramMapLib();
    if (!lib) return null;
    var doc = readParamMapDoc();
    if (!doc) return null;

    // 线索路径：显式 shaderPath 优先；只有文件名时经 effectsDir 拼成完整路径（与抽出前一致）。
    var hintPath = '';
    if (opts.shaderPath) {
      hintPath = String(opts.shaderPath);
    } else if (opts.shaderName && typeof _paramMapEffectsDir === 'function') {
      try {
        var dir = _paramMapEffectsDir();
        if (dir) hintPath = String(dir) + '\\' + String(opts.shaderName) + '.glsl';
      } catch (_) {}
    }
    var aefs = paramMapAefs();
    var r = lib.resolveParamMapTarget(doc, {
      uniformName: uniformName,
      shaderPath: hintPath,
      // 与抽出前逐字一致：每条候选各自读 entry.shaderPath 的真实内容判过期（读不到 = 保留映射）；
      // 调用方显式给了 shaderSource 时一律用它（预览区现成文本 / 测试）。
      shaderSource: function (entry) {
        if (typeof opts.shaderSource === 'string') return opts.shaderSource;
        if (!aefs || typeof aefs.readFileSync !== 'function' || !entry || !entry.shaderPath) return null;
        try { return aefs.readFileSync(entry.shaderPath, { quietNotFound: true }); } catch (_) { return null; }
      }
    });
    if (!r || r.ambiguous) return null;
    return r;
  }

  // 解析导出的库索引文本。头部三行以 '#' 开头，数据行为 "<0基序号>\t<名>"。
  // 返回 null = 文件不存在/不可读（宿主尚未导出）；list 为空数组是合法状态（空库）。
  function parseLibraryIndex(text) {
    if (!text) return null;
    var lines = String(text).split(/\r?\n/);
    var list = [], names = [], generated = '', declared = -1;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln) continue;
      if (ln.charAt(0) === '#') {
        var mg = /^#\s*generated:\s*(.+?)\s*$/.exec(ln);
        if (mg) generated = mg[1];
        var mc = /^#\s*count:\s*(\d+)\s*$/.exec(ln);
        if (mc) declared = parseInt(mc[1], 10);
        continue;
      }
      var tab = ln.indexOf('\t');
      if (tab <= 0) continue;
      var idxStr = ln.substring(0, tab);
      if (!/^\d+$/.test(idxStr)) continue;
      var nm = ln.substring(tab + 1);
      if (!nm) continue;
      list.push({ index: parseInt(idxStr, 10), name: nm });
      names.push(nm);
    }
    return { list: list, names: names, generated: generated, declaredCount: declared };
  }

  // 宿主列表 vs 磁盘现状的集合差：notInHost = 磁盘新增但宿主还没扫到（此时该文件
  // 尚无有效序号，需 ↻ 或重加效果）；notOnDisk = 宿主列表里已被删掉的文件。
  // 只比集合不比顺序：宿主 std::sort 对"仅大小写不同"的同名项顺序不定，比顺序会误报。
  function diffLibraryNames(hostNames, diskNames) {
    var hs = {}, ds = {};
    var i;
    for (i = 0; i < hostNames.length; i++) hs[asciiFold(hostNames[i])] = hostNames[i];
    for (i = 0; i < diskNames.length; i++) ds[asciiFold(diskNames[i])] = diskNames[i];
    var notInHost = [], notOnDisk = [];
    for (var k in ds) { if (!hs[k]) notInHost.push(ds[k]); }
    for (var m in hs) { if (!ds[m]) notOnDisk.push(hs[m]); }
    notInHost.sort(hostOrderCmp);
    notOnDisk.sort(hostOrderCmp);
    return { notInHost: notInHost, notOnDisk: notOnDisk };
  }

  // 截取 shader 预览 canvas 当前帧为 JPEG data URL。
  // 由 getShaderPreview 工具调用，结果经 vision hook 直接注入 LLM（不经文件 I/O）。
  // 返回 null 表示 canvas 不可用（非 shader 模式 / 预览未启动 / 无 WebGL 上下文）。
  function captureShaderPreview() {
    if (typeof document === 'undefined') return null;
    var canvas = document.getElementById('shaderPreviewCanvas');
    if (!canvas) return null;
    var w = canvas.width, h = canvas.height;
    if (!w || !h) return null;
    try {
      return canvas.toDataURL('image/jpeg', 0.9);
    } catch (_) {
      return null;
    }
  }

  // getShaderPreview 的多时间点参数（与 getPreviewFrame 的 timesInSeconds 同口径）：
  // 1–6 个有限秒数，负值钳到 0。返回 { times, timeClamped } 或 { error }。
  var SHADER_PREVIEW_MAX_TIMES = 6;
  function normalizePreviewTimes(raw) {
    if (!raw || Object.prototype.toString.call(raw) !== '[object Array]' || raw.length === 0) {
      return { error: 'timesInSeconds 需为 1–' + SHADER_PREVIEW_MAX_TIMES + ' 个有限秒数（数组，如 [0, 0.5, 1.0]）' };
    }
    if (raw.length > SHADER_PREVIEW_MAX_TIMES) {
      return { error: '最多 ' + SHADER_PREVIEW_MAX_TIMES + ' 个时间点（收到 ' + raw.length + ' 个）：拆成两次调用，或减少采样点。' };
    }
    var times = [];
    var clamped = false;
    for (var i = 0; i < raw.length; i++) {
      var t = Number(raw[i]);
      if (!isFinite(t)) {
        return { error: 'timesInSeconds 第 ' + (i + 1) + ' 项不是有限数：' + raw[i] };
      }
      if (t < 0) { t = 0; clamped = true; }
      times.push(t);
    }
    return { times: times, timeClamped: clamped };
  }

  // 联系表时间标签：与预览联系表同源（AEPreviewSheet.formatTimeLabel）；
  // 模块缺席时退回同一格式，标签不能没有。
  function previewTimeLabel(sec) {
    var sheet = global.AEPreviewSheet;
    if (sheet && typeof sheet.formatTimeLabel === 'function') return sheet.formatTimeLabel(sec);
    return Number(sec).toFixed(2) + 's';
  }

  // Blob → data URL：联系表合成只回传 blob（旧版 AEPreviewSheet 无 canvas）时的兜底通道。
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      if (!blob || typeof global.FileReader !== 'function') { reject(new Error('联系表导出失败')); return; }
      var fr = new global.FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('联系表读取失败')); };
      fr.readAsDataURL(blob);
    });
  }

  function createShaderTools(deps) {
    deps = deps || {};
    var registry = deps.toolRegistry;
    var aefs = deps.aefs || global.AEFS;
    var effectsDir = deps.effectsDir;         // () => effects 目录绝对路径
    // buildSetParamScript 是模块级函数（拿不到 deps）：param-map 读取通道由最近
    // 一次装配注入，测试/旧装配下回落 global.AEFS（与组装前行为一致）。
    _paramMapAefs = aefs || null;
    if (typeof effectsDir === 'function') _paramMapEffectsDir = effectsDir;
    var compileCheck = deps.compileCheck;      // (src) => { ok, error? }  GLSL 编译校验（同步）
    var compileCheckAsync = deps.compileCheckAsync; // (src) => Promise<{ok, error?}> 异步编译校验（不阻塞主线程）
    var onShaderReady = deps.onShaderReady;    // (code) => 写右预览区
    var getCurrentShader = deps.getCurrentShader; // () => 预览区当前内容
    var getStopRequested = deps.getStopRequested;               // () => bool（用户已点停止）
    var getActiveAbortController = deps.getActiveAbortController; // () => { signal } | null
    if (!registry || !aefs || typeof effectsDir !== 'function') return { register: function () {} };

    // 用户已点「停止」/ 当前轮已 abort：异步窗口（编译校验、JS 执行）结束后不得再写入。
    // script 侧 submit_script 有同款复查（scriptTools.js 入口与写前各一次），shader 侧
    // 也必须复查：否则停止后预览区与效果库仍被写入，而 LLM 拿到的是 stopped。
    // 缺注入（旧装配/测试沙箱）时按"未停止"处理。
    // 修复（真机「团队→shader 后 submit_shader 恒 stopped」的根因）：判据为
    // **执行侧优先**——execCtx 里带的是本次调用所属 runtime 的实时停止态（toolExecutionPipeline
    // 随调用下发、toolExecutor 抄进 handler 第二参）。工具注册表只有一份且 last-wins ⇒ 本
    // handler 可能是另一条 runtime（团队 lane / 子 Agent）注册的那一份，它闭包里的 getter
    // 不是本次执行者的；只认闭包状态会把「那条 runtime 早已停止」误当成本次被停止。
    // ctx 缺判据（旧装配/测试直调）时回落注入的 getter，行为与接入前一致。
    function stopRequested(execCtx) {
      try {
        if (typeof getStopRequested === 'function' && getStopRequested(execCtx)) return true;
        var ac = typeof getActiveAbortController === 'function' ? getActiveAbortController(execCtx) : null;
        return !!(ac && ac.signal && ac.signal.aborted);
      } catch (_) { return false; }
    }
    function stoppedResult() {
      return { success: false, result: JSON.stringify({ status: 'stopped', message: '已停止。' }) };
    }
    // 写入 GLSL 预览区：onShaderReady 透传 service.js 的落点回执，返回 false = 目标编辑区
    // 缺失（写入没落到 #shaderCodePreview）→ 该报错就不能报"已写入"。
    function writeShaderPreview(code) {
      if (typeof onShaderReady !== 'function') return null;   // 旧装配无写入回调：不裁决
      return onShaderReady(code) === false ? false : true;
    }
    function writeFailedResult() {
      return { success: false, result: JSON.stringify({ status: 'error', message: '写入预览区失败：写入入口未接受本次写入（GLSL 编辑区缺失、装配未接线，或当前运行身份没有预览区写入通道——如团队子 Agent）。本次未交付——请先重开扩展面板后重试；若当前是团队子 Agent，请把产出交回上级 Agent 再提交。' }) };
    }

    // ── 写前快照守卫（陈旧读→写拦截）──
    // 语义与生命周期见 engine/previewSnapshot.js 头注：get_current_shader 读到即留快照，
    // submit_shader / submit_js_effect 落笔前比对当前预览区——不一致（用户在读取后手改/
    // 他处写入）即拒绝写入并回喂「重新读取」指引，防按旧内容局部合并或整份覆盖掉用户
    // 改动。快照按调用方分账（面板内 vs 外接客户端），别人写完不顶替本调用方的读账——
    // 面板内的写入照样拦。store 缺席（旧装配/测试沙箱未载 previewSnapshot.js）时守卫
    // 缺席，行为同接入前。
    var PREVIEW_AREA = 'shader';
    var STALE_PREVIEW_MESSAGE = '预览区内容在最近一次读取之后已被修改（用户手动编辑，或由其他调用方写入），'
      + '为避免按旧内容写入覆盖这些改动，本次提交已被拒绝、未写入。'
      + '请先调用 get_current_shader 重新读取预览区最新内容，确认后再基于最新内容重新提交。';
    var READ_REQUIRED_MESSAGE = '预览区已有内容，但你尚未读取过它。'
      + '为避免在不知情的情况下覆盖现有代码，本次提交已被拒绝、未写入。'
      + '请先调用 get_current_shader 读取预览区当前内容，确认后再提交。';
    // 空预览区不再放行（「写前必读，就算是首次提交也要」）：
    // 面板重载会回填草稿，空与否以读取结果为准；空读同样留账，读一次即解
    var READ_REQUIRED_EMPTY_MESSAGE = '预览区当前为空，但你尚未读取过它。'
      + '按"写前必读"规则，每次提交（含首次生成）前都要先读取一次预览区'
      + '（面板重载可能回填草稿，空与否须以读取结果为准）。'
      + '本次提交已被拒绝、未写入。请先调用 get_current_shader 读取，再提交。';
    // 本实例所属 lane（团队模式）：每 lane 一个 controller ⇒ 每 lane 一份
    // shaderTools，lane 由 controller 装配时注入。两种命名（laneId / laneKey）的字符串或 getter
    // 形态都接受——controller 侧现有的 getLaneId() / getLaneKey() 两个名字都能直接接上。
    // 取不到（单 Agent 路径）⇒ 空串 ⇒ 缺省 lane，读写落缺省槽，行为与分槽前逐字节一致。
    function previewLane() {
      var cands = [deps.laneId, deps.laneKey,
        deps.lane && deps.lane.id, deps.lane && deps.lane.laneKey,
        deps.getLaneId, deps.getLaneKey];
      for (var i = 0; i < cands.length; i++) {
        var v = cands[i];
        if (typeof v === 'function') { try { v = v(); } catch (_) { continue; } }
        if (typeof v === 'string' && v) return v;
      }
      return '';
    }
    // 预览区账本解析（**唯一的 previewSnapshot 回退点**，按 lane 参数化）：
    //   ① 注入的 store（测试/旧装配）优先；② 否则全局单例（engine/previewSnapshot.js）。
    // 两者都按 lane 取视图（store.forLane(lane)）：只做槽位与会话指针的分槽，
    // 账本仍是同一份单例——同一 lane 的读写命中同一账本，不同 lane 各记自己的账；
    // 单 Agent 路径 lane 为空 ⇒ 原样返回 store，零包装、零行为变化。
    // state（= previewWriter 的返回）带执行侧 lane 时以它为准（同类 last-wins 收口）：
    // 账本槽位必须跟**执行者**走，不能跟「注册表里 handler 的注册者」走——否则 handler 换了
    // 归属者（团队 lane / 子 Agent 后注册）时读写落在不同槽，检出假「没读过/已被改」。
    function snapshotStore(state) {
      var injected = (deps.previewSnapshot && typeof deps.previewSnapshot.check === 'function') ? deps.previewSnapshot : null;
      var store = injected || ((global.AEEngine && global.AEEngine.previewSnapshot) || null);
      var lane = (state && typeof state.lane === 'string') ? state.lane : previewLane();
      if (store && lane && typeof store.forLane === 'function') return store.forLane(lane);
      return store;
    }
    // 内容锚定编辑库（engine/textEdits.js）：局部编辑的唯一实现，与 script 侧
    // submit_script 共用同一份（匹配语义属正确性核心，不允许双实现漂移）。缺席
    // （旧装配 / 遗留沙箱未载该文件）时局部编辑报 infra_error 并指引整份提交。
    function textEditLib() {
      return (global.AEEngine && global.AEEngine.textEdits) || null;
    }
    // 行数口径（与读取侧同款：空内容 0 行、尾随换行计入）。回执要用它，但不能因
    // textEdits 缺席就炸——故带等价内联兜底（此处兜底的是"数行"，不是匹配语义）。
    function countLinesSafe(text) {
      var te = textEditLib();
      if (te && typeof te.countLines === 'function') return te.countLines(text);
      var s = String(text == null ? '' : text);
      return s ? s.split('\n').length : 0;
    }
    // 行号定位已移除：局部编辑一律内容锚定（见
    // engine/textEdits.js 头注）。传 startLine/endLine 的陈旧调用必须显式拒绝——
    // 若静默按整份提交处理，只想改一处的调用会变成整份覆盖。
    var LEGACY_LINE_EDIT_MESSAGE = 'startLine/endLine 局部编辑已移除（行号会随内容规整与模型计数漂移而改错行，且改错得静默）。'
      + '局部编辑请改用内容锚定：oldText（要替换的原文，须与预览区当前内容逐字符一致、且在其中唯一）+ newText（替换文本，空串=删除）；'
      + '多段一次改完用 edits:[{oldText,newText}, ...]。整份提交不传 oldText/edits。本次未写入预览区。';
    // 调用方身份（toolExecutor 透传的执行上下文）：面板内为空串＝'panel' 账；
    // 外接 dispatch 传 'ext:<clientId>'，各自记账互不顶替。
    // 同类 last-wins 收口：返回 {callerId, lane} —— lane 取**执行者**的
    // execLane（单 Agent 为空串；旧装配/外接无该键时为 null ⇒ 回落本实例的 previewLane()）。
    function previewWriter(execCtx) {
      return {
        callerId: String((execCtx && execCtx.callerId) || ''),
        lane: (execCtx && typeof execCtx.execLane === 'string') ? execCtx.execLane : null
      };
    }
    function currentShaderText() {
      return (typeof getCurrentShader === 'function') ? String(getCurrentShader() || '') : '';
    }
    // 陈旧则返回回喂 LLM 的拒绝结果，可写则返回 null
    function stalePreviewRejection(state) {
      var store = snapshotStore(state);
      if (!store) return null;
      var r;
      try { r = store.check(PREVIEW_AREA, currentShaderText(), (state && state.callerId) || ''); } catch (_) { return null; }
      if (!r || r.ok) return null;
      if (r.code === 'READ_REQUIRED') {
        return {
          success: false,
          result: JSON.stringify({
            status: 'read_required',
            message: r.currentEmpty ? READ_REQUIRED_EMPTY_MESSAGE : READ_REQUIRED_MESSAGE,
            currentHash: r.currentHash,
            currentLines: r.currentLines
          })
        };
      }
      return {
        success: false,
        result: JSON.stringify({
          status: 'stale_preview',
          message: STALE_PREVIEW_MESSAGE,
          readHash: r.readHash,
          currentHash: r.currentHash,
          currentLines: r.currentLines
        })
      };
    }
    // 读取留存 / 写入后刷新。shader 侧写入不过转译管线，读回值与写入值一致，
    // 仍统一读回取值（与 script 侧同口径，也覆盖写入回调另有加工的情况）。
    // writer 形参是 previewWriter 的返回（{callerId, lane}），账本槽位取执行侧 lane。
    function recordPreviewRead(state) {
      var store = snapshotStore(state);
      if (store) { try { store.recordRead(PREVIEW_AREA, currentShaderText(), (state && state.callerId) || ''); } catch (_) {} }
    }
    function recordPreviewWrite(state) {
      var store = snapshotStore(state);
      if (store) { try { store.recordWrite(PREVIEW_AREA, currentShaderText(), (state && state.callerId) || ''); } catch (_) {} }
    }

    function checkDir() {
      var dir = effectsDir();
      return dir ? dir : '';
    }

    // 读取宿主导出的库索引（见文件上方 LIB_INDEX_FILE 说明）。不可读/未导出 → null。
    function readLibraryIndex(dir) {
      if (!aefs.readFile) return Promise.resolve(null);
      return Promise.resolve(aefs.readFile(dir + '\\' + LIB_INDEX_FILE)).then(function (txt) {
        return parseLibraryIndex(txt);
      }).catch(function () { return null; });
    }

    // 磁盘 `.glsl` 名单按宿主同款比较器排序（diskOrder 的唯一口径，list 与 save 共用）
    function sortedDiskGlsl(files) {
      var glsl = [];
      var list = files || [];
      for (var i = 0; i < list.length; i++) {
        if (/\.glsl$/i.test(list[i])) glsl.push(stemOf(list[i]));
      }
      glsl.sort(hostOrderCmp);
      return glsl;
    }

    // 名字 → 磁盘序 0 基序号（未命中 -1；listFiles 不可用/异常同样 -1）。
    // 与 list 的 diskOrder 同一算法，避免两处各排一次序得到不同结果。
    function diskIndexOfName(dir, name) {
      if (!aefs.listFiles) return Promise.resolve(-1);
      return aefs.listFiles(dir).then(function (files) {
        var glsl = sortedDiskGlsl(files);
        var fold = asciiFold(name);
        for (var i = 0; i < glsl.length; i++) {
          if (asciiFold(glsl[i]) === fold) return i;
        }
        return -1;
      }).catch(function () { return -1; });
    }

    // 用法诊断的公共拼装：诊断源都挂在 AEEffectLab 上、都
    // 返回告警字符串数组，回执格式统一为「 ⚠ a；b。」。函数缺失（旧装配/测试沙箱不注入）
    // 或抛错一律静默跳过——诊断是附加信息，绝不能把提交路径带崩。
    function diagnosticsNote(code, fns) {
      var L = global.AEEffectLab;
      if (!L) return '';
      var ws = [];
      for (var i = 0; i < fns.length; i++) {
        if (typeof L[fns[i]] !== 'function') continue;
        try { ws = ws.concat(L[fns[i]](code) || []); } catch (_) {}
      }
      if (!ws.length) return '';
      return ' ⚠ ' + ws.join('；') + '。';
    }
    // 提交回执用的全部用法诊断（单一调用点，三条写入通路都走它）：
    // - 采样器用法：面板轮对"采样了却没声明 iChannelN""自造
    //    sampler 名"完全静默（宿主只写 AE 侧 error.log）→ 判据在 uniformParser.samplerUsageWarnings
    //    （单一实现，与宿主同口径）；
    // - 迭代/结算指令：`@solve: 8` 这类形态不被识别、超限被钳制、@solve 缺 iterateImage
    //    —— 判据在 glslValidator.iterDirectiveWarnings；
    // - 声明形态：不支持的 uniform 类型 / 数组口径分歧 / 灯光数组常量下标
    //    —— 判据在 uniformParser.declUsageWarnings；
    //  - 参数数量：按宿主槽位口径超过 32（float 数组按元素展开）——第 33 个起
    //    不注册、值恒为 GL 默认 0，宿主只写 error.log、面板侧同样静默
    //    —— 判据在 uniformParser.uniformLimitWarnings。
    // 四者共同的形态是"违反契约但面板与宿主**都不报错**"——只有这条回执能把它们变成模型可自判的信号。
    // （收拢：原 samplerUsageNote 已并入本函数，无独立调用方，避免留一条诱导接回旧语义的入口）
    function usageNote(code) {
      return diagnosticsNote(code, ['iterDirectiveWarnings', 'samplerUsageWarnings', 'declUsageWarnings', 'uniformLimitWarnings']);
    }

    // 主线程不阻塞——同步 compileCheck 查询 COMPILE_STATUS 时会卡住扩展 UI，是 LLM
    // 提交 shader 卡顿的主因）；未注入异步通道（测试沙箱/旧装配）时退回同步 compileCheck。
    function checkShaderAsync(code) {
      if (typeof compileCheckAsync === 'function') {
        return Promise.resolve(compileCheckAsync(code));
      }
      return Promise.resolve(compileCheck ? compileCheck(code) : { ok: true });
    }

    // 等待预览编译 settle（getShaderPreview 截图前调用）：异步编译（KHR_parallel_shader_compile）
    // pending 期间 canvas 仍是上一次的画面（换装策略为"旧 program 继续渲染"，首次加载则为空帧），
    // 直接截图会把旧效果当新 shader 的结果喂给视觉模型（如误判"效果没生效/画面全黑"）。
    // 轮询渲染器状态至非 pending（40ms 间隔，上限 3s），settle 后再等约两帧让 rAF 画出新画面。
    // 渲染器不可读（未进 shader 模式/模块未挂载/实例未提供 getPreviewStatus）时立即返回 unknown——截图逻辑照旧。
    function waitForPreviewSettle() {
      return new Promise(function (resolve) {
        var su = global.AEShaderUIInstance;
        if (!su || typeof su.getPreviewStatus !== 'function') { resolve({ compileState: 'unknown' }); return; }
        var waited = 0;
        (function poll() {
          var st = su.getPreviewStatus();
          if (!st || !st.pending) {
            setTimeout(function () {
              resolve({ compileState: !st ? 'unknown' : (st.ok ? 'ok' : (st.skip ? 'skip' : 'error')) });
            }, 50);
            return;
          }
          if (waited >= 3000) { resolve({ compileState: 'pending' }); return; }
          waited += 40;
          setTimeout(poll, 40);
        })();
      });
    }

    // ── submit_shader 描述：契约单一内容源 + 分读者（提示词清洗后收敛外接面）──

    // 契约正文只住 client/shared/glslApiReference.txt；本文不内嵌任何契约正文。
    //   · 面板 shader 轮：系统提示词已注入契约**核心与能力索引**（详版按
    //     当前代码用到的特性附上，其余按需经 shader_contract 工具拉），描述只给指针避免同注入双份。
    //   · 外接（external-mcp）：无系统提示词 → 描述给"最少必要事实 + 去 guide 取契约"的指路，
    //     完整契约与分节都走 guide('shader') / guide('shader:<节名>')。
    //   外接描述里内嵌一份手抄压缩契约有两个问题：一是与
    //   全量契约双维护（本会话循环检查里两份各改一遍，已见漂移），二是客户端对工具描述有
    //   **2048 字符静默截断**，那份 7.5k 文本的后半段（迭代/结算/历史/参数）从来送不到，
    //   等于把契约留在了一个读者拿不到的地方。现在描述只带 ≤2048 的要点，全文走 guide。
    var SUBMIT_SHADER_BASE = '提交 GLSL 片元着色器源码到预览区（Shader 模式输出代码的唯一方式）；'
      + '面板编译校验（GLSL 330 core，ES100 语法不可用），通过写入预览区，失败回错误供修正重提。';
    var SUBMIT_SHADER_TAIL = '支持整份提交或内容锚定局部编辑（oldText/newText，多处用 edits[]，语义见参数说明；行号只用于读取与沟通，不作定位依据）。';
    // 外接描述里的"最少必要事实"：这几条是**首用就会踩**的（面板侧有系统提示词兜，外接没有）
    // ——入口签名、内置禁重声明、映射图层必须自己声明、uniform 白名单、两条预览口径
    // （避免把预览的假象当 bug 修）。其余细节一律走 guide，不在描述里复述。
    var SUBMIT_SHADER_EXT_ESSENTIALS = '最少必要：入口 vec4 mainImage(vec2 fragCoord, float time)'
      + '（fragCoord 为 0~1 UV、左下角原点 y 向上）；内置 iChannel0/uTime/uResolution/uAspect/'
      + 'uLayerSize 等**一律禁止重声明**（唯一例外：映射图层 iChannel1/2/3 必须自己写 '
      + '`uniform sampler2D iChannel1;` 那一行才有输入）；自定义 uniform 只支持 '
      + 'float/vec2/vec3/vec4（≤32 个，行尾 // @range 设范围）；面板预览里 iChannel1/2/3 恒透明黑、'
      + 'iHistory0..3 恒等于 iChannel0 那张输入图——预览不反映它们是否生效。';
    // 契约切分模块是否就绪（装配异常时外接侧如实报缺，不指向一个必然失败的 guide）
    function _contractSourceReady() {
      return !!(global.AEGlslContractTopics
        && typeof global.AEGlslContractTopics.splitSections === 'function');
    }
    function _submitShaderDescription(moduleId) {
      if (moduleId === 'shader') {
        return SUBMIT_SHADER_BASE + '代码契约见系统提示词「AS_ExtP GLSL 契约」节。' + SUBMIT_SHADER_TAIL;
      }
      // 外接分支：指路句**放最前**。外接客户端对工具描述有
      // 2048 字符静默截断（截断无日志、UI 仍显示全文），
      // 放最前 = 任何截断形态下都可见。用双引号字符串：源码层面保留原文 guide('shader')
      // （便于源码检索）。
      if (!_contractSourceReady()) {
        return SUBMIT_SHADER_BASE
          + '（本次会话完整契约不可用：契约切分模块未加载——如实报缺，不指向必然失败的取用入口）'
          + SUBMIT_SHADER_EXT_ESSENTIALS + SUBMIT_SHADER_TAIL;
      }
      return SUBMIT_SHADER_BASE + "完整契约先调 guide('shader')（核心 + 能力索引）；"
        + "用到可选特性按索引里的节名取节：guide('shader:layers')=映射图层 iChannel1/2/3、"
        + "guide('shader:solve')=结算器、guide('shader:iter')=帧内迭代趟、"
        + "guide('shader:history')=输入历史、guide('shader:camera')／guide('shader:lights')="
        + '相机与灯光内置。'
        + SUBMIT_SHADER_EXT_ESSENTIALS + SUBMIT_SHADER_TAIL;
    }

    // ── submit_js_effect 描述：分读者 ──
    // 静态串（moduleId 非 external-mcp）与基线逐字节一致；指路句只在 moduleId===
    // 'external-mcp' 时追加。若把指路句直接拼进静态 description，面板 shader 轮
    // 取不到 buildDescription 时用的就是该静态串（从 1088B 增至 1132B，
    // 面板模型被指向它轮次里不存在的 guide——guide scope 限 external-mcp）。
    // 双引号字符串同上：源码保留原文 guide('shader')。
    var JS_EFFECT_BASE = '提交 JS 效果代码（须实现 buildShader(params) 返回 GLSL 字符串）。面板执行后校验产出的 GLSL（GLSL 330 core），通过写入预览区、失败回错误。仅用于需 JS 编排（动态拼接/数学计算/循环生成）的效果；纯 GLSL 能表达的用 submit_shader，勿套 JS。传 name 归档 JS 源码到效果库，可用 shader_library get type=js 读回迭代（归档与来源注释细节见参数说明）。JS 契约：buildShader 纯函数，只用 params 与 JS 内置（Math/JSON/Number/String/Array/Object），不引用闭包外作用域；params 字段须兜底（如 Number(p.bands) || 4），缺省拼 undefined 进 GLSL 编译失败；产出的 GLSL 须符合 submit_shader 的 GLSL 契约（mainImage 入口/内置变量/uAspect 校正/纯函数式；迭代类效果可另定义 iterateImage，见契约「迭代趟」节）；代码经静态预检，文件读写/网络/命令执行类调用被拒。错误恢复：JS 语法错误/buildShader 缺失/返回非字符串或空 → status=failed，message 含具体错误；GLSL 编译失败 → error 含编译错误，glsl 字段回传产出代码供调试。';
    var SUBMIT_JS_EFFECT_POINTER = "契约细节可用 guide('shader') 获取。";
    function _submitJsEffectDescription(moduleId) {
      return JS_EFFECT_BASE + (moduleId === 'external-mcp' ? SUBMIT_JS_EFFECT_POINTER : '');
    }

    return {
      register: function () {
        registry.register({
          name: 'submit_shader',
          description: _submitShaderDescription(""),
          buildDescription: _submitShaderDescription,
          input_schema: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'GLSL 源码。整份提交时须完整实现 vec4 mainImage(vec2 fragCoord, float time)，uniform 仅 float/vec2/vec3/vec4，≤32 个；用 oldText/edits 局部编辑时不需要传' },
              message: { type: 'string', description: '给用户的说明（可选）' },
              oldText: { type: 'string', description: '局部编辑：要替换的原文，须与预览区当前内容逐字符一致（含缩进与空行）且在其中唯一；先用 get_current_shader 读回原文再原样复制。不传则整份提交；读回内容每行开头的 "N: " 是行号标注、不属于代码，复制时去掉' },
              newText: { type: 'string', description: '局部编辑：替换文本；空串表示删除 oldText 命中的整段' },
              edits: { type: 'array', items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' } } }, description: '局部编辑（1-20 处，按序应用）：与顶层 oldText/newText 互斥' }
            },
            required: []
          },
          handler: function (args, execCtx) {
            args = args || {};
            var writer = previewWriter(execCtx);
            // 陈旧行号调用显式拒绝（早于守卫：这是参数形态错误，不该先答"陈旧读"）。
            // 判「参数存在」而非 typeof==='number'：字符串
            // "3"/null/true/数组/对象形态若不拦，会落进「无 oldText/edits → 整份提交」
            // 分支，把只想改一处的调用变成整份覆盖（实测预览区被整体替换）。
            if (stopRequested(execCtx)) return Promise.resolve(stoppedResult());
            if (args.startLine !== undefined || args.endLine !== undefined) {
              return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', message: LEGACY_LINE_EDIT_MESSAGE }) });
            }
            // 写前快照守卫（早拦）：预览区在读取后被改过 → 直接拒绝，不进编译校验
            var staleEarly = stalePreviewRejection(writer);
            if (staleEarly) return staleEarly;
            var te2 = textEditLib();
            // 装配缺失 + 调用带编辑参数：报 infra_error——静默按整份提交处理会让带
            // oldText 的调用变成整份覆盖（与 startLine 陈旧调用同一条红线）
            if (!te2 && (args.oldText != null || args.newText != null || args.edits != null)) {
              return Promise.resolve({ success: false, result: JSON.stringify({ status: 'infra_error', message: '内部装配缺失（textEdits 未加载）：局部编辑不可用，请改用整份提交，或在 AE 中重新打开扩展面板后重试。' }) });
            }
            var req2 = te2 ? te2.parseRequest(args, 'code') : { mode: 'full' };
            if (req2.error) {
              return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', message: req2.error.message }) });
            }
            var rawCode = String(args.code == null ? '' : args.code);
            var isEdit = req2.mode === 'edit';
            // 编辑文本的围栏处理：只在整串被围栏包住（或只有开围栏，模型漏写收尾）时剥——
            // 中部围栏是正文，按 stripFencesSoft 取「首尾围栏之间」会丢掉围栏外内容、
            // 静默缩小替换范围。newText 与 oldText 同款。
            function refineEditText(t) {
              var s = String(t == null ? '' : t);
              return te2 ? te2.stripEditFences(s) : s;
            }
            if (!isEdit) {
              // 整份提交：始终 stripFences（剥离围栏 + trim，保持原行为）；代码必填非空
              var code = stripFences(rawCode);
              if (!code.trim()) {
                return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', code: 'EMPTY_CODE', message: '代码为空，无法提交。' }) });
              }
              return checkShaderAsync(code).then(function (ck) {
                if (ck && ck.ok === false) {
                  return { success: false, result: JSON.stringify({ status: 'failed', message: '编译校验失败，请修正后重新提交。', error: ck.error || '' }) };
                }
                // 停止复查：编译校验是异步窗口，期间用户可能已点停止
                // （不复查则停止后仍写入，LLM 却拿到 stopped）
                if (stopRequested(execCtx)) return stoppedResult();
                // 二次守卫：堵住编译校验（异步窗口）期间预览区的改动
                var staleLate = stalePreviewRejection(writer);
                if (staleLate) return staleLate;
                if (writeShaderPreview(code) === false) return writeFailedResult();
                recordPreviewWrite(writer);
                // hash：本次写入预览区的版本指纹，与 shader_library get/save 返回的 hash 比对
                // 即可确认"库里/预览区是不是同一版"；totalLines 给出写入后的坐标系
                // （回执不能只有 ok——模型想知道自己写成多少行只能靠数，正是数错行的来源）
                return { success: true, result: JSON.stringify({ status: 'passed', message: '编译校验通过，已写入预览区（共 ' + countLinesSafe(code) + ' 行）。' + usageNote(code), hash: _hashShaderText(code), totalLines: countLinesSafe(code) }) };
              });
            }
            // 局部编辑（内容锚定）：按 oldText 唯一命中做替换/删除（newText
            // 空串即删除），合并后整体编译校验再写回
            var current = currentShaderText();
            if (!current.trim()) {
              return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', message: '预览区为空，无法局部编辑。请先整份提交一次 submit_shader。' }) });
            }
            var editList2 = [];
            for (var ej = 0; ej < req2.edits.length; ej++) {
              var _rawNew2 = req2.edits[ej].newText == null ? '' : String(req2.edits[ej].newText);
              // newText 剥围栏后为纯空白 = 删除，判据取剥壳后的文本（与 script 侧删除口径一致）
              var _refinedNew2 = refineEditText(_rawNew2);
              editList2.push({
                oldText: req2.edits[ej].oldText,
                newText: _refinedNew2.trim() ? _refinedNew2 : ''
              });
            }
            var applied2 = te2.applyEditsWithRefine(current, editList2, refineEditText);
            if (!applied2.ok) {
              return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', message: te2.formatFailure(applied2, 'get_current_shader') }) });
            }
            var merged = applied2.content;
            var editResults2 = applied2.results;
            return checkShaderAsync(merged).then(function (ck2) {
              if (ck2 && ck2.ok === false) {
                return { success: false, result: JSON.stringify({ status: 'failed', message: '合并后编译校验失败，请修正后重新提交。', error: ck2.error || '' }) };
              }
              // 停止复查 + 二次守卫（同上：异步窗口内用户可能已点停止 / 手改）
              if (stopRequested(execCtx)) return stoppedResult();
              var staleLate = stalePreviewRejection(writer);
              if (staleLate) return staleLate;
              if (writeShaderPreview(merged) === false) return writeFailedResult();
              recordPreviewWrite(writer);
              var detail2 = (editResults2.length <= 3) ? ('（' + te2.describeEdit(editResults2) + '）') : '';
              // 多段编辑时 edits[].anchorLine 是各步应用时的坐标（非最终坐标）——在回执里说清，
              // 免得模型拿它当改动后的位置去做行号推理
              var coordNote2 = (editResults2.length > 1) ? '（多段编辑：edits[].anchorLine 为各步锚点命中行，非最终坐标；要最终坐标请用 get_current_shader 重读）' : '';
              return {
                success: true,
                result: JSON.stringify({
                  status: 'passed',
                  message: '已按内容锚定替换 ' + editResults2.length + ' 处' + detail2 + '，合并后编译校验通过，已写入预览区（共 ' + countLinesSafe(merged) + ' 行）。' + coordNote2 + usageNote(merged),
                  hash: _hashShaderText(merged),
                  totalLines: countLinesSafe(merged),
                  edits: editResults2
                })
              };
            });
          },
          scope: { type: 'module', moduleIds: ['shader', 'external-mcp'] },
          stub: false,
          category: 'utility',
          source: 'agent'
        });

        registry.register({
          name: 'get_current_shader',
          description: '读取预览区当前的 GLSL 代码。提交前必调（含首次，空预览区也要读一次——写前必读，未读提交会被拒绝）；修改已有 shader 或用户提到"当前代码/第 N 行"时也用它定位。不传参数返回完整代码（每行带行号，超过 500 行时截断为前 500 行）；search 的 context 与 segments 的 snippet 含行号或截断，不能直接当 oldText 锚点——锚点用整篇读回并剥掉行号前缀后的原文',
          input_schema: {
            type: 'object',
            properties: {
              startLine: { type: 'number', description: '起始行号（1-based，含）。单次最多返回 500 行，超出则截断并标注 truncated' },
              endLine: { type: 'number', description: '结束行号（1-based，含）' },
              search: { type: 'string', description: '文本搜索：返回每个匹配的行号、该行内容及 ±2 行上下文，每页最多 20 个匹配，用 offset 分页。与 startLine/endLine/segments 互斥' },
              offset: { type: 'number', description: '分页偏移：起始匹配序号（1-based，默认 1）。仅配合 search 使用，返回第 offset 个匹配起的 20 个匹配及 hasMore 标记' },
              segments: { type: 'boolean', description: '按逻辑块拆分：返回段落列表（startLine/endLine/snippet），便于定位要修改的段。与 search/startLine/endLine 互斥' }
            },
            required: []
          },
          handler: function (args, execCtx) {
            args = args || {};
            var writer = previewWriter(execCtx);
            var current = typeof getCurrentShader === 'function' ? (getCurrentShader() || '') : '';
            // 参数校验必须早于记账（被拒的读不算"读过"）。
            var _cq = resolveCodeQuery();
            if (!_cq) return codeQueryUnavailable();
            var _qErr = _cq.validateCodeQueryArgs(args);
            if (_qErr) return _qErr;
            // 空读也留账：回执 status='empty' 交付了"当前内容为空"这一事实，读一次即解写前必读。
            if (!current.trim()) {
              recordPreviewRead(writer);
              return { success: true, result: JSON.stringify({ status: 'empty', message: '预览区当前为空。' }) };
            }
            // 只有确实交付了内容的读才留快照（回执 status='ok'）；search 未命中、offset 越界这类
            // 没有返回任何内容的调用不记账——否则一次无效读就解除「从未读过 + 预览区非空 →
            // 拒绝写入」那道防线。快照供 submit_shader / submit_js_effect 写前比对（按调用方分账）。
            var res = _cq.runCodeQuery(current, args, { hash: _hashShaderText(current), buildSegments: buildSegments });
            var delivered = false;
            try {
              var _p = JSON.parse(res && res.result);
              delivered = !!res && res.success !== false && _p && _p.status === 'ok';
            } catch (_) {}
            if (delivered) recordPreviewRead(writer);
            return res;
          },
          scope: { type: 'module', moduleIds: ['shader', 'external-mcp'] },
          stub: false,
          category: 'utility',
          source: 'agent'
        });

        registry.register({
          name: 'shader_library',
          description: '效果库管理：list（列出 effects/ 下全部效果文件，含 .glsl 与 .js）、get（读取 effects/<name>.<ext>）、save（写入效果库）、delete（删除）。get 不传查询参数则整份返回（原文不带行号；超过 500 行截断并标注 truncated）。GLSL（渲染产物，须在选择器选中该 .glsl 才渲染）；JS（源码归档，由 submit_js_effect 传 name 生成）仅作 LLM 读回源码迭代用，不可被宿主直接渲染——需用 get type=js 读回 JS 后经 submit_js_effect 重新执行产出新的 GLSL。list 返回 hostOrder（宿主导出的库索引 0 基序号，与效果选择器逐项一致）与 diskOrder（磁盘 .glsl 按同一排序规则的带序号表）：刚保存的文件若还不在 hostOrder 里，用 diskOrder 的序号写效果实例即可——宿主写索引时会先重扫目录，该文件即成为实例身份。save 传 source:"preview" 时取预览区当前内容落库，传 expectHash 时与内容 hash 不一致即拒绝保存；save/get 返回 hash，与 submit_shader 返回的 hash 相同即同一版本。',
          input_schema: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['list', 'get', 'save', 'delete'], description: '操作类型' },
              name: { type: 'string', description: '效果名（不含扩展名），list 时省略。支持中文等 Unicode 与字母/数字/_/-，禁 Windows 文件名非法字符（\\ / : * ? " < > |），1-64 字符' },
              code: { type: 'string', description: '源码，save 且未传 source:"preview" 时必填（GLSL 或 JS）' },
              source: { type: 'string', enum: ['code', 'preview'], description: 'save 的内容来源，默认 code=取 code 参数；preview=取预览区当前已校验内容' },
              expectHash: { type: 'string', description: 'save 可选：期望的内容 hash（如 submit_shader 返回的 hash），不一致即拒绝保存' },
              type: { type: 'string', enum: ['glsl', 'js'], description: '效果类型（默认 glsl；JS 效果用 js）' },
              startLine: { type: 'number', description: 'get 查询：起始行号（1-based，含）。单次最多返回 500 行，超出则截断并标注 truncated' },
              endLine: { type: 'number', description: 'get 查询：结束行号（1-based，含）' },
              search: { type: 'string', description: 'get 查询：文本搜索（返回每个匹配的行号、该行内容及 ±2 行上下文，每页最多 20 个匹配，用 offset 分页）。与 startLine/endLine/segments 互斥' },
              offset: { type: 'number', description: 'get 查询：search 的分页偏移（起始匹配序号，1-based，默认 1）' },
              segments: { type: 'boolean', description: 'get 查询：按逻辑块拆分（返回 startLine/endLine/snippet 段落列表）。与 search/startLine/endLine 互斥' }
            },
            required: ['mode']
          },
          handler: function (args) {
            args = args || {};
            var mode = args.mode;
            var dir = checkDir();
            if (!dir) return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', message: 'effects 数据目录不可用。' }) });
            // 根据调用方指定 type 决定扩展名（默认 glsl；js 效果需显式 type='js'）
            // save/get/delete 通过 type 参数区分；list 不需要
            var ext = (args.type === 'js') ? 'js' : 'glsl';
            // list 的响应体构造（两条取数路径共用：listFilesResult 三态 / 旧 listFiles 折叠版回落）
            function buildListPayload(files) {
              var names = (files || []).filter(function (f) { return /\.(glsl|js)$/i.test(f); });
              var glsl = [], js = [];
              for (var i = 0; i < names.length; i++) {
                if (/\.glsl$/i.test(names[i])) glsl.push(stemOf(names[i]));
                else js.push(stemOf(names[i]));
              }
              glsl.sort(hostOrderCmp);
              js.sort(hostOrderCmp);
              return readLibraryIndex(dir).then(function (host) {
                var payload = { status: 'ok', files: names, glsl: glsl, js: js };
                // diskOrder：磁盘 .glsl 按宿主同款比较器排序后的带序号表，与宿主重扫后的
                // 列表逐项一致。宿主在**写入索引参数的当刻**会先重扫目录（plugin.cpp 的
                // USER_CHANGED_PARAM 分支先经 shaderNameAtIndex → maybeRescanEffectsDir，
                // 再把名字固化为实例身份），故刚保存的文件用 diskOrder 的序号可直接写入
                // 效果实例；hostOrder 是宿主**上一次**导出索引时的快照，滞后于磁盘。
                var diskOrder = [];
                for (var di = 0; di < glsl.length; di++) diskOrder.push({ index: di, name: glsl[di] });
                payload.diskOrder = diskOrder;
                if (host) {
                  payload.hostOrder = host.list;
                  if (host.generated) payload.hostGenerated = host.generated;
                  var d = diffLibraryNames(host.names, glsl);
                  if (d.notInHost.length || d.notOnDisk.length) {
                    payload.hostStale = d;
                    payload.hostStaleNote = '宿主索引是快照、滞后于磁盘：notInHost 里的文件宿主还没扫到，用 diskOrder 的序号写入即可（宿主写索引时会先重扫目录；要在效果控件列表里看到它点控件 ↻）；notOnDisk 的文件磁盘已删、宿主索引仍有条目，选中走透传。';
                  }
                } else {
                  payload.hostOrderNote = '宿主尚未导出库索引。用 diskOrder 的序号写效果实例即可（宿主写索引时会先重扫目录）；要在效果控件里核对宿主索引，挂一次 AS_Effect Host 效果（或点控件 ↻）后会生成 effects/' + LIB_INDEX_FILE + '。';
                }
                return { success: true, result: JSON.stringify(payload) };
              });
            }
            // 目录读取失败的统一出口：**不能**回成「空库」（{status:'ok',files:[]}）——模型会
            // 断言效果库为空，而真因可能是目录还没建 / 通道挂了 / 路径被拒（原因：
            // 折叠版 aefs.listFiles 丢三态返回 []，而同文件 save/delete 都如实报失败）。
            function listFailedResult(code) {
              return {
                success: false,
                result: JSON.stringify({
                  status: 'error', code: code || 'LIB_LIST_FAILED',
                  message: 'effects 目录读取失败（' + (code || 'UNKNOWN') + '），未能列出效果库。这不是「库为空」'
                    + '——请先确认数据目录存在、Bridge 已连接、路径未被拒，再重试。'
                })
              };
            }
            if (mode === 'list') {
              if (typeof aefs.listFilesResult === 'function') {
                return aefs.listFilesResult(dir).then(function (r) {
                  if (!r || r.ok !== true) {
                    var _err = (r && r.error) || {};
                    return listFailedResult(_err.code);
                  }
                  return buildListPayload(r.data);
                }).catch(function () { return listFailedResult(); });
              }
              // 回落：只提供折叠版 listFiles 的环境（测试桩 / 旧装配）
              if (!aefs.listFiles) return Promise.resolve(listFailedResult('LIB_LIST_UNAVAILABLE'));
              return aefs.listFiles(dir).then(buildListPayload)
                .catch(function () { return listFailedResult(); });
            }
            var name = sanitizeName(args.name);
            if (!name) return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', message: '效果名不合法。' }) });
            var libPath = dir + '\\' + name + '.' + ext;
            if (mode === 'get') {
              // 参数校验前置（与读着色器同款：被拒的调用不落到读取动作上）
              var _cqGet = resolveCodeQuery();
              if (!_cqGet) return Promise.resolve(codeQueryUnavailable());
              var _qErr = _cqGet.validateCodeQueryArgs(args);
              if (_qErr) return Promise.resolve(_qErr);
              var _hasQuery = (typeof args.search === 'string' && args.search.length > 0)
                || args.segments === true
                || (typeof args.startLine === 'number') || (typeof args.endLine === 'number');
              return aefs.readFile(libPath).catch(function (e) {
                return { __err: 'READ_FAILED', __msg: String((e && e.message) || e) };
              }).then(function (content) {
                if (content && content.__err) {
                  return { success: false, result: JSON.stringify({ status: 'error', message: '读取效果文件失败: ' + name }) };
                }
                if (content === null || content === undefined) {
                  return { success: false, result: JSON.stringify({ status: 'error', message: '效果库中不存在: ' + name }) };
                }
                // 查询式读取：与 get_current_shader 共用同一实现（search / startLine-endLine / segments），
                // 大文件只取相关片段，回执与读着色器逐字节一致。
                if (_hasQuery) return _cqGet.runCodeQuery(content, args, { hash: _hashShaderText(content), buildSegments: buildSegments });
                // 整篇读取：**保持旧契约——原文（不带行号）**，模型可据此与 hash 对照、原样回存；
                // 仅补一道 500 行上限（超限截断并指路分段读），与查询式/读着色器同一保护口径。
                var _fullLines = String(content).split(/\r?\n/);
                var _fullTotal = _fullLines.length;
                var _fullTruncated = _fullTotal > 500;
                var _fullPayload = _fullTruncated
                  ? { status: 'ok', name: name, code: _fullLines.slice(0, 500).join('\n'), totalLines: _fullTotal, maxLines: 500, truncated: true, hash: _hashShaderText(content), message: '代码超过 500 行，已仅返回前 500 行，请用 startLine/endLine 分段读取。' }
                  : { status: 'ok', name: name, code: content, totalLines: _fullTotal, hash: _hashShaderText(content) };
                // 整篇返回前按序列化长度自守（预算取 codeQuery 的 PAYLOAD_BUDGET，取不到按 24K）：
                // 超过管线 32K 兜底就会把结果截成非法 JSON。
                var _fullBudget = (_cqGet && _cqGet.PAYLOAD_BUDGET) || (24 * 1024);
                if (JSON.stringify(_fullPayload).length > _fullBudget) {
                  return { success: false, result: JSON.stringify({ status: 'error', code: 'PAYLOAD_TOO_LARGE', message: '代码内容超出单次读取体积上限（约 ' + Math.round(_fullBudget / 1024) + ' KB）：本工具无法整篇返回。请用 startLine/endLine 分段读取；若单行本身超限则无法读取。' }) };
                }
                return { success: true, result: JSON.stringify(_fullPayload) };
              });
            }
            if (mode === 'save') {
              // 内容来源：默认取 code 参数；source:'preview' 取预览区当前内容——
              // 预览区是 submit_shader 校验过的产物，落库免整份源码重传（也就不存在
              // 「预览已修好、落库的却是旧内容」这类错版）。
              var fromPreview = (args.source === 'preview');
              // 预览区内容恒为 GLSL（submit_js_effect 产出的也是 GLSL），故 source:'preview'
              // 只对 type=glsl 有意义——JS 归档要的是 JS 源码，从预览区取会把 GLSL 写进 .js。
              if (fromPreview && ext === 'js') {
                return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', message: 'source:"preview" 只用于 GLSL（预览区内容为 GLSL）；归档 JS 请传 code。' }) });
              }
              var rawCode = fromPreview
                ? (typeof getCurrentShader === 'function' ? String(getCurrentShader() || '') : '')
                : String(args.code == null ? '' : args.code);
              // GLSL 剥围栏；JS 代码原样保存（不能剥 GLSL 围栏）
              if (ext === 'glsl') rawCode = stripFences(rawCode);
              if (!rawCode.trim()) {
                return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', message: fromPreview ? '预览区为空，无可发布内容（先 submit_shader 提交并通过校验）。' : '代码为空。' }) });
              }
              var contentHash = _hashShaderText(rawCode);
              // 期望哈希（发布一致性）：调用方带上它认为正在发布的版本；不一致说明预览/代码
              // 已被改动，此时拒绝保存并在回执里给出实际 hash 供比对。
              if (args.expectHash && String(args.expectHash) !== contentHash) {
                return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', message: 'expectHash 与本次待写入内容不一致，已拒绝保存（内容可能已被改动：重新读取后再试）。', expectHash: String(args.expectHash), hash: contentHash }) });
              }
              // JS 效果写入前静态危险代码预检：防止 LLM 把恶意/越权 JS 直接写进效果库。
              if (ext === 'js' && global.AEJsExecutor && typeof global.AEJsExecutor.precheckJsEffect === 'function') {
                var _savePre = global.AEJsExecutor.precheckJsEffect(rawCode);
                if (!_savePre.valid) {
                  var _savePreMsg = (_savePre.errors || []).map(function (e) { return e.message; }).join('；');
                  return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', message: 'JS 效果预检未通过，已拒绝保存: ' + _savePreMsg }) });
                }
              }
              return aefs.writeFile(libPath, rawCode).then(function (ok) {
                if (!ok) return { success: false, result: JSON.stringify({ status: 'error', message: '写入失败: ' + name + '.' + ext }) };
                var payload = {
                  status: 'ok',
                  message: '已保存: ' + name + '.' + ext,
                  name: name,
                  hash: contentHash,
                  source: fromPreview ? 'preview' : 'code'
                };
                // 落库回执（best-effort，读取失败不影响保存结果）：
                //   diskIndex = 磁盘序序号，写效果实例文件索引参数直接用（见 list 的 diskOrder 说明）；
                //   hostOrderContains = 宿主导出的索引里是否已有该文件——false 只表示宿主索引快照
                //   尚未刷新，不影响写入。
                return diskIndexOfName(dir, name).then(function (di) {
                  if (di >= 0) payload.diskIndex = di;
                  return readLibraryIndex(dir).then(function (host) {
                    if (host) {
                      var fold = asciiFold(name);
                      var has = false;
                      for (var hi = 0; hi < host.names.length; hi++) {
                        if (asciiFold(host.names[hi]) === fold) { has = true; break; }
                      }
                      payload.hostOrderContains = has;
                      if (!has) payload.hostIndexNote = '宿主索引快照尚未包含该文件；写效果实例用 diskIndex 即可（宿主写索引时会先重扫目录）。';
                    }
                    return { success: true, result: JSON.stringify(payload) };
                  });
                });
              });
            }
            if (mode === 'delete') {
              // deleteFile 失败以 resolve(false) 结算（不 reject），因此不能忽略返回值：
              // .then(function () { return true; }) 把 resolved boolean 丢弃恒回报
              // 「已删除」——对齐上方 save 分支的 ok ? success : error 模式透传结果；
              // aefs.deleteFile 不存在同样视为失败。
              return (aefs.deleteFile ? aefs.deleteFile(libPath).then(function (ok) { return ok; }) : Promise.resolve(false))
                .then(function (ok) {
                  return ok
                    ? { success: true, result: JSON.stringify({ status: 'ok', message: '已删除: ' + name + '.' + ext }) }
                    : { success: false, result: JSON.stringify({ status: 'error', message: '删除失败: ' + name + '.' + ext }) };
                });
            }
            return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', message: '未知 mode: ' + mode }) });
          },
          scope: { type: 'module', moduleIds: ['shader', 'external-mcp'] },
          stub: false,
          category: 'utility',
          source: 'agent'
        });

        // getShaderPreview：截取 shader 预览 canvas，供视觉模型分析实际渲染效果。
        // 与 getPreviewFrame（截 AE 合成）互补：本工具截面板内 WebGL 实时预览，无需应用图层。
        // 返回 JSON 中带 imageDataUrl 字段，vision hook 据此直接注入图片到 LLM 上下文。
        // 多时间点（timesInSeconds）在面板侧拼成一张联系表再注入：视觉链路只认单张
        // imageDataUrl（面板 vision hook 与外接 MCP hoist 同口径），多图会各自占一份 token。
        function previewAspectNote(w, h, aspect) {
          return '预览画幅 = 面板预览框 ' + w + '×' + h
            + (aspect === null ? '' : '，比例 ' + aspect)
            + '；不等于目标合成比例，判断构图位置需按比例换算。';
        }

        // 单帧（默认路径）：截 canvas 当前帧，字段与文案保持既有口径。
        function capturePreviewFrame(settle) {
          var dataUrl = captureShaderPreview();
          if (!dataUrl) {
            return { success: false, result: JSON.stringify({ status: 'error', message: '预览不可用：未进入 Shader 模式或 WebGL 未初始化。' }) };
          }
          var canvas = document.getElementById('shaderPreviewCanvas');
          var w = canvas ? canvas.width : 0, h = canvas ? canvas.height : 0;
          var aspect = (w > 0 && h > 0) ? Math.round((w / h) * 1000) / 1000 : null;
          var msg = '已截取 shader 预览帧，图片已注入上下文供视觉分析。';
          if (settle.compileState === 'pending') {
            msg = 'shader 仍在编译中（等待 3 秒未完成）；当前帧是上一版本代码的画面，首次加载时为占位空帧。';
          } else if (settle.compileState === 'error') {
            msg = '当前 shader 编译失败；预览帧是上一版画面或占位帧。';
          }
          return {
            success: true,
            result: JSON.stringify({
              status: 'ok',
              compile: settle.compileState,
              width: w,
              height: h,
              aspect: aspect,
              aspectNote: previewAspectNote(w, h, aspect),
              message: msg,
              imageDataUrl: dataUrl
            })
          };
        }

        // 多时间点抓帧：经 shaderUI 的渲染器按时间点重绘并截图。
        // 升序渲染（结算器从第 0 帧顺序推进，来回跳会反复重解），回执按请求顺序还原。
        function capturePreviewFramesAt(times) {
          var su = global.AEShaderUIInstance;
          if (!su || typeof su.capturePreviewFrames !== 'function') {
            return { error: '多时间点截图不可用：预览渲染器未就绪（未进入 Shader 模式，或面板文件未完整更新）。' };
          }
          var order = [];
          var i;
          for (i = 0; i < times.length; i++) order.push({ t: times[i], idx: i });
          order.sort(function (a, b) { return a.t - b.t; });
          var sortedTimes = [];
          for (i = 0; i < order.length; i++) sortedTimes.push(order[i].t);
          var cap;
          try {
            cap = su.capturePreviewFrames(sortedTimes);
          } catch (e) {
            return { error: '多时间点截图失败：' + ((e && e.message) || e) };
          }
          if (!cap || cap.ok !== true) return { error: (cap && cap.error) || '多时间点截图失败：预览渲染失败。' };
          var shots = (cap.frames || []).slice();
          if (shots.length !== sortedTimes.length) {
            return { error: '多时间点截图失败：渲染器返回的帧数与时间点不一致。' };
          }
          var frames = [];
          for (i = 0; i < shots.length; i++) {
            var shot = shots[i];
            if (!shot || typeof shot.dataUrl !== 'string' || shot.dataUrl.indexOf('data:image/') !== 0) {
              return { error: '多时间点截图失败：时间点 ' + sortedTimes[i] + 's 的画面不可读。' };
            }
            frames[order[i].idx] = shot;
          }
          return {
            frames: frames,
            mode: cap.mode,
            frameRate: cap.frameRate,
            timeClamped: !!cap.timeClamped,
            frameWidth: cap.frameWidth,
            frameHeight: cap.frameHeight
          };
        }

        // 联系表合成：复用 getPreviewFrame 那套网格/时间标签/单格上限（AEPreviewSheet），
        // 优先用其回传的 canvas 直出 JPEG；旧版模块只回 blob 时走 FileReader 兜底。
        function composePreviewContactSheet(frames) {
          var sheet = global.AEPreviewSheet;
          if (!sheet || typeof sheet.composeSheet !== 'function') {
            return Promise.resolve({ error: '联系表模块未加载（AEPreviewSheet 不可用）' });
          }
          var items = [];
          for (var i = 0; i < frames.length; i++) {
            items.push({ url: frames[i].dataUrl, label: previewTimeLabel(frames[i].actualTime) });
          }
          var composing;
          try {
            composing = sheet.composeSheet(items);
          } catch (e) {
            return Promise.resolve({ error: '联系表合成失败：' + ((e && e.message) || e) });
          }
          return Promise.resolve(composing).then(function (r) {
            if (r && r.canvas && typeof r.canvas.toDataURL === 'function') {
              var url = null;
              try { url = r.canvas.toDataURL('image/jpeg', 0.9); } catch (_) { url = null; }
              if (url && url.indexOf('data:image/') === 0) {
                return { imageDataUrl: url, layout: r.layout, frameW: r.frameW, frameH: r.frameH };
              }
            }
            return blobToDataUrl(r && r.blob).then(function (dataUrl) {
              if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/') !== 0) {
                throw new Error('联系表导出格式无效');
              }
              return { imageDataUrl: dataUrl, layout: r.layout, frameW: r.frameW, frameH: r.frameH };
            });
          }).catch(function (e) {
            return { error: '联系表合成失败：' + ((e && e.message) || e) };
          });
        }

        // 多时间点回执：单点与单帧同形；多点拼联系表，合成失败降级为只注入第一帧。
        function capturePreviewSequence(settle, norm) {
          var cap = capturePreviewFramesAt(norm.times);
          if (cap.error) {
            return { success: false, result: JSON.stringify({ status: 'error', message: cap.error }) };
          }
          var frames = cap.frames;
          var total = frames.length;
          var fw = cap.frameWidth || 0, fh = cap.frameHeight || 0;
          var aspect = (fw > 0 && fh > 0) ? Math.round((fw / fh) * 1000) / 1000 : null;
          var aspectNote = previewAspectNote(fw, fh, aspect);
          var timeClamped = !!(norm.timeClamped || cap.timeClamped);
          var clampNote = '';
          if (norm.timeClamped) clampNote += '负值时间点已按 0 处理。';
          if (cap.timeClamped) clampNote += '结算器 shader 单点上限 10 秒，超出的时间点已钳制。';
          var modeNote = cap.mode === 'solver'
            ? '结算器 shader 按 30fps 从第 0 帧顺序重解到各时间点；采样后预览时间轴停在最后采样点。'
            : '';
          var compileNote = '';
          if (settle.compileState === 'pending') {
            compileNote = 'shader 仍在编译中（等待 3 秒未完成）；画面是上一版本代码的渲染结果，首次加载时为占位空帧。';
          } else if (settle.compileState === 'error') {
            compileNote = '当前 shader 编译失败；画面是上一版代码的渲染结果或占位帧。';
          }
          if (total === 1) {
            var f0 = frames[0];
            var oneMsg = '已截取 shader 预览在 ' + previewTimeLabel(f0.actualTime) + ' 的画面，图片已注入上下文供视觉分析。'
              + (f0.frame === null ? '' : '对应第 ' + f0.frame + ' 帧（30fps）。')
              + compileNote + modeNote + clampNote;
            return {
              success: true,
              result: JSON.stringify({
                status: 'ok',
                compile: settle.compileState,
                time: f0.time,
                actualTime: f0.actualTime,
                frame: f0.frame,
                mode: cap.mode,
                width: fw,
                height: fh,
                aspect: aspect,
                aspectNote: aspectNote,
                timeClamped: timeClamped,
                message: oneMsg,
                imageDataUrl: f0.dataUrl
              })
            };
          }
          return composePreviewContactSheet(frames).then(function (sheetRes) {
            var sheetOk = !!(sheetRes && sheetRes.imageDataUrl);
            var out = {
              status: 'ok',
              compile: settle.compileState,
              contactSheet: sheetOk,
              mode: cap.mode,
              times: [],
              frames: [],
              width: fw,
              height: fh,
              frameWidth: fw,
              frameHeight: fh,
              aspect: aspect,
              aspectNote: aspectNote,
              timeClamped: timeClamped
            };
            for (var i = 0; i < frames.length; i++) {
              out.times.push(frames[i].time);
              out.frames.push({ time: frames[i].time, actualTime: frames[i].actualTime, frame: frames[i].frame });
            }
            if (sheetOk) {
              out.sheetLayout = {
                cols: sheetRes.layout.cols,
                rows: sheetRes.layout.rows,
                cellWidth: sheetRes.layout.cellW,
                cellHeight: sheetRes.layout.cellH
              };
              out.width = sheetRes.layout.sheetW;
              out.height = sheetRes.layout.sheetH;
              out.frameWidth = sheetRes.frameW;
              out.frameHeight = sheetRes.frameH;
              out.imageDataUrl = sheetRes.imageDataUrl;
              out.message = '已截取 ' + total + ' 帧并合成一张带时间标签的联系表（每格左上角为该帧时间），图片已注入上下文供视觉分析。'
                + compileNote + modeNote + clampNote;
            } else {
              out.sheetError = (sheetRes && sheetRes.error) || '联系表合成失败';
              out.imageDataUrl = frames[0].dataUrl;
              out.message = '已截取 ' + total + ' 帧，但联系表合成失败（' + out.sheetError + '），本次图片是第一个时间点 '
                + previewTimeLabel(frames[0].actualTime) + ' 的单帧，其余时间点未送达。'
                + compileNote + modeNote + clampNote;
            }
            return { success: true, result: JSON.stringify(out) };
          });
        }

        registry.register({
          name: 'getShaderPreview',
          description: '截取 Shader 面板实时预览区画面。默认截当前帧；传 timesInSeconds（1–6 个秒数 = shader 时间 uTime）可指定时间点：1 个返回该时刻单帧，≥2 个逐点抓帧并合成一张带时间标签的联系表（检查动画连续性/出场层次/形变）。无状态 shader 按 uTime 精确重绘，不影响实时画面；结算器（@solve/@solveHz）shader 从第 0 帧按 30fps 顺序重解到各时间点（单点上限 10 秒，超出钳制），抓完后预览时间轴停在最后时间点继续。截图前最多等 3 秒让进行中的编译完成；结果带 compile 字段：ok（编译已完成，图是当前代码的画面）/ pending（3 秒内未编完，图是上一版本代码的画面，首次加载时为占位空帧）/ error（编译失败，图是上一版画面或占位帧）/ unknown（读不到渲染器状态）。返回截图信息（尺寸/编译状态/时间点），图片经 vision hook 自动注入上下文供视觉分析。可选参数 purpose 用于向视觉模型说明本次分析需要关注的内容。用于：调整 shader 参数/代码后验证视觉效果、检查动画、排查渲染异常。需视觉模型或视觉代理模型。width/height 是面板预览框像素尺寸（多帧时是联系表尺寸，frameWidth/frameHeight 才是单帧），aspect 为单帧宽高比；预览画幅不等于目标合成比例，判断构图位置按 aspect 换算。',
          input_schema: {
            type: 'object',
            properties: {
              purpose: {
                type: 'string',
                description: '本次截取/分析 shader 预览需要重点关注的内容（可选）。例如："帮我看看画面中心的光晕是否正常"。提供后，系统会将该需求交给视觉模型，令其围绕需求输出相关信息。'
              },
              timesInSeconds: {
                type: 'array',
                items: { type: 'number' },
                description: '多时间点抓帧（秒 = shader 时间 uTime，1–6 个）：1 个返回该时刻单帧，≥2 个合成一张带时间标签的联系表；省略则截当前帧。负值按 0；结算器 shader 单点上限 10 秒（超出钳制，回执 timeClamped=true）。'
              }
            },
            required: []
          },
          handler: function (args) {
            args = args || {};
            var norm = null;
            if (args.timesInSeconds !== undefined && args.timesInSeconds !== null) {
              norm = normalizePreviewTimes(args.timesInSeconds);
              if (norm.error) {
                return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', message: norm.error }) });
              }
            }
            // 截图前等编译 settle：pending 期间 canvas 仍是旧画面/空帧，直接截会给
            // 视觉模型喂错图（详见 waitForPreviewSettle 注释）
            return waitForPreviewSettle().then(function (settle) {
              return norm ? capturePreviewSequence(settle, norm) : capturePreviewFrame(settle);
            });
          },
          scope: { type: 'module', moduleIds: ['shader', 'external-mcp'] },
          stub: false,
          category: 'utility',
          source: 'agent'
        });

        // get_render_error：读取 AE 宿主写入的 effects/error.log，
        // 把渲染/编译错误回传给 LLM。用户在选择器选中渲染后，可调用此工具检查 AE 实际渲染状态。
        // error.log 为空或不存在 = 渲染无错误。
        registry.register({
          name: 'get_render_error',
          // get_render_error 用法与 error.log 触发条件自 shader
          // 系统提示词「错误排查」节归位（同注入两处删一）
          description: '读取 AE 宿主的渲染错误日志（effects/error.log）。用户在选择器选中渲染后，若画面异常，调用本工具检查 AE 编译/链接错误，据此修正后重新提交。返回空表示渲染成功。注意：AE 需触发渲染（预览/移动时间指示器）才会写入 error.log，静止帧可能无反馈。',
          input_schema: { type: 'object', properties: {}, description: '无参数，直接读取 error.log' },
          handler: function () {
            var dir = checkDir();
            if (!dir) return Promise.resolve({
              success: false,
              result: JSON.stringify({ status: 'error', message: 'effects 数据目录不可用。' })
            });
            var errorLogPath = dir + '\\error.log';
            // 三态读取：用 `readFile` 会把三态折成两态
            //（`aefs.readFile` 对 NOT_FOUND 与 CHANNEL_FAILURE 都回 null），catch 又把**一切**
            // 读失败说成「AE 渲染无错误」——把「**未知**」讲成「已知干净」。shader 排查回路会据此
            // 认定渲染成功并继续叠加。改用 `readFileResult`（带 code），只有**确证不存在**才算无错误。
            var _readRes = (typeof aefs.readFileResult === 'function')
              ? aefs.readFileResult(errorLogPath)
              : aefs.readFile(errorLogPath).then(function (c) {
                  return { ok: true, data: c };   // 无三态 API 时的旧口径回退
                });
            return _readRes.then(function (r) {
              if (r && r.ok !== true) {
                var _code = (r && r.error && r.error.code) || 'CHANNEL_FAILURE';
                if (_code === 'NOT_FOUND') {
                  // 真没有该文件 = 宿主在重载成功时清空/删除 ⇒ 无错误（这才是原注释的本意）
                  return {
                    success: true,
                    result: JSON.stringify({ status: 'ok', message: 'AE 渲染无错误', error: '' })
                  };
                }
                return {
                  success: false,
                  isError: true,
                  result: JSON.stringify({
                    status: 'unknown',
                    message: 'error.log 读取失败（' + _code + '），无法判断 AE 渲染是否出错'
                      + '（若怀疑渲染失败，请让用户查看 AE 的日志/界面，勿据此认定无错误）',
                    error: ''
                  })
                };
              }
              var text = String((r && r.data) || '').trim();
              if (!text) {
                return {
                  success: true,
                  result: JSON.stringify({ status: 'ok', message: 'AE 渲染无错误', error: '' })
                };
              }
              return {
                success: true,
                result: JSON.stringify({ status: 'error', message: 'AE 渲染出错', error: text })
              };
            }).catch(function (e) {
              // reject 的两种含义要分开（对齐真实 AEFS 语义）：
              //  · 文本表明「不存在」（NOT_FOUND/ENOENT/not found）⇒ 真没有 ⇒ 无错误；
              //  · 其它（通道异常/权限/超时）⇒ **未知**，不再谎报无错误。
              var _m = ((e && e.message) || String(e) || '');
              if (/NOT_FOUND|ENOENT|not\s+found/i.test(_m)) {
                return {
                  success: true,
                  result: JSON.stringify({ status: 'ok', message: 'AE 渲染无错误', error: '' })
                };
              }
              return {
                success: false,
                isError: true,
                result: JSON.stringify({
                  status: 'unknown',
                  message: 'error.log 读取异常，无法判断 AE 渲染是否出错: ' + _m,
                  error: ''
                })
              };
            });
          },
          scope: { type: 'module', moduleIds: ['shader', 'external-mcp'] },
          stub: false,
          category: 'utility',
          source: 'agent'
        });

        // submit_js_effect：LLM 提交 JS 效果代码 → jsExecutor 执行 buildShader(params) →
        // compileCheck 校验产出的 GLSL → 通过则写入预览区（GLSL），失败回喂 LLM。
        // 宿主对 JS 无感知，最终都走 .glsl 库文件：预览区定稿后由用户手动
        // 保存到效果库并在选择器选中渲染（LLM 不自动保存）。
        // params: 可选，由 LLM 提供 uniform 默认值（如 { uAmount: 0.5 }），注入 buildShader
        registry.register({
          name: 'submit_js_effect',
          description: _submitJsEffectDescription(''),
          buildDescription: _submitJsEffectDescription,
          input_schema: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'JS 效果代码（必须实现 buildShader(params) 函数返回 GLSL 字符串，params 为 uniform 默认值对象）' },
              name: { type: 'string', description: '可选，JS 效果归档名（不含扩展名，仅 [A-Za-z0-9_-] 1-64 位）。提供时把 JS 源码存为 <name>.js 并在产出的 GLSL 顶部注入来源注释，便于后续读回源码迭代' },
              params: { type: 'object', description: '可选，注入 buildShader 的参数对象（如 { uAmount: 0.5 }）', properties: {} },
              message: { type: 'string', description: '给用户的说明（可选）' }
            },
            required: ['code']
          },
          handler: function (args, execCtx) {
            args = args || {};
            var writer = previewWriter(execCtx);
            // 局部编辑参数在这里无意义（本工具产出的是 buildShader 生成的 GLSL，没有可锚定的
            // 原文）——显式拒绝，不静默忽略：静默忽略等于把带 oldText/startLine 的调用当整份
            // 重写执行，模型以为只改了一段（与另两个提交工具同一条红线）。
            if (args.oldText != null || args.newText != null || args.edits != null
              || args.startLine !== undefined || args.endLine !== undefined) {
              return Promise.resolve({
                success: false,
                result: JSON.stringify({
                  status: 'error',
                  message: 'submit_js_effect 只接受整份 JS 代码（code）：它写入预览区的是 buildShader() 产出的 GLSL，没有可锚定的原文。改 JS 请改 code 重新执行；改产出的 GLSL 请用 submit_shader 的 oldText/newText（先 get_current_shader 读回）。本次未执行、未写入。'
                })
              });
            }
            if (stopRequested(execCtx)) return Promise.resolve(stoppedResult());
            // 写前快照守卫（早拦）：预览区在读取后被改过 → 直接拒绝，不执行 JS
            var staleEarly = stalePreviewRejection(writer);
            if (staleEarly) return Promise.resolve(staleEarly);
            var jsCode = String(args.code == null ? '' : args.code);
            if (!jsCode.trim()) {
              return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', code: 'EMPTY_CODE', message: 'JS 代码为空，无法提交。' }) });
            }
            // jsExecutor 是共享能力，惰性加载
            var executor = (global.AEJsExecutor && typeof global.AEJsExecutor.executeJsEffectAsync === 'function')
              ? global.AEJsExecutor : null;
            if (!executor) {
              return Promise.resolve({ success: false, result: JSON.stringify({ status: 'error', message: 'JS 执行器未加载' }) });
            }
            // 静态危险代码预检：执行前确定性拦截（文件读写/网络/命令执行/沙箱逃逸等）。
            // 沿用早期 executeExtendScript 静态黑名单思路，按 shader JS（面板侧）语义收紧。
            if (typeof executor.precheckJsEffect === 'function') {
              var _pre = executor.precheckJsEffect(jsCode);
              if (!_pre.valid) {
                var _preMsg = (_pre.errors || []).map(function (e) { return e.message; }).join('；');
                return Promise.resolve({ success: false, result: JSON.stringify({ status: 'failed', message: 'JS 效果预检未通过，已拒绝执行: ' + _preMsg }) });
              }
            }
            // 改走超时竞速异步通道——同步 executeJsEffect 无执行时限，
            // LLM 生成的死循环 buildShader 会永久冻结面板主线程（工具调用栈上无法反馈）
            return executor.executeJsEffectAsync(jsCode, args.params || {}).then(function (exec) {
            if (!exec.ok) {
              return Promise.resolve({ success: false, result: JSON.stringify({ status: 'failed', message: 'JS 执行失败: ' + (exec.error || '未知错误') }) });
            }
            var glsl = exec.glsl;
            // 围栏剥离（buildShader 可能返回带围栏的 GLSL）
            if (global.AEEffectLab && typeof global.AEEffectLab.stripFences === 'function') {
              glsl = global.AEEffectLab.stripFences(glsl);
            }
            // GLSL 编译校验（异步通道优先，不阻塞主线程）
            return checkShaderAsync(glsl).then(function (ck) {
            if (ck && ck.ok === false) {
              return { success: false, result: JSON.stringify({ status: 'failed', message: 'JS 产出的 GLSL 编译校验失败，请修正 buildShader 返回值。', error: ck.error || '', glsl: glsl }) };
            }
            // 可选 name：把 JS 源码归档到效果库（<name>.js）+ 在 GLSL 顶部注入来源注释，
            // 供 LLM 后续 shader_library get type=js 读回源码迭代修改后重新提交。归档失败不影响本次产出。
            // 归档名单独走 ASCII 白名单（不用 sanitizeName）：名字会拼进 GLSL 顶部注释，
            // 非 ASCII 字节在 GLSL 注释里属未定义行为，要同时过 WebGL（预览）与宿主桌面 GL。
            var rawJsName = String(args.name == null ? '' : args.name).trim();
            var jsName = /^[A-Za-z0-9_-]{1,64}$/.test(rawJsName) ? rawJsName : '';
            var nameRejected = !!(rawJsName && !jsName);
            // 写入预览区（GLSL）。二次守卫：堵住 JS 执行 + 编译校验（异步窗口，
            // executor 有超时上限）期间预览区的改动
            if (stopRequested(execCtx)) return stoppedResult();
            var staleLate = stalePreviewRejection(writer);
            if (staleLate) return staleLate;
            // 归档与来源注释都在守卫之后：若先落盘 <name>.js、
            // 再守卫，被拒的调用仍会在效果库留下一个"本次未交付"的 JS 归档（零写入不变量
            // 在磁盘维度被破坏，shader_library list 会列出它）。
            // 来源注释先拼（要随 GLSL 一起写进预览区），归档落盘放在**预览写入成功之后**——
            // 预览写不进去（目标区缺失）时不留孤儿归档。
            if (jsName) {
              glsl = '// 源: ' + jsName + '.js（由 buildShader() 生成，改 JS 请重新执行 submit_js_effect）\n' + glsl;
            }
            if (writeShaderPreview(glsl) === false) return writeFailedResult();
            recordPreviewWrite(writer);
            // 回执带 totalLines + hash：JS 效果的 GLSL 是 buildShader 产出的，
            // 模型从未见过它的行布局——给行数 + 指纹，
            // 模型据此决定要不要 get_current_shader 读回，也能与 shader_library 的 hash 对照
            var glslLines = countLinesSafe(glsl);
            // 归档结果进回执：名字不合法被静默清空、归档写入失败被 catch 吞掉时，
            // 两种情形下回执照旧写「来源已归档为 X.js」，而磁盘上没有该文件。
            // 现等归档写入返回后如实报（与 shader_library save 同一口径）。
            function jsReceipt(archiveNote) {
              return {
                success: true,
                result: JSON.stringify({
                  status: 'passed',
                  message: 'JS 执行成功，产出的 GLSL 已写入预览区（共 ' + glslLines + ' 行' + archiveNote + '）。' + usageNote(glsl),
                  hash: _hashShaderText(glsl),
                  totalLines: glslLines
                })
              };
            }
            if (nameRejected) {
              return jsReceipt('；归档名 ' + JSON.stringify(rawJsName) + ' 不合法（仅 [A-Za-z0-9_-]、1-64 字符），本次未归档');
            }
            if (!jsName) return jsReceipt('');
            var jsSaveDir = checkDir();
            if (!jsSaveDir || !aefs || typeof aefs.writeFile !== 'function') {
              return jsReceipt('；效果库目录不可用，本次未归档');
            }
            // 等归档结果（如实报）但**有界**：归档写通道（bridge 的
            // writeFileAsync）没有超时——bridge 半死（TCP 可连不响应）时无界等待会把整轮工具调用
            // 挂住（唯一的出口是用户点停止）。超时条说的话是事实（未确认），不假装成功/失败。
            // 超时可被 global.AEShaderTools.JS_ARCHIVE_WAIT_MS 覆盖（测试把它压到几十毫秒）。
            return Promise.race([
              new Promise(function (resolve) {
                resolve(aefs.writeFile(jsSaveDir + '\\' + jsName + '.js', jsCode));
              }).then(function (ok) { return ok ? 'ok' : 'fail'; }, function () { return 'fail'; }),
              new Promise(function (resolve) {
                var ms = (global.AEShaderTools && typeof global.AEShaderTools.JS_ARCHIVE_WAIT_MS === 'number'
                          && global.AEShaderTools.JS_ARCHIVE_WAIT_MS > 0)
                  ? global.AEShaderTools.JS_ARCHIVE_WAIT_MS : 5000;
                setTimeout(function () { resolve('timeout'); }, ms);
              })
            ]).then(function (st) {
              if (st === 'ok') return jsReceipt('；来源已归档为 ' + jsName + '.js');
              if (st === 'timeout') return jsReceipt('；来源归档未在限时内返回（写入可能仍在进行，结果未确认）');
              return jsReceipt('；来源归档写入失败: ' + jsName + '.js');
            });
            });
            });
          },
          scope: { type: 'module', moduleIds: ['shader', 'external-mcp'] },
          stub: false,
          category: 'utility',
          source: 'agent'
        });
      }
    };
  }

  global.AEShaderTools = global.AEShaderTools || {};
  global.AEShaderTools.createShaderTools = createShaderTools;
  global.AEShaderTools.buildSetParamScript = buildSetParamScript;
  // param-map 过期判定的哈希口径（与宿主 paramMap.cpp 同算法；测试/诊断用）
  global.AEShaderTools.hashUtf8 = hashUtf8;
  global.AEShaderTools.captureShaderPreview = captureShaderPreview;
  // 多时间点参数归一（纯函数，供单测直接覆盖；handler 同一入口）
  global.AEShaderTools.normalizePreviewTimes = normalizePreviewTimes;
  // 库索引：纯函数导出供单测（宿主侧文本契约的 JS 侧对照）
  global.AEShaderTools.LIB_INDEX_FILE = LIB_INDEX_FILE;
  global.AEShaderTools.parseLibraryIndex = parseLibraryIndex;
  global.AEShaderTools.diffLibraryNames = diffLibraryNames;
  global.AEShaderTools.hostOrderCmp = hostOrderCmp;
})(window);
