(function (global) {
    'use strict';
    // SSE 增量累积器，供 processScriptToolLoop 使用。
    // 维护 accumulatedContent/accumulatedReasoning/finishReason 的增量（覆写/置空/快照），
    // 收敛为无状态纯工具（每次循环创建独立实例，不跨请求共享）。
    // 采用重置型累积（每轮开始 reset() 置空），与 processToolLoop 的跨轮保留语义不同，故未共用。
    // 仅负责「增量维护」本身（写入/置空/快照），读侧的循环控制流（_streamedThisRound 判空、
    // 分段推送 UI、中途截断回调）仍留在 controller 骨架中，经 snapshot() 取当前累积值。
    // controller.js 调用方式：var acc = createStreamAccumulator(); 见 createController 组装区。
    function createStreamAccumulator() {
        var accumulatedContent = '';
        var accumulatedReasoning = '';
        var finishReason = '';
        // 置空累积变量（每轮开始调用，防止跨轮拼接；finishReason 仅在结束轮写入，置空无副作用）
        function reset() {
            accumulatedContent = '';
            accumulatedReasoning = '';
            finishReason = '';
        }
        // 增量维护：type 为 'content'/'reasoning'/'finishReason'，value 为整段最新文本（覆写语义，与源一致）
        function append(type, value) {
            if (type === 'content') {
                accumulatedContent = value;
            } else if (type === 'reasoning') {
                accumulatedReasoning = value;
            } else if (type === 'finishReason') {
                finishReason = value;
            }
        }
        // 快照当前累积状态（返回浅拷贝，读侧不污染内部状态）
        function snapshot() {
            return { accumulatedContent: accumulatedContent, accumulatedReasoning: accumulatedReasoning, finishReason: finishReason };
        }
        return { reset: reset, append: append, snapshot: snapshot };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createStreamAccumulator = createStreamAccumulator;
})(typeof global !== 'undefined' ? global : window);