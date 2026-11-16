(function (global) {
    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.nodeDefs = global.AEComfyUI.nodeDefs || {};

    global.AEComfyUI.nodeDefs.text = {
        type: 'text',
        get title() { return AEI18n.t('文本'); },
        category: '输入',
        inputs: [],
        outputs: [{ name: 'text', type: 'text' }],
        defaultParams: { text: '' },
        execute: function (inputs, params) {
            return { text: params.text || '' };
        },
        renderEditor: function (el, node, ctx) {
            ctx = ctx || {};
            el.classList.add('ng-editor-text');  // 禁用文本节点编辑器的滚动条
            var ta = document.createElement('textarea');
            ta.className = 'ng-text-area';
            ta.value = (node.params && node.params.text) || '';
            ta.placeholder = AEI18n.t('输入文本…');
            ta.addEventListener('input', function () {
                node.params = node.params || {};
                node.params.text = ta.value;
                // 改文本 → 清自身 + 下游 gen 缓存，防重新生成时用到旧 prompt（同 imageInputNode 改路径）
                if (ctx.invalidateCache) ctx.invalidateCache(node.id);
                if (ctx.markDirty) ctx.markDirty();
            });
            el.appendChild(ta);
        }
    };
})(window);
