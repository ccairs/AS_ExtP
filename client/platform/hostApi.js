(function (global) {
    var _apiDir = '';
    function _getApiDir() {
        if (_apiDir) return _apiDir;
        try {
            var r = (typeof window !== 'undefined' && window.__ext_root) ? String(window.__ext_root).replace(/\\/g, '/') : '';
            _apiDir = r ? r + '/host/api' : '';
        } catch (_) {}
        return _apiDir;
    }

    function createHostApi(bridge) {
        const hostBridge = bridge;

        function call(script, timeoutMs) {
            return new Promise((resolve) => {
                if (!hostBridge) {
                    resolve({ ok: false, result: '', error: 'HOST_BRIDGE_UNAVAILABLE' });
                    return;
                }
                var apiDir = _getApiDir();
                var guarded = script;
                if (apiDir) {
                    // apiDir 拼进 ExtendScript 字符串字面量：转义双引号，防路径含 " 破坏脚本串；
                    // U+2028/U+2029 是 ES3 字面量中的行终止符，未转义同样会让整条 evalScript 解析失败
                    var q = apiDir.replace(/"/g, '\\"')
                        .replace(/\u2028/g, '\\u2028')
                        .replace(/\u2029/g, '\\u2029');
                    // beginPresetApply/applyPresetToLayersRange 探测：AE 会话内升级扩展后
                    // 升级前的 presetApi 仍在内存，缺此探测会让分块预设应用报"函数未定义"
                    // （其余三个探测同理防缺接口的模块；probeNativeHotbox 同因——）
                    guarded = 'if(typeof getSelectionInfo!=="function"||typeof getProjectState!=="function"||typeof getApplicationInfo!=="function"||typeof beginPresetApply!=="function"||typeof applyPresetToLayersRange!=="function"||typeof probeNativeHotbox!=="function"){' +
                        'try{$.evalFile("' + q + '/runtimeApi.jsx")}catch(e){}' +
                        'try{$.evalFile("' + q + '/projectAssetApi.jsx")}catch(e){}' +
                        'try{$.evalFile("' + q + '/presetApi.jsx")}catch(e){}' +
                        'try{$.evalFile("' + q + '/json2.jsx")}catch(e){}' +
                        '}' + script;
                }
                hostBridge.evalScript(guarded, timeoutMs || 8000, (resp) => {
                    resolve(resp);
                });
            });
        }

        return {
            call,
            checkBridgeReady() {
                const checkScript = '(function(){try{return (typeof getApplicationInfo === "function") ? (typeof getProjectInfo === "function" ? "OK" : "OK_NO_MCP") : "MISSING_HOST_FUNCTIONS";}catch(e){return "ERROR:" + e.toString();}})();';
                return call(checkScript, 4000);
            }
        };
    }

    global.AEPlatform = global.AEPlatform || {};
    global.AEPlatform.createHostApi = createHostApi;
})(window);
