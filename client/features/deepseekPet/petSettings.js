// petSettings.js — 桌宠独立设置弹窗，持久化到 AEFS <dataDir>/deepseekPet/settings.json
(function (global) {
    'use strict';

    var SETTINGS_FILE = 'deepseekPet/settings.json';
    var _settings = {
        showPet: true,
        userName: '',
        // 对话模型：空串 = 跟随主面板「模型管理」选中的默认模型（默认值）；
        // 两项成对写入才表示桌宠单独指定了模型（petChat 据此决定是否覆盖 provider/model）
        chatProviderId: '',
        chatModel: '',
        // 对话超时（毫秒）：模型静默超过该时长则中止请求，持续输出思考内容不触发。默认 120s
        chatTimeoutMs: 120000,
        announceInterval: { min: 30, max: 300 },
        webSearchEnabled: true,
        activityBounds: null,
        // 桌宠大小（CSS px）：80-320，默认 160
        petSize: 160,
        // 主动回复：默认开启，15 分钟触发一次
        autoReply: { enabled: true, intervalSec: 900 },
        // 一次性迁移闸标记：旧版把 deepseek/deepseek-v4-pro 强写为默认值，
        // 下方的旧值迁移只在磁盘上**没有**该标记时执行一次，落盘后永不重跑——
        // 否则用户显式选回这一对模型的每次启动都会被静默清成「跟随主面板」
        chatModelMigrationDone: false
    };
    var _modalEl = null;
    // 写盘防抖句柄：对齐 petHistory._scheduleWrite 模式，并发 updateSettings
    // 静默 500ms 后取最新 _settings 快照写一次盘，避免异步链乱序（旧快照后写覆盖新值）
    var _saveDebounceTimer = null;
    // 三态读取的「读失败态」——readFileResult/复核判定为通道故障（拿不到，
    // 而非文件不存在）时置位，此后拒绝一切覆盖写（见 _persist），防内存默认态把读不出
    // 的原文件整包覆盖。用户提示走既有 AEToast 通道一次（不新增 UI 组件）
    var _readFailed = false;
    var _readFailNotified = false;

    function createSettings() {
        var _loadPromise = null;
        // 默认值快照：读盘完成后用于识别"加载期间被 updateSettings 修改过的字段"
        var _defaultsSnapshot = null;

        function init() {
            _defaultsSnapshot = Object.assign({}, _settings);
            _loadPromise = _loadFromDisk();
            return _loadPromise;
        }

        function whenReady() {
            return _loadPromise || Promise.resolve();
        }

        function _getDataDir() {
            if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                return global.AEShared.getDataDir().dir;
            }
            return '';
        }

        function _getFilePath() {
            var dir = _getDataDir();
            if (!dir) return null;
            return dir.replace(/\\/g, '/') + '/' + SETTINGS_FILE;
        }

        // ── 原子写助手（对齐素材库 folderStoreMixin.js 的
        // atomicWriteJson  定稿形态 + providerRegistry.js）──
        // 先写 <file>.tmp 再 rename 到正式名，写盘瞬间崩溃不再留下半截 JSON——
        // 原直写覆盖若被崩溃打断，下次启动 parse 失败即触发「静默重置」清空设置。
        // rename 失败（Bridge 下线走 ExtendScript 回退时 File.rename 不能覆盖既有目标）
        // 时绝不先删正式文件：旧文件挪 .recovery-<时间戳> 旁路，rename 成功才删旁路；
        // 仍失败则新旧两份内容都留在盘上（tmp 改名 .recovery- 留存，失败时绝不清 tmp）。
        // renameFile 不可用（降级环境/仅 mock writeFile 的旧测试）时回退直写。
        function _atomicWriteFile(filePath, content) {
            if (typeof AEFS.renameFile !== 'function') return AEFS.writeFile(filePath, content);
            var tmpPath = filePath + '.tmp';
            // 重试一旦启动，tmp 就可能成为新内容唯一副本——此后兜底不得再清理 tmp
            var _inRetry = false;
            var _recoverySeq = 0;
            function _nextRecoveryPath() {
                _recoverySeq = (_recoverySeq + 1) % 1000000000;
                return filePath + '.recovery-' + Date.now() + '-' + _recoverySeq;
            }
            function _cleanupTmp() {
                try { if (AEFS.deleteFile) AEFS.deleteFile(tmpPath).catch(function () {}); } catch (_) {}
            }
            // rename 失败兜底：tmp 是新内容唯一副本，绝不清理——改名 .recovery- 留存；
            // 挪到旁路的旧正式文件尽力放回原位（放回失败则旧内容留在旁路名下）
            function _preserveBothCopies(asidePath, movedOk) {
                var keepPath = _nextRecoveryPath();
                var park = AEFS.renameFile(tmpPath, keepPath).catch(function () {});
                var restore = movedOk ? AEFS.renameFile(asidePath, filePath).catch(function () {}) : null;
                return Promise.all([park, restore || Promise.resolve()]).then(function () { return false; });
            }
            return AEFS.writeFile(tmpPath, content).then(function (writeOk) {
                if (!writeOk) return false;
                return AEFS.renameFile(tmpPath, filePath).then(function (renameOk) {
                    if (renameOk) return true;
                    // rename 失败先复核 tmp 仍在——并发写交错时 tmp 缺失则放弃本次写入，
                    // 绝不删正式文件（否则毁掉并发者刚落位的好数据）
                    var recheck = (typeof AEFS.exists === 'function')
                        ? AEFS.exists(tmpPath) : Promise.resolve(true);
                    return recheck.then(function (tmpAlive) {
                        if (!tmpAlive) return false;
                        // 旧正式文件先挪 .recovery-<时间戳> 旁路（而非直接删除），
                        // rename 成功后才删旁路旧文件；仍失败则两份内容都留在盘上
                        var asidePath = _nextRecoveryPath();
                        _inRetry = true;
                        var moveAside = AEFS.renameFile(filePath, asidePath).then(function (ok) { return ok; },
                            function () { return false; });
                        return moveAside.then(function (movedOk) {
                            return AEFS.renameFile(tmpPath, filePath).then(function (retryOk) {
                                if (!retryOk) return _preserveBothCopies(asidePath, movedOk);
                                if (movedOk && AEFS.deleteFile) {
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
                if (!_inRetry) _cleanupTmp();   // 重试阶段 tmp 是唯一副本，绝不清理
                return false;
            });
        }

        // ── 损坏文件备份助手（对齐 providerRegistry.js 的 _backupCorruptProvidersFile 模式）──
        // parse 失败先把损坏原件改名备份（<file>.corrupt-<时间戳>）再重置——否则随后的
        // 防抖重写把默认设置覆盖回原路径，损坏原件不可恢复。备份失败仅告警不中断重置
        // （renameFile 不可用的降级环境跳过备份）。
        function _backupCorruptFile(filePath) {
            if (typeof AEFS.renameFile !== 'function') return Promise.resolve(false);
            var corruptBakPath = filePath + '.corrupt-' + Date.now();
            return AEFS.renameFile(filePath, corruptBakPath).then(function () {
                console.warn('[petSettings] 损坏文件已备份到: ' + corruptBakPath);
                return true;
            }).catch(function (e) {
                console.warn('[petSettings] 损坏文件备份失败: ' + e);
                return false;
            });
        }

        // ── 三态读取（readFileResult 优先）──
        // AEFS.readFile 把「文件不存在」与「通道故障」都折叠成 null，二者一律按
        // 「首次运行」用默认值继续；此后任何写触发（updateSettings 防抖 500ms / destroy
        // flush）都会把内存默认态整包覆盖读不出的原文件，原设置不可恢复（无 .corrupt 备份）。
        // 三态判据：ok → 正常解析；NOT_FOUND → 首次运行旧语义（可写）；
        // CHANNEL_FAILURE/REJECTED/通道异常（拿不到/无法判定）→ 读失败态，拒绝覆盖写。
        // 旧式 AEFS（无 readFileResult，测试 mock/降级环境）：readFile 折叠 null 后用
        // existsResult（或 exists 折叠布尔）复核——文件在却读不出即通道故障；复核原语
        // 也不可用（无法判定）同样按读失败态处理（保守：宁可拒绝写不可覆盖原文件）。
        function _readFileTriState(p) {
            if (typeof AEFS.readFileResult === 'function') {
                return AEFS.readFileResult(p).then(function (r) {
                    if (r && r.ok === true) return { status: 'ok', content: r.data };
                    if (r && r.error && r.error.code === 'NOT_FOUND') return { status: 'notfound' };
                    return { status: 'failed', message: (r && r.error && r.error.message) || 'readFileResult 失败' };
                }, function (e) { return { status: 'failed', message: (e && e.message) || String(e) }; });
            }
            if (typeof AEFS.readFile !== 'function') return Promise.resolve({ status: 'failed', message: 'AEFS.readFile 不可用' });
            return AEFS.readFile(p).then(function (content) {
                // 空串是「成功读到 0 字节文件」而非失败（readFile 契约：失败恒 null），
                // summary 类文件合法为空——按失败处理会把正常空文件误判成通道故障
                if (content !== null && content !== undefined) return { status: 'ok', content: content };
                if (typeof AEFS.existsResult === 'function') {
                    return AEFS.existsResult(p).then(function (r) {
                        if (r && r.ok === true) return { status: 'failed', message: '文件存在但读取为空（通道故障）' };
                        if (r && r.error && r.error.code === 'NOT_FOUND') return { status: 'notfound' };
                        return { status: 'failed', message: (r && r.error && r.error.message) || 'existsResult 失败' };
                    }, function (e) { return { status: 'failed', message: (e && e.message) || String(e) }; });
                }
                if (typeof AEFS.exists === 'function') {
                    return AEFS.exists(p).then(function (ex) {
                        return ex ? { status: 'failed', message: '文件存在但读取为空（通道故障）' } : { status: 'notfound' };
                    }, function (e) { return { status: 'failed', message: (e && e.message) || String(e) }; });
                }
                // 无任何存在性复核通道：无法判定「真没有」还是「拿不到」——按读失败态
                // 保守处理（宁可拒绝写不可覆盖原文件）
                return { status: 'failed', message: 'readFile 返回空且无存在性复核通道（无法判定）' };
            }, function (e) { return { status: 'failed', message: (e && e.message) || String(e) }; });
        }

        // 读失败态置位 + 一次用户可见提示（既有 AEToast 通道，不新增 UI 组件）。
        // 置位后 _persist 拒绝一切覆盖写；提示只发一次，防每次写触发刷屏
        function _markReadFailed(message) {
            _readFailed = true;
            console.warn('[petSettings] settings.json 读取失败（' + message + '），进入保护态：本次会话拒绝覆盖写盘，原文件保留: ' + (_getFilePath() || ''));
            if (_readFailNotified) return;
            _readFailNotified = true;
            if (global.AEToast && typeof global.AEToast.warn === 'function') {
                try { global.AEToast.warn(AEI18n.t('桌宠设置读取失败，已暂停保存以免覆盖原文件（请重启面板或检查 Bridge 连接后重试）')); } catch (_) {}
            }
        }

        function _applyLoadedContent(content, p) {
            try {
                var data = JSON.parse(content);
                // 加载期间可能有 updateSettings：先按默认值快照识别运行时已修改的字段，
                // 磁盘数据应用后再叠加运行时修改，避免磁盘旧值回滚用户的最新设置
                // （若 data 直接覆盖 _settings，与"保留运行时修改"的意图正好相反）
                var runtime = {};
                if (_defaultsSnapshot) {
                    Object.keys(_settings).forEach(function (k) {
                        if (_settings[k] !== _defaultsSnapshot[k]) runtime[k] = _settings[k];
                    });
                }
                var migrationDoneOnDisk = data.chatModelMigrationDone === true;
                _settings = Object.assign({}, _defaultsSnapshot || _settings, data, runtime);
                // 旧版默认值（deepseek/deepseek-v4-pro 由迁移强写）迁到
                // 「跟随主面板」——只在磁盘上没有一次性标记时执行；迁移后立刻把标记
                // 一并落盘（_scheduleSave），此后用户显式选回 deepseek/deepseek-v4-pro
                // 不再被清。注意：磁盘上无标记、又在本次迁移落盘前**曾**显式选择过这
                // 一对模型的用户会被再清一次（磁盘无痕，无从区分），标记落盘后不再发生。
                if (!migrationDoneOnDisk) {
                    if (_settings.chatProviderId === 'deepseek' && _settings.chatModel === 'deepseek-v4-pro') {
                        _settings.chatProviderId = '';
                        _settings.chatModel = '';
                    }
                    _settings.chatModelMigrationDone = true;
                    _scheduleSave();
                }
            } catch (e) {
                // JSON 损坏不得静默吞掉（对齐 petHistory/petMemory 的处理）：
                // 否则用户持久化的桌宠设置（名字/尺寸/区域/间隔等）每次启动
                // 静默重置为默认值且无任何反馈；告警 + 安排重写修复损坏文件
                console.warn('[petSettings] settings.json parse failed, resetting: ' + e);
                // 重写前先把损坏原件改名备份（settings.json.corrupt-<时间戳>），
                // 否则默认设置覆盖回原路径后原件不可恢复；备份 settle 后再安排重写
                _backupCorruptFile(p).then(function () {
                    _scheduleSave();
                });
            }
        }

        function _loadFromDisk() {
            var p = _getFilePath();
            if (!p || typeof AEFS === 'undefined') return Promise.resolve();
            if (typeof AEFS.readFileResult !== 'function' && typeof AEFS.readFile !== 'function') return Promise.resolve();
            return _readFileTriState(p).then(function (res) {
                if (res.status === 'failed') {
                    // 通道故障/拒绝：置读失败态（拒绝覆盖写）；连读都读不到故无法留
                    // .corrupt 备份（对齐定稿修复的「跳过备份」分支）
                    _markReadFailed(res.message);
                    return;
                }
                if (res.status === 'ok' && res.content) {
                    _applyLoadedContent(res.content, p);
                }
                // 本次启动即视为"迁移闸已放行"——内存标记置位后，后续任何
                // updateSettings 的落盘都会带上 true。否则全新安装（无 settings.json）
                // 的用户显式选回 deepseek/deepseek-v4-pro 时，首次保存会把标记 false
                // 写盘，下次启动又被当成旧默认值清掉。
                _settings.chatModelMigrationDone = true;
            });
        }

        // 同步原子写（仅面板卸载 flush 用）：writeFileSync(tmp) → renameFileSync 落位。
        // rename 失败尽力直写正式名（牺牲原子性保数据）；同步原语缺失（旧 mock/降级
        // AEFS）或直写也失败返回 false，由调用方回落异步链
        function _syncAtomicWrite(filePath, dir, content) {
            if (typeof AEFS.writeFileSync !== 'function') return false;
            try { if (typeof AEFS.mkdirSync === 'function') AEFS.mkdirSync(dir); } catch (_) {}
            var tmpPath = filePath + '.tmp';
            if (typeof AEFS.renameFileSync === 'function') {
                if (AEFS.writeFileSync(tmpPath, content) && AEFS.renameFileSync(tmpPath, filePath)) return true;
                return !!AEFS.writeFileSync(filePath, content);
            }
            return !!AEFS.writeFileSync(filePath, content);
        }

        // 写盘唯一出口：_readFailed 时拒绝覆盖写。
        // sync=true（面板卸载 flush）优先走 AEFS 同步通道原子写——Bridge 同步 XHR /
        // cep.fs 原生同步调用，beforeunload 内可完成；同步不可用时回落异步链并如实
        // 返回 false（异步 XHR 在卸载窗口可能来不及，边界见 petIndex.flush 注释）
        function _persist(sync) {
            var p = _getFilePath();
            if (!p || typeof AEFS === 'undefined' || !AEFS.writeFile) return false;
            if (_readFailed) {
                console.warn('[petSettings] 读取失败态：拒绝覆盖写 settings.json（原文件内容未读到，写回会用默认值整包覆盖）');
                return false;
            }
            var dir = p.substring(0, p.lastIndexOf('/'));
            // JSON.stringify 加 try/catch 防止循环引用抛错
            var dataStr;
            try {
                dataStr = JSON.stringify(_settings);
            } catch (e) {
                console.warn('[petSettings] JSON.stringify failed: ' + e);
                return false;
            }
            if (sync && _syncAtomicWrite(p, dir, dataStr)) return true;
            // 加 .catch 防止 mkdir/writeFile reject 时 unhandledrejection
            // 改走 .tmp→rename 原子写，写盘瞬间崩溃不再留半截 JSON
            AEFS.mkdir(dir).then(function () {
                return _atomicWriteFile(p, dataStr);
            }).catch(function (e) {
                console.warn('[petSettings] save to disk failed: ' + e);
            });
            return false;
        }

        // 防抖写盘：连续 updateSettings 只在静默 500ms 后落盘一次，
        // _persist 执行时同步读取 _settings 即最新快照，天然避免旧快照乱序后写
        function _scheduleSave() {
            if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
            _saveDebounceTimer = setTimeout(function () {
                _saveDebounceTimer = null;
                _persist(false);
            }, 500);
        }

        // 面板卸载前落盘（main.js beforeunload → petIndex.flush → controller.flush）：
        // 取消防抖窗口并同步写（AEFS.writeFileSync → renameFileSync 原子落位，见 _persist）。
        // 不清 _settings 内存态、不置销毁标志——beforeunload 可能被取消（用户取消关闭
        // 面板），模块须保持可用（对齐 engine/bootstrap.js sessionStore.flush 语义）。
        // 边界：同步通道不可用时回落异步写，能否在卸载窗口内完成取决于异步通道；
        // 若防抖已触发、异步写仍在途，同步写可能与其迟到完成乱序（卸载窗口极窄，
        // 模块无写链，重排风险与既有并发写同级）
        function flush() {
            if (_saveDebounceTimer) { clearTimeout(_saveDebounceTimer); _saveDebounceTimer = null; }
            return _persist(true);
        }

        function getSettings() { return _settings; }

        function updateSettings(patch) {
            _settings = Object.assign({}, _settings, patch);
            _scheduleSave();
        }

        function _buildModelOptions() {
            // 与 main.js:1211-1218 getProviderList/getModelList 同源
            // 读取 global.AE_LLM.providerRegistry，而非已废弃的 GLOBAL_MODELS
            var registry = global.AE_LLM && global.AE_LLM.providerRegistry;
            if (!registry || typeof registry.listProviders !== 'function') return [];
            var providers = [];
            try {
                providers = registry.listProviders(false) || [];
            } catch (e) {
                console.warn('[petSettings] listProviders failed: ' + e);
                return [];
            }
            var options = [];
            for (var i = 0; i < providers.length; i++) {
                var p = providers[i];
                if (!p || !p.id) continue;
                var models = [];
                try {
                    models = registry.listModels(p.id) || [];
                } catch (e) { continue; }
                for (var j = 0; j < models.length; j++) {
                    var m = models[j];
                    if (!m || !m.id) continue;
                    options.push({
                        value: p.id + ':' + m.id,
                        // registry 实际字段是 label：providerRegistry.normalizeProvider 只设 p.label，
                        // model-manager 保存模型为 {id,label,capabilities}；无 label（内置预设模型）时回退 id
                        label: (p.label || p.id) + ' — ' + (m.label || m.id)
                    });
                }
            }
            return options;
        }

        function openModal() {
            // 等待磁盘加载完成后再打开，避免用默认值覆盖用户已有设置
            whenReady().then(function () {
                if (_modalEl) { _fillForm(); _showModal(); return; }
                _buildModal();
            });
        }

        function _showModal() {
            // 与项目标准模式一致（model-manager/view.js:691）：用 .open 类切显示
            // 直接 style.display='flex' 不行——.modal-mask 默认 opacity:0，只切 display 仍不可见
            if (!_modalEl) return;
            _modalEl.classList.remove('hidden');
            _modalEl.classList.add('open');
        }

        function _buildModal() {
            _modalEl = document.createElement('div');
            _modalEl.className = 'modal-mask hidden';
            _modalEl.id = 'petSettingsModal';
            _modalEl.innerHTML =
                '<div class="modal pet-settings-modal">' +
                    '<div class="modal-head">' +
                        AEI18n.html('<span class="modal-title">桌宠设置</span>') +
                        AEI18n.html('<button class="icon-btn pet-settings-close" title="关闭">✕</button>') +
                    '</div>' +
                    '<div class="modal-body ae-scrollbar pet-settings-body">' +
                        '<div class="pet-settings-row">' +
                            '<div class="pet-settings-label">' +
                                AEI18n.html('<span class="pet-settings-label-text">开启桌宠</span>') +
                                AEI18n.html('<span class="pet-settings-label-tip">关闭后停止所有桌宠功能（动画/对话/闲时播报/主动回复等），但保留设置可重新开启</span>') +
                            '</div>' +
                            '<label class="toggle-wrap">' +
                                '<input type="checkbox" id="petSettingShow" class="switch-input">' +
                                '<span class="switch-slider"></span>' +
                            '</label>' +
                        '</div>' +
                        '<div class="pet-settings-row">' +
                            '<div class="pet-settings-label">' +
                                AEI18n.html('<span class="pet-settings-label-text">你的名字</span>') +
                                AEI18n.html('<span class="pet-settings-label-tip">桌宠会用这个名字称呼你，留空则不称呼</span>') +
                            '</div>' +
                            AEI18n.html('<input type="text" id="petSettingUserName" class="pet-settings-text-input" placeholder="输入你的名字" maxlength="20">') +
                        '</div>' +
                        '<div class="pet-settings-row">' +
                            '<div class="pet-settings-label">' +
                                AEI18n.html('<span class="pet-settings-label-text">对话模型</span>') +
                                AEI18n.html('<span class="pet-settings-label-tip">长按桌宠可唤起对话气泡；默认跟随主面板「模型管理」选中的模型，也可在此单独指定</span>') +
                            '</div>' +
                            '<select id="petSettingModel" class="text-input"></select>' +
                        '</div>' +
                        '<div class="pet-settings-row">' +
                            '<div class="pet-settings-label">' +
                                AEI18n.html('<span class="pet-settings-label-text">对话超时（毫秒）</span>') +
                                AEI18n.html('<span class="pet-settings-label-tip">模型静默超过该时长则中止请求（持续输出思考内容不会触发）。范围 30000-600000</span>') +
                            '</div>' +
                            '<input type="number" id="petSettingTimeout" class="pet-settings-text-input" min="30000" max="600000" step="5000">' +
                        '</div>' +
                        '<div class="pet-settings-row">' +
                            '<div class="pet-settings-label">' +
                                AEI18n.html('<span class="pet-settings-label-text">联网搜索</span>') +
                                AEI18n.html('<span class="pet-settings-label-tip">开启后桌宠对话会先调用 Web Search 工具检索补充信息，再交由 LLM 生成回复</span>') +
                            '</div>' +
                            '<label class="toggle-wrap">' +
                                '<input type="checkbox" id="petSettingSearch" class="switch-input">' +
                                '<span class="switch-slider"></span>' +
                            '</label>' +
                        '</div>' +
                        '<div class="pet-settings-row pet-settings-row-col">' +
                            '<div class="pet-settings-row-h">' +
                                AEI18n.html('<label class="pet-settings-label-text">闲时播报间隔</label>') +
                                '<span class="pet-settings-interval-value" id="petIntervalValue">30-300s</span>' +
                            '</div>' +
                            '<div class="pet-range-group">' +
                                '<div class="pet-range-row">' +
                                    AEI18n.html('<span class="pet-range-label">最小</span>') +
                                    '<input type="range" id="petSettingIntervalMin" min="30" max="270" step="10">' +
                                    '<span class="pet-range-label pet-range-value" id="petIntervalMinValue">30s</span>' +
                                '</div>' +
                                '<div class="pet-range-row">' +
                                    AEI18n.html('<span class="pet-range-label">最大</span>') +
                                    '<input type="range" id="petSettingIntervalMax" min="60" max="300" step="10">' +
                                    '<span class="pet-range-label pet-range-value" id="petIntervalMaxValue">300s</span>' +
                                '</div>' +
                            '</div>' +
                            AEI18n.html('<span class="pet-settings-label-tip">桌宠会在用户无操作时定期调用 LLM 主动说一句话，模拟"陪伴感"。最小值与最大值之间随机取一个延迟，避免节奏过于机械。</span>') +
                        '</div>' +
                        '<div class="pet-settings-row">' +
                            '<div class="pet-settings-label">' +
                                AEI18n.html('<span class="pet-settings-label-text">主动回复</span>') +
                                AEI18n.html('<span class="pet-settings-label-tip">开启后桌宠会定时主动说一句话（默认 15 分钟）。用户主动发送消息后会重置计时</span>') +
                            '</div>' +
                            '<label class="toggle-wrap">' +
                                '<input type="checkbox" id="petSettingAutoReply" class="switch-input">' +
                                '<span class="switch-slider"></span>' +
                            '</label>' +
                        '</div>' +
                        '<div class="pet-settings-row pet-settings-row-col">' +
                            '<div class="pet-settings-row-h">' +
                                AEI18n.html('<label class="pet-settings-label-text">主动回复间隔（分钟）</label>') +
                                '<span class="pet-settings-interval-value" id="petAutoReplyValue">15min</span>' +
                            '</div>' +
                            '<div class="pet-range-row">' +
                                '<input type="range" id="petSettingAutoReplyInterval" min="1" max="60" step="1">' +
                                '<span class="pet-range-label pet-range-value" id="petAutoReplyIntervalValue">15min</span>' +
                            '</div>' +
                            AEI18n.html('<span class="pet-settings-label-tip">范围 1-60 分钟，用户主动发送消息后会从此间隔重新计时</span>') +
                        '</div>' +
                        '<div class="pet-settings-row pet-settings-row-col">' +
                            '<div class="pet-settings-row-h">' +
                                AEI18n.html('<label class="pet-settings-label-text">桌宠大小</label>') +
                                '<span class="pet-settings-interval-value" id="petSizeValue">160px</span>' +
                            '</div>' +
                            '<div class="pet-range-row">' +
                                '<input type="range" id="petSettingSize" min="80" max="320" step="10">' +
                                '<span class="pet-range-label pet-range-value" id="petSizeRangeValue">160px</span>' +
                            '</div>' +
                            AEI18n.html('<span class="pet-settings-label-tip">调整桌宠显示尺寸（80-320px），实时生效。默认 160px</span>') +
                        '</div>' +
                        '<div class="pet-settings-row">' +
                            '<div class="pet-settings-label">' +
                                AEI18n.html('<span class="pet-settings-label-text">活动区域</span>') +
                                AEI18n.html('<span class="pet-settings-label-tip">限制桌宠只能在框选的矩形范围内活动（含漫游和拖拽）</span>') +
                            '</div>' +
                            '<div class="pet-zone-actions">' +
                                AEI18n.html('<span class="pet-zone-status" id="petZoneStatus">未设置</span>') +
                                AEI18n.html('<button class="btn secondary" id="petSettingResetZone">重新框选</button>') +
                                AEI18n.html('<button class="btn" id="petSettingClearZone">清除</button>') +
                            '</div>' +
                        '</div>' +
                        '<div class="pet-settings-row pet-settings-section-danger">' +
                            '<div class="pet-settings-label">' +
                                AEI18n.html('<span class="pet-settings-label-text">重置桌宠激活</span>') +
                                AEI18n.html('<span class="pet-settings-label-tip">用于测试：关闭桌宠并重新加载页面，恢复"大肥鱼"彩蛋待触发状态</span>') +
                            '</div>' +
                            AEI18n.html('<button class="btn pet-btn-danger" id="petSettingResetActivation">重置激活</button>') +
                        '</div>' +
                        '<div class="pet-settings-about">' +
                            AEI18n.html('<div class="pet-settings-about-title">大肥鱼桌宠 v1.0</div>') +
                            AEI18n.html('<div class="pet-settings-about-line">独立记忆系统 + 联网搜索，与 Agent 模块零干扰</div>') +
                            AEI18n.html('<div class="pet-settings-about-tip">彩蛋触发：在"全局设置 → 数据目录"输入 <code>大肥鱼</code> 保存即可激活</div>') +
                        '</div>' +
                    '</div>' +
                '</div>';
            document.body.appendChild(_modalEl);

            _modalEl.querySelector('.pet-settings-close').addEventListener('click', closeModal);

            var modelSelect = _modalEl.querySelector('#petSettingModel');
            var modelOpts = _buildModelOptions();
            // 首项「跟随主面板默认」（value 空串，可选）：默认状态，选中即清空桌宠自己的模型配置；
            // 注册表里没有任何模型时也能选（主面板未配置模型时本就是这个状态，不必另加提示项）
            var followOpt = document.createElement('option');
            followOpt.value = '';
            followOpt.textContent = AEI18n.t('（跟随主面板默认）');
            modelSelect.appendChild(followOpt);
            for (var k = 0; k < modelOpts.length; k++) {
                var opt = document.createElement('option');
                opt.value = modelOpts[k].value;
                opt.textContent = modelOpts[k].label;
                modelSelect.appendChild(opt);
            }

            // 双滑块控制 [min, max] 范围，max 始终 >= min
            var minInput = _modalEl.querySelector('#petSettingIntervalMin');
            var maxInput = _modalEl.querySelector('#petSettingIntervalMax');
            var intervalValue = _modalEl.querySelector('#petIntervalValue');
            var intervalMinLabel = _modalEl.querySelector('#petIntervalMinValue');
            var intervalMaxLabel = _modalEl.querySelector('#petIntervalMaxValue');
            function _updateIntervalLabel() {
                var lo = parseInt(minInput.value);
                var hi = parseInt(maxInput.value);
                if (hi < lo) { hi = lo; maxInput.value = lo; }
                if (intervalValue) intervalValue.textContent = lo + '-' + hi + 's';
                if (intervalMinLabel) intervalMinLabel.textContent = lo + 's';
                if (intervalMaxLabel) intervalMaxLabel.textContent = hi + 's';
            }
            minInput.addEventListener('input', _updateIntervalLabel);
            maxInput.addEventListener('input', _updateIntervalLabel);
            minInput.addEventListener('change', function () {
                var lo = parseInt(minInput.value);
                var hi = parseInt(maxInput.value);
                if (hi < lo) { hi = lo; maxInput.value = lo; }
                updateSettings({ announceInterval: { min: lo, max: hi } });
            });
            maxInput.addEventListener('change', function () {
                var lo = parseInt(minInput.value);
                var hi = parseInt(maxInput.value);
                if (hi < lo) { lo = hi; minInput.value = lo; }
                updateSettings({ announceInterval: { min: lo, max: hi } });
            });

            // 用户名字输入框
            var userNameInput = _modalEl.querySelector('#petSettingUserName');
            if (userNameInput) {
                userNameInput.addEventListener('change', function (e) {
                    updateSettings({ userName: e.target.value.trim() });
                });
            }

            _modalEl.querySelector('#petSettingShow').addEventListener('change', function (e) {
                updateSettings({ showPet: e.target.checked });
                if (global.AEDeepseekPet && global.AEDeepseekPet.controller) {
                    var ctrl = global.AEDeepseekPet.controller;
                    if (e.target.checked) {
                        // 开启：从 shutdown 状态恢复
                        if (typeof ctrl.startup === 'function') ctrl.startup();
                        else ctrl.show();
                    } else {
                        // 关闭：停止所有子模块运行时（暂停 timer/RAF/活动检测），隐藏 DOM
                        if (typeof ctrl.shutdown === 'function') ctrl.shutdown();
                        else ctrl.hide();
                    }
                }
            });

            modelSelect.addEventListener('change', function () {
                // 选「跟随主面板默认」：两个字段一起清空，petChat 便不再覆盖 provider/model
                var v = modelSelect.value || '';
                if (!v) {
                    updateSettings({ chatProviderId: '', chatModel: '' });
                    return;
                }
                // value 形如 "providerId:modelId"，modelId 自身可能含 ":"，所以只 split 第一个
                var sepIdx = v.indexOf(':');
                var providerId = sepIdx >= 0 ? v.substring(0, sepIdx) : '';
                var modelId = sepIdx >= 0 ? v.substring(sepIdx + 1) : '';
                updateSettings({ chatProviderId: providerId, chatModel: modelId });
            });

            // 对话超时：毫秒输入，clamp 到 30000-600000
            var timeoutInput = _modalEl.querySelector('#petSettingTimeout');
            if (timeoutInput) {
                timeoutInput.addEventListener('change', function () {
                    var v = Math.max(30000, Math.min(600000, parseInt(timeoutInput.value, 10) || 120000));
                    timeoutInput.value = v;
                    updateSettings({ chatTimeoutMs: v });
                });
            }

            _modalEl.querySelector('#petSettingSearch').addEventListener('change', function (e) {
                updateSettings({ webSearchEnabled: e.target.checked });
            });

            // 主动回复开关
            var autoReplyToggle = _modalEl.querySelector('#petSettingAutoReply');
            if (autoReplyToggle) {
                autoReplyToggle.addEventListener('change', function (e) {
                    var cur = _settings.autoReply || { enabled: true, intervalSec: 900 };
                    updateSettings({ autoReply: { enabled: e.target.checked, intervalSec: cur.intervalSec } });
                    // 通知桌宠侧重新调度主动回复（走既有 petApi → eventBus 通道，不新造机制）：
                    // 关闭时 petAutoReply._reschedule 清 timer 且不排；重新打开必须显式触发，
                    // 否则要等下次 chat:userSend / onWake 才恢复计时。
                    try {
                        if (global.AEDeepseekPet && global.AEDeepseekPet.api &&
                            typeof global.AEDeepseekPet.api.emit === 'function') {
                            global.AEDeepseekPet.api.emit('settings:autoReplyChanged', { enabled: e.target.checked });
                        }
                    } catch (_) {}
                });
            }
            // 主动回复间隔滑块
            var autoReplyInterval = _modalEl.querySelector('#petSettingAutoReplyInterval');
            var autoReplyValueEl = _modalEl.querySelector('#petAutoReplyValue');
            var autoReplyIntervalLabel = _modalEl.querySelector('#petAutoReplyIntervalValue');
            if (autoReplyInterval) {
                autoReplyInterval.addEventListener('input', function () {
                    var v = parseInt(autoReplyInterval.value);
                    if (autoReplyValueEl) autoReplyValueEl.textContent = v + 'min';
                    if (autoReplyIntervalLabel) autoReplyIntervalLabel.textContent = v + 'min';
                });
                autoReplyInterval.addEventListener('change', function () {
                    var v = parseInt(autoReplyInterval.value);
                    var cur = _settings.autoReply || { enabled: true, intervalSec: 900 };
                    updateSettings({ autoReply: { enabled: cur.enabled, intervalSec: v * 60 } });
                    // 间隔变更同样要让 petAutoReply 重排计时器（复用开关路径的既有
                    // petApi → eventBus 通道）——只 updateSettings 不发事件时，已挂的旧
                    // interval setTimeout 继续跑，新间隔要等下次 chat:userSend/onWake 才生效。
                    try {
                        if (global.AEDeepseekPet && global.AEDeepseekPet.api &&
                            typeof global.AEDeepseekPet.api.emit === 'function') {
                            global.AEDeepseekPet.api.emit('settings:autoReplyChanged', { enabled: cur.enabled, intervalSec: v * 60 });
                        }
                    } catch (_) {}
                });
            }

            // 桌宠大小滑块：input 时实时调整桌宠尺寸（视觉反馈），change 时持久化到磁盘
            var petSizeInput = _modalEl.querySelector('#petSettingSize');
            var petSizeValueEl = _modalEl.querySelector('#petSizeValue');
            var petSizeRangeLabel = _modalEl.querySelector('#petSizeRangeValue');
            if (petSizeInput) {
                petSizeInput.addEventListener('input', function () {
                    var v = parseInt(petSizeInput.value);
                    if (petSizeValueEl) petSizeValueEl.textContent = v + 'px';
                    if (petSizeRangeLabel) petSizeRangeLabel.textContent = v + 'px';
                    // 实时应用：让用户拖动滑块时立刻看到桌宠变大变小
                    if (global.AEDeepseekPet && global.AEDeepseekPet.controller && typeof global.AEDeepseekPet.controller.applyPetSize === 'function') {
                        global.AEDeepseekPet.controller.applyPetSize(v);
                    }
                });
                petSizeInput.addEventListener('change', function () {
                    var v = parseInt(petSizeInput.value);
                    updateSettings({ petSize: v });
                });
            }

            _modalEl.querySelector('#petSettingResetZone').addEventListener('click', function () {
                if (global.AEDeepseekPet && global.AEDeepseekPet.controller) {
                    var ctrl = global.AEDeepseekPet.controller;
                    closeModal();
                    if (ctrl.getActivityZone) {
                        // 框选完成后重新读 bounds、刷新 UI 状态文本、同步到 controller、重新打开设置面板
                        ctrl.getActivityZone().startSelection(function () {
                            if (ctrl.getActivityZone) {
                                var b = ctrl.getActivityZone().getBounds();
                                if (b && ctrl.setActivityBounds) ctrl.setActivityBounds(b);
                            }
                            // 重新打开设置面板并刷新活动区域状态文本
                            openModal();
                        });
                    }
                }
            });

            var clearZoneBtn = _modalEl.querySelector('#petSettingClearZone');
            if (clearZoneBtn) {
                clearZoneBtn.addEventListener('click', function () {
                    if (global.AEDeepseekPet && global.AEDeepseekPet.controller) {
                        var ctrl = global.AEDeepseekPet.controller;
                        if (ctrl.getActivityZone) {
                            ctrl.getActivityZone().reset();
                        }
                        if (ctrl.setActivityBounds) ctrl.setActivityBounds(null);
                    }
                    updateSettings({ activityBounds: null });
                    _refreshZoneStatus();
                });
            }

            // 内部辅助：根据 _settings.activityBounds 刷新状态文本
            function _refreshZoneStatus() {
                var statusEl = _modalEl.querySelector('#petZoneStatus');
                if (!statusEl) return;
                var b = _settings.activityBounds;
                if (!b) {
                    statusEl.textContent = AEI18n.t('未设置（整面板）');
                    statusEl.classList.add('is-empty');
                } else {
                    statusEl.textContent = Math.round(b.w) + ' × ' + Math.round(b.h) + ' px';
                    statusEl.classList.remove('is-empty');
                }
            }
            _refreshZoneStatus();

            var resetBtn = _modalEl.querySelector('#petSettingResetActivation');
            var _resetting = false;  // 防重入标志，避免 800ms reload 期间重复点击
            resetBtn.addEventListener('click', function () {
                if (_resetting) return;
                // 优先使用项目统一的 showConfirm；不可用时退回原生 confirm
                var doReset = function () {
                    if (_resetting) return;
                    _resetting = true;
                    resetBtn.disabled = true;  // 立即禁用按钮防重入
                    try {
                        var ctx = global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function' ? global.AEAppContainer.getContext() : null;
                        var store = ctx && ctx.settingsStore;
                        if (store && typeof store.getGlobalSettings === 'function' && typeof store.setGlobalSettings === 'function') {
                            store.getGlobalSettings({}).then(function (current) {
                                current.enableDeepseekPet = false;
                                return store.setGlobalSettings(current);
                            }).then(function (writeResult) {
                                // setGlobalSettings 写失败 resolve false（配额满/加密异常）——
                                // 不看返回值直接弹「已重置激活」并 reload 时实际未落盘，
                                // 重载后桌宠仍是激活态。false 当失败走既有 catch 提示/复位按钮。
                                if (writeResult === false) {
                                    throw new Error(AEI18n.t('设置写入失败（本地存储被拒绝，可能已满）'));
                                }
                                if (global.AEToast) global.AEToast.success(AEI18n.t('已重置激活，正在重新加载...'));
                                setTimeout(function () { location.reload(); }, 800);
                            }).catch(function (e) {
                                _resetting = false;
                                resetBtn.disabled = false;
                                console.warn('[petSettings] reset activation failed: ' + e);
                                if (global.AEToast) global.AEToast.error(AEI18n.t('重置失败：') + (e && e.message ? e.message : e));
                            });
                        } else {
                            if (global.AEToast) global.AEToast.warn(AEI18n.t('未找到设置存储，直接重载页面'));
                            setTimeout(function () { location.reload(); }, 800);
                        }
                    } catch (e) {
                        _resetting = false;
                        resetBtn.disabled = false;
                        console.warn('[petSettings] reset activation error: ' + e);
                        if (global.AEToast) global.AEToast.error(AEI18n.t('重置出错：') + (e && e.message ? e.message : e));
                    }
                };
                var msg = AEI18n.t('确定要重置桌宠激活状态吗？\n\n将会：\n1. 关闭桌宠（enableDeepseekPet=false）\n2. 重新加载页面\n3. 恢复彩蛋待触发状态（可重新输入"大肥鱼"激活）');
                if (typeof global.showConfirm === 'function') {
                    global.showConfirm(AEI18n.t('重置桌宠激活'), msg, 'confirm').then(function (ok) {
                        if (ok) doReset();
                    });
                } else if (global.confirm(msg)) {
                    doReset();
                }
            });

            _modalEl.classList.remove('hidden');
            _modalEl.classList.add('open');
            _fillForm();
        }

        function _fillForm() {
            if (!_modalEl) return;
            var showInput = _modalEl.querySelector('#petSettingShow');
            if (showInput) showInput.checked = _settings.showPet;

            var userNameInput = _modalEl.querySelector('#petSettingUserName');
            if (userNameInput) userNameInput.value = _settings.userName || '';

            var modelSelect = _modalEl.querySelector('#petSettingModel');
            if (modelSelect) {
                // 未显式选择（两字段为空）→ 回填首项「跟随主面板默认」
                var modelVal = (_settings.chatProviderId && _settings.chatModel)
                    ? _settings.chatProviderId + ':' + _settings.chatModel
                    : '';
                modelSelect.value = modelVal;
                // 回填值在下拉选项中不存在（provider/model 已删除或重命名）时，
                // 赋值静默失败——UI 显示空白但旧值仍生效，用户无从得知实际模型。
                // 追加带「已失效」标注的禁用项回显旧值，可见、可主动换选
                if (modelSelect.value !== modelVal) {
                    var staleOpt = document.createElement('option');
                    staleOpt.value = modelVal;
                    staleOpt.textContent = (_settings.chatModel || modelVal) + AEI18n.t('（已失效，请重新选择）');
                    staleOpt.disabled = true;
                    modelSelect.appendChild(staleOpt);
                    modelSelect.value = modelVal;
                }
            }

            // 对话超时回填（与事件绑定的 clamp 一致）
            var timeoutInput = _modalEl.querySelector('#petSettingTimeout');
            if (timeoutInput) {
                var t = (typeof _settings.chatTimeoutMs === 'number' && _settings.chatTimeoutMs >= 30000 && _settings.chatTimeoutMs <= 600000) ? _settings.chatTimeoutMs : 120000;
                timeoutInput.value = t;
            }

            var minInput = _modalEl.querySelector('#petSettingIntervalMin');
            var maxInput = _modalEl.querySelector('#petSettingIntervalMax');
            var intervalValue = _modalEl.querySelector('#petIntervalValue');
            var intervalMinLabel = _modalEl.querySelector('#petIntervalMinValue');
            var intervalMaxLabel = _modalEl.querySelector('#petIntervalMaxValue');
            var lo = _settings.announceInterval ? _settings.announceInterval.min : 30;
            var hi = _settings.announceInterval ? _settings.announceInterval.max : 300;
            if (hi < lo) hi = lo;
            if (minInput) minInput.value = lo;
            if (maxInput) maxInput.value = hi;
            if (intervalValue) intervalValue.textContent = lo + '-' + hi + 's';
            if (intervalMinLabel) intervalMinLabel.textContent = lo + 's';
            if (intervalMaxLabel) intervalMaxLabel.textContent = hi + 's';

            var searchInput = _modalEl.querySelector('#petSettingSearch');
            if (searchInput) searchInput.checked = _settings.webSearchEnabled;

            // 主动回复开关和间隔
            var autoReplyInput = _modalEl.querySelector('#petSettingAutoReply');
            if (autoReplyInput) {
                autoReplyInput.checked = _settings.autoReply ? _settings.autoReply.enabled : true;
            }
            var autoReplyIntervalInput = _modalEl.querySelector('#petSettingAutoReplyInterval');
            var autoReplyValueEl = _modalEl.querySelector('#petAutoReplyValue');
            var autoReplyIntervalLabel = _modalEl.querySelector('#petAutoReplyIntervalValue');
            var arSec = _settings.autoReply ? _settings.autoReply.intervalSec : 900;
            var arMin = Math.max(1, Math.round(arSec / 60));
            if (autoReplyIntervalInput) autoReplyIntervalInput.value = arMin;
            if (autoReplyValueEl) autoReplyValueEl.textContent = arMin + 'min';
            if (autoReplyIntervalLabel) autoReplyIntervalLabel.textContent = arMin + 'min';

            // 桌宠大小
            var petSizeInput = _modalEl.querySelector('#petSettingSize');
            var petSizeValueEl = _modalEl.querySelector('#petSizeValue');
            var petSizeRangeLabel = _modalEl.querySelector('#petSizeRangeValue');
            var petSz = (typeof _settings.petSize === 'number' && _settings.petSize >= 80 && _settings.petSize <= 320) ? _settings.petSize : 160;
            if (petSizeInput) petSizeInput.value = petSz;
            if (petSizeValueEl) petSizeValueEl.textContent = petSz + 'px';
            if (petSizeRangeLabel) petSizeRangeLabel.textContent = petSz + 'px';

            // 活动区域状态文本
            var statusEl = _modalEl.querySelector('#petZoneStatus');
            if (statusEl) {
                var b = _settings.activityBounds;
                if (!b) {
                    statusEl.textContent = AEI18n.t('未设置（整面板）');
                    statusEl.classList.add('is-empty');
                } else {
                    statusEl.textContent = Math.round(b.w) + ' × ' + Math.round(b.h) + ' px';
                    statusEl.classList.remove('is-empty');
                }
            }
        }

        function closeModal() {
            if (!_modalEl) return;
            _modalEl.classList.remove('open');
            _modalEl.classList.add('hidden');
        }

        function destroy() {
            // flush 500ms 防抖窗口内未落盘的修改，再清理定时器（对齐 petHistory.destroy 模式）
            // flush 优先同步写；读失败态下拒绝覆盖写（_persist 内判据）
            flush();
            if (_modalEl && _modalEl.parentNode) {
                _modalEl.parentNode.removeChild(_modalEl);
            }
            _modalEl = null;
        }

        return {
            init: init,
            whenReady: whenReady,
            getSettings: getSettings,
            updateSettings: updateSettings,
            openModal: openModal,
            closeModal: closeModal,
            flush: flush,
            destroy: destroy
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createSettings = createSettings;
    global.AEDeepseekPet.settings = null;
})(window);
