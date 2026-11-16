#include "i18n.h"

// 文案表：[语言][StrId]，行序 = i18n::localeIndex()，由生成器按 manifest 顺序写入。
#include "i18nStrings.inc"

// 表维度必须与运行时的语言数、枚举的字符串数一致；生成器与运行时分头演化时在编译期报错。
static_assert(sizeof(kI18nTables) / sizeof(kI18nTables[0]) == static_cast<size_t>(i18n::kLocaleCount),
              "i18nStrings.inc 的言行数与 i18n::kLocaleCount 不一致：请重新运行 tools/i18n/build-native-strings.js");
static_assert(sizeof(kI18nTables[0]) / sizeof(kI18nTables[0][0]) == static_cast<size_t>(S_COUNT),
              "i18nStrings.inc 的列数与 StrId::S_COUNT 不一致：请重新运行 tools/i18n/build-native-strings.js");

const char* Tr(StrId id) {
    const int locale = i18n::localeIndex();
    const int stringId = static_cast<int>(id);
    if (locale < 0 || locale >= i18n::kLocaleCount) return "";
    if (stringId < 0 || stringId >= S_COUNT) return "";
    return kI18nTables[locale][stringId];
}

const char* TrIn(int localeIndex, StrId id) {
    const int stringId = static_cast<int>(id);
    if (localeIndex < 0 || localeIndex >= i18n::kLocaleCount) return "";
    if (stringId < 0 || stringId >= S_COUNT) return "";
    return kI18nTables[localeIndex][stringId];
}
