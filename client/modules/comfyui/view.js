(function (global) {
    // 剪贴板空结果的**内部哨兵**（不是展示文案）：抛出方与判断方共用这一份串，
    // 上屏时由调用点按当前语言翻译，避免把哨兵值当译文查表。
    var NO_CLIP_MEDIA = '剪贴板无图片/视频';
    function createComfyUIView(controller) {
        var ctrl = controller;
        var panel = null;
        var listeners = [];
        var lightbox = null;
        var lightboxImg = null;
        var lightboxScale = 1;
        var lightboxTargetScale = 1;
        var lightboxScaleAnimId = null;
        var lightboxPanX = 0;
        var lightboxPanY = 0;
        var lightboxDragging = false;
        var lightboxMoved = false;
        var lightboxDragStartX = 0;
        var lightboxDragStartY = 0;
        var lightboxPanStartX = 0;
        var lightboxPanStartY = 0;
        var lightboxVelX = 0;
        var lightboxVelY = 0;
        var lightboxLastX = 0;
        var lightboxLastY = 0;
        var lightboxLastTime = 0;
        var lightboxInertiaId = null;
        var lightboxCloseTimer = null;   // 关闭过渡定时器：重开时须取消，防 200ms 后把新开的图藏掉（对齐 canvas/sharedUtils）
        var formCache = {};  // 按模板ID缓存表单值，切换模板时保留
        var currentTemplateId = null;
        // 当前正在执行的 form 任务 promptId（WS progress/executing 事件记录）。
        // 取消当前批次时 /interrupt 必须打到这张正在跑的（见 cancelFormBatch）；
        // 全局 currentPromptId 是"最后一次提交"，批量时指向排队末尾，打上去无效。
        var _runningFormPromptId = null;
        // 设置弹窗（settingsModal 遮罩）代际计数器——对齐 main.js closeModal 的
        // _modalGen 模式（只读参考）。关闭时递增代数，220ms 过渡定时器回调校验代数未变
        // 才 display='none'；showSettingsModal 重开时同样递增，作废在途的关闭定时器，
        // 防"关闭后 220ms 内重开被迟到定时器藏掉"
        var _settingsMaskGen = 0;

        function lightboxApplyTransform() {
            if (!lightboxImg) return;
            lightboxImg.style.transform = 'translate(' + lightboxPanX + 'px,' + lightboxPanY + 'px) scale(' + lightboxScale + ')';
        }
        function lightboxStopInertia() {
            if (lightboxInertiaId) { cancelAnimationFrame(lightboxInertiaId); lightboxInertiaId = null; }
            if (lightboxScaleAnimId) { cancelAnimationFrame(lightboxScaleAnimId); lightboxScaleAnimId = null; }
        }
        function lightboxAnimateScale() {
            lightboxScaleAnimId = null;
            var diff = lightboxTargetScale - lightboxScale;
            if (Math.abs(diff) < 0.001) { lightboxScale = lightboxTargetScale; lightboxApplyTransform(); return; }
            lightboxScale += diff * 0.25;
            lightboxApplyTransform();
            lightboxScaleAnimId = requestAnimationFrame(lightboxAnimateScale);
        }
        function lightboxSetScale(newScale) {
            lightboxTargetScale = Math.max(0.15, Math.min(8, newScale));
            if (!lightboxScaleAnimId) lightboxScaleAnimId = requestAnimationFrame(lightboxAnimateScale);
        }
        function lightboxStartInertia() {
            lightboxStopInertia();
            var friction = 0.92;
            function step() {
                lightboxVelX *= friction; lightboxVelY *= friction;
                if (Math.abs(lightboxVelX) < 0.3 && Math.abs(lightboxVelY) < 0.3) { lightboxVelX = 0; lightboxVelY = 0; lightboxInertiaId = null; return; }
                lightboxPanX += lightboxVelX; lightboxPanY += lightboxVelY;
                lightboxApplyTransform();
                lightboxInertiaId = requestAnimationFrame(step);
            }
            lightboxInertiaId = requestAnimationFrame(step);
        }

        function getLightbox() {
            if (lightbox) return lightbox;
            lightbox = document.createElement('div');
            lightbox.className = 'comfyui-lightbox';
            lightbox.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0);align-items:center;justify-content:center;transition:background .3s ease;overflow:hidden;';
            lightboxImg = document.createElement('img');
            lightboxImg.style.cssText = 'position:absolute;max-width:90vw;max-height:90vh;object-fit:contain;cursor:grab;user-select:none;outline:2px solid rgba(255,255,255,.15);outline-offset:4px;';
            lightboxImg.draggable = false;
            lightbox.appendChild(lightboxImg);
            document.body.appendChild(lightbox);

            lightbox.addEventListener('wheel', function (e) {
                e.preventDefault();
                var newScale = lightboxTargetScale + (e.deltaY > 0 ? -0.3 : 0.3);
                var rect = lightboxImg.getBoundingClientRect();
                var mx = e.clientX - (rect.left + rect.width / 2);
                var my = e.clientY - (rect.top + rect.height / 2);
                var ratio = newScale / lightboxScale;
                lightboxPanX -= mx * (ratio - 1);
                lightboxPanY -= my * (ratio - 1);
                lightboxSetScale(newScale);
            });
            lightboxImg.addEventListener('mousedown', function (e) {
                if (e.button !== 0 && e.button !== 1) return;
                e.stopPropagation();
                lightboxStopInertia();
                lightboxDragging = true;
                lightboxMoved = false;
                lightboxDragStartX = e.clientX; lightboxDragStartY = e.clientY;
                lightboxPanStartX = lightboxPanX; lightboxPanStartY = lightboxPanY;
                lightboxLastX = e.clientX; lightboxLastY = e.clientY;
                lightboxLastTime = Date.now();
                lightboxVelX = 0; lightboxVelY = 0;
                lightboxImg.style.cursor = 'grabbing';
                lightboxImg.style.transition = 'none';
            });
            window.addEventListener('mousemove', function (e) {
                if (!lightboxDragging) return;
                var dx = e.clientX - lightboxDragStartX, dy = e.clientY - lightboxDragStartY;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) lightboxMoved = true;
                var now = Date.now(), dt = Math.max(1, now - lightboxLastTime);
                lightboxPanX = lightboxPanStartX + dx;
                lightboxPanY = lightboxPanStartY + dy;
                lightboxVelX = (e.clientX - lightboxLastX) / dt * 16;
                lightboxVelY = (e.clientY - lightboxLastY) / dt * 16;
                lightboxLastX = e.clientX; lightboxLastY = e.clientY;
                lightboxLastTime = now;
                lightboxApplyTransform();
            });
            window.addEventListener('mouseup', function (e) {
                if (!lightboxDragging) return;
                lightboxDragging = false;
                lightboxImg.style.cursor = 'grab';
                lightboxImg.style.transition = 'transform .15s ease-out';
                if (Math.abs(lightboxVelX) > 0.5 || Math.abs(lightboxVelY) > 0.5) lightboxStartInertia();
            });
            lightbox.addEventListener('dblclick', function (e) {
                if (e.target === lightboxImg) {
                    lightboxStopInertia();
                    lightboxScale = 1; lightboxTargetScale = 1; lightboxPanX = 0; lightboxPanY = 0;
                    lightboxApplyTransform();
                }
            });
            // 点击背景关闭
            lightbox.addEventListener('click', function (e) {
                if (e.target === lightbox) closeLightbox();
            });
            // 点击图片关闭（仅当未拖拽时）
            lightboxImg.addEventListener('click', function (e) {
                if (!lightboxMoved) closeLightbox();
            });
            return lightbox;
        }

        function openLightbox(src, isVideo) {
            if (isVideo) { openVideoLightbox(src); return; }
            var lb = getLightbox();
            lightboxStopInertia();
            // 取消在途的关闭过渡定时器——关闭后 200ms 内重开时，迟到的定时器
            // 会把新开的图藏掉（display='none' + src=''）
            if (lightboxCloseTimer) { clearTimeout(lightboxCloseTimer); lightboxCloseTimer = null; }
            lightboxScale = 1; lightboxTargetScale = 1; lightboxPanX = 0; lightboxPanY = 0;
            lightboxVelX = 0; lightboxVelY = 0;
            lightboxMoved = false;
            lightboxImg.src = src;
            lightboxImg.style.transition = 'transform .15s ease-out';
            lightboxApplyTransform();
            lb.style.display = 'flex';
            lb.style.transition = 'opacity .2s ease, background .2s ease';
            lb.style.opacity = '0';
            lb.style.background = 'rgba(0,0,0,0.92)';
            requestAnimationFrame(function () { lb.style.opacity = '1'; });
        }

        var videoLightbox = null;
        var videoLightboxCloseTimer = null;  // 视频侧同款：关闭过渡定时器，重开时取消
        function openVideoLightbox(src) {
            if (!videoLightbox) {
                videoLightbox = document.createElement('div');
                videoLightbox.className = 'comfyui-lightbox';
                videoLightbox.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0);align-items:center;justify-content:center;transition:opacity .2s ease,background .2s ease;';
                var v = document.createElement('video');
                v.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:4px;outline:2px solid rgba(255,255,255,.15);outline-offset:4px;';
                v.controls = true;
                videoLightbox.appendChild(v);
                videoLightbox.addEventListener('click', function (e) {
                    if (e.target === videoLightbox) closeVideoLightbox();
                });
                document.body.appendChild(videoLightbox);
            }
            var v = videoLightbox.querySelector('video');
            // 取消在途的关闭过渡定时器（同图片侧）
            if (videoLightboxCloseTimer) { clearTimeout(videoLightboxCloseTimer); videoLightboxCloseTimer = null; }
            v.src = src;
            videoLightbox.style.display = 'flex';
            videoLightbox.style.opacity = '0';
            videoLightbox.style.background = 'rgba(0,0,0,0.92)';
            requestAnimationFrame(function () { videoLightbox.style.opacity = '1'; });
            v.play().catch(function () {});
        }
        function closeVideoLightbox() {
            if (!videoLightbox) return;
            var v = videoLightbox.querySelector('video');
            v.pause();
            videoLightbox.style.opacity = '0';
            // 持有句柄（重开时取消），替代原匿名 setTimeout
            if (videoLightboxCloseTimer) clearTimeout(videoLightboxCloseTimer);
            videoLightboxCloseTimer = setTimeout(function () {
                videoLightboxCloseTimer = null;
                if (videoLightbox) {
                    videoLightbox.style.display = 'none';
                    v.src = '';
                }
            }, 200);
        }

        function closeLightbox() {
            if (!lightbox) return;
            lightboxStopInertia();
            lightbox.style.opacity = '0';
            // 持有句柄（重开时取消），替代原匿名 setTimeout
            if (lightboxCloseTimer) clearTimeout(lightboxCloseTimer);
            lightboxCloseTimer = setTimeout(function () {
                lightboxCloseTimer = null;
                if (lightbox) {
                    lightbox.style.display = 'none';
                    lightboxImg.src = '';
                    lightboxScale = 1; lightboxPanX = 0; lightboxPanY = 0;
                }
            }, 200);
        }

        function on(el, event, handler) {
            el.addEventListener(event, handler);
            listeners.push({ el: el, event: event, handler: handler });
        }

        function offAll() {
            listeners.forEach(function (l) { l.el.removeEventListener(l.event, l.handler); });
            listeners = [];
        }

        // 局部解绑（offAll 的 scoped 版本）：移除 root 自身及子树内元素的监听条目并解绑。
        // renderParams 这类 innerHTML 整块重建场景：旧元素已 detached，若条目留在
        // listeners 里会连同闭包被长期持有（detached DOM 泄漏），重建前必须清掉。
        // root 自身也解绑——结果卡片删除（offWithin(card)）时 card 上直接注册的
        // mouseenter/mouseleave（视频卡片）也须回收；paramsContainer 自身无监听，语义不变。
        function offWithin(root) {
            if (!root || typeof root.contains !== 'function') return;
            var kept = [];
            for (var i = 0; i < listeners.length; i++) {
                var l = listeners[i];
                if (l.el === root || root.contains(l.el)) {
                    l.el.removeEventListener(l.event, l.handler);
                } else {
                    kept.push(l);
                }
            }
            listeners = kept;
        }

        function bind() {
            panel = document.getElementById('comfyuiPanel');
            if (!panel) return;
            // 补发 init 期攒下的工作流提示（controller 侧队列：那时 panel 还是 null，
            // showError 会静默丢弃——见 controller.flushWorkflowNotices）
            if (ctrl && typeof ctrl.flushWorkflowNotices === 'function') {
                try { ctrl.flushWorkflowNotices(); } catch (_fn) {}
            }

            var connectBtn = panel.querySelector('.comfyui-connect-btn');
            if (connectBtn) on(connectBtn, 'click', function () {
                ctrl.testConnection().catch(function (e) {
                    showError(AEI18n.t('连接失败: {detail}', { detail: e.message }));
                });
            });

            var closeSettingsBtn = document.getElementById('closeSettingsBtn');
            if (closeSettingsBtn) on(closeSettingsBtn, 'click', function () {
                if (document.getElementById(COMFYUI_SETTINGS_CONTAINER) || document.getElementById('mcpSettingsContainer') || document.getElementById('skillSettingsContainer')) {
                    closeComfyuiSettings();
                    return;
                }
                var mask = document.getElementById('settingsModal');
                if (mask) {
                    var modal = mask.querySelector('.modal');
                    if (modal) {
                        modal.style.opacity = '0';
                        modal.style.transform = 'translateY(10px) scale(.98)';
                    }
                    mask.style.opacity = '0';
                    // 代际守卫——关闭递增代数，定时器回调校验代数未变才隐藏
                    // （关闭后 220ms 内重开由 showSettingsModal 递增代数使本定时器失效）
                    var _closeGen = ++_settingsMaskGen;
                    setTimeout(function () {
                        if (_settingsMaskGen !== _closeGen) return;
                        mask.style.display = 'none';
                    }, 220);
                }
            });


            var templateSelect = panel.querySelector('.comfyui-template-select');
            if (templateSelect) {
                on(templateSelect, 'change', function () {
                    // 切换前保存当前表单值
                    collectParamValues();
                    ctrl.selectTemplate(templateSelect.value);
                });
            }

            // 官方模板浏览入口：搜索官方库 → 选中拉取转换注册（表单/画布即用）
            var officialBtn = panel.querySelector('.comfyui-official-btn');
            if (officialBtn) {
                on(officialBtn, 'click', function () {
                    showOfficialTemplatesModal();
                });
            }

            var importBtn = panel.querySelector('.comfyui-import-workflow');
            if (importBtn) {
                on(importBtn, 'click', function () {
                    var input = document.createElement('input');
                    input.type = 'file';
                    input.accept = '.json';
                    input.addEventListener('change', function (ev) {
                        var file = ev.target.files[0];
                        if (!file) return;
                        var reader = new FileReader();
                        reader.onload = async function (rev) {
                            var jsonContent = rev.target.result;
                            try {
                                // 处理中状态：UI 格式（编辑器 Save）转换要拉 /object_info，
                                // 冷启动首次可能秒级
                                showStatus(AEI18n.t('正在导入工作流...'));
                                // 双格式入口：UI 格式经 uiToApi 转换（失败不注册、不进下拉；
                                // 若把 UI 格式静默注册成空参数模板，点生成才在服务端报错）
                                var res = await ctrl.importWorkflowFile(jsonContent, file.name);
                                if (!res.ok) {
                                    showError(AEI18n.t('工作流导入失败: {detail}', { detail: res.error.message }));
                                    return;
                                }
                                var custom = res.data.template;
                                renderParams(custom);
                                if (templateSelect) {
                                    // 按 id 查重——同一工作流重复导入时
                                    // importWorkflowFile 复用既有模板 id，append 前查重
                                    // 避免下拉累积重复 option
                                    var _optExists = false;
                                    for (var _oi = 0; _oi < templateSelect.options.length; _oi++) {
                                        if (templateSelect.options[_oi].value === custom.id) { _optExists = true; break; }
                                    }
                                    if (!_optExists) {
                                        var opt = document.createElement('option');
                                        opt.value = custom.id;
                                        opt.textContent = custom.name;
                                        templateSelect.appendChild(opt);
                                    }
                                    templateSelect.value = custom.id;
                                }
                                // 落盘到固定工作流目录（<数据目录>\comfyui\workflows）：
                                // 主目录存转换后的 API 格式，原件进 originals/ 子目录。
                                // 写失败必须可见（本次会话已注册在内存仍可用，重启后需重新导入）。
                                var saved;
                                try {
                                    saved = await ctrl.saveWorkflowFile(jsonContent, file.name);
                                } catch (e2) {
                                    saved = { ok: false, message: (e2 && e2.message) ? e2.message : String(e2) };
                                }
                                var _convNote = res.data.converted ? '（已从 UI 格式转换）' : '';
                                // 转换器跳过的界面控制节点（rgthree 旁路开关一族）如实告知：
                                // 跳过是有意为之（不参与 API 执行），但不能无声。
                                // skipped 条目可能带 dropped（V3 隐藏输入值被丢弃，
                                // 节点本身是安装了的）——两类分句，别把带 dropped 的误报成「未安装」。
                                if (res.data.skipped && res.data.skipped.length) {
                                    var _skippedUi = [];
                                    var _droppedCnt = 0;
                                    for (var _ski = 0; _ski < res.data.skipped.length; _ski++) {
                                        var _sk = res.data.skipped[_ski];
                                        if (_sk && _sk.dropped) _droppedCnt++;
                                        else _skippedUi.push(_sk);
                                    }
                                    if (_skippedUi.length) {
                                        _convNote += '（已跳过 ' + _skippedUi.length + ' 个未安装的界面控制节点: '
                                            + _skippedUi.map(function (sk) { return sk.type; }).join('、') + '）';
                                    }
                                    if (_droppedCnt) {
                                        _convNote += '（' + _droppedCnt + ' 个节点的隐藏输入值按默认值处理）';
                                    }
                                }
                                if (saved && saved.ok) {
                                    showStatus(AEI18n.t('已导入并保存到: ') + saved.path + _convNote);
                                } else {
                                    showStatus(AEI18n.t('工作流已导入，但保存到文件夹失败: ') + ((saved && saved.message) || AEI18n.t('未知错误'))
                                        + _convNote + AEI18n.t('（本次会话仍可用，重启后需重新导入）'), 'error');
                                }
                            } catch (err) {
                                showError(AEI18n.t('工作流加载失败: {detail}', { detail: err.message }));
                            }
                        };
                        reader.readAsText(file);
                    });
                    input.click();
                });
            }

            var generateBtn = panel.querySelector('.comfyui-generate-btn');
            if (generateBtn) on(generateBtn, 'click', function () {
                var values = collectParamValues();
                ctrl.generate(values).catch(function (e) {
                    showError(AEI18n.t('生成失败: {detail}', { detail: e.message }), 'form');  // 表单生成失败终态，移除进度卡
                });
            });

            var cancelBtn = panel.querySelector('.comfyui-cancel-btn');
            if (cancelBtn) on(cancelBtn, 'click', function () {
                // 顶栏取消只取消"表单（form）来源"的任务——并发生成时全局
                // currentPromptId 是"最后一次提交"（可能是画布/LLM 任务），无参
                // interrupt 会取消错对象（与进度卡取消按钮语义对齐）。
                // 本轮取消语义 = 清掉当前批次排队项 + 中断正在跑的那张（见 cancelFormBatch）；
                // 返回值透出（提示在请求结果落定后按成/败给出，见 cancelFormBatch）
                return cancelFormBatch();
            });

            var expandBtn = panel.querySelector('.comfyui-expand-btn');
            if (expandBtn) on(expandBtn, 'click', function () {
                toggleIframe().catch(function (e) {
                    console.error('[ComfyUI] toggleIframe error:', e);
                });
            });

            // 可拖拽分界线
            var divider = panel.querySelector('.comfyui-divider');
            var paramsPanel = panel.querySelector('.comfyui-params');
            if (divider && paramsPanel) {
                var isDragging = false;
                var startX, startW;
                on(divider, 'mousedown', function (e) {
                    isDragging = true;
                    startX = e.clientX;
                    startW = paramsPanel.offsetWidth;
                    divider.classList.add('dragging');
                    document.body.style.cursor = 'col-resize';
                    document.body.style.userSelect = 'none';
                });
                // document 级监听须走 on() 注册，unbind 的 offAll 才能移除（否则每次 mount/unmount 泄漏一对）
                on(document, 'mousemove', function (e) {
                    if (!isDragging) return;
                    var containerW = panel.querySelector('.comfyui-main').offsetWidth;
                    var newW = Math.max(200, Math.min(containerW - 300, startW + (e.clientX - startX)));
                    paramsPanel.style.width = newW + 'px';
                    paramsPanel.style.flex = 'none';
                });
                on(document, 'mouseup', function () {
                    if (!isDragging) return;
                    isDragging = false;
                    divider.classList.remove('dragging');
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                });
            }

            // 重新挂载时重绑已有结果卡片：unbind 的 offAll 会移除卡片上的监听，
            // 但 DOM 卡片保留，这里必须重新绑定，否则重进模块后预览/导入/删除都点不动
            // 按 dataset.globalIndex 恢复结果对象引用绑定（dataset 与数组
            // 索引的一致性由删除后的 indexOf 重排维持）
            var existingCards = panel.querySelectorAll('.comfyui-result-card[data-global-index]');
            existingCards.forEach(function (card) {
                bindCardEvents(card, ctrl.getResults()[parseInt(card.dataset.globalIndex)]);
            });

            // 粘贴图片/视频：剪贴板含图片或视频文件时拦截粘贴，填入当前 hover/聚焦的图槽，
            // 否则填第一个空槽；纯文本粘贴放行（不影响提示词 textarea 正常粘贴文字）
            on(panel, 'paste', function (e) {
                var cd = e.clipboardData;
                if (!cd || !cd.items || !cd.items.length) return;
                // 优先取图片/视频；记录是否存在任意文件（用于"不支持格式"提示）
                var file = null;
                var anyFile = null;
                for (var i = 0; i < cd.items.length; i++) {
                    var it = cd.items[i];
                    if (it.kind !== 'file') continue;
                    var f = it.getAsFile();
                    if (!f) continue;
                    if (!anyFile) anyFile = f;
                    if (f.type && (f.type.indexOf('image/') === 0 || f.type.indexOf('video/') === 0)) {
                        file = f;
                        break;
                    }
                }
                if (!file) {
                    if (!anyFile) return; // 纯文本：交给浏览器默认处理
                    e.preventDefault();
                    showStatus(AEI18n.t('剪贴板内容不是图片/视频，无法粘贴'), 'warn');
                    return;
                }

                // 目标图槽：hover/聚焦优先，否则第一个空槽
                var zone = panel.querySelector('.comfyui-image-drop:hover') ||
                           panel.querySelector('.comfyui-image-drop:focus');
                if (!zone) {
                    var zones = panel.querySelectorAll('.comfyui-image-drop');
                    for (var z = 0; z < zones.length; z++) {
                        if (!zones[z].dataset.filename) { zone = zones[z]; break; }
                    }
                }
                if (!zone) { showStatus(AEI18n.t('没有可粘贴的参考槽'), 'warn'); return; }
                if (!fileMatchesMediaType(file, zone.dataset.mediaType)) {
                    showStatus(zone.dataset.mediaType === 'video' ? AEI18n.t('请粘贴视频文件') : AEI18n.t('请粘贴图片文件'), 'warn');
                    return;
                }
                e.preventDefault();
                handleImageDrop(zone, file);
                showStatus(AEI18n.t('已粘贴') + (zone.dataset.mediaType === 'video' ? AEI18n.t('参考视频') : AEI18n.t('参考图')), 'success');
            });

            ctrl.testConnection().catch(function () {});
        }

        function unbind() {
            offAll();
            closeLightbox();
            // 官方模板库 overlay 挂在 document.body，不随视图卸载消失：卸载时兜底关闭
            if (global.AEComfyUI && global.AEComfyUI.officialTemplateModal) global.AEComfyUI.officialTemplateModal.close();
            // 不清空 formCache：unmount 旨在保留表单缓存和生成结果（见 index.js），
            // 重进模块时 renderParams 用缓存值恢复表单。currentTemplateId 也保留。
            panel = null;
        }

        function escapeHtml(str) {
            if (str === null || str === undefined) return '';
            return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        // 数值属性：强制 Number，非有限数回退默认值。
        // 等价原 (p.min || 0) 输出行为，但挡住字符串/异常值拼进 min/max/step 属性。
        function numAttr(name, val, dflt) {
            var n = Number(val);
            if (!Number.isFinite(n)) n = dflt;
            return ' ' + name + '="' + n + '"';
        }

        function buildImageSlotHtml(key, showRemove, isVideo) {
            var mediaType = isVideo ? 'video' : 'image';
            var safeKey = escapeHtml(key);
            var html = '<div class="comfyui-image-slot" data-slot-key="' + safeKey + '">';
            html += '<div class="comfyui-image-drop" data-key="' + safeKey + '" data-media-type="' + mediaType + '">';
            if (!isVideo) {
                html += '<button class="comfyui-capture-btn" data-key="' + safeKey + '" title="' + AEI18n.t('从AE视窗获取当前帧') + '" type="button">📷</button>';
                // 粘贴按钮：截图按钮右边（left:34px）
                html += '<button class="comfyui-paste-btn" data-key="' + safeKey + '" title="' + AEI18n.t('粘贴图片') + '" type="button" style="left:34px">📋</button>';
            } else {
                // 视频槽无截图按钮，粘贴按钮单独放左上（left:4px，CSS 默认）
                html += '<button class="comfyui-paste-btn" data-key="' + safeKey + '" title="' + AEI18n.t('粘贴视频') + '" type="button">📋</button>';
            }
            html += '<div class="comfyui-image-placeholder">' + (isVideo ? AEI18n.t('拖拽视频或点击选择') : AEI18n.t('拖拽图片或点击选择')) + '</div>';
            if (isVideo) {
                html += '<video class="comfyui-image-preview comfyui-video-preview" preload="metadata" style="display:none"></video>';
            } else {
                html += '<img class="comfyui-image-preview" style="display:none">';
            }
            html += AEI18n.html('<span class="comfyui-image-clear" title="清空" style="display:none">&times;</span>');
            html += '</div>';
            if (showRemove) {
                html += AEI18n.html('<button class="comfyui-image-slot-remove" title="移除此项">✕</button>');
            }
            html += '</div>';
            return html;
        }

        function fileMatchesMediaType(file, mediaType) {
            if (!file || !file.type) return false;
            if (mediaType === 'video') return /^video\//.test(file.type);
            return /^image\//.test(file.type);
        }

        // 常见扩展名 → MIME（Bridge 文件路径结果构造 File 用）
        function _mimeFromExt(ext) {
            var m = {
                png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
                webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
                mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
                avi: 'video/x-msvideo', mkv: 'video/x-matroska', m4v: 'video/mp4',
                mpg: 'video/mpeg', mpeg: 'video/mpeg', wmv: 'video/x-ms-wmv', flv: 'video/x-flv'
            };
            return m[ext] || '';
        }

        function _base64ToFile(b64, mime) {
            var bin = atob(b64);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            var ext = (mime.split('/')[1] || 'png').replace(/[^a-zA-Z0-9]/g, '');
            return new File([bytes], 'pasted_' + Date.now() + '.' + ext, { type: mime });
        }

        // 从剪贴板读图片/视频文件（按钮点击用，paste 事件用 clipboardData）
        // 优先 AEFS/Bridge 原生通道（CEF file:// 下 navigator.clipboard.read() 被拒，免 Ctrl+V）；
        // bridge 不可用/读取失败回退浏览器通道。与画布 _readClipboardImage 同一约定。
        function readClipboardFile() {
            if (global.AEFS && typeof global.AEFS.readClipboard === 'function') {
                return global.AEFS.readClipboard().then(function (r) {
                    if (r && r.ok && r.kind === 'image' && r.base64) {
                        return _base64ToFile(r.base64, r.mime || 'image/png');
                    }
                    if (r && r.ok && r.kind === 'files' && r.files && r.files.length) {
                        // Explorer 复制的文件：读字节构造 File（generate 走 uploadImage 需字节）
                        var p = r.files[0];
                        var name = String(p).split(/[\\\/]/).pop() || ('pasted_' + Date.now());
                        var ext = (name.split('.').pop() || '').toLowerCase();
                        var mime = _mimeFromExt(ext);
                        if (!mime) throw new Error('剪贴板文件不是图片/视频');
                        if (typeof global.AEFS.readBlob !== 'function') throw new Error('AEFS 不支持读文件');
                        return global.AEFS.readBlob(p).then(function (res) {
                            if (!res || !res.success || !res.blob) throw new Error('读取剪贴板文件失败');
                            return new File([res.blob], name, { type: mime });
                        });
                    }
                    if (r && r.ok === false && r.error === 'empty') {
                        throw new Error('剪贴板无图片/视频');
                    }
                    // bridge 未启动/读取失败：回退浏览器通道
                    return _readClipboardViaBrowser();
                });
            }
            return _readClipboardViaBrowser();
        }

        // 浏览器通道：file:// 下 navigator.clipboard.read() 可能因安全上下文失败
        function _readClipboardViaBrowser() {
            return new Promise(function (resolve, reject) {
                if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
                    reject(new Error('浏览器不支持剪贴板读取'));
                    return;
                }
                navigator.clipboard.read().then(function (items) {
                    for (var i = 0; i < items.length; i++) {
                        var types = items[i].types;
                        for (var t = 0; t < types.length; t++) {
                            var ty = types[t];
                            if (ty.indexOf('image/') === 0 || ty.indexOf('video/') === 0) {
                                var capturedType = ty;
                                items[i].getType(ty).then(function (blob) {
                                    var ext = (capturedType.split('/')[1] || 'bin').replace(/[^a-zA-Z0-9]/g, '');
                                    resolve(new File([blob], 'pasted_' + Date.now() + '.' + ext, { type: capturedType }));
                                }).catch(reject);
                                return;
                            }
                        }
                    }
                    reject(new Error('剪贴板无图片/视频'));
                }).catch(reject);
            });
        }

        // 绑定粘贴按钮：点击读剪贴板，填入该按钮所属图槽
        function bindPasteButton(btn) {
            if (!btn) return;
            on(btn, 'click', function (e) {
                e.stopPropagation();
                var key = btn.dataset.key;
                var origText = btn.textContent;
                btn.textContent = '⏳';
                btn.disabled = true;
                readClipboardFile().then(function (file) {
                    var zone = panel.querySelector('.comfyui-image-drop[data-key="' + key + '"]');
                    if (!zone) return;
                    if (!fileMatchesMediaType(file, zone.dataset.mediaType)) {
                        showStatus(zone.dataset.mediaType === 'video' ? AEI18n.t('请粘贴视频文件') : AEI18n.t('请粘贴图片文件'), 'warn');
                        return;
                    }
                    handleImageDrop(zone, file);
                    showStatus(AEI18n.t('已粘贴') + (zone.dataset.mediaType === 'video' ? AEI18n.t('参考视频') : AEI18n.t('参考图')), 'success');
                }).catch(function (err) {
                    var msg = (err && err.message) || AEI18n.t('未知错误');
                    // 剪贴板为空是确定性结果，不再提示 Ctrl+V；其余失败保留手动粘贴后路
                    showStatus(msg === NO_CLIP_MEDIA ? AEI18n.t('剪贴板无图片/视频') : (AEI18n.t('粘贴失败：') + msg + AEI18n.t('（可改用 Ctrl+V）')), 'warn');
                }).then(function () {
                    btn.textContent = origText;
                    btn.disabled = false;
                });
            });
        }

        function bindImageSlotEvents(slotEl) {
            if (!slotEl) return;
            var zone = slotEl.querySelector('.comfyui-image-drop');
            var preview = slotEl.querySelector('.comfyui-image-preview');
            var clearBtn = slotEl.querySelector('.comfyui-image-clear');
            var captureBtn = slotEl.querySelector('.comfyui-capture-btn');

            if (zone) {
                on(zone, 'dragover', function (e) { e.preventDefault(); zone.classList.add('dragover'); });
                on(zone, 'dragleave', function () { zone.classList.remove('dragover'); });
                on(zone, 'drop', function (e) {
                    e.preventDefault();
                    zone.classList.remove('dragover');
                    var file = e.dataTransfer.files[0];
                    if (!file) return;
                    if (!fileMatchesMediaType(file, zone.dataset.mediaType)) {
                        showStatus(zone.dataset.mediaType === 'video' ? AEI18n.t('请拖入视频文件') : AEI18n.t('请拖入图片文件'));
                        return;
                    }
                    handleImageDrop(zone, file);
                });
                on(zone, 'click', function (e) {
                    if (e.target.classList.contains('comfyui-image-clear')) return;
                    if (e.target.classList.contains('comfyui-capture-btn')) return;
                    if (e.target.classList.contains('comfyui-paste-btn')) return;
                    var input = document.createElement('input');
                    input.type = 'file';
                    input.accept = zone.dataset.mediaType === 'video' ? 'video/*' : 'image/*';
                    // 临时 input 不入 listeners：元素不挂 DOM、选完即弃，监听随元素一起可回收
                    input.addEventListener('change', function (ev) {
                        if (ev.target.files[0]) handleImageDrop(zone, ev.target.files[0]);
                    });
                    input.click();
                });
            }
            // 📋 粘贴按钮
            bindPasteButton(slotEl.querySelector('.comfyui-paste-btn'));
            if (preview) {
                on(preview, 'click', function (e) {
                    e.stopPropagation();
                    if (preview.tagName === 'IMG') openLightbox(preview.src);
                    else openLightbox(preview.src, true);
                });
            }
            if (clearBtn) {
                on(clearBtn, 'click', function (e) { e.stopPropagation(); clearImageDrop(zone); });
            }
            if (captureBtn) {
                on(captureBtn, 'click', function (e) {
                    e.stopPropagation();
                    var key = captureBtn.dataset.key;
                    captureBtn.textContent = '⏳';
                    captureBtn.disabled = true;
                    ctrl.captureCurrentFrame().then(function (file) {
                        var dropZone = slotEl.querySelector('.comfyui-image-drop[data-key="' + key + '"]');
                        if (dropZone) handleImageDrop(dropZone, file);
                        showStatus(AEI18n.t('已获取AE当前帧'));
                    }).catch(function (e) {
                        showError(AEI18n.t('获取帧失败: {detail}', { detail: e.message }));
                    }).then(function () {
                        captureBtn.textContent = '📷';
                        captureBtn.disabled = false;
                    });
                });
            }

            var removeBtn = slotEl.querySelector('.comfyui-image-slot-remove');
            if (removeBtn) {
                on(removeBtn, 'click', function () {
                    var group = slotEl.closest('.comfyui-param-multiple');
                    // 移除前解绑槽内监听（文件选择/截图/删除按钮等），detached 元素
                    // 不再被 listeners 数组连同闭包持有直至 unbind
                    offWithin(slotEl);
                    slotEl.remove();
                    if (group) {
                        var addBtn = group.querySelector('.comfyui-add-image-btn');
                        var currentCount = group.querySelectorAll('.comfyui-image-slot').length;
                        var maxCount = parseInt(group.dataset.maxCount) || 10;
                        if (addBtn && currentCount < maxCount) {
                            addBtn.style.display = '';
                        }
                    }
                });
            }
        }

        function renderParams(template) {
            if (!panel) return;  // unbind 后 panel=null：LLM 工具 selectTemplate 仍会调用，静默跳过
            var paramsContainer = panel.querySelector('.comfyui-params-form');
            if (!paramsContainer || !template) return;

            // 按当前模板取缓存值（确保缓存对象落在 formCache 上，
            // 下拉值因模型清单变化被回退时才能写回持久值）
            currentTemplateId = template.id;
            if (!formCache[template.id]) formCache[template.id] = {};
            var cached = formCache[template.id];

            var html = '';
            template.parameters.forEach(function (p, _pIdx) {
                var val = cached[p.key] !== undefined ? cached[p.key] : p.default;
                var safeKey = escapeHtml(p.key);
                var isMultipleImage = ((p.type === 'image' || p.type === 'video') && p.multiple);
                // 入场动画：按行索引错开 delay，顶上的先出
                var _animStyle = 'animation:comfyui-param-enter 0.3s ease-out ' + (_pIdx * 0.04) + 's both;';
                html += '<div class="comfyui-param' + (isMultipleImage ? ' comfyui-param-multiple' : '') + '" data-key="' + safeKey + '" style="' + _animStyle + '"' + (isMultipleImage ? ' data-multiple="true"' + numAttr('data-max-count', p.maxCount, 10) : '') + '>';
                // 参数 label 来自模板 JSON（中文源文），显示前经 t()：zh 原样，其它语言查词典。
                html += '<label>' + escapeHtml(AEI18n.t(p.label || p.key)) + '</label>';

                if (p.type === 'textarea') {
                    html += '<textarea data-key="' + safeKey + '" rows="3">' + escapeHtml(val) + '</textarea>';
                } else if (p.type === 'number') {
                    html += '<div class="comfyui-slider-row">';
                    html += '<input type="range" class="comfyui-slider" data-key="' + safeKey + '"' + numAttr('min', p.min, 0) + numAttr('max', p.max, 100) + numAttr('step', p.step, 1) + ' value="' + escapeHtml(val || 0) + '">';
                    html += '<div class="comfyui-stepper">';
                    html += '<input type="number" class="comfyui-param-number" data-key="' + safeKey + '"' + numAttr('min', p.min, 0) + numAttr('max', p.max, 100) + numAttr('step', p.step, 1) + ' value="' + escapeHtml(val || 0) + '">';
                    html += '<button class="comfyui-step-btn" data-dir="down" tabindex="-1">−</button>';
                    html += '<button class="comfyui-step-btn" data-dir="up" tabindex="-1">+</button>';
                    html += '</div>';
                    html += '</div>';
                } else if (p.type === 'image' || p.type === 'video') {
                    var isVideo = (p.type === 'video');
                    if (p.multiple) {
                        var baseKey = p.key;
                        html += '<div class="comfyui-image-slots">';
                        html += buildImageSlotHtml(baseKey + '_1', false, isVideo);
                        html += '</div>';
                        html += '<button class="btn btn-slice secondary comfyui-add-image-btn" data-base-key="' + escapeHtml(baseKey) + '">' + (isVideo ? AEI18n.t('＋ 添加参考视频') : AEI18n.t('＋ 添加参考图')) + '</button>';
                    } else {
                        html += buildImageSlotHtml(p.key, false, isVideo);
                    }
                } else if (p.type === 'boolean') {
                    html += '<label class="toggle-wrap"><input type="checkbox" class="switch-input" data-key="' + safeKey + '"' + (val ? ' checked' : '') + '><span class="switch-slider" aria-hidden="true"></span></label>';
                } else if (p.type === 'select') {
                    // 缓存值可能因模型清单变化（视频/不支持模型被过滤）而不在选项里：
                    // 回退到模板默认值/首项并写回缓存，避免下拉显示空白、提交空值
                    var _choices = p.choices || [];
                    var _selVal = val;
                    var _inChoices = function (v) {
                        for (var _ci = 0; _ci < _choices.length; _ci++) {
                            if (String(_choices[_ci]) === String(v)) return true;
                        }
                        return false;
                    };
                    if (_choices.length > 0 && !_inChoices(_selVal)) {
                        _selVal = _inChoices(p.default) ? p.default : _choices[0];
                        cached[p.key] = _selVal;
                    }
                    html += '<select data-key="' + safeKey + '">';
                    _choices.forEach(function (c) {
                        html += '<option value="' + escapeHtml(c) + '"' + (String(c) === String(_selVal) ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
                    });
                    html += '</select>';
                } else {
                    html += '<input type="text" data-key="' + safeKey + '" value="' + escapeHtml(val) + '"' + (p.placeholder ? ' placeholder="' + escapeHtml(p.placeholder) + '"' : '') + '>';
                }

                html += '</div>';
            });

            // 重建前清掉旧参数区子树的监听条目（防 detached DOM 与闭包随 listeners 累积）
            offWithin(paramsContainer);
            // 重建前 revoke 图片/视频槽的 objectURL——handleImageDrop 创建的
            // blob: URL 挂在旧 zone 元素上，innerHTML 整块重建后旧元素 detached，但 URL
            // 未 revoke 则底层 blob 一直驻留内存（每次切换模板/模型版本重建都泄漏一批）
            var _oldZones = paramsContainer.querySelectorAll('.comfyui-image-drop');
            for (var _zi = 0; _zi < _oldZones.length; _zi++) {
                if (_oldZones[_zi]._objectUrl) {
                    URL.revokeObjectURL(_oldZones[_zi]._objectUrl);
                    _oldZones[_zi]._objectUrl = null;
                }
            }
            paramsContainer.innerHTML = html;
            bindParamEvents();
        }

        function _setFormNumber(key, value) {
            if (!panel) return;
            var slider = panel.querySelector('.comfyui-slider[data-key="' + key + '"]');
            var number = panel.querySelector('.comfyui-param-number[data-key="' + key + '"]');
            var found = false;
            if (slider) { slider.value = value; found = true; }
            if (number) { number.value = value; found = true; }
            if (found && currentTemplateId) {
                formCache[currentTemplateId] = formCache[currentTemplateId] || {};
                formCache[currentTemplateId][key] = value;
            }
        }

        function _setFormSelect(key, value) {
            if (!panel || value === undefined || value === null) return false;
            var select = panel.querySelector('.comfyui-params-form select[data-key="' + key + '"]');
            if (!select) return false;
            var ok = false;
            for (var i = 0; i < select.options.length; i++) {
                if (select.options[i].value === String(value)) { ok = true; break; }
            }
            // 值不在当前选项里（旧模板缺该选项 / 枚举差异）就不写，避免把下拉置空
            if (!ok) return false;
            select.value = String(value);
            if (currentTemplateId) {
                formCache[currentTemplateId] = formCache[currentTemplateId] || {};
                formCache[currentTemplateId][key] = select.value;
            }
            return true;
        }

        function bindParamEvents() {
            var sliders = panel.querySelectorAll('.comfyui-slider');
            sliders.forEach(function (slider) {
                on(slider, 'input', function () {
                    var numInput = panel.querySelector('.comfyui-param-number[data-key="' + slider.dataset.key + '"]');
                    if (numInput) numInput.value = slider.value;
                });
            });

            var numbers = panel.querySelectorAll('.comfyui-param-number');
            numbers.forEach(function (numInput) {
                on(numInput, 'input', function () {
                    var slider = panel.querySelector('.comfyui-slider[data-key="' + numInput.dataset.key + '"]');
                    if (slider) slider.value = numInput.value;
                });
            });

            // 自定义步进按钮 +/−
            var stepBtns = panel.querySelectorAll('.comfyui-step-btn');
            stepBtns.forEach(function (btn) {
                on(btn, 'click', function () {
                    var stepper = btn.parentElement;
                    var numInput = stepper.querySelector('.comfyui-param-number');
                    var slider = panel.querySelector('.comfyui-slider[data-key="' + numInput.dataset.key + '"]');
                    if (!numInput) return;
                    var step = parseFloat(numInput.step) || 1;
                    var min = parseFloat(numInput.min);
                    var max = parseFloat(numInput.max);
                    var val = parseFloat(numInput.value) || 0;
                    if (btn.dataset.dir === 'up') {
                        val = Math.min(isNaN(max) ? Infinity : max, val + step);
                    } else {
                        val = Math.max(isNaN(min) ? -Infinity : min, val - step);
                    }
                    // 保留精度
                    var decimals = (String(step).split('.')[1] || '').length;
                    val = parseFloat(val.toFixed(decimals));
                    numInput.value = val;
                    if (slider) slider.value = val;
                });
            });

            var dropZones = panel.querySelectorAll('.comfyui-image-drop');
            dropZones.forEach(function (zone) {
                on(zone, 'dragover', function (e) { e.preventDefault(); zone.classList.add('dragover'); });
                on(zone, 'dragleave', function () { zone.classList.remove('dragover'); });
                on(zone, 'drop', function (e) {
                    e.preventDefault();
                    zone.classList.remove('dragover');
                    var file = e.dataTransfer.files[0];
                    if (!file) return;
                    if (!fileMatchesMediaType(file, zone.dataset.mediaType)) {
                        showStatus(zone.dataset.mediaType === 'video' ? AEI18n.t('请拖入视频文件') : AEI18n.t('请拖入图片文件'));
                        return;
                    }
                    handleImageDrop(zone, file);
                });
                on(zone, 'click', function (e) {
                    if (e.target.classList.contains('comfyui-image-clear')) return;
                    if (e.target.classList.contains('comfyui-capture-btn')) return;
                    if (e.target.classList.contains('comfyui-paste-btn')) return;
                    var input = document.createElement('input');
                    input.type = 'file';
                    input.accept = zone.dataset.mediaType === 'video' ? 'video/*' : 'image/*';
                    // 临时 input 不入 listeners：元素不挂 DOM、选完即弃，监听随元素一起可回收
                    input.addEventListener('change', function (e) {
                        if (e.target.files[0]) handleImageDrop(zone, e.target.files[0]);
                    });
                    input.click();
                });
                // 预览点击放大（图片用缩放 lightbox；视频用视频 lightbox）
                var prevImg = zone.querySelector('.comfyui-image-preview');
                if (prevImg) {
                    on(prevImg, 'click', function (e) {
                        e.stopPropagation();
                        if (prevImg.tagName === 'IMG') openLightbox(prevImg.src);
                        else openLightbox(prevImg.src, true);
                    });
                }
                // X 清空按钮
                var clearBtn = zone.querySelector('.comfyui-image-clear');
                if (clearBtn) {
                    on(clearBtn, 'click', function (e) { e.stopPropagation(); clearImageDrop(zone); });
                }
                // 📋 粘贴按钮
                bindPasteButton(zone.querySelector('.comfyui-paste-btn'));
            });

            // 📷 获取AE当前帧按钮
            var captureBtns = panel.querySelectorAll('.comfyui-capture-btn');
            captureBtns.forEach(function (btn) {
                on(btn, 'click', function (e) {
                    e.stopPropagation();
                    var key = btn.dataset.key;
                    btn.textContent = '⏳';
                    btn.disabled = true;
                    ctrl.captureCurrentFrame().then(function (file) {
                        var zone = panel.querySelector('.comfyui-image-drop[data-key="' + key + '"]');
                        if (zone) handleImageDrop(zone, file);
                        showStatus(AEI18n.t('已获取AE当前帧'));
                    }).catch(function (e) {
                        showError(AEI18n.t('获取帧失败: {detail}', { detail: e.message }));
                    }).then(function () {
                        btn.textContent = '📷';
                        btn.disabled = false;
                    });
                });
            });

            // 多图参考：＋ 添加按钮
            var addImageBtns = panel.querySelectorAll('.comfyui-add-image-btn');
            addImageBtns.forEach(function (addBtn) {
                on(addBtn, 'click', function () {
                    var group = addBtn.closest('.comfyui-param-multiple');
                    if (!group) return;
                    var baseKey = group.dataset.key;
                    var maxCount = parseInt(group.dataset.maxCount) || 10;
                    var slotsContainer = group.querySelector('.comfyui-image-slots');
                    var currentCount = slotsContainer.querySelectorAll('.comfyui-image-slot').length;
                    if (currentCount >= maxCount) {
                        showStatus(AEI18n.t('最多添加 ') + maxCount + AEI18n.t(' 张参考图'));
                        return;
                    }
                    // 找 1..maxCount 里第一个没被占用的索引复用，避免反复增删后索引溢出
                    var usedIndices = {};
                    slotsContainer.querySelectorAll('.comfyui-image-slot').forEach(function (s) {
                        var m = (s.dataset.slotKey || '').match(/_(\d+)$/);
                        if (m) usedIndices[parseInt(m[1])] = true;
                    });
                    var nextIndex = 1;
                    while (usedIndices[nextIndex]) nextIndex++;
                    var key = baseKey + '_' + nextIndex;
                    var temp = document.createElement('div');
                    temp.innerHTML = buildImageSlotHtml(key, true);
                    var newSlot = temp.firstChild;
                    slotsContainer.appendChild(newSlot);
                    bindImageSlotEvents(newSlot);
                    if (currentCount + 1 >= maxCount) {
                        addBtn.style.display = 'none';
                    }
                });
            });

            // ── DynamicCombo model select 联动：切换 model 值后刷新子参数 ──
            // 仅 non-pipeline 模型且有 modelKey 时生效
            var _engine = ctrl.getEngine ? ctrl.getEngine() : null;
            if (_engine && _engine.refreshModelParams && currentTemplateId) {
                var _modelDef = _engine.getById ? _engine.getById(currentTemplateId) : null;
                var _modelKey = _modelDef ? _modelDef.modelKey : null;
                if (_modelKey && _modelDef && !_modelDef.pipeline) {
                    var _modelSel = panel.querySelector('.comfyui-params-form select[data-key="' + _modelKey + '"]');
                    if (_modelSel) {
                        var _dcRefreshToken = 0;  // 防竞态 token
                        on(_modelSel, 'change', function () {
                            var _newVal = _modelSel.value;
                            var _myToken = ++_dcRefreshToken;  // 本次刷新的 token
                            // 快照发起刷新时的模板 id——then 回调校验未变再渲染，
                            // 刷新 await 窗口内切换模板（currentTemplateId 已变）时丢弃
                            // 过期参数集，防旧模板参数覆盖新模板的表单
                            var _tplId = currentTemplateId;
                            // 先缓存当前表单值（非子参数部分）
                            collectParamValues();
                            var _dcPrefix = _modelKey + '.';
                            // 删除旧子参数的缓存值
                            var _oldCache = formCache[currentTemplateId] || {};
                            Object.keys(_oldCache).forEach(function (k) {
                                if (k.indexOf(_dcPrefix) === 0) delete _oldCache[k];
                            });
                            // 写入新 model 值到缓存
                            formCache[currentTemplateId] = formCache[currentTemplateId] || {};
                            formCache[currentTemplateId][_modelKey] = _newVal;
                            // 用新 modelValue 重新生成参数
                            _engine.refreshModelParams(_tplId, _newVal).then(function (newParams) {
                                // 竞态保护：如果期间用户又切换了 model，放弃本次结果
                                if (_myToken !== _dcRefreshToken) return;
                                // 模板已切换（B）——丢弃 A 的过期参数集
                                if (_tplId !== currentTemplateId) return;
                                // 用新参数列表全量重建表单（事件绑定走 bindParamEvents 一次完成）
                                var _oldTpl = _engine.getTemplate ? _engine.getTemplate(_tplId) : null;
                                var _newTpl = _oldTpl || { id: _tplId };
                                _newTpl.parameters = newParams;
                                renderParams(_newTpl);
                                showStatus(AEI18n.t('已切换模型版本，参数已更新'));
                            }).catch(function (e) {
                                console.warn('[ComfyUI] 子参数刷新失败:', e && e.message);
                            });
                        });
                    }
                }
            }

            // UNET 模型：切到裸扩散模型时同步步数/CFG/采样器/调度器/denoise 为该族推荐值。
            // 引擎在“值等于模板默认值”时也会用族推荐值兜底，这里让表单显示与实际一致。
            var _unetModelSel = panel.querySelector('.comfyui-params-form select[data-key="model"]');
            var _unetTpl = ctrl.getCurrentTemplate ? ctrl.getCurrentTemplate() : null;
            if (_unetModelSel && _unetTpl && _unetTpl.modelSource === 'mixed') {
                on(_unetModelSel, 'change', function () {
                    var _eng = ctrl.getEngine ? ctrl.getEngine() : null;
                    if (!_eng || typeof _eng.getUnetSamplingHints !== 'function') return;
                    var _hints = _eng.getUnetSamplingHints(_unetModelSel.value);
                    if (_hints) {
                        _setFormNumber('steps', _hints.steps);
                        _setFormNumber('cfg', _hints.cfg);
                        if (_hints.sampler) _setFormSelect('sampler', _hints.sampler);
                        if (_hints.scheduler) _setFormSelect('scheduler', _hints.scheduler);
                        if (_hints.denoise !== undefined) _setFormNumber('denoise', _hints.denoise);
                        showStatus(AEI18n.t('已切换 ') + _hints.label + AEI18n.t(' 模型：步数 ') + _hints.steps + ' / CFG ' + _hints.cfg
                            + (_hints.sampler ? AEI18n.t(' / 采样器 ') + _hints.sampler : ''));
                        return;
                    }
                    // 切回 checkpoint：步数/CFG/采样器/调度器/重绘幅度还原模板默认值
                    // （残留的族参数会让 SD 出图异常）
                    var _tplNow = ctrl.getCurrentTemplate ? ctrl.getCurrentTemplate() : null;
                    var _params = (_tplNow && _tplNow.parameters) || [];
                    for (var _pi = 0; _pi < _params.length; _pi++) {
                        var _p = _params[_pi];
                        if (!_p || _p.default === undefined) continue;
                        if (_p.key === 'steps' || _p.key === 'cfg' || _p.key === 'denoise') {
                            _setFormNumber(_p.key, _p.default);
                        } else if (_p.key === 'sampler' || _p.key === 'scheduler') {
                            _setFormSelect(_p.key, _p.default);
                        }
                    }
                });
            }
        }

        function clearImageDrop(zone) {
            if (zone._objectUrl) { URL.revokeObjectURL(zone._objectUrl); zone._objectUrl = null; }
            var preview = zone.querySelector('.comfyui-image-preview');
            var placeholder = zone.querySelector('.comfyui-image-placeholder');
            var clearBtn = zone.querySelector('.comfyui-image-clear');
            if (preview) { preview.src = ''; preview.style.display = 'none'; }
            if (placeholder) placeholder.style.display = '';
            if (clearBtn) clearBtn.style.display = 'none';
            delete zone.dataset.filename;
            zone._file = null;
        }

        function handleImageDrop(zone, file) {
            if (zone._objectUrl) { URL.revokeObjectURL(zone._objectUrl); zone._objectUrl = null; }

            var objectUrl = URL.createObjectURL(file);
            zone._objectUrl = objectUrl;

            var preview = zone.querySelector('.comfyui-image-preview');
            var placeholder = zone.querySelector('.comfyui-image-placeholder');
            var clearBtn = zone.querySelector('.comfyui-image-clear');
            if (preview) { preview.src = objectUrl; preview.style.display = 'block'; }
            if (placeholder) placeholder.style.display = 'none';
            if (clearBtn) clearBtn.style.display = 'flex';
            zone.dataset.filename = file.name;
            zone._file = file;
        }

        function collectParamValues() {
            var values = {};
            if (!panel) return values;  // unbind 后 panel=null：refreshModelList 等仍会调用
            var params = panel.querySelectorAll('.comfyui-params-form .comfyui-param');
            params.forEach(function (param) {
                var key = param.dataset.key;
                var textarea = param.querySelector('textarea[data-key="' + key + '"]');
                var textInput = param.querySelector('input[type="text"][data-key="' + key + '"]');
                var slider = param.querySelector('.comfyui-slider[data-key="' + key + '"]');
                var number = param.querySelector('.comfyui-param-number[data-key="' + key + '"]');
                var checkbox = param.querySelector('.switch-input[data-key="' + key + '"]');
                var select = param.querySelector('select[data-key="' + key + '"]');
                var dropZone = param.querySelector('.comfyui-image-drop[data-key="' + key + '"]');

                if (textarea) values[key] = textarea.value;
                else if (textInput) values[key] = textInput.value;
                else if (slider) values[key] = parseFloat(slider.value);
                else if (number) values[key] = parseFloat(number.value);
                else if (checkbox) values[key] = checkbox.checked;
                else if (select) values[key] = select.value;
                else if (param.dataset.multiple === 'true') {
                    // 多图参考：收集所有 slot 的值
                    var dropZones = param.querySelectorAll('.comfyui-image-drop');
                    dropZones.forEach(function (dz) {
                        if (dz.dataset.key && (dz.dataset.filename || dz._file)) {
                            values[dz.dataset.key] = dz._file || dz.dataset.filename;
                        }
                    });
                } else if (dropZone && dropZone.dataset.filename) values[key] = dropZone._file || dropZone.dataset.filename;
            });

            // 缓存文本/数字/选择值（image 的 File 对象不缓存）
            var cacheEntry = {};
            Object.keys(values).forEach(function (k) {
                if (!(values[k] instanceof File)) cacheEntry[k] = values[k];
            });
            if (currentTemplateId) formCache[currentTemplateId] = cacheEntry;

            return values;
        }

        function updateProgress(data) {
            // 记录正在执行的 form 任务（取消当前批次的 interrupt 目标，见 cancelFormBatch）。
            // 放在 panel 守卫之前：切模块（panel=null）后事件仍会到达，取消链路不该丢目标
            if (data && data.prompt_id) _runningFormPromptId = data.prompt_id;
            if (!panel) return;  // unbind 后 panel=null，切模块时 WebSocket 进度仍会到达
            var progressCard = panel.querySelector('.comfyui-generating');
            if (!progressCard) return;
            var progressBar = progressCard.querySelector('.comfyui-progress-bar');
            var progressText = progressCard.querySelector('.comfyui-progress-text');
            if (progressBar && data.max) {
                var pct = Math.round((data.value / data.max) * 100);
                progressBar.style.width = pct + '%';
            }
            if (progressText && data.max) {
                progressText.textContent = data.value + ' / ' + data.max + AEI18n.t(' 步');
            }
        }

        function updateExecuting(data) {
            // 同 updateProgress：记录正在执行的 form 任务（executing 事件同样带 prompt_id）
            if (data && data.prompt_id) _runningFormPromptId = data.prompt_id;
            if (!panel) return;  // unbind 后 panel=null，切模块时 WebSocket 进度仍会到达
            var progressCard = panel.querySelector('.comfyui-generating');
            if (!progressCard) return;
            var nodeText = progressCard.querySelector('.comfyui-executing-node');
            if (nodeText) nodeText.textContent = data.node ? AEI18n.t('执行节点: ') + data.node : '';
        }

        // 取消当前批次表单生成（进度卡取消按钮与顶栏取消共用）。
        // ComfyUI 的 /interrupt 只停"正在跑"的那张，排队中的任务必须走 /queue delete——
        // 只调 interrupt（且多打在"最后一次提交"的排队末尾上）时，排队任务继续执行、
        // 云端继续扣费。语义唯一：对当前批次全部 pending promptId 依次 clearQueue(pid)，
        // 再对正在跑的那张 interrupt(pid)。pending 清单复用 controller.getFormPromptIds()
        // （form 来源在途任务，既有 helper，不新造批状态）；正在跑的 pid 取 WS
        // progress/executing 事件记录，事件未到（如刚提交）时按提交顺序取首个 form 任务兜底。
        // 回执如实：两个调用若被 .catch(function(){}) 吞空、再无条件
        // showStatus('已取消…','success')——ComfyUI 老版本无该 API、HTTP 超时或 5xx 时
        // 用户看到绿色"已取消"，服务端仍在排队执行/扣费。现在收集全部请求结果（成败逐项），
        // 全部成功才用原成功文案；部分/全部失败报失败数并给客观检查指引。不新增 UI 组件。
        function _settleCancelCall(fn) {
            // 单次取消请求 → 布尔（成功 true）。同步抛错同样计入失败；
            // 不用 Promise.allSettled 是为兼容旧 mock/注入的非 Promise 返回值（语义等价）。
            try {
                return Promise.resolve(fn()).then(function () { return true; }, function () { return false; });
            } catch (_) {
                return Promise.resolve(false);
            }
        }
        // 进度卡收尾统一入口（完成/表单错误/取消成功共用同一 DOM 路径）。
        // 成功取消后不会再有完成/错误事件到达表单进度卡（来源已转 form-stale，进度事件
        // 不再投递），只给绿色回执不摘卡片时，「准备中… + 取消剩余」可永久停留。
        function removeProgressCard() {
            if (!panel) return;
            var resultsPanel = panel.querySelector('.comfyui-results');
            if (!resultsPanel) return;
            var progressCard = resultsPanel.querySelector('.comfyui-generating');
            if (progressCard) progressCard.remove();
        }
        function cancelFormBatch() {
            var svc = ctrl.getService();
            if (!svc) return;
            var formIds = (typeof ctrl.getFormPromptIds === 'function') ? ctrl.getFormPromptIds() : [];
            // ②：'form-stale'（错误终态/超时/上次取消后仍在 ComfyUI 队列里跑的任务）
            // 一并纳入取消目标。只收 'form' 时：一张 execution_error 后同批剩余任务全变
            // stale，进度卡被移除、再点取消只得到「当前没有本批生成任务可取消」——可能仍在
            // 计费的排队/在执行任务从此不可取消。stale 语义不变（迟到完成仅下载/展示、不改计数）。
            var staleIds = (typeof ctrl.getStaleFormPromptIds === 'function') ? ctrl.getStaleFormPromptIds() : [];
            var targets = formIds.concat(staleIds.filter(function (pid) { return formIds.indexOf(pid) < 0; }));
            // ①：发取消请求之前同步置 controller 级取消意图 + 本地 settle——
            // 提交循环立即停止后续提交（在途 submit 返回后不再登记新的 form 任务，否则新任务
            // 不在本函数点击瞬间的 targets 快照里，clearQueue/interrupt 打不到）；本地解锁/
            // form-stale 收尾也不再依赖取消 HTTP 往返。请求成败只决定下方回执文案。
            if (typeof ctrl.requestFormBatchCancel === 'function') ctrl.requestFormBatchCancel();
            var calls = [];
            function _issue(method, pid) {
                if (typeof svc[method] !== 'function') return;
                calls.push(_settleCancelCall(function () { return svc[method](pid); }));
            }
            if (!targets.length) {
                // 无当前批次在途任务时不再发无参 interrupt——service.interrupt 未传
                // promptId 会回落 currentPromptId，而 clearQueue 成功时已把它置 null，最终
                // 发出空 body 的 /interrupt（全局中断），可能打断此后新提交的画布/LLM 任务。
                // 没有可取消对象就零请求，并如实回报。
                showStatus(AEI18n.t('当前没有本批生成任务可取消'), 'info');
                return Promise.resolve();
            }
            targets.forEach(function (pid) { _issue('clearQueue', pid); });
            var runningPid = (_runningFormPromptId && targets.indexOf(_runningFormPromptId) >= 0)
                ? _runningFormPromptId
                : targets[0];
            _issue('interrupt', runningPid);
            if (!calls.length) {
                showStatus(AEI18n.t('取消请求发送失败：取消接口不可用，服务端任务可能仍在运行；')
                    + AEI18n.t('请到 ComfyUI 网页端检查队列/重启服务后重试'), 'error');
                return Promise.resolve();
            }
            return Promise.all(calls).then(function (marks) {
                var failed = 0;
                for (var i = 0; i < marks.length; i++) if (!marks[i]) failed++;
                // 取消至少部分生效（非全部请求失败）→ 收尾进度卡。本地解锁/
                // form-stale 已在点击处由 requestFormBatchCancel 同步完成（①），
                // 此处保留幂等调用以兼容未实现新入口的旧 controller 桩；全部请求失败时
                // 本地已按 stale 收尾（服务端任务可能仍在跑但不再改计数，且可再次取消——
                // stale 已入 targets），回执仍如实报失败数。
                if (failed < calls.length && typeof ctrl.settleFormBatchCancel === 'function') {
                    ctrl.settleFormBatchCancel();
                    // 与 settle 同条件收尾进度卡——此后不会再有完成/错误事件
                    // 到达当前批次（来源已 stale、进度不再投递），不收尾卡片永久停留
                    removeProgressCard();
                }
                if (failed === 0) {
                    showStatus(AEI18n.t('已取消本批任务（') + targets.length + AEI18n.t(' 张）'), 'success');
                    return;
                }
                showStatus(AEI18n.t('取消未完全成功：') + failed + '/' + calls.length
                    + AEI18n.t(' 项取消请求失败，服务端可能仍在排队或执行；请到 ComfyUI 网页端检查队列/重启服务后重试'), 'error');
            });
        }

        function updateConnectionStatus(connected, info) {
            if (!panel) return;  // unbind 后 panel=null，connect/testConnection 回调仍会到达
            var indicator = panel.querySelector('.comfyui-status-indicator');
            var statusText = panel.querySelector('.comfyui-status-text');
            if (indicator) {
                indicator.className = 'comfyui-status-indicator ' + (connected ? 'connected' : 'disconnected');
            }
            if (statusText) {
                statusText.textContent = connected ? AEI18n.t('已连接') : AEI18n.t('未连接');
            }
        }

        // promptId 参数保留为 API 形状（调用方仍传本次提交结果）；取消语义为
        // 「当前批次」，取消目标由 cancelFormBatch 用 getFormPromptIds() + WS 执行事件推导
        function showGenerating(promptId) {
            if (!panel) return;  // unbind 后 panel=null（LLM 工具与 UI 共享 controller，仍可触发生成）
            var resultsPanel = panel.querySelector('.comfyui-results');
            if (!resultsPanel) return;
            // Remove old progress card if any
            var oldProgress = resultsPanel.querySelector('.comfyui-generating');
            if (oldProgress) oldProgress.remove();

            // Find or create the grid
            var grid = resultsPanel.querySelector('.comfyui-results-grid');
            if (!grid) {
                resultsPanel.innerHTML = '';
                grid = document.createElement('div');
                grid.className = 'comfyui-results-grid';
                resultsPanel.appendChild(grid);
            }

            // 创建进度卡片，插入到网格最前面
            var progressCard = document.createElement('div');
            progressCard.className = 'comfyui-result-card comfyui-generating';
            progressCard.innerHTML =
                '<div class="comfyui-result-preview comfyui-progress-preview">' +
                    '<div class="comfyui-progress-inner">' +
                        '<div class="comfyui-progress-container"><div class="comfyui-progress-bar"></div></div>' +
                        AEI18n.html('<div class="comfyui-progress-text">准备中...</div>') +
                        '<div class="comfyui-executing-node"></div>' +
                        AEI18n.html('<button class="btn btn-slice danger-btn comfyui-cancel-btn">取消剩余</button>') +
                    '</div>' +
                '</div>';
            grid.insertBefore(progressCard, grid.firstChild);

            var cancelBtn = progressCard.querySelector('.comfyui-cancel-btn');
            // 卡片随生成结束移除，不入 listeners（监听随卡片元素回收，避免每次生成累积一条）
            // 取消按钮只对当前批次 form 任务生效（并发生成时全局 currentPromptId 是
            // "最后一次提交"，会打错对象）；语义 = 取消当前批次剩余（排队项 clearQueue +
            // 正在跑的那张 interrupt，见 cancelFormBatch）。返回值透出，回执在请求
            // 结果落定后按成/败给出
            if (cancelBtn) cancelBtn.addEventListener('click', function () { return cancelFormBatch(); });
        }

        function buildResultCardHtml(r, gIdx, multi) {
            var safeName = escapeHtml(r.filename);
            var safeType = escapeHtml(r.outputType || '');
            var safeUrl = escapeHtml(r.url);
            var isVideo = /\.(mp4|webm|gif)$/i.test(r.filename);
            var isAudio = /\.(wav|mp3|ogg|flac|m4a)$/i.test(r.filename);
            var html = '<div class="comfyui-result-card" data-global-index="' + gIdx + '">';
            if (isVideo && /\.gif$/i.test(r.filename)) {
                html += '<img class="comfyui-result-preview" src="' + safeUrl + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">';
                html += '<div class="comfyui-result-preview comfyui-audio-placeholder" style="display:none">🎞 ' + safeName + '</div>';
            } else if (isVideo) {
                html += '<video class="comfyui-result-preview" src="' + safeUrl + '" muted loop playsinline onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'"></video>';
                html += '<div class="comfyui-result-preview comfyui-audio-placeholder" style="display:none">🎬 ' + safeName + '</div>';
            } else if (isAudio) {
                html += '<div class="comfyui-result-preview comfyui-audio-placeholder">♪ ' + (safeType || 'audio') + '</div>';
            } else {
                html += '<img class="comfyui-result-preview" src="' + safeUrl + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">';
                html += '<div class="comfyui-result-preview comfyui-audio-placeholder" style="display:none">🖼 ' + safeName + '</div>';
            }
            html += '<div class="comfyui-result-info">';
            if (r.outputType && multi) {
                html += '<span class="comfyui-result-type">' + safeType + '</span>';
            }
            html += '<span class="comfyui-result-filename">' + safeName + '</span>';
            html += '</div>';
            html += '<div class="comfyui-result-actions">';
            html += '<button class="btn btn-slice comfyui-import-btn" data-global-index="' + gIdx + '">' + AEI18n.t('导入') + '</button>';
            html += '<button class="btn btn-slice danger-btn comfyui-delete-btn" data-global-index="' + gIdx + '" title="' + AEI18n.t('移除') + '">✕</button>';
            html += '</div>';
            html += '</div>';
            return html;
        }

        // 卡片绑定结果对象引用（card._comfyResult）——删除定位与删除后的
        // 索引重排均按 ctrl.getResults() 数组的 indexOf 回映射，不再按 DOM 顺序重编。
        // 背景：新批次结果卡 DOM 落网格最前（进度卡 insertBefore firstChild）、数组
        // 索引在尾部（currentResults.concat），DOM 顺序 ≠ 数组顺序；删除后若按
        // DOM 顺序把 dataset.globalIndex 重编为 0..N-1，与 splice 后的数组顺序错位，
        // 剩余卡片的导入/删除按钮会操作错误的数据。result 由 showResults 构建时传入
        // （与 controller concat 进 currentResults 的是同一批对象引用）。
        function bindCardEvents(card, result) {
            var grid = card.parentElement;
            card._comfyResult = result;

            // 点击预览图放大查看
            var preview = card.querySelector('.comfyui-result-preview');
            if (preview && preview.tagName === 'IMG') {
                on(preview, 'click', function (e) {
                    e.stopPropagation();
                    openLightbox(preview.src);
                });
            }

            var importBtn = card.querySelector('.comfyui-import-btn');
            if (importBtn) on(importBtn, 'click', function () {
                // 导入与删除对称——优先按结果对象引用定位（重排中引用
                // 失配的卡被跳过、其 dataset 停留陈旧值，按 dataset 取会拿到错误
                // 数据），引用在数组中命中才使用；失配回退 dataset（兼容旧卡场景）
                var results = ctrl.getResults();
                var result = null;
                if (card._comfyResult && results.indexOf(card._comfyResult) >= 0) {
                    result = card._comfyResult;
                } else {
                    result = results[parseInt(card.dataset.globalIndex)];
                }
                if (result) {
                    ctrl.importToAE(result).then(function (res) {
                        showStatus(AEI18n.t('导入成功: ') + (res.itemName || ''));
                    }).catch(function (e) {
                        showError(AEI18n.t('导入失败: {detail}', { detail: e.message }));
                    });
                }
            });

            var deleteBtn = card.querySelector('.comfyui-delete-btn');
            if (deleteBtn) on(deleteBtn, 'click', function () {
                // 优先按结果对象引用定位数组索引（与 splice 后数组精确对齐）；
                // 引用失配（重挂载旧卡等场景）回退 dataset.globalIndex，controller 侧
                // removeResult 自带边界校验
                var idx = ctrl.getResults().indexOf(card._comfyResult);
                if (idx < 0) idx = parseInt(card.dataset.globalIndex);
                ctrl.removeResult(idx);
                // 移除前解绑本卡片的监听（预览点击/导入/删除/视频 hover），detached
                // 元素不再被 listeners 数组连同闭包持有直至 unbind
                offWithin(card);
                card.remove();
                if (grid) {
                    var remaining = grid.querySelectorAll('.comfyui-result-card[data-global-index]');
                    // 重排按 ctrl.getResults() 数组顺序回映射——每张卡用其
                    // 绑定的结果引用 indexOf 重算索引（数组顺序即真值），不得按 DOM
                    // 顺序重编（新批次卡 DOM 在最前、数组索引在尾部，两序错位）
                    remaining.forEach(function (c) {
                        var newIdx = ctrl.getResults().indexOf(c._comfyResult);
                        if (newIdx < 0) return;
                        c.dataset.globalIndex = newIdx;
                        var btns = c.querySelectorAll('[data-global-index]');
                        btns.forEach(function (b) { b.dataset.globalIndex = newIdx; });
                    });
                }
            });

            var video = card.querySelector('video.comfyui-result-preview');
            if (video) {
                on(card, 'mouseenter', function () { video.play().catch(function () {}); });
                on(card, 'mouseleave', function () { video.pause(); });
            }
        }

        // batchRemaining（可选）= 批量生成还剩几张未完成。>0 时进度卡不随当前批次
        // 结果移除（首个结果到达即移除会让剩余 N-1 张无任何进度反馈，看起来像卡死），
        // 结果全部追加到网格、进度卡置顶保留；最后一张（=0）才走"替换进度卡"收尾。
        function showResults(newResults, batchRemaining) {
            if (!panel) return;  // unbind 后 panel=null
            var resultsPanel = panel.querySelector('.comfyui-results');
            if (!resultsPanel) return;

            var allResults = ctrl.getResults();
            var globalStart = allResults.length - newResults.length;
            var multi = newResults.length > 1;

            var grid = resultsPanel.querySelector('.comfyui-results-grid');
            if (!grid) {
                resultsPanel.innerHTML = '';
                grid = document.createElement('div');
                grid.className = 'comfyui-results-grid';
                resultsPanel.appendChild(grid);
            }

            // 用第一个结果替换进度卡片
            var progressCard = resultsPanel.querySelector('.comfyui-generating');
            if (!newResults || newResults.length === 0) {
                if (progressCard) progressCard.remove();
                return;
            }
            if (progressCard && !(batchRemaining > 0)) {
                var firstResult = newResults[0];
                var firstIdx = globalStart;
                var temp = document.createElement('div');
                temp.innerHTML = buildResultCardHtml(firstResult, firstIdx, multi);
                var firstCard = temp.firstChild;
                progressCard.replaceWith(firstCard);
                bindCardEvents(firstCard, firstResult);
                // 剩余结果追加到网格
                for (var i = 1; i < newResults.length; i++) {
                    var gIdx = globalStart + i;
                    var t = document.createElement('div');
                    t.innerHTML = buildResultCardHtml(newResults[i], gIdx, multi);
                    var card = t.firstChild;
                    grid.appendChild(card);
                    bindCardEvents(card, newResults[i]);
                }
            } else {
                // 没有进度卡片（或批量进行中保留进度卡）：直接追加所有结果
                for (var j = 0; j < newResults.length; j++) {
                    var gIdx2 = globalStart + j;
                    var t2 = document.createElement('div');
                    t2.innerHTML = buildResultCardHtml(newResults[j], gIdx2, multi);
                    var card2 = t2.firstChild;
                    grid.appendChild(card2);
                    bindCardEvents(card2, newResults[j]);
                }
            }
        }

        // source 标记错误来源（'form' | 'canvas' | 'llm'）。只有表单自身的
        // 失败终态才移除进度卡片——LLM/画布来源的错误事件与表单生成无关（画布侧
        // 自有错误呈现），无条件移除会误伤正在批量生成的表单进度卡（进度仍在走
        // 但卡片消失）。不传 source 的调用（提示/操作失败类）同样不动进度卡。
        function showError(message, source) {
            if (!panel) return;  // unbind 后 panel=null
            var resultsPanel = panel.querySelector('.comfyui-results');
            if (!resultsPanel) return;
            // 移除进度卡片（仅表单来源错误；走统一收尾入口）
            if (source === 'form') removeProgressCard();
            // 在网格上方插入错误信息，不破坏已有结果
            var errorDiv = document.createElement('div');
            errorDiv.className = 'comfyui-error';
            errorDiv.textContent = message;
            var grid = resultsPanel.querySelector('.comfyui-results-grid');
            if (grid) {
                resultsPanel.insertBefore(errorDiv, grid);
            } else {
                resultsPanel.appendChild(errorDiv);
            }
            // 3秒后自动移除错误信息
            setTimeout(function () { if (errorDiv.parentNode) errorDiv.remove(); }, 5000);
        }

        // 工作流链路的用户可见提示入口（controller 调用）：面板已 bind → 显示并返回 true；
        // 未 bind → 返回 false，提示留在 controller 队列里等 bind 后补发（不静默丢失）
        function showWorkflowNotice(level, message) {
            if (!panel) return false;
            if (level === 'error') showError(message);
            else showStatus(message);
            return true;
        }

        // source 标记错误来源（'form' | 'canvas' | 'llm'，对齐 showError 的
        // 来源路由）——generateRaw 提交失败（画布任务）无条件移除唯一的表单进度卡时，
        // 表单批量生成中画布提交失败会误伤其进度反馈。只有表单自身的提交失败（source==='form'）
        // 才移除进度卡；不传 source 的调用维持原行为（兼容）。
        function showNodeErrors(errorData, source) {
            if (!panel) return;  // unbind 后 panel=null，LLM 工具提交失败时仍会调用
            var msg = '节点错误:';
            var hasDetails = false;

            if (errorData.node_errors && typeof errorData.node_errors === 'object') {
                var nodeIds = Object.keys(errorData.node_errors);
                if (nodeIds.length > 0) {
                    nodeIds.forEach(function (nodeId) {
                        var err = errorData.node_errors[nodeId];
                        if (err && err.errors && Array.isArray(err.errors)) {
                            var messages = err.errors.map(function (e) {
                                return (e.details ? e.details + ': ' : '') + (e.message || JSON.stringify(e));
                            }).join(', ');
                            msg += '\n节点 ' + nodeId + ': ' + messages;
                            hasDetails = true;
                        } else if (err && err.message) {
                            msg += '\n节点 ' + nodeId + ': ' + err.message;
                            hasDetails = true;
                        } else if (typeof err === 'string') {
                            msg += '\n节点 ' + nodeId + ': ' + err;
                            hasDetails = true;
                        } else {
                            msg += '\n节点 ' + nodeId + ': ' + JSON.stringify(err);
                            hasDetails = true;
                        }
                    });
                }
            }

            // 如果没有结构化的 node_errors，尝试提取其他错误信息
            if (!hasDetails) {
                if (errorData.error) {
                    if (typeof errorData.error === 'string') {
                        msg += '\n' + errorData.error;
                    } else if (errorData.error.message) {
                        msg += '\n' + errorData.error.message;
                    } else {
                        msg += '\n' + JSON.stringify(errorData.error);
                    }
                    hasDetails = true;
                } else if (errorData.message) {
                    msg += '\n' + errorData.message;
                    hasDetails = true;
                } else if (errorData.details) {
                    msg += '\n' + errorData.details;
                    hasDetails = true;
                }
            }

            // 针对常见错误提供额外提示
            var fullMsg = msg;
            if (/no outputs/i.test(fullMsg)) {
                fullMsg += '\n\n💡 提示：工作流缺少输出节点。云端工作流（如 GPT Image）需要 ComfyUI 安装对应的自定义节点。\n请确认 ComfyUI 已安装该节点类型，或使用本地模板（如"文生图"）。';
            }

            // 如果仍然没有详细信息，显示原始错误数据
            if (!hasDetails) {
                try {
                    fullMsg += '\n' + JSON.stringify(errorData, null, 2);
                } catch (e) {
                    fullMsg += '\n(无法解析错误详情)';
                }
            }

            var resultsPanel = panel.querySelector('.comfyui-results');
            if (!resultsPanel) return;
            // 仅表单来源的提交失败移除进度卡（对齐 showError 的来源路由）——
            // 画布/LLM 任务的 generateRaw 提交失败与表单生成无关，无条件移除会误伤
            // 正在批量生成的表单进度卡。走统一收尾入口。
            if (source === 'form') removeProgressCard();
            var errorDiv = document.createElement('div');
            errorDiv.className = 'comfyui-error';
            errorDiv.textContent = fullMsg;
            var grid = resultsPanel.querySelector('.comfyui-results-grid');
            if (grid) {
                resultsPanel.insertBefore(errorDiv, grid);
            } else {
                resultsPanel.appendChild(errorDiv);
            }
            setTimeout(function () { if (errorDiv.parentNode) errorDiv.remove(); }, 8000);
        }

        // 提示走 AEShared.createStatusFacade()（内部转发全局 AEToast）。
        var _statusFacade = null;
        function showStatus(message, type) {
            if (!_statusFacade && global.AEShared && typeof global.AEShared.createStatusFacade === 'function') {
                _statusFacade = global.AEShared.createStatusFacade();
            }
            if (_statusFacade) {
                _statusFacade.show(message, type);
            }
        }

        var COMFYUI_SETTINGS_CONTAINER = 'comfyuiSettingsContainer';

        // ─────────────────────────────────────────────────────────────────────
        // 官方模板库浏览 modal（搜索官方库 → 选中拉取转换注册）
        // 由共享模块 AEComfyUI.officialTemplateModal 渲染：表单视图与画布共用一份实现，
        // 本文件只透传 controller 与提示通道；关闭由模块自身与卸载钩子负责。
        // ─────────────────────────────────────────────────────────────────────
        function showOfficialTemplatesModal() {
            if (!global.AEComfyUI || !global.AEComfyUI.officialTemplateModal) return;
            global.AEComfyUI.officialTemplateModal.open({ controller: ctrl, status: showStatus });
        }


        function closeComfyuiSettings() {
            // 移除 ComfyUI 注入的设置容器
            var container = document.getElementById(COMFYUI_SETTINGS_CONTAINER);
            if (container && container.parentNode) container.parentNode.removeChild(container);

            // 关闭弹窗
            var mask = document.getElementById('settingsModal');
            if (mask) {
                var modal = mask.querySelector('.modal');
                if (modal) {
                    modal.style.opacity = '0';
                    modal.style.transform = 'translateY(10px) scale(.98)';
                }
                mask.style.opacity = '0';
                // 代际守卫——关闭递增代数，定时器回调校验代数未变才隐藏
                // （关闭后 220ms 内重开由 showSettingsModal 递增代数使本定时器失效）
                var _closeGen = ++_settingsMaskGen;
                setTimeout(function () {
                    if (_settingsMaskGen !== _closeGen) return;
                    mask.style.display = 'none';
                }, 220);
            }
        }

        async function showSettingsModal() {
            var settings = await ctrl.getSettings();
            var allTemplates = ctrl.getEngine() ? ctrl.getEngine().getAllTemplates() : [];
            // defaultTemplate 只在 controller._initOnce 消费（→ currentTemplate），
            // saveSettings 不热应用——保存后本次会话完全不变。记录打开弹窗时的值，
            // 保存时若变化则提示「重开面板后生效」。
            var _origDefaultTemplate = settings.defaultTemplate || 'txt2img';

            // 移除其他模块的设置容器（互斥）
            ['llmSettingsContainer', COMFYUI_SETTINGS_CONTAINER, 'mcpSettingsContainer', 'skillSettingsContainer'].forEach(function (id) {
                var c = document.getElementById(id);
                if (c && c.parentNode) c.parentNode.removeChild(c);
            });

            // 构建 ComfyUI 专用设置 HTML（分组网格排版，视觉语言对齐 Agent 模块设置）
            var tplOptions = allTemplates.map(function (t) {
                return '<option value="' + escapeHtml(t.id) + '"' + (t.id === (settings.defaultTemplate || 'txt2img') ? ' selected' : '') + '>' + escapeHtml(AEI18n.t(t.name)) + (t.cloud ? ' ☁' : '') + '</option>';
            }).join('');
            var html = '<div id="' + COMFYUI_SETTINGS_CONTAINER + '" class="st-panel">';
            // 分组：服务器连接（地址/端口并排，API Key 跨双列）
            html += AEI18n.html('<div class="st-section"><div class="st-section-title">服务器连接</div><div class="st-grid">');
            html += AEI18n.html('<div class="st-field"><label for="comfyuiHost">服务器地址</label><input type="text" id="comfyuiHost" placeholder="127.0.0.1" value="') + escapeHtml(settings.host || '127.0.0.1') + '"></div>';
            html += AEI18n.html('<div class="st-field"><label for="comfyuiPort">端口</label><input type="number" id="comfyuiPort" min="1" max="65535" placeholder="8188" value="') + (settings.port || 8188) + '"></div>';
            // placeholder 单独查词典：value 要拼运行时值，整段 <input> 不是完整标签，
            // html() 只解析完整标签内的属性，截断串里的 placeholder 不会进词典。
            html += AEI18n.html('<div class="st-field st-field-wide"><label for="comfyuiApiKey">Comfy API Key</label><input type="password" id="comfyuiApiKey" placeholder="' + escapeHtml(AEI18n.t('用于 Partner Node 鉴权，留空则使用 ComfyUI 桌面端登录')) + '" value="') + escapeHtml(settings.apiKey || '') + '"></div>';
            html += '</div></div>';
            // 分组：生成输出
            html += AEI18n.html('<div class="st-section"><div class="st-section-title">生成输出</div><div class="st-grid">');
            html += AEI18n.html('<div class="st-field"><label for="comfyuiOutputDir">输出子文件夹</label><input type="text" id="comfyuiOutputDir" placeholder="_comfyui_output" value="') + escapeHtml(settings.outputSubfolder || '_comfyui_output') + '"></div>';
            html += AEI18n.html('<div class="st-field"><label for="comfyuiDefaultTemplate">默认模板</label><select id="comfyuiDefaultTemplate">') + tplOptions + '</select></div>';
            html += '</div></div>';
            // 单字段项不设分组标题与分割线（字段 label 已自说明），直接作为面板子元素。
            // 工作流目录固定为数据根下 comfyui\workflows（不再可配，见 controller.resolveWorkflowDir）：
            // 只读展示告诉用户文件该放哪；.json 放进去即自动加载（API 或 UI 格式均可）。
            var _wfDir = '';
            try { _wfDir = ctrl.resolveWorkflowDir ? ctrl.resolveWorkflowDir() : ''; } catch (_e) {}
            html += AEI18n.html('<div class="st-field"><label for="comfyuiWorkflowDir">工作流目录</label>');
            html += '<input type="text" id="comfyuiWorkflowDir" readonly value="' + escapeHtml(_wfDir || AEI18n.t('（数据目录未就绪）')) + '">';
            html += AEI18n.html('<div class="st-field-hint">把工作流 .json 放进该目录即可自动加载（API 或 UI 格式均可；UI 格式需连接 ComfyUI 后转换）</div></div>');
            html += AEI18n.html('<div class="btn-row"><button class="btn" id="comfyuiSaveSettingsBtn">保存模块设置</button>');
            html += AEI18n.html('<button class="btn secondary" id="comfyuiAboutModuleBtn">关于模块</button></div>');
            html += '</div>';

            // 注入到 modal-body
            var modalBody = document.querySelector('#settingsModal .modal-body');
            if (modalBody) {
                modalBody.innerHTML = html;
            }

            // 绑定关于按钮
            var aboutBtn = document.getElementById('comfyuiAboutModuleBtn');
            if (aboutBtn) aboutBtn.addEventListener('click', function () {
                showAboutModal('module', { name: 'ComfyUI', desc: AEI18n.t('AE 内调用 ComfyUI 进行 AI 图像/视频生成') });
            });

            // 绑定保存按钮
            var comfyuiSaveBtn = document.getElementById('comfyuiSaveSettingsBtn');
            if (comfyuiSaveBtn) {
                comfyuiSaveBtn.addEventListener('click', function () {
                    var container = document.getElementById(COMFYUI_SETTINGS_CONTAINER);
                    if (!container) return;
                    var newSettings = {
                        host: (container.querySelector('#comfyuiHost') || {}).value || '127.0.0.1',
                        port: parseInt((container.querySelector('#comfyuiPort') || {}).value) || 8188,
                        outputSubfolder: (container.querySelector('#comfyuiOutputDir') || {}).value || '_comfyui_output',
                        apiKey: (container.querySelector('#comfyuiApiKey') || {}).value || '',
                        defaultTemplate: (container.querySelector('#comfyuiDefaultTemplate') || {}).value || 'txt2img'
                    };
                    // 默认模板保存后本次会话不生效（仅在 _initOnce 消费）——回执明示
                    // 生效时机，不再让用户以为改完即用。host/port/apiKey/outputSubfolder
                    // 仍即时生效，文案保持原样。工作流目录已固定（只读展示，不参与保存）。
                    var _deferredKeys = [];
                    if (newSettings.defaultTemplate !== _origDefaultTemplate) _deferredKeys.push('默认模板');
                    if (newSettings.defaultTemplate !== _origDefaultTemplate) _deferredKeys.push('默认模板');
                    ctrl.saveSettings(newSettings).then(function () {
                        if (_deferredKeys.length) {
                            showStatus(AEI18n.t('模块设置已保存（') + _deferredKeys.join('/') + AEI18n.t('将在重开面板后生效）'), 'success');
                        } else {
                            showStatus(AEI18n.t('模块设置已保存'), 'success');
                        }
                        closeComfyuiSettings();
                    }).catch(function (e) {
                        showStatus(AEI18n.t('保存失败: ') + (e && e.message ? e.message : e), 'error');
                    });
                });
            }

            // 关闭按钮已在 bind() 中绑定，无需重复添加（避免 listener 叠加）

            // 打开弹窗
            var mask = document.getElementById('settingsModal');
            if (mask) {
                // ×按钮是双 handler：main.js closeModal 的 220ms 隐藏定时器与 view 的定时器
                // 同时在途。 只作废了本模块代数；重开还须走 openModal 递增 main 侧
                // _modalGen 作废 main 那条定时器（对齐 assets/index.js 的打开方式），否则
                // 220ms 内重开的弹窗仍会被迟到的 closeModal 定时器藏掉
                _settingsMaskGen++;
                if (typeof global.openModal === 'function') {
                    global.openModal('settingsModal');
                } else {
                    mask.style.display = 'flex';
                    requestAnimationFrame(function () {
                        mask.style.opacity = '1';
                        var modal = mask.querySelector('.modal');
                        if (modal) {
                            modal.style.opacity = '1';
                            modal.style.transform = 'translateY(0) scale(1)';
                        }
                    });
                }
            }
        }

        async function toggleIframe() {
            var settings = await ctrl.getSettings();
            var url = 'http://' + settings.host + ':' + settings.port;

            // Test connection first
            try {
                await ctrl.testConnection();
            } catch (e) {
                showError(AEI18n.t('无法连接到 ComfyUI\n{detail}\n\n请确认：\n1. ComfyUI 已启动\n2. 地址和端口正确（当前: {url}）\n3. 已启用 CORS（--enable-cors-header）', { detail: e.message || '', url: url }));
                return;
            }

            // Open in system browser — 多级 fallback 确保至少一种方式生效
            var _opened = false;
            // 1. cep.util.openURLInDefaultBrowser（CEP 原生，最可靠）
            try {
                if (window.cep && window.cep.util && typeof window.cep.util.openURLInDefaultBrowser === 'function') {
                    window.cep.util.openURLInDefaultBrowser(url);
                    _opened = true;
                }
            } catch (e1) { /* 继续尝试下一种方式 */ }
            // 2. CSInterface.openURLInDefaultBrowser
            if (!_opened) {
                try {
                    if (typeof CSInterface !== 'undefined' && window.__adobe_cep__) {
                        new CSInterface().openURLInDefaultBrowser(url);
                        _opened = true;
                    }
                } catch (e2) { /* 继续尝试下一种方式 */ }
            }
            // 3. window.open（浏览器环境 fallback）
            if (!_opened) {
                try {
                    var _win = window.open(url, '_blank');
                    if (_win) _opened = true;
                } catch (e3) { /* 所有方式都失败 */ }
            }
            if (_opened) {
                showStatus(AEI18n.t('已在浏览器中打开 ComfyUI'));
            } else {
                showError(AEI18n.t('无法自动打开浏览器，请手动访问: {url}', { url: url }));
            }
        }

        return {
            bind: bind,
            unbind: unbind,
            renderParams: renderParams,
            collectParamValues: collectParamValues,
            updateProgress: updateProgress,
            updateExecuting: updateExecuting,
            updateConnectionStatus: updateConnectionStatus,
            showResults: showResults,
            showGenerating: showGenerating,
            showError: showError,
            showNodeErrors: showNodeErrors,
            showStatus: showStatus,
            showWorkflowNotice: showWorkflowNotice,
            showSettings: showSettingsModal
        };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createComfyUIView = createComfyUIView;
})(window);
