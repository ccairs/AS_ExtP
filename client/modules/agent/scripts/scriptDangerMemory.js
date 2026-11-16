// scriptDangerMemory.js — user-library 审计确认层
// per-script 确认记忆 + 确认弹窗编排：
//   - 锚定内容哈希（djb2 × sdbm 双 32 位 + 长度——审计确认层是防呆知情面非
//     执行边界，执行边界是运行时沙箱；代码变即哈希变即记忆失效即重新弹：
//     用户改脚本重新确认与防篡改绕过是同一机制）
//   - 存储：<dataDir>\agent\script-danger-memory.json（AEFS 读写；路径刻意
// 置于 scripts 库之外—— 配置自保护：宽通道文件写白名单须排除此路径，
//     防 LLM 预先「确认」自己的危险脚本）
//   - 脚本树 / quickBar 同库同哈希自然共享（读同一存储文件、同一内存态）
//   - 弹窗：优先 window.showConfirmEx（勾选框「此脚本不再提醒」，默认不勾）；
//     不可见时回退 showConfirm（无勾选形态 = 不写入记忆）；两者都缺席时 fail-closed
// 模块缺席容忍：调用方（service.js/quickBarExecutor.js）检测本模块缺席时
//   按 dangers 空=直跑处理（维持 Task 4 过渡态——运行时沙箱兜底不变）。
(function (global) {
    'use strict';

    var _mem = null;         // 已确认哈希表 {hash: true}（懒加载）
    var _loadPromise = null; // 加载 Promise（in-flight 复用——见 _load 竞态注记）
    // 三态读的「读失败态」——通道故障（拿不到而非文件不存在）时置位，
    // 此后 _save 拒绝覆盖写（防读不出的既有确认记忆被空表整包覆盖；对齐桌宠三库
    // _readFailed 模式）。读成功（含 NOT_FOUND/损坏备份后）才清除
    var _readFailed = false;
    var _readFailMsg = '';

    // 内容哈希：djb2(h1) × sdbm(h2) 双 32 位 + 内容长度
    function _hash(content) {
        var s = String(content);
        var h1 = 5381, h2 = 0;
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            h1 = ((h1 << 5) + h1 + c) >>> 0;
            h2 = (c + (h2 << 6) + (h2 << 16) - h2) >>> 0;
        }
        return h1.toString(16) + '-' + h2.toString(16) + '-' + s.length;
    }

    function _memPath() {
        try {
            if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                var dir = global.AEShared.getDataDir().dir;
                // dataDir 未就绪（initDataDir 完成前）返回空串——直接拼接会得到
                // '\agent\script-danger-memory.json'，必然读失败且命中「空记忆固化」链；
                // 空串下 _load 不固化 Promise、_save 直接拒写，就绪后下次调用重试
                if (!dir) return '';
                return dir + '\\agent\\script-danger-memory.json';
            }
        } catch (_) {}
        return '';
    }

    // ── 三态读（readFileResult 优先；旧式 AEFS 用 existsResult/exists 复核）──
    // 判据：ok → 正常解析；NOT_FOUND → 首次运行旧语义（可写）；
    // CHANNEL_FAILURE/REJECTED/通道异常 → 读失败态（拒覆盖写）
    function _readFileTriState(p) {
        if (global.AEFS && typeof global.AEFS.readFileResult === 'function') {
            return global.AEFS.readFileResult(p).then(function (r) {
                if (r && r.ok === true) return { status: 'ok', content: r.data };
                if (r && r.error && r.error.code === 'NOT_FOUND') return { status: 'notfound' };
                return { status: 'failed', message: (r && r.error && r.error.message) || 'readFileResult 失败' };
            }, function (e) { return { status: 'failed', message: (e && e.message) || String(e) }; });
        }
        if (!global.AEFS || typeof global.AEFS.readFile !== 'function') {
            return Promise.resolve({ status: 'failed', message: 'AEFS.readFile 不可用' });
        }
        return global.AEFS.readFile(p).then(function (content) {
            if (content !== null && content !== undefined) return { status: 'ok', content: content };
            if (typeof global.AEFS.existsResult === 'function') {
                return global.AEFS.existsResult(p).then(function (r) {
                    if (r && r.ok === true) return { status: 'failed', message: '文件存在但读取为空（通道故障）' };
                    if (r && r.error && r.error.code === 'NOT_FOUND') return { status: 'notfound' };
                    return { status: 'failed', message: (r && r.error && r.error.message) || 'existsResult 失败' };
                }, function (e) { return { status: 'failed', message: (e && e.message) || String(e) }; });
            }
            if (typeof global.AEFS.exists === 'function') {
                return global.AEFS.exists(p).then(function (ex) {
                    return ex ? { status: 'failed', message: '文件存在但读取为空（通道故障）' } : { status: 'notfound' };
                }, function (e) { return { status: 'failed', message: (e && e.message) || String(e) }; });
            }
            // 旧式沙箱/降级 AEFS：无任何存在性复核原语——退回折叠契约（null=不存在），
            // 保持既有测试/降级环境行为；生产 AEFS 恒有 readFileResult，不落此支
            return { status: 'notfound' };
        }, function (e) { return { status: 'failed', message: (e && e.message) || String(e) }; });
    }

    // 解析失败：损坏原件先改名备份（.corrupt-<时间戳>）再当空记忆（保留证据）
    function _backupCorruptFile(p) {
        if (!global.AEFS || typeof global.AEFS.renameFile !== 'function') return Promise.resolve(false);
        var bakPath = p + '.corrupt-' + Date.now();
        return global.AEFS.renameFile(p, bakPath).then(function (ok) {
            if (ok) {
                try { console.warn('[scriptDangerMemory] 记忆文件 JSON 损坏，原件已备份到: ' + bakPath); } catch (_) {}
            }
            return !!ok;
        }, function () { return false; });
    }

    // 原子写：先写 <file>.tmp 再 rename 到正式名（定稿形态，同源对齐
    // sessionStore._atomicWriteJson / petSettings._atomicWriteFile）；renameFile 不可用
    // （旧 mock/降级 AEFS）回退直写
    function _atomicWriteFile(filePath, content) {
        if (typeof global.AEFS.renameFile !== 'function') {
            return Promise.resolve(global.AEFS.writeFile(filePath, content)).then(function (ok) {
                return ok !== false;
            }, function () { return false; });
        }
        var tmpPath = filePath + '.tmp';
        var _inRetry = false;
        var _recoverySeq = 0;
        function _nextRecoveryPath() {
            _recoverySeq = (_recoverySeq + 1) % 1000000000;
            return filePath + '.recovery-' + Date.now() + '-' + _recoverySeq;
        }
        function _cleanupTmp() {
            try { if (global.AEFS.deleteFile) global.AEFS.deleteFile(tmpPath).catch(function () {}); } catch (_) {}
        }
        function _preserveBothCopies(asidePath, movedOk) {
            var keepPath = _nextRecoveryPath();
            var park = global.AEFS.renameFile(tmpPath, keepPath).catch(function () {});
            var restore = movedOk ? global.AEFS.renameFile(asidePath, filePath).catch(function () {}) : null;
            return Promise.all([park, restore || Promise.resolve()]).then(function () { return false; });
        }
        return global.AEFS.writeFile(tmpPath, content).then(function (writeOk) {
            if (!writeOk) { _cleanupTmp(); return false; }
            return global.AEFS.renameFile(tmpPath, filePath).then(function (renameOk) {
                if (renameOk) return true;
                var recheck = (typeof global.AEFS.exists === 'function')
                    ? global.AEFS.exists(tmpPath) : Promise.resolve(true);
                return recheck.then(function (tmpAlive) {
                    if (!tmpAlive) return false;
                    var asidePath = _nextRecoveryPath();
                    _inRetry = true;
                    var moveAside = global.AEFS.renameFile(filePath, asidePath).then(function (ok) { return ok; },
                        function () { return false; });
                    return moveAside.then(function (movedOk) {
                        return global.AEFS.renameFile(tmpPath, filePath).then(function (retryOk) {
                            if (!retryOk) return _preserveBothCopies(asidePath, movedOk);
                            if (movedOk && global.AEFS.deleteFile) {
                                try { global.AEFS.deleteFile(asidePath).catch(function () {}); } catch (_) {}
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

    // 竞态修正（收官抽查，同 userTable 同族）：in-flight Promise 复用——修正前
    // 二次 _load 直接返回当前空表，加载窗口内并发 confirmExecution 的记忆命中检查
    // 与勾选后的 _save 均基于空表（误弹窗 + 覆写丢既有记忆——fail-closed 方向但
    // 记忆失效即重复打扰）
    // 读失败（通道故障）/路径或原语未就绪同样不固化 Promise——置读失败态
    // 拒写并允许后续调用重试；读成功（含 NOT_FOUND/损坏备份后）才固化并清除失败态
    function _load() {
        if (_loadPromise) return _loadPromise;
        _mem = {};
        var p = _memPath();
        if (!p || !global.AEFS || (typeof global.AEFS.readFile !== 'function' &&
                typeof global.AEFS.readFileResult !== 'function')) {
            return Promise.resolve(_mem);
        }
        _loadPromise = new Promise(function (resolve) {
            _readFileTriState(p).then(function (res) {
                if (res.status === 'failed') {
                    _readFailed = true;
                    _readFailMsg = res.message;
                    try {
                        console.warn('[scriptDangerMemory] 记忆读取失败（' + res.message
                            + '），进入保护态：拒绝覆盖写盘，原文件保留: ' + p);
                    } catch (_) {}
                    _loadPromise = null;
                    resolve(_mem);
                    return;
                }
                _readFailed = false;
                _readFailMsg = '';
                _mem = {};
                if (res.status === 'ok' && res.content) {
                    try {
                        var data = JSON.parse(res.content);
                        if (data && typeof data === 'object' && data.confirmed) {
                            for (var k in data.confirmed) {
                                if (Object.prototype.hasOwnProperty.call(data.confirmed, k)) {
                                    _mem[k] = 1;
                                }
                            }
                        }
                    } catch (_) {
                        // 损坏：备份原件后按空记忆继续（证据已在备份中；写盘不受阻）
                        _backupCorruptFile(p);
                    }
                }
                resolve(_mem);
            });
        });
        return _loadPromise;
    }

    // 写盘唯一出口：路径未就绪/读失败态拒写（返回 false，不做假成功）；
    // 成功路径 .tmp → rename 原子写，写盘瞬间崩溃不留半截 JSON
    function _save() {
        var p = _memPath();
        if (!p || !global.AEFS || typeof global.AEFS.writeFile !== 'function') return Promise.resolve(false);
        if (_readFailed) {
            try {
                console.warn('[scriptDangerMemory] 读取失败态：拒绝覆盖写确认记忆（原文件内容未读到，'
                    + '写回会用空记忆整包覆盖）: ' + p);
            } catch (_) {}
            return Promise.resolve(false);
        }
        var txt;
        try {
            txt = JSON.stringify({ confirmed: _mem });
        } catch (e) {
            try { console.error('[scriptDangerMemory] 记忆序列化失败:', e); } catch (_) {}
            return Promise.resolve(false);
        }
        return _atomicWriteFile(p, txt).then(function (ok) {
            if (!ok) {
                try { console.error('[scriptDangerMemory] 记忆写入失败: ' + p); } catch (_) {}
            }
            return !!ok;
        }, function (e) {
            try { console.error('[scriptDangerMemory] 记忆写入失败:', e); } catch (_) {}
            return false;
        });
    }

    // 危险清单 → 分区文案（两档 + 不可解析档；展示上限 20 条——防刷屏，
    // 溢出折叠为「另有 N 项」）
    function formatDangers(scriptName, dangers) {
        var cap = [], esc = [], parse = [];
        for (var i = 0; i < dangers.length; i++) {
            var d = dangers[i];
            var line = '第 ' + (d.line || 0) + ' 行 · ' + (d.construct || '?') +
                (d.reason ? '——' + d.reason : '');
            if (d.kind === 'capability') cap.push(line);
            else if (d.kind === 'parse') parse.push(line);
            else esc.push(line);
        }
        var all = cap.concat(esc).concat(parse);
        var shown = all.slice(0, 20);
        var msg = AEI18n.t('脚本「{name}」经审计包含以下危险内容：', { name: scriptName || AEI18n.t('未命名') }) + '\n\n';
        if (cap.length) msg += AEI18n.t('【能力类】（文件 / 系统 / 网络 / 菜单 / 写盘等操作）') + '\n' +
            cap.slice(0, 20).join('\n') + '\n\n';
        if (esc.length) msg += AEI18n.t('【逃逸形态类】（动态求值 / 原型链 / 沙箱内部面）') + '\n' +
            esc.slice(0, 20).join('\n') + '\n\n';
        if (parse.length) msg += AEI18n.t('【不可解析】') + '\n' + parse.slice(0, 20).join('\n') + '\n\n';
        if (all.length > shown.length) msg += AEI18n.t('……另有 {n} 项未列出', { n: all.length - shown.length }) + '\n\n';
        msg += AEI18n.t('确认后脚本将运行（危险操作仍受运行时沙箱拦截）。');
        return msg;
    }

    // 弹窗：优先 showConfirmEx（勾选框）；回退 showConfirm（无勾选框——checked 恒 false，不写入记忆）。
    // 两个弹窗模块都缺席时 fail-closed（拒执行）：原生 confirm 被项目规约禁用，且无面板弹窗时
    // 无法把标题/正文交给本地化层，宁可拒绝也不绕过确认链。
    function _showDangerConfirm(scriptName, dangers) {
        var msg = formatDangers(scriptName, dangers);
        var title = AEI18n.t('安全警告');
        if (typeof global.showConfirmEx === 'function') {
            return global.showConfirmEx(title, msg, 'confirm',
                { checkLabel: AEI18n.t('此脚本不再提醒') });
        }
        if (typeof global.showConfirm === 'function') {
            return global.showConfirm(title, msg, 'confirm')
                .then(function (ok) { return { ok: ok, checked: false }; });
        }
        return Promise.resolve({ ok: false, checked: false });
    }

    // 确认层编排（调用方入口）：dangers 非空 → 查记忆 → 无记忆弹确认
    //   resolve(true)  = 放行执行（含记忆命中直通）
    //   resolve(false) = 用户取消
    function confirmExecution(scriptName, content, dangers) {
        if (!dangers || dangers.length === 0) return Promise.resolve(true);
        return _load().then(function () {
            if (_mem && Object.prototype.hasOwnProperty.call(_mem, _hash(content))) {
                return true;
            }
            return _showDangerConfirm(scriptName, dangers).then(function (r) {
                if (!r || !r.ok) return false;
                if (r.checked && _mem) {
                    _mem[_hash(content)] = 1;
                    _save();
                }
                return true;
            });
        });
    }

    // 当次授权的能力域并集：dangers 能力类命中 → allow-set
    //（设计 4.1 终版矩阵「弹窗确认=当次授权」——确认放行后该域真实生效）。
    // system 域：system 标识符 / callSystem 成员（含计算键形态）；socket 域：
    // Socket 构造引用（含计算键形态）；file 域（对齐落定 6 修正）：
    // File/Folder 构造引用——确认 → 帧载荷 file:true 真实放行（核内经包装构造器，
    // _isSensitivePath 路径防线保持——修复 「确认了核内照样拦」的现存案例）。
    // 其余能力类（菜单命令域、$ / BridgeTalk / scheduleTask / runScriptFromFile
    // ——硬拒面无 allow 可授）不产生 allow。（saveProject 原在此列，随
    // 其全局宿主函数删除而移出：保存改走原生 app.project.save()，是成员名面。）
    function allowSetFromDangers(dangers) {
        var out = { system: false, socket: false, file: false };
        if (!dangers || !dangers.length) return out;
        for (var i = 0; i < dangers.length; i++) {
            var d = dangers[i];
            if (!d || d.kind !== 'capability') continue;
            var c = String(d.construct || '');
            if (c === 'Identifier:Socket' || c === 'ComputedMember:Socket') out.socket = true;
            else if (c === 'Identifier:File' || c === 'Identifier:Folder' ||
                c === 'ComputedMember:File' || c === 'ComputedMember:Folder') out.file = true;
            else if (c === 'Identifier:system' || c === 'Member:callSystem' ||
                c === 'ComputedMember:callSystem') out.system = true;
        }
        return out;
    }

    // 管理面（AST 门能力配置弹窗消费）：已确认清单 / 清空记忆。
    // 返回形态对齐既有存储结构：confirmed 表仅含内容哈希键（无脚本名/时间元数据），
    // 故 listConfirmed 返回哈希字符串数组；clearAll 清空内存态并重写文件。
    // clearAll 返回 {ok}——读失败态/写盘失败时不得谎报成功（modals 据此提示）；
    // 读失败态拒绝清空（盘上既有记忆未知，写空表＝丢用户确认）
    function listConfirmed() {
        return _load().then(function () {
            return Object.keys(_mem || {});
        });
    }

    function clearAll() {
        return _load().then(function () {
            if (_readFailed) {
                return { ok: false, code: 'READ_FAILED', message: '记忆读取失败（' + _readFailMsg
                    + '），已拒绝写盘以免覆盖盘上既有确认；请稍后重试' };
            }
            _mem = {};
            return _save().then(function (ok) {
                return ok
                    ? { ok: true }
                    : { ok: false, code: 'WRITE_FAILED', message: '记忆写盘失败（dataDir 不可写或写通道故障）' };
            });
        });
    }

    global.AEScriptDangerMemory = {
        confirmExecution: confirmExecution,
        allowSetFromDangers: allowSetFromDangers,
        formatDangers: formatDangers,
        listConfirmed: listConfirmed,
        clearAll: clearAll,
        _hash: _hash,
        // 测试辅助：重置内存态（磁盘态由测试桩控制）
        _reset: function () { _mem = null; _loadPromise = null; _readFailed = false; _readFailMsg = ''; },
        // 测试辅助：读失败态断言（拒写保护）
        _isReadFailed: function () { return _readFailed; }
    };
    // AE_LLM 挂载点（quickBar 经 global.AE_LLM 统一访问面板侧能力）
    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM._scriptDangerMemory = global.AEScriptDangerMemory;
})(typeof window !== 'undefined' ? window : globalThis);
