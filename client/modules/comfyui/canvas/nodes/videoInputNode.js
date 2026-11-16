(function (global) {
    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.nodeDefs = global.AEComfyUI.nodeDefs || {};

    // 视频输入节点：视频进画布的起点。无输入、只输出 video。
    // UI 仿 comfyui 图槽：拖拽/点击选择/粘贴 + 预览 + 清空（视频无截帧）。
    global.AEComfyUI.nodeDefs.videoInput = {
        type: 'videoInput',
        get title() { return AEI18n.t('视频输入'); },
        category: '输入',
        inputs: [],
        outputs: [{ name: 'video', type: 'video' }],
        defaultParams: { path: null },
        execute: function (inputs, params) {
            return { video: params.path || null };
        },
        renderEditor: function (el, node, ctx) {
            ctx = ctx || {};
            // 复用 imageInputNode 的辅助函数（_inputClear/_inputPaste/_inputDropFile/_inputPickFile）
            var h = global.AEComfyUI;
            el.innerHTML =
                '<div class="ng-drop" data-media="video">' +
                AEI18n.html('<button class="ng-drop-btn ng-paste-btn" title="粘贴视频" type="button">📋</button>') +
                AEI18n.html('<div class="ng-drop-empty">拖拽 / 点击 / 粘贴</div>') +
                '<video class="ng-drop-preview" preload="metadata" style="display:none"></video>' +
                AEI18n.html('<span class="ng-drop-clear" title="清空" style="display:none">×</span>') +
                '</div>';
            var drop = el.querySelector('.ng-drop');
            var empty = el.querySelector('.ng-drop-empty');
            var preview = el.querySelector('.ng-drop-preview');
            var clearBtn = el.querySelector('.ng-drop-clear');

            function syncPreview() {
                var p = node.params && node.params.path;
                if (p) {
                    preview.src = global.AEComfyUI.toFileUrl(p);
                    preview.style.display = 'block';
                    empty.style.display = 'none';
                    clearBtn.style.display = 'flex';
                } else {
                    preview.src = '';
                    preview.style.display = 'none';
                    empty.style.display = '';
                    clearBtn.style.display = 'none';
                }
            }

            el.querySelector('.ng-paste-btn').addEventListener('click', function (e) {
                e.stopPropagation();
                if (h._inputPaste) h._inputPaste(node, ctx);
            });
            clearBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                node.params = node.params || {};
                node.params.path = null;
                syncPreview();
                if (h._inputClear) h._inputClear(node, ctx);
            });
            // 有视频时点预览 → 放大查看（带 controls 播放按键，与表单 lightbox 一致）
            // 预览态不带 controls，放大后才给播放控件。
            preview.addEventListener('click', function (e) {
                if (!node.params || !node.params.path) return;
                e.stopPropagation();
                if (global.AEComfyUI && global.AEComfyUI.openLightbox) global.AEComfyUI.openLightbox(preview.src, true);
            });
            drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('dragover'); });
            drop.addEventListener('dragleave', function () { drop.classList.remove('dragover'); });
            drop.addEventListener('drop', function (e) {
                e.preventDefault();
                drop.classList.remove('dragover');
                if (h._inputDropFile) h._inputDropFile(node, ctx, e.dataTransfer);
            });
            drop.addEventListener('click', function (e) {
                if (e.target.classList.contains('ng-drop-btn') || e.target.classList.contains('ng-drop-clear') || e.target.classList.contains('ng-drop-preview')) return;
                if (h._inputPickFile) h._inputPickFile(node, ctx);
            });

            syncPreview();
            el._syncPreview = syncPreview;
        }
    };
})(window);
