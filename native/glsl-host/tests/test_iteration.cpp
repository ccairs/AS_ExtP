// 迭代趟：帧内多趟 ping-pong 迭代 —— 解析层单元测试
// 断言纪律同 test_sampler_channels.cpp：#undef NDEBUG 必须在任何头包含之前
//（Release 构建默认 /DNDEBUG，否则 assert 全部空转，"PASSED" 只证明不崩溃）。
#undef NDEBUG
#include <cassert>
#include <iostream>
#include <string>
#include <vector>
#include "uniformParser.h"
#include "solverSchedule.h"   // test_solve_res：网格尺寸 ↔ 逐帧缓存预算的自洽断言

// —— hasIteratePass：只认定义形态，注释内的伪定义不算 ——

static void test_iterate_pass_absent() {
    assert(!glsl::hasIteratePass(""));
    assert(!glsl::hasIteratePass("uniform float uAmount;\n"));
    // 纯调用不算定义（与面板 validator 的 noise 族撞名预检同款口径）
    assert(!glsl::hasIteratePass(
        "vec4 mainImage(vec2 f, float t){ return iterateImage(f, t); }\n"));
    std::cout << "PASS test_iterate_pass_absent\n";
}

static void test_iterate_pass_present() {
    assert(glsl::hasIteratePass("vec4 iterateImage(vec2 fragCoord, float time) { return vec4(0.0); }\n"));
    // 换行/多余空白
    assert(glsl::hasIteratePass("vec4\n  iterateImage  ( vec2 f , float t )\n{ return vec4(0.0); }\n"));
    // 与 mainImage 并存
    const char* both =
        "vec4 iterateImage(vec2 f, float t) { return vec4(t); }\n"
        "vec4 mainImage(vec2 f, float t) { return vec4(1.0); }\n";
    assert(glsl::hasIteratePass(both));
    std::cout << "PASS test_iterate_pass_present\n";
}

static void test_iterate_pass_ignores_comments() {
    // 行注释掉的伪定义不算——否则用户注释掉迭代趟后宿主仍去编译不存在的入口
    assert(!glsl::hasIteratePass("// vec4 iterateImage(vec2 f, float t) { }\n"));
    // 块注释同理
    assert(!glsl::hasIteratePass("/* vec4 iterateImage(vec2 f, float t) { } */\n"));
    // 注释在真定义之前，真定义仍须命中
    assert(glsl::hasIteratePass("// vec4 iterateImage(vec2 f, float t) { }\n"
                                "vec4 iterateImage(vec2 f, float t) { return vec4(0.0); }\n"));
    std::cout << "PASS test_iterate_pass_ignores_comments\n";
}

// —— parseIterations：默认值 / 显式值 / 钳制 ——

static void test_iterations_default() {
    // 未声明 → 默认值
    assert(glsl::parseIterations("vec4 iterateImage(vec2 f, float t){}", 8) == 8);
    // 自定义默认值透传
    assert(glsl::parseIterations("uniform float uAmount;", 3) == 3);
    std::cout << "PASS test_iterations_default\n";
}

static void test_iterations_explicit() {
    assert(glsl::parseIterations("// @iterations 16\nvec4 iterateImage(vec2 f,float t){}", 8) == 16);
    assert(glsl::parseIterations("// @iterations 1\n", 8) == 1);
    // 与 @range 指令共存不互相干扰
    const char* src =
        "// @iterations 24\n"
        "uniform float uAmount = 0.5;   // @range 0.0 1.0\n"
        "vec4 iterateImage(vec2 f, float t){ return vec4(0.0); }\n";
    assert(glsl::parseIterations(src, 8) == 24);
    std::cout << "PASS test_iterations_explicit\n";
}

static void test_iterations_clamped() {
    // 0 / 超大 / 非数字 → 钳制或回落默认
    assert(glsl::parseIterations("// @iterations 0\n", 8) == 1);          // 下限钳到 1
    assert(glsl::parseIterations("// @iterations 999\n", 8) == glsl::kMaxIterations);
    assert(glsl::parseIterations("// @iterations 999999999999\n", 8) == glsl::kMaxIterations);  // 超长数字串
    assert(glsl::parseIterations("// @iterations abc\n", 8) == 8);        // 非数字 → 默认
    assert(glsl::parseIterations("// @iterations -3\n", 8) == 8);         // 负号不匹配 → 默认
    // 取首个匹配：文件级单一事实，尾部示例值不覆盖
    assert(glsl::parseIterations("// @iterations 4\n// @iterations 32\n", 8) == 4);
    std::cout << "PASS test_iterations_clamped\n";
}

// —— 迭代内置不得被当成用户 uniform（幽灵滑块会覆盖宿主每帧写入的趟号）——

static void test_iterate_builtins_not_user_uniforms() {
    const char* src =
        "uniform sampler2D iPrev;\n"
        "uniform float uIter;\n"
        "uniform float uIterCount;\n"
        "uniform float uAmount;\n";
    std::string warn;
    std::vector<glsl::Param> ps = glsl::parseUniforms(src, &warn);
    assert(ps.size() == 1);
    assert(ps[0].name == "uAmount");
    std::cout << "PASS test_iterate_builtins_not_user_uniforms\n";
}

// —— 迭代内置声明必须被剥离（宿主已预声明，重复声明是编译错误）——

static void test_iterate_builtins_stripped() {
    std::string out = glsl::stripBuiltinUniformDecls(
        "uniform sampler2D iPrev;\n"
        "uniform float uIter;\n"
        "uniform float uIterCount;\n"
        "uniform float uAmount;\n");
    assert(out.find("iPrev") == std::string::npos);
    assert(out.find("uIter") == std::string::npos);
    assert(out.find("uAmount") != std::string::npos);
    std::cout << "PASS test_iterate_builtins_stripped\n";
}

// —— iPrev 是宿主绑定的内置采样器，不得产生"未绑定的采样器"告警 ——

static void test_iprev_no_sampler_warning() {
    std::string warn;
    uint8_t mask = glsl::parseSamplerChannels("uniform sampler2D iPrev;\n", &warn);
    assert(mask == 0);          // 不是图层 checkout，不进 mask
    assert(warn.empty());       // 也不得告警
    // 与图层通道共存
    warn.clear();
    mask = glsl::parseSamplerChannels(
        "uniform sampler2D iChannel1;\nuniform sampler2D iPrev;\nuniform sampler2D iChannel3;\n",
        &warn);
    assert(mask == 0x5);        // bit0=iChannel1, bit2=iChannel3
    assert(warn.empty());
    std::cout << "PASS test_iprev_no_sampler_warning\n";
}

// —— 迭代 shader 的典型整体形态：解析结果自洽 ——

static void test_iterate_shader_end_to_end_parse() {
    const char* src = R"GLSL(
// @iterations 12
uniform float uRate = 0.5;    // @range 0.0 1.0
uniform vec3  uColor;

vec4 iterateImage(vec2 fragCoord, float time) {
    vec4 prev = texture(iPrev, fragCoord);
    return mix(prev, vec4(uColor, 1.0), uRate);
}

vec4 mainImage(vec2 fragCoord, float time) {
    return texture(iPrev, fragCoord);
}
)GLSL";
    assert(glsl::hasIteratePass(src));
    assert(glsl::parseIterations(src) == 12);
    std::string warn;
    std::vector<glsl::Param> ps = glsl::parseUniforms(src, &warn);
    assert(ps.size() == 2);
    assert(ps[0].name == "uRate");
    assert(ps[0].hasRange);
    assert(ps[1].name == "uColor");
    warn.clear();
    assert(glsl::parseSamplerChannels(src, &warn) == 0);
    assert(warn.empty());
    std::cout << "PASS test_iterate_shader_end_to_end_parse\n";
}

// —— 结算模式：@solve / @history / parseIterConfig ——

static void test_solve_steps() {
    assert(glsl::parseSolveSteps("uniform float uX;") == 0);            // 未声明 → 0
    assert(glsl::parseSolveSteps("// @solve 16\n") == 16);
    assert(glsl::parseSolveSteps("// @solve 0\n") == 1);                // 下限钳制
    assert(glsl::parseSolveSteps("// @solve 999\n") == glsl::kMaxSolveSteps);
    assert(glsl::parseSolveSteps("// @solve 999999999999\n") == glsl::kMaxSolveSteps);
    assert(glsl::parseSolveSteps("// @solve abc\n") == 0);              // 非数字 → 未声明
    std::cout << "PASS test_solve_steps\n";
}

static void test_history_frames() {
    assert(glsl::parseHistoryFrames("uniform float uX;") == 0);
    assert(glsl::parseHistoryFrames("// @history 2\n") == 2);
    assert(glsl::parseHistoryFrames("// @history 99\n") == glsl::kMaxHistory);
    assert(glsl::parseHistoryFrames("// @history 0\n") == 0);
    std::cout << "PASS test_history_frames\n";
}

// @solveRes 边界：这条指令决定结算状态纹理的**分配尺寸**
//（网格面积 × 16B/像素进了逐帧缓存），钳制失效就是"一条注释申请几百 MB 显存"。
// @solve 与 @solveRes 都必须有边界断言：钳制失效即「一条注释申请几百 MB 显存」。
static void test_solve_res() {
    assert(glsl::parseSolveRes("uniform float uX;") == 0);                     // 未声明 → 0（调用方取默认）
    assert(glsl::parseSolveRes("// @solveRes 256\n") == 256);
    // 声明了 0 与"没声明"不同：走钳制下限（不是回默认值）
    assert(glsl::parseSolveRes("// @solveRes 0\n") == glsl::kSolveResMin);
    assert(glsl::parseSolveRes("// @solveRes 1\n") == glsl::kSolveResMin);
    assert(glsl::parseSolveRes("// @solveRes 63\n") == glsl::kSolveResMin);
    assert(glsl::parseSolveRes("// @solveRes 99999\n") == glsl::kSolveResMax);
    assert(glsl::parseSolveRes("// @solveRes 999999999999\n") == glsl::kSolveResMax);  // 位数防御
    assert(glsl::parseSolveRes("// @solveRes abc\n") == 0);                    // 非数字 → 未声明
    // 上下限本身在逐帧缓存预算下必须自洽：上限网格按最坏位深也得留得住几帧，
    // 否则默认档位就是"每帧淘汰上一帧 → 每帧从 0 重解"的 O(n²) 形态。
    const size_t maxFrame = host::solverFrameBytes(glsl::kSolveResMax, glsl::kSolveResMax,
                                                   host::PixelDepth::Bits32);
    assert(maxFrame * 4 <= host::kSolverCacheBudgetBytes);   // 上限档至少 4 帧
    const size_t defFrame = host::solverFrameBytes(glsl::kSolveResDefault, glsl::kSolveResDefault,
                                                   host::PixelDepth::Bits8);
    assert(defFrame * 100 <= host::kSolverCacheBudgetBytes); // 默认档至少 100 帧
    std::cout << "PASS test_solve_res\n";
}

static void test_iter_config_mode_selection() {
    // 无迭代趟 → None
    assert(glsl::parseIterConfig("vec4 mainImage(vec2 f,float t){return vec4(1.0);}").mode == glsl::IterMode::None);
    // 只有 iterateImage → Stateless + 默认趟数
    const char* iter = "vec4 iterateImage(vec2 f,float t){return vec4(1.0);}\n"
                       "vec4 mainImage(vec2 f,float t){return vec4(1.0);}";
    glsl::IterConfig c1 = glsl::parseIterConfig(iter);
    assert(c1.mode == glsl::IterMode::Stateless);
    assert(c1.stepsPerFrame == glsl::kDefaultIterations);
    // @iterations 显式 → Stateless + 该趟数
    glsl::IterConfig c2 = glsl::parseIterConfig(
        "// @iterations 24\nvec4 iterateImage(vec2 f,float t){return vec4(1.0);}");
    assert(c2.mode == glsl::IterMode::Stateless && c2.stepsPerFrame == 24);
    // @solve → Solver（跨帧持久）
    glsl::IterConfig c3 = glsl::parseIterConfig(
        "// @solve 12\nvec4 iterateImage(vec2 f,float t){return vec4(1.0);}");
    assert(c3.mode == glsl::IterMode::Solver && c3.stepsPerFrame == 12);
    // @solve 优先于 @iterations（改到一半的现场：新指令生效、旧指令静默失效）
    glsl::IterConfig c4 = glsl::parseIterConfig(
        "// @iterations 32\n// @solve 6\nvec4 iterateImage(vec2 f,float t){return vec4(1.0);}");
    assert(c4.mode == glsl::IterMode::Solver && c4.stepsPerFrame == 6);
    // @solve 写了但没定义 iterateImage → 仍进 Solver（让迭代趟编译失败进错误帧，
    // 比静默退回单趟更能说明问题在哪）
    glsl::IterConfig c5 = glsl::parseIterConfig(
        "// @solve 8\nvec4 mainImage(vec2 f,float t){return vec4(1.0);}");
    assert(c5.mode == glsl::IterMode::Solver);
    // @history 与模式正交
    glsl::IterConfig c6 = glsl::parseIterConfig(
        "// @history 3\n// @solve 8\nvec4 iterateImage(vec2 f,float t){return vec4(1.0);}");
    assert(c6.mode == glsl::IterMode::Solver && c6.historyFrames == 3);
    // —— @solveHz：每秒子步数，优先级高于 @solve ——
    // 两个正则互不越界的前提："@solveHz 400" 的 "@solve" 后是 'H' 不是空白。
    assert(glsl::parseSolveSteps("// @solveHz 400\n") == 0);
    assert(glsl::parseSolveHz("// @solveHz 400\n") == 400);
    assert(glsl::parseSolveHz("// @solveHz 0\n") == 1);                  // 下限钳制
    assert(glsl::parseSolveHz("// @solveHz 999999999999\n") == glsl::kMaxSolveHz);  // 位数防御
    assert(glsl::parseSolveHz("uniform float uX;") == 0);
    glsl::IterConfig c7 = glsl::parseIterConfig(
        "// @solveHz 400\nvec4 iterateImage(vec2 f,float t){return vec4(1.0);}");
    assert(c7.mode == glsl::IterMode::Solver && c7.solveHz == 400 && c7.stepsPerFrame == 0);
    // @solveHz 优先于 @solve（从每帧制切到每秒制忘删旧行：取新意图）
    glsl::IterConfig c8 = glsl::parseIterConfig(
        "// @solve 6\n// @solveHz 400\nvec4 iterateImage(vec2 f,float t){return vec4(1.0);}");
    assert(c8.mode == glsl::IterMode::Solver && c8.solveHz == 400 && c8.stepsPerFrame == 0);
    std::cout << "PASS test_iter_config_mode_selection\n";
}

// —— 结算/历史内置同样不得被当成用户 uniform，且声明须被剥离 ——

static void test_solver_builtins_filtered_and_stripped() {
    const char* src =
        "uniform sampler2D iHistory0;\n"
        "uniform sampler2D iHistory1;\n"
        "uniform float uStep;\n"
        "uniform float uFrame;\n"
        "uniform float uAmount;\n";
    std::string warn;
    std::vector<glsl::Param> ps = glsl::parseUniforms(src, &warn);
    assert(ps.size() == 1);
    assert(ps[0].name == "uAmount");

    std::string out = glsl::stripBuiltinUniformDecls(src);
    assert(out.find("uStep") == std::string::npos);
    assert(out.find("uFrame") == std::string::npos);
    assert(out.find("iHistory0") == std::string::npos);
    assert(out.find("uAmount") != std::string::npos);

    // iHistory0..3 是宿主绑定的内置采样器，不得产生"未绑定的采样器"告警
    warn.clear();
    assert(glsl::parseSamplerChannels("uniform sampler2D iHistory0;\n", &warn) == 0);
    assert(warn.empty());
    std::cout << "PASS test_solver_builtins_filtered_and_stripped\n";
}

// —— 结算 shader 的典型整体形态：解析结果自洽 ——

static void test_solver_shader_end_to_end_parse() {
    const char* src = R"GLSL(
// @solve 16
// @history 2
uniform float uGravity = 9.8;   // @range 0.0 30.0

vec4 iterateImage(vec2 fragCoord, float time) {
    if (uStep < 0.5) return vec4(0.0);
    vec4 s = texture(iPrev, fragCoord);
    vec4 h1 = texture(iHistory0, fragCoord);
    return s + h1 * 0.01;
}

vec4 mainImage(vec2 fragCoord, float time) {
    return texture(iPrev, fragCoord);
}
)GLSL";
    glsl::IterConfig c = glsl::parseIterConfig(src);
    assert(c.mode == glsl::IterMode::Solver);
    assert(c.stepsPerFrame == 16);
    assert(c.historyFrames == 2);
    std::string warn;
    std::vector<glsl::Param> ps = glsl::parseUniforms(src, &warn);
    assert(ps.size() == 1 && ps[0].name == "uGravity" && ps[0].hasRange);
    warn.clear();
    assert(glsl::parseSamplerChannels(src, &warn) == 0);
    assert(warn.empty());
    std::cout << "PASS test_solver_shader_end_to_end_parse\n";
}

// 输入图层是否被读取（据此跳过"AE 帧 → RGBA float 转换 + 上传"，
// 16bit 工程下实测这两段占整帧 38%）。
// 要害在 iPrev 的来路**按模式分**：结算模式的 iPrev 全程是状态纹理（播种读零状态），
// 其余模式的首趟/主趟读输入图层。真实反例：example_reaction_diffusion（@iterations）
// 全文 11 处 iPrev、0 处 iChannel0 —— 按"有迭代趟 ⇒ iPrev 不是输入"判会整帧变黑。
static void test_input_layer_needed() {
    // 结算（@solve / @solveHz）：iPrev = 状态纹理 → 不读输入，可跳过
    assert(glsl::inputLayerNeeded(
        "// @solve 32\nvec4 iterateImage(vec2 f,float t){return texture(iPrev,f);}") == false);
    assert(glsl::inputLayerNeeded(
        "// @solveHz 60\nvec4 mainImage(vec2 f,float t){return texture(iPrev,f);}") == false);
    // @iterations：首趟的 iPrev 就是输入图层 → 必须上传（反例回归）
    assert(glsl::inputLayerNeeded(
        "// @iterations 8\nvec4 iterateImage(vec2 f,float t){return texture(iPrev,f);}") == true);
    // 无迭代趟：主趟 iPrev = 输入图层
    assert(glsl::inputLayerNeeded(
        "vec4 mainImage(vec2 f,float t){return texture(iPrev,f);}") == true);
    // 直接采样 iChannel0（输入历史示例那种）
    assert(glsl::inputLayerNeeded(
        "vec4 mainImage(vec2 f,float t){return texture(iChannel0,f);}") == true);
    // 结算 + iChannel0：仍要输入（结算器叠在源画面上）
    assert(glsl::inputLayerNeeded(
        "// @solve 8\nvec4 mainImage(vec2 f,float t){return texture(iChannel0,f)+texture(iPrev,f);}") == true);
    // 纯生成：两段都可省
    assert(glsl::inputLayerNeeded(
        "vec4 mainImage(vec2 f,float t){return vec4(f,0.5,1.0);}") == false);
    // 保守方向：注释里提到 iChannel0 也算"需要"（宁可多传一次）
    assert(glsl::inputLayerNeeded(
        "// 这里说明 iChannel0 的用法\nvec4 mainImage(vec2 f,float t){return vec4(1.0);}") == true);
    std::cout << "PASS test_input_layer_needed\n";
}

void runIterationTests() {
    test_iterate_pass_absent();
    test_iterate_pass_present();
    test_iterate_pass_ignores_comments();
    test_iterations_default();
    test_iterations_explicit();
    test_iterations_clamped();
    test_iterate_builtins_not_user_uniforms();
    test_iterate_builtins_stripped();
    test_iprev_no_sampler_warning();
    test_iterate_shader_end_to_end_parse();
    test_solve_steps();
    test_solve_res();
    test_history_frames();
    test_iter_config_mode_selection();
    test_input_layer_needed();
    test_solver_builtins_filtered_and_stripped();
    test_solver_shader_end_to_end_parse();
}
