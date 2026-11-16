// 运行模式五段开关（script/agent/shader/external/**team**）
// 从 app/main.js 的 bindEvents 闭包拆出：
//   - cachedSettings 经惰性 getter 注入（main.js 顶层 let）

//   第 5 档 = 团队模式。
// 第 5 档是**第一等档位**——
//   `settings.runtimeMode` 就是面板档位（合法值含 'team'），被 park 的单 Agent 档位搬到
//   `settings.team.baseMode`。旧语义（第 5 档不写 runtimeMode、真相源只有 team.enabled）让
//   「面板在哪个档」这个问题在会话名 / 胶囊 / 工具栏 / 白闪四处各错一次。
//   于是本文件的进出团队都变成**一步**：
//     · 点第 5 档 ⇒ setTeamEnabled(true)：一次 saveSettings 写 runtimeMode='team' + baseMode=来处；
//     · 点别的档 ⇒ 直接 switchGlobalMode(目标档)：controller.switchMode 写 runtimeMode=目标档，
//       成功返回后由 switchGlobalMode 关引擎（详见下方「退出团队：一步式」注释）。
//   旋钮位置的渲染由 main.js 的 syncRuntimeMode 统一裁决（档位表与 engine 的 MODES 同源）。
(function (global) {
    function createRuntimeModeSwitch(opts) {
        var getCachedSettings = opts.getCachedSettings || function () { return {}; };
        var applySettingsToUI = opts.applySettingsToUI;
        var refreshList = opts.refreshList;
        var syncRuntimeMode = opts.syncRuntimeMode;
        var getShaderUI = opts.getShaderUI;
        // 点击处理器单飞。switchMode 首个 await 前已置 controller 侧
        // _modeSwitching 同步锁，但这里再加一道——第二次点击不再重复派发（避免 busy
        // 提示刷屏与成功钩子重复执行），也覆盖 controller 实例被替换/残留实例并存的情形。
        var _switchInFlight = false;

        // 切换成功后的 UI 补全步骤逐段隔离（refreshList 自带 try-catch 但防御性统一，
        // 任何一步异常不阻断剩余步骤）。**定义在工厂层**：团队档分支与单 Agent 档分支
        // 都要用它，声明在某个 if/else 块里的话另一条分支在块执行前拿不到它（sloppy 模式下
        // Annex B 只保证名字存在、值是 undefined ⇒ 调用抛 TypeError 且被 catch 静默吞掉）。
        function _tryHook(label, fn) {
            try { fn(); } catch (hookErr) {
                console.error('[Agent] 模式切换钩子(' + label + ')异常:', hookErr);
            }
        }

        // 会话标题刷新（窄接口）：`refreshSessionSwitcher` 是**宽跳**
        //（= 标题 + `_refreshTeamUI()` ⇒ `teamUI.mount()` 全量重挂载），真机实测
        // **315ms/次（团队档）/ 622ms/次（单 Agent 档）**；模式切换只需要标题跟上。
        // 窄接口缺席（旧部署/旧混合包）时回落宽接口，行为与改动前逐字一致。
        function _refreshSessionTitle() {
            var E = window.AEEngine;
            if (!E) return;
            if (typeof E.refreshSessionTitle === 'function') {
                try { E.refreshSessionTitle(); } catch (_) { /* 标题刷新失败不该打穿切档 */ }
                return;
            }
            if (typeof E.refreshSessionSwitcher === 'function') {
                try { E.refreshSessionSwitcher(); } catch (_) { /* 同上（旧部署回落） */ }
            }
        }

        // 外接布局残留检测（脱节自愈）：设置(runtimeMode)与 UI(ext-mode-active)
        // 可能脱节——switchMode 内部 saveSettings 已写入新模式但切换流程中途异常时，
        // ext-exit 钩子不会执行，ext-mode-active 残留会以 display:none!important 压住
        // 聊天区/输入区，UI 永久卡在外接布局。此后点击目标模式档还会因「设置已是目标
        // 模式」被同档守卫静默吞掉（点击无反应）。三处自愈路径（同档/same/catch）统一
        // 经此判定：目标模式非 external 而外接布局还挂着 → 摘类恢复。
        function _extStuck() {
            try {
                var ap = document.getElementById('agentPanel');
                return !!(ap && ap.classList.contains('ext-mode-active'));
            } catch (_) { return false; }
        }
        function _healExitExternal(targetMode) {
            if (targetMode === 'external') return;
            if (!_extStuck()) return;
            try {
                if (window.AEExternal && window.AEExternal.view) window.AEExternal.view.exit();
            } catch (healErr) {
                console.error('[Agent] 脱节自愈 ext-exit 异常:', healErr);
            }
        }

        function bind(runtimeModeSwitch) {
            if (!runtimeModeSwitch) return;
            runtimeModeSwitch.addEventListener('click', async function (e) {
                // 档位表引用 engine 的唯一来源（第 5 档是第一等档位）
                var modes = (window.AEEngine && window.AEEngine.settings && window.AEEngine.settings.MODES)
                    || ['script', 'agent', 'shader', 'external', 'team'];
                var cachedSettings = getCachedSettings();
                // 当前档 = `settings.runtimeMode`（该字段**就是**面板档位）。
                // teamOn 仅作保险丝：异步装配窗口里设置可能还没落盘而引擎已开团队，此时按引擎裁决，
                // 免得同档守卫把这一次点击静默吞掉（runtimeMode 与 team.enabled 恒一致，它不改变稳态结果）。
                var teamOn = false;
                try {
                    teamOn = !!(window.AEAgentTeamUI && window.AEAgentTeamUI.isTeamModeOn && window.AEAgentTeamUI.isTeamModeOn());
                } catch (_) { teamOn = false; }
                var currentMode = teamOn ? 'team' : ((cachedSettings && cachedSettings.runtimeMode) || 'script');
                var currentIdx = modes.indexOf(currentMode);
                if (currentIdx < 0) currentIdx = 0;
                // 直接定位：点击 mode-track 五等分定位（script/agent/shader/external/team）
                var trackEl = e.target && e.target.closest ? e.target.closest('.mode-track') : null;
                var newIdx = currentIdx;
                if (trackEl) {
                    var rect = trackEl.getBoundingClientRect();
                    var ratio = (e.clientX - rect.left) / rect.width;
                    newIdx = ratio < 1 / 5 ? 0 : (ratio < 2 / 5 ? 1 : (ratio < 3 / 5 ? 2 : (ratio < 4 / 5 ? 3 : 4)));
                } else {
                    // 点击标签等非轨道区域→默认下一档（保留循环）
                    newIdx = (currentIdx + 1) % modes.length;
                }
                var newMode = modes[newIdx];
                // 第 5 档（团队）：开/关团队。这一下由
                // `teamUI.setTeamEnabled` 在同一次 saveSettings 里把 `runtimeMode` 一并写成 'team'
                // （团队 = 模式旋钮第 5 档，设置段必须与旋钮同源）；本处只下发开关、等落地后再刷新旋钮与列表。
                if (newMode === 'team') {
                    if (teamOn) return;                       // 已经在团队档
                    if (_switchInFlight) return;
                    _switchInFlight = true;
                    try {
                        var teamUi = window.AEAgentTeamUI;
                        if (!teamUi || typeof teamUi.setTeamEnabled !== 'function') {
                            if (window.AEToast) window.AEToast.show(AEI18n.t('团队模式不可用：团队面板未装配'), 'error');
                            return;
                        }
                        var r = await teamUi.setTeamEnabled(true);
                        if (r === false) {
                            if (window.AEToast) window.AEToast.show(AEI18n.t('团队模式开启失败（设置未写入或装配失败）'), 'error');
                        } else {
                            _tryHook('apply-settings', function () { applySettingsToUI({ ...getCachedSettings() }); });
                            _tryHook('refresh-list', function () { refreshList(); });
                        }
                        _tryHook('sync-knob', function () { syncRuntimeMode(teamUi.isTeamModeOn() ? 'team' : currentMode); });
                    } catch (e2) {
                        console.error('[Agent] 进入团队模式异常:', e2);
                        if (window.AEToast) window.AEToast.show(AEI18n.t('进入团队模式失败: {reason}', { reason: (e2 && e2.message ? e2.message : e2) }), 'error');
                    } finally {
                        _switchInFlight = false;
                    }
                    return;
                }
                // 已在目标模式则不处理（避免无意义重入）——例外：设置与 UI 脱节
                //（设置已是目标模式但外接布局残留）时不吞掉，继续走下方 same 自愈，
                // 否则 UI 永久卡死（点击无反应）。脱节判据：目标非 external 而外接布局在
                // 团队档下 `currentMode` 恒为 'team'，故本守卫不会吞掉「点别的档 = 退出团队」。
                if (newMode === currentMode && !(newMode !== 'external' && _extStuck())) return;
                // ── 退出团队：**一步式** ──────────────────────────────
                // 不再先 `setTeamEnabled(false,{targetMode})` 再切档（旧的两步做法）。那一步会把设置
                // 直接写成目标档 ⇒ 随后的 switchMode 在 `same` 守卫返回、**走不到模式钩子**（外接布局
                // enter / shader 预览启动都在切档成功路径里），退团队到外接会只换档位不换布局。
                // 现在只走下面这一个出口：`switchGlobalMode(newMode)` ⇒ controller.switchMode 写设置
                //（runtimeMode=newMode，engine 侧唯一归一实现同步把 team.enabled 置假）⇒ 成功返回后由
                // switchGlobalMode 关引擎（`_disableTeam`）。失败则设置被回滚回团队档、引擎保持开着，
                // 两侧天然一致。白闪在一步式下**结构上不存在**：底层档从头到尾没被写进设置，
                // 也就没有任何一次 refreshList 按它作画（`skipChromeRefresh` 因此不再被本路径需要）。
                // 出口缺席（旧部署/装配未完成）时回落旧路径，行为与改动前一致。
                // 全局模式切换的**唯一正确落点**：优先走宿主出口
                // AEEngine.switchGlobalMode（固定用单 Agent 那条 runtime）。
                // 为什么不能用 getController()：团队模式下它返回**当前 lane** 的 controller，
                // 而 lane 的 getSettings().runtimeMode 被钉死为它的 slot（director/ae-exec=agent、
                // glsl=shader）⇒ 在 director/ae-exec lane 上点旋钮切 agent 会判 same、什么都不做
                //（真机实测：lane=director 点 agent 象限无反应；换 lane=glsl 同一次点击就切成功）。
                var switchModeFn = null;
                if (window.AEEngine && typeof window.AEEngine.switchGlobalMode === 'function') {
                    switchModeFn = window.AEEngine.switchGlobalMode;
                } else {
                    var controller = window.AEEngine && typeof window.AEEngine.getController === 'function' && window.AEEngine.getController();
                    if (controller && typeof controller.switchMode === 'function') {
                        switchModeFn = function (m) { return controller.switchMode(m); };
                    }
                }
                if (!switchModeFn) return;
                if (_switchInFlight) return;   // 在途切换期间忽略再次点击
                _switchInFlight = true;
                try {
                    var result = await switchModeFn(newMode);
                    if (result && !result.ok && result.reason === 'same') {
                        // 设置里已是目标模式（UI 与设置曾脱节）：按钮已拨向正确方向，
                        // 不回弹，直接按当前设置刷新 UI——让脱节自愈合而非永久卡死。
                        // 摘外接布局（refreshList 不摘类，残留时聊天区/输入区仍被压住）
                        _healExitExternal(newMode);
                        applySettingsToUI({ ...getCachedSettings() });
                        refreshList();
                        _refreshSessionTitle();
                    } else if (!result || !result.ok) {
                        syncRuntimeMode((getCachedSettings() && getCachedSettings().runtimeMode) || 'script');
                        if (result && result.reason === 'busy' && window.AEToast) {
                            window.AEToast.show(AEI18n.t('请等待当前任务完成'), 'warn');
                        } else if (result && result.reason === 'store_not_ready' && window.AEToast) {
                            // 目标模式的会话索引还没就绪（init 未落地 / 索引读失败）：如实提示。
                            // 不回弹到「什么都没发生」——否则用户看到的是「点了没反应」。
                            window.AEToast.show(AEI18n.t('会话数据尚未就绪，请稍后再切换模式'), 'warn');
                        }
                    } else {
                        // 切换本体已成功——后续 UI 补全步骤逐段隔离（_tryHook 在工厂层）
                        // 补全模式切换后的 UI 更新（switchMode 内部不触发这些）
                        _tryHook('apply-settings', function () {
                            applySettingsToUI({ ...getCachedSettings(), runtimeMode: newMode });
                        });
                        _tryHook('refresh-list', function () { refreshList(); });
                        // 模式进出钩子：
                        //   shader → 先退出外接布局（残留 ext-mode-active 会压住聊天框/输入框）再启动预览
                        // external → 布局重排 + 预览循环常驻（必做）
                        //   script/agent → 停止渲染并隐藏 shader 区块；离开 external 恢复原生布局
                        if (newMode === 'shader') {
                            _tryHook('ext-exit', function () {
                                if (window.AEExternal && window.AEExternal.view) window.AEExternal.view.exit();
                            });
                            _tryHook('shader-start', function () {
                                var su = getShaderUI();
                                if (su) { su.startPreview(); su.refreshLibrary(); }
                            });
                        } else if (newMode === 'external') {
                            _tryHook('ext-enter', function () {
                                if (window.AEExternal && window.AEExternal.view) window.AEExternal.view.enter();
                            });
                            _tryHook('shader-start', function () {
                                var su3 = getShaderUI();
                                if (su3) { su3.startPreview(); su3.refreshLibrary(); }
                            });
                        } else {
                            _tryHook('ext-exit', function () {
                                if (window.AEExternal && window.AEExternal.view) window.AEExternal.view.exit();
                            });
                            _tryHook('shader-stop', function () {
                                var su2 = getShaderUI();
                                if (su2) { su2.stopPreview(); su2.hideLeft(); su2.hideRight(); }
                            });
                        }
                        _tryHook('session-switcher', _refreshSessionTitle);
                    }
                } catch (e) {
                    console.error('[Agent] switchMode 异常:', e);
                    // 切换中途异常：switchMode 内部可能已 saveSettings 写入新模式（设置与
                    // UI 脱节的根源），回弹开关的同时摘外接布局（若残留）——否则 UI 卡外接
                    // 且下次点击被同档守卫吞掉
                    var rbMode = (getCachedSettings() && getCachedSettings().runtimeMode) || 'script';
                    _healExitExternal(rbMode);
                    syncRuntimeMode(rbMode);
                    if (window.AEToast) {
                        // 同款参数错误——show 第二参须为类型字符串（对象会拼成
                        // ae-toast-[object Object]，error 样式与音效失效）
                        window.AEToast.show(AEI18n.t('模式切换失败: {reason}', { reason: (e && e.message ? e.message : e) }), 'error');
                    }
                } finally {
                    _switchInFlight = false;   // 成功/失败/异常一律释放单飞
                }
            });
        }

        return { bind };
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.createRuntimeModeSwitch = createRuntimeModeSwitch;
})(window);
