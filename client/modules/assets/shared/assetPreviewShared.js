// assetPreviewShared.js — 素材预览的共享判据：自动转码开关、转码限宽、序列帧帧推导
// 素材库视图（refView）与快速执行栏悬停预览共用。判据只有这一份，两处调用同一函数，
// 避免设置键或帧名规则在一边改动后在另一边漂移。
(function (global) {
    global.AEAssetsShared = global.AEAssetsShared || {};

    // 自动转码开关（素材库模块设置）：localStorage['assets.autoTranscode'] === '0' 为关闭，
    // 缺省开启。关闭时不发起 ffmpeg 转码；既有缓存不受影响，命中仍可播放。
    function autoTranscodeEnabled() {
        try { return localStorage.getItem('assets.autoTranscode') !== '0'; } catch (_) { return true; }
    }

    // 转码限宽（模块设置里的缓存分辨率），缺省 854。产物名含限宽，切换分辨率不命中旧缓存。
    function transcodeMaxWidth() {
        var maxWidth = 854;
        try {
            var mw = localStorage.getItem('assets.transcodeMaxWidth');
            if (mw != null) {
                var parsed = parseInt(mw, 10);
                if (!isNaN(parsed)) maxWidth = parsed;
            }
        } catch (_) {}
        return maxWidth;
    }

    // 序列帧条目（originalPath 为首帧路径，sequence = { count, prefix, ext }）→
    // { dir, prefix, ext, count, start, width }；文件名不合规返回 null。
    // width > 0 表示带前导零命名（frame_001）→ 补零到首帧位宽；无前导零（frame_1..frame_10）
    // 按自然位数增长（补零会推出不存在的 frame_010）。
    function sequenceMetaFromItem(item) {
        var seq = item && item.sequence;
        var src = item && item.originalPath;
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

    // 第 index 帧文件名
    function sequenceFrameName(meta, index) {
        var s = String(meta.start + index);
        while (meta.width > 0 && s.length < meta.width) s = '0' + s;
        return meta.prefix + s + meta.ext;
    }

    // 帧 URL 列表：目录扫描命中才收（缺帧不推进 <img>）；扫描不可用时按推导兜底。
    function sequenceFrameUrls(meta) {
        var names = [];
        for (var i = 0; i < meta.count; i++) names.push(sequenceFrameName(meta, i));
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

    global.AEAssetsShared.autoTranscodeEnabled = autoTranscodeEnabled;
    global.AEAssetsShared.transcodeMaxWidth = transcodeMaxWidth;
    global.AEAssetsShared.sequenceMetaFromItem = sequenceMetaFromItem;
    global.AEAssetsShared.sequenceFrameName = sequenceFrameName;
    global.AEAssetsShared.sequenceFrameUrls = sequenceFrameUrls;
})(window);
