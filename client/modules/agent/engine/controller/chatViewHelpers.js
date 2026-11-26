(function (global) {
    'use strict';
    function createChatViewHelpers(opts) {
        // opts 注入：{ getSettings, scriptContextManager, agentContextManager, shaderContextManager,
        //            scriptSessionStore, agentSessionStore, shaderSessionStore, state, view,
        //            onStateChange, getStopping, getLastSwitcherLocked, setLastSwitcherLocked,
        //            saveActiveSessionDebounced }

        // ── 活动 cm / store 的分发 ──────────────────────────────────────────
        // **必须经 effectiveMode**：runtimeMode 现在承载面板档位（含 'team'），而这里是 4 档表
        // 的消费者。'team' 直接喂进来会落到末尾兜底 = script 域——那正是「团队 + 底层 shader」
        // 时把读写落到 Script 会话上的静默串台（本仓 previewFps 式漂移的同类）。
        // 团队档没有独立会话域：团队会话归三条 lane 的 store + binder，被 park 的单 Agent
        // 域就是 baseMode 那一份——退出团队立刻要用它，故它也是 team 档下唯一正确的落点。
        function _activeMode(settings) {
            var st = settings;
            try {
                var fn = global.AEEngine && global.AEEngine.settings && global.AEEngine.settings.effectiveMode;
                if (typeof fn === 'function') return fn(st);
            } catch (_) { /* 引擎缺席（测试桩）：走下面的本地兜底 */ }
            var r = (st && st.runtimeMode) || 'script';
            if (r === 'team') return ((st.team && st.team.baseMode) || 'script');
            return r;
        }

        function getActiveCm() {
            const m = _activeMode(opts.getSettings());
            if (m === 'agent') return opts.agentContextManager;
            if (m === 'shader') return opts.shaderContextManager;
            return opts.scriptContextManager;
        }

        // 运行时「活动 store」按模式分发，与 bootstrap 启动恢复链那份同口径：external 落到
        // script store 是**有意的兜底**（外接无会话域，其 UI 无聊天/会话）。设计意图详见
        // controller.switchMode 的「外接模式快路径」注释——勿在此处按「补齐 external」的口径改。
        // team 档**不是**兜底：它经 _activeMode 显式取 baseMode 的域（见上方注释）。
        function getActiveStore() {
            var settings = opts.getSettings();
            var m = _activeMode(settings);
            if (m === 'agent') return opts.agentSessionStore;
            if (m === 'shader') return opts.shaderSessionStore;
            return opts.scriptSessionStore;
        }

        // state.messages ← cm.list() 的「合并重赋值 / 全量重建」——直接整体重赋值会剥离
        // state 中的 _local 本地消息（/help、/compress 提示，仅 UI 展示不进 cm）。恰有一条
        // _local 时，pushSystemResult 新增卡片后 state 长度不变，view.renderMessages 因
        // _renderedCount >= messages.length 早退，新 system-result 卡片永不渲染；且 _local
        // 之后的消息下标整体前移，已渲染的编辑/重生成按钮索引错位。
        //
        // 两种语义由 options.dropHead 选择：
        //   · 合并（默认）：遍历旧 state.messages，_local 条目原位保留（cm 中无对应，
        //     保持 cmIndexForStateIndex 的「cm 比 state 少」offset 不变量）；非 _local
        //     槽位按序换成 cm.list() 条目，头部已被 pruneByTokens 裁剪掉的旧消息保留
        //     原条目（UI 完整历史）；cm 尾部新增条目追加到末尾，state 长度随之 +1 供
        //     增量渲染。尾部新增类调用点（新 system-result 卡、隐藏消息、用户消息）与
        //     pruneByTokens 硬裁剪都走这一支。
        //   · 重建（dropHead: true）：以 cm.list() 为准全量重建 state，旧 head 不再进
        //     state；_local 按「尾部对齐」换算后回插（见分支内注释）。用于上下文压缩——
        //     摘要卡已承载被压缩段的记忆，state 与 cm、与会话文件因此是同一份消息集合，
        //     本次会话与重开面板后的视图一致。
        // addedCount：调用方本次在 cm 尾部新增的条数（须先 add 再同步）——头部裁剪偏移
        // 与尾部新增会使「非 _local 数 - cm 数」差值产生歧义，凭 addedCount 扣除新增段
        // 才能准确算出头部裁剪数（合并语义的调用点均为先追加 1 条再同步，故传 1）。
        // 重建语义不使用 addedCount（cm.list() 即全量真值）。
        function syncStateFromCm(addedCount, options) {
            var added = (typeof addedCount === 'number' && addedCount > 0) ? addedCount : 0;
            var dropHead = !!(options && options.dropHead);
            var cmList = getActiveCm().list();
            var oldMsgs = opts.state.messages;
            if (dropHead) {
                // _local 只存在于 state，重建后按「尾部对齐」换算它该插在哪：被压缩掉的前段在
                // 新 cm 里没有对应条目，这类 _local 落到摘要卡之后；保留段内的 _local 则回到它
                // 在 cm 中的同位置（seen - 被压缩条数 + 1）。
                var oldNonLocal = 0;
                for (var oi = 0; oi < oldMsgs.length; oi++) {
                    if (!oldMsgs[oi]._local) oldNonLocal++;
                }
                // 摘要卡占新 cm 的第 0 位（上下文压缩）：这一条在旧 state 里没有对应，
                // 算被压缩条数时要扣掉；卡之后的位序才是「保留段」的起点。
                var newEntries = (cmList[0] && (cmList[0]._compactSummary
                    || (cmList[0].role === 'system-result' && cmList[0].title === '上下文压缩'))) ? 1 : 0;
                var headDropped = Math.max(0, oldNonLocal - (cmList.length - newEntries));
                var locals = [];
                var seenNonLocal = 0;
                for (var lj = 0; lj < oldMsgs.length; lj++) {
                    if (!oldMsgs[lj]._local) { seenNonLocal++; continue; }
                    locals.push({
                        anchor: Math.min(cmList.length, Math.max(newEntries, seenNonLocal - headDropped + 1)),
                        msg: oldMsgs[lj]
                    });
                }
                var rebuilt = [];
                var localAt = 0;
                for (var cmPos = 0; cmPos < cmList.length; cmPos++) {
                    while (localAt < locals.length && locals[localAt].anchor <= cmPos) {
                        rebuilt.push(locals[localAt].msg);
                        localAt++;
                    }
                    rebuilt.push(cmList[cmPos]);
                }
                while (localAt < locals.length) {
                    rebuilt.push(locals[localAt].msg);
                    localAt++;
                }
                opts.state.messages = rebuilt;
                return;
            }
            var nonLocal = 0;
            for (var i = 0; i < oldMsgs.length; i++) {
                if (!oldMsgs[i]._local) nonLocal++;
            }
            // cm 前 mirrorCount 条为旧 state 非 _local 条目的镜像段，其后为本次新增段
            var mirrorCount = cmList.length - added;
            var headKeep = Math.max(0, nonLocal - mirrorCount);
            var merged = [];
            var ci = 0;
            for (var k = 0; k < oldMsgs.length; k++) {
                if (oldMsgs[k]._local) { merged.push(oldMsgs[k]); continue; }
                if (headKeep > 0) { merged.push(oldMsgs[k]); headKeep--; continue; }
                if (ci < mirrorCount) { merged.push(cmList[ci]); ci++; continue; }
                merged.push(oldMsgs[k]);
            }
            // cm 剩余条目（含尾部新增段与镜像段残余）追加到末尾
            while (ci < cmList.length) { merged.push(cmList[ci]); ci++; }
            opts.state.messages = merged;
        }

        // 活动会话落盘（防抖）：供「直接写 cm、不经过 pushSystemResult」的注入点复用
        // （goal 第 1 轮的隐藏 user 消息由 apiActions 写入，需与 pushSystemResult 同口径落盘，
        // 否则面板在下一轮保存前关闭时，隐藏指令丢失而 roundsStarted 已落盘）。
        function saveActiveSessionDebounced() {
            try { opts.saveActiveSessionDebounced(); } catch (_) { /* 落盘失败不影响当前轮上下文 */ }
        }

        // 把 system-result 结构写入当前 contextManager 并落盘会话。
        // visible/detail 形如 { text, images, videos, files }；llmRole 决定上下文角色 user/assistant。
        function pushSystemResult(title, visible, detail, llmRole) {
            var _v = visible || {};
            var _d = detail || {};
            var msg = getActiveCm().addSystemResult({
                title: title || '',
                llmRole: llmRole || 'user',
                visibleText: _v.text,
                visibleImages: _v.images,
                visibleVideos: _v.videos,
                visibleFiles: _v.files,
                detailText: _d.text,
                detailImages: _d.images,
                detailVideos: _d.videos,
                detailFiles: _d.files
            });
            syncStateFromCm(1);   // addSystemResult 已在 cm 尾部追加 1 条
            opts.saveActiveSessionDebounced();
            return msg;
        }

        // 收集所有给定会话 store 中仍被引用的 chat_img_ 文件名（不含 dataURL）。
        // 用于清空会话时的安全删除：仅当某图片不再被任何会话引用时才删除，避免共用图断链。
        // 保留集必须补扫归档（<id>.archive.json）——被压缩/裁剪的旧消息副本
        // 仍被 read_early_history 以图片路径喂给 LLM，只扫主消息文件会让归档引用成死链。
        // 归档读取走 sessionStore 既有 loadArchive 入口（上限 500 条/会话）。
        // fail-closed——任一会话/归档读取失败（load/loadArchive 抛错或返回
        // __readFailed 哨兵）即整轮返回 null（引用集不完整），调用方在 null 时放弃删除；
        // 任一失败被折叠成「该会话零引用」会让清空/预算清理把仍被引用的用户附件删掉。
        // 索引读失败保护态（store.isIndexReadFailed()）同样整轮 fail-closed
        // ——哨兵态 listSessions() 为空，枚举不到会话等于把旧会话引用全判成孤儿。
        function collectAllChatImgRefs(stores) {
            var allStores = Array.isArray(stores) ? stores : [stores];
            return Promise.all(allStores.map(function (s) {
                return (s && typeof s.whenReady === 'function') ? s.whenReady().catch(function () {}) : Promise.resolve();
            })).then(function () {
                var refs = {};
                var readFailed = false;
                // 单条消息 → 引用文件名。附件路径数组字段按持久化口径取全：user 消息
                // images；system-result 卡 visibleImages/detailImages（context.js 落库形态）。
                // dataURL 内嵌图不落盘缓存，不参与引用。
                function addMsgRefs(m) {
                    if (!m) return;
                    var fields = [m.images, m.visibleImages, m.detailImages];
                    for (var f = 0; f < fields.length; f++) {
                        var arr = fields[f];
                        if (!Array.isArray(arr)) continue;
                        for (var j = 0; j < arr.length; j++) {
                            var p = arr[j];
                            if (typeof p === 'string' && p.indexOf('data:') !== 0 && p.indexOf('chat_img_') >= 0) {
                                refs[p.replace(/\\/g, '/').split('/').pop()] = true;
                            }
                        }
                    }
                }
                var tasks = [];
                allStores.forEach(function (store) {
                    if (!store || typeof store.listSessions !== 'function' || typeof store.load !== 'function') return;
                    // 索引读失败保护态下 listSessions() 返回空表，枚举不到任何
                    // 会话（零 task）→ 引用集空 → 清空/预算清理会删掉仍被旧会话引用的图。
                    // 先查 store 暴露的索引哨兵标志，为真即整轮 fail-closed（返回 null）。
                    if (typeof store.isIndexReadFailed === 'function' && store.isIndexReadFailed()) {
                        readFailed = true;
                        return;
                    }
                    var sessions = [];
                    try { sessions = store.listSessions() || []; } catch (_) { return; }
                    sessions.forEach(function (s) {
                        if (!s || !s.id) return;
                        tasks.push(
                            store.load(s.id).then(function (msgs) {
                                if (msgs && msgs.__readFailed) { readFailed = true; return; }
                                if (!Array.isArray(msgs)) return;
                                for (var i = 0; i < msgs.length; i++) addMsgRefs(msgs[i]);
                            }).catch(function () { readFailed = true; })
                        );
                        // 归档同扫：清空会话是单次操作（非 30 分钟周期任务），
                        // 每会话多一次归档文件读（无档时读空即返 null），量级不变。
                        if (typeof store.loadArchive === 'function') {
                            tasks.push(
                                store.loadArchive(s.id).then(function (archived) {
                                    if (archived && archived.__readFailed) { readFailed = true; return; }
                                    if (!Array.isArray(archived)) return;
                                    for (var i = 0; i < archived.length; i++) addMsgRefs(archived[i]);
                                }).catch(function () { readFailed = true; })
                            );
                        }
                    });
                });
                return Promise.all(tasks).then(function () { return readFailed ? null : refs; });
            });
        }

        function isAbortError(error) {
            if (!error) return false;
            if (error.name === 'AbortError') return true;
            const msg = String(error && error.message ? error.message : error).toLowerCase();
            return msg.includes('abort');
        }

        function getErrorMessage(type, rawError) {
            switch (type) {
                case 'timeout': return AEI18n.t('请求超时，模型响应时间过长。可尝试：1) 更换更快的模型；2) 精简对话上下文；3) 稍后重试。');
                case 'network': return AEI18n.t('网络连接失败，请检查网络连接后重试。');
                case 'auth':    return AEI18n.t('API Key 无效或已过期，请检查对应平台的 API Key 设置。');
                case 'rate':    return AEI18n.t('请求频率过高被限流，请等待几秒后重试。');
                case 'quota':   return AEI18n.t('API 额度不足，请充值后重试。');
                case 'server':  return AEI18n.t('API 服务端异常，请稍后重试。');
                default:        return AEI18n.t('请求失败: ') + ((rawError && rawError.message) ? rawError.message : String(rawError || ''));
            }
        }

        // 编辑重发路径的 chip token → 引用说明（与 app/main.js 发送路径一致）：
        // LLM 收到行号引用/图层引用/文件引用（不嵌代码全文、图层只给稳定键 id），
        // UI 用 displayText 显示原始 chip token。
        // 不依赖内存记录：跨会话粘贴来的 token 也按行号/载荷里的 id/名解析。
        // 按当前 runtimeMode 选择行号读取工具名——shader 模式下
        // get_current_script（module:script scope）未注册，对应工具为
        // get_current_shader（module:shader），硬编码会把 LLM 指向不存在的工具。
        // 与 app/main.js _resolveChipTokens 同步实现（两处分属 engine/app 层，
        // 无法共享实现，改动须两处同步）；引用类 token 的语法与解析取自
        // utils/chipTokens.js（该模块 app/engine 共用，无副本）。
        // 文件引用在这条路径上**只给名**：附件 chip 在发送时就清空了，这里查不到路径
        //（发送路径此刻附件还在，故那里多给一个路径——名与口径同源，只是这个字段有无之别）。
        function resolveChipTokensForLlm(text) {
            if (!text) return text;
            var settings = opts.getSettings ? opts.getSettings() : null;
            var mode = settings ? settings.runtimeMode : 'script';
            // agent 模式下两个行号读取工具均未注册，中性提示代替工具指引
            var guide = mode === 'shader' ? '可调 get_current_shader 工具读取'
                : mode === 'agent' ? 'Agent 模式无行号读取工具，需切换到 Script/Shader 模式读取'
                : '可调 get_current_script 工具读取';
            var ct = global.AEAgentApp && global.AEAgentApp.chipTokens;
            var withRefs = ct
                ? ct.resolveFileTokens(ct.resolveItemTokens(ct.resolveLayerTokens(String(text))))
                : String(text);
            return String(withRefs).replace(/\u200b {2}(L\d+(?:-L\d+)?(?:\(\d+\))?) {2}\u200b/g, function (m, label) {
                var mm = /^L(\d+)(?:-L(\d+))?/.exec(label);
                var s = mm ? Number(mm[1]) : 0;
                var e = mm && mm[2] != null ? Number(mm[2]) : s;
                if (e > s) return '（预览区 L' + s + '-L' + e + ' 行代码，' + guide + '）';
                return '（预览区 L' + s + ' 行代码，' + guide + '）';
            });
        }

        // 列表里"不在 state.messages 里的活元素"：整表重建（listEl.innerHTML=''）会把它们抹掉
        // ——流式气泡、执行中/压缩中的进度条、待确认卡片、内联编辑框（含未保存文本）
        var _LIVE_ELS = '.ae-agent-message-streaming, .ae-agent-message.tool-progress, '
            + '.ae-agent-message.tool-confirm, .ae-agent-msg-edit-wrap';

        // 能否现在做全量重建（DEBUG 开关的延迟重建用）：空闲 + 列表可见 + 无活元素。
        // 列表没有布局盒（模块未显示）时也不做——此时既拿不到阅读位置，滚动也落不到真实高度上，
        // 重建完用户回到模块只会看到列表顶部。
        function _canFullRebuildNow() {
            if (opts.state.busy) return false;
            var listEl = document.getElementById((opts.dom && opts.dom.listId) || 'aeAgentMessageList');
            if (!listEl || !(listEl.clientHeight > 0 || listEl.scrollHeight > 0)) return false;
            if (listEl.querySelector && listEl.querySelector(_LIVE_ELS)) return false;
            return true;
        }

        function syncView(onDone) {
            // DEBUG 开关的延迟重建：应用发生在主面板保存全局设置时（那一刻 Agent 面板
            // display:none），或此时列表里正有活元素——那些时刻重建会丢东西。登记在 state 上，等这一次
            // （通常是回到模块那次）可见且空闲的 syncView 再消费。
            if (opts.state.debugRebuildPending && _canFullRebuildNow()) {
                opts.state.debugRebuildPending = false;
                if (opts.view && typeof opts.view.resetRenderedCount === 'function') {
                    opts.view.resetRenderedCount();
                }
            }
            opts.view.renderMessages(opts.state.messages, opts.state.mode, onDone);
            opts.view.setBusy(opts.state.busy, opts.state.busyText);
            opts.view.setMode(opts.state.mode);
            // 全局控件（清空对话 / 模式开关）随**当前 lane** 置灰：非当前 lane 的忙碌不该锁住用户
            // 正在看的界面；团队模式下会话切换器的锁判据由全局宿主 index.js 按「任一 lane busy」算
            //（这里拿不到别的 lane 的状态）。
            var _isTeam = (typeof opts.isTeamMode === 'function') ? opts.isTeamMode() : false;
            var _isCurrent = (typeof opts.isCurrentLane === 'function') ? opts.isCurrentLane() : true;
            if (!_isTeam || _isCurrent) {
                // 忙碌时禁用模式切换相关按钮
                var lockBtns = ['clearConversationBtn'];
                for (var i = 0; i < lockBtns.length; i++) {
                    var el = document.getElementById(lockBtns[i]);
                    if (el) el.disabled = opts.state.busy;
                }
                var modeSwitchEl = document.getElementById('runtimeModeSwitch');
                if (modeSwitchEl) {
                    // 点状 slot 整体禁用（无子按钮），通过 pointer-events 控制
                    modeSwitchEl.style.pointerEvents = opts.state.busy ? 'none' : '';
                    modeSwitchEl.style.opacity = opts.state.busy ? '0.5' : '';
                }
            }
            if (_isTeam) {
                // 团队模式：把本 lane 的忙碌/停止中状态上报给宿主（index.js 汇总三条 lane 决定
                // 会话切换器禁用态），此处不再自行置灰 switcher。
                if (typeof opts.onBusyChange === 'function') {
                    try { opts.onBusyChange(opts.state.busy, opts.getStopping()); } catch (_) {}
                }
            } else {
                // 忙碌或停止清理窗口（_stopping）内锁定会话切换器：
                // 该窗口内 switchSession 等入口会被拒，UI 同步置灰防误点
                var switcherLocked = opts.state.busy || opts.getStopping();
                if (switcherLocked !== opts.getLastSwitcherLocked()) {
                    opts.setLastSwitcherLocked(switcherLocked);
                    if (global.AEEngine && typeof global.AEEngine.setSessionSwitcherDisabled === 'function') {
                        try { global.AEEngine.setSessionSwitcherDisabled(switcherLocked); } catch (_) {}
                    }
                }
            }
            opts.onStateChange(opts.state);
        }

        return { getActiveCm: getActiveCm, getActiveStore: getActiveStore, pushSystemResult: pushSystemResult, saveActiveSessionDebounced: saveActiveSessionDebounced, syncStateFromCm: syncStateFromCm, collectAllChatImgRefs: collectAllChatImgRefs, isAbortError: isAbortError, getErrorMessage: getErrorMessage, resolveChipTokensForLlm: resolveChipTokensForLlm, syncView: syncView };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createChatViewHelpers = createChatViewHelpers;
})(typeof global !== 'undefined' ? global : window);