(function (global) {
    'use strict';
    // 网页正文抓取工具实现层。与 webSearchTool.js 平级，由 controller.js 组装区经 AEEngine.createUrlReadTool() 创建。
    // 通过 Bridge /api/fetch-page 抓取 URL 并提取正文可读文本（可访问站点有效，Cloudflare/被墙站点会如实报错）。
    function createUrlReadTool(opts) {
        function bridgeFetchPageUrl() {
            return (global.Bridge && global.Bridge.getBridgeUrl ? global.Bridge.getBridgeUrl() : 'http://127.0.0.1:9877') + '/api/fetch-page';
        }

        function handleReadUrl(args) {
            args = args || {};
            var url = String(args.url || '').trim();
            if (!url) {
                return Promise.resolve({ success: false, isError: true, content: [{ type: 'text', text: 'read_url: url 不能为空' }] });
            }
            var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            var fetchTimer = setTimeout(function () { if (controller) controller.abort(); }, 15000);
            var offset = Math.max(0, Number(args.offset) || 0);
            var limit = Math.min(16000, Math.max(500, Number(args.limit) || 8000));
            var reqBody = { url: url, offset: offset, limit: limit };
            // 关键词/正则检索：与读文件同语义（大小写不敏感、/pattern/flags 走正则、每页 20 条命中）。
            // 长文先搜定位、再按命中给的 offset 读那一段，比一页页翻便宜得多。
            if (args.search) {
                reqBody.search = String(args.search);
                reqBody.searchOffset = Math.max(0, Number(args.searchOffset) || 0);
            }
            var fetchOpts = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(reqBody)
            };
            if (controller) fetchOpts.signal = controller.signal;
            return fetch(bridgeFetchPageUrl(), fetchOpts).then(function (res) {
                clearTimeout(fetchTimer);
                if (!res.ok) {
                    // 非 2xx 时 bridge 响应体带具体原因（SSRF 拒绝 / 下载超时 / HTTP N 等），
                    // 只报状态码会把可执行信息丢在桥侧。读 body 的 error/detail 并入文案；
                    // body 读不出/非 JSON 时回退旧文案（行为兼容）。
                    return res.text().then(function (body) {
                        var eb = null;
                        try { eb = JSON.parse(body); } catch (_) {}
                        var reason = '';
                        if (eb && eb.error) reason = eb.detail ? String(eb.error) + '：' + String(eb.detail) : String(eb.error);
                        else if (eb && eb.detail) reason = String(eb.detail);
                        throw new Error('抓取请求失败: HTTP ' + res.status + (reason ? '（' + reason + '）' : ''));
                    }, function () {
                        throw new Error('抓取请求失败: HTTP ' + res.status);
                    });
                }
                return res.json();
            }).then(function (data) {
                if (data && data.ok) {
                    // 检索模式：返回命中列表（偏移 + 前后文），模型据此挑段落再用 offset 精读
                    if (data.search !== undefined && data.matches) {
                        var lines = ['URL: ' + url,
                            '标题: ' + (data.title || '(无标题)'),
                            '检索「' + data.search + '」：正文共 ' + data.total + ' 字符，共 ' + data.matchTotal
                                + ' 处命中，本页返回第 ' + (data.searchOffset + 1) + '~' + (data.searchOffset + data.hits) + ' 处'];
                        for (var mi = 0; mi < data.matches.length; mi++) {
                            lines.push('[' + (data.searchOffset + mi + 1) + '] offset=' + data.matches[mi].offset
                                + '：' + data.matches[mi].snippet);
                        }
                        if (data.matchTotal > data.searchOffset + data.hits) {
                            lines.push('[还有更多命中：searchOffset=' + (data.searchOffset + data.hits) + ' 可读下一页]');
                        }
                        lines.push('[命中处可用 offset 参数读取该段]');
                        return { success: true, isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
                    }
                    var out = 'URL: ' + url + '\n标题: ' + (data.title || '(无标题)') + '\n\n' + (data.text || '');
                    if (data.note) out += '\n[提示: ' + data.note + ']';
                    return { success: true, isError: false, content: [{ type: 'text', text: out }] };
                }
                var errMsg = (data && data.error) ? data.error : '页面抓取返回异常';
                throw new Error(errMsg);
            }).catch(function (e) {
                clearTimeout(fetchTimer);
                var msg = (e && e.name === 'AbortError') ? '页面抓取超时（15s）' : (e && e.message ? e.message : String(e));
                return { success: false, isError: true, content: [{ type: 'text', text: 'read_url 失败: ' + msg }] };
            });
        }

        return { bridgeFetchPageUrl: bridgeFetchPageUrl, handleReadUrl: handleReadUrl };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createUrlReadTool = createUrlReadTool;
})(typeof global !== 'undefined' ? global : window);