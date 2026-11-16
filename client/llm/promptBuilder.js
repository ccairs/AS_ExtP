(function(global) {

    function createPromptBuilder() {
        var buildFns = [];

        function register(buildFn, priority) {
            if (typeof buildFn !== 'function') return;
            var p = typeof priority === 'number' ? priority : 50;
            buildFns.push({ fn: buildFn, priority: p });
            buildFns.sort(function(a, b) { return a.priority - b.priority; });
        }

        function build(basePrompt, context) {
            var prompt = basePrompt;
            for (var i = 0; i < buildFns.length; i++) {
                try {
                    prompt = buildFns[i].fn(prompt, context);
                } catch (e) {
                    // 单个注入器异常不中断整体 prompt 组装（否则一次 LLM 请求整体报废），跳过并告警
                    console.warn('[PromptBuilder] injector #' + i + ' 异常，已跳过: ' + e);
                }
            }
            return prompt;
        }

        function getBuildFnCount() {
            return buildFns.length;
        }

        function clear() {
            buildFns = [];
        }

        function remove(buildFn) {
            for (var i = buildFns.length - 1; i >= 0; i--) {
                if (buildFns[i].fn === buildFn) {
                    buildFns.splice(i, 1);
                }
            }
        }

        return {
            register: register,
            build: build,
            getBuildFnCount: getBuildFnCount,
            clear: clear,
            remove: remove
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createPromptBuilder = createPromptBuilder;

})(window);
