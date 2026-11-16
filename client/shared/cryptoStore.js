(function (global) {
    'use strict';

    var ALGORITHM = 'AES-GCM';
    var KEY_LENGTH = 256;
    // 旧派生盐——仅用于旧记录（无 salt 字段）的解密兼容，不可改动/删除，
    // 否则存量密文全部不可解。新写入改用每记录随机盐（见 encryptValue）
    var LEGACY_SALT = new Uint8Array([
        0x8e,0x3a,0x71,0x9f,0x2b,0x4c,0x5d,0x6e,
        0x7f,0x80,0x91,0xa2,0xb3,0xc4,0xd5,0xe6,
        0x1a,0x2b,0x3c,0x4d,0x5e,0x6f,0x70,0x81,
        0x92,0xa3,0xb4,0xc5,0xd6,0xe7,0xf8,0x09
    ]);
    var PBKDF2_ITERATIONS = 100000;
    // 新写入的随机派生盐字节数（与 LEGACY_SALT 同长度）
    var SALT_BYTES = 32;

    var DEFAULT_SENSITIVE_FIELDS = ['apiKey', 'siliconflowApiKey', 'openrouterApiKey', 'deepseekApiKey', 'kimiApiKey', 'anthropicApiKey'];

    // 嵌套容器字段：模块设置下以「整块 JSON 加密」方式落盘的字段。
    // 敏感值散布在嵌套结构里（MCP servers 的 env/headers/url/args 都可能带 Key），
    // 整块序列化后作为单条密文落盘，磁盘上只出现一个密文字段：模块名 → 字段名列表。
    // settingsStore.js 的 FALLBACK_ENCRYPTED_CONTAINER_FIELDS 是同一清单的降级兜底，改动需同步。
    var ENCRYPTED_CONTAINER_FIELDS = { 'mcp-manager': ['servers'] };

    function isEncryptedContainerField(modId, name) {
        var list = ENCRYPTED_CONTAINER_FIELDS[modId];
        return !!(list && list.indexOf(name) !== -1);
    }

    // 完整密文形状才认：v=1 且 value/iv/salt 均为字符串。只看「对象有 .v」会把
    // 服务器 id 恰为 v 的明文 servers 容器误判成密文（加密被跳过、读取按密文解包失败）
    function _isContainerCipher(v) {
        return !!(v && typeof v === 'object' && !Array.isArray(v)
            && v.v === 1
            && typeof v.value === 'string'
            && typeof v.iv === 'string'
            && typeof v.salt === 'string');
    }

    // 只有非空容器才加密：空对象/空数组保留原形，供指纹漂移时的密文保留判定
    //（settingsStore 把 {} / [] 视为「已被解密失败清空」，据此回填原密文）
    function _containerHasContent(v) {
        if (!v || typeof v !== 'object') return false;
        if (Array.isArray(v)) return v.length > 0;
        return Object.keys(v).length > 0;
    }

    // 记录最近一次 decryptSensitive 中解密失败的字段（指纹漂移时 catch 置空的那批）。
    // settingsStore 写回时据此保留 localStorage 中的原密文，避免空值覆盖导致密钥永久丢失。
    var _undecryptableFields = [];
    function getUndecryptableFields() {
        return _undecryptableFields.slice();
    }

    function getSensitiveFields() {
        var registry = global.AE_LLM && global.AE_LLM.providerRegistry;
        var fields = [];
        // Add default fields
        for (var i = 0; i < DEFAULT_SENSITIVE_FIELDS.length; i++) {
            fields.push(DEFAULT_SENSITIVE_FIELDS[i]);
        }
        // Add registry-derived fields
        if (registry && typeof registry.getSensitiveFields === 'function') {
            try {
                var registryFields = registry.getSensitiveFields();
                if (Array.isArray(registryFields)) {
                    for (var j = 0; j < registryFields.length; j++) {
                        if (fields.indexOf(registryFields[j]) === -1) {
                            fields.push(registryFields[j]);
                        }
                    }
                }
            } catch (_) {}
        }
        return fields;
    }

    function getFingerprint() {
        try {
            var STORAGE_KEY = 'ae_crypto_fingerprint';
            var cached = localStorage.getItem(STORAGE_KEY);
            if (cached && cached.length >= 16) return cached;
            // 组合稳定机器特征，不用 screen.width/height（外接显示器会变）
            // 不使用 crypto.randomUUID()：该值随机，localStorage 清除后无法复现，导致已加密数据永久不可解密
            // 不用 Intl.DateTimeFormat().timeZone：时区随旅行/系统设置漂移，会导致派生密钥变化、已存密文静默丢失
            var seed = [
                navigator.platform || '',
                navigator.hardwareConcurrency || 0,
                navigator.language || '',
                String(navigator.userAgent || '').length.toString(36)
            ].join('|');
            localStorage.setItem(STORAGE_KEY, seed);
            return seed;
        } catch (_) {
            // 回退仍使用稳定特征，不用硬编码字符串（否则所有用户共享同一密钥）
            return [
                navigator.platform || 'unknown',
                navigator.hardwareConcurrency || 0,
                navigator.language || '',
                'fallback'
            ].join('|');
        }
    }

    function getKeyMaterial() {
        return crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(getFingerprint()),
            'PBKDF2',
            false,
            ['deriveKey']
        );
    }

    function deriveKey(keyMaterial, salt) {
        return crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt || LEGACY_SALT,
                iterations: PBKDF2_ITERATIONS,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: ALGORITHM, length: KEY_LENGTH },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async function encryptValue(plaintext) {
        // 每记录随机派生盐（32B）随密文持久化在 salt 字段——硬编码盐时代
        // 全用户共享同一派生输入，低熵指纹（四元组组合空间数百至千级）× 共享盐可
        // 预计算彩虹表一次打穿所有用户；per-record 随机盐让每条密文需独立穷举。
        // 强度边界（明示）：派生输入仍是机器特征指纹（非用户口令），且指纹缓存在
        // localStorage（ae_crypto_fingerprint）——本机文件级全量泄露时攻击者可直接
        // 复算派生密钥，本修复只消除跨用户/跨记录的彩虹表摊销，不抵抗本机全量泄露
        // （抵抗本机泄露需引入用户口令，属产品级变更）。
        // 盐持久化在记录内（而非 localStorage 单点）：localStorage 清除后指纹可由
        // 稳定特征复现、盐随密文留存，密文仍可解——对齐 getFingerprint 注释里明确
        // 规避的「随机值清除后不可复现」丢失模式。版本标记 = salt 字段存在与否
        // （v 保持 1，密文对象形状与既有读取方/settingsStore 保留逻辑兼容）
        var salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
        var keyMaterial = await getKeyMaterial();
        var key = await deriveKey(keyMaterial, salt);
        var iv = crypto.getRandomValues(new Uint8Array(12));
        var encoded = new TextEncoder().encode(plaintext);
        var ciphertext = await crypto.subtle.encrypt(
            { name: ALGORITHM, iv: iv },
            key,
            encoded
        );
        return {
            value: btoa(String.fromCharCode.apply(null, new Uint8Array(ciphertext))),
            iv: btoa(String.fromCharCode.apply(null, iv)),
            salt: btoa(String.fromCharCode.apply(null, salt)),
            v: 1
        };
    }

    async function decryptValue(encrypted) {
        // salt 字段存在 = 按记录内随机盐派生（新写入）；无 salt 字段 =
        // 旧记录按 LEGACY_SALT 派生（存量密文读取兼容，无迁移成本）
        var salt = (encrypted && encrypted.salt)
            ? Uint8Array.from(atob(encrypted.salt), function (c) { return c.charCodeAt(0); })
            : LEGACY_SALT;
        var keyMaterial = await getKeyMaterial();
        var key = await deriveKey(keyMaterial, salt);
        var iv = Uint8Array.from(atob(encrypted.iv), function (c) { return c.charCodeAt(0); });
        var ciphertext = Uint8Array.from(atob(encrypted.value), function (c) { return c.charCodeAt(0); });
        var plaintext = await crypto.subtle.decrypt(
            { name: ALGORITHM, iv: iv },
            key,
            ciphertext
        );
        return new TextDecoder().decode(plaintext);
    }

    async function encryptSensitive(payload) {
        var result = JSON.parse(JSON.stringify(payload));
        var sensitiveFields = getSensitiveFields();
        for (var i = 0; i < sensitiveFields.length; i++) {
            var field = sensitiveFields[i];
            if (result.global && typeof result.global[field] === 'string' && result.global[field] && !result.global[field].v) {
                result.global[field] = await encryptValue(result.global[field]);
            }
            if (result.modules) {
                var modIds = Object.keys(result.modules);
                for (var m = 0; m < modIds.length; m++) {
                    var modId = modIds[m];
                    if (result.modules[modId][field] && typeof result.modules[modId][field] === 'string') {
                        result.modules[modId][field] = await encryptValue(result.modules[modId][field]);
                    }
                }
            }
        }
        // 嵌套容器整块加密：JSON 序列化后作为单条密文落盘，密文标记 json=true
        // 供 decryptSensitive 还原成对象（字符串与对象两种载荷共用一个值容器形状）
        var containerModIds = Object.keys(ENCRYPTED_CONTAINER_FIELDS);
        for (var c = 0; c < containerModIds.length; c++) {
            var cmodId = containerModIds[c];
            var cmod = result.modules && result.modules[cmodId];
            if (!cmod || typeof cmod !== 'object') continue;
            var cfields = ENCRYPTED_CONTAINER_FIELDS[cmodId];
            for (var cf = 0; cf < cfields.length; cf++) {
                var cval = cmod[cfields[cf]];
                if (!_containerHasContent(cval) || _isContainerCipher(cval)) continue;
                var containerCipher = await encryptValue(JSON.stringify(cval));
                containerCipher.json = true;
                cmod[cfields[cf]] = containerCipher;
            }
        }
        return result;
    }

    async function decryptSensitive(payload, collector) {
        var result = JSON.parse(JSON.stringify(payload));
        var sensitiveFields = getSensitiveFields();
        _undecryptableFields = [];
        // 失败集是 settingsStore read-modify-write 的 preserve 依据，但模块级全局
        // 状态会被并发的另一次 decryptSensitive 开头重置撕开（读操作与写闭包在 decrypt
        // 阶段交错 → 本次写回的 preserve 读到空集 → 密文被空串覆盖、API Key 永久丢失）。
        // 调用方可传局部数组 collector 让失败集随调用链显式携带（同一次 read 记录、
        // 同一次 write 消费）；未传时（兼容既有调用方）仍同步维护模块级数组。
        var useCollector = Array.isArray(collector);
        for (var i = 0; i < sensitiveFields.length; i++) {
            var field = sensitiveFields[i];
            if (result.global && result.global[field] && result.global[field].v) {
                try {
                    result.global[field] = await decryptValue(result.global[field]);
                } catch (_) {
                    // 解密失败（指纹漂移等）不能只置空——随后的全量写回会把空值持久化，
                    // 原密文被覆盖、密钥永久丢失。仍置 ''（消费方行为不变），
                    // 但记录字段路径，供 settingsStore 写回时保留原密文
                    result.global[field] = '';
                    _undecryptableFields.push({ scope: 'global', modId: null, field: field });
                    if (useCollector) collector.push({ scope: 'global', modId: null, field: field });
                    console.warn('[crypto] 解密失败（加密指纹可能已漂移），写回时保留原密文: global.' + field);
                }
            }
            if (result.modules) {
                var modIds = Object.keys(result.modules);
                for (var m = 0; m < modIds.length; m++) {
                    var modId = modIds[m];
                    if (result.modules[modId][field] && result.modules[modId][field].v) {
                        try {
                            result.modules[modId][field] = await decryptValue(result.modules[modId][field]);
                        } catch (_) {
                            result.modules[modId][field] = '';
                            _undecryptableFields.push({ scope: 'modules', modId: modId, field: field });
                            if (useCollector) collector.push({ scope: 'modules', modId: modId, field: field });
                            console.warn('[crypto] 解密失败（加密指纹可能已漂移），写回时保留原密文: modules.' + modId + '.' + field);
                        }
                    }
                }
            }
        }
        // 嵌套容器解密：失败时与顶层敏感字段一致——置空 + 记录失败路径，
        // settingsStore 写回时据此保留磁盘原密文（否则指纹漂移会把配置清空）
        var containerModIds = Object.keys(ENCRYPTED_CONTAINER_FIELDS);
        for (var c = 0; c < containerModIds.length; c++) {
            var cmodId = containerModIds[c];
            var cmod = result.modules && result.modules[cmodId];
            if (!cmod || typeof cmod !== 'object') continue;
            var cfields = ENCRYPTED_CONTAINER_FIELDS[cmodId];
            for (var cf = 0; cf < cfields.length; cf++) {
                var cfield = cfields[cf];
                var dval = cmod[cfield];
                if (!_isContainerCipher(dval)) continue;
                try {
                    var containerPlain = await decryptValue(dval);
                    cmod[cfield] = dval.json ? JSON.parse(containerPlain) : containerPlain;
                } catch (_) {
                    cmod[cfield] = '';
                    _undecryptableFields.push({ scope: 'modules', modId: cmodId, field: cfield });
                    if (useCollector) collector.push({ scope: 'modules', modId: cmodId, field: cfield });
                    console.warn('[crypto] 解密失败（加密指纹可能已漂移），写回时保留原密文: modules.' + cmodId + '.' + cfield);
                }
            }
        }
        return result;
    }

    global.AEShared = global.AEShared || {};
    global.AEShared.encryptSensitive = encryptSensitive;
    global.AEShared.decryptSensitive = decryptSensitive;
    // 导出敏感字段判定，供加密层不可用时的降级写入路径复用（保持字段清单单一来源）
    global.AEShared.getSensitiveFields = getSensitiveFields;
    // 导出嵌套容器判定，供 settingsStore 的降级剔除/密文回填复用（同字段清单单一来源）
    global.AEShared.isEncryptedContainerField = isEncryptedContainerField;
    // 导出最近一次解密失败的字段集，供 settingsStore 写回时保留原密文（S6）
    global.AEShared.getUndecryptableFields = getUndecryptableFields;
})(window);
