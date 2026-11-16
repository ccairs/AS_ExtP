(function (global) {
    global.AEAssetsShared = global.AEAssetsShared || {};

    function _norm(f) { return String(f || '').replace(/^\/+|\/+$/g, ''); }

    // ── 清单原子写 + 损坏备份公共助手（对齐 ae-tools/effectsCache.js 的 .tmp → rename 模式）──
    // 三个 store（refStore/presetStore/projectAssetStore）与 folderStoreMixin 的清单
    // 落盘统一走这里。先写 <file>.tmp 再 rename 到正式名，写盘窗口内进程中断不再
    // 留下半截文件；rename 通道对已存在的目标文件可能失败（Bridge 的 fs.renameSync
    // 可覆盖，ExtendScript File.rename 回退不能），此时把旧正式文件挪到 .recovery-<时间戳>
    // 旁路后重试一次（旧文件删除的前置条件从「重试前」改为「rename 已
    // 验证成功」），重试成功才删旁路旧文件。全失败返回 false（调用方按写入失败处理），
    // 且绝不清理 tmp——改名 .recovery-<时间戳> 留存、旁路旧文件尽力放回原位，新/旧
    // 内容至少各有一份在盘上（若旧文件先删 + tmp 清理 → 两份同毁，下次 load
    // 按空态处理，refs.json 全部条目 / index.json 用户元数据不可恢复丢失）。
    // renameFile 不可用（极端降级环境/仅 mock writeFile 的旧测试）时回退直写，
    // 无原子写保护。

    // recovery 留存名生成——同毫秒多次尝试需互不相同（追加自增序号），
    // 旧文件旁路名与 tmp 留存名共用
    var _recoverySeq = 0;
    function _nextRecoveryPath(filePath) {
        _recoverySeq = (_recoverySeq + 1) % 1000000000;
        return filePath + '.recovery-' + Date.now() + '-' + _recoverySeq;
    }

    function atomicWriteJson(AEFS, filePath, content) {
        if (!AEFS || typeof AEFS.writeFile !== 'function') return Promise.resolve(false);
        if (typeof AEFS.renameFile !== 'function') return AEFS.writeFile(filePath, content);
        var tmpPath = filePath + '.tmp';
        // rename 失败后的重试一旦启动，tmp 就可能成为新内容的唯一副本
        // （旧正式文件已挪旁路）——此后任何异常兜底都不得再清理 tmp
        var _inRetry = false;
        function _cleanupTmp() {
            try { if (AEFS.deleteFile) AEFS.deleteFile(tmpPath).catch(function () {}); } catch (_) {}
        }
        // rename 失败兜底——tmp 是新内容唯一副本，绝不清理：改名
        // .recovery-<时间戳> 留存；挪到旁路的旧正式文件尽力放回原位（放回失败则
        // 旧内容留在旁路名下）。两步均 best-effort，只影响留痕形态，不改变结论。
        function _preserveBothCopies(asidePath, movedOk) {
            var keepPath = _nextRecoveryPath(filePath);
            var park = AEFS.renameFile(tmpPath, keepPath).catch(function () {});
            var restore = movedOk ? AEFS.renameFile(asidePath, filePath).catch(function () {}) : null;
            return Promise.all([park, restore || Promise.resolve()]).then(function () { return false; });
        }
        return AEFS.writeFile(tmpPath, content).then(function (writeOk) {
            if (!writeOk) return false;
            return AEFS.renameFile(tmpPath, filePath).then(function (renameOk) {
                if (renameOk) return true;
                // rename 失败先复核 tmp 仍在——并发写交错时（另一路写恰好
                // 消费了同名 tmp），失败原因是 tmp 缺失而非目标已存在，动正式文件会
                // 毁掉并发者刚落位的好数据。tmp 不在 → 放弃本次写入，绝不动正式文件。
                // （三 store 的写入已被 _serialized 队列串行保护，此处复核为纵深防御）
                var recheck = (typeof AEFS.exists === 'function')
                    ? AEFS.exists(tmpPath) : Promise.resolve(true);
                return recheck.then(function (tmpAlive) {
                    if (!tmpAlive) return false;
                    // 旧正式文件先挪到 .recovery-<时间戳> 旁路（而非直接删除），
                    // rename 成功后才删旁路旧文件；仍失败则两份内容都留在盘上
                    var asidePath = _nextRecoveryPath(filePath);
                    _inRetry = true;
                    // 旁路挪移失败/被拒都归一为 movedOk=false：旧正式文件原位未动，重试照常进行
                    var moveAside = AEFS.renameFile(filePath, asidePath).then(function (ok) { return ok; },
                        function () { return false; });
                    return moveAside.then(function (movedOk) {
                        return AEFS.renameFile(tmpPath, filePath).then(function (retryOk) {
                            if (!retryOk) return _preserveBothCopies(asidePath, movedOk);
                            if (movedOk && AEFS.deleteFile) {
                                // rename 已验证成功：旁路旧文件确认可删（fire-and-forget，对齐 _cleanupTmp）
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
            // 重试已启动后 tmp 可能是唯一幸存副本，绝不在此清理（注意：
            // 此处会把 rename 失败现场的 tmp 一并删除，两份内容同毁）
            if (!_inRetry) _cleanupTmp();
            return false;
        });
    }

    // ── 损坏清单保留为 <file>.corrupt.bak ──
    // load 侧解析失败时先把损坏文件挪到 .bak（用户元数据可手工恢复），再走空态；
    // 随后的重建/覆盖落盘不影响 .bak。rename 失败（如 .bak 已存在，rename 通道对
    // 已存在目标可能失败）时删旧 .bak 重试一次；再失败回退 copyFile（原件留在原位，
    // 由下次原子写替换）；任何失败仅返回 false 不抛（空态流程不因备份失败而中断）。
    function backupCorruptFile(AEFS, filePath) {
        var bakPath = filePath + '.corrupt.bak';
        if (!AEFS) return Promise.resolve(false);
        if (typeof AEFS.renameFile === 'function') {
            return AEFS.renameFile(filePath, bakPath).then(function (ok) {
                if (ok) return true;
                var del = (typeof AEFS.deleteFile === 'function')
                    ? AEFS.deleteFile(bakPath) : Promise.resolve(true);
                return del.then(function () {
                    return AEFS.renameFile(filePath, bakPath);
                }, function () { return false; }).then(function (ok2) {
                    // rename 双失败（.bak 被占用/通道异常）回退 copyFile——
                    // 损坏原件留在原位虽会被随后的空态重建覆盖，但 .bak 里已有副本可恢复
                    if (ok2) return true;
                    if (typeof AEFS.copyFile !== 'function') {
                        console.warn('[AEAssetsShared] 损坏文件备份失败: ' + filePath);
                        return false;
                    }
                    return AEFS.copyFile(filePath, bakPath).then(function (cpOk) {
                        if (!cpOk) console.warn('[AEAssetsShared] 损坏文件备份失败: ' + filePath);
                        return cpOk;
                    });
                });
            }, function () {
                console.warn('[AEAssetsShared] 损坏文件备份失败: ' + filePath);
                return false;
            });
        }
        if (typeof AEFS.copyFile === 'function') {
            return AEFS.copyFile(filePath, bakPath).then(function (ok) {
                if (!ok) console.warn('[AEAssetsShared] 损坏文件备份失败: ' + filePath);
                return ok;
            }, function () {
                console.warn('[AEAssetsShared] 损坏文件备份失败: ' + filePath);
                return false;
            });
        }
        return Promise.resolve(false);
    }

    // ── 清单三态读取（readFileResult 消费方单点）──
    // 清单类 JSON 读取统一走这里：presetStore/projectAssetStore 的 index.json
    // （接线）、refStore 的 refs.json 与本文件 _loadFoldersInner 的
    // .folders.json（接线）。注入的 AEFS 带
    // readFileResult（真实 AEFS）时三态直判：
    //   ok          → { state: 'ok', raw: text }     读得（含空文件 ok('')）
    //   NOT_FOUND   → { state: 'missing', raw: null } 真没有（首次启动，空重建合法）
    //   其他失败    → { state: 'failed', code, channel, message }
    //                 拿不到（CHANNEL_FAILURE）/不该读（REJECTED）——调用方必须中止
    //                 「按空重建 + 覆盖落盘」链：旧路径把读失败折叠为空索引，随后孤儿
    //                 重建 + _flushIndex 覆盖 index.json，用户维护的 notes 等元数据
    //                 永久丢失，且该分支无 .corrupt.bak 保护。
    // 旧式 fs（无 readFileResult，测试 mock/旧 AEFS）回退 readFile：null 按空重建
    // （真没有/拿不到不可分，旧行为逐字保持），异常原样上抛（load 中止，旧行为）。
    function readManifestThreeState(AEFS, filePath) {
        if (AEFS && typeof AEFS.readFileResult === 'function') {
            return AEFS.readFileResult(filePath).then(null, function () {
                // readFileResult 自身 reject（通道异常冒泡）同按拿不到处理
                return { ok: false, error: { code: 'CHANNEL_FAILURE', message: AEI18n.t('readFileResult 通道异常'), channel: null } };
            }).then(function (r) {
                if (r && r.ok === true) return { state: 'ok', raw: r.data };
                if (r && r.error && r.error.code === 'NOT_FOUND') return { state: 'missing', raw: null };
                return {
                    state: 'failed',
                    code: (r && r.error && r.error.code) || 'CHANNEL_FAILURE',
                    message: (r && r.error && r.error.message) || '',
                    channel: (r && r.error && r.error.channel) || null
                };
            });
        }
        return AEFS.readFile(filePath).then(function (raw) {
            // raw 可为 null（不存在/通道失败折叠态）——调用方 !raw 分支按空重建，
            // 与 readFile 直读行为逐字等价
            return { state: 'ok', raw: raw };
        });
    }

    // ── 归档（删除=归档，7 天后自动物理清理）──
    // 三库共用的常量与纯函数。归档区固定落在各库自己的 <base>/___archive__/ 下
    // （沿用 ___ 系统目录前缀，与 projectAssetStore 的 ___trash__ 同风格）。
    // 归档条目一律保留在索引中（archived/archivedAt），恢复即清标记——不引入
    // 文件夹级归档注册表：条目的 folder 字段本身就是恢复目标。
    var ARCHIVE_DIR_NAME = '___archive__';
    var ARCHIVE_TTL_MS = 7 * 24 * 3600 * 1000;

    // 'YYYYMMDD-HHmmss'（人类可读、可排序、与 cleanGarbage 的时间戳前缀同构）
    function archiveStamp(nowMs) {
        var d = new Date(nowMs == null ? Date.now() : nowMs);
        function p2(n) { return n < 10 ? '0' + n : String(n); }
        return String(d.getFullYear()) + p2(d.getMonth() + 1) + p2(d.getDate())
            + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
    }

    // 名称段安全网：store 层用，防索引被篡改后拼出穿越路径。
    // 与 treeView.invalidNameSeg（入口校验，规则更全）分工：这里是"永远在"的兜底，
    // 不做 % / 控制字符 / DOS 名等入口级规则，只保路径语义安全（分隔符、. / ..、空）。
    function badNameSeg(name) {
        var s = String(name == null ? '' : name);
        if (!s) return AEI18n.t('名称为空');
        if (s.indexOf('/') !== -1 || s.indexOf('\\') !== -1) return AEI18n.t('名称不能含路径分隔符');
        if (s === '.' || s === '..') return AEI18n.t('名称不能为 . 或 ..');
        return null;
    }

    // 文件夹前缀匹配（'' = 根，匹配所有）：f === prefix 或 f 在 prefix 之下
    function folderUnder(f, prefix) {
        var a = _norm(f), b = _norm(prefix);
        if (b === '') return true;
        return a === b || a.indexOf(b + '/') === 0;
    }

    // 归档条目判定 + 剩余毫秒（无效/缺失 archivedAt 一律按"未过期"处理：宁留不误删）
    function isArchived(it) { return !!(it && it.archived); }
    function archiveExpiredAt(it, nowMs) {
        if (!isArchived(it)) return false;
        var t = Date.parse(it.archivedAt);
        if (isNaN(t)) return false;
        return (nowMs - t) >= ARCHIVE_TTL_MS;
    }

    // 路径是否位于 <base>/___archive__/ 之下（清扫第三道防线：只删自己写进去的东西）
    function underArchiveDir(base, p) {
        var b = String(base || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        var f = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        if (!b || !f) return false;
        return f.indexOf(b + '/' + ARCHIVE_DIR_NAME + '/') === 0;
    }

    // opts: { AEFS, foldersPath, logTag }
    function createFolderStoreMixin(opts) {
        opts = opts || {};
        var _AEFS = opts.AEFS;
        var _foldersPath = opts.foldersPath || '';
        var _logTag = opts.logTag || '[store]';
        var _folders = [];
        // hasEntries(folderPath) → bool：由 store 注入，判定该文件夹下是否还有条目。
        // 未注入时 listEmptyFolders 退化为旧行为（返回全部显式创建记录）
        var _hasEntries = typeof opts.hasEntries === 'function' ? opts.hasEntries : null;
        // listEntries() → 条目数组（调用方保证已排除归档）：由 store 注入。
        // 注入后 listEmptyFolders 走**一次扫描**（O(条目数 + 文件夹记录数)），不再对每条
        // 文件夹记录全量扫条目（旧路径是 O(文件夹记录 × 条目数)：素材引用库 38759 条目
        // × 1842 条记录实测 2214ms，而折叠/展开每次都调它 → 左树点击卡 2.4s）。
        // 未注入时仍回退 hasEntries / 旧行为，单测与旧调用方不受影响。
        var _listEntries = typeof opts.listEntries === 'function' ? opts.listEntries : null;

        // 串行化：.folders.json 全局共享，并发写会互相覆盖丢数据
        var _fmQueue = Promise.resolve();
        function _serialized(fn) {
            var p = _fmQueue.then(fn, fn);
            _fmQueue = p.then(function () {}, function () {});
            return p;
        }

        async function _saveFolders() {
            // 原子写（.tmp → rename）——写盘窗口中断不再截断 .folders.json
            var ok = await global.AEAssetsShared.atomicWriteJson(_AEFS, _foldersPath, JSON.stringify(_folders));
            if (!ok) throw new Error(AEI18n.t('写入 .folders.json 失败'));
        }

        async function loadFolders() {
            return _serialized(function () { return _loadFoldersInner(); });
        }
        async function _loadFoldersInner() {
            // 三态读取（单点助手 readManifestThreeState，本文件内单点直调）——
            // 读失败（CHANNEL_FAILURE/REJECTED）时 throw 且不清空 _folders（读前不清空：
            // 中止加载后内存仍持旧记录，下次 createFolder 等写入不会用「空+新」覆盖
            // .folders.json——旧路径把读失败折叠为空记录，下一次文件夹操作即覆盖，
            // 全部空文件夹记录丢失）。NOT_FOUND（真没有）/ok('')（空文件）按空重建
            // （首次启动语义）。旧式 fs 回退 readFile：null 按空（旧行为）；异常上抛
            // （旧路径此处曾吞异常折叠为空——与 index.json 读路径语义对齐，不再静默）。
            var rs = await readManifestThreeState(_AEFS, _foldersPath);
            if (rs.state === 'failed') {
                throw new Error(AEI18n.t('.folders.json 读取失败(') + rs.code + (rs.channel ? '@' + rs.channel : '') + AEI18n.t(')，已中止加载以防覆盖'));
            }
            _folders.length = 0;
            if (!rs.raw) return;
            try {
                var parsed = JSON.parse(rs.raw);
                if (Array.isArray(parsed)) _folders.push.apply(_folders, parsed);
            } catch (e) {
                // 解析失败必须可见：静默清空后任意写入会把损坏状态覆盖回磁盘，记录永久丢失
                // 先保留 .corrupt.bak 再按空处理（旧记录可手工恢复）
                console.warn(_logTag + ' .folders.json 解析失败，已保留损坏文件为 ' + _foldersPath + '.corrupt.bak，空文件夹记录按空处理: ' + (e && e.message ? e.message : e));
                await global.AEAssetsShared.backupCorruptFile(_AEFS, _foldersPath);
            }
        }

        // 空文件夹判定：_folders 是"显式创建过"的文件夹记录（条目移入不移除记录，供清空后仍显示），
        // 其下有条目的文件夹不是空文件夹，必须过滤——否则 removeFolder 安全校验会被假空文件夹骗过
        //
        // 性能口径：注入 listEntries 时先**一次**遍历条目，把每个条目所在文件夹
        // 及其全部祖先登记进集合（前缀已登记即剪枝，同层/上层不会重复），再拿记录去查。
        // 复杂度 O(条目数 + 记录数)，与记录数无关；语义与逐条 hasEntries 等价
        // （hasEntries(fp) ≡ fp 或其子路径上有非归档条目 ≡ 集合里查得到 fp）。
        function _nonEmptyFolderSet() {
            var set = Object.create(null);
            var items = _listEntries() || [];
            for (var i = 0; i < items.length; i++) {
                var f = _norm(items[i] && items[i].folder);
                while (f) {
                    if (set[f]) break;   // 自身或祖先已登记 ⇒ 再往上必然都登记过
                    set[f] = true;
                    var k = f.lastIndexOf('/');
                    f = k > 0 ? f.slice(0, k) : '';
                }
            }
            return set;
        }
        function listEmptyFolders() {
            if (typeof _listEntries === 'function') {
                var nonEmpty = _nonEmptyFolderSet();
                return _folders.filter(function (fp) {
                    var n = _norm(fp);
                    // 根（空路径）不作为可归档的空文件夹：与其下有/无条目无关，一律按非空处理
                    return n ? !nonEmpty[n] : false;
                });
            }
            if (typeof _hasEntries !== 'function') return _folders.slice();
            return _folders.filter(function (fp) { return !_hasEntries(fp); });
        }

        async function createFolder(folderPath) {
            return _serialized(function () { return _createFolderInner(folderPath); });
        }
        async function _createFolderInner(folderPath) {
            var fp = _norm(folderPath);
            if (!fp) return false;
            if (badReservedFolderSeg(fp)) return false;   // 不得建系统保留目录（归档区/垃圾区）
            if (_folders.indexOf(fp) !== -1) return true;
            _folders.push(fp);
            try { await _saveFolders(); }
            catch (e) { _folders.pop(); throw e; }
            return true;
        }

        // 删除空文件夹记录（仅供 LLM 工具调用：仅当 _folders 包含该路径时删记录）
        // 对齐 projectAssetStore.deleteEmptyFolder / presetStore.deleteEmptyFolder 语义
        // 注意：此方法只删 .folders.json 中的虚拟记录，不动物理目录、不动条目
        async function deleteEmptyFolder(folderPath) {
            return _serialized(function () { return _deleteEmptyFolderInner(folderPath); });
        }
        async function _deleteEmptyFolderInner(folderPath) {
            var fp = _norm(folderPath);
            if (!fp) return false;
            var idx = _folders.indexOf(fp);
            if (idx === -1) return false;
            var removed = _folders.splice(idx, 1)[0];
            try { await _saveFolders(); }
            catch (e) { _folders.splice(idx, 0, removed); throw e; }
            return true;
        }

        // 归档整夹：移除该路径（含子路径）的全部空文件夹记录（返回被移除的记录）。
        // 与 syncFoldersOnRemove 的差别：本方法 await + 写盘失败抛错（回滚内存），
        // 供工具回执如实报告"已移除文件夹记录"；syncFoldersOnRemove 是删除后的
        // fire-and-forget 顺带清理，语义不同不合并。
        async function removeFolderRecords(folderPath) {
            return _serialized(function () { return _removeFolderRecordsInner(folderPath); });
        }
        async function _removeFolderRecordsInner(folderPath) {
            var fN = _norm(folderPath);
            if (!fN) return [];   // 根路径不参与（调用方已拒绝根归档）
            var removed = [];
            var kept = _folders.filter(function (fp) {
                if (folderUnder(fp, fN)) { removed.push(_norm(fp)); return false; }
                return true;
            });
            if (!removed.length) return [];
            var saved = _folders.slice();
            _folders.length = 0;
            _folders.push.apply(_folders, kept);
            try { await _saveFolders(); }
            catch (e) {
                _folders.length = 0;
                _folders.push.apply(_folders, saved);
                throw e;
            }
            return removed;
        }

        // 重命名文件夹后同步 _folders：改名匹配的空文件夹路径 + 去重
        async function syncFoldersOnRename(oldN, newN) {
            return _serialized(function () { return _syncFoldersOnRenameInner(oldN, newN); });
        }
        async function _syncFoldersOnRenameInner(oldN, newN) {
            // 快照回滚（对齐 _deleteEmptyFolderInner）：先改内存再写盘，写盘失败必须还原内存，
            // 否则内存态与磁盘态分裂，后续任意成功写盘会把不一致状态固化
            var saved = _folders.slice();
            var oldNL = oldN.length;
            for (var i = 0; i < _folders.length; i++) {
                if (_folders[i] === oldN) _folders[i] = newN;
                else if (oldNL > 0 && _folders[i].indexOf(oldN + '/') === 0)
                    _folders[i] = _norm(newN + '/' + _folders[i].slice(oldNL + 1));
                else if (oldNL === 0)
                    // 根目录重命名：所有空文件夹统一前缀到 newN 下
                    _folders[i] = _norm(newN + '/' + _folders[i]);
            }
            var seen = {};
            var filtered = _folders.filter(function (fp) { if (seen[fp]) return false; seen[fp] = true; return true; });
            _folders.length = 0;
            _folders.push.apply(_folders, filtered);
            try { await _saveFolders(); }
            catch (e) {
                _folders.length = 0;
                _folders.push.apply(_folders, saved);
                throw e;
            }
        }

        // 删除文件夹后同步 _folders：移除匹配的空文件夹路径
        // _under: function(f, prefix) → bool，调用方传自己的 _under 实现
        function syncFoldersOnRemove(fN, _under) {
            // 通过 _serialized 排队确保写入顺序，但 fire-and-forget（调用方不 await）
            _serialized(function () { return _syncFoldersOnRemoveInner(fN, _under); }).catch(function (e) {
                console.warn(_logTag + ' 删除文件夹后同步 .folders.json 失败: ' + (e && e.message ? e.message : e));
            });
        }
        async function _syncFoldersOnRemoveInner(fN, _under) {
            var changed = false;
            var filtered = _folders.filter(function (fp) {
                if (_under(fp, fN)) { changed = true; return false; }
                return true;
            });
            if (changed) {
                // 快照回滚（对齐 _deleteEmptyFolderInner）：写盘失败还原内存，防内存态与磁盘态分裂
                var saved = _folders.slice();
                _folders.length = 0;
                _folders.push.apply(_folders, filtered);
                try { await _saveFolders(); }
                catch (e) {
                    _folders.length = 0;
                    _folders.push.apply(_folders, saved);
                    throw e;
                }
            }
        }

        return {
            _folders: _folders,
            loadFolders: loadFolders,
            _saveFolders: _saveFolders,
            createFolder: createFolder,
            listEmptyFolders: listEmptyFolders,
            deleteEmptyFolder: deleteEmptyFolder,
            removeFolderRecords: removeFolderRecords,
            syncFoldersOnRename: syncFoldersOnRename,
            syncFoldersOnRemove: syncFoldersOnRemove
        };
    }

    global.AEAssetsShared.createFolderStoreMixin = createFolderStoreMixin;
    // 原子写/损坏备份助手导出——refStore/presetStore/projectAssetStore 复用
    // （本文件先于三个 store 加载，见 scripts.manifest.js 顺序）
    global.AEAssetsShared.atomicWriteJson = atomicWriteJson;
    global.AEAssetsShared.backupCorruptFile = backupCorruptFile;
    // 三态读取助手导出——presetStore/projectAssetStore 复用
    global.AEAssetsShared.readManifestThreeState = readManifestThreeState;
    // 归档常量与纯函数（三 store 共用；导出供 bootstrap 回执与单测注入 now 使用）
    global.AEAssetsShared.ARCHIVE_DIR_NAME = ARCHIVE_DIR_NAME;
    global.AEAssetsShared.ARCHIVE_TTL_MS = ARCHIVE_TTL_MS;
    global.AEAssetsShared.archiveStamp = archiveStamp;
    global.AEAssetsShared.folderUnder = folderUnder;
    global.AEAssetsShared.badNameSeg = badNameSeg;
    global.AEAssetsShared.badReservedFolderSeg = badReservedFolderSeg;
    global.AEAssetsShared.isArchived = isArchived;
    global.AEAssetsShared.archiveExpiredAt = archiveExpiredAt;
    global.AEAssetsShared.underArchiveDir = underArchiveDir;
    // 系统保留目录段：归档区/垃圾区由系统管理——文件夹路径不得含这些段，
    // 否则与系统目录物理同路径（预设库是实体目录），或留下树上无法操作的虚拟文件夹。
    // 入口防线在 UI（invalidNameSeg(folderOnly)）与 LLM 工具（_reservedFolderGuard）；
    // 这里是 store 层兜底（任何新调用方都不会踩坑）。命中返回该段名，无则 null。
    function badReservedFolderSeg(folderPath) {
        var segs = String(folderPath == null ? '' : folderPath)
            .replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
            .split('/').filter(function (x) { return x !== ''; });
        for (var i = 0; i < segs.length; i++) {
            if (segs[i] === ARCHIVE_DIR_NAME) return ARCHIVE_DIR_NAME;
            if (segs[i].indexOf('___trash__') === 0) return segs[i];
        }
        return null;
    }

    // 归档批量的两级上限（bootstrap 入口校验 + store 兜底共用）
    global.AEAssetsShared.ARCHIVE_MAX_IDS = 200;
    global.AEAssetsShared.ARCHIVE_MAX_FOLDER = 1000;
})(window);
