// ast-gate/config.js ── 门配置（通道信任 bypass + 能力域矩阵）
// （client/modules/ast-gate/，双端模块：CEP 面板 window / Node globalThis）
// 存储：localStorage['ast_gate_config_v1']（面板进程私有——AE 侧宽通道物理不可达，
// 配置自保护；读写仅经设置 UI）。即时生效：调用方每次现读，无缓存。
// master（门总开关）取消——bypass 即细分到 source 的总开关。
// 旧键迁移：ae_tools_allow_system_call → domains.system（迁移即收割删旧键）。
(function (global) {
    'use strict';

    var KEY = 'ast_gate_config_v1';
    var LEGACY_KEY = 'ae_tools_allow_system_call';
    var SOURCES = ['agent-tool', 'llm-preview', 'ae-tool', 'user-library'];

    function _store() {
        return (typeof localStorage !== 'undefined') ? localStorage
            : (global.__astGateTestStore || null);
    }

    function _defaults() {
        return {
            bypass: { 'agent-tool': false, 'llm-preview': false, 'ae-tool': false, 'user-library': false },
            domains: { system: false, socket: false, file: false, menu: false }
        };
    }

    function _normalize(parsed) {
        var cfg = _defaults();
        if (!parsed || typeof parsed !== 'object') return cfg;
        if (parsed.bypass && typeof parsed.bypass === 'object') {
            for (var i = 0; i < SOURCES.length; i++) {
                cfg.bypass[SOURCES[i]] = parsed.bypass[SOURCES[i]] === true;
            }
        }
        if (parsed.domains && typeof parsed.domains === 'object') {
            cfg.domains.system = parsed.domains.system === true;
            cfg.domains.socket = parsed.domains.socket === true;
            cfg.domains.file = parsed.domains.file === true;
            cfg.domains.menu = parsed.domains.menu === true;
        }
        return cfg;
    }

    function read() {
        var st = _store();
        if (st) {
            try {
                var raw = st.getItem(KEY);
                if (raw !== null && raw !== undefined) return _normalize(JSON.parse(raw));
                var legacy = st.getItem(LEGACY_KEY);
                if (legacy !== null && legacy !== undefined) {
                    var cfg = _defaults();
                    cfg.domains.system = (legacy === 'true');
                    try { st.setItem(KEY, JSON.stringify(cfg)); st.removeItem(LEGACY_KEY); } catch (_) {}
                    _syncMirror(cfg);
                    return cfg;
                }
            } catch (_) { /* 损坏 → 默认（fail-safe） */ }
        }
        return _defaults();
    }

    function _syncMirror(cfg) {
        global.AE_LLM = global.AE_LLM || {};
        global.AE_LLM.allowAEToolsSystemCall = cfg.domains.system === true;
    }

    // 带落盘回执的写入。write() 原签名保持不变（返回 normalized），面板保存链改用
    // writeEx 消费 ok——setItem 失败被吞时，面板仍弹「已保存」：用户若是在**收回**危险
    // 能力（关域/清 bypass），重启后回到更早的**更宽松**配置而以为已保存（安全方向恶化）。
    function writeEx(cfg) {
        var normalized = _normalize(cfg);
        var st = _store();
        var ok = true;
        if (st) {
            try { st.setItem(KEY, JSON.stringify(normalized)); } catch (_) {
                // 持久化失败时镜像已更新、storage 留旧值——重载回旧态（写失败
                // 方向=回到更早配置，非 fail-open 扩权；配置 ~150B 实际不可达配额）
                ok = false;
            }
        }
        _syncMirror(normalized);
        return { ok: ok, cfg: normalized };
    }

    function write(cfg) {
        return writeEx(cfg).cfg;
    }

    // 通道信任判定（bypass 判定序第一层——落定 1 修正：门照跑，调用方据返回值
    // 跳过确认层/审计弹窗，执行时携带全开 allowSet〔file 能力经包装构造器，
    // 与域开启一致〕；逃逸形态与未收录成员仍拒于门）
    function isBypassed(source) {
        var cfg = read();
        return !!(cfg.bypass && cfg.bypass[source] === true);
    }

    // 域矩阵合成策略（类型表默认 × 用户覆盖；全 false → null 零开销路径）
    function getEffectivePolicy(override) {
        var cfg = read();
        var o = (override && typeof override === 'object') ? override : null;
        var p = {
            syscallAllowed: (o && o.syscallAllowed === true) || cfg.domains.system,
            socketAllowed: (o && o.socketAllowed === true) || cfg.domains.socket,
            fileAllowed: (o && o.fileAllowed === true) || cfg.domains.file,
            menuAllowed: (o && o.menuAllowed === true) || cfg.domains.menu
        };
        if (!p.syscallAllowed && !p.socketAllowed && !p.fileAllowed && !p.menuAllowed) return null;
        return p;
    }

    global.AEGate = global.AEGate || {};
    global.AEGate.config = { read: read, write: write, writeEx: writeEx, isBypassed: isBypassed, getEffectivePolicy: getEffectivePolicy };
    _syncMirror(read());
})(typeof window !== 'undefined' ? window : globalThis);
