/**
 * ffxMeta.js — .ffx（动画预设）本体元数据静态探测
 *
 * 背景：手动拷入数据目录的 .ffx 没有 AE 侧来源信息，详情里的
 * 「大小 / KF / EXP / FX」恒为 0/false（不可信）。本模块从 .ffx 字节本体读出：
 *   · hasKeyframes  ← 结构里出现 lhd3 / ldat 块（逐属性动画数据）
 *   · hasExpressions← 属性数据 LIST 里与 tdb4 同级的 Utf8（表达式源码）。名字串不混：
 *                     解析只下钻 LIST、不下钻普通块载荷（它们嵌在 tdsn / fnam / pdnm 等
 *                     普通块的载荷里）；「同级 tdb4」是第二道精度防线（见 fixtures）。
 *   · size          ← 文件字节数（由 readFfxMeta 从 blob 拿）
 *
 * 判据来源：AE 23.5 上用 11 份预设做「应用后读回」对照，取实测的判别特征，非格式文档推演。
 *
 * 边界（如实）：.ffx 是 AE 私有 part 格式（RIFX/FaFX），Adobe 未提供文档。
 * 解析失败（非 RIFX、结构畸形）返回 {ok:false}，调用方保留默认行为（0/false），
 * 不编造元数据。
 */
(function (global) {
    'use strict';

    var MAX_CHUNKS = 200000;   // 畸形文件防御（正常 <500KB 预设的块数在千级）

    function _u32(b, o) {
        return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    }
    function _str(b, o, len) {
        var s = '';
        for (var i = 0; i < len; i++) s += String.fromCharCode(b[o + i]);
        return s;
    }
    function _isChunkId(s) {
        // 可打印 ASCII 四字符（AE 块 id 全为这种形态）
        for (var i = 0; i < 4; i++) {
            var c = s.charCodeAt(i);
            if (c < 0x20 || c > 0x7e) return false;
        }
        return true;
    }

    // 纯函数：Uint8Array（或数字数组）→ {ok, hasKeyframes, hasExpressions, effectCount}
    function parseFfxMeta(bytes) {
        if (!bytes || bytes.length < 16) return { ok: false, reason: 'too_short' };
        if (_str(bytes, 0, 4) !== 'RIFX') return { ok: false, reason: 'not_rifx' };
        var res = { ok: true, hasKeyframes: false, hasExpressions: false, effectCount: 0 };
        var chunks = 0;

        // 只下钻 LIST（RIFX 顶层容器）——tdsn/fnam/pdnm 是**普通块**（载荷里嵌着一段 Utf8
        // 子块），下钻它们的载荷会把名字串误当表达式（这正是判据要区分的地方）。
        function walkList(off, end) {
            var firstOfList = [];
            while (off + 8 <= end) {
                if (++chunks > MAX_CHUNKS) return;
                var id = _str(bytes, off, 4);
                var size = _u32(bytes, off + 4);
                if (!_isChunkId(id) || size > end - off - 8) return;
                var dataOff = off + 8;
                if (id === 'LIST' || id === 'RIFX') {
                    walkList(dataOff + 4, dataOff + size);
                } else {
                    firstOfList.push(id);
                    if (id === 'lhd3' || id === 'ldat') res.hasKeyframes = true;
                    if (id === 'tdmn' && size >= 18 &&
                        _str(bytes, dataOff, 18) === 'ADBE Effect Parade') {
                        res.effectCount++;
                    }
                }
                off = dataOff + size + (size % 2);
            }
            // 表达式：同一 LIST 内 Utf8 与 tdb4 同级（属性数据块 + 表达式源码的固定形态）
            var hasTdb4 = false, hasUtf8 = false;
            for (var i = 0; i < firstOfList.length; i++) {
                if (firstOfList[i] === 'tdb4') hasTdb4 = true;
                else if (firstOfList[i] === 'Utf8') hasUtf8 = true;
            }
            if (hasTdb4 && hasUtf8) res.hasExpressions = true;
        }

        walkList(12, bytes.length);   // RIFX(4) + size(4) + formType 'FaFX'(4) → 块流从 12 起
        return res;
    }

    function _toBytes(blob) {
        if (!blob) return null;
        if (blob.arrayBuffer) {
            return blob.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
        }
        // 老环境兜底：FileReader（CEF 88 有 arrayBuffer，正常走不到）
        return new Promise(function (resolve, reject) {
            try {
                var fr = new FileReader();
                fr.onload = function () { resolve(new Uint8Array(fr.result)); };
                fr.onerror = function () { reject(new Error('FileReader 读取失败')); };
                fr.readAsArrayBuffer(blob);
            } catch (e) { reject(e); }
        });
    }

    // 读盘 + 解析：aefs 为 AEFS 实例；成功 → {size, hasKeyframes, hasExpressions, hasEffects, effectCount}
    // 失败（通道不可用 / 非 .ffx / 解析失败）→ null（调用方保留旧行为，不编造）
    function readFfxMeta(aefs, ffxPath) {
        if (!aefs || typeof aefs.readBlob !== 'function') return Promise.resolve(null);
        return Promise.resolve(aefs.readBlob(ffxPath)).then(function (r) {
            if (!r || r.success !== true || !r.blob) return null;
            return _toBytes(r.blob).then(function (bytes) {
                var meta = parseFfxMeta(bytes);
                if (!meta.ok) return null;
                meta.size = (typeof r.size === 'number' && r.size > 0) ? r.size : bytes.length;
                meta.hasEffects = meta.effectCount > 0;
                return meta;
            });
        }).catch(function () { return null; });
    }

    global.AEAssetsShared = global.AEAssetsShared || {};
    global.AEAssetsShared.parseFfxMeta = parseFfxMeta;
    global.AEAssetsShared.readFfxMeta = readFfxMeta;
})(window);
