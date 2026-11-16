// 视频附件预览组件（Agent 消息卡片 / 输入框 chip 共用）
//
// 背景：CEF 88 不带 HEVC/H.265 解码能力，遇到这类文件 <video> 会
// "元数据读得到、时间轴照走、画面全黑"，而且**不触发 error 事件**——只挂了 error
// 兜底，于是黑屏一路静默到底。
//
// 交互（与素材库对齐）：卡片悬停即静音预览播放，点击开 lightbox 播放
// （声音在 lightbox 里，那里用原生控件）。卡片内不再自绘控制条——竖屏视频按比例收窄后
// 卡片只有 90px 宽，那套 [播放|进度|时间|静音] 会被 overflow 裁掉，用户看到的是"静音
// 按钮不见了"。
//
// 本模块：
//   ① 判定"解不出画面"：error 事件、loadedmetadata 后 videoWidth === 0（黑屏无 error 的
//      主路径，含 300ms 复检）、播放后复查——三条路汇到同一个兜底；
//   ② 兜底转码：复用 Bridge 的 /api/ffmpeg-transcode（经 ffmpegMovPlayer.js 暴露为
//      AEShared.transcodeVideo），按预览限宽转码成 webm 缓存到 temp/transcoded，成功后换源；
//   ③ 容器宽度按视频比例反推（横屏贴宽度上限、竖屏按高度上限折算），避免"宽卡片 + 左右黑边"。
//
// 返回 { el, video, play, pause, destroy }：compact 模式给输入框 chip 的 hover 预览用
// （由调用方在 hover 时 play()/pause()），非 compact 给消息卡片用（悬停自动播放 + 点击开 lightbox）。
(function (global) {
    'use strict';

    var DEFAULT_MAX_WIDTH = 640;   // 预览转码限宽：消息卡片最宽 260px，转 4K 原片纯属浪费
    var PLAY_PROBE_MS = 1500;      // 播放后再复查一次画面是否真的解出来
    var META_RECHECK_MS = 300;     // metadata 报 0 尺寸时的复检间隔（防瞬间状态误判）
    var VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v|mkv)$/i;

    function isVideoPath(name) {
        return VIDEO_EXT_RE.test(String(name || ''));
    }

    function _toFileUrl(p) {
        if (global.AEShared && typeof global.AEShared.toFileUrl === 'function') return global.AEShared.toFileUrl(p);
        return p;
    }

    // 转码缓存目录：与素材库转码回退共用 <数据目录>/temp/transcoded——
    // ① 素材库的「清缓存」按钮扫的正是这里（tc_ 前缀 + .webm），agent 侧预览产物
    //    因而同样可被手动清理，不必再加一个入口；
    // ② temp/ 是既定的临时命名空间，agent 侧周期性清扫（AETempSweep）也按此挂载。
    // 文件名由转码客户端按 路径+限宽 哈希生成，两侧不会互相覆盖。
    function _cacheDir() {
        try {
            var dd = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                ? global.AEShared.getDataDir() : null;
            if (dd && dd.dir) return String(dd.dir).replace(/\\/g, '/').replace(/\/+$/, '') + '/temp/transcoded';
        } catch (_) {}
        return '';
    }

    // 同文件并发转码去重：Bridge 侧对同一输出路径会各起一个 ffmpeg 进程、共写同一个
    // .part 文件（产物可能互相踩坏）。同一面板里消息卡片与输入框 chip 可能同时预览
    // 同一个视频，故按 路径+限宽 共享在途 Promise，进度广播给所有订阅者。
    var _transcodeInflight = {};

    // 转码入口：不可用时返回 null（调用方直接给失败文案，不假装在转码）
    function _startTranscode(path, maxWidth, onProgress) {
        var fn = global.AEShared && global.AEShared.transcodeVideo;
        var dir = _cacheDir();
        if (typeof fn !== 'function' || !dir || !path) return null;
        var key = String(path) + '|' + (maxWidth || 0);
        var entry = _transcodeInflight[key];
        if (!entry) {
            entry = { watchers: [] };
            try {
                entry.promise = fn(path, dir, function (p) {
                    for (var i = 0; i < entry.watchers.length; i++) {
                        try { entry.watchers[i](p); } catch (_) {}
                    }
                }, maxWidth || 0);
                // 转码客户端约定返回 Promise；返回空/非 thenable 时按不可用处理，
                // 不把"不确定的对象"当任务用（调用方据此走失败文案）
                if (!entry.promise || typeof entry.promise.then !== 'function') return null;
            } catch (_) {
                return null;
            }
            _transcodeInflight[key] = entry;
            var _cleanup = function () { delete _transcodeInflight[key]; };
            entry.promise.then(_cleanup, _cleanup);
        }
        if (typeof onProgress === 'function') entry.watchers.push(onProgress);
        return entry.promise;
    }

    // 取消某个实例的进度订阅（destroy 时调用，避免闭包把已卸载的组件留在内存里）
    function _unsubscribeProgress(path, maxWidth, fn) {
        var entry = _transcodeInflight[String(path) + '|' + (maxWidth || 0)];
        if (!entry || typeof fn !== 'function') return;
        var i = entry.watchers.indexOf(fn);
        if (i >= 0) entry.watchers.splice(i, 1);
    }

    // ── 视频 lightbox（全局单例）──
    // 点击卡片后在这里播放：原生控件（进度/音量/全屏都在），声音正常。
    // 打开由用户点击触发，属"用户手势"，可带声自动播放。
    // 关闭 = 点视频之外任意处（遮罩）/ Esc —— 不设 ✕ 按钮
    var _lbEl = null, _lbVideo = null, _lbName = null, _lbKeyHandler = null;

    function _ensureLightbox() {
        if (_lbEl) return;
        _lbEl = document.createElement('div');
        _lbEl.className = 'ae-agent-vp-lightbox';
        _lbEl.style.display = 'none';

        _lbName = document.createElement('div');
        _lbName.className = 'ae-agent-vp-lightbox-name';

        _lbVideo = document.createElement('video');
        _lbVideo.className = 'ae-agent-vp-lightbox-video';
        _lbVideo.controls = true;
        _lbVideo.playsInline = true;

        _lbEl.appendChild(_lbName);
        _lbEl.appendChild(_lbVideo);
        // 点遮罩关闭；点视频本体（含原生控件）不关
        _lbEl.addEventListener('click', function (e) {
            if (e.target === _lbEl) closeVideoLightbox();
        });
        document.body.appendChild(_lbEl);
    }

    function closeVideoLightbox() {
        if (!_lbEl) return;
        try { _lbVideo.pause(); } catch (_) {}
        _lbVideo.removeAttribute && _lbVideo.removeAttribute('src');
        _lbVideo.src = '';
        _lbEl.style.display = 'none';
        if (_lbKeyHandler) {
            document.removeEventListener('keydown', _lbKeyHandler);
            _lbKeyHandler = null;
        }
    }

    function openVideoLightbox(opts) {
        opts = opts || {};
        var src = opts.src || '';
        if (!src) return;
        _ensureLightbox();
        _lbName.textContent = opts.name || '';
        _lbName.title = opts.path || '';
        _lbEl.style.display = 'flex';
        _lbVideo.src = src;
        try { _lbVideo.currentTime = 0; } catch (_) {}
        var p = _lbVideo.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
        if (!_lbKeyHandler) {
            _lbKeyHandler = function (e) { if (e.key === 'Escape') closeVideoLightbox(); };
            document.addEventListener('keydown', _lbKeyHandler);
        }
    }

    /**
     * @param {Object} opts
     *   path          {string}  原始绝对路径（转码输入；无 File 时也是播放源）
     *   file          {File}    可选，拖拽时优先用 blob URL（免读盘）
     *   name          {string}  可选，显示名（默认取路径末段）
     *   compact       {boolean} 输入框 chip 的 hover 预览（无名字行、无点击 lightbox）
     *   elClassName   {string}  可选，附加到根元素的 class（chip 用现成的浮层样式类）
     *   maxWidth      {number}  转码限宽，默认 640
     *   muted         {boolean} 默认 true（悬停自动播放必须静音）
     *   loop          {boolean} 默认 false（compact 下默认 true，与 hover 预览语义一致）
     * @returns {{el:Element, video:Element, play:Function, pause:Function, destroy:Function}}
     */
    function createVideoPreview(opts) {
        opts = opts || {};
        var path = opts.path || '';
        var file = opts.file || null;
        var compact = opts.compact === true;
        var name = opts.name || String(path).replace(/^.*[\\\/]/, '') || 'video';
        var maxWidth = opts.maxWidth > 0 ? opts.maxWidth : DEFAULT_MAX_WIDTH;

        var objectUrl = '';
        var root = document.createElement('div');
        root.className = 'ae-agent-video-preview' + (compact ? ' is-compact' : '');
        if (opts.elClassName) root.className += ' ' + opts.elClassName;

        if (!compact) {
            var nameEl = document.createElement('div');
            nameEl.className = 'ae-agent-attach-video-name';
            nameEl.textContent = name;
            nameEl.title = path;
            root.appendChild(nameEl);
        }

        var stage = document.createElement('div');
        stage.className = 'ae-agent-vp-stage';

        var v = document.createElement('video');
        v.className = 'ae-agent-vp-el';
        v.muted = opts.muted !== false;          // 悬停自动播放的前提
        v.loop = compact ? opts.loop !== false : opts.loop === true;
        v.playsInline = true;
        v.preload = 'metadata';

        var status = document.createElement('div');
        status.className = 'ae-agent-vp-status';
        status.style.display = 'none';

        stage.appendChild(v);
        stage.appendChild(status);
        root.appendChild(stage);

        var _fellBack = false;      // 已进入兜底（防 error/metadata/播放复查三路重复触发）
        var _transcoded = false;    // 已换源到转码产物
        var _probeTimer = null;
        var _metaRecheckTimer = null;
        var _progressWatcher = null;   // 转码进度订阅函数（destroy 时退订）
        var _destroyed = false;
        var _hovering = false;         // 非 compact：悬停即预览播放

        // 视频区尺寸上限（卡片 / 输入框浮层各一套）；宽度按视频比例反推，见 _applyAspect
        var ASPECT_MAX_W = compact ? 220 : 260;
        var ASPECT_MAX_H = compact ? 220 : 160;

        // 容器宽度跟随视频比例：横屏贴宽度上限；竖屏超过高度上限时按高度反推宽度。
        // 容器定宽 + 视频 max-height 的写法会把竖屏视频压成"宽卡片 + 左右黑边"。
        // 元数据未知（videoWidth === 0，解不出画面）时退回上限宽度，布局保持稳定。
        function _applyAspect() {
            var vw = v.videoWidth, vh = v.videoHeight;
            var w = ASPECT_MAX_W;
            if (vw > 0 && vh > 0) {
                var ratio = vw / vh;
                var h = ASPECT_MAX_W / ratio;
                if (h > ASPECT_MAX_H) { h = ASPECT_MAX_H; w = h * ratio; }
            }
            root.style.width = Math.round(w) + 'px';
        }

        function _setStatus(text) {
            status.textContent = text || '';
            status.style.display = text ? '' : 'none';
            root.classList.toggle('is-undecodable', !!text);
        }

        function _clearProbe() {
            if (_probeTimer) { clearTimeout(_probeTimer); _probeTimer = null; }
            if (_metaRecheckTimer) { clearTimeout(_metaRecheckTimer); _metaRecheckTimer = null; }
        }

        // 「解得出画面」的肯定证据：拿到首帧尺寸即认为可播
        function _markPlayable() {
            if (_fellBack) return;
            _clearProbe();
        }

        function _hoverPlay() {
            if (_destroyed || !v.src) return;
            var p = v.play();
            if (p && typeof p.catch === 'function') p.catch(function () {});
        }

        function _markUndecodable(reason) {
            if (_destroyed || _fellBack) return;
            _fellBack = true;
            _clearProbe();
            try { v.pause(); } catch (_) {}
            // 已有 File（拖拽）时其实用不着转码：blob URL 与 file:// 走同一个解码器，
            // 解不了就是解不了——但转码输入仍用原始路径，所以统一走下面的转码分支。
            if (_transcoded) {
                _setStatus(AEI18n.t('视频预览失败：{reason}', { reason: reason }));
                return;
            }
            _progressWatcher = function (p) {
                if (_destroyed) return;
                if (p && p.status === 'running') _setStatus(AEI18n.t('正在转码预览… {pct}%', { pct: Math.round(p.progress || 0) }));
            };
            var task = _startTranscode(path, maxWidth, _progressWatcher);
            if (!task || typeof task.then !== 'function') {
                _setStatus(AEI18n.t('此视频编码面板内无法解码（如 HEVC/H.265）。转码预览不可用：需要 Bridge 与 ffmpeg。'));
                return;
            }
            _setStatus(AEI18n.t('此视频编码面板内无法解码，正在转码预览…'));
            task.then(function (outPath) {
                if (_destroyed || !outPath) return;
                _transcoded = true;
                v.src = _toFileUrl(outPath);
                try { v.load(); } catch (_) {}
                _setStatus('');
                // 换源后仍要复查：转码产物若也解不出（极少），error/复查会再次置文案
                _fellBack = false;
                _scheduleProbe();
                // 只有鼠标还在卡片上才自动播（与"悬停预览播放"的交互一致）
                if (compact || _hovering) _hoverPlay();
            }).catch(function (e) {
                if (_destroyed) return;
                var msg = (e && e.message) ? e.message : String(e);
                _setStatus(AEI18n.t('此视频编码面板内无法解码，转码预览失败：{error}', { error: msg }));
            });
        }

        // 播放中复查：元数据能读、时间轴在走，但一帧画面都没解出来（CEF 播 HEVC 的典型表现）
        function _scheduleProbe() {
            _clearProbe();
            _probeTimer = setTimeout(function () {
                _probeTimer = null;
                if (_destroyed || !v.isConnected) return;
                if (v.videoWidth === 0 && v.readyState >= 1) _markUndecodable(AEI18n.t('播放中始终没有画面'));
            }, PLAY_PROBE_MS);
        }

        v.addEventListener('loadedmetadata', function () {
            // 容器先按比例定宽，再判可播性——两件事都只依赖 videoWidth/videoHeight
            _applyAspect();
            // 有尺寸 = 视频轨可解；videoWidth 仍为 0 = 容器能读、视频轨解不出（HEVC 主路径）。
            // 但 0 也可能是瞬间状态，故先复检一次再下结论——转码是重操作，别为误判白跑一趟。
            if (v.videoWidth > 0) { _markPlayable(); return; }
            if (_metaRecheckTimer) clearTimeout(_metaRecheckTimer);
            _metaRecheckTimer = setTimeout(function () {
                _metaRecheckTimer = null;
                if (_destroyed) return;
                if (v.videoWidth > 0) _markPlayable();
                else _markUndecodable(AEI18n.t('视频轨无法解码'));
            }, META_RECHECK_MS);
        });
        v.addEventListener('loadeddata', _markPlayable);
        v.addEventListener('error', function () { _markUndecodable(AEI18n.t('浏览器报告媒体错误')); });
        v.addEventListener('play', function () { _scheduleProbe(); });

        if (compact) {
            // compact：hover 播放/暂停由调用方（输入框 chip）驱动，点击切播放保持不变
            root.addEventListener('click', function (e) {
                e.stopPropagation();
                if (v.paused) _hoverPlay();
                else { try { v.pause(); } catch (_) {} }
            });
        } else {
            // 非 compact：悬停即静音预览；点击开 lightbox 播放（声音在那里）
            root.addEventListener('mouseenter', function () { _hovering = true; _hoverPlay(); });
            root.addEventListener('mouseleave', function () {
                _hovering = false;
                try { v.pause(); } catch (_) {}
            });
            stage.addEventListener('click', function (e) {
                e.stopPropagation();
                if (_destroyed) return;
                // 画面解不出（含转码中）时不打开——lightbox 里同样是黑的；
                // 此时卡片上的状态覆盖层已在说明原因
                if (!v.videoWidth) return;
                var cur = v.currentSrc || v.src || (path ? _toFileUrl(path) : '');
                if (!cur) return;
                openVideoLightbox({ src: cur, name: name, path: path });
            });
        }

        // 源设置放在监听器之后：同步的 error/loadedmetadata 也不会漏接
        if (file && global.URL && typeof global.URL.createObjectURL === 'function') {
            try {
                objectUrl = global.URL.createObjectURL(file);
                v.src = objectUrl;
            } catch (_) {}
        }
        if (!v.src && path) v.src = _toFileUrl(path);

        return {
            el: root,
            video: v,
            play: function () { return v.play(); },
            pause: function () { try { v.pause(); } catch (_) {} },
            destroy: function () {
                _destroyed = true;
                _clearProbe();
                // 退出转码进度订阅：否则在途转码的广播闭包会把这个已卸载的组件留在内存里
                if (_progressWatcher) {
                    _unsubscribeProgress(path, maxWidth, _progressWatcher);
                    _progressWatcher = null;
                }
                try { v.pause(); } catch (_) {}
                if (objectUrl && global.URL && typeof global.URL.revokeObjectURL === 'function') {
                    try { global.URL.revokeObjectURL(objectUrl); } catch (_) {}
                    objectUrl = '';
                }
            }
        };
    }

    global.AEShared = global.AEShared || {};
    global.AEShared.createVideoPreview = createVideoPreview;
    global.AEShared.isVideoPath = isVideoPath;
    global.AEShared.openVideoLightbox = openVideoLightbox;
    global.AEShared.closeVideoLightbox = closeVideoLightbox;
})(window);
