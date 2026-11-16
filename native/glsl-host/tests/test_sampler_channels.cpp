// Release 构建（CMake 默认 /DNDEBUG）会把 assert 编译为空操作——
// 本文件全部断言曾因此空转（"ALL TESTS PASSED" 只证明不崩溃）。#undef NDEBUG
// 必须位于所有头包含之前（首个 <cassert> 被包含时生效，其后 include guard
// 保证不再重定义）。
#undef NDEBUG
#include <cassert>
#include <iostream>
#include <string>
#include "uniformParser.h"

// —— 映射图层（iChannel1/2/3）声明检测：parseSamplerChannels ——
// 声明检测 / iChannel0 忽略 / 非法命名告警 / bitmask 组合

static void test_no_sampler() {
    const char* src = R"GLSL(
        uniform float uAmount;
        uniform vec3 uColor;
        void main() {}
    )GLSL";
    std::string warn;
    uint8_t mask = glsl::parseSamplerChannels(src, &warn);
    assert(mask == 0);
    assert(warn.empty());
    std::cout << "PASS test_no_sampler\n";
}

static void test_single_channel_declarations() {
    // bit0=iChannel1、bit1=iChannel2、bit2=iChannel3
    std::string warn;
    assert(glsl::parseSamplerChannels("uniform sampler2D iChannel1;\n", &warn) == 0x1);
    assert(glsl::parseSamplerChannels("uniform sampler2D iChannel2;\n", &warn) == 0x2);
    assert(glsl::parseSamplerChannels("uniform sampler2D iChannel3;\n", &warn) == 0x4);
    assert(warn.empty());
    std::cout << "PASS test_single_channel_declarations\n";
}

static void test_ichannel0_builtin_ignored() {
    // iChannel0 是内置（本图层输入）：合法、不置位、不告警
    const char* src = R"GLSL(
        uniform sampler2D iChannel0;
        uniform float uA;
        void main() { vec4 c = texture(iChannel0, vec2(0.5)); }
    )GLSL";
    std::string warn;
    uint8_t mask = glsl::parseSamplerChannels(src, &warn);
    assert(mask == 0);
    assert(warn.empty());
    std::cout << "PASS test_ichannel0_builtin_ignored\n";
}

static void test_bitmask_combo() {
    // 组合声明：iChannel1 + iChannel3 → 0x5；全声明 → 0x7
    const char* src13 = R"GLSL(
        uniform sampler2D iChannel1;
        uniform sampler2D iChannel3;
        void main() {}
    )GLSL";
    std::string warn;
    assert(glsl::parseSamplerChannels(src13, &warn) == 0x5);
    const char* srcAll = R"GLSL(
        uniform sampler2D iChannel0;
        uniform sampler2D iChannel1;
        uniform sampler2D iChannel2;
        uniform sampler2D iChannel3;
        void main() {}
    )GLSL";
    assert(glsl::parseSamplerChannels(srcAll, &warn) == 0x7);
    assert(warn.empty());
    std::cout << "PASS test_bitmask_combo\n";
}

static void test_illegal_name_warning() {
    // 其他名字的 sampler2D → 告警写入 warnings（error.log 可见），不置位
    const char* src = R"GLSL(
        uniform sampler2D uMyTex;
        uniform sampler2D iChannel1;
        void main() {}
    )GLSL";
    std::string warn;
    uint8_t mask = glsl::parseSamplerChannels(src, &warn);
    assert(mask == 0x1);
    assert(warn.find("uMyTex") != std::string::npos);
    // 告警模板文本自含 "iChannel1/2/3" 说明字样
    // （旧断言 find("iChannel1")==npos 因此恒假，从未真实运行）。真实语义是
    // 「合法名不产生自己的告警条目」——按告警条目前缀+名字精确断言。
    assert(warn.find("[未绑定的采样器] iChannel1") == std::string::npos);   // 合法名不进告警
    // 不传 warnings 指针时不崩溃
    assert(glsl::parseSamplerChannels(src) == 0x1);
    std::cout << "PASS test_illegal_name_warning\n";
}

static void test_comments_and_bom_ignored() {
    // 注释里的声明不算（与 parseUniforms 同款剥注释）
    const char* src = R"GLSL(
        // uniform sampler2D iChannel1;
        /* uniform sampler2D iChannel2; */
        uniform sampler2D iChannel3;
        void main() {}
    )GLSL";
    std::string warn;
    assert(glsl::parseSamplerChannels(src, &warn) == 0x4);
    assert(warn.empty());
    // UTF-8 BOM 剥离：带 BOM 的首个声明不漏检
    std::string bomSrc = "\xEF\xBB\xBFuniform sampler2D iChannel2;\n";
    assert(glsl::parseSamplerChannels(bomSrc, &warn) == 0x2);
    std::cout << "PASS test_comments_and_bom_ignored\n";
}

static void test_mixed_with_uniforms() {
    // 与数值 uniform 混排：词流对齐不受影响（parseUniforms 忽略 sampler2D 行）
    const char* src = R"GLSL(
        uniform float uAmount = 0.5;
        uniform sampler2D iChannel1;
        uniform vec2 uOffset;
        uniform sampler2D uNoiseTex;
        void main() {}
    )GLSL";
    std::string warn;
    uint8_t mask = glsl::parseSamplerChannels(src, &warn);
    assert(mask == 0x1);
    assert(warn.find("uNoiseTex") != std::string::npos);
    // parseUniforms 侧：sampler 声明不占数值槽位
    auto params = glsl::parseUniforms(src);
    assert(params.size() == 2);
    assert(params[0].name == "uAmount");
    assert(params[1].name == "uOffset");
    std::cout << "PASS test_mixed_with_uniforms\n";
}

// 逗号分隔多声明：第二个名字不能丢（丢了 → host 不绑纹理 → 静默黑采样）
static void test_comma_separated_declarations() {
    std::string warn;
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1, iChannel2;\n", &warn) == 0x3);
    assert(warn.empty());
    // 非法名混排：uA 告警，iChannel3 正常置位
    uint8_t mask = glsl::parseSamplerChannels(
        "uniform sampler2D uA, iChannel3;\n", &warn);
    assert(mask == 0x4);
    assert(warn.find("uA") != std::string::npos);
    // 三连声明 + 结尾非法名
    mask = glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1, iChannel2, iChannel3, uB;\n", &warn);
    assert(mask == 0x7);
    assert(warn.find("uB") != std::string::npos);
    // 带初始化器/数组维度的畸形声明：吞至 ';' 不失步，后续声明仍可解析
    mask = glsl::parseSamplerChannels(
        "uniform sampler2D uC = something;\nuniform sampler2D iChannel1;\n", &warn);
    assert(mask == 0x1);
    assert(warn.find("uC") != std::string::npos);
    std::cout << "PASS test_comma_separated_declarations\n";
}

// 回归：终结符与名字粘连（`iChannel1[4];` / `uC=xxx;` 整体是一个 token）时，
// cut 之后已含本声明的 ';' → 声明已完整，不得进入吞流循环吃掉下一条 iChannel 声明
static void test_glued_terminator_declarations() {
    std::string warn;
    // ① 数组维度粘连：iChannel1[4]; 单 token 已含 ';'，其后 iChannel2 不得被吞
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1[4];\nuniform sampler2D iChannel2;\n", &warn) == 0x3);
    assert(warn.empty());
    // ② 初始化器粘连：uC=xxx; 单 token 已含 ';'，其后 iChannel1 不得被吞
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D uC=xxx;\nuniform sampler2D iChannel1;\n", &warn) == 0x1);
    assert(warn.find("uC") != std::string::npos);
    // ③ 空格分隔形式（既有行为）不回归：`iChannel1 [4];` 走名字后无终结符路径
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1 [4];\nuniform sampler2D iChannel3;\n", &warn) == 0x5);
    // ④ 复查补充：分号独立 token（`iChannel1[4] ;`）——token 内 cut 后无 ';'，
    //    正确进入吞流循环消耗独立分号，不得误判"声明已完整"把分号漏给外层
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1[4] ;\nuniform sampler2D iChannel2;\n", &warn) == 0x3);
    // ⑤ 复查补充：等号粘连但值分离（`uC= xxx;`）——token 内无 ';' → 吞流至含
    //    ';' 的 token 止，其后 iChannel1 不得被吞
    warn.clear();   // 清残留（② 的 uC 告警文本会让 find 恒真，断言空转）
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D uC= xxx;\nuniform sampler2D iChannel1;\n", &warn) == 0x1);
    assert(warn.find("uC") != std::string::npos);
    std::cout << "PASS test_glued_terminator_declarations\n";
}

// 逗号链的全部书写变体——后续 iChannel 名不得丢失。
// 只支持「逗号粘连在前名后 + 空格分隔」（`a, b;`）时，其余变体一律丢名：
// mask 丢位 → host 不 checkout 不绑纹理 → shader 实际采样 → 静默黑图。
static void test_comma_chain_spacing_variants() {
    std::string warn;
    // ① 逗号独立成 token：`iChannel1 , iChannel2;`
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1 , iChannel2;\n", &warn) == 0x3);
    // ② 逗号前粘连后空格（既有唯一支持的形式，回归）：`iChannel1, iChannel2;`
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1, iChannel2;\n", &warn) == 0x3);
    // ③ 逗号全粘连（单 token `iChannel1,iChannel2;`）
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1,iChannel2;\n", &warn) == 0x3);
    // ④ 逗号前空格后粘连（token `iChannel1` + `,iChannel2;`）
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1 ,iChannel2;\n", &warn) == 0x3);
    // ⑤ 数组维度+逗号空格：`iChannel1[4], iChannel2;`
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1[4], iChannel2;\n", &warn) == 0x3);
    // ⑥ 数组维度闭合后逗号独立：`iChannel1[4] , iChannel2;`
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1[4] , iChannel2;\n", &warn) == 0x3);
    // ⑦ 数组维度+逗号全粘连（单 token `iChannel1[4],iChannel2;`）
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1[4],iChannel2;\n", &warn) == 0x3);
    // ⑧ 三名混合变体链：`iChannel1 ,iChannel2, iChannel3[2];`
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1 ,iChannel2, iChannel3[2];\n", &warn) == 0x7);
    assert(warn.empty());
    // ⑨ 漏分号畸形（对齐 parseUniforms 防御）：链中 "uniform" 交还外层，
    //    下一声明仍被扫描，且不为关键字产生伪告警
    warn.clear();
    assert(glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1, uniform sampler2D iChannel2;\n", &warn) == 0x3);
    assert(warn.empty());
    std::cout << "PASS test_comma_chain_spacing_variants\n";
}

// 采样了但**没声明**的 iChannelN → 告警
// 背景：mask 只由声明行驱动，而骨架里恒声明 iChannel1/2/3（编译必过）→ "只采样不声明"
// 若无诊断则全链静默（不 checkout、行不启用、绑兜底透明黑、error.log 一个字都没有），
// 而这是最可能犯的错——契约把判别权推给用户看 UI 灰态。现补 error.log 告警。
static void test_undeclared_usage_warning() {
    std::string warn;
    // ① 采样但没声明：告警 + 不置位
    uint8_t mask = glsl::parseSamplerChannels(
        "vec4 mainImage(vec2 f,float t){ return texture(iChannel1,f); }\n", &warn);
    assert(mask == 0);
    assert(warn.find("[未声明的采样器] iChannel1") != std::string::npos);

    // ② 声明了（即使也采样了）：不告警、正常置位
    warn.clear();
    mask = glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1;\n"
        "vec4 mainImage(vec2 f,float t){ return texture(iChannel1,f); }\n", &warn);
    assert(mask == 0x1);
    assert(warn.find("未声明的采样器") == std::string::npos);

    // ③ 只在注释里提到：剥注释后不算使用（不给注释产生噪音）
    warn.clear();
    glsl::parseSamplerChannels("// 这里没用 iChannel2，别告警\nuniform float uA;\n", &warn);
    assert(warn.find("未声明的采样器") == std::string::npos);

    // ④ 词边界：iChannel10 / my_iChannel1 不是 iChannel1
    warn.clear();
    glsl::parseSamplerChannels(
        "uniform float iChannel10;\nuniform float my_iChannel1;\n", &warn);
    assert(warn.find("未声明的采样器") == std::string::npos);

    // ⑤ 内置名（iChannel0 / iPrev / iHistory0）本就不用声明 → 不告警
    warn.clear();
    glsl::parseSamplerChannels(
        "vec4 c = texture(iChannel0,f) + texture(iPrev,f) + texture(iHistory0,f);\n", &warn);
    assert(warn.find("未声明的采样器") == std::string::npos);

    // ⑥ 只缺一张：只对缺的那张告警
    warn.clear();
    glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1;\n"
        "vec4 mainImage(vec2 f,float t){ return texture(iChannel1,f) + texture(iChannel3,f); }\n",
        &warn);
    assert(warn.find("[未声明的采样器] iChannel3") != std::string::npos);
    assert(warn.find("[未声明的采样器] iChannel1") == std::string::npos);

    // ⑦ 不传 warnings 指针时不崩溃（与既有同款守卫）
    assert(glsl::parseSamplerChannels(
        "vec4 mainImage(vec2 f,float t){ return texture(iChannel2,f); }\n") == 0);

    // ⑧ 非 2D sampler 类型（samplerCube 等）→ 明确告警（原因：
    //    宿主只支持 sampler2D，其余类型若不告警则三层全链静默、采样无效）
    warn.clear();
    assert(glsl::parseSamplerChannels(
        "uniform samplerCube uEnv;\nvec4 mainImage(vec2 f,float t){ return texture(uEnv,vec3(f,0.0)); }\n",
        &warn) == 0);
    assert(warn.find("[不支持的采样器类型] samplerCube") != std::string::npos);
    assert(warn.find("uEnv") != std::string::npos);   // 带声明名（与 [未绑定的采样器] 同款形态）
    // ⑧b 精度限定符在前（复核发现的盲区）与整数采样器
    warn.clear();
    assert(glsl::parseSamplerChannels("uniform highp samplerCube uE2;\n", &warn) == 0);
    assert(warn.find("[不支持的采样器类型] samplerCube uE2") != std::string::npos);
    warn.clear();
    assert(glsl::parseSamplerChannels("uniform isampler2D uI;\n", &warn) == 0);
    assert(warn.find("[不支持的采样器类型] isampler2D uI") != std::string::npos);
    // usampler* 也要命中（compare 的 count 与字面量长度不等时恒不命中，先前写成 9 是空转）
    warn.clear();
    assert(glsl::parseSamplerChannels("uniform usampler2D uU;\n", &warn) == 0);
    assert(warn.find("[不支持的采样器类型] usampler2D uU") != std::string::npos);
    // 逗号链：后续名字也要出现在告警里（与面板侧一致）
    warn.clear();
    assert(glsl::parseSamplerChannels("uniform samplerCube a, b;\n", &warn) == 0);
    assert(warn.find("[不支持的采样器类型] samplerCube a, b") != std::string::npos);
    // 无声明名的畸形形态后紧跟 sampler2D 声明：不得吃掉下一条的 `uniform`（回归修复）
    warn.clear();
    assert(glsl::parseSamplerChannels("uniform samplerCube;\nuniform sampler2D iChannel1;\n", &warn) == 0x1);
    // 类型名不得带粘连终结符（`samplerCube;` 会把 `;` 打进告警文案）
    assert(warn.find("[不支持的采样器类型] samplerCube：") != std::string::npos ||
           warn.find("[不支持的采样器类型] samplerCube ") != std::string::npos);
    assert(warn.find("samplerCube;") == std::string::npos);
    // 同款形态但 `;uniform` 无空格（下一条声明整条不被解析、通道位静默丢失）
    warn.clear();
    assert(glsl::parseSamplerChannels("uniform samplerCube;uniform sampler2D iChannel1;\n", &warn) == 0x1);
    // `uniform sampler2D;`（漏声明名）不该被报成"不支持的采样器类型"
    warn.clear();
    assert(glsl::parseSamplerChannels("uniform sampler2D;\nuniform sampler2D iChannel2;\n", &warn) == 0x2);
    assert(warn.find("不支持的采样器类型") == std::string::npos);
    // 粘连逗号链的后续名字也要出现
    warn.clear();
    assert(glsl::parseSamplerChannels("uniform samplerCube a,b,c;\n", &warn) == 0);
    assert(warn.find("[不支持的采样器类型] samplerCube a, b, c") != std::string::npos);
    // 不传 warnings 指针时结果一致（peek 与否不影响 mask）
    assert(glsl::parseSamplerChannels("uniform samplerCube;\nuniform sampler2D iChannel1;\n") == 0x1);
    // 限定符在前的 sampler2D 仍按正常声明处理（置位、不告警）
    warn.clear();
    assert(glsl::parseSamplerChannels("uniform highp sampler2D iChannel1;\n", &warn) == 0x1);
    assert(warn.empty());
    // sampler2D 不受影响
    warn.clear();
    assert(glsl::parseSamplerChannels("uniform sampler2D iChannel1;\n", &warn) == 0x1);
    assert(warn.empty());
    std::cout << "PASS test_undeclared_usage_warning\n";
}

void runSamplerChannelTests() {
    test_no_sampler();
    test_single_channel_declarations();
    test_ichannel0_builtin_ignored();
    test_bitmask_combo();
    test_illegal_name_warning();
    test_comments_and_bom_ignored();
    test_mixed_with_uniforms();
    test_comma_separated_declarations();
    test_glued_terminator_declarations();
    test_comma_chain_spacing_variants();
    test_undeclared_usage_warning();
    std::cout << "ALL sampler channel tests passed\n";
}
