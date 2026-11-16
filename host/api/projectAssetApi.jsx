// 工程素材导出 ExtendScript 工具（由 host.jsx $.evalFile 加载，挂 AE 全局）
// 由面板 projectAssetView 经 hostApi.call 调用。所有函数返回 JSON.stringify({status:"success"|"error", ...}) 字符串
// （hostApi.call 经 evalScript 拿 toString，裸对象会变 "[object Object]"，故显式 JSON.stringify；view 侧 _call 用 JSON.parse 还原）。
// 注意：数据目录文件的读写由面板侧 AEFS 负责，本文件只用 new File/new Folder 操作 AE 工程 API（collectFiles/save/open/reduce）。

// 导出忙标志：防 panel 超时后排队的 restoreProject 误伤用户手动切换的工程。
// 背景：CEP 的 evalScript 超时只放弃 panel 端等待，jsx 仍在后台跑到完成；ExtendScript 单线程排队，
// panel 超时后发的 restoreProject 会排在 exportCompOrLayer 后面延迟执行——若此时用户已手动切工程
// 并做了未保存工作，延迟到达的 app.open + suppressDialogs 会静默丢弃用户工作。
// 故 restoreProject 在 $_exporting 仍为 true 时拒绝执行，让 panel 提示用户手动打开原工程。
var $_exporting = false;

// 进度上报：通过 PlugPlugExternalObject 向 panel 发 CSEvent，供 notice 实时更新阶段文本。
// ExtendScript 单线程，evalScript 轮询会排队失效；CSEvent 异步派发不受阻塞影响。
// PlugPlug 不可用时静默降级（notice 保持初始文本）。
var _plugPlug = null;
function _emitProgress(msg) {
    try {
        if (!_plugPlug) _plugPlug = new ExternalObject("lib:PlugPlugExternalObject");
        var ev = new PlugPlugExternalObject.CSEvent("com.ae.assets.exportProgress", "APPLICATION");
        ev.data = msg;
        _plugPlug.dispatchEvent(ev);
    } catch (_) {}
}

// 结构化进度上报：发送 JSON 字符串，panel 侧按 {message, progress, progressLabel} 解析。
// progress=null 表示显式清除进度条（PSD 阶段结束后切回纯文本阶段时使用）。
function _emitProgressObj(obj) {
    try { _emitProgress(JSON.stringify(obj)); } catch (_) {}
}

// ── PSD 分图层 footage 转 PNG（绕开 FileSource.file readOnly）──
// saveFrameToPng 直接存帧不走渲染队列，PNG 单图层 replace 不合并
// 替换集对齐 _sanitizeFileName——补引号/%$/控制字符 → _（AEFS 拒引号/%，
// 落盘文件名带这些字符会让条目后续 fileSize/删除/改名全被 AEFS 拒绝）
function _sanitizePngName(s) {
    return String(s).replace(/\.psd$/i, '').replace(/[\/\\:*?"'<>|%$]/g, '_').replace(/[\x00-\x1f\x7f]/g, '_').replace(/\s/g, '_');
}

// ── 保存产物核查：分档判据 ──
// 背景：save 在 beginSuppressDialogs 窗口内会**静默失败**（磁盘满/被杀软扫描/另一 AE
// 实例锁定），不抛异常。三种判据都不成立：
// · 只查 exists → 保存失败但目标处有旧残留时被报 success 入索引；
// · 收紧成「mtime 必须变化」→ 能识破残留，但 FAT/exFAT（2s 粒度）或低分辨率
//     共享盘上**保存成功也同粒度**，被判假失败（面板不登记资产）；

// 分档判据——两侧统一成同一套：
//   ① 保存前**本来没有** → 保存后必须出现且非 0 字节（没有可比对象，只能这样验）；
//   ② 保存前**本来就有** → 允许 mtime 相等（粗粒度盘），但要求 mtime 变化**或**大小变化
//      （真写盘一般会动其一，比只看时间靠得住）；
// ③ mtime 回退（拿到但比保存前旧）→ 失败（既有语义，防被旧副本顶替）；
//   ④ mtime 任一侧读不到（通道故障）→ 退到「存在且非空」——读不到时间不是保存失败的证据，
//      不误报。
// 已知残差：② 的「mtime 同粒度且大小恰好不变」仍会报「未确认」（再往下要读全文比对，
// 对动辄几十 MB 的 .aep 代价不成比例）。
function _verifySavedAep(preExists, preLen, preMod, f) {
    var postExists = false, postLen = 0, postMod = 0;
    try {
        postExists = !!f.exists;
        if (postExists) postLen = f.length;
        if (postExists && f.modified) postMod = f.modified.getTime();
    } catch (_) {}
    if (!postExists || !(postLen > 0)) return false;   // ①③：不存在 / 空产物
    if (!preExists) return true;                       // ①：本来没有 → 出现且非空即成功
    if (!preMod || !postMod) return true;              // ④：时间通道读不到 → 不误报
    if (postMod < preMod) return false;                // ③：mtime 回退
    if (postMod > preMod) return true;                 // mtime 前进
    return postLen !== preLen;                         // ②：同粒度 → 要求大小变了
}

// ── 输出文件名消毒（防目录穿越）──
// compName 来自 .aep 工程内容（AE 合成名允许 / \ .. 等任意字符），projectName 来自 panel 用户输入。
// 直接拼进输出路径会把 .aep 写到 targetFolder 之外（"../../pwn"）。
// Owner 拍板：非法字符一律替换为 _（不拒绝、不报错，兼容旧工程）；消毒后为空串回退 "untitled"。
// 语义对齐 panel 侧 _autoName（projectAssetView.js）与 treeView.invalidNameSeg：
// 路径分隔符 + Windows 非法字符 + 引号 + % $ → _（AEFS _checkPath 拒引号/%，落盘文件名带这些字符
// 会让条目后续 fileSize/删除/改名全被 AEFS 拒绝），控制字符 → _（_autoName 是删除，此处替换保证长度可见），
// 纯点段整体 → _（防 ".." 逐字符处理后仍残留）。
function _sanitizeFileName(s) {
    var n = String(s == null ? "" : s);
    n = n.replace(/[\/\\:*?"'<>|%$]/g, "_")   // 路径分隔符 + Windows 非法字符 + 引号 + % $
         .replace(/[\x00-\x1f\x7f]/g, "_");   // 控制字符
    if (/^\.+$/.test(n)) n = "_";              // 纯点段 "." / ".." / "..." 整体替换（防 ".." 逐字符处理后仍残留）
    return n || "untitled";
}

// ES3 兼容的数组包含判断：ExtendScript 的 Array 无 indexOf（ES5 方法，同文件
// "ExtendScript 无 Array.map（ES3）" 注释同源），unredirected.indexOf 在真实 AE
// 中抛 TypeError 被逐项 catch 吞掉 → 未重定向素材警告列表永远为空。
function _arrContains(arr, v) {
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] === v) return true;
    }
    return false;
}

// ── 路径白名单校验（纵深防御兜底）──
// panel 侧 AEFS 已做 _checkPath 校验，此处 jsx 侧兜底：targetFolder/tempDir 必须以 dataRoot 开头。
// dataRoot 由 panel 侧传入（= dataDir），防止 panel 异常或调用方绕过 AEFS 时路径越界。
// 路径比较前统一规范化（\ → /，去末尾 /），大小写不敏感（Windows）。
// 拒绝含 .. 段的路径，防穿越（如 C:/data/../Windows 会被误判为 C:/data 子路径）。
function _ensureUnderRoot(p, root) {
    if (!p || !root) return false;
    var ps = String(p);
    // 与 AEFS _checkPath 对齐：拒 % / 控制字符 / 引号 / DOS 设备名
    if (ps.indexOf('%') !== -1) return false;
    for (var ci = 0; ci < ps.length; ci++) {
        var cc = ps.charCodeAt(ci);
        if (cc <= 0x1F || cc === 0x7F || cc === 0x22 || cc === 0x27) return false;
    }
    if (/(^|[\\\/\:])\.\.([\\\/\:]|$)/.test(ps) || /(^|[\\\/\:])\.([\\\/\:]|$)/.test(ps)) return false;
    var segs = ps.replace(/[\\\/]+/g, '/').replace(/\/+$/, '').split('/');
    for (var si = 0; si < segs.length; si++) {
        var upper = segs[si].replace(/\..*$/, '').toUpperCase();
        if (upper === 'NUL' || upper === 'CON' || upper === 'CONIN$' || upper === 'CONOUT$' ||
            upper === 'PRN' || upper === 'AUX' || /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) {
            return false;
        }
    }
    var normP = ps.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    var normRoot = String(root).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!normP || !normRoot) return false;
    // 拒绝含 .. 段的路径（防穿越）
    if (/(^|\/)\.\.(\/|$)/.test(normP)) return false;
    if (/(^|\/)\.\.(\/|$)/.test(normRoot)) return false;
    if (normP === normRoot) return false;          // 不能等于根目录本身
    return normP.indexOf(normRoot + "/") === 0;     // 必须是 root 的子路径
}

// 等 saveFrameToPng 输出文件写完（渐进写入，参考 aeTools.jsx getPreviewFrame）
// 轮询间隔已缩短：saveFrameToPng 同步返回后文件通常已写完，乐观情况 ~450ms 即可返回。
// 保留多轮检测机制防御"半截图片"（文件头写完但像素数据还在写入），最坏情况 ~12s 超时。
// 入参是调用方交给 saveFrameToPng 的那个 File 对象——它在 AE
// 渐进写入期属性**陈旧**（同库 aeTools.jsx `_liveLen` 的实测对照：文件最终 10,833,057 字节，
// 该对象 length 只回报 1,476,761；直读它会恒判 0 字节 → 空转到超时 → PSD 转 PNG
// 报失败、条目落进 unredirected）。修法：入参只用于取一次路径（兼容直接传路径字符串），
// 此后每轮 `new File(路径)` 重取对象，exists/length/seek/open 全部走新对象
//（对齐 aeTools.jsx _liveLen 的写法）。
function _waitPngStable(file) {
    try {
        var pngPath = (typeof file === "string") ? file : String(file.fsName || "");
        if (!pngPath) return false;
        // 实时读：-1 = 当前不存在；>=0 = 当前字节数。每轮新建 File 对象，绝不复用陈旧对象
        //（`file` 只作为"当前轮新对象"的持有者被重赋，下方 open/seek/read 全走新对象）。
        var _liveLen = function () {
            file = new File(pngPath);
            return file.exists ? file.length : -1;
        };
        $.sleep(50);
        var waitCount = 0;
        var len = _liveLen();
        // 等待条件从"文件出现（len >= 0）"收紧为
        // "文件非空（len > 0）"。saveFrameToPng 是渐进写入——先创建 0 字节文件再写像素
        //（同库 aeTools.jsx getPreviewFrame/_liveLen 注释与实测：只等 exists 会在 0 字节
        // 窗口立刻早退）。saveFrameToPng 同步返回后本函数随即判长度，命中该窗口即误判
        // "转 PNG 失败" → PSD 条目落进 unredirected（正是上一轮要修的用户症状）。
        // -1（尚未出现）与 0（写入窗口）都继续等，预算仍是 100 轮 × 50ms = 5s；
        // 只有超时仍为 0/-1 才 return false（预算不可无限延长）。
        while (len <= 0 && waitCount < 100) { $.sleep(50); waitCount++; len = _liveLen(); }
        if (len <= 0) return false;
        var stableCount = 0;
        for (var w = 0; w < 10; w++) {
            $.sleep(100);
            var lenBefore = _liveLen();   // 每轮重取对象：旧对象 length 陈旧（见上）
            $.sleep(100);
            var lenAfter = _liveLen();    // 同上
            if (lenBefore === lenAfter && lenBefore > 0) { stableCount++; if (stableCount >= 2) break; }
            else stableCount = 0;
        }
        for (var vi = 0; vi < 20; vi++) {
            try {
                // 只读最后 8 字节、只校验前 4 字符。
                // 原法读"含 CRC 的 12 字节"并判 `tail.length === 12`——而 IEND chunk 的 CRC
                // 是固定值 AE 42 60 82，首字节 0xAE ≥ 0x80 会被 ExtendScript 的读编码转换吞掉
                // → 实得 11 字符 → 长度判据恒 false → **该校验在中文 Windows 上必然失败**，
                // 不是间歇（详见 aeTools.jsx getPreviewFrame 的同款注释与实测报文）。
                // IEND 的 length 字段恒为 0，故从 len-8 读时 "IEND" 必落在头 4 字符上，不碰 CRC。
                _liveLen();   // 读尾前重取对象（同上：旧对象 length 陈旧会让 seek 落错位置）
                if (file.length < 8) { $.sleep(100); continue; }
                file.open("r", "BINARY");
                try {
                    file.seek(file.length - 8);
                    var tail = file.read(8);
                } finally {
                    // 异常时也要关闭句柄，否则下轮 open 可能因占用失败导致 IEND 误判
                    //（对齐 aeTools.jsx getPreviewFrame 的 IEND 校验写法）
                    file.close();
                }
                if (tail && tail.substring(0, 4) === "IEND") return true;
            } catch (_) {}
            $.sleep(100);
        }
        return false;
    } catch (e) { return false; }
}

// 把 PSD 分图层 footage 渲染成 PNG 并 replace（footage 改指向 footageDir 下的 PNG，自包含）
// copiedByName（可缺省）：同名登记映射（见 exportWholeProject 声明处注释）。
// PSD 图层名体系与普通素材文件名体系共用 footageDir 命名空间，产物名必须与
// 普通素材互相查重/登记（登记值 "$psdpng$" 为合成标记，永不等同真实源 fsName，普通素材
// 同名碰撞时视为不同源走序号后缀）——否则先落盘的 bg.png 会让后处理的同名普通素材
// exists 误判已拷而错接 PSD 渲染图（声称消灭的错接在两套命名体系间复活）
function _psdFootageToPng(footage, footageDir, copiedByName) {
    var tempComp = null;
    try {
        var base = _sanitizePngName(footage.name);
        var pngName = base + ".png";
        var pngPath = footageDir.fsName + "/" + pngName;
        var pngFile = new File(pngPath);
        var seq = 1;
        // 重名加序号——磁盘 exists 与同轮 copiedByName 登记双向查重（普通素材
        // 拷贝失败仍登记、或登记先于落盘时，仅查磁盘会撞名占位）
        // copiedByName 键统一 toLowerCase（与两导出函数的普通素材分支同一
        // 键空间——大小写变体名相互查重，防 PSD PNG 产物被普通素材大小写变体覆盖）
        while (pngFile.exists || (copiedByName && copiedByName[pngName.toLowerCase()])) {
            pngName = base + "_" + seq + ".png";
            pngPath = footageDir.fsName + "/" + pngName;
            pngFile = new File(pngPath);
            seq++;
        }
        var w = footage.width < 4 ? 4 : footage.width;
        var h = footage.height < 4 ? 4 : footage.height;
        tempComp = app.project.items.addComp("_psd2png_" + (new Date().getTime()), w, h, footage.pixelAspect, 1 / 30, 30);
        tempComp.layers.add(footage);
        // 不调用 openInViewer：后台渲染无需切换 viewer，省去 UI 刷新开销
        tempComp.saveFrameToPng(0, pngFile);
        var stable = _waitPngStable(pngFile);
        if (!stable) return false;
        // 最终落盘 PNG 名登记进 copiedByName（stable 验证后，半截产物不登记；
        // "$psdpng$" 永不等同真实源 fsName，普通素材同名时视为不同源走序号后缀）
        // 键 toLowerCase（与查重同一键空间）
        if (copiedByName) copiedByName[pngName.toLowerCase()] = "$psdpng$";
        footage.replace(pngFile);
        return true;
    } catch (e) { return false; }
    finally { if (tempComp) { try { tempComp.remove(); } catch (_) {} } }
}

// ── 取当前工程信息（路径 + 是否有文件 + 项目面板元素数）──
function getProjectState(args) {
    try {
        if (!args) args = {};
        var path = "";
        try { if (app.project.file) path = app.project.file.fsName; } catch (_) {}
        var numItems = 0;
        try { numItems = app.project.numItems; } catch (_) {}
        return JSON.stringify({
            status: "success",
            projectPath: path,
            hasFile: !!path,
            numItems: numItems
        });
    } catch (e) {
        return JSON.stringify({ status: "error", message: e.toString() });
    }
}

// ── 整工程导出 ──
// args: { targetFolder, projectName, collectAssets }
// collectAssets=false（默认）：非破坏，save + copy .aep 到目标目录，素材指向原路径
// collectAssets=true：save 副本 → open 副本 → 收集素材到 footageDir + 改引用 → save 到目标；
//   切回原工程由 panel restoreProject 处理（同 exportCompOrLayer），tempPath 一并返回供清理
function exportWholeProject(args) {
    var suppressStarted = false;
    var tempFile;
    var tempPath = "";
    var tempSavePath = "";   // 未保存工程的 Save-As 临时副本：不在此处删，路径回传面板走 AEFS
    var collectAssets = false;
    var collectPsD = false;
    var setExporting = false;
    try {
        if (!args) args = {};
        var targetStr = args.targetFolder || "";
        // projectName 来自 panel 用户输入（showPrompt，已过 invalidNameSeg），jsx 侧再消毒兜底
        var projectName = _sanitizeFileName(args.projectName || "project");
        collectAssets = args.collectAssets ? true : false;
        collectPsD = args.collectPsD ? true : false;
        if (!targetStr) throw new Error("targetFolder 必填");
        // 路径白名单兜底：targetFolder 必须在 dataRoot 下
        var dataRoot = args.dataRoot || "";
        if (!dataRoot || !_ensureUnderRoot(targetStr, dataRoot)) {
            throw new Error("目标目录不在数据目录下，拒绝执行: " + targetStr);
        }
        var target = new Folder(targetStr);
        if (!target.exists) {
            var parentOk = target.create();
            if (!parentOk) throw new Error("无法创建目标目录: " + targetStr);
        }
        var outputPath = targetStr + "/" + projectName + ".aep";

        if (!collectAssets) {
            // 非破坏：先保存原工程（如有），再 File.copy 到目标目录——避免 Save As 改变当前工程路径
            if (app.project.file) {
                app.project.save();
                // 检查 copy 返回值——磁盘满/目标只读/被占用时复制失败
                // 仅靠事后 exists 探测时，失败仍返回 success + 空 aepPath（导出失败被吞）
                if (!app.project.file.copy(outputPath)) throw new Error("工程副本复制到目标失败: " + outputPath);
            } else {
                // 从未保存过的工程无原路径可回——save(new File(outputPath)) 是
                // Save As 语义，当前工程路径被静默改为导出文件，后续 Ctrl+S 污染导出快照。
                // 改为保存到临时副本再 copy 到目标：导出快照与当前工程解耦（保持「非破坏」；
                // 临时副本用后即删，时间戳后缀防碰撞）
                // 临时副本不能放导出目标目录——Save As 会把当前（未保存）工程的
                // 路径关联改绑到临时副本，删除后用户后续 Ctrl+S 会在导出目录复活
                // _export_tmp_*.aep 幽灵文件，故移出用户可见的导出目录。
                // 临时副本存**数据目录 temp**（不用系统临时目录 Folder.temp）——
                // 缓存/临时产物一律写数据目录；该目录由面板侧
                // AEFS 预建（AE 侧 Folder.create 在未授权 file 域时被沙箱守卫拦）
                // （AEFS 删除审计）：临时副本位于**数据目录内**，删除不得用裸 File.remove
                // 与同函数 catch 分支同款做法：路径经 tempSavePath 回传，面板 AEFS.deleteFile 清理
                var tmpDir = dataRoot.replace(/[\\\/]+$/, "") + "/temp";
                tempSavePath = tmpDir + "/_export_tmp_" + (new Date().getTime()) + ".aep";
                var tmpSaveFile = new File(tempSavePath);
                app.beginSuppressDialogs();
                suppressStarted = true;
                app.project.save(tmpSaveFile);
                app.endSuppressDialogs(false);
                suppressStarted = false;
                if (!tmpSaveFile.exists) throw new Error("保存临时副本失败: " + tempSavePath);
                if (!tmpSaveFile.copy(outputPath)) throw new Error("导出副本复制到目标失败: " + outputPath);
            }
            var aepPath0 = "";
            if (new File(outputPath).exists) aepPath0 = outputPath;
            return JSON.stringify({ status: "success", targetFolder: targetStr, aepPath: aepPath0, unredirected: [], tempSavePath: tempSavePath });
        }

        // 收集素材：save 副本 → open 副本 → 收集 → save 到目标（切回由 panel restoreProject 处理）
        if ($_exporting) {
            return JSON.stringify({ status: "error", message: "导出仍在进行中，请等待当前导出完成" });
        }
        $_exporting = true;
        setExporting = true;
        _emitProgress("正在保存临时副本…");
        if (app.project.file) app.project.save();
        var tempDir = args.tempDir || "";
        if (!tempDir || !_ensureUnderRoot(tempDir, dataRoot)) {
            throw new Error("临时目录未指定或不在数据目录下，拒绝执行");
        }
        var tempFolder = new Folder(tempDir);
        if (!tempFolder.exists) tempFolder.create();  // 防御性兜底（panel 侧 AEFS.mkdir 已建）
        tempPath = tempDir + "/_export_whole_" + (new Date().getTime()) + ".aep";
        tempFile = new File(tempPath);
        app.project.save(tempFile);
        if (!tempFile.exists) throw new Error("保存临时副本失败: " + tempPath);

        _emitProgress("正在打开副本工程（大工程可能较慢）…");
        app.beginSuppressDialogs();
        suppressStarted = true;
        var tempProj = app.open(tempFile);
        if (!tempProj) throw new Error("打开临时副本失败");

        _emitProgress("正在收集素材…");
        var footageDir = new Folder(targetStr + "/footage");
        if (!footageDir.exists) footageDir.create();
        var fileRefCount = {};
        for (var i = 1; i <= app.project.numItems; i++) {
            try {
                var _it = app.project.item(i);
                if (!(_it instanceof FootageItem)) continue;
                var _ms = _it.mainSource;
                if (!_ms || !_ms.file || !_ms.file.exists) continue;
                var _key = String(_ms.file.fsName);
                fileRefCount[_key] = (fileRefCount[_key] || 0) + 1;
            } catch (_) {}
        }
        // 预统计需转 PNG 的 FootageItem 数量（每个分图层 footage 单独转一次），供进度条显示 N/T
        var psdTotal = 0;
        if (collectPsD) {
            for (var i = 1; i <= app.project.numItems; i++) {
                try {
                    var _pit = app.project.item(i);
                    if (!(_pit instanceof FootageItem)) continue;
                    var _pms = _pit.mainSource;
                    if (!_pms || !_pms.file || !_pms.file.exists) continue;
                    // 后缀双重条件（与 isLayered 判定同口径，进度计数不错位）
                    var _psdKey = String(_pms.file.fsName);
                    var _psdDot = _psdKey.lastIndexOf(".");
                    var _psdExt = _psdDot >= 0 ? _psdKey.substring(_psdDot).toLowerCase() : "";
                    if ((fileRefCount[_psdKey] || 0) > 1 && (_psdExt === ".psd" || _psdExt === ".ai")) psdTotal++;
                } catch (_) {}
            }
        }
        var psdDone = 0;  // 当前正在处理第几个（1-indexed，转换前递增）
        var collected = 0, skipped = 0;
        var unredirected = [];
        // 分图层 PSD/AI 兜底副本（collectPsD=false 分支复制到 footageDir 供
        // 手动重链）复制失败的源文件名。ExtendScript File.copy 失败返回 false 不抛异常，
        // 旧代码忽略返回值 → footageDir 静默缺副本而回执不体现；失败经本字段如实上报
        var copyFailed = [];
        // 同名去重映射「消毒名 → 源 fsName」——两个不同源文件同名
        //（不同目录的 bg.png，或名字仅在被替换字符上不同而消毒后相同）时，第二个源
        // 若沿用「目标存在即跳过复制」会直接指向第一个源的副本，导出工程素材静默
        // 张冠李戴且无任何警告；碰撞时追加 _2/_3 序号（对齐 _psdFootageToPng 去重形态）
        // 跳过复制的判定收窄为「同轮同源已拷过且目标在场」——其余情况（首轮
        // 遇磁盘同名残留 / 源原地更新后重导出）无条件重拷，见普通素材分支注释
        // PSD 分图层 PNG 产物名也登记进本映射（值 "$psdpng$" 合成标记，与普通
        // 素材互相查重，防两套命名体系撞名错接），见 _psdFootageToPng
        // 映射键统一 toLowerCase 折叠——JS 对象键大小写敏感而 Windows 文件
        // 系统不敏感，见普通素材分支注释
        var copiedByName = {};
        for (var i = 1; i <= app.project.numItems; i++) {
            try {
                var it = app.project.item(i);
                if (!(it instanceof FootageItem)) continue;
                var ms = it.mainSource;
                if (!ms || !ms.file || !ms.file.exists) { skipped++; continue; }
                var src = ms.file;
                var srcKey = String(src.fsName);
                // 后缀双重条件——refCount>1 也在「同一文件被导入两次」时成立
                //（用户两次导入同一 logo.png / 脚本批量导入重复路径），无后缀校验时
                // 普通素材被误判为 PSD/AI 分图层：collectPsD=false 不重定向引用
                //（导出工程非自包含），true 时被 _psdFootageToPng 栅格化成 PNG
                //（普通素材静默降级）
                var _srcDot = srcKey.lastIndexOf(".");
                var _srcExt = _srcDot >= 0 ? srcKey.substring(_srcDot).toLowerCase() : "";
                var isLayered = (fileRefCount[srcKey] || 0) > 1 && (_srcExt === ".psd" || _srcExt === ".ai");
                if (isLayered) {
                    if (collectPsD) {
                        // 转 PNG，footage 改指向 footageDir 下的 PNG（不需要 PSD 副本）
                        psdDone++;
                        _emitProgressObj({
                            message: "PSD 转 PNG: " + it.name,
                            progress: psdTotal > 0 ? Math.round(psdDone / psdTotal * 100) : 100,
                            progressLabel: psdDone + "/" + psdTotal
                        });
                        if (_psdFootageToPng(it, footageDir, copiedByName)) collected++;
                        else { if (!_arrContains(unredirected, src.name)) unredirected.push(src.name); skipped++; }
                    } else {
                        // 不转 PNG：复制 PSD 到 footageDir 供手动重链，footage 保留原引用
                        // 素材名过 _sanitizeFileName——含 %/' 等字符的落盘文件会让后续 AEFS 操作全被拒
                        // copy 失败返 false 不抛异常，忽略返回值会静默丢兜底副本——
                        // 与普通素材分支同口径「返回值 + exists 双验证」，失败记入 copyFailed 回执
                        // 1b：exists 复核必须重新取对象——psdDstFile 是 copy 之前创建的，
                        // 其 exists 在 ExtendScript 中可能陈旧（同 _waitPngStable 一带的每轮 new File
                        // 读法），成功拷贝会被误判为失败（假告警）。psdCopyOk 的双验证语义不变
                        var psdDst = footageDir.fsName + "/" + _sanitizeFileName(src.name);
                        var psdDstFile = new File(psdDst);
                        if (!psdDstFile.exists) {
                            var psdCopyOk = false;
                            try { psdCopyOk = src.copy(psdDst); } catch (_) { psdCopyOk = false; }
                            if (!psdCopyOk || !new File(psdDst).exists) {
                                if (!_arrContains(copyFailed, src.name)) copyFailed.push(src.name);
                            }
                        }
                        if (!_arrContains(unredirected, src.name)) unredirected.push(src.name);
                        skipped++;
                    }
                    continue;
                }
                // 普通素材：复制 + 改引用
                // 素材名过 _sanitizeFileName——含 %/' 等字符的落盘文件会让后续 AEFS 操作全被拒
                // 同名碰撞走序号后缀（见 copiedByName 声明处注释）
                // 映射键统一 toLowerCase——JS 对象键比较大小写敏感而 Windows
                // 文件系统不敏感，Logo.png/logo.png 两源时：rename 循环不触发（第二个
                // 键未登记）、dstFile.exists 大小写不敏感命中源1已落盘副本 →
                // sameSourceCopied=false → 强制重拷分支 remove+copy 改写源1物理文件
                //（源1 footage 已重定向到该路径，两 footage 同指源2字节，静默张冠
                // 李戴）。键折叠后第二个源走序号后缀；落盘文件名保持原大小写
                //（对齐 _ensureUnderRoot 的 toLowerCase 先例）
                var sName = _sanitizeFileName(src.name);
                if (copiedByName[sName.toLowerCase()] && copiedByName[sName.toLowerCase()] !== srcKey) {
                    var dotAt = sName.lastIndexOf(".");
                    var stem = dotAt > 0 ? sName.substring(0, dotAt) : sName;
                    var ext = dotAt > 0 ? sName.substring(dotAt) : "";
                    var n = 2;
                    while (copiedByName[(stem + "_" + n + ext).toLowerCase()] && copiedByName[(stem + "_" + n + ext).toLowerCase()] !== srcKey) n++;
                    sName = stem + "_" + n + ext;
                }
                // 登记前捕获「当前轮是否已拷过同源」——登记后 copiedByName 键值恒等于
                // srcKey，跳过判定必须用捕获值（键折叠，与查重/登记同一键空间）
                var sKey = sName.toLowerCase();
                var sameSourceCopied = copiedByName[sKey] === srcKey;
                copiedByName[sKey] = srcKey;
                var dstPath = footageDir.fsName + "/" + sName;
                var dstFile = new File(dstPath);
                // 仅「同轮同源已拷过且目标在场」才跳过复制（去重优化保留）；
                // 其余情况（首轮遇磁盘同名残留 / 源原地更新后的重导出）无条件重拷——
                // 旧「目标存在即跳过」在面板确认覆盖再导出时不清理旧 footage：源原地
                // 更新后陈旧副本被复用，跨轮同名源互换时素材张冠李戴（消灭的
                // 错接在跨轮复活）。remove 失败不阻断（旧文件删不掉时 copy 行为由引擎
                // 决定，事后双验证兜底）；copy 返回值与 exists 双验证（ExtendScript copy
                // 失败返 false），失败保持既有 skipped 跳过语义
                if (!dstFile.exists || !sameSourceCopied) {
                    // （AEFS 删除审计）：ES 侧没有 AEFS，这条「清旧再拷」的删除用 _ensureUnderRoot
                    // 复刻 AEFS 的 _checkPath + 容器判定（拒 %/控制字符/引号/DOS 设备名/.. 段，且必须是
                    // footageDir 的子路径）——越界只记日志不删：后续 copy 照旧走返回值 + exists 双验证，
                    // 失败保持 skipped 语义，不存在静默覆盖。
                    if (dstFile.exists) {
                        if (_ensureUnderRoot(dstPath, footageDir.fsName)) { try { dstFile.remove(); } catch (_) {} }
                        else $.writeln("[AS_ExtP] 拒删 footage 目录外的同名残留: " + dstPath);
                    }
                    var copyOk = false;
                    try { copyOk = src.copy(dstPath); } catch (_) { copyOk = false; }
                    if (!copyOk || !dstFile.exists) { skipped++; continue; }
                }
                // 普通素材：ms.file= 优先，replace 回退
                try {
                    ms.file = dstFile;
                    collected++;
                } catch (_) {
                    try {
                        it.replace(dstFile);
                        collected++;
                    } catch (_) { skipped++; }
                }
            } catch (_) { skipped++; }
        }
        // PSD 阶段结束：清除进度条，切回纯文本阶段
        if (psdTotal > 0) _emitProgressObj({ message: "素材收集完成: " + collected + " / " + (collected + skipped), progress: null });
        else _emitProgress("素材收集完成: " + collected + " / " + (collected + skipped));

        _emitProgress("正在保存…");
        // save 前记录旧文件状态（是否存在/大小/mtime）——save 在
        // beginSuppressDialogs 窗口内静默失败不抛异常（磁盘满/目标被杀软扫描或另一 AE
        // 实例锁定），只查 exists 拦不住「重复导出时命中上一轮残留旧 .aep」。核查判据
        // 见 _verifySavedAep（分档：本来没有→出现且非空；本来就有→mtime 变或大小变）
        var _aepTarget = new File(outputPath);
        var _preExists = false, _preLen = 0, _preMod = 0;
        try {
            _preExists = !!_aepTarget.exists;
            if (_preExists) { _preLen = _aepTarget.length; if (_aepTarget.modified) _preMod = _aepTarget.modified.getTime(); }
        } catch (_) {}
        app.project.save(_aepTarget);
        app.endSuppressDialogs(false);
        suppressStarted = false;

        // save 在 beginSuppressDialogs 窗口内静默失败不抛异常，旧代码 status
        // 硬编码 "success"（exists 只喂给 aepPath）→ 保存失败的空导出被面板当成功入索引。
        // 对齐 exportCompOrLayer 尾部形态（三姊妹语义一致）：核查判据决定 status，
        // 失败返回 error + message + 空 aepPath
        var _postAep = new File(outputPath);
        var ok = _verifySavedAep(_preExists, _preLen, _preMod, _postAep);
        return JSON.stringify({
            status: ok ? "success" : "error",
            targetFolder: targetStr,
            aepPath: ok ? outputPath : "",
            tempPath: tempPath,
            unredirected: unredirected,
            copyFailed: copyFailed,   // 分图层 PSD/AI 兜底副本复制失败的源文件名
            message: ok ? "" : "保存 .aep 失败"
        });
    } catch (e) {
        if (suppressStarted) { try { app.endSuppressDialogs(false); } catch (_) {} }
        return JSON.stringify({ status: "error", message: e.toString(), tempPath: tempPath, tempSavePath: tempSavePath });
    } finally {
        if (setExporting) $_exporting = false;
    }
}

// ── 合成/图层导出（reduceProject 非破坏副本 + collectFiles 自包含）──
// args: { compName, layerName(可选), targetFolder, tempName }
// 流程：save 副本到数据目录 temp/tempName → app.open(副本) → (图层则预合成) → reduceProject([目标合成]) → collectFiles(targetFolder) → 找 .aep 返回
// reduce 后工程只剩目标合成 + 其用到的素材，collectFiles 把素材复制进 targetFolder + .aep 也存进去 + 重写路径 → 自包含。
// 临时路径由 ES 侧在数据目录 temp 下生成，返回 tempPath 供面板事后清理
function exportCompOrLayer(args) {
    var suppressStarted = false;
    var tempFile;
    if ($_exporting) {
        return JSON.stringify({ status: "error", message: "导出仍在进行中，请等待当前导出完成" });
    }
    $_exporting = true;
    try {
        if (!args) args = {};
        var compName = args.compName || "";
        var layerName = args.layerName || "";
        var targetFolder = args.targetFolder || "";
        var tempName = args.tempName || ("_export_" + (new Date().getTime()) + ".aep");
        if (!compName || !targetFolder) throw new Error("compName/targetFolder 必填");
        var collectAssets = args.collectAssets !== false ? true : false;  // 默认收集素材
        var collectPsD = args.collectPsD ? true : false;  // PSD 分图层转 PNG（默认不转）

        // 路径白名单兜底：targetFolder/tempDir 必须在 dataRoot 下
        var dataRoot = args.dataRoot || "";
        if (!dataRoot || !_ensureUnderRoot(targetFolder, dataRoot)) {
            throw new Error("目标目录不在数据目录下，拒绝执行: " + targetFolder);
        }

        // 1. 先保存原工程回原路径，再 save 副本到数据目录 temp（panel 传 tempDir）
        _emitProgress("正在保存临时副本…");
        if (app.project.file) app.project.save();
        var tempDir = args.tempDir || "";
        if (!tempDir || !_ensureUnderRoot(tempDir, dataRoot)) {
            throw new Error("临时目录未指定或不在数据目录下，拒绝执行");
        }
        var tempFolder = new Folder(tempDir);
        if (!tempFolder.exists) tempFolder.create();  // 防御性兜底（panel 侧 AEFS.mkdir 已建）
        var tempPath = tempDir + "/" + tempName;
        tempFile = new File(tempPath);
        app.project.save(tempFile);
        if (!tempFile.exists) throw new Error("保存临时副本失败: " + tempPath);

        // 2. 切到副本工程
        _emitProgress("正在打开副本工程（大工程可能较慢）…");
        app.beginSuppressDialogs();
        suppressStarted = true;
        var tempProj = app.open(tempFile);
        if (!tempProj) throw new Error("打开临时副本失败");

        // 3. 找目标合成
        // 优先按 Item.id 定位（稳定键）——按名查找在"工程里有两个同名合成"时会静默取到
        // 前一个（保存合成路径没有图层 id 兜底，导出件会整个错）。id 与图层 id 同理跨保存/重载
        // 不变；旧面板没传 compId（0）或引擎无 itemByID 时退回按名查找（原行为）。
        _emitProgress("正在定位目标合成…");
        var targetComp = null;
        var compIdArg = Number(args.compId);
        if (compIdArg > 0 && typeof app.project.itemByID === "function") {
            try {
                var _byId = app.project.itemByID(compIdArg);
                if (_byId instanceof CompItem) targetComp = _byId;
            } catch (_) { targetComp = null; }
        }
        if (!targetComp) {
            for (var i = 1; i <= app.project.numItems; i++) {
                var item = app.project.item(i);
                if (item instanceof CompItem && item.name === compName) { targetComp = item; break; }
            }
        }
        if (!targetComp) throw new Error("副本中找不到合成: " + compName + (compIdArg > 0 ? "（id=" + compIdArg + "）" : ""));

        // 4. 图层导出：预合成选中的图层（多个一起打包）
        // 寻址协议：面板直传选中图层「id」layerIds（assets_getActiveComp 的
        // selectedLayerIds）——id 是稳定键（Layer.id 官方口径："当项目保存到文件并稍后重新
        // 加载时，ID 的值保持不变"），而 index 是层叠位置：删/加/重排图层都会移位，面板读取
        // 与 host 在副本里执行之间隔着一整轮 save/open（还有确认框），期间用户动过图层就会
        // 张冠李戴。id 在副本里重新解析 → 取「当下」的 index 去 precompose。
        // 降级链：layerIds（稳定）→ layerIndices（位置键，仅旧 host/旧 AE 用）→
        // layerNames（同名层无法区分，只能整批；仅旧面板用）。
        // 图层名协议：面板侧传 JSON.stringify(图层名数组)——AE 图层名（PSD/AI 导入）可含逗号，
        // 逗号 join/split 必坏；json2.jsx 已最先加载，引擎有 JSON.parse。
        // 解析失败（旧版面板逗号串）退回逗号 split 兜底。
        var layerNames = args.layerNames || args.layerName || "";
        var layerIdxArg = args.layerIndices;
        var layerIdArg = args.layerIds;
        var isLayerExport = false;
        var indices = [];
        var _hasLayerByID = false;
        try { _hasLayerByID = (typeof app.project.layerByID === "function"); } catch (_) {}
        if (_hasLayerByID && layerIdArg && typeof layerIdArg.length === "number" && layerIdArg.length > 0) {
            _emitProgress("正在预合成图层…");
            isLayerExport = true;
            var _badIds = [];
            var _compId = targetComp.id;
            for (var li = 0; li < layerIdArg.length; li++) {
                var _lid = Number(layerIdArg[li]);
                var _ly = null;
                try { _ly = app.project.layerByID(_lid); } catch (_) { _ly = null; }
                var _inComp = false;
                try { _inComp = !!(_ly && _ly.containingComp && _ly.containingComp.id === _compId); } catch (_) {}
                if (_inComp) {
                    // 用解析当刻的 index（不是面板发来的位置）
                    if (!_arrContains(indices, _ly.index)) indices.push(_ly.index);
                } else { _badIds.push(String(layerIdArg[li])); }
            }
            // fail-closed：图层被删/被移出该合成即报错——绝不静默换层（导出错层比失败更糟）
            if (_badIds.length) {
                throw new Error("图层 id 在副本工程中找不到或不属于目标合成（导出期间图层被改动？）: " + _badIds.join(", "));
            }
        } else if (layerIdxArg && typeof layerIdxArg.length === "number" && layerIdxArg.length > 0) {
            _emitProgress("正在预合成图层…");
            isLayerExport = true;
            var _badIdx = [];
            for (var lj = 0; lj < layerIdxArg.length; lj++) {
                var _lv = Number(layerIdxArg[lj]);
                if (_lv >= 1 && _lv <= targetComp.numLayers && Math.floor(_lv) === _lv) {
                    if (!_arrContains(indices, _lv)) indices.push(_lv);
                } else { _badIdx.push(String(layerIdxArg[lj])); }
            }
            // fail-closed：面板索引取自同一 .aep 的副本，必在范围内；越界即状态异常，
            // 宁可报错也不静默换层（导出错层比导出失败更糟）
            if (_badIdx.length) throw new Error("图层索引超出范围（副本合成共 " + targetComp.numLayers + " 层）: " + _badIdx.join(", "));
        } else if (layerNames) {
            _emitProgress("正在预合成图层…");
            isLayerExport = true;
            var names;
            try { names = JSON.parse(layerNames); } catch (_) { names = layerNames.split(","); }
            var missing = [];
            for (var n = 0; n < names.length; n++) {
                var ln = names[n];
                var found = false;
                // 同名图层收集全部匹配索引（不再首个命中即 break）——AE 中
                // 复制图层同名极常见，旧逻辑把两个同名条目都解析到第一个匹配层，
                // precompose([i,i]) 重复索引报错或第二个图层静默漏出导出件。
                // 本分支降级为回退路径（面板已直传索引），仅名字可用时同名层只能整批。
                for (var j = 1; j <= targetComp.numLayers; j++) {
                    if (targetComp.layer(j).name === ln) { indices.push(targetComp.layer(j).index); found = true; }
                }
                if (!found) missing.push(ln);
            }
            // 去重：同名多次传入会重复收集同一批索引
            var _seen = {};
            var _uniq = [];
            for (var ui = 0; ui < indices.length; ui++) {
                if (!_seen[indices[ui]]) { _seen[indices[ui]] = 1; _uniq.push(indices[ui]); }
            }
            indices = _uniq;
            if (missing.length) throw new Error("副本中找不到图层: " + missing.join(", "));
        }
        if (isLayerExport) {
            if (!indices.length) throw new Error("未找到任何目标图层");
            var precompName = "_export_layers_" + (new Date().getTime());
            var precomp = targetComp.layers.precompose(indices, precompName);
            if (!precomp) throw new Error("图层预合成失败");
            targetComp = precomp;
        }

        // 5. reduceProject：保留目标合成，删未使用素材
        _emitProgress("正在精简工程素材…");
        var removed = app.project.reduceProject([targetComp]);

        // 5b.：图层导出件里的合成名改成素材条目名——内部名 _export_layers_<ts> 会随 .aep
        // 泄漏给用户（面板工程列表 / 导入回 AE 的合成名）。reduceProject 已移除源合成，条目名
        // 此刻无冲突（真重名时 AE 自行加后缀，响应 compName 回传实际生效名）。
        // 仅图层路径改名：保存合成时合成名是用户自己的，原样保留。
        if (isLayerExport) {
            try { targetComp.name = String(args.outName || compName); } catch (_) {}
        }

        // 6. 手工收集素材（可选）+ save 到目标目录
        //    AE 23.5 移除了 collectFiles，自己遍历 FootageItem 复制源文件并替换引用
        var collected = 0, skipped = 0;
        var unredirected = [];  // 分图层素材：保留原引用未重定向（避免合并），供面板提示
        // 分图层 PSD/AI 兜底副本复制失败的源文件名（同 exportWholeProject，
        // ExtendScript File.copy 失败返 false 不抛异常，失败经本字段如实上报）
        var copyFailed = [];
        if (collectAssets) {
            _emitProgress("正在收集素材…");
            var target = new Folder(targetFolder);
            if (!target.exists) {
                var parentOk = target.create();
                if (!parentOk) throw new Error("无法创建目标目录: " + targetFolder);
            }
            var footageDir = new Folder(targetFolder + "/footage");
            if (!footageDir.exists) footageDir.create();

            // 预统计：同一源文件被多少 FootageItem 引用。refCount > 1 = PSD/AI 分图层导入
            // （每层一个 FootageItem，mainSource.file 都指向同一源文件）。
            // 分图层 footage 的 FileSource.file 是 readOnly（实测 AE 23.5 抛"readOnly"属性错误），
            // replace(file) 会用默认设置重新解析 → 合并图层。两条路都无法保留图层改路径，
            // AE 也没提供其他 API（ImportOptions 无图层选择，collectFiles 23.5 已移除）。
            // 这类 footage 只复制源文件、不重定向引用，保留分图层。
            // 代价：.aep 里该素材仍指向原路径，非自包含（文件已复制到 footageDir，可手动重链）。
            var fileRefCount = {};
            for (var i = 1; i <= app.project.numItems; i++) {
                try {
                    var _it = app.project.item(i);
                    if (!(_it instanceof FootageItem)) continue;
                    var _ms = _it.mainSource;
                    if (!_ms || !_ms.file || !_ms.file.exists) continue;
                    var _key = String(_ms.file.fsName);
                    fileRefCount[_key] = (fileRefCount[_key] || 0) + 1;
                } catch (_) {}
            }
            // 预统计需转 PNG 的 FootageItem 数量（每个分图层 footage 单独转一次），供进度条显示 N/T
            var psdTotal = 0;
            if (collectPsD) {
                for (var i = 1; i <= app.project.numItems; i++) {
                    try {
                        var _pit = app.project.item(i);
                        if (!(_pit instanceof FootageItem)) continue;
                        var _pms = _pit.mainSource;
                        if (!_pms || !_pms.file || !_pms.file.exists) continue;
                        // 后缀双重条件（与 isLayered 判定同口径，进度计数不错位）
                        var _psdKey = String(_pms.file.fsName);
                        var _psdDot = _psdKey.lastIndexOf(".");
                        var _psdExt = _psdDot >= 0 ? _psdKey.substring(_psdDot).toLowerCase() : "";
                        if ((fileRefCount[_psdKey] || 0) > 1 && (_psdExt === ".psd" || _psdExt === ".ai")) psdTotal++;
                    } catch (_) {}
                }
            }
            var psdDone = 0;  // 当前正在处理第几个（1-indexed，转换前递增）
            // 同名去重映射（同 exportWholeProject，见其声明处注释）
            // 映射键统一 toLowerCase 折叠（同 exportWholeProject，见其普通素材分支注释）
            var copiedByName = {};

            for (var i = 1; i <= app.project.numItems; i++) {
                try {
                    var it = app.project.item(i);
                    if (!(it instanceof FootageItem)) continue;
                    var ms = it.mainSource;
                    if (!ms || !ms.file || !ms.file.exists) { skipped++; continue; }
                    var src = ms.file;
                    var srcKey = String(src.fsName);
                    // 后缀双重条件——refCount>1 也在「同一文件被导入两次」时成立
                    //（同 exportWholeProject，见其注释）
                    var _srcDot = srcKey.lastIndexOf(".");
                    var _srcExt = _srcDot >= 0 ? srcKey.substring(_srcDot).toLowerCase() : "";
                    var isLayered = (fileRefCount[srcKey] || 0) > 1 && (_srcExt === ".psd" || _srcExt === ".ai");  // 分图层导入
                    if (isLayered) {
                        if (collectPsD) {
                            // 转 PNG，footage 改指向 footageDir 下的 PNG（不需要 PSD 副本）
                            psdDone++;
                            _emitProgressObj({
                                message: "PSD 转 PNG: " + it.name,
                                progress: psdTotal > 0 ? Math.round(psdDone / psdTotal * 100) : 100,
                                progressLabel: psdDone + "/" + psdTotal
                            });
                            if (_psdFootageToPng(it, footageDir, copiedByName)) collected++;
                            else { if (!_arrContains(unredirected, src.name)) unredirected.push(src.name); skipped++; }
                        } else {
                            // 不转 PNG：复制 PSD 到 footageDir 供手动重链，footage 保留原引用
                            // 素材名过 _sanitizeFileName——含 %/' 等字符的落盘文件会让后续 AEFS 操作全被拒
                            // 同 exportWholeProject——copy 返回值 + exists 双验证，
                            // 失败（含 catch）记入 copyFailed 回执，不再静默丢失兜底副本
                            // 1b：同 exportWholeProject——exists 复核重新取对象（陈旧 File
                            // 对象会把成功拷贝误判为失败），psdCopyOk 双验证语义不变
                            var psdDst = footageDir.fsName + "/" + _sanitizeFileName(src.name);
                            var psdDstFile = new File(psdDst);
                            if (!psdDstFile.exists) {
                                var psdCopyOk = false;
                                try { psdCopyOk = src.copy(psdDst); } catch (_) { psdCopyOk = false; }
                                if (!psdCopyOk || !new File(psdDst).exists) {
                                    if (!_arrContains(copyFailed, src.name)) copyFailed.push(src.name);
                                }
                            }
                            if (!_arrContains(unredirected, src.name)) unredirected.push(src.name);
                            skipped++;
                        }
                        continue;
                    }
                    // 普通素材：复制 + 改引用
                    // 素材名过 _sanitizeFileName——含 %/' 等字符的落盘文件会让后续 AEFS 操作全被拒
                    // 同名碰撞走序号后缀（同 exportWholeProject）
                    // 映射键统一 toLowerCase（同 exportWholeProject，见其普通素材分支注释）
                    var sName = _sanitizeFileName(src.name);
                    if (copiedByName[sName.toLowerCase()] && copiedByName[sName.toLowerCase()] !== srcKey) {
                        var dotAt = sName.lastIndexOf(".");
                        var stem = dotAt > 0 ? sName.substring(0, dotAt) : sName;
                        var ext = dotAt > 0 ? sName.substring(dotAt) : "";
                        var n = 2;
                        while (copiedByName[(stem + "_" + n + ext).toLowerCase()] && copiedByName[(stem + "_" + n + ext).toLowerCase()] !== srcKey) n++;
                        sName = stem + "_" + n + ext;
                    }
                    // 登记前捕获「当前轮是否已拷过同源」——登记后 copiedByName 键值恒等于
                    // srcKey，跳过判定必须用捕获值（键折叠，与查重/登记同一键空间）
                    var sKey = sName.toLowerCase();
                    var sameSourceCopied = copiedByName[sKey] === srcKey;
                    copiedByName[sKey] = srcKey;
                    var dstPath = footageDir.fsName + "/" + sName;
                    var dstFile = new File(dstPath);
                    // 仅「同轮同源已拷过且目标在场」才跳过复制（去重优化保留）；
                    // 其余情况（首轮遇磁盘同名残留 / 源原地更新后的重导出）无条件重拷——
                    // 旧「目标存在即跳过」在面板确认覆盖再导出时不清理旧 footage：源原地
                    // 更新后陈旧副本被复用，跨轮同名源互换时素材张冠李戴（消灭的
                    // 错接在跨轮复活）。remove 失败不阻断（旧文件删不掉时 copy 行为由引擎
                    // 决定，事后双验证兜底）；copy 返回值与 exists 双验证（ExtendScript copy
                    // 失败返 false），失败保持既有 skipped 跳过语义
                    if (!dstFile.exists || !sameSourceCopied) {
                        // （AEFS 删除审计）：ES 侧没有 AEFS，这条「清旧再拷」的删除用 _ensureUnderRoot
                        // 复刻 AEFS 的 _checkPath + 容器判定（拒 %/控制字符/引号/DOS 设备名/.. 段，且必须是
                        // footageDir 的子路径）——越界只记日志不删：后续 copy 照旧走返回值 + exists 双验证，
                        // 失败保持 skipped 语义，不存在静默覆盖。
                        if (dstFile.exists) {
                            if (_ensureUnderRoot(dstPath, footageDir.fsName)) { try { dstFile.remove(); } catch (_) {} }
                            else $.writeln("[AS_ExtP] 拒删 footage 目录外的同名残留: " + dstPath);
                        }
                        var copyOk = false;
                        try { copyOk = src.copy(dstPath); } catch (_) { copyOk = false; }
                        if (!copyOk || !dstFile.exists) { skipped++; continue; }
                    }
                    // 普通素材：ms.file= 优先，replace 回退
                    try {
                        ms.file = dstFile;
                        collected++;
                    } catch (_) {
                        try {
                            it.replace(dstFile);
                            collected++;
                        } catch (_) { skipped++; }
                    }
                } catch (_) { skipped++; }
            }
            // PSD 阶段结束：清除进度条，切回纯文本阶段
            if (psdTotal > 0) _emitProgressObj({ message: "素材收集完成: " + collected + " / " + (collected + skipped), progress: null });
            else _emitProgress("素材收集完成: " + collected + " / " + (collected + skipped));
        } else {
            _emitProgress("跳过素材收集…");
        }

        // 7. save .aep
        _emitProgress("正在保存…");
        // 消毒仅用于拼输出文件名；上方"按原名查找合成"仍用原始 compName，查找行为不变。
        // outName：panel 已消毒的最终条目名（_autoName 会取基名/替换 % 等）——优先用它拼文件名，
        // 保证 .aep 文件名与索引条目名一致（否则每次 load 都触发标准化幽灵改名；
        // 且 compName 含 % 时此处若不消毒，落盘文件名会让 AEFS _checkPath 拒绝后续操作）
        var aepName = _sanitizeFileName(args.outName || compName) + ".aep";
        var outputPath = targetFolder + "/" + aepName;
        // save 前记录旧文件状态（同 exportWholeProject，判据见 _verifySavedAep）——
        // 重复导出时 save 静默失败会让旧残留 .aep 被报 success
        var _aepTarget = new File(outputPath);
        var _preExists = false, _preLen = 0, _preMod = 0;
        try {
            _preExists = !!_aepTarget.exists;
            if (_preExists) { _preLen = _aepTarget.length; if (_aepTarget.modified) _preMod = _aepTarget.modified.getTime(); }
        } catch (_) {}
        app.project.save(_aepTarget);

        app.endSuppressDialogs(false);
        suppressStarted = false;

        // 分档核查（同 exportWholeProject 尾部形态）
        var _postAep = new File(outputPath);
        var ok = _verifySavedAep(_preExists, _preLen, _preMod, _postAep);
        return JSON.stringify({
            status: ok ? "success" : "error",
            targetFolder: targetFolder,
            compName: targetComp.name,   // 导出件里的实际合成名（图层路径 = 条目名）
            aepPath: ok ? outputPath : "",
            tempPath: tempPath,
            removedItems: removed,
            aepSize: ok ? _postAep.length : 0,
            unredirected: unredirected,  // 分图层素材保留原引用的文件名列表
            copyFailed: copyFailed,      // 分图层 PSD/AI 兜底副本复制失败的源文件名
            message: ok ? "" : "保存 .aep 失败"
        });
    } catch (e) {
        // 只关 suppress，不主动 app.open 回切——回切统一交给 panel 的 restoreProject。
        // 否则失败路径原工程会被 open 两次（jsx 一次 + panel catch 一次），大工程重复加载明显卡顿。
        // 原 panel 那次 restore 不能省（jsx 在 suppressStarted=false 时本就不 restore），故这里去掉 jsx 这次，
        // 成功/失败路径都只 open 一次。原工程导出前已 save，panel 收到 error 到调 restore 期间 _busy 锁住用户操作。
        if (suppressStarted) {
            try { app.endSuppressDialogs(false); } catch (_) {}
        }
        // 临时副本的删除交给面板侧 AEFS（tempPath 一并返回；面板 catch 经 _call 的 err.detail 取出后走 AEFS.deleteFile），
        // 不在 jsx 里裸 File.remove——遵循"数据目录/临时文件 IO 走 AEFS"。
        return JSON.stringify({ status: "error", message: e.toString(), tempPath: typeof tempPath !== "undefined" ? tempPath : "" });
    } finally {
        $_exporting = false;
    }
}

// ── 回切原工程（导出后恢复用户工程）──
// args: { originalPath: "C:/work/my.aep" }
function restoreProject(args) {
    var suppressStarted = false;
    // 防 panel 超时后排队的 restoreProject：若 exportCompOrLayer 仍在跑，此刻用户可能已手动切工程
    // 并做了未保存工作，自动 app.open 经 suppressDialogs 会静默丢弃。拒绝执行，让 panel 提示手动打开。
    if ($_exporting) {
        return JSON.stringify({ status: "error", message: "导出仍在进行中，已跳过自动回切——请在导出完成后手动打开原工程" });
    }
    try {
        if (!args) args = {};
        var origStr = args.originalPath || "";
        if (!origStr) throw new Error("originalPath 必填");
        var origFile = new File(origStr);
        if (!origFile.exists) throw new Error("原工程不存在: " + origStr);
        app.beginSuppressDialogs();
        suppressStarted = true;
        var restored = app.open(origFile);
        app.endSuppressDialogs(false);
        suppressStarted = false;
        return JSON.stringify({ status: restored ? "success" : "error", originalPath: origStr, message: restored ? "" : "回切失败" });
    } catch (e) {
        if (suppressStarted) { try { app.endSuppressDialogs(false); } catch (_) {} }
        return JSON.stringify({ status: "error", message: e.toString() });
    }
}

// ── 获取当前活动/选中的合成 + 选中图层（不弹列表，直接读 activeItem/selection）──
// 注意：函数名不能叫 getActiveComp——aeTools.jsx 有同名函数，会被覆盖
function assets_getActiveComp(args) {
    try {
        if (!args) args = {};
        // 优先用时间轴中打开的合成
        var activeItem = app.project.activeItem;
        if (activeItem && activeItem instanceof CompItem) {
            var selLayers = [];
            var selLayerIndices = [];
            var selLayerIds = [];
            try {
                var sl = activeItem.selectedLayers || [];
                for (var k = 0; k < sl.length; k++) {
                    selLayers.push(sl[k].name);
                    selLayerIndices.push(sl[k].index);
                    // 稳定键——index 是层叠位置（删/加/重排图层会移位），id 跨保存/重载不变
                    // （Layer.id 官方口径："当项目保存到文件并稍后重新加载时，ID 的值保持不变"）。
                    // id 读取单独 try：某层取不到 id（旧 AE）时该位记 0，不让异常截断
                    // names/indices 造成三数组错位（错位会让面板把选中层数看少 → 少导出层）。
                    // 面板按"长度一致 + 全为正整数"守卫整批丢弃 ids → 自动退回索引路径。
                    var _lid = 0;
                    try { _lid = sl[k].id; } catch (_) { _lid = 0; }
                    if (!(_lid > 0)) _lid = 0;
                    selLayerIds.push(_lid);
                }
            } catch (_) {}
            // 不再清理合成名控制字符——导出链路（exportCompOrLayer）按名全等匹配，
            // 清理后「A\nB」变「AB」，与副本工程里的原名必然失配、误报「副本中找不到合成」；
            // 返回走 JSON.stringify（控制字符自动转义）、入参走 JSON 参数通道保真，直接用原名
            //（对齐下方 Project 面板 selection 路径直接取 comps[0].name 的做法）
            var compName = String(activeItem.name);
            // 合成 id（稳定键）——同名合成并存时按名查找会取错那个（导出件整个错）
            var compId = 0;
            try { compId = activeItem.id; } catch (_) { compId = 0; }
            if (!(compId > 0)) compId = 0;
            return JSON.stringify({
                status: "success",
                compName: compName,
                compId: compId,
                width: activeItem.width,
                height: activeItem.height,
                selectedLayers: selLayers,
                // 选中图层索引（与 selectedLayers 同序同快照）——面板按索引寻址，
                // 同名图层不再被整批带走
                selectedLayerIndices: selLayerIndices,
                // 选中图层 id（稳定键，首选）；面板与 host 之间隔着 save/open 与确认框，
                // 位置键（index）在期间被用户改动图层就会错位
                selectedLayerIds: selLayerIds
            });
        }
        // 其次用 Project 面板选中的合成
        var sel = app.project.selection || [];
        var comps = [];
        for (var i = 0; i < sel.length; i++) {
            if (sel[i] instanceof CompItem) comps.push(sel[i]);
        }
        if (comps.length === 1) {
            var compId1 = 0;
            try { compId1 = comps[0].id; } catch (_) { compId1 = 0; }
            if (!(compId1 > 0)) compId1 = 0;
            return JSON.stringify({
                status: "success",
                compName: comps[0].name,
                compId: compId1,
                width: comps[0].width,
                height: comps[0].height,
                selectedLayers: [],
                selectedLayerIndices: [],
                selectedLayerIds: []
            });
        }
        if (comps.length > 1) {
            return JSON.stringify({ status: "error", message: "项目面板选中了 " + comps.length + " 个合成：请只选中要保存的那一个" });
        }
        // 选中项不是合成时给出具体原因——旧文案一律"未找到合成，请在时间轴中打开或选中一个合成"，
        // 用户实测在项目面板选中的是文件夹，被告知去时间轴打开合成，与实际操作对不上。
        if (sel.length) {
            var selNames = [];
            var _cap = sel.length > 3 ? 3 : sel.length;
            for (var si = 0; si < _cap; si++) { if (sel[si] && sel[si].name) selNames.push(String(sel[si].name)); }
            var _selDesc = selNames.join("、") + (sel.length > 3 ? " 等 " + sel.length + " 项" : "");
            return JSON.stringify({
                status: "error",
                message: "项目面板选中的不是合成（" + _selDesc + "）：请选中要保存的合成，或在时间轴中打开它"
            });
        }
        return JSON.stringify({ status: "error", message: "请在项目面板选中要保存的合成（或在时间轴中打开一个合成）" });
    } catch (e) {
        return JSON.stringify({ status: "error", message: e.toString() });
    }
}

// ── 列当前工程合成（供 UI 选目标）──
function listProjectComps(args) {
    try {
        if (!args) args = {};
        var comps = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem) {
                comps.push({ name: item.name, width: item.width, height: item.height, duration: item.duration, numLayers: item.numLayers });
            }
        }
        return JSON.stringify({ status: "success", compositions: comps });
    } catch (e) {
        return JSON.stringify({ status: "error", message: e.toString() });
    }
}

// ── 列某合成的图层（供 UI 选目标图层）──
function listCompLayers(args) {
    try {
        if (!args) args = {};
        var compName = args.compName || "";
        var comp = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.name === compName) { comp = item; break; }
        }
        if (!comp) throw new Error("找不到合成: " + compName);
        var layers = [];
        for (var j = 1; j <= comp.numLayers; j++) {
            var l = comp.layer(j);
            layers.push({ index: j, name: l.name, typeName: l.typeName || "" });
        }
        return JSON.stringify({ status: "success", layers: layers });
    } catch (e) {
        return JSON.stringify({ status: "error", message: e.toString() });
    }
}
