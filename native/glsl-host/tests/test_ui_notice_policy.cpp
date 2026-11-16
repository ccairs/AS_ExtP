// test_ui_notice_policy.cpp —— 槽位栏/文件选择器「GLSL 文件已丢失」提醒的判据与文案单测
//
// 判据与文案在 src/uiNoticePolicy.h（DRAW 热路径，零 I/O）。本文件钉住：
//   ① 判据：只有「身份名非空且按名解析不到」才算丢失；名字为空（无身份，按位置
//      回退）不提醒。
//   ② 文案按槽位分配：slot 0 = 文件名，slot 1 = 后果与操作指引；其余槽位空串
//      （调用方据此维持未使用槽位的灰色占位）。
//   ③ 文件名原样带上，不在文案层截断（绘制侧按可用宽度省略）。
// Release（/DNDEBUG）会把 assert 编成空操作——#undef 必须在所有头包含之前，
// 否则本文件在 Release 下空转（"ALL TESTS PASSED" 只证明不崩溃）。
#undef NDEBUG
#include <cassert>
#include <iostream>
#include <string>

#include "uiNoticePolicy.h"

namespace {

// —— ① 丢失判据 ——
void test_shader_file_lost() {
    // 名字为空 = 无身份 → 按位置回退，不算丢失
    assert(!host::shaderFileLost("", -1));
    assert(!host::shaderFileLost("", 0));
    // 名字命中（resolvedIndex >= 0）→ 没丢
    assert(!host::shaderFileLost("lightball", 0));
    assert(!host::shaderFileLost("lightball", 13));
    // 名字非空但解析不到 → 丢
    assert(host::shaderFileLost("lightball", -1));
    assert(host::shaderFileLost("中文名", -1));
    std::cout << "PASS test_shader_file_lost\n";
}

// —— ②③ 文案：槽位映射 + 文件名原样 ——
void test_slot_lost_notice() {
    // slot 0：文件名原样带上（不截断——绘制侧按宽度省略，硬切会切坏短名/切裂 UTF-8）
    assert(host::slotLostNotice(0, "lightball") == "GLSL 文件已丢失：lightball");
    // slot 1：后果与操作指引
    assert(host::slotLostNotice(1, "lightball") == "已改为透传，请在上方重新选择文件");
    // 其余槽位：空串（调用方退回灰 "-"）
    assert(host::slotLostNotice(2, "lightball").empty());
    assert(host::slotLostNotice(31, "lightball").empty());
    assert(host::slotLostNotice(-1, "lightball").empty());
    // 长文件名不在文案层截断
    const std::string longName(120, 'a');
    assert(host::slotLostNotice(0, longName) == "GLSL 文件已丢失：" + longName);
    // 空名字：判据侧已保证走不到；即使传入也只产出前缀（不崩、不越界）
    assert(host::slotLostNotice(0, "") == "GLSL 文件已丢失：");
    std::cout << "PASS test_slot_lost_notice\n";
}

} // namespace

void runUiNoticePolicyTests() {
    test_shader_file_lost();
    test_slot_lost_notice();
}
