// customUI.cpp —— 槽位 CUSTOM UI 自绘与交互（Drawbot）
// 参考：SDK Examples/UI/ColorGrid（arbitrary+UI+关键帧）、Custom_ECW_UI（事件/绘制）。
// 事件入口 HandleUIEvent 由 plugin.cpp 的 PF_Cmd_EVENT 分发调用。
#include "customUI.h"
#include "AE_EffectCB.h"   // _PF_UtilCallbacks 完整定义（host_lock_handle 等；WndProc 直接写参数用）
#include "AE_EffectSuites.h"
#include "AE_AdvEffectSuites.h"   // kPFAdvAppSuite：PF_RefreshAllWindows（滚轮消费触发重绘）
#include "AE_Macros.h"            // DH()（序列数据句柄直取，宿主已加锁——见 InstanceInstanceId）
#include "AEFX_SuiteHelper.h"     // AEFX_SuiteScoper（序列数据套件读取，见 InstanceInstanceId）
#include "params.h"
#include "seqIdentity.h"          // 实例身份载体（序列数据；见该文件头）
#include "renderer.h"    // 结算器状态（重算按钮走「重算代数」参数，见 params.h）
#include "effectState.h"
#include "uniformParser.h"
#include "errorLog.h"
#include "glslLoader.h"
#include "i18n.h"              // 用户可见文案（取色器标题/文件计数/解算进度/按钮）
#include "selWheelPolicy.h"   // 目标表匹配/剔除/超时修剪纯逻辑（可单测）
#include "uiNoticePolicy.h"   // 槽位栏/表头「GLSL 文件已丢失」提醒判据与文案（纯逻辑，可单测）
#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <string>
#include <vector>

namespace host {
namespace {

// —— 常量 ——
constexpr int kInset       = 4;    // 控件左边距
constexpr int kTextWidth   = 46;   // 滑条右侧数值输入框宽度（缩窄：原 56 显得框太长）
constexpr int kSwatchWidth = 48;   // 色块宽度
constexpr int kAlphaWidth  = 60;   // vec4 alpha 滑条宽度
constexpr int kPointGlyphW = 18;   // 点控件左侧 "+" 图标区宽度
// 点控件每行开头的分量标签（x/y/z/a）占宽。每个分量独占一行后，标签留在行首、
// 轨道从标签右侧起——沿用"每列内先标签后轨道"的相对次序。
constexpr int kCompLabelW  = 14;
// 数值框纵向高度与横向净空（见 valueBoxRect：绘制/命中/编辑浮窗共用同一矩形）
// 实测行高：AE 给槽位行的控件框是 20px（日志 [click-probe] h=20；注册的 ui_height=22
// 被 AE 收走 2px）。14px 框在 20px 行里上下各留 3px 空档——"点框上方"才是真的点在框外。
constexpr int kValueBoxH   = 14;
constexpr int kValueBoxGap = 6;    // 框左缘与轨道右端的净空（滑块半径 4 + 2px 间隙）
// 滑轨（含 vec4 alpha）的**拖拽带**高度：只包住可见轨道本身（drawTrack 的 kTrackH=4）
// 加滑块半径 4，上下各留 1px 余量。
// 约束：拖拽带与数值框带不可统一成同一条 16px 带，否则"点轨道上方 6-8px
// 也能拖动滑条"（用户实测：pt=(250,435) 距可见轨道上缘 5px 仍被判为拖拽）。
// 拖拽带与数值框带是两种东西——前者贴视觉轨道，后者等于绘制的框矩形。
constexpr int kTrackBandH  = 10;

// —— 数值工具 ——
float clampf(float v, float lo, float hi) { return (std::max)(lo, (std::min)(hi, v)); }
float clamp01(float v) { return clampf(v, 0.0f, 1.0f); }

// isColorNamed 迁至 uniformParser（glsl::isColorNamed，纯 C++
// 可测）并加词法边界校验——按 4 字符前缀 "colo"/"coul" 做任意位置子串
// 匹配会把 coulomb 类物理量命名误判颜色语义（vec3 渲染成取色器丢分量编辑）。
// 行为兼容：uColor/colorTint/colour 等既有命名形态经驼峰词边界保持命中。

enum class ControlKind { Slider, Point, Swatch };

ControlKind kindFor(const glsl::Param& p) {
    switch (p.type) {
    case glsl::ParamType::Float: return ControlKind::Slider;
    case glsl::ParamType::Vec2:
    case glsl::ParamType::Vec3:
        return glsl::isColorNamed(p.name) ? ControlKind::Swatch : ControlKind::Point;
    case glsl::ParamType::Vec4:
        return ControlKind::Swatch;
    }
    return ControlKind::Slider;
}

// 绘制用分量数 = 行数（见 params.h slotUiRows：Vec2=2 / Vec3=3 / 其余=1）。
// 点控件用**每个分量独占一行**而非"一行内并排 N 列"——并排时
// Vec3 每列仅约 60px（扣掉标签与数值框后滑轨所剩无几），滑条太短很难拖动。
// 行数与注册行高（kSlotUiHeight × slotUiRows）共用同一函数，两处不会漂移。
int drawCompCount(const glsl::Param& p) { return slotUiRows(p); }

// Point 行内**可见轨道**的横向范围（drawPoint 的 drawTrack 就画在这一段）：
// 行首分量标签右侧 → 数值框左缘留 4px 净空。
// 绘制 / 拖拽灵敏度 / 点击绝对定位三处共用本函数——三者不同宽就会出现
// "点轨道中点、滑块跳到别处"（并排分列时列窄、差异被掩盖，整行布局后暴露）。
void pointTrackSpan(const PF_Rect& f, int* trackL, int* trackW) {
    const int l = f.left + kInset + kPointGlyphW + kCompLabelW;
    const int r = f.right - kTextWidth - 4;
    if (trackL) *trackL = l;
    if (trackW) *trackW = (std::max)(1, r - l);
}

// Point 控件第 row 个分量的**行几何**（drawPoint / hitTest / handleClick / valueBoxRect
// 共用同一来源）。纵向：把控件框按行数等分（用乘除而非累加，行边界不累积误差）；
// 横向：左侧 "+" 图标区（各行统一保留，保证各行左边界对齐）→ 分量标签 → 轨道 →
// 右侧 kTextWidth 数值框。
void pointRowGeom(const PF_Rect& f, const glsl::Param& p, int row,
                  int* rowT, int* rowB, int* labL, int* trackL, int* numL, int* numR) {
    const int n = (std::max)(1, drawCompCount(p));
    int rt = 0, rb = 0;
    slotRowBand(f.top, f.bottom, n, row, &rt, &rb);   // 切分口径见 params.h（有单测）
    const int start = f.left + kInset + kPointGlyphW;
    if (rowT)   *rowT = rt;
    if (rowB)   *rowB = rb;
    if (labL)   *labL = start;
    if (trackL) *trackL = start + kCompLabelW;
    if (numL)   *numL = f.right - kTextWidth;
    if (numR)   *numR = f.right;
}

// Slider 行轨道右端（= 数值框段的左界基准）。drawSlider / hitTest / valueBoxRect
// 共用同一式，避免"各算一份"再次分叉。
int sliderTrackR(const PF_Rect& f) { return f.right - kTextWidth; }

// 数值输入框的矩形——**单点来源**：drawSlider / drawPoint / hitTest / handleClick /
// openValueEdit 五处共用，绘制出来的框与命中判定的框恒为同一个矩形。
// 症状（"折叠后参数右边仍能点开输入框；展开后参数名右边、数值框上方
// 点击也能出输入框"）：两边各算一份时偏差都是"命中比绘制大"——
//   · 纵向：绘制框是 top+1..bottom-1（几乎占满整行），命中判据却是**整行**
//     （Point）或**完全没有纵向判定**（Slider）→ 框外上下几点也算命中；
//   · 横向（Slider）：判定自 f.right-kTextWidth 起算，绘制的框自 trackR+6 起算
//     → 框左侧 6px 空隙也算命中。
// 现在纵向统一为行内居中 kValueBoxH 高的带，横向与各自绘制处同一来源。
// 【注意】kValueBoxH 的带是**数值框**的带；滑轨的拖拽带另用 trackBand（见其注释）。
struct BoxRect { int L, R, T, B; };

// 行内居中的 h 高纵向带（钳制在控件框内）
void bandOf(const PF_Rect& f, int h, int* t, int* b) {
    const int cy = f.top + (f.bottom - f.top) / 2;
    *t = (std::max)(f.top, cy - h / 2);
    *b = (std::min)(f.bottom, cy + h / 2);
}

// 数值框的纵向范围（= 绘制出来的框的上下边）
void valueBoxBand(const PF_Rect& f, int* t, int* b) { bandOf(f, kValueBoxH, t, b); }

// 滑轨的拖拽带（紧贴可见轨道，不含数值框区域）
void trackBand(const PF_Rect& f, int* t, int* b) { bandOf(f, kTrackBandH, t, b); }

BoxRect valueBoxRect(const PF_Rect& f, ControlKind kind, const glsl::Param& p, int comp) {
    BoxRect r;
    if (kind == ControlKind::Point) {
        // 点控件：该分量**所在行**右侧 kTextWidth 段（行几何见 pointRowGeom）。
        // 纵向必须取该行的居中带——整框的 band 会把三行都算成同一行的高度，
        // 于是三个数值框重叠在中间、上下两行点不开输入框。
        int rt = 0, rb = 0;
        pointRowGeom(f, p, comp, &rt, &rb, nullptr, nullptr, &r.L, &r.R);
        const int cy = rt + (rb - rt) / 2;
        r.T = (std::max)(rt, cy - kValueBoxH / 2);
        r.B = (std::min)(rb, cy + kValueBoxH / 2);
        return r;
    }
    // 滑条：轨道右端右移净空后占满 kTextWidth 段（drawSlider 的框与此同源）
    r.L = sliderTrackR(f) + kValueBoxGap;
    r.R = f.right;
    valueBoxBand(f, &r.T, &r.B);
    return r;
}

// 数值范围：uniform 声明 `// @range min max` 时用声明的范围（LLM 可指定），
// 否则沿用旧 FLOAT_SLIDER 规则 [min(0,dv), max(1,dv)]；float 无初始化器默认 1.0
void rangeFor(const glsl::Param& p, int comp, float* lo, float* hi) {
    if (p.hasRange) {
        *lo = p.rmin;
        *hi = p.rmax;
        // min>max 反写（如 `// @range 10 0`）：与面板同口径交换（client/shared/
        // uniformParser.js:166-172 在 mx < mn 时交换；uniformParser.cpp 解析层同款
        // 归一）——不交换则自绘滑条左右方向与面板相反（用户"拖了没反应/反着走"）。
        if (*lo > *hi) {
            const float t = *lo;
            *lo = *hi;
            *hi = t;
        }
        if (*lo == *hi) *hi = *lo + 1.0f;  // 防除零
        return;
    }
    float dv = 0.0f;
    if (p.type == glsl::ParamType::Float) {
        dv = p.hasDef ? p.def[0] : 1.0f;
    } else if (comp >= 0 && comp < kFloatsPerSlot && p.hasDef) {
        dv = p.def[comp];
    }
    *lo = (std::min)(0.0f, dv);
    *hi = (std::max)(1.0f, dv);
    if (*lo == *hi) *hi = *lo + 1.0f;  // 防除零
}

// 读取本实例**实际生效**的文件索引：身份名优先 —— 库增删导致位置位移后，实例仍
// 指向同一个文件（这正是"新增/删除效果后已有实例全乱套"的修复点）；名字缺失
//（v1 旧工程）时回退参数里的位置索引（与改动前一致）。
// 用 NoRescan 变体：本函数在 DRAW 热路径上被每帧每控件调用，不能触发目录重扫
//（列表新鲜度由渲染/快照路径负责，UI 读同一份 popupChoices）。
// 返回值 -1 = **身份名非空但查不到**（文件被删/改名）：不高亮任何行、不画槽位名，
// 与渲染侧的"透传"口径一致。此时若回退位置，就会高亮到**另一个文件**上 ——
// 那正是本次修复要消灭的"看着合法实则指错"。
int fileSelIndex(PF_InData* in_data, PF_ParamDef* params[]) {
    const int raw = InstanceFileIndex(nullptr, params);
    const std::string nm = InstanceShaderName(in_data, params);
    if (nm.empty()) return raw;                    // 未捕获身份 → 位置（旧行为）
    return indexForShaderNameNoRescan(nm);
}

// 读取本实例指定槽位的 uniform（uniforms 不取全局，而是本实例选中文件
// 的 per-file 缓存条目——多实例（不同 .glsl）各自的 ECW 控件按各自文件绘制）。
// 只拷贝 1 个 Param，避免每帧 DRAW × 32 控件全量拷贝 uniforms 列表——其
// std::string 成员会堆分配，是播放期 ECW 持续重绘的主要放大因素。
bool uniformAt(PF_InData* in_data, PF_ParamDef* params[], int slot, glsl::Param* out) {
    (void)in_data;
    const int idx = fileSelIndex(in_data, params);
    if (idx < 0) return false;   // 身份缺失（文件已删）：不画槽位名，避免显示成别的文件
    return shaderUniformAt(shaderPathForIndex(idx), slot, out);
}

// 本实例记住的 .glsl 是否已不在库中（与渲染侧 getShaderByIdentity 同口径：身份名
// 非空且按名解析不到；名字为空时按位置回退，不算丢失）。命中时 *nameOut = 记住的文件名。
// 使用 NoRescan 变体：DRAW 路径不触发目录重扫，列表新鲜度由渲染/快照路径维护。
bool lostShaderIdentity(PF_InData* in_data, PF_ParamDef* params[], std::string* nameOut) {
    const std::string nm = InstanceShaderName(in_data, params);
    // 判据单点在 uiNoticePolicy.h（空名不算丢失；indexForShaderNameNoRescan("") 直接 -1）
    if (!shaderFileLost(nm, indexForShaderNameNoRescan(nm))) return false;
    if (nameOut) *nameOut = nm;
    return true;
}

// —— PICA 套件进程级缓存 ——
// 自绘控件在播放/悬停时每帧被大量重绘（32 控件 × DRAW 事件），每次重复
// AEFX_AcquireSuite/AcquireDrawbotSuites 的开销显著。PICA 套件进程内稳定，
// 首次获取后常驻不释放（与 AE 宿主生命周期一致）。
struct UiSuites {
    bool drawbotReady = false;
    DRAWBOT_Suites drawbot;
    PFAppSuite6* app = nullptr;
    PF_EffectCustomUISuite1* cui = nullptr;
    PF_AdvAppSuite2* advApp = nullptr;   // 滚轮消费：PF_RefreshAllWindows 强制 ECW 重绘
};
UiSuites& uiSuites() {
    static UiSuites s;
    return s;
}
void ensureSuites(PF_InData* in_data, PF_OutData* out_data) {
    UiSuites& s = uiSuites();
    if (!s.app) {
        AEFX_AcquireSuite(in_data, out_data, kPFAppSuite, kPFAppSuiteVersion6,
                          nullptr, reinterpret_cast<void**>(&s.app));
    }
    if (!s.advApp) {
        AEFX_AcquireSuite(in_data, out_data, kPFAdvAppSuite, kPFAdvAppSuiteVersion2,
                          nullptr, reinterpret_cast<void**>(&s.advApp));
    }
    if (!s.cui) {
        AEFX_AcquireSuite(in_data, out_data, kPFEffectCustomUISuite, kPFEffectCustomUISuiteVersion1,
                          nullptr, reinterpret_cast<void**>(&s.cui));
    }
    if (!s.drawbotReady) {
        s.drawbotReady = (AEFX_AcquireDrawbotSuites(in_data, out_data, &s.drawbot) == PF_Err_NONE);
    }
}

// 拖拽状态打包进 continue_refcon[4]（DO_CLICK → DRAG 传递）
struct DragState {
    int slot;   // 槽位序号
    int comp;   // 分量（-1 = 无）
    float startVal;
    float startPx;
};
void packDrag(A_intptr_t* cr, const DragState& s) {
    cr[0] = static_cast<A_intptr_t>(s.slot);
    cr[1] = static_cast<A_intptr_t>(s.comp);
    std::memcpy(&cr[2], &s.startVal, sizeof(float));
    std::memcpy(&cr[3], &s.startPx, sizeof(float));
}
DragState unpackDrag(const A_intptr_t* cr) {
    DragState s;
    s.slot = static_cast<int>(cr[0]);
    s.comp = static_cast<int>(cr[1]);
    std::memcpy(&s.startVal, &cr[2], sizeof(float));
    std::memcpy(&s.startPx, &cr[3], sizeof(float));
    return s;
}

// UPDATE_NOW 节流：距上次 ≥kUpdateNowInterval 才放行（拖拽路径用，见 finishChange）
bool updateNowDue() {
    static auto s_last = std::chrono::steady_clock::now();
    const auto now = std::chrono::steady_clock::now();
    if (now - s_last < std::chrono::milliseconds(33)) return false;
    s_last = now;
    return true;
}

// 事件后统一收尾：标记已处理 + 重绘控件区 + 声明值变更。
// throttleUpdateNow：拖拽路径传 true —— PF_EO_UPDATE_NOW 会触发 AE 立即重渲染
// （含 GPU 渲染），拖动中每帧都触发会阻塞 UI 线程造成"拖拽延迟"；节流到
// ~30Hz（invalidate 不节流，滑块跟手），渲染略滞后但对拖拽体验更跟手。
// 前置声明（定义见下方「槽位值访问」段）
void markSlotChanged(PF_ParamDef* params[], int slot);

void finishChange(PF_InData* in_data, PF_OutData* out_data, PF_EventExtra* extra,
                  PF_ParamDef* params[], int index, bool throttleUpdateNow = false) {
    PF_Rect inval = extra->effect_win.current_frame;
    ensureSuites(in_data, out_data);
    PFAppSuite6* app = uiSuites().app;
    if (app) {
        app->PF_InvalidateRect(extra->contextH, &inval);
    }
    extra->evt_out_flags |= PF_EO_HANDLED_EVENT;
    if (!throttleUpdateNow || updateNowDue()) {
        extra->evt_out_flags |= PF_EO_UPDATE_NOW;
    }
    // 槽位由 4 个原生分量参数承载：逐分量置变更标志才能完整持久化整槽
    const int slot = slotFromIndex(index);
    if (slot >= 0) {
        markSlotChanged(params, slot);
    } else if (params && params[index]) {
        params[index]->uu.change_flags |= PF_ChangeFlag_CHANGED_VALUE;
    }
}

// —— Drawbot 绘制辅助 ——
DRAWBOT_ColorRGBA rgba(float r, float g, float b, float a = 1.0f) {
    DRAWBOT_ColorRGBA c;
    c.red = r; c.green = g; c.blue = b; c.alpha = a;
    return c;
}

// —— 自绘控件统一配色（subtle，与 AE 暗色面板协调）——
namespace col {
const DRAWBOT_ColorRGBA Track   = rgba(0.24f, 0.24f, 0.26f);  // 轨道/底色
const DRAWBOT_ColorRGBA Fill    = rgba(0.38f, 0.57f, 0.86f);  // 填充/选中（淡蓝）
const DRAWBOT_ColorRGBA Thumb   = rgba(0.88f, 0.89f, 0.92f);  // 滑块
const DRAWBOT_ColorRGBA Text    = rgba(0.76f, 0.77f, 0.81f);  // 主要文本
const DRAWBOT_ColorRGBA TextDim = rgba(0.44f, 0.45f, 0.48f);  // 次要/占位
const DRAWBOT_ColorRGBA Hover   = rgba(0.29f, 0.41f, 0.58f);  // 悬停/编辑底
// 文件丢失提醒：橙字 + 淡橙底（AE 暗底上可读，与错误占位帧的品红区分）
const DRAWBOT_ColorRGBA Warn    = rgba(1.00f, 0.68f, 0.28f);
const DRAWBOT_ColorRGBA WarnBg  = rgba(0.32f, 0.21f, 0.10f);
} // namespace col

// —— 文件选择器状态（定义在前：handleCursor 计算悬停行需要）——
// 选中索引真相源为尾部隐藏原生参数 kIdxFileIndexParam
//（见 fileSelIndex）；选择器仍为 ARBITRARY_DATA，其 handle f[1] = 展开、
// f[2] = 滚动等纯 UI 会话态（不再受「DRAW/ADJUST_CURSOR 上下文写参数不生效」
// 限制——索引已走原生参数，见旧注释）。
// s_selHoverRow 仍为进程级：瞬态/单鼠标，同一时刻只有一处悬停高亮，无串扰。
static int  s_selHoverRow = -1;   // 展开时鼠标悬停的文件行（-1 = 无）

// 读取本实例选择器状态：选中索引取尾部隐藏原生参数 kIdxFileIndexParam（真相源），
// 展开状态仍取选择器 ARBITRARY handle f[1]（纯 UI 会话态，per-instance 且随工程
// 持久化，跨事件上下文可靠——不用内存 map，实测 EVENT 写 / UPDATE_PARAMS_UI 读
// 会取不到同一份）。缺省折叠。
bool fileSelState(PF_InData* in_data, PF_ParamDef* params[], int* idx, bool* expanded) {
    (void)in_data;   // PF_LOCK_HANDLE 宏需要 in_data 在作用域内
    if (idx) *idx = fileSelIndex(in_data, params);
    if (expanded) *expanded = false;
    if (!params || !params[kIdxFileSelector] || !params[kIdxFileSelector]->u.arb_d.value) return false;
    PF_ParamDef* sel = params[kIdxFileSelector];
    const float* v = reinterpret_cast<const float*>(PF_LOCK_HANDLE(sel->u.arb_d.value));
    if (!v) return false;
    if (expanded) *expanded = (v[1] != 0.0f);
    PF_UNLOCK_HANDLE(sel->u.arb_d.value);
    return true;
}

// 写本实例选择器展开状态（handle f[1]）。仅在 DO_CLICK 等有效事件上下文调用
//（实测 DRAW/ADJUST_CURSOR 上下文写该句柄不生效）。
void setFileSelExpanded(PF_InData* in_data, PF_ParamDef* params[], bool expanded) {
    host::rawTrace("fsel-setexp", expanded ? 1 : 0);   // 诊断
    if (!params || !params[kIdxFileSelector] || !params[kIdxFileSelector]->u.arb_d.value) return;
    PF_ParamDef* sel = params[kIdxFileSelector];
    float* v = reinterpret_cast<float*>(PF_LOCK_HANDLE(sel->u.arb_d.value));
    if (!v) return;
    v[1] = expanded ? 1.0f : 0.0f;
    PF_UNLOCK_HANDLE(sel->u.arb_d.value);
}

// —— 文件选择器滚动（文件数 > kFileSelMaxRows，偏移存 handle f[2]）——
void resetFileSelWheelDelta();   // 定义见下方滚轮目标区
int fileSelScrollOf(PF_InData* in_data, PF_ParamDef* params[], int n) {
    (void)in_data;
    const int maxScroll = (std::max)(0, n - kFileSelMaxRows);
    if (maxScroll <= 0) return 0;
    if (!params || !params[kIdxFileSelector] || !params[kIdxFileSelector]->u.arb_d.value) return 0;
    PF_ParamDef* sel = params[kIdxFileSelector];
    const float* v = reinterpret_cast<const float*>(PF_LOCK_HANDLE(sel->u.arb_d.value));
    if (!v) return 0;
    const float s = v[2];
    PF_UNLOCK_HANDLE(sel->u.arb_d.value);
    if (!(s >= 0.0f && s <= 1000000.0f)) return 0;   // NaN/负/超界防御
    return (std::min)(static_cast<int>(s + 0.5f), maxScroll);
}

void setFileSelScroll(PF_InData* in_data, PF_ParamDef* params[], int scroll, int n) {
    (void)in_data;
    if (!params || !params[kIdxFileSelector] || !params[kIdxFileSelector]->u.arb_d.value) return;
    const int maxScroll = (std::max)(0, n - kFileSelMaxRows);
    PF_ParamDef* sel = params[kIdxFileSelector];
    float* v = reinterpret_cast<float*>(PF_LOCK_HANDLE(sel->u.arb_d.value));
    if (!v) return;
    v[2] = static_cast<float>((std::max)(0, (std::min)(scroll, maxScroll)));
    PF_UNLOCK_HANDLE(sel->u.arb_d.value);
    // 句柄写入必须配 CHANGED_VALUE 才会被 AE 保留（否则下一次事件读回旧值——
    // 滚轮消费发生在 UPDATE_PARAMS_UI，该上下文 change_flags 有效，见 AE_Effect.h:2250）
    sel->uu.change_flags |= PF_ChangeFlag_CHANGED_VALUE;
    resetFileSelWheelDelta();   // 非滚轮路径接管滚动：清掉滚轮累计，避免叠加
}

// 滚动条几何（展开态、n > kFileSelMaxRows 时由绘制/点击/拖拽共用）
struct SelScrollGeom {
    int trackTop;    // 滑轨顶部 y（上箭头之下）
    int trackH;      // 滑轨高（两箭头之间）
    int thumbH;      // 滑块高（可点击性下限钳制）
    int scrollMax;   // 最大滚动偏移（n - 可见行数）
};
SelScrollGeom selScrollGeom(const PF_Rect& f, int n) {
    SelScrollGeom g{};
    const int rows = (std::min)(n, kFileSelMaxRows);
    const int listTop = f.top + kFileSelHeaderH;
    g.trackTop = listTop + kSelScrollArrowH;
    g.trackH = rows * kFileSelRowH - kSelScrollArrowH * 2;
    g.scrollMax = (std::max)(0, n - kFileSelMaxRows);
    const float ratio = (n > 0) ? (float)kFileSelMaxRows / (float)n : 1.0f;
    g.thumbH = (std::max)(kSelScrollThumbMin, (int)((float)g.trackH * ratio + 0.5f));
    return g;
}
// 滚动偏移 → 滑块顶部 y（scroll 已钳制时滑块恒在轨道内）
int selThumbTop(const SelScrollGeom& g, int scroll) {
    if (g.scrollMax <= 0 || g.trackH <= g.thumbH) return g.trackTop;
    const float t = (float)scroll / (float)g.scrollMax;
    return g.trackTop + (int)((float)(g.trackH - g.thumbH) * t + 0.5f);
}

// —— 数值输入：非模态 Win32 EDIT 子窗口 ——
// ECW 自绘控件收不到 KEYDOWN（AE 宿主不把键盘焦点路由给 PF_PUI_CONTROL，无官方
// 焦点 API），就地 KEYDOWN 输入方案不可行；模态对话框（DialogBoxIndirectParamW）
// 会运行嵌套消息循环 → AE 重入 → contextH 失效崩溃（8-06 已实证）。
// 业界标准做法（Video Copilot/Red Giant 等）：点击数值区 → 创建非模态 EDIT 子窗口
// （WS_POPUP 浮动在数字框位置）。它**不运行任何消息循环**，消息由 AE 主循环正常
// 派发，键盘输入由 Windows 直接路由给编辑框（不经过 PF_Cmd_EVENT → 无重入）。
// 回车/Esc/失焦在子类化 WndProc 中处理；提交写参数经 IDLE 完成（WndProc 内无
// AE 事件上下文，不能直接 InvalidateRect/写 params）。
//
// 重绘约束（AE 23.5 实测）：PF_InvalidateRect 仅 DO_CLICK/DRAG/IDLE 合法，
// KEYDOWN 非法。编辑框打开期间不触发 AE 重绘（独立窗口自绘），提交/取消后经
// IDLE 重绘恢复显示实际值。
struct EditState {
    bool active = false;      // 编辑框是否打开
    int  slot  = -1;          // 正在编辑的槽位
    int  comp  = 0;           // 正在编辑的分量（滑块=0）
    PF_Rect rect{};           // 进入编辑态时控件矩形（IDLE 用它定位重绘）
    bool dirty = false;       // 状态变化，待 IDLE 触发重绘（恢复显示实际值）
    bool pendingCommit = false; // 待提交（WndProc 解析后置位，AE 事件内写参数）
    bool pendingPersist = false; // 值已写句柄但尚未在有效事件设 change_flags（需持久化）
    float pendingVal = 0.0f;    // 待写入的值
    DWORD openTick = 0;       // 编辑框打开时刻（GetTickCount，DEACTIVATE 时序防护）
    HWND owner = nullptr;     // 编辑框父/宿主窗口（DO_CLICK 时活动窗口，销毁后 InvalidateRect 触发 ECW 重绘）
};

// —— 编辑会话状态按实例隔离 ——
// 若 static EditState s_edit（含进程级的合成点击抑制标记与数值框落点家族）为
// 进程级单例：A 实例打开编辑框输入的值（pendingVal/pendingCommit）由 B 实例的
// DO_CLICK/DRAW/IDLE 先到达时，flushPendingCommit 用 **B 的** params 写入 B 的
// 同号槽位并置 CHANGED_VALUE 持久化（与 N1 选择器串扰同族）。迁为按
// effect_ref（实例存活期间稳定的 AE 不透明句柄，仅作实例身份比较，不解引用）
// 索引的 per-instance 条目。真正进程级共享的成员及理由：
//   - s_editHwnd/s_editOldProc/s_editFont：编辑框窗口本身——同一时刻进程内
//     最多一个 Win32 EDIT 浮窗（openValueEdit 的双保险设计），是窗口物理单例；
//   - s_drawbotFontSize：Drawbot 默认字号，进程级渲染设置，与实例无关。
// s_editWndOwnerRef 记录编辑框窗口当前归属实例：WndProc 提交（commitValueEdit）
// 时无 AE 事件上下文，用它路由到正确条目。
struct EditInstanceState {
    EditState edit;
    // 合成 DO_CLICK 抑制标记（原 s_suppressClick/s_suppressClickTick）：Enter
    // 提交后注入的合成点击仅用于触发**归属实例** handleClick 补 change_flags
    // 持久化，不应重开编辑框/触发控件动作。仅抑制注入后 200ms 内的那次
    // DO_CLICK，避免用户更快到达的真实点击被误判（导致"第二次点击打不开
    // 编辑框"）。
    bool  suppressClick = false;
    DWORD suppressClickTick = 0;
    // 数值框屏幕中心（原 s_valueBoxC[XY]/s_valueBoxValid，Enter 提交后合成
    // 点击的落点）。openValueEdit 时按 DPI 换算存入，保证注入的点击**确定
    // 落在归属实例的数值框上**——若沿用"当前光标位置"，用户按 Enter 时光标
    // 未必停在数值框上，点击会落到 ECW 外/其他控件 → 不产生 DO_CLICK →
    // CHANGED_VALUE 永不落盘 → 值回滚。
    int  valueBoxCX = 0;
    int  valueBoxCY = 0;
    bool valueBoxValid = false;
    // openValueEdit 时刻的宿主窗口屏幕矩形——Enter 立即路径注入
    // 合成点击前按宿主当前矩形与之比对重算落点（窗口整体位移跟随），再做
    // 延迟路径同款落点校验（宿主矩形内 + WindowFromPoint 根一致）；失配
    //（宿主已关/被其他窗口覆盖/落点漂出）取消注入，不向错误目标注入点击。
    RECT ownerOpenRect{};
    bool ownerRectValid = false;
    // 会话最近写入时刻：实例销毁后无人消费的 pending 在 effect_ref 地址被
    // 新实例复用时防误读（超时视为悬空丢弃，见 flushPendingCommit）
    DWORD lastTouch = 0;
};
static std::map<void*, EditInstanceState> s_editByInstance;
// 编辑框窗口（Win32 单例）当前归属实例的 effect_ref；窗口销毁后置空
static void* s_editWndOwnerRef = nullptr;

// 按 effect_ref 取编辑状态条目（不存在返回 nullptr——消费方视为无编辑会话）
static EditInstanceState* editStateForRef(void* ref) {
    if (!ref) return nullptr;
    auto it = s_editByInstance.find(ref);
    return it == s_editByInstance.end() ? nullptr : &it->second;
}
static EditInstanceState* editStateOf(PF_InData* in_data) {
    return in_data ? editStateForRef(in_data->effect_ref) : nullptr;
}

// 编辑框窗口句柄 + 原子类化前 WndProc（WM_KILLFOCUS/回车/Esc 拦截）
static HWND    s_editHwnd    = nullptr;
static WNDPROC s_editOldProc = nullptr;
static HFONT   s_editFont    = nullptr;   // 高 DPI 自建字体（需在关闭时 DeleteObject）
// Drawbot 默认字号（逻辑像素），绘画时记录，供编辑框创建字体时对齐默认框字号
static float   s_drawbotFontSize = 0.0f;

// 取证日志：编辑框提交→持久化关键路径写入 effects/ui_debug.log（供排查，
// 不污染 error.log——后者在插件重载时会被清空）。仅写关键决策点，低频率。
// 路径为 UTF-8：窄 ofstream 按 ANSI(GBK) 解释，含中文的数据目录打不开 → 宽路径
// 体积上限：1MB 保留尾部 128KB；上限缺失时虽低频，但数值框/点击
// 每次交互都追加，且从不清理（实测攒到 61KB 后一直留着）。
static constexpr unsigned long long kUiDebugMaxBytes  = 1ull * 1024 * 1024;
static constexpr unsigned long long kUiDebugKeepBytes = 128ull * 1024;
void uiDebug(const char* fmt, ...) {
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    const std::string path = effectsDirPath() + "\\ui_debug.log";
    rotateLogFileKeepTail(path, kUiDebugMaxBytes, kUiDebugKeepBytes);
    std::ofstream f(std::filesystem::path(glsl::utf8ToWide(path)), std::ios::app);
    if (f) {
        // 时间戳在写入端统一加：调用方只传消息体，避免每个调用点各自拼（会漏、会不一致）
        char ts[24];
        host::isoLocalStamp(ts, sizeof(ts));
        f << ts << buf << std::endl;
    }
}

// 编辑态重绘：仅在 DO_CLICK / DRAG / IDLE 等合法上下文调用（KEYDOWN 中
// 调用 PF_InvalidateRect 会让 AE 弹 "内部验证故障"，见上）。配合
// PF_EO_UPDATE_NOW 事件返回后立即重绘，消除等 IDLE 的输入延迟。
// 重绘矩形取**本实例**编辑会话的 rect（IDLE 是全局事件，会派发给
// 所有实例，须各自用各自的条目定位）。
void invalidateEditNow(PF_InData* in_data, PF_OutData* out_data, PF_EventExtra* extra) {
    ensureSuites(in_data, out_data);
    EditInstanceState* st = editStateOf(in_data);
    if (uiSuites().app && st) {
        uiSuites().app->PF_InvalidateRect(extra->contextH, &st->edit.rect);
    }
    extra->evt_out_flags |= PF_EO_HANDLED_EVENT | PF_EO_UPDATE_NOW;
}

// 编辑态是否对应指定槽位/分量（绘制时判断是否画编辑缓冲）
// 只认**本实例**的编辑会话——读进程级 s_edit 会导致 A 打开编辑框时
// B 的同号控件也被画成编辑态高亮（串扰表现之一）。
bool editingThis(PF_InData* in_data, int slot, int comp) {
    const EditInstanceState* st = editStateOf(in_data);
    return st && st->edit.active && st->edit.slot == slot && st->edit.comp == comp;
}

// fillRectPx 定义在文件后部，圆角/圆形辅助先引用 → 前置声明
void fillRectPx(DRAWBOT_Suites* dbs, DRAWBOT_SurfaceRef surface, DRAWBOT_SupplierRef supplier,
                int l, int t, int r, int b, const DRAWBOT_ColorRGBA* color);

// 圆角矩形路径填充：r 为圆角半径（用 AddArc 四角拼接，Drawbot 无原生圆角矩形）。
// 用一条 path 一次 FillPath（比多次 fillRect 干净，抗锯齿一致）。
void fillRoundRectPx(DRAWBOT_Suites* dbs, DRAWBOT_SurfaceRef surface, DRAWBOT_SupplierRef supplier,
                     int l, int t, int r, int b, float rad, const DRAWBOT_ColorRGBA* color) {
    if (r <= l || b <= t) return;
    rad = (std::min)(rad, (std::min)((r - l) / 2.0f, (b - t) / 2.0f));
    if (rad <= 0.5f) { fillRectPx(dbs, surface, supplier, l, t, r, b, color); return; }
    DRAWBOT_PathRef path = nullptr;
    DRAWBOT_BrushRef brush = nullptr;
    if (dbs->supplier_suiteP->NewPath(supplier, &path) != PF_Err_NONE || !path) return;
    if (dbs->supplier_suiteP->NewBrush(supplier, color, &brush) != PF_Err_NONE) {
        dbs->supplier_suiteP->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(path));
        return;
    }
    const float L = static_cast<float>(l), T = static_cast<float>(t);
    const float R = static_cast<float>(r), B = static_cast<float>(b);
    DRAWBOT_PointF32 c;
    dbs->path_suiteP->MoveTo(path, L + rad, T);
    dbs->path_suiteP->LineTo(path, R - rad, T);
    c.x = R - rad; c.y = T + rad; dbs->path_suiteP->AddArc(path, &c, rad, -90.0f, 90.0f);   // 右上角
    dbs->path_suiteP->LineTo(path, R, B - rad);
    c.x = R - rad; c.y = B - rad; dbs->path_suiteP->AddArc(path, &c, rad, 0.0f, 90.0f);     // 右下角
    dbs->path_suiteP->LineTo(path, L + rad, B);
    c.x = L + rad; c.y = B - rad; dbs->path_suiteP->AddArc(path, &c, rad, 90.0f, 90.0f);    // 左下角
    dbs->path_suiteP->LineTo(path, L, T + rad);
    c.x = L + rad; c.y = T + rad; dbs->path_suiteP->AddArc(path, &c, rad, 180.0f, 90.0f);   // 左上角
    dbs->path_suiteP->Close(path);
    dbs->surface_suiteP->FillPath(surface, brush, path, kDRAWBOT_FillType_Default);
    dbs->supplier_suiteP->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(brush));
    dbs->supplier_suiteP->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(path));
}

// 圆形填充（滑块 thumb 等）
void fillCirclePx(DRAWBOT_Suites* dbs, DRAWBOT_SurfaceRef surface, DRAWBOT_SupplierRef supplier,
                  int cx, int cy, float rad, const DRAWBOT_ColorRGBA* color) {
    DRAWBOT_PathRef path = nullptr;
    DRAWBOT_BrushRef brush = nullptr;
    if (dbs->supplier_suiteP->NewPath(supplier, &path) != PF_Err_NONE || !path) return;
    if (dbs->supplier_suiteP->NewBrush(supplier, color, &brush) != PF_Err_NONE) {
        dbs->supplier_suiteP->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(path));
        return;
    }
    DRAWBOT_PointF32 c;
    c.x = static_cast<float>(cx); c.y = static_cast<float>(cy);
    dbs->path_suiteP->MoveTo(path, c.x + rad, c.y);
    dbs->path_suiteP->AddArc(path, &c, rad, 0.0f, 360.0f);
    dbs->path_suiteP->Close(path);
    dbs->surface_suiteP->FillPath(surface, brush, path, kDRAWBOT_FillType_Default);
    dbs->supplier_suiteP->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(brush));
    dbs->supplier_suiteP->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(path));
}

void fillRect(DRAWBOT_Suites* dbs, DRAWBOT_SurfaceRef surface, DRAWBOT_SupplierRef supplier,
              const DRAWBOT_RectF32* r, const DRAWBOT_ColorRGBA* color) {
    DRAWBOT_PathRef path = nullptr;
    DRAWBOT_BrushRef brush = nullptr;
    if (dbs->supplier_suiteP->NewPath(supplier, &path) != PF_Err_NONE || !path) return;
    if (dbs->supplier_suiteP->NewBrush(supplier, color, &brush) != PF_Err_NONE) {
        dbs->supplier_suiteP->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(path));
        return;
    }
    dbs->path_suiteP->AddRect(path, r);
    dbs->surface_suiteP->FillPath(surface, brush, path, kDRAWBOT_FillType_Default);
    dbs->supplier_suiteP->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(brush));
    dbs->supplier_suiteP->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(path));
}

void fillRectPx(DRAWBOT_Suites* dbs, DRAWBOT_SurfaceRef surface, DRAWBOT_SupplierRef supplier,
                int l, int t, int r, int b, const DRAWBOT_ColorRGBA* color) {
    DRAWBOT_RectF32 rect;
    rect.left = static_cast<float>(l) + 0.5f;
    rect.top = static_cast<float>(t) + 0.5f;
    rect.width = static_cast<float>(r - l);
    rect.height = static_cast<float>(b - t);
    fillRect(dbs, surface, supplier, &rect, color);
}

// UTF-8 → UTF-16（BMP）：drawText 只按字节转码（仅 ASCII 正确），
// 文件选择器需要 ▶/▼/↻/… 等非 ASCII 字形，做最小解码（4 字节代理对降级为 '?'）。
void utf8ToWide16(const char* s, DRAWBOT_UTF16Char* wbuf, int cap) {
    int out = 0;
    const unsigned char* p = reinterpret_cast<const unsigned char*>(s);
    while (*p && out < cap - 1) {
        unsigned int cp = 0;
        if ((*p & 0x80) == 0) {
            cp = *p++;
        } else if ((*p & 0xE0) == 0xC0 && (p[1] & 0xC0) == 0x80) {
            cp = ((*p & 0x1F) << 6) | (p[1] & 0x3F); p += 2;
        } else if ((*p & 0xF0) == 0xE0 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80) {
            cp = ((*p & 0x0F) << 12) | ((p[1] & 0x3F) << 6) | (p[2] & 0x3F); p += 3;
        } else {
            cp = '?'; ++p;
        }
        wbuf[out++] = static_cast<DRAWBOT_UTF16Char>(cp);
    }
    wbuf[out] = 0;
}

// 绘制一行文本（入参 UTF-8）。trunc/truncWidth 非默认值时按可用宽度省略；默认不截断。
void drawText(DRAWBOT_Suites* dbs, DRAWBOT_SurfaceRef surface, DRAWBOT_SupplierRef supplier,
              int x, int y, const char* text, const DRAWBOT_ColorRGBA* color,
              DRAWBOT_TextAlignment align = kDRAWBOT_TextAlignment_Left,
              DRAWBOT_TextTruncation trunc = kDRAWBOT_TextTruncation_None,
              float truncWidth = 0.0f) {
    DRAWBOT_FontRef font = nullptr;
    DRAWBOT_BrushRef brush = nullptr;
    if (dbs->supplier_suiteP->NewBrush(supplier, color, &brush) != PF_Err_NONE) return;
    float size = 0.0f;
    dbs->supplier_suiteP->GetDefaultFontSize(supplier, &size);
    if (size > 0.0f) s_drawbotFontSize = size;   // 缓存，供编辑框字体对齐
    if (dbs->supplier_suiteP->NewDefaultFont(supplier, size, &font) != PF_Err_NONE) {
        dbs->supplier_suiteP->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(brush));
        return;
    }
    DRAWBOT_UTF16Char wbuf[320];
    utf8ToWide16(text, wbuf, 320);
    DRAWBOT_PointF32 origin;
    origin.x = static_cast<float>(x);
    origin.y = static_cast<float>(y);
    dbs->surface_suiteP->DrawString(surface, brush, font, wbuf, &origin,
                                    align, trunc, truncWidth);
    dbs->supplier_suiteP->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(font));
    dbs->supplier_suiteP->ReleaseObject(reinterpret_cast<DRAWBOT_ObjectRef>(brush));
}

// 数字框/编辑框初始值显示：固定两位小数。
void formatValue(char* buf, size_t n, float v) { std::snprintf(buf, n, "%.2f", v); }

// 编辑框（点击数值打开）初始值：保留更高精度（5 位小数），让用户在此输入/微调
// 五位小数；默认框仍用 formatValue（两位小数）显示。二者分离：默认框只读展示，
// 编辑框是输入入口，需保留用户可编辑的完整精度。
void formatValueEdit(char* buf, size_t n, float v) { std::snprintf(buf, n, "%.5f", v); }

// —— 各控件绘制 ——
// 胶囊轨道 + 填充 + 圆形滑块（Slider 与 vec4 alpha 滑条共用）
void drawTrack(DRAWBOT_Suites* dbs, DRAWBOT_SurfaceRef surface, DRAWBOT_SupplierRef supplier,
               int trackL, int trackW, int cy, float t) {
    constexpr int kTrackH = 4;      // 轨道高
    constexpr int kThumbR = 4;      // 滑块半径
    const int top = cy - kTrackH / 2;
    // 轨道（胶囊，圆角 2px）
    fillRoundRectPx(dbs, surface, supplier, trackL, top, trackL + trackW, top + kTrackH,
                    2.0f, &col::Track);
    // 已填充部分（淡蓝，胶囊）
    const int fillW = static_cast<int>(t * trackW);
    if (fillW > 0) {
        fillRoundRectPx(dbs, surface, supplier, trackL, top, trackL + fillW, top + kTrackH,
                        2.0f, &col::Fill);
    }
    // 滑块（圆形）
    const int thumbX = trackL + static_cast<int>(t * trackW);
    fillCirclePx(dbs, surface, supplier, thumbX, cy, static_cast<float>(kThumbR), &col::Thumb);
}

void drawSlider(DRAWBOT_Suites* dbs, DRAWBOT_SurfaceRef surface, DRAWBOT_SupplierRef supplier,
                const PF_Rect& f, const glsl::Param& p, float v, float lo, float hi,
                bool editing = false) {
    const int h = f.bottom - f.top;
    const int trackL = f.left + kInset;
    const int trackR = sliderTrackR(f);
    // 拉条宽度不得超过可用空间（trackR - trackL），否则会侵入右侧输入框区域
    const int trackW = (std::max)(1, trackR - trackL);
    const int cy = f.top + h / 2;
    const float t = clampf((v - lo) / (hi - lo), 0.0f, 1.0f);
    drawTrack(dbs, surface, supplier, trackL, trackW, cy, t);

    // 数值输入框：右侧 kTextWidth 段（框左缘 = 轨道右端 + 净空，避免滑块在最大值时
    // 压到边框）。矩形与命中判定、编辑浮窗同源（valueBoxRect）。
    const BoxRect bx = valueBoxRect(f, ControlKind::Slider, p, 0);
    // 编辑态：高亮边框 + 略深背景；非编辑态：细边框
    const DRAWBOT_ColorRGBA* border = editing ? &col::Fill : &col::TextDim;
    fillRoundRectPx(dbs, surface, supplier, bx.L, bx.T, bx.R, bx.B, 2.0f, border);
    // 背景挖洞（露出控件底色），让边框内看起来是独立输入区
    fillRoundRectPx(dbs, surface, supplier, bx.L + 1, bx.T + 1, bx.R - 1, bx.B - 1,
                    1.5f, &rgba(0.12f, 0.12f, 0.14f));

    // 数值文本（左对齐到输入框内左侧 12px，不贴最左；与编辑框 ES_LEFT 一致）。
    // 编辑态：不在此绘制文本/光标——真正的编辑由 Win32 EDIT 子窗口完成（见
    // openValueEdit），其浮在控件上方，内容与光标由系统绘制，跟手且无闪烁。
    if (editing) return;
    char buf[64];
    formatValue(buf, sizeof(buf), v);
    const int textLeft = bx.L + 4;   // 贴输入框左边缘（与编辑框 ES_LEFT 左边距一致，避免太靠右）
    const int textY = f.top + (h + 12) / 2 - 1;
    drawText(dbs, surface, supplier, textLeft, textY, buf, &col::Text,
             kDRAWBOT_TextAlignment_Left);
}

// —— 数值编辑框：Win32 非模态 EDIT 子窗口 ——
// WndProc（子类化）：回车提交 / Esc 取消 / 失焦提交。提交时只把解析结果
// 存入 s_edit（pendingCommit/pendingVal），实际写参数 + InvalidateRect 交
// IDLE 完成——WndProc 里没有 AE 事件上下文，直接调 PF API 会越界崩溃。
static void closeValueEdit();

// 当前 ECW 所在窗口的 DPI 缩放系数（200% 屏 = 2.0）。
// AE ECW 的 current_frame / screen_point 是逻辑坐标（DIP），而 CreateWindowExW /
// GetCursorPos 使用物理像素；非 100% 缩放下二者必须换算，否则编辑浮窗错位。
static float dpiScale() {
    float s = 1.0f;
    HWND hwnd = GetActiveWindow();
    if (HDC hdc = GetDC(hwnd)) {
        const int lpx = GetDeviceCaps(hdc, LOGPIXELSX);
        ReleaseDC(hwnd, hdc);
        if (lpx > 0) s = static_cast<float>(lpx) / 96.0f;
    }
    return s;
}

// —— 文件选择器中键滚轮（WH_MOUSE_LL 低级钩子）——
// AE custom UI 事件模型没有滚轮事件（PF_Event 全集仅 DO_CLICK/DRAG/
// ADJUST_CURSOR/KEYDOWN；PF_StylusEventInfo.stylus_wheelF 仅触控笔），
// 滚轮消息默认由 ECW 窗口消费（表现为滚整个参数面板）。用 WH_MOUSE_LL 在
// 输入驱动层拦截滚轮：光标位于本实例选择器屏幕矩形内 → 累计待滚行数并吃掉
// 输入（面板不滚）；否则透传（面板正常滚动）。
// 为何不用普通 WH_MOUSE：其回调仅在鼠标消息**经 GetMessage/PeekMessage 出队**
// 时触发，而现代 Windows 输入栈的 WM_MOUSEWHEEL 常由系统 SendMessage 直接
// 投递焦点窗口、不经队列——普通钩子根本看不到。
// WH_MOUSE_LL 在原始输入层拦截（无论投递方式），回调经输入线程中转在**安装
// 线程的消息循环**里执行（= AE 主线程），与事件回调同线程无竞态。
// 写参数 handle 必须在 AE 事件回调内完成——非事件上下文 handle 可能被 AE
// 重建，直接写会访问已释放内存（与编辑框提交同一约束，见 commitValueEdit
// 注释）——故钩子只排队，由随后的 IDLE/ADJUST_CURSOR 事件应用
// （handleIdle / handleCursor → selWheelApplyIdle）。
// 回调性能约束：LL 钩子对全系统每次鼠标事件触发（含其他应用内移动），输入
// 线程同步等待——只做消息号快拒 + MSLLSTRUCT.pt 矩形比较（纯内存，零系统
// 调用），且仅在选择器展开且有滚动条期间挂钩。
// 屏幕矩形映射：ADJUST_CURSOR 的 screen_point（ECW 客户区逻辑坐标）与同刻
// GetCursorPos（物理像素）给出仿射基准 screen = base + client×scale；悬停期间
// 每次移动刷新（面板滚动导致控件位移后映射仍准确）。
struct SelWheelTarget {
    void*    effectRef;   // 归属实例（in_data->effect_ref；不稳定，仅日志/兜底用）
    host::SelWheelRect clientRect;  // 控件矩形（ECW 客户区逻辑坐标）——稳定身份
    RECT     screen;      // 控件屏幕矩形（物理像素，钩子命中判定用）
    bool     screenValid; // 展开点击校准前忽略滚轮（无矩形可比）
    HWND     calibRoot = nullptr;   // 校准时刻 WindowFromPoint 命中的根窗口
    DWORD    lastSeen = 0;          // 最近一次绘制/悬停/命中刷新时刻（超时修剪依据）
    int      wheelDelta = 0;        // 滚轮累计偏移（插件侧保存——DRAW 内写 handle 不生效）
};
static std::vector<SelWheelTarget> s_selWheelTargets;
// 待滚条目。effect_ref 实测不稳定（同一控件在不同 DRAW 间给不同 ref），故同时记下
// 命中时的控件矩形：消费时 ref 或矩形任一命中即认为属于该选择器。
// pending 记 lastSeen（入队时刻）并与目标表同口径超时修剪——实例 A 的
// ECW 关闭时按 ref 剔除会因 ref 抖动失败，pending 幸存后会被下一个实例 B 的
// UPDATE_PARAMS_UI 消费（打开 B 的列表即被滚过若干行）。消费点与钩子修剪都按
// kSelWheelTargetStaleMs 丢弃超时条目（目标表变空时整队列一并清）。
struct SelWheelPending {
    void*   effectRef;
    host::SelWheelRect clientRect;   // 命中时控件矩形（与目标同口径，可跨 ref 变化匹配）
    int     delta;   // 有符号行数累计
    DWORD   lastSeen = 0;   // 入队时刻（超时修剪依据，GetTickCount 口径）
};
static std::vector<SelWheelPending> s_selWheelPending;
// 目标表/待滚队列被两个线程访问：AE 主线程（绘制/悬停/消费）与钩子线程（回调）。
// 统一用 s_selWheelMutex 保护；钩子线程一律 try_lock（拿不到就放行事件，绝不
// 阻塞输入路径），主线程侧只在**叶子作用域**短暂持有（不得跨越会再取本锁的调用）。
// Win32 SRWLOCK 而非 std::mutex：本插件用 MSVC 14.51 构建，运行时链接的却是 AE
// 自带的 msvcp140 14.00.24210.0（Support Files 同名单实例），std::mutex 的布局/
// 初始化与该版本 _Mtx_lock 不兼容——实测加锁即空指针崩溃（0xC0000005 @
// msvcp140+0x18C34，selWheelConsumeImpl → _Mtx_lock）。与 effectState.h:21 的
// 既有纪律一致：DLL 内一律用 Win32 原生同步原语。
static SRWLOCK s_selWheelMutex = SRWLOCK_INIT;
// SRWLOCK 的 RAII 封装（替代 std::lock_guard / std::unique_lock(try_to_lock)，
// 语义与 effectState.h 的 CSLock 一致；主线程叶子作用域加锁，钩子线程 try 失败放行）。
struct SelWheelLock {
    SRWLOCK* lock;
    explicit SelWheelLock(SRWLOCK& l) : lock(&l) { AcquireSRWLockExclusive(lock); }
    ~SelWheelLock() { if (lock) ReleaseSRWLockExclusive(lock); }
    SelWheelLock(const SelWheelLock&) = delete;
    SelWheelLock& operator=(const SelWheelLock&) = delete;
};
struct SelWheelTryLock {
    SRWLOCK* lock;
    explicit SelWheelTryLock(SRWLOCK& l)
        : lock(TryAcquireSRWLockExclusive(&l) ? &l : nullptr) {}
    ~SelWheelTryLock() { if (lock) ReleaseSRWLockExclusive(lock); }
    bool owns() const { return lock != nullptr; }
    SelWheelTryLock(const SelWheelTryLock&) = delete;
    SelWheelTryLock& operator=(const SelWheelTryLock&) = delete;
};
// 清除滚轮累计偏移（滚动条点击/拖拽/行选中接管滚动时调用，避免与 handle 值叠加）。
// 前向声明在 setFileSelScroll 之前——那里会调用本函数。
void resetFileSelWheelDelta() {
    SelWheelLock lk(s_selWheelMutex);
    for (auto& t : s_selWheelTargets) t.wheelDelta = 0;
}
// 有效滚动偏移 = handle 偏移 + 该控件累计的滚轮偏移（DRAW 内写不进 handle，
// 见 selWheelApplyIdle 注释）。**所有读取"当前滚动位置"的地方都必须用它**
// （绘制、行命中、滚动条箭头/翻页/拖拽基准）——否则显示用 handle+wheelDelta、
// 命中判定用 handle，滚动后点击会选中"未滚动前那一行"（显示与实际错位）。
int effectiveFileSelScroll(PF_InData* in_data, PF_ParamDef* params[], int n, const PF_Rect& f) {
    int s = fileSelScrollOf(in_data, params, n);
    const host::SelWheelRect r = host::selWheelRectOf(f.left, f.top, f.right, f.bottom);
    SelWheelLock lk(s_selWheelMutex);
    for (const auto& t : s_selWheelTargets) {
        // 认同一目标统一走 Rect 口径（ref 不稳定，不得参与身份）
        if (host::selWheelRectEq(t.clientRect, r)) {
            const int maxScroll = (std::max)(0, n - kFileSelMaxRows);
            s = (std::max)(0, (std::min)(s + t.wheelDelta, maxScroll));
            break;
        }
    }
    return s;
}
static HHOOK s_selWheelHook = nullptr;
static HWND  s_selWheelOwner = nullptr;   // AE 主窗口（主线程缓存，仅日志用）
// —— 独立钩子线程 ——
// WH_MOUSE_LL 的回调在**安装线程**的消息循环里执行。装在 AE 主线程时：全系统
// 每次鼠标事件都要等 AE 主线程空闲才被处理，AE 一忙（选中图层触发重渲）就表现为
// 点击卡顿。改为在专用线程安装——回调在该轻量线程执行，AE 主线程不被占用，输入
// 延迟消失，滚轮功能保留；回调只排队（写 pending），应用仍在 AE 主线程事件内完成。
static HANDLE s_selWheelThread = nullptr;      // 专用钩子线程句柄
static DWORD  s_selWheelThreadId = 0;
static HANDLE s_selWheelReady = nullptr;       // 钩子装好（或安装失败）后置位
static std::atomic<float> s_selWheelDpiScale{1.0f};   // 主线程算好缓存（钩子线程 GetActiveWindow 为 null）
// 钩子线程自停请求。钩子回调里超时修剪清空目标后，线程不能 join 自己
//（会死锁在等待自身），只置位并 PostThreadMessage(WM_QUIT)；主线程下一次任何
// 滚轮表操作（登记/剔除）先 join+CloseHandle 回收，再按需重启。没有这个机制时
// 陈旧目标残留会让 WH_MOUSE_LL 钩子与线程活到 AE 会话结束（先前只在上层操作
// 发现 targets 空时才停）。
static std::atomic<bool> s_selWheelStopReq{false};
// 陈旧目标超时（ms）：lastSeen 由 DRAW/悬停/命中刷新；超过该时长且**本次滚轮未命中**
// 才视为陈旧（实例已折叠/已关窗但剔除失败）并修剪。修剪判定移到命中测试
// 之后——指针停在列表上不动、ECW 又无重绘时 lastSeen 会超时，但目标仍是活目标，
// 先修剪会删掉光标下的目标（代价是首档滚轮透传给面板一次）；现在命中即刷新
// 并消费，只有真正未命中才修剪。pending 同口径。阈值 3s 是折中：短到
// 关窗后残留不会吞掉用户太久，长到不会误删「ECW 开着但用户长时间没碰、指针也未
// 悬停」的活目标。
static constexpr DWORD kSelWheelTargetStaleMs = 3000;
static void selWheelStartHookThread();
static void selWheelStopHookThread();

// 滚轮链路诊断日志（节流 budget；AS_EFFECT_HOST_LOG=1 解除）——定位「拦截/校准/消费」
// 三段哪段失效用：wheel-hook（安装）、wheel-cb（回调收到）、wheel-miss（判定未中，
// 附光标与矩形）、wheel-hit（命中入队）、wheel-apply（事件上下文应用）。
static void wheelLog(const char* stage, long a, long b) {
    static const bool s_verbose = std::getenv("AS_EFFECT_HOST_LOG") != nullptr;
    // 只有高频 stage（cb/miss/hit）走共享预算节流；关键结论 stage（hook/selfcal/
    // calib2/consume-in/apply/apply2/refresh）不过节流——共享预算被 cb 耗尽后
    // 关键结论被吞（实测 300 条正好用尽，apply/apply2 是否发生无从判定），诊断失明。
    static LONG volatile s_budget = 300;
    const bool highFreq = (std::strcmp(stage, "cb") == 0 ||
                           std::strcmp(stage, "miss") == 0 ||
                           std::strcmp(stage, "miss-root") == 0 ||
                           std::strcmp(stage, "hit") == 0);
    if (!s_verbose && highFreq && InterlockedDecrement(&s_budget) < 0) return;
    // fopen 后端在 AE 运行期静默失效（见 errorLog.h 探针注释）——滚轮链路
    // 诊断改 Win32 直写，带时间戳
    SYSTEMTIME st; GetLocalTime(&st);
    char buf[112];
    int n = std::snprintf(buf, sizeof(buf), "%02d:%02d:%02d wheel-%s %ld %ld\n",
                          st.wHour, st.wMinute, st.wSecond, stage, a, b);
    if (n > 0) host::rawTraceLine(buf);
}

// 命中分支的 HWND 有效性判据注入（纯函数 selWheelHandleState 的 isWindowFn）。
// IsWindow 是纯 Win32 查询、可跨线程（钩子线程）安全调用（本头已含 windows.h；
// 文件内既有用法见 solveProgressTimerProc 的窗口守卫）；目标表存的是"校准时刻
// WindowFromPoint 命中的根窗口"，其销毁 = 该实例的 ECW 已关闭（或宿主窗口已换新）
// ——这正是"已死实例"的硬证据（见 selWheelPolicy.h 三态判据注释）。
static bool selWheelIsWindowFn(std::uintptr_t h) {
    return IsWindow(reinterpret_cast<HWND>(h)) != FALSE;
}

static LRESULT CALLBACK selWheelMouseProc(int nCode, WPARAM wp, LPARAM lp) {
    if (nCode != HC_ACTION || wp != WM_MOUSEWHEEL) {
        return CallNextHookEx(s_selWheelHook, nCode, wp, lp);
    }
    // 钩子线程一律 try_lock：主线程正在改目标/待滚时直接放行（绝不阻塞输入路径）。
    SelWheelTryLock lk(s_selWheelMutex);
    if (!lk.owns() || s_selWheelTargets.empty()) {
        return CallNextHookEx(s_selWheelHook, nCode, wp, lp);
    }
    const MSLLHOOKSTRUCT* m = reinterpret_cast<const MSLLHOOKSTRUCT*>(lp);
    const SHORT wdelta = static_cast<SHORT>(HIWORD(m->mouseData));
    if (wdelta == 0) return CallNextHookEx(s_selWheelHook, nCode, wp, lp);
    wheelLog("cb", m->pt.x, m->pt.y);
    // 陈旧修剪只能在**未命中**时执行（下方命中测试通过后直接消费并 return）。
    // 把它放在命中测试之前时：指针停在列表上不动 >3s（DRAW/悬停/命中都不刷新
    // lastSeen）时，下一格滚轮会先把光标下的**活目标**删掉 → 滚轮被放行给参数面板；
    // 目标表被清空还会置自停，之后无 DRAW 就持续失效。pending 同口径超时
    // 修剪，且目标表空时整队列一并清——防 A 实例 ECW 关闭（ref 抖动导致按 ref 剔除
    // 失败）的幸存 pending 被 B 实例的 UPDATE_PARAMS_UI 消费（打开 B 的列表即被滚
    // 过若干行）。返回 true = 已请求自停（WM_QUIT 已投递）。
    const auto pruneStaleMiss = [&](DWORD now) -> bool {
        auto& tv = s_selWheelTargets;
        const auto newEnd = host::selWheelPruneStale(tv.begin(), tv.end(), now, kSelWheelTargetStaleMs);
        if (newEnd != tv.end()) {
            wheelLog("prune", (long)(tv.end() - newEnd), (long)(newEnd - tv.begin()));
            tv.erase(newEnd, tv.end());
        }
        auto& pv = s_selWheelPending;
        const auto pEnd = host::selWheelPruneStale(pv.begin(), pv.end(), now, kSelWheelTargetStaleMs);
        if (pEnd != pv.end()) pv.erase(pEnd, pv.end());
        if (tv.empty()) {
            pv.clear();   // 目标表空 → 无归属的 pending 不得再被任何实例消费
            s_selWheelStopReq.store(true);
            wheelLog("prune-empty", 0, 0);
            PostThreadMessageW(GetCurrentThreadId(), WM_QUIT, 0, 0);
            return true;
        }
        return false;
    };
    // 自校准命中测试（不依赖 AE 事件锚点——工程恢复的展开态没有点击/
    // 悬停事件，screenValid 可能从未置位）：滚轮时光标必在某窗口上——
    // WindowFromPoint 命中 ECW 所属根（与登记实例校准根一致，无则取
    // 当前命中根为基准）时，ScreenToClient 把光标物理坐标转为 ECW 客户
    // 物理坐标，÷dpiScale 转客户逻辑坐标，直接与 clientRect 比较。
    {
        const HWND hit = WindowFromPoint(m->pt);
        const HWND hitRoot = hit ? GetAncestor(hit, GA_ROOT) : nullptr;
        const HWND calibRoot = s_selWheelTargets[0].calibRoot;
        if (!hit || !hitRoot) {   // 无窗口（罕见）：透传（未命中 → 允许修剪收敛）
            wheelLog("miss-root", m->pt.x, m->pt.y);
            pruneStaleMiss(GetTickCount());
            return CallNextHookEx(s_selWheelHook, nCode, wp, lp);
        }
        if (calibRoot && hitRoot != calibRoot) {   // 其他应用/其他面板：透传（未命中 → 修剪）
            wheelLog("miss-root", m->pt.x, m->pt.y);
            pruneStaleMiss(GetTickCount());
            return CallNextHookEx(s_selWheelHook, nCode, wp, lp);
        }
        // 首见根窗口（工程恢复路径，calibRoot 为 null）：登记为基准
        if (!calibRoot) {
            for (auto& t : s_selWheelTargets) {
                if (!t.calibRoot) t.calibRoot = hitRoot;
            }
            wheelLog("selfcal", (long)(intptr_t)hitRoot, 0);
        }
        // 光标 → ECW 客户逻辑坐标（ScreenToClient 用命中窗口——ECW 或其
        // 子窗口的客户原点与 AE 绘制坐标系可能差子窗口边框，但选择器
        // 命中区域大（整列表 8 行 × 行高），边缘 1-2px 偏差不影响判定）
        for (auto& t : s_selWheelTargets) {
            if (!t.screenValid && t.calibRoot == hitRoot) {
                // 惰性校准：用光标点近似事件锚点（滚轮时光标就在控件上方，
                // 误差 = 光标与校准参考点差 → 以光标为基准重算矩形）。
                // DPI 用主线程缓存（钩子线程 GetActiveWindow 为 null）
                POINT cp = m->pt;
                if (ScreenToClient(hit, &cp)) {
                    const float scale = s_selWheelDpiScale.load(std::memory_order_relaxed);
                    const float lx = static_cast<float>(cp.x) / scale;
                    const float ly = static_cast<float>(cp.y) / scale;
                    t.screen.left   = static_cast<LONG>(m->pt.x - lx + static_cast<float>(t.clientRect.left));
                    t.screen.top    = static_cast<LONG>(m->pt.y - ly + static_cast<float>(t.clientRect.top));
                    t.screen.right  = static_cast<LONG>(m->pt.x - lx + static_cast<float>(t.clientRect.right));
                    t.screen.bottom = static_cast<LONG>(m->pt.y - ly + static_cast<float>(t.clientRect.bottom));
                    t.screenValid = true;
                    wheelLog("calib2", t.screen.left, t.screen.top);
                }
            }
        }
    }
    // MSLLHOOKSTRUCT.pt = 物理屏幕坐标（与 screenValid 映射同空间），无需 GetCursorPos。
    // 多实例同屏时 s_selWheelTargets 会残留「实例已销毁/选择器不再绘制」的旧目标
    // （其 screen 是旧校准值，仍可能覆盖光标）。在**所有命中**的目标中取 lastSeen
    // 最新者（绘制/悬停会持续刷新 lastSeen，旧目标不再刷新），命中判定不看 lastSeen
    // 是否超时（见 selWheelHitIndex 注释）——原内联循环抽到
    // host::selWheelHitIndex，与单测共用同一实现。
    const DWORD now = GetTickCount();
    const size_t picked = host::selWheelHitIndex(
        s_selWheelTargets.begin(), s_selWheelTargets.end(), m->pt.x, m->pt.y);
    if (picked != static_cast<size_t>(-1)) {
        SelWheelTarget& t = s_selWheelTargets[picked];
        // 命中不代表目标还活着——已死实例
        //（ECW 已关闭但 ref 抖动导致剔除失败）只要旧矩形压住光标就靠本行续命、
        // 永不修剪（局部死区 + 钩子线程不收敛）。故先判目标窗口（calibRoot）的
        // 有效性（三态纯函数 host::selWheelHandleState，单测见 test_sel_wheel_policy.cpp）：
        //   · Dead（IsWindow(calibRoot)==false，窗口已销毁）→ **不续命、不消费**：
        //     落入未命中路径跑 pruneStaleMiss（lastSeen 不再刷新 → 既有 3s 阈值
        //     修剪即刻收敛该死目标），本次滚轮放行给面板（宁可放行，不吞输入）。
        //   · Alive / Unknown(0)（窗口存在 / 尚未校准出 calibRoot）→ 降级保留现状：
        //     照常续命 + 消费，由 3s 阈值兜底（见 selWheelPolicy.h 判据注释的三态口径）。
        // 两级判据的关系：HWND 有效性是"立即判死"的硬证据；3s 阈值是它与 ref 剔除
        // 都失效时的最终兜底（阈值为 0 的路径不存在——三级都不成立才可能残留）。
        const host::SelWheelHandleState hs = host::selWheelHandleState(
            reinterpret_cast<std::uintptr_t>(t.calibRoot), selWheelIsWindowFn);
        if (hs == host::SelWheelHandleState::Dead) {
            wheelLog("hit-dead", (long)(intptr_t)t.calibRoot, 0);
            pruneStaleMiss(now);
            return CallNextHookEx(s_selWheelHook, nCode, wp, lp);
        }
        t.lastSeen = now;   // 命中即刷新：连续滚轮优先复用同一目标
        // 向前滚（+）= 内容上移 = 滚动偏移减；每档 3 行（Windows 默认）
        s_selWheelPending.push_back({t.effectRef, t.clientRect, wdelta > 0 ? -3 : 3, now});
        // 吃掉输入后面板不动 → AE 不会因输入重绘 ECW → 事件不派发 →
        // pending 无人消费（IDLE 实测几乎不派发，见 handleIdle 注释）。
        // 向命中窗口合成一次鼠标微移动 → AE 派发 ADJUST_CURSOR → handleCursor
        // 开头 selWheelApplyIdle 消费 pending（该路径自带有效 contextH）。
        // 注意：不得从本（钩子）线程调 AE 套件——旧代码的 PF_RefreshAllWindows
        // 实测也无效（refresh 160 次 / apply 0 次），已移除。
        {
            // 向 ECW 宿主合成 WM_MOUSEMOVE **无效**——AE 丢弃
            // 无真实位移的移动消息，不会重绘 ECW，所以「滚轮后必须再动一下真鼠标」。
            // 改为制造**真实**位移：光标 +1px 再复位（等价于用户动一下鼠标，这是
            // 已被验证能触发重绘的方式；光标视觉抖动 1px，几乎无感）。
            // 本钩子只处理滚轮消息（WP==WM_MOUSEWHEEL 分支内），合成移动不会递归到此。
            SetCursorPos(m->pt.x + 1, m->pt.y);
            SetCursorPos(m->pt.x, m->pt.y);
            // 保留合成移动作为兜底（部分环境下真实位移被系统过滤）
            HWND targetWnd = t.calibRoot ? t.calibRoot : WindowFromPoint(m->pt);
            POINT cp = m->pt;
            if (targetWnd && ScreenToClient(targetWnd, &cp)) {
                PostMessageW(targetWnd, WM_MOUSEMOVE, 0, MAKELPARAM(cp.x + 1, cp.y));
                PostMessageW(targetWnd, WM_MOUSEMOVE, 0, MAKELPARAM(cp.x, cp.y));
            }
        }
        wheelLog("hit", wdelta, (long)s_selWheelPending.size());
        return 1;   // 吃掉：滚轮输入不投递，面板不滚
    }
    // 未命中：此处才修剪陈旧目标/待滚（命中路径在上面已消费并返回，活目标即使
    // lastSeen 超时也绝不在命中前被删）。目标表空 → 自停并清 pending。
    pruneStaleMiss(now);
    if (!s_selWheelTargets.empty() && s_selWheelTargets[0].screenValid) {
        wheelLog("miss", m->pt.x - s_selWheelTargets[0].screen.left,
                 m->pt.y - s_selWheelTargets[0].screen.top);
    }
    return CallNextHookEx(s_selWheelHook, nCode, wp, lp);
}

// —— 独立钩子线程的安装/拆除（均在 AE 主线程调用）——
static DWORD WINAPI selWheelThreadProc(LPVOID) {
    HMODULE mod = nullptr;
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                           GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           reinterpret_cast<LPCWSTR>(&selWheelMouseProc), &mod) && mod) {
        s_selWheelHook = SetWindowsHookExW(WH_MOUSE_LL, selWheelMouseProc, mod, 0);
    }
    wheelLog("hook", (long)(intptr_t)s_selWheelHook, (long)(intptr_t)s_selWheelOwner);
    // 先建消息队列（PostThreadMessage 依赖它存在），再通知主线程
    MSG msg;
    PeekMessageW(&msg, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
    if (s_selWheelReady) SetEvent(s_selWheelReady);
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    if (s_selWheelHook) {
        UnhookWindowsHookEx(s_selWheelHook);
        s_selWheelHook = nullptr;
    }
    return 0;
}

static void selWheelStartHookThread() {
    if (s_selWheelThread) return;
    s_selWheelStopReq.store(false);   // 新线程从零计（上一线程的自停请求已回收）
    s_selWheelOwner = GetActiveWindow();
    s_selWheelDpiScale.store(dpiScale(), std::memory_order_relaxed);
    if (!s_selWheelReady) s_selWheelReady = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    else ResetEvent(s_selWheelReady);
    s_selWheelThread = CreateThread(nullptr, 0, selWheelThreadProc, nullptr, 0, &s_selWheelThreadId);
    if (!s_selWheelThread) {
        s_selWheelThreadId = 0;
        return;
    }
    if (s_selWheelReady) WaitForSingleObject(s_selWheelReady, 1000);
}

static void selWheelStopHookThread() {
    if (!s_selWheelThread) { s_selWheelStopReq.store(false); return; }
    const DWORD tid = s_selWheelThreadId;
    if (tid) PostThreadMessageW(tid, WM_QUIT, 0, 0);
    WaitForSingleObject(s_selWheelThread, 2000);
    CloseHandle(s_selWheelThread);
    s_selWheelThread = nullptr;
    s_selWheelThreadId = 0;
    s_selWheelHook = nullptr;
    s_selWheelStopReq.store(false);
}

// 主线程侧回收「自停」的钩子线程（见 s_selWheelStopReq 注释）。登记/
// 剔除入口先调用本函数，之后调用方再按需 selWheelStartHookThread 重启——否则线程
// 句柄悬挂，s_selWheelThread 非空会让随后的登记误以为钩子还活着、永不重挂。
static void selWheelReapStoppedHookThread() {
    if (!s_selWheelThread) { s_selWheelStopReq.store(false); return; }
    if (!s_selWheelStopReq.exchange(false)) return;
    selWheelStopHookThread();
}

// 列表有滚动条时登记/刷新本实例目标（drawFileSelector 调用）；无滚动条/折叠时
// 调 selWheelRemoveTarget（滚轮透传给面板，无滚动条时这是预期行为）。
static void selWheelUpsertTarget(void* effectRef, const PF_Rect& f) {
    selWheelReapStoppedHookThread();   // 钩子曾自停（陈旧修剪清空）→ 先回收线程句柄
    const DWORD now = GetTickCount();
    const host::SelWheelRect r = host::selWheelRectOf(f.left, f.top, f.right, f.bottom);
    {
        SelWheelLock lk(s_selWheelMutex);
        // 按控件矩形认同一目标并刷新为**当前** ref：effect_ref 实测同一控件在不同
        // DRAW 间会变，若按 ref 匹配会不断新建目标，且滚轮 pending 记到过期 ref 上
        // （DRAW 永不匹配 → apply 迟到数秒，实测 8s 后才生效）。查找口径
        // 与剔除统一走 selWheelPolicy（selWheelFindByRect），不再各写一份比较。
        auto it = host::selWheelFindByRect(s_selWheelTargets.begin(), s_selWheelTargets.end(), r);
        if (it != s_selWheelTargets.end()) {
            it->effectRef = effectRef;
            it->clientRect = r;
            it->lastSeen = now;
        } else {
            SelWheelTarget t{};
            t.effectRef = effectRef;
            t.clientRect = r;
            t.screenValid = false;
            t.lastSeen = now;
            s_selWheelTargets.push_back(t);
        }
    }
    // 自停请求在钩子线程持锁时置位；若入口 reap 恰好发生在置位之前（竞态窗口），
    // 插入完成后再收一次——否则线程已退出而句柄非空，下面的启动判断拒绝重启，
    // 新目标将没有钩子。
    selWheelReapStoppedHookThread();
    // 有目标即需要钩子：在专用线程安装（回调不再占用 AE 主线程，见
    // selWheelStartHookThread 上方注释）。锁外调用——启动线程会等就绪事件，
    // 持锁等待会阻塞钩子线程抢锁。
    if (!s_selWheelThread) selWheelStartHookThread();
}

// 剔除目标与待滚。rect 非空（折叠/无滚动条的 DRAW 路径，f 就是登记时
// 的控件矩形）→ **只**按矩形匹配（与 upsert 同口径，ref 不同也能删掉）；rect 为空
// （ECW 关闭/实例销毁，没有可靠矩形）→ 按 ref 兜底（ref 不稳定时可能删不掉，由
// 钩子侧 lastSeen 超时修剪兜底收敛，不再残留整个 AE 会话）。
static void selWheelRemoveTarget(void* effectRef, const PF_Rect* rect = nullptr) {
    selWheelReapStoppedHookThread();
    bool empty = false;
    {
        SelWheelLock lk(s_selWheelMutex);
        host::SelWheelRect r{};
        const host::SelWheelRect* rp = nullptr;
        if (rect) {
            r = host::selWheelRectOf(rect->left, rect->top, rect->right, rect->bottom);
            rp = &r;
        }
        s_selWheelTargets.erase(
            host::selWheelRemoveTargets(s_selWheelTargets.begin(), s_selWheelTargets.end(), rp, effectRef),
            s_selWheelTargets.end());
        // 待滚条目同口径一并清（矩形命中即可——实例销毁/折叠后悬空待滚不得再被消费）
        s_selWheelPending.erase(
            host::selWheelRemoveTargets(s_selWheelPending.begin(), s_selWheelPending.end(), rp, effectRef),
            s_selWheelPending.end());
        empty = s_selWheelTargets.empty();
        // 目标表已空 = 本插件当前没有选择器在屏，任何残留 pending（含 ref
        // 抖动删不掉的）都失去归属，整队列清——否则会被下一个打开列表的实例消费。
        if (empty) s_selWheelPending.clear();
    }
    // 锁外停线程：join 期间钩子线程可能正抢锁，持锁 join 必然死锁
    if (empty) {
        selWheelStopHookThread();
        s_selWheelOwner = nullptr;
    }
}

// 悬停时刷新屏幕矩形映射（handleCursor 调用）。clientPt = 事件点（ECW 客户区
// 逻辑坐标），同刻 GetCursorPos 即该点的物理屏幕坐标；f = 当前控件矩形。
// （事件锚点版：DO_CLICK/ADJUST_CURSOR 携带事件点时用；钩子自校准见
// selWheelHitTest——工程恢复的展开态没有点击事件，校准不能只靠事件锚点）
static void selWheelUpdateScreen(void* effectRef, const PF_Point& clientPt, const PF_Rect& f) {
    POINT cur;
    if (!GetCursorPos(&cur)) return;
    const float scale = dpiScale();
    s_selWheelDpiScale.store(scale, std::memory_order_relaxed);   // 钩子线程读取的缓存
    const float baseX = static_cast<float>(cur.x) - static_cast<float>(clientPt.h) * scale;
    const float baseY = static_cast<float>(cur.y) - static_cast<float>(clientPt.v) * scale;
    const host::SelWheelRect r = host::selWheelRectOf(f.left, f.top, f.right, f.bottom);
    SelWheelLock lk(s_selWheelMutex);
    for (auto& t : s_selWheelTargets) {
        // 与 upsert 同口径：按控件矩形认同（ref 不稳定）
        if (!host::selWheelRectEq(t.clientRect, r)) continue;
        t.effectRef = effectRef;   // 刷新为当前 ref
        const bool firstCalib = !t.screenValid;   // 仅首次校准打日志——逐移动打会刷爆预算
        t.screen.left   = static_cast<LONG>(baseX + static_cast<float>(f.left) * scale);
        t.screen.top    = static_cast<LONG>(baseY + static_cast<float>(f.top) * scale);
        t.screen.right  = static_cast<LONG>(baseX + static_cast<float>(f.right) * scale);
        t.screen.bottom = static_cast<LONG>(baseY + static_cast<float>(f.bottom) * scale);
        t.screenValid = true;
        t.lastSeen = GetTickCount();   // 悬停刷新：该目标当前活跃
        // 校准时刻的命中根窗口（钩子回调的漂移防御基准）
        if (HWND hit = WindowFromPoint({cur.x, cur.y})) {
            t.calibRoot = GetAncestor(hit, GA_ROOT);
        }
        if (firstCalib) wheelLog("calib", t.screen.left, t.screen.top);
        break;
    }
}

// IDLE 应用待滚行数（handleIdle 调用，归属实例各自消费）。IDLE 非有效事件上下文
// 不能设 CHANGED_VALUE——滚轮路径的滚动偏移不随工程持久化（视图状态，可接受；
// 箭头/翻页/拖拽路径在有效事件内写 handle，仍持久化）。
static void selWheelApplyIdle(PF_InData* in_data, PF_OutData* out_data,
                              PF_ParamDef* params[], PF_EventExtra* extra) {
    const PF_Rect& cur = extra->effect_win.current_frame;
    const host::SelWheelRect curR = host::selWheelRectOf(cur.left, cur.top, cur.right, cur.bottom);
    int delta = 0;
    {
        SelWheelLock lk(s_selWheelMutex);
        if (s_selWheelPending.empty()) return;
        // 消费前先按与目标同口径的超时丢弃陈旧 pending——上一实例的 ECW
        // 关闭时按 ref 剔除会因 ref 抖动失败，幸存条目不得再被本实例消费。
        s_selWheelPending.erase(
            host::selWheelPruneStale(s_selWheelPending.begin(), s_selWheelPending.end(),
                                     GetTickCount(), kSelWheelTargetStaleMs),
            s_selWheelPending.end());
        if (s_selWheelPending.empty()) return;
        // ref 优先，ref 不稳定时按控件矩形兜底（同一选择器的 DRAW 矩形与命中时一致）
        for (auto it = s_selWheelPending.begin(); it != s_selWheelPending.end(); ) {
            const bool sameRef = (it->effectRef == in_data->effect_ref);
            const bool sameRect = host::selWheelRectEq(it->clientRect, curR);
            if (sameRef || sameRect) { delta += it->delta; it = s_selWheelPending.erase(it); }
            else ++it;
        }
    }
    if (delta == 0) return;
    int n = 0;
    {
        auto& gs = globalState();
        CSLock lk(gs.mutex);
        n = static_cast<int>(gs.popupChoices.size());
    }
    if (n <= kFileSelMaxRows) return;   // 列表已缩短（刷新后）：无滚动可滚
    wheelLog("apply", delta, fileSelScrollOf(in_data, params, n));
    // 累计到插件侧，**不写 handle**：实测在 DRAW/ADJUST_CURSOR 上下文写
    // ARBITRARY_DATA 句柄不生效（下一次事件读回仍是旧值——每档都从 0 开始，
    // 列表永远不动）。drawFileSelector 绘制时把 wheelDelta 叠加到 handle 偏移。
    // 关键：累计值必须**当场按可见范围钳制**——否则滚到底后继续滚会把超出量
    // 吃进累计值（如 5 行上限却累计到 30），再向上滚要先"吐"完超出的量才动，
    // 表现为「到尽头后再滚一次，反向滚不动」。
    SelWheelLock lk(s_selWheelMutex);
    for (auto& t : s_selWheelTargets) {
        if (t.effectRef == in_data->effect_ref ||
            host::selWheelRectEq(t.clientRect, curR)) {
            const int handleScroll = fileSelScrollOf(in_data, params, n);
            const int maxScroll = (std::max)(0, n - kFileSelMaxRows);
            int want = handleScroll + t.wheelDelta + delta;
            want = (std::max)(0, (std::min)(want, maxScroll));
            t.wheelDelta = want - handleScroll;   // 保持「handle + wheelDelta = 可见偏移」
            break;
        }
    }
    // 不调 PF_InvalidateRect：本函数在 PF_Event_DRAW 开头被调用，紧随其后的
    // drawFileSelector 会在同一事件里用新偏移重绘。实测在 DRAW 上下文调用
    // PF_InvalidateRect 会触发 AE 内部验证故障并中断本次绘制。
}

// UPDATE_PARAMS_UI 消费路径（plugin.cpp 调用，无 extra）——DRAW 实测不被
// InvalidateRect 主框架触发（ECW 的 DRAW 由 AE 内部调度），滚轮 pending 的
// 可靠消费点：UPDATE_PARAMS_UI 在 ECW 打开期间持续到达且携带本实例上下文。
// 应用后直接改 handle（滚动偏移，DRAW 读取）并 InvalidateRect 主窗口——下一次
// 任意 ECW 重绘即呈现新偏移；若 AE 仍不重绘，滚动在下一个自然重绘时机生效。
// 注意：Impl 留在匿名 namespace（内部链接即可）；对外包装 selWheelConsume 必须
// 定义在**文件级匿名 namespace 之外**（外部链接，plugin.cpp 跨 TU 引用），
// 见文件末尾「对外接口」区。
namespace {
static PF_Err selWheelConsumeImpl(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[]) {
    int delta = 0;
    {
        SelWheelLock lk(s_selWheelMutex);
        if (s_selWheelPending.empty()) return PF_Err_NONE;
        // 同口径超时修剪——上一实例（ECW 已关、ref 抖动导致剔除失败）的
        // 幸存 pending 不得被本实例的 UPDATE_PARAMS_UI 消费。
        s_selWheelPending.erase(
            host::selWheelPruneStale(s_selWheelPending.begin(), s_selWheelPending.end(),
                                     GetTickCount(), kSelWheelTargetStaleMs),
            s_selWheelPending.end());
        if (s_selWheelPending.empty()) return PF_Err_NONE;
        // in_data->effect_ref 在 DRAW/EVENT 与 UPDATE_PARAMS_UI
        // 两个上下文**不保证一致**，按 effectRef 过滤会让 pending 永不被消费
        //（探针：wt-pick=0 命中入队，但 apply/apply2 恒为 0）。钩子已按屏幕矩形
        // 解析出唯一的在屏控件，且 ECW 同一时刻只显示一个实例的控件，故直接清空整个
        // pending 并把总量应用到当前实例。（ADJUST_CURSOR 那条路实测 AE 基本不派发。）
        for (const auto& p : s_selWheelPending) delta += p.delta;
        s_selWheelPending.clear();
    }
    if (delta == 0) return PF_Err_NONE;
    int n = 0;
    {
        auto& gs = globalState();
        CSLock lk(gs.mutex);
        n = static_cast<int>(gs.popupChoices.size());
    }
    if (n <= kFileSelMaxRows) return PF_Err_NONE;
    wheelLog("apply2", delta, fileSelScrollOf(in_data, params, n));
    setFileSelScroll(in_data, params, fileSelScrollOf(in_data, params, n) + delta, n);
    // 强制 ECW 重绘：invalidate 校准根窗口（ECW 所属主框架）整个客户区——
    // 控件矩形已随 handle 偏移更新，下一次 DRAW 读取 handle 即呈现滚动。
    // 锁外 InvalidateRect：setFileSelScroll→resetFileSelWheelDelta 会再取本锁。
    HWND calibRoot = nullptr;
    {
        SelWheelLock lk(s_selWheelMutex);
        for (const auto& t : s_selWheelTargets) {
            if (t.effectRef == in_data->effect_ref) { calibRoot = t.calibRoot; break; }
        }
    }
    if (calibRoot) InvalidateRect(calibRoot, nullptr, FALSE);
    return PF_Err_NONE;
}
} // namespace

// —— 编辑框提交的「合成点击」持久化推进 ——
// 为什么需要：Enter/失焦提交发生在编辑框 WndProc，那里**没有 AE 事件上下文**，
// 只能置 pendingCommit/pendingPersist 留待 AE 回调处理；而 `change_flags` 的
// CHANGED_VALUE 位只在**有效事件**（DO_CLICK/DRAG）里设置才被 AE 采纳
//（AE_Effect.h:2250），DRAW/IDLE/ACTIVATE 阶段设置无效。若完全不推进，用户回车
// 提交后值只写进参数不落盘，工程重载即回滚（Enter 后闪一下变回原值）。
// 推进手段 = 在数值框上合成一次**真实系统鼠标点击**（SendInput），令 AE 产生
// 一次 DO_CLICK → handleClick 在有效事件里补 CHANGED_VALUE（见
// postPersistClickSynthetic）。合成的那次点击由抑制标记吞掉，不触发控件动作。
//
// 【与「脚本切文件 → 槽位重置」是两条独立链，勿混】
// 本条链只服务**编辑框提交**。脚本切文件的槽位重置
//（RequestSlotResetForFileIndex / consumePendingSlotReset）保持**纯被动登记**：
// 不注入合成输入、不挂定时器、不做 DRAW 阶段坐标换算。该链的故障现象（应用
// 效果时弹「内部验证故障」）源于在那条链的 DRAW 阶段做坐标换算并注入，本恢复
// 不触及该链（其纯被动契约仍由测试钉死）。
//
// 合成一次 DO_CLICK 打到数字框上，触发 AE 的 handleClick 在有效事件里补
// change_flags，从而持久化 DRAW 阶段已写入参数的值（见 flushPendingCommit 注释）。
// 用编辑框屏幕位置 + ScreenToClient 换算到宿主窗口客户区坐标，避免坐标系错位。
// defer：失焦提交路径用——不立即注入，挂起定时器延迟注入（见
// persistClickTimerProc 处注释：立即注入会与导致失焦的本 ECW 内点击互相干扰）。
static void postPersistClickSynthetic(void* ownerRef, bool defer = false);

// 提交当前编辑框内容（回车/失焦/切换编辑框/ECW 失焦共用）：
// 读取文本 → 解析 → 存 pendingVal → 置 pendingCommit/pendingPersist。**不在
// WndProc 里直接写参数 handle**：缓存 handle 在 AE 消息循环期间可能因参数重建
// 而失效，直接写会访问已释放内存崩溃（0xC0000005 已实证）。写参数必须在 AE
// 事件回调内完成（flushPendingCommit），配合 out_flags 强制重渲染。→ 销毁编辑框。
// postPersistClick：Enter/Tab 提交后合成一次 DO_CLICK，确保在有效事件里补
// change_flags 持久化；WM_KILLFOCUS 路径同样需要（导致失焦的点击若
// 落在 ECW 之外——时间轴/其他面板/其他应用——不会产生任何 DO_CLICK，
// CHANGED_VALUE 永不补设，值只在参数中生效，工程重载可能回滚），但该路径必须
// deferPersistClick 延迟注入（立即注入的副作用见 persistClickTimerProc 注释）。
// WndProc 提交无 AE 事件上下文，经 s_editWndOwnerRef 路由到**归属实例**
// 条目存 pendingVal——写进程级 s_edit 时，A 输入的值可能被 B 的事件消费。
static void commitValueEdit(bool postPersistClick = false, bool deferPersistClick = false) {
    if (!s_editHwnd) return;
    // 验收修复：先捕获归属实例 ref——下方 closeValueEdit() 会把 s_editWndOwnerRef
    // 置空（窗口销毁解除归属），若事后才读取，Enter 路径的 postPersistClickSynthetic
    // 恒拿 nullptr 提前返回 → 合成 DO_CLICK 永不注入 → CHANGED_VALUE 永不补设
    // → 值只写参数不落盘（Enter 提交后重载回滚的回归）。
    void* ownerRef = s_editWndOwnerRef;
    EditInstanceState* st = editStateForRef(ownerRef);
    wchar_t wbuf[64] = {0};
    GetWindowTextW(s_editHwnd, wbuf, 64);
    char nbuf[64] = {0};
    WideCharToMultiByte(CP_UTF8, 0, wbuf, -1, nbuf, sizeof(nbuf), nullptr, nullptr);
    if (st) {
        st->edit.pendingVal = static_cast<float>(std::atof(nbuf));
        st->edit.pendingCommit = true;
        st->edit.pendingPersist = true;
        st->edit.active = false;
        st->edit.dirty = true;   // 待 AE 事件重绘恢复显示实际值
        st->lastTouch = GetTickCount();
    }
    // 归属实例条目缺失（实例已销毁）：丢弃输入，不落到其他实例
    closeValueEdit();
    if (postPersistClick) postPersistClickSynthetic(ownerRef, deferPersistClick);
}

// ── 失焦提交的合成点击延迟注入 ——
// WM_KILLFOCUS 若照搬 Enter 路径**立即**注入合成点击，会与导致失焦的那次点击
// 互相干扰（handleClick 的抑制标记是「注入后 200ms 内的首个 DO_CLICK」消费制，
// 而本文件 handleClick 处注释实证 WM_KILLFOCUS 先于 DO_CLICK 到达）：
//   - 失焦因点击**本 ECW 内**控件触发（如点另一滑条）：真实 DO_CLICK 先到 →
//     消耗抑制标记（用户的点击被当合成点击吞掉、不触发控件动作）；随后到达的
//     合成点击反被视为真实点击 → 在数值框上**重开编辑框**；
//   - 立即 SetCursorPos 还会把光标从用户点击处拉回数值框：打断进行中的拖拽、
//     干扰下一个编辑框弹窗的定位（openValueEdit 按当前光标定位）。
// 改为延迟注入（线程定时器，回调在 AE 主线程消息循环派发——与 WndProc 同线程
// 安全上下文）：
//   - 期间 pendingPersist 已被真实有效事件消费（失焦点击就在本 ECW 内，其
//     DO_CLICK 补了 CHANGED_VALUE）→ 取消注入，零打扰；
//   - 仍无有效事件（点击在 ECW 之外：时间轴/其他面板/其他应用）→ 此时注入：
//     此刻无进行中的手势，合成点击必然是注入后的首个 DO_CLICK，抑制标记精准
//     命中，无吞点击/重开编辑框副作用。
// 鼠标左键按住（拖拽中）或任一编辑框打开时顺延（不与用户手势争抢）；挂起
// 超 60s 取消（对齐 flushPendingCommit 的悬空防御）。注入前校验落点仍在宿主
// 窗口矩形内（挂起期间 ECW/宿主可能移动，不向陌生窗口注入点击）。
// 残余风险（评估后接受）：仅 DLL 卸载（AE 退出）时有挂起定时器一种时序理论上
// 回调悬空——退出路径消息泵先行停止且挂起窗口 ≤60s，实际不可达。
static void* s_persistClickRef = nullptr;     // 挂起合成点击的归属实例 effect_ref
static UINT_PTR s_persistClickTimer = 0;      // SetTimer(NULL) 返回的定时器 id
static DWORD s_persistClickArmTick = 0;       // 首次挂起时刻（60s 上限起算点）
void CALLBACK persistClickTimerProc(HWND, UINT, UINT_PTR, DWORD);

// 挂起（或重启）延迟注入定时器。重复调用替换前次（同一时刻至多一个挂起）：
// 更晚的会话的挂起覆盖更早的——被覆盖者的 pending 留在其条目，由该实例自身的
// 后续有效事件或 60s 超时兜底（兜底路径不变，无新增回滚面）。
static void armPersistClickTimer(void* ref) {
    if (s_persistClickTimer) KillTimer(nullptr, s_persistClickTimer);
    s_persistClickRef = ref;
    s_persistClickArmTick = GetTickCount();
    s_persistClickTimer = SetTimer(nullptr, 0, 250, persistClickTimerProc);
}

void CALLBACK persistClickTimerProc(HWND, UINT, UINT_PTR, DWORD) {
    auto cancel = []() {
        if (s_persistClickTimer) KillTimer(nullptr, s_persistClickTimer);
        s_persistClickTimer = 0;
        s_persistClickRef = nullptr;
    };
    EditInstanceState* st = editStateForRef(s_persistClickRef);
    if (!st || !st->edit.pendingPersist ||
        GetTickCount() - s_persistClickArmTick > 60000) {
        // 归属实例已销毁 / 待持久化值已被有效事件补设 / 挂起超时 → 取消
        uiDebug("[persist] deferred cancel slot=%d",
                st ? st->edit.slot : -1);
        cancel();
        return;
    }
    // 手势顺延面扩展——左/右/中任一鼠标键按住（右键上下文菜单流：
    // 菜单弹出期间按钮持续按住或即将再次按下）或鼠标被捕获（菜单跟踪/拖拽中
    // GetCapture 非空：上下文菜单弹出期间 AE 捕获鼠标，此时注入会把光标从菜单
    // 拉走并点击关闭菜单——每次「编辑数值 → 右键他处」流可复现）。
    if (s_editHwnd || (GetAsyncKeyState(VK_LBUTTON) & 0x8000)
        || (GetAsyncKeyState(VK_RBUTTON) & 0x8000)
        || (GetAsyncKeyState(VK_MBUTTON) & 0x8000)
        || GetCapture() != nullptr) {
        // 编辑框打开 / 任意鼠标键按住 / 鼠标被捕获（用户手势进行中）：顺延
        //（不刷新挂起时刻，60s 上限兜底取消）
        if (s_persistClickTimer) KillTimer(nullptr, s_persistClickTimer);
        s_persistClickTimer = SetTimer(nullptr, 0, 250, persistClickTimerProc);
        return;
    }
    // 注入前校验落点仍在宿主窗口内（挂起期间窗口可能移动/关闭）；
    // valueBoxValid 为假（无可靠落点）时同样取消
    RECT wr;
    const BOOL haveRect = st->edit.owner ? GetWindowRect(st->edit.owner, &wr) : FALSE;
    if (!st->valueBoxValid || !st->edit.owner || !haveRect ||
        !PtInRect(&wr, { st->valueBoxCX, st->valueBoxCY })) {
        uiDebug("[persist] deferred cancel slot=%d valid=%d owner=%p rect=%d pt=(%d,%d)",
                st->edit.slot, st->valueBoxValid ? 1 : 0,
                reinterpret_cast<void*>(st->edit.owner), haveRect ? 1 : 0,
                st->valueBoxCX, st->valueBoxCY);
        cancel();
        return;
    }
    // 命中窗口根一致性——PtInRect 只保证点在宿主矩形内，不保证
    // 点击会落到宿主窗口：挂起期间用户 alt-tab 到其他应用（其窗口恰好覆盖
    // valueBox 坐标）或 AE 内其他面板移入该区域时，SetCursorPos+SendInput 的
    // 点击会打到 Z 序最顶的其他窗口（跨应用误点击/误操作其他面板）。用
    // WindowFromPoint 做 Z 序命中测试：命中窗口的根窗口必须与宿主根一致
    //（停靠 ECW 根为 AE 主框架、浮动 ECW 根为浮动面板），否则顺延等用户
    // 回到宿主窗口（60s 上限兜底）。顺延分支**不得** cancel（须保留归属引用）。
    const POINT probe = { static_cast<LONG>(st->valueBoxCX), static_cast<LONG>(st->valueBoxCY) };
    const HWND hit = WindowFromPoint(probe);
    const HWND ownerRoot = GetAncestor(st->edit.owner, GA_ROOT);
    if (!hit || !ownerRoot || GetAncestor(hit, GA_ROOT) != ownerRoot) {
        uiDebug("[persist] deferred defer (hit root != owner root) slot=%d", st->edit.slot);
        if (!s_persistClickTimer) s_persistClickTimer = SetTimer(nullptr, 0, 250, persistClickTimerProc);
        return;
    }
    // 注入前终止本定时器（注入后不再周期触发；顺延分支已提前 return）
    cancel();
    st->suppressClick = true;
    st->suppressClickTick = GetTickCount();
    st->lastTouch = GetTickCount();
    SetCursorPos(st->valueBoxCX, st->valueBoxCY);
    INPUT in[2] = {};
    in[0].type = INPUT_MOUSE;
    in[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    in[1].type = INPUT_MOUSE;
    in[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    const UINT sent = SendInput(2, in, sizeof(INPUT));
    uiDebug("[persist] deferred SendInput click sent=%u slot=%d val=%.2f at=(%d,%d)",
            sent, st->edit.slot, st->edit.pendingVal, st->valueBoxCX, st->valueBoxCY);
}

// 合成一次 DO_CLICK 触发 AE 的 handleClick 在有效事件里补 change_flags，从而
// 持久化 DRAW 阶段已写入参数的值（见 flushPendingCommit 注释）。
// 用 SendInput 注入**真实系统鼠标点击**（而非 PostMessage 投递 WM_LBUTTONDOWN）：
// AE 的 ECW 窗口过程会检查输入队列/物理按键状态，PostMessage 投递的合成消息可能
// 不被识别为真实点击 → 不生成 DO_CLICK → change_flags 永不落盘 → 值回滚。
// 注入后置 suppressClick + 时间戳：handleClick 只抑制此 200ms 内的那次点击。
// 注入位置不再用"当前光标"（用户按 Enter 时鼠标未必停在数值框上，点击会落到 ECW 外
// → 不产生 DO_CLICK → 值不落盘回滚；且 suppressClick 残留吞掉下一次真实点击）。
// 改为：先把光标移到数值框屏幕中心（openValueEdit 按 DPI 换算的 valueBoxCX/CY），
// 再注入真实系统点击 → 点击**必然落在数值框上** → DO_CLICK 稳定触发 → handleClick
// 在有效事件里补 CHANGED_VALUE 完成持久化。
static void postPersistClickSynthetic(void* ownerRef, bool defer) {
    // 合成点击的抑制标记/落点坐标写入**归属实例**条目（窗口单例，
    // 经 ownerRef 路由——commitValueEdit 在 closeValueEdit 清空全局归属
    // 标记前捕获传入）；归属条目缺失（实例已销毁）时无待持久化值，不注入
    // 合成点击。
    EditInstanceState* st = editStateForRef(ownerRef);
    if (!st) return;
    if (defer) {
        // 失焦路径延迟注入（见 persistClickTimerProc 上方注释——
        // 立即注入会吞掉导致失焦的本 ECW 内点击、并在数值框上重开编辑框）
        armPersistClickTimer(ownerRef);
        uiDebug("[persist] deferred arm slot=%d val=%.2f", st->edit.slot, st->edit.pendingVal);
        return;
    }
    // 立即路径注入前时效校验（对齐 persistClickTimerProc 延迟路径
    // 的落点校验）——编辑框打开期间 ECW/宿主可能移动（窗口拖拽/停靠变化/
    // 面板重排），openValueEdit 记录的落点若照原样注入会打到错误目标（其他
    // 控件/其他实例/其他应用）。先按宿主窗口当前位移重算落点（窗口整体
    // 移动时数值框跟随），再校验：落点仍在宿主矩形内且 WindowFromPoint 命中
    // 窗口与宿主同根。任一失配即取消注入（ui_debug.log 记录提示）——值仍
    // 留在参数中由后续有效事件补 CHANGED_VALUE 持久化，宁可不补持久化也不向
    // 错误目标注入点击。校验先于抑制标记置位：取消时不留 suppressClick 残留
    //（否则吞掉用户 200ms 内的下一次真实点击）。
    RECT wr;
    if (!st->valueBoxValid || !st->edit.owner || !GetWindowRect(st->edit.owner, &wr)) {
        uiDebug("[persist] immediate cancel (no target) slot=%d valid=%d owner=%p",
                st->edit.slot, st->valueBoxValid ? 1 : 0,
                reinterpret_cast<void*>(st->edit.owner));
        return;
    }
    int tx = st->valueBoxCX;
    int ty = st->valueBoxCY;
    if (st->ownerRectValid) {
        tx += wr.left - st->ownerOpenRect.left;   // 宿主窗口位移跟随
        ty += wr.top - st->ownerOpenRect.top;
    }
    if (!PtInRect(&wr, { static_cast<LONG>(tx), static_cast<LONG>(ty) })) {
        uiDebug("[persist] immediate cancel (target outside owner) slot=%d", st->edit.slot);
        return;
    }
    {
        const POINT probe = { static_cast<LONG>(tx), static_cast<LONG>(ty) };
        const HWND hit = WindowFromPoint(probe);
        const HWND ownerRoot = GetAncestor(st->edit.owner, GA_ROOT);
        if (!hit || !ownerRoot || GetAncestor(hit, GA_ROOT) != ownerRoot) {
            uiDebug("[persist] immediate cancel (hit root != owner root) slot=%d", st->edit.slot);
            return;
        }
    }
    st->suppressClick = true;
    st->suppressClickTick = GetTickCount();
    st->lastTouch = GetTickCount();
    // 光标移到（重算后的）数值框中心
    POINT target;
    target.x = tx;
    target.y = ty;
    SetCursorPos(target.x, target.y);
    INPUT in[2] = {};
    in[0].type = INPUT_MOUSE;
    in[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    in[1].type = INPUT_MOUSE;
    in[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    const UINT sent = SendInput(2, in, sizeof(INPUT));
    uiDebug("[persist] SendInput click sent=%u slot=%d val=%.2f at=(%d,%d)",
            sent, st->edit.slot, st->edit.pendingVal, target.x, target.y);
}

// 取消编辑：丢弃输入，恢复显示原值
static void cancelValueEdit() {
    if (!s_editHwnd) return;
    // dirty（恢复显示原值的重绘标记）写归属实例条目
    EditInstanceState* st = editStateForRef(s_editWndOwnerRef);
    if (st) {
        st->edit.active = false;
        st->edit.dirty = true;   // 恢复显示原值
        st->edit.pendingCommit = false;
    }
    closeValueEdit();
}

static LRESULT CALLBACK ValueEditWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_KEYDOWN: {
        const WPARAM vk = wParam;
        if (vk == VK_RETURN || vk == VK_TAB) {   // 回车/Tab → 提交（并合成点击持久化）
            commitValueEdit(true);
            return 0;
        }
        if (vk == VK_ESCAPE) {                     // Esc → 取消
            cancelValueEdit();
            return 0;
        }
        break;
    }
    case WM_KILLFOCUS:
        // 点击其他区域 → 提交。导致失焦的点击若在 ECW 之外（时间轴/
        // 其他面板/其他应用），不会再有任何 DO_CLICK 补 CHANGED_VALUE——值只写
        // 参数不落盘，工程重载可能回滚。同样注入合成点击持久化，但必须**延迟**
        // 注入（deferPersistClick）：立即注入会吞掉失焦点击在本 ECW 内时的那次
        // DO_CLICK、并在数值框上重开编辑框（见 persistClickTimerProc 上方注释）。
        commitValueEdit(true, /*deferPersistClick=*/true);
        return 0;
    default:
        break;
    }
    return CallWindowProcW(s_editOldProc, hwnd, msg, wParam, lParam);
}

static void closeValueEdit() {
    // 先取出归属实例条目里的宿主窗口（销毁窗口会解除归属关系）
    EditInstanceState* st = editStateForRef(s_editWndOwnerRef);
    HWND owner = st ? st->edit.owner : nullptr;
    if (s_editHwnd) {
        // 先恢复原 WndProc 再销毁，避免销毁过程中收到回调
        if (s_editOldProc) {
            SetWindowLongPtrW(s_editHwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(s_editOldProc));
            s_editOldProc = nullptr;
        }
        DestroyWindow(s_editHwnd);
        s_editHwnd = nullptr;
        s_editWndOwnerRef = nullptr;   // 窗口已销毁，归属关系解除
    }
    // 释放高 DPI 自建字体（库存 DEFAULT_GUI_FONT 无需删除）
    if (s_editFont) {
        DeleteObject(s_editFont);
        s_editFont = nullptr;
    }
    // 编辑框是 WS_POPUP（AE 不知道它盖在 ECW 上），销毁后 ECW 不会自动重绘 →
    // DRAW 事件不来 → flushPendingCommit 等不到。主动 InvalidateRect 宿主窗口
    // 强制 ECW 重绘 → 产生 PF_Event_DRAW → handleDraw 开头 flush 编辑框提交值，
    // 实现 Enter 后立即应用。
    if (owner) {
        InvalidateRect(owner, nullptr, TRUE);
    }
}

// 打开数值编辑框：在数字框位置创建非模态 EDIT 浮动窗口（WS_POPUP）。
// 定位：屏幕坐标 = 鼠标屏幕位置 + (数字框客户区位置 − 点击客户区位置)。
// DO_CLICK 的 screen_point 与 current_frame 同为 ECW 客户区坐标，二者差值
// 是客户区内相对位移；加上 GetCursorPos（鼠标屏幕位置）即数字框屏幕位置，
// **不依赖任何 HWND 坐标系**，从根上避免"上方有 GLSL 文件列表导致整体偏移"。
// 为什么 WS_POPUP 而非 WS_CHILD：弹窗点击外部必然失焦 → WM_KILLFOCUS 可靠
// 提交；子窗口的父窗口/坐标/覆盖行为受 ECW 内部结构影响，不可控。
// 返回 false 表示创建失败（保持现状，不崩溃）。
// in_data 参数用于把编辑会话状态写入**本实例**条目（按 effect_ref
// 索引），并记录 s_editWndOwnerRef 供 WndProc 提交时路由。
bool openValueEdit(PF_InData* in_data, const PF_Rect& f, const BoxRect& box, int slot, int comp,
                   const char* initText, const PF_Point& clickPt) {
    if (!in_data) return false;
    // 双保险：若仍有编辑框打开（正常路径下点击其他区域已触发 WM_KILLFOCUS 提交），
    // 这里提交并销毁，避免新编辑框打开时旧输入丢失。（提交经旧归属实例路由；
    // 旧实例的 pending 留在其条目，等它自己的事件 flush，不被本会话覆盖）
    if (s_editHwnd) commitValueEdit();
    // 数字框客户区矩形：**由调用点传入**（与绘制、命中判定同一个 valueBoxRect），
    // 浮窗正好盖在自绘的框上。若自算一份（numL = f.right-kTextWidth+6，
    // 高度几乎占满整行），与绘制/命中三处各不同源。
    const int numL = box.L;
    const int numW = (std::max)(box.R - box.L, 40);
    // 浮窗高不低于 16px（默认 GUI 字体的可读下限）；高于自绘框时**按框心居中**扩张，
    // 避免浮窗只往下挂一截（框已收到 14px，见 kValueBoxH）。
    const int numH = (std::max)(box.B - box.T, 16);
    const int numT = box.T - (numH - (box.B - box.T)) / 2;

    // ECW 逻辑坐标 → 物理像素：非 100% DPI 下 offset 与窗口尺寸需按缩放系数换算，
    // 否则在 200% 屏上编辑浮窗会相对自绘数字框错位（见 dpiScale）。
    const float scale = dpiScale();

    // 屏幕坐标 = 鼠标屏幕位置 + (数字框客户区位置 − 点击客户区位置) × DPI缩放
    POINT cur;
    if (!GetCursorPos(&cur)) return false;
    const int px = cur.x + static_cast<int>((numL - clickPt.h) * scale);
    const int py = cur.y + static_cast<int>((numT - clickPt.v) * scale);
    const int pxW = static_cast<int>(numW * scale);
    const int pxH = static_cast<int>(numH * scale);

    // 宿主窗口：取光标下窗口的顶层根（用户刚点的数值框所在 ECW）——GetActiveWindow()
    // 在 DO_CLICK 上下文/前一个编辑框刚销毁时可能返回 null，取不到时提交值只能等
    // 下一次 ECW 重绘的 flush 才应用（观感延迟，无功能损失）。命中窗口更可靠。
    HWND hostWnd = nullptr;
    if (HWND under = WindowFromPoint(cur)) hostWnd = GetAncestor(under, GA_ROOT);
    if (!hostWnd) hostWnd = GetActiveWindow();

    wchar_t winit[64] = {0};
    MultiByteToWideChar(CP_UTF8, 0, initText, -1, winit, 64);

    HWND hwnd = CreateWindowExW(
        WS_EX_CLIENTEDGE | WS_EX_TOOLWINDOW,
        L"EDIT", winit,
        WS_POPUP | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL | ES_LEFT,
        px, py, pxW, pxH,
        hostWnd, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!hwnd) return false;

    // 默认系统 EDIT 样式（白底黑字）——与 AE 原生参数聚焦时的白色输入框一致，
    // 避免深色自绘与系统控件混搭的割裂感；数字左对齐。
    // 字号对齐默认框：Drawbot 默认字号（逻辑像素）→ 编辑框 lfHeight（物理像素）。
    // 绘图在 DIP 空间，编辑框是物理像素窗口，故按 DPI 缩放系数换算出物理字高。
    s_editFont = nullptr;
    HFONT hfont = static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
    if (s_drawbotFontSize > 0.0f) {
        LOGFONTW lf;
        if (GetObjectW(hfont, sizeof(lf), &lf)) {
            // Drawbot GetDefaultFontSize 返回的是 DIP/逻辑像素（与 ECW 的
            // current_frame 同坐标系），编辑框是物理像素窗口 → 只需乘 DPI 缩放。
            // 注意：不能乘 96/72（那是"点→DIP"，Drawbot size 已是 DIP，再乘会
            // 放大 1.333 倍，导致编辑框数字比默认自绘框大）。
            lf.lfHeight = -static_cast<LONG>(std::lround(s_drawbotFontSize * scale));
            s_editFont = CreateFontIndirectW(&lf);
            hfont = s_editFont;
        }
    }
    SendMessageW(hwnd, WM_SETFONT, reinterpret_cast<WPARAM>(hfont), TRUE);
    SendMessageW(hwnd, EM_SETLIMITTEXT, 38, 0);
    SendMessageW(hwnd, EM_SETSEL, 0, -1);   // 全选，直接输入即替换

    s_editOldProc = reinterpret_cast<WNDPROC>(
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(ValueEditWndProc)));
    s_editHwnd = hwnd;
    // 编辑会话状态写入本实例条目（不存在则创建）；旧条目若残留脏状态
    // （实例销毁后悬空、effect_ref 地址复用），这里整体覆写复位
    EditInstanceState& st = s_editByInstance[in_data->effect_ref];
    st.edit = EditState{};   // 整体复位后再填本次会话字段
    st.edit.active = true;
    st.edit.slot = slot;
    st.edit.comp = comp;
    st.edit.rect = f;
    st.edit.pendingCommit = false;
    st.edit.pendingPersist = false;
    st.edit.dirty = false;
    st.edit.openTick = GetTickCount();
    st.edit.owner = hostWnd;   // 宿主窗口（销毁后 InvalidateRect 触发 ECW 重绘）
    // 记录数值框屏幕中心（物理像素），供 Enter 提交后合成点击定位（postPersistClickSynthetic）
    st.valueBoxCX = px + pxW / 2;
    st.valueBoxCY = py + pxH / 2;
    st.valueBoxValid = true;
    // 记录宿主窗口开窗矩形（注入前按当前矩形重算落点用）
    st.ownerRectValid = (st.edit.owner != nullptr) && GetWindowRect(st.edit.owner, &st.ownerOpenRect);
    st.lastTouch = GetTickCount();
    s_editWndOwnerRef = in_data->effect_ref;   // 记录编辑框窗口归属实例
    SetFocus(hwnd);
    return true;
}

void drawPoint(PF_InData* in_data, DRAWBOT_Suites* dbs, DRAWBOT_SurfaceRef surface, DRAWBOT_SupplierRef supplier,
               const PF_Rect& f, int slot, const glsl::Param& p, const float v[kFloatsPerSlot]) {
    const int h = f.bottom - f.top;
    // 左侧 "+" 图标（两段细线）：整框纵向居中画一次——各行共用同一左边界，
    // 图标是整组的分量堆叠标记，不随行重复。
    const int gl = f.left + 4;
    const int gc = gl + kPointGlyphW / 2;
    const int cyAll = f.top + h / 2;
    fillRectPx(dbs, surface, supplier, gc - 1, cyAll - 5, gc + 1, cyAll + 5, &col::TextDim);
    fillRectPx(dbs, surface, supplier, gc - 5, cyAll - 1, gc + 5, cyAll + 1, &col::TextDim);

    const int n = drawCompCount(p);
    // 取证一行：把「AE 实际给的控件框高度」与「绘制行数」并排记下——两者不匹配
    // （AE 未采纳运行期下发的 ui_height、或差值没发出去）时会立刻在日志里现形，
    // 症状是向量被压扁、数值框互相重叠。
    //
    // **去重必须按槽位做，不能只靠 rfDiag 那条"与上一行不同才落"**：
    // 本函数每帧被逐槽调用，各槽的行互不相同 → rfDiag 比对的"上一行"永远不等，
    // 多槽并存时等于**逐帧逐槽刷日志**：吃掉 rfLog 的 4000 条预算（该预算被 rf-* 崩溃
    // 阶段诊断依赖，见 renderer.cpp），且每行一次开/写/关盘进到绘制热路径——
    // 正是 rfDiag 注释里说它自己要避免的事。故在调用点按槽位记上次形态，真变了才落。
    if (slot >= 0 && slot < host::kMaxParams) {
        static int s_lastH[host::kMaxParams] = {0};
        static int s_lastRows[host::kMaxParams] = {0};
        if (s_lastH[slot] != h || s_lastRows[slot] != n) {
            s_lastH[slot] = h;
            s_lastRows[slot] = n;
            char d[96];
            std::snprintf(d, sizeof(d), "slot-rect slot=%d h=%d rows=%d", slot, h, n);
            rfDiag(d);
        }
    }
    static const char* labels[] = {"x", "y", "z", "a"};
    for (int c = 0; c < n; ++c) {
        float lo = 0.0f, hi = 1.0f;
        rangeFor(p, c, &lo, &hi);
        int rt, rb, labL;
        pointRowGeom(f, p, c, &rt, &rb, &labL, nullptr, nullptr, nullptr);
        const int rowH = rb - rt;
        const int cy = rt + rowH / 2;
        // 文本基线：沿用 f.top + (h + 12) / 2 - 1，只是把整框高度换成行高
        const int textY = rt + (rowH + 12) / 2 - 1;
        // 分量标签（行首，弱化）
        drawText(dbs, surface, supplier, labL + 2, textY, labels[c], &col::TextDim);
        // 迷你滑块（标签后到数值框之间）——独占整行，故滑轨长度是并排布局的数倍
        int tL = 0, tW = 0;
        pointTrackSpan(f, &tL, &tW);
        {
            const float t = clampf((v[c] - lo) / (hi - lo), 0.0f, 1.0f);
            drawTrack(dbs, surface, supplier, tL, tW, cy, t);
        }
        // 数值输入框：该行右侧 kTextWidth 段，点击可输入数字（与 float 滑块一致）。
        // 矩形与命中判定、编辑浮窗同源（valueBoxRect）——绘制框 == 命中框。
        const bool ed = editingThis(in_data, slot, c);
        const DRAWBOT_ColorRGBA* border = ed ? &col::Fill : &col::TextDim;
        const BoxRect bx = valueBoxRect(f, ControlKind::Point, p, c);
        fillRoundRectPx(dbs, surface, supplier, bx.L, bx.T, bx.R, bx.B, 2.0f, border);
        fillRoundRectPx(dbs, surface, supplier, bx.L + 1, bx.T + 1, bx.R - 1, bx.B - 1,
                        1.5f, &rgba(0.12f, 0.12f, 0.14f));
        if (!ed) {
            char buf[64];
            formatValue(buf, sizeof(buf), v[c]);
            drawText(dbs, surface, supplier, bx.L + 4, textY, buf, &col::Text);
        }
    }
}

void drawSwatch(DRAWBOT_Suites* dbs, DRAWBOT_SurfaceRef surface, DRAWBOT_SupplierRef supplier,
                const PF_Rect& f, const glsl::Param& p, const float v[kFloatsPerSlot]) {
    const int h = f.bottom - f.top;
    const int cy = f.top + h / 2;
    // 色块：深色描边 + 内芯颜色（圆角 2px）
    DRAWBOT_ColorRGBA sw = rgba(clamp01(v[0]), clamp01(v[1]), clamp01(v[2]));
    fillRoundRectPx(dbs, surface, supplier, f.left + kInset, f.top + 2,
                    f.left + kInset + kSwatchWidth, f.bottom - 2, 2.0f, &rgba(0.9f, 0.9f, 0.9f));  // 描边
    fillRoundRectPx(dbs, surface, supplier, f.left + kInset + 1, f.top + 3,
                    f.left + kInset + kSwatchWidth - 1, f.bottom - 3, 1.5f, &sw);                   // 内芯

    int textX = f.left + kInset + kSwatchWidth + 8;
    if (p.type == glsl::ParamType::Vec4) {
        // alpha 滑条（胶囊轨道 + 圆形滑块，与 Slider 同款）
        const int al = f.left + kInset + kSwatchWidth + 8;
        const int aw = (std::max)(40, kAlphaWidth);
        drawTrack(dbs, surface, supplier, al, aw, cy, clamp01(v[3]));
        textX = al + aw + 8;
    }
    char buf[96];
    std::snprintf(buf, sizeof(buf), "%.3g %.3g %.3g", v[0], v[1], v[2]);
    drawText(dbs, surface, supplier, textX, f.top + (h + 12) / 2 - 1, buf, &col::Text);
}

// —— 拖拽宽度（值映射的横向基准）——
int dragWidth(const PF_Rect& f, ControlKind kind, const glsl::Param& p) {
    switch (kind) {
    case ControlKind::Slider: return (std::max)(1, f.right - f.left - kTextWidth - kInset);
    case ControlKind::Swatch:
        return (p.type == glsl::ParamType::Vec4) ? (std::max)(40, kAlphaWidth) : 1;
    case ControlKind::Point:
    default: {
        // 与可见轨道同宽（见 pointTrackSpan）：拖拽灵敏度 = 滑块可见行程，
        // 点击/拖拽落点与滑块位置一一对应。
        int tW = 0;
        pointTrackSpan(f, nullptr, &tW);
        return tW;
    }
    }
}

// —— 控件交互 ——
// 返回值：是否命中并修改了值；kind==Swatch 时色块点击走取色器
struct HitResult { bool hit; int comp; };

HitResult hitTest(const PF_Rect& f, const glsl::Param& p, ControlKind kind, int px, int py) {
    HitResult r{false, -1};
    // 拖拽带**只包住可见的轨道**（kTrackBandH），与数值框带（kValueBoxH）分开：
    // 两者统一成一条大带会让"点轨道上方 6-8px 也拖得动"。
    int bandT = f.top, bandB = f.bottom;
    trackBand(f, &bandT, &bandB);
    switch (kind) {
    case ControlKind::Slider: {
        const int trackL = f.left + kInset;
        const int trackW = (std::max)(1, sliderTrackR(f) - trackL);
        if (px >= trackL && px <= trackL + trackW && py >= bandT && py <= bandB) {
            r.hit = true; r.comp = 0;
        }
        break;
    }
    case ControlKind::Point: {
        // 按行判定：命中的是**该行**，纵向只在行内居中的拖拽带里才算拖拽。
        // 若按列切分（px 定位列），纵向用整框的一条带——多行后那会把三行
        // 都算成同一行，上下两行点不动。
        const int start = f.left + kInset + kPointGlyphW;
        const int n = drawCompCount(p);
        if (px >= start && px < f.right) {
            for (int c = 0; c < n; ++c) {
                int rt = 0, rb = 0, numL = 0, numR = 0;
                pointRowGeom(f, p, c, &rt, &rb, nullptr, nullptr, &numL, &numR);
                const int cy = rt + (rb - rt) / 2;
                const int bt = (std::max)(rt, cy - kTrackBandH / 2);
                const int bb = (std::min)(rb, cy + kTrackBandH / 2);
                if (py < bt || py > bb) continue;
                r.hit = true;
                r.comp = c;
                // 数值输入框区域不触发拖拽（handleClick 先处理打开编辑框）
                if (px >= numL && px <= numR) r.hit = false;
                break;
            }
        }
        break;
    }
    case ControlKind::Swatch: {
        const int sl = f.left + kInset;
        if (px >= sl && px <= sl + kSwatchWidth && py >= f.top + 2 && py <= f.bottom - 2) {
            r.hit = true; r.comp = -2;  // -2 = 色块（取色器）
        } else if (p.type == glsl::ParamType::Vec4) {
            const int al = f.left + kInset + kSwatchWidth + 8;
            const int aw = (std::max)(40, kAlphaWidth);
            if (px >= al && px <= al + aw && py >= bandT && py <= bandB) {
                r.hit = true; r.comp = 3;
            }
        }
        break;
    }
    }
    return r;
}

// —— 槽位值访问（原生参数）——
// 每槽 4 分量 = 4 个 PF_Param_FLOAT_SLIDER（分量 c → 索引 5+4i+c）。都是 AE 原生
// 参数，读写直接访问 params[] 联合体字段；存储/持久化/关键帧插值由 AE 负责
//（旧的 16B ARBITRARY 句柄与 4×4B 原子读写机制整体移除）。

// 取色器模态快照。PF_AppColorPickerDialog 内部跑嵌套消息循环，期间的 DRAW 里
// params[].u 不保证有效——原生参数会读成垃圾浮点（inf/1e38），面板就画成乱值；
// 读 ARBITRARY 句柄时拿不到就失败、不画，所以没暴露。故打开前存一份，期间照它画。
bool s_pickerOpen = false;
int s_pickerSlot = -1;
float s_pickerSnapshot[kFloatsPerSlot] = {0.0f, 0.0f, 0.0f, 0.0f};

// 读 4 分量（缺失分量按 0）。返回 false = 任一分量参数不可用。
bool readSlot4(PF_ParamDef* params[], int slot, float v[kFloatsPerSlot]) {
    v[0] = v[1] = v[2] = v[3] = 0.0f;
    for (int c = 0; c < kFloatsPerSlot; ++c) {
        const int pi = slotCompIndex(slot, c);
        if (pi < 0 || !params || !params[pi]) return false;
        v[c] = static_cast<float>(params[pi]->u.fs_d.value);
    }
    return true;
}

// 写单分量（comp 0..3 → 对应分量滑条）
void writeSlotComp(PF_ParamDef* params[], int slot, int comp, float val) {
    const int pi = slotCompIndex(slot, comp);
    if (pi < 0 || !params || !params[pi]) return;
    params[pi]->u.fs_d.value = val;
}

// 写全 4 分量（切换 shader 文件时重置为新文件声明的默认值）
void writeSlot4(PF_ParamDef* params[], int slot, const float v[kFloatsPerSlot]) {
    for (int c = 0; c < kFloatsPerSlot; ++c) writeSlotComp(params, slot, c, v[c]);
}

// 置变更标志让 AE 持久化（仅 PF_Cmd_EVENT 的 DO_CLICK/DRAG 等有效事件里生效）。
// 4 个分量参数都要置位才能完整持久化整槽。
void markSlotChanged(PF_ParamDef* params[], int slot) {
    for (int c = 0; c < kFloatsPerSlot; ++c) {
        const int pi = slotCompIndex(slot, c);
        if (params && pi >= 0 && params[pi]) {
            params[pi]->uu.change_flags |= PF_ChangeFlag_CHANGED_VALUE;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// 切换文件 → 槽位值重置为新文件声明的默认值（单点实现）
// ═══════════════════════════════════════════════════════════════════
// 两个使用方**必须共用本函数**（否则「切完即新文件默认值」的规则会分裂成两份）：
//   ① 手动点击切文件：handleFileSelectorClick（DO_CLICK，合法写值上下文）；
//   ② 脚本切文件：UPDATE_PARAMS_UI 只登记「待重置」，随后在下一个合法写值上下文
//      由 consumePendingSlotReset 调用本函数。
// 规则本体 = params.h ecwDefault4（与 PARAMS_SETUP 注册槽位 dephault 同一处）。
// 写 params[].u.fs_d.value + 置 PF_ChangeFlag_CHANGED_VALUE **只能在 SDK 允许写参数
// 值的上下文执行**：PF_Cmd_EVENT 的 DO_CLICK/DRAG/KEYDOWN，或 PF_Cmd_USER_CHANGED_PARAM
//（AE_Effect.h:2250）。在 PF_Cmd_UPDATE_PARAMS_UI 调用会被 AE 丢弃，并触发「逐帧
// FORCE_RERENDER + ECW 反复重建」（AE_Effect.h:1111-1113：该阶段只允许 cosmetic 改动）。
void resetSlotsToFileDefaults(PF_InData* in_data, PF_ParamDef* params[], int fileIdx) {
    if (!params) return;
    // 身份优先：库增删后位置会位移，`fileIdx` 可能已指向别的文件；实例记住的名字
    // 才是"要取谁的默认值"的依据（无名/已删 → 回退 fileIdx，与改动前一致）。
    const std::string nm = InstanceShaderName(in_data, params);
    const ShaderSnapshot snap = getShaderByIdentity(nm, fileIdx, /*checkReload=*/true,
                                                    /*forRender=*/false, nullptr);
    for (size_t i = 0; i < snap.uniforms.size() && i < (size_t)kMaxParams; ++i) {
        float dv[kFloatsPerSlot];
        ecwDefault4(snap.uniforms[i], dv);
        writeSlot4(params, static_cast<int>(i), dv);
        markSlotChanged(params, static_cast<int>(i));
    }
}

// —— 脚本切文件：槽位值「待重置」登记 + 在下一个真实合法写值上下文消费 ——
// 症状：fx.property(kIdxFileIndexParam).setValue(N) 后渲染与槽位名都跟随，但
// property(5..132) 仍是上一文件留下的旧值；手动点击选择器切文件则会被重置为新
// 文件声明的默认值——两条路径行为不一致。
// 约束：脚本写的索引本插件只能在 PF_Cmd_UPDATE_PARAMS_UI 观测到，而该阶段
// **禁止写参数值/置 CHANGED_VALUE**（AE_Effect.h:1111-1113）。故该阶段只登记
// 「待重置」（零参数写入）；真正的重置在用户下一次与 ECW 交互的真实合法写值
// 上下文（PF_Cmd_EVENT 的 DO_CLICK，即 handleClick）由 consumePendingSlotReset
// 执行，复用与手动点击完全相同的单点实现（resetSlotsToFileDefaults）。
// 【已否决方案】合成鼠标输入（向本实例选择器控件注入一次真实
// 点击）把「待重置」确定性推进到 DO_CLICK，并为此在 DRAW 阶段调用客户坐标→屏幕
// 坐标换算套件登记控件落点（含反算自校验）。实测该换算套件在 DRAW 阶段调用会
// 触发 AE 内部错误「can only be called during valid events」（SDK 只允许在合法
// 事件上下文调用，DRAW 不在其列），故整条合成输入链（鼠标注入、延迟注入定时器、
// 抑制标记状态、DRAW 落点登记与自校验）**整体移除**。现为纯被动：只登记，等用户
// 下次在 ECW 里做任何操作（点击/拖拽——拖拽必先经 DO_CLICK）时在真实事件里消费。
// 取舍（如实记录）：脚本切文件的默认值重置会**延迟到用户下一次与 ECW 交互时**
// 发生；若用户不交互则槽位保留旧值（可接受的降级，换取不触发 AE 内部错误）。
struct SlotResetState {
    int fileIdx = -1;              // 待重置到的文件索引（-1 = 无待重置）
};
static std::map<void*, SlotResetState> s_slotReset;

// 登记「待重置」（UPDATE_PARAMS_UI 上下文，**零参数写入**——不写 value、不置
// CHANGED_VALUE，也不注入任何合成输入、不挂定时器）。
void requestSlotResetForFileIndexImpl(PF_InData* in_data, PF_ParamDef* params[]) {
    if (!in_data || !in_data->effect_ref || !params) return;
    s_slotReset[in_data->effect_ref].fileIdx = fileSelIndex(in_data, params);   // 与渲染/选择器同一真相源
}

// 合法写值上下文（handleClick 的 DO_CLICK，或经其先到的 DRAG 序列）消费待重置：
// 把槽位值重置到待重置文件声明的默认值（单点实现）。返回 true = 本次消费了
// 待重置（调用方须置 PF_EO_HANDLED_EVENT，AE_Effect.h:2255）。消费即清标记
//（一次性，不逐帧重复重置）。
bool consumePendingSlotReset(PF_InData* in_data, PF_ParamDef* params[]) {
    if (!in_data || !params) return false;
    auto it = s_slotReset.find(in_data->effect_ref);
    if (it == s_slotReset.end() || it->second.fileIdx < 0) return false;
    const int idx = it->second.fileIdx;
    it->second.fileIdx = -1;
    resetSlotsToFileDefaults(in_data, params, idx);
    return true;
}

// 实例销毁（ShutdownInstanceUI）：拆除本实例的待重置状态（防 effect_ref 地址
// 复用误读旧索引 → 新实例被误重置）
void releaseSlotReset(void* ref) {
    if (!ref) return;
    s_slotReset.erase(ref);
}

// —— 事件处理 ——
// 文件选择器（kIdxFileSelector）与「重算结算器」按钮（kIdxSolveBtn）的绘制/点击：
// 定义在文件后部（handleCursor 之后），handleDraw/handleClick 先引用，这里前置声明。
void drawFileSelector(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                      PF_EventExtra* extra);
void handleFileSelectorClick(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                             PF_EventExtra* extra);
void drawSolveResetBtn(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                       PF_EventExtra* extra);
void handleSolveResetBtnClick(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                              PF_EventExtra* extra);

// —— 「重算结算器」按钮控件的按下态与可用性判据 ——
// 位置：独立控件行（params.h kIdxSolveBtn），视觉上是「启用三维灯光」的下一行。
// 按下反馈语义：**按住时亮、松开即复原**——不是"亮 500ms"的持久高亮。
// ECW 只有 DO_CLICK（按下）没有 MOUSE_UP，故按下态在绘制期用 GetAsyncKeyState
// 复核物理左键：松手后的下一次重绘（悬停移动/再点/面板滚动/重算引发的重渲）即复原；
// 另设 2s 上限兜底，避免"按住不动后松手且再无任何事件"时永久停在按下态。
// 定义在事件分发之前（handleDrag/handleCursor/handleClick 都要用）。
static std::chrono::steady_clock::time_point s_solveBtnPressTick = std::chrono::steady_clock::now();
static bool s_solveBtnPressed = false;
static bool s_solveBtnHover = false;
void solveResetButtonPress() {
    s_solveBtnPressed = true;
    s_solveBtnPressTick = std::chrono::steady_clock::now();
}
bool solveResetButtonPressed() {
    if (!s_solveBtnPressed) return false;
    if ((GetAsyncKeyState(VK_LBUTTON) & 0x8000) == 0) {   // 物理左键已松 → 立即复原
        s_solveBtnPressed = false;
        return false;
    }
    const auto held = std::chrono::steady_clock::now() - s_solveBtnPressTick;
    if (held > std::chrono::seconds(1)) {                 // 兜底上限
        s_solveBtnPressed = false;
        return false;
    }
    return true;
}
// 拖拽把指针带出按钮 = 取消按下（标准按钮手感）
void solveResetButtonCancelPress() { s_solveBtnPressed = false; }

// —— 解算进度条 ——
// 为什么用定时器轮询而不是 PF_Event_IDLE：IDLE 实测几乎不派发（见 handleIdle 注释），
// 靠它刷新会在整个解算期间一动不动。定时器经 SetTimer(NULL) 在 AE 主线程消息循环派发
//（与按下态复原同款），250ms 一次只读四个原子量、没在解算时零开销。
// 覆盖范围：重算按钮、切文件、拖时间轴——任何触发重解的路径都能看到进度。
static UINT_PTR s_progTimer = 0;
// 上一次轮询时是否在解算：用来把"解算刚结束"这一次单独放行去重绘一次。
// 少了它，进度条一旦画上就没有下一个人来擦——解算结束时活性归 0，本回调直接
// return，ECW 停在最后一帧的百分比（"解算中 87%·218/250 帧"）直到用户碰巧制造出
// 别的重绘事件（鼠标划过控件、改参数）才恢复成按钮。窗口期的观感就是"卡在 87%"。
static bool s_progWasActive = false;
void CALLBACK solveProgressTimerProc(HWND, UINT, UINT_PTR, DWORD) {
    const host::SolverProgress prog = host::solverProgress();
    if (!prog.active) {
        if (!s_progWasActive) return;       // 一直空闲：零开销轮询
        s_progWasActive = false;            // 刚结束：放行这一次，把按钮画回来
    } else {
        s_progWasActive = true;
    }
    HWND w = GetActiveWindow();
    if (w && IsWindow(w)) {
        RedrawWindow(w, nullptr, nullptr,
                     RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW | RDW_ERASE);
    }
}
void armSolveProgressTimer() {
    if (s_progTimer) return;                        // 只挂一次，常驻到进程结束
    s_progTimer = SetTimer(nullptr, 0, 250, solveProgressTimerProc);
}

// 按下态复原定时器：ECW 没有 MOUSE_UP，松手后不会自动来事件 → 用 60ms 轮询物理
// 左键，一旦松手立即重绘一次（否则按钮会一直停在按下态，直到用户碰巧制造出别的
// 事件）。回调经 SetTimer(NULL) 在 AE 主线程消息循环派发（与事件回调同线程，
// 见 persistClickTimerProc 同款说明）；重绘用 Win32 InvalidateRect 打 AE 主窗口
//（与 selWheelConsumeImpl 的重绘手法同款，PF_InvalidateRect 只在事件上下文合法）。
static UINT_PTR s_solveBtnTimer = 0;
static HWND s_solveBtnWindow = nullptr;
void CALLBACK solveBtnTimerProc(HWND, UINT, UINT_PTR, DWORD);
void armSolveBtnReleaseTimer(HWND owner) {
    s_solveBtnWindow = owner ? owner : GetActiveWindow();
    if (s_solveBtnTimer) KillTimer(nullptr, s_solveBtnTimer);
    s_solveBtnTimer = SetTimer(nullptr, 0, 60, solveBtnTimerProc);
}
void CALLBACK solveBtnTimerProc(HWND, UINT, UINT_PTR, DWORD) {
    if (solveResetButtonPressed()) return;   // 仍按住（且未超上限）→ 继续轮询，保持按下态
    if (s_solveBtnTimer) {
        KillTimer(nullptr, s_solveBtnTimer);
        s_solveBtnTimer = 0;
    }
    // 重绘：InvalidateRect 实测不足以让 ECW 重绘（Drawbot 控件由 AE 自己调度），
    // RedrawWindow + ALLCHILDREN|UPDATENOW 更强，仍失败则退回"下一次自然事件"
    //（悬停移动等）——那时 handleCursor 会复核并重绘。
    if (s_solveBtnWindow) {
        RedrawWindow(s_solveBtnWindow, nullptr, nullptr,
                     RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW | RDW_ERASE);
    }
    s_solveBtnWindow = nullptr;
}

// 「重算」是否可用：**唯一判据**（绘制/命中/置灰三处共用——三处各写一遍必然漂移，
// 本仓库反复踩过"两侧不同步"的坑）。判据 = 当前选中文件是 @solve。
bool solveResetAvailable(PF_InData* in_data, PF_ParamDef* params[]) {
    if (!params) return false;
    int selIdx = kDefaultFileIndex;
    fileSelState(in_data, params, &selIdx, nullptr);
    if (selIdx < 0) selIdx = kDefaultFileIndex;
    return host::shaderIterMode(host::shaderPathForIndex(selIdx)) == glsl::IterMode::Solver;
}

// 将编辑框提交的待写值写入参数并强制重渲染合成（DO_CLICK / IDLE / ACTIVATE 等
// AE 事件回调内调用）。WndProc 里只解析文本存归属实例条目的 edit.pendingVal，
// 真正写参数必须在有 in_data/params 的 AE 事件回调内完成（缓存 handle 在消息
// 循环期间会失效）。
// 钳制到控件范围（与滑块拖拽一致）。
// 持久化机制：SDK 规定 PF_ChangeFlag_CHANGED_VALUE 仅在 DO_CLICK/DRAG/KEYDOWN
// 事件中生效（AE_Effect.h:2250），DRAW/IDLE/ACTIVATE 里设置无效。故：
//   - validEvent=true（DO_CLICK/DRAG）：写句柄 + change_flags → AE 持久化。
//   - validEvent=false（DRAW/IDLE/ACTIVATE）：只写句柄供立即显示；持久化由随后
//     的合成 DO_CLICK（Enter）或自然点击的 handleClick 补 change_flags 完成。
static void flushPendingCommit(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                               bool validEvent = false) {
    // 只消费**本实例**的待写值——读进程级 s_edit 时，A 实例输入的值
    // 会被 B 实例的事件用 B 的 params 写入 B 的同号槽位（本缺陷核心路径）
    EditInstanceState* st = editStateOf(in_data);
    if (!st) return;
    // 悬空防御：实例销毁后无人消费的 pending 在 effect_ref 地址被新实例复用
    // 时会误写 stale 值——会话静默超过 60s 视为悬空丢弃
    if (st->edit.pendingCommit || st->edit.pendingPersist) {
        if (GetTickCount() - st->lastTouch > 60000) {
            st->edit.pendingCommit = false;
            st->edit.pendingPersist = false;
            return;
        }
    }
    // pendingCommit（值尚未写句柄）或 pendingPersist（值已写句柄但缺有效事件补
    // change_flags）任一存续时都处理。关键：DRAW/IDLE/ACTIVATE 首 flush 只消费
    // pendingCommit 写句柄，**保留** pendingPersist，等随后合成 DO_CLICK 在有效
    // 事件里补 change_flags。若在 DRAW 里顺手把 pendingCommit 清零就放弃了后续
    // 持久化机会 → 值只显示不落盘，AE 重载即回滚（Enter 后闪一下变回原值）。
    if (!st->edit.pendingCommit && !st->edit.pendingPersist) return;
    if (slotParamIndex(st->edit.slot) < 0) {
        st->edit.pendingCommit = false;
        st->edit.pendingPersist = false;
        return;
    }
    glsl::Param p;
    float val = st->edit.pendingVal;
    if (uniformAt(in_data, params, st->edit.slot, &p)) {
        float lo = 0.0f, hi = 1.0f;
        rangeFor(p, st->edit.comp, &lo, &hi);
        val = clampf(val, lo, hi);
    }
    // 写原生参数（该槽位对应分量的 FLOAT_SLIDER），AE 自行处理存储
    writeSlotComp(params, st->edit.slot, st->edit.comp, val);
    st->edit.pendingCommit = false;
    // 有效事件（DO_CLICK/DRAG）才设 change_flags 持久化；DRAW/IDLE/ACTIVATE 中
    // 设置无效（AE_Effect.h:2250），保留 pendingPersist 交给合成 DO_CLICK 补。
    if (validEvent) {
        markSlotChanged(params, st->edit.slot);
        st->edit.pendingPersist = false;
        uiDebug("[flush] CHANGED_VALUE set (validEvent) slot=%d val=%.2f", st->edit.slot, val);
    }
    // FORCE_RERENDER 任意 EVENT 有效：强制重渲染合成
    if (out_data) out_data->out_flags |= PF_OutFlag_FORCE_RERENDER;
}

PF_Err handleDraw(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_EventExtra* extra) {
    // 编辑框销毁后 ECW 重绘（DRAW）是最可靠的后续事件——ACTIVATE/IDLE 在
    // 编辑框打开/销毁间隙可能不触发（WS_POPUP 持焦点时 AE 暂停 IDLE），
    // 这里兜底 flush 编辑框提交值，保证 Enter 后立即应用。
    flushPendingCommit(in_data, out_data, params);
    if (extra->effect_win.area != PF_EA_CONTROL) return PF_Err_NONE;
    const int idx = static_cast<int>(extra->effect_win.index);
    if (idx == kIdxFileSelector) {
        // 滚轮消费主路径：钩子吃掉滚轮后 InvalidateRect 触发本 DRAW——应用待滚
        // 行数后绘制（IDLE 实测几乎不派发——事件计数 evt-type10 全程仅 1 次，
        // 不能作消费路径；ADJUST_CURSOR 兜底在 handleCursor，仅覆盖伴随的鼠标移动）
        selWheelApplyIdle(in_data, out_data, params, extra);
        drawFileSelector(in_data, out_data, params, extra);
        return PF_Err_NONE;
    }
    if (idx == host::kIdxSolveBtn) {
        drawSolveResetBtn(in_data, out_data, params, extra);
        return PF_Err_NONE;
    }
    const int slot = slotFromIndex(idx);
    if (slot < 0) return PF_Err_NONE;

    const PF_Rect f = extra->effect_win.current_frame;
    ensureSuites(in_data, out_data);
    UiSuites& su = uiSuites();
    if (!su.drawbotReady || !su.cui) return PF_Err_NONE;
    DRAWBOT_Suites* dbs = &su.drawbot;

    DRAWBOT_DrawRef drawRef = nullptr;
    su.cui->PF_GetDrawingReference(extra->contextH, &drawRef);
    if (!drawRef) return PF_Err_NONE;

    DRAWBOT_SurfaceRef surface = nullptr;
    DRAWBOT_SupplierRef supplier = nullptr;
    dbs->drawbot_suiteP->GetSurface(drawRef, &surface);
    dbs->drawbot_suiteP->GetSupplier(drawRef, &supplier);
    if (!surface || !supplier) return PF_Err_NONE;

    // 背景（AE 面板底色）
    DRAWBOT_ColorRGBA bg = rgba(0.18f, 0.18f, 0.20f);
    if (su.app) {
        PF_App_Color c = {0, 0, 0};
        if (su.app->PF_AppGetBgColor(&c) == PF_Err_NONE) {
            constexpr float kInv = 1.0f / 65535.0f;
            bg = rgba(c.red * kInv, c.green * kInv, c.blue * kInv);
        }
    }
    fillRectPx(dbs, surface, supplier, f.left, f.top, f.right, f.bottom, &bg);

    glsl::Param p;
    if (!uniformAt(in_data, params, slot, &p)) {
        // 身份名解析不到（文件被删除/改名）：槽位栏前两行显示文字提醒
        //（slot 0 = 文件名，slot 1 = 后果与操作指引，文案见 uiNoticePolicy.h）；
        // 其余槽位维持灰 "-"。纯绘制：不写参数、不改行高与启用态。
        std::string lostName;
        std::string notice;
        if (slot < 2 && lostShaderIdentity(in_data, params, &lostName)) {
            notice = slotLostNotice(slot, lostName);
        }
        if (!notice.empty()) {
            const int textX = f.left + kInset;
            const int avail = (std::max)(1, f.right - textX - 2);
            fillRectPx(dbs, surface, supplier, f.left, f.top, f.right, f.bottom, &col::WarnBg);
            drawText(dbs, surface, supplier, textX, f.top + (f.bottom - f.top + 12) / 2 - 1,
                     notice.c_str(), &col::Warn, kDRAWBOT_TextAlignment_Left,
                     kDRAWBOT_TextTruncation_EndEllipsis, static_cast<float>(avail));
        } else {
            // 未使用槽位：置灰占位
            drawText(dbs, surface, supplier, f.left + kInset,
                     f.top + (f.bottom - f.top + 12) / 2 - 1, "-", &col::TextDim);
        }
    } else {
        float v[kFloatsPerSlot];
        bool haveV = false;
        if (s_pickerOpen && s_pickerSlot == slot) {
            v[0] = s_pickerSnapshot[0];
            v[1] = s_pickerSnapshot[1];
            v[2] = s_pickerSnapshot[2];
            v[3] = s_pickerSnapshot[3];
            haveV = true;
        } else {
            haveV = readSlot4(params, slot, v);
        }
        if (haveV) {
            switch (kindFor(p)) {
            case ControlKind::Slider: {
                float lo = 0.0f, hi = 1.0f;
                rangeFor(p, 0, &lo, &hi);
                const bool ed = editingThis(in_data, slot, 0);
                drawSlider(dbs, surface, supplier, f, p, v[0], lo, hi, ed);
                break;
            }
            case ControlKind::Point:
                drawPoint(in_data, dbs, surface, supplier, f, slot, p, v);
                break;
            case ControlKind::Swatch:
                drawSwatch(dbs, surface, supplier, f, p, v);
                break;
            }
        }
    }
    extra->evt_out_flags |= PF_EO_HANDLED_EVENT;
    return PF_Err_NONE;
}

PF_Err handleClick(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_EventExtra* extra) {
    const int idx = static_cast<int>(extra->effect_win.index);
    // 消费合成点击抑制标记：Enter 提交后 SendInput 注入的那次 DO_CLICK 仅用于在
    // 有效事件里补 change_flags 持久化，不应重新打开编辑框/触发控件动作。
    // 时间戳守卫：仅抑制注入后 200ms 内的那次点击，避免用户稍后到达的真实点击
    // 被误判为合成点击（否则"第二次点击打不开编辑框"）。
    // 抑制标记是**归属实例**的会话状态——注入的点击物理上落在打开编辑框
    // 实例的数值框上，B 实例的 DO_CLICK 不应误吞 A 的抑制标记（否则 A 的合成
    // 点击到达时不再被抑制 → A 重开编辑框/误触发控件动作）
    const DWORD now = GetTickCount();
    EditInstanceState* st = editStateOf(in_data);
    const bool isSynthetic = st && st->suppressClick && (now - st->suppressClickTick) < 200;
    if (st) st->suppressClick = false;
    // DO_CLICK 是有效事件：对编辑框提交的待写值在此补 change_flags 完成持久化
    // （编辑框失焦/回车产生的待写值，WM_KILLFOCUS 先于 DO_CLICK 到达，先写参数）。
    flushPendingCommit(in_data, out_data, params, /*validEvent=*/true);
    if (isSynthetic) {
        // 合成点击只为触发持久化，值已在 flushPendingCommit 写入，不执行控件动作。
        // 关键：flushPendingCommit 在 PF_Cmd_EVENT 里设了 PF_ChangeFlag_CHANGED_VALUE，
        // SDKL（AE_Effect.h:2255）要求同时设 PF_EO_HANDLED_EVENT，否则 AE 不落盘 → 回滚。
        extra->evt_out_flags |= PF_EO_HANDLED_EVENT;
        uiDebug("[click] synthetic consumed, handled+persisted");
        // 刻意**不**消费脚本切文件的「待重置」：合成点击不是用户对控件的真实操作，
        // 该标记继续留给下一次真实 DO_CLICK（保持「仅真实点击触发重置」的契约）。
        return PF_Err_NONE;
    }
    // 脚本切文件：UPDATE_PARAMS_UI 阶段登记的「待重置」在此（合法写值上下文）
    // 落盘——复用与手动点击完全相同的单点实现 resetSlotsToFileDefaults。
    if (consumePendingSlotReset(in_data, params)) {
        extra->evt_out_flags |= PF_EO_HANDLED_EVENT;
        if (out_data) out_data->out_flags |= PF_OutFlag_FORCE_RERENDER;
        uiDebug("[slotreset] file defaults applied (validEvent DO_CLICK)");
    }
    // —— 只处理**控件区**的事件 ——
    // AE 对同一个参数会分别派发两种区域的 DO_CLICK：PF_EA_CONTROL（控件区，用户真正
    // 点的是数值框/滑条）与 PF_EA_PARAM_TITLE（参数名/标题区），而 `effect_win.current_frame`
    // 是**该区自己的矩形**（AE_EffectUI.h:479-491：PF_EA_NONE/PF_EA_PARAM_TITLE/PF_EA_CONTROL，
    // current_frame = "full frame of the current area"，另有独立的 param_title_frame）。
    // 标题区与控件区不是同一个矩形：窄面板下 AE 会把参数名独占一行、控件放到下一行
    //（实测配对：控件 72,456,329,478 h=22 ↔ 标题 40,432,341,452 h=20——标题正好在控件上方
    // 24px、横向铺满整行）。
    // 不区分 area 时，"点参数名那一行"也被当成点控件、还用标题区的矩形去
    // 算数值框 → 在控件框上方也能点出编辑框、在轨道上方也能拖动滑条（用户实测回执）。
    // handleDraw 一直有同款守卫（area != PF_EA_CONTROL 直接返回），此处补齐。
    // 注意：必须放在 flushPendingCommit / 合成点击消费 / 待重置消费**之后**——那些是
    // 持久化与状态机的合法落点，与 area 无关；只把"控件交互"这一步限定到控件区。
    if (extra->effect_win.area != PF_EA_CONTROL) {
        extra->evt_out_flags |= PF_EO_HANDLED_EVENT;   // 认领但不动作，避免 AE 默认处理
        return PF_Err_NONE;
    }
    if (idx == kIdxFileSelector) {
        handleFileSelectorClick(in_data, out_data, params, extra);
        return PF_Err_NONE;
    }
    if (idx == host::kIdxSolveBtn) {
        handleSolveResetBtnClick(in_data, out_data, params, extra);
        return PF_Err_NONE;
    }
    const int slot = slotFromIndex(idx);
    if (slot < 0) return PF_Err_NONE;
    glsl::Param p;
    if (!uniformAt(in_data, params, slot, &p)) return PF_Err_NONE;

    const PF_Rect f = extra->effect_win.current_frame;
    const int px = extra->u.do_click.screen_point.h;
    const int py = extra->u.do_click.screen_point.v;

    const ControlKind kind = kindFor(p);

    HitResult hit = hitTest(f, p, kind, px, py);
    float v[kFloatsPerSlot];
    if (!readSlot4(params, slot, v)) return PF_Err_NONE;

    // Point 各分量数值输入框：点击打开编辑框（与 float 数值框一致，可精确输入）
    // 命中矩形 = 绘制矩形（valueBoxRect）——纵向不再是整行，横向不再外扩。
    if (kind == ControlKind::Point) {
        const int n = drawCompCount(p);
        for (int c = 0; c < n; ++c) {
            const BoxRect bx = valueBoxRect(f, kind, p, c);
            if (px >= bx.L && px <= bx.R && py >= bx.T && py <= bx.B) {
                char tmp[64];
                formatValueEdit(tmp, sizeof(tmp), v[c]);
                PF_Point clickPt;
                clickPt.h = px;
                clickPt.v = py;
                if (openValueEdit(in_data, f, bx, slot, c, tmp, clickPt)) {
                    extra->evt_out_flags |= PF_EO_HANDLED_EVENT;
                }
                return PF_Err_NONE;
            }
        }
    }

    if (!hit.hit) {
        // 滑条右侧数值框 → 打开非模态 Win32 编辑框
        // （KEYDOWN 在 ECW 不派发，就地输入不可行；编辑框见 openValueEdit）
        const BoxRect bx = valueBoxRect(f, kind, p, 0);
        if (kind == ControlKind::Slider && px >= bx.L && px <= bx.R &&
            py >= bx.T && py <= bx.B) {
            char tmp[64];
            formatValueEdit(tmp, sizeof(tmp), v[0]);   // 编辑框保留 5 位小数精度（默认框显示仍两位）
            PF_Point clickPt;
            clickPt.h = px;
            clickPt.v = py;
            if (openValueEdit(in_data, f, bx, slot, 0, tmp, clickPt)) {
                // 编辑框已创建并聚焦，内容由 Windows 绘制，无需 AE 重绘
                extra->evt_out_flags |= PF_EO_HANDLED_EVENT;
            }
            return PF_Err_NONE;
        }
        // 点击控件空白区：编辑框若打开，失焦（WM_KILLFOCUS）已自动提交，此处无需处理
        return PF_Err_NONE;
    }
    // 命中控件其他区域（滑条/点/alpha/色块）：编辑框若打开，本点击会先使其失焦
    // （WM_KILLFOCUS 自动提交），再触发本事件，故此处无需额外提交逻辑。
    bool changed = false;
    if (hit.comp == -2) {
        // 色块 → AE 原生取色器
        ensureSuites(in_data, out_data);
        PFAppSuite6* app = uiSuites().app;
        if (app) {
            PF_PixelFloat sample, result;
            sample.red = clamp01(v[0]);
            sample.green = clamp01(v[1]);
            sample.blue = clamp01(v[2]);
            sample.alpha = 1.0f;
            // 标题需转 ACP：Tr 返回 UTF-8，而 AE 在 Windows 上以系统代码页(CP_ACP/GBK)
            // 解释标题字符串，直接传 UTF-8 中文会乱码（与 plugin.cpp 的 utf8ToAcp 逻辑一致）。
            static char titleAcp[128] = {0};
            if (!titleAcp[0]) {
                wchar_t wide[64] = {0};
                if (MultiByteToWideChar(CP_UTF8, 0, Tr(S_EFFECTHOST_CUSTOMUI_COLOR_PICKER_TITLE),
                                        -1, wide, 64) > 0) {
                    WideCharToMultiByte(CP_ACP, 0, wide, -1, titleAcp, sizeof(titleAcp), nullptr, nullptr);
                }
            }
            // I-1 安全性（保留）：PF_AppColorPickerDialog 是模态对话框，内部跑嵌套消息
            // 循环，AE 可在其中重建/释放参数存储。因此模态期间**绝不缓存 PF_ParamDef*
            // 指针**——历史审计记录过同模式（持指针穿越
            // 模态消息循环后写回）的 0xC0000005 崩溃，本文件编辑框路径同样因此改为
            // pendingCommit 延迟写入。下方写回一律「调用点现场索引」：模态返回后才由
            // writeSlotComp 现场取 params[slotCompIndex(slot,c)]，不跨模态持任何指针。
            // 为何不用 PF_CHECKOUT_PARAM/PF_CHECKIN_PARAM：checkout/checkin 是参数求值
            // 型路径，在 PF_Cmd_EVENT 的 DO_CLICK 上下文里检出-写-归还不会让 AE 以 UI
            // 变更持久化该值（回归症状：取色器选完颜色不生效）。EVENT 上下文的标准持久化
            // 路径是「直接写 params[索引]->u.fs_d.value + uu.change_flags |=
            // PF_ChangeFlag_CHANGED_VALUE」，与滑块拖拽（handleDrag/flushPendingCommit）
            // 完全一致，由下方 finishChange→markSlotChanged 落盘并触发重渲染。
            s_pickerSlot = slot;
            s_pickerSnapshot[0] = v[0];
            s_pickerSnapshot[1] = v[1];
            s_pickerSnapshot[2] = v[2];
            s_pickerSnapshot[3] = v[3];
            s_pickerOpen = true;
            PF_Err perr = app->PF_AppColorPickerDialog(
                titleAcp[0] ? titleAcp : Tr(S_EFFECTHOST_CUSTOMUI_COLOR_PICKER_TITLE),
                &sample, TRUE, &result);
            s_pickerOpen = false;
            if (perr == PF_Err_NONE) {
                // 模态返回后现场索引写回（不跨模态持指针，见上）：与滑块拖拽同路径。
                writeSlotComp(params, slot, 0, result.red);
                writeSlotComp(params, slot, 1, result.green);
                writeSlotComp(params, slot, 2, result.blue);
                changed = true;
            }
        }
    } else if (hit.comp >= 0) {
        // 滑条/点/alpha：点击按位置绝对值设值 + 开始拖拽
        float lo = 0.0f, hi = 1.0f;
        rangeFor(p, hit.comp, &lo, &hi);
        const int dw = dragWidth(f, kind, p);
        float t = 0.0f;
        if (kind == ControlKind::Slider) {
            t = static_cast<float>(px - (f.left + kInset)) / static_cast<float>(dw);
        } else if (kind == ControlKind::Swatch) {  // alpha
            t = static_cast<float>(px - (f.left + kInset + kSwatchWidth + 8)) / static_cast<float>(dw);
        } else {  // Point：行内可见轨道横向映射（与 drawTrack / dragWidth 同源）
            int tL = 0;
            pointTrackSpan(f, &tL, nullptr);
            t = static_cast<float>(px - tL) / static_cast<float>(dw);
        }
        const float nv = clampf(lo + t * (hi - lo), lo, hi);
        writeSlotComp(params, slot, hit.comp, nv);
        changed = true;
        // 打包拖拽状态，请求 DRAG 事件
        DragState ds;
        ds.slot = slot;
        ds.comp = hit.comp;
        ds.startVal = nv;
        ds.startPx = static_cast<float>(px);
        packDrag(extra->u.do_click.continue_refcon, ds);
        extra->u.do_click.send_drag = TRUE;
    }

    if (changed) finishChange(in_data, out_data, extra, params, idx, /*throttleUpdateNow=*/false);
    return PF_Err_NONE;
}

// —— 数值编辑：IDLE 收尾 ——
// IDLE 是全局事件（无 effect_win.index），重绘用本实例编辑会话条目的 rect 定位控件。
// 只处理两类待办：pendingCommit（写参数 + 强制重渲染合成）、dirty（重绘恢复显示实际值）。
// 编辑框打开期间不在此强制重绘——编辑框是独立 Win32 窗口，内容由 Windows
// 自绘，AE 每帧 invalidate + UPDATE_NOW 只会造成重渲染风暴（卡顿根源，已移除）。
PF_Err handleIdle(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                  PF_EventExtra* extra) {
    // IDLE 是全局事件（会派发给每个实例），各自消费各自条目的
    // pending/dirty——A 提交的待写值不被 B 的 IDLE 误写（旧缺陷路径之一）
    bool needInvalidate = false;
    EditInstanceState* st = editStateOf(in_data);
    if (st && st->edit.pendingCommit) {
        // 写参数 + FORCE_RERENDER（flushPendingCommit 内设置 out_flags）：
        // 强制 AE 重渲染合成，实现 Enter 后立即应用。
        flushPendingCommit(in_data, out_data, params);
        needInvalidate = true;
    }
    if (st && st->edit.dirty) {
        st->edit.dirty = false;
        needInvalidate = true;
    }
    if (needInvalidate) {
        invalidateEditNow(in_data, out_data, extra);
    }
    return PF_Err_NONE;
}

PF_Err handleDrag(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                  PF_EventExtra* extra) {
    // 「重算结算器」按钮：拖拽把指针带出按钮范围 = 取消按下（标准按钮手感，松手不触发）。
    // 本控件不做连续拖拽动作，故只需按下态撤销 + 重绘。
    if (static_cast<int>(extra->effect_win.index) == host::kIdxSolveBtn) {
        if (s_solveBtnPressed) {
            solveResetButtonCancelPress();
            extra->evt_out_flags |= PF_EO_HANDLED_EVENT | PF_EO_UPDATE_NOW;
        }
        return PF_Err_NONE;
    }
    // 编辑框提交的待写值在拖拽前先落盘（点击滑条触发 DO_CLICK → DRAG 序列，
    // 已在 handleClick 处理；此处兜底时序边界，DRAG 是有效事件可补 change_flags）
    flushPendingCommit(in_data, out_data, params, /*validEvent=*/true);
    DragState ds = unpackDrag(extra->u.do_click.continue_refcon);
    // 文件选择器滚动条拖拽（哨兵 slot；comp = 按下时的 grab 偏移 px）：
    // 期望滑块顶 = py - grab → 按行程比例换算滚动偏移并钳制
    if (ds.slot == kSelDragScrollbar) {
        int n = 0;
        {
            auto& gs = globalState();
            CSLock lk(gs.mutex);
            n = static_cast<int>(gs.popupChoices.size());
        }
        if (n > kFileSelMaxRows) {
            const PF_Rect f = extra->effect_win.current_frame;
            const SelScrollGeom g = selScrollGeom(f, n);
            const int travel = g.trackH - g.thumbH;
            const int py = extra->u.do_click.screen_point.v;
            if (travel > 0) {
                const float t = static_cast<float>(py - ds.comp - g.trackTop) / static_cast<float>(travel);
                int scroll = static_cast<int>(t * static_cast<float>(g.scrollMax) + 0.5f);
                scroll = (std::max)(0, (std::min)(scroll, g.scrollMax));
                if (scroll != effectiveFileSelScroll(in_data, params, n, f)) {
                    setFileSelScroll(in_data, params, scroll, n);
                    finishChange(in_data, out_data, extra, params, kIdxFileSelector,
                                 /*throttleUpdateNow=*/true);
                }
            }
        }
        return PF_Err_NONE;
    }
    if (ds.slot < 0 || ds.slot >= kMaxParams || ds.comp < 0 || ds.comp >= kFloatsPerSlot) return PF_Err_NONE;
    glsl::Param p;
    if (!uniformAt(in_data, params, ds.slot, &p)) return PF_Err_NONE;
    const ControlKind kind = kindFor(p);

    const int idx = slotParamIndex(ds.slot);
    if (idx < 0) return PF_Err_NONE;
    const PF_Rect f = extra->effect_win.current_frame;
    const int px = extra->u.do_click.screen_point.h;

    float v[kFloatsPerSlot];
    if (!readSlot4(params, ds.slot, v)) return PF_Err_NONE;

    float lo = 0.0f, hi = 1.0f;
    rangeFor(p, ds.comp, &lo, &hi);
    const int dw = dragWidth(f, kind, p);
    const float delta = static_cast<float>(px - ds.startPx) * (hi - lo) / static_cast<float>(dw);
    const float nv = clampf(ds.startVal + delta, lo, hi);
    if (nv == v[ds.comp]) {   // 值未实际变化（像素微移/精度不足）→ 跳过刷新，减少无效渲染
        return PF_Err_NONE;
    }
    writeSlotComp(params, ds.slot, ds.comp, nv);
    // 拖拽路径节流 UPDATE_NOW：invalidate 照旧（滑块跟手），渲染 ~30Hz（见 finishChange）
    finishChange(in_data, out_data, extra, params, idx, /*throttleUpdateNow=*/true);
    return PF_Err_NONE;
}

PF_Err handleCursor(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                  PF_EventExtra* extra) {
    const int idx = static_cast<int>(extra->effect_win.index);
    if (idx == host::kIdxSolveBtn) {
        extra->u.adjust_cursor.set_cursor = PF_Cursor_FINGER_POINTER;
        // 悬停高亮 + **按下态复核**：松开左键后靠这里的重绘把按钮复原
        //（ECW 没有 MOUSE_UP，见 solveResetButtonPressed 注释）
        const bool hover = solveResetAvailable(in_data, params);
        const bool wasPressed = s_solveBtnPressed;
        const bool stillPressed = solveResetButtonPressed();
        if (hover != s_solveBtnHover || wasPressed != stillPressed) {
            s_solveBtnHover = hover;
            ensureSuites(in_data, out_data);
            if (uiSuites().app) uiSuites().app->PF_InvalidateRect(extra->contextH, &extra->effect_win.current_frame);
        }
        extra->evt_out_flags |= PF_EO_HANDLED_EVENT;
        return PF_Err_NONE;
    }
    if (idx == kIdxFileSelector) {
        extra->u.adjust_cursor.set_cursor = PF_Cursor_FINGER_POINTER;
        // 中键滚轮兜底消费：滚轮时若伴随鼠标移动（ADJUST_CURSOR 派发）立即应用
        // 待滚行数（IDLE 是鼠标静止时的消费路径，两者互为保险）
        selWheelApplyIdle(in_data, out_data, params, extra);
        // 悬停行反馈：展开时按 py 计算行号，变化时 invalidate 重绘（行边界切换才变 → 节流）
        const PF_Rect f = extra->effect_win.current_frame;
        // 中键滚轮：刷新选择器屏幕矩形映射（事件点客户坐标 ↔ GetCursorPos 物理像素；
        // 悬停期间持续校准，面板滚动导致控件位移后仍准确）
        selWheelUpdateScreen(in_data->effect_ref, extra->u.adjust_cursor.screen_point, f);
        int row = -1;
        bool expanded = false;
        fileSelState(in_data, params, nullptr, &expanded);
        if (expanded) {
            const int py = extra->u.adjust_cursor.screen_point.v;
            // C++ 整除向零取整——表头下半区域（偏移 ∈ [-rowH+1, -1]）
            // 会被算成 0 而非 -1，通过下方行号合法性检查后第 0 行被误高亮。
            // 负偏移在整除前置 -1（等价下取整）。
            const int off = py - (f.top + kFileSelHeaderH);
            row = (off < 0) ? -1 : off / kFileSelRowH;
            int n = 0;
            {
                auto& gs = globalState();
                CSLock lk(gs.mutex);
                n = static_cast<int>(gs.popupChoices.size());
            }
            // 悬停行是显示行（滚动窗口内 0..rows-1）；滚动条区域不悬停高亮
            const int px = extra->u.adjust_cursor.screen_point.h;
            if (n > kFileSelMaxRows && px >= f.right - kSelScrollW) row = -1;
            if (row < 0 || row >= (std::min)(n, kFileSelMaxRows)) row = -1;
        }
        if (row != s_selHoverRow) {
            s_selHoverRow = row;
            ensureSuites(in_data, out_data);
            if (uiSuites().app) uiSuites().app->PF_InvalidateRect(extra->contextH, &f);
        }
        return PF_Err_NONE;
    }
    return PF_Err_NONE;
}

// —— 文件选择器（kIdxFileSelector，自绘控件）——
// 折叠：表头行（▶/▼ + 当前文件 + ↻ 刷新）；展开：表头 + 文件列表（点击行切换）。
// 原生 popup 的选项列表无法运行时更新（PF_UpdateParamUI 白名单不含
// num_choices/namesptr），改自绘后列表实时重绘、刷新即时生效。
// 展开/折叠高度：UPDATE_PARAMS_UI 里经 PF_UpdateParamUI(ui_height) 调整
// （官方许可上下文），AE 重新布局 ECW——高度由 SyncFileSelectorUI 按本实例
// 当前状态重算（不再依赖进程级 dirty 标志）。
// ↻ 刷新反馈：记录最近一次刷新点击时间戳，绘制时短时间内高亮 ↻ 图标
static std::chrono::steady_clock::time_point s_lastRefreshTick = std::chrono::steady_clock::now();
bool refreshFlashActive() {
    return std::chrono::steady_clock::now() - s_lastRefreshTick < std::chrono::milliseconds(500);
}

// 「重算结算器」按钮的按下态/可用性判据定义在文件前部（事件分发的前置声明旁）。

int fileSelHeight(PF_InData* in_data, PF_ParamDef* params[]) {
    bool expanded = false;
    fileSelState(in_data, params, nullptr, &expanded);
    if (!expanded) return kFileSelCollapsedH;
    auto& gs = globalState();
    CSLock lk(gs.mutex);
    const int n = static_cast<int>(gs.popupChoices.size());
    int h = kFileSelHeaderH + (std::min)(n, kFileSelMaxRows) * kFileSelRowH;
    if (n > kFileSelMaxRows) h += kFileSelRowH;   // "共 N 个文件" 计数行
    return h;
}

// 滚动条箭头三角（fillRectPx 逐行堆叠，5 行高、底宽 9px ≤ kSelScrollW）
void drawTriUp(DRAWBOT_Suites* dbs, DRAWBOT_SurfaceRef surface, DRAWBOT_SupplierRef supplier,
               int cx, int yTop, const DRAWBOT_ColorRGBA* c) {
    for (int k = 0; k <= 4; ++k)
        fillRectPx(dbs, surface, supplier, cx - k, yTop + k, cx + k + 1, yTop + k + 1, c);
}
void drawTriDown(DRAWBOT_Suites* dbs, DRAWBOT_SurfaceRef surface, DRAWBOT_SupplierRef supplier,
                 int cx, int yBot, const DRAWBOT_ColorRGBA* c) {
    for (int k = 0; k <= 4; ++k)
        fillRectPx(dbs, surface, supplier, cx - k, yBot - k, cx + k + 1, yBot - k + 1, c);
}

void drawFileSelector(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                      PF_EventExtra* extra) {
    (void)out_data;
    const PF_Rect f = extra->effect_win.current_frame;
    ensureSuites(in_data, out_data);
    UiSuites& su = uiSuites();
    if (!su.drawbotReady || !su.cui) return;
    DRAWBOT_Suites* dbs = &su.drawbot;
    DRAWBOT_DrawRef drawRef = nullptr;
    su.cui->PF_GetDrawingReference(extra->contextH, &drawRef);
    if (!drawRef) return;
    DRAWBOT_SurfaceRef surface = nullptr;
    DRAWBOT_SupplierRef supplier = nullptr;
    dbs->drawbot_suiteP->GetSurface(drawRef, &surface);
    dbs->drawbot_suiteP->GetSupplier(drawRef, &supplier);
    if (!surface || !supplier) return;

    // 背景（AE 面板底色）
    DRAWBOT_ColorRGBA bg = rgba(0.18f, 0.18f, 0.20f);
    if (su.app) {
        PF_App_Color c = {0, 0, 0};
        if (su.app->PF_AppGetBgColor(&c) == PF_Err_NONE) {
            constexpr float kInv = 1.0f / 65535.0f;
            bg = rgba(c.red * kInv, c.green * kInv, c.blue * kInv);
        }
    }
    fillRectPx(dbs, surface, supplier, f.left, f.top, f.right, f.bottom, &bg);

    // 选中索引读自本实例隐藏原生参数 kIdxFileIndexParam（真相源，per-instance）、
    // 展开状态读自选择器 ARBITRARY handle f[1]；文件列表仍是进程级（effects/ 目录对全实例一致）
    std::vector<std::string> choices;
    {
        auto& gs = globalState();
        CSLock lk(gs.mutex);
        choices = gs.popupChoices;
    }
    int selIdx = kDefaultFileIndex;
    bool expanded = false;
    fileSelState(in_data, params, &selIdx, &expanded);
    // 身份名解析不到（文件被删除/改名）：表头显示丢失提醒，不高亮任何行——
    // 此时 -1 不回退到位置索引（回退会显示并高亮另一个文件）。
    std::string lostName;
    const bool identityLost = lostShaderIdentity(in_data, params, &lostName);
    // 索引越界（工程恢复的索引超出当前库文件数）才回退显示第一个库文件
    if (!identityLost && (selIdx < 0 || selIdx >= static_cast<int>(choices.size()))) {
        selIdx = kDefaultFileIndex;
    }
    const int hc = f.top + kFileSelHeaderH;
    const int cy = f.top + (kFileSelHeaderH + 12) / 2 - 1;
    // 身份丢失时整行淡橙底；底色先画，展开三角随后绘制（否则三角被底色覆盖）
    if (identityLost) {
        fillRectPx(dbs, surface, supplier, f.left, f.top, f.right, hc - 1, &col::WarnBg);
    }
    // 展开三角 + 当前文件/丢失提醒 + ↻ 刷新
    drawText(dbs, surface, supplier, f.left + 6, cy, expanded ? "\xE2\x96\xBC" : "\xE2\x96\xB6",
             &col::TextDim);   // ▼ / ▶
    if (identityLost) {
        // 与槽位栏同一文案来源（slotLostNotice）；按可用宽度省略，右侧让出 ↻ 位置。
        // 该行位于「Shader 文件」组（默认展开），「参数」组折叠时仍可见。
        const int textX = f.left + 24;
        const int avail = (std::max)(1, f.right - textX - 22);
        const std::string notice = slotLostNotice(0, lostName);
        drawText(dbs, surface, supplier, textX, cy, notice.c_str(), &col::Warn,
                 kDRAWBOT_TextAlignment_Left, kDRAWBOT_TextTruncation_EndEllipsis,
                 static_cast<float>(avail));
    } else {
        const std::string& cur = (selIdx >= 0 && selIdx < static_cast<int>(choices.size()))
                                     ? choices[selIdx] : "?";
        const int textX = f.left + 24;
        const int avail = (std::max)(1, f.right - textX - 22);   // 右侧让出 ↻ 位置
        drawText(dbs, surface, supplier, textX, cy, cur.c_str(), &col::Text,
                 kDRAWBOT_TextAlignment_Left, kDRAWBOT_TextTruncation_EndEllipsis,
                 static_cast<float>(avail));
    }
    // ↻ 刷新：点击后 500ms 内高亮（亮蓝），给用户"已刷新"的即时反馈
    drawText(dbs, surface, supplier, f.right - 20, cy, "\xE2\x86\xBB",
             refreshFlashActive() ? &rgba(0.55f, 0.80f, 1.0f) : &col::TextDim);
    // 表头底部分隔线
    fillRectPx(dbs, surface, supplier, f.left, hc - 1, f.right, hc, &col::Track);

    if (!expanded) {
        // 带本 DRAW 的控件矩形剔除（与 upsert 同口径）——ref 在不同 DRAW
        // 间会变，按 ref 删不掉会把陈旧目标留在表里整会话吞滚轮
        selWheelRemoveTarget(in_data->effect_ref, &f);   // 折叠：滚轮透传面板
        // 诊断（一次性）：本条目出现即证明新构建已加载且选择器绘制到达此函数
        { static bool s_once = false; if (!s_once) { s_once = true; wheelLog("seldraw", 0, (long)choices.size()); } }
        return;
    }
    const int n = static_cast<int>(choices.size());
    const int rows = (std::min)(n, kFileSelMaxRows);
    const int scroll = effectiveFileSelScroll(in_data, params, n, f);
    // 有滚动条时行绘制右缘让出滚动条宽度
    const int rowRight = (n > kFileSelMaxRows) ? f.right - kSelScrollW : f.right;
    for (int i = 0; i < rows; ++i) {
        const int fileIdx = scroll + i;
        if (fileIdx >= n) break;
        const int y0 = hc + i * kFileSelRowH;
        const int y1 = y0 + kFileSelRowH;
        if (fileIdx == selIdx) {
            fillRectPx(dbs, surface, supplier, f.left, y0, rowRight, y1, &col::Fill);
        } else if (i == s_selHoverRow) {
            fillRectPx(dbs, surface, supplier, f.left, y0, rowRight, y1, &col::Hover);
        } else {
            fillRectPx(dbs, surface, supplier, f.left + 4, y1 - 1, rowRight - 4, y1, &col::Track);
        }
        const int textX = f.left + 14;
        const int avail = (std::max)(1, rowRight - textX - 6);   // 右侧让出滚动条
        drawText(dbs, surface, supplier, textX, y0 + (kFileSelRowH + 12) / 2 - 1,
                 choices[fileIdx].c_str(),
                 (fileIdx == selIdx) ? &rgba(1.0f, 1.0f, 1.0f) : &col::Text,
                 kDRAWBOT_TextAlignment_Left, kDRAWBOT_TextTruncation_EndEllipsis,
                 static_cast<float>(avail));
    }
    if (n > kFileSelMaxRows) {
        // 有滚动条：登记本实例滚轮目标（WH_MOUSE_LL 拦截入口——漏登记时
        // targets 恒空钩子永不安装，是滚轮失效的根因）
        selWheelUpsertTarget(in_data->effect_ref, f);
        // 滚动条：轨道 + 上下箭头（点击 ±1 行）+ 滑块（可拖拽）
        const SelScrollGeom g = selScrollGeom(f, n);
        const int sbL = f.right - kSelScrollW;
        const int sbR = f.right - 1;
        const int listBot = hc + rows * kFileSelRowH;
        fillRectPx(dbs, surface, supplier, sbL, hc, sbR, listBot, &col::Track);
        const int cx = (sbL + sbR) / 2;
        drawTriUp(dbs, surface, supplier, cx, hc + 4, &col::TextDim);
        drawTriDown(dbs, surface, supplier, cx, listBot - 5, &col::TextDim);
        const int tTop = selThumbTop(g, scroll);
        fillRectPx(dbs, surface, supplier, sbL + 2, tTop, sbR - 2, tTop + g.thumbH, &col::Thumb);
        char buf[128];
        std::snprintf(buf, sizeof(buf), Tr(S_EFFECTHOST_CUSTOMUI_FILE_COUNT), n);
        drawText(dbs, surface, supplier, f.left + 14, hc + rows * kFileSelRowH + (kFileSelRowH + 12) / 2 - 1,
                 buf, &rgba(0.52f, 0.52f, 0.56f));
    } else {
        // 同上（无滚动条 ≠ 折叠，但同一控件矩形仍须带矩形剔除）
        selWheelRemoveTarget(in_data->effect_ref, &f);   // 无滚动条：滚轮透传面板
    }
    extra->evt_out_flags |= PF_EO_HANDLED_EVENT;
}

// —— 「重算结算器」按钮控件（ARBITRARY_DATA + PF_PUI_CONTROL）——
// 位置：独立控件行（params.h kIdxSolveBtn），视觉上紧接「启用三维灯光」之后。
// 样式：一枚真正的按钮（圆角边框 + 内缩填充 + 居中文字），有悬停与按下反馈。
// 按下反馈语义：**按住时亮、松开即复原**——不是"亮 N 百毫秒"的持久高亮。
// ECW 只有 DO_CLICK（按下）没有 MOUSE_UP，故按下态在**绘制期**用 GetAsyncKeyState
// 复核物理左键：松手后的下一次重绘（悬停移动/再点一次/面板滚动/重算触发的重渲）即
// 复原；另设 2s 上限兜底，避免"按住不动后松手且再无任何事件"永久停在按下态。
// 非结算模式整行置灰且不响应点击（避免"@iterations 下按钮还能点、点了没反应"）。
void drawSolveResetBtn(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                       PF_EventExtra* extra) {
    (void)out_data;
    const PF_Rect f = extra->effect_win.current_frame;
    ensureSuites(in_data, out_data);
    UiSuites& su = uiSuites();
    if (!su.drawbotReady || !su.cui) return;
    DRAWBOT_Suites* dbs = &su.drawbot;
    DRAWBOT_DrawRef drawRef = nullptr;
    su.cui->PF_GetDrawingReference(extra->contextH, &drawRef);
    if (!drawRef) return;
    DRAWBOT_SurfaceRef surface = nullptr;
    DRAWBOT_SupplierRef supplier = nullptr;
    dbs->drawbot_suiteP->GetSurface(drawRef, &surface);
    dbs->drawbot_suiteP->GetSupplier(drawRef, &supplier);
    if (!surface || !supplier) return;

    armSolveProgressTimer();   // ECW 打开着就保持轮询（幂等：只挂一次）
    const bool enabled = solveResetAvailable(in_data, params);
    const bool pressed = enabled && solveResetButtonPressed();
    const bool hover = enabled && s_solveBtnHover;
    const int L = f.left + 2, R = f.right - 2, T = f.top + 3, B = f.bottom - 3;
    if (R <= L || B <= T) return;
    // —— 解算中：本行改画进度条 ——
    // 复用这一行而不是新插一行：位置正好在用户视线处（按下重算/切完文件就在这看结果），
    // 且解算期间按钮本就点不动，不会丢功能。进度由渲染线程发布（见 renderer.h）。
    const host::SolverProgress prog = host::solverProgress();
    if (prog.active && prog.total > 0) {
        int pct = (int)((long long)prog.done * 100 / prog.total);
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        fillRoundRectPx(dbs, surface, supplier, L, T, R, B, 4.0f, &col::TextDim);
        fillRoundRectPx(dbs, surface, supplier, L + 1, T + 1, R - 1, B - 1, 3.0f, &rgba(0.18f, 0.20f, 0.24f));
        const int fillR = L + 1 + (R - L - 2) * pct / 100;
        if (fillR > L + 2) {
            fillRoundRectPx(dbs, surface, supplier, L + 1, T + 1, fillR, B - 1, 3.0f,
                            &rgba(0.25f, 0.55f, 0.85f));
        }
        char label[128];
        std::snprintf(label, sizeof(label), Tr(S_EFFECTHOST_CUSTOMUI_SOLVE_PROGRESS),
                      pct, (int)prog.done, (int)prog.total);
        const int h = f.bottom - f.top;
        drawText(dbs, surface, supplier, (L + R) / 2, f.top + (h + 12) / 2 - 1, label,
                 &col::Text, kDRAWBOT_TextAlignment_Center);
        return;
    }
    // 边框 + 内缩填充（与数值输入框同款"边框挖洞"画法，圆角 4px）
    const DRAWBOT_ColorRGBA* border = !enabled  ? &rgba(0.24f, 0.24f, 0.26f)
                                    : pressed ? &rgba(0.80f, 0.90f, 1.0f) : &col::TextDim;
    const DRAWBOT_ColorRGBA* fill = !enabled  ? &rgba(0.20f, 0.20f, 0.22f)
                                  : pressed ? &rgba(0.55f, 0.80f, 1.0f)
                                  : hover   ? &rgba(0.35f, 0.48f, 0.66f) : &col::Hover;
    fillRoundRectPx(dbs, surface, supplier, L, T, R, B, 4.0f, border);
    fillRoundRectPx(dbs, surface, supplier, L + 1, T + 1, R - 1, B - 1, 3.0f, fill);
    const DRAWBOT_ColorRGBA* textCol = !enabled  ? &rgba(0.44f, 0.45f, 0.48f)
                                     : pressed ? &rgba(0.10f, 0.10f, 0.12f) : &col::Text;
    const int h = f.bottom - f.top;
    drawText(dbs, surface, supplier, (L + R) / 2, f.top + (h + 12) / 2 - 1,
             enabled ? Tr(S_EFFECTHOST_CUSTOMUI_SOLVE_BUTTON)
                     : Tr(S_EFFECTHOST_CUSTOMUI_SOLVE_BUTTON_DISABLED),
             textCol, kDRAWBOT_TextAlignment_Center);
    //      ↑ 按钮文案（启用/置灰）：置灰态点明为什么点不动
}

void handleSolveResetBtnClick(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                              PF_EventExtra* extra) {
    extra->evt_out_flags |= PF_EO_HANDLED_EVENT;   // 认领，避免 AE 默认处理
    if (extra->effect_win.area != PF_EA_CONTROL) return;   // 标题区点击不动作（同其它控件）
    if (!solveResetAvailable(in_data, params)) return;     // 非结算模式：置灰态，不动作
    solveResetButtonPress();
    extra->evt_out_flags |= PF_EO_UPDATE_NOW;              // 立刻画出按下态
    armSolveBtnReleaseTimer(GetActiveWindow());            // 松手后自动复原（无 MOUSE_UP）
    // **缓存失效载体：给「重算代数」+1**（值真变 → AE 失效该帧缓存并重渲）。
    // 为什么不用内存标记重启结算：effect_ref 在 ECW 与渲染两个上下文里不是同一个值
    //（点击侧 -473970576、渲染侧 -1775950160；仓库早有同款记录，
    // 见 selWheelTarget 注释"effect_ref 实测同一控件在不同 DRAW 间会变"）——按 ref 登记
    // 的复位会落进幽灵条目，渲染永远看不到，用户看到的就是"点了重算还是吃缓存"。
    // 渲染侧把该值混进结算参数指纹 → 指纹变即从第 0 帧整体重解（全链路见 params.h）。
    // 写值与置位都在 DO_CLICK 这个合法写值上下文里（AE_Effect.h:2250）。
    if (params && params[host::kIdxSolveGen]) {
        PF_ParamDef* g = params[host::kIdxSolveGen];
        double nv = static_cast<double>(g->u.fs_d.value) + 1.0;
        if (nv > host::kSolveGenValidMax) nv = 0.0;   // 回绕（仅作失效载体，语义无影响）
        g->u.fs_d.value = static_cast<PF_FpLong>(nv);
        g->uu.change_flags |= PF_ChangeFlag_CHANGED_VALUE;
    }
    // FORCE_RERENDER 兜底：值恰好在回绕点相同时（1/9999 概率）仍要重渲一次。
    if (out_data) out_data->out_flags |= PF_OutFlag_FORCE_RERENDER;
    finishChange(in_data, out_data, extra, params, host::kIdxSolveBtn);
}

void handleFileSelectorClick(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                             PF_EventExtra* extra) {
    const PF_Rect f = extra->effect_win.current_frame;
    const int px = extra->u.do_click.screen_point.h;
    const int py = extra->u.do_click.screen_point.v;
    const bool inHeader = (py >= f.top && py < f.top + kFileSelHeaderH);
    const bool inRefresh = inHeader && (px >= f.right - 26);
    // 诊断：点击是否到达 + 命中判定 + 控件矩形（定位"展开无效"）
    host::rawTrace("fsel-clk", (inHeader ? 1 : 0) * 100 + (inRefresh ? 2 : 0));
    host::rawTrace("fsel-top", f.top);
    host::rawTrace("fsel-h", f.bottom - f.top);
    host::rawTrace("fsel-py", py);

    if (inHeader && inRefresh) {
        // ↻：重扫 effects/ 目录 → 列表实时更新（展开时行数可能变化 → 高度由
        // 随后的 UPDATE_PARAMS_UI 按 SyncFileSelectorUI 重算）
        refreshPopupChoices();
        s_lastRefreshTick = std::chrono::steady_clock::now();  // 触发 ↻ 短暂高亮反馈
        finishChange(in_data, out_data, extra, params, kIdxFileSelector);
        return;
    }
    if (inHeader) {
        // 展开/折叠（状态存本实例 handle f[1]）
        bool expanded = false;
        fileSelState(in_data, params, nullptr, &expanded);
        setFileSelExpanded(in_data, params, !expanded);
        if (!expanded) {
            // 滚轮校准（展开时）：DO_CLICK 是唯一同时拿到「事件点客户坐标 +
            // 光标物理坐标」的可靠时刻（openValueEdit 同款公式）——ADJUST_CURSOR
            // 悬停实测不派发（仅挂载期 3 次），screenValid 若无此校准则恒 false，
            // 钩子命中判定形同虚设（滚轮全部透传面板的根因）
            selWheelUpdateScreen(in_data->effect_ref, extra->u.do_click.screen_point, f);
            // 即将展开：滚动到选中项可见（选中项在首屏之外时自动带到窗口内）
            int selIdx = kDefaultFileIndex;
            fileSelState(in_data, params, &selIdx, nullptr);
            int n2 = 0;
            {
                auto& gs = globalState();
                CSLock lk(gs.mutex);
                n2 = static_cast<int>(gs.popupChoices.size());
            }
            if (selIdx < 0 || selIdx >= n2) selIdx = kDefaultFileIndex;
            const int rows2 = (std::min)(n2, kFileSelMaxRows);
            int scroll = effectiveFileSelScroll(in_data, params, n2, f);
            if (selIdx < scroll) scroll = selIdx;
            else if (selIdx >= scroll + rows2) scroll = selIdx - rows2 + 1;
            setFileSelScroll(in_data, params, scroll, n2);
        }
        s_selHoverRow = -1;
        finishChange(in_data, out_data, extra, params, kIdxFileSelector);
        return;
    }
    bool expanded = false;
    fileSelState(in_data, params, nullptr, &expanded);
    if (!expanded) return;

    int n = 0;
    {
        auto& gs = globalState();
        CSLock lk(gs.mutex);
        n = static_cast<int>(gs.popupChoices.size());
    }
    const int rows = (std::min)(n, kFileSelMaxRows);
    const int listTop = f.top + kFileSelHeaderH;
    const int listBot = listTop + rows * kFileSelRowH;
    // 滚动条区域（文件数超出一屏时显示）：▲/▼ ±1 行、轨道翻页、滑块拖拽
    if (n > kFileSelMaxRows && px >= f.right - kSelScrollW && py >= listTop && py < listBot) {
        const SelScrollGeom g = selScrollGeom(f, n);
        const int scroll = effectiveFileSelScroll(in_data, params, n, f);
        if (py < g.trackTop) {
            // ▲ 上箭头
            setFileSelScroll(in_data, params, scroll - 1, n);
        } else if (py >= g.trackTop + g.trackH) {
            // ▼ 下箭头
            setFileSelScroll(in_data, params, scroll + 1, n);
        } else {
            const int tTop = selThumbTop(g, scroll);
            if (py >= tTop && py < tTop + g.thumbH) {
                // 滑块：按下进入拖拽（DRAG 事件按 grab 偏移换算滚动）
                DragState ds;
                ds.slot = kSelDragScrollbar;
                ds.comp = py - tTop;
                ds.startVal = static_cast<float>(scroll);
                ds.startPx = static_cast<float>(py);
                packDrag(extra->u.do_click.continue_refcon, ds);
                extra->u.do_click.send_drag = TRUE;
                extra->evt_out_flags |= PF_EO_HANDLED_EVENT;
                return;
            }
            // 轨道：向点击方向翻页
            setFileSelScroll(in_data, params, py < tTop ? scroll - rows : scroll + rows, n);
        }
        finishChange(in_data, out_data, extra, params, kIdxFileSelector);
        return;
    }

    // 文件行命中 → 选中：写索引参数（随工程持久化）+ 折叠
    // （显示行号 + 滚动偏移 = 文件索引；off<0 前置 -1 与 handleCursor 同款整除防御）
    const int off = py - listTop;
    const int row = (off < 0) ? -1 : off / kFileSelRowH;
    const int scroll = effectiveFileSelScroll(in_data, params, n, f);
    if (row < 0 || row >= rows) return;   // 计数行（row == maxRows）不响应
    const int fileIdx = scroll + row;
    if (fileIdx < 0 || fileIdx >= n) return;

    // 真相源：新索引写入尾部隐藏原生参数 kIdxFileIndexParam（140）——脚本与 UI
    // 都从这里读写、随工程持久化；CHANGED_VALUE 在 DO_CLICK 有效上下文内让 AE
    // 立即落盘。渲染/SmartRender/SyncParamUI 均按该参数取文件（instanceFileIndex）。
    if (params && params[kIdxFileIndexParam]) {
        params[kIdxFileIndexParam]->u.fs_d.value = static_cast<PF_FpLong>(fileIdx);
        params[kIdxFileIndexParam]->uu.change_flags |= PF_ChangeFlag_CHANGED_VALUE;
    }
    // 选择器 handle：写**身份名**（本次新增的持久化载体）+ 位置索引。
    // 身份名让实例在库增删导致位置位移后仍指向同一个文件——这是"索引位移"问题的
    // 修复点（见 fileSelLayout.h）。仍保留 v[0] 索引：instanceFileIndex 的参数缺失
    // 回退路径读它。seqlock 保证渲染线程并发读到的是自洽快照（见 WriteFileSelSelection）。
    if (params && params[kIdxFileSelector] && params[kIdxFileSelector]->u.arb_d.value) {
        WriteFileSelSelection(in_data, params[kIdxFileSelector]->u.arb_d.value, fileIdx,
                              shaderNameAtIndex(fileIdx));
        // 同 UCP 路径：ARBITRARY 原地写入须置 CHANGED_VALUE 才持久化
        params[kIdxFileSelector]->uu.change_flags |= PF_ChangeFlag_CHANGED_VALUE;
    }
    // 同步加载新文件 → 立即填充该文件的 per-file 缓存条目（无全局索引可同步，
    // kIdxFileIndexParam 即真相）。否则条目要等下一次 Render 的 watcher 检测才更新，而
    // finishChange 的 CHANGED_VALUE 会先触发 UPDATE_PARAMS_UI → SyncParamUI 读到的
    // 是**旧文件** uniforms → 面板不重建；直到用户再点一个参数槽触发下一次
    // UPDATE_PARAMS_UI 才刷新（表现为"换文件后要点一下参数才更新"）。
    // 这里在事件线程同步加载，让随后的 UPDATE_PARAMS_UI 直接读到新 uniforms → 面板即时重建。
    // 这里在事件线程同步加载（resetSlotsToFileDefaults 内部即按 fileIdx 取快照），
    // 让随后的 UPDATE_PARAMS_UI 直接读到新 uniforms → 面板即时重建。
    // 切换文件 → 槽位值重置为新文件声明的默认值（**单点实现**：规则只在
    // resetSlotsToFileDefaults 一处；脚本切文件的延迟重置走同一函数，两条路径
    // 行为严格一致）。PARAMS_SETUP 只在挂效果时跑一次（槽位 dephault 按默认文件
    // 注册），PF_UpdateParamUI 又不能改 value/dephault——不在此写值的话，槽位会
    // 一直保留旧文件的值，与所选 shader 写的默认值（`uniform float uX = 0.5;`）
    // 不一致。本行是 DO_CLICK（合法写值上下文：AE_Effect.h:2250），CHANGED_VALUE
    // 逐槽置位让 AE 持久化新值（下方 FORCE_RERENDER 兜底：新文件默认值恰与当前值
    // 相同时参数值不变）。
    resetSlotsToFileDefaults(in_data, params, fileIdx);
    // 缓存失效：切换 GLSL 文件后，效果输出依赖的文件内容已变，若各槽位参数值未变
    //（新文件默认值与当前值恰好相同），AE 的帧缓存键（基于参数值）不变 → 直接返回
    // 上一个文件的缓存帧，需清缓存才见新效果。
    // FORCE_RERENDER 仅在 PF_Cmd_EVENT / USER_CHANGED_PARAM / UPDATE_PARAMS_UI 有效，
    // 此处正是 DO_CLICK 事件，设置后强制 AE 使缓存失效并重渲染。CHANGED_VALUE 已由
    // finishChange 设置，这里显式补 FORCE_RERENDER 兜底（文件内容是外部依赖）。
    if (out_data) out_data->out_flags |= PF_OutFlag_FORCE_RERENDER;
    setFileSelExpanded(in_data, params, false);
    s_selHoverRow = -1;
    finishChange(in_data, out_data, extra, params, kIdxFileSelector);
}

} // namespace

// 对外接口：脚本切文件后登记槽位值「待重置」（实现与理由见
// requestSlotResetForFileIndexImpl 上方注释）。本阶段（PF_Cmd_UPDATE_PARAMS_UI）
// **零参数写入**：不写 value、不置 CHANGED_VALUE，不注入合成输入、不挂定时器——
// 只登记 per-instance 待重置标记，等下一次真实合法写值上下文（handleClick）消费。
// **必须在文件级匿名 namespace 之外定义**：匿名 namespace 内是内部链接，plugin.cpp
// 跨 TU 引用会 LNK2019（requestSlotResetForFileIndexImpl 在其内，本包装可直接调用）。
PF_Err RequestSlotResetForFileIndex(PF_InData* in_data, PF_OutData* out_data,
                                    PF_ParamDef* params[]) {
    (void)out_data;
    requestSlotResetForFileIndexImpl(in_data, params);
    return PF_Err_NONE;
}

// 合法写值上下文的立即重置（PF_Cmd_USER_CHANGED_PARAM；语义与理由见 customUI.h 声明处）。
// 复用与手动点击完全相同的单点实现 resetSlotsToFileDefaults——三条路径（点击 / 本命令 /
// 外部工具 hostSelectShaderFile）的「切文件后取新文件默认值」规则因此只有一份实现。
int ApplySlotDefaultsNow(PF_InData* in_data, PF_OutData* out_data,
                         PF_ParamDef* params[]) {
    if (!in_data || !params) return -1;
    const int idx = fileSelIndex(in_data, params);
    resetSlotsToFileDefaults(in_data, params, idx);
    // 本函数已当场兑现重置 → 清掉「待重置」登记，否则用户下一次点击会再重置一遍
    //（结果值相同，但多一次无意义的 CHANGED_VALUE 写入与撤销步）
    releaseSlotReset(in_data->effect_ref);
    // 文件内容是外部依赖，且新文件默认值可能与当前值恰好相同（参数值不变 → AE 帧缓存键
    // 不变 → 直接复用旧文件的缓存帧）：显式要求失效重渲染。本阶段合法（AE_Effect.h:886）。
    if (out_data) out_data->out_flags |= PF_OutFlag_FORCE_RERENDER;
    return idx;
}

// 中键滚轮 pending 消费（UPDATE_PARAMS_UI 上下文，无 extra）：应用钩子队列累计
// 的待滚行数到选择器 handle 并 invalidate ECW 宿主根窗口触发重绘。
// **必须在文件级匿名 namespace 之外定义**：匿名 namespace 内是内部链接，plugin.cpp
// 跨 TU 引用会 LNK2019（selWheelConsumeImpl 在其内，本包装可直接调用）。
PF_Err selWheelConsume(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[]) {
    return selWheelConsumeImpl(in_data, out_data, params);
}

// 插件卸载（PF_Cmd_GLOBAL_SETDOWN）：停掉专用滚轮钩子线程并清空目标/待滚。
// 进程退出时线程由系统回收，此路径主要防显式卸载 DLL 后线程仍执行已卸载代码。
// **同样必须在文件级匿名 namespace 之外定义**（外部链接，plugin.cpp 跨 TU 引用）。
void ShutdownWheelHook() {
    selWheelStopHookThread();
    {
        SelWheelLock lk(s_selWheelMutex);
        s_selWheelTargets.clear();
        s_selWheelPending.clear();
    }
    if (s_selWheelReady) {
        CloseHandle(s_selWheelReady);
        s_selWheelReady = nullptr;
    }
}

// —— 对外接口 ——

// UPDATE_PARAMS_UI 调用：同步文件选择器高度（展开/折叠/刷新后行数变化）。
// 不再用进程级 s_selHeightDirty 待定标志——多实例同屏时该标志会被
// 任意实例的 UPDATE_PARAMS_UI 抢先消费（首个到达者得：A 展开、B 的周期性
// UPDATE_PARAMS_UI 先到 → B 消费并清除 → A 到达时跳过 → A 的 ui_height 停留
// 折叠值，展开的文件列表被裁剪）。effect_ref 键控表亦不可行：无实例销毁清理
// 钩子（无 SEQUENCE_RESET/SETDOWN 处理），悬空条目无界泄漏。改为无条件按
// **本实例**当前状态计算期望高度：高度取自本实例选择器 handle 的展开位 +
// 进程级文件列表行数（与 fileSelHeight 绘制口径一致）。
// （收起留白）：按 params[].ui_height 与期望值比对时——
// 实测 AE 对 PUI_CONTROL 的 ui_height **不回写**到 UPDATE_PARAMS_UI 的
// params[]（恒为 PARAMS_SETUP 注册的 24）：展开（24≠177）总能长高，收起
//（24==24）恒 no-op → 收起后控件停留展开高度、下方一片空白。改为追踪本实例
// 上次经 PF_UpdateParamUI 应用的高度（初始 = 注册值 kFileSelCollapsedH），
// 与期望值比对——不依赖 AE 是否回写。播放期逐帧 UPDATE_PARAMS_UI 下
// applied==want 即 no-op；重复同值更新 AE 端本就无变化不重建。条目随
// ShutdownInstanceUI（SEQUENCE_SETDOWN）清理，防 effect_ref 地址复用误判。
static std::map<void*, A_short> s_selAppliedH;

// 选择器**展开态**的权威副本（effect_ref 键控）。针对"点开 GLSL 文件
// 列表 → 参数组全部展开 + 滚动条持续滚动"：
// 原因：展开态唯一存放处是选择器的 ARBITRARY handle f[1]，而该句柄的回读**不稳**——
// 详见 setFileSelExpanded 注释（"DRAW/ADJUST_CURSOR 上下文写该句柄不生效"）。
// 实测证据（%TEMP%\as_effect_host_trace.log 的 fsel-sync-diag）：
//   calls=109 emit=9  want=177 applied=24  EMIT
//   calls=110 emit=10 want=177 applied=24  EMIT
//   calls=111 emit=11 want=24  applied=177 EMIT
// want（=展开态推导的期望高度）与 applied 在 177↔24 间来回翻转，**每翻一次就发
// PF_UpdateParamUI → AE 重建 ECW → 又触发 UPDATE_PARAMS_UI → 再翻** → 无限重建，
// 用户可见"持续滚动"，而每次重建还会把「参数」组强制展开。
// 修法：与 s_selAppliedH / g_layerAppliedBits / g_reconciledIdx 同款——把展开态
// 放进**实例内存**作为权威；handle 仅在内存无记录时作为首次来源（工程恢复），
// 并继续写回以维持持久化。
// 条目随 ShutdownInstanceUI（SEQUENCE_SETDOWN）清理，防 effect_ref 地址复用误判。
static std::map<void*, bool> s_selExpanded;

// fsel-sync / fsel-sync-diag 计数探针、选择器高度一手信号与进程级发射序号
// （含其跨 TU 接口）已整族删除——
// 信号链只剩探针消费方；上述
// 实测证据（fsel-sync-diag 行）已沉淀在上方 s_selExpanded 注释里。

PF_Err SyncFileSelectorUI(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[]) {
    if (!params || !params[kIdxFileSelector]) return PF_Err_NONE;
    PF_ParamDef def = *params[kIdxFileSelector];
    const A_short wantH = static_cast<A_short>(fileSelHeight(in_data, params));
    const auto it = s_selAppliedH.find(in_data->effect_ref);
    const A_short appliedH = (it != s_selAppliedH.end())
        ? it->second : static_cast<A_short>(kFileSelCollapsedH);   // PARAMS_SETUP 注册高度
    if (appliedH == wantH) {   // 无变化：纯 no-op（不看 params[].ui_height——AE 不回写，恒为注册值）
        return PF_Err_NONE;
    }
    PF_ParamUtilsSuite3* pus = nullptr;
    PF_Err err = AEFX_AcquireSuite(in_data, out_data, kPFParamUtilsSuite,
                                   kPFParamUtilsSuiteVersion3, nullptr,
                                   reinterpret_cast<void**>(&pus));
    if (err != PF_Err_NONE || !pus) {
        return PF_Err_NONE;
    }
    def.ui_height = wantH;
    err = pus->PF_UpdateParamUI(in_data->effect_ref, kIdxFileSelector, &def);
    AEFX_ReleaseSuite(in_data, out_data, kPFParamUtilsSuite, kPFParamUtilsSuiteVersion3, nullptr);
    if (err == PF_Err_NONE) s_selAppliedH[in_data->effect_ref] = wantH;
    return PF_Err_NONE;
}

// 分配 16 字节 ARBITRARY_DATA handle（仅服务文件选择器：dephault + PF_Arbitrary_*
// 回调输出；槽位现为原生 FLOAT_SLIDER，不再使用）。
PF_Err AllocFileSelHandle(PF_InData* in_data, PF_OutData* out_data,
                          const float v[4], PF_ArbitraryH* outH) {
    (void)out_data;
    // 注意：PF_NEW_HANDLE / PF_LOCK_HANDLE 宏展开依赖 in_data（AE_EffectCB.h）
    PF_Handle h = PF_NEW_HANDLE(sizeof(FileSelHandle));
    if (!h) return PF_Err_OUT_OF_MEMORY;
    FileSelHandle init;
    fileSelInit(init);                      // 全零 + 魔数：填充/尾部字节确定，见 pack(1) 说明
    for (int i = 0; i < 4; ++i) init.v[i] = v[i];
    float* dst = reinterpret_cast<float*>(PF_LOCK_HANDLE(h));
    if (dst) {
        std::memcpy(dst, &init, sizeof(FileSelHandle));
        PF_UNLOCK_HANDLE(h);
    }
    *outH = h;
    return PF_Err_NONE;
}

// —— 选中项身份（名字）读写 ——
// 布局与顺序约定见 fileSelLayout.h。渲染线程会**并发读**这个 handle（每帧取身份名 +
// 兜底索引），所以这里用 v[3] 当版本号做 seqlock：写者入场置奇数、写完置回偶数；
// 读者「读版本 → 整块拷贝 → 再读版本，两次一致且为偶数」才算有效，否则重试。
// v[3] 在 v1/v2 里都未被使用（v[0] 索引 / v[1] 展开 / v[2] 滚动），故可安全征用。
static inline bool fileSelVersionOdd(const FileSelHandle* d, uint32_t* outVer) {
    uint32_t ver = 0;
    std::memcpy(&ver, &d->v[3], sizeof(ver));
    if (outVer) *outVer = ver;
    return (ver & 1u) != 0u;
}

void WriteFileSelSelection(PF_InData* in_data, PF_ArbitraryH h, int index, const std::string& name) {
    if (!h) return;
    FileSelHandle* d = reinterpret_cast<FileSelHandle*>(PF_LOCK_HANDLE(h));
    if (!d) return;
    // 先在栈上拼好目标内容（保留 v[1..3] = 展开/滚动/版本，避免改索引时把选择器
    // 的展开与滚动状态一起抹掉），再按 seqlock 顺序落回 handle。
    FileSelHandle tmp = *d;
    fileSelSetIdentity(tmp, index, name);
    uint32_t ver = 0;
    fileSelVersionOdd(d, &ver);
    ++ver;                                  // → 奇数：写者入场
    std::memcpy(&d->v[3], &ver, sizeof(ver));
    std::atomic_thread_fence(std::memory_order_release);
    d->v[0] = tmp.v[0];
    std::memcpy(d->name, tmp.name, kFileSelNameMax);
    std::atomic_thread_fence(std::memory_order_release);
    d->nameLen = tmp.nameLen;               // 长度最后写：读到新长度即意味着字节已就位
    ++ver;                                  // → 偶数：写完
    std::memcpy(&d->v[3], &ver, sizeof(ver));
    PF_UNLOCK_HANDLE(h);
}

bool ReadFileSelSelection(PF_InData* in_data, PF_ArbitraryH h, int* index, std::string* name) {
    if (index) *index = -1;
    if (name) name->clear();
    if (!h) return false;
    const FileSelHandle* s = reinterpret_cast<const FileSelHandle*>(PF_LOCK_HANDLE(h));
    if (!s) return false;
    FileSelHandle tmp;
    bool ok = false;
    for (int attempt = 0; attempt < 8; ++attempt) {
        uint32_t before = 0;
        if (fileSelVersionOdd(s, &before)) continue;       // 写者正在写：重试
        std::atomic_thread_fence(std::memory_order_acquire);
        std::memcpy(&tmp, s, sizeof(FileSelHandle));
        std::atomic_thread_fence(std::memory_order_acquire);
        uint32_t after = 0;
        if (fileSelVersionOdd(s, &after)) continue;
        if (after == before) { ok = true; break; }         // 两次版本一致 → 快照有效
    }
    PF_UNLOCK_HANDLE(h);
    if (!ok) return false;   // 连续撕裂：放弃身份，调用方按位置回退（不阻塞渲染）
    if (index) *index = static_cast<int>(tmp.v[0]);
    if (name) *name = fileSelName(tmp);
    return true;
}

// 本实例选中文件的位置索引。真相源 = 隐藏参数 kIdxFileIndexParam（140）：UI 点选与
// 脚本写入都落在这里，渲染/SmartRender/SyncParamUI 也都读这里。
// 参数缺失（理论上不应发生）→ 回退选择器 handle 的 v[0] → 再回退 kDefaultFileIndex。
// 越界钳制仍由 shaderPathForIndex 统一完成。
int InstanceFileIndex(PF_InData* in_data, PF_ParamDef* params[]) {
    (void)in_data;
    if (params && params[kIdxFileIndexParam]) {
        return static_cast<int>(params[kIdxFileIndexParam]->u.fs_d.value);
    }
    if (params && params[kIdxFileSelector]) {
        int idx = -1;
        std::string ignored;
        if (ReadFileSelSelection(in_data, params[kIdxFileSelector]->u.arb_d.value, &idx, &ignored)) {
            return idx;
        }
    }
    return kDefaultFileIndex;
}

// 本实例记住的身份名（空 = 无身份）。渲染侧按它解析：库增删只改变"名字→位置"的
// 映射，已有实例不再随位置位移而静默换成另一个 shader。
std::string InstanceShaderName(PF_InData* in_data, PF_ParamDef* params[]) {
    if (!params || !params[kIdxFileSelector]) return "";
    std::string name;
    int ignored = -1;
    ReadFileSelSelection(in_data, params[kIdxFileSelector]->u.arb_d.value, &ignored, &name);
    return name;
}

// 本实例身份 id（载体见 seqIdentity.h）。真相源 = **序列数据**：
// SEQUENCE_SETUP 每实例铸非零号，FLATTEN/RESETUP 随渲染工程拷贝把数据带给渲染克隆。
// 两条读取路径：
//   · in_data->sequence_data 非空（UI/装载/部分渲染上下文）→ 直读句柄内容；
//   · 渲染上下文该字段可能为 NULL（AE_Effect.h:847-848「sequence_data is read-only
//     at render time … in_data->sequence_data will be NULL during render」）→
//     PF_EffectSequenceDataSuite::PF_GetConstSequenceData 取只读句柄（18.2 冻结版）。
// 返回 0 = 取不到（数据缺失/套件不可用/结构不符）——调用方按「所有实例共享谱系」的
// 旧行为处理，绝不拿 effect_ref 顶替（跨上下文会变，会破坏克隆接力）。
uint64_t InstanceInstanceId(PF_InData* in_data) {
    if (!in_data) return 0;
    uint64_t id = 0;
    if (in_data->sequence_data) {
        // DH(h) = *(h)：序列数据句柄由宿主自动加锁（AE_Effect.h:2713-2720），
        // SDK 样本同款直取，不自行 lock/unlock。
        const void* bytes = DH(in_data->sequence_data);
        if (bytes) host::seqIdentityReadId(bytes, sizeof(host::AsSeqIdentity), &id);
        if (id > 0) return id;
    }
    // 套件取只读句柄：ALLOW_NO_SUITE=true —— 旧版 AE / 套件缺失时静默降级为
    // 「身份未知」（0 = 旧行为），不抛异常、不打断渲染。
    AEFX_SuiteScoper<PF_EffectSequenceDataSuite1, true> seqSuite(
        in_data, kPFEffectSequenceDataSuite, kPFEffectSequenceDataSuiteVersion1);
    if (const PF_EffectSequenceDataSuite1* s = seqSuite.get()) {
        PF_ConstHandle ch = nullptr;
        if (s->PF_GetConstSequenceData(in_data->effect_ref, &ch) == PF_Err_NONE && ch) {
            host::seqIdentityReadId(*ch, sizeof(host::AsSeqIdentity), &id);
        }
    }
    return id;
}

PF_Err HandleUIEvent(PF_InData* in_data, PF_OutData* out_data,
                     PF_ParamDef* params[], void* extra) {
    if (!extra) return PF_Err_NONE;
    PF_EventExtra* ev = reinterpret_cast<PF_EventExtra*>(extra);
    PF_Err err = PF_Err_NONE;
    switch (ev->e_type) {
    case PF_Event_DRAW:
        err = handleDraw(in_data, out_data, params, ev);
        break;
    case PF_Event_DO_CLICK:
        err = handleClick(in_data, out_data, params, ev);
        break;
    case PF_Event_ACTIVATE:
        // ECW 重新激活（编辑框销毁后焦点回 ECW 必然触发）：处理编辑框提交遗留的
        // pendingCommit——写参数 + FORCE_RERENDER 强制重渲染合成，实现
        // "Enter 后立即应用"（不依赖 IDLE 时序；change_flags 在 ACTIVATE 无效）。
        // pending/dirty 是**本实例**条目的会话状态
        if (EditInstanceState* st = editStateOf(in_data); st && st->edit.pendingCommit) {
            flushPendingCommit(in_data, out_data, params);
            if (st->edit.dirty) st->edit.dirty = false;
            invalidateEditNow(in_data, out_data, ev);
        }
        break;
    case PF_Event_DEACTIVATE:
        // ECW 失焦（点击外部/切换窗口/按 Tab 离开）：编辑框若打开会因失焦自动
        // 提交（WM_KILLFOCUS）。防护：打开后 300ms 内的 DEACTIVATE 视为
        // SetFocus 引起的瞬时焦点转移（ECW→编辑框），不关闭编辑框。
        // 只由编辑框**归属实例**的 DEACTIVATE 提交（A 的编辑框不因 B 的
        // 失焦事件被提交——B 失焦与 A 的编辑框无关）
        if (s_editHwnd && s_editWndOwnerRef == in_data->effect_ref) {
            EditInstanceState* st = editStateOf(in_data);
            if (st && (GetTickCount() - st->edit.openTick) > 300) {
                commitValueEdit();
            }
        }
        break;
    case PF_Event_CLOSE_CONTEXT:
        // ECW 关闭：销毁编辑框并提交（兜底，正常路径 WM_KILLFOCUS 已提交）。
        // 仅归属实例的 CLOSE_CONTEXT 提交其编辑框
        if (s_editHwnd && s_editWndOwnerRef == in_data->effect_ref) commitValueEdit();
        // 滚轮目标随 ECW 关闭一并摘除（切合成/切效果时 ECW 关闭；不摘除则
        // 全局钩子泄漏、重启 AE 才消失，见 selWheelStartHookThread 注释）。重新
        // 打开 ECW 会触发 DRAW → selWheelUpsertTarget 重新登记并启动钩子线程。
        // 本路径没有可靠控件矩形，只能按 ref 兜底（ref 不稳定时可能删
        // 不掉）——残留由钩子回调的 lastSeen 超时修剪兜底收敛（见 s_selWheelStopReq
        // 与 selWheelMouseProc 的 prune 段），不再残留整个 AE 会话。
        selWheelRemoveTarget(in_data->effect_ref);
        break;
    case PF_Event_DRAG:
        err = handleDrag(in_data, out_data, params, ev);
        break;
    case PF_Event_ADJUST_CURSOR:
        err = handleCursor(in_data, out_data, params, ev);
        break;
    case PF_Event_IDLE:
        err = handleIdle(in_data, out_data, params, ev);
        break;
    default:
        break;
    }
    // 本实例编辑会话完全静默（无打开的编辑框/待写值/待重绘/抑制标记）
    // 时移除条目——实例销毁后残留的静默条目无消费价值，且 effect_ref 地址被
    // 新实例复用时也不会被误读（活跃会话由 openValueEdit 整体覆写、悬空
    // pending 由 flushPendingCommit 的 lastTouch 超时防御兜底）
    if (EditInstanceState* st = editStateOf(in_data); st) {
        if (!st->edit.active && !st->edit.pendingCommit && !st->edit.pendingPersist
            && !st->edit.dirty && !st->suppressClick) {
            s_editByInstance.erase(in_data->effect_ref);
        }
    }
    return err;
}

// 实例销毁钩子——PF_Cmd_SEQUENCE_SETDOWN（效果从图层移除）时调用。
// 实例销毁后 s_editByInstance 条目因 pendingPersist=true 不满足 HandleUIEvent
// 末尾静默清理的条件而残留（悬空条目，editStateForRef 返回非 null），挂起的延迟
// 合成点击照常注入：ECW 内多效果时被移除实例的 valueBox 坐标由其余实例重排占据，
// 注入点击的 DO_CLICK 路由到其他实例（isSynthetic 按收件实例判定，抑制标记在
// 悬空条目上失效）→ 被当真实点击执行——其他实例的滑条被设值/编辑框被误开。
// 此处随实例销毁一并拆除：归属的挂起定时器、编辑框（closeValueEdit 完整拆除）、
// 条目本身。 修复：编辑框必须主动销毁——其 owner 是 openValueEdit 里的
// GetActiveWindow()（AE 活动顶层窗口）而非 ECW，不随效果实例销毁；仅清
// 静态量不销毁窗口，残留的子类化窗口首个非 KEYDOWN/KILLFOCUS 消息经
// CallWindowProcW（s_editOldProc 已置 null）必然崩溃。
// 残余风险（评估后接受）：SDK 声明未启用 GET_FLATTENED_SEQUENCE_DATA 时 flat
// 场景 SETDOWN 可能被旁路——由 persistClickTimerProc 的 WindowFromPoint 根一致
// 性校验兜底（悬空实例的重排错位命中场景，命中窗口属同根但收件实例不同时仍
// 有理论窗口，须与 250ms 内重排叠加才可达，概率极低）。
PF_Err ShutdownInstanceUI(PF_InData* in_data) {
    if (!in_data || !in_data->effect_ref) return PF_Err_NONE;
    void* ref = in_data->effect_ref;
    // 挂起的延迟合成点击归属本实例 → 取消（值已在参数中，随实例销毁无意义）
    if (s_persistClickRef == ref) {
        if (s_persistClickTimer) KillTimer(nullptr, s_persistClickTimer);
        s_persistClickTimer = 0;
        s_persistClickRef = nullptr;
    }
    // 编辑框归属本实例 → closeValueEdit 完整拆除（恢复原 WndProc → DestroyWindow
    // → 释放字体 → InvalidateRect 宿主），静态量由其内部清空。必须在
    // s_editByInstance.erase(ref) 之前调用：closeValueEdit 经
    // editStateForRef(s_editWndOwnerRef) 取宿主窗口，条目擦除后取不到。
    // SEQUENCE_SETDOWN 与 DO_CLICK 同在 AE 主线程，DestroyWindow 上下文安全。
    if (s_editWndOwnerRef == ref) {
        closeValueEdit();
    }
    // 中键滚轮：移除本实例目标与悬空待滚（钩子随最后一个目标摘除）
    selWheelRemoveTarget(ref);
    // 文件选择器高度追踪条目（SyncFileSelectorUI 的 s_selAppliedH）：实例销毁
    // 清除，防 effect_ref 地址被新实例复用时误读旧高度（新实例 PARAMS_SETUP
    // 注册高度恒为 kFileSelCollapsedH，条目不存在即取该默认）
    s_selAppliedH.erase(ref);
    // 脚本切文件的「待重置」状态同款拆除（防 effect_ref 地址复用误读旧索引 →
    // 新实例被误重置）
    releaseSlotReset(ref);
    s_editByInstance.erase(ref);
    return PF_Err_NONE;
}

} // namespace host
