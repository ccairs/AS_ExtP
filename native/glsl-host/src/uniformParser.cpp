#include "uniformParser.h"
#include "i18n.h"
#include <cstdarg>
#include <cstdio>
#include <sstream>
#include <unordered_map>
#include <regex>
#include <cstdlib>
#include <array>
#include <cctype>
#include <cstring>
#include <vector>

namespace glsl {
namespace {
// 告警文本组装：fmt 是 Tr 取出的 UTF-8 模板（占位符序列由生成器按 manifest 校验），
// 动态片段（类型名/声明名/名字清单）作为实参代入，长度不受固定缓冲区限制。
std::string trFormat(const char* fmt, ...) {
    std::vector<char> buf(256);
    for (;;) {
        va_list ap;
        va_start(ap, fmt);
        const int n = std::vsnprintf(buf.data(), buf.size(), fmt, ap);
        va_end(ap);
        if (n < 0) return std::string();
        if (static_cast<size_t>(n) < buf.size()) {
            return std::string(buf.data(), static_cast<size_t>(n));
        }
        buf.resize(static_cast<size_t>(n) + 1);
    }
}
ParamType typeFromToken(const std::string& t) {
    if (t == "vec2") return ParamType::Vec2;
    if (t == "vec3") return ParamType::Vec3;
    if (t == "vec4") return ParamType::Vec4;
    return ParamType::Float;
}
bool supported(const std::string& t) {
    return t == "float" || t == "vec2" || t == "vec3" || t == "vec4";
}
// 剥离 // 与 /* */ 注释（与 JS 端 uniformParser.js 对齐，避免注释里的 uniform 被误解析）
std::string stripComments(const std::string& src) {
    std::string out;
    out.reserve(src.size());
    bool inLine = false, inBlock = false;
    for (size_t i = 0; i < src.size(); ++i) {
        if (inLine) {
            if (src[i] == '\n') { inLine = false; out += '\n'; }
            continue;
        }
        if (inBlock) {
            if (src[i] == '*' && i + 1 < src.size() && src[i + 1] == '/') { inBlock = false; ++i; out += ' '; }
            continue;
        }
        if (src[i] == '/' && i + 1 < src.size() && src[i + 1] == '/') { inLine = true; ++i; out += ' '; continue; }
        if (src[i] == '/' && i + 1 < src.size() && src[i + 1] == '*') { inBlock = true; ++i; out += ' '; continue; }
        out += src[i];
    }
    return out;
}

// 共用：注释区间掩码——inCmt[i] 为真表示 src[i] 处于
// 行/块注释内（状态机与 stripComments 同一套）。用于「改写源码」类工具
//（stripUniformInitializers / stripBuiltinUniformDecls）的注释门控：头匹配
// 起点落在注释内的一律视为伪声明跳过；改写扫描器对注释区间不解释其中的
// ';'/','/括号（对齐 @range 的注释门控修法）。行注释的换行符不算
// 注释（对齐 stripComments：行注释不吞换行）。
std::vector<bool> commentMaskOf(const std::string& src) {
    std::vector<bool> inCmt(src.size(), false);
    bool inLine = false, inBlock = false;
    for (size_t i = 0; i < src.size(); ++i) {
        if (inLine) {
            if (src[i] == '\n') inLine = false;
            else inCmt[i] = true;
            continue;
        }
        if (inBlock) {
            inCmt[i] = true;
            if (src[i] == '*' && i + 1 < src.size() && src[i + 1] == '/') {
                inCmt[i + 1] = true;
                inBlock = false;
                ++i;
            }
            continue;
        }
        if (src[i] == '/' && i + 1 < src.size() && src[i + 1] == '/') {
            inCmt[i] = true;
            inCmt[i + 1] = true;
            inLine = true;
            ++i;
            continue;
        }
        if (src[i] == '/' && i + 1 < src.size() && src[i + 1] == '*') {
            inCmt[i] = true;
            inCmt[i + 1] = true;
            inBlock = true;
            ++i;
            continue;
        }
    }
    return inCmt;
}

// 初始化器表达式的「本 declarator 段」——逗号链（`uniform float a = 1.0, b;`，
// GLSL ES 1.00 与桌面 GLSL 语法都合法的多 declarator 声明）里初始化器在**顶层逗号**
// 处结束。declRe 的 `([^;]+)` 捕获会把后续 declarator（b）一起吞进表达式 →
// parseInitValues 判失败 → a 的默认值静默读不到（面板/宿主滑条回退 1.0，而剥离器
// 与编译端都按"a 有初始化器"处理——声明在、值错、无告警）。深度感知与
// stripUniformInitializers 的扫描同款：vec3(0.1, 0.2, 0.3)/f(x, y) 括号内的逗号
// 不是 declarator 分隔符。无顶层逗号时原样返回（单 declarator 行为不变）。
std::string initializerBeforeTopLevelComma(const std::string& expr) {
    int depth = 0;
    for (size_t i = 0; i < expr.size(); ++i) {
        const char c = expr[i];
        if (c == '(' || c == '[' || c == '{') ++depth;
        else if (c == ')' || c == ']' || c == '}') { if (depth > 0) --depth; }
        else if (c == ',' && depth == 0) return expr.substr(0, i);
    }
    return expr;
}

// 解析初始化器表达式 → 4 分量默认值。返回是否成功解析。
// - float 数值：def[0]=值
// - vec2(r,g) / vec3(r,g,b) / vec4(r,g,b,a)：按位置填入 def[0..n-1]，未填的保持 0
// - 其他表达式（PI 等）→ false
bool parseInitValues(const std::string& expr, std::array<float, 4>& def) {
    def = {0.0f, 0.0f, 0.0f, 0.0f};
    std::string s = expr;
    // 去首尾空白
    size_t b = s.find_first_not_of(" \t");
    size_t e = s.find_last_not_of(" \t");
    if (b == std::string::npos) return false;
    s = s.substr(b, e - b + 1);
    // 纯数值 → float
    if (std::regex_match(s, std::regex(R"([-+0-9.eE]+)"))) {
        def[0] = (float)std::atof(s.c_str());
        return true;
    }
    // vec2/vec3/vec4(r,g,b[,a])
    std::smatch m;
    if (std::regex_match(s, m, std::regex(R"(vec([234])\(([^)]+)\))")) ) {
        int n = std::atoi(m[1].str().c_str());
        std::string args = m[2].str();
        std::stringstream ss(args);
        std::string tok;
        int i = 0;
        while (std::getline(ss, tok, ',') && i < n) {
            // 去空白
            size_t tb = tok.find_first_not_of(" \t");
            size_t te = tok.find_last_not_of(" \t");
            if (tb == std::string::npos) break;
            std::string num = tok.substr(tb, te - tb + 1);
            if (!std::regex_match(num, std::regex(R"([-+0-9.eE]+)"))) return false;
            def[i] = (float)std::atof(num.c_str());
            ++i;
        }
        return i == n;
    }
    return false;
}
}

// 终结符归一化：把 `;` 与 `,` 两侧补上空格，**仅用于分词**。
// 粘连写法（`uniform float uA;uniform float uB;`）会让 `uniform` 与上一条的 `;` 落进同一个
// token，下一条声明整条被静默丢弃——宿主侧表现为 AE 效果控件少一个滑条、值恒为 GL 默认 0、
// error.log 一个字都没有；面板侧同款（滑块消失）。正则扫描（@range/默认值）一律用未归一化的
// 原文，故补空格无副作用；`parseUniforms` 与 `parseSamplerChannels` 共用本函数（单一实现，
// 防两侧漂移—— 只修了后者，复核抓到这个姊妹函数漏网）。
static std::string normalizeTerminators(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (size_t i = 0; i < s.size(); ++i) {
        const char c = s[i];
        if (c == ';' || c == ',') {
            out += ' ';
            out += c;
            out += ' ';
        } else {
            out += c;
        }
    }
    return out;
}

std::vector<Param> parseUniforms(const std::string& src, std::string* warnings) {
    std::vector<Param> out;
    // 剥 UTF-8 BOM：JS 端 \s 含 \uFEFF 会把 BOM 当空白切分，C++ istringstream 不剥，
    // 不处理会导致带 BOM 文件的首个 uniform 在宿主端漏解析、与面板槽位错位
    std::string s = src;
    if (s.size() >= 3 && (unsigned char)s[0] == 0xEF && (unsigned char)s[1] == 0xBB && (unsigned char)s[2] == 0xBF) {
        s = s.substr(3);
    }
    const std::string clean = stripComments(s);

    // 自定义范围映射：uniform 声明行尾注释 `// @range min max`（LLM 可写），
    // 覆盖默认滑条范围。@range 本身位于注释中（stripComments 会剥掉），故须在
    // 原始源码上提取。
    // 整段 regex_search 时，行内/块内注释中的示例声明（如
    // `// uniform float speed; // @range 0 10`）同样命中——注释掉的假声明污染
    // 同名真实 uniform 的滑条范围。改为按行扫描 + 注释门控：块注释状态跨行
    // 携带（与 stripComments 同一套状态机），本行剥注释后仍含 uniform 声明
    // （声明未被注释掉）才在原始行上提取 @range——与下方 defaultMap 在剥注释
    // 后的 clean 上匹配的口径一致：注释内的声明一律无效。
    // 格式：uniform 声明（可带初始化器）; 行尾注释 // @range min max
    // 类型前补可选精度限定符（与剥离器/解析侧同口径）。`uniform highp
    // float uX; // @range 0 1` 也须命中；否则滑条退回 fallback 范围而声明正常注册，
    // 两侧不一致静默。
    std::unordered_map<std::string, std::pair<float, float>> rangeMap;
    {
        std::regex rangeRe(R"(uniform\s+(?:(?:highp|mediump|lowp)\s+)?(float|vec2|vec3|vec4)\s+([A-Za-z_]\w*)[^;\n]*;[^\n]*//[^\n]*@range\s+([-+0-9.eE]+)\s+([-+0-9.eE]+))");
        std::smatch m;
        std::istringstream lines(s);
        std::string line;
        bool inBlock = false;
        while (std::getline(lines, line)) {
            // 剥本行注释：行注释截断到行尾；块注释跨行携带状态
            std::string stripped;
            stripped.reserve(line.size());
            for (size_t li = 0; li < line.size(); ++li) {
                if (inBlock) {
                    if (line[li] == '*' && li + 1 < line.size() && line[li + 1] == '/') {
                        inBlock = false;
                        ++li;
                        stripped += ' ';
                    }
                    continue;
                }
                if (line[li] == '/' && li + 1 < line.size() && line[li + 1] == '/') break;
                if (line[li] == '/' && li + 1 < line.size() && line[li + 1] == '*') {
                    inBlock = true;
                    ++li;
                    stripped += ' ';
                    continue;
                }
                stripped += line[li];
            }
            // 声明被整行注释掉（含块注释内）→ 剥注释后无 uniform，跳过本行
            if (stripped.find("uniform") == std::string::npos) continue;
            std::string::const_iterator lit = line.cbegin();
            while (std::regex_search(lit, line.cend(), m, rangeRe)) {
                rangeMap[m[2].str()] = { (float)std::atof(m[3].str().c_str()),
                                         (float)std::atof(m[4].str().c_str()) };
                lit = m[0].second;
            }
        }
    }

    // 行级默认值映射（与 JS 端 uniformParser.js defaultMap 对齐）：
    // uniform <type> <name> = <init>; → name → 完整 4 分量默认值
    // 与 rangeRe 同步补可选精度限定符——`uniform highp float uX = 0.5;`
    // 剥离后声明正常（剥离器支持该写法），但默认值正则不命中 → hasDef=false，
    // 面板/宿主滑条退回 1.0 而非声明的 0.5（声明在、值错，无任何告警）。
    // 捕获到的初始化器先截到顶层逗号（`a = 1.0, b;` → `1.0`）——见
    // initializerBeforeTopLevelComma 注释。
    std::unordered_map<std::string, std::array<float, 4>> defaultMap;
    {
        std::regex declRe(R"(uniform\s+(?:(?:highp|mediump|lowp)\s+)?(float|vec2|vec3|vec4)\s+([A-Za-z_]\w*)\s*=\s*([^;]+);)");
        std::smatch m;
        std::string::const_iterator it = clean.begin();
        while (std::regex_search(it, clean.end(), m, declRe)) {
            std::array<float, 4> dv;
            if (parseInitValues(initializerBeforeTopLevelComma(m[3].str()), dv)) {
                defaultMap[m[2].str()] = dv;
            }
            it = m[0].second;
        }
    }
    std::istringstream in(normalizeTerminators(clean));
    std::string tok;
    // 内层 declarator 链 peek 回填的 token：外层直接处理、不再读流
    //（istringstream 无法按 token 回退，用标志位代替 unread）
    bool haveTok = false;
    // 槽位满截断只告警一次（首个被丢弃的 declarator 点名，其后的
    // uniform 由外层循环扫过不注册、由该条告警文案覆盖——逐个重复告警只会
    // 淹没 error.log）
    bool capWarned = false;
    while (haveTok || (in >> tok)) {
        haveTok = false;
        if (tok != "uniform") continue;
        std::string type;
        if (!(in >> type)) break;
        // 精度限定符（highp/mediump/lowp）不是类型——再读一个 token 当类型。
        // 采样器路径同款剥离（parseSamplerChannels）；若不剥，数值路径 type="highp"
        // 被 supported() 判否 → 整条声明静默跳过：ECW 少一个滑条、值恒 GL 默认 0、
        // error.log 无任何记录（从 Shadertoy 搬来的 `uniform highp float uX;` 常踩）。
        if (type == "highp" || type == "mediump" || type == "lowp") {
            if (!(in >> type)) break;
        }
        if (!supported(type)) continue;
        // —— 逗号分隔多声明（`uniform float a, b;`）：逐 declarator 处理 ——
        // 若只取首个名字 token，名字会带逗号（注册出 "a," 坏名，
        // glGetUniformLocation 恒 -1 → 槽位显示但值永不生效），后续名字被
        // 词流当独立 token 丢弃（host 不注册该槽位 → 静默保持 GL 默认 0）。
        std::string decl;
        if (!(in >> decl)) break;
        while (true) {
            // 畸形输入防御：逗号链的下一个 declarator 是 "uniform"（漏分号的
            // `uniform float a, uniform float b;`）→ 视为新语句开始，交还外层
            // 扫描。不防御会注册名为 "uniform" 的伪参数且丢失 b（只取首个名字 token 则为
            // "a," 坏名 + b，b 不丢；本守卫恢复该行为且首名干净）。
            if (decl == "uniform") { tok = decl; haveTok = true; break; }
            // 解析单个 declarator：裸名 + 可选数组维度 + 终结符（; , =）
            // 数组维度：`name[N]`（N 为十进制字面量）。float 数组按元素展开为 N 个
            // Float 槽位（w[0..N-1]，renderer 对 "w[i]" 逐元素 glGetUniformLocation/
            // glUniform1f，GL 规范保证数组元素名可直接查询）；vec 数组与维度无法
            // 解析的数组拒绝并记 warnings——截掉 [N] 按标量注册会让
            // glGetUniformLocation 只得首元素位置，其余元素静默保持 GL 默认 0。
            std::string bare = decl, rest;
            int arrayDim = 0;
            bool multiDim = false;    // 多维数组（见数组分支的拒绝政策）
            bool chainPeeked = false; // 数组维度预读已消费链上下一 token（下方不得再 peek）
            const size_t lb = decl.find('[');
            if (lb != std::string::npos) {
                std::string dim;
                const size_t rb = decl.find(']', lb + 1);
                if (rb != std::string::npos) {
                    dim = decl.substr(lb + 1, rb - lb - 1);
                    rest = decl.substr(rb + 1);
                }
                bare = decl.substr(0, lb);
                bool dimOk = !dim.empty();
                for (char dc : dim)
                    if (!std::isdigit((unsigned char)dc)) { dimOk = false; break; }
                arrayDim = dimOk ? std::atoi(dim.c_str()) : -1;
                // 多维数组（`float w[2][3];`）——只展开第一维会注册出
                // w[0]/w[1] 这种 GL 里根本不存在的名字（glGetUniformLocation 恒 -1
                // 的死滑条，拖了不生效）；与 vec 数组同政策：整条拒绝并告警。
                // 形态一：同一 token 内后续维度（rest 以 '[' 开头，`w[2][3]`）。
                {
                    const size_t rp = rest.find_first_not_of(" \t");
                    if (rp != std::string::npos && rest[rp] == '[') multiDim = true;
                }
                // 形态二：维度之间夹空白（`w[2] [3]`，GLSL 合法）→ 第二维是独立
                // token，读进来判多维；末次读到的分隔符（','/';'/'='）回填 rest
                // 交下方链推进统一处理（'='/'uniform' 等仍走既有分支）。
                // 不预读判别会先把 w[0]/w[1] 注册出去、再解析 "[3]" 时发现多维，
                // 拒绝已来不及（部分展开的坏名字已进槽位表）。
                if (!multiDim && rest.empty() && arrayDim > 0) {
                    std::string nt;
                    while (in >> nt) {
                        if (!nt.empty() && nt[0] == '[') { multiDim = true; continue; }
                        if (!nt.empty() && (nt[0] == ';' || nt[0] == ',' || nt[0] == '=')) {
                            rest = nt;
                        } else {
                            tok = nt;   // 非分隔符（含畸形漏分号的下一条 uniform）交还外层
                            haveTok = true;
                        }
                        chainPeeked = true;
                        break;
                    }
                }
            } else {
                const size_t term = decl.find_first_of(";,=");
                if (term != std::string::npos) {
                    bare = decl.substr(0, term);
                    rest = decl.substr(term);
                }
            }
            // 内置 uniform（宿主注入）跳过。L2 相机五内置必须在此过滤：
            // 声明 `uniform float uHasCam;`（vec3 uCamPos 同理）若被注册成
            // 用户槽位，渲染期 userSlots 上传与内置上传查到同一 location，
            // 滑块值会覆盖真实相机值（幽灵参数）。mat4 两内置因类型不支持
            // 恰好安全，仍按名单统一过滤（与 stripBuiltinUniformDecls 同源）。
            // L3 灯光七内置同理必须过滤，且其中三类后果不同：
            //   uHasLights / uLightCount（float）—— 漏过滤即变幽灵滑块，覆盖真实灯数
            //   uLightType[8]（float 数组）—— 漏过滤会被**展开成 8 个用户槽位**
            //   uLightPos/Dir/Color[8]、uLightParams[8]（vec 数组）—— 本会被拒并记
            //     warnings，一并过滤可免去误导性告警
            if (!bare.empty() && bare != "uTime" && bare != "uResolution" &&
                bare != "uAspect" && bare != "uLayerSize" && bare != "uHasCam" && bare != "uCamFov" &&
                bare != "uCamPos" &&
                bare != "uCamMatrix" && bare != "uWorldMatrix" &&
                bare != "uHasLights" && bare != "uLightCount" && bare != "uLightType" &&
                bare != "uLightPos" && bare != "uLightDir" && bare != "uLightColor" &&
                bare != "uLightParams" &&
                // 迭代/结算内置：与上列同款——漏过滤即变幽灵滑块，
                // 用户拖它就会覆盖宿主每帧写入的真实趟号/步号/帧号
                bare != "uIter" && bare != "uIterCount" &&
                bare != "uStep" && bare != "uFrame" && bare != "uDt") {
                if (arrayDim != 0 || multiDim) {
                    // 数组：float 按元素展开；vec 数组、多维数组与维度未知的数组
                    // 拒绝（记 warnings）。展开元素不适用 defaultMap/rangeMap
                    //（二者按裸名键控），元素默认 1.0（与无初始化器的 float 同规则，
                    // 见 params.h ecwDefault4）；上限 kMaxParams
                    // 与标量路径同口径。
                    if (multiDim) {
                        // 多维不截取第一维展开（展开出的 w[0] 在 GL 里
                        // 不存在，location 恒 -1 → 用户拖一条永不生效的死滑条且
                        // 无任何告警）。整条拒绝是唯一不会误导的政策。
                        if (warnings)
                            *warnings += trFormat(
                                Tr(S_EFFECTHOST_UNIFORMPARSER_WARN_ARRAY_MULTIDIM),
                                type.c_str(), bare.c_str());
                    } else if (arrayDim < 0 || type != "float") {
                        if (warnings)
                            *warnings += trFormat(
                                Tr(S_EFFECTHOST_UNIFORMPARSER_WARN_ARRAY_UNSUPPORTED),
                                type.c_str(), bare.c_str());
                    } else {
                        for (int e = 0; e < arrayDim; ++e) {
                            if ((int)out.size() >= kMaxParams) {
                                // 数组元素截断必告警（对齐上方数组拒绝
                                // 路径）——静默截断时 renderer 不再 glUniform 这些
                                // 元素、ECW 无槽位，error.log/parseWarning 双空白，
                                // 渲染错误无从诊断
                                if (warnings)
                                    *warnings += "[uniform limit reached] " + type + " " + bare +
                                                 "[" + std::to_string(e) + ".." +
                                                 std::to_string(arrayDim - 1) + "]: only " +
                                                 std::to_string(kMaxParams) +
                                                 " uniform slots are supported, the remaining "
                                                 "array elements are dropped and keep GL default 0\n";
                                break;
                            }
                            Param p;
                            p.name = bare + "[" + std::to_string(e) + "]";
                            p.type = ParamType::Float;
                            out.push_back(std::move(p));
                        }
                    }
                } else if ((int)out.size() < kMaxParams) {
                    Param p;
                    p.name = bare;
                    p.type = typeFromToken(type);
                    auto dit = defaultMap.find(bare);
                    if (dit != defaultMap.end()) {
                        for (int i = 0; i < 4; ++i) p.def[i] = dit->second[i];
                        p.hasDef = true;
                    }
                    auto rit = rangeMap.find(bare);
                    if (rit != rangeMap.end()) {
                        p.rmin = rit->second.first;
                        p.rmax = rit->second.second;
                        if (p.rmax < p.rmin) std::swap(p.rmin, p.rmax);  // 容错：min>max 时交换
                        if (p.rmin == p.rmax) p.rmax = p.rmin + 1.0f;    // 防除零（与 rangeFor 兜底一致）
                        p.hasRange = true;
                    }
                    out.push_back(std::move(p));
                } else {
                    // 标量/declarator 截断必告警（对齐数组拒绝路径的
                    // 告警风格）——静默 break 会让第 33+ 个 uniform 不注册、
                    // renderer 跳过 glUniform，值静默保持 GL 默认 0
                    if (warnings && !capWarned) {
                        capWarned = true;
                        *warnings += "[uniform limit reached] " + type + " " + bare +
                                     ": only " + std::to_string(kMaxParams) +
                                     " uniform slots are supported, this and any later "
                                     "uniforms are dropped and keep GL default 0\n";
                    }
                    break;   // 槽位满：停止本声明链（后续 uniform 也已达上限，扫过不注册）
                }
            }
            // —— 链式走向：',' 继续下一 declarator；'=' / ';' 结束 ——
            const char lead = rest.empty() ? '\0' : rest[0];
            if (lead == ';') break;
            if (lead == ',') {
                if (rest.size() > 1) { decl = rest.substr(1); continue; }   // ",b;" → "b;"
                if (!(in >> decl)) break;                                    // ',' 独立成 token
                continue;
            }
            if (lead == '=') {
                // 初始化器：吞至 ';'。GLSL 330 uniform 初始化器非法，编译前由
                // stripUniformInitializers 剥离（后仅剥离初始化器段、
                // 保留链上后续 declarator——编译端 b 仍声明并保持 GL 默认 0）。
                // 解析端沿用旧行为不注册初始化器之后的名字（无槽位、不可调），
                // 与编译端的行为差异在此文档化。
                // rest 内已含 ';'（`uX=0.5;` 无空格粘连形式）→ 声明已完整，
                // 直接结束；否则从流吞至含 ';' 的 token。
                if (rest.find(';') != std::string::npos) break;
                std::string skip;
                while (in >> skip) {
                    if (skip.find(';') != std::string::npos) break;
                }
                break;
            }
            // 数组维度预读已消费/回填链上下一 token（见 multiDim 预读）：此处不得
            // 再 peek——否则会把已回填到 tok 的分隔符/下一语句冲掉，链上第二个
            // declarator（`w[2] [3], b;` 的 b）或下一条 uniform 丢失。
            if (chainPeeked) break;
            // rest 空：名字 token 无终结符。peek 下一 token 区分三种情况：
            // ① 逗号独立成 token（`a , b;`）② 初始化器（`a = ...;`）
            // ③ 下一语句的首 token（通常是 "uniform"）→ 回填外层处理
            std::string peek;
            if (!(in >> peek)) break;
            if (peek == ",") {
                if (!(in >> decl)) break;
                continue;
            }
            if (peek[0] == '=') {
                // peek 已含 ';'（如 "=0.5;" 整个初始化器在一个 token）→ 声明
                // 完整，无需再吞流（否则会误吞下一条声明）
                if (peek.find(';') == std::string::npos) {
                    std::string skip;
                    while (in >> skip) {
                        if (skip.find(';') != std::string::npos) break;
                    }
                }
                break;
            }
            tok = peek;
            haveTok = true;
            break;
        }
    }
    return out;
}

uint8_t parseSamplerChannels(const std::string& src, std::string* warnings) {
    // 预处理与 parseUniforms 一致：剥 UTF-8 BOM + 注释（避免注释里的声明被误解析）
    std::string s = src;
    if (s.size() >= 3 && (unsigned char)s[0] == 0xEF && (unsigned char)s[1] == 0xBB && (unsigned char)s[2] == 0xBF) {
        s = s.substr(3);
    }
    const std::string clean = stripComments(s);
    uint8_t mask = 0;
    // 终结符归一化见 normalizeTerminators（单一实现；本函数与 parseUniforms 共用）
    std::istringstream in(normalizeTerminators(clean));
    std::string tok;
    // 内层链 peek 回填的 token：外层直接处理、不再读流（istringstream 无法按
    // token 回退，用标志位代替 unread——与 parseUniforms 的 haveTok 同款机制）
    bool haveTok = false;
    while (haveTok || (in >> tok)) {
        haveTok = false;
        if (tok != "uniform") continue;
        // 与 parseUniforms 同款取词：先读 type 再判定，保证词流对齐
        std::string type;
        if (!(in >> type)) break;
        // 精度限定符在前的写法（`uniform highp samplerCube x;`）：限定符不是类型，再读一个
        // token 当类型（否则 type="highp" → 整条声明静默跳过）
        if (type == "highp" || type == "mediump" || type == "lowp") {
            if (!(in >> type)) break;
        }
        if (type != "sampler2D") {
            // 非 2D sampler（samplerCube/3D/2DArray 等，常从 Shadertoy 的 env map 代码搬来）：
            // 宿主只认 sampler2D，这类声明不会被 checkout/绑定、采样无效——现按告警上报
            //（面板侧 uniformParser.js 同款告警）。
            // 整数采样器 isampler2D/usampler2D 同属"宿主不支持"，一并命中（补；修 off-by-one
            // ——compare 要求 count 与字面量长度相等，先前 "usampler" 写成 9 恒不命中）。
            const bool isSamplerType = type.compare(0, 7, "sampler") == 0 ||
                                       type.compare(0, 8, "isampler") == 0 ||
                                       type.compare(0, 8, "usampler") == 0;
            if (warnings && isSamplerType) {
                // 带上声明名（与 [未绑定的采样器] 同款形态）：peek declarator token（含逗号链
                // 的后续名字，与面板侧一致）。**peek 到 "uniform" 必须回填**（无声明名的
                // `uniform samplerCube;` 形态下会把下一条声明的 `uniform` 当名字吃掉 →
                // 紧随的 `uniform sampler2D iChannelN;` 整条不被解析 → channel 位静默丢失；
                // 同款防御见下方采样器分支的 bare=="uniform" 回填）。
                std::string names;
                for (int peekN = 0; peekN < 8; ++peekN) {
                    std::string dtoken;
                    if (!(in >> dtoken)) break;
                    if (dtoken == "uniform") { tok = dtoken; haveTok = true; break; }
                    const std::string dname = dtoken.substr(0, dtoken.find_first_of(";,=["));
                    if (!dname.empty()) names += (names.empty() ? "" : ", ") + dname;
                    if (dtoken.find_first_of(";") != std::string::npos) break;   // 本声明到分号为止
                }
                *warnings += names.empty()
                    ? trFormat(Tr(S_EFFECTHOST_UNIFORMPARSER_WARN_SAMPLER_TYPE), type.c_str())
                    : trFormat(Tr(S_EFFECTHOST_UNIFORMPARSER_WARN_SAMPLER_TYPE_NAMED),
                               type.c_str(), names.c_str());
            }
            continue;
        }
        // 逗号分隔多声明（`uniform sampler2D a, b;`）逐名处理直至 ';'——
        // 若只取首个名字，第二个名字会被外层循环当独立 token 丢弃，host
        // 就不会为它 checkout/绑纹理（shader 里却真实采样 → 静默黑图）。
        // haveName：终结符后粘连的剩余字符回填为下一 declarator（`a,b;` 整体
        // 一个 token 时 `in >> name` 读不到 b——只支持空格分隔形式会让
        // 粘连/独立逗号等变体的后续名字全部丢失）。
        std::string name;
        bool haveName = false;
        while (haveName || (in >> name)) {
            haveName = false;
            const auto cut = name.find_first_of(";,=[");
            const std::string bare = name.substr(0, cut);
            // 畸形输入防御（对齐 parseUniforms）：漏分号的
            // `uniform sampler2D a, uniform sampler2D b;`——链中出现的
            // "uniform" 视为新语句首 token 交还外层扫描。不防御会为关键字
            // 产生伪告警且丢失其后声明。
            if (bare == "uniform") { tok = name; haveTok = true; break; }
            if (!bare.empty()) {
                if (bare == "iChannel0") {
                    // 内置：本图层输入（效果链上游输出），合法忽略
                } else if (bare == "iPrev") {
                    // 迭代趟内置：上一趟迭代的输出，宿主每趟绑定
                    // 到纹理单元 4。合法忽略——不进 mask（它不是图层 checkout，
                    // 由迭代循环自行绑定）。
                } else if (bare == "iHistory0" || bare == "iHistory1" ||
                           bare == "iHistory2" || bare == "iHistory3") {
                    // 输入历史内置：宿主按偏移时刻检出输入
                    // 图层后绑定。合法忽略——不进 mask（checkout 由 `// @history N`
                    // 驱动，不走映射图层那条 mask 通路）。
                } else if (bare == "iChannel1") {
                    mask |= 1u;
                } else if (bare == "iChannel2") {
                    mask |= 2u;
                } else if (bare == "iChannel3") {
                    mask |= 4u;
                } else if (warnings) {
                    // 其他名字的 sampler2D：宿主不会绑定该纹理，采样结果未定义 → 告警
                    //（枚举与面板侧同字面：iChannel0/iChannel1/2/3/iHistory0..3/iPrev——
                    // 四组全列，只列前两组会让模型误判 iHistory/iPrev 不是宿主内置）
                    *warnings += trFormat(
                        Tr(S_EFFECTHOST_UNIFORMPARSER_WARN_SAMPLER_UNBOUND), bare.c_str());
                }
            }
            if (cut == std::string::npos) {
                // 名字 token 无终结符——peek 下一 token 区分「逗号独立成
                // token 的续链」（`a , b;`，GLSL 合法书写）与「下一语句首 token」：
                // 前者继续本声明链，后者交还外层（对齐 parseUniforms 的 peek 机制）。
                // 直接 break 会让 `iChannel1 , iChannel2;` 的第二个名字被外层当
                // 普通 token 丢弃 → mask 丢位 → 不 checkout 不绑纹理 → 静默黑采样。
                std::string peek;
                if (!(in >> peek)) break;
                if (peek == ",") continue;
                if (!peek.empty() && peek[0] == ',') {
                    // 逗号后粘连下一名字（`a ,b;`）：剩余字符回填为下一 declarator
                    std::string r = peek.substr(1);
                    if (!r.empty()) { name = r; haveName = true; }
                    continue;
                }
                tok = peek;
                haveTok = true;
                break;
            }
            const char term = name[cut];
            if (term == ';') break;                // 声明结束
            if (term == ',') {
                // 粘连逗号（`a,b;` 整体一个 token）：逗号后剩余字符回填为下一
                // declarator；空（`a,` token 结束）则由循环读下一流 token（空格
                // 分隔的既有形式）
                std::string rest = name.substr(cut + 1);
                if (!rest.empty()) { name = rest; haveName = true; }
                continue;                          // 下一个同类型声明名
            }
            if (term == '[') {
                // 数组维度——解析 ']' 闭合后的剩余字符识别续链：
                // `a[4], b;` / `a[4] , b;` / `a[4],b;` 三种书写形式的后续名字，
                // 一律吞流至 ';' 会让第二个名字整体丢失（mask 丢位）。
                const size_t rb = name.find(']', cut);
                if (rb != std::string::npos) {
                    const size_t t2 = name.find_first_of(",;", rb + 1);
                    if (t2 == std::string::npos) {
                        // token 以 ']' 结束（`a[4]`）：peek 下一 token——',' 续链，
                        // 独立分号/下一语句首 token 交还外层
                        std::string peek;
                        if (!(in >> peek)) break;
                        if (peek == ",") continue;
                        if (!peek.empty() && peek[0] == ',') {
                            std::string r = peek.substr(1);
                            if (!r.empty()) { name = r; haveName = true; }
                            continue;
                        }
                        tok = peek;
                        haveTok = true;
                        break;
                    }
                    if (name[t2] == ';') break;    // `a[4];` / `a[4]=x;` 已完整
                    // name[t2] == ','：续链——逗号后剩余字符非空则回填，空则读流
                    std::string nxt = name.substr(t2 + 1);
                    if (!nxt.empty()) { name = nxt; haveName = true; }
                    continue;
                }
                // ']' 未闭合（`a[4;` 畸形）：token 内已含 ';' 则本声明完整，
                // 否则吞流至 ';'（畸形防御，对齐守卫语义）
                if (name.find(';', cut) != std::string::npos) break;
                std::string skip;
                while (in >> skip) {
                    if (skip.find(';') != std::string::npos) break;
                }
                break;
            }
            // term == '='：初始化器——吞至 ';'。GLSL 330 uniform 初始化器非法，
            // 对齐 parseUniforms 的 '=' 分支：初始化器之后的链上名字不注册。
            // 当前 token 的 cut 之后已含 ';'（`uC=xxx;` 终结符与名字
            // 粘连、整个声明在一个 token 里）→ 本声明已完整，直接结束。
            if (name.find(';', cut) != std::string::npos) break;
            std::string skip;
            while (in >> skip) {
                if (skip.find(';') != std::string::npos) break;
            }
            break;
        }
    }
    // 采样了但**没声明**的 iChannelN：mask 只由声明行驱动，
    // 而骨架里恒声明 iChannel1/2/3（编译必过）→ "只采样不声明"若不给告警即零诊断：
    // 不 checkout、行不启用、渲染绑兜底透明黑，用户/模型只看到一片黑、error.log 一个字
    // 都没有——而这是最可能犯的错（把 iChannelN 当 iChannel0 那样的内置直接用）。
    // 补一条与「未绑定的采样器」同口径的告警（进 error.log，面板 get_render_error 可读）。
    // 判据取**词边界**匹配（注释已剥离）：`iChannel10`/`iChannel1x` 之类不算。
    // 边界：判据是**文本级**的——函数形参/局部变量同名遮蔽、
    // `#if 0` 死代码、仅宏体里出现都会命中（故文案用"若它指的就是…"留余地）；反向漏报一种：
    // 令牌粘贴宏 `#define CH(n) iChannel##n` + `texture(CH(1),f)`（文本里没有完整名字）。
    // 两者都接受：主流错法是"直接写 texture(iChannel1,…) 却忘了声明"，那种必被抓到。
    if (warnings) {
        static const struct { const char* name; uint8_t bit; } kChans[] = {
            {"iChannel1", 1u}, {"iChannel2", 2u}, {"iChannel3", 4u}
        };
        for (const auto& c : kChans) {
            if (mask & c.bit) continue;                       // 已声明：正常，不告警
            const std::string n(c.name);
            bool used = false;
            for (size_t p = clean.find(n); p != std::string::npos; p = clean.find(n, p + n.size())) {
                const auto isWord = [](char ch) {
                    return std::isalnum(static_cast<unsigned char>(ch)) || ch == '_';
                };
                const bool lOk = (p == 0) || !isWord(clean[p - 1]);
                const size_t after = p + n.size();
                const bool rOk = (after >= clean.size()) || !isWord(clean[after]);
                if (lOk && rOk) { used = true; break; }
            }
            if (used) {
                *warnings += trFormat(
                    Tr(S_EFFECTHOST_UNIFORMPARSER_WARN_SAMPLER_UNDECLARED),
                    n.c_str(), n.c_str());
            }
        }
    }
    return mask;
}

std::string stripUniformInitializers(const std::string& src) {
    // `uniform <type> <name> = <init>;` → `uniform <type> <name>;`
    // `uniform <type> <name> = <init>, b;` → `uniform <type> <name>, b;`
    // 旧正则 `=[^;]*;` 贪婪吞到分号，把逗号链中后续 declarator 一并
    // 剥掉——strip 后 shader 中 b 未声明，mainImage 使用 b 时报 "undeclared"，
    // 编译错误与用户实际写法之间的因果被 strip 掩盖、误导 LLM 排错方向。
    // 改为仅剥离初始化器段、保留后续 declarator。
    // 初始化器结束判定需括号深度感知：vec2(1.0, 2.0) 内部的逗号处于深度 > 0，
    // 不是 declarator 分隔符——扫描到深度 0 的首个 ','（其后 declarator 保留）
    // 或 ';'（声明终结，整段剥离）。链上多个初始化器（`a = 0.5, b = 0.6;`）
    // 逐个剥离。与 JS uniformParser.js stripUniformInitializers 同源白名单
    //（float/vec2/vec3/vec4）。
    // 注释门控——头匹配与改写扫描器均对原始 src 直接工作时：
    // `/* uniform float a = */` 的头匹配落在注释内，扫描器把注释闭合符之后
    // 的第一处深度 0 ';'/',' 当终结符，真实声明被当初始化器吞掉，且块注释
    // 失去闭合符殃及后续全部源码（所编译源码≠所见源码）。改为：头匹配起点
    // 落在注释内（commentMaskOf）一律跳过（注释段原样保留）；扫描器遇注释
    // 区间整体跳过——初始化器内注释中的 ';'/','/括号不再参与终结与深度判定。
    // 头正则补可选精度限定符（highp/mediump/lowp）——旧头 `uniform\s+(float|…)`
    // 要求 uniform 后紧跟类型，`uniform highp float uX = 1.0;` 不匹配 → 初始化器
    // 原样进编译（GLSL 330 uniform 初始化器非法，严格驱动直接编译失败）。解析侧
    // 已跳过限定符，剥离侧须同口径。组序：1=精度（可空）、
    // 2=类型、3=名字；重建头时精度原样保留。
    static const std::regex head(
        R"(uniform\s+(?:(highp|mediump|lowp)\s+)?(float|vec2|vec3|vec4)\s+([A-Za-z_]\w*)\s*=)");
    const std::vector<bool> inCmt = commentMaskOf(src);
    std::string out;
    out.reserve(src.size());
    size_t pos = 0;
    while (pos < src.size()) {
        std::smatch m;
        if (!std::regex_search(src.begin() + static_cast<std::ptrdiff_t>(pos),
                               src.end(), m, head)) {
            out.append(src, pos, src.size() - pos);
            break;
        }
        const size_t mstart = pos + static_cast<size_t>(m.position(0));
        const size_t mend = mstart + static_cast<size_t>(m.length(0));
        // 头匹配起点落在注释内 → 伪声明，跳过（注释段原样保留到
        // 匹配末尾，从匹配末尾继续找下一个头）
        if (inCmt[mstart]) {
            out.append(src, pos, mend - pos);
            pos = mend;
            continue;
        }
        // 声明链逐段改写：初始化器段丢弃，其余（名字/逗号/分号）保留。
        // inInit = 当前处于初始化器段（剥离）；否则原样拷贝，遇 '=' 进入剥离。
        // 深度 0 的 ';' 结束本条声明 → 提交改写；扫描到源码结尾仍未终结 →
        // 放弃改写、原样保留（对齐旧正则「必须有 ';' 才匹配」的行为）。
        // 名字与 '='/';' 之间的空白在剥离/终结前修剪（`b = 0.6` 剥离后不得
        // 残留 `b ;`——GLSL 空白不敏感，仅求输出干净）。
        std::string repl = "uniform ";
        if (m[1].matched) repl += m[1].str() + " ";   // 精度限定符原样保留
        repl += m[2].str() + " " + m[3].str();
        bool inInit = true;
        int depth = 0;
        bool complete = false;
        size_t i = mend;
        for (; i < src.size(); ++i) {
            // 注释区间整体跳过——inInit 时初始化器内注释的 ';'/','/
            // 括号不参与终结/深度判定（不拷贝：初始化器本就要丢弃）；非
            // inInit（拷贝 declarator 段）时原样保留
            if (inCmt[i]) {
                if (!inInit) repl += src[i];
                continue;
            }
            const char c = src[i];
            if (inInit) {
                if (c == '(' || c == '[' || c == '{') {
                    ++depth;
                } else if (c == ')' || c == ']' || c == '}') {
                    if (depth > 0) --depth;
                } else if (depth == 0 && (c == ',' || c == ';')) {
                    repl += c;
                    if (c == ';') { complete = true; break; }
                    inInit = false;   // ','：后续 declarator 原样保留
                }   // 其余初始化器字符：丢弃
            } else {
                if (c == '=') {
                    while (!repl.empty() && std::isspace(static_cast<unsigned char>(repl.back())))
                        repl.pop_back();
                    inInit = true;   // 链上后续 declarator 的初始化器：进入剥离
                } else {
                    repl += c;
                    if (c == ';') {
                        while (repl.size() > 1 &&
                               std::isspace(static_cast<unsigned char>(repl[repl.size() - 2])))
                            repl.erase(repl.size() - 2, 1);
                        complete = true;
                        break;
                    }
                }
            }
        }
        if (!complete) {
            // 截断/畸形（无深度 0 终结符）：本段原样保留，从声明头之后继续找
            out.append(src, pos, mend - pos);
            pos = mend;
            continue;
        }
        out.append(src, pos, mstart - pos);
        out += repl;
        pos = i + 1;
    }
    return out;
}

// 剥离用户源码中的内置 uniform 声明（iChannel0..3 / uTime /
// uResolution / uAspect / uHasCam / uCamPos / uCamMatrix / uWorldMatrix）——
// renderer 在片元着色器前部预声明这些内置 uniform，
// GLSL 同作用域同名重复声明是编译错误（旧注释「GLSL 330 允许同类型重复
// 声明」不成立：NVIDIA 宽容掩盖，AMD/Intel/严格驱动直接编译失败——迁移自
// Shadertoy 的 shader 常自带这些声明）。按名字匹配（类型不限——错误类型的
// 内置再声明同样剔除，宿主预声明为准）；整条声明全为内置 → 移除；逗号链
// 混排 → 仅剔除内置 declarator、保留其余（改写模式对齐
// stripUniformInitializers）；注释内伪声明经注释门控跳过。链上带初始化器
//（调用方应先过 stripUniformInitializers）或类型/名字之间夹注释等非预期
// 形态 → 本条原样保留（宁可不剥离也不改坏）。
std::string stripBuiltinUniformDecls(const std::string& src) {
    // 头正则补可选精度限定符（highp/mediump/lowp）。旧头 `\buniform\s+([A-Za-z_]\w*)`
    // 在 `uniform highp float uTime;` 上把 "highp" 当类型、随后的 declarator 扫描从
    // "float uTime;" 开始：先读 "float" 当名字、下一字符是字母非 ','/';' → chainOk=false
    // → 整条原样保留。宿主 renderer 预声明 uTime（GLSL 同作用域重复声明 = 编译错误，
    // AMD/Intel 严格驱动直接失败），用户源码里的精度限定符写法因此必编译不过。
    // 组 1 取整段头（"uniform [precision ]type"，精度原样保留——重建链时用它）。
    static const std::regex head(
        R"(\b(uniform\s+(?:(?:highp|mediump|lowp)\s+)?[A-Za-z_]\w*)\s*)");
    const std::vector<bool> inCmt = commentMaskOf(src);
    auto isBuiltinName = [](const std::string& n) {
        return n == "iChannel0" || n == "iChannel1" || n == "iChannel2" ||
               n == "iChannel3" || n == "uTime" || n == "uResolution" || n == "uAspect" ||
               // L4 全分辨率尺寸（renderer 预声明；vec2 若不剥离会编译期重复声明失败）
               n == "uLayerSize" ||
               // 迭代趟内置（renderer 预声明）
               n == "iPrev" || n == "uIter" || n == "uIterCount" ||
               // 结算器内置：uStep/uFrame + 历史采样器
               n == "uStep" || n == "uFrame" || n == "uDt" ||
               n == "iHistory0" || n == "iHistory1" || n == "iHistory2" || n == "iHistory3" ||
               // L2 相机感知内置（renderer 同样预声明，重复声明编译错误）
               n == "uHasCam" || n == "uCamFov" || n == "uCamPos" ||
               n == "uCamMatrix" || n == "uWorldMatrix" ||
               // L3 灯光感知内置（renderer 同样预声明；数组名按**裸名**匹配——
               // 声明形态为 `uniform vec3 uLightPos[8];`，head 正则只捕到类型与
               // 裸名，数组维度在其后，故此处无需带 [8]）
               n == "uHasLights" || n == "uLightCount" || n == "uLightType" ||
               n == "uLightPos" || n == "uLightDir" || n == "uLightColor" ||
               n == "uLightParams";
    };
    auto skipSpace = [&](size_t& i) {
        while (i < src.size() && !inCmt[i] &&
               std::isspace(static_cast<unsigned char>(src[i]))) ++i;
    };
    std::string out;
    out.reserve(src.size());
    size_t pos = 0;
    while (pos < src.size()) {
        std::smatch m;
        if (!std::regex_search(src.begin() + static_cast<std::ptrdiff_t>(pos),
                               src.end(), m, head)) {
            out.append(src, pos, src.size() - pos);
            break;
        }
        const size_t mstart = pos + static_cast<size_t>(m.position(0));
        const size_t mend = mstart + static_cast<size_t>(m.length(0));
        // 注释内伪声明跳过（注释段原样保留到匹配末尾）
        if (inCmt[mstart]) {
            out.append(src, pos, mend - pos);
            pos = mend;
            continue;
        }
        // 扫描 declarator 链：name('['dim']')? (',' name ...)* ';'，
        // 白名单外的字符（'=' 初始化器等）→ 放弃本条改写
        size_t i = mend;
        std::vector<std::pair<std::string, bool>> chain;   // (名字[维度], 是否内置)
        bool anyBuiltin = false;
        bool chainOk = false;
        while (true) {
            skipSpace(i);
            if (i >= src.size() || inCmt[i] ||
                !(std::isalpha(static_cast<unsigned char>(src[i])) || src[i] == '_')) break;
            const size_t nb = i;
            while (i < src.size() && !inCmt[i] &&
                   (std::isalnum(static_cast<unsigned char>(src[i])) || src[i] == '_')) ++i;
            const std::string name = src.substr(nb, i - nb);
            const bool builtin = isBuiltinName(name);
            anyBuiltin |= builtin;
            std::string dtext = name;
            skipSpace(i);
            if (i < src.size() && !inCmt[i] && src[i] == '[') {
                const size_t rb = src.find(']', i);
                if (rb == std::string::npos || inCmt[rb]) break;
                dtext += src.substr(i, rb - i + 1);
                i = rb + 1;
                skipSpace(i);
            }
            chain.emplace_back(dtext, builtin);
            if (i < src.size() && !inCmt[i] && src[i] == ',') { ++i; continue; }
            if (i < src.size() && !inCmt[i] && src[i] == ';') { ++i; chainOk = true; break; }
            break;   // '=' 等非预期 → 放弃本条改写
        }
        if (!chainOk || !anyBuiltin) {
            // 不含内置或链形态非预期：原样保留（chainOk 时 i 已越过 ';'；
            // 否则从匹配末尾继续找下一个头，链余下部分原样透传）
            out.append(src, pos, (chainOk ? i : mend) - pos);
            pos = chainOk ? i : mend;
            continue;
        }
        // 含内置：前缀原样保留，链重建（只留非内置 declarator；
        // 全为内置 → 整条声明移除）
        out.append(src, pos, mstart - pos);
        bool keptAny = false;
        for (const auto& d : chain) {
            if (!d.second) { keptAny = true; break; }
        }
        if (keptAny) {
            out += m[1].str();   // 组 1 已含 "uniform [precision ]type" 整段头
            bool first = true;
            for (const auto& d : chain) {
                if (d.second) continue;
                out += first ? " " : ", ";
                out += d.first;
                first = false;
            }
            out += ";";
        }
        pos = i;   // 链尾 ';' 之后
    }
    return out;
}

// （观察级收口）：剥离精度限定符——宿主编译端专用（契约与理由见
// uniformParser.h）。两趟：
//   ① `precision <q> <type>;` 语句整条替换为等量空白（保留其中的换行——#line 1
//      的用户行号映射不受影响）；语句外层包的是 `precision`，桌面 330 里
//      `precision` 语句整条非法，删整条而不是只删关键字（只删关键字会留下
//      `float;` 这种同样非法的残句）。
//   ② 其余位置的 highp/mediump/lowp 关键字（声明/形参/局部变量前）按词删除。
//      桌面 GLSL 无精度语义 → 删除语义中性；这三个词在桌面 GLSL 里是保留字
//      （用户不可能拿它们当标识符），词级删除不会伤到合法代码。
// 注释门控同其他剥离器：注释内的字面量一律原样保留（不做任何改写）。
std::string stripPrecisionQualifiers(const std::string& src) {
    const std::vector<bool> inCmt = commentMaskOf(src);
    std::string out;
    out.reserve(src.size());
    // ① 精度语句整条（含跨行：`precision\n highp float;`——以 \s 匹配、换行原样保留）
    {
        static const std::regex stmt(R"(\bprecision\s+(?:highp|mediump|lowp)\s+[A-Za-z_]\w*\s*;)");
        size_t pos = 0;
        while (pos < src.size()) {
            std::smatch m;
            if (!std::regex_search(src.begin() + static_cast<std::ptrdiff_t>(pos),
                                   src.end(), m, stmt)) break;
            const size_t ms = pos + static_cast<size_t>(m.position(0));
            const size_t me = ms + static_cast<size_t>(m.length(0));
            if (inCmt[ms]) {          // 注释内伪语句：原样保留（对齐其他剥离器）
                out.append(src, pos, me - pos);
                pos = me;
                continue;
            }
            out.append(src, pos, ms - pos);
            for (size_t i = ms; i < me; ++i)
                if (src[i] == '\n') out += '\n';   // 行数不变
            pos = me;
        }
        out.append(src, pos, src.size() - pos);
    }
    // ② 词级删除限定符关键字（注释外）。
    // afterPrecision：紧跟 `precision` 的限定符**不删**——① 已删整条语句，此处仍遇到
    // `precision` 说明①没命中（如语句内含注释 `precision /*c*/ highp float;`），
    // 只删关键字会留下 `precision float;` 这种更坏的残句（NVIDIA 宽容路径也可能
    // 从"能编"变"编不过"）。整条留着 = 与改动前逐字一致（该形态本就不在剥离面内）。
    std::string res;
    res.reserve(out.size());
    const std::vector<bool> cmt2 = commentMaskOf(out);
    const auto isIdent = [](char c) {
        return std::isalnum(static_cast<unsigned char>(c)) || c == '_';
    };
    bool afterPrecision = false;
    for (size_t i = 0; i < out.size();) {
        if (cmt2[i] || !isIdent(out[i]) || std::isdigit(static_cast<unsigned char>(out[i]))) {
            res += out[i];
            ++i;
            continue;
        }
        size_t j = i;
        while (j < out.size() && isIdent(out[j])) ++j;
        const std::string tok = out.substr(i, j - i);
        const bool isQual = (tok == "highp" || tok == "mediump" || tok == "lowp");
        if (!isQual || afterPrecision) res += tok;
        afterPrecision = (tok == "precision");
        i = j;
    }
    return res;
}

// —— 命名语义匹配内核（供角度语义复用）——
// 前边界：串首 / 非词字符（'_' 等）/ 驼峰（前小写且本词首大写，如 uColor）
static bool atSemanticWordStart(const std::string& n, size_t i) {
    if (i == 0) return true;
    if (!std::isalnum(static_cast<unsigned char>(n[i - 1]))) return true;
    return std::isupper(static_cast<unsigned char>(n[i])) != 0 &&
           std::islower(static_cast<unsigned char>(n[i - 1])) != 0;
}
// 后边界：串尾 / 非词字符 / 驼峰（后接大写子词首，如 colorTint）
static bool atSemanticWordEnd(const std::string& n, size_t e) {
    if (e >= n.size()) return true;
    if (!std::isalnum(static_cast<unsigned char>(n[e]))) return true;
    return std::isupper(static_cast<unsigned char>(n[e])) != 0;
}
// 不区分大小写地查找 w，且须落在词首边界上；requireWordEnd=true 时还要求词尾边界。
static bool findSemanticWord(const std::string& n, const char* w, bool requireWordEnd) {
    const auto lowerCh = [](char c) {
        return static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    };
    const size_t wl = std::strlen(w);
    for (size_t i = 0; i + wl <= n.size(); ++i) {
        bool eq = true;
        for (size_t k = 0; k < wl; ++k) {
            if (lowerCh(n[i + k]) != w[k]) { eq = false; break; }
        }
        if (!eq) continue;
        if (!atSemanticWordStart(n, i)) continue;
        if (requireWordEnd && !atSemanticWordEnd(n, i + wl)) continue;
        return true;
    }
    return false;
}

// 颜色语义判定——匹配完整词 "color"/"colour"（不区分大小写）且
// 须落在词法边界上：前后为串首/尾、'_'（snake_case 分隔符）或驼峰边界
//（前小写接本词首大写，如 uColor；词后接大写子词首，如 colorTint）。
// '_' 按词分隔符处理（与驼峰边界同属「人类分词」，my_colour_value 等既有
// snake_case 命名保持命中，不影响 coulomb 修复——其不含 color/colour 子串）。
// 按 4 字符前缀 "colo"/"coul" 任意位置匹配时：coulomb/coulombConstant 等
// 物理量命名被误判颜色语义，vec3 被渲染成取色器丢分量编辑。
bool isColorNamed(const std::string& n) {
    static const char* const kWords[] = {"color", "colour"};
    for (const char* w : kWords) {
        if (findSemanticWord(n, w, /*requireWordEnd=*/true)) return true;
    }
    return false;
}

// 角度语义判定——匹配词干 "angle"/"deg"/"rot" 于**词首边界**，
// **不要求词尾边界**：调用方（params.h slotSliderRange）要给角度类 uniform 一个
// -360..360 的滑条量程，必须覆盖词干派生名 rotation / rotSpeed / degrees / degToRad，
// 词尾边界会把它们全部漏掉（"rot" 后接 'a' 就被判为不匹配）。
// 与 isColorNamed 的整词口径不同是有意的：颜色必须整词（否则 coulomb 类误判，
// 见上），而角度词干在词首出现时无同类误判（degrade 一类命名在实际 shader 中
// 不表示角度，但这也是本判定能容忍的最坏误报）。
bool isAngleNamed(const std::string& n) {
    static const char* const kStems[] = {"angle", "deg", "rot"};
    for (const char* w : kStems) {
        if (findSemanticWord(n, w, /*requireWordEnd=*/false)) return true;
    }
    return false;
}

// —— 迭代趟 ——
// 定义形态预检：只认「返回类型前缀 + 名字 + '('」，与面板 glslValidator 的
// noise 族撞名预检同款口径——纯调用 `iterateImage(...)` 不算定义。
// 注释门控：注释掉的伪定义（`// vec4 iterateImage(...)`）不算，
// 否则用户注释掉迭代趟后宿主仍会去编译一个不存在的入口 → 编译失败。
bool hasIteratePass(const std::string& src) {
    static const std::regex defRe(R"(\bvec4\s+iterateImage\s*\()");
    const std::vector<bool> inCmt = commentMaskOf(src);
    std::smatch m;
    std::string::const_iterator it = src.begin();
    while (std::regex_search(it, src.end(), m, defRe)) {
        const size_t at = static_cast<size_t>(m.position(0)) +
                          static_cast<size_t>(it - src.begin());
        if (!inCmt[at]) return true;
        it = m[0].second;
    }
    return false;
}

// `// @iterations N`：文件级指令，取**首个**匹配（原注释流上搜——指令本身
// 就在注释里，不能用 stripComments 后的文本）。未声明 → defaultValue；
// 声明了但数字非法/越界 → 钳制到 [1, kMaxIterations]。
// 不做注释门控的理由：@iterations 只可能出现在注释中，做门控等于永不命中。
// 取首个而非"最后一个"：与 @range 的"就近声明行"语义不同——趟数是文件级
// 单一事实，首个声明即生效，避免尾部注释里的示例值意外覆盖。
int parseIterations(const std::string& src, int defaultValue) {
    static const std::regex iterRe(R"(@iterations\s+([0-9]+))");
    std::smatch m;
    int v = defaultValue;
    if (std::regex_search(src, m, iterRe)) {
        // 位数防御：先限长度再 atoi，避免超长数字串的溢出未定义行为
        const std::string digits = m[1].str();
        if (digits.size() > 6) {
            v = kMaxIterations;
        } else {
            v = std::atoi(digits.c_str());
        }
    }
    if (v < 1) v = 1;
    if (v > kMaxIterations) v = kMaxIterations;
    return v;
}

// `// @solve N`：结算器每帧子步数。未声明 → 0（= 非结算模式）。
// 与 @iterations 同款：取首个匹配、位数防御、钳制 [1, kMaxSolveSteps]。
int parseSolveSteps(const std::string& src) {
    static const std::regex solveRe(R"(@solve\s+([0-9]+))");
    std::smatch m;
    if (!std::regex_search(src, m, solveRe)) return 0;
    const std::string digits = m[1].str();
    int v = (digits.size() > 6) ? kMaxSolveSteps : std::atoi(digits.c_str());
    if (v < 1) v = 1;
    if (v > kMaxSolveSteps) v = kMaxSolveSteps;
    return v;
}

// `// @solveHz N`：结算器每秒子步数（真实时间驱动）。未声明 → 0。
// 正则必须 `\s+`（与 @solve 同构）："@solveHz 400" 的 "@solve" 后是 'H' 不是空白，
// 不会被上面的 @solve 正则误吞——两个正则互不越界是 @solveHz 能与 @solve 共存
// （按优先级取舍）的前提。
int parseSolveHz(const std::string& src) {
    static const std::regex hzRe(R"(@solveHz\s+([0-9]+))");
    std::smatch m;
    if (!std::regex_search(src, m, hzRe)) return 0;
    const std::string digits = m[1].str();
    int v = (digits.size() > 6) ? kMaxSolveHz : std::atoi(digits.c_str());
    if (v < 1) v = 1;
    if (v > kMaxSolveHz) v = kMaxSolveHz;
    return v;
}

// `// @history N`：I2a 输入历史检出帧数。未声明 → 0。
int parseHistoryFrames(const std::string& src) {
    static const std::regex histRe(R"(@history\s+([0-9]+))");
    std::smatch m;
    if (!std::regex_search(src, m, histRe)) return 0;
    const std::string digits = m[1].str();
    int v = (digits.size() > 6) ? kMaxHistory : std::atoi(digits.c_str());
    if (v < 0) v = 0;
    if (v > kMaxHistory) v = kMaxHistory;
    return v;
}

// `// @solveRes N`：仿真网格长边。未声明 → 0（调用方取 kSolveResDefault）。
int parseSolveRes(const std::string& src) {
    static const std::regex resRe(R"(@solveRes\s+([0-9]+))");
    std::smatch m;
    if (!std::regex_search(src, m, resRe)) return 0;
    const std::string digits = m[1].str();
    int v = (digits.size() > 6) ? kSolveResMax : std::atoi(digits.c_str());
    if (v < kSolveResMin) v = kSolveResMin;
    if (v > kSolveResMax) v = kSolveResMax;
    return v;
}

// 三件套一次解析。优先级：@solveHz > @solve > @iterations > （有 iterateImage 时
// 的默认趟数）。同时出现取"更重/更强意图"的那条并让另一条静默失效——改主意
// 忘删旧行的场景，报错不如取新意图。
IterConfig parseIterConfig(const std::string& src) {
    IterConfig c;
    c.historyFrames = parseHistoryFrames(src);
    c.simDim = parseSolveRes(src);
    const int hz = parseSolveHz(src);
    if (hz > 0) {
        // @solveHz（真实时间口径）：stepsPerFrame 置 0——每帧实际子步数由渲染侧按
        // 合成帧率推导（渲染期才知道 time_step），解析期只携带 hz。
        c.mode = IterMode::Solver;
        c.solveHz = hz;
        return c;
    }
    const int solve = parseSolveSteps(src);
    if (solve > 0) {
        // 不要求 hasIteratePass：@solve 写了但没定义 iterateImage 时，让迭代趟
        // 编译失败进错误帧——比"静默退回单趟"更能说明问题在哪。
        c.mode = IterMode::Solver;
        c.stepsPerFrame = solve;
        return c;
    }
    if (hasIteratePass(src)) {
        c.mode = IterMode::Stateless;
        c.stepsPerFrame = parseIterations(src);
        return c;
    }
    return c;   // None：单趟
}

// 输入图层是否可能被读取——决定渲染侧要不要做"AE 帧 → RGBA float 转换 + 上传"
//（16bit 工程下这两段实测 13.7ms/帧、占整帧 38%）。
// 两个来源：
//   ① 正文引用 iChannel0；
//   ② iPrev —— 但它的来路**按模式分**：结算（@solve/@solveHz）下 iPrev 全程是状态
//      纹理（播种那步读的是网格尺寸的零状态纹理），与输入图层无关；其余模式
//      （@iterations 的首趟、无迭代趟的主趟）iPrev 读的就是输入图层。
// 判据用源码串包含（保守方向：注释里出现也算"需要"，宁可多传一次），故不依赖
// program 是否已编译/link。
// **本函数存在的原因**：曾按"有迭代趟 ⇒ iPrev 不是输入"判定，而
// example_reaction_diffusion（@iterations，全文 11 处 iPrev、0 处 iChannel0）的
// 首趟正是读输入图层 —— 那样会跳过上传，整个效果变黑。
bool inputLayerNeeded(const std::string& src) {
    if (src.find("iChannel0") != std::string::npos) return true;
    if (src.find("iPrev") == std::string::npos) return false;
    return parseIterConfig(src).mode != IterMode::Solver;
}
} // namespace glsl
