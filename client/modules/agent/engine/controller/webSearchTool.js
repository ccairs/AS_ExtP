(function (global) {
    'use strict';
    // 联网搜索工具实现层拆分。由 controller.js 组装区经 AEEngine.createWebSearchTool() 创建。
    // 纯迁移自 controller.js 的 _bridgeWebSearchUrl / handleSearchWeb（无外部依赖，自包含）。
    //
    // 失败态文案（面板内探针实测）：只回「HTTP N」时 LLM 无从改道——
    // 桥的失败响应体里本就带着可读原因（4xx 是查询本身的问题，如 Query too long；
    // 5xx 是桥→搜索引擎不可达的网络错误），整段丢弃时用户无从改道。按「说明 + 怎么办 +
    // 不要重复」回喂（与工具门控文案同口径），并区分「改查询」（4xx）与「改道」
    // （5xx / 连不上桥），网络层的 "Failed to fetch" 也映射为中文可执行指引。
    function createWebSearchTool(opts) {
        function bridgeWebSearchUrl() {
            return (global.Bridge && global.Bridge.getBridgeUrl ? global.Bridge.getBridgeUrl() : 'http://127.0.0.1:9877') + '/api/web-search';
        }

        function fail(text) {
            return { success: false, isError: true, content: [{ type: 'text', text: 'search_web 失败: ' + text }] };
        }

        // 非 2xx：带上响应体里的 error 原因，按 4xx（查询问题，改查询）/ 5xx（服务或网络，
        // 改道）分别给指引——两种失败的「怎么办」完全不同，同形文案会误导 LLM 原样重试。
        function httpFailText(status, reason) {
            var r = reason ? '（' + reason + '）' : '';
            if (status >= 400 && status < 500) {
                return '搜索请求失败: HTTP ' + status + r + '。本地搜索服务拒绝了本次请求（多为查询内容问题）；请调整查询后重试，不要原样重复。';
            }
            return '搜索请求失败: HTTP ' + status + r + '。本地搜索服务无法完成搜索（搜索引擎不可达或服务异常）；请改用本地知识作答，并如实告知用户联网搜索暂不可用，不要立即反复重试。';
        }

        function exceptionText(e) {
            if (e && e.name === 'AbortError') {
                return '搜索超时（8s）：搜索服务未在 8 秒内返回。可换更简短的关键词重试一次，或改用本地知识作答，不要原样重复。';
            }
            var m = (e && e.message) ? String(e.message) : String(e);
            // fetch 网络层失败：CEF/Chromium 报 "Failed to fetch"，Node 报 "fetch failed"
            if ((e && e.name === 'TypeError') || /failed to fetch|fetch failed|networkerror|load failed/i.test(m)) {
                return '无法连接本地搜索服务（Bridge 未运行或本机网络异常）：' + m + '。请改用本地知识作答，并如实告知用户联网搜索暂不可用，不要重试。';
            }
            return '搜索返回异常：' + m + '。请改用本地知识作答，不要原样重复本查询。';
        }

        // 200 但结构不可用（ok=false / 非 JSON / 缺字段）
        function bodyFailText(data) {
            var errMsg = (data && data.error) ? String(data.error) : '响应缺少结果数据';
            return '搜索返回异常（' + errMsg + '）。请改用本地知识作答，不要原样重复本查询。';
        }

        // 200 但一条都没解析出来（桥标 degraded）：不能当「确实没有结果」——Bing 改版/限流时
        // 静默回空数组时，模型据此告知用户「没搜到」，故障被吞成正常空结果。按失败回喂并给改道指引；
        // 三种成因（改版 / 限流 / 该查询确实无结果）都在文案里保留，避免把「无结果」误报成服务故障。
        function degradedText(data) {
            var note = (data && data.note) ? String(data.note) : '响应里没有可解析的结果';
            return '搜索未返回可解析结果（' + note + '）。不要据此断言没有相关资料；可换更通用的关键词重试，不要原样重复；或改用本地知识作答并如实告知用户本次未取得结果。';
        }

        function handleSearchWeb(args) {
            args = args || {};
            var query = String(args.query || '').trim();
            if (!query) {
                return Promise.resolve({ success: false, isError: true, content: [{ type: 'text', text: 'search_web: query 不能为空' }] });
            }
            // num 钳制到 [1, 20]：防止 LLM 传入超大 num 拉取海量结果撑大上下文（默认 5）。
            // 单页实际只有 8~10 条（首页 b_algo 数），且上游不认翻页参数（见 bridge 常量处实测注释）。
            var num = Math.min(20, Math.max(1, Number(args.num) || 5));
            var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            var fetchTimer = setTimeout(function () { if (controller) controller.abort(); }, 8000);
            var fetchOpts = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: query, num: num })
            };
            if (controller) fetchOpts.signal = controller.signal;
            return fetch(bridgeWebSearchUrl(), fetchOpts).then(function (res) {
                clearTimeout(fetchTimer);
                return res.text().then(function (body) {
                    var data = null;
                    try { data = JSON.parse(body); } catch (_) {}
                    if (!res.ok) {
                        return fail(httpFailText(res.status, (data && data.error) ? data.error : ''));
                    }
                    if (data && data.ok && data.results) {
                        if (data.results.length === 0 || data.degraded) {
                            return fail(degradedText(data));
                        }
                        return { success: true, isError: false, content: [{ type: 'text', text: JSON.stringify({ query: query, results: data.results }) }] };
                    }
                    return fail(bodyFailText(data));
                });
            }).catch(function (e) {
                clearTimeout(fetchTimer);
                return fail(exceptionText(e));
            });
        }

        return { bridgeWebSearchUrl: bridgeWebSearchUrl, handleSearchWeb: handleSearchWeb };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createWebSearchTool = createWebSearchTool;
})(typeof global !== 'undefined' ? global : window);
