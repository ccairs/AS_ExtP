#pragma once
// uniformParser.h —— 纯 C++，与 AE SDK 无关
#include <string>
#include <vector>
#include <cstdint>
namespace glsl {
enum class ParamType { Float, Vec2, Vec3, Vec4 };
struct Param {
    std::string name;
    ParamType type;
    // 默认值：float 取 def[0]；vec2 取 def[0..1]；vec3 取 def[0..2]；vec4 取 def[0..3]。
    // 无初始化器时 hasDef=false，def 全为 0。vec4 作颜色时按 RGBA 顺序。
    float def[4] = {0.0f, 0.0f, 0.0f, 0.0f};
    bool hasDef = false;     // 是否有初始化器（GLSL `= 值` 声明）
    // 自定义范围：uniform 声明行尾注释 `// @range min max`（LLM 可写），
    // 覆盖宿主的默认 [min(0,dv), max(1,dv)] 滑条范围。vec2/3/4 时作用于全部分量。
    // 未声明时 hasRange=false，fallback 默认范围。
    float rmin = 0.0f;
    float rmax = 1.0f;
    bool hasRange = false;
    bool operator==(const Param& o) const {
        if (name != o.name || type != o.type || hasDef != o.hasDef) return false;
        if (hasRange != o.hasRange) return false;
        if (hasRange && (rmin != o.rmin || rmax != o.rmax)) return false;
        for (int i = 0; i < 4; ++i) if (def[i] != o.def[i]) return false;
        return true;
    }
};
// 解析 GLSL 源码中的 uniform 声明（float/vec2/vec3/vec4），忽略内置与不支持类型
// 返回参数列表，按声明顺序；最多 kMaxParams 个。
// 数组声明（`name[N]`）：float 数组按元素展开为 N 个 Float 槽位（w[0..N-1]），
// vec 数组/维度无法解析的数组跳过并（传入 warnings 时）追加告警行——
// 截掉 [N] 按标量注册时，glUniform 只设置首元素，其余元素静默保持 0。
constexpr int kMaxParams = 32;
std::vector<Param> parseUniforms(const std::string& src, std::string* warnings = nullptr);
// 映射图层（iChannel1/2/3）声明检测：逐行扫 `uniform sampler2D <name>;`，
// 返回 bitmask：bit0=iChannel1、bit1=iChannel2、bit2=iChannel3。
// iChannel0 为内置（本图层输入，忽略不告警）；其他名字的 sampler2D →
// warnings 追加告警行（帮助 LLM 发现命名错误，仅 iChannel1/2/3 提供图层纹理）。
// 独立函数而非扩展 parseUniforms 签名：不动现有调用方与测试；
// kMaxParams=32 与 channels 无关（sampler 不占数值槽位）。
uint8_t parseSamplerChannels(const std::string& src, std::string* warnings = nullptr);
// 剥离 uniform 初始化器：GLSL 规范不允许 uniform 带 `= 值`（"cannot initialize this
// type of qualifier"），编译（330 core）前必须剥离；默认值已由 parseUniforms 提取。
// 与 JS uniformParser.js stripUniformInitializers 同源（白名单 float/vec2/vec3/vec4）。
// 注释门控——注释内的 `uniform … =` 伪声明不再参与剥离（若不作门控，本模块
// 的头匹配与改写扫描器会把注释闭合符之后的第一处深度 0 ';'/',' 当终结符，
// 吞掉后续真实声明）。
std::string stripUniformInitializers(const std::string& src);
// 剥离用户源码中的内置 uniform 声明（iChannel0..3/uTime/uResolution/
// uAspect）——renderer 拼接片元着色器前已预声明这些内置 uniform，GLSL 同
// 作用域同名重复声明是编译错误（NVIDIA 宽容掩盖，AMD/Intel/严格驱动直接
// 失败——迁移自 Shadertoy 的 shader 常自带这些声明）。整条声明全为内置则
// 移除；逗号链混排仅剔除内置 declarator、保留其余；注释内伪声明跳过。
std::string stripBuiltinUniformDecls(const std::string& src);
// 剥离精度限定符——**宿主编译端专用**（面板侧 WebGL
// 是 GLSL ES，精度限定符合法且有意义，必须保留；本函数不参与任何解析/重建
// 文本，parseUniforms 与两个剥离器的"精度原样保留"口径不变）。
// 为什么：宿主以 `#version 330 core` 编译，桌面 GLSL 无精度语义（precision 是
// ES 概念，桌面 4.10 起才被规范接受且同样无效果）——330 core 严格按规范无此
// 语法，AMD/Intel 严格驱动直接编译失败，NVIDIA 宽容掩盖（观察级条目：驱动
// 接受度未真机验证）。剥离后语义中性（桌面无精度语义）、行数不变（#line 1 的
// 用户行号映射不受影响）。剥离两处：
//   ① `precision <q> <type>;` 语句整条（ES 专有，桌面 330 非法）；
//   ② 其余位置的限定符关键字（uniform/局部变量/形参声明前的 highp/mediump/lowp）。
// 注释门控同其他剥离器（commentMaskOf）：注释内的字面量原样保留。
std::string stripPrecisionQualifiers(const std::string& src);
// —— 迭代趟：帧内多趟 ping-pong 迭代 ——
// 效果文件可选定义 `vec4 iterateImage(vec2 fragCoord, float time)`：宿主每帧把它
// 连续跑 N 趟，每趟写一张离屏纹理、读上一趟的结果（iPrev）；第 0 趟的 iPrev =
// 输入图层。末趟结果交给 mainImage（存在时，作为 mainImage 的 iPrev），否则
// 直接作为该帧输出。
// 与"帧间反馈"的区别：**全部趟数都在同一帧内完成**，效果仍是 time 的纯函数——
// AE 的乱序渲染/跳帧/渲染队列区间/预览降采样都不会让它失真。
// 趟数由文件头注释 `// @iterations N` 声明，缺省 kDefaultIterations；钳制到
// [1, kMaxIterations]（趟数是每帧全屏 draw 次数，上限防呆）。
constexpr int kDefaultIterations = 8;
constexpr int kMaxIterations = 64;
// 是否定义了迭代趟入口（注释内的伪定义不算；只认带返回类型前缀的定义形态，
// 与面板 glslValidator 的 noise 族撞名预检同款口径）。
bool hasIteratePass(const std::string& src);
// 输入图层是否可能被读取（引用 iChannel0，或**非结算模式**下的 iPrev —— 结算模式的
// iPrev 全程是状态纹理，与输入无关）。渲染侧据此跳过"AE 帧 → RGBA float + 上传"
//（16bit 工程下实测占整帧 38%）。保守口径：源码串里出现即算"需要"。
bool inputLayerNeeded(const std::string& src);
// 解析 `// @iterations N`。未声明 → defaultValue；非法值/越界 → 钳制到
// [1, kMaxIterations]。仅识别十进制整数（不支持表达式，保持可预测）。
int parseIterations(const std::string& src, int defaultValue = kDefaultIterations);

// —— 结算模式：跨帧携带状态的求解器 ——
// `// @solve N` 把 iterateImage 的语义从「帧内多趟」改成「**每帧 N 个子步、
// 状态跨帧持久**」：第 0 步从初值播种，其后每一步读上一帧/上一子步的结果，
// 逐帧推进——即 Houdini Solver SOP 那种结算器。
//
// 两种模式的差别只在"状态活多久"与"从哪读 iPrev"：
//   Stateless（@iterations）：每帧重置，第 0 趟读输入图层；结果 = time 的纯函数。
//   Solver   （@solve）：按实例持久、逐帧缓存；第 0 **步**（整个结算的第一次）
//                            读输入图层，其余步读上一子步结果。
// 两个模式共用同一入口 iterateImage 与同一份 shader 正文——因为 uStep 在两种
// 模式下都表示"绝对步号"（Stateless 下 = 本帧内第几趟，每帧归零；Solver 下 =
// 自结算开始累计），故 `if (uStep < 0.5) 播种 else 步进` 在两种模式下都写对。
//
// 与 Stateless 的取舍：
//   · Solver 的状态按实例持久并**逐帧缓存**——顺序播放每帧只走 N 个子步（O(1)）；
//     回拖落在已缓存的帧上直接读缓存；向前跳到未算过的帧从最后一个已缓存帧顺序
//     推进；只有缓存被内存上限淘汰掉的早期帧才需要从 0 重解。
//   · Stateless 无状态，故对渲染顺序完全免疫，适合"在这一帧解到收敛"。
enum class IterMode {
    None = 0,       // 无迭代趟：单趟 mainImage
    Stateless = 1,  // @iterations N
    Solver = 2,     // @solve N
};
struct IterConfig {
    IterMode mode = IterMode::None;
    int stepsPerFrame = 0;   // 每帧子步数（Stateless = 趟数；Solver@solve = 子步数；solveHz 下无效）
    int historyFrames = 0;   // I2a：输入历史检出帧数（0 = 不检出）
    int simDim = 0;          // Solver：仿真网格长边像素（0 = 用默认值）
    int solveHz = 0;         // Solver：@solveHz——每秒子步数（>0 时覆盖 stepsPerFrame 的语义；
                             // 每帧实际子步数由渲染侧按合成帧率推导，见 renderer.cpp Solver 分支）
};
constexpr int kMaxSolveSteps = 64;    // 每帧子步数上限（与 kMaxIterations 同口径）
constexpr int kDefaultSolveSteps = 8;
// @solveHz 上限：高帧率合成才吃得满（每帧还有 kMaxSolveSteps=64 的硬顶——25fps 合成
// 实际封在 64×25=1600Hz，触顶即解算慢于声明值，属声明的显式钳制而非静默错误）。
constexpr int kMaxSolveHz = 4096;
// 仿真网格长边：结算器的状态纹理尺寸。与渲染分辨率**解耦**是必需的——AE 预览
// 降采样会让渲染尺寸变化，若仿真网格跟着变，结算状态每切一次预览档位就得重来。
// 上限与默认值同时受内存约束：逐帧缓存的字节数 = 网格面积 × 16B（RGBA16F），
// 512² 是 2MB/帧（250 帧的镜头 ≈ 500MB，够用）；2048² 是 32MB/帧（缓存只能存 16 帧）。
constexpr int kSolveResDefault = 512;
constexpr int kSolveResMin = 64;
constexpr int kSolveResMax = 2048;
// 解析 `// @solveRes N`：未声明 → 0（调用方用默认值）；声明了则钳制到 [min, max]。
int parseSolveRes(const std::string& src);
// I2a 输入历史检出（`// @history N`）：宿主按偏移时刻检出输入（效果输入，含前序
// 效果），iHistory0 = 当前帧前 1 帧、iHistory1 = 前 2 帧……供拖尾/残影/时间回馈。
// 上限受纹理单元与检出开销双重约束（每帧每历史各一次 PF_CHECKOUT_PARAM）。
constexpr int kMaxHistory = 4;
// 解析 `// @solve N`：未声明返回 0（表示非结算模式）；声明了则钳制到
// [1, kMaxSolveSteps]。
int parseSolveSteps(const std::string& src);
// 解析 `// @solveHz N`：每秒子步数（真实时间驱动——任何合成帧率下解算速度恒为
// N 步/秒）。未声明返回 0；声明了则钳制到 [1, kMaxSolveHz]。
// 与 parseSolveSteps 的正则同构注意：`@solve\s+` 后必须紧跟空白才匹配，
// "@solveHz 400" 不会被 @solve 的正则误吞（@solve 后是 'H' 非空白）。
int parseSolveHz(const std::string& src);
// 解析 `// @history N`：未声明返回 0；钳制到 [0, kMaxHistory]。
int parseHistoryFrames(const std::string& src);
// 一次性解析三件套（模式判定 + 每帧步数 + 历史帧数）。优先级：
// @solveHz > @solve > @iterations > （有 iterateImage 时的默认趟数）。
// @solveHz 与 @solve 同时出现取 @solveHz（真实时间口径是更强的意图声明，从
// 每帧制切到每秒制忘删旧行时，取新模式更符合"改到一半"的场景）。
IterConfig parseIterConfig(const std::string& src);

// uniform 名是否颜色语义（含完整词 "color"/"colour"，词法边界校验）——
// customUI 据此决定 vec2/vec3 渲染为取色器（Swatch）还是分量滑条（Point）。
// 按 4 字符前缀 "colo"/"coul" 任意位置匹配时，
// coulomb 等物理量命名被误判颜色语义丢分量编辑；迁入本模块（纯 C++ 可测）
// 并改为完整词 + 词法边界匹配：串首/尾、'_'（snake_case 分隔符）与驼峰边界
//（uColor/colorTint 的 case 过渡）均视为词边界，既有命名形态保持命中。
bool isColorNamed(const std::string& n);
// 角度语义判定：匹配词干 "angle"/"deg"/"rot" 于词首边界，允许后缀
// 派生（rotation / rotSpeed / degrees / degToRad 均命中）。用途：槽位滑条量程与
// 精度——角度类给 -360..360，而非通用标量的 -10..10（见 params.h slotSliderRange）。
// 与 isColorNamed 的"整词"口径不同：颜色必须整词，否则 coulomb 类命名被误判。
bool isAngleNamed(const std::string& n);
} // namespace glsl
