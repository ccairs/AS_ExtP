(function (global) {
    'use strict';
    // api 门面内联实体方法外提。纯迁移自 controller.js api 对象的实体方法体，
    // 收敛为 createApiActions(opts) 返回的薄动作集，controller.js api 门面只保留签名 + 一行委托。
    // 涉及的 controller 闭包可变状态经 getter/setter 惰性注入（stopping/injectQueue/stop 三件套/
    // activePlan）；global.* 与 opts.*(llmChannel/getModel/getPlatform/getSettings) 直接引用。
    // 注入项见 controller.js 组装区 createApiActions 调用处注释。
    function createApiActions(opts) {
        // 本 lane 的 token 统计存储（团队模式）：由 controller 注入 getTokenStats；
        // 不注入时回落缺省单例 ⇒ 单 Agent 路径行为与改动前一致。
        // 为什么不能直接读 global.AEEngine.tokenStats：三条 lane 会共写同一份数组，
        // 一条 lane 的「清空对话」会把另外两条 lane 的统计一起清掉（串台路径）。
        function _statsStore() {
            if (typeof opts.getTokenStats === 'function') {
                try {
                    var s = opts.getTokenStats();
                    if (s) return s;
                } catch (_) { /* 注入方异常时回落单例，不阻断清空/渲染 */ }
            }
            return (global.AEEngine && global.AEEngine.tokenStats) || null;
        }
        function setModeByDebug(enabled) {
            opts.state.mode = enabled ? 'B' : 'A';
            // DEBUG 决定工具卡片「查看详情」（入参/返回）是否渲染，而 renderMessages 是增量渲染
            // （_renderedCount 追平消息数即早退）：不重置计数，已渲染的消息不会按新 debug 态重建。
            // 登记为待重建，由 chatViewHelpers.syncView 在「列表可见且没有活元素」时消费——
            // 开关只在主面板的全局设置里（保存生效时 Agent 面板 display:none、列表无布局盒），
            // 此处通常重建不了；等用户回到模块那次 syncView 才做，重建后落在最新消息。
            opts.state.debugRebuildPending = true;
            opts.chatViewHelpers.syncView();
        }

        // ══════════════════════════════════════════════════════════
        //  后台结果「待唤起」队列
        //
        //  目的：后台任务（当前唯一生产者是 ComfyUI 生图，见 modules/comfyui/bootstrap.js
        //  的 _backgroundPoll）完成时若 Agent 已待机，主动起一轮让 LLM 回应结果。
        //  背景：待机分支若只落卡片 + 写上下文、**不叫醒 LLM** —— 用户提交生图任务后
        //  待机（正是该功能的典型场景）就永远收不到结果，要等用户下次开口才被顺带看到。
        //
        //  为什么必须独立于 _injectQueue（用户消息队列）：
        //   ① _injectQueue 的条目语义是「用户消息」，其 drain 规则是「取最后一条 user text
        //      续跑」；Script 分支更明确 `if (!lastText) return defaultReturn;`——纯
        //      system-result 会被整条吞掉（不触发续跑）；
        //   ② 混队会让用户消息与后台结果抢同一次续跑。
        //  本队列只承载「某会话有后台结果待唤起」这句意图（内容已由 pushSystemResult 写进
        //  cm），故同会话多条结果天然合并为一次唤起，不会连跑多轮。
        // ══════════════════════════════════════════════════════════
        var _bgWakeQueue = [];        // [{ sessionId, origin? }]
        var _bgWakeRunning = false;   // drain 重入守卫（唤起轮自身收尾会再调一次）

        // 本轮发起者标记：goal 续轮要能被工具权限识别成 'goal'，
        // 而普通后台结果唤起是 'bg'。默认 bg；条目带了 origin 就用条目的。
        function _setOrigin(o) {
            if (typeof opts.setTurnOrigin === 'function') {
                try { opts.setTurnOrigin(o); } catch (_) {}
            }
        }

        // 安全时机判定：六个守卫全假。与 injectSystemResult 的入队守卫同源
        // （busy/stopping/switching/dispatching/msgActionBusy/restoring）——即便漏判，
        // 起轮前同步置 busy 仍与 submitUserInput 的 `busy || _stopping || _dispatching`
        // 判据互斥，用户此刻发送只会走追加队列，不会形成两个并发循环。
        function _bgWakeGuarded() {
            return !!(opts.state.busy
                || (opts.getStopping && opts.getStopping())
                || (opts.getSwitching && opts.getSwitching())
                || (opts.getDispatching && opts.getDispatching())
                || (opts.getMsgActionBusy && opts.getMsgActionBusy())
                || opts.state.restoring);
        }

        function _currentSessionId() {
            try { return opts.chatViewHelpers.getActiveCm().getSessionId() || ''; } catch (_) { return ''; }
        }

        // 入队（同会话已有待唤起条目即合并，不重复排）
        // origin：goal 续轮的唤起要标 'goal'（工具 complete/blocked 权限依赖它），
        // 普通后台结果不传 ⇒ 'bg'。合并时已有条目优先，不覆盖。
        function enqueueBgWake(sessionId, origin) {
            var sid = sessionId || _currentSessionId();
            if (!sid) return;
            for (var i = 0; i < _bgWakeQueue.length; i++) {
                if (_bgWakeQueue[i].sessionId === sid) {
                    if (!_bgWakeQueue[i].origin && origin) _bgWakeQueue[i].origin = origin;
                    return;
                }
            }
            _bgWakeQueue.push({ sessionId: sid, origin: origin || null });
        }

        // 尝试唤起：安全时机 + 目标会话仍是当前会话 + Agent 模块已挂载，才起一轮。
        // 结构性无效的条目（模式不符/会话已切走）**丢弃并继续取下一个**——若 drop 后直接
        // 返回，排在它后面的可唤起条目会被挡住（例：模块未挂载期间先入队会话 A，之后切到
        // 会话 B 又入队 B，队列 [A,B]——A 无效不等于 B 无效）。
        function tryWakeBgResult() {
            if (_bgWakeRunning) return;
            // 时机/挂载检查在循环外求值一次（循环体内无 await，取值不变）
            if (_bgWakeGuarded()) return;
            // Agent 模块未挂载（用户切到别的模块）：不起轮——否则会在用户没在看的面板里
            // 空跑一轮 LLM（耗 token），回话也要等重开模块才可见。`undefined`（未 stamp，
            // 如单测直接构造 controller）视为已挂载，不因此被挡。条目保留待挂载后补唤起。
            if (global.AEEngine && global.AEEngine.agentUiMounted === false) return;

            while (_bgWakeQueue.length > 0) {
                var entry = _bgWakeQueue.shift();
                // 模式门（双保险）：只给「工具循环」起轮——Agent/Shader 天然放行。Script 模式
                // 支持 goal 续轮，故**仅 goal 来源的唤起**在 Script 档
                // 放行；普通后台结果（ComfyUI/MCP 等 bg）仍不在 Script 档起轮（那轮会拿到
                // 「生成脚本」提示词 + 空用户文本，语义退化；跨模式本来也被下方会话门挡住）。
                var _mode = '';
                try { _mode = ((opts.getSettings && opts.getSettings()) || {}).runtimeMode || ''; } catch (_) {}
                if (_mode !== 'agent' && _mode !== 'shader'
                    && !(_mode === 'script' && entry.origin === 'goal')) continue;
                // 会话门（切走就不起）：目标会话已不是当前会话
                // （切到别的会话或别的模式）→ **丢弃该条**，不在用户没看的会话里自行跑一轮。
                // 结果仍在目标会话的 cm 与存储里，切回去可见（只是不主动回话）。
                var curSid = _currentSessionId();
                if (!curSid || entry.sessionId !== curSid) continue;

                var run = opts.getRunUserRequest && opts.getRunUserRequest();
                if (typeof run !== 'function') return;

                _bgWakeRunning = true;
                // 同步置 busy（守卫检查到此无 await 窗口）：与用户发送路径互斥
                opts.state.busy = true;
                opts.state.busyText = AEI18n.t('处理后台结果...');
                opts.chatViewHelpers.syncView();
                // 空文本入循环：那一轮的「用户消息」就是刚写进 cm 的 system-result
                //（toLlmMessages 把 llmRole='user' 的 system-result 转成 role:'user'），
                // 故无需伪造用户输入；循环首轮迭代还会顺带 drain _injectQueue 里的残留条目，
                // 所以「窗口期残留 + 待机」这种竞态也自愈，不需要额外规则。
                _setOrigin(entry.origin || 'bg');
                Promise.resolve(run('')).catch(function () {
                    // 兜底释放 busy：_runUserRequest 的 try/catch/finally 会自行复位 busy，
                    // 但**分支选择之前**抛出的异常（入口的 getSettings 等）逃过那层 finally——
                    // 而 busy 是本函数在调用前同步置上的，不释放会让发送按钮永久锁死。
                    // 此刻 busy 必然只属于当前轮（置位后用户发送只能入队），复位是安全的。
                    if (opts.state.busy) {
                        opts.state.busy = false;
                        opts.state.busyText = '';
                        try { opts.chatViewHelpers.syncView(); } catch (_) {}
                    }
                }).then(function () {
                    _bgWakeRunning = false;
                    // 收尾再试：当前轮期间新到达的、或队列里其他会话的条目
                    setTimeout(function () { try { tryWakeBgResult(); } catch (_) {} }, 0);
                });
                return;
            }
        }

        // 目标会话已删除时的兜底提示：结果既进不了任何对话、也不会自动
        // 唤起，用户完全无感知（只有控制台一行 warn）——而生成要几分钟，用户在这
        // 期间删掉会话是很现实的窗口。改为把结果与产出文件路径直接告知用户，至少不丢信息。
        function _notifyOrphanSystemResult(title, visible, detail) {
            if (typeof opts.showStatus !== 'function') return;
            var v = visible || {};
            var d = detail || {};
            var parts = [];
            if (v.text) parts.push(String(v.text));
            var files = [];
            if (Array.isArray(v.images)) files = files.concat(v.images);
            if (Array.isArray(v.videos)) files = files.concat(v.videos);
            if (Array.isArray(v.files)) files = files.concat(v.files);
            if (files.length > 0) {
                parts.push(files.slice(0, 3).join('  '));
                if (files.length > 3) parts.push('等 ' + files.length + ' 个文件');
            } else if (d.text) {
                // 细节区是结果 JSON（含 outputs 路径）：原样附一段，避免无 visible 路径时丢产出信息
                parts.push(String(d.text).slice(0, 300));
            }
            if (parts.length === 0) return;
            try {
                opts.showStatus(AEI18n.t('原会话已删除，{title}：{parts}', { title: title || AEI18n.t('后台结果'), parts: parts.join(' · ') }), 'warn', { autoHideMs: 8000 });
            } catch (_) {}
        }

        async function clearConversation() {
            if (opts.state.busy || opts.getStopping()) return;
            // 补 _switching/_dispatching 守卫（对齐 injectSystemMessage 的守卫链）。
            // 切换加载窗口（store.load 异步可达数百 ms，此时 _switching=true、busy=false）
            // 内点击"清空对话"：弹窗期间切换完成，下方重新取 getActiveCm() 已指向新会话，
            // 清空的是刚切入的新会话（数据丢失）；派发窗口内同理与即将启动的处理链并发。
            if (opts.getSwitching && opts.getSwitching()) {
                if (typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('正在切换会话，请稍候再清空对话'), 'info', { autoHideMs: 3000 });
                }
                return;
            }
            if (opts.getDispatching && opts.getDispatching()) {
                if (typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('正在发送上一条消息，请稍候再清空对话'), 'info', { autoHideMs: 3000 });
                }
                return;
            }
            // 入口时刻的会话 id：showConfirm 的 await 窗口内可能发生会话切换，
            // 确认返回后须重校验（见下），否则清空的是刚切入的新会话
            var _sidAtEntry = opts.chatViewHelpers.getActiveCm().getSessionId();
            // 清空对话会删除会话记录及关联图片缓存，不可逆，先经 showConfirm 确认。
            var _confirmOk = (typeof global !== 'undefined' && typeof global.showConfirm === 'function')
                ? await global.showConfirm(AEI18n.t('清空对话'),
                    AEI18n.t('确定要清空当前对话吗？将删除对话记录及关联的图片缓存文件，此操作不可恢复。'))
                : true;
            if (!_confirmOk) return;
            // 确认弹窗的 await 窗口内异步路径可置 busy（入口守卫只覆盖到弹窗前）：
            // ① 弹窗前用户先点「编辑」——其入口此刻守卫全 false 放行，gather 返回后
            // 继续并 _runUserRequest 置 busy（gather 窗口内则 _msgActionBusy=true）；
            // ② 后台 ComfyUI 任务恰在弹窗期间完成——injectSystemMessage 空闲分支
            // 放行并 _runUserRequest 置 busy。此时确认清空会与运行中的工具循环并发：
            // 循环下一轮从已清空的 cm 重建（LLM 失忆继续跑），任务结束的防抖 save
            // 晚于清空 save 落盘，清空被覆盖（消息"复活"）。对齐入口守卫链复查，
            // 窗口内已起任务/编辑操作则中止清空。
            if (opts.state.busy || (opts.getMsgActionBusy && opts.getMsgActionBusy())) {
                if (typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('当前有任务在执行，已取消清空对话'), 'info', { autoHideMs: 3000 });
                }
                return;
            }
            // 确认弹窗的 await 跨越会话切换边界（入口守卫只覆盖到弹窗前）——
            // 期间用户已切走时（getActiveCm() 已指向新会话）直接中止，防止清空新会话
            if (opts.chatViewHelpers.getActiveCm().getSessionId() !== _sidAtEntry) return;
            var cm = opts.chatViewHelpers.getActiveCm();
            var store = opts.chatViewHelpers.getActiveStore();
            var sid = cm.getSessionId();
            // 清空前收集本会话引用的 chat_img_ 缓存文件；清空后仅删这些，
            // 避免清空任一会话误删其他会话历史消息引用的图片（temp/agent 为所有会话共用）。
            // 扫描字段与清理器 _collectChatImgRefs 同口径（user.images / system-result
            // visibleImages / detailImages）：压缩摘要卡的会话图片清单住在 visibleImages，
            // 漏扫它会让「清空对话」后这些图仍留在 temp/agent（清空后应删除）。
            var _sessionImgFiles = new Set();
            for (var _mi = 0; _mi < opts.state.messages.length; _mi++) {
                var _msgAtClear = opts.state.messages[_mi];
                if (!_msgAtClear) continue;
                var _imgFields = [_msgAtClear.images, _msgAtClear.visibleImages, _msgAtClear.detailImages];
                for (var _fi = 0; _fi < _imgFields.length; _fi++) {
                    var _ims = _imgFields[_fi];
                    if (!Array.isArray(_ims)) continue;
                    for (var _ii = 0; _ii < _ims.length; _ii++) {
                        var _p = _ims[_ii];
                        // 兼容绝对（旧数据）与相对（agent\temp\...，新数据）路径；dataURL 无文件可删
                        if (typeof _p === 'string' && _p.indexOf('data:') !== 0 && _p.indexOf('chat_img_') >= 0) {
                            _sessionImgFiles.add(_p.replace(/\\/g, '/').split('/').pop());
                        }
                    }
                }
            }
            opts.state.messages = [];
            opts.getInjectQueue().length = 0;
            cm.clear();
            // 清空即落盘（防关面板后旧消息复活）。save/flush/归档删除都是异步写：
            // 图片引用集收集（下方 delete 段）必须等它们落定后再读会话文件/归档，
            // 否则读到清空前的旧内容、把本会话自己引用的图判成「仍被引用」而不删
            //（真机复验实测：压缩后清空对话，摘要卡 visibleImages 清单里的图残留）。
            var _clearWrites = [];
            try {
                var _clearSaveP = store.save(sid, []);
                if (_clearSaveP && typeof _clearSaveP.then === 'function') _clearWrites.push(_clearSaveP);
            } catch (_) {}
            try {
                var _clearFlushP = store.flush();
                if (_clearFlushP && typeof _clearFlushP.then === 'function') _clearWrites.push(_clearFlushP);
            } catch (_) {}
            // 压缩归档（<sid>.archive.json）是对话记录的一部分，清空对话须
            // 一并清掉——否则 read_early_history 会把「已清空」的旧对话原样读回
            //（清空确认文案明说删除对话记录且不可恢复）。deleteSession 已有同款清理，
            // 此处补清空路径。失败仅告警，并纳入 _clearWrites 让引用集读取等它落定。
            if (typeof store.clearArchive === 'function') {
                try {
                    var _archiveClearP = store.clearArchive(sid).then(function (ok) {
                        if (ok === false) console.warn('[Agent] 清空会话：归档文件清除失败: ' + sid);
                    }, function () {});
                    _clearWrites.push(_archiveClearP);
                } catch (_) {}
            }
            // 同步清空持久化的 token 统计，否则下次切回会恢复已清零的旧记录
            if (typeof store.saveTokenStats === 'function') {
                store.saveTokenStats(sid, []);
            }
            opts.setActivePlan({ steps: [] });
            // 仅 agent 模式才持久化 plan 清理：plan 文件按 sessionId 存储在 agentStore，
            // script 模式下 chatViewHelpers.getActiveStore() 返回 scriptStore，不应写 agent 的 plan
            var _clearSettings = opts.getSettings();
            if (_clearSettings && _clearSettings.runtimeMode === 'agent') opts.planTracking.persistPlan();
            // 防御：清掉可能残留的流式占位气泡（busy 时本函数已 return，正常无残留，这里兜底）
            opts.view.clearStreaming();
            var _laneStatsForClear = _statsStore();
            if (_laneStatsForClear) {
                _laneStatsForClear.clear();
            }
            // 清空后刷新 token 显示（显示 '--'）；后续 syncView 不影响此调用
            if (typeof opts.view.updateTokenStats === 'function') {
                opts.view.updateTokenStats(null);
            }
            if (global.AEAgent && typeof global.AEAgent.refreshList === 'function') {
                try { global.AEAgent.refreshList(); } catch (e) {}
            }
            // 清理 temp/agent/ 下本会话引用的 chat_img_ 缓存文件。
            // 本会话消息已在上方清空，此处先收集所有会话（script/agent/shader）还引用的图片，
            // 仅删除不再被任何会话引用的文件，避免共用图被本会话清空后导致其他会话断链。
            if (_sessionImgFiles.size > 0) {
                try {
                    var imgDir = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                        ? global.AEShared.getDataDir().dir.replace(/\\+$/, '') + '\\temp\\agent' : '';
                    if (imgDir && typeof global.AEFS !== 'undefined' && typeof global.AEFS.listFiles === 'function') {
                        var imgRefs = null;
                        // 等清空态落盘 + 归档删除完成，再收集引用集：否则 load/loadArchive
                        // 读到的是清空前的旧会话文件/旧归档，本会话自己引用的图会被判成
                        // 「仍被引用」而跳过删除（真机复验实测的竞态）。
                        Promise.all(_clearWrites).catch(function () {}).then(function() {
                            return opts.chatViewHelpers.collectAllChatImgRefs([opts.scriptSessionStore, opts.agentSessionStore, opts.shaderSessionStore]);
                        })
                            .then(function(allRefs) {
                                // 引用收集失败返回 null（任一会话/归档读不出）——
                                // 放弃删除而不是按不完整引用集删（会误删仍被引用的用户附件）
                                if (!allRefs) {
                                    console.warn('[Agent] 清空会话：chat_img 引用收集失败（会话/归档读取异常），跳过图片删除');
                                    return;
                                }
                                imgRefs = allRefs;
                                return global.AEFS.listFiles(imgDir);
                            })
                            .then(function(files) {
                                if (!imgRefs || !files || !files.length) return;
                                files.forEach(function(f) {
                                    // 仅删本会话引用过、且当前不再被任何会话引用的文件
                                    if (_sessionImgFiles.has(f) && !imgRefs[f]) global.AEFS.deleteFile(imgDir + '\\' + f);
                                });
                            })
                            .catch(function() {});
                    }
                } catch (_) {}
            }
            opts.chatViewHelpers.syncView();
        }

        // 空闲手动压缩（用量条 / /compress）的在途请求中止槽位。
        // 空闲时 activeAbortController 为 null（round 结束即置 null），手动压缩曾因此
        // 不绑任何 signal——requestStop 只能 abort activeAbortController，压缩请求
        // 不被中止（最长 60s），返回后阶段 3 仍无条件改写 cm/落盘：用户按了停止，
        // 历史照样被改写。手动压缩在 compressContext 内自建 controller 注册于此，
        // requestStop 一并 abort；压缩收束（成功/失败/中止）后清槽。
        var _manualCompressAbortController = null;

        function requestStop(cause) {
            opts.setStopRequested(true);
            // 停止即作废挂起的「目标失败自动续轮」定时器：stopAll（关团队 / 切会话 / 停 lane）
            // 与用户点停止都走本函数，不一定经过 goal 的 pause 分支；定时器若留到触发，隐藏
            // lane 可能自行起一轮并计费。
            try {
                if (typeof opts.cancelGoalRetry === 'function') opts.cancelGoalRetry();
            } catch (_) { /* 取消失败不影响停止 */ }
            // goal 续轮中用户点停止 → 暂停目标。
            // cause 缺省 = 用户点停止；'forced-send' 等程序化打断不暂停目标。
            if (!cause || cause === 'user') {
                try {
                    var _ga = (typeof opts.getGoalApi === 'function') ? opts.getGoalApi() : null;
                    if (_ga && _ga.origin && _ga.origin() === 'goal') {
                        var _g = _ga.get ? _ga.get() : null;
                        if (_g && _g.phase === 'active') {
                            _ga.pause({ ref: _g.revision, pausedBy: 'stop' });
                        }
                    }
                } catch (_e) { /* goal 暂停失败不影响停止 */ }
            }
            // 仅确有在途 loop 时才标记停止清理窗口：空闲时 requestStop 若也置 _stopping，
            // 没有 loop 的 finally 来清它，会话切换等入口会被永久锁住
            if (opts.state.busy) opts.setStopping(true);
            if (opts.getStopPromiseResolve()) {
                opts.getStopPromiseResolve()({ success: false, error: 'stopped', result: '{}' });
                opts.setStopPromiseResolve(null);
            }
            if (opts.getActiveAbortController()) {
                // 只中止本运行轮自己的在途请求（agent 主循环/压缩/审查的
                // sendStream/sendJson 均经 options.signal 绑定了这个 controller）。
                // 不调全局 channel.abort()——那会连带中止桌宠聊天、ComfyUI 悬浮聊天、
                // MCP 短描述生成等共享同一 llmChannel 实例的在途请求（桌宠还会把
                // 假错误「网络好像不太好」存进聊天历史）。
                opts.getActiveAbortController().abort();
            }
            // 空闲手动压缩无运行轮 controller，中止自建的那个（只中止本请求）
            if (_manualCompressAbortController) {
                try { _manualCompressAbortController.abort(); } catch (_) {}
            }
            opts.state.busy = false;
            opts.state.busyText = '';
            opts.state.toolCallInProgress = null;
            opts.chatViewHelpers.syncView();
        }

        function render() {
            // 改走 syncStateFromCm 合并重赋值（修复的姊妹遗漏）——
            // 整体重赋值 cm.list() 会剥离 state 中的 _local 本地消息（/help、/compress
            // 提示，仅 UI 展示不进 cm），重渲染后本地提示凭空消失。
            if (typeof opts.chatViewHelpers.syncStateFromCm === 'function') {
                opts.chatViewHelpers.syncStateFromCm(0);
            } else {
                opts.state.messages = opts.chatViewHelpers.getActiveCm().list();
            }
            opts.chatViewHelpers.syncView();
            // 初始化 token 显示（恢复会话时显示已有统计，新会话显示 '--'）
            if (typeof opts.view.updateTokenStats === 'function') {
                var stats = _statsStore();
                opts.view.updateTokenStats(stats ? stats.getTotal() : null);
            }
        }

        function switchContext() {
            // 同 render——切上下文（模式切换）后 _local 本地提示不应被剥离
            if (typeof opts.chatViewHelpers.syncStateFromCm === 'function') {
                opts.chatViewHelpers.syncStateFromCm(0);
            } else {
                opts.state.messages = opts.chatViewHelpers.getActiveCm().list();
            }
            opts.state.streamingContent = '';
            opts.state.toolCallInProgress = null;
            opts.view.clearStreaming();
            opts.chatViewHelpers.syncView();
            // 切换上下文后刷新 token 显示
            if (typeof opts.view.updateTokenStats === 'function') {
                var stats = _statsStore();
                opts.view.updateTokenStats(stats ? stats.getTotal() : null);
            }
        }

        function clearReflectDrafts() {
            var cleared = false;
            var touched = [];                 // 原地写过的消息对象（token 记忆化需按条失效）
            var cm = opts.chatViewHelpers.getActiveCm();
            for (var i = 0; i < opts.state.messages.length; i++) {
                if (opts.state.messages[i].detail && opts.state.messages[i].detail.reflectDraft) {
                    opts.state.messages[i].detail = null;
                    touched.push(opts.state.messages[i]);
                    cleared = true;
                }
            }
            var msgs = cm.list();
            for (var j = 0; j < msgs.length; j++) {
                if (msgs[j].detail && msgs[j].detail.reflectDraft) {
                    msgs[j].detail = null;
                    touched.push(msgs[j]);
                    cleared = true;
                }
            }
            // token 记忆化（A-2 第一步）按**消息对象**缓存估值，而这里绕开 `updateMessage`
            // 原地改 `detail`——不失效就会保留「含 reflectDraft 的旧估值」（实测
            // 实测：detail 清空后 totalTokens 不变，虚高 ⇒ percentUsed 偏高 ⇒ 提前自动压缩）。
            if (touched.length && typeof cm.invalidateTokens === 'function') {
                for (var t = 0; t < touched.length; t++) cm.invalidateTokens(touched[t]);
            }
            // 清理只改内存不落盘——重启后 reflectDraft 从会话文件复活，
            // 经验审阅弹窗重复弹出。cm.list() 是浅拷贝、消息对象为同一引用，
            // 上方改动已生效到 cm，此处触发防抖保存把清理态落盘（对齐 compressContext）。
            if (cleared && opts.tokenStats && typeof opts.tokenStats.saveActiveSessionDebounced === 'function') {
                opts.tokenStats.saveActiveSessionDebounced();
            }
            return cleared;
        }

        function getContextTokenStats() {
            return opts.chatViewHelpers.getActiveCm().getTokenStats();
        }

        // 压缩失败原因 → 用户可见文案（唯一一份）。本函数与 compressContext 同处一个模块：
        // 错误码由谁产生，文案就由谁维护——三处消费方（发送前的自动压缩 toast、
        // 用量条手动压缩、/compress 斜杠命令）各写一套，其中两处把内部错误码抛给用户、
        // 或只写 console.warn（表现为「点了没反应」），同一情形三种说法。
        // 文案按原因分档，且**不替用户选行动**（旧文案对 nothing_to_compress 也说
        // 「建议手动压缩」，而手动压缩必然同样失败——那条建议在该情形下是错的）。
        function describeCompressFailure(reason) {
            var r = String(reason == null ? '' : reason);
            if (r === 'nothing_to_compress') return AEI18n.t('没有可压缩的内容（当前对话太少，或旧消息已无可折叠部分）。');
            if (r === 'busy') return AEI18n.t('正在处理中，请稍后再试。');
            if (r === 'LLM_CHANNEL_UNAVAILABLE') return AEI18n.t('LLM 通道不可用，无法压缩。');
            if (r === 'empty_summary') return AEI18n.t('模型返回的摘要为空，本次压缩未生效。');
            // 停止折叠——手动压缩被 requestStop 中止有两条路径都产生 error 串：
            // ① 阶段 3 前的停止复查返回 'stopped'；② 在途 sendStream 被 abort 时
            // llmChannel 返回 {error:'ABORTED', message:'Request aborted'}，:500 转成
            // '摘要请求失败: Request aborted'。
            // 两者都不是「压缩失败」而是用户主动停止（历史未改动），不能显示红色
            // 「压缩失败：… aborted」吓用户。口径对齐发送中停止的既有文案
            //（inputDispatch「已停止，本条消息未发送」），并明确历史未被改写。
            // 不再用裸子串正则匹配 abort（大小写不敏感）——上游真实错误（如
            //「API请求失败: 500 upstream aborted connection」）含 abort 字样会被误折叠为
            //「已停止」，用户不再重试。只认自己的停止信号：精确码 'stopped'，以及
            // llmChannel 的已知中止文案白名单（'ABORTED' / 'Request aborted' /
            // 'The operation was aborted'，大小写不敏感、容许尾句点），并剥掉既有的
            // `摘要请求失败: ` 前缀后再锚定比对（:507 的拼装形态）。
            var _stopBody = r;
            if (_stopBody.indexOf('摘要请求失败: ') === 0) _stopBody = _stopBody.slice('摘要请求失败: '.length);
            if (r === 'stopped'
                || /^(aborted|request aborted|the operation was aborted)\.?$/i.test(_stopBody.trim())) {
                return AEI18n.t('已停止压缩（历史未改动）。');
            }
            // 非已知错误码 = 真实报错原文（compressContext 的 catch 返回 `String(e.message||e)`，
            // 如「摘要请求失败: 401 …」）——原样带出处，别把可诊断的信息折成通用句
            // （统一口径时曾把这类原因吞掉，鉴权失效/模型不存在只剩控制台可见）。
            // 截断防超长；已知错误码（上面四个）与 'unknown' 不走这条。
            if (r && r !== 'unknown') {
                var shown = r.length > 160 ? r.slice(0, 160) + '…' : r;
                return AEI18n.t('压缩失败：{reason}', { reason: shown });
            }
            return AEI18n.t('压缩失败，请稍后再试。');
        }

        // 压缩**单飞锁**。
        // 守卫缺口：入口守卫读 `state.busy`（下面 :448），而 busy 要等 `await resolveApiKeyForPlatform`
        // 之后才置位 ⇒ 两个手动入口（/compress 与用量条点击）在同一秒内都能通过守卫，
        // 各自算 retainFromIdx 并先后 compactWithSummary 同一个 cm（双摘要卡、边界错乱、
        // 归档重复——saveArchive 无幂等键）；internal 调用（loop 内）更是**完全跳过**守卫。
        // 现在：锁在本函数**同步**置位（首个 await 之前）、`finally` 清理，且 internal 与手动
        // 走同一把锁。代价：手动压缩进行中 loop 撞上触发闸会拿到 'busy' 并如实提示
        //（「⚠ 自动压缩未完成：正在处理中，请稍后再试。」），下一轮再试 —— 方向 fail-closed。
        var _compressInFlight = false;
        async function compressContext(options) {
            if (_compressInFlight) return { success: false, error: 'busy' };
            _compressInFlight = true;
            try {
                return await _compressContextInner(options);
            } finally {
                _compressInFlight = false;
            }
        }

        async function _compressContextInner(options) {
            var internal = !!(options && options.internal);
            // 手动压缩（/compress、用量条点击）：保留量按已用历史算，见阶段1 的保留边界
            var manual = !!(options && options.manual) && !internal;
            // 编辑（editUserMessage）的 gather/读图/
            // 确认弹窗 await 窗口不设 busy，期间手动压缩（/compress、点击用量条）会并发
            // compactWithSummary/pruneByTokens 改写 cm——编辑路径提前算好的 cmIdx 过期
            // 错位，cm.updateMessage/truncateFrom 改错/错删消息。_msgActionBusy 窗口内
            // 一律拒绝（调用方对 'busy' 已有兜底提示：commands.js /compress 与
            // bootstrap.js 用量条路径均按 result.error 分支处理）。
            // 补 _switching 守卫——/compress 是斜杠命令，在 app/main.js 的
            // doSendAgentMessage 里先于 submitUserInput 处理（不经过 inputDispatch 的
            // 切换窗口拒绝链）。会话切换窗口（store.load 异步可达数百 ms，busy=false）内
            // 提交 /compress 时：retainFromIdx 按旧会话算出，随后 sendStream 摘要的
            // await（秒级）跨越切换边界——切完后 cm 已 importMessages 新会话，压缩的
            // 阶段3会按旧会话的边界 compactWithSummary 新会话（极端时 retainFromIdx ≥
            // 新会话长度 → 整个新会话被替换成一张旧会话摘要卡并落盘）。入口对齐
            // clearConversation/injectSystemMessage 的守卫链直接拒绝。
            if (!internal && (opts.state.busy || (opts.getMsgActionBusy && opts.getMsgActionBusy()) || (opts.getSwitching && opts.getSwitching()))) return { success: false, error: 'busy' };
            var cm = opts.chatViewHelpers.getActiveCm();
            var stats = cm.getTokenStats();
            // 用未取整值（与三处闸门同口径；89.5% 曾被 Math.round 成 90 后又被这条 5% 下限
            // 之外的判定链条当成「够压」）。缺字段的 mock 桩回退 percentUsed。
            var _statsPct = (typeof stats.percentUsedRaw === 'number') ? stats.percentUsedRaw : (stats.percentUsed || 0);
            if (_statsPct < 5) return { success: false, error: 'nothing_to_compress' };

            var channel = opts.llmChannel || (global.AE_LLM && global.AE_LLM.llmChannel);
            if (!channel || !channel.sendStream) return { success: false, error: 'LLM_CHANNEL_UNAVAILABLE' };

            var model = opts.getModel ? opts.getModel() : '';
            var platform = opts.getPlatform ? opts.getPlatform() : '';
            var apiKey = '';
            try {
                apiKey = await opts.resolveApiKeyForPlatform(platform);
            } catch (_) {}

            // === 两阶段压缩 ===
            // 阶段1：计算保留边界（保留最近约 30% token 的消息，按工具组原子单位）
            // 被保留部分原样不动，避免最近轮次的工具调用/结果丢失导致断层。
            // 保留基数：手动压缩取「已用历史 token」与窗口的较小值，自动压缩取窗口。
            var maxTokens = cm.getMaxContextTokens();
            var retainBase = maxTokens;
            if (manual) {
                // stats 取自首个 await 之前；保留边界在 await 之后才算，期间可能有新一轮消息
                // 写入（busy 只挡并发压缩，不挡写入）——重取一次，避免保留基数偏小。
                var _retainStats = cm.getTokenStats();
                var usedHistory = Math.max(0, (Number(_retainStats.totalTokens) || 0) - (Number(_retainStats.overheadTokens) || 0));
                if (usedHistory > 0) retainBase = Math.min(maxTokens, usedHistory);
            }
            var retainBudget = Math.max(Math.floor(retainBase * 0.3), 2000);
            var retainFromIdx = cm.findRetainIndex(retainBudget);
            var totalMessages = cm.list().length;
            // 边界情况：消息太少或无可压缩的旧部分
            if (totalMessages < 5 || retainFromIdx === 0 || retainFromIdx >= totalMessages) {
                return { success: false, error: 'nothing_to_compress' };
            }

            // 阶段2：折叠 [0, retainFromIdx) 范围内的工具组为文本摘要消息
            // 工具调用 → "[工具调用] name(args) → [name] 结果摘要"，非工具组原样保留
            // LLM 摘要基于折叠后的旧消息（降 token、保留工具调用关键信息而非全丢）
            // 摘要请求必须带附件图片引用。只取 m.text 会让 images 字段
            // 完全不进摘要请求 → 压缩后模型再也看不到会话图片。优先走 cm 的专用折叠
            // 入口（与发送面同一内容函数）；旧桩/旧 cm 无该入口时回落文本映射。
            var _summaryBuilder = (typeof cm.buildSummaryMessages === 'function');
            var foldedOldMsgs = _summaryBuilder ? null : cm.foldOldToolGroups(retainFromIdx);

            var summaryPrompt = '你是对话摘要助手。请对以上对话进行详细但简洁的总结，重点关注：\n'
                + '- 已完成的事情（做出的决策、修改的文件、代码变更）\n'
                + '- 当前正在进行的工作\n'
                + '- 接下来需要做什么\n'
                + '- 遇到的任何重要错误或问题\n'
                + '- 用户发送过的图片（设定图、参考图、角色图等）：写明批次、张数、用途与用户对它们的说明；用户说过后面要用来生成的图片不得省略用途\n\n'
                + '摘要需要足够全面以便后续继续对话，但要保持简洁。使用与对话相同的语言回复。';

            var _summaryHistory = _summaryBuilder
                ? cm.buildSummaryMessages(retainFromIdx)
                : foldedOldMsgs.map(function (m) {
                    return { role: m.role, content: m.text || '' };
                });
            var summaryMsgs = _summaryHistory.concat([{ role: 'user', content: summaryPrompt }]);

            // 空闲手动压缩没有运行轮的 activeAbortController——自建 controller 并
            // 登记到 requestStop 可中止的槽位（signal 为 null 时停止按钮对压缩请求无效：
            // 最长 60s 后返回仍执行阶段 3 改写 cm/落盘）。运行轮内（internal 自动压缩）沿用
            // 运行轮 signal，不再多建一个。
            var _runAc = opts.getActiveAbortController && opts.getActiveAbortController();
            var _manualAc = null;
            if (!internal && !_runAc) {
                _manualAc = new AbortController();
                _manualCompressAbortController = _manualAc;
            }

            opts.state.busyText = AEI18n.t('正在压缩上下文...');
            if (!internal) {
                opts.state.busy = true;
            }
            opts.chatViewHelpers.syncView();

            // 在消息流中显示"压缩上下文"工具执行中指示，避免用户误以为无响应
            var _compressProgressEl = (opts.view && typeof opts.view.appendToolProgress === 'function')
                ? opts.view.appendToolProgress('压缩上下文') : null;

            var summary = '';
            try {
                var result = await channel.sendStream({
                    messages: summaryMsgs,
                    tools: [],
                    apiKey: apiKey,
                    model: model,
                    platform: platform,
                    // 上下文压缩属于当前会话的请求，声明式会话头沿用同一会话 id
                    sessionId: opts.chatViewHelpers.getActiveCm().getSessionId(),
                    // 运行轮内绑定运行轮 signal；空闲手动压缩绑定自建
                    // controller 的 signal（requestStop 会一并 abort 它）
                    options: {
                        maxToolLoops: 0,
                        timeoutMs: 60000,
                        signal: _runAc ? _runAc.signal : (_manualAc ? _manualAc.signal : null)
                    },
                    reasoningEffort: (opts.getSettings().reasoningEffort) || 'high'
                }, {
                    onToken: function (token, full) {
                        summary = full;
                        opts.state.busyText = AEI18n.t('压缩中... {detail}', {
                            detail: full.length > 40 ? full.slice(-40) : full
                        });
                    }
                });
                if (result && result.error) {
                    // sendStream 出错不抛异常而是返回 {error}（llmChannel 设计），
                    // 此处转为 throw 走下方 catch：否则 summary 为空会静默失败为 empty_summary，
                    // 掩盖真实 API 错误（如 400 非法 role、401 鉴权失败）
                    throw new Error('摘要请求失败: ' + (result.message || result.error));
                }
                if (result && result.content) summary = result.content;
                // 记录流式 usage（上下文压缩请求）
                opts.tokenStats.recordStreamUsage(result, 'agent-summarize');
            } catch (e) {
                if (_compressProgressEl && opts.view && typeof opts.view.removeToolProgress === 'function') {
                    opts.view.removeToolProgress(_compressProgressEl);
                }
                if (!internal) {
                    opts.setStopping(false);
                    opts.state.busy = false;
                }
                opts.state.busyText = '';
                opts.chatViewHelpers.syncView();
                return { success: false, error: String(e.message || e) };
            } finally {
                // 请求已收束（成功/失败/中止），清掉手动压缩的中止槽位——
                // 此后 requestStop 不该再 abort 这个已完成的 controller
                if (_manualAc && _manualCompressAbortController === _manualAc) {
                    _manualCompressAbortController = null;
                }
            }

            if (_compressProgressEl && opts.view && typeof opts.view.removeToolProgress === 'function') {
                opts.view.removeToolProgress(_compressProgressEl);
            }

            // 防御：LLM 返回空摘要时不压缩，避免删掉旧部分却无摘要替代导致数据丢失
            if (!summary) {
                if (!internal) {
                    opts.setStopping(false);
                    opts.state.busy = false;
                }
                opts.state.busyText = '';
                opts.chatViewHelpers.syncView();
                return { success: false, error: 'empty_summary' };
            }

            // 阶段 3 前复查停止——摘要请求可能在停止动作（requestStop）之后
            // 才返回（中止与响应到达的竞态窗口），此时不得改写 cm / saveArchive / 落盘：
            // 用户按了停止，历史不能被改写（该路径本身无条件执行阶段 3）。
            if ((opts.getStopRequested && opts.getStopRequested())
                || (_manualAc && _manualAc.signal && _manualAc.signal.aborted)) {
                if (!internal) {
                    opts.setStopping(false);
                    opts.state.busy = false;
                }
                opts.state.busyText = '';
                opts.chatViewHelpers.syncView();
                return { success: false, error: 'stopped' };
            }

            // 阶段3前捕获被压缩的旧消息（[0, retainFromIdx)）副本：
            // compactWithSummary 会重写 cm.list()，故须在此刻提前截取。
            // 压缩丢弃的旧消息不直接丢弃：写入归档（累积 + 上限），LLM 可按需经
            // read_early_history 回看早期聊天历史，避免信息永久丢失。
            var _compressedOldMsgs = cm.list().slice(0, retainFromIdx);

            // 阶段3：重组上下文——摘要替代旧部分，保留 [retainFromIdx, end) 原样不动
            // 保留部分的工具调用/结果配对完整，LLM 可继续引用最近轮次的具体调用（无断层）
            cm.compactWithSummary(summary, retainFromIdx);

            if (_compressedOldMsgs.length) {
                var _arcStore = opts.chatViewHelpers.getActiveStore();
                var _arcSid = cm.getSessionId();
                if (_arcStore && typeof _arcStore.saveArchive === 'function') {
                    _arcStore.saveArchive(_arcSid, _compressedOldMsgs).catch(function (e) {
                        console.warn('[Agent] saveArchive failed: ' + (e && e.message || e));
                    });
                }
            }

            // 压缩清空了 retainFromIdx 之前的 tool_search 历史记录，同步清空 searchedTools
            // 然后从保留的最近消息中重建 searchedTools：保留部分若含 tool_search 成功结果，
            // 重建后 stub 工具闸门仍放行；避免压缩后 stub 工具被误拒
            // 必须传「当前模式的 cm」（即上方被压缩的 cm）：无参调用会回退到 agent 会话——
            // Script/Shader 模式下会拿 agent 会话的 tool_search 历史越权放行（跨模式污染），
            // 同时本模式已搜过的 stub 工具被误锁、被迫重新 tool_search
            if (opts.state.searchedTools) opts.state.searchedTools.clear();
            opts.toolHistory.rebuildSearchedToolsFromHistory(cm);

            // 压缩后以 cm 为准重建 state（dropHead）：被压缩的旧消息不再留在面板里。
            // 保留旧消息会让本次会话与重开面板（从会话文件恢复 cm.list()）出现两套视图——
            // 本次能看到、重开就消失。_local 本地提示按锚点回插，不会丢。
            // 摘要卡位于 cm[0]，重建后落在 state 顶部；它是被压缩旧段的唯一 UI 载体，
            // 更早内容走 read_early_history 从归档回看。
            if (typeof opts.chatViewHelpers.syncStateFromCm === 'function') {
                opts.chatViewHelpers.syncStateFromCm(0, { dropHead: true });
            } else {
                opts.state.messages = cm.list();
            }
            if (opts.view && typeof opts.view.resetRenderedCount === 'function') {
                opts.view.resetRenderedCount();
            }
            // 压缩改写了 cm，必须立即把压缩态落盘到会话文件（saveActiveSessionDebounced 防抖入队，
            // beforeunload flush 兜底），否则手动压缩后关面板，重载会从陈旧会话文件恢复未压缩的完整上下文。
            opts.tokenStats.saveActiveSessionDebounced();
            if (!internal) {
                opts.setStopping(false);
                opts.state.busy = false;
            }
            opts.state.busyText = '';
            opts.chatViewHelpers.syncView();
            return { success: true, summaryLength: summary.length };
        }

        function addUserMessage(text) {
            if (!text) return;
            opts.chatViewHelpers.getActiveCm().add('user', text);
            // 改走 syncStateFromCm 合并重赋值——整体替换 state.messages 会
            // 剥离 _local 消息（恰一条 _local 时新消息因长度不变早退
            // 不渲染）；当前无活跃调用方，属潜伏接口，一并消灭隐患
            if (typeof opts.chatViewHelpers.syncStateFromCm === 'function') {
                opts.chatViewHelpers.syncStateFromCm(1);
            } else {
                opts.state.messages = opts.chatViewHelpers.getActiveCm().list();
            }
            opts.chatViewHelpers.syncView();
            // 落盘口径与 pushSystemResult 一致：cm.add 内的 persist() 是 no-op 兼容钩子，
            // 不排这次防抖保存的话，面板在下一轮保存前关闭会丢这条用户消息。
            // 当前唯一生产调用方是人面 `/goal <目标>` 的目标文本回显。
            if (typeof opts.chatViewHelpers.saveActiveSessionDebounced === 'function') {
                opts.chatViewHelpers.saveActiveSessionDebounced();
            }
        }

        // 按 sessionId 找归属 store——先查三条单 Agent store，再查注入的**全量 store 提供者**
        //（团队 lane store 也在这张表里，后台结果在目标 lane runtime 不在时按
        // 发起时快照的 sessionId 写回原会话）。跨模式后台任务（ComfyUI 轮询等）完成时用户可能
        // 已切走模式，getActiveStore() 按当前 runtimeMode 分发会把结果写错目录（如 agent 模式的
        // 会话 ID 落进 script store，会话清空时因查无此 id 成为孤儿文件）。
        // 全部命中必须先收集再裁决：同一 id 在多个 store 里都出现时**不得取第一个**——
        // 那等于按存储数组顺序猜归属，可能把结果写进别的模式/别的 lane 的同名会话。歧义 ⇒ 返回 null
        //（调用方按「会话归属不明」拒绝写 + 可见警告），与「找不到」同一条失败路径。
        // 不得回退 getActiveStore，那会复现孤儿文件 BUG；也不得猜「最近会话」。
        function _findStoreMatches(sessionId) {
            var out = [];
            var stores = [opts.scriptSessionStore, opts.agentSessionStore, opts.shaderSessionStore];
            var extra = null;
            try {
                extra = (typeof opts.getSessionStores === 'function') ? opts.getSessionStores() : null;
            } catch (_) { extra = null; }
            if (Array.isArray(extra) && extra.length) {
                for (var e = 0; e < extra.length; e++) {
                    if (extra[e] && stores.indexOf(extra[e]) < 0) stores.push(extra[e]);
                }
            }
            for (var i = 0; i < stores.length; i++) {
                var st = stores[i];
                if (!st || typeof st.listSessions !== 'function') continue;
                var sessions = [];
                try { sessions = st.listSessions() || []; } catch (_) { continue; }
                for (var j = 0; j < sessions.length; j++) {
                    if (sessions[j] && sessions[j].id === sessionId) {
                        if (out.indexOf(st) < 0) out.push(st);
                        break;
                    }
                }
            }
            return out;
        }
        function _findStoreBySessionId(sessionId) {
            var matches = _findStoreMatches(sessionId);
            if (matches.length > 1) {
                console.warn('[Agent] sessionId 归属歧义：' + sessionId + ' 同时出现在 ' + matches.length
                    + ' 个会话 store 里，拒绝写入（不按存储顺序猜归属）');
                return null;
            }
            return matches.length === 1 ? matches[0] : null;
        }

        // 把跨会话的队列条目写回原会话 store 的辅助函数。
        // 入队条目（injectSystemMessage/injectSystemResult 的守卫分支）携带 sessionId，
        // drain/立即发送消费点发现条目归属非当前会话时调用本函数：复用失配分支的
        // _findStoreBySessionId + store.appendTo 语义（全部 store 都找不到 / 归属歧义则告警跳过，
        // 不回退 getActiveStore——那会复现孤儿文件 BUG），集中一处避免多个消费点
        // 各写一份导致逻辑漂移。entry 为队列条目：systemResult 条目构造与失配分支
        // （injectSystemResult）同款卡片形状，text 条目构造与 injectSystemMessage 失配分支同款
        // 消息形状；不写当前 cm、不触发当前会话 LLM。
        // 返回 Result：成功 `{ok:true}`；找不到/歧义 `{ok:false,reason:'session_not_found'}`
        // ——调用方（bootstrap facade）据此把失败如实透出（含可见警告），**不得恒返 ok:true**。
        // Promise 恒 resolve（消费点在同步 drain 循环里 fire-and-forget）；异常收敛进 Result。
        async function appendToSession(sessionId, entry) {
            try {
                if (!sessionId || !entry || (!entry.systemResult && !entry.text)) {
                    return { ok: false, reason: 'bad_request' };
                }
                var store = _findStoreBySessionId(sessionId);
                if (!store || typeof store.appendTo !== 'function') {
                    console.warn('[Agent] appendToSession: 会话 ' + sessionId + ' 不在任何会话 store 中（或归属歧义），'
                        + '跳过写入（会话可能已删除）');
                    return { ok: false, reason: 'session_not_found' };
                }
                if (entry.systemResult) {
                    var _v = entry.visible || {};
                    var _d = entry.detail || {};
                    await store.appendTo(sessionId, {
                        role: 'system-result',
                        text: '',
                        title: entry.title || '',
                        llmRole: entry.llmRole || 'user',
                        visibleText: _v.text || '',
                        visibleImages: Array.isArray(_v.images) ? _v.images : null,
                        visibleVideos: Array.isArray(_v.videos) ? _v.videos : null,
                        visibleFiles: Array.isArray(_v.files) ? _v.files : null,
                        detailText: _d.text || '',
                        detailImages: Array.isArray(_d.images) ? _d.images : null,
                        detailVideos: Array.isArray(_d.videos) ? _d.videos : null,
                        detailFiles: Array.isArray(_d.files) ? _d.files : null,
                        createdAt: Date.now()
                    });
                } else {
                    await store.appendTo(sessionId, { role: 'user', text: entry.text, detail: entry.detail || null, images: Array.isArray(entry.images) ? entry.images : null, createdAt: Date.now() });
                }
                return { ok: true };
            } catch (e) {
                console.error('[Agent] appendToSession: 写入原会话失败', e);
                return { ok: false, reason: 'write_failed', error: String((e && e.message) || e) };
            }
        }

        // 系统消息注入：外部异步任务（如 ComfyUI 后台生成）完成后，自动把结果推入对话并触发 LLM 处理。
        // agent 执行中则入队，在当前轮结束后自动 drain。
        // sessionId: 调用方传入的会话 ID，用于会话切换后把结果写入原会话而非当前会话。
        // detail: 完整结果信息（JSON 等），UI 不显示但 LLM 可见（via toLlmMessages）。
        async function injectSystemMessage(text, images, sessionId, detail, originOverride) {
            if (!text) return;
            // 会话一致性检查：若 sessionId 不匹配当前会话，写入原会话的 store（用户切回时可见），不触发 LLM
            if (sessionId) {
                var currentSessionId = opts.chatViewHelpers.getActiveCm().getSessionId();
                if (currentSessionId !== sessionId) {
                    try {
                        var store = _findStoreBySessionId(sessionId);
                        if (!store || typeof store.appendTo !== 'function') {
                            console.warn('[Agent] injectSystemMessage: 会话 ' + sessionId + ' 不在任何会话 store 中，跳过写入（会话可能已删除）');
                            return;
                        }
                        // 改走 store.appendTo 原子追加。旧 load→push→saveNow 的
                        // 读-改-写不互斥（saveNow 链只串行化写，load 在链外）：两个并发
                        // 后台任务完成时间接近时，后写者整包覆盖先写者，先落盘的结果
                        // JSON 从会话文件永久丢失。appendTo 在 per-file 串行链内完成
                        // 读+追加+落盘，并发追加逐条落盘不互相覆盖。
                        await store.appendTo(sessionId, { role: 'user', text: text, detail: detail || null, images: Array.isArray(images) ? images : null, createdAt: Date.now() });
                    } catch (e) {
                        console.error('[Agent] injectSystemMessage: 写入原会话失败', e);
                    }
                    return;
                }
            }
            // _switching/_dispatching：会话切换窗口与 submitUserInput 派发窗口（gather/自动压缩
            // 的 await 期间，busy 尚未置位）内不得直接发起处理链——addMessage 会写进半初始化新会话
            // 被 importMessages 覆盖，或与即将启动的 _runUserRequest 并发交错写状态。对齐
            // sendInjectItem 的同款守卫：结果入队，由当前轮循环出口 drain 或后续处理消费。
            // _msgActionBusy：消息编辑的 await 窗口内直接注入会与编辑
            // 路径的 truncateFrom 并发起两个工具循环——同走入队等 drain 消费。
            // 补 state.restoring（对齐 submitUserInput）——启动
            // 恢复链进行中（busy/_switching 均为 false 的窗口）后台任务完成回调直发会被
            // 恢复链 importMessages 覆盖，生成结果永久丢失；入队等恢复完成后 drain
            if (opts.state.restoring || opts.state.busy || opts.getStopping() || (opts.getSwitching && opts.getSwitching()) || (opts.getDispatching && opts.getDispatching()) || (opts.getMsgActionBusy && opts.getMsgActionBusy())) {
                // 入队条目必须携带 sessionId——守卫命中（如 _switching 窗口）
                // 时条目可能滞留到切换完成后才被 drain，无归属则会被写进当前（可能
                // 已是另一个）会话，原会话永久丢失该结果。
                opts.getInjectQueue().push({ text: text, images: images || null, detail: detail || null, sessionId: sessionId || null });
                return;
            }
            opts.setStopRequested(false);
            opts.setStopPromiseResolve(null);
            opts.setActiveAbortController(new AbortController());
            opts.messageHelpers.addMessage('user', text, detail, images);
            _setOrigin(originOverride || 'system');
            await opts.getRunUserRequest()(text);
        }

        // 通用系统信息卡片：标题 + 常显区(visible) + 细节区(detail，默认收起)。
        // visible/detail 形如 { text, images, videos, files }；llmRole 决定上下文角色 user/assistant。
        // 仅入历史并渲染，不主动触发 LLM（LLM 在下一轮自然读到该上下文）。
        // sessionId: 调用方传入的会话 ID（ComfyUI 后台轮询等长异步任务，最长 300s）。任务
        // 期间用户可能已切换会话，不匹配时把结果写回原会话文件（镜像 injectSystemMessage
        // 的会话一致性检查与落盘行为），不注入当前会话污染其 LLM 上下文；不传视为当前会话。
        // silent: true = **只记录、不唤醒**：卡片照常落进
        // 对话与 LLM 上下文（下一轮自然读到），但不排 bg-wake。用于「用户与子 Agent 的私下追问」——
        // 上级 Agent 需要知道有这回事，但不该被它唤醒去接着干。缺省 false（既有调用方逐字不变）。
        async function injectSystemResult(title, visible, detail, llmRole, sessionId, originOverride, silent) {
            if (sessionId) {
                var currentSessionId = opts.chatViewHelpers.getActiveCm().getSessionId();
                if (currentSessionId !== sessionId) {
                    try {
                        // 按 sessionId 找归属 store（跨模式后台任务完成时用户已
                        // 切走模式的场景）——getActiveStore() 按当前 runtimeMode 分发会写
                        // 错目录；找不到归属（会话已删除）告警跳过，不回退 getActiveStore。
                        var store = _findStoreBySessionId(sessionId);
                        if (!store || typeof store.appendTo !== 'function') {
                            console.warn('[Agent] injectSystemResult: 会话 ' + sessionId + ' 不在任何会话 store 中，跳过写入（会话可能已删除）');
                            _notifyOrphanSystemResult(title, visible, detail);
                            return;
                        }
                        var _v = visible || {};
                        var _d = detail || {};
                        // 改走 store.appendTo 原子追加（与 injectSystemMessage 失配分支
                        // 同因）：旧 load→push→saveNow 的读-改-写不互斥，并发后台任务完成
                        // 时间接近时后写者整包覆盖先写者，先落盘的结果 JSON 永久丢失。
                        await store.appendTo(sessionId, {
                            role: 'system-result',
                            text: '',
                            title: title || '',
                            llmRole: llmRole || 'user',
                            visibleText: _v.text || '',
                            visibleImages: Array.isArray(_v.images) ? _v.images : null,
                            visibleVideos: Array.isArray(_v.videos) ? _v.videos : null,
                            visibleFiles: Array.isArray(_v.files) ? _v.files : null,
                            detailText: _d.text || '',
                            detailImages: Array.isArray(_d.images) ? _d.images : null,
                            detailVideos: Array.isArray(_d.videos) ? _d.videos : null,
                            detailFiles: Array.isArray(_d.files) ? _d.files : null,
                            createdAt: Date.now()
                        });
                    } catch (e) {
                        console.error('[Agent] injectSystemResult: 写入原会话失败', e);
                    }
                    return;
                }
            }
            // _switching/_dispatching：同 injectSystemMessage——切换/派发窗口内不直接落卡片，
            // 入队等待 drain（对齐 sendInjectItem 守卫），防并发 _runUserRequest 或写进半初始化新会话。
            // _msgActionBusy：消息编辑的 await 窗口内直接落卡片会与编辑
            // 路径的 truncateFrom 并发交错写状态——同走入队等 drain 消费。
            // 补 state.restoring（与 injectSystemMessage 同步）
            if (opts.state.restoring || opts.state.busy || opts.getStopping() || (opts.getSwitching && opts.getSwitching()) || (opts.getDispatching && opts.getDispatching()) || (opts.getMsgActionBusy && opts.getMsgActionBusy())) {
                // 入队条目必须携带 sessionId（同 injectSystemMessage 入队分支）——
                // 滞留条目 drain 时据此路由回原会话，防止写进切换后的当前会话。
                // silent 随条目一起记住：drain 的各消费点目前只 pushSystemResult（不排唤醒），所以它
                // 现在是「语义标记」；若将来把 drain 改成走 injectSystemResult，**必须把这个字段传下去**，
                // 否则用户追问的记录会静默恢复唤醒。
                opts.getInjectQueue().push({ systemResult: true, title: title || '', visible: visible || {}, detail: detail || {}, llmRole: llmRole || 'user', sessionId: sessionId || null, silent: silent === true });
                return;
            }
            opts.chatViewHelpers.pushSystemResult(title, visible, detail, llmRole);
            opts.chatViewHelpers.syncView();
            // 待机分支：落卡之后排一次「唤起」，让 LLM 主动回应结果。没有这一步，结果就
            // 只是躺在上下文里——用户提交生图任务后待机时永远不会被读到（本功能的动因）。
            // 走到这里必然满足「会话为当前会话」（跨会话分支已在上面 return），故传
            // sessionId 或当前会话 id 等价；为空时取当前会话 id 兜底。
            // llmRole='assistant' 的结果不排唤起：那种条目在 LLM 报文里是 assistant 消息，
            // 当轮没有可回应的 user 消息，起轮只会退化（当前唯一生产者 _backgroundPoll
            // 传的都是 'user'，此处仅作防御）。
            // silent=true 同样不排唤起（「只记录、不唤醒」）：卡片已在上面落进对话与上下文，
            // 上级 Agent 下一轮自然读到，但不该被用户与子 Agent 的私下追问叫醒。
            if (!silent && llmRole !== 'assistant') {
                enqueueBgWake(sessionId, originOverride || null);
                tryWakeBgResult();
            }
        }

        // 「隐藏 user 消息」注入：只进 cm / LLM 上下文、UI 不渲染（`_hidden` 标记，view 跳过渲染），
        // 随后排一次唤起（复用 bg-wake 链）。唯一生产者是 goal 第 1 轮
        // 「首次发目标不要系统卡，续轮才需要」——人刚设完目标，对话里不需要再插一张
        // 「目标续轮 第 1/N 轮」卡；续轮才用可见卡解释 Agent 为何自行开工。
        // 同步实现：落消息与排唤起之间没有 await，调用点（goalDriver 已通过 isIdle 判据）
        // 不会滑进轮内/切换窗口。任何守卫命中或会话已切走时返回 false —— 调用方回退到
        // 可见卡（不会静默吞掉一轮）。
        function injectHiddenUserMessage(text, sessionId, originOverride) {
            if (!text) return false;
            if (sessionId) {
                var _curSid = '';
                try { _curSid = opts.chatViewHelpers.getActiveCm().getSessionId() || ''; } catch (_e) { _curSid = ''; }
                if (_curSid !== sessionId) return false;
            }
            // 守卫链与 injectSystemResult 同源（restoring/busy/stopping/switching/dispatching/编辑互斥）。
            if (opts.state.restoring || opts.state.busy || opts.getStopping()
                || (opts.getSwitching && opts.getSwitching())
                || (opts.getDispatching && opts.getDispatching())
                || (opts.getMsgActionBusy && opts.getMsgActionBusy())) {
                return false;
            }
            try {
                opts.chatViewHelpers.getActiveCm().add('user', text, null, { _hidden: true });
                // 隐藏消息必须同时镜像进 state.messages（合并重赋值，与 persistVisionDesc 同因）：
                // 否则 state 与 cm 的下标持续错位，编辑/截断会换算到错误下标、误删消息。
                // 渲染层对 _hidden 跳过渲染，UI 无感知；传 1 = 本次在 cm 尾部新增了 1 条。
                opts.chatViewHelpers.syncStateFromCm(1);
                // 落盘口径与 pushSystemResult 一致：cm.add 内的 persist() 是 no-op 兼容钩子，
                // 不排这次防抖保存的话，面板在下一轮保存前关闭会让隐藏指令丢失（roundsStarted
                // 已由 goal 状态机单独落盘 ⇒ 恢复后轮号与上下文不一致）。
                if (typeof opts.chatViewHelpers.saveActiveSessionDebounced === 'function') {
                    opts.chatViewHelpers.saveActiveSessionDebounced();
                }
            } catch (e) {
                console.warn('[Agent] 隐藏 user 消息注入失败: ' + ((e && e.message) || e));
                return false;
            }
            // 唤起一轮：与 injectSystemResult 待机分支同一条 bg-wake 链；origin='goal'
            // 决定工具体验/停止语义（与可见卡路径一致）。
            enqueueBgWake(sessionId, originOverride || 'goal');
            tryWakeBgResult();
            return true;
        }

        // 本地消息：只显示到聊天框（进 state.messages 供渲染），不进 contextManager（不发给 LLM）。
        // 用于 /help 这类纯提示——避免帮助文本污染对话历史/LLM 上下文。
        // 用 view.appendLocalMessage 增量插入，不走 syncView 全量重渲染，不打扰在途流式气泡。
        // _local 标记：state.messages 与 contextManager 的 1:1 镜像下标换算时跳过此类条目。
        function addLocalMessage(role, text) {
            if (!text) return;
            opts.state.messages.push({ role: role || 'assistant', text: text, detail: null, images: null, createdAt: Date.now(), _local: true });
            if (opts.view && typeof opts.view.appendLocalMessage === 'function') {
                opts.view.appendLocalMessage(role || 'assistant', text);
            }
        }

        // ── 执行中追加消息队列（底部弹出框用）──
        // "立刻发送"暂存期间（_deferQueue 非空）有效队列为 _deferQueue，UI 据此显示其余待发条目，
        // 看起来队列不清空、只少了被点击发送的那一条；否则有效队列为 _injectQueue。
        function _activeQueue() {
            return opts.getDeferQueue().length ? opts.getDeferQueue() : opts.getInjectQueue();
        }
        function getInjectQueue() { return _activeQueue().slice(); }
        function removeInjectItem(index) {
            var q = _activeQueue();
            if (index >= 0 && index < q.length) {
                q.splice(index, 1);
            }
        }
        function clearInjectQueue() {
            opts.getInjectQueue().length = 0;
            opts.getDeferQueue().length = 0;
        }
        // 编辑：从队列移除该条并返回，供 UI 回填输入框
        function editInjectItem(index) {
            var q = _activeQueue();
            if (index >= 0 && index < q.length) {
                return q.splice(index, 1)[0] || null;
            }
            return null;
        }
        // 立刻发送：只发送指定下标的这一条，其余待发送条目暂存到 _deferQueue 保留在队列。
        // busy 中：当前条 addMessage 持久化到历史，_forcedInjectText 标记该文本，打断当前轮后
        // 循环出口据此立即起新一轮单独处理这一条；整条任务链结束后 finally 再把
        // _deferQueue 恢复回 _injectQueue，其余条目继续排队等待后续自然 drain，不随当前轮误发。
        // UI 读取 getInjectQueue 返回 _activeQueue().slice()，暂存期间仍显示其余条目，不清空队列。
        // 空闲态：无在途 loop 可打断——requestStop 是空操作、_forcedInjectText 无循环出口消费，
        // 旧路径会把消息挂到用户下次手动发送才处理（显示已发送但 Agent 永不响应），
        // 改为直接发起与正常发送一致的处理链（同 injectSystemMessage 空闲路径）。
        async function sendInjectItem(index) {
            var q = _activeQueue();
            console.log('[Agent] sendInjectItem: idx=' + index + ' queue=' + q.length
                + ' busy=' + !!opts.state.busy
                + ' stopping=' + !!(opts.getStopping && opts.getStopping())
                + ' dispatching=' + !!(opts.getDispatching && opts.getDispatching()));
            if (!q.length || typeof index !== 'number' || index < 0 || index >= q.length) return;
            // 会话切换窗口（store.load 异步可达数百 ms）与 submitUserInput 派发窗口
            // （gather/自动压缩的 await 期间，busy 尚未置位）内不发起处理链：
            // 前者 addMessage 会写进半初始化新会话、随后被 importMessages 覆盖丢失；
            // 后者与即将启动的 _runUserRequest 并发交错写 state.messages/contextManager
            // ——正是 _dispatching 锁要堵的竞态。条目留在队列：dispatch 的循环出口
            // finally 会 drain；切换结束后可再点发送。对齐 submitUserInput 入口守卫。
            if (opts.getSwitching && opts.getSwitching()) {
                if (typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('正在切换会话，请稍候再发送'), 'info', { autoHideMs: 3000 });
                }
                return;
            }
            // 仅在派发前置窗口（gather / 自动压缩的 await 期间，busy 尚未置位）内拦截。
            // _dispatching 由 submitUserInput 持有到整条工具链结束（await _runUserRequest →
            // processToolLoop），busy 已置位时属正常执行中——若此处一并拦截，「立刻发送」在
            // 整条任务期间（含流式输出中）恒被拦下，表现为"点击无任何反应"。
            if (opts.getDispatching && opts.getDispatching() && !opts.state.busy) {
                if (typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('正在发送上一条消息，请稍候再发送'), 'info', { autoHideMs: 3000 });
                }
                return;
            }
            // 消息编辑的 await 窗口内"立刻发送"会并发起第二个工具循环，
            // 且该条目刚持久化即被编辑路径的 truncateFrom 删除——条目留在队列，操作结束后再发
            if (opts.getMsgActionBusy && opts.getMsgActionBusy()) {
                if (typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('当前有消息操作进行中，请稍候再发送'), 'info', { autoHideMs: 3000 });
                }
                return;
            }
            var item = q.splice(index, 1)[0];
            if (!item) return;
            // 跨会话条目「立即发送」——入队时携带的 sessionId 非空且不等于
            // 当前会话时，写回原会话 store（appendToSession），不写当前 cm、不触发
            // 当前会话 LLM；条目已从队列移除。systemResult 条目同款处理（否则
            // 点击 systemResult 条目会在 splice 后被直接丢弃）。
            if (item.sessionId && item.sessionId !== opts.chatViewHelpers.getActiveCm().getSessionId()) {
                await appendToSession(item.sessionId, item);
                // 条目已 splice 离队，必须刷新视图——否则已发送的跨会话
                // chip 残留显示，且残留按钮持有的旧下标会误操作队列中的其他条目
                opts.chatViewHelpers.syncView();
                return;
            }
            if (item.systemResult) return;
            // 仅当有效队列是 _injectQueue 时，才把其余条目移到 _deferQueue 隐藏，
            // 避免循环出口整队 drain 误发；若已在 _deferQueue（连续立刻发送）则其余本就暂存。
            // 暂存条目补记 sessionId——暂存条目可能跨越会话切换存活（任务链
            // finally 把 _deferQueue 恢复回 _injectQueue 后用户才切走），drain 消费点
            // （processToolLoop 循环内 / 两分支 finally / sendInjectItem）据 sessionId 走
            // 跨会话路由（appendToSession 写回原会话，对齐的 injectSystemMessage
            // 入队模式）；无归属则会被 addMessage 写进切换后的新会话并投喂新会话 LLM，
            // 原会话永久丢失该消息。已带 sessionId 的条目（injectSystemMessage 入队）不覆盖。
            if (q === opts.getInjectQueue() && q.length > 0) {
                var _deferSid = opts.chatViewHelpers.getActiveCm().getSessionId();
                for (var _di = 0; _di < q.length; _di++) {
                    if (q[_di] && !q[_di].sessionId) q[_di].sessionId = _deferSid;
                }
                opts.getDeferQueue().push.apply(opts.getDeferQueue(), q);
                q.length = 0;
            }
            // 空闲态：直接发起处理链。_runUserRequest 入口同步置 state.busy，无 await 窗口，
            // 天然防并发；其余条目已暂存 _deferQueue，当前轮 finally 恢复后继续排队。
            if (!opts.state.busy && !opts.getStopping()) {
                opts.setStopRequested(false);
                opts.setStopPromiseResolve(null);
                opts.setActiveAbortController(new AbortController());
                opts.messageHelpers.addMessage('user', item.text, item.detail, item.images, {
                    displayText: item.displayText,
                    videos: item.videos,
                    fileRefs: item.fileRefs,
                    fileCtx: item.fileCtx
                });
                // 视觉通道随条目透传——与正常发送一致，经 _pendingImages →
                // processToolLoop 主消费点注入到刚持久化的该条 user 消息（否则
                // imageDataUrls 在入队时被丢弃，图片只落盘不进 LLM）。
                if (typeof opts.setPendingImages === 'function') {
                    opts.setPendingImages(item.imageDataUrls && item.imageDataUrls.length ? item.imageDataUrls : null);
                }
                opts.chatViewHelpers.syncView();
                await opts.getRunUserRequest()(item.text);
                return;
            }
            // 持久化当前条到历史（与循环内 drain 一致，保留 displayText 供 UI 还原 chip 标签；
            // 附件字段随队列条目透传，与发送路径一致地持久化到历史）
            opts.messageHelpers.addMessage('user', item.text, item.detail, item.images, {
                displayText: item.displayText,
                videos: item.videos,
                fileRefs: item.fileRefs,
                fileCtx: item.fileCtx
            });
            // 视觉通道回填——循环出口据 _forcedInjectText 递归起新一轮
            // processToolLoop，其主消费点消费 _pendingImages 把该条的图片带给 LLM。
            // 连续「立刻发送」：忙态第一条点击已把图写进 _pendingImages，
            // 但它要等循环出口的续跑轮才被消费；此窗口内再点第二条若沿用单槽覆盖，前一张图
            // 永不注入（UI 气泡仍在，用户以为已发送）。对齐「合并而非覆盖」：
            // 累积到现有 pending 之后由续跑轮入口统一注入；本条无图时不得写 null（否则清掉前条）。
            var _rg3Imgs = item.imageDataUrls && item.imageDataUrls.length ? item.imageDataUrls : null;
            if (_rg3Imgs && typeof opts.setPendingImages === 'function') {
                var _rg3Pending = (typeof opts.getPendingImages === 'function') ? opts.getPendingImages() : null;
                opts.setPendingImages((_rg3Pending || []).concat(_rg3Imgs));
            }
            // 标记强制注入，循环出口据此起新一轮只处理这一条。
            // 已有未消费的 forced 文本时不得覆盖——本条已 addMessage 持久化，放回
            // 待发送队列会重复落库/重复投喂，故改换行合并；续跑轮以合并文本作当前轮 userText，
            // 两条消息的文本都不会从任务链里消失。
            var _rg3PrevForced = (typeof opts.getForcedInjectText === 'function') ? opts.getForcedInjectText() : null;
            opts.setForcedInjectText(_rg3PrevForced ? (_rg3PrevForced + '\n' + item.text) : item.text);
            // 程序化打断（立刻发送）≠ 用户停目标：不触发 goal 暂停
            requestStop('forced-send');
            opts.chatViewHelpers.syncView();
        }

        return {
            setModeByDebug: setModeByDebug,
            clearConversation: clearConversation,
            requestStop: requestStop,
            render: render,
            switchContext: switchContext,
            clearReflectDrafts: clearReflectDrafts,
            getContextTokenStats: getContextTokenStats,
            compressContext: compressContext,
            describeCompressFailure: describeCompressFailure,
            addUserMessage: addUserMessage,
            injectSystemMessage: injectSystemMessage,
            injectSystemResult: injectSystemResult,
            // 隐藏 user 消息注入（goal 第 1 轮：进上下文、UI 不渲染、随后唤起一轮）
            injectHiddenUserMessage: injectHiddenUserMessage,
            // 跨会话队列条目写回原会话的辅助函数，供 controller.js 的
            // drain 消费点（processToolLoop 循环 / finally drain /
            // _drainScriptQueueAndRecurse）归属检查失败时路由使用。
            appendToSession: appendToSession,
            addLocalMessage: addLocalMessage,
            getInjectQueue: getInjectQueue,
            removeInjectItem: removeInjectItem,
            clearInjectQueue: clearInjectQueue,
            editInjectItem: editInjectItem,
            sendInjectItem: sendInjectItem,
            // 后台结果唤起：controller.js 在 _runUserRequest 收尾处调用，
            // 覆盖「唤起排在守卫为真的窗口内 → 当前轮收尾再试」；对外暴露亦便于回归测试
            // 直接驱动「延后唤起」路径（如模块未挂载期间入队、挂载后补唤起）。
            tryWakeBgResult: tryWakeBgResult
        };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createApiActions = createApiActions;
})(typeof global !== 'undefined' ? global : window);