// previewSheet.js — getPreviewFrame 面板侧后处理（多时间点联系表 + 局部裁切放大）
//
// 位置与职责：aeTools.jsx 的 _getPreviewFrames 逐时间点抓出的是一堆 PNG（AE 侧没有 canvas，
// 拼不了图）；本模块在**面板侧**把它们拼成一张带时间标签的网格图并落盘，再把工具结果里
// 的 filePath 改指到这张表——下游两条图片链（面板 controller 的 vision hook、外接
// extBridgeClient 的内联链）都按 filePath 取图，故不加改动即生效。
//
// 局部裁切放大：getPreviewFrame 的 region（0–1 归一化矩形）或 zoom（中心放大
// 倍数）同样由本模块后处理——读已落盘的原帧 PNG，按源矩形重绘（长边不足 960 时最多放大 2 倍），
// 写一张新 PNG 并把 filePath 改指它；整帧路径留在 fullFramePath（单帧）或 frames[].filePath
// （多帧）。裁切只读原帧 + 写面板侧临时文件，不碰 AE 工程。
//
// 关键取舍：
//   - 各时间点原始 PNG **保留**（frames[].filePath 仍在回执里）：联系表用于整体判断，
//     需要细看某一帧时客户端可单独取该文件；残留由 tempSweep 统一清（temp/ae-tools：龄 7 天
//     + 保留池最新 30 张，见 previewFrameTargets）。
//   - 回执 width/height 按 PNG 实际像素（IHDR，面板侧解析）校正；抓帧分辨率与合成尺寸口径
//     不一致时裁切源矩形重映射到实际图像尺寸。
//   - 合成失败不吞结果：原样返回多帧回执并加 contactSheet:false + sheetError，顶层 filePath
//     退化为第一帧（与单帧路径同形）；裁切失败只加 cropError，注入整帧，工具仍算成功。
//   - 纯函数（gridFor/computeSheetLayout/formatTimeLabel/buildSheetResult/parseCropRequest/
//     cropOutputSize/cropMeta）无 DOM，可 vm 单测；canvas 编排（composeSheet/cropSingleFrame）
//     依赖浏览器 Image/canvas，真机验证。
(function (global) {
    'use strict';

    // 单格目标宽（px）。6 帧 3 列时整图 2880×1080，仍在图片链的 4096×2160 转码上限内，
    // 不被二次缩放；再大则在注入视觉模型前被二次缩放（仅增抓帧与传输量）。
    var MAX_CELL_WIDTH = 960;

    // ── 局部裁切放大的参数边界 ──
    // zoom 与 AE 查看器的缩放范围对齐（0.01–16），这里只接受 1–16 的放大方向。
    var MAX_ZOOM = 16;
    // 裁切区域在源图上的最小边长（px）：更小的区域没有可读细节，直接报参数错误。
    var MIN_CROP_PX = 16;
    // 裁切输出的长边归一目标：与单格上限同值（同文件内直接引用，防两处数字漂移）。
    // 小于它时最多放大 MAX_CROP_UPSCALE 倍补足，大于它时保持原像素（多帧拼表时仍受单格上限约束）；
    // 超过图片链转码上限（4096×2160）时先缩到上限内，避免下游二次缩放。
    // 下游视觉模型按自己的规则再缩放，这里不做超量插值。
    var MIN_CROP_LONG_SIDE = MAX_CELL_WIDTH;
    var MAX_CROP_UPSCALE = 2;
    // 与 imageTranscode.MAX_W/MAX_H 同值；mediaReaders.convertPngToJpegViaCanvasFallback 里还有
    // 一份离线副本（旧缓存兜底）——三处要同步，测试钉住前两处。
    var MAX_CROP_W = 4096;
    var MAX_CROP_H = 2160;

    // ── 纯函数 ──

    function _isNum(v) {
        return typeof v === 'number' && isFinite(v);
    }

    // 数字或非空数字字符串 → 有限数；其余（布尔/null/undefined/空串/NaN）→ NaN。
    // 为什么要收严：schema 声明 number，而布尔 true 经 Number() 会变成 1——对 zoom 意味着
    // 静默「不裁」、对 region 意味着 1.0，都是无声的错误参数。
    function _toFiniteNum(v) {
        var n;
        if (typeof v === 'number') n = v;
        else if (typeof v === 'string' && v.replace(/^\s+|\s+$/g, '') !== '') n = Number(v);
        else return NaN;
        return isFinite(n) ? n : NaN;
    }

    function _round2(v) {
        return Math.round(Number(v) * 100) / 100;
    }

    function _copy(obj) {
        var out = {};
        for (var k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
        }
        return out;
    }

    // 网格：尽量接近正方（3 帧 = 2×2 留一格空，6 帧 = 3×2）。
    function gridFor(count) {
        var n = Math.max(1, Number(count) || 1);
        if (n === 1) return { cols: 1, rows: 1 };
        var cols = Math.ceil(Math.sqrt(n));
        return { cols: cols, rows: Math.ceil(n / cols) };
    }

    // 布局：按第一帧尺寸等比缩放到单格 ≤ maxCellWidth，各格同尺寸（同合成抓帧，宽高一致）。
    // 裁切模式下 frameW/H 传裁切输出尺寸；裁切输出长边 > MAX_CELL_WIDTH 时仍会被等比缩到这里
    // 的单格上限（整表总预算优先，不因裁切把整表撑到图片链 4096 上限之外）。
    function computeSheetLayout(count, frameW, frameH, maxCellWidth) {
        var g = gridFor(count);
        var cap = maxCellWidth || MAX_CELL_WIDTH;
        var w = Math.max(1, Number(frameW) || 1);
        var h = Math.max(1, Number(frameH) || 1);
        var cellW = Math.max(1, Math.round(w * Math.min(1, cap / w)));
        var cellH = Math.max(1, Math.round(h * (cellW / w)));
        return {
            cols: g.cols, rows: g.rows,
            cellW: cellW, cellH: cellH,
            sheetW: cellW * g.cols, sheetH: cellH * g.rows
        };
    }

    // 时间标签：固定两位小数（帧时间在视觉判断里只需可辨认、可对齐报告）。
    function formatTimeLabel(seconds) {
        var t = Number(seconds);
        if (!isFinite(t)) return '';
        return t.toFixed(2) + 's';
    }

    // 裁切输出尺寸：超过图片链上限（4096×2160）先等比缩到上限内；长边 < MIN_CROP_LONG_SIDE
    // 时等比放大（上限 MAX_CROP_UPSCALE 倍），其余保持原像素。scale 为实际缩放倍数（1 = 未缩放）。
    function cropOutputSize(srcW, srcH) {
        var w = Math.max(1, Math.round(Number(srcW) || 0));
        var h = Math.max(1, Math.round(Number(srcH) || 0));
        var scale = 1;
        var capScale = Math.min(1, MAX_CROP_W / w, MAX_CROP_H / h);
        if (capScale < 1) {
            scale = capScale;
            w = Math.max(1, Math.round(w * capScale));
            h = Math.max(1, Math.round(h * capScale));
        } else {
            var longSide = Math.max(w, h);
            if (longSide < MIN_CROP_LONG_SIDE) {
                scale = Math.min(MAX_CROP_UPSCALE, MIN_CROP_LONG_SIDE / longSide);
                if (scale < 1) scale = 1;
                w = Math.max(1, Math.round(w * scale));
                h = Math.max(1, Math.round(h * scale));
            }
        }
        return { width: w, height: h, scale: _round2(scale) };
    }

    // getPreviewFrame 的裁切参数 → 源图像素矩形 + 输出尺寸。
    // 返回：null（未请求裁切 / 区域等于整帧）| { error } | 裁切描述对象。
    // 约定：region 优先于 zoom；坐标 0–1 归一化（左上角原点），越界钳制。
    function parseCropRequest(args, frameW, frameH) {
        args = (args && typeof args === 'object') ? args : {};
        var hasRegion = (args.region !== undefined && args.region !== null);
        var hasZoom = (args.zoom !== undefined && args.zoom !== null);
        if (!hasRegion && !hasZoom) return null;
        var W = Number(frameW), H = Number(frameH);
        if (!_isNum(W) || !_isNum(H) || W < 1 || H < 1) {
            return { error: '无法确定帧尺寸，未裁切（结果缺 width/height）' };
        }
        var mode = '';
        var region = null;
        var zoom = null;
        if (hasRegion) {
            var r = args.region;
            if (typeof r !== 'object' || Array.isArray(r)) {
                return { error: 'region 需为对象 {x,y,width,height}（0–1 归一化，左上角原点）' };
            }
            var rw = _toFiniteNum(r.width), rh = _toFiniteNum(r.height);
            if (isNaN(rw) || isNaN(rh) || rw <= 0 || rh <= 0) {
                return { error: 'region 的 width/height 需为大于 0 的数字（0–1 归一化）' };
            }
            var hasX = (r.x !== undefined && r.x !== null);
            var hasY = (r.y !== undefined && r.y !== null);
            var rx = hasX ? _toFiniteNum(r.x) : 0;
            var ry = hasY ? _toFiniteNum(r.y) : 0;
            if (isNaN(rx) || isNaN(ry)) {
                return { error: 'region 的 x/y 需为数字（0–1 归一化）' };
            }
            rw = Math.min(1, rw);
            rh = Math.min(1, rh);
            rx = Math.min(Math.max(0, rx), 1 - rw);
            ry = Math.min(Math.max(0, ry), 1 - rh);
            region = { x: rx, y: ry, width: rw, height: rh };
            mode = 'region';
        } else {
            zoom = _toFiniteNum(args.zoom);
            if (isNaN(zoom) || zoom < 1) {
                return { error: 'zoom 需为 1–16 的数字（1 = 整帧，2 = 中心 1/2 宽高，4 = 中心 1/4 宽高）' };
            }
            if (zoom === 1) return null;      // 1 = 整帧，等同不传
            if (zoom > MAX_ZOOM) zoom = MAX_ZOOM;
            var zw = 1 / zoom, zh = 1 / zoom;
            region = { x: (1 - zw) / 2, y: (1 - zh) / 2, width: zw, height: zh };
            mode = 'zoom';
        }
        var sx = Math.round(region.x * W);
        var sy = Math.round(region.y * H);
        var sw = Math.round(region.width * W);
        var sh = Math.round(region.height * H);
        if (sx < 0) sx = 0;
        if (sy < 0) sy = 0;
        if (sx > W - 1) sx = W - 1;
        if (sy > H - 1) sy = H - 1;
        sw = Math.max(1, Math.min(sw, W - sx));
        sh = Math.max(1, Math.min(sh, H - sy));
        // 取整/钳制后覆盖整帧（如 zoom≈1、region 覆盖全画面）→ 等同不裁：不写多余的整帧副本，
        // 也不产出与「1 = 整帧」契约矛盾的 crop 元数据。
        if (sx === 0 && sy === 0 && sw >= W && sh >= H) return null;
        if (sw < MIN_CROP_PX || sh < MIN_CROP_PX) {
            return { error: '裁切区域过小（' + sw + '×' + sh + 'px，每边至少 ' + MIN_CROP_PX + 'px）' };
        }
        var out = cropOutputSize(sw, sh);
        return {
            mode: mode,
            region: region,
            zoom: (mode === 'zoom') ? _round2(1 / Math.max(region.width, region.height)) : null,
            x: sx, y: sy, width: sw, height: sh,
            outWidth: out.width, outHeight: out.height, scale: out.scale,
            sourceWidth: Math.round(W), sourceHeight: Math.round(H)
        };
    }

    // 裁切描述 → 回执里的 crop 字段（给 LLM 自证：裁的是哪块、输出多大、放大了多少）。
    // region 按 3 位小数收口：1/zoom 会带出 0.333333… 这类浮点噪音，对 LLM 无信息量；
    // 四舍五入后把 x/y 钳回「不超出 1」的闭区间（极端值下 x+width 可能略微越过 1）。
    function cropMeta(crop) {
        var rx = Math.round(crop.region.x * 1000) / 1000;
        var ry = Math.round(crop.region.y * 1000) / 1000;
        var rw = Math.round(crop.region.width * 1000) / 1000;
        var rh = Math.round(crop.region.height * 1000) / 1000;
        return {
            mode: crop.mode,
            region: {
                x: Math.min(rx, Math.max(0, 1 - rw)),
                y: Math.min(ry, Math.max(0, 1 - rh)),
                width: rw,
                height: rh
            },
            zoom: crop.zoom,
            rect: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
            source: { width: crop.sourceWidth, height: crop.sourceHeight },
            output: { width: crop.outWidth, height: crop.outHeight },
            scale: crop.scale
        };
    }

    // 合成回执：保留原多帧字段（times/frames/partial/timesMissing…），把顶层取图字段改指联系表。
    function buildSheetResult(payload, info) {
        var out = {};
        for (var k in payload) {
            if (Object.prototype.hasOwnProperty.call(payload, k)) out[k] = payload[k];
        }
        out.contactSheet = true;
        out.sheetLayout = { cols: info.cols, rows: info.rows, cellWidth: info.cellW, cellHeight: info.cellH };
        out.filePath = info.sheetPath;
        out.fileName = info.sheetName;
        out.width = info.sheetW;
        out.height = info.sheetH;
        out.frameWidth = info.frameW;
        out.frameHeight = info.frameH;
        out.fileSize = info.sheetSize;
        out.sheetNote = 'filePath 是 ' + payload.frameCount + ' 帧合成的一张联系表（每格左上角为该帧时间标签）；'
            + 'frames[].filePath 是各时间点的原始单帧，要细看某帧时可直接读取对应文件。';
        return out;
    }

    // ── canvas 编排 ──

    function loadImage(mkImage, url) {
        return new Promise(function (resolve, reject) {
            var im = mkImage();
            im.onload = function () { resolve(im); };
            im.onerror = function () { reject(new Error('图片加载失败 (' + url.slice(0, 24) + '…)')); };
            im.src = url;
        });
    }

    function canvasToBlob(canvas) {
        return new Promise(function (resolve, reject) {
            if (typeof canvas.toBlob !== 'function') { reject(new Error('画布导出失败（canvas.toBlob 不可用）')); return; }
            canvas.toBlob(function (blob) {
                if (blob) resolve(blob);
                else reject(new Error('画布导出失败（canvas.toBlob 返回空）'));
            }, 'image/png');
        });
    }

    function imageSizeOf(im) {
        return {
            w: im.naturalWidth || im.width || 0,
            h: im.naturalHeight || im.height || 0
        };
    }

    // 单格左上角时间标签（半透明底 + 白字）：让多帧联系表自证「哪一格是哪个时刻」。
    function drawLabel(ctx, label, x, y, layout) {
        if (!label || typeof ctx.fillText !== 'function') return;
        var fs = Math.max(14, Math.round(layout.cellH / 18));
        var pad = Math.round(fs * 0.35);
        ctx.font = fs + 'px sans-serif';
        var barW = Math.min(layout.cellW, Math.round(ctx.measureText(label).width) + pad * 2);
        var barH = fs + pad * 2;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x, y, barW, barH);
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'top';
        ctx.fillText(label, x + pad, y + pad);
    }

    // items: [{url, label, crop?}]（按格子顺序）。crop = {x,y,width,height,outWidth,outHeight}
    // 时按源矩形重绘（同一区域裁各帧），格子尺寸取裁切输出尺寸（再受单格上限约束）。
    // 源矩形按各帧**实际解码尺寸**再钳一次：若 PNG 实际像素与回执 width/height 不一致，
    // 正常路径（两者相同）逐像素不变，异常路径也不会把源矩形画到图外。
    // deps 可选（测试注入）：{createImage, createCanvas, maxCellWidth}。
    function composeSheet(items, deps) {
        deps = deps || {};
        var mkImage = deps.createImage || function () { return new Image(); };
        var mkCanvas = deps.createCanvas || function (w, h) {
            var c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            return c;
        };
        return Promise.all(items.map(function (it) {
            return loadImage(mkImage, it.url);
        })).then(function (imgs) {
            var first = imageSizeOf(imgs[0]);
            var firstCrop = items[0] && items[0].crop;
            var baseW = firstCrop ? firstCrop.outWidth : first.w;
            var baseH = firstCrop ? firstCrop.outHeight : first.h;
            var layout = computeSheetLayout(imgs.length, baseW, baseH, deps.maxCellWidth);
            var canvas = mkCanvas(layout.sheetW, layout.sheetH);
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, layout.sheetW, layout.sheetH);
            for (var i = 0; i < imgs.length; i++) {
                var x = (i % layout.cols) * layout.cellW;
                var y = Math.floor(i / layout.cols) * layout.cellH;
                var c = items[i] && items[i].crop;
                if (c && c.width > 0 && c.height > 0) {
                    var sz = imageSizeOf(imgs[i]);
                    if (sz.w > 0 && sz.h > 0) {
                        var sx = Math.max(0, Math.min(c.x, sz.w - 1));
                        var sy = Math.max(0, Math.min(c.y, sz.h - 1));
                        var sw = Math.max(1, Math.min(c.width, sz.w - sx));
                        var sh = Math.max(1, Math.min(c.height, sz.h - sy));
                        ctx.drawImage(imgs[i], sx, sy, sw, sh, x, y, layout.cellW, layout.cellH);
                    } else {
                        ctx.drawImage(imgs[i], c.x, c.y, c.width, c.height, x, y, layout.cellW, layout.cellH);
                    }
                } else {
                    ctx.drawImage(imgs[i], x, y, layout.cellW, layout.cellH);
                }
                drawLabel(ctx, items[i].label, x, y, layout);
            }
            return canvasToBlob(canvas).then(function (blob) {
                // canvas 一并回传：面板侧直接截同一个工具结果的调用方（如 shader 预览多帧
                // 联系表）可经 toDataURL 取图，不必再绕 PNG blob。
                return { blob: blob, layout: layout, frameW: first.w, frameH: first.h, canvas: canvas };
            });
        });
    }

    // ── 编排（工具结果后处理入口）──

    function dirOf(filePath) {
        var p = String(filePath || '');
        var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        return i > 0 ? p.slice(0, i) : '';
    }

    // 沿用源路径的分隔符拼新文件名（Windows 路径不要混出 C:\dir/x.png 的形态；
    // 与 imageAnalysis._postProcessMulti 的同款先例对齐）。
    function sepOf(filePath) {
        var p = String(filePath || '');
        return (p.lastIndexOf('\\') > p.lastIndexOf('/')) ? '\\' : '/';
    }

    function sheetNameFor(nowMs) {
        // 与单帧同前缀：面板 vision hook 按 /^ae_preview_\d+\.png$/ 识别预览帧，读完进保留池
        //（不即删，池内保留最新 30 张）；外接通道不删（客户端可能自读），
        // 残留由 tempSweep 按龄与保留池兜底清。改了前缀这里必须同步，否则联系表/裁切图
        // 不进池也不被清。
        return 'ae_preview_' + nowMs + '.png';
    }

    function withSheetError(payload, msg) {
        var out = {};
        for (var k in payload) {
            if (Object.prototype.hasOwnProperty.call(payload, k)) out[k] = payload[k];
        }
        out.contactSheet = false;
        out.sheetError = msg;
        return out;
    }

    // 裁切未生效（参数非法/读图失败/写盘失败）：保留整帧结果，只把原因交给 LLM。
    function withCropError(payload, msg) {
        var out = _copy(payload);
        out.cropError = msg;
        out.cropNote = '裁切放大未生效，注入的是整帧；原因：' + msg;
        return out;
    }

    // 裁切描述里的缩放说明（放大/缩小/原样三种，只写有信息量的两种）。
    function scaleNote(scale) {
        if (!(scale > 0) || scale === 1) return '';
        return (scale > 1 ? '（放大 ' + scale + ' 倍）' : '（缩小 ' + scale + ' 倍）');
    }

    // 解码后的实际图像尺寸与回执 width/height 不一致时，按归一化 region 重新映射源矩形。
    // 正常路径两者相同（AE saveFrameToPng 按合成分辨率出帧），此处只是防未来抓帧方式变化后
    // 源矩形静默错位；映射后仍过小则返回 null，由调用方转成 cropError。
    function remapCropToImage(crop, iw, ih) {
        var sx = Math.round(crop.region.x * iw);
        var sy = Math.round(crop.region.y * ih);
        var sw = Math.round(crop.region.width * iw);
        var sh = Math.round(crop.region.height * ih);
        if (sx < 0) sx = 0;
        if (sy < 0) sy = 0;
        if (sx > iw - 1) sx = iw - 1;
        if (sy > ih - 1) sy = ih - 1;
        sw = Math.max(1, Math.min(sw, iw - sx));
        sh = Math.max(1, Math.min(sh, ih - sy));
        if (sw < MIN_CROP_PX || sh < MIN_CROP_PX) return null;
        var out = cropOutputSize(sw, sh);
        var c = _copy(crop);
        c.x = sx; c.y = sy; c.width = sw; c.height = sh;
        c.outWidth = out.width; c.outHeight = out.height; c.scale = out.scale;
        c.sourceWidth = iw; c.sourceHeight = ih;
        return c;
    }

    // PNG IHDR 宽高（面板侧解析）：base64 前 32 字符 → 24 字节，够签名 + IHDR。
    // ExtendScript 的 BINARY read() 在中文 Windows 仍做编码转换（≥0x80 字节被吞），
    // AE 侧读 IHDR 不可靠，故解析只放面板侧。非法/过短/非 PNG → null。
    function pngSizeFromBase64(b64) {
        if (typeof b64 !== 'string' || b64.length < 32) return null;
        var bin;
        try { bin = atob(b64.slice(0, 32)); } catch (_) { return null; }
        if (!bin || bin.length < 24) return null;
        var sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        for (var i = 0; i < 8; i++) { if (bin.charCodeAt(i) !== sig[i]) return null; }
        if (bin.slice(12, 16) !== 'IHDR') return null;
        var w = ((bin.charCodeAt(16) << 24) | (bin.charCodeAt(17) << 16) | (bin.charCodeAt(18) << 8) | bin.charCodeAt(19)) >>> 0;
        var h = ((bin.charCodeAt(20) << 24) | (bin.charCodeAt(21) << 16) | (bin.charCodeAt(22) << 8) | bin.charCodeAt(23)) >>> 0;
        if (!(w > 0 && h > 0)) return null;
        return { width: w, height: h };
    }

    // 单帧无裁切：探测一次 PNG 实际像素。尺寸一致或探测失败 → 原样返回同一对象
    //（调用方依赖同一对象直通）；不一致 → 新对象校正 width/height + sizeNote。
    function _probeSingleFrameSize(payload, deps) {
        var aefs = deps.aefs || global.AEFS;
        if (!aefs || typeof aefs.readImageBase64 !== 'function' || !payload.filePath) {
            return Promise.resolve(payload);
        }
        return Promise.resolve(aefs.readImageBase64(payload.filePath)).then(function (r) {
            if (!r || r.success !== true || !r.base64) return payload;
            var size = pngSizeFromBase64(r.base64);
            if (!size) return payload;
            if (size.width === payload.width && size.height === payload.height) return payload;
            var out = _copy(payload);
            out.width = size.width;
            out.height = size.height;
            out.sizeNote = 'width/height 已按 PNG 实际像素校正（合成尺寸口径为 '
                + payload.width + '×' + payload.height + '）';
            return out;
        }).catch(function () {
            return payload;
        });
    }

    // 单帧裁切：读原帧 → canvas 按源矩形重绘到裁切输出尺寸 → 写新 PNG → 回执改指新图。
    // 失败一律回 withCropError（工具本身已成功，不因裁切失败报错）。
    function cropSingleFrame(payload, crop, deps) {
        var aefs = deps.aefs || global.AEFS;
        if (!aefs || typeof aefs.readImageBase64 !== 'function' || typeof aefs.writeBlob !== 'function') {
            return Promise.resolve(withCropError(payload, 'AEFS 图片通道不可用，未做裁切放大'));
        }
        var srcPath = payload.filePath;
        if (!srcPath) return Promise.resolve(withCropError(payload, '结果里没有 filePath，无法裁切'));
        var mkImage = deps.createImage || function () { return new Image(); };
        var mkCanvas = deps.createCanvas || function (w, h) {
            var c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            return c;
        };
        return Promise.resolve(aefs.readImageBase64(srcPath)).then(function (r) {
            if (!r || r.success !== true || !r.base64) throw new Error('原帧读取失败');
            return loadImage(mkImage, 'data:' + (r.mime || 'image/png') + ';base64,' + r.base64);
        }).then(function (img) {
            var iw = img.naturalWidth || img.width || 0;
            var ih = img.naturalHeight || img.height || 0;
            var use = crop;
            if (iw > 0 && ih > 0 && (iw !== crop.sourceWidth || ih !== crop.sourceHeight)) {
                use = remapCropToImage(crop, iw, ih);
                if (!use) throw new Error('裁切区域与图像尺寸不匹配（图像 ' + iw + '×' + ih + '）');
            }
            var canvas = mkCanvas(use.outWidth, use.outHeight);
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, use.x, use.y, use.width, use.height, 0, 0, use.outWidth, use.outHeight);
            return canvasToBlob(canvas).then(function (blob) {
                return { blob: blob, use: use };
            });
        }).then(function (made) {
            var blob = made.blob, use = made.use;
            var nowMs = (typeof deps.now === 'number') ? deps.now : (new Date()).getTime();
            var name = sheetNameFor(nowMs);
            var path = dirOf(srcPath) + sepOf(srcPath) + name;
            return Promise.resolve(aefs.writeBlob(path, blob)).then(function (ok) {
                if (ok !== true) throw new Error('裁切图写盘失败: ' + path);
                var out = _copy(payload);
                out.fullFramePath = payload.filePath;
                out.filePath = path;
                out.fileName = name;
                out.width = use.outWidth;
                out.height = use.outHeight;
                out.fileSize = (blob && blob.size) || 0;
                out.crop = cropMeta(use);
                out.cropNote = '图已裁切放大：整帧 ' + use.sourceWidth + '×' + use.sourceHeight
                    + ' → 区域 x=' + use.x + ' y=' + use.y + ' ' + use.width + '×' + use.height
                    + ' → 输出 ' + use.outWidth + '×' + use.outHeight
                    + scaleNote(use.scale)
                    + '；整帧仍在 fullFramePath。核对整帧构图时不要传 region/zoom。';
                // iendVerified 描述的是原帧（AE 侧校验）；裁切图由 canvas 导出，完整写入由 writeBlob 保证。
                return out;
            });
        }).catch(function (e) {
            return withCropError(payload, String((e && e.message) || e));
        });
    }

    // 多时间点 + 裁切：每帧读一次，按同一源矩形重绘到格子（格子取裁切输出尺寸、再受单格上限约束），
    // 再拼带时间标签的联系表。合成/读取失败沿用既有降级语义（contactSheet:false + sheetError），
    // 同时补 cropError（裁切未生效时让 LLM 知道看的是整帧）。
    function _postProcessFrames(payload, deps, crop, cropErr) {
        var aefs = deps.aefs || global.AEFS;
        if (!aefs || typeof aefs.readImageBase64 !== 'function' || typeof aefs.writeBlob !== 'function') {
            var failedNoAefs = withSheetError(payload, 'AEFS 图片通道不可用，未合成联系表');
            if (cropErr) failedNoAefs.cropError = cropErr;
            else if (crop) failedNoAefs.cropError = '裁切未生效：AEFS 图片通道不可用';
            return Promise.resolve(failedNoAefs);
        }
        var frames = payload.frames;
        var sizeFailed = false;
        var sizeFailCount = 0;
        var sizeFailIdx = [];
        var firstSize = null;
        return Promise.all(frames.map(function (f) {
            return Promise.resolve(aefs.readImageBase64(f.filePath));
        })).then(function (reads) {
            // 按 PNG 实际像素（IHDR）校正 frames[].width/height；请求了裁切时把源矩形
            // 重映射到实际图像尺寸（合成尺寸口径可能与抓帧分辨率不一致）
            for (var i = 0; i < frames.length; i++) {
                var r = reads[i];
                if (!r || r.success !== true || !r.base64) {
                    throw new Error('联系表：第 ' + (i + 1) + ' 帧读取失败 (' + frames[i].fileName + ')');
                }
                var sz = pngSizeFromBase64(r.base64);
                if (sz) {
                    if (!firstSize) firstSize = sz;
                    frames[i].width = sz.width;
                    frames[i].height = sz.height;
                } else {
                    sizeFailed = true;
                    sizeFailCount++;
                    sizeFailIdx.push(i + 1);
                }
            }
            if (crop && firstSize
                && (firstSize.width !== crop.sourceWidth || firstSize.height !== crop.sourceHeight)) {
                crop = remapCropToImage(crop, firstSize.width, firstSize.height);
                if (!crop) {
                    cropErr = '裁切区域与图像尺寸不匹配（图像 ' + firstSize.width + '×' + firstSize.height + '）';
                }
            }
            var items = [];
            for (var j = 0; j < frames.length; j++) {
                items.push({
                    url: 'data:' + (reads[j].mime || 'image/png') + ';base64,' + reads[j].base64,
                    label: formatTimeLabel(frames[j].time),
                    crop: crop ? {
                        x: crop.x, y: crop.y, width: crop.width, height: crop.height,
                        outWidth: crop.outWidth, outHeight: crop.outHeight
                    } : null
                });
            }
            return composeSheet(items, deps);
        }).then(function (sheet) {
            var nowMs = (typeof deps.now === 'number') ? deps.now : (new Date()).getTime();
            var sheetName = sheetNameFor(nowMs);
            var sheetPath = dirOf(frames[0].filePath) + sepOf(frames[0].filePath) + sheetName;
            return Promise.resolve(aefs.writeBlob(sheetPath, sheet.blob)).then(function (ok) {
                if (ok !== true) throw new Error('联系表写盘失败: ' + sheetPath);
                var out = buildSheetResult(payload, {
                    sheetPath: sheetPath,
                    sheetName: sheetName,
                    sheetSize: (sheet.blob && sheet.blob.size) || 0,
                    cols: sheet.layout.cols, rows: sheet.layout.rows,
                    cellW: sheet.layout.cellW, cellH: sheet.layout.cellH,
                    sheetW: sheet.layout.sheetW, sheetH: sheet.layout.sheetH,
                    frameW: sheet.frameW, frameH: sheet.frameH
                });
                if (sizeFailed) {
                    out.sizeNote = (sizeFailCount === frames.length
                        ? '全部帧未能读取实际像素，frames[].width/height 仍为合成尺寸口径'
                        : '第 ' + sizeFailIdx.join('、') + ' 帧未能读取实际像素，其 width/height 仍为合成尺寸口径');
                }
                if (crop) {
                    out.crop = cropMeta(crop);
                    // 单格上限可能把裁切输出再压一次（多帧整表总预算优先）——如实写进回执，
                    // 避免 LLM 以为每格就是裁切的原始像素。
                    var capped = (sheet.layout.cellW < crop.outWidth || sheet.layout.cellH < crop.outHeight);
                    out.cropNote = '每格为同一裁切区域（' + crop.mode + '）：整帧 '
                        + crop.sourceWidth + '×' + crop.sourceHeight
                        + ' → 区域 x=' + crop.x + ' y=' + crop.y + ' ' + crop.width + '×' + crop.height
                        + ' → 每格 ' + sheet.layout.cellW + '×' + sheet.layout.cellH
                        + scaleNote(crop.scale)
                        + (capped ? '（裁切输出 ' + crop.outWidth + '×' + crop.outHeight
                            + ' 超过 ' + MAX_CELL_WIDTH + ' 单格上限，已缩到单格）' : '')
                        + '；全帧仍在 frames[].filePath。核对整帧构图时不要传 region/zoom。';
                }
                if (cropErr) out.cropError = cropErr;
                return out;
            });
        }).catch(function (e) {
            var msg = String((e && e.message) || e);
            var failed = withSheetError(payload, msg);
            // 顶层尺寸与 frames[0] 同口径（降级时顶层 filePath 回退指第一帧）
            failed.width = frames[0].width;
            failed.height = frames[0].height;
            if (cropErr) failed.cropError = cropErr;
            else if (crop) failed.cropError = '裁切未生效：' + msg;
            return failed;
        });
    }

    // 工具结果后处理入口。签名与 imageAnalysis.postProcessAnalyzeImage 同形：
    // (payload, args, deps)。args = 本次工具调用的入参（region/zoom 在这里读）；
    // deps 仅测试注入（{aefs, now, createImage, createCanvas, maxCellWidth}），生产为 undefined。
    // 单帧：未请求裁切时探测一次 PNG 实际像素——尺寸一致（或探测失败）原样返回同一对象，
    // 不一致则新对象校正 width/height；请求了裁切则产出裁切图。
    // 多帧：在原联系表流程上叠加「按同一区域裁各帧」与 IHDR 尺寸校正。
    function postProcessPreviewFrames(payload, args, deps) {
        deps = deps || {};
        if (!payload || payload.status !== 'success') return Promise.resolve(payload);
        var frames = (Array.isArray(payload.frames) && payload.frames.length >= 2) ? payload.frames : null;
        var frameW, frameH;
        if (frames) {
            frameW = (frames[0] && frames[0].width !== undefined) ? frames[0].width : payload.width;
            frameH = (frames[0] && frames[0].height !== undefined) ? frames[0].height : payload.height;
        } else {
            frameW = payload.width;
            frameH = payload.height;
        }
        var req = parseCropRequest(args, frameW, frameH);
        var cropErr = (req && req.error) ? req.error : '';
        var crop = (req && !req.error) ? req : null;
        if (frames) return _postProcessFrames(payload, deps, crop, cropErr);
        if (!crop) {
            if (cropErr) return Promise.resolve(withCropError(payload, cropErr));
            return _probeSingleFrameSize(payload, deps);
        }
        return cropSingleFrame(payload, crop, deps);
    }

    global.AEPreviewSheet = {
        MAX_CELL_WIDTH: MAX_CELL_WIDTH,
        MAX_ZOOM: MAX_ZOOM,
        MIN_CROP_PX: MIN_CROP_PX,
        MIN_CROP_LONG_SIDE: MIN_CROP_LONG_SIDE,
        MAX_CROP_UPSCALE: MAX_CROP_UPSCALE,
        MAX_CROP_W: MAX_CROP_W,
        MAX_CROP_H: MAX_CROP_H,
        gridFor: gridFor,
        computeSheetLayout: computeSheetLayout,
        formatTimeLabel: formatTimeLabel,
        cropOutputSize: cropOutputSize,
        parseCropRequest: parseCropRequest,
        cropMeta: cropMeta,
        buildSheetResult: buildSheetResult,
        pngSizeFromBase64: pngSizeFromBase64,
        composeSheet: composeSheet,
        postProcessPreviewFrames: postProcessPreviewFrames
    };

})(window);
