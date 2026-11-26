(function (global) {
  // L2 相机感知：预览期矩阵默认值（列主序单位阵，与宿主无相机兜底语义一致）
  var IDENTITY_MAT4 = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

  // —— 预览相机（可操控轨道相机：面板预览期「暂时替代 AE 相机矩阵」）——
  // 预览不注入 uHasCam=0 + 单位阵——那会逼 shader 走自建相机分支：既无法检查相机联动
  // 写法，也无法换个角度看场景。现改为注入一台鼠标操控的虚拟相机，取值与宿主
  // aeCamera.h **逐位同构**（列 [0]/[1]/[2] = 右/上/前（前 = 视线方向），列 [3].xyz =
  // 相机位置），故 shader 标准配方 rd = uCamMatrix[2]*uCamFov + uCamMatrix[0]*ndc.x +
  // uCamMatrix[1]*ndc.y（ndc = uv*2.0，边到边 ±1）在预览与 AE 里等价——预览所见即 AE 所见。
  // 默认取景对齐 AE 默认相机（50mm / 1920×1080：zoom = 2666.6666…px）：
  // 正面（yaw=pitch=0，视线 +z）、瞄准**画面中心**、距离使整个世界可见（contain + 边距）。
  // 世界比例 == 视口比例（同源，见 _worldSizeOf），故默认取景 = 整幅画面铺满预览框。
  // 用户一旦拖拽即交出控制权（不再自动取景）；◎ 复位键恢复默认取景。
  // uCamFov = 1/tan(垂直半视场)，与宿主 cameraFovFromPlane 同形（距离 / (像平面高/2)）。
  // 取值 = AE 默认 50mm 相机在 1920×1080 上：zoom 2666.6666…px、像平面高 1080 → 半视场 11.4476°
  // （全视场 22.90°）。半视场由系数反推，使取景距离与注入值描述同一台相机。
  var CAM_FOV_COEF = (8000 / 3) / (1080 / 2);          // ≈ 4.9382716
  var CAM_HALF_FOV_Y = Math.atan(1 / CAM_FOV_COEF);    // ≈ 0.19979825 rad = 11.4476°
  var CAM_FIT_MARGIN = 1.06;                          // 默认取景边距（整层四周各留 6%）
  var CAM_PITCH_LIMIT = 1.5533;                       // 俯仰限位 ±89°：视线与世界上方向共线会让右向量叉乘退化
  var CAM_DIST_MIN = 1;                               // 距离下限（像素）：防穿到目标点内部/归一化除零
  var CAM_DIST_MAX = 1e6;                             // 距离上限：防缩放到数值失稳
  var CAM_ORBIT_PER_PX = 0.01;                        // 旋转灵敏度（弧度/像素，约 0.57°/px）
  var CAM_ZOOM_PER_PX = 0.005;                        // 推拉灵敏度（指数：200px ≈ 2.7 倍距离）
  // —— 预览的世界模型：**画面框即图层** ——
  // 世界宽度恒 WORLD_W（尺度锚点：shader 里"200 单位"的半径在 1920 宽的世界里占 10.4%
  // 宽，与挂在 1920 宽图层上同量级），世界高度由**画面框的比例**推出（见 _worldSizeOf）。
  // 于是 uLayerSize : uAspect : 视口三者比例恒等——shader 按 uLayerSize 铺满全层的写法
  // 在预览里正好铺满所见画面，不会各说各话。
  // 不再假定 AE 的真实尺寸：同一个 shader 会挂到不同尺寸的实例上，探测也解决不了
  // （每个效果实例的图层大小都可能不同），所以预览只承诺"在所见这个比例的图层上正确"。
  var WORLD_W = 1920;
  var WORLD_ASPECT_FALLBACK = 16 / 9;   // 画布尚无尺寸（未布局/离屏/切模式瞬间）时的兜底比例

  // shader 实时预览渲染器：WebGL 全屏 quad + buildFragmentSource 骨架，rAF 每帧绘制。
  // 与 compileCheck 的校验单例（glslValidator getGl）分离：预览用独立 canvas 上下文。
  // deps: { getCanvas(): canvas, getContext(): gl|null, onStatus?(status),
  //         getGridBaseSize?(): number }
  // getGridBaseSize：结算网格长边的封顶基数（像素）。缺省 0 = 用绘制缓冲长边（面板预览的
  // 既有口径：网格不超过可见画布，不为看不见的细节买单）。离屏抓帧传 @solveRes 上限，
  // 让网格按 shader 声明的分辨率建，而不是被输出图尺寸二次封顶。
  function createShaderPreviewRenderer(deps) {
    deps = deps || {};
    var _canvas = null, _gl = null, _isEs3 = false;
    var _program = null, _buffer = null;
    // —— 迭代趟 ——
    // _programIter：iterateImage 的 program（无迭代趟时为 null → 单趟路径）
    // _uniformLocsIter：迭代趟的 uniform 位置表（换装时与主趟一起重建）
    // _fbo/_ppTex：ping-pong 渲染目标（GL 不允许同一纹理既采样又作渲染目标）
    // _iterCount：本帧趟数（来自 // @iterations N，与宿主 parseIterations 同口径）
    var _programIter = null;
    var _uniformLocsIter = {};
    var _fbo = null, _ppTex = [null, null], _ppW = 0, _ppH = 0;
    var _iterCount = 0;
    // —— 结算模式（@solve / @solveHz）跨帧状态 ——
    // _solveStep：绝对步号（跨预览帧累计）；_solveFrame：预览帧号
    // _solveLastTex：上一帧的末趟结果（下一帧从它继续，而不是从输入重来）
    // _ppNext：ping-pong 的下一个写指针（保证读的那张 ≠ 写的那张）
    // _solveAccMs：真实时间累计——结算帧按"已播放的真实
    // 时间 × 帧率"推进（帧率现为固定 30fps，见 _previewFps），屏幕刷新率不再影响
    // 解算速率（每 rAF 无条件 _solveFrame++ 时：144Hz 比 60Hz 快 2.4 倍）；
    // 暂停/未启动不累计（拖相机补帧不再偷推进）。帧率不可配置 ⇒ 无需按新帧时长重校准。
    var _solveStep = 0, _solveFrame = 0, _solveLastTex = null, _ppNext = 0;
    var _solveAccMs = 0, _lastTickMs = 0;
    // Shader 预览解算帧率：**固定 30fps，不可配置**（「彻底移除，
    // 预览按照 30FPS」——原「Shader 预览帧率（fps）」设置项与 deps 的帧率注入通道
    // 一并收口，不再留"第二来源"）。唯一真相源 = engine/settings.js 的 AEEngine.settings.PREVIEW_FPS：
    // **本文件不自带第二份字面量**（scripts.manifest.js 保证 engine/settings.js 先于
    // 本文件加载）。它折算的口径：@solve 的推进速率（每帧 N 步 × 帧率）、非 Hz 路径的
    // uDt（1/(帧率×每帧步数)）、@solveHz 的每帧子步数量化、以及 uFrame 的"预览帧号"。
    // 取不到唯一常量（独立沙箱里只加载本文件）时返回 0 = 帧率未就绪：消费点按
    // "本帧只播种、不推进"处理（绝不写 NaN/Infinity uniform），真机上不可能走到
    // （engine/settings.js 先加载）。
    function _previewFps() {
        try {
            var eng = global.AEEngine && global.AEEngine.settings;
            var v = eng ? Number(eng.PREVIEW_FPS) : 0;
            return (isFinite(v) && v > 0) ? v : 0;
        } catch (_) { return 0; }
    }

    // 结算器多时间点采样的单点上限（秒）：结算器要从第 0 帧顺序重解，耗时随目标时间线性
    // 增长（帧率 × 每帧子步），超过上限就钳制并在回执标记 timeClamped。
    var SOLVER_SAMPLE_MAX_SECONDS = 10;

    // 迭代/结算指令解析（单一来源）：_render 与多时间点采样都要判定模式。
    // 模块缺席（独立沙箱只加载本文件）时按无迭代趟处理。
    function _iterConfig() {
        return (global.AEEffectLab && typeof global.AEEffectLab.parseIterConfig === 'function')
            ? global.AEEffectLab.parseIterConfig(_lastSrc || '')
            : { mode: 'stateless', stepsPerFrame: 8, simDim: 0, solveHz: 0 };
    }

    // 结算状态归零（换码/改参数/重置时间/多时间点采样共用）：绝对步号与状态纹理一起
    // 作废——只清其一会让 shader 看到"步号继续而状态全零"（播种分支不再进入）。
    function _resetSolveState() {
        _solveStep = 0; _solveFrame = 0; _solveLastTex = null; _ppNext = 0; _solveAccMs = 0;
    }
    var _status = { ok: true, error: '' };
    var _rafId = 0;
    var _started = 0;
    var _paused = false;    // 暂停：冻结时间与画面（t 停在暂停点）
    var _elapsedMs = 0;     // 暂停时已累计时间（恢复时从该点继续）
    var _uniformLocs = {};
    var _uniformValues = {};
    var _pendingUniforms = null; // pending 期缓存的 uniform 写入：换装时原子落值（见 setUniformValue）
    var _placeholderTex = null;
    var _mapStubTex = null; // 映射图层兜底（iChannel1/2/3）：1×1 全透明黑，与宿主 <none> 同构
    var _maxTexUnits = 16;  // 片段纹理单元上限（WebGL1 只保证 8；见 _ensureContext 的查询）
    var _stubSamplerNames = [];  // 源码里自造的 sampler 名（非内置）：预览绑透明黑兜底，别静默采输入图
    var _lastSrc = null;    // 幂等缓存：最近一次成功编译的（剥离初始化器后）源码
    var _lastOk = false;    // 上次编译是否成功（失败不缓存，重复提交会重编译以便修复）
    var _destroyed = false; // 销毁标记——迟到 setPaused 不得复活空转 rAF 循环
    var _compileGen = 0;    // 异步编译代数：新的 setSource / 终态分支使在途编译结果作废
    var _pending = false;   // 异步编译进行中（幂等缓存跳过：缓存命中会绕过代数失效，破坏 last-write-wins）
    var _pendingSrc = null; // 在途编译的源码（同码在途幂等用，见 setSource）
    var _pce = null;        // KHR_parallel_shader_compile 扩展缓存（按上下文一次性获取）

    // 预览相机状态：球面轨道（目标点 + yaw/pitch + 距离），全部为世界像素单位。
    // dist=0 表示尚未取景，下一帧由 _camAutoFrame 按画布宽高比算出（画布此刻可能还没布局）。
    var _cam = {
      yaw: 0, pitch: 0,
      dist: 0,
      target: [WORLD_W * 0.5, -(WORLD_W / WORLD_ASPECT_FALLBACK) * 0.5, 0],  // 世界中心（y-up，原点=画面左上角）
      touched: false    // 用户已操控 → 停止自动取景（resetCamera 复位）
    };
    var _camPos = new Float32Array(3);
    var _camMatrix = new Float32Array(16);
    var _camRight = new Float32Array(3), _camUp = new Float32Array(3);   // 平移换算用（相机基）
    var _camDirty = true;   // 矩阵脏标记：渲染循环每帧取用，只有相机真变了才重算

    // 并行编译扩展：可用时编译/链接在驱动线程进行，主线程轮询 COMPLETION_STATUS_KHR
    // （非阻塞）——同步查询 COMPILE_STATUS/LINK_STATUS 会阻塞主线程直至驱动完成，
    // 是首次加载 shader / LLM 提交 shader 时面板卡顿的主因。扩展不可用返回 null（走同步路径）。
    function _parallelExt() {
      if (_gl && !_pce && typeof _gl.getExtension === 'function') {
        _pce = _gl.getExtension('KHR_parallel_shader_compile') || null;
      }
      return _pce;
    }

    // ── WebGL 上下文丢失/恢复 ──────────────────────────────
    // GPU 重置/TDR 后上下文丢失：_gl 对象仍非空（isContextLost()=true），_acquireContext
    // 的重建分支永不进入——渲染全为 GL 空操作（画面冻死）、异步编译轮询的
    // COMPLETION_STATUS_KHR 恒返回 null（done 恒 false）→ 状态永停 pending。
    // 监听 webglcontextlost（必须 preventDefault 打开恢复通道，否则浏览器不再发
    // restored）：复位全部 GL 资源引用到可重建状态；webglcontextrestored：丢弃失效
    // 上下文重新获取（getContext 返回恢复后的同一对象），并重编译丢失前最后一次
    // 提交的源码（_restoreSrc，last-write-wins 口径）。
    var _glLost = false;         // 上下文丢失窗口（等 restored）
    var _ctxLossBound = false;   // 元素级监听只绑一次（恢复是同一 canvas/上下文对象）
    var _restoreSrc = null;      // 丢失前最后一次提交的源码：恢复后据此重编译
    var _statusBeforeLoss = null; // 丢失前终态：无可重编译源码（未提交/已清空）时恢复后还原
    function _onContextLost(e) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (_destroyed) return;
      _glLost = true;
      _statusBeforeLoss = _status;
      _compileGen++; _pending = false; _pendingUniforms = null;   // 在途编译作废（句柄随上下文消失）
      // 资源引用全部置空：句柄已随上下文失效，恢复后由 _installCompileResult / 各惰性
      // 建纹理路径按下标引用重建（不置空会让重建分支误以为资源仍在）
      _program = null; _programIter = null; _buffer = null;
      _placeholderTex = null; _mapStubTex = null; _zeroTex = null; _zeroW = 0; _zeroH = 0;
      _fbo = null; _ppTex = [null, null]; _ppW = 0; _ppH = 0; _iterCount = 0;
      _solveLastTex = null; _ppNext = 0;
      _uniformLocs = {}; _uniformLocsIter = {}; _stubSamplerNames = [];
      _pce = null; _floatTargetOk = null;   // 扩展/能力缓存随上下文失效
      _status = { ok: false, error: 'WebGL 上下文已丢失，等待恢复' };
      if (deps.onStatus) deps.onStatus(_status);
    }
    function _onContextRestored() {
      if (_destroyed) return;
      _glLost = false;
      _gl = null;   // 强制 _acquireContext 重建分支（同一 canvas 的 getContext 返回恢复后的上下文）
      _pce = null;
      _acquireContext();
      if (!_gl) { if (deps.onStatus) deps.onStatus(_status); return; }
      if (_restoreSrc) {
        _statusBeforeLoss = null;
        _api.setSource(_restoreSrc);   // 重编译并换装（状态经 onStatus 回传）
        return;
      }
      // 无可重编译源码（从未提交 / 代码已清空）：还原丢失前终态（如 skip 占位），
      // 不冒充 ok——清空态在恢复后照旧是占位语义
      _status = _statusBeforeLoss || { ok: true, error: '' };
      _statusBeforeLoss = null;
      if (deps.onStatus) deps.onStatus(_status);
    }
    function _bindContextLoss() {
      if (_ctxLossBound) return;
      if (!_canvas || typeof _canvas.addEventListener !== 'function') return;
      try {
        _canvas.addEventListener('webglcontextlost', _onContextLost, false);
        _canvas.addEventListener('webglcontextrestored', _onContextRestored, false);
        _ctxLossBound = true;
      } catch (_) { _ctxLossBound = false; }
    }

    function _acquireContext() {
      if (_gl) return;
      _glLost = false;
      _pce = null;  // 新上下文：扩展缓存随之失效（旧上下文的扩展对象不可跨上下文使用）
      _floatTargetOk = null;   // 同上：浮点渲染目标能力按新上下文重判
      _canvas = deps.getCanvas ? deps.getCanvas() : null;
      if (!_canvas) { _status = { ok: false, error: '预览画布不可用' }; return; }
      // preserveDrawingBuffer：WebGL 默认在每帧合成后清空 drawing buffer——
      // getShaderPreview 的 canvas.toDataURL 发生在后续事件循环（工具调用时刻），
      // 读到的 buffer 已被清空 → 截图恒为纯黑（与 shader 内容无关）。保留 buffer
      // 后任意时刻可读；暂停态下读到的即冻结帧。预览 canvas 体量小，保留开销可忽略。
      var attrs = { preserveDrawingBuffer: true };
      _gl = deps.getContext ? deps.getContext() : (_canvas.getContext ? _canvas.getContext('webgl2', attrs) || _canvas.getContext('webgl', attrs) : null);
      if (!_gl) { _status = { ok: false, error: '当前环境无 WebGL，实时预览不可用' }; return; }
      _isEs3 = !!(deps.getContextIsEs3 ? deps.getContextIsEs3() : (_canvas.getContext ? _canvas.getContext('webgl2') : false));
      // 片段纹理单元上限：映射图层兜底占单元 1..3、输入历史占
      // 5..8，最高用到单元 8。WebGL2 至少 16 个，但**WebGL1 规范只保证 8 个（0..7）**——
      // 本渲染器会回退到 'webgl'（见上），落到 8 单元的实现时 activeTexture(TEXTURE8) 越界：
      // GL 只报错不抛异常，绑定留在上一个生效单元而 sampler 指向 8 → 静默采错纹理。
      // 取不到上限（旧上下文/测试桩）时按 16 乐观处理。
      var unitLimit = 0;
      try {
        if (_gl.MAX_TEXTURE_IMAGE_UNITS !== undefined && typeof _gl.getParameter === 'function') {
          unitLimit = Number(_gl.getParameter(_gl.MAX_TEXTURE_IMAGE_UNITS));
        }
      } catch (_) { unitLimit = 0; }
      _maxTexUnits = (isFinite(unitLimit) && unitLimit > 0) ? unitLimit : 16;
      _bindSizeObserver();
      _bindContextLoss();
    }

    // 尺寸观察：**暂停态下 rAF 不绘制**（见 _loop 的暂停分支），
    // 舞台尺寸变化就没机会同步绘制缓冲——冻结帧比例与新元素框不符，被 object-fit 信箱化，
    // 表现为"一暂停、再拖抽屉/拖预览列表分隔条，预览又不铺满了"（"先暂停再绕着看"是预览的
    // 常见用法，暂停不是边缘态）。ResizeObserver 在尺寸变化时补一次同步 + 补帧，语义与
    // 相机手势的补帧一致（运行中不补：下一个 rAF 自然带新尺寸出图）。
    // 观察 canvas 元素本身：元素框由 CSS 铺满舞台（见 _viewportRect），且外接模式把整个
    // 舞台搬进中列时观察者随元素走，无需重绑。CEF（Chromium 87）支持，取不到就静默降级
    // 为"下一帧才跟上"（与改动前行为一致）。
    var _ro = null;
    function _bindSizeObserver() {
      if (_ro || _destroyed || !_canvas) return;
      var RO = global.ResizeObserver;
      if (typeof RO !== 'function') return;
      try {
        _ro = new RO(function () {
          if (_destroyed) return;
          _syncCanvasSize();   // 幂等：尺寸没变就不写 canvas.width/height（也不触发新通知）
          _camRepaint();       // 仅暂停/未启动态出帧；运行中交给下一个 rAF
        });
        _ro.observe(_canvas);
      } catch (_) { _ro = null; }
    }

    // 编译两阶段拆分（供同步与异步（KHR_parallel_shader_compile）两条路径共用）：
    //   _compileStart：提交阶段——createShader/shaderSource/compileShader/linkProgram
    //                  全部立即返回，真正编译链接在驱动侧（主线程不阻塞）
    //   _compileFinish：结算阶段——查询 COMPILE_STATUS/LINK_STATUS 与错误日志；驱动侧
    //                  已完成时查询即时返回，未完成时同步等待（异步路径只在完成后才调它）
    function _compileStart(src) {
      var gl = _gl;
      var build = (global.AEEffectLab && typeof global.AEEffectLab.buildFragmentSource === 'function')
        ? global.AEEffectLab.buildFragmentSource
        : function (s) { return s; };
      var vsText = _isEs3
        ? '#version 300 es\nin vec2 aPos;out vec2 vUv;void main(){vUv=aPos*0.5+0.5;gl_Position=vec4(aPos,0.0,1.0);}'
        : 'attribute vec2 aPos;varying vec2 vUv;void main(){vUv=aPos*0.5+0.5;gl_Position=vec4(aPos,0.0,1.0);}';
      function make(type, text) {
        var s = gl.createShader(type);
        gl.shaderSource(s, text);
        gl.compileShader(s);
        return s;
      }
      // 迭代趟：定义了 iterateImage 时多编一个程序——入口不同、
      // 内置声明段与主趟逐字相同（与宿主 renderer.cpp 的双 program 一一对应）。
      // 无 iterateImage 时不建迭代程序，_render 走单趟路径（行为与改动前一致）。
      var hasIter = !!(global.AEEffectLab && typeof global.AEEffectLab.hasIteratePass === 'function' &&
                       global.AEEffectLab.hasIteratePass(src));
      var vs = make(gl.VERTEX_SHADER, vsText);
      var fs = make(gl.FRAGMENT_SHADER, build(src, _isEs3, 'main'));
      var prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      var h = { vs: vs, fs: fs, prog: prog, hasIter: hasIter, vsI: null, fsI: null, progI: null };
      if (hasIter) {
        h.vsI = make(gl.VERTEX_SHADER, vsText);
        h.fsI = make(gl.FRAGMENT_SHADER, build(src, _isEs3, 'iterate'));
        h.progI = gl.createProgram();
        gl.attachShader(h.progI, h.vsI);
        gl.attachShader(h.progI, h.fsI);
        gl.linkProgram(h.progI);
      }
      return h;
    }

    function _compileFinish(h) {
      var gl = _gl;
      // 任一趟失败即整体失败（与宿主「迭代趟编译失败 → 错误帧，不静默降级为
      // 单趟」同口径：静默只跑一趟会让用户以为迭代在跑、实际没有）
      function dropAll() {
        gl.deleteShader(h.vs); gl.deleteShader(h.fs);
        if (h.vsI) gl.deleteShader(h.vsI);
        if (h.fsI) gl.deleteShader(h.fsI);
        gl.deleteProgram(h.prog);
        if (h.progI) gl.deleteProgram(h.progI);
      }
      if (!gl.getShaderParameter(h.vs, gl.COMPILE_STATUS)) {
        var vlog = gl.getShaderInfoLog(h.vs) || 'unknown';
        dropAll();
        return { err: '顶点着色器: ' + vlog };
      }
      if (!gl.getShaderParameter(h.fs, gl.COMPILE_STATUS)) {
        var flog = gl.getShaderInfoLog(h.fs) || 'unknown';
        dropAll();
        return { err: '片元着色器: ' + flog };
      }
      if (!gl.getProgramParameter(h.prog, gl.LINK_STATUS)) {
        var linkLog = gl.getProgramInfoLog(h.prog) || 'unknown';
        dropAll();
        return { err: '链接失败: ' + linkLog };
      }
      if (h.hasIter) {
        if (!gl.getShaderParameter(h.fsI, gl.COMPILE_STATUS)) {
          var flogI = gl.getShaderInfoLog(h.fsI) || 'unknown';
          dropAll();
          return { err: '迭代趟(iterateImage): 片元着色器: ' + flogI };
        }
        if (!gl.getProgramParameter(h.progI, gl.LINK_STATUS)) {
          var linkLogI = gl.getProgramInfoLog(h.progI) || 'unknown';
          dropAll();
          return { err: '迭代趟(iterateImage): 链接失败: ' + linkLogI };
        }
      }
      gl.deleteShader(h.vs); gl.deleteShader(h.fs);
      if (h.vsI) gl.deleteShader(h.vsI);
      if (h.fsI) gl.deleteShader(h.fsI);
      return { prog: h.prog, progIter: h.progI };
    }

    // 丢弃未结算的编译句柄（代数失效路径：更新请求已到达 / 实例已销毁）
    // destroy 会把 _gl 置空，而轮询要在其**之后**才触发（不能提前到
    // destroy 里删——在途编译期 deleteShader 在部分驱动上同步等待编译完成、冻结主线程数秒，
    // 见 setSource 的作废路径注释）→ 用 _deadGl 记住旧上下文，否则这里的早退会让这批
    // shader/program 泄漏到页面重载（预览 canvas 是静态节点，上下文会被下次挂载复用）。
    // 调用方传入句柄**所属**上下文（ownGl）——销毁后 canvas 被重新挂载时 _gl 可能
    // 已是另一个上下文，拿它删旧句柄是空操作（句柄留在旧上下文里没被回收，且轮询永远读不到
    // 完成位）。传 null 时退回 _gl || _deadGl（语义）。
    var _deadGl = null;
    function _discardCompile(h, gl) {
      gl = gl || _gl || _deadGl;
      if (!gl) return;
      gl.deleteShader(h.vs); gl.deleteShader(h.fs);
      if (h.vsI) gl.deleteShader(h.vsI);
      if (h.fsI) gl.deleteShader(h.fsI);
      gl.deleteProgram(h.prog);
      if (h.progI) gl.deleteProgram(h.progI);
    }

    function _compileAndLink(src) {
      return _compileFinish(_compileStart(src));
    }

    function _setupGeometry() {
      var gl = _gl;
      _buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, _buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation ? gl.getAttribLocation(_program, 'aPos') : 0;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    function _ensurePlaceholderTexture() {
      if (_placeholderTex || !_gl) return;
      var gl = _gl;
      _placeholderTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, _placeholderTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      // 占位纹理：UV 彩色渐变 + 棋盘格，让采样类 shader 的处理效果可见
      // （纯灰色占位会导致 texture(iChannel0,...) 全灰，无法预览采样/变换效果）
      var S = 256, data = new Uint8Array(S * S * 4);
      for (var y = 0; y < S; y++) {
        for (var x = 0; x < S; x++) {
          // 与宿主一致：源纹理以上下翻转方式上传（t=0=底部行），
          // mainImage 收到 y 向上的标准 UV，texture(iChannel0, uv) 采样即正向。
          // 生成时按"图像坐标"计数（y=0 为图像顶行），写入时翻转到纹理行 (S-1-y)。
          var gy = S - 1 - y;
          var i = (y * S + x) * 4;
          // 棋盘格（32px 格）交替明暗，让采样偏移/平铺可见
          var cell = (((x >> 5) ^ (gy >> 5)) & 1) ? 255 : 200;
          // UV 渐变：R=x/S, G=gy/S, B=棋盘格
          data[i]   = Math.round(x / S * 255 * 0.7 + cell * 0.3);
          data[i+1] = Math.round(gy / S * 255 * 0.7 + cell * 0.3);
          data[i+2] = cell;
          data[i+3] = 255;
        }
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    }

    // 映射图层兜底纹理（iChannel1/2/3）：1×1 全透明黑。面板预览不接 AE 图层，声明了
    // 映射图层的 shader 在预览里恒采到 (0,0,0,0)——与宿主 renderer.cpp 对「声明了但
    // 用户选 <none>」的兜底（共享 1×1 黑透明纹理）逐位同构。
    // **必须显式绑**：sampler 未注入 uniform1i 时默认指向单元 0，会静默采到 iChannel0
    // 那张占位图（"映射图层看着生效了，其实只是输入图"）——比黑帧更难发现。
    function _ensureMapStubTexture() {
      if (_mapStubTex || !_gl) return;
      var gl = _gl;
      gl.activeTexture(gl.TEXTURE1);
      _mapStubTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, _mapStubTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // —— 预览相机：取景 / 矩阵生成 / 补帧 ——
    function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    // 默认取景距离：**整个世界**（= 整幅画面，见 _worldSizeOf）contain 进视口，四周留
    // CAM_FIT_MARGIN 边距。世界比例 == 视口比例，故默认取景就是"整幅画面"。
    // 未交互期间每帧重算（幂等），视口无尺寸（抽屉折叠/离屏/切模式瞬间）时按 16:9 估——
    // 布局恢复或面板宽高比变化后自动校准，不必重进模式。
    function _camAutoFrame() {
      if (_cam.touched) return;
      var ws = _worldSize();
      // 世界中心随画面比例移动（框变高 → 世界变高 → 中心下移）。未交互时相机跟着走，
      // 否则换个抽屉宽度默认视角就偏到画面一角；复位键同口径（见 resetCamera）。
      var tx = ws.w * 0.5, ty = -ws.h * 0.5;
      if (tx !== _cam.target[0] || ty !== _cam.target[1]) {
        _cam.target[0] = tx; _cam.target[1] = ty; _camDirty = true;
      }
      var aspect = ws.w / ws.h;
      var halfH = Math.max(ws.h * 0.5, (ws.w * 0.5) / aspect) * CAM_FIT_MARGIN;
      var d = halfH / Math.tan(CAM_HALF_FOV_Y);
      if (d !== _cam.dist) { _cam.dist = d; _camDirty = true; }
    }

    // 由 yaw/pitch/dist/target 生成 uCamPos + uCamMatrix（列主序：右 / 上 / 前 / 位置）。
    // 脏标记缓存——渲染循环每帧调用，只有相机真变了才重算。
    function _camUpdateMatrix() {
      if (!_camDirty) return;
      var cy = Math.cos(_cam.yaw), sy = Math.sin(_cam.yaw);
      var cp = Math.cos(_cam.pitch), sp = Math.sin(_cam.pitch);
      // 相机在目标球面上的单位偏移：yaw=pitch=0 → (0,0,-1)（正面，视线 +z，与 AE 默认相机同向）
      var ox = sy * cp, oy = sp, oz = -cy * cp;
      var fx = -ox, fy = -oy, fz = -oz;      // 前 = 目标 − 位置
      var rx = fz, rz = -fx;                 // 右 = 世界上方向 × 前 = (f.z, 0, −f.x)
      var rl = Math.sqrt(rx * rx + rz * rz) || 1;   // cos(pitch)：俯仰限位保证非零
      rx /= rl; rz /= rl;
      var ux = fy * rz, uy = fz * rx - fx * rz, uz = -fy * rx;   // 上 = 前 × 右（右×上=前，与宿主同手性）
      _camRight[0] = rx; _camRight[1] = 0; _camRight[2] = rz;
      _camUp[0] = ux; _camUp[1] = uy; _camUp[2] = uz;
      var t = _cam.target, d = _cam.dist;
      _camPos[0] = t[0] + ox * d; _camPos[1] = t[1] + oy * d; _camPos[2] = t[2] + oz * d;
      var m = _camMatrix;
      m[0] = rx; m[1] = 0; m[2] = rz; m[3] = 0;
      m[4] = ux; m[5] = uy; m[6] = uz; m[7] = 0;
      m[8] = fx; m[9] = fy; m[10] = fz; m[11] = 0;
      m[12] = _camPos[0]; m[13] = _camPos[1]; m[14] = _camPos[2]; m[15] = 1;
      _camDirty = false;
    }

    // 相机变化后的补帧：暂停态（rAF 循环不绘制）与未启动态下由这里出帧——
    // 「先暂停再绕着看」是预览的常见用法，不补帧则拖拽期间画面纹丝不动。
    // 运行中不补帧：下一个 rAF 自然带新相机出图，避免一次拖拽里每像素重绘。
    function _camRepaint() {
      if (!_gl || !_program) return;
      if (_paused) _render(_elapsedMs / 1000);
      else if (!_started) _render(0);
    }

    // 预览视口的设备像素比（异常值一律按 1，免得算出 0 尺寸缓冲）
    function _dpr() {
      return (global.devicePixelRatio && global.devicePixelRatio >= 1) ? global.devicePixelRatio : 1;
    }

    // —— 世界模型（唯一来源）——
    // 世界尺寸（像素单位）由**画面比例**推出：宽恒 WORLD_W，高 = WORLD_W / 画面比例。
    // 传的是绘制缓冲尺寸：缓冲比例 = 元素框比例（见 _syncCanvasSize），且渲染时一定有效。
    // 三处口径（uLayerSize / uAspect / 视口）都从这里出发，改比例只改这一个函数。
    function _worldSizeOf(w, h) {
      var aspect = (w > 0 && h > 0) ? (w / h) : WORLD_ASPECT_FALLBACK;
      return { w: WORLD_W, h: WORLD_W / aspect };
    }
    function _worldSize() {
      return _worldSizeOf(_canvas ? (_canvas.width || 0) : 0, _canvas ? (_canvas.height || 0) : 0);
    }

    // 预览视口 = 舞台（元素框）本身 —— **画面铺满预览框**。
    // 元素框由 CSS 铺满舞台（width/height:100%），绘制缓冲就取这个尺寸 ×DPR；世界模型
    // 跟着它的比例走（见 _worldSizeOf），故"视口比例 = uAspect = uLayerSize 比例"恒等。
    // 视口不得锁成"舞台内接最大 16:9"（假定 uLayerSize
    // 1920×1080），理由是"否则 uAspect/结算网格比例与 AE 对不上"。该理由只对 16:9 合成
    // 成立，代价却是窄高舞台上大片黑边（面板实测占舞台高度 1/3，即"填不满"）；
    // 而 AE 的合成/图层本就不一定是 16:9，且同一 shader 会挂到尺寸各异的实例上——
    // 假定 AE 的尺寸这条路走不通（探测也不行），故改为"画面框即图层"。
    // **元素框与绘制缓冲仍是两件事**：元素框由 CSS 决定，缓冲 = 元素框 ×DPR。
    // 面板实测事故（"填不满"的真身）：曾让**元素框尺寸取自绘制缓冲**（CSS
    // max-width/max-height:100% + width/height:auto + aspect-ratio），而 _syncCanvasSize
    // 又把绘制缓冲取自元素框的 clientWidth/Height → 自指不动点：元素框尺寸恒等于缓冲
    // 尺寸、缓冲又恒等于元素框，于是预览被钉死在 canvas **默认位图尺寸**上，与舞台无关
    // （面板 CEF 实测恒 267×150 = 默认高 150 反推宽；Chrome 同写法实测 300×169 = 默认宽
    // 300 反推高——两引擎挑的固有维度不同，不变的是"舞台再大也填不满"）。
    // **元素的布局尺寸绝不能反过来依赖绘制缓冲**。
    function _viewportRect() {
      var boxW = (_canvas && _canvas.clientWidth) || 0;
      var boxH = (_canvas && _canvas.clientHeight) || 0;
      if (boxW <= 0 || boxH <= 0) return null;
      return { w: boxW, h: boxH };
    }

    // 视口的**显示尺寸**（CSS 像素）= 绘制缓冲 ÷ DPR：真正画在屏幕上的那块尺寸
    // （光标位移换算要用它，见 panCamera；两轴取整差出亚像素，用缓冲口径与所见一致）。
    function _viewportCssSize() {
      var dpr = _dpr();
      return { w: ((_canvas && _canvas.width) || 0) / dpr, h: ((_canvas && _canvas.height) || 0) / dpr };
    }

    // 同步绘制缓冲到视口（元素框）×DPR，避免固定 300x150 拉伸/变形；
    // 元素框无尺寸（抽屉折叠/离屏/未布局）时保持原尺寸，绝不锁成 1x1——
    // 切模式瞬间/抽屉展开动画中 canvas 可能读到 0 尺寸，若强行设 1x1 则绘制缓冲被
    // 重置成 1 像素，之后黑屏。布局恢复后由 _render 每帧再补同步。
    // 两轴各自按元素框 ×DPR 取整（不再"由整数宽按图层比例反推高"——那是锁 16:9 时代的
    // 写法，现在缓冲比例就该等于元素框比例；两轴取整差出的亚像素由 object-fit 兜）。
    function _syncCanvasSize() {
      if (!_canvas) return;
      var rect = _viewportRect();
      if (!rect) return;
      var dpr = _dpr();
      var w = Math.max(1, Math.round(rect.w * dpr));
      var h = Math.max(1, Math.round(rect.h * dpr));
      if (_canvas.width !== w || _canvas.height !== h) {
        _canvas.width = w;
        _canvas.height = h;
      }
    }

    // 迭代趟 ping-pong 资源（惰性创建；画布尺寸变化即重建）
    // 位深：**优先浮点渲染目标**——迭代求解类效果（反应扩散/流体）每步增量远小于
    // 1/255，8bit 会被量化到失效（图案直接死掉）。WebGL2 需 EXT_color_buffer_float
    // 才可渲染到 RGBA16F；不可用则回落 RGBA8（预览只求"能看到迭代在跑"，宿主侧
    // 恒为 RGBA16F/32F——位深差异属预览既有立场：预览只保证"能出画面"）。
    // 返回是否**重建**（尺寸变了或首次分配）：调用方据此把结算步号一起归零
    //（见 _render 的 solver 分支——重建只作废纹理不够，步号不归零会让 shader 看到
    // "uStep 很大而状态全零"，播种分支永不再进）。
    // 浮点渲染目标的可用性判定：**单一来源**——由 ping-pong 分配
    // 时定下结论（含"扩展声明了但驱动渲染不了 → 完整性自检失败 → 回落 8bit"这一步的结果），
    // 零状态纹理复用同一结论。两处各自重算扩展位时：ping-pong 回落后零状态仍按 16F 建 →
    // 那个 FBO 不完整 → `glClear` 无效（只置 INVALID_FRAMEBUFFER_OPERATION）→ 结算的播种步
    //（uStep < 0.5）读到**未定义显存**（NaN/极大值），从头就废且不报错——正是 _ensureZeroTex
    // 当初被引入要消灭的那类事故。null = 尚未判定（_acquireContext 里置回，新上下文可能不同）。
    var _floatTargetOk = null;
    function _probeFloatTarget() {
      var useFloat = false;
      try {
        useFloat = _isEs3 && typeof _gl.getExtension === 'function' &&
                   !!_gl.getExtension('EXT_color_buffer_float');
      } catch (_) { useFloat = false; }
      return useFloat;
    }

    function _ensurePingPong(w, h) {
      var gl = _gl;
      if (!_fbo) _fbo = gl.createFramebuffer();
      if (!_ppTex[0]) { _ppTex[0] = gl.createTexture(); _ppTex[1] = gl.createTexture(); }
      if (_ppW === w && _ppH === h) return false;
      // 重建纹理 = 旧状态作废：不置空会让下一帧去读一张已被重新分配的纹理
      _solveLastTex = null; _ppNext = 0;
      var useFloat = _probeFloatTarget();
      function alloc(tex) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (useFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, null);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      alloc(_ppTex[0]); alloc(_ppTex[1]);
      // 完整性自检：浮点目标建不起来（扩展存在但驱动不支持渲染）时回落 8bit 重来
      // 一次——否则每帧迭代都画进一个不完整的 FBO，画面全黑且不报任何错
      if (useFloat && typeof gl.checkFramebufferStatus === 'function') {
        var ok = false;
        try {
          gl.bindFramebuffer(gl.FRAMEBUFFER, _fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _ppTex[0], 0);
          ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        } catch (_) { ok = false; }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (!ok) { useFloat = false; alloc(_ppTex[0]); alloc(_ppTex[1]); }
      }
      _floatTargetOk = useFloat;   // 单一来源：零状态纹理复用本结论（见 _probeFloatTarget 注释）
      _ppW = w; _ppH = h;
      return true;
    }

    // 播种步的零状态纹理（面板实测事故，与宿主 ensureSolveZeroTex 同构）：
    // 结算的第 0 步（uStep < 0.5）曾把 **输入占位纹理（256×256）** 绑成 iPrev——
    // 而状态纹理是画布尺寸。shader 里 textureSize(iPrev) 于是"播种步一个尺寸、
    // 后续步另一个尺寸"，按网格寻址的写法（一物一纹素）把种子全写进角落，不报错。
    // 改绑一张**画布尺寸、清零**的专用纹理：iPrev 尺寸在结算每一步恒 = 状态纹理尺寸。
    var _zeroTex = null, _zeroW = 0, _zeroH = 0;
    function _ensureZeroTex(w, h) {
      var gl = _gl;
      if (_zeroTex && _zeroW === w && _zeroH === h) return _zeroTex;
      if (_zeroTex) { gl.deleteTexture(_zeroTex); _zeroTex = null; }
      _zeroTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, _zeroTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // 位深跟随 ping-pong 的实际分配（浮点可用则 16F，否则 8bit）——**复用同一结论**
      //（此处曾独立重算扩展位，ping-pong 回落 8bit 后仍按 16F 建
      // → FBO 不完整 → clear 无效 → 播种步读未定义内容）。内容由 FBO + clear 清零（同宿主）。
      var useFloat = (_floatTargetOk === null) ? _probeFloatTarget() : _floatTargetOk;
      if (useFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      if (!_fbo) _fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, _fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _zeroTex, 0);
      // clearColor 是全局状态：主趟的清屏依赖 _render 段设的 (0.1,0.1,0.12)，用完还原
      var pc = gl.getParameter ? gl.getParameter(gl.COLOR_CLEAR_VALUE) : null;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (pc) gl.clearColor(pc[0], pc[1], pc[2], pc[3]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      _zeroW = w; _zeroH = h;
      return _zeroTex;
    }

    // 公共 uniform 注入（迭代趟与主趟共用）：与宿主 renderer.cpp 的
    // applyCommonUniforms 同口径——两趟的内置集合完全相同，只有 iPrev/uIter/
    // uIterCount 是每趟独立的（由调用点单独注入，不在本函数内）。
    // 两份拷贝必然漂移，故抽成一处（本仓库反复踩过"两侧不同步"的坑）。
    function _applyCommonUniforms(gl, L, prog, t, W, H, dim) {
      if (L.iChannel0) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, _placeholderTex); gl.uniform1i(L.iChannel0, 0); }
      // 映射图层（iChannel1/2/3 → 纹理单元 1..3，与宿主 renderer.cpp 的 GL_TEXTURE1+ci 同款）：
      // 面板预览不接 AE 图层 → 恒绑 1×1 透明黑兜底（宿主「声明了但 <none>」同语义）。
      // 未声明的名字 location 为 null，直接跳过（不白付三次绑定/三次 uniform1i）。
      for (var mi = 0; mi < 3; mi++) {
        var mloc = L['iChannel' + (mi + 1)];
        if (!mloc || !_mapStubTex) continue;
        if (1 + mi >= _maxTexUnits) continue;   // 单元越界（WebGL1 8 单元下限）→ 宁可留默认单元 0
        gl.activeTexture(gl.TEXTURE1 + mi);
        gl.bindTexture(gl.TEXTURE_2D, _mapStubTex);
        gl.uniform1i(mloc, 1 + mi);
      }
      // 输入历史（iHistory0..3 → 纹理单元 5..8，与宿主 renderer.cpp 的 GL_TEXTURE5+hi 同款）：
      // 预览的输入是**静态**占位图，"前 1..4 帧的输入"与当前帧本就是同一张图 → 显式绑它。
      // 这四个名字若没有位置表，采样会靠"未赋值 sampler 默认指向单元 0"的巧合落到占位图
      // ——语义恰好对，但依赖别处不碰单元 0（本文件里 iChannel0 也用它），且契约对预览只字未提。
      // 契约「输入历史」节现在写明这条口径：拖尾的累积过程在预览里看不到，要到 AE 里看。
      for (var hi = 0; hi < 4; hi++) {
        var hloc = L['iHistory' + hi];
        if (!hloc || !_placeholderTex) continue;
        if (5 + hi >= _maxTexUnits) continue;   // 单元越界（WebGL1 8 单元：iHistory3 会落到单元 8）
        gl.activeTexture(gl.TEXTURE5 + hi);
        gl.bindTexture(gl.TEXTURE_2D, _placeholderTex);
        gl.uniform1i(hloc, 5 + hi);
      }
      // 自造 sampler 名的兜底：绑到**映射兜底那张** 1×1 透明黑
      // （因此也就共用单元 1——同一张纹理故语义相同，无冲突；采样结果恒透明黑，
      // 而不是静默采到单元 0 的输入占位图）。
      for (var si = 0; si < _stubSamplerNames.length; si++) {
        var sloc = L[_stubSamplerNames[si]];
        if (!sloc || !_mapStubTex) continue;
        if (1 >= _maxTexUnits) continue;   // 与两条邻居同款的单元守卫（防御非合规 GL 实现）
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, _mapStubTex);
        gl.uniform1i(sloc, 1);
      }
      if (L.uTime) gl.uniform1f(L.uTime, t);
      // dim：本趟的 uResolution/uAspect 口径（迭代趟传网格尺寸、主趟省略 = 渲染尺寸）。
      // 宿主的两趟就是这样分的（renderer.cpp 迭代趟覆盖 uResolution/uAspect），此处同构。
      var rw = (dim && dim.w > 0) ? dim.w : W;
      var rh = (dim && dim.h > 0) ? dim.h : H;
      if (L.uResolution) gl.uniform2f(L.uResolution, rw, rh);
      if (L.uAspect) gl.uniform1f(L.uAspect, rw / Math.max(1, rh));
      // L2 相机感知：面板预览没有 AE 相机数据，注入「可操控虚拟相机」暂时替代 AE 相机
      // 矩阵（默认取景见 CAM_* 常量；交互绑定见 shaderUI.bindPreviewCamera）。
      // uHasCam=1：预览从此走 shader 的相机联动分支——与 AE 3D 合成所见一致，
      // 也使 uCamMatrix 配方在面板内可被直接检验。语义与宿主 aeCamera.h 逐位同构。
      // 预分配矩阵/向量每帧复用（uniformMatrix4fv 无 transpose 参数，WebGL 恒列主序）。
      if (L.uHasCam) gl.uniform1f(L.uHasCam, 1);
      if (L.uCamFov) gl.uniform1f(L.uCamFov, CAM_FOV_COEF);
      if (L.uCamPos) gl.uniform3f(L.uCamPos, _camPos[0], _camPos[1], _camPos[2]);
      if (L.uCamMatrix) gl.uniformMatrix4fv(L.uCamMatrix, false, _camMatrix);
      if (L.uWorldMatrix) gl.uniformMatrix4fv(L.uWorldMatrix, false, IDENTITY_MAT4);
      // L4 全分辨率尺寸：**预览的世界模型 = 画面框**（宽恒 WORLD_W、高按画面比例推出，
      // 见 _worldSizeOf）——不再是"假定 1920×1080"：假定值挂到非 16:9 的合成/图层上时
      // 会与 uAspect 各说各话（按 uLayerSize 铺满全层的写法要么被拉伸、要么只画出一部分）。
      // AE 里由宿主注入真实图层尺寸。
      if (L.uLayerSize) {
        var wsU = _worldSizeOf(W, H);
        gl.uniform2f(L.uLayerSize, wsU.w, wsU.h);
      }
      // L3 灯光感知默认值：面板预览无 AE 灯光——uHasLights=0 / uLightCount=0
      //（与宿主「无灯合成」兜底语义一致，shader 可据此走"无灯兜底"分支）。
      // 数组元素**不逐个注入**：宿主侧同样只写 count 与数组整块，shader 的
      // `if (i >= n) break;` 循环在 n=0 时空转，不会读到任何元素；且 WebGL 下
      // 未上传的数组元素保持 0，语义与宿主全零注入一致。
      if (L.uHasLights) gl.uniform1f(L.uHasLights, 0);
      if (L.uLightCount) gl.uniform1f(L.uLightCount, 0);
      for (var n in _uniformValues) {
        var loc = gl.getUniformLocation(prog, n);
        if (!loc) continue;
        var v = _uniformValues[n];
        if (typeof v === 'number') gl.uniform1f(loc, v);
        else if (Array.isArray(v) && v.length === 2) gl.uniform2f(loc, v[0], v[1]);
        else if (Array.isArray(v) && v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
        else if (Array.isArray(v) && v.length === 4) gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
      }
    }

    // 结算网格长边的封顶基数（像素）：deps 给了就用它（离屏抓帧传 @solveRes 上限），
    // 否则 0 = 用绘制缓冲长边（面板预览口径）。
    function _gridBaseSize() {
      var f = deps.getGridBaseSize;
      if (typeof f !== 'function') return 0;
      var v = Number(f());
      return (isFinite(v) && v > 0) ? v : 0;
    }

    // 序列渲染的公共现场（同步与异步两条多时间点路径共用）：入参归一、结算钳制、
    // 采样前现场快照。返回 { error } 或状态对象（list/frames/lastActual/…）。
    function _sequenceBegin(times) {
      if (_destroyed) return { error: '预览已销毁' };
      _acquireContext();
      if (!_gl || !_program) return { error: '预览未就绪（无 WebGL 或未编译成功）' };
      var raw = (times && typeof times.length === 'number') ? times : [];
      var list = [];
      var i;
      for (i = 0; i < raw.length; i++) {
        var tv = Number(raw[i]);
        if (!isFinite(tv)) return { error: '时间点不是有限数' };
        list.push(tv < 0 ? 0 : tv);
      }
      if (!list.length) return { error: '没有时间点' };
      var fps = _previewFps();
      // 结算器判定：有迭代趟程序且指令为 @solve/@solveHz（与 _render 同源）
      var solver = !!(_programIter && _iterConfig().mode === 'solver');
      if (solver && !(fps > 0)) return { error: '预览帧率未就绪' };
      var clamped = false;
      if (solver) {
        for (i = 0; i < list.length; i++) {
          if (list[i] > SOLVER_SAMPLE_MAX_SECONDS) { list[i] = SOLVER_SAMPLE_MAX_SECONDS; clamped = true; }
        }
        _resetSolveState();
      }
      return {
        list: list,
        fps: fps,
        frameMs: fps > 0 ? 1000 / fps : 0,
        solver: solver,
        clamped: clamped,
        prevPaused: _paused,
        prevElapsedMs: _elapsedMs,
        prevStarted: _started,
        frames: [],
        lastActual: 0
      };
    }

    // 结算推进一帧：半帧偏移让 floor(_solveAccMs / 帧时长) 恒 = _solveFrame，
    // 保证每次 _render 恰好推进一帧（直接取整可能少一帧 → 死循环）。
    function _sequenceAdvanceFrame(st) {
      _solveAccMs = (_solveFrame + 0.5) * st.frameMs;
      _render(_solveFrame / st.fps);
    }

    // 采样结束恢复现场（与 _sequenceBegin 的快照成对）。
    function _sequenceFinish(st) {
      if (st.solver) {
        _solveAccMs = st.lastActual * 1000;
        if (st.prevPaused) {
          _elapsedMs = st.lastActual * 1000;
        } else if (st.prevStarted) {
          _started = Date.now() - st.lastActual * 1000;
          _lastTickMs = Date.now();
        } else {
          // 未启动（切出模式/预热）：状态归零，下次 start 从第 0 帧与 uTime 0 对齐
          _resetSolveState();
        }
      } else if (st.prevPaused) {
        _render(st.prevElapsedMs / 1000);
      } else if (st.prevStarted) {
        _render((Date.now() - st.prevStarted) / 1000);
      } else {
        _render(0);
      }
    }

    function _render(t) {
      if (!_gl || !_program) return;
      _syncCanvasSize();
      var gl = _gl;
      var W = _canvas.width, H = _canvas.height;
      gl.clearColor(0.1, 0.1, 0.12, 1);
      _ensurePlaceholderTexture();
      _ensureMapStubTexture();
      _camAutoFrame();
      _camUpdateMatrix();

      // —— 迭代趟（可选）：帧内 N 次 ping-pong，全部在本帧内跑完 ——
      // 与宿主同构：第 0 趟读输入（预览的输入是占位棋盘格纹理），其后读上一趟
      // 输出；末趟结果交给主趟作 iPrev。**不做跨帧累积**——效果因此仍是 time
      // 的纯函数，与 AE 的乱序渲染/跳帧语义一致。
      var iterResultTex = _placeholderTex;   // 无迭代趟时主趟 iPrev 的兜底 = 输入
      var isSolver = false;                  // 主趟也要用（uStep/uFrame/uDt 的口径分叉点）
      var uDtVal = 0;                        // 每子步真实秒数（两趟同值注入；无迭代趟保持 0）
      if (_programIter) {
        // 模式判定与宿主同口径：@solveHz > @solve > @iterations > 默认趟数
        var cfg = _iterConfig();
        isSolver = (cfg.mode === 'solver');
        var hz = isSolver ? (cfg.solveHz || 0) : 0;
        // 本次渲染生效的预览帧率（固定 30fps，见 _previewFps）：逐帧读一次即可——
        // 帧率不可配置，故无需"上一 tick 用的帧率"这类跨帧状态。直调 _render 的
        // 路径（暂停补帧/换装首帧）同样走到这里。
        var fpsNow = _previewFps();
        // 帧率未就绪（独立沙箱里 engine/settings.js 未加载）→ frameMs = Infinity，
        // targetFrame 恒 0：本帧只播种不推进。真机不会走到。
        var frameMs = fpsNow > 0 ? 1000 / fpsNow : Infinity;
        // —— 结算网格：与宿主同规则（renderer.cpp:2004-2011 的 simW/simH）——
        // 长边 = @solveRes（glslValidator 已钳到 [64, 2048]；未声明则 RES_DEFAULT），
        // 短边按**世界比例**折算（= 画面比例 = uLayerSize 比例；宿主那条按图层尺寸折算，
        // 同一条规则的两侧）。长边落在哪一轴按比例分叉——竖版画面（H > W）下长边是高度，
        // 写死 "simW = longEdge" 会把网格拧成横的，状态纹理被拉长采样、图案变形。
        // 预览额外把长边**封顶到画布长边**：网格比画布还大只会让预览变慢，细节在面板里
        // 也看不见（AE 侧仍按声明的 @solveRes 跑，这条差异写在契约里）。离屏抓帧给了
        // gridBase（= @solveRes 上限）时不封顶到画布，网格按声明值建。
        // 画面比例一变（拖抽屉/换模式）网格随之重建、结算从第 0 帧重来——与"改 @solveRes
        // 即整体重解"同款语义（走 _ensurePingPong 的重建路径）。
        // 帧内迭代（@iterations）不建网格——宿主那条路读的就是渲染尺寸，故 simW/simH = W/H。
        var simW = W, simH = H;
        if (isSolver) {
          var simDim = cfg.simDim > 0
            ? cfg.simDim
            : ((global.AEEffectLab && global.AEEffectLab.RES_DEFAULT) || 512);
          var gridBase = _gridBaseSize();
          var longEdge = Math.min(simDim, gridBase > 0 ? gridBase : Math.max(W, H));
          if (W >= H) {
            simW = longEdge;
            simH = Math.max(1, Math.round(longEdge * H / W));
          } else {
            simH = longEdge;
            simW = Math.max(1, Math.round(longEdge * W / H));
          }
        }
        // @solveHz 的每帧子步数（与宿主 substepsAt 同公式，帧率口径 = 固定 30fps）：
        // floor(Hz·(f+1)/FPS) − floor(Hz·f/FPS)；帧 0 至少 1 步（播种先于一切 0 步帧）。
        function substepsAt(f) {
          // 帧率未就绪：只播种（帧 0 = 1 步）、其后各帧 0 步——不写 NaN（0 作除数）
          if (!(fpsNow > 0)) return f === 0 ? 1 : 0;
          var a = Math.floor(hz * (f + 1) / fpsNow);
          var b = Math.floor(hz * f / fpsNow);
          var n = a - b;
          if (n < 0) n = 0;
          if (n > 64) n = 64;
          if (f === 0 && n < 1) n = 1;
          return n;
        }
        // 网格重建 = 结算重来（与宿主「结算指纹含网格，失配从第 0 帧重解」同口径）：
        // 只作废状态纹理不够——步号/帧号/时间累计必须一起归零，否则 shader 看到 uStep
        // 继续增长而状态是全零（`uStep < 0.5` 才播种的写法永不再进，画面变空/发黑）。
        // 归零后本帧必走播种帧（_solveFrame===0 时 owed ≥ 1），主趟 iPrev 因此也不会
        // 退回 256×256 输入占位图（重建后 _solveLastTex 为 null，零子步帧会兜底到占位图）。
        if (_ensurePingPong(simW, simH)) _resetSolveState();
        gl.useProgram(_programIter);
        // 迭代趟的 uResolution/uAspect 取**网格口径**（宿主 renderer.cpp:1874-1877 同款：
        // uResolution 取网格尺寸、uAspect 取网格宽高比）——预览若按画布尺寸走，
        // 于是 @solveRes 声明的网格在预览里根本不生效，"图案长在网格上"的效果（流体/
        // 反应扩散）会在错误的网格与错误的世界比例上调参，进 AE 全变样。
        _applyCommonUniforms(gl, _uniformLocsIter, _programIter, t, W, H, { w: simW, h: simH });
        gl.activeTexture(gl.TEXTURE4);
        gl.uniform1i(_uniformLocsIter.iPrev, 4);
        // uDt：@solveHz = 1/Hz（子步等长，与帧率无关）；@solve/@iterations = 帧时长均分到每子步
        // （帧率未就绪时 0 = 本帧不推进，不写 Infinity）
        uDtVal = hz ? 1 / hz : (fpsNow > 0 ? 1 / (fpsNow * Math.max(1, cfg.stepsPerFrame || 8)) : 0);
        if (_uniformLocsIter.uDt) gl.uniform1f(_uniformLocsIter.uDt, uDtVal);
        if (isSolver) {
          // —— 结算帧按真实时间推进：应解帧号 = floor(真实累计/帧时长)，
          // 每次 tick 补齐欠账（上限 8，慢机不滚雪球）。欠 0 帧只重绘不推进——高刷屏
          // 不再让解算变快，暂停/未启动的相机补帧也不再偷推进。冷启动首帧属初始化
          //（播种），恒解。@solveHz 下 Hz < 帧率的帧子步数为 0：状态原样延续、只计帧号
          //（与宿主 blit 延续同语义）。
          var targetFrame = Math.floor(_solveAccMs / frameMs);
          var owed = targetFrame + 1 - _solveFrame;
          if (owed < 0) owed = 0;
          if (_solveFrame === 0) owed = Math.max(owed, 1);
          if (owed > 8) owed = 8;
          var lastTex = _solveLastTex, nextIdx = _ppNext, stepNow = _solveStep;
          for (var fi = 0; fi < owed; fi++) {
            var f = _solveFrame;
            var stepsF = hz ? substepsAt(f) : (cfg.stepsPerFrame || 8);
            if (_uniformLocsIter.uIterCount) gl.uniform1f(_uniformLocsIter.uIterCount, stepsF);
            if (stepsF > 0) {
              // 起点：整个结算的第 0 步读**画布尺寸的零状态**（不是输入占位图——
              // 占位图是 256×256，会让 textureSize(iPrev) 在播种步返回错的尺寸，
              // 见 _ensureZeroTex 注释）；其后各步读上一子步结果。
              // 写指针接着上次的位置，"读的那张"与"写的那张"永不为同一张。
              var srcTex = (stepNow > 0 && lastTex) ? lastTex : _ensureZeroTex(simW, simH);
              var dstIdx = nextIdx;
              for (var it = 0; it < stepsF; it++) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, _fbo);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _ppTex[dstIdx], 0);
                gl.viewport(0, 0, simW, simH);
                gl.activeTexture(gl.TEXTURE4);
                gl.bindTexture(gl.TEXTURE_2D, srcTex);
                if (_uniformLocsIter.uIter) gl.uniform1f(_uniformLocsIter.uIter, it);
                // uStep：绝对步号（跨帧累计）；uFrame：正在解的这一帧
                if (_uniformLocsIter.uStep) gl.uniform1f(_uniformLocsIter.uStep, stepNow + it);
                if (_uniformLocsIter.uFrame) gl.uniform1f(_uniformLocsIter.uFrame, f);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                srcTex = _ppTex[dstIdx];
                dstIdx = 1 - dstIdx;
              }
              lastTex = srcTex;
              nextIdx = dstIdx;
              stepNow += stepsF;
            }
            _solveFrame++;
          }
          _solveLastTex = lastTex;      // 状态留到下一帧接着推
          _ppNext = nextIdx;
          _solveStep = stepNow;
          _iterCount = hz ? substepsAt(Math.max(0, _solveFrame - 1)) : (cfg.stepsPerFrame || 8);
          iterResultTex = lastTex || _placeholderTex;
        } else {
          // —— 帧内迭代（@iterations/默认）：每 tick 一帧、N 趟全在本帧跑完 ——
          _iterCount = cfg.stepsPerFrame || 8;
          if (_uniformLocsIter.uIterCount) gl.uniform1f(_uniformLocsIter.uIterCount, _iterCount);
          var srcTex2 = _placeholderTex;
          var dstIdx2 = _ppNext;
          for (var it2 = 0; it2 < _iterCount; it2++) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, _fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _ppTex[dstIdx2], 0);
            gl.viewport(0, 0, simW, simH);   // 帧内迭代不建网格：simW/simH = W/H
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_2D, srcTex2);
            if (_uniformLocsIter.uIter) gl.uniform1f(_uniformLocsIter.uIter, it2);
            if (_uniformLocsIter.uStep) gl.uniform1f(_uniformLocsIter.uStep, it2);
            if (_uniformLocsIter.uFrame) gl.uniform1f(_uniformLocsIter.uFrame, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            srcTex2 = _ppTex[dstIdx2];
            dstIdx2 = 1 - dstIdx2;
          }
          iterResultTex = srcTex2;   // 末趟输出
        }
      }

      // —— 主趟（画到画布）——
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(_program);
      _applyCommonUniforms(gl, _uniformLocs, _program, t, W, H);
      // iPrev：有迭代趟 = 末趟结果；无 = 输入占位纹理（与宿主兜底语义一致）
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, iterResultTex);
      if (_uniformLocs.iPrev) gl.uniform1i(_uniformLocs.iPrev, 4);
      if (_uniformLocs.uIter) gl.uniform1f(_uniformLocs.uIter, _programIter ? _iterCount : 0);
      if (_uniformLocs.uIterCount) gl.uniform1f(_uniformLocs.uIterCount, _programIter ? _iterCount : 0);
      // uStep/uFrame 主趟同样必须设（宿主主趟也设，口径见 renderer.cpp 主趟段）：
      //   结算  = 本帧末子步的下一个（此处 _solveStep 已在子步循环后累加过）/ 本帧帧号；
      //   帧内  = 趟数本身 / 0。
      // 漏设时 uniform 停在驱动默认 0——"步号超过某值才画的收尾逻辑"在预览里永远
      // 停在起始态，而 AE 里是正常推进；这正是"两侧不同步"的隐蔽形态之一。
      if (_uniformLocs.uStep) gl.uniform1f(_uniformLocs.uStep,
        isSolver ? _solveStep : (_programIter ? _iterCount : 0));
      if (_uniformLocs.uFrame) gl.uniform1f(_uniformLocs.uFrame, isSolver ? _solveFrame - 1 : 0);
      // uDt 与迭代趟同值（收尾趟若继续积分，dt 仍是同一子步长；无迭代趟不注入）
      if (_uniformLocs.uDt && _programIter) gl.uniform1f(_uniformLocs.uDt, uDtVal);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function _loop() {
      if (!_started) return;
      _rafId = requestAnimationFrame(_loop);
      // 真实时间累计：_lastTickMs 无论暂停与否都前移——恢复播放时
      // dt 正常、不跳帧；dt 钳 250ms——切页/后台回来不做大补算（结算帧追赶另有
      // 每 tick 8 帧上限）。
      var now = Date.now();
      var dtMs = now - _lastTickMs;
      if (!(dtMs > 0)) dtMs = 0;            // 同毫秒/时钟回拨防御
      if (dtMs > 250) dtMs = 250;
      _lastTickMs = now;
      // 暂停中不绘制：保持冻结帧。防御外部 stop()/start() 干扰（模块刷新/模式同步等）
      // 在暂停期间重启了 rAF 循环——否则循环会用实时时间重绘，画面被带回 t=0。
      if (_paused) return;
      // 帧率固定 30fps（不可配置）⇒ 「设置变了就把累计器按新帧时长换算到当前进度」
      // 的重校准分支已整体删除：帧时长恒定，_solveAccMs 的**真实时间累计语义**不变
      //（解算速率 = 真实时间 × 帧率，与屏幕刷新率无关）。取不到唯一常量（fps=0）时
      // 累计照走、只是不推进帧——常量就绪后按既有"每 tick 最多补 8 帧"上界追上。
      _solveAccMs += dtMs;                  // 只在播放态累计：解算速率 = 真实时间 × 帧率
      if (_program) _render((now - _started) / 1000);
    }

    function _cleanupProgram() {
      if (_gl && _program) { _gl.deleteProgram(_program); _program = null; }
      if (_gl && _programIter) { _gl.deleteProgram(_programIter); _programIter = null; }
      if (_gl && _buffer) { _gl.deleteBuffer(_buffer); _buffer = null; }
    }

    // 编译结果落装（同步/异步路径共用的终态处理）：失败清 program + 状态回传；
    // 成功换装新 program + 重建几何/uniform 位置表 + 暂停补帧
    function _installCompileResult(r, src) {
      _pending = false;
      // 换 shader = 换结算：绝对步号归零、上一帧状态作废（与宿主"源码变即整体重解"同口径）
      _resetSolveState();
      if (r.err) {
        _pendingUniforms = null;  // 失败终态：pending 期缓冲的 uniform 值无落点，丢弃
        _cleanupProgram();
        _status = { ok: false, error: r.err };
        _lastSrc = null; _lastOk = false;
        if (deps.onStatus) deps.onStatus(_status);
        return _status;
      }
      _cleanupProgram();
      _program = r.prog;
      // 迭代趟程序（无 iterateImage 时为 null → _render 走单趟路径）
      _programIter = r.progIter || null;
      _lastSrc = src; _lastOk = true;
      _setupGeometry();
      // 内置位置表：主趟与迭代趟逐名同查（两趟内置声明段相同），迭代趟多出的
      // iPrev/uIter/uIterCount 只在迭代趟存在时才有意义，主趟查得 -1 也无害
      //（_render 的注入点都带 if (loc) 守卫）。
      var LOC_NAMES = ['iChannel0','uTime','uResolution','uAspect','uLayerSize',
       // 映射图层：面板预览不接 AE 图层，三个单元恒绑 1×1 透明黑兜底
       //（宿主「声明了但 <none>」同语义）。查表与注入**必须成对**——漏查表 = 下面
       // `if (loc) uniform1i(...)` 静默跳过 → sampler 默认指单元 0 → 静默采到
       // iChannel0 占位图（本仓库在 uStep/uDt 上踩过两次同型坑：位置表漏名、注入空转）。
       'iChannel1','iChannel2','iChannel3',
       // 输入历史：同样漏过位置表——预览输入是静态占位图，
       // 显式绑它当"历史帧"（单元 5..8，宿主同款分配），不再靠默认单元 0 的巧合。
       'iHistory0','iHistory1','iHistory2','iHistory3',
       // L2 相机感知内置：面板注入可操控虚拟相机（uHasCam=1，见 _render 的 CAM_* 取值）
       'uHasCam','uCamFov','uCamPos','uCamMatrix','uWorldMatrix',
       // L3 灯光感知内置：预览无 AE 灯光，渲染循环注入零值（见 _render）。
       // 数组**必须写成 'name[0]'**——本循环按名字逐个 getUniformLocation，
       // 数组用裸名在部分驱动上拿不到位置（宿主 renderer.cpp 同样查 [0]）。
       'uHasLights','uLightCount',
       'uLightType[0]','uLightPos[0]','uLightDir[0]','uLightColor[0]','uLightParams[0]',
       // 迭代趟内置
       'iPrev','uIter','uIterCount',
       // 结算器内置：**位置表漏了这两个名字** = 下面四处
       // 「if (loc) uniform1f(uStep/uFrame, …)」全部静默不执行（loc 恒 undefined），
       // 于是预览里 uStep 恒为驱动默认 0 → 播种判据 `uStep < 0.5` 恒真 → 每子步重撒
       // 种子、纹样永远长不起来。查表与注入必须成对出现，别只加注入。
       'uStep','uFrame',
       // 每子步真实秒数：漏查表 = uDt 恒 0，物理积分类
       // shader 在预览里静止（AE 里正常）——又一处"两侧不同步"的隐蔽形态。
       'uDt'];
      _uniformLocs = {};
      LOC_NAMES.forEach(function (n) {
        // 位置表按「名字 → location」存；数组键保留带 [0] 的原名（下方注入按名取用）
        _uniformLocs[n] = _gl.getUniformLocation(_program, n);
      });
      _uniformLocsIter = {};
      if (_programIter) {
        LOC_NAMES.forEach(function (n) {
          _uniformLocsIter[n] = _gl.getUniformLocation(_programIter, n);
        });
      }
      // 未知名 sampler 的兜底：源码里自造 sampler 名（Shadertoy
      // 习惯的 uMyTex / uNoise…）时宿主不绑定它，而预览**更糟**——未注入 uniform1i 的
      // sampler 默认指向纹理单元 0，即 iChannel0 那张输入占位图：预览看着"生效了"，到 AE
      // 里却拿到未定义内容（宿主只写一条告警）。故把这些名字也纳入位置表，注入时绑 1×1
      // 透明黑兜底（与"无数据"同语义）——预览不再说谎，黑帧配合提交回执里的告警可自诊断。
      _stubSamplerNames = [];
      // 扫"用户源码"里声明的 sampler2D 名——**先剥注释**：
      // 声明行尾带注释（`uniform sampler2D uMyTex /* 备用 */;`）时，不剥注释会让名字解析
      // 失败、兜底名单漏掉它，于是它又悄悄落回单元 0 采输入图（面板诊断那边是剥注释的，
      // 两处口径必须一致）；反向的幻名（注释掉的声明）也一并消掉。
      // 类型可带精度限定符在前（`uniform highp sampler2D x;`，若只放宽面板告警、
      // 这里没跟 → 该拼写下"预览说谎"会复活）；非 sampler2D 类型不进兜底名单（2D 纹理兜底
      // 对它没意义，且面板/宿主会另行告警）。
      // 无 AEEffectLab（测试桩/旧装配）时退化为不剥注释。
      var srcNoComments = (global.AEEffectLab && typeof global.AEEffectLab.stripComments === 'function')
        ? global.AEEffectLab.stripComments(String(src || '')) : String(src || '');
      var declaredSamplers = srcNoComments.match(
        /uniform\s+(?:(?:highp|mediump|lowp)\s+)?sampler2D\s+([^;]+);/g) || [];
      declaredSamplers.forEach(function (line) {
        var names = line.replace(/uniform\s+(?:(?:highp|mediump|lowp)\s+)?sampler2D\s+/, '').replace(/;.*$/, '').split(',');
        names.forEach(function (n) {
          var raw = n.trim().split('=')[0].trim();
          var dim = /\[([0-9]+)\]/.exec(raw);   // 数组后缀先取再剥（元素各自持有一个单元）
          var nm = raw.replace(/\[[^\]]*\]/g, '').trim();
          if (!/^[A-Za-z_]\w*$/.test(nm)) return;
          if (nm === 'iChannel0' || nm === 'iPrev') return;                 // 已绑定的内置
          if (/^iChannel[123]$/.test(nm) || /^iHistory[0-3]$/.test(nm)) return;   // 各有专用单元
          if (dim) {
            // sampler 数组：**每个元素各自持有一个纹理单元**，裸名在 GL 里只等价于 [0]。
            // 只兜底裸名（形态）会让 [1..N-1] 从不注入 uniform1i → 停在驱动默认单元 0
            // = iChannel0 的输入占位图（"预览看着生效了"，AE 里是未定义内容）。元素下标与
            // 源码声明一致，上限 16 防病态声明（`[999]`）把位置表撑爆。
            var elemCount = Math.min(parseInt(dim[1], 10), 16);
            for (var ei = 0; ei < elemCount; ei++) {
              var elemName = nm + '[' + ei + ']';
              if (_stubSamplerNames.indexOf(elemName) < 0) _stubSamplerNames.push(elemName);
            }
            return;
          }
          if (_stubSamplerNames.indexOf(nm) < 0) _stubSamplerNames.push(nm);
        });
      });
      _stubSamplerNames.forEach(function (n) {
        _uniformLocs[n] = _gl.getUniformLocation(_program, n);
        if (_programIter) _uniformLocsIter[n] = _gl.getUniformLocation(_programIter, n);
      });
      // 换装即落 pending 期缓冲的 uniform 值：与新 program 原子生效（写入时机见
      // setUniformValue 缓冲语义），须在下方补帧之前——补帧即用新值绘制
      if (_pendingUniforms) {
        for (var pn in _pendingUniforms) _uniformValues[pn] = _pendingUniforms[pn];
        _pendingUniforms = null;
      }
      // 换装即绘首帧：新 program 的首次 draw（驱动侧懒初始化，复杂 shader 可观）在
      // 编译窗口内完成，下一个 rAF 呈现时已是热路径——否则首 draw 与首次呈现叠在
      // 同一时刻，表现为「编译完成显示的瞬间 UI 卡一下」。暂停中维持冻结帧语义
      // （rAF 循环已停，让新内容以冻结时间显示）。
      if (_paused) _render(_elapsedMs / 1000);
      else if (_started) _render((Date.now() - _started) / 1000);
      _status = { ok: true, error: '' };
      if (deps.onStatus) deps.onStatus(_status);
      return _status;
    }

    // 命名引用（_api）：上下文恢复通道（_onContextRestored）需要重编译，走与调用方
    // 完全相同的 setSource 入口——同一套预检/幂等/last-write-wins 判定，不复刻第二份编译路径。
    var _api = {
      setSource: function (code) {
        // 销毁后迟到的 setSource 直接忽略——与 setPaused 的销毁守卫同款。
        // 迟到调用会经 _acquireContext 重建 GL 资源（program/buffer/纹理），而 destroy
        // 已置 _destroyed 且释放画布引用，重建后的资源无人再释放（WebGL 上下文泄漏）。
        if (_destroyed) return { ok: false, skip: true, error: '' };
        var src = String(code == null ? '' : code);
        // 空代码不参与编译：骨架无 mainImage 必然编译失败，误报"编译失败"黑屏。
        // 返回 skip 状态，由 UI 层展示占位提示（提交代码后自动渲染）。
        if (!src.trim()) {
          _compileGen++; _pending = false;  // 在途异步编译作废（空态为终态）
          _pendingUniforms = null;
          _cleanupProgram();
          _status = { ok: false, skip: true, error: '' };
          _lastSrc = null; _lastOk = false;
          _restoreSrc = null;   // 清空态：上下文恢复后不得把清空前的旧 shader 复活
          if (deps.onStatus) deps.onStatus(_status);
          return _status;
        }
        // GLSL 规范不允许 uniform 带初始化器：编译前剥离（与 compileCheck 同源，
        // 避免"校验剥离后通过、实际编译原文失败"的假阳性）
        if (global.AEEffectLab && typeof global.AEEffectLab.stripUniformInitializers === 'function') {
          src = global.AEEffectLab.stripUniformInitializers(src);
        }
        // 上下文丢失/恢复通道的重编译基准：只记"最后一次提交"，
        // 恢复后按它重编译（含预检失败/编译失败态——恢复后如实复现同一终态，不拿旧图欺骗）
        _restoreSrc = src;
        // 幂等：同一已成功编译的源码重复提交（模块挂载 / 会话切换时 refreshList 会重复调用
        // setSource），直接复用当前渲染程序，跳过昂贵的重复 WebGL 编译。编译进行中（_pending）
        // 时不走缓存——缓存命中会绕过代数失效，导致后到的提交被在途结果覆盖（破坏 last-write-wins）。
        if (!_pending && src === _lastSrc && _lastOk && _program) {
          return _status;
        }
        // 同码在途幂等：pending 期重复提交同一源码（模式进入时草稿恢复与预览初始化会
        // 先后对同一份代码调用 setSource，实测 20KB 复杂 shader 被双份提交）直接复用在途
        // 编译。否则 gen++ 作废在途结果并重复提交一次驱动编译（两份 9s 级编译互相争抢
        // 驱动线程），且作废路径对在途句柄的即时 deleteShader 在部分驱动上同步等待编译
        // 完成，阻塞主线程数秒（实测 rAF 帧间隔 7.7s）。同码复用不破坏
        // last-write-wins——不同源码仍正常作废重编译。
        if (_pending && src === _pendingSrc) {
          return _status;
        }
        // 仅做 legacy 语法预检（纯正则、无 WebGL 开销，与宿主 GLSL 330 core 对齐）；
        // 实际编译由 _compileStart/_compileFinish 在预览上下文完成（校验器未加载时跳过
        // 预检：预览编译仍会给出真实错误）。
        var ck = (global.AEEffectLab && typeof global.AEEffectLab.precheckGlsl === 'function')
          ? global.AEEffectLab.precheckGlsl(src)
          : { ok: true };
        if (ck && ck.ok === false) {
          _compileGen++; _pending = false;  // 在途异步编译作废（预检失败为终态）
          _pendingUniforms = null;
          _status = { ok: false, error: ck.error || '编译失败' };
          _lastSrc = null; _lastOk = false;
          if (deps.onStatus) deps.onStatus(_status);
          _cleanupProgram();
          return _status;
        }
        // 上下文丢失窗口（等 webglcontextrestored）：此刻提交编译在丢失上下文上全是
        // 空操作且状态字读回 null（_compileFinish 会伪报"编译失败: unknown"）——只更新
        // 重编译基准并维持丢失提示，恢复通道按 _restoreSrc 统一重编译（last-write-wins）。
        if (_glLost) return _status;
        _acquireContext();
        if (!_gl) { _compileGen++; _pending = false; _pendingUniforms = null; _lastOk = false; if (deps.onStatus) deps.onStatus(_status); return _status; }
        var gen = ++_compileGen;
        _pendingSrc = src;       // 同码在途幂等基准（见 setSource 顶部判定）
        _pendingUniforms = null;  // 缓冲值属上一轮提交：当前轮提交方（refreshPreviewFromCode/renderUniforms）会重新同步默认值
        // 同步路径（无并行编译扩展）：提交+结算一次完成
        var ext = _parallelExt();
        if (!ext) {
          _pending = false;
          var res = _compileAndLink(src);
          return _installCompileResult(res, src);
        }
        // 异步路径（KHR_parallel_shader_compile）：提交编译（非阻塞）后立即返回 pending，
        // 主线程以 16ms 轮询完成位；期间旧 program 继续渲染（若有），完成后原子换装。
        // UI 不被驱动侧的同步编译等待卡住（首次加载 shader / LLM 提交 shader 的卡顿主因）。
        var h = _compileStart(src);
        var ownGl = _gl;   // 本批句柄所属上下文：销毁/重新挂载后仍据此轮询与回收（见 _discardCompile 注释）
        _pending = true;
        _status = { ok: false, pending: true, error: '' };
        if (deps.onStatus) deps.onStatus(_status);
        // 轮询两条纪律（编译最后几秒准备显示时会卡顿）：
        //   ① 覆盖本次提交的**全部** program——_compileFinish 会逐个查 COMPILE_STATUS/
        //      LINK_STATUS，任一 program 未编完时那个查询就是同步等待。迭代趟是独立 program
        //      且可能晚于主趟完成（实测 105KB 黑洞：主趟 t=103.7s、迭代趟 t=105.1s），只轮询
        //      主趟会让结算在末尾多冻一段（实测 2.97s）。
        //   ② **不设**"超时即同步结算"的兜底——撞上 10s 上限就直接调 _compileFinish 的话，
        //      实测主线程冻 92s（那次编译共 102s）。完成位本身覆盖整段编译：无上限轮询两趟的
        //      105s 冷编译全程零阻塞。驱动永不返回完成位时状态停在 pending（可观察、可被新
        //      提交作废），不回头去同步查询状态字——那正是本函数要消除的冻结路径。
        (function poll() {
          // 上下文丢失（GPU 重置/TDR）：完成位查询恒返回 null（done 恒 false）→ 无限
          // 轮询；句柄随上下文消失，直接放弃（不 delete），恢复通道会重编译 _restoreSrc。
          if (_glLost || (ownGl && typeof ownGl.isContextLost === 'function' && ownGl.isContextLost())) return;
          if (_destroyed || gen !== _compileGen) {
            // 实例销毁：立即回收（轮询在 destroy 之后才触发，_deadGl 保底在途句柄）
            if (_destroyed) { _discardCompile(h, ownGl); return; }
            // 被新提交作废：**不立即删**——在途编译期的 deleteShader/deleteProgram 在部分
            // 驱动上同步等待编译完成（实测 rAF 帧间隔 7.7s）。改为继续非阻塞轮询完成位，
            // 编完再回收；句柄仍由本闭包持有，不会泄漏。
            (function retire() {
              if (!ownGl) return;   // 上下文已不可用：句柄随上下文消失
              // 上下文丢失：完成位查询恒 null → retire 也会无限轮询（同 poll 的丢失守卫）
              if (_glLost || (typeof ownGl.isContextLost === 'function' && ownGl.isContextLost())) return;
              var ready = false;
              try {
                ready = !!ownGl.getProgramParameter(h.prog, ext.COMPLETION_STATUS_KHR) &&
                        (!h.progI || !!ownGl.getProgramParameter(h.progI, ext.COMPLETION_STATUS_KHR));
              } catch (_) { ready = true; }
              if (!ready) { setTimeout(retire, 100); return; }
              _discardCompile(h, ownGl);
            })();
            return;
          }
          var done = false;
          try {
            done = !!ownGl.getProgramParameter(h.prog, ext.COMPLETION_STATUS_KHR) &&
                   (!h.progI || !!ownGl.getProgramParameter(h.progI, ext.COMPLETION_STATUS_KHR));
          } catch (_) { done = true; }
          if (!done) { setTimeout(poll, 16); return; }
          var r = _compileFinish(h);
          if (_destroyed || gen !== _compileGen) {
            if (r.prog) ownGl.deleteProgram(r.prog);  // finish 已清理失败句柄，成功句柄须手动丢弃
            return;
          }
          _pending = false;
          _installCompileResult(r, src);
        })();
        return _status;
      },
      // 异步编译（pending）期写入先缓冲、换装时原子落值：pending 期旧 program 仍在
      // 渲染（「期间旧 program 继续渲染」为既定设计），若立即写入，渲染循环会把新
      // shader 的 uniform 默认值逐帧应用到旧 program（同名 uniform 生效）——效果库
      // 切换文件时旧 shader 画面瞬间跳变（「闪一下/时间重置」观感）。缓冲在换装
      // （成功）时落值，失败/新提交时代空作废。
      setUniformValue: function (name, value) {
        // 参数变 = 结算重来（与宿主 solverParamHash 同口径：参数是结算的输入，不是每步的输入）。
        // 宿主侧"打了关键帧的参数值不进指纹、逐帧取当帧值"（renderer.cpp + aeParams.cpp），
        // 面板预览无关键帧概念（无时间轴参数求值），保持"改动即重演"的调参语义。
        _resetSolveState();
        if (_pending) {
          if (!_pendingUniforms) _pendingUniforms = {};
          _pendingUniforms[name] = value;
          return;
        }
        _uniformValues[name] = value;
      },
      // 透传 pending/skip：异步编译期 UI 显示「编译中」，空代码/无校验器显示占位
      getStatus: function () { return { ok: _status.ok, skip: _status.skip, pending: _status.pending, error: _status.error }; },
      // 当前预览时刻（秒）：暂停时是冻结时刻，播放中是已累计时间；未启动返回 0。
      // getShaderPreview 的 width 单帧重绘据此对齐「当前时刻」。
      getCurrentTime: function () {
        if (_paused) return _elapsedMs / 1000;
        if (_started) return (Date.now() - _started) / 1000;
        return 0;
      },
      start: function () {
        // 销毁后迟到的 start 直接忽略——与
        // setSource/setPaused/warmup/相机七件套同款守卫。恢复分支会无条件重置 _started 并
        // 重启 rAF 循环，而 destroy 已释放 program/GL → 循环每帧空转、不会再停（烧帧）。
        if (_destroyed) return this;
        if (_started) return this;
        _started = Date.now();
        _lastTickMs = _started;   // 解算累计从此刻起算（否则首帧 dt 含页面停留时长）
        // 暂停中 start（模块刷新/模式同步可能触发）：只记录起始基准，不启动实时循环，
        // 否则会把冻结画面带回 t=0；恢复时 setPaused(false) 会按 _elapsedMs 重算基准。
        if (!_paused) _loop();
        return this;
      },
      stop: function () { _started = 0; if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; } return this; },
      // 暂停：冻结时间与画面；恢复：时间从暂停点继续
      setPaused: function (p) {
        // 销毁后迟到的 setPaused 直接忽略——恢复分支会无条件重置 _started
        // 并重启 rAF 循环，而 destroy 已释放 program/GL，循环将永久空转烧帧。
        if (_destroyed) return this;
        _paused = !!p;
        if (_paused) {
          _elapsedMs = _started ? (Date.now() - _started) : 0;
          if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
        } else {
          // 无论是否被 stop/start 扰动过，都以冻结时间点为基准恢复
          if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
          _started = Date.now() - _elapsedMs;
          _lastTickMs = Date.now();   // 暂停期 rAF 已停：重校准，恢复首帧 dt 不含暂停时长
          _loop();
        }
        if (deps.onPause) deps.onPause(_paused);
        return this;
      },
      getPaused: function () { return _paused; },
      // 时间基准归零：uTime 从 0 重新起算。加载效果库文件时调用——面板预览是常驻循环，
      // uTime 已累计到很大的值，载入一份新效果会直接从中途时刻开始（与「刚打开这份效果」
      // 的预期不符，动画类 shader 表现为一进来就跳到后段）。
      // 结算器状态一并清零（与 setUniformValue/_installCompileResult 同口径）：@solve 的
      // 状态活在 _solveLastTex 里，只归零 uTime 它会带着旧状态继续推进，重置形同虚设；
      // 且加载同一文件会命中 setSource 幂等缓存跳过重装，结算器只能在这里被清。
      // 暂停态同步重绘一帧 t=0，否则画面仍停在旧时刻、要等恢复才更新。
      resetTime: function () {
        if (_destroyed) return this;
        _elapsedMs = 0;
        // 仅运行中/曾启动过才挪基准：未启动时本就没有时间在累加，不动 _started，
        // 以免把 start() 的 `if (_started) return` 幂等守卫提前置位。
        if (_started) _started = Date.now();
        _resetSolveState();
        if (_paused) _render(0);
        return this;
      },
      // —— 多时间点渲染（getShaderPreview 的 timesInSeconds 用）——
      // 按 times（秒）逐点渲染并同步回调 onFrame(meta)，调用方在回调内截 canvas。
      // 时间点语义：无迭代趟/帧内迭代 = 直接以该 uTime 绘制（纯函数）；结算器 = 从第 0 帧
      // 按固定帧率顺序重解到目标帧（uTime 取各帧时刻，等价于从头播放到该时刻），单点上限
      // SOLVER_SAMPLE_MAX_SECONDS，超出钳制并回执 timeClamped。
      // 采样结束恢复现场：无迭代趟恢复采样前画面（播放中按实时时间重绘、暂停时冻结原帧）；
      // 结算状态无法复原——停在最后采样点，播放中从该点继续、暂停时冻结在该帧。
      // 返回 { ok, mode, frames:[{time, actualTime, frame}], timeClamped, frameRate }。
      renderFrameSequence: function (times, onFrame) {
        var st = _sequenceBegin(times);
        if (st.error) return { ok: false, error: st.error };
        for (var i = 0; i < st.list.length; i++) {
          var t = st.list[i];
          var meta;
          if (st.solver) {
            var targetFrame = Math.floor(t * st.fps);
            // 目标帧落在结算进度之前：从第 0 帧重解（与宿主 solve-rewind 同口径）
            if (targetFrame < _solveFrame - 1) _resetSolveState();
            // 每轮恰好推进一帧；上界防不变量被改坏时死循环（正常路径恒 ≤ targetFrame+1 轮）
            var guard = targetFrame + 2;
            while (_solveFrame <= targetFrame) {
              if (--guard < 0) return { ok: false, error: '结算推进异常（帧号未按预期前进）' };
              _sequenceAdvanceFrame(st);
            }
            st.lastActual = targetFrame / st.fps;
            meta = { time: t, actualTime: st.lastActual, frame: targetFrame };
          } else {
            _render(t);
            meta = { time: t, actualTime: t, frame: null };
          }
          st.frames.push(meta);
          if (typeof onFrame === 'function') {
            try { onFrame(meta, i); } catch (_) {}
          }
        }
        _sequenceFinish(st);
        return {
          ok: true,
          mode: st.solver ? 'solver' : 'stateless',
          frames: st.frames,
          timeClamped: st.clamped,
          frameRate: st.fps || null
        };
      },
      // 与 renderFrameSequence 同语义的异步版：每帧之间让出主线程，供长时抓帧（结算器 +
      // 高分辨率网格）不在主线程上一次跑完。opts.shouldAbort() 返回 true 时中止。
      // 让出粒度是"帧"——结算器单帧内的子步循环不可中断，单帧耗时仍是主线程卡顿的上限。
      renderFrameSequenceAsync: function (times, onFrame, opts) {
        var o = opts || {};
        var shouldAbort = function () {
          try { return typeof o.shouldAbort === 'function' && !!o.shouldAbort(); } catch (_) { return false; }
        };
        var st = _sequenceBegin(times);
        if (st.error) return Promise.resolve({ ok: false, error: st.error });
        var since = Date.now();
        function yieldNow() { return new Promise(function (r) { setTimeout(r, 0); }); }
        return new Promise(function (resolve) {
          async function run() {
            for (var i = 0; i < st.list.length; i++) {
              var t = st.list[i];
              var meta;
              if (st.solver) {
                var targetFrame = Math.floor(t * st.fps);
                if (targetFrame < _solveFrame - 1) _resetSolveState();
                var guard = targetFrame + 2;
                while (_solveFrame <= targetFrame) {
                  if (--guard < 0) { resolve({ ok: false, error: '结算推进异常（帧号未按预期前进）' }); return; }
                  _sequenceAdvanceFrame(st);
                  if (shouldAbort()) { _sequenceFinish(st); resolve({ ok: false, cancelled: true, error: '已取消' }); return; }
                  // 时间预算让出：单帧耗时不变，让出粒度为两帧之间
                  if (Date.now() - since >= 30) { await yieldNow(); since = Date.now(); }
                }
                st.lastActual = targetFrame / st.fps;
                meta = { time: t, actualTime: st.lastActual, frame: targetFrame };
              } else {
                _render(t);
                if (shouldAbort()) { _sequenceFinish(st); resolve({ ok: false, cancelled: true, error: '已取消' }); return; }
                meta = { time: t, actualTime: t, frame: null };
              }
              st.frames.push(meta);
              if (typeof onFrame === 'function') {
                try { onFrame(meta, i); } catch (_) {}
              }
              await yieldNow();
              since = Date.now();
            }
            _sequenceFinish(st);
            resolve({
              ok: true,
              mode: st.solver ? 'solver' : 'stateless',
              frames: st.frames,
              timeClamped: st.clamped,
              frameRate: st.fps || null
            });
          }
          run().catch(function (e) {
            _sequenceFinish(st);
            resolve({ ok: false, error: (e && e.message) || String(e) });
          });
        });
      },
      // —— 预览相机操控（UI 层 pointer 拖拽转发，单位 = CSS 像素 dpr 无关）——
      // 左键旋转：绕目标点轨道。yaw 反向（拖向右 = 相机左移）使画面跟随光标，
      // 与主流 3D 视口（Blender/Maya/three.js 轨道控制器）手感一致。
      orbitCamera: function (dx, dy) {
        if (_destroyed) return this;
        _camAutoFrame();   // 首次交互发生在首帧渲染之前（dist 尚未定）时先取景，避免以 0 距离起算
        _cam.yaw -= (Number(dx) || 0) * CAM_ORBIT_PER_PX;
        _cam.pitch = _clamp(_cam.pitch + (Number(dy) || 0) * CAM_ORBIT_PER_PX, -CAM_PITCH_LIMIT, CAM_PITCH_LIMIT);
        _cam.touched = true; _camDirty = true;
        _camRepaint();
        return this;
      },
      // 右键推拉：正值 = 拉近（相机前推）、负值 = 拉远。距离按指数变化，远近手感对称；
      // 调用方按手势轴给符号（预览交互：右键向右拖 = 拉近，见 shaderUI.bindPreviewCamera）。
      zoomCamera: function (d) {
        if (_destroyed) return this;
        _camAutoFrame();   // 同上：先有取景距离再缩放
        _cam.dist = _clamp(_cam.dist * Math.exp(-(Number(d) || 0) * CAM_ZOOM_PER_PX), CAM_DIST_MIN, CAM_DIST_MAX);
        _cam.touched = true; _camDirty = true;
        _camRepaint();
        return this;
      },
      // 中键平移：目标点沿相机基（右/上）反向移动，位移按「目标平面处每 CSS 像素的世界单位」
      // 换算——画面位移与光标位移 1:1，且缩放后仍成立。分母用**显示尺寸**（绘制缓冲 ÷ DPR）
      // 而非元素框高度：与所见画面同口径（两轴取整差出的亚像素不参与换算）。
      panCamera: function (dx, dy) {
        if (_destroyed) return this;
        _camAutoFrame();      // 同上
        _camUpdateMatrix();   // 取当前基向量（幂等：脏标记命中时不重算）
        var h = _viewportCssSize().h || 200;
        // 目标平面处的可见高度 = 2·dist·tan(半视场) = 2·dist / fovCoef（fovCoef = 1/tan）
        var wpp = (2 * _cam.dist / CAM_FOV_COEF) / Math.max(1, h);
        var mx = (-_camRight[0] * (Number(dx) || 0) + _camUp[0] * (Number(dy) || 0)) * wpp;
        var my = (-_camRight[1] * (Number(dx) || 0) + _camUp[1] * (Number(dy) || 0)) * wpp;
        var mz = (-_camRight[2] * (Number(dx) || 0) + _camUp[2] * (Number(dy) || 0)) * wpp;
        _cam.target[0] += mx; _cam.target[1] += my; _cam.target[2] += mz;
        _cam.touched = true; _camDirty = true;
        _camRepaint();
        return this;
      },
      // 恢复默认取景（正面、整个世界可见）：清 touched 让 _camAutoFrame 重新接管，
      // 面板宽高比变化后默认取景继续自动校准。
      resetCamera: function () {
        if (_destroyed) return this;
        var ws = _worldSize();
        _cam.yaw = 0; _cam.pitch = 0; _cam.dist = 0; _cam.touched = false;
        _cam.target[0] = ws.w * 0.5; _cam.target[1] = -ws.h * 0.5; _cam.target[2] = 0;
        _camDirty = true;
        _camRepaint();
        return this;
      },
      // 相机状态读写（离屏抓帧转交主预览的取景：截图与用户在面板里看到的构图一致）。
      // 离屏实例默认自动取景；主实例被用户拖过（touched）时把 yaw/pitch/dist/target 一并转交。
      getCamera: function () {
        return {
          yaw: _cam.yaw,
          pitch: _cam.pitch,
          dist: _cam.dist,
          touched: !!_cam.touched,
          target: [_cam.target[0], _cam.target[1], _cam.target[2]]
        };
      },
      setCamera: function (st) {
        if (!st || typeof st !== 'object') return this;
        if (typeof st.yaw === 'number' && isFinite(st.yaw)) _cam.yaw = st.yaw;
        if (typeof st.pitch === 'number' && isFinite(st.pitch)) {
          _cam.pitch = _clamp(st.pitch, -CAM_PITCH_LIMIT, CAM_PITCH_LIMIT);
        }
        if (typeof st.dist === 'number' && isFinite(st.dist) && st.dist > 0) {
          _cam.dist = _clamp(st.dist, CAM_DIST_MIN, CAM_DIST_MAX);
        }
        if (st.target && typeof st.target.length === 'number' && st.target.length === 3) {
          var tx = Number(st.target[0]), ty = Number(st.target[1]), tz = Number(st.target[2]);
          if (isFinite(tx) && isFinite(ty) && isFinite(tz)) {
            _cam.target[0] = tx; _cam.target[1] = ty; _cam.target[2] = tz;
          }
        }
        _cam.touched = !!st.touched;
        _camDirty = true;
        return this;
      },
      // 预热（幂等）：提前完成 WebGL 上下文创建 + 驱动着色器编译器初始化 + 占位纹理，
      // 把首次 setSource 的一次性 GL 开销（CEF 下可达数百 ms）挪到进入模式后的空闲
      // 时刻（shaderUI schedulePreviewInit 调度）。预热程序临时安装渲染一帧后立即
      // 释放——这一帧现付 canvas 实际尺寸的 drawing buffer 分配、首次呈现的合成层
      // 建立、首次 draw 管线等一次性开销（若不预热会全部叠在首个真实 shader 编译
      // 完成的显示瞬间）；画面为近黑单帧，与占位态视觉一致，预览保持"提交代码后
      // 自动渲染"占位语义，首个真实 setSource 照常编译。
      warmup: function () {
        if (_destroyed || _gl) return;
        _acquireContext();
        if (!_gl) return;
        var r = _compileAndLink('vec4 mainImage(vec2 f, float t){return vec4(0.0,0.0,0.0,1.0);}');
        if (r.prog) {
          _program = r.prog;
          _setupGeometry();
          _render(0);
          _cleanupProgram();
        }
        _ensurePlaceholderTexture();
      },
      destroy: function () {
        _destroyed = true;
        _compileGen++; _pending = false; _pendingUniforms = null;  // 在途异步编译轮询经 _destroyed 守卫丢弃句柄
        this.stop();
        _cleanupProgram();
        if (_gl && _placeholderTex) { _gl.deleteTexture(_placeholderTex); _placeholderTex = null; }
        // 映射图层兜底纹理同款回收
        if (_gl && _mapStubTex) { _gl.deleteTexture(_mapStubTex); _mapStubTex = null; }
        // 播种零状态纹理同款回收
        if (_gl && _zeroTex) { _gl.deleteTexture(_zeroTex); _zeroTex = null; _zeroW = 0; _zeroH = 0; }
        // 迭代趟 ping-pong 资源：FBO + 两张纹理，不回收会随
        // 渲染器重建累积（上下文槽位有限，与 _placeholderTex 同款纪律）
        if (_gl && _fbo) { _gl.deleteFramebuffer(_fbo); _fbo = null; }
        if (_gl) {
          for (var ti = 0; ti < 2; ti++) {
            if (_ppTex[ti]) { _gl.deleteTexture(_ppTex[ti]); _ppTex[ti] = null; }
          }
        }
        _ppW = 0; _ppH = 0; _iterCount = 0;
        // 尺寸观察者同款回收：不断开则已释放的画布仍被观察（回调还会走 _syncCanvasSize，
        // 虽然 _destroyed 已挡住重绘，但观察者本身是泄漏的注册项）
        if (_ro) { try { _ro.disconnect(); } catch (_) {} _ro = null; }
        // 上下文丢失/恢复监听同款回收（观察者同一纪律：画布节点是静态复用的，不摘监听
        // 会让已销毁实例在下次上下文事件时被复活回调）
        if (_ctxLossBound && _canvas && typeof _canvas.removeEventListener === 'function') {
          try {
            _canvas.removeEventListener('webglcontextlost', _onContextLost, false);
            _canvas.removeEventListener('webglcontextrestored', _onContextRestored, false);
          } catch (_) {}
          _ctxLossBound = false;
        }
        _deadGl = _gl;   // 在途异步编译的句柄仍要回收（轮询在 destroy 之后才触发）
        _gl = null; _canvas = null; _pce = null;
      }
    };
    return _api;
  }

  global.AEShaderPreview = global.AEShaderPreview || {};
  global.AEShaderPreview.createShaderPreviewRenderer = createShaderPreviewRenderer;
})(window);
