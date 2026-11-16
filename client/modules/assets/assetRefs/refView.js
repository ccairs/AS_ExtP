(function (global) {
    global.AEAssetsShared = global.AEAssetsShared || {};

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // 自动转码开关（模块设置 → 素材库 → 自动转码；与设置面板同一 localStorage 键，默认开）。
    // 三处自动转码入口共用本判定：详情兜底 _playMovFallback / 网格缩略图
    // onThumbVideoUnplayable / 全屏 _onLbVideoUnplayable。关闭时不发起转码——详情与全屏
    // 显示关闭提示，网格保持静态封面；既有缓存不受影响（清缓存按钮仍可用）。
    function _autoTranscodeEnabled() {
        try { return localStorage.getItem('assets.autoTranscode') !== '0'; } catch (_) { return true; }
    }

    // ── Lightbox：图片缩放/拖动/惯性 / 视频带 controls 播放 ──
    // 行为与 comfyui lightbox 一致：
    //   图片：滚轮缩放(0.15~8)+拖拽平移(带惯性)+双击复位+点击空白关闭
    //   视频：带 controls 播放，点击空白关闭
    var _lb = null, _lbImg = null, _lbVideo = null, _lbFallbackToken = 0;
    var _lbScale = 1, _lbTargetScale = 1, _lbScaleAnimId = null;
    var _lbPanX = 0, _lbPanY = 0;
    var _lbDragging = false, _lbMoved = false;
    var _lbDragStartX = 0, _lbDragStartY = 0, _lbPanStartX = 0, _lbPanStartY = 0;
    var _lbVelX = 0, _lbVelY = 0, _lbLastX = 0, _lbLastY = 0, _lbLastTime = 0;
    var _lbInertiaId = null;
    var _lbCloseTimer = null;        // 图片 lightbox 关闭动画定时器（200ms 内重开时需取消）
    var _lbVideoCloseTimer = null;   // 视频 lightbox 关闭动画定时器（同上）

    function _lbApplyTransform() {
        if (!_lbImg) return;
        _lbImg.style.transform = 'translate(' + _lbPanX + 'px,' + _lbPanY + 'px) scale(' + _lbScale + ')';
    }
    function _lbStopInertia() {
        if (_lbInertiaId) { cancelAnimationFrame(_lbInertiaId); _lbInertiaId = null; }
        if (_lbScaleAnimId) { cancelAnimationFrame(_lbScaleAnimId); _lbScaleAnimId = null; }
    }
    function _lbAnimateScale() {
        _lbScaleAnimId = null;
        var diff = _lbTargetScale - _lbScale;
        if (Math.abs(diff) < 0.001) { _lbScale = _lbTargetScale; _lbApplyTransform(); return; }
        _lbScale += diff * 0.25;
        _lbApplyTransform();
        _lbScaleAnimId = requestAnimationFrame(_lbAnimateScale);
    }
    function _lbSetScale(newScale) {
        _lbTargetScale = Math.max(0.15, Math.min(8, newScale));
        if (!_lbScaleAnimId) _lbScaleAnimId = requestAnimationFrame(_lbAnimateScale);
    }
    function _lbStartInertia() {
        _lbStopInertia();
        var friction = 0.92;
        function step() {
            _lbVelX *= friction; _lbVelY *= friction;
            if (Math.abs(_lbVelX) < 0.3 && Math.abs(_lbVelY) < 0.3) { _lbVelX = 0; _lbVelY = 0; _lbInertiaId = null; return; }
            _lbPanX += _lbVelX; _lbPanY += _lbVelY;
            _lbApplyTransform();
            _lbInertiaId = requestAnimationFrame(step);
        }
        _lbInertiaId = requestAnimationFrame(step);
    }

    function _ensureLightbox() {
        if (_lb) return _lb;
        _lb = document.createElement('div');
        _lb.className = 'assets-lightbox';
        _lb.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0);align-items:center;justify-content:center;transition:background .3s ease;overflow:hidden;';
        _lbImg = document.createElement('img');
        _lbImg.style.cssText = 'position:absolute;max-width:90vw;max-height:90vh;object-fit:contain;cursor:grab;user-select:none;border-radius:4px;outline:2px solid rgba(255,255,255,.15);outline-offset:4px;';
        _lbImg.draggable = false;
        _lb.appendChild(_lbImg);
        document.body.appendChild(_lb);

        // 点击背景关闭
        _lb.addEventListener('click', function (e) {
            if (e.target === _lb) _closeLightbox();
        });
        // 滚轮缩放（以图片中心为锚点）
        _lb.addEventListener('wheel', function (e) {
            e.preventDefault();
            var newScale = _lbTargetScale + (e.deltaY > 0 ? -0.3 : 0.3);
            var rect = _lbImg.getBoundingClientRect();
            var mx = e.clientX - (rect.left + rect.width / 2);
            var my = e.clientY - (rect.top + rect.height / 2);
            var ratio = newScale / _lbScale;
            _lbPanX -= mx * (ratio - 1);
            _lbPanY -= my * (ratio - 1);
            _lbSetScale(newScale);
        });
        // 图片拖拽
        _lbImg.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            _lbStopInertia();
            _lbDragging = true; _lbMoved = false;
            _lbDragStartX = e.clientX; _lbDragStartY = e.clientY;
            _lbPanStartX = _lbPanX; _lbPanStartY = _lbPanY;
            _lbLastX = e.clientX; _lbLastY = e.clientY;
            _lbLastTime = Date.now();
            _lbVelX = 0; _lbVelY = 0;
            _lbImg.style.cursor = 'grabbing';
            _lbImg.style.transition = 'none';
        });
        window.addEventListener('mousemove', function (e) {
            if (!_lbDragging) return;
            var dx = e.clientX - _lbDragStartX, dy = e.clientY - _lbDragStartY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) _lbMoved = true;
            var now = Date.now(), dt = Math.max(1, now - _lbLastTime);
            _lbPanX = _lbPanStartX + dx;
            _lbPanY = _lbPanStartY + dy;
            _lbVelX = (e.clientX - _lbLastX) / dt * 16;
            _lbVelY = (e.clientY - _lbLastY) / dt * 16;
            _lbLastX = e.clientX; _lbLastY = e.clientY;
            _lbLastTime = now;
            _lbApplyTransform();
        });
        window.addEventListener('mouseup', function () {
            if (!_lbDragging) return;
            _lbDragging = false;
            _lbImg.style.cursor = 'grab';
            _lbImg.style.transition = 'transform .15s ease-out';
            if (Math.abs(_lbVelX) > 0.5 || Math.abs(_lbVelY) > 0.5) _lbStartInertia();
        });
        // 双击复位
        _lb.addEventListener('dblclick', function (e) {
            if (e.target === _lbImg) {
                _lbStopInertia();
                _lbScale = 1; _lbTargetScale = 1; _lbPanX = 0; _lbPanY = 0;
                _lbApplyTransform();
            }
        });
        return _lb;
    }

    function _openLightbox(src, isVideo, movPath, dataDir) {
        if (isVideo) { _openVideoLightbox(src, movPath, dataDir); return; }
        var lb = _ensureLightbox();
        // 取消挂起的关闭定时器：200ms 内重开时，避免新开的 lightbox 被旧定时器隐藏/清空
        if (_lbCloseTimer) { clearTimeout(_lbCloseTimer); _lbCloseTimer = null; }
        _lbStopInertia();
        _lbScale = 1; _lbTargetScale = 1; _lbPanX = 0; _lbPanY = 0;
        _lbVelX = 0; _lbVelY = 0;
        _lbMoved = false;
        _lbImg.src = src;
        _lbImg.style.transition = 'transform .15s ease-out';
        _lbApplyTransform();
        lb.style.display = 'flex';
        lb.style.background = 'rgba(0,0,0,0.92)';
        lb.style.opacity = '0';
        requestAnimationFrame(function () { lb.style.opacity = '1'; lb.style.transition = 'opacity .2s ease, background .3s ease'; });
    }

    function _openVideoLightbox(src, movPath, dataDir) {
        if (!_lbVideo) {
            _lbVideo = document.createElement('div');
            _lbVideo.className = 'assets-lightbox';
            _lbVideo.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.92);align-items:center;justify-content:center;transition:opacity .2s ease;';
            var v = document.createElement('video');
            v.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:4px;outline:2px solid rgba(255,255,255,.15);outline-offset:4px;';
            v.controls = true;
            _lbVideo.appendChild(v);
            // 转码回退容器
            var fb = document.createElement('div');
            fb.className = 'lb-fallback';
            fb.style.cssText = 'display:none;text-align:center;color:var(--text-muted);font-size:14px;padding:20px;';
            _lbVideo.appendChild(fb);
            // 视频无法解码 → 转码回退。error 与"无画面"两条路共用本函数：
            // HEVC/H.265 等 CEF 解不了的编码只表现为 videoWidth === 0（时长照读、时间轴
            // 照走、画面全黑），**不触发 error**——只挂 error 时这类文件永不回退。
            function _onLbVideoUnplayable() {
                var curV = _lbVideo.querySelector('video');
                var curFb = _lbVideo.querySelector('.lb-fallback');
                var mp = curV.dataset.movpath;
                var dd = _lbVideo.dataset.datadir;
                if (!mp || !dd) return;
                if (curFb && !curFb.dataset.loading) {
                    curFb.dataset.loading = '1';
                    // 同上：隐藏不等于暂停，转码期间不能继续出声（该元素随后会被复用播转码产物）
                    try { curV.pause(); } catch (_) {}
                    curV.style.display = 'none';
                    curFb.style.display = 'block';
                    if (!_autoTranscodeEnabled()) {
                        curFb.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px">'
                            + AEI18n.html('无法解码该视频（自动转码已在模块设置中关闭）</div>');
                        return;
                    }
                    var token = ++_lbFallbackToken;
                    var transcodedDir = dd.replace(/[\\\/]+$/, '') + '/temp/transcoded';
                    var maxWidth = 854;
                    try { var mw = localStorage.getItem('assets.transcodeMaxWidth'); if (mw != null) { var p = parseInt(mw, 10); if (!isNaN(p)) maxWidth = p; } } catch (_) {}
                    var hasTrans = global.AEAssetsShared && typeof global.AEAssetsShared.transcodeMov === 'function';
                    if (!hasTrans) return;
                    curFb.innerHTML = '<div style="padding:12px 16px;text-align:center;color:var(--text-muted);font-size:12px">'
                        + AEI18n.html('正在转码…<br>')
                        + '<div style="width:200px;height:4px;background:var(--surface-2);border-radius:2px;margin:8px auto 0;overflow:hidden">'
                        + '<div class="lb-transcode-bar" style="height:100%;width:0%;background:var(--accent);border-radius:2px;transition:width .3s ease"></div></div>'
                        + '<div class="lb-transcode-pct" style="margin-top:4px;font-size:11px;color:var(--text-muted)">0%</div></div>';
                    try {
                        global.AEAssetsShared.transcodeMov(mp, transcodedDir, function (p) {
                            if (token !== _lbFallbackToken || !curFb.isConnected) return;
                            var bar = curFb.querySelector('.lb-transcode-bar');
                            var pct = curFb.querySelector('.lb-transcode-pct');
                            if (bar) bar.style.width = (p.progress || 0) + '%';
                            if (pct) pct.textContent = (p.progress || 0) + '%';
                        }, maxWidth).then(function (webmPath) {
                            if (token !== _lbFallbackToken) return;
                            if (!curFb.isConnected) return;
                            curFb.innerHTML = '';
                            curFb.style.display = 'none';
                            curV.src = 'file:///' + webmPath.replace(/\\/g, '/');
                            curV.style.display = '';
                            // 转码完成同样不自动播放——与普通视频路径一致（见 _openVideoLightbox 末尾）
                        }).catch(function (err) {
                            if (token !== _lbFallbackToken) return;
                            curFb.innerHTML = AEI18n.html('<div style="padding:12px;text-align:center;color:#fbbf24;font-size:12px">转码失败: ') + _esc(err.message || err) + '</div>';
                        });
                    } catch (e) {
                        curFb.innerHTML = AEI18n.html('<div style="padding:12px;text-align:center;color:#fbbf24;font-size:12px">transcodeMov 调用失败: ') + _esc(e.message || e) + '</div>';
                    }
                }
            }
            v.addEventListener('error', _onLbVideoUnplayable);
            v.addEventListener('loadedmetadata', function () {
                var curV = _lbVideo.querySelector('video');
                if (curV && curV.dataset.movpath && curV.videoWidth === 0) _onLbVideoUnplayable();
            });
            _lbVideo.addEventListener('click', function (e) {
                if (e.target === _lbVideo) _closeLightbox();
            });
            document.body.appendChild(_lbVideo);
        }
        // 取消上一个未完成的转码（切换素材/重复打开时）
        ++_lbFallbackToken;
        // 取消挂起的关闭定时器：200ms 内重开时，避免新开的 lightbox 被旧定时器隐藏
        if (_lbVideoCloseTimer) { clearTimeout(_lbVideoCloseTimer); _lbVideoCloseTimer = null; }
        var v = _lbVideo.querySelector('video');
        var fb = _lbVideo.querySelector('.lb-fallback');
        // 重置回退状态
        v.style.display = '';
        fb.style.display = 'none';
        fb.innerHTML = '';
        delete fb.dataset.loading;
        delete v.dataset.movpath;
        if (movPath) v.dataset.movpath = movPath;
        if (dataDir) _lbVideo.dataset.datadir = dataDir;
        v.src = src;
        _lbVideo.style.display = 'flex';
        _lbVideo.style.opacity = '0';
        requestAnimationFrame(function () { _lbVideo.style.opacity = '1'; _lbVideo.style.transition = 'opacity .2s ease'; });
        // 不自动播放：点击预览进全屏这一步只负责"打开"，播放由控制条手动开始。
        // 详情预览区的自动循环只作用于详情区，不影响本全屏播放器；v 停在 0:00 首帧
    }

    function _closeLightbox() {
        // 关视频
        if (_lbVideo) {
            var v = _lbVideo.querySelector('video');
            if (v) { v.pause(); v.src = ''; delete v.dataset.movpath; }
            var fb = _lbVideo.querySelector('.lb-fallback');
            if (fb) { fb.style.display = 'none'; fb.innerHTML = ''; delete fb.dataset.loading; }
            delete _lbVideo.dataset.datadir;
            ++_lbFallbackToken; // 取消进行中的转码
            _lbVideo.style.opacity = '0';
            if (_lbVideoCloseTimer) clearTimeout(_lbVideoCloseTimer);
            _lbVideoCloseTimer = setTimeout(function () {
                _lbVideoCloseTimer = null;
                if (_lbVideo) _lbVideo.style.display = 'none';
            }, 200);
        }
        // 关图片
        if (!_lb) return;
        _lbStopInertia();
        _lb.style.opacity = '0';
        if (_lbCloseTimer) clearTimeout(_lbCloseTimer);
        _lbCloseTimer = setTimeout(function () {
            _lbCloseTimer = null;
            if (_lb) {
                _lb.style.display = 'none';
                _lbImg.src = '';
                _lbScale = 1; _lbPanX = 0; _lbPanY = 0;
            }
        }, 200);
    }

    // opts: { pane, store, dataDir }
    function createRefView(opts) {
        var pane = opts.pane;
        var store = opts.store;
        var hostApi = opts.hostApi || null;
        var dataDir = opts.dataDir;
        var _tv = null;
        var _handlers = {};
        var _destroyed = false;
        var _busy = false;
        var _selectGen = 0;   // _onSelect 重入防护：每次选中自增，异步回调比对代龄丢弃过期者
        var IMPORT_WARN_COUNT = 100;   // 批量导入文件数超此值，先弹确认提示
        var NOTICE_THRESHOLD = 20;     // 批量操作超过此数量才显示进度条（少量操作静默处理）

        pane.innerHTML = '';
        pane.classList.add('assets-pane');

        // 视频无法解码 → 回退到 ffmpeg 转码播放。触发有两条路：
        //   ① error 事件（带 alpha 的 mov 等，浏览器明确报错）；
        //   ② loadedmetadata 后 videoWidth === 0（HEVC/H.265 等：CEF 88 无该解码能力，
        //      容器与音频照常解析——时长读得到、时间轴照走、画面全黑，**且不触发 error**。
        //      只挂 error 时，这类文件永不回退，用户只看到一个黑框 + 原生控件）。
        function _onPreviewVideoUnplayable(v, why) {
            if (!v || v.tagName !== 'VIDEO' || !v.dataset.movpath) return;
            var preview = v.closest('.assets-detail-preview');
            var fallback = preview ? preview.querySelector('.mov-fallback') : null;
            console.warn('[ffmpeg-fb] ' + why + ': ' + v.dataset.movpath.replace(/^.*[\\\/]/,'') + ' fb=' + !!fallback + ' ld=' + (fallback ? fallback.dataset.loading : '?'));
            if (fallback && !fallback.dataset.loading) {
                fallback.dataset.loading = '1';
                // display:none 不会暂停播放——HEVC 这类"视频轨解不出、音频轨正常"的文件
                // 会在"正在转码…"期间继续出声（明明在转码却有声音）
                try { v.pause(); } catch (_) {}
                v.style.display = 'none';
                fallback.style.display = 'block';
                _playMovFallback(fallback, v.dataset.movpath);
            }
        }
        pane.addEventListener('error', function (e) {
            if (e.target && e.target.tagName === 'VIDEO' && e.target.dataset.movpath) {
                _onPreviewVideoUnplayable(e.target, 'video error');
            }
        }, true);
        // 详情预览自动播放：点击条目后右侧预览区自动静音循环播放，不依赖鼠标悬停。
        // 必须静音：HEVC 这类文件音频轨正常、画面解不出，出声会成为"转码期间仍有声音"的问题；
        // 且静音 play() 不受 Chrome 自动播放策略约束（详情渲染不构成用户激活，非静音会被拒）。
        // 主视频解码失败/无画面时由 _onPreviewVideoUnplayable 转去转码兜底，兜底产物走同一套自动播放。
        // _previewSuppressed：强制停播（进全屏 / 卡被盖住）后阻止迟到的事件重新起播——
        // loadedmetadata 可能在停播之后才到，转码完成回调也可能晚到且 autoplay 属性会自行起播。
        // 详情重建（_renderDetail）时复位，恢复正常自动播放。
        var _previewSuppressed = false;
        function _autoplayPreviewVideo(v) {
            if (_previewSuppressed) return;
            if (!v || v.tagName !== 'VIDEO') return;
            try {
                v.muted = true;
                v.loop = true;
                if (v.ended) v.currentTime = 0;
                var p = v.play();
                if (p && typeof p.catch === 'function') p.catch(function () {});
            } catch (_) {}
        }
        // 只认详情预览区里的 video：lightbox 挂在 body 上，不经过 pane 的事件监听；
        // 转码兜底产物没有 data-movpath，同样靠这个判定接上自动播放
        function _isInDetailPreview(v) {
            return !!(v && v.closest && v.closest('.assets-detail-preview'));
        }
        // 停掉详情预览区正在播的视频并抑制迟到起播：进全屏、卡被盖住、模块卸载前调用。
        // video 从 DOM 移除不会自动暂停，不显式停会在后台继续解码播放。
        // 详情重建前的停播在 treeView._renderDetail 入口（多选/文件夹分支也覆盖）。
        function _stopPreviewPlayback() {
            _previewSuppressed = true;
            _stopSequencePreview();   // 序列帧同理：定时器不停会在已卸载的 <img> 上继续换帧
            var area = pane.querySelector('.assets-detail-preview');
            if (!area) return;
            var vids = area.querySelectorAll('video');
            for (var i = 0; i < vids.length; i++) {
                try { vids[i].pause(); } catch (_) {}
            }
        }
        // loadedmetadata 不冒泡，但捕获阶段仍会经过 pane ✓
        pane.addEventListener('loadedmetadata', function (e) {
            var v = e.target;
            if (!v || v.tagName !== 'VIDEO') return;
            // 无画面（HEVC：时长照读、视频轨全黑、不触发 error）→ 转码兜底，主视频不播
            if (v.dataset.movpath && v.videoWidth === 0) {
                _onPreviewVideoUnplayable(v, 'video 无画面（videoWidth=0）');
                return;
            }
            // 正常解码的主视频 / 转码兜底产物 → 自动静音循环播放
            if (_isInDetailPreview(v)) _autoplayPreviewVideo(v);
        }, true);

        // ── 序列帧预览播放 ──
        // 序列帧条目的 originalPath 是首帧路径，sequence 只存 { count, prefix, ext }
        // （见 refStore._mkItem）；帧路径不额外落盘：按首帧文件名推导起始号与位宽，再用
        // 同目录文件列表交叉校验，避免同目录多段同前缀序列混段、缺帧时在 <img> 里读出破图。
        // 交互与视频一致：点击条目后自动逐帧循环播放，切换/进全屏/卡被盖住/卸载即停。
        var SEQ_FRAME_MS = 80;   // 12.5fps：序列帧没有 fps 数据源，按预览能辨认逐帧动作取值
        var _seqPlay = null;     // { img, frames:[url], idx, timer }

        function _stopSequencePreview() {
            if (_seqPlay && _seqPlay.timer) { try { clearTimeout(_seqPlay.timer); } catch (_) {} }
            _seqPlay = null;
        }

        // 首帧文件名 → { dir, prefix, ext, count, start, width }；文件名不合规返回 null。
        // width > 0 表示带前导零命名（frame_001）→ 补零到首帧位宽；无前导零（frame_1..frame_10）
        // 按自然位数增长（补零会推出不存在的 frame_010）。
        function _sequenceMeta(r) {
            var seq = r && r.sequence;
            var src = r && r.originalPath;
            if (!seq || !src) return null;
            var p = String(src).replace(/\\/g, '/');
            var slash = p.lastIndexOf('/');
            var dir = slash >= 0 ? p.slice(0, slash) : '';
            var base = slash >= 0 ? p.slice(slash + 1) : p;
            var prefix = String(seq.prefix || '');
            var ext = String(seq.ext || '');
            var count = Number(seq.count) || 0;
            if (!prefix || !ext || count < 2) return null;
            if (base.indexOf(prefix) !== 0) return null;
            var mid = base.slice(prefix.length);
            if (mid.length <= ext.length || mid.slice(-ext.length).toLowerCase() !== ext.toLowerCase()) return null;
            mid = mid.slice(0, -ext.length);
            if (!/^\d+$/.test(mid)) return null;
            return {
                dir: dir,
                prefix: prefix,
                ext: ext,
                count: count,
                start: parseInt(mid, 10),
                width: mid.charAt(0) === '0' ? mid.length : 0
            };
        }

        // 由 img 的 data-seq-* 重建 meta（详情渲染时已算过，避免二次解析路径）
        function _sequenceMetaFromImg(img) {
            var ds = img && img.dataset;
            if (!ds || !ds.seqDir) return null;
            var count = Number(ds.seqCount) || 0;
            if (count < 2) return null;
            return {
                dir: String(ds.seqDir),
                prefix: String(ds.seqPrefix || ''),
                ext: String(ds.seqExt || ''),
                count: count,
                start: Number(ds.seqStart) || 0,
                width: Number(ds.seqWidth) || 0
            };
        }

        // 第 i 帧文件名
        function _sequenceFrameName(meta, i) {
            var s = String(meta.start + i);
            if (meta.width > 0) { while (s.length < meta.width) s = '0' + s; }
            return meta.prefix + s + meta.ext;
        }

        // 帧 URL 列表：目录扫描命中才收（缺帧不推进 <img>）；扫描不可用时按推导兜底
        function _sequenceFrameUrls(meta) {
            var names = [];
            for (var i = 0; i < meta.count; i++) names.push(_sequenceFrameName(meta, i));
            var toUrl = (global.AEShared && typeof global.AEShared.toFileUrl === 'function')
                ? global.AEShared.toFileUrl : null;
            var build = function (hitSet) {
                var out = [];
                for (var j = 0; j < names.length; j++) {
                    if (hitSet && !hitSet[names[j]]) continue;
                    var u = toUrl ? toUrl(meta.dir + '/' + names[j]) : '';
                    if (u) out.push(u);
                }
                return out;
            };
            var AEFS = global.AEFS;
            var lister = AEFS && (AEFS.listFilesAsync || AEFS.listFiles);
            if (typeof lister !== 'function') return Promise.resolve(build(null));
            return Promise.resolve()
                .then(function () { return lister.call(AEFS, meta.dir); })
                .then(function (list) {
                    if (!Array.isArray(list) || !list.length) return build(null);
                    var hitSet = {};
                    for (var k = 0; k < list.length; k++) hitSet[String(list[k])] = true;
                    return build(hitSet);
                })
                .catch(function () { return build(null); });
        }

        function _seqTick(entry) {
            if (_seqPlay !== entry) return;   // 已被新播放器/停播替换
            var img = entry.img;
            // 详情被重建（多选/文件夹分支直写 innerHTML）时原 img 已脱离 DOM：自停。
            // 这类分支不经过 refView 的停播点，由这里停止。
            if (!img || !img.isConnected) { _stopSequencePreview(); return; }
            if (!entry.frames.length) return;
            entry.idx = (entry.idx + 1) % entry.frames.length;
            try { img.src = entry.frames[entry.idx]; } catch (_) { _stopSequencePreview(); return; }
            entry.timer = setTimeout(function () { _seqTick(entry); }, SEQ_FRAME_MS);
        }

        function _startSequencePreview(img) {
            if (_previewSuppressed) return;   // 全屏/卡被盖住期间迟到的首帧 load 不再起播
            _stopSequencePreview();
            var meta = _sequenceMetaFromImg(img);
            if (!meta) return;
            var entry = { img: img, frames: [], idx: 0, timer: null };
            _seqPlay = entry;
            _sequenceFrameUrls(meta).then(function (frames) {
                if (_seqPlay !== entry || !img.isConnected) return;   // 扫描期间已切走
                if (frames.length < 2) return;                        // 单帧/扫描失败：保持首帧静态
                entry.frames = frames;
                entry.idx = 0;
                entry.timer = setTimeout(function () { _seqTick(entry); }, SEQ_FRAME_MS);
            }).catch(function () { if (_seqPlay === entry) _stopSequencePreview(); });
        }

        // 序列帧首帧 load → 启动播放；播放器自己换帧也会触发 load，用 _seqPlay.img 同一性挡掉，
        // 否则每帧都会重启播放器，画面停在第二帧
        pane.addEventListener('load', function (e) {
            var img = e.target;
            if (!img || img.tagName !== 'IMG' || !img.dataset || !img.dataset.seqDir) return;
            if (_seqPlay && _seqPlay.img === img) return;
            _startSequencePreview(img);
        }, true);

        var _movToken = 0;
        var _currentMovPlayer = null;
        var _transcodeMap = {};  // key -> { status:'running'|'done'|'error', container, lastProgress, token, webmPath?, error? }
        function _playMovFallback(container, movPath) {
            var token = ++_movToken;
            if (_currentMovPlayer) { _currentMovPlayer.destroy(); _currentMovPlayer = null; }
            if (!_autoTranscodeEnabled()) {
                container.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px">'
                    + AEI18n.html('无法直接预览该视频<br>（自动转码已在模块设置中关闭）</div>');
                return;
            }
            var transcodedDir = (dataDir || '').replace(/[\\\/]+$/,'') + '/temp/transcoded';
            var maxWidth = 854;
            try { var mw = localStorage.getItem('assets.transcodeMaxWidth'); if (mw != null) { var p = parseInt(mw, 10); if (!isNaN(p)) maxWidth = p; } } catch (_) {}
            var hasTrans = global.AEAssetsShared && typeof global.AEAssetsShared.transcodeMov === 'function';
            if (!hasTrans) return;

            // 缓存键与产物名同源：直接用转码客户端给的产物路径（它那份命名是唯一实现）。
            // 就地抄一份 base64 截断 hash 会与产物名两处漂移，后果是"复用了别人的在途 promise"
            // 或"认的键与实际产物不是同一个文件"；转码客户端必然与 transcodeMov 同源存在
            // （上面刚查过 hasTrans），故不留降级分支。
            var cacheKey = global.AEAssetsShared.transcodeOutputPath(movPath, transcodedDir, maxWidth);
            var existing = _transcodeMap[cacheKey];

            // 已有进行中的转码 → 重新绑定 container，复用 promise
            if (existing && existing.status === 'running') {
                existing.container = container;
                existing.token = token;
                var pct = existing.lastProgress || 0;
                container.innerHTML = '<div style="padding:12px 16px;text-align:center;color:var(--text-muted);font-size:12px">'
                    + AEI18n.html('正在转码…<br>')
                    + '<div style="width:100%;height:4px;background:var(--surface-2);border-radius:2px;margin-top:8px;overflow:hidden">'
                    + '<div class="mov-transcode-bar" style="height:100%;width:' + pct + '%;background:var(--accent);border-radius:2px;transition:width .3s ease"></div></div>'
                    + '<div class="mov-transcode-pct" style="margin-top:4px;font-size:11px;color:var(--text-muted)">' + pct + '%</div></div>';
                return;
            }
            // 已转码完成 → 复用前复核产物仍在磁盘，再展示缓存结果的首帧。
            // 「清缓存」删掉 temp/transcoded/tc_*.webm 后内存映射若不复核，这里会把已删文件的
            // file:// URL 直接塞进 <video>——该兜底 video 无 data-movpath，error 不会再触发
            // 转码回退，用户只看到永久黑框；产物不在则丢弃条目、落到 _start() 重新转码。
            if (existing && existing.status === 'done' && existing.webmPath) {
                var doneEntry = existing;
                var showCached = function () {
                    // 切到别的条目后容器已脱离 DOM：此时再追加带 autoplay 的 video 会在已卸载的
                    // 兜底容器里静音无限循环（元素仍被 _transcodeMap 引用），必须按 isConnected 丢弃
                    if (token !== _movToken || !container.isConnected) return;
                    container.innerHTML = '';
                    var video = document.createElement('video');
                    video.src = 'file:///' + doneEntry.webmPath.replace(/\\/g, '/');
                    // 与主预览一致：自动静音循环播放（无 controls，声音去点击后的 lightbox）
                    video.preload = 'auto';
                    video.muted = true;
                    video.loop = true;
                    video.autoplay = !_previewSuppressed;   // 停播抑制期间（全屏/卡被盖住）不得自行起播
                    video.style.cssText = 'display:block;margin:0 auto;max-width:100%;max-height:240px;border-radius:3px;';
                    container.appendChild(video);
                };
                if (global.AEFS && typeof global.AEFS.exists === 'function') {
                    global.AEFS.exists(doneEntry.webmPath).then(function (ok) {
                        if (ok) { showCached(); return; }
                        if (token !== _movToken) return;   // 期间已切到别的素材，不再接管
                        if (_transcodeMap[cacheKey] === doneEntry) delete _transcodeMap[cacheKey];
                        _start();
                    }).catch(function () { showCached(); });   // 通道异常按"产物在"处理，避免无谓重转
                } else {
                    showCached();
                }
                return;
            }
            // 之前转码失败 → 显示错误，并给重试入口（重试丢弃 error 条目重新发起）
            if (existing && existing.status === 'error') {
                container.innerHTML = AEI18n.html('<div style="padding:12px;text-align:center;color:#fbbf24;font-size:12px">转码失败: ') + _esc(existing.error || '') + '</div>';
                var retryBtn = document.createElement('button');
                retryBtn.className = 'btn btn-slice secondary';
                retryBtn.textContent = AEI18n.t('重试转码');
                retryBtn.style.cssText = 'display:block;margin:6px auto 0;font-size:12px;padding:2px 10px;';
                retryBtn.addEventListener('click', function () {
                    if (_transcodeMap[cacheKey] && _transcodeMap[cacheKey].status === 'error') delete _transcodeMap[cacheKey];
                    _playMovFallback(container, movPath);
                });
                container.appendChild(retryBtn);
                return;
            }

            _start();

            // 新转码（首次 / done 复核发现产物缺失 / error 重试共用）
            function _start() {
            var entry = { status: 'running', container: container, lastProgress: 0, token: token };
            _transcodeMap[cacheKey] = entry;

            container.innerHTML = '<div style="padding:12px 16px;text-align:center;color:var(--text-muted);font-size:12px">'
                + AEI18n.html('正在转码…<br>')
                + '<div style="width:100%;height:4px;background:var(--surface-2);border-radius:2px;margin-top:8px;overflow:hidden">'
                + '<div class="mov-transcode-bar" style="height:100%;width:0%;background:var(--accent);border-radius:2px;transition:width .3s ease"></div></div>'
                + '<div class="mov-transcode-pct" style="margin-top:4px;font-size:11px;color:var(--text-muted)">0%</div></div>';
            try {
            global.AEAssetsShared.transcodeMov(movPath, transcodedDir, function (p) {
                entry.lastProgress = p.progress || 0;
                if (entry.token !== _movToken) return;
                var cur = entry.container;
                if (!cur || !cur.isConnected) return;
                var bar = cur.querySelector('.mov-transcode-bar');
                var pct = cur.querySelector('.mov-transcode-pct');
                if (bar) bar.style.width = (p.progress || 0) + '%';
                if (pct) pct.textContent = (p.progress || 0) + '%';
            }, maxWidth).then(function (webmPath) {
                entry.status = 'done';
                entry.webmPath = webmPath;
                if (entry.token !== _movToken) return;
                var cur = entry.container;
                if (!cur || !cur.isConnected) return;
                cur.innerHTML = '';
                var video2 = document.createElement('video');
                video2.src = 'file:///' + webmPath.replace(/\\/g, '/');
                // 同上：转码完成后同样自动静音循环播放
                video2.preload = 'auto';
                video2.muted = true;
                video2.loop = true;
                video2.autoplay = !_previewSuppressed;   // 同上：停播抑制期间不得自行起播
                video2.style.cssText = 'display:block;margin:0 auto;max-width:100%;max-height:240px;border-radius:3px;';
                cur.appendChild(video2);
                }).catch(function (err) {
                    entry.status = 'error';
                    entry.error = err.message || err;
                    if (entry.token !== _movToken) return;
                    var cur2 = entry.container;
                    if (!cur2 || !cur2.isConnected) return;
                    console.warn('[ffmpeg-fb] 转码失败: ' + (err && err.message || err));
                    cur2.innerHTML = AEI18n.html('<div style="padding:12px;text-align:center;color:#fbbf24;font-size:12px">转码失败: ') + _esc(err.message || err) + '</div>';
                    // 失败态容器也要给重试入口（与上方 error 缓存条目一致）
                    var retry2 = document.createElement('button');
                    retry2.className = 'btn btn-slice secondary';
                    retry2.textContent = AEI18n.t('重试转码');
                    retry2.style.cssText = 'display:block;margin:6px auto 0;font-size:12px;padding:2px 10px;';
                    retry2.addEventListener('click', function () {
                        if (_transcodeMap[cacheKey] && _transcodeMap[cacheKey].status === 'error') delete _transcodeMap[cacheKey];
                        _playMovFallback(cur2, movPath);
                    });
                    cur2.appendChild(retry2);
                });
            } catch (e) {
                // 同步异常同样落 error 态（否则条目永远停在 running，后续复用会虚假显示"转码中"），
                // 再走一遍 error 分支渲染重试入口
                entry.status = 'error';
                entry.error = e.message || e;
                console.warn('[ffmpeg-fb] transcodeMov 同步异常: ' + (e && e.message || e));
                _playMovFallback(container, movPath);
            }
            }
        }

        function _mkBtn(text, type) {
            var b = document.createElement('button');
            b.className = 'btn btn-slice ' + (type || 'secondary');
            b.textContent = text;
            return b;
        }

        // null byte 转义：纵深防御，防止 C-string 语义下截断字符串字面量
        // U+2028/U+2029 在 ES3 字符串字面量中是行终止符，未转义会让 evalScript 解析失败
        function _escPath(p) {
            return String(p || '')
                .replace(/\\/g, '\\\\')
                .replace(/"/g, '\\"')
                .replace(/\n/g, '\\n')
                .replace(/\r/g, '\\r')
                .replace(/\t/g, '\\t')
                .replace(/\0/g, '\\0')
                .replace(/\u2028/g, '\\u2028')
                .replace(/\u2029/g, '\\u2029');
        }

        var tb = document.createElement('div');
        tb.className = 'assets-toolbar';
        var btnImport = _mkBtn(AEI18n.t('导入'), 'secondary');
        tb.appendChild(btnImport);
        var hint = document.createElement('span');
        hint.className = 'assets-toolbar-hint';
        hint.textContent = AEI18n.t('或拖入文件');
        tb.appendChild(hint);
        var btnRefresh = _mkBtn('↻', 'secondary');
        btnRefresh.style.marginLeft = 'auto';
        btnRefresh.title = AEI18n.t('刷新');
        tb.appendChild(btnRefresh);
        var btnClearCache = _mkBtn(AEI18n.t('清缓存'), 'secondary');
        btnClearCache.title = AEI18n.t('清除转码缓存');
        btnClearCache.style.marginLeft = '6px';
        var btnArchive = _mkBtn(AEI18n.t('归档区'), 'secondary');
        btnArchive.title = AEI18n.t('查看归档区（7 天后自动清理，可恢复/立即清理）');
        btnArchive.addEventListener('click', function () { _openArchivePanel(); });
        var btnCleanMissing = _mkBtn(AEI18n.t('清理索引'), 'secondary');
        btnCleanMissing.title = AEI18n.t('清理丢失索引（原文件不存在但索引仍在的条目）');
        btnCleanMissing.addEventListener('click', function () {
            _cleanMissing();
        });
        tb.appendChild(btnArchive);
        tb.appendChild(btnCleanMissing);
        tb.appendChild(btnClearCache);
        pane.appendChild(tb);
        btnImport.addEventListener('click', function () {
            var input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = 'image/*,video/*,audio/*';
            input.addEventListener('change', function (ev) {
                var files = ev.target.files;
                if (!files || !files.length) return;
                _importFiles(files);
            });
            input.click();
        });
        btnRefresh.addEventListener('click', _reload);
        btnClearCache.addEventListener('click', function () {
            var cacheDir = (dataDir || '').replace(/[\\\/]+$/,'') + '/temp/transcoded';
            // 只清理转码产物（带统一前缀标识 'tc_' 的 .webm）；无标识符的非缓存文件保留且静默跳过
            var isCacheName = function (n) {
                return typeof n === 'string' && n.indexOf('tc_') === 0 && /\.webm$/i.test(n);
            };
            // 体积由 Bridge 侧 statSync 提供（CEP 运行时的 cep.fs.stat 不带 size 字段）：优先
            // AEFS.listFilesWithSize（只走 Bridge，拿不到返回 null），回退 AEFS.listFiles 名单，
            // 此时弹窗标注「大小未知」而不是按 0 显示。
            var sized = (global.AEFS && typeof global.AEFS.listFilesWithSize === 'function')
                ? global.AEFS.listFilesWithSize(cacheDir).catch(function () { return null; })
                : Promise.resolve(null);
            sized.then(function (detailed) {
                if (Array.isArray(detailed)) {
                    var entries = [], total = 0;
                    for (var i = 0; i < detailed.length; i++) {
                        var e = detailed[i];
                        if (!e || !isCacheName(e.name)) continue;
                        var sz = Number(e.size) || 0;
                        entries.push({ name: e.name, size: sz });
                        total += sz;
                    }
                    return _confirmClearCache(cacheDir, entries, total, true);
                }
                return global.AEFS.listFiles(cacheDir).then(function (files) {
                    var entries2 = (Array.isArray(files) ? files : []).filter(isCacheName).map(function (n) {
                        return { name: n, size: 0 };
                    });
                    return _confirmClearCache(cacheDir, entries2, 0, false);
                });
            }).catch(function () {
                if (global.AEToast) AEToast.warn(AEI18n.t('清理缓存失败'));
            });

            // 确认并逐条删除。sizeKnown=false（Bridge 体积清单不可用）时弹窗明示大小未知
            function _confirmClearCache(dir, entries, totalSize, sizeKnown) {
                if (!entries.length) {
                    if (global.AEToast) AEToast.info(AEI18n.t('转码缓存为空'));
                    return;
                }
                var sizeText = sizeKnown
                    ? AEI18n.t('（共 {size}）', { size: _fmtSize(totalSize) })
                    : AEI18n.t('（大小未知）');
                return global.showConfirm(AEI18n.t('清除转码缓存'), AEI18n.t('清除 ') + entries.length + AEI18n.t(' 个转码缓存文件') + sizeText + AEI18n.punct('？', '?', null, null, null, ' ?')).then(function (ok) {
                    if (!ok) return;
                    var delCount = 0;
                    var failCount = 0;
                    var freed = 0;
                    var deleted = {};   // 归一化路径 → true（只记真删成功的产物）
                    (function next(i) {
                        if (i >= entries.length) {
                            // 内存映射同步失效：done 条目指向的产物已删，复用会把坏 URL 塞进
                            // <video>；在途（running）条目保留——转码尚未落定、界面还绑着它的
                            // 进度回调；删失败的产物仍在磁盘，其 done 条目一并保留（避免无谓重转）
                            if (delCount > 0) {
                                var kept = {};
                                for (var k in _transcodeMap) {
                                    var en = _transcodeMap[k];
                                    if (!en || en.status === 'running') { kept[k] = en; continue; }
                                    var wp = en.webmPath ? String(en.webmPath).replace(/\\/g, '/') : '';
                                    if (!wp || !deleted[wp]) kept[k] = en;
                                }
                                _transcodeMap = kept;
                            }
                            if (global.AEToast) {
                                // 0 成功不能报绿色成功（全失败时磁盘上什么都没删）；部分失败在
                                // toast 里给出失败数，成功数与释放大小只累计真删成功的项
                                if (delCount === 0) {
                                    AEToast.warn(AEI18n.t('未能清除缓存（0/') + entries.length + AEI18n.punct('）', ')'));
                                } else {
                                    AEToast.success(AEI18n.t('已清除 ') + delCount + AEI18n.t(' 个缓存')
                                        + (sizeKnown ? AEI18n.punct('（', ' (') + _fmtSize(freed) + AEI18n.punct('）', ')') : '')
                                        + (failCount > 0 ? AEI18n.t('，失败 ') + failCount + AEI18n.t(' 个') : ''));
                                }
                            }
                            return;
                        }
                        var fp = dir + '/' + entries[i].name;
                        global.AEFS.deleteFile(fp).then(function (ok2) {
                            if (ok2) {
                                delCount++;
                                freed += entries[i].size || 0;
                                deleted[String(fp).replace(/\\/g, '/')] = true;
                            } else {
                                failCount++;
                            }
                            next(i + 1);
                        }).catch(function () { failCount++; next(i + 1); });
                    })(0);
                });
            }
        });

        // dropzone（treeView 容器）
        var dz = document.createElement('div');
        dz.className = 'assets-dropzone';
        pane.appendChild(dz);

        var _fh = global.AEAssetsShared.createFolderViewHelpers({
            store: store,
            refresh: function () { _refresh(); },
            confirmMsg: {
                folderDeleteBody: function (fp) { return '删除文件夹「' + fp + '」？内含素材将一并删除（仅删引用，不删原文件）。'; }
            },
            importFolderToAE: _importFolderToAE,
            renderItemContextmenu: function (item, x, y) {
                var r = item._raw || item;
                var count = _tv.getSelectedCount();
                var menu;
                if (count > 1) {
                    menu = [
                        { label: '导入AE (' + count + ')', action: 'batchImportAE' },
                        { label: '归档选中 (' + count + ')', action: 'batchDelete', danger: true }
                    ];
                } else {
                    menu = [{ label: AEI18n.t('重命名'), action: 'rename' }];
                    if (r.type === 'video' || r.type === 'image') menu.push({ label: AEI18n.t('全屏播放'), action: 'fullscreen' });
                    menu.push({ label: AEI18n.t('导入AE'), action: 'importToAE' });
                    menu.push({ label: AEI18n.t('打开所在位置'), action: 'openLocation' });
                    menu.push({ label: AEI18n.t('归档'), action: 'delete', danger: true });
                }
                global.AEAssetsShared.showAssetsMenu(x, y, menu, function (act) {
                    if (act === 'batchDelete') _batchDelete();
                    else if (act === 'batchImportAE') _batchImportAE();
                    else if (act === 'rename') _tv.beginRename(item.id);
                    else if (act === 'fullscreen') _fullscreen(item.id);
                    else if (act === 'importToAE') _importToAE(item.id).catch(function (e) { if (global.AEToast) AEToast.error(AEI18n.t('导入AE失败: ') + (e.message || e)); });
                    else if (act === 'openLocation') _openLocation(item.id);
                    else if (act === 'delete') _delete(item.id);
                });
            }
        });
        var _newFolder = _fh._newFolder;
        var _moveFolder = _fh._moveFolder;
        var _renameFolderPrompt = _fh._renameFolderPrompt;
        var _archiveFolderPrompt = _fh._archiveFolderPrompt;
        var _openArchivePanel = _fh._openArchivePanel;
        var _archivedCount = _fh._archivedCount || function () { return 0; };

        // 视频格子封面用的预览协作件（懒建：预览是附加物，缺它不该让素材库构造失败）。
        // 本库的封面由 Bridge ffmpeg 抽帧产出，回收在 refStore 载入期做（见 refStore._previewStore）。
        var _coverPv = null;
        function _coverStore() {
            if (_coverPv) return _coverPv;
            var SH = global.AEAssetsShared;
            if (!SH || typeof SH.createPreviewStore !== 'function') return null;
            _coverPv = SH.createPreviewStore({ AEFS: global.AEFS, dataDir: dataDir, lib: 'asset-refs' });
            return _coverPv;
        }

        var _treeBaseOpts = _fh.folderTreeViewOpts;
        _tv = global.AEAssetsShared.createTreeView({
            container: dz,
            onSelect: function (id) { _onSelect(id); },
            itemLabel: function (it) { return it.name; },
            itemIcon: function (it) {
                var r = it._raw || it;
                if (r.sequence) return '🎞️';
                if (r.type === 'image') return '🖼️';
                if (r.type === 'video') return '🎬';
                if (r.type === 'audio') return '🎵';
                return '📄';
            },
            // 网格模式缩略图：本库直接指向外部原文件——图片与序列帧出首帧图（静态缩略图，
            // 序列帧的 originalPath 即首帧路径）；视频返回 videoUrl → 格子 hover 时播放
            // （见 treeView._attachGridVideoHover）；音频不提供（回落 itemIcon）。
            itemThumb: function (it) {
                var r = it._raw || it;
                if (!r.originalPath) return null;
                var toUrl = global.AEShared && global.AEShared.toFileUrl;
                if (typeof toUrl !== 'function') return null;
                var u = toUrl(r.originalPath);
                if (!u) return null;
                if (r.type === 'image') {
                    // 序列帧首帧多为 4K 级 PNG：网格缩略图走降采样缓存（异步产出），
                    // 生成期间不加载原图——原图整批解码会卡滚动
                    if (r.sequence) {
                        var st = _coverStore();
                        var p = (st && typeof st.ensureImageCover === 'function')
                            ? st.ensureImageCover(r.id, r.originalPath) : null;
                        return { url: u, asyncThumbUrl: p || Promise.resolve(null) };
                    }
                    return { url: u };
                }
                if (r.type === 'video') return { videoUrl: u, movPath: r.originalPath };
                return null;
            },
            // 网格视频格子的静态封面：Bridge ffmpeg 抽一帧（CEF 88 解不出画面的源——本机
            // 素材库的 mjpeg mov——在面板侧拿不到像素，抽帧只能在能解码的一侧做），落盘到
            // 预览根后长期命中；拿不到（无 ffmpeg/探测失败）就保持图标态。
            videoCover: function (it, thumb) {
                var pv = _coverStore();
                if (!pv) return null;
                var r = it._raw || it;
                var p = (thumb && thumb.movPath) || r.originalPath;
                if (!p) return null;
                return pv.ensureVideoCover(it.id, p);
            },
            // 网格视频格子解码失败（CEF 88 解不了 HEVC 等）→ 转码兜底后换源播放。
            // 与详情区/全屏同一条转码链（transcodeMov 有磁盘缓存，第二次起直接命中）。
            // hint：treeView 给的转码文案句柄（`show(text)/hide()`），位置与生命周期都在那一层。
            // 只在进度回调报 running（= ffmpeg 真在转）时才 show——缓存命中那条路只有
            // exists 命中 + 换源（实测真机 09:39:41 那组全程 ~8ms），上文案就是"闪一下"
            // 转码失败由 catch 收掉，首帧到位/移出由 treeView 收。
            onThumbVideoUnplayable: function (v, it, thumb, hint) {
                if (!_autoTranscodeEnabled()) return;   // 自动转码关闭：格子保持静态封面
                if (!v || v.dataset.fbLoading) return;
                if (!(global.AEAssetsShared && typeof global.AEAssetsShared.transcodeMov === 'function')) return;
                var movPath = (thumb && thumb.movPath) || (it._raw || it).originalPath;
                if (!movPath) return;
                v.dataset.fbLoading = '1';
                var transcodedDir = (dataDir || '').replace(/[\\\/]+$/, '') + '/temp/transcoded';
                var maxWidth = 854;
                try {
                    var mw = localStorage.getItem('assets.transcodeMaxWidth');
                    if (mw != null) { var p = parseInt(mw, 10); if (!isNaN(p)) maxWidth = p; }
                } catch (_) {}
                global.AEAssetsShared.transcodeMov(movPath, transcodedDir, function (p) {
                    if (p && p.status === 'running' && hint) hint.show(AEI18n.t('转码中…'));
                }, maxWidth).then(function (webmPath) {
                    if (!v.isConnected) return;   // 已移出：不复活
                    v.src = 'file:///' + String(webmPath).replace(/\\/g, '/');
                    try {
                        var pr = v.play();
                        if (pr && typeof pr.catch === 'function') pr.catch(function () {});
                    } catch (_) {}
                }).catch(function (err) {
                    // 转码失败：格子回落到封面（不弹错——hover 预览失败不该打断浏览）
                    if (hint) hint.hide();
                    console.warn('[ffmpeg-fb] 网格缩略图转码失败: ' + (err && err.message ? err.message : err));
                });
            },
            renderDetail: function (it) { return _renderDetail(it); },
            isEditing: function () { return !!(_tv && _tv.isEditing && _tv.isEditing()); },
            nameForEdit: function (it) { return (it._raw || it).name || ''; },
            onRename: function (id, newName) {
                return store.rename(id, newName).then(function () {
                    _refresh(); _tv.select(id);
                });
            },
            onRenameFolder: function (folderPath, newName) {
                var fp = String(folderPath || '').replace(/^\/+|\/+$/g, '');
                var slashIdx = fp.lastIndexOf('/');
                var newPath = slashIdx >= 0 ? fp.slice(0, slashIdx + 1) + newName : newName;
                return store.renameFolder(fp, newPath).then(function () { _refresh(); });
            },
            onNewItem: function (type, parentPath, name) {
                var fullPath = parentPath ? (parentPath + '/' + name) : name;
                return store.createFolder(fullPath).then(function () { _refresh(); });
            },
            onDragStart: function (item, e) {
                e.dataTransfer.setData('application/x-ae-assets', item.id);
                e.dataTransfer.effectAllowed = 'move';
            },
            onFolderDragStart: _treeBaseOpts.onFolderDragStart,
            onDragOver: _treeBaseOpts.onDragOver,
            onDrop: _treeBaseOpts.onDrop,
            onContextmenu: _treeBaseOpts.onContextmenu,
            extraFolders: _treeBaseOpts.extraFolders,
            onBlankContextmenu: _treeBaseOpts.onBlankContextmenu,
            onDetailAction: _handleDetailAction,
            // 大图标模式双击预览图 = 格子右上角 ↗ 同一个动作（导入AE）。走 _handleDetailAction
            // 而不是另调 _importToAE：act 字面量与 rowActions 同源，日后改动作只改一处。
            onPreviewActivate: function (it) { _handleDetailAction('importAE', it.id); },
            previewActionLabel: AEI18n.t('导入'),
            rowActions: function (it) { return '<span class="assets-row-act" data-act="importAE" data-id="' + _esc(it.id) + '" title="' + AEI18n.t('导入AE') + '">↗</span>'; }
        });

        if (_fh.setInlineCallbacks) _fh.setInlineCallbacks(_tv.beginNewItem, _tv.beginRenameFolder);
        if (_fh.setTreeView) _fh.setTreeView(_tv);

        // 拖拽导入：仅外部文件拖入时高亮，内部 DnD 不触发
        _handlers.dragover = function (e) {
            var dt = e.dataTransfer;
            if (dt && dt.types && (dt.types.indexOf('application/x-ae-assets') !== -1 || dt.types.indexOf('application/x-ae-folder-move') !== -1)) return;
            e.preventDefault();
            dz.classList.add('dragover');
        };
        _handlers.dragleave = function () {
            dz.classList.remove('dragover');
        };
        _handlers.drop = function (e) {
            e.preventDefault();
            dz.classList.remove('dragover');
            var dt = e.dataTransfer;
            // 内部 DnD 由 treeView 处理
            if (dt && dt.types && (dt.types.indexOf('application/x-ae-assets') !== -1 || dt.types.indexOf('application/x-ae-folder-move') !== -1)) return;
            if (!dt || !dt.files || !dt.files.length) return;
            _importFiles(dt.files);
        };
        dz.addEventListener('dragover', _handlers.dragover);
        dz.addEventListener('dragleave', _handlers.dragleave);
        dz.addEventListener('drop', _handlers.drop);

        async function _importFiles(files) {
            if (!files || !files.length) return;
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            var total = files.length;
            var okCount = 0, failCount = 0, skipCount = 0;
            var cancelled = false;
            // 超过阈值才显示进度条（少量导入静默处理）
            var notice = (files.length > NOTICE_THRESHOLD) && global.AENotice ? global.AENotice.show({
                id: 'assets-refs-import',
                title: AEI18n.t('导入素材'),
                message: AEI18n.t('正在检测…'),
                tone: 'info',
                dismissible: false,
                progress: 0,
                actions: [
                    { label: AEI18n.t('取消'), type: 'secondary', onClick: function () { cancelled = true; }, keepOpen: false }
                ],
                onClose: function (result) {
                    if (result && result.action === AEI18n.t('取消')) cancelled = true;
                }
            }) : null;
            // 强制让出主线程一次，浏览器先重绘出 notice，再进入后续扫描。
            // （AEFS 的 isFile 等为“同步 XHR + Promise.resolve”假异步，await 不产生 macrotask，
            //   若不主动让出，notice 会被后续假异步占满主线程而迟迟不显示）
            await new Promise(function (r) { setTimeout(r, 0); });

            // ── 文件夹模式：单条 + 是目录 → 递归扫描，保留文件夹层级 ──
            // 注意：AEFS.listFiles 对普通文件路径也返回 []（服务端 readdirSync 抛 ENOTDIR 后兜底），
            // 必须先用 isFile 排除普通文件，否则单文件拖入会被误判为空文件夹。
            if (files.length === 1 && files[0].path) {
                var maybeDir = String(files[0].path || '').replace(/\\/g, '/');
                try {
                    var isSingleFile = await global.AEFS.isFile(maybeDir);
                    var testList = (isSingleFile === true) ? null : await global.AEFS.listFilesAsync(maybeDir);
                    if (Array.isArray(testList)) {
                        var dirName = maybeDir.replace(/\/+$/, '').split('/').pop();
                        // 文件夹模式：files.length 恒为 1，无法在顶部按数量判断；
                        // 扫描本身可能是最耗时的阶段，先展示进度，扫描后再按实际数量决定是否关闭。
                        if (notice == null && global.AENotice) {
                            notice = global.AENotice.show({
                                id: 'assets-refs-import',
                                title: AEI18n.t('导入素材'),
                                message: AEI18n.t('正在扫描…'),
                                tone: 'info',
                                dismissible: false,
                                progress: 0,
                                actions: [
                                    { label: AEI18n.t('取消'), type: 'secondary', onClick: function () { cancelled = true; }, keepOpen: false }
                                ],
                                onClose: function (result) {
                                    if (result && result.action === AEI18n.t('取消')) cancelled = true;
                                }
                            });
                        }
                        if (notice && global.AENotice) global.AENotice.update('assets-refs-import', { message: AEI18n.t('正在扫描…') });
                        var scanned = [];
                        var scanFolders = {};
                        var baseLen = maybeDir.replace(/\/+$/, '').length + 1;
                        await _scanMediaDir(maybeDir, baseLen, scanned, scanFolders, function (n) {
                            if (notice && global.AENotice) {
                                global.AENotice.update('assets-refs-import', { message: '正在扫描… ' + n });
                            }
                        }, function () { return cancelled; });
                        // 扫描耗时较长，是取消的主要窗口：已取消则直接收尾，
                        // 跳过确认弹窗 / 序列识别 / 建虚拟文件夹 / 导入循环
                        if (cancelled) {
                            _busy = false; if (notice) notice.close(); notice = null;
                            if (global.AEToast) AEToast.info(AEI18n.t('已取消（已导入 ') + okCount + AEI18n.t(' 个）'));
                            return;
                        }
                        if (!scanned.length) {
                            _busy = false; if (notice) notice.close(); notice = null;
                            if (global.AEToast) AEToast.warn(AEI18n.t('未找到支持的媒体文件'));
                            return;
                        }
                        // 扫描完成后：实际文件数未超阈值则静默（关闭扫描进度条）
                        if (scanned.length <= NOTICE_THRESHOLD && notice) {
                            notice.close();
                            notice = null;
                        }
                        // 批量导入确认：文件数超阈值先征询（已取消则不再弹窗，直接走收尾）
                        if (scanned.length > IMPORT_WARN_COUNT && !cancelled) {
                            var goScan = await global.showConfirm(AEI18n.t('批量导入确认'), AEI18n.t('即将导入 ') + scanned.length + AEI18n.t(' 个文件，可能需要较长时间，是否继续？'), 'confirm');
                            if (!goScan) { _busy = false; if (notice) notice.close(); return; }
                            // 超阈值确认后立即刷新进度，覆盖建文件夹/序列帧识别前的准备阶段空档
                            if (notice && global.AENotice) {
                                global.AENotice.update('assets-refs-import', {
                                    message: '正在导入… 0/' + scanned.length,
                                    progress: 0,
                                    progressLabel: '0/' + scanned.length
                                });
                            }
                        }
                        // 文件夹名作为虚拟文件夹根 + 路径前缀
                        if (dirName) {
                            // 把 _scanMediaDir 收集的相对路径 key 都重命名为 dirName 前缀下
                            var oldKeys = Object.keys(scanFolders);
                            for (var ok = 0; ok < oldKeys.length; ok++) {
                                delete scanFolders[oldKeys[ok]];
                                scanFolders[dirName + '/' + oldKeys[ok]] = true;
                            }
                            scanFolders[dirName] = true;
                            for (var si = 0; si < scanned.length; si++) {
                                scanned[si].folder = scanned[si].folder ? dirName + '/' + scanned[si].folder : dirName;
                            }
                        }
                        // ── 序列帧识别：检测到连续编号图片时，询问用户是否作为序列帧导入 ──
                        // 默认按单图导入；用户确认后才合并为序列（避免普通编号图被误判）。
                        var seqCandidates = _detectSequences(scanned);
                        if (seqCandidates.length > 0 && !cancelled) {
                            var goSeq = await global.showConfirm(
                                AEI18n.t('序列帧识别'),
                                AEI18n.t('检测到 ') + seqCandidates.length + AEI18n.t(' 组连续编号图片，是否将它们作为序列帧导入？'),
                                'confirm'
                            );
                            if (goSeq) {
                                var seqSet = {};
                                seqCandidates.forEach(function (sc) {
                                    sc.framePaths.forEach(function (fp) { seqSet[fp] = true; });
                                });
                                var merged = [];
                                seqCandidates.forEach(function (sc) {
                                    merged.push({
                                        path: sc.path, folder: sc.folder,
                                        _seq: { count: sc.count, prefix: sc.prefix, ext: sc.ext }
                                    });
                                });
                                for (var mi = 0; mi < scanned.length; mi++) {
                                    if (seqSet[scanned[mi].path]) continue;
                                    merged.push(scanned[mi]);
                                }
                                scanned = merged;
                            }
                        }
                        // 导入每个文件：先收集，末尾一次批量落盘
                        total = scanned.length;
                        if (notice && global.AENotice) global.AENotice.update('assets-refs-import', { message: '正在导入… 0/' + total, progress: 0, progressLabel: '0/' + total });
                        var pendingItems = [];
                        // 姊妹入口（拖文件夹）：扫描结果直接入列而不经 _collectImport 校验时——
                        // 含 ' / % / 控制字符的路径 AEFS._checkPath 恒拒（exists 恒 false），入库即永久
                        // missing + 「已导入 N」假成功。复用 bootstrap 导出的同一判据；不通过计入现有
                        // skipCount 并跳过入列（跳过项不计入「已导入 N」），每文件各给一条可读原因。
                        // 计数结构对齐多文件模式（done = 待入列 + 跳过）：进度含跳过项、恒 ≤100% 不卡条
                        var _scanPathFn = global.AEAssetsShared && global.AEAssetsShared.checkOriginalPath;
                        for (var si = 0; si < scanned.length; si++) {
                            if (cancelled) break;
                            var sf = scanned[si];
                            var _sfBad = (typeof _scanPathFn === 'function') ? _scanPathFn(sf.path) : null;
                            if (_sfBad) {
                                if (global.AEToast) AEToast.warn(String(_sfBad) + '：' + String(sf.path).replace(/\\/g, '/').split('/').pop());
                                skipCount++;
                            } else {
                                var pi = { originalPath: sf.path, mime: '', size: 0, folder: sf.folder };
                                if (sf._seq) { pi.name = sf._seq.prefix; pi.sequence = sf._seq; }
                                pendingItems.push(pi);
                            }
                            var doneF = pendingItems.length + skipCount;
                            if (notice && global.AENotice) {
                                global.AENotice.update('assets-refs-import', {
                                    message: '正在导入… ' + doneF + '/' + total,
                                    progress: Math.round(doneF / total * 100),
                                    progressLabel: doneF + '/' + total
                                });
                            }
                            await new Promise(function (r) { setTimeout(r, 5); });
                        }
                        // 建虚拟文件夹：放在导入循环之后，取消时跳过——
                        // 条目 folder 字段本身能在树上派生文件夹显示（refStore.add 不依赖 .folders.json 记录），
                        // 不建记录可避免取消后 0 条导入时 .folders.json 残留空文件夹
                        // 快照既有空文件夹记录——addBatch 失败的补偿清理只删本次新建的
                        var scanFolderList = Object.keys(scanFolders);
                        var scanPreEmpty = {};
                        (store.listEmptyFolders() || []).forEach(function (e) { scanPreEmpty[e] = true; });
                        var scanCreated = [];
                        // 全部被跳过（pendingItems 空）时不建记录：无条目引用这批文件夹会成树上
                        // 幽灵空目录（对齐多文件模式「只按待导入条目的 folder 建」的口径）
                        if (!cancelled && pendingItems.length) {
                            for (var vf = 0; vf < scanFolderList.length; vf++) {
                                if (!scanPreEmpty[scanFolderList[vf]]) scanCreated.push(scanFolderList[vf]);
                                try { await store.createFolder(scanFolderList[vf]); } catch (_) {}
                            }
                        }
                        // 批量落盘：一次 _save 替代逐条 add 的 N 次全量重写
                        if (pendingItems.length) {
                            try {
                                await store.addBatch(pendingItems);
                                okCount = pendingItems.length;
                            } catch (_) {
                                failCount += pendingItems.length;
                                // 落盘失败补偿清理本次新建的虚拟文件夹记录——条目未
                                // 入库，这些记录成为无条目引用的幽灵空文件夹（树上残留）；
                                // 先前已存在的记录与有条目引用的文件夹不受影响
                                for (var sc = scanCreated.length - 1; sc >= 0; sc--) {
                                    try { await store.deleteEmptyFolder(scanCreated[sc]); } catch (_) {}
                                }
                            }
                        }
                        _busy = false;
                        if (notice) notice.close();
                        _refresh();
                        // 对齐多文件模式：取消/落盘失败单独提示，不误报成功
                        if (cancelled) {
                            if (global.AEToast) AEToast.info(AEI18n.t('已取消（已导入 ') + okCount + AEI18n.t(' 个）'));
                        } else if (okCount > 0) {
                            if (global.AEToast) AEToast.success(AEI18n.t('已导入 ') + okCount + AEI18n.t(' 个文件'));
                        } else if (failCount > 0) {
                            if (global.AEToast) AEToast.warn(AEI18n.t('导入失败: ') + failCount + '/' + total);
                        } else if (skipCount > 0) {
                            // 与多文件模式同一套 skipped 汇总提示（全部被路径校验拦下时说明原因）
                            if (global.AEToast) AEToast.warn(AEI18n.t('未导入任何文件（全部跳过）'));
                        } else {
                            if (global.AEToast) AEToast.warn(AEI18n.t('未导入任何文件'));
                        }
                        return;
                    }
                } catch (_) {}
            }

            // ── 多文件模式 ──
            // 本次新建的虚拟文件夹记录（addBatch 失败的补偿清理用）
            var multiCreatedFolders = [];
            try {
                // 批量导入确认：文件数超阈值先征询
                if (files.length > IMPORT_WARN_COUNT && !cancelled) {
                    var goMulti = await global.showConfirm(AEI18n.t('批量导入确认'), AEI18n.t('即将导入 ') + files.length + AEI18n.t(' 个文件，可能需要较长时间，是否继续？'), 'confirm');
                    if (!goMulti) return;   // 外层 finally 复位 _busy 并关闭 notice
                    // 超阈值确认后立即刷新进度，覆盖建文件夹/序列帧识别前的准备阶段空档
                    if (notice && global.AENotice) {
                        global.AENotice.update('assets-refs-import', {
                            message: '正在导入… 0/' + total,
                            progress: 0,
                            progressLabel: '0/' + total
                        });
                    }
                }
                var map = global.AEAssetsShared.deriveFolderMap(files);
                var pendingItems = [];
                // ── 序列帧识别（多选）：检测到连续编号图片时询问用户，默认按单图导入 ──
                var mergeSeqSet = null;
                var multiScanned = [];
                for (var ms = 0; ms < files.length; ms++) {
                    if (!files[ms].path) continue;
                    multiScanned.push({ path: files[ms].path, folder: map.fileFolders[ms] || '' });
                }
                var multiSeqs = _detectSequences(multiScanned);
                if (multiSeqs.length > 0 && !cancelled) {
                    var goSeqM = await global.showConfirm(AEI18n.t('序列帧识别'), AEI18n.t('检测到 ') + multiSeqs.length + AEI18n.t(' 组连续编号图片，是否将它们作为序列帧导入？'), 'confirm');
                    if (goSeqM) {
                        // 组项不在主循环前入列：成员文件会在循环内经 mergeSeqSet 各计一次（skipCount），
                        // 组项提前入列会与成员双重计数使进度超 100%，故改在主循环结束后统一入列
                        mergeSeqSet = {};
                        multiSeqs.forEach(function (sc) {
                            sc.framePaths.forEach(function (fp) { mergeSeqSet[String(fp)] = true; });
                        });
                    }
                }
                for (var i = 0; i < files.length; i++) {
                    if (cancelled) break;
                    var r = _collectImport(files[i], map.fileFolders[i] || '');
                    if (r && r._skipped) skipCount++;
                    // 已确认合并的序列帧：跳过单条（_detectSequences 已把路径归一化为正斜杠）
                    else if (r && mergeSeqSet && mergeSeqSet[String(r.originalPath || '').replace(/\\/g, '/')]) skipCount++;
                    else pendingItems.push(r);
                    var done = pendingItems.length + skipCount + failCount;
                    if (notice && global.AENotice) {
                        global.AENotice.update('assets-refs-import', {
                            message: '正在导入… ' + done + '/' + total,
                            progress: Math.round(done / total * 100),
                            progressLabel: done + '/' + total
                        });
                    }
                    // 让出主线程给浏览器渲染进度条（sync Bridge 操作不产生 macrotask 间隙）
                    await new Promise(function (r) { setTimeout(r, 5); });
                }
                // 序列组项主循环后入列：成员文件已在循环内经 mergeSeqSet 命中各计一次（skipCount），
                // 保证每个文件恰好计一次，正常完成时 done === total（进度不超 100%）
                // E2E-2 第三入口：序列组项以首帧路径入列（不进主循环，不参与 done/total 计数），
                // 同样须过路径判据——首帧含 ' / % / 控制字符时组项入库即永久 missing。成员文件
                // 已在主循环各计一次 skipCount，组项跳过无需补计，进度口径不变
                if (mergeSeqSet) {
                    var _seqPathFn = global.AEAssetsShared && global.AEAssetsShared.checkOriginalPath;
                    multiSeqs.forEach(function (sc) {
                        var _seqBad = (typeof _seqPathFn === 'function') ? _seqPathFn(sc.path) : null;
                        if (_seqBad) {
                            if (global.AEToast) AEToast.warn(String(_seqBad) + '：' + String(sc.path).replace(/\\/g, '/').split('/').pop());
                            return;
                        }
                        pendingItems.push({
                            originalPath: sc.path, mime: '', size: 0, folder: sc.folder,
                            name: sc.prefix, sequence: { count: sc.count, prefix: sc.prefix, ext: sc.ext }
                        });
                    });
                }
                // 建虚拟文件夹：放在导入循环之后，取消时跳过（对齐文件夹模式同函数的修复）——
                // 条目 folder 字段本身能在树上派生文件夹显示（refStore.add 不依赖 .folders.json 记录），
                // 先建记录会让「已取消 / 全部跳过」的导入在 .folders.json 残留空文件夹记录（树上幽灵空目录）
                if (!cancelled && pendingItems.length) {
                    var foldersToCreate = {};
                    for (var fc = 0; fc < pendingItems.length; fc++) {
                        var fSegs = String(pendingItems[fc].folder || '').split('/');
                        var fAcc = '';
                        for (var fsi = 0; fsi < fSegs.length; fsi++) {
                            if (!fSegs[fsi]) continue;
                            fAcc = fAcc ? fAcc + '/' + fSegs[fsi] : fSegs[fsi];
                            foldersToCreate[fAcc] = true;
                        }
                    }
                    var folderList = Object.keys(foldersToCreate);
                    // 快照既有空文件夹记录——补偿清理只删本次新建的
                    var folderPreEmpty = {};
                    (store.listEmptyFolders() || []).forEach(function (e) { folderPreEmpty[e] = true; });
                    for (var vfi = 0; vfi < folderList.length; vfi++) {
                        if (!folderPreEmpty[folderList[vfi]]) multiCreatedFolders.push(folderList[vfi]);
                        try { await store.createFolder(folderList[vfi]); } catch (_) { /* 已存在则忽略 */ }
                    }
                }
                // 批量落盘：一次 _save 替代逐条 add 的 N 次全量重写
                if (pendingItems.length) {
                    try {
                        await store.addBatch(pendingItems);
                        okCount = pendingItems.length;
                    } catch (e) {
                        console.warn('[Assets] 批量写索引失败: ' + (e && e.message ? e.message : e));
                        failCount += pendingItems.length;
                        // 落盘失败补偿清理本次新建的虚拟文件夹记录——条目未入库，
                        // 这些记录成为无条目引用的幽灵空文件夹（树上残留）；先前已存在的
                        // 记录与有条目引用的文件夹不受影响
                        for (var mc = multiCreatedFolders.length - 1; mc >= 0; mc--) {
                            try { await store.deleteEmptyFolder(multiCreatedFolders[mc]); } catch (_) {}
                        }
                    }
                }
            } finally {
                _busy = false;
                if (notice) notice.close();
                notice = null;
            }
            _refresh();
            if (cancelled) {
                var msg2 = AEI18n.t('已取消（已导入 {n} 个）', { n: okCount });
                if (failCount > 0) msg2 += AEI18n.t('，{n} 失败', { n: failCount });
                if (skipCount > 0) msg2 += AEI18n.t('，{n} 跳过', { n: skipCount });
                if (global.AEToast) AEToast.info(msg2);
            } else if (okCount > 0) {
                if (global.AEToast) AEToast.success(AEI18n.t('已导入 ') + okCount + AEI18n.t(' 个文件'));
            } else if (failCount > 0) {
                if (global.AEToast) AEToast.warn(AEI18n.t('导入失败: ') + failCount + '/' + total);
            } else if (skipCount > 0) {
                if (global.AEToast) AEToast.warn(AEI18n.t('未导入任何文件（全部跳过）'));
            } else {
                if (global.AEToast) AEToast.warn(AEI18n.t('未导入任何文件'));
            }
        }

        // 递归扫描目录，找出所有支持的媒体文件 + 文件夹层级
        async function _scanMediaDir(dirPath, baseLen, out, folders, onProgress, isCancelled) {
            // 扫描阶段取消检查：入口即止，递归调用自然短路
            if (isCancelled && isCancelled()) return;
            var list = await global.AEFS.listFilesAsync(dirPath);
            if (Array.isArray(list)) {
                for (var l = 0; l < list.length; l++) {
                    var type = global.AEAssetsShared.detectType(list[l], '');
                    if (!type) continue;
                    var absPath = (dirPath + '/' + list[l]).replace(/\\/g, '/');
                    var rel = absPath.slice(baseLen);
                    var lastSlash = rel.lastIndexOf('/');
                    var relFolder = lastSlash >= 0 ? rel.slice(0, lastSlash) : '';
                    if (relFolder) {
                        var parts = relFolder.split('/');
                        var acc = '';
                        for (var p = 0; p < parts.length; p++) {
                            acc = acc ? acc + '/' + parts[p] : parts[p];
                            folders[acc] = true;
                        }
                    }
                    out.push({ path: absPath, folder: relFolder });
                    if (onProgress) onProgress(out.length);
                }
            }
            var subDirs = await global.AEFS.listDirsAsync(dirPath);
            if (Array.isArray(subDirs)) {
                for (var d = 0; d < subDirs.length; d++) {
                    await _scanMediaDir(dirPath + '/' + subDirs[d], baseLen, out, folders, onProgress, isCancelled);
                }
            }
        }

        // 序列帧识别：按目录分组，找「同前缀 + 连续数字编号 + 同扩展名」的图片组。
        // 仅当连续编号（步进 1）≥2 张才判为序列，规避单张编号图 / 日期命名的误判。
        // 编号位宽参与分组：无前导零（x1..x10 自然增长）归同组；有前导零按位数分组（x001/x002 一组），
        // 避免 x01 与 x001 这类同号不同位宽的帧混编（parseInt 抹平位宽后同号帧会拆散序列/误并组员）。
        // 返回候选序列数组：[{ path(首帧), folder, count, prefix, ext, framePaths:[...] }]
        function _detectSequences(scanned) {
            var byKey = {}; // folder|prefix|ext|padKey -> { list:[{num,path}], prefix, ext, folder }
            (Array.isArray(scanned) ? scanned : []).forEach(function (s) {
                var p = String(s.path || '').replace(/\\/g, '/');
                if (global.AEAssetsShared.detectType(p, '') !== 'image') return;
                var m = p.match(/([^/]*?)(\d+)(\.\w+)$/);
                if (!m) return;
                var prefix = m[1], numStr = m[2], num = parseInt(numStr, 10), ext = m[3];
                if (!prefix) return; // 要求有前缀，规避纯数字命名
                // 前导零形态：z+位数（x001 → z3）；无前导零统一 n（x1..x10 跨十位不拆组）
                var padKey = numStr.charAt(0) === '0' ? ('z' + numStr.length) : 'n';
                var key = (s.folder || '') + '|' + prefix + '|' + ext + '|' + padKey;
                var entry = byKey[key];
                if (!entry) { entry = byKey[key] = { list: [], prefix: prefix, ext: ext, folder: s.folder }; }
                entry.list.push({ num: num, path: p });
            });
            var seqs = [];
            function _pushSeq(entry, seg) {
                if (seg.length >= 2) {
                    seqs.push({
                        path: seg[0].path,
                        folder: entry.folder,
                        count: seg.length,
                        prefix: entry.prefix,
                        ext: entry.ext,
                        framePaths: seg.map(function (x) { return x.path; })
                    });
                }
            }
            Object.keys(byKey).forEach(function (key) {
                var entry = byKey[key];
                var arr = entry.list.slice().sort(function (a, b) { return a.num - b.num; });
                // 切分连续段：数字差 1 视为连续
                var seg = [arr[0]];
                for (var i = 1; i < arr.length; i++) {
                    if (arr[i].num === seg[seg.length - 1].num + 1) seg.push(arr[i]);
                    else { _pushSeq(entry, seg); seg = [arr[i]]; }
                }
                _pushSeq(entry, seg);
            });
            return seqs;
        }

        // 收集单个文件导入参数（类型/路径校验），不落盘。批量导入末尾统一 addBatch。
        function _collectImport(file, folder) {
            folder = folder || '';
            var path = file.path;
            if (!path) {
                if (global.AEToast) AEToast.warn(AEI18n.t('该文件无路径信息，跳过: ') + file.name);
                return { _skipped: true };
            }
            // E2E-2：路径含 ' / % / 控制字符时 AEFS._checkPath 恒拒（exists 恒 false）——
            // 放行入库只会得到"已导入 N 个文件"的假成功 + 条目永久 missing。入库前复用 LLM
            // 侧同一校验函数（bootstrap 导出），走既有 _skipped 链路给出一条可读原因。
            var _pathFn = global.AEAssetsShared && global.AEAssetsShared.checkOriginalPath;
            var _pathBad = (typeof _pathFn === 'function') ? _pathFn(path) : null;
            if (_pathBad) {
                if (global.AEToast) AEToast.warn(String(_pathBad) + '：' + file.name);
                return { _skipped: true };
            }
            var type = global.AEAssetsShared.detectType(file.name, file.type);
            if (!type) {
                if (global.AEToast) AEToast.warn(AEI18n.t('不支持的类型: ') + file.name);
                return { _skipped: true };
            }
            return { originalPath: path, mime: file.type, size: file.size || 0, folder: folder };
        }

        function _refresh() {
            if (_destroyed) return;
            _tv.render(store.list().map(function (it) {
                return { id: it.id, name: it.name, folder: it.folder, type: it.type, _raw: it };
            }));
            // 归档区按钮计数（删除=归档）
            var archN = _archivedCount();
            btnArchive.textContent = archN > 0 ? (AEI18n.t('归档区 (') + archN + ')') : AEI18n.t('归档区');
        }

        function _onSelect(id) {
            // 懒检测 missing
            var gen = ++_selectGen;
            var items = store.list();
            var it = null;
            for (var i = 0; i < items.length; i++) { if (items[i].id === id) { it = items[i]; break; } }
            if (!it) return;
            // 单点 exists 无法区分「真不存在」与「通道故障」——AEFS.exists 的
            // ExtendScript 回退对 CSInterface 未定义/超时/异常均 resolve(false)，通道故障
            // 误标 missing 落盘后叠加 cleanMissing 会误删引用（只修了批量路径，
            // 单点未覆盖）。调用前快照 AEFS.lastError()，false 且 lastError 有新增 →
            // 通道故障不落 missing 标记（方向偏安全：宁可不标也不误删）
            var _errBefore = (global.AEFS && typeof global.AEFS.lastError === 'function') ? global.AEFS.lastError() : '';
            global.AEFS.exists(it.originalPath).then(function (ok) {
                if (_destroyed || gen !== _selectGen) return;   // 过期（用户已选别项）
                if (ok === false && !it.missing) {
                    var _errNow = (global.AEFS && typeof global.AEFS.lastError === 'function') ? global.AEFS.lastError() : '';
                    if (_errNow && _errNow !== _errBefore) {
                        console.warn('[Assets] exists 通道故障，跳过 missing 标记: ' + _errNow);
                        return;
                    }
                    // return 内层 promise → 接入外层 .catch，setMissing 持久化失败不再成 unhandled rejection
                    return store.setMissing(id, true).then(function () {
                        if (_destroyed || gen !== _selectGen) return;
                        // 行内重命名/新建进行中不重渲染。render 与 renderList 都走
                        // _renderLeftOnly → innerHTML='' 重建左树，会销毁行内编辑器（移除聚焦元素
                        // 不触发 blur，正在输入的名称静默丢失）且 _editingId 残留 stale 拦截后续行点击
                        // （treeView 折叠箭头守卫注释同款结论）。missing 标记已持久化，行数据经 _raw
                        // 活引用在下一次重建（提交/取消重命名）时自然带出
                        // 行内重命名或备注编辑中跳过全量刷新（重建会销毁正在输入的元素）
                        if (_tv && _tv.isEditing && _tv.isEditing()) return;
                        if (_notesEditing) return;
                        _refresh(); _tv.select(id);
                    });
                } else if (ok === true && it.missing) {
                    return store.setMissing(id, false).then(function () {
                        if (_destroyed || gen !== _selectGen) return;
                        // 行内重命名或备注编辑中跳过全量刷新（重建会销毁正在输入的元素）
                        if (_tv && _tv.isEditing && _tv.isEditing()) return;
                        if (_notesEditing) return;
                        _refresh(); _tv.select(id);
                    });
                }
            }).catch(function (e) {
                // exists 或 setMissing 失败：非致命，记日志不打断用户
                console.warn('[Assets] setMissing 链失败: ' + (e && e.message ? e.message : e));
            });
        }

        function _renderDetail(it) {
            _previewSuppressed = false;   // 详情重建恢复自动播放（进全屏/卡被盖住的抑制到此结束）
            if (!it) return AEI18n.html('<div class="assets-empty-state"><div class="assets-empty-state-icon">📄</div><div class="assets-empty-state-text">未选中</div></div>');
            var r = it._raw || it;
            var url = global.AEShared.toFileUrl(r.originalPath);
            var typeLabel = { image: AEI18n.t('图片'), video: AEI18n.t('视频'), audio: AEI18n.t('音频') }[r.type] || r.type;
            if (r.sequence) typeLabel = AEI18n.t('图像序列');
            var preview = '';
            var seqRow = r.sequence ? '<div class="assets-detail-row"><span class="k">' + AEI18n.t('帧数') + '</span><span class="v">' + _esc(AEI18n.t('{n} 帧', { n: r.sequence.count })) + '</span></div>' : '';
            if (r.missing) {
                preview = '<div class="assets-empty assets-empty-inline assets-empty-warn">' + AEI18n.t('原文件已丢失') + '</div>';
            } else if (r.type === 'image') {
                var seqMeta = _sequenceMeta(r);
                if (seqMeta) {
                    // 序列帧：首帧出图后由 pane 的 load 捕获监听启动逐帧循环播放；
                    // data-seq-* 即帧参数（目录/前缀/扩展名/帧数/起始号/位宽）。
                    // 不挂内联 onerror：播放中偶发单帧失败会把整个预览替换成提示文本。
                    // decoding=async：逐帧换 src 时解码放到解码线程，不阻塞滚动与其它渲染。
                    preview = '<img src="' + _esc(url) + '" decoding="async"'
                        + ' data-seq-dir="' + _esc(seqMeta.dir) + '"'
                        + ' data-seq-prefix="' + _esc(seqMeta.prefix) + '"'
                        + ' data-seq-ext="' + _esc(seqMeta.ext) + '"'
                        + ' data-seq-count="' + seqMeta.count + '"'
                        + ' data-seq-start="' + seqMeta.start + '"'
                        + ' data-seq-width="' + seqMeta.width + '">';
                } else {
                    preview = '<img src="' + _esc(url) + '" decoding="async" onerror="this.parentNode.textContent=\'' + _esc(AEI18n.t('⚠ 无法加载')) + '\'">';
                }
            } else if (r.type === 'video') {
                // 点击条目后预览区自动静音循环播放；播放交互只在预览区内，声音通过点击后的
                // lightbox 播放：
                //  · 不带 controls：CEF 88 原生控制条的"点画面切换播放"会和整块点击抢手势
                //    （点击打开 lightbox 与点击播放会重叠）
                //  · muted：自动播放策略只放行静音；HEVC 这类文件音频轨正常、画面解不出，
                //    出声会出现"转码期间仍有声音"的问题
                //  · loop：短片循环播放，不必手动重播
                //  · pointer-events:none（见 assets.css）：点击一律落到外层容器走全屏
                //  · preload=auto：metadata 就绪即起播，首帧不再等待点击
                // data-movpath 保留：无画面/报错时转去转码兜底（_onPreviewVideoUnplayable）
                preview = '<video preload="auto" muted autoplay loop src="' + _esc(url) + '" data-movpath="' + _esc(r.originalPath) + '"></video><div class="mov-fallback" style="display:none;width:100%"></div>';
            } else if (r.type === 'audio') {
                preview = '<audio controls src="' + _esc(url) + '" style="width:100%"></audio>';
            } else {
                preview = '<div class="assets-empty-state"><div class="assets-empty-state-icon">📄</div><div class="assets-empty-state-text">' + _esc(r.type) + '</div></div>';
            }
            // 全屏入口：图片与视频都整块可点（不采用「全屏」角标，点击区为整块预览）。
            // 预览 video 无 controls 且 pointer-events:none，点击语义只有"进全屏"一种，
            // 不会顺带切换播放态。
            // audio/other 不开全屏：点预览区会开出空白黑色 lightbox
            var fsAttr = (r.type === 'video' || r.type === 'image')
                ? ' data-act="fullscreen" data-id="' + _esc(r.id) + '" style="cursor:pointer" title="' + _esc(AEI18n.t('点击全屏')) + '"'
                : '';
            return '<div class="assets-detail">'
                // 预览区（点击即全屏）
                + '<div class="assets-detail-preview"' + fsAttr + '>' + preview + '</div>'
                // 元数据卡片
                + '<div class="assets-detail-section">'
                + '<div class="assets-detail-section-title">' + AEI18n.t('详情') + '</div>'
                + '<div class="assets-detail-section-body">'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('名称') + '</span><span class="v">' + _esc(r.name) + '</span></div>'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('类型') + '</span><span class="v">' + _esc(typeLabel) + '</span></div>'
                + seqRow
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('路径') + '</span><span class="v">' + _esc(r.originalPath) + '</span></div>'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('大小') + '</span><span class="v">' + _fmtSize(r.size || 0) + '</span></div>'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('添加时间') + '</span><span class="v">' + _esc(r.addedAt || '') + '</span></div>'
                + '</div></div>'
                // 操作按钮
                + '<div class="assets-detail-actions">'
                + '<button class="btn btn-slice secondary" data-act="importAE" data-id="' + _esc(r.id) + '">' + AEI18n.t('导入AE') + '</button>'
                + '<button class="btn btn-slice secondary" data-act="delete" data-id="' + _esc(r.id) + '">' + AEI18n.t('归档') + '</button>'
                + '</div>'
                // 备注（三库统一字段；失焦保存，上限 2000 与工具面一致）
                + '<textarea class="assets-ref-notes" data-id="' + _esc(r.id) + '" maxlength="2000" placeholder="' + _esc(AEI18n.t('备注…')) + '">' + _esc(r.notes || '') + '</textarea>'
                + '</div>';
        }

        // 备注编辑态：focusin 置位（抑制重渲染打断输入），focusout 失焦保存
        var _notesEditing = false;
        pane.addEventListener('focusin', function (e) {
            if (e.target && e.target.classList && e.target.classList.contains('assets-ref-notes')) _notesEditing = true;
        });
        pane.addEventListener('focusout', function (e) {
            if (!e.target || !e.target.classList || !e.target.classList.contains('assets-ref-notes')) return;
            _notesEditing = false;
            var id = e.target.getAttribute('data-id');
            if (id) _saveNotes(id, e.target.value);
        });

        function _saveNotes(id, notes) {
            store.updateMeta(id, { notes: notes || '' }).then(function () {
                // 只刷新右栏保留编辑焦点；全量 render 会替换 textarea 打断输入
                if (_tv && _tv.refreshDetail) _tv.refreshDetail();
            }).catch(function (e) {
                if (global.AEToast) AEToast.error(AEI18n.t('保存备注失败: ') + (e && e.message ? e.message : e));
            });
        }

        function _handleDetailAction(act, id) {
            if (act === 'fullscreen') _fullscreen(id);
            else if (act === 'importAE') _importToAE(id).catch(function (e) { if (global.AEToast) AEToast.error(AEI18n.t('导入AE失败: ') + (e.message || e)); });
            else if (act === 'delete') _delete(id);
        }

        function _fmtSize(bytes) {
            if (!bytes) return '0 B';
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
            return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
        }

        function _delete(id) {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            var it = store.list().filter(function (x) { return x.id === id; })[0];
            if (!it) { _busy = false; return; }
            global.showConfirm(AEI18n.t('归档素材'), AEI18n.t('确定归档「') + it.name + AEI18n.t('」？仅移入库内归档区（不删外部原文件），7 天后自动清理，期间可在「归档区」面板恢复。'), 'confirm').then(function (ok) {
                if (!ok) { _busy = false; return; }
                store.archive([id]).then(function (res) {
                    _busy = false; _refresh();
                    // 单条归档也要消费回执 failures：store._archiveInner 复制/删源/归档区创建
                    // 失败时不抛错，只把失败写进 res.failures 后 resolve——不查会弹假成功
                    // （单条入口不读 failures，与预设/工程素材两个姊妹入口口径对齐）。
                    // 分档与文案对齐同库批量路径与 presetView._deleteConfirmed
                    var arch = (res && res.archived) || [];
                    var miss = (res && res.missing) || [];
                    var fails = (res && res.failures) || [];
                    var doneN = arch.length + miss.length;
                    if (fails.length) {
                        var err0 = (fails[0] && fails[0].error) ? fails[0].error : AEI18n.t('未知错误');
                        if (doneN > 0) {
                            if (global.AEToast) AEToast.warn(AEI18n.t('归档完成（') + doneN + AEI18n.t(' 成功，') + fails.length + AEI18n.t(' 条部分失败警告）: ') + err0);
                        } else {
                            if (global.AEToast) AEToast.error(AEI18n.t('归档失败: ') + err0);
                        }
                        return;
                    }
                    if (miss.length) { if (global.AEToast) AEToast.info(AEI18n.punct('「', '"', '「', '„', '“', '« ', '«') + it.name + AEI18n.t('」无实体文件，已移除索引条目')); return; }
                    if (global.AEToast) AEToast.success(AEI18n.t('已归档「') + it.name + AEI18n.t('」（7 天后自动清理）'));
                }).catch(function (e) { _busy = false; if (global.AEToast) AEToast.error(AEI18n.t('归档失败: ') + (e && e.message ? e.message : e)); });
            });
        }

        async function _cleanMissing() {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            var notice = global.AENotice ? global.AENotice.show({
                id: 'assets-ref-scan-missing',
                title: AEI18n.t('扫描丢失素材'),
                message: AEI18n.t('正在扫描丢失文件…'),
                tone: 'info',
                dismissible: false
            }) : null;
            try {
                await store.scanMissing();
            } catch (_) {}
            if (_destroyed) { _busy = false; if (notice) notice.close(); return; }
            if (notice) notice.close();
            _busy = false;
            var missing = store.listMissing();
            if (missing.length === 0) {
                if (global.AEToast) AEToast.info(AEI18n.t('没有丢失索引的素材'));
                return;
            }
            _refresh();
            global.showConfirm(
                AEI18n.t('清理丢失索引'),
                AEI18n.t('检测到 ') + missing.length + AEI18n.t(' 个素材的原文件已丢失（索引仍在）。确定清理这些索引条目？此操作仅删除索引，不影响其他素材。'),
                'confirm'
            ).then(function (ok) {
                if (!ok) return;
                _busy = true;
                store.cleanMissing().then(function (res) {
                    _busy = false;
                    _refresh();
                    if (global.AEToast) AEToast.success(AEI18n.t('已清理 ') + res.cleaned + AEI18n.t(' 个丢失索引'));
                }).catch(function (e) {
                    _busy = false;
                    if (global.AEToast) AEToast.error(AEI18n.t('清理失败: ') + (e && e.message ? e.message : e));
                });
            }).catch(function () { /* 用户关闭对话框，_busy 已为 false */ });
        }

        function _openLocation(id) {
            var it = store.list().filter(function (x) { return x.id === id; })[0];
            if (!it || !it.originalPath) return;
            var folderPath = it.originalPath.replace(/[\\/][^\\/]+$/, '');
            if (!folderPath) return;
            if (typeof CSInterface === 'undefined') { if (global.AEToast) AEToast.warn(AEI18n.t('请在 AE 中打开扩展面板')); return; }
            var safePath = _escPath(folderPath);
            new CSInterface().evalScript(
                '(function(){var f=new Folder("' + safePath + '");if(!f.exists){return "NOT_EXISTS";}return f.execute()?"OK":"FAIL";})();',
                function (res) {
                    var r = String(res || '').trim();
                    if (r === 'NOT_EXISTS') { if (global.AEToast) AEToast.warn(AEI18n.t('目录不存在: ') + folderPath); }
                    else if (r !== 'OK') { if (global.AEToast) AEToast.warn(AEI18n.t('打开目录失败: ') + folderPath); }
                }
            );
        }

        function _batchDelete() {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            var ids = _tv.getSelectedIds();
            if (!ids.length) return;
            _busy = true;
            global.showConfirm(AEI18n.t('批量归档'), AEI18n.t('确定归档选中的 ') + ids.length + AEI18n.t(' 个素材？移入库内归档区（不删外部原文件），7 天后自动清理，期间可恢复。'), 'danger').then(function (ok) {
                if (!ok) { _busy = false; return; }
                var total = ids.length;
                var deleted = 0, failed = 0, missingRemoved = 0;
                var cancelled = false;
                var notice = (total > NOTICE_THRESHOLD) && global.AENotice ? global.AENotice.show({
                    id: 'assets-refs-archive',
                    title: AEI18n.t('归档素材'),
                    message: AEI18n.t('正在归档… {done}/{total}', { done: 0, total: total }),
                    tone: 'warn',
                    dismissible: false,
                    progress: 0,
                    progressLabel: '0/' + total,
                    actions: [
                        { label: AEI18n.t('取消'), type: 'secondary', onClick: function () { cancelled = true; }, keepOpen: false }
                    ],
                    onClose: function (result) {
                        if (result && result.action === AEI18n.t('取消')) cancelled = true;
                    }
                }) : null;
                setTimeout(function () {
                    (function next(i) {
                        if (cancelled || i >= ids.length) {
                            _busy = false; _refresh();
                            if (notice) notice.close();
                            if (cancelled) {
                                if (global.AEToast) AEToast.info(AEI18n.t('已取消（已归档 ') + deleted + '/' + total + AEI18n.punct('）', ')'));
                            } else if (failed > 0) {
                                // 部分失败必须如实汇报（对齐 folderViewMixin._archiveFolders），
                                // 否则失败条目仍留在库里，用户却看到"已归档 N 个"的成功提示
                                if (global.AEToast) AEToast.error(AEI18n.t('归档完成（') + deleted + AEI18n.t(' 成功，') + failed + AEI18n.t(' 失败）'));
                            } else {
                                var _mi = missingRemoved ? AEI18n.t('；另移除丢失索引 {n} 条（无实体可归档）', { n: missingRemoved }) : '';
                                if (global.AEToast) AEToast.success(AEI18n.t('已归档 ') + deleted + AEI18n.t(' 个素材') + _mi + AEI18n.t('（7 天后自动清理）'));
                            }
                            return;
                        }
                        // 分块调用 store.archive（每块一次索引落盘；块内逐条成败由返回结果记账）
                        var chunk = ids.slice(i, i + 20);
                        store.archive(chunk).then(function (res) {
                            deleted += (res && res.archived) ? res.archived.length : chunk.length;
                            missingRemoved += (res && res.missing) ? res.missing.length : 0;
                            failed += (res && res.failures) ? res.failures.length : 0;
                            _updateRd();
                            setTimeout(function () { next(i + chunk.length); }, 5);
                        }).catch(function () {
                            failed += chunk.length;
                            _updateRd();
                            setTimeout(function () { next(i + chunk.length); }, 5);
                        });
                    })(0);
                }, 30);
                function _updateRd() {
                    if (notice && global.AENotice) {
                        var d = deleted + failed;
                        global.AENotice.update('assets-refs-archive', {
                            message: AEI18n.t('正在归档… {done}/{total}', { done: d, total: total }),
                            progress: Math.round(d / total * 100),
                            progressLabel: d + '/' + total
                        });
                    }
                }
            });
        }

        function _batchImportAE() {
            var ids = _tv.getSelectedIds();
            if (!ids.length) return;
            _importIdList(ids);
        }

        function _importFolderToAE(folderPath) {
            var fp = String(folderPath || '').replace(/^\/+|\/+$/g, '');
            var items = store.list().filter(function (it) {
                if (!fp) return !it.folder;
                return it.folder === fp || it.folder.indexOf(fp + '/') === 0;
            });
            if (!items.length) { if (global.AEToast) AEToast.warn(AEI18n.t('文件夹为空')); return; }
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            // 以选中文件夹为根，计算相对 folder 路径
            // 例：选中 "3/2"，条目 folder="3/2" → "2"，folder="3/2/sub" → "2/sub"
            var prefixLen = fp.length;
            var slashIdx = fp.lastIndexOf('/');
            var rootName = slashIdx >= 0 ? fp.slice(slashIdx + 1) : fp;
            global.AEAssetsShared.importFilesToAE(hostApi, items.map(function (x) {
                var rel = x.folder || '';
                if (rel === fp) rel = rootName;
                else if (fp.length > 0 && rel.indexOf(fp + '/') === 0) rel = rootName + '/' + rel.slice(prefixLen + 1);
                return { path: x.originalPath, folder: rel, asSequence: !!x.sequence };
            })).then(function (r) {
                _busy = false;
                var msg = AEI18n.t('已导入AE: {done}/{total}', { done: r.ok, total: r.ok + r.fail });
                if (r.fail > 0) msg += AEI18n.t('（{n} 失败）', { n: r.fail });
                if (global.AEToast) AEToast[r.ok > 0 ? 'success' : 'error'](msg);
                if (r.renames && r.renames.length) {
                    setTimeout(function () {
                        var parts = r.renames.map(function (x) { return x.orig + ' → ' + x.renamed; });
                        if (global.AEToast) AEToast.warn(AEI18n.t('AE 中已有同名文件夹，已重命名: ') + parts.join('、'));
                    }, 400);
                }
            }).catch(function (e) {
                _busy = false;
                if (global.AEToast) AEToast.error(AEI18n.t('导入AE失败: ') + (e && e.message ? e.message : e));
            });
        }

        function _importIdList(ids) {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            var allItems = store.list();
            var items = [];
            for (var i = 0; i < ids.length; i++) {
                for (var j = 0; j < allItems.length; j++) {
                    if (allItems[j].id === ids[i]) {
                        items.push({ path: allItems[j].originalPath, folder: '', asSequence: !!allItems[j].sequence });
                        break;
                    }
                }
            }
            if (!items.length) { _busy = false; return; }
            var notice = (items.length > NOTICE_THRESHOLD) && global.AENotice ? global.AENotice.show({
                id: 'assets-refs-importAE',
                title: AEI18n.t('导入AE'),
                message: AEI18n.t('正在导入 {n} 个素材…', { n: items.length }),
                tone: 'info',
                dismissible: false
            }) : null;
            global.AEAssetsShared.importFilesToAE(hostApi, items).then(function (r) {
                _busy = false;
                if (notice) notice.close();
                var msg = AEI18n.t('已导入AE: {done}/{total}', { done: r.ok, total: r.ok + r.fail });
                if (r.fail > 0) msg += AEI18n.t('（{n} 失败）', { n: r.fail });
                if (global.AEToast) AEToast[r.ok > 0 ? 'success' : 'error'](msg);
            }).catch(function (e) {
                _busy = false;
                if (notice) notice.close();
                if (global.AEToast) AEToast.error(AEI18n.t('导入AE失败: ') + (e && e.message ? e.message : e));
            });
        }

        function _fullscreen(id) {
            var it = store.list().filter(function (x) { return x.id === id; })[0];
            if (!it) return;
            // 类型守卫：仅 video/image 支持全屏（与右键菜单一致），防御存量调用误开空白 lightbox
            if (it.type !== 'video' && it.type !== 'image') return;
            // 进全屏前停掉预览自动播放：否则 lightbox 打开后预览区仍在背后解码播放
            _stopPreviewPlayback();
            _openLightbox(global.AEShared.toFileUrl(it.originalPath), it.type === 'video', it.originalPath, dataDir);
        }

        function _importToAE(id, silent) {
            // silent=true 由 _importIdList 批量调用，_busy 由其统一管理
            if (!silent && _busy) {
                if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待'));
                return Promise.reject(new Error('busy'));
            }
            if (!silent) _busy = true;
            var it = store.list().filter(function (x) { return x.id === id; })[0];
            if (!it) { if (!silent) _busy = false; return Promise.reject(new Error(AEI18n.t('素材不存在'))); }
            if (!hostApi) { if (!silent) _busy = false; return Promise.reject(new Error(AEI18n.t('ExtendScript 桥未就绪'))); }
            return global.AEAssetsShared.importFilesToAE(hostApi, [{
                path: it.originalPath, folder: '', asSequence: !!it.sequence
            }]).then(function (r) {
                if (!silent) _busy = false;
                if (r.ok > 0) {
                    if (!silent && global.AEToast) AEToast.success(AEI18n.t('已导入AE'));
                    return;
                }
                throw new Error(AEI18n.t('导入失败'));
            }).catch(function (e) {
                if (!silent) _busy = false;
                throw e;
            });
        }

        function onActive() {
            // 卡回到顶层：onCovered 清了 media src，这里只重渲染详情恢复媒体。
            // 不调 _refresh（全量重建树 + 重置选中）——树数据在被盖住期间不变，重建会闪。
            if (_tv && _tv.refreshDetail) _tv.refreshDetail();
        }
        function onCovered() {
            // CEF 88 点竖条不夺焦，编辑中切卡须主动 blur-save（对齐 presetView/projectAssetView 同款）——
            // 备注只在 focusout 落盘，被覆盖后 textarea 收不到 blur，不主动保存则关闭面板即丢输入
            if (_notesEditing) {
                var nta = pane.querySelector('.assets-ref-notes');
                if (nta) { var nid = nta.getAttribute('data-id'); if (nid) _saveNotes(nid, nta.value); }
                _notesEditing = false;
            }
            // 卡被盖住：清当前选中项媒体 src，停止后台解码/播放
            _stopPreviewPlayback();
            _closeLightbox();
            var id = _tv ? _tv.getSelected() : null;
            if (!id) return;
            var preview = pane.querySelector('.assets-detail-preview');
            if (preview) {
                var v = preview.querySelector('video'); if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {} }
                var img = preview.querySelector('img'); if (img) img.removeAttribute('src');
            }
        }


        async function init() {
            var overlay = global.AEAssetsShared.createLoadingOverlay(dz);
            try {
                await store.load();
                if (_destroyed) return;
                _refresh();
            } finally {
                overlay.hide();
            }
        }

        async function _reload() {
            if (_busy) return;
            _busy = true;
            var overlay = global.AEAssetsShared.createLoadingOverlay(dz);
            try {
                // 刷新失败不能吞错后仍提示"已刷新"（对齐 presetView/projectAssetView._reload）
                try { await store.load(); }
                catch (e) {
                    if (global.AEToast) AEToast.error(AEI18n.t('刷新失败: ') + (e && e.message ? e.message : e));
                    return;
                }
                if (_destroyed) return;
                _refresh();
                if (global.AEToast) AEToast.info(AEI18n.t('已刷新'));
            } finally {
                overlay.hide();
                _busy = false;
            }
        }

        function destroy() {
            _destroyed = true;
            _closeLightbox();
            if (_currentMovPlayer) { _currentMovPlayer.destroy(); _currentMovPlayer = null; }
            _stopPreviewPlayback();   // 卸载前停掉详情预览的自动播放（移除元素不会自动暂停）
            dz.removeEventListener('dragover', _handlers.dragover);
            dz.removeEventListener('dragleave', _handlers.dragleave);
            dz.removeEventListener('drop', _handlers.drop);
            if (_tv) _tv.destroy();
            pane.innerHTML = '';
        }

        return { init: init, destroy: destroy, refresh: _refresh, pane: pane, onActive: onActive, onCovered: onCovered };
    }

    global.AEAssetsShared.createRefView = createRefView;
})(window);
