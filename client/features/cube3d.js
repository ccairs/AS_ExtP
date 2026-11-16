(function (global) {
    'use strict';

    var _onNavigate = null;

    var cubeState = {
        active: false,
        rotateX: -25,
        rotateY: 45,
        cubeScale: 1,
        dragging: false,
        dragStartX: 0,
        dragStartY: 0,
        dragMoved: 0,
        prevMouseX: 0,
        prevMouseY: 0,
        inertiaVX: 0,
        inertiaVY: 0,
        particles: [],
        ambientParticles: [],
        particleAnimId: null,
        autoRotating: false,
        autoRotateId: null,
        shakeX: 0,
        shakeY: 0,
        totalSpeed: 0,
        burstParticles: null,
        faceHighlightTimeout: null,
        focusLocked: false,
        cubeIndex: 0,
        switching: false,
        // 开关代际守卫：openCube/closeCube 递增，退场动画迟到的 done 校验代际未变才执行
        // （参照 main.js _modalGen 模式：关闭后快速重开不被迟到的 done 隐藏/取消渲染循环）
        openGen: 0,
        // 每个 cube 的轮盘过渡状态：位移/缩放，由 applyCubeTransform 统一应用。
        // 注意不能做透明度渐变：opacity < 1 会强制 preserve-3d 扁平化，cube 会塌成面片
        cubeOffsets: [{ x: 0, y: 0, s: 1 }, { x: 0, y: 0, s: 1 }]
    };

    function buildCubeIcon(iconEl) {
        if (!iconEl || iconEl.querySelector('.cube-icon-inner')) return;
        var faces = ['front', 'back', 'right', 'left', 'top', 'bottom'];
        var inner = document.createElement('div');
        inner.className = 'cube-icon-inner';
        for (var f = 0; f < faces.length; f++) {
            var face = document.createElement('div');
            face.className = 'cube-icon-face ci-' + faces[f];
            var corners = ['ictl', 'ictr', 'icbl', 'icbr'];
            for (var k = 0; k < corners.length; k++) {
                var cor = document.createElement('div');
                cor.className = 'cube-icon-corner ' + corners[k];
                face.appendChild(cor);
            }
            inner.appendChild(face);
        }
        iconEl.appendChild(inner);
        iconEl.addEventListener('click', function(e) {
            e.stopPropagation();
            openCube();
        });
    }

    function init(onNavigate) {
        _onNavigate = onNavigate;
        buildCubeIcon(document.getElementById('cubeIcon'));
        buildCubeIcon(document.getElementById('moduleCubeIcon'));

        var backdrop = document.getElementById('cubeBackdrop');
        if (backdrop) {
            backdrop.addEventListener('click', function() {
                closeCube();
            });
        }
        var prevBtn = document.getElementById('cubeNavPrev');
        var nextBtn = document.getElementById('cubeNavNext');
        if (prevBtn) {
            prevBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                switchCube(-1);
            });
        }
        if (nextBtn) {
            nextBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                switchCube(1);
            });
        }
        var sceneEl = document.getElementById('cubeScene');
        if (sceneEl) {
            sceneEl.addEventListener('click', function(e) {
                if (e.target === sceneEl && cubeState.dragMoved < 5) {
                    closeCube();
                }
            });
        }

        var faces2 = document.querySelectorAll('.cube-face');
        for (var i = 0; i < faces2.length; i++) {
            (function(faceEl) {
                var tag = '';
                if (faceEl.classList.contains('cube-face-front')) tag = 'FRONT';
                else if (faceEl.classList.contains('cube-face-back')) tag = 'BACK';
                else if (faceEl.classList.contains('cube-face-right')) tag = 'RIGHT';
                else if (faceEl.classList.contains('cube-face-left')) tag = 'LEFT';
                else if (faceEl.classList.contains('cube-face-top')) tag = 'TOP';
                else if (faceEl.classList.contains('cube-face-bottom')) tag = 'BOTTOM';
                faceEl.setAttribute('data-face-tag', tag);

                var scanline = document.createElement('div');
                scanline.className = 'cube-face-scanline';
                faceEl.appendChild(scanline);

                var count = 6 + Math.floor(Math.random() * 7);
                for (var j = 0; j < count; j++) {
                    var inlay = document.createElement('span');
                    inlay.className = 'cube-inlay';
                    var s = 3 + Math.floor(Math.random() * 5);
                    var l = 12 + Math.random() * 250;
                    var t = 12 + Math.random() * 250;
                    var cx = 150, cy = 150;
                    while (Math.abs(l + s / 2 - cx) < 50 && Math.abs(t + s / 2 - cy) < 30) {
                        l = 12 + Math.random() * 250;
                        t = 12 + Math.random() * 250;
                    }
                    inlay.style.width = s + 'px';
                    inlay.style.height = s + 'px';
                    inlay.style.left = l + 'px';
                    inlay.style.top = t + 'px';
                    inlay.style.opacity = (0.15 + Math.random() * 0.4).toFixed(2);
                    faceEl.appendChild(inlay);
                }

                var moduleId = faceEl.getAttribute('data-module');
                if (moduleId) {
                    faceEl.addEventListener('click', function(e) {
                        if (cubeState.dragMoved > 8) return;
                        if (cubeState.focusLocked) return;
                        e.stopPropagation();
                        focusFace(faceEl, moduleId);
                    });
                }
            })(faces2[i]);
        }

        initAmbientParticles();

        var scene = document.getElementById('cubeScene');
        if (scene) {
            scene.addEventListener('mousedown', function(e) {
                if (!cubeState.active) return;
                cubeState.dragging = true;
                cubeState.dragStartX = e.clientX;
                cubeState.dragStartY = e.clientY;
                cubeState.dragMoved = 0;
                cubeState.prevMouseX = e.clientX;
                cubeState.prevMouseY = e.clientY;
                cubeState.inertiaVX = 0;
                cubeState.inertiaVY = 0;
                e.preventDefault();
            });
            window.addEventListener('mousemove', function(e) {
                if (!cubeState.active) return;
                if (cubeState.dragging) {
                    var dx = e.clientX - cubeState.prevMouseX;
                    var dy = e.clientY - cubeState.prevMouseY;
                    // 拖拽判定按「净位移」：起点在 mousedown 时记录一次；若每帧把它重置为
                    // 当前坐标，Math.abs(e.clientX - dragStartX) 恒为上一帧增量，
                    // dragMoved 实为累计路程：小幅回晃（右移再左移归位）也累计超标，
                    // 超过 8px 阈值后 face 点击导航失灵。改为相对 mousedown 起点的
                    // 净位移（Manhattan），并删除恒零死代码
                    //「- (cubeState.dragMoved > 0 ? 0 : 0)」与逐帧起点重置
                    cubeState.dragMoved = Math.abs(e.clientX - cubeState.dragStartX) + Math.abs(e.clientY - cubeState.dragStartY);
                    cubeState.inertiaVX = dx;
                    cubeState.inertiaVY = dy;
                    cubeState.rotateY += dx * 0.5;
                    cubeState.rotateX -= dy * 0.5;
                    cubeState.prevMouseX = e.clientX;
                    cubeState.prevMouseY = e.clientY;
                    applyCubeTransform();
                }
                for (var ap = 0; ap < cubeState.ambientParticles.length; ap++) {
                    var apObj = cubeState.ambientParticles[ap];
                    var adx = e.clientX - apObj.screenX;
                    var ady = e.clientY - apObj.screenY;
                    var adist = Math.sqrt(adx * adx + ady * ady);
                    if (adist < 120 && adist > 0) {
                        var force = (1 - adist / 120) * 0.8;
                        apObj.fx += (adx / adist) * force;
                        apObj.fy += (ady / adist) * force;
                    }
                }
            });
            window.addEventListener('mouseup', function() {
                if (!cubeState.dragging) return;
                cubeState.dragging = false;
            });
            scene.addEventListener('wheel', function(e) {
                if (!cubeState.active) return;
                e.preventDefault();
                cubeState.cubeScale -= e.deltaY * 0.001;
                cubeState.cubeScale = Math.max(0.4, Math.min(3, cubeState.cubeScale));
                var wrap2 = document.getElementById('cubeScaleWrap');
                if (wrap2) wrap2.style.transform = 'scale3d(' + cubeState.cubeScale + ',' + cubeState.cubeScale + ',' + cubeState.cubeScale + ')';
                applyCubeTransform();
            }, { passive: false });
        }

        var particlesCanvas = document.getElementById('cubeParticles');
        if (particlesCanvas) {
            particlesCanvas.width = window.innerWidth;
            particlesCanvas.height = window.innerHeight;
            window.addEventListener('resize', function() {
                particlesCanvas.width = window.innerWidth;
                particlesCanvas.height = window.innerHeight;
            });
        }
    }

    function initAmbientParticles() {
        cubeState.ambientParticles = [];
        for (var i = 0; i < 45; i++) {
            cubeState.ambientParticles.push({
                x: (Math.random() - 0.5) * 600,
                y: (Math.random() - 0.5) * 600,
                z: (Math.random() - 0.5) * 400,
                screenX: 0,
                screenY: 0,
                vx: (Math.random() - 0.5) * 0.4,
                vy: (Math.random() - 0.5) * 0.3,
                vz: (Math.random() - 0.5) * 0.2,
                fx: 0,
                fy: 0,
                baseSize: 0.4 + Math.random() * 0.8,
                opacity: 0.18 + Math.random() * 0.4
            });
        }
    }

    function drawAxes() {
        var canvas = document.getElementById('cubeAxes');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        var cx = 14, cy = canvas.height - 14;
        var len = 30;
        var rxRad = -cubeState.rotateX * Math.PI / 180;
        var ryRad = cubeState.rotateY * Math.PI / 180;
        var cosY = Math.cos(ryRad), sinY = Math.sin(ryRad);
        var cosX = Math.cos(rxRad), sinX = Math.sin(rxRad);
        function project(ax, ay, az) {
            var rnx = ax * cosY + az * sinY;
            var rnz = -ax * sinY + az * cosY;
            var rny = ay * cosX - rnz * sinX;
            var rnz2 = ay * sinX + rnz * cosX;
            var s = 400 / (400 + rnz2 + 60) * cubeState.cubeScale;
            return { x: cx + rnx * s, y: cy - rny * s };
        }
        var axes = [
            { ax: 1, ay: 0, az: 0, label: 'X' },
            { ax: 0, ay: 1, az: 0, label: 'Y' },
            { ax: 0, ay: 0, az: 1, label: 'Z' }
        ];
        var colors = ['rgba(251,191,36,.45)', 'rgba(251,191,36,.55)', 'rgba(251,191,36,.7)'];
        for (var i = 0; i < axes.length; i++) {
            var p = project(axes[i].ax * len, axes[i].ay * len, axes[i].az * len);
            ctx.strokeStyle = colors[i];
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            ctx.fillStyle = colors[i];
            ctx.globalAlpha = 0.75;
            ctx.font = '8px monospace';
            ctx.fillText(axes[i].label, p.x + 4, p.y + 3);
        }
        ctx.globalAlpha = 1;
    }

    var CUBE_ROOT_IDS = ['cubeRoot', 'cubeRoot2'];

    function forEachCubeRoot(fn) {
        for (var i = 0; i < CUBE_ROOT_IDS.length; i++) {
            var el = document.getElementById(CUBE_ROOT_IDS[i]);
            if (el) fn(el);
        }
    }

    function updateCubeIndicator() {
        var ind = document.getElementById('cubeNavIndicator');
        if (ind) ind.textContent = 'CUBE ' + (cubeState.cubeIndex + 1) + '/' + CUBE_ROOT_IDS.length;
    }

    function setActiveCube(index) {
        var total = CUBE_ROOT_IDS.length;
        cubeState.cubeIndex = ((index % total) + total) % total;
        for (var i = 0; i < total; i++) {
            var el = document.getElementById(CUBE_ROOT_IDS[i]);
            if (!el) continue;
            el.classList.toggle('cube-root-hidden', i !== cubeState.cubeIndex);
            var off = cubeState.cubeOffsets[i];
            off.x = 0; off.y = 0; off.s = 1;
        }
        updateCubeIndicator();
    }

    // 对单个 cube 内所有 face/wire 设置透明度。
    // 注意不能在整个 cube-root（preserve-3d 根）上做 opacity 渐变：
    // opacity < 1 会强制根扁平化，cube 会塌成面片。逐 face 设置则各面仍保留
    // 各自的 translateZ 3D 位置，根结构不受影响，可安全实现渐隐/渐显。
    function setCubeRootOpacity(rootEl, opacity) {
        if (!rootEl) return;
        var els = rootEl.querySelectorAll('.cube-face, .cube-wire-face');
        for (var i = 0; i < els.length; i++) {
            els[i].style.opacity = opacity;
        }
    }

    // 左右滑屏式切换：两个 cube 同时触发、同一缓动等速联动，
    // 间距恒定为画外距离，不会相撞；新 cube 落定带轻微弹性。
    // 同时旧 cube 逐 face 渐隐、新 cube 逐 face 渐显，避免缩小后直接消失。
    function switchCube(dir) {
        if (!cubeState.active || cubeState.switching) return;
        var total = CUBE_ROOT_IDS.length;
        var fromIdx = cubeState.cubeIndex;
        var toIdx = ((fromIdx + dir) % total + total) % total;
        if (fromIdx === toIdx) return;
        var fromEl = document.getElementById(CUBE_ROOT_IDS[fromIdx]);
        var toEl = document.getElementById(CUBE_ROOT_IDS[toIdx]);
        cubeState.switching = true;
        cubeState.cubeIndex = toIdx;
        updateCubeIndicator();

        // 移出画外所需距离：半屏宽 + cube 半宽 + 余量
        var offX = Math.round(window.innerWidth / 2 + 250);
        var exitX = dir > 0 ? -offX : offX;
        var fromOff = cubeState.cubeOffsets[fromIdx];
        var toOff = cubeState.cubeOffsets[toIdx];

        var finish = function() {
            if (fromEl) fromEl.classList.add('cube-root-hidden');
            fromOff.x = 0; fromOff.y = 0; fromOff.s = 1;
            toOff.x = 0; toOff.y = 0; toOff.s = 1;
            setCubeRootOpacity(fromEl, 1);
            setCubeRootOpacity(toEl, 1);
            cubeState.switching = false;
            applyCubeTransform();
        };

        if (typeof anime !== 'undefined' && fromEl && toEl) {
            toEl.classList.remove('cube-root-hidden');
            toOff.x = -exitX;
            // 新 cube 先逐 face 隐藏，随滑入渐显
            setCubeRootOpacity(toEl, 0);
            applyCubeTransform();
            var doneCount = 0;
            var onOneDone = function() {
                doneCount++;
                if (doneCount >= 2) finish();
            };
            anime({
                targets: fromOff,
                x: exitX,
                duration: 700,
                easing: 'easeOutElastic(0.7, 0.8)',
                update: applyCubeTransform,
                complete: onOneDone
            });
            anime({
                targets: toOff,
                x: 0,
                duration: 700,
                easing: 'easeOutElastic(0.7, 0.8)',
                update: applyCubeTransform,
                complete: onOneDone
            });
            // 旧 cube 渐隐、新 cube 渐显（逐 face，避免整体渐变塌陷）
            anime({ targets: fromEl.querySelectorAll('.cube-face, .cube-wire-face'), opacity: 0, duration: 380, easing: 'easeInCubic' });
            anime({ targets: toEl.querySelectorAll('.cube-face, .cube-wire-face'), opacity: 1, duration: 380, easing: 'easeOutCubic' });
        } else {
            if (fromEl) fromEl.classList.add('cube-root-hidden');
            if (toEl) toEl.classList.remove('cube-root-hidden');
            finish();
        }
    }

    function applyCubeTransform() {
        for (var ci = 0; ci < CUBE_ROOT_IDS.length; ci++) {
            var root = document.getElementById(CUBE_ROOT_IDS[ci]);
            if (!root) continue;
            var off = cubeState.cubeOffsets[ci];
            root.style.transform = 'translate(' + off.x + 'px, ' + off.y + 'px) rotateX(' + cubeState.rotateX + 'deg) rotateY(' + cubeState.rotateY + 'deg) scale(' + off.s + ')';
        }
        var bgRoot = document.getElementById('cubeBgRoot');
        if (bgRoot) {
            bgRoot.style.transform = 'translate(0, 0) rotateX(' + cubeState.rotateX + 'deg) rotateY(' + cubeState.rotateY + 'deg) scale3d(' + cubeState.cubeScale + ',' + cubeState.cubeScale + ',' + cubeState.cubeScale + ')';
        }
        var angle = document.getElementById('cubeHudAngle');
        if (angle) {
            angle.innerHTML = 'SPIN: ' + cubeState.totalSpeed.toFixed(1) + '&deg;/s &nbsp; X:' + Math.round(cubeState.rotateX) + '&deg; Y:' + Math.round(cubeState.rotateY) + '&deg; &nbsp; ZOOM:' + cubeState.cubeScale.toFixed(1) + 'x';
        }
        drawAxes();
    }

    function applySceneShake() {
        var scene = document.getElementById('cubeScene');
        if (!scene || !cubeState.active) return;
        var maxShake = 6;
        var intensity = Math.min(cubeState.totalSpeed / 60, 1);
        intensity = Math.pow(intensity, 1.4);
        var shakeAmt = intensity * maxShake;
        cubeState.shakeX = (Math.random() - 0.5) * shakeAmt * 2;
        cubeState.shakeY = (Math.random() - 0.5) * shakeAmt * 2;
        var hudEl = document.querySelector('.cube-deco-frame');
        if (hudEl) {
            var hudShakeX = (Math.random() - 0.5) * shakeAmt * 1.6;
            var hudShakeY = (Math.random() - 0.5) * shakeAmt * 1.6;
            hudEl.style.transform = 'translate(' + hudShakeX + 'px, ' + hudShakeY + 'px)';
        }
    }

    function particleLoop() {
        // cube 未激活时不渲染，避免弹窗关闭后仍消耗 GPU
        if (!cubeState.active) {
            console.log('[cube粒子] active=false, 停止渲染循环');
            cubeState.particleAnimId = null;
            return;
        }
        var canvas = document.getElementById('cubeParticles');
        var ctx = canvas ? canvas.getContext('2d') : null;
        if (!ctx) {
            cubeState.particleAnimId = requestAnimationFrame(particleLoop);
            return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        var cx = canvas.width / 2;
        var cy = canvas.height / 2;
        var persp = 900;

        // 旋转矩阵对所有粒子相同，提到循环外避免重复计算
        var rxRad = cubeState.rotateX * Math.PI / 180;
        var ryRad = -cubeState.rotateY * Math.PI / 180;
        var cosY = Math.cos(ryRad), sinY = Math.sin(ryRad);
        var cosX = Math.cos(rxRad), sinX = Math.sin(rxRad);

        for (var a = 0; a < cubeState.ambientParticles.length; a++) {
            var ap = cubeState.ambientParticles[a];
            ap.x += ap.vx + ap.fx * 0.6;
            ap.y += ap.vy + ap.fy * 0.6;
            ap.z += ap.vz;
            if (ap.x > 300) { ap.x = -300; ap.fx = 0; }
            if (ap.x < -300) { ap.x = 300; ap.fx = 0; }
            if (ap.y > 300) { ap.y = -300; ap.fy = 0; }
            if (ap.y < -300) { ap.y = 300; ap.fy = 0; }
            if (ap.z > 200) ap.z = -200;
            if (ap.z < -200) ap.z = 200;
            ap.fx *= 0.92;
            ap.fy *= 0.92;
            var rnx = ap.x * cosY + ap.z * sinY;
            var rnz = -ap.x * sinY + ap.z * cosY;
            var rny = ap.y * cosX - rnz * sinX;
            var rnz2 = ap.y * sinX + rnz * cosX;
            var scale = persp / (persp + rnz2);
            ap.screenX = cx + rnx * scale * cubeState.cubeScale;
            ap.screenY = cy - rny * scale * cubeState.cubeScale;
            var sz = ap.baseSize * scale * cubeState.cubeScale;
            ctx.fillStyle = '#fbbf24';
            ctx.globalAlpha = ap.opacity * (0.35 + 0.65 * scale);
            ctx.beginPath();
            ctx.arc(ap.screenX, ap.screenY, sz, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = ap.opacity * 0.3 * scale;
            ctx.beginPath();
            ctx.arc(ap.screenX, ap.screenY, sz * 2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        cubeState.particleAnimId = requestAnimationFrame(particleLoop);
    }

    function cubeMainLoop() {
        if (!cubeState.active) return;
        var paused = cubeState.dragging || cubeState.focusLocked;
        if (!paused) {
            if (cubeState.inertiaVX !== 0 || cubeState.inertiaVY !== 0) {
                cubeState.rotateY += cubeState.inertiaVX * 0.5;
                cubeState.rotateX -= cubeState.inertiaVY * 0.5;
                cubeState.inertiaVX *= 0.94;
                cubeState.inertiaVY *= 0.94;
                if (Math.abs(cubeState.inertiaVX) < 0.03) cubeState.inertiaVX = 0;
                if (Math.abs(cubeState.inertiaVY) < 0.03) cubeState.inertiaVY = 0;
                applyCubeTransform();
            }
        }
        var speedX = cubeState.autoRotating && !paused ? 0.08 + Math.abs(cubeState.inertiaVY) * 0.4 : 0;
        var speedY = cubeState.autoRotating && !paused ? 0.14 + Math.abs(cubeState.inertiaVX) * 0.4 : 0;
        if (!paused) {
            if (speedX || speedY) {
                cubeState.rotateX += speedX;
                cubeState.rotateY += speedY;
                applyCubeTransform();
            }
        }
        cubeState.totalSpeed = Math.sqrt(speedX * speedX + speedY * speedY + (cubeState.inertiaVX * 0.5) * (cubeState.inertiaVX * 0.5) + (cubeState.inertiaVY * 0.5) * (cubeState.inertiaVY * 0.5)) * 60;
        if (typeof aeCubeSpinUpdate === 'function') aeCubeSpinUpdate(cubeState.focusLocked ? 0 : cubeState.totalSpeed);
        applySceneShake();
        cubeState.autoRotateId = requestAnimationFrame(cubeMainLoop);
    }

    function startAutoRotate() {
        if (cubeState.autoRotating) return;
        cubeState.autoRotating = true;
        cubeState.autoRotateId = requestAnimationFrame(cubeMainLoop);
    }

    function stopAutoRotate() {
        cubeState.autoRotating = false;
        if (cubeState.autoRotateId) {
            cancelAnimationFrame(cubeState.autoRotateId);
            cubeState.autoRotateId = null;
        }
    }

    function openCube() {
        var modal = document.getElementById('cubeModal');
        if (!modal) return;
        // 递增代际：使在途的关闭退场动画 done 失效（350ms 内快速重开场景）
        cubeState.openGen = (cubeState.openGen || 0) + 1;
        if (typeof aeCubeOpen === 'function') aeCubeOpen();
        if (typeof aeCubeSpinStart === 'function') aeCubeSpinStart();
        cubeState.active = true;
        cubeState.inertiaVX = 0;
        cubeState.inertiaVY = 0;
        cubeState.totalSpeed = 0;
        cubeState.shakeX = 0;
        cubeState.shakeY = 0;
        cubeState.cubeScale = 1;
        cubeState.focusLocked = false;
        // 作废旧会话遗留的 focus 收尾定时器：关闭退场 350ms 内快速重开时，
        // closeCube.done 被代际守卫跳过、不会清理它，迟到的回调会关闭新会话并触发过期导航
        if (cubeState.faceHighlightTimeout) {
            clearTimeout(cubeState.faceHighlightTimeout);
            cubeState.faceHighlightTimeout = null;
        }
        modal.style.opacity = '0';
        modal.style.display = 'flex';
        modal.classList.add('active');

        /* 背景模糊淡入：backdrop 默认就 blur+深色，用 opacity 过渡 */
        var backdrop = document.getElementById('cubeBackdrop');
        if (backdrop) backdrop.classList.add('blurred');

        startAutoRotate();
        var wrap = document.getElementById('cubeScaleWrap');

        forEachCubeRoot(function(root) {
            root.style.transform = 'translate(0, 0) rotateX(-25deg) rotateY(45deg)';
        });
        cubeState.rotateX = -25;
        cubeState.rotateY = 45;
        setActiveCube(0);
        if (wrap) wrap.style.transform = 'scale3d(0.3,0.3,0.3)';
        var angle = document.getElementById('cubeHudAngle');
        if (angle) angle.innerHTML = 'SPIN: 0.0&deg;/s &nbsp; X:-25&deg; Y:45&deg; &nbsp; ZOOM:1.0x';

        initAmbientParticles();

        if (typeof anime !== 'undefined') {
            // 整个 modal UI 淡入（透明度加在 modal 上不会影响 cube 的 preserve-3d）
            anime({
                targets: modal,
                opacity: [0, 1],
                duration: 450,
                easing: 'easeOutCubic'
            });
            if (wrap) {
                requestAnimationFrame(function() {
                    var scaleProxy = { v: 0.3 };
                    anime({
                        targets: scaleProxy,
                        v: [0.3, 1],
                        duration: 900,
                        easing: 'easeOutElastic(1, .6)',
                        update: function() {
                            cubeState.cubeScale = scaleProxy.v;
                            wrap.style.transform = 'scale3d(' + scaleProxy.v + ',' + scaleProxy.v + ',' + scaleProxy.v + ')';
                        },
                        complete: function() {
                            cubeState.cubeScale = 1;
                            wrap.style.transform = 'scale3d(1,1,1)';
                        }
                    });
                });
            }
        } else {
            modal.style.opacity = '1';
            if (wrap) {
                wrap.style.transform = 'scale3d(1,1,1)';
                wrap.style.transition = 'transform .9s cubic-bezier(0, .6, .35, 1.2)';
            }
        }

        var canvas = document.getElementById('cubeParticles');
        if (canvas) {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        }
        if (!cubeState.particleAnimId) particleLoop();

        var faces = document.querySelectorAll('.cube-face');
        for (var i = 0; i < faces.length; i++) {
            faces[i].classList.add('glitching');
        }
    }

    function closeCube(onComplete) {
        var modal = document.getElementById('cubeModal');
        if (!modal) return;
        // 递增代际并捕获：done 执行时校验代际未变（期间被重新 openCube 则放弃收尾）
        var gen = cubeState.openGen = (cubeState.openGen || 0) + 1;
        if (typeof aeBeep === 'function') aeBeep('close');
        if (typeof aeCubeSpinStop === 'function') aeCubeSpinStop();
        // 面聚焦 600ms 高亮定时器在入口立即撤销：若延到 done()（350ms
        // 关闭动画之后），手动取消发生在等待窗后段（>250ms）时超时先触发，第二次
        // closeCube（携带 navigate 回调）照常执行并导航，取消意图被覆盖
        if (cubeState.faceHighlightTimeout) { clearTimeout(cubeState.faceHighlightTimeout); cubeState.faceHighlightTimeout = null; }
        cubeState.active = false;
        stopAutoRotate();
        cubeState.inertiaVX = 0;
        cubeState.inertiaVY = 0;
        cubeState.totalSpeed = 0;
        var wrap = document.getElementById('cubeScaleWrap');

        /* 背景模糊淡出：与 modal 淡出同步 */
        var backdrop = document.getElementById('cubeBackdrop');
        if (backdrop) backdrop.classList.remove('blurred');

        var done = function() {
            // 代际守卫：关闭退场动画期间被重新 openCube（350ms 内快速重开）时，
            // 本代关闭流程作废——不得 display='none' 隐藏新会话、也不得取消新启动的渲染循环
            if (cubeState.openGen !== gen) return;
            modal.style.display = 'none';
            modal.classList.remove('active');
            cubeState.ambientParticles = [];
            // 停止 cube 粒子渲染循环
            if (cubeState.particleAnimId) {
                cancelAnimationFrame(cubeState.particleAnimId);
                cubeState.particleAnimId = null;
            }
            var faces = document.querySelectorAll('.cube-face');
            for (var i = 0; i < faces.length; i++) {
                faces[i].classList.remove('glitching', 'cube-face-focused', 'cube-face-focused-glow');
            }
            cubeState.focusLocked = false;
            modal.style.opacity = '';
            forEachCubeRoot(function(root) {
                root.style.transform = 'translate(0, 0) rotateX(-25deg) rotateY(45deg)';
                root.style.transition = '';
            });
            if (wrap) { wrap.style.transform = 'scale3d(1,1,1)'; wrap.style.transition = ''; }
            var scene = document.getElementById('cubeScene');
            if (scene) scene.style.transform = '';
            var hudEl = document.querySelector('.cube-deco-frame');
            if (hudEl) hudEl.style.transform = '';
            if (cubeState.faceHighlightTimeout) { clearTimeout(cubeState.faceHighlightTimeout); cubeState.faceHighlightTimeout = null; }
            if (typeof onComplete === 'function') onComplete();
        };

        if (typeof anime !== 'undefined' && wrap) {
            var scaleOutProxy = { v: cubeState.cubeScale };
            anime({
                targets: scaleOutProxy,
                v: [cubeState.cubeScale, 0.3],
                duration: 350,
                easing: 'easeInCubic',
                update: function() {
                    wrap.style.transform = 'scale3d(' + scaleOutProxy.v + ',' + scaleOutProxy.v + ',' + scaleOutProxy.v + ')';
                },
                complete: done
            });
            anime({
                targets: modal,
                opacity: [1, 0],
                duration: 320,
                easing: 'easeInCubic'
            });
        } else {
            if (wrap) {
                wrap.style.transition = 'transform .35s cubic-bezier(.5,0,.8,1)';
                wrap.style.transform = 'scale3d(0.3,0.3,0.3)';
            }
            modal.style.opacity = '0';
            setTimeout(done, 350);
        }
    }

    function focusFace(faceEl, moduleId) {
        if (typeof aeCubeEnter === 'function') aeCubeEnter();
        faceEl.classList.add('cube-face-focused');
        cubeState.focusLocked = true;

        var tag = faceEl.getAttribute('data-face-tag') || '';
        var targetX = cubeState.rotateX;
        var targetY = cubeState.rotateY;
        if (tag === 'FRONT') { targetX = 0; targetY = 0; }
        else if (tag === 'BACK') { targetX = 0; targetY = 180; }
        else if (tag === 'RIGHT') { targetX = 0; targetY = -90; }
        else if (tag === 'LEFT') { targetX = 0; targetY = 90; }
        else if (tag === 'TOP') { targetX = -90; }
        else if (tag === 'BOTTOM') { targetX = 90; }

        var startX = cubeState.rotateX;
        var startY = cubeState.rotateY;
        var curScale = cubeState.cubeScale;
        var wrap = document.getElementById('cubeScaleWrap');

        if (typeof anime !== 'undefined') {
            var rotProxy = { rx: startX, ry: startY };
            var highlighted = false;
            requestAnimationFrame(function() {
                if (wrap) {
                    var scaleProxy2 = { v: curScale };
                    anime({
                        targets: scaleProxy2,
                        v: [curScale, curScale * 0.82, curScale],
                        duration: 900,
                        easing: 'easeOutElastic(1, .45)',
                        update: function() {
                            cubeState.cubeScale = scaleProxy2.v;
                            wrap.style.transform = 'scale3d(' + scaleProxy2.v + ',' + scaleProxy2.v + ',' + scaleProxy2.v + ')';
                        },
                        complete: function() {
                            cubeState.cubeScale = curScale;
                            wrap.style.transform = 'scale3d(' + curScale + ',' + curScale + ',' + curScale + ')';
                        }
                    });
                }
                anime({
                    targets: rotProxy,
                    rx: [startX, targetX],
                    ry: [startY, targetY],
                    duration: 900,
                    easing: 'easeOutElastic(1, .4)',
                    update: function() {
                        cubeState.rotateX = rotProxy.rx;
                        cubeState.rotateY = rotProxy.ry;
                        applyCubeTransform();
                        if (!highlighted && Math.abs(rotProxy.rx - targetX) < 8 && Math.abs(rotProxy.ry - targetY) < 8) {
                            highlighted = true;
                            faceEl.classList.add('cube-face-focused-glow');
                        }
                    },
                    complete: function() {
                        cubeState.rotateX = targetX;
                        cubeState.rotateY = targetY;
                        applyCubeTransform();
                        faceEl.classList.add('cube-face-focused-glow');
                        cubeState.faceHighlightTimeout = setTimeout(function() {
                            closeCube(function() {
                                if (typeof _onNavigate === 'function') _onNavigate(moduleId);
                            });
                        }, 600);
                    }
                });
            });
        } else {
            cubeState.rotateX = targetX;
            cubeState.rotateY = targetY;
            applyCubeTransform();
            faceEl.classList.add('cube-face-focused-glow');
            cubeState.faceHighlightTimeout = setTimeout(function() {
                closeCube(function() {
                    if (typeof _onNavigate === 'function') _onNavigate(moduleId);
                });
            }, 600);
        }
    }

    global.AECube = { init: init, open: openCube, close: closeCube };
})(window);
