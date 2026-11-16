(function (global) {

    var TEMPLATE_DEFAULTS = {
        optionEnabled: true,
        maxItems: 10
    };

    function createTemplateController(context) {
        var ctx = context || {};
        var settingsStore = ctx.settingsStore;
        var hostApi = ctx.hostApi;
        var toolRegistry = ctx.toolRegistry;

        // ---- 内部状态 ----
        var _data = [];

        // ---- 初始化 ----
        function init() {
            console.warn('[Template] ' + '控制器初始化');
        }

        function destroy() {
            _data = [];
        }

        // ---- 设置 ----
        function getSettings() {
            if (!settingsStore || typeof settingsStore.getModuleSettings !== 'function') {
                return Promise.resolve(TEMPLATE_DEFAULTS);
            }
            return settingsStore.getModuleSettings('template-module', TEMPLATE_DEFAULTS);
        }

        function saveSettings(settings) {
            if (settingsStore && typeof settingsStore.setModuleSettings === 'function') {
                return settingsStore.setModuleSettings('template-module', settings);
            }
            return Promise.resolve();
        }

        // ---- 业务方法示例 ----
        function getData() {
            return _data.slice();
        }

        function addItem(item) {
            if (_data.length >= TEMPLATE_DEFAULTS.maxItems) return false;
            _data.push(item);
            return true;
        }

        return {
            init: init,
            destroy: destroy,
            getSettings: getSettings,
            saveSettings: saveSettings,
            getData: getData,
            addItem: addItem,
            // 暴露依赖给 view
            getHostApi: function () { return hostApi; },
            getToolRegistry: function () { return toolRegistry; }
        };
    }

    global.AEModuleTemplate = global.AEModuleTemplate || {};
    global.AEModuleTemplate.createTemplateController = createTemplateController;
})(window);
