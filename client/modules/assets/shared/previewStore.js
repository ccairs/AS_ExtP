// previewStore.js — 素材库预览图的缩图落盘、路径拼装、删除与载入期回收
//
// 位置与职责：预设库与工程素材库在保存入库时各截 1 帧当前合成画面（ae-tools 的
// getPreviewFrame 单帧路径），本模块把 AE 侧产出的全分辨率 PNG 缩成小图、写进预览根，
// 并把「路径拼装 / 删除 / 回收」三件事收在一处。两库同形——路径、删除、GC 走同一份
// 代码，只有库名不同，故落盘位置统一在库外的独立根目录：
//
//   <dataDir>/assets/previews/<lib>/<itemId>/preview.jpg      lib ∈ presets | project-assets | asset-refs
//
// 引用库（asset-refs）走同一条路径与同一份回收：它的封面不是 AE 截的，而是 Bridge
// ffmpeg 抽视频一帧（CEF 解不出画面的源在面板侧拿不到像素，见 ensureVideoCover），
// 落点、文件名、回收口径与另两库完全一致——一份代码覆盖三库。
//
// 为什么不放库内：
//   · 预设条目是共享真实目录树里的裸 .ffx 文件，没有 per-item 目录。做同目录兄弟文件
//     （foo.ffx + foo.jpg）要在 _moveInner / _renameInner / renameFoldersBatch 跨目录
//     路径三处补随迁逻辑，而预设库没有垃圾回收机制 → 孤儿 .jpg 永久残留；且「空文件夹」
//     判据只看 .ffx，孤儿 .jpg 会让目录被判空却 rmdir 不掉。
//   · 工程素材条目虽是目录，但把预览放进去受 classifyDir 结构判定约束——预览不得放
//     子目录（1 .aep + 多子目录 判 invalid，条目目录会被 cleanGarbage 移进垃圾区）。
//   两库统一放库外独立根，换来的是一份代码覆盖两库。
//
// 记录里只存文件名（item.previewFrame.file），不存绝对路径：数据目录迁移后无需改写索引。
(function (global) {
    'use strict';

    var PREVIEW_SUBDIR = 'previews';
    var PREVIEW_FILE = 'preview.jpg';
    // 缩图目标宽（px）。1080p 单帧 PNG 实测约 4.5MB，缩到 320px 宽 + JPEG 0.8 后
    // 单条目约 20–30KB。这一步不是优化而是必需：全分辨率 5MB 量级不能进永久目录。
    var MAX_WIDTH = 320;
    var JPEG_QUALITY = 0.8;
    // 允许的库名（白名单）：库名进路径，不接受调用方传任意串
    var LIBS = ['presets', 'project-assets', 'asset-refs'];
    // 条目 id 白名单：id 也进路径，且 deleteOne/gc 会按它 rmdir——含分隔符或 .. 的 id
    // 必须 fail-closed 拒绝，不能拼出根目录之外的路径（对齐仓库既有路径校验口径）
    var ID_RE = /^[A-Za-z0-9_-]+$/;

    function _fwd(p) { return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, ''); }

    // ── 纯函数：路径拼装 ──

    // 预览根：<dataDir>/assets/previews
    function previewRoot(dataDir) {
        var d = _fwd(dataDir);
        return d ? d + '/assets/' + PREVIEW_SUBDIR : '';
    }

    // 库级目录：<预览根>/<lib>
    function libDir(dataDir, lib) {
        var r = previewRoot(dataDir);
        var l = String(lib == null ? '' : lib);
        return (r && LIBS.indexOf(l) >= 0) ? r + '/' + l : '';
    }

    // 条目级目录：<预览根>/<lib>/<id>
    function itemDir(dataDir, lib, id) {
        var ld = libDir(dataDir, lib);
        var i = String(id == null ? '' : id).trim();
        return (ld && ID_RE.test(i)) ? ld + '/' + i : '';
    }

    // 条目预览图绝对路径。item 需带 id；带 previewFrame.file 时用它，否则用默认名。
    function buildPath(dataDir, lib, item) {
        var dir = itemDir(dataDir, lib, item && item.id);
        if (!dir) return '';
        var f = (item && item.previewFrame && item.previewFrame.file) ? String(item.previewFrame.file) : PREVIEW_FILE;
        // 文件名同样不得含分隔符（记录可能被外部改写）
        if (!f || f.indexOf('/') >= 0 || f.indexOf('\\') >= 0 || f === '.' || f === '..') f = PREVIEW_FILE;
        return dir + '/' + f;
    }

    // 条目预览图的 file:// URL；无 previewFrame 或通道缺失时返回 ''
    function buildUrl(dataDir, lib, item) {
        if (!item || !item.previewFrame) return '';
        var p = buildPath(dataDir, lib, item);
        if (!p) return '';
        var toUrl = global.AEShared && global.AEShared.toFileUrl;
        return (typeof toUrl === 'function') ? toUrl(p) : '';
    }

    // 条目预览图的 file:// URL（不要求 previewFrame 字段）：路径由 lib + id 决定，
    // 文件名缺省即 preview.jpg。引用库的封面即走这条——它没有 AE 截帧记录，
    // 也就不为封面写索引字段（省掉每条目一次索引写）。
    function coverUrlFor(dataDir, lib, item) {
        var p = buildPath(dataDir, lib, item);
        if (!p) return '';
        var toUrl = global.AEShared && global.AEShared.toFileUrl;
        return (typeof toUrl === 'function') ? toUrl(p) : '';
    }

    // ── 缩图（面板侧 canvas；AE 侧没有 canvas）──

    function loadImage(url, mkImage) {
        return new Promise(function (resolve, reject) {
            var im = mkImage();
            im.onload = function () { resolve(im); };
            im.onerror = function () { reject(new Error(AEI18n.t('预览帧加载失败'))); };
            im.src = url;
        });
    }

    function canvasToJpegBlob(canvas) {
        return new Promise(function (resolve, reject) {
            if (typeof canvas.toBlob !== 'function') { reject(new Error(AEI18n.t('canvas.toBlob 不可用'))); return; }
            canvas.toBlob(function (blob) {
                if (blob) resolve(blob);
                else reject(new Error(AEI18n.t('canvas.toBlob 返回空')));
            }, 'image/jpeg', JPEG_QUALITY);
        });
    }

    // base64 PNG → 等比缩到宽 ≤ MAX_WIDTH 的 JPEG Blob
    // deps: { createImage, createCanvas }（测试注入；默认用浏览器 DOM）
    function downscaleToJpeg(base64, mime, deps) {
        deps = deps || {};
        var mkImage = deps.createImage || function () { return new Image(); };
        var mkCanvas = deps.createCanvas || function (w, h) {
            var c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            return c;
        };
        var url = 'data:' + (mime || 'image/png') + ';base64,' + base64;
        return loadImage(url, mkImage).then(function (im) {
            var w = im.naturalWidth || im.width || 0;
            var h = im.naturalHeight || im.height || 0;
            if (!w || !h) throw new Error(AEI18n.t('预览帧尺寸为 0'));
            var scale = Math.min(1, MAX_WIDTH / w);
            var tw = Math.max(1, Math.round(w * scale));
            var th = Math.max(1, Math.round(h * scale));
            var canvas = mkCanvas(tw, th);
            var ctx = canvas.getContext('2d');
            if (!ctx) throw new Error(AEI18n.t('canvas 2d 上下文不可用'));
            ctx.drawImage(im, 0, 0, tw, th);
            return canvasToJpegBlob(canvas);
        });
    }

    // ── 面板侧抓帧 ──
    //
    // 走**工具注册表里已注册的 getPreviewFrame**，不直调 ExtendScript 里的同名函数：
    // 直调没有授权帧，而 getPreviewFrame 的数据目录取自授权帧（`_authFrame.get().dataDir`），
    // 取不到时回落到硬编码 `%APPDATA%\Adobe\CEP\extensions\AS_ExtP`——数据目录非默认时那条
    // 路径没被 ensurePreviewDir 预建，抓帧直接失败（AE 侧对不可用目录是 fail-closed 报错，
    // 不会把不存在的目录交给 saveFrameToPng，故不会卡死 AE，但也拿不到帧）。
    // 注册表里的 handler 自带授权帧、预建目录包装与结果后处理（见 ae-tools/controller.js 的
    // createHandlerOpts），是面板侧调用 AE 工具的正规入口。
    // 返回 getPreviewFrame 的成功回执（{status, filePath, capturedAt, …}）；任一步失败返回 null。
    function captureCurrentFrame(deps) {
        deps = deps || {};
        var ex = deps.toolExecutor || (global.AE_LLM && global.AE_LLM.toolExecutor);
        if (!ex || typeof ex.call !== 'function') return Promise.resolve(null);
        return Promise.resolve(ex.call('getPreviewFrame', {}, '')).then(function (res) {
            if (!res || res.isError) return null;
            var txt = res.content && res.content[0] && res.content[0].text;
            if (!txt) return null;
            var parsed = null;
            try { parsed = JSON.parse(txt); } catch (_) { return null; }
            if (!parsed || parsed.status !== 'success' || !parsed.filePath) return null;
            return parsed;
        }).catch(function () { return null; });
    }

    // 抓帧回执 → 待写盘的小图 { blob, time }。**缩图只做一次**：同一张图要能写到整批的全部
    // 新条目（一次保存可能产出多个 .ffx），故不在这里绑定条目 id。
    // frame 为 getPreviewFrame 的成功回执：{ status, filePath, capturedAt, … }。
    // 注意 capturedAt 字段名是历史遗留，它的值是**合成时间（秒）**而非墙钟时间
    // （aeTools.jsx:5406 `capturedAt: time`，time 即 comp.time）——预览记的是
    // 「这一帧取自合成的哪个时刻」，故直接用它。
    // 缩图成功后立即删临时帧（不等 tempSweep 的 7 天龄清扫）；失败返回 null 并 warn 一行。
    // deps: { aefs, createImage, createCanvas }（测试注入；默认取 global.AEFS / 浏览器 DOM）
    function prepareFrame(frame, deps) {
        deps = deps || {};
        var aefs = deps.aefs || global.AEFS;
        if (!frame || frame.status !== 'success' || !frame.filePath) return Promise.resolve(null);
        if (!aefs || typeof aefs.readImageBase64 !== 'function') return Promise.resolve(null);
        return Promise.resolve(aefs.readImageBase64(frame.filePath)).then(function (r) {
            if (!r || r.success !== true || !r.base64) throw new Error(AEI18n.t('预览帧读取失败'));
            return downscaleToJpeg(r.base64, r.mime, deps);
        }).then(function (blob) {
            // 临时帧用完即删（不等 tempSweep 的 7 天龄清扫）；删失败不阻断——tempSweep 兜底
            try {
                var dp = aefs.deleteFile(frame.filePath);
                if (dp && typeof dp.catch === 'function') dp.catch(function () {});
            } catch (_) {}
            return { blob: blob, time: Number(frame.capturedAt) || 0 };
        }).catch(function (e) {
            console.warn('[previewStore] 预览缩图失败: ' + (e && e.message ? e.message : e));
            return null;
        });
    }

    // ── 视频封面抽帧（引用库）：Bridge ffmpeg 抽一帧 → 预览根 ──
    // 与另两库的差别只在「谁产出这张图」：AE 截当前合成帧换成 ffmpeg 抽视频帧，落点、
    // 命名、删除、回收全同。为什么要 ffmpeg 而不是面板 canvas：CEF 88 解不出画面的源
    // （本机素材库的 mjpeg mov）在 canvas 里拿不到像素——抽帧能力必须落在能解码的一侧。
    var COVER_MAX_WIDTH = MAX_WIDTH;
    // 同时最多 2 个 ffmpeg 在跑：滚动时几十个视频格子一起要封面，不加闸会把 CPU 打满
    var COVER_CONCURRENCY = 2;
    var _coverQueue = [];
    var _coverActive = 0;

    function _pumpCoverQueue() {
        while (_coverActive < COVER_CONCURRENCY && _coverQueue.length) {
            var job = _coverQueue.shift();
            _coverActive++;
            var p;
            try { p = job.task(); } catch (e) { p = Promise.reject(e); }
            // 失败统一收敛成 null（调用方保持图标态），队列不因单个失败停摆
            p.then(function (v) { job.resolve(v); }, function () { job.resolve(null); })
                .then(function () { _coverActive--; _pumpCoverQueue(); });
        }
    }

    function _enqueueCover(task) {
        return new Promise(function (resolve) {
            _coverQueue.push({ task: task, resolve: resolve });
            _pumpCoverQueue();
        });
    }

    // ── store 工厂 ──
    // opts: { AEFS, dataDir, lib, createImage, createCanvas, extractFrame }
    function createPreviewStore(opts) {
        opts = opts || {};
        var _AEFS = opts.AEFS || global.AEFS;
        var dataDir = opts.dataDir || (global.AEShared && global.AEShared.getDataDir ? global.AEShared.getDataDir().dir : '');
        var lib = String(opts.lib || '');
        var deps = { createImage: opts.createImage, createCanvas: opts.createCanvas };
        // 抽帧通道：默认走 Bridge（AEShared.extractVideoFrame），测试可注入
        var _extractFrame = opts.extractFrame || null;

        function _dir(id) { return itemDir(dataDir, lib, id); }
        var _coverInflight = {};   // itemId → 在途/已成功的封面 Promise（见 ensureVideoCover）

        // 抓帧回执 → 待写盘的小图（委托模块级 prepareFrame，共用一份缩图实现）
        function prepareFromFrame(frame) {
            return prepareFrame(frame, { aefs: _AEFS, createImage: deps.createImage, createCanvas: deps.createCanvas });
        }

        // 待写盘小图 → 条目预览目录；返回 previewFrame 记录 { file, time } 或 null。
        // 失败不阻断保存：只记一行，调用方据此不写字段。
        function savePrepared(prepared, itemId) {
            if (!prepared || !prepared.blob) return Promise.resolve(null);
            var dir = _dir(itemId);
            if (!dir) return Promise.resolve(null);
            if (!_AEFS || typeof _AEFS.writeBlob !== 'function') return Promise.resolve(null);
            var dst = dir + '/' + PREVIEW_FILE;
            // mkdir 尽力而为：目录已存在时 mkdir 的返回口径不确定（CEP/ES 两通道不一致），
            // 而重复保存必须能覆盖旧预览——故不拿 mkdir 的返回值当判据，由 writeBlob 定成败
            // （目录真不存在时 writeBlob 会失败，结果同样是"跳过预览、保存照常成功"）。
            return Promise.resolve()
                .then(function () { return _AEFS.mkdir(dir); })
                .catch(function () { return false; })
                .then(function () { return _AEFS.writeBlob(dst, prepared.blob); })
                .then(function (ok) {
                    if (ok !== true) throw new Error(AEI18n.t('预览图写盘失败'));
                    return { file: PREVIEW_FILE, time: prepared.time };
                })
                .catch(function (e) {
                    console.warn('[previewStore] 预览写盘失败(' + lib + '): ' + (e && e.message ? e.message : e));
                    return null;
                });
        }

        // 删单个条目的预览目录（先删文件再 rmdir——AEFS.rmdir 非递归、只接受空目录）。
        // 返回「本次是否确实删掉了东西」：文件删成功或目录 rmdir 成功都算成功；两者都失败
        // 才返回 false（gc 的 failed 列表据此才有意义——恒 true 会让失败被吞成假成功）。
        function deleteOne(id) {
            var dir = _dir(id);
            if (!dir) return Promise.resolve(false);
            if (!_AEFS || typeof _AEFS.deleteFile !== 'function') return Promise.resolve(false);
            var fileOk = false;
            return Promise.resolve()
                .then(function () { return _AEFS.deleteFile(dir + '/' + PREVIEW_FILE); })
                .then(function (r) { fileOk = (r !== false); }, function () { fileOk = false; })
                .then(function () {
                    if (typeof _AEFS.rmdir !== 'function') return false;
                    try { return _AEFS.rmdir(dir); } catch (_) { return false; }
                })
                .then(function (dirOk) { return !!(dirOk !== false || fileOk); },
                    function () { return fileOk; });
        }

        // 视频封面：磁盘命中直接给 URL；没有则排队抽帧。返回 URL 或 null（调用方据此
        // 保持图标态）。同一条目在途只抽一次——格子滚动重渲染会反复问同一批条目。
        // 失败不留在途表（下次渲染可重试），成功留着（省掉重复 exists 往返）。
        function ensureVideoCover(itemId, videoPath) {
            var dir = _dir(itemId);
            var url = coverUrlFor(dataDir, lib, { id: itemId });
            if (!dir || !url || !videoPath) return Promise.resolve(null);
            if (_coverInflight[itemId]) return _coverInflight[itemId];
            var dst = dir + '/' + PREVIEW_FILE;
            var p = Promise.resolve()
                .then(function () { return _AEFS.exists(dst); })
                .then(function (has) {
                    if (has === true) return true;
                    var ex = _extractFrame || (global.AEAssetsShared && global.AEAssetsShared.extractVideoFrame);
                    // 通道缺失（老面板/测试桩）→ 无封面，不假装成功
                    if (typeof ex !== 'function') return false;
                    return _enqueueCover(function () { return ex(videoPath, dst, COVER_MAX_WIDTH); });
                })
                .then(function (ok) { return ok ? url : null; }, function () { return null; });
            _coverInflight[itemId] = p;
            p.then(function (u) { if (!u) delete _coverInflight[itemId]; },
                function () { delete _coverInflight[itemId]; });
            return p;
        }

        // 图片缩略图：源图在面板侧解码后缩到 MAX_WIDTH 落成同目录 preview.jpg。
        // 网格缩略图直接挂原图会整批解码（序列帧首帧常见 4K PNG，实测滚动帧间隔 100ms+），
        // 故大图一律先降采样缓存；命中磁盘直接给 URL，未命中走缩图队列（并发同封面闸）。
        // 与视频封面共用一个落点与在途表口径：同一条目同时只会产出一张 preview.jpg。
        var _imageCoverInflight = {};   // itemId → 在途/已成功的缩略图 Promise
        function ensureImageCover(itemId, srcPath) {
            var dir = _dir(itemId);
            var url = coverUrlFor(dataDir, lib, { id: itemId });
            if (!dir || !url || !srcPath) return Promise.resolve(null);
            if (_imageCoverInflight[itemId]) return _imageCoverInflight[itemId];
            var dst = dir + '/' + PREVIEW_FILE;
            var p = Promise.resolve()
                .then(function () { return _AEFS.exists(dst); })
                .then(function (has) {
                    if (has === true) return true;
                    if (!_AEFS || typeof _AEFS.readImageBase64 !== 'function') return false;
                    return _enqueueCover(function () {
                        return Promise.resolve(_AEFS.readImageBase64(srcPath)).then(function (r) {
                            if (!r || r.success !== true || !r.base64) throw new Error(AEI18n.t('源图读取失败'));
                            return downscaleToJpeg(r.base64, r.mime, deps);
                        }).then(function (blob) {
                            return savePrepared({ blob: blob, time: 0 }, itemId);
                        }).then(function (rec) { return !!rec; });
                    });
                })
                .then(function (ok) { return ok ? url : null; }, function () { return null; });
            _imageCoverInflight[itemId] = p;
            p.then(function (u) { if (!u) delete _imageCoverInflight[itemId]; },
                function () { delete _imageCoverInflight[itemId]; });
            return p;
        }

        // 载入期回收：删掉预览根下不在保留集合内的条目目录。
        // 保留集合由调用方给出（存活 ∪ 已归档的条目 id），故不依赖各删除路径是否挂全——
        // 崩溃中断的删除、cleanMissing、missing 分支的归档、addMeta 覆盖旧 id、
        // _dedupById 重发 id、索引损坏后重建，都由这里兜住。
        function gc(keepIds) {
            var ld = libDir(dataDir, lib);
            if (!ld || !_AEFS || typeof _AEFS.listDirsAsync !== 'function') {
                return Promise.resolve({ removed: 0, failed: [] });
            }
            var keep = {};
            var list = Array.isArray(keepIds) ? keepIds : [];
            for (var i = 0; i < list.length; i++) keep[String(list[i])] = true;
            return Promise.resolve(_AEFS.listDirsAsync(ld)).then(function (dirs) {
                var names = Array.isArray(dirs) ? dirs : [];
                var removed = 0;
                var failed = [];
                return names.reduce(function (chain, name) {
                    return chain.then(function () {
                        var n = String(name);
                        if (keep[n] || !ID_RE.test(n)) return;   // 保留中 / 非条目目录名（不动）
                        return deleteOne(n).then(function (ok) {
                            if (ok) removed++;
                            else failed.push(n);
                        });
                    });
                }, Promise.resolve()).then(function () {
                    return { removed: removed, failed: failed };
                });
            }).catch(function () {
                // 列目录失败不抛：GC 是机会式清扫，不能阻断 load
                return { removed: 0, failed: [] };
            });
        }

        return {
            lib: lib,
            prepareFromFrame: prepareFromFrame,
            savePrepared: savePrepared,
            ensureVideoCover: ensureVideoCover,
            ensureImageCover: ensureImageCover,
            deleteOne: deleteOne,
            gc: gc
        };
    }

    global.AEAssetsShared = global.AEAssetsShared || {};
    global.AEAssetsShared.PREVIEW_FILE = PREVIEW_FILE;
    global.AEAssetsShared.previewRoot = previewRoot;
    global.AEAssetsShared.previewLibDir = libDir;
    global.AEAssetsShared.previewItemDir = itemDir;
    global.AEAssetsShared.previewPathFor = buildPath;
    global.AEAssetsShared.previewUrlFor = buildUrl;
    global.AEAssetsShared.coverUrlFor = coverUrlFor;
    global.AEAssetsShared.downscaleToJpeg = downscaleToJpeg;
    global.AEAssetsShared.captureCurrentFrame = captureCurrentFrame;
    global.AEAssetsShared.preparePreviewFrame = prepareFrame;
    global.AEAssetsShared.createPreviewStore = createPreviewStore;
})(window);
