// paramMap 单元测试：JSON 形状与落盘路径（用临时 APPDATA 隔离真实数据根）。
// 这段契约同时被面板 client/modules/agent/engine/shaderTools.js 消费：
//   propertyIndex/components/componentNames、name/type/slot、default/range、signature.hash。
#undef NDEBUG
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <windows.h>
#include "paramMap.h"
#include "effectState.h"
#include "test_util.h"

namespace {

std::string readAll(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

unsigned fnv1a32(const std::string& bytes) {
    unsigned h = 2166136261u;
    for (unsigned char c : bytes) {
        h ^= static_cast<unsigned>(c);
        h *= 16777619u;
    }
    return h;
}

bool contains(const std::string& hay, const std::string& needle) {
    return hay.find(needle) != std::string::npos;
}

void test_write_json_shape() {
    // 用临时 APPDATA 隔离：dataRootDirPath = <APPDATA>\Adobe\CEP\extensions\AS_ExtP
    const std::wstring oldAppData = [] {
        wchar_t buf[1024] = {0};
        DWORD n = GetEnvironmentVariableW(L"APPDATA", buf, 1024);
        return std::wstring(buf, n);
    }();
    const std::string root = glsltest::tempPath("param_map_test_root");
    const std::wstring wroot = std::filesystem::absolute(std::filesystem::path(root)).wstring();
    _wputenv_s(L"APPDATA", wroot.c_str());

    glsl::Param p;
    p.name = "uAmount";
    p.type = glsl::ParamType::Float;
    p.hasDef = true;
    p.def[0] = 0.25f;
    std::vector<glsl::Param> uniforms{p};
    const std::string src = "uniform float uAmount = 0.25;\n";
    const bool ok = host::writeParamMapFile("X:\\effects\\demo.glsl", "", 3, src, uniforms);
    assert(ok);

    const std::string outPath = root + "\\Adobe\\CEP\\extensions\\AS_ExtP\\temp\\ae-tools\\param-map\\index.json";
    const std::string json = readAll(outPath);
    assert(!json.empty());
    assert(contains(json, "\"version\":1"));
    assert(contains(json, "\"shaderPath\":\"X:\\\\effects\\\\demo.glsl\""));
    assert(contains(json, "\"shaderName\":\"demo\""));
    assert(contains(json, "\"libraryIndex\":3"));
    assert(contains(json, "\"name\":\"uAmount\""));
    assert(contains(json, "\"type\":\"float\""));
    assert(contains(json, "\"slot\":0"));
    assert(contains(json, "\"propertyIndex\":5"));
    assert(contains(json, "\"diskId\":500"));
    assert(contains(json, "\"components\":[5,6,7,8]"));
    assert(contains(json, "\"componentNames\":[\"uAmount\"]"));
    assert(contains(json, "\"default\":[0.25,0,0,0]"));
    assert(contains(json, "\"hasDefault\":true"));
    assert(contains(json, "\"range\":{\"min\":-10,\"max\":10"));
    char hash[16];
    std::snprintf(hash, sizeof(hash), "\"hash\":\"%08x\"", fnv1a32(src));
    assert(contains(json, hash));

    // 写盘是合并语义：再写第二个文件，第一个条目仍在（面板可跨实例读）
    glsl::Param q;
    q.name = "uColor";
    q.type = glsl::ParamType::Vec4;
    std::vector<glsl::Param> uniforms2{q};
    assert(host::writeParamMapFile("X:\\effects\\other.glsl", "other", 4, "vec4 uColor;", uniforms2));
    const std::string json2 = readAll(outPath);
    assert(contains(json2, "demo.glsl"));
    assert(contains(json2, "other.glsl"));
    assert(contains(json2, "\"componentNames\":[\"uColor\",\"uColor.g\",\"uColor.b\",\"uColor.a\"]"));
    assert(contains(json2, "\"propertyIndex\":5"));

    if (oldAppData.empty()) _wputenv_s(L"APPDATA", L"");
    else _wputenv_s(L"APPDATA", oldAppData.c_str());
    std::filesystem::remove_all(root);
    std::cout << "PASS test_write_json_shape\n";
}

} // namespace

void runParamMapTests() {
    test_write_json_shape();
    std::cout << "ALL PARAM MAP TESTS PASSED\n";
}
