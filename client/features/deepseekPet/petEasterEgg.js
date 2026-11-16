// petEasterEgg.js — 彩蛋触发逻辑（检查全局设置 dataDir 输入框中的"大肥鱼"）
(function (global) {
    'use strict';

    var TRIGGER_WORD = '大肥鱼';
    var _originalDataDir = '';
    var _onTriggered = null;

    function createEasterEgg() {
        var _retryTimer = null;  // _hookSettingsSave 的重试 setTimeout，destroy 时清理

        function init(onTriggered) {
            _onTriggered = onTriggered;
            _hookSettingsSave();
        }

        function _hookSettingsSave() {
            // 注意：不能在 saveBtn 上注册捕获 handler 拦截。
            // 原因：在 target 元素本身上注册的 handler，无论 capture=true 还是 false，
            // 都按注册顺序在 target 阶段执行。main.js 的 bindHomeEvents 先于 petEasterEgg
            // 挂载，所以 main.js 的 handler 会先于 _checkEasterEgg 触发，stopImmediatePropagation
            // 来得太晚，AEFS 校验已经跑完。
            // 解决：在 document 上注册捕获 handler，捕获阶段严格先于 target 阶段执行，
            // 通过 e.target 判断是否是 saveBtn。
            document.addEventListener('click', _checkEasterEgg, true);
        }

        function _checkEasterEgg(e) {
            // 只处理 saveGlobalSettingsBtn 的点击
            var saveBtn = document.getElementById('saveGlobalSettingsBtn');
            if (!saveBtn || e.target !== saveBtn) return;

            var dataDirInput = document.getElementById('globalDataDir');
            if (!dataDirInput) return;

            var value = dataDirInput.value.trim();
            if (value === TRIGGER_WORD) {
                // 命中彩蛋：阻止后续 target/冒泡阶段的 handler，防止"大肥鱼"被当作真实 dataDir
                if (e) {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    if (typeof e.preventDefault === 'function') e.preventDefault();
                }

                // 从 settingsStore 读取真实数据目录作为原值，不依赖 DOM 属性
                var settingsStore = null;
                try {
                    if (global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function') {
                        var ctx = global.AEAppContainer.getContext();
                        if (ctx && ctx.settingsStore) settingsStore = ctx.settingsStore;
                    }
                } catch (e2) {}
                if (settingsStore && typeof settingsStore.getGlobalSettings === 'function') {
                    settingsStore.getGlobalSettings().then(function (gs) {
                        _originalDataDir = gs.dataDir || '';
                        dataDirInput.value = _originalDataDir;
                        _triggerEasterEgg();
                    }).catch(function () {
                        _originalDataDir = dataDirInput.value;
                        _triggerEasterEgg();
                    });
                } else {
                    _originalDataDir = dataDirInput.value;
                    _triggerEasterEgg();
                }
            }
        }

        function _triggerEasterEgg() {
            var settingsStore = null;
            try {
                if (global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function') {
                    var ctx = global.AEAppContainer.getContext();
                    if (ctx && ctx.settingsStore) settingsStore = ctx.settingsStore;
                }
            } catch (e) {}

            if (settingsStore && typeof settingsStore.setGlobalSettings === 'function') {
                settingsStore.getGlobalSettings({}).then(function (current) {
                    current.enableDeepseekPet = true;
                    return settingsStore.setGlobalSettings(current);
                }).then(function () {
                    _playAppearAnimation();
                }).catch(function (e) {
                    // settingsStore 读/写失败时仍播放出场动画，避免彩蛋静默失败
                    console.warn('[petEasterEgg] trigger persist failed: ' + e);
                    _playAppearAnimation();
                });
            } else {
                _playAppearAnimation();
            }
        }

        function _playAppearAnimation() {
            // ========= 容器：模糊压暗背景 =========
            var overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:rgba(0,0,0,0.55);backdrop-filter:blur(8px) brightness(0.6) saturate(0.15);-webkit-backdrop-filter:blur(8px) brightness(0.6) saturate(0.15);overflow:hidden;';
            document.body.appendChild(overlay);

            // ========= EVA 装饰元素（搬自 easterEgg.js，保留全部）=========
            // 所有 .egg-* 类的 z-index 在 panel.css 中定义（9993~9999）
            // 我们把视频的 z-index 设为 10000（最顶层），让出场视频覆盖在所有 glitch 元素之上

            var warnStage = document.createElement('div');
            warnStage.className = 'egg-warn-stage';
            var warnEl = document.createElement('div');
            warnEl.className = 'egg-warning';
            warnEl.textContent = 'WARNING';
            warnStage.appendChild(warnEl);
            var scanLine = document.createElement('div');
            scanLine.className = 'egg-warn-scan';
            warnStage.appendChild(scanLine);
            overlay.appendChild(warnStage);

            var decoTL = document.createElement('div');
            decoTL.className = 'egg-warn-deco';
            decoTL.innerHTML = AEI18n.html('<div class="egg-warn-deco-tl"></div>');
            decoTL.style.top = 'calc(50% - 155px)';
            decoTL.style.left = 'calc(50% - 245px)';
            overlay.appendChild(decoTL);

            var decoBR = document.createElement('div');
            decoBR.className = 'egg-warn-deco';
            decoBR.innerHTML = AEI18n.html('<div class="egg-warn-deco-br"></div>');
            decoBR.style.top = 'calc(50% + 95px)';
            decoBR.style.right = 'calc(50% - 245px)';
            overlay.appendChild(decoBR);

            var warnHex = document.createElement('div');
            warnHex.className = 'egg-warn-hex';
            warnHex.style.top = 'calc(50% + 105px)';
            warnHex.style.left = 'calc(50% + 150px)';
            overlay.appendChild(warnHex);

            var warnGlyph1 = document.createElement('div');
            warnGlyph1.className = 'egg-warn-glyph';
            warnGlyph1.textContent = '< AT FIELD WARNING >';
            warnGlyph1.style.top = 'calc(50% - 175px)';
            warnGlyph1.style.left = '50%';
            warnGlyph1.style.transform = 'translateX(-50%)';
            overlay.appendChild(warnGlyph1);

            var warnGlyph2 = document.createElement('div');
            warnGlyph2.className = 'egg-warn-glyph';
            warnGlyph2.textContent = '< PATTERN RED >';
            warnGlyph2.style.top = 'calc(50% + 190px)';
            warnGlyph2.style.left = '50%';
            warnGlyph2.style.transform = 'translateX(-50%)';
            overlay.appendChild(warnGlyph2);

            var atfOverlay = document.createElement('div');
            atfOverlay.className = 'egg-atf-overlay';
            overlay.appendChild(atfOverlay);

            var tacReadoutTL = document.createElement('div');
            tacReadoutTL.className = 'egg-tac-readout';
            tacReadoutTL.textContent = '[ AT-FIELD ]';
            tacReadoutTL.style.top = 'calc(50% - 190px)';
            tacReadoutTL.style.left = 'calc(50% - 260px)';
            overlay.appendChild(tacReadoutTL);

            var tacReadoutBR = document.createElement('div');
            tacReadoutBR.className = 'egg-tac-readout';
            tacReadoutBR.textContent = '[ DAMAGE LVL: CRIT ]';
            tacReadoutBR.style.bottom = 'calc(50% - 170px)';
            tacReadoutBR.style.right = 'calc(50% - 260px)';
            overlay.appendChild(tacReadoutBR);

            var crossEl = document.createElement('div');
            crossEl.className = 'egg-cross';
            var crossA = document.createElement('div');
            crossA.className = 'egg-cross-a';
            var crossB = document.createElement('div');
            crossB.className = 'egg-cross-b';
            crossEl.appendChild(crossA);
            crossEl.appendChild(crossB);
            overlay.appendChild(crossEl);

            var crossRing = document.createElement('div');
            crossRing.className = 'egg-cross-ring';
            var ring1 = document.createElement('div');
            ring1.className = 'egg-cross-ring-inner hex-ring';
            ring1.style.width = '180px'; ring1.style.height = '180px';
            ring1.style.marginLeft = '-90px'; ring1.style.marginTop = '-90px';
            ring1.style.borderWidth = '1px';
            var ring2 = document.createElement('div');
            ring2.className = 'egg-cross-ring-inner hex-ring';
            ring2.style.width = '300px'; ring2.style.height = '300px';
            ring2.style.marginLeft = '-150px'; ring2.style.marginTop = '-150px';
            ring2.style.borderWidth = '0.5px';
            crossRing.appendChild(ring1);
            crossRing.appendChild(ring2);
            overlay.appendChild(crossRing);

            var crossHex = document.createElement('div');
            crossHex.className = 'egg-cross-hex';
            var hexEa = document.createElement('div');
            hexEa.className = 'egg-cross-hex-ea';
            crossHex.appendChild(hexEa);
            overlay.appendChild(crossHex);

            var crossTags = [];
            var tagPositions = ['tl', 'tr', 'bl', 'br'];
            var tagTexts = ['ATF: COLLAPSED', 'SYS: PATTERN RED', 'BOUNDARY: NULL', 'CORE: BREACH'];
            for (var ti = 0; ti < 4; ti++) {
                var tag = document.createElement('div');
                tag.className = 'egg-cross-tag ' + tagPositions[ti];
                tag.textContent = '< ' + tagTexts[ti] + ' >';
                overlay.appendChild(tag);
                crossTags.push(tag);
            }

            var crossScan = document.createElement('div');
            crossScan.className = 'egg-cross-scan';
            overlay.appendChild(crossScan);

            var glitchEl = document.createElement('div');
            glitchEl.className = 'egg-glitch';
            overlay.appendChild(glitchEl);

            var chromaR = document.createElement('div');
            chromaR.className = 'egg-chroma-r';
            chromaR.textContent = 'WARNING';
            chromaR.style.top = 'calc(50% - 36px)';
            chromaR.style.left = '50%';
            overlay.appendChild(chromaR);

            var chromaB = document.createElement('div');
            chromaB.className = 'egg-chroma-b';
            chromaB.textContent = 'WARNING';
            chromaB.style.top = 'calc(50% - 36px)';
            chromaB.style.left = '50%';
            overlay.appendChild(chromaB);

            var stretchEl = document.createElement('div');
            stretchEl.className = 'egg-pixel-stretch';
            stretchEl.style.left = 'calc(50% - 200px)';
            stretchEl.style.top = 'calc(50% - 20px)';
            overlay.appendChild(stretchEl);

            var tear1 = document.createElement('div');
            tear1.className = 'egg-screen-tear';
            tear1.style.top = '28%'; tear1.style.left = '0'; tear1.style.right = '0';
            overlay.appendChild(tear1);

            var tear2 = document.createElement('div');
            tear2.className = 'egg-screen-tear';
            tear2.style.top = '74%'; tear2.style.left = '0'; tear2.style.right = '0';
            overlay.appendChild(tear2);

            var vcrLines = document.createElement('div');
            vcrLines.className = 'egg-vcr-lines';
            overlay.appendChild(vcrLines);

            var brackets = [];
            var brPositions = ['tl', 'tr', 'bl', 'br'];
            for (var bi = 0; bi < 4; bi++) {
                var brEl = document.createElement('div');
                brEl.className = 'egg-corner-bracket ' + brPositions[bi];
                overlay.appendChild(brEl);
                brackets.push(brEl);
            }

            var noiseEl = document.createElement('div');
            noiseEl.className = 'egg-noise';
            overlay.appendChild(noiseEl);

            var colorBars = document.createElement('div');
            colorBars.className = 'egg-color-bars';
            colorBars.style.top = '0'; colorBars.style.left = '0'; colorBars.style.right = '0'; colorBars.style.bottom = '0';
            overlay.appendChild(colorBars);

            var vhsTrack = document.createElement('div');
            vhsTrack.className = 'egg-vhs-track';
            vhsTrack.style.top = '0'; vhsTrack.style.left = '0'; vhsTrack.style.right = '0'; vhsTrack.style.height = '60px';
            overlay.appendChild(vhsTrack);

            var hsyncEl = document.createElement('div');
            hsyncEl.className = 'egg-hsync';
            hsyncEl.style.top = '15%'; hsyncEl.style.left = '0'; hsyncEl.style.right = '0'; hsyncEl.style.height = '10px';
            overlay.appendChild(hsyncEl);

            var distortionEl = document.createElement('div');
            distortionEl.className = 'egg-distortion';
            overlay.appendChild(distortionEl);

            var flashEl = document.createElement('div');
            flashEl.className = 'egg-flash';
            // 覆盖 panel.css 默认 z-index:9999 + background:#fff
            // 1) z-index 提到 10002，覆盖在桌宠视频（10000）之上，否则闪黑被视频盖住
            // 2) 背景从白改成黑：配合 reload 后的加载画面（深色）更连贯
            flashEl.style.zIndex = '10002';
            flashEl.style.background = '#000';
            overlay.appendChild(flashEl);

            // ========= 全屏震屏函数 =========
            // 注意：必须定义在 if (typeof anime !== 'undefined') 块外！
            // 因为 video 的 loadedmetadata 回调在 if 块外注册，会在 setTimeout 中调用 screenShake()。
            // 严格模式下块级函数声明在块外不可见，会导致 ReferenceError。
            function screenShake() {
                if (typeof anime === 'undefined') return;
                // 视频结束前 1 秒触发的"系统崩溃"震屏，需持续到视频结束（约 1 秒）
                // 总时长约 810ms（translateX）/ 770ms（translateY），配合后续 720ms 闪白
                anime({
                    targets: overlay,
                    translateX: [
                        { value: -22, duration: 120 },
                        { value: 20, duration: 120 },
                        { value: -16, duration: 100 },
                        { value: 12, duration: 100 },
                        { value: -10, duration: 80 },
                        { value: 8, duration: 80 },
                        { value: -6, duration: 60 },
                        { value: 4, duration: 50 },
                        { value: -2, duration: 40 },
                        { value: 1, duration: 30 },
                        { value: 0, duration: 30 }
                    ],
                    translateY: [
                        { value: 10, duration: 100 },
                        { value: -12, duration: 120 },
                        { value: 8, duration: 100 },
                        { value: -6, duration: 90 },
                        { value: 4, duration: 80 },
                        { value: -3, duration: 70 },
                        { value: 2, duration: 60 },
                        { value: -1, duration: 50 },
                        { value: 0, duration: 100 }
                    ],
                    easing: 'easeInOutSine',
                    update: function (anim) {
                        if (anim.progress > 90) overlay.style.transform = '';
                    }
                });
            }

            // ========= 桌宠出场视频（覆盖在所有 glitch 元素之上）=========
            // z-index: 10000 高于所有 .egg-* 元素（9993~9999），让视频完整可见
            // 延迟 0.5s 赋值 src + play：让 glitch 动画先播 0.5s 营造"信号干扰→实体出现"的过渡感
            var video = document.createElement('video');
            video.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:10000;pointer-events:none;opacity:0;transition:opacity 80ms ease-out;';
            video.playsInline = true;
            video.muted = false;
            video.volume = 1.0;
            overlay.appendChild(video);

            setTimeout(function () {
                video.src = 'features/deepseekPet/sprites/appear.webm';
                video.autoplay = true;
                video.load();
                // 视频开始播放时淡入，避免突然出现
                video.addEventListener('loadeddata', function () {
                    video.style.opacity = '1';
                }, { once: true });
                // 拿到视频时长后，在"视频结束前 1 秒"再触发一次全屏震屏
                // 配合后续的闪白收尾，营造"系统崩溃→重启"的过渡感
                video.addEventListener('loadedmetadata', function () {
                    var duration = video.duration;
                    if (typeof duration === 'number' && isFinite(duration) && duration > 1) {
                        var shakeDelay = Math.max(0, (duration - 1) * 1000);
                        setTimeout(function () {
                            if (typeof anime !== 'undefined' && overlay.parentNode) {
                                screenShake();
                            }
                        }, shakeDelay);
                    }
                }, { once: true });
            }, 500);

            // ========= 兜底提示（视频加载失败时显示）=========
            var fallback = document.createElement('div');
            fallback.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10001;text-align:center;color:#fbbf24;display:none;';
            fallback.innerHTML = AEI18n.html('<div style="font-size:48px;font-weight:600;letter-spacing:4px;">大肥鱼桌宠</div>') +
                AEI18n.html('<div style="margin-top:14px;font-size:16px;color:#fbbf24;">桌宠已解锁</div>') +
                AEI18n.html('<div style="margin-top:8px;font-size:12px;color:#7a8090;">即将重启...</div>');
            overlay.appendChild(fallback);

            var triggered = false;
            function _finish() {
                if (triggered) return;
                triggered = true;
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                if (typeof _onTriggered === 'function') _onTriggered();
            }

            // ========= Glitch 动画序列（搬自 easterEgg.js triggerEasterEgg）=========
            if (typeof anime !== 'undefined') {
                anime({ targets: warnEl, opacity: [0, 1], scale: [2, 1], duration: 250, easing: 'easeOutExpo' });
                anime({ targets: [atfOverlay, decoTL, decoBR, tacReadoutTL, tacReadoutBR, warnHex, warnGlyph1, warnGlyph2], opacity: [0, 1], duration: 180, delay: 80, easing: 'easeInExpo' });

                warnEl.classList.add('blinking');

                anime({
                    targets: warnEl,
                    color: [{ value: 'rgb(251,191,36)' }, { value: 'rgb(153,27,27)' }],
                    textShadow: [
                        { value: '0 0 40px rgba(251,191,36,.6), 0 0 120px rgba(251,191,36,.3)' },
                        { value: '0 0 40px rgba(153,27,27,.5), 0 0 100px rgba(153,27,27,.2)' }
                    ],
                    duration: 600, delay: 100, easing: 'easeInExpo',
                    complete: fireCross
                });

                function fireCross() {
                    screenShake();

                    anime({ targets: crossEl, opacity: [0, 1], duration: 60, easing: 'easeInExpo' });
                    crossEl.classList.add('flicker');
                    var crossScale = { v: 0 };
                    anime({
                        targets: crossScale,
                        v: [0, 1.3],
                        duration: 150,
                        easing: 'easeOutExpo',
                        update: function () {
                            crossA.style.transform = 'rotate(45deg) scale(' + crossScale.v + ')';
                            crossB.style.transform = 'rotate(-45deg) scale(' + crossScale.v + ')';
                        },
                        complete: function () {
                            anime({
                                targets: crossScale,
                                v: [1.3, 1],
                                duration: 80,
                                easing: 'easeOutCubic',
                                update: function () {
                                    crossA.style.transform = 'rotate(45deg) scale(' + crossScale.v + ')';
                                    crossB.style.transform = 'rotate(-45deg) scale(' + crossScale.v + ')';
                                }
                            });
                        }
                    });
                    anime({ targets: [crossRing, crossHex, crossScan], opacity: [0, 1], duration: 150, delay: 40 });
                    hexEa.style.animation = 'egg-hex-pulse 2s ease-in-out infinite';
                    anime({ targets: crossTags, opacity: [0, 1], duration: 120, delay: anime.stagger(40, { start: 80 }) });
                    anime({ targets: crossScan, top: ['-10%', '110%'], duration: 1200, easing: 'linear', loop: true });
                    anime({ targets: hexEa, rotate: ['30deg', '390deg'], duration: 1000, easing: 'linear', loop: false });
                    anime({ targets: [ring1, ring2], scale: [0.5, 1], duration: 250, easing: 'easeOutElastic(1, .3)' });

                    fireGlitch();
                    fireChroma();
                    fireTears();
                    spawnVertBars();

                    // 0.2s 后撒出 30 个 NERV 错误弹窗（与主彩蛋同时序），作为 glitch 装饰
                    // 弹窗 z-index 调到 9998，位于桌宠出场视频（10000）下方，不遮挡视频
                    setTimeout(function () {
                        floodErrors(function () {
                            // done：什么都不做，结束时机由视频 ended 驱动
                        });
                    }, 200);
                }

                function floodErrors(done) {
                    var errorTexts = [
                        'ERR: AT_FIELD_COLLAPSE at 0x7F3A',
                        'CRITICAL: Boundary layer breach detected',
                        'FATAL: Memory parity error in sector 07',
                        'WARN: Pattern RED threshold exceeded',
                        'ERR: Sync rate dropping below minimum',
                        'ALERT: Core temperature critical',
                        'FATAL: System integrity compromised',
                        'ERR: LCL connection terminated',
                        'CRITICAL: All safeties disengaged',
                        'WARN: Neural bridge unstable',
                        'ALERT: Containment field failing',
                        'ERR: Stack overflow in kernel',
                        'FATAL: Unrecoverable exception',
                        'ERR: DMA transfer corrupted',
                        'CRITICAL: Fail-safe override',
                        'FATAL: MAGI consensus lost — BALTHASAR',
                        'ALERT: Sync ratio zero — pilot unresponsive',
                        'WARN: Dirac sea anomaly detected'
                    ];
                    var w = overlay.offsetWidth;
                    var h = overlay.offsetHeight;
                    var winSpecs = [];
                    for (var i = 0; i < 30; i++) {
                        var ww = 180 + Math.random() * 260;
                        var wh = 80 + Math.random() * 140;
                        var wx = Math.random() * (w - ww);
                        var wy = Math.random() * (h - wh);
                        winSpecs.push({ w: ww, h: wh, x: wx, y: wy });
                    }

                    var wins = [];
                    for (var j = 0; j < winSpecs.length; j++) {
                        var spec = winSpecs[j];
                        var win = document.createElement('div');
                        win.className = 'egg-err-win';
                        // 覆盖默认 z-index 10001，让弹窗在视频（10000）下方作为 glitch 装饰
                        win.style.zIndex = '9998';
                        win.style.left = spec.x + 'px';
                        win.style.top = spec.y + 'px';
                        win.style.width = spec.w + 'px';
                        win.style.height = spec.h + 'px';

                        var head = document.createElement('div');
                        head.className = 'egg-err-win-head';
                        win.appendChild(head);

                        var body = document.createElement('div');
                        body.className = 'egg-err-win-body';
                        var txt = errorTexts[Math.floor(Math.random() * errorTexts.length)];
                        body.innerHTML = txt + '<br>CODE: 0x' + Math.floor(Math.random() * 0xFFFF).toString(16).toUpperCase() +
                            '<br>ADDR: 0x' + Math.floor(Math.random() * 0xFFFFFFFF).toString(16).toUpperCase() +
                            '<br>TIME: ' + Math.floor(Math.random() * 999).toString().padStart(3, '0') + 'ms';
                        win.appendChild(body);

                        var decoTl = document.createElement('div');
                        decoTl.className = 'egg-err-win-deco tl';
                        var decoBr = document.createElement('div');
                        decoBr.className = 'egg-err-win-deco br';
                        win.appendChild(decoTl);
                        win.appendChild(decoBr);

                        var blip = document.createElement('div');
                        blip.className = 'egg-err-blip';
                        blip.style.top = (8 + Math.random() * (spec.h - 16)) + 'px';
                        blip.style.right = (6 + Math.random() * 20) + 'px';
                        win.appendChild(blip);

                        overlay.appendChild(win);
                        wins.push(win);
                    }

                    for (var k = 0; k < wins.length; k++) {
                        (function (el, idx) {
                            anime({
                                targets: el,
                                opacity: [0, 1],
                                scale: [0.3 + Math.random() * 0.5, 1],
                                translateX: [
                                    (Math.random() - 0.5) * 200,
                                    (Math.random() - 0.5) * 30,
                                    (Math.random() - 0.5) * 60,
                                    0
                                ],
                                translateY: [
                                    (Math.random() - 0.5) * 150,
                                    (Math.random() - 0.5) * 20,
                                    (Math.random() - 0.5) * 40,
                                    0
                                ],
                                rotate: [Math.random() * 40 - 20, 0],
                                duration: 300 + Math.random() * 300,
                                delay: idx * 15 + Math.random() * 50,
                                easing: 'easeOutExpo'
                            });
                        })(wins[k], k);
                    }

                    // 1 秒后清理所有弹窗，调 done
                    setTimeout(function () {
                        for (var m = 0; m < wins.length; m++) {
                            if (wins[m].parentNode) wins[m].parentNode.removeChild(wins[m]);
                        }
                        if (typeof done === 'function') done();
                    }, 1000);
                }

                function spawnVertBars() {
                    for (var vi = 0; vi < 60; vi++) {
                        (function (d) {
                            setTimeout(function () {
                                var bar = document.createElement('div');
                                bar.style.cssText = 'position:absolute;z-index:9999;pointer-events:none;top:0;height:100%;opacity:0;';
                                bar.style.left = (Math.random() * 100) + '%';
                                bar.style.width = (3 + Math.random() * 50) + 'px';
                                bar.style.background = Math.random() > 0.5
                                    ? 'rgba(153,27,27,' + (0.2 + Math.random() * 0.3) + ')'
                                    : 'rgba(251,191,36,' + (0.08 + Math.random() * 0.12) + ')';
                                bar.style.boxShadow = '0 0 12px rgba(153,27,27,.15)';
                                overlay.appendChild(bar);
                                anime({ targets: bar, opacity: [0, 0.6], duration: 20, easing: 'easeInExpo', complete: function () {
                                    anime({ targets: bar, opacity: [0.6, 0], duration: 80 + Math.random() * 120, delay: 20 + Math.random() * 50, easing: 'easeOutExpo', complete: function () {
                                        if (bar.parentNode) bar.parentNode.removeChild(bar);
                                    }});
                                }});
                            }, d * 40 + Math.random() * 120);
                        })(vi);
                    }
                }

                function fireGlitch() {
                    anime({ targets: glitchEl, opacity: [0, 0.6], duration: 30, easing: 'easeInExpo', complete: function () {
                        anime({ targets: glitchEl, opacity: [0.6, 0.04], duration: 200, delay: 10 });
                    }});
                    for (var gi = 0; gi < 10; gi++) {
                        (function (d) {
                            setTimeout(function () {
                                anime({ targets: glitchEl, opacity: [0.04, (d % 2 === 0 ? 0.6 : 0.4)], duration: 25, easing: 'easeInExpo', complete: function () {
                                    anime({ targets: glitchEl, opacity: { value: 0.04, easing: 'easeOutExpo' }, duration: 80 });
                                }});
                            }, 400 + d * 150 + Math.random() * 150);
                        })(gi);
                    }
                }

                function fireChroma() {
                    anime({ targets: chromaR, opacity: [0, 0.4], duration: 80, easing: 'easeInExpo', complete: function () {
                        anime({ targets: chromaR, marginLeft: ['calc(-50% - 4px)', 'calc(-50% + 18px)'], duration: 40, complete: function () {
                            anime({ targets: chromaR, marginLeft: ['calc(-50% + 18px)', 'calc(-50% - 10px)'], duration: 50, complete: function () {
                                anime({ targets: chromaR, marginLeft: ['calc(-50% - 10px)', 'calc(-50% + 2px)'], duration: 70, complete: function () {
                                    anime({ targets: chromaR, opacity: [0.4, 0], duration: 200 });
                                }});
                            }});
                        }});
                    }});
                    anime({ targets: chromaB, opacity: [0, 0.25], duration: 90, delay: 15, easing: 'easeInExpo', complete: function () {
                        anime({ targets: chromaB, marginLeft: ['calc(-50% + 5px)', 'calc(-50% - 12px)'], duration: 45, complete: function () {
                            anime({ targets: chromaB, marginLeft: ['calc(-50% - 12px)', 'calc(-50% + 4px)'], duration: 55, complete: function () {
                                anime({ targets: chromaB, opacity: [0.25, 0], duration: 200 });
                            }});
                        }});
                    }});
                }

                function fireTears() {
                    anime({ targets: [stretchEl, vcrLines], opacity: [0, 0.6], duration: 50, easing: 'easeInExpo' });
                    anime({ targets: stretchEl, width: ['0px', '520px'], height: ['0px', '80px'], duration: 100, easing: 'easeOutExpo', complete: function () {
                        anime({ targets: stretchEl, opacity: [0.6, 0], duration: 200, delay: 100 });
                        anime({ targets: stretchEl, height: ['80px', '10px'], duration: 35, delay: 100 });
                    }});
                    anime({ targets: [tear1, tear2], opacity: [0, 0.7], duration: 60, delay: 30, easing: 'easeInExpo', complete: function () {
                        anime({ targets: [tear1, tear2], opacity: [0.7, 0], duration: 300, delay: 150 });
                    }});
                    anime({ targets: brackets, opacity: [0, 1], duration: 100, delay: anime.stagger(25, { start: 50 }) });
                    anime({ targets: vcrLines, opacity: [0.6, 0.06], duration: 400, delay: 200, easing: 'easeOutExpo' });

                    anime({ targets: distortionEl, opacity: [0, 0.3], duration: 40, easing: 'easeInExpo', complete: function () {
                        anime({ targets: distortionEl, opacity: [0.3, 0], duration: 250, delay: 80 });
                    }});
                    anime({ targets: noiseEl, opacity: [0, 0.12], duration: 80, complete: function () {
                        anime({ targets: noiseEl, opacity: [0.12, 0.03], duration: 200, delay: 40 });
                    }});
                    anime({ targets: colorBars, opacity: [0, 0.35], duration: 40, complete: function () {
                        colorBars.classList.add('shifting');
                        anime({ targets: colorBars, opacity: [0.35, 0], duration: 250, delay: 80, complete: function () {
                            colorBars.classList.remove('shifting');
                        }});
                    }});
                    anime({ targets: vhsTrack, opacity: [0, 0.4], duration: 30, complete: function () {
                        vhsTrack.classList.add('active');
                        anime({ targets: vhsTrack, opacity: [0.4, 0], duration: 300, delay: 120, complete: function () {
                            vhsTrack.classList.remove('active');
                        }});
                    }});
                    anime({ targets: hsyncEl, opacity: [0, 0.5], duration: 40, easing: 'easeInExpo', complete: function () {
                        anime({ targets: hsyncEl, opacity: [0.5, 0], duration: 150, delay: 40 });
                    }});

                    spawnRandomBlocks();
                }

                function spawnRandomBlocks() {
                    for (var ri = 0; ri < 12; ri++) {
                        (function (d) {
                            setTimeout(function () {
                                var block = document.createElement('div');
                                block.className = 'egg-random-block';
                                var bw = 40 + Math.random() * 120;
                                var bh = 20 + Math.random() * 60;
                                block.style.width = bw + 'px';
                                block.style.height = bh + 'px';
                                block.style.left = (Math.random() * 90) + '%';
                                block.style.top = (Math.random() * 90) + '%';
                                overlay.appendChild(block);
                                anime({ targets: block, opacity: [0, 0.5], duration: 60, easing: 'easeInCubic', complete: function () {
                                    anime({ targets: block, opacity: [0.5, 0], duration: 300, delay: 100, complete: function () {
                                        if (block.parentNode) block.parentNode.removeChild(block);
                                    }});
                                }});
                            }, d * 200 + Math.random() * 300);
                        })(ri);
                    }
                }

                function fireFlash(done) {
                    // 闪黑：快速到全黑 → 短暂保持 → done（reload）
                    // 不做渐出，因为 done 会触发 location.reload，加载画面直接接管
                    anime({
                        targets: flashEl,
                        opacity: [0, 1],
                        duration: 100,
                        easing: 'easeInExpo',
                        complete: function () {
                            // 保持黑色 150ms，让"闪黑"感强烈后再 reload
                            setTimeout(done, 150);
                        }
                    });
                }

                // 视频结束后：闪黑 → _finish → location.reload → 加载画面接管
                video.addEventListener('ended', function () {
                    fireFlash(_finish);
                }, { once: true });
            } else {
                // anime.js 不可用时直接监听视频结束
                video.addEventListener('ended', function () { setTimeout(_finish, 300); });
            }

            // 视频加载失败：显示兜底文本
            video.addEventListener('error', function () {
                fallback.style.display = 'block';
                video.style.display = 'none';
                setTimeout(_finish, 2500);
            });

            // 兜底超时：0.5s 延迟 + 视频 4 秒 + glitch 序列约 4 秒，留 10.5 秒余量（应对磁盘 IO 慢加载视频的情况）
            setTimeout(_finish, 10500);

            // 通知事件总线
            if (global.AEDeepseekPet && global.AEDeepseekPet.eventBus) {
                global.AEDeepseekPet.eventBus.emit('easter-egg:triggered');
            }
        }

        function destroy() {
            if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
            document.removeEventListener('click', _checkEasterEgg, true);
            _onTriggered = null;
        }

        return {
            init: init,
            destroy: destroy
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createEasterEgg = createEasterEgg;
    global.AEDeepseekPet.easterEgg = null;
})(window);
