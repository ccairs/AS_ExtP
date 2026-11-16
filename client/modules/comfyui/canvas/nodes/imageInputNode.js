(function (global) {
    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.nodeDefs = global.AEComfyUI.nodeDefs || {};

    // 图片输入节点：图进画布的起点。无输入、只输出 image。
    // UI 仿 comfyui 图槽：拖拽/点击选择/截帧/粘贴 + 预览 + 清空。
    // 实际落盘逻辑（captureCurrentFrame 等）在集成层 callbacks。
    global.AEComfyUI.nodeDefs.imageInput = {
        type: 'imageInput',
        get title() { return AEI18n.t('图片输入'); },
        category: '输入',
        inputs: [],
        outputs: [{ name: 'image', type: 'image' }],
        defaultParams: { path: null },
        execute: function (inputs, params) {
            return { image: params.path || null };
        },
        renderEditor: function (el, node, ctx) {
            ctx = ctx || {};
            el.innerHTML =
                '<div class="ng-drop" data-media="image">' +
                AEI18n.html('<button class="ng-drop-btn ng-capture-btn" title="截取AE当前帧" type="button">📷</button>') +
                AEI18n.html('<button class="ng-drop-btn ng-paste-btn" title="粘贴图片" type="button">📋</button>') +
                AEI18n.html('<div class="ng-drop-empty">拖拽 / 点击 / 截帧 / 粘贴</div>') +
                '<img class="ng-drop-preview" style="display:none" draggable="false">' +
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

            el.querySelector('.ng-capture-btn').addEventListener('click', function (e) {
                e.stopPropagation();
                _inputCapture(node, ctx);
            });
            el.querySelector('.ng-paste-btn').addEventListener('click', function (e) {
                e.stopPropagation();
                _inputPaste(node, ctx);
            });
            clearBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                node.params = node.params || {};
                node.params.path = null;
                syncPreview();
                _inputClear(node, ctx);
            });
            // 有图时点预览图 → 放大查看（与表单 lightbox 一致）；stopPropagation 防冒泡到 drop 的选文件
            preview.addEventListener('click', function (e) {
                if (!node.params || !node.params.path) return;
                e.stopPropagation();
                if (global.AEComfyUI && global.AEComfyUI.openLightbox) global.AEComfyUI.openLightbox(preview.src);
            });
            drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('dragover'); });
            drop.addEventListener('dragleave', function () { drop.classList.remove('dragover'); });
            drop.addEventListener('drop', function (e) {
                e.preventDefault();
                drop.classList.remove('dragover');
                _inputDropFile(node, ctx, e.dataTransfer);
            });
            drop.addEventListener('click', function (e) {
                // 点预览图由 preview 自身处理（放大），点按钮/清空各自处理；其余（空白）才选文件
                if (e.target.classList.contains('ng-drop-btn') || e.target.classList.contains('ng-drop-clear') || e.target === preview) return;
                _inputPickFile(node, ctx);
            });

            syncPreview();
            el._syncPreview = syncPreview;
        }
    };

    // ── input 节点辅助函数（ctx 提供 canvasIndex 的能力）──

    function _inputClear(node, ctx) {
        node.params = node.params || {};
        node.params.path = null;
        if (ctx.renderNode) ctx.renderNode(node.id);
        if (ctx.invalidateCache) ctx.invalidateCache(node.id);
        if (ctx.markDirty) ctx.markDirty();
        // 清空内容后刷新活跃 gen 节点输入容器缩略图（否则旧缩略图残留）
        if (ctx.refreshActiveGenInput) ctx.refreshActiveGenInput(node.id);
    }

    function _inputPickFile(node, ctx) {
        var inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = node.type === 'videoInput' ? 'video/*' : 'image/*';
        inp.addEventListener('change', function () {
            var file = inp.files && inp.files[0];
            if (!file) return;
            _inputHandleFile(node, ctx, file);
        });
        inp.click();
    }

    function _inputDropFile(node, ctx, dt) {
        var file = dt && dt.files && dt.files[0];
        if (!file) return;
        var isVideo = file.type && file.type.indexOf('video/') === 0;
        if (node.type === 'imageInput' && isVideo) { if (global.AEToast) AEToast.warn(AEI18n.t('图片输入节点不接受视频')); return; }
        // 与文件选择器 accept='video/*' 对齐：视频输入节点只收视频
        // （放行 image/* 时，图片路径送进下游 LoadVideo 必失败）。MIME 缺失时按扩展名兜底。
        if (node.type === 'videoInput' && !isVideo) {
            var fext = (file.name || '').split('.').pop().toLowerCase();
            if (!/^(mp4|mov|webm|avi|mkv|m4v|mpg|mpeg|wmv|flv)$/.test(fext)) {
                if (global.AEToast) AEToast.warn(AEI18n.t('视频输入节点只接受视频文件')); return;
            }
        }
        _inputHandleFile(node, ctx, file);
    }

    function _inputHandleFile(node, ctx, file) {
        var path = file.path;
        if (path) {
            if (ctx.setInputNodePath) ctx.setInputNodePath(node.id, path);
        } else {
            if (ctx.writeBlobToInputNode) ctx.writeBlobToInputNode(node.id, file);
        }
    }

    function _inputPaste(node, ctx) {
        if (!ctx.checkOutputReady || !ctx.checkOutputReady()) return;
        var ctrl = ctx.getController ? ctx.getController() : null;
        if (!ctrl) { if (global.AEToast) AEToast.warn(AEI18n.t('AE IO 未就绪')); return; }
        if (!ctx.readClipboardImage) { if (global.AEToast) AEToast.warn(AEI18n.t('剪贴板不可用')); return; }
        ctx.readClipboardImage().then(function (res) {
            // 契约：{ file: File } 或 { path: 绝对路径 }；旧浏览器通道直接返回 File，做兼容
            if (res && typeof res.arrayBuffer === 'function') res = { file: res };
            if (res && res.path) {
                // 剪贴板里是 Explorer 复制的文件：校验扩展名后直接用原路径（不复制字节）
                var pext = String(res.path).split('.').pop().toLowerCase();
                var isVideoExt = /^(mp4|mov|webm|avi|mkv|m4v|mpg|mpeg|wmv|flv)$/.test(pext);
                var isImageExt = /^(png|jpe?g|gif|webp|bmp|tiff?|exr)$/.test(pext);
                if (node.type === 'imageInput' && !isImageExt) throw new Error('剪贴板文件不是图片');
                if (node.type === 'videoInput' && !isVideoExt) throw new Error('剪贴板文件不是视频');  // 视频输入节点只收视频
                return res.path;
            }
            var file = res && res.file;
            if (!file) throw new Error('剪贴板无图片/视频');
            // 按节点类型校验 MIME：视频输入节点拒收剪贴板图片（截图等），避免 png 路径送进 LoadVideo
            var _isVidFile = file.type && file.type.indexOf('video/') === 0;
            if (node.type === 'imageInput' && _isVidFile) throw new Error(AEI18n.t('图片输入节点不接受视频'));
            if (node.type === 'videoInput' && !_isVidFile) throw new Error(AEI18n.t('视频输入节点只接受视频文件'));
            var ext = (file.type && file.type.split('/')[1]) || 'png';
            ext = ext.replace(/[^a-zA-Z0-9]/g, '') || 'png';
            var path = ctx.saveBlobToInputPath ? ctx.saveBlobToInputPath(file, ext) : '';
            if (!path) throw new Error('无法生成保存路径');
            return ctrl.writeBlobToFile(file, path).then(function () { return path; });
        }).then(function (path) {
            if (ctx.setInputNodePath) ctx.setInputNodePath(node.id, path);
            if (global.AEToast) AEToast.success(AEI18n.t('已粘贴'));
        }).catch(function (e) {
            console.warn('[ComfyUI Canvas] 粘贴失败:', e && e.message);
            if (global.AEToast) AEToast.error(AEI18n.t('粘贴失败: ') + (e && e.message || AEI18n.t('请用拖拽或点击选择')));
        });
    }

    function _inputCapture(node, ctx) {
        if (!ctx.checkOutputReady || !ctx.checkOutputReady()) return;
        var ctrl = ctx.getController ? ctx.getController() : null;
        if (!ctrl || !ctrl.captureCurrentFrame) { if (global.AEToast) AEToast.warn(AEI18n.t('截帧不可用')); return; }
        if (global.AEToast) AEToast.info(AEI18n.t('截取 AE 帧…'));
        ctrl.captureCurrentFrame().then(function (file) {
            // captureCurrentFrame 返回 File 对象，有 .name/.type，没有 .filePath/.blob
            if (!file || !(file instanceof File)) throw new Error('截帧返回空');
            var ext = (file.name.split('.').pop() || 'png').toLowerCase();
            var dest = ctx.saveBlobToInputPath ? ctx.saveBlobToInputPath(file, ext) : '';
            if (!dest) throw new Error('无法生成保存路径');
            return ctrl.writeBlobToFile(file, dest).then(function () { return dest; });
        }).then(function (path) {
            if (ctx.setInputNodePath) ctx.setInputNodePath(node.id, path);
            if (global.AEToast) AEToast.success(AEI18n.t('已截帧'));
        }).catch(function (e) {
            console.warn('[ComfyUI Canvas] 截帧失败:', e && e.message);
            if (global.AEToast) AEToast.error(AEI18n.t('截帧失败: ') + (e && e.message || ''));
        });
    }

    // 供 videoInputNode 复用
    global.AEComfyUI._inputClear = _inputClear;
    global.AEComfyUI._inputPickFile = _inputPickFile;
    global.AEComfyUI._inputDropFile = _inputDropFile;
    global.AEComfyUI._inputPaste = _inputPaste;
    global.AEComfyUI._inputCapture = _inputCapture;
})(window);
