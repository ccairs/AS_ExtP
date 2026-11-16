(function (global) {
    'use strict';
    // 在线 Skill 目录查询工具实现层。与 webSearchTool.js / readUrlTool.js 平级，
    // 由 controller.js 组装区经 AEEngine.createSkillStoreTool() 创建。
    // 通过 Bridge /api/skill-store 拉取并归一化官方 anthropics/skills 目录，
    // 返回可直接用于 skill_manager install source=url 的裸 SKILL.md 下载链接，
    // 不受中文市场搜索引擎结果污染，绕开"搜索→落地页→读不到正文"的死循环。
    function createSkillStoreTool(opts) {
        function bridgeSkillStoreUrl() {
            return (global.Bridge && global.Bridge.getBridgeUrl ? global.Bridge.getBridgeUrl() : 'http://127.0.0.1:9877') + '/api/skill-store';
        }

        function handleSearchSkillStore(args) {
            args = args || {};
            var query = String(args.query || '').trim();
            var limit = Math.min(20, Math.max(1, Number(args.limit) || 10));
            var offset = Math.max(0, Number(args.offset) || 0);
            var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            // 35s：首次拉 catalog 最坏链路 = 目录列表（8s GitHub 超时回退 jsdelivr 8s）+ 逐 SKILL.md 下载
            //（8s raw 超时回退 jsdelivr 下载数秒），TTL 缓存后为毫秒级
            var fetchTimer = setTimeout(function () { if (controller) controller.abort(); }, 35000);
            var fetchOpts = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: query, limit: limit, offset: offset })
            };
            if (controller) fetchOpts.signal = controller.signal;
            return fetch(bridgeSkillStoreUrl(), fetchOpts).then(function (res) {
                clearTimeout(fetchTimer);
                if (!res.ok) {
                    // 非 2xx 时 bridge 响应体带具体原因（目录拉取失败原因等），只报状态码
                    // 会丢掉可执行信息。读 body 的 error/detail 并入文案；body 读不出/
                    // 非 JSON 时回退旧文案（行为兼容）。
                    return res.text().then(function (body) {
                        var eb = null;
                        try { eb = JSON.parse(body); } catch (_) {}
                        var reason = '';
                        if (eb && eb.error) reason = eb.detail ? String(eb.error) + '：' + String(eb.detail) : String(eb.error);
                        else if (eb && eb.detail) reason = String(eb.detail);
                        throw new Error('Skill 目录请求失败: HTTP ' + res.status + (reason ? '（' + reason + '）' : ''));
                    }, function () {
                        throw new Error('Skill 目录请求失败: HTTP ' + res.status);
                    });
                }
                return res.json();
            }).then(function (data) {
                if (data && data.ok) {
                    var text = String(data.text || '');
                    if (data.note) text += '\n[提示: ' + data.note + ']';
                    return { success: true, isError: false, content: [{ type: 'text', text: text }] };
                }
                var errMsg = (data && data.error) ? data.error : 'Skill 目录返回异常';
                throw new Error(errMsg);
            }).catch(function (e) {
                clearTimeout(fetchTimer);
                var msg = (e && e.name === 'AbortError') ? 'Skill 目录请求超时（35s）' : (e && e.message ? e.message : String(e));
                return { success: false, isError: true, content: [{ type: 'text', text: 'search_skill_store 失败: ' + msg }] };
            });
        }

        return { bridgeSkillStoreUrl: bridgeSkillStoreUrl, handleSearchSkillStore: handleSearchSkillStore };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createSkillStoreTool = createSkillStoreTool;
})(typeof global !== 'undefined' ? global : window);