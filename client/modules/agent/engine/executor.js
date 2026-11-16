(function (global) {
    function initScriptSandbox() {
        // （落定 4）：_wrapScriptForAE / _scriptSandboxPreamble / _buildPreamble
        // 已删除—— 起生产执行路径统一改道 bootstrap createHandler 桥 →
        // aeTools.jsx executeExtendScript 执行核（shadow + 核内 undo + allow-set），
        // 该包装器退位后的唯一保留理由（门总开关关闭时的 regex 回退路径）随
        // 计划落定 1 修正（bypass 门照跑——免打扰不是免检）而消亡：门侧开关
        // 语义已由 ast-gate config（bypass/domains）承载，无「关门直跑」路径需要
        // 本包装器兜底。热盒 scriptRunner.jsx 自有同构副本（__hotboxPreamble，
        // 行为由断言钉住）。
        // 本文件仅保留安全闸门升旗（service.js/quickBarExecutor 执行入口检查）——
        // 旗子必须保留：执行入口的「沙箱未就绪即拒绝」防线不随包装器退役。
        window.AE_LLM = window.AE_LLM || {};
        window.AE_LLM._agentSafetyReady = true;
    }

    initScriptSandbox();
})(window);
