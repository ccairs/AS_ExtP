// ComfyUI 画布 多宫格 合成/拆分 纯逻辑 + canvas 编排。
// 纯函数（mapNodesToGrid/checkAspectMatch/computeComposeLayout/computeSplitMeta）无 DOM，可 vm 单测。
// canvas 编排（composeGridImages/splitGridImage）依赖浏览器的 Image/canvas，需真机验证。
(function (global) {
    global.AEComfyUI = global.AEComfyUI || {};

    // ── 纯函数 ──

    // 宫格图片数上限：当前调用方（canvasIndex._onComposeGrid）仅支持 4/9/16，
    // 64 为纯防御上限（防未来调用方传超大数组触发 O(n²) 冲突重排）。
    var MAX_GRID_IMAGES = 64;

    // 几何象限映射：按节点中心坐标把 imgs 映射到 cols×cols 格子，返回按格子顺序(左上→右下)的数组。
    // imgs: [{id, path, cx, cy}]；返回 [{id, path}]（长度=imgs.length，按 cellIndex 升序）。
    function mapNodesToGrid(imgs, cols) {
        if (imgs.length > MAX_GRID_IMAGES) {
            throw new Error('宫格图片数 ' + imgs.length + ' 超过上限 ' + MAX_GRID_IMAGES);
        }
        var n = imgs.length;
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (var i = 0; i < n; i++) {
            if (imgs[i].cx < minX) minX = imgs[i].cx;
            if (imgs[i].cx > maxX) maxX = imgs[i].cx;
            if (imgs[i].cy < minY) minY = imgs[i].cy;
            if (imgs[i].cy > maxY) maxY = imgs[i].cy;
        }
        var spanX = maxX - minX;
        var spanY = maxY - minY;
        var cells = []; // cellIndex -> imgs entry
        for (var j = 0; j < n; j++) {
            var col = spanX > 0 ? Math.max(0, Math.min(cols - 1, Math.floor((imgs[j].cx - minX) / spanX * cols))) : 0;
            var row = spanY > 0 ? Math.max(0, Math.min(cols - 1, Math.floor((imgs[j].cy - minY) / spanY * cols))) : 0;
            var idx = row * cols + col;
            cells.push({ idx: idx, entry: imgs[j], cx: imgs[j].cx, cy: imgs[j].cy });
        }
        // 冲突：同一格多占 → 按到该格中心距离就近重排；保证每格恰一个。
        var used = {};
        var result = new Array(n);
        for (var k = 0; k < n; k++) {
            var cell = Math.min(cells[k].idx, n - 1);
            while (used[cell]) {
                // 该格被占，找最近未占格
                var best = -1, bestDist = Infinity;
                for (var c = 0; c < n; c++) {
                    if (used[c]) continue;
                    var cr = Math.floor(c / cols), cc = c % cols;
                    var cx = minX + (spanX > 0 ? cc / cols * spanX : 0);
                    var cy = minY + (spanY > 0 ? cr / cols * spanY : 0);
                    var d = Math.pow(cells[k].cx - cx, 2) + Math.pow(cells[k].cy - cy, 2);
                    if (d < bestDist) { bestDist = d; best = c; }
                }
                cell = best;
            }
            used[cell] = true;
            result[cell] = cells[k].entry;
        }
        return result.filter(Boolean).map(function (e) { return { id: e.id, path: e.path }; });
    }

    // 宽高比一致性校验：sizes=[{w,h}]，任意两者差值 > tolerance 则 false。
    function checkAspectMatch(sizes, tolerance) {
        tolerance = tolerance == null ? 0.01 : tolerance;
        if (!sizes || sizes.length < 2) return true;
        var ref = sizes[0].w / sizes[0].h;
        for (var i = 1; i < sizes.length; i++) {
            var r = sizes[i].w / sizes[i].h;
            if (Math.abs(r - ref) > tolerance) return false;
        }
        return true;
    }

    // 合成布局计算：sizes=[{w,h}]，返回 {cellW, cellH, gridW, gridH}，长边 ≤ maxPx。
    function computeComposeLayout(sizes, cols, maxPx) {
        maxPx = maxPx || 8192;
        var cellW = 0, cellH = 0;
        for (var i = 0; i < sizes.length; i++) {
            if (sizes[i].w > cellW) cellW = sizes[i].w;
            if (sizes[i].h > cellH) cellH = sizes[i].h;
        }
        var gridW = cellW * cols, gridH = cellH * cols;
        var scale = Math.min(1, maxPx / Math.max(gridW, gridH));
        cellW = Math.floor(cellW * scale);
        cellH = Math.floor(cellH * scale);
        return { cellW: cellW, cellH: cellH, gridW: cellW * cols, gridH: cellH * cols };
    }

    // 拆分元数据：源图 width×height，切成 cols×cols。单格短边 < minCell 则 throw {code:'RESOLUTION'}。
    function computeSplitMeta(width, height, cols, minCell) {
        minCell = minCell || 256;
        var cellW = Math.floor(width / cols);
        var cellH = Math.floor(height / cols);
        var shortEdge = Math.min(cellW, cellH);
        if (shortEdge < minCell) {
            var err = new Error('分辨率不足');
            err.code = 'RESOLUTION';
            throw err;
        }
        return { cellW: cellW, cellH: cellH };
    }

    // ── canvas 编排 ──

    function loadImage(url) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error('图片加载失败: ' + url)); };
            img.src = url;
        });
    }
    function canvasToBlob(canvas, mime) {
        return new Promise(function (resolve, reject) {
            if (canvas.toBlob) {
                canvas.toBlob(resolve, mime);
            } else {
                var dataUrl = canvas.toDataURL(mime);
                var b64 = dataUrl.split(',')[1];
                var raw = atob(b64);
                var parts = [new Uint8Array(raw.length)];
                for (var i = 0; i < raw.length; i++) parts[0][i] = raw.charCodeAt(i);
                resolve(new Blob(parts, { type: mime }));
            }
        });
    }

    // paths 已按格子顺序(左上→右下)排好，长度=cols*cols。opts={maxPx, tolerance, toFileUrl}。
    function composeGridImages(paths, cols, opts) {
        opts = opts || {};
        var toFileUrl = opts.toFileUrl || function (x) { return x; };
        return Promise.all(paths.map(function (p) { return loadImage(toFileUrl(p)); })).then(function (imgs) {
            var sizes = imgs.map(function (im) { return { w: im.naturalWidth, h: im.naturalHeight }; });
            if (!checkAspectMatch(sizes, opts.tolerance)) throw new Error('宽高比不一致');
            var layout = computeComposeLayout(sizes, cols, opts.maxPx);
            var canvas = document.createElement('canvas');
            canvas.width = layout.gridW;
            canvas.height = layout.gridH;
            var ctx = canvas.getContext('2d');
            for (var i = 0; i < imgs.length; i++) {
                var col = i % cols, row = Math.floor(i / cols);
                ctx.drawImage(imgs[i], col * layout.cellW, row * layout.cellH, layout.cellW, layout.cellH);
            }
            return canvasToBlob(canvas, 'image/png');
        });
    }

    // opts={minCell, toFileUrl}；返回 Array<Blob>（按格子顺序）。
    function splitGridImage(path, cols, opts) {
        opts = opts || {};
        var toFileUrl = opts.toFileUrl || function (x) { return x; };
        return loadImage(toFileUrl(path)).then(function (img) {
            var meta = computeSplitMeta(img.naturalWidth, img.naturalHeight, cols, opts.minCell);
            var canvas = document.createElement('canvas');
            canvas.width = meta.cellW;
            canvas.height = meta.cellH;
            var ctx = canvas.getContext('2d');
            var blobs = [];
            for (var row = 0; row < cols; row++) {
                for (var col = 0; col < cols; col++) {
                    ctx.clearRect(0, 0, meta.cellW, meta.cellH);
                    ctx.drawImage(img, col * meta.cellW, row * meta.cellH, meta.cellW, meta.cellH, 0, 0, meta.cellW, meta.cellH);
                    blobs.push(canvasToBlob(canvas, 'image/png'));
                }
            }
            return Promise.all(blobs);
        });
    }

    // 导出
    global.AEComfyUI.mapNodesToGrid = mapNodesToGrid;
    global.AEComfyUI.checkAspectMatch = checkAspectMatch;
    global.AEComfyUI.computeComposeLayout = computeComposeLayout;
    global.AEComfyUI.computeSplitMeta = computeSplitMeta;
    global.AEComfyUI.composeGridImages = composeGridImages;
    global.AEComfyUI.splitGridImage = splitGridImage;
})(typeof window !== 'undefined' ? window : global);