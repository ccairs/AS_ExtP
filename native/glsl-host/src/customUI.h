#pragma once
// customUI.h —— 槽位 CUSTOM UI 自绘与交互（Drawbot）
// 参考 SDK 示例 Examples/UI/Custom_ECW_UI（标准参数类型 + PF_PUI_CONTROL）
// 与 ColorGrid（自绘 + 关键帧）。
//
// 槽位底层由 ARBITRARY_DATA 换为原生可脚本类型——
//   每槽 4 分量各为 PF_Param_FLOAT_SLIDER（分量0 挂 PF_PUI_CONTROL 绘制仍由本文件
//   自绘，外观不变；分量1..3 挂 PF_PUI_NO_ECW_UI 仅作数值容器）。
// 控件形态由 uniform 类型 + 命名语义决定（绘制时按本实例选中文件取 per-file
// 缓存条目的 uniforms，见 customUI.cpp uniformAt / effectState.h fileCache）：
//   Float                     → 单分量滑条 + 数值
//   Vec2/Vec3                 → 点控件（**每个分量独占一行**：行首 x/y/z 标签 + 滑条 + 数值框）
//   Vec3 且名字含 color/colour → 色块 + 点击弹 AE 原生取色器
//   Vec4                      → 色块 + 点击弹取色器 + alpha 滑条
#include "AEConfig.h"
#ifdef AE_OS_WIN
#include <windows.h>
#endif
#include "AE_Effect.h"
#include "AE_EffectUI.h"
#include "AEFX_SuiteHelper.h"

#include "fileSelLayout.h"   // FileSelHandle v2 布局 + 纯字节序列化（SDK 无关）

namespace host {

// 文件选择器 ARBITRARY_DATA 值布局见 fileSelLayout.h（v2 定长，含身份名）。
// 其中 v[1] = 展开、v[2] = 滚动（纯 UI 会话态，见 customUI.cpp）；
// v[0] = 位置索引，现为只写不读的遗留载体（选中的真相源是隐藏参数 kIdxFileIndexParam）。
// 身份名（name）是本次新增的持久化载体：库增删只改变"名字→位置"的映射，
// 已有实例不再随位置位移而静默换成另一个 shader。

// 分配 v2 ARBITRARY_DATA handle 并填入 4 个 float。仅服务文件选择器：
// PARAMS_SETUP 的 dephault 与 PF_Arbitrary_* 回调的输出分配。
// 失败返回 PF_Err_OUT_OF_MEMORY。
PF_Err AllocFileSelHandle(PF_InData* in_data, PF_OutData* out_data,
                          const float v[4], PF_ArbitraryH* outH);

// —— 选中项身份（名字）读写 ——
// 写者只有 UI 线程（DO_CLICK / USER_CHANGED_PARAM），读者是渲染线程；
// 顺序约定见 fileSelSetIdentity。handle 为空/不可锁 → 静默返回。
// 注：PF_LOCK_HANDLE 宏展开引用作用域内的 in_data，故必须传入（SDK 约定）。
void WriteFileSelSelection(PF_InData* in_data, PF_ArbitraryH h, int index, const std::string& name);

// 读选中项。返回 false = handle 不可用（*index = -1、*name 清空）。
bool ReadFileSelSelection(PF_InData* in_data, PF_ArbitraryH h, int* index, std::string* name);

// 本实例选中文件的位置索引：真相源是隐藏参数 kIdxFileIndexParam（脚本与 UI 都写它）；
// 参数缺失时回退选择器 handle 的 v[0]，再回退 kDefaultFileIndex。
int InstanceFileIndex(PF_InData* in_data, PF_ParamDef* params[]);

// 本实例身份 id（载体见 seqIdentity.h）：谱系键的 per-instance 分量，
// 同图层两个同款同参实例靠它各走各的谱系。真相源 = 序列数据（SEQUENCE_SETUP
// 每实例铸号；FLATTEN/RESETUP 随渲染工程拷贝带到渲染克隆）——读取路径见实现。
// 返回 0 = 取不到（数据缺失/套件不可用）→ 调用方按「所有实例共享」的旧行为处理。
// 注意：**不得**用 ARBITRARY 句柄或 effect_ref 顶替——
//（渲染克隆不按实例携带 ARBITRARY 句柄内容）+ effect_ref 跨上下文会变。
uint64_t InstanceInstanceId(PF_InData* in_data);

// 本实例记住的身份名。空串 = 无身份（v1 旧工程 / 从未捕获）→ 调用方按位置回退。
std::string InstanceShaderName(PF_InData* in_data, PF_ParamDef* params[]);

// PF_Cmd_EVENT 处理：处理文件选择器（kIdxFileSelector）与 32 个槽位分量0
// （effect_win.index ∈ [kIdxSlots, kIdxSlots + kMaxParams*kFloatsPerSlot)，步长 4）的
// DRAW / DO_CLICK / DRAG / ADJUST_CURSOR；其余参数返回 PF_Err_NONE 由 AE 默认处理。
PF_Err HandleUIEvent(PF_InData* in_data, PF_OutData* out_data,
                     PF_ParamDef* params[], void* extra);

// 应用文件选择器的待定高度变更（展开/折叠/刷新后行数变化），经
// PF_UpdateParamUI(ui_height) 让 AE 重新布局 ECW。
// 由 PF_Cmd_UPDATE_PARAMS_UI 调用（PF_UpdateParamUI 的官方许可上下文）。
PF_Err SyncFileSelectorUI(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[]);

// （PF_Cmd_UPDATE_PARAMS_UI 调用，见 plugin.cpp reconcileFileIndexChange）
// 脚本改索引（fx.property(kIdxFileIndexParam).setValue(N)）后登记 per-instance
//「槽位值待重置」：该阶段禁止写参数值/置 PF_ChangeFlag_CHANGED_VALUE
//（AE_Effect.h:1111-1113 只允许 cosmetic 改动），故此处**零参数写入**——只登记，
// 不注入任何合成输入、不挂定时器。登记后由**用户下一次与本实例 ECW 的真实交互**
//（PF_Cmd_EVENT 的 DO_CLICK，即 handleClick）在合法写值上下文消费该标记，复用与
// 手动点击完全相同的单点实现重置槽位为新文件声明的默认值
//（customUI.cpp resetSlotsToFileDefaults）。取舍：若用户不交互，重置不会发生
//（槽位保留旧值）——换取彻底不注入合成输入、不调用非法阶段的 API。
PF_Err RequestSlotResetForFileIndex(PF_InData* in_data, PF_OutData* out_data,
                                    PF_ParamDef* params[]);

// **合法写值上下文的立即重置**（PF_Cmd_USER_CHANGED_PARAM 调用，返回值 = 重置到的文件索引，
// -1 = 未执行）：把槽位值重置为当前索引指向文件声明的默认值 + 置 PF_OutFlag_FORCE_RERENDER，
// 并清掉「待重置」登记（本函数已当场兑现，避免用户下次点击时重复重置一遍）。
//
// 为什么这是根因修复而非补丁：脚本写索引后，宿主唯一能观测到的 PF_Cmd_UPDATE_PARAMS_UI
// **禁止写参数值**（AE_EffectSuites.h:200-215：PF_UpdateParamUI 可改字段清单里没有 value，
// 且明文 "you are not allowed to change the value during PF_Cmd_UPDATE_PARAMS_UI"），
// 于是只能登记「待重置」并等用户下一次真实交互——AI/脚本场景下永不发生，槽位值
// 停留在上一个文件，渲染即「新 shader + 旧参数值」（实测死黑/死灰）。
// PF_Cmd_USER_CHANGED_PARAM 是 SDK 明确允许写值的阶段（AE_Effect.h:2250），且该命令的
// 设计用途正是「make one control affect others」（AE_Effect.h:1092）——即本场景。
// 前提：索引参数挂 PF_ParamFlag_SUPERVISE 后 AE 确实为本命令派发（plugin.cpp 注册处注释
// 记录了 SDK 两处口径不一致与该前提的实测需求）。
int ApplySlotDefaultsNow(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[]);

// 中键滚轮 pending 消费（UPDATE_PARAMS_UI 上下文，无 extra）：应用钩子队列
// 累计的待滚行数到选择器 handle 并 invalidate ECW 宿主根窗口触发重绘。
PF_Err selWheelConsume(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[]);

// 插件卸载（PF_Cmd_GLOBAL_SETDOWN）：停掉专用滚轮钩子线程（WH_MOUSE_LL 装在
// 独立线程上，避免回调占用 AE 主线程造成点击卡顿），并清空滚轮目标/待滚队列。
void ShutdownWheelHook();

// 实例销毁钩子——PF_Cmd_SEQUENCE_SETDOWN（效果从图层移除）时调用：
// 清理该实例的编辑会话条目/编辑框归属静态量/挂起的延迟合成点击定时器/「待重置」
// 登记，防止悬空条目让注入点击误操作 ECW 重排后的其他实例，也防 effect_ref 地址
// 复用时被新实例误读。
PF_Err ShutdownInstanceUI(PF_InData* in_data);

} // namespace host
