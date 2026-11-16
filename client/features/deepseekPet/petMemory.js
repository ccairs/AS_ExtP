// petMemory.js — 桌宠独立记忆系统（LLM function calling 触发写入）
(function (global) {
    'use strict';

    var MEMORY_FILE = 'deepseekPet/memories.json';
    var _memories = [];
    var _writeTimer = null;
    // 三态读取的「读失败态」——readFileResult/复核判定为通道故障（拿不到，
    // 而非文件不存在）时置位，此后拒绝一切覆盖写（见 _persist），防空记忆态把读不出的
    // 原文件整包覆盖。提示走既有 AEToast 通道一次（不新增 UI 组件）
    var _readFailed = false;
    var _readFailNotified = false;
    // 写失败的「一次用户可见提示」标志——_persist 防抖异步写失败若仅
    // console.warn（_atomicWriteFile resolve false 被忽略），LLM save_memory 回执仍
    // success，重启后记忆丢失且用户无感知。置位后本次会话只弹一次（与读失败同款）。
    var _writeFailNotified = false;

    function createMemory(eventBus) {
        var _loadPromise = null;

        function init() {
            _loadPromise = _loadFromDisk();
            return _loadPromise;
        }

        function whenReady() {
            return _loadPromise || Promise.resolve();
        }

        function _getDataDir() {
            if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                return global.AEShared.getDataDir().dir;
            }
            return '';
        }

        function _getFilePath() {
            var dir = _getDataDir();
            if (!dir) return null;
            return dir.replace(/\\/g, '/') + '/' + MEMORY_FILE;
        }

        // ── 原子写助手（对齐素材库 folderStoreMixin.js 的
        // atomicWriteJson  定稿形态 + providerRegistry.js）──
        // 先写 <file>.tmp 再 rename 到正式名，写盘瞬间崩溃不再留下半截 JSON——
        // 原直写覆盖若被崩溃打断，下次启动 parse 失败即触发「静默重置」清空记忆。
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
        // 防抖重写把空记忆覆盖回原路径，损坏原件不可恢复。备份失败仅告警不中断重置
        // （renameFile 不可用的降级环境跳过备份）。
        function _backupCorruptFile(filePath) {
            if (typeof AEFS.renameFile !== 'function') return Promise.resolve(false);
            var corruptBakPath = filePath + '.corrupt-' + Date.now();
            return AEFS.renameFile(filePath, corruptBakPath).then(function () {
                console.warn('[petMemory] 损坏文件已备份到: ' + corruptBakPath);
                return true;
            }).catch(function (e) {
                console.warn('[petMemory] 损坏文件备份失败: ' + e);
                return false;
            });
        }

        // ── 三态读取（readFileResult 优先）──
        // AEFS.readFile 把「文件不存在」与「通道故障」都折叠成 null，二者一律按
        // 「首次运行」继续用空内存；此后任何写触发（save 防抖 2s / destroy flush）都会把
        // 空记忆整包覆盖读不出的原文件，记忆不可恢复（无 .corrupt 备份）。三态判据：
        // ok → 正常解析；NOT_FOUND → 首次运行旧语义（可写）；CHANNEL_FAILURE/REJECTED/
        // 通道异常（拿不到/无法判定）→ 读失败态，拒绝覆盖写。旧式 AEFS（无 readFileResult，
        // 测试 mock/降级环境）：readFile 折叠 null 后用 existsResult（或 exists 折叠布尔）
        // 复核——文件在却读不出即通道故障；复核原语也不可用（无法判定）同样按读失败态
        // 处理（保守：宁可拒绝写不可覆盖原文件）
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
                // 空串是「成功读到 0 字节文件」而非失败（readFile 契约：失败恒 null）
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
            console.warn('[petMemory] memories.json 读取失败（' + message + '），进入保护态：本次会话拒绝覆盖写盘，原文件保留');
            if (_readFailNotified) return;
            _readFailNotified = true;
            if (global.AEToast && typeof global.AEToast.warn === 'function') {
                try { global.AEToast.warn(AEI18n.t('桌宠记忆读取失败，已暂停保存以免覆盖原文件（请重启面板或检查 Bridge 连接后重试）')); } catch (_) {}
            }
        }

        // 写失败一次性可见提示（与 _markReadFailed 同款通道）——异步原子写
        // resolve false / reject 时调用；防抖重试每次失败都调，但只弹一次，不打扰用户。
        function _markWriteFailed(message) {
            console.warn('[petMemory] memories.json 写入失败（' + message + '），新记忆可能无法持久化');
            if (_writeFailNotified) return;
            _writeFailNotified = true;
            if (global.AEToast && typeof global.AEToast.error === 'function') {
                try { global.AEToast.error(AEI18n.t('桌宠记忆保存失败，新记忆可能无法持久化（请检查 Bridge 连接或存储空间）')); } catch (_) {}
            }
        }

        function _loadFromDisk() {
            var p = _getFilePath();
            if (!p || typeof AEFS === 'undefined') return Promise.resolve();
            if (typeof AEFS.readFileResult !== 'function' && typeof AEFS.readFile !== 'function') return Promise.resolve();
            return _readFileTriState(p).then(function (res) {
                if (res.status === 'failed') {
                    // 通道故障/拒绝：置读失败态（拒绝覆盖写）；连读都读不到故无法留
                    // .corrupt 备份（对齐定稿修复的「跳过备份」分支）
                    _markReadFailed(res.message);
                    return;
                }
                if (res.status !== 'ok' || !res.content) return;
                try {
                    var loaded = JSON.parse(res.content) || [];
                    // 加载期间可能有新 save，合并而非覆盖
                    if (Array.isArray(loaded) && loaded.length > 0) {
                        _memories = loaded.concat(_memories);
                    }
                } catch (e) {
                    // JSON 损坏不得静默吞掉（对齐 petHistory 的处理）：
                    // 否则每次启动记忆全部静默失效、无任何反馈，且损坏文件
                    // 不会被重写修复——告警 + 安排重写，下次启动恢复正常加载
                    console.warn('[petMemory] memories.json parse failed, resetting: ' + e);
                    // 重写前先把损坏原件改名备份（memories.json.corrupt-<时间戳>），
                    // 否则空记忆覆盖回原路径后原件不可恢复；备份 settle 后再安排重写
                    _backupCorruptFile(p).then(function () {
                        _scheduleWrite();
                    });
                }
            }).catch(function (e) {
                // 意外异常也按读失败处理（保守——宁可拒绝写不可覆盖原文件）
                _markReadFailed((e && e.message) || String(e));
            });
        }

        // 同步原子写（仅面板卸载 flush 用，与 petSettings._syncAtomicWrite 同构）：
        // writeFileSync(tmp) → renameFileSync 落位；rename 失败尽力直写正式名。
        // 同步原语缺失（旧 mock/降级 AEFS）或写失败返回 false，由调用方回落异步链
        function _syncAtomicWrite(filePath, dir, content) {
            if (typeof AEFS.writeFileSync !== 'function') return false;
            try { if (typeof AEFS.mkdirSync === 'function') AEFS.mkdirSync(dir); } catch (_) {}
            var tmpPath = filePath + '.tmp';
            if (typeof AEFS.renameFileSync === 'function') {
                if (AEFS.writeFileSync(tmpPath, content) && AEFS.renameFileSync(tmpPath, filePath)) return true;
                return !!AEFS.writeFileSync(filePath, content);
            }
            return !!AEFS.writeFileSync(filePath, content);
        }

        // 写盘唯一出口：_readFailed 时拒绝覆盖写。
        // sync=true（面板卸载 flush）优先走 AEFS 同步通道原子写——Bridge 同步 XHR /
        // cep.fs 原生同步调用，beforeunload 内可完成；同步不可用时回落异步链并如实
        // 返回 false（异步 XHR 在卸载窗口可能来不及，边界见 petIndex.flush 注释）
        function _persist(sync) {
            var p = _getFilePath();
            if (!p || typeof AEFS === 'undefined' || !AEFS.writeFile) return false;
            if (_readFailed) {
                console.warn('[petMemory] 读取失败态：拒绝覆盖写 memories.json（原文件内容未读到，写回会清空记忆）');
                return false;
            }
            var dir = p.substring(0, p.lastIndexOf('/'));
            // JSON.stringify 加 try/catch 防止循环引用抛错
            var dataStr;
            try {
                dataStr = JSON.stringify(_memories);
            } catch (e) {
                console.warn('[petMemory] JSON.stringify failed: ' + e);
                _markWriteFailed('JSON 序列化失败');
                return false;
            }
            if (sync && _syncAtomicWrite(p, dir, dataStr)) return true;
            // 加 .catch 防止 mkdir/writeFile reject 时 unhandledrejection
            // 改走 .tmp→rename 原子写，写盘瞬间崩溃不再留半截 JSON
            // resolve false（写被拒/rename 全败）时补一次可见提示，不静默
            AEFS.mkdir(dir).then(function () {
                return _atomicWriteFile(p, dataStr);
            }).then(function (ok) {
                if (!ok) _markWriteFailed('写盘未成功');
            }).catch(function (e) {
                console.warn('[petMemory] write to disk failed: ' + e);
                _markWriteFailed((e && e.message) || String(e));
            });
            return false;
        }

        function _scheduleWrite() {
            if (_writeTimer) clearTimeout(_writeTimer);
            _writeTimer = setTimeout(function () {
                _writeTimer = null;
                _persist(false);
            }, 2000);
        }

        // 面板卸载前落盘（main.js beforeunload → petIndex.flush → controller.flush）：
        // 取消防抖窗口并同步写（AEFS.writeFileSync → renameFileSync 原子落位，见 _persist）。
        // 不清 _memories 内存态、不置销毁标志——beforeunload 可能被取消（用户取消关闭
        // 面板），模块须保持可用（对齐 engine/bootstrap.js sessionStore.flush 语义）。
        // 边界：同步通道不可用时回落异步写，能否在卸载窗口内完成取决于异步通道；
        // 若防抖已触发、异步写仍在途，同步写可能与其迟到完成乱序（卸载窗口极窄，
        // 模块无写链，重排风险与既有并发写同级）
        function flush() {
            if (_writeTimer) { clearTimeout(_writeTimer); _writeTimer = null; }
            return _persist(true);
        }

        function save(content, tags, importance) {
            return new Promise(function (resolve) {
                // 类型校验：LLM 工具调用可能传非字符串 content，强制转字符串避免后续 search 抛错
                var safeContent = (content == null) ? '' : String(content);
                var safeTags = Array.isArray(tags) ? tags.filter(function (t) { return typeof t === 'string'; }) : [];
                var entry = {
                    id: 'mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                    content: safeContent,
                    tags: safeTags,
                    importance: importance || 'medium',
                    createdAt: new Date().toISOString(),
                    source: 'llm'
                };
                _memories.push(entry);
                _scheduleWrite();
                eventBus.emit('memory:saved', { entry: entry });
                resolve(entry);
            });
        }

        function deleteMem(id) {
            return new Promise(function (resolve) {
                for (var i = _memories.length - 1; i >= 0; i--) {
                    if (_memories[i].id === id) {
                        _memories.splice(i, 1);
                        _scheduleWrite();
                        eventBus.emit('memory:deleted', { id: id });
                        resolve(true);
                        return;
                    }
                }
                resolve(false);
            });
        }

        function search(query) {
            if (!query) return _memories.slice();
            var lower = String(query).toLowerCase();
            return _memories.filter(function (m) {
                // 防御性：旧数据可能存在 content/tags 为 null，避免抛 TypeError 中断循环
                if (m.content && typeof m.content === 'string' && m.content.toLowerCase().indexOf(lower) >= 0) return true;
                if (Array.isArray(m.tags)) {
                    for (var i = 0; i < m.tags.length; i++) {
                        if (typeof m.tags[i] === 'string' && m.tags[i].toLowerCase().indexOf(lower) >= 0) return true;
                    }
                }
                return false;
            });
        }

        function getAll() { return _memories.slice(); }

        function getHighImportance() {
            return _memories.filter(function (m) { return m.importance === 'high'; });
        }

        function getByTag(tag) {
            if (!tag) return _memories.slice();
            return _memories.filter(function (m) {
                return Array.isArray(m.tags) && m.tags.indexOf(tag) >= 0;
            });
        }

        function getAllTags() {
            var tags = {};
            for (var i = 0; i < _memories.length; i++) {
                // Array.isArray 防御：旧数据 tags 可能为字符串（遍历字符）或 null（抛 TypeError）
                if (Array.isArray(_memories[i].tags)) {
                    for (var j = 0; j < _memories[i].tags.length; j++) {
                        tags[_memories[i].tags[j]] = true;
                    }
                }
            }
            return Object.keys(tags);
        }

        function destroy() {
            // 先 flush 防抖窗口内未落盘的记忆，再清理定时器（flush 内部已处理异常，
            // 无同步通道时回落异步）；读失败态下 flush 拒绝覆盖写
            flush();
            if (_writeTimer) { clearTimeout(_writeTimer); _writeTimer = null; }
            _memories = [];
        }

        return {
            init: init,
            whenReady: whenReady,
            save: save,
            delete: deleteMem,
            search: search,
            getAll: getAll,
            getHighImportance: getHighImportance,
            getByTag: getByTag,
            getAllTags: getAllTags,
            flush: flush,
            destroy: destroy
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createMemory = createMemory;
})(window);
