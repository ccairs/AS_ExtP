(function (global) {
    'use strict';

    var _adapters = {};

    // 大小写不敏感地判断请求头是否已存在：自定义头写 'X-Opencode-Session' 与声明式
    // 'x-opencode-session' 视为同一个头，避免同一语义发两份（服务端行为未定义）
    function hasHeader(headers, name) {
        var target = String(name || '').toLowerCase();
        if (!target) return false;
        for (var key in headers) {
            if (headers.hasOwnProperty(key) && key.toLowerCase() === target) return true;
        }
        return false;
    }

    // ctx.sessionId（可选）：声明的会话头取值。不传/为空时留空不写该头——
    // 由调用方（llmChannel）负责回退到客户端安装级稳定 id，此处不引入存储依赖。
    function makeHeaders(provider, apiKey, ctx) {
        var headers = {};
        if (provider && provider.headers) {
            for (var key in provider.headers) {
                if (provider.headers.hasOwnProperty(key)) {
                    headers[key] = provider.headers[key];
                }
            }
        }
        // 声明式会话头（如 OpenCode Go/Zen 的 x-opencode-session）：平台自己声明头名，
        // 值取本次请求的会话 id。用户已在自定义头里配了同名头时不覆盖（尊重显式配置）。
        var sessionHeader = provider && provider.sessionIdHeader;
        if (sessionHeader) {
            var sessionId = ctx && ctx.sessionId ? String(ctx.sessionId) : '';
            if (sessionId && !hasHeader(headers, sessionHeader)) {
                headers[sessionHeader] = sessionId;
            }
        }
        if (provider && provider.auth && provider.auth.type === 'x-api-key') {
            headers['x-api-key'] = apiKey || '';
        } else {
            headers['Authorization'] = 'Bearer ' + (apiKey || '');
        }
        if (!headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
        if (provider && provider.protocol === 'anthropic-messages' && !headers['anthropic-version']) {
            headers['anthropic-version'] = '2023-06-01';
        }
        return headers;
    }

    // ───────────── 思考模式（平台级意图 → 各家原生参数）─────────────
    // 用户在模型管理里只选「关 / 开 / 自定义」（provider.thinking.mode），参数由本表拼。
    // 依据各家官方文档（已查证）：
    //   DeepSeek  thinking:{type:'enabled'}                     api-docs.deepseek.com
    //   智谱 GLM  thinking:{type:'enabled'}                     docs.z.ai/guides/capabilities/thinking-mode
    //   火山 Ark  thinking:{type:'enabled'}（另有 disabled/auto） volcengine SDK 类型
    //   OpenRouter reasoning:{enabled:true}（≡ effort:'medium'） openrouter.ai/docs/use-cases/reasoning-tokens
    //   Anthropic thinking:{type:'enabled',budget_tokens:N}     anthropic-sdk-python types（budget ≥1024 且 < max_tokens）
    //   SiliconFlow enable_thinking:true（扁平布尔，非 thinking 对象） docs.siliconflow.cn
    //   Kimi      按模型而异（见 models 覆盖）：k3 / k3.1-pro / k2.7-code 恒开且不吃 thinking.type，k2.6 才吃
    // 语义约定：mode='off' **不发任何参数**（保持平台默认；显式关闭走「自定义」手填，
    // 避免给不支持 disabled 枚举的家发非法值）；mode='on' 查表命中才发，未收录平台不发（UI 会提示）。
    // Anthropic 扩展思考的预算（仅 enabled+budget 写法用；adaptive 系不发这个字段）。
    // 取值依据（已查证各家 Agent 默认值）：官方最小值 1024、"从最小值往上加"；
    // Claude Code 默认「数万」量级、OpenCode 16000/31999、LiteLLM 档位 high=4096 / xhigh=8192 / max=16384。
    // 取 16384 = LiteLLM 的 max 档；**预算是上限不是指标**（官方原话："Claude might not use the entire
    // budget allocated"），所以抬高它不会凭空多花，只是允许难题多想。硬约束：必须 < max_tokens
    // （本协议默认给 32000，见 anthropicBuildRequest），且官方建议 >32K 时改走批处理（避免长请求超时）。
    var ANTHROPIC_THINKING_BUDGET = 16384;
    var THINKING_PARAM_MAP = {
        deepseek: { on: { thinking: { type: 'enabled' } } },
        zhipu: { on: { thinking: { type: 'enabled' } } },
        volcengine: { on: { thinking: { type: 'enabled' } } },
        openrouter: { on: { reasoning: { enabled: true } } },
        siliconflow: { on: { enable_thinking: true } },
        anthropic: {
            // 条目级门槛：只对 Claude 系模型生效。Anthropic 的 thinking 是厂商专用扩展，
            // 协议回退（自建/网关的 anthropic-messages 平台）若把非 Claude 模型也算进来，
            // 等于给未知模型发 Claude 专用字段——收窄到按模型名认亲，其余不发（保留强度）。
            match: /claude/i,
            on: { thinking: { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET } },
            // Claude 5 系（opus-5.x / sonnet-5.x / haiku-5.x / fable）支持 adaptive：省略 thinking
            // 字段即走 adaptive，显式 enabled+budget_tokens 会被拒。Claude 4.5 及更早不支持
            // adaptive（含 haiku-4-5）→ 仍走 enabled+budget。
            models: [
                { match: /claude-(opus-5|sonnet-5|haiku-5|sonnet-4[.-]6|fable|mythos)/i, on: { thinking: { type: 'adaptive' } }, get note() { return AEI18n.t('推荐模式'); } }
            ]
        },
        kimi: {
            on: { thinking: { type: 'enabled' } },
            // 模型级覆盖：match 命中即用该条（on:null = 恒开，无需发送任何参数）
            models: [
                { match: /^kimi-k3/, on: null, get note() { return AEI18n.t('该模型恒开，无需参数'); } },
                { match: /^kimi-k2\.7-code/, on: null, get note() { return AEI18n.t('该模型恒开且不可关'); } }
            ]
        },
        // OpenCode Go（opencode.ai/zen/go，订阅制网关）——/chat/completions 家族。
        // 该网关官方文档（opencode.ai/docs/go）不写任何 reasoning 字段；认知来自其官方数据链：
        //   ① models.dev 的 opencode-go 供应商条目（OpenCode 团队自己维护，逐模型声明 reasoning_options）
        //   ② 官方客户端对 openai-compatible 模型透传的就是 reasoning_effort
        //      （@ai-sdk/openai-compatible 把 providerOptions.reasoningEffort 直接写成请求体
        //        reasoning_effort；GLM-5.2 在官方 transform 表里亦硬编码 high/max 两档）
        //   ③ 逐模型档位（见下方 models 规则，来源同 ①）。
        // 语义：这批模型恒开思考，没有真正的「关」参数——开关的含义是「要不要强度字段」，
        // 字段的**值**取 Agent 面板的「思考」档位（low|medium|high|xhigh），按该模型声明的档位
        // 就近取整（见 snapEffort；平手取更高一档——宁可多想，也不静默削弱 Agent 的推理）。
        // 模型声明为空集 = 不吃强度字段（官方客户端也不发）→ 连面板档也一并删掉，不塞。
        'opencode-go': {
            effort: { path: ['reasoning_effort'], tiers: ['low', 'high', 'max'], fallback: 'high' },
            models: [
                // note 是给用户看的一句话（模型弹窗提示），不写实现细节
                { match: /^kimi-k3\.1/i, tiers: ['low', 'high', 'max'] },
                { match: /^kimi-k3/i, tiers: ['max'], get note() { return AEI18n.t('该模型只有 max 一档'); } },
                { match: /^glm-5\.2/i, tiers: ['high', 'max'] },
                { match: /^deepseek-v4-pro/i, tiers: ['high', 'max'] },
                { match: /^longcat/i, tiers: ['low', 'medium', 'high'] },
                // hy3 官方档位 none|low|high、hy4 官方档位 none|high（none = 关，不作为「开启」的目标档）
                { match: /^hy3/i, tiers: ['low', 'high'] },
                { match: /^hy4/i, tiers: ['high'] },
                // 声明空集 = 开关对它们什么都不做（开启不发参数、关闭也只是「不发」）→ 提示就一句话
                { match: /^(glm-5\.1|kimi-k2\.6|kimi-k2\.7-code|mimo-v2\.5)/i, tiers: [], get note() { return AEI18n.t('该模型恒开思考，开关不起作用'); } },
                // mimo-v2.6 只声明 thinking.type 开关，不声明强度档位 → 本条目按强度字段建模，不发
                { match: /^mimo-v2\.6/i, tiers: [], get note() { return AEI18n.t('该模型未声明强度档位'); } }
            ]
        },
        // OpenCode Go 的 /messages 家族（MiniMax / Qwen / Claude）——Anthropic 形状的开关。
        //   ① 官方数据条目对 qwen3.8-max/flash 注明「Toggle (Messages): thinking.type = enabled|disabled」
        //      （注释直接引用 opencode.ai/docs/go#endpoints 与阿里云 Messages 兼容文档）
        //   ② 官方客户端对 minimax-m3 发 {thinking:{type:'adaptive'}}（transform 表的 minimax-m3 分支，
        //      anthropic / openai-compatible 两种 npm 同形），关闭档是 {type:'disabled'}
        //   ③ minimax-m2.5/m2.7 无任何声明（官方客户端不发切换参数）→ 保持「不发」
        //   ④ Claude 系按版本分流：5 系（含 haiku-5）开启档是 adaptive，4.5 及更早是 enabled+budget_tokens
        'opencode-go-anthropic': {
            // 与 anthropic 条目同源的收窄思路：只对已查证的三族生效，其余模型维持手填
            match: /^(minimax|qwen|claude)/i,
            on: { thinking: { type: 'enabled' } },
            models: [
                { match: /claude-(opus-5|sonnet-5|haiku-5|fable|mythos)/i, on: { thinking: { type: 'adaptive' } }, get note() { return AEI18n.t('推荐模式'); } },
                { match: /claude/i, on: { thinking: { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET } } },
                { match: /minimax-m3/i, on: { thinking: { type: 'adaptive' } } },
                { match: /minimax-m2\.(5|7)/i, on: null, get note() { return AEI18n.t('该模型恒开思考，无需参数'); } }
            ]
        }
    };

    // ───────────── 强度档位归一：面板档位 → 模型声明的档位 ─────────────
    // 有些平台（如 OpenCode Go）没有独立的开关字段，「思考参数」就是强度字段本身，而各模型声明的
    // 档位集合又不一样（low|high|max / high|max / 只有 max / 空集）。面板只有 low|medium|high|xhigh
    // 四档，故按「就近取整」落到模型声明的档位上——落点必在声明集合内，不会发出服务端不认的档。
    var EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

    // tiers 为空/无名 → null（调用方据此不发该字段）
    function snapEffort(requested, tiers) {
        var reqIdx = EFFORT_LADDER.indexOf(String(requested || '').toLowerCase());
        if (reqIdx < 0) return null;
        var best = null;
        var bestDist = -1;
        for (var i = 0; i < (tiers || []).length; i++) {
            var t = String(tiers[i] || '').toLowerCase();
            var ti = EFFORT_LADDER.indexOf(t);
            // none/minimal 的语义是「不思考」，不作为「开启思考」的目标档（要关就关开关）
            if (ti < EFFORT_LADDER.indexOf('low')) continue;
            var d = Math.abs(ti - reqIdx);
            // 平手取更高一档
            if (best === null || d < bestDist || (d === bestDist && ti > EFFORT_LADDER.indexOf(best))) {
                best = t;
                bestDist = d;
            }
        }
        return best;
    }

    // 请求体按路径读写（本平台是顶层 reasoning_effort；Anthropic 形状是 output_config.effort）
    function _getPath(source, path) {
        var node = source;
        for (var i = 0; i < path.length; i++) {
            if (!node || typeof node !== 'object') return null;
            node = node[path[i]];
        }
        return node === undefined ? null : node;
    }

    function _putPath(target, path, value) {
        var node = target;
        for (var i = 0; i < path.length - 1; i++) {
            if (!node[path[i]] || typeof node[path[i]] !== 'object') node[path[i]] = {};
            node = node[path[i]];
        }
        node[path[path.length - 1]] = value;
    }

    function _delPath(target, path) {
        var node = target;
        for (var i = 0; i < path.length - 1; i++) {
            if (!node || typeof node !== 'object') return;
            node = node[path[i]];
        }
        if (node && typeof node === 'object') delete node[path[path.length - 1]];
    }

    // baseUrl → 主机名（不依赖 URL API，ES5 友好；去协议/凭据/端口，转小写）
    function _hostOf(baseUrl) {
        var s = String(baseUrl || '');
        var m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^\/?#]+)/i);
        var authority = m ? m[1] : s;
        authority = authority.replace(/^.*@/, '');   // 去 user:pass@
        authority = authority.split(':')[0];         // 去端口
        return authority.toLowerCase();
    }

    // 自建平台「认亲」：baseUrl 主机名与某个**内置**平台一致时（用户常「复制平台」换 Key/端点，
    // 副本 id 不在映射表里），继承该内置平台的思考映射。只认内置平台，避免用户自建之间误认；
    // 主机名对不上就返回 null（UI 提示「该平台无可用的思考参数，需要时请手动填入」）。
    // 同主机命中多个内置平台时（如 opencode.ai 同时有 /chat/completions 与 /messages 两条，
    // 参数形状完全不同）优先取协议一致的那条，避免把 A 端点的参数发给 B 端点。
    function _hostMappingKey(provider) {
        var reg = global.AE_LLM && global.AE_LLM.providerRegistry;
        if (!reg || typeof reg.listProviders !== 'function') return null;
        var host = _hostOf(provider && provider.baseUrl);
        if (!host) return null;
        var list = [];
        try { list = reg.listProviders() || []; } catch (_) { return null; }
        var hostOnly = null;
        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            if (!p || p.builtin !== true) continue;
            if (_hostOf(p.baseUrl) !== host) continue;
            if (!THINKING_PARAM_MAP[p.id]) continue;
            if (p.protocol === (provider && provider.protocol)) return p.id;
            if (hostOnly === null) hostOnly = p.id;
        }
        return hostOnly;
    }

    // 查表，三级优先：平台 id（内置平台与显式命名）→ baseUrl 主机名认亲 → anthropic 协议回退
    function _mappingEntry(provider) {
        if (!provider) return null;
        return THINKING_PARAM_MAP[provider.id]
            || THINKING_PARAM_MAP[_hostMappingKey(provider)]
            || (provider.protocol === 'anthropic-messages' ? THINKING_PARAM_MAP.anthropic : null);
    }

    // 条目内命中的模型级规则（null = 该条目没有更细的规则）
    function _mappingRule(entry, model) {
        if (!entry || !entry.models || !model) return null;
        for (var i = 0; i < entry.models.length; i++) {
            if (entry.models[i].match && entry.models[i].match.test(String(model))) return entry.models[i];
        }
        return null;
    }

    function _entryApplies(entry, model) {
        // 条目级门槛（如 anthropic 条目要求模型名像 Claude）：不满足即视为无映射
        return !(entry.match && !entry.match.test(String(model || '')));
    }

    function thinkingMappingFor(provider, model) {
        var entry = _mappingEntry(provider);
        if (!entry || !_entryApplies(entry, model)) return null;
        return _mappingRule(entry, model) || entry;
    }

    function hasThinkingMapping(provider, model) {
        return !!thinkingMappingFor(provider, model);
    }

    // 该模型条目上记的「思考模式」意图（off/on/custom）——UI 在模型管理「编辑模型能力」里
    function modelThinkingIntent(provider, model) {
        if (!provider || !model) return { mode: 'off', custom: {} };
        var models = provider.models || [];
        for (var i = 0; i < models.length; i++) {
            if (models[i] && models[i].id === model) {
                var t = models[i].thinking;
                if (t && typeof t === 'object') {
                    return { mode: t.mode || 'off', custom: t.custom || {} };
                }
                break;
            }
        }
        return { mode: 'off', custom: {} };
    }

    // 该模型当前生效的「强度字段」描述（null = 本平台不做强度归一）：
    //   { path: ['reasoning_effort'], tiers: [...], fallback: 'high' }
    // tiers 为空数组 = 该模型不吃强度字段（构建时会把面板档一并删掉）。
    function thinkingEffortFor(provider, model) {
        var entry = _mappingEntry(provider);
        if (!entry || !entry.effort || !_entryApplies(entry, model)) return null;
        var rule = _mappingRule(entry, model);
        var tiers = (rule && rule.tiers !== undefined) ? rule.tiers : entry.effort.tiers;
        return {
            path: entry.effort.path,
            tiers: tiers || [],
            fallback: entry.effort.fallback || 'high'
        };
    }

    // 预演：假设「思考」已开启，给定面板档位会发什么（**不看模型当前意图**，UI 提示专用）。
    // 返回对象（可能为 {}：映射命中但什么都不发）；无映射平台返回 null。
    function thinkingPreviewFor(provider, model, effort) {
        var entry = _mappingEntry(provider);
        if (!entry || !_entryApplies(entry, model)) return null;
        var rule = _mappingRule(entry, model);
        var src = rule || entry;
        var out = src.on ? JSON.parse(JSON.stringify(src.on)) : {};
        if (entry.effort) {
            var v = snapEffort(effort || entry.effort.fallback, (rule && rule.tiers !== undefined) ? rule.tiers : entry.effort.tiers);
            if (v) _putPath(out, entry.effort.path, v);
        }
        return out;
    }

    // 该平台/模型当前该发什么思考参数（null = 不发）；请求构建用。
    // effort = 面板「思考」档位（可省；省了用条目声明的 fallback）。
    function thinkingParamsFor(provider, model, effort) {
        if (!provider) return null;
        var intent = modelThinkingIntent(provider, model);
        if (intent.mode === 'custom') {
            // 空对象视为「没填参数」→ 不发送（避免往请求体塞空壳）
            if (!intent.custom || typeof intent.custom !== 'object' || !Object.keys(intent.custom).length) return null;
            return intent.custom;
        }
        if (intent.mode !== 'on') return null;
        var out = thinkingPreviewFor(provider, model, effort);
        return (out && Object.keys(out).length) ? out : null;
    }

    function thinkingNoteFor(provider, model) {
        var mapping = thinkingMappingFor(provider, model);
        if (mapping && mapping.note) return mapping.note;
        return '';
    }

    // 面板四档（与 index.html 的 thinking-strip 同序）——提示语里按这个顺序描述映射
    var PANEL_EFFORT_LEVELS = [['LOW', 'low'], ['MEDIUM', 'medium'], ['HIGH', 'high'], ['XHIGH', 'xhigh']];

    // 强度跟随型平台的「留空会发什么」：用户必须能一眼看出档位会变成什么值。
    //   四档结果相同（如 k3 只有 max）→ 直接给具体值：{"reasoning_effort":"max"}
    //   否则 → 声明档位占位 + 逐档映射：{"reasoning_effort":"low|high|max"}（思考等级映射：LOW→low、…）
    //   声明为空集 → {}（什么都不发）
    function _effortPreviewText(provider, model) {
        var eff = thinkingEffortFor(provider, model);
        var tiers = eff.tiers;
        if (!tiers.length) return '{}';
        var values = [];
        var same = true;
        for (var i = 0; i < PANEL_EFFORT_LEVELS.length; i++) {
            var preview = thinkingPreviewFor(provider, model, PANEL_EFFORT_LEVELS[i][1]) || {};
            var v = _getPath(preview, eff.path);
            values.push(v);
            if (v !== values[0]) same = false;
        }
        if (same) {
            var one = {};
            _putPath(one, eff.path, values[0]);
            return JSON.stringify(one);
        }
        var shape = {};
        _putPath(shape, eff.path, tiers.join('|'));
        var mapping = [];
        for (var j = 0; j < PANEL_EFFORT_LEVELS.length; j++) {
            mapping.push(PANEL_EFFORT_LEVELS[j][0] + '→' + values[j]);
        }
        return JSON.stringify(shape) + AEI18n.t('（思考等级映射：{map}）', { map: mapping.join(AEI18n.punct('、', ', ')) });
    }

    // 模型弹窗「思考」提示语：留空 = 发送本平台预设参数（把将发的 JSON 摊给用户看，
    // 强度跟随型平台额外逐档说明会变成什么值）；填了 = 原样并入请求体。
    function thinkingHintFor(provider, model, custom) {
        if (custom && typeof custom === 'object' && Object.keys(custom).length) {
            return AEI18n.t('将发送自定义参数（覆盖预设）：') + JSON.stringify(custom);
        }
        var entry = _mappingEntry(provider);
        if (!entry || !_entryApplies(entry, model)) return AEI18n.t('该平台无可用的思考参数，需要时请手动填入。');
        var note = thinkingNoteFor(provider, model);
        var tail = note ? (AEI18n.punct('（', ' (') + note + AEI18n.punct('）', ')')) : '';
        if (entry.effort) {
            return AEI18n.t('留空则发送本平台预设参数：') + _effortPreviewText(provider, model) + tail;
        }
        var on = (_mappingRule(entry, model) || entry).on;
        if (on) return AEI18n.t('留空则发送本平台预设参数：') + JSON.stringify(on) + tail;
        // 映射命中但什么都不发（恒开模型）→ JSON 语义就是空对象，照样摊给用户看
        if (note) return AEI18n.t('留空则发送本平台预设参数：') + '{}' + tail;
        return AEI18n.t('该平台无可用的思考参数，需要时请手动填入。');
    }

    // 模型名是否命中「按前缀省略 temperature」清单（网关上一个端点可能混跑 Claude 与非 Claude 模型）
    function _matchesModelPrefix(model, prefixes) {
        if (!prefixes || !prefixes.length) return false;
        var m = String(model || '');
        for (var i = 0; i < prefixes.length; i++) {
            var p = String(prefixes[i] || '');
            if (p && m.indexOf(p) === 0) return true;
        }
        return false;
    }

    function applyRequestOptions(body, provider, model) {
        if (!body || !provider) return body;
        var opts = provider.requestOptions || {};
        if (opts.omitTemperature || _matchesModelPrefix(model, opts.omitTemperaturePrefixes)) {
            delete body.temperature;
        }
        // 思考模式=关闭 → 连「思考等级」也不发（思考都关了，
        // 强度字段无意义，且严格服务端可能因「不支持推理的模型带 reasoning_effort」直接 400）。
        // 想要强度旋钮就把该模型思考模式设为「开启/自定义」——对本平台无内置映射时，
        // 「开启」不会多发任何参数，只保留强度字段。
        var intent = modelThinkingIntent(provider, model);
        if (intent.mode === 'off') {
            delete body.reasoning_effort;
            delete body.output_config;
        }
        // 强度档归一：把面板档位就近落到该模型声明的档位上（值来自请求体里面板带过来的那一档）。
        // 只对「开启」生效——「关闭」上面已清、「自定义」表示用户全手控（不替他改值）。
        var effortDesc = (intent.mode === 'on') ? thinkingEffortFor(provider, model) : null;
        var panelEffort = effortDesc ? _getPath(body, effortDesc.path) : null;
        // 思考模式：先生成再让 extraBody 覆盖（extraBody 是最高优先级的逃生舱）
        var thinkingParams = thinkingParamsFor(provider, model, panelEffort);
        if (thinkingParams) {
            for (var tk in thinkingParams) {
                if (Object.prototype.hasOwnProperty.call(thinkingParams, tk)) body[tk] = thinkingParams[tk];
            }
        }
        if (effortDesc && !effortDesc.tiers.length) {
            // 该模型声明档位为空集（不吃强度字段）→ 连面板档一起不发，别给不支持的模型塞字段
            _delPath(body, effortDesc.path);
        }
        if (opts.extraBody) {
            for (var key in opts.extraBody) {
                if (opts.extraBody.hasOwnProperty(key)) {
                    body[key] = opts.extraBody[key];
                }
            }
        }
        return body;
    }

    function _buildOpenAICompatibleRequest(ctx) {
        var body = {
            model: ctx.model || '',
            messages: ctx.messages || [],
            stream: ctx.stream !== false
        };
        // 流式请求带上 stream_options.include_usage，让 OpenAI 兼容服务端在最后一帧返回 usage
        // DeepSeek/OpenAI/o1 等均支持；不支持该字段的服务端会原样忽略，无副作用
        if (body.stream) {
            body.stream_options = { include_usage: true };
        }
        if (ctx.temperature !== undefined && ctx.temperature !== null) {
            body.temperature = ctx.temperature;
        }
        if (ctx.maxTokens) {
            body.max_tokens = ctx.maxTokens;
        }
        if (ctx.tools && ctx.tools.length > 0) {
            body.tools = ctx.tools;
        }
        if (ctx.toolChoice) {
            body.tool_choice = ctx.toolChoice;
        }
        if (ctx.responseFormat) {
            body.response_format = ctx.responseFormat;
        }
        if (ctx.reasoningEffort) {
            body.reasoning_effort = ctx.reasoningEffort;
        }
        if (ctx.provider) {
            body = applyRequestOptions(body, ctx.provider, ctx.model);
        }
        return body;
    }

    function parseOpenAiSseLine(line) {
        // SSE 规范允许 'data:' 后无空格（前导空格至多一个，需剥离），无空格帧同样合法
        if (line.indexOf('data:') !== 0) return null;
        var dataStr = line.slice(5);
        if (dataStr.charAt(0) === ' ') dataStr = dataStr.slice(1);
        dataStr = dataStr.trim();
        if (dataStr === '[DONE]') return { done: true };
        try { return JSON.parse(dataStr); } catch (_) { return null; }
    }

    function processOpenAiStreamEvent(deltaObj, state, callbacks) {
        if (!deltaObj) return;

        // OpenAI 兼容协议：流式 usage 出现在最后一帧（与 choices 同级，可能 choices 为空数组）
        // 字段：prompt_tokens / completion_tokens / total_tokens
        // 缓存命中：OpenAI 兼容用 prompt_tokens_details.cached_tokens，DeepSeek 用 prompt_cache_hit_tokens
        if (deltaObj.usage && typeof deltaObj.usage === 'object') {
            var u = deltaObj.usage;
            var cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens);
            if (cached === undefined || cached === null) cached = u.prompt_cache_hit_tokens;
            if (cached === undefined || cached === null) cached = 0;
            state.usage = {
                prompt_tokens: u.prompt_tokens || 0,
                completion_tokens: u.completion_tokens || 0,
                total_tokens: u.total_tokens || 0,
                cache_hit_tokens: cached
            };
        }

        if (!deltaObj.choices || !deltaObj.choices[0]) return;
        var choice = deltaObj.choices[0];
        var delta = choice.delta || {};

        if (typeof delta.content === 'string' && delta.content.length > 0) {
            state.content += delta.content;
            if (callbacks.onToken) callbacks.onToken(delta.content, state.content);
        }
        // 思考增量双读：DeepSeek 系（含智谱/火山等 OpenAI 兼容网关）用 reasoning_content；
        // OpenRouter 家族（请求侧发的就是 reasoning:{enabled:true}，见 THINKING_PARAM_MAP）
        // 与部分网关用 reasoning 承载同一语义——只认前者时思考整段丢弃、气泡恒空。
        // reasoning_content 优先：同帧两字段都有时只取前者，不重复累加。
        // reasoning_details 数组形态（元素 text 拼接）离线无真实报文佐证，且 OpenRouter
        // 文档中它与 reasoning 并存（结构化镜像）同读会重复计数 → 保守不实现，待真机抓包确认。
        var reasoningDelta = '';
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            reasoningDelta = delta.reasoning_content;
        } else if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
            reasoningDelta = delta.reasoning;
        }
        if (reasoningDelta) {
            state.reasoningContent += reasoningDelta;
            if (callbacks.onReasoning) callbacks.onReasoning(reasoningDelta, state.reasoningContent);
        }
        if (Array.isArray(delta.tool_calls)) {
            for (var i = 0; i < delta.tool_calls.length; i++) {
                var tc = delta.tool_calls[i];
                var idx = tc.index !== undefined ? String(tc.index) : '0';
                if (!state.toolCallsAccum[idx]) {
                    state.toolCallsAccum[idx] = { id: tc.id || '', name: '', arguments: '' };
                }
                if (tc.id) state.toolCallsAccum[idx].id = tc.id;
                if (tc.function) {
                    // name 改覆盖式赋值——标准协议只在首帧携带 name（后续帧为空），
                    // 覆盖与追加等价；「每帧重发完整 name」的服务端经 += 会产出重复工具名
                    //（如 get_weatherget_weather）致调用链失效。arguments 保持增量拼接不变。
                    if (tc.function.name) state.toolCallsAccum[idx].name = tc.function.name;
                    if (tc.function.arguments) state.toolCallsAccum[idx].arguments += tc.function.arguments;
                }
            }
        }
        if (choice.finish_reason) state.finishReason = choice.finish_reason;
    }

    function finalizeOpenAiToolCalls(toolCallsAccum) {
        var result = [];
        // 数字序排序：索引可能超过 9（多 tool call 场景），字典序会把 '10' 排在 '2' 前面
        var keys = Object.keys(toolCallsAccum).sort(function(a, b) { return Number(a) - Number(b); });
        for (var i = 0; i < keys.length; i++) {
            var tc = toolCallsAccum[keys[i]];
            if (tc.name) {
                result.push({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments }
                });
            }
        }
        return result.length > 0 ? result : null;
    }

    function parseOpenAiJsonResponse(data) {
        if (!data || !data.choices || !data.choices[0]) {
            if (data && data.result) {
                return { content: typeof data.result === 'string' ? data.result : JSON.stringify(data.result) };
            }
            return { content: '', error: 'EMPTY_RESPONSE', message: AEI18n.t('模型返回为空') };
        }

        var msg = data.choices[0].message;
        if (!msg) {
            if (data.choices[0].text !== undefined) return { content: String(data.choices[0].text) };
            return { content: '' };
        }

        var content = '';
        // 思考字段双读（与流式同一优先级）：reasoning_content（DeepSeek 系）优先，reasoning
        // （OpenRouter 系）兜底；两字段都有时只取前者。返回值携带 reasoningContent 供消费侧
        // （service.requestChat / controller 工具轮）落盘思考，非流式不再整段丢弃。
        var reasoningContent = '';
        if (typeof msg.reasoning_content === 'string') reasoningContent = msg.reasoning_content;
        else if (typeof msg.reasoning === 'string') reasoningContent = msg.reasoning;

        if (typeof msg.content === 'string') {
            content = msg.content;
        } else if (Array.isArray(msg.content)) {
            content = msg.content
                .filter(function(p) { return p && p.type === 'text' && typeof p.text === 'string'; })
                .map(function(p) { return p.text; })
                .join('');
        } else if (msg.content === null || msg.content === undefined) {
            // 保留原判据（typeof 判 string 而非真值）：reasoning_content 为空串时同样命中，
            // 不走 refusal 分支——DeepSeek 既有行为逐字节不变；reasoning 仅在其缺席时兜底。
            if (typeof msg.reasoning_content === 'string') content = msg.reasoning_content;
            else if (typeof msg.reasoning === 'string') content = msg.reasoning;
            else if (typeof msg.refusal === 'string' && msg.refusal) content = '[REFUSAL] ' + msg.refusal;
        } else {
            content = String(msg.content || '');
        }

        var toolCalls = null;
        if (Array.isArray(msg.tool_calls)) {
            toolCalls = finalizeOpenAiToolCalls(msg.tool_calls.reduce(function(acc, tc, i) {
                // 扁平化 API 原始嵌套结构 {function:{name,arguments}} 为 {name,arguments}
                acc[String(i)] = {
                    id: tc.id,
                    name: tc.function ? tc.function.name : tc.name,
                    arguments: tc.function ? tc.function.arguments : tc.arguments
                };
                return acc;
            }, {}));
        }

        return { content: content, reasoningContent: reasoningContent, toolCalls: toolCalls };
    }

    function registerAdapter(protocol, adapter) {
        _adapters[protocol] = adapter;
    }

    function getAdapter(protocol) {
        var adapter = _adapters[protocol];
        if (adapter && typeof adapter.buildRequest === 'function') {
            return adapter;
        }
        return _adapters['openai-compatible'];
    }

    // SSE 事件装配器——SSE 规范（WHATWG）规定事件以空行分隔，同一事件内多个
    // data: 行以 \n 连接成一个完整 payload。逐行独立 parse 时，规范合规的多行
    // data 拆分编码（大 JSON 按行切片的网关/代理产物）每行 JSON.parse 必失败，事件被
    // 静默丢失。装配器按空行边界累积 data 行后合并成单帧，再复用适配器既有 parseSseLine
    // 解析合并 payload（[DONE]/message_stop 哨兵语义不变）；event/id 字段按规范解析并
    // 随分发结果透出（sseEvent/sseId），冒号开头的注释行忽略，行尾 \r 按 CRLF 规范剥离。
    function createSseEventAssembler(parseSseLine) {
        var dataLines = null;   // null = 当前无未分派的待发事件
        var eventName = '';
        var lastEventId = '';

        function dispatch() {
            var payload = dataLines.join('\n');
            dataLines = null;
            var parsed = parseSseLine('data: ' + payload);
            var dispatchedEvent = eventName;
            eventName = '';
            if (parsed && dispatchedEvent) parsed.sseEvent = dispatchedEvent;
            if (parsed && lastEventId) parsed.sseId = lastEventId;
            return parsed;
        }

        return {
            // 逐行投喂；遇空行（事件边界）返回该事件的解析结果，其余时候返回 null
            feed: function (line) {
                if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
                if (line === '') {
                    return dataLines ? dispatch() : null;
                }
                if (line.charAt(0) === ':') return null;
                var colon = line.indexOf(':');
                var field = colon === -1 ? line : line.slice(0, colon);
                var value = colon === -1 ? '' : line.slice(colon + 1);
                if (value.charAt(0) === ' ') value = value.slice(1);
                if (field === 'data') {
                    if (!dataLines) dataLines = [];
                    dataLines.push(value);
                } else if (field === 'event') {
                    eventName = value;
                } else if (field === 'id' && value.indexOf('\u0000') === -1) {
                    // 规范：id 值含 U+0000 时须忽略
                    lastEventId = value;
                }
                return null;
            },
            // 流结束冲刷：无尾随空行的最后一个事件也须分发
            flush: function () {
                return dataLines ? dispatch() : null;
            }
        };
    }

    registerAdapter('openai-compatible', {
        buildRequest: _buildOpenAICompatibleRequest,
        parseSseLine: parseOpenAiSseLine,
        processStreamEvent: processOpenAiStreamEvent,
        finalizeToolCalls: finalizeOpenAiToolCalls,
        parseJsonResponse: parseOpenAiJsonResponse
    });

    function mapAnthropicStopReason(stopReason) {
        var map = {
            'end_turn': 'stop',
            'tool_use': 'tool_calls',
            'max_tokens': 'length',
            'refusal': 'refusal',
            'pause_turn': 'pause_turn'
        };
        return map[stopReason] || stopReason || 'stop';
    }

    function _convertOpenAiMessagesToAnthropic(messages, systemPrompt) {
        var result = [];
        var systemParts = [];
        if (systemPrompt) systemParts.push(systemPrompt);

        for (var i = 0; i < messages.length; i++) {
            var msg = messages[i];
            if (msg.role === 'system') {
                if (typeof msg.content === 'string') {
                    systemParts.push(msg.content);
                } else if (Array.isArray(msg.content)) {
                    for (var j = 0; j < msg.content.length; j++) {
                        var p = msg.content[j];
                        if (p && p.type === 'text' && typeof p.text === 'string') {
                            systemParts.push(p.text);
                        }
                    }
                }
                continue;
            }

            var contentBlocks = [];
            if (msg.role === 'user') {
                if (typeof msg.content === 'string') {
                    contentBlocks.push({ type: 'text', text: msg.content });
                } else if (Array.isArray(msg.content)) {
                    for (var k = 0; k < msg.content.length; k++) {
                        var block = msg.content[k];
                        if (block.type === 'text') {
                            contentBlocks.push({ type: 'text', text: block.text });
                        } else if (block.type === 'image_url' && block.image_url) {
                            var url = block.image_url.url || '';
                            if (url.indexOf('data:') === 0) {
                                var parts = url.split(',');
                                var header = parts[0] || '';
                                var data = parts[1] || '';
                                var mediaType = 'image/png';
                                var match = header.match(/data:([^;]+)/);
                                if (match) mediaType = match[1];
                                contentBlocks.push({
                                    type: 'image',
                                    source: { type: 'base64', media_type: mediaType, data: data }
                                });
                            } else if (/^https?:\/\//i.test(url)) {
                                // Anthropic 支持 url source（https 公共 URL 直接引用）；
                                // http 明文 URL 服务端可能拒绝，照常转换并提示，不再静默丢弃
                                contentBlocks.push({
                                    type: 'image',
                                    source: { type: 'url', url: url }
                                });
                                if (/^http:\/\//i.test(url)) {
                                    console.warn('[LLM] Anthropic 图片使用 http 明文 URL，服务端可能拒绝: ' + url);
                                }
                            } else {
                                console.warn('[LLM] 无法转换的图片地址（仅支持 data: base64 或 http(s) URL），已跳过: ' + url);
                            }
                        }
                    }
                }
            } else if (msg.role === 'assistant') {
                if (typeof msg.content === 'string' && msg.content) {
                    contentBlocks.push({ type: 'text', text: msg.content });
                } else if (Array.isArray(msg.content)) {
                    for (var l = 0; l < msg.content.length; l++) {
                        var ab = msg.content[l];
                        if (ab && ab.type === 'text' && typeof ab.text === 'string') {
                            contentBlocks.push({ type: 'text', text: ab.text });
                        }
                    }
                }
                if (Array.isArray(msg.tool_calls)) {
                    for (var tcIdx = 0; tcIdx < msg.tool_calls.length; tcIdx++) {
                        var tc = msg.tool_calls[tcIdx];
                        var input = {};
                        try {
                            if (tc.function && tc.function.arguments) {
                                input = JSON.parse(tc.function.arguments);
                            }
                        } catch (_) {}
                        contentBlocks.push({
                            type: 'tool_use',
                            id: tc.id || '',
                            name: tc.function && tc.function.name ? tc.function.name : '',
                            input: input
                        });
                    }
                }
            } else if (msg.role === 'tool') {
                var toolContent = msg.content;
                if (typeof toolContent === 'object' && toolContent !== null) {
                    toolContent = JSON.stringify(toolContent);
                } else {
                    toolContent = String(toolContent || '');
                }
                var toolResult = {
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id || '',
                    content: toolContent
                };
                if (msg.is_error) {
                    toolResult.is_error = true;
                }
                contentBlocks.push(toolResult);
            }

            if (contentBlocks.length > 0) {
                var targetRole = msg.role === 'tool' ? 'user' : msg.role;
                if (result.length > 0 && result[result.length - 1].role === targetRole) {
                    result[result.length - 1].content = result[result.length - 1].content.concat(contentBlocks);
                } else {
                    result.push({ role: targetRole, content: contentBlocks });
                }
            }
        }

        return {
            system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
            messages: result
        };
    }

    function _convertOpenAiToolsToAnthropic(tools) {
        if (!tools || !tools.length) return undefined;
        var result = [];
        for (var i = 0; i < tools.length; i++) {
            var t = tools[i];
            if (t.type === 'function' && t.function) {
                result.push({
                    name: t.function.name || '',
                    description: t.function.description || '',
                    input_schema: t.function.parameters || { type: 'object', properties: {} }
                });
            }
        }
        return result.length > 0 ? result : undefined;
    }

    function anthropicBuildRequest(ctx) {
        var provider = ctx.provider || {};
        var defaults = provider.defaults || {};
        var converted = _convertOpenAiMessagesToAnthropic(ctx.messages || [], ctx.system);

        var body = {
            model: ctx.model || '',
            // 默认 32000：要容下思考预算（ANTHROPIC_THINKING_BUDGET，必须 < max_tokens）并给正文留half。
            // 两个附带约束：>21333 必须流式（本协议恒流式 ✔）；prompt + max_tokens 不得超上下文窗口
            // （200K 窗口下留给 prompt 的上限从 184K 降到 168K，仍远大于我们自己的上下文预算）。
            max_tokens: ctx.maxTokens || defaults.maxTokens || 32000,
            messages: converted.messages,
            stream: ctx.stream !== false
        };

        if (converted.system) body.system = converted.system;

        // Anthropic 协议无原生 response_format，jsonMode（上游置 ctx.responseFormat
        // = {type:'json_object'}）若被本分支忽略——勾选后请求实际无任何 JSON 约束，
        // 结构化功能静默失效。按 jsonMode 注入 system 约束文本替代 API 级强制：要求只输出
        // 合法 JSON、不加 markdown 代码围栏。选择在协议适配层实现而非 view.js 按协议禁用
        // 勾选：UI 禁用需维护「协议 × 能力」枚举矩阵（能力编辑器与协议清单双处同步，新增
        // 协议即漏），适配层按 ctx 标记兜底是单一职责出口，各协议自行决定约束手段。
        if (ctx.responseFormat) {
            var jsonConstraint = '输出格式硬性要求：只输出一个合法的 JSON 值，禁止添加 markdown 代码围栏（```）、解释性文字或 JSON 以外的任何内容。';
            body.system = body.system ? (body.system + '\n\n' + jsonConstraint) : jsonConstraint;
        }

        // Anthropic 协议 temperature 字段名与 OpenAI 一致（max_tokens 为蛇形，已在上方）
        if (ctx.temperature !== undefined && ctx.temperature !== null) {
            body.temperature = ctx.temperature;
        }

        var tools = _convertOpenAiToolsToAnthropic(ctx.tools);
        if (tools) {
            body.tools = tools;
            body.tool_choice = { type: 'auto' };
        }

        if (defaults.thinking !== undefined) {
            body.thinking = defaults.thinking;
        }
        if (defaults.effort !== undefined) {
            body.output_config = { effort: defaults.effort };
        }
        if (ctx.reasoningEffort && !body.output_config) {
            body.output_config = { effort: ctx.reasoningEffort };
        }

        return applyRequestOptions(body, provider, ctx.model);
    }

    function parseAnthropicSseLine(line) {
        // 对齐 parseOpenAiSseLine：SSE 规范允许 'data:' 后无空格（前导空格至多一个，需剥离），无空格帧同样合法
        if (line.indexOf('data:') !== 0) return null;
        var dataStr = line.slice(5);
        if (dataStr.charAt(0) === ' ') dataStr = dataStr.slice(1);
        dataStr = dataStr.trim();
        try {
            var eventObj = JSON.parse(dataStr);
            // message_stop 是 Anthropic 流式终止事件，置 done 哨兵对齐 OpenAI
            // [DONE] 的出口写法——适配器无 done 出口时流式循环只能等服务端关连接，
            // 代理对 SSE 保活下已完整输出的回答会被空闲超时误判 REQUEST_TIMEOUT
            if (eventObj && eventObj.type === 'message_stop') return { done: true };
            return eventObj;
        } catch (_) { return null; }
    }

    function processAnthropicStreamEvent(eventObj, state, callbacks) {
        if (!eventObj || !eventObj.type) return;

        var type = eventObj.type;

        if (type === 'content_block_start') {
            var block = eventObj.content_block;
            var idx = String(eventObj.index || 0);
            if (block.type === 'text') {
                if (!state._contentBlocks) state._contentBlocks = {};
                state._contentBlocks[idx] = { type: 'text', text: '' };
            } else if (block.type === 'thinking') {
                if (!state._thinkingBlocks) state._thinkingBlocks = {};
                state._thinkingBlocks[idx] = { type: 'thinking', thinking: '' };
            } else if (block.type === 'tool_use') {
                if (!state._toolBlocks) state._toolBlocks = {};
                state._toolBlocks[idx] = { id: block.id || '', name: block.name || '', input: '' };
            }
        } else if (type === 'content_block_delta') {
            var idx = String(eventObj.index || 0);
            var delta = eventObj.delta || {};
            if (delta.type === 'text_delta') {
                if (state._contentBlocks && state._contentBlocks[idx]) {
                    state._contentBlocks[idx].text += delta.text || '';
                }
                if (typeof delta.text === 'string' && delta.text.length > 0) {
                    state.content += delta.text;
                    if (callbacks.onToken) callbacks.onToken(delta.text, state.content);
                }
            } else if (delta.type === 'thinking_delta') {
                if (state._thinkingBlocks && state._thinkingBlocks[idx]) {
                    state._thinkingBlocks[idx].thinking += delta.thinking || '';
                }
                if (typeof delta.thinking === 'string' && delta.thinking.length > 0) {
                    state.reasoningContent += delta.thinking;
                    if (callbacks.onReasoning) callbacks.onReasoning(delta.thinking, state.reasoningContent);
                }
            } else if (delta.type === 'input_json_delta') {
                if (state._toolBlocks && state._toolBlocks[idx]) {
                    state._toolBlocks[idx].input += delta.partial_json || '';
                }
            }
        } else if (type === 'content_block_stop') {
            var idx = String(eventObj.index || 0);
            if (state._toolBlocks && state._toolBlocks[idx]) {
                var tb = state._toolBlocks[idx];
                state.toolCallsAccum[idx] = {
                    id: tb.id,
                    name: tb.name,
                    arguments: tb.input || '{}'
                };
            }
        } else if (type === 'message_delta') {
            if (eventObj.delta && eventObj.delta.stop_reason) {
                state.finishReason = mapAnthropicStopReason(eventObj.delta.stop_reason);
            }
            // Anthropic 流式：message_delta 事件携带 output_tokens
            // 字段名：usage.output_tokens（cumulative）
            if (eventObj.usage && typeof eventObj.usage === 'object') {
                var prevUsage = state.usage || {};
                state.usage = {
                    prompt_tokens: prevUsage.prompt_tokens || (eventObj.usage.input_tokens || 0),
                    completion_tokens: eventObj.usage.output_tokens || 0,
                    total_tokens: (prevUsage.prompt_tokens || (eventObj.usage.input_tokens || 0))
                        + (eventObj.usage.output_tokens || 0)
                };
            }
        } else if (type === 'message_start') {
            // Anthropic 流式：message_start 事件含 input_tokens（output_tokens 此处为 0 或缺失）
            var msg = eventObj.message;
            if (msg && msg.usage && typeof msg.usage === 'object') {
                var inputTokens = msg.usage.input_tokens || 0;
                state.usage = {
                    prompt_tokens: inputTokens,
                    completion_tokens: 0,
                    total_tokens: inputTokens
                };
            }
        } else if (type === 'message_stop') {
        }
    }

    function finalizeAnthropicToolCalls(toolCallsAccum) {
        return finalizeOpenAiToolCalls(toolCallsAccum);
    }

    function parseAnthropicJsonResponse(data) {
        if (!data || !data.content) {
            return { content: '', error: 'EMPTY_RESPONSE', message: AEI18n.t('模型返回为空') };
        }

        var content = '';
        var reasoningContent = '';
        var toolCallsAccum = {};

        for (var i = 0; i < data.content.length; i++) {
            var block = data.content[i];
            if (block.type === 'text') {
                content += block.text || '';
            } else if (block.type === 'thinking') {
                reasoningContent += block.thinking || '';
            } else if (block.type === 'tool_use') {
                var idx = String(i);
                toolCallsAccum[idx] = {
                    id: block.id || '',
                    name: block.name || '',
                    arguments: JSON.stringify(block.input || {})
                };
            }
        }

        var result = {
            content: content,
            reasoningContent: reasoningContent,
            toolCalls: finalizeAnthropicToolCalls(toolCallsAccum)
        };

        if (data.stop_reason) {
            result.finishReason = mapAnthropicStopReason(data.stop_reason);
        }

        return result;
    }

    registerAdapter('anthropic-messages', {
        buildRequest: anthropicBuildRequest,
        parseSseLine: parseAnthropicSseLine,
        processStreamEvent: processAnthropicStreamEvent,
        finalizeToolCalls: finalizeAnthropicToolCalls,
        parseJsonResponse: parseAnthropicJsonResponse
    });

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.protocolAdapters = {
        makeHeaders: makeHeaders,
        applyRequestOptions: applyRequestOptions,
        // 思考模式：查表/参数生成/提示文案（模型管理的平台编辑器与请求构建共用一套真相源）
        thinkingMappingFor: thinkingMappingFor,
        hasThinkingMapping: hasThinkingMapping,
        thinkingParamsFor: thinkingParamsFor,
        thinkingNoteFor: thinkingNoteFor,
        thinkingEffortFor: thinkingEffortFor,
        thinkingPreviewFor: thinkingPreviewFor,
        thinkingHintFor: thinkingHintFor,
        registerAdapter: registerAdapter,
        getAdapter: getAdapter,
        createSseEventAssembler: createSseEventAssembler
    };
})(window);
