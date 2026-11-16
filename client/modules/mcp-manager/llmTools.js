/**
 * mcp-manager/llmTools.js - MCP 管理 LLM 工具装配
 *
 * 双工具（按权限边界拆分）：
 *   mcp_servers   配置层 CRUD（list/get/add/update/remove/setAutoStart）
 *   mcp_control   运行层控制（getStatus/getAllStatuses/start/stop/restart/autoStartAll）
 *
 * 权限策略（与 permissions.js 对齐）：
 *   - 读 mode（list/get/getStatus/getAllStatuses）→ 不弹
 *   - 写 mode（add/update/setAutoStart）→ balanced 弹
 *   - 控制 mode（start/stop/restart/autoStartAll）→ balanced 弹
 *   - remove → FORCE_CONFIRM（任何模式都弹，包括 auto）
 *
 * env/headers 字段策略：list 不返回（避免 API Key 进入 LLM 上下文）；get 单条返回键名、值掩码为 ***。
 * url 字段策略：query 部分整体掩码为 ***（保留 scheme+host+path），防 `?token=sk-...` 嵌凭据 URL 明文进入 LLM 上下文。
 *
 * 依赖：serverManager 由 bootstrap.js initMCP 创建并挂到 global.AE_LLM.serverManager。
 */
(function (global) {
    global.AEMcpManager = global.AEMcpManager || {};

    var TOOL_NAMES = ['mcp_servers', 'mcp_control'];

    // ── 权限策略共用的 mode 分类（与 permissions.js 的 CONFIRM_COND 保持一致）──
    var SERVERS_READ_MODES = { list: true, get: true };
    var CONTROL_READ_MODES = { getStatus: true, getAllStatuses: true };

    function _ok(text) {
        return { success: true, isError: false, content: [{ type: 'text', text: String(text) }] };
    }
    function _err(text) {
        return { success: false, isError: true, content: [{ type: 'text', text: String(text) }] };
    }
    function _asyncErr(e) {
        var msg = (e && e.message) ? e.message : String(e);
        return { success: false, isError: true, content: [{ type: 'text', text: '执行错误: ' + msg }] };
    }

    // ── mcp_servers 描述（含「MCP 输出目录落数据目录」规则）──
    // 为什么走 buildDescription 而非静态串：数据目录支持运行时切换（syncDataDirSetting
    // 不重启面板），注册时快照会把旧路径写死进 LLM 上下文，配置随之落到已迁走/已删的
    // 目录。toolRegistry 取完整定义的三处（getToolFullDef/getLlmToolDefinitions/
    // getLlmToolStubs）都优先 buildDescription，故每次都是当前路径。
    // 依据 @playwright/mcp：stdio 子进程继承的 cwd 是 CEP 扩展
    // 安装目录（Program Files 下只读），会写文件的服务器不显式指定输出目录就 EPERM mkdir；
    // 而 %TEMP% 写法会被 spawn 层的 shell 字符校验拒（% 在禁列）。
    function _serversDescription() {
        var dataDir = '';
        try {
            if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                dataDir = String((global.AEShared.getDataDir() || {}).dir || '').replace(/\\+$/, '');
            }
        } catch (_) {}
        var outDir = (dataDir || '<数据目录>') + '\\temp\\mcp\\<serverId>';
        return 'MCP 服务器配置管理（CRUD）。按 mode 操作：'
            + ' list/get（读，不弹确认）；'
            + ' add/update/setAutoStart（写，balanced 弹确认）；'
            + ' remove（删除，FORCE_CONFIRM 任何模式都弹）。'
            + ' 停用服务器 = mcp_control 的 stop（立即断开）+ setAutoStart(false)（不再自启）：'
            + ' 停用不是「彻底关闭」，之后显式 start/restart 仍可拉起。'
            + ' list 不返回 env/headers（敏感字段）；get 返回全部字段，但 env/headers 仅显示键名、值掩码为 ***，url 的 query 部分掩码为 ***（凭据明文不进入对话上下文；需修改时经 update 直接传新值）。'
            + ' serverId 须匹配 /^[a-zA-Z0-9_-]{1,64}$/。'
            + ' ⚠️ add/update 前必须审核：command 不得包含 rm/del/format/curl/wget 等破坏/外泄命令；'
            + ' url 不得指向内网/localhost/未知域名；'
            + ' 来源不明的 JSON 配置应建议用户手动通过 UI 添加而非直接 add；'
            + ' env/headers 含 API Key/Token 时提醒用户会被持久化。'
            + ' ⚠️ stdio MCP 会写文件的（截图/快照/导出类）一律把输出目录指到数据目录下：' + outDir
            + '（参数名以该服务器自身文档为准，如 --output-dir）。默认 cwd 是只读的 CEP 扩展安装目录，不显式指定就一执行报 EPERM mkdir；'
            + '不要用 %TEMP%（含 % 会被 spawn 层拒绝）或 C:\\Users\\Public 等面板外路径。';
    }

    /**
     * 初始化 MCP 管理 LLM 工具。
     * @param {object} config
     *   toolRegistry  (必填)
     *   serverManager (必填，由 bootstrap.js initMCP 创建)
     */
    function initMcpManagerTools(config) {
        config = config || {};
        var toolRegistry = config.toolRegistry;
        var serverManager = config.serverManager || (global.AE_LLM && global.AE_LLM.serverManager) || null;

        if (!toolRegistry) {
            console.warn('[McpLlmTools] MISSING_TOOL_REGISTRY');
            return { ok: false, error: 'MISSING_TOOL_REGISTRY' };
        }
        if (!serverManager) {
            console.warn('[McpLlmTools] MISSING_SERVER_MANAGER');
            return { ok: false, error: 'MISSING_SERVER_MANAGER' };
        }

        // ── 注册 mcp_servers（配置 CRUD）──
        toolRegistry.register({
            name: 'mcp_servers',
            shortDescription: 'MCP 服务器配置管理（CRUD），按 mode 操作',
            description: _serversDescription(),
            // LLM 面实际取这份（路径现读，见 _serversDescription 注释）
            buildDescription: _serversDescription,
            input_schema: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['list', 'get', 'add', 'update', 'remove', 'setAutoStart']
                    },
                    serverId: {
                        type: 'string',
                        description: 'add/update/remove/setAutoStart/get 用：服务器 id（字母数字下划线连字符，1-64 字符）'
                    },
                    config: {
                        type: 'object',
                        description: 'add 必填 / update 可选：服务器配置（update 仅传需要变更的字段）',
                        properties: {
                            command: { type: 'string', description: 'stdio 必填：可执行文件路径' },
                            args: { type: 'array', items: { type: 'string' }, description: 'stdio 参数列表' },
                            env: { type: 'object', description: 'stdio 环境变量（可含 API Key 等敏感字段）' },
                            headers: { type: 'object', description: 'HTTP/SSE 请求头（如 Authorization: Bearer xxx）' },
                            url: { type: 'string', description: 'HTTP/SSE 必填：服务器 URL' },
                            transport: { type: 'string', enum: ['http', 'stdio', 'sse'] },
                            autoStart: { type: 'boolean', description: '是否自启动（false=不参与自启，配合 mcp_control stop 即停用）' },
                            agentModes: {
                                type: 'array',
                                items: { type: 'string', enum: ['agent', 'script', 'shader', 'external-mcp'] },
                                description: '生效模式（Agent 模块）。缺省/空=面板三模式全生效；external-mcp = 外接通道'
                            }
                        }
                    },
                    autoStart: { type: 'boolean', description: 'setAutoStart 必填：是否自启动（false=不再自启；停用的另一半是 mcp_control stop）' },
                    restart: {
                        type: 'boolean',
                        description: 'update/setAutoStart 可选：是否触发 restart 使配置生效（默认 false，仅同步到 provider 不断开）'
                    }
                },
                required: ['mode']
            },
            scope: { type: 'global' },
            stub: true,
            source: 'mcp',
            category: 'mcp',
            handler: function (args) {
                return _handleServers(args, serverManager);
            }
        });

        // ── 注册 mcp_control（运行控制）──
        toolRegistry.register({
            name: 'mcp_control',
            shortDescription: 'MCP 服务器运行控制（start/stop/restart/status）',
            description: 'MCP 服务器运行控制。按 mode 操作：'
                + ' getStatus/getAllStatuses（读，不弹确认）；'
                + ' start/stop/restart/autoStartAll（控制，balanced 弹确认）。'
                + ' start/stop/restart 使用同步 API，返回当前状态（start 后通常为 connecting，需等待或通过 getStatus 确认最终状态）。'
                + ' 停用服务器 = stop（立即断开）+ mcp_servers setAutoStart(false)（不再自启）；'
                + ' autoStart=false 的服务器不参与 autoStartAll，但显式 start/restart 照常拉起'
                + '（停用只表示已断开、不会自启）。',
            input_schema: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['getStatus', 'getAllStatuses', 'start', 'stop', 'restart', 'autoStartAll']
                    },
                    serverId: {
                        type: 'string',
                        description: 'getStatus/start/stop/restart 用：服务器 id'
                    }
                },
                required: ['mode']
            },
            scope: { type: 'global' },
            stub: true,
            source: 'mcp',
            category: 'mcp',
            handler: function (args) {
                return _handleControl(args, serverManager);
            }
        });

        console.log('[McpLlmTools] Registered ' + TOOL_NAMES.length + ' mcp tools');
        return { ok: true, toolNames: TOOL_NAMES };
    }

    // ════════════════════════════════════════════════════════
    //  mcp_servers handler
    // ════════════════════════════════════════════════════════
    async function _handleServers(args, sm) {
        args = args || {};
        var mode = args.mode;
        try {
            switch (mode) {
                case 'list': return _ok(_fmtServerList(sm.getAllServerConfigs()));
                case 'get': return _ok(_fmtServerGet(sm.getServerConfig(args.serverId), sm.getServerStatus(args.serverId)));
                case 'add': return await _serversAdd(sm, args);
                case 'update': return await _serversUpdate(sm, args);
                case 'remove': return await _serversRemove(sm, args);
                case 'setAutoStart':
                    if (typeof args.autoStart !== 'boolean') return _err('setAutoStart 必填 autoStart (boolean)');
                    return await _serversUpdate(sm, args, { autoStart: args.autoStart });
                default: return _err('未知 mode: ' + mode);
            }
        } catch (e) {
            return _asyncErr(e);
        }
    }

    // 写操作回执区分「配置非法/不存在」与「运行时已生效但落盘失败」
    //（persisted===false；本次会话已生效，重启后回退——与 skill-manager
    // llmTools 的写失败回执口径对齐）。
    function _persistFailText(r, fallback) {
        return r && r.persisted === false
            ? fallback + '，但配置保存失败（本次会话已生效，重启后回退）'
            : null;
    }

    async function _serversAdd(sm, args) {
        if (!args.serverId) return _err('add 必填 serverId');
        if (!args.config) return _err('add 必填 config');
        var cfg = _normalizeConfig(args.config);
        if (args.config.agentModes !== undefined) cfg.scope = _agentScope(args.config.agentModes);
        var r = await sm.addServer(args.serverId, cfg);
        if (r && r.ok) return _ok('已添加 MCP 服务器: ' + args.serverId);
        var pFail = _persistFailText(r, '已添加 MCP 服务器: ' + args.serverId);
        if (pFail) return _err(pFail);
        return _err('添加失败: ' + (r && r.error ? r.error : '未知错误'));
    }

    async function _serversUpdate(sm, args, patchOverride) {
        if (!args.serverId) return _err('update/setAutoStart 必填 serverId');
        var patch = patchOverride || (args.config ? _normalizeConfig(args.config) : null);
        if (!patch) return _err('update 必填 config（或 setAutoStart 必填对应字段）');
        if (args.config && args.config.agentModes !== undefined) patch.scope = _agentScope(args.config.agentModes);
        var opts = { restart: args.restart === true };
        var r = await sm.updateServer(args.serverId, patch, opts);
        if (r && r.ok) {
            var msg = '已更新: ' + args.serverId;
            if (opts.restart) {
                msg += '（已触发重启）';
            }
            return _ok(msg);
        }
        // 更新已合并进内存/运行时，仅落盘失败：如实回执
        var pFailUpd = _persistFailText(r, '已更新: ' + args.serverId);
        if (pFailUpd) return _err(pFailUpd);
        return _err('更新失败: ' + (r && r.error ? r.error : '未知错误'));
    }

    async function _serversRemove(sm, args) {
        if (!args.serverId) return _err('remove 必填 serverId');
        var r = await sm.removeServer(args.serverId);
        if (r && r.ok) return _ok('已删除 MCP 服务器: ' + args.serverId);
        var pFail = _persistFailText(r, '已删除 MCP 服务器: ' + args.serverId);
        if (pFail) return _err(pFail);
        return _err('删除失败: ' + (r && r.error ? r.error : '未知错误'));
    }

    // ════════════════════════════════════════════════════════
    //  mcp_control handler
    // ════════════════════════════════════════════════════════
    function _handleControl(args, sm) {
        args = args || {};
        var mode = args.mode;
        try {
            switch (mode) {
                case 'getStatus': return _ok(_fmtStatus(sm.getServerStatus(args.serverId)));
                case 'getAllStatuses': return _ok(_fmtStatusList(sm.getAllServerStatuses()));
                case 'start': return _controlSync(sm, args.serverId, 'startServerSync', '启动');
                case 'stop': return _controlSync(sm, args.serverId, 'stopServerSync', '停止');
                case 'restart':
                    // restart: stop 后 start，分两步走同步 API
                    return _controlRestart(sm, args.serverId);
                case 'autoStartAll':
                    var count = sm.autoStartAllServers();
                    return _ok('已自启动 ' + count + ' 个服务器');
                default: return _err('未知 mode: ' + mode);
            }
        } catch (e) {
            return _asyncErr(e);
        }
    }

    function _controlSync(sm, serverId, method, label) {
        if (!serverId) return _err(label + ' 必填 serverId');
        var r = sm[method](serverId);
        if (r && r.ok) {
            return _ok(label + ' 完成: ' + serverId + '（状态: ' + (r.status || 'unknown') + '）');
        }
        return _err(label + ' 失败: ' + serverId + '（' + (r && r.error ? r.error : '未知错误') + '）');
    }

    function _controlRestart(sm, serverId) {
        if (!serverId) return _err('restart 必填 serverId');
        var stopR = sm.stopServerSync(serverId);
        var startR = sm.startServerSync(serverId);
        if (startR && startR.ok) {
            return _ok('重启完成: ' + serverId + '（状态: ' + (startR.status || 'unknown') + '）');
        }
        return _err('重启失败: ' + serverId + '（stop=' + (stopR && stopR.ok ? 'ok' : 'fail')
            + ', start=' + (startR && startR.error ? startR.error : 'fail') + '）');
    }

    // ════════════════════════════════════════════════════════
    //  共用辅助
    // ════════════════════════════════════════════════════════

    // LLM 写操作作用域：模块固定为 Agent，只接受模式（agent/script/shader/外接）。
    // agentModes 缺省/空 = 面板三模式全生效（不写 agentModes 字段）。
    // 白名单含 'external-mcp'（外接）：它是 Agent 的模式之一，且 list 会把作用域打印成
    // module=agent(agent:external-mcp)——LLM 读回后照抄再写时若在这里被过滤，服务器会静默丢掉外接。
    function _agentScope(agentModes) {
        var modes = Array.isArray(agentModes) ? agentModes.filter(function (m) {
            return m === 'agent' || m === 'script' || m === 'shader' || m === 'external-mcp';
        }) : [];
        var scope = { type: 'module', moduleIds: ['agent'] };
        if (modes.length) scope.agentModes = modes;
        return scope;
    }

    // 将 LLM 传入的 config（scope 是 string）规范化为 lifecycle 接受的形态
    // （enabled 字段已删除，schema 不再透传该键）
    function _normalizeConfig(cfg) {
        if (!cfg || typeof cfg !== 'object') return cfg;
        var out = {};
        if (cfg.hasOwnProperty('command')) out.command = cfg.command;
        if (cfg.hasOwnProperty('args')) out.args = cfg.args;
        if (cfg.hasOwnProperty('env')) out.env = cfg.env;
        if (cfg.hasOwnProperty('headers')) out.headers = cfg.headers;
        if (cfg.hasOwnProperty('url')) out.url = cfg.url;
        if (cfg.hasOwnProperty('transport')) out.transport = cfg.transport;
        if (cfg.hasOwnProperty('autoStart')) out.autoStart = cfg.autoStart;
        if (cfg.hasOwnProperty('scope')) out.scope = cfg.scope; // string 或 object 都接受，lifecycle.parseServerScope 处理
        return out;
    }

    // list 摘要：不含 env
    function _fmtServerList(configs) {
        if (!configs) return '（无 MCP 服务器）';
        var ids = Object.keys(configs);
        if (!ids.length) return '（无 MCP 服务器）';
        var lines = ['共 ' + ids.length + ' 个 MCP 服务器：'];
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            var c = configs[id];
            var scopeStr = ' global';
            if (c.scope && c.scope.type === 'module') {
                var scModsP = c.scope.moduleIds || (c.scope.moduleId ? [c.scope.moduleId] : []);
                scopeStr = ' module=' + scModsP.join(',');
                var scModesP = c.scope.agentModes || (c.scope.mode ? [c.scope.mode] : []);
                if (scModsP.indexOf('agent') >= 0 && scModesP.length) scopeStr += '(agent:' + scModesP.join('/') + ')';
            }
            lines.push('- [' + id + '] transport=' + (c.transport || '?')
                + ' autoStart=' + (c.autoStart !== false)
                + scopeStr
                + (c.url ? ' url=' + _maskUrlQuery(c.url) : '')
                + (c.command ? ' command=' + c.command : ''));
        }
        return lines.join('\n');
    }

    // get 单条详情：含 env
    // env/headers 的值掩码为 ***——防提示注入链
    // "get → API Key/Token 明文进入 LLM 上下文 → 随回复/后续调用外泄"。
    // LLM 排障只需键名；需要改值时经 update 直接传新值，无需读取旧明文。
    function _maskEnvHeaders(v) {
        if (v && typeof v === 'object' && typeof Array.isArray === 'function' && !Array.isArray(v)) {
            var masked = {};
            var ks = Object.keys(v);
            for (var i = 0; i < ks.length; i++) masked[ks[i]] = '***';
            return JSON.stringify(masked);
        }
        return '***';
    }
    // url 的 query 部分整体掩码（保留 scheme+host+path）——remote MCP
    // 常见 `https://host/mcp?token=sk-...` 形态，query 嵌凭据不得明文进入 LLM 上下文
    // （与 _maskEnvHeaders 同一防线；排障只需端点，改值经 update 直传新 url）
    function _maskUrlQuery(u) {
        if (typeof u !== 'string') return u;
        var qi = u.indexOf('?');
        if (qi === -1) return u;
        return u.slice(0, qi + 1) + '***';
    }
    // args 键值感知掩码——命令行参数常承载凭据（--api-key=sk-xxx），直接走
    // JSON.stringify 原样进入 LLM 上下文（env/headers/url query 均已掩码，args 是漏网
    // 之口）。命中敏感键名（key/token/secret/password/passwd/pwd/auth/credential）或
    // 「=长值（≥16 字符赋值）」形态的元素整体替换为 '***'；未命中的短参数保留可读性
    //（排障只需参数形状，改值经 update 直传新参，与 _maskEnvHeaders 同一防线）。
    function _maskArgs(v) {
        if (!Array.isArray(v)) return '***';
        var masked = [];
        for (var i = 0; i < v.length; i++) {
            var a = String(v[i]);
            var eq = a.indexOf('=');
            var sensitive = /(key|token|secret|password|passwd|pwd|auth|credential)/i.test(a)
                || (eq >= 0 && a.slice(eq + 1).length >= 16);
            masked.push(sensitive ? '***' : v[i]);
        }
        return masked;
    }
    function _fmtServerGet(config, status) {
        if (!config) return '未找到 serverId 对应的服务器';
        var lines = ['--- ' + (status && status.id ? status.id : '?') + ' ---'];
        var keys = Object.keys(config);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var v = config[k];
            if (k === 'env' || k === 'headers') {
                v = _maskEnvHeaders(v);
            } else if (k === 'url' && typeof v === 'string') {
                v = _maskUrlQuery(v);
            } else if (k === 'args') {
                // args 键值感知掩码（否则 JSON.stringify 原样输出 --api-key=sk-xxx）
                v = JSON.stringify(_maskArgs(v));
            } else if (v && typeof v === 'object') {
                v = JSON.stringify(v);
            }
            lines.push(k + ': ' + v);
        }
        if (status) {
            lines.push('--- 状态 ---');
            lines.push('state: ' + (status.state || 'unknown'));
            if (status.lastError) lines.push('lastError: ' + status.lastError);
        }
        return lines.join('\n');
    }

    function _fmtStatus(status) {
        if (!status) return '未找到 serverId 对应的服务器';
        var lines = ['--- ' + status.id + ' ---'];
        lines.push('state: ' + (status.state || 'unknown'));
        if (status.lastError) lines.push('lastError: ' + status.lastError);
        var c = status.config || {};
        lines.push('transport: ' + (c.transport || '?'));
        lines.push('autoStart: ' + (c.autoStart !== false));
        return lines.join('\n');
    }

    function _fmtStatusList(statuses) {
        if (!statuses || !statuses.length) return '（无 MCP 服务器）';
        var lines = ['共 ' + statuses.length + ' 个：'];
        for (var i = 0; i < statuses.length; i++) {
            var s = statuses[i];
            lines.push('- [' + s.id + '] state=' + (s.state || 'unknown')
                + (s.lastError ? ' err=' + s.lastError : ''));
        }
        return lines.join('\n');
    }

    // 暴露
    global.AEMcpManager.initMcpManagerTools = initMcpManagerTools;
    // 供 permissions.js 引用（避免循环依赖，permissions.js 内部硬编码同名集合）
    global.AEMcpManager.SERVERS_READ_MODES = SERVERS_READ_MODES;
    global.AEMcpManager.CONTROL_READ_MODES = CONTROL_READ_MODES;
})(window);
