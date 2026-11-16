(function (global) {
    // 本地绝对路径 → file:/// URL，供 <img>/<video>/<audio> 加载。
    // 裸 C:\ 路径当相对 URL 在 CEP 下不显示；已有 file/http/data/blob 前缀的直通。
    // 公共层单份实现，多模块共用。
    function toFileUrl(p) {
        if (!p) return p;
        if (/^(file:|https?:|data:|blob:)/i.test(p)) return p;
        var norm = String(p).replace(/\\/g, '/');
        // # 是 fragment 起始符、? 是 query 起始符、% 是百分号编码前缀——
        // 文件名含这三个字符时 file URL 会被截断/误解析，img/video 加载失败。
        // （与 aefs.js _readFileFallback 的 encodeURI(...).replace(/#/g, '%23') 同口径并补齐 % 与 ?）
        var esc = function (c) {
            return c === '?' ? '%3F' : (c === '#' ? '%23' : '%25');
        };
        if (/^[A-Za-z]:\//.test(norm)) {
            return 'file:///' + norm.replace(/[?#%]/g, esc);
        }
        // UNC（\\server\share\... / //server/share\...）：标准 file URL 形态为
        // file://server/share/...（主机名=server）。数据根被域策略重定向到文件服务器时
        // 图片/视频路径会落到这里；与盘符分支同款转义，防 #/?/% 文件名被截断。
        if (/^\/\/[^\/]/.test(norm)) {
            // norm 以 //server/... 开头：file:// 后直接接 server（去掉前导斜杠），
            // 否则拼成 file:////server/...（空主机 + 盘根相对路径，非 UNC 语义）
            return 'file://' + norm.replace(/^\/+/, '').replace(/[?#%]/g, esc);
        }
        return norm;
    }

    global.AEShared = global.AEShared || {};
    global.AEShared.toFileUrl = toFileUrl;
})(window);
