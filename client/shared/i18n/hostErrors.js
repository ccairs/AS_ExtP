// 宿主 ExtendScript 错误消息 → 面板词典 key 的映射。
// 宿主侧（host/api/*.jsx）保持中文不改：ES3 无 i18n 运行时，且同一条消息也要给
// AE 原生脚本错误面板看。面板侧只在上屏前把「宿主消息」映射成词典 key，再交给
// AEI18n.t 取当前语言译文。
//
// 契约：
//   · 精确命中 → 用 key 查表；key 含 {param} 时把右侧原文作为参数回填。
//   · 一条消息含多处变量时按条目 pattern 抽参数（params 按捕获组顺序命名）。
//   · 未命中 → **原样返回**（不吞消息、不改写、不查表，避免把未知宿主串当 key 记进缺 key 统计）。
//   · zh-CN → 走同一条路径，但 t() 原样返回 key，回填参数后与原文逐字节一致。
//   · 消息可能是异常对象（Error.message）或纯串；非串一律 String() 后照上面规则处理。
//   · "ERROR:" 是宿主失败协议前缀（调用方按它判失败），只翻其后的文案，前缀原样保留。
//   · 表里同时收进度通道文案（_emitProgress 的 message 直接进 AENotice）：同一条
//     localize 路径翻译，调用方按需在显示前过一遍；进度数值/标签不在文案内，不受影响。
(function (global) {
    'use strict';

    // 每条：{ key } / { key, param } / { key, pattern, params }。
    //   · key 即 zh 源文；param 非空表示 key 里带一个占位符，命中方式为「前缀匹配」——
    //     原文去掉前缀后的剩余部分整体作为该参数。前缀由 key 在第一个 '{' 处切分得到，
    //     故条目里不需要重复写前缀。
    //   · 一条消息里有多处变量时用 pattern + params：正则按组顺序填参数，正则必须整串命中。
    //     key 的占位符集合由 build-locale 校验，与译文逐一对齐。
    var ENTRIES = [
        { key: '无活动合成' },
        { key: '未选中任何图层' },
        { key: 'ffxPath 必填' },
        { key: '预设路径非法（含空字节）' },
        { key: '预设必须是 .ffx 文件' },
        { key: '预设文件不存在: {path}', param: 'path' },
        { key: '目标目录不在数据目录下，拒绝执行: {path}', param: 'path' },
        { key: '无法创建目标目录: {path}', param: 'path' },
        { key: '工程副本复制到目标失败: {path}', param: 'path' },
        { key: '保存临时副本失败: {path}', param: 'path' },
        { key: '导出副本复制到目标失败: {path}', param: 'path' },
        { key: '导出仍在进行中，请等待当前导出完成' },
        { key: '空块' },
        { key: '合成已切换，批量中止' },
        { key: '图层已变更，批量中止' },
        // ── 工程素材（host/api/projectAssetApi.jsx）──
        { key: 'targetFolder 必填' },
        { key: '临时目录未指定或不在数据目录下，拒绝执行' },
        { key: '打开临时副本失败' },
        { key: 'compName/targetFolder 必填' },
        { key: '副本中找不到合成: {name}', param: 'name' },
        {
            key: '图层索引超出范围（副本合成共 {count} 层）: {ids}',
            pattern: /^图层索引超出范围（副本合成共 (\d+) 层）: (.+)$/,
            params: ['count', 'ids']
        },
        { key: '图层 id 在副本工程中找不到或不属于目标合成（导出期间图层被改动？）: {ids}', param: 'ids' },
        { key: '副本中找不到图层: {ids}', param: 'ids' },
        { key: '未找到任何目标图层' },
        { key: '图层预合成失败' },
        { key: 'originalPath 必填' },
        { key: '原工程不存在: {path}', param: 'path' },
        { key: '找不到合成: {name}', param: 'name' },
        // ── 效果（host/api/effectApi.jsx）──
        { key: 'matchName 必填' },
        { key: 'matchName 非法（含空字节）' },
        { key: 'matchName 格式非法' },
        // ── 工程素材：从项目面板选中项保存（host/api/projectAssetApi.jsx）──
        {
            key: '项目面板选中了 {n} 个合成：请只选中要保存的那一个',
            pattern: /^项目面板选中了 (\d+) 个合成：请只选中要保存的那一个$/,
            params: ['n']
        },
        {
            key: '项目面板选中的不是合成（{names}）：请选中要保存的合成，或在时间轴中打开它',
            pattern: /^项目面板选中的不是合成（([\s\S]+)）：请选中要保存的合成，或在时间轴中打开它$/,
            params: ['names']
        },
        { key: '请在项目面板选中要保存的合成（或在时间轴中打开一个合成）' },
        { key: '导出仍在进行中，已跳过自动回切——请在导出完成后手动打开原工程' },
        // ── 进度通道：_emitProgress / _emitProgressObj 的 message（CSEvent → AENotice）──
        { key: 'PSD 转 PNG: {name}', param: 'name' },
        {
            key: '素材收集完成: {done} / {total}',
            pattern: /^素材收集完成: (\d+) \/ (\d+)$/,
            params: ['done', 'total']
        },
        { key: '正在保存…' },
        { key: '正在保存临时副本…' },
        { key: '正在打开副本工程（大工程可能较慢）…' },
        { key: '正在收集素材…' },
        { key: '跳过素材收集…' },
        { key: '正在定位目标合成…' },
        { key: '正在预合成图层…' },
        { key: '正在精简工程素材…' },
        // ── 沙箱拒绝：executeExtendScript 核（client/modules/ae-tools/aeTools.jsx）与
        //    热盒 runScriptSandboxed（host/api/scriptRunner.jsx）。两串为整串 key（含标识符
        //    清单，无变量位），故用精确命中：任何字符差异都不该被当成同一条消息。
        { key: "[AE_LLM] executeExtendScript 拒绝：代码含沙箱逃逸/系统调用/网络通信/延迟执行/实例危险操作标识符（_cs/__ael/__aeS*/$.evalFile/$.global/callSystem/BridgeTalk/Socket/scheduleTask/runScriptFromFile/_File/_Folder/_ef/_bt/_sk/_st/_gFile/_gFolder/_gBT/_alert/_confirm/_prompt/caller/callee/.execute(/.changePath(/.constructor/__proto__/引擎内部名（_isSensitivePath/_isSystemOrRootDir/_GateFile/_fpo/_authFrame 等，完整名单见引擎侧 _INTERNAL_NAMES）/.getFiles()[）。Socket 是完整 TCP 通道（数据外泄/伪造 bridge 请求），默认无条件禁项（经 allow-set 受控放行——user-library 审计确认或能力域授权）。app.scheduleTask 回调在 shadow 恢复后执行（延迟绕过双层沙箱），禁止调用（硬拒无通道）。runScriptFromFile 在 host.jsx 顶层作用域 eval 文件内容，shadow 沙箱对其无效——禁止调用。File/Folder 实例的 execute()（启动任意可执行文件）一律拒绝；changePath()（真实例改指任意路径，敏感读取链一环）一律拒绝；Folder.getFiles()[ 立即索引形态默认拒绝（file 域授权后放行——静态访问器与 getFiles 返回条目按域分粒度包装）。如需 system.callSystem 等 capability 能力，请在「Agent 模块设置 > AST 门能力配置」开启对应能力域（或通道信任）。" },
        { key: "[AE_LLM] runScriptSandboxed 拒绝执行：脚本含沙箱逃逸/系统调用/网络通信/延迟执行/实例危险操作标识符（__ael/__aeS/_OF/_OD/$.evalFile/$.global/callSystem/BridgeTalk/Socket/scheduleTask/runScriptFromFile/.execute(/.changePath(/.getFiles()[）。热盒脚本一律沙箱执行（hotbox scripts are always sandboxed）：system.callSystem/BridgeTalk/Socket 即使经字符串拼接绕过本预检，运行时 shadow 也会以 System call disabled / BridgeTalk disabled / Socket disabled 拦截。app.scheduleTask 可在 shadow 恢复后延迟执行任意代码（时间窗绕过双层防线），禁止调用；脚本自带撤销组（beginUndoGroup/endUndoGroup）不再拦截——检测到即跳过框架外层包裹，撤销语义由脚本自负。File/Folder 实例的 execute()（启动任意可执行文件）一律拒绝；changePath()（真实例改指任意路径，敏感读取链一环）一律拒绝；Folder.getFiles()[ 立即索引形态拒绝——Folder.temp 等静态访问器与 getFiles 返回条目已包装为只读安全实例（写/删/改名/复制/执行拦截，读放行）。" }
    ];

    // 宿主失败协议前缀：宿主返回 "ERROR:<msg>"，调用方按该前缀判失败，故不参与查表。
    var ERROR_PREFIX = 'ERROR:';

    // 前缀表在加载期算一次（key 是静态数据，不随语言变化）。
    var _table = [];
    for (var i = 0; i < ENTRIES.length; i++) {
        var e = ENTRIES[i];
        var cut = e.key.indexOf('{');
        _table.push({
            key: e.key,
            param: e.param || null,
            prefix: cut < 0 ? e.key : e.key.slice(0, cut),
            pattern: e.pattern || null,
            params: e.params || null
        });
    }

    function _text(v) {
        if (v == null) return '';
        if (typeof v === 'string') return v;
        if (v.message != null) return String(v.message);
        return String(v);
    }

    // 解析宿主消息 → { key, params, prefix } 或 null（未命中）。纯函数，便于单测。
    // prefix 是原始文本的失败协议前缀（"ERROR:" 或空串），由 localize 原样加回。
    function resolve(message) {
        var text = _text(message);
        if (!text) return null;
        var prefix = '';
        if (text.slice(0, ERROR_PREFIX.length) === ERROR_PREFIX) {
            prefix = ERROR_PREFIX;
            text = text.slice(ERROR_PREFIX.length);
        }
        if (!text) return null;
        for (var i = 0; i < _table.length; i++) {
            var row = _table[i];
            if (row.pattern) {
                var hit = row.pattern.exec(text);
                if (!hit) continue;
                var multi = {};
                for (var g = 0; g < row.params.length; g++) multi[row.params[g]] = hit[g + 1];
                return { key: row.key, params: multi, prefix: prefix };
            }
            if (!row.param) {
                if (text === row.prefix) return { key: row.key, params: null, prefix: prefix };
                continue;
            }
            if (text.length > row.prefix.length && text.slice(0, row.prefix.length) === row.prefix) {
                var params = {};
                params[row.param] = text.slice(row.prefix.length);
                return { key: row.key, params: params, prefix: prefix };
            }
        }
        return null;
    }

    // 上屏入口：命中则取当前语言译文（参数回填），未命中原样返回。
    function localize(message) {
        var hit = resolve(message);
        if (!hit) return _text(message);
        var t = global.AEI18n && typeof global.AEI18n.t === 'function'
            ? global.AEI18n.t
            : function (s, p) {
                // 词典缺席时的最小回退：与 i18nCore.format 同规则，保证 zh 逐字节一致。
                return String(s).replace(/\{(\w+)\}/g, function (m, k) {
                    return p && Object.prototype.hasOwnProperty.call(p, k) ? String(p[k]) : m;
                });
            };
        return hit.prefix + t(hit.key, hit.params);
    }

    var api = { resolve: resolve, localize: localize, ENTRIES: ENTRIES };
    if (global) global.AEHostErrors = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
