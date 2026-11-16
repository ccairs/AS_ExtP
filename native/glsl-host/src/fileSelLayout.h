#pragma once
// fileSelLayout.h —— 文件选择器 ARBITRARY_DATA 的持久化布局（v1 / v2）
//
// 为什么需要 v2：v1 只存 4 个 float，其中 v[0] 是**位置索引**。库增删会让排序后的
// 位置整体位移，于是工程里已用着的实例会静默换成另一个 shader（本项目已实测复现：
// 放入一个排序靠前的新文件后，原索引 13 从 lightball 变成 erro）。修法是让实例
// 记住**身份**（文件名），渲染时按名解析——位置怎么变都不影响已有实例。
//
// 名字只能存在这里：AE 效果参数没有字符串类型（AE_Effect.h:358-382 枚举），
// PF_Param_PATH 是图层蒙版路径而非文件选择器（:1837-1842），而隐藏索引参数量程
// 仅 0..9999（实测），装不下可用的哈希。
//
// 本文件**不依赖 AE SDK**：布局与序列化是纯字节逻辑，独立成头后单测可直接覆盖；
// customUI.cpp 只负责锁住 handle 后把字节 memcpy 进出。
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>

namespace host {

// v1（历史布局，16B）：只有 4 个 float，v[0] = 位置索引，无身份。
constexpr size_t kFileSelV1Bytes = sizeof(float) * 4;

// v2 名字上限（字节，UTF-8，不含扩展名）。与 struct 内缓冲同长。
constexpr size_t kFileSelNameMax = 256;

// v2 布局字节数（魔数 + 4 float + 名字长度 + 名字缓冲）。
constexpr size_t kFileSelV2Bytes = 8 + 16 + 2 + kFileSelNameMax;

// 探针版历史布局（290B：本布局 + 8 字节实例令牌）——
// 令牌随克隆探针整批移除，但工程若恰在探针版下保存过，这里仍兼容读取：
// 只取前 kFileSelV2Bytes 字节（令牌丢弃），身份名不丢。
constexpr size_t kFileSelV2ProbeBytes = kFileSelV2Bytes + 8;

// v2 魔数：8 字节定长，不做 NUL 终止（按定长比较）
inline constexpr char kFileSelMagic[8] = {'A', 'S', 'S', 'L', 'S', 'E', 'L', '2'};

// pack(1) 是必须的：默认对齐会在 uint16 之后补 2 字节填充，而填充字节
// ① 会让 FLATTEN 写出未初始化数据（同一实例两次落盘字节不同）；
// ② 会让 COMPARE 的 memcmp 因垃圾填充误报 NOT_EQUAL，AE 可能据此判定参数已变。
#pragma pack(push, 1)
struct FileSelHandle {
    char     magic[8];      // [0..7]    kFileSelMagic
    float    v[4];          // [8..23]   v[0] = 位置索引（保留：只读 f[0] 的既有路径 + 并发回退）
    uint16_t nameLen;       // [24..25]  名字字节数（0 = 无身份 → 调用方按位置回退）
    char     name[kFileSelNameMax];   // [26..281] UTF-8，不含扩展名，无 NUL
};
#pragma pack(pop)



static_assert(sizeof(FileSelHandle) == 8 + 16 + 2 + kFileSelNameMax,
              "FileSelHandle 必须无填充（见上方 pack(1) 说明）");

// 全零 + 写魔数。所有写入路径都从这里开始，保证填充/尾部字节确定。
inline void fileSelInit(FileSelHandle& h) {
    std::memset(&h, 0, sizeof(h));
    std::memcpy(h.magic, kFileSelMagic, sizeof(h.magic));
}

// 写选中项：索引 + 身份名。**保留 v[1..3]**（v[1] = 展开、v[2] = 滚动，是纯 UI
// 会话态；清零会把选择器的展开/滚动状态一起抹掉，用户会看到刚改索引就折叠回去）。
// 并发约定（读者是渲染线程）：名字字节先写，长度**最后**写并带 release 栅栏——
// 读者若读到新长度，其前面的字节必然已就位（x86 存储有序 + 栅栏），故不会出现
// "长度是新的、名字是半截旧的"这种撕裂；读到旧长度则整体回退到旧身份，无害。
inline void fileSelSetIdentity(FileSelHandle& h, int index, const std::string& name) {
    std::memcpy(h.magic, kFileSelMagic, sizeof(h.magic));
    h.v[0] = static_cast<float>(index);
    size_t n = name.size();
    if (n > kFileSelNameMax) n = kFileSelNameMax;   // 截断而非越界
    if (n) std::memcpy(h.name, name.data(), n);
    std::atomic_thread_fence(std::memory_order_release);
    h.nameLen = static_cast<uint16_t>(n);
}

// 内容比较（AE 的 PF_Arbitrary_COMPARE_FUNC 用）：
// **排除 v[3]（seqlock 版本号）**——
// 版本号是并发协议的内部状态而非用户可见内容：每次 WriteFileSelSelection 都让它
// ±2，整块 memcmp 会把"内容完全相同、只被人重写过一次"的句柄报成 NOT_EQUAL，
// AE 据此判参数已变、做多余的重建/刷新（无功能损失但纯属噪声）。
// 其余字节（魔数 / v[0] 索引 / v[1..2] 展开滚动 / nameLen / 名字）全部参与比较：
// v[1]/v[2] 是选择器 UI 会话态，会随用户展开/滚动变化，比较结果与改动前一致。
// 写者入场（版本号为奇数）时 nameLen/名字可能半新半旧——比较会报 NOT_EQUAL，
// 与旧行为相同（保守方向：宁可多报一次变化）。
inline bool fileSelEqual(const FileSelHandle& a, const FileSelHandle& b) {
    // v[3] 位于 [20..23]（magic 8 + v[0..2] 12）；其余分两段逐字节比较
    constexpr size_t kVerOff = offsetof(FileSelHandle, v) + 3 * sizeof(float);
    static_assert(kVerOff == 20, "v[3] 偏移变化需同步本函数与 pack(1) 布局");
    return std::memcmp(&a, &b, kVerOff) == 0 &&
           std::memcmp(reinterpret_cast<const char*>(&a) + kVerOff + sizeof(float),
                       reinterpret_cast<const char*>(&b) + kVerOff + sizeof(float),
                       sizeof(FileSelHandle) - kVerOff - sizeof(float)) == 0;
}

// 读身份名。nameLen 越界（外部数据损坏）时按缓冲上限裁剪。
inline std::string fileSelName(const FileSelHandle& h) {
    std::atomic_thread_fence(std::memory_order_acquire);
    size_t n = h.nameLen;
    if (n > kFileSelNameMax) n = kFileSelNameMax;
    return std::string(h.name, n);
}

// 反序列化（UNFLATTEN 用）：
//   长度 16  → v1，升级为 v2（只保留索引，身份为空 → 旧工程按位置解释，首次索引
//              变更时由宿主捕获身份自动升级）
//   长度 282 → v2，校验魔数
//   长度 290 → 探针版 v2（282 + 8B 令牌）：只取前 282 字节，身份照常恢复
//   其它长度 → 视为无效（返回 false，调用方给全零 handle）
inline bool fileSelDeserialize(const void* buf, size_t len, FileSelHandle& out) {
    fileSelInit(out);
    if (!buf) return false;
    if (len == kFileSelV1Bytes) {
        std::memcpy(out.v, buf, kFileSelV1Bytes);
        out.v[3] = 0.0f;      // 版本字段归一化为偶数，见下方 acquire 语义
        return true;
    }
    if (len != sizeof(FileSelHandle) && len != kFileSelV2ProbeBytes) return false;
    // 探针版长度（290 > sizeof）只拷本布局的字节数：多余令牌字节丢弃。
    const size_t copyLen = (len < sizeof(FileSelHandle)) ? len : sizeof(FileSelHandle);
    std::memcpy(&out, buf, copyLen);
    if (std::memcmp(out.magic, kFileSelMagic, sizeof(out.magic)) != 0) {
        fileSelInit(out);     // 魔数不符：当无效处理，避免把垃圾当名字
        return false;
    }
    // 版本字段（v[3]）必须落成偶数：seqlock 用"奇数 = 写者入场"，一旦是奇数
    // 就永远读不到身份（静默退回位置解释）。v1 布局里 v[3] 无人使用、只碰巧是 0，
    // 外部异常数据也可能带奇数 → 这里统一归一化。
    {
        uint32_t ver = 0;
        std::memcpy(&ver, &out.v[3], sizeof(ver));
        if (ver & 1u) { ver = 0; std::memcpy(&out.v[3], &ver, sizeof(ver)); }
    }
    return true;
}

} // namespace host
