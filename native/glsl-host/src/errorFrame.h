#pragma once
// errorFrame.h —— shader 失败占位帧光栅化
// 品红底 + 白色粗体错误文本（GDI 系统字体渲染，中文/英文均可显示）。
// 纯逻辑层：仅依赖 Win32 GDI 与 std，不依赖 AE SDK / OpenGL，
// 与 glsl_core 单测层同构（renderer.cpp 失败分支调用）。
#include <string>
#include <vector>

namespace host {

// 光栅化失败占位帧。errUtf8 为 UTF-8 错误文本（如
// "shader 编译失败: ERROR: 0:52: ..."，与 error.log 同源）。
// 返回 GL 底行序（row 0 = 底行）的 RGBA float 缓冲（W*H*4），
// 直接喂 renderer 的 writeOutputWorld。W/H 非法或 GDI 失败时
// 返回空 vector（调用方退化为纯品红填充）。
// 失败帧每帧渲染，调用方负责缓存（renderer 侧单条目 (W,H,text) 缓存）。
std::vector<float> rasterizeErrorFrame(long W, long H, const std::string& errUtf8);

} // namespace host
