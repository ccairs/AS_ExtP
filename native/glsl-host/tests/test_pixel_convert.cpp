// 像素转换的等价性测试
//
// 被守护的事实：pixelConvert.cpp 的向量路径与"逐像素标量"语义**逐位一致**。
// 标量参照直接写在本文件里（就是抽出前的 renderer.cpp 实现，逐字保留），
// 因此本测试同时是这份语义的规格说明——改 pixelConvert.cpp 先跑它。
//
// 覆盖：
//   · 三档位深（8/16/32bit）× 上传（AE world → RGBA float）/ 回写（反之）
//   · 宽度非 4 倍数的尾段（1/2/3/5/7/13/63 等）、高度 1 与多行
//   · 翻转：源第 0 行必须出现在目的最后一行
//   · 行距 > 宽度×像素字节（AE 实际会有 rowbytes 填充）
//   · 边界值：0 / 满格 / 半格（v*255 = x.5 的平局）/ 负值 / 超 1.0 / NaN
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <cmath>
#include <vector>
#include <algorithm>

#undef NDEBUG   // Release（/DNDEBUG）会把 assert 编译成空操作，断言必须保持生效
#include <cassert>
#include "../src/pixelConvert.h"
#include "../src/solverSchedule.h"

// ── 标量参照：抽出前 renderer.cpp 的实现（逐字保留）─────────────────────────
namespace ref {

using host::PixelDepth;

static inline unsigned char clamp8(float v) {
    if (v < 0.0f) v = 0.0f; else if (v > 1.0f) v = 1.0f;
    return static_cast<unsigned char>(v * 255.0f + 0.5f);
}
static inline unsigned short clamp16(float v) {
    if (v < 0.0f) v = 0.0f; else if (v > 1.0f) v = 1.0f;
    return static_cast<unsigned short>(v * 32768.0f + 0.5f);
}

void convert(const void* src, int32_t rowbytes, int32_t W, int32_t H,
             PixelDepth depth, std::vector<float>& rgba) {
    const unsigned char* inPix = static_cast<const unsigned char*>(src);
    rgba.assign(static_cast<size_t>(W) * H * 4, 0.0f);
    if (depth == PixelDepth::Bits32) {
        for (int32_t y = 0; y < H; ++y) {
            const int32_t sy = H - 1 - y;
            const float* row = reinterpret_cast<const float*>(inPix + static_cast<size_t>(sy) * rowbytes);
            float* dst = rgba.data() + static_cast<size_t>(y) * W * 4;
            for (int32_t x = 0; x < W; ++x) {
                dst[x * 4 + 0] = row[x * 4 + 1];
                dst[x * 4 + 1] = row[x * 4 + 2];
                dst[x * 4 + 2] = row[x * 4 + 3];
                dst[x * 4 + 3] = row[x * 4 + 0];
            }
        }
    } else if (depth == PixelDepth::Bits16) {
        for (int32_t y = 0; y < H; ++y) {
            const int32_t sy = H - 1 - y;
            const unsigned short* row = reinterpret_cast<const unsigned short*>(
                inPix + static_cast<size_t>(sy) * rowbytes);
            float* dst = rgba.data() + static_cast<size_t>(y) * W * 4;
            for (int32_t x = 0; x < W; ++x) {
                const unsigned short* p = row + static_cast<size_t>(x) * 4;
                dst[x * 4 + 0] = p[1] / 32768.0f;
                dst[x * 4 + 1] = p[2] / 32768.0f;
                dst[x * 4 + 2] = p[3] / 32768.0f;
                dst[x * 4 + 3] = p[0] / 32768.0f;
            }
        }
    } else {
        for (int32_t y = 0; y < H; ++y) {
            const int32_t sy = H - 1 - y;
            const unsigned char* row = inPix + static_cast<size_t>(sy) * rowbytes;
            float* dst = rgba.data() + static_cast<size_t>(y) * W * 4;
            for (int32_t x = 0; x < W; ++x) {
                const unsigned char* p = row + static_cast<size_t>(x) * 4;
                dst[x * 4 + 0] = p[1] / 255.0f;
                dst[x * 4 + 1] = p[2] / 255.0f;
                dst[x * 4 + 2] = p[3] / 255.0f;
                dst[x * 4 + 3] = p[0] / 255.0f;
            }
        }
    }
}

void writeOut(void* dst, int32_t rowbytes, int32_t outW, int32_t outH,
              const float* back, int32_t W, int32_t H, PixelDepth depth) {
    const int32_t outRows = (std::min)(H, outH);
    const int32_t outCols = (std::min)(W, outW);
    unsigned char* outPix = static_cast<unsigned char*>(dst);
    for (int32_t y = 0; y < outRows; ++y) {
        const float* rowIn = back + static_cast<size_t>(H - 1 - y) * W * 4;
        if (depth == PixelDepth::Bits32) {
            float* rowOut = reinterpret_cast<float*>(outPix + static_cast<size_t>(y) * rowbytes);
            for (int32_t x = 0; x < outCols; ++x) {
                rowOut[x * 4 + 0] = rowIn[x * 4 + 3];
                rowOut[x * 4 + 1] = rowIn[x * 4 + 0];
                rowOut[x * 4 + 2] = rowIn[x * 4 + 1];
                rowOut[x * 4 + 3] = rowIn[x * 4 + 2];
            }
        } else if (depth == PixelDepth::Bits16) {
            unsigned short* rowOut = reinterpret_cast<unsigned short*>(
                outPix + static_cast<size_t>(y) * rowbytes);
            for (int32_t x = 0; x < outCols; ++x) {
                rowOut[x * 4 + 0] = clamp16(rowIn[x * 4 + 3]);
                rowOut[x * 4 + 1] = clamp16(rowIn[x * 4 + 0]);
                rowOut[x * 4 + 2] = clamp16(rowIn[x * 4 + 1]);
                rowOut[x * 4 + 3] = clamp16(rowIn[x * 4 + 2]);
            }
        } else {
            unsigned char* rowOut = outPix + static_cast<size_t>(y) * rowbytes;
            for (int32_t x = 0; x < outCols; ++x) {
                rowOut[x * 4 + 0] = clamp8(rowIn[x * 4 + 3]);
                rowOut[x * 4 + 1] = clamp8(rowIn[x * 4 + 0]);
                rowOut[x * 4 + 2] = clamp8(rowIn[x * 4 + 1]);
                rowOut[x * 4 + 3] = clamp8(rowIn[x * 4 + 2]);
            }
        }
    }
}

} // namespace ref

namespace {

using host::PixelDepth;

int32_t bpp(PixelDepth d) {
    return (d == PixelDepth::Bits32) ? 16 : (d == PixelDepth::Bits16 ? 8 : 4);
}

// 造输入像素：覆盖 0/满格/中值 + 伪随机（固定种子，保证可复现）
unsigned int g_seed = 12345u;
unsigned int rnd() { g_seed = g_seed * 1664525u + 1013904223u; return g_seed >> 8; }

std::vector<unsigned char> makeInput(int32_t W, int32_t H, int32_t rowbytes, PixelDepth d) {
    std::vector<unsigned char> buf(static_cast<size_t>(rowbytes) * H + 32, 0xAB);   // 行距填充区填毒值
    for (int32_t y = 0; y < H; ++y) {
        unsigned char* row = buf.data() + static_cast<size_t>(y) * rowbytes;
        for (int32_t x = 0; x < W; ++x) {
            if (d == PixelDepth::Bits8) {
                unsigned char* p = row + static_cast<size_t>(x) * 4;
                p[0] = static_cast<unsigned char>(rnd() & 0xFF);          // A
                p[1] = static_cast<unsigned char>(rnd() & 0xFF);          // R
                p[2] = static_cast<unsigned char>(rnd() & 0xFF);          // G
                p[3] = static_cast<unsigned char>(rnd() & 0xFF);          // B
            } else if (d == PixelDepth::Bits16) {
                unsigned short* p = reinterpret_cast<unsigned short*>(row + static_cast<size_t>(x) * 8);
                p[0] = static_cast<unsigned short>(rnd() & 0xFFFF);
                p[1] = static_cast<unsigned short>(rnd() & 0xFFFF);
                p[2] = static_cast<unsigned short>(rnd() & 0xFFFF);
                p[3] = static_cast<unsigned short>(rnd() & 0xFFFF);
            } else {
                float* p = reinterpret_cast<float*>(row + static_cast<size_t>(x) * 16);
                p[0] = static_cast<float>(rnd() % 1000) / 250.0f;        // 含 >1.0 的超白
                p[1] = static_cast<float>(rnd() % 1000) / 1000.0f;
                p[2] = -static_cast<float>(rnd() % 100) / 500.0f;        // 负值
                p[3] = 1.0f;
            }
        }
    }
    return buf;
}

// 回写输入：覆盖边界（负/0/半格平局/1/超 1/NaN）
std::vector<float> makeBack(int32_t W, int32_t H) {
    std::vector<float> v(static_cast<size_t>(W) * H * 4, 0.0f);
    const float edge[] = {0.0f, 0.5f / 255.0f, 1.0f / 255.0f, 127.5f / 255.0f, 128.5f / 255.0f,
                          0.5f, 1.0f, 1.5f, -0.25f, -1e-7f, 0.5f / 32768.0f, 32767.5f / 32768.0f,
                          1.0f - 1e-7f};
    const int nEdge = static_cast<int>(sizeof(edge) / sizeof(edge[0]));
    for (size_t i = 0; i < v.size(); ++i) {
        if (static_cast<int>(i % 17) < nEdge) v[i] = edge[i % 17];
        else v[i] = static_cast<float>(rnd() % 1024) / 1024.0f * 1.2f - 0.1f;
    }
    if (!v.empty()) v[0] = std::nanf("");
    if (v.size() > 4) v[4] = INFINITY;
    if (v.size() > 8) v[8] = -INFINITY;
    return v;
}

void checkConvert(int32_t W, int32_t H, PixelDepth d, int32_t pad) {
    const int32_t rb = W * bpp(d) + pad;
    std::vector<unsigned char> in = makeInput(W, H, rb, d);
    std::vector<float> got(static_cast<size_t>(W) * H * 4, 0.0f);
    std::vector<float> want;
    host::convertWorldToRgba(in.data(), rb, W, H, d, got.data());
    ref::convert(in.data(), rb, W, H, d, want);
    assert(got.size() == want.size());
    for (size_t i = 0; i < want.size(); ++i) {
        if (memcmp(&got[i], &want[i], sizeof(float)) != 0) {
            printf("  FAIL convert W=%d H=%d depth=%d pad=%d 首个差异 idx=%zu got=%.9g want=%.9g\n",
                   W, H, static_cast<int>(d), pad, i, got[i], want[i]);
            assert(false);
        }
    }
}

void checkWrite(int32_t W, int32_t H, PixelDepth d, int32_t pad) {
    const int32_t rb = W * bpp(d) + pad;
    std::vector<float> back = makeBack(W, H);
    std::vector<unsigned char> got(static_cast<size_t>(rb) * H + 32, 0);
    std::vector<unsigned char> want(static_cast<size_t>(rb) * H + 32, 0);
    host::writeOutputWorld(got.data(), rb, W, H, back.data(), W, H, d);
    ref::writeOut(want.data(), rb, W, H, back.data(), W, H, d);
    if (memcmp(got.data(), want.data(), want.size()) != 0) {
        for (size_t i = 0; i < want.size(); ++i) {
            if (got[i] != want[i]) {
                printf("  FAIL write W=%d H=%d depth=%d pad=%d 首个差异字节=%zu got=%u want=%u\n",
                       W, H, static_cast<int>(d), pad, i,
                       static_cast<unsigned>(got[i]), static_cast<unsigned>(want[i]));
                break;
            }
        }
        assert(false);
    }
}

// 尺寸不一致时（GL 读回尺寸 ≠ output 尺寸）的越界保护：只允许写 outW/outH 范围
void checkClamp() {
    const int32_t W = 24, H = 6, outW = 10, outH = 3, rb = 64;
    std::vector<float> back = makeBack(W, H);
    std::vector<unsigned char> got(static_cast<size_t>(rb) * H, 0xEE);
    std::vector<unsigned char> want(static_cast<size_t>(rb) * H, 0xEE);
    host::writeOutputWorld(got.data(), rb, outW, outH, back.data(), W, H, PixelDepth::Bits8);
    ref::writeOut(want.data(), rb, outW, outH, back.data(), W, H, PixelDepth::Bits8);
    assert(memcmp(got.data(), want.data(), want.size()) == 0);
    // 越界区（第 outH 行起）必须原样未动
    for (size_t i = static_cast<size_t>(rb) * outH; i < got.size(); ++i) assert(got[i] == 0xEE);
    printf("  PASS: 越界保护（outW/outH 限制生效，未写区保持原值）\n");
}

// 翻转方向本身：源顶行 → 目的末行
void checkFlip() {
    const int32_t W = 5, H = 3, rb = W * 4;
    std::vector<unsigned char> in(static_cast<size_t>(rb) * H, 0);
    for (int32_t y = 0; y < H; ++y) {
        for (int32_t x = 0; x < W; ++x) {
            unsigned char* p = in.data() + static_cast<size_t>(y) * rb + static_cast<size_t>(x) * 4;
            p[1] = static_cast<unsigned char>(y + 1);   // R 通道 = 行号（1..H）
        }
    }
    std::vector<float> out(static_cast<size_t>(W) * H * 4, 0.0f);
    host::convertWorldToRgba(in.data(), rb, W, H, PixelDepth::Bits8, out.data());
    for (int32_t y = 0; y < H; ++y) {
        // 输出第 y 行应当来自源第 H-1-y 行
        const float expect = static_cast<float>(H - 1 - y + 1) / 255.0f;
        for (int32_t x = 0; x < W; ++x) assert(out[(static_cast<size_t>(y) * W + x) * 4] == expect);
    }
    // 通道序：源 A R G B → 输出 R G B A
    std::vector<unsigned char> one(4);
    one[0] = 10; one[1] = 20; one[2] = 30; one[3] = 40;   // A=10 R=20 G=30 B=40
    std::vector<float> o4(4, 0.0f);
    host::convertWorldToRgba(one.data(), 4, 1, 1, PixelDepth::Bits8, o4.data());
    assert(o4[0] == 20 / 255.0f && o4[1] == 30 / 255.0f && o4[2] == 40 / 255.0f && o4[3] == 10 / 255.0f);
    printf("  PASS: 翻转方向与通道序（顶行→末行、ARGB→RGBA）\n");
}

// 8bit 全值域穷举（0..255 单通道）：向量与标量逐位比对
void checkExhaustive8() {
    std::vector<unsigned char> in(256 * 4, 0);
    for (int v = 0; v < 256; ++v) {
        in[v * 4 + 0] = static_cast<unsigned char>(v);        // A
        in[v * 4 + 1] = static_cast<unsigned char>(255 - v);  // R
        in[v * 4 + 2] = static_cast<unsigned char>(v);        // G
        in[v * 4 + 3] = static_cast<unsigned char>(255 - v);  // B
    }
    std::vector<float> got(256 * 4, 0.0f), want;
    host::convertWorldToRgba(in.data(), 256 * 4, 256, 1, PixelDepth::Bits8, got.data());
    ref::convert(in.data(), 256 * 4, 256, 1, PixelDepth::Bits8, want);
    for (size_t i = 0; i < want.size(); ++i) assert(memcmp(&got[i], &want[i], 4) == 0);
    printf("  PASS: 8bit 全值域 256×4 通道逐位一致（divps 与标量 divss 同舍入）\n");
}

} // namespace

// ── BGRA8 直取拷贝 ────────────────────────────────
void checkBgra8Copy() {
    // 行倒序 + 尺寸钳制：源第 0 行 = 画面底行 → 目的第 outH-1 行
    const int32_t W = 5, H = 4, rb = W * 4;
    std::vector<unsigned char> src(static_cast<size_t>(W) * H * 4);
    for (int32_t y = 0; y < H; ++y)
        for (int32_t x = 0; x < W; ++x) {
            unsigned char* p = src.data() + (static_cast<size_t>(y) * W + x) * 4;
            p[0] = static_cast<unsigned char>(y * 4 + 0);   // A（用行号可辨翻转）
            p[1] = static_cast<unsigned char>(y * 4 + 1);   // R
            p[2] = static_cast<unsigned char>(y * 4 + 2);   // G
            p[3] = static_cast<unsigned char>(y * 4 + 3);   // B
        }
    std::vector<unsigned char> dst(static_cast<size_t>(rb) * H, 0xEE);
    host::copyBgra8ToWorld8(dst.data(), rb, W, H, src.data(), W, H);
    for (int32_t y = 0; y < H; ++y) {
        const unsigned char* got = dst.data() + static_cast<size_t>(y) * rb;
        const unsigned char* exp = src.data() + static_cast<size_t>(H - 1 - y) * W * 4;
        for (int32_t i = 0; i < W * 4; ++i) assert(got[i] == exp[i]);
    }
    // 尺寸钳制：outW/outH 小于读回尺寸时只写这么多，多出来的区域原样不动
    const int32_t ow = 3, oh = 2;
    std::vector<unsigned char> dst2(static_cast<size_t>(rb) * H, 0xEE);
    host::copyBgra8ToWorld8(dst2.data(), rb, ow, oh, src.data(), W, H);
    for (int32_t y = 0; y < oh; ++y)
        for (int32_t i = 0; i < ow * 4; ++i)
            assert(dst2[static_cast<size_t>(y) * rb + i] ==
                   src[static_cast<size_t>(H - 1 - y) * W * 4 + i]);
    for (int32_t i = ow * 4; i < rb; ++i) assert(dst2[i] == 0xEE);          // 行内未写区
    for (size_t i = static_cast<size_t>(rb) * oh; i < dst2.size(); ++i) assert(dst2[i] == 0xEE);  // 未写行
    // 行距 > 宽×4（AE 的 rowbytes 可能有填充）：填充区不得被写
    const int32_t rbPad = rb + 16;
    std::vector<unsigned char> dst3(static_cast<size_t>(rbPad) * H, 0xEE);
    host::copyBgra8ToWorld8(dst3.data(), rbPad, W, H, src.data(), W, H);
    for (int32_t y = 0; y < H; ++y)
        for (int32_t i = W * 4; i < rbPad; ++i) assert(dst3[static_cast<size_t>(y) * rbPad + i] == 0xEE);
    printf("  PASS: BGRA8 直取拷贝（行倒序、尺寸钳制、行距填充区不动）\n");
}

// ── 结算器纯逻辑（记账 + 子步目标）──────────────────────
namespace {

using host::PixelDepth;
using host::SolverTarget;

void checkSolverBudget() {
    // 512² 的 RGBA16F 必须是 2MB/帧（solverSchedule.h 注释里那句"250 帧才 500MB"
    // 就是靠这条成立的）；32bit 项目 RGBA32F 才是 4MB/帧。
    assert(host::solverFrameBytes(512, 512, PixelDepth::Bits8)  == 2u * 1024 * 1024);
    assert(host::solverFrameBytes(512, 512, PixelDepth::Bits16) == 2u * 1024 * 1024);
    assert(host::solverFrameBytes(512, 512, PixelDepth::Bits32) == 4u * 1024 * 1024);
    // 512MB 预算下的帧数：8/16bit 256 帧、32bit 128 帧（一律按 16B 记账时 →
    // 8/16bit 只有 128 帧，等于白丢一半预算）
    assert(host::solverCacheCapacity(512, 512, PixelDepth::Bits8)  == 256);
    assert(host::solverCacheCapacity(512, 512, PixelDepth::Bits16) == 256);
    assert(host::solverCacheCapacity(512, 512, PixelDepth::Bits32) == 128);
    // 退化输入不崩、且至少留一帧（否则指纹一变就退化成每帧从 0 重解）
    assert(host::solverCacheCapacity(0, 0, PixelDepth::Bits8) == 1);
    assert(host::solverFrameBytes(-4, 8, PixelDepth::Bits8) == 0);
    // @solveRes 128（示例文件用的档）：每帧 128KB，预算内可存 4096 帧 → 不设上限也行，
    // 这里只钉住"远大于 250 帧"这个量级判断
    assert(host::solverCacheCapacity(128, 72, PixelDepth::Bits8) > 250);
    printf("  PASS: 结算器记账（512²=2MB/帧、预算 256 帧；32bit 4MB/帧=128 帧）\n");
}

void checkSolverStepTargets() {
    // 用"谁持有当前状态"的模拟来验读写不撞车：-1 = prevTex（第 0 帧的输入图层，
    // 或后续帧的上一帧缓存纹理——两者都不是 scratch），0/1 = 两张 scratch，
    // 2 = 本帧缓存纹理（每帧 glGen 出来的新对象，与谁都不同）。
    // 每一步的 target 都不能是它刚读的那张——读写同一张 = GL 反馈回路，结果未定义。
    for (int n = 1; n <= 64; ++n) {
        int holder = -1;
        for (int k = 0; k < n; ++k) {
            const SolverTarget t = host::solverStepTarget(k, n);
            const int id = (t == SolverTarget::Scratch0) ? 0
                         : (t == SolverTarget::Scratch1) ? 1 : 2;
            assert(id != holder);                       // 读-写撞车检查
            if (k == n - 1) assert(t == SolverTarget::Cache);   // 末步落进缓存纹理
            else            assert(t != SolverTarget::Cache);   // 中间步只在 scratch 间用
            holder = id;
        }
    }
    // 具体序列（防"让测试过"的巧合）：N=1 → C；N=2 → S0,C；N=3 → S0,S1,C；N=4 → S0,S1,S0,C
    assert(host::solverStepTarget(0, 1) == SolverTarget::Cache);
    assert(host::solverStepTarget(0, 2) == SolverTarget::Scratch0);
    assert(host::solverStepTarget(1, 2) == SolverTarget::Cache);
    assert(host::solverStepTarget(1, 3) == SolverTarget::Scratch1);
    assert(host::solverStepTarget(2, 3) == SolverTarget::Cache);
    assert(host::solverStepTarget(2, 4) == SolverTarget::Scratch0);
    assert(host::solverStepTarget(3, 4) == SolverTarget::Cache);
    // 防御：stepsPerFrame ≤ 0（解析器钳到 ≥1，理论不可达）不越界、不倒序
    assert(host::solverStepTarget(0, 0) == SolverTarget::Cache);
    assert(host::solverStepTarget(5, -1) == SolverTarget::Cache);
    printf("  PASS: 结算器子步目标（1..64 步全序列无读写撞车、末步进缓存纹理）\n");
}

void checkSolverLruVictim() {
    // 谱系 LRU：全局预算超限时整条谱系按最旧淘汰，
    // keep 永不可选（它正被锁内解算循环持有）。
    const uint64_t t1[] = {30, 10, 20};                 // 最旧是下标 1
    assert(host::solverLruVictim(t1, 3, SIZE_MAX) == 1);
    assert(host::solverLruVictim(t1, 3, 1) == 2);       // 最旧被保护 → 次旧
    const uint64_t t2[] = {5};                          // 只剩 keep 本身
    assert(host::solverLruVictim(t2, 1, 0) == -1);      // 无可淘汰（调用方停止淘汰）
    assert(host::solverLruVictim(nullptr, 0, SIZE_MAX) == -1);   // 空表
    const uint64_t t3[] = {7, 7, 7};                    // 同 touch：任选一个但必须可复现
    const int v = host::solverLruVictim(t3, 3, SIZE_MAX);
    assert(v == 0 || v == 1 || v == 2);
    // 全局预算量级：1GiB = 单谱系 512MB 的 2 倍（活跃谱系吃满后新谱系仍有起步空间）
    assert(host::kSolverCacheGlobalBudgetBytes == 2 * host::kSolverCacheBudgetBytes);
    printf("  PASS: 谱系 LRU 受害者选取（最旧优先、keep 保护、空表/单条退化）\n");
}

void checkSolverHzSchedule() {
    // @solveHz 的每帧子步数 + 绝对步号基址（两侧一致性）。
    const double fd25 = 1.0 / 25.0;   // 25fps 合成的帧时长
    // 未声明 Hz → 0（调用方走 @solve 分支）
    assert(host::solverSubstepsAt(0, fd25, 3, 64) == 0);
    // Hz ≥ 帧率（240 @25fps）：帧号纯函数、跨帧取整不累积误差（9.6/帧 → 9,10,9,10…）
    assert(host::solverSubstepsAt(240, fd25, 0, 64) == 9);
    assert(host::solverSubstepsAt(240, fd25, 1, 64) == 10);
    assert(host::solverSubstepsAt(240, fd25, 2, 64) == 9);
    assert(host::solverSubstepsAt(240, fd25, 3, 64) == 10);
    // 第 0 帧的播种钳制（Hz < 帧率时本会算 0）
    assert(host::solverSubstepsAt(8, fd25, 0, 64) == 1);
    assert(host::solverSubstepsAt(8, fd25, 1, 64) == 0);
    assert(host::solverSubstepsAt(8, fd25, 2, 64) == 0);
    assert(host::solverSubstepsAt(8, fd25, 3, 64) == 1);   // floor(1.28)−floor(0.96)
    // 每帧硬顶
    assert(host::solverSubstepsAt(100000, fd25, 5, 64) == 64);
    // 交叉锚点：与预览侧 JS 同构实现（shaderPreviewRenderer 的 substepsAt）用同一组参数，
    // 数值必须一致——JS 侧同构实现断言的就是这两个值（Hz 50 → 每帧 2 步；Hz 10 → 帧 1 为 0）
    assert(host::solverSubstepsAt(50, fd25, 0, 64) == 2);
    assert(host::solverSubstepsAt(50, fd25, 1, 64) == 2);
    assert(host::solverSubstepsAt(10, fd25, 0, 64) == 1);   // 播种钳制
    assert(host::solverSubstepsAt(10, fd25, 1, 64) == 0);   // Hz < 帧率的 0 子步帧

    // 非 Hz：基址 = 帧号 × 每帧子步数
    assert(host::solverStepBase(false, 0, fd25, 0, 8) == 0);
    assert(host::solverStepBase(false, 0, fd25, 3, 8) == 24);
    // Hz ≥ 帧率：Hz 时钟的累计就是执行过的步数（帧 0 的首子步即播种，计数已含它）
    assert(host::solverStepBase(true, 240, fd25, 0, 0) == 0);
    assert(host::solverStepBase(true, 240, fd25, 1, 0) == 9);
    assert(host::solverStepBase(true, 240, fd25, 2, 0) == 19);
    // Hz < 帧率：播种被钳制（+1）必须计入基址——不计入时帧 3 的基址是 0，
    // 与播种哨兵 uStep<0.5 撞车（实测：播种在帧 0 与帧 3 各执行一次、整条谱系少跑一步）
    assert(host::solverStepBase(true, 8, fd25, 0, 0) == 0);    // 帧 0 的基址 0 = 真播种
    assert(host::solverStepBase(true, 8, fd25, 3, 0) == 1);    // 计入播种得 1（0 会撞哨兵）
    assert(host::solverStepBase(true, 8, fd25, 9, 0) == 3);
    // 一般不变式（这条才是拦住整类 bug 的判据）：任何**带子步**的非 0 帧，
    // 基址必须 ≥ 1，否则该帧第一子步会被当成播种（状态被重写）
    const int hzList[] = {1, 2, 5, 8, 10, 20, 24};
    for (int hz : hzList) {
        for (int f = 0; f <= 40; ++f) {
            const int n = host::solverSubstepsAt(hz, fd25, f, 64);
            const long long base = host::solverStepBase(true, hz, fd25, f, 0);
            if (f > 0 && n > 0) assert(base >= 1);
            if (f == 0) assert(base == 0);   // 只有帧 0 允许基址 0（那次是播种）
        }
    }
    // 执行过的子步号必须严格递增（不重号）：把整条谱系的子步号摊开看
    {
        long long expect = 0;
        for (int f = 0; f <= 40; ++f) {
            const int n = host::solverSubstepsAt(8, fd25, f, 64);
            const long long base = host::solverStepBase(true, 8, fd25, f, 0);
            for (int k = 0; k < n; ++k) {
                assert(base + k == expect);
                ++expect;
            }
        }
        // 40 帧 @Hz8/25fps：播种 1 步 + Hz 时钟 13 步（floor(8·41/25)=13）
        assert(expect == 1 + 13);
    }
    printf("  PASS: @solveHz 子步数/步号基址（播种钳制计入基址、非 0 帧基址 ≥1、子步号不重号）\n");
}

} // namespace

void runPixelConvertTests() {
    printf("[pixelConvert] 向量路径 vs 标量参照\n");
    checkFlip();
    checkExhaustive8();

    const int32_t widths[] = {1, 2, 3, 4, 5, 7, 8, 13, 16, 63, 64, 127};
    const int32_t heights[] = {1, 2, 5};
    const int32_t pads[] = {0, 4, 16};
    const PixelDepth depths[] = {PixelDepth::Bits8, PixelDepth::Bits16, PixelDepth::Bits32};
    for (PixelDepth d : depths) {
        for (int32_t w : widths) {
            for (int32_t h : heights) {
                for (int32_t pad : pads) {
                    checkConvert(w, h, d, pad);
                    checkWrite(w, h, d, pad);
                }
            }
        }
    }
    printf("  PASS: 三档位深 × 12 种宽度（含尾段）× 3 高度 × 3 行距填充 —— 上传/回写全部逐位一致\n");
    checkClamp();
    checkSolverBudget();
    checkSolverStepTargets();
    checkSolverLruVictim();
    checkSolverHzSchedule();
    checkBgra8Copy();
}
