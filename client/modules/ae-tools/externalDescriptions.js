/**
 * externalDescriptions.js — AE 读取工具的外接（external-mcp）短描述。
 *
 * 为什么需要：客户端对 MCP 工具 description 有 2048 字符硬顶（超长静默截断），
 * 而 queryProject/queryDetails 的面板描述可达数千字符。外接投影（extTools.toToolDef）优先取
 * tool.buildDescription('external-mcp')，故这里只给外接读者一份「路由 + 关键参数」短版；
 * 面板/内部 Agent 仍用 seed 里的完整 description（bootstrap 注册时按 reader 分叉）。
 * 参数级细节仍由 inputSchema 各参数的 description 承载（schema 不被客户端截断）。
 *
 * 约束：每条 ≤2048 字符；只写外接读者需要的事实。
 */
(function (global) {
    'use strict';

    var SHORT = {
        queryProject: '浏览 AE 项目结构。target=browse：项目面板（folderIndex、depth=-1 全量、typeFilter/nameFilter）；layers：某合成的图层列表（compositionId 或 compositionIndex 必填；layerType/nameFilter；每条带稳定键 layerId 与 content/anim 摘要，可先判断要不要 queryDetails）；renderQueue：渲染队列；search：跨合成按名字搜（searchType+name）；selected：当前选中概览（scope=project 或 timeline，timeline 用 itemOffset/itemLimit 分页）；overview：项目级动画总览（每合成一行计数、扫全部图层、按合成分页）。定位优先稳定 id（compositionId/layerId/footageId），索引/名字会漂移。返回页有 12KB 单页预算，超出置 bytesTruncated，按 nextOffset/nextItemOffset 续页。content/anim 是摘要，细节用 queryDetails。',

        queryDetails: '查询 AE 对象详情。对象用稳定键定位（compositionId/layerId/footageId/effectIndex），索引与名字会漂移。target=comp：合成详情；includeTimeline:true 附事件表（关键帧/图层入出/标记，timelineOffset/timelineLimit 分页，整段 12KB 预算；截断看 timelineBytesTruncated、本页空看 timelineEventsStarved）。target=layer：图层细节（蒙版、文本与 Text Animator、图层样式〔全部样式带 enabled，未启用条目默认只给骨架，参数要 includeDisabledLayerStyleParams:true；参数树递归子组，样式参数关键帧要 includeLayerStyleAnimation:true〕、效果清单、关键帧与表达式、形状树）；fields 选块（不传=默认，layer 默认不含 content）；蒙版顶点要 includeMaskVertices:true；关键帧按 keyframeOffset/keyframeLimit 分页（默认 0/30、上限 200），逐属性起点用 keyframeOffsets；形状叶子值要 includeShapeValues:true。target=selected：同 layer 字段，只对返回页（itemOffset/itemLimit）提取详情。target=footage：素材详情。target=effect：效果参数树，用 propertyFilter/propertyOffset/propertyLimit/maxNodes 收窄，叶子关键帧用 keyframeOffset/keyframeLimit（默认 0/100），嵌套组用 groupPath/groupOffset 续读；不接受 compName。整响应 24000 预算，关键帧/形状/载荷各 12KB；截断带 *Truncated/*Capped/*Starved 标记，续页用 next*；starved 时不要按 next* 重试。参数级细节见各参数说明；id/index 传 null 等于未传，未知 field 报错。'
    };

    function get(name) {
        return Object.prototype.hasOwnProperty.call(SHORT, name) ? SHORT[name] : null;
    }

    // 注册用 buildDescription(reader)：external-mcp 读短版，其它 reader（agent/script/shader/
    // team/空串）读 def.description。无短版返回 null（注册表不挂该字段）。
    function build(def) {
        if (!def || !def.name) return null;
        var short = get(def.name);
        if (!short) return null;
        return function (reader) {
            return reader === 'external-mcp' ? short : def.description;
        };
    }

    global.AEExternalReadToolDescriptions = { get: get, build: build, SHORT: SHORT };
})(window);
