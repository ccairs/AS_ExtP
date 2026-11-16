#pragma once
// uiNoticePolicy.h —— ECW 槽位栏与文件选择器的「GLSL 文件已丢失」提醒：判据与文案
// （纯逻辑，不依赖 AE SDK）
//
// 判据：身份名非空且按名解析不到才算丢失；名字为空（无身份，按位置回退）不提醒。
// 文案按槽位分配：slot 0 显示丢失的文件名，slot 1 显示后果与操作指引，其余槽位返回
// 空串（调用方维持未使用槽位的灰色占位）。文案不做截断，绘制侧按可用宽度省略。
// 文案文本来自 i18n 表（随宿主语言），插值只做字符串代入。
#include <string>

#include "i18n.h"

namespace host {

// 丢失判据：身份名非空且按名解析失败（resolvedIndex < 0）。
inline bool shaderFileLost(const std::string& rememberedName, int resolvedIndex) {
    return !rememberedName.empty() && resolvedIndex < 0;
}

// 槽位栏提醒文案：slot 0 = 丢失的文件名；slot 1 = 后果与操作指引；其余槽位 = 空串。
inline std::string slotLostNotice(int slot, const std::string& rememberedName) {
    if (slot == 0) {
        // 模板恰含一个 %s（生成器校验占位符序列）：把文件名原样代入，不截断。
        std::string text(Tr(S_EFFECTHOST_UINOTICE_FILE_LOST));
        const size_t pos = text.find("%s");
        if (pos != std::string::npos) text.replace(pos, 2, rememberedName);
        return text;
    }
    if (slot == 1) return Tr(S_EFFECTHOST_UINOTICE_PASSTHROUGH);
    return std::string();
}

} // namespace host
