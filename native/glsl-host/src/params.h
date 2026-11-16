#pragma once
// params.h —— 参数槽位：GLSL 文件选择 + 32 个通用槽位（收进可折叠的"参数"分组）
//
// 槽位底层由 ARBITRARY_DATA（CUSTOM_VALUE，AE 脚本层不可读写，
// 实测报「此 propertyValueType CUSTOM_VALUE 尚未实施」）换成原生可脚本类型，
// 打通「LLM 脚本下发运行期参数」：
//   - 每槽 4 分量，各为 1 个 PF_Param_FLOAT_SLIDER（PF_FloatSliderDef.value =
//     PF_FpLong = double，脚本 property(k).value 可读写）。
//   分量0 带 PF_PUI_CONTROL（自绘整行，外观与既有样式一致）；分量1..3 带
//   PF_PUI_NO_ECW_UI 完全不出现在 ECW（仅作数值容器）。
//   注意：不用 PF_Param_POINT_3D 承载前 3 分量——POINT_3D 带「图层原点百分比」
//   语义，AE 脚本读 property(k).value 会抛「数字结果无效」，故整体改为 4 个
//   FLOAT_SLIDER（同为原生可脚本类型，无原点偏移副作用）。
//
// 索引与 disk ID 约定（disk ID 是 AE 跨版本的稳定键）：
//   分量 c 的索引 = 5 + 4*i + c（i = 0..31，c = 0..3）→ 5..132
//           分量0 = 该槽位可见行（自绘）；分量1/2/3 隐藏
//   disk ID = 500 + 4*i + c（全新区段，避免与旧 300/400 区段撞键误恢复）
//   其后区段整体后移：group end 133、映射图层 134..138、相机 139、
//   GLSL 索引 140、总数 141。
#include "uniformParser.h"
namespace host {
constexpr int kMaxParams = 32;

// 每个槽位的分量数（vec4 满，vec3 前 3，vec2 前 2，float 第 1）
constexpr int kFloatsPerSlot = 4;

// 「Shader 文件」分组：自绘文件选择器
// 原生 popup 的选项列表在 AE 中无法运行时更新（PF_UpdateParamUI 白名单不含
// num_choices/namesptr），故保留自绘：折叠显示当前文件 + ↻ 刷新；展开显示 effects
// 目录全部文件，点击切换。
// 选择器必须用 ARBITRARY_DATA：AE 对**标准参数类型**
//（POINT_3D/FLOAT_SLIDER）不采用 ui_height（注册时设 0 也不隐藏，运行时
// PF_UpdateParamUI 改高度更无效），而展开/折叠恰恰依赖 ui_height 变大控件高度；
// ARBITRARY_DATA + PF_PUI_CONTROL 才被 AE 当作真正的自定义控件、按请求高度布局。
// 选中索引真相源为尾部隐藏参数 kIdxFileIndexParam（PF_PUI_NO_ECW_UI）；选择器
// handle 的 f[0] 为只写不读的遗留索引，f[1]/f[2] 承载展开/滚动会话态。
constexpr int kIdxFileGroupStart  = 1;                       // PF_Param_GROUP_START（默认展开）
constexpr int kIdxFileSelector    = 2;                       // PF_Param_ARBITRARY_DATA + PF_PUI_CONTROL
constexpr int kIdxFileGroupEnd    = 3;                       // PF_Param_GROUP_END
constexpr int kFileSelUiId        = 1000;                    // 选择器 ARBITRARY uiID
constexpr int kFileSelDiskId      = 210;                     // 隐藏索引参数 disk ID
// 选择器滑条有效范围：索引只需 0..文件数-1，留宽便于库增长（脚本超范围 setValue 会抛错）
constexpr double kFileSelValidMin = 0.0;
constexpr double kFileSelValidMax = 9999.0;

// 「参数」分组（单分组布局）：
// 32 个槽位（每槽 4 个 FLOAT_SLIDER = 128 个参数）全部注册进「参数」组（默认折叠），
// 不再拆「未激活参数」组——AE 的 PF_UpdateParamUI 无法运行时把参数移动到另一个
// 分组，拆两组会导致切换 glsl 文件后新增的激活 uniform 永远留在「未激活参数」组、
// 回不到「参数」列表。改为单组后：未激活槽位的分量0 通过 ui_height=0（隐藏）+
// DISABLED（置灰兜底）不占位，激活时恢复 kSlotUiHeight，切换文件即时归位
// （分量1..3 恒 PF_PUI_NO_ECW_UI，不参与布局）。
constexpr int kIdxGroupStart      = 4;                                     // PF_Param_GROUP_START（「参数」组，折叠）
constexpr int kIdxSlots           = 5;                                     // 槽位分量0起始索引（分量 c → 5+4i+c）
constexpr int kSlotsSpan          = kMaxParams * kFloatsPerSlot;           // 128（32 槽 × 4 分量）
constexpr int kIdxGroupEnd        = kIdxSlots + kSlotsSpan;                // 133（「参数」组 END）

// —— 「映射图层」分组：iChannel1/2/3 原生图层下拉 ——
// shader 声明 iChannel1/2/3 时可各选一个合成图层作纹理输入（PF_Param_LAYER，
// AE 自动生成图层下拉，随工程持久化）。上限固定 3 个：PF_Param_LAYER 必须在
// PARAMS_SETUP 注册，无法运行时增删；启用态由 SyncParamUI 按当前文件声明同步
// （槽位同款：名称/启用比对，变化才 PF_UpdateParamUI，**不改写 ui_height**）。
// 判定（依据：SDK 注 AE_Effect.h:2290「ui_width/ui_height
// 仅在 PF_PUI_CONTROL 下被采用」+ 代码复核；本仓库无真机日志）：LAYER 未挂 PF_PUI_CONTROL →
// 行无法隐藏，未声明的行只加 DISABLED 置灰；行名注册期恒为「映射图层 N」，改名「—」只在
// 声明位由有变无时发生。功能无损、观感降级。
//
// 【兼容性约束】参数只能在尾部追加，绝不能在中间插入：AE 按 disk ID 恢复旧工程
// 参数值，盘 ID 是跨版本稳定键；如确需改索引务必同步维护 disk ID。
constexpr int kIdxLayerGroupStart = kIdxGroupEnd + 1;        // 134（PF_Param_GROUP_START，「映射图层」组，折叠）
constexpr int kIdxLayerBase       = kIdxLayerGroupStart + 1; // 135（iChannel1 → 135+i）
constexpr int kIdxMapChannels     = 3;                       // 映射图层上限（iChannel1/2/3）
constexpr int kIdxLayerGroupEnd   = kIdxLayerBase + kIdxMapChannels;  // 138（PF_Param_GROUP_END）

// —— 「启用三维摄像机」复选框（L2 相机联动总开关）——
// 勾选：渲染回调内 AEGP 查询相机/世界矩阵并注入 uHasCam/uCamFov/uCamPos/
// uCamMatrix/uWorldMatrix；取消：跳过查询，注入无相机默认值（uHasCam=0 + 单位阵，与
// 「无相机合成」同语义——面板预览另走自己的可操控虚拟相机 uHasCam=1，不在此兜底内）。
// 默认勾选（功能开箱即用；AEGP 失败静默降级，
// 关闭仅省每帧 4 次套件调用的开销）。
constexpr int kIdxCamEnable       = kIdxLayerGroupEnd + 1;    // 139（PF_Param_CHECKBOX）

// 槽位分量的 disk ID 基址（分量 c → 500 + 4i + c）。全新区段：旧工程存的
// 300/400 区段（ARBITRARY 句柄 / 旧滑条）不匹配 → 回落默认值，而非被误读。
constexpr int kSlotCompDiskIdBase = 500;
// 滑条**有效输入范围**（valid_min/max）：脚本 setValue 超出该范围会抛错
// 故放宽到 ±1e9——让脚本/AI 写入任意数值不被 AE 钳制。
// 注意：这**不是**滑条量程，两者语义不同，见 slotSliderRange。
constexpr double kSlotSliderValidMin = -1.0e9;
constexpr double kSlotSliderValidMax =  1.0e9;

// —— 槽位滑条量程与显示精度 ——
// SDK 对 FLOAT_SLIDER 的两个范围字段语义不同（AE_Effect.h:1669-1670）：
//   valid_min/max  = "acceptable input range"（可接受/可输入范围）
//   slider_min/max = "range represented by width of slider"（**滑条宽度所代表的量程**）
// 把同一个常量同时赋给两者的副作用有二（用户报"±1e9 是正常的吗"）：
//   ① AE 原生参数对话框（时间线点参数值弹出的那个）显示"滑块范围 -1000000000
//      至 1000000000"；② 那根滑条彻底不可用——整条宽度映射 ±1e9，1px ≈ 1e7，
//      且 PF_FpShort（32 位 float）在 1e9 量级的分辨率仅约 64，微调无从谈起。
// 现分工：valid 保持宽（不钳制脚本写入），slider 收成**按类型/命名的有用量程**：
//   · uniform 声明了 `// @range min max`（LLM 可写）→ 用声明值（与自绘滑条同源）；
//   · 颜色语义（Vec4 / 名字含 color）→ 0..1；
//   · 角度语义（名字含 angle/deg/rot，见 glsl::isAngleNamed）→ -360..360；
//   · 其余标量/向量 → -10..10。
// precision（显示小数位，A_short）由量程跨度导出：≤2 → 3 位；≤100 → 2 位；否则 1 位
//（否则宽量程下原生对话框只能显示整数）。
// 【边界】面板内那根**自绘**滑条的量程由 customUI.cpp 的 rangeFor 决定（同样支持
// @range——min>max 两边均已归一交换，与面板 uniformParser.js 同口径；无 @range 时
// 默认回退是 [min(0,dv), max(1,dv)]）——本函数只影响 AE 原生对话框与时间线手感，
// 不改自绘滑条；默认量程若也要完全一致，需把 rangeFor 的回退切到本规则。
inline void slotSliderRange(const glsl::Param& p, double* lo, double* hi, int* precision) {
    double a = -10.0, b = 10.0;   // 其余标量/向量：温和默认量程
    if (p.hasRange) {
        a = p.rmin;
        b = p.rmax;
        // min>max 反写（如 `// @range 10 0`）：与面板同口径交换（client/shared/
        // uniformParser.js 在 mx < mn 时交换；uniformParser.cpp 解析层也做同款
        // 归一）。宿主不交换的话，同一参数的 AE 原生滑条方向与面板滑条相反
        //（用户"拖了没反应/反着走"）——量程必须是 [lo, hi] 且 lo<=hi。
        if (a > b) {
            const double t = a;
            a = b;
            b = t;
        }
    } else if (p.type == glsl::ParamType::Vec4 || glsl::isColorNamed(p.name)) {
        a = 0.0;
        b = 1.0;
    } else if (glsl::isAngleNamed(p.name)) {
        a = -360.0;
        b = 360.0;
    }
    if (a == b) b = a + 1.0;   // 防退化量程（滑条宽度映射除零）
    const double span = b - a;
    *lo = a;
    *hi = b;
    *precision = (span <= 2.0) ? 3 : ((span <= 100.0) ? 2 : 1);
}

// —— 选中文件索引真相源（脚本可读写；PF_PUI_NO_ECW_UI → 不在 ECW 出现）——
// UI 点选/脚本写入都落在这里（带 CHANGED_VALUE 持久化）；渲染/SmartRender/
// SyncParamUI/选择器显示统一读它。选择器 ARBITRARY handle f[0] 为只写不读的
// 遗留载体（仅作 instanceFileIndex 参数缺失时的兜底回退）。
constexpr int kIdxFileIndexParam  = kIdxCamEnable + 1;                 // 140

// —— 「启用三维灯光」复选框（L3 灯光联动总开关）——
// 勾选：渲染回调内 AEGP 枚举合成灯光（灯型/位置/朝向/颜色×强度/锥角/衰减）并注入
// uHasLights/uLightCount/uLightType[]/uLightPos[]/uLightDir[]/uLightColor[]/uLightParams[]；
// 取消：跳过查询，注入无灯默认值（hasLights=0、count=0、数组全零，与「无灯合成」
// 及面板预览同语义）。默认勾选（与 kIdxCamEnable 同策略：失败静默降级，关闭仅省
// 每帧一次合成枚举的开销）。
//
// 【落位理由】追加在 kIdxFileIndexParam **之后**而非紧跟摄像机开关：AE 按 disk ID
// 恢复旧工程参数值，把新参数插在 140 位会把隐藏的文件索引参数挤到 141，
// 旧工程存下的 140（文件索引）将被新复选框误读。故严格遵守「只能在尾部追加」。
// 视觉顺序不受影响：文件索引参数挂 PF_PUI_NO_ECW_UI 不显示，ECW 中本复选框
// 紧跟摄像机开关之后。
constexpr int kIdxLightEnable     = kIdxFileIndexParam + 1;            // 141

// —— 「重算代数」（隐藏）——
// 手动「重算结算器」按钮的**缓存失效载体**。AE 的帧缓存键只看参数值，而重算不改
// 任何参数值 → 不作废缓存时 AE 把上一帧画面原样还回来（用户实测反馈"点了还是吃
// 缓存"）。真机实测：`PF_OutFlag_FORCE_RERENDER` + 给 ARBITRARY 选择器参数置
// `PF_ChangeFlag_CHANGED_VALUE`（= 文件切换那条路径的组合）在 DO_CLICK 里**不足以**
// 触发重渲——点击后日志只有 `solve-reset-req`，没有任何 SmartRender；而同一函数里
// 切文件却会重渲，差别只在切文件顺带改了**槽位滑条的值**。故改为本参数：每点一次
// 「重算」+1（值真变，与用户拖滑条同款机制），AE 必然失效该帧缓存并重渲。
// 【落位】严格遵守「只能在尾部追加」（disk ID 是跨版本恢复键）：追加在灯光开关之后。
constexpr int kIdxSolveGen        = kIdxLightEnable + 1;               // 142
constexpr int kSolveGenDiskId     = 211;                               // 重算代数 disk ID
constexpr double kSolveGenValidMax = 9999.0;                           // 计数器回绕上限

// —— 「重算结算器」按钮控件（ARBITRARY_DATA + PF_PUI_CONTROL）——
// 位置放在「启用三维灯光」下方（= 参数表末尾），样式做成一枚真正的按钮
// （带边框、居中文字、悬停/按下反馈），不在文件行表头里挤 40px 裸字。
// 它是**纯 UI**：点击只做两件事——给 kIdxSolveGen +1（缓存失效载体）并置
// FORCE_RERENDER；结算状态复位由渲染路径据指纹变化完成（机制与理由见上方注释）。
// 【落位】尾部追加（disk ID 是跨版本恢复键），排在隐藏的 kIdxSolveGen 之后——
// 隐藏参数不占视觉行，故它显示为「启用三维灯光」下面紧接的一行。
constexpr int kIdxSolveBtn        = kIdxSolveGen + 1;                  // 143
constexpr int kSolveBtnUiId       = 1001;
constexpr int kSolveBtnDiskId     = 212;
constexpr int kSolveBtnH          = 26;                                // 按钮行高（含上下留白）
void* const    kSolveBtnRefcon    = (void*)0x534F4C5642544E31LL;       // 'SOLVBTN1'

// —— 「实例身份」不在参数表里 ——
// 曾有过一个隐藏 FLOAT_SLIDER 身份参数（索引 144 / disk 213）——
// 证伪了它的前提「PARAMS_SETUP 每实例执行一次」：**PARAMS_SETUP 每 AE 会话只发
// 一次**（两次 addProperty 只有一行 params-setup-done），新实例初值一律取注册期
// dephault（AE_Effect.h:416-423 明文），故参数路给不出「每实例不同」的初值
//（dephault 写号值 → 全实例同号；留 0 → 全 0）。身份现在走**序列数据**：
// SEQUENCE_SETUP 每次「应用到图层」都发（每实例铸号），FLATTEN/RESETUP 随渲染
// 工程拷贝把数据带给渲染克隆——见 seqIdentity.h（含全部真机证据）与 plugin.cpp
// 的 SEQUENCE_SETUP / SEQUENCE_RESETUP 分支。
// 参数总数回到 144：输入层 + 文件组(1-3) + 参数组(4-133) + 映射图层组(134-138) +
// 摄像机开关(139) + 隐藏文件索引(140) + 灯光开关(141) + 隐藏重算代数(142) + 重算按钮控件(143)
constexpr int kNumParams          = kIdxSolveBtn + 1;                  // 144

// ARBITRARY 回调的 refconPV（选择器用；与 ColorGrid 的 ARB_REFCON 同用途；
// 非 constexpr：指针常量表达式在 MSVC 下不可作为常量折叠；非 const 限定：
// PF_ADD_ARBITRARY2 的 REFCON 参数类型为 void*）
void* const    kSlotRefcon      = (void*)0x474C534C474C534CLL; // 'GLSLGLSL'

// 映射图层行高（声明时恢复的显示高度；槽位同款语义）
constexpr int kLayerUiHeight      = 22;

// 选择器选项全部为库文件（无 active 特殊项）；索引越界/默认回退到第一个库文件
constexpr int kDefaultFileIndex  = 0;

// —— 文件选择器控件（自绘）——
constexpr int  kFileSelHeaderH    = 24;     // 表头行高（展开三角 + 当前文件 + ↻ 刷新）
constexpr int  kFileSelRowH       = 17;     // 文件行高
constexpr int  kFileSelMaxRows    = 8;      // 列表最大显示行数（超出显示滚动条）
constexpr int  kFileSelCollapsedH = 24;     // 折叠时控件高度（= 表头高）
// 「重算结算器」整行按钮（仅结算模式下存在）：放在控件**底部**而不是文件行内部——
// 底部定位不动任何既有行坐标（列表/滚动/悬停全按 f.top 锚定），只让控件高度多一行。
constexpr int  kSolveResetRowH    = 22;

// 文件选择器滚动条（文件数 > kFileSelMaxRows 时显示）。AE custom UI 无滚轮
// 事件（PF_Event 仅 DO_CLICK/DRAG/ADJUST_CURSOR/KEYDOWN），滚动靠：
// ▲/▼ 点击（±1 行）、轨道点击（翻页）、滑块拖拽（DRAG 事件）。
// 滚动偏移改存 per-instance 内存（customUI.cpp），不再占用参数存储。
constexpr int  kSelScrollW        = 12;     // 滚动条宽（贴列表右缘）
constexpr int  kSelScrollArrowH   = 12;     // 上下箭头按钮高
constexpr int  kSelScrollThumbMin = 14;     // 滑块最小高（可点击性下限）
constexpr int  kSelDragScrollbar  = -2;     // DragState.slot 哨兵：滚动条拖拽（槽位为 0..31，负值不冲突）

// —— CUSTOM UI 槽位 ——
// 32 槽位 × 4 分量全部注册为 PF_Param_FLOAT_SLIDER：分量0 挂 PF_PUI_CONTROL
// （自绘整行），分量1..3 挂 PF_PUI_NO_ECW_UI（纯数值容器，不出现在 ECW）：
//   - 值类型固定（不随 uniform 类型变化）→ AE 缓存/重加不重跑 PARAMS_SETUP 均不影响；
//     控件形态由绘制时按当前 uniform 类型决定（见 customUI.cpp）
//   - 关键帧：分量1..3 是 PF_PUI_NO_ECW_UI（不出现在 ECW），UI 上仅分量0 可打关键帧
// ui_width/ui_height 仅在设置 PF_PUI_CONTROL 时被 AE 采用（AE_Effect.h:2290-2291）。
constexpr int  kSlotUiWidth     = 200;                     // 控件请求宽（AE 按面板实际宽度布局）
constexpr int  kSlotUiHeight    = 22;                      // 控件高（**单行**；多分量控件 = 本值 × 行数）

// 槽位自绘控件的**行数**：点控件每个分量独占一行（Vec2=2 / Vec3=3），单行控件
// （Float 滑条、色块、色块+alpha）为 1。与 customUI.cpp kindFor 的控件选型同口径——
// 颜色命名的 vec2/vec3 走 Swatch 单行，故这里也要排除，否则会注册出两三行高、
// 却只画一行的"空行"。
// **注册行高（plugin.cpp：本值 × 本函数）与绘制分行（customUI.cpp drawPoint）必须
// 共用本函数**：各算一份时，行高与行数不匹配就表现为"行被裁掉"或"行内大片留白"。
inline int slotUiRows(const glsl::Param& p) {
    switch (p.type) {
    case glsl::ParamType::Vec2: return glsl::isColorNamed(p.name) ? 1 : 2;
    case glsl::ParamType::Vec3: return glsl::isColorNamed(p.name) ? 1 : 3;
    default: return 1;
    }
}

// 多行控件的第 row 行纵向范围（[top, bottom] 内按 rows 等分）。
// **用乘除而非逐行累加**：等分点不累积舍入误差，相邻行边界严格相接
// （累加会让"第 2 行上界"与"第 1 行下界"差 1px，表现为行间空隙或压线）。
// 高度不足以给每行留 1px 时按下限撑开（宁可超出控件框一点，也不产生 0 高行——
// 0 高行的拖拽带为空，那一行就彻底点不动了）。
inline void slotRowBand(int top, int bottom, int rows, int row, int* rt, int* rb) {
    const int n = (rows > 0) ? rows : 1;
    const int h0 = bottom - top;
    const int h = (h0 > n) ? h0 : n;
    if (rt) *rt = top + (h * row) / n;
    if (rb) *rb = top + (h * (row + 1)) / n;
}

// uniform → 槽位默认值（4 分量）。单点维护，两个使用方必须一致：
//   ① PARAMS_SETUP 注册槽位 dephault（plugin.cpp addSlot）；
//   ② 文件切换点击把新文件默认值写入槽位（customUI.cpp handleFileSelectorClick）
//      ——PF_UpdateParamUI 不能改 value/dephault，不写值的话切换文件后槽位保留
//      旧值，与所选 shader 声明的默认值不一致。
// 规则：Float 无初始化器默认 1.0；vec4 无初始化器默认全 1.0；vec2/vec3 无初始化器
// 保持 0；有初始化器（hasDef）一律取解析值 def[0..3]。
inline void ecwDefault4(const glsl::Param& p, float dv[4]) {
    dv[0] = dv[1] = dv[2] = dv[3] = 0.0f;
    if (p.type == glsl::ParamType::Float) {
        dv[0] = p.hasDef ? p.def[0] : 1.0f;
    } else if (p.type == glsl::ParamType::Vec4) {
        for (int c = 0; c < 4; ++c) dv[c] = p.hasDef ? p.def[c] : 1.0f;
    } else if (p.hasDef) {
        for (int c = 0; c < 4; ++c) dv[c] = p.def[c];
    }
}
} // namespace host
