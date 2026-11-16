(function (global) {
    // validator.js — LLM 语义审查层
    // 静态校验层（staticValidate regex 家族）已整体退役：AST 门（ast-gate）以
    // ES3 parser + 类型表精确覆盖其全部检测面（危险 API/逃逸标识符/ES6）且带
    // 域语义；regex 双路径与门漂移是缺陷温床（域盲误拒门已放行的代码）。
    // 门未就绪（ast-gate 加载失败）时 validate() fail-closed 拒绝——对齐执行
    // 通道立场（bootstrap createHandler / service runScript 同款「门未就绪即
    // 拒绝」）。本文件仅存 LLM 审查（modelReviewValidate）与三个入口。
    async function modelReviewValidate(script, options) {
        const opts = options || {};
        // fail-closed：审查函数未注入时拒绝执行（与下方 catch 块设计对齐）。
        // 正常装配下 bootstrap.js 会注入 reviewScript；此分支防御模块加载顺序异常。
        if (typeof opts.reviewScript !== 'function') {
            return {
                valid: false,
                errors: [{
                    type: 'model_review',
                    code: 'REVIEW_FN_UNAVAILABLE',
                    message: 'LLM 审查服务未就绪，已拒绝执行以防安全风险'
                }],
                warnings: [],
                stage: 'model_review'
            };
        }
        try {
            const reviewed = await opts.reviewScript({
                script: String(script || ''),
                userMessage: opts.userMessage || '',
                contextMessages: opts.contextMessages || [],
                signal: opts.signal,
                mode: opts.mode || ''  // ''=Script模式, 'agent'=Agent模式 executeExtendScript
            });
            const errors = Array.isArray(reviewed && reviewed.errors) ? reviewed.errors : [];
            const warnings = Array.isArray(reviewed && reviewed.warnings) ? reviewed.warnings : [];
            const mappedErrors = errors.map((item) => ({
                type: 'model_review',
                code: item && item.code ? String(item.code) : 'REVIEW_ERROR',
                message: item && item.message ? String(item.message) : '模型审查失败'
            }));
            const mappedWarnings = warnings.map((item) => ({
                type: 'model_review',
                code: item && item.code ? String(item.code) : 'REVIEW_WARN',
                message: item && item.message ? String(item.message) : '模型审查风险提示'
            }));
            const valid = !!(reviewed && reviewed.valid) && mappedErrors.length === 0;
            return {
                valid,
                errors: mappedErrors,
                warnings: mappedWarnings,
                stage: 'model_review',
                riskLevel: reviewed && reviewed.riskLevel ? reviewed.riskLevel : 'medium',
                reasoningContent: (reviewed && reviewed.reasoningContent) || ''
            };
        } catch (error) {
            return {
                valid: false,
                errors: [{
                    type: 'model_review',
                    code: 'MODEL_REVIEW_FAILED',
                    message: error && error.message ? error.message : '模型审查调用失败'
                }],
                warnings: [],
                stage: 'model_review',
                reasoningContent: ''
            };
        }
    }

    function createScriptValidator(options) {
        const opts = options || {};
        return {
            // Script 模式 submit_script 的校验入口：调用方（scriptTools）已先行
            // AST 门预检（能力面 + 逃逸形态承载），本层只做 LLM 语义审查。
            async validate(script, runtimeOptions) {
                if (!(global.AE_LLM && typeof global.AE_LLM._runSandboxedScript === 'function')) {
                    return {
                        valid: false,
                        errors: [{
                            type: 'gate_unavailable',
                            code: 'AST_GATE_UNAVAILABLE',
                            message: 'AST 编译门未就绪（ast-gate 模块加载失败），拒绝提交以保安全。请刷新面板。'
                        }],
                        warnings: [],
                        stage: 'gate'
                    };
                }
                const runOpts = runtimeOptions || {};
                return modelReviewValidate(script, {
                    reviewScript: opts.reviewScript,
                    userMessage: runOpts.userMessage,
                    contextMessages: runOpts.contextMessages || [],
                    signal: runOpts.signal
                });
            },
            // 仅跑 LLM 审查一级（复用 modelReviewValidate，不复制审查逻辑）。
            // 供 Agent 模式 executeExtendScript 在 AST 门通过后、权限确认前调用
            //（管线 toolExecutionPipeline 已先行过门）；审查是一次性 LLM 调用
            //（service.reviewScript → sendJson，无工具），不走工具循环，防递归。
            async review(script, runtimeOptions) {
                const runOpts = runtimeOptions || {};
                return modelReviewValidate(script, {
                    reviewScript: opts.reviewScript,
                    userMessage: runOpts.userMessage,
                    contextMessages: runOpts.contextMessages || [],
                    signal: runOpts.signal,
                    mode: 'agent'  // Agent 模式专用入口
                });
            },
            // shader 模式 JS 效果审计：仅跑 LLM 审查一级（mode='shader' 走专用 prompt）。
            // 供 shader 模式 submit_js_effect / shader_library(js) 在静态预检通过后、执行/写入前调用。
            async reviewShaderJs(script, runtimeOptions) {
                const runOpts = runtimeOptions || {};
                return modelReviewValidate(script, {
                    reviewScript: opts.reviewScript,
                    userMessage: runOpts.userMessage,
                    contextMessages: runOpts.contextMessages || [],
                    signal: runOpts.signal,
                    mode: 'shader'  // shader 模式专用入口：service.reviewScript 据此走 shader JS 审查 prompt
                });
            }
        };
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createScriptValidator = createScriptValidator;
})(window);
