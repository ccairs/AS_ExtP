// ast-gate/tables.js — AST 编译门：三张表数据
// （client/modules/ast-gate/，双端模块：CEP 面板 window / Node globalThis）
//
// 「表是数据不是代码」——条目级变更不动引擎。
// Task 2 落表①② + meta-property 黑名单；Task 3 增表③（类型表）。
//
// 实证基线（114 份 LLM 历史脚本）：
//   全局面 = app / CompItem(89) / TextLayer(42) / String(22) / Math(16) /
//   AVLayer(4) / FootageItem(2) / JSON(1)；File/Folder/alert/callSystem 全零。
//   宿主函数桩全集 9（运行时 ae_tools.json 实测）；saveProject（参数式
//   保存工具入口）→ 10。
(function (global) {
    'use strict';

    var tables = {};

    // ── 表① 节点类型白名单 ──────────────────────────────────────
    // reemit 覆盖全集 − WithStatement（拒：作用域混淆逃逸面）。
    // getter/setter 字面量等 ES5+ 形态由 parser（ecmaVersion:3）在 parse 层拒。
    tables.NODE_TYPES = {
        Program: 1, VariableDeclaration: 1, VariableDeclarator: 1,
        FunctionDeclaration: 1, ExpressionStatement: 1, IfStatement: 1,
        ForStatement: 1, ForInStatement: 1, WhileStatement: 1, DoWhileStatement: 1,
        ReturnStatement: 1, BreakStatement: 1, ContinueStatement: 1,
        BlockStatement: 1, EmptyStatement: 1, LabeledStatement: 1,
        SwitchStatement: 1, SwitchCase: 1, ThrowStatement: 1, TryStatement: 1,
        CatchClause: 1, DebuggerStatement: 1,
        Identifier: 1, Literal: 1, ThisExpression: 1, ArrayExpression: 1,
        ObjectExpression: 1, Property: 1, FunctionExpression: 1,
        UnaryExpression: 1, UpdateExpression: 1, BinaryExpression: 1,
        LogicalExpression: 1, AssignmentExpression: 1, ConditionalExpression: 1,
        SequenceExpression: 1, MemberExpression: 1, CallExpression: 1,
        NewExpression: 1
    };

    // ── meta-property 全局黑名单（挂所有接收者，独立于表③）──────────
    // 逃逸核心：constructor/__proto__ 链取得 Function 构造器即击穿
    // 不变量 1/2；prototype 是原型篡改面（补丁可在 AE 运行时跨脚本存活——
    // 环境持久化注入，正是 monkey-patch 时代「封版」要解决的问题在门下的镜像）；
    // caller/callee/arguments 是函数内部逃逸面。合法 AE 脚本零使用场景。
    tables.META_PROPERTIES = {
        'constructor': 1,
        '__defineGetter__': 1, '__defineSetter__': 1,
        '__lookupGetter__': 1, '__lookupSetter__': 1,
        'prototype': 1, 'caller': 1, 'callee': 1, 'arguments': 1
    };
    // '__proto__' 在对象字面量中是原型设置器（不创建自有属性，条目会静默丢失）——
    // 必须 defineProperty 定义为普通自有键
    Object.defineProperty(tables.META_PROPERTIES, '__proto__', {
        value: 1, enumerable: true, writable: true, configurable: true
    });

    // ── 常见错名 → 正确成员名（type-scoped）────────
    // 只收现场验证过的两例：Layer.blendMode（正确的是 blendingMode，tables.js 里
    // Layer.blendingMode w:1）与 TextDocument.sourceText（正确的是 text——
    // TextProp.sourceText 是合法成员，故别名只对 TextDocument 接收者生效）。
    // 未收录成员时只按本表点名替代，不做通用模糊匹配（编辑距离召回不可靠）。
    tables.MEMBER_ALIAS = {
        'Layer': { 'blendMode': 'blendingMode' },
        'AVLayer': { 'blendMode': 'blendingMode' },
        'TextDocument': { 'sourceText': 'text' }
    };

    // ── 未收录成员 → 正确官方替代（type-scoped 诊断表）────────
    // **只用于拒绝文案，不是能力表**：此表不参与 entryOn/memberOn，不影响放行、
    // 域闸、受限类型与放行判定——成员未收录照旧 fail-closed 拒，这里只把
    // 「官方没有这个成员」与「官方等价写法是什么」写进 reason/alternative。
    // 收录判据：成员名不是官方 API 成员（官方脚本指南核实），而调用方意图明确、
    // 官方有等价入口。三项来源：Layer.moveTo / Layer.numEffects /
    // LayerCollection.addComp（三次被拒后
    // LLM 把不存在的成员记成「官方 API 但白名单缺」并写进记忆）。
    // 结构按接收者类型分组，值 = 可直接照抄的官方调用串；新增类型/成员只加数据。
    // 文案尾部统一带「不是官方 API、不要提议补表添加」——run.js 的通用尾注会引导
    // 用 propose_table_entry 补成员，对这些不存在的成员必须说清相反结论。
    tables.MEMBER_REPLACEMENTS = {
        'Layer': {
            // 官方 Layer 方法表只有 moveBefore/moveAfter/moveToBeginning/moveToEnd，
            // 无 moveTo（层排序按层序号/相邻层调整）。
            'moveTo': '层排序改用官方 Layer 方法：layer.moveBefore(otherLayer) / layer.moveAfter(otherLayer)'
                + ' / layer.moveToBeginning() / layer.moveToEnd()（该成员不是官方 API，不要提议补表添加）',
            // 官方 Layer 无 numEffects；效果组经 Property API 取——
            // layer.property("ADBE Effect Parade").numProperties（同族 numProperties 在表中）。
            'numEffects': '效果数量用 layer.property("ADBE Effect Parade").numProperties；'
                + '按名/序号取效果用 layer.effect(name) / layer.property(index)'
                + '（该成员不是官方 API，不要提议补表添加）'
        },
        'LayerCollection': {
            // 官方 LayerCollection 无 addComp（创建族是 add/addNull/addText/addSolid/
            // addShape/addCamera/addLight/precompose 等）；新建合成在 ItemCollection，
            // 嵌套已有合成用 comp.layers.add(compItem)。
            'addComp': '新建合成用 app.project.items.addComp(name, width, height, pixelAspect, duration, frameRate)；'
                + '把已有合成嵌套进当前合成用 comp.layers.add(compItem)（该成员不是官方 API，不要提议补表添加）'
        }
    };

    // 接收者类型 → 典型取用表达式（「同名成员在别的类型表」态的点名示例）。
    // 只做文案示例，不参与判定；未登记的类型只报类型名。
    tables.TYPE_RECEIVER_EXAMPLES = {
        'Project': 'app.project',
        'CompItem': 'app.project.item(i) / app.project.activeItem',
        'FolderItem': 'app.project.rootFolder / item.parentFolder',
        'FootageItem': 'app.project.item(i)',
        'ItemCollection': 'app.project.items / folderItem.items',
        'LayerCollection': 'comp.layers',
        'Layer': 'comp.layer(i)',
        'Property': 'layer.property(name|index)'
    };

    // ── 表② 标识符白名单 ─────────────────────────────────────────
    // kind 语义：
    //   ae-global      AE DOM 根（表③ 类型挂点）
    //   ae-class       instanceof 专用类对象（成员面全拒——防原型探测）
    //   builtin-object 内建对象（成员走 MATH_MEMBERS/JSON_MEMBERS）
    // builtin-call 仅函数调用转换形态（成员拒——String.fromCharCode 口径）
    //   builtin-fn     安全内建函数
    //   builtin-literal undefined/NaN/Infinity
    //   injected       执行环境预注入（result 可写）
    //   host-fn        宿主函数（桩调用面）：仅裸调用位置，成员/赋值均拒
    //   builtin-ctor   内建构造器（new Error——错误处理惯用法，零逃逸面）
    //   ae-ctor        AE 数据构造器（new Shape/MarkerValue/KeyframeEase——
    //                  实例类型=表③同名条目承载成员面；类对象面密封）
    tables.IDENTIFIERS = {
        'app': 'ae-global',
        'CompItem': 'ae-class', 'TextLayer': 'ae-class', 'AVLayer': 'ae-class',
        'FootageItem': 'ae-class', 'FolderItem': 'ae-class',
        // Layer 子类判型面（instanceof 右侧）：纯原型链比对，无执行无能力面。
        // AVItem / Item 刻意不收——官方明定二者在 ExtendScript 中不存在，
        // instanceof 会因标识符 undefined 而失败。
        'CameraLayer': 'ae-class', 'LightLayer': 'ae-class', 'ShapeLayer': 'ae-class',
        // ThreeDModelLayer 自 AE 24.4、ParametricMeshLayer 自 AE 26.3；更早版本上
        // 标识符 undefined，instanceof 抛 ReferenceError，须先判存在。
        'ThreeDModelLayer': 'ae-class', 'ParametricMeshLayer': 'ae-class',
        // 纯数据构造器（官方 other/ 章节三件——遮罩形状/标记/
        // 缓急曲线，均无 IO 面）。ae-ctor：可 new（实例类型 = 同名 TYPES 条目），
        // 类对象面密封（作值成员全拒）
        'Shape': 'ae-ctor', 'MarkerValue': 'ae-ctor', 'KeyframeEase': 'ae-ctor',
        // 导入选项构造器。官方三步
        // `app.project.importFile(new ImportOptions(new File(p)))` 在标识符层被整拒
        // （域全开也拒）——而 client/shared/aeApiReference.txt 有 ImportOptions 专章
        //（:1834-1859）教它，queryAeApi 会把 LLM 引到一条过不了门的路上。
        // 工具层能力没丢（平台 importFile/replaceFootage 在册），此处补的是**脚本内**可达面。
        'ImportOptions': 'ae-ctor',
        // 参考线配置构造器（AE 26.5+）：纯数据对象，无 IO 面。
        'GuideOptions': 'ae-ctor',
        'Error': 'builtin-ctor',
        // Date 构造器（builtin-ctor + TYPES.Date 同名条目——
        // new Date() 实例面与 Date.now/parse/UTC 静态面共用一表，纯计算无 IO）。
        // AE 23.5 实测：Date.now 存在且可用；toISOString 缺席（唯一）——见 TYPES.Date
        'Date': 'builtin-ctor',
        // Object/Array 构造器对象面（builtin-object——仅静态方法
        // 经 TYPES 同名条目受控；new/裸调用拒，prototype 等成员面不收录=拒）。
        // AE 23.5 上 Object.keys/Array.isArray 存在且可用——标识符层整拒
        // 是假阴性（无安全价值的摩擦）
        'Object': 'builtin-object', 'Array': 'builtin-object',
        'Math': 'builtin-object', 'JSON': 'builtin-object', 'String': 'builtin-call',
        'parseInt': 'builtin-fn', 'parseFloat': 'builtin-fn',
        'isNaN': 'builtin-fn', 'isFinite': 'builtin-fn',
        // ES3 全局纯函数，零副作用：URI 编/解码四件——
        // 路径/URL 字符串处理常用
        'encodeURIComponent': 'builtin-fn', 'decodeURIComponent': 'builtin-fn',
        'encodeURI': 'builtin-fn', 'decodeURI': 'builtin-fn',
        // docsforadobe Global Functions 表，AE 原生全局：
        // isValid（AE 对象存活性检查）、时间码换算对（帧时间码↔秒——AE 脚本
        // 高频需求，否则 LLM 只能手工算帧）、线程安全随机数（AE 13.6+，
        // 官方建议优先于 Math.random）。均纯计算、无文件/网络/系统面
        'isValid': 'builtin-fn', 'timeToCurrentFormat': 'builtin-fn',
        'currentFormatToTime': 'builtin-fn', 'generateRandomNumber': 'builtin-fn',
        // AE 24.0 起可用：枚举数值 → 名称串（如 5220 → "BlendingMode.ADD"）。
        'getEnumAsString': 'builtin-fn',
        // Info 面板输出面，无文件/系统/网络副作用。
        'write': 'builtin-fn', 'writeLn': 'builtin-fn', 'clearOutput': 'builtin-fn',
        'undefined': 'builtin-literal', 'NaN': 'builtin-literal', 'Infinity': 'builtin-literal',
        // AE 关键帧插值枚举对象（builtin-object——成员面走表③
        // KeyframeInterpolationType 条目：LINEAR/BEZIER/HOLD 三个常量，纯数字
        // 零副作用。实测外部 Agent 用 KeyframeInterpolationType.BEZIER 被标识符
        // 白名单拒，只能硬编码 7613 魔数）
        'KeyframeInterpolationType': 'builtin-object',
        // 查看器类型枚举（viewer.type 比较——官方 Viewer 示例即
        // viewer.type === ViewerType.VIEWER_COMPOSITION 模式；值 7612-7614 纯数字）
        'ViewerType': 'builtin-object',
        // 遮罩三枚举（官方 maskpropertygroup.md 逐条核对——成员
        // 面即 MaskMode.NONE/ADD/…、MaskFeatherFalloff.FFO_*、MaskMotionBlur.*，
        // 均为纯数字常量、零副作用；对应 maskMode/maskFeatherFalloff/maskMotionBlur
        // 三个属性的可写值面。否则三个标识符全被白名单拒，LLM 只能硬编码魔数）
        'MaskMode': 'builtin-object',
        'MaskFeatherFalloff': 'builtin-object',
        'MaskMotionBlur': 'builtin-object',
        // 能力静默丢失：库函数整链清理删掉了 6 个
        // 「枚举薄包装」——它们原本替 LLM 把字符串映射成枚举值；函数没了，LLM 必须自己写
        // 枚举，而这 7 个标识符全被白名单拒、**数值在可达面零来源**（错值静默生效：
        // 设错混合模式/遮罩型别不报错，用户看到「说设好了、画面不对」）。
        // 名字来源逐条取自**被删实现当时的真实用法** + client/shared/aeApiReference.txt，
        // 不引入任何新数值；同遮罩三枚举先例。
        'BlendingMode': 'builtin-object',            // 原 setLayerBlendMode：BlendingMode[enumKey]（旧 aeTools.jsx:1563）
        'TrackMatteType': 'builtin-object',          // 原 setTrackMatte：TrackMatteType.ALPHA/…（旧 :4836 + 参考 :779）
        'AutoOrientType': 'builtin-object',          // 原 setAutoOrient：AutoOrientType[…]/ALONG_PATH（旧 :5880/:4339）
        'LightType': 'builtin-object',               // 原 setLightProperties：LightType.POINT/…（旧 :4791 + 参考 :854）
        'ParagraphJustification': 'builtin-object',  // 原 setTextStyle：ParagraphJustification.LEFT_JUSTIFY/…（旧 :4724/:1332）
        'PurgeTarget': 'builtin-object',             // 原 purgeMemory：app.purge(PurgeTarget.…)(旧 :4935 + 参考 :110)
        'PropertyValueType': 'builtin-object',       // 原 getPropertyInfo/_pvName：PropertyValueType[name]（旧 :3837 + 参考 :943）
        // `PropertyType` 是 AE 全局枚举——官方
        // PropertyBase.propertyType 明写取值为 PropertyType.PROPERTY / INDEXED_GROUP /
        // NAMED_GROUP（docsforadobe「PropertyBase」页；仓库参考 aeApiReference.txt:1177-1206
        // 同款用法）。成员面在下方 TYPES['PropertyType']；两处必须**同时**在，否则标识符层或
        // 成员层任一层仍拒。注意：官方只有三个成员，**不收录 PROPERTY_GROUP**（该名字在
        // 本机为 undefined；aeTools.jsx:2900 用它属宿主侧另一个缺陷，补表时不得跟着收）。
        'PropertyType': 'builtin-object',
        // 素材解释枚举四件：成员面在下方 TYPES 同名条目，取值为纯数字常量、只读。
        'AlphaMode': 'builtin-object',
        'FieldSeparationType': 'builtin-object',
        'PulldownPhase': 'builtin-object',
        'PulldownMethod': 'builtin-object',
        // 枚举对象面：成员为纯数字常量，只读、零副作用；成员面在 TYPES 同名条目，
        // 标识符与成员两处必须同时在，任缺一层仍拒。
        'LayerQuality': 'builtin-object',
        'LayerSamplingQuality': 'builtin-object',
        'FrameBlendingType': 'builtin-object',
        'SceneEditDetectionMode': 'builtin-object',
        'PostRenderAction': 'builtin-object',
        'LogType': 'builtin-object',
        'RQItemStatus': 'builtin-object',
        'GetSettingsFormat': 'builtin-object',
        'CloseOptions': 'builtin-object',
        'ResolveType': 'builtin-object',
        'ImportAsType': 'builtin-object',
        'TimeDisplayType': 'builtin-object',
        'FramesCountType': 'builtin-object',
        'FeetFramesFilmType': 'builtin-object',
        'FootageTimecodeDisplayStartType': 'builtin-object',
        'FastPreviewType': 'builtin-object',
        'PREFType': 'builtin-object',
        'ToolType': 'builtin-object',
        // 官方类型段写 Metal、示例段写 METAL，两处不一致；只收拼写一致的三名。
        'GpuAccelType': 'builtin-object',
        'AutoKernType': 'builtin-object',
        'BaselineDirection': 'builtin-object',
        'BoxAutoFitPolicy': 'builtin-object',
        'BoxFirstBaselineAlignment': 'builtin-object',
        'BoxVerticalAlignment': 'builtin-object',
        'ComposerEngine': 'builtin-object',
        'DigitSet': 'builtin-object',
        'FontBaselineOption': 'builtin-object',
        'FontCapsOption': 'builtin-object',
        'LeadingType': 'builtin-object',
        'LineJoinType': 'builtin-object',
        'LineOrientation': 'builtin-object',
        'ParagraphDirection': 'builtin-object',
        'CTFontTechnology': 'builtin-object',
        'CTFontType': 'builtin-object',
        'CTScript': 'builtin-object',
        'SubstitutedFontReplacementMatchPolicy': 'builtin-object',
        // 参考线枚举（AE 26.5+）：orientationType/positionType 的整数值跨版本不同，
        // 须比常量而非裸整数。
        'GuideOrientationType': 'builtin-object',
        'GuidePositionType': 'builtin-object',
        'ParametricMeshType': 'builtin-object',
        'ChannelType': 'builtin-object',
        'result': 'injected', '__args': 'injected'
    };

    // ── 弹窗族通道规则（「弹窗 = 通道固有属性」）────────
    // alert/confirm/prompt 是阻断式系统弹窗、ScriptUI 类族（Window 及控件类）
    // 是 UI 界面——合法性取决于「执行时有没有人在场」而非能力信任，故不走
    // 能力域配置（全局域开关无法表达 per-source 区分）：
    //   DIALOG_SOURCES 内的 source（用户手动点运行的通道）→ 放行（真弹窗——
    //     核侧跳过 alert 重定向且不 shadow confirm/prompt；Window 实例类型链
    //     为 'ui-object'：任意静态键可读/写/调、结果自传播，computed 键放行；
    //     控件类经 w.add() 返回同 'ui-object' 链）
    //   其余 source（agent-tool/ae-tool——LLM 自动执行、无人在场）→ 静态拒
    //     （弹窗会挂起 AE 线程）；核侧纵深：帧载荷未授 dialog 时 alert→$.writeln
    //     重定向 + confirm/prompt shadow throw（ScriptUI 类核侧不 shadow——门侧
    //     静态拒已覆盖，弹窗族 shadow 仅纵深兜 bypass/旁路）。bypass 不放行
    //     （对齐逃逸形态零例外——免打扰不是免检）。Agent 通道的信息回传走
    //     result 返回值；UI 面板需求引导用户在 Script 模式运行。
    // 控件类族（无危险全收录——instanceof 判型/new 构造
    // 走弹窗通道规则；类面 = 官方 JavaScript Tools Guide ScriptUI 章节。
    // 作值时类型 'u'——成员/调用面照拒，类对象面天然密封）。
    // FlashPlayer 刻意不收录：可加载外部 swf 执行内容——非「无危险」。
    // 门侧拒绝经 validate checkIdentifierUse 的 DIALOG 分支（source 经 run.js
    // gate(opts.source) 传入；缺 source 默认拒——fail-closed）。
    tables.DIALOG_IDS = {
        'alert': 1, 'confirm': 1, 'prompt': 1,
        'Window': 1, 'Group': 1, 'Panel': 1,
        'Button': 1, 'IconButton': 1, 'Checkbox': 1, 'RadioButton': 1,
        'StaticText': 1, 'EditText': 1, 'Slider': 1, 'ProgressBar': 1,
        'ListBox': 1, 'ListItem': 1, 'DropDownList': 1,
        'TreeView': 1, 'TreeItem': 1,
        'Tab': 1, 'TabbedPanel': 1, 'ScrollView': 1
    };
    tables.DIALOG_SOURCES = { 'llm-preview': 1, 'user-library': 1 };

    // 宿主函数面（参数式工具面——）：
    // aeTools.jsx 公开函数全集（顶层 function 声明，读只扩展目录 = 可信代码，
    // 类型表的宿主函数条目 = 参数式工具面）。桩（`result = <fn>(__args);`）
    // 与 agent-tool 内联调用（`result = createTextLayer(__args)`）同面共用。
    // 实证：LLM 语料零直接调用（工具走 JSON 桩），此面主要为桩/存量库覆盖。
    // 刻意排除（fail-closed，逐个再评估）：
    //   _ 前缀内部函数 / __ael* 沙箱内部引用
    // executeMenuCommand 原在此列（menu 能力域，
    //   经 POLICY_GATED.identifiers 挂域闸）——该宿主函数已删除（它是
    //   app.findMenuCommandId + app.executeCommand 的薄包装，两个官方 API 均在门表内），
    //   menu 域现由 POLICY_GATED.members 的 app.executeCommand 单点承载。
    // **撤销 saveProject 条**——不再维护自实现的
    //   saveProject 宿主函数（连同其产物核查 helper _verifySavedArtifact 一并删除），
    //   改用**原生 app.project.save([file])**，同时**放开**它的 file 域闸
    //   （Project 表 'save' 条目去 d:'file'，见该处注释）。
    //   理由：saveProject 本就是在原生 API 上套护栏（路径校验 + 产物核查 + 未保存
    //   工程防模态），而这三条护栏在「库函数整链清理」的方向下不值得再维护一份
    //   宿主实现；保存是 AE 工程的基本操作，交回原生面。
    //   **保留不变**：saveWithDialog / close / importFile / importFileWithDialog /
    //   setDefaultImportFolder 的 file 域闸；saveWithDialog 的 dlg 弹窗闸照旧
    //   （Agent 通道弹系统对话框会挂起 AE）。即：本次只放开 'save' 一条。
    tables.HOST_FNS = {
        // 查询/信息
        'queryProject': 1, 'queryDetails': 1, 'queryEnvironment': 1,
        'getProjectInfo': 1, 'getActiveCompInfo': 1, 'getLayerInfo': 1,
        'getPropSafe': 1, 'getSubProp': 1, 'findEffectByName': 1,
        'getLayerTarget': 1, 'getActiveComp': 1, 'getCompOrThrow': 1,
        'collectKeyframes': 1, 'listLayers': 1, 
        'getSelectedOverview': 1, 'getSelectedDetails': 1, 
        'getEffectInfo': 1, 'getEffectsBatch': 1, 
        
        'getRenderQueueInfo': 1, 'getCompInfo': 1, 'getFootageInfo': 1,
        // 参数式渲染：输出路径在宿主实现内校验（_checkPath + 敏感路径 +
        // 系统目录/盘根），故免 file 域——这是「不放开 OutputModule.file」的替代入口。
        'renderComp': 1,
        'browseProject': 1, 'searchProject': 1, 'getDiagnostics': 1,
        'getInstallPath': 1,
        // 文件/素材（参数式读写工具——敏感路径防线在宿主实现内）
        'importFile': 1, 'replaceFootage': 1, 'listFolderFiles': 1,
        'getPreviewFrame': 1,
        // 参数式图片分析（analyzeImage 工具入口：文件模式只回元数据，抓帧模式
        // 复用 getPreviewFrame；像素统计在面板侧 imageAnalysis.js，不走宿主）
        'analyzeImage': 1,
        // 参数式保存工具：这里的名字是 **ae_tools.json 工具入口**
        //（其 extendScript 就是 `result = saveProject(__args);` 这一行），不是
        // 那个「LLM 在自写代码里按名调用的宿主库函数」——后者
        // 已随库函数整链清理删除，保存改走原生 app.project.save([file])。但原生
        // save 的 file 参数只能来自 `new File(...)`（挂 file 域闸，域关 fail-closed）
        // 或 `app.project.file`（只指向已保存过的工程文件）⇒ file 域关时 LLM 仍**无法
        // 另存**（实测：`new File(...)` 被拒 → 只能求用户开域）。
        // 本工具补回该能力：路径从工具参数传入、宿主侧建 File，带路径校验 + 敏感路径
        // 拦截 + 产物分档核查 + 未保存工程先拒（实现与守卫见 aeTools.jsx `saveProject`）。
        'saveProject': 1,
        // 保存工程：自实现 saveProject 已随库函数整链清理删除，保存走原生
        // app.project.save()（'save' 条目去 file 域闸，见本表上方注释）。
        
        // 工程内操作（undo group 地盘）
        'createTextLayer': 1,
        'applyPreset': 1,
        // 框架内建
        'executeExtendScript': 1, 'undoLastOperation': 1, 
        'openInViewer': 1, 
    };
    for (var _hfn in tables.HOST_FNS) {
        if (Object.prototype.hasOwnProperty.call(tables.HOST_FNS, _hfn)) {
            tables.IDENTIFIERS[_hfn] = 'host-fn';
        }
    }

    // Math 成员（ES3 全集——纯计算，无副作用面）
    tables.MATH_MEMBERS = {
        'abs': 1, 'acos': 1, 'asin': 1, 'atan': 1, 'atan2': 1, 'ceil': 1, 'cos': 1,
        'exp': 1, 'floor': 1, 'log': 1, 'max': 1, 'min': 1, 'pow': 1, 'random': 1,
        'round': 1, 'sin': 1, 'sqrt': 1, 'tan': 1,
        'E': 1, 'LN2': 1, 'LN10': 1, 'LOG2E': 1, 'LOG10E': 1, 'PI': 1,
        'SQRT1_2': 1, 'SQRT2': 1
    };

    // JSON 成员（运行时 = json2.jsx）
    tables.JSON_MEMBERS = { 'parse': 1, 'stringify': 1 };

    // builtin-fn 裸调用返回类型（数据驱动化——原 isNaN/isFinite
    // 内联特判并入表；新补 URI 编解码/AE 原生全局随表维护，缺省 'number'）
    tables.BUILTIN_FN_RETURNS = {
        'isNaN': 'boolean', 'isFinite': 'boolean', 'isValid': 'boolean',
        'timeToCurrentFormat': 'string',
        'getEnumAsString': 'string',
        'write': 'u', 'writeLn': 'u', 'clearOutput': 'u',
        'encodeURIComponent': 'string', 'decodeURIComponent': 'string',
        'encodeURI': 'string', 'decodeURI': 'string'
    };

    // primitive 成员（ES3 原型方法白名单——实证清单 + 标准安全集；
    // trim：AE 23.5 实测 String.prototype.trim 存在且可用）
    tables.STRING_MEMBERS = {
        'charAt': 1, 'charCodeAt': 1, 'concat': 1, 'indexOf': 1, 'lastIndexOf': 1,
        'localeCompare': 1, 'match': 1, 'replace': 1, 'search': 1, 'slice': 1,
        'split': 1, 'substr': 1, 'substring': 1, 'toLowerCase': 1, 'toUpperCase': 1,
        'toString': 1, 'valueOf': 1, 'length': 1, 'trim': 1
    };
    tables.NUMBER_MEMBERS = {
        'toFixed': 1, 'toExponential': 1, 'toPrecision': 1,
        'toString': 1, 'valueOf': 1
    };
    tables.ARRAY_MEMBERS = {
        'concat': 1, 'join': 1, 'pop': 1, 'push': 1, 'reverse': 1, 'shift': 1,
        'slice': 1, 'sort': 1, 'splice': 1, 'unshift': 1,
        'toString': 1, 'valueOf': 1, 'length': 1
    };

    // ── 表③ 类型表 v1（实证基线驱动 + fail-closed 兜底）──────
    // 成员条目：{ t: 类型, m: 'm' = 方法（可调用）; 省略 m = 属性; w: 1 = 可写;
    // d: 域名（条目挂能力域闸，域关时被抑制即现行拒路径） }
    // 类型语法：
    //   'a|b|c'   联合（any-member 语义 + 受限类型一票否决——RESTRICTED_TYPES）
    //   'array<X>' 数组元素类型；'u' unknown（成员/调用一律拒）；'self' 同接收者
    //   'user-object' 用户对象字面量（静态/动态键放行，结果 'u'）
    //   'user-object{k1:T1,k2:T2}' 带形状的字面量（validate.objShapeType
    //     产出）：已记录键取真实类型，未记录键回落与裸 'user-object' 相同的
    //     {t:'u',w:1}——只锐化不收紧；值为 'u' 的键不收录，同键异类型取并集
    //     （成员类型可含 '|'——splitTypes 深度计法已含花括号）
    // 受限类型：FileHandle（AE DOM 返回的真实 File 实例的只读句柄面）——
    // 写路径原语（open/remove/rename/copy/changePath/execute/encoding…）
    // 不列条目即拒；写路径原语挂 d:'file' 域闸收录
    //   （域开=文件能力授权，changePath/execute 仍刻意不收录），受限否决语义
    //   （联合一票否决）不受域开关影响；parent 返回 FolderObj 受限句柄。
    tables.RESTRICTED_TYPES = { 'FileHandle': 1 };

    // 已登记集合类型的数值索引元素类型（computedOn 用）：AE 集合对象（Collection
    // 子类）只有 length 与自身成员，没有 Array.prototype 方法。索引面在此单独建模
    // ——数值下标返回元素类型；字符串字面量键仍拒。集合类型不要与 array<X> 写成
    // 联合：any-member 语义会让 slice/push/map 等方法在集合接收者上放行。
    tables.COLLECTIONS = {
        'ItemCollection': 'CompItem|FolderItem|FootageItem',
        'LayerCollection': 'Layer',
        'RQItemCollection': 'RenderQueueItem',
        'OMCollection': 'OutputModule'
    };

    tables.TYPES = {
        'app': {
            'project': { t: 'Project' },
            'findMenuCommandId': { t: 'number', m: 'm' },
            'fonts': { t: 'FontsObject' },
            // executeCommand（菜单枢纽）收录但挂 menu 域闸（POLICY_GATED.members
            // 名挂点——域关时条目被抑制，拒绝附 error.domain='menu'）；scheduleTask
            // 未收录即拒（延迟执行面）。撤销组（begin/endUndoGroup）收录：
            // 脚本自写优先、框架兜底——脚本可自写撤销组（执行核检测到即跳过框架包裹，避免
            // 嵌套 mismatch）；不写则由框架自动包裹（aeTools.jsx executeExtendScript）。
            'executeCommand': { t: 'u', m: 'm' },
            'beginUndoGroup': { t: 'u', m: 'm' },
            'endUndoGroup': { t: 'u', m: 'm' },
            // 官方 Application 全量核对，只收只读查询/无害面：
            'version': { t: 'string' },
            'isoLanguage': { t: 'string' },
            'buildName': { t: 'string' },
            'buildNumber': { t: 'number' },
            'isRenderEngine': { t: 'boolean' },
            'isWatchFolder': { t: 'boolean' },
            'memoryInUse': { t: 'number' },
            'activeViewer': { t: 'Viewer' },
            'availableGPUAccelTypes': { t: 'array<u>' },
            'effects': { t: 'array<EffectRef>' },          // 效果查询（遍历 matchName 用）
            'activate': { t: 'u', m: 'm' },                // AE 置前
            'purge': { t: 'u', m: 'm' },                   // 内存清理
            // FILE 面挂 file 域闸收录（白名单服务
            // Agent+Script 双模式——Script 用户在场可能需要文件操作；域开=
            // 文件能力授权，域关=现行拒路径，与 FileHandle 先例同构）：
            'open': { t: 'Project', m: 'm', d: 'file' },           // 打开工程文件
            'openFast': { t: 'Project', m: 'm', d: 'file' },       // 快速打开（跳过部分检查）
            'parseSwatchFile': { t: 'user-object', m: 'm', d: 'file' } // 解析 .ase/.xml 色板
            // 刻意不收录（fail-closed，官方同名成员）：newProject（纯工程重置，
            // 无文件语义且丢弃当前工程）；quit/restart/cancelTask（终止/延迟执行——
            // 硬拒族 scheduleTask 同族）；begin/endSuppressDialogs（对话抑制，与门
            // 通道机制交互）；watchFolder 族（渲染农场模式）；onError（回调执行面）；
            // preferences/settings（全局偏好修改面）；saveProjectOnCrash/
            // disableRendering/exitCode/exitAfterLaunchAndEval/setMemoryUsageLimits/
            // setMultiFrameRenderingConfig/setSavePreferencesOnQuit（运行状态面）
        },
        'Project': {
            'item': { t: 'CompItem|FolderItem|FootageItem', m: 'm' },
            'numItems': { t: 'number' },
            // 索引面由 tables.COLLECTIONS 建模（items[i] → Item 联合），成员面见
            // ItemCollection（addComp/addFolder）；不写成 array 联合
            'items': { t: 'ItemCollection' },
            'rootFolder': { t: 'FolderItem' },
            'file': { t: 'FileHandle' },
            'activeItem': { t: 'CompItem|FolderItem|FootageItem' },
            // 官方 Project 全量核对——工程内属性/方法全收：
            'bitsPerChannel': { t: 'number', w: 1 },
            'compensateForSceneReferredProfiles': { t: 'boolean', w: 1 },
            'dirty': { t: 'boolean' },
            'displayStartFrame': { t: 'number', w: 1 },
            'expressionEngine': { t: 'string', w: 1 },
            'feetFramesFilmType': { t: 'number', w: 1 },
            'footageTimecodeDisplayStartType': { t: 'number', w: 1 },
            'framesCountType': { t: 'number', w: 1 },
            'framesUseFeetFrames': { t: 'boolean', w: 1 },
            'gpuAccelType': { t: 'number', w: 1 },
            'linearBlending': { t: 'boolean', w: 1 },
            'linearizeWorkingSpace': { t: 'boolean', w: 1 },
            'revision': { t: 'number' },
            'selection': { t: 'array<CompItem|FolderItem|FootageItem>' },
            'timeDisplayType': { t: 'number', w: 1 },
            'toolType': { t: 'number', w: 1 },
            'transparencyGridThumbnails': { t: 'boolean', w: 1 },
            // AE 24.5+：每条记录 = 字体对象 + 使用位置数组。
            'usedFonts': { t: 'array<user-object{font:FontObject,usedAt:array<user-object{layerID:number,layerTimeD:number}>}>' },
            'workingGamma': { t: 'number', w: 1 },
            'workingSpace': { t: 'string', w: 1 },
            'xmpPacket': { t: 'string', w: 1 },
            'autoFixExpressions': { t: 'u', m: 'm' },
            'consolidateFootage': { t: 'number', m: 'm' },
            'importPlaceholder': { t: 'FootageItem', m: 'm' },
            'itemByID': { t: 'CompItem|FolderItem|FootageItem', m: 'm' },
            'layerByID': { t: 'Layer', m: 'm' },
            'listColorProfiles': { t: 'array<string>', m: 'm' },
            'reduceProject': { t: 'number', m: 'm' },
            'removeUnusedFootage': { t: 'number', m: 'm' },
            'replaceFont': { t: 'boolean', m: 'm' },
            'showWindow': { t: 'u', m: 'm' },
            // FILE 面挂 file 域闸收录（Script 模式文件
            // 操作需求；域关=现行拒——saveAs/save 文件写原语维度经域闸授权）。
            // **'save' 单条摘除 file 域闸**（保存工程交回
            // 原生面，不再由自实现 saveProject 代劳——后者已连同 _verifySavedArtifact
            // 一并删除）。**saveAs 等其余条目不动**：本表无 'saveAs' 条目，
            // Project 上也无该原生方法（另存语义就是 save(file)）。
            // WithDialog 族另挂 dlg 弹窗闸（仅 Script 通道可用——Agent 通道弹系统
            // 对话框挂起 AE）：
            // **保留**放开 file 域闸，但空实参形态另挂
            // noArgModal 闸——工程从未保存过时 `app.project.save()` 不能在无人通道安全执行：
            // 会走 AE「另存为」模态挂起 AE，或按官方文档口径直接报错（`client/shared/
            // aeApiReference.txt`：未保存过且未提供 file 则报错；两种口径未在真机核对，
            // 闸按保守面拦）。`save(file)` 是另存语义、不弹模态，故**只拦空实参形态**
            //（含 null/undefined/void，见 validate.isEmptyArgs）；通道口径同 dlg 闸
            //（仅 DIALOG_SOURCES 即预览区/用户库放行）。**引用位另禁**（取引用/转发会绕过
            // 实参判定，见 validate 的 NoArgModalRef）。
            'save': { t: 'u', m: 'm', noArgModal: 1 },
            'saveWithDialog': { t: 'boolean', m: 'm', d: 'file', dlg: 1 },
            'close': { t: 'boolean', m: 'm', d: 'file' },
            'importFile': { t: 'FootageItem', m: 'm', d: 'file' },
            'importFileWithDialog': { t: 'array<CompItem|FolderItem|FootageItem>', m: 'm', d: 'file', dlg: 1 },
            'setDefaultImportFolder': { t: 'boolean', m: 'm', d: 'file' },
            // 渲染队列入口（渲染输出常用；RenderQueue
            // 族类型建模见 SocketObj 后；输出路径经 OutputModule.file 赋值 = File
            // 对象，file 域开时核侧 _GateFile 构造期敏感路径检查 = 位置限制）
            'renderQueue': { t: 'RenderQueue' }
            // 核对后仍刻意不收录：Team Projects 15 方法（网络协作面）
        },
        // ItemCollection（官方 ItemCollection 章节核对）：工程内合成/文件夹创建面——
        // 与 LayerCollection 创建族（addText/addSolid/precompose…）同风险类：非文件写/
        // 系统执行面，无域闸。Project.items 与 FolderItem.items 的数值索引由
        // tables.COLLECTIONS 建模（items[i] → CompItem|FolderItem|FootageItem）；
        // 本类型只提供成员面。length 为官方 Collection 基类属性
        //（LayerCollection/RQItemCollection/OMCollection 同款）。
        'ItemCollection': {
            'addComp': { t: 'CompItem', m: 'm' },    // addComp(name, width, height, pixelAspect, duration, frameRate)
            'addFolder': { t: 'FolderItem', m: 'm' }, // addFolder(name)
            'length': { t: 'number' }
        },
        'CompItem': {
            'layer': { t: 'Layer', m: 'm' },
            'numLayers': { t: 'number' },
            'selectedLayers': { t: 'array<Layer>' },
            // 数值索引由 tables.COLLECTIONS 建模（layers[i] → Layer），成员面见 LayerCollection
            'layers': { t: 'LayerCollection' },
            'name': { t: 'string', w: 1 },
            'label': { t: 'number', w: 1 },
            'openInViewer': { t: 'Viewer', m: 'm' },   // View/Viewer 建模
            'width': { t: 'number', w: 1 },
            'height': { t: 'number', w: 1 },
            'duration': { t: 'number', w: 1 },
            'time': { t: 'number', w: 1 },
            'frameDuration': { t: 'number', w: 1 },  // 官方 rw（核对修正）
            'pixelAspect': { t: 'number', w: 1 },
            // 补表（官方 CompItem/AVItem/Item 全量核对，扁平并入继承面）：
            'activeCamera': { t: 'Layer' },                     // CameraLayer 按 Layer
            'bgColor': { t: 'array<number>', w: 1 },
            'comment': { t: 'string', w: 1 },
            'displayStartFrame': { t: 'number', w: 1 },
            'displayStartTime': { t: 'number', w: 1 },
            'draft3d': { t: 'boolean', w: 1 },
            'dropFrame': { t: 'boolean', w: 1 },
            'footageMissing': { t: 'boolean' },
            'frameBlending': { t: 'boolean', w: 1 },
            'frameRate': { t: 'number', w: 1 },
            'hasAudio': { t: 'boolean' },
            'hasVideo': { t: 'boolean' },
            'hideShyLayers': { t: 'boolean', w: 1 },
            'id': { t: 'number' },
            'markerProperty': { t: 'Property' },                // PropertyGroup 扁平
            'motionBlur': { t: 'boolean', w: 1 },
            'motionBlurAdaptiveSampleLimit': { t: 'number', w: 1 },
            'motionBlurSamplesPerFrame': { t: 'number', w: 1 },
            'motionGraphicsTemplateControllerCount': { t: 'number' },
            'motionGraphicsTemplateName': { t: 'string', w: 1 },
            'parentFolder': { t: 'FolderItem', w: 1 },
            'preserveNestedFrameRate': { t: 'boolean', w: 1 },
            'preserveNestedResolution': { t: 'boolean', w: 1 },
            'proxySource': { t: 'FootageSource' },
            'renderer': { t: 'string', w: 1 },
            'renderers': { t: 'array<string>' },
            'resolutionFactor': { t: 'array<number>', w: 1 },
            'selected': { t: 'boolean', w: 1 },
            'selectedProperties': { t: 'array<Property>' },
            'shutterAngle': { t: 'number', w: 1 },
            'shutterPhase': { t: 'number', w: 1 },
            'typeName': { t: 'string' },
            'usedIn': { t: 'array<CompItem>' },
            'useProxy': { t: 'boolean', w: 1 },
            'workAreaDuration': { t: 'number', w: 1 },
            'workAreaStart': { t: 'number', w: 1 },
            'duplicate': { t: 'CompItem', m: 'm' },
            'getMotionGraphicsTemplateControllerName': { t: 'string', m: 'm' },
            'setMotionGraphicsControllerName': { t: 'string', m: 'm' },
            'openInEssentialGraphics': { t: 'u', m: 'm' },
            // 补录：FILE 面挂 file 域闸收录（AVItem setProxy
            // 族扁平并入 + .mogrt 导出；域关=现行拒）：
            'setProxy': { t: 'u', m: 'm', d: 'file' },
            'setProxyToNone': { t: 'u', m: 'm', d: 'file' },
            'setProxyWithPlaceholder': { t: 'u', m: 'm', d: 'file' },
            'setProxyWithSequence': { t: 'u', m: 'm', d: 'file' },
            'setProxyWithSolid': { t: 'u', m: 'm', d: 'file' },
            'exportAsMotionGraphicsTemplate': { t: 'boolean', m: 'm', d: 'file' },
            // 补录（Item.remove() 不在白名单）：
            // Item 基类 remove()——官方语义「从项目和项目面板中删除此项；此项为
            // FolderItem 时内含项一并删除；不删磁盘上的文件或文件夹」（scripts
            // guide Item 章）。属「工程内操作，undo group 地盘」默认放行
            // 面，同类先例已收录：Layer/Property/RenderQueueItem/OutputModule 的
            // remove。无域闸（不触磁盘、无系统执行面）；宿主函数 projectDeleteItem 已随
            // 库函数整链清理删除，本条即其裸 DOM 路径的接替面。
            'remove': { t: 'u', m: 'm' },
            // Item 基类参考线族（AE 16.1+）：条目形状与版本差异同 Layer.guides。
            'guides': { t: 'array<user-object{orientationType:number,positionType:number,position:number,color:array<number>,pinned:boolean}>' },
            'addGuide': { t: 'number', m: 'm' },
            'removeGuide': { t: 'u', m: 'm' },
            'setGuide': { t: 'u', m: 'm' },
            'getGuideAsObject': { t: 'GuideOptions', m: 'm' },   // AE 26.5+
            'dynamicLinkGUID': { t: 'string' },
            // AVItem 面：能否作 Property.setAlternateSource 的替换源（AE 18.0+）
            'isMediaReplacementCompatible': { t: 'boolean' }
            // 刻意不收录：counters（官方未文档化且无功能）
        },
        'LayerCollection': {
            'addNull': { t: 'Layer', m: 'm' },
            'add': { t: 'Layer', m: 'm' },
            // 补表（分诊遗漏）：官方图层创建族全收——addText/
            // addSolid/addShape 等与 add/addNull 同风险类（工程内图层创建，
            // 非文件写/系统执行面）；addCamera/addLight 返回 CameraLayer/
            // LightLayer（Layer 子类，表内无独立类型——按 Layer 收录）
            'addText': { t: 'Layer', m: 'm' },
            'addBoxText': { t: 'Layer', m: 'm' },
            'addSolid': { t: 'Layer', m: 'm' },
            'addShape': { t: 'Layer', m: 'm' },
            'addCamera': { t: 'Layer', m: 'm' },
            'addLight': { t: 'Layer', m: 'm' },
            // 补表（官方 LayerCollection 核对）：
            'addVerticalText': { t: 'Layer', m: 'm' },       // AE 24.2+
            'addVerticalBoxText': { t: 'Layer', m: 'm' },    // AE 24.2+
            'byName': { t: 'Layer', m: 'm' },                // 常用：按名取层
            'precompose': { t: 'CompItem', m: 'm' },         // 工程内预合成
            'addParametricMesh': { t: 'Layer', m: 'm' },     // AE 26.3+；ParametricMeshLayer 按 Layer
            'length': { t: 'number' }
        },
        'Layer': {
            'property': { t: 'Property', m: 'm' },
            'name': { t: 'string', w: 1 },
            'inPoint': { t: 'number', w: 1 },
            'outPoint': { t: 'number', w: 1 },
            'startTime': { t: 'number', w: 1 },
            'stretch': { t: 'number', w: 1 },
            'enabled': { t: 'boolean', w: 1 },
            'selected': { t: 'boolean', w: 1 },
            'motionBlur': { t: 'boolean', w: 1 },
            'timeRemapEnabled': { t: 'boolean', w: 1 },
            'canSetCollapseTransformation': { t: 'boolean' },
            'collapseTransformation': { t: 'boolean', w: 1 },
            'hasVideo': { t: 'boolean' },
            'hasAudio': { t: 'boolean' },
            'parent': { t: 'Layer', w: 1 },
            // 官方 AVLayer.source → AVItem（CompItem 亦可为源——联合放宽）
            'source': { t: 'FootageItem|CompItem' },
            'index': { t: 'number' },
            // 补表（白名单补常用表）：
            // Layer.id —— 只读稳定键。证据：① aeApiReference.txt 的 Layer.id 条在册
            //（「唯一且持久的标识号…保存重载后不变」）；② **本仓自身把它当引用键**：
            // aeTools.jsx 的 _readLayerId/_findLayerById 与「引用当前选中」回传的 layerId、
            // prompt 里教 LLM 的「图层用 layerId」全建在这上面（索引会随增删重排漂移）；
            // ③ item 侧 Item.id 早已收录（CompItem/FolderItem/FootageItem 三张表），
            // 唯独 Layer 缺同名条目——属**同面不对称缺口**（同一寻址口径的另一半写不出来）。
            // 安全：纯只读数字（不触磁盘/系统/网络/菜单；写面照拒——id 由 AE 分配）。
            'id': { t: 'number' },
            'matchName': { t: 'string' },
            'blendingMode': { t: 'number', w: 1 },
            'transform': { t: 'Property' },
            // ── 补表（Layer 便捷访问器）：官方 Property 对象页示例
            // myLayer.position / myLayer.opacity + AE 实测 setValue ✓；等价
            // layer.transform.position（表达式文档等价表）。直赋值
            // layer.position = [x,y] 实测静默失败（值不变、无异常）→ 全组不标
            // w，写值统一走 .setValue（与 transform 同款只读引用条目）──
            'anchorPoint': { t: 'Property' },
            'position': { t: 'Property' },
            'scale': { t: 'Property' },
            'rotation': { t: 'Property' },
            'opacity': { t: 'Property' },
            // 3D 变换便捷访问器（3D 层/灯光/相机；2D 层运行时自然无值，同 lightType 语义）
            'pointOfInterest': { t: 'Property' },
            'orientation': { t: 'Property' },
            'xRotation': { t: 'Property' },
            'yRotation': { t: 'Property' },
            'zRotation': { t: 'Property' },
            'text': { t: 'TextProp' },
            'numProperties': { t: 'number' },
            'remove': { t: 'u', m: 'm' },
            'duplicate': { t: 'Layer', m: 'm' },
            'moveToBeginning': { t: 'u', m: 'm' },
            'moveToEnd': { t: 'u', m: 'm' },
            // ── 补表（官方 Layer/AVLayer/LightLayer 全量核对，扁平并入）──
            // Layer 基类属性：
            'comment': { t: 'string', w: 1 },
            'containingComp': { t: 'CompItem' },
            'isNameSet': { t: 'boolean' },
            'label': { t: 'number', w: 1 },
            'locked': { t: 'boolean', w: 1 },
            'marker': { t: 'Property' },                       // PropertyGroup 扁平
            'nullLayer': { t: 'boolean' },
            'selectedProperties': { t: 'array<Property>' },
            'shy': { t: 'boolean', w: 1 },
            'solo': { t: 'boolean', w: 1 },
            'time': { t: 'number' },
            'autoOrient': { t: 'number', w: 1 },               // AutoOrientType 枚举
            // Layer 基类方法：
            'activeAtTime': { t: 'boolean', m: 'm' },
            'applyPreset': { t: 'u', m: 'm' },                 // 读 .ffx 应用（同 HOST_FNS applyPreset 语义）
            'copyToComp': { t: 'u', m: 'm' },
            'moveAfter': { t: 'u', m: 'm' },
            'moveBefore': { t: 'u', m: 'm' },
            'setParentWithJump': { t: 'u', m: 'm' },
            // PropertyGroup / PropertyBase 继承面（Layer 是 PropertyGroup 子类）。
            // propertyIndex 在 Layer 上恒为 undefined，不收。
            // moveTo 只对索引组的子项有效，Layer 属命名组、调用即抛异常；
            // 层序调整走 moveBefore / moveAfter / moveToBeginning / moveToEnd。
            'active': { t: 'boolean' },
            'canSetEnabled': { t: 'boolean' },
            'elided': { t: 'boolean' },
            'isEffect': { t: 'boolean' },
            'isMask': { t: 'boolean' },
            'isModified': { t: 'boolean' },
            'parentProperty': { t: 'Property' },
            'propertyDepth': { t: 'number' },
            'propertyType': { t: 'number', w: 1 },
            'propertyGroup': { t: 'Property|Layer', m: 'm' },
            'addProperty': { t: 'Property', m: 'm' },
            'canAddProperty': { t: 'boolean', m: 'm' },
            // 参考线族（AE 16.1+）。条目形状随版本变化：orientationType/positionType/
            // position 自 16.1 起有，color/pinned 自 26.5 起有。两个 orientation/position
            // 枚举的整数值跨版本不同，比较须用 GuideOrientationType/GuidePositionType 常量。
            'guides': { t: 'array<user-object{orientationType:number,positionType:number,position:number,color:array<number>,pinned:boolean}>' },
            'addGuide': { t: 'number', m: 'm' },
            'removeGuide': { t: 'u', m: 'm' },
            // 两形参顺序相反：(position, guideIndex) 自 16.1；(guideIndex, GuideOptions) 自 26.5。
            'setGuide': { t: 'u', m: 'm' },
            'getGuideAsObject': { t: 'GuideOptions', m: 'm' },   // AE 26.5+
            // 场景剪辑检测（AE 22.3+）：返回检测到的剪辑点时间数组。
            // 非视频层或开了时间重映射的视频层上调用会报错。
            'doSceneEditDetection': { t: 'array<number>', m: 'm' },
            // ParametricMeshLayer 面（AE 26.3+，AVLayer 子类扁平并入）。
            // 两个 options 对象的键集随 parametricMeshType 变化，官方只列键路径、
            // 未给逐键类型，故按裸 user-object 收录（成员类型 unknown）。
            // parametricBevelOptions 只有 CUBE/CONE/CYLINDER 三种网格有。
            'parametricMeshType': { t: 'number', w: 1 },     // ParametricMeshType 枚举
            'parametricMeshOptions': { t: 'user-object', w: 1 },
            'parametricBevelOptions': { t: 'user-object', w: 1 },
            // AVLayer 面：
            'adjustmentLayer': { t: 'boolean', w: 1 },
            'audioActive': { t: 'boolean' },
            'audioEnabled': { t: 'boolean', w: 1 },
            // 补表：视频分量开关——原 setLayerSwitches 的
            // hasVideo 分支随库函数删除后，关闭图层视频分量**无任何可达路径**
            //（enabled 只能整层连音频一起关）。姊妹成员 audioEnabled 一直在表内，
            // 属遗漏非设计。官方成员名是 videoEnabled（hasVideo 为只读，见上）。
            'videoEnabled': { t: 'boolean', w: 1 },
            'canSetTimeRemapEnabled': { t: 'boolean' },
            'effectsActive': { t: 'boolean', w: 1 },
            'environmentLayer': { t: 'boolean', w: 1 },
            'frameBlending': { t: 'boolean' },
            'frameBlendingType': { t: 'number', w: 1 },
            'guideLayer': { t: 'boolean', w: 1 },
            'hasTrackMatte': { t: 'boolean' },
            'height': { t: 'number' },
            'isNameFromSource': { t: 'boolean' },
            'isTrackMatte': { t: 'boolean' },
            'preserveTransparency': { t: 'boolean', w: 1 },
            'quality': { t: 'number', w: 1 },                  // LayerQuality 枚举
            'samplingQuality': { t: 'number', w: 1 },
            'threeDLayer': { t: 'boolean', w: 1 },
            'threeDPerChar': { t: 'boolean', w: 1 },
            'trackMatteLayer': { t: 'Layer' },                 // AE 23.0+
            'trackMatteType': { t: 'number', w: 1 },
            'width': { t: 'number' },
            // AVLayer 方法（sourceRectAtTime 为文本/形状测尺寸高频用法）：
            'addToMotionGraphicsTemplate': { t: 'boolean', m: 'm' },
            'addToMotionGraphicsTemplateAs': { t: 'boolean', m: 'm' },
            'audioActiveAtTime': { t: 'boolean', m: 'm' },
            'calculateTransformFromPoints': { t: 'user-object', m: 'm' },
            'canAddToMotionGraphicsTemplate': { t: 'boolean', m: 'm' },
            'compPointToSource': { t: 'array<number>', m: 'm' },
            'openInViewer': { t: 'Viewer', m: 'm' },   // View/Viewer 建模
            'removeTrackMatte': { t: 'u', m: 'm' },
            'replaceSource': { t: 'u', m: 'm' },               // 工程内换源（无文件 IO）
            'setTrackMatte': { t: 'u', m: 'm' },
            'sourcePointToComp': { t: 'array<number>', m: 'm' },
            'sourceRectAtTime': { t: 'user-object', m: 'm' },  // {top,left,width,height}
            // LightLayer 面（CameraLayer 无自有脚本成员——参数走 Property API）：
            'lightType': { t: 'number', w: 1 },                // LightType 枚举
            'lightSource': { t: 'Layer', w: 1 },
            // ── 补表（层上 effect/mask 便捷访问器整族缺席）──
            // 签名（官方 Expression 参考 · Layer Sub-objects，逐字）：
            //   thisLayer.effect(name|index) → Effect 对象；thisLayer.mask(name|index) → Mask 对象
            // （按名时取效果控制/时间线面板最上方；按 index 从 1 计数）。ExtendScript 侧同一访问器
            // 有官方文档路径佐证——MaskPropertyGroup 页逐条属性路径即
            //   app.project.item(index).layer(index).mask(index).maskMode（…color/inverted/…同族）；
            // Adobe 随 AE 2023 发行的 ScriptUI Panels/VR Comp Editor.jsx 亦用
            //   layer.effect(kIndex).property(1).setValue(…)（本机 Support Files/Scripts 实证）。
            // 返回的都是 PropertyGroup 族对象，本门已把该族扁平并入 Property（见 Property 节
            // MaskPropertyGroup 注释），故按 'Property' + m:'m' 收录。**非新增能力面**：等价路径
            // layer.property("ADBE Mask Parade"|"ADBE Effect Parade").property(i) 本就放行，
            // 这里只是把官方便捷写法从误拦（fail-closed 未收录）转为放行。
            // 复数形态 layer.effects / layer.masks 官方文档未见条目（Types-for-Adobe 亦只有单数
            // effect/mask shortcut），签名不确定——不收录，走 propose_table_entry 补表闭环。
            'effect': { t: 'Property', m: 'm' },               // layer.effect(name|index)
            'mask': { t: 'Property', m: 'm' }                  // layer.mask(name|index)
            // 工程内操作面（layer 方法全放行精神 + 数据驱动条目化，
            // fail-closed——未列方法分诊补表）
        },
        'TextProp': {
            'sourceText': { t: 'Property' }
        },
        'Property': {
            // value/valueAtTime/keyValue 联合 = 官方 PropertyValueType 全量取值面
            // （property.md「Property.propertyValueType」逐项：OneD→number、
            // TwoD/ThreeD/COLOR→array<number>、TEXT_DOCUMENT→TextDocument、
            // MARKER→MarkerValue、SHAPE→Shape、LAYER_INDEX/MASK_INDEX→number；
            // NO_VALUE/CUSTOM_VALUE 无静态类型，按 'u' 兜底不列）。补
            // Shape/MarkerValue：遮罩路径回读（Mask Shape 的 .value.vertices）
            // 与标记回读（keyValue().comment）被 fail-closed 误拦（面板 Agent 会话
            // 实证）；写路径 setValue(new Shape()) 本就收录，属读写不对称缺口
            'value': { t: 'TextDocument|string|number|boolean|array<number>|Shape|MarkerValue', w: 1 },
            'setValue': { t: 'u', m: 'm' },
            'setValueAtTime': { t: 'u', m: 'm' },
            'setValueAtKey': { t: 'u', m: 'm' },
            'valueAtTime': { t: 'TextDocument|string|number|boolean|array<number>|Shape|MarkerValue', m: 'm' },
            'numKeys': { t: 'number' },
            'keyTime': { t: 'number', m: 'm' },
            'keyValue': { t: 'TextDocument|number|array<number>|Shape|MarkerValue', m: 'm' },
            'removeKey': { t: 'u', m: 'm' },
            'keyInInterpolationType': { t: 'number', m: 'm' },
            'keyOutInterpolationType': { t: 'number', m: 'm' },
            'keyInterpolationType': { t: 'number', m: 'm' },
            'setInterpolationTypeAtKey': { t: 'u', m: 'm' },
            'keyInTemporalEase': { t: 'array<KeyframeEase>', m: 'm' },
            'keyOutTemporalEase': { t: 'array<KeyframeEase>', m: 'm' },
            'setTemporalEaseAtKey': { t: 'u', m: 'm' },
            'expression': { t: 'string', w: 1 },
            'expressionEnabled': { t: 'boolean', w: 1 },
            'matchName': { t: 'string' },
            'name': { t: 'string', w: 1 },
            'numProperties': { t: 'number' },
            'propertyValueType': { t: 'number', w: 1 },
            'property': { t: 'Property', m: 'm' },
            'addProperty': { t: 'Property', m: 'm' },
            'enabled': { t: 'boolean', w: 1 },
            // PropertyGroup 快捷成员（transform 组——实证语料 layer.transform.position 形态）
            'anchorPoint': { t: 'Property' },
            'position': { t: 'Property' },
            'scale': { t: 'Property' },
            'rotation': { t: 'Property' },
            'opacity': { t: 'Property' },
            // ── 补表（官方 Property/PropertyBase/PropertyGroup 全量核对，扁平并入）──
            // PropertyBase 面：
            'active': { t: 'boolean' },
            'canSetEnabled': { t: 'boolean' },
            'elided': { t: 'boolean' },
            'isEffect': { t: 'boolean' },
            'isMask': { t: 'boolean' },
            'isModified': { t: 'boolean' },
            'parentProperty': { t: 'Property' },
            'propertyDepth': { t: 'number' },
            'propertyIndex': { t: 'number' },
            'propertyType': { t: 'number', w: 1 },
            'selected': { t: 'boolean', w: 1 },
            'duplicate': { t: 'Property', m: 'm' },
            'moveTo': { t: 'u', m: 'm' },
            'remove': { t: 'u', m: 'm' },
            'propertyGroup': { t: 'Property|Layer', m: 'm' },
            // PropertyGroup 面：
            'canAddProperty': { t: 'boolean', m: 'm' },
            // Property 自身属性：
            'alternateSource': { t: 'FootageItem|CompItem' },
            'canSetAlternateSource': { t: 'boolean' },
            'canSetExpression': { t: 'boolean' },
            'canVaryOverTime': { t: 'boolean' },
            'dimensionsSeparated': { t: 'boolean', w: 1 },
            'essentialPropertySource': { t: 'Property|Layer' },   // AE 22.0+；非基本属性上为 null
            'expressionError': { t: 'string' },
            'hasMax': { t: 'boolean' },
            'hasMin': { t: 'boolean' },
            'isDropdownEffect': { t: 'boolean' },
            'isSeparationFollower': { t: 'boolean' },
            'isSeparationLeader': { t: 'boolean' },
            'isSpatial': { t: 'boolean' },
            'isTimeVarying': { t: 'boolean' },
            'maxValue': { t: 'number' },
            'minValue': { t: 'number' },
            'selectedKeys': { t: 'array<number>' },
            'separationDimension': { t: 'number' },
            'separationLeader': { t: 'Property' },
            'unitsText': { t: 'string' },
            'propertyParameters': { t: 'array<string>' },       // AE 26.0+
            'valueText': { t: 'string' },                       // AE 26.0+；下拉菜单属性当前选中项文本
            // 层参数渲染阶段面（AE 26.5+）：只对 propertyValueType 为 LAYER_INDEX 的属性
            // 有效，其余属性上读取即抛异常。LayerInputStageType 是属性作用域的命名空间
            // 对象（不是全局标识符），哨兵值 SOURCE=0 / ALL_EFFECTS=-1 / ONLY_MASKS=-2。
            'layerInputStage': { t: 'number' },
            'inputLayerAndStage': { t: 'array<number>' },       // [layerIndex, stageIndex]
            'LayerInputStageType': { t: 'LayerInputStageType' },
            'getInputStageCycleSafeLimit': { t: 'number', m: 'm' },
            'setLayerInputStage': { t: 'u', m: 'm' },
            'setInputLayerAndStage': { t: 'u', m: 'm' },
            // 可变字体轴（AE 26.0+）：只能在文本动画器的 "ADBE Text Animator Properties"
            // 属性组上调用，轴须存在于字体上才有效果。
            'addVariableFontAxis': { t: 'Property', m: 'm' },
            // Property 方法：
            'addKey': { t: 'number', m: 'm' },
            'addToMotionGraphicsTemplate': { t: 'boolean', m: 'm' },
            'addToMotionGraphicsTemplateAs': { t: 'boolean', m: 'm' },
            'canAddToMotionGraphicsTemplate': { t: 'boolean', m: 'm' },
            'getSeparationFollower': { t: 'Property', m: 'm' },
            'isInterpolationTypeValid': { t: 'boolean', m: 'm' },
            'keyInSpatialTangent': { t: 'array<number>', m: 'm' },
            'keyLabel': { t: 'number', m: 'm' },
            'keyOutSpatialTangent': { t: 'array<number>', m: 'm' },
            'keyRoving': { t: 'boolean', m: 'm' },
            'keySelected': { t: 'boolean', m: 'm' },
            'keySpatialAutoBezier': { t: 'boolean', m: 'm' },
            'keySpatialContinuous': { t: 'boolean', m: 'm' },
            'keyTemporalAutoBezier': { t: 'boolean', m: 'm' },
            'keyTemporalContinuous': { t: 'boolean', m: 'm' },
            'nearestKeyIndex': { t: 'number', m: 'm' },
            'setAlternateSource': { t: 'u', m: 'm' },
            'setLabelAtKey': { t: 'u', m: 'm' },
            'setPropertyParameters': { t: 'Property', m: 'm' },
            'setRovingAtKey': { t: 'u', m: 'm' },
            'setSelectedAtKey': { t: 'u', m: 'm' },
            'setSpatialAutoBezierAtKey': { t: 'u', m: 'm' },
            'setSpatialContinuousAtKey': { t: 'u', m: 'm' },
            'setSpatialTangentsAtKey': { t: 'u', m: 'm' },
            'setTemporalAutoBezierAtKey': { t: 'u', m: 'm' },
            'setTemporalContinuousAtKey': { t: 'u', m: 'm' },
            'setValuesAtTimes': { t: 'u', m: 'm' },
            // ── 补表：MaskPropertyGroup 面（官方 property/maskpropertygroup.md
            // 全量逐条核对，7 成员全 read/write）──
            // 蒙版组经 layer.property("Masks")/("ADBE Mask Parade") 取出，门内
            // Property 族扁平并入，故挂在本类型下。整族缺席时：addMask 族工具
            // 之外，LLM 直接写 maskMode 被 MemberWrite 误拦（面板 Agent 会话实证，
            // 官方路径 app.project.item(index).layer(index).mask(index).maskMode）
            'maskMode': { t: 'number', w: 1 },              // MaskMode 枚举
            'inverted': { t: 'boolean', w: 1 },
            'locked': { t: 'boolean', w: 1 },
            'rotoBezier': { t: 'boolean', w: 1 },
            'maskFeatherFalloff': { t: 'number', w: 1 },    // MaskFeatherFalloff 枚举
            'maskMotionBlur': { t: 'number', w: 1 },        // MaskMotionBlur 枚举
            'color': { t: 'array<number>', w: 1 }           // [R,G,B] 0.0..1.0
        },
        'TextDocument': {
            'text': { t: 'string', w: 1 },
            'font': { t: 'string', w: 1 },
            'fontSize': { t: 'number', w: 1 },
            'fontObject': { t: 'FontObject', w: 1 },   // AE 24.0+；只反映首字符的字体
            // 补表（分诊遗漏）：官方文本样式面（对齐官方
            // TextDocument 样式字段）——fillColor/strokeColor 为 0~1 RGB 数组，
            // justification 为 ParagraphJustification 枚举（blendingMode 先例
            // 记 number）
            'fillColor': { t: 'array<number>', w: 1 },
            'strokeColor': { t: 'array<number>', w: 1 },
            'strokeWidth': { t: 'number', w: 1 },
            'applyFill': { t: 'boolean', w: 1 },
            'applyStroke': { t: 'boolean', w: 1 },
            'justification': { t: 'number', w: 1 },
            'leading': { t: 'number', w: 1 },
            'tracking': { t: 'number', w: 1 },
            // ── 补表（官方 TextDocument 61 属性全量核对——纯样式数据面）──
            'allCaps': { t: 'boolean' },
            'autoHyphenate': { t: 'boolean', w: 1 },
            'autoLeading': { t: 'boolean', w: 1 },
            'autoKernType': { t: 'number', w: 1 },
            'baselineDirection': { t: 'number', w: 1 },
            'baselineLocs': { t: 'array<number>' },            // 官方未标读写——按只读
            'baselineShift': { t: 'number', w: 1 },
            'boxAutoFitPolicy': { t: 'number', w: 1 },
            'boxFirstBaselineAlignment': { t: 'number', w: 1 },
            'boxFirstBaselineAlignmentMinimum': { t: 'number', w: 1 },
            'boxInsetSpacing': { t: 'number', w: 1 },
            'boxOverflow': { t: 'boolean' },
            'boxText': { t: 'boolean' },
            'boxTextPos': { t: 'array<number>', w: 1 },
            'boxTextSize': { t: 'array<number>', w: 1 },
            'boxVerticalAlignment': { t: 'number', w: 1 },
            'composedLineCount': { t: 'number' },
            'composerEngine': { t: 'number', w: 1 },
            'digitSet': { t: 'number', w: 1 },
            'direction': { t: 'number', w: 1 },
            'endIndent': { t: 'number', w: 1 },
            'everyLineComposer': { t: 'boolean', w: 1 },
            'fauxBold': { t: 'boolean', w: 1 },                // 写入 AE 24.0+
            'fauxItalic': { t: 'boolean', w: 1 },              // 写入 AE 24.0+
            'firstLineIndent': { t: 'number', w: 1 },
            'fontBaselineOption': { t: 'number', w: 1 },
            'fontCapsOption': { t: 'number', w: 1 },
            'fontFamily': { t: 'string' },
            'fontLocation': { t: 'string' },
            'fontStyle': { t: 'string' },
            'hangingRoman': { t: 'boolean', w: 1 },
            'horizontalScale': { t: 'number', w: 1 },
            'kerning': { t: 'number', w: 1 },
            'leadingType': { t: 'number', w: 1 },
            'ligature': { t: 'boolean', w: 1 },
            'lineJoinType': { t: 'number', w: 1 },
            'lineOrientation': { t: 'number', w: 1 },
            'noBreak': { t: 'boolean', w: 1 },
            'paragraphCount': { t: 'number' },
            'pointText': { t: 'boolean' },
            'smallCaps': { t: 'boolean' },
            'spaceAfter': { t: 'number', w: 1 },
            'spaceBefore': { t: 'number', w: 1 },
            'startIndent': { t: 'number', w: 1 },
            'strokeOverFill': { t: 'boolean', w: 1 },
            'subscript': { t: 'boolean' },
            'superscript': { t: 'boolean' },
            'tsume': { t: 'number', w: 1 },
            'verticalScale': { t: 'number', w: 1 },
            // 方法（AE 24.3+ Text Range API）：range 族返回同名 Range 类型；
            // indexesAt 族返回 {start,end} 文本索引对。
            'characterRange': { t: 'CharacterRange', m: 'm' },
            'composedLineCharacterIndexesAt': { t: 'user-object{start:number,end:number}', m: 'm' },
            'composedLineRange': { t: 'ComposedLineRange', m: 'm' },
            'paragraphCharacterIndexesAt': { t: 'user-object{start:number,end:number}', m: 'm' },
            'paragraphRange': { t: 'ParagraphRange', m: 'm' },
            'resetCharStyle': { t: 'u', m: 'm' },
            'resetParagraphStyle': { t: 'u', m: 'm' }
        },
        'FootageItem': {
            'name': { t: 'string', w: 1 },
            'mainSource': { t: 'FootageSource' },
            'duration': { t: 'number' },
            // 补表（官方 FootageItem/AVItem/Item 全量核对，扁平并入）：
            'file': { t: 'FileHandle' },
            'comment': { t: 'string', w: 1 },
            'frameDuration': { t: 'number' },                  // FootageItem 上只读
            'frameRate': { t: 'number' },                      // 只读
            'hasAudio': { t: 'boolean' },
            'hasVideo': { t: 'boolean' },
            'height': { t: 'number', w: 1 },                   // 仅 SolidSource 可写
            'width': { t: 'number', w: 1 },
            'pixelAspect': { t: 'number', w: 1 },
            'proxySource': { t: 'FootageSource' },
            'time': { t: 'number', w: 1 },
            'usedIn': { t: 'array<CompItem>' },
            'useProxy': { t: 'boolean', w: 1 },
            'footageMissing': { t: 'boolean' },
            'id': { t: 'number' },
            'label': { t: 'number', w: 1 },
            'parentFolder': { t: 'FolderItem', w: 1 },
            'selected': { t: 'boolean', w: 1 },
            'typeName': { t: 'string' },
            'openInViewer': { t: 'Viewer', m: 'm' },   // View/Viewer 建模
            'replaceWithPlaceholder': { t: 'u', m: 'm' },
            'replaceWithSolid': { t: 'u', m: 'm' },
            // 补录：FILE 面挂 file 域闸收录（换源族 + AVItem
            // setProxy 族扁平并入；域关=现行拒——replace 属 FORCE_DOMAIN_MEMBERS
            // 同族）：
            'replace': { t: 'u', m: 'm', d: 'file' },
            'replaceWithSequence': { t: 'u', m: 'm', d: 'file' },
            'setProxy': { t: 'u', m: 'm', d: 'file' },
            'setProxyToNone': { t: 'u', m: 'm', d: 'file' },
            'setProxyWithPlaceholder': { t: 'u', m: 'm', d: 'file' },
            'setProxyWithSequence': { t: 'u', m: 'm', d: 'file' },
            'setProxyWithSolid': { t: 'u', m: 'm', d: 'file' },
            // Item 基类面：remove（语义与无域理由见 CompItem 同条）
            'remove': { t: 'u', m: 'm' },
            // Item 基类参考线族（AE 16.1+）：条目形状与版本差异同 Layer.guides。
            'guides': { t: 'array<user-object{orientationType:number,positionType:number,position:number,color:array<number>,pinned:boolean}>' },
            'addGuide': { t: 'number', m: 'm' },
            'removeGuide': { t: 'u', m: 'm' },
            'setGuide': { t: 'u', m: 'm' },
            'getGuideAsObject': { t: 'GuideOptions', m: 'm' },   // AE 26.5+
            'dynamicLinkGUID': { t: 'string' },
            'isMediaReplacementCompatible': { t: 'boolean' }     // AVItem 面，AE 18.0+
        },
        'FootageSource': {
            'file': { t: 'FileHandle' },
            'name': { t: 'string' },
            // 补表：reload 重读磁盘素材（FILE 读——挂域，域关拒）：
            'reload': { t: 'u', m: 'm', d: 'file' },
            // ── 补表：素材解释面（白名单补常用表）──

            // 为什么算缺口：aeApiReference.txt「FootageSource」章 16 名逐条在册
            // （queryAeApi 会教给 LLM），而本类型只收 3 名（file/name/reload）、
            // 同族 FootageItem 收了 33 名 ⇒ **读面结构性缺口**：`footage.mainSource`
            // 是素材属性的唯一真源，帧率 conform / Alpha 解释 / 场分离全在这里；
            // 本仓宿主代码 aeTools.jsx 亦以 mainSource 为主路径（11 处）。
            // 安全：全部为工程内素材解释设置——不触磁盘、无系统/网络/菜单面。
            // 唯一的 IO 面仍是既有的 file（FileHandle 域闸）与 reload（d:'file'），不动。
            // 写面（w）按官方正文口径逐条判定：明文「设置此属性会报错」的形态
            //（isStill/非静帧约束）与「设为 0 即用 native」的形态都说明该属性可写；
            // 正文描述为**派生值**的 displayFrameRate 只收读面（见该条注释）。
            'isStill': { t: 'boolean' },
            'hasAlpha': { t: 'boolean' },
            'nativeFrameRate': { t: 'number' },
            // 正文：有效帧率 = conformFrameRate（非 0）或 nativeFrameRate ⇒ 派生值，
            // 写面口径需真机核对才敢开——只收读面（要改帧率请用 conformFrameRate）。
            // 宁可误拒不可静默失效（同 layer.position 的 w 判定）。
            'displayFrameRate': { t: 'number' },
            'alphaMode': { t: 'number', w: 1 },            // AlphaMode 枚举
            'invertAlpha': { t: 'boolean', w: 1 },
            'premulColor': { t: 'array<number>', w: 1 },   // [r, g, b]
            'conformFrameRate': { t: 'number', w: 1 },     // 0 = 用 nativeFrameRate
            'loop': { t: 'number', w: 1 },
            'fieldSeparationType': { t: 'number', w: 1 },  // FieldSeparationType 枚举
            'highQualityFieldSeparation': { t: 'boolean', w: 1 },
            'removePulldown': { t: 'number', w: 1 },       // PulldownPhase 枚举
            'guessAlphaMode': { t: 'u', m: 'm' },
            'guessPulldown': { t: 'u', m: 'm' },           // 实参 = PulldownMethod 枚举
            // FileSource 继承面（官方 FileSource 页）：本表已按同族扁平先例收了
            // file/reload；missingFootagePath 是离线素材**定位**的唯一来源——
            // 而布尔侧 AVItem.footageMissing 早已收录在 FootageItem ⇒ 同一处
            // 「同面不对称」，故一并补（只读字符串）。
            'missingFootagePath': { t: 'string' },
            // SolidSource 继承面（官方 SolidSource 是 FootageSource 子类，自有成员只此一个）
            'color': { t: 'array<number>', w: 1 }         // [R,G,B] 0.0..1.0
        },
        'FolderItem': {
            'item': { t: 'CompItem|FolderItem|FootageItem', m: 'm' },
            'numItems': { t: 'number' },
            // 同 Project.items：数值索引由 tables.COLLECTIONS 建模，成员面见 ItemCollection
            'items': { t: 'ItemCollection' },
            'name': { t: 'string', w: 1 },
            // 补表（官方 Item 继承面扁平并入）：
            'comment': { t: 'string', w: 1 },
            'id': { t: 'number' },
            'label': { t: 'number', w: 1 },
            'parentFolder': { t: 'FolderItem', w: 1 },
            'selected': { t: 'boolean', w: 1 },
            'typeName': { t: 'string' },
            // Item 基类面：remove（FolderItem 连内含项一并删除——见 CompItem 同条）
            'remove': { t: 'u', m: 'm' },
            // Item 基类参考线族（AE 16.1+）：条目形状与版本差异同 Layer.guides。
            'guides': { t: 'array<user-object{orientationType:number,positionType:number,position:number,color:array<number>,pinned:boolean}>' },
            'addGuide': { t: 'number', m: 'm' },
            'removeGuide': { t: 'u', m: 'm' },
            'setGuide': { t: 'u', m: 'm' },
            'getGuideAsObject': { t: 'GuideOptions', m: 'm' },   // AE 26.5+
            'dynamicLinkGUID': { t: 'string' }
        },
        // FileHandle： 只读句柄面（常开）+ file 域受控面（d:'file'——域开才
        // 生效，域关时条目被抑制即现行拒路径，app.project.file 真实例同面——
        // 能力域语义：file 域开启 = 文件读写能力授权，敏感路径防线在核包装构造器）
        'FileHandle': {
            'fsName': { t: 'string' },
            'exists': { t: 'boolean' },
            'displayName': { t: 'string' },
            // 补表：文件名段读取（`src.file.name` 判后缀等高频用法，
            // 外接会话实测被拒——LLM 只能改写 displayName/fsName 绕）。官方
            // ExtendScript File 对象属性：「The file name portion of the absolute
            // URI for the referenced file, without the path specification. String.
            // Read only.」https://extendscript.docsforadobe.dev/file-system-access/file-object/#filename
            // 与 fsName/displayName 同为只读句柄面：不挂 d:'file'——域语义是
            // 「文件读写能力授权」而非「知道路径」，敏感路径防线在核包装构造器。
            'name': { t: 'string' },
            // Step 2b 核验修正：官方成员名是 parent（非 folder），返回 Folder 对象
            // （Adobe ExtendScript File System Access：File.parent → Folder, read only）
            'parent': { t: 'FolderObj' },
            'open': { t: 'boolean', m: 'm', d: 'file' },
            'read': { t: 'string', m: 'm', d: 'file' },
            'write': { t: 'boolean', m: 'm', d: 'file' },
            'close': { t: 'boolean', m: 'm', d: 'file' },
            'seek': { t: 'boolean', m: 'm', d: 'file' },
            'tell': { t: 'number', m: 'm', d: 'file' },
            'remove': { t: 'boolean', m: 'm', d: 'file' },
            'rename': { t: 'boolean', m: 'm', d: 'file' },
            'copy': { t: 'boolean', m: 'm', d: 'file' },
            'length': { t: 'number', d: 'file' },
            // 补表：原 _verifySavedArtifact 的产物核查判据是
            // 「mtime 优先」（本次是否真重写），该 helper 随 saveProject 删除后，脚本侧
            // 只能按存在+大小判——FileHandle 缺 modified 使 mtime 判据**不可达**。
            // 官方类型为 Date（TYPES.Date 已在表内），只读。
            'modified': { t: 'Date' },
            // 补录：编码配置（UTF-8 写出等）——核侧不拦（核自
            // 身 readFile 工具即设 f.encoding），敏感路径防线在构造器不受影响
            'encoding': { t: 'string', w: 1, d: 'file' }
            // changePath/execute 刻意不收录=硬拒（对齐落定 1：核内照拦，
            // 门侧同样不因 file 域放行）
        },
        // FolderObj： file 域构造面（new Folder 构造器类型）+ 真实例只读面——
        // 写路径原语挂 d:'file'（域关即现行拒）；Step 2b 核验：create/remove/rename
        // → Boolean、getFiles → File/Folder 数组或 null、parent → Folder、
        // exists/fsName/displayName 只读
        'FolderObj': {
            'exists': { t: 'boolean' },
            'fsName': { t: 'string' },
            'displayName': { t: 'string' },
            'parent': { t: 'FolderObj' },
            'create': { t: 'boolean', m: 'm', d: 'file' },
            'remove': { t: 'boolean', m: 'm', d: 'file' },
            'rename': { t: 'boolean', m: 'm', d: 'file' },
            'getFiles': { t: 'array<u>', m: 'm', d: 'file' }
        },
        // SocketObj： socket 域构造面（new Socket 构造器类型，域关时 Socket
        // 标识符本身即拒——类型不可达）。Step 2b 核验：open/write → bool（write
        // 返回 Boolean 非 Number——修正预填）、read → String、connected/eof 只读
        // 布尔、encoding 字符串、timeout 数字（binary 非官方成员不收录——二进制
        // 模式经 encoding="BINARY"）；listen/poll/error/host 刻意不收录（fail-closed）
        'SocketObj': {
            'open': { t: 'boolean', m: 'm' },
            'close': { t: 'boolean', m: 'm' },
            'write': { t: 'boolean', m: 'm' },
            'read': { t: 'string', m: 'm' },
            'connected': { t: 'boolean' },
            'eof': { t: 'boolean' },
            'encoding': { t: 'string' },
            'timeout': { t: 'number' }
        },
        // ── 渲染队列族（官方 RenderQueue 章节全量核对）──
        // render()/queueInAME() 无条件收录（触发语义——渲染已配置的队列项；输出
        // 路径控制权在上游：用户 UI 配置或 OutputModule.file 赋值处，后者挂
        // file 域 + 核侧 _GateFile 构造期敏感路径检查双重把关。LLM 需渲染视频/
        // 音频预览连续画面——拦触发动作只挡工作流不增安全）。
        // 模板族四成员亦无条件收录——applyTemplate 按名
        // 应用已有模板（无路径参数、无写盘，纯工程内状态修改，与 skipFrames
        // 同级）；saveAsTemplate 写 AE 全局模板库（固定位置，路径不由脚本控制，
        // 内容仅为当前渲染设置——非任意路径写原语，风险极低）。
        // RenderQueueItem.onStatusChanged 刻意不收录（回调函数名执行面——对齐
        // app.onError 恒拒）；startTime 为 Date 类型未建模记 'u'。
        'RenderQueue': {
            'canQueueInAME': { t: 'boolean' },               // AE 14.0 只读
            'queueNotify': { t: 'boolean', w: 1 },           // AE 22.0 读写
            'items': { t: 'RQItemCollection' },
            'numItems': { t: 'number' },
            'rendering': { t: 'boolean' },
            'item': { t: 'RenderQueueItem', m: 'm' },
            'pauseRendering': { t: 'u', m: 'm' },
            'render': { t: 'u', m: 'm' },                    // 触发渲染（无域闸——见上方说明）
            'showWindow': { t: 'u', m: 'm' },
            'stopRendering': { t: 'u', m: 'm' },
            'queueInAME': { t: 'u', m: 'm' }                 // 触发 AME 编码（同上）
        },
        'RQItemCollection': {
            'add': { t: 'RenderQueueItem', m: 'm' },
            'length': { t: 'number' }   // Collection 基类属性
        },
        'RenderQueueItem': {
            'comp': { t: 'CompItem' },
            'elapsedSeconds': { t: 'number' },
            'logType': { t: 'number', w: 1 },
            'numOutputModules': { t: 'number' },
            'outputModules': { t: 'OMCollection' },
            'queueItemNotify': { t: 'boolean', w: 1 },
            'render': { t: 'boolean', w: 1 },
            'skipFrames': { t: 'number', w: 1 },
            'startTime': { t: 'Date' },                       // 未开始渲染时为 null
            'status': { t: 'number' },
            'templates': { t: 'array<string>' },
            'timeSpanDuration': { t: 'number', w: 1 },
            'timeSpanStart': { t: 'number', w: 1 },
            'applyTemplate': { t: 'u', m: 'm' },              // 按名应用渲染设置模板（无域闸——见上方说明）
            'duplicate': { t: 'RenderQueueItem', m: 'm' },
            'getSetting': { t: 'u', m: 'm' },                 // AE 13.0
            'getSettings': { t: 'u', m: 'm' },
            'outputModule': { t: 'OutputModule', m: 'm' },
            'remove': { t: 'u', m: 'm' },
            'saveAsTemplate': { t: 'u', m: 'm' },             // 存命名模板（AE 模板库固定位置，无域闸）
            'setSetting': { t: 'u', m: 'm' },
            'setSettings': { t: 'u', m: 'm' }
            // onStatusChanged 刻意不收录（回调执行面）
        },
        'OMCollection': {
            'length': { t: 'number' },   // Collection 基类属性
            'add': { t: 'OutputModule', m: 'm' }
        },
        'OutputModule': {
            'file': { t: 'FileHandle', w: 1, d: 'file' },     // 输出路径（File 对象赋值——敏感路径防线在核构造器）
            'includeSourceXMP': { t: 'boolean', w: 1 },
            'name': { t: 'string' },
            'postRenderAction': { t: 'number', w: 1 },        // PostRenderAction 枚举
            'templates': { t: 'array<string>' },
            'applyTemplate': { t: 'u', m: 'm' },              // 按名应用输出模块模板（无域闸）
            'getSetting': { t: 'u', m: 'm' },
            'getSettings': { t: 'u', m: 'm' },
            'remove': { t: 'u', m: 'm' },
            'saveAsTemplate': { t: 'u', m: 'm' },             // 存命名模板（AE 模板库固定位置，无域闸）
            'setSetting': { t: 'u', m: 'm' },
            'setSettings': { t: 'u', m: 'm' }
        },
        'JSON': {
            'parse': { t: 'u', m: 'm' },
            'stringify': { t: 'string', m: 'm' }
        },
        'String-obj': {}, // String 标识符作接收者：成员全拒（fromCharCode 口径）
        // 字体对象（AE 24.0 起）：全属性只读。字体代理失效后任一属性引用抛异常，
        // 取值前用全局 isValid(font) 判存活。
        'FontObject': {
            'postScriptName': { t: 'string' },
            'styleName': { t: 'string' },
            'familyName': { t: 'string' },
            'fullName': { t: 'string' },
            'location': { t: 'string' },
            'version': { t: 'string' },
            'nativeFamilyName': { t: 'string' },
            'nativeFullName': { t: 'string' },
            'nativeStyleName': { t: 'string' },
            'familyPrefix': { t: 'string' },
            'fontID': { t: 'number' },
            'technology': { t: 'number' },
            'type': { t: 'number' },
            'writingScripts': { t: 'array<number>' },
            'designVector': { t: 'array<number>' },
            // 非可变字体上为 undefined；键集见官方 designAxesData 示例。
            'designAxesData': { t: 'array<user-object{name:string,tag:string,min:number,max:number,default:number}>' },
            'hasDesignAxes': { t: 'boolean' },
            'isFromAdobeFonts': { t: 'boolean' },
            'isSubstitute': { t: 'boolean' },
            'otherFontsWithSameDict': { t: 'array<FontObject>' },
            'hasGlyphsFor': { t: 'boolean', m: 'm' },
            'hasSameDict': { t: 'boolean', m: 'm' },
            'postScriptNameForDesignVector': { t: 'string', m: 'm' }
        },
        // app.fonts（AE 24.0 起）：无 length、无数值下标，字体经 allFonts 家族组取。
        'FontsObject': {
            'allFonts': { t: 'array<array<FontObject>>' },
            'fontServerRevision': { t: 'number' },
            'fontsWithDefaultDesignAxes': { t: 'array<FontObject>' },
            'missingOrSubstitutedFonts': { t: 'array<FontObject>' },
            'fontsDuplicateByPostScriptName': { t: 'array<array<FontObject>>' },
            'favoriteFontFamilyList': { t: 'array<string>', w: 1 },
            'mruFontFamilyList': { t: 'array<string>', w: 1 },
            'freezeSyncSubstitutedFonts': { t: 'boolean', w: 1 },
            'substitutedFontReplacementMatchPolicy': { t: 'number', w: 1 },
            'getFontByID': { t: 'FontObject', m: 'm' },
            'getFontsByPostScriptName': { t: 'array<FontObject>', m: 'm' },
            'getFontsByFamilyNameAndStyleName': { t: 'array<FontObject>', m: 'm' },
            'getDefaultFontForCTScript': { t: 'FontObject', m: 'm' },
            'setDefaultFontForCTScript': { t: 'boolean', m: 'm' },
            'getCTScriptForString': { t: 'array<user-object{chars:number,ctScript:number}>', m: 'm' },
            'pollForAndPushNonSystemFontFoldersChanges': { t: 'boolean', m: 'm' }
        },
        // 文本区间访问器（AE 24.3+）：由 TextDocument.characterRange/paragraphRange/
        // composedLineRange 取出。区间创建后独立于源 TextDocument 的后续改动；
        // isRangeValid 为 false 时只有 toString 可安全调用。
        // 此处只列自有成员；继承的 TextDocument 样式面在 TYPES 字面量之后派生补齐。
        // 跨多个字符时属性值可能不一致，此时返回 undefined。
        'CharacterRange': {
            'characterStart': { t: 'number' },
            'characterEnd': { t: 'number' },
            'isRangeValid': { t: 'boolean' },
            'text': { t: 'string', w: 1 },
            'fillColor': { t: 'array<number>', w: 1 },
            'strokeColor': { t: 'array<number>', w: 1 },
            'strokeOverFill': { t: 'boolean', w: 1 },
            'kerning': { t: 'number', w: 1 },
            'pasteFrom': { t: 'u', m: 'm' },          // AE 25.1+；粘贴语义覆盖目标区间文本
            'toString': { t: 'string', m: 'm' }
        },
        'ParagraphRange': {
            'characterStart': { t: 'number' },
            'characterEnd': { t: 'number' },
            'isRangeValid': { t: 'boolean' },
            'characterRange': { t: 'CharacterRange', m: 'm' },
            'toString': { t: 'string', m: 'm' }
        },
        'ComposedLineRange': {
            'characterStart': { t: 'number' },
            'characterEnd': { t: 'number' },
            'isRangeValid': { t: 'boolean' },
            'characterRange': { t: 'CharacterRange', m: 'm' },
            'toString': { t: 'string', m: 'm' }
        },
        // ── 补表：官方 other/ 章节纯数据对象三件 + 效果查询元素 ──
        'KeyframeEase': { // new KeyframeEase(speed, influence)——缓急曲线（遮罩/动效高频）
            'speed': { t: 'number', w: 1 },
            'influence': { t: 'number', w: 1 }
        },
        'Shape': { // new Shape()——遮罩/形状路径数据（全部 rw，官方 other/shape 核对）
            'vertices': { t: 'array<array<number>>', w: 1 },
            'inTangents': { t: 'array<array<number>>', w: 1 },
            'outTangents': { t: 'array<array<number>>', w: 1 },
            'closed': { t: 'boolean', w: 1 },
            'featherSegLocs': { t: 'array<number>', w: 1 },
            'featherRelSegLocs': { t: 'array<number>', w: 1 },
            'featherRadii': { t: 'array<number>', w: 1 },
            'featherInterps': { t: 'array<number>', w: 1 },
            'featherTypes': { t: 'array<number>', w: 1 },
            'featherRelCornerAngles': { t: 'array<number>', w: 1 },
            'featherTensions': { t: 'array<number>', w: 1 }
        },
        'MarkerValue': { // new MarkerValue(comment)——层/合成标记（全部 rw）
            'comment': { t: 'string', w: 1 },
            'duration': { t: 'number', w: 1 },
            'chapter': { t: 'string', w: 1 },
            'cuePointName': { t: 'string', w: 1 },
            'eventCuePoint': { t: 'boolean', w: 1 },
            'url': { t: 'string', w: 1 },
            'frameTarget': { t: 'string', w: 1 },
            'label': { t: 'number', w: 1 },
            'protectedRegion': { t: 'boolean', w: 1 },
            'getParameters': { t: 'user-object', m: 'm' },
            'setParameters': { t: 'u', m: 'm' }
        },
        'GuideOptions': { // new GuideOptions()——参考线配置（AE 26.5+，全部 rw）
            'orientation': { t: 'number', w: 1 },        // GuideOrientationType 枚举
            'position': { t: 'number', w: 1 },
            'positionType': { t: 'number', w: 1 },       // GuidePositionType 枚举
            'color': { t: 'array<number>', w: 1 },       // [R,G,B] 0.0..1.0
            'pinned': { t: 'boolean', w: 1 }
        },
        'EffectRef': { // app.effects 数组元素（效果查询——遍历 matchName 用）
            'displayName': { t: 'string' },
            'category': { t: 'string' },
            'matchName': { t: 'string' },
            'version': { t: 'string' }
        },
        // ── 补表：View/Viewer 族（官方 other/viewer|view|viewoptions
        // 三页核对）。「打开合成视图/setActive」场景：comp.openInViewer().setActive()/
        // app.activeViewer.setActive()/maximized 等。ViewerType 枚举值为纯数字
        // 7612/7613/7614（Types-for-Adobe 运行时实证——与 KeyframeInterpolationType
        // 7611 同族，故 type/枚举成员按 number 收录）。ViewOptions.channels/fastPreview
        // 的 ChannelType/FastPreviewType 枚举成员面见同名 TYPES 条目──
        'Viewer': { // app.activeViewer / CompItem|AVLayer|FootageItem.openInViewer()
            'active': { t: 'boolean' },
            'activeViewIndex': { t: 'number', w: 1 },
            'maximized': { t: 'boolean', w: 1 },
            'views': { t: 'array<View>' },
            'type': { t: 'number' },                     // ViewerType 枚举（RO）
            'setActive': { t: 'boolean', m: 'm' }
        },
        'View': { // viewer.views[i]
            'active': { t: 'boolean' },
            'options': { t: 'ViewOptions' },
            'setActive': { t: 'boolean', m: 'm' }
        },
        'ViewOptions': { // view.options（官方全 rw；fastPreview AE 12.0+、guides/rulers 族 16.1+）
            'channels': { t: 'number', w: 1 },           // ChannelType 枚举
            'checkerboards': { t: 'boolean', w: 1 },
            'exposure': { t: 'number', w: 1 },           // [-40..40]
            'fastPreview': { t: 'number', w: 1 },        // FastPreviewType 枚举（Layer/Footage 面板读写报错）
            'guidesLocked': { t: 'boolean', w: 1 },
            'guidesSnap': { t: 'boolean', w: 1 },
            'guidesVisibility': { t: 'boolean', w: 1 },
            'rulers': { t: 'boolean', w: 1 },
            'zoom': { t: 'number', w: 1 }                // 0.01..16
        },
        'ViewerType': {
            'VIEWER_COMPOSITION': { t: 'number' },
            'VIEWER_LAYER': { t: 'number' },
            'VIEWER_FOOTAGE': { t: 'number' }
        },
        'ChannelType': {
            'CHANNEL_ALPHA': { t: 'number' }, 'CHANNEL_ALPHA_BOUNDARY': { t: 'number' },
            'CHANNEL_ALPHA_OVERLAY': { t: 'number' }, 'CHANNEL_BLUE': { t: 'number' },
            'CHANNEL_BLUE_COLORIZE': { t: 'number' }, 'CHANNEL_GREEN': { t: 'number' },
            'CHANNEL_GREEN_COLORIZE': { t: 'number' }, 'CHANNEL_RED': { t: 'number' },
            'CHANNEL_RED_COLORIZE': { t: 'number' }, 'CHANNEL_RGB': { t: 'number' },
            'CHANNEL_RGB_STRAIGHT': { t: 'number' }
        },
        'ESException': { // catch 参数类型（实证 6 文件 e.toString() 形态；只读面）
            'toString': { t: 'string', m: 'm' },
            'message': { t: 'string' },
            'name': { t: 'string' },
            'description': { t: 'string' },
            'lineNumber': { t: 'number' },
            'fileName': { t: 'string' },
            // line：ExtendScript 异常对象标准成员（官方文档 Errors 一节；实测
            // 实测外部 Agent catch 链被拒——实证收集时只采了 toString 形态漏了它）
            'line': { t: 'number' }
        },
        'RegExp': {
            'test': { t: 'boolean', m: 'm' },
            'exec': { t: 'array<u>', m: 'm' },
            'source': { t: 'string' },
            'global': { t: 'boolean' },
            'ignoreCase': { t: 'boolean' },
            'multiline': { t: 'boolean' }
        },
        // 补表：Date（new Date() 实例面 + Date.now/parse/UTC 静态面共用，
        // any-member 语义）。AE 23.5 实测：ES5 的 Date.now 存在且可用（收录）；
        // toISOString 缺席（实测唯一缺席的常用成员——刻意不收录，运行时必炸）
        'Date': {
            // 静态面（构造器对象直访）：
            'now': { t: 'number', m: 'm' },                        // AE 23.5 实测存在
            'parse': { t: 'number', m: 'm' },
            'UTC': { t: 'number', m: 'm' },
            // getter 族：
            'getTime': { t: 'number', m: 'm' },
            'getTimezoneOffset': { t: 'number', m: 'm' },
            'getFullYear': { t: 'number', m: 'm' }, 'getUTCFullYear': { t: 'number', m: 'm' },
            'getMonth': { t: 'number', m: 'm' }, 'getUTCMonth': { t: 'number', m: 'm' },
            'getDate': { t: 'number', m: 'm' }, 'getUTCDate': { t: 'number', m: 'm' },
            'getDay': { t: 'number', m: 'm' }, 'getUTCDay': { t: 'number', m: 'm' },
            'getHours': { t: 'number', m: 'm' }, 'getUTCHours': { t: 'number', m: 'm' },
            'getMinutes': { t: 'number', m: 'm' }, 'getUTCMinutes': { t: 'number', m: 'm' },
            'getSeconds': { t: 'number', m: 'm' }, 'getUTCSeconds': { t: 'number', m: 'm' },
            'getMilliseconds': { t: 'number', m: 'm' }, 'getUTCMilliseconds': { t: 'number', m: 'm' },
            'getYear': { t: 'number', m: 'm' },                  // ES3 legacy
            // setter 族（返回内部毫秒值）：
            'setTime': { t: 'number', m: 'm' },
            'setFullYear': { t: 'number', m: 'm' }, 'setUTCFullYear': { t: 'number', m: 'm' },
            'setMonth': { t: 'number', m: 'm' }, 'setUTCMonth': { t: 'number', m: 'm' },
            'setDate': { t: 'number', m: 'm' }, 'setUTCDate': { t: 'number', m: 'm' },
            'setHours': { t: 'number', m: 'm' }, 'setUTCHours': { t: 'number', m: 'm' },
            'setMinutes': { t: 'number', m: 'm' }, 'setUTCMinutes': { t: 'number', m: 'm' },
            'setSeconds': { t: 'number', m: 'm' }, 'setUTCSeconds': { t: 'number', m: 'm' },
            'setMilliseconds': { t: 'number', m: 'm' }, 'setUTCMilliseconds': { t: 'number', m: 'm' },
            'setYear': { t: 'number', m: 'm' },                  // ES3 legacy
            // 转换族：
            'toString': { t: 'string', m: 'm' },
            'toDateString': { t: 'string', m: 'm' },
            'toTimeString': { t: 'string', m: 'm' },
            'toLocaleString': { t: 'string', m: 'm' },
            'toLocaleDateString': { t: 'string', m: 'm' },
            'toLocaleTimeString': { t: 'string', m: 'm' },
            'toUTCString': { t: 'string', m: 'm' },
            'toGMTString': { t: 'string', m: 'm' },              // ES3 legacy
            'valueOf': { t: 'number', m: 'm' }
        },
        // 补表：Object/Array 构造器对象面（IDENTIFIERS 挂 builtin-object，
        // 仅静态方法收录受控）。刻意不收录：Object.prototype/getPrototypeOf/
        // setPrototypeOf/defineProperty/assign 等（原型篡改/反射面——对齐
        // META_PROPERTIES「prototype 是原型篡改面」；keys 纯枚举无风险）
        'Object': {
            'keys': { t: 'array<string>', m: 'm' }
        },
        'Array': {
            'isArray': { t: 'boolean', m: 'm' }
        },
        'Math': (function () {
            var m = {};
            var consts = { 'E': 1, 'LN2': 1, 'LN10': 1, 'LOG2E': 1, 'LOG10E': 1, 'PI': 1, 'SQRT1_2': 1, 'SQRT2': 1 };
            for (var k in tables.MATH_MEMBERS) {
                if (!Object.prototype.hasOwnProperty.call(tables.MATH_MEMBERS, k)) continue;
                m[k] = Object.prototype.hasOwnProperty.call(consts, k)
                    ? { t: 'number' } : { t: 'number', m: 'm' };
            }
            return m;
        })(),
        // 关键帧插值枚举（IDENTIFIERS 挂 builtin-object，成员
        // 面在此）。LINEAR/BEZIER/HOLD 纯数字零副作用（7611/7613/7615——官方
        // 属性 attributes#keyframe-interpolation-type 一节；setInterpolationTypeAtKey/
        // isInterpolationTypeAtKey 用）
        'KeyframeInterpolationType': {
            'LINEAR': { t: 'number' },
            'BEZIER': { t: 'number' },
            'HOLD': { t: 'number' }
        },
        // 遮罩三枚举成员面（IDENTIFIERS 挂 builtin-object，
        // 官方 maskpropertygroup.md 逐条枚举——值同为纯数字常量）
        'MaskMode': {
            'NONE': { t: 'number' },
            'ADD': { t: 'number' },
            'SUBTRACT': { t: 'number' },
            'INTERSECT': { t: 'number' },
            'LIGHTEN': { t: 'number' },
            'DARKEN': { t: 'number' },
            'DIFFERENCE': { t: 'number' }
        },
        'MaskFeatherFalloff': {
            'FFO_LINEAR': { t: 'number' },
            'FFO_SMOOTH': { t: 'number' }
        },
        'MaskMotionBlur': {
            'SAME_AS_LAYER': { t: 'number' },
            'ON': { t: 'number' },
            'OFF': { t: 'number' }
        },
        // 素材解释枚举成员面：纯数字常量、只读，数值由 AE 提供。
        'AlphaMode': {
            'IGNORE': { t: 'number' },
            'PREMULTIPLIED': { t: 'number' },
            'STRAIGHT': { t: 'number' }
        },
        'FieldSeparationType': {
            'OFF': { t: 'number' },
            'UPPER_FIELD_FIRST': { t: 'number' },
            'LOWER_FIELD_FIRST': { t: 'number' }
        },
        // 官方类型段写 PulldownPhase.RemovePulldown.<名>、描述段写 PulldownPhase.<名>，
        // 嵌套层级两处不一致；只收描述段与既有脚本一致的平铺 OFF，其余成员未收录。
        'PulldownPhase': {
            'OFF': { t: 'number' }
        },
        'PulldownMethod': {
            'PULLDOWN_3_2': { t: 'number' },
            'ADVANCE_24P': { t: 'number' }
        },
        'BlendingMode': {
            // 官方拼写不对称：ALPHA 变体是 SILHOUETE（单 T，官方附拼写警告），
            // LUMA 变体是 SILHOUETTE（双 T）。无 LUMINESCENT，只有 LUMINESCENT_PREMUL。
            'NORMAL': { t: 'number' }, 'DISSOLVE': { t: 'number' },
            'DANCING_DISSOLVE': { t: 'number' }, 'MULTIPLY': { t: 'number' },
            'SCREEN': { t: 'number' }, 'OVERLAY': { t: 'number' },
            'DARKEN': { t: 'number' }, 'LIGHTEN': { t: 'number' },
            'COLOR_DODGE': { t: 'number' }, 'COLOR_BURN': { t: 'number' },
            'CLASSIC_COLOR_DODGE': { t: 'number' }, 'CLASSIC_COLOR_BURN': { t: 'number' },
            'LINEAR_DODGE': { t: 'number' }, 'LINEAR_BURN': { t: 'number' },
            'ADD': { t: 'number' }, 'ALPHA_ADD': { t: 'number' },
            'SUBTRACT': { t: 'number' }, 'DIVIDE': { t: 'number' },
            'HARD_LIGHT': { t: 'number' }, 'SOFT_LIGHT': { t: 'number' },
            'VIVID_LIGHT': { t: 'number' }, 'LINEAR_LIGHT': { t: 'number' },
            'PIN_LIGHT': { t: 'number' }, 'HARD_MIX': { t: 'number' },
            'DIFFERENCE': { t: 'number' }, 'CLASSIC_DIFFERENCE': { t: 'number' },
            'EXCLUSION': { t: 'number' }, 'HUE': { t: 'number' },
            'SATURATION': { t: 'number' }, 'COLOR': { t: 'number' },
            'LUMINOSITY': { t: 'number' }, 'DARKER_COLOR': { t: 'number' },
            'LIGHTER_COLOR': { t: 'number' }, 'STENCIL_ALPHA': { t: 'number' },
            'STENCIL_LUMA': { t: 'number' }, 'SILHOUETE_ALPHA': { t: 'number' },
            'SILHOUETTE_LUMA': { t: 'number' }, 'LUMINESCENT_PREMUL': { t: 'number' }
        },
        'TrackMatteType': {
            // 参考 :779（NO_TRACK_MATTE）+ 旧 setTrackMatte 的 typeMap 四值
            'NO_TRACK_MATTE': { t: 'number' }, 'ALPHA': { t: 'number' },
            'ALPHA_INVERTED': { t: 'number' }, 'LUMA': { t: 'number' },
            'LUMA_INVERTED': { t: 'number' }
        },
        'AutoOrientType': {
            // 旧 _autoOrientName 的 names 数组（4 值）
            'NO_AUTO_ORIENT': { t: 'number' }, 'ALONG_PATH': { t: 'number' },
            'CAMERA_OR_POINT_OF_INTEREST': { t: 'number' },
            'CHARACTERS_TOWARD_CAMERA': { t: 'number' }
        },
        'LightType': {
            // 参考 :854（PARALLEL/SPOT/POINT/AMBIENT/ENVIRONMENT）+ 旧 setLightProperties 的 typeMap
            'PARALLEL': { t: 'number' }, 'SPOT': { t: 'number' }, 'POINT': { t: 'number' },
            'AMBIENT': { t: 'number' }, 'ENVIRONMENT': { t: 'number' }
        },
        'ParagraphJustification': {
            // 无 FULL_JUSTIFY；两端对齐末行四态是 FULL_JUSTIFY_LASTLINE_*。
            'LEFT_JUSTIFY': { t: 'number' }, 'CENTER_JUSTIFY': { t: 'number' },
            'RIGHT_JUSTIFY': { t: 'number' },
            'FULL_JUSTIFY_LASTLINE_LEFT': { t: 'number' },
            'FULL_JUSTIFY_LASTLINE_RIGHT': { t: 'number' },
            'FULL_JUSTIFY_LASTLINE_CENTER': { t: 'number' },
            'FULL_JUSTIFY_LASTLINE_FULL': { t: 'number' },
            'MULTIPLE_JUSTIFICATIONS': { t: 'number' }
        },
        'PurgeTarget': {
            // 参考 :110 五值
            'ALL_CACHES': { t: 'number' }, 'ALL_MEMORY_CACHES': { t: 'number' },
            'UNDO_CACHES': { t: 'number' }, 'SNAPSHOT_CACHES': { t: 'number' },
            'IMAGE_CACHES': { t: 'number' }
        },
        'PropertyValueType': {
            // 官方大小写混排：维度名 OneD/TwoD/ThreeD，空间变体 TwoD_SPATIAL/ThreeD_SPATIAL。
            'NO_VALUE': { t: 'number' }, 'ThreeD_SPATIAL': { t: 'number' },
            'ThreeD': { t: 'number' }, 'TwoD_SPATIAL': { t: 'number' },
            'TwoD': { t: 'number' }, 'OneD': { t: 'number' },
            'COLOR': { t: 'number' }, 'SHAPE': { t: 'number' },
            'CUSTOM_VALUE': { t: 'number' }, 'MARKER': { t: 'number' },
            'LAYER_INDEX': { t: 'number' }, 'MASK_INDEX': { t: 'number' },
            'TEXT_DOCUMENT': { t: 'number' }
        },
        // 成员只收官方三值（docsforadobe「PropertyBase」
        // propertyType 条），不凭记忆补 PROPERTY_GROUP（官方无此成员）。纯数字常量只读。
        'PropertyType': {
            'PROPERTY': { t: 'number' },
            'INDEXED_GROUP': { t: 'number' },
            'NAMED_GROUP': { t: 'number' }
        },
        // 以下枚举成员均为纯数字常量、只读、零副作用。
        'LayerQuality': {
            'BEST': { t: 'number' }, 'DRAFT': { t: 'number' }, 'WIREFRAME': { t: 'number' }
        },
        'LayerSamplingQuality': {
            'BICUBIC': { t: 'number' }, 'BILINEAR': { t: 'number' }
        },
        'FrameBlendingType': {
            'FRAME_MIX': { t: 'number' }, 'NO_FRAME_BLEND': { t: 'number' }, 'PIXEL_MOTION': { t: 'number' }
        },
        'SceneEditDetectionMode': {
            'MARKERS': { t: 'number' }, 'SPLIT': { t: 'number' }, 'SPLIT_PRECOMP': { t: 'number' },
            'NONE': { t: 'number' }
        },
        'PostRenderAction': {
            'NONE': { t: 'number' }, 'IMPORT': { t: 'number' }, 'IMPORT_AND_REPLACE_USAGE': { t: 'number' },
            'SET_PROXY': { t: 'number' }
        },
        'LogType': {
            'ERRORS_ONLY': { t: 'number' }, 'ERRORS_AND_SETTINGS': { t: 'number' }, 'ERRORS_AND_PER_FRAME_INFO': { t: 'number' }
        },
        'RQItemStatus': {
            'QUEUED': { t: 'number' }, 'UNQUEUED': { t: 'number' }, 'WILL_CONTINUE': { t: 'number' },
            'NEEDS_OUTPUT': { t: 'number' }, 'RENDERING': { t: 'number' }, 'USER_STOPPED': { t: 'number' },
            'ERR_STOPPED': { t: 'number' }, 'DONE': { t: 'number' }
        },
        'GetSettingsFormat': {
            'SPEC': { t: 'number' }, 'NUMBER_SETTABLE': { t: 'number' }, 'STRING_SETTABLE': { t: 'number' },
            'NUMBER': { t: 'number' }, 'STRING': { t: 'number' }
        },
        'CloseOptions': {
            'DO_NOT_SAVE_CHANGES': { t: 'number' }, 'PROMPT_TO_SAVE_CHANGES': { t: 'number' }, 'SAVE_CHANGES': { t: 'number' }
        },
        'ResolveType': {
            'ACCEPT_THEIRS': { t: 'number' }, 'ACCEPT_YOURS': { t: 'number' }, 'ACCEPT_THEIRS_AND_COPY': { t: 'number' }
        },
        'ImportAsType': {
            'COMP_CROPPED_LAYERS': { t: 'number' }, 'FOOTAGE': { t: 'number' }, 'COMP': { t: 'number' },
            'PROJECT': { t: 'number' }
        },
        'TimeDisplayType': {
            'FRAMES': { t: 'number' }, 'TIMECODE': { t: 'number' }
        },
        'FramesCountType': {
            'FC_START_0': { t: 'number' }, 'FC_START_1': { t: 'number' }, 'FC_TIMECODE_CONVERSION': { t: 'number' }
        },
        'FeetFramesFilmType': {
            'MM16': { t: 'number' }, 'MM35': { t: 'number' }
        },
        'FootageTimecodeDisplayStartType': {
            'FTCS_START_0': { t: 'number' }, 'FTCS_USE_SOURCE_MEDIA': { t: 'number' }
        },
        'FastPreviewType': {
            'FP_OFF': { t: 'number' }, 'FP_ADAPTIVE_RESOLUTION': { t: 'number' }, 'FP_DRAFT': { t: 'number' },
            'FP_FAST_DRAFT': { t: 'number' }, 'FP_WIREFRAME': { t: 'number' }
        },
        'PREFType': {
            'PREF_Type_MACHINE_SPECIFIC': { t: 'number' }, 'PREF_Type_MACHINE_INDEPENDENT': { t: 'number' }
        },
        'ToolType': {
            'Tool_Arrow': { t: 'number' }, 'Tool_Rotate': { t: 'number' }, 'Tool_CameraMaya': { t: 'number' },
            'Tool_CameraOrbit': { t: 'number' }, 'Tool_CameraTrackXY': { t: 'number' }, 'Tool_CameraTrackZ': { t: 'number' },
            'Tool_Paintbrush': { t: 'number' }, 'Tool_CloneStamp': { t: 'number' }, 'Tool_Eraser': { t: 'number' },
            'Tool_Hand': { t: 'number' }, 'Tool_Magnify': { t: 'number' }, 'Tool_PanBehind': { t: 'number' },
            'Tool_Rect': { t: 'number' }, 'Tool_RoundedRect': { t: 'number' }, 'Tool_Oval': { t: 'number' },
            'Tool_Polygon': { t: 'number' }, 'Tool_Star': { t: 'number' }, 'Tool_TextH': { t: 'number' },
            'Tool_TextV': { t: 'number' }, 'Tool_Pen': { t: 'number' }, 'Tool_Feather': { t: 'number' },
            'Tool_PenPlus': { t: 'number' }, 'Tool_PenMinus': { t: 'number' }, 'Tool_PenConvert': { t: 'number' },
            'Tool_Pin': { t: 'number' }, 'Tool_PinStarch': { t: 'number' }, 'Tool_PinDepth': { t: 'number' },
            'Tool_Quickselect': { t: 'number' }, 'Tool_Hairbrush': { t: 'number' }
        },
        'GpuAccelType': {
            'CUDA': { t: 'number' }, 'OPENCL': { t: 'number' }, 'SOFTWARE': { t: 'number' }
        },
        'AutoKernType': {
            'NO_AUTO_KERN': { t: 'number' }, 'METRIC_KERN': { t: 'number' }, 'OPTICAL_KERN': { t: 'number' }
        },
        'BaselineDirection': {
            'BASELINE_WITH_STREAM': { t: 'number' }, 'BASELINE_VERTICAL_ROTATED': { t: 'number' }, 'BASELINE_VERTICAL_CROSS_STREAM': { t: 'number' }
        },
        'BoxAutoFitPolicy': {
            'NONE': { t: 'number' }, 'HEIGHT_CURSOR': { t: 'number' }, 'HEIGHT_PRECISE_BOUNDS': { t: 'number' },
            'HEIGHT_BASELINE': { t: 'number' }
        },
        'BoxFirstBaselineAlignment': {
            'ASCENT': { t: 'number' }, 'CAP_HEIGHT': { t: 'number' }, 'EM_BOX': { t: 'number' },
            'LEADING': { t: 'number' }, 'LEGACY_METRIC': { t: 'number' }, 'MINIMUM_VALUE_ASIAN': { t: 'number' },
            'MINIMUM_VALUE_ROMAN': { t: 'number' }, 'TYPO_ASCENT': { t: 'number' }, 'X_HEIGHT': { t: 'number' }
        },
        'BoxVerticalAlignment': {
            'TOP': { t: 'number' }, 'CENTER': { t: 'number' }, 'BOTTOM': { t: 'number' },
            'JUSTIFY': { t: 'number' }
        },
        'ComposerEngine': {
            'UNIVERSAL_TYPE_ENGINE': { t: 'number' }, 'LATIN_CJK_ENGINE': { t: 'number' }
        },
        'DigitSet': {
            'DEFAULT_DIGITS': { t: 'number' }, 'ARABIC_DIGITS': { t: 'number' }, 'HINDI_DIGITS': { t: 'number' },
            'FARSI_DIGITS': { t: 'number' }, 'ARABIC_DIGITS_RTL': { t: 'number' }
        },
        'FontBaselineOption': {
            'FONT_NORMAL_BASELINE': { t: 'number' }, 'FONT_FAUXED_SUPERSCRIPT': { t: 'number' }, 'FONT_FAUXED_SUBSCRIPT': { t: 'number' }
        },
        'FontCapsOption': {
            'FONT_NORMAL_CAPS': { t: 'number' }, 'FONT_SMALL_CAPS': { t: 'number' }, 'FONT_ALL_CAPS': { t: 'number' },
            'FONT_ALL_SMALL_CAPS': { t: 'number' }
        },
        'LeadingType': {
            'ROMAN_LEADING_TYPE': { t: 'number' }, 'JAPANESE_LEADING_TYPE': { t: 'number' }
        },
        'LineJoinType': {
            'LINE_JOIN_MITER': { t: 'number' }, 'LINE_JOIN_ROUND': { t: 'number' }, 'LINE_JOIN_BEVEL': { t: 'number' }
        },
        'LineOrientation': {
            'HORIZONTAL': { t: 'number' }, 'VERTICAL_RIGHT_TO_LEFT': { t: 'number' }, 'VERTICAL_LEFT_TO_RIGHT': { t: 'number' }
        },
        'ParagraphDirection': {
            'DIRECTION_LEFT_TO_RIGHT': { t: 'number' }, 'DIRECTION_RIGHT_TO_LEFT': { t: 'number' }
        },
        'CTFontTechnology': {
            'CT_TYPE1_FONT': { t: 'number' }, 'CT_TRUETYPE_FONT': { t: 'number' }, 'CT_CID_FONT': { t: 'number' },
            'CT_BITMAP_FONT': { t: 'number' }, 'CT_ATC_FONT': { t: 'number' }, 'CT_TYPE3_FONT': { t: 'number' },
            'CT_SVG_FONT': { t: 'number' }, 'CT_ANYTECHNOLOGY': { t: 'number' }
        },
        'CTFontType': {
            'CT_TYPE1_FONTTYPE': { t: 'number' }, 'CT_TRUETYPE_FONTTYPE': { t: 'number' }, 'CT_CID_FONTTYPE': { t: 'number' },
            'CT_ATC_FONTTYPE': { t: 'number' }, 'CT_BITMAP_FONTTYPE': { t: 'number' }, 'CT_OPENTYPE_CFF_FONTTYPE': { t: 'number' },
            'CT_OPENTYPE_CID_FONTTYPE': { t: 'number' }, 'CT_OPENTYPE_TT_FONTTYPE': { t: 'number' }, 'CT_TYPE3_FONTTYPE': { t: 'number' },
            'CT_SVG_FONTTYPE': { t: 'number' }
        },
        'CTScript': {
            'CT_ROMAN_SCRIPT': { t: 'number' }, 'CT_JAPANESE_SCRIPT': { t: 'number' }, 'CT_TRADITIONALCHINESE_SCRIPT': { t: 'number' },
            'CT_KOREAN_SCRIPT': { t: 'number' }, 'CT_ARABIC_SCRIPT': { t: 'number' }, 'CT_HEBREW_SCRIPT': { t: 'number' },
            'CT_GREEK_SCRIPT': { t: 'number' }, 'CT_CYRILLIC_SCRIPT': { t: 'number' }, 'CT_RIGHTLEFT_SCRIPT': { t: 'number' },
            'CT_DEVANAGARI_SCRIPT': { t: 'number' }, 'CT_GURMUKHI_SCRIPT': { t: 'number' }, 'CT_GUJARATI_SCRIPT': { t: 'number' },
            'CT_ORIYA_SCRIPT': { t: 'number' }, 'CT_BENGALI_SCRIPT': { t: 'number' }, 'CT_TAMIL_SCRIPT': { t: 'number' },
            'CT_TELUGU_SCRIPT': { t: 'number' }, 'CT_KANNADA_SCRIPT': { t: 'number' }, 'CT_MALAYALAM_SCRIPT': { t: 'number' },
            'CT_SINHALESE_SCRIPT': { t: 'number' }, 'CT_BURMESE_SCRIPT': { t: 'number' }, 'CT_KHMER_SCRIPT': { t: 'number' },
            'CT_THAI_SCRIPT': { t: 'number' }, 'CT_LAOTIAN_SCRIPT': { t: 'number' }, 'CT_GEORGIAN_SCRIPT': { t: 'number' },
            'CT_ARMENIAN_SCRIPT': { t: 'number' }, 'CT_SIMPLIFIEDCHINESE_SCRIPT': { t: 'number' }, 'CT_TIBETAN_SCRIPT': { t: 'number' },
            'CT_MONGOLIAN_SCRIPT': { t: 'number' }, 'CT_GEEZ_SCRIPT': { t: 'number' }, 'CT_EASTEUROPEANROMAN_SCRIPT': { t: 'number' },
            'CT_VIETNAMESE_SCRIPT': { t: 'number' }, 'CT_EXTENDEDARABIC_SCRIPT': { t: 'number' }, 'CT_KLINGON_SCRIPT': { t: 'number' },
            'CT_EMOJI_SCRIPT': { t: 'number' }, 'CT_ROHINGYA_SCRIPT': { t: 'number' }, 'CT_JAVANESE_SCRIPT': { t: 'number' },
            'CT_SUNDANESE_SCRIPT': { t: 'number' }, 'CT_LONTARA_SCRIPT': { t: 'number' }, 'CT_SYRIAC_SCRIPT': { t: 'number' },
            'CT_TAITHAM_SCRIPT': { t: 'number' }, 'CT_BUGINESE_SCRIPT': { t: 'number' }, 'CT_BALINESE_SCRIPT': { t: 'number' },
            'CT_CHEROKEE_SCRIPT': { t: 'number' }, 'CT_MANDAIC_SCRIPT': { t: 'number' }, 'CT_VAI_SCRIPT': { t: 'number' },
            'CT_THAANA_SCRIPT': { t: 'number' }, 'CT_BRAVANESE_SCRIPT': { t: 'number' }, 'CT_BRAHMI_SCRIPT': { t: 'number' },
            'CT_CARIAN_SCRIPT': { t: 'number' }, 'CT_CYPRIOT_SCRIPT': { t: 'number' }, 'CT_EGYPTIAN_SCRIPT': { t: 'number' },
            'CT_IMPERIALARAMAIC_SCRIPT': { t: 'number' }, 'CT_PAHLAVI_SCRIPT': { t: 'number' }, 'CT_PARTHIAN_SCRIPT': { t: 'number' },
            'CT_KHAROSHTHI_SCRIPT': { t: 'number' }, 'CT_LYCIAN_SCRIPT': { t: 'number' }, 'CT_LYDIAN_SCRIPT': { t: 'number' },
            'CT_PHOENICIAN_SCRIPT': { t: 'number' }, 'CT_PERSIAN_SCRIPT': { t: 'number' }, 'CT_SHAVIAN_SCRIPT': { t: 'number' },
            'CT_SUMAKKCUNEIFORM_SCRIPT': { t: 'number' }, 'CT_UGARITIC_SCRIPT': { t: 'number' }, 'CT_GLAGOLITIC_SCRIPT': { t: 'number' },
            'CT_GOTHIC_SCRIPT': { t: 'number' }, 'CT_OGHAM_SCRIPT': { t: 'number' }, 'CT_OLDITALIC_SCRIPT': { t: 'number' },
            'CT_ORKHON_SCRIPT': { t: 'number' }, 'CT_RUNIC_SCRIPT': { t: 'number' }, 'CT_MEROITICCURSIVE_SCRIPT': { t: 'number' },
            'CT_COPTIC_SCRIPT': { t: 'number' }, 'CT_OLCHIKI_SCRIPT': { t: 'number' }, 'CT_SORASOMPENG_SCRIPT': { t: 'number' },
            'CT_OLDHANGUL_SCRIPT': { t: 'number' }, 'CT_LISU_SCRIPT': { t: 'number' }, 'CT_NKO_SCRIPT': { t: 'number' },
            'CT_ADLAM_SCRIPT': { t: 'number' }, 'CT_BAMUM_SCRIPT': { t: 'number' }, 'CT_BASSAVAH_SCRIPT': { t: 'number' },
            'CT_NEWA_SCRIPT': { t: 'number' }, 'CT_NEWTAILU_SCRIPT': { t: 'number' }, 'CT_SCRIPT': { t: 'number' },
            'CT_OSAGE_SCRIPT': { t: 'number' }, 'CT_UCAS_SCRIPT': { t: 'number' }, 'CT_TIFINAGH_SCRIPT': { t: 'number' },
            'CT_KAYAHLI_SCRIPT': { t: 'number' }, 'CT_LAO_SCRIPT': { t: 'number' }, 'CT_TAILE_SCRIPT': { t: 'number' },
            'CT_TAIVIET_SCRIPT': { t: 'number' }, 'CT_DONTKNOW_SCRIPT': { t: 'number' }
        },
        'SubstitutedFontReplacementMatchPolicy': {
            'POSTSCRIPT_NAME': { t: 'number' }, 'CTFI_EQUAL': { t: 'number' }, 'DISABLED': { t: 'number' }
        },
        'GuideOrientationType': {
            'VERTICAL': { t: 'number' }, 'HORIZONTAL': { t: 'number' }
        },
        'GuidePositionType': {
            'PERCENTAGE': { t: 'number' }, 'PIXEL': { t: 'number' }
        },
        'ParametricMeshType': {
            'SPHERE': { t: 'number' }, 'PLANE': { t: 'number' }, 'CYLINDER': { t: 'number' },
            'CONE': { t: 'number' }, 'TORUS': { t: 'number' }, 'CUBE': { t: 'number' }
        },
        // 属性作用域枚举：经 property.LayerInputStageType 取，不是全局标识符。
        'LayerInputStageType': {
            'SOURCE': { t: 'number' }, 'ALL_EFFECTS': { t: 'number' }, 'ONLY_MASKS': { t: 'number' }
        },
        // ImportOptions 成员面。importAs 取值为 ImportAsType 枚举（数字）：
        // FOOTAGE=3813 / COMP=3814 / COMP_CROPPED_LAYERS=3812 / PROJECT=3815。
        // 脚本内分层导入亦可走宿主函数 importFile({filePath, importAs})，
        // 其内部构造 File 不受脚本 file 域限制。
        'ImportOptions': {
            'file': { t: 'FileHandle', w: 1 },
            'forceAlphabetical': { t: 'boolean', w: 1 },
            'importAs': { t: 'number', w: 1 },
            'rangeEnd': { t: 'number', w: 1 },
            'rangeStart': { t: 'number', w: 1 },
            'sequence': { t: 'boolean', w: 1 },
            'canImportAs': { t: 'boolean', m: 'm' },
            'isFileNameNumbered': { t: 'user-object', m: 'm' }
        },
        'GlobalThis': {}, // this 的成员走表②标识符白名单（Task 2 既有分支）
        'AEClass': {},   // instanceof 类对象：成员全拒（防原型探测）
        'function': {},  // 用户函数值：成员全拒（调用走 fnReturns 路径）
        // allowAEToolsSystemCall 能力域（4.2.1 最小实现——）：开关开启时经
        // policy.syscallAllowed 注入生效，`system` 标识符按此类型解析。
        // 扩权后代码依然过门：仅 callSystem 单成员，其余成员（其它逃逸面）仍拒
        'SystemObj': {
            'callSystem': { t: 'string', m: 'm' }
        }
    };

    // CharacterRange 继承 TextDocument 的成员面，官方排除项除外。派生而非手抄：
    // TextDocument 样式面增删时此处自动跟随。自有成员优先，不被继承面覆盖。
    (function () {
        var EXCLUDED = {
            'baselineLocs': 1, 'boxText': 1, 'boxTextPos': 1, 'boxTextSize': 1,
            'lineOrientation': 1, 'paragraphCount': 1, 'pointText': 1,
            'characterRange': 1, 'paragraphCharacterIndexesAt': 1, 'paragraphRange': 1
        };
        var src = tables.TYPES.TextDocument, dst = tables.TYPES.CharacterRange;
        for (var k in src) {
            if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
            if (Object.prototype.hasOwnProperty.call(EXCLUDED, k)) continue;
            if (Object.prototype.hasOwnProperty.call(dst, k)) continue;
            dst[k] = src[k];
        }
    })();

    // ── 种子快照 + 用户增补合并层（双层表管理——种子只读 ∪ 增补可增删回滚）──
    // 快照语义：值（成员条目对象）共享引用——条目一律只读不原地改写（applyUserAdditions
    // 只添加键，resetToSeed 只删增补键），浅拷贝一层即够；深拷贝无必要（YAGNI）。
    var _seedTypes = {};
    (function () {
        for (var _tn in tables.TYPES) {
            if (Object.prototype.hasOwnProperty.call(tables.TYPES, _tn)) {
                var _src = tables.TYPES[_tn], _copy = {};
                for (var _mn in _src) {
                    if (Object.prototype.hasOwnProperty.call(_src, _mn)) _copy[_mn] = _src[_mn];
                }
                _seedTypes[_tn] = _copy;
            }
        }
    })();

    // 机械规则数据（合并层防篡改再校验与 userTable.precheck 共用——单一真相源）
    // 硬拒族：任何类型上这些成员名都不可提议/不可落表（三档之「不可提议」
    // + 预审即拒——不弹给用户，防「Agent 说需要这个功能」的诱导确认）
    tables.HARD_DENY_MEMBERS = {
        'scheduleTask': 1, 'evalFile': 1, 'execute': 1, 'changePath': 1,
        'runScriptFromFile': 1, 'callSystem': 1, 'BridgeTalk': 1,
        'eval': 1, 'Function': 1,
        'constructor': 1, 'prototype': 1, '__proto__': 1, 'global': 1
    };
    // 强制挂域族：文件写语义成员——落表必带 d:'file'（收录≠无条件放行=进 file 域
    // 管辖——三档之「强制挂域」；footage.replace(file) 默认拒同族）
    // 注：本表判的是**类型成员名提案**（userTable 增补），与 HOST_FNS 的全局宿主函数
    // 是两个面。全局宿主函数 saveProject 已删除（改走原生
    // app.project.save()），但**本表条目保留**——它管的是「给某类型加成员名叫
    // saveProject」的提案，仍按文件写语义强制挂 file 域，与那个全局函数无关。
    tables.FORCE_DOMAIN_MEMBERS = {
        'saveAs': 'file', 'replace': 'file', 'outputModule': 'file',
        'saveProject': 'file', 'importFile': 'file'
    };

    // 审查修正：虚拟类型集——框架内部类型，成员条目刻意不带 d 域标（SystemObj.
    // callSystem / SocketObj.* 的安全性承载于「类型不可达」不变量：仅经
    // POLICY_GATED.identifiers 域闸挂点进入类型链，域关时标识符本身即拒）。增补
    // returnType 引用这些类型 = 为不可达类型开普通成员链入口、短路域闸（审查实证：
    // CompItem.mySys→SystemObj 落表后 mySys.callSystem 链过门即放行）。String-obj/
    // GlobalThis/AEClass/function 为空成员表框架类型，收录无语义，一并拒。
    // FileHandle/FolderObj 刻意不列：成员写原语带 d:'file' 域闸（Project.file 种子先例）。
    tables.VIRTUAL_TYPES = {
        'SystemObj': 1, 'SocketObj': 1,
        'String-obj': 1, 'GlobalThis': 1, 'AEClass': 1, 'function': 1
    };

    // 类型引用合法性（userTable.precheck 与合并层防篡改共用——单一真相源）：
    // 'a|b' 联合逐段、array<X> 剥壳，每段须为 primitive 或 TYPES 已收录的非虚拟类型。
    // extra：本次一并声明的类型名集合——「新增类型」提议在同一次里
    // 给自己的成员写返回类型时，该类型此刻还没进 TYPES，由调用方传入放行。
    var _REF_PRIMS = { 'string': 1, 'number': 1, 'boolean': 1, 'u': 1, 'self': 1, 'user-object': 1 };
    tables.isValidTypeRef = function (t, extra) {
        if (!t || typeof t !== 'string') return false;
        var parts = t.split('|');
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            var m = /^array<(.+)>$/.exec(p);
            if (m) { p = m[1]; }
            p = p.trim();
            if (_REF_PRIMS[p]) continue;
            if (extra && Object.prototype.hasOwnProperty.call(extra, p)) continue;
            if (!Object.prototype.hasOwnProperty.call(tables.TYPES, p)) return false;
            if (tables.VIRTUAL_TYPES[p]) return false;
        }
        return true;
    };

    // 保留类型名（新增类型能力的前置闸）：新类型名不得与 primitive/
    // 框架类型/种子类型撞名——撞 PRIM 会被 entryOn 的 PRIM 分支抢先解析（条目静默失效），
    // 撞虚拟类型则等于给域闸 sugar 面开同名顶替口子。
    var _RESERVED_TYPE_NAMES = null;
    // 原型污染键：对象字面量里 '__proto__' 不产生自有属性（赋值即改原型），
    // 一律不许作类型名（否则 _newTypes/存储序列化会静默丢条目）。
    var _FORBIDDEN_TYPE_NAMES = ['__proto__', 'constructor', 'prototype'];
    tables.isReservedTypeName = function (name) {
        if (_FORBIDDEN_TYPE_NAMES.indexOf(name) >= 0) return true;
        if (!_RESERVED_TYPE_NAMES) {
            var r = {};
            var _put = function (o) {
                for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = 1; }
            };
            _put(_REF_PRIMS);
            _put(tables.VIRTUAL_TYPES);
            _put(tables.PRIM);
            _put(_seedTypes);
            r['array'] = 1; r['ui-object'] = 1; r['Object'] = 1;
            // JS 内建构造器/全局名：与官方类型同名会混淆推断
            //（String→String-obj、Error→ESException），一律不许新建同名类型。
            ['Function', 'String', 'Number', 'Boolean', 'Error', 'Window', 'alert',
                'Array', 'RegExp', 'undefined', 'null', 'NaN'].forEach(function (n) { r[n] = 1; });
            _RESERVED_TYPE_NAMES = r;
        }
        return !!_RESERVED_TYPE_NAMES[name];
    };

    // 合并：adds = { TypeName: { memberName: {t, m?, w?, d?} } }
    // 防篡改再校验（安全红线 ③）：①类型须已存在（种子或用户新增类型）②成员名合法且非硬拒
    //   ③强制域族/FileHandle 类型缺 d 或 d 非 file 时强制重挂 ④t 须为合法类型引用
    //   （isValidTypeRef——primitive/已收录非虚拟类型，堵手改存储虚拟类型走私）。
    //   无效条目静默丢弃 + console.warn（fail-closed 方向——存储被手改不生效）。
    tables.applyUserAdditions = function (adds) {
        if (!adds || typeof adds !== 'object') return;
        for (var tn in adds) {
            if (!Object.prototype.hasOwnProperty.call(adds, tn)) continue;
            // 存在性判据从「种子」放宽到「当前 TYPES」——用户新增类型
            //（applyUserState 先建容器）也能加成员；手改存储凭空写类型仍被丢弃。
            if (!Object.prototype.hasOwnProperty.call(tables.TYPES, tn)) {
                console.warn('[ast-gate] userTable 合并丢弃未知类型: ' + tn); continue;
            }
            // 虚拟类型不作增补宿主：AEClass/function/String-obj/
            // GlobalThis 的空成员表是「类对象面密封」的承载，SystemObj/SocketObj 靠不可达
            // 承载域闸——补表往里加成员等于把密封面打开（虽仍无能力域逃逸，但破坏设计意图）。
            if (tables.VIRTUAL_TYPES[tn]) {
                console.warn('[ast-gate] userTable 合并丢弃虚拟类型宿主: ' + tn); continue;
            }
            var members = adds[tn];
            if (!members || typeof members !== 'object') continue;
            for (var mn in members) {
                if (!Object.prototype.hasOwnProperty.call(members, mn)) continue;
                if (!/^[A-Za-z_$][\w$]*$/.test(mn) || tables.HARD_DENY_MEMBERS[mn]) {
                    console.warn('[ast-gate] userTable 合并丢弃硬拒/非法成员: ' + tn + '.' + mn); continue;
                }
                // 种子赢：新类型没有种子表，按空表查（防 undefined 上取键抛错）
                var seedTbl = _seedTypes[tn] || {};
                if (Object.prototype.hasOwnProperty.call(seedTbl, mn)) continue;
                var e = members[mn];
                if (!e || typeof e !== 'object' || !tables.isValidTypeRef(e.t)) {
                    console.warn('[ast-gate] userTable 合并丢弃无效条目: ' + tn + '.' + mn); continue;
                }
                var entry = { t: e.t };
                if (e.m === 'm') entry.m = 'm';
                if (e.w === 1 || e.w === true) entry.w = 1;
                if (tables.FORCE_DOMAIN_MEMBERS[mn] || tn === 'FileHandle') {
                    entry.d = 'file'; // 强制重挂（手改存储摘除域标记不生效）
                }
                tables.TYPES[tn] = tables.TYPES[tn] || {};
                tables.TYPES[tn][mn] = entry;
            }
        }
    };

    // 回滚到纯种子（管理面 clearAll/「回滚到纯种子」动作消费）。
    // 原地变更（不重建 TYPES 引用）——防外部模块缓存 AEGate.tables.TYPES 引用
    // 后 reset 失联（validate 每次 gate 调用现读 AEGate.tables，但不可假设全体如此）。
    tables.resetToSeed = function () {
        // 删非种子类型 + 类型内删增补成员
        for (var tn in tables.TYPES) {
            if (!Object.prototype.hasOwnProperty.call(tables.TYPES, tn)) continue;
            if (!Object.prototype.hasOwnProperty.call(_seedTypes, tn)) { delete tables.TYPES[tn]; continue; }
            var cur = tables.TYPES[tn];
            for (var mn in cur) {
                if (Object.prototype.hasOwnProperty.call(cur, mn)
                    && !Object.prototype.hasOwnProperty.call(_seedTypes[tn], mn)) delete cur[mn];
            }
        }
        // 补回种子缺失的类型与成员（种子不可删——承重约束的防御面）
        // 覆盖层会**替换**种子成员条目对象（applyUserState 覆盖重建 out），
        // 故此处按引用比对还原——只补缺失键会把改写永久留在内存里（删除改写后不还原）。
        for (var tn2 in _seedTypes) {
            if (!Object.prototype.hasOwnProperty.call(_seedTypes, tn2)) continue;
            tables.TYPES[tn2] = tables.TYPES[tn2] || {};
            var s = _seedTypes[tn2], d = tables.TYPES[tn2];
            for (var mn2 in s) {
                if (Object.prototype.hasOwnProperty.call(s, mn2)
                    && d[mn2] !== s[mn2]) d[mn2] = s[mn2];
            }
        }
    };

    // ── 用户可编辑层（除危险硬拒外不限制用户需求）──────
    // state = { additions: {T:{m:entry}}, newTypes: {T:{sourceUrl,reason,createdAt,reviewed}},
    //           overrides: {T:{m:entry}} }
    // 三类能力（additions 为既有能力，另两类是「限制用户需求」的欠账）：
    //   newTypes  —— 补表可新增类型（只能给已有类型加成员时，官方对象族无从建模）
    //   overrides —— 补表可改写种子条目的判定（返回类型/方法位/可写位；种子赢时，
    //                同键直接拒，类型精度记错也没有修正路径）
    //   additions —— 给已有类型加成员（原能力）
    // 只保留三条安全不变量：①硬拒族不可加/不可改 ②虚拟类型不可引用 ③能力域不可剥离
    //（force 域成员与 FileHandle 成员一律重挂 d:'file'；覆盖继承种子原有的 d 标记）。
    // 无效条目静默丢弃 + warn（存储被手改不生效，方向 fail-closed）。
    tables.applyUserState = function (state) {
        var st = state || {};
        tables.resetToSeed();
        // ① 新增类型：只建空容器；成员仍走 additions 的同一条校验
        var nt = st.newTypes || {};
        for (var tn in nt) {
            if (!Object.prototype.hasOwnProperty.call(nt, tn)) continue;
            if (!/^[A-Za-z_$][\w$]*$/.test(tn) || tables.isReservedTypeName(tn)) {
                console.warn('[ast-gate] userTable 合并丢弃保留/非法类型名: ' + tn); continue;
            }
            if (!Object.prototype.hasOwnProperty.call(tables.TYPES, tn)) tables.TYPES[tn] = {};
        }
        tables.applyUserAdditions(st.additions || {});
        // ② 覆盖：只能改已存在的条目（不能凭空造成员——那是 additions 的职责）；
        //    d/dlg 等种子安全标记继承自原条目，覆盖只能改 t/m/w。
        var ov = st.overrides || {};
        for (var tn2 in ov) {
            if (!Object.prototype.hasOwnProperty.call(ov, tn2)) continue;
            if (!Object.prototype.hasOwnProperty.call(tables.TYPES, tn2)) {
                console.warn('[ast-gate] userTable 覆盖丢弃未知类型: ' + tn2); continue;
            }
            if (tables.VIRTUAL_TYPES[tn2]) {
                console.warn('[ast-gate] userTable 覆盖丢弃虚拟类型宿主: ' + tn2); continue;
            }
            var mem = ov[tn2];
            if (!mem || typeof mem !== 'object') continue;
            for (var mn in mem) {
                if (!Object.prototype.hasOwnProperty.call(mem, mn)) continue;
                if (!/^[A-Za-z_$][\w$]*$/.test(mn) || tables.HARD_DENY_MEMBERS[mn]) {
                    console.warn('[ast-gate] userTable 覆盖丢弃硬拒/非法成员: ' + tn2 + '.' + mn); continue;
                }
                if (!Object.prototype.hasOwnProperty.call(tables.TYPES[tn2], mn)) {
                    console.warn('[ast-gate] userTable 覆盖丢弃不存在的条目: ' + tn2 + '.' + mn); continue;
                }
                var e2 = mem[mn];
                if (!e2 || typeof e2 !== 'object' || !tables.isValidTypeRef(e2.t)) {
                    console.warn('[ast-gate] userTable 覆盖丢弃无效条目: ' + tn2 + '.' + mn); continue;
                }
                var base = tables.TYPES[tn2][mn] || {};
                var out = {};
                for (var bk in base) {
                    if (Object.prototype.hasOwnProperty.call(base, bk)) out[bk] = base[bk];
                }
                out.t = e2.t;
                if (e2.m === 'm') out.m = 'm'; else delete out.m;
                if (e2.w === 1 || e2.w === true) out.w = 1; else delete out.w;
                if (tables.FORCE_DOMAIN_MEMBERS[mn] || tn2 === 'FileHandle') out.d = 'file';
                tables.TYPES[tn2][mn] = out;
            }
        }
    };

    // primitive 成员表（含方法返回类型；'self' = 同接收者类型）
    tables.PRIM = {
        'string': {
            'length': { t: 'number' },
            'charAt': { t: 'string', m: 'm' }, 'charCodeAt': { t: 'number', m: 'm' },
            'concat': { t: 'string', m: 'm' }, 'indexOf': { t: 'number', m: 'm' },
            'lastIndexOf': { t: 'number', m: 'm' }, 'localeCompare': { t: 'number', m: 'm' },
            'match': { t: 'array<u>', m: 'm' }, 'replace': { t: 'string', m: 'm' },
            'search': { t: 'number', m: 'm' }, 'slice': { t: 'string', m: 'm' },
            'split': { t: 'array<u>', m: 'm' }, 'substr': { t: 'string', m: 'm' },
            'substring': { t: 'string', m: 'm' }, 'toLowerCase': { t: 'string', m: 'm' },
            'toUpperCase': { t: 'string', m: 'm' }, 'toString': { t: 'string', m: 'm' },
            'valueOf': { t: 'string', m: 'm' },
            // AE 23.5 实测 String.prototype.trim 存在且可用
            'trim': { t: 'string', m: 'm' }
        },
        'number': {
            'toFixed': { t: 'string', m: 'm' }, 'toExponential': { t: 'string', m: 'm' },
            'toPrecision': { t: 'string', m: 'm' }, 'toString': { t: 'string', m: 'm' },
            'valueOf': { t: 'number', m: 'm' }
        },
        'boolean': {
            'toString': { t: 'string', m: 'm' }
        },
        'array': {
            'length': { t: 'number' },
            'push': { t: 'number', m: 'm' }, 'pop': { t: 'u', m: 'm' },
            'shift': { t: 'u', m: 'm' }, 'unshift': { t: 'number', m: 'm' },
            'join': { t: 'string', m: 'm' }, 'slice': { t: 'array<u>', m: 'm' },
            'splice': { t: 'array<u>', m: 'm' }, 'concat': { t: 'array<u>', m: 'm' },
            'reverse': { t: 'self', m: 'm' }, 'sort': { t: 'self', m: 'm' },
            'some': { t: 'boolean', m: 'm' },
            // 迭代/查找族（回调参数注入元素类型见 validate
            // _ITER_CB——map 返回元素不可静态知，保守 array<u>；filter 同型
            // 过滤返回 self；reduce 聚合值不可静态知）
            'forEach': { t: 'u', m: 'm' },
            'map': { t: 'array<u>', m: 'm' },
            'filter': { t: 'self', m: 'm' },
            'reduce': { t: 'u', m: 'm' },
            'every': { t: 'boolean', m: 'm' },
            'indexOf': { t: 'number', m: 'm' },
            'lastIndexOf': { t: 'number', m: 'm' },
            'toString': { t: 'string', m: 'm' }
        }
    };

    // ── 审计危险集（user-library 审计确认层）─────────────────
    // 语义：仅收录「这个脚本想干什么」的如实陈述信号（能力域引用/逃逸形态），
    // 刻意不含类型表未收录成员等良性缺口——防呆信号质量优先（确认疲劳即防线
    // 失效）；别名混淆等深逃逸的执行边界仍是运行时沙箱（纵深第二层）。
    // 命中 → 审计确认弹窗（非硬拒，user-library 信任根降级）。
    tables.AUDIT = {
        // 能力类标识符：表达式位引用即报（文件/网络/延迟执行/跨应用/$ 工具面）
        capabilityIds: {
            'File': 1, 'Folder': 1, 'Socket': 1, 'system': 1, 'scheduleTask': 1,
            'BridgeTalk': 1, '$': 1, 'runScriptFromFile': 1
        },
        // 能力类成员名：任意接收者（app.scheduleTask / x.callSystem / $.evalFile /
        // app.executeCommand——4.2.1 菜单命令域能力面）
        capabilityMembers: {
            'callSystem': 1, 'scheduleTask': 1, 'executeCommand': 1,
            'evalFile': 1
        },
        // 逃逸形态类标识符：eval/Function 构造器 + 沙箱内部标识符
        // （_OF/_OD/_cs——quickBar hasSandboxBypass regex 的 AST 精确化版本）
        escapeIds: { 'eval': 1, 'Function': 1, '_OF': 1, '_OD': 1, '_cs': 1 },
        // 逃逸形态类成员名：meta-property（$.global 经 '$' 标识符覆盖——'global'
        // 不入成员集：re.global 是合法 RegExp 标志检查，误判不在审计层复活）
        escapeMembers: { '__proto__': 1, 'constructor': 1, 'prototype': 1 },
        // 逃逸形态类标识符前缀：沙箱内部命名族（__ael*/__aeS*）
        escapeIdPrefixes: ['__ael', '__aeS']
    };

    // ── policy 挂点数据表（「表是数据不是代码」——域闸门声明式维护）──
    // identifiers：域开（policy 对应布尔 true）按 type 解析进类型链（无 type 的
    // 按值 'u'——裸调用面），域关走现行拒路径且拒绝附 error.domain（llm-preview
    // 域确认弹窗的输入信号）。'system'+syscallAllowed 特判统一在此表登记。
    // menu 域原为「双挂点」——identifiers 侧 executeMenuCommand（aeTools
    // 宿主函数，裸调用面）+ members 侧 app.executeCommand（App 成员名）。前者已随
    // 其宿主函数删除（它是 findMenuCommandId + executeCommand 的薄包装），
    // 现只剩 members 一条；**域控语义不变**（menu 域开时 app.executeCommand 过门）。
    tables.POLICY_GATED = {
        identifiers: {
            'system': { domain: 'system', type: 'SystemObj' },
            'Socket': { domain: 'socket', type: 'SocketObj' },
            'File': { domain: 'file', type: 'FileHandle' },
            'Folder': { domain: 'file', type: 'FolderObj' }
        },
        members: {
            'executeCommand': { domain: 'menu' }   // App 成员名挂点（TYPES.app.executeCommand 条目协同抑制）
        }
    };

    // AUDIT 域标注（终版矩阵 ON 行 user-library 静默）：危险条目名 → 能力域，
    // 域已开时审计层静默剔除该条目（validate.audit 消费）；$/evalFile/scheduleTask/
    // BridgeTalk/runScriptFromFile 无域——恒报（硬拒面 / 无域面）。
    // saveProject 已从本表与 capabilityIds 摘除（全局宿主函数删除，
    // 该标识符不再可达；保存走原生 app.project.save()，其审计面是成员名而非全局名）。
    tables.AUDIT_DOMAINS = {
        'Socket': 'socket', 'system': 'system', 'callSystem': 'system',
        'File': 'file', 'Folder': 'file',
        'executeCommand': 'menu'
    };

    // 能力类条目的「如实陈述」标签（validate.audit 组装 reason，键 = 条目名）：
    // 只声称确实存在的能力域——挂域项写「<域> 能力域」，无域/无开关项按动作直述、
    // 不出现「能力域」字样。把 $/BridgeTalk/scheduleTask/
    // runScriptFromFile/evalFile 从「引用能力域标识符」这一笼统措辞拆出（它们无域）。
    // saveProject 条目随全局宿主函数删除一并摘除；把
    // 「保存工程（写盘）」的信号补回——落点是 validate 侧**接收者感知**规则
    //（app.project.save 形态，见该处注释）：'save' 是通用词，按名入 capabilityMembers
    // 会把用户对象自己的 .save() 误报成保存工程（审计须如实，宁窄勿假）。
    // 未登记名回落通用措辞（不声称域名）——新增能力类条目请在此登记标签。
    tables.AUDIT_LABELS = {
        'File': '文件/文件夹构造（file 能力域）',
        'Folder': '文件/文件夹构造（file 能力域）',
        'Socket': '网络连接（socket 能力域）',
        'system': '系统命令（system 能力域）',
        'callSystem': '系统命令（system 能力域）',
        'executeCommand': '菜单命令（menu 能力域）',
        'save': '保存工程（写盘）',
        '$': 'ExtendScript $ 接口面（$.evalFile/$.global）',
        'evalFile': '执行脚本文件（$.evalFile）',
        'runScriptFromFile': '执行脚本文件',
        'BridgeTalk': '跨应用通信',
        'scheduleTask': '延迟执行'
    };

    global.AEGate = global.AEGate || {};
    global.AEGate.tables = tables;
})(typeof window !== 'undefined' ? window : globalThis);
