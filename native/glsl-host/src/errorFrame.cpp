// errorFrame.cpp —— shader 失败占位帧光栅化（GDI 系统字体）
// 动机：失败帧为纯品红（glClear + glReadPixels）时，错误详情只写
// error.log——用户在 AE 合成窗口看到品红但不知道原因，需另走一步读日志；
// 视觉 LLM 调 getPreviewFrame 也只看到无信息量的纯色帧。改为把编译错误
// 文本直接画在占位帧上：人即刻可见，视觉模型可直接读出错误内容。
// 完整错误仍写 error.log（get_render_error 文本通道更精确，此处为视觉冗余）。
//
// 行序约定：CreateDIBSection 用正值 biHeight（bottom-up DIB），内存 row 0
// = 底行——与 glReadPixels 的 GL 读回约定一致，产出可直接喂 writeOutputWorld
//（其按 (H-1-y) 翻转到 AE 顶行序）。
#include "errorFrame.h"
#include "i18n.h"

#include <windows.h>

#include <algorithm>
#include <string>
#include <vector>

namespace host {

namespace {

// 品红底填充（32bpp bottom-up DIB，字节序 BGRA：B=255,G=0,R=255）
void fillMagenta(unsigned char* px, size_t pixelCount) {
    for (size_t i = 0; i < pixelCount; ++i) {
        unsigned char* p = px + i * 4;
        p[0] = 255;  // B
        p[1] = 0;    // G
        p[2] = 255;  // R
        p[3] = 255;  // A
    }
}

// 纯品红 float 缓冲（GDI 不可用/空文本时的退化输出，保持旧占位语义）
std::vector<float> magentaFloatBuffer(long W, long H) {
    std::vector<float> back((size_t)W * H * 4, 1.0f);
    for (size_t i = 0; i < back.size(); i += 4) {
        back[i] = 1.0f;    // R
        back[i + 1] = 0.0f; // G
        back[i + 2] = 1.0f; // B
        back[i + 3] = 1.0f; // A
    }
    return back;
}

} // namespace

std::vector<float> rasterizeErrorFrame(long W, long H, const std::string& errUtf8) {
    if (W <= 0 || H <= 0) return std::vector<float>();

    // UTF-8 → UTF-16（GDI W 系 API；错误文本含中文前缀）
    // 转换失败/空文本 → 纯品红（无信息可画，保持旧占位语义）
    int wlen = 0;
    if (!errUtf8.empty()) {
        wlen = MultiByteToWideChar(CP_UTF8, 0, errUtf8.c_str(),
                                   (int)errUtf8.size(), nullptr, 0);
    }
    if (wlen <= 0) return magentaFloatBuffer(W, H);
    std::wstring wtext((size_t)wlen, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, errUtf8.c_str(), (int)errUtf8.size(),
                        &wtext[0], wlen);

    // bottom-up DIB：biHeight 正值 → 内存 row 0 = 底行（GL 读回行序）
    BITMAPINFO bmi = {};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = (LONG)W;
    bmi.bmiHeader.biHeight = (LONG)H;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;

    void* bits = nullptr;
    HDC hdc = CreateCompatibleDC(nullptr);
    if (!hdc) return magentaFloatBuffer(W, H);
    HBITMAP dib = CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
    if (!dib || !bits) {
        DeleteDC(hdc);
        return magentaFloatBuffer(W, H);
    }
    HGDIOBJ oldBmp = SelectObject(hdc, dib);

    // 品红底 + 白色粗体文本（字体族按当前语言取：zh-CN 微软雅黑，ja/ko 等各自
    // 界面字体；GDI 找不到该字体时自行回退系统默认字体，仍可绘制）。字号随帧高
    // 缩放（1080p ≈ 30px），钳制 [14,64]：太小于 AE 预览缩放下不可读，太大挤压行数。
    const size_t pixelCount = (size_t)W * (size_t)H;
    fillMagenta(static_cast<unsigned char*>(bits), pixelCount);

    // (std::min)/(std::max) 括号形式：windows.h 的 min/max 宏与裸 std::min/max 冲突
    const long fontH = (std::max)(14L, (std::min)(64L, H / 36));
    HFONT font = CreateFontW(-((LONG)fontH), 0, 0, 0, FW_BOLD, FALSE, FALSE,
                            FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                            CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_DONTCARE, i18n::uiFontFamilyGDI());
    HGDIOBJ oldFont = font ? SelectObject(hdc, font) : nullptr;
    SetTextColor(hdc, RGB(255, 255, 255));
    SetBkMode(hdc, TRANSPARENT);

    // 文本区：四周留 fontH/2 边距；DT_WORDBREAK 自动换行（超长错误按
    // rect 高度裁剪，完整文本在 error.log）
    RECT rc;
    rc.left = fontH / 2;
    rc.top = fontH / 2;
    rc.right = (LONG)W - fontH / 2;
    rc.bottom = (LONG)H - fontH / 2;
    if (rc.right > rc.left && rc.bottom > rc.top) {
        DrawTextW(hdc, wtext.c_str(), (int)wtext.size(), &rc,
                  DT_WORDBREAK | DT_NOPREFIX | DT_EXTERNALLEADING);
    }

    // font 创建成功但 SelectObject 失败时 oldFont 为 nullptr——旧清理
    // 条件 `if (oldFont)` 会跳过整块，CreateFontW 的 HFONT 泄漏（GDI 句柄一条）。
    // 拆开：选中成功才需要还原旧字体；只要 font 非空就必须 DeleteObject（DeleteObject
    // 对未选中的 HFONT 同样是正确释放）。
    if (oldFont) SelectObject(hdc, oldFont);
    if (font) DeleteObject(font);
    SelectObject(hdc, oldBmp);

    // bottom-up DIB 字节序 BGRA → RGBA float（行序已是底行序，无需翻转）。
    // 必须在 DeleteObject(dib) 之前拷贝——DIB 删除后 bits 内存即释放。
    std::vector<float> back(pixelCount * 4, 1.0f);
    const unsigned char* px = static_cast<const unsigned char*>(bits);
    for (long y = 0; y < H; ++y) {
        const unsigned char* row = px + (size_t)y * (size_t)W * 4;
        float* dst = back.data() + (size_t)y * (size_t)W * 4;
        for (long x = 0; x < W; ++x) {
            dst[x * 4 + 0] = row[x * 4 + 2] / 255.0f;  // R
            dst[x * 4 + 1] = row[x * 4 + 1] / 255.0f;  // G
            dst[x * 4 + 2] = row[x * 4 + 0] / 255.0f;  // B
            dst[x * 4 + 3] = 1.0f;                     // A
        }
    }
    DeleteObject(dib);
    DeleteDC(hdc);
    return back;
}

} // namespace host
