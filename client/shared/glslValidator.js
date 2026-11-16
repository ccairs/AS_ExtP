(function (global) {
  // 拼接宿主同款片元着色器骨架（WebGL2→GLSL ES 300，WebGL1→ES 100 + texture 宏兼容）
  // pass：'main'（默认，入口 mainImage）| 'iterate'（入口 iterateImage）。
  // 与宿主 renderer.cpp buildFragmentSource 的 iteratePass 参数一一对应——两侧
  // 内置声明段必须逐字同构，只有末尾包装的 main() 不同。
  function buildFragmentSource(body, isEs3, pass) {
    // 拼接前剥离用户源码里对**内置 uniform 的重复声明**（面板侧补齐，
    // 实测发现面板缺这一手）：GLSL 同作用域同名重复声明是编译错误，
    // 宿主 renderer.cpp 已在拼接前剥离（故 AE 能渲染），面板不剥就会**拒绝一份
    // AE 本可跑的 shader**——WebGL2/ES3 实测 `uniform float uTime;` 直接报
    // "'uTime' : redefinition"（迁移自 Shadertoy 的代码大量重声明 uTime/uResolution）。
    // 剥离放在**唯一拼接点**：三条编译通路（compileCheck / compileCheckAsync /
    // 预览渲染器 setSource）与 warmup 一并受益，不必逐调用点补。
    // 剥离按行原位留白（见 uniformParser.stripBuiltinDecls），下方 `#line 1` 的
    // 行号映射不受影响——这是它与宿主"删行"实现的唯一差异。
    if (global.AEEffectLab && typeof global.AEEffectLab.stripBuiltinDecls === 'function') {
      body = global.AEEffectLab.stripBuiltinDecls(body);
    }
    var entry = (pass === 'iterate') ? 'iterateImage' : 'mainImage';
    var head = isEs3
      ? '#version 300 es\nprecision highp float;\n'
      : '#version 100\nprecision highp float;\n#define texture texture2D\n';
    var io = isEs3
      ? 'in vec2 vUv;\nout vec4 fragColor;\n'
      : 'varying vec2 vUv;\n';
    var main = isEs3
      ? 'void main(){fragColor=' + entry + '(vUv,uTime);}'
      : 'void main(){gl_FragColor=' + entry + '(vUv,uTime);}';
    return head +
      // 映射图层输入（与宿主 renderer.cpp 同步，缺声明即报错：
      // iChannel1..3，用映射图层的 shader 面板校验必炸 undeclared identifier 而宿主正常）
      'uniform sampler2D iChannel0;\n' +
      'uniform sampler2D iChannel1;\n' +
      'uniform sampler2D iChannel2;\n' +
      'uniform sampler2D iChannel3;\n' +
      'uniform float uTime;\n' +
      'uniform vec2 uResolution;\n' +
      'uniform float uAspect;\n' +
      // L4 全分辨率尺寸（与宿主 renderer.cpp buildFragmentSource 同步）：
      // 源图层的完整分辨率宽高，**与预览下采样档位无关**。uResolution 是效果像素、
      // 会随预览缩放，不可用于推导世界空间位置/长度——需要分辨率无关的尺寸基准时用本变量。
      'uniform vec2 uLayerSize;\n' +
      // L2 相机感知内置（与宿主 renderer.cpp buildFragmentSource 同步；shader
      // 未使用时被驱动剔除，零开销）。面板预览注入一台可操控的虚拟相机
      // （uHasCam=1，左键旋转/右键推拉/中键平移，见 shaderPreviewRenderer CAM_* 常量），
      // 宿主侧为真实 AE 相机数据。
      'uniform float uHasCam;\n' +
      'uniform float uCamFov;\n' +
      'uniform vec3 uCamPos;\n' +
      'uniform mat4 uCamMatrix;\n' +
      'uniform mat4 uWorldMatrix;\n' +
      // L3 灯光感知内置（与宿主 renderer.cpp buildFragmentSource 同步，两侧类型
      // 必须逐字一致——否则面板校验通过、宿主编译失败，或反之）。面板预览无 AE
      // 灯光——预览渲染器注入 uHasLights=0 / uLightCount=0 / 数组全零，宿主侧为
      // 真实合成灯光。数组**必须动态下标访问**（以 uLightCount 为循环上界），
      // 见 aeLights.h 的数组访问约定。
      'uniform float uHasLights;\n' +
      'uniform float uLightCount;\n' +
      'uniform float uLightType[8];\n' +
      'uniform vec3 uLightPos[8];\n' +
      'uniform vec3 uLightDir[8];\n' +
      'uniform vec3 uLightColor[8];\n' +
      'uniform vec4 uLightParams[8];\n' +
      // 迭代趟内置（与宿主 renderer.cpp buildFragmentSource 同步）：
      // 帧内多趟 ping-pong 迭代。iPrev = 上一趟输出（第 0 趟 = 输入图层）；
      // uIter = 当前趟号（0 基；主趟取趟数本身）；uIterCount = 本帧总趟数。
      // 未使用时被驱动剔除，零开销。
      'uniform sampler2D iPrev;\n' +
      'uniform float uIter;\n' +
      'uniform float uIterCount;\n' +
      // 结算器内置（与宿主 renderer.cpp 同步）：
      // uStep = **绝对步号**（@iterations 下每帧归零、@solve 下跨帧累计），
      // 故 `if (uStep < 0.5) 播种` 在两种模式下都写对；uFrame = 合成帧号
      //（预览没有时间轴，恒 0）。
      'uniform float uStep;\n' +
      'uniform float uFrame;\n' +
      // uDt = 每子步真实秒数（与宿主 renderer.cpp 同步）：
      // @solve/@iterations = 帧时长/子步数；@solveHz = 1/Hz。物理积分用它做 dt，
      // 解算速率与合成帧率解耦。
      'uniform float uDt;\n' +
      // I2a 输入历史（与宿主 renderer.cpp 同步，缺声明即报错，
      // 官方示例 example_history_trail 在面板校验直接 undeclared identifier 报错）。
      // 未声明 @history 头时采样无纹理可绑（宿主侧全透明黑），预览侧回落输入占位纹理
      'uniform sampler2D iHistory0;\n' +
      'uniform sampler2D iHistory1;\n' +
      'uniform sampler2D iHistory2;\n' +
      'uniform sampler2D iHistory3;\n' +
      io +
      // 骨架在用户代码前拼了 13 行（ES3 与 ES100 两条分支
      // 等长），而驱动报错按整份源码的行号计数——用户第 3 行被报成 0:16（偏移 +13），
      // LLM 按报错行号回改会改到无关行。#line 是 GLSL 预处理器指令，声明紧随其后的
      // 行号为 1，使此后所有编译错误自动回到用户坐标系，且同步/异步两条校验通道同时
      // 受益；骨架增删行无需再同步维护行号偏移常量。
      // 注意 io 段以 \n 结尾，#line 必须落在行首。
      '#line 1\n' +
      (body || '') + '\n' +
      main + '\n';
  }

  function buildVertexSource(isEs3) {
    return isEs3
      ? '#version 300 es\nin vec2 aPos;out vec2 vUv;void main(){vUv=aPos*0.5+0.5;gl_Position=vec4(aPos,0.0,1.0);}'
      : 'attribute vec2 aPos;varying vec2 vUv;void main(){vUv=aPos*0.5+0.5;gl_Position=vec4(aPos,0.0,1.0);}';
  }

  // —— 迭代趟：与宿主 uniformParser.cpp 的 hasIteratePass /
  // parseIterations 同口径（两侧必须一致，否则面板放行、宿主行为不同）——
  // 迭代趟默认趟数与上限（宿主 kDefaultIterations / kMaxIterations）
  var ITER_DEFAULT = 8, ITER_MAX = 64;

  // 是否定义了 iterateImage 入口。只认「返回类型前缀 + 名字 + (」的定义形态
  //（纯调用不算）；注释内的伪定义不算——与宿主 hasIteratePass 的注释门控一致。
  function hasIteratePass(src) {
    var text = String(src || '');
    var noCmt = text
      .replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); })
      .replace(/\/\/[^\n]*/g, '');
    return /\bvec4\s+iterateImage\s*\(/.test(noCmt);
  }

  // 解析 `// @iterations N`（文件级，取首个匹配）。未声明 → ITER_DEFAULT；
  // 非法/越界 → 钳制到 [1, ITER_MAX]。
  // —— 结算器：与宿主 uniformParser.cpp 的
  // parseSolveSteps / parseSolveRes / parseIterConfig 同口径 ——
  var SOLVE_DEFAULT = 8, SOLVE_MAX = 64;      // 宿主 kDefaultSolveSteps / kMaxSolveSteps
  var SOLVEHZ_MAX = 4096;                     // 宿主 kMaxSolveHz（每帧另有 SOLVE_MAX=64 硬顶）
  var RES_DEFAULT = 512, RES_MIN = 64, RES_MAX = 2048;

  // `// @solve N`：结算器每帧子步数。未声明 → 0（= 非结算模式）。
  function parseSolveSteps(src) {
    // 此处曾写成 /@solve\sS+([0-9]+)/ —— \sS+ 是"一个空白 + 一个
    // 或多个字面 S"，于是任何真实写法 `// @solve 32` 都匹配不上 → parseIterConfig 永不
    // 返回 solver → 面板预览把结算器 shader 当帧内迭代跑（uStep 每帧归零，播种型 shader
    // 每帧重撒种子，画面永远停在起始期）。宿主那边一直是 \s+，两侧就此分叉。
    // 这个正则必须与宿主 uniformParser.cpp 的 R"(@solve\s+([0-9]+))" 同构，不要凭观感换成别的写法。
    var m = String(src || '').match(/@solve\s+([0-9]+)/);
    if (!m) return 0;
    var v = (m[1].length > 6) ? SOLVE_MAX : parseInt(m[1], 10);
    if (!isFinite(v)) return 0;
    if (v < 1) v = 1;
    if (v > SOLVE_MAX) v = SOLVE_MAX;
    return v;
  }
  // `// @solveRes N`：仿真网格长边。未声明 → 0（调用方取默认值）。
  function parseSolveRes(src) {
    var m = String(src || '').match(/@solveRes\s+([0-9]+)/);   // 同上：曾是 \sS+
    if (!m) return 0;
    var v = (m[1].length > 6) ? RES_MAX : parseInt(m[1], 10);
    if (!isFinite(v)) return 0;
    if (v < RES_MIN) v = RES_MIN;
    if (v > RES_MAX) v = RES_MAX;
    return v;
  }
  // `// @solveHz N`：结算器每秒子步数（真实时间驱动）。未声明 → 0。
  // 与宿主 uniformParser.cpp 的 R"(@solveHz\s+([0-9]+))" 同构；`@solve\s+` 要求
  // "@solve" 后是空白，"@solveHz 400"（后跟 'H'）不会被 @solve 的正则误吞。
  function parseSolveHz(src) {
    var m = String(src || '').match(/@solveHz\s+([0-9]+)/);
    if (!m) return 0;
    var v = (m[1].length > 6) ? SOLVEHZ_MAX : parseInt(m[1], 10);
    if (!isFinite(v)) return 0;
    if (v < 1) v = 1;
    if (v > SOLVEHZ_MAX) v = SOLVEHZ_MAX;
    return v;
  }
  // 模式判定（与宿主 parseIterConfig 同优先级：@solveHz > @solve > @iterations > 默认）。
  // 返回 { mode: 'none'|'stateless'|'solver', stepsPerFrame, simDim, solveHz }。
  // solveHz > 0 时 stepsPerFrame 无效（每帧子步数由渲染侧按帧率推导）。
  function parseIterConfig(src) {
    var text = String(src || '');
    var hz = parseSolveHz(text);
    if (hz > 0) return { mode: 'solver', stepsPerFrame: 0, simDim: parseSolveRes(text), solveHz: hz };
    var solve = parseSolveSteps(text);
    if (solve > 0) return { mode: 'solver', stepsPerFrame: solve, simDim: parseSolveRes(text), solveHz: 0 };
    if (hasIteratePass(text)) return { mode: 'stateless', stepsPerFrame: parseIterations(text), simDim: 0, solveHz: 0 };
    return { mode: 'none', stepsPerFrame: 0, simDim: 0, solveHz: 0 };
  }


  // 指令诊断：三类**两侧都不报错**的写法，前移到面板的提交回执
  //（消费点见 shaderTools 的 usageNote），让模型当场看见并改写：
  //   ① 指令字面量在、形态不被识别（`@solve: 8` / `@solve=8` / 裸写 `@solve`）——正则要求
  //      "指令后紧跟空白 + 数字" → 静默按**帧内迭代**跑：uStep 每帧归零、`uStep < 0.5` 的
  //      播种分支每帧重进、状态永不跨帧；且面板预览与 AE 一致地这么跑，连"两侧不一致"这条
  // 线索都没有。
  //   ② 数值超限被静默钳制（写 128 → 生效 64；写 4096 → 生效 2048）——写下的参数与实际不符。
  //   ③ 结算模式但没有 `iterateImage`：宿主按 `cfg.mode != None` 必编迭代趟（入口 wrap 成
  //      iterateImage），编不过走**错误帧**；而面板预览只编主趟、照常出图（正反馈，比沉默更坏）。
  // 判据一律复用本文件的解析函数（parseSolveSteps/parseSolveRes/parseSolveHz/parseIterations/
  // hasIteratePass），不另写一套正则 → 不会与渲染侧口径漂移。
  // `@history` 例外：面板侧没有帧数解析器（预览一律绑 4 张历史纹理，用不到帧数），这里的
  // 正则只做"字面量在/不在"的探测；权威实现是宿主 uniformParser.cpp 的 parseHistoryFrames。
  // 文本级判据的已知误报面：正文/字符串里出现同名字面量也会命中——保守方向（提示改写成注释形态）。
  function iterDirectiveWarnings(src) {
    var out = [];
    var s = String(src === null || src === undefined ? '' : src);
    var wrote = function (name) { return new RegExp('@' + name + '(?![A-Za-z])').test(s); };
    var numOf = function (name) {
      var m = new RegExp('@' + name + '\\s+([0-9]+)').exec(s);
      return m ? parseInt(m[1], 10) : null;
    };
    var steps = parseSolveSteps(s), hz = parseSolveHz(s), res = parseSolveRes(s);
    // ① 形态不被识别
    if (wrote('solve') && steps === 0 && hz === 0) {
      out.push('[`@solve` 未被识别] 源码里出现了 `@solve`，但没解析到子步数——要求写成 `// @solve 8`'
        + '（`@solve` 后**紧跟空白 + 数字**；`@solve: 8`、`@solve=8`、裸写 `@solve` 都不生效）。'
        + '当前按**帧内迭代**跑：uStep 每帧归零、`uStep < 0.5` 的播种分支每帧重进，状态不会跨帧累积'
        + '（流体/粒子/波前会永远停在起始期）');
    }
    if (wrote('solveHz') && hz === 0) {
      out.push('[`@solveHz` 未被识别] 要求写成 `// @solveHz 60`（后紧跟空白 + 数字）——当前按 '
        + '@solve / @iterations / 帧内迭代的优先级继续判定，解算速率不是你要的每秒子步数');
    }
    if (wrote('solveRes') && res === 0) {
      out.push('[`@solveRes` 未被识别] 要求写成 `// @solveRes 512`（后紧跟空白 + 数字）——当前仿真网格取默认 512');
    }
    if (wrote('iterations') && numOf('iterations') === null) {
      out.push('[`@iterations` 未被识别] 要求写成 `// @iterations 8`（后紧跟空白 + 数字）——当前按默认 '
        + ITER_DEFAULT + ' 趟跑');
    }
    if (wrote('history') && numOf('history') === null) {
      out.push('[`@history` 未被识别] 要求写成 `// @history 1`（后紧跟空白 + 数字）——宿主按**未声明**处理：'
        + 'iHistoryN 绑不到纹理、采样恒全透明黑（面板预览看不出来，它一律绑输入占位图）');
    }
    // ② 钳制（写出的数字与生效值不一致）
    var clamp = function (name, effective, range) {
      var w = numOf(name);
      if (w !== null && w !== effective) {
        out.push('[`@' + name + '` 被钳制] 写的是 ' + w + '，实际生效 ' + effective + '（' + range + '）');
      }
    };
    clamp('solve', steps, '每帧子步数范围 1–' + SOLVE_MAX);
    clamp('solveRes', res, '网格长边范围 64–' + RES_MAX);
    clamp('solveHz', hz, '每秒子步数范围 1–' + SOLVEHZ_MAX + '，且每帧另有 ' + SOLVE_MAX + ' 子步硬顶');
    if (numOf('iterations') !== null) clamp('iterations', parseIterations(s), '趟数范围 1–' + ITER_MAX);
    // ③ 入口缺失（结算模式 / 迭代指令与 iterateImage 不配套）
    if ((steps > 0 || hz > 0) && !hasIteratePass(s)) {
      out.push('[`@solve` 缺少 iterateImage] 已按**结算模式**解析（每帧'
        + (hz > 0 ? '按 ' + hz + ' 子步/秒推导' : ' ' + steps + ' 个子步') + '），但源码里没有 `iterateImage`——'
        + '宿主会编迭代趟（入口 wrap 成 iterateImage），编不过就走**错误帧**（AE 里是错误画面）；'
        + '面板预览只编主趟、照常出图，**别以预览通过为准**。补 `vec4 iterateImage(vec2 fragCoord, float time)`（骨架见契约「结算器」节）');
    } else if (wrote('iterations') && !hasIteratePass(s)) {
      out.push('[`@iterations` 无迭代趟可跑] 声明了 ' + parseIterations(s) + ' 趟，但源码里没有 `iterateImage`——'
        + '没有迭代入口 → 实际只渲染单趟（面板与宿主都不会报错）');
    }
    return out;
  }

  function parseIterations(src) {
    var m = String(src || '').match(/@iterations\s+([0-9]+)/);
    var v = ITER_DEFAULT;
    if (m) {
      v = (m[1].length > 6) ? ITER_MAX : parseInt(m[1], 10);
      if (!isFinite(v)) v = ITER_DEFAULT;
    }
    if (v < 1) v = 1;
    if (v > ITER_MAX) v = ITER_MAX;
    return v;
  }

  // 宏定义名称表展开（compileCheck 预检与 view mainImage 形态校验共用单一实现）：
  // `#define NAME VAL` → 正文中 NAME 替换为 VAL；与宿主编译语义一致——
  // 如 `#define texture2D texture` + 正文 texture2D(...) 展开为 texture(...)，避免误报。
  // 函数式宏不参与对象展开：仅 `#define NAME(`（左括号紧贴宏名）才是函数式宏，
  // `#define NAME (expr)` 左括号前有空白属对象宏（宏体为 (expr)）——两者不可混淆。
  function expandMacros(text) {
    var macroMap = {};
    var rawLines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < rawLines.length; i++) {
      if (!/^\s*#define\s+([A-Za-z_]\w*)/.test(rawLines[i])) continue;
      if (/^\s*#define\s+[A-Za-z_]\w*\(/.test(rawLines[i])) continue;  // 函数式宏（( 紧贴宏名）跳过
      var dm = /^\s*#define\s+([A-Za-z_]\w*)\s*(.*)$/.exec(rawLines[i]);
      var val = dm[2].trim();
      // 反斜杠-换行消除与宿主编译（C/GLSL 翻译阶段 2，贪心）一致：行尾反斜杠+换行即续行，
      // 删除最后一个反斜杠后拼接下一行（\\+换行同样续行，无奇偶之分）；while 直到行尾无反斜杠
      while (/\\$/.test(val) && i + 1 < rawLines.length) {
        val = val.replace(/\\\s*$/, '') + ' ' + rawLines[++i].trim();
      }
      macroMap[dm[1]] = val;
    }
    if (Object.keys(macroMap).length === 0) return text;
    var out = String(text || '');
    // 多趟迭代展开（上限 8 趟），支持链式宏别名；互环宏在趟数上限处确定性终止
    for (var pass = 0; pass < 8; pass++) {
      var replaced = out.replace(/\b([A-Za-z_]\w*)\b/g, function (w) {
        return Object.prototype.hasOwnProperty.call(macroMap, w) ? macroMap[w] : w;
      });
      if (replaced === out) break;
      out = replaced;
    }
    return out;
  }

  // 收集函数式宏（#define NAME( ... ) 宏体）：仅左括号紧贴宏名才算函数式宏；
  // 宏体含续行拼接，供被调用时的 legacy 词预检使用（不参与对象展开）。
  function collectFnMacros(text) {
    var fn = {};
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = /^\s*#define\s+([A-Za-z_]\w*)\(/.exec(lines[i]);
      if (!m) continue;
      var val = lines[i].slice(lines[i].indexOf('('));
      while (/\\$/.test(val) && i + 1 < lines.length) {
        val = val.replace(/\\\s*$/, '') + ' ' + lines[++i].trim();
      }
      fn[m[1]] = val;
    }
    return fn;
  }

  // legacy 语法预检（纯正则，无 WebGL 开销）：宿主为 GLSL 330 core，texture2D 及其
  // ES 100 扩展函数族（texture2DProj/texture2DLod/textureCube/shadow2D 等）与 ES 100
  // 专有内置/限定符（gl_FragColor/gl_FragData/varying/attribute）均已被移除，而
  // WebGL1 环境（ES 100）仍支持——若不加预检会出现"面板校验通过但宿主编译失败"的
  // 假阳性。用与 uniformParser 同源的 stripComments 剥离注释（字符级状态机，无行/
  // 块注释顺序依赖），再检测函数调用形式。独立导出供 shaderPreviewRenderer setSource
  // 复用——预览只需预检（实际编译在预览上下文完成），避免同一份源码在两个 WebGL
  // 预检报错定位：在**原始源码**（未剥注释/未展开宏）里找同一模式的首个命中，换算 1-based 行号。
  // 预检正文经过剥注释 → 宏展开 → 去预处理器行三步改写，行号与用户源码已不对应，
  // 故只能回到原文重找（regex 必须非 global：global 的 match() 不回传 index）。
  // 返回 0 = 找不到（惰性报错，不阻断）。
  function firstMatchLine(src, re) {
    var m = String(src || '').match(re);
    if (!m || typeof m.index !== 'number') return 0;
    var line = 1;
    for (var i = 0; i < m.index; i++) {
      if (src.charCodeAt(i) === 10) line++;
    }
    return line;
  }
  // 行号提示后缀（0 = 无提示）
  function lineHint(line) {
    return line > 0 ? '（首次出现在第 ' + line + ' 行）' : '';
  }

  // 上下文各编译一遍（首次加载 / LLM 提交 shader 的主线程卡顿来源之一）。
  function precheckGlsl(source) {
    var src = String(source || '');
    // GLSL 规范不允许 uniform 带初始化器（"cannot initialize this type of qualifier"）：
    // 编译前剥离 `uniform float uX = 0.5;` 的初始化器，默认值由 parseUniforms 单独提取。
    // 与宿主 uniformParser.cpp stripUniformInitializers 语义对齐（同白名单 float/vec2/vec3/vec4）。
    if (global.AEEffectLab && typeof global.AEEffectLab.stripUniformInitializers === 'function') {
      src = global.AEEffectLab.stripUniformInitializers(src);
    }
    // 与宿主对称：剥 UTF-8 BOM，避免带 BOM 源码在面板编译时报假阴性
    if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
    // 行号定位基准（下面对 src 的各种改写只在本变量之后发生；stripUniformInitializers 只动
    // 行内文本、不改行数，故此时的行号与用户源码一致）
    var locatorSrc = src;
    var body = (global.AEEffectLab && typeof global.AEEffectLab.stripComments === 'function')
      ? global.AEEffectLab.stripComments(src)
      : src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // 函数式宏表在对象宏展开前收集（此时宏定义行未受展开污染）
    var fnMacros = collectFnMacros(body);
    body = expandMacros(body);

    // 剥掉预处理器行（#define texture2D ... 这类函数式宏在 330 core 合法，不应误报）；
    // 以 \ 结尾的宏定义跨行，其续行一并吞掉
    var cleaned = [];
    var inContinuation = false;
    var lines = body.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      if (inContinuation) {
        if (!/\\\s*$/.test(lines[i])) inContinuation = false;
        continue;
      }
      if (/^\s*#/.test(lines[i])) {
        if (/\\\s*$/.test(lines[i])) inContinuation = true;
        continue;
      }
      cleaned.push(lines[i]);
    }
    body = cleaned.join('\n');
    // 函数式宏 legacy 预检：宏在正文被调用时宿主会把宏体展开入正文，宏体内 legacy 词
    // （texture2D 族/ES100 专有语法）必随展开进入 → 宿主 330 core 编译失败；面板若不预检
    // 会出现"面板通过宿主失败"假阳性。未调用的宏不展开，不产生 legacy 词 → 不误报。
    var fnNames = Object.keys(fnMacros);
    for (var fi = 0; fi < fnNames.length; fi++) {
      if (!new RegExp('\\b' + fnNames[fi] + '\\s*\\(').test(body)) continue;  // 宏未被调用
      var fnLegacy = fnMacros[fnNames[fi]].match(/\b(?:texture2D|texture2DProj|texture2DLod|texture2DProjLod|textureCube|textureCubeLod|shadow2D|shadow2DProj|texture2DRect|texture2DRectProj)\s*\(|\b(?:gl_FragColor|gl_FragData|varying|attribute)\b/);
      if (fnLegacy) {
        // 宏体内命中：位置报**宏定义行**（改动点是宏定义处，不是调用处）
        var fnDefLine = firstMatchLine(locatorSrc, new RegExp('^\\s*#\\s*define\\s+' + fnNames[fi] + '\\b', 'm'));
        return { ok: false, error: (fnLegacy[0].trim() || fnLegacy[0]).replace(/\s*\($/, '') + ' 在函数式宏 ' + fnNames[fi] + ' 体内，宿主（GLSL 330 core）已移除该写法' + lineHint(fnDefLine) };
      }
    }
    var legacyFn = body.match(/\b(?:texture2D|texture2DProj|texture2DLod|texture2DProjLod|textureCube|textureCubeLod|shadow2D|shadow2DProj|texture2DRect|texture2DRectProj)\s*\(/);
    if (legacyFn) {
      return { ok: false, error: (legacyFn[0].trim() || 'texture2D').replace(/\s*\($/, '') + ' 在宿主（GLSL 330 core）中已移除，请改用 texture() 等' + lineHint(firstMatchLine(locatorSrc, /\b(?:texture2D|texture2DProj|texture2DLod|texture2DProjLod|textureCube|textureCubeLod|shadow2D|shadow2DProj|texture2DRect|texture2DRectProj)\s*\(/)) };
    }
    // ES 100 专有内置/限定符在 330 core 已移除（WebGL1 环境面板可编译 → 假阳性）
    var legacyId = body.match(/\b(?:gl_FragColor|gl_FragData|varying|attribute)\b/);
    if (legacyId) {
      return { ok: false, error: legacyId[0] + ' 在宿主（GLSL 330 core）已移除，请改用 ES 3.0 语法（out/in）' + lineHint(firstMatchLine(locatorSrc, /\b(?:gl_FragColor|gl_FragData|varying|attribute)\b/)) };
    }
    // 桌面 GLSL 内置 noise 族撞名预检：GLSL 1.30 内置 noise1/2/3/4（如 vec2 noise2(vec2)）
    // 标记废弃但 NVIDIA 桌面驱动在 330 core 下仍暴露——用户定义 float noise2(vec2) 与内置
    // 同参数签名不同返回类型，GLSL 要求重载返回类型一致 → 宿主编译必失败；而 WebGL2 走
    // ES 300，ES 规范从无 noise 族，面板正常 → 「面板过、宿主挂」假阳性（实测案例：ocean
    // 的 float noise2(vec2)，驱动报 overloaded functions must have the same return type）。
    // 仅拦「用户定义」形态（声明/定义带返回类型前缀），纯调用内置 noise2(...) 合法（返回
    // vec2 可用）不误报。
    var noiseDef = body.match(/\b(?:float|vec[234]|int|bool|mat[234]|mat[23]x[234]|uint|void)\s+(noise[1234])\s*\(/);
    if (noiseDef) {
      return { ok: false, error: noiseDef[1] + ' 与桌面 GLSL 内置 noise 族函数同名（宿主 330 core 下 NVIDIA 驱动仍暴露该内置），用户重载返回类型不一致会导致宿主编译失败；WebGL 面板（ES 规范无此内置）不受影响属假阳性。请改名（如 ' + noiseDef[1] + 'd / my' + noiseDef[1] + '）' + lineHint(firstMatchLine(locatorSrc, /\b(?:float|vec[234]|int|bool|mat[234]|mat[23]x[234]|uint|void)\s+(?:noise[1234])\s*\(/)) };
    }
    // 入口撞名预检：宿主把用户源码拼进 `void main(){fragColor=mainImage(...);}` 再编译
    //（buildFragmentSource），用户自带 main 必然重复定义/链接失败。规则已写进契约
    //（"不定义 main()"），此处给带行号的确定性拦截，省一次编译失败往返。
    var mainDef = body.match(/\bvoid\s+main\s*\(/);
    if (mainDef) {
      return { ok: false, error: '定义 main() 与宿主入口撞名（宿主自行拼接 main，调用 mainImage）；请改为只实现 vec4 mainImage(vec2 fragCoord, float time)' + lineHint(firstMatchLine(locatorSrc, /\bvoid\s+main\s*\(/)) };
    }
    return { ok: true };
  }

  // WebGL 编译校验（仅编译链接，不渲染）。返回 { ok, error? }
  function compileCheck(source) {
    // legacy 语法预检（宿主 GLSL 330 core 对齐，详见 precheckGlsl）：失败直接返回，
    // 不浪费一次 WebGL 编译
    var pre = precheckGlsl(source);
    if (pre && pre.ok === false) return pre;
    // WebGL 编译用剥离初始化器后的源码（GLSL 规范不允许 uniform 带初始化器，
    // 默认值由 parseUniforms 单独提取）
    var src = String(source || '');
    if (global.AEEffectLab && typeof global.AEEffectLab.stripUniformInitializers === 'function') {
      src = global.AEEffectLab.stripUniformInitializers(src);
    }
    if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
    var ctx = getGl();
    var gl = ctx.gl;
    var isEs3 = ctx.isEs3;
    if (!gl) return { ok: false, skip: true, error: '当前环境无 WebGL，跳过编译校验（AE 宿主仍会编译）' };
    if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) {
      _gl = null;       // 重置单例，下次调用惰性重建
      _glChecked = false;
      return { ok: false, skip: true, error: 'WebGL 上下文已丢失，编译校验已跳过' };
    }

    function compile(type, text) {
      var s = gl.createShader(type);
      if (!s) return { err: 'shader 创建失败' };
      gl.shaderSource(s, text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        var log = gl.getShaderInfoLog(s) || 'unknown';
        gl.deleteShader(s);
        return { err: log };
      }
      return { shader: s };
    }

    // 逐趟编译链接：迭代趟存在时两趟都要过——宿主两趟都编译，只校验主趟会让
    //「面板放行、宿主挂」的假阳性从主趟挪到迭代趟（迭代趟编译失败会让整个效果
    // 进错误帧，而错误信息只在宿主侧可见）。
    var passes = hasIteratePass(src) ? ['main', 'iterate'] : ['main'];
    for (var pi = 0; pi < passes.length; pi++) {
      var label = (passes[pi] === 'iterate') ? '迭代趟(iterateImage): ' : '';
      var vs = compile(gl.VERTEX_SHADER, buildVertexSource(isEs3));
      if (vs.err) return { ok: false, error: '顶点着色器: ' + vs.err };
      var fs = compile(gl.FRAGMENT_SHADER, buildFragmentSource(src, isEs3, passes[pi]));
      if (fs.err) {
        gl.deleteShader(vs.shader);  // vs 已编译成功，须清理（与宿主 renderer.cpp 对称）
        return { ok: false, error: label + '片元着色器: ' + fs.err };
      }

      var prog = gl.createProgram();
      gl.attachShader(prog, vs.shader);
      gl.attachShader(prog, fs.shader);
      gl.linkProgram(prog);
      gl.deleteShader(vs.shader);
      gl.deleteShader(fs.shader);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        var linkLog = gl.getProgramInfoLog(prog) || 'unknown';
        gl.deleteProgram(prog);
        return { ok: false, error: label + '链接失败: ' + linkLog };
      }
      gl.deleteProgram(prog);
    }
    return { ok: true };
  }

  // 异步编译校验（结果形状与 compileCheck 完全一致，返回 Promise）：KHR_parallel_shader_compile
  // 扩展可用时编译/链接在驱动线程进行，主线程仅以 ~16ms 间隔轮询 COMPLETION_STATUS_KHR
  // （非阻塞查询）——同步 compileCheck 在查询 COMPILE_STATUS/LINK_STATUS 时会阻塞主线程
  // 直至驱动完成（CEF/ANGLE 下数十~数百 ms），是 LLM 提交 shader 时面板 UI 卡顿的主因。
  // 扩展不可用（无 WebGL / 旧 CEF）时退化为同步语义（立即 finish，等价旧 compileCheck）。
  // 供 shaderTools（submit_shader/submit_js_effect 工具校验）使用——工具 handler 本就
  // 以 Promise 结算，多等几帧不影响工具协议，UI 却全程可响应。
  function compileCheckAsync(source) {
    return new Promise(function (resolve) {
      var pre = precheckGlsl(source);
      if (pre && pre.ok === false) { resolve(pre); return; }
      var src = String(source || '');
      if (global.AEEffectLab && typeof global.AEEffectLab.stripUniformInitializers === 'function') {
        src = global.AEEffectLab.stripUniformInitializers(src);
      }
      if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
      var ctx = getGl();
      var gl = ctx.gl;
      var isEs3 = ctx.isEs3;
      if (!gl) { resolve({ ok: false, skip: true, error: '当前环境无 WebGL，跳过编译校验（AE 宿主仍会编译）' }); return; }
      if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
        _gl = null;
        _glChecked = false;
        resolve({ ok: false, skip: true, error: 'WebGL 上下文已丢失，编译校验已跳过' });
        return;
      }
      var khr = (typeof gl.getExtension === 'function') ? gl.getExtension('KHR_parallel_shader_compile') : null;
      // 提交阶段全部非阻塞：compileShader/linkProgram 立即返回，真正的编译链接在驱动侧。
      // 迭代趟存在时两趟一起提交（与同步 compileCheck 同口径：宿主两趟都编译，
      // 只校验主趟会让「面板放行、宿主挂」的假阳性挪到迭代趟）。共享同一个 vs。
      var passNames = hasIteratePass(src) ? ['main', 'iterate'] : ['main'];
      var vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, buildVertexSource(isEs3));
      gl.compileShader(vs);
      var fsList = [], progList = [];
      for (var pi = 0; pi < passNames.length; pi++) {
        var fsX = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fsX, buildFragmentSource(src, isEs3, passNames[pi]));
        gl.compileShader(fsX);
        var progX = gl.createProgram();
        gl.attachShader(progX, vs);
        gl.attachShader(progX, fsX);
        gl.linkProgram(progX);
        fsList.push(fsX);
        progList.push(progX);
      }
      function cleanup() {
        gl.deleteShader(vs);
        for (var i = 0; i < fsList.length; i++) {
          gl.deleteShader(fsList[i]);
          gl.deleteProgram(progList[i]);
        }
      }
      // 完成阶段：此刻驱动侧已出结果，查询即时返回（不再阻塞）
      function finish() {
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
          var vlog = gl.getShaderInfoLog(vs) || 'unknown';
          cleanup();
          resolve({ ok: false, error: '顶点着色器: ' + vlog });
          return;
        }
        for (var pi2 = 0; pi2 < passNames.length; pi2++) {
          var label = (passNames[pi2] === 'iterate') ? '迭代趟(iterateImage): ' : '';
          if (!gl.getShaderParameter(fsList[pi2], gl.COMPILE_STATUS)) {
            var flog = gl.getShaderInfoLog(fsList[pi2]) || 'unknown';
            cleanup();
            resolve({ ok: false, error: label + '片元着色器: ' + flog });
            return;
          }
          if (!gl.getProgramParameter(progList[pi2], gl.LINK_STATUS)) {
            var llog = gl.getProgramInfoLog(progList[pi2]) || 'unknown';
            cleanup();
            resolve({ ok: false, error: label + '链接失败: ' + llog });
            return;
          }
        }
        cleanup();
        resolve({ ok: true });
      }
      if (!khr) { finish(); return; }  // 无并行编译扩展：同步结算（等价旧 compileCheck）
      // 轮询两条纪律（与 shaderPreviewRenderer 的 setSource 同款，
      // 「编译最后几秒准备显示的时候会卡顿」修正）：
      //   ① 覆盖本次提交的**全部** program——finish() 逐个查 COMPILE_STATUS/LINK_STATUS，
      //      任一 program 未编完时那个查询就是同步等待；迭代趟是独立 program，可能比主趟晚完成。
      //   ② **不设**"超时即同步查询"的兜底——10s 上限一到就 finish()，巨型 shader 的
      //      剩余编译全部变成主线程同步等待（实测冻 92s）。完成位不返回时 Promise 不 settle。
      (function poll() {
        var done = true;
        try {
          for (var pi3 = 0; pi3 < progList.length; pi3++) {
            if (!gl.getProgramParameter(progList[pi3], khr.COMPLETION_STATUS_KHR)) { done = false; break; }
          }
        } catch (_) { done = true; }
        if (!done) { setTimeout(poll, 16); return; }
        finish();
      })();
    });
  }

  // WebGL 上下文单例：避免每次编译校验新建 canvas 造成上下文耗尽（Chromium 约 16 个上限）
  var _gl = null;
  var _isEs3 = false;
  var _glChecked = false;
  function getGl() {
    if (_glChecked) return { gl: _gl, isEs3: _isEs3 };
    try {
      var canvas = document.createElement('canvas');
      var g = canvas.getContext('webgl2');
      _isEs3 = !!g;
      if (!g) g = canvas.getContext('webgl');
      _gl = g;
    } catch (_) { _gl = null; }
    _glChecked = !!_gl;   // 创建失败不缓存，下次可重试（如上下文槽位释放后）
    return { gl: _gl, isEs3: _isEs3 };
  }

  // 预热校验上下文（幂等）：创建 WebGL 单例并做一次最小编译，把首次 getContext 的
  // 驱动初始化开销（CEF 下可达数百 ms）从首次 compileCheck（LLM 提交 shader 的校验
  // 时刻）挪到进入 shader/外接模式后的空闲时刻（shaderUI schedulePreviewInit 调度）。
  // 编译失败静默：真实编译路径（compileCheck）会给出完整错误。
  function warmup() {
    var ctx = getGl();
    var gl = ctx.gl;
    if (!gl) return;
    try {
      var s = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(s, buildFragmentSource('vec4 mainImage(vec2 f,float t){return vec4(0.0);}', ctx.isEs3));
      gl.compileShader(s);
      gl.deleteShader(s);
    } catch (_) {}
  }

  global.AEEffectLab = global.AEEffectLab || {};
  global.AEEffectLab.buildFragmentSource = buildFragmentSource;
  global.AEEffectLab.compileCheck = compileCheck;
  global.AEEffectLab.compileCheckAsync = compileCheckAsync;  // 异步编译校验（KHR 并行编译扩展，不阻塞主线程）
  global.AEEffectLab.precheckGlsl = precheckGlsl;   // 供 shaderPreviewRenderer setSource 复用（免 WebGL 的 legacy 预检）
  global.AEEffectLab.warmup = warmup;               // 校验上下文预热（进入 shader/外接模式空闲时调用）
  global.AEEffectLab.expandMacros = expandMacros;   // 供 view mainImage 形态校验复用
  // 迭代趟：与宿主 uniformParser.cpp 同口径，供预览渲染器与
  // 工具面（shaderTools 提交提示）判断该 shader 是否走迭代循环
  global.AEEffectLab.hasIteratePass = hasIteratePass;
  global.AEEffectLab.parseIterations = parseIterations;
  global.AEEffectLab.ITER_DEFAULT = ITER_DEFAULT;
  global.AEEffectLab.ITER_MAX = ITER_MAX;
  // 结算器（@solve）：与宿主 uniformParser.cpp 同口径
  global.AEEffectLab.parseSolveSteps = parseSolveSteps;
  global.AEEffectLab.parseSolveRes = parseSolveRes;
  global.AEEffectLab.parseSolveHz = parseSolveHz;
  global.AEEffectLab.parseIterConfig = parseIterConfig;
  // 指令诊断：供 shaderTools 的提交回执复用——"指令没被识别 /
  // 被钳制 / 与 iterateImage 不配套"三类面板与宿主都不报错，故在提交回执里点名（详见函数头注释）
  global.AEEffectLab.iterDirectiveWarnings = iterDirectiveWarnings;
  global.AEEffectLab.SOLVE_DEFAULT = SOLVE_DEFAULT;
  global.AEEffectLab.SOLVE_MAX = SOLVE_MAX;
  global.AEEffectLab.RES_DEFAULT = RES_DEFAULT;
})(window);
