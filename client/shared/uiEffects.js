(function (global) {
    // UI 效果门面：统一封装动画调用入口，
    // 避免业务层直接依赖全局动画函数实现细节。
    function createUiEffects() {
        return {
            // 触发面板入场动画。
            // 当全局 animatePanelsIn 不可用时静默降级，保证流程不中断。
            animatePanelsIn() {
                if (typeof global.animatePanelsIn === 'function') {
                    global.animatePanelsIn();
                }
            }
        };
    }

    // 导出 UI 效果工厂到 shared 命名空间。
    global.AEShared = global.AEShared || {};
    global.AEShared.createUiEffects = createUiEffects;

    // 共享 AudioContext，避免每次调用创建新实例导致资源耗尽
    var _sharedAudioCtx = null;
    function _getAudioCtx() {
        if (!_sharedAudioCtx) {
            _sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        return _sharedAudioCtx;
    }

    // 主限幅器：所有音效经此节点再输出，防止多音效叠加或 bug 导致爆音。
    // threshold=-6dB 以下原样通过，超过即硬压（ratio=20, knee=0），相当于 brickwall limiter。
    var _masterLimiter = null;
    function _getMaster() {
        if (!_masterLimiter) {
            var ctx = _getAudioCtx();
            _masterLimiter = ctx.createDynamicsCompressor();
            _masterLimiter.threshold.value = -6;
            _masterLimiter.knee.value = 0;
            _masterLimiter.ratio.value = 20;
            _masterLimiter.attack.value = 0.001;
            _masterLimiter.release.value = 0.1;
            _masterLimiter.connect(ctx.destination);
        }
        return _masterLimiter;
    }

    // 共享混响：短房间卷积，为启用 reverb 的音效增加空间感。惰性创建，全套复用。
    var _reverb = null;
    function _getReverb() {
        if (!_reverb) {
            var ctx = _getAudioCtx();
            var conv = ctx.createConvolver();
            var rate = ctx.sampleRate;
            var len = Math.floor(rate * 1.6);
            var imp = ctx.createBuffer(2, len, rate);
            for (var ch = 0; ch < 2; ch++) {
                var data = imp.getChannelData(ch);
                for (var i = 0; i < len; i++) {
                    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.6);
                }
            }
            conv.buffer = imp;
            var wet = ctx.createGain();
            wet.gain.value = 0.25;
            conv.connect(wet);
            wet.connect(_getMaster());
            _reverb = { input: conv, wet: wet };
        }
        return _reverb;
    }

    // 共享延迟回声：带反馈的延时，为启用 delay 的音效增加空灵回响。惰性创建，全套复用。
    var _delayFx = null;
    function _getDelay() {
        if (!_delayFx) {
            var ctx = _getAudioCtx();
            var d = ctx.createDelay(1.0);
            d.delayTime.value = 0.18;
            var wet = ctx.createGain();
            wet.gain.value = 0.4;
            var fb = ctx.createGain();
            fb.gain.value = 0.25;
            d.connect(wet);
            wet.connect(_getMaster());
            wet.connect(fb);
            fb.connect(d);
            _delayFx = { input: d, wet: wet };
        }
        return _delayFx;
    }

    // 音效定义表：每种类型指定波形、频率序列、音量、时长、间隔。
    // slide=true 时用单个振荡器做频率滑动（开合/发送），否则逐频率连响（提示/成功/错误）。
    var _soundDef = {
        warn:    { wave: 'sine',   freqs: [800, 800],   vol: 0.35, dur: 0.12, gap: 0.05 },
        soft:    { wave: 'sine',   freqs: [520],         vol: 0.18, dur: 0.10, gap: 0 },
        // 中性信息提示：单音柔和"叮"，介于 soft 与 toggle 之间的轻量反馈
        info:    { wave: 'sine',   freqs: [660],         vol: 0.12, dur: 0.09, gap: 0 },
        success: { wave: 'sine',   freqs: [523, 784],    vol: 0.20, dur: 0.09, gap: 0.04 },
        error:   { wave: 'triangle', freqs: [440, 311],  vol: 0.18, dur: 0.12, gap: 0.04 },
        toggle:  { wave: 'sine',   freqs: [600],         vol: 0.10, dur: 0.04, gap: 0 },
        open:    { wave: 'sine',   freqs: [440, 660],    vol: 0.12, dur: 0.10, gap: 0, slide: true },
        close:   { wave: 'sine',   freqs: [660, 440],    vol: 0.12, dur: 0.10, gap: 0, slide: true },
        send:    { wave: 'sine',   freqs: [400, 880],    vol: 0.12, dur: 0.08, gap: 0, slide: true },
        receive: { wave: 'sine',   freqs: [659, 880],    vol: 0.15, dur: 0.08, gap: 0.04 },
        // LLM 工作完成提醒：C 大调明亮上行三音 C5-E5-G5，配混响+延迟营造空间感
        done:    { wave: 'sine',   freqs: [523, 659, 784], vol: 0.18, dur: 0.12, gap: 0.05, reverb: true, delay: true },
        // Konami Code 彩蛋：8-bit 方波上行 C 大调琶音，致敬红白机音色
        konami:  { wave: 'square', freqs: [523, 659, 784, 1047, 1319], vol: 0.14, dur: 0.11, gap: 0.03 },
        // NERV 彩蛋 — 高频双音警报（增四度 tritone，恶魔音程）
        nerv:    { wave: 'sawtooth', freqs: [880, 622, 880, 622], vol: 0.14, dur: 0.16, gap: 0.06 },
        // 危险操作弹窗：低频双声"噔噔"报错音（比 error 更重更低更闷），警示确认前先给听觉反馈
        danger:  { wave: 'triangle', freqs: [330, 294], vol: 0.4, dur: 0.18, gap: 0.08 },
        // NERV 彩蛋 — 低频下滑贝斯 drone，与 nerv 叠加营造压迫感
        nervBass:{ wave: 'sawtooth', freqs: [110, 55], vol: 0.18, dur: 0.7, gap: 0, slide: true }
    };

    // 读取全局音量设置（0~1），未设置时默认为 1
    function _getVol() {
        var v = global.__aeSoundVolume;
        return (typeof v === 'number' && v >= 0 && v <= 1) ? v : 1;
    }

    // 统一音效入口：type 为 _soundDef 的键名，未知类型回退到 'soft'，静默失败。
    function aeBeep(type) {
        try {
            var volMul = _getVol();
            if (volMul === 0) return;
            // 取消待播放的按钮 tick：具体音效优先，避免叠加
            if (_btnTickTimer) { clearTimeout(_btnTickTimer); _btnTickTimer = null; }
            var def = _soundDef[type || 'soft'] || _soundDef.soft;
            var ctx = _getAudioCtx();
            var vol = def.vol * volMul;

            if (def.slide) {
                // 单振荡器频率滑动（开合弹窗 / 发送消息）
                var t = ctx.currentTime;
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.type = def.wave;
                osc.frequency.setValueAtTime(def.freqs[0], t);
                osc.frequency.linearRampToValueAtTime(def.freqs[def.freqs.length - 1], t + def.dur);
                gain.gain.setValueAtTime(vol, t);
                gain.gain.exponentialRampToValueAtTime(0.001, t + def.dur);
                osc.connect(gain);
                gain.connect(_getMaster());
                osc.start(t);
                osc.stop(t + def.dur);
            } else {
                // 逐频率连响（提示 / 成功 / 错误 / 开关）
                for (var i = 0; i < def.freqs.length; i++) {
                    var ti = ctx.currentTime + i * (def.dur + def.gap);
                    var osc2 = ctx.createOscillator();
                    var gain2 = ctx.createGain();
                    osc2.type = def.wave;
                    osc2.frequency.value = def.freqs[i];
                    gain2.gain.setValueAtTime(vol, ti);
                    gain2.gain.exponentialRampToValueAtTime(0.001, ti + def.dur);
                    osc2.connect(gain2);
                    gain2.connect(_getMaster());
                    // 效果：启用混响/延迟的音效（如 done）同步送入对应效果节点，其余音效不受影响
                    if (def.reverb) gain2.connect(_getReverb().input);
                    if (def.delay) gain2.connect(_getDelay().input);
                    osc2.start(ti);
                    osc2.stop(ti + def.dur);
                }
            }
        } catch (_) {}
    }
    global.aeBeep = aeBeep;

    // 老虎机滚动音效：快速短促的 blip 序列，逐渐减速，最后一响稍重表示落定。
    // 用于思考等级 / 权限等级的点击循环切换。
    function aeSlotSpin() {
        try {
            var volMul = _getVol();
            if (volMul === 0) return;
            if (_btnTickTimer) { clearTimeout(_btnTickTimer); _btnTickTimer = null; }
            var ctx = _getAudioCtx();
            var vol = 0.10 * volMul;
            var dur = 0.015;
            var gaps = [0.025, 0.03, 0.04, 0.05, 0.07];
            var t = ctx.currentTime;
            for (var i = 0; i <= gaps.length; i++) {
                var ti = t;
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = 900;
                gain.gain.setValueAtTime(i === gaps.length ? vol * 1.5 : vol, ti);
                gain.gain.exponentialRampToValueAtTime(0.001, ti + dur);
                osc.connect(gain);
                gain.connect(_getMaster());
                osc.start(ti);
                osc.stop(ti + dur);
                if (i < gaps.length) t += gaps[i] + dur;
            }
        } catch (_) {}
    }
    global.aeSlotSpin = aeSlotSpin;

    // Cube 导航开启音效：短促激活 click + 上升扫频，营造科技 portal 开启感。
    function aeCubeOpen() {
        try {
            var volMul = _getVol();
            if (volMul === 0) return;
            if (_btnTickTimer) { clearTimeout(_btnTickTimer); _btnTickTimer = null; }
            var ctx = _getAudioCtx();
            var t = ctx.currentTime;
            // 激活 click
            var osc1 = ctx.createOscillator();
            var gain1 = ctx.createGain();
            osc1.type = 'sine';
            osc1.frequency.value = 1200;
            gain1.gain.setValueAtTime(0.10 * volMul, t);
            gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
            osc1.connect(gain1);
            gain1.connect(_getMaster());
            osc1.start(t);
            osc1.stop(t + 0.02);
            // 上升扫频
            var osc2 = ctx.createOscillator();
            var gain2 = ctx.createGain();
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(300, t + 0.02);
            osc2.frequency.exponentialRampToValueAtTime(900, t + 0.20);
            gain2.gain.setValueAtTime(0.15 * volMul, t + 0.02);
            gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.20);
            osc2.connect(gain2);
            gain2.connect(_getMaster());
            osc2.start(t + 0.02);
            osc2.stop(t + 0.20);
        } catch (_) {}
    }
    global.aeCubeOpen = aeCubeOpen;

    // Cube 旋转风声：白噪声 -> 带通滤波器 -> 增益，速度越快风声越大越高。
    var _spinNoise = null, _spinFilter = null, _spinGain = null;
    var _noiseBuffer = null;
    var SPIN_SPEED_MAX = 200;

    function _getNoiseBuffer() {
        if (_noiseBuffer) return _noiseBuffer;
        var ctx = _getAudioCtx();
        var len = ctx.sampleRate * 2;
        _noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
        var data = _noiseBuffer.getChannelData(0);
        for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        return _noiseBuffer;
    }

    function aeCubeSpinStart() {
        try {
            if (_spinNoise) return;
            var volMul = _getVol();
            if (volMul === 0) return;
            var ctx = _getAudioCtx();
            _spinNoise = ctx.createBufferSource();
            _spinNoise.buffer = _getNoiseBuffer();
            _spinNoise.loop = true;
            _spinFilter = ctx.createBiquadFilter();
            _spinFilter.type = 'lowpass';
            _spinFilter.frequency.value = 200;
            _spinFilter.Q.value = 1.0;
            _spinGain = ctx.createGain();
            _spinGain.gain.value = 0;
            _spinNoise.connect(_spinFilter);
            _spinFilter.connect(_spinGain);
            _spinGain.connect(_getMaster());
            _spinNoise.start();
        } catch (_) {}
    }

    function aeCubeSpinUpdate(speed) {
        try {
            if (!_spinNoise || !_spinGain || !_spinFilter) return;
            var volMul = _getVol();
            if (volMul === 0) return;
            var ratio = Math.min(speed / SPIN_SPEED_MAX, 1);
            var ctx = _getAudioCtx();
            var t = ctx.currentTime;
            // 风声：低通截止频率随速度上移（200->600Hz），Q 略降使高速更开阔
            _spinGain.gain.setTargetAtTime(ratio * 0.12 * volMul, t, 0.06);
            _spinFilter.frequency.setTargetAtTime(200 + ratio * 400, t, 0.06);
            _spinFilter.Q.setTargetAtTime(1.0 - ratio * 0.4, t, 0.06);
        } catch (_) {}
    }

    function aeCubeSpinStop() {
        try {
            if (!_spinNoise) return;
            var ctx = _getAudioCtx();
            _spinGain.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
            var src = _spinNoise;
            setTimeout(function () {
                try { src.stop(); } catch (_) {}
            }, 120);
            _spinNoise = null;
            _spinFilter = null;
            _spinGain = null;
        } catch (_) {}
    }

    // Cube 点击面进入模块音效：上升扫频 + 短促定音，"锁定目标"感。
    function aeCubeEnter() {
        try {
            var volMul = _getVol();
            if (volMul === 0) return;
            if (_btnTickTimer) { clearTimeout(_btnTickTimer); _btnTickTimer = null; }
            var ctx = _getAudioCtx();
            var t = ctx.currentTime;
            // 上升扫频
            var osc1 = ctx.createOscillator();
            var gain1 = ctx.createGain();
            osc1.type = 'sine';
            osc1.frequency.setValueAtTime(600, t);
            osc1.frequency.exponentialRampToValueAtTime(1200, t + 0.12);
            gain1.gain.setValueAtTime(0.12 * volMul, t);
            gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
            osc1.connect(gain1);
            gain1.connect(_getMaster());
            osc1.start(t);
            osc1.stop(t + 0.15);
        } catch (_) {}
    }
    global.aeCubeEnter = aeCubeEnter;
    global.aeCubeSpinStart = aeCubeSpinStart;
    global.aeCubeSpinUpdate = aeCubeSpinUpdate;
    global.aeCubeSpinStop = aeCubeSpinStop;

    // 音量蓄力音效：长按音量标识时的持续上升音。
    // 音量随蓄力进度 c(0~1) 越来越大、音高越来越高，形成"越蓄越强"的蓄力感。
    var _charge = null;
    function aeChargeStart() {
        try {
            if (_charge) return;
            var volMul = _getVol();
            if (volMul === 0) return;
            var ctx = _getAudioCtx();
            var osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = 260;
            var gain = ctx.createGain();
            gain.gain.value = 0.0001;
            osc.connect(gain);
            gain.connect(_getMaster());
            osc.start();
            _charge = { osc: osc, gain: gain, ctx: ctx };
        } catch (_) {}
    }

    function aeChargeUpdate(c) {
        try {
            if (!_charge) return;
            var volMul = _getVol();
            var t = _charge.ctx.currentTime;
            // 音量随蓄力平方增长（越到后面越响），音高同步上升
            _charge.gain.gain.setTargetAtTime(0.0001 + c * c * 0.20 * volMul, t, 0.04);
            _charge.osc.frequency.setTargetAtTime(260 + c * 320, t, 0.06);
        } catch (_) {}
    }

    function aeChargeStop() {
        try {
            if (!_charge) return;
            var t = _charge.ctx.currentTime;
            _charge.gain.gain.setTargetAtTime(0.0001, t, 0.03);
            var o = _charge.osc;
            setTimeout(function () { try { o.stop(); } catch (_) {} }, 120);
            _charge = null;
        } catch (_) {}
    }
    global.aeChargeStart = aeChargeStart;
    global.aeChargeUpdate = aeChargeUpdate;
    global.aeChargeStop = aeChargeStop;

    // 全局面板按钮点击音效：超短轻触，静默失败
    // 延迟 15ms 播放：若期间 aeBeep() 被调用（按钮触发了更具体的音效），
    // 则取消 tick，避免两个音效叠加。
    var _btnTickTimer = null;
    function _btnTick() {
        if (_btnTickTimer) return;
        _btnTickTimer = setTimeout(function () {
            _btnTickTimer = null;
            try {
                var volMul = _getVol();
                if (volMul === 0) return;
                var ctx = _getAudioCtx();
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = 1200;
                gain.gain.setValueAtTime(0.08 * volMul, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);
                osc.connect(gain);
                gain.connect(_getMaster());
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.03);
            } catch (_) {}
        }, 15);
    }

    document.addEventListener('click', function (e) {
        var el = e.target;
        if (!el || !el.tagName || typeof el.closest !== 'function') return;
        // 用 closest 向上查找：点击卡片的子元素（标题/描述等）也能命中
        var clickable = el.closest(
            'button, a, input[type="button"], input[type="submit"], ' +
            '.btn, .context-menu-item, .module-card, [role="button"], ' +
            '.ng-menu-item, .session-menu-item, .qb-item, .qb-folder-row'
        );
        if (clickable) _btnTick();
    }, true);

    // 全局开关切换音效：监听 .switch-input 复选框的 change 事件，静默失败
    document.addEventListener('change', function (e) {
        var el = e.target;
        if (!el || el.tagName.toLowerCase() !== 'input' || el.type !== 'checkbox') return;
        if (el.classList && el.classList.contains('switch-input')) {
            aeBeep('toggle');
        }
    }, true);
})(window);
