(function (global) {
    function createAgentState() {
        return {
            mode: 'A',
            busy: false,
            // busyText 是可见状态栏文案：写入方负责给出**已本地化**的整句
            // （AEI18n.t 或整句模板），读取方（view/团队行/任务板）原样上屏、不再二次翻译。
            // 这样同一文案在单 Agent 栏与团队 lane 行上完全一致，且语言切换只影响后续写入。
            busyText: '',
            messages: [],
            streamingContent: '',
            toolCallInProgress: null,
            agentCallCount: 0,
            sessionId: 'default',
            sessionTitle: '新会话',
            // 启动会话恢复链进行中标志（仅内存态，不持久化）。
            // bootstrap 在恢复链（store.init/migrate/动画等待/switchSession）开始前置位、
            // 完成/异常后复位；submitUserInput 据此在恢复完成前拒绝提交——否则消息会
            // 写进初始 'default' 孤儿会话、随后被恢复流程 importMessages 覆盖丢弃。
            restoring: false,
            // stub 工具调用前置检查：记录已通过 tool_search 获取参数定义的工具名。
            // 仅内存态，不持久化——会话重载后首次调用会触发一次 tool_search，可接受。
            searchedTools: null,
            // 当前轮投放清单（工具名 Set）与门控原因表（名字→原因码）：每轮工具循环构建
            // tools 时由 controller._buildRoundTools 同步填充。执行侧据此把门控落成
            // 「不可用」（toolExecutionPipeline 的两道轮次闸门）。仅内存态、每轮重建；
            // 未跑过工具循环（直调路径/会话刚恢复）时为 null ⇒ 闸门放行（fail-open）。
            roundToolNames: null,
            roundGateReasons: null
        };
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.state = {
        createAgentState
    };
})(window);
