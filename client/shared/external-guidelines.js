/**
 * external-guidelines.js — 对外约束文档源
 *
 * 面板内 Agent 的工具约束写在系统提示词（PromptBuilder 管线）；外部 Agent 经 MCP 调用时
 * 收不到系统提示词。本文件是共享约束文档源：
 *   - 出口①（本文件 → ext-mcp-server.js）：initialize 响应的 instructions 字段
 *   - 出口②（面板内 Agent 系统提示词注入）不做：面板有各模式专属 overlay、外接是工具合并
 *     的扁平面，强行同源会让同一段话要同时满足两种读者，维护成本大于收益。故本文件只服务
 *     出口①。
 *
 * 双环境加载：
 *   - Node（ext-mcp-server.js）：module.exports = { getInstructions, INSTRUCTIONS }
 *   - CEP 面板：window.AEExternalGuidelines = { getInstructions, INSTRUCTIONS }
 *
 * 预算约束：instructions 有 **2048 字符静默截断**预算（Claude Code 客户端即如此截断）。
 *   2048 是 **JS 字符串长度**（截断判据 `W.length`），不是字节也不是 token；且**同时约束
 *   instructions 与每个 tool description**。可见性差异：instructions 截断会打 debug 日志
 *   （`Server instructions truncated from X to 2048 chars`），**tool description 截断什么都
 *   不记**，而 `/mcp` UI 显示的是未截断全文——所以无从察觉，且无覆盖开关。本文件保持精炼
 *   并按重要性排序：铁律在前，细则靠工具描述按需获取。当前正文约 1781 字符，逼近硬顶，
 *   追加内容须等量删减。
 *
 * 内容分层：
 *   L1 本文件：只放**导航**——三入口剧本 + 效果与工程联动 + 跨工具要点 + 错误恢复 + 确认语义
 *        + 自带子系统辨识（第 14 条：本服务器自带的技能库/MCP 网关 ≠ 调用方自带的系统）
 *        + 知识路由（第 15-16 条：guide 主题路由 + get_rule 开工前置）——追加于末尾，
 *        保持既有编号（1-7、9-16，第 8 条空缺）与既有引用（第 7 条/第 14 条）稳定
 *   L2 各工具 description：工具级契约（ES3/GLSL 入口/参数/返回字段），随 tools/list 送达
 *   L2.5 extTools 的 EXTERNAL_DESC_NOTES：外接侧注记，两类——①「外接通道与面板行为不同」的差异；
 *        ② 外接专属**作用域限定**（记忆六个入口，见该表 MEMORY_SCOPE_NOTE）
 *        （共享描述讲的是面板行为，外接侧的东西写进去会污染它——故分离维护）
 *
 * 写作原则：**读者对本站系统一无所知**。故不出现「外接」「面板内 Agent」「两套工具同时在线」
 * 「不必等」这类需要上下文的措辞；每个陈述自足——点明施动者、工具名、可观察行为。正文只写
 * **已验证**的事实。
 *
 * 写作风格（适用于全部提示词文本）：**机械、直抒胸臆、客观**。落实到四类删改：
 * ① 删修辞——「值得一提」这类括号调侃不承载约束；② 去假精确——不可机械计数处不写数字
 * （「多次」而非「≥2 次」，否则诱导 LLM 去数第几次）；③ 删可由前文推出的结论——同一件事
 * 说两遍（「是硬门」＋「不可跳过」）反而稀释；④ 每条约束写成**可直接执行的动作**或明确的
 * 否证项，不写成价值判断。
 *
 * 与面板提示词的关系：两侧**派生自同一规则集**，但按读者分别成文——面板侧在 engine/prompts.js
 * 的 `buildMemorySection()`（三模式共享，含完整口径），本文件第 7 条是其压缩版（吃 2048 预算，
 * 故去掉举例与铺陈）。两者是同一门槛的两份表述，不是各自独立的规则：改动须同步。
 * 例外：记忆门槛的**外接专属作用域限定**（只记操作本扩展与 AE 工程相关的事实）不进第 7 条
 * ——instructions 不追加内容（现约 1781 字符），且该限定只对外接成立（外接 Agent 常身处本扩展
 * 代码库，面板侧 Agent 不会把「本工程」读成「这个代码库的开发约定」）。它落在 L2.5：
 * extTools.js 的 EXTERNAL_DESC_NOTES（铺到全部六个 memory_* 入口，读侧同样明示归属——外部
 * Agent 会先 search 再拟写，只在写入口限定不够）。不合并成一份的理由与「出口②不做」同源——
 * 同一段话同时满足两种读者，代价高于收益。
 *
 * 视角（MCP 规范）：instructions 是「描述如何使用本服务器及其能力」的模型提示
 * （"a hint to the model"，可被客户端并入系统提示词）——因此以**服务器视角**
 * 自述能力与用法，不替客户端的 Agent 定义身份。
 */

(function (global) {
    'use strict';

    var INSTRUCTIONS = [
        '# AS_ExtP MCP 服务器（Adobe After Effects 扩展面板）',
        '',
        '本服务器操控 AE。所有工具经面板串行执行。工具与参数以 tools/list 为准，完整契约（ES3、matchName、GLSL 入口等）见工具描述。API 签名不确定时用 queryAeApi 查证，不要编造。',
        '',
        '## 任务剧本（按产出选择入口）',
        '1. 修改工程：queryProject(browse) 取合成索引 → queryProject(layers, compositionIndex=N) 取图层索引 → queryDetails 查详情 → executeExtendScript 执行写入（写主入口，经预检审查）→ 回查实际状态（用查询工具，别在代码里重复实现）。',
        '2. 产出脚本：先 get_current_script 读预览区（含首次，未读提交被拒），再用 submit_script 交付。',
        '3. 产出效果：先 get_current_shader 读预览区（同上）；submit_shader/submit_js_effect 编译校验；提交后用 getShaderPreview 查看预览图，确认真实渲染结果。',
        '',
        '## 效果与工程联动',
        '4. 提交后用 shader_library(mode=save) 入库；再用 executeExtendScript 给图层 addProperty AS_Effect_Host，文件索引（刚保存用 save 回执，否则 hostOrder）与槽位值分两次写（写索引重置槽位值）；参数用 matchName 槽位（`AS_Effect_Host-0(500+4i+c)`），勿按名，写完读 .value。',
        '5. 仅提交未入库时代码只在预览区；AE 渲染的是效果库里选中的文件。',
        '',
        '## 跨工具要点',
        '6. ComfyUI 异步：comfyui_generate 提交即返回 prompt_id，结果不主动送达，用 comfyui_check_status 反复查询；done 时 outputs 含路径。',
        '7. 记忆：执行前先 memory_search 查经验；记忆只记三类：项目经验（本工程约定/结构/进展）、通用经验（可复用的 API 实测行为/踩坑/工具用法）、用户偏好与纠正；只写已验证事实，不写推测。其余不记：任务过程、一次性操作、临时约定、文档/工程可查到的。同一主题只 update 不新建；create 前必须 memory_search 查重；写完把所存内容告知用户。',
        '',
        '## 代码契约与错误恢复',
        '9. 撤销组可自写 beginUndoGroup/endUndoGroup，不写则框架兜底，一次撤销整组回滚；回滚用 undoLastOperation。',
        '10. 安全门/编译校验的拒绝信息含原因与替代方案，按指引修正后重提，不要绕过；信息缺失先问用户，同一错误反复不过就停下，不要盲试。',
        '11. RELAY_TIMEOUT / EXT_TIMEOUT / EXT_TASK_PENDING 表示可能仍在执行：先查结果再决定，不要盲目重试；EXT_TASK_PENDING 的 taskId 用 ext_task_get 查。',
        '12. 状态码：PANEL_OFFLINE=面板未运行；EXTERNAL_MODE_OFF=未授权；ACCESS_DENIED=工具被停用（非故障）；QUEUE_FULL=队列满稍后重试。',
        '',
        '## 确认与拒绝',
        '13. 删除类操作触发确认：支持的客户端内部弹出，60s 未响应即拒绝；不支持则直接拒绝。',
        '',
        '## 本服务器自带子系统',
        '14. 本服务器自带技能库与 MCP 网关：Skill 读面板技能库（skill_manager），不读调用方技能；mcp_* 转发面板配置的第三方 MCP 服务器。',
        '',
        '## 知识路由',
        "15. 出片先 guide('production')；写 GLSL/JS 效果先 guide('shader')；建/整理工程先 guide('conventions')；不确定 guide('index')。",
        '16. 开工前 get_rule 查用户约定（script/agent/shader 三档都读），有则覆盖默认约定。'
    ].join('\n');

    function getInstructions() {
        return INSTRUCTIONS;
    }

    var api = { getInstructions: getInstructions, INSTRUCTIONS: INSTRUCTIONS };

    // 双出口：Node（module）与浏览器/CEP（window）
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof global !== 'undefined') {
        global.AEExternalGuidelines = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
