// capture.h — 合成预览图：AEGP 渲染活动合成 + 剪切板 PNG(带 alpha)+DIB / WIC PNG / WIC JPG
#pragma once
#include <windows.h>   // HWND（保存对话框 owner）
#include <string>
#include <vector>

namespace capture {

// 渲染结果：BGRA（顶朝下，行 stride = w*4）
struct Frame {
    int w = 0, h = 0;
    std::vector<unsigned char> px;
    std::string compNameUtf8;   // 合成名（默认保存文件名用）
    bool valid() const { return w > 0 && h > 0 && px.size() == (size_t)w * h * 4; }
};

// 渲染活动合成当前时间帧（AE 主线程调用；>2s 的渲染 AE 自带进度弹窗可取消）。
// 8bpc / 100% 采样。keepAlpha=false 预乘于合成背景色（保存动作，观感与合成视图一致）；
// keepAlpha=true 走 STRAIGHT（不拼合背景，保留合成自身 alpha，供剪切板 PNG 表达透明）。
// 失败时 err 返回原因。
bool renderActiveComp(Frame* out, std::string* err, bool keepAlpha = false);

// 三动作（先 renderActiveComp 再调用）。成功 msgOut 返回反馈气泡文本（如「已保存 …」）；
// 失败 errOut 返回原因。保存类在用户取消对话框时返回 true（msg=已取消，非错误）。
// copyToClipboard 以注册格式 "PNG"（32bpp 带 alpha，需 keepAlpha=true 渲染的帧）为主，
// 另附 CF_DIB 回退供不认识 PNG 格式的消费者取图。
bool copyToClipboard(const Frame& f, std::string* msgOut, std::string* errOut);
bool saveAsPng(const Frame& f, HWND owner, std::string* msgOut, std::string* errOut);
bool saveAsJpg(const Frame& f, HWND owner, std::string* msgOut, std::string* errOut);

} // namespace capture
