(function (global) {
    function shouldEnableParticles() {
        return true;
    }

    // 页面可见性变化时暂停/恢复粒子渲染，避免后台浪费 GPU
    function _handleVisibilityChange(state, rafTick, cancelRafTick) {
        if (document.hidden) {
            if (state.rafId) {
                cancelRafTick(state.rafId);
                state.rafId = 0;
            }
        } else {
            if (state.running && !state.rafId) {
                state.lastTs = 0;
                renderParticleFrame({
                    state: state,
                    window: global,
                    ts: Date.now(),
                    rafTick: rafTick,
                    cancelRafTick: cancelRafTick,
                    showStatus: function () {},
                    reportParticleDiagnostics: function () {}
                });
            }
        }
    }

    function initParticleCanvasStage(options) {
        const state = options && options.state;
        const doc = (options && options.document) || global.document;
        if (!state || !doc) {
            return false;
        }

        const stage = doc.getElementById('chatInputParticleStage') || doc.getElementById('previewParticleStage');
        const interactionTarget = doc.getElementById('aeAgentInputWrap') || doc.getElementById('scriptPreviewWrap');
        const canvas = doc.getElementById('particleCanvas');
        if (!stage || !interactionTarget || !canvas) {
            return false;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return false;
        }

        state.stage = stage;
        state.interactionTarget = interactionTarget;
        state.canvas = canvas;
        state.ctx = ctx;
        return true;
    }

    function getParticlePointerPosition(state, e) {
        if (!state || !state.stage) {
            return null;
        }
        const rect = state.stage.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }

    function bindParticlePointerInteraction(options) {
        const state = options && options.state;
        if (!state || !state.interactionTarget || state.pointerHandlers) {
            return;
        }

        const onPointerMove = (e) => {
            const pos = getParticlePointerPosition(state, e);
            if (!pos) {
                return;
            }
            state.pointerX = pos.x;
            state.pointerY = pos.y;
            state.pointerActive = true;
        };

        const onPointerLeave = () => {
            state.pointerActive = false;
            state.pointerX = -9999;
            state.pointerY = -9999;
        };

        const onPointerDown = (e) => {
            const pos = getParticlePointerPosition(state, e);
            if (!pos) {
                return;
            }
            state.pointerX = pos.x;
            state.pointerY = pos.y;
            state.pointerActive = true;
            state.pulses.push({
                x: pos.x,
                y: pos.y,
                age: 0,
                life: 0.85,
                maxRadius: 180
            });
            if (state.pulses.length > 8) {
                state.pulses.shift();
            }
        };

        state.interactionTarget.addEventListener('pointermove', onPointerMove);
        state.interactionTarget.addEventListener('pointerleave', onPointerLeave);
        state.interactionTarget.addEventListener('pointercancel', onPointerLeave);
        state.interactionTarget.addEventListener('pointerdown', onPointerDown);

        state.pointerHandlers = {
            onPointerMove,
            onPointerLeave,
            onPointerDown
        };
    }

    function unbindParticlePointerInteraction(options) {
        const state = options && options.state;
        if (!state || !state.interactionTarget || !state.pointerHandlers) {
            return;
        }

        const handlers = state.pointerHandlers;
        state.interactionTarget.removeEventListener('pointermove', handlers.onPointerMove);
        state.interactionTarget.removeEventListener('pointerleave', handlers.onPointerLeave);
        state.interactionTarget.removeEventListener('pointercancel', handlers.onPointerLeave);
        state.interactionTarget.removeEventListener('pointerdown', handlers.onPointerDown);
        state.pointerHandlers = null;
    }

    function spawnParticle(width, height) {
        return {
            x: Math.random() * width,
            y: height + Math.random() * 16,
            vx: (Math.random() - 0.5) * 0.01,
            vy: -(0.95 + Math.random() * 0.0375 / 2),
            drift: 0.5 + Math.random() * 0.125,
            swayAmp: 0.3 + Math.random() * 0.05,
            swayPhase: Math.random() * Math.PI * 1,
            r: 0.9 + Math.random() * 2.4,
            a: 0.35 + Math.random() * 0.55
        };
    }

    function buildParticleSet(count, width, height) {
        const items = [];
        for (let i = 0; i < count; i += 1) {
            const p = spawnParticle(width, height);
            p.y = Math.random() * height;
            items.push(p);
        }
        return items;
    }

    function syncParticleSetToViewport(state, width, height, expectedCount) {
        const particles = Array.isArray(state.particles) ? state.particles : [];

        if (!particles.length) {
            state.particles = buildParticleSet(expectedCount, width, height);
            return;
        }

        const currentCount = particles.length;
        if (currentCount < expectedCount) {
            for (let i = currentCount; i < expectedCount; i += 1) {
                const p = spawnParticle(width, height);
                p.y = Math.random() * height;
                particles.push(p);
            }
        } else if (currentCount > expectedCount) {
            particles.length = expectedCount;
        }

        for (let i = 0; i < particles.length; i += 1) {
            const p = particles[i];
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
                Object.assign(p, spawnParticle(width, height));
                p.y = Math.random() * height;
                continue;
            }
            p.x = Math.max(-18, Math.min(width + 18, p.x));
            p.y = Math.max(-12, Math.min(height + 18, p.y));
        }

        state.particles = particles;
    }

    function resizeParticleCanvas(options) {
        const state = options && options.state;
        const win = (options && options.window) || global;
        const forceReset = !!(options && options.forceReset);
        if (!state || !state.stage || !state.canvas || !state.ctx) {
            return false;
        }

        const rect = state.stage.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        const dpr = Math.max(1, win.devicePixelRatio || 1);

        const changed = forceReset || width !== state.lastCssWidth || height !== state.lastCssHeight || Math.abs(dpr - state.lastDpr) > 0.001;
        if (!changed) {
            return false;
        }

        state.lastCssWidth = width;
        state.lastCssHeight = height;
        state.lastDpr = dpr;

        state.canvas.width = Math.floor(width * dpr);
        state.canvas.height = Math.floor(height * dpr);
        state.canvas.style.width = `${width}px`;
        state.canvas.style.height = `${height}px`;
        state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const count = Math.max(56, Math.min(140, Math.floor((width * height) / 5000)));
        syncParticleSetToViewport(state, width, height, count);
        return true;
    }

    function reportParticleDiagnostics(options) {
        const state = options && options.state;
        const showStatus = options && options.showStatus;
        const reason = options && options.reason;
        if (!state || !state.diagnosticsEnabled) {
            return '';
        }

        const stageRect = state.stage ? state.stage.getBoundingClientRect() : null;
        const canvas = state.canvas;
        const cssW = stageRect ? Math.floor(stageRect.width) : 0;
        const cssH = stageRect ? Math.floor(stageRect.height) : 0;
        const pxW = canvas ? canvas.width : 0;
        const pxH = canvas ? canvas.height : 0;
        const msg = AEI18n.t('粒子自检 {reason} | stage:{cssW}x{cssH} canvas:{pxW}x{pxH} running:{running} n:{count}', {
            reason: reason, cssW: cssW, cssH: cssH, pxW: pxW, pxH: pxH,
            running: state.running ? 1 : 0, count: state.particles.length
        });

        if (typeof showStatus === 'function') {
            showStatus(msg, 'info', { autoHideMs: 2800 });
        }
        return msg;
    }

    function renderParticleFrame(options) {
        const state = options && options.state;
        const win = (options && options.window) || global;
        const ts = options && options.ts;
        const rafTick = options && options.rafTick;
        const cancelRafTick = options && options.cancelRafTick;
        const showStatus = options && options.showStatus;
        const report = options && options.reportParticleDiagnostics;

        if (!state || !state.running || !state.ctx || !state.canvas || typeof rafTick !== 'function' || typeof cancelRafTick !== 'function') {
            return;
        }

        const scheduleNext = () => {
            if (!state.running) {
                return;
            }
            if (state.rafId) {
                cancelRafTick(state.rafId);
                state.rafId = 0;
            }

            state.rafId = rafTick((nextTs) => {
                renderParticleFrame({
                    state,
                    window: win,
                    ts: nextTs,
                    rafTick,
                    cancelRafTick,
                    showStatus,
                    reportParticleDiagnostics: report
                });
            });
        };

        try {
            const ctx = state.ctx;
            const width = Math.max(1, Math.floor(state.canvas.clientWidth));
            const height = Math.max(1, Math.floor(state.canvas.clientHeight));

            const expectedCount = Math.max(56, Math.min(140, Math.floor((width * height) / 5000)));
            if (!state.particles || state.particles.length !== expectedCount) {
                syncParticleSetToViewport(state, width, height, expectedCount);
            }

            const frameTs = Number.isFinite(ts) ? ts : Date.now();
            if (state.running && frameTs - state.lastTs > 220) {
                resizeParticleCanvas({ state, window: win });
            }
            if (!state.lastTs) {
                state.lastTs = frameTs;
            }
            const dtRaw = (frameTs - state.lastTs) / 1000;
            const dt = Math.max(0.001, Math.min(0.05, Number.isFinite(dtRaw) ? dtRaw : 0.016));
            state.lastTs = frameTs;

            ctx.clearRect(0, 0, width, height);

            const frameScale = dt * 60;
            const pointerRadius = 124;
            const pointerRadiusSq = pointerRadius * pointerRadius;
            const activePulses = [];
            for (let i = 0; i < state.pulses.length; i += 1) {
                const pulse = state.pulses[i];
                pulse.age += dt;
                if (pulse.age < pulse.life) {
                    activePulses.push(pulse);
                }
            }
            state.pulses = activePulses;

            if (!state.firstFrameDrawn) {
                state.firstFrameDrawn = true;
                if (typeof report === 'function') {
                    report({ state, reason: AEI18n.t('首帧'), showStatus });
                }
            }

            for (let i = 0; i < state.particles.length; i += 1) {
                const p = state.particles[i];

                const sway = Math.sin((frameTs * 0.0016) + p.swayPhase) * p.swayAmp;
                const targetVx = sway;
                const targetVy = -p.drift;

                p.vx += (targetVx - p.vx) * 0.07;
                p.vy += (targetVy - p.vy) * 0.05;

                let pointerGlow = 0;
                if (state.pointerActive) {
                    const toPointerX = state.pointerX - p.x;
                    const toPointerY = state.pointerY - p.y;
                    const distSq = (toPointerX * toPointerX) + (toPointerY * toPointerY);
                    if (distSq < pointerRadiusSq && distSq > 0.01) {
                        const dist = Math.sqrt(distSq);
                        const falloff = 1 - (dist / pointerRadius);
                        const attract = 0.065 * (falloff * falloff + (0.35 * falloff)) * frameScale;
                        p.vx += (toPointerX / dist) * attract;
                        p.vy += (toPointerY / dist) * attract;
                        pointerGlow = Math.min(1, falloff * 1.25);
                    }
                }

                let pulseGlow = 0;
                for (let j = 0; j < state.pulses.length; j += 1) {
                    const pulse = state.pulses[j];
                    const progress = pulse.age / pulse.life;
                    const ringRadius = pulse.maxRadius * progress;
                    const fromPulseX = p.x - pulse.x;
                    const fromPulseY = p.y - pulse.y;
                    const pulseDist = Math.sqrt((fromPulseX * fromPulseX) + (fromPulseY * fromPulseY));
                    const ringBand = 24;
                    const ringDelta = Math.abs(pulseDist - ringRadius);
                    if (ringDelta < ringBand) {
                        const ringPower = (1 - (ringDelta / ringBand)) * (1 - progress);
                        pulseGlow = Math.max(pulseGlow, ringPower);
                        if (pulseDist > 0.01) {
                            const push = 0.64 * ringPower * frameScale;
                            p.vx += (fromPulseX / pulseDist) * push;
                            p.vy += (fromPulseY / pulseDist) * push;
                        }
                    }
                }

                p.vx = Math.max(-16, Math.min(16, p.vx));
                p.vy = Math.max(-24, Math.min(24, p.vy));
                p.x += p.vx * frameScale;
                p.y += p.vy * frameScale;

                if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.vx) || !Number.isFinite(p.vy)) {
                    Object.assign(p, spawnParticle(width, height));
                }

                if (p.y < -10 || p.x < -18 || p.x > width + 18) {
                    Object.assign(p, spawnParticle(width, height));
                }

                const glow = Math.max(pointerGlow * 0.6, pulseGlow);
                const drawRadius = p.r * (1 + (glow * 0.55));
                const drawAlpha = Math.min(1, p.a + (glow * 0.45));
                const green = Math.min(255, Math.round(220 + (glow * 30)));

                ctx.beginPath();
                ctx.fillStyle = `rgba(170, ${green}, 210, ${drawAlpha})`;
                ctx.arc(p.x, p.y, drawRadius, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.fillStyle = `rgba(200, 255, 235, ${Math.min(1, drawAlpha * 0.45)})`;
                ctx.arc(p.x, p.y, Math.max(0.7, drawRadius * 0.46), 0, Math.PI * 2);
                ctx.fill();
            }

            for (let i = 0; i < state.pulses.length; i += 1) {
                const pulse = state.pulses[i];
                const progress = pulse.age / pulse.life;
                const ringRadius = pulse.maxRadius * progress;
                const alpha = Math.max(0, 0.34 * (1 - progress));
                if (alpha <= 0) {
                    continue;
                }
                ctx.beginPath();
                ctx.lineWidth = 1.2 + (2.4 * (1 - progress));
                ctx.strokeStyle = `rgba(160, 255, 215, ${alpha})`;
                ctx.arc(pulse.x, pulse.y, ringRadius, 0, Math.PI * 2);
                ctx.stroke();
            }
        } catch (_) {
            const now = Date.now();
            if (!state.lastErrorNoticeAt || (now - state.lastErrorNoticeAt) > 1200) {
                state.lastErrorNoticeAt = now;
                if (typeof showStatus === 'function') {
                    showStatus(AEI18n.t('粒子渲染已自动恢复'), 'info', { autoHideMs: 1200 });
                }
            }
        }

        scheduleNext();
    }

    function stopParticleEngine(options) {
        const state = options && options.state;
        const cancelRafTick = options && options.cancelRafTick;
        if (!state || typeof cancelRafTick !== 'function') {
            return;
        }

        state.running = false;
        state.lastTs = 0;
        state.lastErrorNoticeAt = 0;
        state.pointerActive = false;
        state.pointerX = -9999;
        state.pointerY = -9999;
        state.pulses = [];
        unbindParticlePointerInteraction({ state });

        // 注销可见性监听
        if (state._visibilityHandler) {
            document.removeEventListener('visibilitychange', state._visibilityHandler);
            state._visibilityHandler = null;
        }

        if (state.rafId) {
            cancelRafTick(state.rafId);
            state.rafId = 0;
        }
        if (state.layoutSyncRafId) {
            cancelRafTick(state.layoutSyncRafId);
            state.layoutSyncRafId = 0;
        }
        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = 0;
        }
        // 取消挂起的启动重试，防停止后引擎被遗留重试"复活"
        if (state.startRetryTimerId) {
            clearTimeout(state.startRetryTimerId);
            state.startRetryTimerId = 0;
        }
        if (state.ctx && state.canvas) {
            state.ctx.clearRect(0, 0, state.canvas.clientWidth, state.canvas.clientHeight);
        }
    }

    function startParticleEngine(options) {
        const state = options && options.state;
        const win = (options && options.window) || global;
        const rafTick = options && options.rafTick;
        const cancelRafTick = options && options.cancelRafTick;
        const showStatus = options && options.showStatus;
        const report = options && options.reportParticleDiagnostics;

        if (!state || typeof rafTick !== 'function' || typeof cancelRafTick !== 'function') {
            return;
        }

        // 兜底：startRetryCount 不应依赖调用方初始化——未初始化时
        // `undefined += 1` 得 NaN，`NaN <= 10` 恒 false 会跳过重试直接报
        // "尺寸异常"，诊断输出"尺寸未就绪#NaN"。非有限数值一律归零重计。
        if (typeof state.startRetryCount !== 'number' || !isFinite(state.startRetryCount)) {
            state.startRetryCount = 0;
        }

        if (!initParticleCanvasStage({ state })) {
            if (typeof showStatus === 'function') {
                showStatus(AEI18n.t('粒子自检 挂载失败：找不到画布或容器'), 'error', { autoHideMs: 3200 });
            }
            return;
        }

        // 外接模式等隐藏输入区的布局：stage 祖先链 display:none（offsetParent 为 null），
        // 尺寸恒为 0、重试注定无效——静默跳过（不重试不报错），退出该模式后
        // enforcePreviewFillHeight 的 not-running 分支会自动补启，避免误报
        // 「预览区尺寸异常」错误 toast（非 fixed 定位元素 offsetParent 判 display:none 可靠）
        if (state.stage && state.stage.offsetParent === null) {
            return;
        }

        stopParticleEngine({ state, cancelRafTick });
        resizeParticleCanvas({ state, window: win, forceReset: true });

        const rect = state.stage ? state.stage.getBoundingClientRect() : null;
        const width = rect ? Math.floor(rect.width) : 0;
        const height = rect ? Math.floor(rect.height) : 0;

        if (width < 8 || height < 8) {
            state.startRetryCount += 1;
            if (typeof report === 'function') {
                report({ state, reason: AEI18n.t('尺寸未就绪#{n}', { n: state.startRetryCount }), showStatus });
            }
            if (state.startRetryCount <= 10) {
                // 重试句柄存入 state，stopParticleEngine 可 clearTimeout 取消，
                // 防停止后被遗留重试"复活"（低性能模式被绕过）；回调入口守卫拦陈旧重试。
                const retryTimerId = setTimeout(() => {
                    if (state.startRetryTimerId !== retryTimerId) return;
                    state.startRetryTimerId = 0;
                    startParticleEngine({ state, window: win, rafTick, cancelRafTick, showStatus, reportParticleDiagnostics: report });
                }, 120);
                state.startRetryTimerId = retryTimerId;
            } else if (typeof showStatus === 'function') {
                showStatus(AEI18n.t('粒子自检 失败：预览区尺寸异常'), 'error', { autoHideMs: 3600 });
            }
            return;
        }

        state.startRetryCount = 0;
        state.firstFrameDrawn = false;
        bindParticlePointerInteraction({ state });
        state.running = true;
        state.lastTs = 0;
        state.lastErrorNoticeAt = 0;
        state.timerId = 0;
        state.pulses = [];

        // 注册可见性监听，页面不可见时暂停渲染
        if (!state._visibilityHandler) {
            state._visibilityHandler = function () {
                _handleVisibilityChange(state, rafTick, cancelRafTick);
            };
            document.addEventListener('visibilitychange', state._visibilityHandler);
        }


        if (typeof report === 'function') {
            report({ state, reason: AEI18n.t('启动'), showStatus });
        }

        renderParticleFrame({
            state,
            window: win,
            ts: Date.now(),
            rafTick,
            cancelRafTick,
            showStatus,
            reportParticleDiagnostics: report
        });
    }

    function probeParticleStatus(options) {
        const state = options && options.state;
        const win = (options && options.window) || global;
        const rafTick = options && options.rafTick;
        const cancelRafTick = options && options.cancelRafTick;
        const showStatus = options && options.showStatus;
        const report = options && options.reportParticleDiagnostics;
        if (!state) {
            return;
        }

        if (!initParticleCanvasStage({ state })) {
            if (typeof showStatus === 'function') {
                showStatus(AEI18n.t('粒子自检 手动检测失败：找不到画布或容器'), 'error', { autoHideMs: 3600 });
            }
            return;
        }

        resizeParticleCanvas({ state, window: win });
        const msg = typeof report === 'function' ? report({ state, reason: AEI18n.t('手动检测'), showStatus }) : '';

        if (!state.running) {
            if (typeof showStatus === 'function') {
                showStatus(AEI18n.t('{msg} | 引擎未运行，尝试重启', { msg: msg }), 'error', { autoHideMs: 4200 });
            }
            startParticleEngine({ state, window: win, rafTick, cancelRafTick, showStatus, reportParticleDiagnostics: report });
            return;
        }

        if (!state.firstFrameDrawn) {
            if (typeof showStatus === 'function') {
                showStatus(AEI18n.t('{msg} | 已运行但尚未首帧', { msg: msg }), 'error', { autoHideMs: 4200 });
            }
            return;
        }

        if (typeof showStatus === 'function') {
            showStatus(AEI18n.t('{msg} | 状态正常', { msg: msg }), 'success', { autoHideMs: 3200 });
        }
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.particles = {
        shouldEnableParticles,
        reportParticleDiagnostics,
        probeParticleStatus,
        initParticleCanvasStage,
        bindParticlePointerInteraction,
        unbindParticlePointerInteraction,
        resizeParticleCanvas,
        renderParticleFrame,
        startParticleEngine,
        stopParticleEngine
    };
})(window);
