#pragma once
// pixelConvert.h —— AE world 像素 ↔ RGBA float 的批量转换（不依赖 AE SDK，可单测）
//
// 从 renderer.cpp 抽出：这两个函数是每帧最大的纯 CPU 开销
// （实测 1080p 8bit 合计 10.6ms/帧，且**每个映射图层/历史帧各再来一遍**），
// 抽出后①可向量化②能被 glsl_core_tests 直接验证等价性（renderer.cpp 依赖
// glad/AE SDK，测试链接不进去）。语义与标量路径逐位一致，逐字节比对
// 的标量参照。
#include <cstdint>
#include "pixelDepth.h"

namespace host {

// AE world（顶行起始、通道内存序 A R G B、8/16/32bit）→ RGBA float（底行起始 R G B A）。
// 一次完成「通道重排」+「上下翻转」：输出第 0 行 = AE 最后一行。
// src 指向 AE 首行（顶行）首字节，rowbytes 为行距；dst 长度须 ≥ w*h*4。
// 通道归一化：8bit ÷255；16bit ÷32768（PF_MAX_CHAN16，即 1.0 = 32768）；32bit 原样。
void convertWorldToRgba(const void* src, int32_t rowbytes, int32_t w, int32_t h,
                        PixelDepth depth, float* dst);

// RGBA float（底行起始）→ AE world（顶行起始、A R G B）。
// back 为 GL 读回缓冲（第 0 行 = 画面底行），w/h 为读回缓冲尺寸；
// dstRowbytes/outW/outH 为输出 world 的行距与尺寸，行列均取与读回缓冲的较小值防越界。
// 归一化（与既有实现一致）：8bit → 钳 [0,1] 后 v*255+0.5 截断；16bit → 钳 [0,1] 后
// v*32768+0.5 截断（1.0 = 32768，不是 65535）；32bit 原样拷贝（仅通道重排）。
void writeOutputWorld(void* dst, int32_t dstRowbytes, int32_t outW, int32_t outH,
                      const float* back, int32_t w, int32_t h, PixelDepth depth);

// BGRA8 读回缓冲（第 0 行 = 画面底行；内存序 A R G B，由 GL_BGRA +
// GL_UNSIGNED_INT_8_8_8_8 在小端机上落成）→ AE 8bit world（顶行起始）。
// 只做行倒序拷贝 + 尺寸钳制，**无逐像素处理**：通道序已由 GL 的读回格式给定。
// 行列均取与读回缓冲的较小值防越界；每行拷 min(w, outW)*4 字节。
void copyBgra8ToWorld8(void* dst, int32_t dstRowbytes, int32_t outW, int32_t outH,
                       const uint8_t* src, int32_t w, int32_t h);

} // namespace host
