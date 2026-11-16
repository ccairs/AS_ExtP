(function (global) {
    var mounted = false;
    var _controller = null;
    var _view = null;

    var SETTINGS_CONTAINER = 'templateSettingsContainer';

    function showSettingsModal() {
        var modalBody = document.querySelector('#settingsModal .modal-body');
        if (!modalBody) return;

        var html = '<div id="' + SETTINGS_CONTAINER + '">';
        html += AEI18n.html('<div class="btn-row"><button class="btn secondary" id="templateSettingsAboutBtn">关于模块</button></div>');
        html += '</div>';

        modalBody.innerHTML = html;

        var aboutBtn = document.getElementById('templateSettingsAboutBtn');
        if (aboutBtn) aboutBtn.addEventListener('click', function () {
            global.showAboutModal('module', { name: 'Template Module', desc: AEI18n.t('模块描述写在这里') });
        });

        if (typeof global.openModal === 'function') {
            global.openModal('settingsModal');
        }
    }

    var templateModule = {
        id: 'template-module',
        title: 'Template Module',
        get description() { return AEI18n.t('模块简要描述，修改为实际功能说明'); },
        panelId: 'templatePanel',

        mount: function (containerContext) {
            if (mounted) return;
            mounted = true;

            var panel = document.getElementById('templatePanel');
            if (panel) panel.classList.remove('hidden');

            _controller = global.AEModuleTemplate.createTemplateController(containerContext);

            var body = document.getElementById('templateBody');
            if (body) {
                _view = global.AEModuleTemplate.createTemplateView(_controller, body);
                _view.render();
            }

        },

        showSettings: function () { showSettingsModal(); },

        unmount: function () {
            if (!mounted) return;
            mounted = false;

            var panel = document.getElementById('templatePanel');
            if (panel) panel.classList.add('hidden');

            if (_view && typeof _view.destroy === 'function') {
                _view.destroy();
            }
            _view = null;
            if (_controller && typeof _controller.destroy === 'function') {
                _controller.destroy();
            }
            _controller = null;
        }
    };

    global.AEModules = global.AEModules || {};
    global.AEModules.templateModule = templateModule;
})(window);
