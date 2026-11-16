#pragma once
// solverKeyIdentity.h —— 结算谱系「实例身份」混入的哈希内核（纯逻辑，不依赖 AE/GL/Win32）。
//
// 实例身份混入的意义：同图层两个**同款同参** @solve 实例若共享谱系键
//（键 = 图层身份 ⊕ 参数指纹），第二个实例直接命中第一个的帧缓存（残差）。修法 =
// 把「本实例身份」（隐藏参数 kIdxInstanceId，**per-instance**）定长混进参数指纹：
//   · 同参、不同实例 id → 哈希不同 → 各走各的谱系（残差修掉）；
//   · 同一实例的渲染克隆（AE 复制普通参数值）→ 同 id → 哈希相同 → 接力不失效；
//   · 用户 duplicate() 出来的实例继承源 id → 哈希相同 → 与今日一致（共享）。
// 身份走高精度参数而非 ARBITRARY 句柄/effect_ref——理由见 params.h kIdxInstanceId
// 的探针定论注释。
//
// 本头文件是 renderer.cpp solverParamHash / mixSolverGen 的哈希内核（FNV-1a 64）的
// 单点实现：抽出后「id 不同 → 哈希不同 / id 相同 → 哈希相同 / id=0 与 id=1 不同」
// 可由单测（tests/test_solver_key_identity.cpp）调用**生产同一函数**钉住，而不是在
// 测试里另抄一份循环。renderer.cpp 侧以 fnv1aMix 为通用混入原语、以 mixInstanceId
// 定长混入实例 id（源码字面即 fnv1aMix(&instanceId, sizeof(instanceId))）。
#include <cstddef>
#include <cstdint>

namespace host {

// —— 实例 id 的取值约束 ——
// 载体是 AE 的 FLOAT_SLIDER 参数。SDK 里 PF_FpLong 是 double，但**真机实测**：
// AE 对该参数类型内部按 float32 存/取——52 位 id 往返后低位被舍入（实测两实例读回
// 同一个 `0x3F4…00000000` 形态的值，低 19 位被抹平，实例身份失效）。float32 能
// **精确表示** 2^24 以内的整数，故 id 限制在 24 位：
//   · 同一图层实例数极少，n 个实例的碰撞概率 ~n²/2^25（可忽略）；
//   · 同一次铸号内（同 tick）靠计数器低 12 位区分，跨会话靠 tick 低 12 位区分；
//   · 恒非零（0 是「读不到」的哨兵，见 plugin.cpp PARAMS_SETUP）。
constexpr uint32_t kInstanceIdMax = 0xFFFFFFu;   // 2^24-1：AE float 参数可精确表示的上界

inline uint32_t makeInstanceId(uint64_t tickLow12, uint32_t seqLow12) {
    uint32_t id = (static_cast<uint32_t>(tickLow12 & 0xFFFu) << 12) | (seqLow12 & 0xFFFu);
    // 0 是「读不到」哨兵 → 映射到空间**上界**而非 1：映到 1 会与 seq==1 的合法 id 撞号
    //（单测钉住 0..4095 全扫两两不同；此映射的撞号概率 1/2^24，且只发生在退化输入）。
    if (id == 0) id = kInstanceIdMax;
    return id;
}

// FNV-1a 64 的偏移基与质数（与 renderer.cpp 既有取值一致；改这里即改全局）。
constexpr uint64_t kFnv1aOffset = 1469598103934665603ull;
constexpr uint64_t kFnv1aPrime  = 1099511628211ull;

// 把一个字节块续混进哈希（renderer.cpp 的 mix lambda / mixSolverGen 即此实现）。
inline uint64_t fnv1aMix(uint64_t h, const void* p, size_t n) {
    const unsigned char* b = static_cast<const unsigned char*>(p);
    for (size_t i = 0; i < n; ++i) {
        h ^= b[i];
        h *= kFnv1aPrime;
    }
    return h;
}

// 定长混入实例身份（8 字节原样，renderer.cpp 的 solverParamHash 就在 dims/clock 之后
// 调本函数）。定长编码保证无歧义：id=0 与 id=1 必然产出不同哈希，也不会与前后任何
// 负载（源码字节串 / 槽位值 / 通道身份）粘连产生同哈希。
inline uint64_t mixInstanceId(uint64_t h, uint64_t instanceId) {
    return fnv1aMix(h, &instanceId, sizeof(instanceId));
}

} // namespace host
