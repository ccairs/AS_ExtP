// petHistory.js — 对话历史管理（256k token 窗口 + 后台摘要压缩）
(function (global) {
    'use strict';

    var TOKEN_WINDOW = 256000;
    var HISTORY_FILE = 'deepseekPet/history.json';
    var SUMMARY_FILE = 'deepseekPet/summary.json';
    // 摘要二次压缩阈值：_summary 每次超窗摘要只增不减，超阈值触发 LLM 整体压缩为一段，
    // 防长期使用摘要无限膨胀（摘要本为省 token，膨胀后反成 token 大户）
    var SUMMARY_MAX_CHARS = 16 * 1024;
    var _messages = [];
    var _summary = '';
    var _writeTimer = null;
    // 写盘串行链（对齐 sessionStore._saveNowChains 模式）。防抖只合并
    // 调度，不串行化已触发的写入：防抖到期触发的写链在途时 clear()/destroy()
    // 直接调 _writeToDisk 会并发起第二条链，mkdir→writeFile 乱序完成后旧快照
    // 后落位可回滚新数据（含 clear() 被静默撤销窗口）。所有写链排进同一条
    // promise 链，按发起顺序落盘
    var _writeChain = Promise.resolve();
    var _isSummarizing = false;
    // clear() 期间若正在进行摘要 LLM 调用，置为 true 让回调放弃结果，避免旧消息被"复活"
    var _summarizeAborted = false;
    var _isCompactingSummary = false;
    // 摘要压缩代际：clear() 时递增，使在途压缩的迟到回调失效
    // （原防复活检查 `!_summary && _messages.length===0` 在 clear 后又有新消息时不拦）
    var _compactEpoch = 0;
    // clear() 代际：初始 _loadFromDisk 读盘在途时 clear() 被调用，迟到的磁盘数据会经
    // loaded.concat(_messages) 复活已清空的消息、并直接回写 _summary——清空语义被静默
    // 破坏，复活数据还会被下一次防抖写盘持久化回磁盘
    var _clearEpoch = 0;
    // destroy 后拒绝新写入：销毁后 addMessage 会复活写盘定时器，产生僵尸写入
    var _destroyed = false;
    // 三态读取的「读失败态」——readFileResult/复核判定为通道故障（拿不到，
    // 而非文件不存在）时置位，此后拒绝一切覆盖写（见 _writeToDisk），防空内存态把读不出
    // 的 history/summary 整包覆盖。提示走既有 AEToast 通道一次（不新增 UI 组件）
    var _readFailed = false;
    var _readFailNotified = false;
    // 异步写链在途计数：flush 时若已有写在途，改走链尾排队而不是同步写——同步写绕过
    // _writeChain 会与在途的旧快照乱序，旧快照后落位会回滚最新数据。
    // 用计数而非布尔：链上可排队多条写，逐条完成递减，避免前一条完成误清后一条的在途态
    var _writeInFlight = 0;

    function estimateTokens(text) {
        if (!text || typeof text !== 'string') return 0;
        var cjkCount = 0;
        var otherCount = 0;
        for (var i = 0; i < text.length; i++) {
            var code = text.charCodeAt(i);
            if ((code >= 0x4E00 && code <= 0x9FFF) ||
                (code >= 0x3040 && code <= 0x30FF) ||
                (code >= 0xFF00 && code <= 0xFFEF)) {
                cjkCount++;
            } else {
                otherCount++;
            }
        }
        return Math.ceil(cjkCount + otherCount / 4);
    }

    function createHistory(eventBus) {

    function _estimateMessageTokens(msg) {
        if (!msg) return 0;
        var total = 0;
        if (msg.content) total += estimateTokens(msg.content);
        if (msg.role) total += estimateTokens(msg.role);
        if (msg.tool_calls) total += estimateTokens(JSON.stringify(msg.tool_calls));
        return total + 4;
    }

    function _getTotalTokens() {
        var total = estimateTokens(_summary);
        for (var i = 0; i < _messages.length; i++) {
            total += _estimateMessageTokens(_messages[i]);
        }
        return total;
    }

    function _getDataDir() {
        if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
            return global.AEShared.getDataDir().dir;
        }
        return '';
    }

    function _getFilePath(file) {
        var dir = _getDataDir();
        if (!dir) return null;
        return dir.replace(/\\/g, '/') + '/' + file;
    }

    var _loadPromise = null;

    function init() {
        _loadPromise = _loadFromDisk();
        return _loadPromise;
    }

    function whenReady() {
        return _loadPromise || Promise.resolve();
    }

    // ── 原子写助手（对齐素材库 folderStoreMixin.js 的
    // atomicWriteJson  定稿形态 + providerRegistry.js）──
    // 先写 <file>.tmp 再 rename 到正式名，写盘瞬间崩溃不再留下半截 JSON——
    // 原直写覆盖若被崩溃打断，下次启动 parse 失败即触发「静默重置」清空历史。
    // rename 失败（Bridge 下线走 ExtendScript 回退时 File.rename 不能覆盖既有目标）
    // 时绝不先删正式文件：旧文件挪 .recovery-<时间戳> 旁路，rename 成功才删旁路；
    // 仍失败则新旧两份内容都留在盘上（tmp 改名 .recovery- 留存，失败时绝不清 tmp）。
    // renameFile 不可用（降级环境/仅 mock writeFile 的旧测试）时回退直写。
    function _atomicWriteFile(filePath, content) {
        if (typeof AEFS.renameFile !== 'function') return AEFS.writeFile(filePath, content);
        var tmpPath = filePath + '.tmp';
        // 重试一旦启动，tmp 就可能成为新内容唯一副本——此后兜底不得再清理 tmp
        var _inRetry = false;
        var _recoverySeq = 0;
        function _nextRecoveryPath() {
            _recoverySeq = (_recoverySeq + 1) % 1000000000;
            return filePath + '.recovery-' + Date.now() + '-' + _recoverySeq;
        }
        function _cleanupTmp() {
            try { if (AEFS.deleteFile) AEFS.deleteFile(tmpPath).catch(function () {}); } catch (_) {}
        }
        // rename 失败兜底：tmp 是新内容唯一副本，绝不清理——改名 .recovery- 留存；
        // 挪到旁路的旧正式文件尽力放回原位（放回失败则旧内容留在旁路名下）
        function _preserveBothCopies(asidePath, movedOk) {
            var keepPath = _nextRecoveryPath();
            var park = AEFS.renameFile(tmpPath, keepPath).catch(function () {});
            var restore = movedOk ? AEFS.renameFile(asidePath, filePath).catch(function () {}) : null;
            return Promise.all([park, restore || Promise.resolve()]).then(function () { return false; });
        }
        return AEFS.writeFile(tmpPath, content).then(function (writeOk) {
            if (!writeOk) return false;
            return AEFS.renameFile(tmpPath, filePath).then(function (renameOk) {
                if (renameOk) return true;
                // rename 失败先复核 tmp 仍在——并发写交错时 tmp 缺失则放弃本次写入，
                // 绝不删正式文件（否则毁掉并发者刚落位的好数据）
                var recheck = (typeof AEFS.exists === 'function')
                    ? AEFS.exists(tmpPath) : Promise.resolve(true);
                return recheck.then(function (tmpAlive) {
                    if (!tmpAlive) return false;
                    // 旧正式文件先挪 .recovery-<时间戳> 旁路（而非直接删除），
                    // rename 成功后才删旁路旧文件；仍失败则两份内容都留在盘上
                    var asidePath = _nextRecoveryPath();
                    _inRetry = true;
                    var moveAside = AEFS.renameFile(filePath, asidePath).then(function (ok) { return ok; },
                        function () { return false; });
                    return moveAside.then(function (movedOk) {
                        return AEFS.renameFile(tmpPath, filePath).then(function (retryOk) {
                            if (!retryOk) return _preserveBothCopies(asidePath, movedOk);
                            if (movedOk && AEFS.deleteFile) {
                                try { AEFS.deleteFile(asidePath).catch(function () {}); } catch (_) {}
                            }
                            return true;
                        }, function () {
                            return _preserveBothCopies(asidePath, movedOk);
                        });
                    });
                });
            });
        }).catch(function () {
            if (!_inRetry) _cleanupTmp();   // 重试阶段 tmp 是唯一副本，绝不清理
            return false;
        });
    }

    // ── 损坏文件备份助手（对齐 providerRegistry.js 的 _backupCorruptProvidersFile 模式）──
    // parse 失败先把损坏原件改名备份（<file>.corrupt-<时间戳>）再重置——否则随后的
    // 防抖重写把空内存态覆盖回原路径，损坏原件不可恢复。备份失败仅告警不中断重置
    // （renameFile 不可用的降级环境跳过备份）。
    function _backupCorruptFile(filePath) {
        if (typeof AEFS.renameFile !== 'function') return Promise.resolve(false);
        var corruptBakPath = filePath + '.corrupt-' + Date.now();
        return AEFS.renameFile(filePath, corruptBakPath).then(function () {
            console.warn('[petHistory] 损坏文件已备份到: ' + corruptBakPath);
            return true;
        }).catch(function (e) {
            console.warn('[petHistory] 损坏文件备份失败: ' + e);
            return false;
        });
    }

    function _loadFromDisk() {
        var histPath = _getFilePath(HISTORY_FILE);
        var sumPath = _getFilePath(SUMMARY_FILE);
        if (!histPath) return Promise.resolve();
        if (typeof AEFS === 'undefined') return Promise.resolve();
        if (typeof AEFS.readFileResult !== 'function' && typeof AEFS.readFile !== 'function') return Promise.resolve();
        // 捕获 clear() 代际：读盘在途时用户清空历史（clear 已同步写空盘），
        // 迟到的磁盘旧数据整体作废，不得 concat 复活已清空的消息/摘要
        var epoch = _clearEpoch;

        try {
            var tasks = [_readFileTriState(histPath).then(function (res) {
                if (_clearEpoch !== epoch) return;  // 加载期间已 clear：磁盘旧数据作废
                if (res.status === 'failed') {
                    // 通道故障/拒绝：置读失败态（拒绝覆盖写）；连读都读不到故无法留
                    // .corrupt 备份（对齐定稿修复的「跳过备份」分支）
                    _markReadFailed(res.message);
                    return;
                }
                if (res.status !== 'ok' || !res.content) return;
                try {
                    var loaded = JSON.parse(res.content) || [];
                    // 加载期间可能有新 addMessage，合并而非覆盖
                    if (Array.isArray(loaded) && loaded.length > 0) {
                        // 旧消息可能无 id，补上以便支持单条删除
                        for (var k = 0; k < loaded.length; k++) {
                            if (!loaded[k].id) {
                                loaded[k].id = 'msg_' + Date.now() + '_' + k + '_' + Math.random().toString(36).substr(2, 6);
                            }
                        }
                        _messages = loaded.concat(_messages);
                    }
                } catch (e) {
                    // JSON 损坏：保留加载期间新 add 的内存消息（不清空），
                    // 并安排重写修复损坏文件，否则下次启动仍加载失败
                    console.warn('[petHistory] history.json parse failed, resetting: ' + e);
                    // 重置前先把损坏原件改名备份（history.json.corrupt-<时间戳>），
                    // 否则重写把内存态覆盖回原路径后原件不可恢复；备份 settle 后再
                    // 安排重写，保证「备份先行」——重写的 rename 不与备份的 rename 交错
                    _backupCorruptFile(histPath).then(function () {
                        _scheduleWrite();
                    });
                }
            })];
            if (sumPath) {
                tasks.push(_readFileTriState(sumPath).then(function (res) {
                    // 同 history.json 分支的代际守卫：读盘在途时 clear() 已同步写空盘，
                    // 迟到的磁盘旧摘要不得回写 _summary（否则清空语义被静默破坏，
                    // 复活的摘要还会经下一次防抖写盘持久化回磁盘）
                    if (_clearEpoch !== epoch) return;  // 加载期间已 clear：磁盘旧摘要作废
                    if (res.status === 'failed') { _markReadFailed(res.message); return; }
                    if (res.status === 'ok' && res.content) _summary = res.content;
                }));
            }
            // 全链异常兜底：意外 reject 也按读失败处理（保守——宁可拒绝写不可覆盖原文件）
            return Promise.all(tasks).catch(function (e) {
                _markReadFailed((e && e.message) || String(e));
            });
        } catch (e) {
            console.warn('[petHistory] load failed: ' + e);
            _markReadFailed((e && e.message) || String(e));
            return Promise.resolve();
        }
    }

    // ── 三态读取（readFileResult 优先）──
    // AEFS.readFile 把「文件不存在」与「通道故障」都折叠成 null，二者一律按
    // 「首次运行」继续用空内存；此后任何写触发（addMessage 防抖 2s / destroy flush）
    // 都会把空历史整包覆盖读不出的原文件，聊天历史不可恢复（无 .corrupt 备份）。
    // 三态判据：ok → 正常解析；NOT_FOUND → 首次运行旧语义（可写）；
    // CHANNEL_FAILURE/REJECTED/通道异常（拿不到/无法判定）→ 读失败态，拒绝覆盖写。
    // 旧式 AEFS（无 readFileResult，测试 mock/降级环境）：readFile 折叠 null 后用
    // existsResult（或 exists 折叠布尔）复核——文件在却读不出即通道故障；复核原语
    // 也不可用（无法判定）同样按读失败态处理（保守：宁可拒绝写不可覆盖原文件）
    function _readFileTriState(p) {
        if (typeof AEFS.readFileResult === 'function') {
            return AEFS.readFileResult(p).then(function (r) {
                if (r && r.ok === true) return { status: 'ok', content: r.data };
                if (r && r.error && r.error.code === 'NOT_FOUND') return { status: 'notfound' };
                return { status: 'failed', message: (r && r.error && r.error.message) || 'readFileResult 失败' };
            }, function (e) { return { status: 'failed', message: (e && e.message) || String(e) }; });
        }
        if (typeof AEFS.readFile !== 'function') return Promise.resolve({ status: 'failed', message: 'AEFS.readFile 不可用' });
        return AEFS.readFile(p).then(function (content) {
            // 空串是「成功读到 0 字节文件」而非失败（readFile 契约：失败恒 null），
            // summary.json 合法为空——按失败处理会把正常空文件误判成通道故障
            if (content !== null && content !== undefined) return { status: 'ok', content: content };
            if (typeof AEFS.existsResult === 'function') {
                return AEFS.existsResult(p).then(function (r) {
                    if (r && r.ok === true) return { status: 'failed', message: '文件存在但读取为空（通道故障）' };
                    if (r && r.error && r.error.code === 'NOT_FOUND') return { status: 'notfound' };
                    return { status: 'failed', message: (r && r.error && r.error.message) || 'existsResult 失败' };
                }, function (e) { return { status: 'failed', message: (e && e.message) || String(e) }; });
            }
            if (typeof AEFS.exists === 'function') {
                return AEFS.exists(p).then(function (ex) {
                    return ex ? { status: 'failed', message: '文件存在但读取为空（通道故障）' } : { status: 'notfound' };
                }, function (e) { return { status: 'failed', message: (e && e.message) || String(e) }; });
            }
            // 无任何存在性复核通道：无法判定「真没有」还是「拿不到」——按读失败态
            // 保守处理（宁可拒绝写不可覆盖原文件）
            return { status: 'failed', message: 'readFile 返回空且无存在性复核通道（无法判定）' };
        }, function (e) { return { status: 'failed', message: (e && e.message) || String(e) }; });
    }

    // 读失败态置位 + 一次用户可见提示（既有 AEToast 通道，不新增 UI 组件）
    function _markReadFailed(message) {
        _readFailed = true;
        console.warn('[petHistory] history/summary 读取失败（' + message + '），进入保护态：本次会话拒绝覆盖写盘，原文件保留');
        if (_readFailNotified) return;
        _readFailNotified = true;
        if (global.AEToast && typeof global.AEToast.warn === 'function') {
            try { global.AEToast.warn(AEI18n.t('桌宠聊天历史读取失败，已暂停保存以免覆盖原文件（请重启面板或检查 Bridge 连接后重试）')); } catch (_) {}
        }
    }

    function _scheduleWrite() {
        if (_destroyed) return;
        if (_writeTimer) clearTimeout(_writeTimer);
        _writeTimer = setTimeout(function () {
            _writeToDisk();
        }, 2000);
    }

    function _writeToDisk() {
        var histPath = _getFilePath(HISTORY_FILE);
        var sumPath = _getFilePath(SUMMARY_FILE);
        if (!histPath || typeof AEFS === 'undefined' || !AEFS.writeFile) return;
        if (_readFailed) {
            // 读失败态拒绝覆盖写——内存是空/未加载态，写回会清空读不出的
            // 原文件（含 clear() 直调本函数的路径：清空语义只作用于内存，不落盘覆盖）
            console.warn('[petHistory] 读取失败态：拒绝覆盖写 history/summary（原文件内容未读到，写回会清空历史）');
            return;
        }

        var dir = histPath.substring(0, histPath.lastIndexOf('/'));
        // JSON.stringify 加 try/catch 防止消息含循环引用抛错
        var histStr;
        try {
            histStr = JSON.stringify(_messages);
        } catch (e) {
            console.warn('[petHistory] JSON.stringify failed: ' + e);
            return;
        }
        // 快照仍在调用时捕获（语义不变），AEFS 写入排进 _writeChain 串行执行，
        // 保证并发触发的多条写链按发起顺序落盘（后发快照永远最后落位，不被旧快照回滚）
        var run = _writeChain.then(function () {
            // 加 .catch 防止 mkdir/writeFile reject 时 unhandledrejection
            // writeFile 需 return 进 Promise 链，否则写失败时产生 unhandledrejection
            // history/summary 均改走 .tmp→rename 原子写，写盘瞬间崩溃不再留半截 JSON
            return AEFS.mkdir(dir).then(function () {
                return _atomicWriteFile(histPath, histStr);
            }).then(function () {
                if (sumPath) return _atomicWriteFile(sumPath, _summary || '');
            });
        });
        _writeInFlight++;
        // 吞掉错误防止链断裂（对齐 sessionStore 模式）：失败仅告警，后续写入仍能排队
        _writeChain = run.catch(function (e) {
            console.warn('[petHistory] write to disk failed: ' + e);
        }).then(function () { _writeInFlight--; });
    }

    // 同步原子写（仅面板卸载 flush 用，与 petSettings._syncAtomicWrite 同构）：
    // writeFileSync(tmp) → renameFileSync 落位；rename 失败尽力直写正式名。
    // 同步原语缺失（旧 mock/降级 AEFS）或写失败返回 false，由调用方回落异步链
    function _syncAtomicWrite(filePath, content) {
        var tmpPath = filePath + '.tmp';
        if (typeof AEFS.renameFileSync === 'function') {
            if (AEFS.writeFileSync(tmpPath, content) && AEFS.renameFileSync(tmpPath, filePath)) return true;
            return !!AEFS.writeFileSync(filePath, content);
        }
        return !!AEFS.writeFileSync(filePath, content);
    }

    // 面板卸载前落盘（main.js beforeunload → petIndex.flush → controller.flush）：
    // 取消防抖窗口后优先同步写 history+summary（AEFS.writeFileSync → renameFileSync，
    // Bridge 同步 XHR / cep.fs 原生同步调用，beforeunload 内可完成）；同步原语不可用
    // 或已有异步写在途（同步写绕过 _writeChain 会与在途旧快照乱序）时回落异步链，
    // 该分支落盘与否取决于异步通道能否在卸载窗口内完成（边界如实记录）。
    // 不置 _destroyed、不清内存——beforeunload 可能被取消（用户取消关闭面板），
    // 模块须保持可用（对齐 engine/bootstrap.js sessionStore.flush 语义）
    function flush() {
        if (_destroyed) return false;
        if (_writeTimer) { clearTimeout(_writeTimer); _writeTimer = null; }
        if (_readFailed) {
            console.warn('[petHistory] 读取失败态：拒绝覆盖写 history/summary（flush 跳过）');
            return false;
        }
        var histPath = _getFilePath(HISTORY_FILE);
        var sumPath = _getFilePath(SUMMARY_FILE);
        var syncable = histPath && typeof AEFS !== 'undefined' &&
            typeof AEFS.writeFileSync === 'function' && !_writeInFlight;
        if (!syncable) {
            _writeToDisk();
            return false;
        }
        var histStr;
        try {
            histStr = JSON.stringify(_messages);
        } catch (e) {
            console.warn('[petHistory] JSON.stringify failed: ' + e);
            return false;
        }
        var dir = histPath.substring(0, histPath.lastIndexOf('/'));
        try { if (typeof AEFS.mkdirSync === 'function') AEFS.mkdirSync(dir); } catch (_) {}
        var ok = _syncAtomicWrite(histPath, histStr);
        if (sumPath) ok = _syncAtomicWrite(sumPath, _summary || '') && ok;
        if (!ok) {
            _writeToDisk();
            return false;
        }
        return true;
    }

    function addMessage(role, content, toolCalls) {
        if (_destroyed) return Promise.resolve();
        var msg = { id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6), role: role, content: content };
        if (toolCalls) msg.tool_calls = toolCalls;
        _messages.push(msg);
        _scheduleWrite();

        if (_getTotalTokens() > TOKEN_WINDOW && !_isSummarizing) {
            _summarizeOldMessages();
        }

        return Promise.resolve();
    }

    // 按 id 删除单条历史消息
    function deleteMessage(id) {
        if (_destroyed) return Promise.resolve(false);
        return new Promise(function (resolve) {
            for (var i = _messages.length - 1; i >= 0; i--) {
                if (_messages[i].id === id) {
                    _messages.splice(i, 1);
                    _scheduleWrite();
                    eventBus.emit('history:deleted', { id: id });
                    resolve(true);
                    return;
                }
            }
            resolve(false);
        });
    }

    function _summarizeOldMessages() {
        _isSummarizing = true;
        var overflowTokens = _getTotalTokens() - TOKEN_WINDOW;
        if (overflowTokens <= 0) { _isSummarizing = false; return; }

        var messagesToSummarize = [];
        var keptMessages = [];
        var accumulatedTokens = 0;

        for (var i = 0; i < _messages.length; i++) {
            var msgTokens = _estimateMessageTokens(_messages[i]);
            if (accumulatedTokens + msgTokens < overflowTokens) {
                messagesToSummarize.push(_messages[i]);
                accumulatedTokens += msgTokens;
            } else {
                keptMessages = _messages.slice(i);
                break;
            }
        }

        if (messagesToSummarize.length === 0) {
            _isSummarizing = false;
            return;
        }

        // Bug 修复：若 keptMessages 为空（所有消息都被纳入摘要），
        // LLM 失败时会 _messages = [].concat([]) = [] 丢失全部数据且无摘要
        // 处理策略：保留最后一条消息作为 keptMessages 兜底，避免完全清空
        if (keptMessages.length === 0 && messagesToSummarize.length > 0) {
            keptMessages = [messagesToSummarize[messagesToSummarize.length - 1]];
            messagesToSummarize = messagesToSummarize.slice(0, -1);
            if (messagesToSummarize.length === 0) {
                _isSummarizing = false;
                return;
            }
        }

        var llmChannel = null;
        if (global.AE_LLM && global.AE_LLM.llmChannel) llmChannel = global.AE_LLM.llmChannel;
        else if (global.AEAppContainer) {
            try { var ctx = global.AEAppContainer.getContext(); if (ctx && ctx.llmChannel) llmChannel = ctx.llmChannel; } catch (e) {}
        }

        // 已摘要消息的 id 集合：LLM 调用期间 _messages 可能被 addMessage/deleteMessage
        // 变更（最长 30s 窗口），回写时按 id 过滤而非按快照索引切片，
        // 避免索引错位导致已删消息复活 / 摘要期间新增的消息丢失
        var removedIds = {};
        for (var ri = 0; ri < messagesToSummarize.length; ri++) {
            if (messagesToSummarize[ri] && messagesToSummarize[ri].id) {
                removedIds[messagesToSummarize[ri].id] = true;
            }
        }

        if (!llmChannel) {
            // clear() 在摘要期间被调用 -> 放弃，不写回旧消息
            if (_summarizeAborted) {
                _isSummarizing = false;
                _summarizeAborted = false;
                return;
            }
            // LLM 通道完全不可用：与下方 LLM 失败分支同语义——保留 _messages 不删除
            // （否则待摘要消息被删而 _summary 无增长，历史静默丢失），
            // 仅复位 _isSummarizing，下次 addMessage 超窗会自动重试 _summarizeOldMessages
            _isSummarizing = false;
            return;
        }

        var convText = messagesToSummarize.map(function (m) {
            return m.role + ': ' + (m.content || '');
        }).join('\n');

        var context = {
            messages: [
                { role: 'system', content: '请将以下对话压缩为结构化摘要（关键话题、重要信息、待办事项），不超过200字。只输出摘要内容。' },
                { role: 'user', content: convText }
            ],
            options: { timeoutMs: 30000 }
        };

        // 解析 apiKey：与 petChat.js _resolveApiKey 逻辑一致
        // 缺失 apiKey 会导致 sendStream 发出 Authorization: Bearer (空)，API 返回 401
        try {
            if (global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function') {
                var appCtx = global.AEAppContainer.getContext();
                if (appCtx && appCtx.settingsStore && typeof appCtx.settingsStore.getGlobalSettings === 'function') {
                    appCtx.settingsStore.getGlobalSettings({}).then(function (globals) {
                        var providerId = globals.defaultProviderId || globals.defaultPlatform || 'deepseek';
                        var apiKey = _resolveApiKey(globals, providerId);
                        if (apiKey) context.apiKey = apiKey;
                        _doSummarize(llmChannel, context, removedIds);
                    }).catch(function () {
                        _doSummarize(llmChannel, context, removedIds);
                    });
                    return;
                }
            }
        } catch (_) {}
        _doSummarize(llmChannel, context, removedIds);
    }

    function _resolveApiKey(globals, providerId) {
        var registry = global.AE_LLM && global.AE_LLM.providerRegistry;
        var apiKeyField = null;
        if (registry && typeof registry.getApiKeyField === 'function') {
            try { apiKeyField = registry.getApiKeyField(providerId); } catch (e) {}
        }
        if (!apiKeyField || providerId === 'siliconflow') {
            return String(globals.apiKey || globals.siliconflowApiKey || '').trim();
        }
        return String(globals[apiKeyField] || globals.apiKey || '').trim();
    }

    // 摘要二次压缩：超 SUMMARY_MAX_CHARS 时把 _summary 整体交给 LLM 压缩为一段。
    // LLM 失败时本地截断保留尾部兜底（丢最早摘要，保最近记忆）。
    function _compactSummary(llmChannel) {
        if (_isCompactingSummary || !_summary || _summary.length <= SUMMARY_MAX_CHARS) return;
        _isCompactingSummary = true;
        var snapshot = _summary;
        // 捕获发起时的压缩代际：clear() 会递增，迟到的回调据此放弃写入
        var epoch = _compactEpoch;
        var context = {
            messages: [
                { role: 'system', content: '请把以下多段历史对话摘要压缩为一段精简摘要，保留关键话题、重要信息与待办事项，不超过1000字。只输出摘要内容。' },
                { role: 'user', content: snapshot }
            ],
            options: { timeoutMs: 30000 }
        };
        var proceed = function () {
            llmChannel.sendStream(context, {}).then(function (result) {
                _isCompactingSummary = false;
                // 压缩期间 clear() 被调用（代际已变）：放弃写入，防旧摘要"复活"
                if (epoch !== _compactEpoch) return;
                if (result && result.content && result.content.trim()) {
                    if (_summary === snapshot) {
                        _summary = result.content.trim();
                    } else {
                        // 罕见竞态：压缩期间又有新摘要追加，拼接新追加部分（宁多勿丢）
                        _summary = result.content.trim() + '\n' + _summary.slice(snapshot.length);
                    }
                    _scheduleWrite();
                } else {
                    // sendStream 从不 reject（失败返回 {error,message} 无 content），.catch 兜底永不触发；
                    // 压缩持续失败时摘要超阈值会无限增长。失败分支本地截断保留尾部（丢最早摘要，保最近记忆）
                    console.warn('[petHistory] 摘要压缩 LLM 调用失败，本地截断兜底: ' + ((result && (result.message || result.error)) || 'empty response'));
                    if (_summary.length > SUMMARY_MAX_CHARS) {
                        _summary = _summary.slice(-SUMMARY_MAX_CHARS);
                        _scheduleWrite();
                    }
                }
            }).catch(function () {
                _isCompactingSummary = false;
                // 同上：压缩期间 clear() 被调用则放弃本地截断兜底
                if (epoch !== _compactEpoch) return;
                if (_summary.length > SUMMARY_MAX_CHARS) {
                    _summary = _summary.slice(-SUMMARY_MAX_CHARS);
                    _scheduleWrite();
                }
            });
        };
        // apiKey 解析与 _summarizeOldMessages 一致（缺失会导致 401）
        try {
            if (global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function') {
                var appCtx = global.AEAppContainer.getContext();
                if (appCtx && appCtx.settingsStore && typeof appCtx.settingsStore.getGlobalSettings === 'function') {
                    appCtx.settingsStore.getGlobalSettings({}).then(function (globals) {
                        var providerId = globals.defaultProviderId || globals.defaultPlatform || 'deepseek';
                        var apiKey = _resolveApiKey(globals, providerId);
                        if (apiKey) context.apiKey = apiKey;
                    }).catch(function () {}).then(proceed);
                    return;
                }
            }
        } catch (_) {}
        proceed();
    }

    function _doSummarize(llmChannel, context, removedIds) {
        // 注意：不得在入口复位 _summarizeAborted —— clear() 可能在 getGlobalSettings
        // 异步间隙（_summarizeOldMessages 与 _doSummarize 之间）置位中止标志，
        // 入口复位会把该标志丢弃，迟到的摘要结果便绕过中止检查写回已清空的 _summary（旧摘要复活）。
        // 标志只在消费点（下方回调的中止分支）复位，且 _isSummarizing 守卫保证同一时刻仅一个摘要周期。

        // 按 id 移除已摘要的消息：摘要期间 _messages 可能被 addMessage/deleteMessage
        // 变更，按快照索引切片回写会索引错位（已删消息复活/新消息丢失）
        var applySummarizedState = function () {
            _messages = _messages.filter(function (m) {
                return !removedIds[m.id];
            });
            _scheduleWrite();
        };

        llmChannel.sendStream(context, {}).then(function (result) {
            if (_summarizeAborted) {
                _isSummarizing = false;
                _summarizeAborted = false;
                return;
            }
            if (result && result.content) {
                _summary = (_summary ? _summary + '\n' : '') + result.content.trim();
                // 追加后检查是否触发摘要二次压缩
                _compactSummary(llmChannel);
                applySummarizedState();
                if (global.AEDeepseekPet && global.AEDeepseekPet.controller) {
                    var bus = global.AEDeepseekPet.controller.getEventBus();
                    if (bus) bus.emit('history:summarized');
                }
            } else {
                // 摘要 LLM 失败（sendStream 失败时不 reject，返回 {error,message} 无 content）：
                // 必须跳过 applySummarizedState，否则被摘要消息被删而 _summary 未更新，历史静默丢失。
                // 保留 _messages；_isSummarizing 已复位，下次 addMessage 会自动重试
                console.warn('[petHistory] 摘要 LLM 调用失败，保留原消息待下次重试: ' + ((result && (result.message || result.error)) || 'empty response'));
            }
            _isSummarizing = false;
        }).catch(function () {
            if (_summarizeAborted) {
                _isSummarizing = false;
                _summarizeAborted = false;
                return;
            }
            // sendStream 从不 reject，此为防御分支：同样保留 _messages，避免摘要失败丢历史
            console.warn('[petHistory] 摘要 LLM 调用异常，保留原消息待下次重试');
            _isSummarizing = false;
        });
    }

    function getRecentMessages(limit) {
        var msgs = _messages.slice(-(limit || _messages.length));
        var result = [];
        if (_summary) {
            result.push({ role: 'system', content: '之前的对话摘要：\n' + _summary });
        }
        for (var i = 0; i < msgs.length; i++) {
            result.push(msgs[i]);
        }
        return Promise.resolve(result);
    }

    function getAllMessages() { return _messages.slice(); }
    function getSummary() { return _summary; }
    function getTotalTokens() { return _getTotalTokens(); }
    function getTokenWindow() { return TOKEN_WINDOW; }

    function search(query) {
        if (!query) return _messages.slice();
        var lower = String(query).toLowerCase();
        return _messages.filter(function (m) {
            // 防御性：避免 content 为 null/非字符串时抛 TypeError 中断 filter
            return m.content && typeof m.content === 'string' && m.content.toLowerCase().indexOf(lower) >= 0;
        });
    }

    function clear() {
        // 读失败保护态下内存历史不完整（读盘未成功），且 _writeToDisk/flush 一律
        // 拒绝落盘——若仍清空内存并发 history:deleted，界面清空而磁盘保留原文件，
        // 属谎报清空成功。此处直接拒绝（不清内存、不发事件），返回原因由 UI 明确提示。
        if (_readFailed) {
            console.warn('[petHistory] 读取失败态：拒绝清空（内存历史不完整且已暂停写入，暂不能清空）');
            return { ok: false, reason: AEI18n.t('当前历史未成功读取，已暂停写入，暂不能清空') };
        }
        _messages = [];
        _summary = '';
        // 递增压缩代际：使在途的摘要二次压缩回调失效，防迟到的压缩结果写回已清空的 _summary
        _compactEpoch++;
        // 递增读盘代际：使 _loadFromDisk 在途的 history/summary 读盘回调失效，
        // 防迟到的磁盘旧数据复活已清空的消息/摘要——该代际必须在此递增（否则
        // 从未被递增，两处守卫均为死代码——清空后旧数据照常复活）
        _clearEpoch++;
        // 若摘要 LLM 调用进行中，标记中止，避免回调把旧消息"复活"
        if (_isSummarizing) {
            _summarizeAborted = true;
        }
        _writeToDisk();
        if (eventBus) eventBus.emit('history:deleted', { id: null });
        return { ok: true };
    }

    function destroy() {
        // 先 flush 2s 防抖窗口内未落盘的消息，再清理定时器（flush 内部已处理异常，
        // 无同步/无在途写时 fire-and-forget）；读失败态下 flush 拒绝覆盖写
        flush();
        if (_writeTimer) { clearTimeout(_writeTimer); _writeTimer = null; }
        _isSummarizing = false;
        _isCompactingSummary = false;
        _destroyed = true;
    }

    return {
        init: init,
        whenReady: whenReady,
        addMessage: addMessage,
        deleteMessage: deleteMessage,
        getRecentMessages: getRecentMessages,
        getAllMessages: getAllMessages,
        getSummary: getSummary,
        getTotalTokens: getTotalTokens,
        getTokenWindow: getTokenWindow,
        search: search,
        clear: clear,
        flush: flush,
        destroy: destroy,
        estimateTokens: estimateTokens
    };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createHistory = createHistory;
    global.AEDeepseekPet.estimateTokens = estimateTokens;
})(window);
