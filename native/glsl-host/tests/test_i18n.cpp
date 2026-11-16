// test_i18n.cpp —— 效果宿主的本地化运行时与生成文案表（不依赖 AE SDK）。
//
// 判据：
//   ① tag 解析：前缀大小写不敏感、'_'/'-' 等价、规范 tag 与表行自洽；
//      不支持的语言 → en-US；取不到 tag（nullptr/空串/纯空白）→ zh-CN；
//   ② 环境变量 AS_EXTP_NATIVE_LOCALE 优先于宿主 tag，取值同样过映射；
//   ③ 字体族按语言返回；widen 的 UTF-8→UTF-16 往返与非法输入降级；
//   ④ 生成表：每个语言每个 StrId 非空；ja/ko/de/fr/ru 抽样命中该语言字符、en 不残留中文。
//      译文未生成时六语言行整行回落 zh，④ 的抽样断言会失败——那是「译文没落地」的显式红灯。
// 失败信息走 stderr 并在 abort 前 flush：本文件以 abort 收尾（glsl_core_tests 的 main 不计数
// 返回值），stdout 的缓冲内容在 abort 时会丢，ctest --output-on-failure 就看不到失败点。
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <string>
#include <windows.h>

#include "i18n.h"

namespace {

int g_fail = 0;

#define CHECK(cond) do { \
    if (!(cond)) { std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); ++g_fail; } \
} while (0)

const char* const kLocaleTags[i18n::kLocaleCount] = {
    "zh-CN", "en-US", "ja-JP", "de-DE", "ko-KR", "fr-FR", "ru-RU"
};

const wchar_t kOverrideEnv[] = L"AS_EXTP_NATIVE_LOCALE";

void setOverride(const wchar_t* value) {
    ::SetEnvironmentVariableW(kOverrideEnv, value);
}

int countStrings(int localeIndex, bool (*hit)(const wchar_t*)) {
    i18n::setLocaleTag(kLocaleTags[localeIndex]);
    int count = 0;
    for (int id = 0; id < S_COUNT; ++id) {
        const std::wstring wide = i18n::widen(Tr(static_cast<StrId>(id)));
        if (hit(wide.c_str())) ++count;
    }
    return count;
}

bool hasKana(const wchar_t* text) {
    for (const wchar_t* p = text; *p; ++p) {
        if ((*p >= 0x3040 && *p <= 0x30FF) || (*p >= 0x31F0 && *p <= 0x31FF)) return true;
    }
    return false;
}

bool hasCyrillic(const wchar_t* text) {
    for (const wchar_t* p = text; *p; ++p) {
        if (*p >= 0x0400 && *p <= 0x04FF) return true;
    }
    return false;
}

bool hasHangul(const wchar_t* text) {
    for (const wchar_t* p = text; *p; ++p) {
        if ((*p >= 0xAC00 && *p <= 0xD7AF) || (*p >= 0x1100 && *p <= 0x11FF)) return true;
    }
    return false;
}

bool hasGermanUmlaut(const wchar_t* text) {
    for (const wchar_t* p = text; *p; ++p) {
        if (*p == 0x00E4 || *p == 0x00F6 || *p == 0x00FC || *p == 0x00DF
            || *p == 0x00C4 || *p == 0x00D6 || *p == 0x00DC) return true;
    }
    return false;
}

bool hasFrenchAccent(const wchar_t* text) {
    const wchar_t kAccents[] = L"éèêàçùôîûëïœÉÈÊÀÇÙÔÎÛËÏ";
    for (const wchar_t* p = text; *p; ++p) {
        if (std::wcschr(kAccents, *p)) return true;
    }
    return false;
}

bool hasCjk(const wchar_t* text) {
    for (const wchar_t* p = text; *p; ++p) {
        if (*p >= 0x4E00 && *p <= 0x9FFF) return true;
    }
    return false;
}

void test_locale_tags() {
    setOverride(nullptr);
    struct TagCase {
        const char* tag;
        const char* expectTag;
        int expectIndex;
    };
    const TagCase cases[] = {
        {"en_US", "en-US", i18n::kLocaleEnUS},
        {"en-US", "en-US", i18n::kLocaleEnUS},
        {"EN_us", "en-US", i18n::kLocaleEnUS},
        {"en", "en-US", i18n::kLocaleEnUS},
        {"ja_JP", "ja-JP", i18n::kLocaleJaJP},
        {"ja-JP", "ja-JP", i18n::kLocaleJaJP},
        {"zh_CN", "zh-CN", i18n::kLocaleZhCN},
        {"zh_TW", "zh-CN", i18n::kLocaleZhCN},
        {"de_DE", "de-DE", i18n::kLocaleDeDE},
        {"ko_KR", "ko-KR", i18n::kLocaleKoKR},
        {"fr_FR", "fr-FR", i18n::kLocaleFrFR},
        {"ru_RU", "ru-RU", i18n::kLocaleRuRU},
        {"  ja-JP  ", "ja-JP", i18n::kLocaleJaJP},
        {"es_ES", "en-US", i18n::kLocaleEnUS},   // 检测到但不支持 → en-US
        {"", "zh-CN", i18n::kLocaleZhCN},
        {"   ", "zh-CN", i18n::kLocaleZhCN},
        {nullptr, "zh-CN", i18n::kLocaleZhCN},
    };
    for (const TagCase& c : cases) {
        i18n::setLocaleTag(c.tag);
        CHECK(std::strcmp(i18n::localeTag(), c.expectTag) == 0);
        CHECK(i18n::localeIndex() == c.expectIndex);
        CHECK(std::strcmp(i18n::localeTag(), kLocaleTags[i18n::localeIndex()]) == 0);
    }
}

void test_env_override() {
    setOverride(L"ja_JP");
    i18n::setLocaleTag("en_US");
    CHECK(i18n::localeIndex() == i18n::kLocaleJaJP);
    CHECK(std::strcmp(i18n::localeTag(), "ja-JP") == 0);
    CHECK(i18n::localeOverride() == "ja_JP");

    setOverride(L"de-DE");
    i18n::setLocaleTag("zh_CN");
    CHECK(i18n::localeIndex() == i18n::kLocaleDeDE);

    setOverride(L"xx_YY");
    i18n::setLocaleTag("ja_JP");
    CHECK(i18n::localeIndex() == i18n::kLocaleEnUS);

    setOverride(L"");
    i18n::setLocaleTag("fr_FR");
    CHECK(i18n::localeIndex() == i18n::kLocaleFrFR);

    setOverride(nullptr);
    CHECK(i18n::localeOverride().empty());
    i18n::setLocaleTag("ru_RU");
    CHECK(i18n::localeIndex() == i18n::kLocaleRuRU);
}

void test_fonts_and_widen() {
    i18n::setLocaleTag("zh_CN");
    CHECK(std::wcscmp(i18n::uiFontFamilyD2D(), L"Microsoft YaHei UI") == 0);
    CHECK(std::wcscmp(i18n::uiFontFamilyGDI(), L"Microsoft YaHei") == 0);
    i18n::setLocaleTag("ja_JP");
    CHECK(std::wcscmp(i18n::uiFontFamilyD2D(), L"Yu Gothic UI") == 0);
    CHECK(std::wcscmp(i18n::uiFontFamilyGDI(), L"Yu Gothic") == 0);
    i18n::setLocaleTag("ko_KR");
    CHECK(std::wcscmp(i18n::uiFontFamilyD2D(), L"Malgun Gothic") == 0);
    CHECK(std::wcscmp(i18n::uiFontFamilyGDI(), L"Malgun Gothic") == 0);
    const int latinLocales[] = {i18n::kLocaleEnUS, i18n::kLocaleDeDE, i18n::kLocaleFrFR, i18n::kLocaleRuRU};
    for (int index : latinLocales) {
        i18n::setLocaleTag(kLocaleTags[index]);
        CHECK(std::wcscmp(i18n::uiFontFamilyD2D(), L"Segoe UI") == 0);
        CHECK(std::wcscmp(i18n::uiFontFamilyGDI(), L"Segoe UI") == 0);
    }

    CHECK(i18n::widen(nullptr).empty());
    CHECK(i18n::widen("").empty());
    const std::wstring wide = i18n::widen("GLSL 效果");
    CHECK(wide == L"GLSL 效果");
    CHECK(wide.size() == 7);
    CHECK(!i18n::widen("\xff\xfe").empty());
}

void test_tables() {
    CHECK(S_COUNT > 0);
    for (int loc = 0; loc < i18n::kLocaleCount; ++loc) {
        i18n::setLocaleTag(kLocaleTags[loc]);
        CHECK(i18n::localeIndex() == loc);
        for (int id = 0; id < S_COUNT; ++id) {
            const char* text = Tr(static_cast<StrId>(id));
            CHECK(text != nullptr && text[0] != '\0');
        }
    }
    CHECK(std::strcmp(Tr(static_cast<StrId>(-1)), "") == 0);
    CHECK(std::strcmp(Tr(static_cast<StrId>(S_COUNT)), "") == 0);

    struct SampleCase {
        int locale;
        bool (*hit)(const wchar_t*);
        const char* what;
    };
    const SampleCase samples[] = {
        {i18n::kLocaleJaJP, &hasKana, "ja-JP 应含假名（译文未生成时整行为 zh）"},
        {i18n::kLocaleRuRU, &hasCyrillic, "ru-RU 应含西里尔（译文未生成时整行为 zh）"},
        {i18n::kLocaleKoKR, &hasHangul, "ko-KR 应含谚文（译文未生成时整行为 zh）"},
        {i18n::kLocaleDeDE, &hasGermanUmlaut, "de-DE 应含变音（译文未生成时整行为 zh）"},
        {i18n::kLocaleFrFR, &hasFrenchAccent, "fr-FR 应含重音（译文未生成时整行为 zh）"},
    };
    for (const SampleCase& s : samples) {
        const int hits = countStrings(s.locale, s.hit);
        if (hits > 0) {
            std::printf("PASS i18n 抽样 %s（%d 串命中）\n", kLocaleTags[s.locale], hits);
        } else {
            std::fprintf(stderr, "FAIL i18n 抽样 %s：%s\n", kLocaleTags[s.locale], s.what);
            ++g_fail;
        }
    }
    const int enCjk = countStrings(i18n::kLocaleEnUS, &hasCjk);
    if (enCjk == 0) {
        std::printf("PASS i18n 抽样 en-US 无中文残留\n");
    } else {
        std::fprintf(stderr, "FAIL i18n 抽样 en-US：%d 串残留中文\n", enCjk);
        ++g_fail;
    }
    i18n::setLocaleTag("zh_CN");
}

} // namespace

void runI18nTests() {
    setOverride(nullptr);
    test_locale_tags();
    test_env_override();
    test_fonts_and_widen();
    test_tables();
    setOverride(nullptr);
    std::fflush(stdout);
    if (g_fail != 0) {
        std::fprintf(stderr, "I18N TESTS FAILED (%d 条)\n", g_fail);
        std::abort();
    }
    std::printf("PASS test_i18n (tag/覆盖/字体/widen/生成表 %d 串 x %d 语言)\n",
                static_cast<int>(S_COUNT), static_cast<int>(i18n::kLocaleCount));
}
