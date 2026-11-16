(function (global) {
    'use strict';

    // ============================================================================
    // 官方模板表单化编排（手调层统一为自动拉取）
    // 编排链：bridge fetch → uiToApi.convert（需 /object_info）→ templateDeriver.derive
    //        → 产出 pipeline 同构模板（parameters + {{key}} 占位符）
    // 消费方：controller.fetchOfficialTemplate（表单浏览/注册）；测试直调。
    // 与 bootstrap._bridgeComfyTemplates 分立（bootstrap 加载序在 controller 后，
    // 且 LLM 路径错误文案面向 LLM、本路径面向表单用户，各自演化）。
    // ============================================================================

    function _bridgeUrl() {
        return (global.Bridge && global.Bridge.getBridgeUrl ? global.Bridge.getBridgeUrl() : 'http://127.0.0.1:9877') + '/api/comfy-templates';
    }

    // bridge 调用（对齐 bootstrap 的超时档：fetch 最坏回退链路 60s → 75s）
    function _bridgeCall(action, payload, timeoutMs) {
        var timeout = timeoutMs || 75000;
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = setTimeout(function () { if (controller) controller.abort(); }, timeout);
        var body = { action: action };
        var keys = Object.keys(payload || {});
        for (var i = 0; i < keys.length; i++) body[keys[i]] = payload[keys[i]];
        var opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
        if (controller) opts.signal = controller.signal;
        return fetch(_bridgeUrl(), opts).then(function (res) {
            if (!res.ok) {
                return res.json().catch(function () { return null; }).then(function (errBody) {
                    throw new Error((errBody && errBody.error) ? errBody.error : 'HTTP ' + res.status);
                });
            }
            return res.json();
        }).catch(function (e) {
            if (e && e.name === 'AbortError') throw new Error('官方模板库请求超时（' + Math.round(timeout / 1000) + 's）');
            throw e;
        }).finally(function () { clearTimeout(timer); });
    }

    /**
     * 搜索官方模板库（表单浏览用，返回 bridge 原始响应）。
     */
    function search(query, category, limit, offset) {
        return _bridgeCall('search', {
            query: String(query || '').trim(),
            category: String(category || '').trim(),
            limit: Math.min(20, Math.max(1, Number(limit) || 10)),
            offset: Math.max(0, Number(offset) || 0)
        }, 45000);
    }

    /**
     * 拉取 + 转换 + 推导（不注册——注册由调用方原子完成）。
     * @param opts {name, service}  service 提供 getObjectInfo（全量目录，内部有缓存）
     * @returns {ok:true, data:{template, registryEntry}} | {ok:false, error:{code, message}}
     */
    async function fetchAndDerive(opts) {
        var name = String((opts && opts.name) || '').trim();
        if (!name) return { ok: false, error: { code: 'NO_NAME', message: '缺少模板 name' } };
        var service = opts && opts.service;
        var conv = (global.AEComfyUI && global.AEComfyUI.uiToApi) ? global.AEComfyUI.uiToApi : null;
        var deriver = (global.AEComfyUI && global.AEComfyUI.templateDeriver) ? global.AEComfyUI.templateDeriver : null;
        if (!conv || !deriver) {
            return { ok: false, error: { code: 'MODULE_MISSING', message: '转换/推导模块未加载' } };
        }

        // 1. bridge 拉模板（name 白名单在 bridge 侧校验）
        var resp;
        try {
            resp = await _bridgeCall('fetch', { name: name });
        } catch (e) {
            return { ok: false, error: { code: 'FETCH_FAIL', message: '模板获取失败: ' + (e.message || String(e)) } };
        }
        if (!resp || !resp.ok) {
            return { ok: false, error: { code: 'FETCH_FAIL', message: '模板获取失败: ' + ((resp && resp.error) || '未知错误') } };
        }
        var meta = resp.meta || {};

        // 2. /object_info 全量目录（service 内部有缓存；未连接时抛错由调用方提示）
        var catalog;
        try {
            catalog = await service.getObjectInfo();
        } catch (e) {
            return { ok: false, error: { code: 'NO_CATALOG', message: '获取 ComfyUI 节点信息失败（需先连接 ComfyUI）: ' + (e.message || String(e)) } };
        }

        // 3. UI→API 转换
        var converted = conv.convert(resp.template, catalog);
        if (!converted.ok) {
            return { ok: false, error: { code: 'CONVERT_FAIL', message: '模板转换失败: ' + converted.error.message } };
        }

        // 4. 参数推导（占位符化 + registry 条目）
        var derived = deriver.derive(converted.data, catalog, meta);
        if (!derived.ok) {
            return { ok: false, error: { code: 'DERIVE_FAIL', message: derived.error.message } };
        }
        return derived;
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.officialTemplates = {
        search: search,
        fetchAndDerive: fetchAndDerive
    };
})(typeof global !== 'undefined' ? global : window);
