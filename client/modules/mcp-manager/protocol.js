(function(global) {

    var MCP_PROTOCOL_VERSION = '2025-11-25';
    // 版本协商：服务器不认识客户端请求版本时会回自己支持的最新版本。
    // 白名单须覆盖主流服务器版本，否则 2025-06-18/2025-03-26 的服务器会被误判 mismatch 握手失败
    //（本客户端仅用 tools/list、tools/call 子集，这些版本间完全兼容）。
    var MCP_SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    var MCP_CLIENT_NAME = 'AE_LLM';
    var MCP_CLIENT_VERSION = '1.0.0';

    var JSON_RPC_ERRORS = {
        PARSE_ERROR: -32700,
        INVALID_REQUEST: -32600,
        METHOD_NOT_FOUND: -32601,
        INVALID_PARAMS: -32602,
        INTERNAL_ERROR: -32603
    };

    function generateId() {
        return 'mcp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
    }

    function createRequest(method, params, id) {
        var req = { jsonrpc: '2.0', method: method, id: id || generateId() };
        if (params !== undefined) req.params = params;
        return req;
    }

    function createError(id, code, message) {
        return {
            jsonrpc: '2.0',
            id: id,
            error: { code: code, message: message }
        };
    }

    function isValidResponse(response) {
        if (!response || typeof response !== 'object') return false;
        if (response.jsonrpc !== '2.0') return false;
        if (response.id === undefined) return false;
        return true;
    }

    function isSuccess(response) {
        return isValidResponse(response) && response.result !== undefined;
    }

    function isError(response) {
        return isValidResponse(response) && response.error !== undefined;
    }

    function formatToolResult(success, textOrParts, isError) {
        var content;
        if (Array.isArray(textOrParts)) {
            content = textOrParts;
        } else if (typeof textOrParts === 'string') {
            content = [{ type: 'text', text: textOrParts }];
        } else if (textOrParts && typeof textOrParts === 'object') {
            content = [{ type: 'text', text: JSON.stringify(textOrParts, null, 2) }];
        } else {
            content = [{ type: 'text', text: '' }];
        }
        return {
            content: content,
            isError: !!isError
        };
    }

    function extractResultText(content) {
        if (!content) return '';
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            var parts = [];
            for (var i = 0; i < content.length; i++) {
                if (content[i] && content[i].type === 'text' && typeof content[i].text === 'string') {
                    parts.push(content[i].text);
                }
            }
            return parts.join('\n');
        }
        return JSON.stringify(content);
    }

    function extractErrorText(content) {
        if (!content) return 'Unknown server error';
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            var parts = [];
            for (var i = 0; i < content.length; i++) {
                if (content[i] && content[i].type === 'text' && typeof content[i].text === 'string') {
                    parts.push(content[i].text);
                }
            }
            return parts.join('\n') || 'Unknown server error';
        }
        return JSON.stringify(content);
    }

    function buildInitializeRequest() {
        return createRequest('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            clientInfo: {
                name: MCP_CLIENT_NAME,
                version: MCP_CLIENT_VERSION
            },
            capabilities: {
                tools: {}
            }
        });
    }

    // MCP 规范：客户端收到 initialize 响应后 MUST 发送该通知才能进入正常操作阶段；
    // 严格实现的服务器（如 rmcp >= 0.2）未收到会拒绝后续 tools/list。
    // 无 id 即 JSON-RPC notification（fire-and-forget，不期待响应）。
    function buildInitializedNotification() {
        return { jsonrpc: '2.0', method: 'notifications/initialized' };
    }

    function validateInitializeResponse(resp) {
        if (!isSuccess(resp)) {
            var errorMsg = resp.error ? (resp.error.message || 'Unknown error') : 'Invalid response';
            throw new Error('Initialize failed: ' + errorMsg);
        }
        if (resp.result && resp.result.protocolVersion && MCP_SUPPORTED_VERSIONS.indexOf(resp.result.protocolVersion) === -1) {
            throw new Error('Protocol version mismatch: server=' + resp.result.protocolVersion + ', client=' + MCP_PROTOCOL_VERSION);
        }
        return resp.result;
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createMCPProtocol = function() {
        return {
            createRequest: createRequest,
            createError: createError,
            isValidResponse: isValidResponse,
            isSuccess: isSuccess,
            isError: isError,
            formatToolResult: formatToolResult,
            extractResultText: extractResultText,
            extractErrorText: extractErrorText,
            buildInitializeRequest: buildInitializeRequest,
            buildInitializedNotification: buildInitializedNotification,
            validateInitializeResponse: validateInitializeResponse,
            generateId: generateId,
            PROTOCOL_VERSION: MCP_PROTOCOL_VERSION,
            SUPPORTED_VERSIONS: MCP_SUPPORTED_VERSIONS,
            CLIENT_NAME: MCP_CLIENT_NAME,
            CLIENT_VERSION: MCP_CLIENT_VERSION,
            JSON_RPC_ERRORS: JSON_RPC_ERRORS
        };
    };
    global.AE_LLM.MCP_PROTOCOL_VERSION = MCP_PROTOCOL_VERSION;

})(window);
