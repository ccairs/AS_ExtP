(function (global) {
  'use strict';
  // ══════════════════════════════════════════════════════════════════════════
  // 代码读取查询的单一实现
  //
  // 消费点三处，共用这一份：面板 shader 轮的 get_current_shader、效果库
  // shader_library(mode:'get')、面板 script 轮的 get_current_script。三份平行
  // 拷贝（校验与查询各自内联在 handler 里），同一族判据在两侧不同步的毛病在历史上
  // 出现过多次。
  //
  // 消费方差异全部走 opts，本文件不含语言特定逻辑：
  //   hash          —— 回执字段，供写前比对（不传时字段为 undefined，JSON.stringify 自动
  //                    省略 → 与既有回执逐字节一致）
  //   name          —— 回执字段（同上；效果库整篇读取沿用旧契约）
  //   buildSegments —— segments 查询的分段器（GLSL 与 ES3 各有一份语言特定的实现）
  //   subject       —— 截断提示里的主语（'代码' / '脚本'）
  //
  // 拆成「校验」与「执行」两段是为保住调用方的顺序约束：**记账必须晚于参数校验**
  // （被拒的读不算"读过"，否则一次参数错误的调用就解除「从未读过 + 预览区非空 →
  // 拒绝写入」那道防线）。
  // ══════════════════════════════════════════════════════════════════════════

  var MAX_LINES = 500;      // 单次最多返回行数（超出截断并标注 truncated）
  var MATCH_PAGE = 20;      // search 每页匹配数
  // 面积（结果体积）自守预算：工具结果进管线的是 **JSON 序列化后**的文本，
  // 而管线兜底上限是 32768 字符——行数上限（500 行）本身挡不住：实测 500 行 × 60 字符的普通
  // GLSL 已经到 34486（转义密集内容到 20 万+，segments 模式更无行数约束，3000 行源到 34.7 万）。
  // 超了就会被管线再截一次：正文中段丢失 + 结果切成非法 JSON（startLine/endLine/totalLines 等
  // 定位字段全没）。故这里按**序列化后长度**自守一道（24K，给兜底留 8K），超了就缩减本条
  // 实际返回的内容量（行数/命中数/段数），并在回执里如实标注缩减量与续读位置。
  var PAYLOAD_BUDGET = 24 * 1024;

  // 把"内容条数"逐步缩到序列化后落进预算内（每轮按观察到的膨胀比缩，转义比 ≥1 故几轮内收敛）；
  // build(n) 接受条数、返回该条数下的 payload 字符串。n=0 时仍超（源本身过大）就原样交出去，
  // 由管线兜底处理——不在这里死循环。
  function fitBudget(build, n) {
    var payload = build(n);
    for (var pass = 0; pass < 4 && payload.length > PAYLOAD_BUDGET && n > 0; pass++) {
      var excess = payload.length - PAYLOAD_BUDGET;
      var drop = Math.max(1, Math.ceil(n * excess / payload.length));
      n = Math.max(0, n - drop);
      payload = build(n);
    }
    return payload;
  }

  // 参数值的短展示（进错误消息；对象/数组截断，循环引用不抛）
  function brief(v) {
    var s;
    try {
      s = JSON.stringify(v);
    } catch (_) {
      s = String(v);
    }
    if (typeof s !== 'string') s = String(v);
    return s.length > 32 ? s.slice(0, 32) + '…' : s;
  }

  // 查询参数的形态判据：**存在但不是该类型/不是合法取值**时显式报错——这类调用若被静默按
  // "没传"处理，回执却是一整篇/未检索的结果（模型以为读的是它要的区间或检索页）。
  // null 与 undefined 同义（视作没传，与仓库既有 `== null` 口径一致）。
  function badTypeOf(args) {
    function errOf(key, want) {
      return key + ' 非法（收到 ' + brief(args[key]) + '）：须为' + want + '。';
    }
    if (args.search != null && typeof args.search !== 'string') return errOf('search', '字符串');
    if (args.segments != null && typeof args.segments !== 'boolean') return errOf('segments', '布尔值');
    // 行号/偏移：整数性与下界同判——只查类型时小数会被 Math.floor
    // 静默降级（`startLine: 2.5` 读成 2..）；`offset: 0.5` 更糟：`Math.floor(0.5)-1 = -1` 让
    // `slice(-1, 19)` 返回**最后一条匹配**并回执 `offset: 0`（静默给错页，与本次要消灭的形态同族）。
    if (args.startLine != null && !isIntAtLeast(args.startLine, 1)) return errOf('startLine', '>= 1 的整数');
    if (args.endLine != null && !isIntAtLeast(args.endLine, 1)) return errOf('endLine', '>= 1 的整数');
    if (args.offset != null && !isIntAtLeast(args.offset, 0)) return errOf('offset', '>= 0 的整数');
    return null;
  }

  function isIntAtLeast(v, min) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= min;
  }

  // 返回 null（通过）或错误回执对象
  function validateCodeQueryArgs(args) {
    args = args || {};
    function err(message) {
      return { success: false, result: JSON.stringify({ status: 'error', message: message }) };
    }
    var badType = badTypeOf(args);
    if (badType) return err(badType);
    var hasSearch = typeof args.search === 'string' && args.search.length > 0;
    var hasSegments = args.segments === true;
    var hasRangeArg = (typeof args.startLine === 'number') || (typeof args.endLine === 'number');
    var hasOffset = (typeof args.offset === 'number') && args.offset > 0;
    if (hasSearch && hasSegments) return err('search 与 segments 不能同时使用，请选择一种查询方式。');
    if ((hasSearch || hasSegments) && hasRangeArg) {
      return err((hasSearch ? 'search' : 'segments') + ' 与 startLine/endLine 不能同时使用，请选择一种查询方式。');
    }
    if (hasOffset && !hasSearch) return err('offset 仅用于配合 search 分页，请同时传 search。');
    return null;
  }

  // source：待查询源码；opts 见文件头。
  // 四种查询：search（+offset 分页）/ segments / startLine-endLine / 整篇（带行号）。
  function runCodeQuery(source, args, opts) {
    args = args || {};
    opts = opts || {};
    var hash = opts.hash;
    var name = opts.name;
    var subject = opts.subject || '代码';
    var buildSegments = opts.buildSegments;
    var hasSearch = typeof args.search === 'string' && args.search.length > 0;
    var hasSegments = args.segments === true;
    var hasOffset = (typeof args.offset === 'number') && args.offset > 0;
    var lines = String(source || '').split(/\r?\n/);
    var totalLines = lines.length;
    if (hasSearch) {
      var needle = args.search;
      var hitLines = [];
      for (var li = 0; li < totalLines; li++) {
        if (lines[li].indexOf(needle) !== -1) hitLines.push(li);
      }
      var totalMatchCount = hitLines.length;
      if (!totalMatchCount) {
        return { success: true, result: JSON.stringify({ status: 'not_found', name: name, search: needle, totalLines: totalLines, message: '未找到匹配文本。' }) };
      }
      var startIdx = hasOffset ? (Math.floor(args.offset) - 1) : 0;
      if (startIdx >= totalMatchCount) {
        return { success: false, result: JSON.stringify({ status: 'error', name: name, message: 'offset 超出匹配总数（共 ' + totalMatchCount + ' 个匹配）。' }) };
      }
      var pageHits = hitLines.slice(startIdx, startIdx + MATCH_PAGE);
      var matches = pageHits.map(function (hl) {
        var from = Math.max(0, hl - 2);
        var to = Math.min(totalLines - 1, hl + 2);
        var ctx = [];
        for (var ci = from; ci <= to; ci++) ctx.push((ci + 1) + ': ' + lines[ci]);
        return { line: hl + 1, text: lines[hl], context: ctx.join('\n') };
      });
      // 命中条数也吃体积自守：上下文行可以很长（压缩过的源码一行几万字符），20 命中 × 5 行就爆
      var buildSearchPayload = function (count) {
        var keep = matches.slice(0, count);
        var hasMore = (startIdx + count) < totalMatchCount;
        var o = { status: 'ok', name: name, search: needle, totalLines: totalLines, totalMatchCount: totalMatchCount, offset: startIdx + 1, matchCount: keep.length, hasMore: hasMore, hash: hash, matches: keep };
        if (count < matches.length) {
          // 缩减必须如实标注，并给出续读的 offset（offset 是"起始匹配序号"，1-based）
          o.truncated = true;
          o.message = '本页按结果体积缩减为前 ' + keep.length + ' 个命中，可用 offset=' + (startIdx + keep.length + 1) + ' 继续读取。';
        }
        return JSON.stringify(o);
      };
      return { success: true, result: fitBudget(buildSearchPayload, matches.length) };
    }
    if (hasSegments) {
      if (typeof buildSegments !== 'function') {
        return { success: false, result: JSON.stringify({ status: 'error', name: name, message: '内部装配缺失（segments 分段器未注入）：segments 查询不可用。' }) };
      }
      var allSegs = buildSegments(lines);   // 段数随文件规模线性增长（3000 行源实测 payload 34.7 万字符）
      var buildSegPayload = function (count) {
        var keep = allSegs.slice(0, count);
        var o = { status: 'ok', name: name, totalLines: totalLines, hash: hash, segments: keep };
        if (count < allSegs.length) {
          // 缩了就要能续读：段自带 startLine，模型可用 startLine/endLine 取后一段窗口
          var lastLine = keep.length ? keep[keep.length - 1].endLine : 0;
          o.truncated = true;
          o.message = '本页按结果体积缩减为前 ' + keep.length + '/' + allSegs.length + ' 段，可用 startLine=' + (lastLine + 1) + ' 继续读取后续段。';
        }
        return JSON.stringify(o);
      };
      return { success: true, result: fitBudget(buildSegPayload, allSegs.length) };
    }
    var start = (typeof args.startLine === 'number' && args.startLine > 0) ? Math.floor(args.startLine) : 1;
    var end = (typeof args.endLine === 'number' && args.endLine > 0) ? Math.floor(args.endLine) : totalLines;
    start = Math.max(1, Math.min(start, totalLines));
    end = Math.max(1, Math.min(end, totalLines));
    if (start > end) { var _t = start; start = end; end = _t; }
    var hasRange = (typeof args.startLine === 'number') || (typeof args.endLine === 'number');
    var overLineCap = (end - start + 1) > MAX_LINES;
    var capEnd = Math.min(end, start + MAX_LINES - 1);
    // 区间/整篇统一按"返回多少行"参数化，好让体积自守把行数再缩（见 PAYLOAD_BUDGET）
    var buildRangePayload = function (count) {
      var toLine = start + count - 1;
      var cut = overLineCap || toLine < capEnd;
      var sliceLines = lines.slice(start - 1, toLine);
      var numbered = sliceLines.map(function (line, i) { return (start + i) + ': ' + line; }).join('\n');
      if (!hasRange) {
        // 整篇：未截断时保持旧契约（无 maxLines/truncated/message 字段），逐字节不变
        return cut
          ? JSON.stringify({
              status: 'ok', name: name, code: numbered, totalLines: totalLines, maxLines: MAX_LINES, truncated: true, hash: hash,
              message: overLineCap
                ? (subject + '超过 ' + MAX_LINES + ' 行，已仅返回前 ' + MAX_LINES + ' 行，请用 startLine/endLine 分段读取。')
                : (subject + '本页按结果体积缩到前 ' + toLine + ' 行（未超出 ' + MAX_LINES + ' 行上限），请用 startLine/endLine 继续读取。')
            })
          : JSON.stringify({ status: 'ok', name: name, code: numbered, totalLines: totalLines, hash: hash });
      }
      return JSON.stringify({ status: 'ok', name: name, startLine: start, endLine: toLine, totalLines: totalLines, maxLines: MAX_LINES, truncated: cut, hash: hash, code: numbered });
    };
    return { success: true, result: fitBudget(buildRangePayload, capEnd - start + 1) };
  }

  global.AEEngine = global.AEEngine || {};
  global.AEEngine.codeQuery = { validateCodeQueryArgs: validateCodeQueryArgs, runCodeQuery: runCodeQuery, MAX_LINES: MAX_LINES, MATCH_PAGE: MATCH_PAGE };
})(typeof global !== 'undefined' ? global : window);
