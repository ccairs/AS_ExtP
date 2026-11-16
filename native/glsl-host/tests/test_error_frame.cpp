// errorFrame（失败占位帧光栅化）单元测试——纯逻辑层，仅依赖 Win32 GDI。
// 契约：品红底 + 白色错误文本；输出为 GL 底行序（row 0 = 底行）RGBA float；
// 空文本/非法尺寸的退化路径不崩溃且语义正确（空文本 → 纯品红，非法尺寸 → 空）。
#undef NDEBUG
#include <cassert>
#include <iostream>
#include <string>
#include <vector>

#include "errorFrame.h"

namespace {

// 纯品红像素判定（R=1, G=0, B=1, A=1；GDI 抗锯齿边缘不满足）
bool isMagenta(const std::vector<float>& f, size_t i) {
    return f[i] > 0.99f && f[i + 1] < 0.01f && f[i + 2] > 0.99f && f[i + 3] > 0.99f;
}

// 尺寸与背景契约：输出恰为 W*H*4；四角为品红（文本区有 fontH/2 边距，
// 文字不触边——角检查与底行序无关）
void test_dimensions_and_magenta_bg() {
    const long W = 64, H = 48;
    auto f = host::rasterizeErrorFrame(W, H, "ERROR: something failed");
    assert(f.size() == (size_t)W * H * 4);
    const size_t corners[4] = {
        0,
        (size_t)(W - 1) * 4,
        (size_t)(H - 1) * W * 4,
        ((size_t)H * W - 1) * 4
    };
    for (size_t off : corners) assert(isMagenta(f, off));
    std::cout << "PASS error_frame dimensions_and_magenta_bg\n";
}

// 文本落墨契约：中英混排错误文本在帧内产生非品红像素（文字可见）。
// 覆盖宿主真实错误形态：中文前缀 + ASCII 驱动错误。
void test_text_ink_present() {
    const long W = 256, H = 128;
    auto f = host::rasterizeErrorFrame(
        W, H, "shader \xE7\xBC\x96\xE8\xAF\x91\xE5\xA4\xB1\xE8\xB4\xA5: ERROR: 0:52: 'float' : overloaded functions");
    assert(f.size() == (size_t)W * H * 4);
    size_t ink = 0;
    for (size_t i = 0; i + 3 < f.size(); i += 4) {
        if (!isMagenta(f, i)) ++ink;
    }
    // 多行中英文本在 256x128 上应显著落墨（阈值保守：只要文字真的画出来了）
    assert(ink > 100);
    std::cout << "PASS error_frame text_ink_present (ink=" << ink << ")\n";
}

// 空文本退化：纯品红（保持旧占位语义——无信息可画时帧仍确定）
void test_empty_text_pure_magenta() {
    const long W = 32, H = 32;
    auto f = host::rasterizeErrorFrame(W, H, "");
    assert(f.size() == (size_t)W * H * 4);
    for (size_t i = 0; i + 3 < f.size(); i += 4) {
        assert(isMagenta(f, i));
    }
    std::cout << "PASS error_frame empty_text_pure_magenta\n";
}

// 非法尺寸：返回空 vector（调用方 renderer 侧退化为品红填充）
void test_invalid_dims_empty() {
    assert(host::rasterizeErrorFrame(0, 100, "x").empty());
    assert(host::rasterizeErrorFrame(100, -1, "x").empty());
    std::cout << "PASS error_frame invalid_dims_empty\n";
}

// 底行序契约（writeOutputWorld 适配前提）：文本绘制在帧顶部（DrawText 从
// rect 顶开始），bottom-up DIB 的屏幕上半 = 内存行序的后半段（y >= H/2）。
// 单字符测试文本，落墨应集中在内存 y >= H/2 区域。
void test_bottom_row_order() {
    const long W = 128, H = 256;
    auto f = host::rasterizeErrorFrame(W, H, "X");
    assert(f.size() == (size_t)W * H * 4);
    size_t inkUpperScreen = 0, inkLowerScreen = 0;
    for (long y = 0; y < H; ++y) {
        for (long x = 0; x < W; ++x) {
            const size_t i = ((size_t)y * W + x) * 4;
            if (!isMagenta(f, i)) {
                if (y >= H / 2) ++inkUpperScreen;  // bottom-up：内存后半段 = 屏幕上半
                else ++inkLowerScreen;
            }
        }
    }
    assert(inkUpperScreen > 0);
    assert(inkUpperScreen > inkLowerScreen);
    std::cout << "PASS error_frame bottom_row_order (upper=" << inkUpperScreen
              << " lower=" << inkLowerScreen << ")\n";
}

} // namespace

void runErrorFrameTests() {
    test_dimensions_and_magenta_bg();
    test_text_ink_present();
    test_empty_text_pure_magenta();
    test_invalid_dims_empty();
    test_bottom_row_order();
}
