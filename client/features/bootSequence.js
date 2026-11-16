// bootSequence.js — 启动动画
// 进度由 bootstrap 各里程碑驱动（AEBoot.setProgress），直接反映真实初始化进度。
// bootstrap 完成后调 AEBoot.finish()，保证最小展示时长后切 phase2 → dismiss，
// 避免"初始化太快、进度条一闪而过、UI 还没出来就收起"。
(function (global) {
    'use strict';

    var _boot = null;
    var _fill = null;
    var _status = null;
    var _phase2 = null;
    var _finished = false;
    var _dismissed = false;

    var MIN_DISPLAY_MS = 900;   // 最小展示时长：从首次 setProgress 起算
    var _firstProgressAt = 0;

    function _resolve() {
        _boot = document.getElementById('bootSequence');
        if (!_boot) return false;
        _fill = document.getElementById('bootBarFill');
        _status = document.getElementById('bootStatusLine');
        var phases = _boot.querySelectorAll('.boot-phase');
        _phase2 = phases[1];
        return true;
    }

    // 设置进度（0-100）和当前步骤说明。直接更新进度条宽度。
    function setProgress(pct, label) {
        if (!_boot && !_resolve()) return;
        if (!_firstProgressAt) _firstProgressAt = Date.now();
        if (_fill) {
            _fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
        }
        if (label && _status) {
            _status.textContent = label;
        }
    }

    // bootstrap 全部完成：等满足最小展示时长后切 phase2 → dismiss
    function finish(onStaggerCard) {
        if (!_boot && !_resolve()) return;
        if (_finished) return;
        _finished = true;
        if (_fill) _fill.style.width = '100%';
        if (_status) _status.textContent = 'ALL SYSTEMS ACTIVE';

        var startAt = _firstProgressAt || Date.now();
        var elapsed = Date.now() - startAt;
        var wait = Math.max(0, MIN_DISPLAY_MS - elapsed);

        setTimeout(function () { _doFinish(onStaggerCard); }, wait);
    }

    function _doFinish(onStaggerCard) {
        if (_dismissed) return;
        setTimeout(function () {
            if (_phase2) _phase2.classList.add('active');
        }, 280);
        setTimeout(function () {
            if (_phase2) _phase2.classList.add('done');
        }, 1100);
        setTimeout(function () {
            if (_boot) _boot.classList.add('dismissed');
        }, 1380);
        setTimeout(function () {
            if (_boot) _boot.classList.add('done');
            if (typeof onStaggerCard === 'function') onStaggerCard();
            _dismissed = true;
        }, 1720);
    }

    function start(onStaggerCard) {
        // 兼容旧调用：start 等价于 finish
        finish(onStaggerCard);
    }

    // 重置内部状态，供彩蛋 bootNow 重播使用
    // 不重置 DOM 类（bootNow 自己已处理），只清模块级 _finished/_dismissed 锁
    function replay() {
        _finished = false;
        _dismissed = false;
        _firstProgressAt = 0;
    }

    global.AEBoot = {
        start: start,
        setProgress: setProgress,
        finish: finish,
        replay: replay
    };
})(window);
