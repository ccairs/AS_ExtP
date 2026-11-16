/**
 * pending 输入交接存储。
 * 显式 set/consume/peek/clear 契约，解决 UI 层与引擎间的隐形交接。
 * IIFE，挂 AEEngine.createPendingInputStore。
 *
 * **按 lane 分槽**：团队模式三条 lane 各跑一个
 * 工具循环、各自提交用户输入，单槽会让 lane A 挂起的附件被 lane B 的 consume() 破坏性取走
 * （附件进了别条 lane 的上下文，A 自己反而空手）。所有入口末位支持可选 laneId：
 *   省略 / 空串 ⇒ **缺省槽**（'agent'）——单 Agent 路径读写的一直是这一个槽；
 *   laneId 有值 ⇒ 只在该 lane 的槽上存取，别的 lane 读不到、取不走。
 * 槽数有界：lane 集合是封闭的三条（team/lanes.js）+ 缺省槽，且 consume()/clear() 删除键
 * （不留空槽），不随调用次数增长。
 * 写入端（app/main.js）必须带当前 lane，读取端（controller/inputDispatch.js 的
 * consume()）必须带同一条 lane——否则附件落缺省槽、被别的 lane 取走，分槽等于白做。
 */
(function (global) {
    'use strict';

    var DEFAULT_LANE = 'agent';   // 缺省槽：单 Agent 路径（调用方不传 laneId）

    // laneId 归一：非字符串/空串 → 缺省槽。不做 trim 之外的解释（lane id 由 team/lanes.js 定义）。
    function _laneOf(laneId) {
        return (typeof laneId === 'string' && laneId) ? laneId : DEFAULT_LANE;
    }

    function createPendingInputStore() {
        var byLane = {};   // laneId -> state（键缺失 = 空；consume/clear 删键，不留空槽）

        return {
            set: function (inputs, laneId) {
                inputs = inputs || {};
                byLane[_laneOf(laneId)] = {
                    fileContext: 'fileContext' in inputs ? inputs.fileContext : null,
                    imageDataUrls: inputs.imageDataUrls || null,
                    imageTempPaths: inputs.imageTempPaths || null,
                    videoPaths: inputs.videoPaths || null,
                    fileRefs: inputs.fileRefs || null,
                    codeContext: 'codeContext' in inputs ? inputs.codeContext : null,
                    codeDisplay: 'codeDisplay' in inputs ? inputs.codeDisplay : null
                };
            },
            peek: function (laneId) { return byLane[_laneOf(laneId)] || null; },
            consume: function (laneId) {
                var k = _laneOf(laneId);
                var v = byLane[k] || null;
                delete byLane[k];
                return v;
            },
            // clear(laneId)：给了字符串（含 `''` ⇒ 缺省槽）⇒ 只清那一个槽；**不传（undefined/null）
            // ⇒ 清全部槽**。
            // 为什么无参要清全部（实测）：分槽前只有「唯一那个槽」，`clear()` 的语义就是
            // 「丢弃全部挂起输入」。分槽后若把无参按「缺省槽」解释，将来有人用 `clear()` 表达该语义时，
            // 陈旧附件会留在 lane 槽里、在该 lane 下次发送时被 consume 走（用户看到「没发过的附件
            // 自己发出去了」）。而 `clear('')` 保持「缺省槽」的字面语义——单 Agent 路径的调用形状
            // 传的就是空串，它要清的正是自己那个槽，不该顺带清掉团队 lane 的。
            clear: function (laneId) {
                if (typeof laneId === 'string') { delete byLane[_laneOf(laneId)]; return; }
                byLane = {};   // 无参 = 全清
            },
            hasAny: function (laneId) { return byLane[_laneOf(laneId)] !== undefined; }
        };
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createPendingInputStore = createPendingInputStore;
})(typeof global !== 'undefined' ? global : window);
