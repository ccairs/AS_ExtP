(function (global) {
    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.nodeDefs = global.AEComfyUI.nodeDefs || {};

    // 图片生成节点：走 ComfyUI 模板渲染完整 workflow（不再手搓——手搓 classType 跟真实节点对不上）。
    // 模板覆盖：本地 SD txt2img/img2img、云端 Seedream/GPT Image 2/Nano Banana 2。
    // execute：上传上游图（i2i/参考图）→ router.renderWorkflow → 提交 → 轮询 → 落盘。

    // 遍历 ComfyUI outputs，下载 SaveImage/PreviewImage 节点产物并落盘到 outputDir
    // outputs: pollUntilDone 返回的 hist.outputs { nodeId: { images: [{filename,subfolder,type}] } }
    // 无 images / 空数组 / 缺 filename 的节点跳过；返回 Promise<string[]> 落盘路径
    global.AEComfyUI.extractAndSaveImages = async function (outputs, bridge, aeIO, outputDir) {
        var paths = [];
        var nodeIds = Object.keys(outputs || {});
        for (var i = 0; i < nodeIds.length; i++) {
            var nodeOut = outputs[nodeIds[i]];
            var images = nodeOut && nodeOut.images;
            if (!images || !images.length) continue;
            for (var j = 0; j < images.length; j++) {
                var img = images[j];
                if (!img || !img.filename) continue;
                var blob = await bridge.downloadOutput(img.filename, img.subfolder, img.type);
                var destPath = outputDir + '/' + img.filename;
                await aeIO.writeBlobToFile(blob, destPath);
                paths.push(destPath);
            }
        }
        return paths;
    };

    var def = {
        type: 'imageGen',
        get title() { return AEI18n.t('图片生成'); },
        category: '生成',
        // text 输入端口接文本节点 → 其输出覆盖 prompt（提示词源），与 image 输入分置：
        // image 锚在节点中部、text 锚在顶部（见 edgeRenderer.portPos + nodeRenderer 端口标记）
        inputs: [{ name: 'image', type: 'image[]' }, { name: 'text', type: 'text' }],
        outputs: [{ name: 'images', type: 'image[]' }],
        defaultParams: { modelId: '', prompt: '', seed: -1 },

        // 收集节点 params + 上游图 filename → 喂给 router.renderWorkflow 的 paramValues
        // 上游图填进模板的图片占位符：img2img 用 input_image，云端参考图用 reference_image_1..N
        // imageNames: 已上传的 ComfyUI 图名（key→name），由 runGenWorkflow 按 imageInputKeys 上传后传入。
        //   - pipeline 单图（img2img）：取 imageNames.input_image 填进 values（{{input_image}} 替换）
        //   - non-pipeline 多图参考：imageNames 直接作 imageFilenames 传 renderWorkflow（建 LoadImage）
        buildParamValues: function (params, imageNames, model, upPaths, videoNames) {
            var values = {};
            var keys = params ? Object.keys(params) : [];
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (k === '_result' || k === 'modelId') continue;
                values[k] = params[k];
            }
            // pipeline 单图（img2img 的 input_image）
            if (model && model.needsImage && imageNames && imageNames.input_image) {
                values.input_image = imageNames.input_image;
            }
            // 多图参考（non-pipeline 云端参考图）：imageNames 已作 imageFilenames 注入 renderWorkflow
            return values;
        },

        // ctx: { router, bridge, aeIO, outputDir } 运行时注入（executor 透传 opts.ctx）
        execute: async function (inputs, params, ctx) {
            // imageGen 上游图按 imageInputKeys 映射（img2img 唯一 key=input_image），
            // 多图参考的编号续 key 由 runGenWorkflow 内部处理。返回落盘路径数组。
            var paths = await global.AEComfyUI.runGenWorkflow(def, inputs, params, ctx, {
                defaultExt: 'output.png',
                emptyError: '图片生成无输出',
                onIteration: ctx.onBatchIteration || (ctx.graphExecutor && ctx.graphExecutor._onBatchIteration) || null,
                batchOffset: ctx.batchOffset || (ctx.graphExecutor && ctx.graphExecutor._batchOffset) || 0,
                isCancelled: ctx.isCancelled || null   // 取消后迟到产物不再落盘
            });
            return { images: paths };
        },

        renderEditor: function (el, node, ctx) {
            ctx = ctx || {};
            // 结果预览区（初始占位，生成后由 showPreviewGenerating/Error/_refreshDownstreamPreviews 更新）
            el.innerHTML =
                '<div class="ng-result-preview">' +
                AEI18n.html('<div class="ng-preview-placeholder">等待生成</div>') +
                '</div>';
        }
    };

    // 渲染单个模板参数控件，写回 node.params[key]
    // onChange: 可选回调，参数值变化时触发（用于 markDirty）
    function _renderOneParam(box, p, node, onChange) {
        node.params = node.params || {};
        onChange = onChange || function () {};
        var row = document.createElement('label');
        row.className = 'ng-param-row';
        var lbl = document.createElement('span');
        lbl.className = 'ng-param-label';
        // 参数 label 来自模板 JSON（中文源文），显示前经 t()：zh 原样，其它语言查词典。
        lbl.textContent = AEI18n.t(p.label || p.key);
        row.appendChild(lbl);

        var cur = (node.params[p.key] !== undefined) ? node.params[p.key] : p.default;

        if (p.type === 'select') {
            var sel = document.createElement('select');
            sel.className = 'ng-param-select';
            (p.choices || []).forEach(function (c) {
                var o = document.createElement('option');
                o.value = c; o.textContent = c;
                if (c === cur) o.selected = true;
                sel.appendChild(o);
            });
            node.params[p.key] = sel.value;
            sel.addEventListener('change', function () { node.params[p.key] = sel.value; onChange(); });
            row.appendChild(sel);
        } else if (p.type === 'boolean') {
            // 仿 Agent 模块的 toggle 开关（复用 common.css 的 .toggle-wrap / .switch-slider）
            var toggleWrap = document.createElement('label');
            toggleWrap.className = 'toggle-wrap ng-param-toggle';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'switch-input';
            cb.checked = !!cur;
            var sliderEl = document.createElement('span');
            sliderEl.className = 'switch-slider';
            node.params[p.key] = cb.checked;
            cb.addEventListener('change', function () { node.params[p.key] = cb.checked; onChange(); });
            toggleWrap.appendChild(cb);
            toggleWrap.appendChild(sliderEl);
            row.appendChild(toggleWrap);
        } else if (p.type === 'number') {
            var initVal = (cur === undefined || cur === '') ? p.default : cur;
            node.params[p.key] = initVal;
            var hasRange = p.min !== undefined && p.max !== undefined;
            if (hasRange) {
                // 滑块 + 数字输入组合（仿 ComfyUI 原生节点）
                var rng = document.createElement('input');
                rng.type = 'range';
                rng.className = 'ng-param-slider';
                rng.min = p.min; rng.max = p.max;
                if (p.step !== undefined) rng.step = p.step;
                rng.value = initVal;
                var num = document.createElement('input');
                num.type = 'number';
                num.className = 'ng-param-number';
                num.min = p.min; num.max = p.max;
                if (p.step !== undefined) num.step = p.step;
                num.value = initVal;
                rng.addEventListener('input', function () {
                    var v = parseFloat(rng.value);
                    node.params[p.key] = isNaN(v) ? p.default : v;
                    num.value = rng.value;
                    onChange();
                });
                num.addEventListener('input', function () {
                    var v = parseFloat(num.value);
                    node.params[p.key] = isNaN(v) ? p.default : v;
                    rng.value = num.value;
                    onChange();
                });
                num.addEventListener('change', function () {
                    var v = parseFloat(num.value);
                    if (!isNaN(v)) {
                        v = Math.max(p.min, Math.min(p.max, v));
                        num.value = v;
                        node.params[p.key] = v;
                        rng.value = v;
                        onChange();
                    }
                });
                row.appendChild(rng);
                row.appendChild(num);
            } else {
                // 无范围限制 → 纯数字输入填满
                var numOnly = document.createElement('input');
                numOnly.type = 'number';
                numOnly.className = 'ng-param-number ng-param-number-flex';
                numOnly.value = initVal;
                if (p.min !== undefined) numOnly.min = p.min;
                if (p.max !== undefined) numOnly.max = p.max;
                if (p.step !== undefined) numOnly.step = p.step;
                numOnly.addEventListener('input', function () {
                    var v = parseFloat(numOnly.value);
                    node.params[p.key] = isNaN(v) ? p.default : v;
                    onChange();
                });
                numOnly.addEventListener('change', function () {
                    var v = parseFloat(numOnly.value);
                    if (!isNaN(v)) {
                        if (p.min !== undefined) v = Math.max(p.min, v);
                        if (p.max !== undefined) v = Math.min(p.max, v);
                        numOnly.value = v;
                        node.params[p.key] = v;
                        onChange();
                    }
                });
                row.appendChild(numOnly);
            }
        } else {
            // 文本/textarea 参数较宽，跨两列
            row.classList.add('ng-param-wide');
            var ta = document.createElement('textarea');
            ta.className = 'ng-param-text';
            ta.value = cur || '';
            node.params[p.key] = ta.value;
            ta.addEventListener('input', function () { node.params[p.key] = ta.value; onChange(); });
            row.appendChild(ta);
        }
        box.appendChild(row);
    }

    global.AEComfyUI.nodeDefs.imageGen = def;
    global.AEComfyUI._renderNodeParam = _renderOneParam;
    global.AEComfyUI._autoFitNode = _autoFitNode;
    global.AEComfyUI._renderGenInputContainer = renderGenInputContainer;
    global.AEComfyUI._refreshInputThumb = _refreshInputThumb;
    global.AEComfyUI._refreshVideoThumb = _refreshVideoThumb;

    // 参数加载后自动调整节点大小：放 auto 让浏览器量内容高度，再设回固定值
    // el 是 .ng-node-editor 容器，需要找到父级 .ng-node 来设宽高
    function _autoFitNode(el, node) {
        var nodeEl = el.closest('.ng-node');
        if (!nodeEl) return;
        // 暂存旧尺寸用于最小宽度兜底
        var prevW = nodeEl.style.width;
        // 放 auto 让内容撑开
        nodeEl.style.height = 'auto';
        // 强制重排读取真实高度（offsetHeight 触发 reflow）
        var contentH = nodeEl.offsetHeight;
        var contentW = nodeEl.offsetWidth;
        // 恢复最小约束：不低于 200×80
        if (contentW < 200) contentW = 200;
        if (contentH < 80) contentH = 80;
        // 宽度不收缩（已手动拉宽则保留），高度跟内容走
        var oldW = parseInt(prevW) || contentW;
        nodeEl.style.width = Math.max(contentW, oldW) + 'px';
        nodeEl.style.height = contentH + 'px';
        // 持久化
        node.params = node.params || {};
        node.params.width = parseInt(nodeEl.style.width);
        node.params.height = parseInt(nodeEl.style.height);
        // 通知画布重绘连线（尺寸变了端口位置可能位移）
        try { window.dispatchEvent(new CustomEvent('ae:node-resized', { detail: { nodeId: node.id } })); } catch (_) {}
    }

    // ── 画布生成节点模型下拉：模板过滤 / 云标记文案 / 注册后重建 ──
    // 数据源 engine.getAllTemplates()，与表单模板卡片、设置页默认模板下拉同源。
    // imageGen 收所有非 video 模板（image / custom / 未标 category 均归图片节点），
    // videoGen 只收 video——同一模板在两类节点下的归属只由 category 决定。
    var _openGenInputRef = null;   // { root, node, select, engine }：当前展开的 gen 输入容器

    function _isGenTemplate(tpl, isVideo) {
        if (!tpl) return false;
        return isVideo ? tpl.category === 'video' : tpl.category !== 'video';
    }

    // 选项文案与表单模板卡片一致：模板名后接云标记（☁ = 云端/API 工作流）
    // 模板名来自模板 JSON / 工作流文件名（数据源），显示前经 t()。
    function _genModelOptionText(tpl) {
        return AEI18n.t(tpl.name) + (tpl.cloud ? ' ☁' : '');
    }

    // 按节点类型过滤并填充模型下拉，返回选中 id：已存 modelId 优先，否则首个模板。
    // 节点尚无 modelId 时把首个模板写回 node.params（与首次打开容器的行为一致）。
    function _fillGenModelSelect(selectEl, templates, node) {
        var isVideo = !!(node && node.type === 'videoGen');
        var filtered = [];
        for (var i = 0; i < templates.length; i++) {
            if (_isGenTemplate(templates[i], isVideo)) filtered.push(templates[i]);
        }
        var modelId = (node.params && node.params.modelId) || '';
        var selId = modelId || (filtered[0] ? filtered[0].id : '');
        selectEl.innerHTML = '';
        for (var j = 0; j < filtered.length; j++) {
            var tpl = filtered[j];
            var opt = document.createElement('option');
            opt.value = tpl.id;
            opt.textContent = _genModelOptionText(tpl);
            if (tpl.id === selId) opt.selected = true;
            selectEl.appendChild(opt);
        }
        if (!modelId && selId) {
            node.params = node.params || {};
            node.params.modelId = selId;
        }
        return selId;
    }

    // 模板注册后（controller 广播 ae:comfyui-templates-changed）重建已展开容器的下拉：
    // 只重建选项，不触碰参数行/提示词/批量设置。容器未展开时不处理——下次展开会重新渲染完整列表；
    // 容器已随画布卸载时释放引用。
    function _refreshOpenGenModelSelect() {
        var ref = _openGenInputRef;
        if (!ref || !ref.root || !ref.select || !ref.engine) return;
        if (typeof document === 'undefined' || !document.contains || !document.contains(ref.root)) {
            _openGenInputRef = null;
            return;
        }
        if (!ref.root.classList || !ref.root.classList.contains('ng-gen-input-open')) return;
        _fillGenModelSelect(ref.select, ref.engine.getAllTemplates(), ref.node);
    }

    // 模块脚本只执行一次 → 监听器只挂一次；重复执行（测试/热载）不重复绑定。
    if (typeof global.addEventListener === 'function' && !global.AEComfyUI._genTemplatesListenerBound) {
        global.addEventListener('ae:comfyui-templates-changed', _refreshOpenGenModelSelect);
        global.AEComfyUI._genTemplatesListenerBound = true;
    }

    // ── 生成节点弹出输入容器渲染（imageGen/videoGen 共用）──
    // el: .ng-gen-input-container DOM 元素
    // node: graph 节点对象
    // ctx: 编辑器上下文（同 renderEditor）
    function renderGenInputContainer(el, node, ctx) {
        ctx = ctx || {};
        var params = node.params || {};
        var engine = ctx.getEngine ? ctx.getEngine() : null;

        el.innerHTML =
            '<div class="ng-gen-input-top"></div>' +
            '<div class="ng-gen-input-mid">' +
            AEI18n.html('<textarea class="ng-gen-input-textarea" placeholder="输入提示词…"></textarea>') +
            '</div>' +
            '<div class="ng-gen-input-params-panel">' +
            '<div class="ng-gen-input-params"></div>' +
            '</div>' +
            '<div class="ng-gen-input-bottom">' +
            AEI18n.html('<button class="ng-gen-input-params-toggle">参数＋</button>') +
            '<span style="flex:1"></span>' +
            AEI18n.html('<span class="ng-gen-input-batch" title="批量生成数量（拖拽或点击调整）">1x</span>') +
            AEI18n.html('<button class="btn run" style="flex-shrink:0">生成</button>') +
            '</div>';

        var promptEl = el.querySelector('.ng-gen-input-textarea');
        var modelSel = document.createElement('select');
        modelSel.className = 'ng-gen-input-model';
        var paramsBox = el.querySelector('.ng-gen-input-params');
        var sendBtn = el.querySelector('.btn.run');
        var topRow = el.querySelector('.ng-gen-input-top');
        var toggleBtn = el.querySelector('.ng-gen-input-params-toggle');
        var paramsPanel = el.querySelector('.ng-gen-input-params-panel');

        // 预填 prompt
        promptEl.value = params.prompt || '';
        promptEl.addEventListener('input', function () {
            node.params = node.params || {};
            node.params.prompt = promptEl.value;
            onParamChange();
        });

        // gen 节点参数（prompt/模型/动态参数）变更 → 清自身 + 下游缓存，
        // 否则 runNodeAsync 因 isReady 跳过、再点"生成"返回旧结果（同输入节点改路径）。
        // 上游图缓存不动——参数变只影响本节点输出。
        function onParamChange() {
            if (ctx.invalidateCache) ctx.invalidateCache(node.id);
            if (ctx.markDirty) ctx.markDirty();
        }

        // 上游接了文本节点 → 提示词由其提供（runGenWorkflow 用上游 text 覆盖 prompt），
        // 禁用自带 textarea，避免用户误以为在此输入有效。
        var hasTextSrc = false;
        if (ctx.graph && ctx.graph.edges) {
            var te = ctx.graph.edges();
            for (var tsi = 0; tsi < te.length; tsi++) {
                if (te[tsi].to === node.id && te[tsi].toPort === 'text') { hasTextSrc = true; break; }
            }
        }
        if (hasTextSrc) {
            promptEl.value = '';
            promptEl.placeholder = AEI18n.t('已接入文本节点（提示词由其提供）');
            promptEl.disabled = true;
            promptEl.classList.add('ng-input-disabled');
        }

        // ── 填模型下拉（放底部操作栏，始终可见）──
        var templates = engine ? engine.getAllTemplates() : [];
        var selId = _fillGenModelSelect(modelSel, templates, node);
        // 记录当前展开容器：模板注册广播（ae:comfyui-templates-changed）时据此重建下拉
        _openGenInputRef = { root: el, node: node, select: modelSel, engine: engine };
        // 插入到 toggle 按钮前面
        toggleBtn.parentNode.insertBefore(modelSel, toggleBtn);

        // ── batch_size 拖拽/点击调整 ──
        var batchEl = el.querySelector('.ng-gen-input-batch');
        var batchVal = parseInt(params.batch_size) || 1;
        batchVal = Math.max(1, Math.min(20, batchVal));
        batchEl.textContent = batchVal + 'x';
        node.params = node.params || {};
        node.params.batch_size = batchVal;

        function setBatch(v) {
            v = Math.max(1, Math.min(20, Math.floor(v)));
            batchVal = v;
            batchEl.textContent = v + 'x';
            node.params.batch_size = v;
            // batch_size 调整接 onChange 链 markDirty——只写内存参数不落盘时，
            // 拖拽/输入调整的批量设置重启后丢失回退 1x（不走 onParamChange 的
            // invalidateCache：已有结果缓存不受批量数影响，重新生成时 _runGen
            // 本就会 clearResult）
            if (ctx.markDirty) ctx.markDirty();
        }

        // 拖拽调整
        batchEl.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            var startX = e.clientX;
            var startVal = batchVal;
            var moved = false;
            function onMove(ev) {
                var dx = ev.clientX - startX;
                if (Math.abs(dx) < 3 && !moved) return;
                moved = true;
                setBatch(startVal + Math.round(dx / 15));
            }
            function onUp() {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                if (!moved) {
                    // 未拖拽 → 点击编辑
                    clickEdit();
                }
            }
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });

        // 点击直接输入
        function clickEdit() {
            var inp = document.createElement('input');
            inp.type = 'number';
            inp.className = 'ng-gen-input-batch-edit';
            inp.min = 1; inp.max = 20; inp.step = 1;
            inp.value = batchVal;
            inp.style.width = '42px';
            batchEl.style.display = 'none';
            batchEl.parentNode.insertBefore(inp, batchEl.nextSibling);
            inp.focus();
            inp.select();
            function commit() {
                var v = parseInt(inp.value);
                if (!isNaN(v)) setBatch(v);
                inp.remove();
                batchEl.style.display = '';
            }
            inp.addEventListener('blur', commit);
            inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') commit(); });
        }

        // ── 渲染模型参数 ──
        var _schemaToken = 0;  // schema 竞态令牌：切换模型后，慢响应不得覆盖新模型的参数行
        function renderModelParams(mid) {
            var myToken = ++_schemaToken;
            // 参数重建窗口禁用生成入口——下方同步删除 node.params 的模型参数后、
            // schema 异步返回前（首次打开该模型未缓存时是网络往返窗口）点「生成」会以
            // 默认值提交（用户已设参数静默丢失）。恢复点：schema 成功/失败回调（token
            // 校验后）与无 getModelParams 的提前返回；过期 token 回调不恢复（按钮由
            // 新请求的回调管理，旧回调恢复会解除新加载期的禁用）。
            if (sendBtn) sendBtn.disabled = true;
            // 清除旧参数 UI 行（保留模型行）
            var rows = paramsBox.querySelectorAll('.ng-param-dynamic');
            for (var r = 0; r < rows.length; r++) rows[r].remove();

            // 清除 node.params 里旧模型的参数，只保留与模型无关的簿记 key。
            // 否则切换模型后旧 key（如 gpt_image2 的 model.size / n / model:"gpt-image-2"）
            // 仍残留在 params 里，buildParamValues 会把它们全喂给 paramValues，
            // buildDynamicWorkflow 再塞进主节点 inputs → ComfyUI 报 unknown kwarg / model 值错。
            // 保留白名单：modelId（模型 id）、prompt/prompt_text（提示词）、_result（结果缓存）、
            // imageOrder/videoOrder（边排序）、width/height（节点 UI 尺寸，_autoFitNode 写入）、
            // 批量帧/多图预览状态（生成中点击节点重开面板时不能丢，否则 onIteration 回调找不到占位符）。
            //
            // ⚠️ model（modelKey）不在 KEEP_KEYS 中——切换 modelId 时旧 model 值需清除。
            // 但重开面板（同一 modelId）时，删除 model 会导致 _renderOneParam 用 p.default
            // 覆盖用户选择（如 gpt-image-1 → gpt-image-2）。因此在删除前保存当前 modelKey 的值，
            // 删除后恢复，使 _renderOneParam 能读到用户之前的选择。
            // 清理前快照全部参数值：新 schema 中仍存在的同名 key 在渲染时恢复用户原值
            var _savedVals = node.params ? Object.assign({}, node.params) : {};
            var _modelDef = (engine && engine.getById) ? engine.getById(mid) : null;
            var _modelKey = _modelDef ? _modelDef.modelKey : null;
            var _savedModelVal = (_modelKey && node.params && node.params[_modelKey] !== undefined)
                ? node.params[_modelKey] : undefined;
            if (node.params) {
                var KEEP_KEYS = { modelId: 1, prompt: 1, prompt_text: 1, _result: 1, batch_size: 1,
                    imageOrder: 1, videoOrder: 1, width: 1, height: 1,
                    _placeholders: 1, _frameHTMLs: 1, _batchCurIdx: 1,
                    _multiImgs: 1, _multiCurIdx: 1,
                    _layoutWidth: 1, _layoutHeight: 1 };
                var _oldKeys = Object.keys(node.params);
                for (var ok = 0; ok < _oldKeys.length; ok++) {
                    if (!KEEP_KEYS[_oldKeys[ok]]) delete node.params[_oldKeys[ok]];
                }
            }
            // 恢复 model 值：_renderOneParam 会用 node.params[modelKey]（而非 p.default）初始化下拉框
            if (_modelKey && _savedModelVal !== undefined) {
                node.params = node.params || {};
                node.params[_modelKey] = _savedModelVal;
            }

            if (!engine || !engine.getModelParams) {
                // 无 schema 拉取能力——无异步回调会来恢复按钮，此处直接恢复
                if (sendBtn) sendBtn.disabled = false;
                return;
            }
            var loadingEl = document.createElement('div');
            loadingEl.className = 'ng-loading ng-param-dynamic';
            loadingEl.textContent = AEI18n.t('加载参数…');
            paramsBox.appendChild(loadingEl);

            engine.getModelParams(mid).then(function (tParams) {
                // 竞态守卫：token 已过期（用户又切了模型）或面板已关闭 → 丢弃本次结果
                if (myToken !== _schemaToken || !document.contains(paramsBox)) return;
                if (sendBtn) sendBtn.disabled = false;  // 参数恢复完成，重新开放生成入口
                // 移除 loading
                var ld = paramsBox.querySelector('.ng-loading');
                if (ld) ld.remove();
                var renderer = global.AEComfyUI._renderNodeParam;
                if (!renderer) return;
                // _modelDef / _modelKey 在函数开头已声明，此处直接复用
                for (var i = 0, _rowIdx = 0; i < tParams.length; i++) {
                    var p = tParams[i];
                    // 跳过提示词：含点号嵌套 key（如 model.prompt / multi_shot.prompt）也跳过，
                    // 否则 schema 动态拉取的 prompt 会和顶部提示词输入框重复
                    var _lastSeg = p.key.lastIndexOf('.') >= 0 ? p.key.slice(p.key.lastIndexOf('.') + 1) : p.key;
                    if (_lastSeg === 'prompt' || _lastSeg === 'prompt_text' || p.key === 'modelId') continue;
                    if (p.type === 'image' || p.type === 'video') continue;
                    if (p.key === 'file' || p.key === 'lora' || p.type === undefined) continue;
                    // batch_size 已固定在底部栏，不重复渲染
                    if (p.key === 'batch_size') continue;
                    // 恢复用户原值：新 schema 中仍存在的 key 用清理前的值初始化（而非 p.default）
                    if (_savedVals[p.key] !== undefined) node.params[p.key] = _savedVals[p.key];
                    // _renderNodeParam 内部创建 .ng-param-row → 用 div 包装以免嵌套 label
                    var wrapper = document.createElement('div');
                    wrapper.className = 'ng-param-dynamic';
                    wrapper.dataset.paramKey = p.key;  // 标记参数 key，用于联动刷新时识别
                    // 入场动画：按行索引错开 delay，顶上的先出
                    wrapper.style.animation = 'ng-param-enter 0.3s ease-out ' + (_rowIdx * 0.04) + 's both';
                    _rowIdx++;
                    renderer(wrapper, p, node, onParamChange);
                    paramsBox.appendChild(wrapper);
                }

                // ── DynamicCombo model select 联动：切换 model 值后刷新子参数 ──
                // 仅 non-pipeline 模型且有 modelKey 时生效；pipeline 模型参数静态，不联动
                if (_modelKey && _modelDef && !_modelDef.pipeline && engine.refreshModelParams) {
                    var _modelSelRow = paramsBox.querySelector('.ng-param-dynamic[data-param-key="' + _modelKey + '"]');
                    var _modelSel = _modelSelRow ? _modelSelRow.querySelector('select.ng-param-select') : null;
                    if (_modelSel) {
                        var _dcRefreshToken = 0;  // 防竞态 token
                        _modelSel.addEventListener('change', function () {
                            var _newVal = _modelSel.value;
                            node.params[_modelKey] = _newVal;
                            var _myToken = ++_dcRefreshToken;  // 本次刷新的 token
                            // 用新 modelValue 重新生成参数
                            engine.refreshModelParams(mid, _newVal).then(function (newParams) {
                                // 竞态保护：如果期间用户又切换了 model，放弃本次结果
                                if (_myToken !== _dcRefreshToken) return;
                                // 删除除 model select 行外的所有动态行，重新渲染
                                var _allRows = paramsBox.querySelectorAll('.ng-param-dynamic');
                                _allRows.forEach(function (row) {
                                    if (row.dataset.paramKey !== _modelKey) row.remove();
                                });
                                // 清除旧 DynamicCombo 子参数的 node.params 值（带 modelKey. 前缀）
                                var _dcPrefix = _modelKey + '.';
                                if (node.params) {
                                    Object.keys(node.params).forEach(function (k) {
                                        if (k.indexOf(_dcPrefix) === 0) delete node.params[k];
                                    });
                                }
                                var _renderer = global.AEComfyUI._renderNodeParam;
                                if (!_renderer) return;
                                for (var ni = 0, _dcRowIdx = 0; ni < newParams.length; ni++) {
                                    var np = newParams[ni];
                                    var _nls = np.key.lastIndexOf('.') >= 0 ? np.key.slice(np.key.lastIndexOf('.') + 1) : np.key;
                                    if (_nls === 'prompt' || _nls === 'prompt_text' || np.key === 'modelId') continue;
                                    if (np.type === 'image' || np.type === 'video') continue;
                                    if (np.key === 'file' || np.key === 'lora' || np.type === undefined) continue;
                                    if (np.key === 'batch_size') continue;
                                    // 跳过 model select 本身（已保留原行），避免重复
                                    if (np.key === _modelKey) continue;
                                    var _w = document.createElement('div');
                                    _w.className = 'ng-param-dynamic';
                                    _w.dataset.paramKey = np.key;
                                    // 入场动画：按行索引错开 delay，顶上的先出
                                    _w.style.animation = 'ng-param-enter 0.3s ease-out ' + (_dcRowIdx * 0.04) + 's both';
                                    _dcRowIdx++;
                                    _renderer(_w, np, node, onParamChange);
                                    paramsBox.appendChild(_w);
                                }
                                onParamChange();
                            }).catch(function (e) {
                                console.warn('[ComfyUI Canvas] 子参数刷新失败:', e && e.message);
                            });
                        });
                    }
                }
            }).catch(function (e) {
                if (myToken !== _schemaToken || !document.contains(paramsBox)) return;  // 过期请求的错误不落地
                if (sendBtn) sendBtn.disabled = false;  // 加载失败也恢复生成入口（错误行已提示）
                console.warn('[ComfyUI Canvas] 参数加载失败:', e && e.message);
                var ld = paramsBox.querySelector('.ng-loading');
                if (ld) ld.remove();
                var errEl = document.createElement('div');
                errEl.className = 'ng-error ng-param-dynamic';
                errEl.textContent = AEI18n.t('参数加载失败: ') + (e && e.message || AEI18n.t('未知错误'));
                paramsBox.appendChild(errEl);
            });
        }
        renderModelParams(selId);

        modelSel.addEventListener('change', function () {
            node.params = node.params || {};
            node.params.modelId = modelSel.value;
            renderModelParams(modelSel.value);
            if (ctx.checkImageOverflow) ctx.checkImageOverflow(node.id);
            if (ctx.checkVideoOverflow) ctx.checkVideoOverflow(node.id);
            onParamChange();
        });

        // ── 参数面板折叠/展开 ──
        toggleBtn.addEventListener('click', function () {
            var isOpen = paramsPanel.classList.toggle('ng-gen-input-params-open');
            toggleBtn.textContent = isOpen ? AEI18n.t('参数－') : AEI18n.t('参数＋');
            // 容器高度变了 → 重定位（可能往下溢出画布）
            if (ctx.positionGenInput) ctx.positionGenInput();
        });

        // ── 发送按钮（不限 disabled，生成中可再次点击追加）──
        sendBtn.addEventListener('click', function () {
            node.params = node.params || {};
            if (!promptEl.disabled) node.params.prompt = promptEl.value;
            node.params.modelId = modelSel.value;
            ctx.runGen ? ctx.runGen(node.id) : null;
        });

        // ── 上游输入参考图缩略图 + 视频参考（同行）──
        _refreshInputThumb(topRow, node, ctx);
        _refreshVideoThumb(topRow, node, ctx);
    }

    // 刷新视频参考缩略图：多视频参考（video[] 端口），支持拖拽排序、hover 预览、× 断开。
    // 顺序由 videoOrder（edge id 序列）决定，与 imageOrder 同构。视频每条边单值，无多图边错位。
    // 追加到容器末尾（紧跟图片缩略图），只清自身（.ng-video-thumbs），不动图片。
    function _refreshVideoThumb(container, node, ctx) {
        if (!container) return;
        var oldRef = container.querySelector('.ng-video-thumbs');
        if (oldRef) oldRef.remove();
        if (!ctx || !ctx.graph || !ctx.graph.edges) return;
        if (node.type !== 'videoGen') return;
        var edges = ctx.graph.edges();
        var vidEdges = [];
        for (var i = 0; i < edges.length; i++) {
            if (edges[i].to === node.id && edges[i].toPort === 'video') vidEdges.push(edges[i]);
        }
        if (!vidEdges.length) return;

        // ── 排序：videoOrder 为唯一顺序来源（edge id 序列）──
        // prune 已断开的边 id，新边按连线先后追加末尾（同 imageOrder 逻辑）。
        node.params = node.params || {};
        var rawVOrder = node.params.videoOrder || [];
        var curVIds = {};
        for (var cvi = 0; cvi < vidEdges.length; cvi++) curVIds[vidEdges[cvi].id] = true;
        var vorder = [];
        for (var voi = 0; voi < rawVOrder.length; voi++) {
            var veid = rawVOrder[voi];
            if (curVIds[veid] && vorder.indexOf(veid) < 0) vorder.push(veid);
        }
        for (var vni = 0; vni < vidEdges.length; vni++) {
            if (vorder.indexOf(vidEdges[vni].id) < 0) vorder.push(vidEdges[vni].id);
        }
        node.params.videoOrder = vorder;
        vidEdges.sort(function (a, b) {
            return vorder.indexOf(a.id) - vorder.indexOf(b.id);
        });

        // 收集每条边的上游视频路径（取不到给占位）
        var vItems = [];
        for (var vei2 = 0; vei2 < vidEdges.length; vei2++) {
            var vedge = vidEdges[vei2];
            var vUpNode = ctx.graph.getNode(vedge.from);
            var path = null;
            if (ctx.graphExecutor && ctx.graphExecutor.getResult) {
                var vr = ctx.graphExecutor.getResult(vedge.from);
                // 按边的 fromPort 取（videoGen 输出名为 videoOut 以避开同名输入；videoInput 输出仍为 video）
                if (vr) {
                    if (vr[vedge.fromPort] !== undefined) path = vr[vedge.fromPort];
                    else if (vr.videoOut) path = vr.videoOut;
                    else if (vr.video) path = vr.video;
                }
            }
            // videoGen 上游：结果在 params._result（videoOut/videos）。ctx 未注入 graphExecutor，
            // 仅靠 getResult 分支取不到 → 上游为生成节点时缩略图缺失
            if (!path && vUpNode && vUpNode.params && vUpNode.params._result) {
                var vres = vUpNode.params._result;
                if (vres[vedge.fromPort] !== undefined) path = vres[vedge.fromPort];
                else if (vres.videoOut) path = vres.videoOut;
                else if (vres.video) path = vres.video;
            }
            if (!path && vUpNode && vUpNode.params) path = vUpNode.params.path || null;
            vItems.push({ edge: vedge, path: path });
        }

        // ── 保存排序结果到 node.params.videoOrder（仅拖拽后调用）──
        function saveVOrder() {
            node.params.videoOrder = [];
            for (var oi = 0; oi < vidEdges.length; oi++) {
                if (vidEdges[oi] && vidEdges[oi].id) node.params.videoOrder.push(vidEdges[oi].id);
            }
            // 视频顺序变 → 多视频参考的输入顺序变 → 旧生成结果无效，清缓存（同 onParamChange）
            if (ctx.invalidateCache) ctx.invalidateCache(node.id);
            if (ctx.markDirty) ctx.markDirty();
            if (ctx.pushHistory) ctx.pushHistory();   // 离散结构操作：立即推历史
        }

        var row = document.createElement('div');
        row.className = 'ng-video-thumbs';
        var hasContent = false;   // 是否有实际视频缩略图（全空则不 append 空 row）

        for (var vi2 = 0; vi2 < vItems.length; vi2++) {
            (function (item) {
                var vedge = item.edge;
                var wrap = document.createElement('div');
                wrap.className = 'ng-video-thumb-wrap';
                wrap.draggable = true;
                wrap.dataset.edgeId = vedge.id;

                if (!item.path) {
                    // 已连线但上游无视频 → 不显示占位符（与用户预期一致：空输入不占位）
                    return;
                } else {
                    hasContent = true;
                    var vSrc = global.AEComfyUI.toFileUrl(item.path);
                    var vEl = document.createElement('video');
                    vEl.className = 'ng-video-thumb-vid';
                    vEl.muted = true;
                    vEl.preload = 'metadata';
                    vEl.draggable = false;  // <video> 默认 draggable=true，不拦会触发原生拖拽（拖出文件/复制光标）
                    vEl.src = vSrc;
                    wrap.appendChild(vEl);

                    // hover 放大预览
                    var preview = document.createElement('div');
                    preview.className = 'ng-video-thumb-preview';
                    var previewVid = document.createElement('video');
                    previewVid.className = 'ng-video-thumb-preview-vid';
                    previewVid.muted = true;
                    previewVid.loop = true;
                    previewVid.preload = 'metadata';
                    previewVid.draggable = false;  // 同 vEl，防原生拖拽
                    previewVid.src = vSrc;
                    preview.appendChild(previewVid);
                    wrap.appendChild(preview);
                    wrap.addEventListener('mouseenter', function () {
                        previewVid.currentTime = 0;
                        previewVid.play().catch(function () {});
                    });
                    wrap.addEventListener('mouseleave', function () {
                        previewVid.pause();
                    });
                }

                // ── 拖拽排序（边空间，同图片缩略图）──
                wrap.addEventListener('dragstart', function (e) {
                    e.dataTransfer.setData('text/plain', vedge.id);
                    e.dataTransfer.effectAllowed = 'move';
                    wrap.classList.add('ng-thumb-dragging');
                });
                wrap.addEventListener('dragend', function () {
                    wrap.classList.remove('ng-thumb-dragging');
                    var allWraps = row.querySelectorAll('.ng-video-thumb-wrap');
                    for (var aw = 0; aw < allWraps.length; aw++) {
                        allWraps[aw].classList.remove('ng-thumb-drop-before', 'ng-thumb-drop-after');
                    }
                });
                wrap.addEventListener('dragover', function (e) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    var rect = wrap.getBoundingClientRect();
                    var mid = rect.left + rect.width / 2;
                    wrap.classList.toggle('ng-thumb-drop-before', e.clientX < mid);
                    wrap.classList.toggle('ng-thumb-drop-after', e.clientX >= mid);
                });
                wrap.addEventListener('dragleave', function () {
                    wrap.classList.remove('ng-thumb-drop-before', 'ng-thumb-drop-after');
                });
                wrap.addEventListener('drop', function (e) {
                    e.preventDefault();
                    wrap.classList.remove('ng-thumb-drop-before', 'ng-thumb-drop-after');
                    var fromId = e.dataTransfer.getData('text/plain');
                    if (!fromId || fromId === vedge.id) return;  // 同边自拖 = no-op
                    var fromEdgeIdx = -1, toEdgeIdx = -1;
                    for (var fi = 0; fi < vidEdges.length; fi++) {
                        if (vidEdges[fi].id === fromId) fromEdgeIdx = fi;
                        if (vidEdges[fi].id === vedge.id) toEdgeIdx = fi;
                    }
                    if (fromEdgeIdx < 0 || toEdgeIdx < 0 || fromEdgeIdx === toEdgeIdx) return;
                    var rect = wrap.getBoundingClientRect();
                    var insertBefore = e.clientX < (rect.left + rect.width / 2);
                    var targetEdgeIdx = insertBefore ? toEdgeIdx : toEdgeIdx + 1;
                    if (fromEdgeIdx < targetEdgeIdx) targetEdgeIdx--;
                    if (fromEdgeIdx === targetEdgeIdx) return;
                    var moved = vidEdges.splice(fromEdgeIdx, 1)[0];
                    vidEdges.splice(targetEdgeIdx, 0, moved);
                    saveVOrder();
                    if (ctx.redrawEdges) ctx.redrawEdges();
                    // 复用现有 wrap 按 edge 顺序重新挂回，不重建 video → 不闪烁、不重载
                    var kids = Array.prototype.slice.call(row.children);
                    var byEid = {};
                    kids.forEach(function (k) { var id = k.dataset.edgeId; if (id) (byEid[id] = byEid[id] || []).push(k); });
                    for (var ri = 0; ri < vidEdges.length; ri++) {
                        var grp = byEid[vidEdges[ri].id];
                        if (grp) for (var gi = 0; gi < grp.length; gi++) row.appendChild(grp[gi]);
                    }
                });

                // × 断开连线
                var btn = document.createElement('button');
                btn.className = 'ng-thumb-close';
                btn.textContent = '×';
                btn.title = AEI18n.t('断开视频连线');
                btn.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    if (ctx.disconnectEdge) {
                        ctx.disconnectEdge(vedge.from, vedge.fromPort, node.id, vedge.toPort);
                        if (node.params && node.params.videoOrder) {
                            var ord = node.params.videoOrder;
                            var oidx = ord.indexOf(vedge.id);
                            if (oidx >= 0) ord.splice(oidx, 1);
                        }
                        _refreshVideoThumb(container, node, ctx);
                    }
                });
                wrap.appendChild(btn);

                row.appendChild(wrap);
            })(vItems[vi2]);
        }
        if (hasContent) container.appendChild(row);
    }

    // 刷新容器顶部输入参考图缩略图（支持多图、拖拽排序、hover 预览、× 断开）
    function _refreshInputThumb(container, node, ctx) {
        // 只清图片缩略图，不动同行视频 ref
        var oldThumbs = container.querySelectorAll('.ng-thumbs, .ng-thumb-wrap, .ng-gen-input-thumb-placeholder');
        for (var ot = 0; ot < oldThumbs.length; ot++) oldThumbs[ot].remove();
        if (!ctx || !ctx.graph) return;
        var edges = ctx.graph.edges ? ctx.graph.edges() : [];
        var imgEdges = [];
        for (var i = 0; i < edges.length; i++) {
            if (edges[i].to === node.id && edges[i].toPort === 'image') {
                imgEdges.push(edges[i]);
            }
        }
        if (!imgEdges.length) {
            var ph = document.createElement('div');
            ph.className = 'ng-gen-input-thumb-placeholder';
            ph.textContent = AEI18n.t('无输入图');
            container.appendChild(ph);
            return;
        }

        // ── 排序：imageOrder 为唯一顺序来源（edge id 序列）──
        // prune 已断开的边 id，新边按连线先后追加末尾，再按 order 排 imgEdges。
        // 这样 imageOrder 始终与当前连线对齐，无 stale id 堆积，新边确定性地落末尾。
        node.params = node.params || {};
        var rawOrder = node.params.imageOrder || [];
        var curIds = {};
        for (var ci = 0; ci < imgEdges.length; ci++) curIds[imgEdges[ci].id] = true;
        var order = [];
        for (var oi = 0; oi < rawOrder.length; oi++) {
            var eid = rawOrder[oi];
            if (curIds[eid] && order.indexOf(eid) < 0) order.push(eid);
        }
        for (var ni = 0; ni < imgEdges.length; ni++) {
            if (order.indexOf(imgEdges[ni].id) < 0) order.push(imgEdges[ni].id);
        }
        node.params.imageOrder = order;
        imgEdges.sort(function (a, b) {
            return order.indexOf(a.id) - order.indexOf(b.id);
        });

        // 收集所有上游路径（空的输入节点给占位）
        var paths = [];
        for (var ei = 0; ei < imgEdges.length; ei++) {
            var upNode = ctx.graph.getNode(imgEdges[ei].from);
            if (!upNode || !upNode.params) {
                paths.push({ placeholder: true, edge: imgEdges[ei] });
                continue;
            }
            var result = upNode.params._result;
            if (result) {
                var imgs = result.images || (result.image ? [result.image] : []);
                if (imgs.length) {
                    for (var j = 0; j < imgs.length; j++) paths.push({ path: imgs[j], edge: imgEdges[ei] });
                } else {
                    paths.push({ placeholder: true, edge: imgEdges[ei] });
                }
            } else if (upNode.params.editedPath) {
                paths.push({ path: upNode.params.editedPath, edge: imgEdges[ei] });
            } else if (upNode.params.path) {
                paths.push({ path: upNode.params.path, edge: imgEdges[ei] });
            } else if (ctx.graphExecutor && ctx.graphExecutor.getResult) {
                var execRes = ctx.graphExecutor.getResult(imgEdges[ei].from);
                if (execRes && execRes.image) {
                    var epaths = Array.isArray(execRes.image) ? execRes.image : [execRes.image];
                    for (var ep = 0; ep < epaths.length; ep++) paths.push({ path: epaths[ep], edge: imgEdges[ei] });
                } else {
                    paths.push({ placeholder: true, edge: imgEdges[ei] });
                }
            } else {
                // 已连线但上游无图（未选图的 imageInput 等）→ 占位符（与节点缩略图行行为一致）
                paths.push({ placeholder: true, edge: imgEdges[ei] });
            }
        }
        if (!paths.length) {
            container.innerHTML = AEI18n.html('<div class="ng-gen-input-thumb-placeholder">无输入图</div>');
            return;
        }

        // ── 保存排序结果到 node.params.imageOrder（仅拖拽后调用）──
        function saveOrder() {
            node.params.imageOrder = [];
            for (var oi = 0; oi < imgEdges.length; oi++) {
                if (imgEdges[oi] && imgEdges[oi].id) node.params.imageOrder.push(imgEdges[oi].id);
            }
            // 图片顺序变 → 多图参考的输入图顺序变 → 旧生成结果无效，清缓存（同 onParamChange）
            if (ctx.invalidateCache) ctx.invalidateCache(node.id);
            if (ctx.markDirty) ctx.markDirty();
            if (ctx.pushHistory) ctx.pushHistory();   // 离散结构操作：立即推历史
        }

        // 按 imgEdges 顺序复用现有 wrap 重新挂回 row（移动节点非重建，img 不重载、不闪烁）
        function reorderThumbDom(rowEl, orderedEdges) {
            var byEdge = {};
            var children = Array.prototype.slice.call(rowEl.children);
            for (var c = 0; c < children.length; c++) {
                var eid = children[c].dataset.edgeId;
                if (!eid) continue;
                if (!byEdge[eid]) byEdge[eid] = [];
                byEdge[eid].push(children[c]);
            }
            for (var i = 0; i < orderedEdges.length; i++) {
                var group = byEdge[orderedEdges[i].id];
                if (!group) continue;
                for (var g = 0; g < group.length; g++) rowEl.appendChild(group[g]);
            }
        }

        // 缩略图行
        var row = document.createElement('div');
        row.className = 'ng-thumbs';

        for (var pi = 0; pi < paths.length; pi++) {
            (function (item) {
                var imgEdge = item.edge;
                var wrap = document.createElement('div');
                wrap.className = 'ng-thumb-wrap';
                wrap.draggable = true;
                wrap.dataset.edgeId = imgEdge.id;

                if (item.placeholder) {
                    // ── 占位符：已连线但上游无图 ──
                    var ph = document.createElement('div');
                    ph.className = 'ng-thumb ng-thumb-placeholder';
                    ph.title = AEI18n.t('等待导入图片…');
                    wrap.appendChild(ph);
                } else {
                    var firstPath = item.path;
                    // 统一走 toFileUrl（既有 file/http/data/blob 前缀直通 + ?#% 编码），
                    // 手搓 file:/// 拼接漏编码，文件名含 #/%/? 时缩略图破图（与 S14 口径统一）
                    var src = global.AEComfyUI.toFileUrl(firstPath);

                    var img = document.createElement('img');
                    img.className = 'ng-thumb';
                    img.draggable = false;
                    img.src = src;
                    img.title = firstPath + AEI18n.t(' (拖拽排序)');
                    wrap.appendChild(img);

                    // hover 大预览
                    var preview = document.createElement('div');
                    preview.className = 'ng-thumb-preview';
                    var preImg = document.createElement('img');
                    preImg.className = 'ng-thumb-preview-img';
                    preImg.draggable = false;
                    preImg.src = src;
                    preview.appendChild(preImg);
                    wrap.appendChild(preview);
                }

                // ── 拖拽排序 ──
                wrap.addEventListener('dragstart', function (e) {
                    e.dataTransfer.setData('text/plain', imgEdge.id);
                    e.dataTransfer.effectAllowed = 'move';
                    wrap.classList.add('ng-thumb-dragging');
                });
                wrap.addEventListener('dragend', function () {
                    wrap.classList.remove('ng-thumb-dragging');
                    var allWraps = row.querySelectorAll('.ng-thumb-wrap');
                    for (var aw = 0; aw < allWraps.length; aw++) {
                        allWraps[aw].classList.remove('ng-thumb-drop-before', 'ng-thumb-drop-after');
                    }
                });
                wrap.addEventListener('dragover', function (e) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    var rect = wrap.getBoundingClientRect();
                    var mid = rect.left + rect.width / 2;
                    wrap.classList.toggle('ng-thumb-drop-before', e.clientX < mid);
                    wrap.classList.toggle('ng-thumb-drop-after', e.clientX >= mid);
                });
                wrap.addEventListener('dragleave', function () {
                    wrap.classList.remove('ng-thumb-drop-before', 'ng-thumb-drop-after');
                });
                wrap.addEventListener('drop', function (e) {
                    e.preventDefault();
                    wrap.classList.remove('ng-thumb-drop-before', 'ng-thumb-drop-after');
                    var fromId = e.dataTransfer.getData('text/plain');
                    if (!fromId || fromId === imgEdge.id) return;  // 同边自拖 = no-op
                    // 多图边共用一个 edge id → 必须在「边空间」算索引，不能用 path 索引
                    // （imageOrder 存 edge id，runGenWorkflow 按边序上传，UI 必须与之对齐）
                    var fromEdgeIdx = -1, toEdgeIdx = -1;
                    for (var fi = 0; fi < imgEdges.length; fi++) {
                        if (imgEdges[fi].id === fromId) fromEdgeIdx = fi;
                        if (imgEdges[fi].id === imgEdge.id) toEdgeIdx = fi;
                    }
                    if (fromEdgeIdx < 0 || toEdgeIdx < 0 || fromEdgeIdx === toEdgeIdx) return;
                    var rect = wrap.getBoundingClientRect();
                    var insertBefore = e.clientX < (rect.left + rect.width / 2);
                    var targetEdgeIdx = insertBefore ? toEdgeIdx : toEdgeIdx + 1;
                    if (fromEdgeIdx < targetEdgeIdx) targetEdgeIdx--;
                    if (fromEdgeIdx === targetEdgeIdx) return;
                    // 整条边为一组移动（边内多图绑定同行，imageOrder 按 edge id 存）
                    var moved = imgEdges.splice(fromEdgeIdx, 1)[0];
                    imgEdges.splice(targetEdgeIdx, 0, moved);
                    saveOrder();
                    if (ctx.redrawEdges) ctx.redrawEdges();
                    // 复用现有 wrap 按 edge 顺序重新挂回，不重建 img → 不闪烁
                    reorderThumbDom(row, imgEdges);
                });

                // × 断开连线
                var btn = document.createElement('button');
                btn.className = 'ng-thumb-close';
                btn.textContent = '×';
                btn.title = AEI18n.t('断开连线');
                btn.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    if (ctx.disconnectEdge) {
                        ctx.disconnectEdge(imgEdge.from, imgEdge.fromPort, node.id, imgEdge.toPort);
                        if (node.params && node.params.imageOrder) {
                            var ord = node.params.imageOrder;
                            var oidx = ord.indexOf(imgEdge.id);
                            if (oidx >= 0) ord.splice(oidx, 1);
                        }
                        _refreshInputThumb(container, node, ctx);
                    }
                });
                wrap.appendChild(btn);

                row.appendChild(wrap);
            })(paths[pi]);
        }
        container.appendChild(row);
    }
})(window);
