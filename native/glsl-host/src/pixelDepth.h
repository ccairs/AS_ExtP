#pragma once
// pixelDepth.h —— 像素深度检测（不依赖 AE SDK，可供单元测试直接使用）
#include <cstdint>

namespace host {

// 像素深度
enum class PixelDepth { Bits8, Bits16, Bits32 };

// 从 PF_LayerDef/PF_EffectWorld 的 rowbytes/width 推断深度
// 8bit:  4 bytes/pix (A_u_char × 4)
// 16bit: 8 bytes/pix (A_u_short × 4)
// 32bit:16 bytes/pix (A_FpShort/float × 4)
inline PixelDepth detectDepth(int64_t rowbytes, int64_t width) {
    if (width <= 0) return PixelDepth::Bits8;
    int64_t bpp = rowbytes / width;
    if (bpp >= 16) return PixelDepth::Bits32;
    if (bpp >= 8)  return PixelDepth::Bits16;
    return PixelDepth::Bits8;
}

} // namespace host
