// pixelConvert.cpp —— 见 pixelConvert.h。
//
// 实现纪律：
//   · 向量路径与标量尾必须**逐位一致**——tests/test_pixel_convert.cpp 用穷举探针
//     把两者逐字节比对（含 w 非 4 倍数的尾段、负值/超范围值）。改这里先跑那个测试。
//   · 8bit 上传归一化用 divps 而非「乘 1/255」：1/255 在二进制下不可精确表示，
//     乘法结果与标量除法差 ≤1 ulp（16F 量化后几乎全被吸收，但理论上有
//     极少数值落在 16F 舍入边界上翻一格）。divps 是 IEEE 正确舍入，与标量 divss
//     逐位相同——省下的那点时间不值得换一处说不清的精度差异。
//   · 16bit 归一化用乘 1/32768：2^-15 可精确表示，乘法即精确，与除法逐位相同。
#include "pixelConvert.h"

#if !defined(_M_X64) && !defined(__SSE2__)
#error "AS_Effect_Host 为 x64 插件，pixelConvert 的向量路径要求 SSE2"
#endif

#include <emmintrin.h>
#include <cstddef>
#include <cstring>

namespace host {
namespace {

constexpr float kInv255  = 1.0f / 255.0f;      // 仅用于注释对照，见文件头纪律
constexpr float kInvChan16 = 1.0f / 32768.0f;  // = 2^-15，精确

// __m128 的 4 个 float 从 [A R G B] 重排为 [R G B A]（AE 内存序 → GL 序）
inline __m128 rgbaFromArgb(__m128 v) {
    return _mm_shuffle_ps(v, v, _MM_SHUFFLE(0, 3, 2, 1));
}
// 反向：[R G B A] → [A R G B]
inline __m128 argbFromRgba(__m128 v) {
    return _mm_shuffle_ps(v, v, _MM_SHUFFLE(2, 1, 0, 3));
}
// 整型版（同上，通道序在 int32 lane 上的重排）
inline __m128i argbFromRgbaI(__m128i v) {
    return _mm_shuffle_epi32(v, _MM_SHUFFLE(2, 1, 0, 3));
}

// —— 标量尾（也是非 SSE2 平台的完整实现语义参照）——
void convertTail8(const unsigned char* row, float* d, int32_t x0, int32_t w) {
    for (int32_t x = x0; x < w; ++x) {
        const unsigned char* p = row + static_cast<size_t>(x) * 4;
        d[x * 4 + 0] = p[1] / 255.0f;
        d[x * 4 + 1] = p[2] / 255.0f;
        d[x * 4 + 2] = p[3] / 255.0f;
        d[x * 4 + 3] = p[0] / 255.0f;
    }
}
void convertTail16(const unsigned char* row, float* d, int32_t x0, int32_t w) {
    for (int32_t x = x0; x < w; ++x) {
        const unsigned short* p = reinterpret_cast<const unsigned short*>(
            row + static_cast<size_t>(x) * 8);
        // AE 16bit：1.0 = PF_MAX_CHAN16 = 32768（最高 2.0 = 65535）
        d[x * 4 + 0] = p[1] / 32768.0f;
        d[x * 4 + 1] = p[2] / 32768.0f;
        d[x * 4 + 2] = p[3] / 32768.0f;
        d[x * 4 + 3] = p[0] / 32768.0f;
    }
}
void convertTail32(const unsigned char* row, float* d, int32_t x0, int32_t w) {
    for (int32_t x = x0; x < w; ++x) {
        const float* p = reinterpret_cast<const float*>(row + static_cast<size_t>(x) * 16);
        d[x * 4 + 0] = p[1];
        d[x * 4 + 1] = p[2];
        d[x * 4 + 2] = p[3];
        d[x * 4 + 3] = p[0];
    }
}

// 浮点 [0,1] → 8bit/16bit 通道（与旧 renderer.cpp 的 clamp8/clamp16 同语义）
inline unsigned char clamp8(float v) {
    if (v < 0.0f) v = 0.0f; else if (v > 1.0f) v = 1.0f;
    return static_cast<unsigned char>(v * 255.0f + 0.5f);
}
inline unsigned short clamp16(float v) {
    if (v < 0.0f) v = 0.0f; else if (v > 1.0f) v = 1.0f;
    return static_cast<unsigned short>(v * 32768.0f + 0.5f);
}
void writeTail8(const float* rowIn, unsigned char* rowOut, int32_t x0, int32_t outW) {
    for (int32_t x = x0; x < outW; ++x) {
        rowOut[x * 4 + 0] = clamp8(rowIn[x * 4 + 3]);   // A
        rowOut[x * 4 + 1] = clamp8(rowIn[x * 4 + 0]);   // R
        rowOut[x * 4 + 2] = clamp8(rowIn[x * 4 + 1]);   // G
        rowOut[x * 4 + 3] = clamp8(rowIn[x * 4 + 2]);   // B
    }
}
void writeTail16(const float* rowIn, unsigned char* rowOut, int32_t x0, int32_t outW) {
    for (int32_t x = x0; x < outW; ++x) {
        unsigned short* q = reinterpret_cast<unsigned short*>(
            rowOut + static_cast<size_t>(x) * 8);
        q[0] = clamp16(rowIn[x * 4 + 3]);
        q[1] = clamp16(rowIn[x * 4 + 0]);
        q[2] = clamp16(rowIn[x * 4 + 1]);
        q[3] = clamp16(rowIn[x * 4 + 2]);
    }
}
void writeTail32(const float* rowIn, unsigned char* rowOut, int32_t x0, int32_t outW) {
    for (int32_t x = x0; x < outW; ++x) {
        float* q = reinterpret_cast<float*>(rowOut + static_cast<size_t>(x) * 16);
        q[0] = rowIn[x * 4 + 3];
        q[1] = rowIn[x * 4 + 0];
        q[2] = rowIn[x * 4 + 1];
        q[3] = rowIn[x * 4 + 2];
    }
}

} // namespace

void convertWorldToRgba(const void* src, int32_t rowbytes, int32_t w, int32_t h,
                        PixelDepth depth, float* dst) {
    if (!src || !dst || w <= 0 || h <= 0) return;
    const unsigned char* inPix = static_cast<const unsigned char*>(src);
    const __m128i zero = _mm_setzero_si128();

    for (int32_t y = 0; y < h; ++y) {
        const unsigned char* row = inPix +
            static_cast<size_t>(h - 1 - y) * static_cast<size_t>(rowbytes);   // 上下翻转
        float* d = dst + static_cast<size_t>(y) * w * 4;
        int32_t x = 0;

        if (depth == PixelDepth::Bits32) {
            for (; x + 4 <= w; x += 4) {
                const float* p = reinterpret_cast<const float*>(
                    row + static_cast<size_t>(x) * 16);
                _mm_storeu_ps(d + static_cast<size_t>(x) * 4 + 0,
                              rgbaFromArgb(_mm_loadu_ps(p + 0)));
                _mm_storeu_ps(d + static_cast<size_t>(x) * 4 + 4,
                              rgbaFromArgb(_mm_loadu_ps(p + 4)));
                _mm_storeu_ps(d + static_cast<size_t>(x) * 4 + 8,
                              rgbaFromArgb(_mm_loadu_ps(p + 8)));
                _mm_storeu_ps(d + static_cast<size_t>(x) * 4 + 12,
                              rgbaFromArgb(_mm_loadu_ps(p + 12)));
            }
            convertTail32(row, d, x, w);
        } else if (depth == PixelDepth::Bits16) {
            for (; x + 4 <= w; x += 4) {
                // 每像素 8 字节：A R G B 各 u16 → 字节→dword 零扩展后转 float
                const unsigned char* r = row + static_cast<size_t>(x) * 8;
                const __m128i p0 = _mm_loadu_si128(reinterpret_cast<const __m128i*>(r));
                const __m128i p1 = _mm_loadu_si128(reinterpret_cast<const __m128i*>(r + 16));
                const __m128 v0 = _mm_mul_ps(
                    _mm_cvtepi32_ps(_mm_unpacklo_epi16(p0, zero)), _mm_set1_ps(kInvChan16));
                const __m128 v1 = _mm_mul_ps(
                    _mm_cvtepi32_ps(_mm_unpackhi_epi16(p0, zero)), _mm_set1_ps(kInvChan16));
                const __m128 v2 = _mm_mul_ps(
                    _mm_cvtepi32_ps(_mm_unpacklo_epi16(p1, zero)), _mm_set1_ps(kInvChan16));
                const __m128 v3 = _mm_mul_ps(
                    _mm_cvtepi32_ps(_mm_unpackhi_epi16(p1, zero)), _mm_set1_ps(kInvChan16));
                float* o = d + static_cast<size_t>(x) * 4;
                _mm_storeu_ps(o + 0,  rgbaFromArgb(v0));
                _mm_storeu_ps(o + 4,  rgbaFromArgb(v1));
                _mm_storeu_ps(o + 8,  rgbaFromArgb(v2));
                _mm_storeu_ps(o + 12, rgbaFromArgb(v3));
            }
            convertTail16(row, d, x, w);
        } else {
            for (; x + 4 <= w; x += 4) {
                // 16 字节 = 4 像素 × 4 通道 u8 → 零扩展成 4 个 [A R G B] dword 向量
                const __m128i px = _mm_loadu_si128(reinterpret_cast<const __m128i*>(
                    row + static_cast<size_t>(x) * 4));
                const __m128i w0 = _mm_unpacklo_epi8(px, zero);
                const __m128i w1 = _mm_unpackhi_epi8(px, zero);
                const __m128 div = _mm_set1_ps(255.0f);
                const __m128 v0 = _mm_div_ps(_mm_cvtepi32_ps(_mm_unpacklo_epi16(w0, zero)), div);
                const __m128 v1 = _mm_div_ps(_mm_cvtepi32_ps(_mm_unpackhi_epi16(w0, zero)), div);
                const __m128 v2 = _mm_div_ps(_mm_cvtepi32_ps(_mm_unpacklo_epi16(w1, zero)), div);
                const __m128 v3 = _mm_div_ps(_mm_cvtepi32_ps(_mm_unpackhi_epi16(w1, zero)), div);
                float* o = d + static_cast<size_t>(x) * 4;
                _mm_storeu_ps(o + 0,  rgbaFromArgb(v0));
                _mm_storeu_ps(o + 4,  rgbaFromArgb(v1));
                _mm_storeu_ps(o + 8,  rgbaFromArgb(v2));
                _mm_storeu_ps(o + 12, rgbaFromArgb(v3));
            }
            convertTail8(row, d, x, w);
        }
    }
}

void writeOutputWorld(void* dst, int32_t dstRowbytes, int32_t outW, int32_t outH,
                      const float* back, int32_t w, int32_t h, PixelDepth depth) {
    if (!dst || !back) return;
    // 安全限制：行数/列数取读回缓冲与输出 world 的最小值，防止越界
    const int32_t rows = outH < h ? outH : h;
    const int32_t cols = outW < w ? outW : w;
    if (rows <= 0 || cols <= 0) return;
    unsigned char* outPix = static_cast<unsigned char*>(dst);
    const __m128 kHalf = _mm_set1_ps(0.5f);
    const __m128 kZeroF = _mm_setzero_ps();
    const __m128 kOneF = _mm_set1_ps(1.0f);

    for (int32_t y = 0; y < rows; ++y) {
        const float* rowIn = back + static_cast<size_t>(h - 1 - y) * w * 4;   // 上下翻转
        unsigned char* rowOut = outPix + static_cast<size_t>(y) * dstRowbytes;
        int32_t x = 0;

        if (depth == PixelDepth::Bits32) {
            for (; x + 4 <= cols; x += 4) {
                float* q = reinterpret_cast<float*>(rowOut + static_cast<size_t>(x) * 16);
                _mm_storeu_ps(q + 0,  argbFromRgba(_mm_loadu_ps(rowIn + static_cast<size_t>(x) * 4 + 0)));
                _mm_storeu_ps(q + 4,  argbFromRgba(_mm_loadu_ps(rowIn + static_cast<size_t>(x) * 4 + 4)));
                _mm_storeu_ps(q + 8,  argbFromRgba(_mm_loadu_ps(rowIn + static_cast<size_t>(x) * 4 + 8)));
                _mm_storeu_ps(q + 12, argbFromRgba(_mm_loadu_ps(rowIn + static_cast<size_t>(x) * 4 + 12)));
            }
            writeTail32(rowIn, rowOut, x, cols);
        } else if (depth == PixelDepth::Bits16) {
            const __m128 kScale = _mm_set1_ps(32768.0f);
            const __m128i kBias = _mm_set1_epi32(0x8000);
            for (; x + 4 <= cols; x += 4) {
                __m128i s[4];
                for (int k = 0; k < 4; ++k) {
                    __m128 v = _mm_loadu_ps(rowIn + (static_cast<size_t>(x) + k) * 4);
                    __m128 t = _mm_min_ps(_mm_max_ps(v, kZeroF), kOneF);   // 钳 [0,1]
                    t = _mm_add_ps(_mm_mul_ps(t, kScale), kHalf);
                    s[k] = argbFromRgbaI(_mm_cvttps_epi32(t));             // [A R G B] dword
                }
                // dword→word：值域 [0,32768] 超出 int16 上限（32767）→ 先减 0x8000 偏置，
                // 打包后再异或回来（SSE2 无 packus_epi32，这是等价且不饱和的写法）
                __m128i b0 = _mm_packs_epi32(_mm_sub_epi32(s[0], kBias), _mm_sub_epi32(s[1], kBias));
                __m128i b1 = _mm_packs_epi32(_mm_sub_epi32(s[2], kBias), _mm_sub_epi32(s[3], kBias));
                unsigned char* o = rowOut + static_cast<size_t>(x) * 8;
                _mm_storeu_si128(reinterpret_cast<__m128i*>(o),
                                 _mm_xor_si128(b0, _mm_set1_epi16(static_cast<short>(0x8000))));
                _mm_storeu_si128(reinterpret_cast<__m128i*>(o + 16),
                                 _mm_xor_si128(b1, _mm_set1_epi16(static_cast<short>(0x8000))));
            }
            writeTail16(rowIn, rowOut, x, cols);
        } else {
            const __m128 kScale = _mm_set1_ps(255.0f);
            for (; x + 4 <= cols; x += 4) {
                __m128i s[4];
                for (int k = 0; k < 4; ++k) {
                    __m128 v = _mm_loadu_ps(rowIn + (static_cast<size_t>(x) + k) * 4);
                    __m128 t = _mm_min_ps(_mm_max_ps(v, kZeroF), kOneF);   // 钳 [0,1]
                    t = _mm_add_ps(_mm_mul_ps(t, kScale), kHalf);
                    s[k] = argbFromRgbaI(_mm_cvttps_epi32(t));             // [A R G B] dword
                }
                const __m128i w01 = _mm_packs_epi32(s[0], s[1]);   // 8 word = 2 像素
                const __m128i w23 = _mm_packs_epi32(s[2], s[3]);
                _mm_storeu_si128(
                    reinterpret_cast<__m128i*>(rowOut + static_cast<size_t>(x) * 4),
                    _mm_packus_epi16(w01, w23));                   // 16 字节 = 4 像素
            }
            writeTail8(rowIn, rowOut, x, cols);
        }
    }
}

void copyBgra8ToWorld8(void* dst, int32_t dstRowbytes, int32_t outW, int32_t outH,
                       const uint8_t* src, int32_t w, int32_t h) {
    if (!dst || !src) return;
    const int32_t rows = (outH < h) ? outH : h;
    const int32_t cols = (outW < w) ? outW : w;
    if (rows <= 0 || cols <= 0) return;
    unsigned char* out = static_cast<unsigned char*>(dst);
    const size_t rowBytes = static_cast<size_t>(cols) * 4;
    for (int32_t y = 0; y < rows; ++y) {
        // 源第 0 行 = 画面底行 → 目的末行；纯 memcpy，无逐像素代码路径
        std::memcpy(out + static_cast<size_t>(y) * dstRowbytes,
                    src + static_cast<size_t>(h - 1 - y) * static_cast<size_t>(w) * 4,
                    rowBytes);
    }
}

} // namespace host
