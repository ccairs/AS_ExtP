(function (global) {

    function createSkillManagerController(context) {
        var ctx = context || {};
        var skillRegistry = ctx.skillRegistry || null;
        var skillInjector = null;
        var skillInstaller = null;
        var settingsStore = ctx.settingsStore || null;
        var _updateToolDescription = null;

        if (skillRegistry && global.AE_LLM && typeof global.AE_LLM.createSkillInjector === 'function') {
            skillInjector = global.AE_LLM.createSkillInjector({ registry: skillRegistry });
            global.AE_LLM.skillInjector = skillInjector;
        }

        // 复用 bootstrap 阶段创建的 skillInstaller（保证 LLM 工具与 UI 操作同一实例，状态一致）
        // 若 bootstrap 未创建（如旧调用路径），则就地创建作为兜底
        if (global.AE_LLM && global.AE_LLM.skillInstaller) {
            skillInstaller = global.AE_LLM.skillInstaller;
        } else if (global.AE_LLM && typeof global.AE_LLM.createSkillInstaller === 'function') {
            skillInstaller = global.AE_LLM.createSkillInstaller();
            global.AE_LLM.skillInstaller = skillInstaller;
        }

        // Skill 注册和工具安装已由 bootstrap.js 统一处理。controller 只负责运行时管理。

        return {
            init: function (onReady) {
                // Skill registry is populated at bootstrap time (bootstrap.js).
                if (typeof onReady === 'function') {
                    var count = skillRegistry ? skillRegistry.getCount() : 0;
                    onReady(count);
                }
            },

            destroy: function () {
                _updateToolDescription = null;
            },

            getSkillRegistry: function () {
                return skillRegistry;
            },

            getSkillInjector: function () {
                return skillInjector;
            },

            getSkillInstaller: function () {
                return skillInstaller;
            },

            getSettingsStore: function () {
                return settingsStore;
            },

            setToolRegistry: function (toolRegistry) {
                if (!toolRegistry || !skillInjector) return;
                _updateToolDescription = function () {
                    var def = toolRegistry.get('Skill');
                    if (def && typeof skillInjector.buildSkillsToolDescription === 'function') {
                        def.description = skillInjector.buildSkillsToolDescription();
                    }
                };
            },

            refreshSkillToolDescription: function () {
                if (_updateToolDescription && typeof _updateToolDescription === 'function') {
                    _updateToolDescription();
                }
            }
        };
    }

    global.AESkillManager = global.AESkillManager || {};
    global.AESkillManager.createSkillManagerController = createSkillManagerController;
})(window);
