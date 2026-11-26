// quickBarPreview.js — 快速执行栏条目的悬停缩略图浮层
// 视频与图像序列循环播放；图片、预设、工程素材显示静态预览图。
// 视频解码失败时走素材库同一条转码链（AEAssetsShared.transcodeMov）：产物名与缓存键都由
// transcodeOutputPath 决定，同一源文件在素材库与本浮层之间命中同一份缓存，不重复转码。
// 自动转码开关与限宽读同一份模块设置（AEAssetsShared.autoTranscodeEnabled /
// transcodeMaxWidth）。浮层挂在 body 上（.qb-panel 是 overflow:hidden，挂在里面会被裁掉），
// 同一时刻只保留一个播放器，移出、滚动、列表重建、关栏都销毁。
(function (global) {
    'use strict';

    var HOVER_DELAY_MS = 250;      // 停留多久才弹（快速划过不闪）
    var SEQ_FRAME_MS = 80;         // 序列帧 12.5fps，与素材库详情预览同值
    var PANEL_WIDTH_PX = 176;
    var PANEL_GAP_PX = 8;
    var PANEL_EST_HEIGHT_PX = 128; // offsetHeight 读不到时的高度兜底（浮层已入布局但尚无尺寸）

    var _root = null;
    var _mediaEl = null;
    var _captionEl = null;
    var _statusEl = null;
    var _listEl = null;
    var _resolveItem = null;
    var _bound = null;
    var _hoverRow = null;
    var _mouseX = null;   // 悬停行的鼠标水平位置（两种摆位都以它为水平锚点）
    var _mouseY = null;   // 悬停行的鼠标垂直位置（上方放不下时浮层顶边从这里往下让）
    var _delayTimer = null;
    var _active = null;   // { kind, token, video?, img?, seqTimer?, frames?, idx?, transcoding? }
    var _token = 0;

    function _dataDir() {
        try {
            if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                return global.AEShared.getDataDir().dir || '';
            }
        } catch (_) {}
        return '';
    }

    function _fileUrl(p) {
        if (!p) return '';
        var toUrl = global.AEShared && global.AEShared.toFileUrl;
        return (typeof toUrl === 'function') ? toUrl(p) : String(p);
    }

    function _autoTranscodeEnabled() {
        var S = global.AEAssetsShared;
        if (S && typeof S.autoTranscodeEnabled === 'function') return S.autoTranscodeEnabled();
        try { return localStorage.getItem('assets.autoTranscode') !== '0'; } catch (_) { return true; }
    }

    function _transcodeMaxWidth() {
        var S = global.AEAssetsShared;
        if (S && typeof S.transcodeMaxWidth === 'function') return S.transcodeMaxWidth();
        var maxWidth = 854;
        try {
            var mw = localStorage.getItem('assets.transcodeMaxWidth');
            if (mw != null) { var p = parseInt(mw, 10); if (!isNaN(p)) maxWidth = p; }
        } catch (_) {}
        return maxWidth;
    }

    function init() {
        if (_root || !global.document || !document.body) return;
        _root = document.createElement('div');
        _root.id = 'quickBarPreview';
        _root.className = 'qb-preview';
        _mediaEl = document.createElement('div');
        _mediaEl.className = 'qb-preview-media';
        _captionEl = document.createElement('div');
        _captionEl.className = 'qb-preview-caption';
        _root.appendChild(_mediaEl);
        _root.appendChild(_captionEl);
        document.body.appendChild(_root);
    }

    function _cancelDelay() {
        if (_delayTimer) { try { clearTimeout(_delayTimer); } catch (_) {} }
        _delayTimer = null;
    }

    function _closestItem(el) {
        if (!el || typeof el.closest !== 'function') return null;
        return el.closest('.qb-item');
    }

    function _clearMedia() {
        var a = _active;
        _active = null;
        if (!a) return;
        if (a.seqTimer) { try { clearTimeout(a.seqTimer); } catch (_) {} }
        if (a.video) {
            try { a.video.pause(); } catch (_) {}
            try { a.video.removeAttribute('src'); } catch (_) {}
            if (typeof a.video.load === 'function') { try { a.video.load(); } catch (_) {} }
        }
        if (_mediaEl) _mediaEl.innerHTML = '';
        _statusEl = null;
    }

    function hide() {
        _hoverRow = null;
        _cancelDelay();
        _token++;
        _clearMedia();
        if (_root && _root.classList) _root.classList.remove('qb-preview-visible');
        if (_captionEl) _captionEl.textContent = '';
    }

    function _showStatus(text) {
        if (!_mediaEl) return;
        if (!_statusEl) {
            _statusEl = document.createElement('div');
            _statusEl.className = 'qb-preview-status';
        }
        _statusEl.textContent = text || '';
        if (_statusEl.parentNode !== _mediaEl) _mediaEl.appendChild(_statusEl);
    }

    function _hideStatus() {
        if (_statusEl && _statusEl.parentNode) _statusEl.parentNode.removeChild(_statusEl);
        _statusEl = null;
    }

    function _position(row) {
        if (!_root || !row || typeof row.getBoundingClientRect !== 'function') return;
        var rect = row.getBoundingClientRect();
        var vw = global.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
        var vh = global.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
        var width = PANEL_WIDTH_PX;
        var height = _root.offsetHeight || PANEL_EST_HEIGHT_PX;
        // 两种摆位都以鼠标为锚点：上方时底边在鼠标上方，下方时顶边在鼠标下方；水平居中于鼠标。
        var anchorX = (_mouseX == null) ? (rect.left + rect.width / 2) : _mouseX;
        var anchorY = (_mouseY == null) ? rect.bottom : _mouseY;
        var left = anchorX - width / 2;
        var top = rect.top - height - PANEL_GAP_PX;
        if (top < 4) {
            // 上方放不下 → 鼠标下方（顶边距鼠标 8px），不再放右侧。
            top = anchorY + PANEL_GAP_PX;
        }
        if (left < 4) left = 4;
        if (vw && left + width > vw - 4) left = vw - width - 4;
        // 视口比浮层还窄时上面的右夹取会算出负值：保左缘可见（宁可右侧溢出也不移出视口）
        if (left < 4) left = 4;
        if (top < 4) top = 4;
        if (vh && top + height > vh - 4) top = vh - height - 4;
        // 视口比浮层还矮时同上：保顶部可见
        if (top < 4) top = 4;
        _root.style.left = Math.round(left) + 'px';
        _root.style.top = Math.round(top) + 'px';
    }

    function _showImage(url, token) {
        if (!url || !_mediaEl) return false;
        var img = document.createElement('img');
        img.className = 'qb-preview-img';
        img.alt = '';
        img.addEventListener('error', function () {
            if (_active && _active.token === token) hide();
        });
        _active = { kind: 'image', token: token, img: img };
        _mediaEl.appendChild(img);
        img.src = url;
        return true;
    }

    function _transcode(entry, item) {
        if (_active !== entry || entry.transcoding) return;
        // 转码走中性共享出口（AEShared.transcodeVideo，与 Agent 预览等跨模块调用方同一别名）；
        // 产物名与缓存键在客户端内部唯一实现，这里不与素材库各自拼键。
        var S = global.AEShared;
        if (!S || typeof S.transcodeVideo !== 'function' || !_autoTranscodeEnabled()) {
            _showStatus(AEI18n.t('无法直接预览该视频'));
            return;
        }
        var dir = _dataDir();
        if (!dir) {
            _showStatus(AEI18n.t('无法直接预览该视频'));
            return;
        }
        entry.transcoding = true;
        var outputDir = dir.replace(/[\\\/]+$/, '') + '/temp/transcoded';
        _showStatus(AEI18n.t('转码中…'));
        var pending;
        try {
            pending = S.transcodeVideo(item.path, outputDir, function (p) {
                if (_active !== entry) return;
                if (p && p.status === 'running') _showStatus(AEI18n.t('转码中…'));
            }, _transcodeMaxWidth());
        } catch (e) {
            _showStatus(AEI18n.t('无法直接预览该视频'));
            return;
        }
        if (!pending || typeof pending.then !== 'function') {
            _showStatus(AEI18n.t('无法直接预览该视频'));
            return;
        }
        pending.then(function (webmPath) {
            if (_active !== entry || !webmPath) return;
            entry.transcoding = false;
            entry.transcoded = true;
            entry.video.src = _fileUrl(webmPath);
            try {
                var pr = entry.video.play();
                if (pr && typeof pr.catch === 'function') pr.catch(function () {});
            } catch (_) {}
        }).catch(function () {
            if (_active !== entry) return;
            _showStatus(AEI18n.t('无法直接预览该视频'));
        });
    }

    function _showVideo(url, item, token) {
        if (!url || !_mediaEl) return false;
        var v = document.createElement('video');
        v.className = 'qb-preview-video';
        v.muted = true;
        v.loop = true;
        v.autoplay = true;
        v.setAttribute('muted', '');
        v.setAttribute('playsinline', '');
        v.setAttribute('preload', 'auto');
        var entry = { kind: 'video', token: token, video: v };
        _active = entry;
        var unplayable = function () {
            if (_active !== entry) return;
            _hideStatus();
            // 转码产物仍解不出：再转也是同一份缓存，只报提示，不再进转码链
            if (entry.transcoded) { _showStatus(AEI18n.t('无法直接预览该视频')); return; }
            _transcode(entry, item);
        };
        v.addEventListener('error', unplayable);
        v.addEventListener('loadedmetadata', function () {
            if (v.videoWidth === 0) unplayable();
        });
        v.addEventListener('loadeddata', function () {
            if (_active !== entry) return;
            _hideStatus();
        });
        _mediaEl.appendChild(v);
        v.src = url;
        try {
            var pr = v.play();
            if (pr && typeof pr.catch === 'function') pr.catch(function () {});
        } catch (_) {}
        return true;
    }

    function _seqTick(entry) {
        if (_active !== entry) return;
        var img = entry.img;
        if (!img || img.isConnected === false) { hide(); return; }
        if (!entry.frames || !entry.frames.length) return;
        entry.idx = (entry.idx + 1) % entry.frames.length;
        try { img.src = entry.frames[entry.idx]; } catch (_) { hide(); return; }
        entry.seqTimer = setTimeout(function () { _seqTick(entry); }, SEQ_FRAME_MS);
    }

    function _showSequence(item, token) {
        if (!_mediaEl) return false;
        var img = document.createElement('img');
        img.className = 'qb-preview-img';
        img.alt = '';
        img.addEventListener('error', function () {
            if (_active && _active.token === token) hide();
        });
        var entry = { kind: 'sequence', token: token, img: img, frames: [], idx: 0, seqTimer: null };
        _active = entry;
        _mediaEl.appendChild(img);
        img.src = _fileUrl(item.path);

        var S = global.AEAssetsShared;
        // 共享推导按素材库记录字段取键（originalPath / sequence），快速执行栏条目是
        // path / meta.sequence，这里只做字段映射，规则仍走同一份实现。
        var meta = (S && typeof S.sequenceMetaFromItem === 'function')
            ? S.sequenceMetaFromItem({
                originalPath: item.path,
                sequence: item.meta && item.meta.sequence
            }) : null;
        if (!meta || !S || typeof S.sequenceFrameUrls !== 'function') return true;   // 首帧静态
        Promise.resolve(S.sequenceFrameUrls(meta)).then(function (frames) {
            if (_active !== entry || !frames || frames.length < 2) return;
            entry.frames = frames;
            entry.seqTimer = setTimeout(function () { _seqTick(entry); }, SEQ_FRAME_MS);
        }).catch(function () {});
        return true;
    }

    function _show(row, item) {
        if (!_root) init();
        if (!_root || !_mediaEl) return;
        hide();
        _hoverRow = row;
        _captionEl.textContent = item.name || '';
        _position(row);
        var token = _token;
        _root.classList.add('qb-preview-visible');

        var shown = false;
        var meta = item.meta || {};
        // 条目文件缺失：任何类型都不弹（预设/工程素材的预览帧可能仍在，但条目本身已不可用）
        if (meta.missing) { hide(); return; }
        if (item.type === 'ref') {
            if (meta.mediaType === 'video') {
                shown = _showVideo(_fileUrl(item.path), item, token);
            } else if (meta.mediaType === 'image') {
                shown = meta.sequence
                    ? _showSequence(item, token)
                    : _showImage(_fileUrl(item.path), token);
            }
        } else if (item.type === 'preset' || item.type === 'project') {
            if (meta.previewUrl) shown = _showImage(meta.previewUrl, token);
        }
        if (!shown) hide();
    }

    function _schedule(row) {
        _cancelDelay();
        var id = row.getAttribute('data-id');
        if (!id) return;
        _delayTimer = setTimeout(function () {
            _delayTimer = null;
            if (_hoverRow !== row) return;
            var item = _resolveItem ? _resolveItem(id) : null;
            if (item) _show(row, item);
        }, HOVER_DELAY_MS);
    }

    function _onMouseOver(e) {
        var row = _closestItem(e.target);
        if (!row || row === _hoverRow) return;
        // 进入行时先取一次坐标：鼠标随即停住不再产生 mousemove 时，定位也有正确锚点。
        // 事件不带数值坐标时置空，让 _position 回落到行中心/行底（不沿用上一行的坐标）。
        _mouseX = (typeof e.clientX === 'number') ? e.clientX : null;
        _mouseY = (typeof e.clientY === 'number') ? e.clientY : null;
        _hoverRow = row;
        _schedule(row);
    }

    function _onMouseMove(e) {
        if (typeof e.clientX === 'number') _mouseX = e.clientX;
        if (typeof e.clientY === 'number') _mouseY = e.clientY;
    }

    function _onMouseOut(e) {
        var row = _closestItem(e.target);
        if (!row || row !== _hoverRow) return;
        var to = e.relatedTarget;
        if (to && typeof row.contains === 'function' && row.contains(to)) return;
        hide();
    }

    function _onListLeave() {
        hide();
    }

    function _onScroll() {
        hide();
    }

    function _onResize() {
        hide();
    }

    function unbind() {
        if (!_bound || !_listEl) return;
        _listEl.removeEventListener('mouseover', _bound.mouseover);
        _listEl.removeEventListener('mouseout', _bound.mouseout);
        _listEl.removeEventListener('mousemove', _bound.mousemove);
        _listEl.removeEventListener('mouseleave', _bound.mouseleave);
        _listEl.removeEventListener('scroll', _bound.scroll);
        if (typeof global.removeEventListener === 'function') {
            global.removeEventListener('resize', _bound.resize);
        }
        _bound = null;
        _listEl = null;
        hide();
    }

    // listEl：条目列表容器（事件委托，虚拟滚动重建 innerHTML 不影响绑定）；
    // resolveItem(id)：按条目 id 取扫描结果对象（由入口模块提供，浮层不读入口状态）。
    function bindList(listEl, resolveItem) {
        if (_listEl === listEl && _resolveItem === resolveItem) return;
        init();
        unbind();
        if (!listEl || typeof listEl.addEventListener !== 'function') return;
        _listEl = listEl;
        _resolveItem = resolveItem || null;
        _bound = {
            mouseover: _onMouseOver,
            mouseout: _onMouseOut,
            mousemove: _onMouseMove,
            mouseleave: _onListLeave,
            scroll: _onScroll,
            resize: _onResize
        };
        listEl.addEventListener('mouseover', _bound.mouseover);
        listEl.addEventListener('mouseout', _bound.mouseout);
        listEl.addEventListener('mousemove', _bound.mousemove);
        listEl.addEventListener('mouseleave', _bound.mouseleave);
        listEl.addEventListener('scroll', _bound.scroll);
        // 面板/窗口尺寸变化后 fixed 坐标停在旧视口，直接收起（与滚动同口径）。
        if (typeof global.addEventListener === 'function') {
            global.addEventListener('resize', _bound.resize);
        }
    }

    global.AEQuickBarPreview = global.AEQuickBarPreview || {};
    global.AEQuickBarPreview.init = init;
    global.AEQuickBarPreview.bindList = bindList;
    global.AEQuickBarPreview.unbind = unbind;
    global.AEQuickBarPreview.hide = hide;
    global.AEQuickBarPreview.HOVER_DELAY_MS = HOVER_DELAY_MS;
    global.AEQuickBarPreview.SEQ_FRAME_MS = SEQ_FRAME_MS;
})(window);
