// Release 构建（/DNDEBUG）会把 assert 编译为空操作——断言须保持生效
#undef NDEBUG
#include <cassert>
#include <cstring>
#include <iostream>
#include <string>
#include "fileSelLayout.h"

// —— 文件选择器 ARBITRARY_DATA v2 布局 ——
// 这是"索引位移"问题的修复载体：实例记住的是**文件名**而不是位置，库增删只改变
// "名字→位置"的映射，已有实例不再静默换成另一个 shader。布局错了会直接伤到
// 工程持久化（残破的名字 → 按名解析失败 → 渲染透传），故逐项钉死。

static void test_layout_size_and_init() {
    // 定长且无填充：填充字节会让 FLATTEN 写出未初始化数据、让 COMPARE 误报 NOT_EQUAL
    // （8 字节探针令牌使长度为 290；探针整批移除后回到 282。）
    assert(sizeof(host::FileSelHandle) == 282);
    assert(host::kFileSelV2Bytes == 282);
    assert(host::kFileSelV2ProbeBytes == 290);   // 探针版历史长度——反序列化兼容读取
    assert(host::kFileSelNameMax == 256);
    assert(host::kFileSelV1Bytes == 16);

    host::FileSelHandle h;
    std::memset(&h, 0xAB, sizeof(h));      // 先填垃圾，验证 init 真的清干净
    host::fileSelInit(h);
    assert(std::memcmp(h.magic, host::kFileSelMagic, sizeof(h.magic)) == 0);
    assert(h.nameLen == 0);
    assert(host::fileSelName(h).empty());
    for (int i = 0; i < 4; ++i) assert(h.v[i] == 0.0f);

    std::cout << "PASS test_file_sel_layout_size_and_init\n";
}

// 探针版历史布局（290B = 282 + 8B 令牌）兼容读：探针已整批移除，但工程若恰在
// 探针版下保存过，反序列化仍必须被接受、身份名照常恢复（多余令牌字节丢弃）。
static void test_probe_version_layout_compat() {
    // 造一份 290B 缓冲：前 282 字节是当前布局（含身份），尾部 8 字节填垃圾令牌
    host::FileSelHandle src;
    host::fileSelInit(src);
    host::fileSelSetIdentity(src, 3, "probe-era");
    char buf[host::kFileSelV2ProbeBytes];
    std::memcpy(buf, &src, sizeof(src));
    std::memset(buf + sizeof(src), 0xAB, sizeof(buf) - sizeof(src));   // 令牌字节（应被丢弃）
    host::FileSelHandle out;
    assert(host::fileSelDeserialize(buf, sizeof(buf), out));
    assert(out.v[0] == 3.0f);
    assert(host::fileSelName(out) == "probe-era");
    // 其他异常长度仍拒绝（如 290 之外的加长）
    assert(!host::fileSelDeserialize(buf, sizeof(buf) + 1, out));

    std::cout << "PASS test_probe_version_layout_compat\n";
}

static void test_identity_roundtrip_and_ui_state_preserved() {
    host::FileSelHandle h;
    host::fileSelInit(h);
    // UI 会话态：v[1] = 展开、v[2] = 滚动。写身份时**必须保留**——否则用户一改
    // 索引，选择器的展开/滚动就跟着被抹掉。
    h.v[1] = 1.0f;
    h.v[2] = 7.0f;

    host::fileSelSetIdentity(h, 13, "lightball");
    assert(h.v[0] == 13.0f);
    assert(host::fileSelName(h) == "lightball");
    assert(h.v[1] == 1.0f);      // 展开未被清
    assert(h.v[2] == 7.0f);      // 滚动未被清
    assert(std::memcmp(h.magic, host::kFileSelMagic, sizeof(h.magic)) == 0);

    // 索引可负（-1 = 未选中），名字可空（= 无身份，调用方按位置回退）
    host::fileSelSetIdentity(h, -1, "");
    assert(h.v[0] == -1.0f);
    assert(host::fileSelName(h).empty());
    assert(h.v[1] == 1.0f && h.v[2] == 7.0f);   // 仍保留

    std::cout << "PASS test_file_sel_identity_roundtrip_and_ui_state_preserved\n";
}

static void test_name_edge_cases() {
    // 超长名字：截断而非越界（库里理论上不会出现，但外部数据可能）
    host::FileSelHandle h;
    host::fileSelInit(h);
    const std::string huge(host::kFileSelNameMax + 64, 'x');
    host::fileSelSetIdentity(h, 0, huge);
    assert(host::fileSelName(h).size() == host::kFileSelNameMax);

    // 非 ASCII（中文名）：按字节原样往返，不做任何转码
    host::fileSelSetIdentity(h, 2, "光球");
    assert(host::fileSelName(h) == "光球");
    assert(h.nameLen == 6);   // UTF-8：每字 3 字节

    // 名字里的 NUL 不是终止符：长度说了算（构造一个含 NUL 的字节串）
    const std::string withNul("a\0b", 3);
    host::fileSelSetIdentity(h, 3, withNul);
    assert(host::fileSelName(h).size() == 3);
    assert(host::fileSelName(h) == withNul);

    std::cout << "PASS test_file_sel_name_edge_cases\n";
}

static void test_deserialize_v1_upgrade() {
    // v1（旧工程）= 16 字节 4 个 float。升级后必须**保留索引**、身份为空——
    // 老工程行为与改动前一致（按位置解释），首次改索引时由宿主捕获身份。
    float v1[4] = {13.0f, 1.0f, 7.0f, 0.0f};
    host::FileSelHandle h;
    const bool ok = host::fileSelDeserialize(v1, sizeof(v1), h);
    assert(ok);
    assert(h.v[0] == 13.0f);
    assert(h.v[1] == 1.0f && h.v[2] == 7.0f);
    assert(host::fileSelName(h).empty());
    assert(std::memcmp(h.magic, host::kFileSelMagic, sizeof(h.magic)) == 0);

    std::cout << "PASS test_file_sel_deserialize_v1_upgrade\n";
}

static void test_deserialize_v2_and_invalid() {
    // v2 完整往返
    host::FileSelHandle src;
    host::fileSelInit(src);
    src.v[1] = 1.0f;
    host::fileSelSetIdentity(src, 4, "ocean");
    host::FileSelHandle out;
    assert(host::fileSelDeserialize(&src, sizeof(src), out));
    assert(out.v[0] == 4.0f);
    assert(host::fileSelName(out) == "ocean");
    assert(out.v[1] == 1.0f);

    // 长度异常（既不是 v1 也不是 v2）→ 无效 + 全零，不把垃圾当名字
    char junk[64];
    std::memset(junk, 0x7F, sizeof(junk));
    host::FileSelHandle bad;
    assert(!host::fileSelDeserialize(junk, sizeof(junk), bad));
    assert(bad.nameLen == 0 && host::fileSelName(bad).empty());
    assert(bad.v[0] == 0.0f);

    // 长度对但魔数不符 → 无效 + 全零
    char wrong[sizeof(host::FileSelHandle)];
    std::memset(wrong, 0x5A, sizeof(wrong));
    assert(!host::fileSelDeserialize(wrong, sizeof(wrong), bad));
    assert(host::fileSelName(bad).empty());

    // 空指针 → 无效
    assert(!host::fileSelDeserialize(nullptr, sizeof(host::FileSelHandle), bad));

    std::cout << "PASS test_file_sel_deserialize_v2_and_invalid\n";
}

// 版本字段（v[3]）必须落成偶数：seqlock 用"奇数 = 写者入场"，一旦是奇数，
// 读者会永远认为写者正在写 → 身份读取恒失败 → 静默退回位置解释（= 修复失效）。
// v1 布局里 v[3] 无人使用、只碰巧是 0；外部异常数据也可能带奇数 → 反序列化须归一化。
static void test_version_field_normalized_even() {
    auto isOdd = [](const host::FileSelHandle& h) {
        uint32_t v = 0;
        std::memcpy(&v, &h.v[3], sizeof(v));
        return (v & 1u) != 0u;
    };

    // ① v1 升级路径：故意把第 4 个 float 放成奇数位模式
    float v1[4] = {7.0f, 1.0f, 0.0f, 0.0f};
    uint32_t odd = 3;
    std::memcpy(&v1[3], &odd, sizeof(odd));
    host::FileSelHandle h;
    assert(host::fileSelDeserialize(v1, sizeof(v1), h));
    assert(!isOdd(h));
    assert(h.v[0] == 7.0f);          // 索引仍保留

    // ② v2 路径：手改版本为奇数后落盘再读回
    host::FileSelHandle src;
    host::fileSelInit(src);
    host::fileSelSetIdentity(src, 2, "abc");
    odd = 5;
    std::memcpy(&src.v[3], &odd, sizeof(odd));
    host::FileSelHandle out;
    assert(host::fileSelDeserialize(&src, sizeof(src), out));
    assert(!isOdd(out));
    assert(host::fileSelName(out) == "abc");   // 名字不受影响

    std::cout << "PASS test_file_sel_version_field_normalized_even" << (char)10;
}

// PF_Arbitrary_COMPARE_FUNC 的内容比较（fileSelEqual）：**排除 v[3] seqlock 版本号**。
// 整块 memcmp 时：WriteFileSelSelection 每次让版本 ±2 → "内容完全相同、只被重写过
// 一次"的两个句柄被报 NOT_EQUAL，AE 据此做多余的重建/刷新（无功能损失但纯噪声）。
// 其余字节必须照旧参与比较——尤其是 v[0] 索引与名字（内容语义）与 v[1]/v[2]
// 展开/滚动（UI 会话态，改动前的比较行为就是这样）。
static void test_compare_excludes_seqlock_version() {
    host::FileSelHandle a, b;
    host::fileSelInit(a);
    host::fileSelInit(b);
    host::fileSelSetIdentity(a, 5, "ocean");
    host::fileSelSetIdentity(b, 5, "ocean");
    assert(host::fileSelEqual(a, b));               // 同内容同版本
    // 只改版本（模拟另一个句柄被写过一次：偶数→偶数，模拟写者入场：奇数）
    uint32_t ver = 0;
    std::memcpy(&ver, &a.v[3], sizeof(ver));
    ver += 2;                                       // 偶数 → 偶数（写者完成一次）
    std::memcpy(&b.v[3], &ver, sizeof(ver));
    assert(host::fileSelEqual(a, b));               // 版本不同、内容相同 → 仍相等
    ver |= 1u;                                      // 奇数 = 写者入场
    std::memcpy(&b.v[3], &ver, sizeof(ver));
    assert(host::fileSelEqual(a, b));               // 版本奇偶也不参与内容比较

    // 内容差异必须被检出：索引 / 名字 / 名字长度 / 展开滚动（v[1]、v[2]）
    host::FileSelHandle c = a;
    c.v[0] = 6.0f;
    assert(!host::fileSelEqual(a, c));
    c = a;
    host::fileSelSetIdentity(c, 5, "lightball");
    assert(!host::fileSelEqual(a, c));
    c = a;
    c.nameLen = 0;                                  // 名字长度参与比较
    assert(!host::fileSelEqual(a, c));
    c = a;
    c.v[1] = 1.0f;                                  // 展开态：改动前整块 memcmp 即会报不等
    assert(!host::fileSelEqual(a, c));
    c = a;
    c.v[2] = 7.0f;                                  // 滚动位置：同上
    assert(!host::fileSelEqual(a, c));
    c = a;
    c.magic[7] = 'X';                               // 魔数翻转 → 不等
    assert(!host::fileSelEqual(a, c));
    // 名字缓冲尾部的垃圾字节也参与比较（pack(1) 布局下不应存在，但外部数据可能带）
    c = a;
    c.name[host::kFileSelNameMax - 1] = 'z';
    assert(!host::fileSelEqual(a, c));

    std::cout << "PASS test_file_sel_compare_excludes_seqlock_version\n";
}

void runFileSelLayoutTests() {
    test_layout_size_and_init();
    test_probe_version_layout_compat();   // 探针版 290B 历史布局兼容读（令牌已移除）
    test_identity_roundtrip_and_ui_state_preserved();
    test_name_edge_cases();
    test_deserialize_v1_upgrade();
    test_deserialize_v2_and_invalid();
    test_version_field_normalized_even();
    test_compare_excludes_seqlock_version();
    std::cout << "ALL file selection layout tests passed\n";
}
