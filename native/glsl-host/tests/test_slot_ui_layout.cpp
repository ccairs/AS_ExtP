// test_slot_ui_layout.cpp —— 槽位自绘控件的**多行布局**纯逻辑单测（不依赖 AE SDK）
//
// 背景：点控件（Vec2/Vec3）由"一行内并排分量列"改为"每个分量独占
// 一行"——并排时 Vec3 每列扣掉标签与数值框后滑轨只剩几像素，几乎拖不动。
// 改版后有两处必须一致、且出错就肉眼可见的约定，故用单测钉住：
//   ① 行数（params.h slotUiRows）：注册行高 = kSlotUiHeight × 行数，绘制按行数分行。
//      两处口径不一致 → 行被裁掉或行内大片留白。
//      颜色命名的 vec2/vec3 走色块控件（单行），这里最容易写错成 2/3 行。
//   ② 行带切分（params.h slotRowBand）：相邻行边界必须严格相接、每行高度 ≥1px。
//      相接出错 → 行间出现空隙或压线；出现 0 高行 → 该行拖拽带为空，彻底点不动。
// Release（CMake 默认 /DNDEBUG）会把 assert 编译成空操作——本文件
// 漏了 #undef，18 条断言在 Release 下空转（"ALL TESTS PASSED" 只证明不崩溃）。
// #undef 必须在所有头包含之前。
#undef NDEBUG
#include <cassert>
#include <iostream>

#include "params.h"   // slotUiRows / slotRowBand（含 uniformParser.h，无 AE SDK 依赖）

namespace {

glsl::Param mkParam(glsl::ParamType t, const char* name) {
    glsl::Param p;
    p.type = t;
    p.name = name;
    return p;
}

// —— ① 行数判据 ——
void test_slot_ui_rows() {
    // 单行控件
    assert(host::slotUiRows(mkParam(glsl::ParamType::Float, "uAmount")) == 1);
    assert(host::slotUiRows(mkParam(glsl::ParamType::Vec4, "uTint4")) == 1);
    // 点控件：每个分量一行
    assert(host::slotUiRows(mkParam(glsl::ParamType::Vec2, "uOffset")) == 2);
    assert(host::slotUiRows(mkParam(glsl::ParamType::Vec3, "uTint")) == 3);
    // 颜色命名 → 走色块（单行），不能按分量给 2/3 行，否则注册出"空行"
    assert(host::slotUiRows(mkParam(glsl::ParamType::Vec3, "uColor")) == 1);
    assert(host::slotUiRows(mkParam(glsl::ParamType::Vec3, "backgroundColor")) == 1);
    assert(host::slotUiRows(mkParam(glsl::ParamType::Vec2, "uColour")) == 1);
    // 反例词汇（isColorNamed 的词法边界）：不是颜色语义 → 仍按分量分行
    assert(host::slotUiRows(mkParam(glsl::ParamType::Vec3, "uCoulomb")) == 3);
    std::cout << "PASS test_slot_ui_rows\n";
}

// —— ② 行带切分 ——
void test_slot_row_band() {
    // 正常：AE 实测给槽位行的控件框是注册高度 -2px（注册 22 → 实收 20）
    struct Case { int top, bottom, rows; };
    const Case cases[] = {
        {100, 120, 1},   // 单行
        {100, 140, 2},   // Vec2
        {100, 160, 3},   // Vec3
        {0, 64, 3},      // 顶行（top=0 边界）
        {-30, -10, 3},   // 负坐标（AE 允许）
    };
    for (const Case& c : cases) {
        int prevB = 0;
        for (int r = 0; r < c.rows; ++r) {
            int rt = 0, rb = 0;
            host::slotRowBand(c.top, c.bottom, c.rows, r, &rt, &rb);
            assert(rb > rt);                                  // 每行高度 ≥1px（0 高行点不动）
            assert(rt >= c.top && rb <= c.bottom);            // 不越出控件框
            if (r > 0) assert(rt == prevB);                    // 相邻行严格相接（无空隙/压线）
            if (r == 0) assert(rt == c.top);                   // 首行贴顶
            if (r == c.rows - 1) assert(rb == c.bottom);       // 末行贴底
            prevB = rb;
        }
    }
    // 首行/末行贴边（等分不产生居中留白）
    int rt = 0, rb = 0;
    host::slotRowBand(100, 160, 3, 0, &rt, &rb);
    assert(rt == 100 && rb == 120);
    host::slotRowBand(100, 160, 3, 2, &rt, &rb);
    assert(rt == 140 && rb == 160);
    // 退化：高度小于行数时按下限撑开——不产生 0 高行（宁可略超出框）
    host::slotRowBand(0, 2, 3, 0, &rt, &rb);
    assert(rt == 0 && rb == 1);
    host::slotRowBand(0, 2, 3, 2, &rt, &rb);
    assert(rt == 2 && rb == 3);
    // rows<=0 的防御（不应发生，但不能除零崩溃）
    host::slotRowBand(10, 20, 0, 0, &rt, &rb);
    assert(rb > rt);
    std::cout << "PASS test_slot_row_band\n";
}

} // namespace

void runSlotUiLayoutTests() {
    test_slot_ui_rows();
    test_slot_row_band();
}
