(function (global) {

    function createTemplateView(controller, container) {
        var _ctrl = controller;
        var _el = container;

        // ---- DOM 缓存 ----
        var _listEl = null;

        // ---- 构建 HTML ----
        function buildHtml() {
            var html = '';
            // 工具栏
            html += '<div class="template-toolbar">';
            html += AEI18n.html('<button class="btn" id="templateAddBtn">添加</button>');
            html += AEI18n.html('<button class="btn secondary" id="templateRefreshBtn">刷新</button>');
            html += '</div>';
            // 列表
            html += '<div class="template-list" id="templateList"></div>';
            return html;
        }

        // ---- 渲染列表 ----
        function renderList() {
            if (!_listEl) return;
            var data = _ctrl.getData();
            if (!data || data.length === 0) {
                _listEl.innerHTML = AEI18n.html('<div class="template-empty">暂无数据</div>');
                return;
            }
            var html = '';
            data.forEach(function (item, i) {
                html += '<div class="template-item">';
                html += '<span>' + (item.name || 'Item ' + (i + 1)) + '</span>';
                html += '</div>';
            });
            _listEl.innerHTML = html;
        }

        // ---- 事件绑定 ----
        function bindEvents() {
            var addBtn = document.getElementById('templateAddBtn');
            var refreshBtn = document.getElementById('templateRefreshBtn');

            if (addBtn) addBtn.addEventListener('click', function () {
                _ctrl.addItem({ name: 'New Item ' + Date.now() });
                renderList();
            });

            if (refreshBtn) refreshBtn.addEventListener('click', function () {
                renderList();
            });
        }

        // ---- 公开接口 ----
        return {
            render: function () {
                if (_el) {
                    _el.innerHTML = buildHtml();
                }
                _listEl = document.getElementById('templateList');
                bindEvents();
                renderList();
                console.warn('[Template] ' + '视图渲染完成');
            },

            destroy: function () {
                _listEl = null;
                _el = null;
            }
        };
    }

    global.AEModuleTemplate = global.AEModuleTemplate || {};
    global.AEModuleTemplate.createTemplateView = createTemplateView;
})(window);
