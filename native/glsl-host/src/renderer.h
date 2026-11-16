#pragma once
// renderer.h —— AE SDK 桥：OpenGL 渲染（Task 6）
#include "AE_Effect.h"
#include "AE_EffectCB.h"
// AEGP 类型（AEGP_PluginID 等）来自 AE_GeneralPlug.h——本头文件要声明
// ensureAegpPluginId，故必须引入（该头有 include guard `_H_AE_PlugGeneral`，
// 与各 .cpp 的重复包含幂等；顺序沿用 aeCamera.cpp 的 AE_Effect.h → 本头）。
#include "AE_GeneralPlug.h"
#include "uniformParser.h"
#include "aeCamera.h"
#include "aeLights.h"
#include "pixelDepth.h"
#include <vector>

namespace host {
// 渲染一帧：编译（如变化）→ 上传输入 → 画 quad → 读回 → 写 output world
// uniforms：当前生效的 uniform 列表（槽位 uniforms[i] ↔ 分量0 参数 kIdxSlots+4i）
// src：输入图层（Render 回调用 params[0]->u.ld，SmartRender 用 checkout_layer_pixels）
// userValues：槽位分量值数组（长度 = uniforms->size() * kFloatsPerSlot，分量 c 为
//   第 i 槽的第 c 个 FLOAT_SLIDER），由调用方提供。
//   Render 回调中 params 数组有效，可直接取 params[slotCompIndex(i,c)]->u.fs_d.value；
//   SmartRender 回调中 params 数组不可靠，必须用 PF_CHECKOUT_PARAM 检出后传入。
//   一次微小改动使两条路径统一，避免在 renderFrame 内直接访问 params（崩溃根因）。
// mapLayers：映射图层（iChannel1/2/3）数组，长度恒为 kIdxMapChannels；
//   null 槽位 = 该 channel 未声明 checkout 或用户选 <none>（renderer 绑 1×1 黑
//   透明纹理兜底）；整个指针可为 nullptr（无任何映射图层）。纹理单元 1..3。
// historyLayers：输入历史数组（iHistory0 = 当前帧前 1 帧、iHistory1 = 前 2 帧……），
//   长度 historyCount（≤ glsl::kMaxHistory）；nullptr 或短数组的槽位绑 1×1 黑
//   透明纹理兜底。SmartFX 路径由 PF_Cmd_SMART_PRE_RENDER 的 checkout_layer 取回
//   （检出的效果输入，含前序效果，见 kHistoryCheckoutIdBase）；legacy
//   PF_Cmd_RENDER 路径由 HistoryCheckout 检出（未加工的源图层，见该类注释）。
//   纹理单元 5..8。
// cam：L2 相机/3D 变换快照（aeCamera.h）。null 或未使用的 uniform → 跳过/单位阵
//   兜底，行为与无相机一致。调用方在渲染回调内经 queryCameraUniforms 查询。
// lights：L3 灯光快照（aeLights.h）。null 或未声明的 uniform → 跳过/全零兜底，
//   行为与「无灯合成」一致。调用方在渲染回调内经 queryLightUniforms 查询。
// solveGeneration：「重算代数」隐藏参数值（params.h kIdxSolveGen）。**由调用方读好
//   传入**——Render 回调 params 有效可直接读，SmartRender 回调 params 不可靠须用
//   PF_CHECKOUT_PARAM 检出（与 userValues 同纪律）。它混进结算参数指纹：值一变即
//   整体重解，是手动「重算」按钮的唯一可靠信道（effect_ref 跨上下文会变，不能用
//   它传复位标记——见 customUI.cpp 重算分支）。
// instanceInstanceId：「实例身份」值（载体＝序列数据，见 seqIdentity.h）。
//   **由调用方读好传入**（host::InstanceInstanceId(in_data)；渲染上下文里
//   in_data->sequence_data 可能为 NULL → 经 PF_EffectSequenceDataSuite 取只读句柄）。
//   它按 8 字节定长混进结算参数指纹（renderer.cpp solverParamHash）：同图层两个
//   同款同参实例 → id 不同 → 各走各的谱系（残差修掉）；同一实例的渲染克隆由 AE
//   随渲染工程拷贝复制序列数据 → 同 id → 接力不失效。取不到（数据缺失/套件不可用）
//   传 0 → 退化为「所有实例共享」的旧行为。
// 返回错误信息；成功返回空串
PF_Err renderFrame(PF_InData* in_data, PF_OutData* out_data,
                   PF_LayerDef* src, PF_LayerDef* output,
                   const char* glslSource,
                   const std::vector<glsl::Param>* uniforms,
                   char* errorLogOut, size_t errorLogCap,
                   const float* userValues,
                   const PF_LayerDef* const* mapLayers = nullptr,
                   const CameraUniforms* cam = nullptr,
                   const LightUniforms* lights = nullptr,
                   const PF_LayerDef* const* historyLayers = nullptr,
                   int historyCount = 0,
                   double solveGeneration = 0.0,
                   uint64_t instanceInstanceId = 0);

// —— 映射图层 checkout 守卫 ——
// checkout() 仅检出 channelsUsed 声明的 channel（PF_CHECKOUT_PARAM → 该图层
// 当前时间的 PF_EffectWorld；<none> 时 data==NULL，按无数据处理）；
// 析构自动 CHECKIN 全部已检出参数——覆盖 renderFrame 抛异常（bad_alloc 被
// 外层 catch 吞掉）等所有早退路径，保证 checkout/checkin 严格配对。
// mapLayers() 返回长度 kIdxMapChannels 的数组（未声明/<none> 槽 = nullptr），
// 直接传给 renderFrame。
// —— I2a 输入历史：SmartFX 检出 id 约定 ——
// SMART_PRE_RENDER 用 checkout_layer(index=0, checkout_id, 请求矩形, what_time, …) 按
// 偏移时刻检出输入图层：id 0 = 当前帧输入（smartPreRender 既有），
// id kHistoryCheckoutIdBase + hi = iHistory{hi}（hi = 0..kMaxHistory-1）。
// SMART_RENDER 用 checkout_layer_pixels 按同一 id 取回，一请求一取回一一对应
// （SDK SmartFX：图层输入只能在 PreRender 检出）。该通道检出的是**效果的输入**
// ——前序效果已应用，与 iChannel0 同源。
constexpr int kHistoryCheckoutIdBase = 1;

// —— I2a 输入历史检出（legacy PF_Cmd_RENDER 路径）——
// 仅非 SmartFX 宿主走这里：用 PF_CHECKOUT_PARAM 按偏移时刻检出 param 0。
// 该通道给的是**未加工的源图层**（SDK《Parameter Checkout vs. Param Zero》：
// normal effect 用 PF_CHECKOUT_PARAM 检出图层得到 raw un-effected source，不含
// 前序效果），与 params[0] 的「前序效果输出」语义不同；AE 渲染走 SmartFX，
// 历史帧经 smartPreRender 的 checkout_layer 取（见上）。失败/返回空按「无数据」
// 降级（绑黑纹理），不抛错、不影响主渲染。析构自动 CHECKIN，覆盖 renderFrame
// 抛异常等所有早退路径。
class HistoryCheckout {
public:
    void checkout(PF_InData* in_data, int frames);
    ~HistoryCheckout();
    const PF_LayerDef* const* layers() const { return layers_; }
    int count() const { return count_; }
    HistoryCheckout() = default;
    HistoryCheckout(const HistoryCheckout&) = delete;
    HistoryCheckout& operator=(const HistoryCheckout&) = delete;
private:
    PF_InData* in_data_ = nullptr;
    int count_ = 0;
    PF_ParamDef defs_[glsl::kMaxHistory];
    const PF_LayerDef* layers_[glsl::kMaxHistory] = {nullptr, nullptr, nullptr, nullptr};
    unsigned mask_ = 0;   // bit i = defs_[i] 已 checkout 待归还
};

class MapLayerCheckout {
public:
    void checkout(PF_InData* in_data, uint8_t channelsUsed);
    ~MapLayerCheckout();
    const PF_LayerDef* const* mapLayers() const { return layers_; }
    MapLayerCheckout() = default;
    MapLayerCheckout(const MapLayerCheckout&) = delete;
    MapLayerCheckout& operator=(const MapLayerCheckout&) = delete;
private:
    PF_InData* in_data_ = nullptr;
    PF_ParamDef defs_[3];
    const PF_LayerDef* layers_[3] = {nullptr, nullptr, nullptr};
    unsigned mask_ = 0;   // bit i = defs_[i] 已 checkout 待归还
};

// 提前创建 GL 上下文（PARAMS_SETUP 主线程调用一次，渲染路径复用，避免播放期在渲染线程建上下文）
void ensureGlContext(PF_InData* in_data, PF_OutData* out_data);

// 实例销毁（PF_Cmd_SEQUENCE_SETDOWN）清理该实例的时变掩码/通道身份
// 载体（renderer.cpp 的 s_maskCarriers，effect_ref 键控）——防 effect_ref 地址
// 被新实例复用时继承旧实例的 sticky 位。只清载体，不动谱系帧缓存（见本头文件
// 结算器状态管理注释）；sticky「只置位不清位」语义不变。可在任意线程、
// 无 GL 上下文时调用（内部只取专用临界区）。
void forgetInstanceMaskCarrier(void* effect_ref);

// 渲染诊断日志：更新崩溃阶段跟踪 + 落盘（默认节流，AS_EFFECT_HOST_LOG=1 全量；
// plugin.cpp 渲染路径共用，见 renderer.cpp 注释）
void rfLog(const char* stage, long val);

// 带文本明细 + 结构化数值的诊断行（槽位改名探针）。
// detail 只用于日志（如 desired name），数值字段由调用方按语义排布；
// 实现独立预算（2000 行/进程），不与渲染诊断的 4000 行预算争用。
void rfLog(const char* stage, const char* detail, long slot, long comp,
           long ret, long uniformCount);

// 纯诊断行（stage + 调用方预格式化明细，无字段标签排布），走同一轮转/预算。
// 用于「一趟同步进来了、差异行数多少」这类自成一句的探针。
void rfLogLine(const char* stage, const char* detail);

// 渲染侧「取文件/程序」取证（一行含 idx/文件路径/源码长度/uniform 数/program id）：
// 经 rfLog 节流落盘；AS_EFFECT_HOST_LOG=1 时追加 Win32 直写（本机 fopen("a") 在 AE
// 运行期静默失败，见 errorLog.h rawTrace 注释），供实测取证。仅诊断用。
void rfDiag(const char* line);

// —— L2 相机/3D 变换查询（实现见 aeCamera.cpp）——
// 渲染回调内调用（Render/SmartRender 路径各一次）。SDK 约定 AEGP_PFInterfaceSuite
// 仅限 FRAME_SETUP/RENDER/EVENT::DRAW 期；SmartRender 不在官方允许列表——所有
// AEGP 失败路径一律返回默认值（单位阵/uHasCam=0），不影响渲染；原始矩阵经节流
// 日志（cam-* 前缀）落盘，供实测校准方向语义。AEGP plugin id 惰性注册（进程级一次）。
CameraUniforms queryCameraUniforms(PF_InData* in_data);

// —— L3 合成灯光查询（实现见 aeLights.cpp）——
// 渲染回调内调用（Render/SmartRender 路径各一次），与 queryCameraUniforms 同款约束
// 与降级纪律：任何 AEGP 不可用/套件缺席/枚举失败一律返回默认值（hasLights=0 全零），
// 不影响渲染。灯型/基向量经节流日志（lt-* 前缀）落盘，**供方向语义实测定标**——
// 灯光发光轴与符号在 SDK 中无明文，见 aeLights.h 的未定标警告。
LightUniforms queryLightUniforms(PF_InData* in_data);

// —— AEGP plugin id 共享注册入口（实现见 aeCamera.cpp）——
// queryCameraUniforms / queryLightUniforms 共用同一 id 与失败短路标志，避免两条
// 链路各自注册拿到两个 id、各自记账（见 aeCamera.cpp 注释）。成功返回 true 并
// 写出 id（out_id 可为 nullptr，仅需判断可用性时用）。进程级一次，失败后恒 false。
bool ensureAegpPluginId(SPBasicSuite* pica, AEGP_PluginID* out_id);

// —— 参数流时变判定 + 任意时刻取值（实现见 aeParams.cpp）——
// 结算器专用：打了关键帧/表达式的参数（时变流）值退出结算指纹、逐帧读当帧值——
// 关键帧驱动可用；追赶段（一次渲染调用连解多帧）经 AEGP StreamSuite 按各中间帧
// 时刻取值（GetNewEffectForEffect → GetNewEffectStreamByIndex → GetNewStreamValue）。
// 约束与降级纪律同 queryCameraUniforms：仅渲染回调窗口合法、任何 AEGP 失败静默
// 返回（acquire 失败返回 nullptr，调用方沿用 sticky 时变掩码保指纹稳定、追赶段
// 不缓存仅显示），不影响渲染。
struct ParamValueSession;
// 建会话：预取各槽位分量的参数流并做时变判定（outVaryingMask：bit i = 槽位 i 时变）。
// mapDeclaredMask：本次源码声明的映射通道位（bit ci = iChannel(ci+1)，
// 取自 glsl::parseSamplerChannels）。只对置位通道追查输入图层身份（结算键用）——
// 未声明通道不参与结算，跳过查询省 AEGP 往返。
// outStaticConfirmedMask：bit i = 槽位 i 的**全部分量判定成功且
// 均非时变**。掩码载体的更新策略见 solverMaskPolicy.h（判定成功且静态 → 允许清位，
// 修「删光关键帧后改静态值不重解」）；判定失败的分量两个掩码都不置位 → 沿用 sticky。
// 失败返回 nullptr（两个 out 掩码均置 0）。会话持有 AEGP 流/引用句柄，
// 用毕必须 releaseParamSession 释放。
ParamValueSession* acquireParamSession(PF_InData* in_data,
                                       const std::vector<glsl::Param>* uniforms,
                                       uint8_t mapDeclaredMask,
                                       uint32_t* outVaryingMask,
                                       uint32_t* outStaticConfirmedMask);
// 读会话捕获的第 ci 个映射通道（0→iChannel1，对应 kIdxLayerBase+ci）的输入图层身份。
// 返回 true 时写 *outLayerId（AEGP LayerID，合成内唯一）。false = 未声明/未查到/查询
// 失败/该通道时变（选择随时间变 → 不做静态身份，见 renderer.cpp 身份编码注释）。
bool paramSessionChannelLayerId(const ParamValueSession* s, int ci, uint64_t* outLayerId);
// 按 frame 时刻取各时变槽位（varyingMask 置位）的值，写回 userValuesInOut 对应槽
//（4 float/槽；静态槽位不动——常量流任何时刻值 = 请求帧值）。true = 全部取值成功。
bool paramValueAtFrame(ParamValueSession* s, PF_InData* in_data, int frame,
                       uint32_t varyingMask, float* userValuesInOut);
// 释放会话（流 → AEGP_EffectRefH 逐层 dispose）。
void releaseParamSession(ParamValueSession* s);

// —— 结算器（@solve）状态管理（实现见 renderer.cpp）——
// 键控改造：帧缓存按**谱系**键控（图层身份 = 合成 itemID + 图层
// LayerID，⊕ 参数指纹），不再按 effect_ref——真机日志证伪了"渲染串行单实例"
// 的假设：AE 拖时间线时成批克隆短命渲染实例（SEQUENCE_RESETUP），per-instance
// 缓存随实例生灭，表现为回拖已算过的帧仍整段重解。谱系表进程级共享、跨实例
// 接力，实例销毁（SEQUENCE_SETDOWN）**不**清缓存；旧谱系由全局 LRU 过期
//（kSolverCacheGlobalBudgetBytes，见 solverSchedule.h）。身份获取失败降级
// effect_ref 键（现状行为）。曾经的 releaseSolverState(SETDOWN 清理入口) 已
// 移除——连带消灭了 SETDOWN 等解算临界区导致的"删图层时 AE 卡住"。
// 参数指纹追加 **iChannel 输入身份**——同图层
// 两个同款同参 @solve 不再因"键只含图层+参数"而合流（第二个实例的映射图层输入
// 被忽略）。身份取图层参数指向的图层（AEGP LayerID，克隆无关），克隆接力不变。
// —— 解算进度（ECW 进度条读它）——
// 渲染线程写、UI 线程读：内部四个 LONG + Interlocked（不加锁、不与 GLLock/解算
// 临界区争用）。UI 线程必须在渲染期也能读到，否则进度条会卡在旧值。
struct SolverProgress {
    bool active;   // 正在推进/重解（缓存命中的 O(1) 路径不算——那没有可等的进度）
    int  done;     // 本次已解算帧数
    int  total;    // 本次要走的帧数（含目标帧）
    int  frame;    // 正在解算的帧号
};
SolverProgress solverProgress();

} // namespace host
