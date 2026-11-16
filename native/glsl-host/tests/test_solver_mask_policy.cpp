// test_solver_mask_policy.cpp —— 时变掩码三态更新策略单测（纯逻辑，无 AE 依赖）。
//
// 覆盖：
//   · 判定为时变 → 置位（关键帧驱动的基础路径）
//   · 判定成功且静态 → 清位（本修复核心：删光关键帧后回落静态 → 指纹标记字节变化 →
//     谱系键变 → 重解一次；此后静态值进指纹，改值即重解——修「改静态值不重解」）
//   · 判定失败/不可得（两个掩码都不置位）→ 沿用上次（sticky，防指纹振荡）
//   · 重合输入的公式鲁棒性
#undef NDEBUG
#include <cassert>
#include <cstdint>
#include <iostream>

#include "solverMaskPolicy.h"

static void test_set_on_varying() {
    // ① 判定为时变 → 置位（静态不置位）
    assert(host::updateVaryingMaskSticky(0u, 0b0100u, 0u) == 0b0100u);
}

static void test_clear_on_static_confirmed() {
    // ② 判定成功且静态 → 清位（核心）
    assert(host::updateVaryingMaskSticky(0b0100u, 0u, 0b0100u) == 0u);
}

static void test_sticky_on_probe_failure() {
    // ③ 判定失败（两掩码都不置位）→ 沿用上次（sticky，防指纹振荡）
    assert(host::updateVaryingMaskSticky(0b0101u, 0u, 0u) == 0b0101u);
}

static void test_mixed_slots() {
    // ④ 混合：一个槽置位、一个槽清位、一个槽沿用
    assert(host::updateVaryingMaskSticky(0b1011u, 0b0100u, 0b0001u) == 0b1110u);
    // ⑤ 对静态槽重复确认静态 → 幂等保持 0
    assert(host::updateVaryingMaskSticky(0u, 0u, 0b1111u) == 0u);
    // ⑥ 同一位同时被置位与确认静态（理论不应发生）→ 清位优先（公式对重合输入安全）
    assert(host::updateVaryingMaskSticky(0u, 0b0010u, 0b0010u) == 0u);
}

static void test_session_sequence_regression() {
    // ⑦ 会话序列： 现场——打关键帧（时变）→ AEGP 失败一次 → 删光关键帧（确认静态）
    uint32_t mask = 0;
    mask = host::updateVaryingMaskSticky(mask, 0b0001u, 0u);
    assert(mask == 0b0001u);
    mask = host::updateVaryingMaskSticky(mask, 0u, 0u);
    assert(mask == 0b0001u);   // sticky 兜底：中途判定失败不得抖动
    mask = host::updateVaryingMaskSticky(mask, 0u, 0b0001u);
    assert(mask == 0u);        // 删关键帧 → 回落静态 → 值进指纹 → 改值即重解
}

void runSolverMaskPolicyTests() {
    test_set_on_varying();
    test_clear_on_static_confirmed();
    test_sticky_on_probe_failure();
    test_mixed_slots();
    test_session_sequence_regression();
    std::cout << "ALL SOLVER MASK POLICY (#15) TESTS PASSED\n";
}
