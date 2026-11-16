(function (global) {
    'use strict';

    var BUILTIN_LLM_PROVIDERS = [
        {
            id: 'openai',
            label: 'OpenAI',
            builtin: true,
            enabled: true,
            protocol: 'openai-compatible',
            baseUrl: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            apiKeyField: 'openaiApiKey',
            auth: { type: 'bearer' },
            headers: {},
            defaults: {},
            requestOptions: {
                // GPT-6 / GPT-5 系列推理模型不接受 temperature（忽略/报错），由 reasoning_effort 控制；
                // 平台级省略，gpt-4o-mini 同样不发送
                omitTemperature: true
            },
            modelDiscovery: {
                enabled: true,
                endpoint: '/v1/models'
            },
            models: [
                { id: 'gpt-6.1-terra', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'gpt-6.1-sol', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'gpt-6-sol', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'gpt-6-luna', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                // 非推理模型：不标思考（发送 reasoning_effort 会被拒）
                { id: 'gpt-4o-mini', capabilities: { vision: true, jsonMode: true, tools: true, stream: true } }
            ]
        },
        {
            id: 'openrouter',
            label: 'OpenRouter',
            builtin: true,
            enabled: true,
            protocol: 'openai-compatible',
            baseUrl: 'https://openrouter.ai',
            endpoint: '/api/v1/chat/completions',
            apiKeyField: 'openrouterApiKey',
            auth: { type: 'bearer' },
            headers: {},
            defaults: {},
            requestOptions: {
                // 网关会把 temperature 透传给上游：Claude / GPT-6 系不接受，其它模型照常带
                omitTemperaturePrefixes: ['anthropic/claude', 'openai/gpt-6', 'openai/gpt-5']
            },
            modelDiscovery: {
                enabled: true,
                endpoint: '/api/v1/models'
            },
            models: [
                { id: 'openai/gpt-6.1-terra', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                // Claude 5.x 省略 thinking 字段即走 adaptive（AWS Bedrock 文档）；
                // Gemini 4.x 默认思考且不可关闭（Google 官方 cookbook）——都属于「恒开」，故标 on。
                { id: 'anthropic/claude-opus-5.5', capabilities: { vision: true, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'anthropic/claude-sonnet-5.5', capabilities: { vision: true, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'google/gemini-4-argon', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'deepseek/deepseek-v4.1-flash', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'moonshotai/kimi-k3.1-pro', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } }
            ]
        },
        {
            id: 'deepseek',
            label: 'DeepSeek',
            builtin: true,
            enabled: true,
            protocol: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com',
            endpoint: '/v1/chat/completions',
            apiKeyField: 'deepseekApiKey',
            auth: { type: 'bearer' },
            headers: {},
            defaults: {},
            requestOptions: {
                omitTemperature: true
                // 思考参数不再在这里硬编码：改由模型条目的 thinking 意图 + protocolAdapters
                // 的映射表生成（用户可在模型管理「编辑模型能力」里改，extraBody 仍作为逃生舱保留）
            },
            modelDiscovery: {
                enabled: true,
                endpoint: '/v1/models'
            },
            models: [
                // capabilities.thinking=true：该模型会产出思考内容（「思考回传保护」的声明来源之一，
                // 见 providerRegistry.supportsThinking）。
                // thinking.mode='on'：请求时按内置映射发送原生思考参数（DeepSeek 为
                // {"thinking":{"type":"enabled"}}，见 protocolAdapters 的 THINKING_PARAM_MAP）——
                // 思考参数由 thinking.mode 驱动，不在 requestOptions.extraBody.thinking 硬编码；用户可在模型管理里改。
                { id: 'deepseek-v4-pro', capabilities: { vision: false, jsonMode: true, tools: true, stream: true, thinking: true }, thinking: { mode: 'on' } },
                { id: 'deepseek-flash', capabilities: { vision: true, jsonMode: true, tools: true, stream: true, thinking: true }, thinking: { mode: 'on' } }
            ]
        },
        {
            id: 'siliconflow',
            label: 'SiliconFlow',
            builtin: true,
            enabled: true,
            protocol: 'openai-compatible',
            baseUrl: 'https://api.siliconflow.cn',
            endpoint: '/v1/chat/completions',
            apiKeyField: 'siliconflowApiKey',
            auth: { type: 'bearer' },
            headers: {},
            defaults: {},
            requestOptions: {},
            modelDiscovery: {
                enabled: true,
                endpoint: '/v1/models'
            },
            models: [
                { id: 'deepseek-ai/DeepSeek-V4-Pro', capabilities: { vision: false, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'deepseek-ai/DeepSeek-V4-Flash', capabilities: { vision: false, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'zai-org/GLM-5.3', capabilities: { vision: false, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'Qwen/Qwen3.6-27B', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } }
            ]
        },
        {
            id: 'kimi',
            label: 'Kimi',
            builtin: true,
            enabled: true,
            protocol: 'openai-compatible',
            baseUrl: 'https://api.moonshot.cn',
            endpoint: '/v1/chat/completions',
            apiKeyField: 'kimiApiKey',
            auth: { type: 'bearer' },
            headers: {},
            defaults: {},
            requestOptions: {
                omitTemperature: true
            },
            modelDiscovery: {
                enabled: true,
                endpoint: '/v1/models'
            },
            // 视频输入：文件上传 API 方式（方案 1）。endpoint 相对 baseUrl，purpose 为上传用途，
            // reference 为 file_id 的引用前缀（Kimi 规范：ms://<file_id>）。
            videoInput: {
                upload: { endpoint: '/v1/files', purpose: 'video' },
                reference: 'ms://'
            },
            models: [
                { id: 'kimi-k3.1-pro', capabilities: { vision: true, video: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'kimi-k3', capabilities: { vision: true, video: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                // 旧档位：仅对既有 Key 可调用，官方已停止向新注册账号提供
                { id: 'kimi-k2.6', capabilities: { vision: true, video: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'kimi-k2.7-code', capabilities: { vision: true, video: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } }
            ]
        },
        {
            id: 'zhipu',
            get label() { return AEI18n.t('智谱 GLM'); },
            builtin: true,
            enabled: true,
            protocol: 'openai-compatible',
            baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
            endpoint: '/chat/completions',
            apiKeyField: 'zhipuApiKey',
            auth: { type: 'bearer' },
            headers: {},
            defaults: {},
            requestOptions: {},
            modelDiscovery: {
                enabled: true,
                endpoint: '/models'
            },
            models: [
                { id: 'glm-5.3', capabilities: { vision: false, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'glm-5.3-flash', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'glm-5.2', capabilities: { vision: false, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'glm-4.7-flash', capabilities: { vision: false, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'glm-5v-turbo', capabilities: { vision: true, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'glm-4.6v', capabilities: { vision: true, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } }
            ]
        },
        {
            id: 'volcengine',
            get label() { return AEI18n.t('火山方舟'); },
            builtin: true,
            enabled: true,
            protocol: 'openai-compatible',
            baseUrl: 'https://ark.cn-beijing.volces.com',
            endpoint: '/api/v3/chat/completions',
            apiKeyField: 'arkApiKey',
            auth: { type: 'bearer' },
            headers: {},
            defaults: {},
            requestOptions: {},
            modelDiscovery: {
                enabled: true,
                endpoint: '/api/v3/models'
            },
            // 视频输入：OpenAI 兼容 Files API 上传（方案 1），reference 为 file_id 引用前缀。
            // 火山方舟 Chat API 视频理解走 video_url 内容块，file_id 引用前缀为 file://。
// 上传端点用标准绝对地址，与聊天 baseUrl 解耦（配 /api/plan、/api/coding 等套餐 baseUrl 时
            // 不会拼出 /api/plan/api/v3/files 这类 404 地址）。
            // purpose 必须用 user_data：火山方舟 Files API 只接受 [user_data, agent]，传 video 会 400。
            videoInput: {
                upload: { endpoint: 'https://ark.cn-beijing.volces.com/api/v3/files', purpose: 'user_data' },
                reference: 'file://'
            },
            models: [
                { id: 'doubao-seed-2-1-pro-260628', capabilities: { vision: true, video: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'doubao-seed-2-1-turbo-260628', capabilities: { vision: true, video: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'doubao-seed-2-0-lite-260428', capabilities: { vision: true, video: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'doubao-seed-2-0-mini-260428', capabilities: { vision: true, video: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'deepseek-v4-pro-ga-260813', capabilities: { vision: false, video: false, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'deepseek-v4-flash-ga-260731', capabilities: { vision: false, video: false, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } }
            ]
        },
        {
            id: 'anthropic',
            label: 'Anthropic',
            builtin: true,
            enabled: true,
            protocol: 'anthropic-messages',
            baseUrl: 'https://api.anthropic.com',
            endpoint: '/v1/messages',
            apiKeyField: 'anthropicApiKey',
            auth: { type: 'x-api-key' },
            headers: {
                'anthropic-version': '2023-06-01'
            },
            defaults: {},
            requestOptions: {
                // Claude 5 系不接受 temperature（传了会 400）；思考强度走 output_config.effort
                omitTemperature: true
            },
            modelDiscovery: {
                enabled: true,
                endpoint: '/v1/models'
            },
            models: [
                // Claude 5 系省略 thinking 字段即走 adaptive；显式 enabled+budget_tokens 会被拒 → 标 on
                { id: 'claude-opus-5-5', capabilities: { vision: true, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'claude-sonnet-5-5', capabilities: { vision: true, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'claude-haiku-5-5', capabilities: { vision: true, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } }
            ]
        },
        // ── OpenCode Go（$10/月订阅，一份 Key 覆盖下列全部模型）──
        // 端点按模型家族分流：此条只放 /chat/completions 家族；MiniMax/Qwen/Claude 走 /messages，
        // 见下方 opencode-go-anthropic；Grok/GPT Luna/Muse Spark 走 /responses、Gemini 走
        // Google 原生端点，本扩展没有对应适配器，暂不收录。
        // 两个平台共用同一 apiKeyField：同一份订阅只有一把 Key，用户填一次即可。
        {
            id: 'opencode-go',
            label: 'OpenCode Go',
            builtin: true,
            enabled: true,
            protocol: 'openai-compatible',
            baseUrl: 'https://opencode.ai/zen/go/v1',
            endpoint: '/chat/completions',
            apiKeyField: 'opencodeGoApiKey',
            auth: { type: 'bearer' },
            headers: {},
            // 服务端强制要求会话标识（缺失直接 400 MissingSessionID）：
            // 值由 llmChannel 按当前会话 id / 安装级稳定 id 注入，见 protocolAdapters.makeHeaders
            sessionIdHeader: 'x-opencode-session',
            defaults: {},
            requestOptions: {},
            modelDiscovery: {
                enabled: true,
                endpoint: '/models'
            },
            // 能力数据源：models.dev 的 opencode-go 供应商条目（opencode 官方模型目录）。
            // vision 取 modalities.input 含 image，jsonMode 取 structured_output。
            // video 一律 false：视频还需平台侧 videoInput（上传端点或内联），内置平台的
            // 高级选项不可编辑，标 true 只会让能力徽标与实际可用性不符。
            models: [
                { id: 'deepseek-v4.1-flash', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'deepseek-v4-pro', capabilities: { vision: false, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'glm-5.3', capabilities: { vision: false, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'glm-5.3-flash', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'glm-5.2', capabilities: { vision: false, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'kimi-k3.1-pro', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'kimi-k3', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'kimi-k2.7-code', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'mimo-v2.6-pro', capabilities: { vision: true, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'mimo-v2.6-flash', capabilities: { vision: true, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'hy4', capabilities: { vision: true, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'hy4-preview', capabilities: { vision: false, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'hy3', capabilities: { vision: false, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'longcat-2.0', capabilities: { vision: false, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } }
            ]
        },
        // OpenCode Go 的 Anthropic 风格端点（/messages）。端点必须显式声明为 '/messages'：
        // anthropic-messages 协议的默认端点是 '/v1/messages'，用默认值会拼成
        // https://opencode.ai/zen/go/v1/v1/messages（404）。
        {
            id: 'opencode-go-anthropic',
            label: 'OpenCode Go (Anthropic)',
            builtin: true,
            enabled: true,
            protocol: 'anthropic-messages',
            baseUrl: 'https://opencode.ai/zen/go/v1',
            endpoint: '/messages',
            apiKeyField: 'opencodeGoApiKey',
            auth: { type: 'x-api-key' },
            headers: {},
            sessionIdHeader: 'x-opencode-session',
            defaults: {},
            requestOptions: {
                // Claude 5 系不接受 temperature；同一端点的 minimax/qwen 模型照常带温度
                omitTemperaturePrefixes: ['claude']
            },
            modelDiscovery: {
                enabled: true,
                endpoint: '/models'
            },
            // 能力数据源：models.dev 的 opencode-go 供应商条目（opencode 官方模型目录，
            // 含逐模型 modalities.input 与 structured_output）——vision 取 input 含 image，
            // jsonMode 取 structured_output。video 一律 false：视频还需平台侧 videoInput
            // （上传端点或内联），内置平台的高级选项不可编辑，标 true 只会让能力与实际不符。
            models: [
                { id: 'claude-haiku-5-5', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'minimax-m3', capabilities: { vision: true, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'qwen3.8-max', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'qwen3.8-flash', capabilities: { vision: true, jsonMode: true, tools: true, stream: true }, thinking: { mode: 'on' } },
                { id: 'qwen3.7-plus', capabilities: { vision: true, jsonMode: false, tools: true, stream: true }, thinking: { mode: 'on' } }
            ]
        }
    ];

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.BUILTIN_LLM_PROVIDERS = BUILTIN_LLM_PROVIDERS;
})(window);
