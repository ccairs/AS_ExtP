(function (global) {
    var COMFYUI_DEFAULTS = {
        host: '127.0.0.1',
        port: 8188,
        outputSubfolder: '_comfyui_output',
        // 工作流目录不再可配（固定为 resolveWorkflowDir()，见下）：用户任选目录与
        // AEFS 写入白名单冲突（读得到写不进）。历史存量 workflowDir 设置键不再被读取，
        // 残留值随 settings 对象回来也无影响（不做迁移清理）。
        apiKey: '',
        defaultTemplate: 'txt2img'
    };

    // 从 ComfyUI 返回的 filename 提取扩展名，白名单 [\w]+。
    // ext 会拼进 ExtendScript new File("..."+ext)，若含引号/路径分隔符可逃逸字符串注入命令。
    // 正常 ComfyUI 输出扩展名（png/jpg/webp/mp4/gif/webm 等）均为 \w+，非法值 fallback 到 'bin'。
    function _safeExt(filename) {
        var ext = String(filename || '').split('.').pop().toLowerCase();
        return /^[\w]+$/.test(ext) ? ext : 'bin';
    }

    // 文件名去重：若 outputDir\fileName 已存在，追加 _1/_2/... 后缀直到不冲突。
    // 例: "ComfyUI_x_001.png" → "ComfyUI_x_001_1.png" → "ComfyUI_x_001_2.png"
    // 防止同节点多次导出/同 promptId 重试覆盖既有文件。
    function _dedupeFileName(outputDir, fileName) {
        var dotIdx = fileName.lastIndexOf('.');
        var stem = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
        var ext = dotIdx > 0 ? fileName.slice(dotIdx) : '';
        var candidate = fileName;
        var n = 1;
        while (n < 10000 && typeof AEFS !== 'undefined' && AEFS.existsSync &&
            AEFS.existsSync(outputDir + '\\' + candidate)) {
            candidate = stem + '_' + n + ext;
            n++;
        }
        return candidate;
    }

    // 本项目资产库子文件夹：<当前 AE 工程目录>\_comfyui_assets。
    // 生成产物默认落数据目录 temp\comfyui-output（滚动裁剪 + 按龄/预算回收）；
    // 要长期保留的由调用方显式转存到这里。固定在工程文件同目录：工程搬家时资产库跟着走，
    // 工程未保存则无"本项目"可言（显式失败，不回落数据目录）。
    // 工程目录不在 AEFS SAFE_NAMESPACES 内 ⇒ 目录用 AEFS.mkdir 预建（mkdir 只过 _checkPath），
    // 文件复制/移动走 ExtendScript File（与 importToAE / saveOnly / 工程素材导出同一条宿主通道）；
    // 不扩白名单、不新增 Bridge 路由。
    var PROJECT_ASSET_SUBFOLDER = '_comfyui_assets';

    // 表单生成图片上传的单文件超时（ms，每文件 120s）。uploadImage 的
    // fetch 无超时——服务器 accept 后响应停滞时 Promise 永不 settle，_isGenerating
    // 恒 true 锁死后续所有表单生成（超时解锁定时器在全部上传完成后才启动，
    // 覆盖不到该窗口）。经 global.AEComfyUI.uploadImageTimeoutMs 可注入覆盖（单测用）。
    var UPLOAD_IMAGE_TIMEOUT_MS = (global.AEComfyUI && typeof global.AEComfyUI.uploadImageTimeoutMs === 'number')
        ? global.AEComfyUI.uploadImageTimeoutMs : 120000;

    // uploadImage 包 Promise.race 超时——超时 reject '图片上传超时'，
    // 异常走 generate 既有 catch 释放 _isGenerating
    // race 结束（成功/失败任一先到）即 clearTimeout——否则超时定时器
    // 存活至 120s 到点触发 no-op reject，反复上传时短暂堆积无用定时器（到时自清，
    // 无功能影响，属资源瑕疵）
    function _uploadImageWithTimeout(service, blob, filename) {
        var t = null;
        var timeoutP = new Promise(function (_, reject) {
            t = setTimeout(function () { reject(new Error(AEI18n.t('图片上传超时'))); }, UPLOAD_IMAGE_TIMEOUT_MS);
        });
        return Promise.race([service.uploadImage(blob, filename), timeoutP])
            .finally(function () { clearTimeout(t); });
    }

    // 校验用户设置的 outputSubfolder，与 AEFS _checkPath 字符集对齐。
    // 拒 %/控制字符/引号/路径分隔符/.. /.段/DOS 设备名，非法时回退默认值。
    // subfolder 会拼进 outputDir = dir + '\\' + subfolder，若含非法字符 _checkPath 拒绝导致 mkdir 失败。
    function _sanitizeSubfolder(s) {
        var s = String(s || '');
        if (!s) return '_comfyui_output';
        if (s.indexOf('%') !== -1) return '_comfyui_output';
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c <= 0x1F || c === 0x7F || c === 0x22 || c === 0x27) return '_comfyui_output';
        }
        if (/[\/\\:$*?<>|]/.test(s)) return '_comfyui_output';
        if (s === '.' || s === '..') return '_comfyui_output';
        var upper = s.replace(/\..*$/, '').toUpperCase();
        if (upper === 'NUL' || upper === 'CON' || upper === 'PRN' || upper === 'AUX' ||
            /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) return '_comfyui_output';
        return s;
    }

    // 工作流目录固定为数据根下 comfyui\workflows（comfyui / workflows 两段均在 AEFS
    // SAFE_NAMESPACES 内 → writeFileSync 白名单放行）。目录不再来自设置：用户任选路径
    // 与写入白名单冲突（读得到写不进），故设置项已删（见 COMFYUI_DEFAULTS 注）。
    function resolveWorkflowDir() {
        try {
            if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                var d = global.AEShared.getDataDir();
                var base = (d && d.dir) ? String(d.dir).replace(/[\\\/]+$/, '') : '';
                return base ? (base + '\\comfyui\\workflows') : '';
            }
        } catch (_) {}
        return '';
    }

    // 校验导入工作流的文件名后再拼路径（对齐 _sanitizeSubfolder / AEFS _checkPath）：
    // 拒 %/控制字符/引号/路径分隔符/Windows 非法字符/.. 段/DOS 设备名，非法时返回 null。
    // （原居 view.js——安全闸不该由视图层持有，随导入落盘一并移到 controller。）
    function _safeWorkflowFileName(name) {
        var n = String(name || '');
        if (!n || n.indexOf('%') !== -1) return null;
        for (var i = 0; i < n.length; i++) {
            var c = n.charCodeAt(i);
            if (c <= 0x1F || c === 0x7F) return null;
            if (c === 0x22 || c === 0x27) return null;
        }
        if (/[\\\/\:\*\?\"\<\>\|]/.test(n)) return null;
        if (n === '.' || n === '..') return null;
        var upper = n.replace(/\..*$/, '').toUpperCase();
        if (upper === 'NUL' || upper === 'CON' || upper === 'PRN' || upper === 'AUX' ||
            /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) return null;
        return n;
    }

    // AEFS Result 错误码读取。真实形态是 {ok:false, error:{code,message,channel}}
    //（aefs.js _resultErr 单点构造）；顶层 code 形态只在旧 mock/薄适配层出现，一并接受。
    // 读错形状会把 NOT_FOUND 判定变成死分支——真机复现：工作流目录首读（目录还不存在）
    // 因错误码读成 undefined 而不建目录，随后首次导入落盘因父目录缺失全通道失败。
    function _resultCode(r) {
        if (!r || typeof r !== 'object') return '';
        if (r.error && r.error.code) return String(r.error.code);
        return r.code ? String(r.code) : '';
    }
    // Result 的错误说明文本（同样是 error.message 优先，兼容顶层 message）
    function _resultMessage(r) {
        if (!r || typeof r !== 'object') return '';
        if (r.error && r.error.message) return String(r.error.message);
        return r.message ? String(r.message) : '';
    }

    // 工作流目录链（<数据根>\comfyui\workflows → …\originals）：数据根到目标之间**每一段**
    // 都是要建的候选（数据根本身已存在，不重复建）。拿不到数据根时退化为只建目标本身。
    function _workflowDirLevels(dir) {
        var fwd = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (!fwd) return [];
        var base = '';
        try {
            if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                var d = global.AEShared.getDataDir();
                base = (d && d.dir) ? String(d.dir).replace(/\\/g, '/').replace(/\/+$/, '') : '';
            }
        } catch (_) {}
        var levels = [];
        // 前缀比较按长度切片后小写折叠（同 dataDir.js _rebaseStrUnderRoot 手法：少数 Unicode
        // 字符折叠会改变长度，整串折叠后再切片会错位）
        var underBase = !!base && fwd.length > base.length && fwd.charAt(base.length) === '/' &&
            fwd.slice(0, base.length).toLowerCase() === base.toLowerCase();
        if (underBase) {
            var cur = fwd.slice(0, base.length).replace(/\//g, '\\');
            var segs = fwd.slice(base.length + 1).split('/');
            for (var i = 0; i < segs.length; i++) {
                if (!segs[i]) continue;
                cur = cur + '\\' + segs[i];
                levels.push(cur);
            }
        } else if (base && fwd.toLowerCase() === base.toLowerCase()) {
            return [];   // 目标就是数据根本身（不该发生）：无需建
        } else {
            levels.push(String(dir).replace(/\//g, '\\').replace(/\\+$/, ''));
        }
        var last = levels.length ? levels[levels.length - 1] : '';
        if (last) levels.push(last + '\\originals');
        return levels;
    }

    // 逐级建目录（串行，父先于子）。
    // 为什么逐级而不是一次建到底：本机 CEP 版本没有 cep.fs.mkdir（真机 panel.log：
    // 「mkdir cep.fs.mkdir 不可用，切 ExtendScript」实测），回退的
    // ExtendScript Folder.create 只建单层——一次建多级会失败，之后写文件因父目录不存在
    // 而全通道失败（真机复现：导入工作流报「写入失败（磁盘或权限）」）。
    // 串行而非并发：并发时子目录可能先于父目录执行，同样失败。任一失败不中断（目录可能已存在）。
    // @returns {Promise<boolean>} 目标目录是否已存在（拿不到 existsSync 时按 true 放行既有流程）
    function _ensureWorkflowDirs(dir) {
        var levels = _workflowDirLevels(dir);
        if (!levels.length) return Promise.resolve(false);
        var target = String(dir).replace(/\//g, '\\').replace(/\\+$/, '');
        var mk = function (p) {
            if (typeof AEFS === 'undefined' || !AEFS) return Promise.resolve(false);
            if (typeof AEFS.mkdir === 'function') {
                try {
                    return Promise.resolve(AEFS.mkdir(p)).then(function (ok) { return !!ok; },
                        function () { return false; });
                } catch (_) { return Promise.resolve(false); }
            }
            try {
                return Promise.resolve(typeof AEFS.mkdirSync === 'function' ? !!AEFS.mkdirSync(p) : false);
            } catch (_) { return Promise.resolve(false); }
        };
        return levels.reduce(function (p, lv) {
            return p.then(function () { return mk(lv); });
        }, Promise.resolve(true)).then(function () {
            try {
                return (typeof AEFS.existsSync === 'function') ? !!AEFS.existsSync(target) : true;
            } catch (_) { return true; }
        });
    }

    function createComfyUIController(context) {
        var ctx = context || {};
        var settingsStore = ctx.settingsStore;
        var hostApi = ctx.hostApi;
        var service = null;
        var engine = null;
        var currentTemplate = null;
        var currentResults = [];
        var _isGenerating = false;
        var _pendingBatchCount = 0;  // 批量生成剩余任务数（>1 时 onComplete 按 count 计数）
        var _ready = false;
        var _promptSources = {};  // { promptId: 'form'|'form-stale'|'canvas'|'llm' }（form-stale 见 _markFormSourcesStale）
        var _canvasProgressCb = null;  // 画布生成节点进度回调 { onProgress(pctStr), onExecuting(nodeName) }
        var _pendingTemplateId = null;  // selectTemplate 竞态保护：记录正在加载的模板 id
        var _donePrompts = {};      // 终态处理标记：WS 完成/错误事件与 /history 轮询兜底并发去重
        var _historyGuards = {};    // promptId → /history 轮询定时器（WS 掉线时兜底）
        var _promptSourceTs = {};   // promptId → 登记时间戳（_pruneDonePrompts 在途保护用）
                                     // TTL 取 60min：大于全部路径的最长任务生命周期（画布 600s×3 视频档/
                                     // 表单批量 600s×N+60s/guard 兜底/LLM 视频 1980s），确保在途任务不被
                                     // 修剪误删，死条目（llm 终态事件永不到达等）超 TTL 后照常淘汰
        var _formGenTimeout = null; // 表单生成超时解锁定时器（完成事件丢失时不永久锁死）
        var _formGenEpoch = 0;     // 表单生成批次纪元——generate 入口自增，提交循环凭此识别
                                   // 自己已被错误解锁后的重入新批次取代（仅重检 _isGenerating 会被
                                   // 新批次的 true 蒙混）
        var _formCancelRequested = false; // 表单取消意图——view 取消点击处（发取消请求
                                   // 之前）经 requestFormBatchCancel 同步置位；提交循环凭此立即停止
                                   // 提交/登记新任务，不再依赖取消 HTTP 往返期间 settle 才生效。
                                   // generate 开批复位。
        var _modelRegistry = null; // modelRegistry 引用——切换端点时联动 clearSchemaCache
        var _initPromise = null;   // init 在途去重 + 失败可重试（见 init 包装说明）
        var _pendingUiWorkflows = [];   // UI 格式工作流待转换清单 [{path, name, raw}]：
                                        // init 期 ComfyUI 未就绪暂存，连接成功后补转换（见 _retryPendingUiWorkflows）
        var _workflowLoadFailures = []; // 最近一次目录加载的失败清单 [{name, message}]（getWorkflowLoadReport 暴露）
        var _retryPromise = null;       // 补转换在途去重（connect/onReconnect/testConnection 三处可并发触发）
        var _workflowNotices = [];      // 工作流加载/转换的用户可见提示队列——init 期 view 已存在但
                                        // 面板尚未 bind（showError 会因 panel=null 静默丢弃），先攒着，
                                        // bind 后由 view 拉取显示（见 flushWorkflowNotices / view.showWorkflowNotice）

        // ── /history 轮询兜底 ──
        // 生成完成仅靠 WS 事件：断线窗口内 ComfyUI 完成的 prompt 其完成事件不会重放
        // （重连成功也于事无补），画布侧挂满 600s 后误报"生成超时"，表单侧 _isGenerating
        // 永久锁死。提交后启动低频轮询（10s），发现终态（完成/失败）走与 WS 事件相同的
        // 处理入口（handleWsComplete / handleWsError）；WS 事件先到则停轮询。
        function _startHistoryGuard(promptId, maxAgeMs) {
            if (!promptId || !service || typeof service.getHistory !== 'function') return;
            if (_historyGuards[promptId]) return;
            var startedAt = Date.now();
            // maxAge 与调用方等待上限联动（默认 660s = 画布 600s + 余量）——
            // 表单批量总超时随 N 线性放大（600s×N+60s），固定 660s 上限使 guard 在
            // 第 2~N 张完成前就自停，深排队+WS 断线窗口下个别张数的 /history 兜底丢失；
            // 画布视频档（放宽至 1800s）同样经 maxAgeMs 联动
            var maxAge = maxAgeMs || 660000;
            _historyGuards[promptId] = setInterval(function () {
                if (Date.now() - startedAt > maxAge) { _stopHistoryGuard(promptId); return; }
                service.getHistory(promptId).then(function (history) {
                    if (!history || !history.status) return;  // 还在队列/执行中（history 未写入）
                    if (history.status.status_str === 'error' || history.status.completed === false) {
                        _stopHistoryGuard(promptId);
                        var data = { prompt_id: promptId, message: AEI18n.t('ComfyUI 执行失败') };
                        var msgs = history.status.messages || [];
                        for (var mi = 0; mi < msgs.length; mi++) {
                            if (msgs[mi] && msgs[mi][0] === 'execution_error' && msgs[mi][1]) {
                                data.exception_message = msgs[mi][1].exception_message || msgs[mi][1].exception_type || AEI18n.t('未知错误');
                                if (msgs[mi][1].node_type) data.node_type = msgs[mi][1].node_type;
                                break;
                            }
                        }
                        handleWsError(data);
                        return;
                    }
                    if (history.status.completed === true) {
                        _stopHistoryGuard(promptId);
                        handleWsComplete({ prompt_id: promptId });
                    }
                }).catch(function () { /* 网络失败：下轮再试 */ });
            }, 10000);
        }

        function _stopHistoryGuard(promptId) {
            if (_historyGuards[promptId]) {
                clearInterval(_historyGuards[promptId]);
                delete _historyGuards[promptId];
            }
        }

        // 终态标记条目上限：防止 _donePrompts 无限增长（FIFO 淘汰最旧）。
        // _promptSources 同步修剪——llm 来源不走 handleGenerationComplete
        // （无 delete 清理点），且其终态事件可能永不到达（WS 掉线时），映射只增不减。
        // _promptSources 修剪跳过在途任务——原 FIFO 删最旧不辨终态，200+ 任务
        // 后慢任务的来源映射被挤走：完成事件到达时 _src===undefined 被跳过 → 画布侧
        // 挂满 600s 误报"生成超时"、表单侧计数永不清零。在途判据 = 登记未满 TTL
        // （60min，见 _promptSourceTs 声明处）或 history guard 仍在轮询；死条目超
        // TTL 后照常淘汰，防无限增长的能力不回归。
        function _pruneDonePrompts() {
            var keys = Object.keys(_donePrompts);
            if (keys.length > 200) {
                for (var i = 0; i < keys.length - 200; i++) delete _donePrompts[keys[i]];
            }
            var skeys = Object.keys(_promptSources);
            if (skeys.length > 200) {
                var now = Date.now();
                var removed = 0;
                var budget = skeys.length - 200;
                for (var j = 0; j < skeys.length && removed < budget; j++) {
                    var pid = skeys[j];
                    var inFlight = (_promptSourceTs[pid] !== undefined && (now - _promptSourceTs[pid]) < 3600000) || !!_historyGuards[pid];
                    if (inFlight) continue;   // 在途：跳过，等终态事件正常走清理路径
                    delete _promptSources[pid];
                    delete _promptSourceTs[pid];
                    removed++;
                }
            }
            // 平行时间戳表对账清理——_promptSources 的各终态删除点不携带
            // ts 同步删除，孤儿条目在此统一回收（条目量 ~200 级，全扫开销可忽略）
            var tkeys = Object.keys(_promptSourceTs);
            for (var t = 0; t < tkeys.length; t++) {
                if (_promptSources[tkeys[t]] === undefined) delete _promptSourceTs[tkeys[t]];
            }
        }

        // 表单生成超时解锁：完成事件/错误/提交失败时清除
        function _clearFormGenTimeout() {
            if (_formGenTimeout) {
                clearTimeout(_formGenTimeout);
                _formGenTimeout = null;
            }
        }

        // form 错误终态/提交失败/超时解锁的收尾清理——同批其余在途任务的来源
        // 映射标记为 'form-stale' 而非删除。这些任务仍在 ComfyUI 队列中，其完成事件
        // 到达时仍应下载产物并进入结果区；删除映射会让 handleWsComplete 以
        // _src===undefined 整条跳过，整批在途/后续完成产物被静默丢弃。
        // 过期标记不参与批量计数递减（handleWsComplete 的 `_src !== 'form'` 分支
        // 直接透传 handleGenerationComplete，不动 _pendingBatchCount/_isGenerating/
        // 超时器）、不进 getFormPromptIds（批量取消目标）、进度事件也不再投递表单
        // 进度卡；各条目到达终态时由对应分支按 pid 删除（自然收敛），新批次开批时
        // 另做残留清理（见 _clearStaleFormSources）。
        function _markFormSourcesStale() {
            Object.keys(_promptSources).forEach(function (pid) {
                if (_promptSources[pid] === 'form') {
                    _promptSources[pid] = 'form-stale';
                    _stopHistoryGuard(pid);
                }
            });
        }

        // 新批次开批清理上一批残留的 'form-stale' 死条目——防映射表跨批
        // 泄漏与旧任务迟到事件串进新批次；上一批仍在途任务的完成事件此后到达按
        // 未登记来源跳过（跨批隔离，归入未登记 promptId 的既有跳过语义）。
        function _clearStaleFormSources() {
            Object.keys(_promptSources).forEach(function (pid) {
                if (_promptSources[pid] === 'form-stale') {
                    delete _promptSources[pid];
                    delete _promptSourceTs[pid];
                    _stopHistoryGuard(pid);
                }
            });
        }

        // 表单批量取消的本地收尾（view.cancelFormBatch 在取消请求至少部分
        // 成功后调用）。只发 clearQueue/interrupt + showStatus，不触碰本地状态机：
        // 取消回执与真实状态相反，generate 入口的「正在生成中」守卫把用户锁死到
        // 600s×N+60s 超时，超时后还弹假「生成超时」。收尾语义完全复用既有错误终态/
        // 超时解锁路径：清计数、解锁、清超时器 + 当前批次 form 来源标 'form-stale'
        // （迟到完成事件仍下载并进结果区，但不再参与计数/进度；见 _markFormSourcesStale）。
        // 不递增 _formGenEpoch：在途提交循环凭 `!_isGenerating` 即停止提交，收尾把其
        // 已登记的 'form' 键转 stale 保留（递增 epoch 会被判为「被新批次取代」而 delete，
        // 同批迟到产物将静默丢弃，违背 form-stale 语义）。
        function settleFormBatchCancel() {
            _pendingBatchCount = 0;
            _isGenerating = false;
            _clearFormGenTimeout();
            _markFormSourcesStale();
        }

        // 取消点击处的同步本地收口（view.cancelFormBatch 在发取消请求之前调用）。
        // 旧流程本地 settle 要等取消 HTTP 全部返回（view 的 Promise.all 回调）才执行，
        // 提交循环在该窗口内仍会继续 await submitPrompt 并登记新的 'form' 任务——这些任务
        // 不在点击瞬间的取消目标快照里，clearQueue/interrupt 打不到（可能仍在计费）。
        // 本方法同步完成两件事：①置取消意图（提交循环立即停止后续提交——在途 submit 返回后
        // 由循环尾部收尾按既有语义转 'form-stale'，不再发起下一次提交）；②立即执行既有
        // settleFormBatchCancel 本地收尾（解锁 + 清超时器 + 当前批次 form→form-stale），不再依赖
        // HTTP 往返。取消请求成败只决定回执文案：全部失败时服务端任务可能仍在跑，但当前批次已按
        // form-stale 语义收尾（迟到完成仅下载/展示、不改计数）。
        // 注释修正（只修注释，行为维持）：点击瞬间**已发出但未返回**的那一次
        // submitPrompt 无法撤回——它此刻未登记，不在 targets 快照里（clearQueue/interrupt
        // 打不到），返回后会先登记为 'form'、随循环尾部转 'form-stale' 并停 history guard；
        // 随后 view 收尾移除进度卡（取消按钮在进度卡内），用户没有再取消的入口。该张仍会
        // 在服务端跑完（继续计费），产物按 stale 语义照常下载/展示——至多 1 张、服务端已
        // 受理，属有界残留。'stale 可再次取消'（getStaleFormPromptIds）只对点击快照内或
        // 快照后仍有取消入口时（错误/超时后进度卡尚在）的条目成立，不覆盖上述窗口。
        function requestFormBatchCancel() {
            _formCancelRequested = true;
            settleFormBatchCancel();
        }

        function getSettings() {
            if (!settingsStore || typeof settingsStore.getModuleSettings !== 'function') {
                return Promise.resolve(COMFYUI_DEFAULTS);
            }
            return settingsStore.getModuleSettings('comfyui', COMFYUI_DEFAULTS);
        }

        // 固定工作流目录（<dataDir>\comfyui\workflows）的文件名清单。
        // 三态：listFilesResult 可用时区分「目录不存在 / 空 / 通道故障」——
        // 目录不存在则建出来（用户要能在文件管理器里找到落点、直接拖文件进去）；
        // 通道故障如实 warn（listFiles 会把失败折叠成 []，读不到就无从知晓）。
        // 旧通道（listFilesResult 不可用）退化为按后缀过滤的数组语义。
        async function _listWorkflowDirFiles(dirPath) {
            if (typeof AEFS === 'undefined' || !AEFS) return [];
            var isJson = function (f) { return String(f).toLowerCase().endsWith('.json'); };
            if (typeof AEFS.listFilesResult === 'function') {
                var res = null;
                try { res = await AEFS.listFilesResult(dirPath); } catch (e) { res = null; }
                if (res && res.ok === true) return (res.data || []).filter(isJson);
                if (res && _resultCode(res) === 'NOT_FOUND') {
                    // 目录不存在 → 建出来（用户要能在文件管理器里找到落点、直接拖文件进去）。
                    // 逐级建 + await：本机 cep.fs.mkdir 不可用、回退 ExtendScript 只建单层，
                    // 一次 mkdir 建到 workflows/ 会静默失败（父 comfyui/ 可能也不存在）。
                    try { await _ensureWorkflowDirs(dirPath); } catch (_) {}
                    return [];
                }
                if (res) {
                    console.warn('[ComfyUI] 工作流目录读取失败(' + (_resultCode(res) || '未知') + '): '
                        + (_resultMessage(res) || dirPath));
                    return [];
                }
                // res===null：listFilesResult 自身抛异常 → 落旧通道复核
            }
            var legacy = await AEFS.listFiles(dirPath);
            return (legacy || []).filter(isJson);
        }

        // 目录加载：API 格式文件零转换直接注册（离线可用）；UI 格式文件需要
        // /object_info 才能转换——opts.catalogReady 为 false（init 期 ComfyUI 未就绪）时
        // 不做任何网络尝试，记入 _pendingUiWorkflows 等连接成功后补转换，
        // 绝不因为没连上就把用户文件整批丢掉。
        // 返回值：注册成功的模板数组（兼容既有调用方）；失败/待转换细节见 getWorkflowLoadReport。
        async function loadWorkflowsFromDir(dirPath, opts) {
            opts = opts || {};
            _workflowLoadFailures = [];
            if (!dirPath) return [];
            var loaded = [];
            try {
                var jsonFiles = await _listWorkflowDirFiles(dirPath);
                var client = (global.AEComfyUI && global.AEComfyUI.customWorkflow) ? global.AEComfyUI.customWorkflow : null;
                for (var i = 0; i < jsonFiles.length; i++) {
                    var fileName = jsonFiles[i];
                    var name = fileName.replace(/\.json$/i, '');
                    try {
                        var fp = dirPath.replace(/\\/g, '/').replace(/\/?$/, '') + '/' + fileName;
                        var raw = await AEFS.readFile(fp);
                        if (!raw) {
                            console.warn('[ComfyUI] AEFS 读取失败:', fileName);
                            _workflowLoadFailures.push({ name: name, message: AEI18n.t('文件读取失败') });
                            continue;
                        }
                        var res = client
                            ? await client.normalizeWorkflow(raw, { service: service, requireCatalog: opts.catalogReady === true })
                            : { ok: false, error: { code: 'MODULE_MISSING', message: AEI18n.t('customWorkflow 模块未加载') } };
                        if (res.ok) {
                            var custom = engine.loadCustomWorkflow(JSON.stringify(res.data.workflow));
                            custom.name = name;
                            loaded.push(custom);
                            _queueSkippedWorkflowNotice(name, res.data.skipped);
                        } else if (res.error.code === 'NO_CATALOG') {
                            _rememberPendingWorkflow({ path: fp, name: name, raw: raw });
                        } else {
                            console.warn('[ComfyUI] 工作流加载失败:', fileName, res.error.message);
                            _workflowLoadFailures.push({ name: name, message: res.error.message });
                        }
                    } catch (e) {
                        console.warn('[ComfyUI] 加载工作流失败:', fileName, e.message);
                        _workflowLoadFailures.push({ name: name, message: e.message || String(e) });
                    }
                }
                if (_pendingUiWorkflows.length) {
                    // 不允许完全无声：至少一条汇总日志 + 面板一次性提示（bind 后补发）
                    _queueWorkflowNotice('info', AEI18n.t('检测到 {n} 个 UI 格式工作流，待连接 ComfyUI 后自动转换: ', { n: _pendingUiWorkflows.length })
                        + _pendingUiWorkflows.map(function (p) { return p.name; }).join(AEI18n.punct('、', ', ')));
                }
                if (_workflowLoadFailures.length) {
                    // 一次性可见提示（逐条细节已在 console.warn）
                    _queueWorkflowNotice('error', AEI18n.t('自定义工作流加载失败: ') + _workflowLoadFailures.map(function (f) {
                        return f.name + ': ' + f.message;
                    }).join('；'));
                }
                if (loaded.length) _notifyCanvasTemplatesChanged();
                return loaded;
            } catch (e) {
                console.warn('[ComfyUI] 读取工作流目录失败:', e.message);
                return [];
            }
        }

        // 待转换清单按 path 去重（init 失败重试等重复加载同一目录时不累积）
        function _rememberPendingWorkflow(item) {
            for (var i = 0; i < _pendingUiWorkflows.length; i++) {
                if (_pendingUiWorkflows[i].path === item.path) return;
            }
            _pendingUiWorkflows.push(item);
        }

        // 连接就绪后的 UI 格式补转换。幂等 + 在途去重（对齐 init 的 _initPromise 手法）：
        // connect/onReconnect/testConnection 三处触发可能并发进来，共享同一在途 promise。
        // 仍拿不到 catalog 的条目留在清单里等下次触发；其他失败转失败清单 + 一次可见回执。
        function _retryPendingUiWorkflows() {
            if (_retryPromise) return _retryPromise;
            if (!_pendingUiWorkflows.length) return Promise.resolve();
            _retryPromise = _doRetryPendingUiWorkflows().catch(function (e) {
                console.warn('[ComfyUI] 待转换工作流补转换异常:', e && e.message);
            }).then(function () { _retryPromise = null; });
            return _retryPromise;
        }

        async function _doRetryPendingUiWorkflows() {
            if (!_pendingUiWorkflows.length) return;
            var client = (global.AEComfyUI && global.AEComfyUI.customWorkflow) ? global.AEComfyUI.customWorkflow : null;
            var items = _pendingUiWorkflows.slice();
            _pendingUiWorkflows = [];
            var registered = 0;
            var failedNow = [];
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                // 真相源回读：pending 里的 raw 是 init 期快照，用户可能在等待期间改过/删掉
                // 该文件——补转换一律按磁盘当前内容进行。三态判定（对齐读盘纪律）：
                // NOT_FOUND → 文件真没了，丢弃（否则会注册一个磁盘上不存在的「幽灵条目」）；
                // 通道故障/被拒 → 不能当作已删除，留在待转换清单等下次触发；ok → 用磁盘当前内容。
                var rawNow = it.raw;
                if (typeof AEFS !== 'undefined' && AEFS && typeof AEFS.readFileResult === 'function') {
                    var rr = null;
                    try { rr = await AEFS.readFileResult(it.path); } catch (e) { rr = null; }
                    if (rr && rr.ok === true) {
                        rawNow = rr.data;
                    } else if (rr && _resultCode(rr) === 'NOT_FOUND') {
                        console.warn('[ComfyUI] 待转换工作流文件已删除，跳过:', it.name);
                        continue;
                    } else {
                        console.warn('[ComfyUI] 待转换工作流读取失败(' + ((rr && _resultCode(rr)) || '通道异常') + ')，留在待转换清单:', it.name);
                        _pendingUiWorkflows.push(it);
                        continue;
                    }
                }
                var res = client
                    ? await client.normalizeWorkflow(rawNow, { service: service, requireCatalog: true })
                    : { ok: false, error: { code: 'MODULE_MISSING', message: AEI18n.t('customWorkflow 模块未加载') } };
                if (res.ok) {
                    var custom = engine.loadCustomWorkflow(JSON.stringify(res.data.workflow));
                    custom.name = it.name;
                    registered++;
                    _queueSkippedWorkflowNotice(it.name, res.data.skipped);
                } else if (res.error.code === 'NO_CATALOG') {
                    _pendingUiWorkflows.push(it);   // 仍未连上：留待下次连接触发，不算失败
                } else {
                    failedNow.push({ name: it.name, message: res.error.message });
                }
            }
            if (failedNow.length) {
                _workflowLoadFailures = _workflowLoadFailures.concat(failedNow);
                // 队列化：面板已 bind 时立即显示，未 bind（bootstrap 预初始化等）时留待补发
                _queueWorkflowNotice('error', AEI18n.t('自定义工作流转换失败: ') + failedNow.map(function (f) {
                    return f.name + ': ' + f.message;
                }).join('；'));
            }
            if (registered) _notifyCanvasTemplatesChanged();
            if (registered && global.AEComfyUI._renderTemplateCards && engine) {
                // 补转换产物要进下拉——经 index.js 的重渲入口（直接操作 DOM 会绕过选中恢复逻辑）
                global.AEComfyUI._renderTemplateCards(engine.getAllTemplates(), currentTemplate ? currentTemplate.id : '');
            }
        }

        // 刷新模型列表（顺带预热 /object_info 缓存）后再补转换：刷新失败说明 catalog
        // 仍不可用，此时补转换只会再打一轮注定失败的请求（每文件一次网络往返）。
        function _refreshCatalogThenRetryPending() {
            return refreshModelList().catch(function () {}).then(function (catalogOk) {
                if (catalogOk) return _retryPendingUiWorkflows();
            });
        }

        // init 在途去重 + 失败可重试。直接暴露 async init：bootstrap
        // _ensureController 与 index mount 并发初始化同一 controller 时双跑，各自
        // createComfyUIService/createTemplateEngine（双份 WebSocket 回调状态机）；
        // 失败后 isReady() 恒 false 且无重试路径（面板永久僵死，bootstrap 侧只能
        // 另建新实例 → UI/LLM 双 controller 状态机）。包装后：在途调用共享同一
        // promise；失败不缓存 rejected promise（_initPromise 清空，可重跑重建）。
        function init() {
            if (_ready) return Promise.resolve();
            if (_initPromise) return _initPromise;
            _initPromise = _initOnce().catch(function (e) {
                _initPromise = null;  // 失败可重试：不缓存 rejected promise
                throw e;
            });
            return _initPromise;
        }

        async function _initOnce() {
            var settings = await getSettings();
            service = global.AEComfyUI.createComfyUIService({ host: settings.host, port: settings.port });
            engine = global.AEComfyUI.createTemplateEngine();
            // 初始化 modelRegistry
            var registry = global.AEComfyUI.createModelRegistry();
            _modelRegistry = registry;  // saveSettings 切换端点时联动清 schema 缓存
            try {
                var extRoot = window.__ext_root || '';
                if (extRoot) {
                    var listPath = extRoot + '\\client\\modules\\comfyui\\models\\template-list.json';
                    var listJson = await AEFS.readFile(listPath);
                    if (listJson) registry.load(listJson);
                }
            } catch (e) {
                console.warn('[ComfyUI] template-list.json 加载失败:', e && e.message);
            }
            engine.setRegistry(registry);
            engine.setService(service);
            await engine.loadTemplates();

            // Fetch available checkpoint models and inject into templates
            // 即使获取失败也注入兜底文本输入框，让用户至少能手动填模型名
            // 返回值=catalog 是否就绪（object_info 是否已进缓存）——工作流目录里的
            // UI 格式文件只有 catalog 在手才能转换，未就绪的记入待转换清单（见下）
            var _catalogReady = await refreshModelList();

            // 自动加载固定工作流目录（API 格式离线即注册；UI 格式待连接后补转换）
            await loadWorkflowsFromDir(resolveWorkflowDir(), { catalogReady: _catalogReady });

            currentTemplate = engine.getTemplate(settings.defaultTemplate) || engine.getTemplate('txt2img');

            // 表单进度卡按来源过滤——updateProgress/updateExecuting 直接操作唯一
            // 的 .comfyui-generating 进度卡，画布/LLM 任务的进度事件（产品显式支持并发）
            // 无条件转发会使表单进度条跳变、画布执行节点名混入。对齐 complete/error 的
            // 来源路由（handleWsComplete/handleWsError）：无 prompt_id 的事件维持
            // 按表单处理（历史行为，无来源可查），有 prompt_id 且非 form 来源的不转发；
            // 画布侧进度走 _canvasProgressCb 自有路由（带 promptId 查映射，不受影响）。
            function _isFormProgressSource(data) {
                if (!data || !data.prompt_id) return true;
                return _promptSources[data.prompt_id] === 'form';
            }
            service.onProgress(function (data) {
                if (global.AEComfyUI._view && _isFormProgressSource(data)) global.AEComfyUI._view.updateProgress(data);
                if (_canvasProgressCb && _canvasProgressCb.onProgress) {
                    var pct = data.max ? Math.round((data.value / data.max) * 100) : 0;
                    _canvasProgressCb.onProgress(pct + '%', data.prompt_id);
                }
            });
            service.onExecuting(function (data) {
                if (global.AEComfyUI._view && _isFormProgressSource(data)) global.AEComfyUI._view.updateExecuting(data);
                if (_canvasProgressCb && _canvasProgressCb.onExecuting) {
                    _canvasProgressCb.onExecuting(data.node || '', data.prompt_id);
                }
            });
            service.onComplete(function (data) {
                handleWsComplete(data);
            });
            service.onError(function (data) {
                handleWsError(data);
            });
            // WS 重连成功（服务器重启/断线恢复）→ 服务器节点集可能已变。
            // service 侧已把 objectInfoCache 标 stale（重拉失败回退旧缓存），这里联动清
            // modelRegistry 的 schema 缓存并重拉（顺序对齐 connect() 的 warmup + refresh）。
            // 仅「曾掉线后成功恢复」触发一次，不造成请求风暴。
            if (typeof service.onReconnect === 'function') {
                service.onReconnect(function () {
                    if (_modelRegistry && typeof _modelRegistry.clearSchemaCache === 'function') {
                        _modelRegistry.clearSchemaCache();
                    }
                    if (engine && typeof engine.warmupSchemas === 'function') {
                        engine.warmupSchemas().catch(function () {});
                    }
                    _refreshCatalogThenRetryPending();
                });
            }
            _ready = true;
        }

        // WS executing(node=null) 完成事件与 /history 轮询兜底的统一入口。
        // 两个来源可能并发到达（轮询发现完成的网络往返期间 WS 事件恰好恢复），
        // _donePrompts 原子标记保证单次处理：重复处理会二次下载 blob + 表单结果
        // 重复展示 + 画布 ae:canvas-generation-done 重复派发。
        function handleWsComplete(data) {
            if (!data || !data.prompt_id) return;
            // 未登记 promptId 不默认按 form 处理（提交响应体解析前的竞态窗口内
            // 到达、或同服务器其他客户端的完成事件）。必须完全跳过且【不】标记
            // _donePrompts——若在此标记，登记后 history guard 轮询发现的终态会被去重
            // 拦截，画布侧将挂满 600s 误报"生成超时"；跳过后 guard 轮询（form/canvas）
            // 或 _backgroundPoll（llm）会以已登记的 source 重新进入本函数正确路由。
            var _src = _promptSources[data.prompt_id];
            if (_src === undefined) return;
            if (_donePrompts[data.prompt_id]) return;
            _donePrompts[data.prompt_id] = true;
            _pruneDonePrompts();
            _stopHistoryGuard(data.prompt_id);
            // LLM 工具路径（bootstrap comfyui_generate 直调 submitPrompt）自带
            // _backgroundPoll 轮询下载并注入对话，这里只做终态去重与映射清理：
            // 不递减表单批量计数（否则表单批量生成中被 LLM 任务提前解锁）、不进
            // handleGenerationComplete（否则重复下载产物且结果串显进表单结果区）
            if (_src === 'llm') {
                delete _promptSources[data.prompt_id];
                return;
            }
            // 画布任务（generateRaw 提交）不参与表单批量计数：所有 prompt 完成都走
            // 此回调，画布事件递减表单计数会让 _isGenerating 提前解锁（批量中途可再提交）
            // 'form-stale'（错误终态后仍在途的同批任务）同走此分支——不递减
            // 计数、不触碰锁/超时器，仅由 handleGenerationComplete 下载并展示产物
            if (_src !== 'form') {
                handleGenerationComplete(data);
                return;
            }
            // 批量任务计数：>1 时递减，到 0 才解除 _isGenerating
            if (_pendingBatchCount > 1) {
                _pendingBatchCount--;
            } else {
                _pendingBatchCount = 0;
                _isGenerating = false;
                _clearFormGenTimeout();
            }
            handleGenerationComplete(data);
        }

        // WS execution_error 事件与 /history 轮询兜底的统一入口。
        // 有 prompt_id 的错误终态同样走 _donePrompts 去重（轮询发现 error 与 WS error 并发）。
        function handleWsError(data) {
            // 未登记 promptId 的错误完全跳过（与 handleWsComplete 同口径）：不在
            // _donePrompts 标记（否则登记后 guard 轮询发现的错误终态被拦截，画布侧挂
            // 600s 超时）、不进 form 分支（否则外部客户端/竞态窗口的错误事件清零表单
            // 批量锁）。无 prompt_id 的错误维持按 form 处理（历史行为，无来源可查）。
            var _src = (data && data.prompt_id) ? _promptSources[data.prompt_id] : 'form';
            if (_src === undefined) return;
            if (data && data.prompt_id) {
                if (_donePrompts[data.prompt_id]) return;
                _donePrompts[data.prompt_id] = true;
                _pruneDonePrompts();
                _stopHistoryGuard(data.prompt_id);
            }
            // 仅表单来源的错误解锁表单批量锁。画布任务失败时表单可能正批量生成中，
            // 无条件清零 _pendingBatchCount 会提前解锁（批量中途可再提交 + 计数错乱）。
            // llm 来源同理不解锁——LLM 路径失败由 bootstrap _backgroundPoll 轮询
            // 发现并注入对话，表单锁与其无关。
            if (_src === 'form') {
                _pendingBatchCount = 0;
                _isGenerating = false;
                _clearFormGenTimeout();
                // form 错误终态即当前批次全部 form 任务收尾（与超时路径同
                // 语义）——批量中单张 execution_error 只复位计数时，其余在途任务的
                // _promptSources[pid]='form' 映射残留，旧任务完成事件会递减新一轮批量
                // 计数提前解锁 + 旧结果串显进新一轮结果区。canvas/llm 条目不受影响
                // （各有终态收尾路径）。下方按 pid 的通用清理（幂等）仍保留。
                // 清理即标记 'form-stale'（不删映射）——该批其余任务照常下载
                // 并进入结果区，计数/锁/超时器仍在本分支一次性收尾（只有失败那一个
                // 的错误提示保留，见下方 showError）。
                _markFormSourcesStale();
            }
                // 从多种可能的错误格式中提取信息
                var errMsg = AEI18n.t('生成失败');
                if (data.exception_message) {
                    errMsg = data.exception_message;
                } else if (data.execution_error && data.execution_error.message) {
                    errMsg = data.execution_error.message;
                } else if (data.error && data.error.message) {
                    errMsg = data.error.message;
                } else if (data.message) {
                    errMsg = data.message;
                }
                // 添加节点信息
                if (data.node_type || data.node_id) {
                    errMsg = '[' + (data.node_type || data.node_id) + '] ' + errMsg;
                }
                // Unauthorized 提示
                if (/unauthorized|login first/i.test(errMsg)) {
                    errMsg += AEI18n.t('\n\n💡 请在 ComfyUI 模块设置中填入 Comfy API Key，或确认 ComfyUI 桌面端已登录。');
                }
                // llm 来源错误只做映射清理与错误提示——LLM 路径的结果/失败注入由
                // bootstrap _backgroundPoll 负责，不解锁表单、不派画布错误事件
                if (_src === 'llm') {
                    delete _promptSources[data.prompt_id];
                    // 来源随错误下传——llm 错误不得移除表单进度卡（表单可能正批量生成中）
                    if (global.AEComfyUI._view) global.AEComfyUI._view.showError(errMsg, 'llm');
                    return;
                }
                // 画布任务错误：按 prompt_id 路由到画布（对齐 handleGenerationComplete 的
                // _promptSources 分发）。画布侧 runGenWorkflow 监听 ae:canvas-generation-error
                // 立即解除生成等待，_runGen 的 catch 走 session.writeError 呈现错误并做失败
                // 清理（不再挂到 600s 超时才以“生成超时”收场）；表单路径行为不变（仍写表单结果区）。
                if (data && data.prompt_id && _promptSources[data.prompt_id]) {
                    // 错误终态：canvas/form 条目都清理——form 任务失败后没有 onComplete
                    // 收尾（成功路径 handleGenerationComplete 统一 delete），不清理则映射
                    // 表只增不减（每失败任务泄漏一个键）；canvas 分支对齐该清理语义
                    var _errSrc = _promptSources[data.prompt_id];
                    delete _promptSources[data.prompt_id];
                    if (_errSrc === 'canvas') {
                        window.dispatchEvent(new CustomEvent('ae:canvas-generation-error', {
                            detail: { promptId: data.prompt_id, error: errMsg }
                        }));
                    }
                }
                // 来源随错误下传——此处 _src 为 'form'（含无 prompt_id 的历史
                // 默认路径）或 'canvas'（llm 已提前 return）。canvas 错误画布侧自有
                // 呈现，不移除表单进度卡；form 失败终态保持移除进度卡的原语义。
                if (global.AEComfyUI._view) global.AEComfyUI._view.showError(errMsg, _src);
        }

        async function connect() {
            try {
                await service.connect();
                if (global.AEComfyUI._view) global.AEComfyUI._view.updateConnectionStatus(true);
                // WebSocket 连接成功后刷新模型列表
                if (engine && engine.warmupSchemas) {
                    engine.warmupSchemas().catch(function () {});
                }
                // 连接就绪 → 补转换 init 期未连上而暂存的 UI 格式工作流
                _refreshCatalogThenRetryPending();
            } catch (e) {
                if (global.AEComfyUI._view) global.AEComfyUI._view.updateConnectionStatus(false);
                throw e;
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // 官方模板表单化（fetch → convert → derive → 注册 → 选中）
        // ─────────────────────────────────────────────────────────────────────

        // 模板注册广播：画布生成节点的模型下拉数据源是 engine.getAllTemplates()，
        // 注册成功后通知已展开的画布 gen 容器重建下拉（表单卡片由各注册路径自行重渲）。
        // 监听方为 canvas/nodes/imageGenNode.js（imageGen/videoGen 共用下拉）。
        function _notifyCanvasTemplatesChanged() {
            try {
                var w = (typeof window !== 'undefined') ? window : null;
                if (!w || typeof w.dispatchEvent !== 'function') return;
                var Ctor = (typeof CustomEvent === 'function') ? CustomEvent : w.CustomEvent;
                if (typeof Ctor !== 'function') return;
                w.dispatchEvent(new Ctor('ae:comfyui-templates-changed'));
            } catch (_) {}
        }

        /**
         * 搜索官方模板库（表单浏览 modal 用）。转发 bridge /api/comfy-templates。
         */
        async function searchOfficialTemplates(query, category, limit, offset) {
            var client = global.AEComfyUI && global.AEComfyUI.officialTemplates;
            if (!client) throw new Error(AEI18n.t('officialTemplates 模块未加载'));
            return client.search(query, category, limit, offset);
        }

        /**
         * 拉取官方模板并转换为 pipeline 同构模板注册（表单/画布即用）。
         * 原子性：预检模板 id（自定义工作流/已注册占位时跳过，不产生半注册）。
         */
        async function fetchOfficialTemplate(name) {
            var client = global.AEComfyUI && global.AEComfyUI.officialTemplates;
            if (!client) return { ok: false, error: { code: 'MODULE_MISSING', message: AEI18n.t('officialTemplates 模块未加载') } };
            if (!service) return { ok: false, error: { code: 'NOT_CONNECTED', message: AEI18n.t('ComfyUI 未连接（转换需要节点信息）') } };
            var result = await client.fetchAndDerive({ name: name, service: service });
            if (!result.ok) return result;
            var d = result.data;
            // 原子性预检：id 已被自定义导入工作流/历史注册占用时拒绝
            if (engine.getTemplate(d.registryEntry.id)) {
                return { ok: false, error: { code: 'EXISTS', message: AEI18n.t('模板已注册（下拉中已存在）') } };
            }
            if (engine.addRegistryEntry(d.registryEntry) && engine.addTemplate(d.template)) {
                _notifyCanvasTemplatesChanged();
                if (global.AEComfyUI._renderTemplateCards) {
                    global.AEComfyUI._renderTemplateCards(engine.getAllTemplates(), d.registryEntry.id);
                }
                await selectTemplate(d.registryEntry.id);
                return { ok: true, data: { id: d.registryEntry.id, name: d.template.name } };
            }
            return { ok: false, error: { code: 'REGISTER_FAIL', message: AEI18n.t('模板注册失败') } };
        }

        // 刷新模型列表（伙伴节点发现 + 模型下拉注入）。
        // 返回 true/false = object_info（catalog）是否拿到——调用方据此决定能否做
        // 依赖 catalog 的事（如 UI 格式工作流转换）；失败路径返回 false 而非抛出
        //（错误仍按原样 console.warn，行为不变）。
        async function refreshModelList() {
            var catalogOk = false;
            try {
                var objectInfo = await service.getObjectInfo();
                catalogOk = true;
                // 伙伴节点自动发现：objectInfo 在手，零额外请求推导注册条目
                // （静态 template-list.json 条目优先；发现失败只告警不影响主流程）
                try {
                    var _existing = engine.getRegisteredClassTypes ? engine.getRegisteredClassTypes() : [];
                    var _discovered = (global.AEComfyUI && global.AEComfyUI.partnerDiscovery)
                        ? global.AEComfyUI.partnerDiscovery.discoverPartnerNodes(objectInfo, _existing) : [];
                    var _added = 0;
                    for (var _di = 0; _di < _discovered.length; _di++) {
                        var _d = _discovered[_di];
                        // 原子性预检：卡片 id 被自定义导入工作流占用时跳过整个条目，
                        // 避免「registry 有注册、下拉无卡片」的不一致
                        if (engine.getTemplate(_d.entry.id)) continue;
                        if (engine.addRegistryEntry(_d.entry) && engine.addTemplate(_d.card)) _added++;
                    }
                    if (_added > 0) {
                        _notifyCanvasTemplatesChanged();
                        console.log('[ComfyUI] 伙伴节点自动发现: 新增 ' + _added + ' 个模型（表单/画布可用）');
                        if (global.AEComfyUI._renderTemplateCards) {
                            global.AEComfyUI._renderTemplateCards(engine.getAllTemplates(),
                                currentTemplate ? currentTemplate.id : '');
                        }
                    }
                } catch (_de) {
                    console.warn('[ComfyUI] 伙伴节点发现失败（不影响模型列表刷新）:', _de && _de.message);
                }
                var _unetTools = (global.AEComfyUI && global.AEComfyUI.unetModels) ? global.AEComfyUI.unetModels : null;
                var _ckptChoices = [];
                if (objectInfo && objectInfo.CheckpointLoaderSimple) {
                    var input = objectInfo.CheckpointLoaderSimple.input;
                    var required = input && input.required;
                    var ckptInput = required && required.ckpt_name;
                    if (Array.isArray(ckptInput) && Array.isArray(ckptInput[0])) {
                        _ckptChoices = ckptInput[0];
                    }
                }
                // models/unet + models/diffusion_models 的裸扩散模型（ComfyUI 合并进 UNETLoader.unet_name），
                // 与 checkpoint 一起并入声明了 modelSource:'mixed' 的模板下拉。
                // 表单下拉只放能直接出图的图像模型：视频扩散模型（MiniMax H3 / WAN / LTX 等）
                // 与未适配族不进下拉（会渲染失败），但 comfyui_list_checkpoints 分页返回全部
                // 模型并标注 modality / supported，供 LLM 判断。
                var _unetAll = _unetTools ? _unetTools.listUnetNames(objectInfo) : [];
                var _unetChoices = _unetTools ? _unetTools.listImageUnetNames(objectInfo) : _unetAll;
                if (_unetTools) _ckptChoices = _unetTools.filterImageModelNames(_ckptChoices);
                engine.injectModelChoices(_ckptChoices, _unetChoices, _unetAll);
                if (_unetTools && typeof engine.setModelCatalog === 'function') {
                    engine.setModelCatalog(_unetTools.buildCatalog(objectInfo));
                }
                var _hiddenUnet = _unetAll.length - _unetChoices.length;
                console.log('[ComfyUI] 本地模型: checkpoint ' + _ckptChoices.length + ' 个 + 图像扩散模型 ' + _unetChoices.length + ' 个'
                    + (_hiddenUnet > 0 ? '（已排除 ' + _hiddenUnet + ' 个视频/未适配扩散模型）' : '')
                    + '，已并入文生图/图生图模型下拉');
            } catch (e) {
                console.warn('[ComfyUI] 获取模型列表失败:', e.message);
                // 兜底：注入空列表，templateEngine 会渲染文本输入框
                engine.injectModelChoices([], [], []);
                if (typeof engine.setModelCatalog === 'function') engine.setModelCatalog(null);
            }
            // 动态 enum：无条件通知（bootstrap 侧空集/去重早退）——置于 try/catch 之后，
            // ComfyUI 未连接时也能把注册表既有条目（含已发现的伙伴模型）同步出去，
            // 覆盖「发现先于 bootstrap 回调注册」的加载序竞态
            if (global.AEComfyUI._onModelRegistryChanged && _modelRegistry) {
                try { global.AEComfyUI._onModelRegistryChanged(_modelRegistry.getAll()); } catch (_) {}
            }
            // 模型列表刷新后重新渲染当前模板参数（先保存表单值防止丢失）
            var view = global.AEComfyUI._view;
            if (currentTemplate && view) {
                if (typeof view.collectParamValues === 'function') {
                    view.collectParamValues();
                }
                view.renderParams(currentTemplate);
            }
            return catalogOk;
        }

        async function testConnection() {
            try {
                var info = await service.testConnection();
                if (global.AEComfyUI._view) global.AEComfyUI._view.updateConnectionStatus(true, info);
                // 连接成功后刷新模型列表（把可能的文本输入框升级为下拉）
                // 面板 bind 时与用户点「连接测试」都会走到这里——也是 init 期未连上时
                // 暂存的自定义工作流（UI 格式）最可能的补转换时机
                _refreshCatalogThenRetryPending();
                return info;
            } catch (e) {
                if (global.AEComfyUI._view) global.AEComfyUI._view.updateConnectionStatus(false);
                throw e;
            }
        }

        async function selectTemplate(templateId) {
            _pendingTemplateId = templateId;
            var _m = engine.getById(templateId);
            var _isNonPipeline = _m && !_m.pipeline;
            var params;
            if (_isNonPipeline) {
                try { params = await engine.getModelParams(templateId); } catch (e) { params = null; }
                // await 期间用户可能切换到其他模板，此时不应覆盖 currentTemplate
                if (_pendingTemplateId !== templateId) return;
                currentTemplate = engine.getTemplate(templateId);
                if (params && params.length > 0) currentTemplate.parameters = params;
            } else {
                currentTemplate = engine.getTemplate(templateId);
            }
            if (currentTemplate && global.AEComfyUI._view) {
                global.AEComfyUI._view.renderParams(currentTemplate);
            }
        }

        async function generate(paramValues) {
            if (!currentTemplate) throw new Error(AEI18n.t('未选择模板'));
            if (_isGenerating) {
                if (global.AEComfyUI._view) global.AEComfyUI._view.showError(AEI18n.t('正在生成中，请等待当前任务完成'));
                return;
            }
            // 批次纪元——批量首张 execution_error 解锁（handleWsError form 分支清
            // _isGenerating）后用户重入会开启新批次；旧提交循环仅凭 _isGenerating 重检
            // 会被新批次的 true 蒙混，凭 epoch 识别自己已被取代
            var myEpoch = ++_formGenEpoch;
            _isGenerating = true;
            // 新批次开批复位取消意图（上一批取消残留不得使当前批次一提交即停）
            _formCancelRequested = false;
            // 新批次开批——清理上一批错误终态遗留的 'form-stale' 死条目
            // （防映射表跨批泄漏与旧任务迟到事件串批，见 _clearStaleFormSources）
            _clearStaleFormSources();
            try {
                // Upload any image File objects and replace with server filenames
                var values = paramValues || {};
                var keys = Object.keys(values);
                for (var i = 0; i < keys.length; i++) {
                    var k = keys[i];
                    if (values[k] && typeof values[k] === 'object' && values[k] instanceof File) {
                        // 上传包超时保护（每文件 120s）——挂死时 reject 走下方
                        // catch 释放 _isGenerating，不再永久锁死表单生成
                        var uploadResult = await _uploadImageWithTimeout(service, values[k], values[k].name);
                        values[k] = uploadResult.name || values[k].name;
                    }
                }
                // non-pipeline 走 schema 驱动（与画布统一），pipeline 保留模板 JSON
                var _model = engine.getById(currentTemplate.id);
                var _isNonPipeline = _model && !_model.pipeline;
                var _formImgFilenames = {}, _formVidFilenames = {};
                if (_isNonPipeline) {
                    var _regImgKeys = (_model.imageInputKeys || []);
                    for (var _ri = 0; _ri < _regImgKeys.length; _ri++) {
                        var _rik = _regImgKeys[_ri];
                        if (values[_rik]) { _formImgFilenames[_rik] = values[_rik]; delete values[_rik]; }
                        // 不管 registry key 是否带 _N 后缀，都扫描 baseKey+_1..._20：
                        // 带 _N 的模型（model.images.image_1）续 key 多图；
                        // 不带 _N 的模型（first_frame_image）也能捡到表单 slot 产生的 _1 键
                        var _imgBase = _rik.replace(/_\d+$/, '');
                        for (var _in = 1; _in <= 20; _in++) {
                            var _ink = _imgBase + '_' + _in;
                            if (values[_ink]) { _formImgFilenames[_ink] = values[_ink]; delete values[_ink]; }
                        }
                    }
                    var _regVidKeys = (_model.videoInputKeys || []);
                    for (var _rv = 0; _rv < _regVidKeys.length; _rv++) {
                        var _rvk = _regVidKeys[_rv];
                        if (values[_rvk]) { _formVidFilenames[_rvk] = values[_rvk]; delete values[_rvk]; }
                        var _vidBase = _rvk.replace(/_\d+$/, '');
                        for (var _vn = 1; _vn <= 20; _vn++) {
                            var _vnk = _vidBase + '_' + _vn;
                            if (values[_vnk]) { _formVidFilenames[_vnk] = values[_vnk]; delete values[_vnk]; }
                        }
                    }
                }
                // 批量生成：仅 batch_size 参数触发循环（云端 n/max_images 由节点原生处理）
                // 每次不同 seed → N 张不同的图。workflow 内 batch_size 固定 1，由循环实现批量。
                var _batchN = 1;
                if (values.batch_size !== undefined && Number(values.batch_size) > 1) {
                    _batchN = Math.floor(Number(values.batch_size));
                }
                delete values.batch_size;  // workflow 里无 {{batch_size}} 占位符，删除避免误传
                var _origSeed = values.seed;
                var _wfOpts = _isNonPipeline ? {} : { useTemplateWorkflow: true };
                var settings = await getSettings();
                _pendingBatchCount = _batchN;
                var _lastResult = null;
                var _myPromptIds = [];  // 当前批次登记的 promptId（提交循环收尾延迟清理用）
                // 表单生成超时解锁——完成事件（WS 与轮询兜底均）丢失时不永久锁死，
                // 批量按每张 600s（画布侧等待上限）+ 60s 余量计总超时
                _clearFormGenTimeout();
                _formGenTimeout = setTimeout(function () {
                    _formGenTimeout = null;
                    if (_pendingBatchCount > 0 || _isGenerating) {
                        _pendingBatchCount = 0;
                        _isGenerating = false;
                        // 超时解锁即当前批次 form 任务终态——清理残留的 form 来源映射与
                        // history guard（正常收尾路径 handleGenerationComplete/handleWsError
                        // 均会 delete；超时需要同样清理，否则迟到完成事件（队列阻塞后
                        // 恢复）仍按 form 路由：递减新一轮批量计数提前解锁 + 旧结果串显进
                        // 新一轮结果区。canvas/llm 条目不受影响（各有终态收尾路径）。
                        // 清理即标记 'form-stale'——迟到完成事件仍下载并进入结果区，
                        // 但不再触碰新一轮计数（见 _markFormSourcesStale）。
                        _markFormSourcesStale();
                        if (global.AEComfyUI._view) global.AEComfyUI._view.showError(AEI18n.t('生成超时：未收到完成事件，已自动解锁'), 'form');  // 表单失败终态
                    }
                }, 600000 * _batchN + 60000);
                // 取消意图可能在 generate 的 await（图片上传/取设置）期间到达——
                // requestFormBatchCancel 已本地收尾，但本函数随后又把计数/超时器武装起来
                // （上面的 _pendingBatchCount/_formGenTimeout 赋值发生在 await 之后）。
                // 不在此处再收一遍：残留计数会让超时器到点弹假「生成超时」，且 _isGenerating
                // 被错误复锁。直接按取消语义收尾并跳过提交循环。
                if (_formCancelRequested) {
                    _pendingBatchCount = 0;
                    _isGenerating = false;
                    _clearFormGenTimeout();
                }
                for (var _bi = 0; _bi < _batchN; _bi++) {
                    // 提交循环内重检——批量首张 execution_error 已解锁（handleWsError
                    // form 分支清 _isGenerating）或已被重入新批次取代（epoch 变化）时，
                    // 停止提交剩余任务；不重检则旧循环继续提交并登记 form 映射，其迟到
                    // 完成事件会递减新批次计数（提前解锁 + 旧结果串显进新结果区）
                    // 取消意图（_formCancelRequested）同样立即停止提交——在途
                    // submit 返回后不再发起下一次，杜绝「取消请求在途期间继续登记新 form
                    // 任务、新任务不在取消快照里打不到」的窗口
                    if (!_isGenerating || myEpoch !== _formGenEpoch || _formCancelRequested) break;
                    // 批量模式每次不同 seed：seed=-1 每次随机；固定 seed 则 seed+i
                    if (_batchN > 1) {
                        if (_origSeed === -1 || _origSeed === '-1') {
                            values.seed = Math.floor(Math.random() * 2147483647);
                        } else {
                            values.seed = ((Number(_origSeed) || 0) + _bi) >>> 0;
                        }
                    }
                    var workflow = engine.renderWorkflow(currentTemplate.id, values, _formImgFilenames, _formVidFilenames, _wfOpts);
                    // 清理未使用的 LoadImage / LoadVideo 节点（通用，不依赖命名约定）
                    // renderWorkflow 的 removeUnreplacedPlaceholders 会把无值的 {{key}} 占位符删掉，
                    // 导致 loader 节点丢失主输入（LoadImage.image / LoadVideo.file）。这些孤儿要删掉，并清掉所有指向它的 link。
                    Object.keys(workflow).forEach(function (nodeId) {
                        var node = workflow[nodeId];
                        if (!node) return;
                        var mainInput = null;
                        if (node.class_type === 'LoadImage') mainInput = 'image';
                        else if (node.class_type === 'LoadVideo') mainInput = 'file';
                        else return;
                        if (node.inputs && node.inputs[mainInput]) return; // 有主输入，保留
                        delete workflow[nodeId];
                        Object.keys(workflow).forEach(function (nid) {
                            var n = workflow[nid];
                            if (n && n.inputs) {
                                Object.keys(n.inputs).forEach(function (ik) {
                                    var v = n.inputs[ik];
                                    if (Array.isArray(v) && v[0] === nodeId) {
                                        delete n.inputs[ik];
                                    }
                                });
                            }
                        });
                    });
                    var result = await service.submitPrompt(workflow, settings.apiKey);
                    if (result && result.error) {
                        // 批量中途失败：立即解锁，避免 _pendingBatchCount 残留导致生成按钮永久锁死
                        // 已被重入新批次取代（epoch 变化）时不再触碰共享状态——
                        // 否则会清零新批次计数/清光新批次映射
                        if (myEpoch === _formGenEpoch) {
                            _pendingBatchCount = 0;
                            _isGenerating = false;
                            _clearFormGenTimeout();
                            // （复查发现）：submitPrompt 返回型失败（节点校验拒/鉴权
                            // 失效，不 throw）是第三个 form 失败路径——与 catch 分支同因，已提交的
                            // 前几张 promptId 仍登记 _promptSources，不清理则迟到完成事件递减
                            // 新一轮计数提前解锁 + 旧结果串显；迟到错误事件甚至清光新一轮映射
                            // 清理即标记 'form-stale'——已提交任务的产物照常下载并
                            // 进入结果区，计数/锁/超时器仍在本分支一次性收尾
                            _markFormSourcesStale();
                        }
                        // 来源随错误下传（form）——view.showNodeErrors 按 source 决定
                        // 是否移除表单进度卡，表单自身提交失败保持移除的原语义
                        if (global.AEComfyUI._view) global.AEComfyUI._view.showNodeErrors(result.error, 'form');
                        return _lastResult;
                    }
                    var promptId = typeof result === 'string' ? result : (result && result.prompt_id);
                    if (promptId) {
                        _promptSources[promptId] = 'form';
                        _promptSourceTs[promptId] = Date.now();  // 在途保护时间戳
                        _myPromptIds.push(promptId);  // 循环收尾延迟清理用
                        // WS 掉线时 /history 轮询兜底；maxAge 与批量总超时
                        // (600s×N+60s) 联动 + 60s 余量——固定 660s 会在第 2~N 张完成前自停
                        _startHistoryGuard(promptId, 600000 * _batchN + 120000);
                    }
                    if (global.AEComfyUI._view) global.AEComfyUI._view.showGenerating(result);
                    _lastResult = result;
                }
                // error 清理延迟到提交循环结束——批量中单张失败（handleWsError
                // form 分支清 _isGenerating/递减计数）后循环又登记的 form 映射在此统一
                // 清理（延迟期间错误处理器的全量清理已覆盖失败前登记的条目，这里补
                // 失败后登记的漏网），否则旧任务迟到完成事件按 form 路由递减重入后的
                // 新批次计数；epoch 不匹配（新批次在途）时只清当前批次登记，不动新批次
                // 该清理只许删「已不可能进结果区」的键——'form-stale'
                // 条目（错误终态/超时已在途标记，见 _markFormSourcesStale）跳过保留：
                // 它们不参与计数/进度，留着只供完成事件下载与展示。上一轮只修了错误
                // 处理器的四个收尾点，漏了这里：错误在提交循环进行中到达时（某张
                // submit 仍在途时收到 execution_error），错误处理器把已登记项标成
                // 'form-stale'，而循环在途 submit 返回后又登记新的 'form' 键，收尾
                // 一删就把刚落好的 stale 标记连同新登记键一起抹掉——同批仍在
                // ComfyUI 队列里的任务完成事件在 handleWsComplete 以未登记来源整条
                // 跳过，产物静默丢弃。故：批次未被取代（epoch 未变）时，
                // 当前批次在途的 'form' 键转 'form-stale'（对齐 _markFormSourcesStale
                // 语义：不参与计数/进度、停 history guard）；仅新批次已接管
                // （epoch 变化）时才按现状 delete + stopHistoryGuard，只清当前批次登记。
                if (!_isGenerating || myEpoch !== _formGenEpoch) {
                    var _superseded = (myEpoch !== _formGenEpoch);
                    _myPromptIds.forEach(function (pid) {
                        var _srcNow = _promptSources[pid];
                        if (_srcNow === 'form-stale') return;   // 已过期：保留映射仅供下载/展示
                        if (!_superseded && _srcNow === 'form') {
                            _promptSources[pid] = 'form-stale';
                        } else {
                            delete _promptSources[pid];
                        }
                        _stopHistoryGuard(pid);
                    });
                }
                return _lastResult;
            } catch (e) {
                // 已被重入新批次取代（epoch 变化）时不再触碰共享状态——否则清零
                // 新批次计数/清光新批次映射（错误解锁→重入→旧循环提交超时抛错的串扰路径）
                if (myEpoch === _formGenEpoch) {
                    _pendingBatchCount = 0;
                    _isGenerating = false;
                    _clearFormGenTimeout();
                    // 提交部分成功后失败（catch）同样清理 form 来源映射与 history
                    // guard（对齐超时路径与 handleWsError form 分支语义）——已提交的
                    // 前几张 promptId 仍登记在 _promptSources，不清理则其迟到完成事件会
                    // 递减新一轮批量计数提前解锁 + 旧结果串显进新一轮结果区
                    // 清理即标记 'form-stale'——已提交任务的产物照常下载并进入
                    // 结果区，但不再触碰新一轮计数
                    _markFormSourcesStale();
                }
                console.error('[ComfyUI] 生成异常:', e);
                if (global.AEComfyUI._view) global.AEComfyUI._view.showError(AEI18n.t('生成请求失败: ') + (e.message || String(e)), 'form');  // 表单失败终态
            }
        }

        // opts.timeoutMs： 起调用方（画布 runGenWorkflow 按模型 category）可传入
        // 当前批次等待上限——history guard 的 maxAge 与之联动（+60s 余量），画布视频档等待
        // 放宽至 1800s 后 guard 不再提前自停（WS 断线窗口的 /history 兜底不丢）。
        async function generateRaw(workflowJson, source, opts) {
            if (!service) throw new Error(AEI18n.t('ComfyUI 服务未初始化'));
            try {
                var settings = await getSettings();
                var result = await service.submitPrompt(workflowJson, settings.apiKey);
                if (result && result.error) {
                    // 来源随错误下传——画布任务提交失败不移除表单进度卡（对齐
                    // showError 的来源路由，无条件移除会误伤批量生成中的表单进度卡）
                    if (global.AEComfyUI._view) global.AEComfyUI._view.showNodeErrors(result.error, source || 'canvas');
                    return null;
                }
                var promptId = typeof result === 'string' ? result : (result && result.prompt_id);
                if (promptId) {
                    _promptSources[promptId] = source || 'canvas';
                    _promptSourceTs[promptId] = Date.now();  // 在途保护时间戳
                    // WS 掉线时 /history 轮询兜底；maxAge 与调用方等待上限联动
                    _startHistoryGuard(promptId, (opts && opts.timeoutMs) ? (opts.timeoutMs + 60000) : 660000);
                }
                return promptId;
            } catch (e) {
                console.error('[ComfyUI] generateRaw 异常:', e);
                throw e;
            }
        }

        // 供绕过 generate/generateRaw 的提交路径（bootstrap 的 LLM 工具
        // comfyui_generate 直调 service.submitPrompt）登记 promptId 来源。不登记则
        // 完成事件会被未知来源跳过逻辑忽略、错误事件同理（未登记来源则被误
        // 判为 form 路由进表单状态机）。不启动 history guard——llm 路径自带
        // _backgroundPoll 轮询 getHistory，重复轮询浪费请求。
        function registerPromptSource(promptId, source) {
            if (!promptId) return;
            _promptSources[promptId] = source;
            _promptSourceTs[promptId] = Date.now();  // 在途保护时间戳（llm 视频档最长 1980s）
        }

        // 供顶栏取消按钮定位"表单来源"的生成任务——并发生成时全局 currentPromptId
        // 是"最后一次提交"（可能是画布/LLM 任务），无参 interrupt 会取消错对象
        function getFormPromptIds() {
            return Object.keys(_promptSources).filter(function (pid) {
                return _promptSources[pid] === 'form';
            });
        }

        // 'form-stale' 在途任务（错误终态/超时/取消后仍在 ComfyUI 队列里跑，
        // 可能继续计费）——取消入口据此把这些任务一并纳入取消目标。只收 'form'：
        // 一张 execution_error 后同批剩余任务全变 stale，进度卡被移除、顶栏取消返回
        // 「当前没有本批生成任务可取消」，用户再也无法取消它们。
        function getStaleFormPromptIds() {
            return Object.keys(_promptSources).filter(function (pid) {
                return _promptSources[pid] === 'form-stale';
            });
        }

        // LLM 工具路径的只读取模板——不写 currentTemplate、不触发表单
        // renderParams（selectTemplate 会静默改掉用户表单当前选中的模板，并发时
        // 还会打断用户自身 selectTemplate 的 _pendingTemplateId 竞态守卫）。
        // 产出与 selectTemplate 同构的参数集：non-pipeline 同样拉 schema 参数合并；
        // engine.getTemplate 返回克隆对象，改 parameters 不影响注册表。
        async function getTemplateFor(templateId) {
            if (!engine) return null;
            var t = engine.getTemplate(templateId);
            if (!t) return null;
            var _m = engine.getById(templateId);
            if (_m && !_m.pipeline && typeof engine.getModelParams === 'function') {
                try {
                    var params = await engine.getModelParams(templateId);
                    if (params && params.length > 0) t.parameters = params;
                } catch (_) { /* schema 拉取失败：保留模板 JSON 自带参数 */ }
            }
            return t;
        }

        async function handleGenerationComplete(data) {
            // 来源快照——必须在任何 await 之前读取。放到 getHistory/
            // downloadOutput 之后才查 _promptSources：下载在途期间新批次开批
            // （_clearStaleFormSources 清理 'form-stale' 键）会让判定读不到键而回落
            // 'form'，取消批迟到产物随即按新批次 form 路由进入结果区（showResults 还
            // 带着新批次的 _pendingBatchCount 剩余数）。快照固定「事件到达时的归属」，
            // 后续所有 await 后的判定一律用快照，不再重读映射。
            var source = _promptSources[data.prompt_id] || 'form';
            try {
                var history = await service.getHistory(data.prompt_id);
                var outputs = history.outputs || {};
                var results = [];

                Object.keys(outputs).forEach(function (nodeId) {
                    var nodeOutput = outputs[nodeId];
                    // Generic: process any array of file objects (images, gifs, videos, audio, etc.)
                    Object.keys(nodeOutput).forEach(function (key) {
                        var arr = nodeOutput[key];
                        if (!Array.isArray(arr)) return;
                        arr.forEach(function (item, idx) {
                            if (!item || !item.filename) return;
                            results.push({
                                promptId: data.prompt_id,
                                nodeId: nodeId,
                                outputType: key,
                                filename: item.filename,
                                subfolder: item.subfolder || '',
                                type: item.type || 'output',
                                index: idx,
                                format: item.format || ''
                            });
                        });
                    });
                });

                for (var i = 0; i < results.length; i++) {
                    var blob = await service.downloadOutput(results[i].filename, results[i].subfolder, results[i].type);
                    results[i].blob = blob;
                    // 存 ComfyUI 原始 URL，供 AE 直接下载（跳过 CSInterface 传文件）
                    results[i].viewUrl = 'http://' + (await getSettings()).host + ':' + (await getSettings()).port +
                        '/view?filename=' + encodeURIComponent(results[i].filename) +
                        '&subfolder=' + encodeURIComponent(results[i].subfolder || '') +
                        '&type=' + encodeURIComponent(results[i].type || 'output');
                }

                // 跨批隔离收口——事件到达时本任务映射仍在（否则 handleWsComplete
                // 已整条跳过），但下载期间新批次开批清理了本任务映射（_clearStaleFormSources
                // 只清 form/form-stale），说明产物属于已被新批次取代的旧批：不再进
                // currentResults/showResults（对齐「新批次开批后旧任务迟到完成整条跳过」的
                // 既有跨批隔离语义）。source 用入口快照，不受后续清理影响。
                if ((source === 'form' || source === 'form-stale') && _promptSources[data.prompt_id] === undefined) {
                    return;
                }

                if (source === 'canvas') {
                    // dispatch 画布事件
                    var event = new CustomEvent('ae:canvas-generation-done', {
                        detail: { promptId: data.prompt_id, results: results }
                    });
                    window.dispatchEvent(event);
                }

                // 'form-stale'（错误终态/提交失败/超时后仍在途的同批任务）与
                // 'form' 同等下载并进入结果区，只是不参与批量计数（handleWsComplete
                // 的非 form 分支已直接透传到此，未动 _pendingBatchCount）。该类
                // 映射被删除，完成事件在 handleWsComplete 入口以未登记来源跳过，
                // 同批其余任务产物被静默丢弃（不下载、不进结果区）
                if (source === 'form' || source === 'form-stale') {
                    // objectURL 仅表单路径创建（removeResult/destroy 负责 revoke）；
                    // canvas 路径消费方只用 blob/filename，无条件创建会泄漏 blob 引用
                    for (var ui = 0; ui < results.length; ui++) {
                        results[ui].url = URL.createObjectURL(results[ui].blob);
                    }
                    currentResults = currentResults.concat(results);
                    // 批量剩余数传给视图——>0 时进度卡保留，最后一张才收尾移除
                    if (global.AEComfyUI._view) global.AEComfyUI._view.showResults(results, _pendingBatchCount);
                }

                // 清理映射
                delete _promptSources[data.prompt_id];
            } catch (e) {
                console.error('[ComfyUI] 处理结果失败:', e);
                // 异常路径（如下载 blob 失败）与成功路径同等收尾——清理映射 +
                // 画布来源派发 error 事件（否则画布侧挂满 600s 误报"生成超时"，且映射泄漏）。
                // 表单锁已在 handleWsComplete 解除，此处无需再动。
                // 来源同样用入口快照；映射在下载期间被新批次清理的旧批
                // form/form-stale 产物失败也不再打扰新批次（与上方成功路径收口同口径）。
                var _c8src = source;
                var _c8cleared = (_c8src === 'form' || _c8src === 'form-stale') && _promptSources[data.prompt_id] === undefined;
                delete _promptSources[data.prompt_id];
                if (_c8cleared) return;
                if (_c8src === 'canvas') {
                    window.dispatchEvent(new CustomEvent('ae:canvas-generation-error', {
                        detail: { promptId: data.prompt_id, error: AEI18n.t('获取结果失败: ') + (e.message || String(e)) }
                    }));
                }
                // 来源随错误下传——canvas 任务下载失败画布侧已派 error 事件，
                // 不移除表单进度卡；form 任务失败终态保持移除语义
                if (global.AEComfyUI._view) global.AEComfyUI._view.showError(AEI18n.t('获取结果失败: ') + e.message, _c8src);
            }
        }

        function checkHostResp(resp, errMsg) {
            if (!resp || resp.ok === false) throw new Error(errMsg + (resp && resp.error ? ': ' + resp.error : ''));
            // 检查 ExtendScript 脚本是否执行出错（返回错误字符串）
            if (resp.result && typeof resp.result === 'string' && /^(ERROR|Error):/.test(resp.result)) {
                throw new Error(errMsg + ': ' + resp.result);
            }
            return resp;
        }

        async function writeBlobToFile(blob, filePath) {
            // 优先走 AEFS.writeBlob：Bridge 二进制通道（免 base64/JSON 编解码，大文件快一个量级）。
            // 内部已含 Blob→base64→writeFileBase64 回退（cep.fs/ExtendScript 全链），失败才进下方旧链兜底。
            if (typeof AEFS !== 'undefined' && typeof AEFS.writeBlob === 'function') {
                var ok = await AEFS.writeBlob(filePath, blob);
                if (ok) {
                    return true;
                }
                throw new Error(AEI18n.t('写入文件失败(AEFS writeBlob 全通道不可用): ') + filePath);
            }

            // 兜底（旧 AEFS 无 writeBlob）：FileReader → base64 → writeFileBase64
            var base64 = await new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onload = function () { resolve(reader.result.split(',')[1]); };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            var ok2 = await AEFS.writeFileBase64(filePath, base64);
            if (ok2) {
                return true;
            }
            throw new Error(AEI18n.t('写入文件失败(AEFS 全通道不可用): ') + filePath);
        }

        // 嵌入 ExtendScript 的路径转义（对齐 assets/index.js 的 _escPath 完整链）——
        // importToAE/saveOnly/captureCurrentFrame 三处只转义 \ 与 \" 时，\n\r\t\0 与
        // U+2028/U+2029（ES3 字符串字面量中的行终止符）未转义会让 evalScript 解析
        // 失败或截断字符串字面量
        function _escPath(p) {
            return String(p || '')
                .replace(/\\/g, '\\\\')
                .replace(/"/g, '\\"')
                .replace(/\n/g, '\\n')
                .replace(/\r/g, '\\r')
                .replace(/\t/g, '\\t')
                .replace(/\0/g, '\\0')
                // U+2028/U+2029 在 ES3 字符串字面量中是行终止符，未转义会让 evalScript 解析失败
                .replace(/\u2028/g, '\\u2028')
                .replace(/\u2029/g, '\\u2029');
        }

        async function importToAE(resultItem) {
            if (!hostApi) throw new Error(AEI18n.t('hostApi 不可用'));

            // 获取项目路径
            var resp = checkHostResp(
                await hostApi.call('app.project.file ? app.project.file.fsName : ""'),
                AEI18n.t('获取项目路径失败')
            );
            var projectPath = typeof resp.result === 'string' ? resp.result : '';
            if (!projectPath) throw new Error(AEI18n.t('请先保存 AE 项目'));

            // 规范化路径：统一使用单反斜杠，后续在需要时转义
            var dir = projectPath.replace(/[\\\/][^\\\/]+$/, '');
            var subfolder = ctx.settingsStore ?
                _sanitizeSubfolder((await getSettings()).outputSubfolder) : '_comfyui_output';
            var outputDir = dir + '\\' + subfolder;

            // 创建输出目录（走 AEFS.mkdir，过 _checkPath 校验防路径穿越/注入）
            var _dirOk = (typeof AEFS !== 'undefined' && AEFS.mkdir) ? await AEFS.mkdir(outputDir) : false;
            if (!_dirOk && !(typeof AEFS !== 'undefined' && AEFS.existsSync && AEFS.existsSync(outputDir))) {
                throw new Error(AEI18n.t('创建输出目录失败: ') + outputDir);
            }

            var ext = _safeExt(resultItem.filename);
            var shortId = resultItem.promptId.replace(/-/g, '').substring(0, 8);
            var fileName = 'ComfyUI_' + shortId + '_' + String(resultItem.index + 1).padStart(3, '0') + '.' + ext;
            fileName = _dedupeFileName(outputDir, fileName);
            var filePath = outputDir + '\\' + fileName;

            // 通过 ExtendScript 分块写入文件（已优化：原生 readAsDataURL + 数组 join 解码）
            await writeBlobToFile(resultItem.blob, filePath);

            // 验证文件是否写入成功（使用转义后的路径供 ExtendScript）
            var escapedPath = _escPath(filePath);
            var verifyResp = checkHostResp(
                await hostApi.call(
                    'var f = new File("' + escapedPath + '"); ' +
                    'f.exists ? "OK" : "ERROR: 文件不存在"'
                ),
                AEI18n.t('验证文件失败')
            );
            if (verifyResp.result !== 'OK') throw new Error(verifyResp.result || AEI18n.t('文件写入后验证失败: ') + filePath);

            // 导入到 AE 项目（不自动添加到合成，用户按需手动拖入）
            var importScript =
                'var f = new File("' + escapedPath + '"); ' +
                'if (!f.exists) { "ERROR: 文件不存在"; } else { ' +
                'try { ' +
                'var opts = new ImportOptions(f); ' +
                'var item = app.project.importFile(opts); ' +
                'item && item.name ? item.name : "ERROR: 导入返回空结果"; ' +
                '} catch (e) { "ERROR: " + e.message; } }';
            // importFile 不可取消——大素材/慢盘导入超过 hostApi.call 默认 8s
            // 超时时面板报「导入 AE 失败」，AE 随后仍导入成功（假失败 + 状态不一致）。
            // 显式放宽到 60s（对齐同文件渲染帧 25s 等重路径的量级；导入无服务端可取消点，
            // 只能给足窗口）。
            var importResp = checkHostResp(await hostApi.call(importScript, 60000), AEI18n.t('导入 AE 失败'));
            var itemName = importResp.result ? String(importResp.result) : '';

            // 检查 ExtendScript 返回的错误
            if (!itemName || /^(ERROR|Error):/.test(itemName)) {
                throw new Error(itemName || AEI18n.t('AE 导入返回为空，请检查文件格式是否支持'));
            }

            return { filePath: filePath, itemName: itemName };
        }

        async function saveOnly(resultItem) {
            if (!hostApi) throw new Error(AEI18n.t('hostApi 不可用'));

            var resp = checkHostResp(
                await hostApi.call('app.project.file ? app.project.file.fsName : ""'),
                AEI18n.t('获取项目路径失败')
            );
            var projectPath = typeof resp.result === 'string' ? resp.result : '';
            if (!projectPath) throw new Error(AEI18n.t('请先保存 AE 项目'));

            var dir = projectPath.replace(/[\\\/][^\\\/]+$/, '');
            var subfolder = ctx.settingsStore ?
                _sanitizeSubfolder((await getSettings()).outputSubfolder) : '_comfyui_output';
            var outputDir = dir + '\\' + subfolder;

            // 创建输出目录（走 AEFS.mkdir，过 _checkPath 校验防路径穿越/注入）
            var _dirOk = (typeof AEFS !== 'undefined' && AEFS.mkdir) ? await AEFS.mkdir(outputDir) : false;
            if (!_dirOk && !(typeof AEFS !== 'undefined' && AEFS.existsSync && AEFS.existsSync(outputDir))) {
                throw new Error(AEI18n.t('创建输出目录失败: ') + outputDir);
            }

            var ext = _safeExt(resultItem.filename);
            var shortId = resultItem.promptId.replace(/-/g, '').substring(0, 8);
            var fileName = 'ComfyUI_' + shortId + '_' + String(resultItem.index + 1).padStart(3, '0') + '.' + ext;
            fileName = _dedupeFileName(outputDir, fileName);
            var filePath = outputDir + '\\' + fileName;

            await writeBlobToFile(resultItem.blob, filePath);

            var escapedPath = _escPath(filePath);
            var verifyResp = checkHostResp(
                await hostApi.call(
                    'var f = new File("' + escapedPath + '"); ' +
                    'f.exists ? "OK" : "ERROR: 文件不存在"'
                ),
                AEI18n.t('验证文件失败')
            );
            if (verifyResp.result !== 'OK') throw new Error(verifyResp.result || AEI18n.t('文件写入后验证失败'));

            return { filePath: filePath };
        }

        // ── 本项目资产库（工程目录文件）──────────────────────────────────────────
        // 唯一目标：让"temp 里的生成产物"能被显式转存成跟随工程的长期资产，并能再移出。
        // 边界：只碰 <工程目录>/PROJECT_ASSET_SUBFOLDER 与 <数据目录>/temp/comfyui-output
        // 两处；不导入 AE、不改工程内容。工程未保存 ⇒ 显式失败（见 _assetRoot）。

        function _dataDirPath() {
            try {
                var d = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                    ? global.AEShared.getDataDir() : null;
                return (d && d.dir) ? String(d.dir).replace(/[\\\/]+$/, '') : '';
            } catch (_) { return ''; }
        }

        function _tempOutputDirPath() {
            var base = _dataDirPath();
            return base ? (base + '\\temp\\comfyui-output') : '';
        }

        // AEFS 三态适配（Result 版）：ok → data，NOT_FOUND → 空/不存在，
        // REJECTED / CHANNEL_FAILURE → 显式抛错。折叠版（existsSync/listFiles/stat）把
        // 「读不了」与「不存在」折成同一个假值；资产库的回执要能区分，否则通道故障会被
        // 报成「资产库为空」。旧 AEFS 无 Result 接口时退回折叠版（行为同改造前）。
        function _aefsErrorText(r) {
            var code = (r && r.error && r.error.code) || '';
            var msg = (r && r.error && r.error.message) || '';
            var last = '';
            try {
                last = (typeof AEFS !== 'undefined' && typeof AEFS.lastError === 'function')
                    ? String(AEFS.lastError() || '') : '';
            } catch (_) { last = ''; }
            var detail = msg || last;
            // 码表有对应码 → 当前语言文案 + 原始详情；表外的码保持 code: detail 形态
            if (typeof AEFS !== 'undefined' && AEFS && typeof AEFS.displayError === 'function') {
                var text = AEFS.displayError({ ok: false, error: { code: code, message: detail } });
                if (text && text !== detail) return text;
            }
            return code + (detail ? (': ' + detail) : '');
        }

        async function _exists3(abs) {
            if (typeof AEFS === 'undefined' || typeof AEFS.existsResult !== 'function') {
                return !!(typeof AEFS !== 'undefined' && typeof AEFS.existsSync === 'function'
                    && AEFS.existsSync(abs));
            }
            var r = null;
            try { r = await AEFS.existsResult(abs); } catch (e) {
                throw new Error(AEI18n.t('路径探测失败: ') + abs + AEI18n.punct('（', ' (') + (e && e.message ? e.message : e) + AEI18n.punct('）', ')'));
            }
            if (r && r.ok === true) return !!r.data;
            var code = (r && r.error && r.error.code) || '';
            if (code === 'NOT_FOUND') return false;
            throw new Error(AEI18n.t('路径探测失败（') + _aefsErrorText(r) + AEI18n.punct('）', ')') + ': ' + abs);
        }

        async function _listNames3(dir, kind) {
            var resultFn = (kind === 'dirs') ? 'listDirsResult' : 'listFilesResult';
            var plainFn = (kind === 'dirs') ? 'listDirs' : 'listFiles';
            if (typeof AEFS === 'undefined' || typeof AEFS[resultFn] !== 'function') {
                var fallback = [];
                try {
                    if (typeof AEFS !== 'undefined' && typeof AEFS[plainFn] === 'function') {
                        fallback = await AEFS[plainFn](dir);
                    }
                } catch (_) { fallback = []; }
                return { ok: true, names: Array.isArray(fallback) ? fallback : [] };
            }
            var r = null;
            try { r = await AEFS[resultFn](dir); } catch (e) {
                throw new Error(AEI18n.t('列目录失败: ') + dir + AEI18n.punct('（', ' (') + (e && e.message ? e.message : e) + AEI18n.punct('）', ')'));
            }
            if (r && r.ok === true) {
                return { ok: true, names: Array.isArray(r.data) ? r.data : [] };
            }
            var code = (r && r.error && r.error.code) || '';
            if (code === 'NOT_FOUND') return { ok: true, names: [], notFound: true };
            throw new Error(AEI18n.t('列目录失败（') + _aefsErrorText(r) + AEI18n.punct('）', ')') + ': ' + dir);
        }

        // 当前 AE 工程所在目录（'' = 工程未保存/路径形态不支持；宿主桥不可用或异常时抛错）。
        async function getProjectDir() {
            if (!hostApi) throw new Error(AEI18n.t('ExtendScript 桥未就绪（hostApi 不可用）'));
            var resp = checkHostResp(
                await hostApi.call('app.project.file ? app.project.file.fsName : ""'),
                AEI18n.t('获取工程路径失败')
            );
            var projectPath = typeof resp.result === 'string' ? resp.result : '';
            if (!projectPath) return '';
            var dir = projectPath.replace(/[\\\/][^\\\/]+$/, '');
            if (!dir || dir === projectPath) return '';
            // 盘符（含盘根 `E:\x.aep` 的 `E:` 形态）与 UNC 工程目录都接受；
            // UNC 工程目录的实际读写受 AEFS 对已登记 UNC 根的限制（未登记时三动作显式失败，
            // 不会被当成「工程未保存」）。
            var isDrive = /^[A-Za-z]:$/.test(dir) || /^[A-Za-z]:[\\\/]/.test(dir);
            var isUnc = /^\\\\[^\\\/]+[\\\/][^\\\/]+/.test(dir);
            if (!isDrive && !isUnc) return '';
            return dir.replace(/\//g, '\\').replace(/\\+$/, '');
        }

        // 资产库根（工程未保存 ⇒ 抛 PROJECT_UNSAVED，不回落数据目录）。
        async function _assetRoot() {
            var projectDir = await getProjectDir();
            if (!projectDir) {
                var err = new Error(AEI18n.t('当前 AE 工程未保存：本项目资产库建在工程文件同目录，请先保存工程后重试'));
                err.code = 'PROJECT_UNSAVED';
                throw err;
            }
            return { projectDir: projectDir, root: projectDir + '\\' + PROJECT_ASSET_SUBFOLDER };
        }

        // 绝对目录逐段预建（AEFS.mkdir 非递归）。基址支持盘符与 UNC（网络数据目录/工程）；
        // 已存在的段跳过 mkdir（少一次通道往返，也避开部分通道对已存在目录返回失败码）。
        async function _ensureAbsDir(absDir) {
            var norm = String(absDir || '').replace(/\//g, '\\').replace(/\\+$/, '');
            var base = '';
            var rest = '';
            var mDrive = /^([A-Za-z]:)(\\.*)$/.exec(norm);
            var mUnc = /^(\\\\[^\\\/]+\\[^\\\/]+)(\\.*)?$/.exec(norm);
            if (mDrive) {
                base = mDrive[1];
                rest = mDrive[2].slice(1);
            } else if (mUnc) {
                base = mUnc[1];
                rest = (mUnc[2] || '').slice(1);
            } else {
                throw new Error(AEI18n.t('目录必须是绝对路径（盘符或 UNC）: ') + absDir);
            }
            var segs = rest ? rest.split('\\').filter(function (s) { return !!s; }) : [];
            // 纵深：`..` 段一律拒（AEFS._checkPath 也拒，这里先挡住）。
            // 段尾空格/点按 Windows 语义会先被剥掉（`.. ` 等价 `..`），故剥后再判。
            for (var k = 0; k < segs.length; k++) {
                if (segs[k] === '..' || segs[k].replace(/[. ]+$/, '') === '..') {
                    throw new Error(AEI18n.t('目录不能含 .. 段: ') + absDir);
                }
            }
            var cur = base;
            for (var i = 0; i < segs.length; i++) {
                var candidate = cur + '\\' + segs[i];
                if (await _exists3(candidate)) { cur = candidate; continue; }
                var ok = (typeof AEFS !== 'undefined' && typeof AEFS.mkdir === 'function')
                    ? await AEFS.mkdir(candidate) : false;
                if (!ok && !(await _exists3(candidate))) throw new Error(AEI18n.t('创建目录失败: ') + candidate);
                cur = candidate;
            }
            return cur;
        }

        // 工程目录内的路径判定（大小写不敏感 + 分隔符归一；等值不算"在内部"）。
        function _withinDir(absPath, dirAbs) {
            var a = String(absPath || '').replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
            var d = String(dirAbs || '').replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
            if (!a || !d) return false;
            return a.indexOf(d + '\\') === 0;
        }

        // 输入路径归一：绝对路径原样（分隔符归一），否则按数据根相对路径解析
        //（生成回执里给的是 temp/comfyui-output/xxx 这种相对形态）。
        function _resolveInputPath(raw) {
            var s = String(raw == null ? '' : raw).trim();
            if (!s) throw new Error(AEI18n.t('路径为空'));
            var isAbs = /^[A-Za-z]:[\\\/]/.test(s) || /^\\\\/.test(s);
            if (!isAbs) {
                var abs = '';
                try {
                    if (global.AEShared && typeof global.AEShared.fromDataRel === 'function') {
                        abs = global.AEShared.fromDataRel(s);
                    }
                } catch (_) {}
                if (typeof abs !== 'string' || !abs) throw new Error(AEI18n.t('无法解析路径（数据目录不可用或路径不合法）: ') + raw);
                s = abs;
            }
            s = s.replace(/\//g, '\\').replace(/\\+$/, '');
            // 纵深：`..` 段一律拒（AEFS 读/写/探测路径同样会拒；这里先挡住，
            // 防「前缀匹配通过但实际父目录逃逸」）。段尾空格/点按 Windows 语义会先被剥掉。
            var segs = s.split('\\');
            for (var i = 0; i < segs.length; i++) {
                if (segs[i] === '..' || segs[i].replace(/[. ]+$/, '') === '..') {
                    throw new Error(AEI18n.t('路径不能含 .. 段: ') + raw);
                }
            }
            return s;
        }

        function _baseNameOf(p) {
            var m = String(p || '').replace(/\\/g, '/').match(/([^\/]+)$/);
            return m ? m[1] : '';
        }

        // Windows 单段名合法性（与 AEFS._checkPath ⑤/④ 同口径的子集，供资产子目录/文件名复用）：
        // 拒 Windows 非法字符、行分隔符（U+2028/U+2029 是 ES3 字面量里的行终止符）、纯空白、
        // 尾点/尾空格（文件系统会剥掉，导致回读路径与原路径不是同一个）、% 与引号（AEFS 全拒）、
        // DOS 保留设备名（CON/NUL/COM1/CONIN$…，不带扩展名也算）。
        function _badWinSegment(seg) {
            if (!seg) return true;
            if (/[<>:"|?*%\u0000-\u001f\u007f\u2028\u2029]/.test(seg)) return true;
            if (!seg.replace(/\s/g, '')) return true;
            if (/[. ]$/.test(seg)) return true;
            if (/^\.+$/.test(seg)) return true;
            var upper = seg.replace(/\..*$/, '').toUpperCase();
            if (upper === 'NUL' || upper === 'CON' || upper === 'PRN' || upper === 'AUX'
                || upper === 'CONIN$' || upper === 'CONOUT$'
                || /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) return true;
            return false;
        }

        // 资产库内相对子目录：只收单层/多层相对段；拒盘符、..、非法段名。
        function _normRelDir(raw) {
            var s = String(raw == null ? '' : raw).trim().replace(/\\/g, '/');
            if (!s) return '';
            if (/^[A-Za-z]:/.test(s) || s.charAt(0) === '/') {
                throw new Error(AEI18n.t('资产子目录只接受相对路径: ') + raw);
            }
            var parts = s.split('/');
            var segs = [];
            for (var i = 0; i < parts.length; i++) {
                var seg = parts[i];
                if (seg === '' || seg === '.') continue;
                if (seg === '..' || seg.replace(/[. ]+$/, '') === '..') throw new Error(AEI18n.t('资产子目录不能含 ..: ') + raw);
                if (_badWinSegment(seg)) {
                    throw new Error(AEI18n.t('资产子目录含非法字符: ') + JSON.stringify(seg));
                }
                segs.push(seg);
            }
            return segs.join('\\');
        }

        // 重命名参数：只收单段文件名（不含路径分隔符），空串表示沿用源文件名。
        function _normFileName(raw) {
            var s = String(raw == null ? '' : raw).trim();
            if (!s) return '';
            if (/[\\\/]/.test(s)) throw new Error(AEI18n.t('name 只能是文件名，不能含路径分隔符: ') + raw);
            if (_badWinSegment(s)) throw new Error(AEI18n.t('name 含非法字符: ') + raw);
            return s;
        }

        // 读侧文件信息（AEFS.stat 只过 _checkPath，工程目录同样可读）。
        // opts.strict：用 statResult 三态——「不存在」返回 null，通道故障/路径被拒抛错
        //（save/restore 用；list 的逐文件 stat 用非 strict，单文件探测失败不阻断整页）。
        async function _statFile(abs, opts) {
            var strict = !!(opts && opts.strict);
            if (typeof AEFS === 'undefined') return null;
            if (strict && typeof AEFS.statResult === 'function') {
                var rr = null;
                try { rr = await AEFS.statResult(abs); } catch (e) {
                    throw new Error(AEI18n.t('文件探测失败: ') + abs + AEI18n.punct('（', ' (') + (e && e.message ? e.message : e) + AEI18n.punct('）', ')'));
                }
                if (rr && rr.ok === true && rr.data) {
                    var dd = rr.data;
                    return {
                        isFile: dd.isFile !== false,
                        size: (typeof dd.size === 'number') ? dd.size : 0,
                        mtimeMs: (typeof dd.mtimeMs === 'number') ? dd.mtimeMs : 0
                    };
                }
                var code = (rr && rr.error && rr.error.code) || '';
                if (code === 'NOT_FOUND') return null;
                throw new Error(AEI18n.t('文件探测失败（') + _aefsErrorText(rr) + AEI18n.punct('）', ')') + ': ' + abs);
            }
            if (typeof AEFS.stat === 'function') {
                var st = null;
                try { st = await AEFS.stat(abs); } catch (_) { st = null; }
                if (st) {
                    return {
                        isFile: st.isFile !== false,
                        size: (typeof st.size === 'number') ? st.size : 0,
                        mtimeMs: (typeof st.mtimeMs === 'number') ? st.mtimeMs : 0
                    };
                }
            }
            if (typeof AEFS.existsSync === 'function' && AEFS.existsSync(abs)) {
                return { isFile: true, size: 0, mtimeMs: 0 };
            }
            return null;
        }

        function _hostEval(script, errMsg) {
            if (!hostApi) return Promise.reject(new Error(AEI18n.t('ExtendScript 桥未就绪（hostApi 不可用）')));
            return hostApi.call(script, 60000).then(function (resp) {
                return checkHostResp(resp, errMsg);
            });
        }

        // 宿主侧复制（file 域关闭时 new File 被宿主守卫拒绝 ⇒ 返回 ERROR/抛错，不静默成功）。
        // 成功判据在宿主侧一次拿全：File.copy 返回 true 且目标文件确实存在。
        // 复核必须**新建 File 对象**：复制前创建的对象其 exists 在 ExtendScript 里可能陈旧
        //（仓内 projectAssetApi.jsx 的 1b 修复即此坑），会把成功复制误判为失败。
        async function _hostCopyFile(srcAbs, dstAbs) {
            var script = '(function(){var s=new File("' + _escPath(srcAbs) + '");'
                + 'if(!s.exists)return"ERROR:源文件不存在";'
                + 'if(new File("' + _escPath(dstAbs) + '").exists)return"ERROR:目标文件已存在";'
                + 'try{if(!s.copy("' + _escPath(dstAbs) + '"))return"ERROR:复制失败";}'
                + 'catch(e){return"ERROR:"+(e&&e.message?e.message:e);}'
                + 'return new File("' + _escPath(dstAbs) + '").exists?"OK":"ERROR:复制后目标文件不存在";})()';
            var resp = await _hostEval(script, AEI18n.t('复制文件失败'));
            var out = String(resp.result == null ? '' : resp.result);
            if (out !== 'OK') throw new Error(out || AEI18n.t(AEI18n.t('复制文件失败')));
        }

        // 宿主侧移动 = 复制 + 删源（跨盘没有 rename 语义）。删源失败如实报"部分完成"，
        // 此时目标已存在、源仍在——错误对象带 partial/tempPath 供调用方结构化上报，
        // 不假装成功也不重试覆盖。存在性复核同样每次新建 File 对象（见 _hostCopyFile）。
        async function _hostMoveFile(srcAbs, dstAbs) {
            var script = '(function(){var s=new File("' + _escPath(srcAbs) + '");'
                + 'if(!s.exists)return"ERROR:源文件不存在";'
                + 'if(new File("' + _escPath(dstAbs) + '").exists)return"ERROR:目标文件已存在";'
                + 'try{if(!s.copy("' + _escPath(dstAbs) + '"))return"ERROR:复制失败";}'
                + 'catch(e){return"ERROR:"+(e&&e.message?e.message:e);}'
                + 'if(!(new File("' + _escPath(dstAbs) + '").exists))return"ERROR:复制后目标文件不存在";'
                + 'try{if(!(new File("' + _escPath(srcAbs) + '")).remove())return"PARTIAL:已复制到 temp，但删除资产库源文件失败";}'
                + 'catch(e2){return"PARTIAL:已复制到 temp，但删除资产库源文件失败";}'
                + 'return"OK";})()';
            var resp = await _hostEval(script, AEI18n.t('移动文件失败'));
            var out = String(resp.result == null ? '' : resp.result);
            if (out === 'OK') return;
            if (out.indexOf('PARTIAL:') === 0) {
                var err = new Error(out.slice('PARTIAL:'.length) + AEI18n.t('（temp 副本已生成: ') + dstAbs + AEI18n.punct('）', ')'));
                err.partial = true;
                err.tempPath = dstAbs;
                throw err;
            }
            throw new Error(out || AEI18n.t('移动文件失败'));
        }

        /**
         * 把生成产物（temp\comfyui-output 下）复制到本项目资产库。
         * @param {{paths:string[], folder?:string, names?:string[]}} opts
         * @returns {Promise<{projectDir,assetRoot,folder,saved:Array,failed:Array}>}
         */
        async function saveProjectAssets(opts) {
            opts = opts || {};
            var paths = Array.isArray(opts.paths) ? opts.paths : [];
            if (!paths.length) throw new Error(AEI18n.t('paths 必填：至少一个生成产物路径'));
            if (paths.length > 50) throw new Error(AEI18n.t('单次最多转存 50 个文件'));
            var names = Array.isArray(opts.names) ? opts.names : [];
            var ar = await _assetRoot();
            var tempDir = _tempOutputDirPath();
            if (!tempDir) throw new Error(AEI18n.t('数据目录不可用，无法定位生成产物'));
            var subRel = _normRelDir(opts.folder);
            var targetDir = await _ensureAbsDir(subRel ? (ar.root + '\\' + subRel) : ar.root);
            var saved = [];
            var failed = [];
            for (var i = 0; i < paths.length; i++) {
                try {
                    var abs = _resolveInputPath(paths[i]);
                    if (!_withinDir(abs, tempDir)) {
                        throw new Error(AEI18n.t('只能转存 temp\\comfyui-output 下的生成产物（收到: ') + paths[i] + AEI18n.punct('）', ')'));
                    }
                    var st = await _statFile(abs, { strict: true });
                    if (!st || !st.isFile) throw new Error(AEI18n.t('源文件不存在: ') + abs);
                    var wanted = (names[i] != null) ? _normFileName(names[i]) : '';
                    var baseName = wanted || _baseNameOf(abs);
                    // 显式改名但没给扩展名 ⇒ 沿用源扩展名（资产文件靠扩展名判定类型）
                    if (wanted && !/\.[^.]{1,12}$/.test(wanted)) {
                        var extMatch = /\.[^.\\\/]+$/.exec(_baseNameOf(abs));
                        baseName = wanted + (extMatch ? extMatch[0] : '');
                    }
                    var dstName = _dedupeFileName(targetDir, baseName);
                    // 成功判据由宿主脚本给（copy 返回 true + 新建 File 复核 exists）：
                    // 不再用折叠版 AEFS.existsSync 二次复核——通道故障会把已成功复制误报成失败，
                    // 模型重试又会产生 _1 重复资产。
                    await _hostCopyFile(abs, targetDir + '\\' + dstName);
                    saved.push({
                        path: targetDir + '\\' + dstName,
                        name: dstName,
                        source: abs,
                        size: st.size || 0,
                        folder: subRel.replace(/\\/g, '/')
                    });
                } catch (e) {
                    failed.push({ input: paths[i], error: (e && e.message) ? e.message : String(e) });
                }
            }
            return { projectDir: ar.projectDir, assetRoot: ar.root, folder: targetDir, saved: saved, failed: failed };
        }

        /**
         * 列出本项目资产库内的文件（递归，深度 ≤ 3；按 mtime 新→旧）。
         * 目录读取走 AEFS 三态接口：只有 NOT_FOUND 才报「不存在/空库」，
         * 通道故障或路径被数据层拒绝一律显式抛错（不把「读不了」报成「库是空的」）。
         * @param {{folder?:string, limit?:number}} opts
         */
        async function listProjectAssets(opts) {
            opts = opts || {};
            var ar = await _assetRoot();
            var limit = (typeof opts.limit === 'number' && opts.limit > 0)
                ? Math.min(Math.floor(opts.limit), 500) : 200;
            var subRel = _normRelDir(opts.folder);
            var startDir = subRel ? (ar.root + '\\' + subRel) : ar.root;
            var exists = await _exists3(startDir);
            var files = [];
            var dirs = [];
            var hitMore = false;
            var DIRS_LIMIT = 200;
            async function walk(dirAbs, relPrefix, depth) {
                if (hitMore || depth > 3) return;
                var listed = await _listNames3(dirAbs, 'files');
                var names = listed.names;
                if (listed.notFound) return;
                var sizeMap = {};
                if (typeof AEFS.listFilesWithSize === 'function') {
                    var sized = null;
                    try { sized = await AEFS.listFilesWithSize(dirAbs); } catch (_) { sized = null; }
                    if (Array.isArray(sized)) {
                        for (var si = 0; si < sized.length; si++) {
                            var one = sized[si] || {};
                            if (one.name) sizeMap[one.name] = one;
                        }
                    }
                }
                for (var i = 0; i < names.length; i++) {
                    var nm = names[i];
                    if (typeof nm !== 'string' || !nm) continue;
                    if (files.length >= limit) { hitMore = true; return; }
                    var abs = dirAbs + '\\' + nm;
                    var info = sizeMap[nm];
                    var size = (info && typeof info.size === 'number') ? info.size : 0;
                    var mtimeMs = (info && typeof info.mtimeMs === 'number') ? info.mtimeMs : 0;
                    if (!info) {
                        // 逐文件 stat 用非 strict：单文件探测失败不阻断整页（列表本身仍可用）
                        var st = await _statFile(abs);
                        if (st) { size = st.size || 0; mtimeMs = st.mtimeMs || 0; }
                    }
                    files.push({
                        name: nm,
                        relPath: relPrefix ? (relPrefix + '/' + nm) : nm,
                        path: abs,
                        size: size,
                        mtimeMs: mtimeMs
                    });
                }
                var subDirs = (await _listNames3(dirAbs, 'dirs')).names;
                for (var d = 0; d < subDirs.length; d++) {
                    var dn = subDirs[d];
                    if (typeof dn !== 'string' || !dn) continue;
                    var drel = relPrefix ? (relPrefix + '/' + dn) : dn;
                    if (dirs.length < DIRS_LIMIT) dirs.push(drel);
                    await walk(dirAbs + '\\' + dn, drel, depth + 1);
                    if (hitMore) return;
                }
            }
            if (exists) await walk(startDir, subRel.replace(/\\/g, '/'), 0);
            files.sort(function (a, b) { return (b.mtimeMs || 0) - (a.mtimeMs || 0); });
            return {
                projectDir: ar.projectDir,
                assetRoot: ar.root,
                dir: startDir,
                exists: exists,
                // total = 本次返回的条数（截断时等于 limit，不是库内总数）；truncated 表示还有未返回项
                total: files.length,
                returned: files.length,
                truncated: hitMore,
                truncatedBy: hitMore ? 'limit' : '',
                dirs: dirs,
                dirsTruncated: dirs.length >= DIRS_LIMIT,
                files: files
            };
        }

        /**
         * 把资产库内的文件移回 temp\comfyui-output（= 移出资产库）。
         * 移回后按 temp 的回收策略处理，不再作为长期资产。
         * @param {{paths:string[]}} opts
         */
        async function restoreProjectAssets(opts) {
            opts = opts || {};
            var paths = Array.isArray(opts.paths) ? opts.paths : [];
            if (!paths.length) throw new Error(AEI18n.t('paths 必填：要移出资产库的资产路径（list 返回的 path）'));
            if (paths.length > 50) throw new Error(AEI18n.t('单次最多移出 50 个文件'));
            var ar = await _assetRoot();
            var tempDir = _tempOutputDirPath();
            if (!tempDir) throw new Error(AEI18n.t('数据目录不可用，无法移回 temp'));
            await _ensureAbsDir(tempDir);
            var moved = [];
            var failed = [];
            for (var i = 0; i < paths.length; i++) {
                try {
                    var abs = _resolveInputPath(paths[i]);
                    if (!_withinDir(abs, ar.root)) {
                        throw new Error(AEI18n.t('只能移出资产库内的文件（收到: ') + paths[i] + AEI18n.punct('）', ')'));
                    }
                    var st = await _statFile(abs, { strict: true });
                    if (!st || !st.isFile) throw new Error(AEI18n.t('资产文件不存在: ') + abs);
                    // 落回 temp 用 ComfyUI_ 前缀：temp\comfyui-output 的滚动裁剪与 2GB 预算
                    // 判据都是 /^ComfyUI_/i（bootstrap._pruneResultDir / tempSweep.budgetTargets）
                    // ——沿用资产名（如 hero.png）会既不被裁剪也不计入预算，违背「移回 temp
                    // 后按 temp 回收策略处理」的承诺。
                    var srcBase = _baseNameOf(abs);
                    var extMatch = /\.[^.\\\/]{1,12}$/.exec(srcBase);
                    var stamp = String(Date.now()).slice(-8);
                    var dstName = 'ComfyUI_restored_' + stamp + '_'
                        + String(i + 1).padStart(3, '0') + (extMatch ? extMatch[0] : '');
                    dstName = _dedupeFileName(tempDir, dstName);
                    var dstAbs = tempDir + '\\' + dstName;
                    await _hostMoveFile(abs, dstAbs);
                    var relPath = dstAbs;
                    try {
                        if (global.AEShared && typeof global.AEShared.toDataRelPath === 'function') {
                            relPath = global.AEShared.toDataRelPath(_dataDirPath(), dstAbs);
                        }
                    } catch (_) {}
                    moved.push({ from: abs, path: dstAbs, relPath: relPath, name: dstName });
                } catch (e) {
                    failed.push({
                        input: paths[i],
                        error: (e && e.message) ? e.message : String(e),
                        // 半完成（已复制到 temp、源未删）要结构化上报：模型按文案重试会再复制一份
                        partial: !!(e && e.partial),
                        tempPath: (e && e.partial && e.tempPath) ? e.tempPath : ''
                    });
                }
            }
            return { projectDir: ar.projectDir, assetRoot: ar.root, tempDir: tempDir, moved: moved, failed: failed };
        }

        async function captureCurrentFrame() {
            if (!hostApi) throw new Error(AEI18n.t('hostApi 不可用'));

            // 确定临时目录：数据目录/temp/ae-preview/，回退系统临时目录
            var tempDir = '';
            var dd = '';
            try {
                dd = (typeof global.AEShared !== 'undefined' && typeof global.AEShared.getDataDir === 'function')
                    ? global.AEShared.getDataDir().dir : '';
            } catch (_) {}
            if (dd) {
                var ddFwd = dd.replace(/\\/g, '/').replace(/\/+$/, '');
                tempDir = ddFwd + '/temp/ae-preview';
                // 确保目录存在（AEFS.mkdir 非递归，逐层建）
                try { if (typeof AEFS !== 'undefined' && AEFS.mkdir) await AEFS.mkdir(ddFwd + '/temp'); } catch (_) {}
                try { if (typeof AEFS !== 'undefined' && AEFS.mkdir) await AEFS.mkdir(tempDir); } catch (_) {}
            }
            // 渲染帧的落盘目录必须在数据目录内（缓存/临时产物不写系统临时目录——那边没有
            // 清扫覆盖）；数据目录不可用时直接失败，不再回退。
            if (!tempDir) {
                throw new Error(AEI18n.t('数据目录不可用，无法确定渲染帧的临时目录（缓存只写数据目录，不落系统临时目录）'));
            }
            // ExtendScript 侧路径：数据目录以字符串字面量传入
            // 注意：路径中的 \ 和 " 必须转义，防 ExtendScript 字符串注入
            var extTempPath = '"' + _escPath(tempDir) + '/"';

            // 第一步：ExtendScript 渲染当前帧到临时 PNG，只返回文件路径（不编码 base64）
            // 交给 saveFrameToPng 的 File 对象此后 exists/length 是
            // **陈旧**的（aeTools.jsx 有实测：文件最终 10,833,057 字节而该对象回报 1,476,761，
            // 且 open("r") 此后恒 false）——必须每轮 new File(outputFile.fsName) 重取实时状态；
            // 且「等出现」与「等非空」分开：AE 先创建 0 字节文件再渐进写入，只等 exists 会在
            // 0 字节窗口早退，随即被 length===0 误判成「渲染超时」（对齐 aeTools.jsx /
            // host/api/projectAssetApi.jsx 的既有注释口径）。
            var renderScript =
                '(function(){ try {' +
                'var comp = app.project.activeItem;' +
                'if (!comp || !(comp instanceof CompItem)) return "ERROR: 没有活动的合成";' +
                'try { comp.openInViewer(); } catch(_) {}' +
                'var outDir = ' + extTempPath + ';' +
                'var f = new Folder(outDir); if (!f.exists) f.create();' +
                'var outputFile = new File(outDir + "ae_preview_" + (new Date().getTime()) + ".png");' +
                'comp.saveFrameToPng(comp.time, outputFile);' +
                '$.sleep(200);' +
                // 实时长度：每轮新建 File 对象（-1=不存在；>=0=当前字节数）
                'var liveLen = function () { var nf = new File(outputFile.fsName); return nf.exists ? nf.length : -1; };' +
                // 三段等待共享 18s 总预算（面板侧 hostApi.call 超时 25s），防大合成误报超时
                'var deadline = (new Date()).getTime() + 18000;' +
                'var len = liveLen(), waited = 0;' +
                'while (len <= 0 && waited < 150 && (new Date()).getTime() < deadline) { $.sleep(100); waited++; len = liveLen(); }' +
                'if (len < 0) return "ERROR: 渲染超时（文件未创建）";' +
                'if (len === 0) return "ERROR: 渲染超时（0 字节）";' +
                // 等待文件写入稳定（同样每轮新建 File，不复用旧对象）
                'var stable = 0, lastLen = 0;' +
                'for (var w = 0; w < 10 && (new Date()).getTime() < deadline; w++) { $.sleep(300); var curLen = liveLen(); if (curLen === lastLen && curLen > 0) { stable++; if (stable >= 2) break; } else { stable = 0; } lastLen = curLen; }' +
                'return String(outputFile.fsName);' +
                '} catch(e) { return "ERROR: " + e.toString(); } })();';

            var resp = await hostApi.call(renderScript, 25000);
            var filePath = resp && resp.result ? String(resp.result) : '';

            if (!filePath || filePath.substring(0, 5) === 'ERROR') {
                throw new Error(AEI18n.t('获取当前帧失败: ') + (filePath || AEI18n.t('无响应')));
            }

            // 第二步：读回渲染帧。ExtendScript 侧已等到「文件出现 + 非空 + 尺寸稳定」
            //（每轮 new File 重取实时长度），这里不再烧 60×200ms 的重复整读。
            // 收敛到异步读图链路（同 mediaReaders 口径）——
            // ① 优先 AEFS.readBlob 二进制通道一次读回（免 base64/JSON 编解码搬运，bridge
            //   侧自带 waitFileStable）；② 失败回退 AEFS.readImageBase64（异步）。两路都做
            // PNG 头+IEND / JPEG 头+EOI 完整性校验，截断帧不交付。全程无同步 XHR。
            var blob = null;
            var fileName = filePath.replace(/^.*[\\\/]/, '') || 'ae_frame.png';

            // 帧完整性/类型判定（返回 mime 或 null）
            async function frameMime(b) {
                if (!b || b.size <= 12) return null;
                var head = new Uint8Array(await b.slice(0, 8).arrayBuffer());
                var tail = new Uint8Array(await b.slice(b.size - 12).arrayBuffer());
                var isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
                var isJpg = head[0] === 0xFF && head[1] === 0xD8;
                if (isPng) {
                    var iendOk = tail[4] === 0x49 && tail[5] === 0x45 && tail[6] === 0x4E && tail[7] === 0x44 &&
                                 tail[8] === 0xAE && tail[9] === 0x42 && tail[10] === 0x60 && tail[11] === 0x82;
                    return iendOk ? 'image/png' : null;
                }
                if (isJpg) {
                    return (tail[10] === 0xFF && tail[11] === 0xD9) ? 'image/jpeg' : null;  // EOI
                }
                return null;
            }

            // ① 二进制通道（免 base64/JSON 搬运；bridge 侧自带 waitFileStable）
            try {
                var blobResult = (global.AEFS && typeof global.AEFS.readBlob === 'function')
                    ? await global.AEFS.readBlob(filePath) : null;
                if (blobResult && blobResult.success && blobResult.blob) {
                    if (await frameMime(blobResult.blob)) {
                        blob = blobResult.blob;
                        console.warn('[ComfyUI] 读帧完成 size=' + blob.size + ' mime=' + blob.type);
                    } else {
                        console.warn('[ComfyUI] AEFS.readBlob 帧完整性校验失败（疑似截断），尝试图片链兜底: size=' + blobResult.blob.size);
                    }
                }
            } catch (e) {
                console.warn('[ComfyUI] AEFS.readBlob 读取帧失败:', (e && e.message) || e);
            }

            // ② 兜底：异步 readImageBase64 → base64 → Blob（同一套头尾完整性校验）
            if (!blob) {
                try {
                    var b64Result = (global.AEFS && typeof global.AEFS.readImageBase64 === 'function')
                        ? await global.AEFS.readImageBase64(filePath) : null;
                    if (b64Result && b64Result.success && b64Result.base64) {
                        var raw;
                        try { raw = atob(b64Result.base64); } catch (e) { raw = null; }
                        if (raw && raw.length > 12) {
                            var CHUNK = 256 * 1024;
                            var parts = [];
                            for (var offset = 0; offset < raw.length; offset += CHUNK) {
                                var end = Math.min(offset + CHUNK, raw.length);
                                var chunk = new Uint8Array(end - offset);
                                for (var j = 0; j < end - offset; j++) { chunk[j] = raw.charCodeAt(offset + j); }
                                parts.push(chunk);
                            }
                            var cand = new Blob(parts, { type: 'application/octet-stream' });
                            var candMime = await frameMime(cand);
                            if (candMime) {
                                blob = cand;
                                console.warn('[ComfyUI] 读帧完成（图片链兜底） size=' + blob.size + ' mime=' + candMime);
                            } else {
                                console.warn('[ComfyUI] AEFS.readImageBase64 帧完整性校验失败（疑似截断）: size=' + cand.size);
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[ComfyUI] AEFS.readImageBase64 兜底读取帧失败:', (e && e.message) || e);
                }
            }

            try {
                if (!blob || blob.size === 0) {
                    throw new Error(AEI18n.t('无法读取渲染帧文件: ') + filePath);
                }
                return new File([blob], fileName, { type: 'image/png' });
            } finally {
                // 无论读取成功还是失败，临时预览帧都删除，避免残留
                if (/^ae_preview_\d+\.png$/i.test(fileName) && typeof AEFS !== 'undefined' && AEFS.deleteFile) {
                    try { AEFS.deleteFile(filePath).catch(function () {}); } catch (_) {}
                }
            }
        }

        async function uploadImage(blob, filename) {
            return await service.uploadImage(blob, filename);
        }

        // 兼容入口：只收 **API 格式** 文本（模板引擎的原始读取器）。新调用方一律走
        // importWorkflowFile —— 它接受 UI 格式（编辑器 Save）并经 uiToApi 转换。
        function loadCustomWorkflow(jsonString) {
            var custom = engine.loadCustomWorkflow(jsonString);
            _notifyCanvasTemplatesChanged();
            currentTemplate = custom;
            return custom;
        }

        /**
         * 手动导入工作流文件（view「导入工作流」入口）。
         * UI 格式（编辑器 Save）自动经 customWorkflow.normalizeWorkflow 转换后再注册
         * （需已连接 ComfyUI 取 /object_info）；API 格式直通。失败返回结构化 error，
         * 不注册半成品（调用方渲染可见报错）。
         * @returns {{ok:true, data:{template, converted, skipped?}} | {ok:false, error:{code, message}}}
         */
        async function importWorkflowFile(rawJson, fileName) {
            if (!engine) return { ok: false, error: { code: 'NOT_READY', message: AEI18n.t('ComfyUI 模块尚未初始化') } };
            var client = (global.AEComfyUI && global.AEComfyUI.customWorkflow) ? global.AEComfyUI.customWorkflow : null;
            if (!client) return { ok: false, error: { code: 'MODULE_MISSING', message: AEI18n.t('customWorkflow 模块未加载') } };
            var res = await client.normalizeWorkflow(rawJson, { service: service, requireCatalog: true });
            if (!res.ok) return res;
            var custom = engine.loadCustomWorkflow(JSON.stringify(res.data.workflow));
            var name = String(fileName || '').replace(/\.json$/i, '');
            if (name) custom.name = name;   // 与目录加载命名口径一致（文件名去后缀）
            _notifyCanvasTemplatesChanged();
            currentTemplate = custom;
            // skipped：转换器跳过的「缺目录界面控制节点」明细（视图层给可见提示）
            return { ok: true, data: { template: custom, converted: res.data.converted, skipped: res.data.skipped || [] } };
        }

        /**
         * 落盘导入的工作流。主目录 <数据目录>\comfyui\workflows\<name>.json 存
         * **转换后的 API 格式**（目录加载零转换、离线可用），用户原件存同目录 originals\
         * <name>.json 保留可追溯（originals/ 不被 *.json 扫描命中——listFiles 不递归）。
         * @returns {{ok:true, path:string} | {ok:false, message:string}}
         */
        async function saveWorkflowFile(rawJson, fileName) {
            var dir = resolveWorkflowDir();
            if (!dir) return { ok: false, message: AEI18n.t('数据目录未就绪，无法保存工作流文件') };
            var safeName = _safeWorkflowFileName(fileName);
            if (!safeName) return { ok: false, message: AEI18n.t('工作流文件名包含非法字符: ') + (fileName || '') };
            var client = (global.AEComfyUI && global.AEComfyUI.customWorkflow) ? global.AEComfyUI.customWorkflow : null;
            if (!client) return { ok: false, message: AEI18n.t('customWorkflow 模块未加载') };
            var res = await client.normalizeWorkflow(rawJson, { service: service, requireCatalog: true });
            if (!res.ok) return { ok: false, message: res.error.message };
            var dest = dir + '\\' + safeName;
            // 目录先建齐（逐级，见 _ensureWorkflowDirs）：workflows/ 还不存在时，写入
            // 通道必须自己补建父目录——桥非同步安全那一刻只能落 cep.fs/ExtendScript，
            // 而本机 cep.fs.mkdir 不可用（真机复现的成因链）。
            try { await _ensureWorkflowDirs(dir); } catch (_) {}
            var main = await _writeWorkflowText(dest, JSON.stringify(res.data.workflow, null, 2));
            if (!main.ok) {
                return { ok: false, message: AEI18n.t('写入失败') + (main.reason ? AEI18n.punct('（', ' (') + main.reason + AEI18n.punct('）', ')') : AEI18n.t('（磁盘或权限）')) + ': ' + dest };
            }
            // 原件备份：主目录文件已写好，备份失败只告警不翻转成功语义
            try {
                var orig = dir + '\\originals\\' + safeName;
                var backup = await _writeWorkflowText(orig, String(rawJson));
                if (!backup.ok) {
                    console.warn('[ComfyUI] 工作流原件备份写入失败（主目录文件已写好）: ' + orig
                        + (backup.reason ? ' — ' + backup.reason : ''));
                }
            } catch (e2) {
                console.warn('[ComfyUI] 工作流原件备份写入异常（主目录文件已写好）:', (e2 && e2.message) || e2);
            }
            return { ok: true, path: dest };
        }

        // 工作流文本写入：优先异步全链（Bridge 异步 → cep.fs → ExtendScript，AEFS.writeFile），
        // 该链的父目录创建是 **await 的** 且带 ExtendScript 回退；同步 writeFileSync 在
        // 「桥非同步安全 + cep.fs.mkdir 不可用」的机器上补不出父目录（真机复现成因）。
        // 旧数据层/测试 mock 无 writeFile 时回落同步。
        // 失败原因取 AEFS.lastError（数据层最后一条错误：桥拒/通道全败/父目录建不出…），
        // 一律折叠成「磁盘或权限」时，用户与日志都看不到真因。
        // @returns {Promise<{ok:boolean, reason:string}>}
        function _writeWorkflowText(path, text) {
            var fail = function (reason) { return { ok: false, reason: reason || '' }; };
            if (typeof AEFS === 'undefined' || !AEFS) return Promise.resolve(fail(AEI18n.t('数据层不可用')));
            // AEFS.lastError() 是全局单值，可能残留上一条**无关**操作的错误（真机实测：写入
            // 失败后读到的是别的模块的「listFilesSync 目录不存在: …/agent/scripts」）。只认
            // 提到本次目标路径或其父目录的那条——否则宁缺勿错，退回通用文案，绝不把无关
            // 错误当成本次病因写进用户可见提示。
            var lastWhy = function () {
                var why = '';
                try { why = (typeof AEFS.lastError === 'function') ? String(AEFS.lastError() || '') : ''; } catch (_) { why = ''; }
                if (!why) return '';
                var norm = function (s) { return String(s).replace(/\//g, '\\').toLowerCase(); };
                var w = norm(why), d = norm(path), parent = d.replace(/\\[^\\]*$/, '');
                return (w.indexOf(d) >= 0 || (parent && w.indexOf(parent) >= 0)) ? why : '';
            };
            if (typeof AEFS.writeFile === 'function') {
                return Promise.resolve(AEFS.writeFile(path, text)).then(function (ok) {
                    return (ok === true) ? { ok: true, reason: '' } : fail(lastWhy());
                }, function (e) { return fail((e && e.message) || String(e)); });
            }
            try {
                var okSync = (typeof AEFS.writeFileSync === 'function') ? AEFS.writeFileSync(path, text) : false;
                return Promise.resolve((okSync === true) ? { ok: true, reason: '' } : fail(lastWhy()));
            } catch (e2) { return Promise.resolve(fail((e2 && e2.message) || String(e2))); }
        }

        // 目录加载报告（失败/待转换明细；view/测试用）。pending = 待 ComfyUI 连接后
        // 转换的 UI 格式文件；failures = 结构非法/转换失败/读取失败的文件。
        function getWorkflowLoadReport() {
            return {
                pending: _pendingUiWorkflows.map(function (p) { return p.name; }),
                failures: _workflowLoadFailures.map(function (f) { return { name: f.name, message: f.message }; })
            };
        }

        // 工作流链路的用户可见提示：入队 + 立即尝试交给 view 显示（面板未 bind 时
        // view 返回 false，提示留在队列里等 bind 后 flushWorkflowNotices 补发——
        // init 期的失败若只走 showError 会被 panel=null 静默吞掉）。
        function _queueWorkflowNotice(level, message) {
            console.warn('[ComfyUI] ' + message);
            _workflowNotices.push({ level: level, message: message });
            flushWorkflowNotices();
        }

        // 「缺目录界面控制节点被跳过」的可见提示文案（目录加载与补转换两处共用单一来源）：
        // 跳过是有意为之（这些节点不参与 API 执行），但不能无声——用户要知道模板少带了什么。
        // skipped 条目可能带 dropped（V3 隐藏输入值被丢弃，节点本身已安装）；
        // 两类分开说，避免把「值被丢弃」误报成「节点未安装」。
        function _queueSkippedWorkflowNotice(name, skipped) {
            if (!skipped || !skipped.length) return;
            var uiSkipped = [];
            var droppedCount = 0;
            for (var i = 0; i < skipped.length; i++) {
                if (skipped[i] && skipped[i].dropped) droppedCount++;
                else uiSkipped.push(skipped[i]);
            }
            if (uiSkipped.length) {
                _queueWorkflowNotice('info', name + ': 已跳过 ' + uiSkipped.length + ' 个未安装的界面控制节点: '
                    + uiSkipped.map(function (sk) { return sk.type; }).join('、'));
            }
            if (droppedCount) {
                _queueWorkflowNotice('info', name + ': ' + droppedCount + ' 个节点的隐藏输入值按默认值处理（已丢弃未命名尾部值）');
            }
        }

        function flushWorkflowNotices() {
            if (!_workflowNotices.length) return 0;
            var view = global.AEComfyUI && global.AEComfyUI._view;
            if (!view || typeof view.showWorkflowNotice !== 'function') return 0;
            var rest = [];
            var shown = 0;
            for (var i = 0; i < _workflowNotices.length; i++) {
                var n = _workflowNotices[i];
                if (view.showWorkflowNotice(n.level, n.message) === true) shown++;
                else rest.push(n);
            }
            _workflowNotices = rest;
            return shown;
        }

        async function saveSettings(newSettings) {
            // 注：工作流目录已固定为 resolveWorkflowDir()，saveSettings 不再收写 workflowDir。
            // 存量设置键不清理（不再读它即无影响）；若要清掉需显式传 workflowDir: undefined
            //（JSON.stringify 丢弃 undefined 值，等价删键）——本实现选择不清理。
            // 拦截外网地址：仅允许本机/内网 ComfyUI
            if (newSettings.host && global.AEComfyUI && typeof global.AEComfyUI.isPrivateHost === 'function'
                && !global.AEComfyUI.isPrivateHost(newSettings.host)) {
                throw new Error(AEI18n.t('已拦截外网 ComfyUI 地址（') + newSettings.host + AEI18n.t('）：仅允许本机/内网地址（如 127.0.0.1、192.168.x.x、10.x.x.x、172.16-31.x.x）'));
            }
            var oldSettings = await getSettings();
            if (settingsStore && typeof settingsStore.setModuleSettings === 'function') {
                // 消费落盘回执——setModuleSettings 写失败 resolve false（配额满/加密异常，
                // 见 settingsStore）；丢弃时视图层仍弹「模块设置已保存」，
                // 重启后设置回退而用户以为已保存。抛错走视图层既有 error 分支。
                var _persisted = await settingsStore.setModuleSettings('comfyui', newSettings);
                if (_persisted === false) throw new Error(AEI18n.t('设置写入持久层失败（存储配额满或加密异常），本次未保存'));
            }
            // 如果 host/port 变化，断开旧连接并重建
            if (service && typeof service.updateEndpoint === 'function') {
                if (newSettings.host !== oldSettings.host || newSettings.port !== oldSettings.port) {
                    service.updateEndpoint(newSettings.host, newSettings.port);
                    // modelRegistry 的 schema 缓存（_schemaCache，按 classType 键）
                    // 属于旧端点的 ComfyUI 实例——updateEndpoint 只清 service 的
                    // objectInfoCache，schema 缓存不联动清理则新端点继续命中旧实例的
                    // 节点定义（参数集/可选值漂移，提交时新端点报验证错误）。清空后
                    // 由 warmupSchemas 重新预热（与 connect() 路径同语义）。
                    if (_modelRegistry && typeof _modelRegistry.clearSchemaCache === 'function') {
                        _modelRegistry.clearSchemaCache();
                    }
                    if (engine && typeof engine.warmupSchemas === 'function') {
                        engine.warmupSchemas().catch(function () {});
                    }
                    try {
                        await service.connect();
                        if (global.AEComfyUI._view) global.AEComfyUI._view.updateConnectionStatus(true);
                        // 换端点后连上同样补转换（pending 项来自固定目录，与端点无关）
                        _refreshCatalogThenRetryPending();
                    } catch (e) {
                        if (global.AEComfyUI._view) global.AEComfyUI._view.updateConnectionStatus(false);
                    }
                }
            }
        }

        function removeResult(globalIndex) {
            if (globalIndex >= 0 && globalIndex < currentResults.length) {
                var r = currentResults[globalIndex];
                if (r.url) URL.revokeObjectURL(r.url);
                currentResults.splice(globalIndex, 1);
            }
        }

        function destroy() {
            currentResults.forEach(function (r) {
                if (r.url) URL.revokeObjectURL(r.url);
            });
            if (service) service.disconnect();
            service = null;
            engine = null;
            currentResults = [];
            // 清理 /history 轮询守护与表单超时定时器，防 destroy 后僵尸定时器
            Object.keys(_historyGuards).forEach(function (pid) { _stopHistoryGuard(pid); });
            _clearFormGenTimeout();
        }

        return {
            init: init,
            isReady: function () { return _ready; },
            destroy: destroy,
            connect: connect,
            testConnection: testConnection,
            selectTemplate: selectTemplate,
            generate: generate,
            generateRaw: generateRaw,
            registerPromptSource: registerPromptSource,  // LLM 直连路径登记 promptId 来源（含清理时机见 _pruneDonePrompts）
            getFormPromptIds: getFormPromptIds,          // 顶栏取消按钮按 form 来源取消（防并发生成取消错对象）
            getStaleFormPromptIds: getStaleFormPromptIds, // stale 在途任务（错误/超时/取消后仍在队列）纳入取消目标
            settleFormBatchCancel: settleFormBatchCancel, // 取消生效后的本地收尾（解锁 + form-stale，见函数注释）
            requestFormBatchCancel: requestFormBatchCancel, // 取消点击处同步置取消意图 + 本地收尾（不等取消 HTTP 往返）
            getTemplateFor: getTemplateFor,              // 只读取模板（不动用户表单选择）
            importToAE: importToAE,
            saveOnly: saveOnly,
            // 本项目资产库（工程目录文件）：生成产物长期保留/移出（工具 comfyui_project_asset 用）
            getProjectDir: getProjectDir,
            saveProjectAssets: saveProjectAssets,
            listProjectAssets: listProjectAssets,
            restoreProjectAssets: restoreProjectAssets,
            PROJECT_ASSET_SUBFOLDER: PROJECT_ASSET_SUBFOLDER,
            writeBlobToFile: writeBlobToFile,
            removeResult: removeResult,
            captureCurrentFrame: captureCurrentFrame,
            uploadImage: uploadImage,
            loadCustomWorkflow: loadCustomWorkflow,
            importWorkflowFile: importWorkflowFile,   // 手动导入（UI/API 双格式；失败不注册半成品）
            saveWorkflowFile: saveWorkflowFile,       // 落盘（主目录=API 格式 + originals/ 原件）
            loadWorkflowsFromDir: loadWorkflowsFromDir,
            getWorkflowLoadReport: getWorkflowLoadReport,
            flushWorkflowNotices: flushWorkflowNotices, // view bind 后拉取遗留提示（init 期面板未就绪时攒下的）
            resolveWorkflowDir: resolveWorkflowDir,   // 固定工作流目录（设置面板只读展示）
            saveSettings: saveSettings,
            getService: function () { return service; },
            getEngine: function () { return engine; },
            getRegistry: function () { return _modelRegistry; },  // 动态 enum：bootstrap 首用一次性直读（发现先于回调注册的竞态兜底）
            getCurrentTemplate: function () { return currentTemplate; },
            getResults: function () { return currentResults; },
            getSettings: getSettings,
            refreshModelList: refreshModelList,
            searchOfficialTemplates: searchOfficialTemplates,  // 官方模板浏览（表单 modal）
            fetchOfficialTemplate: fetchOfficialTemplate,      // 拉取+转换+注册（表单/画布即用）
            setCanvasProgressCallback: function (cb) { _canvasProgressCb = cb; }
        };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createComfyUIController = createComfyUIController;
})(window);
