// test_geom.cpp — 纯几何函数单元测试（不依赖 Win32 / AE SDK）
#include "geom.h"
#include <cstdio>

static int g_fail = 0;
#define CHECK(cond) do { \
    if (!(cond)) { \
        std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
        ++g_fail; \
    } \
} while (0)

int run_geom_tests() {
    using namespace hotbox;

    // —— 弧段命中测试：6 段、每段 6° 间隙、起始 -90° ——
    SegmentLayout lay = { 6, 6.0, -90.0 };
    // 第 0 段：-90° ~ -36°（span=(360-36)/6=54）
    CHECK(segmentHitTest(0, 0, 100, -100, 90, 210, lay) == 0);   // 中心右上的环内点，角度 -45°
    CHECK(segmentHitTest(0, 0, 100, 100, 90, 210, lay) == 2);    // 角度 45°，应在第 2 段
    CHECK(segmentHitTest(0, 0, 0, 0, 90, 210, lay) == -1);       // 中心圆内 → -1
    CHECK(segmentHitTest(0, 0, 300, 0, 90, 210, lay) == -1);     // 环外 → -1
    CHECK(segmentHitTest(0, 0, 105, 0, 90, 210, lay) == 1);      // 角度 0°（右），应在第 1 段
    CHECK(segmentHitTest(0, 0, -105, 0, 90, 210, lay) == 4);     // 角度 180°（左），应在第 4 段

    // —— polarToXY 与 hit-test 一致性（闭环）——
    double px, py;
    polarToXY(100, 100, 150, -45.0, &px, &py);
    CHECK(segmentHitTest(100, 100, px, py, 90, 210, lay) == 0);

    // —— 结果列表选中行环绕（↑↓ 键与滚轮同一口径）——
    CHECK(wrapSel(0, -1, 5) == 4);    // 首行继续上滚 → 末行
    CHECK(wrapSel(4, 1, 5) == 0);     // 末行继续下滚 → 首行
    CHECK(wrapSel(2, 1, 5) == 3);     // 常规移动
    CHECK(wrapSel(2, -1, 5) == 1);
    CHECK(wrapSel(0, 1, 5) == 1);
    CHECK(wrapSel(4, -1, 5) == 3);
    CHECK(wrapSel(0, -1, 1) == 0);    // 单条结果：环绕回自身
    CHECK(wrapSel(0, 1, 1) == 0);
    CHECK(wrapSel(0, -1, 0) == 0);    // 无结果：选中行唯一合法值 0
    CHECK(wrapSel(0, 1, 0) == 0);
    CHECK(wrapSel(-1, 1, 3) == 0);    // 脏输入（负选中）：落到首行而非越界
    CHECK(wrapSel(0, -3, 4) == 1);    // 多格步长（滚轮连滚）同样环绕

    // —— 窗口顶部纵向钳制（底边呼出时整面板上移；整面板高于工作区时从顶起）——
    CHECK(clampTopForHeight(900, 256, 0, 1040) == 784);   // 底部溢出 → 上移到面板底贴工作区底
    CHECK(clampTopForHeight(100, 256, 0, 1040) == 100);   // 空间足够 → 不动
    CHECK(clampTopForHeight(-50, 256, 0, 1040) == 0);     // 顶部越界 → 钳到工作区顶
    CHECK(clampTopForHeight(-200, 2000, 0, 1040) == 0);   // 面板高于整屏 → 从工作区顶起（底部溢出）
    CHECK(clampTopForHeight(120, 0, 0, 1040) == 120);     // 零高面板不改变位置
    CHECK(clampTopForHeight(80, 256, -1080, 0) == -256);  // 副屏负坐标工作区：面板底贴工作区底（0-256）

    return g_fail;
}
