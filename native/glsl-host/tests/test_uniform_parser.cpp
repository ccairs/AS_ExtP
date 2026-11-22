// Release 构建（/DNDEBUG）会把 assert 编译为空操作——断言须保持生效
#undef NDEBUG
#include <cassert>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include "uniformParser.h"

#ifndef SHADER_SEED_DIR
#error "本测试需要 SHADER_SEED_DIR（种子示例目录，由 CMakeLists 提供）"
#endif

static void test_parse_three_types() {
    const char* src = R"GLSL(
        uniform float uAmount;
        uniform vec2  uOffset;
        uniform vec3  uColor;
        void main() { gl_FragColor = vec4(0.0); }
    )GLSL";
    auto params = glsl::parseUniforms(src);
    assert(params.size() == 3);
    assert(params[0].name == "uAmount" && params[0].type == glsl::ParamType::Float);
    assert(params[1].name == "uOffset" && params[1].type == glsl::ParamType::Vec2);
    assert(params[2].name == "uColor"  && params[2].type == glsl::ParamType::Vec3);
    std::cout << "PASS test_parse_three_types\n";
}

static void test_ignore_unsupported_and_builtin() {
    const char* src = R"GLSL(
        uniform sampler2D iChannel0;   // 内置，忽略
        uniform mat4 uMatrix;          // 不支持类型，忽略
        uniform float uA;
        void main() {}
    )GLSL";
    auto params = glsl::parseUniforms(src);
    assert(params.size() == 1);
    assert(params[0].name == "uA");
    std::cout << "PASS test_ignore_unsupported_and_builtin\n";
}

// L2 相机内置不得注册为用户参数（幽灵参数缺陷回归锚点）：float/vec3 类型的
// 相机内置若漏过滤，渲染期滑块上传与内置上传同 location，滑块值覆盖真实相机值
static void test_ignore_camera_builtins() {
    const char* src = R"GLSL(
        uniform float uHasCam;
        uniform float uCamFov;
        uniform vec3  uCamPos;
        uniform mat4  uCamMatrix;
        uniform mat4  uWorldMatrix;
        uniform float uAmount;
        void main() {}
    )GLSL";
    auto params = glsl::parseUniforms(src);
    assert(params.size() == 1);
    assert(params[0].name == "uAmount");
    std::cout << "PASS test_ignore_camera_builtins\n";
}

// L3 灯光内置必须从用户参数列表里过滤掉，否则会变成幽灵参数：
//   uHasLights / uLightCount（float）→ 幽灵滑块，渲染期覆盖真实灯数
//   uLightType[8]（float 数组）→ 被**展开成 8 个**用户槽位（数组展开路径）
//   vec 数组（uLightPos/Dir/Color/Params）→ 本会被拒并记误导性 warnings
// 锚点：迁移自 Shadertoy 或 LLM 照抄内置清单生成的 shader 常自带这些声明。
static void test_ignore_light_builtins() {
    const char* src = R"GLSL(
        uniform float uHasLights;
        uniform float uLightCount;
        uniform float uLightType[8];
        uniform vec3  uLightPos[8];
        uniform vec3  uLightDir[8];
        uniform vec3  uLightColor[8];
        uniform vec4  uLightParams[8];
        uniform float uAmount;
        void main() {}
    )GLSL";
    std::string warnings;
    auto params = glsl::parseUniforms(src, &warnings);
    assert(params.size() == 1);
    assert(params[0].name == "uAmount");
    // 不得产生 "数组不支持" 类告警（这些名字应先被内置名单拦掉）
    assert(warnings.find("uLight") == std::string::npos);
    std::cout << "PASS test_ignore_light_builtins\n";
}

static void test_over_32_capped() {
    std::string src;
    for (int i = 0; i < 40; ++i) src += "uniform float uP" + std::to_string(i) + ";\n";
    std::string warn;
    auto params = glsl::parseUniforms(src, &warn);
    assert(params.size() == 32); // 防御性上限
    // 截断必告警（静默截断会让 parseWarning/error.log 双空白）
    assert(warn.find("uP32") != std::string::npos);
    assert(warn.find("32") != std::string::npos);
    std::cout << "PASS test_over_32_capped\n";
}

static void test_ignore_comments() {
    const char* src = R"GLSL(
        // uniform float debug;
        uniform float uReal;
        /* uniform float a; uniform float b; */
        uniform vec2 uOff;
        void main() {}
    )GLSL";
    auto params = glsl::parseUniforms(src);
    assert(params.size() == 2);
    assert(params[0].name == "uReal" && params[0].type == glsl::ParamType::Float);
    assert(params[1].name == "uOff" && params[1].type == glsl::ParamType::Vec2);
    std::cout << "PASS test_ignore_comments\n";
}

// —— 默认值提取：float 数值 / vec2/vec3/vec4 完整分量 / 无初始化器 / 表达式 ——
static void test_parse_default_values() {
    const char* src = R"GLSL(
        uniform float uAmount = 0.5;
        uniform vec2  uOffset = vec2(1.0, 2.0);
        uniform vec3  uColor;
        uniform vec4  uTintColor = vec4(0.1, 0.2, 0.3, 0.4);
        uniform float uK = PI * 0.5;
        void main() {}
    )GLSL";
    auto params = glsl::parseUniforms(src);
    assert(params.size() == 5);
    assert(params[0].hasDef && params[0].def[0] == 0.5f);
    assert(params[1].hasDef && params[1].def[0] == 1.0f && params[1].def[1] == 2.0f);
    assert(!params[2].hasDef);
    assert(params[3].hasDef && params[3].def[0] == 0.1f && params[3].def[1] == 0.2f &&
           params[3].def[2] == 0.3f && params[3].def[3] == 0.4f);
    assert(!params[4].hasDef);
    std::cout << "PASS test_parse_default_values\n";
}

// —— vec4 类型支持 ——
static void test_parse_vec4_type() {
    const char* src = R"GLSL(
        uniform vec4 uColor;
        uniform vec4 uTint = vec4(1.0, 0.5, 0.25, 0.0);
        void main() {}
    )GLSL";
    auto params = glsl::parseUniforms(src);
    assert(params.size() == 2);
    assert(params[0].name == "uColor" && params[0].type == glsl::ParamType::Vec4);
    assert(!params[0].hasDef);
    assert(params[1].name == "uTint" && params[1].type == glsl::ParamType::Vec4);
    assert(params[1].hasDef);
    assert(params[1].def[0] == 1.0f && params[1].def[1] == 0.5f &&
           params[1].def[2] == 0.25f && params[1].def[3] == 0.0f);
    std::cout << "PASS test_parse_vec4_type\n";
}

// —— 剥离 uniform 初始化器（GLSL 规范不允许 uniform 带 `= 值`，编译前必须剥离）——
static void test_strip_uniform_initializers() {
    const std::string src = R"GLSL(
        // 超简单彩虹渐变
        uniform float uSpeed = 2.67; // 行尾注释保留
        uniform vec3 uColor = vec3(1.0, 0.5, 0.2);
        uniform vec4 uTint = vec4(0.1, 0.2, 0.3, 0.4);
        uniform float uPlain;
        vec4 mainImage(vec2 f, float t) { return vec4(0.0); }
    )GLSL";
    std::string out = glsl::stripUniformInitializers(src);
    // float 初始化器已剥离、行尾注释保留（注释文本不断言，避免 MSVC 源码编码差异）
    assert(out.find("uniform float uSpeed;") != std::string::npos);
    assert(out.find("uSpeed =") == std::string::npos);
    assert(out.find("uniform float uSpeed; //") != std::string::npos);
    // vec3 初始化器已剥离
    assert(out.find("uniform vec3 uColor;") != std::string::npos);
    assert(out.find("uColor =") == std::string::npos);
    // vec4 初始化器已剥离
    assert(out.find("uniform vec4 uTint;") != std::string::npos);
    assert(out.find("uTint =") == std::string::npos);
    // 无初始化器的声明不受影响
    assert(out.find("uniform float uPlain;") != std::string::npos);

    // ── 初始化器 + 逗号链——仅剥离初始化器，保留后续 declarator ——
    //（整段吞到 ';' 会让 b 的声明消失 → strip 后 shader 用 b 报 "undeclared"）
    std::string s1 = glsl::stripUniformInitializers("uniform float a = 0.5, b;\nvoid main() {}\n");
    assert(s1.find("uniform float a, b;") != std::string::npos);
    assert(s1.find("= 0.5") == std::string::npos);
    // 括号深度感知：vec2(1.0, 2.0) 内部逗号（深度 > 0）不是 declarator 分隔符
    std::string s2 = glsl::stripUniformInitializers("uniform vec2 v = vec2(1.0, 2.0), b;\nvoid main() {}\n");
    assert(s2.find("uniform vec2 v, b;") != std::string::npos);
    assert(s2.find("vec2(1.0") == std::string::npos);
    // 链上多个初始化器逐个剥离
    std::string s3 = glsl::stripUniformInitializers("uniform float a = 0.5, b = 0.6;\nvoid main() {}\n");
    assert(s3.find("uniform float a, b;") != std::string::npos);
    assert(s3.find("= 0.6") == std::string::npos);
    // 无后续 declarator：整段剥离（既有形态回归）
    std::string s4 = glsl::stripUniformInitializers("uniform vec2 v = vec2(1.0, 2.0);\nvoid main() {}\n");
    assert(s4.find("uniform vec2 v;") != std::string::npos);
    assert(s4.find("vec2(1.0") == std::string::npos);
    std::cout << "PASS test_strip_uniform_initializers\n";
}

// —— 自定义范围：行尾注释 `// @range min max` ——
static void test_parse_range_annotation() {
    const char* src = R"GLSL(
        uniform float uAmount;   // @range -10.0 10.0
        uniform float uOpacity = 0.5;  // @range 0.0 1.0
        uniform vec2  uOffset;  // @range -1.0 1.0
        uniform float uPlain;   // 无范围注释
        uniform vec3  uColor;
        void main() {}
    )GLSL";
    auto params = glsl::parseUniforms(src);
    assert(params.size() == 5);
    assert(params[0].name == "uAmount");
    assert(params[0].hasRange && params[0].rmin == -10.0f && params[0].rmax == 10.0f);
    // 带初始化器 + 行尾注释
    assert(params[1].hasRange && params[1].hasDef && params[1].def[0] == 0.5f &&
           params[1].rmin == 0.0f && params[1].rmax == 1.0f);
    assert(params[2].hasRange && params[2].rmin == -1.0f && params[2].rmax == 1.0f);
    assert(!params[3].hasRange);   // 无注释 → fallback
    assert(!params[4].hasRange);
    std::cout << "PASS test_parse_range_annotation\n";
}

// —— 范围容错：min>max 交换、min==max 防除零 ——
static void test_parse_range_tolerance() {
    const char* src = R"GLSL(
        uniform float uA; // @range 5.0 2.0
        uniform float uB; // @range 3.0 3.0
        void main() {}
    )GLSL";
    auto params = glsl::parseUniforms(src);
    assert(params.size() == 2);
    assert(params[0].rmin == 2.0f && params[0].rmax == 5.0f);   // 已交换
    assert(params[1].rmin == 3.0f && params[1].rmax == 4.0f);   // 防除零 +1
    std::cout << "PASS test_parse_range_tolerance\n";
}

// ── 注释行中的假 @range 不得污染同名真实 uniform 的滑条范围 ——
//（rangeRe 在未剥注释的整段源码上匹配时：`// uniform float speed; // @range 0 10`
//  命中注释行，词流端真实声明被假范围覆盖；含块注释与块注释跨行形态）
static void test_parse_range_comment_immune() {
    const char* src = R"GLSL(
        // uniform float uSpeed; // @range 0 100
        /* uniform float uSpeed; */ // @range 0 100
        /*
            uniform float uSpeed; // @range 0 100
        */
        uniform float uSpeed;
        uniform float uReal; // @range -2.0 2.0
        void main() {}
    )GLSL";
    auto params = glsl::parseUniforms(src);
    assert(params.size() == 2);
    // 注释掉的示例声明（行注释/块注释/跨行块注释）一律无效
    assert(params[0].name == "uSpeed" && !params[0].hasRange);
    // 真实声明的行尾注释正常提取
    assert(params[1].name == "uReal" && params[1].hasRange &&
           params[1].rmin == -2.0f && params[1].rmax == 2.0f);
    std::cout << "PASS test_parse_range_comment_immune\n";
}

// —— 数组 uniform（回归：截掉 [N] 按标量注册会让 glUniform 只设置首元素，
//    其余元素静默保持 GL 默认 0，UI 无提示错渲染）——
// float 数组按元素展开为 w[0..N-1]（renderer 逐元素按名查询 location，GL 规范
// 保证数组元素名 "w[i]" 可直接用于 glGetUniformLocation）
static void test_parse_float_array_expansion() {
    const char* src = R"GLSL(
        uniform float w[8];
        uniform float uA;
        void main() {}
    )GLSL";
    auto params = glsl::parseUniforms(src);
    assert(params.size() == 9);
    assert(params[0].name == "w[0]" && params[0].type == glsl::ParamType::Float);
    assert(params[7].name == "w[7]" && params[7].type == glsl::ParamType::Float);
    assert(params[8].name == "uA" && params[8].type == glsl::ParamType::Float);
    std::cout << "PASS test_parse_float_array_expansion\n";
}

// vec 数组拒绝 + 告警（不再截断为单个标量槽位误导用户）
static void test_parse_vec_array_rejected_with_warning() {
    const char* src = R"GLSL(
        uniform vec3 colors[4];
        uniform float uA;
        void main() {}
    )GLSL";
    std::string warn;
    auto params = glsl::parseUniforms(src, &warn);
    assert(params.size() == 1);
    assert(params[0].name == "uA");
    assert(warn.find("colors") != std::string::npos);
    std::cout << "PASS test_parse_vec_array_rejected_with_warning\n";
}

// 维度无法解析（空维度/表达式）→ 拒绝 + 告警；数组展开受 kMaxParams 上限约束
static void test_parse_array_edge_cases() {
    const char* bad = R"GLSL(
        uniform float w[];
        uniform float uA;
        void main() {}
    )GLSL";
    std::string warn;
    auto params = glsl::parseUniforms(bad, &warn);
    assert(params.size() == 1);
    assert(params[0].name == "uA");
    assert(warn.find("w") != std::string::npos);

    std::string capWarn;
    auto capped = glsl::parseUniforms("uniform float w[64];", &capWarn);
    assert(capped.size() == 32);           // 与标量路径同口径的防御性上限
    assert(capped.back().name == "w[31]");
    // 数组元素截断必告警（首个被丢弃元素 w[32] 点名）
    assert(capWarn.find("w[32") != std::string::npos);
    std::cout << "PASS test_parse_array_edge_cases\n";
}

// 精度限定符（highp/mediump/lowp）在数值路径必须与采样器路径同款跳过
// （parseSamplerChannels 已有）。type="highp" 若被 supported() 判否 → 整条声明
// 静默跳过：ECW 少一个滑条、值恒 GL 默认 0、error.log 无任何记录。
static void test_numeric_precision_qualifier_skipped() {
    const char* src = R"GLSL(
        uniform highp float uA;
        uniform mediump vec3 uB;
        uniform lowp vec2 uC;
        uniform highp vec4 uD;
        uniform lowp float uE, uF;
        void main() {}
    )GLSL";
    auto params = glsl::parseUniforms(src);
    assert(params.size() == 6);
    assert(params[0].name == "uA" && params[0].type == glsl::ParamType::Float);
    assert(params[1].name == "uB" && params[1].type == glsl::ParamType::Vec3);
    assert(params[2].name == "uC" && params[2].type == glsl::ParamType::Vec2);
    assert(params[3].name == "uD" && params[3].type == glsl::ParamType::Vec4);
    assert(params[4].name == "uE" && params[4].type == glsl::ParamType::Float);
    assert(params[5].name == "uF" && params[5].type == glsl::ParamType::Float);
    // 限定符后接不支持类型仍须静默跳过（词流对齐：mat4 不能落到 uG 头上）
    auto p2 = glsl::parseUniforms("uniform highp mat4 uM;\nuniform float uG;\n");
    assert(p2.size() == 1 && p2[0].name == "uG");
    std::cout << "PASS test_numeric_precision_qualifier_skipped\n";
}

// 精度限定符不得绕过两个「改写源码」剥离器（只修了解析侧）。
// 旧头正则要求 `uniform` 后紧跟类型/名字：`uniform highp float uX = 1.0;` 的初始化器
// 原样进编译（GLSL 330 uniform 初始化器非法），`uniform highp float uTime;` 的内置
// 重声明原样保留（宿主 renderer 已预声明 → 严格驱动重复声明编译失败）。
static void test_precision_qualifier_strip() {
    // ① stripUniformInitializers：初始化器剥离、精度限定符原样保留
    std::string a = glsl::stripUniformInitializers(
        "uniform highp float uX = 1.0;\nuniform mediump vec3 uC = vec3(1.0);\nvoid main() {}\n");
    assert(a.find("uniform highp float uX;") != std::string::npos);
    assert(a.find("= 1.0") == std::string::npos);
    assert(a.find("uniform mediump vec3 uC;") != std::string::npos);
    assert(a.find("vec3(1.0)") == std::string::npos);
    // 逗号链：仅剥初始化器、保留后续 declarator 且精度不丢
    std::string b = glsl::stripUniformInitializers("uniform lowp float a = 0.5, b;\n");
    assert(b.find("uniform lowp float a, b;") != std::string::npos);
    // 无初始化器的精度声明原样不动（回归：不得因新头正则误改）
    std::string c0 = glsl::stripUniformInitializers("uniform highp float uPlain;\n");
    assert(c0.find("uniform highp float uPlain;") != std::string::npos);

    // ② stripBuiltinUniformDecls：内置重声明（带精度限定符）必须整条剥离
    std::string c = glsl::stripBuiltinUniformDecls(
        "uniform highp float uTime;\nuniform mediump vec2 uResolution;\n"
        "uniform float uSpeed;\n");
    assert(c.find("uTime") == std::string::npos);
    assert(c.find("uResolution") == std::string::npos);
    assert(c.find("uniform float uSpeed;") != std::string::npos);
    // 混排逗号链：内置剔除、用户 declarator 保留，精度限定符随保留声明原样保留
    std::string d = glsl::stripBuiltinUniformDecls("uniform highp float uTime, uSpeed;\n");
    assert(d.find("uTime") == std::string::npos);
    assert(d.find("uniform highp float uSpeed;") != std::string::npos);
    // 全内置链（带精度）：整条移除
    std::string e = glsl::stripBuiltinUniformDecls(
        "uniform lowp float uTime, uAspect;\nuniform float uReal;\n");
    assert(e.find("uTime") == std::string::npos && e.find("uAspect") == std::string::npos);
    assert(e.find("uniform float uReal;") != std::string::npos);

    // ③ `uniform highp sampler2D iChannel0;` 正常：采样器通道解析不受影响
    std::string warn;
    const uint8_t mask = glsl::parseSamplerChannels(
        "uniform highp sampler2D iChannel0;\nuniform highp sampler2D iChannel1;\n", &warn);
    assert(mask == 0x1);
    assert(warn.empty());

    // ④ 全链组合（renderer 顺序：先剥初始化器、再剥内置声明）后应无初始化器、无内置名
    std::string full = glsl::stripBuiltinUniformDecls(glsl::stripUniformInitializers(
        "uniform highp float uTime;\nuniform highp float uX = 1.0;\nvoid main() {}\n"));
    assert(full.find("uTime") == std::string::npos);
    assert(full.find("uniform highp float uX;") != std::string::npos);
    assert(full.find("= 1.0") == std::string::npos);
    std::cout << "PASS test_precision_qualifier_strip\n";
}

// 精度限定符 + 初始化器 / @range 的提取。这部分只
// 修了「改写源码」剥离器（stripUniformInitializers/stripBuiltinUniformDecls）与解析侧
// 跳过，defaultMap/rangeMap 两条正则仍要求 `uniform` 后紧跟类型：
// `uniform highp float uX = 0.5;` 声明正常注册（剥离后合法），但默认值读不到
// （hasDef=false → 面板/宿主滑条回退 1.0），`uniform highp float uX; // @range …`
// 读不到（回退 fallback 范围）——声明在、值/范围静默错。
static void test_precision_qualifier_default_and_range() {
    const char* src = R"GLSL(
        uniform highp float uA = 0.5;
        uniform mediump vec3 uB = vec3(0.1, 0.2, 0.3);
        uniform lowp vec4 uC = vec4(1.0, 0.0, 0.5, 1.0);
        uniform highp float uD; // @range -2.0 2.0
        uniform mediump float uE = 0.25; // @range 0.0 1.0
        uniform lowp vec2 uF; // @range -1.0 1.0
        void main() {}
    )GLSL";
    auto p = glsl::parseUniforms(src);
    assert(p.size() == 6);
    assert(p[0].name == "uA" && p[0].hasDef && p[0].def[0] == 0.5f);
    assert(p[1].name == "uB" && p[1].hasDef &&
           p[1].def[0] == 0.1f && p[1].def[1] == 0.2f && p[1].def[2] == 0.3f);
    assert(p[2].name == "uC" && p[2].hasDef && p[2].def[0] == 1.0f &&
           p[2].def[1] == 0.0f && p[2].def[2] == 0.5f && p[2].def[3] == 1.0f);
    assert(p[3].name == "uD" && p[3].hasRange && p[3].rmin == -2.0f && p[3].rmax == 2.0f);
    // 初始化器 + @range 共存：两者都要在同一行命中
    assert(p[4].name == "uE" && p[4].hasDef && p[4].def[0] == 0.25f &&
           p[4].hasRange && p[4].rmin == 0.0f && p[4].rmax == 1.0f);
    assert(p[5].name == "uF" && p[5].hasRange && p[5].rmin == -1.0f && p[5].rmax == 1.0f);

    // 对照组：无精度限定符的既有行为不变
    auto q = glsl::parseUniforms(
        "uniform float uG = 0.75;\nuniform float uH; // @range 0 10\n");
    assert(q.size() == 2 && q[0].hasDef && q[0].def[0] == 0.75f);
    assert(q[1].hasRange && q[1].rmin == 0.0f && q[1].rmax == 10.0f);
    std::cout << "PASS test_precision_qualifier_default_and_range\n";
}

// 逗号链 + 初始化器（`uniform highp float a = 1.0, b;`）的默认值读取。
// 合法性问题（查证结论，不凭记忆）：GLSL ES 1.00 与桌面 GLSL 的声明语法都是
// init_declarator_list 递归（`COMMA IDENTIFIER` / `COMMA IDENTIFIER EQUAL initializer`）
// ——该写法**语法合法**；被拒绝的是"uniform 带初始化器"这一语义（ANGLE 实测对
// ES 1.00/3.00 都报 "cannot initialize this type of qualifier"，与单 declarator 形态
// `uniform float a = 1.0;` 完全相同）。项目既定政策 = 编译前剥离初始化器（两侧剥离器
// 都保留链上后续 declarator），默认值由解析侧读取——故链上首个 declarator 的默认值
// 必须与单 declarator 形态同样读到。declRe 的 `[^;]+` 把 ", b" 吞进表达式
// → parseInitValues 判失败 → a 的默认值静默丢失（面板/宿主滑条回退 1.0，无任何告警）。
static void test_comma_chain_initializer_default() {
    // ① 精度前缀 + 逗号链（报告点名形态）
    {
        auto p = glsl::parseUniforms("uniform highp float a = 1.0, b;\n");
        assert(p.size() == 1 && p[0].name == "a");   // 链上后续 declarator 不注册（既定行为）
        assert(p[0].hasDef && p[0].def[0] == 1.0f);
    }
    // ② 无精度限定符的同形写法（既有形态，同样需读到）
    {
        auto p = glsl::parseUniforms("uniform float a = 2.0, b;\n");
        assert(p.size() == 1 && p[0].hasDef && p[0].def[0] == 2.0f);
    }
    // ③ vec 初始化器内含逗号：不是 declarator 分隔符（括号深度感知）
    {
        auto p = glsl::parseUniforms("uniform vec3 c = vec3(0.1, 0.2, 0.3), d;\n");
        assert(p.size() == 1 && p[0].name == "c");
        assert(p[0].hasDef && p[0].def[0] == 0.1f && p[0].def[1] == 0.2f && p[0].def[2] == 0.3f);
    }
    // ④ 链上每个 declarator 都带初始化器：首个照读
    {
        auto p = glsl::parseUniforms("uniform float a = 0.25, b = 0.75;\n");
        assert(p.size() == 1 && p[0].hasDef && p[0].def[0] == 0.25f);
    }
    // ⑤ 单 declarator 形态回归（不受截断影响）
    {
        auto p = glsl::parseUniforms("uniform float a = 3.0;\n");
        assert(p.size() == 1 && p[0].hasDef && p[0].def[0] == 3.0f);
        auto v = glsl::parseUniforms("uniform vec4 col = vec4(1.0, 0.5, 0.25, 1.0);\n");
        assert(v.size() == 1 && v[0].hasDef && v[0].def[1] == 0.5f && v[0].def[2] == 0.25f);
    }
    // ⑥ 表达式初始化器（非字面量）仍拒绝：既定边界，不因截断变成误读
    {
        auto p = glsl::parseUniforms("uniform float a = 1.0 + 2.0, b;\n");
        assert(p.size() == 1 && !p[0].hasDef);
    }
    std::cout << "PASS test_comma_chain_initializer_default\n";
}

// 精度限定符剥离（宿主编译端专用，330 core 无精度语义）。
// 观察级条目「宿主以 #version 330 core 保留 highp 限定符，驱动接受度属真机复验项」：
// 剥离后语义中性（桌面无精度语义）、行数不变（#line 1 映射不漂移），严格驱动
//（AMD/Intel）不再因 ES 语法编译失败；NVIDIA 宽容下行为不变。
static void test_strip_precision_qualifiers() {
    // ① 声明前缀：关键字删除、其余原样
    std::string a = glsl::stripPrecisionQualifiers(
        "uniform highp float uA;\nuniform mediump vec3 uB;\nuniform lowp vec4 uC;\n");
    assert(a.find("highp") == std::string::npos);
    assert(a.find("mediump") == std::string::npos);
    assert(a.find("lowp") == std::string::npos);
    assert(a.find("uniform  float uA;") != std::string::npos);
    assert(a.find("uniform  vec3 uB;") != std::string::npos);
    // ② precision 语句整条移除（含其中的换行保留：行数不变）
    std::string b = glsl::stripPrecisionQualifiers("precision highp float;\nuniform float uX;\n");
    assert(b.find("precision") == std::string::npos);
    assert(b.find("uniform float uX;") != std::string::npos);
    size_t nl = 0; for (char c : b) if (c == '\n') ++nl;
    assert(nl == 2);   // 两条语句各保留原换行
    // ③ 局部变量/形参前的限定符同样删除
    std::string c = glsl::stripPrecisionQualifiers(
        "vec4 mainImage(vec2 f, float t) { mediump float k = 0.5; return vec4(k); }\n");
    assert(c.find("mediump") == std::string::npos);
    assert(c.find("float k = 0.5;") != std::string::npos);
    // ④ 注释内字面量原样保留（注释门控，与其他剥离器同款）
    std::string d = glsl::stripPrecisionQualifiers("// use highp on mobile\nuniform float uY;\n");
    assert(d.find("use highp on mobile") != std::string::npos);
    // ④b 语句内含注释（① 不命中）：限定符**不得**被②单独删——留着整句与改动前
    // 逐字一致（只删关键字会留下 `precision float;` 这种更坏的残句）
    std::string d2 = glsl::stripPrecisionQualifiers("precision /* keep */ highp float;\n");
    assert(d2.find("precision /* keep */ highp float;") != std::string::npos);
    // ⑤ 无精度限定符源码逐字节不变（正常路径零影响）
    const char* plain = "uniform float uZ = 0.5;\nvoid mainImage(vec2 f, float t) {}\n";
    assert(glsl::stripPrecisionQualifiers(plain) == plain);
    // ⑥ 与解析侧口径一致：剥离后仍是同一条声明（名字/类型/默认值都在）
    auto p = glsl::parseUniforms(a);
    assert(p.size() == 3 && p[0].name == "uA" && p[1].name == "uB" && p[2].name == "uC");
    std::cout << "PASS test_strip_precision_qualifiers\n";
}


// 多维 float 数组整条拒绝并告警——只展开第一维会注册出
// w[0]/w[1] 这种 GL 里不存在的名字（glGetUniformLocation 恒 -1 的死滑条，
// 拖了永不生效且零诊断）。与 vec 数组同政策，不截取第一维展开。
static void test_multidim_float_array_rejected() {
    // 形态一：同一 token（`w[2][3]`）；三维同样拒绝
    const char* src = R"GLSL(
        uniform float w[2][3];
        uniform float v[2][3][4];
        uniform float uA;
        void main() {}
    )GLSL";
    std::string warn;
    auto params = glsl::parseUniforms(src, &warn);
    assert(params.size() == 1);
    assert(params[0].name == "uA");
    assert(warn.find("[uniform 数组不支持]") != std::string::npos);
    assert(warn.find("多维") != std::string::npos);
    assert(warn.find("w") != std::string::npos);
    assert(warn.find("v") != std::string::npos);

    // 形态二：维度间夹空白（`w[2] [3]`，GLSL 合法）——同样整条拒绝，
    // 且链上第二个 declarator b 与下一条 uniform 均不丢失
    std::string warn2;
    auto p2 = glsl::parseUniforms(
        "uniform float w[2] [3], b;\nuniform float uA;\n", &warn2);
    assert(p2.size() == 2);
    assert(p2[0].name == "b" && p2[1].name == "uA");
    assert(warn2.find("[uniform 数组不支持]") != std::string::npos);

    // 政策边界：一维 float 数组不受影响（仍按元素展开，无告警）
    std::string warn3;
    auto p3 = glsl::parseUniforms("uniform float v[3];", &warn3);
    assert(p3.size() == 3 && p3[0].name == "v[0]" && p3[2].name == "v[2]");
    assert(warn3.empty());
    std::cout << "PASS test_multidim_float_array_rejected\n";
}

// —— 终结符归一化：`;` 与下一条声明的 `uniform` 之间无空白时，
//    后续声明若被整条静默丢弃（AE 效果控件少一个滑条、值恒为 GL 默认 0、error.log 空）——
//    与通道解析器同族，parseUniforms 一并在此归一化 ——
static void test_glued_semicolon_declarations() {
    auto p = glsl::parseUniforms("uniform float uA;uniform float uB;\nvoid main() {}\n");
    assert(p.size() == 2);
    assert(p[0].name == "uA" && p[1].name == "uB");

    // 逗号链 + 粘连分号
    p = glsl::parseUniforms("uniform vec2 a,b;uniform float uC;\nvoid main() {}\n");
    assert(p.size() == 3);
    assert(p[0].name == "a" && p[0].type == glsl::ParamType::Vec2);
    assert(p[1].name == "b");
    assert(p[2].name == "uC");

    // 数组展开 + 粘连分号（展开 3 个 + 后续 1 个）
    p = glsl::parseUniforms("uniform float arr[3];uniform float uB;\nvoid main() {}\n");
    assert(p.size() == 4);
    assert(p[0].name == "arr[0]" && p[3].name == "uB");

    // 三连粘连 + 连续分号 `;;`
    p = glsl::parseUniforms("uniform vec2 uP;uniform vec3 uQ;uniform float uR;\nvoid main() {}\n");
    assert(p.size() == 3);
    assert(p[0].name == "uP" && p[1].name == "uQ" && p[2].name == "uR");
    p = glsl::parseUniforms("uniform float uA;;uniform float uB;\nvoid main() {}\n");
    assert(p.size() == 2 && p[0].name == "uA" && p[1].name == "uB");

    // 默认值与 @range 在**常规写法**（声明各自成行）下照常生效
    p = glsl::parseUniforms("uniform float uA = 3.0;\nuniform float uB; // @range 0 10\n");
    assert(p.size() == 2);
    assert(p[0].hasDef && p[0].def[0] == 3.0f);
    assert(p[1].hasRange && p[1].rmin == 0.0f && p[1].rmax == 10.0f);

    // 已知口径（畸形输入，如实钉住而非修正）：一行里写两条声明 + 行尾 @range 时，
    // @range 是**行尾注释**、按行扫描，会挂到该行的**第一条**声明上（uA 拿到 uB 的范围）。
    // 契约要求"声明行尾写 @range"，正常写法（一条声明一行）不受影响；此处钉住现状，
    // 将来若改语义会被这条断言提醒。
    p = glsl::parseUniforms("uniform float uA = 3.0;uniform float uB; // @range 0 10\n");
    assert(p.size() == 2);
    assert(p[0].hasRange && p[0].rmin == 0.0f && p[0].rmax == 10.0f);
    std::cout << "PASS test_glued_semicolon_declarations\n";
}

// —— 逗号分隔多声明（回归：注册出 "a," 坏名 → glGetUniformLocation 恒 -1，
//    槽位显示但值永不生效；后续名字被词流丢弃 → 静默保持 GL 默认 0）——
static void test_parse_comma_declarations() {
    // 基本形态：两个名字全部注册、名字干净
    auto p = glsl::parseUniforms("uniform float uA, uB;\nvoid main() {}\n");
    assert(p.size() == 2);
    assert(p[0].name == "uA" && p[0].type == glsl::ParamType::Float);
    assert(p[1].name == "uB" && p[1].type == glsl::ParamType::Float);

    // vec 类型 + 三个名字
    p = glsl::parseUniforms("uniform vec3 uP, uQ, uR;\nvoid main() {}\n");
    assert(p.size() == 3);
    assert(p[0].name == "uP" && p[0].type == glsl::ParamType::Vec3);
    assert(p[2].name == "uR");

    // 逗号前后带空格（逗号独立成 token）
    p = glsl::parseUniforms("uniform float uA , uB;\nvoid main() {}\n");
    assert(p.size() == 2);
    assert(p[0].name == "uA" && p[1].name == "uB");

    // 混排：逗号声明 + 后续独立声明，词流不失步
    p = glsl::parseUniforms("uniform float uA, uB;\nuniform vec2 uC;\nvoid main() {}\n");
    assert(p.size() == 3);
    assert(p[0].name == "uA" && p[1].name == "uB");
    assert(p[2].name == "uC" && p[2].type == glsl::ParamType::Vec2);

    // 数组 + 逗号：数组展开后继续处理后续名字
    p = glsl::parseUniforms("uniform float w[2], uB;\nvoid main() {}\n");
    assert(p.size() == 3);
    assert(p[0].name == "w[0]" && p[1].name == "w[1]");
    assert(p[2].name == "uB");

    // 内置名混在逗号声明中：跳过内置、注册其余
    p = glsl::parseUniforms("uniform float uTime, uA;\nvoid main() {}\n");
    assert(p.size() == 1);
    assert(p[0].name == "uA");

    // 初始化器终结声明（`a = 0.5;`）：a 正常注册，默认值由 defaultMap 提供
    p = glsl::parseUniforms("uniform float uX = 0.5;\nvoid main() {}\n");
    assert(p.size() == 1);
    assert(p[0].name == "uX" && p[0].hasDef && p[0].def[0] == 0.5f);

    // 初始化器后接逗号：与 stripUniformInitializers 的"仅剥初始化器段、保留后续
    // declarator"行为对齐——解析端仅注册首个名字，但其默认值必须读到。
    // 该写法**语法合法**——GLSL ES 1.00 与桌面
    // GLSL 的声明语法都递归允许 `COMMA IDENTIFIER` / `COMMA IDENTIFIER EQUAL initializer`
    // 续链；被拒绝的是"uniform 带初始化器"这一语义（ANGLE 实测对 ES 1.00/3.00 都报
    // "cannot initialize this type of qualifier"，与单 declarator 形态完全相同），
    // 两侧都靠编译前剥离处理 → 默认值读取必须与单 declarator 形态一致。
    p = glsl::parseUniforms("uniform float uX = 0.5, uY;\nvoid main() {}\n");
    assert(p.size() == 1);
    assert(p[0].name == "uX" && p[0].hasDef && p[0].def[0] == 0.5f);

    // 逗号声明与 @range 注释共存：rangeMap 正则按声明行首个名字键控——
    // 首名命中，后续名走默认范围（注释属行级元信息，组合场景极罕见，
    // 文档化现状即可；LLM 模板均为每名一行）
    p = glsl::parseUniforms("uniform float uA, uB; // @range -2.0 2.0\nvoid main() {}\n");
    assert(p.size() == 2);
    assert(p[0].hasRange && p[0].rmin == -2.0f && p[0].rmax == 2.0f);
    assert(!p[1].hasRange);

    // 初始化器粘连形式（`uX=0.5;` 无空格，名字/=/值/; 同一 token）：
    // 声明内已含终结符，不得再吞流（回归：曾误吞下一条声明致其丢失）
    p = glsl::parseUniforms("uniform float uX=0.5;\nuniform float uY;\nvoid main() {}\n");
    assert(p.size() == 2);
    assert(p[0].name == "uX" && p[0].hasDef && p[0].def[0] == 0.5f);
    assert(p[1].name == "uY");

    // 等号独立成 token 且初始化器整体含 ';'（`uX = 0.5;`）：
    // 同样不得误吞下一条声明
    p = glsl::parseUniforms("uniform float uX = 0.5;\nuniform float uY;\nvoid main() {}\n");
    assert(p.size() == 2);
    assert(p[0].name == "uX" && p[0].hasDef);
    assert(p[1].name == "uY");

    // 漏分号畸形输入（`a, uniform float b;`）：逗号链遇 "uniform" 关键字视为
    // 新语句开始（回归：曾注册名为 "uniform" 的伪参数且丢失 b）
    p = glsl::parseUniforms("uniform float uA, uniform float uB;\nvoid main() {}\n");
    assert(p.size() == 2);
    assert(p[0].name == "uA" && p[1].name == "uB");

    // 逗号独立成 token 的漏分号形式
    p = glsl::parseUniforms("uniform float uA , uniform float uB;\nvoid main() {}\n");
    assert(p.size() == 2);
    assert(p[0].name == "uA" && p[1].name == "uB");

    // 逗号与 uniform 无空格粘连的漏分号形式（haveTok 交还后按新语句恢复）
    p = glsl::parseUniforms("uniform float uA,uniform float uB;\nvoid main() {}\n");
    assert(p.size() == 2);
    assert(p[0].name == "uA" && p[1].name == "uB");

    std::cout << "PASS test_parse_comma_declarations\n";
}

// ── stripUniformInitializers 注释门控 ——
// 头匹配与改写扫描器均对原始 src 直接工作时：注释内的 `uniform … =`
// 伪声明会把注释闭合符之后的第一处深度 0 ';'/',' 当终结符，真实声明被当
// 初始化器吞掉、块注释失去闭合符殃及后续源码（所编译源码≠所见源码）。
static void test_strip_initializers_comment_immune() {
    // 块注释内伪声明：真实声明必须保留并正常剥离初始化器，注释原样保留
    std::string s1 = glsl::stripUniformInitializers(
        "/* uniform float uOld = */\nuniform float uReal = 1.0;\nvoid main() {}\n");
    assert(s1.find("/* uniform float uOld = */") != std::string::npos);  // 注释原样
    assert(s1.find("uniform float uReal;") != std::string::npos);       // 真实声明存活
    assert(s1.find("= 1.0") == std::string::npos);                      // 初始化器仍剥离
    // 行注释内伪声明（含分号）：整行注释原样保留，不吞后续声明
    std::string s2 = glsl::stripUniformInitializers(
        "// uniform float uOld = 0.5;\nuniform float uReal = 1.0;\nvoid main() {}\n");
    assert(s2.find("// uniform float uOld = 0.5;") != std::string::npos);
    assert(s2.find("uniform float uReal;") != std::string::npos);
    // 初始化器内含注释：注释中的 ';'/',' 不参与终结判定（无门控时会在
    // `/* x;y */` 的 ';' 处提前终结，泄漏 `y */ 0.5;` 碎片成语法错误）
    std::string s3 = glsl::stripUniformInitializers(
        "uniform float b = /* x;y */ 0.5;\nvoid main() {}\n");
    assert(s3.find("uniform float b;") != std::string::npos);
    assert(s3.find("y */") == std::string::npos);   // 注释内容不得泄漏为活代码
    assert(s3.find("0.5") == std::string::npos);
    // 同一块注释内多个伪声明 + 注释后真实声明
    std::string s4 = glsl::stripUniformInitializers(
        "/* uniform float a = 0.5; uniform float b = 1.0; */\nuniform float c = 2.0;\n");
    assert(s4.find("uniform float c;") != std::string::npos);
    assert(s4.find("/* uniform float a = 0.5; uniform float b = 1.0; */") != std::string::npos);
    std::cout << "PASS test_strip_initializers_comment_immune\n";
}

// ── 剥离内置 uniform 声明（拼接前防同作用域重复声明编译错误）——
static void test_strip_builtin_uniform_decls() {
    // 独立声明整条移除，用户声明保留
    std::string a = glsl::stripBuiltinUniformDecls(
        "uniform float uTime;\nuniform vec2 uResolution;\nuniform float uAspect;\n"
        "uniform float uSpeed;\nvoid main(){}\n");
    assert(a.find("uTime") == std::string::npos);
    assert(a.find("uResolution") == std::string::npos);
    assert(a.find("uAspect") == std::string::npos);
    assert(a.find("uniform float uSpeed;") != std::string::npos);
    // sampler2D 内置移除、用户 sampler 保留
    std::string b = glsl::stripBuiltinUniformDecls(
        "uniform sampler2D iChannel0;\nuniform sampler2D iChannel1;\nuniform sampler2D myTex;\n");
    assert(b.find("iChannel0") == std::string::npos);
    assert(b.find("iChannel1") == std::string::npos);
    assert(b.find("uniform sampler2D myTex;") != std::string::npos);
    // 逗号链：仅剔内置 declarator、保留其余
    std::string c = glsl::stripBuiltinUniformDecls("uniform float uTime, uSpeed;\n");
    assert(c.find("uTime") == std::string::npos);
    assert(c.find("uniform float uSpeed;") != std::string::npos);
    // 全内置链：整条移除
    std::string d = glsl::stripBuiltinUniformDecls("uniform float uTime, uAspect;\n");
    assert(d.find("uTime") == std::string::npos && d.find("uAspect") == std::string::npos);
    // 注释内伪声明原样保留（不剥离不动注释）
    std::string e = glsl::stripBuiltinUniformDecls(
        "// uniform float uTime;\n/* uniform vec2 uResolution; */\nuniform float uReal;\n");
    assert(e.find("// uniform float uTime;") != std::string::npos);
    assert(e.find("/* uniform vec2 uResolution; */") != std::string::npos);
    assert(e.find("uniform float uReal;") != std::string::npos);
    // 内置名作前后缀的用户命名不受影响（uTimer/uTimex 均非 uTime）
    std::string f = glsl::stripBuiltinUniformDecls(
        "uniform float uTimer;\nuniform vec2 xuTimey;\n");
    assert(f.find("uniform float uTimer;") != std::string::npos);
    assert(f.find("uniform vec2 xuTimey;") != std::string::npos);
    // 数组维度保留（非内置 declarator 带维度续链）
    std::string g = glsl::stripBuiltinUniformDecls("uniform float uTime, w[4];\n");
    assert(g.find("uniform float w[4];") != std::string::npos);
    // 链上带初始化器（调用方应先过 stripUniformInitializers）：原样保留不改坏
    std::string h = glsl::stripBuiltinUniformDecls("uniform float uTime = 1.0;\n");
    assert(h.find("uniform float uTime = 1.0;") != std::string::npos);
    // L2 相机感知内置：独立声明移除 / mat4 同样按名字剥离 / 用户命名不受影响
    std::string i = glsl::stripBuiltinUniformDecls(
        "uniform float uHasCam;\nuniform float uCamFov;\nuniform vec3 uCamPos;\n"
        "uniform mat4 uCamMatrix;\n"
        "uniform mat4 uWorldMatrix;\nuniform mat4 uUserMatrix;\nuniform float uCamPosScale;\n");
    assert(i.find("uHasCam") == std::string::npos);
    assert(i.find("uCamFov") == std::string::npos);
    assert(i.find("uCamPos;") == std::string::npos);      // uCamPosScale 不受影响（词边界）
    assert(i.find("uCamMatrix") == std::string::npos);
    assert(i.find("uWorldMatrix") == std::string::npos);
    assert(i.find("uniform mat4 uUserMatrix;") != std::string::npos);
    assert(i.find("uniform float uCamPosScale;") != std::string::npos);
    // L3 灯光内置：**数组声明**同样按裸名剥离（head 正则只捕类型与裸名，维度在其后；
    // 裸名比对是这条正确性的关键——带 [8] 比对会全部漏剥，严格驱动上重复声明即编译失败）
    std::string j = glsl::stripBuiltinUniformDecls(
        "uniform float uHasLights;\nuniform float uLightCount;\n"
        "uniform float uLightType[8];\nuniform vec3 uLightPos[8];\n"
        "uniform vec3 uLightDir[8];\nuniform vec3 uLightColor[8];\n"
        "uniform vec4 uLightParams[8];\n"
        "uniform vec3 uLightPosOffset;\n");   // 词边界：不得误伤
    assert(j.find("uHasLights") == std::string::npos);
    assert(j.find("uLightCount") == std::string::npos);
    assert(j.find("uLightType") == std::string::npos);
    assert(j.find("uLightPos[8]") == std::string::npos);
    assert(j.find("uLightDir") == std::string::npos);
    assert(j.find("uLightColor") == std::string::npos);
    assert(j.find("uLightParams") == std::string::npos);
    assert(j.find("uniform vec3 uLightPosOffset;") != std::string::npos);
    std::cout << "PASS test_strip_builtin_uniform_decls\n";
}

// ── isColorNamed 词法边界校验 ——
// 任意位置匹配 4 字符前缀 "colo"/"coul" 会把 coulomb 类物理量命名误判
// 颜色语义（vec3 渲染成取色器丢分量编辑）。
static void test_is_color_named_boundaries() {
    // 命中：完整词 / 驼峰词边界
    assert(glsl::isColorNamed("color"));
    assert(glsl::isColorNamed("colour"));
    assert(glsl::isColorNamed("uColor"));            // 驼峰前边界（前小写+词首大写）
    assert(glsl::isColorNamed("colorTint"));         // 驼峰后边界（词后接大写子词）
    assert(glsl::isColorNamed("BackgroundColor"));
    assert(glsl::isColorNamed("my_colour_value"));   // 下划线词边界
    assert(glsl::isColorNamed("COLOUR"));            // 大小写不敏感
    assert(glsl::isColorNamed("colourMix"));
    // 命中：短颜色词 + 至多一个字符段（uColA / uBg / uTint / col0 / col_A）
    assert(glsl::isColorNamed("uColA"));
    assert(glsl::isColorNamed("uColB"));
    assert(glsl::isColorNamed("uColC"));
    assert(glsl::isColorNamed("uBg"));
    assert(glsl::isColorNamed("uTint"));
    assert(glsl::isColorNamed("uRgb"));
    assert(glsl::isColorNamed("col"));
    assert(glsl::isColorNamed("col0"));
    assert(glsl::isColorNamed("col_A"));
    assert(glsl::isColorNamed("uRGB"));
    // 不命中：4 字符前缀的更长物理量词（审计例）
    assert(!glsl::isColorNamed("coulomb"));
    assert(!glsl::isColorNamed("coulombConstant"));
    assert(!glsl::isColorNamed("coulombForce"));     // "coul" 前缀会误命中
    // 不命中：color/colour 作为更长词的非词首部分
    assert(!glsl::isColorNamed("decolorize"));
    assert(!glsl::isColorNamed("colorectal"));
    // 不命中：短颜色词后接普通词干（颜色词 + 词干的向量仍是分量控件）
    assert(!glsl::isColorNamed("uColOffset"));
    assert(!glsl::isColorNamed("bgDir"));
    assert(!glsl::isColorNamed("uTintSpeed"));
    assert(!glsl::isColorNamed("uColAB"));
    assert(!glsl::isColorNamed("column"));
    assert(!glsl::isColorNamed("colormap"));
    // 不命中：无关命名
    assert(!glsl::isColorNamed("uOffset"));
    assert(!glsl::isColorNamed("uSpeed"));
    assert(glsl::isColorNamed("u_col_a"));
    assert(glsl::isColorNamed("col_"));
    assert(!glsl::isColorNamed(""));
    std::cout << "PASS test_is_color_named_boundaries\n";
}

// —— isAngleNamed（角度语义，供槽位滑条量程用）——
// 与 isColorNamed 的"整词"口径不同：角度要覆盖 rotation / rotSpeed / degrees /
// degToRad 这些**词干派生**名，故只要求词首边界、不要求词尾边界（见实现注释）。
// —— 输入侧跳过：库内示例的判据必须与设计意图一致 ——
// inputLayerNeeded 用的是**源码串包含**判定（见 uniformParser.cpp）：所以给 shader 写注释时
// 不小心写出输入纹理的名字，也会让快路径失效——症状是"优化悄悄不生效"，没有任何报错。
// 这里按真实种子文件把每条的期望值钉死：纯生成类必须为 false，需要输入的必须为 true。
static std::string readSeedFile(const char* name) {
    std::ifstream in(std::string(SHADER_SEED_DIR) + "/" + name, std::ios::binary);
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

static void test_input_layer_needed_library_examples() {
    // 纯生成类示例（库内第一个"不读输入图层"的）→ 必须 false，否则快路径白写。
    // 注意：本示例 .glsl 的注释里刻意不出现输入纹理的名字，就是为守住这条。
    {
        const std::string src = readSeedFile("example_generator_aurora.glsl");
        assert(!src.empty() && "种子示例读不到——检查 SHADER_SEED_DIR");
        assert(!glsl::inputLayerNeeded(src));
    }
    // 需要读输入的示例 → true。列在这里是让「输入依赖变化」这种结构性变化
    // 必须显式改这份清单，而不是悄悄改变判据覆盖面。
    const char* needInput[] = {
        "example_history_trail.glsl",      // 采样本图层输入做拖尾
        "example_reaction_diffusion.glsl", // 非结算模式（@iterations）首趟读输入
    };
    for (const char* n : needInput) {
        const std::string src = readSeedFile(n);
        assert(!src.empty() && "种子示例读不到——检查 SHADER_SEED_DIR");
        assert(glsl::inputLayerNeeded(src));
    }
    std::cout << "PASS test_input_layer_needed_library_examples\n";
}

static void test_is_angle_named_boundaries() {
    // 命中：词干在串首（无后缀）
    assert(glsl::isAngleNamed("angle"));
    assert(glsl::isAngleNamed("deg"));
    assert(glsl::isAngleNamed("rot"));
    // 命中：词干派生（词尾边界不要求——这正是与 isColorNamed 的差异所在）
    assert(glsl::isAngleNamed("rotation"));
    assert(glsl::isAngleNamed("rotSpeed"));
    assert(glsl::isAngleNamed("degrees"));
    assert(glsl::isAngleNamed("degree"));
    assert(glsl::isAngleNamed("degToRad"));
    // 命中：驼峰 / 下划线词首边界
    assert(glsl::isAngleNamed("uAngle"));
    assert(glsl::isAngleNamed("angleDeg"));
    assert(glsl::isAngleNamed("uRot"));
    assert(glsl::isAngleNamed("uDeg"));
    assert(glsl::isAngleNamed("my_angle_value"));
    assert(glsl::isAngleNamed("ANGLE"));             // 大小写不敏感
    // 不命中：词干落在词中间（前边界不成立）——proton/carrot 的 "rot"、
    // triangle 的 "angle" 都前接小写字母，不构成词首
    assert(!glsl::isAngleNamed("proton"));
    assert(!glsl::isAngleNamed("carrot"));
    assert(!glsl::isAngleNamed("triangle"));
    // 不命中：无关命名
    assert(!glsl::isAngleNamed("uOffset"));
    assert(!glsl::isAngleNamed("uScale"));
    assert(!glsl::isAngleNamed("coulomb"));
    assert(!glsl::isAngleNamed(""));
    std::cout << "PASS test_is_angle_named_boundaries\n";
}

// L4 全分辨率尺寸内置（uLayerSize，vec2）：这是**最容易漏过滤**的一类——它是 vec2，
// 若漏过滤会被注册成一个"幽灵取色器/双分量滑条"，且渲染期 userSlots 上传与内置上传
// 查到同一 location，滑块值会覆盖真实图层尺寸 → 场景锚点被用户无感知地改掉。
// 剥离名单同理必须含它（renderer 预声明，用户重复声明即编译期重定义失败）。
static void test_ignore_layer_size_builtin() {
    const char* src = R"GLSL(
        uniform vec2 uLayerSize;
        uniform float uAmount;
        void main() {}
    )GLSL";
    auto params = glsl::parseUniforms(src);
    assert(params.size() == 1);
    assert(params[0].name == "uAmount");
    std::string stripped = glsl::stripBuiltinUniformDecls(
        "uniform vec2 uLayerSize;\nuniform vec2 uLayerSizeUser;\n");
    assert(stripped.find("uniform vec2 uLayerSize;") == std::string::npos);
    assert(stripped.find("uLayerSizeUser") != std::string::npos);   // 词边界不误伤
    std::cout << "PASS test_ignore_layer_size_builtin\n";
}

void runUniformParserTests() {
    test_parse_three_types();
    test_ignore_unsupported_and_builtin();
    test_ignore_camera_builtins();
    test_ignore_light_builtins();
    test_ignore_layer_size_builtin();
    test_over_32_capped();
    test_ignore_comments();
    test_parse_default_values();
    test_parse_vec4_type();
    test_strip_uniform_initializers();
    test_parse_range_annotation();
    test_parse_range_tolerance();
    test_parse_range_comment_immune();
    test_parse_float_array_expansion();
    test_parse_vec_array_rejected_with_warning();
    test_parse_array_edge_cases();
    test_numeric_precision_qualifier_skipped();
    test_precision_qualifier_strip();
    test_precision_qualifier_default_and_range();
    test_comma_chain_initializer_default();
    test_strip_precision_qualifiers();
    test_multidim_float_array_rejected();
    test_glued_semicolon_declarations();
    test_parse_comma_declarations();
    test_strip_initializers_comment_immune();
    test_strip_builtin_uniform_decls();
    test_is_color_named_boundaries();
    test_is_angle_named_boundaries();
    test_input_layer_needed_library_examples();
    std::cout << "ALL uniform parser tests passed\n";
}
