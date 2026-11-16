(function (global) {
    'use strict';

    var _onBootReplay = null;

    var _eggState = { clicks: 0, timer: null, fired: false };

    function init(onBootReplay) {
        _onBootReplay = onBootReplay;
        var eggSpan = document.querySelector('.hud-all-clear');
        if (!eggSpan) return;

        eggSpan.style.cursor = 'pointer';
        eggSpan.addEventListener('click', function(e) {
            e.stopPropagation();
            if (_eggState.fired) return;
            _eggState.clicks++;
            if (_eggState.timer) clearTimeout(_eggState.timer);
            _eggState.timer = setTimeout(function() { _eggState.clicks = 0; }, 5000);
            if (_eggState.clicks >= 10) {
                _eggState.fired = true;
                if (_eggState.timer) clearTimeout(_eggState.timer);
                triggerEasterEgg();
            }
        });
    }

    function triggerEasterEgg() {
        // NERV 彩蛋音效：高频警报 + 低频 drone 叠加
        if (typeof global.aeBeep === 'function') {
            global.aeBeep('nerv');
            global.aeBeep('nervBass');
        }

        var rect = document.querySelector('.hud-all-clear').getBoundingClientRect();
        var tx = rect.left + rect.width / 2;
        var ty = rect.top + rect.height / 2;

        var blurBg = document.createElement('div');
        blurBg.className = 'egg-blur-bg';

        var eggOverlay = document.createElement('div');
        eggOverlay.className = 'egg-overlay';

        var warnStage = document.createElement('div');
        warnStage.className = 'egg-warn-stage';

        var warnEl = document.createElement('div');
        warnEl.className = 'egg-warning';
        warnEl.textContent = 'WARNING';
        warnStage.appendChild(warnEl);

        var scanLine = document.createElement('div');
        scanLine.className = 'egg-warn-scan';
        warnStage.appendChild(scanLine);
        eggOverlay.appendChild(warnStage);

        var decoTL = document.createElement('div');
        decoTL.className = 'egg-warn-deco';
        decoTL.innerHTML = AEI18n.html('<div class="egg-warn-deco-tl"></div>');
        decoTL.style.top = 'calc(50% - 155px)';
        decoTL.style.left = 'calc(50% - 245px)';

        var decoBR = document.createElement('div');
        decoBR.className = 'egg-warn-deco';
        decoBR.innerHTML = AEI18n.html('<div class="egg-warn-deco-br"></div>');
        decoBR.style.top = 'calc(50% + 95px)';
        decoBR.style.right = 'calc(50% - 245px)';

        var warnHex = document.createElement('div');
        warnHex.className = 'egg-warn-hex';
        warnHex.style.top = 'calc(50% + 105px)';
        warnHex.style.left = 'calc(50% + 150px)';

        var warnGlyph1 = document.createElement('div');
        warnGlyph1.className = 'egg-warn-glyph';
        warnGlyph1.textContent = '< AT FIELD WARNING >';
        warnGlyph1.style.top = 'calc(50% - 175px)';
        warnGlyph1.style.left = '50%';
        warnGlyph1.style.transform = 'translateX(-50%)';

        var warnGlyph2 = document.createElement('div');
        warnGlyph2.className = 'egg-warn-glyph';
        warnGlyph2.textContent = '< PATTERN RED >';
        warnGlyph2.style.top = 'calc(50% + 190px)';
        warnGlyph2.style.left = '50%';
        warnGlyph2.style.transform = 'translateX(-50%)';

        var atfOverlay = document.createElement('div');
        atfOverlay.className = 'egg-atf-overlay';

        var tacReadoutTL = document.createElement('div');
        tacReadoutTL.className = 'egg-tac-readout';
        tacReadoutTL.textContent = '[ AT-FIELD ]';
        tacReadoutTL.style.top = 'calc(50% - 190px)';
        tacReadoutTL.style.left = 'calc(50% - 260px)';

        var tacReadoutBR = document.createElement('div');
        tacReadoutBR.className = 'egg-tac-readout';
        tacReadoutBR.textContent = '[ DAMAGE LVL: CRIT ]';
        tacReadoutBR.style.bottom = 'calc(50% - 170px)';
        tacReadoutBR.style.right = 'calc(50% - 260px)';

        var crossEl = document.createElement('div');
        crossEl.className = 'egg-cross';
        var crossA = document.createElement('div');
        crossA.className = 'egg-cross-a';
        var crossB = document.createElement('div');
        crossB.className = 'egg-cross-b';
        crossEl.appendChild(crossA);
        crossEl.appendChild(crossB);

        var crossRing = document.createElement('div');
        crossRing.className = 'egg-cross-ring';
        var ring1 = document.createElement('div');
        ring1.className = 'egg-cross-ring-inner hex-ring';
        ring1.style.width = '180px';
        ring1.style.height = '180px';
        ring1.style.marginLeft = '-90px';
        ring1.style.marginTop = '-90px';
        ring1.style.borderWidth = '1px';
        var ring2 = document.createElement('div');
        ring2.className = 'egg-cross-ring-inner hex-ring';
        ring2.style.width = '300px';
        ring2.style.height = '300px';
        ring2.style.marginLeft = '-150px';
        ring2.style.marginTop = '-150px';
        ring2.style.borderWidth = '0.5px';
        crossRing.appendChild(ring1);
        crossRing.appendChild(ring2);

        var crossHex = document.createElement('div');
        crossHex.className = 'egg-cross-hex';
        var hexEa = document.createElement('div');
        hexEa.className = 'egg-cross-hex-ea';
        crossHex.appendChild(hexEa);

        var crossTags = [];
        var tagPositions = ['tl', 'tr', 'bl', 'br'];
        var tagTexts = ['ATF: COLLAPSED', 'SYS: PATTERN RED', 'BOUNDARY: NULL', 'CORE: BREACH'];
        for (var ti = 0; ti < 4; ti++) {
            var tag = document.createElement('div');
            tag.className = 'egg-cross-tag ' + tagPositions[ti];
            tag.textContent = '< ' + tagTexts[ti] + ' >';
            crossTags.push(tag);
        }

        var crossScan = document.createElement('div');
        crossScan.className = 'egg-cross-scan';

        var glitchEl = document.createElement('div');
        glitchEl.className = 'egg-glitch';

        var chromaR = document.createElement('div');
         chromaR.className = 'egg-chroma-r';
         chromaR.textContent = 'WARNING';
         chromaR.style.top = 'calc(50% - 36px)';
         chromaR.style.left = '50%';

         var chromaB = document.createElement('div');
         chromaB.className = 'egg-chroma-b';
         chromaB.textContent = 'WARNING';
         chromaB.style.top = 'calc(50% - 36px)';
         chromaB.style.left = '50%';

        var stretchEl = document.createElement('div');
        stretchEl.className = 'egg-pixel-stretch';
        stretchEl.style.left = 'calc(50% - 200px)';
        stretchEl.style.top = 'calc(50% - 20px)';

        var tear1 = document.createElement('div');
        tear1.className = 'egg-screen-tear';
        tear1.style.top = '28%';
        tear1.style.left = '0';
        tear1.style.right = '0';

        var tear2 = document.createElement('div');
        tear2.className = 'egg-screen-tear';
        tear2.style.top = '74%';
        tear2.style.left = '0';
        tear2.style.right = '0';

        var vcrLines = document.createElement('div');
        vcrLines.className = 'egg-vcr-lines';

        var brackets = [];
        var brPositions = ['tl', 'tr', 'bl', 'br'];
        for (var bi = 0; bi < 4; bi++) {
            var brEl = document.createElement('div');
            brEl.className = 'egg-corner-bracket ' + brPositions[bi];
            brackets.push(brEl);
        }

        var flashEl = document.createElement('div');
        flashEl.className = 'egg-flash';

        var noiseEl = document.createElement('div');
        noiseEl.className = 'egg-noise';

        var colorBars = document.createElement('div');
        colorBars.className = 'egg-color-bars';
        colorBars.style.top = '0'; colorBars.style.left = '0'; colorBars.style.right = '0'; colorBars.style.bottom = '0';

        var vhsTrack = document.createElement('div');
        vhsTrack.className = 'egg-vhs-track';
        vhsTrack.style.top = '0'; vhsTrack.style.left = '0'; vhsTrack.style.right = '0'; vhsTrack.style.height = '60px';

        var hsyncEl = document.createElement('div');
        hsyncEl.className = 'egg-hsync';
        hsyncEl.style.top = '15%'; hsyncEl.style.left = '0'; hsyncEl.style.right = '0'; hsyncEl.style.height = '10px';

        var distortionEl = document.createElement('div');
        distortionEl.className = 'egg-distortion';

        document.body.appendChild(blurBg);
        document.body.appendChild(eggOverlay);
        document.body.appendChild(atfOverlay);
        document.body.appendChild(decoTL);
        document.body.appendChild(decoBR);
        document.body.appendChild(tacReadoutTL);
        document.body.appendChild(tacReadoutBR);
        document.body.appendChild(warnHex);
        document.body.appendChild(warnGlyph1);
        document.body.appendChild(warnGlyph2);
        document.body.appendChild(crossEl);
        document.body.appendChild(crossRing);
        document.body.appendChild(crossHex);
        for (var t = 0; t < crossTags.length; t++) document.body.appendChild(crossTags[t]);
        document.body.appendChild(crossScan);
        document.body.appendChild(glitchEl);
        document.body.appendChild(chromaR);
        document.body.appendChild(chromaB);
        document.body.appendChild(stretchEl);
        document.body.appendChild(tear1);
        document.body.appendChild(tear2);
        document.body.appendChild(vcrLines);
        for (var bi2 = 0; bi2 < brackets.length; bi2++) document.body.appendChild(brackets[bi2]);
        document.body.appendChild(noiseEl);
        document.body.appendChild(colorBars);
        document.body.appendChild(vhsTrack);
        document.body.appendChild(hsyncEl);
        document.body.appendChild(distortionEl);
        document.body.appendChild(flashEl);

        if (typeof anime !== 'undefined') {
            var scene = document.getElementById('cubeScene');

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

            function screenShake() {
                var appEl = document.querySelector('.app');
                if (!appEl) return;
                anime({
                    targets: appEl,
                    translateX: [
                        { value: -8, duration: 30 },
                        { value: 7, duration: 30 },
                        { value: -5, duration: 25 },
                        { value: 4, duration: 25 },
                        { value: -2, duration: 20 },
                        { value: 1, duration: 15 },
                        { value: 0, duration: 10 }
                    ],
                    translateY: [
                        { value: 4, duration: 25 },
                        { value: -5, duration: 30 },
                        { value: 3, duration: 20 },
                        { value: -2, duration: 25 },
                        { value: 1, duration: 15 },
                        { value: 0, duration: 10 }
                    ],
                    easing: 'easeInOutSine',
                    update: function(anim) {
                        if (anim.progress > 70) {
                            appEl.style.transform = '';
                        }
                    }
                });
            }

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
                    update: function() {
                        crossA.style.transform = 'rotate(45deg) scale(' + crossScale.v + ')';
                        crossB.style.transform = 'rotate(-45deg) scale(' + crossScale.v + ')';
                    },
                    complete: function() {
                        anime({
                            targets: crossScale,
                            v: [1.3, 1],
                            duration: 80,
                            easing: 'easeOutCubic',
                            update: function() {
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
                flashDOM();
                spawnVertBars();

                if (scene) {
                    anime({ targets: scene, scale: [1, 1.08], duration: 25, easing: 'easeInExpo', complete: function() {
                        anime({ targets: scene, scale: [1.08, 0.88], duration: 40, easing: 'easeInExpo', complete: function() {
                            anime({ targets: scene, scale: [0.88, 1.04], duration: 35, easing: 'easeOutExpo', complete: function() {
                                anime({ targets: scene, scale: [1.04, 1], duration: 50, easing: 'easeOutCubic' });
                            }});
                        }});
                    }});
                }

                setTimeout(function() {
                    floodErrors(tx, ty, function() {
                        flash(flashEl, function() {
                            cleanupEgg();
                            bootNow();
                        });
                    });
                }, 200);
            }

            function flashDOM() {
                var domEls = document.querySelectorAll('.app, .topbar, .hud-status-bar, .btn, .panel, .mgmt-table-wrap, input, .cube-face, .script-item');
                for (var fi = 0; fi < 30; fi++) {
                    (function(d) {
                        setTimeout(function() {
                            var idx = Math.floor(Math.random() * domEls.length);
                            var el = domEls[idx];
                            if (!el) return;
                            var origBg = el.style.background;
                            var origFilter = el.style.filter;
                            el.style.transition = 'background .03s ease-out, filter .02s ease-out';
                            el.style.background = 'rgba(153,27,27,' + (0.4 + Math.random() * 0.5) + ')';
                            el.style.filter = 'brightness(2)';
                            setTimeout(function() {
                                el.style.background = origBg;
                                el.style.filter = origFilter;
                            }, 30 + Math.random() * 60);
                        }, d * 100 + Math.random() * 200);
                    })(fi);
                }
            }

            function spawnVertBars() {
                 for (var vi = 0; vi < 60; vi++) {
                     (function(d) {
                         setTimeout(function() {
                             var bar = document.createElement('div');
                             bar.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;top:0;height:100%;opacity:0;';
                             bar.style.left = (Math.random() * 100) + '%';
                             bar.style.width = (3 + Math.random() * 50) + 'px';
                             bar.style.background = Math.random() > 0.5
                                 ? 'rgba(153,27,27,' + (0.2 + Math.random() * 0.3) + ')'
                                 : 'rgba(251,191,36,' + (0.08 + Math.random() * 0.12) + ')';
                             bar.style.boxShadow = '0 0 12px rgba(153,27,27,.15)';
                             document.body.appendChild(bar);
                             anime({ targets: bar, opacity: [0, 0.6], duration: 20, easing: 'easeInExpo', complete: function() {
                                 anime({ targets: bar, opacity: [0.6, 0], duration: 80 + Math.random() * 120, delay: 20 + Math.random() * 50, easing: 'easeOutExpo', complete: function() {
                                     if (bar.parentNode) bar.parentNode.removeChild(bar);
                                 }});
                             }});
                         }, d * 40 + Math.random() * 120);
                     })(vi);
                 }
             }

            function fireGlitch() {
                 anime({ targets: glitchEl, opacity: [0, 0.6], duration: 30, easing: 'easeInExpo', complete: function() {
                     anime({ targets: glitchEl, opacity: [0.6, 0.04], duration: 200, delay: 10 });
                 }});
                 for (var gi = 0; gi < 10; gi++) {
                     (function(d) {
                         setTimeout(function() {
                             anime({ targets: glitchEl, opacity: [0.04, (d % 2 === 0 ? 0.6 : 0.4)], duration: 25, easing: 'easeInExpo', complete: function() {
                                 anime({ targets: glitchEl, opacity: { value: 0.04, easing: 'easeOutExpo' }, duration: 80 });
                             }});
                         }, 400 + d * 150 + Math.random() * 150);
                     })(gi);
                 }
            }

            function fireChroma() {
                anime({ targets: chromaR, opacity: [0, 0.4], duration: 80, easing: 'easeInExpo', complete: function() {
                    anime({ targets: chromaR, marginLeft: ['calc(-50% - 4px)', 'calc(-50% + 18px)'], duration: 40, complete: function() {
                        anime({ targets: chromaR, marginLeft: ['calc(-50% + 18px)', 'calc(-50% - 10px)'], duration: 50, complete: function() {
                            anime({ targets: chromaR, marginLeft: ['calc(-50% - 10px)', 'calc(-50% + 2px)'], duration: 70, complete: function() {
                                anime({ targets: chromaR, opacity: [0.4, 0], duration: 200 });
                            }});
                        }});
                    }});
                }});
                anime({ targets: chromaB, opacity: [0, 0.25], duration: 90, delay: 15, easing: 'easeInExpo', complete: function() {
                    anime({ targets: chromaB, marginLeft: ['calc(-50% + 5px)', 'calc(-50% - 12px)'], duration: 45, complete: function() {
                        anime({ targets: chromaB, marginLeft: ['calc(-50% - 12px)', 'calc(-50% + 4px)'], duration: 55, complete: function() {
                            anime({ targets: chromaB, opacity: [0.25, 0], duration: 200 });
                        }});
                    }});
                }});
            }

            function fireTears() {
                 anime({ targets: [stretchEl, vcrLines], opacity: [0, 0.6], duration: 50, easing: 'easeInExpo' });
                 anime({ targets: stretchEl, width: ['0px', '520px'], height: ['0px', '80px'], duration: 100, easing: 'easeOutExpo', complete: function() {
                     anime({ targets: stretchEl, opacity: [0.6, 0], duration: 200, delay: 100 });
                     anime({ targets: stretchEl, height: ['80px', '10px'], duration: 35, delay: 100 });
                 }});
                 anime({ targets: [tear1, tear2], opacity: [0, 0.7], duration: 60, delay: 30, easing: 'easeInExpo', complete: function() {
                     anime({ targets: [tear1, tear2], opacity: [0.7, 0], duration: 300, delay: 150 });
                 }});
                 anime({ targets: brackets, opacity: [0, 1], duration: 100, delay: anime.stagger(25, { start: 50 }) });
                 anime({ targets: vcrLines, opacity: [0.6, 0.06], duration: 400, delay: 200, easing: 'easeOutExpo' });

                 anime({ targets: distortionEl, opacity: [0, 0.3], duration: 40, easing: 'easeInExpo', complete: function() {
                     anime({ targets: distortionEl, opacity: [0.3, 0], duration: 250, delay: 80 });
                 }});
                 anime({ targets: noiseEl, opacity: [0, 0.12], duration: 80, complete: function() {
                     anime({ targets: noiseEl, opacity: [0.12, 0.03], duration: 200, delay: 40 });
                 }});
                 anime({ targets: colorBars, opacity: [0, 0.35], duration: 40, complete: function() {
                     colorBars.classList.add('shifting');
                     anime({ targets: colorBars, opacity: [0.35, 0], duration: 250, delay: 80, complete: function() {
                         colorBars.classList.remove('shifting');
                     }});
                 }});
                 anime({ targets: vhsTrack, opacity: [0, 0.4], duration: 30, complete: function() {
                     vhsTrack.classList.add('active');
                     anime({ targets: vhsTrack, opacity: [0.4, 0], duration: 300, delay: 120, complete: function() {
                         vhsTrack.classList.remove('active');
                     }});
                 }});
                 anime({ targets: hsyncEl, opacity: [0, 0.5], duration: 40, easing: 'easeInExpo', complete: function() {
                     anime({ targets: hsyncEl, opacity: [0.5, 0], duration: 150, delay: 40 });
                 }});

                 spawnRandomBlocks();
             }

             function spawnRandomBlocks() {
                 for (var ri = 0; ri < 12; ri++) {
                     (function(d) {
                         setTimeout(function() {
                             var block = document.createElement('div');
                             block.className = 'egg-random-block';
                             var bw = 40 + Math.random() * 120;
                             var bh = 20 + Math.random() * 60;
                             block.style.width = bw + 'px';
                             block.style.height = bh + 'px';
                             block.style.left = (Math.random() * 90) + '%';
                             block.style.top = (Math.random() * 90) + '%';
                             document.body.appendChild(block);
                             anime({ targets: block, opacity: [0, 0.5], duration: 60, easing: 'easeInCubic', complete: function() {
                                 anime({ targets: block, opacity: [0.5, 0], duration: 300, delay: 100, complete: function() {
                                     if (block.parentNode) block.parentNode.removeChild(block);
                                 }});
                             }});
                         }, d * 200 + Math.random() * 300);
                     })(ri);
                 }
             }
        } else {
            warnEl.style.opacity = '1';
            warnEl.style.color = '#ef4444';
            warnEl.classList.add('blinking');
            atfOverlay.style.opacity = '1';
            decoTL.style.opacity = '1'; decoBR.style.opacity = '1';
            tacReadoutTL.style.opacity = '1'; tacReadoutBR.style.opacity = '1';
            crossEl.style.opacity = '1'; crossRing.style.opacity = '1';
            setTimeout(function() {
                floodErrors(tx, ty, function() {
                    // 与 anime 分支同语义：先清理全部 egg DOM（否则 .egg-blur-bg 等
                    // 全屏 fixed 元素永久残留，整个应用持续处于模糊压暗态），
                    // 再走 bootNow 重置彩蛋状态并回放启动动画（AEBoot.replay 复位
                    // _finished 锁；直接调 _onBootReplay 会因锁未复位而无任何效果）
                    flash(flashEl, function() {
                        cleanupEgg();
                        bootNow();
                    });
                });
            }, 500);
        }
    }

    function floodErrors(tx, ty, done) {
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
        var winSpecs = [];
        var w = window.innerWidth;
        var h = window.innerHeight;
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

            document.body.appendChild(win);
            wins.push(win);
        }

        if (typeof anime !== 'undefined') {
            for (var k = 0; k < wins.length; k++) {
                (function(el, idx) {
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
        }

        var totalTime = 1000;
        setTimeout(function() {
            for (var m = 0; m < wins.length; m++) {
                if (wins[m].parentNode) wins[m].parentNode.removeChild(wins[m]);
            }
            done();
        }, totalTime);
    }

    function cleanupEgg() {
        var appEl = document.querySelector('.app');
        if (appEl) appEl.style.transform = '';

        var allEgg = document.querySelectorAll(
            '.egg-blur-bg, .egg-overlay, .egg-atf-overlay, .egg-tac-readout, .egg-warn-deco, .egg-warn-hex, .egg-warn-glyph,' +
            '.egg-cross, .egg-cross-ring, .egg-cross-hex, .egg-cross-tag, .egg-cross-scan,' +
            '.egg-glitch, .egg-chroma-r, .egg-chroma-b, .egg-pixel-stretch, .egg-screen-tear,' +
            '.egg-vcr-lines, .egg-corner-bracket, .egg-flash, .egg-err-win,' +
            '.egg-noise, .egg-color-bars, .egg-vhs-track, .egg-hsync, .egg-distortion, .egg-random-block'
        );
        for (var ei = allEgg.length - 1; ei >= 0; ei--) {
            if (allEgg[ei].parentNode) allEgg[ei].parentNode.removeChild(allEgg[ei]);
        }
        var scene = document.getElementById('cubeScene');
        if (scene) scene.style.transform = '';
    }

    function bootNow() {
        var boot = document.getElementById('bootSequence');
        if (boot) {
            boot.classList.remove('dismissed', 'done');
            var phases = boot.querySelectorAll('.boot-phase');
            for (var p = 0; p < phases.length; p++) {
                phases[p].classList.remove('active', 'done');
            }
            if (phases[0]) phases[0].classList.add('active');
            boot.style.display = '';
        }
        // 重置 AEBoot 模块的 _finished/_dismissed 锁，否则 finish() 会因已 finish 而直接 return
        if (global.AEBoot && typeof global.AEBoot.replay === 'function') {
            global.AEBoot.replay();
        }
        _eggState.fired = false;
        _eggState.clicks = 0;
        if (typeof _onBootReplay === 'function') _onBootReplay();
    }

    function flash(flashEl, done) {
        if (typeof anime !== 'undefined') {
            anime({
                targets: flashEl,
                opacity: [0, 1],
                duration: 120,
                easing: 'easeInExpo',
                complete: function() {
                    anime({
                        targets: flashEl,
                        opacity: [1, 0],
                        duration: 600,
                        easing: 'easeOutExpo',
                        complete: done
                    });
                }
            });
        } else {
            flashEl.style.opacity = '1';
            setTimeout(function() {
                flashEl.style.opacity = '0';
                setTimeout(done, 400);
            }, 150);
        }
    }

    function resetEasterEgg() { _eggState.fired = false; _eggState.clicks = 0; }

    global.AEEasterEgg = { init: init, trigger: triggerEasterEgg, reset: resetEasterEgg };
})(window);
