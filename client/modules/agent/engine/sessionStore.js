(function (global) {

    // 会话消息「读失败」哨兵——区别于 load 返回 null（文件不存在=新会话 /
    // JSON 损坏=留 .corrupt 备份后按空处理的既有语义）：文件在但读不出（读取通道
    // reject / 返回空）时 load 返回本对象，调用方（controller.switchSession /
    // appendTo）据此中止切换/拒绝追加起步，防止「按空会话导入→切走时整包覆盖」
    // 把原会话文件静默清空。
    var SESSION_READ_FAILED = { __readFailed: true };

    // ── ② 会话消息落盘失败的用户可见提示（跨 store 实例共享）──
    // 病灶：_doSave 对消息文件写失败只 resolve(false) 且无人检查，界面一切正常；
    // 关面板重开发现自上次成功写盘以来的整段对话消失。修复后写失败经返回值上报
    // （saveNow/appendTo/flush 透传），并由本模块直接给一次可见 toast（AEToast 是
    // 全局提示通道，无需调用方接线）。去重策略：同一错误连续发生只提示一次
    // （2s 窗口兜底多 store/多路径短时连弹）；成功写入即清除失败标记，下次失败
    // 可再提示一次。仅提示，不自动重试、不中断对话流程（失败不 reject）。
    var SAVE_FAILURE_TOAST_DEDUPE_MS = 2000;
    var _saveFailureToastAt = 0;

    function _noteSaveFailure() {
        var now = Date.now();
        if (_saveFailureToastAt && (now - _saveFailureToastAt) < SAVE_FAILURE_TOAST_DEDUPE_MS) return;
        _saveFailureToastAt = now;
        try {
            if (global.AEToast && typeof global.AEToast.show === 'function') {
                global.AEToast.show(AEI18n.t('会话保存失败（磁盘空间/文件占用/权限），本次内容可能未落盘，请检查后重试'), 'error', { autoHideMs: 6000 });
            }
        } catch (_) {}
        console.warn('[SessionStore] 会话消息写入失败（已向用户提示，未自动重试）');
    }

    function _clearSaveFailure() {
        // 清除失败标记：恢复成功后再次失败可再提示一次
        _saveFailureToastAt = 0;
    }

    // ── 索引原子写助手──
    // 同源照抄素材库 client/modules/assets/shared/folderStoreMixin.js:27 的
    // atomicWriteJson（定稿形态；画布 / nodegenStore.js /
    // providerRegistry.js 同族）：先写 <file>.tmp 再 rename 到正式名，写盘瞬间
    // 崩溃不再留下半截 JSON。rename 失败（Bridge 下线走 ExtendScript 回退时
    // File.rename 不能覆盖既有目标）时不删正式文件——旧文件先挪 .recovery-<时间戳>
    // 旁路，rename 成功才删旁路；仍失败则新旧两份内容都留在盘上（tmp 改名
    // .recovery- 留存，绝不在失败时清理唯一副本）。renameFile 不可用（降级环境/
    // 仅 mock writeFile 的旧测试）时回退直写，行为不变。
    // tmp 路径 = filePath + '.tmp'，同一文件的原子写**必须由调用方串行化**
    // （索引侧见 createSessionStore 内 _indexWriteQueue；消息文件侧见
    // _enqueueMsgWrite；归档侧为 _archiveChains）：并发两次原子写会互相消费
    // 对方的 tmp，后完成者 rename 静默失败、失败分支还可能把在途 tmp 挪成
    // .recovery-* 残骸。此处不做内部锁（锁放调用侧更直白，各文件一条写入方）。
    var _atomicRecoverySeq = 0;
    function _atomicWriteJson(fs, filePath, content) {
        if (!fs || typeof fs.writeFile !== 'function') return Promise.resolve(false);
        if (typeof fs.renameFile !== 'function') return fs.writeFile(filePath, content);
        var tmpPath = filePath + '.tmp';
        // 重试一旦启动，tmp 就可能成为新内容唯一副本——此后兜底不得再清理 tmp
        var _inRetry = false;
        function _nextRecoveryPath() {
            _atomicRecoverySeq = (_atomicRecoverySeq + 1) % 1000000000;
            return filePath + '.recovery-' + Date.now() + '-' + _atomicRecoverySeq;
        }
        function _cleanupTmp() {
            try { if (fs.deleteFile) fs.deleteFile(tmpPath).catch(function () {}); } catch (_) {}
        }
        // rename 失败兜底：tmp 是新内容唯一副本，绝不清理——改名 .recovery- 留存；
        // 挪到旁路的旧正式文件尽力放回原位（放回失败则旧内容留在旁路名下）。
        // .recovery-<时间戳>-<序号> 是仓库既有留存命名（folderStoreMixin.js
        // 同款，数据目录诊断可识别）；索引持久化已串行化，仅真实 rename
        // 失败（非并发错踩）才走到这里，是留痕而非残骸。
        function _preserveBothCopies(asidePath, movedOk) {
            var keepPath = _nextRecoveryPath();
            var park = fs.renameFile(tmpPath, keepPath).catch(function () {});
            var restore = movedOk ? fs.renameFile(asidePath, filePath).catch(function () {}) : null;
            return Promise.all([park, restore || Promise.resolve()]).then(function () { return false; });
        }
        return fs.writeFile(tmpPath, content).then(function (writeOk) {
            // 写 tmp 失败（返回 false）同样清理自己创建的 tmp——通道可能
            // 落了半截内容，不清理就会成为 .tmp 残骸（正式文件未动，可安全删）
            if (!writeOk) { _cleanupTmp(); return false; }
            return fs.renameFile(tmpPath, filePath).then(function (renameOk) {
                if (renameOk) return true;
                // rename 失败先复核 tmp 仍在——并发写交错时 tmp 缺失则放弃本次写入，
                // 绝不动正式文件（否则毁掉并发者刚落位的好数据）
                var recheck = (typeof fs.exists === 'function')
                    ? fs.exists(tmpPath) : Promise.resolve(true);
                return recheck.then(function (tmpAlive) {
                    if (!tmpAlive) return false;
                    var asidePath = _nextRecoveryPath();
                    _inRetry = true;
                    var moveAside = fs.renameFile(filePath, asidePath).then(function (ok) { return ok; },
                        function () { return false; });
                    return moveAside.then(function (movedOk) {
                        return fs.renameFile(tmpPath, filePath).then(function (retryOk) {
                            if (!retryOk) return _preserveBothCopies(asidePath, movedOk);
                            if (movedOk && fs.deleteFile) {
                                // rename 已验证成功：旁路旧文件确认可删（fire-and-forget）
                                try { fs.deleteFile(asidePath).catch(function () {}); } catch (_) {}
                            }
                            return true;
                        }, function () {
                            return _preserveBothCopies(asidePath, movedOk);
                        });
                    });
                });
            });
        }).catch(function () {
            if (!_inRetry) _cleanupTmp();
            return false;
        });
    }

    // ── ① mode 白名单 + 未命中时**显式失败** ──
    // mode 是会话落盘的唯一命名空间维度（`<数据Dir>/agent/sessions/<mode>/` 与
    // `<mode>_index.json` 由它拼出）。未命中白名单即硬失败：团队模式
    // （team-director / team-ae / team-glsl / team-asset）的 mode 一旦拼错，四条 lane 的会话会写进
    // Script 的目录与索引——真机表现是「团队会话出现在 Script 列表里」且**没有任何报错信号**，
    // 两个模式的会话互相串台且极难定位。现改为显式失败（工厂内直接抛错：拿不到 store 实例，
    // 也就不可能落到别家命名空间），错误对象带 code/mode/allowed 三个字段供程序化识别，
    // 抛之前先经注入的告警通道留一行痕。
    // 为什么抛错而不是返回失败对象：三处生产调用点（engine/bootstrap.js:1136 / :1141 / :1148、
    // comfyui/canvas/canvasIndex.js:5062）全是字面量 mode 且**不检查返回值**——返回失败对象
    // 只会在后续调用点退化成更难懂的 TypeError，或者更糟：一个看似可用、实际到处 no-op 的 store。
    // 既有合法 mode 的行为逐字节不变（白名单成员直接通过，命名空间拼接仍是 :127-128 那两行）。
    // 'team-asset' 是第四条 lane（美术执行）的 mode：显式映射，与 lane id 'asset-gen' 不同名——
    // 不能靠 'team-' + laneId 拼（那会得到 team-asset-gen，不在白名单 ⇒ 工厂硬失败）。
    var _ALLOWED_MODES = {
        'script': true, 'agent': true, 'shader': true, 'comfyui': true,
        'team-director': true, 'team-ae': true, 'team-glsl': true, 'team-asset': true
    };

    function assertSupportedMode(mode, warn) {
        if (_ALLOWED_MODES[mode]) return;
        var allowed = Object.keys(_ALLOWED_MODES);
        if (typeof warn === 'function') {
            warn('[SessionStore] 非法 mode "' + String(mode) + '"：拒绝创建 store（不再静默回落 script）。允许：' + allowed.join(' / '));
        }
        var err = new Error('[SessionStore] 非法 mode "' + String(mode) + '"（允许：' + allowed.join(' / ') + '）');
        err.code = 'INVALID_SESSION_MODE';
        err.mode = mode;
        err.allowed = allowed;
        throw err;
    }

    // 告警通道：opts.onWarn → opts.log → console.warn（缺省）。注入方自己抛错一律吞掉——
    // 告警是观测手段，不该反过来打断会话链路（损坏/非法 mode 两条新信号走它，
    // 既有告警保持各自的 console.warn 原样，不动既有留痕口径）。
    function _mkWarn(opts) {
        var sink = (typeof opts.onWarn === 'function') ? opts.onWarn
            : ((typeof opts.log === 'function') ? opts.log : null);
        if (!sink) return function (msg) { console.warn(msg); };
        return function (msg) { try { sink(msg); } catch (_) {} };
    }

    function createSessionStore(options) {
        var opts = options || {};
        var fs = opts.fs;
        var dataDir = opts.dataDir || 'agent';
        var mode = opts.mode || 'script';
        var _warn = _mkWarn(opts);
        // mode 白名单校验：既防 mode 含 ../ 等特殊字符导致路径越界，也防「团队 mode 拼错」
        // 落进别家命名空间（未命中 = 显式失败，见 assertSupportedMode 注释）
        assertSupportedMode(mode, _warn);
        var debounceMs = opts.debounceMs !== undefined ? opts.debounceMs : 2000;
        // 上下文压缩归档（早期消息副本）上限：超过则丢弃最旧的，防磁盘/token 无限增长
        var maxArchiveMessages = opts.maxArchiveMessages !== undefined ? Number(opts.maxArchiveMessages) : 500;

        var sessionsDir = dataDir + '/sessions/' + mode;
        var indexFile = dataDir + '/sessions/' + mode + '_index.json';

        var _index = null;
        var _writeTimer = null;
        var _pendingSave = null;
        var _ready = false;
        var _readyPromise = null;
        // 已删除会话 id 集合（仅内存态）：阻断 deleteSession 之后仍在途/新发起的
        // 直写（appendTo/saveNow/saveArchive 链）复写已删会话文件。id 含时间戳+随机
        // 段，新建会话不会与已删 id 碰撞；重启后集合清空（磁盘索引亦无该会话）。
        var _deletedIds = {};
        // 最近一次 load(id) 是否返回读失败哨兵（__readFailed）——flushSync **与 _doSave** 消费：
        // 读不出的消息文件是唯一副本，任何整包写（同步兜底 / 防抖 save / 直写链）都不得覆盖。
        // 正常读到/确认不存在（含损坏已备份的 null）会清除该标记。
        // 每条写入路径都必须读该标记：只挡防抖那一条
        // 路 ⇒ switchSession 的直写、自动压缩落盘、清空对话三条路仍能把「读不出的唯一副本」覆盖掉。
        var _readFailedIds = {};
        // 每个 id 只告警一次（用户/排障要看得见「这个会话没在写盘」，又不能刷屏）
        var _readFailedWarned = {};

        // ── 损坏会话保护态（消除 `.corrupt → null` 与 `__readFailed` 的不对称）──
        // 不对称之处：读通道失败（__readFailed 哨兵）会阻断覆盖性写入，而 **JSON 解析失败**
        // 只是留一份 .corrupt-<ts>.bak 后按「空会话」返回 null——调用方照常当新会话导入，
        // 下一条消息触发的防抖 save 立刻用空/新内容整包覆盖原文件：用户的会话在界面上被
        // **静默清空**（副本在磁盘上，但用户在面板里看不到、也拿不回来）。
        // 现在损坏侧补上同款防线（按 id 记，与 _readFailedIds 同构）：
        //   · 读到损坏（JSON.parse 失败，已留 .corrupt 副本）→ 本 id 进保护态，索引条目打
        //     `__corrupt: true`（可观测，经 getSession(id).__corrupt 读），并给**一次**告警；
        //   · 保护态下 _doSave / flushSync 拒绝**空内容**写入（返回 false + 一次告警）——
        //     「空会话覆写」正是静默清空那一步；
        //   · **非空**内容照常写入（用户此后新发的消息必须能落盘，否则保护态本身变成另一种
        //     静默丢数据），写入成功后解除保护态（磁盘上已是一份合法 JSON），索引上的
        //     __corrupt 一并撤下。
        // 边界（有意保留的既有语义）：合法 JSON 但结构异常（无 messages 数组）仍按 null 处理，
        // **不**算损坏——它不写 .corrupt 副本，也不进保护态（既有语义；appendTo 的起步
        // 判据依赖它，改动会波及既有链路）。
        var _corruptIds = {};
        var _corruptWarned = {};
        var _corruptBlockWarned = {};
        var _corruptRaw = {};   // 已留副本的损坏原文（同一份原文只留一份副本，见 _backupCorruptOnce）

        // 索引 persist 串行链——_atomicWriteJson 的 tmp 路径全模块共用
        //（indexFile + '.tmp'），而 _doSave 每次消息保存都会 persist 索引、索引本身
        // 无 per-file 链：快速连发消息时两次 persist 交叠，后完成者 rename 时 tmp 已被
        // 对方消费 → 该次快照静默丢失（返回 false 无上报，用户可见 updatedAt/lastActiveId
        // 偶发回退），失败分支还可能把在途 tmp 挪成 .recovery-* 残骸。串行链保证同一
        // 时刻只有一次 .tmp → rename（对齐素材库 refStore._serialized / 本文件
        // _archiveChains 写法）；前一步成败都不影响本步执行，队列不断裂。
        var _indexWriteQueue = Promise.resolve();

        function _generateId() {
            var ts = Date.now();
            var rand = Math.random().toString(36).slice(2, 8);
            return 'sess_' + ts + '_' + rand;
        }

        // ── 三态文本读（区分「确定不存在」/「拿不到」/「拿到了」）──
        // init/saveArchive/loadPlan/loadArchive 的读必须区分三种结果，不能用
        // 折叠版（读失败与文件不存在都得 null/falsy）——读失败被当「无索引/空旧档」，
        // 随后的覆盖写把磁盘上唯一一份数据永久清掉。readFileResult（真实 AEFS，
        // client/shared/aefs.js:1102）按 Result 三态判定：ok=读得、NOT_FOUND=真没有、
        // 其余（CHANNEL_FAILURE/REJECTED）=拿不到。旧式 fs（测试 mock/旧 AEFS）无
        // readFileResult 时退回原折叠语义（null=缺失、reject=失败），行为不变。
        function _readTextTri(file) {
            if (typeof fs.readFileResult === 'function') {
                return fs.readFileResult(file).then(function (r) {
                    if (r && r.ok === true) return { status: 'ok', text: r.data };
                    if (r && r.error && r.error.code === 'NOT_FOUND') return { status: 'missing' };
                    return { status: 'failed' };
                }, function () { return { status: 'failed' }; });
            }
            var readFn = (typeof fs.readFileAsync === 'function') ? fs.readFileAsync : fs.readFile;
            if (typeof readFn !== 'function') return Promise.resolve({ status: 'failed' });
            return readFn.call(fs, file).then(function (raw) {
                return raw ? { status: 'ok', text: raw } : { status: 'missing' };
            }, function () { return { status: 'failed' }; });
        }

        // 读失败哨兵（对齐 load 的 __readFailed 约定）：文件在但读不出/解析不了。
        // loadPlan/loadArchive 的消费方据此把「读不出」与「尚无归档/空计划」分开。
        function _readFailedSentinel() { return { __readFailed: true }; }

        function _emptyIndex() { return { version: 1, lastActiveId: null, sessions: [] }; }

        // ── 损坏会话保护态的两个入口（语义见 _corruptIds 注释）──
        // 损坏原文副本：**同一份原文只留一份** .corrupt-<ts>.bak。若不去重，每次 load 命中解析失败
        // 都会再写一份（同一份坏内容在盘上堆出 N 个副本，重启后又从头数起）；内容变了
        //（用户又写坏了/人工改过）才再留一份——副本的用途是「原文可恢复」，重复副本没有信息量。
        function _backupCorruptOnce(id, msgFile, raw) {
            if (id && _corruptRaw[id] === raw) return;
            if (id) _corruptRaw[id] = raw;
            try { fs.writeFile(msgFile + '.corrupt-' + Date.now() + '.bak', raw).catch(function () {}); } catch (_) {}
        }

        // 置位：索引里确有这条会话时打 __corrupt 并落盘（可观测、跨重启留存）；索引里没有
        //（孤儿消息文件）则只记内存标记——不为了打标记而凭空复活一条索引条目。
        function _markCorrupt(id, msgFile) {
            if (!id || _corruptIds[id]) return;
            _corruptIds[id] = true;
            var marked = false;
            if (_index) {
                for (var i = 0; i < _index.sessions.length; i++) {
                    if (_index.sessions[i].id === id) {
                        _index.sessions[i].__corrupt = true;
                        marked = true;
                        break;
                    }
                }
            }
            if (marked) _persistIndex();
            if (!_corruptWarned[id]) {
                _corruptWarned[id] = true;
                _warn('[SessionStore] 会话消息 JSON 损坏: ' + msgFile
                    + '（已留 .corrupt 副本；该会话的空内容不再覆写原文件，索引已标记 __corrupt）');
            }
        }

        // 解除：读到合法会话 / 非空内容写入成功 / 会话被删除时调用（幂等）
        function _clearCorrupt(id) {
            if (!id || !_corruptIds[id]) return;
            delete _corruptIds[id];
            delete _corruptWarned[id];
            delete _corruptBlockWarned[id];
            delete _corruptRaw[id];
            if (!_index) return;
            for (var i = 0; i < _index.sessions.length; i++) {
                if (_index.sessions[i].id === id && _index.sessions[i].__corrupt) {
                    delete _index.sessions[i].__corrupt;
                    _persistIndex();
                    return;
                }
            }
        }

        // 这次写入会不会用**空内容**覆盖（保护态只拦这一种；非空写入是用户的新内容，必须放行）
        function _corruptBlocks(id, messages) {
            if (!_corruptIds[id]) return false;
            return !(Array.isArray(messages) && messages.length > 0);
        }

        function _noteCorruptWriteBlocked(id, where) {
            if (_corruptBlockWarned[id]) return;
            _corruptBlockWarned[id] = true;
            _warn('[SessionStore] ' + where + ': 会话 ' + id
                + ' 的消息文件损坏且本次写入为空内容，已跳过（不覆写原文件；原内容在 .corrupt 副本里）');
        }

        // 索引 JSON 文本 → 索引对象；损坏时先留 .corrupt 副本再返 null（由调用方走备份兜底）
        function _tryParseIndex(text, sourceFile) {
            try {
                var parsed = JSON.parse(text);
                if (!parsed.sessions) parsed.sessions = [];
                return parsed;
            } catch (_) {
                console.warn('[SessionStore] 会话索引 JSON 损坏: ' + sourceFile);
                try { fs.writeFile(sourceFile + '.corrupt-' + Date.now() + '.bak', text).catch(function () {}); } catch (_) {}
                return null;
            }
        }

        // init 读失败哨兵——索引读取通道故障且 .bak 也拿不到时置位，
        // 此后 _persistIndex 不落盘（含 createSession/renameSession/updateLastActive/
        // deleteSession/_doSave 全部写入方），防止「空表 + 新会话」原子覆盖磁盘上
        // 仍完好的 <mode>_index.json 并把 .bak 刷成同一份（会话列表元数据永久丢失，
        // 消息文件还在盘上但不可达）。
        // 哨兵态不再永久阻断——每个写请求先做一次惰性重读（冷却窗口
        // indexRereadCooldownMs 内只试一次，避免故障通道被写请求打爆），重读成功则
        // 磁盘索引与内存索引按 id 合并后正常落盘（见 _mergeRecoveredIndex），仍失败
        // 才短路。哨兵态首次发生时经 _noteSaveFailure 给一次性可见提示（每实例一次，
        // 多 store 并发 init 由 2s 去重窗口折叠）。
        var _indexReadFailed = false;
        var _indexFailureNotified = false;
        var _indexRereadCooldownMs = (opts.indexRereadCooldownMs !== undefined) ? Number(opts.indexRereadCooldownMs) : 5000;
        if (!isFinite(_indexRereadCooldownMs) || _indexRereadCooldownMs < 0) _indexRereadCooldownMs = 5000;
        var _lastIndexRereadAt = 0;

        // 重读恢复用轻量解析：不做 .corrupt 备份（每次重试都落一份备份会成为残骸），
        // 解析不出即视为仍未恢复（磁盘内容保持不动，等下一次重试）。
        function _parseIndexPlain(text) {
            try {
                var parsed = JSON.parse(text);
                if (!parsed.sessions) parsed.sessions = [];
                return parsed;
            } catch (_) { return null; }
        }

        // 合并语义（明确并固定）：
        //  - 磁盘索引为基底：哨兵态下 listSessions 为空，磁盘条目是「本实例看不到的旧会话」；
        //  - 内存条目按 id 覆盖磁盘同 id 条目：哨兵窗口内本实例的新建/改名/计数更新优先；
        //  - _deletedIds 中的 id 一律丢弃（本实例删除过的会话不得被磁盘旧索引复活）；
        //  - lastActiveId：内存指向的会话优先（用户在哨兵窗口内激活过），否则用磁盘值。
        function _mergeRecoveredIndex(diskIndex) {
            var byId = {};
            var order = [];
            function _add(s, override) {
                if (!s || !s.id || _deletedIds[s.id]) return;
                if (!byId[s.id]) order.push(s.id);
                if (override || !byId[s.id]) byId[s.id] = s;
            }
            var diskSessions = (diskIndex && Array.isArray(diskIndex.sessions)) ? diskIndex.sessions : [];
            for (var i = 0; i < diskSessions.length; i++) _add(diskSessions[i], false);
            var memSessions = (_index && Array.isArray(_index.sessions)) ? _index.sessions : [];
            for (var j = 0; j < memSessions.length; j++) _add(memSessions[j], true);
            var sessions = [];
            for (var k = 0; k < order.length; k++) sessions.push(byId[order[k]]);
            var lastActive = null;
            if (_index && _index.lastActiveId && byId[_index.lastActiveId]) lastActive = _index.lastActiveId;
            else if (diskIndex && diskIndex.lastActiveId && byId[diskIndex.lastActiveId]) lastActive = diskIndex.lastActiveId;
            return { version: 1, lastActiveId: lastActive, sessions: sessions };
        }

        // 一次重读尝试：ok+可解析 / missing（盘上确无索引，按内存索引重建）→ 恢复；
        // failed 或内容仍不可解析 → 保持哨兵（零写盘）。
        function _tryRecoverIndexFromDisk() {
            return _readTextTri(indexFile).then(function (res) {
                var diskIndex = null;
                if (res.status === 'ok') {
                    diskIndex = _parseIndexPlain(res.text);
                    if (!diskIndex) {
                        console.warn('[SessionStore] 索引重读内容仍不可解析，保持读失败保护态: ' + indexFile);
                        return false;
                    }
                } else if (res.status === 'missing') {
                    diskIndex = _emptyIndex();
                } else {
                    console.warn('[SessionStore] 索引重读仍失败，保持读失败保护态: ' + indexFile);
                    return false;
                }
                _index = _mergeRecoveredIndex(diskIndex);
                _indexReadFailed = false;
                console.warn('[SessionStore] 索引重读成功，磁盘条目与内存条目已合并，恢复索引落盘: ' + indexFile);
                return true;
            }, function () { return false; });
        }

        function _persistIndex() {
            if (!fs) return Promise.resolve(false);
            if (_indexReadFailed) {
                // 先惰性重读（冷却窗口内只试一次）；成功则合并恢复后
                // 走下方正常落盘路径（递归进入，序列化仍由 _indexWriteQueue 保证）。
                var _nowTs = Date.now();
                if (_lastIndexRereadAt && (_nowTs - _lastIndexRereadAt) < _indexRereadCooldownMs) {
                    console.warn('[SessionStore] 索引处于读失败保护态，冷却窗口内跳过本次索引落盘（防覆盖磁盘上的现有索引）: ' + indexFile);
                    return Promise.resolve(false);
                }
                _lastIndexRereadAt = _nowTs;
                console.warn('[SessionStore] 索引处于读失败保护态，本次写请求尝试重读恢复: ' + indexFile);
                return _tryRecoverIndexFromDisk().then(function (recovered) {
                    if (!recovered) return false;
                    return _persistIndex();
                });
            }
            // 快照在调用时刻取（本次 persist 记录本次调用时的 _index）
            var payload = JSON.stringify(_index);
            function _writeIndexAtomic() {
                // 索引改走 .tmp → rename 原子写（见文件头 _atomicWriteJson 注释；
                // AEFS 确有 renameFile：client/shared/aefs.js:3011，Bridge 侧 renameFileAsync）。
                // 直写 fs.writeFile(indexFile) 非原子：写盘窗口内进程被杀 → 索引截断 →
                // 下次启动只能从 .bak 恢复，恒落后一次 persist（最后一次建会话/改名/updatedAt
                // 丢失，对应消息文件成索引外孤儿）。
                return _atomicWriteJson(fs, indexFile, payload).then(function (ok) {
                    // 索引备份：主文件写成功后同步刷一份 .bak，供损坏时兜底恢复
                    //（顺序与时机保持不变：仅在主文件落位成功后 fire-and-forget）
                    if (ok) {
                        try { fs.writeFile(indexFile + '.bak', payload).catch(function () {}); } catch (_) {}
                    } else {
                        // 写失败必须可见（return false 无人上报时，
                        // 索引回退只能靠用户察觉列表顺序异常）——留一行告警供排障
                        console.warn('[SessionStore] 会话索引写入失败（快照未落盘）: ' + indexFile);
                    }
                    return ok;
                });
            }
            var run = _indexWriteQueue.then(_writeIndexAtomic, _writeIndexAtomic);
            _indexWriteQueue = run.then(function () {}, function () {});
            return run;
        }

        function _now() { return Date.now(); }

        function init() {
            if (_readyPromise) return _readyPromise;
            _readyPromise = new Promise(function (resolve) {
                if (!fs) {
                    _index = _emptyIndex();
                    _ready = true;
                    resolve();
                    return;
                }
                function _finish(index) { _index = index; _ready = true; resolve(); }
                function _finishReadFailed() {
                    // 主索引与备份都「拿不到」：禁用索引落盘（_persistIndex 哨兵分支），
                    // 内存仍给空表保证 UI 可用；磁盘上的原索引原样保留待下次启动重读。
                    _indexReadFailed = true;
                    console.warn('[SessionStore] 会话索引读取失败（主/备份均拿不到），本实例禁用索引落盘以免覆盖磁盘上的现有索引: ' + indexFile);
                    // 哨兵态首次发生给一次性可见提示（复用消息保存失败的
                    // toast 通道；每实例只提示一次，多 store 并发 init 由 _noteSaveFailure
                    // 的 2s 去重窗口折叠为一条，避免刷屏）
                    if (!_indexFailureNotified) {
                        _indexFailureNotified = true;
                        _noteSaveFailure();
                    }
                    _finish(_emptyIndex());
                }
                function _recoverFromBak(mainStatus) {
                    // 现有损坏兜底逻辑保留：主索引损坏或读失败时尝试 .bak 备份。
                    // 必须带上主索引读取状态——主读 failed（盘上有但拿不到）
                    // 且 .bak 不可用时不得当空表（后续 persist 会用「空表+新会话」覆盖盘上
                    // 仍完好的主索引），只有主读 ok 但解析损坏（已留 .corrupt 副本）才维持
                    // 「空表」既有语义。
                    return _readTextTri(indexFile + '.bak').then(function (bres) {
                        if (bres.status === 'ok') {
                            var bak = _tryParseIndex(bres.text, indexFile + '.bak');
                            if (bak) {
                                console.warn('[SessionStore] 已从备份恢复会话索引: ' + indexFile + '.bak');
                                return _finish(bak);
                            }
                            // .bak 内容也损坏：主索引仅解析损坏 → 空表（旧语义）；
                            // 主索引读失败 → 无法确认磁盘状态，落保护态
                        } else if (bres.status === 'failed') {
                            // 备份也拿不到（通道故障）→ 读失败哨兵，绝不落盘
                            return _finishReadFailed();
                        }
                        if (mainStatus === 'failed') return _finishReadFailed();
                        // 主索引解析损坏（已留 .corrupt 副本）且 .bak 不存在/同损坏 → 空表
                        _finish(_emptyIndex());
                    });
                }
                // 优先异步读取索引，避免同步 Bridge XHR 阻塞主线程（模块挂载时 3 个 store 并发 init）
                _readTextTri(indexFile).then(function (res) {
                    if (res.status === 'missing') {
                        // 仅「确定不存在」视为空表（首启正常态）
                        return _finish(_emptyIndex());
                    }
                    if (res.status === 'ok') {
                        var parsed = _tryParseIndex(res.text, indexFile);
                        if (parsed) return _finish(parsed);
                        return _recoverFromBak('parse_failed');
                    }
                    // 通道失败/被拒：先试 .bak；.bak 也不可用时进入读失败保护态
                    return _recoverFromBak('failed');
                }).catch(function () {
                    _finishReadFailed();
                });
            });
            return _readyPromise;
        }

        function whenReady() { return _readyPromise || init(); }
        function isReady() { return _ready; }

        function listSessions() {
            if (!_index) return [];
            return _index.sessions.slice().sort(function (a, b) {
                return (b.createdAt || 0) - (a.createdAt || 0);
            });
        }

        function getSession(id) {
            if (!_index) return null;
            for (var i = 0; i < _index.sessions.length; i++) {
                if (_index.sessions[i].id === id) return _index.sessions[i];
            }
            return null;
        }

        function getLastActiveId() {
            return _index ? _index.lastActiveId : null;
        }

        function createSession() {
            // 索引未就绪（init 异步读盘未完成）：**显式、可诊断地失败**，不抛裸 TypeError
            //（`_index.sessions.push` 的真机表现是 `Cannot read property 'sessions' of null`，
            // 排查时看不出是「谁在未就绪期建会话」）。
            // 契约：调用方必须在调用前 `await whenReady()`——controller.createSession /
            // switchMode / _restoreOneLane 都走这条；本入口不自动建空索引：那会让这次新建落进一个
            // 随后被 init 结果覆盖的索引里（新会话静默丢失，比显式失败难查得多）。
            if (!_index) {
                throw new Error('[SessionStore] createSession 在索引就绪前被调用（init 未完成）: '
                    + indexFile + '——调用方需先 await whenReady()');
            }
            var id = _generateId();
            var now = _now();
            var session = {
                id: id,
                title: '新会话',
                createdAt: now,
                updatedAt: now,
                messageCount: 0
            };
            _index.sessions.push(session);
            _persistIndex();
            return session;
        }

        // ── 按显式 id 落空会话（团队模式的整队会话落点）──
        // 背景：createSession() 自造 `sess_<ts>_<rand>` id，而团队会话的 id 由 binder 生成
        //（`team_<ts>_<rand>`）并要求三条 lane **共用同一个 id**——store 因此需要一个
        // 「接受外来 id」的增量出口。缺它时 controller.adoptSession 第 1 步的能力探测落到
        // `no_ensure_api` 降级（零副作用显式失败），真机整队「新建」不成立：三条 lane 各造
        // 一个 sess_ id，会话索引里也永远没有 binder 那个 id。
        //
        // 契约（**同步、永不抛**）：
        //   · 成功 `{ ok:true, id:<原样回显>, created:<boolean> }`；id 已在索引里 ⇒
        //     `created:false` 且**零写入**（幂等：binder 重试 / 整队切换不得造重复索引项）。
        //     幂等判据只认索引里 id **全等**（不 trim、不忽略大小写、不做前缀匹配）。
        //   · 失败 `{ ok:false, reason:'bad_id'|'not_ready'|'io_error', detail }`。
        // 为什么 fail-closed 而不是 sanitize：落盘路径（消息 / token 统计 / 计划 / 归档四个
        // 文件名）都由 id 直接拼出，trim 后放行、大小写归一、前缀匹配都会让「调用方以为的
        // id」与「盘上的文件名」分叉——同一团队会话在三条 lane 上落成不同文件是比显式失败
        // 难查得多的静默故障。`/` `\`（路径越界）、`..`（上跳）、`:`（NTFS 数据流）、控制
        // 字符（路径/日志注入）、前后空白（拼出的文件名与调用方所见不一致）一律拒绝，宁可
        // 调用方拿到 bad_id 自己修 id。bad_id 是纯校验（零副作用），故先于 not_ready 判定。
        // 为什么同步：唯一生产调用方 controller.adoptSession 必须同步返回（binder 的
        // _normalizeAction 按 `typeof res.ok === 'boolean'` 判成败），故本入口不返回 Promise、
        // 不 await——落盘与 createSession 同口径走 fire-and-forget 的 `_persistIndex()`
        //（内存索引才是 getSession/listSessions 的唯一来源；盘上是否落位由索引侧的告警体现）。
        // 复活语义：该 id 曾 deleteSession（`_deletedIds`）或曾 load 读失败（`_readFailedIds`）
        // 时，本入口是把该 id **重新交给**这套 store——两枚内存标记必须清掉，否则
        // `_doSave`/`appendTo`/`saveArchive`/`flushSync` 会按「已删除/读不出」**静默跳过**写入，
        // 索引里有条目而消息永远落不了盘（孤儿会话）。损坏保护态（`_corruptIds`）**有意不清**：
        // 它拦的只是「空内容覆写」，盘上读不出的原文件仍是唯一副本，不该被一次新建当可覆盖。
        // 边界：**不建消息文件**（.json / .tokens.json / .plan.json / .archive.json 一律不碰），
        // 只落索引条目；消息内容归调用方后续 save/appendTo。
        function _badIdDetail(id) {
            if (typeof id !== 'string') return 'not_string';
            if (id === '') return 'empty';
            if (/^\s|\s$/.test(id)) return 'surrounding_whitespace';
            if (id.indexOf('/') >= 0 || id.indexOf('\\') >= 0) return 'path_separator';
            if (id.indexOf('..') >= 0) return 'dotdot';
            if (id.indexOf(':') >= 0) return 'colon';
            if (/[\u0000-\u001f\u007f]/.test(id)) return 'control_char';
            return null;
        }

        function ensureSession(id) {
            var pushed = false;
            var prevDeleted = false;
            var prevReadFailed = false;
            try {
                var bad = _badIdDetail(id);
                if (bad) return { ok: false, reason: 'bad_id', detail: bad };
                // 索引未就绪（init 的异步读索引尚未完成）⇒ 显式失败、零副作用：与
                // _doSave / deleteSession / flushSync 的 `!_index` 守卫同源（push 直接 TypeError）
                if (!_index) return { ok: false, reason: 'not_ready', detail: 'index_not_initialized' };
                // 幂等：索引里已有全等 id ⇒ 零写入返回（不刷 updatedAt、不重复 push、不落盘）
                for (var i = 0; i < _index.sessions.length; i++) {
                    if (_index.sessions[i] && _index.sessions[i].id === id) {
                        return { ok: true, id: id, created: false };
                    }
                }
                // 复活：新建前清掉「已删除 / 读失败」两枚内存标记（见上「复活语义」）
                prevDeleted = !!_deletedIds[id];
                prevReadFailed = !!_readFailedIds[id];
                delete _deletedIds[id];
                delete _readFailedIds[id];
                var now = _now();
                _index.sessions.push({
                    id: id,
                    title: '新会话',
                    createdAt: now,
                    updatedAt: now,
                    messageCount: 0
                });
                pushed = true;
                _persistIndex();
                return { ok: true, id: id, created: true };
            } catch (e) {
                // 永不抛：push / 序列化异常折叠成显式失败（binder 的同步动作调用不许炸）。
                // 回滚本次已入内存的条目——io_error 与「索引里仍没有这条」必须一致，否则
                // 调用方复查（controller._ensureSessionEntry 只复查 getSession）会把失败当成功。
                if (pushed && _index && Array.isArray(_index.sessions)) {
                    for (var k = _index.sessions.length - 1; k >= 0; k--) {
                        if (_index.sessions[k] && _index.sessions[k].id === id) {
                            _index.sessions.splice(k, 1);
                            break;
                        }
                    }
                }
                if (prevDeleted) _deletedIds[id] = true;
                if (prevReadFailed) _readFailedIds[id] = true;
                return { ok: false, reason: 'io_error', detail: String((e && e.message) || e) };
            }
        }

        function deleteSession(id) {
            if (!_index) return Promise.resolve(false);
            // 清掉该会话挂起的防抖写入：否则删除后 flush/_doSave 会把已删会话的
            // 消息文件复活为孤儿文件（索引中已无该会话）
            if (_pendingSave && _pendingSave.id === id) {
                _pendingSave = null;
                if (_writeTimer) { clearTimeout(_writeTimer); _writeTimer = null; }
            }
            // 标记已删除：阻断在途/后续直写链（appendTo/saveNow/saveArchive）在删除
            // 落地后复写该会话文件（_doSave/_doAppend 入口据此跳过）
            _deletedIds[id] = true;
            delete _readFailedIds[id];
            // 会话已删：损坏保护态与去重告警标记一并作废（文件即将删除，不必再拦写入）
            delete _corruptIds[id];
            delete _corruptWarned[id];
            delete _corruptBlockWarned[id];
            delete _corruptRaw[id];
            for (var i = 0; i < _index.sessions.length; i++) {
                if (_index.sessions[i].id === id) {
                    _index.sessions.splice(i, 1);
                    break;
                }
            }
            if (_index.lastActiveId === id) {
                // 兜底选「最近更新」的会话而非创建序第一个（最旧）——与 listSessions
                // 按 createdAt 降序展示的语义一致，避免 store 层与 UI 排序相反埋雷
                var _latest = null;
                for (var d = 0; d < _index.sessions.length; d++) {
                    if (!_latest || ((_index.sessions[d].updatedAt || 0) > (_latest.updatedAt || 0))) {
                        _latest = _index.sessions[d];
                    }
                }
                _index.lastActiveId = _latest ? _latest.id : null;
            }
            var msgFile = sessionsDir + '/' + id + '.json';
            var tokensFile = sessionsDir + '/' + id + '.tokens.json';
            var planFile = sessionsDir + '/' + id + '.plan.json';
            var archiveFile = sessionsDir + '/' + id + '.archive.json';
            // 会话已删，归档读失败暂存的批次一并作废（不再有合法写入方）
            delete _archivePending[archiveFile];
            var p1 = _persistIndex();
            var p2 = fs && fs.deleteFile ? fs.deleteFile(msgFile) : Promise.resolve(true);
            var p3 = fs && fs.deleteFile ? fs.deleteFile(tokensFile) : Promise.resolve(true);
            var p4 = fs && fs.deleteFile ? fs.deleteFile(planFile) : Promise.resolve(true);
            var p5 = fs && fs.deleteFile ? fs.deleteFile(archiveFile) : Promise.resolve(true);
            return Promise.all([p1, p2, p3, p4, p5]).then(function (results) {
                // p1（索引落盘）失败时如实告警——消息/统计/计划/归档文件
                // 已删而索引未更新（或哨兵态下未落盘），重启后可能残留「有索引无文件」
                // 条目。返回值语义保持 true（文件删除已尽力，调用方按成功处理）。
                if (results && results[0] === false) {
                    console.warn('[SessionStore] deleteSession: 索引落盘失败（本次删除未反映到索引，重启后可能残留空条目）: ' + id + ' @ ' + indexFile);
                }
                return true;
            });
        }

        function renameSession(id, title) {
            if (!_index) return Promise.resolve(false);
            var found = false;
            for (var i = 0; i < _index.sessions.length; i++) {
                if (_index.sessions[i].id === id) {
                    _index.sessions[i].title = title;
                    _index.sessions[i].updatedAt = _now();
                    found = true;
                    break;
                }
            }
            if (!found) return Promise.resolve(false);
            // 改名必须透传 _persistIndex 的结果：否则写失败只在内部 console.warn，
            // controller 直接报 {ok:true}，UI 标题改了而磁盘未落，重启回退。现在把落盘
            // 结果透传（promise），失败复用消息保存路径的一次性可见提示（_noteSaveFailure，
            // 去重窗口/成功清除语义同 _doSave），成功路径行为不变。
            return _persistIndex().then(function (ok) {
                if (ok === false) {
                    _noteSaveFailure();
                    return false;
                }
                return true;
            });
        }

        // goal：会话级长期目标。**只落索引条目**——消息文件是
        // {version,sessionId,messages}，load() 只返回 messages，写进去会被丢弃。
        // 与 renameSession 同款：改条目 → _persistIndex() → 失败走 _noteSaveFailure。
        // 入参 goal 必须是 normalizeGoal 之后的普通对象（调用方负责归一与 CAS 校验）。
        function setGoal(id, goal) {
            if (!_index) return Promise.resolve(false);
            var found = false;
            for (var i = 0; i < _index.sessions.length; i++) {
                if (_index.sessions[i].id === id) {
                    if (goal) { _index.sessions[i].goal = goal; }
                    else { delete _index.sessions[i].goal; }
                    _index.sessions[i].updatedAt = _now();
                    found = true;
                    break;
                }
            }
            if (!found) return Promise.resolve(false);
            return _persistIndex().then(function (ok) {
                if (ok === false) { _noteSaveFailure(); return false; }
                return true;
            });
        }

        // 读：索引未就绪 / 无该会话 / 旧数据无 goal 字段 一律返回 null（无目标，不迁移不补写）。
        function getGoal(id) {
            if (!_index) return null;
            for (var i = 0; i < _index.sessions.length; i++) {
                if (_index.sessions[i].id === id) {
                    var g = _index.sessions[i].goal;
                    return (g && typeof g === 'object') ? g : null;
                }
            }
            return null;
        }

        function updateLastActive(id) {
            if (!_index) return;
            _index.lastActiveId = id;
            // 同步刷新该会话的 updatedAt，确保切换到的新会话排在列表最前
            for (var i = 0; i < _index.sessions.length; i++) {
                if (_index.sessions[i].id === id) {
                    _index.sessions[i].updatedAt = _now();
                    break;
                }
            }
            _persistIndex();
        }

        // ── 消息文件写入统一串行链──
        // _doSave 改走 .tmp → rename 原子写（对齐索引/归档）后，同一文件的原子写
        // **必须串行**（tmp 路径共用，并发两次会互相消费对方 tmp，见文件头
        // _atomicWriteJson 注释）。四个入口若不同链，就会出现
        // 防抖 save 与 flush 在链外直调 _doSave——正是原子写最怕的并发形态。现把
        // 四条入口（save 定时器/flush/saveNow/appendTo）全部排进同一条 per-file 链：
        // appendTo 的读-改-写整体在链内（防并发追加丢批次），不同会话互不阻塞。
        var _msgWriteChains = {};
        function _enqueueMsgWrite(id, fn) {
            var file = sessionsDir + '/' + id + '.json';
            var prev = _msgWriteChains[file];
            var run;
            if (!prev) {
                // 链空闲（该会话尚无在途写）：同步起步——保持 flush()/saveNow()
                // 的同步入口时序（降级 fs/旧 mock 下同步可观测；也不多一次微任务跳转）。
                // 单线程语义保证本赋值先于任何后续调用，同 tick 内的并发写仍按链排队。
                try { run = fn(); } catch (e) { run = Promise.reject(e); }
            } else {
                run = prev.then(fn, fn);
            }
            if (!run || typeof run.then !== 'function') run = Promise.resolve(run);
            // 防止链断裂：吞掉 run 中的错误，由调用方自行处理（对齐 saveArchive 模式）
            _msgWriteChains[file] = run.catch(function () {});
            return run;
        }

        function _doSave(id, messages) {
            // _index 未就绪（init 异步读索引未完成）时跳过：与 deleteSession 等方法的
            // !_index 守卫对齐，防 init 窗口内的 save/flush 触发 null 引用崩溃；
            // 消息仍在内存 cm 中，init 完成后的下一次防抖 save 会正常落盘。
            if (!fs || !_index) return Promise.resolve(false);
            // 已删除会话的直写拦截：deleteSession 只清防抖 pendingSave，管不到在途的
            // per-file 直写链（_enqueueMsgWrite）——后台任务结果与
            // 删除的时间窗重合时，链上排队的 load→_doSave 会在删除完成后落盘，把已删
            // 会话的消息文件复活为索引外孤儿（修的是防抖复活，此处堵直写链同构洞）。
            if (_deletedIds[id]) return Promise.resolve(false);
            // 读失败保护：该 id 最近一次 load 返回 __readFailed 哨兵时，原文件是
            // **唯一副本**——整包写（哪怕只有一条新消息）都会把它覆盖掉。与 flushSync 的同款
            // 守卫对齐，并**显式告警一次**：静默 return false 会让用户看不到「消息没落盘」。
            // 成功 load 一次后自动解除（见 _trackLoadResult）。
            if (_readFailedIds[id]) {
                if (!_readFailedWarned[id]) {
                    _readFailedWarned[id] = true;
                    console.warn('[SessionStore] save 跳过：会话 ' + id + ' 的消息文件读取失败'
                        + '（原文件是唯一副本，不覆盖；成功读取一次后自动解除）');
                }
                return Promise.resolve(false);
            }
            // 损坏保护态：拒绝**空内容**覆写（见 _corruptIds 注释）——这一步正是
            // 「读损坏 → 当空会话 → 下一条消息把原文件覆盖掉」的静默清空点。非空内容放行。
            if (_corruptBlocks(id, messages)) {
                _noteCorruptWriteBlocked(id, 'save');
                return Promise.resolve(false);
            }
            var msgFile = sessionsDir + '/' + id + '.json';
            var payload = JSON.stringify({
                version: 1,
                sessionId: id,
                messages: messages
            });
            for (var i = 0; i < _index.sessions.length; i++) {
                if (_index.sessions[i].id === id) {
                    _index.sessions[i].messageCount = messages.length;
                    _index.sessions[i].updatedAt = _now();
                    break;
                }
            }
            // 消息文件改走原子写（.tmp → rename，见文件头 _atomicWriteJson）。
            // 直写 fs.writeFile(msgFile)：写盘窗口内进程被杀/断电 → 文件截断，
            // 下次 load 只能留 .corrupt 副本并按空会话导入（截断前整段对话不可达）。
            // 同文件并发写已由调用侧 _enqueueMsgWrite 串行化（原子写前提）。
            var p1 = _atomicWriteJson(fs, msgFile, payload);
            var p2 = _persistIndex();
            // ② 消息文件写失败不得静默（不能恒 resolve(true)）：返回值上报
            //（saveNow/appendTo/flush 透传 false）+ 一次性可见提示；成功写入清除
            // 失败标记。只认显式 false（AEFS 约定），真值/undefined 按既有语义算成功，
            // 不误伤只 mock writeFile 返回 true 的旧环境。
            return Promise.all([p1, p2]).then(function (results) {
                if (results && results[0] === false) {
                    _noteSaveFailure();
                    return false;
                }
                _clearSaveFailure();
                // 非空内容写入成功 ⇒ 磁盘上已是一份合法 JSON，损坏保护态解除（幂等；
                // 顺带撤下索引上的 __corrupt——p2 的快照可能仍带着它，故此处会再持久化一次）
                _clearCorrupt(id);
                return true;
            }, function () {
                // 写入通道 reject 同样是"没落盘"（对齐 load 的 catch 折叠语义）
                _noteSaveFailure();
                return false;
            });
        }

        function save(id, messages) {
            var msgs = Array.isArray(messages) ? messages : [];
            if (debounceMs <= 0) {
                return _doSave(id, msgs);
            }
            _pendingSave = { id: id, messages: msgs };
            if (_writeTimer) clearTimeout(_writeTimer);
            _writeTimer = setTimeout(function () {
                _writeTimer = null;
                if (_pendingSave) {
                    var pending = _pendingSave;
                    _pendingSave = null;
                    // 防抖写同样进 per-file 链（原子写前提；直调 _doSave 会与
                    // 链上在途的 saveNow/appendTo 并发踩同一个 .tmp）
                    _enqueueMsgWrite(pending.id, function () {
                        return _doSave(pending.id, pending.messages);
                    });
                }
            }, debounceMs);
            return Promise.resolve(true);
        }

        // flushSync 守卫支持：跟踪 load 各返回分支，读失败哨兵置位、其余（读到/确认
        // 不存在/损坏已备份按空）清除——只被 flushSync 读取，不改变 load 自身返回值。
        function _trackLoadResult(id, p) {
            return Promise.resolve(p).then(function (msgs) {
                if (msgs && msgs.__readFailed) _readFailedIds[id] = true;
                else { delete _readFailedIds[id]; delete _readFailedWarned[id]; }
                return msgs;
            });
        }

        function load(id) {
            if (!fs) return Promise.resolve(null);
            var msgFile = sessionsDir + '/' + id + '.json';
            // 注入的 fs 带 readFileResult（真实 AEFS）时走三态直判——读失败
            // （CHANNEL_FAILURE/REJECTED）与「文件不存在」（NOT_FOUND）由通道一次
            // 判定，不再依赖 existsSync 二次复核（间接判定：existsSync 自身失败时
            // 会把「文件在但读不出」误判回 null，哨兵失效）。旧式 fs
            //（无 readFileResult，测试 mock/旧 AEFS）回退原路径。
            if (typeof fs.readFileResult === 'function') {
                return _trackLoadResult(id, fs.readFileResult(msgFile).then(function (r) {
                    if (r && r.ok === true) {
                        // 空文件 ok('')：0 字节会话 JSON 本就是可疑形态（合法会话至少
                        // {"messages":[]}）——与旧路径 existsSync 复核口径一致，按读失败哨兵
                        if (!r.data) return SESSION_READ_FAILED;
                        return _parseSessionRaw(r.data, msgFile, id);
                    }
                    // NOT_FOUND（真没有）→ null 新会话语义；CHANNEL_FAILURE（拿不到）
                    // /REJECTED（不该读）→ 哨兵，调用方中止覆盖性写入
                    if (r && r.error && r.error.code === 'NOT_FOUND') {
                        // 文件确实不在 ⇒ 无原文件可保护，损坏保护态一并解除
                        _clearCorrupt(id);
                        return null;
                    }
                    return SESSION_READ_FAILED;
                }).catch(function () {
                    return SESSION_READ_FAILED;
                }));
            }
            // 优先异步读取（Bridge.readFileAsync）：大会话文件不阻塞主线程，避免进入模块卡顿。
            // 无 readFileAsync 时回退原 readFile（同步 Bridge XHR）。
            var readFn = (fs && typeof fs.readFileAsync === 'function') ? fs.readFileAsync : fs.readFile;
            return _trackLoadResult(id, readFn.call(fs, msgFile).then(function (raw) {
                if (!raw) {
                    // 读出空但文件仍存在 → 读失败（通道异常）而非「新会话」：
                    // 返回哨兵让调用方中止覆盖性写入。existsSync 不可用（或返回 false）
                    // 时维持原 null 语义（文件不存在=新会话，不引入新行为）。
                    var _exists = false;
                    try { _exists = (typeof fs.existsSync === 'function') ? !!fs.existsSync(msgFile) : false; } catch (_) {}
                    if (_exists) return SESSION_READ_FAILED;
                    _clearCorrupt(id);   // 确认文件不存在 ⇒ 损坏保护态解除（同 readFileResult 的 NOT_FOUND 分支）
                    return null;
                }
                return _parseSessionRaw(raw, msgFile, id);
            }).catch(function () {
                // 读取通道 reject 同为读失败——原样折叠为 null 会被调用方
                // 当空会话导入，切走时整包覆盖原文件（会话静默丢失）。
                return SESSION_READ_FAILED;
            }));
        }

        // 原文解析收口（两条读路径共用）——JSON 损坏留 .corrupt 副本后按空会话（null）处理
        // **并置损坏保护态**（见 _corruptIds 注释：空内容不再覆写原文件）；
        // 结构异常（无 messages 数组）同样 null，但不置保护态（既有语义，见上）。
        function _parseSessionRaw(raw, msgFile, id) {
            try {
                var parsed = JSON.parse(raw);
                if (!Array.isArray(parsed.messages)) return null;
                // 读到合法会话 ⇒ 该 id 不再是「损坏态」（幂等；也覆盖「外部修好文件」的情况）
                _clearCorrupt(id);
                return parsed.messages;
            } catch (_) {
                // 消息文件损坏：留 .corrupt 副本供人工排查（对齐索引文件的损坏保护；同一份原文
                // 只留一份，见 _backupCorruptOnce）。返回 null 后调用方按空会话处理，但保护态
                // 已置位：空内容不会再覆盖原文件（没有这条防线时，下一条消息触发的防抖
                // save 就把会话静默清空了）。
                _backupCorruptOnce(id, msgFile, raw);
                _markCorrupt(id, msgFile);
                return null;
            }
        }

        function flush() {
            if (_writeTimer) {
                clearTimeout(_writeTimer);
                _writeTimer = null;
            }
            if (_pendingSave) {
                var pending = _pendingSave;
                _pendingSave = null;
                // flush 与链上在途写串行（同 _enqueueMsgWrite 注释）
                return _enqueueMsgWrite(pending.id, function () {
                    return _doSave(pending.id, pending.messages);
                });
            }
            return Promise.resolve(true);
        }

        // ── 关面板同步兜底（收口，可选接口，仅画布卸载钩子调用）──
        // 卸载窗口内页面即将销毁，防抖写与 _doSave 异步链（writeFile→Bridge fetch）都会被
        // 中断：调用方提供当前内存消息快照，本入口用同步写直接落盘（AEFS.writeFileSync
        // 内部已含 cep.fs 原生同步回退，见 client/shared/aefs.js:552），不排队、不等防抖。
        // 既有守卫沿用：_index 未就绪不写（同 _doSave/deleteSession 的 !_index 守卫）、
        // _deletedIds 拦截不复活已删会话、该 id 最近一次 load 返回 __readFailed 哨兵时
        // 不覆盖（读不出的原文件是唯一副本）；messages 非数组拒绝（防误写空历史）。
        // 无同步写通道（旧 mock/降级 fs）返回 false，调用方自行退回异步 flush（尽力而为）。
        // 边界：仅本接口走同步；save/saveNow/appendTo 等普通保存路径仍全异步，不受影响。
        function flushSync(id, messages) {
            if (!fs || !_index) return false;
            if (_deletedIds[id]) return false;
            if (_readFailedIds[id]) {
                console.warn('[SessionStore] flushSync: 会话 ' + id + ' 消息读取失败，跳过同步写（不覆盖原文件）');
                return false;
            }
            if (!Array.isArray(messages)) return false;
            // 损坏保护态：同步兜底同样不得用空内容覆写（对齐 _doSave 的同款守卫）
            if (_corruptBlocks(id, messages)) {
                _noteCorruptWriteBlocked(id, 'flushSync');
                return false;
            }
            if (typeof fs.writeFileSync !== 'function') return false;
            // 清掉该会话挂起的防抖写：其异步链在卸载窗口内会随页面销毁中断，
            // 留着只会在（未销毁的模拟/降级场景）以旧快照晚到覆盖本次同步写。
            if (_pendingSave && _pendingSave.id === id) {
                _pendingSave = null;
                if (_writeTimer) { clearTimeout(_writeTimer); _writeTimer = null; }
            }
            var msgFile = sessionsDir + '/' + id + '.json';
            var payload = JSON.stringify({
                version: 1,
                sessionId: id,
                messages: messages
            });
            // 内存索引同步刷新（与 _doSave 一致）；索引文件仍由异步 _persistIndex 负责，
            // 本同步入口不触碰索引落盘链（面板固定 id 场景索引中无条目，无影响）。
            for (var i = 0; i < _index.sessions.length; i++) {
                if (_index.sessions[i].id === id) {
                    _index.sessions[i].messageCount = messages.length;
                    _index.sessions[i].updatedAt = _now();
                    break;
                }
            }
            try {
                // AEFS 约定：显式 false 才算失败（undefined/真值按既有语义算成功）
                var _ok = fs.writeFileSync(msgFile, payload) !== false;
                if (_ok) _clearCorrupt(id);   // 非空内容落盘成功 ⇒ 损坏保护态解除（同 _doSave）
                return _ok;
            } catch (_) {
                return false;
            }
        }

        // ── 关面板同步兜底（beforeunload 专用）──
        // 病灶：Agent 会话在 beforeunload 仍走异步 flush——该写链（writeFile→Bridge
        // fetch）在页面销毁窗口内会被中止，防抖窗口内最后一次落盘可能丢失（画布/
        // 桌宠有同步通道，会话侧缺同款）。本入口把挂起的防抖快照（_pendingSave）
        // 用 flushSync 同步落盘：快照恒来自合法 save() 调用（id 与内容同源），
        // 不存在「以空/中间态快照覆盖原文件」的窗口（switchSession 的 setSessionId
        // 清空窗口不在防抖槽里）。守卫（未就绪/已删除/读失败哨兵/非数组/无同步
        // 通道）全部复用 flushSync。无挂起快照时返回 false，调用方可退回异步 flush
        //（在途链本就无法在卸载窗口内保证完成，属既有边界）。
        function flushSyncNow() {
            if (!_pendingSave) return false;
            var pending = _pendingSave;
            return flushSync(pending.id, pending.messages) === true;
        }

        // 直写接口：后台任务结果落回非当前会话（injectSystemMessage/injectSystemResult
        // 失配分支）用。防抖 save 的 _pendingSave 是单槽：失配分支 save(A) 排队后，
        // 当前会话 B 的防抖 save 会覆盖槽位并重置定时器，A 的写入被静默丢弃（切回
        // A 永远看不到结果）。直写绕过单槽立即落盘；per-file promise 链排队（对齐
        // saveArchive._archiveChains 模式）保证同会话并发直写不交错。
        // 链已统一为 _enqueueMsgWrite（save/flush/appendTo 共用同一条）。
        function saveNow(id, messages) {
            var msgs = Array.isArray(messages) ? messages : [];
            return _enqueueMsgWrite(id, function () {
                return _doSave(id, msgs);
            });
        }

        // 原子追加（load→push→落盘 整体进 per-file 串行链）。
        // 旧调用方各自 load(id) → push → saveNow(id, msgs)：saveNow 的链只串行化
        // "写"，load 发生在链外——两个并发后台任务（ComfyUI fire-and-forget 轮询）
        // 都在先到者写盘前完成 load，各自 push 后排队整包写盘，后写者覆盖先写者，
        // 先落盘的结果 JSON 从会话文件永久丢失。appendTo 把读-改-写整体排进
        // _enqueueMsgWrite 同一条链（与 saveNow/save/flush 互斥），并发追加逐条落盘不互相覆盖。
        // load 返回 null（文件不存在/损坏兜底）时以 [msg] 起步创建——
        // 与旧调用方 if (!msgs) msgs = [] 的语义一致，不引入新行为。
        // load 返回读失败哨兵时拒绝起步——以 [msg] 起步会在链尾 _doSave
        // 整包覆盖读不出的原会话文件，返回 false 落空本次追加并告警。
        function appendTo(id, msg) {
            if (!msg) return Promise.resolve(false);
            return _enqueueMsgWrite(id, function () {
                return load(id).then(function (existing) {
                    if (existing && existing.__readFailed) {
                        console.warn('[SessionStore] appendTo: 会话 ' + id + ' 消息读取失败，跳过追加（不覆盖原文件）');
                        return false;
                    }
                    var msgs = Array.isArray(existing) ? existing : [];
                    msgs.push(msg);
                    return _doSave(id, msgs);
                });
            });
        }

        // token 统计独立文件持久化：避免会话切换/模式切换 reset 后切回丢统计。
        // 与消息文件分离，避免每次防抖 save 都序列化 token 记录。
        function saveTokenStats(id, records) {
            if (!fs) return Promise.resolve(false);
            var file = sessionsDir + '/' + id + '.tokens.json';
            return fs.writeFile(file, JSON.stringify({ records: records || [] }));
        }

        // 读失败哨兵（对齐 load() 的 __readFailed 约定）：文件在但读不出/解析不了时返回它。
        // 为什么必须与「无记录」分开：调用方（tokenStats.restoreTokenStats）把 null 视为
        // 「该会话没有记录」→ records=[] → 下一次保存把 [] 写盘，**一次瞬时读失败
        //（bridge 重启/换包窗口）即把之前存下的好数据永久清空**——而这条链上没有任何日志。
        function _statsReadFailed() { return { __readFailed: true }; }

        function loadTokenStats(id) {
            if (!fs) return Promise.resolve(null);
            var file = sessionsDir + '/' + id + '.tokens.json';
            // 优先异步读取，避免同步 Bridge XHR 阻塞主线程（与 load 保持一致）
            var readFn = (typeof fs.readFileAsync === 'function') ? fs.readFileAsync : fs.readFile;
            return readFn.call(fs, file).then(function (raw) {
                if (!raw) return null;   // 文件不存在 = 无记录（合法空态）
                try {
                    var parsed = JSON.parse(raw);
                    return Array.isArray(parsed.records) ? parsed.records : null;
                } catch (_) {
                    return _statsReadFailed();   // 内容损坏 ≠ 空
                }
            }).catch(function () { return _statsReadFailed(); });   // 通道失败 ≠ 空
        }

        // Agent 任务清单（plan）独立文件持久化：与消息/统计同目录同生命周期。
        // 替代 localStorage 方案——CEP 重启/扩展升级时 localStorage 可能被清，
        // 导致 sessionStore 恢复了会话但 plan 丢失。改用 AEFS 磁盘文件确保可靠性。
        function savePlan(id, plan) {
            if (!fs) return Promise.resolve(false);
            var file = sessionsDir + '/' + id + '.plan.json';
            return fs.writeFile(file, JSON.stringify({ steps: (plan && plan.steps) || [] }));
        }

        function loadPlan(id) {
            if (!fs) return Promise.resolve(null);
            var file = sessionsDir + '/' + id + '.plan.json';
            // 读失败/解析失败返回 __readFailed 哨兵（对齐 load/loadTokenStats 约定）。
            // 如实说明消费现状（勿再宣称存在按哨兵分支的消费方）：当前唯一消费方
            // controller.restorePlan 只判 Array.isArray，非数组（含本哨兵与 null）一律
            // 按「无计划」处理，不会清空也不会落盘；本哨兵是对齐同族接口的约定保留
            // （供将来消费方区分「读不出」与「确无计划」），本身不改变 restorePlan 行为。
            return _readTextTri(file).then(function (res) {
                if (res.status === 'missing') return null;   // 确定不存在 = 无计划（合法空态）
                if (res.status !== 'ok') return _readFailedSentinel();
                try {
                    var parsed = JSON.parse(res.text);
                    return Array.isArray(parsed.steps) ? parsed.steps : _readFailedSentinel();
                } catch (_) {
                    return _readFailedSentinel();
                }
            });
        }

        // 上下文压缩归档独立文件持久化：压缩丢弃的早期消息副本，供 LLM 按需回看。
        // 与消息文件分离——归档只增不改、按上限截断，不参与每次防抖 save。
        // append 语义：新被压缩的旧消息追加到末尾（时间正序），超出 maxArchiveMessages
        // 时丢弃最旧的，保持「越早的归档消息越靠前」的顺序。
        // 读-改-写互斥：compressContext 压缩归档与 pruneByTokens 归档两条 fire-and-forget
        // 路径可能并发触发同一会话的归档，不串行化则后写者胜出、先写入批次永久丢失。
        // per-file promise 链排队（对齐 settingsStore._serializedWrite 模式），不同会话互不阻塞。
        // 读失败的有界重试 + 内存待合并缓冲。调用方（compressContext /
        // pruneByTokens）是 fire-and-forget，原注释「下轮重试」不成立——被裁剪的消息已从
        // cm 移除并落盘，本批丢了就永久丢失。故：同链内先重试 archiveReadRetries 次
        // （短退避），全失败则把本批按文件暂存 _archivePending；下次同文件 append 成功
        // 读到盘后，把 pending 批次（更旧）并到已有归档之后、本批之前一起写，写成功后清 pending。
        var _archiveChains = {};
        var _archivePending = {};
        var _archiveReadRetries = (opts.archiveReadRetries !== undefined) ? Number(opts.archiveReadRetries) : 3;
        if (!isFinite(_archiveReadRetries) || _archiveReadRetries < 0) _archiveReadRetries = 3;
        var _archiveReadRetryDelayMs = (opts.archiveReadRetryDelayMs !== undefined) ? Number(opts.archiveReadRetryDelayMs) : 200;
        if (!isFinite(_archiveReadRetryDelayMs) || _archiveReadRetryDelayMs < 0) _archiveReadRetryDelayMs = 200;

        function _readArchiveWithRetry(file, attempt) {
            return _readTextTri(file).then(function (res) {
                if (res.status !== 'failed' || attempt >= _archiveReadRetries) return res;
                return new Promise(function (resolve) { setTimeout(resolve, _archiveReadRetryDelayMs); })
                    .then(function () { return _readArchiveWithRetry(file, attempt + 1); });
            });
        }

        function saveArchive(id, olderMessages) {
            if (!fs) return Promise.resolve(false);
            var msgs = Array.isArray(olderMessages) ? olderMessages : [];
            if (!msgs.length) return Promise.resolve(true);
            var file = sessionsDir + '/' + id + '.archive.json';
            function _doAppend() {
                // 已删除会话的归档直写拦截（与 _doSave 同因）：压缩归档与 pruneByTokens
                // 归档均为 fire-and-forget，链上排队的读-改-写会在 deleteSession 落地后
                // 把 .archive.json 复活为孤儿文件
                if (_deletedIds[id]) return Promise.resolve(true);
                return _readArchiveWithRetry(file, 0).then(function (res) {
                    // 归档读通道失败（重试后仍拿不到）时整包覆盖会毁掉磁盘上
                    // 唯一一份归档副本——本批暂存内存 pending（下次成功读到盘后并入一起写），
                    // 不写盘。调用方 fire-and-forget 不会自己重试，故不能只返回 false 了事。
                    if (res.status === 'failed') {
                        console.warn('[SessionStore] 会话归档读取失败（重试 ' + _archiveReadRetries + ' 次仍拿不到），本批暂存待下次追加合并: ' + file);
                        var pend = _archivePending[file] || (_archivePending[file] = []);
                        pend.push(msgs);
                        return false;
                    }
                    var existing = [];
                    if (res.status === 'ok') {
                        try {
                            var parsed = JSON.parse(res.text);
                            if (Array.isArray(parsed.messages)) existing = parsed.messages;
                        } catch (_) {
                            // 解析失败：先留 .corrupt 副本（对齐索引/消息文件的损坏保护），
                            // 再按空档合并——不备份就会在本次整包覆盖后彻底无法恢复
                            console.warn('[SessionStore] 会话归档 JSON 损坏: ' + file);
                            try { fs.writeFile(file + '.corrupt-' + Date.now() + '.bak', res.text).catch(function () {}); } catch (_) {}
                        }
                    }
                    // pending 批次（读失败时暂存的更旧批次，按暂存顺序）先于本批、后于盘上已有
                    var merged = existing;
                    var pendingBatches = _archivePending[file] || [];
                    for (var pb = 0; pb < pendingBatches.length; pb++) {
                        merged = merged.concat(pendingBatches[pb]);
                    }
                    merged = merged.concat(msgs);
                    if (merged.length > maxArchiveMessages) {
                        merged = merged.slice(merged.length - maxArchiveMessages);
                    }
                    var payload = JSON.stringify({ version: 1, sessionId: id, messages: merged });
                    // 改走既有原子写（.tmp → rename，写盘崩溃不留半截 JSON）；
                    // 同文件读-改-写已在 _archiveChains 串行化，满足 _atomicWriteJson 的
                    // 「同一文件原子写须串行」前提。
                    return _atomicWriteJson(fs, file, payload).then(function (ok) {
                        if (ok === false) {
                            console.warn('[SessionStore] 会话归档写入失败（本次追加未落盘）: ' + file);
                            return false;
                        }
                        // 写成功才清 pending（失败时保留，等待下次追加重试合并）
                        delete _archivePending[file];
                        return true;
                    });
                }).catch(function () { return false; });
            }
            var chain = _archiveChains[file] || Promise.resolve();
            var run = chain.then(_doAppend, _doAppend);
            // 防止链断裂：吞掉 run 中的错误，由调用方自行处理（对齐 settingsStore 模式）
            _archiveChains[file] = run.catch(function () {});
            return run;
        }

        function loadArchive(id) {
            if (!fs) return Promise.resolve(null);
            var file = sessionsDir + '/' + id + '.archive.json';
            // 读通道失败返回 __readFailed 哨兵——消费方（read_early_history /
            // 清图引用收集器）不得把「拿不到」当「无归档」，否则挨个谎报「尚无归档」
            // 或在清图时按不完整引用集删文件。
            // 解析失败（文件在、内容坏了）与通道失败分开——先留
            // .corrupt-<ts>.bak 备份再返回 null（当无归档）。理由：坏档本来就读不出任何
            // 消息；若返回哨兵，清图收集器会把整轮引用集判为不完整（null）→ 龄清扫与
            // 2GB 预算清扫每 30 分钟直接跳过，temp 无界增长（仅 console.warn）。
            // read_early_history 对坏档报「无归档可读」同样诚实（原文已备份可人工恢复）。
            return _readTextTri(file).then(function (res) {
                if (res.status === 'missing') return null;
                if (res.status !== 'ok') return _readFailedSentinel();
                try {
                    var parsed = JSON.parse(res.text);
                    // 合法 JSON 但无 messages 数组：同样无归档可读 → null（不算通道故障）
                    return Array.isArray(parsed.messages) ? parsed.messages : null;
                } catch (_) {
                    console.warn('[SessionStore] 会话归档 JSON 损坏（已留副本，按无归档处理）: ' + file);
                    try { fs.writeFile(file + '.corrupt-' + Date.now() + '.bak', res.text).catch(function () {}); } catch (_) {}
                    return null;
                }
            });
        }

        // 清空会话时一并清归档──
        // 病灶：clearConversation 清掉消息/统计/计划后，<sid>.archive.json（上下文
        // 压缩丢弃的早期消息副本）仍在盘上，read_early_history 会把「已清空对话」的
        // 旧内容原样读回（清空确认文案明说「删除对话记录…不可恢复」，归档属于对话
        // 记录的一部分）。deleteSession 一直有清归档文件，本入口补上清空路径的同款。
        // 排进 _archiveChains 同一条链：与在途 saveArchive（读-改-写）串行——否则
        // 在途追加会在删除后把文件复活；同时作废该文件的待合并 pending 批次。
        function clearArchive(id) {
            if (!fs) return Promise.resolve(false);
            var file = sessionsDir + '/' + id + '.archive.json';
            function _doClear() {
                delete _archivePending[file];
                if (_deletedIds[id]) return Promise.resolve(true);
                if (typeof fs.deleteFile !== 'function') return Promise.resolve(true);
                return fs.deleteFile(file);
            }
            var chain = _archiveChains[file] || Promise.resolve();
            var run = chain.then(_doClear, _doClear);
            // 防止链断裂：吞掉 run 中的错误，由调用方自行处理（对齐 saveArchive 模式）
            _archiveChains[file] = run.catch(function () {});
            return run;
        }

        return {
            init: init,
            whenReady: whenReady,
            isReady: isReady,
            // 索引读失败保护态对外可见——清图引用收集器在枚举会话前先查，
            // 为真即整轮 fail-closed（哨兵态下 listSessions() 为空，枚举不到任何会话，
            // 零 task 会返回空引用集，清扫据此会删掉仍被旧会话引用的图）。
            isIndexReadFailed: function () { return _indexReadFailed; },
            listSessions: listSessions,
            getSession: getSession,
            getLastActiveId: getLastActiveId,
            createSession: createSession,
            // 团队会话落点：按**显式 id** 落空会话（id 由 binder 生成，三条 lane 共用一个；
            // controller.adoptSession 第 1 步的能力探测名单见 controller._ENSURE_API_NAMES）
            ensureSession: ensureSession,
            deleteSession: deleteSession,
            renameSession: renameSession,
            // 会话级 goal：读写索引条目的 goal 字段（与 title 同层）
            setGoal: setGoal,
            getGoal: getGoal,
            updateLastActive: updateLastActive,
            save: save,
            load: load,
            flush: flush,
            // 收口：卸载专用同步兜底（canvasIndex beforeunload 钩子调用）
            flushSync: flushSync,
            // 卸载专用——把挂起的防抖快照同步落盘（bootstrap beforeunload 调用）
            flushSyncNow: flushSyncNow,
            saveNow: saveNow,
            appendTo: appendTo,
            saveTokenStats: saveTokenStats,
            loadTokenStats: loadTokenStats,
            savePlan: savePlan,
            loadPlan: loadPlan,
            saveArchive: saveArchive,
            loadArchive: loadArchive,
            // 清空对话时清归档（apiActions.clearConversation 调用）
            clearArchive: clearArchive
        };
    }

    // 解析旧版 localStorage 会话数据为 UI 形态消息数组。
    // 旧值有两个写入方：外层 context.js persist() 写 {messages:[{role,text,...}]}，
    // 内层会话账本 save()（持久化已并入本文件 sessionStore.js）写 {conversationId,messages:[{role,content,...}],tokenStats}，
    // 二者都是「带 messages 数组的对象」（也容忍直接是数组的未来形态）。
    // 返回 null 表示数据形态无法识别（调用方应视为失败，保留旧键以便重试），
    // 返回数组（可为空）表示解析成功。
    function parseLegacyMessages(raw) {
        if (!raw) return null;
        var parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (_) {
            return null;
        }
        var arr = Array.isArray(parsed) ? parsed
            : (parsed && Array.isArray(parsed.messages) ? parsed.messages : null);
        if (!arr) return null;
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            var m = arr[i];
            if (!m || typeof m !== 'object') continue;
            out.push({
                role: m.role || 'assistant',
                // 内层 cm 的 LLM 形态用 content，外层 UI 形态用 text
                text: m.text || m.content || '',
                detail: m.detail || null,
                toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls
                    : (Array.isArray(m.tool_calls) ? m.tool_calls : null),
                toolCallId: m.toolCallId || m.tool_call_id || null,
                toolName: m.toolName || m.name || null,
                reasoningContent: m.reasoningContent || m.reasoning_content || '',
                createdAt: m.createdAt || Date.now()
            });
        }
        return out;
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createSessionStore = createSessionStore;
    global.AEEngine.parseLegacySessionMessages = parseLegacyMessages;
})(window);
