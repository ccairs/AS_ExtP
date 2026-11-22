(function (global) {
  // 与 native/glsl-host/src/uniformParser.cpp 语义对齐（token 扫描）：
  // 白名单 float/vec2/vec3/vec4；跳过内置（宿主注入）；上限 32。
  //
  // 内置名单 = **宿主那两份名单的并集**：
  //   · uniformParser.cpp parseUniforms 的 `bare != "…"` 链（float/vec 类型，21 个）
  //     —— 供本文件 parseUniforms 过滤（漏一个 = 预览把用户声明当参数上传、盖掉内置值）；
  //   · stripBuiltinUniformDecls 的 isBuiltinName（另含 sampler/mat4 共 30 个）
  //     —— 供 stripBuiltinDecls 剥离重复声明（类型白名单挡不住 sampler/mat4）。
  // 合并成一张表：两个用途的判据是同一个"这个名字是内置"，分开写必然漂移。
  //
  // 为什么必须逐名对齐（补齐 13 个名字）：
  //   · 漏过滤的后果（parseUniforms 侧）：面板把该名字注册成**用户参数**，而预览渲染器
  //     _applyCommonUniforms 的上传次序是"内置先、用户参数（_uniformValues）最后"——
  //     幽灵参数会盖掉宿主注入的内置值。uLayerSize / uHasLights / uLightCount 每帧都被
  //     内置写过后又被用户值覆盖：声明了 `uniform vec2 uLayerSize;`（无初始化器 → 默认 0）
  //     的效果，预览里 uLayerSize 恒为 (0,0)（世界坐标/网格换算塌成 0 → 黑屏或全糊），
  //     而 AE 侧宿主剥离该声明、注入真实尺寸照常渲染。uDt 同类（主趟只在有迭代趟时补写）。
  //     uStep/uFrame/uIter/uIterCount 在主趟/迭代趟其后逐帧补写 → 画面不受影响，但面板
  //     会多出"拖了没反应"的假参数（误导用户，也让模型以为这些名字要自己声明）。
  //   · 漏剥离的后果（stripBuiltinDecls 侧）：见该函数注释（面板拒绝 AE 本可跑的 shader）。
  // 跨语言一致性由「名单对齐」用例从源码双向核对。
  var BUILTIN_UNIFORMS = {
    uTime: true, uResolution: true, uAspect: true, uLayerSize: true,
    uHasCam: true, uCamFov: true, uCamPos: true, uCamMatrix: true, uWorldMatrix: true,
    uHasLights: true, uLightCount: true, uLightType: true, uLightPos: true,
    uLightDir: true, uLightColor: true, uLightParams: true,
    uIter: true, uIterCount: true, uStep: true, uFrame: true, uDt: true,
    iChannel0: true, iChannel1: true, iChannel2: true, iChannel3: true,
    iPrev: true, iHistory0: true, iHistory1: true, iHistory2: true, iHistory3: true
  };
  var MAX_PARAMS = 32;
  var TYPE_WHITELIST = { float: 'float', vec2: 'vec2', vec3: 'vec3', vec4: 'vec4' };

  // 剥离 // 行注释与 /* */ 块注释（与 native/glsl-host uniformParser.cpp 状态机语义一致：
  // 行注释优先；未闭合的 /* 吞掉剩余内容）。块注释内保留换行以维持行数
  // （围栏剥离 stripCodeFences/stripFences 依赖行号对齐；对 token 流无影响）。
  function stripComments(src) {
    var out = '';
    var inLine = false;
    var inBlock = false;
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      if (inLine) {
        if (c === '\n') { inLine = false; out += '\n'; }
        continue;
      }
      if (inBlock) {
        if (c === '*' && src[i + 1] === '/') { inBlock = false; i++; out += ' '; }
        else if (c === '\n') { out += '\n'; }
        continue;
      }
      if (c === '/' && src[i + 1] === '/') { inLine = true; i++; out += ' '; continue; }
      if (c === '/' && src[i + 1] === '*') { inBlock = true; i++; out += ' '; continue; }
      out += c;
    }
    return out;
  }

  // 剥离 Markdown 代码围栏（面板 view 与 llmTools 双通道共享单一实现，防语义漂移）。
  // 注释内的围栏样式行不当作围栏：先用 stripComments 检测注释（块注释保留换行维持行数），
  // 提取仍从原始文本（保留注释内容）。
  function stripFences(code) {
    if (code === null || code === undefined) return '';
    var s = String(code);
    var scan = stripComments(s);
    var lines = scan.split(/\r?\n/);
    var sLines = s.split(/\r?\n/);   // 原文行（scan 行号对齐，但内容保留注释）

    // 围栏行检测：捕获语言标签（如 glsl；允许围栏与标签间有空白、标签后尾随词）
    function fenceMeta(line) {
      var m = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/.exec(line);
      if (!m) return null;
      return { ch: m[1][0], label: m[2], isGlsl: /^glsl$/i.test(m[2]) };
    }

    // 优先找带 glsl 标签的围栏对（模型输出代码块几乎总带 ```glsl）；
    // 散文里的 ~~~ 分隔线（无 glsl 标签）不会抢占代码块围栏。
    // requireGlsl 时遇到更新的 glsl 围栏行才重置 start（避免未闭合 glsl 块
    // 被后续散文对抢占）；findPair(false) 保持首个同型对优先、异型视为内容
    function findPair(requireGlsl) {
      var start = -1;
      var startCh = '';
      for (var i = 0; i < lines.length; i++) {
        var f = fenceMeta(lines[i]);
        if (!f) continue;
        if (start === -1) {
          if (!requireGlsl || f.isGlsl) { start = i; startCh = f.ch; }
        } else if (f.ch === startCh) {
          return { start: start, end: i };
        } else if (requireGlsl && f.isGlsl) {
          start = i;
          startCh = f.ch;
        }
      }
      return null;
    }

    var pair = findPair(true);
    if (pair) return sLines.slice(pair.start + 1, pair.end).join('\n').trim();

    // glsl 围栏存在但未闭合（流式截断）：取首个 glsl 围栏之后的内容，
    // 避免其后的散文对在 findPair(false) 中抢占
    for (var i = 0; i < lines.length; i++) {
      var fm = fenceMeta(lines[i]);
      if (fm && fm.isGlsl) return sLines.slice(i + 1).join('\n').trim();
    }

    pair = findPair(false);
    if (pair) return sLines.slice(pair.start + 1, pair.end).join('\n').trim();

    // 无闭合围栏（生成截断）：取首个围栏之后的内容
    for (var i = 0; i < lines.length; i++) {
      if (fenceMeta(lines[i])) return sLines.slice(i + 1).join('\n').trim();
    }
    return s.trim();
  }

  // 初始化器表达式的「本 declarator 段」——逗号链
  //（`uniform highp float a = 1.0, b;`）里初始化器在**顶层逗号**处结束（与宿主
  // C++ initializerBeforeTopLevelComma 逐条同源）。defaultMap 正则的 `([^;]+)` 会把
  // 后续 declarator（b）一起吞进表达式 → parseDefaultValue 判失败 → 面板 default:null
  // 而宿主读到 1.0 —— 同一 shader 两侧滑块初值分叉（该写法语法合法：GLSL ES 1.00 与
  // 桌面 GLSL 的声明语法都递归允许 `COMMA IDENTIFIER`；被拒的是"uniform 带初始化器"
  // 语义，两侧都靠编译前剥离处理）。括号深度感知：vec3(0.1, 0.2, 0.3) 内部逗号不是
  // declarator 分隔符；无顶层逗号时原样返回（单 declarator 行为不变）。
  function initializerBeforeTopLevelComma(expr) {
    var depth = 0;
    for (var i = 0; i < expr.length; i++) {
      var c = expr.charAt(i);
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth > 0) depth--; }
      else if (c === ',' && depth === 0) return expr.slice(0, i);
    }
    return expr;
  }

  // 将初始化器表达式解析为可用默认值：
  // - float 数值 → number
  // - vec2(r,g) → [r, g]；vec3(r,g,b) → [r, g, b]；vec4(r,g,b,a) → [r, g, b, a]
  // 表达式（PI、uTime*0.5 等）或无初始化器 → null。
  // 与 C++ parseInitValues 对齐（vec4 作颜色时按 RGBA 顺序）。
  function parseDefaultValue(expr) {
    if (!expr) return null;
    // 跨行捕获的边界（照抄宿主 parseInitValues 判据）：宿主组件修剪只认空格/制表符，
    // 捕获里一旦残留换行（`0.5\n` 这种分号另起一行、vec 参数跨行）一律解析失败 →
    // 面板同样拒绝，避免"面板读出值、宿主读不出"的新分叉
    if (/[\r\n]/.test(expr)) return null;
    var m4 = /^vec4\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)$/.exec(expr);
    if (m4) return [parseFloat(m4[1]), parseFloat(m4[2]), parseFloat(m4[3]), parseFloat(m4[4])];
    var m3 = /^vec3\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)$/.exec(expr);
    if (m3) return [parseFloat(m3[1]), parseFloat(m3[2]), parseFloat(m3[3])];
    var m2 = /^vec2\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)$/.exec(expr);
    if (m2) return [parseFloat(m2[1]), parseFloat(m2[2])];
    if (/^[-+0-9.eE]+$/.test(expr)) return parseFloat(expr);
    return null;
  }

  // 剥离 uniform 初始化器：GLSL 规范不允许 uniform 带 `= 值`（"cannot initialize this type
  // of qualifier"），面板预览 WebGL 与宿主 330 core 编译都必须剥离后才能编译。
  // 默认值已由 parseUniforms.default 单独提取；编辑区原文保留初始化器供滑块 setUniformDefault 写回。
  // 与 C++ uniformParser.cpp stripUniformInitializers（+）逐条同源
  //（白名单 float/vec2/vec3/vec4）：
  //   · 只剥**初始化器段**、保留逗号链后续 declarator：`uniform float a = 0.5, b;` → `a, b;`
  //     （旧 JS 正则 `=[^;]*;` 整段吞到首个 ';'，b 的声明被删 → 面板编译失败而宿主能跑）；
  //   · 括号深度感知：`vec2(1.0, 2.0)` 内部的逗号不是 declarator 分隔符；
  //   · 注释门控（commentMask，与 C++ commentMaskOf 同一状态机）：头匹配起点落在注释内的
  //     伪声明一律跳过；扫描器对注释区间不解译其中的 ';'/','/括号——纯文本扫描在
  //     `/* uniform float a = */` 上会越过 '*/' 吞到后续代码的 ';'，注释失去闭合符，
  //     其后源码全变注释（所编译源码 ≠ 所见源码）。
  //   · 无深度 0 终结符（截断/畸形）时本段原样保留，对齐 C++ 的 !complete 分支。
  // · 精度限定符：头正则允许 `highp/mediump/lowp` 前缀（`uniform highp float uX = 1.0;`
  //     是 GLSL ES 合法写法）。头正则缺精度前缀时不匹配 → 初始化器留在源码里
  //     → 面板 WebGL 编译报 "cannot initialize this type of qualifier"，而宿主剥离后照常渲染。
  // · 复验（跨语言同源）：重建文本**原样保留**精度限定符（`uniform highp float uX;`）——
  //     宿主 stripUniformInitializers 组 1=精度、组 2=类型、组 3=名字，重建头
  // `"uniform " + (m[1] ? m[1]+" " : "") + type + " " + name`（uniformParser.cpp）。
  //     旧 JS 重建省略精度、注释却宣称「按宿主同款省略」与宿主实现不符（两侧重建文本确定不同）。
  function stripUniformInitializers(source) {
    var src = String(source === null || source === undefined ? '' : source);
    var mask = commentMask(src);
    // 组序与宿主头正则一致：1=精度（可空）、2=类型、3=名字
    var head = /uniform\s+(?:(highp|mediump|lowp)\s+)?(float|vec2|vec3|vec4)\s+([A-Za-z_]\w*)\s*=/g;
    var out = '';
    var pos = 0;
    var m;
    while (pos < src.length) {
      head.lastIndex = pos;
      m = head.exec(src);
      if (!m) { out += src.slice(pos); break; }
      var mstart = m.index;
      var mend = mstart + m[0].length;
      if (mask[mstart]) {                        // 注释内伪声明：注释段原样保留到匹配末尾
        out += src.slice(pos, mend);
        pos = mend;
        continue;
      }
      // 声明链逐段改写：inInit = 当前处于初始化器段（丢弃）；否则原样拷贝，遇 '=' 进入剥离。
      // 深度 0 的 ';' 结束本条声明 → 提交改写；',' 结束初始化器段、后续 declarator 保留。
      // 精度限定符原样回填（与宿主 的重建头同款）
      var repl = 'uniform ' + (m[1] ? m[1] + ' ' : '') + m[2] + ' ' + m[3];
      var inInit = true;
      var depth = 0;
      var complete = false;
      var i = mend;
      for (; i < src.length; i++) {
        if (mask[i]) {                           // 注释区间整体跳过（inInit 时其中的 ; , 括号不参与判定）
          if (!inInit) repl += src[i];           // declarator 段的注释原样保留
          continue;
        }
        var c = src[i];
        if (inInit) {
          if (c === '(' || c === '[' || c === '{') depth++;
          else if (c === ')' || c === ']' || c === '}') { if (depth > 0) depth--; }
          else if (depth === 0 && (c === ',' || c === ';')) {
            repl += c;
            if (c === ';') { complete = true; break; }
            inInit = false;                      // ','：后续 declarator 原样保留
          }                                      // 其余初始化器字符：丢弃
        } else {
          if (c === '=') {
            repl = repl.replace(/\s+$/, '');     // 名字与 '=' 之间空白修剪（`b = 0.6` → `b`）
            inInit = true;                       // 链上后续 declarator 的初始化器：进入剥离
          } else {
            repl += c;
            if (c === ';') {
              repl = repl.replace(/\s+;$/, ';'); // ';' 前空白修剪（对齐 C++ 的 pop_back 循环）
              complete = true;
              break;
            }
          }
        }
      }
      if (!complete) {                           // 无深度 0 终结符：本段原样保留，从声明头之后继续找
        out += src.slice(pos, mend);
        pos = mend;
        continue;
      }
      out += src.slice(pos, mstart) + repl;
      pos = i + 1;
    }
    return out;
  }

  // 内部扫描（单一实现）：返回每条声明 { name, type, default, range, dim }。
  // cap = 注册条数上限——对外 parseUniforms 传 MAX_PARAMS（32，UI 滑块数），槽位审计传 Infinity 取全量。
  // dim 与宿主 uniformParser.cpp 的 arrayDim 同口径：
  //   0 = 无方括号（含 `[0]`：宿主按标量注册 1 槽）  >0 = 数组维度  -1 = 维度无法解析（宿主拒绝该声明）
  // 多维数组（`w[2][3]`）整条不注册（无 dim 值）——宿主/面板只支持一维数组，诊断见 declUsageWarnings。
  function scanUniforms(source, cap) {
    var out = [];
    if (typeof source !== 'string') return out;
    var cleaned = stripComments(source);
    // 初始化器提取：在**剥注释后的整份文本**上全局匹配同一正则族（与宿主
    // uniformParser.cpp 的 defaultMap 段 declRe 同一正则、同一搜寻域）。
    // `=` 后的 `\s*` 可吃换行、`[^;]+` 止于首个 `;` → 初始化器允许跨行
    // （`uniform float uX =\n  0.5;` 两侧都读到 0.5），且绝不会把下一条 uniform
    // 的初始化器吃进来（宿主实现为准的边界判据）。按行匹配时：跨行初始化器
    // 读不到 → 面板滑块/预览按 1.0 起、宿主按 0.5 渲染（两侧同 shader 不同默认值）。
    // 跨侧分叉收口：类型前补可选精度限定符
    // `(?:(?:highp|mediump|lowp)\s+)?`，与宿主 declRe 逐字同形——
    // 缺精度限定符时 `uniform highp float uA = 0.5;` 面板 default:null、宿主读到 0.5，滑块初值
    // 静默不一致；「正则逐字同形」用例
    // 从两侧源码抽取比对，任一侧再漂移即红。
    // token 扫描（下方 toks[i+2]）不含初始化器值，故默认值只在这里取一份。
    var defaultMap = {};
    var rangeMap = {};
    var dre = /uniform\s+(?:(?:highp|mediump|lowp)\s+)?(float|vec2|vec3|vec4)\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g, dm;
    while ((dm = dre.exec(cleaned)) !== null) {
      // 只去空格/制表符：宿主 parseInitValues 同款（跨行捕获里残留的换行会让宿主
      // 解析失败，parseDefaultValue 以同一判据拒绝——见该函数）
      // 先截到顶层逗号（`a = 1.0, b;` → `1.0`），宿主同款
      defaultMap[dm[2]] = initializerBeforeTopLevelComma(dm[3]).replace(/^[ \t]+|[ \t]+$/g, '');
    }
    // 自定义范围 `// @range min max`（行尾注释）：注释被 stripComments 剥除，
    // 需在原始源码行上提取。正则与宿主 uniformParser.cpp 的 rangeRe **逐字同形**
    //（跨侧分叉收口）：类型前补可选精度限定符
    // `(?:(?:highp|mediump|lowp)\s+)?`——缺这段时 `uniform highp float uD;`
    // // @range -2 2` 面板 range:null、宿主取到 [-2,2]，滑块范围静默不一致。
    // 组序随宿主：1=类型、2=名字、3=min、4=max（宿主 m[2..4] 同口径）；JS 侧另有
    // 与宿主的已知差异：min>max 时面板交换，宿主不交换。
    // 「正则逐字同形」用例从两侧源码
    // 抽取比对（JS 的 `\/` 归一化后），任一侧再漂移即红。
    var rawLines = String(source).split(/\r?\n/);
    for (var ri = 0; ri < rawLines.length; ri++) {
      var rm = /uniform\s+(?:(?:highp|mediump|lowp)\s+)?(float|vec2|vec3|vec4)\s+([A-Za-z_]\w*)[^;\n]*;[^\n]*\/\/[^\n]*@range\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/.exec(rawLines[ri]);
      if (rm) {
        var mn = parseFloat(rm[3]), mx = parseFloat(rm[4]);
        if (mx < mn) { var t = mn; mn = mx; mx = t; }   // 容错：min>max 交换
        if (mn === mx) mx = mn + 1.0;                   // 防除零
        rangeMap[rm[2]] = { min: mn, max: mx };
      }
    }
    var toks = normalizeTerminators(cleaned).split(/\s+/);
    // —— 逗号分隔多声明（`uniform float a, b;`）：逐 declarator 链处理（对齐
    //    C++ uniformParser.cpp）——若只取 toks[i+2] 且未截逗号：注册出
    //    "a," 坏名（预览 setUniform 按名查询恒失配 → 滑块无效），后续名字被
    //    词流当独立 token 丢弃（无槽位 → 静默保持 GL 默认值）。
    var i = 0;
    while (i < toks.length) {
      if (toks[i] !== 'uniform') { i++; continue; }
      var typed = toks[i + 1];
      // 精度限定符在前（`uniform highp float uGain;`，GLSL ES 合法写法）：限定符不是类型，
      // 再读一个 token 当类型（与 samplerUsageWarnings 的 reDecl、宿主的
      // 数值路径精度分支、parseSamplerChannels 同款）。不读限定符时 type="highp" 不在白名单
      // → 整条声明静默跳过：无滑块、值恒为 GL 默认 0、零诊断（declUsageWarnings 同款盲区，已一并修）。
      var prec = typed === 'highp' || typed === 'mediump' || typed === 'lowp';
      var type = prec ? toks[i + 2] : typed;
      if (!TYPE_WHITELIST[type]) { i += 3; continue; }   // 对齐 C++：非白名单类型跳过 3 token
      i += prec ? 3 : 2;
      var decl = toks[i];   // 首个 declarator token（可能是 "a" / "a," / "a;" / "a=..." / "a[N]..."）
      while (decl !== undefined) {
        // 畸形输入防御（对齐 C++）：逗号链的下一个 declarator 是 "uniform"
        // （漏分号的 `uniform float a, uniform float b;`）→ 结束本链，交还
        // 外层按新语句扫描。不防御会注册名为 "uniform" 的伪参数且丢失 b。
        // 走到此处的只有嵌入式逗号（",uniform" 无空格粘连，另两路有消费前
        // 守卫）：把 "uniform" 回插 toks（对齐 C++ haveTok 交还语义，外层
        // i++ 后正好落在插入位按新语句处理）
        if (decl === 'uniform') { toks.splice(i + 1, 0, decl); break; }
        // 解析单个 declarator：裸名 + 终结符（; , = 或数组维度 [N]）
        var cut = decl.search(/[;,\[=]/);
        var bare, rest, dim = 0, multiDim = false;
        if (cut === -1) { bare = decl; rest = ''; }
        else {
          bare = decl.slice(0, cut);
          if (decl.charAt(cut) === '[') {
            // 数组后缀清洗（既有行为）：截 [N] 按裸名注册单个参数，终结符到 ']' 之后找
            var rb = decl.indexOf(']', cut);
            var dimText = rb === -1 ? '' : decl.slice(cut + 1, rb);
            dim = /^[0-9]+$/.test(dimText) ? parseInt(dimText, 10) : -1;   // 宿主口径：非空全数字才算维度
            rest = rb === -1 ? '' : decl.slice(rb + 1);
            // 多维数组（`w[2][3]`/`w[2][3][4]`）：宿主与面板只支持一维 uniform 数组，
            // 整条不注册。若只认第一维并注册裸名（另一个维度被静默丢弃）：第一维是 2 时会被
            // uniformLimitWarnings 当 2 槽计数、面板出现一个怎么拖都只改首个元素的死参数。
            // 明确诊断由 declUsageWarnings 的「[uniform 数组不支持] 多维数组」条目给出。
            // 跳过其后所有 [..] 维度组，逗号链的其余 declarator 照常解析（不丢声明）。
            while (rest.charAt(0) === '[') {
              multiDim = true;
              var rb2 = rest.indexOf(']');
              if (rb2 === -1) { rest = ''; break; }
              rest = rest.slice(rb2 + 1);
            }
            // 形态二：维度间夹空白（`w[2] [3]`，GLSL 合法）→ 后续维度是独立 token。
            // 与 C++ 的流预读同款判据（rest 空且第一维可解析 > 0 才预读）：
            // 看到下一 token 以 '[' 开头即判多维并连续消费维度 token，否则不吞流
            // （漏分号的下一条 `uniform` 等交还外层）。不判会先注册出 w（第一维）
            // → 与宿主"整条拒绝"分叉。
            if (!multiDim && rest === '' && dim > 0) {
              while (toks[i + 1] !== undefined && toks[i + 1].charAt(0) === '[') {
                multiDim = true;
                i++;                                     // 消费该维度 token
                var close2 = toks[i].indexOf(']');
                if (close2 === -1) { rest = ''; break; }  // 畸形 `[3`：整条不注册即可
                rest = toks[i].slice(close2 + 1);         // 同 token 尾随字符（罕见）交回链推进
                if (rest.charAt(0) === '[') rest = '';    // 同 token 还有维度：继续看下一 token
                if (rest !== '') break;
              }
            }
          } else {
            rest = decl.slice(cut);
          }
        }
        if (bare && !BUILTIN_UNIFORMS[bare] && !multiDim) {   // 空名（`uniform float ;`）/内置/多维数组跳过，对齐 C++
          if (out.length >= cap) break;
          out.push({ name: bare, type: TYPE_WHITELIST[type], default: defaultMap[bare] !== undefined ? parseDefaultValue(defaultMap[bare]) : null, range: rangeMap[bare] || null, dim: dim });
        }
        // —— 链式走向：',' 继续下一 declarator；'=' / ';' 结束 ——
        var lead = rest.charAt(0);
        if (lead === ';') break;
        if (lead === ',') {
          if (rest.length > 1) { decl = rest.slice(1); continue; }   // ",b;" → "b;"
          // 下一 token 是 "uniform"（漏分号新语句）：i 停在本 token，外层 i++ 后
          // 正好落在 "uniform" 上按新语句处理（链顶部守卫会丢失该语句头）
          if (toks[i + 1] === 'uniform') break;
          decl = toks[++i];                                          // ',' 独立成 token（`a , b;`）
          continue;
        }
        if (lead === '=') {
          // 初始化器：吞至 ';'。GLSL 330 uniform 初始化器非法——stripUniformInitializers
          // 只剥初始化器段（链上后续 declarator 在**编译端**保留）；解析端对齐
          // C++ parseUniforms：初始化器之后的名字不注册（无槽位、不可调），两侧同一分歧已文档化。
          // rest 内已含 ';'（`a=0.5;` 无空格粘连）→ 声明已完整，不得再吞流
          if (rest.indexOf(';') !== -1) break;
          while (++i < toks.length && toks[i].indexOf(';') === -1) {}
          break;
        }
        // rest 空：名字 token 无终结符。peek 下一 token 区分：① 逗号独立成
        // token ② 初始化器 ③ 下一语句首 token（通常 "uniform"）→ 交还外层
        var peek = toks[i + 1];
        if (peek === undefined) break;
        if (peek === ',') {
          // 消费前守卫：逗号后是 "uniform"（漏分号新语句）→ i 停在名字 token，
          // 外层 i++ 逐 token 走到 "uniform" 按新语句处理（先消费会丢语句头）
          if (toks[i + 2] === 'uniform') break;
          decl = toks[i + 2]; i += 2; continue;
        }
        if (peek.charAt(0) === '=') {
          if (peek.indexOf(';') === -1) {
            while (++i < toks.length && toks[i].indexOf(';') === -1) {}
          }
          break;
        }
        break;   // 交还外层：外层 i++ 后从 peek 继续扫描
      }
      i++;
    }
    return out;
  }

  // 对外形状固定 4 个字段（UI 滑块/单测按此结构消费；dim 只是审计用的内部字段）
  function parseUniforms(source) {
    var raw = scanUniforms(source, MAX_PARAMS);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      out.push({ name: raw[i].name, type: raw[i].type, default: raw[i].default, range: raw[i].range });
    }
    return out;
  }

  // uniform 数量超上限诊断：宿主按**槽位**注册、上限 32（kMaxParams），第 33 个
  // 起不注册也不 glUniform（值恒为 GL 默认 0、ECW 无滑条），宿主只往 error.log 写一条英文告警；
  // 面板侧 parseUniforms 会静默截断，故由提交回执给出数量检查——超限时模型与用户都能看到信号。
  // 判据按**宿主槽位口径**（float 数组按元素展开成 w[0..N-1]；vec 数组与坏维度数组宿主整体
  // 拒绝、不占槽位，另有 [uniform 数组]/[uniform 数组不支持] 告警），与
  // native/glsl-host/src/uniformParser.cpp 的注册计数同源。面板侧那个 32 是**条数**（数组算 1 个），
  // 与宿主的槽位数不是同一个数。
  // 返回告警字符串数组（空数组 = 未超限），与 samplerUsageWarnings / declUsageWarnings 同形，
  // 供 shaderTools 的提交回执消费。
  function uniformLimitWarnings(source) {
    var out = [];
    var decls = scanUniforms(String(source === null || source === undefined ? '' : source), Infinity);
    var declared = 0;       // 宿主口径槽位总数
    var droppedSlots = 0;   // 落在上限外的槽位数
    var droppedDecls = 0;   // 有槽位被丢弃的声明条数
    var dropped = [];
    for (var i = 0; i < decls.length; i++) {
      var d = decls[i];
      // 槽位权重：标量（含 `[0]`）1；float 数组 N；vec 数组与坏维度数组 0（宿主拒绝，不占槽位）
      var w = d.dim > 0 ? (d.type === 'float' ? d.dim : 0) : (d.dim === -1 ? 0 : 1);
      if (w <= 0) continue;
      var first = declared < MAX_PARAMS ? MAX_PARAMS - declared : 0;   // 本声明内首个越限元素的下标
      declared += w;
      if (first >= w) continue;                                       // 整条都在上限内
      droppedSlots += w - first;
      droppedDecls++;
      if (dropped.length < 3) {
        dropped.push('`' + (w > 1 ? d.name + '[' + first + '..' + (w - 1) + ']' : d.name) + '`');
      }
    }
    if (!droppedSlots) return out;
    out.push('[uniform 超上限] 宿主按槽位注册（float 数组按元素展开）：源码共 ' + declared + ' 个槽位、上限 '
      + MAX_PARAMS + '，' + dropped.join((typeof AEI18n !== 'undefined' && AEI18n.punct ? AEI18n.punct('、', ', ', '、') : '、')) + (droppedDecls > dropped.length ? '…' : '')
      + '（共 ' + droppedSlots + ' 个槽位）不注册、值恒为 GL 默认 0');
    return out;
  }

  // 注释掩码：与 stripComments 同一状态机口径，但保留**下标**（true = 该字符在注释内）。
  // 为什么不用 stripComments 的结果：剥离内置声明要按原位改写（见 stripBuiltinDecls），
  // 位置必须稳定，而 stripComments 会把注释删掉、位置整体前移。
  function commentMask(src) {
    var mask = [];
    for (var k = 0; k < src.length; k++) mask[k] = false;
    var inLine = false, inBlock = false;
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      if (inLine) { if (c === '\n') inLine = false; else mask[i] = true; continue; }
      if (inBlock) {
        mask[i] = true;
        if (c === '*' && src[i + 1] === '/') { mask[i + 1] = true; inBlock = false; i++; }
        continue;
      }
      if (c === '/' && src[i + 1] === '/') { mask[i] = true; mask[i + 1] = true; inLine = true; i++; continue; }
      if (c === '/' && src[i + 1] === '*') { mask[i] = true; mask[i + 1] = true; inBlock = true; i++; continue; }
    }
    return mask;
  }

  // 重建后的声明链按**原声明段的换行与缩进**铺回（供 stripBuiltinDecls 处理跨行逗号链）。
  // 与宿主 uniformParser.cpp stripBuiltinUniformDecls 的链重建段（:829-839：
  // `out += "uniform " + type; … += ", " + declarator; … += ";"`）**同一保留集合**：
  // 剔除内置 declarator、保留其余（含数组维度）、链尾补 `;`。差异只在排版——宿主侧删行
  // 单行输出，面板原位铺回：行数与逐行长度不变，`#line 1` 的行号映射与
  // 报错列号都不漂。
  // 只在 token 之间断行：换行若落在 token 中间，名字会被切成两个词（GLSL 语法错误）。
  // 末行放不下时该行允许变长（仅"逗号间无空格的畸形链 + 短内置名 uDt"理论上会触发）——
  // 宁可变列，也不丢 token / 不加行；调用方按实际长度决定等长改写还是 splice。
  function layoutChainStatement(stmt, rebuilt) {
    var tokens = rebuilt.split(' ');
    var lines = stmt.split('\n');
    var res = [];
    var ti = 0;
    for (var li = 0; li < lines.length; li++) {
      var cap = lines[li].length;
      var indent = /^[ \t]*/.exec(lines[li])[0];   // 续行缩进保留（旧内容让位给重建的 token）
      var body = '';
      while (ti < tokens.length) {
        var sep = body ? 1 : 0;                    // token 间单空格（与宿主 ", " 重建同形）
        if (indent.length + body.length + sep + tokens[ti].length > cap) {
          if (li === lines.length - 1) {           // 末行兜底：放不下也放（本行变长）
            body += (sep ? ' ' : '') + tokens[ti];
            ti++;
            continue;
          }
          break;
        }
        body += (sep ? ' ' : '') + tokens[ti];
        ti++;
      }
      var pad = cap - indent.length - body.length;
      res.push(indent + body + new Array((pad > 0 ? pad : 0) + 1).join(' '));
    }
    return res.join('\n');
  }

  // 剥离用户源码里对**内置 uniform 的重复声明**（宿主同款语义，见 uniformParser.cpp
  // stripBuiltinUniformDecls）。为什么必须有这一手：GLSL 同作用域同名重复声明是编译
  // 错误——宿主已在拼接前剥离故 AE 能渲染，面板不剥就会**拒绝一份 AE 本可跑的 shader**
  //（实测 WebGL2/ES3：`uniform float uTime;` → "'uTime' : redefinition"；
  // 迁移自 Shadertoy 的代码大量重声明 uTime/uResolution，正是的修复场景）。
  //
  // 与宿主的唯一差异：**原位留白/原位铺排**而不是删行——面板的报错行号靠 buildFragmentSource 的
  // `#line 1` 映射回用户坐标系，删行会让其后所有行号错位。
  //   独立声明 `uniform float uTime;`         → 整条留白（换行保留）
  //   逗号链   `uniform float uTime, uSpeed;` → 重建为 `uniform float uSpeed;` 右侧补空格
  //   跨行链   `uniform float uTime,\n  uSpeed;` → 同一保留集合（剔内置、留其余、链尾补 `;`），
  //            按原换行与缩进铺回——行数/逐行长度不变，见 layoutChainStatement
  //   全内置链 `uniform float uTime, uAspect;`→ 整条留白
  //   注释内伪声明 / 非内置名（uTimer、xuTimey）/ 形态非预期（带 `=` 初始化器的链，
  //   调用方应先过 stripUniformInitializers）→ 原样不动
  // 类型前允许精度限定符（`uniform highp float uTime;`）——旧头正则把 highp 当头一个
  // 类型词，m[1]="highp" 后声明链扫描从 float 起（非 ';'）立即放弃 → 重复声明残留 →
  // 面板拒绝 AE 本可跑的 shader。
  // 复验（跨语言同源）：重建链**保留**精度限定符——头正则组 1 取整段头
  // "uniform [precision ]type"（与宿主 uniformParser.cpp 头正则同款），重建时整段回填
  //（宿主测试 test_precision_qualifier_strip 断言 `uniform highp float uSpeed;`）。
  // 旧 JS 头只捕类型、重建 `'uniform ' + type` 丢掉精度，两侧重建文本确定不同。
  function stripBuiltinDecls(src) {
    var s = String(src === null || src === undefined ? '' : src);
    var mask = commentMask(s);
    var out = s.split('');
    var shift = 0;                 // 声明段被铺成更长文本（末行兜底）时的累计长度差
    // 组 1 = 整段头 "uniform [precision ]type"（宿主同款；重建链时原样回填）
    var head = /\b(uniform\s+(?:(?:highp|mediump|lowp)\s+)?[A-Za-z_]\w*)\s*/g;
    var m;
    while ((m = head.exec(s)) !== null) {
      var mstart = m.index, mend = mstart + m[0].length;
      if (mask[mstart]) continue;                       // 注释内伪声明：不动
      var i = mend, names = [], chainOk = false;
      while (true) {
        while (i < s.length && !mask[i] && /\s/.test(s[i])) i++;
        if (i >= s.length || mask[i] || !/[A-Za-z_]/.test(s[i])) break;
        var nb = i;
        while (i < s.length && !mask[i] && /[A-Za-z0-9_]/.test(s[i])) i++;
        var name = s.slice(nb, i);
        var dtext = name;
        while (i < s.length && !mask[i] && /\s/.test(s[i])) i++;
        if (i < s.length && !mask[i] && s[i] === '[') {
          var rb = s.indexOf(']', i);
          if (rb < 0 || mask[rb]) break;
          dtext += s.slice(i, rb + 1);
          i = rb + 1;
          while (i < s.length && !mask[i] && /\s/.test(s[i])) i++;
        }
        names.push({ text: dtext, builtin: !!BUILTIN_UNIFORMS[name] });
        if (i < s.length && !mask[i] && s[i] === ',') { i++; continue; }
        if (i < s.length && !mask[i] && s[i] === ';') { i++; chainOk = true; break; }
        break;                                          // '=' 等非预期 → 放弃本条
      }
      if (!chainOk) continue;
      var anyBuiltin = false, keep = [];
      for (var k = 0; k < names.length; k++) {
        if (names[k].builtin) anyBuiltin = true;
        else keep.push(names[k].text);
      }
      if (!anyBuiltin) continue;
      var stmt = s.slice(mstart, i);
      var repl;
      if (!keep.length) {
        repl = stmt.replace(/[^\n]/g, ' ');              // 全内置：整条留白（换行保留）
      } else {
        // 剔除内置 declarator、保留其余、链尾补 `;`（与宿主重建段同一保留集合）；
        // 单行链同样走这里（结果 = 重建文本 + 右侧补空格）。
        // m[1] 是整段头（含精度限定符），原样回填 → 重建保留 `uniform highp float …`
        repl = layoutChainStatement(stmt, m[1] + ' ' + keep.join(', ') + ';');
      }
      if (repl.length === stmt.length) {
        for (var q = 0; q < stmt.length; q++) out[mstart + shift + q] = repl.charAt(q);
      } else {
        // 末行兜底造成的变长（理论路径，见 layoutChainStatement）：splice 替换声明段，
        // 后续写入下标随 shift 平移。行数仍不变（改进文本只在末行，未新增 '\n'）。
        out.splice.apply(out, [mstart + shift, stmt.length].concat(repl.split('')));
        shift += repl.length - stmt.length;
      }
      head.lastIndex = i;                                // 改写区不再扫描
    }
    return out.join('');
  }

  // 终结符归一化（与宿主 normalizeTerminators 同款）：把 `;` 与 `,`
  // 两侧补空格，**仅用于分词**——粘连写法（`uniform float uA;uniform float uB;`）会让 `uniform`
  // 与上一条的 `;` 落进同一个 token，下一条声明整条被静默丢弃（滑块消失、值恒为 GL 默认 0），
  // 而宿主/面板两侧都不报错。正则扫描（@range / 默认值 / 采样器诊断）一律用未归一化的原文。
  function normalizeTerminators(s) {
    return String(s == null ? '' : s).replace(/([;,])/g, ' $1 ');
  }

  // 采样器用法诊断：把宿主侧两条"不报错的坑"前移到**面板提交
  // 回执**里，让模型当场看见（宿主只写进 AE 的 error.log，而面板轮正是
  // 模型唯一在干活的地方）：
  //   ① 采样了 iChannelN 却**没声明** `uniform sampler2D iChannelN;`：骨架恒声明这三个名字
  //      → 编译必过；但宿主按**用户源码里的声明**置 channelsUsed → 该行不启用、不检出、
  //      采样恒透明黑。预览也绑透明黑 → 与"声明了但选 <none>"画面完全相同，无从区分。
  //   ② 声明了**别的** sampler 名（Shadertoy 习惯的 uMyTex…）→ 宿主不会绑定它；预览里更糟：
  //      未注入 uniform1i 的 sampler 默认指向单元 0 = iChannel0 的输入占位图（看着像生效了）。
  // 返回告警字符串数组（空数组 = 干净）。判据与宿主 uniformParser.cpp 的同名诊断同口径
  // （词边界匹配、剥注释、内置名不告警）。
  // 边界：文本级判据——形参/局部变量同名遮蔽、`#if 0` 死代码、
  // 仅宏体里出现都会命中（故文案用"若它指的就是…"留余地）；令牌粘贴宏 `iChannel##n` 会漏掉。
  function samplerUsageWarnings(src) {
    var out = [];
    var s = stripComments(String(src === null || src === undefined ? '' : src));
    var usedAsWord = function (name) {
      return new RegExp('(^|[^A-Za-z0-9_])' + name + '([^A-Za-z0-9_]|$)').test(s);
    };
    var declared = {};
    var otherSamplerDecls = [];
    // 类型可带精度限定符在前（`uniform highp samplerCube x;`）；整数采样器 isampler2D/usampler2D
    // 同属"宿主不支持"（面板侧由此点名，宿主侧不报错）。
    // 名字组**可空**（`uniform samplerCube;` 这类漏名字的畸形形态若正则不匹配，面板侧就
    // 静默，而宿主会告警——两侧必须同口径；无名时只点名类型）。
    var reDecl = /uniform\s+(?:(?:highp|mediump|lowp)\s+)?([iu]?sampler\w*)\s*([^;]*);/g, m;
    while ((m = reDecl.exec(s)) !== null) {
      var type = m[1];
      var names = [];
      m[2].split(',').forEach(function (piece) {
        var n = piece.trim().replace(/\[[^\]]*\]/g, '').split('=')[0].trim();
        if (/^[A-Za-z_]\w*$/.test(n)) names.push(n);
      });
      if (type !== 'sampler2D') {
        // 非 2D sampler（samplerCube/3D/2DArray…，常从 Shadertoy 的 env map 代码搬来）：
        // 宿主只认 sampler2D，这类声明不会被绑定、采样无效——宿主编译链与预览链
        // 全都静默
        if (!names.length) otherSamplerDecls.push(type);
        else names.forEach(function (n) { otherSamplerDecls.push(n + '（' + type + '）'); });
      } else {
        names.forEach(function (n) { declared[n] = true; });
      }
    }
    if (otherSamplerDecls.length) {
      // 标签与宿主 error.log 的同款（`[不支持的采样器类型]`）——契约按这个标签点名，
      // 面板回执里必须能检索到
      out.push('[不支持的采样器类型] 源码声明了 ' + otherSamplerDecls.join((typeof AEI18n !== 'undefined' && AEI18n.punct ? AEI18n.punct('、', ', ', '、') : '、')) +
        '——宿主只支持 `sampler2D`（iChannel0/iChannel1/2/3/iHistory0..3），这类 sampler 不会被绑定、采样无效');
    }
    ['iChannel1', 'iChannel2', 'iChannel3'].forEach(function (n) {
      if (!declared[n] && usedAsWord(n)) {
        out.push('源码里出现了 ' + n + '，但没有声明 `uniform sampler2D ' + n +
          ';`——若它指的就是宿主那个映射图层通道，则效果控件里那一行不会启用、采样恒为全透明黑（那行声明才是开关）');
      }
    });
    Object.keys(declared).forEach(function (n) {
      if (BUILTIN_UNIFORMS[n]) return;   // 内置名（iChannel0..3 / iHistory0..3 / iPrev / uTime…）
      out.push('`' + n + '` 不是宿主提供的 sampler：宿主只绑定 iChannel0（本图层输入）、' +
        'iChannel1/2/3（映射图层）、iHistory0..3（输入历史）与 iPrev（迭代趟内部）——' +
        '它不会被绑定，采样结果不是你要的图（改用 iChannel1/2/3，或先把那张图并进 iChannel0）');
    });
    return out;
  }

  // 声明形态诊断——与 samplerUsageWarnings 同一消费点
  //（submit_shader / submit_js_effect 的提交回执）。三类"违反契约却两侧全静默"：
  //   ① uniform 类型不在支持面（int/bool/mat…）：面板词流跳过 3 个 token、宿主 supported()
  //      直接 continue，**两处都不写告警** → 没有槽位、值恒为 GL 默认 0，模型与用户都看不出
  //   ② 用户 uniform 写成数组：宿主只展开 **float** 数组（按元素成 w[0..N-1] 槽位，元素默认 1.0，与无初始化器的 float 同规则），
  //      vec 数组整条拒绝并写 error.log（标签 [uniform 数组不支持]）；面板一律按裸名注册**单个**
  //      参数 → 两侧参数个数不同。**多维数组**（`w[2][3]`）宿主与面板都只支持一维 → 整条不注册，
  //      单列一条明确告警（只取第一维会静默截断出死参数）
  //   ③ 灯光数组用**常量下标**（契约硬性规则要求动态下标）：宿主只查 `[0]` 的位置再按 8 个
  //      连续元素上传 → 其余元素无位置（读到全零）或越界写；面板预览没有灯光（uHasLights=0），
  //      这条在模型唯一能自测的通道里结构上不可达
  // 剥注释后扫描（注释里的示例/说明不算）；sampler 类型归 samplerUsageWarnings（不双报）；
  // 内置名跳过（骨架已声明，用户重声明由 stripBuiltinDecls 留白）。
  // 类型可带精度限定符在前（`uniform highp float uGain;`，与 samplerUsageWarnings 的 reDecl
  // 同款）：类型组不含限定符时，type 取成 "highp" → 名字组被吃掉，既解析不出也零告警。
  function declUsageWarnings(src) {
    var out = [];
    var s = stripComments(String(src === null || src === undefined ? '' : src));
    var badTypes = [], floatArrays = [], vecArrays = [], multiArrays = [];
    var re = /uniform\s+(?:(?:highp|mediump|lowp)\s+)?([A-Za-z_]\w*)\s+([^;]*);/g, m;
    while ((m = re.exec(s)) !== null) {
      var type = m[1];
      if (/sampler/.test(type)) continue;              // sampler 归 samplerUsageWarnings
      var names = [];
      m[2].split(',').forEach(function (piece) {
        var nm = piece.trim().split('=')[0].trim();
        var brackets = (nm.match(/\[/g) || []).length;
        var isArr = brackets > 0;
        var isMultiArr = brackets > 1;                 // `w[2][3]`：多维（宿主与面板都不支持）
        nm = nm.replace(/\[[^\]]*\]/g, '').trim();
        if (!/^[A-Za-z_]\w*$/.test(nm)) return;
        if (BUILTIN_UNIFORMS[nm]) return;              // 内置名不在支持面讨论范围内
        names.push({ name: nm, isArr: isArr, isMultiArr: isMultiArr });
      });
      if (!names.length) continue;
      if (!TYPE_WHITELIST[type]) {
        names.forEach(function (n) { badTypes.push('`' + type + ' ' + n.name + '`'); });
        continue;
      }
      names.forEach(function (n) {
        if (n.isMultiArr) { multiArrays.push('`' + type + ' ' + n.name + '[][]`'); return; }
        if (!n.isArr) return;
        (type === 'float' ? floatArrays : vecArrays).push('`' + type + ' ' + n.name + '[]`');
      });
    }
    if (badTypes.length) {
      out.push('[不支持的 uniform 类型] ' + badTypes.join((typeof AEI18n !== 'undefined' && AEI18n.punct ? AEI18n.punct('、', ', ', '、') : '、')) + '——宿主与面板都只注册 `float`/'
        + '`vec2`/`vec3`/`vec4` 参数，这些声明会被跳过：效果控件里没有对应滑条、值恒为 GL 默认 0'
        + '（改用 `float` 参数按阈值判断，或把常量直接写进代码）');
    }
    if (floatArrays.length) {
      out.push('[uniform 数组] ' + floatArrays.join((typeof AEI18n !== 'undefined' && AEI18n.punct ? AEI18n.punct('、', ', ', '、') : '、')) + '：宿主按元素展开成 N 个槽位（元素默认 1.0，与无初始化器的 float 同规则），'
        + '面板预览按裸名注册 1 个参数——两侧参数个数不同');
    }
    if (vecArrays.length) {
      out.push('[uniform 数组不支持] ' + vecArrays.join((typeof AEI18n !== 'undefined' && AEI18n.punct ? AEI18n.punct('、', ', ', '、') : '、')) + '：宿主只展开 `float` 数组，'
        + '这些声明不注册、值恒为 GL 默认 0；面板预览按裸名注册 1 个参数');
    }
    if (multiArrays.length) {
      out.push('[uniform 数组不支持] 多维数组 ' + multiArrays.join((typeof AEI18n !== 'undefined' && AEI18n.punct ? AEI18n.punct('、', ', ', '、') : '、')) + '：宿主与面板都只支持一维 uniform 数组'
        + '（float 一维数组按元素展开成 N 个槽位）、多维数组整条不注册、值恒为 GL 默认 0'
        + '，面板预览也没有对应参数');
    }
    // 灯光数组的常量下标：**先摘掉 uniform 声明语句**（`uniform float uLightPos[8];` 的方括号是
    // 声明维度，不是使用下标——不摘会把合法声明误报成常量下标）
    var usageText = s.replace(/uniform\s+[^;]*;/g, ' ');
    var lightArr = /(^|[^A-Za-z0-9_])(uLight(?:Type|Pos|Dir|Color|Params))\[\s*[0-9]+\s*\]/g;
    var hits = [];
    while ((m = lightArr.exec(usageText)) !== null) if (hits.indexOf(m[2]) < 0) hits.push(m[2]);
    if (hits.length) {
      out.push('[灯光数组常量下标] ' + hits.join((typeof AEI18n !== 'undefined' && AEI18n.punct ? AEI18n.punct('、', ', ', '、') : '、')) + '：宿主只查 `[0]` 的 uniform 位置、再按 8 个元素连续上传，'
        + '用常量下标时其余元素可能拿不到位置（读到全零）或越界写——必须动态下标：'
        + '`for (int i = 0; i < 8; i++) { if (i >= int(uLightCount)) break; …uLightPos[i]… }`'
        + '（另：面板预览没有灯光，uHasLights 恒 0，这条只能到 AE 里验证）');
    }
    return out;
  }

  // 写回 uniform 默认值：替换 `uniform <type> <name> = <init>;` 的初始化器；
  // 无初始化器时追加 ` = <value>`。value: float 数值 或 [x,y]/[x,y,z]/[x,y,z,w] 数组。
  // 找不到声明 → 原样返回。**注释门控**（commentMask，与 strip* 系列同一状态机）：
  // 匹配起点落在注释内的伪声明（`// uniform float uAmount = 0.5;`）跳过并继续找下一条——
  // 直接 replace 首个匹配时，调用方（shaderUI.setUniformDefaultValue）传的是编辑器
  // 原文：注释伪声明在真实声明之前时写回改到注释、真实声明不变（250ms 后重编译滑块值回弹）。
  // 类型前允许精度限定符（`uniform highp float uGain;`，GLSL ES
  // 合法、parseUniforms/strip* 均已支持）。旧两条正则要求 `uniform` 后紧跟类型 → 带精度
  // 声明均不匹配 → 原样返回，shaderUI 见 newCode === code 提前 return：滑块调整永远到不了
  // AE（宿主 C++ 的 defaultMap/rangeRe 同口径）。$1 含限定符 → 输出原样保留精度。
  function setUniformDefault(source, name, value) {
    var s = String(source || '');
    var esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    function render(v) {
      if (Array.isArray(v)) {
        if (v.length === 2) return 'vec2(' + v[0] + ', ' + v[1] + ')';
        if (v.length === 3) return 'vec3(' + v[0] + ', ' + v[1] + ', ' + v[2] + ')';
        return 'vec4(' + v[0] + ', ' + v[1] + ', ' + v[2] + ', ' + v[3] + ')';
      }
      return String(v);
    }
    var mask = commentMask(s);
    // 首个**不在注释内**的匹配替换：全局 exec 逐次试探，命中注释区间时 lastIndex 只前进 1
    //（不跳到匹配末尾——伪声明的匹配可能跨出注释吞掉其后的真实声明，如
    // `// uniform float uA =\nuniform float uA;` 的 `[^;]*` 会吃到真实声明的 `;`）。
    function replaceFirstOutsideComment(reSrc, build) {
      var re = new RegExp(reSrc, 'g');
      var m;
      while ((m = re.exec(s)) !== null) {
        if (mask[m.index]) { re.lastIndex = m.index + 1; continue; }
        return s.slice(0, m.index) + build(m) + s.slice(m.index + m[0].length);
      }
      return null;
    }
    var withInit = replaceFirstOutsideComment(
      '(uniform\\s+(?:(?:highp|mediump|lowp)\\s+)?(?:float|vec2|vec3|vec4)\\s+' + esc + '\\s*=\\s*)[^;]*;',
      function (m) { return m[1] + render(value) + ';'; });
    if (withInit !== null) return withInit;
    var noInit = replaceFirstOutsideComment(
      '(uniform\\s+(?:(?:highp|mediump|lowp)\\s+)?(?:float|vec2|vec3|vec4)\\s+' + esc + ')\\s*;',
      function (m) { return m[1] + ' = ' + render(value) + ';'; });
    if (noInit !== null) return noInit;
    return s;
  }

  // 颜色语义判定（与 native/glsl-host/src/uniformParser.cpp isColorNamed 同口径）：
  // 整词 color/colour（词边界），或短词 col/tint/rgb/bg（词尾后至多一个字符段，
  // 可隔一个 '_'）。词首边界 = 串首 / 非字母数字 / 驼峰（前小写接本词首大写）。
  // 短词后接普通词干不算颜色：colOffset / bgDir / tintSpeed 仍按分量控件。
  function isColorNamed(name) {
    var n = String(name == null ? '' : name);
    function isAlnum(c) { return /[A-Za-z0-9]/.test(c); }
    function isUpper(c) { return c >= 'A' && c <= 'Z'; }
    function isLower(c) { return c >= 'a' && c <= 'z'; }
    function wordStart(i) {
      if (i === 0) return true;
      if (!isAlnum(n.charAt(i - 1))) return true;
      return isUpper(n.charAt(i)) && isLower(n.charAt(i - 1));
    }
    function wordEnd(e) {
      if (e >= n.length) return true;
      var c = n.charAt(e);
      return !isAlnum(c) || isUpper(c);
    }
    function segmentTail(e) {
      var k = e;
      if (k >= n.length) return true;
      if (n.charAt(k) === '_') k++;
      if (k >= n.length) return true;
      return isAlnum(n.charAt(k)) && k + 1 === n.length;
    }
    function find(word, tailOk) {
      for (var i = 0; i + word.length <= n.length; i++) {
        if (n.substr(i, word.length).toLowerCase() !== word) continue;
        if (!wordStart(i)) continue;
        if (tailOk && !tailOk(i + word.length)) continue;
        return true;
      }
      return false;
    }
    if (find('color', wordEnd) || find('colour', wordEnd)) return true;
    var shorts = ['col', 'tint', 'rgb', 'bg'];
    for (var i = 0; i < shorts.length; i++) {
      if (find(shorts[i], segmentTail)) return true;
    }
    return false;
  }

  global.AEEffectLab = global.AEEffectLab || {};
  global.AEEffectLab.parseUniforms = parseUniforms;
  global.AEEffectLab.setUniformDefault = setUniformDefault;
  global.AEEffectLab.isColorNamed = isColorNamed;   // 面板预览按此选色块控件，与宿主同一判据表
  global.AEEffectLab.stripUniformInitializers = stripUniformInitializers;
  global.AEEffectLab.stripComments = stripComments;   // 供 glslValidator 预检复用（单一实现防语义漂移）
  // 供 glslValidator.buildFragmentSource 在拼接前调用（面板侧的：宿主已剥离，
  // 面板不剥就会拒绝一份 AE 本可渲染的 shader——见本函数注释）
  global.AEEffectLab.stripBuiltinDecls = stripBuiltinDecls;
  global.AEEffectLab.stripFences = stripFences;       // 供 view/llmTools 围栏剥离复用（单一实现防语义漂移）
  global.AEEffectLab.samplerUsageWarnings = samplerUsageWarnings;   // 供 shaderTools 的提交回执复用
  global.AEEffectLab.declUsageWarnings = declUsageWarnings;         // 同上（循环检查）
  global.AEEffectLab.uniformLimitWarnings = uniformLimitWarnings;   // 同上（数量超 32 上限）
})(window);
