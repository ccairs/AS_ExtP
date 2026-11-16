// test_seq_identity.cpp —— 实例身份载体（序列数据）的纯逻辑单测
//（不依赖 AE SDK / GL / Win32；实现见 src/seqIdentity.h，plugin.cpp 的
//  SEQUENCE_SETUP/RESETUP 与 customUI.cpp InstanceInstanceId 调用同一组函数）。
//
// 背景（机制改判，真机取证见 seqIdentity.h 头注释）：身份原走隐藏参数，但
// PARAMS_SETUP 每会话只发一次 → 新实例初值一律取注册期 dephault → 参数路给不出
// 「每实例不同」的初值。载体改为序列数据：SEQUENCE_SETUP 每实例铸号、FLATTEN/
// RESETUP 随渲染工程拷贝接力。本测钉住读侧契约（写侧在 plugin.cpp，逻辑仅
// init/read 两个纯函数）：
//   a) 合法结构读回原 id（渲染克隆拿到同一份字节 = 同一身份）；
//   b) 魔数不符/长度不足/空指针 → 读失败（绝不把别的数据当身份）；
//   c) id=0 的结构「有效但未知」——读成功且返回 0（调用方按共享谱系旧行为）；
//   d) 布局稳定：sizeof = 16（工程持久化字节，改布局必须换魔数）；
//   e) 两实例各自铸号（不同 id）读回后仍互异（残差修复在数据层的判据）。
#undef NDEBUG
#include <cassert>
#include <cstdint>
#include <cstring>
#include <iostream>

#include "seqIdentity.h"
#include "solverKeyIdentity.h"   // kInstanceIdMax（铸号上界，与 makeInstanceId 同口径）

namespace {

// a) 合法结构：init 后读回原 id（含 24 位满量程边界）
void test_roundtrip_valid() {
    host::AsSeqIdentity s;
    host::seqIdentityInit(&s, 0x00ABCDEFull, 0);
    uint64_t id = 0;
    assert(host::seqIdentityReadId(&s, sizeof(s), &id));
    assert(id == 0x00ABCDEFull);
    // 上界（kInstanceIdMax = 2^24-1，与 makeInstanceId 同口径）
    host::seqIdentityInit(&s, host::kInstanceIdMax, 0);
    assert(host::seqIdentityReadId(&s, sizeof(s), &id) && id == host::kInstanceIdMax);
    // flat 标志不影响 id 读取（POD 数据两种形态内容相同）
    host::seqIdentityInit(&s, 42, 1);
    assert(host::seqIdentityReadId(&s, sizeof(s), &id) && id == 42);
    std::cout << "PASS test_roundtrip_valid\n";
}

// b) 坏输入：空指针 / 长度不足 / 魔数不符 → 读失败（写侧不该出现，出现即防住）
void test_read_rejects_garbage() {
    uint64_t id = 0xDEADBEEFull;
    assert(!host::seqIdentityReadId(nullptr, 16, &id));
    host::AsSeqIdentity s;
    host::seqIdentityInit(&s, 7, 0);
    assert(!host::seqIdentityReadId(&s, sizeof(s) - 1, &id));   // 长度不足
    assert(!host::seqIdentityReadId(&s, 0, &id));
    std::memset(&s, 0, sizeof(s));                              // 全零（未初始化句柄）
    assert(!host::seqIdentityReadId(&s, sizeof(s), &id));
    s.magic = host::kSeqIdentityMagic ^ 0x1u;                   // 魔数差一位
    assert(!host::seqIdentityReadId(&s, sizeof(s), &id));
    // 读失败时不写 outId（调用方先置 0，不会被污染）
    assert(id == 0xDEADBEEFull);
    std::cout << "PASS test_read_rejects_garbage\n";
}

// c) id=0 的占位结构：结构有效但身份未知（调用方按共享谱系旧行为，不误判为坏数据）
void test_zero_id_is_valid_but_unknown() {
    host::AsSeqIdentity s;
    host::seqIdentityInit(&s, 0, 1);   // 退化情形写下的占位（RESETUP 数据缺失）
    uint64_t id = 0xFFFFull;
    assert(host::seqIdentityReadId(&s, sizeof(s), &id));
    assert(id == 0);
    std::cout << "PASS test_zero_id_is_valid_but_unknown\n";
}

// d) 布局与魔数：16 字节定长（4+4+8，无隐式填充歧义）；魔数钉字面量（改魔数 =
//    旧工程序列数据失配 → 必须是有意为之的版本升级）
void test_layout_and_magic_pinned() {
    assert(sizeof(host::AsSeqIdentity) == 16);
    assert(host::kSeqIdentityMagic == 0x31495341u);   // "ASI1" 小端字节序读出
    const unsigned char* b = reinterpret_cast<const unsigned char*>(&host::kSeqIdentityMagic);
    assert(b[0] == 'A' && b[1] == 'S' && b[2] == 'I' && b[3] == '1');
    std::cout << "PASS test_layout_and_magic_pinned\n";
}

// e) 两实例各自铸号 → 两个结构里的 id 互异（数据层判据）
void test_two_instances_distinct() {
    host::AsSeqIdentity a, b;
    host::seqIdentityInit(&a, 1001, 0);
    host::seqIdentityInit(&b, 1002, 0);
    uint64_t idA = 0, idB = 0;
    assert(host::seqIdentityReadId(&a, sizeof(a), &idA));
    assert(host::seqIdentityReadId(&b, sizeof(b), &idB));
    assert(idA != idB && idA > 0 && idB > 0);
    std::cout << "PASS test_two_instances_distinct\n";
}

} // namespace

void runSeqIdentityTests() {
    test_roundtrip_valid();
    test_read_rejects_garbage();
    test_zero_id_is_valid_but_unknown();
    test_layout_and_magic_pinned();
    test_two_instances_distinct();
    std::cout << "ALL SEQ IDENTITY (#14) TESTS PASSED\n";
}
