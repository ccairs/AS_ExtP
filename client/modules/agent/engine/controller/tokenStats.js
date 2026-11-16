(function (global) {
    'use strict';
    function createTokenStats(opts) {
        // opts 注入：{ getActiveStore, getActiveCm, view }
        // 新增 getTokenStats()：返回**本 lane** 的统计存储实例（团队模式：controller 按 lane
        // 注入 AEEngine.tokenStatsFor(laneId)）。不传 ⇒ 回落 global.AEEngine.tokenStats
        // （单 Agent 路径，行为与注入前逐字一致）。注入了就以它为准、拿不到实例时**不回落**缺省实例：
        // 否则 lane 的记录会悄悄写进缺省实例——正是本次要消除的「三 lane 共写一份数组」。

        // 逐轮防抖落盘：统计只**在切走会话/切模式/卸载模块**三个时刻写盘时，
        // 而面板非正常重载（部署换包、AE 重启、面板直接关闭）走不到卸载——当前会话的
        // 记录随内存消失，重开后该会话统计为 '--'（线上实测的根因主路径）。
        // 与消息的 saveActiveSessionDebounced 对齐：每轮结束即安排落盘。
        // 时长可经 opts.saveDebounceMs 覆盖（测试用；生产不传 = 1000ms）
        var SAVE_DEBOUNCE_MS = (typeof opts.saveDebounceMs === 'number' && opts.saveDebounceMs >= 0)
            ? opts.saveDebounceMs : 1000;
        var _saveTimer = null;

        function _clearSaveTimer() {
            if (_saveTimer) {
                clearTimeout(_saveTimer);
                _saveTimer = null;
            }
        }

        function _scheduleSave() {
            if (_saveTimer) return;   // 已有待触发：合并（连轮不叠加计时器）
            _saveTimer = setTimeout(function () {
                _saveTimer = null;
                saveCurrentTokenStats();
            }, SAVE_DEBOUNCE_MS);
        }

        // 本 lane 的统计存储实例（每次调用现取：登记换实例后即时生效）。
        // 不传 getTokenStats ⇒ 缺省实例（单 Agent 路径）；传了就以注入的为准（拿不到 → null，不回落）。
        function _resolveStats() {
            if (typeof opts.getTokenStats === 'function') return opts.getTokenStats() || null;
            return (global.AEEngine && global.AEEngine.tokenStats) || null;
        }

        // 把 sendStream 返回的 usage 记入 tokenStats，并刷新 UI 显示
        // result 为 sendStream 的返回值；stage 用于统计分组
        // timing: 可选 { firstTokenMs, llmDurationMs }（主循环 LLM 流式调用的计时指标）
        // 返回新记录引用（无 usage 时返回 null），供工具执行完毕后回填工具耗时
        function recordStreamUsage(result, stage, timing) {
            if (!result || !result.usage) return null;
            var stats = _resolveStats();
            if (!stats || typeof stats.addRecord !== 'function') return null;
            var rec = stats.addRecord(stage || 'agent-stream', result.usage, timing);
            // 记录归属：这一轮是在 cm 当前指向的会话上跑的，记录就属于该会话。
            // 显式记下来，保存时才能校验「别把 A 的记录写进 B 的文件」。
            var cm = opts.getActiveCm();
            if (cm && typeof cm.getSessionId === 'function') {
                stats.sessionId = cm.getSessionId();
            }
            if (typeof opts.view.updateTokenStats === 'function') {
                opts.view.updateTokenStats(stats.getTotal());
            }
            _scheduleSave();
            return rec;
        }

        // 逐条消息防抖保存到 session 文件。文件只在切换/清空时写入——
        // 面板直接关闭时 load 到陈旧文件，会遮蔽 localStorage 里的新镜像（丢自上次切换以来的消息）。
        // 传 cm.list()（浅拷贝快照）而非 exportMessages()（深拷贝）：消息只增不改，
        // 防抖落盘时 stringify 最新 pending，省去每条消息一次全量深拷贝。无 store 的极简环境守卫跳过。
        function saveActiveSessionDebounced() {
            var store = opts.getActiveStore();
            var cm = opts.getActiveCm();
            if (!store || !cm || typeof store.save !== 'function') return;
            // 会话历史读失败守卫：读不出的原文件是**唯一副本**。单 Agent 的
            // switchSession 在 read_failed 时中止切换（原会话内存态原样恢复），而团队
            // adoptSession 已同步返回、中止不了——只能在落盘口挡住覆写：否则用户在新会话里
            // 发一条消息，store.save 会用「只有这一条」的内容整包覆盖掉读不出的原文件。
            if (typeof opts.isSessionWriteBlocked === 'function') {
                var blocked = false;
                try { blocked = opts.isSessionWriteBlocked() === true; } catch (_) { blocked = false; }
                if (blocked) return;
            }
            store.save(cm.getSessionId(), cm.list());
        }

        // 保存当前会话的 token 统计到独立文件。三个时刻调用：每轮结束（防抖）、
        // 切走会话/切模式前、模块卸载前（flushCurrentTokenStats）。
        //
        // 两条承重规则（缺任一条就是线上丢数据的那条链）：
        // ① **空记录一律不写盘**。本函数在切走/卸载时被无条件调用，而那些时刻 records
        //    常常已被 reset() 清空——把 [] 写下去只会把磁盘上已有的好数据清成空
        //    （'--' 的判据正是「记录数组为空」，故一次空写 = 该会话统计永久归零）。
        //    真要清空由显式清空操作直接调 store.saveTokenStats(id, [])，不经此处。
        // ② **归属校验**：records 属于哪个会话只写哪个会话。cm 与 records 不同步的窗口
        //    （切模式的二次写、external→script 回退映射）会把记录写进错误的会话文件。
        function saveCurrentTokenStats() {
            var store = opts.getActiveStore();
            var cm = opts.getActiveCm();
            var stats = _resolveStats();
            if (!store || !cm || !stats || typeof store.saveTokenStats !== 'function') return false;
            var records = stats.records || [];
            if (!records.length) return false;   // 规则①：空记录不写盘
            var targetId = cm.getSessionId();
            if (!targetId) return false;
            if (stats.sessionId == null) {
                // 归属未知（记录由极简环境/测试直接塞入）：以当前会话认领，不阻断正常保存
                stats.sessionId = targetId;
            } else if (stats.sessionId !== targetId) {
                console.warn('[TokenStats] 跳过保存：记录属于会话 ' + stats.sessionId
                    + '，当前会话为 ' + targetId + '（防写错会话文件）');
                return false;
            }
            return store.saveTokenStats(targetId, records);
        }

        // 取消待触发的防抖保存并立即落盘。面板关闭/模块卸载时调用——这是最后一个
        // 保证写盘的机会，此后内存态不再可达。
        function flushCurrentTokenStats() {
            _clearSaveTimer();
            return saveCurrentTokenStats();
        }

        // 从独立文件恢复目标会话的 token 统计并刷新 UI 显示。
        // 无记录（新会话/旧会话首次迁移 / 文件不存在）则清零，显示 '--'。
        // 读失败（哨兵）时**保持内存记录不动**：把它当"无记录"会让下一次保存把 [] 固化上盘，
        // 一次瞬时读失败即永久清空该会话统计。
        function restoreTokenStats(sessionId) {
            var store = opts.getActiveStore();
            var stats = _resolveStats();
            if (!store || !stats || typeof store.loadTokenStats !== 'function') return Promise.resolve();
            return store.loadTokenStats(sessionId).then(function (records) {
                if (records && records.__readFailed) {
                    console.warn('[TokenStats] 会话 ' + sessionId + ' 的统计文件读取失败，保留内存记录且不覆盖原文件');
                    // 仍刷新一次显示：调用方（switchSession/switchMode）在恢复前已 reset()，
                    // 不刷新的话顶栏会停留**上一个会话**的数字（读数比 '--' 更误导）
                    if (typeof opts.view.updateTokenStats === 'function') {
                        opts.view.updateTokenStats(stats.getTotal());
                    }
                    return;
                }
                stats.records = Array.isArray(records) ? records : [];
                stats.sessionId = sessionId;
                if (typeof opts.view.updateTokenStats === 'function') {
                    opts.view.updateTokenStats(stats.getTotal());
                }
            }).catch(function () {});
        }

        return {
            recordStreamUsage: recordStreamUsage,
            saveActiveSessionDebounced: saveActiveSessionDebounced,
            saveCurrentTokenStats: saveCurrentTokenStats,
            flushCurrentTokenStats: flushCurrentTokenStats,
            restoreTokenStats: restoreTokenStats
        };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createTokenStats = createTokenStats;
})(typeof global !== 'undefined' ? global : window);
