(function (global) {
    'use strict';
    // submitUserInput 主派发器外提。纯迁移自 controller.js api 门面内联的 submitUserInput。
    // 依赖经 opts 注入（对应 controller createController 作用域闭包变量，可变状态用 getter/setter 惰性引用）：
    //   view / pendingInput / state：直接引用
    //   getSettings：读模块设置（待发送消息派发时机的入队提示文案按它切换）
    //   getStopping / setStopping / getSwitching / getInjectQueue /
    //   setPendingImages / setStopRequested /
    //   getStopPromiseResolve / setStopPromiseResolve / getActiveAbortController / setActiveAbortController
    //   messageHelpers / chatViewHelpers / onStateChange / showStatus
    //   getAutoTitle / getRunUserRequest / getCompressContext
    function createInputDispatch(opts) {
        // 派发互斥锁：入口检查通过后到 _runUserRequest 同步置 state.busy 之间存在 await
        // 窗口（gather 含多次 evalScript、用量达触发阈值时的自动压缩 LLM 调用），期间 busy 仍为
        // false——第二次提交会在检查点放行，形成两个并发工具循环交错写
        // state.messages/contextManager。持锁期间重入与 busy 同等对待（走入队分支），
        // finally 确保清除（含异常路径）。不提前置 state.busy：compressContext 以 busy
        // 拒绝非 internal 调用，提前置位会让本函数的自动压缩直接失败。
        // 锁状态经 getDispatching 暴露给 controller 注入 apiActions（sendInjectItem
        // 空闲分支同窗口内不得并发发起第二条处理链）。
        var _dispatching = false;
        async function submitUserInput() {
            // 消息编辑的 gather/读图/确认弹窗 await 窗口（不设 busy）内
            // 提交会与编辑路径的 truncateFrom 并发——新消息刚持久化即被截断删除，且并发
            // 起两个工具循环交错写状态。直接拒绝且不入队（编辑截断会清空 _injectQueue，
            // 入队等于静默丢弃），保留输入框内容供操作完成后重发。检查放在读取输入与
            // pendingInput.consume() 之前，避免破坏性消费后拒绝导致 pending 丢失。
            if (opts.getMsgActionBusy && opts.getMsgActionBusy()) {
                if (typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('当前有操作进行中，请稍候再发送'), 'warn', { autoHideMs: 3000 });
                }
                return;
            }
            // 启动会话恢复链（store.init/migrate/动画等待/switchSession）完成前，
            // 各守卫全 false（busy 未置、_switching 在 switchSession 调用后才置位），
            // 消息会 addMessage 进初始 'default' 孤儿会话、随后被恢复流程 importMessages
            // 覆盖丢弃。恢复期间直接拒绝提交（保留输入框内容），bootstrap 在链首尾
            // 置位/复位 state.restoring（含异常路径 finally）。
            if (opts.state.restoring) {
                if (typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('会话恢复中，请稍候'), 'info', { autoHideMs: 3000 });
                }
                return;
            }
            // 会话切换窗口（store.load 异步可达数百 ms）内提交不能走入队分支——
            // 切换窗口内 getActiveCm 身份处于过渡态，入队补记的 sessionId 可能
            // 拿到切换后新会话的 id，用户在旧会话视图上发的消息归属错位；也不能直接
            // 放行——addMessage 会写进半初始化新会话、
            // 随后被 importMessages 覆盖丢失。对齐 editUserMessage/
            // sendInjectItem 的守卫直接拒绝，保留输入框内容供切换完成后重发。
            // 检查在 pendingInput.consume() 之前，避免破坏性消费后拒绝导致 pending 附件丢失。
            if (opts.getSwitching && opts.getSwitching()) {
                if (typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('正在切换会话，请稍候再发送'), 'info', { autoHideMs: 3000 });
                }
                return;
            }
            // 文本可能含代码片段 token，app/main.js 发送前已把 token 原位替换为代码块
            // 并写入 store 的 codeContext（完整消息文本），此处优先采用
            const rawText = opts.view.getInput();
            // 注：askUser 等待期间不接受主输入框提交——提问面板整块替换输入区
            // 回答在面板自带的输入框/选项里给出，不走本派发器。
            // 团队模式：附件按 lane 分槽（写入端在 app/main.js，已带当前 lane）。读取端必须带
            // **同一条** lane——否则附件落缺省槽、被别的 lane 的 consume() 破坏性取走（用户表现为
            // 「拖进来的文件/图片提交后消失」）。单 Agent 路径 getLaneId() 为空 ⇒ 缺省槽，行为不变。
            const _laneId = (typeof opts.getLaneId === 'function' && opts.getLaneId()) || '';
            const pending = (opts.pendingInput && opts.pendingInput.consume(_laneId)) || null;
            const resolved = (pending && pending.codeContext) || '';
            // 聊天框 UI 显示文本：优先用发送前的原始输入（未 trim，保留 chip token 外层间隙空格），
            // 保证聊天框 chip 标签与输入框视觉一致；无则回退 trim 文本
            const displayRaw = (pending && typeof pending.codeDisplay === 'string' && pending.codeDisplay) || rawText;
            const text = resolved || rawText;
            // 拖入文件但未输入文字时：不注入默认指令，LLM 仅依据 <context> 内注入的 [引用文件] 块自行处理
            const _hasFileCtx = !!(pending && pending.fileContext);
            if (!text && !_hasFileCtx) return;
            const effectiveText = text;
            const fileCtx = (pending && pending.fileContext) || null;
            var pendingImages = (pending && pending.imageDataUrls) || null;
            var pendingImagePaths = (pending && pending.imageTempPaths) || null;
            var pendingVideoPaths = (pending && pending.videoPaths) || null;
            var pendingFileRefs = (pending && pending.fileRefs) || null;
            // 最近图片缓存与 ae:recent-images-changed 广播已移除——会话图片
            // 改用「消息里持久化的相对路径 + 发送装配时转绝对」派生（ComfyUI 用 file_path），
            // 不再有面板全局的「最后一批」隐式状态。
            // 图片显示优先使用持久化路径，兜底 data URL。
            // 写盘失败兜底 dataURL 时，超大 base64 不持久化（仅本次发送），防撑爆 localStorage
            var displayImages = pendingImagePaths;
            if (!displayImages && pendingImages) {
                var _smallImages = pendingImages.filter(function (d) { return typeof d === 'string' && d.length <= 2 * 1024 * 1024; });
                displayImages = _smallImages.length > 0 ? _smallImages : null;
            }

            // 执行中：追加消息入队，不打断当前轮。注入时机由模块设置的
            // deferInjectUntilReply 决定（关闭 = 下一轮 LLM 调用前注入；开启 = 等当前轮正式回复后
            // 作为新一轮发送）。用户可随后点停止来打断当前轮 + 用队列重新起一轮。
            // _stopping：requestStop 已触发但旧 loop 的 abort 清理尚未跑完（busy 已被置 false），
            // 此时也走入队——否则会与旧 loop 清理交错起新 loop 导致消息错乱。
            // （_switching 切换窗口已在函数入口直接拒绝并保留输入，见上方，不再入队）
            // _dispatching：本函数的派发窗口（见 createInputDispatch 顶部注释）内重入，
            // 与 busy 同等对待走追加队列。
            if (opts.state.busy || opts.getStopping() || _dispatching) {
                // 执行中：只入队，不 addMessage（消息还没真发给 LLM，显示在悬浮 chip 即可）。
                // 不调 syncView——执行中流式 token 在追加，全量重渲染会打断流式状态导致白屏。
                // 附件（图片/视频/文件引用/[引用文件] 块）随队列条目保留：drain 时经
                // addMessage 以与发送路径相同的字段持久化到历史，否则被静默丢弃。
                // 图片须双通道透传——images（displayImages，持久化/缩略图路径，
                // 无路径时仅 ≤2MB dataURL）之外，imageDataUrls（发给 LLM 的视觉通道原始
                // 数据）也随条目保留，drain 消费点据此注入视觉通道（循环内 drain 直接注入
                // 当前轮 messages / sendInjectItem·finally drain 回填 _pendingImages）；否则
                // 执行中追加的图片只落盘不进 LLM，视觉通道数据永久丢失。
                opts.view.clearInput();
                opts.getInjectQueue().push({
                    // 入队即补记 sessionId——直接入队条目可能跨越
                    // 会话切换存活（maxLoops/网络错误后 finally drain 已跑完、_stopping 清理
                    // 窗口内追加等队列遗留路径，之后用户切走），各 drain 消费点据此经
                    // _isCrossSessionInject 路由回原会话（对齐 sendInjectItem 暂存补记与
                    // injectSystemMessage 入队模式）；缺失时条目会被写进切换后的新会话，
                    // 原会话永久丢失该消息。
                    sessionId: opts.chatViewHelpers.getActiveCm().getSessionId(),
                    text: effectiveText,
                    displayText: displayRaw,
                    images: displayImages,
                    imageDataUrls: pendingImages,
                    videos: pendingVideoPaths,
                    fileRefs: pendingFileRefs,
                    fileCtx: fileCtx
                });
                if (typeof opts.onStateChange === 'function') opts.onStateChange(opts.state);
                if (typeof opts.showStatus === 'function') {
                    // 提示文案跟进派发时机：延后模式要如实说明「等本轮正式回复后
                    // 再发送」，否则沿用旧文案会与实际行为不符（旧文案说「当前轮结束后」）。
                    var _deferInject = false;
                    try {
                        var _dispatchSettings = (typeof opts.getSettings === 'function') ? (opts.getSettings() || {}) : {};
                        _deferInject = !!_dispatchSettings.deferInjectUntilReply;
                    } catch (_) { _deferInject = false; }
                    opts.showStatus(_deferInject
                        ? AEI18n.t('已追加消息，将在本轮回复后发送给 Agent')
                        : AEI18n.t('已追加消息，将在当前轮结束后发送给 Agent'), 'info', { autoHideMs: 3000 });
                }
                return;
            }

            _dispatching = true;
            // 当前轮是否真正进到「起一轮」：提前 return 的停止回滚路径不算（那时没有轮收尾，
            // 不能给 goal 续轮一个假时机）。
            var _runStarted = false;
            try {
                opts.setPendingImages(pendingImages);
                // fileCtx（[引用文件] 块）通过 addMessage 的 extra.fileCtx 注入到 <context> 前缀内，
                // LLM 能看到文件路径，UI 经 stripContextBlock 剥离 <context> 不显示。
                // _runUserRequest 接收纯用户文本（text），与 editUserMessage 路径一致。

                opts.setStopRequested(false);
                opts.setStopPromiseResolve(null);
                opts.setActiveAbortController(new AbortController());
                opts.view.clearInput();
                // gather 提前到 addMessage 之前，使 addMessage 能注入最新 AE snapshot 到 <context> 前缀。
                // 传当前轮模块身份（controller 注入的 getRoundModuleId）：shader 轮无 queryProject
                // （scope 限 agent/script）→ gather 返回 'no-access'、快照为空，工程/选中信息不进
                // shader 轮上下文；未注入该 getter 的调用方传 undefined，退回"不做作用域检查"的旧语义。
                if (global.AEEngine && global.AEEngine.aeContext) {
                    // 并联身份与快照身份分离：moduleIds 决定 scope 合法性（可被拒绝，
                    // 拒绝即快照为空），laneKey 只做缓存分槽、绝不参与作用域判定。
                    // 未注入新 getter 的调用方退回 getRoundModuleId 单串语义（行为不变）。
                    var _gdIds = (typeof opts.getToolModuleIds === 'function') ? opts.getToolModuleIds() : null;
                    if (!_gdIds && typeof opts.getRoundModuleId === 'function') _gdIds = opts.getRoundModuleId();
                    if (!_gdIds) _gdIds = undefined;
                    // 槽键**只认 lane**（团队模式）；单 Agent 路径 getLaneKey() 为空 ⇒ 传 undefined 落
                    // 缺省槽。不得拿 roundModuleId(mode) 当槽键（实测）：那会让跨模式的陈旧
                    // 快照被身份过滤挡掉的旧语义失效，模式往返后读到本模式旧槽。
                    var _gdLaneKey = (typeof opts.getLaneKey === 'function') ? opts.getLaneKey() : null;
                    await global.AEEngine.aeContext.gather(_gdIds, _gdLaneKey || undefined);
                }
                // 停止复查点提前到 addMessage 之前——gather 的 await 窗口内点
                // 停止，消息仍会被 addMessage 持久化（提示「本条消息未发送」但消息
                // 已写 cm 落盘、后续进入 LLM 上下文，用户重发即产生重复）。前置复查使
                // gather 窗口的停止在消息落盘前生效；addMessage 之后压缩窗口的停止由
                // 下方回滚分支兜住，两段窗口的停止语义一致（消息不留在会话）。
                if (opts.getStopRequested && opts.getStopRequested()) {
                    opts.setStopRequested(false);
                    opts.setPendingImages(null);
                    opts.setActiveAbortController(null);
                    if (typeof opts.showStatus === 'function') {
                        opts.showStatus(AEI18n.t('已停止，本条消息未发送'), 'info', { autoHideMs: 3000 });
                    }
                    return;
                }
                // 记录入栈时间戳供压缩窗口的停止回滚定位（addMessage 会注入 <context>
                // 前缀，须以 createdAt + 文本尾部匹配双重校验，防误删同尾历史消息）
                var _preAddTs = Date.now();
                // displayText：UI 显示用原始文本（含 chip token，view 渲染成标签）；text 是 LLM 用的转换文本（行号引用）
                opts.messageHelpers.addMessage('user', effectiveText, null, displayImages, { fileCtx: fileCtx, displayText: displayRaw, videos: pendingVideoPaths, fileRefs: pendingFileRefs });
                // 发送即强制滚到底部：用户发送消息的意图就是查看回复，即使上滑查看历史也应拉回底部，
                // 否则随后流式弹出的"思考过程"UI 判定不贴近底部而跳过自动滚动，用户看不到新内容。
                if (typeof opts.view.scrollToBottom === 'function') opts.view.scrollToBottom();
                opts.getAutoTitle()();

                // ── 上下文用量超阈值处理 ──
                // ≥触发阈值（85）：自动压缩（避免被动裁剪丢消息）；≥70%：仅提醒
                // 判闸用**未取整**的 percentUsedRaw（真值 89.5% 曾被 Math.round 成 90 就触发）；
                // 阈值从 cm 取（COMPACT_TRIGGER_PCT 唯一一份），mock 桩缺字段时回退到同值（85）。
                var _stats = opts.chatViewHelpers.getActiveCm().getTokenStats();
                var _pctExact = (typeof _stats.percentUsedRaw === 'number') ? _stats.percentUsedRaw : (_stats.percentUsed || 0);
                var _pct = Math.round(_pctExact);
                var _trigger = (typeof _stats.compactTriggerPct === 'number') ? _stats.compactTriggerPct : 85;
                // 「待压缩」标记（撞过硬上限被裁剪过）也是触发条件；5% 下限与
                // compressContext 自身的判据（<5% ⇒ nothing_to_compress）对齐，避免空转。
                var _needsByFlag = _stats.needsCompaction === true;
                if (_pctExact >= _trigger || (_needsByFlag && _pctExact >= 5)) {
                    // 自动压缩：在发送前压缩，避免长对话撑爆或被动裁剪丢消息
                    // 必须 await 压缩完成再继续 _runUserRequest，否则竞态会同时改 contextManager
                    var compressResult = await opts.getCompressContext()();
                    if (compressResult && compressResult.success) {
                        if (typeof opts.showStatus === 'function') {
                            // 文案里的百分比取实际阈值（不再硬编码 90）
                            opts.showStatus(AEI18n.t('✓ 上下文已超 {pct}%，已自动压缩', { pct: _trigger }), 'info', { autoHideMs: 3000 });
                        }
                    } else {
                        if (typeof opts.showStatus === 'function') {
                            // 文案唯一一份（apiActions.describeCompressFailure）：这里把内部
                            // 错误码抛给用户，并对 nothing_to_compress 也建议"手动压缩（点击用量条）"
                            // ——那个情形下手动压缩必然同样失败，且该路径当时只 console.warn，
                            // 用户点了没反应。两处口径现已统一。
                            var _cfText = typeof opts.getCompressFailureText === 'function'
                                ? opts.getCompressFailureText()
                                : null;
                            var _reason = (compressResult && compressResult.error) || 'unknown';
                            opts.showStatus(AEI18n.t('⚠ 自动压缩未完成：') + (typeof _cfText === 'function' ? _cfText(_reason) : AEI18n.t('压缩失败，请稍后再试。')), 'error', { autoHideMs: 8000 });
                        }
                    }
                } else if (_pct >= 70 && typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('💡 上下文已使用 {pct}%，建议压缩上下文释放空间（点击用量条）', { pct: _pct }), 'warn', { autoHideMs: 5000 });
                }

                // gather/压缩的 await 窗口内点击停止：compressContext（非 internal 调用）
                // 的 catch 已清 _stopping/busy，而 _runUserRequest 入口会无条件重置
                // stopRequested——不在此复查，停止意图被彻底吞掉、任务照常启动执行。
                if (opts.getStopRequested && opts.getStopRequested()) {
                    // 压缩 await 窗口内点停止——消息已 addMessage 写 cm 并落盘，
                    // 与「本条消息未发送」提示矛盾（用户重发即产生重复）。回滚刚追加的 user
                    // 消息（createdAt 入栈时间戳 + 文本尾部匹配双重校验，从尾部反向定位
                    // 防压缩重排误伤），cm 截断与 state 移除同步，两段窗口的停止语义一致。
                    var _rbCm = opts.chatViewHelpers.getActiveCm();
                    var _rbList = (typeof _rbCm.list === 'function') ? _rbCm.list() : [];
                    // 定位刚写入的那条 user 消息：
                    // 判据曾是「尾部匹配」`text.slice(-effectiveText.length) === effectiveText`，而
                    // **仅拖文件、不输入文字**时 `effectiveText === ''` ⇒ `slice(-0)` 等于 `slice(0)`
                    //（整串）与 `''` 比较**恒 false** ⇒ 定位失败 ⇒ 不回滚、不落盘修正，却仍提示
                    // 「本条消息未发送」——**假陈述**：消息留在 cm/state（含 `[引用文件]` 段），
                    // 还会随防抖快照写盘、并在重载后复活进入下一轮 LLM 上下文。
                    // 修法：空文本时**只用时间锚 + role**（`createdAt >= _preAddTs`，从尾部往前找
                    // 即最近一条），非空时保持原尾部匹配（能同时区分同秒内的多条消息）。
                    var _rbMatch = function (m) {
                        if (!m || m.role !== 'user' || (m.createdAt || 0) < _preAddTs
                            || typeof m.text !== 'string') return false;
                        if (!effectiveText) return true;
                        return m.text.slice(-effectiveText.length) === effectiveText;
                    };
                    var _rbIdx = -1;
                    for (var _rbi = _rbList.length - 1; _rbi >= 0; _rbi--) {
                        if (_rbMatch(_rbList[_rbi])) { _rbIdx = _rbi; break; }
                    }
                    if (_rbIdx >= 0 && typeof _rbCm.truncateFrom === 'function') {
                        _rbCm.truncateFrom(_rbIdx);
                    }
                    var _rbStateHit = false;
                    for (var _rsi = opts.state.messages.length - 1; _rsi >= 0; _rsi--) {
                        if (_rbMatch(opts.state.messages[_rsi])) {
                            opts.state.messages.splice(_rsi, 1);
                            _rbStateHit = true;
                            break;
                        }
                    }
                    // 回滚后同步 UI（addMessage 已渲染的气泡立即移除，防闪烁残留）
                    if (typeof opts.chatViewHelpers.syncView === 'function') {
                        opts.chatViewHelpers.syncView();
                    }
                    // 回滚后立即落盘当前真实状态。addMessage 已把含该消息的快照压进
                    // sessionStore 的单槽防抖（约 2s）——只截断 cm/state 不落盘，防抖到期照旧
                    // 把已回滚的消息写盘，重载后它复活并进入后续 LLM 上下文。用现有活动 store
                    // 的 save 覆盖待写快照，再 flush 立即写出（不新造节流/队列）；无 flush 的
                    // store（极简环境）由 save 的新快照兜底，拿不到 store 时如实上报。
                    if (_rbIdx >= 0) {
                        try {
                            var _rbStore = (opts.chatViewHelpers && typeof opts.chatViewHelpers.getActiveStore === 'function')
                                ? opts.chatViewHelpers.getActiveStore() : null;
                            if (_rbStore && typeof _rbStore.save === 'function' && typeof _rbCm.getSessionId === 'function') {
                                _rbStore.save(_rbCm.getSessionId(), _rbCm.list());
                                if (typeof _rbStore.flush === 'function') _rbStore.flush();
                            } else {
                                console.warn('[InputDispatch] 停止回滚后无法立即保存：活动 store/save 不可用，'
                                    + '该消息可能被挂起的防抖快照写回');
                            }
                        } catch (_rbErr) {
                            console.warn('[InputDispatch] 停止回滚后立即保存失败: '
                                + (_rbErr && _rbErr.message ? _rbErr.message : _rbErr));
                        }
                    }
                    opts.setStopRequested(false);
                    opts.setPendingImages(null);
                    opts.setActiveAbortController(null);
                    if (typeof opts.showStatus === 'function') {
                        // 定位失败时**不得**再断言「未发送」（M-2 的诚实度面）：那时消息可能仍在会话里，
                        // 如实说明并请用户核对，好过给一句错的保证。
                        opts.showStatus((_rbIdx >= 0 || _rbStateHit)
                            ? AEI18n.t('已停止，本条消息未发送')
                            : AEI18n.t('已停止；但未能定位刚写入的消息（它可能仍在会话中，请核对后再发送）'),
                            (_rbIdx >= 0 || _rbStateHit) ? 'info' : 'warn', { autoHideMs: 3000 });
                    }
                    return;
                }

                // 当前轮由用户直接发起（goal 工具权限据此放行 create/edit/pause/resume）
                if (typeof opts.setTurnOrigin === 'function') opts.setTurnOrigin('user');
                _runStarted = true;
                await opts.getRunUserRequest()(effectiveText);
            } finally {
                _dispatching = false;
                // 派发锁释放后再通知一次：goal 续轮的空闲判据包含本锁（轮收尾时 await
                // 尚未返回、锁仍被持有），缺这次补评估，用户轮收尾后就不会起 Goal Round
                // 只在真正起过一轮时通知，停止回滚路径没有轮收尾。
                if (_runStarted && typeof opts.onDispatchEnd === 'function') {
                    try { opts.onDispatchEnd(); } catch (_) { /* 通知失败不影响发送路径 */ }
                }
            }
        }
        return { submitUserInput: submitUserInput, getDispatching: function () { return _dispatching; } };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createInputDispatch = createInputDispatch;
})(typeof global !== 'undefined' ? global : window);