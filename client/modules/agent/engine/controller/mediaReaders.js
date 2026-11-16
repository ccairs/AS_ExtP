(function (global) {
    'use strict';
    // 媒体读取层拆分。由 controller.js 组装区经 AEEngine.createMediaReaders() 创建。
    // 纯迁移自 controller.js 的 convertPngToJpegViaCanvas / readImageStable / readVideoStable。
    // 依赖 global.AEFS（readImageBase64 异步 / listFilesWithSize / readBlob）与浏览器 document/Image，
    // 无 controller 闭包依赖。
    //
    // 视觉读图链路异步化 + 按需整读：
    //   旧 readImageStable 每轮都 readImageBase64Sync（同步 XHR 整图 base64 + JSON.parse），
    //   且强制「stableCount>=2 且 attempt>=8」才退出 → 同一张图至少整读 9 次。1080p PNG
    //   4.5MB / 8K PNG 10.8MB 的单次整读实测 1–3.5s（极端 15s），全部发生在面板主线程上，
    //   期间整面板冻结（连停止按钮都点不动）；搬运量 ≈ 9×1.33×文件大小。
    //   现改为：① 全程异步（无同步 XHR）；② 先用轻量探测（AEFS.listFilesWithSize →
    //   bridge Node statSync 一次列目录拿 size，零图片载荷）等到「存在且 size>0 连续三次
    //   相同」，之后只做一次整读（PNG 尾部 IEND 未验证视为仍截断，最多补读 3 次兜底）；
    //   ③ 无轻量探测通道时退回保守整读轮询（读仍是异步的，不再冻结面板）。
    //   渐进写入（AE saveFrameToPng 产物）的「未稳定继续等、稳定后返回」语义不变。
    function createMediaReaders(opts) {
        // Canvas 转 JPEG：浏览器原生编码，超尺寸自动缩放，解决 AE 16-bit PNG 兼容问题。
        // 规则本体在共享单点 shared/imageTranscode.js——外接 MCP 的结果图片
        // 走同一份实现，否则同一个大图在两条路上会得到不同大小/质量（外接侧完全不转码时，
        // 直接送原始 PNG base64）。此处保留薄壳：共享模块缺失（旧缓存/极端加载顺序）时回退内联
        // 实现，保证面板内图片投递不会因此失效。
        function convertPngToJpegViaCanvasFallback(pngDataUrl) {
            return new Promise(function(resolve) {
                var img = new Image();
                img.onload = function() {
                    try {
                        var MAX_W = 4096, MAX_H = 2160;
                        var w = img.naturalWidth, h = img.naturalHeight;
                        if (w > MAX_W || h > MAX_H) {
                            var scale = Math.min(MAX_W / w, MAX_H / h);
                            w = Math.round(w * scale);
                            h = Math.round(h * scale);
                        }
                        var c = document.createElement('canvas');
                        c.width = w; c.height = h;
                        var ctx = c.getContext('2d');
                        ctx.fillStyle = '#FFFFFF';
                        ctx.fillRect(0, 0, w, h);
                        ctx.drawImage(img, 0, 0, w, h);
                        resolve(c.toDataURL('image/jpeg', 0.9));
                    } catch (e) {
                        resolve(pngDataUrl); // 转换失败，回退原始 PNG
                    }
                };
                img.onerror = function() {
                    resolve(pngDataUrl); // 图片加载失败，回退原始 PNG
                };
                img.src = pngDataUrl;
            });
        }

        function convertPngToJpegViaCanvas(pngDataUrl) {
            var tx = global.AEImageTranscode;
            if (tx && typeof tx.transcodeDataUrl === 'function') {
                return tx.transcodeDataUrl(pngDataUrl);
            }
            return convertPngToJpegViaCanvasFallback(pngDataUrl);
        }

        // 轮询休眠（裸 setTimeout：测试环境可替换整个沙箱的 setTimeout 替身加速）
        function _sleep(ms) {
            return new Promise(function (r) { setTimeout(r, ms); });
        }

        // Blob → base64（readBlob 异步链兜底用；FileReader 是异步的，不阻塞主线程）
        function blobToBase64(blob) {
            return new Promise(function (resolve) {
                try {
                    var fr = new global.FileReader();
                    fr.onload = function () {
                        var s = String(fr.result || '');
                        var comma = s.indexOf(',');
                        resolve(comma >= 0 ? s.slice(comma + 1) : null);
                    };
                    fr.onerror = function () { resolve(null); };
                    fr.readAsDataURL(blob);
                } catch (e) { resolve(null); }
            });
        }

        // 轻量尺寸探测：不读图片内容——AEFS.listFilesWithSize 走 bridge /fs/list-sizes
        // （Node statSync 一次列目录），拿该文件当前字节数。返回 Promise：
        //   {state:'ok', size}      权威拿到当前 size（可能为 0：AE 渐进写入的 0 字节窗口）
        //   {state:'missing'}       权威确认目录里没有该文件（尚未创建）
        //   {state:'unknown'}       探测通道不可用（bridge 不在/旧缓存无该 API）→ 调用方
        //                           退回保守整读轮询（读已是异步，不再冻结主线程）
        // 不用 AEFS.stat：调用方是 cep.fs.stat 时 size 恒 0（aefs.js 注释已记录），
        // 拿 0 当真实尺寸会把「正常文件」误判成 0 字节窗口。
        function probeFileLight(filePath) {
            var aefs = global.AEFS;
            if (!aefs || typeof aefs.listFilesWithSize !== 'function') {
                return Promise.resolve({ state: 'unknown', size: 0 });
            }
            var dir = filePath.replace(/[\\\/][^\\\/]*$/, '');
            var base = String(filePath.replace(/^.*[\\\/]/, '')).toLowerCase();
            var pending;
            try {
                pending = aefs.listFilesWithSize(dir);
            } catch (e) {
                return Promise.resolve({ state: 'unknown', size: 0 });
            }
            return Promise.resolve(pending).then(function (list) {
                if (!Array.isArray(list)) return { state: 'unknown', size: 0 };
                for (var i = 0; i < list.length; i++) {
                    if (list[i] && String(list[i].name || '').toLowerCase() === base) {
                        return { state: 'ok', size: list[i].size || 0 };
                    }
                }
                return { state: 'missing', size: 0 };
            }).catch(function () { return { state: 'unknown', size: 0 }; });
        }

        // 单次整读（异步优先，绝不阻塞主线程）。返回 Promise<result|null>：
        //   ① AEFS.readImageBase64 —— 生产路径（异步 XHR；含 bridge 侧等稳定/IEND 校验）
        //   ② AEFS.readBlob + FileReader —— 旧版 AEFS 无异步读图 API 时的等价异步链
        //   ③ AEFS.readImageBase64Sync —— 仅当 ①② 都不存在（旧测试桩/极端旧缓存）才回退；
        //      生产 AEFS 始终带 ①②，正常运行不会命中同步通道（同步 XHR 冻结整个面板）。
        function readImageOnce(filePath) {
            var aefs = global.AEFS;
            if (!aefs) return Promise.resolve(null);
            if (typeof aefs.readImageBase64 === 'function') {
                return Promise.resolve().then(function () { return aefs.readImageBase64(filePath); })
                    .catch(function (e) {
                        console.warn('[Vision-HOOK] readImageBase64 异常: ' + ((e && e.message) || e));
                        return null;
                    });
            }
            if (typeof aefs.readBlob === 'function' && typeof global.FileReader === 'function') {
                return Promise.resolve().then(function () { return aefs.readBlob(filePath); }).then(function (r) {
                    if (!r || !r.success || !r.blob) return null;
                    return blobToBase64(r.blob).then(function (b64) {
                        return b64 ? { success: true, base64: b64, size: r.size || r.blob.size || 0, mime: r.mime || 'image/png' } : null;
                    });
                }).catch(function () { return null; });
            }
            if (typeof aefs.readImageBase64Sync === 'function') {
                try { return Promise.resolve(aefs.readImageBase64Sync(filePath) || null); } catch (e) { return Promise.resolve(null); }
            }
            return Promise.resolve(null);
        }

        // 反复读图片直至尺寸稳定（ComfyUI 方案：AE saveFrameToPng 返回后文件可能还在写入）
        // 快速失败——文件不存在/权限错误等持续性失败若烧满全部轮询
        // （30 次 × 200ms ≈ 6s）才 resolve(null)，调用方白等。连续多次同一错误
        // 提前退出；成功读取一次即清零错误连击（容忍写入中的偶发读失败）。
        // 轮询链接受中止检查回调（options.shouldAbort）——停止信号若不
        // 不传播到本地媒体轮询链，点停止后旧 loop 的 await 链仍在逐图烧满轮询
        //（每图最长 ≈6s），_stopping 窗口内新消息入队滞留数十秒。回调在每轮休眠
        // 后复查，命中即提前退出（对齐 controller 工具循环的停止复查点）。
        // 读图全部异步化（见文件头）；先用轻量尺寸探测等稳定，稳定后
        // 只做一次整读——同目录的稳定输入从「≥9 次整读」降到「N 次轻量探测 + 1 次整读」。
        // options.onProgress 可选：既有工具卡/调试日志之外，给未来状态反馈留挂点（不新增 UI）。
        function readImageStable(filePath, options) {
            var abortCheck = (options && typeof options.shouldAbort === 'function') ? options.shouldAbort : null;
            var onProgress = (options && typeof options.onProgress === 'function') ? options.onProgress : null;
            function _progress(phase, info) {
                try {
                    if (onProgress) onProgress(phase, info || {});
                    if (global.AEAgentApp && typeof global.AEAgentApp.debugLog === 'function') {
                        global.AEAgentApp.debugLog('Vision-HOOK', 'readImageStable ' + phase + (info ? ' ' + JSON.stringify(info) : ''));
                    }
                } catch (_) {}
            }
            return new Promise(async function(resolve) {
                // ── 第一段：轻量探测（零图片载荷）──
                // 判定口径与 bridge 侧 waitFileStable 对齐并加一次冗余：size>0 且连续三次
                // 相同才算稳定。AE 抓帧是渐进写入（实测 4.5MB PNG 约 3.5s），期间 size 递增；
                // 文件还没出现（missing）连续 5 次探测 ≈1s 即按快速失败口径放弃——
                // 对齐旧链路「读返回 ENOENT 五连击退出」，不烧满预算。
                var PROBE_DELAY_MS = 200, MAX_PROBES = 40, PROBE_STABLE_NEEDED = 2, MISSING_FAIL_STREAK = 5;
                var probeWorks = false, stableByProbe = false, probeSize = -1, probeStable = 0;
                var missingStreak = 0, probeRounds = 0, sawSize = false;
                for (var p = 0; p < MAX_PROBES; p++) {
                    if (p > 0) { await _sleep(PROBE_DELAY_MS); }
                    // 仅探测通道确认可用后才在探测段复查中止：通道不可用时本段至多一次
                    // 探测调用，随后直接进保守轮询，不在读取循环外多消费中止检查次数
                    //（中止时机以「检查次数」界定，探测段不额外计数）。
                    if (probeWorks && abortCheck && abortCheck()) break;
                    probeRounds++;
                    var pr = await probeFileLight(filePath);
                    if (!pr || pr.state === 'unknown') { probeWorks = false; break; }
                    probeWorks = true;
                    if (pr.state === 'missing') {
                        missingStreak++;
                        probeStable = 0; probeSize = -1;
                        if (missingStreak >= MISSING_FAIL_STREAK) break;
                        continue;
                    }
                    missingStreak = 0;
                    if (pr.size > 0) sawSize = true;
                    if (pr.size > 0 && pr.size === probeSize) probeStable++; else probeStable = 0;
                    probeSize = pr.size;
                    if (probeStable >= PROBE_STABLE_NEEDED) { stableByProbe = true; break; }
                }
                if (probeWorks && abortCheck && abortCheck()) { _progress('aborted', {}); return resolve(null); }

                // 探测通道有效但自始至终没拿到有效尺寸（文件没出现 / 恒 0 字节）：
                // 如实失败，不再为同一张图烧整读（旧链路此场景要读满 5 次才停）。
                if (probeWorks && !sawSize && !stableByProbe) {
                    console.warn('[Vision-HOOK] readImageStable 文件未就绪（轻量探测 ' + probeRounds + ' 轮无有效尺寸） path=' + filePath);
                    return resolve(null);
                }

                // ── 稳定后的一次整读 ──
                // 探测通道不可用（probeWorks=false）时不走此段，直接进保守轮询。
                if (probeWorks) {
                    var readResult = null, readTries = 0;
                    for (var r = 0; r < 3; r++) {
                        if (r > 0) { await _sleep(300); }
                        if (abortCheck && abortCheck()) break;
                        readTries++;
                        var rr = await readImageOnce(filePath);
                        if (!(rr && rr.success && rr.base64)) { readResult = null; break; }
                        readResult = rr;
                        // bridge 对 PNG 尾部做了 IEND 校验：false = 文件尾不是 IEND（仍在写/截断）。
                        // 探测判稳后仍可能撞上写入停顿，补读兜底；仍不完整则按可用结果返回，
                        // 不把旧链路能交付的图片降级成失败。
                        if (String(rr.mime || 'image/png').indexOf('png') >= 0 && rr.iendVerified === false) {
                            console.warn('[Vision-HOOK] readImageStable 读到截断 PNG（iendVerified=false），补读 path=' + filePath);
                            continue;
                        }
                        break;
                    }
                    if (readResult && readResult.success && readResult.base64) {
                        _progress('read', { size: readResult.size || readResult.base64.length, probeRounds: probeRounds, readTries: readTries });
                        return resolve({
                            success: true,
                            base64: readResult.base64,
                            size: readResult.size || readResult.base64.length,
                            mime: readResult.mime || 'image/png'
                        });
                    }
                    if (abortCheck && abortCheck()) { _progress('aborted', {}); return resolve(null); }
                    console.warn('[Vision-HOOK] readImageStable 轻量探测就绪但整读失败，转入保守轮询 path=' + filePath);
                }

                // ── 第二段：保守整读轮询（既有语义，读已异步化）──
                // 无轻量探测通道 / 探测误判 / 单次整读失败时兜底：反复整读直到尺寸连续稳定。
                var bestB64 = null, bestSize = 0, bestMime = 'image/png';
                var lastSize = -1, stableCount = 0;
                var MIN_ATTEMPTS = 8, MAX_ATTEMPTS = 30, FAIL_FAST_STREAK = 5;
                var failStreak = 0, lastError = null;
                for (var attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                    if (attempt > 0) { await _sleep(200); }
                    // 停止后立即退出轮询，不再烧剩余轮次
                    if (abortCheck && abortCheck()) break;
                    try {
                        var result = await readImageOnce(filePath);
                        if (result && result.success && result.base64) {
                            failStreak = 0; lastError = null;
                            var curSize = result.size || result.base64.length || 0;
                            if (curSize > bestSize) { bestSize = curSize; bestB64 = result.base64; bestMime = result.mime || 'image/png'; }
                            if (curSize === lastSize && curSize === bestSize) { stableCount++; }
                            else if (curSize !== lastSize) { stableCount = 0; }
                            lastSize = curSize;
                            if (stableCount >= 2 && attempt >= MIN_ATTEMPTS) break;
                        } else {
                            var err = (result && (result.error || result.message)) ? String(result.error || result.message) : '';
                            if (err === lastError) failStreak++; else { failStreak = 1; lastError = err; }
                        }
                    } catch (e) {
                        var errMsg = (e && e.message) ? String(e.message) : '';
                        if (errMsg === lastError) failStreak++; else { failStreak = 1; lastError = errMsg; }
                    }
                    if (failStreak >= FAIL_FAST_STREAK) break;
                }
                if (bestB64) {
                    _progress('read-fallback', { size: bestSize });
                    resolve({ success: true, base64: bestB64, size: bestSize, mime: bestMime });
                } else {
                    console.warn('[Vision-HOOK] readImageStable 失败 path=' + filePath);
                    resolve(null);
                }
            });
        }

        // 反复读视频直至尺寸稳定（对齐 readImageStable）：
        // 视频源可能由 ffmpeg/ComfyUI 边写边落盘，且 mp4 的 moov 元数据在文件末尾，
        // 若读到未写完的半截文件，整个视频无法解码（比图片"下半部分黑"更彻底）。
        // readBlob 内部已带 bridge 的 _waitFileStableShared（等尺寸连续两次相等），
        // 此处再多轮轮询取最大稳定尺寸，双重兜底 bridge stat→stream 之间的 TOCTOU 窗口。
        function readVideoStable(filePath) {
            return new Promise(async function (resolve) {
                var bestBlob = null, bestSize = 0, lastSize = -1, stableCount = 0;
                var MIN_ATTEMPTS = 3, MAX_ATTEMPTS = 12, FAIL_FAST_STREAK = 4;
                var failStreak = 0, lastError = null;
                for (var attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                    if (attempt > 0) { await new Promise(function (r) { setTimeout(r, 250); }); }
                    try {
                        var result = (global.AEFS && typeof global.AEFS.readBlob === 'function')
                            ? await global.AEFS.readBlob(filePath) : null;
                        if (result && result.success && result.blob) {
                            failStreak = 0; lastError = null;
                            var curSize = result.blob.size || result.size || 0;
                            if (curSize > bestSize) { bestSize = curSize; bestBlob = result.blob; }
                            if (curSize === lastSize && curSize === bestSize) { stableCount++; }
                            else if (curSize !== lastSize) { stableCount = 0; }
                            lastSize = curSize;
                            if (stableCount >= 2 && attempt >= MIN_ATTEMPTS) break;
                        } else {
                            var err = (result && (result.error || result.message)) ? String(result.error || result.message) : '';
                            if (err === lastError) failStreak++; else { failStreak = 1; lastError = err; }
                        }
                    } catch (e) {
                        var errMsg = (e && e.message) ? String(e.message) : '';
                        if (errMsg === lastError) failStreak++; else { failStreak = 1; lastError = errMsg; }
                    }
                    if (failStreak >= FAIL_FAST_STREAK) break;
                }
                if (bestBlob) {
                    resolve({ success: true, blob: bestBlob, size: bestSize });
                } else {
                    console.warn('[Video-HOOK] readVideoStable 失败 path=' + filePath);
                    resolve(null);
                }
            });
        }

        return { convertPngToJpegViaCanvas: convertPngToJpegViaCanvas, readImageStable: readImageStable, readVideoStable: readVideoStable };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createMediaReaders = createMediaReaders;
})(typeof global !== 'undefined' ? global : window);