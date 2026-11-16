// imageAnalysis.js — analyzeImage 参数化图片分析（面板侧解码 + 纯像素统计）
//
// 位置与职责：AE 侧（aeTools.jsx 的 analyzeImage）只负责「确定分析对象」——给了 filePath 就
// 返回该文件元数据，没给就抓当前合成一帧（复用 getPreviewFrame 的完整落盘/IEND 校验链）。
// 像素解码与全部统计都在**面板侧**做：AE 没有 canvas/Image，也没有可用的像素读取 API
//（AE 23.5 无 Layer.sampleImage），故 AE 侧出 PNG、面板侧用 canvas 解码
// 后跑本文件的纯函数。
//
// 接线：bootstrap.js 的 registerToolsFromConfig 把它挂成 analyzeImage 的 createHandler
// postProcess（controller.js 重注册路径与 view.js 抽屉试运行同款接线）——面板 Agent 与外接
// MCP 两条通道共用同一 handler，故指标两边一致。
//
// 图片回送（设计 C）：本模块**不决定**图片是否进上下文，只把 attachImage 写进结果：
//   抓帧模式（无 filePath）→ attachImage:true → controller 的 vision hook 读 filePath 注入图片；
//   文件模式（给定 filePath）→ attachImage:false → 只回指标，不注入图片。
//
// 纯函数（analyzePixels / computeSampleSize / lumaOf 等）不碰 DOM，可 vm 单测；
// canvas/Image 编排依赖浏览器，真机验证。
(function (global) {
    'use strict';

    var DEFAULT_MAX_EDGE = 1024;
    var MIN_MAX_EDGE = 64;
    var MAX_MAX_EDGE = 4096;
    // 分析像素硬顶：默认 maxEdge=1024；用户调大 maxEdge 时仍不超过 2048²，
    // 否则单次调用在面板主线程上的统计开销与像素数组内存无界增长。
    var MAX_SAMPLED_PIXELS = 4194304;
    // 精确去重色数用 Set 全量存 (r<<16|g<<8|b)：只在采样像素数不超此上限时做，
    // 否则改报 quantizedColorBins（5 bit/通道占位桶数）避免一次调用吃几十 MB。
    var EXACT_UNIQUE_LIMIT = 262144;
    var DEFAULT_TOP_COLORS = 8;
    var MAX_TOP_COLORS = 16;
    var MAX_REGIONS = 8;
    var HUE_BIN_COUNT = 12;
    // 多帧结果的单条工具结果安全上限：管线在 32K 字符处截断（截断会切坏 JSON →
    // vision hook 解析失败、图片不注入），故留余量按 30K 主动分层裁剪。
    var MULTI_RESULT_MAX_CHARS = 30000;
    var LUMA_FORMULA = 'Rec.709 (0.2126R + 0.7152G + 0.0722B)';
    var LUMA_W_SUM = 0.2126 + 0.7152 + 0.0722;   // =1（浮点相加为 0.999…，除以它保证白=255）

    // ── 基础工具 ──

    function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    function _round(v, digits) {
        var n = Number(v);
        if (!isFinite(n)) return 0;
        var f = Math.pow(10, digits === undefined ? 2 : digits);
        return Math.round(n * f) / f;
    }

    function _hex2(r, g, b) {
        var h = ((Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)).toString(16);
        while (h.length < 6) h = '0' + h;
        return '#' + h;
    }

    // Rec.709 亮度（伽马编码值上的近似，与 CSS 亮度感知一致；逐像素统计只需同口径）
    function lumaOf(r, g, b) {
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / LUMA_W_SUM;
    }

    // 采样尺寸：最长边不超过 maxEdge，总像素不超过 MAX_SAMPLED_PIXELS。
    // 返回 {width, height, scale}（scale = 采样宽 / 源宽）。
    function computeSampleSize(sourceWidth, sourceHeight, maxEdge) {
        var sw = Math.max(1, Math.floor(Number(sourceWidth) || 0));
        var sh = Math.max(1, Math.floor(Number(sourceHeight) || 0));
        var cap = Number(maxEdge);
        if (!isFinite(cap) || cap <= 0) cap = DEFAULT_MAX_EDGE;
        cap = Math.floor(_clamp(cap, MIN_MAX_EDGE, MAX_MAX_EDGE));
        var longest = Math.max(sw, sh);
        var scale = longest > cap ? (cap / longest) : 1;
        var w = Math.max(1, Math.round(sw * scale));
        var h = Math.max(1, Math.round(sh * scale));
        if (w * h > MAX_SAMPLED_PIXELS) {
            var pixelScale = Math.sqrt(MAX_SAMPLED_PIXELS / (w * h));
            w = Math.max(1, Math.floor(w * pixelScale));
            h = Math.max(1, Math.floor(h * pixelScale));
        }
        return { width: w, height: h, scale: w / sw };
    }

    // 直方图中排名第 k 位的取值（k 为 0-based 名次；直方图每个桶代表一个离散取值）。
    function _valueAtRank(hist, k) {
        var acc = 0;
        for (var i = 0; i < hist.length; i++) {
            acc += hist[i];
            if (acc > k) return i;
        }
        return hist.length - 1;
    }

    // 直方图分位数：hist 为按值升序的计数数组，total 为像素总数，q ∈ [0,1]。
    // 按「名次 = q·(n−1)」在线性插值：桶宽为 1 时等价于对有序样本做常规分位数插值
    //（两像素 0/255 的 p50 = 127.5，而不是把桶内插值误算成 0.5）。
    function percentileFromHistogram(hist, total, q) {
        var n = Number(total) || 0;
        if (n <= 0 || !hist || !hist.length) return 0;
        var rank = _clamp(Number(q) || 0, 0, 1) * (n - 1);
        var lo = Math.floor(rank);
        var hi = Math.ceil(rank);
        var vlo = _valueAtRank(hist, lo);
        if (hi === lo) return vlo;
        var vhi = _valueAtRank(hist, hi);
        return vlo + (vhi - vlo) * (rank - lo);
    }

    function _normalizeRegions(regions) {
        if (!Array.isArray(regions)) return [];
        var out = [];
        for (var i = 0; i < regions.length && out.length < MAX_REGIONS; i++) {
            var r = regions[i] || {};
            var x = Number(r.x), y = Number(r.y), w = Number(r.width), h = Number(r.height);
            if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) continue;
            if (w <= 0 || h <= 0) continue;
            out.push({
                name: (r.name === undefined || r.name === null || r.name === '') ? ('region' + (out.length + 1)) : String(r.name),
                x: Math.floor(x), y: Math.floor(y), width: Math.floor(w), height: Math.floor(h)
            });
        }
        return out;
    }

    function normalizeOptions(options) {
        options = options || {};
        var maxEdge = Number(options.maxEdge);
        if (!isFinite(maxEdge) || maxEdge <= 0) maxEdge = DEFAULT_MAX_EDGE;
        var topColors = Number(options.topColors);
        if (!isFinite(topColors) || topColors <= 0) topColors = DEFAULT_TOP_COLORS;
        return {
            maxEdge: Math.floor(_clamp(maxEdge, MIN_MAX_EDGE, MAX_MAX_EDGE)),
            topColors: Math.floor(_clamp(topColors, 1, MAX_TOP_COLORS)),
            regions: _normalizeRegions(options.regions),
            // 参考图路径（可选）：给了就输出 compare（对比指标）；'' = 不做对比
            comparePath: (typeof options.comparePath === 'string') ? options.comparePath.replace(/^\s+|\s+$/g, '') : ''
        };
    }

    // ── 感知哈希（8×8 网格）──
    // 单图指标与参考图对比共用同一实现：aHash=平均亮度自适应哈希（64 位），
    // dHash/vHash=水平/垂直相邻格差分哈希（各 56 位）。同一画面重渲染应得相同 aHash。
    function _bitsToHex(bits) {
        var hx = '';
        for (var bi = 0; bi < bits.length; bi += 4) {
            hx += parseInt(bits.substr(bi, 4), 2).toString(16);
        }
        return hx;
    }

    function hashesFromLuma(luma, width, height) {
        var w = Math.max(1, Math.floor(Number(width) || 0));
        var h = Math.max(1, Math.floor(Number(height) || 0));
        var cell = new Float64Array(64), cnt = new Float64Array(64);
        for (var i = 0; i < w * h; i++) {
            var x = i % w, y = (i - x) / w;
            var gx = Math.min(7, Math.floor(x * 8 / w));
            var gy = Math.min(7, Math.floor(y * 8 / h));
            var ci = gy * 8 + gx;
            cell[ci] += luma[i] || 0;
            cnt[ci]++;
        }
        var vals = [], avg = 0;
        for (var k = 0; k < 64; k++) {
            var v = cnt[k] > 0 ? cell[k] / cnt[k] : 0;
            vals.push(v);
            avg += v;
        }
        avg /= 64;
        var aBits = '';
        for (k = 0; k < 64; k++) aBits += (vals[k] >= avg ? '1' : '0');
        var dBits = '', vBits = '', rr, rx, ry;
        for (ry = 0; ry < 8; ry++) {
            for (rx = 0; rx < 7; rx++) {
                rr = ry * 8 + rx;
                dBits += (vals[rr] > vals[rr + 1] ? '1' : '0');
            }
        }
        for (rx = 0; rx < 8; rx++) {
            for (ry = 0; ry < 7; ry++) {
                rr = ry * 8 + rx;
                vBits += (vals[rr] > vals[rr + 8] ? '1' : '0');
            }
        }
        return {
            aHash: _bitsToHex(aBits),
            dHash: _bitsToHex(dBits),
            vHash: _bitsToHex(vBits),
            note: 'aHash=64 位平均亮度哈希；dHash/vHash=56 位水平/垂直差分哈希。同一画面重渲染应得到相同 aHash；'
                + '两图 aHash 不同即画面有变化（差分哈希用于粗略判断变化方向）'
        };
    }

    // 十六进制哈希的汉明距离（两串等长；位数 = 4 × 长度）
    function hashDistance(hexA, hexB) {
        var a = String(hexA || ''), b = String(hexB || '');
        var len = Math.min(a.length, b.length);
        var dist = 0;
        for (var i = 0; i < len; i++) {
            var x = parseInt(a.charAt(i), 16) ^ parseInt(b.charAt(i), 16);
            if (isNaN(x)) continue;
            dist += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
        }
        return dist;
    }

    // ── 纯像素统计 ──
    // rgba：Uint8ClampedArray（canvas getImageData().data）或等价的 4 通道数组；
    // width/height：采样后尺寸；options：{sourceWidth, sourceHeight, topColors, regions}。
    function analyzePixels(rgba, width, height, options) {
        options = options || {};
        var w = Math.max(1, Math.floor(Number(width) || 0));
        var h = Math.max(1, Math.floor(Number(height) || 0));
        var n = w * h;
        var data = rgba || [];
        var sourceWidth = Math.floor(Number(options.sourceWidth) || w);
        var sourceHeight = Math.floor(Number(options.sourceHeight) || h);
        var topColors = Math.floor(_clamp(Number(options.topColors) || DEFAULT_TOP_COLORS, 1, MAX_TOP_COLORS));
        var regions = _normalizeRegions(options.regions);

        var histL = new Float64Array(256);
        var histR = new Float64Array(256);
        var histG = new Float64Array(256);
        var histB = new Float64Array(256);
        var histS = new Float64Array(256);      // 饱和度（0–1 线性量化到 0–255 桶）
        var luma = new Uint8Array(n);

        var sumR = 0, sumG = 0, sumB = 0, sumR2 = 0, sumG2 = 0, sumB2 = 0;
        var minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
        var sumL = 0, sumL2 = 0, minL = 255, maxL = 0;
        var sumSat = 0, sumSat2 = 0;
        var sumV = 0, sumV2 = 0, minV = 255, maxV = 0;
        var hueBin = new Float64Array(HUE_BIN_COUNT);
        var hueSin = 0, hueCos = 0, chromaPixels = 0;
        var warmPixels = 0, coolPixels = 0;
        var grayPixels = 0;
        var sumA = 0, minA = 255, maxA = 0, transparentPixels = 0, fullyTransparentPixels = 0;
        // 不透明像素（alpha>=250）单独的亮度统计：透明渲染的黑底/RGB=0 像素会把全图
        // 亮度均值拉低（实机 sprite 实测均值 23.8，主体其实不暗），主体曝光要看这一组。
        var opaqueCount = 0, opaqueSumL = 0, opaqueSumL2 = 0, opaqueOver = 0, opaqueUnder = 0;
        var sumL3 = 0, sumL4 = 0;                             // 三/四阶中心矩（偏度/峰度）
        var centerSumL = 0, centerCount = 0, borderSumL = 0, borderCount = 0;
        var sumRG = 0, sumRG2 = 0, sumYB = 0, sumYB2 = 0;   // 色彩丰富度（Hasler–Süsstrunk）
        var cell3 = new Float64Array(9), cell3Count = new Float64Array(9);
        var cell4 = new Float64Array(16), cell4Count = new Float64Array(16);
        // 主色：5 bit/通道量化为 32768 桶，累计桶内像素数与通道和（桶内取平均色）
        var binCount = new Int32Array(32768);
        var binR = new Float64Array(32768);
        var binG = new Float64Array(32768);
        var binB = new Float64Array(32768);
        var exactColors = (n <= EXACT_UNIQUE_LIMIT) ? new Set() : null;

        var i, p, r, g, b, a, l, v, m, chroma;
        for (i = 0; i < n; i++) {
            p = i * 4;
            r = data[p] || 0;
            g = data[p + 1] || 0;
            b = data[p + 2] || 0;
            a = (data[p + 3] === undefined) ? 255 : data[p + 3];

            sumR += r; sumG += g; sumB += b;
            sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
            if (r < minR) minR = r; if (r > maxR) maxR = r;
            if (g < minG) minG = g; if (g > maxG) maxG = g;
            if (b < minB) minB = b; if (b > maxB) maxB = b;
            histR[r]++; histG[g]++; histB[b]++;

            l = lumaOf(r, g, b);
            sumL += l; sumL2 += l * l;
            sumL3 += l * l * l; sumL4 += l * l * l * l;
            if (l < minL) minL = l; if (l > maxL) maxL = l;
            var li = Math.round(l);
            if (li < 0) li = 0; if (li > 255) li = 255;
            luma[i] = li;
            histL[li]++;

            // HSV：V = max，S = chroma / max（max=0 时 S=0），H 只在有彩度时统计
            m = r > g ? (r > b ? r : b) : (g > b ? g : b);
            var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
            chroma = m - mn;
            v = m;
            var sat = (m === 0) ? 0 : (chroma / m);
            sumSat += sat; sumSat2 += sat * sat;
            sumV += v; sumV2 += v * v;
            if (v < minV) minV = v; if (v > maxV) maxV = v;
            var si = Math.round(sat * 255);
            if (si < 0) si = 0; if (si > 255) si = 255;
            histS[si]++;
            if (chroma <= 8) grayPixels++;
            if (chroma >= 8 && v > 0) {
                var hue;
                if (m === r) hue = 60 * (((g - b) / chroma) % 6);
                else if (m === g) hue = 60 * ((b - r) / chroma + 2);
                else hue = 60 * ((r - g) / chroma + 4);
                if (hue < 0) hue += 360;
                if (hue >= 360) hue -= 360;
                var hb = Math.floor(hue / (360 / HUE_BIN_COUNT));
                if (hb < 0) hb = 0; if (hb >= HUE_BIN_COUNT) hb = HUE_BIN_COUNT - 1;
                hueBin[hb]++;
                var rad = hue * Math.PI / 180;
                hueSin += Math.sin(rad);
                hueCos += Math.cos(rad);
                chromaPixels++;
                // 冷暖分布（按色相粗分）：暖 = 红橙黄（315°–360°/0°–75°），冷 = 青蓝（165°–255°）
                if (hue <= 75 || hue >= 315) warmPixels++;
                else if (hue >= 165 && hue <= 255) coolPixels++;
            }

            // alpha
            sumA += a;
            if (a < minA) minA = a; if (a > maxA) maxA = a;
            if (a < 250) { transparentPixels++; if (a === 0) fullyTransparentPixels++; }
            else {
                opaqueCount++; opaqueSumL += l; opaqueSumL2 += l * l;
                if (l >= 250) opaqueOver++;
                if (l <= 5) opaqueUnder++;
            }

            // 色彩丰富度
            var rg = r - g;
            var yb = 0.5 * (r + g) - b;
            sumRG += rg; sumRG2 += rg * rg; sumYB += yb; sumYB2 += yb * yb;

            // 主色量化桶
            var qr = r >> 3, qg = g >> 3, qb = b >> 3;
            var bin = (qr << 10) | (qg << 5) | qb;
            binCount[bin]++; binR[bin] += r; binG[bin] += g; binB[bin] += b;

            // 精确去重色数（采样像素不超上限时才做）
            if (exactColors) exactColors.add((r << 16) | (g << 8) | b);

            // 亮度网格（按像素坐标比例落格）
            var x = i % w, y = (i - x) / w;
            var gx3 = Math.min(2, Math.floor(x * 3 / w));
            var gy3 = Math.min(2, Math.floor(y * 3 / h));
            var idx3 = gy3 * 3 + gx3;
            cell3[idx3] += l; cell3Count[idx3]++;
            var gx4 = Math.min(3, Math.floor(x * 4 / w));
            var gy4 = Math.min(3, Math.floor(y * 4 / h));
            var idx4 = gy4 * 4 + gx4;
            cell4[idx4] += l; cell4Count[idx4]++;

            // 中心 50% 与边角：构图/暗角参考（边角比中心暗 = 正向暗角）
            if (x >= w * 0.25 && x < w * 0.75 && y >= h * 0.25 && y < h * 0.75) {
                centerSumL += l; centerCount++;
            } else {
                borderSumL += l; borderCount++;
            }
        }

        // 亮度直方图视角的常用统计
        var meanL = sumL / n;
        var stdL = Math.sqrt(Math.max(0, sumL2 / n - meanL * meanL));
        var pcts = {};
        [1, 5, 10, 25, 50, 75, 90, 95, 99].forEach(function (q) {
            pcts['p' + q] = _round(percentileFromHistogram(histL, n, q / 100), 2);
        });
        var overCount = 0, underCount = 0, midCount = 0, clippedWhite = 0, clippedBlack = 0;
        for (i = 0; i < 256; i++) {
            if (i >= 250) overCount += histL[i];
            if (i <= 5) underCount += histL[i];
            if (i >= 32 && i <= 223) midCount += histL[i];
            if (i >= 254) clippedWhite += histL[i];
            if (i <= 1) clippedBlack += histL[i];
        }
        var entropy = 0;
        for (i = 0; i < 256; i++) {
            if (histL[i] > 0) {
                var pr = histL[i] / n;
                entropy -= pr * Math.log(pr) / Math.LN2;
            }
        }
        var dynamicRange = _round(pcts.p99 - pcts.p1, 2);
        var contrast = _round(pcts.p95 - pcts.p5, 2);

        // ── 亮度分布形状：偏度/峰度/四分位距/阴影高光占比/曝光偏移 ──
        // 中心矩由原始像素矩计算（与直方图同一批像素，避免二次遍历误差）。
        var m3 = sumL3 / n - 3 * meanL * (sumL2 / n) + 2 * meanL * meanL * meanL;
        var m4 = sumL4 / n - 4 * meanL * (sumL3 / n) + 6 * meanL * meanL * (sumL2 / n)
            - 3 * meanL * meanL * meanL * meanL;
        var skewness = (stdL > 1e-9) ? m3 / (stdL * stdL * stdL) : 0;
        var kurtosis = (stdL > 1e-9) ? (m4 / (stdL * stdL * stdL * stdL)) - 3 : 0;
        var shadowCount = 0, highlightCount = 0;
        var iqr = pcts.p75 - pcts.p25;
        var spread10_90 = pcts.p90 - pcts.p10;
        for (i = 0; i < 256; i++) {
            if (i <= 31) shadowCount += histL[i];
            if (i >= 224) highlightCount += histL[i];
        }
        // 18% 中灰作基准的曝光偏移（EV；+1 = 亮一档）
        var exposureEv = Math.log(Math.max(meanL, 1) / 255 / 0.18) / Math.LN2;
        // 直方图峰：计数最高的三个亮度桶（色阶/背景主要亮度）
        var peakBins = [];
        for (i = 0; i < 256; i++) if (histL[i] > 0) peakBins.push(i);
        peakBins.sort(function (a1, b1) { return histL[b1] - histL[a1]; });
        var histogramPeaks = [];
        for (i = 0; i < peakBins.length && i < 3; i++) {
            histogramPeaks.push({ value: peakBins[i], ratio: _round(histL[peakBins[i]] / n, 4) });
        }
        // 白点/黑点：亮度前 1% / 后 1% 像素的平均 RGB（白平衡与黑位参考）
        var whiteThr = pcts.p99, blackThr = pcts.p1;
        var whiteCnt = 0, whiteR = 0, whiteG = 0, whiteB = 0;
        var blackCnt = 0, blackR = 0, blackG = 0, blackB = 0;
        for (i = 0; i < n; i++) {
            var qp = i * 4;
            var qr2 = data[qp] || 0, qg2 = data[qp + 1] || 0, qb2 = data[qp + 2] || 0;
            var ql = luma[i];
            if (ql >= whiteThr) { whiteCnt++; whiteR += qr2; whiteG += qg2; whiteB += qb2; }
            if (ql <= blackThr) { blackCnt++; blackR += qr2; blackG += qg2; blackB += qb2; }
        }
        var whitePoint = whiteCnt ? {
            threshold: _round(whiteThr, 2),
            rgb: [_round(whiteR / whiteCnt, 1), _round(whiteG / whiteCnt, 1), _round(whiteB / whiteCnt, 1)],
            hex: _hex2(whiteR / whiteCnt, whiteG / whiteCnt, whiteB / whiteCnt),
            pixels: whiteCnt
        } : null;
        var blackPoint = blackCnt ? {
            threshold: _round(blackThr, 2),
            rgb: [_round(blackR / blackCnt, 1), _round(blackG / blackCnt, 1), _round(blackB / blackCnt, 1)],
            hex: _hex2(blackR / blackCnt, blackG / blackCnt, blackB / blackCnt),
            pixels: blackCnt
        } : null;

        // 通道统计
        function channelStats(hist, sum, sum2, min, max) {
            var mean = sum / n;
            return {
                mean: _round(mean, 2),
                std: _round(Math.sqrt(Math.max(0, sum2 / n - mean * mean)), 2),
                min: min, max: max,
                median: _round(percentileFromHistogram(hist, n, 0.5), 2),
                p5: _round(percentileFromHistogram(hist, n, 0.05), 2),
                p95: _round(percentileFromHistogram(hist, n, 0.95), 2)
            };
        }

        // 色彩丰富度
        var meanRG = sumRG / n, meanYB = sumYB / n;
        var stdRG = Math.sqrt(Math.max(0, sumRG2 / n - meanRG * meanRG));
        var stdYB = Math.sqrt(Math.max(0, sumYB2 / n - meanYB * meanYB));
        var colorfulness = Math.sqrt(stdRG * stdRG + stdYB * stdYB)
            + 0.3 * Math.sqrt(meanRG * meanRG + meanYB * meanYB);

        // 主色：桶内像素数降序，取前 topColors
        var binList = [];
        for (i = 0; i < 32768; i++) {
            if (binCount[i] > 0) binList.push(i);
        }
        binList.sort(function (a1, b1) { return binCount[b1] - binCount[a1]; });
        var dominantColors = [];
        for (i = 0; i < binList.length && i < topColors; i++) {
            var bi = binList[i];
            var cnt = binCount[bi];
            var cr = binR[bi] / cnt, cg = binG[bi] / cnt, cb = binB[bi] / cnt;
            dominantColors.push({
                hex: _hex2(cr, cg, cb),
                ratio: _round(cnt / n, 4),
                rgb: [Math.round(cr), Math.round(cg), Math.round(cb)]
            });
        }

        // 饱和度与色相
        var meanSat = sumSat / n;
        var stdSat = Math.sqrt(Math.max(0, sumSat2 / n - meanSat * meanSat));
        var satMedian = percentileFromHistogram(histS, n, 0.5) / 255;
        var satP5 = percentileFromHistogram(histS, n, 0.05) / 255;
        var satP95 = percentileFromHistogram(histS, n, 0.95) / 255;
        var highSat = 0, lowSat = 0;
        for (i = 0; i < 256; i++) {
            if (i >= 128) highSat += histS[i];
            if (i < 26) lowSat += histS[i];
        }
        var hue = null;
        if (chromaPixels > 0) {
            var meanRad = Math.atan2(hueSin / chromaPixels, hueCos / chromaPixels);
            var meanDeg = meanRad * 180 / Math.PI;
            if (meanDeg < 0) meanDeg += 360;
            var rbar = Math.sqrt(hueSin * hueSin + hueCos * hueCos) / chromaPixels;
            var circStdRad = Math.sqrt(Math.max(0, -2 * Math.log(Math.min(1, Math.max(1e-9, rbar)))));
            var hueRatios = [];
            var dominantHueBin = 0;
            for (i = 0; i < HUE_BIN_COUNT; i++) {
                var ratio = hueBin[i] / chromaPixels;
                hueRatios.push(_round(ratio, 4));
                if (hueBin[i] > hueBin[dominantHueBin]) dominantHueBin = i;
            }
            hue = {
                meanDeg: _round(meanDeg, 1),
                circularStdDeg: _round(circStdRad * 180 / Math.PI, 1),
                chromaPixelRatio: _round(chromaPixels / n, 4),
                dominantBin: dominantHueBin,
                dominantRange: [dominantHueBin * (360 / HUE_BIN_COUNT), (dominantHueBin + 1) * (360 / HUE_BIN_COUNT)],
                histogram: hueRatios
            };
        } else {
            hue = {
                meanDeg: null,
                circularStdDeg: null,
                chromaPixelRatio: 0,
                dominantBin: null,
                dominantRange: null,
                histogram: new Array(HUE_BIN_COUNT).fill(0).map(function () { return 0; }),
                note: '全图无彩度（chroma<=8）像素，色相无定义'
            };
        }

        // 空间统计：Sobel 边缘 + Laplacian 清晰度/噪声（需要 luma 数组，内部像素才参与）
        var edgeCount = 0, edgeSum = 0, internalPixels = 0;
        var lapSum = 0, lapSqSum = 0, noiseSum = 0, noiseSqSum = 0;
        var flatPixels = 0, sumGradSq = 0;
        var spatialSupported = (w >= 3 && h >= 3);
        if (spatialSupported) {
            for (var y = 1; y < h - 1; y++) {
                var row = y * w;
                for (var x = 1; x < w - 1; x++) {
                    var c = luma[row + x];
                    var l0 = luma[row - w + x - 1], l1 = luma[row - w + x], l2 = luma[row - w + x + 1];
                    var l3 = luma[row + x - 1], l5 = luma[row + x + 1];
                    var l6 = luma[row + w + x - 1], l7 = luma[row + w + x], l8 = luma[row + w + x + 1];
                    var gx = (l2 + 2 * l5 + l8) - (l0 + 2 * l3 + l6);
                    var gy = (l6 + 2 * l7 + l8) - (l0 + 2 * l1 + l2);
                    var mag = (Math.abs(gx) + Math.abs(gy)) / 4;   // 归一到 0–255 量级
                    internalPixels++;
                    edgeSum += mag;
                    if (mag >= 48) edgeCount++;
                    if (mag < 8) flatPixels++;
                    sumGradSq += gx * gx + gy * gy;
                    var lap = 4 * c - l3 - l5 - l1 - l7;
                    lapSum += lap; lapSqSum += lap * lap;
                    var resid = c - (l1 + l3 + l5 + l7) / 4;
                    noiseSum += resid; noiseSqSum += resid * resid;
                }
            }
        }
        var lapVar = 0, noiseStd = 0, edgeDensity = 0, edgeStrength = 0;
        var flatAreaRatio = 0, gradientEnergy = 0;
        if (internalPixels > 0) {
            var lapMean = lapSum / internalPixels;
            lapVar = Math.max(0, lapSqSum / internalPixels - lapMean * lapMean);
            var noiseMean = noiseSum / internalPixels;
            noiseStd = Math.sqrt(Math.max(0, noiseSqSum / internalPixels - noiseMean * noiseMean));
            edgeDensity = edgeCount / internalPixels;
            edgeStrength = edgeSum / internalPixels;
            flatAreaRatio = flatPixels / internalPixels;
            // Tenengrad 型梯度能量：mean(gx²+gy²) 按 Sobel 最大幅值归一（0–1）
            gradientEnergy = sumGradSq / internalPixels / (2 * 1020 * 1020);
        }

        // 亮度网格
        function gridCells(sums, counts) {
            var out = [];
            for (var k = 0; k < sums.length; k++) {
                out.push(counts[k] > 0 ? _round(sums[k] / counts[k], 2) : 0);
            }
            return out;
        }
        var grid3 = gridCells(cell3, cell3Count);
        var grid4 = gridCells(cell4, cell4Count);
        var gridStd3 = 0;
        if (grid3.length) {
            var g3m = 0;
            for (i = 0; i < grid3.length; i++) g3m += grid3[i];
            g3m /= grid3.length;
            var g3v = 0;
            for (i = 0; i < grid3.length; i++) g3v += (grid3[i] - g3m) * (grid3[i] - g3m);
            gridStd3 = Math.sqrt(g3v / grid3.length);
        }
        // 中心/边角（构图与暗角）：边角比中心暗 ⇒ vignetteDelta > 0
        var centerLumaMean = centerCount > 0 ? centerSumL / centerCount : 0;
        var borderLumaMean = borderCount > 0 ? borderSumL / borderCount : 0;

        // 色相熵 / 冷暖占比 / 主色覆盖（前三大主色合计占比）
        var hueEntropy = 0;
        if (chromaPixels > 0) {
            for (i = 0; i < HUE_BIN_COUNT; i++) {
                if (hueBin[i] > 0) {
                    var hp = hueBin[i] / chromaPixels;
                    hueEntropy -= hp * Math.log(hp) / Math.LN2;
                }
            }
        }
        if (hue && chromaPixels > 0) hue.entropyBits = _round(hueEntropy, 3);
        else if (hue) hue.entropyBits = null;
        var dominantCoverage = 0;
        for (i = 0; i < dominantColors.length && i < 3; i++) dominantCoverage += dominantColors[i].ratio;
        var warmRatio = chromaPixels > 0 ? _round(warmPixels / chromaPixels, 4) : null;
        var coolRatio = chromaPixels > 0 ? _round(coolPixels / chromaPixels, 4) : null;
        var warmCoolRatio = (warmPixels > 0 && coolPixels > 0) ? _round(warmPixels / coolPixels, 3) : null;

        // ── 感知哈希（8×8 网格，与参考图对比共用 hashesFromLuma）──
        var hashes = hashesFromLuma(luma, w, h);

        // 区域统计（坐标按源图像素；采样后按比例换算到采样坐标，再钳制到画面内）
        var regionResults = [];
        if (regions.length) {
            var invScaleX = w / sourceWidth;
            var invScaleY = h / sourceHeight;
            for (var ri = 0; ri < regions.length; ri++) {
                var reg = regions[ri];
                var rx = Math.max(0, Math.floor(reg.x * invScaleX));
                var ry = Math.max(0, Math.floor(reg.y * invScaleY));
                var rw = Math.min(w - rx, Math.max(0, Math.round(reg.width * invScaleX)));
                var rh = Math.min(h - ry, Math.max(0, Math.round(reg.height * invScaleY)));
                if (rw <= 0 || rh <= 0) {
                    regionResults.push({
                        name: reg.name, x: reg.x, y: reg.y, width: reg.width, height: reg.height,
                        pixels: 0, note: '区域超出画面（按源图像素计），未统计'
                    });
                    continue;
                }
                var rr = 0, gg = 0, bb = 0, ll = 0, ll2 = 0, ss = 0;
                var cntR = 0, overR = 0, underR = 0;
                for (var yy = ry; yy < ry + rh; yy++) {
                    for (var xx = rx; xx < rx + rw; xx++) {
                        var pi = (yy * w + xx) * 4;
                        var pr = data[pi] || 0, pg = data[pi + 1] || 0, pb = data[pi + 2] || 0;
                        var pl = lumaOf(pr, pg, pb);
                        rr += pr; gg += pg; bb += pb;
                        ll += pl; ll2 += pl * pl;
                        if (pl >= 250) overR++;
                        if (pl <= 5) underR++;
                        var pm = pr > pg ? (pr > pb ? pr : pb) : (pg > pb ? pg : pb);
                        var pmn = pr < pg ? (pr < pb ? pr : pb) : (pg < pb ? pg : pb);
                        ss += (pm === 0) ? 0 : ((pm - pmn) / pm);
                        cntR++;
                    }
                }
                var meanLR = ll / cntR;
                regionResults.push({
                    name: reg.name, x: reg.x, y: reg.y, width: reg.width, height: reg.height,
                    pixels: cntR,
                    lumaMean: _round(meanLR, 2),
                    lumaStd: _round(Math.sqrt(Math.max(0, ll2 / cntR - meanLR * meanLR)), 2),
                    overexposedRatio: _round(overR / cntR, 4),
                    underexposedRatio: _round(underR / cntR, 4),
                    rgbMean: [_round(rr / cntR, 1), _round(gg / cntR, 1), _round(bb / cntR, 1)],
                    saturationMean: _round(ss / cntR, 4)
                });
            }
        }

        var scale = w / sourceWidth;
        return {
            meta: {
                sourceWidth: sourceWidth,
                sourceHeight: sourceHeight,
                analysisWidth: w,
                analysisHeight: h,
                scale: _round(scale, 4),
                sourcePixels: sourceWidth * sourceHeight,
                analysisPixels: n,
                lumaFormula: LUMA_FORMULA,
                downscaled: (w !== sourceWidth || h !== sourceHeight)
            },
            luminance: {
                mean: _round(meanL, 2),
                median: pcts.p50,
                std: _round(stdL, 2),
                min: _round(minL, 2),
                max: _round(maxL, 2),
                range: _round(maxL - minL, 2),
                percentiles: pcts,
                dynamicRange: dynamicRange,
                contrastRange: contrast,
                overexposedRatio: _round(overCount / n, 4),
                underexposedRatio: _round(underCount / n, 4),
                midtoneRatio: _round(midCount / n, 4),
                shadowRatio: _round(shadowCount / n, 4),
                highlightRatio: _round(highlightCount / n, 4),
                clippedWhiteRatio: _round(clippedWhite / n, 4),
                clippedBlackRatio: _round(clippedBlack / n, 4),
                // 分布形状与曝光参考：偏度 (0=对称，正=偏亮)、峰度 (0=正态，负=平台分布)
                skewness: _round(skewness, 3),
                kurtosis: _round(kurtosis, 3),
                iqr: _round(iqr, 2),
                spread10_90: _round(spread10_90, 2),
                exposureEv: _round(exposureEv, 2),
                histogramPeaks: histogramPeaks,
                whitePoint: whitePoint,
                blackPoint: blackPoint,
                entropyBits: _round(entropy, 3),
                histogram: Array.prototype.slice.call(histL)
            },
            rgb: {
                r: channelStats(histR, sumR, sumR2, minR, maxR),
                g: channelStats(histG, sumG, sumG2, minG, maxG),
                b: channelStats(histB, sumB, sumB2, minB, maxB)
            },
            hsv: {
                saturation: {
                    mean: _round(meanSat, 4),
                    std: _round(stdSat, 4),
                    median: _round(satMedian, 4),
                    p5: _round(satP5, 4),
                    p95: _round(satP95, 4),
                    highRatio: _round(highSat / n, 4),
                    lowRatio: _round(lowSat / n, 4)
                },
                value: {
                    mean: _round(sumV / n, 2),
                    std: _round(Math.sqrt(Math.max(0, sumV2 / n - (sumV / n) * (sumV / n))), 2),
                    min: minV,
                    max: maxV
                },
                hue: hue
            },
            color: {
                dominantColors: dominantColors,
                dominantCoverage: _round(dominantCoverage, 4),
                warmRatio: warmRatio,
                coolRatio: coolRatio,
                warmCoolRatio: warmCoolRatio,
                hueEntropyBits: chromaPixels > 0 ? _round(hueEntropy, 3) : null,
                quantizedColorBins: binList.length,
                quantizedColorSpaceSize: 32768,
                uniqueColorCount: exactColors ? exactColors.size : null,
                uniqueColorNote: exactColors ? '' : '采样像素超过 ' + EXACT_UNIQUE_LIMIT + '，跳过精确去重（quantizedColorBins 仍给出 5 bit/通道量化桶数）',
                grayscaleRatio: _round(grayPixels / n, 4),
                averageHex: _hex2(sumR / n, sumG / n, sumB / n),
                colorfulness: _round(colorfulness, 2)
            },
            alpha: {
                present: (minA < 255 || maxA < 255),
                mean: _round(sumA / n, 2),
                min: minA,
                max: maxA,
                transparentRatio: _round(transparentPixels / n, 4),
                fullyTransparentRatio: _round(fullyTransparentPixels / n, 4),
                opaqueRatio: _round((n - transparentPixels) / n, 4),
                // 仅不透明像素的亮度统计：透明底（RGB=0）不参与，避免全图均值被拉暗
                opaqueLumaMean: opaqueCount > 0 ? _round(opaqueSumL / opaqueCount, 2) : null,
                opaqueLumaStd: opaqueCount > 0
                    ? _round(Math.sqrt(Math.max(0, opaqueSumL2 / opaqueCount - (opaqueSumL / opaqueCount) * (opaqueSumL / opaqueCount))), 2)
                    : null,
                opaqueOverexposedRatio: opaqueCount > 0 ? _round(opaqueOver / opaqueCount, 4) : null,
                opaqueUnderexposedRatio: opaqueCount > 0 ? _round(opaqueUnder / opaqueCount, 4) : null
            },
            spatial: {
                luminanceGrid3: grid3,
                luminanceGrid4: grid4,
                gridContrast3: _round(Math.max.apply(null, grid3) - Math.min.apply(null, grid3), 2),
                gridContrast4: _round(Math.max.apply(null, grid4) - Math.min.apply(null, grid4), 2),
                gridStd3: _round(gridStd3, 2),
                centerLumaMean: _round(centerLumaMean, 2),
                borderLumaMean: _round(borderLumaMean, 2),
                vignetteDelta: _round(borderLumaMean - centerLumaMean, 2),
                edgeDensity: _round(edgeDensity, 4),
                edgeStrengthMean: _round(edgeStrength, 2),
                gradientEnergy: _round(gradientEnergy, 4),
                flatAreaRatio: _round(flatAreaRatio, 4),
                laplacianVariance: _round(lapVar, 1),
                sharpness: _round(Math.sqrt(lapVar) / 1020, 4),
                highFreqRatio: stdL > 1e-9 ? _round((Math.sqrt(lapVar) / 1020) / (stdL / 255), 3) : 0,
                noiseEstimate: _round(noiseStd, 2),
                spatialSupported: spatialSupported
            },
            hashes: hashes,
            regions: regionResults
        };
    }

    // ── 参考图对比 ──
    // 两张图必须在同一采样网格（调用方保证：参考图按候选图的采样尺寸重采样）。
    // 指标：MAE/RMSE/PSNR/全局 SSIM/变化像素占比/逐通道 MAE/亮度差/直方图 Bhattacharyya
    // 相似度/感知哈希汉明距离/分档判定。
    function comparePixels(candRgba, refRgba, width, height) {
        var w = Math.max(1, Math.floor(Number(width) || 0));
        var h = Math.max(1, Math.floor(Number(height) || 0));
        var n = w * h;
        var a = candRgba || [], b = refRgba || [];
        var CHANGE_THRESHOLD = 8;
        var histC = new Float64Array(256), histR = new Float64Array(256);
        var lumaC = new Uint8Array(n), lumaR = new Uint8Array(n);
        var absSum = 0, sqSum = 0, maxAbs = 0, maxPixelSum = 0, changed = 0;
        var chAbs = [0, 0, 0, 0];
        var lumaAbs = 0, lumaSigned = 0, lumaChanged = 0;
        var sumC = 0, sumR = 0, sumC2 = 0, sumR2 = 0, sumCR = 0;
        for (var i = 0; i < n; i++) {
            var p = i * 4;
            var cr = a[p] || 0, cg = a[p + 1] || 0, cb = a[p + 2] || 0;
            var ca = (a[p + 3] === undefined) ? 255 : a[p + 3];
            var rr = b[p] || 0, rg = b[p + 1] || 0, rb = b[p + 2] || 0;
            var ra = (b[p + 3] === undefined) ? 255 : b[p + 3];
            var d0 = Math.abs(cr - rr), d1 = Math.abs(cg - rg), d2 = Math.abs(cb - rb), d3 = Math.abs(ca - ra);
            chAbs[0] += d0; chAbs[1] += d1; chAbs[2] += d2; chAbs[3] += d3;
            var dsum = d0 + d1 + d2 + d3;
            absSum += dsum;
            sqSum += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
            // maxAbsDiff 取单通道最大差（0–255，更直观）；maxPixelDiff 取四通道差之和（0–1020）
            var dmax = d0;
            if (d1 > dmax) dmax = d1;
            if (d2 > dmax) dmax = d2;
            if (d3 > dmax) dmax = d3;
            if (dmax > maxAbs) maxAbs = dmax;
            if (dsum > maxPixelSum) maxPixelSum = dsum;
            if (d0 > CHANGE_THRESHOLD || d1 > CHANGE_THRESHOLD || d2 > CHANGE_THRESHOLD || d3 > CHANGE_THRESHOLD) changed++;
            var lc = Math.round(lumaOf(cr, cg, cb));
            var lr = Math.round(lumaOf(rr, rg, rb));
            if (lc < 0) lc = 0; if (lc > 255) lc = 255;
            if (lr < 0) lr = 0; if (lr > 255) lr = 255;
            lumaC[i] = lc; lumaR[i] = lr;
            histC[lc]++; histR[lr]++;
            var dl = lc - lr;
            lumaAbs += Math.abs(dl); lumaSigned += dl;
            if (Math.abs(dl) > CHANGE_THRESHOLD) lumaChanged++;
            sumC += lc; sumR += lr; sumC2 += lc * lc; sumR2 += lr * lr; sumCR += lc * lr;
        }
        var mae = absSum / (n * 4);
        var mse = sqSum / (n * 4);
        var rmse = Math.sqrt(mse);
        var psnrDb = (mse <= 1e-12) ? null : _round(10 * Math.log(255 * 255 / mse) / Math.LN10, 2);
        // 全局 SSIM（单窗口）：C1=(0.01·L)²、C2=(0.03·L)²，L=255
        var muC = sumC / n, muR = sumR / n;
        var varC = Math.max(0, sumC2 / n - muC * muC);
        var varR = Math.max(0, sumR2 / n - muR * muR);
        var cov = sumCR / n - muC * muR;
        var ssim = ((2 * muC * muR + 6.5025) * (2 * cov + 58.5225))
            / ((muC * muC + muR * muR + 6.5025) * (varC + varR + 58.5225));
        if (!isFinite(ssim)) ssim = 0;
        ssim = _clamp(ssim, -1, 1);
        // 直方图相似度：Bhattacharyya 系数（0=分布完全不同，1=一致）
        var bh = 0;
        for (var q = 0; q < 256; q++) {
            if (histC[q] > 0 && histR[q] > 0) bh += Math.sqrt((histC[q] / n) * (histR[q] / n));
        }
        var hashesC = hashesFromLuma(lumaC, w, h);
        var hashesR = hashesFromLuma(lumaR, w, h);
        var aDist = hashDistance(hashesC.aHash, hashesR.aHash);
        var dDist = hashDistance(hashesC.dHash, hashesR.dHash);
        var vDist = hashDistance(hashesC.vHash, hashesR.vHash);
        var identical = (absSum === 0);
        var changedRatio = changed / n;
        var verdict;
        if (identical) verdict = 'identical';
        else if (ssim >= 0.995 && changedRatio <= 0.005) verdict = 'near-identical';
        else if (ssim >= 0.95) verdict = 'minor-difference';
        else if (ssim >= 0.8) verdict = 'noticeable-difference';
        else verdict = 'large-difference';
        return {
            analysisWidth: w, analysisHeight: h, pixels: n,
            mae: _round(mae, 3), rmse: _round(rmse, 3), psnrDb: psnrDb,
            ssim: _round(ssim, 4), identical: identical,
            changedPixelRatio: _round(changedRatio, 4), maxAbsDiff: maxAbs, maxPixelDiff: maxPixelSum,
            channelMae: {
                r: _round(chAbs[0] / n, 3), g: _round(chAbs[1] / n, 3),
                b: _round(chAbs[2] / n, 3), alpha: _round(chAbs[3] / n, 3)
            },
            luma: {
                meanSignedDiff: _round(lumaSigned / n, 2),
                meanAbsDiff: _round(lumaAbs / n, 2),
                changedRatio: _round(lumaChanged / n, 4)
            },
            histogramSimilarity: _round(bh, 4),
            hash: {
                aHashDistance: aDist, dHashDistance: dDist, vHashDistance: vDist,
                // aHash 只编码「相对结构」（纯黑/纯白图都得到全 1），故同帧判定再叠加
                // 平均亮度差约束：结构一致但整体亮度变了（黑图 vs 白图）不算同帧。
                sameFrameByHash: (aDist <= 2 && Math.abs(lumaSigned / n) <= 4),
                aHash: hashesC.aHash, referenceAHash: hashesR.aHash
            },
            verdict: verdict,
            note: '对比在面板侧同一采样网格进行（参考图按候选图的采样尺寸重采样，8-bit RGBA）：'
                + 'changedPixelRatio=逐像素任一通道差 > ' + CHANGE_THRESHOLD + ' 的比例；'
                + 'SSIM 为全局单窗口值；PSNR 在完全一致时为 null；'
                + 'sameFrameByHash=aHash 汉明距离 ≤2 且平均亮度差 ≤4'
        };
    }

    // ── canvas 解码（浏览器依赖，测试注入 createImage/createCanvas）──

    function decodeToPixels(dataUrl, opts) {
        opts = opts || {};
        var mkImage = opts.createImage || function () { return new Image(); };
        var mkCanvas = opts.createCanvas || function (cw, ch) {
            var c = document.createElement('canvas');
            c.width = cw;
            c.height = ch;
            return c;
        };
        var maxEdge = normalizeOptions({ maxEdge: opts.maxEdge }).maxEdge;
        return new Promise(function (resolve, reject) {
            var im = mkImage();
            im.onload = function () {
                try {
                    var sw = Math.max(1, im.naturalWidth || im.width || 0);
                    var sh = Math.max(1, im.naturalHeight || im.height || 0);
                    // forceSize：参考图按候选图的采样网格重采样（对比要求同一 W×H，
                    // 不能各自按自己的长边算采样尺寸）。
                    var fs = opts.forceSize || null;
                    var sample = (fs && fs.width > 0 && fs.height > 0)
                        ? { width: Math.floor(fs.width), height: Math.floor(fs.height) }
                        : computeSampleSize(sw, sh, maxEdge);
                    var canvas = mkCanvas(sample.width, sample.height);
                    var ctx = canvas.getContext('2d');
                    if (!ctx || typeof ctx.drawImage !== 'function' || typeof ctx.getImageData !== 'function') {
                        reject(new Error('canvas 2d 上下文不可用，无法解码图片'));
                        return;
                    }
                    ctx.drawImage(im, 0, 0, sample.width, sample.height);
                    var imgData = ctx.getImageData(0, 0, sample.width, sample.height);
                    resolve({
                        data: imgData && imgData.data ? imgData.data : [],
                        width: sample.width,
                        height: sample.height,
                        sourceWidth: sw,
                        sourceHeight: sh
                    });
                } catch (e) {
                    reject(e instanceof Error ? e : new Error(String(e)));
                }
            };
            im.onerror = function () { reject(new Error('图片加载/解码失败（data URL 前缀 ' + String(dataUrl).slice(0, 24) + '…）')); };
            im.src = dataUrl;
        });
    }

    // ── 工具结果后处理入口 ──
    // payload：AE 侧 analyzeImage 的 JSON 回执（成功结果）；args：工具入参；
    // deps 可选（测试注入）：{aefs, createImage, createCanvas}。
    // 语义：读图/解码/统计失败不把工具改判失败（抓帧可能已成功、文件也真实存在），
    // 在回执里追加 analysisError 让模型知道指标缺失；attachImage 原样保留供 vision hook 判据。

    function _copy(payload) {
        var out = {};
        for (var k in payload) {
            if (Object.prototype.hasOwnProperty.call(payload, k)) out[k] = payload[k];
        }
        return out;
    }

    function _withAnalysisError(payload, msg) {
        var out = _copy(payload);
        out.analysisError = String(msg || '图片分析失败');
        return out;
    }

    // 单文件分析：读 → 解码 → 统计。返回 Promise<{metrics, decoded}>；失败 reject。
    function analyzeImageFile(filePath, opts, deps) {
        var aefs = deps.aefs || global.AEFS;
        if (!aefs || typeof aefs.readImageBase64 !== 'function') {
            return Promise.reject(new Error('AEFS 图片读取通道不可用'));
        }
        return Promise.resolve().then(function () {
            return aefs.readImageBase64(filePath);
        }).then(function (read) {
            if (!read || read.success !== true || !read.base64) {
                var reason = (read && (read.error || read.message)) ? String(read.error || read.message) : '未知原因';
                throw new Error('图片读取失败 (' + filePath + ')：' + reason);
            }
            var mime = read.mime || 'image/png';
            return decodeToPixels('data:' + mime + ';base64,' + read.base64, {
                maxEdge: opts.maxEdge,
                createImage: deps.createImage,
                createCanvas: deps.createCanvas
            });
        }).then(function (decoded) {
            var metrics = analyzePixels(decoded.data, decoded.width, decoded.height, {
                sourceWidth: decoded.sourceWidth,
                sourceHeight: decoded.sourceHeight,
                topColors: opts.topColors,
                regions: opts.regions
            });
            return { metrics: metrics, decoded: decoded };
        });
    }

    // 文件大小派生指标（仅当回执带 fileSize 时）：bytesPerPixel 反映压缩率（PNG 越小通常噪声/细节越少）
    function _attachFileSize(metrics, fileSize) {
        var size = Number(fileSize);
        if (!isFinite(size) || size <= 0) return;
        metrics.meta.fileBytes = size;
        metrics.meta.bytesPerPixel = _round(size / Math.max(1, metrics.meta.sourcePixels), 3);
    }

    function _analysisNote(metrics, opts) {
        var note = '指标基于面板侧 canvas 解码的采样图（8-bit RGB' + (metrics.alpha.present ? 'A' : '')
            + '）：亮度=Rec.709 加权，直方图分桶 0–255，网格为行优先 3×3/4×4 亮度均值，区域坐标为源图像素；'
            + 'hashes 为 8×8 亮度自适应/差分感知哈希，可用于同帧比对。';
        if (metrics.meta.downscaled) note += '采样图已按最长边 ' + opts.maxEdge + ' 缩放。';
        return note;
    }

    // ── 参考图对比（单帧与多帧共用）──
    // 参考图按**候选图的采样尺寸**重采样，保证对比在同一个 W×H 网格上（两张图各自按
    // 自己长边算采样尺寸会得到不同网格，逐像素差就没有意义）。
    function _loadReferenceFor(decoded, opts, deps) {
        var aefs = deps.aefs || global.AEFS;
        return Promise.resolve().then(function () {
            return aefs.readImageBase64(opts.comparePath);
        }).then(function (read) {
            if (!read || read.success !== true || !read.base64) {
                var reason = (read && (read.error || read.message)) ? String(read.error || read.message) : '未知原因';
                throw new Error('参考图读取失败 (' + opts.comparePath + ')：' + reason);
            }
            return decodeToPixels('data:' + (read.mime || 'image/png') + ';base64,' + read.base64, {
                maxEdge: opts.maxEdge,
                forceSize: { width: decoded.width, height: decoded.height },
                createImage: deps.createImage,
                createCanvas: deps.createCanvas
            });
        });
    }

    // 参考图只解码一次（多帧模式各帧共用）：state = { ref, pending, error }
    function _ensureReference(decoded, opts, deps, state) {
        if (state.ref) return Promise.resolve(state.ref);
        if (state.pending) return state.pending;
        state.pending = _loadReferenceFor(decoded, opts, deps).then(function (ref) {
            state.ref = ref;
            return ref;
        }, function (e) {
            state.error = String((e && e.message) || e);
            throw e;
        });
        return state.pending;
    }

    // 单帧对比；参考图不可用时不改判工具失败，只回 compare.error
    function _compareWithReference(decoded, opts, deps, state) {
        var st = state || {};
        return _ensureReference(decoded, opts, deps, st).then(function (ref) {
            if (ref.width !== decoded.width || ref.height !== decoded.height) {
                return { error: '参考图与候选图的采样网格不一致（' + ref.width + '×' + ref.height + ' vs ' + decoded.width + '×' + decoded.height + '）' };
            }
            var cmp = comparePixels(decoded.data, ref.data, decoded.width, decoded.height);
            cmp.referencePath = opts.comparePath;
            cmp.referenceSourceWidth = ref.sourceWidth;
            cmp.referenceSourceHeight = ref.sourceHeight;
            return cmp;
        }, function (e) {
            return { error: String((e && e.message) || e), referencePath: opts.comparePath };
        });
    }

    // 多帧结果主动裁剪：6 帧 ×（8 区域 + 16 主色 + compare）会超过单条 32K 工具结果上限，
    // 被管线截断后 JSON 不完整（vision hook 解析失败 → 图片不注入）。按层裁剪到 30K 以内，
    // 保留「每帧有哪些指标」的形状，只压缩重复说明与低价值长字段；trimmed/trimNote 如实告知。
    function _jsonLen(obj) {
        try { return JSON.stringify(obj).length; } catch (_) { return 0; }
    }

    function _trimMultiResult(out) {
        if (_jsonLen(out) <= MULTI_RESULT_MAX_CHARS) return out;
        var frames = (out.analysis && Array.isArray(out.analysis.frames)) ? out.analysis.frames : [];
        var i, a;
        out.analysis.trimmed = true;
        out.analysis.trimNote = '多帧结果超过单条工具结果上限，已逐级裁剪（区域/主色/网格/后段帧指标）；'
            + '需要完整指标时减少时间点数，或对单帧单独分析。';
        // 层 1：删逐帧重复说明（指标口径说明在顶层 analysisNote 已给）
        for (i = 0; i < frames.length; i++) {
            a = frames[i] && frames[i].analysis;
            if (!a) continue;
            if (a.hashes) delete a.hashes.note;
            if (a.color) delete a.color.uniqueColorNote;
        }
        if (_jsonLen(out) <= MULTI_RESULT_MAX_CHARS) return out;
        // 层 2：逐帧区域裁到 3 个、主色裁到 4 个
        for (i = 0; i < frames.length; i++) {
            a = frames[i] && frames[i].analysis;
            if (!a) continue;
            if (Array.isArray(a.regions) && a.regions.length > 3) a.regions = a.regions.slice(0, 3);
            if (a.color && Array.isArray(a.color.dominantColors) && a.color.dominantColors.length > 4) {
                a.color.dominantColors = a.color.dominantColors.slice(0, 4);
            }
        }
        if (_jsonLen(out) <= MULTI_RESULT_MAX_CHARS) return out;
        // 层 3：删逐帧 4×4 网格（3×3 与网格统计保留）
        for (i = 0; i < frames.length; i++) {
            a = frames[i] && frames[i].analysis;
            if (a && a.spatial) delete a.spatial.luminanceGrid4;
        }
        if (_jsonLen(out) <= MULTI_RESULT_MAX_CHARS) return out;
        // 层 4（兜底）：只完整保留前 3 帧指标，其余帧保留亮度和 + compare
        for (i = 3; i < frames.length; i++) {
            a = frames[i] && frames[i].analysis;
            if (!a) continue;
            frames[i].analysis = {
                trimmed: true,
                luminance: {
                    mean: a.luminance ? a.luminance.mean : null,
                    std: a.luminance ? a.luminance.std : null
                }
            };
        }
        if (_jsonLen(out) <= MULTI_RESULT_MAX_CHARS) return out;
        // 层 5：删重复的原始 frames/times（逐帧信息 analysis.frames[] 已有 filePath/time）
        delete out.frames;
        delete out.times;
        if (_jsonLen(out) <= MULTI_RESULT_MAX_CHARS) return out;
        // 层 6（最后兜底）：只保留第一帧条目 + 帧间统计
        if (frames.length > 1) out.analysis.frames = frames.slice(0, 1);
        return out;
    }

    // 多时间点模式：每帧**只读一次** base64——既用于逐帧分析，也用于合成带时间标签的联系表
    // （复用 previewSheet 的 composeSheet / buildSheetResult 导出纯函数；不走它的 postProcess，
    // 因为那会把每帧 PNG 再读一遍，6 帧时额外多 2–3s I/O）。
    // 顶层 filePath 指向联系表，视觉上下文注入一张能看全时间段的图。
    // 单帧采样最长边在多帧模式下收紧到 512（默认 1024）：逐帧分析耗时随帧数线性增长。
    function _postProcessMulti(payload, opts, deps) {
        var aefs = deps.aefs || global.AEFS;
        if (!aefs || typeof aefs.readImageBase64 !== 'function') {
            return Promise.resolve(_withAnalysisError(payload, 'AEFS 图片读取通道不可用，未生成指标'));
        }
        var sheet = deps.previewSheet || global.AEPreviewSheet;
        var frames = Array.isArray(payload.frames) ? payload.frames : [];
        var frameOpts = {
            maxEdge: Math.min(opts.maxEdge, 512),
            topColors: opts.topColors,
            regions: opts.regions
        };
        var reads = [];
        var dataUrls = [];
        var refState = {};   // 参考图（给了 comparePath 时）：各帧共用一次解码
        var chain = Promise.resolve();
        for (var fi = 0; fi < frames.length; fi++) {
            (function (idx, f) {
                chain = chain.then(function () {
                    if (!f || !f.filePath) {
                        reads[idx] = { ok: false, error: '该帧没有 filePath' };
                        return;
                    }
                    return Promise.resolve(aefs.readImageBase64(f.filePath)).then(function (rd) {
                        if (!rd || rd.success !== true || !rd.base64) {
                            reads[idx] = { ok: false, error: '图片读取失败' + ((rd && (rd.error || rd.message)) ? '：' + String(rd.error || rd.message) : '') };
                            return;
                        }
                        var url = 'data:' + (rd.mime || 'image/png') + ';base64,' + rd.base64;
                        dataUrls[idx] = url;
                        return decodeToPixels(url, {
                            maxEdge: frameOpts.maxEdge,
                            createImage: deps.createImage,
                            createCanvas: deps.createCanvas
                        }).then(function (decoded) {
                            var metrics = analyzePixels(decoded.data, decoded.width, decoded.height, {
                                sourceWidth: decoded.sourceWidth,
                                sourceHeight: decoded.sourceHeight,
                                topColors: frameOpts.topColors,
                                regions: frameOpts.regions
                            });
                            _attachFileSize(metrics, f.fileSize);
                            // 多帧结果受单条 32K 工具结果上限约束（6 帧 ≈ 28K）：逐帧省略
                            // 256 桶直方图（分位数/峰值/熵/偏度仍保留），总量降到 ~20K，
                            // 避免截断把 JSON 切坏（视觉注入按 filePath 解析结果）。需要直方图
                            // 时对单帧单独分析。
                            delete metrics.luminance.histogram;
                            metrics.luminance.histogramOmitted = true;
                            var rec = { ok: true, analysis: metrics };
                            reads[idx] = rec;
                            if (!opts.comparePath) return;
                            return _ensureReference(decoded, opts, deps, refState).then(function (ref) {
                                if (ref.width !== decoded.width || ref.height !== decoded.height) {
                                    rec.compare = { error: '参考图与帧采样网格不一致' };
                                    return;
                                }
                                var cmp = comparePixels(decoded.data, ref.data, decoded.width, decoded.height);
                                // 逐帧 compare 去重说明与参考信息（顶层 analysis.reference 统一给），
                                // 6 帧时省 ~2K 字符，避免逼近 32K 工具结果上限。
                                delete cmp.note;
                                delete cmp.referencePath;
                                rec.compare = cmp;
                            }, function (e) {
                                rec.compare = { error: String((e && e.message) || e) };
                            });
                        }, function (e) {
                            reads[idx] = { ok: false, error: String((e && e.message) || e) };
                        });
                    }, function (e) {
                        reads[idx] = { ok: false, error: String((e && e.message) || e) };
                    });
                });
            })(fi, frames[fi]);
        }
        return chain.then(function () {
            var perFrame = [];
            var analyzed = 0;
            for (var k = 0; k < frames.length; k++) {
                var rd = reads[k] || { ok: false, error: '未读取' };
                if (rd.ok) analyzed++;
                perFrame.push({
                    index: k,
                    time: frames[k] ? frames[k].time : null,
                    filePath: frames[k] ? frames[k].filePath : null,
                    ok: rd.ok,
                    analysis: rd.analysis || undefined,
                    compare: rd.compare || undefined,
                    error: rd.error || undefined
                });
            }
            var out = _copy(payload);
            out.analysis = {
                multiFrame: true,
                frameCount: frames.length,
                analyzedCount: analyzed,
                frames: perFrame,
                temporal: _buildTemporalSummary(perFrame)
            };
            if (opts.comparePath) {
                out.analysis.reference = {
                    path: opts.comparePath,
                    sourceWidth: refState.ref ? refState.ref.sourceWidth : null,
                    sourceHeight: refState.ref ? refState.ref.sourceHeight : null,
                    error: refState.error || (analyzed === 0 ? '没有可分析帧，未读取参考图' : null)
                };
            }
            var canSheet = !!(sheet && typeof sheet.composeSheet === 'function'
                && typeof sheet.buildSheetResult === 'function' && frames.length >= 2);
            if (!canSheet || analyzed !== frames.length) {
                out.contactSheet = false;
                out.sheetError = canSheet ? '部分帧读取失败，无法合成联系表'
                    : '联系表模块不可用（AEPreviewSheet.composeSheet 未加载）';
                out.filePath = frames[0] ? frames[0].filePath : payload.filePath;
                out.analysisNote = '多时间点模式：每帧各自分析（analysis.frames[].analysis），单帧采样最长边 '
                    + frameOpts.maxEdge + '；'
                    + (opts.comparePath ? '逐帧与参考图对比（analysis.frames[].compare / temporal.compare）；' : '')
                    + '联系表未合成（' + out.sheetError + '），顶层 filePath 为第一帧。';
                return _trimMultiResult(out);
            }
            var items = [];
            for (var s = 0; s < frames.length; s++) {
                var label = (typeof sheet.formatTimeLabel === 'function')
                    ? sheet.formatTimeLabel(frames[s].time) : String(frames[s].time);
                items.push({ url: dataUrls[s], label: label });
            }
            return Promise.resolve(sheet.composeSheet(items, {
                createImage: deps.createImage,
                createCanvas: deps.createCanvas
            })).then(function (composed) {
                var nowMs = (typeof deps.now === 'number') ? deps.now : (new Date()).getTime();
                var sheetName = 'ae_preview_' + nowMs + '.png';
                var p0 = String(frames[0].filePath || '');
                var dirIdx = Math.max(p0.lastIndexOf('/'), p0.lastIndexOf('\\'));
                // 沿用帧路径的分隔符（Windows 路径不要拼出 C:\dir/x.png 的混合形态）
                var sep = (p0.lastIndexOf('\\') > p0.lastIndexOf('/')) ? '\\' : '/';
                var sheetPath = (dirIdx > 0 ? p0.slice(0, dirIdx) : '') + sep + sheetName;
                return Promise.resolve(aefs.writeBlob(sheetPath, composed.blob)).then(function (ok) {
                    if (ok !== true) throw new Error('联系表写盘失败: ' + sheetPath);
                    var sheetInfo = {
                        sheetPath: sheetPath, sheetName: sheetName,
                        sheetSize: (composed.blob && composed.blob.size) || 0,
                        cols: composed.layout.cols, rows: composed.layout.rows,
                        cellW: composed.layout.cellW, cellH: composed.layout.cellH,
                        sheetW: composed.layout.sheetW, sheetH: composed.layout.sheetH,
                        frameW: composed.frameW, frameH: composed.frameH
                    };
                    var sheetOut = sheet.buildSheetResult(payload, sheetInfo);
                    for (var sk in sheetOut) {
                        if (Object.prototype.hasOwnProperty.call(sheetOut, sk)
                            && sk !== 'analysis' && sk !== 'analysisNote') out[sk] = sheetOut[sk];
                    }
                    out.analysisNote = '多时间点模式：每帧各自分析（analysis.frames[].analysis），单帧采样最长边 '
                        + frameOpts.maxEdge + '；逐帧省略 256 桶直方图（分位数/峰值/熵仍保留），需要直方图时对单帧单独分析；'
                        + (opts.comparePath ? '逐帧与参考图对比（analysis.frames[].compare / temporal.compare）；' : '')
                        + '顶层 filePath 为带时间标签的联系表（图像上下文注入该表）。';
                    return _trimMultiResult(out);
                });
            }).catch(function (e) {
                out.contactSheet = false;
                out.sheetError = String((e && e.message) || e);
                out.filePath = frames[0] ? frames[0].filePath : payload.filePath;
                out.analysisNote = '多时间点模式：每帧各自分析（analysis.frames[].analysis），单帧采样最长边 '
                    + frameOpts.maxEdge + '；'
                    + (opts.comparePath ? '逐帧与参考图对比（analysis.frames[].compare / temporal.compare）；' : '')
                    + '联系表合成失败（' + out.sheetError + '），顶层 filePath 为第一帧。';
                return _trimMultiResult(out);
            });
        });
    }

    // 帧间统计：亮度趋势、最长曝光风险、最差清晰度、同帧/变化帧计数（aHash）
    function _buildTemporalSummary(perFrame) {
        var okFrames = [];
        for (var i = 0; i < perFrame.length; i++) {
            if (perFrame[i].ok && perFrame[i].analysis) okFrames.push(perFrame[i].analysis);
        }
        if (!okFrames.length) return { note: '所有帧分析失败，无法给出帧间统计' };
        var lumaMeans = [], overs = [], unders = [], sharps = [], hashes = [];
        for (var k = 0; k < okFrames.length; k++) {
            var m = okFrames[k];
            lumaMeans.push(m.luminance.mean);
            overs.push(m.luminance.overexposedRatio);
            unders.push(m.luminance.underexposedRatio);
            sharps.push(m.spatial.sharpness);
            hashes.push(m.hashes.aHash);
        }
        var minL = Math.min.apply(null, lumaMeans), maxL = Math.max.apply(null, lumaMeans);
        var identical = 0;
        var distinct = {};
        for (var h = 0; h < hashes.length; h++) {
            distinct[hashes[h]] = 1;
            if (h > 0 && hashes[h] === hashes[h - 1]) identical++;
        }
        var summary = {
            lumaMean: {
                first: lumaMeans[0], last: lumaMeans[lumaMeans.length - 1],
                min: _round(minL, 2), max: _round(maxL, 2),
                delta: _round(lumaMeans[lumaMeans.length - 1] - lumaMeans[0], 2)
            },
            overexposedRatioMax: _round(Math.max.apply(null, overs), 4),
            underexposedRatioMax: _round(Math.max.apply(null, unders), 4),
            sharpnessMin: _round(Math.min.apply(null, sharps), 4),
            identicalAdjacentPairs: identical,
            distinctFrameCount: Object.keys(distinct).length,
            note: '帧间统计按 analysis.frames[] 顺序；同帧判定用 8×8 aHash（identicalAdjacentPairs / distinctFrameCount）'
        };
        // 帧间对比汇总（给了 comparePath 时）：「哪一帧最接近参考图」是最常问的判据
        var cmpFrames = [];
        for (var ci = 0; ci < perFrame.length; ci++) {
            var cf = perFrame[ci];
            if (cf && cf.ok && cf.compare && !cf.compare.error) cmpFrames.push({ index: ci, time: cf.time, cmp: cf.compare });
        }
        if (cmpFrames.length) {
            var psnrs = [], ssims = [], changes = [], bestIdx = 0, bestScore = -2;
            for (var pi = 0; pi < cmpFrames.length; pi++) {
                var c = cmpFrames[pi].cmp;
                if (typeof c.psnrDb === 'number') psnrs.push(c.psnrDb);
                ssims.push(c.ssim);
                changes.push(c.changedPixelRatio);
                var score = (typeof c.ssim === 'number') ? c.ssim : -1;
                if (score > bestScore) { bestScore = score; bestIdx = pi; }
            }
            summary.compare = {
                framesCompared: cmpFrames.length,
                ssimMin: _round(Math.min.apply(null, ssims), 4),
                ssimMean: _round(ssims.reduce(function (x, y) { return x + y; }, 0) / ssims.length, 4),
                psnrDbMin: psnrs.length ? _round(Math.min.apply(null, psnrs), 2) : null,
                psnrDbMean: psnrs.length ? _round(psnrs.reduce(function (x, y) { return x + y; }, 0) / psnrs.length, 2) : null,
                changedPixelRatioMax: _round(Math.max.apply(null, changes), 4),
                bestFrameIndex: cmpFrames[bestIdx].index,
                bestFrameTime: cmpFrames[bestIdx].time,
                identicalFrameCount: (function () {
                    var cnt = 0;
                    for (var xi = 0; xi < cmpFrames.length; xi++) if (cmpFrames[xi].cmp.identical) cnt++;
                    return cnt;
                })(),
                note: '与参考图逐帧对比的汇总；bestFrameIndex 取 SSIM 最高帧；psnrDb* 在全部帧与参考图完全一致时为 null'
            };
        }
        return summary;
    }

    function postProcessAnalyzeImage(payload, args, deps) {
        deps = deps || {};
        if (!payload || payload.status !== 'success') return Promise.resolve(payload);
        var opts = normalizeOptions(args || {});
        if (Array.isArray(payload.frames) && payload.frames.length >= 2) {
            return _postProcessMulti(payload, opts, deps);
        }
        var filePath = payload.filePath;
        if (!filePath) return Promise.resolve(_withAnalysisError(payload, '结果里没有 filePath，无法定位要分析的图片'));
        return analyzeImageFile(filePath, opts, deps).then(function (res) {
            _attachFileSize(res.metrics, payload.fileSize);
            var out = _copy(payload);
            out.analysis = res.metrics;
            out.analysisNote = _analysisNote(res.metrics, opts);
            if (!opts.comparePath) return out;
            return _compareWithReference(res.decoded, opts, deps).then(function (cmp) {
                out.compare = cmp;
                out.analysisNote += '对比参考图：' + opts.comparePath + '。';
                return out;
            });
        }).catch(function (e) {
            return _withAnalysisError(payload, String((e && e.message) || e));
        });
    }

    global.AEImageAnalysis = {
        DEFAULT_MAX_EDGE: DEFAULT_MAX_EDGE,
        MULTI_RESULT_MAX_CHARS: MULTI_RESULT_MAX_CHARS,
        LUMA_FORMULA: LUMA_FORMULA,
        lumaOf: lumaOf,
        computeSampleSize: computeSampleSize,
        percentileFromHistogram: percentileFromHistogram,
        normalizeOptions: normalizeOptions,
        hashesFromLuma: hashesFromLuma,
        hashDistance: hashDistance,
        analyzePixels: analyzePixels,
        comparePixels: comparePixels,
        analyzeImageFile: analyzeImageFile,
        decodeToPixels: decodeToPixels,
        postProcessAnalyzeImage: postProcessAnalyzeImage
    };

})(window);
