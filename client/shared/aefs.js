// =============================================================================
// AEFS — CEP 10 统一文件系统接口 (AE 2023+)
//
// 设计约束
// -------
// - CEP 10 Chrome 88 CEF，Node.js 不可用，require/process/Buffer 全不存在
// - cep.fs: readFile/writeFile/readdir/deleteFile 可用，mkdir 实测缺失（CEP 10）
// - 扩展目录在 Program Files（UAC 只读），数据在 AppData（可写）
// - 所有路径来自 getSystemPath / __ext_root，是合法 Windows 路径
// - CEP 沙箱限制：cep.fs 可能读不了 Program Files 下的扩展文件 → readFile 用 fetch 兜底
//
// 回退链
// ------
// 异步版：Bridge（异步 XHR / fetch → Node.js fs）→ cep.fs → ExtendScript，永不 reject
// 同步版：Bridge（同步 XHR → Node.js fs，仅经 isSyncSafe 门禁放行时）→ cep.fs，
//         直接返回值，不经过 ExtendScript
// 同步 XHR 不能设 timeout——桥「TCP 可连但不响应」时同步调用会把面板主线程
//   永久冻结（心跳/断线浮层也失去执行机会）。同步族入口统一经 _bridgeOkSync()：
//   除 isAvailable 外还要求桥最近被异步探活确认有响应（Bridge.isSyncSafe）；桥半死/
//   证据过期一律落 cep.fs 本地通道，不再发起无超时的同步 XHR。
//   门禁覆盖全族同步入口（read/write/writeBase64/readImage/exists/isFile/list*/
//   mkdir/deleteFile/rmdir/copyFile/renameFile/renameDir）——新增或漏改任一入口
//   即重新引入冻结面。
//
// 同步版局限（无 bridge 时）：
// listDirsSync → readdir + stat.isDirectory() 过滤（stat 不可用时返 []，调用方兜底 ExtendScript）
//   rmdirSync → cep.fs 官方无目录删除原语，探测到 rmdir 能力才回退，否则 false
// 其余同步接口均可在无 bridge 时降级到 cep.fs 工作（bridge 通道失败亦下落）
//
// 安全
// ----
// _checkPath 五道防线：
//   ① 拒 %（URL 编码攻击，合法路径无需编码）
//   ② 控制字符 + 引号
//   ③ . 和 .. 段边界检测
//   ④ 绝对路径 + 压缩连续斜杠；唯一例外=已登记的数据根 UNC 本身及其子路径
// （登记见 setAllowedUncRoot / dataDir.js）
//   ⑤ DOS 设备名（全路径段，去扩展名）
// _safeForDelete — deleteFile/rmdir/removeDirRecursive 共用白名单命名空间
//   skills/memories/ae-tools/agent/temp/scripts/workflows/comfyui/_comfyui_output
//   llm-providers/nodegen/presets/project-assets/asset-refs/deepseekPet
//   新增需删除能力的模块时，同步更新此处、SAFE_NAMESPACES(L161) 和 bridge-server.js SAFE_NAMESPACES
// removeDirRecursive — ⚠️ 危险：递归删整棵目录树（含所有内容），不可恢复
//   用于批量删除性能优化（Bridge 一次 rmSync 替代逐个 deleteFile）
//   安全校验链：_checkPath → _safeForDelete → _depthOk(2) → Bridge 端 safePath+safeForDelete+minDepthOk+resolveRealSafe
//   详见函数注释（搜 removeDirRecursive）。调用方必须确认目录路径在白名单命名空间内且深度≥2
// =============================================================================

(function (global) {

  // _extRoot 懒取值——aefs.js 加载时 __ext_root 可能还没设好
  function _getExtRoot() {
    try {
      if (typeof window !== 'undefined' && window.__ext_root) {
        return String(window.__ext_root).replace(/\\/g, '/');
      }
    } catch (_) {}
    return '';
  }

  function _getEncoding() {
    try {
      // !== undefined 而非 truthy——UTF8 值可能是 0
      if (typeof window !== 'undefined' && window.cep && window.cep.encoding !== undefined && window.cep.encoding.UTF8 !== undefined) {
        return window.cep.encoding.UTF8;
      }
    } catch (_) {}
    // 回退：CEP 编码常量通常是数字，UTF8 通常为 0
    return 0;
  }

  // ════════════════════════════════════════════════════════
  //  Result 三态约定（回退链 Result 化，第一步）
  //  形态：{ ok: true, data } / { ok: false, error: { code, message, channel } }
  //  失败三态显式——区分「真没有」与「拿不到」，根治「通道故障折叠为
  //  数据状态」族（会话读失败→空会话→覆盖丢数据、遍历失败→空源→迁移假成功、
  //  4xx→空列表、通道故障→missing 标记）：
  //    NOT_FOUND        通道正常但目标不存在（真没有）
  //    CHANNEL_FAILURE  通道故障——Bridge/cep.fs/ExtendScript 失败或不可用（拿不到）
  //    REJECTED         明确拒绝——路径校验/安全白名单等确定性拒绝（不该拿）
  //  channel 记录失败所在层：'bridge' | 'cepfs' | 'extendscript'（多层全败
  //  记最终层）。当前只落类型与构造助手，不动现有签名——存量 API 按调用方
  //  逐个迁移。
  // ════════════════════════════════════════════════════════
  var RESULT_CODES = {
    NOT_FOUND: 'NOT_FOUND',
    CHANNEL_FAILURE: 'CHANNEL_FAILURE',
    REJECTED: 'REJECTED'
  };

  function _resultOk(data) {
    return { ok: true, data: data };
  }

  function _resultErr(code, message, channel) {
    return {
      ok: false,
      error: {
        code: code,
        message: String(message == null ? '' : message),
        channel: channel || null
      }
    };
  }

  // ════════════════════════════════════════════════════════
  //  失败体的展示层映射
  //  失败体有两种形态：Result 失败体 { ok:false, error:{ code, message, channel } }
  //  （code 为 RESULT_CODES），以及写/删通道的 { ok:false, reason, detail }
  //  （reason 是小写判据，如 invalid_path / body_too_large / denied）。
  //  两者都带机器码：展示前经 reasonToCode 归到错码文案表
  //  （client/shared/i18n/errorCodes.js）的键，再由 AEI18n.err 取当前语言文案。
  //  文案表与运行时都在**调用时**读取：aefs.js 顶层不引用 AEI18n/错码表
  //  （沙箱与早期装载阶段可能还没有它们）。
  // ════════════════════════════════════════════════════════

  // 归一后的自由文本别名：只收与既有码语义同一的写法，避免给出错误的处置建议。
  //   BRIDGE_UNAVAILABLE   桥不可用 = 通道故障（不是目标不存在）
  //   NOT_IN_SAFE_NAMESPACE 命名空间白名单拒绝 = 路径校验类确定性拒绝
  var REASON_ALIASES = {
    BRIDGE_UNAVAILABLE: 'CHANNEL_FAILURE',
    NOT_IN_SAFE_NAMESPACE: 'REJECTED'
  };

  /**
   * 失败判据 → 错码文案表的键。
   * 大小写不敏感，空格/短横线与下划线等价（'invalid path' 与 'invalid_path' 同键）。
   * @param {string} reason — 小写 reason 或 error.code
   * @returns {string} 表中存在的键；表外取值（含无码、文案表未装载）返回空串
   */
  function reasonToCode(reason) {
    var s = String(reason == null ? '' : reason).trim();
    if (!s) return '';
    s = s.toUpperCase().replace(/[\s\-]+/g, '_');
    var table = global.AE_I18N_ERROR_CODES;
    if (!table) return '';
    var key = (Object.prototype.hasOwnProperty.call(REASON_ALIASES, s)) ? REASON_ALIASES[s] : s;
    return Object.prototype.hasOwnProperty.call(table, key) ? key : '';
  }

  // 失败体里的原始详情：error.message 优先，其次 detail，末位 message。
  // 兼容 { ok:false, error:'<原文>', code }（桥接拒绝体的 error 是字符串）。
  // 全空时返回空串（不拿机器码顶详情——码已由 reasonToCode 处理）。
  function _errorDetail(value) {
    if (value == null) return '';
    if (typeof value !== 'object') return String(value);
    var err = (value.error && typeof value.error === 'object') ? value.error : value;
    var candidates = [err.message, value.message, err.detail, value.detail,
      (typeof value.error === 'string') ? value.error : null];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] != null && String(candidates[i]) !== '') return String(candidates[i]);
    }
    return '';
  }

  // 失败体里的机器码：error.code / error.reason 优先，兼容顶层 code / reason。
  function _errorCode(value) {
    if (!value || typeof value !== 'object') return '';
    var err = (value.error && typeof value.error === 'object') ? value.error : value;
    var candidates = [err.code, err.reason, value.code, value.reason];
    for (var i = 0; i < candidates.length; i++) {
      var code = reasonToCode(candidates[i]);
      if (code) return code;
    }
    return '';
  }

  /**
   * 失败体 → 展示文案，形如「本地化一句话: 原始详情」。
   * 两种失败体（Result 的 error.code、写/删通道的 reason）与 Error 实例都接受，
   * 纯文本按原文返回。原始详情一律保留（诊断不丢）；文案与详情相同时不重复拼接。
   * 码不在文案表内（含无码、AEI18n 未装载）时原样返回详情——不猜码、不臆造文案。
   * @param {object|string} value — Result 失败体 / {reason,detail} / Error / 文本
   * @returns {string}
   */
  function displayError(value) {
    var raw = _errorDetail(value);
    var code = _errorCode(value);
    if (!code) return raw;
    var i18n = global.AEI18n;
    if (!i18n || typeof i18n.err !== 'function') return raw;
    // 占位符参数只能从原始详情解析；解析不到就不走文案表，
    // 否则把 {max} 露给用户（与 bridge.js failureText 同一口径）。
    var params = null;
    if (code === 'BODY_TOO_LARGE') {
      var m = /max\s+(\d+)/i.exec(raw);
      if (!m) return raw;
      params = { max: m[1] };
    }
    var text = String(i18n.err(code, params, raw || code));
    if (!text) return raw;
    return (raw && raw !== text) ? (text + ': ' + raw) : text;
  }

  // cep.fs「真没有」的权威错误码（同步/异步读取面共用单一来源）。CEP 运行时把
  // ERR_NOT_FOUND 挂在 cep.fs 上；无常量的旧运行时按 CEP 文档值 3 字面比较。
  // 单点化前异步 Result 版内联一份、同步面只能各自折叠——同步面正因此把
  // 「文件不存在」误记成「全部通道失败」（首启 MEMORY.md / hotbox config.json 必经）。
  function _cepNotFoundCode() {
    return (window.cep && window.cep.fs && typeof window.cep.fs.ERR_NOT_FOUND === 'number')
      ? window.cep.fs.ERR_NOT_FOUND
      : 3;
  }

  // ====== 内部工具 ======

  // ── 数据根 UNC 白名单 ────────────────────────
  // 企业域环境 %APPDATA% 常被重定向到文件服务器，数据根变成 UNC（\\server\share\...）；
  // _checkPath 只认盘符路径时，记忆/技能/素材索引/会话缓存全部静默写不进去。
  // 放行面最小化：仅「数据根 UNC 本身及其子路径」，其余 UNC 一律照旧拒绝。
  // 单点真相源：dataDir.js 解析出实际数据根后经 setAllowedUncRoot() 登记（唯一写入方），
  // 面板侧读取走 getAllowedUncRoot()；bridge 侧由面板经 POST /api/set-data-dir 同步。
  var _allowedUncRoot = '';

  // UNC 判定 + 规范化（\\server\share\x 与 //server/share/x 等价两种写法）：
  //   统一正斜杠、小写、压缩斜杠、去尾斜杠 → //server/share/x；尾部无斜杠为根形态。
  //   \\?\UNC\ 扩展前缀不放行：实测 Node fs.realpathSync 拒绝该前缀（EISDIR/lstat 'UNC'，
  //   仅 realpathSync.native 可用），bridge 的 resolveRealSafe/symlink 复核链依赖
  //   realpathSync → 放行即链路失败；普通 UNC 无需转换（\\server\share
  //   这类写法读写删均通，cep.fs 同样接受）。
  //   非 UNC（盘符 / 单斜杠根相对路径 / \\?\ 扩展前缀）返回 ''：'\server\share' 是当前
  //   盘根相对路径，与 UNC 不是同一位置，绝不能混同放行。
  function _normUncPath(p) {
    if (!p || typeof p !== 'string') return '';
    if (/^[\\\/]{2}\?/.test(p)) return '';   // \\?\ / //?/ 扩展前缀：fail-closed
    if (!/^[\\\/]{2}[^\\\/]/.test(p)) return '';
    var fwd = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
    // 至少 server/share 两段才是有效 UNC 共享路径（\\server 不可写）
    var segs = fwd.replace(/^\/+/, '').split('/').filter(function (x) { return !!x; });
    if (segs.length < 2) return '';
    return fwd.toLowerCase();
  }

  // 登记允许的 UNC 数据根（唯一写入方：dataDir.js；传盘符/空值 → 清空，保持 fail-closed）
  function setAllowedUncRoot(root) {
    var norm = _normUncPath(root);
    _allowedUncRoot = norm;
    if (norm) console.log('[AEFS] 数据根 UNC 白名单登记: ' + norm);
    return norm;
  }

  function getAllowedUncRoot() { return _allowedUncRoot; }

  // 路径是否等于允许根或以「根 + '/'」开头（大小写不敏感；比较用规范化形态）
  function _isUnderAllowedUncRoot(p) {
    if (!_allowedUncRoot) return false;
    var norm = _normUncPath(p);
    if (!norm) return false;
    return norm === _allowedUncRoot || norm.indexOf(_allowedUncRoot + '/') === 0;
  }

  // 路径安全校验（防穿越 / 注入 / 空 / 非字符串）
  // 每个拒绝分支**都要写 `_lastError`**：只 `console.warn`
  // 就 return false，于是调用方（readFileSync/readFile/…）返回 null 而 `lastError()` 是空串
  // → 工具层只能给出三合一文案「文件不存在、无法读取或解析失败」，把「路径被数据层拒绝」
  // 说成「文件不存在」。触发面很实在：用户账户名含撇号（`C:\Users\O'Brien\…`，域环境常见）
  // 或文件名含 `%`（`100%完成.txt`）时，该用户目录下**任何**文件都不可读，却不给任何原因
  //（写侧反而诚实：`writeFileLlm` 回 `invalid_path` +「路径格式非法」）。
  // 修法：统一经 `_rejectPath` 出口，把原因（含 `explainDataDirSafety` 的现成解释）写进 `_lastError`。
  function _rejectPath(p, reason) {
    _lastError = '路径被数据层拒绝（' + reason + '）: ' + String(p || '').substring(0, 120);
    return false;
  }
  function _checkPath(p) {
    if (!p || typeof p !== 'string') return _rejectPath(p, '路径为空或非字符串');

    // ① 含 % → 直接拒（合法路径不会有编码，有就是攻击）
    if (p.indexOf('%') !== -1) {
      console.warn('[AEFS] 拒绝含 % 的路径: ' + p.substring(0, 80));
      return _rejectPath(p, '路径含「%」（按编码攻击拒；若确是文件名请改名）');
    }

    // ② 控制字符（0x00-0x1F / 0x7F）和引号 `"` `'`
    for (var i = 0; i < p.length; i++) {
      var c = p.charCodeAt(i);
      if (c <= 0x1F || c === 0x7F || c === 0x22 || c === 0x27) {
        console.warn('[AEFS] 拒绝含非法字符的路径 (0x' + c.toString(16) + '): ' + p.substring(0, 80));
        return _rejectPath(p, '路径含非法字符 0x' + c.toString(16)
          + (c === 0x22 || c === 0x27 ? '（引号；若确是目录名含撇号请改名）' : ''));
      }
    }

    // ③ .. 或 . 作为完整路径段 → 目录穿越（. 能充段数绕过深度）
    if (/(^|[\\\/\:])\.\.([\\\/\:]|$)/.test(p) ||
        /(^|[\\\/\:])\.([\\\/\:]|$)/.test(p)) {
      console.warn('[AEFS] 拒绝含 . 或 .. 段的路径: ' + p);
      return _rejectPath(p, '路径含 . 或 .. 段');
    }

    // ③b 段尾点/空格归一后为 . 或 .. 的别名段（Win32 剥尾语义：'.. '→'..'）同样拒
    var dotSegs = p.split(/[\\\/]/);
    for (var ds = 0; ds < dotSegs.length; ds++) {
      if (/^\.\.?[. ]*$/.test(dotSegs[ds])) {
        console.warn('[AEFS] 拒绝含 . 或 .. 别名段的路径: ' + p);
        return _rejectPath(p, '路径含 . 或 .. 段（尾随点/空格别名）');
      }
    }

    // ④ 绝对路径检查：必须以盘符开头（D:/）或 file:///D:/ 格式；
    // 唯一例外——已登记的数据根 UNC 本身及其子路径。
    var cleaned = p.replace(/\\/g, '/');
    // 压缩连续斜杠防止绕过
    cleaned = cleaned.replace(/\/+/g, '/');
    if (/^[A-Za-z]:\//.test(cleaned)) {
      // 正常 D:/ 路径
    } else if (/^file:\/+/i.test(cleaned)) {
      var stripped = cleaned.replace(/^file:\/+/i, '');
      if (!/^[A-Za-z][:\|]\//.test(stripped)) {
        console.warn('[AEFS] 拒绝非法的 file:/// 路径: ' + p);
        return _rejectPath(p, 'file:/// 形态非法');
      }
    } else if (_isUnderAllowedUncRoot(p)) {
      // 数据根 UNC 白名单：仅 setAllowedUncRoot 登记的数据根本身/子路径。
      // 用原始 p 判定——上面的 cleaned 已把 //server 压成 /server，无法与
      // 单斜杠盘根相对路径（\server\share）区分，会误放行非 UNC 路径。
      // ①②③（% / 控制字符 / 引号 / . 与 .. 段）已先行执行，UNC 放行不豁免。
    } else {
      console.warn('[AEFS] 拒绝非绝对路径: ' + p);
      return _rejectPath(p, '不是绝对路径（需盘符开头；未登记的 UNC 一律拒）');
    }

    // ⑤ 任意路径段不能是 DOS 保留设备名（去扩展名后判断，NUL.txt 也是设备）
    var segs = cleaned.replace(/\/+$/, '').split('/');
    for (var j = 0; j < segs.length; j++) {
      var upper = segs[j].replace(/\..*$/, '').toUpperCase();
      if (upper === 'NUL' || upper === 'CON' || upper === 'CONIN$' || upper === 'CONOUT$' ||
          upper === 'PRN' || upper === 'AUX' ||
          /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) {
        console.warn('[AEFS] 拒绝含 DOS 设备名的路径: ' + segs[j]);
        return _rejectPath(p, '含 DOS 保留设备名段「' + segs[j] + '」');
      }
    }

    return true;
  }

  function _toWin(path) {
    if (!path) return '';
    // _checkPath 已拒掉所有 % 字符，无需解码
    return String(path).replace(/^file:\/+/i, '').replace(/\|/g, ':').replace(/\//g, '\\');
  }

  function _toFwd(path) {
    return _toWin(path).replace(/\\/g, '/');
  }

  function _parentDir(winPath) {
    return winPath.replace(/\\/g, '/').replace(/\/[^\/]+$/, '');
  }

  function _hasCepFs() {
    try { return !!(typeof window !== 'undefined' && window.cep && window.cep.fs); }
    catch (_) { return false; }
  }

  // 细粒度探测：cep.fs 对象存在 ≠ 每个方法能用（CEP 10 可能阉掉部分方法）
  function _canRead()  { return _hasCepFs() && typeof window.cep.fs.readFile === 'function'; }
  function _canWrite() { return _hasCepFs() && typeof window.cep.fs.writeFile === 'function'; }
  function _canMkdir() { return _hasCepFs() && typeof window.cep.fs.mkdir === 'function'; }
  function _canDelete(){ return _hasCepFs() && typeof window.cep.fs.deleteFile === 'function'; }
  function _canReaddir(){return _hasCepFs() && typeof window.cep.fs.readdir === 'function'; }
  // rename/stat 为 cep.fs 官方原语（CEPEngine_extensions.js）；rmdir 官方不存在
  //（deleteFile 仅删文件，目录删除无原语）——探测不到即优雅降级，防 CEP 环境外误用
  function _canRename(){ return _hasCepFs() && typeof window.cep.fs.rename === 'function'; }
  function _canStat()  { return _hasCepFs() && typeof window.cep.fs.stat === 'function'; }
  function _canRmdir() { return _hasCepFs() && typeof window.cep.fs.rmdir === 'function'; }

  // cep.fs 回退写一律走**原子写**（临时件 + rename），与桥侧 .part 语义对齐。
  // 背景：桥侧写是 .part+rename（盘满时旧文件完好并如实 500），但 5xx 不在 4xx 白名单里 →
  // 面板把它当「通道失败」落本回退通道，而 cep.fs.writeFile 是「先截断再写」——盘满时写不进去、
  // 旧内容也没了（旧的记忆/会话/配置被清成半截）。临时件命名对齐 bridge 的拷贝族
  //（<名>.<ts>-<seq>-<rand>.part）：/fs/list 会隐藏、桥的陈旧清扫（>24h）会回收，不留可见垃圾。
  // cep.fs.rename 不可用或 rename 失败 → 清理临时件后回退直写（可用性优先；直写只在 rename 通道
  // 坏时残留截断风险）。
  var _atomicSeq = 0;
  function _atomicTempPath(fp) {
    return fp + '.' + Date.now() + '-' + (++_atomicSeq) + '-' + Math.random().toString(36).slice(2, 10) + '.part';
  }
  function _writeCepFsAtomic(fp, data, encoding) {
    if (!_canRename()) {
      var r0 = window.cep.fs.writeFile(fp, data, encoding);
      return !!(r0 && r0.err === 0);
    }
    var tmp = _atomicTempPath(fp);
    var w = window.cep.fs.writeFile(tmp, data, encoding);
    if (!w || w.err !== 0) {
      try { window.cep.fs.deleteFile(tmp); } catch (_) {}
      return false;   // 内容没落盘 → 目标文件保持旧内容（这正是原子写的意义）
    }
    var rn = window.cep.fs.rename(tmp, fp);
    if (rn && rn.err === 0) return true;
    try { window.cep.fs.deleteFile(tmp); } catch (_) {}
    var r2 = window.cep.fs.writeFile(fp, data, encoding);
    return !!(r2 && r2.err === 0);
  }
  function _hasCS() {
    try { return typeof CSInterface !== 'undefined'; }
    catch (_) { return false; }
  }

  // 深度检查：路径段数 ≥ min，防删/写浅层目录
  function _depthOk(path, min) {
    var fwd = _toFwd(path);
    var normalized = fwd.replace(/^[A-Za-z]:\//, '').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    var segs = normalized ? normalized.split('/').filter(function (s) { return s.trim().length > 0; }) : [];
    return segs.length >= min;
  }

  // 安全命名空间：只有路径包含这些段时，才允许 deleteFile/rmdir
  // 新增需删除能力的模块时，同步更新此列表
  var SAFE_NAMESPACES = ['skills', 'memories', 'ae-tools', 'agent', 'temp', 'scripts', 'workflows', 'comfyui', '_comfyui_output', 'llm-providers', 'nodegen', 'presets', 'project-assets', 'asset-refs', 'deepseekPet', 'effects', 'AS_ExtP'];
  function _safeForDelete(path) {
    // 压缩连续斜杠后再判定，防止 c://windows/... 绕过系统目录正则（_toFwd 不压缩）
    var fwd = _toFwd(path).toLowerCase().replace(/\/+/g, '/');
    // ① 拒系统目录/根目录（段级归一含尾随点/空格与 8.3 短名，与 isDataDirSafe 同口径）
    if (_isSystemOrRootDir(path)) {
      _lastError = '安全拒绝: 路径位于系统/危险目录 — ' + path;
      console.warn('[AEFS] _safeForDelete 拒危险路径: ' + path);
      return false;
    }
    // ② 白名单命名空间
    // 命中条件：路径含 /ns/（中间段）或以 /ns 结尾（末尾段）。
    // ⚠️ 末尾段判断必须先确认 /ns 存在（idx !== -1）再比位置——单写 indexOf(...)===len-ns-1
    // 会在串不存在(idx=-1)且 ns.length===fwd.length(目标位置也是-1)时误判命中（如 c:/x.png 长度8
    // 命中 memories/ae-tools 长度8），导致 depth=1 盘根文件绕过白名单。
    // ⚠️ ns 必须小写化后再匹配：fwd 已经被 toLowerCase() 小写化，
    // 若 SAFE_NAMESPACES 中存在驼峰命名（如 'deepseekPet'），不统一小写会导致 indexOf 永远找不到匹配。
    for (var i = 0; i < SAFE_NAMESPACES.length; i++) {
      var ns = SAFE_NAMESPACES[i].toLowerCase();
      var slashNs = '/' + ns;
      var idx = fwd.indexOf(slashNs);
      if (idx !== -1 && (fwd.indexOf(slashNs + '/') !== -1 || idx === fwd.length - ns.length - 1)) {
        return true;
      }
    }
    _lastError = '安全拒绝: 路径不在允许的命名空间内 (需含 scripts/skills/memories 等段) — ' + path;
    console.warn('[AEFS] _safeForDelete 拒绝: ' + path + ' (不在安全命名空间内)');
    return false;
  }

  // 数据目录安全校验（供 dataDir.js 的 resolveDataDir/migrateData 用，对齐删类严度）。
  // 数据目录是 skills/memories 等 ns 的父目录，本身不必含 ns 段，故不走白名单 ns 判断。
  // 三道防线：
  //   ① _checkPath（格式：拒 %/控制符/引号/..段/非绝对路径/DOS 设备名）
  //   ② 系统目录黑名单拒（与 _safeForDelete 同款：Windows/Program Files/ProgramData/Users + 盘根/盘符）
  //   ③ depth 阈值按盘符分档：系统盘(C:)depth≥2，其他盘 depth≥1。
  //      系统盘 depth1（C:\Boot/C:\Recovery/C:\$Recycle.Bin 等）黑名单列不全，强制 depth2 兜底；
  //      非系统盘 depth1（D:\AE_Data）是用户常见数据目录写法，放行。
  //      UNC 数据根（登记后）depth≥3：\\server\share 是共享根（等价盘根）拒，
  // \\server\share\Data 起才可用。
  function _isSystemOrRootDir(path) {
    var fwd = _toFwd(path).toLowerCase().replace(/\/+/g, '/');
    var stripped = fwd.replace(/^[a-z]:\//, '');
    // 段级归一化：剥每段尾随的 . 与空格（Windows 文件系统剥尾语义），
    // 防 "C:\Windows \x" / "C:\Windows.\x" / "C:\Program Files.\y" 绕过系统目录黑名单；
    // 整段剥空（纯点/空格段）过滤。段中含 ".." 子串不受影响（仅剥尾部）。
    var segs = stripped.split('/').map(function (s) { return s.replace(/[. ]+$/, ''); })
      .filter(function (s) { return !!s; });
    var depth = segs.length;
    var i;
    // 8.3 短名段（progra~1 / window~1 形态）直接视为不安全：解析后可能指向系统目录，
    // 而合法数据目录（resolveDataDir 输出的真实路径）不会含 8.3 短名段
    for (i = 0; i < segs.length; i++) {
      if (/^[a-z0-9]{1,6}~[0-9]{1,2}$/.test(segs[i])) return true;
    }
    // 对齐 C++ 宿主侧（data.cpp/effectState.cpp）：任意位置含 windows.old /
    // system volume information 段也拒（正斜杠/尾点/尾空格形态经上方归一化后命中）
    for (i = 0; i < segs.length; i++) {
      if (segs[i] === 'windows.old' || segs[i] === 'system volume information') return true;
    }
    // 与 _safeForDelete 系统目录黑名单对齐：Users 用 depth<=2（只挡 C:\Users 和 C:\Users\<profile>，
    // 不挡 C:\Users\<profile>\Documents\AE_Data 这类用户文档深处目录）。
    if (depth === 0
        || /^[a-z]:$/.test(fwd)
        || segs[0] === 'windows'
        || segs[0] === 'program files'
        || segs[0] === 'program files (x86)'
        || segs[0] === 'programdata'
        || segs[0] === 'users' && depth <= 2) {
      return true;
    }
    return false;
  }
  // 敏感路径判定（面板侧权威实现，skill-manager llmTools 委托本实现）：
  // 浏览器登录态/cookie/SSH 私钥/云凭据/DPAPI、.env/.pem/.key/.pfx 等文件。
  // 写路径必须拒绝，否则 Bridge 拒后 _writeFileFallback 会经 cep.fs 本地写回，绕过防护。
  // 吸收 skill-manager llmTools 旧本地副本的独有条目（.config 段、
  // credentials/cookies.db 文件名、.pfx 后缀），消除四份手抄副本漂移根源。
  var _SENSITIVE_DIR_SEGMENTS = ['.ssh', '.aws', '.azure', '.gcloud', '.gnupg', '.kube', '.docker', '.config'];
  var _SENSITIVE_FILE_NAMES = ['login data', 'cookies', 'local state', 'web data',
    'key4.db', 'logins.json', 'signons.sqlite', 'login.keychain-db',
    '.netrc', '.npmrc', '.pypirc', '.git-credentials',
    'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.pgpass',
    'credentials', 'cookies.db'];
  // Win32 8.3 短名键（与 aeTools.jsx _shortNameKey 同构）——系统卷默认
  // 开启短名生成，黑名单长名文件的确定性短别名（实测：Login Data→LOGIND~1、
  // logins.json→LOGINS~1.JSO、.env→ENV~1、.git-credentials→GIT-CR~1 等）与精确
  // 全等/后缀匹配全部失配。生成规则（实测归纳）：name/ext 以「位置>0 的最后一个点」
  // 分界，两部分各去点与空格后取 name 前 6 / ext 前 3 字符，前导点文件（.env）
  // 整体为 name。DPAPI 组合段 microsoft/credentials（9/11 字符）的短名
  // MICROS~1/CREDEN~1 同理由该键比对覆盖。
  function _shortNameKey(name) {
    var dot = name.lastIndexOf('.');
    var nm = dot > 0 ? name.substring(0, dot) : name;
    var ext = dot > 0 ? name.substring(dot + 1) : '';
    var n = nm.replace(/[ .]/g, '').substring(0, 6);
    if (!n) return '';
    // 仅「有短名形态」的条目参与比对：前导点文件（dot===0）/含空格/去点空格后超
    // 8 字符——≤8 字符的合法名（cookies/key4.db）无短名别名，生成键会把 cookie~1
    // 误判为 cookies 的短名（实测 cookies 短名就是自身）
    var plain = name.replace(/[ .]/g, '');
    if (dot !== 0 && name.indexOf(' ') < 0 && plain.length <= 8) return '';
    return n + '|' + (ext ? ext.replace(/[ .]/g, '').substring(0, 3) : '');
  }
  function _isSensitivePath(p) {
    if (!p || typeof p !== 'string') return false;
    var norm = p.replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/');
    var segs = norm.split('/').filter(function (s) { return s.length > 0; });
    var i, j;
    // 每段剥尾随点/空格再比对（对齐 aeTools.jsx ——
    // 只同步了 ADS 半族，全段尾点剥段缺失）：Win32 路径规范化会静默剥掉段尾的点与
    // 空格（"C:/x/.ssh." 实际打开 "C:/x/.ssh"），".ssh."/"id_rsa."/"microsoft./
    // credentials" 形态精确全等失配绕过；该段无冒号时 ADS 循环不触碰它
    for (i = 0; i < segs.length; i++) {
      segs[i] = segs[i].replace(/[. ]+$/, '');
    }
    // （同步 aeTools.jsx）：每段剥 NTFS 备用数据流（ADS）后缀——Win32 下
    // "id_rsa::$DATA" 打开的是 id_rsa 本体，段精确全等与 .pem/.key 后缀匹配均失配；
    // 剥首个冒号起至段尾再比对（盘符段单字母+冒号不剥），剥后补剥尾随点/空格
    for (i = 0; i < segs.length; i++) {
      if (segs[i].length === 2 && segs[i].charAt(1) === ':') continue;  // 盘符段保护
      var adsAt = segs[i].indexOf(':');
      if (adsAt >= 0) segs[i] = segs[i].substring(0, adsAt).replace(/[. ]+$/, '');
    }
    // 段级 8.3 短名键（name~N[.ext] 形态提取，与 _shortNameKey 同构；
    // name/ext 字符类含连字符——短名部分可含 -（实测 GIT-CR~1））
    var segKeys = [];
    for (i = 0; i < segs.length; i++) {
      var mk = /^([a-z0-9_-]{1,6})~[0-9]{1,2}(?:\.([a-z0-9_-]{1,3}))?$/.exec(segs[i]);
      segKeys[i] = mk ? (mk[1] + '|' + (mk[2] || '')) : '';
    }
    // ① 目录段黑名单（任一路径段精确命中；短名键同比对）
    for (i = 0; i < segs.length; i++) {
      for (j = 0; j < _SENSITIVE_DIR_SEGMENTS.length; j++) {
        if (segs[i] === _SENSITIVE_DIR_SEGMENTS[j]) return true;
        if (segKeys[i] && _shortNameKey(_SENSITIVE_DIR_SEGMENTS[j]) === segKeys[i]) return true;
      }
    }
    // ② DPAPI 组合段：路径含连续段 microsoft/credentials 或 microsoft/protect
    // （短名键同比对；protect 为 7 字符合法名无短名形态，原样比对已足够）
    var msKey = _shortNameKey('microsoft');
    var crKey = _shortNameKey('credentials');
    for (i = 0; i + 1 < segs.length; i++) {
      var msHere = segs[i] === 'microsoft' || (segKeys[i] !== '' && segKeys[i] === msKey);
      var credNext = segs[i + 1] === 'credentials' || (segKeys[i + 1] !== '' && segKeys[i + 1] === crKey);
      if (msHere && (credNext || segs[i + 1] === 'protect')) return true;
    }
    var base = segs.length ? segs[segs.length - 1] : '';
    if (!base) return false;
    var baseKey = segKeys.length ? segKeys[segKeys.length - 1] : '';
    // ③ 文件名黑名单（basename 精确等于；短名键同比对）
    for (i = 0; i < _SENSITIVE_FILE_NAMES.length; i++) {
      if (base === _SENSITIVE_FILE_NAMES[i]) return true;
      if (baseKey && _shortNameKey(_SENSITIVE_FILE_NAMES[i]) === baseKey) return true;
    }
    // ④ 文件名模式：.env / .env.xxx / .envrc；以 .pem / .key / .pfx 结尾
    // （用 ".env." 前缀而非 ".env" 开头，避免误伤 .environment.md 这类合法文件，与 aeTools.jsx 侧口径一致）
    // 短名形态：ENV~1（键 "env|"）/ ENV~1.LOC（键 "env|loc"）——键以 "env|" 开头即命中；
    // .envrc 短名 ENVRC~1 键 "envrc|" 单列。.environment.md 短名键 "enviro|md" 不受影响。
    // .pem/.key/.pfx 后缀不受短名影响（短名扩展恰好保留 3 字符，此后缀规则天然覆盖）。
    if (base === '.env' || base.indexOf('.env.') === 0 || base === '.envrc') return true;
    if (baseKey && (baseKey.indexOf('env|') === 0 || baseKey === 'envrc|')) return true;
    if (/\.(pem|key|pfx)$/.test(base)) return true;
    return false;
  }
  function isDataDirSafe(path) {
    if (!_checkPath(path)) return false;
    if (_isSystemOrRootDir(path)) return false;
    // 系统盘(C:)depth≥2（挡 C:\Boot 等漏列系统目录），其他盘 depth≥1（D:\AE_Data 可用）
    var fwd = _toFwd(path).toLowerCase();
    var drive = fwd.charAt(0);
    var minDepth = (drive === 'c') ? 2 : 1;
    // UNC：\\server\share 是共享根（等价盘根），须至少
    // server/share/dir 三段（\\server\share\Data）；数据根经 dataDir.js 登记后
    // _checkPath 才放行，未登记 UNC 在第①步已被拒（fail-closed）。
    if (_normUncPath(path)) minDepth = 3;
    if (!_depthOk(path, minDepth)) return false;
    return true;
  }

  /**
 * 数据根安全性判定 + **失败原因**（供 UI 如实归因）。
   * 病灶：面板对 `isDataDirSafe` 为假一律说「位于系统目录或盘符根目录」，而真实原因可能是
   * 相对路径 / 含 `%`、引号、控制字符 / `.`/`..` 段 / DOS 设备名 / UNC 深度不足。
   * **判定仍以 isDataDirSafe 为准**（本函数只负责把失败翻译成一句可展示的原因，调用方
   * 只在 isDataDirSafe 已经为假时才用它；返回 '' = 归因不出来，调用方用兜底文案）。
   * @returns {string} 可直接展示给用户的一句原因（空串 = 未能归因/通过）
   */
  function explainDataDirSafety(path) {
    if (!path || typeof path !== 'string') return '路径为空';
    if (path.indexOf('%') !== -1) return '路径含「%」';
    for (var i = 0; i < path.length; i++) {
      var c = path.charCodeAt(i);
      if (c <= 0x1F || c === 0x7F) return '路径含控制字符';
      if (c === 0x22 || c === 0x27) return '路径含引号（Windows 账户名带引号时默认数据目录就会命中；请把数据目录改到不含引号的独立路径）';
    }
    if (/(^|[\\\/\:])\.\.([\\\/\:]|$)/.test(path) || /(^|[\\\/\:])\.([\\\/\:]|$)/.test(path)) return '路径含 . 或 .. 段';
    var cleaned = path.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (!/^[A-Za-z]:\//.test(cleaned) && !/^file:\/+/i.test(cleaned) && !_normUncPath(path)) return '必须是绝对路径（如 D:\\AE_Data）';
    var segs = cleaned.replace(/\/+$/, '').split('/');
    for (var j = 0; j < segs.length; j++) {
      var upper = segs[j].replace(/\..*$/, '').toUpperCase();
      if (upper === 'NUL' || upper === 'CON' || upper === 'CONIN$' || upper === 'CONOUT$' ||
          upper === 'PRN' || upper === 'AUX' || /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) {
        return '路径含 DOS 设备名（' + segs[j] + '）';
      }
    }
    if (_isSystemOrRootDir(path)) return '位于系统目录或盘符根目录';
    if (_normUncPath(path) && !_isUnderAllowedUncRoot(path)) return '网络共享路径未登记为数据根（请在「设置」里选它，或先把共享映射为盘符）';
    var fwd = _toFwd(path).toLowerCase();
    var minDepth = (fwd.charAt(0) === 'c') ? 2 : 1;
    if (_normUncPath(path)) minDepth = 3;
    if (!_depthOk(path, minDepth)) {
      return _normUncPath(path)
        ? '网络共享路径太浅（至少 \\\\server\\share\\目录）'
        : '目录层级太浅（系统盘至少两级，其它盘至少一级）';
    }
    return '';
  }

  // 最近一次失败原因。成功操作不自动清空，调用方在 false/null 后读取。
  var _lastError = '';

  // `cep.fs.mkdir` 在 CEP 10 实测缺失（见文件头注），_mkdirFallback 的「切 ExtendScript」
  // 是**既定正常回退**而非故障。每次调用都 console.warn 会在周期路径上刷屏（真机日志实证：
  // diagLog 每 3 秒一次 mkdir → 1130 条同一告警 / 98 分钟），把真故障淹掉，故只在会话内报一次。
  var _warnedCepMkdirMissing = false;

  // 最近一次文档解析（docx/xlsx/pdf 等，走 Bridge.parseDoc）失败原因。
  // readFile 对二进制文档解析失败返 null，调用方用 getLastDocumentParseError() 拿具体原因
  //（word ok、pdf 失败这类跨库问题，靠它才能把真实错误透传给 LLM 定位）。
  var _lastDocumentParseError = '';

  // Bridge 可用性缓存（只缓存 true，不缓存 false——bridge 可能延迟启动）
  // true 缓存加 TTL 复核——单向缓存（一旦 true 永不复核）时，bridge 中途
  // 死亡后 main.js heartbeat 已 Bridge.setAvailable(false)，这里却仍持 stale true 走同步
  // Bridge 通道，readFileSync/existsSync/listFilesSync 等被静默折叠成 null/false/[]
  //（谎报「文件不存在/目录为空」）。TTL 到期后下次调用经 Bridge.isAvailable() 重新探测
  //（读 heartbeat 维护的实时缓存，不发同步网络请求），死亡即翻转 false。
  var __bridgeOk = false;
  var __bridgeOkAt = 0;          // 缓存置 true 的时刻
  var _BRIDGE_OK_TTL_MS = 5000;  // true 缓存有效期，到期后下次调用复核一次
  function _bridgeOk() {
    var now = Date.now();
    if (__bridgeOk && now - __bridgeOkAt < _BRIDGE_OK_TTL_MS) return true;
    var ok = !!(typeof Bridge !== 'undefined' && Bridge.isAvailable && Bridge.isAvailable());
    if (ok && !__bridgeOk) console.log('[AEFS] Bridge 可用，IO 走 Node.js 通道');
    __bridgeOk = ok;
    if (ok) __bridgeOkAt = now;
    return ok;
  }

  // 同步桥门禁。同步 XHR 无 timeout——桥「TCP 可连但不响应」时同步调用会把
  // 面板主线程永久冻结（心跳定时器/断线 overlay 全部失去执行机会）。同步族只允许在
  // Bridge.isSyncSafe()（桥最近被异步探活确认有响应，见 bridge.js）为 true 时走 Bridge；
  // false 一律下落 cep.fs 本地通道。旧版 Bridge/mock 无 isSyncSafe 时按可用处理（行为
  // 兼容）；门禁本身抛错按不安全处理（宁走本地慢一点，不冒冻结风险）。
  function _bridgeOkSync() {
    if (!_bridgeOk()) return false;
    try {
      if (typeof Bridge !== 'undefined' && typeof Bridge.isSyncSafe === 'function') {
        return !!Bridge.isSyncSafe();
      }
    } catch (_) { return false; }
    return true;
  }

  // Bridge 异步通道 4xx「真拒绝」二分——优先按 promise.__callSeq
  // 消费本次调用的拒绝记录（基础设施），并发同 method 调用不再交叉污染
  // （旧单变量镜像会读到他人记录：A 的 5xx 通道失败读走 B 的 4xx → 误判真拒绝放弃
  // 回退，或入口复位清掉记录 → 误判通道失败走回退）。promise 无 __callSeq
  // （旧测试 mock）退回镜像二分。返回拒绝记录或 null（供 _lastError 直接取
  // status，不再二次读镜像）。拒绝 = bridge 明确拒绝（403 symlink 逃逸/敏感路径/
  // 命名空间、400 非法路径、413 超限），调用方不得回退 cep.fs/ExtendScript（回退
  // 会绕过 bridge 防护本地直写）；null = 通道失败（网络异常/5xx），可走回退。
  function _bridgeAsyncRejection(method, p) {
    if (typeof Bridge === 'undefined') return null;
    var rec = null;
    if (p && typeof p.__callSeq === 'number' && p.__callSeq &&
        typeof Bridge.consumeAsyncRejection === 'function') {
      rec = Bridge.consumeAsyncRejection(p.__callSeq);
    } else if (typeof Bridge.getLastAsyncRejection === 'function') {
      rec = Bridge.getLastAsyncRejection();
    }
    if (!rec || rec.method !== method || !rec.status) return null;
    // 审计：bodyLimit（413 / readBody 超限 400）对写面是「内容未落盘」的
    // 传输层状态而非业务拒绝——按通道失败处理允许本地回退（不丢数据）；读面
    // 413 仍是硬拒绝（本地整读会冻结主线程直至 OOM），保持记录返回。
    if (rec.bodyLimit && (method === 'write' || method === 'write-base64' || method === 'write-llm')) return null;
    return rec;
  }

  // Bridge 同步通道 401（token 轮换窗口）判定。bridge 侧
  // _call 已在收到 401 时触发 token 刷新（单飞）并单独记录；同步通道无法在调用内
  // 等待异步刷新（刷新经 evalScript，天生异步），故本次调用**如实硬失败**、不回退
  // cep.fs/ExtendScript——本地回退的写会绕过 bridge 的 realpath/symlink 防护（读面
  // 同口径：本地直读同样绕过防护）。刷新到位后下一次调用自愈。
  // 返回 401 记录或 null（旧 Bridge mock 无该方法时返回 null，保持旧行为）。
  function _bridgeSyncUnauthorized() {
    if (typeof Bridge === 'undefined' || typeof Bridge.getLastSyncUnauthorized !== 'function') return null;
    var u = Bridge.getLastSyncUnauthorized();
    return (u && u.status === 401) ? u : null;
  }

  // ====== 同步 IO（Bridge → cep.fs 同步回退，不经过 ExtendScript） ======

  function readFileSync(path, opts) {
    if (!_checkPath(path)) return null;
    // opts.quietNotFound —— 调用方**明知该文件可能不存在**（周期性探测
    // 可选标记/配置）时不再把「文件不存在」记 WARN。真机实测：多实例标记每 20 秒一条
    // 「readFileSync 文件不存在」，2.5 小时 124 条，与桥离线告警一起吃掉日志轮转额度。
    // 语义不变：返回值仍恒 null；_lastError 仍如实设置（调用方照旧可读）。
    var _quietNotFound = !!(opts && opts.quietNotFound);
    // 敏感路径入口即拒（对齐 readFile 主入口）：Bridge 可用时由 bridge 侧 read 路由
    // 拦截，但 Bridge 不可用时 cep.fs 直读无任何防护——读取面须与异步版对称
    if (_isSensitivePath(path)) { _lastError = '安全拒绝: 敏感路径 — ' + path; console.warn('[AEFS] ' + _lastError); return null; }
    var fp = _toWin(path);
    var bridgeAvailable = _bridgeOkSync();
    if (bridgeAvailable) {
      var result = Bridge.readFile(fp);
      if (result !== null) return result;
      // Bridge 可用但返回 null：413 超大/403 symlink 逃逸等真拒绝也被折叠成 null——
      // 补记 _lastError（同步面），且 4xx 真拒绝明确失败不回退 cep.fs
      //（否则绕过 bridge 防护本地直读）
      var rRej = (typeof Bridge.getLastSyncRejection === 'function') ? Bridge.getLastSyncRejection() : null;
      if (rRej && rRej.status) {
        _lastError = 'readFileSync Bridge 拒绝 (HTTP ' + rRej.status + '): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return null;
      }
      // 401（token 轮换窗口）不回退 cep.fs（本地直读绕过 bridge 防护）
      var rAuth = _bridgeSyncUnauthorized();
      if (rAuth) {
        _lastError = 'readFileSync Bridge 鉴权失败 (HTTP 401，token 轮换窗口): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return null;
      }
      // 通道失败（bridge 中途死亡/网络异常，非 4xx 真拒绝）→ 下落 cep.fs 回退
      //（对齐 writeFileSync 既有回退写法；直接 return null 会静默谎报「读不到」）
    }
    var canCepRead = _canRead();
    var cepErr = null;          // cep.fs 应答的 err（非 0）——诊断用
    var cepNotFound = false;    // cep.fs 权威判定「真没有」（NOT_FOUND，而非读故障）
    if (canCepRead) {
      try {
        var r = window.cep.fs.readFile(fp, _getEncoding());
        if (r && r.err === 0 && typeof r.data === 'string') return r.data;
        // err=NOT_FOUND → 文件真不存在；其余 err（不可读等）是通道故障，不得反污成「不存在」
        if (r && r.err !== undefined && r.err !== 0) {
          cepErr = r.err;
          if (r.err === _cepNotFoundCode()) cepNotFound = true;
        }
      } catch (_) {}
    }
    // 「文件不存在」vs「通道故障」分治（对齐 readFile Result 版：NOT_FOUND 的最终判定权
    // 归 cep.fs——丢弃 err 会让两种情形一律记「全部通道失败」）。缺失文件是
    // 探测的预期结果，首启 MEMORY.md / hotbox config.json 每条必经，报成通道故障等于把
    // 正常态当故障刷屏。返回值语义不变（恒 null，薄适配层策略）。
    if (cepNotFound) {
      _lastError = 'readFileSync 文件不存在: ' + path;
      if (!_quietNotFound) console.warn('[AEFS] ' + _lastError);
      return null;
    }
    _lastError = 'readFileSync 全部通道失败: ' + path + ' (Bridge=' + bridgeAvailable + ', cep.fs=' + canCepRead + (cepErr === null ? '' : ', err=' + cepErr) + ')';
    console.warn('[AEFS] ' + _lastError);
    return null;
  }

  function writeFileSync(path, content) {
    if (!_checkPath(path)) return false;
    if (!_safeForDelete(path)) return false;
    if (_isSensitivePath(path)) { _lastError = '安全拒绝: 敏感路径 — ' + path; console.warn('[AEFS] ' + _lastError); return false; }
    if (content === null || content === undefined) return false;
    var fp = _toWin(path);
    var bridgeAvailable = _bridgeOkSync();
    if (bridgeAvailable) {
      if (Bridge.writeFile(fp, content)) return true;
      // Bridge 4xx「真拒绝」（403 symlink 逃逸/敏感路径/命名空间）：明确失败，
      // 不回退 cep.fs——否则绕过 bridge 的 symlink 解析防护本地直写（同步面）。
      // 网络异常/5xx（getLastSyncRejection 为 null）仍照旧回退 cep.fs；
      // 审计：bodyLimit（413/readBody 超限 400）内容未落盘，非业务真拒绝 → 回退
      var wRej = (typeof Bridge.getLastSyncRejection === 'function') ? Bridge.getLastSyncRejection() : null;
      if (wRej && wRej.status && !wRej.bodyLimit) {
        _lastError = 'writeFileSync Bridge 拒绝 (HTTP ' + wRej.status + '): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
      // 401（token 轮换窗口）不回退 cep.fs（本地直写绕过 bridge 防护）
      var wAuth = _bridgeSyncUnauthorized();
      if (wAuth) {
        _lastError = 'writeFileSync Bridge 鉴权失败 (HTTP 401，token 轮换窗口): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
    }
    var canCepWrite = _canWrite();
    if (canCepWrite) {
      try {
        if (_canMkdir()) {
          var mr = window.cep.fs.mkdir(_parentDir(fp));
          if (mr && mr.err !== undefined && mr.err !== 0) {
            _lastError = 'writeFileSync mkdir 父目录失败: ' + _parentDir(fp);
            console.warn('[AEFS] ' + _lastError);
            return false;
          }
        }
        if (_writeCepFsAtomic(fp, content, _getEncoding())) return true;
      } catch (_) {}
    }
    _lastError = 'writeFileSync 全部通道失败: ' + path + ' (Bridge=' + bridgeAvailable + ', cep.fs=' + canCepWrite + ')';
    console.warn('[AEFS] ' + _lastError);
    return false;
  }

  /**
   * 同步写二进制文件（base64 编码）。① Bridge → ② cep.fs Base64
   * 仅同步通道（Bridge → cep.fs），不经过 ExtendScript。异步版 writeFileBase64 有 ExtendScript 回退。
   */
  function writeFileBase64Sync(path, base64) {
    if (!_checkPath(path)) return false;
    if (!_safeForDelete(path)) return false;
    // 敏感路径入口即拒（对齐 writeFileSync）：Bridge 拒后 cep.fs Base64 分支会本地
    // 直写成功——与异步版 _writeFileBase64Fallback 修掉的同款绕过模式
    if (_isSensitivePath(path)) { _lastError = '安全拒绝: 敏感路径 — ' + path; console.warn('[AEFS] ' + _lastError); return false; }
    if (!base64 || typeof base64 !== 'string') return false;
    if (!/^[A-Za-z0-9+\/]*={0,2}$/.test(base64)) { _lastError = 'writeFileBase64Sync 非法的 base64 字符串'; console.warn('[AEFS] ' + _lastError); return false; }
    var fp = _toWin(path);
    var bridgeAvailable = _bridgeOkSync();
    // ① Bridge
    if (bridgeAvailable) {
      // 审计：与 writeFileSync/copyFileSync 同步面对齐——4xx 真拒绝（403 symlink
      // 逃逸等）直接 false 不回退 cep.fs Base64 分支（本地直写绕过 bridge 防护）；
      // bodyLimit（内容未落盘）例外，允许回退
      if (typeof Bridge.clearSyncRejection === 'function') Bridge.clearSyncRejection();
      if (Bridge.writeFileBase64(fp, base64)) return true;
      var b64Rej = (typeof Bridge.getLastSyncRejection === 'function') ? Bridge.getLastSyncRejection() : null;
      if (b64Rej && b64Rej.method === 'write-base64' && b64Rej.status && !b64Rej.bodyLimit) {
        _lastError = 'writeFileBase64Sync Bridge 拒绝 (HTTP ' + b64Rej.status + '): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
      // 401（token 轮换窗口）不回退 cep.fs Base64 分支（本地直写绕过 bridge 防护）
      var b64Auth = _bridgeSyncUnauthorized();
      if (b64Auth) {
        _lastError = 'writeFileBase64Sync Bridge 鉴权失败 (HTTP 401，token 轮换窗口): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
    }
    // ② cep.fs Base64
    var canCepWrite = _canWrite();
    if (canCepWrite) {
      try {
        if (_canMkdir()) {
          var mr = window.cep.fs.mkdir(_parentDir(fp));
          if (mr && mr.err !== undefined && mr.err !== 0) {
            _lastError = 'writeFileBase64Sync mkdir 父目录失败: ' + _parentDir(fp);
            console.warn('[AEFS] ' + _lastError);
            return false;
          }
        }
        var cepEnc = (typeof window !== 'undefined' && window.cep && window.cep.encoding) || null;
        if (cepEnc && cepEnc.Base64) {
          if (_writeCepFsAtomic(fp, base64, cepEnc.Base64)) return true;
        } else {
          // 不支持 Base64：atob 解码为 binary string 写入
          var binaryStr = atob(base64);
          if (_writeCepFsAtomic(fp, binaryStr)) return true;
        }
      } catch (_) {}
    }
    _lastError = 'writeFileBase64Sync 全部通道失败: ' + path + ' (Bridge=' + bridgeAvailable + ', cep.fs=' + canCepWrite + ')';
    console.warn('[AEFS] ' + _lastError);
    return false;
  }

  /**
   * 同步读图片文件转 base64。① Bridge（唯一通道，含 sharp 缩放/等待稳定等图片专用逻辑）
   * 无 cep.fs / ExtendScript 回退——图片读取依赖 Bridge Server 专用端点。
   * @param {string} path — 图片绝对路径
   * @returns {{success: boolean, base64: string, size: number, mime: string}|null}
   */
  function readImageBase64Sync(path) {
    if (!_checkPath(path)) return null;
    var fp = _toWin(path);
    if (!_bridgeOkSync()) {
      _lastError = 'readImageBase64Sync Bridge 不可用: ' + path;
      console.warn('[AEFS] ' + _lastError);
      return null;
    }
    var result = Bridge.readImageBase64(fp);
    if (result && result.success) return result;
    _lastError = 'readImageBase64Sync 读取失败: ' + path + ' (result=' + JSON.stringify(result || {}).substring(0, 200) + ')';
    console.warn('[AEFS] ' + _lastError);
    return null;
  }

  function mkdirSync(path) {
    if (!_checkPath(path)) return false;
    var fp = _toWin(path);
    var bridgeAvailable = _bridgeOkSync();
    if (bridgeAvailable) {
      // 审计：与异步 mkdir 对齐——bridge 4xx 真拒绝（symlink 逃逸
      // 403 等）直接 false 不回退（含跳过幂等 exists 短路，防在逃逸位置误判已建）
      if (typeof Bridge.clearSyncRejection === 'function') Bridge.clearSyncRejection();
      if (Bridge.mkdir(fp)) return true;
      var mRej = (typeof Bridge.getLastSyncRejection === 'function') ? Bridge.getLastSyncRejection() : null;
      if (mRej && mRej.method === 'mkdir' && mRej.status) {
        _lastError = 'mkdirSync Bridge 拒绝 (HTTP ' + mRej.status + '): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
      // 401（token 轮换窗口）不回退 cep.fs/幂等短路（本地直建绕过 bridge 防护）
      var mAuth = _bridgeSyncUnauthorized();
      if (mAuth) {
        _lastError = 'mkdirSync Bridge 鉴权失败 (HTTP 401，token 轮换窗口): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
    }
    var canCepMkdir = _canMkdir();
    if (canCepMkdir) {
      try {
        // cep.fs.mkdir 返回 {err}——不查 err 时，失败（权限/盘满/路径非法）
        // 也 return true 假成功，上层把「未建目录」当「已建」继续写文件。对齐
        // _mkdirFallback 的判定口径（返回值为空或 err 非 0 均失败，下落幂等复核链）
        var mr = window.cep.fs.mkdir(fp);
        if (mr && (mr.err === undefined || mr.err === 0)) return true;
        console.warn('[AEFS] mkdirSync cep.fs.mkdir 失败: ' + path + ' err=' + (mr ? mr.err : 'void'));
      } catch (_) {}
    }
    // 同步通道（Bridge/cep.fs）均不可用时：幂等短路——目录已存在直接算成功
    // （如 hotbox 主题每次启动都写，上一轮 ES 自愈建过目录后这里不再误报失败）
    if (existsSync(fp)) return true;
    // 确实不存在 → 发异步 ExtendScript 创建（fire-and-forget：evalScript 无法同步等待，
    // 本次调用仍如实返回 false，目录建好后下一轮调用/下次启动自愈）
    _mkdirES(path);
    _lastError = 'mkdirSync 全部通道失败: ' + path + ' (Bridge=' + bridgeAvailable + ', cep.fs=' + canCepMkdir + ')';
    console.warn('[AEFS] ' + _lastError);
    return false;
  }

  function deleteFileSync(path) {
    if (!_checkPath(path)) return false;
    if (!_safeForDelete(path)) return false;
    if (!_depthOk(path, 2)) { _lastError = '安全拒绝: 路径深度不足 — ' + path; console.warn('[AEFS] deleteFileSync ' + _lastError); return false; }
    var fp = _toWin(path);
    var bridgeAvailable = _bridgeOkSync();
    if (bridgeAvailable) {
      // 审计：与异步 deleteFile 对齐——调用前清拒绝记录保证新鲜性，
      // 失败后读 method 匹配的 4xx：bridge 明确拒绝（symlink/junction 逃逸 403 等）时
      // 直接 false 不回退 cep.fs（否则本地直删绕过白名单）
      if (typeof Bridge.clearSyncRejection === 'function') Bridge.clearSyncRejection();
      if (Bridge.deleteFile(fp)) return true;
      var dRej = (typeof Bridge.getLastSyncRejection === 'function') ? Bridge.getLastSyncRejection() : null;
      if (dRej && dRej.method === 'delete' && dRej.status) {
        _lastError = 'deleteFileSync Bridge 拒绝 (HTTP ' + dRej.status + '): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
      // 401（token 轮换窗口）不回退 cep.fs（本地直删绕过 bridge 防护）
      var dAuth = _bridgeSyncUnauthorized();
      if (dAuth) {
        _lastError = 'deleteFileSync Bridge 鉴权失败 (HTTP 401，token 轮换窗口): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
    }
    var canCepDelete = _canDelete();
    if (canCepDelete) {
      try {
        var r = window.cep.fs.deleteFile(fp);
        if (r && (r.err === undefined || r.err === 0)) return true;
      } catch (_) {}
    }
    _lastError = 'deleteFileSync 全部通道失败: ' + path + ' (Bridge=' + bridgeAvailable + ', cep.fs=' + canCepDelete + ')';
    console.warn('[AEFS] ' + _lastError);
    return false;
  }

  function listFilesSync(dirPath) {
    if (!_checkPath(dirPath)) return [];
    // 敏感路径入口即拒（与 readFile 同口径）：Bridge 不可用时 cep.fs.readdir 直列敏感目录无防护
    if (_isSensitivePath(dirPath)) { _lastError = '安全拒绝: 敏感路径 — ' + dirPath; console.warn('[AEFS] ' + _lastError); return []; }
    var dp = _toWin(dirPath);
    var bridgeAvailable = _bridgeOkSync();
    if (bridgeAvailable) {
      var bFiles = Bridge.listFiles(dp);
      if (bFiles && bFiles.length) return bFiles;
      // [] 分不清「空目录」与「bridge 中途死亡折叠的失败值」：4xx 真拒绝不回退，
      // 通道失败下落 cep.fs 复核（直接 return [] 会让脚本树扫描被清空）
      var fRej = (typeof Bridge.getLastSyncRejection === 'function') ? Bridge.getLastSyncRejection() : null;
      if (fRej && fRej.status) {
        _lastError = 'listFilesSync Bridge 拒绝 (HTTP ' + fRej.status + '): ' + dirPath;
        console.warn('[AEFS] ' + _lastError);
        return [];
      }
      // 401（token 轮换窗口）不回退 cep.fs 复核（本地直列绕过 bridge 防护）
      var fAuth = _bridgeSyncUnauthorized();
      if (fAuth) {
        _lastError = 'listFilesSync Bridge 鉴权失败 (HTTP 401，token 轮换窗口): ' + dirPath;
        console.warn('[AEFS] ' + _lastError);
        return [];
      }
    }
    var canCepReaddir = _canReaddir();
    var dirErr = null;          // cep.fs.readdir 应答的 err（非 0）——诊断用
    var dirNotFound = false;    // cep.fs 权威判定「目录真没有」（NOT_FOUND，而非读故障）
    if (canCepReaddir) {
      try {
        var r = window.cep.fs.readdir(dp);
        if (r && r.err === 0 && Array.isArray(r.data)) return r.data;
        // 同 readFileSync：err=NOT_FOUND 是「目录真没有」的权威判定，不是通道故障。
        // 逐层递归扫描不存在/尚未建的目录（script-tree/bootstrap 必经）本属预期，
        // 报「全部通道失败」是把正常态当故障刷屏
        if (r && r.err !== undefined && r.err !== 0) {
          dirErr = r.err;
          if (r.err === _cepNotFoundCode()) dirNotFound = true;
        }
      } catch (_) {}
    }
    if (dirNotFound) {
      _lastError = 'listFilesSync 目录不存在: ' + dirPath;
      console.warn('[AEFS] ' + _lastError);
      return [];
    }
    // Bridge/cep.fs 未给出权威「不存在」判定：真通道故障（含两者都不可用）才报错
    //（调用方会回退 ExtendScript）
    _lastError = 'listFilesSync 全部通道失败: ' + dirPath + ' (Bridge=' + bridgeAvailable + ', cep.fs=' + canCepReaddir + (dirErr === null ? '' : ', err=' + dirErr) + ')';
    console.warn('[AEFS] ' + _lastError);
    return [];
  }

  function listDirsSync(dirPath) {
    if (!_checkPath(dirPath)) return [];
    // 敏感路径入口即拒（与 listFilesSync 同口径）
    if (_isSensitivePath(dirPath)) { _lastError = '安全拒绝: 敏感路径 — ' + dirPath; console.warn('[AEFS] ' + _lastError); return []; }
    var dp = _toWin(dirPath);
    if (_bridgeOkSync()) {
      var bDirs = Bridge.listDirs(dp);
      if (bDirs && bDirs.length) return bDirs;
      // [] 分不清「无子目录」与「bridge 中途死亡折叠的失败值」（对齐 listFilesSync）：
      // 4xx 真拒绝不回退，通道失败下落 cep.fs 复核
      var dRej = (typeof Bridge.getLastSyncRejection === 'function') ? Bridge.getLastSyncRejection() : null;
      if (dRej && dRej.status) {
        _lastError = 'listDirsSync Bridge 拒绝 (HTTP ' + dRej.status + '): ' + dirPath;
        console.warn('[AEFS] ' + _lastError);
        return [];
      }
      // 401（token 轮换窗口）不回退 cep.fs 复核（本地直列绕过 bridge 防护）
      var dAuth = _bridgeSyncUnauthorized();
      if (dAuth) {
        _lastError = 'listDirsSync Bridge 鉴权失败 (HTTP 401，token 轮换窗口): ' + dirPath;
        console.warn('[AEFS] ' + _lastError);
        return [];
      }
    }
    // cep.fs 回退：readdir 列条目 + stat.isDirectory() 过滤（stat 为官方原语
    // CEPEngine_extensions.js）。stat/readdir 任一不可用（CEP 环境外/方法被阉）时
    // 返回空，调用方兜底 ExtendScript——无条件返 [] 时，bridge 死亡时目录树被清空
    if (_canReaddir() && _canStat()) {
      try {
        var rd = window.cep.fs.readdir(dp);
        if (rd && rd.err === 0 && Array.isArray(rd.data)) {
          var dirs = [];
          for (var i = 0; i < rd.data.length; i++) {
            var st = window.cep.fs.stat(dp + '\\' + rd.data[i]);
            if (st && st.err === 0 && st.data && typeof st.data.isDirectory === 'function' && st.data.isDirectory()) {
              dirs.push(rd.data[i]);
            }
          }
          return dirs;
        }
      } catch (_) {}
    }
    return [];
  }

  function rmdirSync(path) {
    if (!_checkPath(path)) return false;
    if (!_safeForDelete(path)) return false;
    if (!_depthOk(path, 2)) return false;
    if (_bridgeOkSync()) {
      if (Bridge.rmdir(_toWin(path))) return true;
      // 4xx 真拒绝不回退（防 bridge 拒绝的删除被 cep.fs 本地执行绕过）；
      // 通道失败（bridge 中途死亡/网络异常）下落 cep.fs 能力探测回退
      var rmRej = (typeof Bridge.getLastSyncRejection === 'function') ? Bridge.getLastSyncRejection() : null;
      if (rmRej && rmRej.status) {
        _lastError = 'rmdirSync Bridge 拒绝 (HTTP ' + rmRej.status + '): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
      // 401（token 轮换窗口）不回退 cep.fs（本地直删/降级绕过 bridge 防护）
      var rmAuth = _bridgeSyncUnauthorized();
      if (rmAuth) {
        _lastError = 'rmdirSync Bridge 鉴权失败 (HTTP 401，token 轮换窗口): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
    }
    // cep.fs 官方 fs API 无目录删除原语（CEPEngine_extensions.js：deleteFile 仅删
    // 文件、无 rmdir）——探测到 rmdir 能力才用（当前 CEP 10 无 → 优雅降级 false）
    if (_canRmdir()) {
      try {
        var rr = window.cep.fs.rmdir(_toWin(path));
        if (rr && rr.err === 0) return true;
      } catch (_) {}
    }
    _lastError = 'rmdirSync Bridge 不可用且 cep.fs 无 rmdir 能力: ' + path;
    console.warn('[AEFS] ' + _lastError);
    return false;
  }

  function existsSync(path) {
    if (!_checkPath(path)) return false;
    // 敏感路径入口即拒（存在性 oracle：Bridge 不可用时 cep.fs readFile/readdir 会把敏感文件探成 true）
    if (_isSensitivePath(path)) { _lastError = '安全拒绝: 敏感路径 — ' + path; console.warn('[AEFS] ' + _lastError); return false; }
    var fp = _toWin(path);
    // 同步族统一过 _bridgeOkSync 门禁（半死桥不发起无超时的同步 XHR）——
    // 原为 _bridgeOk()，桥「TCP 可连但不响应」时会冻结主线程（existsSync 是
    // 建前查重/列表刷新等高频路径，命中窗口概率最高的一支）。
    var bridgeAvailable = _bridgeOkSync();
    if (bridgeAvailable) {
      if (Bridge.exists(fp)) return true;
      // false 分不清「真不存在」与「bridge 中途死亡折叠的失败值」：4xx 真拒绝不回退
      //（防 cep.fs 把 symlink 逃逸路径探成 true），通道失败则下落 cep.fs 复核
      var eRej = (typeof Bridge.getLastSyncRejection === 'function') ? Bridge.getLastSyncRejection() : null;
      if (eRej && eRej.status) {
        _lastError = 'existsSync Bridge 拒绝 (HTTP ' + eRej.status + '): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
      // 401（token 轮换窗口）不回退 cep.fs 探测（本地探测绕过 bridge 防护）
      var eAuth = _bridgeSyncUnauthorized();
      if (eAuth) {
        _lastError = 'existsSync Bridge 鉴权失败 (HTTP 401，token 轮换窗口): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
    }
    // Bridge 不可用/通道失败，回退：readFile 查文件 + readdir 查目录
    var canCepRead = _canRead();
    if (canCepRead) {
      try {
        var r = window.cep.fs.readFile(fp, _getEncoding());
        if (r && r.err === 0) return true;
      } catch (_) {}
    }
    var canCepReaddir = _canReaddir();
    if (canCepReaddir) {
      try {
        var rd = window.cep.fs.readdir(fp);
        if (rd && rd.err === 0) return true;
      } catch (_) {}
    }
    // 「不存在」vs「通道故障」分治：任一通道响应过（Bridge 在线应答
    // false 且非 4xx 拒绝 / cep.fs readFile / readdir 可用），false 即确定性「不存在」
    // ——建前查重探测、renameFileSync 目标覆盖预检每条必经，误记「全部通道失败」
    // 会刷屏（memory create 三连误报实证：查重探测 2 条 + 原子写 rename 预检 1 条）。
    // 仅全部通道不可用（真故障）时告警 + _lastError 留痕；返回值语义不变（恒 false）。
    if (bridgeAvailable || canCepRead || canCepReaddir) return false;
    _lastError = 'existsSync 全部通道失败: ' + path + ' (Bridge=' + bridgeAvailable + ', cep.fs(read/readdir)=' + canCepRead + '/' + canCepReaddir + ')';
    console.warn('[AEFS] ' + _lastError);
    return false;
  }

  // 是否为普通文件（只读）。① Bridge（isFile）→ ② cep.fs.readFile（成功=文件）
  // 只过 _checkPath，不走 _safeForDelete/_depthOk。
  function isFileSync(path) {
    if (!_checkPath(path)) return false;
    var fp = _toWin(path);
    // 同 existsSync——同步族统一过门禁（原 _bridgeOk() 会在半死桥下发同步 XHR）
    if (_bridgeOkSync()) {
      if (Bridge.isFile(fp)) return true;
      // false 分不清「非文件」与「bridge 中途死亡折叠的失败值」：4xx 真拒绝不回退
      //（防 cep.fs 把 symlink 逃逸路径探成文件），通道失败下落 cep.fs 复核
      var ifRej = (typeof Bridge.getLastSyncRejection === 'function') ? Bridge.getLastSyncRejection() : null;
      if (ifRej && ifRej.status) {
        _lastError = 'isFileSync Bridge 拒绝 (HTTP ' + ifRej.status + '): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
      // 401（token 轮换窗口）不回退 cep.fs 探测（本地探测绕过 bridge 防护）
      var ifAuth = _bridgeSyncUnauthorized();
      if (ifAuth) {
        _lastError = 'isFileSync Bridge 鉴权失败 (HTTP 401，token 轮换窗口): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
    }
    // Bridge 不可用/通道失败，回退 cep.fs：readFile 成功（err===0）= 文件；失败=目录或不存在，均非文件
    if (_canRead()) {
      try {
        var r = window.cep.fs.readFile(fp, _getEncoding());
        if (r && r.err === 0) return true;
      } catch (_) {}
    }
    return false;
  }

  // ExtendScript 回退：建目录
  function _mkdirES(path) {
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = '_mkdirES ExtendScript 不可用 (CSInterface 未定义): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return resolve(false);
      }
      var sd = _toFwd(path);
      if (!sd) return resolve(false);
      var sdEsc = sd.replace(/"/g, '\\"')
        // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，路径未转义会让整条 evalScript 解析失败
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
      var timeout = setTimeout(function () {
        _lastError = '_mkdirES ExtendScript 超时 (5s): ' + path;
        console.warn('[AEFS] ' + _lastError);
        resolve(false);
      }, 5000);
      try {
        new CSInterface().evalScript(
          'var d=new Folder("' + sdEsc + '");if(!d.exists)d.create();(d.exists?"OK":"FAIL");',
          function (result) {
            clearTimeout(timeout);
            resolve(result === 'OK');
          }
        );
      } catch (_) { clearTimeout(timeout); resolve(false); }
    });
  }

  // 「按原编码写回」——桥在写前校验目标编码，非 UTF-8 文本（GBK/ANSI）
  // 一律 409 拒绝（code=TARGET_NOT_UTF8），这里据此改走 ExtendScript 通道按 GBK 写回
  //（Node 无 GBK 编码器；真机实测 ES 的 f.encoding='GBK' 能写出真 GBK 字节）。
  // 链接目标不走 ES（ES 会静默跟随链接、绕过 bridge 的 realpath 防护）→ 如实失败并提示。
  // 返回：'written' 已按原编码落盘 / 'blocked' 写不成（链接/ES 不可用/写失败）
  function _writeViaEsGbk(path, content) {
    return isLinkAsync(path).then(function (lk) {
      if (lk && lk.isLink) {
        _lastError = '目标不是 UTF-8（GBK）且是链接，拒绝经由 ExtendScript 覆盖（会绕过 realpath 防护）: ' + path;
        console.warn('[AEFS] ' + _lastError);
        return 'blocked';
      }
      return _writeFileES(path, content, 'GBK').then(function (ok) {
        if (ok) console.log('[AEFS] 已按原编码（GBK）写回: ' + path);
        else { _lastError = '按原编码（GBK）写回失败（ExtendScript 通道不可用）: ' + path; console.warn('[AEFS] ' + _lastError); }
        return ok ? 'written' : 'blocked';
      });
    }, function () { return 'blocked'; });
  }

  // ExtendScript 回退：写文件（覆盖已有或新建）
  // encoding 可指定——Node 无 GBK 编码器，而 ES 的 f.encoding='GBK'
  // 能写出真 GBK 字节（d6 d0 ce c4），「按原编码写回」只能走这条通道。
  function _writeFileES(path, content, encoding) {
    var encLit = (encoding === 'GBK' || encoding === 'gbk') ? 'GBK' : 'UTF-8';
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = '_writeFileES ExtendScript 不可用 (CSInterface 未定义): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return resolve(false);
      }
      var sd = _toFwd(path);
      if (!sd) return resolve(false);
      // 先确保父目录存在
      var parent = sd.replace(/\/[^\/]+$/, '');
      var escaped = content
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，未转义会让整个 evalScript 解析失败
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
      // 路径侧同样须转义（content 只覆盖了文件内容，Folder/File 路径串是独立字面量）
      var parentEsc = parent.replace(/"/g, '\\"')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
      var sdEsc = sd.replace(/"/g, '\\"')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
      var timeout = setTimeout(function () {
        _lastError = '_writeFileES ExtendScript 超时 (5s): ' + path;
        console.warn('[AEFS] ' + _lastError);
        resolve(false);
      }, 5000);
      try {
        new CSInterface().evalScript(
          'var d=new Folder("' + parentEsc + '");if(!d.exists)d.create();' +
          'var f=new File("' + sdEsc + '");f.encoding="' + encLit + '";f.open("w");f.write("' + escaped + '");f.close();' +
          '(f.exists?"OK":"FAIL");',
          function (result) {
            clearTimeout(timeout);
            resolve(result === 'OK');
          }
        );
      } catch (_) { clearTimeout(timeout); resolve(false); }
    });
  }

  // ExtendScript 回退：二进制文件 base64 分块写入（Bridge + cep.fs 都不可用时）
  function _writeFileBase64ES(path, base64) {
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = '_writeFileBase64ES ExtendScript 不可用 (CSInterface 未定义): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return resolve(false);
      }
      var sd = _toFwd(path);
      if (!sd) return resolve(false);
      // 安全：_toFwd 已转正斜杠，此处 \\\\ 转义是纵深防御（与 _writeFileES 对齐）
      var sdEsc = sd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，路径未转义会让整条 evalScript 解析失败
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
      var parent = sd.replace(/\/[^\/]+$/, '');

      // 先确保父目录存在
      _mkdirES(parent).then(function (dirOk) {
        if (!dirOk) return resolve(false);

        // ExtendScript 内 base64 解码器（数组 push + join，比字符串拼加快十倍）
        var decoderFn = 'var __b64d=function(b){' +
          'var m="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";' +
          'var r=[];var p=0;' +
          'var i=0,l=b.length;' +
          'while(i<l){' +
          'var c1=m.indexOf(b.charAt(i++));' +
          'var c2=m.indexOf(b.charAt(i++));' +
          'var c3=m.indexOf(b.charAt(i++));' +
          'var c4=m.indexOf(b.charAt(i++));' +
          'r[p++]=String.fromCharCode((c1<<2)|(c2>>4));' +
          'if(c3<64)r[p++]=String.fromCharCode(((c2&15)<<4)|(c3>>2));' +
          'if(c4<64)r[p++]=String.fromCharCode(((c3&3)<<6)|c4);' +
          '}' +
          'return r.join("");' +
          '};';

        var CHUNK = 256 * 1024;  // 256KB base64 / 块，避免 CSInterface 脚本过大
        var totalLen = base64.length;
        var chunkCount = Math.ceil(totalLen / CHUNK);
        var settled = false;  // 防超时/回调竞态：一旦 settle 不再发下一块

        // 分块写中途失败（超时/chunk 失败/CSInterface 异常）时 best-effort
        // 删除半截文件——首块 f.open("w") 已截断/创建目标，留下的截断文件会被调用方
        // 当「已写入」消费（三级降级链末端的假阳性），下次读取拿到半截数据无从辨别。
        // fire-and-forget：删除失败（文件被占用等）不阻塞本次 false 结论，残留由
        // 下次重写覆盖；只在 sendChunk 失败路径调用——mkdir 失败分支未动过目标文件，
        // 覆盖场景下旧好文件不能误删
        function cleanupPartial() {
          try {
            new CSInterface().evalScript(
              'var f=new File("' + sdEsc + '");(f.exists?f.remove():false);',
              function () {}
            );
          } catch (_) {}
        }

        function sendChunk(index) {
          if (settled) return;
          if (index >= chunkCount) {
            settled = true;
            return resolve(true);
          }

          var start = index * CHUNK;
          var chunk = base64.substring(start, start + CHUNK);
          var isFirst = index === 0;

          // chunk 只含 [A-Za-z0-9+/=]，拼进 ExtendScript 字符串无需转义
          var script = decoderFn +
            'var __r="";try{' +
            'var f=new File("' + sdEsc + '");' +
            'f.encoding="BINARY";' +
            (isFirst
              ? 'if(!f.open("w")){__r="ERROR: 无法创建文件";}else{var d=__b64d("' + chunk + '");f.write(d);f.close();__r="OK";}'
              : 'if(!f.open("a")){__r="ERROR: 无法打开文件追加";}else{var d=__b64d("' + chunk + '");f.write(d);f.close();__r="OK";}'
            ) +
            '}catch(__e){__r="ERROR: "+__e.message;}' +
            '__r;';

          var timeout = setTimeout(function () {
            if (settled) return;
            settled = true;
            _lastError = '_writeFileBase64ES ExtendScript 超时 (15s) chunk ' + (index + 1) + '/' + chunkCount + ': ' + path;
            console.warn('[AEFS] ' + _lastError);
            cleanupPartial();
            resolve(false);
          }, 15000);

          try {
            new CSInterface().evalScript(script, function (result) {
              clearTimeout(timeout);
              if (settled) return;  // 超时已先行 settle，丢弃迟到回调
              if (result !== 'OK') {
                settled = true;
                _lastError = '_writeFileBase64ES chunk 失败 (' + (index + 1) + '/' + chunkCount + '): ' + result;
                console.warn('[AEFS] ' + _lastError);
                cleanupPartial();
                return resolve(false);
              }
              if (index < chunkCount - 1) {
                setTimeout(function () { sendChunk(index + 1); }, 20);
              } else {
                sendChunk(index + 1);
              }
            });
          } catch (e) {
            clearTimeout(timeout);
            if (settled) return;
            settled = true;
            _lastError = '_writeFileBase64ES CSInterface 异常: ' + e.message;
            console.warn('[AEFS] ' + _lastError);
            cleanupPartial();
            resolve(false);
          }
        }

        sendChunk(0);
      });
    });
  }

  // ====== 公开接口 ======

  /**
   * 读文件。① 二进制文档（docx/xlsx/pdf 等）→ Bridge.parseDoc 解析为文本；
   *    纯文本 → Bridge（同步 XHR）→ fetch（扩展目录内）→ cep.fs
   * @param {string} path — 绝对路径或相对路径
   * @returns {Promise<string|null>} 文件内容，失败返 null
   */
  // readFile 的 Result 版（会话读失败
  // 折叠 null → 调用方当「空/新会话」→ 覆盖写丢数据）。三态：
  //   ok(text)          读得（含空文件 ok('')——与失败态无歧义）
  //   NOT_FOUND         cep.fs ERR_NOT_FOUND（通道权威判定「真没有」——
  //                     与其他 err 一同折叠 null，调用方无从区分「文件不存在」
  //                     与「通道故障」的折叠点）
  //   CHANNEL_FAILURE   全链失败：Bridge 通道失败且 fetch 失败且 cep.fs 失败/不可用
  //                     （拿不到）；parseDoc 解析失败（Bridge 侧解析通道产物不可用）
  //   REJECTED          路径校验/敏感路径入口拒（通道未触碰）/Bridge 4xx 真拒绝
  // fetch 404 不判 NOT_FOUND（URL 形态/映射问题无权威性，最终判定权归 cep.fs）
  function readFileResult(path, opts) {
    if (!_checkPath(path)) return Promise.resolve(_resultErr(RESULT_CODES.REJECTED, 'readFile 路径校验拒绝: ' + path, null));
    if (_isSensitivePath(path)) { _lastError = '安全拒绝: 敏感路径 — ' + path; console.warn('[AEFS] ' + _lastError); return Promise.resolve(_resultErr(RESULT_CODES.REJECTED, _lastError, null)); }
    // 二进制文档：走 Bridge.parseDoc 解析为结构化文本（sheet/正文）。
    // 解析类库（mammoth/SheetJS/unpdf）在 bridge(Node) 侧；AEFS 无解析能力，解析失败返错误态。
    // .doc 仍走本路由（服务端入口明确拒绝并提示转存 .docx）——若改走纯文本
    // 读取通道会把二进制当 utf8 读出乱码，明确报错对用户更清晰（错误经
    // getLastDocumentParseError() 透传给 platformTools/LLM）。
    if (/\.(docx|doc|xlsx|xls|xlsm|pdf)$/i.test(path)) {
      if (typeof Bridge === 'undefined' || typeof Bridge.parseDoc !== 'function') {
        _lastDocumentParseError = 'Bridge 不可用，无法解析文档';
        return Promise.resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastDocumentParseError, 'bridge'));
      }
      return Bridge.parseDoc(_toWin(path)).then(function (r) {
        if (r && r.ok && typeof r.text === 'string') { _lastDocumentParseError = ''; return _resultOk(r.text); }
        _lastDocumentParseError = (r && r.error) ? String(r.error) : '文档解析失败';
        return _resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastDocumentParseError, 'bridge');
      }).catch(function (e) {
        _lastDocumentParseError = (e && e.message) ? String(e.message) : '文档解析异常';
        return _resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastDocumentParseError, 'bridge');
      });
    }
    // ① Bridge 异步（不阻塞主线程）；Bridge 不可用/读不到时走 _readFileResultFallback
    if (_bridgeOk() && typeof Bridge.readFileAsync === 'function') {
      return Bridge.readFileAsync(_toWin(path), opts).then(function (br) {
        // Bridge 4xx「真拒绝」：413 超大 / 403 symlink 逃逸或敏感路径。
        // 必须在此明确失败（记 _lastError），绝不回退 cep.fs——否则超大文件被同步整读
        // 冻结主线程直至 OOM，或绕过 symlink 防护直读敏感目标
        if (br && typeof br === 'object' && br.__bridgeRejected) {
          _lastError = 'Bridge 拒绝读取 (HTTP ' + br.status + '): ' + path + (br.error ? ' — ' + br.error : '');
          console.warn('[AEFS] ' + _lastError);
          return _resultErr(RESULT_CODES.REJECTED, _lastError, 'bridge');
        }
        // 范围读响应：`data` 是**按码元**切出的本页，
        // 另带 totalChars/charOffset。元数据留在结果对象上（`data` 仍是字符串 ⇒ 既有消费方不受影响）。
        if (br && typeof br === 'object' && br.__range === true) {
          var _rr = _resultOk(br.data);
          _rr.totalChars = br.totalChars;
          _rr.charOffset = br.charOffset;
          _rr.range = true;
          return _rr;
        }
        if (br !== null && br !== undefined) return _resultOk(br);
        // null/undefined = 通道失败（网络异常/5xx/响应体异常）→ 回退 cep.fs/ExtendScript
        return _readFileResultFallback(path);
      });
    }
    return _readFileResultFallback(path);
  }

  // readFile 薄适配层：内部调 Result 版，折叠回 string|null——旧调用方零改动。
  // 折叠规则：ok → data；NOT_FOUND/CHANNEL_FAILURE/REJECTED 任一失败态 → null
  //（逐分支返回值保持不变：所有失败路径均 resolve(null)）
  function readFile(path) {
    return readFileResult(path).then(function (r) { return r.ok === true ? r.data : null; });
  }

  // readFile 的 fetch → cep.fs 回退通道（Result 版；Bridge 不可用或 Bridge 返回 null 时）
  function _readFileResultFallback(path) {
    return new Promise(function (resolve) {
      if (_isSensitivePath(path)) {
        _lastError = '安全拒绝: 敏感路径 — ' + path;
        console.warn('[AEFS] ' + _lastError);
        resolve(_resultErr(RESULT_CODES.REJECTED, _lastError, null));
        return;
      }
      var fp = _toWin(path);
      var fwd = _toFwd(path);

      // ② fetch：只对扩展目录内的文件有效
      var extRoot = _getExtRoot();
      var url = '';
      if (extRoot && (fwd === extRoot || fwd.indexOf(extRoot + '/') === 0)) {
        // CEF file:// 协议下相对路径会丢盘符，需构造完整 file:/// URL
        // 对齐 fileUrl.js 的 ? # % 三字符编码口径——encodeURI 不转义保留字
        // ?（query 起始符），文件名含 ? 时 URL 被截断成「路径 + 空 query」，多一次
        // 注定失败的 fetch 才落 cep.fs；# 显式转义、% 由 encodeURI 自身转义，三者齐
        url = 'file:///' + encodeURI(fwd).replace(/#/g, '%23').replace(/\?/g, '%3F');
      }
      if (url && typeof fetch === 'function') {
        fetch(url)
          .then(function (resp) {
            if (resp.ok) return resp.text();
            throw new Error('fetch ' + resp.status);
          })
          .then(function (text) { resolve(_resultOk(text)); })
          .catch(function (fetchErr) {
            // ③ fetch 失败，回退 cep.fs（NOT_FOUND 最终判定权在 cep.fs）
            _lastError = 'readFile fetch 失败, 切 cep.fs: ' + path + ' (' + (fetchErr && fetchErr.message ? fetchErr.message : fetchErr) + ')';
            console.warn('[AEFS] ' + _lastError);
            _readViaCepFsResult(fp, resolve);
          });
      } else {
        _readViaCepFsResult(fp, resolve);
      }
    });
  }

  /**
   * 异步读文件。语义与 readFile 一致：成功返回 string，失败/不可用返回 null。
   * 无后缀 readFile 现已是真异步，readFileAsync 保留为别名（兼容旧调用方）。
   * @param {string} path
   * @returns {Promise<string|null>}
   */
  function readFileAsync(path) {
    return readFile(path);
  }

  // cep.fs 读取的 Result 化（readFile 链最终判定点）。「真没有」的错误码由
  // _cepNotFoundCode() 单点提供（同步面同源，两处不再各持一份魔法值）。
  // 若把 err=3（不存在）与 err=4（不可读）/异常/不可用 一同折叠 null，则成为
  // 「读失败→空会话→覆盖丢数据」的通道判定折叠点。
  function _readViaCepFsResult(fp, resolve) {
    if (_canRead()) {
      try {
        var r = window.cep.fs.readFile(fp, _getEncoding());
        if (r && r.err === 0 && typeof r.data === 'string') return resolve(_resultOk(r.data));
        // 三态化核心：err=NOT_FOUND → 真没有；其余 err → 通道故障
        var nf = _cepNotFoundCode();
        if (r && r.err === nf) {
          console.warn('[AEFS] readFile cep.fs: 文件不存在: ' + fp);
          return resolve(_resultErr(RESULT_CODES.NOT_FOUND, 'readFile cep.fs 文件不存在: ' + fp, 'cepfs'));
        }
        console.warn('[AEFS] readFile cep.fs 失败: ' + fp + ' err=' + (r ? r.err : 'void'));
        return resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, 'readFile cep.fs 失败: ' + fp + ' err=' + (r ? r.err : 'void'), 'cepfs'));
      } catch (e) {
        console.warn('[AEFS] readFile cep.fs 异常: ' + fp + ' ' + (e && e.message ? e.message : e));
        return resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, 'readFile cep.fs 异常: ' + fp + ' ' + (e && e.message ? e.message : e), 'cepfs'));
      }
    } else {
      console.warn('[AEFS] readFile cep.fs.readFile 不可用');
    }
    resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, 'readFile cep.fs.readFile 不可用', 'cepfs'));
  }

  /**
   * 写文件。① Bridge → ② cep.fs → ③ ExtendScript（自动建父目录）
   * @param {string} path — 绝对路径
   * @param {string} content — 文件内容
   * @returns {Promise<boolean>}
   */
  function writeFile(path, content) {
    if (!_checkPath(path)) return Promise.resolve(false);
    if (!_safeForDelete(path)) return Promise.resolve(false);
    if (content === null || content === undefined) return Promise.resolve(false);
    return _writeFileNormal(path, content);
  }

  // writeFile 的常规通道链（bridge → cep.fs/ES 回退）
  function _writeFileNormal(path, content) {
    if (_bridgeOk() && typeof Bridge.writeFileAsync === 'function') {
      // 异步 XHR，不阻塞主线程；Bridge 不可用/失败时走 _writeFileFallback
      return Bridge.writeFileAsync(_toWin(path), content).then(function (bRes) {
        // Bridge 4xx「真拒绝」：403 symlink 逃逸/敏感路径/命名空间。
        // 明确失败（记 _lastError），不回退 cep.fs——否则绕过 bridge 的 symlink 解析防护本地直写。
        // 审计：bodyLimit（413/readBody 超限 400）内容未落盘，非业务真拒绝 → 继续回退
        // 目标不是 UTF-8（GBK）——桥拒绝按 UTF-8 覆盖，这里改走 ES 按原编码写回
        if (bRes && typeof bRes === 'object' && bRes.code === 'TARGET_NOT_UTF8') {
          return _writeViaEsGbk(path, content).then(function (m) { return m === 'written'; });
        }
        if (bRes && typeof bRes === 'object' && bRes.__bridgeRejected && !bRes.bodyLimit) {
          _lastError = 'Bridge 拒绝写入 (HTTP ' + bRes.status + '): ' + path + (bRes.error ? ' — ' + bRes.error : '');
          console.warn('[AEFS] ' + _lastError);
          return false;
        }
        if (bRes === true) return true;
        // false = 通道失败（网络异常/5xx）→ 回退 cep.fs/ExtendScript
        return _writeFileFallback(path, content);
      });
    }
    return _writeFileFallback(path, content);
  }

  // LLM 专用写文件：可写任意非系统绝对路径（不强制命名空间白名单），供 writeFile 工具 → /fs/write-llm。
  // 安全链：_checkPath(格式) → _isSystemOrRootDir(系统目录/盘根) → _isSensitivePath(敏感凭据) →
  // Bridge.writeFileLlmAsync(symlink 逃逸)。
  // 每次调用由面板侧强制用户确认授权；本地 cep.fs 回退复用 _writeFileFallback（无命名空间限制）。
  function writeFileLlm(path, content) {
    if (!_checkPath(path)) return Promise.resolve({ ok: false, reason: 'invalid_path' });
    if (_isSystemOrRootDir(path)) return Promise.resolve({ ok: false, reason: 'system_dir' });
    if (_isSensitivePath(path)) return Promise.resolve({ ok: false, reason: 'sensitive' });
    if (content === null || content === undefined) return Promise.resolve({ ok: false, reason: 'no_content' });
    return _writeFileLlmNormal(path, content);
  }

  // writeFileLlm 的常规通道链（bridge /write-llm → 回退）
  function _writeFileLlmNormal(path, content) {
    if (_bridgeOk() && typeof Bridge.writeFileLlmAsync === 'function') {
      return Bridge.writeFileLlmAsync(_toWin(path), content).then(function (res) {
        if (res && res.ok) return { ok: true };
        if (res && res.serverError) return { ok: false, reason: 'server_error', detail: (res && res.error) || 'server error' };   // 5xx 服务器内部错误：非用户拒绝，不折叠为 denied 也不回退
        // 审计：401（token 轮换）与体超限（413/400 Invalid JSON）单独成 reason——
        // 折叠为 denied 会文案失真（实为鉴权自愈窗口/请求体超限，重试或减小内容可解）
        if (res && res.unauthorized) return { ok: false, reason: 'unauthorized', detail: (res && res.error) || 'unauthorized' };
        if (res && res.bodyLimit) return { ok: false, reason: 'body_too_large', detail: (res && res.error) || 'request body too large' };
        // 目标不是 UTF-8（GBK）——按原编码写回；写不成如实失败（绝不静默转成 UTF-8）
        if (res && res.code === 'TARGET_NOT_UTF8') {
          return _writeViaEsGbk(path, content).then(function (m) {
            return (m === 'written')
              ? { ok: true, encodingPreserved: true }
              : { ok: false, reason: 'encoding_unavailable', detail: '目标不是 UTF-8（GBK），按原编码写回失败（ExtendScript 通道不可用或目标是链接）' };
          });
        }
        if (res && res.denied) return { ok: false, reason: 'denied', detail: (res && res.error) || 'denied' };   // 显式拒绝（敏感/系统目录/二进制/目录），不回退
        return _resolveWaitRes(_writeFileFallback(path, content));   // 仅 bridge 不可用时才回退 cep.fs
      });
    }
    return _resolveWaitRes(_writeFileFallback(path, content));
  }
  // 将回退写入的 boolean 结果归一化为 { ok, reason }，与 writeFileLlm 返回契约一致
  function _resolveWaitRes(p) {
    return p.then(function (ok) {
      return ok ? { ok: true } : { ok: false, reason: 'write_failed' };
    });
  }

  // writeFile 的 cep.fs / ExtendScript 回退通道（Bridge 不可用或 Bridge 失败时）
  function _writeFileFallback(path, content) {
    return new Promise(function (resolve) {
      if (_isSensitivePath(path)) {
        _lastError = '安全拒绝: 敏感路径 — ' + path;
        console.warn('[AEFS] ' + _lastError);
        resolve(false);
        return;
      }
      try {
        var fp = _toWin(path);
        var parent = _parentDir(fp);

        // mkdir 父目录：cep.fs 优先，不行切 ExtendScript
        function ensureParent() {
          if (_canMkdir()) {
            var mr = window.cep.fs.mkdir(parent);
            if (mr && mr.err !== undefined && mr.err !== 0) {
              console.warn('[AEFS] writeFile mkdir 失败: ' + parent);
              return Promise.resolve(false);
            }
            return Promise.resolve(true);
          }
          return _mkdirES(parent);
        }

        ensureParent().then(function (dirOk) {
          if (!dirOk) return resolve(false);

          // 写文件：cep.fs 优先，不行切 ExtendScript
          if (_canWrite()) {
            resolve(_writeCepFsAtomic(fp, content, _getEncoding()));
          } else {
            console.warn('[AEFS] writeFile cep.fs.writeFile 不可用，切 ExtendScript');
            _writeFileES(fp, content).then(resolve);
          }
        }).catch(function (e) {
          console.warn('[AEFS] writeFile 异常: ' + path + ' ' + e);
          resolve(false);
        });
      } catch (e) { console.warn('[AEFS] writeFile 异常: ' + path + ' ' + e); resolve(false); }
    });
  }

  /**
   * 写二进制文件（base64 编码）。① Bridge → ② cep.fs → ③ ExtendScript（分块）
   * @param {string} path — 绝对路径
   * @param {string} base64 — base64 编码的二进制内容
   * @returns {Promise<boolean>}
   */
  function writeFileBase64(path, base64) {
    if (!_checkPath(path)) return Promise.resolve(false);
    if (!_safeForDelete(path)) return Promise.resolve(false);
    if (!base64 || typeof base64 !== 'string') return Promise.resolve(false);
    if (!/^[A-Za-z0-9+\/]*={0,2}$/.test(base64)) { _lastError = 'writeFileBase64 非法的 base64 字符串'; console.warn('[AEFS] ' + _lastError); return Promise.resolve(false); }
    // ① Bridge 异步（不阻塞主线程）；Bridge 不可用/失败时走 _writeFileBase64Fallback
    if (_bridgeOk() && typeof Bridge.writeFileBase64Async === 'function') {
      return Bridge.writeFileBase64Async(_toWin(path), base64).then(function (bRes) {
        // Bridge 4xx「真拒绝」（对齐 writeFile 的 __bridgeRejected 惯例）：
        // 403 symlink 逃逸/敏感路径/命名空间。明确失败（记 _lastError），
        // 不回退 cep.fs/ExtendScript——否则绕过 bridge 防护本地直写。
        // 审计：bodyLimit（413/400 Invalid JSON）内容未落盘，非业务真拒绝 → 回退
        if (bRes && typeof bRes === 'object' && bRes.__bridgeRejected && !bRes.bodyLimit) {
          _lastError = 'Bridge 拒绝写入 (HTTP ' + bRes.status + '): ' + path + (bRes.error ? ' — ' + bRes.error : '');
          console.warn('[AEFS] ' + _lastError);
          return false;
        }
        if (bRes === true) return true;
        // false = 通道失败（网络异常/5xx）→ 回退 cep.fs/ExtendScript
        return _writeFileBase64Fallback(path, base64);
      });
    }
    return _writeFileBase64Fallback(path, base64);
  }

  // writeFileBase64 的 cep.fs / ExtendScript 回退通道（Bridge 不可用或 Bridge 失败时）
  function _writeFileBase64Fallback(path, base64) {
    if (_isSensitivePath(path)) { _lastError = '安全拒绝: 敏感路径 — ' + path; console.warn('[AEFS] ' + _lastError); return Promise.resolve(false); }
    // ① cep.fs Base64（同步，单次调用，非热路径）
    var fp = _toWin(path);
    if (_canWrite()) {
      try {
        if (_canMkdir()) {
          var mr = window.cep.fs.mkdir(_parentDir(fp));
          if (mr && mr.err !== undefined && mr.err !== 0) {
            _lastError = 'writeFileBase64 cep.fs mkdir 父目录失败: ' + _parentDir(fp);
            console.warn('[AEFS] ' + _lastError);
            return Promise.resolve(false);
          }
        }
        var cepEnc = (typeof window !== 'undefined' && window.cep && window.cep.encoding) || null;
        if (cepEnc && cepEnc.Base64) {
          if (_writeCepFsAtomic(fp, base64, cepEnc.Base64)) return Promise.resolve(true);
        } else {
          // 不支持 Base64：atob 解码为 binary string 写入
          var binaryStr = atob(base64);
          if (_writeCepFsAtomic(fp, binaryStr)) return Promise.resolve(true);
        }
      } catch (_) {}
    }
    // ② ExtendScript 分块回退
    console.warn('[AEFS] writeFileBase64 Bridge+cep.fs 均失败，切 ExtendScript: ' + path);
    return _writeFileBase64ES(path, base64);
  }

  // Blob → base64 字符串（FileReader 异步，主线程无同步 API）
  function _blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.onerror = function () { reject(new Error('FileReader 读 Blob 失败')); };
      reader.readAsDataURL(blob);
    });
  }

  // 写二进制文件（Blob）。优先 Bridge 二进制通道（免 base64/JSON，大文件快一个量级），
  // 失败回退 Blob→base64→writeFileBase64（含 cep.fs/ExtendScript 全链）。
  //
  // ⚠️ 仅异步版，无 writeBlobSync：主线程没有同步 Blob→base64 的 API（FileReaderSync 仅 worker 可用），
  // 故同步版在 CEP 面板不可实现。安全检查（_checkPath + _safeForDelete）在异步版内完整覆盖，
  // 与 writeFileBase64 对齐；bridge 侧 safePath + safeForDelete 二次校验。
  //
  // 回退策略区分两类失败：
  //   - 通道不可用（fetch 不存在 / bridge 挂了 / 网络异常 catch）→ 回退 base64 链
  //   - 超限（413）/ 安全拒绝（400/403）→ 直接 false，不回退。否则对大文件会 _blobToBase64
  //     造一份等大 base64 字符串 + writeFileBase64Sync 同步阻塞主线程，双重内存峰值、面板卡死，
  //     且超限本就是真拒绝，回退只会更糟。
  function writeBlob(path, blob) {
    if (!blob) return Promise.resolve(false);
    if (!_checkPath(path)) return Promise.resolve(false);
    if (!_safeForDelete(path)) return Promise.resolve(false);
    // 敏感路径入口即拒（与 writeFileBase64 同口径）：Blob 二进制通道与 base64 回退链均不触达
    if (_isSensitivePath(path)) { _lastError = '安全拒绝: 敏感路径 — ' + path; console.warn('[AEFS] ' + _lastError); return Promise.resolve(false); }
    // 超大 blob 提前拒：bridge 也会拒，提前挡免得无谓回退。MAX 与 bridge MAX_WRITE_SIZE 对齐。
    if (blob.size > 512 * 1024 * 1024) {
      _lastError = 'writeBlob blob 超过 512MB 上限';
      console.warn('[AEFS] ' + _lastError);
      return Promise.resolve(false);
    }
    var fp = _toWin(path);
    // ① Bridge 二进制通道（最快）
    if (_bridgeOk() && typeof Bridge !== 'undefined' && typeof Bridge.writeBlob === 'function') {
      return Bridge.writeBlob(fp, blob).then(function (ok) {
        if (ok) return true;
        // 通道返回 false：可能是 bridge 返 413/4xx（已 reject 进 catch，不会到这）或 2xx 但 ok=false。
        // 真拒绝不回退（catch 分支已处理 413/4xx；此处兜底回退小概率场景）。
        return _blobToBase64(blob).then(function (b64) {
          return b64 ? writeFileBase64(fp, b64) : false;
        });
      }).catch(function (e) {
        // hardReject=true = bridge 业务拒绝(4xx 超限/安全)：真拒绝，不回退（回退 base64 双重内存峰值无意义）。
        // 无标记 = 网络异常 / fetch 整体失败（通道不可用）：回退 base64 链。
        if (e && e.hardReject) {
          console.warn('[AEFS] writeBlob 被拒绝(超限/安全)，不回退: ' + e.message);
          return false;
        }
        console.warn('[AEFS] writeBlob 二进制通道异常，回退 base64: ' + (e && e.message));
        return _blobToBase64(blob).then(function (b64) {
          return b64 ? writeFileBase64(fp, b64) : false;
        });
      });
    }
    // ② 无二进制通道：Blob → base64 → writeFileBase64（Bridge → cep.fs → ExtendScript 全链）
    return _blobToBase64(blob).then(function (b64) {
      return b64 ? writeFileBase64(fp, b64) : false;
    }).catch(function (e) {
      console.warn('[AEFS] writeBlob base64 回退失败: ' + (e && e.message));
      return false;
    });
  }

  /**
   * 读图片文件转 base64（异步）。Bridge-only，含 sharp 缩放/等待稳定等图片专用逻辑。
   * 无 cep.fs / ExtendScript 回退——图片读取依赖 Bridge Server。
   * @param {string} path — 图片绝对路径
   * @returns {Promise<{success: boolean, base64: string, size: number, mime: string}|null>}
   */
  function readImageBase64(path) {
    if (!_checkPath(path)) return Promise.resolve(null);
    // 异步通道失败不再回退 readImageBase64Sync——同步 XHR 会
    // 冻结整个面板（bridge 侧单个读请求可能先等 ≤15s 文件稳定才应答），且异步失败的主因
    // （bridge 不在/网络异常/4xx 拒绝）同步重试同样失败，只换来一次整面板冻结。仅在
    // **结构上**没有异步通道（Bridge 无 readImageBase64Async 或宿主无 fetch，旧缓存/
    // 非 CEF 宿主兼容口）时才走同步实现。
    if (_bridgeOk() && typeof fetch === 'function' && typeof Bridge.readImageBase64Async === 'function') {
      return Bridge.readImageBase64Async(_toWin(path)).then(function (r) {
        return r || null;
      });
    }
    return Promise.resolve(readImageBase64Sync(path));
  }

  /**
   * 读系统剪贴板（异步）。Bridge-only，无 cep.fs / ExtendScript 回退——
   * 剪贴板读取依赖 Bridge Server 专用端点（同 readImageBase64 先例）。
   * 返回契约与 Bridge.readClipboard 一致：
   *   { ok:true, kind:'image', base64, mime } / { ok:true, kind:'files', files[] } /
   *   { ok:false, error:'empty'|'ps_failed'|... } / null（bridge 不可用，调用方走浏览器通道回退）
   * @returns {Promise<object|null>}
   */
  function readClipboard() {
    if (!_bridgeOk() || typeof Bridge === 'undefined' || typeof Bridge.readClipboard !== 'function') {
      return Promise.resolve(null);
    }
    return Bridge.readClipboard();
  }

  // 读二进制文件为 Blob。是 writeBlob 的对称项——优先 Bridge 二进制通道（免 base64/JSON 编解码 +
  // 33% 膨胀传输），失败回退老 readImageBase64（仅限 png/jpg/jpeg 且 ≤100MB，老链读不了视频/大文件）。
  //
  // 返回 {success, blob, mime, size} | null（结构与 readImageBase64 的 {success, base64, size, mime}
  // 对齐，仅 base64→blob）。调用方拿到 Blob 可直接用（上传 ComfyUI / 设 img.src / 编辑器加载）。
  //
  // ⚠️ 仅异步版，无 readBlobSync：fetch 是异步的，主线程无同步二进制读取 API。
  // 安全：_checkPath 前置；bridge 侧 safePath 双校验 + isFile + 上限(MAX_BLOB_READ 512MB) + waitFileStable。
  function readBlob(path) {
    if (!_checkPath(path)) return Promise.resolve(null);
    var fp = _toWin(path);
    // ① Bridge 二进制通道（最快，通用二进制：图片/视频/任意文件）
    if (_bridgeOk() && typeof Bridge !== 'undefined' && typeof Bridge.readBlob === 'function') {
      return Bridge.readBlob(fp).then(function (blob) {
        if (blob) {
          return { success: true, blob: blob, mime: blob.type || '', size: blob.size };
        }
        // 二进制通道失败 → 回退老 readImageBase64（仅图片）
        return _readBlobFallbackImage(fp);
      }).catch(function (e) {
        console.warn('[AEFS] readBlob 二进制通道异常，回退图片链: ' + (e && e.message));
        return _readBlobFallbackImage(fp);
      });
    }
    // ② 无二进制通道：图片走老 readImageBase64（视频/其他类型老链读不了，返 null）
    return _readBlobFallbackImage(fp);
  }

  // readBlob 回退：仅 png/jpg/jpeg（与 bridge /api/read-image 端点的扩展名白名单对齐——该端点只接受
  // 这三种，gif/webp/bmp 进去会被 400 拒，放行只会白跑一趟 bridge 往返）走老 readImageBase64 → base64 → Blob
  // 回退老链走**异步** readImageBase64——调用 readImageBase64Sync 时
  //（同步 XHR）：二进制通道失败时同步重试大概率同样失败，却把面板冻在一次同步请求上。
  function _readBlobFallbackImage(fp) {
    var ext = fp.toLowerCase().split('.').pop();
    if (ext !== 'png' && ext !== 'jpg' && ext !== 'jpeg') {
      return Promise.resolve(null);  // 非白名单图片：老链不支持，直接 null（走主二进制通道即可）
    }
    return Promise.resolve(readImageBase64(fp)).then(function (r) {
      if (!r || !r.success || !r.base64) return null;
      var blob = _base64ToBlobLocal(r.base64, r.mime || 'image/png');
      return blob ? { success: true, blob: blob, mime: r.mime || '', size: r.size } : null;
    });
  }

  // base64 字符串 → Blob（atob 解码 + Uint8Array，aefs 内部用，不依赖外部 base64ToBlob）
  function _base64ToBlobLocal(base64, mime) {
    try {
      var raw = atob(base64);
      var len = raw.length;
      var bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) bytes[i] = raw.charCodeAt(i);
      return new Blob([bytes], { type: mime || 'application/octet-stream' });
    } catch (e) {
      console.warn('[AEFS] _base64ToBlobLocal 解码失败: ' + (e && e.message));
      return null;
    }
  }

  /**
   * 创建目录（幂等）。① Bridge.mkdirAsync（真异步 fetch，不阻塞主线程）→
   * ② cep.fs → ③ ExtendScript。
   * @param {string} path — 绝对路径
   * @returns {Promise<boolean>}
   */
  function mkdir(path) {
    if (!_checkPath(path)) return Promise.resolve(false);
    if (_bridgeOk() && typeof Bridge.mkdirAsync === 'function') {
      // 异步 XHR，不阻塞主线程；Bridge 不可用/返回 false 时走 _mkdirFallback 回退
      // 捕获 promise 经 per-seq 二分（并发同 method 不交叉污染）
      var _bp = Bridge.mkdirAsync(_toWin(path));
      return _bp.then(function (bOk) {
        if (bOk) return true;
        // Bridge 4xx「真拒绝」（403 symlink 逃逸/敏感路径、400 非法路径）→
        // 明确失败不回退 cep.fs/ExtendScript——否则绕过 bridge 防护在逃逸位置建目录。
        // 网络异常/5xx（无拒绝记录）仍照旧回退
        var _rej = _bridgeAsyncRejection('mkdir', _bp);
        if (_rej) {
          _lastError = 'mkdir Bridge 拒绝 (HTTP ' + _rej.status + '): ' + path;
          console.warn('[AEFS] ' + _lastError);
          return false;
        }
        return _mkdirFallback(path);
      });
    }
    return _mkdirFallback(path);
  }

  // mkdir 的 cep.fs / ExtendScript 回退通道（Bridge 不可用或 Bridge 返回 false 时）
  function _mkdirFallback(path) {
    if (_canMkdir()) {
      return new Promise(function (resolve) {
        try {
          var r = window.cep.fs.mkdir(_toWin(path));
          // r 可能为 undefined/null（方法不存在或静默失败），只有明确 err===0 才算成功
          if (!r || (r.err !== undefined && r.err !== 0)) {
            console.warn('[AEFS] mkdir 失败: ' + path + ' err=' + (r ? r.err : 'void'));
            return resolve(false);
          }
          resolve(true);
        } catch (e) { console.warn('[AEFS] mkdir 异常: ' + path + ' ' + e); resolve(false); }
      });
    }
    if (!_warnedCepMkdirMissing) {
      _warnedCepMkdirMissing = true;
      console.warn('[AEFS] mkdir cep.fs.mkdir 不可用，切 ExtendScript（本会话仅报一次）: ' + path);
    }
    return _mkdirES(path);
  }

  /**
   * 异步建目录。语义与 mkdir 一致：成功 true，失败 false。
   * 无后缀 mkdir 现已是真异步，mkdirAsync 保留为别名（兼容旧调用方）。
   * @param {string} path — 绝对目录路径
   * @returns {Promise<boolean>}
   */
  function mkdirAsync(path) {
    return mkdir(path);
  }

  /**
   * 删除文件。① Bridge → ② cep.fs → ③ ExtendScript File.remove()
   * @param {string} path — 绝对路径
   * @returns {Promise<boolean>}
   */
  /**
  * 删文件但**优先移入回收站**。
   * 成功 → {ok:true, method:'recyclebin'}；失败（桥不可用 / 4xx 拒绝 / 回收站通道失败）
   * → {ok:false, reason}——**本函数不退回永久删**，由调用方按已获用户确认的语义决定
   * （迁移覆盖删除阶段回退 deleteFile，见 dataDir.js runDeletePhase）。
   * 安全链与 deleteFile 相同：_checkPath → _safeForDelete → _depthOk；桥侧再做
   * safePath / safeForDelete / minDepthOk / resolveRealSafe 复核。
   * @param {string} path — 绝对路径
   * @returns {Promise<{ok:boolean, method?:string, reason?:string}>}
   */
  function deleteFileToRecycle(path) {
    if (!_checkPath(path)) return Promise.resolve({ ok: false, reason: 'invalid path' });
    if (!_safeForDelete(path)) return Promise.resolve({ ok: false, reason: 'not in safe namespace' });
    if (!_depthOk(path, 2)) { _lastError = '安全拒绝: 路径深度不足 — ' + path; return Promise.resolve({ ok: false, reason: 'depth' }); }
    if (!_bridgeOk() || typeof Bridge.deleteFileRecycleAsync !== 'function') {
      _lastError = 'deleteFileToRecycle 桥不可用: ' + path;
      return Promise.resolve({ ok: false, reason: 'bridge unavailable' });
    }
    var _bp = Bridge.deleteFileRecycleAsync(_toWin(path));
    return _bp.then(function (res) {
      if (res && res.ok) return { ok: true, method: res.method || 'recyclebin' };
      var _rej = _bridgeAsyncRejection('delete', _bp);
      return { ok: false, reason: (_rej && ('http ' + _rej.status)) || (res && res.reason) || 'recycle failed' };
    }, function () { return { ok: false, reason: 'channel failure' }; });
  }

  function deleteFile(path) {
    if (!_checkPath(path)) return Promise.resolve(false);
    if (!_safeForDelete(path)) return Promise.resolve(false);
    if (!_depthOk(path, 2)) { _lastError = '安全拒绝: 路径深度不足 — ' + path; console.warn('[AEFS] deleteFile ' + _lastError); return Promise.resolve(false); }
    if (_bridgeOk()) {
      // 异步 XHR，不阻塞主线程；Bridge 不可用/失败时返回 false，走下方 cep.fs / ExtendScript 回退
      // 捕获 promise 经 per-seq 二分（并发同 method 不交叉污染）
      var _bp = Bridge.deleteFileAsync(_toWin(path));
      return _bp.then(function (bOk) {
        if (bOk) return true;
        // Bridge 4xx「真拒绝」（403 symlink 逃逸/命名空间/深度不足）→ 明确失败，
        // 不回退 cep.fs/ExtendScript——否则绕过 bridge 防护本地直删。
        // 网络异常/5xx（无拒绝记录）仍照旧回退
        var _rej = _bridgeAsyncRejection('delete', _bp);
        if (_rej) {
          _lastError = 'deleteFile Bridge 拒绝 (HTTP ' + _rej.status + '): ' + path;
          console.warn('[AEFS] ' + _lastError);
          return false;
        }
        return _deleteFallback(path);
      });
    }
    return _deleteFallback(path);
  }

  // deleteFile 的 cep.fs / ExtendScript 回退通道（Bridge 不可用或 Bridge 删除失败时）。
  function _deleteFallback(path) {
    if (_canDelete()) {
      return new Promise(function (resolve) {
        try {
          var r = window.cep.fs.deleteFile(_toWin(path));
          if (r && r.err !== undefined && r.err !== 0) {
            console.warn('[AEFS] deleteFile 失败: ' + path + ' err=' + r.err);
            return resolve(false);
          }
          resolve(true);
        } catch (e) { console.warn('[AEFS] deleteFile 异常: ' + path + ' ' + e); resolve(false); }
      });
    }
    // ExtendScript 回退：File.remove()
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = 'deleteFile ExtendScript 不可用 (CSInterface 未定义): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return resolve(false);
      }
      var sd = _toFwd(path);
      if (!sd) return resolve(false);
      // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，路径未转义会让整条 evalScript 解析失败
      var sdEsc = sd.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      var timeout = setTimeout(function () {
        _lastError = 'deleteFile ExtendScript 超时 (5s): ' + path;
        console.warn('[AEFS] ' + _lastError);
        resolve(false);
      }, 5000);
      try {
        new CSInterface().evalScript(
          'var f=new File("' + sdEsc + '");(f.exists?f.remove():false);',
          function (result) { clearTimeout(timeout); resolve(result === true || result === 'true'); }
        );
      } catch (_) { clearTimeout(timeout); resolve(false); }
    });
  }

  // Bridge 异步列目录内部实现——返回 {names, rejected} 供 listFiles/listDirs
  // 公开版（对外仍折叠为 []）与 isEmptyDir（需区分「被拒」与「空」）共用。
  // rejected = 本次调用按 promise.__callSeq 定位的 per-seq 4xx 拒绝状态码，
  // null = 通道失败或成功——与同步版 listFilesSync 读 getLastSyncRejection 的二分语义
  // 对齐。旧版/测试 mock 的 Bridge 无 __callSeq/consumeAsyncRejection 时 seq 为 0，
  // rejected 恒 null（视同通道失败走回退链，与改造前的 mock 语义一致）
  // names 三态——非空数组 = 有结果；[] = bridge 权威空答案（目录存在且
  // 为空，直接采信不再复核）；null = 通道失败（bridge 挂起/5xx/网络异常/路径不存在），
  // 下落 cep.fs/ExtendScript 复核链。bridge.js 包装把失败与真空折叠成同一个 [] 时，
  // AEFS 无法信任空答案——每个空目录都复核一遍，启动期大预设库全树扫描（两遍）产生
  // 上百次 evalScript 洪泛（81 叶子目录 × listDirs 空 → ES 复核），AE 主线程被启动 IO 占用。
  function _listViaBridgeAsync(dirPath, kind) {
    var call = (kind === 'dirs') ? Bridge.listDirsAsync : Bridge.listFilesAsync;
    var p = call(_toWin(dirPath));
    var seq = (p && typeof p.__callSeq === 'number') ? p.__callSeq : 0;
    return p.then(function (names) {
      var rejected = null;
      if (seq && typeof Bridge.consumeAsyncRejection === 'function') {
        var rej = Bridge.consumeAsyncRejection(seq);
        if (rej && rej.method === 'list' && rej.status) rejected = rej.status;
      }
      return { names: names, rejected: rejected };
    });
  }

  // listFiles 的 cep.fs → ExtendScript 回退链（Result 版；Bridge 不可用或通道失败时）
  // _listDirsResultFallback 不走 cep.fs（readdir
  // 无类型信息，区分不了文件/目录）——两条回退链的差异是既有契约，保持。
  function _listFilesResultFallback(dirPath) {
    return new Promise(function (resolve) {
      if (_canReaddir()) {
        try {
          var r = window.cep.fs.readdir(_toWin(dirPath));
          if (r && r.err === 0 && Array.isArray(r.data)) {
            console.warn('[AEFS] listFiles (cep.fs): ' + r.data.length + ' 项');
            return resolve(_resultOk(r.data));
          }
        } catch (_) {}
      }
      // cep.fs 不可用/失败（含目录不存在 err≠0）→ ES 权威探测（NOT_FOUND 判定归 ES）
      _listViaExtendScriptResult(dirPath, resolve, false);
    });
  }

  // listFiles 的 Result 版（手术 2 孪生对之一，与 listDirs 共享
  // _listViaExtendScriptResult/_listViaBridgeAsync——两 API 原子迁移，防姊妹副本）。
  // 三态：ok(names)=读得（含空目录 ok([])）；NOT_FOUND=ES 探测确认目录不存在
  //（真没有）；CHANNEL_FAILURE=全链不可用/异常（拿不到）；REJECTED=路径校验/
  // 敏感路径入口拒（通道未触碰）/Bridge 4xx 真拒绝（channel='bridge'）。
  function listFilesResult(dirPath) {
    if (!_checkPath(dirPath)) return Promise.resolve(_resultErr(RESULT_CODES.REJECTED, 'listFiles 路径校验拒绝: ' + dirPath, null));
    // 敏感路径入口即拒（与 readFile 同口径）：Bridge 403 后曾仍走 cep.fs/ExtendScript 回退列敏感目录
    if (_isSensitivePath(dirPath)) { _lastError = '安全拒绝: 敏感路径 — ' + dirPath; console.warn('[AEFS] ' + _lastError); return Promise.resolve(_resultErr(RESULT_CODES.REJECTED, _lastError, null)); }
    if (_bridgeOk() && typeof Bridge.listFilesAsync === 'function') {
      // 对齐同步版 listFilesSync 二分——直接透传 Bridge.listFilesAsync 时，
      // 403 symlink 逃逸等 4xx 真拒绝被折叠成空列表（表现为空而非错误，调用方无从感知
      // 被拒）。真拒绝时记 _lastError；通道失败（网络异常/5xx）照旧下落
      // cep.fs / ExtendScript 复核（通道失败直接返 [] 同样会丢回退）
      // names===[] 是 bridge 的权威空答案（目录存在且为空）——直接
      // ok([]) 采信，不再下落复核（空结果复核洪泛的根源，见 _listViaBridgeAsync 注释）；
      // 仅 names===null（通道失败/路径不存在）才复核。复核链的 NOT_FOUND 语义经
      // notFound 标记保留在 null 分支
      return _listViaBridgeAsync(dirPath, 'files').then(function (res) {
        if (res.names && res.names.length) return _resultOk(res.names);
        if (res.rejected) {
          _lastError = 'listFiles Bridge 拒绝 (HTTP ' + res.rejected + '): ' + dirPath;
          console.warn('[AEFS] ' + _lastError);
          return _resultErr(RESULT_CODES.REJECTED, _lastError, 'bridge');
        }
        if (res.names === null) return _listFilesResultFallback(dirPath);
        return _resultOk([]);
      });
    }
    return _listFilesResultFallback(dirPath);
  }

  // listFiles 薄适配层：内部调 Result 版，折叠回数组——旧调用方零改动。
  // 折叠规则：ok → data；NOT_FOUND/CHANNEL_FAILURE/REJECTED 任一失败态 → []
  //（逐分支返回值保持不变：所有失败路径均 resolve([])）
  function listFiles(dirPath) {
    return listFilesResult(dirPath).then(function (r) { return r.ok === true ? r.data : []; });
  }

  /**
   * 异步列目录。语义与 listFiles 一致：返回文件名数组，失败返 []。
   * 无后缀 listFiles 现已是真异步，listFilesAsync 保留为别名（兼容旧调用方）。
   * @param {string} dirPath — 绝对目录路径
   * @returns {Promise<string[]>}
   */
  function listFilesAsync(dirPath) {
    return listFiles(dirPath);
  }

  /**
   * 列文件 + 体积/龄（供 temp 缓存体积预算量体积）。**只走 Bridge**，不做 ExtendScript 回退：
   * 体积只有 Node 侧 statSync 拿得到——CEP 的 cep.fs.stat 不带 size 字段（AEFS.stat().size
   * 恒 0，见 _cepMtimeMs 注释），fileSize 是**每文件一次 evalScript**（占 AE 主线程）。
   * 拿不到就 resolve null，消费方（tempSweep.enforceBudget）按「未知 → 本次跳过」处理：
   * 不按 0 字节累加，否则整棵树会被误判超限并开始删文件。
   * @param {string} dirPath — 绝对目录路径
   * @returns {Promise<Array<{name:string,size:number,mtimeMs:number}>|null>} null = 拿不到（非「空目录」）
   */
  function listFilesWithSize(dirPath) {
    if (!_checkPath(dirPath)) return Promise.resolve(null);
    if (_isSensitivePath(dirPath)) {
      _lastError = '安全拒绝: 敏感路径 — ' + dirPath;
      console.warn('[AEFS] ' + _lastError);
      return Promise.resolve(null);
    }
    if (_bridgeOk() && typeof Bridge.listSizesAsync === 'function') {
      try {
        return Bridge.listSizesAsync(_toWin(dirPath)).then(function (list) {
          return Array.isArray(list) ? list : null;
        }).catch(function () { return null; });
      } catch (_) {
        return Promise.resolve(null);
      }
    }
    return Promise.resolve(null);
  }

  // ES 回退 Result 化（listFiles/listDirs 共享，原子迁移）。脚本协议升级：
  // 目录不存在 → 空串 ''；正常 → '__AEFS_LIST__' 前缀 + 名单 join('\n')。回调三态：
  // '' = NOT_FOUND（真没有）；前缀命中 = ok(names)（空目录 ok([])——前缀保证与
  // NOT_FOUND 无歧义，名单中出现同名串的文件也不混淆）；其余（undefined/
  // 'EvalScript error.' 等）= CHANNEL_FAILURE。旧协议 '' 与「目录存在但为空」
  // 同为空串，两者折叠不可分——这正是「遍历失败→空源→迁移假成功」在
  // ES 层的折叠点；且名单会把 'EvalScript error.' 当文件名混进来。
  function _listViaExtendScriptResult(dirPath, resolve, filterFolders) {
    var tag = filterFolders ? 'listDirs' : 'listFiles';
    if (!_hasCS()) {
      _lastError = tag + ' ExtendScript 不可用 (CSInterface 未定义): ' + dirPath;
      console.warn('[AEFS] ' + _lastError);
      return resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastError, 'extendscript'));
    }
    var sd = _toFwd(dirPath);
    if (!sd) return resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, tag + ' 路径归一失败: ' + dirPath, null));
    // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，路径未转义会让整条 evalScript 解析失败
    var sdEsc = sd.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    // filterFolders: true → 只要目录, false/undefined → 只要文件
    var check = filterFolders ? 'subs[i] instanceof Folder' : '!(subs[i] instanceof Folder)';
    var es =
      'var d=new Folder("' + sdEsc + '");' +
      'if(!d.exists){"";}else{' +
      'var subs=d.getFiles();' +
      'var names=[];' +
      'for(var i=0;i<subs.length;i++){' +
      'if(' + check + '){names.push(subs[i].displayName);}' +
      '}' +
      '"__AEFS_LIST__"+names.join("\\n");}';
    var timeout = setTimeout(function () {
      _lastError = tag + ' ExtendScript 超时 (5s): ' + dirPath;
      console.warn('[AEFS] ' + _lastError);
      resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastError, 'extendscript'));
    }, 5000);
    try {
      new CSInterface().evalScript(es, function (result) {
        clearTimeout(timeout);
        if (result === '') {
          // 脚本明确返回空串 = 目录不存在（探测完成，真没有）
          return resolve(_resultErr(RESULT_CODES.NOT_FOUND, tag + ' 探测完成，目录不存在: ' + dirPath, 'extendscript'));
        }
        if (typeof result === 'string' && result.indexOf('__AEFS_LIST__') === 0) {
          var names = result.slice('__AEFS_LIST__'.length).split('\n').filter(function (n) { return !!n; });
          console.warn('[AEFS] ' + tag + ' (ExtendScript): ' + names.length + ' 项');
          return resolve(_resultOk(names));
        }
        // undefined / 'EvalScript error.' 等 = 通道故障（拿不到，非「目录为空/不存在」）
        _lastError = tag + ' ExtendScript 异常返回 (' + String(result) + '): ' + dirPath;
        console.warn('[AEFS] ' + _lastError);
        resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastError, 'extendscript'));
      });
    } catch (e) {
      clearTimeout(timeout);
      console.warn('[AEFS] ' + tag + ' ExtendScript 异常: ' + dirPath + ' ' + e);
      resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, tag + ' ExtendScript 异常: ' + dirPath + ' ' + e, 'extendscript'));
    }
  }

  // listDirs 的 ExtendScript 回退链（Result 版；Bridge 不可用或通道失败时；
  // cep.fs.readdir 无类型信息，不做中转——与既有行为一致）。_hasCS 守卫由

  function _listDirsResultFallback(dirPath) {
    return new Promise(function (resolve) {
      _listViaExtendScriptResult(dirPath, resolve, true);
    });
  }

  // listDirs 的 Result 版（与 listFiles 孪生对，共享回退基础设施——
  // 三态语义同 listFilesResult，见其块注释）
  function listDirsResult(dirPath) {
    if (!_checkPath(dirPath)) return Promise.resolve(_resultErr(RESULT_CODES.REJECTED, 'listDirs 路径校验拒绝: ' + dirPath, null));
    // 敏感路径入口即拒（与 listFiles 同口径）
    if (_isSensitivePath(dirPath)) { _lastError = '安全拒绝: 敏感路径 — ' + dirPath; console.warn('[AEFS] ' + _lastError); return Promise.resolve(_resultErr(RESULT_CODES.REJECTED, _lastError, null)); }
    if (_bridgeOk() && typeof Bridge.listDirsAsync === 'function') {
      // 对齐同步版 listDirsSync 二分（与 listFiles 同款）——直接透传
      // Bridge.listDirsAsync，403 真拒绝被折叠成空列表；真拒绝时记 _lastError，
      // 通道失败照旧下落 ExtendScript 回退链（直接返 [] 同样丢回退）
      // names===[] 权威空答案直接 ok([]) 采信（与 listFilesResult 同款，
      // 空结果复核洪泛根源见 _listViaBridgeAsync 注释）；仅 names===null 复核
      return _listViaBridgeAsync(dirPath, 'dirs').then(function (res) {
        if (res.names && res.names.length) return _resultOk(res.names);
        if (res.rejected) {
          _lastError = 'listDirs Bridge 拒绝 (HTTP ' + res.rejected + '): ' + dirPath;
          console.warn('[AEFS] ' + _lastError);
          return _resultErr(RESULT_CODES.REJECTED, _lastError, 'bridge');
        }
        if (res.names === null) return _listDirsResultFallback(dirPath);
        return _resultOk([]);
      });
    }
    return _listDirsResultFallback(dirPath);
  }

  // listDirs 薄适配层：内部调 Result 版，折叠回数组——旧调用方零改动。
  // 折叠规则：ok → data；NOT_FOUND/CHANNEL_FAILURE/REJECTED 任一失败态 → []
  //（逐分支返回值保持不变：所有失败路径均 resolve([])）
  function listDirs(dirPath) {
    return listDirsResult(dirPath).then(function (r) { return r.ok === true ? r.data : []; });
  }

  /**
   * 异步列子目录。语义与 listDirs 一致：返回子目录名数组，失败返回 []。
   * 无后缀 listDirs 现已是真异步，listDirsAsync 保留为别名（兼容旧调用方）。
   * @param {string} dirPath — 绝对目录路径
   * @returns {Promise<string[]>}
   */
  function listDirsAsync(dirPath) {
    return listDirs(dirPath);
  }

  /**
   * 递归拷贝目录（二进制安全，全文件类型）。
   * ① Bridge.copyDirAsync（Node fs.copyFileSync，异步 XHR 不阻塞主线程）
   * → ② 逐个文件 readFile→writeFile（cep.fs/ExtendScript 回退，仅文本）
   * @param {string} srcDir — 源目录（绝对路径）
   * @param {string} dstDir — 目标目录（绝对路径）
   * @returns {Promise<boolean>} — 全成功才 true，部分/全部失败返 false
   */
  function copyDir(srcDir, dstDir) {
    if (!_checkPath(srcDir) || !_checkPath(dstDir)) return Promise.resolve(false);
    // src 是读语义：敏感路径入口即拒（与 readFile 同口径，Bridge/cep.fs/ExtendScript 全链拒）
    if (_isSensitivePath(srcDir)) { _lastError = '安全拒绝: 敏感路径 — ' + srcDir; console.warn('[AEFS] ' + _lastError); return Promise.resolve(false); }
    if (!_safeForDelete(dstDir)) return Promise.resolve(false);
    var srcWin = _toWin(srcDir);
    var dstWin = _toWin(dstDir);
    // ① Bridge 批量拷贝（最快，Node 侧直接 fs.copyFileSync）——异步 XHR 不阻塞主线程
    if (_bridgeOk() && typeof Bridge.copyDirAsync === 'function') {
      // 捕获 promise 经 per-seq 二分（并发同 method 不交叉污染）
      var _bp = Bridge.copyDirAsync(srcWin, dstWin);
      return _bp.then(function (res) {
        // 新响应形状 {copied, failed}——failed > 0 = 部分文件拷贝失败 → 整体
        // false（对齐回退链 totalOk === rels.length 的严格语义，不再部分失败假成功）
        if (res && typeof res === 'object' && typeof res.copied === 'number') {
          if (res.failed > 0) {
            _lastError = 'copyDir 部分文件拷贝失败 (' + res.failed + ' 个): ' + srcDir + ' → ' + dstDir;
            console.warn('[AEFS] ' + _lastError);
            return false;
          }
          return true; // copied >= 0 且 failed 为 0（0 文件 = 空源，也算成功）
        }
        // 旧形状（number，向后兼容旧服务端/测试 mock）：copied >= 0 视为成功
        if (typeof res === 'number' && res >= 0) return true;
        // null = Bridge 返回失败。4xx「真拒绝」（403 symlink 逃逸/敏感路径/
        // 命名空间）→ 明确失败不回退——否则逐文件 read→write 回退链会绕过 bridge
        // 防护直读 symlink 目标。通道失败（网络异常/5xx）照旧走回退链
        var _rej = _bridgeAsyncRejection('copy-dir', _bp);
        if (_rej) {
          _lastError = 'copyDir Bridge 拒绝 (HTTP ' + _rej.status + '): ' + srcDir + ' → ' + dstDir;
          console.warn('[AEFS] ' + _lastError);
          return false;
        }
        return _copyDirFallback(srcDir, dstDir);
      });
    }
    return _copyDirFallback(srcDir, dstDir);
  }

  // copyDir 回退链：逐个文件 read→write（cep.fs/ExtendScript 通道，Bridge 不可用或 Bridge 失败时）
  function _copyDirFallback(srcDir, dstDir) {
    var srcFwd = _toFwd(srcDir);
    var dstWin = _toWin(dstDir);

    // _listAllFilesRecursive 返回 { ok, rels } 形态——遍历失败（超时/
    // 异常/evalScript 无有效结果）不再与「空源」折叠为同一个空列表。若失败也
    // resolve([])，此处按空源 mkdir 返回 true，Bridge 掉线窗口内 migrateData 逐
    // 子目录假成功、main.js 提示「可删旧目录」后用户删旧目录 = 数据永久丢失
    return _listAllFilesRecursive(srcFwd).then(function (listRes) {
      if (!listRes || !listRes.ok) {
        _lastError = 'copyDir 失败: 源目录遍历失败 (' + srcFwd + ')';
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
      var rels = listRes.rels || [];
      if (rels.length === 0) {
        // 空源目录（含源目录不存在）：只确保目标目录存在
        console.warn('[AEFS] copyDir 空源: ' + srcFwd + ' → mkdir 目标');
        return mkdir(dstWin).then(function (ok) { return ok; });
      }

      console.warn('[AEFS] copyDir: ' + srcFwd + ' → ' + dstWin + ' (' + rels.length + ' 个文件)');
      var copied = 0, skipped = 0;
      var promises = [];

      for (var i = 0; i < rels.length; i++) {
        (function (rel) {
          var relFwd = rel.replace(/\\/g, '/');
          var srcAbs = srcFwd + '/' + relFwd;
          var dstAbs = dstWin + '\\' + rel.replace(/\//g, '\\');
          promises.push(
            exists(dstAbs).then(function (dstExists) {
              if (dstExists) {
                // exists 无 bridge 时走 ExtendScript，可能与 cep.fs 视图不一致；
                // 用 existsSync（Bridge/cep.fs）复核目标确实存在，否则视为误报继续拷贝
                if (_bridgeOk() || existsSync(dstAbs)) { skipped++; return true; }
                console.warn('[AEFS] copyDir exists 误报（existsSync 复核失败），重拷: ' + dstAbs);
              }
              return readFile(srcAbs).then(function (content) {
                if (content === null) {
                  console.warn('[AEFS] copyDir read FAIL: ' + srcAbs);
                  return false;
                }
                return writeFile(dstAbs, content).then(function (written) {
                  if (!written) console.warn('[AEFS] copyDir write FAIL: ' + dstAbs);
                  else copied++;
                  return written;
                });
              });
            })
          );
        })(rels[i]);
      }

      return Promise.all(promises).then(function () {
        var totalOk = copied + skipped;
        console.warn('[AEFS] copyDir: ' + copied + ' 拷, ' + skipped + ' 跳, ' + (rels.length - totalOk) + ' 败');
        return totalOk === rels.length;
      });
    });
  }

  // 递归列全部文件（含子目录）
  // 返回 { ok:boolean, rels:[...] }——遍历成功（含真空目录/源目录不
  // 存在，rels:[]）与遍历失败（超时/异常/evalScript 无有效结果，ok:false）显式
  // 区分，不再把失败折叠成空列表（_copyDirFallback 会当空源 mkdir 假成功）
  function _listAllFilesRecursive(dirFwd) {
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = 'copyDir 遍历 ExtendScript 不可用 (CSInterface 未定义): ' + dirFwd;
        console.warn('[AEFS] ' + _lastError);
        return resolve({ ok: false, rels: [] });
      }
      var es =
        'function walk(folder,base){' +
        'var out=[];' +
        'var list=folder.getFiles();' +
        'for(var i=0;i<list.length;i++){' +
        'if(list[i] instanceof Folder){out=out.concat(walk(list[i],base));}' +
        'else{var rel=list[i].fullName.substring(base.length+1);out.push(rel);}' +
        '}' +
        'return out;' +
        '}' +
        // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，路径未转义会让整条 evalScript 解析失败
        // （对齐同文件其余 11 处拼接写法——仅转义引号时，路径含该字符时
        // copyDir 会把非空源当空源假成功零拷贝）
        'var d=new Folder("' + dirFwd.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + '");' +
        // 成功路径必须回传非空哨兵（源不存在/真空目录 → __AEFS_NO_FILES__），
        // 使「遍历成功但无文件」与「evalScript 空串（无有效结果，按失败）」可区分
        'if(!d.exists){"__AEFS_NO_FILES__";}else{' +
        'var rels=walk(d,d.fullName);' +
        'rels.length===0?"__AEFS_NO_FILES__":rels.join("\\n");}';
      var timeout = setTimeout(function () {
        _lastError = 'copyDir 遍历超时 (10s): ' + dirFwd;
        console.warn('[AEFS] ' + _lastError);
        resolve({ ok: false, rels: [] });
      }, 10000);
      try {
        new CSInterface().evalScript(es, function (result) {
          clearTimeout(timeout);
          // 空串/'EvalScript error.' = 未取得遍历结果 → 失败（折叠成
          // resolve([]) 被当空源假成功）；判定对齐 _statES 的既有哨兵写法
          if (!result || result === 'EvalScript error.') {
            _lastError = 'copyDir 遍历失败 (evalScript 无有效结果): ' + dirFwd;
            console.warn('[AEFS] ' + _lastError);
            return resolve({ ok: false, rels: [] });
          }
          if (result === '__AEFS_NO_FILES__') return resolve({ ok: true, rels: [] });
          // 排除 .gitkeep（git 占位文件，不应拷贝到用户数据目录）
          resolve({ ok: true, rels: result.split('\n').filter(function (r) { return !!r && !r.endsWith('.gitkeep'); }) });
        });
      } catch (e) {
        clearTimeout(timeout);
        console.warn('[AEFS] _listAllFilesRecursive 异常: ' + dirFwd + ' ' + e);
        resolve({ ok: false, rels: [] });
      }
    });
  }

  /**
   * 探测路径是否存在。① Bridge → ② ExtendScript Folder/File 探测
   * @param {string} path — 绝对路径
   * @returns {Promise<boolean>}
   */
  // exists 的 Result 版（手术 2 首个存量 API 参考迁移）。
  // 三态：ok(true)=存在；NOT_FOUND=ExtendScript 探测确认不存在（真没有）；
  // CHANNEL_FAILURE=通道故障（CSInterface 不可用 / 探测超时 / evalScript 异常或
  // 非空错误返回——「拿不到」，若折叠为 false 就与「真没有」不可区分）；
  // REJECTED=路径校验或敏感路径拒绝（入口即拒，通道未触碰）。
  // channel 记录探测走到的最终层：'bridge' | 'extendscript'。
  // 旧签名 exists 为薄适配层（见下），行为逐分支等价——_lastError 诊断与
  // console.warn 留痕语义原样保留在核心实现内。
  function existsResult(path) {
    if (!_checkPath(path)) {
      return Promise.resolve(_resultErr(RESULT_CODES.REJECTED, 'exists 路径校验拒绝: ' + path, null));
    }
    // 敏感路径入口即拒（存在性 oracle）：Bridge 403 后曾仍走 ES 回退（ExtendScript）
    // 把敏感文件探成 true——入口即拒，Bridge 与 ES 回退均不触碰
    if (_isSensitivePath(path)) {
      _lastError = '安全拒绝: 敏感路径 — ' + path;
      console.warn('[AEFS] ' + _lastError);
      return Promise.resolve(_resultErr(RESULT_CODES.REJECTED, _lastError, null));
    }
    if (_bridgeOk() && typeof Bridge.existsAsync === 'function') {
      // 异步 XHR，不阻塞主线程；Bridge 不可用/通道失败（be===null）时走 _existsResultFallback 回退
      // 捕获 promise 经 per-seq 二分（并发同 method 不交叉污染）
      var _bp = Bridge.existsAsync(_toWin(path));
      return _bp.then(function (be) {
        if (be === true) return _resultOk(true);
        // 4xx「真拒绝」（403 symlink 逃逸等）不走 ES 回退——ExtendScript 的
        // Folder/File.exists 跟随 symlink，会把 bridge 明确拒绝的路径探成 true，
        // 绕过存在性 oracle 的防护；对齐同文件 mkdir/delete/copy-dir 等六处守卫
        var _rej = _bridgeAsyncRejection('exists', _bp);
        if (_rej) {
          _lastError = 'exists Bridge 拒绝 (HTTP ' + _rej.status + '): ' + path;
          console.warn('[AEFS] ' + _lastError);
          return _resultErr(RESULT_CODES.REJECTED, _lastError, 'bridge');
        }
        // be===false 是 bridge 权威「不存在」（服务端 200 + exists:false，
        // 实测对不存在路径正常返回而非 4xx）——直接 NOT_FOUND 定论，不再经 ES 复核
        //（与 list 空答案权威化同族：把失败与权威 false 折叠，每个
        // 负答案都做一次 evalScript 往返；projectAssetStore.load 逐条 existsAsync
        // 探测索引条目时成批放大）。be===null 才是通道失败 → 下落 ES 回退链
        if (be === false) return _resultErr(RESULT_CODES.NOT_FOUND, 'exists Bridge 探测完成，不存在: ' + path, 'bridge');
        return _existsResultFallback(path);
      });
    }
    return _existsResultFallback(path);
  }

  // exists 薄适配层：内部调 Result 版，折叠回布尔——旧调用方零改动。
  // 折叠规则：ok → data；NOT_FOUND/CHANNEL_FAILURE/REJECTED 任一失败态 → false
  //（逐分支返回值保持不变：所有失败路径均 resolve(false)）
  function exists(path) {
    return existsResult(path).then(function (r) { return r.ok === true; });
  }

  // exists 的 ExtendScript 回退通道（Result 版；Bridge 不可用或返回 false 时）
  function _existsResultFallback(path) {
    return new Promise(function (resolve) {
      // 回退入口同样拒敏感路径（与 existsResult 主入口双保险，对齐 _readFileResultFallback 模式）
      if (_isSensitivePath(path)) {
        _lastError = '安全拒绝: 敏感路径 — ' + path;
        console.warn('[AEFS] ' + _lastError);
        resolve(_resultErr(RESULT_CODES.REJECTED, _lastError, null));
        return;
      }
      if (!_hasCS()) {
        _lastError = 'exists ExtendScript 不可用 (CSInterface 未定义): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastError, 'extendscript'));
      }
      var sd = _toFwd(path);
      if (!sd) return resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, 'exists 路径归一失败: ' + path, null));
      // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，路径未转义会让整条 evalScript 解析失败
      var sdEsc = sd.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      var es =
        'var d=new Folder("' + sdEsc + '");' +
        'if(d.exists){"FOLDER"}' +
        'else{var f=new File("' + sdEsc + '");' +
        '(f.exists?"FILE":"");}';
      var timeout = setTimeout(function () {
        _lastError = 'exists ExtendScript 超时 (5s): ' + path;
        console.warn('[AEFS] ' + _lastError);
        resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastError, 'extendscript'));
      }, 5000);
      try {
        new CSInterface().evalScript(es, function (result) {
          clearTimeout(timeout);
          if (result === 'FOLDER' || result === 'FILE') {
            resolve(_resultOk(true));
          } else if (result === '') {
            // ES 表达式按约返回空串 = 探测完成且不存在（真没有）
            resolve(_resultErr(RESULT_CODES.NOT_FOUND, 'exists 探测完成，目标不存在: ' + path, 'extendscript'));
          } else {
            // undefined / 'EvalScript error.' 等 = 通道故障（拿不到，非不存在）
            _lastError = 'exists ExtendScript 异常返回 (' + String(result) + '): ' + path;
            console.warn('[AEFS] ' + _lastError);
            resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastError, 'extendscript'));
          }
        });
      } catch (e) {
        clearTimeout(timeout);
        console.warn('[AEFS] exists 异常: ' + path + ' ' + e);
        resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, 'exists 异常: ' + path + ' ' + e, 'extendscript'));
      }
    });
  }

  /**
   * 异步检查路径是否存在。语义与 exists 一致：存在 true，否则 false。
   * 无后缀 exists 现已是真异步，existsAsync 保留为别名（兼容旧调用方）。
   * @param {string} path — 绝对路径
   * @returns {Promise<boolean>}
   */
  function existsAsync(path) {
    return exists(path);
  }

  /**
   * 批量探测路径是否存在（真异步，不阻塞主线程）。① Bridge.existsBatch（异步 fetch，一次往返）
   * → ② 批量通道失败时逐条 exists 复查 → ③ Bridge 批量不可用时逐条 exists。
   * 用于遍历几万素材（_checkMissing / quickBar 扫描）时避免逐条同步 XHR 冻结 UI。
   * 语义与 exists 对齐：非法路径按不存在（false）处理。
   * Bridge.existsBatch 通道故障（网络异常/非 ok）为 reject——此处 catch 后走
   * 逐条 exists 复查（单条 exists 自带 Bridge→ExtendScript 回退链，掉线窗口仍能给出
   * 真实答案）。折叠成 [] 会映射为「等长全 false」，绕过调用方
   * 全部「无法校验按存在」防护（quickBarScanner 三层/store 层 catch），掉线窗口内
   * 全部素材被误标 missing。
   * @param {string[]} paths — 绝对路径数组
   * @returns {Promise<boolean[]>} 与输入等长，index 一一对应
   */
  function existsBatch(paths) {
    if (!Array.isArray(paths) || !paths.length) return Promise.resolve([]);
    // 逐条过 _checkPath（与单点 exists 一致），非法路径直接标 false
    var checked = [];
    var validIdx = [];   // checked 中有效项在原始 paths 的下标
    for (var i = 0; i < paths.length; i++) {
      if (_checkPath(paths[i])) { validIdx.push(i); checked.push(paths[i]); }
    }
    var result = new Array(paths.length).fill(false);
    if (!checked.length) return Promise.resolve(result);
    // 逐条 exists 回退（Bridge 批量不可用或批量通道失败时）——并发，仍优于串行 await
    function perItem() {
      var ps = validIdx.map(function (vi) {
        return exists(paths[vi]).then(function (ok) { result[vi] = !!ok; });
      });
      return Promise.all(ps).then(function () { return result; });
    }
    if (_bridgeOk() && typeof Bridge.existsBatch === 'function') {
      var winChecked = checked.map(function (p) { return _toWin(p); });
      var p = Bridge.existsBatch(winChecked);
      if (p && typeof p.then === 'function') {
        return p.then(function (arr) {
          if (Array.isArray(arr)) {
            for (var k = 0; k < validIdx.length && k < arr.length; k++) {
              result[validIdx[k]] = !!arr[k];
            }
          }
          return result;
        }, function (err) {
          // 批量通道失败不得折叠成全 false（会绕过调用方全部「无法校验按存在」
          // 防护、误标全 missing），逐条 exists 复核
          console.warn('[AEFS] existsBatch 批量通道失败，逐条 exists 复核: ' + ((err && err.message) || err));
          return perItem();
        });
      }
    }
    return perItem();
  }

  /**
   * 路径是否为普通文件。① Bridge（statSync.isFile）→ ② ExtendScript（File.exists）
   * 只读操作：仅过 _checkPath，不走 _safeForDelete/_depthOk。
   * @param {string} path — 绝对路径
   * @returns {Promise<boolean>}
   */
  function isFile(path) {
    if (!_checkPath(path)) return Promise.resolve(false);
    if (_bridgeOk() && typeof Bridge.isFileAsync === 'function') {
      // 异步 XHR，不阻塞主线程；Bridge 不可用/通道失败（bOk===null）时走 _isFileFallback
      // 捕获 promise 经 per-seq 二分（并发同 method 不交叉污染）
      var _bp = Bridge.isFileAsync(_toWin(path));
      return _bp.then(function (bOk) {
        if (bOk === true) return true;
        // 4xx「真拒绝」不走 ES 回退（对齐 exists 守卫）——bridge 侧 isFileAsync
        // 经 _callAsync 调用，4xx 拒绝记录经 per-seq 二分
        var _rej = _bridgeAsyncRejection('is-file', _bp);
        if (_rej) {
          _lastError = 'isFile Bridge 拒绝 (HTTP ' + _rej.status + '): ' + path;
          console.warn('[AEFS] ' + _lastError);
          return false;
        }
        // bOk===false 是 bridge 权威「非文件/不存在」（服务端 200 +
        // isFile:false）——直接返回，不再经 ES 复核（与 list 空答案权威化
        // 同族：失败与权威 false 折叠会让每个负答案都做一次 evalScript 往返）。
        // bOk===null 才是通道失败 → 下落 ES 回退链
        if (bOk === false) return false;
        return _isFileFallback(path);
      });
    }
    return _isFileFallback(path);
  }

  // isFile 的 ExtendScript 回退通道（Bridge 不可用或 Bridge 返回 false 时）
  function _isFileFallback(path) {
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = 'isFile ExtendScript 不可用 (CSInterface 未定义): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return resolve(false);
      }
      var sd = _toFwd(path);
      if (!sd) return resolve(false);
      // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，路径未转义会让整条 evalScript 解析失败
      var sdEsc = sd.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      // 复用 exists 的 FOLDER/FILE 判定：FILE = 文件，FOLDER/"" = 非文件
      var es =
        'var d=new Folder("' + sdEsc + '");' +
        'if(d.exists){"FOLDER"}' +
        'else{var f=new File("' + sdEsc + '");' +
        '(f.exists?"FILE":"");}';
      var timeout = setTimeout(function () {
        _lastError = 'isFile ExtendScript 超时 (5s): ' + path;
        console.warn('[AEFS] ' + _lastError);
        resolve(false);
      }, 5000);
      try {
        new CSInterface().evalScript(es, function (result) {
          clearTimeout(timeout);
          resolve(result === 'FILE');
        });
      } catch (e) {
        clearTimeout(timeout);
        console.warn('[AEFS] isFile 异常: ' + path + ' ' + e);
        resolve(false);
      }
    });
  }

  /**
   * 探测路径**本身**是否为链接（symlink/junction）并取回其真实目标。
  * delete/rmdir/rename 作用于 realpath 目标，面板在删除/
   * 重命名前需要这条事实来做显式提示（探测只是提示依据，不改操作语义）。
   * 仅 Bridge 通道（/fs/is-link，只读）——ExtendScript 的 Folder/File 跟随链接、无
   * lstat 原语，判定不了"条目本身是链接"，故不做 ES 回退。
   * 失败语义：探得 { isLink, realpath }；Bridge 不可用/通道失败/4xx 真拒绝/旧版 bridge
   * 无此端点 → null（调用方按「探不到」放行既有流程：提示通道故障不阻断删除/重命名）。
   * @param {string} path — 绝对路径
   * @returns {Promise<{isLink: boolean, realpath: string|null}|null>}
   */
  function isLinkAsync(path) {
    if (!_checkPath(path)) return Promise.resolve(null);
    if (_bridgeOk() && typeof Bridge.isLinkAsync === 'function') {
      var _bp = Bridge.isLinkAsync(_toWin(path));
      return _bp.then(function (r) {
        if (r && typeof r.isLink === 'boolean') return r;
        return null;
      }, function () { return null; });
    }
    return Promise.resolve(null);
  }

  /**
   * 真实路径探测（只读；桥 /fs/realpath）——消解 junction/symlink/
   * 8.3 短名/映射盘。迁移前用它判断「新旧数据根是不是同一物理目录 / 物理上互相嵌套」。
   * 行为：junction 归一成真实目录；不存在的路径原样返回。
   * 失败语义：Bridge 不可用 / 通道失败 / 4xx 真拒绝（逃逸/敏感凭据）/ 旧版 bridge 无此端点
   * → null（调用方按「探不到」放行既有流程，不阻断迁移）。
   * @param {string} path — 绝对路径
   * @returns {Promise<string|null>}
   */
  function realpathAsync(path) {
    if (!_checkPath(path)) return Promise.resolve(null);
    if (_bridgeOk() && typeof Bridge.realpathAsync === 'function') {
      var _bp = Bridge.realpathAsync(_toWin(path));
      return _bp.then(function (rp) {
        return (typeof rp === 'string' && rp) ? rp : null;
      }, function () { return null; });
    }
    return Promise.resolve(null);
  }

  /**
   * 目录是否为空。① Bridge（listFiles 判空）→ ② ExtendScript
   * @param {string} dirPath — 绝对目录路径
   * @returns {Promise<boolean>}
   */
  function isEmptyDir(dirPath) {
    if (!_checkPath(dirPath)) return Promise.resolve(true);
    if (_bridgeOk()) {
      // 判空不得把「被拒」折叠成「空」——原 Promise.all([listFiles, listDirs])
      // 对 4xx 真拒绝（symlink 逃逸 403/敏感路径 403）只能拿到 []（公开版折叠），
      // 被拒目录被误判「空目录」。改经 _listViaBridgeAsync 拿 per-seq 拒绝记录：
      // 任一被拒时保守报非空（false）并记 _lastError 留痕（调用方不把被拒目录当
      // 空目录处理）；通道失败仍经公开链（含 cep.fs/ExtendScript 回退）判空。
      // Bridge 无异步 list 能力（旧版/测试 mock）时保持原 listFiles/listDirs 判定
      if (typeof Bridge.listFilesAsync === 'function' && typeof Bridge.listDirsAsync === 'function') {
        return Promise.all([
          _listViaBridgeAsync(dirPath, 'files'),
          _listViaBridgeAsync(dirPath, 'dirs')
        ]).then(function (r) {
          var rej = r[0].rejected || r[1].rejected;
          if (rej) {
            _lastError = 'isEmptyDir Bridge 拒绝 (HTTP ' + rej + '): ' + dirPath;
            console.warn('[AEFS] ' + _lastError);
            return false;  // 被拒 ≠ 空：保守报非空（方向安全，不误导「可安全覆写」类决策）
          }
          // names===null = 通道失败（见 _listViaBridgeAsync 注释）——经公开链
          // （listFiles/listDirs 内部含 cep.fs/ExtendScript 回退）复核判空，不得对 null 取
          // .length；names===[] 是 bridge 权威空答案，直接参与判空
          if (r[0].names === null || r[1].names === null) {
            return Promise.all([listFiles(dirPath), listDirs(dirPath)]).then(function (rr) {
              return rr[0].length === 0 && rr[1].length === 0;
            });
          }
          return r[0].names.length === 0 && r[1].names.length === 0;
        });
      }
      // 用已异步化的 listFiles/listDirs（内部走 Bridge 异步通道，不阻塞主线程）
      return Promise.all([listFiles(dirPath), listDirs(dirPath)]).then(function (r) {
        return r[0].length === 0 && r[1].length === 0;
      });
    }
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = 'isEmptyDir ExtendScript 不可用 (CSInterface 未定义): ' + dirPath;
        console.warn('[AEFS] ' + _lastError);
        return resolve(true);
      }
      var sd = _toFwd(dirPath);
      if (!sd) return resolve(true);
      // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，路径未转义会让整条 evalScript 解析失败
      // （对齐同文件其余 11 处拼接写法——仅转义引号时，路径含该字符时
      // ES 失败被吞成误判空目录）
      var sdEsc = sd.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      var es =
        'var d=new Folder("' + sdEsc + '");' +
        'if(!d.exists){"";}else{' +
        'var subs=d.getFiles();' +
        '(subs.length>0?"NOT_EMPTY":"EMPTY");}';
      var timeout = setTimeout(function () {
        _lastError = 'isEmptyDir ExtendScript 超时 (5s): ' + dirPath;
        console.warn('[AEFS] ' + _lastError);
        resolve(true);
      }, 5000);
      try {
        new CSInterface().evalScript(es, function (result) {
          clearTimeout(timeout);
          resolve(result !== 'NOT_EMPTY');
        });
      } catch (e) {
        clearTimeout(timeout);
        console.warn('[AEFS] isEmptyDir 异常: ' + dirPath + ' ' + e);
        resolve(true);
      }
    });
  }

  /**
   * 读取文件/目录元信息（agent 图片孤儿清理、comfyui 产物上限清理与
   * 两处 24h 临时清理均依赖 mtimeMs）。
   * ① cep.fs.stat → ② ExtendScript（File/Folder.modified）。Bridge 侧无 stat 路由封装
   * （bridge-server FS_METHODS 未含），故不走 Bridge 通道。
   * 只读操作：仅过 _checkPath（对齐 isFile，不走 _safeForDelete/_depthOk）。
   * @param {string} path — 绝对路径
   * @returns {Promise<{mtimeMs:number, size:number, isFile:boolean}|null>}
   *          成功 resolve 元信息对象；不存在/失败 resolve(null)，永不 reject（对齐其它异步 API 契约）
   */
  // CEP 10 的 window.cep.fs.stat 真机形态（CDP 直连面板实测）：
  //   data = { isFile: <function>, isDirectory: <function>, mtime: <Date> }
  // 与 CEP 文档式 { mtimeMs, size, isFile: boolean } 都不一样：
  //   · mtime 是 Date 对象 —— 只认 typeof number/ISO 串会让真机 mtimeMs 恒 0；
  //   · isFile/isDirectory 是**函数**（CEPEngine 原语）——!!(st.data.isFile)
  //     恒 true（目录也被判成文件，靠"是文件"的调用方全部失真）；
  //   · 没有 size 字段（AEFS.stat().size 恒 0——diagLog 已按实读长度判超限，不依赖它）。
  // mtimeMs 恒 0 的后果：一切"按龄"判定静默失效——temp/transcoded 转码缓存清扫报
  // noAge=2 一个都不删、comfyui 三处清理（grid/nodegen 24h、产物上限 48h 豁免窗）
  // 全部 `if (!st.mtimeMs) continue` 跳过。故此处把三种形态都认下来，取不到年龄
  // 不再回 mtimeMs:0 的"成功"，一律下落 ES 复核（拿不到就是 CHANNEL_FAILURE，
  // 调用方按"未知 → 保护跳过"处理，而不是"年龄 0 → 当作过期"）。
  function _cepMtimeMs(d) {
    if (!d) return 0;
    if (typeof d.mtimeMs === 'number' && d.mtimeMs > 0) return d.mtimeMs;
    var t = d.mtime;
    if (t && typeof t.getTime === 'function') {           // CEP 真机：Date
      var ms = t.getTime();
      return (isFinite(ms) && ms > 0) ? ms : 0;
    }
    if (typeof t === 'number' && t > 0) {                 // 秒级值（<1e12）归一到毫秒
      return (t < 1e12) ? t * 1000 : t;
    }
    if (typeof t === 'string' && t) {                     // ISO 串（部分运行时/历史形态）
      var p = Date.parse(t);
      return (isFinite(p) && p > 0) ? p : 0;
    }
    return 0;
  }
  function _cepBool(v) {
    // 函数式原语（CEP 真机）要**调用**取结果；抛异常按"取不到"记 false——
    // 不能落到 !!v（函数恒真，isFile 又会得到失真的值）
    if (typeof v === 'function') { try { return !!v(); } catch (_) { return false; } }
    return !!v;
  }

  // stat 的 Result 版（通道故障→null 被
  // 调用方当 missing 标记）。三态：ok({mtimeMs,size,isFile})=读得；
  // NOT_FOUND=ES 脚本权威探测 File/Folder 均不存在（脚本本就有 'NOT_FOUND'
  // 协议——与其他失败一同折叠 null，调用方无从区分「文件没了」与
  //「拿不到」）；CHANNEL_FAILURE=CSInterface 不可用/超时/异常回值（拿不到）；
  // REJECTED=路径校验/敏感路径入口拒（存在性 oracle 防护保留）。
  // cep.fs.stat 失败仍下落 ES 复核（既有回退链），最终判定权归 ES。
  function statResult(path) {
    if (!_checkPath(path)) return Promise.resolve(_resultErr(RESULT_CODES.REJECTED, 'stat 路径校验拒绝: ' + path, null));
    // 敏感路径入口即拒（对齐 exists 模式）——stat 可探出敏感文件
    // mtime/size（存在性 oracle），且 _statES 回退会经 ExtendScript 触碰同一目标
    if (_isSensitivePath(path)) { _lastError = '安全拒绝: 敏感路径 — ' + path; console.warn('[AEFS] ' + _lastError); return Promise.resolve(_resultErr(RESULT_CODES.REJECTED, _lastError, null)); }
    if (_hasCepFs() && typeof window.cep.fs.stat === 'function') {
      try {
        var st = window.cep.fs.stat(_toWin(path));
        if (st && !st.err && st.data) {
          var mtimeMs = _cepMtimeMs(st.data);
          if (mtimeMs > 0) {
            return Promise.resolve(_resultOk({
              mtimeMs: mtimeMs,
              size: (typeof st.data.size === 'number') ? st.data.size : 0,
              isFile: _cepBool(st.data.isFile)
            }));
          }
          // 拿不到年龄 → 不当作"年龄 0 的成功"，下落 ES 复核（见上方 _cepMtimeMs 注释）
        }
      } catch (e) {
        console.warn('[AEFS] stat cep.fs 异常: ' + path + ' ' + e);
      }
      // cep.fs.stat 失败（err 非 0 / 返回结构异常 / 给不出 mtime）：回退 ExtendScript 复核
      return _statESResult(path);
    }
    return _statESResult(path);
  }

  // stat 薄适配层：内部调 Result 版，折叠回 {…}|null——旧调用方零改动。
  // 折叠规则：ok → data；NOT_FOUND/CHANNEL_FAILURE/REJECTED 任一失败态 → null
  //（兼容既有调用方：所有失败路径均 resolve(null)）
  function stat(path) {
    return statResult(path).then(function (r) { return r.ok === true ? r.data : null; });
  }

  // stat 的 ExtendScript 回退通道（Result 版；cep.fs.stat 不可用或失败时）
  function _statESResult(path) {
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = 'stat ExtendScript 不可用 (CSInterface 未定义): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastError, 'extendscript'));
      }
      var sd = _toFwd(path);
      if (!sd) return resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, 'stat 路径归一失败: ' + path, null));
      // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，路径未转义会让整条 evalScript 解析失败
      var sdEsc = sd.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      // File.modified 是 Date：ES 侧直接取 getTime()（毫秒）转字符串回传；
      // 目录（File 不存在而 Folder 存在）走 Folder.modified 兜底，size 记 0
      var es =
        'var f=new File("' + sdEsc + '");' +
        'if(f.exists){(f.modified?f.modified.getTime():0)+","+f.length+",1";}' +
        'else{var d=new Folder("' + sdEsc + '");' +
        'if(d.exists){(d.modified?d.modified.getTime():0)+",0,0";}' +
        'else{"NOT_FOUND";}}';
      var timeout = setTimeout(function () {
        _lastError = 'stat ExtendScript 超时 (5s): ' + path;
        console.warn('[AEFS] ' + _lastError);
        resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastError, 'extendscript'));
      }, 5000);
      try {
        new CSInterface().evalScript(es, function (result) {
          clearTimeout(timeout);
          if (result === 'NOT_FOUND') {
            // ES 权威探测完成：File 与 Folder 均不存在（真没有——折叠 null
            // 与通道故障不可分，调用方把两者都当 missing 标记）
            return resolve(_resultErr(RESULT_CODES.NOT_FOUND, 'stat 探测完成，目标不存在: ' + path, 'extendscript'));
          }
          if (!result || result === 'EvalScript error.') {
            _lastError = 'stat ExtendScript 异常返回 (' + String(result) + '): ' + path;
            console.warn('[AEFS] ' + _lastError);
            return resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastError, 'extendscript'));
          }
          // "mtimeMs,size,isFile" 三段逗号串：非此形态（异常回值）一律按通道故障
          var parts = result.split(',');
          if (parts.length !== 3) {
            _lastError = 'stat ExtendScript 回值形态异常 (' + String(result).slice(0, 50) + '): ' + path;
            console.warn('[AEFS] ' + _lastError);
            return resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastError, 'extendscript'));
          }
          var mtimeMs = parseInt(parts[0], 10);
          var size = parseInt(parts[1], 10);
          if (isNaN(mtimeMs) || isNaN(size)) {
            _lastError = 'stat ExtendScript 回值数值异常: ' + path;
            console.warn('[AEFS] ' + _lastError);
            return resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, _lastError, 'extendscript'));
          }
          resolve(_resultOk({ mtimeMs: mtimeMs, size: size, isFile: parts[2] === '1' }));
        });
      } catch (e) {
        clearTimeout(timeout);
        console.warn('[AEFS] stat 异常: ' + path + ' ' + e);
        resolve(_resultErr(RESULT_CODES.CHANNEL_FAILURE, 'stat 异常: ' + path + ' ' + e, 'extendscript'));
      }
    });
  }

  // ====== scanTree: 递归目录树扫描（过 _checkPath + ExtendScript String.fromCharCode 防注入）======
  function scanTree(dirPath, maxDepth) {
    if (!_checkPath(dirPath)) return Promise.resolve(null);
    // 敏感路径入口即拒——scanTree 扫 .ssh/.aws 等敏感目录可枚举出全部密钥文件名
    if (_isSensitivePath(dirPath)) { _lastError = '安全拒绝: 敏感路径 — ' + dirPath; console.warn('[AEFS] ' + _lastError); return Promise.resolve(null); }
    if (typeof maxDepth !== 'number' || maxDepth < 0) maxDepth = 20;
    maxDepth = Math.floor(maxDepth);
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = 'scanTree ExtendScript 不可用 (CSInterface 未定义): ' + dirPath;
        console.warn('[AEFS] ' + _lastError);
        return resolve(null);
      }
      var sd = _toFwd(dirPath);
      if (!sd) return resolve(null);
      var codes = [];
      for (var i = 0; i < sd.length; i++) { codes.push(sd.charCodeAt(i)); }
      var sdEsc = 'String.fromCharCode(' + codes.join(',') + ')';
      var es =
        '(function(){' +
        // decodeURI 包 try/catch——文件/目录名含裸 % 时 decodeURI 抛
        // URIError，整棵树扫描失败折叠为 null（脚本树空白）。降级返回原名
        'function dn(x){try{return decodeURI(x);}catch(e){return x;}}' +
        'function isAliasSub(f){try{return f.alias||false;}catch(e){return false;}}' +
        'function walk(folder,depth,maxDepth){' +
        'if(depth>maxDepth)return"DEPTH_LIMIT";' +
        'var out={n:dn(folder.displayName),p:folder.fsName,d:[],f:[],nf:0};' +
        'var subs=folder.getFiles();' +
        'for(var i=0;i<subs.length;i++){' +
        'var s=subs[i];' +
        'if(s instanceof Folder){' +
        'if(!isAliasSub(s)){var child=walk(s,depth+1,maxDepth);if(typeof child==="object")out.d.push(child);}' +
        '}else if(s instanceof File){' +
        'var nm=s.name.toLowerCase();' +
        'if(nm.indexOf(".jsx")===nm.length-4||nm.indexOf(".jsxbin")===nm.length-7){out.f.push({n:dn(s.displayName),p:s.fsName});}else{out.nf++;}' +
        '}}' +
        'return out;' +
        '}' +
        'var d=new Folder(' + sdEsc + ');' +
        'if(!d.exists)return"__NO_DIR__";' +
        'var tree=JSON.stringify(walk(d,0,' + maxDepth + '));' +
        'var codes=[];' +
        'for(var k=0;k<tree.length;k++)codes.push(tree.charCodeAt(k));' +
        'return"CHARCODES:"+codes.join(",");' +
        '})();';
      var timeout = setTimeout(function () {
        _lastError = 'scanTree ExtendScript 超时 (10s): ' + dirPath;
        console.warn('[AEFS] ' + _lastError);
        resolve(null);
      }, 10000);
      try {
        new CSInterface().evalScript(es, function (result) {
          clearTimeout(timeout);
          if (!result || result === '__NO_DIR__') return resolve(null);
          if (result.indexOf('CHARCODES:') !== 0) return resolve(null);
          try {
            var chars = result.slice('CHARCODES:'.length).split(',');
            var json = '';
            for (var k = 0; k < chars.length; k++) {
              json += String.fromCharCode(parseInt(chars[k], 10));
            }
            resolve(JSON.parse(json));
          } catch (_) { resolve(null); }
        });
      } catch (e) {
        clearTimeout(timeout);
        console.warn('[AEFS] scanTree 异常: ' + dirPath + ' ' + e);
        resolve(null);
      }
    });
  }

  // ====== fileSize: 文件大小（过 _checkPath + ExtendScript String.fromCharCode 防注入）======
  function fileSize(path) {
    if (!_checkPath(path)) return Promise.resolve(-1);
    // 敏感路径入口即拒——fileSize 可探出敏感文件存在性与大小（存在性 oracle）
    if (_isSensitivePath(path)) { _lastError = '安全拒绝: 敏感路径 — ' + path; console.warn('[AEFS] ' + _lastError); return Promise.resolve(-1); }
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = 'fileSize ExtendScript 不可用 (CSInterface 未定义): ' + path;
        console.warn('[AEFS] ' + _lastError);
        return resolve(-1);
      }
      var sd = _toFwd(path);
      if (!sd) return resolve(-1);
      var codes = [];
      for (var i = 0; i < sd.length; i++) { codes.push(sd.charCodeAt(i)); }
      var sdEsc = 'String.fromCharCode(' + codes.join(',') + ')';
      var es =
        'var f=new File(' + sdEsc + ');' +
        '(f.exists?String(f.length):"-1");';
      var timeout = setTimeout(function () {
        _lastError = 'fileSize ExtendScript 超时 (5s): ' + path;
        console.warn('[AEFS] ' + _lastError);
        resolve(-1);
      }, 5000);
      try {
        new CSInterface().evalScript(es, function (result) {
          clearTimeout(timeout);
          var n = parseInt(String(result || ''), 10);
          resolve(isNaN(n) ? -1 : n);
        });
      } catch (e) {
        clearTimeout(timeout);
        console.warn('[AEFS] fileSize 异常: ' + path + ' ' + e);
        resolve(-1);
      }
    });
  }

  function rmdir(dirPath) {
    if (!_checkPath(dirPath)) return Promise.resolve(false);
    if (!_safeForDelete(dirPath)) return Promise.resolve(false);
    if (!_depthOk(dirPath, 2)) return Promise.resolve(false);
    if (_bridgeOk() && typeof Bridge.rmdirAsync === 'function') {
      // 异步 XHR，不阻塞主线程；Bridge 不可用/失败时走 _rmdirFallback
      // 捕获 promise 经 per-seq 二分（并发同 method 不交叉污染）
      var _bp = Bridge.rmdirAsync(_toWin(dirPath));
      return _bp.then(function (bOk) {
        if (bOk) return true;
        // Bridge 4xx「真拒绝」（403 symlink 逃逸/命名空间/深度不足、
        // 400 非空或不存在）→ 明确失败不回退 ExtendScript——回退链的 Folder.remove()
        // 会绕过 bridge 防护对逃逸目标操作（非空/不存在场景 ES 回退同样 false，行为等价）。
        // 网络异常/5xx（无拒绝记录）仍照旧回退
        var _rej = _bridgeAsyncRejection('rmdir', _bp);
        if (_rej) {
          _lastError = 'rmdir Bridge 拒绝 (HTTP ' + _rej.status + '): ' + dirPath;
          console.warn('[AEFS] ' + _lastError);
          return false;
        }
        return _rmdirFallback(dirPath);
      });
    }
    return _rmdirFallback(dirPath);
  }

  // rmdir 的 ExtendScript 回退通道（Bridge 不可用或 Bridge 失败时）
  function _rmdirFallback(dirPath) {
    // ExtendScript 回退：Folder.remove() 只删空目录
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = 'rmdir ExtendScript 不可用 (CSInterface 未定义): ' + dirPath;
        console.warn('[AEFS] ' + _lastError);
        return resolve(false);
      }
      var sd = _toFwd(dirPath);
      // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，路径未转义会让整条 evalScript 解析失败
      var sdEsc = sd.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      var timeout = setTimeout(function () {
        _lastError = 'rmdir ExtendScript 超时 (5s): ' + dirPath;
        console.warn('[AEFS] ' + _lastError);
        resolve(false);
      }, 5000);
      try {
        new CSInterface().evalScript(
          'var d=new Folder("' + sdEsc + '");(d.exists?d.remove():false);',
          function (result) { clearTimeout(timeout); resolve(result === true || result === 'true'); }
        );
      } catch (_) { clearTimeout(timeout); resolve(false); }
    });
  }

  /**
   * ⚠️ 危险文件管理函数：递归删除整棵目录树（含所有内容）。
   * 最后防线：优先移到 Windows 回收站（可恢复），失败需用户确认才物理删除。
   * 文件数 >50 时需用户确认。
   *
   * 安全校验链（与 rmdir/deleteFile 对齐，修改时必须保持一致）：
   *   _checkPath(格式：拒 %/控制符/引号/..段/非绝对路径/DOS 设备名)
   *   → _safeForDelete(白名单命名空间 + 拒系统目录)
   *   → _depthOk(2)(深度≥2，防删浅层目录)
   *   → Bridge 端再过 safePath + safeForDelete + minDepthOk(2) + resolveRealSafe(symlink逃逸)
   * 使用或修改前必须仔细检查上述校验链是否完整，任何一道缺失都可能导致误删用户数据。
   *
   * 三阶段流程（配合 bridge-server 端点）：
   *   ① 后端返回 needCountConfirm（>50 文件）→ showConfirm 弹窗 → 带 forceCountConfirm 重调
   *   ② 后端返回 needPermanentConfirm（回收站失败）→ showConfirm 弹窗 → 带 permanent 重调
   *   ③ 用户取消 → 抛 {code:'CANCELLED'} 异常（调用方须 catch 并跳过逐个删除回退，
   *      否则取消会被误判为"技术故障"导致回退物理删除，违背用户意图）
   *
   * Bridge 不可用时回退到 _removeDirRecursiveFallback（逐个 deleteFile + rmdir，无回收站保护）。
   *
   * @param {string} dirPath — 目录绝对路径
 * @param {{preConfirmed?: boolean}} [opts] — preConfirmed: 调用方（数据目录覆盖栈，-）
   *   已在自己的确认弹窗里告知「先删除、优先回收站、无法回收则永久删除、不可恢复」并获
   *   用户确认 → 本函数不再二次弹窗（文件数确认/永久删除确认/Bridge 不可用确认），直接
   *   执行并在日志留痕；其余调用方不传（保持逐级弹窗的既有语义）。删除失败仍返回 false。
   * @returns {Promise<boolean>}
   */
  function removeDirRecursive(dirPath, opts) {
    if (!_checkPath(dirPath)) return Promise.resolve(false);
    if (!_safeForDelete(dirPath)) return Promise.resolve(false);
    if (!_depthOk(dirPath, 2)) return Promise.resolve(false);
    var preConfirmed = !!(opts && opts.preConfirmed === true);
    if (!_bridgeOk()) {
      // Bridge 不可用 → 回退逐个删除（无回收站保护，降级模式）
      return _removeDirRecursiveFallback(dirPath, { preConfirmed: preConfirmed });
    }
    return _removeDirRecursiveWithConfirm(dirPath, { preConfirmed: preConfirmed });
  }

  // removeDirRecursive 的回收站 + 弹窗流程（Bridge 可用时）。
  // 三阶段协议（配合 bridge-server 端点）：
  //   ① 后端返回 needCountConfirm → 弹窗 → 带 forceCountConfirm 重调
  //   ② 后端返回 needPermanentConfirm → 弹窗 → 带 permanent 重调
  //   ③ 用户取消 → 抛 {code:'CANCELLED'} 异常（调用方 catch 后跳过逐个删除回退）
  function _removeDirRecursiveWithConfirm(dirPath, opts) {
    var winPath = _toWin(dirPath);
    var preConfirmed = !!(opts && opts.preConfirmed === true);
    if (preConfirmed) console.warn('[AEFS] removeDirRecursive preConfirmed：调用方已确认整份删除，跳过二次弹窗: ' + dirPath);
    // 阶段 1: 首次调用（无特殊参数；preConfirmed 时带 forceCountConfirm，跳过 >50 文件弹窗）。
    // 异步 XHR，不阻塞主线程；失败时 resolve(null，非用户取消）→ 回退逐个删除
    // 捕获 promise 经 per-seq 二分（并发同 method 不交叉污染）
    var _bp = Bridge.removeDirRecursiveAsync(winPath, preConfirmed ? { forceCountConfirm: true } : {});
    return _bp.then(function (r) {
      if (!r) {
        // Bridge 4xx「真拒绝」（403 symlink 逃逸/命名空间/深度不足）→ 不回退
        // 逐个删除（回退是无回收站保护的物理删除，会绕过 bridge 防护）；通道失败
        // （网络异常/5xx，无拒绝记录）照旧回退降级链
        var _rej = _bridgeAsyncRejection('remove-dir-recursive', _bp);
        if (_rej) {
          _lastError = 'removeDirRecursive Bridge 拒绝 (HTTP ' + _rej.status + '): ' + dirPath;
          console.warn('[AEFS] ' + _lastError);
          return false;
        }
        return _removeDirRecursiveFallback(dirPath);
      }
      if (r.ok) return true;

      // 阶段 2: 文件数 >50 预检（大量文件删除，属危险操作 → 红色危险弹窗）。
      // preConfirmed：调用方已确认整份删除 → 不再追问，直接带 forceCountConfirm 重调
      if (r.needCountConfirm) {
        var _countGate = preConfirmed
          ? Promise.resolve(true)
          : _rmDirConfirm('删除确认', '将删除 ' + r.count + ' 个文件，确认删除？', 'warn', true);
        return _countGate.then(function (ok) {
          if (!ok) throw _cancelledError();  // 用户取消 → 抛异常阻止调用方回退物理删除
          // 带 forceCountConfirm 重调（异步）；promise 透传给下游二分
          var _bp2 = Bridge.removeDirRecursiveAsync(winPath, { forceCountConfirm: true });
          return _bp2.then(function (r2) {
            return _rmDirHandlePermanent(winPath, r2, dirPath, _bp2, opts);
          });
        });
      }

      // 无文件数预检（≤50 文件）→ 直接处理结果（可能是 needPermanentConfirm）
      return _rmDirHandlePermanent(winPath, r, dirPath, _bp, opts);
    });
  }

  // 处理 needPermanentConfirm 分支（回收站失败 → 永久删除确认）或最终结果。
  // r 为 Bridge 响应对象；r 为 null 时表示 Bridge 调用失败 → 回退逐个删除。
  // bp: 产出 r 的 Bridge 调用 promise，per-seq 拒绝二分用
  function _rmDirHandlePermanent(winPath, r, originalDirPath, bp, opts) {
    var preConfirmed = !!(opts && opts.preConfirmed === true);
    if (!r) {
      // Bridge 4xx「真拒绝」（确认后的 forceCountConfirm/permanent 重调同样
      // 可能被安全拒绝）→ 不回退逐个删除（无回收站保护的物理删除会绕过 bridge 防护）；
      // 通道失败（无拒绝记录）照旧回退降级链
      var _rej = _bridgeAsyncRejection('remove-dir-recursive', bp);
      if (_rej) {
        _lastError = 'removeDirRecursive Bridge 拒绝 (HTTP ' + _rej.status + '): ' + originalDirPath;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
      // Bridge 调用失败 → 回退逐个删除
      return _removeDirRecursiveFallback(originalDirPath, opts);
    }
    if (r.ok) return Promise.resolve(true);
    if (r.needPermanentConfirm) {
      // 回收站失败 → 永久删除（无法恢复，属危险操作 → 红色危险弹窗）。
      // preConfirmed：调用方确认弹窗已明示「无法移入回收站时将永久删除」→ 不再二次弹窗
      if (preConfirmed) console.warn('[AEFS] removeDirRecursive preConfirmed：回收站不可用，按确认直接永久删除: ' + originalDirPath + ' — ' + (r.reason || ''));
      var _permGate = preConfirmed
        ? Promise.resolve(true)
        : _rmDirConfirm('无法移到回收站',
            '无法移动到回收站（' + (r.reason || '原因未知') + '），是否永久删除？',
            'warn', true);
      return _permGate.then(function (ok) {
        if (!ok) throw _cancelledError();  // 用户取消 → 抛异常阻止调用方回退物理删除
        // 带 permanent 重调（异步）
        return Bridge.removeDirRecursiveAsync(winPath, { permanent: true }).then(function (r2) {
          if (!r2 || !r2.ok) {
            _lastError = 'removeDirRecursive 永久删除失败: ' + (r2 && r2.error ? r2.error : 'unknown');
            console.warn('[AEFS] ' + _lastError);
            return false;
          }
          return true;
        });
      });
    }
    _lastError = 'removeDirRecursive 失败: ' + (r.error || JSON.stringify(r));
    console.warn('[AEFS] ' + _lastError);
    return Promise.resolve(false);
  }

  // 用户取消专用异常工厂。调用方通过 e.code === 'CANCELLED' 识别。
  // 不可用 null/undefined（无法区分），不可用纯字符串（无 code 属性）。
  function _cancelledError() {
    var e = new Error('USER_CANCELLED');
    e.code = 'CANCELLED';
    return e;
  }

  // 确认弹窗封装（带 fallback，防 global.showConfirm 未定义）。
  // isDanger=true 时走 showConfirm 的 'danger' 枚举（红色危险弹窗），否则走普通 confirm。
  // 符合项目约定：typeof 检查 + fallback。
  function _rmDirConfirm(title, message, tone, isDanger) {
    return new Promise(function (resolve) {
      var confirmFn = (typeof global !== 'undefined' && typeof global.showConfirm === 'function')
        ? global.showConfirm
        : (typeof showConfirm === 'function' ? showConfirm : null);
      if (!confirmFn) {
        _lastError = 'removeDirRecursive 确认弹窗不可用';
        console.warn('[AEFS] ' + _lastError);
        return resolve(false);
      }
      // danger 枚举需传 type 参数，普通确认传 tone（音效）
      confirmFn(title, message, isDanger ? 'danger' : tone).then(resolve).catch(function () { resolve(false); });
    });
  }

  // removeDirRecursive 的 Bridge 不可用回退：逐个 deleteFile + rmdir，无回收站保护。
  // Bridge 不可用时删除不可恢复，首次调用弹阻断确认告知用户；递归调用直接执行（走 inner）。
  // 用户取消 → 抛 {code:'CANCELLED'}（对齐 removeDirRecursive 文档契约与
  // _removeDirRecursiveWithConfirm 的 needCountConfirm/needPermanentConfirm 分支）。
  function _removeDirRecursiveFallback(dirPath, opts) {
    var preConfirmed = !!(opts && opts.preConfirmed === true);
    if (preConfirmed) {
      // preConfirmed：调用方确认弹窗已明示删除不可恢复 → 不再二次弹窗，直接物理删除（留痕）
      console.warn('[AEFS] removeDirRecursive preConfirmed：Bridge 不可用，按确认直接物理删除: ' + dirPath);
      return _removeDirRecursiveFallbackInner(dirPath);
    }
    // Bridge 不可用 → 物理删除不可恢复，属最高危险操作 → 红色危险弹窗
    return _rmDirConfirm('Bridge 不可用 - 删除不可恢复',
      'Bridge 服务不可用，无法移到回收站。\n将直接物理删除目录及所有内容，此操作不可恢复。\n\n路径: ' + _toFwd(dirPath) + '\n\n确认继续删除？',
      'warn', true).then(function (ok) {
      if (!ok) {
        // 取消信号必须以 CANCELLED 异常上抛，不得 resolve(false)——调用方
        //（projectAssetStore._removeDir / presetStore.removeFolder）按契约只 catch
        // CANCELLED 来阻止"逐个 deleteFile 物理删除"回退；resolve(false) 会被当作
        // 技术故障落入回退链，用户取消后目录仍被逐文件删除（数据丢失）
        _lastError = 'removeDirRecursive 用户取消（Bridge 不可用回退确认）: ' + dirPath;
        console.warn('[AEFS] ' + _lastError);
        throw _cancelledError();
      }
      return _removeDirRecursiveFallbackInner(dirPath);
    });
  }

  // _removeDirRecursiveFallback 的实际递归删除逻辑（无确认弹窗，供外层确认后调用 + 递归自调用）
  function _removeDirRecursiveFallbackInner(dirPath) {
    var fwd = _toFwd(dirPath);
    return listFiles(fwd).then(function (files) {
      if (!Array.isArray(files)) files = [];
      var p = Promise.resolve();
      for (var i = 0; i < files.length; i++) {
        (function (fp) {
          p = p.then(function () { return deleteFile(fp); });
        })(fwd + '/' + files[i]);
      }
      return p;
    }).then(function () {
      return listDirs(fwd);
    }).then(function (subDirs) {
      if (!Array.isArray(subDirs)) subDirs = [];
      var p = Promise.resolve();
      for (var d = 0; d < subDirs.length; d++) {
        (function (sp) {
          p = p.then(function () { return _removeDirRecursiveFallbackInner(sp); });
        })(fwd + '/' + subDirs[d]);
      }
      return p;
    }).then(function () {
      return rmdir(fwd);
    }).catch(function () {
      return false;
    });
  }

  /**
   * 复制文件（二进制安全）。① Bridge (fs.copyFileSync) → ② ExtendScript (File.copy)
   *
   * 安全：src 和 dst 均需过 _checkPath；src 过 _isSensitivePath（读语义）；dst 过 _safeForDelete（覆盖等价于删旧数据）。
   * @param {string} srcPath — 源文件绝对路径
   * @param {string} dstPath — 目标文件绝对路径
   * @returns {Promise<boolean>}
   */
  function copyFile(srcPath, dstPath) {
    if (!_checkPath(srcPath)) return Promise.resolve(false);
    if (!_checkPath(dstPath)) return Promise.resolve(false);
    // src 是读语义：敏感路径入口即拒（与 readFile 同口径），否则可把 .ssh/id_rsa 拷到
    // 数据目录再用 readFile 读出（dst 文件名非敏感名，读侧防线拦不住）
    if (_isSensitivePath(srcPath)) { _lastError = '安全拒绝: 敏感路径 — ' + srcPath; console.warn('[AEFS] ' + _lastError); return Promise.resolve(false); }
    if (!_safeForDelete(dstPath)) return Promise.resolve(false);
    if (_bridgeOk() && typeof Bridge.copyFileAsync === 'function') {
      // 异步 XHR，不阻塞主线程；Bridge 不可用/失败时走 _copyFileFallback
      // 捕获 promise 经 per-seq 二分（并发同 method 不交叉污染）
      var _bp = Bridge.copyFileAsync(_toWin(srcPath), _toWin(dstPath));
      return _bp.then(function (bOk) {
        if (bOk) return true;
        // Bridge 4xx「真拒绝」（403 symlink 逃逸/敏感路径/命名空间）→ 明确失败，
        // 不回退 ExtendScript——否则 File.copy 跟随 symlink 把私钥/凭据拷到数据目录
        //（dst 文件名非敏感名，读侧防线拦不住）。网络异常/5xx（无拒绝记录）仍照旧回退
        var _rej = _bridgeAsyncRejection('copy-file', _bp);
        if (_rej) {
          _lastError = 'copyFile Bridge 拒绝 (HTTP ' + _rej.status + '): ' + srcPath + ' → ' + dstPath;
          console.warn('[AEFS] ' + _lastError);
          return false;
        }
        return _copyFileFallback(srcPath, dstPath);
      });
    }
    return _copyFileFallback(srcPath, dstPath);
  }

  // copyFile 的 ExtendScript 回退通道（Bridge 不可用或 Bridge 返回 false 时）
  function _copyFileFallback(srcPath, dstPath) {
    // ExtendScript 回退：File.copy()
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = 'copyFile ExtendScript 不可用 (CSInterface 未定义): ' + srcPath + ' → ' + dstPath;
        console.warn('[AEFS] ' + _lastError);
        return resolve(false);
      }
      var sdSrc = _toFwd(srcPath);
      var sdDst = _toFwd(dstPath);
      var dstParent = sdDst.replace(/\/[^\/]+$/, '');
      // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，路径未转义会让整条 evalScript 解析失败
      var parentEsc = dstParent.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      var srcEsc = sdSrc.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      var dstEsc = sdDst.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
      var es =
        'var pd=new Folder("' + parentEsc + '");if(!pd.exists)pd.create();' +
        'var s=new File("' + srcEsc + '");' +
        'if(!s.exists)"NO_SRC";' +
        'else if(!s.copy("' + dstEsc + '"))"COPY_FAIL";' +
        'else"OK";';
      var timeout = setTimeout(function () {
        _lastError = 'copyFile ExtendScript 超时 (8s): ' + srcPath + ' → ' + dstPath;
        console.warn('[AEFS] ' + _lastError);
        resolve(false);
      }, 8000);
      try {
        new CSInterface().evalScript(es, function (result) {
          clearTimeout(timeout);
          resolve(result === 'OK');
        });
      } catch (_) { clearTimeout(timeout); resolve(false); }
    });
  }

  /**
   * 异步复制文件（二进制安全）。语义与 copyFile 一致：成功 true，失败 false。
   * 无后缀 copyFile 现已是真异步，copyFileAsync 保留为别名（兼容旧调用方）。
   * @param {string} srcPath — 源文件绝对路径
   * @param {string} dstPath — 目标文件绝对路径
   * @returns {Promise<boolean>}
   */
  function copyFileAsync(srcPath, dstPath) {
    return copyFile(srcPath, dstPath);
  }

  /**
   * 异步拷贝目录。语义与 copyDir 一致：全成功才 true。
   * 无后缀 copyDir 现已是真异步，copyDirAsync 保留为别名（兼容旧调用方）。
   * @param {string} srcDir — 源目录（绝对路径）
   * @param {string} dstDir — 目标目录（绝对路径）
   * @returns {Promise<boolean>} — 全成功才 true
   */
  function copyDirAsync(srcDir, dstDir) {
    return copyDir(srcDir, dstDir);
  }

  /**
   * 同步复制文件。① Bridge (fs.copyFileSync) → ② cep.fs (Base64 读 + Base64 写)
   * cep.fs 无 copy 接口，回退走 Base64 读源文件 → Base64 写目标文件。
   * 必须 cep.encoding.Base64 可用（CEP 6+ 标配），否则拒绝——避免文本模式损坏二进制。
   * 安全同异步版：_checkPath ×2 + _isSensitivePath(src) + _safeForDelete(dst)。
   * @param {string} srcPath
   * @param {string} dstPath
   * @returns {boolean}
   */
  function copyFileSync(srcPath, dstPath) {
    if (!_checkPath(srcPath)) return false;
    if (!_checkPath(dstPath)) return false;
    // src 是读语义：敏感路径入口即拒（与 readFileSync 同口径，含 cep.fs Base64 读源分支）
    if (_isSensitivePath(srcPath)) { _lastError = '安全拒绝: 敏感路径 — ' + srcPath; console.warn('[AEFS] ' + _lastError); return false; }
    if (!_safeForDelete(dstPath)) return false;
    var srcWin = _toWin(srcPath);
    var dstWin = _toWin(dstPath);
    // 同步族统一过 _bridgeOkSync 门禁（原 _bridgeOk() 会在半死桥下发同步 XHR）
    var bridgeAvailable = _bridgeOkSync();
    if (bridgeAvailable) {
      if (Bridge.copyFile(srcWin, dstWin)) return true;
      // Bridge 4xx「真拒绝」（403 symlink 逃逸/敏感路径/命名空间、400 非法路径）
      // → 明确失败不回退 cep.fs（对齐 writeFileSync 既有模式）——否则 cep.fs Base64
      // 读源会跟随 symlink 直读敏感目标，绕过 bridge 防护。
      // 网络异常/5xx（getLastSyncRejection 为 null）照旧回退 cep.fs Base64 通道
      var cpRej = (typeof Bridge.getLastSyncRejection === 'function') ? Bridge.getLastSyncRejection() : null;
      if (cpRej && cpRej.status) {
        _lastError = 'copyFileSync Bridge 拒绝 (HTTP ' + cpRej.status + '): ' + srcPath + ' → ' + dstPath;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
      // 401（token 轮换窗口）不回退 cep.fs Base64 链（本地直拷绕过 bridge 防护）
      var cpAuth = _bridgeSyncUnauthorized();
      if (cpAuth) {
        _lastError = 'copyFileSync Bridge 鉴权失败 (HTTP 401，token 轮换窗口): ' + srcPath + ' → ' + dstPath;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
    }
    // ② cep.fs 回退：Base64 读源 → Base64 写目标
    if (_canRead() && _canWrite()) {
      try {
        var cepEnc = (typeof window !== 'undefined' && window.cep && window.cep.encoding) || null;
        if (!cepEnc || !cepEnc.Base64) {
          _lastError = 'copyFileSync cep.encoding.Base64 不可用: ' + srcPath + ' → ' + dstPath;
          console.warn('[AEFS] ' + _lastError);
          return false;
        }
        var r = window.cep.fs.readFile(srcWin, cepEnc.Base64);
        if (!r || r.err !== 0 || typeof r.data !== 'string') {
          _lastError = 'copyFileSync cep.fs.readFile 失败: ' + srcPath + ' (err=' + (r && r.err) + ')';
          console.warn('[AEFS] ' + _lastError);
          return false;
        }
        // 父目录确保存在（与 writeFileSync 一致）
        if (_canMkdir()) {
          var mr = window.cep.fs.mkdir(_parentDir(dstWin));
          if (mr && mr.err !== undefined && mr.err !== 0) {
            _lastError = 'copyFileSync cep.fs.mkdir 父目录失败: ' + _parentDir(dstWin);
            console.warn('[AEFS] ' + _lastError);
            return false;
          }
        }
        var w = window.cep.fs.writeFile(dstWin, r.data, cepEnc.Base64);
        if (w && w.err === 0) return true;
        _lastError = 'copyFileSync cep.fs.writeFile 失败: ' + dstPath + ' (err=' + (w && w.err) + ')';
        console.warn('[AEFS] ' + _lastError);
        return false;
      } catch (_) {}
    }
    _lastError = 'copyFileSync 全部通道失败: ' + srcPath + ' → ' + dstPath + ' (Bridge=' + bridgeAvailable + ', cep.fs=' + (_canRead() && _canWrite()) + ')';
    console.warn('[AEFS] ' + _lastError);
    return false;
  }

  /**
   * 重命名文件（仅同目录，原子操作）。
   * ① Bridge (fs.renameSync) → ② ExtendScript (File.rename)
   *
   * 跨目录移动不是原子操作，调用方请用 copyFile + deleteFile 组合实现。
   * src 和 dst 必须在同一父目录下，否则返回 false。
   *
   * 安全：src 和 dst 均需过 _checkPath；src 过 _safeForDelete + _depthOk；
   *       dst 已存在（覆盖）时 dst 亦过 _safeForDelete + _depthOk（与 bridge rename 对齐）。
   * @param {string} srcPath — 源文件绝对路径
   * @param {string} dstPath — 目标文件绝对路径（必须同父目录）
   * @returns {Promise<boolean>}
   */
  function renameFile(srcPath, dstPath) {
    if (!_checkPath(srcPath)) return Promise.resolve(false);
    if (!_checkPath(dstPath)) return Promise.resolve(false);
    // 同目录校验
    var srcFwd = _toFwd(srcPath);
    var dstFwd = _toFwd(dstPath);
    var srcParent = srcFwd.replace(/\/[^\/]+$/, '');
    var dstParent = dstFwd.replace(/\/[^\/]+$/, '');
    if (srcParent.toLowerCase() !== dstParent.toLowerCase()) {
      console.warn('[AEFS] renameFile 拒跨目录: ' + srcParent + ' → ' + dstParent);
      return Promise.resolve(false);
    }
    if (!_safeForDelete(srcPath)) return Promise.resolve(false);
    if (!_depthOk(srcPath, 2)) return Promise.resolve(false);
    // dst 已存在（覆盖场景）= 删旧文件，需 dst 过 _safeForDelete + _depthOk（与 bridge rename 对齐）
    if (existsSync(dstPath)) {
      if (!_safeForDelete(dstPath)) return Promise.resolve(false);
      if (!_depthOk(dstPath, 2)) return Promise.resolve(false);
    }
    if (_bridgeOk() && typeof Bridge.renameFileAsync === 'function') {
      // 异步 XHR，不阻塞主线程；Bridge 不可用/失败时走 _renameFileFallback
      // 捕获 promise 经 per-seq 二分（并发同 method 不交叉污染）
      var _bp = Bridge.renameFileAsync(_toWin(srcPath), _toWin(dstPath));
      return _bp.then(function (bOk) {
        if (bOk) return true;
        // Bridge 4xx「真拒绝」（403 symlink 逃逸/命名空间/跨目录、400 非法路径）→
        // 明确失败不回退 ExtendScript——否则 File.rename 会完成 bridge 拒绝的操作。
        // 网络异常/5xx（无拒绝记录）仍照旧回退
        var _rej = _bridgeAsyncRejection('rename', _bp);
        if (_rej) {
          _lastError = 'renameFile Bridge 拒绝 (HTTP ' + _rej.status + '): ' + srcPath + ' → ' + dstPath;
          console.warn('[AEFS] ' + _lastError);
          return false;
        }
        return _renameFileFallback(srcPath, dstPath, dstFwd);
      });
    }
    return _renameFileFallback(srcPath, dstPath, dstFwd);
  }

  // renameFile 的 ExtendScript 回退通道（Bridge 不可用或 Bridge 失败时）
  function _renameFileFallback(srcPath, dstPath, dstFwd) {
    // ExtendScript 回退：File.rename(name) 同目录原子操作
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = 'renameFile ExtendScript 不可用 (CSInterface 未定义): ' + srcPath + ' → ' + dstPath;
        console.warn('[AEFS] ' + _lastError);
        return resolve(false);
      }
      var sdSrc = _toFwd(srcPath);
      var newName = dstFwd.split('/').pop();
      // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，路径/新名未转义会让整条 evalScript 解析失败
      var srcEsc = sdSrc.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      var nameEsc = newName.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      var es =
        'var f=new File("' + srcEsc + '");' +
        'if(!f.exists)"NO_SRC";' +
        'else if(!f.rename("' + nameEsc + '"))"RENAME_FAIL";' +
        'else"OK";';
      var timeout = setTimeout(function () {
        _lastError = 'renameFile ExtendScript 超时 (5s): ' + srcPath + ' → ' + dstPath;
        console.warn('[AEFS] ' + _lastError);
        resolve(false);
      }, 5000);
      try {
        new CSInterface().evalScript(es, function (result) {
          clearTimeout(timeout);
          resolve(result === 'OK');
        });
      } catch (_) { clearTimeout(timeout); resolve(false); }
    });
  }

  /**
   * 同步重命名文件（仅同目录）。① Bridge (fs.renameSync) → ② cep.fs.rename 回退。
   * 补 cep.fs.rename 回退（官方原语，CEPEngine_extensions.js，文件/目录均可）
   * ——与 writeFileSync 既有 cep.fs 回退读写对齐：bridge 中途死亡时原子写
   * 「writeFileSync(tmp) 成功 + renameFileSync 失败」会卡死在临时文件。
   * 4xx 真拒绝（403 symlink 逃逸/命名空间/跨目录）不回退——防 bridge 拒绝的重命名被
   * cep.fs.rename 本地执行绕过防护（对齐 writeFileSync 既有模式）。
   *
   * 同目录校验同异步版。
   * @param {string} srcPath
   * @param {string} dstPath — 必须同父目录
   * @returns {boolean}
   */
  function renameFileSync(srcPath, dstPath) {
    if (!_checkPath(srcPath)) return false;
    if (!_checkPath(dstPath)) return false;
    var srcFwd = _toFwd(srcPath);
    var dstFwd = _toFwd(dstPath);
    var srcParent = srcFwd.replace(/\/[^\/]+$/, '');
    var dstParent = dstFwd.replace(/\/[^\/]+$/, '');
    if (srcParent.toLowerCase() !== dstParent.toLowerCase()) {
      console.warn('[AEFS] renameFileSync 拒跨目录: ' + srcParent + ' → ' + dstParent);
      return false;
    }
    if (!_safeForDelete(srcPath)) return false;
    if (!_depthOk(srcPath, 2)) return false;
    // dst 已存在（覆盖场景）= 删旧文件，需 dst 过 _safeForDelete + _depthOk（与 bridge rename 对齐）
    if (existsSync(dstPath)) {
      if (!_safeForDelete(dstPath)) return false;
      if (!_depthOk(dstPath, 2)) return false;
    }
    // 同步族统一过 _bridgeOkSync 门禁（原 _bridgeOk() 会在半死桥下发同步 XHR）
    if (_bridgeOkSync()) {
      if (Bridge.renameFile(_toWin(srcPath), _toWin(dstPath))) return true;
      var rnRej = (typeof Bridge.getLastSyncRejection === 'function') ? Bridge.getLastSyncRejection() : null;
      if (rnRej && rnRej.status) {
        _lastError = 'renameFileSync Bridge 拒绝 (HTTP ' + rnRej.status + '): ' + srcPath + ' → ' + dstPath;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
      // 401（token 轮换窗口）不回退 cep.fs.rename（本地直改绕过 bridge 防护）
      var rnAuth = _bridgeSyncUnauthorized();
      if (rnAuth) {
        _lastError = 'renameFileSync Bridge 鉴权失败 (HTTP 401，token 轮换窗口): ' + srcPath + ' → ' + dstPath;
        console.warn('[AEFS] ' + _lastError);
        return false;
      }
      // 通道失败（bridge 中途死亡/网络异常，非 4xx 真拒绝）→ 下落 cep.fs.rename
    }
    if (_canRename()) {
      try {
        var crr = window.cep.fs.rename(_toWin(srcPath), _toWin(dstPath));
        if (crr && crr.err === 0) return true;
      } catch (_) {}
    }
    _lastError = 'renameFileSync Bridge 不可用且 cep.fs.rename 不可用: ' + srcPath + ' → ' + dstPath;
    console.warn('[AEFS] ' + _lastError);
    return false;
  }

  /**
   * 重命名目录（仅同目录，原子操作）。
   * ① Bridge (fs.renameSync) → ② ExtendScript (Folder.rename)
   *
   * 安全：src 和 dst 均需过 _checkPath；src 过 _safeForDelete + _depthOk；
   *       dst 已存在（覆盖）时 dst 亦过 _safeForDelete + _depthOk（与 bridge rename 对齐）。
   * ExtendScript 回退仅同父目录，跨目录返回 false。
   * @param {string} srcPath — 源目录绝对路径
   * @param {string} dstPath — 目标目录绝对路径（必须同父目录）
   * @returns {Promise<boolean>}
   */
  function renameDir(srcPath, dstPath) {
    if (!_checkPath(srcPath)) return Promise.resolve(false);
    if (!_checkPath(dstPath)) return Promise.resolve(false);
    var srcFwd = _toFwd(srcPath);
    var dstFwd = _toFwd(dstPath);
    var srcParent = srcFwd.replace(/\/[^\/]+$/, '');
    var dstParent = dstFwd.replace(/\/[^\/]+$/, '');
    if (srcParent.toLowerCase() !== dstParent.toLowerCase()) {
      console.warn('[AEFS] renameDir 拒跨目录: ' + srcParent + ' → ' + dstParent);
      return Promise.resolve(false);
    }
    if (!_safeForDelete(srcPath)) return Promise.resolve(false);
    if (!_depthOk(srcPath, 2)) return Promise.resolve(false);
    // dst 已存在（覆盖场景）= 删旧目录，需 dst 过 _safeForDelete + _depthOk（与 bridge rename 对齐）
    if (existsSync(dstPath)) {
      if (!_safeForDelete(dstPath)) return Promise.resolve(false);
      if (!_depthOk(dstPath, 2)) return Promise.resolve(false);
    }
    if (_bridgeOk() && typeof Bridge.renameDirAsync === 'function') {
      // 异步 XHR，不阻塞主线程；Bridge 不可用/失败时走 _renameDirFallback
      // 捕获 promise 经 per-seq 二分（并发同 method 不交叉污染）
      var _bp = Bridge.renameDirAsync(_toWin(srcPath), _toWin(dstPath));
      return _bp.then(function (bOk) {
        if (bOk) return true;
        // Bridge 4xx「真拒绝」（403 symlink 逃逸/命名空间/跨目录、400 非法路径）→
        // 明确失败不回退 ExtendScript——否则 Folder.rename 会完成 bridge 拒绝的操作。
        // 网络异常/5xx（无拒绝记录）仍照旧回退
        var _rej = _bridgeAsyncRejection('rename', _bp);
        if (_rej) {
          _lastError = 'renameDir Bridge 拒绝 (HTTP ' + _rej.status + '): ' + srcPath + ' → ' + dstPath;
          console.warn('[AEFS] ' + _lastError);
          return false;
        }
        return _renameDirFallback(srcPath, dstPath, dstFwd);
      });
    }
    return _renameDirFallback(srcPath, dstPath, dstFwd);
  }

  // renameDir 的 ExtendScript 回退通道（Bridge 不可用或 Bridge 失败时）
  function _renameDirFallback(srcPath, dstPath, dstFwd) {
    // ExtendScript 回退：Folder.rename(name) 同目录原子操作
    return new Promise(function (resolve) {
      if (!_hasCS()) {
        _lastError = 'renameDir ExtendScript 不可用 (CSInterface 未定义): ' + srcPath + ' → ' + dstPath;
        console.warn('[AEFS] ' + _lastError);
        return resolve(false);
      }
      var sdSrc = _toFwd(srcPath);
      var newName = dstFwd.split('/').pop();
      // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，路径/新名未转义会让整条 evalScript 解析失败
      var srcEsc = sdSrc.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      var nameEsc = newName.replace(/"/g, '\\"').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      var es =
        'var d=new Folder("' + srcEsc + '");' +
        'if(!d.exists)"NO_SRC";' +
        'else if(!d.rename("' + nameEsc + '"))"RENAME_FAIL";' +
        'else"OK";';
      var timeout = setTimeout(function () {
        _lastError = 'renameDir ExtendScript 超时 (5s): ' + srcPath + ' → ' + dstPath;
        console.warn('[AEFS] ' + _lastError);
        resolve(false);
      }, 5000);
      try {
        new CSInterface().evalScript(es, function (result) {
          clearTimeout(timeout);
          resolve(result === 'OK');
        });
      } catch (_) { clearTimeout(timeout); resolve(false); }
    });
  }

  /**
   * 同步重命名目录（仅同目录，原子操作）。① Bridge (fs.renameSync) 唯一通道。
   * @param {string} srcPath
   * @param {string} dstPath — 必须同父目录
   * @returns {boolean}
   */
  function renameDirSync(srcPath, dstPath) {
    if (!_checkPath(srcPath)) return false;
    if (!_checkPath(dstPath)) return false;
    var srcFwd = _toFwd(srcPath);
    var dstFwd = _toFwd(dstPath);
    var srcParent = srcFwd.replace(/\/[^\/]+$/, '');
    var dstParent = dstFwd.replace(/\/[^\/]+$/, '');
    if (srcParent.toLowerCase() !== dstParent.toLowerCase()) {
      console.warn('[AEFS] renameDirSync 拒跨目录: ' + srcParent + ' → ' + dstParent);
      return false;
    }
    if (!_safeForDelete(srcPath)) return false;
    if (!_depthOk(srcPath, 2)) return false;
    // dst 已存在（覆盖场景）= 删旧目录，需 dst 过 _safeForDelete + _depthOk（与 bridge rename 对齐）
    if (existsSync(dstPath)) {
      if (!_safeForDelete(dstPath)) return false;
      if (!_depthOk(dstPath, 2)) return false;
    }
    // 同步族统一过 _bridgeOkSync 门禁（原 _bridgeOk() 会在半死桥下发同步 XHR；
    // renameDirSync 无本地同步回退——门禁未放行时按失败返回，不冒冻结主线程的风险）
    if (_bridgeOkSync()) {
      return Bridge.renameDir(_toWin(srcPath), _toWin(dstPath));
    }
    _lastError = 'renameDirSync Bridge 不可用或同步门禁未放行（唯一同步通道）: ' + srcPath + ' → ' + dstPath;
    console.warn('[AEFS] ' + _lastError);
    return false;
  }

  // ====== 导出 ======

  global.AEFS = {
    // 异步（Bridge → cep.fs → ExtendScript，永不 reject）
    readFile: readFile,
    readFileAsync: readFileAsync,
    // readFile 的 Result 版（三态：ok(text)/NOT_FOUND/CHANNEL_FAILURE/
    // REJECTED）。薄适配层折叠回 string|null；新调用方一律用 Result 版——
    // 会话/配置类读失败（CHANNEL_FAILURE）不得当「空文件」覆盖写。
    readFileResult: readFileResult,
    // 最近一次文档解析失败原因（readFile 返 null 后读取，用于透传给 LLM 定位）
    getLastDocumentParseError: function () { return _lastDocumentParseError; },
    writeFile: writeFile,
    writeFileLlm: writeFileLlm,
    writeFileBase64: writeFileBase64,
    writeBlob: writeBlob,
    readImageBase64: readImageBase64,
    readBlob: readBlob,
    readClipboard: readClipboard,
    mkdir: mkdir,
    mkdirAsync: mkdirAsync,
    deleteFile: deleteFile,
    deleteFileToRecycle: deleteFileToRecycle,   // 优先回收站（失败不自动退回永久删）
    rmdir: rmdir,
    removeDirRecursive: removeDirRecursive,
    copyFile: copyFile,
    copyFileAsync: copyFileAsync,
    renameFile: renameFile,
    renameDir: renameDir,
    listFiles: listFiles,
    listFilesAsync: listFilesAsync,
    // 列文件 + 体积/龄（只走 Bridge；null = 拿不到体积，非空目录）。temp 缓存体积预算用。
    listFilesWithSize: listFilesWithSize,
    // listFiles/listDirs 的 Result 版（三态：ok(names)/NOT_FOUND/
    // CHANNEL_FAILURE/REJECTED）。薄适配层折叠回数组；新调用方一律用 Result 版。
    listFilesResult: listFilesResult,
    listDirs: listDirs,
    listDirsAsync: listDirsAsync,
    listDirsResult: listDirsResult,
    copyDir: copyDir,
    copyDirAsync: copyDirAsync,
    exists: exists,
    existsAsync: existsAsync,
    // exists 的 Result 版（三态显式：存在 / 不存在 / 通道故障 / 拒绝）。
    // 薄适配层 exists 内部调本实现折叠回布尔；新调用方一律用 Result 版。
    existsResult: existsResult,
    existsBatch: existsBatch,
    isFile: isFile,
    // 链接探测（只读；null = 探不到，调用方放行既有流程）
    isLinkAsync: isLinkAsync,
    // 真实路径探测（只读；null = 探不到/路径不存在，调用方放行）
    realpathAsync: realpathAsync,
    // 文件元信息（mtimeMs 毫秒/size/isFile；失败 resolve null 永不 reject）
    stat: stat,
    // stat 的 Result 版（三态：ok(meta)/NOT_FOUND/CHANNEL_FAILURE/
    // REJECTED）。薄适配层折叠回 {…}|null；新调用方一律用 Result 版——
    // 通道故障（拿不到）不得被当 missing 标记处理。
    statResult: statResult,
    isEmptyDir: isEmptyDir,
    // 递归目录树扫描 + 文件大小（走 ExtendScript，过 _checkPath）
    scanTree: scanTree,
    fileSize: fileSize,
    // 同步（Bridge → cep.fs，直接返回值，不经过 ExtendScript）
    readFileSync: readFileSync,
    writeFileSync: writeFileSync,
    writeFileBase64Sync: writeFileBase64Sync,
    readImageBase64Sync: readImageBase64Sync,
    mkdirSync: mkdirSync,
    deleteFileSync: deleteFileSync,
    rmdirSync: rmdirSync,
    copyFileSync: copyFileSync,
    renameFileSync: renameFileSync,
    renameDirSync: renameDirSync,
    listFilesSync: listFilesSync,
    listDirsSync: listDirsSync,
    existsSync: existsSync,
    isFileSync: isFileSync,

    // 诊断：返回最近一次失败原因字符串，成功不自动清空
    lastError: function () { return _lastError; },

    // 数据目录安全校验（供 dataDir.js 用，对齐删类最严标准）
    isDataDirSafe: isDataDirSafe,
    // 失败原因归因（仅用于把 isDataDirSafe 的 false 翻译成一句可展示的原因）
    explainDataDirSafety: explainDataDirSafety,

    // 数据根 UNC 白名单登记/读取（面板侧单点真相源）。
    // 唯一写入方 dataDir.js（解析出实际数据根时登记）；bridge 侧独立进程同构实现，
    // 由面板经 POST /api/set-data-dir 同步（见 bridge-server.js）。
    setAllowedUncRoot: setAllowedUncRoot,
    getAllowedUncRoot: getAllowedUncRoot,

    // 敏感路径判定单点导出——skill-manager llmTools 委托本实现
    //（消除 aeTools/aefs/bridge-server/skill-manager 四份手抄副本的漂移根源；
    // aeTools.jsx/bridge-server.js 因跨进程无法运行时共享，靠同构实现 + 测试锚定）
    isSensitivePath: _isSensitivePath,

    // 命名空间白名单只读副本（聊天区识别「数据根相对路径」用：`agent\temp\x` 这类
    // 路径没有任何绝对前缀，只能按首段是否属于白名单命名空间判断）。
    // 复制一份再导出，防调用方改数组污染删类安全检查的唯一来源。
    SAFE_NAMESPACES: SAFE_NAMESPACES.slice(),

    // Result 构造助手（存量 API 逐调用方迁移 + 新增 API 一律 Result 形态）。
    // 仅本 IIFE 内部与测试使用——迁移期各 API 旧签名照旧导出（薄适配层策略），
    // 全部调用方迁完后再删旧签名。
    Result: {
      ok: _resultOk,
      err: _resultErr,
      CODES: RESULT_CODES
    },

    // 失败体展示层映射（不改失败体本身）：
    //   reasonToCode(判据)   → 错码文案表的键，表外取值回空串
    //   displayError(失败体) → 「本地化一句话: 原始详情」，无文案表/无 AEI18n 时回原文
    reasonToCode: reasonToCode,
    displayError: displayError
  };

  console.log('[AEFS] loaded');
})(window);
