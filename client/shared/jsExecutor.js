(function (global) {
  // JS 效果执行器：在面板侧（CEP Chromium）执行 JS 效果代码，产出 GLSL 字符串。
  // 宿主对 JS 无感知，最终都走 .glsl 热重载通道。
  // 契约：JS 代码必须实现 buildShader(params) 函数，返回 GLSL 字符串。
  // params: 由面板注入，包含 uniform 默认值（parseUniforms 提取）。
  //
  // 安全：使用 new Function 沙箱执行，仅传入 params 参数，不通过闭包传递当前作用域。
  // 注意：new Function 无法完全隔离全局——代码仍可通过 (new Function('return this'))() 等方式拿到全局对象。
  // 此处沙箱的主要目的是隔离闭包变量（防止 buildShader 访问面板侧的 window/document 等直接引用），
  // 并配合 submit_js_effect 的 LLM 安全审查 + compileCheck 双重防线。

  // 静态危险代码预检黑名单：与 validator.js 对齐，但只保留 shader JS 需要禁止的项。
  // shader JS 效果只允许纯计算动态拼接 GLSL，绝对禁止任何 IO/网络/命令执行/逃逸。
  var BLOCKED_PATTERNS = [
    /\bFile\s*\(/i,
    /\bFolder\s*\(/i,
    /system\.callSystem\s*\(/i,
    // 沙箱逃逸标识符
    /\b__ael/i,
    /\b__aeS/i,
    /\b_OF\b|\b_OD\b/i,
    /\b_cs\b/i,
    /\b_ef\b/i,
    // 拼接/混淆绕过拦截
    /\b(system|this|global|window|self)\s*\[\s*['"]/i,
    /\beval\s*\(/,
    // H2 修复：裸 Function 标识符（旧模式只拦 new Function 前缀形态，
    // Function('code')() 与 var F = Function; new F(...) 均不命中）
    /\bFunction\b/,
    // H2 修复：构造器/原型链逃逸（params.constructor.constructor → Function）
    /\bconstructor\b/,
    /\bprototype\b/,
    /__proto__/,
    // H2 修复：CEP 桥标识符（evalScript 可绕 AST 门禁向 AE 发任意 ExtendScript）
    /\bCSInterface\b/,
    /\bevalScript\b/,
    /\bnew\s+Function\s*\(/,
    /\bString\s*\.\s*fromCharCode\s*\(/,
    /\$\.(global|evalFile)\b/,
    /\bcallSystem\b/i,
    /\bBridgeTalk\b/i,
    /\bSocket\b/i,
    /\brunScriptFromFile\b/i,
    // 禁止直接暴露的危险访问（虽然 params 中没这些，但代码里自己找出来也不行）
    /\bwindow\b/i,
    /\bdocument\b/i,
    /\bXMLHttpRequest\b/i,
    /\bfetch\b/i,
    /\bWebSocket\b/i
  ];

  // H2 修复：注释剥离（仅用于预检匹配，不改原始代码、不影响执行）。
  // 扫描器逐字符跟踪字符串字面量（'/"/`，含转义与未闭合按行终止），字符串内不剥；
  // 行注释剥到换行、块注释替换为单空格。
  function stripCommentsForCheck(src) {
    var out = [];
    var i = 0, n = src.length;
    while (i < n) {
      var c = src.charAt(i);
      if (c === '"' || c === "'" || c === '`') {
        var quote = c;
        out.push(c);
        i++;
        while (i < n) {
          var sc = src.charAt(i);
          if (sc === '\\') {
            out.push(sc);
            if (i + 1 < n) out.push(src.charAt(i + 1));
            i += 2;
            continue;
          }
          out.push(sc);
          i++;
          if (sc === quote) break;
          if (sc === '\n') break; // 未闭合字符串：按行终止，避免吞掉后续代码
        }
        continue;
      }
      if (c === '/' && src.charAt(i + 1) === '/') {
        while (i < n && src.charAt(i) !== '\n') i++;
        continue;
      }
      if (c === '/' && src.charAt(i + 1) === '*') {
        i += 2;
        while (i < n && !(src.charAt(i) === '*' && src.charAt(i + 1) === '/')) i++;
        i += 2;
        out.push(' ');
        continue;
      }
      out.push(c);
      i++;
    }
    return out.join('');
  }

  /**
   * 静态预检 JS 效果代码的安全性。
   * @param {string} jsCode LLM 生成的 JS 效果代码
   * @returns { { valid: boolean, errors: Array<{type:string, message:string}> } }
   */
  function precheckJsEffect(jsCode) {
    var errors = [];
    var src = String(jsCode || '');
    if (!src.trim()) {
      errors.push({ type: 'syntax', message: 'JS 代码为空' });
      return { valid: false, errors: errors };
    }
    // 危险代码拦截（全部都是致命错误，没有例外）。
    // H2 修复：原文 + 剥注释版双文本匹配——
    //   原文匹配兜底「把 payload 藏进字符串内伪注释」形态（'http://x'; eval(..)
    //   中 // 在字符串内，剥离版会误删其后代码，但原文里 payload 可见）；
    //   剥离版匹配兜底「标识符与 ( 之间插注释」分割形态（eval/**/( 使 \s* 失配，
    //   剥离后恢复 eval ( 邻接被命中）。
    var stripped = stripCommentsForCheck(src);
    BLOCKED_PATTERNS.forEach(function (pattern) {
      if (pattern.test(src) || pattern.test(stripped)) {
        errors.push({ type: 'security', message: '检测到危险操作: ' + pattern.source + '。shader JS 效果仅允许纯计算动态拼接 GLSL，禁止文件读写、网络访问、命令执行、沙箱逃逸等操作。' });
      }
    });
    // 契约检查：必须有 buildShader 函数
    if (!/\bbuildShader\s*\(/.test(src)) {
      errors.push({ type: 'contract', message: 'JS 效果必须实现 buildShader(params) 函数，未找到该函数定义。' });
    }
    return { valid: errors.length === 0, errors: errors };
  }

  function executeJsEffect(jsCode, params) {
    var code = String(jsCode == null ? '' : jsCode);
    if (!code.trim()) {
      return { ok: false, error: 'JS 代码为空' };
    }
    var fn;
    try {
      // 沙箱执行：把 JS 代码包到函数体里，最后 return buildShader
      // new Function('params', code + '\n;return typeof buildShader === "function" ? buildShader(params) : undefined;');
      // 这样 buildShader 在函数作用域内定义，不污染全局；params 是唯一传入参数
      fn = new Function('params', code + '\n;return (typeof buildShader === "function") ? buildShader(params) : undefined;');
    } catch (e) {
      return { ok: false, error: 'JS 语法错误: ' + ((e && e.message) || String(e)) };
    }
    var glsl;
    try {
      glsl = fn(params || {});
    } catch (e) {
      return { ok: false, error: 'buildShader 执行异常: ' + ((e && e.message) || String(e)) };
    }
    if (typeof glsl !== 'string') {
      return { ok: false, error: 'buildShader 必须返回字符串，当前返回类型: ' + typeof glsl };
    }
    if (!glsl.trim()) {
      return { ok: false, error: 'buildShader 返回的 GLSL 字符串为空' };
    }
    return { ok: true, glsl: glsl };
  }

  // 执行时限：LLM 生成的 buildShader 可能含死循环/过重计算，同步执行会冻结
  // 面板主线程。主线程无法强杀同步循环——竞速只能保证事件循环活着时到点给出明确
  // 超时反馈（对齐 platformTools.js readFile 的 30s 竞速兜底）；真死循环仍会冻结
  // 面板（彻底方案需迁移到可 terminate 的 Worker，此处先做竞速+提示）。
  var JS_EFFECT_TIMEOUT_MS = 10 * 1000;

  /**
   * 带超时竞速的 JS 效果执行（异步，不阻塞调用方栈）。语义与 executeJsEffect 一致，仅两点差异：
   * ① 实际执行排入 setTimeout——调用方立即拿到 pending Promise，UI 可先渲染忙碌反馈，
   *    不再在工具调用栈上同步冻结；
   * ② 超过预算（默认 10s）按超时失败结算：事件循环被同步执行冻结导致超时定时器迟到时，
   *    以实际耗时复核兜底——晚到的成功结果会被丢弃，避免「冻结几十秒后照常采纳」。
   * @param {string} jsCode LLM 生成的 JS 效果代码
   * @param {object} params 注入 buildShader 的参数
   * @param {number} [timeoutMs] 超时预算（内部/测试用，默认 JS_EFFECT_TIMEOUT_MS）
   * @returns {Promise<{ok:boolean, glsl?:string, error?:string}>} 与 executeJsEffect 同形
   */
  function executeJsEffectAsync(jsCode, params, timeoutMs) {
    var budget = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : JS_EFFECT_TIMEOUT_MS;
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: 'buildShader 执行超时（预算 ' + Math.round(budget / 1000) + ' 秒），疑似死循环或过重计算，本次结果已丢弃。请简化 buildShader（避免无界 while/超大循环）。注意：JS 在面板主线程同步执行，超时反馈只能等事件循环恢复后送达，真死循环仍会冻结面板（彻底修复需迁移到可终止的 Worker）。' });
      }, budget);
      setTimeout(function () {
        if (settled) return;  // 排队期间已超预算被竞速结算：不再执行
        var startedAt = Date.now();
        var r = executeJsEffect(jsCode, params);
        var elapsed = Date.now() - startedAt;
        clearTimeout(timer);
        if (elapsed > budget) {
          // 冻结使超时定时器迟到：按实际耗时判定，丢弃晚到的结果
          settled = true;
          resolve({ ok: false, error: 'buildShader 执行超时（实际 ' + Math.round(elapsed / 1000) + ' 秒，预算 ' + Math.round(budget / 1000) + ' 秒），疑似死循环或过重计算，本次结果已丢弃。请简化 buildShader（避免无界 while/超大循环）。注意：JS 在面板主线程同步执行，真死循环仍会冻结面板（彻底修复需迁移到可终止的 Worker）。' });
          return;
        }
        settled = true;
        resolve(r);
      }, 0);
    });
  }

  global.AEJsExecutor = global.AEJsExecutor || {};
  global.AEJsExecutor.executeJsEffect = executeJsEffect;
  global.AEJsExecutor.executeJsEffectAsync = executeJsEffectAsync;
  global.AEJsExecutor.precheckJsEffect = precheckJsEffect;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
