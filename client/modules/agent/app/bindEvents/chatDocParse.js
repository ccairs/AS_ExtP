// 聊天输入文件解析助手
// 从 app/main.js 的 bindEvents 闭包拆出：
//   - 纯函数 + 常量，零闭包依赖（仅 AEFS / window.Bridge / FileReader / window.AEShared 全局）
//   - main.js 通过解构引用，调用点保持原名不变
(function (global) {
    var PARSEABLE_DOC_EXT = /\.(docx|doc|xlsx|xls|xlsm|csv|pdf|txt|md|js)$/i;
    // 内容通道：无绝对路径的文档（CEP 拖拽 File.path 各环境行为不一，实测当前环境可拿到，
    // 但不可依赖），用 FileReader 读内容解析，不落盘，作为无路径场景的兜底。
    // 文本类（txt/md/js/csv）直接 readAsText 注入；二进制类（docx/xlsx/pdf 等）读 dataURL 后
    // 提取 base64 交给 bridge parse-doc-bytes 解析（mammoth/xlsx/unpdf 在服务端）。
    var PARSE_CONTENT_TEXT_EXT = /\.(txt|md|js|csv)$/i;
    var PARSE_CONTENT_MAX_BYTES = 10 * 1024 * 1024;   // 超 10MB 的文档跳过内容，仅保留路径行
    // 解析截止时间按文件大小自适应：小文件快速降级（防 bridge 卡顿拖死发送），大文件放宽给足解析时间。
    // 无大小信息（parse-doc 路径通道读盘）按最大档处理。
    function _parseTimeout(size) {
        if (!size) return 15000;
        if (size <= 1 * 1024 * 1024) return 2500;
        if (size <= 5 * 1024 * 1024) return 6000;
        if (size <= 20 * 1024 * 1024) return 10000;
        return 15000;
    }
    // 解析文本量上限：64MB 纯文本 ≈ 1600 万 tokens，一次性注入会撑爆 context（1M）。
    // 截断保留头部（正文/表头）+ 尾部（结论/合计），并在中间标注被裁掉的字符数。
    var PARSE_TEXT_MAX_CHARS = 80 * 1024;   // 80K 字符 ≈ 20K tokens
    var PARSE_TEXT_TAIL_CHARS = 8 * 1024;   // 尾部保留 8K 字符
    function _truncateParseText(text) {
        if (!text || text.length <= PARSE_TEXT_MAX_CHARS) return text;
        var head = text.slice(0, PARSE_TEXT_MAX_CHARS - PARSE_TEXT_TAIL_CHARS);
        var tail = text.slice(text.length - PARSE_TEXT_TAIL_CHARS);
        var skipped = text.length - head.length - tail.length;
        return head + '\n\n[内容过长已截断，省略中间 ' + skipped + ' 字符]\n\n' + tail;
    }
    function _parseDocContent(file, name) {
        return new Promise(function (resolve) {
            if (!file || !name) { resolve(null); return; }
            if (file.size && file.size > PARSE_CONTENT_MAX_BYTES) { resolve(null); return; }
            var isText = PARSE_CONTENT_TEXT_EXT.test(name);
            var reader = new FileReader();
            reader.onload = function () {
                try {
                    if (isText) {
                        resolve({ text: String(reader.result || '') });
                        return;
                    }
                    var dataUrl = String(reader.result || '');
                    var idx = dataUrl.indexOf('base64,');
                    var payload = idx !== -1 ? dataUrl.substring(idx + 7) : '';
                    if (!payload || typeof window.Bridge === 'undefined' || typeof window.Bridge.parseDocBytes !== 'function') {
                        resolve(null);
                        return;
                    }
                    var p = window.Bridge.parseDocBytes(name, payload);
                    if (!p || typeof p.then !== 'function') { resolve(null); return; }
                    p.then(function (r) {
                        resolve((r && r.ok && r.text) ? { text: r.text } : null);
                    }).catch(function () { resolve(null); });
                } catch (_) { resolve(null); }
            };
            reader.onerror = function () { resolve(null); };
            if (isText) reader.readAsText(file, 'utf-8');
            else reader.readAsDataURL(file);
        });
    }

    // 把 data URL 存到 temp/agent/，返回相对数据目录的路径（数据目录迁移后仍有效）
    // 文件名加自增序号（chat_img_<ts>_<seq>_<name>）——发送循环内同步调用
    // 本函数，多个同名图片 chip 的 Date.now() 相同，同毫秒多次落盘互相覆盖（后写者
    // 覆盖先写者），持久化的 message.images 多条指向同一文件，会话重载后其余图片
    // 永久丢失；CJK 文件名 sanitize 成下划线后不同名图片也会碰撞。序号保证唯一。
    var _imgTempSeq = 0;
    function _saveImageToTemp(dataUrl, name) {
        try {
            var base64 = dataUrl;
            var idx = base64.indexOf('base64,');
            if (idx !== -1) base64 = base64.substring(idx + 7);
            var dataDir = (window.AEShared && typeof window.AEShared.getDataDir === 'function')
                ? window.AEShared.getDataDir().dir : '';
            if (!dataDir) return null;
            var dir = dataDir.replace(/\\+$/, '') + '\\temp\\agent';
            // 确保目录存在（AEFS.mkdirSync 一次一层，逐层建 temp → temp/agent）
            try {
                if (typeof AEFS !== 'undefined' && AEFS.mkdirSync) AEFS.mkdirSync(dataDir.replace(/\\+$/, '') + '\\temp');
                if (typeof AEFS !== 'undefined' && AEFS.mkdirSync) AEFS.mkdirSync(dir);
            } catch (_) {}
            var ts = Date.now();
            var fname = 'chat_img_' + ts + '_' + (++_imgTempSeq) + '_' + (name || 'img.png').replace(/[^a-zA-Z0-9._-]/g, '_');
            var fp = dir + '\\' + fname;
            if (typeof AEFS !== 'undefined' && typeof AEFS.writeFileBase64Sync === 'function') {
                if (AEFS.writeFileBase64Sync(fp, base64)) return 'temp\\agent\\' + fname;
            }
        } catch (_) {}
        return null;
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.chatDocParse = {
        PARSEABLE_DOC_EXT,
        _parseTimeout,
        _truncateParseText,
        _parseDocContent,
        _saveImageToTemp
    };
})(window);
