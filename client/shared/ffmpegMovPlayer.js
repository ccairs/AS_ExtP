// Bridge Server 调系统 ffmpeg 异步转码带 alpha 的 mov -> WebM VP9（cef 88 不支持 wasm simd/threads）
// 缓存到数据目录 assets/transcoded/,后续命中缓存直接播 webm。依赖 AEFS
// onProgress({status, progress}) — status: 'running'|'done'|'error', progress: 0~100
// 同文件另导出 extractVideoFrame（抽一帧存 JPEG，素材库视频格子封面用）——同一条 Bridge
// ffmpeg 通道，区别只是单帧、同步返回、无进度。
(function (global) {
    global.AEAssetsShared = global.AEAssetsShared || {};

    // ── 产物命名（唯一实现，视图侧要算缓存键也走这里）──
    // 名字 = tc_<全路径摘要 16 位十六进制>_w<限宽>.webm。
    // 摘要必须覆盖**整个路径**：若按 btoa(路径) 去掉 +/= 后**截前 80 字符**，路径前缀
    // 长（同一批素材在同一层深目录下）时，差异落在截断点之后的两个文件会算出同一个名字。
    // 真机实证：`…/【示例】测试素材目录/内方外方.mov` 与 `…/内方外圆.mov` 撞车，
    // 结果是其中一个视频的 hover / 详情预览放的是**另一个**已转码的产物（面板日志里两条
    // `output=…` 逐字符相同；本地按同算法复算一致）。撞车的代价与本次修的 bug 同类（放错视频），
    // 故不留这个口子：摘要把整条路径吃进去，长度与路径长短无关。
    // 两条 32 位链拼 64 位（FNV-1a + djb2）：单条 32 位在缓存目录上限规模（2GB 预算 ≈ 数千条）
    // 下撞车概率约 0.2%，拼接后降到可忽略；两条链算法不同源，避免同构输入下同涨同落。
    function _hash32a(s) {
        var h = 0x811c9dc5;
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
            h = h >>> 0;
        }
        return h;
    }
    function _hash32b(s) {
        var h = 5381;
        for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        return h;
    }
    function _hex8(n) { return ('0000000' + (n >>> 0).toString(16)).slice(-8); }

    // 转码产物绝对路径。素材库（refView）与 Agent 侧预览都按它算缓存键——refView 就地抄了
    // 一份同样的 hash 算法，两处一旦漂移就是"内存里认的键与实际产物不是同一个文件"。
    function transcodeOutputPath(inputPath, outputDir, maxWidth) {
        var p = String(inputPath == null ? '' : inputPath);
        // 转码产物统一加前缀标识 'tc_'，供素材库「清缓存」与 tempSweep 据此判别；不带标识符的文件不会被清理
        return String(outputDir || '').replace(/[\/\\]$/, '') + '/tc_' + _hex8(_hash32a(p)) + _hex8(_hash32b(p))
            + (maxWidth ? '_w' + maxWidth : '') + '.webm';
    }

    function transcodeMov(movPath, outputDir, onProgress, maxWidth) {
        console.warn('[ffmpegMov] transcodeMov 开始 path=' + movPath + ' outputDir=' + outputDir + ' maxWidth=' + (maxWidth || 0));
        // maxWidth 进产物名，切换分辨率不会命中旧缓存
        var output = transcodeOutputPath(movPath, outputDir, maxWidth);
        console.warn('[ffmpegMov] output=' + output);

        // Bridge 端口可能因 9877 被占而回退到 9878-9886，用 Bridge.getBridgeUrl() 动态获取
        function _bridgeUrl() {
            return (global.Bridge && global.Bridge.getBridgeUrl ? global.Bridge.getBridgeUrl() : 'http://127.0.0.1:9877');
        }

        // bridge 无鉴权（token 鉴权已整体回退），headers 保持无鉴权结构
        function _bridgeHeaders(base) {
            return base || {};
        }

        function _fireProgress(status, progress) {
            if (typeof onProgress === 'function') {
                try { onProgress({ status: status, progress: progress }); } catch (_) {}
            }
        }

        return global.AEFS.exists(output).then(function (exists) {
            console.warn('[ffmpegMov] AEFS.exists=' + exists);
            if (exists === true) {
                console.warn('[ffmpegMov] 缓存命中');
                _fireProgress('done', 100);
                return output;
            }
            console.warn('[ffmpegMov] AEFS.mkdir(' + outputDir + ')...');
            return global.AEFS.mkdir(outputDir).then(function (mkOk) {
                console.warn('[ffmpegMov] AEFS.mkdir=' + mkOk);
                // 1. 发起异步转码 → 获取 taskId
                var url = _bridgeUrl() + '/api/ffmpeg-transcode';
                var body = JSON.stringify({ input: movPath, output: output, maxWidth: maxWidth || 0 });
                console.warn('[ffmpegMov] POST ' + url + ' body=' + body.substring(0, 140));
                return fetch(url, {
                    method: 'POST',
                    headers: _bridgeHeaders({ 'Content-Type': 'application/json' }),
                    body: body
                });
            }).then(function (resp) {
                console.warn('[ffmpegMov] fetch resp status=' + resp.status + ' ok=' + resp.ok);
                if (!resp.ok) {
                    // 非 2xx 的 bridge 响应体带具体原因与指引（如 ffmpeg 未安装 + winget/
                    // scoop/choco 安装指引），只报状态码会让预览层把指引丢光（videoPreview
                    // 的失败文案直接取本 Error 的 message）。读 body 的 error/detail 并入
                    // 文案；body 读不出/非 JSON 时回退旧文案（保持既有 message 前缀兼容）。
                    return resp.text().then(function (body) {
                        var eb = null;
                        try { eb = JSON.parse(body); } catch (_) {}
                        var reason = '';
                        if (eb && eb.error) reason = eb.detail ? String(eb.error) + '：' + String(eb.detail) : String(eb.error);
                        else if (eb && eb.detail) reason = String(eb.detail);
                        throw new Error('Bridge Server responded with ' + resp.status + (reason ? '（' + reason + '）' : ''));
                    }, function () {
                        throw new Error('Bridge Server responded with ' + resp.status);
                    });
                }
                return resp.json();
            }).then(function (r) {
                console.warn('[ffmpegMov] transcode started, taskId=' + (r.taskId || '?') + ' ok=' + r.ok);
                if (!r.ok || !r.taskId) throw new Error(r.error || 'transcode start failed');
                var taskId = r.taskId;
                // 2. 轮询进度
                return new Promise(function (resolve, reject) {
                    var _polling = true;
                    var _pollStart = Date.now();
                    var _maxWait = 300000; // 5 分钟超时
                    // 单次网络抖动不整体判失败——一次 poll 失败即 reject，
                    // 但 bridge 端 ffmpeg 仍在转码，用户重试会对同一输出文件双写。
                    // 连续 10 次（约 5s）失败才判死；成功响应即清零计数。
                    var _failStreak = 0;
                    var _maxFailStreak = 10;
                    // 轮询单次 fetch 加 AbortController 超时——半开连接下
                    // fetch 永不 settle，poll 链停摆：_maxWait 超时检查与 _failStreak
                    // 计数全部失效（都挂在「下一轮 poll 被排程」之上），转码 Promise
                    // 永不 settle、UI 永卡「转码中」。超时按一次失败进入 S13 容错链
                    // （连续 10 次才判死，语义不变）。
                    var _POLL_FETCH_TIMEOUT_MS = 3000;
                    function _fetchWithTimeout(url) {
                        if (typeof AbortController !== 'function') {
                            return fetch(url, { headers: _bridgeHeaders() });
                        }
                        var ctrl = new AbortController();
                        var t = setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, _POLL_FETCH_TIMEOUT_MS);
                        var p = fetch(url, { headers: _bridgeHeaders(), signal: ctrl.signal });
                        return p.then(function (r) {
                            clearTimeout(t);
                            return r;
                        }, function (e) {
                            clearTimeout(t);
                            throw e;
                        });
                    }
                    // 整链兜底——任何一环停摆（fetch 挂起且 AbortController
                    // 不可用/回调丢失等）时由独立看门狗强制结算，Promise 保证必 settle。
                    // 正常路径（done/error/判死/超时）总先于看门狗并清理之。
                    var _guardTimer = setTimeout(function () {
                        if (!_polling) return;
                        _polling = false;
                        _fireProgress('error', 0);
                        reject(new Error('转码超时（' + Math.round(_maxWait / 1000) + '秒，轮询链停摆兜底）'));
                    }, _maxWait + 10000);
                    function _finish(fn, arg) {
                        clearTimeout(_guardTimer);
                        fn(arg);
                    }
                    function poll() {
                        if (!_polling) return;
                        // 超时保护：防止 Bridge 一直返回 running 导致 Promise 永不 settle
                        if (Date.now() - _pollStart > _maxWait) {
                            _polling = false;
                            _fireProgress('error', 0);
                            _finish(reject, new Error('转码超时（' + Math.round(_maxWait / 1000) + '秒）'));
                            return;
                        }
                        var progressUrl = _bridgeUrl() + '/api/ffmpeg-progress?taskId=' + encodeURIComponent(taskId);
                        _fetchWithTimeout(progressUrl).then(function (pr) {
                            if (!pr.ok) throw new Error('progress request failed: ' + pr.status);
                            return pr.json();
                        }).then(function (p) {
                            if (!_polling) return;
                            _failStreak = 0;
                            console.warn('[ffmpegMov] progress status=' + p.status + ' pct=' + p.progress);
                            if (p.status === 'done') {
                                _polling = false;
                                _fireProgress('done', 100);
                                console.warn('[ffmpegMov] 转码完成: ' + (p.output || output));
                                _finish(resolve, p.output || output);
                            } else if (p.status === 'error') {
                                _polling = false;
                                _fireProgress('error', 0);
                                _finish(reject, new Error(p.error || 'transcode failed'));
                            } else {
                                _fireProgress('running', p.progress || 0);
                                setTimeout(poll, 500);
                            }
                        }).catch(function (e) {
                            if (!_polling) return;
                            // 瞬时抖动（网络错误/进度接口暂不可用）容错重试，
                            // 连续超阈值才判死（见 _maxFailStreak 注释）；
                            // 轮询超时 abort 也按一次失败进入本链
                            _failStreak++;
                            if (_failStreak >= _maxFailStreak) {
                                _polling = false;
                                _fireProgress('error', 0);
                                _finish(reject, e);
                                return;
                            }
                            setTimeout(poll, 500);
                        });
                    }
                    poll();
                });
            });
        }).catch(function (e) {
            console.warn('[ffmpegMov] transcodeMov 异常: ' + (e && e.message || e));
            _fireProgress('error', 0);
            throw e;
        });
    }

    // 抽一帧存成 JPEG（素材库视频格子的封面）。与转码同一条 Bridge 通道、同一份路径语义：
    // 输出路径由调用方给（素材库给 <数据目录>/assets/previews/asset-refs/<id>/preview.jpg），
    // Bridge 负责建目录、写临时名、成功后原子改名，故这里只在成功时 resolve 输出路径。
    // 单帧无进度可报，同步等结果（本机实测 4s 的 1080p mov 约 0.3s）。
    function extractVideoFrame(input, output, maxWidth) {
        function _bridgeUrl() {
            return (global.Bridge && global.Bridge.getBridgeUrl ? global.Bridge.getBridgeUrl() : 'http://127.0.0.1:9877');
        }
        return fetch(_bridgeUrl() + '/api/ffmpeg-frame', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: input, output: output, maxWidth: maxWidth || 0 })
        }).then(function (resp) {
            return resp.json().then(function (r) {
                if (!resp.ok || !r || !r.ok) {
                    // 同 transcodeMov：body 里除 error 外还有 detail（安装指引等），一并透出
                    var reason = (r && r.error)
                        ? (r.detail ? String(r.error) + '：' + String(r.detail) : String(r.error))
                        : '';
                    throw new Error(reason || ('Bridge Server responded with ' + resp.status));
                }
                return r.output || output;
            });
        }).catch(function (e) {
            console.warn('[ffmpegMov] extractVideoFrame 失败: ' + (e && e.message ? e.message : e));
            throw e;
        });
    }

    global.AEAssetsShared.transcodeMov = transcodeMov;
    global.AEAssetsShared.transcodeOutputPath = transcodeOutputPath;
    // 中性共享出口：这位转码客户端本身与素材库的 mov 场景无关（给输入/输出路径 + 限宽，
    // 编码器由 Bridge 按可用性挑），Agent 侧预览 CEF 解不了的视频（如 HEVC）要复用。
    // 跨模块共享能力走公共接口层——其他模块只用这个别名，不要去碰 AEAssetsShared 命名空间。
    global.AEShared = global.AEShared || {};
    global.AEShared.transcodeVideo = transcodeMov;
    global.AEShared.transcodeOutputPath = transcodeOutputPath;
    global.AEAssetsShared.extractVideoFrame = extractVideoFrame;
    global.AEShared.extractVideoFrame = extractVideoFrame;
})(window);
