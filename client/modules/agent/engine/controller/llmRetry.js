(function (global) {
    'use strict';
    // ── LLM 请求失败自动重试（唯一实现）────────────────────────────────────────
    // 为什么要这一层：流式请求失败（网关 5xx / 限流 / 连接被掐 / 首字节前超时）若是一次性
    // 动作——错误分支直接落一条「流式请求失败」并结束当前轮，用户得手工重发，已经跑过的工具
    // 轮次成果只能靠上下文重述。这里给**同一轮请求**加有界重试：只重试「一个字都没流出」的
    // 瞬时故障，所以重发不会重复展示、也不会重复计费已流出的 token。
    //
    // 职责边界：本模块只做「判定 + 退避 + 取消」，不碰 channel 与 UI；发送动作、是否已流出
    // 输出、用户是否点了停止，全部由调用方经 opts 注入。Agent 循环与 Script 循环共用这一份，
    // 不各写一套（两处各自的 onToken/onReasoning 决定「流出」口径）。
    //
    // 刻意**不**覆盖的请求：上下文压缩（apiActions 的摘要请求）与工具安全审查等旁路请求。
    // 它们失败已有各自的处置（压缩在下一轮仍超阈值时会再次触发；审查失败按 fail-closed 回喂
    // LLM 由模型决定是否重试），把重试叠进去只会拉长卡顿、掩盖真实失败原因。

    // 可重试的 HTTP 状态：瞬时/可自愈的那几类。400/401/402/403/404/413/422 是确定性失败
    //（请求体非法、鉴权/额度/权限/不存在、体积超限），原样重发只会得到同样结果。
    var RETRYABLE_STATUS = [408, 409, 425, 429, 500, 502, 503, 504, 529];
    var DEFAULT_MAX_RETRIES = 2;        // 最多 3 次请求（首次 + 2 次重试）
    var DEFAULT_BASE_DELAY_MS = 1000;   // 退避：1s、2s（指数，封顶 8s）
    var DEFAULT_MAX_DELAY_MS = 8000;
    var MAX_RETRIES_CAP = 5;            // 调用方给再大的值也夹到这里，防长时间静默等待

    function _num(v, dflt) {
        var n = Number(v);
        return isFinite(n) ? n : dflt;
    }

    function _clampRetries(v) {
        // null / 空串按「未设置」处理：Number(null) === 0 会被误当成「0 次重试」
        if (v === null || v === undefined || v === '') return DEFAULT_MAX_RETRIES;
        var n = Number(v);
        if (!isFinite(n)) return DEFAULT_MAX_RETRIES;
        return Math.max(0, Math.min(MAX_RETRIES_CAP, Math.floor(n)));
    }

    // 中止/停止类结果永远不重试：用户要停，重发违背意图；abort 也可能来自调用方切换会话。
    // 判定只采信**结构化信号**（aborted 标志 / 错误码），不按 message 里的 abort 字样判：
    // API_ERROR 的 message 是服务端错误体原文，网关 502/503 常见 "upstream request aborted"、
    // nginx "client aborted" 之类文案——按文案判会把最该重试的瞬时失败误判成用户中止
    //（按文案判定会把 `API请求失败: 503 upstream request aborted` 判成不可重试）。
    // 只有「抛错折成」的两类没有状态码，其 message 来自 fetch 异常本身，才按文案识别。
    function _isAbortLike(result) {
        if (!result) return false;
        if (result.aborted === true) return true;
        var code = String(result.error || '');
        if (code === 'ABORTED' || code === 'stopped') return true;
        if (code === 'EXCEPTION' || code === 'NETWORK_ERROR') return /abort/i.test(String(result.message || ''));
        return false;
    }

    // 网络类异常文案（sendStream 把装配期的 throw 折成 EXCEPTION，没有状态码可判）。
    var _NETWORK_LIKE = /network|failed to fetch|net::|econn(reset|refused|aborted)?|etimedout|eai_again|socket|timed? ?out|timeout/i;

    // 失败是否属「瞬时/可自愈」类：只判失败形态（超时/网络/可重试状态码），不看是否已
    // 流出、是否已停止。同轮重发与 goal 失败轮自动续轮共用这一份判据——两层各自都只
    // 在「值得再试」的失败上动手，口径不一致会出现「这层重试、那层不续」的割裂。
    function isTransient(result) {
        if (!result || !result.error) return false;
        if (_isAbortLike(result)) return false;
        var code = String(result.error);
        if (code === 'NETWORK_ERROR' || code === 'REQUEST_TIMEOUT') return true;
        if (code === 'API_ERROR') {
            return RETRYABLE_STATUS.indexOf(Number(result.status)) >= 0;
        }
        if (code === 'EXCEPTION') return _NETWORK_LIKE.test(String(result.message || ''));
        return false;
    }

    function isRetryable(result, ctx) {
        if (!result || !result.error) return false;
        var c = ctx || {};
        // 已流出 token/reasoning：重发会让同一段内容重复展示、重复计费，一律不重试。
        if (c.streamed === true) return false;
        // 用户已停止（或调用方已取消）：不再发起新请求，交给调用方的停止分支收尾。
        if (c.cancelled === true) return false;
        return isTransient(result);
    }

    // 退避时长：第 1 次重试 base、第 2 次 2×base……封顶 maxDelayMs。
    function _delayFor(attempt, baseDelayMs, maxDelayMs) {
        var n = Math.max(1, Math.floor(_num(attempt, 1)));
        var base = Math.max(0, _num(baseDelayMs, DEFAULT_BASE_DELAY_MS));
        var max = Math.max(0, _num(maxDelayMs, DEFAULT_MAX_DELAY_MS));
        return Math.min(max, base * Math.pow(2, n - 1));
    }

    // 失败原因短标签：只进 UI 文案，不进错误正文（正文仍用 result.message 原文）。
    function describeFailure(result) {
        if (!result) return '未知错误';
        var code = String(result.error || '');
        if (code === 'NETWORK_ERROR') return '网络异常';
        if (code === 'REQUEST_TIMEOUT') return '请求超时';
        if (code === 'EXCEPTION') return '请求异常';
        if (code === 'API_ERROR') {
            var st = Number(result.status);
            if (st === 429) return '限流 429';
            if (st >= 500) return '服务端 ' + st;
            return 'HTTP ' + (st || '?');
        }
        return code || '未知错误';
    }

    // 可被取消的退避等待：resolve(true) = 睡满，resolve(false) = 等待期间被取消。
    // 分片轮询而非单个长定时器——用户点停止后最多 100ms 就跳出，不必等完整退避。
    function _sleep(ms, isCancelled) {
        return new Promise(function (resolve) {
            var deadline = Date.now() + Math.max(0, Number(ms) || 0);
            function tick() {
                if (typeof isCancelled === 'function' && isCancelled()) { resolve(false); return; }
                var left = deadline - Date.now();
                if (left <= 0) { resolve(true); return; }
                setTimeout(tick, Math.min(left, 100));
            }
            tick();
        });
    }

    // send(attempt) → Promise<result>。返回：
    //   { result, attempts, retried }  —— result 是**最后一次**结果（成功或最终失败）
    // 调用方只需要看 result；attempts > 1 时可据此在最终失败文案里如实标注重试过几次。
    // send 抛出的异常**原样穿透**（不折成 {error}）：与直连 channel 时一致，外层
    // （_runUserRequest 的 catch/停止分支）负责收尾——吞掉异常会改变既有错误处理路径。
    async function runWithRetry(send, options) {
        var o = options || {};
        var maxRetries = _clampRetries(o.maxRetries);
        var maxAttempts = maxRetries + 1;
        var baseDelayMs = Math.max(0, _num(o.baseDelayMs, DEFAULT_BASE_DELAY_MS));
        var maxDelayMs = Math.max(0, _num(o.maxDelayMs, DEFAULT_MAX_DELAY_MS));
        var attempts = 0;
        var lastResult = null;
        var cancelled = false;

        while (attempts < maxAttempts) {
            attempts++;
            lastResult = await send(attempts);
            if (!lastResult || !lastResult.error) {
                return { result: lastResult, attempts: attempts, retried: attempts > 1 };
            }
            cancelled = (typeof o.isCancelled === 'function') ? !!o.isCancelled() : false;
            var streamed = (typeof o.hasOutput === 'function') ? !!o.hasOutput() : false;
            if (attempts >= maxAttempts) break;
            if (!isRetryable(lastResult, { streamed: streamed, cancelled: cancelled })) break;

            var delayMs = _delayFor(attempts, baseDelayMs, maxDelayMs);
            if (typeof o.onRetry === 'function') {
                try {
                    o.onRetry({
                        attempt: attempts + 1,
                        maxAttempts: maxAttempts,
                        delayMs: delayMs,
                        reason: describeFailure(lastResult),
                        result: lastResult
                    });
                } catch (_) { /* 提示回调异常不得中断重试链 */ }
            }
            var slept = await _sleep(delayMs, o.isCancelled);
            if (!slept) { cancelled = true; break; }
            // 睡满后再复核一次：停止可能正好落在「sleep 返回 true」与「下一次 send」之间的
            // 同步窗口里——不查会带着已 abort 的 signal 再发一次请求（虽会立刻失败，但停止
            // 后不该再发起任何请求）。
            if (typeof o.isCancelled === 'function' && o.isCancelled()) { cancelled = true; break; }
        }
        return { result: lastResult, attempts: attempts, retried: attempts > 1, cancelled: cancelled };
    }

    // 实例只承载默认值（可在测试里用 createLlmRetry({ baseDelayMs: 1 }) 注入短退避），
    // 判定与流程均为无状态纯函数，调用方可逐次覆盖。
    function createLlmRetry(options) {
        var o = options || {};
        // 默认值落进闭包变量（不靠 this）：实例方法被解构/转交时仍取到同一份口径。
        var maxRetries = _clampRetries(o.maxRetries);
        var baseDelayMs = Math.max(0, _num(o.baseDelayMs, DEFAULT_BASE_DELAY_MS));
        var maxDelayMs = Math.max(0, _num(o.maxDelayMs, DEFAULT_MAX_DELAY_MS));
        return {
            maxRetries: maxRetries,
            baseDelayMs: baseDelayMs,
            maxDelayMs: maxDelayMs,
            isRetryable: isRetryable,
            isTransient: isTransient,
            describeFailure: describeFailure,
            retryDelayMs: function (attempt) {
                return _delayFor(attempt, baseDelayMs, maxDelayMs);
            },
            runWithRetry: runWithRetry
        };
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createLlmRetry = createLlmRetry;
    // 常量公开给回归测试（判定与退避口径的唯一真相源在这里，测试不另抄一份数字）
    global.AEEngine.LLM_RETRY_LIMITS = {
        RETRYABLE_STATUS: RETRYABLE_STATUS,
        DEFAULT_MAX_RETRIES: DEFAULT_MAX_RETRIES,
        DEFAULT_BASE_DELAY_MS: DEFAULT_BASE_DELAY_MS,
        DEFAULT_MAX_DELAY_MS: DEFAULT_MAX_DELAY_MS,
        MAX_RETRIES_CAP: MAX_RETRIES_CAP
    };
})(typeof global !== 'undefined' ? global : window);
