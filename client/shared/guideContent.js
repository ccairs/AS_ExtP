/**
 * guideContent.js — guide 指导工具的内容源
 *
 * 分界：规则 = 用户想要什么（get_rule/set_rule，用户拥有）；
 * 本文件 = 引擎怎么用好（扩展版本拥有，与工具面严格同步——故随代码分发，
 * 不放用户数据目录）。
 *
 * 主题纪律：清单体、可执行三元组（做什么+用什么工具+怎么验证）、
 * 不写叙事；长度随主题内容增长，超预算拆主题而非截断。
 *
 * shader 主题不复制契约文本：正文来自**全量契约**（client/shared/glslApiReference.txt，经
 * AEEngine.getShaderContract() 访问器读盘缓存）+ 切分模块 client/shared/glslContractTopics.js
 * ——与面板 shader 轮同一份内容源、同一套切分（契约不随 submit_shader 描述下发：客户端按
 * 2048 字符静默截断，后半段送不到）。
 * 外接的取节入口是 guide('shader:<节名>')（面板用 shader_contract 工具——两个读者面的工具不同，
 * 索引行按读者分叉产出，见 glslContractTopics.indexText 的 reader 参数）。
 *
 * 双环境加载：
 *   - Node（测试）：module.exports = { listTopics, getTopic, TOPICS }
 *   - CEP 面板：window.AEGuideContent = { listTopics, getTopic, TOPICS }
 */
(function (global) {
    'use strict';

    var TOPICS = ['index', 'production', 'shader', 'conventions'];

    // ── shader 主题的取数 ──
    // 全量契约经面板同一个访问器读（bootstrap 读盘缓存在 AEEngine.getShaderContract）；
    // 切分/索引由 glslContractTopics.js 做。两者任一不可用 → 如实报缺（不假装有契约）。
    function _contractText() {
        try {
            if (global.AEEngine && typeof global.AEEngine.getShaderContract === 'function') {
                return String(global.AEEngine.getShaderContract() || '');
            }
        } catch (_) {}
        return '';
    }
    function _topics() {
        return (global.AEGlslContractTopics
            && typeof global.AEGlslContractTopics.splitSections === 'function')
            ? global.AEGlslContractTopics : null;
    }
    function _shaderSectionIds() {
        var T = _topics();
        return T ? T.allSections() : [];
    }

    // ── 主题正文（正文只住这里；shader 例外——取契约模块，不复制）──
    var INDEX = [
        '可用主题（用 guide(topic) 拉取）：',
        '- production：完整出片流程（结构→素材→效果→动效→自查→渲染）与每步验证口径。触发：一句话成片、完整制作类任务。',
        '- shader：GLSL 效果契约（入口函数/内置变量/相机灯光/参数规范）。触发：写或修改 GLSL/JS 效果前。'
        + '可选特性按节取（guide(\'shader\') 文末索引列了全部节名）：guide(\'shader:layers\')／'
        + 'guide(\'shader:solve\')／guide(\'shader:iter\') 等。',
        '- conventions：项目结构、命名与规格约定。触发：建工程、整理工程、交付前自查。'
    ].join('\n');

    // production 主题：外接 Agent 的出片 playbook（骨架）。
    // 清单体：每步 = 做什么 + 用什么工具 + 怎么验证；不写叙事。
    var PRODUCTION = [
        '## 一、开工前置',
        '1. get_rule 拉取用户个人约定；有则覆盖本 playbook 的默认约定。',
        "2. 结构约定读 guide('conventions')（建工程/整理工程时必读）。",
        '3. 任务含 3 个以上环节时先列计划（用客户端自有规划机制）。',
        '4. 合成/渲染队列操作前先查 app.project 非空。',
        '',
        '## 二、六步工作流',
        '每步 = 做什么 + 用什么工具 + 怎么验证。',
        '',
        '① 结构规划',
        "- 做什么：按 guide('conventions') 建主合成与预合成。",
        '- 工具：executeExtendScript。',
        '- 验证：queryProject(target=browse) 回读结构，确认合成名/尺寸/帧率/时长。',
        '',
        '② 素材',
        '- 做什么：生成素材（官方模板优先）或导入已有素材。',
        '- 工具：comfyui_search_official_templates → comfyui_run_official_template / comfyui_generate / comfyui_run_workflow（异步：comfyui_check_status 轮询到 done，outputs 给输出路径）；导入用 importFile。',
        '- 验证：queryDetails 确认素材已落位、命名合规、无 Missing。',
        '',
        '③ 效果',
        "- 做什么：写 GLSL/JS 效果前先读 guide('shader') 契约。",
        '- 工具：submit_shader（GLSL）/ submit_js_effect（JS 编排）；失败按返回 error 修正重提。',
        '- 验证：提交返回编译通过；getShaderPreview 截图看画面（动画/结算器效果传 timesInSeconds 2–6 个时间点，一次得到带时间标签的联系表）。',
        '- 带扩散的效果（模糊/发光/阴影）在图层边界被裁切：小尺寸层、形状层按合成尺寸（comp.width × comp.height）建层，或把效果放到调整层/预合成；ADBE Grow Bounds 本机加不上。',
        '',
        '④ 动效',
        "- 做什么：关键帧/表达式动画；效果参数寻址见 guide('conventions') 的挂载条目。",
        '- 工具：executeExtendScript（一组成员修改用 beginUndoGroup 包裹）。',
        '- 验证：getPreviewFrame 抽查关键时间点；动画连贯性/出场层次用 timesInSeconds（2–6 个时间点）一次得到一张带时间标签的联系表。核对动画不要先渲染整段视频。',
        '- 只判断可量化特征（明暗、过曝欠曝、主色、饱和度、清晰度、噪声、局部区域曝光）时用 analyzeImage：不传 filePath 抓当前合成帧并回图（可用 compName/compositionId/compositionIndex + timeInSeconds 指定合成与时间；timesInSeconds 抓多个时间点逐帧分析并回联系表），传 filePath 分析已有图片只取指标；传 comparePath 与参考图对比（PSNR/SSIM/变化像素占比/哈希距离，多帧时逐帧对比并给最佳帧）；指标与截图可交叉验证。',
        '',
        '⑤ 自查',
        '- 做什么：多时间点预览帧做视觉自查（构图/文字/黑帧/穿帮/形变连续性），并检查宿主渲染日志。',
        '- 工具：getPreviewFrame；analyzeImage（像素指标：亮度分布/过曝欠曝/动态范围/主色/饱和度/清晰度/噪声/局部区域；传 filePath 时只回指标不回图）；get_render_error。',
        '- 修复环：确定性错误（编译错/参数错）读返回文案修正重提；同一错误重试上限 3 次，超限停下向用户报告现状与已试方案，不继续盲试。',
        '',
        '⑥ 渲染',
        '- 做什么：检查渲染队列 → 入队渲染 → 确认产物。',
        '- 工具：queryProject(target=renderQueue) 查队列与状态；渲染本身用 executeExtendScript 写原生 AE API（如 `var q = app.project.renderQueue; q.render();`，阻塞式立即渲染）。',
        '- 要指定输出位置（默认 file 域关闭时 executeExtendScript 设不了 OutputModule.file）：用 renderComp（outputPath 必填，免 file 域——路径在工具内校验）。它新建该合成的队列项（预设校验通过后才移除同合成就项，校验失败不动旧项），可带 renderPreset / outputModulePreset（AE 本地模板名：先读 item.templates / outputModule(1).templates 拿可用名，不要按英文名猜）；省略 outputModulePreset 且产物是 .mp4/.m4v 时按扩展名自动挑 H.264 类模板（自动套用模板时回执 outputModulePresetAuto=true），挑不到直接报错并列出可用模板。覆盖前把旧产物改名留一代，并回执实际产物路径/大小/耗时/备份。',
        '- 渲染触发受在途门保护（引擎按 renderQueue / render( / renderComp 形态识别）。',
        '- 短片（≤30 秒）同步等待输出完成；等待期间不做其他写操作。render() 是阻塞调用——工具返回即渲染已结束（或已被中断），不需要再查一次队列确认；若调用超时，AE 侧可能仍在渲染：迟到完成/失败的回执会作为系统消息投回本 Agent，不要反复抓帧猜状态。',
        '- 验证：原生 render() 无回执字段，改看 queryProject(target=renderQueue) 的 outputFilePath（各队列项的实际产物路径）；格式由输出模块决定，与请求扩展名可能不同。',
        '- PNG 序列输出模块给产物追加帧号：请求 X.png 实际落盘 X.png00000；按实际产物路径读取（读图工具接受该后缀），不要按请求路径判断产物是否存在。renderComp 会按同基名发现实际产物并回填 productPath / renamedFrom：单帧且请求扩展名是图片时，它收尾改名为请求的精确文件名；多帧序列不改名，回执给 products 逐帧路径与 productNote。需要精确文件名也可用 comp.saveFrameToPng 写单帧。',
        '',
        '## 三、交付前清单',
        "- conventions 自查通过：命名、父子层级、素材无 Missing。",
        '- 渲染产物确认：路径、时长、无黑帧。',
        '- 向用户总结：做了什么、关键参数、遗留问题。'
    ].join('\n');

    // conventions 主题：默认约定集（建工程/整理工程/交付前自查）。
    // 基准跑发现的违反项在此升级为强约束；用户个人约定（get_rule）优先覆盖。
    var CONVENTIONS = [
        '- 用户个人约定（get_rule）优先于本默认集；有冲突以用户约定为准。',
        '',
        '## 命名',
        '- 主合成：MASTER_<项目名>；预合成：<用途>_pre（如 BG_pre、TXT_pre）。',
        '- 素材：生成素材 comfyui_<主题>_<两位序号>；导入素材保留原名，重名加 _v2。',
        '- 图层：类型前缀 + 用途——TXT_ 文字 / SHAPE_ 形状 / ADJ_ 调整层 / FX_ 效果层（如 TXT_title）。',
        '- 自定义效果实例：matchName 恒为 AS_Effect_Host；参数用 matchName 按槽位寻址——文件索引 AS_Effect_Host-0210、uniform 槽位 AS_Effect_Host-0(500+4i+c)（i=实例内槽位，c=分量 0..3；c=1..3 依次为向量 y/z/w 或颜色 g/b/a）。所有槽位参数的 .name 都不可依赖（c=0 恒为空、c=1..3 可能停留注册期名），一律按槽位寻址。映射图层开关 AS_Effect_Host-0135/-0136/-0137（映射图层 1/2/3）、三维摄像机开关 -0139、三维灯光开关 -0141。写值 `eff.property("AS_Effect_Host-0500").setValue(值)`，读 `.value` 确认（0.37 写入读回 0.37000000476837，float32 精度）。',
        '',
        '## 结构',
        '- 自定义效果挂载：executeExtendScript 为该图层 addProperty 名为 AS_Effect_Host 的效果，并写入文件索引与 uniform 槽位值；文件索引用 shader_library 的 hostOrder，刚保存的文件用 save 回执的 diskIndex。时序约束：写文件索引与写槽位值要分成两次调用——写索引会让宿主把该实例的槽位值重置为文件声明的默认值（回读确认见上一条）。',
        '- 多实例：AS_Effect_Host 支持同一图层叠加多个实例（每个实例各有独立的文件索引与 uniform 槽位值）；实例以 ADBE Effect Parade 内的索引定位（layer.property("ADBE Effect Parade").property(i)），参数再按 matchName 在该实例内寻址。',
        '- 效果粒度：除特殊要求，一个自定义效果实现一项视觉处理（如模糊、调色、置换）；整体画面由多个效果实例组合而成（同图层叠加或分布在不同图层），不由单个效果整体生成。',
        '- 效果选型：优先使用 AE 内置效果（内置效果列表查 queryEnvironment(target=availableEffects)；缓存未生成时该 target 返回 status=unavailable 的降级说明，不会报错——此时用 queryAeApi 查 matchName，或按原生路径 addProperty 挂载）；自定义 GLSL/JS 效果用于内置效果无法实现或者不能满足需求的部分。',
        '',
        '## 规格与时长',
        '- 默认 1920×1080 / 30fps。',
        '',
        '## 素材纪律',
        '- 交付前 queryEnvironment 检查 Missing 与表达式错误。',
        '- 引用层素材（asset_library 的 asset_refs 库）导入 AE 后再修改，不回写外部路径。',
        '',
        '## 读取分层',
        '- 模糊查询用 queryProject：图层条目带 content 摘要（effects/masks/keyframes/text/textAnimators/layerStyles 计数；keyframes 与 anim.keys 同口径——5 个变换属性 + Audio Levels（在 ADBE Audio Group 下）+ Time Remap（AVLayer 且已启用）+ Source Text，蒙版/效果关键帧看 masks/effects 计数；layerStyles 只计已启用样式，未启用样式在 queryDetails 的 layerStyles 里看）。先看 content 的计数判断该层是否带对应内容，带则用 queryDetails 取细节。',
        '- 细节查询用 queryDetails：target=layer 返回蒙版（路径形态与关键帧、羽化/不透明度/扩展关键帧）、文本（主样式、Source Text 关键帧、Text Animator 与范围选择器）、图层样式（全部样式子组带 enabled，未启用条目默认只给骨架，其参数需 includeDisabledLayerStyleParams:true；参数树递归子组，叶子有 numKeys/expression，关键帧需 includeLayerStyleAnimation:true）与效果清单；蒙版顶点默认只给数量，需要坐标时传 includeMaskVertices:true。',
        '- 效果参数树用 target=effect（逐个效果，配 propertyFilter/maxNodes 收窄）；target=layer 只给效果清单（name/matchName/enabled/index）。',
        '',
        '## 自查口径',
        '- 交付前 queryProject 回读：合成数、图层命名前缀、素材 Missing 数。',
        '- 临时探测对象：合成/图层统一用 __TMP_ 前缀；收尾用 Item.remove 删除（Item.remove 在能力白名单；projectDeleteItem 已删除，不要引用）。交付前回读确认无 __TMP_ 对象。',
        '',
        '## API 备忘',
        // 通道口径：下面「菜单域」那句对**两条通道
        // 都成立**——面板走 toolExecutionPipeline → ast-gate；外接的 authored 代码同日经
        // extBridgeClient 的**门 6** 过同一道门（source 同为 agent-tool）⇒ menu 域关则两通道都被拒。


        '- 菜单命令：`app.executeCommand(命令ID)`；`app.findMenuCommandId(路径)` 由路径查 ID（路径语言相关：非英文 AE 上传英文路径返回 0），命令 ID 跨语言通用。菜单域需在「Agent 模块设置 > AST 门能力配置」开启。',
        '- 关键帧缓动：缓动/切线数组长度以已有键的 `keyInTemporalEase(1).length` 为准——空间属性（位置/锚点）常为 1，勿按值维度推。',
        // 这条知识也写进指南——门只在拒信里给（validate.js 的
        // NoArgModal 拒信），即只有面板通道在被拒时才知道——而 pull 恰好删掉了唯一带护栏的
        // 保存实现（自实现 saveProject：未保存先拒 + 路径校验 + 产物核查），护栏随之单边化。
        // 外接通道没有门、确认表里也无 executeExtendScript 条目 → 零参 save 一路到内核。
        // 指南两通道共读（外接有 guide 工具），故落在这里补平。
        // 提示词只写操作事实，
        // 不确定性用条件式事实表达（「可能…」），不写依据出处。
        // 本条目为「工具优先 + 代码通道原生写法」；
        // 历史注释保留（护栏单边化的那条已由工具侧守卫收回）。
        '- 保存工程：参数式工具 `saveProject({filePath})`——带 filePath 另存，省略则存回原路径（工程从未保存过且省略 filePath 时被拒）。代码通道写 `if (app.project.file) app.project.save(app.project.file);`；零参 `app.project.save()` 在未保存过的工程上会弹「另存为」模态（或报错），无人值守不用；`new File(...)` 需文件能力域。',
        // 外接会话实测三条被拒写法：写可用写法与否证项，不写依据。
        '- 遮罩子属性：羽化 / 不透明度 / 形状按 matchName 取——`mask.property("ADBE Mask Feather")`、`("ADBE Mask Opacity")`、`("ADBE Mask Shape")`，写值 `property(...).setValue(值)`（羽化接受数值或 [x, y]）；`mask.maskFeather` 形态被 AST 门拒。',
        '- 渲染输出：OutputModule 无 `format` 成员，格式以模板名表达——读 `om.templates`，应用用 `om.applyTemplate(名)`；`om.file` 受文件能力域。`om.getSettings()` 的返回值是字符串或字典，不要在它上面取成员或动态键。',
        '- 形状图层渐变填充的停止点不可脚本写：读/写 `ADBE Vector Grad Colors` 报 `PropertyValueType.NO_VALUE`，`addStop` 不在能力白名单。改用纯色层 + 遮罩 + `ADBE Ramp`，或 `ADBE 4ColorGradient`。',
        '- 亮度实测：AE 23.5 脚本没有 `Layer.sampleImage`（调用即 ReferenceError，补表也无用）。不要在脚本里找像素采样入口；需要量化亮度时先导出单帧 PNG，再由面板/外部工具统计。',
        '- setValueAtTime 时间基：time 参数是合成时间（layer.startTime=2 时 setValueAtTime(3,…) 的 keyTime(1)=3）；图层有 startTime 偏移时关键帧时间 = layer.startTime + 本地时间。',
        '- addSolid 时长：省略 duration 时 source.duration=0（不随合成时长）；显式传 duration。',
        '- shape contents 的 addProperty 追加到列表末尾，即渲染最下层（列表自上而下 = 从前到后）；多个组按从上到下的顺序添加。',
        '- 摄像机 POI：`ADBE Camera POI` 在 Options/Transform 两组都返回 null；实际槽位是 `ADBE Transform Group` 下的 `ADBE Anchor Point`（UI 名「目标点」），默认值为 addCamera 传入的中心点。'
    ].join('\n');

    function listTopics() {
        return TOPICS.slice().concat(_shaderSectionIds().map(function (id) { return 'shader:' + id; }));
    }

    function getTopic(topic) {
        var t = String(topic == null ? '' : topic).trim() || 'index';
        if (t === 'index') {
            return { ok: true, topic: 'index', content: INDEX };
        }
        if (t === 'shader' || t.indexOf('shader:') === 0) {
            var T = _topics();
            var full = _contractText();
            if (!T || !full) {
                return { ok: false, error: 'SHADER_CONTRACT_UNAVAILABLE' };
            }
            if (t === 'shader') {
                // 核心常驻 + 能力索引，与面板 shader 轮同一份内容源、同一套切分；
                // 索引里的取节入口按读者面产出（外接 = guide('shader:<id>')）。
                return {
                    ok: true,
                    topic: 'shader',
                    content: 'AS_ExtP GLSL 效果契约（提交前必读；用到可选特性前按文末索引取对应节）：\n\n'
                        + T.coreText(full) + '\n\n' + T.indexText([], 'external')
                };
            }
            var sec = t.slice('shader:'.length).trim();
            if (_shaderSectionIds().indexOf(sec) < 0) {
                return { ok: false, error: 'UNKNOWN_TOPIC', available: listTopics() };
            }
            var body = (sec === 'core') ? T.coreText(full) : T.topicsText(full, [sec]);
            if (!body) {
                return { ok: false, error: 'SHADER_SECTION_EMPTY' };
            }
            return { ok: true, topic: t, content: body };
        }
        if (t === 'production') {
            return { ok: true, topic: 'production', content: PRODUCTION };
        }
        if (t === 'conventions') {
            return { ok: true, topic: 'conventions', content: CONVENTIONS };
        }
        return { ok: false, error: 'UNKNOWN_TOPIC', available: listTopics() };
    }

    var api = { listTopics: listTopics, getTopic: getTopic, TOPICS: TOPICS.slice() };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof global !== 'undefined') {
        global.AEGuideContent = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
