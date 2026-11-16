(function (global) {
    'use strict';
    // 图像转码单点实现：PNG(data URL) → JPEG(q=0.9)；仅当超过 MAX_W/MAX_H 才等比缩放。
    //
    // 为什么必须单点：同一个大图在两条路上必须得到**同一份**结果，否则 AI 侧观察到的不是同一张图——
    //   · 面板内 Agent 的图片投递：engine/controller.js 视觉注入链 → mediaReaders.convertPngToJpegViaCanvas
    //   · 外接 MCP 的结果图片：extBridgeClient 转码后交 ext-mcp-server（hoistInlineImages）提升为 image 块
    // 两条链路共用本模块这一份规则。
    //
    // 语义（与 mediaReaders.js 面板侧链路口径一致）：
    //   · 输入 data URL，输出 JPEG data URL
    //   · 宽度 > MAX_W 或高度 > MAX_H 时按 min(MAX_W/w, MAX_H/h) 等比缩放
    //   · **已是 JPEG 且未超尺寸 → 原样返回，不重编码**（避免二次有损；
    //     用户上传图片链并入本单点，首发图片可能是 JPEG；工具链输入是 AE 截图 PNG，不受影响）
    //   · 画布铺白底（PNG 可带 alpha，JPEG 不支持 → 与既有行为一致）
    //   · 任何失败（Image 加载失败 / canvas 不可用 / toDataURL 抛错）→ 原样返回输入，绝不阻断链路
    var MAX_W = 4096;
    var MAX_H = 2160;
    var QUALITY = 0.9;
    var MAX_DEPTH = 6;   // 递归上限：防环、防病态深嵌套

    function isPngDataUrl(v) {
        return typeof v === 'string' && v.indexOf('data:image/png') === 0;
    }

    // 单个 data URL → JPEG data URL。无 DOM（纯数据环境）时原样返回，不抛错。
    // 详细版返回 {url, width, height, converted}：width/height 是**转码后**的像素尺寸
    //（未转换时为 0），供调用方记账——外部 AI 需要据此知道图有没有被 4K 上限缩过。
    function transcodeDetailed(dataUrl) {
        return new Promise(function (resolve) {
            function passthrough() { resolve({ url: dataUrl, width: 0, height: 0, converted: false }); }
            if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/') !== 0) { passthrough(); return; }
            if (typeof global.Image !== 'function' ||
                !global.document || typeof global.document.createElement !== 'function') {
                passthrough();
                return;
            }
            var img = new global.Image();
            img.onload = function () {
                try {
                    var w = img.naturalWidth || img.width || 0;
                    var h = img.naturalHeight || img.height || 0;
                    if (!w || !h) { passthrough(); return; }
                    // 已是 JPEG 且未超尺寸：原样返回，不重编码（避免二次有损）。与
                    // transcodeImageFields 的「只认 PNG、不重编码 JPEG」同一条纪律；
                    // 用户上传图片链并入本单点（首发图片可能是 JPEG），需要它。
                    // 超尺寸的 JPEG 仍走下面缩放（缩放本身就是重编码，无法避免）。
                    if (/^data:image\/jpe?g/i.test(dataUrl) && w <= MAX_W && h <= MAX_H) {
                        passthrough();
                        return;
                    }
                    if (w > MAX_W || h > MAX_H) {
                        var scale = Math.min(MAX_W / w, MAX_H / h);
                        w = Math.round(w * scale);
                        h = Math.round(h * scale);
                    }
                    var c = global.document.createElement('canvas');
                    c.width = w; c.height = h;
                    var ctx = c.getContext('2d');
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, w, h);
                    ctx.drawImage(img, 0, 0, w, h);
                    resolve({ url: c.toDataURL('image/jpeg', QUALITY), width: w, height: h, converted: true });
                } catch (e) {
                    passthrough();   // 转换失败，回退原始 data URL
                }
            };
            img.onerror = function () {
                passthrough();       // 图片加载失败，回退原始 data URL
            };
            img.src = dataUrl;
        });
    }

    // 兼容入口：只要转码后的字符串（面板内媒体读取层的既有调用形态）。
    function transcodeDataUrl(dataUrl) {
        return transcodeDetailed(dataUrl).then(function (r) { return r.url; });
    }

    // 就地把对象/数组里的 **PNG** data URL 替换成 JPEG（含超尺寸缩放），返回替换个数的 Promise。
    // 两处关键语义：
    //   ①只认 data:image/png 开头的字符串：AE 截图即 PNG（两条路的输入都是它）；
    //     已是 JPEG 的不重编码（避免二次有损——与面板内"读文件才转码"语义等价，因为文件本身就是 PNG）。
    //   ②**字符串里的 JSON 也要进去**：工具结果的真实形态是
    //     `{content:[{type:'text', text:'{"imageDataUrl":"data:image/png;base64,…"}'}]}` ——
    //     图片藏在 text 的 JSON 文本内，不是直接字段。不解析就会"静默不转码"
    //     （ext-mcp-server 的 hoistInlineImages 同样先 JSON.parse 再取 imageDataUrl，两边形状认知必须一致）。
    //     仅对以 { 或 [ 开头且能解析的字符串尝试；解析失败/非对象 → 原样保留；
    //     且**只在真的替换过**时才回写 JSON（否则会白白改写文本/空白，干扰调用方比对）。
    //   深度上限 MAX_DEPTH 覆盖"JSON 字符串里再嵌 JSON 字符串"的展开层数。
    function transcodeImageFields(root) {
        var sizes = [];   // 每次成功转码的输出尺寸（记账用）
        function walk(node, depth) {
            if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return Promise.resolve(0);
            var isArr = Array.isArray(node);
            var keys = isArr ? null : Object.keys(node);
            var n = isArr ? node.length : keys.length;
            var jobs = [];
            for (var i = 0; i < n; i++) {
                var k = isArr ? i : keys[i];
                if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
                var v = node[k];
                if (typeof v === 'string') {
                    if (isPngDataUrl(v)) {
                        /* eslint-disable no-loop-func */
                        (function (holder, key, url) {
                            jobs.push(transcodeDetailed(url).then(function (r) {
                                holder[key] = r.url;
                                // 只统计**真的转码成功**的次数/尺寸：回退路径（Image 失败/canvas 抛错）
                                // 原样返回输入，此时计 0——否则记账会把"尝试"当"成功"
                                //（实测踩过：非法 data URL 回退后仍报 count:1 sizes:[[0,0]]，
                                //  外部 AI 会据此误以为图片被转码/缩放过）。
                                if (!r.converted) return 0;
                                sizes.push([r.width, r.height]);
                                return 1;
                            }));
                        })(node, k, v);
                        /* eslint-enable no-loop-func */
                        continue;
                    }
                    var head = v.replace(/^\s+/, '').charAt(0);
                    if (head !== '{' && head !== '[') continue;
                    var parsed = null;
                    try { parsed = JSON.parse(v); } catch (_) { parsed = null; }
                    if (!parsed || typeof parsed !== 'object') continue;
                    /* eslint-disable no-loop-func */
                    (function (holder, key, obj) {
                        jobs.push(walk(obj, depth + 1).then(function (cnt) {
                            if (cnt > 0) holder[key] = JSON.stringify(obj);
                            return cnt;
                        }));
                    })(node, k, parsed);
                    /* eslint-enable no-loop-func */
                    continue;
                }
                jobs.push(walk(v, depth + 1));
            }
            return Promise.all(jobs).then(function (counts) {
                var total = 0;
                for (var j = 0; j < counts.length; j++) total += (counts[j] || 0);
                return total;
            });
        }
        return walk(root, 0).then(function (count) {
            return { count: count, sizes: sizes };
        });
    }

    // 外接结果入口：遍历转码 + 在 content 末尾追加一条记账（仅 count>0 时）。
    // 为什么记账要放进 content：外接结果只有 `content` 会随 MCP 结果送达外部客户端，
    // 顶层字段（result.imageTranscoded 之类）会被丢掉——放错地方等于没记。
    // 记账同时给出**实际输出尺寸** sizes=[[w,h],…]：只报"上限 4096×2160"是不够的，
    // 外部 AI 无从判断这张图到底被缩过没有（例如 1920×1080 原样转 JPEG 时它并未被缩放）。
    function transcodeResultImages(result) {
        return transcodeImageFields(result).then(function (res) {
            var count = res && res.count ? res.count : 0;
            if (count > 0 && result && typeof result === 'object' && Array.isArray(result.content)) {
                result.content.push({
                    type: 'text',
                    text: JSON.stringify({
                        imageTranscoded: {
                            count: count,
                            format: 'image/jpeg',
                            quality: QUALITY,
                            sizes: res.sizes,
                            maxWidth: MAX_W,
                            maxHeight: MAX_H
                        }
                    })
                });
            }
            return count;
        });
    }

    // ── 内联图片提升（MCP content 适配，单点实现）──
    // 背景：getShaderPreview / getPreviewFrame 把截图以 data URL 内联在结果 JSON 的
    // imageDataUrl 字段里。base64 以纯文本形态下行会撞客户端结果预算——实测 678×371
    // 画布产生 51,412 字节文本 > ZCode 50,000 文本预算 → JSON 中段被截断、图片进不了
    // 视觉通道。修法：把 data:image/ 前缀的 imageDataUrl 提升为 MCP 原生
    // image content block（图片载荷与文本预算分离），并从文本 JSON 中删除该字段——与面板
    // 内通道「剥离字段 + vision hook 另路注入」的既有设计对齐。仅当形态完整时才搬移；
    // 其余超限文本仍由客户端预算正常约束。
    // 为什么住在本模块：面板侧转码（transcodeResultImages）与本提升是**同一条投递链**的
    // 相邻两环（转码后图片仍是 text JSON 里的 data URL，到 MCP 边界才提升为 image 块），
    // 形状认知（先 JSON.parse 再取 imageDataUrl）必须一致。stdio（ext-mcp-server）与
    // bridge 内嵌 HTTP（ext-mcp-http）两个 Node 通道都 require 本文件取同一实现，
    // 保证同一 content 经两通道得到逐字节一致的结果。
    function hoistInlineImages(content, logFn) {
        if (!Array.isArray(content)) return content;
        var out = [];
        for (var i = 0; i < content.length; i++) {
            var item = content[i];
            if (!item || item.type !== 'text' || typeof item.text !== 'string') { out.push(item); continue; }
            var parsed = null;
            try { parsed = JSON.parse(item.text); } catch (_) { parsed = null; }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
                typeof parsed.imageDataUrl !== 'string' ||
                parsed.imageDataUrl.indexOf('data:image/') !== 0) {
                out.push(item);
                continue;
            }
            var url = parsed.imageDataUrl;
            var semi = url.indexOf(';');
            var comma = url.indexOf(',');
            // 形态不合法（缺 ; 或 , 或顺序颠倒）：原样保留，不冒险改写
            if (semi < 0 || comma < 0 || comma < semi) { out.push(item); continue; }
            var mimeType = url.slice(5, semi) || 'image/jpeg';   // 'data:'.length === 5
            var data = url.slice(comma + 1);
            if (!data) { out.push(item); continue; }
            delete parsed.imageDataUrl;
            out.push({ type: 'text', text: JSON.stringify(parsed) });
            out.push({ type: 'image', data: data, mimeType: mimeType });
            if (typeof logFn === 'function') {
                logFn('hoisted inline image to MCP image block: ' + mimeType + ' (' + data.length + ' b64 chars)');
            }
        }
        return out;
    }

    var api = {
        MAX_W: MAX_W,
        MAX_H: MAX_H,
        QUALITY: QUALITY,
        transcodeDetailed: transcodeDetailed,
        transcodeDataUrl: transcodeDataUrl,
        transcodeImageFields: transcodeImageFields,
        transcodeResultImages: transcodeResultImages,
        isPngDataUrl: isPngDataUrl,
        hoistInlineImages: hoistInlineImages
    };
    if (global) global.AEImageTranscode = api;
    // Node 出口（bridge 的 ext-mcp-http / 外部进程的 ext-mcp-server 均 require 本文件）：
    // 面板侧仍走 window.AEImageTranscode（scripts.manifest.js 装载），两形态同一实现。
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
