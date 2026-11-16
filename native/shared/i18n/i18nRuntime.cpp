#include "i18nRuntime.h"

#include <windows.h>

namespace i18n {
namespace {

// 语言前缀 → 规范 tag / 表行下标。前缀比较只取 2 个 ASCII 字母，大小写不敏感，
// 与宿主 tag 的分隔符（'_' / '-'）无关。
struct LocaleEntry {
    char prefix[3];
    const char* tag;
    int index;
};

const LocaleEntry kLocaleEntries[] = {
    {"zh", "zh-CN", kLocaleZhCN},
    {"en", "en-US", kLocaleEnUS},
    {"ja", "ja-JP", kLocaleJaJP},
    {"de", "de-DE", kLocaleDeDE},
    {"ko", "ko-KR", kLocaleKoKR},
    {"fr", "fr-FR", kLocaleFrFR},
    {"ru", "ru-RU", kLocaleRuRU},
};

// 当前语言：默认 zh-CN（无宿主 tag / 单测环境），首次 setLocaleTag 后固定。
int g_localeIndex = kLocaleZhCN;
const char* g_localeTag = "zh-CN";

const wchar_t kEnvVarName[] = L"AS_EXTP_NATIVE_LOCALE";

bool isSpace(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

char lowerAscii(char c) {
    return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c;
}

std::string trimmed(const char* text) {
    if (!text) return std::string();
    std::string s(text);
    size_t begin = 0;
    while (begin < s.size() && isSpace(s[begin])) ++begin;
    size_t end = s.size();
    while (end > begin && isSpace(s[end - 1])) --end;
    return s.substr(begin, end - begin);
}

// 分隔符前的 2 字母前缀命中的语言；前缀少于 2 字符或不在支持列表内返回 nullptr
// （调用方按「检测到但不支持」处理）。
const LocaleEntry* matchPrefix(const std::string& tag) {
    if (tag.size() < 2) return nullptr;
    const char c0 = lowerAscii(tag[0]);
    const char c1 = lowerAscii(tag[1]);
    if (c0 < 'a' || c0 > 'z' || c1 < 'a' || c1 > 'z') return nullptr;
    // 允许 tag 在这里结束（"ja"）或以分隔符继续（"ja_JP"）；其它字符说明不是语言标签
    if (tag.size() > 2 && tag[2] != '_' && tag[2] != '-') return nullptr;
    for (const LocaleEntry& entry : kLocaleEntries) {
        if (entry.prefix[0] == c0 && entry.prefix[1] == c1) return &entry;
    }
    return nullptr;
}

void apply(const LocaleEntry* entry) {
    if (entry) {
        g_localeIndex = entry->index;
        g_localeTag = entry->tag;
        return;
    }
    g_localeIndex = kLocaleZhCN;
    g_localeTag = "zh-CN";
}

// 不支持的语言统一落 en-US（与「取不到标签 → zh-CN」区分）。
void applyUnsupported() {
    g_localeIndex = kLocaleEnUS;
    g_localeTag = "en-US";
}

} // namespace

void setLocaleTag(const char* tag) {
    const std::string overrideTag = localeOverride();
    const std::string effective = overrideTag.empty() ? trimmed(tag) : overrideTag;
    if (effective.empty()) {
        apply(nullptr);
        return;
    }
    const LocaleEntry* entry = matchPrefix(effective);
    if (entry) apply(entry);
    else applyUnsupported();
}

const char* localeTag() {
    return g_localeTag;
}

int localeIndex() {
    return g_localeIndex;
}

std::string localeOverride() {
    wchar_t buf[64] = {};
    const DWORD len = ::GetEnvironmentVariableW(kEnvVarName, buf, static_cast<DWORD>(sizeof(buf) / sizeof(buf[0])));
    // len == 0：未设置或空串；len >= 缓冲长度：变量过长，按未设置处理（不截断成错误语言）
    if (len == 0 || len >= sizeof(buf) / sizeof(buf[0])) return std::string();
    const int need = ::WideCharToMultiByte(CP_UTF8, 0, buf, static_cast<int>(len), nullptr, 0, nullptr, nullptr);
    if (need <= 0) return std::string();
    std::string utf8(static_cast<size_t>(need), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, buf, static_cast<int>(len), &utf8[0], need, nullptr, nullptr);
    return trimmed(utf8.c_str());
}

std::wstring widen(const char* utf8) {
    if (!utf8 || !*utf8) return std::wstring();
    int wideLen = ::MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, -1, nullptr, 0);
    UINT flags = MB_ERR_INVALID_CHARS;
    if (wideLen <= 0) {
        // 非法 UTF-8：去掉错误标志重试（无效字节按 U+FFFD 替换），保证调用方拿到可绘制文本
        flags = 0;
        wideLen = ::MultiByteToWideChar(CP_UTF8, flags, utf8, -1, nullptr, 0);
        if (wideLen <= 0) return std::wstring();
    }
    std::wstring wide(static_cast<size_t>(wideLen), L'\0');
    ::MultiByteToWideChar(CP_UTF8, flags, utf8, -1, &wide[0], wideLen);
    wide.resize(static_cast<size_t>(wideLen) - 1);   // 去掉 MultiByteToWideChar 写入的终止符
    return wide;
}

const wchar_t* uiFontFamilyD2D() {
    switch (g_localeIndex) {
    case kLocaleZhCN: return L"Microsoft YaHei UI";
    case kLocaleJaJP: return L"Yu Gothic UI";
    case kLocaleKoKR: return L"Malgun Gothic";
    default: return L"Segoe UI";
    }
}

const wchar_t* uiFontFamilyGDI() {
    switch (g_localeIndex) {
    case kLocaleZhCN: return L"Microsoft YaHei";
    case kLocaleJaJP: return L"Yu Gothic";
    case kLocaleKoKR: return L"Malgun Gothic";
    default: return L"Segoe UI";
    }
}

} // namespace i18n
