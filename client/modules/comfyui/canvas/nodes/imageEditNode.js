(function (global) {
    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.nodeDefs = global.AEComfyUI.nodeDefs || {};

    global.AEComfyUI.nodeDefs.imageEdit = {
        type: 'imageEdit',
        get title() { return AEI18n.t('图片编辑'); },
        category: '生成',
        inputs: [{ name: 'image', type: 'image' }],
        outputs: [{ name: 'image', type: 'image' }],
        defaultParams: { editedPath: null },
        execute: function (inputs, params) {
            return { image: (params && params.editedPath) || (inputs && inputs.image) || null };
        },
        renderEditor: function (el, node, ctx) {
            ctx = ctx || {};
            el.innerHTML =
                '<div class="ng-iedit-preview">' +
                  AEI18n.html('<div class="ng-iedit-empty">接上游图后点击编辑</div>') +
                  '<img class="ng-iedit-thumb" style="display:none">' +
                  AEI18n.html('<button class="ng-iedit-btn">✏️ 编辑</button>') +
                '</div>';

            var empty = el.querySelector('.ng-iedit-empty');
            var thumb = el.querySelector('.ng-iedit-thumb');
            var btn = el.querySelector('.ng-iedit-btn');

            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (ctx && ctx.openImageEditor) ctx.openImageEditor(node.id);
            });

            function sync() {
                // 优先显示编辑结果（editedPath），无则回退上游输入图（与 execute 一致）。
                // 接上游图后即可预览，不必先点编辑。
                var p = (node.params && node.params.editedPath) || null;
                var fromUpstream = false;
                if (!p && ctx && typeof ctx.resolveUpstreamImage === 'function') {
                    p = ctx.resolveUpstreamImage(node.id);
                    fromUpstream = !!p;
                }
                if (p) {
                    thumb.src = global.AEComfyUI.toFileUrl(p);
                    thumb.style.display = 'block';
                    empty.style.display = 'none';
                    btn.textContent = fromUpstream ? AEI18n.t('✏️ 编辑') : AEI18n.t('✏️ 重新编辑');
                } else {
                    thumb.src = '';
                    thumb.style.display = 'none';
                    empty.style.display = '';
                    btn.textContent = AEI18n.t('✏️ 编辑');
                }
            }
            sync();
            // 暴露供外部 editedPath / 上游变更后刷新
            el._syncEditThumb = sync;
        }
    };
})(window);
