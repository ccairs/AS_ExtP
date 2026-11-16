(function (global) {
    // 节点 DOM 渲染：
    //   备注（常驻，无则隐藏）
    //   头部：标题 + 收起/展开按钮（▼ 展开 / ▲ 收起）
    //   本体：上游缩略图行（index.js _refreshNodeThumbnails 填充）
    //   下方编辑区（展开显示，节点特有）
    //   连线方式：鼠标靠近节点左右边缘 → 弹出跟随圆圈 → 拖线连接（canvasController 处理）
    //   变色/复制/删除/备注 等移入右键菜单（canvasController.bindNodeContextMenu），不再占顶部工具条
    function createNodeEl(nodeDef, node, worldEl, callbacks, opts) {
        callbacks = callbacks || {};

        var wrap = document.createElement('div');
        wrap.className = 'ng-node';
        wrap.dataset.nodeId = node.id;
        wrap.style.left = node.x + 'px';
        wrap.style.top = node.y + 'px';
        if (node.color) {
            wrap.style.borderColor = node.color;
            var r = parseInt(node.color.slice(1,3), 16);
            var g = parseInt(node.color.slice(3,5), 16);
            var b = parseInt(node.color.slice(5,7), 16);
            wrap.style.backgroundColor = 'rgba(' + r + ',' + g + ',' + b + ', 0.08)';
        }

        // 备注气泡（节点上方）
        var note = document.createElement('div');
        note.className = 'ng-node-note';
        note.textContent = node.note || '';
        if (!node.note) note.classList.add('ng-hidden');
        wrap.appendChild(note);

        // 头部：标题 + 折叠按钮
        var head = document.createElement('div');
        head.className = 'ng-node-head';
        var title = document.createElement('div');
        title.className = 'ng-node-title';
        title.textContent = node.title || nodeDef.title || node.type;

        var isGen = nodeDef && (nodeDef.type === 'imageGen' || nodeDef.type === 'videoGen');
        // imageEdit 自带编辑预览（ng-iedit-preview），不再叠一行上游缩略图，否则重复
        var skipThumbs = isGen || (nodeDef && nodeDef.type === 'imageEdit');

        var toggleBtn = null;
        if (!isGen) {
            toggleBtn = document.createElement('span');
            toggleBtn.className = 'ng-node-toggle';
            toggleBtn.textContent = '▼';
            toggleBtn.title = AEI18n.t('收起/展开');
        }
        // 标题单击无效果（阻止冒泡到 head 避免 toggle），双击触发重命名
        title.addEventListener('click', function (e) {
            e.stopPropagation();
        });
        title.addEventListener('dblclick', function (e) {
            e.stopPropagation();
            if (callbacks.onRename) callbacks.onRename(node.id);
        });
        head.appendChild(title);
        if (toggleBtn) head.appendChild(toggleBtn);
        wrap.appendChild(head);

        // gen 节点的 text/video 输入端口不渲染常驻标记（视觉简洁）。
        // 端口锚点 Y 由 nodeSystem.ports.anchorY 统一算，连线落点仍准确；
        // 拖线时 canvasController 的悬浮圆圈按鼠标 Y 自适应选到对应端口。

        // ── 本体：缩略图行（上游连线图片缩略图，index.js _refreshNodeThumbnails 填充）──
        // gen 节点不渲染节点内缩略图——上游参考图在弹出输入容器顶层显示
        // imageEdit 自带编辑预览，不叠上游缩略图
        if (!skipThumbs) {
            var body = document.createElement('div');
            body.className = 'ng-node-body';
            var thumbs = document.createElement('div');
            thumbs.className = 'ng-thumbs ng-hidden';  // 初始隐藏，有上游图才显示
            body.appendChild(thumbs);
            wrap.appendChild(body);
        }

        var editor = document.createElement('div');
        editor.className = 'ng-node-editor';
        editor.classList.add('ng-editor-box');
        wrap.appendChild(editor);
        // renderEditor 不在此处调用——由 canvasIndex 在 _renderNode / _editNode 中
        // 传入正确的 editor callbacks (fillModels/getParams/onSend) 后调用。
        // 此处只建 DOM 壳，避免 createNodeEl 的生命周期回调误传给 renderEditor。

        // 右下角调整大小手柄（index.js bindNodeResize 绑拖拽）
        var resize = document.createElement('div');
        resize.className = 'ng-node-resize';
        resize.title = AEI18n.t('拖拽调整大小');
        wrap.appendChild(resize);

        var expanded = true;  // 默认展开
        function setExpanded(v) {
            expanded = v;
            editor.classList.toggle('ng-hidden', !v);
            wrap.classList.toggle('ng-node-expanded', v);
            if (toggleBtn) toggleBtn.textContent = v ? '▼' : '▶';
            // 折叠时清掉固定高度（节点缩到 head+body 自适应），展开时恢复用户调过的 height。
            // 否则调大后折叠仍撑着那么大，很怪。
            if (v) {
                if (node.params && node.params.height) wrap.style.height = node.params.height + 'px';
            } else {
                wrap.style.height = '';
            }
        }
        wrap.classList.add('ng-node-expanded');  // 初始展开
        // 单击节点任意位置选中（gen 节点自动弹出输入容器）
        wrap.addEventListener('click', function (e) {
            if (callbacks.onSelect) callbacks.onSelect(node.id, e);
        });
        // 折叠按钮单击切换展开/收起（gen 节点无此按钮）
        if (toggleBtn) {
            toggleBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                setExpanded(!expanded);
                if (callbacks.onSelect) callbacks.onSelect(node.id);
                if (callbacks.onToggle) callbacks.onToggle();
            });
        }

        // 备注双击编辑 / 右键"编辑备注"触发
        function _startNoteEdit() {
            // 先显示气泡（可能当前为空隐藏着）
            note.classList.remove('ng-hidden');
            var input = document.createElement('input');
            input.type = 'text';
            input.className = 'ng-note-input';
            input.value = node.note || '';
            input.placeholder = AEI18n.t('输入备注…');
            note.replaceWith(input);
            input.focus();
            input.select();
            // Escape 取消置位——DOM 移除聚焦 input 会同步触发 blur，
            // 防 cancel 后 commit 抢跑把用户本想放弃的值写入 node.note（对齐
            // canvasIndex 标题重命名的 cancelled 标志）
            var cancelled = false;
            function commit() {
                if (cancelled) return;
                var val = input.value.trim();
                node.note = val;
                if (callbacks.onNoteChange) callbacks.onNoteChange(node.id, node.note);
                note.textContent = val;
                note.classList.toggle('ng-hidden', !val);
                input.replaceWith(note);
            }
            function cancel() {
                cancelled = true;
                note.classList.toggle('ng-hidden', !node.note);
                input.replaceWith(note);
            }
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
                if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); }
            });
        }
        note.addEventListener('dblclick', function (e) {
            e.stopPropagation();
            _startNoteEdit();
        });
        // 单击气泡也触发编辑
        note.addEventListener('click', function (e) {
            e.stopPropagation();
            _startNoteEdit();
        });
        wrap._startNoteEdit = function () { _startNoteEdit(); };

        // 登场动画：仅在节点真正创建/进入画布时播放（opts.appear !== false）。
        // 布局刷新、参数/路径变更等重渲染走 _renderNode 时传 appear:false，避免每次都播缩放动画。
        if (!opts || opts.appear !== false) {
            wrap.classList.add('ng-node-appear');
            wrap.addEventListener('animationend', function () { wrap.classList.remove('ng-node-appear'); }, { once: true });
        }

        worldEl.appendChild(wrap);
        return wrap;
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createNodeEl = createNodeEl;
})(window);
