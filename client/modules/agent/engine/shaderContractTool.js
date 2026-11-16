/**
 * shaderContractTool.js — GLSL 契约**分节拉取**工具（面板 shader 轮专用）
 *
 * 存在理由：shader 轮的系统提示词只常驻"核心契约 + 能力索引"（全量约 10k tokens 里约四分之三
 * 是按特性条件使用的，用不到就不发）。索引里给出的取用入口就是本工具——所以它必须存在，
 * 否则就是让模型指向一个它调不到的工具（这个坑仓库里记着）。
 *
 * 为什么不扩展 guide 而是另起一个：
 *   · guide 是**外接专用**的创作指导 playbook（production 出片流程 / conventions 约定集），
 *     它的话题面、描述文案与外接 instructions 的字符预算棘轮都锁着；
 *   · 把面板 shader 轮的契约取用塞进它，等于让外接专用工具承担面板职责，还得按模块分叉
 *     描述文案——不如让 guide 原样不动，另给面板一个只做一件事的工具。
 *
 * 内容源仍是 client/shared/glslApiReference.txt（唯一正文源，本文件不含任何契约正文），
 * 切分/探测/索引由 client/shared/glslContractTopics.js 做。
 * 装配：engine/bootstrap.js 挂载段调用 registerShaderContractTool（guarded by hasTool）。
 */
(function (global) {
    'use strict';

    var NAME = 'shader_contract';

    function registerShaderContractTool(toolRegistry) {
        if (!toolRegistry || typeof toolRegistry.register !== 'function') {
            return { ok: false, error: 'MISSING_TOOL_REGISTRY' };
        }
        if (typeof toolRegistry.hasTool === 'function' && toolRegistry.hasTool(NAME)) {
            return { ok: true, skipped: true };
        }
        var T = global.AEGlslContractTopics;
        if (!T || typeof T.splitSections !== 'function') {
            // 装载序（manifest）或加载失败：显式报错，别静默少一个工具
            return { ok: false, error: 'MISSING_TOPICS_MODULE' };
        }

        // 契约文本：面板由 engine/bootstrap.js 读盘缓存（AEEngine.getShaderContract）。
        // 取不到时工具报错而不是空手——注意那时系统提示词也会退化成"契约文档缺失"，
        // 两侧口径一致（都不假装有契约）。
        function fullContract() {
            try {
                if (global.AEEngine && typeof global.AEEngine.getShaderContract === 'function') {
                    return String(global.AEEngine.getShaderContract() || '');
                }
            } catch (_) {}
            return '';
        }

        var sections = T.allSections();

        var reg = toolRegistry.register({
            name: NAME,
            description: '读取 AS_ExtP GLSL 效果契约的某一节全文。系统提示词只常驻核心契约与'
                + '能力索引（不传 section 即返回该索引）；要写用到**可选特性**的效果前先取对应节：'
                + 'layers=映射图层（iChannel1/2/3：用合成里另一张图当输入，置换/遮罩/参考图），'
                + 'camera=相机/3D 与 raymarch 配方，lights=灯光与光照配方，iter=帧内多趟迭代，'
                + 'solve=结算器（@solve/@solveHz/@solveRes），history=输入历史（拖尾/残影），'
                + 'core=系统提示词常驻的那部分契约（入口/基础内置/参数规范/硬性规则/示例 **+ JS 编排契约**），'
                + 'js=只要 JS 编排契约（buildShader 产出 GLSL）。',
            input_schema: {
                type: 'object',
                properties: {
                    section: {
                        type: 'string',
                        enum: sections,
                        description: '要取的分节；不传则返回索引（列出可选能力与各节取用入口）'
                    }
                },
                required: []
            },
            handler: function (args) {
                var sec = String((args && args.section) || '').trim();
                var full = fullContract();
                if (!full) {
                    return {
                        success: false, isError: true,
                        content: [{ type: 'text', text: NAME + ' 失败：契约文档不可用（宿主未加载 glslApiReference.txt）。' }]
                    };
                }
                if (!sec) {
                    return {
                        success: true, isError: false,
                        content: [{ type: 'text', text: T.indexText([]) }]
                    };
                }
                if (sections.indexOf(sec) < 0) {
                    return {
                        success: false, isError: true,
                        content: [{ type: 'text', text: NAME + ' 失败：未知 section「' + sec
                            + '」（可用：' + sections.join(' / ') + '）' }]
                    };
                }
                var body = (sec === 'core') ? T.coreText(full) : T.topicsText(full, [sec]);
                if (!body) {
                    return {
                        success: false, isError: true,
                        content: [{ type: 'text', text: NAME + ' 失败：section「' + sec + '」切不出内容（契约文件结构可能变了）。' }]
                    };
                }
                return {
                    success: true, isError: false,
                    content: [{ type: 'text', text: body }]
                };
            },
            // 面板 shader 轮专用。**不给 external-mcp**：外接侧有 guide + submit_shader 描述
            // 承载契约（那是它的既有通路，本工具不去动它）。
            scope: { type: 'module', moduleIds: ['shader'] },
            stub: false,
            // category/source 与同轮其余 6 个 shader 工具**对齐**（shaderTools.js 全部是
            // utility/agent）——不对齐的后果是实测可见的：模型在 shader 轮调
            // tool_search(category:'utility') 会列全同轮工具，唯独漏掉本工具（而索引
            // 正指着它），或凭印象猜分组名。category 只影响分组检索，不影响 scope 过滤。
            category: 'utility',
            source: 'agent'
        });
        return reg;
    }

    global.AEShaderContractTool = { registerShaderContractTool: registerShaderContractTool, NAME: NAME };
})(typeof window !== 'undefined' ? window : globalThis);
