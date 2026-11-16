// userTable.js — 用户增补表（白名单类型表补表层）
// 双层表管理：tables.js = 只读种子（维护者随版本发布）；
//   本模块 = 用户增补（dataDir JSON，可增删回滚——scriptDangerMemory 存储先例）。
// 路径：<dataDir>\ast-gate-user-table.json——刻意置于 scripts 库外；且该文件名已列入
//   aeTools.jsx _isSensitivePath 黑名单（writeFile 参数工具/核内 file 域写/外层
//   路径补丁三面同拒——配置自保护铁律延伸：宽通道不可写本表，写表仅经提议确认
//   弹窗与管理面）。
// 即时生效：add/remove/clearAll 写盘后立即调 AEGate.tables.applyUserAdditions /
//   resetToSeed + 重放剩余增补（validate 每次 gate 调用现读 AEGate.tables——零缓存）。
// 模块缺席容忍：本模块未载（旧测试沙箱六件装载）时 tables 保持纯种子（fail-closed
//   方向），既有套件零影响。
(function (global) {
    'use strict';

    var _additions = null;      // {Type: {member: {t,m,w,d,sourceUrl,reason,createdAt,reviewed}}}
    // 除危险硬拒外不限制用户需求——增补层从「只能给已有类型
    // 加成员」扩到三类能力，存储结构 v2：
    //   _newTypes  {Type: {sourceUrl,reason,createdAt,reviewed}}  新增类型
    //   _overrides {Type: {member: {t,m,w,...}}}                  改写种子条目的判定
    // v1 文件（只有 additions/version:1）按空表迁移，不丢增补。
    var _newTypes = null;
    var _overrides = null;
    var _loadPromise = null;    // 加载 Promise（in-flight 复用——见 _load 竞态注记）
    // 三态读的「读失败态」——readFileResult/存在性复核判定为通道故障（拿不到，
    // 而非文件不存在）时置位；此后 _persist 拒绝一切覆盖写，防「读不出的盘上增补被空表
    // 整包覆盖」（对齐桌宠三库 _readFailed 模式：petSettings.js/petMemory.js/petHistory.js）。
    // 读成功（含 NOT_FOUND）即清除；JSON 损坏走 .corrupt 备份后按空表继续（可写）
    var _readFailed = false;
    var _readFailMsg = '';

    function _tablePath() {
        try {
            if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                var dir = global.AEShared.getDataDir().dir;
                // dataDir 未就绪（initDataDir 完成前）返回空串：_load 据此不固化加载
                // Promise，就绪后下次调用重新加载（否则空路径读失败固化空表）
                if (!dir) return '';
                return dir + '\\ast-gate-user-table.json';
            }
        } catch (_) {}
        return '';
    }

    // ── 三态读（readFileResult 优先；旧式 AEFS 用 existsResult/exists 复核）──
    // 判据：ok → 正常解析；NOT_FOUND → 首次运行旧语义（可写）；
    // CHANNEL_FAILURE/REJECTED/通道异常/无法判定 → 读失败态（拒覆盖写）。
    // readFile 把「文件不存在」与「通道故障」都折叠成 null，JSON.parse(null)
    // 不抛 → 空表 + _loadPromise 固化 → 下次落表整包覆写盘上既有增补（无备份）。
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
            // 空串是「成功读到 0 字节文件」而非失败（readFile 契约：失败恒 null）
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
            // 旧式沙箱/降级 AEFS：既无 readFileResult 也无存在性复核原语——无从判定
            // 「真没有」还是「拿不到」，退回折叠契约（null=不存在，可写）以保持既有
            // 测试/降级环境行为；生产 AEFS 恒有 readFileResult（aefs.js 导出），不落此支
            return { status: 'notfound' };
        }, function (e) { return { status: 'failed', message: (e && e.message) || String(e) }; });
    }

    // 解析失败：先把损坏原件改名备份（.corrupt-<时间戳>）再当空表——保留原文件证据，
    // 后续写盘不再裸覆盖原件（对齐 petSettings._backupCorruptFile）
    function _backupCorruptFile(p) {
        if (!global.AEFS || typeof global.AEFS.renameFile !== 'function') return Promise.resolve(false);
        var bakPath = p + '.corrupt-' + Date.now();
        return global.AEFS.renameFile(p, bakPath).then(function (ok) {
            if (ok) {
                try { console.warn('[userTable] 增补表 JSON 损坏，原件已备份到: ' + bakPath); } catch (_) {}
            }
            return !!ok;
        }, function () { return false; });
    }

    // 原子写：先写 <file>.tmp 再 rename 到正式名（定稿形态，同源对齐
    // sessionStore._atomicWriteJson / petSettings._atomicWriteFile）——写盘瞬间崩溃不再
    // 留下半截 JSON；renameFile 不可用（旧 mock/降级 AEFS）回退直写，无原子写保护
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
        // rename 失败兜底：tmp 是新内容唯一副本，绝不清理——改名 .recovery- 留存；
        // 挪到旁路的旧正式文件尽力放回原位（放回失败则旧内容留在旁路名下）
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

    // 懒加载 + 冷启动合并（模块 init 发起；加载窗口内 seed-only = 更严，安全方向）。
    // 竞态修正（审查发现 2）：in-flight Promise 复用——修正前二次 _load 直接返回
    // 当前空表，加载窗口内 add 的同键检查与 _persist 序列化均基于空表，冷启动窗口
    // 内落表会覆写丢失盘上既有增补。
    // 竞态修正时序变体（线上启动实测）：模块装载期 fire-and-forget _load 在
    // initDataDir 完成前发起 → 路径不可用时同样不得固化 _loadPromise（否则就绪后
    // add/_persist 仍基于固化空表，覆写丢失盘上既有增补）
    // 读失败（通道故障）同样不固化 _loadPromise——置 _readFailed 拒写并允许
    // 后续调用重试；读成功（含 NOT_FOUND/损坏备份后）才固化并清除读失败态
    function _emptyAll() {
        _additions = {};
        _newTypes = {};
        _overrides = {};
    }

    // bucket 拷贝（只接受 plain object；类型/成员名不做校验——合并层还会再校验一遍）。
    // 跳过原型污染键：dst['__proto__']=obj 改的是桶对象原型而非
    // 自有属性，JSON.stringify 只序列化自有属性 → 「add 报成功但门/盘都看不到」的漂移。
    var _BUCKET_FORBIDDEN_KEYS = { '__proto__': 1, 'constructor': 1, 'prototype': 1 };
    function _copyBucket(src, dst) {
        if (!src || typeof src !== 'object') return;
        for (var k in src) {
            if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
            if (_BUCKET_FORBIDDEN_KEYS[k]) continue;
            dst[k] = src[k];
        }
    }

    function _load() {
        if (_loadPromise) return _loadPromise;
        _emptyAll();
        var p = _tablePath();
        if (!p || !global.AEFS || (typeof global.AEFS.readFile !== 'function' &&
                typeof global.AEFS.readFileResult !== 'function')) {
            return Promise.resolve(_additions);
        }
        _loadPromise = new Promise(function (resolve) {
            _readFileTriState(p).then(function (res) {
                if (res.status === 'failed') {
                    // 通道故障：不 applyLive（盘上增补未知，保持 seed-only 更严方向）、
                    // 不固化 Promise（清除后下次调用可重试）、置读失败态拒写
                    _readFailed = true;
                    _readFailMsg = res.message;
                    try {
                        console.warn('[userTable] 增补表读取失败（' + res.message
                            + '），进入保护态：拒绝覆盖写盘，原文件保留: ' + p);
                    } catch (_) {}
                    _loadPromise = null;
                    resolve(_additions);
                    return;
                }
                _readFailed = false;
                _readFailMsg = '';
                _emptyAll();
                if (res.status === 'ok' && res.content) {
                    try {
                        var data = JSON.parse(res.content);
                        if (data && typeof data === 'object') {
                            // v1（仅 additions）向前兼容：缺 newTypes/overrides 按空表
                            _copyBucket(data.additions, _additions);
                            _copyBucket(data.newTypes, _newTypes);
                            _copyBucket(data.overrides, _overrides);
                        }
                    } catch (_) {
                        // 损坏：备份原件后按空表继续（写盘不受阻——证据已在备份中）
                        _backupCorruptFile(p);
                    }
                }
                _applyLive();
                resolve(_additions);
            });
        });
        return _loadPromise;
    }

    // 合并态重放：种子重置 + 三类用户态整体 apply（防篡改再校验在 apply 内）
    function _applyLive() {
        var T = global.AEGate && global.AEGate.tables;
        if (!T) return;
        if (typeof T.applyUserState === 'function') {
            T.applyUserState({
                additions: _additions || {},
                newTypes: _newTypes || {},
                overrides: _overrides || {}
            });
            return;
        }
        // 旧 tables（无 applyUserState）降级：只有增补成员生效
        if (typeof T.resetToSeed === 'function') T.resetToSeed();
        if (typeof T.applyUserAdditions === 'function') T.applyUserAdditions(_additions || {});
    }

    // 三类状态的深拷贝快照（写盘失败回滚用——内存态不得领先磁盘）
    function _snapshot() {
        return JSON.stringify({
            additions: _additions || {}, newTypes: _newTypes || {}, overrides: _overrides || {}
        });
    }
    function _restore(snap) {
        try {
            var d = JSON.parse(snap);
            _additions = d.additions || {};
            _newTypes = d.newTypes || {};
            _overrides = d.overrides || {};
        } catch (_) {}
    }

    // _persist 唯一出口——读失败态/路径未就绪一律拒写（返回 false）；成功路径
    // 走 .tmp → rename 原子写，写盘瞬间崩溃不留半截 JSON（避免下次启动解析损坏再丢表）
    function _persist() {
        return new Promise(function (resolve) {
            var p = _tablePath();
            if (!p || !global.AEFS || typeof global.AEFS.writeFile !== 'function') {
                resolve(false); return;
            }
            if (_readFailed) {
                try {
                    console.warn('[userTable] 读取失败态：拒绝覆盖写增补表（原文件内容未读到，'
                        + '写回会用空表整包覆盖）: ' + p);
                } catch (_) {}
                resolve(false); return;
            }
            var txt;
            try {
                // v2：三类用户态一起落盘；读端对 v1 向前兼容
                txt = JSON.stringify({
                    version: 2,
                    additions: _additions || {},
                    newTypes: _newTypes || {},
                    overrides: _overrides || {}
                });
            } catch (e) {
                try { console.warn('[userTable] 增补表序列化失败: ' + e); } catch (_) {}
                resolve(false); return;
            }
            _atomicWriteFile(p, txt).then(function (ok) { resolve(!!ok); },
                function () { resolve(false); });
        });
    }

    // ── 机械预审三档（安全红线 ②：入参无 domain 字段——域标记只由本函数判定）──
    // proposal: { typeName, memberName, returnType, isMethod, writable, sourceUrl, reason }
    // 返回 { ok, tier: 'free'|'forced', domain: ''|'file', entry: {t,m?,w?,d?} }
    //   或 { ok: false, code, message }——code 见各分支。
    // 类型引用校验委托 tables.isValidTypeRef（单一真相源——含虚拟类型拒）；
    // 函数缺席（旧 tables 配载）按非法拒——fail-closed 方向
    function _validTypeRef(T, t, extra) {
        return !!(T && typeof T.isValidTypeRef === 'function') && T.isValidTypeRef(t, extra);
    }

    // 官方类型名 → 本门类型表里的等价名（**仅用于报错指引，不做自动改写**）。
    // 本门把官方类型族扁平化建模：PropertyGroup/PropertyBase/MaskPropertyGroup 并入 Property，
    // 各 Layer 子类并入 Layer。提议方照抄官方类型名会被类型引用校验拒（表里没有这个名字），
    // 若随后改用 user-object 收场，会丢掉该对象的方法面（真机实测：Layer.Effects
    // 收成 user-object 后 addProperty 被拒）。故拒绝时直接给出等价名，避免这条岔路。
    var FLATTENED_TYPE_ALIASES = {
        'PropertyGroup': 'Property',
        'PropertyBase': 'Property',
        'MaskPropertyGroup': 'Property',
        'AVLayer': 'Layer',
        'TextLayer': 'Layer',
        'ShapeLayer': 'Layer',
        'CameraLayer': 'Layer',
        'LightLayer': 'Layer',
        'ThreeDModelLayer': 'Layer',
        'ParametricMeshLayer': 'Layer'
    };

    function precheck(proposal) {
        var T = global.AEGate && global.AEGate.tables;
        if (!T || !T.TYPES) return { ok: false, code: 'GATE_NOT_READY', message: 'AST 门模块未就绪，无法提议' };
        var p = proposal || {};
        var tn = String(p.typeName || '');
        var mn = String(p.memberName || '');
        // 除危险硬拒外不限制用户需求：提议从「只能给已有类型加
        // 成员」扩到三类——newType=true 新增类型、override=true 改写已有条目判定、
        // 缺省为原「加成员」。安全不变量只剩三条：硬拒族、虚拟类型不可引用、能力域不可剥离。
        var wantNewType = p.newType === true;
        var wantOverride = p.override === true;
        if (!Object.prototype.hasOwnProperty.call(T.TYPES, tn)) {
            if (!wantNewType) {
                return {
                    ok: false, code: 'UNKNOWN_TYPE',
                    message: '类型「' + tn + '」不在白名单类型表中——若这是官方对象族需要建模，把 newType 置为 true 一并提出新增类型；'
                        + 'newType=false 时原防伪造判据不变（不能凭空加类型）'
                };
            }
            if (!/^[A-Za-z_$][\w$]*$/.test(tn)) {
                return { ok: false, code: 'BAD_TYPE_NAME', message: '新增类型名格式非法: ' + tn };
            }
            if (typeof T.isReservedTypeName === 'function' && T.isReservedTypeName(tn)) {
                return {
                    ok: false, code: 'RESERVED_TYPE_NAME',
                    message: '「' + tn + '」是保留类型名（基础类型/框架类型/已收录类型），不能新增同名类型'
                };
            }
        } else if (wantNewType) {
            return {
                ok: false, code: 'ALREADY_IN_TABLE',
                message: '类型「' + tn + '」已存在——给它加成员请把 newType 置为 false'
            };
        }
        // 虚拟类型（框架内部类型 / 域闸可达类型）不作增补宿主：
        // 其空成员表与「不可达」是安全承载，补表不往这里加成员、也不改写其条目。
        if (T.VIRTUAL_TYPES && T.VIRTUAL_TYPES[tn]) {
            return {
                ok: false, code: 'VIRTUAL_TYPE_HOST',
                message: '「' + tn + '」是框架/域闸内部类型（空成员表或不可达承载），不能往里加成员或改写条目'
            };
        }
        if (!/^[A-Za-z_$][\w$]*$/.test(mn)) {
            return { ok: false, code: 'BAD_MEMBER_NAME', message: '成员名格式非法: ' + mn };
        }
        // 三档之一：不可提议（硬拒族——直接拒，不弹给用户）
        if (T.HARD_DENY_MEMBERS[mn]) {
            return { ok: false, code: 'NOT_PROPOSABLE', message: '「' + mn + '」属硬拒族（沙箱逃逸/系统执行/延迟执行/meta-property 面），不可提议' };
        }
        var existsInTable = !!(T.TYPES[tn] && Object.prototype.hasOwnProperty.call(T.TYPES[tn], mn));
        if (wantOverride) {
            // 覆盖只能改写已存在条目（加成员走 additions——两条路径职责分开，避免
            // 「override 顺便造成员」这种双重语义）
            if (!existsInTable) {
                return {
                    ok: false, code: 'OVERRIDE_TARGET_MISSING',
                    message: '「' + tn + '.' + mn + '」不在类型表中，没有可覆盖的条目；新增成员请把 override 置为 false'
                };
            }
            if (_overrides && _overrides[tn] && Object.prototype.hasOwnProperty.call(_overrides[tn], mn)) {
                return { ok: false, code: 'ALREADY_IN_TABLE', message: '「' + tn + '.' + mn + '」已有用户改写（管理面可删除后重新提议）' };
            }
        } else {
            // 同键拒绝（种子 ∪ 增补）；新增类型没有种子，只有增补面
            if (existsInTable) {
                return {
                    ok: false, code: 'ALREADY_IN_TABLE',
                    message: '「' + tn + '.' + mn + '」已在白名单中——若要改写它的判定（返回类型/方法位/可写位），把 override 置为 true；'
                        + '若因能力域关被拒，请在「Agent 模块设置 > AST 门能力配置」开启对应域（与补表无关）'
                };
            }
            if (_additions && _additions[tn] && Object.prototype.hasOwnProperty.call(_additions[tn], mn)) {
                return { ok: false, code: 'ALREADY_IN_TABLE', message: '「' + tn + '.' + mn + '」已在用户增补表中（管理面可删除后重新提议）' };
            }
        }
        // 类型伪造防线：返回类型引用必须已存在且非虚拟类型（SystemObj/SocketObj
        // 等域闸虚拟类型不可引用——防经增补为不可达类型开普通成员链入口短路域闸）。
        // 新增类型例外：允许引用本次一并声明的类型名（extra）。
        var _extra = null;
        if (!Object.prototype.hasOwnProperty.call(T.TYPES, tn)) {
            _extra = {};
            _extra[tn] = 1;
        }
        if (!_validTypeRef(T, p.returnType, _extra)) {
            var _alias = FLATTENED_TYPE_ALIASES[String(p.returnType || '')];
            var _aliasHint = _alias
                ? '；「' + p.returnType + '」在本门已扁平并入「' + _alias + '」——请把 returnType 改为 ' + _alias
                    + ' 后重新提议（改用 user-object 会丢掉该对象的方法面，只能读属性不能调用方法）'
                : '';
            return { ok: false, code: 'BAD_RETURN_TYPE', message: '返回类型「' + p.returnType + '」非法（须为 string/number/boolean/u/self/user-object、array<X> 或联合，或类型表已收录的非虚拟类型名——SystemObj/SocketObj 等域闸虚拟类型不可引用）' + _aliasHint };
        }
        var url = String(p.sourceUrl || '');
        if (!/^https?:\/\/\S+$/.test(url)) {
            return { ok: false, code: 'BAD_SOURCE_URL', message: 'sourceUrl 须为官方文档 URL（http/https）——出处缺失直接拒' };
        }
        if (!String(p.reason || '').trim()) {
            return { ok: false, code: 'MISSING_REASON', message: 'reason（语义说明）必填' };
        }
        // 三档判定：强制挂域 / 自由收录（FileHandle 类型上的成员提案一律挂 file 域——
        // RESTRICTED_TYPES 成员提议强制走挂域档）。
        // POLICY_GATED.members 的按名挂点（executeCommand→menu）
        // 也要算强制挂域——否则预审报「能力域标记: 无」，自动收录决策会把 menu 成员
        // 当无域条目（实际执行仍被 validate 拦，但口径失真）。
        var tier = 'free', domain = '';
        if (T.FORCE_DOMAIN_MEMBERS[mn] || tn === 'FileHandle') {
            tier = 'forced'; domain = 'file';
        } else if (T.POLICY_GATED && T.POLICY_GATED.members && T.POLICY_GATED.members[mn]) {
            tier = 'forced'; domain = T.POLICY_GATED.members[mn].domain;
        }
        var entry = { t: String(p.returnType) };
        if (p.isMethod === true) entry.m = 'm';
        if (p.writable === true) entry.w = 1;
        if (domain) entry.d = domain;
        var kind = wantOverride ? 'override' : (wantNewType ? 'newType' : 'addition');
        return { ok: true, tier: tier, domain: domain, kind: kind, entry: entry };
    }

    // 落表（precheck 由工具层先跑；此处同键防御校验 + 写盘 + 即时合并）
    // 读失败态拒落表（不得基于空占位表改内存态）；写盘失败回滚内存增补并
    // 不 applyLive——内存态不得领先磁盘（否则门即时放行而重启后条目消失＝假成功）
    function add(proposal, reviewMeta) {
        var pc = precheck(proposal);
        if (!pc.ok) return Promise.resolve(pc);
        var p = proposal;
        return _load().then(function () {
            if (_readFailed) {
                return { ok: false, code: 'READ_FAILED', message: '增补表读取失败（' + _readFailMsg
                    + '），已拒绝写盘以免覆盖盘上既有增补；请稍后重试' };
            }
            var tn = String(p.typeName), mn = String(p.memberName);
            var kind = pc.kind || 'addition';
            // 加载后复查（precheck 可能跑在 _load 之前，见竞态注记——盘上已有条目不得重写）
            if (kind === 'override') {
                if (_overrides[tn] && Object.prototype.hasOwnProperty.call(_overrides[tn], mn)) {
                    return { ok: false, code: 'ALREADY_IN_TABLE', message: '「' + tn + '.' + mn + '」已有用户改写' };
                }
            } else {
                if (_additions[tn] && Object.prototype.hasOwnProperty.call(_additions[tn], mn)) {
                    return { ok: false, code: 'ALREADY_IN_TABLE', message: '「' + tn + '.' + mn + '」已在用户增补表中' };
                }
                if (kind === 'newType' && _newTypes[tn]) {
                    return { ok: false, code: 'ALREADY_IN_TABLE', message: '类型「' + tn + '」已在用户新增类型表中' };
                }
            }
            var e = pc.entry;
            var meta = {
                t: e.t, m: e.m, w: e.w, d: e.d,
                sourceUrl: String(p.sourceUrl), reason: String(p.reason || ''),
                createdAt: new Date().toISOString(),
                reviewed: !!(reviewMeta && reviewMeta.reviewed)
            };
            // 三类落位：newType 先建类型容器，再把成员写进 additions；override 单独桶
            var snap = _snapshot();
            if (kind === 'newType') {
                _newTypes[tn] = {
                    sourceUrl: meta.sourceUrl, reason: meta.reason,
                    createdAt: meta.createdAt, reviewed: meta.reviewed
                };
            }
            if (kind === 'override') {
                _overrides[tn] = _overrides[tn] || {};
                _overrides[tn][mn] = meta;
            } else {
                _additions[tn] = _additions[tn] || {};
                _additions[tn][mn] = meta;
            }
            return _persist().then(function (ok) {
                if (!ok) {
                    // 回滚（三类一起还原——磁盘未变，内存态不得领先）
                    _restore(snap);
                    _applyLive();
                    return { ok: false, code: 'WRITE_FAILED', message: '增补表写盘失败（dataDir 不可写或写通道故障）' };
                }
                _applyLive();
                return { ok: true, tier: pc.tier, domain: pc.domain, kind: kind };
            });
        });
    }

    // 删除单条：增补条目优先；同时存在用户改写时一并删除（否则删除只删一半，
    // 管理面会显示「删了但行为没变」）
    function remove(typeName, memberName) {
        return _load().then(function () {
            if (_readFailed) {
                return { ok: false, code: 'READ_FAILED', message: '增补表读取失败（' + _readFailMsg
                    + '），已拒绝写盘；请稍后重试' };
            }
            var snap = _snapshot();
            if (_additions[typeName] && Object.prototype.hasOwnProperty.call(_additions[typeName], memberName)) {
                delete _additions[typeName][memberName];
                if (_keys(_additions[typeName]).length === 0) delete _additions[typeName];
            }
            if (_overrides[typeName] && Object.prototype.hasOwnProperty.call(_overrides[typeName], memberName)) {
                delete _overrides[typeName][memberName];
                if (_keys(_overrides[typeName]).length === 0) delete _overrides[typeName];
            }
            return _persist().then(function (ok) {
                if (!ok) {
                    // 回滚：磁盘未变，内存态不得显示已删除
                    _restore(snap);
                    _applyLive();
                    return { ok: false, code: 'WRITE_FAILED', message: '增补表写盘失败（dataDir 不可写或写通道故障）' };
                }
                _applyLive();
                return { ok: true };
            });
        });
    }

    // 删除整个新增类型（连带其成员增补/改写——类型没了，成员条目无宿主）
    function removeType(typeName) {
        return _load().then(function () {
            if (_readFailed) {
                return { ok: false, code: 'READ_FAILED', message: '增补表读取失败（' + _readFailMsg + '），已拒绝写盘；请稍后重试' };
            }
            var snap = _snapshot();
            delete _newTypes[typeName];
            delete _additions[typeName];
            delete _overrides[typeName];
            return _persist().then(function (ok) {
                if (!ok) {
                    _restore(snap);
                    _applyLive();
                    return { ok: false, code: 'WRITE_FAILED', message: '增补表写盘失败（dataDir 不可写或写通道故障）' };
                }
                _applyLive();
                return { ok: true };
            });
        });
    }
    function _keys(o) { var r = []; for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) r.push(k); } return r; }

    function clearAll() {
        return _load().then(function () {
            if (_readFailed) {
                return { ok: false, code: 'READ_FAILED', message: '增补表读取失败（' + _readFailMsg
                    + '），已拒绝写盘；请稍后重试' };
            }
            var snap = _snapshot();
            _emptyAll();
            return _persist().then(function (ok) {
                if (!ok) {
                    _restore(snap);   // 回滚：清空未落盘
                    _applyLive();
                    return { ok: false, code: 'WRITE_FAILED', message: '增补表写盘失败（dataDir 不可写或写通道故障）' };
                }
                _applyLive();
                return { ok: true };
            });
        });
    }

    function getAdditions() {
        return _load().then(function () {
            if (_readFailed) {
                // 读失败不得以空表上报（管理面会显示「暂无增补条目」＝谎报数据丢失）；
                // 调用方（modals.js）已有 catch 渲染「增补表读取失败」
                return Promise.reject(new Error('增补表读取失败（' + _readFailMsg + '），原文件未读取到'));
            }
            var out = {};
            for (var tn in _additions) {
                if (Object.prototype.hasOwnProperty.call(_additions, tn)) {
                    out[tn] = {};
                    for (var mn in _additions[tn]) {
                        if (Object.prototype.hasOwnProperty.call(_additions[tn], mn)) out[tn][mn] = _additions[tn][mn];
                    }
                }
            }
            return out;
        });
    }

    // 三类用户态整体读取（管理面用；getAdditions 保持只返回增补成员的旧契约）
    function getState() {
        return _load().then(function () {
            if (_readFailed) {
                return Promise.reject(new Error('增补表读取失败（' + _readFailMsg + '），原文件未读取到'));
            }
            return {
                additions: JSON.parse(JSON.stringify(_additions || {})),
                newTypes: JSON.parse(JSON.stringify(_newTypes || {})),
                overrides: JSON.parse(JSON.stringify(_overrides || {}))
            };
        });
    }

    global.AEGate = global.AEGate || {};
    global.AEGate.userTable = {
        precheck: precheck, add: add, remove: remove, removeType: removeType, clearAll: clearAll,
        getAdditions: getAdditions, getState: getState, _load: _load,
        // 启动链重放入口：本模块随 scripts.manifest 早于 initDataDir 装载，模块 init 的
        // fire-and-forget _load() 在数据目录未就绪时只能落空（设计：不固化、等下次调用重读）。
        // 面板启动链在 initDataDir 完成后调一次 load()，否则重启后盘上增补表静默不生效
        //（真机实测：Layer.Effects 已收录，重启后仍报「未收录」）。
        load: _load,
        // 测试钩子：_persist 拒写断言（读失败态返回 false）
        _persist: _persist,
        _isReadFailed: function () { return _readFailed; }
    };
    _load(); // 冷启动合并（fire-and-forget）
})(typeof window !== 'undefined' ? window : globalThis);
