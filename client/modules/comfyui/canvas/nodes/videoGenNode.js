(function (global) {
    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.nodeDefs = global.AEComfyUI.nodeDefs || {};

    // 视频生成节点：走 ComfyUI 模板渲染完整 workflow（不再手搓）。
    // 模板覆盖：Kling V3/旧版/起止帧、Seedance 2.0 首帧/参考、海螺、HappyHorse i2v/r2v。
    // def 闭包捕获：execute 由 executor 裸引用调用（this 丢），故 execute 内用 def.buildParamValues 不用 this。
    var def;
    global.AEComfyUI.nodeDefs.videoGen = def = {
        type: 'videoGen',
        get title() { return AEI18n.t('视频生成'); },
        category: '生成',
        // text 输入端口接文本节点 → 其输出覆盖 prompt（提示词源），与 image 输入分置：
        // image 锚在节点中部、text 锚在顶部（见 edgeRenderer.portPos + nodeRenderer 端口标记）
        // video 输入端口接视频节点 → 视频参考（仅 seedance2_ref 等支持视频参考的模型消费，见 videoInputKeys）
        // video 为数组类型：支持多视频参考（seedance2_ref 多参考视频），顺序由 videoOrder 决定（同 imageOrder）
        // ⚠️ 输出端口名必须避开输入端口名 'video'：portTypeOf 按名查找且先命中 inputs，
        // 同名会让输出被误判成 video[]（连任何 video 单值输入都被拒）。故输出用 'videoOut'。
        // execute 返回对象的 key 必须与输出端口名一致（下游按 fromPort 取值，见 graphExecutor.collectInputs）。
        inputs: [{ name: 'image', type: 'image[]' }, { name: 'text', type: 'text' }, { name: 'video', type: 'video[]' }],
        outputs: [{ name: 'videoOut', type: 'video' }],
        defaultParams: { modelId: '', prompt: '', seed: -1 },

        // 收集节点 params + 上游图 filename → paramValues。
        // 上游图填进模板图片占位符：各模板 key 不同，按 templateId 映射。
        // imageNames: 已上传的 ComfyUI 图名（key→name），由 runGenWorkflow 按 imageInputKeys 上传后传入。
        //   按 imageInputKeys 顺序取出 name 列表，再按 _imageParamKeys(templateId) 顺序填进 values。
        //   不依赖 imageInputKeys 的 key 名（部分模型定义的 key 名与模板占位符不一致，如 kling_i2v
        //   imageInputKeys=["image"] 但模板占位符是 {{start_frame}}），只用其长度判断要几张图 + 顺序对齐。
        buildParamValues: function (params, imageNames, model, upPaths, videoNames) {
            var values = {};
            var keys = params ? Object.keys(params) : [];
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (k === '_result' || k === 'modelId') continue;
                values[k] = params[k];
            }
            if (imageNames && model) {
                // 按 imageInputKeys 顺序取出已上传名（过滤空）
                var imgKeys = model.imageInputKeys || [];
                var names = [];
                for (var ki = 0; ki < imgKeys.length; ki++) {
                    if (imageNames[imgKeys[ki]]) names.push(imageNames[imgKeys[ki]]);
                }
                // 按 templateId 决定的占位符 key 顺序填入
                var targetKeys = def._imageParamKeys(model.templateId);
                for (var ti = 0; ti < targetKeys.length && ti < names.length; ti++) {
                    values[targetKeys[ti]] = names[ti];
                }
            }
            return values;
        },

        // 各视频模板的图片占位符 key（有序数组）：
        // kling_start_end 需首帧+尾帧两张 → [start_frame, end_frame]（只填 start_frame 会丢失 end_frame）
        _imageParamKeys: function (templateId) {
            switch (templateId) {
                case 'kling_i2v': return ['start_frame'];
                case 'kling_i2v_legacy': return ['start_frame'];
                case 'kling_start_end': return ['start_frame', 'end_frame'];
                case 'seedance2_i2v': return ['first_frame'];
                case 'hailuo': return ['first_frame_image'];
                case 'happyhorse_i2v': return ['first_frame'];
                case 'happyhorse_r2v': return ['reference_image_1'];
                default: return [];
            }
        },

        execute: async function (inputs, params, ctx) {
            // videoGen 上游图按 imageInputKeys 映射上传；needsImage 模型无上游图时抛错。
            // 返回落盘路径数组，取首项作 video 输出。
            var paths = await global.AEComfyUI.runGenWorkflow(def, inputs, params, ctx, {
                defaultExt: 'output.mp4',
                emptyError: '视频生成无输出',
                requireImage: true,
                onIteration: ctx.onBatchIteration || (ctx.graphExecutor && ctx.graphExecutor._onBatchIteration) || null,
                batchOffset: ctx.batchOffset || (ctx.graphExecutor && ctx.graphExecutor._batchOffset) || 0,
                isCancelled: ctx.isCancelled || null   // 取消后迟到产物不再落盘
            });
            // 与 imageGen 对齐：videos 数组供批量帧预览/导出。
            // 单值 key 必须与输出端口名一致（videoOut，避开输入端口 'video' 同名遮蔽）——下游按 fromPort 取值。
            return { videoOut: paths[0], videos: paths };
        },

        renderEditor: function (el, node, ctx) {
            ctx = ctx || {};
            el.innerHTML =
                '<div class="ng-result-preview">' +
                AEI18n.html('<div class="ng-preview-placeholder">等待生成</div>') +
                '</div>';
        }
    };

    // 从 ComfyUI outputs 提取视频（SaveVideo 节点 outputs.videos），下载落盘，返回路径数组
    // IIFE 捕获循环变量 v/dest，避免闭包陷阱（downloadOutput 异步返回 blob 时 dest 已是末值）
    function extractAndSaveVideos(outputs, bridge, aeIO, outputDir) {
        var tasks = [];
        var keys = Object.keys(outputs || {});
        for (var i = 0; i < keys.length; i++) {
            var vids = outputs[keys[i]].videos;
            if (!vids || !vids.length) continue;
            for (var j = 0; j < vids.length; j++) {
                (function (v) {
                    if (!v || !v.filename) return;
                    var dest = outputDir + '/' + v.filename;
                    tasks.push(
                        bridge.downloadOutput(v.filename, v.subfolder, v.type).then(function (blob) {
                            return aeIO.writeBlobToFile(blob, dest).then(function () { return dest; });
                        })
                    );
                })(vids[j]);
            }
        }
        return Promise.all(tasks).then(function (results) {
            return results.filter(Boolean);
        });
    }

    global.AEComfyUI.extractAndSaveVideos = extractAndSaveVideos;
})(window);
