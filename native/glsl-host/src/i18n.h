// i18n.h —— 效果宿主的本地化入口。
//
// 文案 id 与文案表都来自生成物：i18nIds.inc / i18nStrings.inc 由
// tools/i18n/build-native-strings.js 依据 i18n/native/effecthost.json 与
// i18n/native/translations/<locale>.json 生成，本文件不含任何文案。
#pragma once

#include <string>

#include "i18nRuntime.h"
#include "i18nIds.inc"

// 当前语言下的 UTF-8 文案；id 必须是 StrId 枚举值。越界 id 返回空串（不读表外内存）。
const char* Tr(StrId id);

// 指定语言的 UTF-8 文案（与 Tr 同一张表）：语言下标或 id 越界返回空串。
// 供「当前语言不可用时回退到别的语言」使用，不改变当前语言。
const char* TrIn(int localeIndex, StrId id);

// 同上，宽字符版本（GDI 错误帧与参数名写入直接用）。
inline std::wstring TrW(StrId id) {
    return i18n::widen(Tr(id));
}
