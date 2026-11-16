// seqIdentity.h —— 实例身份的载体（序列数据）
//
// 【为什么不是隐藏参数】
// 参数路的前提是「PARAMS_SETUP 每实例执行一次」——真机日志证伪：一个 AE 会话里
// 两次 addProperty 只有**一行** params-setup-done（20:56 会话：exit cmd=4 一次、
// exit cmd=5 两次），即 PARAMS_SETUP **每会话一次**。新实例的参数初值一律取注册期
// 写入的 dephault（AE_Effect.h:416-423 明文：「the dephault field will still be used
// for initial value of the parameter when the effect is newly applied or reset」），
// 故参数路无法给每个新实例铸不同初值：dephault 写号值 → 全实例同号（20:39/20:51
// 会话实测两实例读回同值）；dephault 留 0 → 全 0。UPDATE_PARAMS_UI 里写值同样被
// AE 丢弃（plugin.cpp ui-idx-reconcile 段早有实测记载）。
//
// 【为什么序列数据可行】SEQUENCE_SETUP 按 SDK 契约「每次效果被应用到图层」都发
//（AE_Effect.h:1004-1008），真机日志核实（同一会话两次 addProperty → 两条 exit cmd=5）；
// 且 AE 13.5+ 的**渲染工程拷贝**会走 FLATTEN/RESETUP 把数据带给渲染克隆（真机日志：
// 每实例 SETUP→FLATTEN→RESETUP×2；AE_Effect.h:684-686 亦明说 FORCE_RERENDER/拷贝
// 会复制 sequence_data 状态到渲染工程）。这正是「独立实例分离 + 克隆接力」所需的
// 两条语义，SDK 的 Gamma_Table 样本就是这一形态（POD 结构、无需 flatten 标志）。
//
// 本结构是纯 POD（内部无指针悬挂）→ 天然已是 flat 数据，不需要
// PF_OutFlag_SEQUENCE_DATA_NEEDS_FLATTENING（该标志用于「句柄里挂着指针」的场景，
// 且一旦设置就必须同时支持 GET_FLATTENED_SEQUENCE_DATA——见 AE_Effect.h:844-845、
// 926）。AE 仍会在渲染工程拷贝时发 FLATTEN（真机日志可见），对 POD 是无副作用的
// 通知，plugin.cpp 只记日志不动所有权。
//
// 读取（customUI.cpp InstanceInstanceId）：优先 in_data->sequence_data；
// 渲染上下文它可能为 NULL —— AE_Effect.h:847-848 原文：
//   「sequence_data is read-only at render time and must be accessed with
//     PF_EffectSequenceDataSuite. in_data->sequence_data will be NULL during render.」
// → 退到 PF_EffectSequenceDataSuite::PF_GetConstSequenceData（13.5 引入、18.2 冻结版）。
// 取不到（返回 0）＝身份未知 → 调用方按「全实例共享谱系」的旧行为处理；
// 绝不拿 effect_ref 顶替（跨上下文会变，会破坏克隆接力，见 renderer.cpp 键控注释）。
#ifndef AS_EXTP_SEQ_IDENTITY_H
#define AS_EXTP_SEQ_IDENTITY_H

#include <cstdint>
#include <cstring>

namespace host {

// 魔数 "ASI1"（AS_ExtP Sequence Identity v1）：句柄内容可能来自任何历史路径，
// 读之前先验魔数，防把别的数据当身份用。
constexpr uint32_t kSeqIdentityMagic = 0x31495341u;

struct AsSeqIdentity {
    uint32_t magic;        // kSeqIdentityMagic
    uint32_t flatB;        // 1 = 已过 FLATTEN（POD 数据两者内容相同，仅供诊断）
    uint64_t instanceId;   // 24 位铸号（host::makeInstanceId），0 = 未设置/未知
};

inline void seqIdentityInit(AsSeqIdentity* s, uint64_t id, uint32_t flatB) {
    if (!s) return;
    s->magic = kSeqIdentityMagic;
    s->flatB = flatB;
    s->instanceId = id;
}

// 校验并取出 id。返回 false = 不是我们的结构（魔数不符/长度不足）；
// 返回 true 时 *outId 可能为 0（结构在但未铸号 → 调用方按未知处理）。
inline bool seqIdentityReadId(const void* bytes, uint32_t bytesLen, uint64_t* outId) {
    if (!bytes || bytesLen < sizeof(AsSeqIdentity)) return false;
    AsSeqIdentity s;
    std::memcpy(&s, bytes, sizeof(s));
    if (s.magic != kSeqIdentityMagic) return false;
    if (outId) *outId = s.instanceId;
    return true;
}

} // namespace host

#endif // AS_EXTP_SEQ_IDENTITY_H
