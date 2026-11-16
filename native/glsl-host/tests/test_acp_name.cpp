// test_acp_name.cpp —— 参数名 ACP 有界拷贝（src/acpName.h copyAcpBounded）单测。
//
// 判据：
//   ① 输出字节数 ≤ 缓冲上限（AE 参数名缓冲 32 字节 → 最多 31），末尾 NUL，不越界写；
//   ② 截断只发生在完整字符边界（DBCS 代码页上不切半个双字节字符）；
//   ③ ASCII / 中文 / 西里尔 / 假名 / 谚文 / 混合 / 代理对，31/32 字节边界，空串与空缓冲；
//   ④ zh 参数名与整串转 ACP 的字节结果一致（zh 输出不变量）。
// 期望值由本文件的独立实现（整串转 ACP + 逐字符累计）给出，不复用被测函数。
#undef NDEBUG
#include <cassert>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

#include <windows.h>

#include "acpName.h"
#include "i18n.h"

namespace {

// 对照用的整串 ACP 转换：UTF-8 → UTF-16 → 系统代码页，不做字节截断。
std::string wholeUtf8ToAcp(const char* utf8) {
    if (!utf8 || !*utf8) return std::string();
    const int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
    if (wlen <= 1) return std::string();
    std::wstring wide(static_cast<size_t>(wlen), L'\0');
    if (MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &wide[0], wlen) != wlen) return std::string();
    const int alen = WideCharToMultiByte(CP_ACP, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (alen <= 1) return std::string();
    std::string acp(static_cast<size_t>(alen), '\0');
    if (WideCharToMultiByte(CP_ACP, 0, wide.c_str(), -1, &acp[0], alen, nullptr, nullptr) != alen) {
        return std::string();
    }
    acp.resize(static_cast<size_t>(alen - 1));   // 去掉尾零
    return acp;
}

// 规格期望：逐字符转 ACP，整字符放得下才追加（与实现独立：先整串转 UTF-16，再逐字符取值）。
std::string expectedPrefix(const char* utf8, size_t dstSize) {
    if (!utf8 || !*utf8 || dstSize == 0) return std::string();
    const int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
    if (wlen <= 1) return std::string();
    std::wstring wide(static_cast<size_t>(wlen), L'\0');
    if (MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &wide[0], wlen) != wlen) return std::string();
    wide.resize(static_cast<size_t>(wlen - 1));
    const size_t limit = dstSize - 1;
    std::string out;
    for (size_t i = 0; i < wide.size(); ++i) {
        size_t units = 1;
        if (wide[i] >= 0xD800 && wide[i] <= 0xDBFF && i + 1 < wide.size() &&
            wide[i + 1] >= 0xDC00 && wide[i + 1] <= 0xDFFF) {
            units = 2;
        }
        char acp[8] = {0};
        const int n = WideCharToMultiByte(CP_ACP, 0, &wide[i], static_cast<int>(units),
                                          acp, static_cast<int>(sizeof(acp)), nullptr, nullptr);
        if (n <= 0) break;
        if (out.size() + static_cast<size_t>(n) > limit) break;
        out.append(acp, static_cast<size_t>(n));
        i += units - 1;
    }
    return out;
}

// ACP 字节串是否「整字符」序列：解回 UTF-16 再整串编码应逐字节还原。
// 半个双字节字符（孤立前导字节 / 截断的尾字节）会破坏该往返。
bool acpWellFormed(const std::string& acp) {
    if (acp.empty()) return true;
    const int wlen = MultiByteToWideChar(CP_ACP, 0, acp.data(), static_cast<int>(acp.size()),
                                         nullptr, 0);
    if (wlen <= 0) return false;
    std::wstring wide(static_cast<size_t>(wlen), L'\0');
    if (MultiByteToWideChar(CP_ACP, 0, acp.data(), static_cast<int>(acp.size()),
                            &wide[0], wlen) != wlen) {
        return false;
    }
    const int alen = WideCharToMultiByte(CP_ACP, 0, wide.c_str(), static_cast<int>(wide.size()),
                                         nullptr, 0, nullptr, nullptr);
    if (alen != static_cast<int>(acp.size())) return false;
    std::string back(static_cast<size_t>(alen), '\0');
    if (WideCharToMultiByte(CP_ACP, 0, wide.c_str(), static_cast<int>(wide.size()),
                            &back[0], alen, nullptr, nullptr) != alen) {
        return false;
    }
    return back == acp;
}

// 调 helper：dstSize 字节缓冲 + 4 字节哨兵，检查不越界、NUL 结尾、无内嵌 NUL。
std::string run(const char* utf8, size_t dstSize) {
    std::vector<char> buf(dstSize + 4, '#');
    const size_t n = host::copyAcpBounded(utf8, buf.data(), dstSize);
    if (dstSize == 0) {
        assert(n == 0);
        for (char c : buf) assert(c == '#');   // 空缓冲一个字节都不写
        return std::string();
    }
    assert(n <= dstSize - 1);
    assert(buf[n] == '\0');
    assert(std::strlen(buf.data()) == n);       // 无内嵌 NUL
    for (size_t i = dstSize; i < buf.size(); ++i) assert(buf[i] == '#');   // 不越界
    return std::string(buf.data(), n);
}

void check_input(const char* text) {
    const std::string full = wholeUtf8ToAcp(text);
    const std::string got = run(text, 32);
    assert(got.size() <= 31);
    assert(acpWellFormed(got));                            // 不切半个字符
    assert(got == expectedPrefix(text, 32));               // 边界截断 = 逐字符累计
    assert(full.compare(0, got.size(), got) == 0);         // 是整串 ACP 的字节前缀
    if (full.size() <= 31) assert(got == full);            // 放得下 → 不截断
    else assert(got.size() < full.size());
}

// —— ① 空串 / 空缓冲 ——
void test_empty_and_null() {
    char dst[8];
    std::memset(dst, 'x', sizeof dst);
    assert(host::copyAcpBounded("", dst, sizeof dst) == 0);
    assert(dst[0] == '\0');
    std::memset(dst, 'x', sizeof dst);
    assert(host::copyAcpBounded(nullptr, dst, sizeof dst) == 0);
    assert(dst[0] == '\0');
    assert(host::copyAcpBounded("abc", nullptr, 8) == 0);
    std::memset(dst, 'x', sizeof dst);
    assert(host::copyAcpBounded("abc", dst, 0) == 0);
    assert(dst[0] == 'x');
    std::cout << "PASS test_empty_and_null\n";
}

// —— ② ASCII 与 31/32 边界 ——
void test_ascii_boundary() {
    assert(run("abc", 32) == "abc");
    assert(run("abc", 2) == "a");        // 上限 1 字节
    assert(run("abc", 1).empty());       // 上限 0 字节
    const std::string a31(31, 'a');
    const std::string a32(32, 'a');
    const std::string a33(33, 'a');
    assert(run(a31.c_str(), 32) == a31);   // 恰好 31：整串保留
    assert(run(a32.c_str(), 32) == a31);   // 32 → 截到 31
    assert(run(a33.c_str(), 32) == a31);   // 33 → 截到 31
    std::cout << "PASS test_ascii_boundary\n";
}

// —— ③ zh 参数名：与整串转换逐字节一致（zh 不变量） ——
void test_zh_param_names_unchanged() {
    const char* names[] = {
        "Shader 文件", "GLSL 文件", "参数", "映射图层", "映射图层 1", "映射图层 2",
        "启用三维摄像机", "GLSL 索引", "启用三维灯光", "重算代数", "重算结算器",
    };
    std::string sizes;
    for (const char* name : names) {
        const std::string oldPath = wholeUtf8ToAcp(name);
        assert(oldPath.size() <= 31);             // zh 参数名全部远低于上限
        assert(run(name, 32) == oldPath);         // helper 输出 == 整串转换输出
        sizes += (sizes.empty() ? "" : ",") + std::to_string(oldPath.size());
    }
    std::cout << "  zh 参数名 ACP 字节（整串转换=helper）: " << sizes << "\n";
    std::cout << "PASS test_zh_param_names_unchanged\n";
}

// —— ④ 超限译文：字符边界截断（Cyrillic/假名/谚文/德法文本） ——
void test_long_translations_truncate_on_boundary() {
    const char* texts[] = {
        // ru 参数名（CP936 下 2 字节/字符 → 全部超 31 字节）
        "Слои сопоставления",
        "Слой сопоставления %d",
        "Поколение пересчёта",
        "Пересчитать решатель",
        "Включить 3D-освещение",
        "Включить 3D-камеру",
        // ja / ko / de / fr 长参数名
        "3D カメラを有効にする",
        "3D ライトを有効にする",
        "3D 카메라 활성화",
        "3D 조명 활성화",
        "Activer les lumières 3D",
        "Solver neu berechnen",
        // 混合与超长
        "启用 3D Камера カメラ 카메라",
        "aЯaЯaЯaЯaЯaЯaЯaЯaЯaЯaЯaЯaЯaЯaЯaЯ",
        "😀😀😀😀😀😀😀😀",
    };
    for (const char* text : texts) {
        const std::string full = wholeUtf8ToAcp(text);
        const std::string got = run(text, 32);
        std::cout << "  len=" << got.size() << " (full=" << full.size()
                  << ") " << text << "\n";
        check_input(text);
    }
    std::cout << "PASS test_long_translations_truncate_on_boundary\n";
}

// —— ⑤ 全部六语言参数名字典：任何缓冲上限下都满足不变量 ——
void test_all_caps_keep_invariants() {
    const char* texts[] = {
        "Shader File", "Shader ファイル", "Shader-Datei", "Shader 파일", "Fichier Shader",
        "Файл Shader", "GLSL File", "Map Layers", "マップレイヤー", "Mapping-Ebenen",
        "매핑 레이어", "Calques mappés", "Слои сопоставления", "Enable 3D Camera",
        "3D カメラを有効にする", "3D-Kamera aktivieren", "감마 활성화", "Включить 3D-камеру",
    };
    const size_t caps[] = {1, 2, 3, 4, 5, 8, 16, 24, 31, 32, 33, 64};
    for (const char* text : texts) {
        for (size_t cap : caps) {
            const std::string got = run(text, cap);
            assert(got.size() <= (cap > 0 ? cap - 1 : 0));
            assert(acpWellFormed(got));
            if (cap >= 32) {
                const std::string full = wholeUtf8ToAcp(text);
                if (full.size() <= 31) assert(got == full);
            }
        }
    }
    std::cout << "PASS test_all_caps_keep_invariants\n";
}

// —— ⑥ ACP 可表示性判定：与独立实现一致 + 本机代码页的已知事实 ——
bool expectedRepresentable(const char* utf8) {
    if (!utf8 || !*utf8) return true;
    const int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
    if (wlen <= 1) return true;
    std::wstring wide(static_cast<size_t>(wlen), L'\0');
    if (MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &wide[0], wlen) != wlen) return false;
    wide.resize(static_cast<size_t>(wlen - 1));
    for (size_t i = 0; i < wide.size(); ++i) {
        size_t units = 1;
        if (wide[i] >= 0xD800 && wide[i] <= 0xDBFF && i + 1 < wide.size() &&
            wide[i + 1] >= 0xDC00 && wide[i + 1] <= 0xDFFF) {
            units = 2;
        }
        char acp[8] = {0};
        BOOL usedDefault = FALSE;
        const int n = WideCharToMultiByte(CP_ACP, WC_NO_BEST_FIT_CHARS, &wide[i],
                                          static_cast<int>(units), acp,
                                          static_cast<int>(sizeof(acp)),
                                          nullptr, &usedDefault);
        if (n <= 0 || usedDefault) return false;
        i += units - 1;
    }
    return true;
}

void test_acp_representable() {
    assert(host::acpRepresentable("ABC"));
    assert(host::acpRepresentable(""));
    assert(host::acpRepresentable(nullptr));
    const char* samples[] = {
        "Shader 文件", "GLSL 索引", "映射图层 2", "3D カメラを有効にする",
        "Включить 3D-камеру", "카메라 활성화", "매핑 레이어 %d",
        "Activer les lumières 3D", "启用 3D Камера カメラ", "😀", "aЯaЯ", "中文，标点！",
    };
    for (const char* s : samples) {
        // 与独立实现（同 Win32 API、不经被测函数）逐项一致：写法与具体代码页无关
        assert(host::acpRepresentable(s) == expectedRepresentable(s));
    }
    if (GetACP() == 936) {
        // 中文 Windows（GBK）：有假名/西里尔/汉字，无谚文
        assert(host::acpRepresentable("启用三维摄像机"));
        assert(host::acpRepresentable("3D カメラを有効にする"));
        assert(host::acpRepresentable("Включить 3D-камеру"));
        assert(!host::acpRepresentable("카메라 활성화"));
        assert(!host::acpRepresentable("매핑 레이어 %d"));
    }
    if (GetACP() == 54936 || GetACP() == 65001) {
        // GB18030 / UTF-8 代码页能表示全部 Unicode，任何文本都可表示（不回退）
        assert(host::acpRepresentable("한국어 카메라"));
        assert(host::acpRepresentable("中文，标点！"));
        assert(host::acpRepresentable("😀"));
    }
    std::cout << "  ACP=" << GetACP() << "\n";
    std::cout << "PASS test_acp_representable\n";
}

// —— ⑦ 参数名回退：当前语言不可表示 → en-US，可表示 → 行为不变 ——
// wrapper 定义在 plugin.cpp（测试不含该翻译单元），这里按同一规格独立组合：
//   text = acpRepresentable(Tr(id)) ? Tr(id) : TrIn(kLocaleEnUS, id)
const char* paramNameTextExpected(StrId id) {
    const char* text = Tr(id);
    if (host::acpRepresentable(text)) return text;
    return TrIn(i18n::kLocaleEnUS, id);
}

void test_param_name_fallback() {
    const StrId ids[] = {
        S_EFFECTHOST_PLUGIN_PARAM_SHADER_FILE,
        S_EFFECTHOST_PLUGIN_PARAM_GLSL_FILE,
        S_EFFECTHOST_PLUGIN_PARAM_GROUP_PARAMS,
        S_EFFECTHOST_PLUGIN_PARAM_GROUP_MAP_LAYERS,
        S_EFFECTHOST_PLUGIN_PARAM_MAP_LAYER,
        S_EFFECTHOST_PLUGIN_PARAM_CAM3D_ENABLE,
        S_EFFECTHOST_PLUGIN_PARAM_GLSL_INDEX,
        S_EFFECTHOST_PLUGIN_PARAM_LIGHTS3D_ENABLE,
        S_EFFECTHOST_PLUGIN_PARAM_SOLVE_GEN,
        S_EFFECTHOST_PLUGIN_PARAM_SOLVE_BUTTON,
    };
    // ① 当前语言就绪（zh）：可表示时与 Tr 完全相同（可表示时行为不变）
    i18n::setLocaleTag("zh-CN");
    for (StrId id : ids) {
        const char* zh = Tr(id);
        const char* chosen = paramNameTextExpected(id);
        if (host::acpRepresentable(zh)) {
            assert(std::strcmp(chosen, zh) == 0);
        } else {
            assert(std::strcmp(chosen, TrIn(i18n::kLocaleEnUS, id)) == 0);
        }
    }
    // ② 模拟 ko-KR：谚文在本机 ACP 不可表示 → 回退 en-US（拉丁可表示，不再出现 '?'）
    i18n::setLocaleTag("ko-KR");
    bool anyFallback = false;
    for (StrId id : ids) {
        const char* ko = Tr(id);
        const char* en = TrIn(i18n::kLocaleEnUS, id);
        assert(std::strcmp(ko, en) != 0);         // 前提：两种语言译文不同
        assert(host::acpRepresentable(en));       // 回退目标本身可表示
        const char* chosen = paramNameTextExpected(id);
        if (host::acpRepresentable(ko)) {
            assert(std::strcmp(chosen, ko) == 0); // 可表示 → 行为不变
        } else {
            assert(std::strcmp(chosen, en) == 0);  // 不可表示 → 回退英文
            anyFallback = true;
            char buf[32];
            const size_t n = host::copyAcpBounded(chosen, buf, sizeof(buf));
            assert(n == std::strlen(buf));
            if (GetACP() == 936) {
                std::cout << "  ko 回退: \"" << ko << "\" -> ACP \"" << buf << "\"\n";
            }
        }
    }
    if (GetACP() == 936) assert(anyFallback);   // CP936 下必然触发回退
    // ③ 动态「映射图层 %d」：先取回退后的模板，再格式化、落 ACP
    {
        const char* tpl = paramNameTextExpected(S_EFFECTHOST_PLUGIN_PARAM_MAP_LAYER);
        char line[64] = {0};
        std::snprintf(line, sizeof(line), tpl, 2);
        char lineAcp[32] = {0};
        host::copyAcpBounded(line, lineAcp, sizeof(lineAcp));
        char expectLine[64] = {0};
        std::snprintf(expectLine, sizeof(expectLine),
                      TrIn(i18n::kLocaleEnUS, S_EFFECTHOST_PLUGIN_PARAM_MAP_LAYER), 2);
        if (GetACP() == 936) {
            assert(std::strcmp(tpl, TrIn(i18n::kLocaleEnUS,
                                         S_EFFECTHOST_PLUGIN_PARAM_MAP_LAYER)) == 0);
            assert(std::strcmp(lineAcp, expectLine) == 0);
            std::cout << "  ko 动态参数名回退: \"" << line << "\" -> ACP \"" << lineAcp << "\"\n";
        }
    }
    // ④ 当前语言可表示时（本机 CP936 上 ja/de/fr/ru 参数名）不回退
    i18n::setLocaleTag("ja-JP");
    for (StrId id : ids) {
        const char* ja = Tr(id);
        if (host::acpRepresentable(ja)) assert(std::strcmp(paramNameTextExpected(id), ja) == 0);
    }
    i18n::setLocaleTag("zh-CN");   // 复位：后续套件按默认语言断言
    std::cout << "PASS test_param_name_fallback\n";
}

// —— ⑧ TrIn 越界：语言下标或 id 越界返回空串，不读表外内存 ——
void test_trin_bounds() {
    assert(std::strcmp(TrIn(-1, S_EFFECTHOST_PLUGIN_PARAM_GLSL_INDEX), "") == 0);
    assert(std::strcmp(TrIn(i18n::kLocaleCount, S_EFFECTHOST_PLUGIN_PARAM_GLSL_INDEX), "") == 0);
    assert(std::strcmp(TrIn(i18n::kLocaleEnUS, static_cast<StrId>(-1)), "") == 0);
    std::cout << "PASS test_trin_bounds\n";
}

// 文本在指定代码页能否完整表示（与 acpRepresentable 判定同口径，代码页可显式指定）。
bool representableInCodePage(const char* utf8, UINT cp) {
    if (!utf8 || !*utf8) return true;
    if (cp == 54936 || cp == 65001) return true;   // 表示全部 Unicode
    const int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
    if (wlen <= 1) return true;
    std::wstring wide(static_cast<size_t>(wlen), L'\0');
    if (MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &wide[0], wlen) != wlen) return false;
    wide.resize(static_cast<size_t>(wlen - 1));
    for (size_t i = 0; i < wide.size();) {
        size_t units = 1;
        if (wide[i] >= 0xD800 && wide[i] <= 0xDBFF && i + 1 < wide.size() &&
            wide[i + 1] >= 0xDC00 && wide[i + 1] <= 0xDFFF) {
            units = 2;
        }
        char buf[8] = {0};
        BOOL usedDefault = FALSE;
        const int n = WideCharToMultiByte(cp, WC_NO_BEST_FIT_CHARS, &wide[i],
                                          static_cast<int>(units), buf,
                                          static_cast<int>(sizeof(buf)),
                                          nullptr, &usedDefault);
        if (n <= 0 || usedDefault) return false;
        i += units;
    }
    return true;
}

// —— ⑨ 各语言参数名在其原生代码页可表示（否则真实宿主静默回退英文） ——
void test_param_names_fit_native_codepages() {
    const StrId ids[] = {
        S_EFFECTHOST_PLUGIN_PARAM_SHADER_FILE,
        S_EFFECTHOST_PLUGIN_PARAM_GLSL_FILE,
        S_EFFECTHOST_PLUGIN_PARAM_GROUP_PARAMS,
        S_EFFECTHOST_PLUGIN_PARAM_GROUP_MAP_LAYERS,
        S_EFFECTHOST_PLUGIN_PARAM_MAP_LAYER,
        S_EFFECTHOST_PLUGIN_PARAM_CAM3D_ENABLE,
        S_EFFECTHOST_PLUGIN_PARAM_GLSL_INDEX,
        S_EFFECTHOST_PLUGIN_PARAM_LIGHTS3D_ENABLE,
        S_EFFECTHOST_PLUGIN_PARAM_SOLVE_GEN,
        S_EFFECTHOST_PLUGIN_PARAM_SOLVE_BUTTON,
    };
    // 行序同 i18nRuntime：zh / en / ja / de / ko / fr / ru → 各自原生代码页
    const UINT nativeCp[i18n::kLocaleCount] = {936, 1252, 932, 1252, 949, 1252, 1251};
    for (int locale = 0; locale < i18n::kLocaleCount; ++locale) {
        for (StrId id : ids) {
            const char* text = TrIn(locale, id);
            if (!representableInCodePage(text, nativeCp[locale])) {
                std::cerr << "  native CP 不可表示: locale=" << locale
                          << " cp=" << nativeCp[locale] << " \"" << text << "\"\n";
                assert(false);
            }
        }
    }
    std::cout << "PASS test_param_names_fit_native_codepages\n";
}

// —— ⑩ 源码钉：参数名注册点不得直调「整串转 ACP + 有界拷贝」 ——
void test_param_name_source_pin() {
    namespace fs = std::filesystem;
    const fs::path thisFile(__FILE__);
    fs::path pluginCpp = thisFile.parent_path().parent_path() / "src" / "plugin.cpp";
    if (!fs::exists(pluginCpp)) pluginCpp = fs::current_path() / "native/glsl-host/src/plugin.cpp";
    if (!fs::exists(pluginCpp)) pluginCpp = fs::current_path() / "../src/plugin.cpp";
    assert(fs::exists(pluginCpp));
    std::ifstream in(pluginCpp, std::ios::binary);
    assert(in.good());
    const std::string src((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    const auto count = [&src](const std::string& needle) {
        size_t n = 0;
        for (size_t p = src.find(needle); p != std::string::npos;
             p = src.find(needle, p + needle.size())) {
            ++n;
        }
        return n;
    };
    // 参数名不得直调 copyAcpBounded(Tr(...))
    assert(src.find("copyAcpBounded(Tr(") == std::string::npos);
    // copyAcpBounded 至少出现在两个参数名 wrapper 内（后续复用同一判定不得误红）
    assert(count("host::copyAcpBounded(") >= 2);
    // wrapper 定义存在，且 11 处注册/改名点都走 wrapper
    assert(src.find("static size_t copyParamNameAcp(StrId") != std::string::npos);
    assert(src.find("static size_t copyMapLayerNameAcp(int") != std::string::npos);
    assert(count("copyParamNameAcp(") == 10);   // 1 处定义 + 9 个调用点
    assert(count("copyMapLayerNameAcp(") == 3); // 1 处定义 + 2 个动态调用点
    // 回退路径走 TrIn(en-US)
    assert(src.find("TrIn(i18n::kLocaleEnUS") != std::string::npos);
    std::cout << "PASS test_param_name_source_pin\n";
}

} // namespace

void runAcpNameTests() {
    test_empty_and_null();
    test_ascii_boundary();
    test_zh_param_names_unchanged();
    test_long_translations_truncate_on_boundary();
    test_all_caps_keep_invariants();
    test_acp_representable();
    test_param_name_fallback();
    test_trin_bounds();
    test_param_names_fit_native_codepages();
    test_param_name_source_pin();
    std::cout << "ALL ACP NAME TESTS PASSED\n";
}
