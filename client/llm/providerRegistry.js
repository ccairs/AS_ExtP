(function (global) {
    'use strict';

    var _isLoaded = false;
    var _loadError = null;
    var _userConfig = {};
    var _providers = [];
    var _builtinIds = {};
    var _builtins = [];

    function getProviderFilePath() {
        if (!global.AEShared || !global.AEShared.getDataDir) {
            return null;
        }
        var dataDir = global.AEShared.getDataDir();
        if (!dataDir || !dataDir.dir) {
            return null;
        }
        return dataDir.dir.replace(/\\/g, '/') + '/llm-providers/providers.json';
    }

    function getProviderDirPath() {
        if (!global.AEShared || !global.AEShared.getDataDir) {
            return null;
        }
        var dataDir = global.AEShared.getDataDir();
        if (!dataDir || !dataDir.dir) {
            return null;
        }
        return dataDir.dir.replace(/\\/g, '/') + '/llm-providers';
    }

    function sanitizeId(id) {
        if (!id) return '';
        var clean = String(id).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        return clean;
    }

    // ── providers.json 原子写助手（对齐 nodegenStore.js 的 .tmp → rename 模式）──
    // 先写 <file>.tmp 再 rename 到正式名，写盘窗口内进程中断不再留下半截 JSON；
    // rename 通道对已存在的目标文件可能失败（Bridge 的 fs.renameSync 可覆盖，
    // ExtendScript File.rename 回退不能），此时删旧文件后重试一次，把"无文件
    // 窗口"压到最小。renameFile 不可用（极端降级环境/仅 mock writeFile 的旧测试）
    // 时回退直写。
    // .tmp 路径固定，两个 save 并发交错仍会内存/磁盘漂移——
    // 当前全部运行期写入方（model-manager controller 的 saveUserConfig 各操作 +
    // setProviderSelectedModel）均挂 controller._serializeConfigOp 单队列串行，
    // loadUserProviders 的首次写仅在启动 init 触发一次、无并发窗口。纪律断言：
    // 新增 saveUserProviders 调用方必须进同一队列，否则此处交错防护即告失守。
    function atomicWriteProvidersFile(filePath, content) {
        if (typeof AEFS.renameFile !== 'function') return AEFS.writeFile(filePath, content);
        var tmpPath = filePath + '.tmp';
        // （姊妹位，与 skill-manager/comfyui 同族收口）：rename
        // 失败后的重试不再「删旧正式文件」——旧文件先挪 .recovery-<ts> 旁路，
        // rename 成功才删旁路；仍失败则两份内容都留在盘上。「删旧 +
        // rename 失败/异常 + catch 清 tmp」会把新旧内容一同销毁（两份同毁，
        // providers.json 全部自定义平台/模型覆盖/禁用列表不可恢复丢失）。
        var _inRetry = false;   // 重试阶段 tmp 可能成为新内容唯一副本，兜底不得清理
        var _recoverySeq = 0;
        function _nextRecoveryPath() {
            _recoverySeq = (_recoverySeq + 1) % 1000000000;
            return filePath + '.recovery-' + Date.now() + '-' + _recoverySeq;
        }
        function _cleanupTmp() {
            try { if (AEFS.deleteFile) AEFS.deleteFile(tmpPath).catch(function () {}); } catch (_) {}
        }
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
                // rename 失败先复核 tmp 仍在——并发写交错时（前一次写的 rename 恰在
                // 本调用 write 之后消费了同名 tmp），失败原因是 tmp 缺失而非目标已存在，
                // 此时删掉正式文件会毁掉并发者刚落位的好数据
                var recheck = (typeof AEFS.exists === 'function')
                    ? AEFS.exists(tmpPath) : Promise.resolve(true);
                return recheck.then(function (tmpAlive) {
                    if (!tmpAlive) return false;
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
                        });
                    });
                });
            });
        }).catch(function () {
            if (!_inRetry) _cleanupTmp();   // 重试阶段 tmp 是唯一副本，绝不清理
            return false;
        });
    }

    // ── providers.json 损坏备份助手（读失败但文件存在 / JSON.parse 失败共用）──
    // 原件改名备份（providers.json.corrupt-<时间戳>）保留可恢复数据——否则空态后
    // 用户保存把空配置写回原路径，原件被覆盖后不可恢复。备份名带时间戳保证唯一；
    // 备份失败仅告警，空态流程不因之中断（renameFile 不可用的降级环境跳过备份）。
    function _backupCorruptProvidersFile(filePath, reason) {
        if (typeof AEFS.renameFile !== 'function') return;
        var corruptBakPath = filePath + '.corrupt-' + Date.now();
        AEFS.renameFile(filePath, corruptBakPath).then(function () {
            console.warn('[LLM Providers] providers.json ' + reason + '，损坏文件已备份到: ' + corruptBakPath);
        }).catch(function (e) {
            console.warn('[LLM Providers] providers.json ' + reason + '，损坏文件备份失败: ' + e);
        });
    }

    // ── baseUrl 安全策略（http:// 明文外发 API Key）──
    // https:// 一律放行；http:// 仅放行 loopback/私网地址（本机 Ollama、内网 NAS 等），
    // 公网 http:// 及其他 scheme（javascript:/file:/ftp: 等）一律拒绝。
    // 解析不依赖 window.URL，保证 CEP / Node 测试环境行为一致。
    function parseUrlParts(url) {
        var u = String(url || '').trim();
        var schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
        if (!schemeMatch) return { scheme: '', host: '' };
        var scheme = schemeMatch[1].toLowerCase();
        var rest = u.slice(schemeMatch[0].length);
        if (rest.indexOf('//') !== 0) return { scheme: scheme, host: '' };
        rest = rest.slice(2);
        var authority = rest.split(/[/?#]/)[0];
        var atIdx = authority.lastIndexOf('@');
        if (atIdx >= 0) authority = authority.slice(atIdx + 1);
        var host = authority;
        if (authority.charAt(0) === '[') {
            var endIdx = authority.indexOf(']');
            host = endIdx >= 0 ? authority.slice(1, endIdx) : authority;
        } else if (authority.split(':').length - 1 > 1) {
            // 裸 IPv6（多于一个冒号则不可能携带端口，整段视为 host）
            host = authority;
        } else {
            var colonIdx = authority.indexOf(':');
            if (colonIdx >= 0) host = authority.slice(0, colonIdx);
        }
        return { scheme: scheme, host: host.toLowerCase() };
    }

    // 内网/本机判定：纯 IPv4 按段（127/8、10/8、172.16/12、192.168/16），
    // 主机名仅放行 localhost 与 .local/.lan/.internal 后缀，其余一律视为公网。
    function isPrivateOrLocalHost(host) {
        if (!host) return false;
        host = String(host).toLowerCase().replace(/^\[|\]$/g, '');
        if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
        if (/\.(local|lan|internal)$/.test(host)) return true;
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
            var seg = host.split('.').map(function (s) { return parseInt(s, 10); });
            for (var i = 0; i < 4; i++) {
                if (seg[i] > 255) return false;
            }
            if (seg[0] === 127) return true;                        // 127.0.0.0/8 loopback
            if (seg[0] === 10) return true;                         // 10.0.0.0/8 私网
            if (seg[0] === 172 && seg[1] >= 16 && seg[1] <= 31) return true; // 172.16.0.0/12 私网
            if (seg[0] === 192 && seg[1] === 168) return true;      // 192.168.0.0/16 私网
            return false;
        }
        return false;
    }

    function isSecureProviderUrl(url) {
        var parts = parseUrlParts(url);
        if (parts.scheme === 'https') return true;
        if (parts.scheme === 'http') return isPrivateOrLocalHost(parts.host);
        return false;
    }

    // 公网 http:// 单独判定：存量条目/ComfyUI 等场景仅告警不阻断时用。
    function isPublicHttpUrl(url) {
        var parts = parseUrlParts(url);
        return parts.scheme === 'http' && !isPrivateOrLocalHost(parts.host);
    }

    // endpoint 安全校验：只允许以 / 开头的相对路径片段，禁止协议、@、?、#、空白。
    // 防止 baseUrl 为空或拼接时把 endpoint 当作完整 URL 请求（API Key 外发风险）。
    function isSafeEndpoint(endpoint) {
        if (!endpoint) return true; // 空 endpoint = 使用协议默认路径
        var ep = String(endpoint);
        if (ep.charAt(0) !== '/') return false;
        if (/\s/.test(ep)) return false;
        if (ep.indexOf('://') >= 0) return false;
        if (ep.indexOf('@') >= 0) return false;
        if (ep.indexOf('?') >= 0) return false;
        if (ep.indexOf('#') >= 0) return false;
        return true;
    }

    function getDefaultCapabilities() {
        return {
            vision: false,
            video: false,
            jsonMode: false,
            tools: true,
            stream: true,
            // 思考：该模型会产出思考内容（reasoning）。默认 false——只在明确声明时
            // 才武装「多轮工具调用的思考回传」保护（见 controller 的 setReasoningReplay
            // 与 supportsThinking）。
            thinking: false
        };
    }

    function mergeCapabilities(cap) {
        var def = getDefaultCapabilities();
        if (!cap) return def;
        return {
            vision: cap.vision === true,
            video: cap.video === true,
            jsonMode: cap.jsonMode === true,
            tools: cap.tools !== false,
            stream: cap.stream !== false,
            thinking: cap.thinking === true
        };
    }

    // 模型级「思考模式」意图（存于 model.thinking，随模型条目落盘）：
    // off=不额外发参数（走平台/模型默认） / on=按内置映射发开启参数 /
    // custom=用户手填（逃生舱，覆盖未收录平台）。存意图而非拼好的参数：改映射不动用户数据。
    // 之所以按模型而非按平台存：参数形状确实因模型而异（如 Kimi k3 恒开不吃 thinking.type，
    // k2.6 才吃），而请求时本来就拿得到模型名。
    var THINKING_MODES = ['off', 'on', 'custom'];
    function normalizeThinking(t) {
        var mode = (t && typeof t.mode === 'string' && THINKING_MODES.indexOf(t.mode) >= 0) ? t.mode : 'off';
        var custom = {};
        if (t && t.custom && typeof t.custom === 'object' && !Array.isArray(t.custom)) {
            try { custom = JSON.parse(JSON.stringify(t.custom)); } catch (_) { custom = {}; }
        }
        return { mode: mode, custom: custom };
    }

    function normalizeProvider(provider) {
        if (!provider) return null;
        var p = JSON.parse(JSON.stringify(provider));
        p.id = sanitizeId(p.id);
        p.label = String(p.label || p.id);
        p.builtin = p.builtin === true;
        p.enabled = p.enabled !== false;
        p.protocol = String(p.protocol || 'openai-compatible');
        p.baseUrl = String(p.baseUrl || '');
        p.endpoint = String(p.endpoint || '');
        p.apiKeyField = String(p.apiKeyField || 'customApiKey');
        p.auth = p.auth || { type: 'bearer' };
        p.headers = p.headers || {};
        p.defaults = p.defaults || {};
        p.requestOptions = p.requestOptions || {};
        p.modelDiscovery = p.modelDiscovery || { enabled: false };
        if (Array.isArray(p.models)) {
                // models 含非对象元素（null/字符串/数字，手工编辑/旧数据）
                // 时 p.models[i].capabilities 抛 TypeError → _rebuildProviders 在
                // loadUserProviders 的 then 体内炸出。非法元素剔除（留在数组里会在
                // 下游模型列表渲染/路由二次崩溃），合法元素照常合并能力
                p.models = p.models.filter(function (m) { return !!m && typeof m === 'object'; });
                for (var i = 0; i < p.models.length; i++) {
                    p.models[i].capabilities = mergeCapabilities(p.models[i].capabilities);
                    p.models[i].thinking = normalizeThinking(p.models[i].thinking);
                }
            } else {
                p.models = [];
            }
        return p;
    }

    function validateProvider(provider, isCustom) {
        var errors = [];
        if (!provider) {
            errors.push('Provider is null');
            return errors;
        }
        if (!provider.id) {
            errors.push('Provider id is required');
            return errors;
        }
        if (provider.id !== sanitizeId(provider.id)) {
            errors.push('Provider id must contain only lowercase letters, numbers, underscore, hyphen');
        }
        if (!provider.label) {
            errors.push('Provider label is required');
        }
        if (!provider.baseUrl) {
            errors.push('Provider baseUrl is required');
        } else if (!isSecureProviderUrl(provider.baseUrl)) {
            if (isPublicHttpUrl(provider.baseUrl)) {
                errors.push('公网 http:// 会以明文传输 API Key，已拒绝；请改用 https:// 或本机/内网地址（如 127.0.0.1、192.168.x.x）');
            } else {
                errors.push('Provider baseUrl must be https://，或本机/内网 http:// 地址');
            }
        }
        if (!provider.protocol) {
            errors.push('Provider protocol is required');
        }
        if (isCustom && _builtinIds[provider.id]) {
            errors.push('Provider id conflicts with built-in provider: ' + provider.id);
        }
        return errors;
    }

    function _rebuildProviders() {
        _builtinIds = {};
        for (var i = 0; i < _builtins.length; i++) {
            _builtinIds[_builtins[i].id] = true;
        }
        var result = [];
        var disabledMap = {};
        var disabledList = Array.isArray(_userConfig.disabledBuiltins) ? _userConfig.disabledBuiltins : [];
        for (var d = 0; d < disabledList.length; d++) {
            disabledMap[disabledList[d]] = true;
        }
        var deletedModelMapByProvider = {};
        if (_userConfig.builtinDeletedModels && typeof _userConfig.builtinDeletedModels === 'object') {
            for (var delProviderId in _userConfig.builtinDeletedModels) {
                if (Object.prototype.hasOwnProperty.call(_userConfig.builtinDeletedModels, delProviderId)) {
                    deletedModelMapByProvider[delProviderId] = {};
                    var deletedModels = Array.isArray(_userConfig.builtinDeletedModels[delProviderId]) ? _userConfig.builtinDeletedModels[delProviderId] : [];
                    for (var dm = 0; dm < deletedModels.length; dm++) {
                        deletedModelMapByProvider[delProviderId][deletedModels[dm]] = true;
                    }
                }
            }
        }
        for (var j = 0; j < _builtins.length; j++) {
            var np = normalizeProvider(_builtins[j]);
            if (np) {
                var modelMap = {};
                for (var bm = 0; bm < np.models.length; bm++) modelMap[np.models[bm].id] = np.models[bm];
                if (_userConfig.builtinModelOverrides && Array.isArray(_userConfig.builtinModelOverrides[np.id])) {
                    for (var om = 0; om < _userConfig.builtinModelOverrides[np.id].length; om++) {
                        var overrideModel = _userConfig.builtinModelOverrides[np.id][om];
                        if (overrideModel && overrideModel.id) {
                            // 覆盖模型能力与内置预设做「并集合并」：override 只覆盖它显式声明的字段，
                            // 未声明的能力（如 video）继承内置预设的标记。
                            var presetModel = modelMap[overrideModel.id];
                            if (presetModel && presetModel.capabilities && overrideModel.capabilities) {
                                var mergedCap = {};
                                for (var k in presetModel.capabilities) {
                                    if (Object.prototype.hasOwnProperty.call(presetModel.capabilities, k)) mergedCap[k] = presetModel.capabilities[k];
                                }
                                for (var k2 in overrideModel.capabilities) {
                                    if (Object.prototype.hasOwnProperty.call(overrideModel.capabilities, k2)) mergedCap[k2] = overrideModel.capabilities[k2];
                                }
                                overrideModel = JSON.parse(JSON.stringify(overrideModel));
                                overrideModel.capabilities = mergedCap;
                            }
                            // 思考模式意图同款并集：override 未显式声明时继承预设——覆盖条目是
                            // 「整体替换」语义，用户只要改过该模型任一能力就会丢掉预设的思考开关
                            if (presetModel && presetModel.thinking && !overrideModel.thinking) {
                                overrideModel = JSON.parse(JSON.stringify(overrideModel));
                                overrideModel.thinking = presetModel.thinking;
                            }
                            modelMap[overrideModel.id] = overrideModel;
                        }
                    }
                }
                var deletedModelMap = deletedModelMapByProvider[np.id] || {};
                var mergedModels = [];
                for (var mid in modelMap) {
                    if (Object.prototype.hasOwnProperty.call(modelMap, mid) && !deletedModelMap[mid]) mergedModels.push(modelMap[mid]);
                }
                np.models = mergedModels;
                if (disabledMap[np.id]) np.enabled = false;
                result.push(np);
            }
        }
        if (_userConfig.customProviders) {
            for (var k = 0; k < _userConfig.customProviders.length; k++) {
                var cp = normalizeProvider(_userConfig.customProviders[k]);
                if (!cp) continue;
                // 加载时同样强制 baseUrl 安全策略：providers.json 可能不是由当前保存路径写入的，
                // 保存时的过滤无法覆盖这类存量数据（公网 http 明文外发 API Key 风险）
                if (!isSecureProviderUrl(cp.baseUrl)) {
                    console.warn('[LLM Providers] 加载时已跳过不安全的 custom provider（baseUrl）: ' + cp.id + ' -> ' + cp.baseUrl);
                    continue;
                }
                if (!isSafeEndpoint(cp.endpoint)) {
                    console.warn('[LLM Providers] 加载时已跳过 endpoint 非法的 custom provider: ' + cp.id + ' -> ' + cp.endpoint);
                    continue;
                }
                cp.builtin = false;
                result.push(cp);
            }
        }
        _providers = result;
    }

    function init(builtins) {
        _builtins = JSON.parse(JSON.stringify(builtins || []));
        if (_isLoaded) return Promise.resolve({ ok: true });
        return loadUserProviders().then(function () {
            _isLoaded = true;
            return { ok: true };
        });
    }

    function loadUserProviders() {
        _loadError = null;
        _userConfig = { customProviders: [], builtinSelectedModels: {}, builtinModelOverrides: {}, builtinDeletedModels: {}, disabledBuiltins: [] };
        var filePath = getProviderFilePath();
        var dirPath = getProviderDirPath();
        if (!filePath || !dirPath) {
            _rebuildProviders();
            return Promise.resolve({ ok: true, empty: true });
        }
        return AEFS.mkdir(dirPath).then(function () {
            return AEFS.readFile(filePath).then(function (content) {
                if (!content) {
                    // AEFS.readFile 通道故障（Bridge 5xx → cep.fs 回退 → 再失败，
                    // 如文件被杀毒瞬时锁定）同样返 null，与「文件不存在」无法区分。
                    // 直接按首次启动写空配置会把用户既有配置覆盖成空（不可恢复丢失）。
                    // 先存在性复核（对齐 memoryStore._updateIndexEntry 的区分模式）：
                    // 文件存在按损坏处理（备份+告警，绝不回写空配置），不存在才写默认；
                    // 复核通道不可用时无法排除文件存在，同样按存在处理（宁可不写）。
                    // 复核从 exists（折叠布尔）升级为 existsResult 三态
                    //（对齐 dataDir 的范式）——折叠布尔把 null 的三种成因
                    //（不存在/通道失败/4xx 拒绝）折叠，全通道故障窗口会把既有
                    // providers.json 判「不存在」并写入空配置（customProviders/
                    // builtinModelOverrides/disabledBuiltins 全丢，且该分支无
                    // .corrupt 备份）。NOT_FOUND（真不存在）→ 写默认；ok=true
                    //（文件在场但读不出=通道失败）及其余失败态（CHANNEL_FAILURE/
                    // REJECTED）→ 绝不回写，走下方既有损坏/备份路径。旧 mock 无
                    // existsResult 时保持旧 exists 折叠布尔判定（逐分支等价）
                    var existsCheck = (typeof AEFS.existsResult === 'function')
                        ? AEFS.existsResult(filePath)
                        : (typeof AEFS.exists === 'function')
                            ? AEFS.exists(filePath).then(function (b) {
                                return b ? { ok: true } : { ok: false, error: { code: 'NOT_FOUND' } };
                            })
                            : Promise.resolve({ ok: true });
                    return existsCheck.then(function (probe) {
                        var fileExists = !!(probe && (probe.ok === true
                            || (probe.ok === false && probe.error && probe.error.code !== 'NOT_FOUND')));
                        if (!fileExists) {
                            _rebuildProviders();
                            // 首次启动文件不存在，顺手写空配置 JSON，避免下次启动 cep.fs readFile 报 err=3
                            console.log('[LLM Providers] providers.json 不存在，已创建默认空配置');
                            AEFS.writeFile(filePath, JSON.stringify(_userConfig, null, 2));
                            return { ok: true, empty: true };
                        }
                        // 读失败但文件存在：与 parse 失败同款损坏语义——备份原件后空态，
                        // 绝不把空配置写回原路径（customProviders 等全部保留在备份中可恢复）
                        _loadError = 'read failed: file exists but content unreadable';
                        console.warn('[LLM Providers] providers.json 读取失败（文件存在，疑似通道故障），按损坏处理: ' + filePath);
                        _backupCorruptProvidersFile(filePath, '读取失败');
                        _userConfig = { customProviders: [], builtinSelectedModels: {}, builtinModelOverrides: {}, builtinDeletedModels: {}, disabledBuiltins: [] };
                        _rebuildProviders();
                        return { ok: true, error: _loadError };
                    });
                }
                try {
                    _userConfig = JSON.parse(content);
                    if (!Array.isArray(_userConfig.customProviders)) {
                        _userConfig.customProviders = [];
                    }
                    if (typeof _userConfig.builtinSelectedModels !== 'object' || _userConfig.builtinSelectedModels === null) {
                        _userConfig.builtinSelectedModels = {};
                    }
                    if (typeof _userConfig.builtinModelOverrides !== 'object' || _userConfig.builtinModelOverrides === null) {
                        _userConfig.builtinModelOverrides = {};
                    }
                    if (typeof _userConfig.builtinDeletedModels !== 'object' || _userConfig.builtinDeletedModels === null) {
                        _userConfig.builtinDeletedModels = {};
                    }
                    if (!Array.isArray(_userConfig.disabledBuiltins)) {
                        _userConfig.disabledBuiltins = [];
                    }
                } catch (parseErr) {
                    _loadError = 'JSON parse failed: ' + String(parseErr);
                    // 损坏文件先改名备份（providers.json.corrupt-<时间戳>）再重置空配置
                    // ——否则用户后续保存把空配置写回原路径，损坏原件被覆盖后不可恢复
                    _backupCorruptProvidersFile(filePath, '解析失败');
                    _userConfig = { customProviders: [], builtinSelectedModels: {}, builtinModelOverrides: {}, builtinDeletedModels: {}, disabledBuiltins: [] };
                }
                // 第三种损坏形态（JSON 合法但结构异常，_rebuildProviders
                // 抛错）若落入外层 read failed catch——空态但不备份，用户任意一次
                // 保存把空配置写回、自定义平台全部不可恢复丢失。与 parse 失败同款
                // 处置：备份原件 + 空态 + _loadError 记录（normalizeProvider 已加
                // models 元素类型防御，此处兜底其余形态的结构异常）
                try {
                    _rebuildProviders();
                } catch (structErr) {
                    _loadError = 'structure invalid: ' + String(structErr);
                    console.warn('[LLM Providers] providers.json 结构异常，按损坏处理（已备份）: ' + filePath);
                    _backupCorruptProvidersFile(filePath, '结构异常');
                    _userConfig = { customProviders: [], builtinSelectedModels: {}, builtinModelOverrides: {}, builtinDeletedModels: {}, disabledBuiltins: [] };
                    _rebuildProviders();
                }
                return { ok: true, error: _loadError };
            }).catch(function (readErr) {
                _loadError = 'read failed: ' + String(readErr);
                _userConfig = { customProviders: [], builtinSelectedModels: {}, builtinModelOverrides: {}, builtinDeletedModels: {}, disabledBuiltins: [] };
                _rebuildProviders();
                return { ok: true, error: _loadError };
            });
        }).catch(function (e) {
            _loadError = 'mkdir or read failed: ' + String(e);
            _userConfig = { customProviders: [], builtinSelectedModels: {}, builtinModelOverrides: {}, builtinDeletedModels: {}, disabledBuiltins: [] };
            _rebuildProviders();
            return Promise.resolve({ ok: true, error: _loadError });
        });
    }

    function saveUserProviders(config) {
        var filePath = getProviderFilePath();
        var dirPath = getProviderDirPath();
        if (!filePath || !dirPath) {
            return Promise.resolve({ ok: false, error: 'data dir not available' });
        }
        var saveConfig = { customProviders: [], builtinSelectedModels: {}, builtinModelOverrides: {}, builtinDeletedModels: {}, disabledBuiltins: [] };
        if (config && Array.isArray(config.customProviders)) {
            for (var i = 0; i < config.customProviders.length; i++) {
                var cp = JSON.parse(JSON.stringify(config.customProviders[i]));
                // 落盘前强制校验 baseUrl：任何调用方（含 updateCustomProvider 直写路径）
                // 都无法把公网 http:// 或非 http(s) scheme 的条目写进 providers.json。
                if (!isSecureProviderUrl(cp && cp.baseUrl)) {
                    console.warn('[LLM Providers] 已拒绝保存不安全的 baseUrl（公网 http 或非 http(s) scheme），条目不写入: ' +
                        (cp && cp.id) + ' -> ' + (cp && cp.baseUrl));
                    continue;
                }
                // endpoint 与加载侧同款校验（_rebuildProviders 会用 isSafeEndpoint 拒绝并跳过）：
                // 保存时不同步拦截会形成"保存成功、重启后被静默跳过"的不一致
                if (!isSafeEndpoint(cp && cp.endpoint)) {
                    console.warn('[LLM Providers] 已拒绝保存不安全的 endpoint（须以 / 开头，禁止 ://、@、?、#、空白），条目不写入: ' +
                        (cp && cp.id) + ' -> ' + (cp && cp.endpoint));
                    continue;
                }
                saveConfig.customProviders.push(cp);
            }
        }
        if (config && typeof config.builtinSelectedModels === 'object' && config.builtinSelectedModels !== null) {
            saveConfig.builtinSelectedModels = JSON.parse(JSON.stringify(config.builtinSelectedModels));
        }
        if (config && typeof config.builtinModelOverrides === 'object' && config.builtinModelOverrides !== null) {
            saveConfig.builtinModelOverrides = JSON.parse(JSON.stringify(config.builtinModelOverrides));
        }
        if (config && typeof config.builtinDeletedModels === 'object' && config.builtinDeletedModels !== null) {
            saveConfig.builtinDeletedModels = JSON.parse(JSON.stringify(config.builtinDeletedModels));
        }
        if (config && Array.isArray(config.disabledBuiltins)) {
            saveConfig.disabledBuiltins = config.disabledBuiltins.slice(0);
        }
        var content = JSON.stringify(saveConfig, null, 2);
        return AEFS.mkdir(dirPath).then(function () {
            // 原子写（.tmp → rename）——直写在中断时留半截 JSON，重启后 parse
            // 失败又静默重置空配置，用户全部自定义 provider 一次丢失
            return atomicWriteProvidersFile(filePath, content).then(function (ok) {
                if (ok) {
                    _userConfig = saveConfig;
                    _rebuildProviders();
                    return { ok: true };
                }
                return { ok: false, error: 'write failed' };
            }).catch(function (e) {
                return { ok: false, error: String(e) };
            });
        }).catch(function (e) {
            return { ok: false, error: 'mkdir failed: ' + String(e) };
        });
    }

    function getLoadError() {
        return _loadError;
    }

    function isLoaded() {
        return _isLoaded;
    }

    function getUserConfig() {
        return JSON.parse(JSON.stringify(_userConfig));
    }

    function listProviders() {
        return JSON.parse(JSON.stringify(_providers));
    }

    function getProvider(id) {
        for (var i = 0; i < _providers.length; i++) {
            if (_providers[i].id === id) {
                return JSON.parse(JSON.stringify(_providers[i]));
            }
        }
        return null;
    }

    function listModels(providerId) {
        var p = getProvider(providerId);
        if (!p || !p.models) return [];
        return JSON.parse(JSON.stringify(p.models));
    }

    function getModel(providerId, modelId) {
        var p = getProvider(providerId);
        if (!p || !p.models) return null;
        for (var i = 0; i < p.models.length; i++) {
            if (p.models[i].id === modelId) {
                return JSON.parse(JSON.stringify(p.models[i]));
            }
        }
        return null;
    }

    function getApiKeyField(providerId) {
        var p = getProvider(providerId);
        return p ? p.apiKeyField : null;
    }

    function getSensitiveFields(providerId) {
        var fields = ['apiKey'];
        // Collect all apiKeyField values from registered providers
        for (var i = 0; i < _providers.length; i++) {
            if (_providers[i].apiKeyField) {
                fields.push(_providers[i].apiKeyField);
            }
        }
        // Deduplicate by creating a map then converting back to array
        var unique = {};
        for (var j = 0; j < fields.length; j++) {
            unique[fields[j]] = true;
        }
        var result = [];
        for (var key in unique) {
            if (unique.hasOwnProperty(key)) {
                result.push(key);
            }
        }
        return result;
    }

    function getCapabilities(providerId, modelId) {
        var m = getModel(providerId, modelId);
        if (m && m.capabilities) {
            return JSON.parse(JSON.stringify(m.capabilities));
        }
        return getDefaultCapabilities();
    }

    function supportsVision(providerId, modelId) {
        return getCapabilities(providerId, modelId).vision === true;
    }

    function supportsVideo(providerId, modelId) {
        return getCapabilities(providerId, modelId).video === true;
    }

    function supportsJsonMode(providerId, modelId) {
        return getCapabilities(providerId, modelId).jsonMode === true;
    }

    function supportsTools(providerId, modelId) {
        return getCapabilities(providerId, modelId).tools === true;
    }

    function supportsStream(providerId, modelId) {
        return getCapabilities(providerId, modelId).stream === true;
    }

    // 该模型会产出思考内容（模型级能力位，非请求开关）。消费点：Agent 的
    // setReasoningReplay 判定——带 tool_calls 但思考为空的轮次需补空 reasoning_content
    // 字段（thinking + tools 协议要求，缺字段直接 400）。是否真的开启思考由供应商配置
    // 决定（如 DeepSeek 预设的 requestOptions.extraBody.thinking），本开关只做本地声明，
    // 只加不减：它不产生请求体字段，也不会解除供应商侧已开的思考。
    function supportsThinking(providerId, modelId) {
        return getCapabilities(providerId, modelId).thinking === true;
    }

    // 模型级「思考模式」意图（off/on/custom，见 normalizeThinking）——决定请求时是否
    // 发送平台原生思考参数（映射表在 protocolAdapters），也参与回传保护判定。
    function getModelThinking(providerId, modelId) {
        var m = getModel(providerId, modelId);
        var t = m && m.thinking;
        if (t && typeof t === 'object') {
            return normalizeThinking(t);
        }
        return normalizeThinking(null);
    }

    function getProviderSelectedModel(providerId) {
        var p = getProvider(providerId);
        if (!p) return null;
        if (p.builtin) {
            return _userConfig.builtinSelectedModels[providerId] || null;
        }
        // Find the custom provider in _userConfig to get the selectedModelId
        if (_userConfig.customProviders) {
            for (var i = 0; i < _userConfig.customProviders.length; i++) {
                if (_userConfig.customProviders[i].id === providerId) {
                    return _userConfig.customProviders[i].selectedModelId || null;
                }
            }
        }
        return null;
    }

    function setProviderSelectedModel(providerId, modelId) {
        var p = getProvider(providerId);
        if (!p) return Promise.resolve({ ok: false, error: 'provider not found' });
        if (p.builtin) {
            // 写盘失败时回滚内存：此处先改 _userConfig 快照再落盘，失败不回滚会让
            // UI/后续读取显示新选中（内存），重启后却回退（磁盘旧值）——内存与磁盘漂移
            var prevBuiltin = _userConfig.builtinSelectedModels[providerId];
            _userConfig.builtinSelectedModels[providerId] = modelId;
            return saveUserProviders(_userConfig).then(function (result) {
                if (!result || result.ok === false) {
                    _userConfig.builtinSelectedModels[providerId] = prevBuiltin;
                }
                return result;
            });
        }
        // Update custom provider in _userConfig
        if (_userConfig.customProviders) {
            for (var i = 0; i < _userConfig.customProviders.length; i++) {
                if (_userConfig.customProviders[i].id === providerId) {
                    var target = _userConfig.customProviders[i];
                    var prevCustom = target.selectedModelId;
                    target.selectedModelId = modelId;
                    return saveUserProviders(_userConfig).then(function (result) {
                        if (!result || result.ok === false) {
                            target.selectedModelId = prevCustom;
                        }
                        return result;
                    });
                }
            }
        }
        return Promise.resolve({ ok: false, error: 'custom provider not found in config' });
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.providerRegistry = {
        init: init,
        loadUserProviders: loadUserProviders,
        saveUserProviders: saveUserProviders,
        getLoadError: getLoadError,
        isLoaded: isLoaded,
        getUserConfig: getUserConfig,
        listProviders: listProviders,
        getProvider: getProvider,
        listModels: listModels,
        getModel: getModel,
        getApiKeyField: getApiKeyField,
        getSensitiveFields: getSensitiveFields,
        getCapabilities: getCapabilities,
        supportsVision: supportsVision,
        supportsVideo: supportsVideo,
        supportsJsonMode: supportsJsonMode,
        supportsTools: supportsTools,
        supportsStream: supportsStream,
        supportsThinking: supportsThinking,
        getModelThinking: getModelThinking,
        getProviderSelectedModel: getProviderSelectedModel,
        setProviderSelectedModel: setProviderSelectedModel,
        validateProvider: validateProvider,
        normalizeProvider: normalizeProvider,
        sanitizeId: sanitizeId,
        isSecureProviderUrl: isSecureProviderUrl,
        isPublicHttpUrl: isPublicHttpUrl,
        isPrivateOrLocalHost: isPrivateOrLocalHost,
        isSafeEndpoint: isSafeEndpoint
    };

    global.AE_LLM.getProviderModels = function (providerId) {
        return global.AE_LLM.providerRegistry.listModels(providerId);
    };

    global.AE_LLM.getProviderApiKeyField = function (providerId) {
        return global.AE_LLM.providerRegistry.getApiKeyField(providerId);
    };

    global.AE_LLM.supportsVision = function (modelId, providerId) {
        return global.AE_LLM.providerRegistry.supportsVision(providerId, modelId);
    };

    global.AE_LLM.supportsVideo = function (modelId, providerId) {
        return global.AE_LLM.providerRegistry.supportsVideo(providerId, modelId);
    };

    global.AE_LLM.supportsResponseFormat = function (modelId, providerId) {
        return global.AE_LLM.providerRegistry.supportsJsonMode(providerId, modelId);
    };
})(window);
