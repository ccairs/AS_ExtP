// geom.h — 纯几何函数（无 Win32 / AE SDK 依赖，供单元测试）
#pragma once
#include <cmath>

namespace hotbox {

constexpr double kPi = 3.14159265358979323846;

inline double degToRad(double deg) { return deg * kPi / 180.0; }

// 最短角差（有符号，[-180,180]）
inline double angleDelta(double fromDeg, double toDeg) {
    double d = std::fmod(toDeg - fromDeg, 360.0);
    if (d > 180.0) d -= 360.0;
    if (d < -180.0) d += 360.0;
    return d;
}

struct SegmentLayout {
    int segCount;      // 弧段数
    double gapDeg;     // 相邻弧段间隙(度)
    double startDeg;   // 第 0 段起始角(度，0=右，90=下)
};

// 点(px,py)相对圆心(cx,cy)的环带归属弧段下标；不在环带返回 -1。
inline int segmentHitTest(double cx, double cy, double px, double py,
                          double rIn, double rOut, const SegmentLayout& lay) {
    double dx = px - cx, dy = py - cy;
    double dist = std::sqrt(dx * dx + dy * dy);
    if (dist < rIn || dist > rOut) return -1;
    double ang = std::atan2(dy, dx) * 180.0 / kPi;               // [-180,180]
    double span = (360.0 - lay.gapDeg * lay.segCount) / lay.segCount;
    for (int i = 0; i < lay.segCount; ++i) {
        double s = lay.startDeg + i * (span + lay.gapDeg);
        double d = angleDelta(s, ang);   // 段 i 覆盖 [s, s+span]，与测试注释一致
        if (d >= 0.0 && d <= span) return i;
    }
    return -1;
}

struct Rect { double l, t, r, b; };

// 由中心+半径+角度(度)求点坐标
inline void polarToXY(double cx, double cy, double radius, double angDeg,
                      double* px, double* py) {
    *px = cx + radius * std::cos(degToRad(angDeg));
    *py = cy + radius * std::sin(degToRad(angDeg));
}

// 结果列表选中行环绕（↑↓ 键与滚轮同一口径：单一来源，不各写一份漂移）：
// sel + delta 越界时从另一端绕回——首行继续上滚到末行、末行继续下滚到首行。
// count <= 0（无结果）返回 0：选中行无意义时的唯一合法值。
// 单条结果时环绕回自身（调用方可据「返回值 == 原值」跳过重绘）。
inline int wrapSel(int sel, int delta, int count) {
    if (count <= 0) return 0;
    int n = (sel + delta) % count;
    if (n < 0) n += count;
    return n;
}

// 窗口顶部纵向钳制：面板尽量完整落在工作区内——底边不够时整体上移，整面板高于工作区时
// 从工作区顶部起（底部溢出）。只保搜索栏可见不够：面板向下生长，空查询默认带列表后
// 底边呼出会把整份列表放到屏外。（抽成纯函数便于单测：贴底 / 高于整屏 / 正常三态）
inline int clampTopForHeight(int top, int winH, int workTop, int workBottom) {
    if (top + winH > workBottom) top = workBottom - winH;
    if (top < workTop) top = workTop;
    return top;
}

} // namespace hotbox
