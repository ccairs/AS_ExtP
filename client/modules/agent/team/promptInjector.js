(function (global) {
    'use strict';
    // lane 提示词段注入器（priority 45）。
    //
    // 注入点唯一：PromptBuilder 的注册钩子（`promptBuilder.register(fn, 45)`），不直接拼字符串到
    // 调用方——注入点清单里只有 PromptBuilder / ToolRegistry /
    // contextManager 三处，绕开它就会出现「有的路径带角色段、有的路径不带」的漂移。
    //
    // 优先级 45 的位置：aeInfo 10 → aeContext 15 → memory 30 → **lane 角色段 45** → skill 50。
    // 放在 memory/skill 之前，保证角色边界不会被后面的技能说明挤到末尾。
    //
    // 三条「不注入」的判据（任一命中就原样返回 prompt）：
    //   ① 团队模式未开启（单 Agent 路径逐字节不变）；
    //   ② 本次请求没有 lane 身份（ctx.lane/ctx.laneId 都缺——例如外接、脚本区运行、模块自检）；
    //   ③ lane 定义里没有 promptSection（未来新增 lane 时的安全缺省）。
    // 异常一律吞掉并原样返回：PromptBuilder 本身也会兜异常，但这里兜住可以避免半截拼接。

    function resolveLaneId(ctx) {
        if (!ctx || typeof ctx !== 'object') return '';
        if (ctx.lane && typeof ctx.lane === 'object' && typeof ctx.lane.id === 'string') return ctx.lane.id;
        if (typeof ctx.laneId === 'string') return ctx.laneId;
        return '';
    }

    function createPromptInjector(deps) {
        deps = deps || {};
        function getSettingsApi() {
            if (deps.settings) return deps.settings;
            return (global.AEAgentTeam && global.AEAgentTeam.settings) ? global.AEAgentTeam.settings : null;
        }
        function getLanesApi() {
            if (deps.lanes) return deps.lanes;
            return (global.AEAgentTeam && global.AEAgentTeam.lanes) ? global.AEAgentTeam.lanes : null;
        }

        function inject(prompt, ctx) {
            try {
                var settings = getSettingsApi();
                if (!settings || typeof settings.isEnabled !== 'function' || !settings.isEnabled()) return prompt;
                var laneId = resolveLaneId(ctx);
                if (!laneId) return prompt;
                var lanes = getLanesApi();
                var lane = (lanes && typeof lanes.get === 'function') ? lanes.get(laneId) : null;
                if (!lane || !lane.promptSection) return prompt;
                if (typeof prompt !== 'string' || !prompt) return prompt;
                // 角色段按**当前视图可见性**组装——被点名工具在本
                // 视图不可见时对应句子消失。谓词由 controller 放在 ctx.isToolVisible（当前轮闸口现算，
                // 子 Agent 用派生时冻结的闸口实例）；promptSectionFor 缺席或谓词缺席时回落原文，
                // 默认输出逐字不变。
                var section = (typeof lanes.promptSectionFor === 'function')
                    ? lanes.promptSectionFor(laneId, ctx && ctx.isToolVisible)
                    : lane.promptSection;
                if (!section) return prompt;
                return prompt + '\n\n' + section;
            } catch (_) {
                return prompt;
            }
        }

        return { inject: inject };
    }

    // 幂等注册：同一个 PromptBuilder 上重复挂载（模块重挂）不会叠加多份角色段。
    // 返回 { registered, remove }，便于卸载时摘掉。
    var _registered = null;
    function registerWith(promptBuilder, deps) {
        if (!promptBuilder || typeof promptBuilder.register !== 'function') return null;
        if (_registered && _registered.builder === promptBuilder) return _registered;
        var injector = createPromptInjector(deps);
        var fn = function (prompt, ctx) { return injector.inject(prompt, ctx); };
        promptBuilder.register(fn, 45);
        _registered = {
            builder: promptBuilder,
            fn: fn,
            injector: injector,
            remove: function () {
                if (typeof promptBuilder.remove === 'function') promptBuilder.remove(fn);
                if (_registered && _registered.fn === fn) _registered = null;
            }
        };
        return _registered;
    }

    global.AEAgentTeam = global.AEAgentTeam || {};
    global.AEAgentTeam.createPromptInjector = createPromptInjector;
    global.AEAgentTeam.registerPromptInjector = registerWith;
})(typeof window !== 'undefined' ? window : globalThis);
