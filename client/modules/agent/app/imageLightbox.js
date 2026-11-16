// 图片 Lightbox（点击放大、拖拽拖动、滚轮缩放、双击复位）
// 从 app/main.js 拆出：完全自包含，无外部依赖
(function (global) {
    var _imgLb = null, _imgLbImg = null, _imgLbScale = 1, _imgLbTarget = 1, _imgLbAnim = null;
    var _imgLbPanX = 0, _imgLbPanY = 0, _imgLbDrag = false, _imgLbMoved = false;
    var _imgLbDSX = 0, _imgLbDSY = 0, _imgLbPSX = 0, _imgLbPSY = 0;
    var _imgLbVX = 0, _imgLbVY = 0, _imgLbLX = 0, _imgLbLY = 0, _imgLbLT = 0, _imgLbIn = null, _imgLbCloseTmr = 0;
    var _imgLbEscHandler = null;

    function _imgLbApply() {
        if (!_imgLbImg) return;
        _imgLbImg.style.transform = 'translate(' + _imgLbPanX + 'px,' + _imgLbPanY + 'px) scale(' + _imgLbScale + ')';
    }
    function _imgLbStop() {
        if (_imgLbIn) { cancelAnimationFrame(_imgLbIn); _imgLbIn = null; }
        if (_imgLbAnim) { cancelAnimationFrame(_imgLbAnim); _imgLbAnim = null; }
    }
    function _imgLbAnimate() {
        _imgLbAnim = null;
        var d = _imgLbTarget - _imgLbScale;
        if (Math.abs(d) < 0.001) { _imgLbScale = _imgLbTarget; _imgLbApply(); return; }
        _imgLbScale += d * 0.25;
        _imgLbApply();
        _imgLbAnim = requestAnimationFrame(_imgLbAnimate);
    }
    function _imgLbSetScale(v) {
        _imgLbTarget = Math.max(0.15, Math.min(8, v));
        if (!_imgLbAnim) _imgLbAnim = requestAnimationFrame(_imgLbAnimate);
    }
    function _imgLbInertia() {
        _imgLbStop();
        var f = 0.92;
        (function step() {
            _imgLbVX *= f; _imgLbVY *= f;
            if (Math.abs(_imgLbVX) < 0.3 && Math.abs(_imgLbVY) < 0.3) { _imgLbVX = 0; _imgLbVY = 0; _imgLbIn = null; return; }
            _imgLbPanX += _imgLbVX; _imgLbPanY += _imgLbVY;
            _imgLbApply();
            _imgLbIn = requestAnimationFrame(step);
        })();
    }
    function _imgLbEnsure() {
        if (_imgLb) return;
        _imgLb = document.createElement('div');
        _imgLb.className = 'ae-agent-lightbox';
        _imgLbImg = document.createElement('img');
        _imgLbImg.draggable = false;
        _imgLbImg.className = 'ae-agent-lightbox-img';
        _imgLb.appendChild(_imgLbImg);
        document.body.appendChild(_imgLb);

        _imgLb.addEventListener('click', function(e) { if (!_imgLbMoved && e.target === _imgLb) _imgLbClose(); });
        _imgLb.addEventListener('wheel', function(e) {
            e.preventDefault();
            var ns = _imgLbTarget + (e.deltaY > 0 ? -0.3 : 0.3);
            var r = _imgLbImg.getBoundingClientRect();
            var mx = e.clientX - (r.left + r.width / 2), my = e.clientY - (r.top + r.height / 2);
            var ratio = ns / _imgLbScale;
            _imgLbPanX -= mx * (ratio - 1);
            _imgLbPanY -= my * (ratio - 1);
            _imgLbSetScale(ns);
        });
        _imgLbImg.addEventListener('mousedown', function(e) {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            _imgLbStop();
            _imgLbDrag = true; _imgLbMoved = false;
            _imgLbDSX = e.clientX; _imgLbDSY = e.clientY;
            _imgLbPSX = _imgLbPanX; _imgLbPSY = _imgLbPanY;
            _imgLbLX = e.clientX; _imgLbLY = e.clientY; _imgLbLT = Date.now();
            _imgLbVX = 0; _imgLbVY = 0;
            _imgLbImg.style.cursor = 'grabbing';
            _imgLbImg.style.transition = 'none';
        });
        _imgLbImg.addEventListener('click', function(e) { if (!_imgLbMoved) _imgLbClose(); });
        window.addEventListener('mousemove', function(e) {
            if (!_imgLbDrag) return;
            var dx = e.clientX - _imgLbDSX, dy = e.clientY - _imgLbDSY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) _imgLbMoved = true;
            var now = Date.now(), dt = Math.max(1, now - _imgLbLT);
            _imgLbPanX = _imgLbPSX + dx;
            _imgLbPanY = _imgLbPSY + dy;
            _imgLbVX = (e.clientX - _imgLbLX) / dt * 16;
            _imgLbVY = (e.clientY - _imgLbLY) / dt * 16;
            _imgLbLX = e.clientX; _imgLbLY = e.clientY; _imgLbLT = now;
            _imgLbApply();
        });
        window.addEventListener('mouseup', function() {
            if (!_imgLbDrag) return;
            _imgLbDrag = false;
            _imgLbImg.style.cursor = 'grab';
            _imgLbImg.style.transition = 'transform .15s ease-out';
            if (Math.abs(_imgLbVX) > 0.5 || Math.abs(_imgLbVY) > 0.5) _imgLbInertia();
        });
        _imgLb.addEventListener('dblclick', function(e) {
            if (e.target === _imgLbImg) {
                _imgLbStop();
                _imgLbScale = 1; _imgLbTarget = 1; _imgLbPanX = 0; _imgLbPanY = 0;
                _imgLbApply();
            }
        });
        _imgLbEscHandler = function(e) {
            if (e.key === 'Escape') _imgLbClose();
        };
    }
    function _open(src) {
        if (_imgLbCloseTmr) { clearTimeout(_imgLbCloseTmr); _imgLbCloseTmr = 0; }
        _imgLbEnsure();
        _imgLbStop();
        _imgLbScale = 1; _imgLbTarget = 1; _imgLbPanX = 0; _imgLbPanY = 0; _imgLbVX = 0; _imgLbVY = 0;
        _imgLbImg.src = src;
        _imgLbImg.style.transition = 'transform .15s ease-out';
        _imgLbApply();
        _imgLb.style.display = 'flex';
        _imgLb.style.opacity = '0';
        _imgLb.style.background = 'rgba(0,0,0,0.92)';
        if (_imgLbEscHandler) window.addEventListener('keydown', _imgLbEscHandler);
        requestAnimationFrame(function() { _imgLb.style.opacity = '1'; });
    }
    function _imgLbClose() {
        if (!_imgLb) return;
        _imgLbStop();
        if (_imgLbEscHandler) window.removeEventListener('keydown', _imgLbEscHandler);
        _imgLb.style.opacity = '0';
        if (_imgLbCloseTmr) clearTimeout(_imgLbCloseTmr);
        _imgLbCloseTmr = setTimeout(function() {
            _imgLbCloseTmr = 0;
            if (_imgLb) { _imgLb.style.display = 'none'; _imgLbImg.src = ''; _imgLbScale = 1; _imgLbPanX = 0; _imgLbPanY = 0; }
        }, 200);
    }

    global._openImageLightbox = _open;
    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.imageLightbox = { open: _open };
})(window);
