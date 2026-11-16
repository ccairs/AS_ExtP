// petWebSearch.js — 联网搜索，通过 Bridge Server /api/web-search 端点
(function (global) {
    'use strict';

    // Bridge 端口可能因 9877 被占而回退到 9878-9886，用 Bridge.getBridgeUrl() 动态获取
    function _bridgeWebSearchUrl() {
        return (global.Bridge && global.Bridge.getBridgeUrl ? global.Bridge.getBridgeUrl() : 'http://127.0.0.1:9877') + '/api/web-search';
    }
    var _lastSearchTime = 0;
    var _throttleMs = 1000;
    var _enabled = true;

    // 失败态文案：与 client/modules/agent/engine/controller/webSearchTool.js 同口径
    // ——同一端点、同一套失败分支；只回「HTTP N」时调用方 LLM 无从区分「改查询」与「改道」，
    // 桥的失败响应体里带着可读原因，一并透出并给出指引。两处文案由单测跨文件断言钉住同步。
    function _httpFailText(status, reason) {
        var r = reason ? '（' + reason + '）' : '';
        if (status >= 400 && status < 500) {
            return '搜索请求失败: HTTP ' + status + r + '。本地搜索服务拒绝了本次请求（多为查询内容问题）；请调整查询后重试，不要原样重复。';
        }
        return '搜索请求失败: HTTP ' + status + r + '。本地搜索服务无法完成搜索（搜索引擎不可达或服务异常）；请改用本地知识作答，并如实告知用户联网搜索暂不可用，不要立即反复重试。';
    }

    function _exceptionText(e) {
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
    function _bodyFailText(data) {
        var errMsg = (data && data.error) ? String(data.error) : '响应缺少结果数据';
        return '搜索返回异常（' + errMsg + '）。请改用本地知识作答，不要原样重复本查询。';
    }

    // 200 但一条都没解析出来（桥标 degraded）：与 Agent 工具侧同口径按失败结算——
    // resolve([]) 会让桌宠 LLM 把「引擎没解析到」当成「确实没有结果」。文案保留三种成因。
    function _degradedText(data) {
        var note = (data && data.note) ? String(data.note) : '响应里没有可解析的结果';
        return '搜索未返回可解析结果（' + note + '）。不要据此断言没有相关资料；可换更通用的关键词重试，不要原样重复；或改用本地知识作答并如实告知用户本次未取得结果。';
    }

    function createWebSearch() {
        var _pendingTimer = null;
        // 节流 pending Promise 的 reject 引用：新请求覆盖旧 timer 时用来 settle 旧 Promise
        var _pendingReject = null;
        var _destroyed = false;
        // 在途 fetch 的 AbortController：destroy() 用它中止请求（只清节流 timer 时
        // 在途请求会跑满 8s 并把「已销毁」误报成「搜索超时（8s）」）
        var _inflight = null;

        function init() {}

        // 每次搜索前实时读 settings，确保用户改设置后立即生效
        function _isEnabled() {
            try {
                if (global.AEDeepseekPet && global.AEDeepseekPet.settings) {
                    var s = global.AEDeepseekPet.settings.getSettings();
                    if (s && s.webSearchEnabled !== undefined) {
                        _enabled = s.webSearchEnabled;
                    }
                }
            } catch (e) {}
            return _enabled;
        }

        function search(query, num) {
            if (_destroyed) return Promise.reject(new Error('webSearch destroyed'));
            if (!_isEnabled()) return Promise.reject(new Error('搜索功能已关闭'));
            // 空白 query 本地拒绝：直送桥会回 400「Missing query」，再被套上
            // 「多为查询内容问题；请调整查询」的指引，把「没给词」误导成「词不好」
            var queryText = (query == null) ? '' : String(query).trim();
            if (!queryText) return Promise.reject(new Error('搜索关键词不能为空'));

            var now = Date.now();
            if (now - _lastSearchTime < _throttleMs) {
                return new Promise(function (resolve, reject) {
                    var wait = _throttleMs - (now - _lastSearchTime);
                    // 清除上一次未触发的 pending timer，并 settle 其 Promise
                    // 否则旧 Promise 的 resolve/reject 永远不会被调用 -> 永久悬挂
                    if (_pendingTimer) {
                        clearTimeout(_pendingTimer);
                        _pendingTimer = null;
                        if (_pendingReject) {
                            var oldReject = _pendingReject;
                            _pendingReject = null;
                            oldReject(new Error('搜索被后续请求替换'));
                        }
                    }
                    _pendingTimer = setTimeout(function () {
                        _pendingTimer = null;
                        _pendingReject = null;
                        // 加 reject 避免递归 search reject 时外层 Promise 永久悬挂
                        search(queryText, num).then(resolve, reject);
                    }, wait);
                    _pendingReject = reject;
                });
            }
            _lastSearchTime = now;

            // num 钳制与 Agent 工具侧同口径 [1,20]：num 直传时不钳制（负数由桥回落默认 5，
            // 工具侧则钳到 1）。不提供 page——上游不认翻页参数（见 bridge-server 常量处实测注释）。
            var numClamped = Math.min(20, Math.max(1, Number(num) || 5));

            // fetch 超时保护：8s 后 abort，避免 executeTool 的 10s 超时先触发而丢失错误日志
            var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            _inflight = controller;
            var fetchTimer = setTimeout(function () {
                if (controller) controller.abort();
            }, 8000);

            var fetchHeaders = { 'Content-Type': 'application/json' };
            var fetchOpts = {
                method: 'POST',
                headers: fetchHeaders,
                body: JSON.stringify({ query: queryText, num: numClamped })
            };
            if (controller) fetchOpts.signal = controller.signal;

            return fetch(_bridgeWebSearchUrl(), fetchOpts).then(function (res) {
                clearTimeout(fetchTimer);
                return res.text().then(function (body) {
                    var data = null;
                    try { data = JSON.parse(body); } catch (_) {}
                    if (!res.ok) {
                        console.warn('[petWebSearch] HTTP ' + res.status + ' ' + res.statusText + ' (url=' + _bridgeWebSearchUrl() + ')');
                        return { fail: _httpFailText(res.status, (data && data.error) ? data.error : '') };
                    }
                    // Bridge 返回错误时把 error 透传出去，不要吞成空数组；
                    // 一条都没解析出来（degraded）同样按失败结算，不当「确实没有结果」
                    if (data && data.ok && data.results) {
                        if (data.results.length === 0 || data.degraded) return { fail: _degradedText(data) };
                        return { results: data.results };
                    }
                    return { fail: _bodyFailText(data) };
                });
            }).catch(function (e) {
                clearTimeout(fetchTimer);
                if (_destroyed) return { fail: 'webSearch destroyed' };
                return { fail: _exceptionText(e) };
            }).then(function (out) {
                _inflight = null;
                if (out && out.fail) {
                    console.warn('[petWebSearch] search failed: ' + out.fail + ' (query=' + queryText + ', url=' + _bridgeWebSearchUrl() + ')');
                    throw new Error(out.fail);
                }
                return out.results;
            });
        }

        function setEnabled(enabled) { _enabled = !!enabled; }
        function isEnabled() { return _isEnabled(); }

        function destroy() {
            _destroyed = true;
            // 中止在途 fetch：否则它继续跑满 8s，调用方拿到的还是「搜索超时（8s）」
            if (_inflight) {
                try { _inflight.abort(); } catch (_) {}
                _inflight = null;
            }
            if (_pendingTimer) {
                clearTimeout(_pendingTimer);
                _pendingTimer = null;
                // settle 挂起的 Promise，避免调用方永久 await
                if (_pendingReject) {
                    var r = _pendingReject;
                    _pendingReject = null;
                    r(new Error('webSearch destroyed'));
                }
            }
        }

        return {
            init: init,
            search: search,
            setEnabled: setEnabled,
            isEnabled: isEnabled,
            destroy: destroy
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createWebSearch = createWebSearch;
})(window);
