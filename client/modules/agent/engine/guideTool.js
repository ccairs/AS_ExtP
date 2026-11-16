/**
 * guideTool.js — guide 指导工具注册
 *
 * 内容源：client/shared/guideContent.js（随版本分发，与工具面同步）。
 * scope 限 moduleIds:['external-mcp']——外接专用知识工具：面板三模式的契约
 * 已在各自系统提示词（shader 全量契约 / script 工具描述指针），面板侧不投放
 * 本工具（scope 等值匹配，面板 moduleId 为 agent/script/shader 均不命中）；
 * 外接执行经 extBridgeClient 的 moduleId 解析以 'external-mcp' 放行
 * （moduleIds[0] 必须是 external-mcp——extBridgeClient 以首项作为 module-scope
 * 工具的执行 moduleId）。
 * 装配：engine/bootstrap.js 挂载段调用 registerGuideTool（guarded by hasTool）。
 */
(function (global) {
    'use strict';

    var NAME = 'guide';

    function registerGuideTool(toolRegistry) {
        if (!toolRegistry || typeof toolRegistry.register !== 'function') {
            return { ok: false, error: 'MISSING_TOOL_REGISTRY' };
        }
        if (typeof toolRegistry.hasTool === 'function' && toolRegistry.hasTool(NAME)) {
            return { ok: true, skipped: true };
        }
        var content = global.AEGuideContent;
        if (!content || typeof content.getTopic !== 'function') {
            return { ok: false, error: 'MISSING_GUIDE_CONTENT' };
        }
        var reg = toolRegistry.register({
            name: NAME,
            description: '获取创作指导 playbook（按需拉取；非制作任务无需调用）。'
                + 'topic：production=完整出片流程与每步验证口径；shader=GLSL 效果契约核心 + 能力索引；'
                + 'shader:<节名>=该节全文（用到可选特性——映射图层/相机/灯光/迭代/结算/历史/JS 编排——'
                + '前先拉，节名见 guide(\'shader\') 文末索引）；'
                + 'conventions=项目结构与命名约定；index=主题索引（默认）。',
            input_schema: {
                type: 'object',
                properties: {
                    topic: {
                        type: 'string',
                        enum: content.listTopics(),
                        description: '主题：production / shader / shader:<节名> / conventions / index（省略默认 index）'
                    }
                },
                required: []
            },
            handler: function (args) {
                var r = content.getTopic(args && args.topic);
                if (!r || r.ok !== true) {
                    return {
                        success: false,
                        isError: true,
                        content: [{
                            type: 'text',
                            text: 'guide 失败：' + ((r && r.error) || 'UNKNOWN')
                                + '（可用主题：' + content.listTopics().join(' / ') + '）'
                        }]
                    };
                }
                return { success: true, isError: false, content: [{ type: 'text', text: r.content }] };
            },
            scope: { type: 'module', moduleIds: ['external-mcp'] },
            stub: false,
            source: 'agent',
            category: 'utility'
        });
        // 透传注册结果：register 被拒（如 REGISTER_FAILED/校验失败）时不能报 ok，
        // 否则 bootstrap 的失败守卫永不触发（静默失联）。
        return (reg && reg.ok) ? { ok: true } : { ok: false, error: (reg && reg.error) || 'REGISTER_FAILED' };
    }

    global.AEGuideTool = { registerGuideTool: registerGuideTool };
})(typeof window !== 'undefined' ? window : globalThis);
