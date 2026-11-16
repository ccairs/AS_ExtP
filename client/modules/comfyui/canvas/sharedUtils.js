(function (global) {
    global.AEComfyUI = global.AEComfyUI || {};

    // base64 → Blob（分块，避免大图 atob 一次性撑爆）。
    // 公共工具：上游图/视频走 AEFS.readBlob（二进制通道直接拿 Blob，免 base64），此函数留作
    // 公共导出供其他需要 base64→Blob 转换的场景用。不用 fetch('file://')：CEF Chrome 88 XHR/fetch
    // file:/// 大文件 blob 截断。
    function base64ToBlob(base64, mime) {
        var raw = atob(base64);
        var CHUNK = 256 * 1024;
        var parts = [];
        for (var offset = 0; offset < raw.length; offset += CHUNK) {
            var end = Math.min(offset + CHUNK, raw.length);
            var chunk = new Uint8Array(end - offset);
            for (var j = 0; j < end - offset; j++) { chunk[j] = raw.charCodeAt(offset + j); }
            parts.push(chunk);
        }
        return new Blob(parts, { type: mime || 'image/png' });
    }

    // toFileUrl 已抽到公共层 client/shared/fileUrl.js（global.AEShared.toFileUrl），此处转发保兼容。
    // 顺序由 index.html 保证：fileUrl.js 必须先于本文件加载。
    global.AEComfyUI.toFileUrl = global.AEShared.toFileUrl;
    global.AEComfyUI.base64ToBlob = base64ToBlob;

    // 落盘文件名去重（与表单路径 controller.js 的 _dedupeFileName 同语义）：
    // 若 outputDir/fileName 已存在，追加 _1/_2/... 后缀直到不冲突。保护已拆分/
    // 引用旧结果的节点内容不被 gen 节点再次生成时静默覆盖。
    // existsFn 参数供单测注入存在性判定；缺省走 AEFS.existsSync（画布环境同步探测）。
    function dedupeFileName(outputDir, fileName, existsFn) {
        var exists = (typeof existsFn === 'function') ? existsFn : function (p) {
            try { return !!(global.AEFS && global.AEFS.existsSync && global.AEFS.existsSync(p)); }
            catch (_) { return false; }
        };
        var dotIdx = fileName.lastIndexOf('.');
        var stem = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
        var ext = dotIdx > 0 ? fileName.slice(dotIdx) : '';
        var candidate = fileName;
        var n = 1;
        while (n < 10000 && exists(outputDir + '/' + candidate)) {
            candidate = stem + '_' + n + ext;
            n++;
        }
        return candidate;
    }
    global.AEComfyUI.dedupeFileName = dedupeFileName;

    // 画布上游图片容量提示（纯函数，不碰 DOM）：返回 null 表示无需提示，否则返回 toast 文案。
    // 判定依据（registry 字段）：pipeline 模板按 imageInputKeys 逐键收图，超出键数的图片
    // 不会进入模板占位符（runGenWorkflow 超出部分按首键 _N 续 key，模板无该键即被丢弃）。
    // needsImage 只表示必需图槽，不参与本判定——可选图槽（optionalImage）模板同样会丢弃超量图片。
    function imageOverflowNotice(model, imgCount) {
        if (!model || !imgCount || imgCount <= 0) return null;
        if (!model.pipeline) return null;   // 非 pipeline 走动态 workflow，不按模板键数收图
        var keys = model.imageInputKeys || [];
        if (!keys.length) return null;      // 模板未声明图片输入槽
        if (imgCount <= keys.length) return null;
        var name = model.name || model.id || '当前模型';
        return '「' + name + '」只支持 ' + keys.length + ' 张输入图片，多余的 ' +
            (imgCount - keys.length) + ' 张将被忽略';
    }

    // 画布上游视频提示（纯函数，不碰 DOM）：返回 null 表示无需提示，否则返回 toast 文案。
    // 判定依据（registry/模板字段，均可判定）：
    //   videoInputKeys 非空 → 模板有可用的视频输入槽，视频会进入模板，不提示；
    //   videoInputKeys 为空但模板/registry 的 parameters 声明了 type==='video' 输入槽
    //     → 槽未派生可用 key，接入的视频不会被使用；
    //   两者都无（模板没有 VIDEO 输入声明）→ 不支持视频参考。
    // 不用 model.category 作判据：videoGen 的下拉只列 category==='video' 的模板，该字段恒真。
    function videoOverflowNotice(model, templateParameters, vidCount) {
        if (!model || !vidCount || vidCount <= 0) return null;
        var keys = model.videoInputKeys || [];
        if (keys.length) return null;
        var params = templateParameters || model.parameters || [];
        var declared = false;
        for (var i = 0; i < params.length; i++) {
            if (params[i] && params[i].type === 'video') { declared = true; break; }
        }
        var name = model.name || model.id || '当前模型';
        if (declared) {
            return '「' + name + '」当前模板没有视频输入槽，接入的视频不会被使用';
        }
        return '「' + name + '」不支持视频参考，已接入的 ' + vidCount + ' 个视频将被忽略';
    }
    global.AEComfyUI.imageOverflowNotice = imageOverflowNotice;
    global.AEComfyUI.videoOverflowNotice = videoOverflowNotice;

    // ── Lightbox：图片缩放查看 / 视频带 controls 播放 ──
    // 供 canvas 节点（imageInput/videoInput）点击预览放大查看，行为与表单 view.js 的 lightbox 一致：
    //   图片：滚轮缩放（0.15~8，鼠标锚点）+ 拖拽平移（带惯性）+ 双击复位 + 点击空白/图片关闭
    //   视频：带 controls 播放按键，点击空白关闭
    // 不复用表单 view.js 的私有 lightbox（模块解耦：canvas 与表单各自管理 lightbox 生命周期）。
    var _lb = null, _lbImg = null;
    var _lbCloseTimer = null;        // 关闭过渡定时器：重开时须取消，防 200ms 后把新开的图藏掉
    var _lbVideoCloseTimer = null;
    var _lbScale = 1, _lbTargetScale = 1, _lbScaleAnimId = null;
    var _lbPanX = 0, _lbPanY = 0;
    var _lbDragging = false, _lbMoved = false;
    var _lbDragStartX = 0, _lbDragStartY = 0, _lbPanStartX = 0, _lbPanStartY = 0;
    var _lbVelX = 0, _lbVelY = 0, _lbLastX = 0, _lbLastY = 0, _lbLastTime = 0;
    var _lbInertiaId = null;
    var _lbVideo = null;

    function _lbApplyTransform() {
        if (!_lbImg) return;
        _lbImg.style.transform = 'translate(' + _lbPanX + 'px,' + _lbPanY + 'px) scale(' + _lbScale + ')';
    }
    function _lbStopInertia() {
        if (_lbInertiaId) { cancelAnimationFrame(_lbInertiaId); _lbInertiaId = null; }
        if (_lbScaleAnimId) { cancelAnimationFrame(_lbScaleAnimId); _lbScaleAnimId = null; }
    }
    function _lbAnimateScale() {
        _lbScaleAnimId = null;
        var diff = _lbTargetScale - _lbScale;
        if (Math.abs(diff) < 0.001) { _lbScale = _lbTargetScale; _lbApplyTransform(); return; }
        _lbScale += diff * 0.25;
        _lbApplyTransform();
        _lbScaleAnimId = requestAnimationFrame(_lbAnimateScale);
    }
    function _lbSetScale(newScale) {
        _lbTargetScale = Math.max(0.15, Math.min(8, newScale));
        if (!_lbScaleAnimId) _lbScaleAnimId = requestAnimationFrame(_lbAnimateScale);
    }
    function _lbStartInertia() {
        _lbStopInertia();
        var friction = 0.92;
        function step() {
            _lbVelX *= friction; _lbVelY *= friction;
            if (Math.abs(_lbVelX) < 0.3 && Math.abs(_lbVelY) < 0.3) { _lbVelX = 0; _lbVelY = 0; _lbInertiaId = null; return; }
            _lbPanX += _lbVelX; _lbPanY += _lbVelY;
            _lbApplyTransform();
            _lbInertiaId = requestAnimationFrame(step);
        }
        _lbInertiaId = requestAnimationFrame(step);
    }
    function _getLightbox() {
        if (_lb) return _lb;
        _lb = document.createElement('div');
        _lb.className = 'comfyui-lightbox';
        _lb.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0);align-items:center;justify-content:center;transition:background .3s ease;overflow:hidden;';
        _lbImg = document.createElement('img');
        _lbImg.style.cssText = 'position:absolute;max-width:90vw;max-height:90vh;object-fit:contain;cursor:grab;user-select:none;outline:2px solid rgba(255,255,255,.15);outline-offset:4px;';
        _lbImg.draggable = false;
        _lb.appendChild(_lbImg);
        document.body.appendChild(_lb);

        _lb.addEventListener('click', function (e) {
            if (e.target === _lb) closeLightbox();
        });
        _lb.addEventListener('wheel', function (e) {
            e.preventDefault();
            var newScale = _lbTargetScale + (e.deltaY > 0 ? -0.3 : 0.3);
            var rect = _lbImg.getBoundingClientRect();
            var mx = e.clientX - (rect.left + rect.width / 2);
            var my = e.clientY - (rect.top + rect.height / 2);
            var ratio = newScale / _lbScale;
            _lbPanX -= mx * (ratio - 1);
            _lbPanY -= my * (ratio - 1);
            _lbSetScale(newScale);
        });
        _lbImg.addEventListener('mousedown', function (e) {
            if (e.button !== 0 && e.button !== 1) return;
            e.preventDefault();
            e.stopPropagation();
            _lbStopInertia();
            _lbDragging = true;
            _lbMoved = false;
            _lbDragStartX = e.clientX; _lbDragStartY = e.clientY;
            _lbPanStartX = _lbPanX; _lbPanStartY = _lbPanY;
            _lbLastX = e.clientX; _lbLastY = e.clientY;
            _lbLastTime = Date.now();
            _lbVelX = 0; _lbVelY = 0;
            _lbImg.style.cursor = 'grabbing';
            _lbImg.style.transition = 'none';
        });
        window.addEventListener('mousemove', function (e) {
            if (!_lbDragging) return;
            var dx = e.clientX - _lbDragStartX, dy = e.clientY - _lbDragStartY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) _lbMoved = true;
            var now = Date.now(), dt = Math.max(1, now - _lbLastTime);
            _lbPanX = _lbPanStartX + dx;
            _lbPanY = _lbPanStartY + dy;
            _lbVelX = (e.clientX - _lbLastX) / dt * 16;
            _lbVelY = (e.clientY - _lbLastY) / dt * 16;
            _lbLastX = e.clientX; _lbLastY = e.clientY;
            _lbLastTime = now;
            _lbApplyTransform();
        });
        window.addEventListener('mouseup', function () {
            if (!_lbDragging) return;
            _lbDragging = false;
            _lbImg.style.cursor = 'grab';
            _lbImg.style.transition = 'transform .15s ease-out';
            if (Math.abs(_lbVelX) > 0.5 || Math.abs(_lbVelY) > 0.5) _lbStartInertia();
        });
        _lb.addEventListener('dblclick', function (e) {
            if (e.target === _lbImg) {
                _lbStopInertia();
                _lbScale = 1; _lbTargetScale = 1; _lbPanX = 0; _lbPanY = 0;
                _lbApplyTransform();
            }
        });
        // 点击图片关闭（仅当未拖拽时，避免拖拽松开后误关）
        _lbImg.addEventListener('click', function (e) {
            if (!_lbMoved) closeLightbox();
        });
        return _lb;
    }

    function openLightbox(src, isVideo) {
        if (isVideo) { _openVideoLightbox(src); return; }
        var lb = _getLightbox();
        _lbStopInertia();
        if (_lbCloseTimer) { clearTimeout(_lbCloseTimer); _lbCloseTimer = null; }
        _lbScale = 1; _lbTargetScale = 1; _lbPanX = 0; _lbPanY = 0;
        _lbVelX = 0; _lbVelY = 0;
        _lbMoved = false;  // 复位拖拽标记，防上次拖拽残留致 backdrop 点击不关
        _lbImg.src = src;
        _lbImg.style.transition = 'transform .15s ease-out';
        _lbApplyTransform();
        lb.style.display = 'flex';
        lb.style.transition = 'opacity .2s ease, background .2s ease';
        lb.style.opacity = '0';
        lb.style.background = 'rgba(0,0,0,0.92)';
        requestAnimationFrame(function () { lb.style.opacity = '1'; });
    }
    function _openVideoLightbox(src) {
        if (!_lbVideo) {
            _lbVideo = document.createElement('div');
            _lbVideo.className = 'comfyui-lightbox';
            _lbVideo.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0);align-items:center;justify-content:center;transition:opacity .2s ease,background .2s ease;';
            var v = document.createElement('video');
            v.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:4px;outline:2px solid rgba(255,255,255,.15);outline-offset:4px;';
            v.controls = true;
            _lbVideo.appendChild(v);
            _lbVideo.addEventListener('click', function (e) {
                if (e.target === _lbVideo) _closeVideoLightbox();
            });
            document.body.appendChild(_lbVideo);
        }
        var v = _lbVideo.querySelector('video');
        if (_lbVideoCloseTimer) { clearTimeout(_lbVideoCloseTimer); _lbVideoCloseTimer = null; }
        v.src = src;
        _lbVideo.style.display = 'flex';
        _lbVideo.style.opacity = '0';
        _lbVideo.style.background = 'rgba(0,0,0,0.92)';
        requestAnimationFrame(function () { _lbVideo.style.opacity = '1'; });
        v.play().catch(function () {});
    }
    function _closeVideoLightbox() {
        if (!_lbVideo) return;
        var v = _lbVideo.querySelector('video');
        v.pause();
        _lbVideo.style.opacity = '0';
        if (_lbVideoCloseTimer) clearTimeout(_lbVideoCloseTimer);
        _lbVideoCloseTimer = setTimeout(function () {
            _lbVideoCloseTimer = null;
            if (_lbVideo) {
                _lbVideo.style.display = 'none';
                v.src = '';
            }
        }, 200);
    }
    function closeLightbox() {
        // 同时关图片与视频 lightbox：二者都可能开着，卸载/切画布时一并清掉
        // （视频 lightbox 停在 _lbVideo，未关会留全屏 + 继续播放音频）
        _closeVideoLightbox();
        if (!_lb) return;
        _lbStopInertia();
        _lb.style.opacity = '0';
        if (_lbCloseTimer) clearTimeout(_lbCloseTimer);
        _lbCloseTimer = setTimeout(function () {
            _lbCloseTimer = null;
            if (_lb) {
                _lb.style.display = 'none';
                _lbImg.src = '';
                _lbScale = 1; _lbPanX = 0; _lbPanY = 0;
            }
        }, 200);
    }

    global.AEComfyUI.openLightbox = openLightbox;
    global.AEComfyUI.closeLightbox = closeLightbox;

    // imageGen / videoGen 公共生成执行流（两节点 execute 原本大段重复，收归此处）。
    // 流程：校验 ctx → 取 model → 上游图排序 → 逐张读 base64 上传 ComfyUI →
    //       按 imageInputKeys 填 imageNames（key→name，第 i 张→imageInputKeys[i]，超出按首 key _N 续）→
    //       上游视频同理按 videoInputKeys 填 videoNames（仅 seedance2_ref 等支持视频参考的模型有）→
    //       上游 text 节点输出覆盖 prompt（提示词源，优先于节点自带 textarea）→
    //       def.buildParamValues(effParams, imageNames, model, upPaths, videoNames) →
    //       templateEngine.renderWorkflow(modelId, paramValues, imageNames, videoNames) →
    //         pipeline: 模板 {{key}} 占位符替换
    //         non-pipeline: buildDynamicWorkflow 建 LoadImage/LoadVideo + 主节点 + Save*
    //       generateRaw → 等 ae:canvas-generation-done → 落盘 → 返回 paths[]
    //
    // imageNames 既作 non-pipeline 的 imageFilenames（renderWorkflow 建 LoadImage），
    // 也作 pipeline 占位符 name 源（buildParamValues 从中取对应 key 填 values）。
    // videoNames 同理：non-pipeline 建 LoadVideo（输入 key=file）；pipeline 由通用视频桥
    // 按模板 type=video 参数顺序填占位符（见下方视频桥）。
    //   - img2img: imageInputKeys=[input_image] → buildParamValues 取 input_image 填 {{input_image}}
    //   - kling_start_end: imageInputKeys=[start_frame,end_frame] → 第一张→start_frame、第二张→end_frame
    //     （pipeline 只取第一张时会丢弃 end_frame）
    //   - seedance2_ref: non-pipeline，imageInputKeys/videoInputKeys 均为点号嵌套 key
    //     （model.reference_images.image_1 / model.reference_videos.video_1），多张续 _N
    //
    // 从 ComfyUI 返回的 filename 提取扩展名，白名单 [\w]{1,10}（对齐 controller.js _safeExt）。
    // ext 会拼进输出文件名，若含引号/路径分隔符可逃逸字符串注入路径。
    // 正常 ComfyUI 输出扩展名（png/jpg/webp/mp4/gif/webm 等）均为 \w+，非法值回退 defaultExt，仍非法回退 'png'。
    function _safeOutputExt(filename, defaultExt) {
        var ext = String(filename || '').split('.').pop().toLowerCase();
        if (/^[\w]{1,10}$/.test(ext)) return ext;
        var fallback = String(defaultExt || '').split('.').pop().toLowerCase();
        return /^[\w]{1,10}$/.test(fallback) ? fallback : 'png';
    }

    // 清理工作流中无主输入的 LoadImage / LoadVideo 孤儿节点。
    // 复制自 controller.js generate() 中的逻辑（bootstrap.js 同款）：
    // removeUnreplacedPlaceholders 删掉无值占位符后，loader 丢失主输入
    // （LoadImage.image / LoadVideo.file），孤儿与指向它的 link 不清掉，ComfyUI 校验必失败
    // （如 kling_start_end 只连首帧不连尾帧）。
    function _cleanupOrphanLoaders(workflow) {
        Object.keys(workflow).forEach(function (nodeId) {
            var node = workflow[nodeId];
            if (!node) return;
            var mainInput = null;
            if (node.class_type === 'LoadImage') mainInput = 'image';
            else if (node.class_type === 'LoadVideo') mainInput = 'file';
            else return;
            if (node.inputs && node.inputs[mainInput]) return;
            delete workflow[nodeId];
            Object.keys(workflow).forEach(function (nid) {
                var n = workflow[nid];
                if (n && n.inputs) {
                    Object.keys(n.inputs).forEach(function (ik) {
                        var v = n.inputs[ik];
                        if (Array.isArray(v) && v[0] === nodeId) {
                            delete n.inputs[ik];
                        }
                    });
                }
            });
        });
    }

    // opts: { defaultExt, emptyError, requireImage }
    async function runGenWorkflow(def, inputs, params, ctx, opts) {
        ctx = ctx || {};
        opts = opts || {};
        var controller = ctx.controller, templateEngine = ctx.templateEngine, service = ctx.service, graphExecutor = ctx.graphExecutor, nodeId = ctx.nodeId;
        if (!controller || !templateEngine || !service) throw new Error('execute 缺少运行时 ctx (controller/templateEngine/service)');
        var model = templateEngine.getById(params.modelId);
        if (!model) throw new Error('未选模型');

        // 本地取消判定（canvasIndex._runGen 传入的令牌失配检测）。节点取消后
        // 在途等待/落盘立即中止：抛「已取消生成」，由 _runGen 按令牌失配静默丢弃（不写
        // session/不标脏/不 toast——本地「已取消生成」终态已由 _cancelNodeGeneration 写）。
        // 未传 isCancelled（其他调用方/单测）时零开销。
        function _checkCancelled() {
            if (opts.isCancelled && opts.isCancelled()) throw new Error('已取消生成');
        }

        // 上游图：image[] 端口累加。多图时按 imageOrder / 连线先后排序，确保与缩略图行一致
        var upPaths = (inputs && inputs.image) ? (Array.isArray(inputs.image) ? inputs.image : [inputs.image]) : [];
        // 过滤空路径（未选图的 imageInput 输出 null）：否则 [null] 绕过 requireImage 守卫，
        // 残缺 workflow 直送 ComfyUI 报晦涩错误，readBlob(null) 也刷误导性 warn
        upPaths = upPaths.filter(function (p) { return !!p; });
        if (upPaths.length > 1 && ctx.graph && ctx.graphExecutor) {
            var allEdges = ctx.graph.edges ? ctx.graph.edges() : [];
            var portEdges = [];
            for (var ei = 0; ei < allEdges.length; ei++) {
                if (allEdges[ei].to === nodeId && allEdges[ei].toPort === 'image') portEdges.push(allEdges[ei]);
            }
            portEdges.sort(function (a, b) {
                var order = params.imageOrder;
                if (order && order.length) {
                    var ai = order.indexOf(a.id), bi = order.indexOf(b.id);
                    if (ai >= 0 && bi >= 0) return ai - bi;
                    if (ai >= 0) return -1;
                    if (bi >= 0) return 1;
                }
                var an = parseInt(a.id.replace(/\D/g, '')) || 0;
                var bn = parseInt(b.id.replace(/\D/g, '')) || 0;
                return an - bn;
            });
            var sortedPaths = [], seen = {};
            for (var si = 0; si < portEdges.length; si++) {
                var edge = portEdges[si];
                var srcRes = ctx.graphExecutor.getResult(edge.from);
                var val = srcRes ? srcRes[edge.fromPort] : null;
                if (val !== undefined && val !== null) {
                    var vals = Array.isArray(val) ? val : [val];
                    for (var vi = 0; vi < vals.length; vi++) {
                        if (!seen[vals[vi]]) { sortedPaths.push(vals[vi]); seen[vals[vi]] = true; }
                    }
                }
            }
            upPaths = sortedPaths;
        }

        if (opts.requireImage && model.needsImage && !upPaths.length) {
            throw new Error('该模型需要首帧图片（接 image 输入）');
        }

        // 上传上游图 → imageNames（按 imageInputKeys 映射，pipeline/non-pipeline 统一）
        // 读图走 AEFS.readBlob（Bridge 二进制通道，免 base64/JSON 编解码，大图快一个量级）
        var imageNames = {};
        var imgKeys = model.imageInputKeys || [];
        if (upPaths.length && imgKeys.length > 0) {
            for (var pi = 0; pi < upPaths.length; pi++) {
                var imgRes = await AEFS.readBlob(upPaths[pi]);
                if (!imgRes || !imgRes.success || !imgRes.blob) {
                    console.warn('[ComfyUI Canvas] 读取上游图失败: ' + upPaths[pi]);
                    continue;
                }
                var upBlob = imgRes.blob;
                // 上传名加节点 id + 随机段——时间戳+循环序号在并发上传（多画布/
                // 多节点同毫秒同序号）时同名碰撞，ComfyUI 侧 overwrite=true 使后传静默
                // 覆盖先传（参考图串图）；节点 id 区分来源 + 随机段消同毫秒碰撞
                var upRes = await service.uploadImage(upBlob, 'nodegen_' + nodeId + '_' + new Date().getTime() + '_' + pi + '_r' + Math.floor(Math.random() * 1000000) + '.png');
                var upName = upRes && upRes.name;
                if (!upName) continue;
                var imgKey;
                if (pi < imgKeys.length) {
                    imgKey = imgKeys[pi];
                } else {
                    // 超出 key 数：按首 key 的 _N 编号自动续（non-pipeline 多图参考用）
                    var firstKey = imgKeys[0];
                    var m = firstKey.match(/^(.+)_(\d+)$/);
                    imgKey = m ? (m[1] + '_' + (pi + 1)) : null;
                }
                if (imgKey) imageNames[imgKey] = upName;
            }
        }

        // 上游视频：video[] 端口累加。多视频时按 videoOrder / 连线先后排序，确保与缩略图行一致
        // （与图片 imageOrder 同构）。视频每条边单值，无多图边错位问题。
        var upVideoPaths = (inputs && inputs.video) ? (Array.isArray(inputs.video) ? inputs.video : [inputs.video]) : [];
        if (upVideoPaths.length > 1 && ctx.graph && ctx.graphExecutor) {
            var allVEdges = ctx.graph.edges ? ctx.graph.edges() : [];
            var portVEdges = [];
            for (var vei = 0; vei < allVEdges.length; vei++) {
                if (allVEdges[vei].to === nodeId && allVEdges[vei].toPort === 'video') portVEdges.push(allVEdges[vei]);
            }
            portVEdges.sort(function (a, b) {
                var vorder = params.videoOrder;
                if (vorder && vorder.length) {
                    var vai = vorder.indexOf(a.id), vbi = vorder.indexOf(b.id);
                    if (vai >= 0 && vbi >= 0) return vai - vbi;
                    if (vai >= 0) return -1;
                    if (vbi >= 0) return 1;
                }
                var van = parseInt(a.id.replace(/\D/g, '')) || 0;
                var vbn = parseInt(b.id.replace(/\D/g, '')) || 0;
                return van - vbn;
            });
            var sortedVPaths = [], vseen = {};
            for (var vsi = 0; vsi < portVEdges.length; vsi++) {
                var vedge = portVEdges[vsi];
                var vsrcRes = ctx.graphExecutor.getResult(vedge.from);
                var vval = vsrcRes ? vsrcRes[vedge.fromPort] : null;
                if (vval !== undefined && vval !== null) {
                    var vvals = Array.isArray(vval) ? vval : [vval];
                    for (var vvi = 0; vvi < vvals.length; vvi++) {
                        if (!vseen[vvals[vvi]]) { sortedVPaths.push(vvals[vvi]); vseen[vvals[vvi]] = true; }
                    }
                }
            }
            upVideoPaths = sortedVPaths;
        }
        var videoNames = {};
        var vidKeys = model.videoInputKeys || [];
        // 接了视频但模板没有可用的视频输入槽 → 生成时再提示一次兜底（用户可能连线后才换模型；
        // 连线/换模型时 _checkVideoOverflow 已即时提示过）。判定与文案复用 videoOverflowNotice，
        // 与连线侧同源。vidKeys 为空时下面不进入上传循环，不做无效上传。
        if (upVideoPaths.length && vidKeys.length === 0) {
            var _vTpl = (templateEngine.getTemplate && model.templateId) ? templateEngine.getTemplate(model.templateId) : null;
            var _vNotice = global.AEComfyUI.videoOverflowNotice
                ? global.AEComfyUI.videoOverflowNotice(model, _vTpl && _vTpl.parameters, upVideoPaths.length)
                : null;
            if (_vNotice) {
                if (global.AEToast && AEToast.warn) AEToast.warn(_vNotice);
                else console.warn('[ComfyUI Canvas] ' + _vNotice);
            }
        }
        if (upVideoPaths.length && vidKeys.length > 0) {
            for (var vi = 0; vi < upVideoPaths.length; vi++) {
                var vPath = upVideoPaths[vi];
                if (!vPath) continue;
                var vExt = (vPath.split('.').pop() || 'mp4').toLowerCase();
                // 扩展名白名单（防恶意/异常扩展名拼进 ComfyUI 文件名）
                if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'gif', 'm4v'].indexOf(vExt) < 0) vExt = 'mp4';
                // 读视频走 AEFS.readBlob（二进制通道，免 base64；上限 512MB，承接大视频——老 readImageBase64 仅 100MB）
                var vRes = await AEFS.readBlob(vPath);
                var vBlob = (vRes && vRes.success && vRes.blob) ? vRes.blob : null;
                if (!vBlob) {
                    console.warn('[ComfyUI Canvas] 读取上游视频失败: ' + vPath);
                    continue;
                }
                // 同上游图——节点 id + 随机段消并发同名碰撞（overwrite 覆盖串图）
                var vUpRes = await service.uploadImage(vBlob, 'nodegen_' + nodeId + '_' + new Date().getTime() + '_v' + vi + '_r' + Math.floor(Math.random() * 1000000) + '.' + vExt);
                var vName = vUpRes && vUpRes.name;
                if (!vName) continue;
                var vidKey;
                if (vi < vidKeys.length) {
                    vidKey = vidKeys[vi];
                } else {
                    // 超出 key 数：按首 key 的 _N 编号续（同 imageNames 多图续 key 逻辑）
                    var vFirstKey = vidKeys[0];
                    var vm = vFirstKey.match(/^(.+)_(\d+)$/);
                    vidKey = vm ? (vm[1] + '_' + (vi + 1)) : null;
                }
                if (vidKey) videoNames[vidKey] = vName;
            }
        }

        // 上游文本节点输出 → 覆盖 prompt（文本节点作为提示词源，优先于节点自带 textarea）。
        // 不改写 node.params（浅拷贝 effParams），避免持久化污染自带 textarea 的值。
        var upText = (inputs && inputs.text != null) ? String(inputs.text) : '';
        var effParams = params;
        if (upText) {
            effParams = {};
            var pk = Object.keys(params);
            for (var pki = 0; pki < pk.length; pki++) effParams[pk[pki]] = params[pk[pki]];
            effParams.prompt = upText;
        }

        var paramValues = def.buildParamValues(effParams, imageNames, model, upPaths, videoNames);

        // 通用 pipeline 图桥：生成/官方模板无节点级硬编码映射（videoGen 的
        // _imageParamKeys switch 表 default 为空、imageGen 只桥 input_image）时，
        // 按模板 parameters 的 image 参数顺序把已上传图填进占位符 key。
        // 已有值不覆盖（kling switch 表 / img2img input_image 映射保持原行为）。
        if (model && model.pipeline && imageNames) {
            var _gImgKeys = model.imageInputKeys || [];
            var _gUploaded = [];
            for (var _gui = 0; _gui < _gImgKeys.length; _gui++) {
                if (imageNames[_gImgKeys[_gui]]) _gUploaded.push(imageNames[_gImgKeys[_gui]]);
            }
            if (_gUploaded.length && templateEngine.getTemplate) {
                var _gTpl = templateEngine.getTemplate(model.templateId);
                var _gImgParams = (_gTpl && _gTpl.parameters || []).filter(function (p) { return p && p.type === 'image'; });
                for (var _gti = 0; _gti < _gImgParams.length && _gti < _gUploaded.length; _gti++) {
                    var _gtk = _gImgParams[_gti].key;
                    if (paramValues[_gtk] === undefined) paramValues[_gtk] = _gUploaded[_gti];
                }
            }
        }

        // 通用 pipeline 视频桥：官方模板的 LoadVideo 参数（{{video_N}}）按模板
        // parameters 的 video 参数顺序填入已上传视频名；已有值不覆盖，模板无 video
        // 参数时不动。
        if (model && model.pipeline && videoNames) {
            var _gVidKeys = model.videoInputKeys || [];
            var _gVideoUploaded = [];
            for (var _gvi = 0; _gvi < _gVidKeys.length; _gvi++) {
                if (videoNames[_gVidKeys[_gvi]]) _gVideoUploaded.push(videoNames[_gVidKeys[_gvi]]);
            }
            if (_gVideoUploaded.length && templateEngine.getTemplate) {
                var _gVTpl = templateEngine.getTemplate(model.templateId);
                var _gVideoParams = (_gVTpl && _gVTpl.parameters || []).filter(function (p) { return p && p.type === 'video'; });
                for (var _gvti = 0; _gvti < _gVideoParams.length && _gvti < _gVideoUploaded.length; _gvti++) {
                    var _gvk = _gVideoParams[_gvti].key;
                    if (paramValues[_gvk] === undefined) paramValues[_gvk] = _gVideoUploaded[_gvti];
                }
            }
        }

        // 画布等待上限按模型 category 放宽——视频类三倍（对齐 LLM 路径 bootstrap
        // _bgPollTimeoutMs 的语义）：Kling/Seedance 高时长档云端排队+推理远超 10
        // 分钟，600s 硬编码超时把云端视频任务的等待放弃（积分已耗、结果不落盘）。
        // 图片类保持 600s 不变（非视频路径行为不变化）。
        var _genWaitMs = (model && model.category === 'video') ? 600000 * 3 : 600000;

        // 批量生成：仅 batch_size 参数触发循环（云端 n/max_images 由节点原生处理）
        // 每次不同 seed → N 张不同的图。与表单模式 controller.generate 行为一致。
        var _batchN = 1;
        if (paramValues.batch_size !== undefined && Number(paramValues.batch_size) > 1) {
            _batchN = Math.floor(Number(paramValues.batch_size));
        }
        delete paramValues.batch_size;  // workflow 里无 {{batch_size}} 占位符，删除避免误传
        var _origSeed = paramValues.seed;  // 固定 seed 批量时逐批 +i（对齐表单模式 controller.generate）
        var _batchOffset = (opts && opts.batchOffset) || 0;
        var allResults = [];
        var _writtenPaths = {};  // 逐批落盘已写索引→路径，最终循环跳过重复写入

        for (var _bi = 0; _bi < _batchN; _bi++) {
            _checkCancelled();   // 取消后不再提交后续批次
            // 批量模式每次不同 seed：seed=-1 每次随机；固定 seed 则 seed+i（一律随机时
            // 用户设固定 seed 批量出图无法复现，也与表单模式行为不一致）
            if (_batchN > 1) {
                if (_origSeed === -1 || _origSeed === '-1' || _origSeed === undefined) {
                    paramValues.seed = Math.floor(Math.random() * 2147483647);
                } else {
                    paramValues.seed = ((Number(_origSeed) || 0) + _bi) >>> 0;
                }
            }

            var wf = templateEngine.renderWorkflow(params.modelId, paramValues, imageNames, videoNames);
            // 提交前清理孤儿 LoadImage/LoadVideo（可选参考图未连时占位符被删，与表单路径行为一致）
            _cleanupOrphanLoaders(wf);

            // 等待上限经 opts 传给 generateRaw（history guard maxAge 联动）；
            // canvasFile 用调用方快照传入 mapPrompt（提交往返窗口内切画布时进度路由不错记画布）
            var promptId = await controller.generateRaw(wf, 'canvas', { timeoutMs: _genWaitMs });
            if (!promptId) throw new Error('提交生成失败');
            _checkCancelled();   // 提交返回后已取消 → 不再等/落盘
            graphExecutor.mapPrompt(promptId, nodeId, ctx.canvasFile);

            // 等 ae:canvas-generation-done 事件，匹配 promptId
            var result = await new Promise(function (resolve, reject) {
                var timeout = setTimeout(function () { cleanup(); reject(new Error('生成超时')); }, _genWaitMs);
                function onDone(e) {
                    if (!e.detail || e.detail.promptId !== promptId) return;
                    cleanup();
                    resolve(e.detail.results);
                }
                // execution_error 按 promptId 路由（controller.onError 分发 ae:canvas-generation-error）：
                // 立即以服务端错误解除等待，上层 _runGen 的 catch 走 session.writeError + 失败清理，
                // 不再挂到 600s 超时才以“生成超时”收场
                function onGenError(e) {
                    if (!e.detail || e.detail.promptId !== promptId) return;
                    cleanup();
                    reject(new Error(e.detail.error || '生成失败'));
                }
                function cleanup() {
                    clearTimeout(timeout);
                    window.removeEventListener('ae:canvas-generation-done', onDone);
                    window.removeEventListener('ae:canvas-generation-error', onGenError);
                }
                window.addEventListener('ae:canvas-generation-done', onDone);
                window.addEventListener('ae:canvas-generation-error', onGenError);
            });

            allResults = allResults.concat(result);

            // 逐张落盘 + 回调：每迭代完一批就写文件，通知画布填入 grid
            if (opts.onIteration && result.length > 0) {
                _checkCancelled();   // 取消后迟到产物不落盘、不写会话帧
                var iterPaths = [];
                for (var ri = 0; ri < result.length; ri++) {
                    var rr = result[ri];
                    if (!rr.blob) continue;
                    var rext = _safeOutputExt(rr.filename, opts.defaultExt);
                    var _widx = allResults.length - result.length + ri;
                    // 落盘前去重——同节点再次生成（相同 batch）会拼出相同文件名，
                    // 无条件覆盖会把已拆分/引用旧结果的节点内容静默替换
                    var rfname = dedupeFileName(ctx.outputDir, 'nodegen_' + nodeId + '_' + (_batchOffset + _widx) + '.' + rext);
                    var rfp = ctx.outputDir + '/' + rfname;
                    await controller.writeBlobToFile(rr.blob, rfp);
                    iterPaths.push(rfp);
                    _writtenPaths[_widx] = rfp;  // 标记已写，最终循环跳过
                }
                if (iterPaths.length > 0) {
                    try { opts.onIteration(nodeId, _bi, iterPaths); } catch (e) { console.warn('[runGenWorkflow] onIteration 回调失败:', e); }
                }
            }
        }

        // 落盘（非逐张回调路径兜底；逐批已写的跳过）
        var paths = [];
        for (var i = 0; i < allResults.length; i++) {
            _checkCancelled();   // 取消后剩余迟到产物不落盘
            if (_writtenPaths[i] !== undefined) {
                paths.push(_writtenPaths[i]);
                continue;
            }
            var r = allResults[i];
            if (!r.blob) continue;
            var ext = _safeOutputExt(r.filename, opts.defaultExt);
            // 落盘前去重（兜底路径与逐批回调路径同语义，防旧结果被覆盖）
            var fname = dedupeFileName(ctx.outputDir, 'nodegen_' + nodeId + '_' + (_batchOffset + i) + '.' + ext);
            var fp = ctx.outputDir + '/' + fname;
            await controller.writeBlobToFile(r.blob, fp);
            paths.push(fp);
        }
        if (!paths.length) throw new Error(opts.emptyError || '生成无输出');
        return paths;
    }

    global.AEComfyUI.runGenWorkflow = runGenWorkflow;
})(window);
