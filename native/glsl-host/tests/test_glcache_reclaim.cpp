// test_glcache_reclaim.cpp —— 名字缓存「假阳性真删回收」判据的纯逻辑单测
//（不依赖 AE SDK / GL / Win32；判据实现见 src/glCtxGenPolicy.h glCacheReclaimAllowed，
//  renderer.cpp 的代际消费点与各纹理缓存点调用同一函数）。
//
// 背景：上下文代际变化时非结算名字缓存（迭代/结算暂存/渲染目标/输入/映射与历史纹理）
// 仅置 0 不 glDelete*：真 TDR 下这是唯一正确做法（名字可能已被新上下文复用，
// 删名字会误删新上下文里的活对象）；但瞬时抖动（取回同一 HGLRC）时旧对象仍在活上下文
// 里无人引用 → 显存垃圾反复累积。判据三层：代际确实变了 ∧ 遗弃句柄 == 当前句柄 ∧
// 对象身份验证通过，三者全过才允许真删；任一不过 = 只置 0（TDR 安全路径）。
//
// 本测钉住全部分支：
//   · 真 TDR（句柄不同 / 遗弃句柄为空）→ 不回收（只置 0）；
//   · 同句柄但身份验证不过（名字已被复用/尺寸不符）→ 不回收；
//   · 代际未变 → 不回收（无事件，不该动缓存）；
//   · 同句柄 + 身份通过 → 允许回收。
#undef NDEBUG
#include <cassert>
#include <cstdint>
#include <iostream>

#include "glCtxGenPolicy.h"

namespace {

// 代际模型（与 renderer.cpp 一致）：名字缓存建立于 gen=G1；代际自增后消费于 gen=G2。
constexpr std::uint64_t kG1 = 7;   // 名字建立时的代际
constexpr std::uint64_t kG2 = 8;   // 代际自增后的当前代际
constexpr std::uintptr_t kRc = 0x5000;   // 同一上下文（假阳性抖动：遗弃句柄 == 当前句柄）

// ① 真 TDR：句柄换了（遗弃句柄 != 当前句柄）→ 只置 0，绝不 glDelete*
void test_real_tdr_never_reclaims() {
    assert(!host::glCacheReclaimAllowed(kG1, kG2, /*handleSame=*/false, /*identityOk=*/true));
    // 连身份验证都"看似通过"也不得回收（第一层否决优先——真 TDR 下名字可能被新
    // 上下文复用，身份验证通过只是巧合）
    std::cout << "PASS test_real_tdr_never_reclaims\n";
}

// ② 真 TDR 的另一形态：遗弃句柄为空（自建上下文新建，新 HGLRC 必与旧不同）→ 不回收
void test_real_tdr_null_abandoned() {
    // renderer 侧把 nullptr 解释为 handleSame=false（s_glCtxReclaimHandleSame 的赋值式），
    // 纯判据层面等价于 ①；此处再钉 false+false 的组合
    assert(!host::glCacheReclaimAllowed(kG1, kG2, false, false));
    std::cout << "PASS test_real_tdr_null_abandoned\n";
}

// ③ 同句柄（假阳性抖动）但对象身份验证不过（名字已被复用 / level0 尺寸不符 / 无基准）
//    → 只置 0（宁漏回收不误删）
void test_identity_veto_keeps_clear_only() {
    assert(!host::glCacheReclaimAllowed(kG1, kG2, /*handleSame=*/true, /*identityOk=*/false));
    std::cout << "PASS test_identity_veto_keeps_clear_only\n";
}

// ④ 代际未变（prevGen == curGen）：没有代际事件 → 不该动缓存（防御分支；生产调用点
//    都在"已确认代际变化"的分支内，纯函数仍必须自洽）
void test_no_gen_change_never_reclaims() {
    assert(!host::glCacheReclaimAllowed(kG1, kG1, true, true));
    std::cout << "PASS test_no_gen_change_never_reclaims\n";
}

// ⑤ 假阳性：句柄相等 + 身份通过 → 允许真删回收（修复本体：瞬时抖动的显存垃圾）
void test_false_positive_reclaims() {
    assert(host::glCacheReclaimAllowed(kG1, kG2, /*handleSame=*/true, /*identityOk=*/true));
    std::cout << "PASS test_false_positive_reclaims\n";
}

// ⑥ 回访序列（模型级复刻 renderer.cpp 消费点）：
//    自建上下文建立（gen=1，名字缓存随建）→ 连续重绑失败降级（gen=2，遗弃句柄=自建 rc，
//    消费点判 handleSame=false → 只置 0）→ 取回同一句柄的假阳性（gen=3，遗弃=rc，
//    handleSame=true + 身份通过 → 回收）——钉住"真 TDR 只置 0 / 抖动才回收"的分野。
void test_sequence_tdr_then_jitter() {
    std::uint64_t gen = 1;                    // 自建上下文建立
    const std::uint64_t namesGen = gen;       // 名字缓存建立
    std::uintptr_t abandoned = 0x9000;        // 遗弃句柄 = 原绑定 HGLRC
    ++gen;                                    // 降级自增（真失效：新上下文必不同）
    // 消费点：当前句柄（新自建 0xA000）!= 遗弃句柄 → 不回收
    assert(!host::glCacheReclaimAllowed(namesGen, gen, /*handleSame=*/false, true));
    // 之后的瞬时抖动：makeCurrent 失败达阈值自增（遗弃句柄 = 当前句柄 0xA000），
    // 随即重绑取回同一 0xA000 → handleSame=true + 身份通过 → 回收
    abandoned = 0xA000;
    const std::uint64_t genAfterJitter = ++gen;
    const bool handleSame = (abandoned == 0xA000);
    assert(host::glCacheReclaimAllowed(gen - 1, genAfterJitter, handleSame, true));
    std::cout << "PASS test_sequence_tdr_then_jitter\n";
}

} // namespace

void runGlCacheReclaimTests() {
    test_real_tdr_never_reclaims();
    test_real_tdr_null_abandoned();
    test_identity_veto_keeps_clear_only();
    test_no_gen_change_never_reclaims();
    test_false_positive_reclaims();
    test_sequence_tdr_then_jitter();
    std::cout << "ALL GLCACHE RECLAIM (#27) TESTS PASSED\n";
}
