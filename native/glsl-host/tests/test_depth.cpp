// Release 构建（/DNDEBUG）会把 assert 编译为空操作——断言须保持生效
#undef NDEBUG
#include "../src/pixelDepth.h"
#include <cassert>
#include <cstdio>

static void test_detect_depth() {
    using host::PixelDepth;
    using host::detectDepth;
    // 8bit: 1920×1080 → rowbytes=7680
    assert(detectDepth(7680, 1920) == PixelDepth::Bits8);
    // 16bit: 1920×1080 → rowbytes=15360
    assert(detectDepth(15360, 1920) == PixelDepth::Bits16);
    // 32bit: 1920×1080 → rowbytes=30720
    assert(detectDepth(30720, 1920) == PixelDepth::Bits32);
    // 边界：width=0 不崩溃
    assert(detectDepth(0, 0) == PixelDepth::Bits8);
    // 边界：1×1 像素各深度
    assert(detectDepth(4, 1) == PixelDepth::Bits8);
    assert(detectDepth(8, 1) == PixelDepth::Bits16);
    assert(detectDepth(16, 1) == PixelDepth::Bits32);
    printf("  PASS: test_detect_depth\n");
}

int main() {
    test_detect_depth();
    printf("All depth tests passed.\n");
    return 0;
}
