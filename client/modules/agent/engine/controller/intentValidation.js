(function (global) {
    'use strict';
    // 意图校验纯函数层拆分。由 controller.js 组装区经 AEEngine.createIntentValidation() 创建。
    // 纯迁移自 controller.js 内联的 isInfrastructureError / getValidationStageLabel /
    // extractUserRequirement / resolvePurpose。四个函数均为纯函数，不依赖闭包状态。
    // opts 当前为空；保留工厂签名以与其它拆分单元注入方式对齐。
    function createIntentValidation(opts) {
        // 基础设施类错误：这些错误表示宿主环境（CEP/桥）不可用，是暂时性条件性问题，
        // 不应作为脚本/工具本身的失败反馈给 LLM 重试改写，单独识别以便上层处理。
        function isInfrastructureError(message) {
            const msg = String(message || '').toUpperCase();
            return msg.includes('CSINTERFACE_UNAVAILABLE')
                || msg.includes('HOST_BRIDGE_UNAVAILABLE')
                || msg.includes('BRIDGE_NOT_READY')
                || msg.includes('HOST_NOT_READY')
                || msg.includes('MISSING_HOST_FUNCTIONS');
        }

        function getValidationStageLabel(stage) {
            if (stage === 'static') return '静态校验';
            if (stage === 'model_review') return '模型审查';
            return '脚本校验';
        }

        // 提取最近一条用户消息的真实需求文本（剥离 <context> 前缀、截断过长内容）。
        // 供视觉代理描述时作为"需求提示词"传入，让代理围绕用户实际诉求聚焦描述。
        function extractUserRequirement(messages) {
            if (!Array.isArray(messages)) return '';
            for (var i = messages.length - 1; i >= 0; i--) {
                var m = messages[i];
                if (m && m.role === 'user' && typeof m.content === 'string') {
                    var text = String(m.content).replace(/^<context>[\s\S]*?<\/context>\s*\n*/, '').trim();
                    if (text.length > 300) text = text.slice(0, 300) + '\u2026';
                    return text;
                }
            }
            return '';
        }

        // 解析视觉分析需求提示词：仅取工具调用时主 LLM 显式传入的 purpose 参数
        //（如调用 read_image/read_video 时传"帮我仔细看看白色方块在哪个地方"）。
        // 不传则返回空串——不再回退到最近一条用户消息，避免用与当前图片/视频无关的
        // 文本误导视觉代理的聚焦（build*Description 提示词在 req 为空时不注入"用户需求"段，
        // 代理会纯粹客观描述）。拖入图片路径用 extractUserRequirement 直接取用户意图，不受影响。
        function resolvePurpose(args) {
            if (args && typeof args.purpose === 'string' && args.purpose.trim()) {
                return args.purpose.trim();
            }
            return '';
        }

        return { isInfrastructureError: isInfrastructureError, getValidationStageLabel: getValidationStageLabel, extractUserRequirement: extractUserRequirement, resolvePurpose: resolvePurpose };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createIntentValidation = createIntentValidation;
})(typeof global !== 'undefined' ? global : window);