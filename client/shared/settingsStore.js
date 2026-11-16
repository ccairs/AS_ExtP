(function (global) {
    const SETTINGS_KEY = 'ae_llm_tool_settings_v3';

    // 与 cryptoStore 的敏感字段判定对齐：优先复用其导出的字段清单
    // （默认清单 + providerRegistry 动态字段）；不可用时退化为通用命名规则
    function isSensitiveFieldName(name) {
        if (global.AEShared && typeof global.AEShared.getSensitiveFields === 'function') {
            return global.AEShared.getSensitiveFields().indexOf(name) !== -1;
        }
        return name === 'apiKey' || /ApiKey$/.test(name);
    }

    // 嵌套容器字段（整块加密，如 mcp-manager.servers）：判定单一来源在 cryptoStore；
    // cryptoStore 整份未加载时（降级写入路径）用兜底清单，避免明文容器被漏剔。
    // 兜底清单须与 cryptoStore.js 的 ENCRYPTED_CONTAINER_FIELDS 保持一致。
    var FALLBACK_ENCRYPTED_CONTAINER_FIELDS = { 'mcp-manager': ['servers'] };
    function isEncryptedContainerField(modId, name) {
        if (global.AEShared && typeof global.AEShared.isEncryptedContainerField === 'function') {
            return global.AEShared.isEncryptedContainerField(modId, name);
        }
        var list = FALLBACK_ENCRYPTED_CONTAINER_FIELDS[modId];
        return !!(list && list.indexOf(name) !== -1);
    }

    // 空容器与空串同义：解密失败置空后，模块消费方可能把空串再换成 {} / []
    function isEmptyContainerValue(v) {
        if (v === '' || v === null || v === undefined) return true;
        if (Array.isArray(v)) return v.length === 0;
        if (typeof v === 'object') return Object.keys(v).length === 0;
        return false;
    }

    // 容器密文的严格形状：v=1 且 value/iv/salt 均为字符串。容器密文都带 salt，
    // 不存在无 salt 的容器记录；而「服务器 id 恰为 v」的明文 servers 也不是密文。
    // 与 cryptoStore.js 的 _isContainerCipher 同形，改动需同步。
    function isCipherContainerShape(v) {
        return !!(v && typeof v === 'object' && !Array.isArray(v)
            && v.v === 1
            && typeof v.value === 'string'
            && typeof v.iv === 'string'
            && typeof v.salt === 'string');
    }

    // 加密层不可用时的降级写入：剔除敏感字段，其余非敏感字段照常落盘
    function stripSensitiveFields(data) {
        var result = JSON.parse(JSON.stringify(data || {}));
        if (result.global && typeof result.global === 'object') {
            Object.keys(result.global).forEach(function (k) {
                if (isSensitiveFieldName(k)) delete result.global[k];
            });
        }
        if (result.modules && typeof result.modules === 'object') {
            Object.keys(result.modules).forEach(function (modId) {
                var mod = result.modules[modId];
                if (mod && typeof mod === 'object') {
                    Object.keys(mod).forEach(function (k) {
                        // 嵌套容器整块是敏感载荷（如 MCP servers 的 env/headers），降级写入同样剔除
                        if (isSensitiveFieldName(k) || isEncryptedContainerField(modId, k)) delete mod[k];
                    });
                }
            });
        }
        return result;
    }

    function createSettingsStore() {
        // 存量明文容器检测：读到非空明文容器（如 mcp-manager.servers）时置真，由调用方
        // 在用当前配置写回一次后清除——只在读路径打标记，不在这里写盘
        //（read 可能处在写操作串行化队列内）。
        var _legacyContainersPending = false;
        function _noteLegacyContainerFields(parsed) {
            if (_legacyContainersPending || !parsed || typeof parsed !== 'object' || !parsed.modules) return;
            if (!global.AEShared || typeof global.AEShared.isEncryptedContainerField !== 'function') return;
            var modIds = Object.keys(parsed.modules);
            for (var i = 0; i < modIds.length; i++) {
                var modId = modIds[i];
                var mod = parsed.modules[modId];
                if (!mod || typeof mod !== 'object') continue;
                var keys = Object.keys(mod);
                for (var k = 0; k < keys.length; k++) {
                    if (!global.AEShared.isEncryptedContainerField(modId, keys[k])) continue;
                    var v = mod[keys[k]];
                    // 非空且不是严格密文形状 = 未加密容器；空容器不算
                    if (v && typeof v === 'object' && !isCipherContainerShape(v) && Object.keys(v).length > 0) {
                        _legacyContainersPending = true;
                        return;
                    }
                }
            }
        }
        // collector（可选）：随调用链传递的解密失败集局部数组——
        // 同一次 read-modify-write 的 read 记录、write 消费同一份数据，
        // 不再依赖 cryptoStore 模块级全局状态（并发读的 decryptSensitive 重置会互清）
        async function readRaw(collector) {
            try {
                var raw = localStorage.getItem(SETTINGS_KEY);
                var parsed = raw ? JSON.parse(raw) : null;
                _noteLegacyContainerFields(parsed);
                if (parsed && global.AEShared && typeof global.AEShared.decryptSensitive === 'function') {
                    parsed = await global.AEShared.decryptSensitive(parsed, collector);
                }
                return parsed;
            } catch (_) {
                return null;
            }
        }

        // 解密失败（指纹漂移）的字段在 read-modify-write 中变成了空字符串，
        // 若照常落盘，原密文会被空值覆盖，密钥永久丢失且无提示。
        // 依据 cryptoStore 记录的最近一次解密失败字段集，写回时从 localStorage 保留原密文对象。
        // 用户重新输入的 Key 为非空字符串（正常加密覆盖）；解密成功的字段不进入该集合，均不受影响。
        // failedFields 可选——调用链显式传入的失败集（readAll 记录的局部数组）优先，
        // 未传时回退模块级 getter（兼容既有调用方/外部直调 write 的路径）。
        function preserveUndecryptableCiphertexts(encryptedOut, failedFields) {
            var failed;
            if (Array.isArray(failedFields)) {
                failed = failedFields;
            } else {
                if (!global.AEShared || typeof global.AEShared.getUndecryptableFields !== 'function') return encryptedOut;
                failed = global.AEShared.getUndecryptableFields();
            }
            if (!failed || failed.length === 0) return encryptedOut;

            var stored = null;
            try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch (_) { stored = null; }
            if (!stored) return encryptedOut;

            for (var i = 0; i < failed.length; i++) {
                var entry = failed[i];
                var newContainer = (entry.scope === 'global') ? encryptedOut.global : (encryptedOut.modules && encryptedOut.modules[entry.modId]);
                var oldContainer = (entry.scope === 'global') ? stored.global : (stored.modules && stored.modules[entry.modId]);
                if (!newContainer || !oldContainer) continue;
                var oldVal = oldContainer[entry.field];
                // 本次写回值为空（解密失败的置空）且磁盘上确有原密文对象时保留。
                // 嵌套容器解密失败后消费方可能把空串换成 {} / []，同样视为已清空。
                var containerField = isEncryptedContainerField(entry.modId, entry.field);
                var wiped = (newContainer[entry.field] === '')
                    || (containerField && isEmptyContainerValue(newContainer[entry.field]));
                var oldCipher = containerField ? isCipherContainerShape(oldVal) : !!(oldVal && typeof oldVal === 'object' && oldVal.v);
                if (wiped && oldCipher) {
                    newContainer[entry.field] = oldVal;
                    console.warn('[settings] 解密失败字段保留原密文（加密指纹漂移，请在设置中重新输入 API Key 后保存）: ' + entry.scope + (entry.modId ? '.' + entry.modId : '') + '.' + entry.field);
                }
            }
            return encryptedOut;
        }

        // 加密层不可用降级写时，保留磁盘上已存的密文对象（{v:...}）。
        // 降级分支若 setItem 整体覆盖，已加密的 API Key 字段被静默抹掉，
        // 用户在加密层恢复前没有任何途径找回（静默数据丢失）。
        function preserveStoredEncryptedFields(sanitized) {
            var stored = null;
            try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch (_) { stored = null; }
            if (!stored || typeof stored !== 'object') return sanitized;
            _mergeEncryptedContainer(sanitized.global, stored.global, null);
            if (sanitized.modules && stored.modules && typeof stored.modules === 'object') {
                var modIds = Object.keys(stored.modules);
                for (var i = 0; i < modIds.length; i++) {
                    var mod = sanitized.modules[modIds[i]];
                    if (mod && typeof mod === 'object') {
                        _mergeEncryptedContainer(mod, stored.modules[modIds[i]], modIds[i]);
                    }
                }
            }
            return sanitized;
        }
        function _mergeEncryptedContainer(target, source, modId) {
            if (!target || !source || typeof target !== 'object' || typeof source !== 'object') return;
            var keys = Object.keys(source);
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (!source[k] || (k in target)) continue;
                var isContainer = isEncryptedContainerField(modId, k);
                if (isContainer) {
                    // 容器整块回填（密文；降级期间磁盘上的存量明文也原样保留——
                    // 重写同一份明文不增加暴露面，删掉反而丢配置）
                    target[k] = source[k];
                } else if (isSensitiveFieldName(k) && typeof source[k] === 'object' && source[k].v) {
                    // 普通敏感字段只回填密文对象；strip 后明文（异常数据）不回填，杜绝明文落盘
                    target[k] = source[k];
                }
            }
        }

        // failedFields（可选）：同一次 read-modify-write 记录的解密失败集，传给 preserve
        // 逻辑；未传时 preserve 回退 cryptoStore 模块级 getter（兼容外部直调）。
        // 整链兜底——localStorage 配额满（QuotaExceededError）/ encryptSensitive
        // 加密异常若不捕获会直接冒泡，set* 经 _serializedWrite 透传 rejection，main.js 保存
        // 回调无 try/catch → unhandled rejection，弹窗不关、无任何提示。改为捕获后
        // 返回 false 让调用方感知失败（保存回调保持弹窗开启 + error toast）。localStorage
        // setItem 本身原子（单键覆盖），失败时磁盘仍是上一次成功写入的完整配置。
        async function writeRaw(payload, failedFields) {
            var normalized = normalize(payload);
            try {
                if (global.AEShared && typeof global.AEShared.encryptSensitive === 'function') {
                    var encrypted = await global.AEShared.encryptSensitive(normalized);
                    encrypted = preserveUndecryptableCiphertexts(encrypted, failedFields);
                    localStorage.setItem(SETTINGS_KEY, JSON.stringify(encrypted));
                } else {
                    // 加密层不可用：剔除敏感字段（API Key 等）后再写，避免明文落盘；
                    // 非敏感字段照常写入，保证设置不整体丢失
                    var sanitized = stripSensitiveFields(normalized);
                    // 磁盘已有密文原样回填（见 preserveStoredEncryptedFields 注释）
                    sanitized = preserveStoredEncryptedFields(sanitized);
                    console.warn('[settings] 加密层不可用，敏感字段未写入（磁盘已有密文原样保留）');
                    localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
                }
                return true;
            } catch (e) {
                console.error('[settings] 写入失败（localStorage 配额满或加密异常）: ' +
                    (e && e.message ? e.message : e));
                return false;
            }
        }

        function createDefaultShape() {
            return {
                global: {
                    siliconflowApiKey: '',
                    openrouterApiKey: '',
                    deepseekApiKey: '',
                    kimiApiKey: '',
                    anthropicApiKey: '',
                    defaultProviderId: 'deepseek',
                    defaultModelId: 'deepseek-v4-pro',
                    // 视觉代理模型：非视觉主模型遇到图片/读图时，后台用此模型转文字描述
                    visionProviderId: '',
                    visionModelId: '',
                    enableDeepseekPet: false,
                    lowPerfMode: false,  // 全局低性能模式：各模块据此降级自身性能开销
                    bgOverlayImage: '',       // 背景叠加层图片路径（数据目录内相对路径）
                    bgOverlayOpacity: 30,     // 透明度 0-100
                    bgOverlayBlendMode: 'normal', // CSS mix-blend-mode 默认值 normal（不做混合）。四处（本处 / main.js GLOBAL_DEFAULTS / applyBgOverlay / UI 回填）保持统一
                    bgOverlayFillMode: 'cover',   // cover/contain/repeat
                    bgOverlayGrayscale: false,    // 黑白滤镜
                    bgOverlayContrast: 100,       // 对比度 0-200（100=不变）
                    bgOverlayOffsetX: 0,          // X轴偏移 -100~100（百分比）
                    bgOverlayOffsetY: 0,          // Y轴偏移 -100~100（百分比）
                    bgOverlayScale: 100         // 缩放 10-400（100=原始大小）
                },
                modules: {}
            };
        }

        function migrateGlobal(globalSettings) {
            if (!globalSettings || typeof globalSettings !== 'object') {
                return {};
            }
            var result = JSON.parse(JSON.stringify(globalSettings));
            // apiKey -> siliconflowApiKey (preserve legacy apiKey for fallback)
            if (result.apiKey && !result.siliconflowApiKey) {
                result.siliconflowApiKey = result.apiKey;
            }
            // defaultPlatform -> defaultProviderId
            if (result.defaultPlatform && !result.defaultProviderId) {
                result.defaultProviderId = result.defaultPlatform;
            }
            // defaultModel -> defaultModelId
            if (result.defaultModel && !result.defaultModelId) {
                result.defaultModelId = result.defaultModel;
            }
            return result;
        }

        function migrateModule(moduleSettings) {
            if (!moduleSettings || typeof moduleSettings !== 'object') {
                return {};
            }
            var result = JSON.parse(JSON.stringify(moduleSettings));
            // platform -> providerId
            if (result.platform && !result.providerId) {
                result.providerId = result.platform;
            }
            // model -> modelId
            if (result.model && !result.modelId) {
                result.modelId = result.model;
            }
            return result;
        }

        function normalize(raw) {
            const base = createDefaultShape();
            if (!raw || typeof raw !== 'object') {
                return base;
            }
            // v3 style data: already has global/modules structure
            if (raw.global || raw.modules) {
                var normalizedGlobal = migrateGlobal(raw.global || {});
                var normalizedModules = {};
                if (raw.modules && typeof raw.modules === 'object') {
                    var moduleIds = Object.keys(raw.modules);
                    for (var i = 0; i < moduleIds.length; i++) {
                        var modId = moduleIds[i];
                        normalizedModules[modId] = migrateModule(raw.modules[modId]);
                    }
                }
                return {
                    global: normalizedGlobal,
                    modules: normalizedModules
                };
            }

            // Legacy flat settings branch
            const migrated = createDefaultShape();
            // Global fields
            migrated.global.siliconflowApiKey = raw.siliconflowApiKey || raw.apiKey || '';
            migrated.global.openrouterApiKey = raw.openrouterApiKey || '';
            migrated.global.deepseekApiKey = raw.deepseekApiKey || '';
            migrated.global.kimiApiKey = raw.kimiApiKey || '';
            migrated.global.anthropicApiKey = raw.anthropicApiKey || '';
            migrated.global.defaultProviderId = raw.defaultPlatform || raw.defaultProviderId || 'deepseek';
            migrated.global.defaultModelId = raw.defaultModel || raw.defaultModelId || 'deepseek-v4-pro';
            var _oldThemes = { emerald: true, sky: true, sunset: true };
            migrated.global.themePreset = (raw.themePreset && !_oldThemes[raw.themePreset]) ? raw.themePreset : 'default';
            migrated.global.debugMode = !!raw.debugMode;
            // Module fields
            migrated.modules['agent'] = {
                providerId: raw.platform || raw.providerId || 'openrouter',
                modelId: raw.model || raw.modelId || 'openai/gpt-6.1-terra',
                customModel: raw.customModel || '',
                skipRunConfirm: !!raw.skipRunConfirm,
                scriptListHeight: raw.scriptListHeight,
                runtimeMode: raw.runtimeMode || 'script',
                executionTimeoutMs: raw.executionTimeoutMs,
                requestTimeoutMs: raw.requestTimeoutMs,
                maxContextTokens: raw.maxContextTokens,
                // 0 = 不超时是合法值：仅"缺省/空串/非有限数"才回落 30000
                //（`|| 30000` 会把 0 挤成 30000；`Number('')`/`Number(null)` 都是 0，须先排掉）
                permissionConfirmTimeoutMs: (function (v) {
                    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return 30000;
                    var n = Number(v);
                    if (!Number.isFinite(n)) return 30000;
                    return Math.max(0, Math.min(300000, n));
                })(raw.permissionConfirmTimeoutMs),
                previewDraft: raw.previewDraft || '',
                userPersona: raw.userPersona || '',
                flowAnimOffsetMs: raw.flowAnimOffsetMs || 0,
                airsAnimOffsetMs: raw.airsAnimOffsetMs || 0
            };
            return migrated;
        }

        async function readAll(collector) {
            return normalize(await readRaw(collector));
        }

        // 导出的裸写入口同样过串行化队列——只包裹 set* 时，
        // 外部直接调 write/writeAll 会绕过队列，与 set* 的读改写交错互相覆盖。
        // set* 内部走 _writeAllDirect（在已持有的队列闭包内直接写，避免重入死锁）。
        // return await 贯穿——writeRaw 的 false（配额满/加密异常）须逐层透传到
        // set* 的返回值，被 await 吞掉会让调用方误判保存成功
        async function _writeAllDirect(payload, failedFields) {
            return await writeRaw(normalize(payload), failedFields);
        }
        // 裸写入口自带局部失败集——writeRaw 未收到 failedFields 时会回退
        // cryptoStore 模块级 _undecryptableFields，而并发的 decryptSensitive（如另一
        // 读路径）开头会把它重置撕开：本次 preserve 依据读到空集 → 密文被空串覆盖、
        // API Key 永久丢失。改为在本串行化闭包内先探测一次存储态（readRaw 带局部
        // collector，与写共用同一份存储快照），不再依赖模块级全局状态。
        async function writeAll(payload) {
            return _serializedWrite(async function () {
                var probe = [];
                await readRaw(probe);
                return _writeAllDirect(payload, probe);
            });
        }
        async function write(payload) {
            return _serializedWrite(async function () {
                var probe = [];
                await readRaw(probe);
                return writeRaw(payload, probe);
            });
        }

        // 写操作串行化：防止 read-modify-write 竞态导致并发写互相覆盖
        var _writeChain = Promise.resolve();
        function _serializedWrite(writeFn) {
            var run = _writeChain.then(writeFn, writeFn);
            // 防止链断裂：吞掉 run 中的错误，由调用方自行处理
            _writeChain = run.catch(function() {});
            return run;
        }

        async function getGlobalSettings(defaults) {
            var all = await readAll();
            return {
                ...(defaults || {}),
                ...(all.global || {})
            };
        }

        async function setGlobalSettings(next) {
            return _serializedWrite(async function() {
                // 闭包持有本次 read-modify-write 的局部失败集——readAll 记录、
                // _writeAllDirect 消费同一份数据，并发 getGlobalSettings 的 decryptSensitive
                // （开头重置模块级数组）不再撕开本次 preserve 依据（密文被空串覆盖、Key 永久丢失）
                var failedFields = [];
                var all = await readAll(failedFields);
                all.global = {
                    ...(all.global || {}),
                    ...(next || {})
                };
                // return await 透传 writeRaw 的写入结果（false = 配额满/加密异常）
                return await _writeAllDirect(all, failedFields);
            });
        }

        async function getModuleSettings(moduleId, defaults) {
            var all = await readAll();
            var modules = all.modules || {};
            var current = (moduleId && modules[moduleId]) ? modules[moduleId] : {};
            return {
                ...(defaults || {}),
                ...current
            };
        }

        async function setModuleSettings(moduleId, next) {
            if (!moduleId) return;
            return _serializedWrite(async function() {
                // 同 setGlobalSettings——局部失败集贯穿本次 read-modify-write
                var failedFields = [];
                var all = await readAll(failedFields);
                all.modules = all.modules || {};
                all.modules[moduleId] = {
                    ...(all.modules[moduleId] || {}),
                    ...(next || {})
                };
                // return await 透传 writeRaw 的写入结果（false = 配额满/加密异常）
                return await _writeAllDirect(all, failedFields);
            });
        }

        return {
            key: SETTINGS_KEY,
            read: readRaw,
            write: write,
            readAll,
            writeAll,
            getGlobalSettings,
            setGlobalSettings,
            getModuleSettings,
            setModuleSettings,
            // 存量明文嵌套容器检测：读路径置位，调用方写回一次后清除
            needsContainerEncryption: function () { return _legacyContainersPending; },
            clearContainerEncryptionNeed: function () { _legacyContainersPending = false; }
        };
    }

    global.AEShared = global.AEShared || {};
    global.AEShared.createSettingsStore = createSettingsStore;
})(window);
