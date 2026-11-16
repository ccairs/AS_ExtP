(function (global) {
    var mounted = false;
    var controller = null;
    var skillView = null;

    var skillManagerModule = {
        id: 'skill-manager',
        // getter：模块对象在文件加载时求值，翻译推迟到读取时
        get title() { return AEI18n.t('Skill 管理'); },
        get description() { return AEI18n.t('Skill 安装（商店/URL/本地）、创作与作用域管理，Meta-Tool 按需调用'); },
        panelId: 'skillManagerPanel',

        mount(containerContext) {
            if (mounted) {
                return;
            }

            try {
                controller = global.AESkillManager.createSkillManagerController(containerContext);

                var skillInstaller = controller.getSkillInstaller();
                var settingsStore = controller.getSettingsStore();
                var skillRegistry = controller.getSkillRegistry();

                var availableModules = [];
                if (global.AEModules) {
                    var modKeys = Object.keys(global.AEModules);
                    for (var k = 0; k < modKeys.length; k++) {
                        var m = global.AEModules[modKeys[k]];
                        if (m && m.id && m.title) {
                            availableModules.push({ id: m.id, title: m.title });
                        }
                    }
                }

                if (global.AE_LLM && typeof global.AE_LLM.createSkillView === 'function') {
                    skillView = global.AE_LLM.createSkillView({
                        registry: skillRegistry,
                        skillInstaller: skillInstaller,
                        settingsStore: settingsStore,
                        moduleId: 'skill-manager',
                        availableModules: availableModules,
                        onSkillListChanged: function () {
                            if (controller && typeof controller.refreshSkillToolDescription === 'function') {
                                controller.refreshSkillToolDescription();
                            }
                        },
                    });
                }

                // Skill tool 在 bootstrap 时已注册。这里只获取 updateDescription 引用，
                // 确保运行时 skill 变更（安装/卸载）能同步更新工具描述。
                var toolRegistry = containerContext.toolRegistry;
                if (toolRegistry && controller && typeof controller.setToolRegistry === 'function') {
                    controller.setToolRegistry(toolRegistry);
                }

                // skill_manager LLM 工具已在 bootstrap.js initSkillTools 中注册（早于模块挂载），
                // LLM 不依赖用户打开 skill 面板即可调用。此处无需重复注册。

                var body = document.getElementById('skillMgmtBody');
                if (skillView && body) {
                    skillView.render(body);
                }

                controller.init(function () {
                    if (skillView && typeof skillView.renderList === 'function') {
                        skillView.renderList();
                    }
                });

                mounted = true;
            } catch (e) {
                console.error('[AE_SKILL] mount failed:', e);
                // mount 半途失败时，已创建的 skillView 先 destroy 再置空
                //（与 unmount 清理路径一致），否则其监听器/已开弹窗残留
                if (skillView && typeof skillView.destroy === 'function') {
                    try { skillView.destroy(); } catch (_) {}
                }
                mounted = false;
                controller = null;
                skillView = null;
            }
        },

        unmount() {
            if (!mounted) {
                return;
            }
            mounted = false;

            if (skillView && typeof skillView.destroy === 'function') {
                skillView.destroy();
            }
            if (controller && typeof controller.destroy === 'function') {
                controller.destroy();
            }
            skillView = null;
            controller = null;
        },

        getSkillInjector: function () {
            return controller ? controller.getSkillInjector() : null;
        },

        getSkillRegistry: function () {
            return controller ? controller.getSkillRegistry() : null;
        },

        showSettings: function () { showSkillSettingsModal(); },

        refresh: function () {
            if (skillView && typeof skillView.renderList === 'function') {
                skillView.renderList();
            }
        }
    };

    var SKILL_SETTINGS_CONTAINER = 'skillSettingsContainer';

    function showSkillSettingsModal() {
        var modalBody = document.querySelector('#settingsModal .modal-body');
        if (!modalBody) return;

        var html = '<div id="' + SKILL_SETTINGS_CONTAINER + '">';
        html += AEI18n.html('<div class="btn-row"><button class="btn secondary" id="skillSettingsAboutBtn">关于模块</button></div>');
        html += '</div>';

        modalBody.innerHTML = html;

        var aboutBtn = document.getElementById('skillSettingsAboutBtn');
        if (aboutBtn) aboutBtn.addEventListener('click', function () {
            showAboutModal('module', { name: AEI18n.t('Skill 管理'), desc: AEI18n.t('安装、编辑和管理 Agent Skills') });
        });

        // 打开弹窗
        if (typeof global.openModal === 'function') {
            global.openModal('settingsModal');
        }
    }

    global.AEModules = global.AEModules || {};
    global.AEModules.skillManagerModule = skillManagerModule;
})(window);
