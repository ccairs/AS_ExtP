(function (global) {
    'use strict';
    // 团队任务清单：**一份清单属于团队会话，三条 Agent 共用**。
    //
    // 为什么不是「每条 lane 各一份」：团队是**一个**协作单元——导演拆的任务、AE 执行标完成的进度、
    // Shader 执行补的条目，用户看到的必须是同一份清单。分三份会让面板随「当前是哪条 lane」变色，
    // 也让三条 Agent 互相看不见对方记了什么。
    // 与「每个 Agent 自己的 todo」的关系：计划工具
    // （trackSteps / getPlanStatus / updatePlan）**回归 lane 的投放清单**，每 lane 各有一份自己的
    // plan（controller/state/store 都按 lane 分），用来跟踪**自己**的执行步骤；本清单是**共用**的
    // 那一份，放「谁在做什么、对外可见的进度」。两者并存，分工写在工具描述与角色段里。
    //
    // 存储落点：`<数据Dir>/agent/team/<团队会话id>/tasks.json`（团队工作区内，与 brief.md 同目录）。
    // 为什么放工作区而不是某个 lane 的 store：① 天然按团队会话隔离（切会话即换文件）；
    // ② 工作区已经有「会话 id 校验 + 路径安全 + 同文件串行写队列」（team/workspace.js），
    // 本模块**不重写**那一套，只调它的 read/write；③ 团队会话删除/切换时文件跟着走，不留孤儿。
    //
    // 内存 + 落盘的分工（与 sessionStore 同口径）：内存是**读的唯一来源**（UI/工具都读它），
    // 落盘是 fire-and-forget 的持久化；写失败**如实回报**（调用方拿到 persist Result，不静默成功）。
    //
    // 并发：同一团队会话里两条 lane 同时改 —— 内存 last-write-wins（团队清单本来就是协作产物，
    // 不做乐观锁；真要串行，落盘那层由 workspace 的写队列按文件串行）。故工具层提供
    // `add` / `set_status` 这两个**增量**动作：并行协作时用增量，整表替换只用于「重建清单」。
    //
    // 依赖注入（本文件不读任何全局，便于单测注入假 workspace）：
    //   workspace — team/workspace.js 实例（必须有 read / write）。缺省回落 global.AEAgentTeam.workspace
    //   onChange  — 清单变化通知（装配层接到「刷新团队任务面板」）
    //   onWarn    — 告警通道（缺省 console.warn）

    var TASK_STATUSES = { pending: true, running: true, done: true, failed: true };
    var TASKS_FILE = 'tasks.json';
    var VERSION = 1;
    // 清单是给用户看的短表（面板一段）：不设上限就是「模型往里塞 5000 行」。
    // 上限必须与**读**的上界对齐：`workspace.read` 单次只回 64K 字符
    //（`MAX_READ_CHARS`，截断并只给一个 truncated 标记）。写得进、读不回 = 自己写的东西自己
    // 解析不了（截断的 JSON 解析必失败）⇒ 内存当空 ⇒ 下一次写入把盘上那份覆盖掉。
    // 故两道闸：① 条数上限压到 100；② 落盘前按**序列化后字符数**再卡一次（描述含引号/反斜杠/
    // 换行时 JSON 转义会翻倍，条数闸挡不住）。两道都挡在「改内存之前」（拒绝零副作用）。
    var MAX_TASKS = 100;
    var MAX_DESC_CHARS = 300;
    var MAX_PAYLOAD_CHARS = 60000;   // 留 4K 余量给 JSON 外壳与未来字段

    function _msg(e) { return (e && e.message) ? String(e.message) : String(e); }

    function createTaskList(opts) {
        var o = opts || {};

        function _workspace() {
            if (o.workspace && typeof o.workspace.read === 'function' && typeof o.workspace.write === 'function') return o.workspace;
            var api = global.AEAgentTeam;
            if (api && api.workspace && typeof api.workspace.read === 'function') return api.workspace;
            return null;
        }

        function _warn(m) {
            if (typeof o.onWarn === 'function') { try { o.onWarn(m); return; } catch (_) { /* 告警通道坏了不该打穿 */ } }
            if (global.console && console.warn) console.warn(m);
        }

        function _notify() {
            if (typeof o.onChange !== 'function') return;
            try { o.onChange(); } catch (e) { _warn(AEI18n.t('[TeamTaskList] onChange 抛错: ') + _msg(e)); }
        }

        var _sid = '';          // 当前团队会话 id（'' = 未绑定：读写都显式失败）
        var _steps = [];        // 归一后的清单（内存 = 读的唯一来源）
        var _updatedAt = 0;
        var _updatedBy = '';
        var _loadedSid = '';    // 已从盘上载入过的会话（幂等 bind 用）
        var _loadSeq = 0;       // 载入世代号：切会话后旧结果一律作废（不把 A 的清单贴到 B 上）
        // 读失败保护态（与 sessionStore 的 _readFailedIds 同口径）：**读不到**（通道故障/
        // 被拒）时内存只能是空表，此时若放行写入，一次 add/replace 就会把盘上那份完好的清单
        // 覆盖成一条两条——用户与三条 Agent 的协作产物**静默清空**，是本模块最坏的失败。
        // 故：读不到 ⇒ 禁用写入，直到某次载入成功（如实回报 read_failed，并告知原文件未被触碰）。
        // 注意与「内容不可用」分开：文件**读得到但解析不出**时先留一份 .corrupt-<ts>.bak 再放行
        //（原文可恢复），那种情况不是「读不到」，一律禁写会让功能永久卡死。
        var _readFailed = false;
        var _readFailedReason = '';
        var _corruptBackedUp = {};   // sid -> 已**成功**留过副本的原文（同一份原文只留一份）
        var _corruptBackupP = {};    // sid -> { raw, promise }：在途/最近一次备份尝试（失败即清 ⇒ 可重试）

        // ── 归一（唯一的校验实现：工具层不再自己判一遍）────────────────────────────
        // 返回 { ok:true, steps } 或显式失败 { ok:false, reason, index?, status? }。
        // 空表 / 缺 description / 未知 status 一律拒绝——静默接受会让面板上出现一行空白任务，
        // 模型还以为记上了。
        function normalizeTasks(list) {
            if (!list || typeof list.length !== 'number') return { ok: false, reason: 'empty' };
            if (!list.length) return { ok: false, reason: 'empty' };
            if (list.length > MAX_TASKS) return { ok: false, reason: 'too_many', limit: MAX_TASKS, count: list.length };
            var out = [];
            var seen = {};   // 显式编号的唯一性：重复编号会让 set_status(numbers:[n])
            var auto = 0;    // 一次改多行（三条 lane 并行时更容易撞），故显式编号重复一律拒绝
            for (var i = 0; i < list.length; i++) {
                var t = list[i] || {};
                var desc = (typeof t.description === 'string') ? t.description
                    : (typeof t.title === 'string' ? t.title : '');
                desc = desc.replace(/^\s+|\s+$/g, '');
                if (!desc) return { ok: false, reason: 'bad_description', index: i };
                if (desc.length > MAX_DESC_CHARS) return { ok: false, reason: 'too_long', index: i, limit: MAX_DESC_CHARS };
                var st = String(t.status || 'pending');
                if (!TASK_STATUSES[st]) return { ok: false, reason: 'bad_status', index: i, status: st };
                var num = (typeof t.number === 'number' && t.number > 0) ? t.number : 0;
                if (num) {
                    if (seen[String(num)]) return { ok: false, reason: 'duplicate_number', index: i, number: num };
                    seen[String(num)] = true;
                } else {
                    // 缺省编号：**从 1 起**取第一个尚未被占用的号（不是「接在最大编号之后」——实测是
                    // 显式 5 + 缺省 ⇒ 5,1；显式 3 + 两个缺省 ⇒ 3,1,2）。
                    // 只看**已出现过**的编号，故缺省号与显式编号的先后顺序无关；也不能直接按 i+1 补
                    //（会与显式编号撞号）。行为已被测试固化，改注释不改行为。
                    auto++;
                    num = auto;
                    while (seen[String(num)]) { auto++; num = auto; }
                    seen[String(num)] = true;
                }
                out.push({ number: num, description: desc, status: st });
            }
            return { ok: true, steps: out };
        }

        function _copy(steps) {
            var out = [];
            for (var i = 0; i < steps.length; i++) {
                out.push({ number: steps[i].number, description: steps[i].description, status: steps[i].status });
            }
            return out;
        }

        function _nextNumber(steps) {
            var max = 0;
            for (var i = 0; i < steps.length; i++) if (steps[i].number > max) max = steps[i].number;
            return max + 1;
        }

        function _statusOf(raw) {
            var st = String(raw || '');
            return TASK_STATUSES[st] ? st : '';
        }

        function _label(s) {
            return s.status === 'done' ? AEI18n.t('已完成') : (s.status === 'running' ? AEI18n.t('进行中') : (s.status === 'failed' ? AEI18n.t('失败') : AEI18n.t('待办')));
        }

        // ── 落盘 ─────────────────────────────────────────────────────────────────
        // 候选内容的序列化形态（不落内存、不落盘）：供**写前**卡字符数用（见 MAX_PAYLOAD_CHARS）。
        function _payloadOf(steps, by) {
            return JSON.stringify({
                version: VERSION,
                sessionId: _sid,
                updatedAt: Date.now(),
                updatedBy: (typeof by === 'string') ? by : '',
                steps: _copy(steps)
            });
        }

        function _payload() {
            return JSON.stringify({
                version: VERSION,
                sessionId: _sid,
                updatedAt: _updatedAt,
                updatedBy: _updatedBy,
                steps: _copy(_steps)
            });
        }

        // 落盘（写队列由 workspace 按「会话 + 相对路径」串行）。返回 Promise<{ ok, reason? }>。
        function _persist() {
            var ws = _workspace();
            if (!ws) return Promise.resolve({ ok: false, reason: 'no_workspace' });
            if (!_sid) return Promise.resolve({ ok: false, reason: 'no_team_session' });
            var p = null;
            try {
                p = ws.write(TASKS_FILE, _payload(), { teamSessionId: _sid, mode: 'replace', internal: true });
            } catch (e) {
                return Promise.resolve({ ok: false, reason: 'throw', detail: _msg(e) });
            }
            return Promise.resolve(p).then(function (r) {
                if (r && r.ok === true) return { ok: true, path: r.path };
                return { ok: false, reason: (r && r.reason) || 'write_failed', detail: (r && r.message) || '' };
            }, function (e) {
                return { ok: false, reason: 'rejected', detail: _msg(e) };
            });
        }

        // 盘 → 内存。文件不存在 ⇒ 空清单（不是错误：新会话本来就没有清单）。
        function load() {
            var ws = _workspace();
            if (!ws || !_sid) return Promise.resolve({ ok: false, reason: _sid ? 'no_workspace' : 'no_team_session' });
            var mySid = _sid;
            var seq = ++_loadSeq;
            var p = null;
            try {
                p = ws.read(TASKS_FILE, mySid, { internal: true });
            } catch (e) {
                return Promise.resolve({ ok: false, reason: 'throw', detail: _msg(e) });
            }
            return Promise.resolve(p).then(function (r) {
                // 世代号：切走会话后迟到的载入结果一律作废
                if (seq !== _loadSeq || mySid !== _sid) return { ok: false, reason: 'stale' };
                if (!r || r.ok !== true) {
                    if (r && r.reason === 'not_found') {
                        // 确定没有这份文件（首启/新会话）⇒ 空清单，**放行写入**
                        _steps = []; _updatedAt = 0; _updatedBy = ''; _loadedSid = mySid;
                        _readFailed = false; _readFailedReason = '';
                        _notify();
                        return { ok: true, count: 0, empty: true };
                    }
                    // 读不到（通道故障/被拒）：进保护态 ⇒ 禁用写入（见 _readFailed 注释）
                    _readFailed = true;
                    _readFailedReason = String((r && r.reason) || 'read_failed');
                    _warn(AEI18n.t('[TeamTaskList] 团队任务清单读取失败（') + mySid + AEI18n.punct('）', ')', '）') + ': ' + _readFailedReason
                        + ' ' + ((r && r.message) || '') + AEI18n.t('——已进入保护态：本次会话内禁用清单写入，')
                        + AEI18n.t('盘上原文件未被触碰'));
                    _steps = []; _updatedAt = 0; _updatedBy = ''; _loadedSid = mySid;
                    _notify();
                    return { ok: false, reason: _readFailedReason, protected: true };
                }
                _readFailed = false;
                _readFailedReason = '';
                // **截断**：`workspace.read` 单次只回 64K 字符，超出即截断。
                // 截断的 JSON 解析必失败 ⇒ 若按「内容不可用」处理就会：留一份**残缺**副本、
                // 内存当空、**放行写入** ⇒ 下一次写入把盘上那份完整清单覆盖掉（自己写的东西自己
                // 读不回，静默丢数据）。故截断一律按「读不到」处理：进保护态禁写、**不置 _loadedSid**
                //（可重试）、也**不留**残缺副本（留了会让人以为原文已保全）。
                // 写侧已按 MAX_PAYLOAD_CHARS 卡住（见 normalizeTasks 上方的注释），故这条只会在
                // 「文件被外部改大到 64K 以上」时触发。
                if (r.truncated === true) {
                    _readFailed = true;
                    _readFailedReason = 'truncated';
                    _warn(AEI18n.t('[TeamTaskList] 团队任务清单超过单次读取上限（') + mySid + '，size='
                        + (typeof r.size === 'number' ? r.size : '?') + AEI18n.t(' 字符）——已进入保护态：')
                        + AEI18n.t('本次会话内禁用清单写入（截断内容解析不出，写下去会把盘上原文件覆盖掉）；')
                        + AEI18n.t('盘上原文件未被触碰，请人工检查工作区里的 ') + TASKS_FILE);
                    _steps = []; _updatedAt = 0; _updatedBy = '';
                    _notify();
                    return { ok: false, reason: 'truncated', protected: true };
                }
                var parsed = null;
                try { parsed = JSON.parse(r.content); } catch (_) { parsed = null; }
                var norm = normalizeTasks(parsed && parsed.steps);
                if (!norm.ok) {
                    // 读得到但内容不可用：先留一份 .corrupt-<ts>.bak（原文可恢复）再放行写入——
                    // 与「读不到」分开处置，否则功能会永久卡死（见 _readFailed 注释）。
                    // **必须 await 备份结果**（低危真缺陷修复）：只有备份**真的成功**才允许放行写入与
                    // 出现「已留副本」这类断言；失败（ok!==true / reject / 抛）时原文还在盘上是唯一
                    // 一份，放行写入就是把它覆盖掉 ⇒ 进保护态禁写，文案如实说「备份失败」。
                    return _backupCorruptOnce(mySid, r.content).then(function (bk) {
                        // 备份是异步的：期间可能已切走会话（世代号），迟到的处置一律作废
                        if (seq !== _loadSeq || mySid !== _sid) return { ok: false, reason: 'stale' };
                        _steps = []; _updatedAt = 0; _updatedBy = '';
                        if (!bk || bk.ok !== true) {
                            _readFailed = true;
                            _readFailedReason = 'backup_failed';
                            _warn(AEI18n.t('[TeamTaskList] 团队任务清单内容不可用（') + mySid + AEI18n.punct('）', ')', '）') + ': ' + JSON.stringify(norm)
                                + AEI18n.t('——原文备份失败（') + ((bk && bk.reason) || 'unknown') + ' '
                                + ((bk && bk.detail) || '') + AEI18n.t('），已停止写入以免覆盖原文；')
                                + AEI18n.t('盘上原文件未被触碰，请人工检查工作区里的 ') + TASKS_FILE);
                            _notify();
                            return { ok: false, reason: 'backup_failed', protected: true };
                        }
                        _warn(AEI18n.t('[TeamTaskList] 团队任务清单内容不可用（') + mySid + AEI18n.punct('）', ')', '）') + ': ' + JSON.stringify(norm)
                            + AEI18n.t('——已留 .corrupt 副本') + (bk.name ? '（' + bk.name + '）' : '')
                            + AEI18n.t('，可重新建立清单'));
                        _loadedSid = mySid;
                        _notify();
                        return { ok: true, count: 0, empty: true };
                    });
                }
                _steps = norm.steps;
                _updatedAt = (typeof parsed.updatedAt === 'number') ? parsed.updatedAt : 0;
                _updatedBy = (typeof parsed.updatedBy === 'string') ? parsed.updatedBy : '';
                _loadedSid = mySid;
                _notify();
                return { ok: true, count: _steps.length, empty: _steps.length === 0 };
            }, function (e) {
                if (seq !== _loadSeq || mySid !== _sid) return { ok: false, reason: 'stale' };
                _readFailed = true;
                _readFailedReason = 'rejected';
                _warn(AEI18n.t('[TeamTaskList] 团队任务清单读取异常（') + mySid + AEI18n.punct('）', ')', '）') + ': ' + _msg(e)
                    + AEI18n.t('——已进入保护态：本次会话内禁用清单写入，盘上原文件未被触碰'));
                _steps = []; _loadedSid = mySid;
                _notify();
                return { ok: false, reason: 'rejected', protected: true };
            });
        }

        // 内容不可用的原文副本：同一份原文只留一份（同 sessionStore 的 _backupCorruptOnce 口径）。
        //
        // **返回 Promise<{ok, reason?, detail?, name}>**：调用方必须 await 后再决定文案与放行与否。
        // 为什么：`ws.write` 全路径返回 Promise<Result>、**不抛**——只 try/catch
        // 同步抛的写法对异步失败完全失明：写盘失败时盘上**一份副本都没有**，却已经被登记成「已备份」，
        // 调用方照旧放行写入 ⇒ 下一次写入把盘上那份唯一的原文覆盖掉（不可恢复），而告警还在说
        // 「已留 .corrupt 副本」。故：`ok!==true` / reject / 同步抛**一律不算备份成功**，显式告警并
        // 带上 reason/message；只有 `ok===true` 才记进 _corruptBackedUp（失败不留缓存，下次可重试）。
        function _backupCorruptOnce(sid, raw) {
            // 原文为空（或非字符串）：**没有可丢的内容**，也没什么可备份的 ⇒ 不算失败，
            // 保持既有「可重建清单」的行为（别把一个空文件变成永久禁写的保护态）。
            if (typeof raw !== 'string' || !raw) return Promise.resolve({ ok: true, empty: true });
            if (_corruptBackedUp[sid] === raw) return Promise.resolve({ ok: true, reused: true });
            var inflight = _corruptBackupP[sid];
            if (inflight && inflight.raw === raw) return inflight.promise;
            var ws = _workspace();
            var name = TASKS_FILE + '.corrupt-' + Date.now() + '.bak';
            var base = null;
            if (!ws) {
                base = Promise.resolve({ ok: false, reason: 'no_workspace', name: name });
            } else {
                var p = null;
                try {
                    p = ws.write(name, raw, { teamSessionId: sid, mode: 'replace', internal: true });
                } catch (e) {
                    base = Promise.resolve({ ok: false, reason: 'throw', detail: _msg(e), name: name });
                }
                if (!base) {
                    base = Promise.resolve(p).then(function (r) {
                        if (r && r.ok === true) return { ok: true, name: name, path: r.path };
                        return {
                            ok: false, name: name,
                            reason: (r && r.reason) || 'write_failed',
                            detail: (r && r.message) || ''
                        };
                    }, function (e) {
                        return { ok: false, reason: 'rejected', detail: _msg(e), name: name };
                    });
                }
            }
            var token = { raw: raw, promise: null };
            token.promise = base.then(function (r) {
                if (r && r.ok === true) { _corruptBackedUp[sid] = raw; return r; }
                _warn(AEI18n.t('[TeamTaskList] 损坏原文备份失败（') + sid + AEI18n.punct('）', ')', '）') + ': '
                    + ((r && r.reason) || 'unknown') + (r && r.detail ? ' ' + r.detail : '')
                    + AEI18n.t('——未能留 .corrupt 副本（尝试的文件名 ') + name + '）');
                // 失败不进「已备份」缓存 ⇒ 同 sid 同原文下次载入会重试（成功才免重）
                if (_corruptBackupP[sid] === token) _corruptBackupP[sid] = null;
                return r;
            });
            _corruptBackupP[sid] = token;
            return token.promise;
        }

        // ── 会话绑定 ─────────────────────────────────────────────────────────────
        // 同一个 sid 重复通知（binder 的幂等 bind / noteRestored 都会再发一次）⇒ 不重载、不清内存：
        // 重载会把「刚写进内存、还没落盘」的改动闪回旧值。
        function bindSession(sid) {
            var next = (typeof sid === 'string' && sid) ? sid : '';
            if (!next) return reset();
            // 幂等：同一 sid 重复通知不重载（免得把「刚写进内存还没落盘」的改动闪回旧值）。
            // **例外**：保护态下必须重试——否则「读失败 ⇒ 禁写」会一直卡到换会话/重载面板，
            // 用户把文件修好后没有任何自愈路径。
            if (next === _sid && _loadedSid === next && !_readFailed) {
                return Promise.resolve({ ok: true, sid: next, count: _steps.length, reused: true });
            }
            if (next === _sid && _readFailed) {
                return load().then(function (r) { r.sid = next; return r; });
            }
            _sid = next;
            _steps = [];
            _updatedAt = 0;
            _updatedBy = '';
            _loadedSid = '';
            _readFailed = false;      // 保护态是**上一个会话**的事实：换会话即重判（载入结果说了算）
            _readFailedReason = '';
            return load().then(function (r) {
                r.sid = next;
                return r;
            });
        }

        function reset() {
            _sid = '';
            _steps = [];
            _updatedAt = 0;
            _updatedBy = '';
            _loadedSid = '';
            _readFailed = false;
            _readFailedReason = '';
            _loadSeq++;
            _notify();
            return Promise.resolve({ ok: true, sid: '', count: 0 });
        }

        function getSessionId() { return _sid; }
        function isLoaded() { return !!_sid && _loadedSid === _sid; }
        function isReadFailed() { return !!_readFailed; }
        function readFailedReason() { return _readFailedReason; }

        // 写入前的闸门：三道，任一不过就**不写**（宁可报错，不可静默覆盖）——
        //   · 未绑定团队会话：没有可写的落点；
        //   · 读失败保护态：盘上那份可能是完好的，只是这次读不到 ⇒ 写会把它覆盖成空/短表；
        //   · 载入未落地：此刻写会与迟到的载入结果打架（谁赢取决于时序 = 不可复现的数据错）。
        function _writeBlocked() {
            if (!_sid) return { reason: 'no_team_session' };
            // 没有工作区 = 没有落点：清单是**协作产物**，只在内存里等于重载即丢，故直接拒绝写入
            //（与「写失败但仍给内存」不同：那是落点存在、这次写挂了，内存态对用户仍有意义）。
            if (!_workspace()) return { reason: 'no_workspace' };
            if (_readFailed) {
                return { reason: 'read_failed', detail: _readFailedReason, protected: true };
            }
            if (_loadedSid !== _sid) return { reason: 'not_loaded' };
            return null;
        }

        // 快照（**副本**：调用方改不动内存，UI 也不会被下一次写入就地改到）
        function snapshot() {
            return {
                sid: _sid,
                steps: _copy(_steps),
                updatedAt: _updatedAt,
                updatedBy: _updatedBy
            };
        }

        // 归一 + 落内存 + 通知 + 落盘。meta: { by }（哪条 lane 写的，给面板显示）
        function _commit(steps, meta) {
            _steps = steps;
            _updatedAt = Date.now();
            _updatedBy = (meta && typeof meta.by === 'string') ? meta.by : '';
            _loadedSid = _sid;
            // 提交即作废在途载入：否则「bind 发起的读」迟到落地会把刚写进内存的
            // 内容清空/闪回旧值，紧接着的写入再把盘上那份覆盖成旧快照（谁赢取决于时序）。
            _loadSeq++;
            _notify();
            return _persist();
        }

        // 写前卡两件事，**都发生在改内存之前**（拒绝必须零副作用）：
        //   ① 序列化后的字符数 ≤ MAX_PAYLOAD_CHARS（否则写出去自己读不回，见 MAX_TASKS 上方注释）；
        //   ② 通过则提交。
        function _commitChecked(steps, meta) {
            var size = _payloadOf(steps, (meta && meta.by) || '').length;
            if (size > MAX_PAYLOAD_CHARS) {
                return { ok: false, reason: 'too_large', limit: MAX_PAYLOAD_CHARS, size: size };
            }
            return { ok: true, persist: _commit(steps, meta) };
        }

        // 整表替换（工具的 action=replace，缺省行为）。**会覆盖其他 Agent 的条目**——
        // 工具描述里明写了协作规则：整表替换只用于重建清单，增量协作要用 add / set_status。
        function replace(list, meta) {
            var blocked = _writeBlocked();
            if (blocked) return Object.assign({ ok: false }, blocked);
            var norm = normalizeTasks(list);
            if (!norm.ok) return norm;
            var committed = _commitChecked(norm.steps, meta);
            if (!committed.ok) return committed;
            return { ok: true, steps: _copy(_steps), count: _steps.length, persist: committed.persist };
        }

        // 追加（工具的 action=add）：编号接在现有最大编号之后（不覆盖已有条目）。
        function add(list, meta) {
            var blocked = _writeBlocked();
            if (blocked) return Object.assign({ ok: false }, blocked);
            var norm = normalizeTasks(list);
            if (!norm.ok) return norm;
            var steps = _copy(_steps);
            if (steps.length + norm.steps.length > MAX_TASKS) {
                return { ok: false, reason: 'too_many', limit: MAX_TASKS, count: steps.length + norm.steps.length };
            }
            var n = _nextNumber(steps);
            for (var i = 0; i < norm.steps.length; i++) {
                var s = norm.steps[i];
                // 追加项的编号**一律**接在现有最大编号之后：沿用调用方给的编号
                // 会与现有条目撞号，而 set_status 按 number 命中是「命中几行改几行」。
                steps.push({ number: n, description: s.description, status: s.status });
                n++;
            }
            var committed = _commitChecked(steps, meta);
            if (!committed.ok) return committed;
            return {
                ok: true, steps: _copy(_steps), count: _steps.length, added: norm.steps.length,
                // 本次追加的条目（含分配后的编号）：装配层据此生成「谁新增了什么」的通知。
                addedItems: _copy(_steps.slice(_steps.length - norm.steps.length)),
                persist: committed.persist
            };
        }

        // 改状态（工具的 action=set_status）：按 number 或 description（全等，去首尾空白）匹配。
        // 一个都没命中 ⇒ 显式失败（模型拿着 not_found 去读一遍清单，比静默成功有用）。
        function setStatus(keys, status, meta) {
            var blocked = _writeBlocked();
            if (blocked) return Object.assign({ ok: false }, blocked);
            var st = _statusOf(status);
            if (!st) return { ok: false, reason: 'bad_status', status: String(status || '') };
            var numbers = (keys && keys.numbers && typeof keys.numbers.length === 'number') ? keys.numbers : [];
            var descs = (keys && keys.descriptions && typeof keys.descriptions.length === 'number') ? keys.descriptions : [];
            if (!numbers.length && !descs.length) return { ok: false, reason: 'no_keys' };
            var wantNum = {};
            for (var i = 0; i < numbers.length; i++) wantNum[String(numbers[i])] = true;
            var wantDesc = {};
            for (var j = 0; j < descs.length; j++) {
                if (typeof descs[j] !== 'string') continue;
                wantDesc[descs[j].replace(/^\s+|\s+$/g, '')] = true;
            }
            var steps = _copy(_steps);
            var hit = 0;
            var changedItems = [];
            for (var k = 0; k < steps.length; k++) {
                var s = steps[k];
                if (wantNum[String(s.number)] || wantDesc[s.description]) {
                    s.status = st; hit++;
                    changedItems.push({ number: s.number, description: s.description, status: st });
                }
            }
            if (!hit) return { ok: false, reason: 'not_found' };
            var committed = _commitChecked(steps, meta);
            if (!committed.ok) return committed;
            return {
                ok: true, steps: _copy(_steps), count: _steps.length, changed: hit,
                // 本次命中的条目（含新状态）：装配层据此生成「谁把哪几条改成了什么」的通知。
                changedItems: changedItems,
                persist: committed.persist
            };
        }

        return {
            bindSession: bindSession,
            reset: reset,
            getSessionId: getSessionId,
            isLoaded: isLoaded,
            isReadFailed: isReadFailed,
            readFailedReason: readFailedReason,
            snapshot: snapshot,
            load: load,
            replace: replace,
            add: add,
            setStatus: setStatus,
            normalizeTasks: normalizeTasks,
            // 文案单源在 team/taskBoard.js（TASK_STATUS_TEXT）；这里只给测试/工具用的极简映射
            labelOf: _label
        };
    }

    global.AEAgentTeam = global.AEAgentTeam || {};
    global.AEAgentTeam.createTaskList = createTaskList;
    global.AEAgentTeam.TASK_LIST_FILE = TASKS_FILE;
    global.AEAgentTeam.TASK_LIST_STATUSES = TASK_STATUSES;
    global.AEAgentTeam.TASK_LIST_MAX_TASKS = MAX_TASKS;
})(typeof window !== 'undefined' ? window : globalThis);
