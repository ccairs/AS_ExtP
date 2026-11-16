// test_json.cpp — JSON 解析器单测（纯 C++，无 Win32/AE 依赖）
#include "json.h"
#include <cstdio>
#include <string>

static int g_fail = 0;
#define CHECK(cond) do { \
    if (!(cond)) { std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); ++g_fail; } \
} while (0)

int run_json_tests() {
    using namespace json;

    std::string o = R"({"name":"高斯模糊","matchName":"ADBE Gaussian Blur 2","n":3,"ok":true,"nil":null})";
    Value v;
    CHECK(parse(o.c_str(), o.size(), &v) && v.type == Value::kObject);
    CHECK(v["name"].type == Value::kString && v["name"].str == "高斯模糊");
    CHECK(v["matchName"].str == "ADBE Gaussian Blur 2");
    CHECK(v["n"].type == Value::kNumber && v["n"].num == 3.0);
    CHECK(v["ok"].type == Value::kBool && v["ok"].b);
    CHECK(v["nil"].type == Value::kNull);
    CHECK(v["missing"].type == Value::kNull);

    std::string a = R"({"categories":[{"category":"模糊与锐化","effects":[{"name":"径向模糊"}]}]})";
    CHECK(parse(a.c_str(), a.size(), &v) && v.type == Value::kObject);
    CHECK(v["categories"].type == Value::kArray && v["categories"].size() == 1);
    CHECK(v["categories"][0]["effects"][0]["name"].str == "径向模糊");

    std::string esc = R"({"s":"a\"b\\c\/d\u4e2d"})";
    CHECK(parse(esc.c_str(), esc.size(), &v) && v["s"].str == "a\"b\\c/d中");

    std::string arr = R"([1,2,3])";
    CHECK(parse(arr.c_str(), arr.size(), &v) && v.type == Value::kArray && v.size() == 3);

    std::string bad = R"({"a":})";
    CHECK(!parse(bad.c_str(), bad.size(), &v));

    std::string built = buildString("a\"b\\c");
    CHECK(built == "\"a\\\"b\\\\c\"");

    // U+2028/U+2029（ES3 行终止符）转义：原样透传会让嵌入的 ExtendScript
    // 字符串字面量直接 SyntaxError（回归：只处理 <0x20，三字节序列全透传）
    std::string ls = "a\xE2\x80\xA8" "b\xE2\x80\xA9" "c";
    CHECK(buildString(ls) == "\"a\\u2028b\\u2029c\"");
    // 普通 UTF-8（中文）不受影响，原样透传
    CHECK(buildString("\xE4\xB8\xAD") == "\"\xE4\xB8\xAD\"");
    // 末尾正好是三字节序列（边界：i+2 == size-1）
    CHECK(buildString("x\xE2\x80\xA8") == "\"x\\u2028\"");

    // 畸形数字拒绝
    CHECK(!parse(R"({"a":-})", sizeof(R"({"a":-})") - 1, &v));
    CHECK(!parse(R"({"a":1.})", sizeof(R"({"a":1.})") - 1, &v));
    CHECK(!parse(R"({"a":+3})", sizeof(R"({"a":+3})") - 1, &v));

    // \uXXXX 代理对 → 合并为 4 字节 UTF-8（回归：输出 CESU-8，emoji 等非 BMP 字符乱码）
    // 用独立 Value：v 已有同名键 "s"（上文 esc 用例），operator[] 命中首个旧键
    std::string sur = R"({"s":"\uD83D\uDE00"})";   // U+1F600
    Value sv;
    CHECK(parse(sur.c_str(), sur.size(), &sv) && sv["s"].str == "\xF0\x9F\x98\x80");
    // 孤立高位代理（无低位跟随）：保持旧行为（3 字节），不崩溃不误合并
    std::string lone = R"({"s":"\uD83D"})";
    Value lv;
    CHECK(parse(lone.c_str(), lone.size(), &lv) && lv["s"].str.size() == 3);

    return g_fail;
}
