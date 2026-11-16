// test_solver_key_identity.cpp —— 结算谱系键「实例身份」混合的纯逻辑单测
//（不依赖 AE SDK / GL / Win32；内核实现见 src/solverKeyIdentity.h，renderer.cpp
//  solverParamHash 调用同一函数）。
//
// 缺陷链：谱系键若只有「图层身份 ⊕ 参数指纹」，同图层叠两个**同款同参** @solve
// 时，第二个实例直接命中第一个的帧缓存——它自己的输入被忽略（残差）。修复 = 把
// 「本实例身份」混进指纹；载体是**序列数据**（SEQUENCE_SETUP 每实例铸号，FLATTEN/
// RESETUP 随渲染工程拷贝接力——机制改判与真机取证见 src/seqIdentity.h）。
//
// 本测用生产代码（host::fnv1aMix / host::mixInstanceId，与 renderer.cpp 的
// mix lambda 同实现）构造与 solverParamHash 相同序列的指纹，钉住三件事：
//   a) 同参不同 id → 哈希不同（回退「去掉 id 混入」即红）；
//   b) 同 id 同参 → 哈希相同（克隆接力/重复渲染稳定，键不抖动）；
//   c) id=0 与 id=1 不同（0 是"参数缺失"哨兵，必须与非零身份区分）；
//   另钉：id 不是空混（混 id 与不混 id 的哈希不同）、大量 id 两两不同。
#undef NDEBUG
#include <cassert>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <set>

#include "solverKeyIdentity.h"

namespace {

// 与 renderer.cpp solverParamHash 相同的混合序列（源码 → dims → clock → 实例 id →
// 槽位值），只是把生产里的 lambda 换成单点内核 host::fnv1aMix。顺序与生产一致：
// id 在 dims/clock 之后、uniform 之前（见 solverParamHash 头注释）。
uint64_t fingerprint(const char* src, const float* vals, int n, uint64_t instanceId) {
    uint64_t h = host::kFnv1aOffset;
    h = host::fnv1aMix(h, src, std::strlen(src));
    const long dims[3] = {256, 256, 3};
    h = host::fnv1aMix(h, dims, sizeof(dims));
    const long clock[2] = {1, 30};
    h = host::fnv1aMix(h, clock, sizeof(clock));
    h = host::mixInstanceId(h, instanceId);   // ← 生产同款（renderer.cpp solverParamHash 同一调用）
    for (int i = 0; i < n; ++i) h = host::fnv1aMix(h, &vals[i], sizeof(float));
    return h;
}

// （不含 id 混入的对照指纹：证明 id 载荷有实效——去掉混入即与含 id 的哈希相同）
uint64_t fingerprintNoId(const char* src, const float* vals, int n) {
    uint64_t h = host::kFnv1aOffset;
    h = host::fnv1aMix(h, src, std::strlen(src));
    const long dims[3] = {256, 256, 3};
    h = host::fnv1aMix(h, dims, sizeof(dims));
    const long clock[2] = {1, 30};
    h = host::fnv1aMix(h, clock, sizeof(clock));
    for (int i = 0; i < n; ++i) h = host::fnv1aMix(h, &vals[i], sizeof(float));
    return h;
}

const char* kSrc = "void mainImage(out vec4 o, in vec2 uv){ o = vec4(uv,0.,1.); }";

// a) 同参不同实例 id → 哈希不同（判据：两个同款实例各走各的谱系）
void test_same_params_diff_id_differs() {
    const float vals[4] = {1.0f, 2.0f, 3.0f, 4.0f};
    const uint64_t hA = fingerprint(kSrc, vals, 4, 0x0000000000012345ull);
    const uint64_t hB = fingerprint(kSrc, vals, 4, 0x0000000000012346ull);
    assert(hA != hB);
    // 相邻 id、差 1 的最小差情形也必须分开（定长 8 字节混入，无粘连）
    assert(fingerprint(kSrc, vals, 4, 7) != fingerprint(kSrc, vals, 4, 8));
    std::cout << "PASS test_same_params_diff_id_differs\n";
}

// b) 同 id 同参 → 哈希相同（渲染克隆携带同一参数值 → 落同一条谱系、接力不失效；
//    同一帧重复渲染的键也必须稳定不抖动）
void test_same_id_same_params_equal() {
    const float vals[4] = {1.0f, 2.0f, 3.0f, 4.0f};
    const uint64_t id = 0x0000000000ABCDEFull;
    assert(fingerprint(kSrc, vals, 4, id) == fingerprint(kSrc, vals, 4, id));
    // 非 id 载荷变化仍必须改变哈希（id 混入不得吞掉其它载荷）
    const float other[4] = {1.0f, 2.0f, 3.0f, 5.0f};
    assert(fingerprint(kSrc, vals, 4, id) != fingerprint(kSrc, other, 4, id));
    std::cout << "PASS test_same_id_same_params_equal\n";
}

// c) id=0（参数缺失/旧工程哨兵）与 id=1 不同；且 id 载荷不是空混（含 id 与不含 id
//    的哈希不同——去掉混入行则 a) 与本节同时变红）
void test_zero_id_distinct_and_load_bearing() {
    const float vals[2] = {0.5f, -0.25f};
    assert(fingerprint(kSrc, vals, 2, 0) != fingerprint(kSrc, vals, 2, 1));
    assert(fingerprint(kSrc, vals, 2, 0) != fingerprintNoId(kSrc, vals, 2));
    assert(fingerprint(kSrc, vals, 2, 1) != fingerprintNoId(kSrc, vals, 2));
    std::cout << "PASS test_zero_id_distinct_and_load_bearing\n";
}

// d) 批量两两不同：0..255 全部 id 在同一参数下哈希两两不同（无意外定长截断/粘连）
void test_many_ids_pairwise_distinct() {
    const float vals[4] = {1.0f, 0.0f, 0.0f, 1.0f};
    std::set<uint64_t> seen;
    for (uint64_t id = 0; id < 256; ++id) {
        const uint64_t h = fingerprint(kSrc, vals, 4, id);
        assert(seen.insert(h).second);
    }
    // 大 id（接近 double 可精确表示上限 2^53 的邻居）同样可区分
    assert(fingerprint(kSrc, vals, 4, (1ull << 52)) !=
           fingerprint(kSrc, vals, 4, (1ull << 52) + 1));
    std::cout << "PASS test_many_ids_pairwise_distinct\n";
}

// e) 铸号规则：24 位、恒非零、同 tick 不同 seq 互不相同。
// 依据：AE 的 FLOAT_SLIDER 参数内部按 ~float32 精度存/取——实测 4.3e12 量级丢 ≥12 个
// 低位（两次 setValue/读回 993→992；两实例生成 id 读回同值），而 ≤2^24 的整数往返精确，
// 故 id 上限 = kInstanceIdMax（2^24-1）。本测钉住生成器与上界常量的一致性。
void test_instance_id_generation() {
    // 上界常量与「24 位」语义一致
    assert(host::kInstanceIdMax == 0xFFFFFFu);
    // 恒非零：含退化输入 tick=0/seq=0
    assert(host::makeInstanceId(0, 0) != 0);
    assert(host::makeInstanceId(0x3F400000ull, 0) != 0);
    // 全部取值落在 24 位内
    for (uint32_t s = 0; s < 4096; s += 127) {
        const uint32_t id = host::makeInstanceId(0x3F400000ull, s);
        assert(id >= 1 && id <= host::kInstanceIdMax);
    }
    // 同一 tick 内：不同 seq → 不同 id（同毫秒连续创建的两个实例必须分区）
    assert(host::makeInstanceId(0x1234ull, 5) != host::makeInstanceId(0x1234ull, 6));
    // 跨 tick：不同 tick → 不同 id（跨会话/进程重启）
    assert(host::makeInstanceId(0x1234ull, 5) != host::makeInstanceId(0x1235ull, 5));
    // 低 12 位 seq 满载时的两两不同（0..4095 全部互异；含 seq=0 → 0 映射到上界后的集合）
    std::set<uint32_t> seenId;
    for (uint32_t s = 0; s < 4096; ++s) assert(seenId.insert(host::makeInstanceId(0x3F400000ull, s)).second);
    // 与「接近 2^53」的旧方案对照：id 不再越过 float32 精确整数上界
    assert(host::makeInstanceId(0xFFFFFull, 0xFFFu) <= host::kInstanceIdMax);
    std::cout << "PASS test_instance_id_generation\n";
}

} // namespace

void runSolverKeyIdentityTests() {
    test_same_params_diff_id_differs();
    test_same_id_same_params_equal();
    test_zero_id_distinct_and_load_bearing();
    test_many_ids_pairwise_distinct();
    test_instance_id_generation();
    std::cout << "ALL SOLVER KEY IDENTITY (#14) TESTS PASSED\n";
}
