(function (global) {
    'use strict';

    // ============================================================================
    // 自定义工作流格式归一（导入链路编排层）
    // ComfyUI 编辑器「Save」产出 UI 格式（顶层 nodes/links/extra），而
    // templateEngine.loadCustomWorkflow 只认 API 格式（顶层每键一个节点，含
    // class_type/inputs）。本模块：格式嗅探 →（UI 格式时）取 /object_info 全量目录
    // → uiToApi.convert → 返回可直接注册的 API 对象。任何失败都不产出半成品
    // （调用方按 ok 判定，失败必须可见报错、不得静默注册空参数模板）。
    // 消费方：controller.importWorkflowFile（手动导入）、
    //        controller.loadWorkflowsFromDir（固定工作流目录自动加载 / 连接后补转换）。
    // 加载序：controller/view 早于本模块（scripts.manifest 排在 uiToApi.js 后），
    // 故 uiToApi 一律调用点取，不顶层缓存。
    // ============================================================================

    // API 格式闸：与 templateEngine.validateWorkflow 同口径（引擎实例在编排层不可得，
    // 故本地实现；差异：本实现对 null/非对象节点给错误而不抛 TypeError）。
    function _apiFormatErrors(wf) {
        var errors = [];
        var keys = Object.keys(wf);
        for (var i = 0; i < keys.length; i++) {
            var node = wf[keys[i]];
            if (!node || typeof node !== 'object' || Array.isArray(node)) {
                errors.push(AEI18n.t('节点 {id} 不是对象', { id: keys[i] }));
                continue;
            }
            if (!node.class_type) errors.push(AEI18n.t('节点 {id} 缺少 class_type', { id: keys[i] }));
            if (!node.inputs || typeof node.inputs !== 'object') errors.push(AEI18n.t('节点 {id} 缺少 inputs', { id: keys[i] }));
        }
        return errors;
    }

    // 格式嗅探：顶层任一值含 class_type → API 格式
    function _isApiFormat(wf) {
        var keys = Object.keys(wf);
        for (var i = 0; i < keys.length; i++) {
            var v = wf[keys[i]];
            if (v && typeof v === 'object' && !Array.isArray(v) && v.class_type) return true;
        }
        return false;
    }

    /**
     * 自定义工作流格式归一：UI 格式（编辑器 Save）→ API 格式，API 格式直通。
     * @param {string} rawJson          文件原始文本
     * @param {object} opts             {service, requireCatalog}
     *        service        提供 getObjectInfo()（UI 格式转换必须，需已连接 ComfyUI）
     *        requireCatalog false = 启动期离线快速判定：UI 格式不做任何网络尝试，
     *                        直接以 NO_CATALOG 返回，由调用方记入「待转换」清单
     * @returns {{ok:true, data:{workflow:object, converted:boolean}} |
     *           {ok:false, error:{code:string, message:string}}}
     */
    async function normalizeWorkflow(rawJson, opts) {
        opts = opts || {};
        var wf;
        try {
            wf = JSON.parse(String(rawJson));
        } catch (_) {
            return { ok: false, error: { code: 'INVALID_JSON', message: AEI18n.t('不是合法的 JSON 文件') } };
        }
        if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
            return { ok: false, error: { code: 'UNKNOWN_FORMAT', message: AEI18n.t('无法识别的工作流格式：JSON 顶层不是对象') } };
        }

        // ① API 格式直通：零转换、离线可用（不需要 uiToApi / catalog）
        if (_isApiFormat(wf)) {
            var apiErrors = _apiFormatErrors(wf);
            if (apiErrors.length) {
                return { ok: false, error: { code: 'API_FORMAT_INVALID', message: AEI18n.t('工作流节点结构不完整: ') + apiErrors.join(AEI18n.punct('；', '; ', '、')) } };
            }
            return { ok: true, data: { workflow: wf, converted: false } };
        }

        // ② UI 格式（编辑器 Save：顶层 nodes/links 数组）
        if (!Array.isArray(wf.nodes) || !Array.isArray(wf.links)) {
            return {
                ok: false,
                error: { code: 'UNKNOWN_FORMAT', message: AEI18n.t('无法识别的工作流格式（既不是 ComfyUI API 格式，也不是编辑器保存的 UI 格式）') }
            };
        }

        if (opts.requireCatalog === false) {
            return { ok: false, error: { code: 'NO_CATALOG', message: AEI18n.t('UI 格式工作流需连接 ComfyUI 后转换') } };
        }

        var conv = (global.AEComfyUI && global.AEComfyUI.uiToApi) ? global.AEComfyUI.uiToApi : null;
        if (!conv || typeof conv.convert !== 'function') {
            return { ok: false, error: { code: 'MODULE_MISSING', message: AEI18n.t('转换模块 uiToApi 未加载') } };
        }
        var service = opts.service;
        if (!service || typeof service.getObjectInfo !== 'function') {
            return { ok: false, error: { code: 'NO_CATALOG', message: AEI18n.t('获取 ComfyUI 节点信息失败（需先连接 ComfyUI）') } };
        }
        var catalog;
        try {
            catalog = await service.getObjectInfo();
        } catch (e) {
            return {
                ok: false,
                error: { code: 'NO_CATALOG', message: AEI18n.t('获取 ComfyUI 节点信息失败（需先连接 ComfyUI）: ') + ((e && e.message) || String(e)) }
            };
        }
        var converted;
        try {
            converted = conv.convert(wf, catalog);
        } catch (e2) {
            return { ok: false, error: { code: 'CONVERT_FAIL', message: AEI18n.t('工作流转换失败: ') + ((e2 && e2.message) || String(e2)) } };
        }
        if (!converted || !converted.ok) {
            // 转换器错误原文透出（NODE_NOT_FOUND=节点没装 / MUTED_NODE=有静音节点 /
            // SUBGRAPH_UNSUPPORTED=含子图 …），用户才分得清病因
            return {
                ok: false,
                error: { code: 'CONVERT_FAIL', message: AEI18n.t('工作流转换失败: ') + ((converted && converted.error && converted.error.message) || AEI18n.t('未知错误')) }
            };
        }
        // 转换产物必须过 API 格式闸（过不了 = 转换器缺陷，附节点便于报障）
        var postErrors = _apiFormatErrors(converted.data);
        if (postErrors.length) {
            return { ok: false, error: { code: 'CONVERT_FAIL', message: AEI18n.t('工作流转换产物校验失败（可能是转换器缺陷）: ') + postErrors.join(AEI18n.punct('；', '; ', '、')) } };
        }
        // skipped 透传：转换器跳过的「缺目录界面控制节点」明细（rgthree 旁路开关一族）。
        // 调用方据此给用户可见提示——跳过是有意为之，但不能无声。
        var outData = { workflow: converted.data, converted: true };
        if (converted.skipped && converted.skipped.length) outData.skipped = converted.skipped;
        return { ok: true, data: outData };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.customWorkflow = {
        normalizeWorkflow: normalizeWorkflow
    };
})(typeof global !== 'undefined' ? global : window);
