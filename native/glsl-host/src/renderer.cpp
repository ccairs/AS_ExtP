#include <windows.h>
#include "renderer.h"
#include "aeCamera.h"
#include "AE_EffectSuites.h"
#include "AE_EffectPixelFormat.h"
#include "AE_EffectGPUSuites.h"
#include "AE_Macros.h"
#include "AEFX_SuiteHelper.h"
#include <glad/glad.h>
#include "params.h"
#include "pixelConvert.h"    // AE world ↔ RGBA float 批量转换（位深归一化/翻转语义集中在此）
#include "solverSchedule.h"  // 结算器纯逻辑：帧字节记账 / 子步目标纹理（可单测）
#include "glCtxGenPolicy.h"  // 代际自增判据纯逻辑（可单测）
#include "solverKeyIdentity.h"  // 谱系指纹哈希内核 + 实例身份混入（纯逻辑，见 tests/test_solver_key_identity.cpp）
#include "solverMaskPolicy.h" // 时变掩码三态更新策略（可单测，见 tests/test_solver_mask_policy.cpp）
#include "uniformParser.h"
#include "errorLog.h"
#include "errorFrame.h"
#include "i18n.h"          // 用户可见错误文案（错误帧 + error.log，随宿主语言）
#include "effectState.h"   // CSLock（Win32 临界区 RAII）
#include <string>
#include <vector>
#include <deque>
#include <map>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <cmath>

// 注：曾尝试导出 NvOptimusEnablement/AmdPowerXpressRequestHighPerformance 强制独显，
// 但实测导致 wglMakeCurrent 崩溃（地址 0x0，驱动入口点为空）。已移除。
// 虚拟显卡问题需通过 NVIDIA 控制面板或 EnumDisplayDevices 选择物理 GPU 解决。

// 声明 plugin.cpp 中的阶段跟踪缓冲，rfLog 复制阶段名进去使崩溃日志显示精确阶段
// （复制而非保存指针——指针可能指向已析构的临时 std::string 而悬空）
extern thread_local char g_curStageBuf[64];

namespace host {
// 诊断日志：更新 g_curStageBuf（崩溃捕获用；节流后依然更新，崩溃定位不受影响）
// + 写日志文件（每次 fclose 立即刷新）。
// 读盘节流：rfLog 在渲染热路径每帧被调用 ~50 次，fopen+fflush+fclose 的
// I/O 在播放期造成每秒上千次磁盘写（与 plugin.cpp logCmd 注释同款问题，
// 曾拖垮 UI）。默认仅前 4000 次落盘（约覆盖前 70 帧的渲染诊断）；
// AS_EFFECT_HOST_LOG=1 解除限制（驱动问题深度诊断用）。
void rfLog(const char* stage, long val) {
    strncpy_s(g_curStageBuf, sizeof(g_curStageBuf), stage, _TRUNCATE);  // 崩溃时 vectoredHandler 会记录此值
    static const bool s_verbose = std::getenv("AS_EFFECT_HOST_LOG") != nullptr;
    // 节流计数改原子——MFR 下多个渲染线程并发 --s_budget 非原子
    //（读-改-写撕裂），日志条目偶发丢失/超发
    static LONG volatile s_budget = 4000;   // ~70 帧全量诊断
    if (!s_verbose && InterlockedDecrement(&s_budget) < 0) return;
    const std::string path = host::diagLogFilePath("as_effect_host.log");
    if (path.empty()) return;
    // 体积上限：本函数的写入同样受 as_effect_host.log 的 16MB 轮转约束
    //（每次写入都过体积闸门：只由 logCmd 触发时它被节流到 300 次/进程，
    //  16MB 上限形同虚设——rfLog 预算 4000 次，是这个文件最大的写入方）
    host::maybeRotateDiagLog();
    // 追加段互斥——与 logCmd/srLog/GPU 信息段并发写交错丢行；
    // 追加改 Win32 直写（appendDiagLogLine，内核原子），互斥退化为
    // 轮转互斥，纪律不变
    host::lockDiagAppend();
    {
        char body[128];
        std::snprintf(body, sizeof(body), "%s cmd=%ld", stage, val);
        host::appendDiagLogLine(body);
    }
    host::unlockDiagAppend();
}

// 带文本明细的 rfLog：槽位改名探针。detail = 期望名（ACP，
// uniform 名恒 ASCII，日志按 UTF-8 读不会乱码）；其余字段按名字排布。
// 独立预算：改名只在切文件/结构变化时发生，2000 行足够一次真机取证；
// 不与渲染诊断共用预算，避免 renderer 的 rf-* 诊断把探针挤掉。
void rfLog(const char* stage, const char* detail, long slot, long comp,
           long ret, long uniformCount) {
    strncpy_s(g_curStageBuf, sizeof(g_curStageBuf), stage, _TRUNCATE);
    static LONG volatile s_budget = 2000;
    if (InterlockedDecrement(&s_budget) < 0) return;
    const std::string path = host::diagLogFilePath("as_effect_host.log");
    if (path.empty()) return;
    host::maybeRotateDiagLog();
    host::lockDiagAppend();
    {
        char body[256];
        std::snprintf(body, sizeof(body),
                      "%s slot=%ld comp=%ld name=\"%s\" ret=%ld n=%ld",
                      stage, slot, comp, detail ? detail : "", ret, uniformCount);
        host::appendDiagLogLine(body);
    }
    host::unlockDiagAppend();
}

// 见 renderer.h：纯诊断行（stage + 预格式化明细），独立预算 2000 行/进程。
// 区分「没进同步 / 进了但判断无差异 / 有差异」。
void rfLogLine(const char* stage, const char* detail) {
    if (!stage || !*stage) return;
    strncpy_s(g_curStageBuf, sizeof(g_curStageBuf), stage, _TRUNCATE);
    static LONG volatile s_budget = 2000;
    if (InterlockedDecrement(&s_budget) < 0) return;
    const std::string path = host::diagLogFilePath("as_effect_host.log");
    if (path.empty()) return;
    host::maybeRotateDiagLog();
    host::lockDiagAppend();
    {
        char body[512];
        std::snprintf(body, sizeof(body), "%s %s", stage, detail ? detail : "");
        host::appendDiagLogLine(body);
    }
    host::unlockDiagAppend();
}

// 见 renderer.h：渲染侧取文件/程序取证一行
void rfDiag(const char* line) {
    if (!line || !*line) return;
    // 同一线程连续同内容只在首行落盘：调用点每帧执行，内容（索引/文件路径/源码
    // 长度/uniform 数/program id）不变即无信息量——这样把每帧几行降到「切换时的
    // 若干行」，不挤占 rfLog 的节流预算（rf-* 崩溃阶段诊断依赖该预算）。
    static thread_local std::string s_lastDiag;
    static const bool s_verbose = std::getenv("AS_EFFECT_HOST_LOG") != nullptr;
    // 本机实测：AE 运行期 fopen("a") 追加静默失败（errorLog.h rawTrace 注释），
    // 取证需 Win32 直写旁路——仅在 AS_EFFECT_HOST_LOG=1 时启用（与 rfLog 解除
    // 节流的同一开关），默认不影响正常日志量。
    if (s_verbose) host::rawTraceLine(line);
    if (s_lastDiag == line) return;
    s_lastDiag = line;
    rfLog(line, 0);
}

// —— 渲染分段计时 ——
// 要回答的问题：播放为什么卡、时间花在哪一段、AE 是不是每帧都回调我们。
// **默认关**（发布行为不变）；要查性能时设 AS_EFFECT_HOST_PERF=1 打开（=0 或不设即关）。
// 打开后每帧末落一行到 trace 日志（rawTraceLine 统一补时刻），字段：
//   perf res=WxH mode=<0 无趟 / 1 帧内迭代 / 2 结算> tot=.. conv=.. up=.. map=..
//        iter=.. main=.. read=.. hit=../miss=../rew=..   （单位 ms，最后一组是次数）
// 口径与 rfLog 阶段名对应：conv = rf-pix-conv→done（AE 帧转 RGBA float）、
// up = 输入纹理上传（glTexSubImage2D）、map = 映射/历史通道上传、iter = 从 map 结束
// 到主趟开始（公共 uniform 绑定 + 帧内迭代/结算整段）、main = 主趟 draw、
// read = 回读 + 写回 + GL 状态还原（到函数返回）。各段之和 ≈ tot，差额是早退路径。
// hit/miss/rew 是结算该帧的去向：命中缓存 / 新建谱系 / 回档从 0 重解。
// 注意：打开后 trace 日志每帧多一行 ~90B，会把更早的诊断记录更快挤出轮转窗口
//（4MB 上限、保留尾部 512KB ≈ 连续播放 4 分钟），排查完记得关掉。
// QPC 计时；渲染由 GLLock 串行，故计时与计数都无需原子。
static const bool s_perfOn = []() {
    const char* v = std::getenv("AS_EFFECT_HOST_PERF");
    return v && *v && v[0] != '0';
}();

static double perfNowMs() {
    static LARGE_INTEGER freq = []() { LARGE_INTEGER f{}; QueryPerformanceFrequency(&f); return f; }();
    LARGE_INTEGER c;
    QueryPerformanceCounter(&c);
    return static_cast<double>(c.QuadPart) * 1000.0 / static_cast<double>(freq.QuadPart);
}

// 单帧载体：构造即开始计时（早退路径也走析构，故 tot/n 覆盖全部渲染回调），
// 各 mark 记录绝对时刻，析构算差值并落行。
struct RenderPerfScope {
    bool on;
    double t0 = 0, tConv = 0, tUp = 0, tMap = 0, tIter = 0, tMain = 0;
    int mode = 0, hit = 0, miss = 0, rew = 0;
    int W = 0, H = 0;
    RenderPerfScope() : on(s_perfOn), t0(on ? perfNowMs() : 0) {}
    void markConv() { if (on) tConv = perfNowMs(); }
    void markUp()   { if (on) tUp = perfNowMs(); }
    void markMap()  { if (on) tMap = perfNowMs(); }
    void markIter() { if (on) tIter = perfNowMs(); }
    void markMain() { if (on) tMain = perfNowMs(); }
    ~RenderPerfScope() {
        if (!on) return;
        const double tEnd = perfNowMs();
        char body[288];
        std::snprintf(body, sizeof(body),
            "perf res=%dx%d mode=%d tot=%.1f conv=%.1f up=%.1f map=%.1f iter=%.1f main=%.1f read=%.1f "
            "hit=%d miss=%d rew=%d\n",
            W, H, mode, tEnd - t0,
            tConv > 0 ? tConv - t0 : 0.0,
            (tUp > 0 && tConv > 0) ? tUp - tConv : 0.0,
            (tMap > 0 && tUp > 0) ? tMap - tUp : 0.0,
            (tIter > 0 && tMap > 0) ? tIter - tMap : 0.0,
            (tMain > 0 && tIter > 0) ? tMain - tIter : 0.0,
            tMain > 0 ? tEnd - tMain : 0.0,
            hit, miss, rew);
        host::rawTraceLine(body);
    }
};
} // namespace host

namespace host {
namespace windowPlacement {

// 定位物理显卡（非虚拟显示适配器）的显示器矩形，用于把隐藏窗口放到真实 GPU 上。
// 崩溃根因：隐藏窗口的 DC 若落到虚拟显示驱动（向日葵 OrayIdd、MuMu、Idd、远程桌面等），
// wglCreateContext/wglMakeCurrent 会跳到空指针（0xC0000005 @ 0x0）。
// 返回 false 表示未找到物理显示器，调用方用 (0,0,8,8) 兜底。
bool findPhysicalDisplayRect(RECT& out) {
    DISPLAY_DEVICE dd;
    std::memset(&dd, 0, sizeof(dd));
    dd.cb = sizeof(dd);
    for (DWORD i = 0; EnumDisplayDevices(nullptr, i, &dd, 0); ++i) {
        std::string dev = dd.DeviceString;
        // 跳过虚拟/远程/间接显示适配器
        const char* virtualHints[] = {
            "Oray", "MuMu", "Idd", "Virtual", "Indirect", "Remote",
            "RDP", "Basic Render", "Mirror", "vmware", "VBOX", "Hyper-V"
        };
        bool isVirtual = false;
        for (const char* h : virtualHints) {
            if (dev.find(h) != std::string::npos) { isVirtual = true; break; }
        }
        if (isVirtual) continue;
        // 该物理适配器下挂载到桌面的显示器取第一个
        DISPLAY_DEVICE ddMon;
        std::memset(&ddMon, 0, sizeof(ddMon));
        ddMon.cb = sizeof(ddMon);
        for (DWORD j = 0; EnumDisplayDevices(dd.DeviceName, j, &ddMon, 0); ++j) {
            if (!(ddMon.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP)) continue;
            DEVMODE dm;
            std::memset(&dm, 0, sizeof(dm));
            dm.dmSize = sizeof(dm);
            if (EnumDisplaySettings(dd.DeviceName, ENUM_CURRENT_SETTINGS, &dm)) {
                out.left = dm.dmPosition.x;
                out.top = dm.dmPosition.y;
                out.right = out.left + static_cast<LONG>(dm.dmPelsWidth);
                out.bottom = out.top + static_cast<LONG>(dm.dmPelsHeight);
                return true;
            }
        }
    }
    return false;
}

} // namespace windowPlacement
} // namespace host

// WGL_ARB_create_context 常量（glad 不生成 WGL 头）
#ifndef WGL_CONTEXT_MAJOR_VERSION_ARB
#define WGL_CONTEXT_MAJOR_VERSION_ARB 0x2091
#endif
#ifndef WGL_CONTEXT_MINOR_VERSION_ARB
#define WGL_CONTEXT_MINOR_VERSION_ARB 0x2092
#endif
#ifndef WGL_CONTEXT_PROFILE_MASK_ARB
#define WGL_CONTEXT_PROFILE_MASK_ARB 0x9126
#endif
#ifndef WGL_CONTEXT_CORE_PROFILE_BIT_ARB
#define WGL_CONTEXT_CORE_PROFILE_BIT_ARB 0x00000001
#endif

// GLSL 契约：效果文件提供 vec4 mainImage(vec2 fragCoord, float time)；
// 内置 uniform：iChannel0(sampler2D) / uTime / uResolution / uAspect
namespace host {
namespace {

// MFR 多线程渲染：单 GL 上下文 + 全局锁串行化。
// 多上下文并发会导致 GPU 驱动访问违规（0xC0000005），改用单一上下文 + CRITICAL_SECTION。
// GL 渲染本身很快（一个 quad + 纹理上传 + 读回），串行化开销远小于驱动崩溃风险。
static CRITICAL_SECTION g_glCS;
static bool g_glCSInit = []() { InitializeCriticalSection(&g_glCS); return true; }();

// GL 操作 RAII 锁：获取锁 → 退出时恢复调用前上下文（释放我们的上下文）并释放锁。
// 保存/恢复 prevDC/prevRC 确保不干扰调用线程可能持有的其他上下文（如 AE 内部 GL）。
struct GLLock {
    CRITICAL_SECTION* cs;
    HDC   prevDC;
    HGLRC prevRC;
    GLLock(CRITICAL_SECTION& c)
        : cs(&c)
        , prevDC(wglGetCurrentDC())
        , prevRC(wglGetCurrentContext()) {
        EnterCriticalSection(cs);
    }
    ~GLLock() {
        wglMakeCurrent(prevDC, prevRC);  // 恢复调用前的上下文（通常为 nullptr）
        if (cs) LeaveCriticalSection(cs);
    }
    GLLock(const GLLock&) = delete;
    GLLock& operator=(const GLLock&) = delete;
};

// 读回缓冲（GL 底部行序，RGBA float）→ AE world（顶部行，ARGB 8/16/32bit）
// 实现见 pixelConvert.cpp（向量化实现，本文件依赖
// glad/AE SDK，测试链接不进去）。本包装只做尺寸适配；「行列取最小值防越界」与
// 通道重排/翻转/归一化语义都在被调函数内（tests/test_pixel_convert.cpp 守着）。
static void writeOutputWorld(PF_LayerDef* output, const float* back, A_long W, A_long H) {
    host::writeOutputWorld(output->data, (int32_t)output->rowbytes,
                           (int32_t)output->width, (int32_t)output->height,
                           back, (int32_t)W, (int32_t)H,
                           detectDepth(output->rowbytes, output->width));
}

// 帧缓冲复用：单上下文串行化下共享，避免每帧 2×W×H×4 float 堆分配抖动
//（1280×1280 下每帧约 52MB，30fps 播放时会造成大量分配/释放与堆碎片）
static std::vector<float> s_frameRgba;
static std::vector<float> s_frameBack;
static std::vector<unsigned char> s_frameBytes8;   // 8bit 直取路径的读回缓冲（见 rf-u8 段）

// 离屏 FBO：隐藏窗口默认 framebuffer 只有 8×8，直接渲染再读回
// 大尺寸会得到全 0（黑帧）。必须离屏渲染后从 FBO 读回。
// 内部格式：32bit 输入用 RGBA32F，其余 RGBA16F（保留 16bit 输入精度）。
// s_fbo/s_rtTex 提到文件作用域：迭代趟要在每趟把**不同的**纹理
// 挂到同一个 FBO 上（ping-pong），renderFrame 需要直接引用这对句柄。
static GLuint s_fbo = 0, s_rtTex = 0;
// 注：曾有一对"结算器 blit 读端"FBO（s_fboB）+ blitToCache 拷贝器——
// 性能轮改为末子步直接写进缓存纹理后二者均无调用方，随死代码一并退场。

// —— GL 上下文代际 ——
// 借用的 AE 离屏上下文在驱动 TDR / 设备切换后会被 AE 重建：**旧上下文里的 GL
// 对象名（纹理/FBO/program/VAO/VBO/PBO）在新上下文一律无效**，继续绑定只会得到
// GL 错误或读到空纹理——用户可见表现是"TDR 恢复后持续黑屏/花屏"，直到重启 AE
// （glCtx 里已能重查新句柄，但没人通知这批名字缓存作废）。这里用一个
// 单调代际计数把"上下文换了"广播给全部名字缓存：每个缓存点各自记 seen，代际
// 不匹配即把自己的名字/尺寸记忆清零，让 `if (!name) glGen*` 的原分配路径自然重建。
// 注意：清零时**一律不调 glDelete*** —— 旧名字可能已被新上下文复用，删名字会误删
// 新上下文里的活对象；旧上下文的对象随旧上下文一起消失，无需（也无法）回收。
// 唯一例外：代际自增若确认**上下文没换**（假阳性，见下方
// s_glCtxGenPrevRc），旧名字仍有效，谱系帧缓存必须真删回收，否则会泄漏显存。
// 代际自增点（全部在 glCtx 内，判据见 glCtxGenPolicy.h，单测 tests/test_glctx_gen.cpp）：
//   · AE 绑定连续失败达阈值（ctx-ae-stale-reset）；
//   · 自建上下文新建成功（ctx-ok 路径）；
//   · rebind 连续失败降级（ctx-rebind-giveup）——此处不 +1 会让
//     "自建降级 → 采纳 AE 上下文"整链上名字缓存不失效；
//   · AE 分支采纳且上一次绑定句柄不是该 AE 句柄（ctx-ae-adopt-gen）——五次修补。
// 只增不改，读写都在 GLLock 内（renderFrame/glCtx 均持锁），无并发问题。
static uint64_t s_glCtxGen = 0;
// —— 假阳性判据（防泄漏）——
// 代际自增有两大类来源，入口消费时对"带 GL 名字的缓存"处理必须分开：
//   · 真重建（TDR/设备切换、自建上下文新建）：旧 HGLRC 已失效/已被替换，旧名字
//     不可回收（也回收不了）——只能 clear-only。
//   · 假阳性（ctx-ae-stale-reset / ctx-rebind-giveup 的瞬时抖动情形）：连续若干次
//     makeCurrent 失败只是**瞬时占用/驱动抖动**（失败可分瞬态与永久），
//     HGLRC 其实没变，下次 acquireAeGlContext 很可能取回**同一个句柄**——此时旧名字仍
//     指向同一上下文里的活对象，clear-only 会把帧纹理变成"无人引用也无人释放"的显存
//     垃圾（每谱系最多 ~512MB，反复抖动持续累积 → 用户可见显存长期增长）。
// 判据分两层：
// 第一层"遗弃句柄 == 当前句柄"：自增处记下被遗弃的 HGLRC（自建上下文新建处置
// nullptr——新 HGLRC 必与旧的不同，旧上下文已由 glCtxFail 删除；rebind 降级与 AE
// 失效处置被遗弃的当前句柄），消费点比对当前实际绑定的句柄。但**句柄相同 ≠ 命名
// 空间未变**：HGLRC 是 Windows 内核句柄，真 TDR 后 AE 重建上下文时系统可能把**刚
// 回收的句柄值**再分配给新 HGLRC，此时句柄相等而 GL 名字空间已换——只凭第一层就
// 真删会删到新上下文里别的对象。
// 第二层对谱系帧纹理做身份交叉验证（solverFramesIdentityHolds：glIsTexture 存在性 +
// level0 尺寸 vs 谱系记录的 simW/simH），全部通过才允许 freeSolverFrames 真删；任一
// 不通过即整条按"换上下文"走 clear-only（与第一层判负同行为）。
// 只增不改；写/读判据都在 GLLock 内（glCtx 与 renderFrame 入口均持锁），无并发问题。
static HGLRC s_glCtxGenPrevRc = nullptr;
// 名字缓存点调用：代际变化返回 true（并把该点标记为已见新代际）。
static bool glNameStale(uint64_t* seenGen) {
    if (*seenGen == s_glCtxGen) return false;
    *seenGen = s_glCtxGen;
    return true;
}

// —— 代际回收判据的冻结快照 ——
// 把"句柄相等 + 身份验证"判据从结算帧推广到其余名字缓存（至少迭代/结算大纹理）。
// 为何要冻结：s_glCtxGenPrevRc 在 renderFrame 入口的代际消费点即被清空（防误比对），
// 而各 ensure* / 纹理段的 glNameStale 消费点晚于该处——它们看不到判据，只能 clear-only
//（这正是"瞬时抖动的显存垃圾"来源）。故在入口消费点把该代际的结论冻结下来（含当时
// 绑定的句柄），本代际内所有缓存点共用；next 代际的入口消费点重写。
// 保守纪律：冻结只发生在"代际被消费"的那一刻；未冻结（GenStamp 不匹配当前代际）或
// 冻结后绑定的句柄变了（防冻结与回收之间上下文被换而未自增的理论窗口）→ 一律不回收。
static uint64_t s_glCtxReclaimGen = 0;        // 冻结结论所属代际（与 s_glCtxGen 比对）
static bool     s_glCtxReclaimHandleSame = false;   // 遗弃句柄 == 消费点绑定句柄
static HGLRC    s_glCtxReclaimRc = nullptr;         // 消费点绑定的句柄（回收前复核）

// 本代际是否允许对名字缓存真删回收：纯判据见 glCtxGenPolicy.h glCacheReclaimAllowed
//（单测 tests/test_glcache_reclaim.cpp），此处叠加两道现场守卫：
//   · 冻结必须属于**当前**代际（s_glCtxReclaimGen == s_glCtxGen；否则保守不回收）；
//   · 现在绑定的仍是冻结时的同一句柄（防"冻结与回收之间上下文被换而未自增"的理论窗口）。
// prevGen = 该缓存条目建立时记下的代际（调用方在 glNameStale 消费前捕获）。
// 返回 false = 只置 0（TDR 安全路径，覆盖真 TDR：名字可能已被新上下文复用）。
static bool glCtxCacheReclaimOk(uint64_t prevGen, bool identityOk) {
    if (s_glCtxReclaimGen != s_glCtxGen) return false;   // 本代际未冻结 → 保守
    if (!host::glCacheReclaimAllowed(prevGen, s_glCtxGen,
                                     s_glCtxReclaimHandleSame, identityOk)) return false;
    return s_glCtxReclaimRc != nullptr &&
           wglGetCurrentContext() == s_glCtxReclaimRc;
}

// 纹理身份验证（与 solverFramesIdentityHolds 同款、可被各纹理缓存点复用的单点实现）：
//   · glIsTexture：名字在当前上下文不存在 → 直接否决（同时避免对已死名字 glBindTexture
//     ——桌面 GL 下绑定未生成的纹理名会**创建**新对象，探测本身不能留下垃圾）；
//   · level0 尺寸 == 缓存记录的分配尺寸（w/h 为基准；<= 0 表示无基准 → 保守否决）；
//   · 只读探针：绑当前活跃单元并在返回前还原（同 solverFramesIdentityHolds 纪律）。
static bool glTextureIdentityOk(GLuint t, A_long w, A_long h) {
    if (!t || w <= 0 || h <= 0) return false;
    if (glIsTexture(t) != GL_TRUE) return false;
    GLint prevBind = 0;
    glGetIntegerv(GL_TEXTURE_BINDING_2D, &prevBind);
    glBindTexture(GL_TEXTURE_2D, t);
    GLint gw = -1, gh = -1;
    glGetTexLevelParameteriv(GL_TEXTURE_2D, 0, GL_TEXTURE_WIDTH, &gw);
    glGetTexLevelParameteriv(GL_TEXTURE_2D, 0, GL_TEXTURE_HEIGHT, &gh);
    glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(prevBind));
    return gw == static_cast<GLint>(w) && gh == static_cast<GLint>(h);
}

// —— 纹理分配守卫：分配期间把活跃单元钉在 0，退出时还原 ——
// glBindTexture 绑的是**活跃单元**，而这些分配点都在"输入图层已绑到单元 0"
// 之后才跑（ensureIterTextures / ensureSolveScratch / newSolverTex 全在
// renderFrame 的上传段之后）。不还原就把 s_tex 顶成 ping-pong/暂存纹理——
// 任何采样 iChannel0 的趟都读到**一张空纹理（黑）**。实测（AE 真机探针）：
// 同一次渲染里迭代趟与主趟的 iChannel0 全读成 0，而输入图层真值是 189/255；
// 用户可见表现是"预览缩放/首次渲染时整帧黑一下"与"迭代趟读不到源画面"。
// 统一在单元 0 上分配（而不是随便哪个活跃单元），是为了让保存/还原只有一处。
class Unit0TexScope {
public:
    Unit0TexScope() {
        glGetIntegerv(GL_ACTIVE_TEXTURE, &prevActive_);
        glActiveTexture(GL_TEXTURE0);
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &prevBind_);
    }
    ~Unit0TexScope() {
        glBindTexture(GL_TEXTURE_2D, (GLuint)prevBind_);
        glActiveTexture((GLenum)prevActive_);
    }
    Unit0TexScope(const Unit0TexScope&) = delete;
    Unit0TexScope& operator=(const Unit0TexScope&) = delete;
private:
    GLint prevActive_ = GL_TEXTURE0;
    GLint prevBind_ = 0;
};

// 分配纹理存储并**检测显存不足**（失败策略：宁可明确报错，不静默降级）。
// 为什么必须查错：glTexImage2D 在显存不足时只置 GL_OUT_OF_MEMORY、没有返回值——
// 不查错直接当成功用，纹理就成了"句柄有效、存储没分配"的空壳，读出来是未定义内容，
// 表现为"偶尔全黑/花屏/种子莫名其妙"，而 error.log 里一个字都没有。
// 只认 OUT_OF_MEMORY / INVALID_VALUE 为失败：其它错误码（驱动偶发噪声）不判失败——
// 把本来能跑的帧误判成错误帧，比漏报更糟。调用前清历史错误，免得把别人的错误算在自己头上。
static bool glTexStorage2dOk(GLenum internalFmt, A_long w, A_long h) {
    while (glGetError() != GL_NO_ERROR) {}
    glTexImage2D(GL_TEXTURE_2D, 0, internalFmt, w, h, 0, GL_RGBA, GL_FLOAT, nullptr);
    const GLenum e = glGetError();
    if (e == GL_NO_ERROR) return true;
    return e != GL_OUT_OF_MEMORY && e != GL_INVALID_VALUE;
}

static bool ensureFramebuffer(A_long W, A_long H, PixelDepth depth, std::string& errOut) {
    static A_long s_rtW = 0, s_rtH = 0;
    static PixelDepth s_rtDepth = PixelDepth::Bits8;
    static uint64_t s_seenGen = 0;
    const uint64_t prevSeenGen = s_seenGen;   // 名字建立时的代际（回收判据 prevGen）
    if (glNameStale(&s_seenGen)) {
        // 上下文代际变了（TDR 重建）：名字 + 尺寸/格式记忆一起清零——只清名字的话
        // "尺寸未变"会命中旧记忆而跳过重新分配/挂附件，新名字 + 空存储照样黑屏。
        // 清零前先判能否**真删回收**（假阳性：瞬时抖动取回同一 HGLRC，旧名字
        // 仍指向同一上下文里的活对象；判据 = glCacheReclaimAllowed，身份验证用清零前
        // 仍有效的尺寸基准 s_rtW/s_rtH）。不通过则维持只置 0（TDR 安全路径）。
        // FBO 名字（s_fbo）有意维持只置 0：FBO 无存储（显存泄漏关切在纹理），且其身份
        // 只能靠"附件是否挂回本纹理"间接证明——按"宁漏回收不误删"与 blit FBO 同口径处理。
        if (glCtxCacheReclaimOk(prevSeenGen, glTextureIdentityOk(s_rtTex, s_rtW, s_rtH)))
            glDeleteTextures(1, &s_rtTex);
        s_fbo = 0; s_rtTex = 0;
        s_rtW = 0; s_rtH = 0; s_rtDepth = PixelDepth::Bits8;
    }
    rfLog("fbo-gen", 0);
    if (!s_fbo) glGenFramebuffers(1, &s_fbo);
    if (!s_rtTex) glGenTextures(1, &s_rtTex);
    if (s_rtW == W && s_rtH == H && s_rtDepth == depth) {
        rfLog("fbo-bind-old", 0);
        glBindFramebuffer(GL_FRAMEBUFFER, s_fbo);
        rfLog("fbo-bind-old-ok", 0);
        return true;
    }
    const GLenum texInternalFmt = (depth == PixelDepth::Bits32) ? GL_RGBA32F : GL_RGBA16F;
    rfLog("fbo-bind-tex", 0);
    Unit0TexScope unit0;   // 分配期不许顶掉单元 0 的输入图层（本调用在上传段之前，
                           // 眼下无害，但守卫统一才不会在顺序变动时变成暗雷）
    glBindTexture(GL_TEXTURE_2D, s_rtTex);
    rfLog("fbo-teximage2d", 0);
    glTexImage2D(GL_TEXTURE_2D, 0, texInternalFmt, W, H, 0, GL_RGBA, GL_FLOAT, nullptr);
    rfLog("fbo-teximage2d-ok", 0);
    rfLog("fbo-texparam", 0);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    rfLog("fbo-texparam-ok", 0);
    rfLog("fbo-bind-fb", 0);
    glBindFramebuffer(GL_FRAMEBUFFER, s_fbo);
    rfLog("fbo-fb-tex2d", 0);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, s_rtTex, 0);
    rfLog("fbo-check", 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
        errOut = Tr(S_EFFECTHOST_RENDERER_ERROR_FBO_CREATE);
        rfLog("fbo-check-fail", 0);
        return false;
    }
    rfLog("fbo-check-ok", 0);
    s_rtW = W; s_rtH = H; s_rtDepth = depth;
    return true;
}

// —— 迭代趟 ping-pong 纹理对 ——
// 帧内多趟迭代必须双缓冲：GL 不允许同一张纹理既作采样源又作渲染目标（读+写同
// 一纹理是未定义行为）。两张纹理轮换读写，尺寸/位深与主渲染目标同口径
// （32bit 输入用 RGBA32F，其余 RGBA16F）。
// 与 ensureFramebuffer 同款「尺寸/位深不变即复用」，避免每帧重新分配显存；
// 尺寸变化（含 AE 预览降采样档位切换）时重建——迭代趟**无跨帧状态**，重建
// 不丢任何东西（这正是迭代趟相对帧间反馈的关键优势）。
static GLuint s_iterTex[2] = {0, 0};
static bool ensureIterTextures(A_long W, A_long H, PixelDepth depth) {
    static A_long s_iW = 0, s_iH = 0;
    static PixelDepth s_iDepth = PixelDepth::Bits8;
    static uint64_t s_seenGen = 0;
    const uint64_t prevSeenGen = s_seenGen;   // 名字建立时的代际（回收判据 prevGen）
    if (glNameStale(&s_seenGen)) {
        // 上下文重建：名字作废，尺寸/位深记忆一并归零（理由同 ensureFramebuffer）
        // 清零前判真删回收（同 ensureFramebuffer；身份 = level0 尺寸 vs 尺寸记忆）
        if (glCtxCacheReclaimOk(prevSeenGen,
                                glTextureIdentityOk(s_iterTex[0], s_iW, s_iH) &&
                                glTextureIdentityOk(s_iterTex[1], s_iW, s_iH)))
            glDeleteTextures(2, s_iterTex);
        s_iterTex[0] = 0; s_iterTex[1] = 0;
        s_iW = 0; s_iH = 0; s_iDepth = PixelDepth::Bits8;
    }
    if (!s_iterTex[0]) {
        rfLog("iter-tex-gen", 0);
        glGenTextures(2, s_iterTex);
    }
    if (s_iW == W && s_iH == H && s_iDepth == depth) return true;
    Unit0TexScope unit0;                 // 分配期不许顶掉单元 0 的输入图层（见其定义处）
    const GLenum fmt = (depth == PixelDepth::Bits32) ? GL_RGBA32F : GL_RGBA16F;
    for (int i = 0; i < 2; ++i) {
        glBindTexture(GL_TEXTURE_2D, s_iterTex[i]);
        if (!glTexStorage2dOk(fmt, W, H)) {
            // 分配失败（显存/上下文资源不足）：两把都丢掉、尺寸统计归零（下次仍重试），
            // 并把失败如实返回给调用方——旧的 `return true` 是恒定值，调用方接不到任何信号。
            rfLog("iter-tex-fail", 0);
            for (int j = 0; j < 2; ++j) {
                if (s_iterTex[j]) { glDeleteTextures(1, &s_iterTex[j]); s_iterTex[j] = 0; }
            }
            s_iW = 0; s_iH = 0; s_iDepth = PixelDepth::Bits8;
            return false;
        }
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    }
    s_iW = W; s_iH = H; s_iDepth = depth;
    rfLog("iter-tex-resize", W);
    return true;
}

// —— 结算器：跨帧携带状态 + 逐帧缓存 ——
// 与迭代趟（帧内、每帧重置）的区别见 uniformParser.h 的 IterMode 注释。
// 缓存曾按 effect_ref 键控（per-instance），日志
// 证伪了"不声明 MFR 就串行单实例"的假设——拖时间线时 AE 反复克隆短命渲染
// 实例（SEQUENCE_RESETUP 成批出现、多条渲染线交错推进、参数指纹未变也连环
// solve-reset），实例一换缓存就等于没有。现改为**谱系键控**：
//   key = 图层身份（合成 itemID + 图层 LayerID，跨实例稳定）⊕ 参数指纹
// 参数指纹含谱系的一切（源码/网格/位深/静态值/时变标记/重算代数），所以
// "指纹变 = 整体重解"自然变成"换一条新谱系"，旧谱系留在表里由全局 LRU
// （kSolverCacheGlobalBudgetBytes）过期——参数恢复到原值仍可命中一次。
// 实例销毁（SEQUENCE_SETDOWN）**不再**清缓存：克隆/销毁不动谱系表，删图层
// 的谱系靠 LRU 自然过期；附带消灭了旧设计里 SETDOWN 等解算临界区导致的
// "删图层时 AE 卡住"。
// 仿真网格长边默认值：**唯一真相源在 uniformParser.h**（kSolveResDefault/Min/Max，
// @solveRes 的钳制也在那边做的）。这里不再各存一份——曾有一对 kSolverSimMin/MaxDim
// 只在本文件定义、从未被引用（钳制实际发生在 parseSolveRes），默认值也是照样抄了一份
// 512：改一处忘一处就会让"声明的范围"和"生效的范围"悄悄分叉。
using glsl::kSolveResDefault;

// 谱系键：layer 为图层身份，hash 为参数指纹（solverParamHash + 重算代数）。
// fallback 时 layer = kSolverLayerFallbackFlag | effect_ref 指针值——身份获取
// 失败就退回 per-instance 隔离（现状行为），绝不能让不同图层的实例在 fallback
// 下共享缓存（源画面不同，播错状态比重解严重得多）。
struct SolverKey {
    uint64_t layer = 0;
    uint64_t hash = 0;
    bool operator<(const SolverKey& o) const {
        return (layer != o.layer) ? (layer < o.layer) : (hash < o.hash);
    }
};
constexpr uint64_t kSolverLayerFallbackFlag = 1ull << 63;   // Win64 用户态指针 < 2^48，此位恒空闲

struct SolverState {
    A_long simW = 0, simH = 0;         // 仿真网格（与渲染分辨率解耦；键已含网格，恒不变）
    PixelDepth depth = PixelDepth::Bits8;
    std::deque<GLuint> frames;         // 连续帧缓存；frames[i] ↔ 帧 firstFrame+i
    int firstFrame = 0;
    uint64_t lastTouch = 0;            // LRU 触碰计数（s_solverTouch++，越大越新）
};
// 时变掩码的 sticky 载体：仍按 effect_ref 键控（每实例一份）。不能挪进谱系——
// 掩码参与指纹、指纹决定键，放进谱系就是先有鸡还是先有蛋；也不能按图层共享，
// 同图层两个效果实例会互相污染（A 的关键帧位把 B 的静态值挤出指纹，B 改参
// 不再重解）。**实例销毁（SEQUENCE_SETDOWN）时由 forgetInstanceMaskCarrier
// 清理该实例条目**（effect_ref 地址被新实例复用时，旧实例的 sticky
// 时变位/通道身份会被继承——新实例首帧可能按旧掩码构造指纹）。"只置位不清位"
// 的 sticky 语义本身不动；超过上限仍按最旧裁剪兜底。
// 追加 iChannel1/2/3 的**输入图层身份**（chanKnown bit ci 置位 =
// chanLayerId[ci] 是可用的 AEGP LayerID）：同样"只在成功时更新、失败沿用上次"的
// 粘滞纪律——AEGP 间歇失败时若身份在"已知/未知"间抖动，谱系键就跟着抖，每次抖动
// 都换一条谱系从头重解。用户改选图层时下一次成功查询即覆写 → 键变 → 正常重解。
// 地址复用边界（与掩码载体现状相同）：effect_ref 地址被新实例复用时若首帧 AEGP
// 恰好失败，可能短暂沿用旧实例身份，下一次查询成功即自愈（身份不再匹配则重解）。
struct SolverMaskCarrier {
    uint32_t mask = 0;
    uint64_t touch = 0;
    uint8_t  chanKnown = 0;                     // bit ci = iChannel(ci+1) 身份已捕获
    uint64_t chanLayerId[host::kIdxMapChannels] = {0, 0, 0};   // AEGP LayerID
};
static std::map<SolverKey, SolverState> s_solverLineages;
static std::map<void*, SolverMaskCarrier> s_maskCarriers;
static uint64_t s_solverTouch = 0;
static uint64_t s_maskTouch = 0;   // 载体表 LRU 触碰计数（s_maskCS 保护，独立于 s_solverTouch）
// 渲染线程整段解算循环持这把锁（renderFrame 又持 GLLock），谱系表/载体表的
// 全部访问都在锁内。锁序恒为 GLLock → s_solverCS；SETDOWN 不再进来（见上），
// 主线程唯一的残留接触点是 solverProgress（Interlocked，无锁）。
static CRITICAL_SECTION s_solverCS;
static bool s_solverCSInit = []() { InitializeCriticalSection(&s_solverCS); return true; }();
// s_maskCarriers 专用锁。SETDOWN 的载体清理**不得**走 s_solverCS——
// 渲染线程整段解算循环持 s_solverCS（秒级），主线程 SETDOWN 等它就会重演
// "删图层时 AE 卡住"（这正是"SETDOWN 不再进 s_solverCS"的由来，见上）。
// 载体表访问全部改由本锁串行化（访问点本就只在短临界区），SETDOWN 只取本锁；
// 不存在同时持两把锁的路径，故无锁序问题。
static CRITICAL_SECTION s_maskCS;
static bool s_maskCSInit = []() { InitializeCriticalSection(&s_maskCS); return true; }();

static void freeSolverFrames(SolverState& st);   // 定义在下方（需 GL 上下文）
// 从最早的帧淘汰到预算以内。调用方保证 st.frames 非空时至少留一帧。
static void evictSolverFramesToBudget(SolverState& st) {
    const size_t per = solverFrameBytes(st.simW, st.simH, st.depth);
    while (st.frames.size() > 1 && st.frames.size() * per > kSolverCacheBudgetBytes) {
        GLuint t = st.frames.front();
        st.frames.pop_front();
        if (t) glDeleteTextures(1, &t);
        ++st.firstFrame;
    }
}
// 谱系总字节数与最旧者（LRU 驱逐用；keep 之外的谱系才可淘汰）。
// 表里谱系数是"参数拖动留下的旧谱系"量级（几十），线性扫不进热路径。
static void evictLineagesToGlobalBudget(SolverKey keep) {
    auto lineageBytes = [](const SolverState& st) {
        return st.frames.size() * solverFrameBytes(st.simW, st.simH, st.depth);
    };
    for (;;) {
        size_t total = 0;
        std::vector<uint64_t> touches;
        std::vector<SolverKey> keys;
        for (const auto& kv : s_solverLineages) {
            total += lineageBytes(kv.second);
            if (!(kv.first < keep) && !(keep < kv.first)) continue;   // keep 本身
            touches.push_back(kv.second.lastTouch);
            keys.push_back(kv.first);
        }
        if (total <= kSolverCacheGlobalBudgetBytes) return;
        // 受害者选取走 solverSchedule.h 的纯函数（单测钉住），这里只做下标→键映射
        const int victim = solverLruVictim(touches.data(), touches.size(), SIZE_MAX);
        if (victim < 0) return;   // 只剩 keep 一条：让它自己的 512MB 规则去裁
        SolverState& st = s_solverLineages[keys[static_cast<size_t>(victim)]];
        rfLog("solve-lru-evict", (long)st.frames.size());
        freeSolverFrames(st);
        s_solverLineages.erase(keys[static_cast<size_t>(victim)]);
    }
}

// —— 解算进度发布（ECW 进度条读它，见 renderer.h SolverProgress）——
// 只在"真要干活"的那段（推进/重解循环）发布；缓存命中的 O(1) 路径不发布。
// 用 Interlocked 而非临界区：UI 线程在渲染期要能随时读到（拿 s_solverCS 会被
// 渲染线程挡住，进度条就会卡在旧值）。
static volatile LONG s_progActive = 0;
static volatile LONG s_progDone = 0;
static volatile LONG s_progTotal = 0;
static volatile LONG s_progFrame = -1;

// RAII：进入解算置 active、任何退出路径（含 break/异常）都复位
struct SolveProgressGuard {
    explicit SolveProgressGuard(int total) {
        InterlockedExchange(&s_progTotal, static_cast<LONG>(total));
        InterlockedExchange(&s_progDone, 0);
        InterlockedExchange(&s_progActive, 1);
    }
    ~SolveProgressGuard() { InterlockedExchange(&s_progActive, 0); }
    SolveProgressGuard(const SolveProgressGuard&) = delete;
    SolveProgressGuard& operator=(const SolveProgressGuard&) = delete;
};

// 把「重算代数」混进结算指纹（FNV-1a 续算，内核单点实现见 solverKeyIdentity.h）。
// 手动重算按钮点一次该参数 +1 → 指纹变 → 渲染路径走整体重解。
// 为什么走参数而不是内存标记：effect_ref 跨上下文不稳定（见 customUI.cpp 重算
// 分支注释与 params.h kIdxSolveGen），参数是唯一跨上下文的可靠信道。
static uint64_t mixSolverGen(uint64_t h, double gen) {
    return host::fnv1aMix(h, &gen, sizeof(gen));
}

// —— 跨实例稳定的图层身份 ——
// AEGP 链：PFInterfaceSuite::GetEffectLayer → LayerSuite9::{GetLayerParentComp,
// GetLayerID} → CompSuite11::GetItemFromComp → ItemSuite9::GetItemID。LayerID 只在
// 合成内唯一（AEGP_GetLayerFromLayerID 要传 parent_compH 才能反解可证），必须连同
// 合成 itemID 一起编码。约束与降级纪律同 aeParams.cpp：仅渲染回调窗口合法、
// 任何一环失败静默返回 false，调用方降级 effect_ref 键。已知边界：LayerID 删除后
// 是否复用 SDK 无明文——撞上需要"同合成同 ID 且参数指纹全同"，且任何参数一改
// 即自愈；不为小概率上复杂度（换成源素材 itemID 进键则会让换素材误伤重解）。
static bool solverLayerKey(PF_InData* in_data, uint64_t* outKey) {
    if (!outKey) return false;
    *outKey = 0;
    if (!in_data || !in_data->pica_basicP) return false;
    SPBasicSuite* pica = in_data->pica_basicP;
    AEGP_PluginID aegpId = 0;
    if (!ensureAegpPluginId(pica, &aegpId)) return false;

    // 四套件逐个 acquire，取毕统一 release；取链放进 lambda，任何一环失败
    // 静默返回 false（调用方降级 effect_ref 键）
    const void* pv[4] = {nullptr, nullptr, nullptr, nullptr};
    auto releaseAll = [&]() {
        if (pv[3]) pica->ReleaseSuite(kAEGPItemSuite, kAEGPItemSuiteVersion9);
        if (pv[2]) pica->ReleaseSuite(kAEGPCompSuite, kAEGPCompSuiteVersion11);
        if (pv[1]) pica->ReleaseSuite(kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
        if (pv[0]) pica->ReleaseSuite(kAEGPPFInterfaceSuite, kAEGPPFInterfaceSuiteVersion1);
    };
    if (pica->AcquireSuite(kAEGPPFInterfaceSuite, kAEGPPFInterfaceSuiteVersion1, &pv[0]) != kSPNoError || !pv[0] ||
        pica->AcquireSuite(kAEGPLayerSuite, kAEGPLayerSuiteVersion9, &pv[1]) != kSPNoError || !pv[1] ||
        pica->AcquireSuite(kAEGPCompSuite, kAEGPCompSuiteVersion11, &pv[2]) != kSPNoError || !pv[2] ||
        pica->AcquireSuite(kAEGPItemSuite, kAEGPItemSuiteVersion9, &pv[3]) != kSPNoError || !pv[3]) {
        releaseAll();
        return false;
    }
    const bool ok = [&]() {
        const AEGP_PFInterfaceSuite1* pf = static_cast<const AEGP_PFInterfaceSuite1*>(pv[0]);
        const AEGP_LayerSuite9* ls = static_cast<const AEGP_LayerSuite9*>(pv[1]);
        const AEGP_CompSuite11* cs = static_cast<const AEGP_CompSuite11*>(pv[2]);
        const AEGP_ItemSuite9* is = static_cast<const AEGP_ItemSuite9*>(pv[3]);
        AEGP_LayerH layer = nullptr;
        if (pf->AEGP_GetEffectLayer(in_data->effect_ref, &layer) != A_Err_NONE || !layer) return false;
        AEGP_LayerIDVal layerId = AEGP_LayerIDVal_NONE;
        if (ls->AEGP_GetLayerID(layer, &layerId) != A_Err_NONE || layerId == AEGP_LayerIDVal_NONE) return false;
        AEGP_CompH comp = nullptr;
        if (ls->AEGP_GetLayerParentComp(layer, &comp) != A_Err_NONE || !comp) return false;
        AEGP_ItemH item = nullptr;
        if (cs->AEGP_GetItemFromComp(comp, &item) != A_Err_NONE || !item) return false;
        A_long itemId = 0;
        if (is->AEGP_GetItemID(item, &itemId) != A_Err_NONE) return false;
        *outKey = (static_cast<uint64_t>(static_cast<uint32_t>(itemId)) << 32)
                | static_cast<uint32_t>(layerId);
        return true;
    }();
    releaseAll();
    return ok;
}

// 参数指纹：只含**定义这场结算**的量（源码 / uniform 名与静态值 / 仿真网格 / 位深 /
// 帧时长）。刻意不含相机与灯光——它们逐帧变化，纳入指纹会导致每帧重置（相机一动结算
// 就重来）。它们是每一步的输入，不是结算的参数。
// 帧时长（time_step / time_scale 两个整数）：@solveHz 的每帧子步数
// （substepsAt）与 uDt 都由它推导，改帧率/时间伸缩会让整条时间轴的步进节奏变化——
// 旧指纹不含它，改帧率后同一帧号直接命中旧谱系，结算结果不重解（显示旧帧率的演化）。
// 混入后改帧率自然落到新谱系；缓存窗口/命中判据本身不动（旧谱系留表由 LRU 过期，
// 帧率恢复到原值仍可命中一次）。
// 时变参数（自动判定）：打了关键帧/表达式的槽位（varyingMask 置位）值
// 不进指纹——每帧读当帧值，关键帧驱动可用（追赶段按各中间帧时刻取值，aeParams.cpp）。
// 每槽位前混一个标记字节（0x01 静态 / 0x02 时变）：编码无歧义，且首次打关键帧
//（槽位从含值变不含值）指纹必然变化 → 重解一次，其后稳定。名字仍全量进指纹。
//
// —— 实例身份 ——
// 同图层两个**同款同参** @solve 实例若共用谱系键（键＝图层身份⊕本指纹），第二个
// 实例直接命中第一个的帧缓存（残差）。现把隐藏参数 kIdxInstanceId（per-instance，
// 见 params.h；随 AE 的参数复制进渲染克隆）按 8 字节定长混入（见下方函数注释）。
//
// —— iChannel 输入身份 ——
// 背景：谱系键若只有「图层身份 ⊕ 参数指纹」，同一图层叠两个**同款同参**的 @solve
// 时，第二个实例直接命中第一个的帧缓存，**它自己的 iChannel 输入被忽略**。输入是
// 结算语义的一部分（影响结果），必须进指纹。
// 纳入的是「该 iChannel 指向的输入身份」，取与渲染实例克隆无关的稳定量：
//   · iChannel0 = 本图层输入（效果链上游输出）。它的**可稳定取名**只有宿主图层身份
//     （= layerKey，见 solverLayerKey）——上游在效果链里的位置换不来可靠 API（见
//     下方调用点注释的取证结论），故只混入图层身份 + 类别标记，链位残差在真机复验
//     清单里点名。
//   · iChannel1/2/3 = 映射图层参数指向的图层（AEGP 流 LAYER_ID，aeParams.cpp 采集，
//     按 effect_ref 粘滞：AEGP 间歇失败沿用上次成功值，防谱系键抖动）或「无数据」
//     （<none>/检出失败，renderer 绑 1×1 黑常量兜底）。图层的声明与否取自源码
//     （parseSamplerChannels）——未声明通道不影响结果，不入指纹（改它不该触发重解）。
//   · 不纳入：@history（iHistory0..3）——输入即本图层 param[0]（效果输入）的偏移时刻
//     检出（AE SmartFX 经预渲染 checkout_layer、含前序效果；legacy 宿主经
//     PF_CHECKOUT_PARAM 得到未加工源图层），身份维度只有「本图层」（已含于
//     SolverKey.layer），且内容逐帧变化，属"每一步的输入"而非"结算的配置"（与相机/
//     灯光同类理由）；iReb 在本仓库不存在（无任何引用）故无处理对象。
// 克隆接力不受影响：身份取自源/图层参数这些与渲染实例克隆无关的量，同一实例的克隆
// 身份相同 → 仍落同一条谱系。
// 编码（定长、无歧义，沿用本函数既有"标记字节 + 定长负载"写法）：按 iChannel 序号
// 0..N-1 顺序，每通道 1 字节 kind；kind 为「输入图层/映射图层」时再跟 8 字节身份。
enum ChannelKind : uint8_t {
    kChannelUnused     = 0,   // 未声明/不参与结算：无负载
    kChannelInputLayer = 1,   // iChannel0：本图层输入，负载 = layerKey（图层身份）
    kChannelMapLayer   = 2,   // 映射图层：负载 = 该图层的 AEGP LayerID
    kChannelNoData     = 3,   // 声明但无数据（<none>/检出失败 → 黑常量兜底）：无负载
    kChannelUnknown    = 4,   // 声明有数据但身份不可得（AEGP 缺席/时变/查询失败）：无负载
};
struct ChannelInputId {
    uint8_t  kind  = kChannelUnused;
    uint64_t layer = 0;       // kind 为 1/2 时有效
};
// —— 实例身份（载体＝序列数据，见 seqIdentity.h）——
// instanceId 为本实例的身份号（由调用方 host::InstanceInstanceId(in_data) 读好传入，
// 渲染上下文经 PF_EffectSequenceDataSuite 取只读序列数据）。混入位置固定在 dims/clock
// 之后、iChannel 身份与槽位值之前：8 字节定长，编码无歧义。语义：
//   · 同图层两个同款同参实例 → id 不同 → 键不同 → 各走各的谱系（残差修掉）；
//   · 同一实例的渲染克隆（AE 随渲染工程拷贝复制序列数据）→ 同 id → 键相同 → 接力不失效；
//   · duplicate() 出来的实例继承源数据 → 键相同 → 与今日一致（共享）。
// 为什么不用 ARBITRARY 句柄/effect_ref 当身份：渲染克隆
// 不按实例携带 ARBITRARY 句柄内容（且 effect_ref 跨上下文会变）。id=0（数据缺失/
// 读取失败）仍是一个合法槽位值：与任何非零 id 的哈希都不同，缺读时退化为
// "所有实例共享"的旧行为，不会误分叉。
static uint64_t solverParamHash(const std::string& src, const std::vector<glsl::Param>* uniforms,
                                const float* userValues, A_long simW, A_long simH, PixelDepth depth,
                                uint32_t varyingMask, A_long timeStep, A_long timeScale,
                                uint64_t instanceId,
                                const ChannelInputId* channels, int channelCount) {
    uint64_t h = host::kFnv1aOffset;       // FNV-1a 64
    auto mix = [&h](const void* p, size_t n) { h = host::fnv1aMix(h, p, n); };
    mix(src.data(), src.size());
    const A_long dims[3] = {simW, simH, static_cast<A_long>(depth)};
    mix(dims, sizeof(dims));
    // 帧时长：两个整数原样入指纹（不做除法，避免浮点舍入歧义；二者同变才算变帧率）。
    // 与 dims 同列紧随其后（保持既有"先构造量、后参数值"的混合顺序）。
    const A_long clock[2] = {timeStep, timeScale};
    mix(clock, sizeof(clock));
    // 实例身份（见上）：8 字节定长，紧随 clock（"构造量"区段末尾）。混入走单点
    // 内核 host::mixInstanceId（solverKeyIdentity.h，内部即 fnv1aMix(&id, sizeof(id))）
    // ——纯逻辑单测（tests/test_solver_key_identity.cpp）调用**同一函数**，故"把 id
    // 从哈希里去掉"（删本行或把内核改成恒等）必然让该单测变红。
    h = host::mixInstanceId(h, instanceId);
    // iChannel 输入身份：按通道序号定长混入（见本函数头注释）。身份取不到（kind 3/4）
    // 时不带负载——编码仍无歧义（kind 字节本身即区分）。
    if (channels) {
        for (int ci = 0; ci < channelCount; ++ci) {
            mix(&channels[ci].kind, 1);
            if (channels[ci].kind == kChannelInputLayer || channels[ci].kind == kChannelMapLayer)
                mix(&channels[ci].layer, sizeof(uint64_t));
        }
    }
    if (uniforms) {
        for (const auto& p : *uniforms) mix(p.name.data(), p.name.size());
        if (userValues) {
            for (size_t i = 0; i < uniforms->size() && i < 32; ++i) {
                const bool varying = (varyingMask >> i) & 1u;
                const unsigned char marker = varying ? 0x02 : 0x01;
                mix(&marker, 1);
                if (varying) continue;   // 时变槽位值不参与指纹（逐帧读当帧值）
                mix(&userValues[i * host::kFloatsPerSlot], host::kFloatsPerSlot * sizeof(float));
            }
        }
    }
    return h;
}

// 结算器子步的 ping-pong 暂存（进程级共享：渲染在 GLLock 内串行，暂存只在单次
// 渲染调用内使用；帧缓存的纹理才是 per-instance 的，见 SolverState）。
static GLuint s_solveScratch[2] = {0, 0};
static bool ensureSolveScratch(A_long W, A_long H, PixelDepth depth) {
    static A_long s_sw = 0, s_sh = 0;
    static PixelDepth s_sd = PixelDepth::Bits8;
    static uint64_t s_seenGen = 0;
    const uint64_t prevSeenGen = s_seenGen;   // 名字建立时的代际（回收判据 prevGen）
    if (glNameStale(&s_seenGen)) {
        // 上下文重建：名字作废，尺寸/位深记忆一并归零（理由同 ensureFramebuffer）
        // 清零前判真删回收（同 ensureFramebuffer；身份 = level0 尺寸 vs 网格记忆）
        if (glCtxCacheReclaimOk(prevSeenGen,
                                glTextureIdentityOk(s_solveScratch[0], s_sw, s_sh) &&
                                glTextureIdentityOk(s_solveScratch[1], s_sw, s_sh)))
            glDeleteTextures(2, s_solveScratch);
        s_solveScratch[0] = 0; s_solveScratch[1] = 0;
        s_sw = 0; s_sh = 0; s_sd = PixelDepth::Bits8;
    }
    if (!s_solveScratch[0]) glGenTextures(2, s_solveScratch);
    if (s_sw == W && s_sh == H && s_sd == depth) return true;
    Unit0TexScope unit0;                 // 分配期不许顶掉单元 0 的输入图层（见其定义处）
    const GLenum fmt = (depth == PixelDepth::Bits32) ? GL_RGBA32F : GL_RGBA16F;
    for (int i = 0; i < 2; ++i) {
        glBindTexture(GL_TEXTURE_2D, s_solveScratch[i]);
        if (!glTexStorage2dOk(fmt, W, H)) {
            // 同上：分配失败如实返回，并清掉半边状态让下次重试
            rfLog("solve-scratch-fail", 0);
            for (int j = 0; j < 2; ++j) {
                if (s_solveScratch[j]) { glDeleteTextures(1, &s_solveScratch[j]); s_solveScratch[j] = 0; }
            }
            s_sw = 0; s_sh = 0; s_sd = PixelDepth::Bits8;
            return false;
        }
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    }
    s_sw = W; s_sh = H; s_sd = depth;
    return true;
}

// 新建一张结算状态纹理（尺寸 = 仿真网格）。
static GLuint newSolverTex(A_long W, A_long H, PixelDepth depth) {
    GLuint t = 0;
    glGenTextures(1, &t);
    if (!t) return 0;
    Unit0TexScope unit0;                 // 分配期不许顶掉单元 0 的输入图层（见其定义处）
    const GLenum fmt = (depth == PixelDepth::Bits32) ? GL_RGBA32F : GL_RGBA16F;
    glBindTexture(GL_TEXTURE_2D, t);
    if (!glTexStorage2dOk(fmt, W, H)) {   // 显存不足检测：见 glTexStorage2dOk 注释
        glDeleteTextures(1, &t);
        return 0;
    }
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    return t;
}

// —— @solveHz 的 0 子步帧状态延续 ——
// 读/写各一张 FBO（同绑定 blit 行为未定义）；blit 走 GPU 拷贝路径，浮点格式
// 无损——与既有实现搬迁子步产物用同一手法（见 solverSchedule.h 的子步目标注释）。
static GLuint s_solveBlitFbo[2] = {0, 0};
static void ensureSolveBlitFbos() {
    static uint64_t s_seenGen = 0;
    if (glNameStale(&s_seenGen)) {
        // 上下文重建：blit FBO 名字作废（无尺寸记忆），置 0 后下方按需 glGen。
        // 有意**不**做真删回收：FBO 无存储（显存泄漏关切在纹理），且"名字是否
        // 仍属于我们"没有可证明的身份（FBO 尺寸不存在、附件是每步重挂的临时目标；
        // 仅 glIsFramebuffer 存在性不足以排除"句柄值复用 + 名字撞车"的误删）——
        // 按"宁漏回收不误删"维持只置 0，重挂时自然重建。
        s_solveBlitFbo[0] = 0; s_solveBlitFbo[1] = 0;
    }
    if (!s_solveBlitFbo[0]) glGenFramebuffers(2, s_solveBlitFbo);
}

// —— 播种步的零状态纹理 ——
// 播种步（整个结算的第 0 子步）的 iPrev 曾绑**输入图层**（s_tex，按渲染尺寸分配，
// 如 1920×1080），而结算目标是仿真网格（如 64×36）。于是 shader 里
// `textureSize(iPrev)` 在播种步返回的是渲染尺寸、其余步是网格尺寸——"一物一纹素"
// 这类按网格寻址的写法把全部种子写进左下角极小一块（面板实测：整场只剩两三颗球、
// 永远挤在左下角一堆；不报错、不黑屏，伪装成物理 bug）。现改绑一张**网格尺寸、
// 清零**的专用纹理：
//   · iPrev 的尺寸在结算每一步恒 = 网格尺寸 → textureSize(iPrev) 处处可信；
//   · 要读输入图层一律用 iChannel0（它才是输入，且每一步都绑着同一张）。
// 尺寸/格式与状态纹理一致（newSolverTex 同源）；清零一次后永不被写（它只是读源），
// 故内容恒为零。进程级单例（与 s_solveScratch 同款：渲染在 GLLock 内串行）。
static GLuint s_solveZeroTex = 0;
static A_long s_zeroW = 0, s_zeroH = 0;
static PixelDepth s_zeroDepth = PixelDepth::Bits8;
static bool ensureSolveZeroTex(A_long W, A_long H, PixelDepth depth) {
    static uint64_t s_seenGen = 0;
    const uint64_t prevSeenGen = s_seenGen;   // 名字建立时的代际（回收判据 prevGen）
    if (glNameStale(&s_seenGen)) {
        // 上下文重建：名字作废，尺寸/位深记忆一并归零（理由同 ensureFramebuffer）
        // 清零前判真删回收（同 ensureFramebuffer；身份 = level0 尺寸 vs 网格记忆）
        if (glCtxCacheReclaimOk(prevSeenGen, glTextureIdentityOk(s_solveZeroTex, s_zeroW, s_zeroH)))
            glDeleteTextures(1, &s_solveZeroTex);
        s_solveZeroTex = 0;
        s_zeroW = 0; s_zeroH = 0; s_zeroDepth = PixelDepth::Bits8;
    }
    if (s_solveZeroTex && s_zeroW == W && s_zeroH == H && s_zeroDepth == depth) return true;
    Unit0TexScope unit0;
    if (s_solveZeroTex) { glDeleteTextures(1, &s_solveZeroTex); s_solveZeroTex = 0; }
    s_solveZeroTex = newSolverTex(W, H, depth);
    if (!s_solveZeroTex) return false;
    // 清零：新分配的纹理内容是未定义的（读到 NaN 会污染 shader）。经 FBO + glClear
    // 走 GPU（不传整张零缓冲上 CPU）；clear color 是全局状态，用完还原（主趟等
    // 后续绘制不依赖本函数的副作用）。FBO 绑定随后由 drawStep 自行重挂。
    // 清不了就**判失败**：没有清零手段 = 种子读未定义内容，与"分配失败"
    // 同级——跳过清零直接 return true，等于把未定义当零用（静默降级）。
    if (!s_solveBlitFbo[0]) ensureSolveBlitFbos();
    if (!s_solveBlitFbo[0]) {
        rfLog("solve-zero-noclear", 0);
        glDeleteTextures(1, &s_solveZeroTex);
        s_solveZeroTex = 0;
        return false;
    }
    {
        GLfloat prevClear[4] = {0, 0, 0, 0};
        glGetFloatv(GL_COLOR_CLEAR_VALUE, prevClear);
        glBindFramebuffer(GL_FRAMEBUFFER, s_solveBlitFbo[0]);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, s_solveZeroTex, 0);
        glClearColor(0.0f, 0.0f, 0.0f, 0.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        glClearColor(prevClear[0], prevClear[1], prevClear[2], prevClear[3]);
        glBindFramebuffer(GL_FRAMEBUFFER, s_fbo);
    }
    s_zeroW = W; s_zeroH = H; s_zeroDepth = depth;
    return true;
}

// 就地释放（只在 renderFrame 内调用——那里保证 GL 上下文已绑定；
// 键控改造后释放只剩两个源头，都发生在渲染路径内：回拖到窗口之前的整段重解、
// 全局 LRU 淘汰。曾经的"待删纹理垃圾列"随之退役——SETDOWN 不再清缓存、ECW
// 重算按钮走参数指纹，已无上下文之外的触发方。）
static void freeSolverFrames(SolverState& st) {
    for (GLuint t : st.frames) {
        if (t) glDeleteTextures(1, &t);
    }
    st.frames.clear();
    st.firstFrame = 0;
}

// —— 假阳性回收前的"这纹理确实是我们的"身份交叉验证 ——
// 场景：代际消费点第一层判据（遗弃 HGLRC == 当前 HGLRC）为真，但真 TDR 后 Windows
// 可能把刚回收的句柄值复用给 AE 重建的新上下文——句柄相等而 GL 名字空间已换。
// 此时 freeSolverFrames 会按旧名字删到新上下文里 AE/他方在恢复窗口内新分配到的
// 同名纹理。故真删前对每条谱系持有的**每一张**帧纹理抽验一次身份，全部通过才允许删。
// 验证依据（可证明正确）：
//   · SolverState 建系时记录该谱系全部帧纹理的分配尺寸 simW/simH（结构注释"键已含
//     网格，恒不变"——网格是谱系键的一部分，同谱系内恒定）；帧纹理只出自
//     newSolverTex(simW, simH, inDepth) 两处 push（0 子步 blit 与正常子步循环），
//     因此"帧纹理 level0 的 W/H == 谱系 simW/simH"是这些名字确为本插件所分配对象的
//     必要条件：尺寸不符 => 名字已被复用 => 按"换上下文"处理（clear-only）。
//   · 先探 glIsTexture：名字在当前上下文不存在 => 直接否决。这一步同时避免对已死
//     名字 glBindTexture——桌面 GL 下绑定未生成的纹理名会**创建**新对象，探测本身
//     不能留下任何新建对象（不留空纹理垃圾、不抢名字）。
//   · 只读探针不动 GL 状态：不切活跃单元，仅绑定当前活跃单元并在返回前还原
//     （本函数在 renderFrame 入口的 N7 状态快照之前调用，残留绑定会被快照当基线）。
// 空帧谱系返回 true（无对象可删，真删与 clear-only 等价）；谱系无尺寸基准
//（simW/simH <= 0，理论不可达）同样保守返回 false。
static bool solverFramesIdentityHolds(const SolverState& st) {
    if (st.frames.empty()) return true;
    if (st.simW <= 0 || st.simH <= 0) return false;
    GLint prevBind = 0;
    glGetIntegerv(GL_TEXTURE_BINDING_2D, &prevBind);
    bool ours = true;
    for (GLuint t : st.frames) {
        if (!t) continue;   // 0 名（不应存在）：无对象可删，跳过
        if (glIsTexture(t) != GL_TRUE) { ours = false; break; }
        glBindTexture(GL_TEXTURE_2D, t);
        GLint w = -1, h = -1;
        glGetTexLevelParameteriv(GL_TEXTURE_2D, 0, GL_TEXTURE_WIDTH, &w);
        glGetTexLevelParameteriv(GL_TEXTURE_2D, 0, GL_TEXTURE_HEIGHT, &h);
        if (w != static_cast<GLint>(st.simW) || h != static_cast<GLint>(st.simH)) {
            ours = false;
            break;
        }
    }
    glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(prevBind));   // 还原探测绑定（含失败路径）
    return ours;
}

// —— WGL 上下文（单例：MFR 多线程共享，由 GLLock 串行化访问）——// 所有渲染线程共享同一个隐藏窗口 + HGLRC，通过 GLLock 保证同一时刻只有一个线程使用。
struct GlContext {
    HWND  hwnd = nullptr;
    HDC   hdc  = nullptr;
    HGLRC rc   = nullptr;
    bool  ok   = false;
    bool  cur  = false;   // 本次调用时是否成功绑定到当前线程
    bool  failed = false; // 自建 WGL 失败记忆——置位后 glCtx 短路不再重试（防句柄泄漏）
    // hwnd/hdc/rc 是否为**本插件自建**（CreateWindowEx/GetDC/wglCreateContext
    // 三件套）并归本插件所有。AE 分支采纳的 s_aeHdc/s_aeRc 不归本插件，任何收尾路径
    // 都不得 wglDeleteContext/ReleaseDC（会破坏 AE 自己的离屏上下文）。降级回收按它区分。
    bool  owned = false;
    int   rebindFails = 0; // makeCurrent 连续失败计数（达阈值置 ok=false 降级透传）
};

// GlFrameGuard 现为空壳：GL 上下文绑定由 GLLock 管理（renderFrame 入口加锁）。
// PBO 读回：glReadPixels 写入 PBO（异步）→ glGetBufferSubData 拷回普通内存（同步点）。
struct GlFrameGuard {
    ~GlFrameGuard() {}
};

// —— 使用 AE 提供的离屏 OpenGL 上下文（替换自建 WGL）——
// 远程/虚拟显示环境（向日葵、虚拟机）下自建 WGL 上下文不可靠：隐藏窗口 DC 落到
// 虚拟显示适配器；远程无物理显示器时 findPhysicalDisplayRect 也返回 false，无法靠
// 枚举显示器绕开。AE 通过 PF_GPUDeviceSuite 提供主设备的 offscreen_opengl_context
// （HGLRC）与 offscreen_opengl_device（HDC），这是 AE 已创建成功的有效上下文，
// 直接复用可绕开自建路径。
// 阶段串口径：日志里的 ctx-makecurrent-final 标记该行之后的区间，覆盖
// wglMakeCurrent 与其后的 GL 调用，单独出现不能把崩溃归因给 wglMakeCurrent
// （崩溃点须看 minidump 的 RIP 与栈）。
static HDC   s_aeHdc = nullptr;
static HGLRC s_aeRc  = nullptr;
static bool  s_aeGot = false;   // 只有成功获取才置位（失败 verdict 不再永久封存，见下）
// 获取失败不再一次性永久判决。若首次调用就置 s_aeGot=true，
// 即便当次失败（GPU 套件缺席、启动早期 GetDeviceCount=0 等）也短路后续全部重查——
// PARAMS_SETUP 早期的一次瞬时失败会把整个会话锁死在自建隐藏窗口 WGL 路径
//（该路径在部分环境出现空指针崩溃，见 kUseAeGlContext 注释），
// 此后即使 AE 上下文已就绪也不再采用。修法（重查计数 + 事件解锁，对齐下方
// s_aeBindFails「连续失败才放弃」的反向语义「连续失败达上限才放弃」）：
//   · 只有成功才置 s_aeGot 封存句柄；
//   · 失败允许有限次重查（kAeAcquireMaxTries=3，跨调用累计，覆盖
//     PARAMS_SETUP → 首批 RENDER 之间的设备就绪窗口）；
//   · 次数用尽后本会话暂不再重查，但自建路径失败（glCtxFail / rebind 降级）
//     会置 s_aeRetryRequested 解锁新一轮——「其他路径也不可用」是重查信号；
//   · 失败日志仅每轮首次落盘（重查静默），防降级场景耗光 rfLog 的崩溃诊断预算。
// 全部状态在 GLLock（g_glCS）内访问（renderFrame/ensureGlContext 均持锁调用
// acquireAeGlContext/glCtx，与 s_aeBindFails 同款），无并发竞争。
static int   s_aeAcquireTries = 0;        // 未成功期间已重查次数（成功/解锁归零）
static bool  s_aeRetryRequested = false;  // 自建路径失败 → 解锁一轮重查
static const int kAeAcquireMaxTries = 3;
// AE 上下文绑定连续失败计数——驱动 TDR/GPU 切换后 s_aeHdc/s_aeRc
// 缓存句柄悬空，绑定失败原样返回且 s_aeGot 短路 acquireAeGlContext
// 永不重查（查询侧无自愈，修的是 g.ok 分支的 rebindFails），全部
// GLSL 效果静默透传直至重启 AE。连续失败达阈值（3）清空缓存并复位 s_aeGot，
// 下一次 renderFrame 的 acquireAeGlContext 强制重查（AE 侧 TDR 后重建的
// 上下文经 GetDeviceInfo 返回新句柄）；绑定成功即清零。int 即可：计数在
// GLLock（g_glCS）内访问（renderFrame/ensureGlContext 均持锁调 glCtx），
// 无并发竞争。
static int   s_aeBindFails = 0;

// 是否优先使用 AE 的离屏 GL 上下文。
// =false 时强制走自建隐藏窗口 WGL 路径（用于验证自建上下文是否稳定）。
// 自建路径在部分环境于 wglMakeCurrent 阶段崩溃（0xC0000005 @0x0）；阶段串
// ctx-makecurrent-final 覆盖该行之后的区间（含其后 GL 调用），判断崩溃点须看
// minidump 的 RIP 与栈。复用 AE 已建好的 offscreen 上下文是跨环境稳定方案，
// 故保持 =true。
static const bool kUseAeGlContext = true;  // 必须为 true：复用 AE offscreen 上下文绕开自建路径

// 从 AE GPU 设备套件获取主设备的离屏 GL 上下文（仅执行一次，进程级缓存）。
// GL 上下文是进程级资源，跨线程共享，由 GLLock 串行化访问。
static bool acquireAeGlContext(PF_InData* in_data, PF_OutData* out_data) {
    if (!kUseAeGlContext) { rfLog("ae-gpu-disabled", 0); return false; }
    if (s_aeGot) return (s_aeRc != nullptr) && (s_aeHdc != nullptr);
    // 自建路径失败后的解锁（glCtxFail / rebind 降级置位）——重新给一轮
    // 重查机会；失败过的 verdict 不永久封存（见 s_aeAcquireTries 注释）
    if (s_aeRetryRequested) {
        s_aeRetryRequested = false;
        s_aeAcquireTries = 0;
    }
    if (s_aeAcquireTries >= kAeAcquireMaxTries) return false;

    const bool firstTry = (s_aeAcquireTries == 0);
    ++s_aeAcquireTries;
    try {
        AEFX_SuiteScoper<PF_GPUDeviceSuite1> gpuSuite(
            in_data, kPFGPUDeviceSuite, kPFGPUDeviceSuiteVersion1, out_data);
        A_u_long deviceCount = 0;
        PF_Err gerr = gpuSuite->GetDeviceCount(in_data->effect_ref, &deviceCount);
        if (gerr != PF_Err_NONE || deviceCount == 0) {
            if (firstTry) rfLog("ae-gpu-count-fail", gerr);
        } else {
            for (A_u_long di = 0; di < deviceCount; ++di) {
                PF_GPUDeviceInfo devInfo;
                AEFX_CLR_STRUCT(devInfo);
                PF_Err ierr = gpuSuite->GetDeviceInfo(in_data->effect_ref, di, &devInfo);
                if (ierr != PF_Err_NONE) continue;
                // offscreen GL 上下文仅主设备提供
                if (devInfo.offscreen_opengl_contextPV && devInfo.offscreen_opengl_devicePV) {
                    s_aeHdc = reinterpret_cast<HDC>(devInfo.offscreen_opengl_devicePV);
                    s_aeRc  = reinterpret_cast<HGLRC>(devInfo.offscreen_opengl_contextPV);
                    s_aeGot = true;           // 成功才封存：此后短路重查（句柄缓存有效）
                    s_aeAcquireTries = 0;
                    rfLog("ae-gpu-ctx-acquired", (long)(intptr_t)s_aeRc);
                    return true;
                }
            }
        }
    } catch (...) {
        if (firstTry) rfLog("ae-gpu-suite-throw", 0);
    }
    if (firstTry) {
        rfLog("ae-gpu-ctx-null", 0);
    } else if (s_aeAcquireTries >= kAeAcquireMaxTries) {
        // 重查次数用尽（本会话暂不再查；自建路径失败会再解锁一轮）——独立字面量
        // 供二进制取证（grep -a ae-gpu-retry-exhaust）
        rfLog("ae-gpu-retry-exhaust", s_aeAcquireTries);
    }
    return false;
}

// 回收本插件自建的窗口/DC/HGLRC 三件套（逆序 rc→hdc→hwnd；ReleaseDC 需
// 窗口句柄故先于 DestroyWindow）。**只回收 owned 句柄**：AE 离屏上下文不归本插件
// 所有，wglDeleteContext/ReleaseDC 会破坏 AE 会话。抽成独立函数供 glCtxFail（失败
// 收尾）与 rebind 连续失败降级（泄漏修复）两条路径复用，避免收尾动作再次分叉。
// 三字段**无论是否回收都清空**——若只在
// 真回收时置空，owned=false（AE 借用句柄）时字段原样留在单例上。一旦后续某条路径
// 把 owned 翻成 true（创建分支），任何失败收尾都会按 owned 语义 wglDeleteContext
// 删掉仍是 AE 的 g.rc（见 glCtxGenPolicy.h 的交接不变量注释）。
static void glCtxReleaseOwned(GlContext& g) {
    const host::GlCtxRecyclePlan plan = host::glCtxDecideHandleRecycle(g.owned);
    if (plan.rc && g.rc)   { wglDeleteContext(g.rc); }
    if (plan.hdc && g.hdc) { ReleaseDC(g.hwnd, g.hdc); }
    if (plan.hwnd && g.hwnd) { DestroyWindow(g.hwnd); }
    g.rc   = nullptr;
    g.hdc  = nullptr;
    g.hwnd = nullptr;
    g.owned = false;
}

// 修复：glCtx 自建 WGL 失败收尾——回收本次半成品（按创建逆序 rc→hdc→hwnd，
// ReleaseDC 需窗口句柄故先于 DestroyWindow；tmp 临时上下文由调用点自行删除，此处
// 只回收 g.rc/g.hdc/g.hwnd）并置 failed 短路标志。若不如此（失败早退点直接 return）：
// 半成品不回收且无失败记忆，每次 renderFrame 重建一套窗口/HDC/HGLRC，句柄泄漏
// 累积至进程耗尽；失败后渲染走 renderFrame 的 !g.ok 透传降级，不再重试。
static void glCtxFail(GlContext& g) {
    glCtxReleaseOwned(g);
    g.failed = true;
    // 自建路径彻底失败 = 兜底也没了 → 解锁 AE 上下文重查（下一
    // renderFrame 的 acquireAeGlContext 会重走设备套件；若已用尽重查次数，
    // 这里再给一轮）。本函数只在自建创建路径调用，不涉及 AE 上下文分支。
    s_aeRetryRequested = true;
}

GlContext& glCtx() {
    static GlContext g;
    if (g.ok) {
        rfLog("ctx-rebind-check", 0);
        g.cur = (wglGetCurrentContext() == g.rc);
        if (!g.cur) {
            if (wglGetCurrentContext()) {
                rfLog("ctx-rebind-unbind", 0);
                wglMakeCurrent(nullptr, nullptr);
            }
            rfLog("ctx-rebind-makecurrent", 0);
            g.cur = wglMakeCurrent(g.hdc, g.rc);
            rfLog("ctx-rebind-done", (long)g.cur);
            // makeCurrent 失败需区分瞬态与永久——瞬态（上下文被并发占用、
            // 短暂驱动抖动）可自愈，立即放弃会误杀可用环境；永久失效的可达路径：
            // 驱动 TDR 重置（长 shader 触发 GPU 挂起 → Windows 重置驱动 → 旧
            // HGLRC 全部失效）与 GPU 设备丢失，此后每次 makeCurrent 必失败——
            // 每帧报错返回 INTERNAL_STRUCT_DAMAGED（AE 丢弃输出）直至删
            // 效果，无任何产出。连续失败达阈值即置 g.ok=false：此后 renderFrame
            // 走 !g.ok 透传降级（画面保持可用）。阈值 30 ≈ 30fps 下 1 秒，
            // 足以跨过瞬态占用窗口又不至于让用户长时间对着失败黑帧。
            // 计数在 GLLock（g_glCS）内访问（renderFrame/ensureGlContext 均
            // 持锁调本函数），无并发竞争。
            if (g.cur) {
                g.rebindFails = 0;
            } else if (++g.rebindFails >= 30) {
                const int giveupFails = g.rebindFails;   // 日志用（下面清零新句柄计数）
                // 上下文被判失效/丢失也是"名字空间可能已换"
                // ——必须代际 +1 广播（否则满屏名字缓存建在
                // 自建上下文上，降级后若下一次 acquireAeGlContext 成功、AE 分支直接
                // 采纳 AE 上下文，代际不变 → 消费点 glCtxChanged=false，旧名字被当
                // 新上下文对象用：持续黑/花屏不自愈，LRU/尺寸变化还可能 glDelete* 删到
                // AE 上下文里复用同名的活对象）。判据见 glCtxGenPolicy.h；遗弃句柄记
                // s_glCtxGenPrevRc——**未被真删的**句柄（AE 借用）若只是瞬时抖动、之后
                // 取回同一句柄，消费点凭身份验证真删回收帧纹理（不泄漏）；取不回则
                // clear-only（不误删）。自建句柄在本分支被真删（下方 owned 回收），
                // 起按判据记 0 而不是记已删句柄（句柄值复用防假阳性）。
                const host::GlCtxGenDecision giveupGen =
                    host::glCtxDecideRebindGiveup(reinterpret_cast<std::uintptr_t>(g.rc));
                if (giveupGen.bump) {
                    // owned 分支下方随即 glCtxReleaseOwned 真删本句柄——
                    // 已删句柄不得留在 s_glCtxGenPrevRc（句柄值复用会让消费点"句柄相等"
                    // 假阳性）；记 0 = 无遗弃句柄，消费点走保守 clear-only。AE 句柄
                    //（owned=false 只丢引用）照旧记录——瞬时抖动真删回收判据靠它
                    //（判据见 glCtxGenPolicy.h glCtxAbandonedRcAfterOwnedRecycle）。
                    s_glCtxGenPrevRc = reinterpret_cast<HGLRC>(host::glCtxAbandonedRcAfterOwnedRecycle(
                        g.owned, giveupGen.prevRc));
                    ++s_glCtxGen;
                    rfLog("ctx-rebind-giveup-gen", (long)s_glCtxGen);
                }
                g.ok = false;
                g.cur = false;
                // （泄漏修复）：降级只置 ok=false 时，g.hwnd/g.hdc/g.rc 仍挂在
                // 单例上；下一次 glCtx 走到自建创建分支会直接覆写三字段 → 每轮降级泄漏
                // 1 窗口 + 1 DC + 1 HGLRC（glCtxFail 已有回收，这条路径同样需要）。此处
                // 按 glCtxFail 的逆序回收——但**不置 failed**（降级是"当前轮上下文不可
                // 用"，不是"自建路径永久失败"：下一轮仍可重新创建或采纳 AE 上下文）。
                // 自建三件套归本插件所有 → 真回收；AE 采纳来的句柄不归本插件
                //（wglDeleteContext 会删掉 AE 自己的离屏上下文）→ 只丢引用不回收，
                // 由 acquireAeGlContext/重查决定后续（s_glCtxGenPrevRc 已留遗弃句柄）。
                if (g.owned) {
                    glCtxReleaseOwned(g);
                } else {
                    g.rc = nullptr;
                    g.hdc = nullptr;
                }
                g.rebindFails = 0;
                // 自建上下文重绑连续失败降级 → 解锁 AE 上下文重查
                //（acquire 若失败过且重查次数已用尽，这里再给一次机会）
                s_aeRetryRequested = true;
                rfLog("ctx-rebind-giveup", (long)giveupFails);
            }
        }
        return g;
    }
    // 优先使用 AE 提供的离屏 GL 上下文（远程环境稳定，绕开虚拟显示驱动问题）。
    // 本分支必须排在 g.failed 短路**之前**——自建路径可能曾失败
    //（g.failed=true），但 AE 上下文分支不持有自建资源（hwnd/hdc/hglrc 已由
    // glCtxFail 回收），且 acquireAeGlContext 可在自建失败后重查成功
    //（s_aeRetryRequested）。旧顺序先短路会让新查到的 AE 上下文永远不被采用，
    // 会话滞留透传（这也是"g.failed 后 acquire 成功也不生效"的既有缺口）。
    if (kUseAeGlContext && s_aeHdc && s_aeRc) {
        // 从非 AE 上下文（自建，或已被判失效的旧 AE 句柄）
        // 切进 AE 上下文同样是名字空间更换，采纳前必须代际 +1——此处漏自增，
        // 是"自建降级 → 采纳 AE"整链上名字缓存不失效的第二处缺口。判据见
        // glCtxGenPolicy.h（同一 AE 句柄重绑不自增：名字仍有效，且要让消费点保住
        // 假阳性真删回收判据）。g.rebindFails 一并清零：新句柄的重绑失败计数从零起。
        const host::GlCtxGenDecision adoptGen =
            host::glCtxDecideAeAdopt(reinterpret_cast<std::uintptr_t>(g.rc),
                                     reinterpret_cast<std::uintptr_t>(s_aeRc));
        if (adoptGen.bump) {
            // 与 giveup 分支同款——被遗弃的上一句柄若是自建（owned），
            // 下一行 glCtxReleaseOwned 会真删它 → 记 0（已删句柄不做"句柄相等"
            // 判据的载体）；AE 句柄只丢引用，照旧记录。详见 glCtxGenPolicy.h。
            s_glCtxGenPrevRc = reinterpret_cast<HGLRC>(host::glCtxAbandonedRcAfterOwnedRecycle(
                g.owned, adoptGen.prevRc));
            ++s_glCtxGen;
            rfLog("ctx-ae-adopt-gen", (long)s_glCtxGen);
        }
        // AE 句柄不归本插件（下方回收路径一律不碰它们）。防御：若仍挂着
        // 自建三件套（不应发生——降级/失败路径都已回收），先按 owned 语义真回收，
        // 否则一旦被下方覆盖就又成泄漏。
        glCtxReleaseOwned(g);
        g.owned = false;   // 此后 g.hdc/g.rc 是 AE 的，任何收尾路径不得 wglDeleteContext
        g.hdc = s_aeHdc;
        g.rc  = s_aeRc;
        rfLog("ctx-ae-makecurrent", 0);
        if (!wglMakeCurrent(g.hdc, g.rc)) {
            rfLog("ctx-ae-makecurrent-fail", 0);
            // 连续失败达阈值清空缓存 + 复位 s_aeGot，下一次
            // renderFrame 的 acquireAeGlContext 强制重查 AE 设备套件（TDR 后
            // AE 重建的上下文返回新句柄）；未达阈值原样返回（瞬态失败可自愈）
            if (++s_aeBindFails >= 3) {
                // 代际自增前先记下被遗弃的句柄：若这只是瞬时抖动（AE 未换上下文，
                // 下次取回同一 HGLRC），入口消费代际时要按"名字仍有效、需真删"处理，
                // 否则帧纹理成显存垃圾（判据与两情形区别见 s_glCtxGenPrevRc 注释）。
                s_glCtxGenPrevRc = s_aeRc;
                s_aeHdc = nullptr;
                s_aeRc  = nullptr;
                s_aeGot = false;
                // 本实例的 g.rc/g.hdc 仍挂着
                // AE 的句柄引用——必须就地丢干净，与下方 rebind 降级分支（owned=false
                // 只丢引用，见 :1100 附近）对齐。若只清 s_ae*，下一次调用因
                // s_aeHdc/s_aeRc 为空落进自建创建分支，owned 翻转 true 后
                // CreateWindowEx/PF/tmp 任一早退 → glCtxFail → glCtxReleaseOwned(true)
                // → wglDeleteContext(仍是 AE 的 g.rc)，删掉 AE 自己的离屏上下文。
                g.hdc = nullptr;
                g.rc  = nullptr;
                s_aeBindFails = 0;
                // 从这里起旧上下文被判定失效（下一次 acquireAeGlContext 会
                // 重查，AE 侧 TDR 后返回新句柄）。代际 +1 广播所有 GL 名字缓存
                // 作废——即使 AE 返回的是同一个 HGLRC，旧名字也已随 TDR 失效，
                // 按"新上下文"处理是唯一安全选项（详见 s_glCtxGen 注释）。
                // 按句柄判真伪——真 TDR 时 AE 重建返回新
                // 句柄（上方注释即此前提），消费点自然走 clear-only；只有句柄未变的
                // 假阳性（连续失败只是瞬时占用/抖动）才真删回收，两种情形各自正确
                //（判据与理由见 s_glCtxGenPrevRc 注释）。四次修：句柄相等还须帧纹理
                // 身份交叉验证全过（防句柄值被回收复用后误删新上下文对象，见
                // solverFramesIdentityHolds 注释），不过则仍回落 clear-only。
                ++s_glCtxGen;
                rfLog("ctx-ae-stale-reset", 0);
            }
            return g;
        }
        // 绑定成功清零连续失败计数
        s_aeBindFails = 0;
        g.rebindFails = 0;   // 采纳的是新句柄，重绑失败计数从零起
        g.ok = true;
        g.cur = true;
        rfLog("ctx-ae-ok", 0);
        return g;
    }

    // 修复：自建 WGL 曾失败 → 短路不再重建（失败后渲染走 renderFrame 的
    // !g.ok 透传降级，不再重建窗口/HDC/HGLRC，防句柄泄漏累积）。AE 上下文
    // 分支（上方）的失败不置 failed：它不持有自建资源，缓存的失败 verdict
    // 也不再永久（有限重查 + 自建失败解锁）。
    if (g.failed) return g;

    // 进入自建创建前，若仍挂有本插件自有的陈旧三件套（防御；正常路径
    // 已由 glCtxFail/降级回收清空）先回收——绝不覆写句柄造成新一轮泄漏。
    // glCtxReleaseOwned 无条件清空三字段；下面再显式清一次是
    // 把「owned=true 之前句柄字段必为空」钉成本地不变量——owned 一旦翻转，任何
    // 早退都会让 glCtxFail 按自建语义 wglDeleteContext，若此时 g.rc 还是 AE 的
    // HGLRC 就会删掉 AE 的离屏上下文（状态机回归见 test_glctx_gen.cpp 的
    // test_create_after_ae_bindfail_never_deletes_ae_handle）。
    glCtxReleaseOwned(g);
    g.rc   = nullptr;
    g.hdc  = nullptr;
    g.hwnd = nullptr;
    g.owned = true;   // 此后创建的 hwnd/hdc/rc 归本插件，收尾路径可安全回收

    // 隐藏窗口
    rfLog("ctx-create-wnd", 0);
    WNDCLASS wc{};
    wc.style = CS_OWNDC;
    wc.lpfnWndProc = DefWindowProc;
    wc.hInstance = GetModuleHandle(nullptr);
    wc.lpszClassName = "AS_Effect_Host_GL";
    RegisterClass(&wc);
    // 把隐藏窗口放到物理显卡显示器的中心，避免 DC 落到虚拟显示驱动（否则 wgl* 崩溃）
    RECT disp = {0, 0, 8, 8};
    if (windowPlacement::findPhysicalDisplayRect(disp)) {
        rfLog("ctx-display-rect", disp.left * 10000 + disp.top);
    } else {
        rfLog("ctx-display-rect", 0);
    }
    const int wx = disp.left + (disp.right - disp.left) / 2;
    const int wy = disp.top + (disp.bottom - disp.top) / 2;
    g.hwnd = CreateWindowEx(0, wc.lpszClassName, "AS_Effect Host GL",
                            0, wx, wy, 8, 8, nullptr, nullptr, wc.hInstance, nullptr);
    if (!g.hwnd) { rfLog("ctx-create-wnd-fail", 0); glCtxFail(g); return g; }
    g.hdc = GetDC(g.hwnd);

    PIXELFORMATDESCRIPTOR pfd{};
    pfd.nSize = sizeof(pfd);
    pfd.nVersion = 1;
    pfd.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL;
    pfd.iPixelType = PFD_TYPE_RGBA;
    pfd.cColorBits = 32;
    rfLog("ctx-choose-pf", 0);
    int pf = ChoosePixelFormat(g.hdc, &pfd);
    if (!pf) { rfLog("ctx-choose-pf-fail", 0); glCtxFail(g); return g; }
    rfLog("ctx-set-pf", 0);
    if (!SetPixelFormat(g.hdc, pf, &pfd)) { rfLog("ctx-set-pf-fail", 0); glCtxFail(g); return g; }

    // 先用临时 1.x 上下文取 wglCreateContextAttribsARB
    rfLog("ctx-create-tmp", 0);
    HGLRC tmp = wglCreateContext(g.hdc);
    if (!tmp) { rfLog("ctx-create-tmp-fail", 0); glCtxFail(g); return g; }
    rfLog("ctx-makecurrent-tmp", 0);
    if (!wglMakeCurrent(g.hdc, tmp)) { rfLog("ctx-makecurrent-tmp-fail", 0); wglDeleteContext(tmp); glCtxFail(g); return g; }
    using PFN_WGL_CREATE_CONTEXT_ATTRIBS_ARB =
        HGLRC(WINAPI*)(HDC, HGLRC, const int*);
    rfLog("ctx-get-proc", 0);
    auto createAttribs = reinterpret_cast<PFN_WGL_CREATE_CONTEXT_ATTRIBS_ARB>(
        wglGetProcAddress("wglCreateContextAttribsARB"));
    if (createAttribs) {
        rfLog("ctx-create-attribs", 0);
        const int attribs[] = {
            WGL_CONTEXT_MAJOR_VERSION_ARB, 3,
            WGL_CONTEXT_MINOR_VERSION_ARB, 3,
            WGL_CONTEXT_PROFILE_MASK_ARB, WGL_CONTEXT_CORE_PROFILE_BIT_ARB,
            0
        };
        g.rc = createAttribs(g.hdc, nullptr, attribs);
        rfLog("ctx-create-attribs-done", (long)(intptr_t)g.rc);
    }
    rfLog("ctx-unbind-tmp", 0);
    wglMakeCurrent(nullptr, nullptr);
    rfLog("ctx-delete-tmp", 0);
    wglDeleteContext(tmp);
    if (!g.rc) { rfLog("ctx-no-rc", 0); glCtxFail(g); return g; }
    rfLog("ctx-makecurrent-final", 0);
    if (!wglMakeCurrent(g.hdc, g.rc)) { rfLog("ctx-makecurrent-final-fail", 0); glCtxFail(g); return g; }

    // 自建上下文成功创建（含 g.ok 降级后重新走到这里的情形）同样是"新上下文"
    // ——旧 GL 名字全部作废，代际 +1 广播（复用 AE 上下文的路径不在此列，那条路由
    // ctx-ae-stale-reset 触发代际 +1；首个自建上下文时代际从 0 变 1，各缓存本就为空）。
    // 判据置 nullptr——新 HGLRC 必与旧的不同，旧上下文（若有）
    // 已由 glCtxFail 删除，旧名字只能 clear-only，不可在消费点误入回收路径。
    s_glCtxGenPrevRc = nullptr;
    ++s_glCtxGen;
    g.ok = true;
    g.cur = true;
    // 与 AE 采纳成功路径对称（:1136 已有同款复位）——新建成功即新上下文，
    // 重绑失败计数必须从零起。不复位时：降级（rebindFails 已累计到阈值 30）后 AE
    // 始终不可用、走自建重建成功，此后第一次瞬时 makeCurrent 失败就会把计数顶到 31
    // → 立刻二次降级并重建（旧 HGLRC/HWND/HDC 已由 glCtxFail 回收，但用户看到的是
    // 周期性闪断重建）；复位后要再累计 30 次才降级，瞬态抖动由重试自愈。
    // 代际判据不受影响：本处自增与 prevRc=nullptr 是既有语义，与 rebindFails 无关。
    // 仅在确有遗留计数时留一行（降级后重建场景；正常首建 rebindFails=0 不刷日志）
    if (g.rebindFails != 0) rfLog("ctx-rebindfails-reset", (long)g.rebindFails);
    g.rebindFails = 0;
    // 只做 wgl* 上下文创建/回收，不调用 GL 函数（GLAD 指针在 gladLoadGL 之前为 null）。
    rfLog("ctx-ok", 0);
    return g;
}

// —— shader 编译 ——
GLuint compileShader(GLenum type, const char* src, std::string& errOut) {
    rfLog("cs-create", 0);
    GLuint s = glCreateShader(type);
    rfLog("cs-source", 0);
    glShaderSource(s, 1, &src, nullptr);
    rfLog("cs-compile", 0);
    glCompileShader(s);
    rfLog("cs-getiv", 0);
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        rfLog("cs-getlog", 0);
        char log[2048];
        glGetShaderInfoLog(s, sizeof(log), nullptr, log);
        errOut += Tr(S_EFFECTHOST_RENDERER_ERROR_SHADER_COMPILE);
        errOut += log;
        rfLog("cs-delete", 0);
        glDeleteShader(s);
        return 0;
    }
    rfLog("cs-ok", 0);
    return s;
}

GLuint linkProgram(GLuint vs, GLuint fs, std::string& errOut) {
    rfLog("lp-create", 0);
    GLuint p = glCreateProgram();
    rfLog("lp-attach-vs", 0);
    glAttachShader(p, vs);
    rfLog("lp-attach-fs", 0);
    glAttachShader(p, fs);
    rfLog("lp-link", 0);
    glLinkProgram(p);
    rfLog("lp-getiv", 0);
    GLint ok = 0;
    glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if (!ok) {
        rfLog("lp-getlog", 0);
        char log[2048];
        glGetProgramInfoLog(p, sizeof(log), nullptr, log);
        errOut += Tr(S_EFFECTHOST_RENDERER_ERROR_LINK);
        errOut += log;
        rfLog("lp-delete", 0);
        glDeleteProgram(p);
        return 0;
    }
    rfLog("lp-ok", 0);
    return p;
}

// 拼装片元着色器：用户入口（mainImage / iterateImage）+ 内置 uniform
// iChannel1/2/3（映射图层）：未使用时编译器优化剔除，location 查询得 -1，
// 渲染路径零开销。
// 拼接前剥离用户源码中的内置 uniform 声明（iChannel0..3/uTime/
// uResolution/uAspect）——旧注释「GLSL 330 允许同类型 uniform 重复声明」
// 不成立：GLSL 同作用域同名重复声明是编译错误，NVIDIA 宽容掩盖，AMD/Intel/
// 严格驱动直接编译失败（迁移自 Shadertoy 的 shader 常自带这些声明，在
// 严格驱动上完全不可用）。剥离见 uniformParser.cpp stripBuiltinUniformDecls。
//
// iteratePass：同一份用户源码编译两次得到两个程序——迭代趟
// （入口 iterateImage，被宿主连续调用 N 次）与主趟（入口 mainImage，调用一次）。
// 两趟的内置声明段**逐字相同**（含 iPrev/uIter/uIterCount），只有末尾包装的
// main() 不同：既让 mainImage 也能读到迭代结果（iPrev），也保证两侧 #line 1
// 之后的用户坐标系完全一致（编译错误行号不因趟而异）。
std::string buildFragmentSource(const char* glslSource, bool iteratePass) {
    std::string body = glslSource ? glslSource : "";
    body = glsl::stripBuiltinUniformDecls(body);
    // 宿主以 330 core 编译，桌面 GLSL 无精度语义（precision 是 ES 概念，
    // 4.10 起才被规范接受且同样无效果）——330 core 严格按规范无此语法，AMD/Intel
    // 严格驱动直接编译失败（NVIDIA 宽容掩盖；观察级条目"highp 驱动接受度"的收口）。
    // 剥离仅在宿主编译链（面板侧 WebGL 是 ES、必须保留精度），语义中性、行数不变。
    body = glsl::stripPrecisionQualifiers(body);
    std::string fs =
        // #version 必须是首行：缺失时驱动按 GLSL 110/120 编译，out 输出与
        // texture() 均非法（error C5060/C7532）。

        "#version 330 core\n"
        "uniform sampler2D iChannel0;\n"
        "uniform sampler2D iChannel1;\n"
        "uniform sampler2D iChannel2;\n"
        "uniform sampler2D iChannel3;\n"
        "uniform float uTime;\n"
        "uniform vec2 uResolution;\n"
        "uniform float uAspect;\n"
        "uniform vec2 uLayerSize;\n"
        "uniform float uHasCam;\n"
        "uniform float uCamFov;\n"
        "uniform vec3 uCamPos;\n"
        "uniform mat4 uCamMatrix;\n"
        "uniform mat4 uWorldMatrix;\n"
        "uniform float uHasLights;\n"
        "uniform float uLightCount;\n"
        "uniform float uLightType[8];\n"
        "uniform vec3 uLightPos[8];\n"
        "uniform vec3 uLightDir[8];\n"
        "uniform vec3 uLightColor[8];\n"
        "uniform vec4 uLightParams[8];\n"
        "uniform sampler2D iPrev;\n"
        "uniform float uIter;\n"
        "uniform float uIterCount;\n"
        "uniform float uStep;\n"
        "uniform float uFrame;\n"
        "uniform float uDt;\n"
        "uniform sampler2D iHistory0;\n"
        "uniform sampler2D iHistory1;\n"
        "uniform sampler2D iHistory2;\n"
        "uniform sampler2D iHistory3;\n"
        "in vec2 vUv;\n"
        "out vec4 fragColor;\n";
    // 骨架在用户代码前拼了 15 行（比面板侧 glslValidator 的
    // 13 行多 2——多 3 个 sampler、少 1 行 precision），不加 #line 时错误按整份源码行号
    // 上报：用户第 N 行被报成 N+15，且与面板校验的 +13 不一致（同一份 shader 两侧报出
    // 不同行号）。用 #line 声明紧随其后的行号为 1，使宿主侧报错（写入 effects/error.log，
    // 也就是 get_render_error 读的那份）与面板编译校验统一回到用户坐标系。
    // ⚠️ 已知残留：uniformParser::stripBuiltinUniformDecls 删除内置 uniform 声明时，单行
    // 声明只删正文、保留换行（行数不变，本 #line 准确）；多行 declarator 链被重建为单行
    // 时会折掉换行，该情形下行号仍会漂移。
    fs += "#line 1\n";
    fs += body;
    // mainImage 收到 y 向上的标准 UV（左下原点，Shadertoy 惯例）。
    // 不再翻转 uv.y；iChannel0 源纹理已在上传时上下翻转（见 rf-pix 段），
    // 因此 texture(iChannel0, uv) 采样结果依然正向。
    fs += iteratePass
        ? "\nvoid main() {\n"
          "    fragColor = iterateImage(vUv, uTime);\n"
          "}\n"
        : "\nvoid main() {\n"
          "    fragColor = mainImage(vUv, uTime);\n"
          "}\n";
    return fs;
}

// —— AE world → RGBA float 上传缓冲（实现见 pixelConvert.cpp）——
// iChannel0 与映射图层（iChannel1/2/3）/输入历史共用同一条转换：顶行 ARGB →
// 底行 RGBA float（上下翻转；翻转后纹理 t=1 对应 AE 顶行，配合 mainImage 收到
// y 向上的标准 UV）。通道归一化与翻转语义集中在 pixelConvert.h。
// 循环体移出本文件并向量化（renderer.cpp 依赖 glad/AE SDK，
// 单测链接不进去；抽出的 TU 可被 glsl_core_tests 直接做逐位等价性验证）。
// 本包装只负责尺寸适配（A_long → int32_t）与缓冲扩容。
static void convertWorldToRgba(const PF_LayerDef* src, std::vector<float>& rgba) {
    const A_long W = src->width, H = src->height;
    if (W <= 0 || H <= 0) { rgba.clear(); return; }
    rgba.resize((size_t)W * H * 4);
    host::convertWorldToRgba(src->data, (int32_t)src->rowbytes, (int32_t)W, (int32_t)H,
                             detectDepth(src->rowbytes, src->width), rgba.data());
}

// GPU / GL 版本信息写一次诊断日志。只在 gladLoadGL 成功后调用：glGetString 等
// GLAD 函数指针在 gladLoadGL 之前为 null。
static void logGpuInfoOnce() {
    static bool s_logged = false;
    if (s_logged) return;
    s_logged = true;
    const char* renderer = reinterpret_cast<const char*>(glGetString(GL_RENDERER));
    const char* vendor = reinterpret_cast<const char*>(glGetString(GL_VENDOR));
    const char* version = reinterpret_cast<const char*>(glGetString(GL_VERSION));
    rfLog("ctx-gpu-renderer", (long)(intptr_t)renderer);
    rfLog("ctx-gpu-vendor", (long)(intptr_t)vendor);
    rfLog("ctx-gpu-version", (long)(intptr_t)version);
    if (!renderer) return;
    const std::string gpuLogPath = host::diagLogFilePath("as_effect_host.log");
    // 与 logCmd/rfLog/srLog 同一文件同一追加互斥；体积同受 16MB 轮转约束
    host::maybeRotateDiagLog();
    host::lockDiagAppend();
    if (!gpuLogPath.empty()) {
        // 三行成一个信息块：appendDiagLogLine 只补一次时间戳（在首行），
        // 逐行加戳会把一个块拆成三条看不出关联的记录
        char body[512];
        std::snprintf(body, sizeof(body),
                      "GPU_RENDERER=%s\nGPU_VENDOR=%s\nGL_VERSION=%s",
                      renderer, vendor ? vendor : "null", version ? version : "null");
        host::appendDiagLogLine(body);
    }
    host::unlockDiagAppend();
}

// 透传：逐行拷贝输入到输出（取 rowbytes / 高度最小值防越界）。上下文不可用或
// 版本不足时保持画面可用；返回错误码会让 AE 丢弃输出显示"渲染失败"黑帧。
static PF_Err copyInputToOutput(const PF_LayerDef* src, PF_LayerDef* output) {
    const A_long rows = (std::min)(src->height, output->height);
    const A_long bytes = (std::min)(src->rowbytes, output->rowbytes);
    if (rows > 0 && bytes > 0) {
        for (A_long y = 0; y < rows; ++y) {
            std::memcpy(
                reinterpret_cast<unsigned char*>(output->data) + y * output->rowbytes,
                reinterpret_cast<const unsigned char*>(src->data) + y * src->rowbytes,
                bytes);
        }
    }
    return PF_Err_NONE;
}

} // namespace

PF_Err renderFrame(PF_InData* in_data, PF_OutData* out_data,
                   PF_LayerDef* src, PF_LayerDef* output,
                   const char* glslSource,
                   const std::vector<glsl::Param>* uniforms,
                   char* errorLogOut, size_t errorLogCap,
                   const float* userValues,
                   const PF_LayerDef* const* mapLayers,
                   const CameraUniforms* cam,
                   const LightUniforms* lights,
                   const PF_LayerDef* const* historyLayers,
                   int historyCount,
                   double solveGeneration,
                   uint64_t instanceInstanceId) {
    (void)out_data;
    std::string err; // 本帧错误文本
    if (errorLogCap) errorLogOut[0] = 0;

    rfLog("rf-enter", 0);
    if (!src || !output || !src->data || !output->data) { rfLog("rf-null-io", 0); return PF_Err_NONE; }

    RenderPerfScope perf;   // 分段计时（默认关，AS_EFFECT_HOST_PERF=1 开；析构落一行）

    // 串行化所有 GL 访问：单上下文 + 全局锁，MFR 多线程安全
    rfLog("rf-lock", 0);
    GLLock glLock(g_glCS);
    rfLog("rf-glctx", 0);
    acquireAeGlContext(in_data, out_data);  // 获取 AE 离屏 GL 上下文（若可用），避免自建 WGL 崩溃
    GlContext& g = glCtx();
    if (!g.ok) {
        // 上下文创建失败：优雅降级为透传（拷贝输入到输出），不返回错误码。
        // 返回错误码会让 AE 丢弃输出显示"渲染失败"黑帧；透传至少保持画面可用、不崩溃。
        err = Tr(S_EFFECTHOST_RENDERER_ERROR_GL_CONTEXT);
        rfLog("rf-no-ctx", 0);
        if (errorLogCap) std::snprintf(const_cast<char*>(errorLogOut), errorLogCap, "%s", err.c_str());
        return copyInputToOutput(src, output);
    }
    GlFrameGuard frameGuard;
    if (!g.cur) {
        err = Tr(S_EFFECTHOST_RENDERER_ERROR_GL_BIND);
        rfLog("rf-no-bind", 0);
        if (errorLogCap) std::snprintf(const_cast<char*>(errorLogOut), errorLogCap, "%s", err.c_str());
        return PF_Err_INTERNAL_STRUCT_DAMAGED;
    }

    static bool loaded = false;
    if (!loaded) {
        rfLog("rf-glad-load", 0);
        if (!gladLoadGL()) {
            err = Tr(S_EFFECTHOST_RENDERER_ERROR_GLAD_LOAD);
            rfLog("rf-glad-fail", 0);
            if (errorLogCap) std::snprintf(const_cast<char*>(errorLogOut), errorLogCap, "%s", err.c_str());
            return PF_Err_INTERNAL_STRUCT_DAMAGED;
        }
        loaded = true;
        rfLog("rf-glad-ok", 0);
        logGpuInfoOnce();
        // gladLoadGL 成功只保证 glGetString / GL_VERSION 可读；上下文版本低于 3.3 时
        // glad 按版本闸门跳过 3.x 装载，函数指针保持 null。缺任一入口即按上下文
        // 不可用降级透传，避免首次使用时调用 null 指针。
        if (!GLAD_GL_VERSION_3_3 || !glGenFramebuffers || !glCreateShader || !glGenVertexArrays) {
            rfLog("rf-gl-version-low", (long)GLVersion.major * 10 + GLVersion.minor);
            err = Tr(S_EFFECTHOST_RENDERER_ERROR_GL_VERSION);
            if (errorLogCap) std::snprintf(const_cast<char*>(errorLogOut), errorLogCap, "%s", err.c_str());
            return copyInputToOutput(src, output);
        }
    }
    // —— 上下文代际检查 ——
    // 到这里上下文已成功绑定（上方 !g.ok / !g.cur 早退不会消费代际）。代际变了 =
    // 旧上下文被 TDR/设备切换废掉、这批 GL 名字在新上下文里无效：文件作用域的
    // 名字缓存在各 ensure* 里按代际自清；本函数内的静态缓存（输入纹理/program 表/
    // VAO/VBO/PBO/映射与历史纹理）在下方各自声明处按本标志清零，结算帧缓存见下方
    // 代际消费点处的自清块。早退路径不消费本标志——留给下一次真正渲染的调用处理。
    static uint64_t s_seenGlCtxGen = 0;
    const uint64_t prevSeenGlCtxGen = s_seenGlCtxGen;   // 消费前的代际（回收判据的 prevGen）
    const bool glCtxChanged = glNameStale(&s_seenGlCtxGen);
    if (glCtxChanged) rfLog("rf-ctx-gen-reset", static_cast<long>(s_glCtxGen));
    // —— 谱系帧缓存自清 ——
    // 必须在**代际消费点**就地清，而不是拖到 Solver 分支：s_seenGlCtxGen 是进程级
    // static，代际变化后**第一个**渲染的实例消费它（哪怕是普通迭代/透传实例）。若
    // 结算实例不是第一个（代际被别的实例消费），或本实例的路径在 Solver 分支前早退
    //（如 ensureSolveScratch/ensureSolveZeroTex 失败、uniform 解析失败——都 return），
    // 就会在后续帧继续把旧上下文的帧纹理名当采样源（持续黑/花屏），且回卷时的
    // glDeleteTextures 可能删到新上下文里复用了同名的新对象。放到本处后，任何一个
    // 消费代际的调用都会顺带清掉全局谱系帧缓存；后续 renderFrame 代际已匹配、不再清。
    // 清空语义（分两种情形，判据 = 遗弃句柄是否 == 当前绑定的句柄；
    // 四次修给"相等"再加一层帧纹理身份交叉验证，理由见 solverFramesIdentityHolds）：
    //  · 真重建（当前句柄 != 遗弃句柄，或判据为空，或身份验证不过）：旧上下文已消失/
    //    名字已复用，**不**调 glDeleteTextures（删名字会误删新上下文里的活对象；
    //    旧对象随旧上下文一起没了）。只清帧纹理缓存与 firstFrame 等元数据。
    //  · 假阳性（当前句柄 == 遗弃句柄 **且** 帧纹理身份全部验证通过）：连续 makeCurrent
    //    失败只是瞬时占用/驱动抖动，AE 上下文没换，旧名字仍指向同一上下文里的**活**
    //    对象——clear-only 会让这些帧纹理无人引用也无人释放（每谱系最多 ~512MB，反复
    //    抖动即显存长期增长），必须走 freeSolverFrames 真删回收（glDeleteTextures +
    //    clear + firstFrame=0）。
    // 谱系键与网格/位深元数据不含 GL 名字，两情形都留用；重解按既有 LRU 预算重新填帧。
    // 锁序：进入点已持 GLLock（上方 g_glCS），此处取 s_solverCS 仍是 GLLock → s_solverCS
    //（与 Solver 分支的 slk 同序，Solver 分支不再重复清——代际已被本处消费，见其注释）。
    if (glCtxChanged) {
        CSLock ctxResetLk(s_solverCS);
        const HGLRC curRc = wglGetCurrentContext();   // 已绑定（上方 g.cur 检查），即 g.rc
        // 把本代际的判据冻结下来供其余名字缓存点复用（见 s_glCtxReclaimGen
        // 注释）——冻结先于下面的谱系回收，两处用同一判据（纯函数 glCacheReclaimAllowed）。
        s_glCtxReclaimGen = s_glCtxGen;
        s_glCtxReclaimHandleSame = (s_glCtxGenPrevRc != nullptr && curRc == s_glCtxGenPrevRc);
        s_glCtxReclaimRc = curRc;
        if (s_glCtxReclaimHandleSame) {
            // 第二层判据：句柄相等只是"可能没换"，还需每条谱系的帧纹理身份抽验全过
            //（glIsTexture + level0 尺寸 vs simW/simH）才允许真删；任一谱系不过 =>
            // 整条按"真重建"走 clear-only（宁漏回收不误删）。
            bool identityOk = true;
            for (const auto& kv : s_solverLineages) {
                if (!solverFramesIdentityHolds(kv.second)) { identityOk = false; break; }
            }
            if (host::glCacheReclaimAllowed(prevSeenGlCtxGen, s_glCtxGen,
                                            s_glCtxReclaimHandleSame, identityOk)) {
                size_t reclaimed = 0;
                for (auto& kv : s_solverLineages) {
                    reclaimed += kv.second.frames.size();
                    freeSolverFrames(kv.second);   // 同一上下文、名字仍有效 → 真删回收
                }
                rfLog("solve-cache-ctx-reset-reclaim", (long)reclaimed);
            } else {
                for (auto& kv : s_solverLineages) {
                    kv.second.frames.clear();
                    kv.second.firstFrame = 0;
                }
                rfLog("solve-cache-ctx-reset-veto", (long)s_solverLineages.size());
            }
        } else {
            for (auto& kv : s_solverLineages) {
                kv.second.frames.clear();
                kv.second.firstFrame = 0;
            }
            rfLog("solve-cache-ctx-reset", (long)s_solverLineages.size());
        }
        // 判据已消费：本代际只消费一次（s_seenGlCtxGen 已置新），清掉免得下次误比对；
        // 下一次自增会重写（自建上下文新建处写 nullptr，AE 失效处写旧句柄）。
        // 注意：冻结快照（s_glCtxReclaimGen 等）**不清**——其余名字缓存点晚于本处
        // 消费代际，要靠它做真删回收。
        s_glCtxGenPrevRc = nullptr;
    }
    // —— 借用 AE 上下文的状态保护：GLLock 只还原上下文绑定，不还原 GL 状态。
    // 保存进入时的 viewport / UNPACK_ALIGNMENT，渲染结束前还原（见 rf-restore 段），
    // 避免遗留进 AE 的 offscreen 上下文。
    GLint prevViewport[4] = {0, 0, 0, 0};
    glGetIntegerv(GL_VIEWPORT, prevViewport);
    GLint prevUnpackAlign = 4;
    glGetIntegerv(GL_UNPACK_ALIGNMENT, &prevUnpackAlign);
    // 快照 activeTexture / TEXTURE_2D 绑定 / VAO 绑定——只还原
    // viewport/FBO/UNPACK_ALIGNMENT，本函数变更的这三个绑定态遗漏进 AE 自身的
    // GPU 管线。映射图层（N7 扩展）占用纹理单元 0-3：快照/还原全部 4 个单元
    // 的 TEXTURE_2D 绑定（进入时活跃单元可能是 4..N，其绑定单独记录，
    // 早退路径仅还原该单元——单元 0-3 的变更只发生在末尾统一还原点之前）。
    // 迭代趟的 iPrev 占单元 4 → 快照/还原范围扩到 0-4
    //（kTexUnitsTracked）。iHistory0..3 占单元 5-8 →
    // 再扩到 0-8。范围常量单点维护，勿再散落魔数。
    constexpr int kTexUnitsTracked = 9;   // 单元 0..8：iChannel0 / iChannel1-3 / iPrev / iHistory0-3
    GLint prevActiveTexture = GL_TEXTURE0;
    glGetIntegerv(GL_ACTIVE_TEXTURE, &prevActiveTexture);
    GLint prevTexBindingEntry = 0;                       // 进入时活跃单元的绑定（早退路径还原用）
    glGetIntegerv(GL_TEXTURE_BINDING_2D, &prevTexBindingEntry);
    GLint prevTexBinding2D[kTexUnitsTracked] = {0, 0, 0, 0, 0, 0, 0, 0, 0};   // 单元 0-8（末尾统一还原）
    for (int u = 0; u < kTexUnitsTracked; ++u) {
        glActiveTexture(GL_TEXTURE0 + u);
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &prevTexBinding2D[u]);
    }
    glActiveTexture((GLenum)prevActiveTexture);          // 回到进入时单元（早退路径按旧语义还原）
    GLint prevVao = 0;
    glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &prevVao);
    // 补快照 FBO / PBO 绑定——与 viewport/纹理/VAO 快照-还原同策略。
    // 退出不能硬编码 glBindFramebuffer/glBindBuffer 还原到 0：借用 AE 离屏
    // 上下文时其管线可能绑有自身 FBO/PBO，硬编码 0 会改写其绑定，AE 后续
    // 绘制落到错误目标。PBO 仅在末尾读回段绑定，早退路径不触达无需还原
    GLint prevFbo = 0;
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &prevFbo);
    GLint prevPbo = 0;
    glGetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &prevPbo);
    // 失败占位帧走 GDI 光栅化（不触 GL 清除色），
    // 故无需 clearColor 快照-还原。

    const A_long W = src->width, H = src->height;
    const PixelDepth inDepth = detectDepth(src->rowbytes, src->width);
    perf.W = (int)W; perf.H = (int)H;
    rfLog("rf-depth", (long)inDepth);
    rfLog("rf-depth-in-rb", src->rowbytes);
    rfLog("rf-depth-out-rb", output->rowbytes);

    rfLog("rf-fbo", 0);
    if (!ensureFramebuffer(W, H, inDepth, err)) {
        rfLog("rf-fbo-fail", 0);
        if (errorLogCap) std::snprintf(const_cast<char*>(errorLogOut), errorLogCap, "%s", err.c_str());
        glBindFramebuffer(GL_FRAMEBUFFER, (GLuint)prevFbo);  // 失败前可能已绑 FBO，还原进入时绑定（勿硬编码 0 改写 AE 自身绑定）
        // ensureFramebuffer 的 resize 分支已 glBindTexture(s_rtTex)，
        // 早退路径同样还原纹理绑定（activeTexture/VAO/viewport 在此路径尚未被本函数修改；
        // 活跃单元 = 进入时单元，还原其进入时绑定）
        glBindTexture(GL_TEXTURE_2D, (GLuint)prevTexBindingEntry);
        return PF_Err_INTERNAL_STRUCT_DAMAGED;
    }
    rfLog("rf-fbo-ok", 0);

    // —— 输入纹理是否需要 ——
    // 判据收在 uniformParser 的 inputLayerNeeded（纯函数、有原生单测）：引用 iChannel0，
    // 或**非结算模式**下的 iPrev（结算模式的 iPrev 全程是状态纹理，与输入无关）。
    // 这判据差点写错：曾按"有迭代趟 ⇒ iPrev 不是输入"来判，而 @iterations 的反馈类
    // shader（example_reaction_diffusion：11 处 iPrev、0 处 iChannel0）首趟读的就是输入图层。
    // 实测动机：16bit 工程下"AE 帧 → RGBA float 转换 + 上传"合计 13.7ms/帧、占整帧
    // 38%（1080p/@solve 256²），而结算类与纯生成类 shader 全文不出现 iChannel0。
    // 输入图层纹理句柄（声明提前到"是否需要输入"判据之前：上传段要用；跨帧存活，故 static）
    static GLuint s_tex = 0;
    // 上次分配尺寸/位深记忆（声明随句柄上移——代际回收判据在清零点就要用它做
    // 身份验证；语义与位置无耦合：仅上传段读写）
    static A_long s_texW = 0, s_texH = 0;
    static PixelDepth s_texDepth = PixelDepth::Bits8;
    // 上下文重建后旧名字作废（尺寸/位深记忆一并清零）。
    // 清零前判**真删回收**（假阳性：瞬时抖动取回同一 HGLRC，旧对象仍在活上下
    // 文里无人引用——clear-only 即显存垃圾）。身份 = level0 尺寸 vs 上次分配尺寸记忆。
    if (glCtxChanged) {
        if (glCtxCacheReclaimOk(prevSeenGlCtxGen, glTextureIdentityOk(s_tex, s_texW, s_texH)))
            glDeleteTextures(1, &s_tex);
        s_tex = 0;
        s_texW = 0; s_texH = 0; s_texDepth = PixelDepth::Bits8;
    }
    const std::string srcForInput = glslSource ? glslSource : "";
    const bool needInputTex = glsl::inputLayerNeeded(srcForInput);

    // —— 输入像素：AE ARGB(8/16/32bit) → RGBA float 上传 ——
    // PF_Pixel 内存序 A R G B；GL 需要 R G B A。
    // 16bit 通道 1.0=32768（可到 2.0）；32bit 通道已是 float [0,1]。
    // 源纹理以上下翻转的方式上传（convertWorldToRgba 内实现）：AE 图层顶行
    // （src 行 0）→ 纹理 t=1 行。配合 main() 内不再翻转 uv.y（mainImage 收到
    // y 向上的标准 UV），使 texture(iChannel0, uv) 采样结果正向（Shadertoy 惯例）。
    rfLog("rf-pix-conv", (long)inDepth);
    std::vector<float>& rgba = s_frameRgba;
    if (needInputTex) {
        convertWorldToRgba(src, rgba);
    } else {
        // 无入口读输入：不转换、不上传（上传段同样跳过）。s_tex 保持未创建——会绑它的
        // 路径都不在此模式下路过：结算的状态纹理分配失败改为明确报错早退（见
        // emitErrorFrame 的调用点），非结算模式则必然需要输入（inputLayerNeeded 判据）。
        rfLog("rf-pix-skip", 0);
    }
    perf.markConv();
    rfLog("rf-pix-done", 0);

    // —— shader program 缓存（按源码串缓存；N1 修复）——
    // 单 s_lastSource/s_prog：多实例（不同图层选不同 .glsl）交替渲染时
    // 每帧 srcStr != s_lastSource → glDeleteProgram + 全量重编译。改为按源码串
    // 缓存 ≤kMaxCachedProgs 个程序（LRU 淘汰），交替渲染零重编译。
    static constexpr size_t kMaxCachedProgs = 4;
    // uniform location 缓存：shader link 成功后一次性查询，渲染循环零查询
    // （原方案在渲染循环中惰性查询 glGetUniformLocation，MFR 多线程下 GPU 驱动
    //   导致栈/堆损坏崩溃。改为 link 后批量查询，远离渲染热路径。）
    struct UniformLocations {
        GLint iChannel0 = -1;
        GLint iChannelN[3] = {-1, -1, -1};   // iChannel1/2/3（映射图层；未声明/被优化剔除 = -1）
        GLint uTime = -1;
        GLint uResolution = -1;
        GLint uLayerSize = -1;                // 全分辨率尺寸（分辨率无关，见前导注释）
        GLint uAspect = -1;
        GLint uHasCam = -1;                   // L2 相机感知（未使用 = -1，下同）
        GLint uCamFov = -1;
        GLint uCamPos = -1;
        GLint uCamMatrix = -1;
        GLint uWorldMatrix = -1;
        // L3 灯光感知（未使用/整个数组被剔除 = -1，下同）。
        // 数组位置统一查首元素（"uLightPos[0]"）——规范允许用数组名查首元素，
        // 但驱动实现不一，用 [0] 最稳；须与 glUniform*v 的连续写入配套。
        GLint uHasLights = -1;
        GLint uLightCount = -1;
        GLint uLightType = -1;
        GLint uLightPos = -1;
        GLint uLightDir = -1;
        GLint uLightColor = -1;
        GLint uLightParams = -1;
        // 迭代趟内置：iPrev 采样上一趟输出（单元 4）；
        // uIter/uIterCount 供 shader 区分初始化趟与步进趟。两趟共用同一结构
        // （迭代趟与主趟各持一份，见 ProgEntry）。
        GLint iPrev = -1;
        GLint uIter = -1;
        GLint uIterCount = -1;
        GLint uStep = -1;                     // 绝对步号（Stateless=趟号，Solver=累计步号）
        GLint uFrame = -1;                    // 合成帧号（Stateless 恒 0）
        GLint uDt = -1;                       // 每子步真实秒数：@solve/@iterations=帧时长/子步数；@solveHz=1/Hz
        GLint iHistoryN[glsl::kMaxHistory] = {-1, -1, -1, -1};   // I2a 输入历史（单元 5..8）
        std::vector<GLint> userSlots;  // 与 uniforms 列表对齐
    };
    struct ProgEntry {
        std::string src;
        GLuint prog = 0;               // 主趟（mainImage）；0 = 编译失败（缓存失败结果，避免每帧重试编译）
        GLuint progIter = 0;           // 迭代趟（iterateImage）；仅 iterDefined 时非 0
        bool iterDefined = false;      // 该源码定义了 iterateImage → 本帧走迭代循环
        glsl::IterConfig cfg;          // 迭代/结算配置（编译期解析一次，渲染期零解析）
        std::string compileError;      // 失败时的编译/链接错误（UTF-8，失败占位帧每帧要画）
        UniformLocations uloc;         // 主趟 uniform 位置
        UniformLocations ulocIter;     // 迭代趟 uniform 位置（iterDefined 时有效）
        unsigned long long lastUse = 0;   // LRU 时钟
    };
    static std::vector<ProgEntry> s_progs;
    static unsigned long long s_useClock = 0;
    // 当前绑定的 program：仅目标 != 当前绑定时才 glUseProgram——实证"同 id 重复
    // use"会触发 GPU 驱动崩溃（见下方注释）；从不绑定 0（不 unbind 策略）
    static GLuint s_curProg = 0;
    // 上下文重建后 program 名作废——清空缓存表（旧 program 随旧上下文消失，
    // 不调 glDeleteProgram：名字可能已被新上下文复用作别的对象），s_curProg 归 0
    // 让首次 useProgram 正常走 glUseProgram。清表即"每源码一条目"的缓存重建，
    // 下一次命中同源码会重新编译，无法复用旧上下文里的 program（也没法复用）。
    if (glCtxChanged) { s_progs.clear(); s_useClock = 0; s_curProg = 0; }

    // 本帧的 shader 源码串（program 缓存键）。声明须早于下方 buildPass lambda——
    // lambda 按引用捕获它，C++ 要求捕获名在 lambda 定义点已可见。
    const std::string srcStr = glslSource ? glslSource : "";

    // —— 编译单趟程序（主趟/迭代趟共用）——
    // 同一份用户源码按 iteratePass 拼两个骨架（入口不同），故两趟的编译/链接/
    // location 查询/驱动规避流程完全同构——抽成一处避免两份拷贝漂移（本仓库
    // 反复踩过"两侧不同步"的坑）。
    // 返回 program id；0 = 失败（错误文本追加进 errOut）。成功后立即批量查询
    // location 并 use+validate（驱动在首次 use 时做延迟优化，不先 use 会崩）。
    auto buildPass = [&](bool iteratePass, UniformLocations& locOut, std::string& errOut) -> GLuint {
        const char* vsSrc =
            "#version 330 core\n"
            "layout(location=0) in vec2 aPos;\n"
            "out vec2 vUv;\n"
            "void main() {\n"
            "    vUv = aPos * 0.5 + 0.5;\n"
            "    gl_Position = vec4(aPos, 0.0, 1.0);\n"
            "}\n";
        // GLSL 规范不允许 uniform 带初始化器：编译前剥离（默认值已由 parseUniforms 提取，
        // 供 AE 参数初始化；active.glsl 原文保留初始化器，宿主重载时仍可解析 def）
        std::string fsSrc = buildFragmentSource(
            srcStr.empty() ? nullptr : glsl::stripUniformInitializers(srcStr).c_str(), iteratePass);

        rfLog("rf-shader-vs", 0);
        GLuint vs = compileShader(GL_VERTEX_SHADER, vsSrc, errOut);
        rfLog("rf-shader-vs-done", (long)vs);
        rfLog(iteratePass ? "rf-shader-fs-iter" : "rf-shader-fs", 0);
        GLuint fs = vs ? compileShader(GL_FRAGMENT_SHADER, fsSrc.c_str(), errOut) : 0;
        rfLog("rf-shader-fs-done", (long)fs);
        GLuint prog = 0;
        if (vs && fs) {
            rfLog("rf-shader-link", 0);
            prog = linkProgram(vs, fs, errOut);
            rfLog("rf-shader-link-done", (long)prog);
        }
        if (vs) {
            rfLog("rf-shader-del-vs", 0);
            glDeleteShader(vs);
        }
        if (fs) {
            rfLog("rf-shader-del-fs", 0);
            glDeleteShader(fs);
        }
        if (!prog) return 0;

        // —— link 成功：立即批量查询所有 uniform location ——
        // 关键：所有 glGetUniformLocation 调用集中在此处（非渲染热路径），
        // 渲染循环只读缓存值，避免 MFR 多线程下驱动 bug。
        rfLog("rf-loc-batch", 0);
        locOut.iChannel0 = glGetUniformLocation(prog, "iChannel0");
        // 映射图层：link 后批量查询 iChannel1/2/3（未声明/被优化剔除 = -1，
        // 渲染路径据此跳过该 channel 的纹理绑定）
        for (int ci = 0; ci < host::kIdxMapChannels; ++ci) {
            char cname[16];
            std::snprintf(cname, sizeof(cname), "iChannel%d", ci + 1);
            locOut.iChannelN[ci] = glGetUniformLocation(prog, cname);
        }
        locOut.iPrev = glGetUniformLocation(prog, "iPrev");
        locOut.uIter = glGetUniformLocation(prog, "uIter");
        locOut.uIterCount = glGetUniformLocation(prog, "uIterCount");
        locOut.uStep = glGetUniformLocation(prog, "uStep");
        locOut.uFrame = glGetUniformLocation(prog, "uFrame");
        locOut.uDt = glGetUniformLocation(prog, "uDt");
        for (int hi = 0; hi < glsl::kMaxHistory; ++hi) {
            char hname[16];
            std::snprintf(hname, sizeof(hname), "iHistory%d", hi);
            locOut.iHistoryN[hi] = glGetUniformLocation(prog, hname);
        }
        locOut.uTime = glGetUniformLocation(prog, "uTime");
        locOut.uResolution = glGetUniformLocation(prog, "uResolution");
        locOut.uLayerSize = glGetUniformLocation(prog, "uLayerSize");
        locOut.uAspect = glGetUniformLocation(prog, "uAspect");
        // L2 相机感知：与既有内置同批量查询（shader 未声明 → -1，上传段跳过）
        locOut.uHasCam = glGetUniformLocation(prog, "uHasCam");
        locOut.uCamFov = glGetUniformLocation(prog, "uCamFov");
        locOut.uCamPos = glGetUniformLocation(prog, "uCamPos");
        locOut.uCamMatrix = glGetUniformLocation(prog, "uCamMatrix");
        locOut.uWorldMatrix = glGetUniformLocation(prog, "uWorldMatrix");
        // L3 灯光感知：数组查首元素（"name[0]"）——见 UniformLocations 注释
        locOut.uHasLights = glGetUniformLocation(prog, "uHasLights");
        locOut.uLightCount = glGetUniformLocation(prog, "uLightCount");
        locOut.uLightType = glGetUniformLocation(prog, "uLightType[0]");
        locOut.uLightPos = glGetUniformLocation(prog, "uLightPos[0]");
        locOut.uLightDir = glGetUniformLocation(prog, "uLightDir[0]");
        locOut.uLightColor = glGetUniformLocation(prog, "uLightColor[0]");
        locOut.uLightParams = glGetUniformLocation(prog, "uLightParams[0]");
        // 用户 uniform：按传入的 uniforms 列表查询（若有）
        if (uniforms && !uniforms->empty()) {
            locOut.userSlots.resize(uniforms->size());
            for (size_t i = 0; i < uniforms->size(); ++i) {
                locOut.userSlots[i] = glGetUniformLocation(prog, (*uniforms)[i].name.c_str());
            }
        } else {
            locOut.userSlots.clear();
        }
        rfLog("rf-loc-batch-done", (long)locOut.userSlots.size());
        // 驱动 bug 排查：link 后立即 glUseProgram + glValidateProgram
        // 某些 GPU 驱动在首次 use 时触发延迟优化，可能崩溃
        rfLog("rf-link-use-program", (long)prog);
        glUseProgram(prog);
        s_curProg = prog;
        rfLog("rf-link-use-program-ok", 0);
        glValidateProgram(prog);
        GLint status = 0;
        glGetProgramiv(prog, GL_VALIDATE_STATUS, &status);
        rfLog("rf-validate", (long)status);
        // 不 unbind：保持 program current，避免后续纹理/VAO 操作后
        // 重新 glUseProgram 触发驱动 bug（实测 unbind→纹理→reuse 崩溃）
        return prog;
    };

    static GLuint s_vao = 0, s_vbo = 0;
    // PBO（异步读回，减少 GPU→CPU stall）
    static GLuint s_pbo = 0;
    // 上下文重建后 VAO/VBO/PBO 名字作废，置 0 让下方/读回段的按需分配重新
    // glGen*（VAO 若不清，glBindVertexArray 绑到旧名字 → 绘制无顶点数据 → 黑帧）
    // 有意**不**做真删回收：VAO/VBO/PBO 无身份基准（VAO 无尺寸、VBO 是固定 8
    // 顶点常量数据、PBO 容量随读回路径单调增长），仅凭存在性无法排除"句柄值复用 +
    // 名字撞车"的误删；三者皆为小对象（VBO 32B；PBO 的显存由 glBufferData 按需重分配），
    // 按"宁漏回收不误删"维持只置 0。显存回收关切见纹理缓存点（本文件 glCtxCacheReclaimOk）。
    if (glCtxChanged) { s_vao = 0; s_vbo = 0; s_pbo = 0; }

    ProgEntry* entry = nullptr;
    for (auto& pe : s_progs) {
        if (pe.src == srcStr) { entry = &pe; break; }
    }
    bool progRebuilt = false;   // [临时诊断] 本帧是否走编译/失败缓存新建分支
    if (!entry) {
        progRebuilt = true;
        // 先淘汰（LRU，跳过当前绑定程序）再插入，保证 entry 指针稳定
        if (s_progs.size() >= kMaxCachedProgs) {
            auto victim = s_progs.end();
            for (auto it = s_progs.begin(); it != s_progs.end(); ++it) {
                // 失败条目 prog==0，s_curProg 初始值亦为 0：若不加排除会把失败条目当
                // 「当前绑定」保护，本会话从未成功编译时缓存突破 kMaxCachedProgs 无限
                // 增长——只保护真实绑定中的程序
                // 迭代趟程序同样要保护（两个 program 同属一条目，
                // 只判 prog 会让"当前绑的是迭代趟程序"的条目被删 → 删掉正在 use
                // 的 program）
                if (it->prog != 0 && it->prog == s_curProg) continue;   // 不删当前绑定（驱动脆弱，保守处理）
                if (it->progIter != 0 && it->progIter == s_curProg) continue;
                if (victim == s_progs.end() || it->lastUse < victim->lastUse) victim = it;
            }
            if (victim != s_progs.end()) {
                rfLog("rf-shader-evict", (long)victim->prog);
                if (victim->prog) glDeleteProgram(victim->prog);
                if (victim->progIter) glDeleteProgram(victim->progIter);
                s_progs.erase(victim);
            }
        }
        rfLog("rf-shader-rebuild", 0);
        s_progs.emplace_back();
        entry = &s_progs.back();
        entry->src = srcStr;
        // 一次性诊断（zzdiag-）：本次「编译」实际使用的源指纹——用于反查是哪份 .glsl
        host::diagState("zzdiag-shader", -1, host::srcHash32(srcStr.c_str(), srcStr.size()),
                        static_cast<int>(srcStr.size()), nullptr, 0, 0);

        // —— 主趟（mainImage）——
        std::string errMain;
        rfLog("rf-shader-vs", 0);
        entry->prog = buildPass(/*iteratePass=*/false, entry->uloc, errMain);
        if (!entry->prog) err = errMain;

        // —— 迭代趟 / 结算器（可选）——
        // 定义即编译：编译失败与主趟失败同待遇（进错误帧）——静默忽略会让用户
        // 以为迭代在跑、实际每帧只执行了一次，是最难诊断的一类"没效果"。
        entry->cfg = glsl::parseIterConfig(srcStr);
        entry->iterDefined = (entry->cfg.mode != glsl::IterMode::None);
        if (entry->iterDefined) {
            std::string errIter;
            entry->progIter = buildPass(/*iteratePass=*/true, entry->ulocIter, errIter);
            if (!entry->progIter) err = errIter;
        }
        // 失败占位帧每帧都要画错误文本，而 err 只在本帧非空（后续帧命中
        // prog==0 缓存不重编译）——错误文本随条目缓存
        if (!err.empty()) entry->compileError = err;
        if (errorLogCap && !err.empty())
            std::snprintf(const_cast<char*>(errorLogOut), errorLogCap, "%s", err.c_str());
    }
    entry->lastUse = ++s_useClock;
    // program 切换：仅目标 != 当前绑定时才 use（多实例交替渲染的正常切换路径；
    // 同 id 重复 use 是实证过的驱动崩溃路径，必须避开）。
    // 一趟一次切换——迭代趟与主趟是两个 program，本帧可能连续切
    // 两次（迭代趟 → 主趟），与多实例交替渲染走同一条已被实证的路径。
    auto useProgram = [&](GLuint p) {
        if (p && s_curProg != p) {
            rfLog("rf-shader-switch", (long)p);
            glUseProgram(p);
            s_curProg = p;
        }
    };
    // [临时诊断] 渲染侧 program 取证：program id / 本帧是否新建 / uniform 数 / 源码长度
    {
        char d[320];
        std::snprintf(d, sizeof(d), "diag-prog prog=%u iter=%u rebuilt=%d unis=%u srclen=%u",
                      static_cast<unsigned>(entry->prog), static_cast<unsigned>(entry->progIter),
                      progRebuilt ? 1 : 0,
                      static_cast<unsigned>(uniforms ? uniforms->size() : 0),
                      static_cast<unsigned>(srcStr.size()));
        rfDiag(d);
    }

    // —— 失败占位帧统一出口（品红底 + 错误文本，GDI 光栅化）——
    // 两条路共用：① shader 编译失败/入口缺失；② 结算状态纹理分配失败（显存/上下文
    // 资源不足）。写一份还原码——早退路径漏还原是"串帧/花屏"的经典来源，两处各写
    // 一份必然漂移。调用者负责 return；必须返回 PF_Err_NONE（输出已写入有效占位画面，
    // 返回错误码会让 AE 丢弃输出显示"渲染失败"黑帧）。
    // 还原范围 = 函数尾那套（FBO / viewport / 解包对齐 / 单元 0-8 绑定 / VAO），
    // 故从任何位置早退都安全（未改动过的状态按原值重设）。
    auto emitErrorFrame = [&](const std::string& textUtf8) {
        // 光栅化缓存：失败帧每帧渲染，GDI 对象创建 + DrawText 不能进热路径。
        // 单条目 (W,H,text)——常态下同时渲染的失败 shader 只有一个
        //（多个交替渲染时未命中方每帧重光栅化，失败路径可接受）。
        static A_long s_efW = 0, s_efH = 0;
        static std::string s_efText;
        static std::vector<float> s_efPix;
        if (s_efW != W || s_efH != H || s_efText != textUtf8) {
            rfLog("rf-ef-raster", 0);   // 阶段名供崩溃取证（GDI 光栅化是可疑崩溃点之一）
            s_efPix = rasterizeErrorFrame(W, H, textUtf8);
            s_efW = W;
            s_efH = H;
            s_efText = textUtf8;
        }
        std::vector<float>& back = s_frameBack;
        back.resize((size_t)W * H * 4);
        if (s_efPix.size() == back.size()) {
            std::memcpy(back.data(), s_efPix.data(), s_efPix.size() * sizeof(float));
        } else {
            // 光栅化退化（尺寸非法等）：纯品红填充（旧占位语义兜底）
            for (size_t i = 0; i < back.size(); i += 4) {
                back[i] = 1.0f;
                back[i + 1] = 0.0f;
                back[i + 2] = 1.0f;
                back[i + 3] = 1.0f;
            }
        }
        rfLog("rf-ef-write", 0);
        writeOutputWorld(output, back.data(), W, H);
        glBindFramebuffer(GL_FRAMEBUFFER, (GLuint)prevFbo);  // 还原进入时 FBO 绑定（勿硬编码 0 改写 AE 自身绑定）
        glViewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
        glPixelStorei(GL_UNPACK_ALIGNMENT, prevUnpackAlign);
        for (int u = 0; u < kTexUnitsTracked; ++u) {
            glActiveTexture(GL_TEXTURE0 + u);
            glBindTexture(GL_TEXTURE_2D, (GLuint)prevTexBinding2D[u]);
        }
        glActiveTexture((GLenum)prevActiveTexture);
        glBindTexture(GL_TEXTURE_2D, (GLuint)prevTexBindingEntry);
        glBindVertexArray((GLuint)prevVao);
    };

    // 任一趟不可用即走错误占位帧——迭代趟编译失败**不静默降级**为"每帧只跑一次"
    //（那会让用户以为迭代在跑、实际没有，是最难诊断的一类"没效果"）。
    if (!entry->prog || (entry->iterDefined && !entry->progIter)) {
        // 无可用 shader：把编译错误直接画在占位帧上——纯品红清屏 + glReadPixels，
        // 错误详情只在 error.log，用户在合成窗口看到品红却不知道原因，视觉 LLM 调
        // getPreviewFrame 也只拿到无信息量的纯色帧；画上去则人即刻可见、模型可直读
        //（error.log 全量文本照写，文本通道更精确）。
        // 失败条目（含缓存命中）每帧走本路径重新生成占位画面，
        // 多实例下不会从共享 FBO 读到其他实例的残影串帧。
        rfLog("rf-noprog-raster", 0);
        emitErrorFrame(entry->compileError);
        rfLog("rf-noprog-done", 0);
        return PF_Err_NONE;
    }

    // —— 上传纹理（32bit 输入用 RGBA32F，其余 RGBA16F 保留精度）——
    // needInputTex=false（无入口读输入图层）时整段跳过：不建纹理也不上传——1080p
    // 16bit 下这一跳省的是 31.6MB 的上行 + 上一段的整帧转换。glActiveTexture(单元 0)
    // 也随之跳过，故不能依赖本段清残留绑定：单元 0 的绑定由函数尾部的状态还原收口。
    if (needInputTex) {
    rfLog("rf-tex", 0);
    // 显式切到纹理单元 0：iChannel0 的 glUniform1i 指向单元 0，绑定必须与其一致。
    // 借用 AE 上下文时 active unit 可能非 0（AE 侧遗留），不显式设置会把 s_tex
    // 绑到其他单元而采样单元 0 → 黑帧/花屏。
    glActiveTexture(GL_TEXTURE0);
    if (!s_tex) {
        rfLog("rf-tex-gen", 0);
        glGenTextures(1, &s_tex);
        rfLog("rf-tex-bind-new", 0);
        glBindTexture(GL_TEXTURE_2D, s_tex);
        rfLog("rf-tex-param-new", 0);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    }
    rfLog("rf-tex-bind", 0);
    glBindTexture(GL_TEXTURE_2D, s_tex);
    rfLog("rf-tex-pixelstore", 0);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    // 尺寸或深度变化时才重分配纹理存储，避免每帧 glTexImage2D 造成的 GPU 显存抖动
    //（s_texW/s_texH 声明已上移到句柄处：代际回收判据在清零点用它们做身份验证；
    //  代际清零同步在那里完成，此处不再重复）
    const GLenum texInternalFmt = (inDepth == PixelDepth::Bits32) ? GL_RGBA32F : GL_RGBA16F;
    if (s_texW != W || s_texH != H || s_texDepth != inDepth) {
        rfLog("rf-tex-image2d", 0);
        if (!glTexStorage2dOk(texInternalFmt, W, H)) {
            // 输入纹理分配失败（显存/上下文资源不足）：shader 采 iChannel0 会拿到未定义
            // 内容。明确报错占位帧（失败策略）；尺寸统计不更新，下帧重试。
            rfLog("rf-tex-fail", 0);
            char imsg[512];
            std::snprintf(imsg, sizeof(imsg), Tr(S_EFFECTHOST_RENDERER_ERROR_INPUT_TEX),
                (int)W, (int)H);
            if (errorLogCap) std::snprintf(const_cast<char*>(errorLogOut), errorLogCap, "%s", imsg);
            emitErrorFrame(imsg);
            return PF_Err_NONE;
        }
        rfLog("rf-tex-image2d-ok", 0);
        s_texW = W; s_texH = H; s_texDepth = inDepth;
    }
    rfLog("rf-tex-subimage", 0);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, W, H, GL_RGBA, GL_FLOAT, rgba.data());
    rfLog("rf-tex-subimage-ok", 0);
    }   // if (needInputTex)
    perf.markUp();

    // —— 映射图层纹理（iChannel1/2/3，纹理单元 1..3）——
    // 仅对**两趟中任一** link 后 location >= 0（shader 声明且未被优化剔除）的 channel
    // 绑纹理；两趟都未声明的 channel 不绑（sampler 未激活，绑定无关紧要）。
    // 声明但无数据（用户选 <none> → checkout data==NULL）→ 绑共享 1×1 黑透明
    // 纹理兜底（避免采样未绑定纹理的 UB，shader 采到 (0,0,0,0)）。
    // 每 channel 独立纹理对象 + 尺寸/深度缓存：尺寸/深度不变不重分配；内容
    // 每帧上传（动画 map 正确；静止 map 的上传节流属二期）。
    static struct MapTexState {
        GLuint tex = 0;
        A_long w = 0, h = 0;
        PixelDepth depth = PixelDepth::Bits8;
    } s_mapTex[host::kIdxMapChannels];
    static MapTexState s_histTex[glsl::kMaxHistory];   // I2a 输入历史（单元 5..8）
    static GLuint s_blackTex = 0;          // 共享 1×1 黑透明兜底纹理
    // 兜底黑纹按需创建：不能只在**映射图层**的"声明了但无数据"
    // 分支里创建，而输入历史分支也依赖它（无数据 / 检出失败时绑黑）——那里写的是"黑纹已存在
    // 才绑"的条件分支。于是本进程若从未有过"声明了映射图层但用户选 <none>"的帧，s_blackTex
    // 恒为 0，历史分支什么也不绑，单元 5..8 保留本帧开始时的 AE 残留绑定（契约承诺的
    // "无纹理可绑 → 全透明黑"不成立，画面随工程/随帧变化且无告警）。
    // 两处共用同一份按需创建，别再各写一份。
    // 上下文重建后映射/历史/兜底黑纹理的名字全部作废。名字与尺寸/位深记忆
    // 一并清零——只清名字的话"尺寸未变"会跳过 glTexImage2D 重分配，新名字仍是
    // 空存储（映射层/历史读到未定义内容）。
    // 清零前逐张判**真删回收**（假阳性抖动；身份 = glIsTexture + level0 尺寸
    // vs 各条目记录的分配尺寸），不通过只置 0（TDR 安全路径）。黑纹按 1×1 身份验证。
    if (glCtxChanged) {
        for (auto& st : s_mapTex) {
            if (glCtxCacheReclaimOk(prevSeenGlCtxGen, glTextureIdentityOk(st.tex, st.w, st.h)))
                glDeleteTextures(1, &st.tex);
            st.tex = 0; st.w = 0; st.h = 0; st.depth = PixelDepth::Bits8;
        }
        for (auto& st : s_histTex) {
            if (glCtxCacheReclaimOk(prevSeenGlCtxGen, glTextureIdentityOk(st.tex, st.w, st.h)))
                glDeleteTextures(1, &st.tex);
            st.tex = 0; st.w = 0; st.h = 0; st.depth = PixelDepth::Bits8;
        }
        if (glCtxCacheReclaimOk(prevSeenGlCtxGen, glTextureIdentityOk(s_blackTex, 1, 1)))
            glDeleteTextures(1, &s_blackTex);
        s_blackTex = 0;
    }
    auto ensureBlackTex = [&]() {
        if (!s_blackTex) {
            glGenTextures(1, &s_blackTex);
            glBindTexture(GL_TEXTURE_2D, s_blackTex);
            const float black[4] = {0.0f, 0.0f, 0.0f, 0.0f};
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA, GL_FLOAT, black);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        } else {
            glBindTexture(GL_TEXTURE_2D, s_blackTex);
        }
    };
    // 像素转换暂存复用 rgba（= s_frameRgba）：iChannel0 像素在上方已上传 GL（needInputTex 时），
    // 不另留 CPU 副本——避免大尺寸 map 层（8K ≈268MB）额外一份峰值内存
    //（renderFrame 内大额分配可能 bad_alloc）。各 channel 顺序
    // 复用互不覆盖（每个 channel 转换后立即上传再处理下一个）。
    for (int ci = 0; ci < host::kIdxMapChannels; ++ci) {
        // 两趟取或：只声明在主趟、或只声明在迭代趟，都得绑（与下方 iHistory 循环同款）。
        // 只判主趟 uloc 时，"iterateImage 采 iChannel1 而 mainImage 直接透出 iPrev" 这种
        // 契约推荐的写法（契约「映射图层」节 + 迭代趟节的典型形态）会整条跳过绑定，
        // 单元 1..3 留着本帧开始时的 AE 残留绑定 → 迭代趟读到既不是所选图层、也不是
        // 兜底透明黑的东西，且全链无告警。
        if (entry->uloc.iChannelN[ci] < 0 && entry->ulocIter.iChannelN[ci] < 0) continue;   // 两趟都未声明：不绑纹理
        const PF_LayerDef* mld = (mapLayers && mapLayers[ci]) ? mapLayers[ci] : nullptr;
        glActiveTexture(GL_TEXTURE1 + ci);
        if (mld && mld->data && mld->width > 0 && mld->height > 0) {
            MapTexState& st = s_mapTex[ci];
            if (!st.tex) {
                rfLog("rf-map-tex-gen", ci);
                glGenTextures(1, &st.tex);
                glBindTexture(GL_TEXTURE_2D, st.tex);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            }
            glBindTexture(GL_TEXTURE_2D, st.tex);
            // 像素转换复用 iChannel0 逻辑（顶行 ARGB → 底行 RGBA float，8/16/32bit；
            // 归一化 uv 各采各的，map 层与输入分辨率不同也天然对齐）
            convertWorldToRgba(mld, rgba);
            const PixelDepth mdepth = detectDepth(mld->rowbytes, mld->width);
            const GLenum mfmt = (mdepth == PixelDepth::Bits32) ? GL_RGBA32F : GL_RGBA16F;
            if (st.w != mld->width || st.h != mld->height || st.depth != mdepth) {
                rfLog("rf-map-tex-image2d", ci);
                glTexImage2D(GL_TEXTURE_2D, 0, mfmt, mld->width, mld->height, 0,
                             GL_RGBA, GL_FLOAT, nullptr);
                st.w = mld->width; st.h = mld->height; st.depth = mdepth;
            }
            glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, mld->width, mld->height,
                            GL_RGBA, GL_FLOAT, rgba.data());
        } else {
            rfLog("rf-map-black", ci);
            ensureBlackTex();   // 声明了但无数据（<none> / checkout 失败）→ 绑共享黑透明
        }
    }
    rfLog("rf-map-tex-done", 0);
    // —— I2a 输入历史纹理（iHistory0..3，纹理单元 5..8）——
    // 与映射图层同款纪律：只对 link 后 location >= 0 的 channel 绑；无数据绑共享
    // 黑纹理兜底（避免采样未绑定纹理的 UB）。每帧重传（历史内容逐帧变化）。
    for (int hi = 0; hi < glsl::kMaxHistory; ++hi) {
        if (entry->uloc.iHistoryN[hi] < 0 && entry->ulocIter.iHistoryN[hi] < 0) continue;
        const PF_LayerDef* hld = (historyLayers && hi < historyCount) ? historyLayers[hi] : nullptr;
        glActiveTexture(GL_TEXTURE5 + hi);
        if (hld && hld->data && hld->width > 0 && hld->height > 0) {
            MapTexState& hst = s_histTex[hi];
            if (!hst.tex) {
                rfLog("rf-hist-tex-gen", hi);
                glGenTextures(1, &hst.tex);
                glBindTexture(GL_TEXTURE_2D, hst.tex);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            }
            glBindTexture(GL_TEXTURE_2D, hst.tex);
            convertWorldToRgba(hld, rgba);
            const PixelDepth hdepth = detectDepth(hld->rowbytes, hld->width);
            const GLenum hfmt = (hdepth == PixelDepth::Bits32) ? GL_RGBA32F : GL_RGBA16F;
            if (hst.w != hld->width || hst.h != hld->height || hst.depth != hdepth) {
                glTexImage2D(GL_TEXTURE_2D, 0, hfmt, hld->width, hld->height, 0,
                             GL_RGBA, GL_FLOAT, nullptr);
                hst.w = hld->width; hst.h = hld->height; hst.depth = hdepth;
            }
            glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, hld->width, hld->height,
                            GL_RGBA, GL_FLOAT, rgba.data());
        } else {
            rfLog("rf-hist-black", hi);
            ensureBlackTex();   // 无数据（未声明 @history / 检出失败）→ 绑共享黑透明
        }
    }
    rfLog("rf-hist-tex-done", 0);
    perf.markMap();

    // —— quad 缓冲 ——
    rfLog("rf-vao", 0);
    if (!s_vao) {
        rfLog("rf-vao-gen", 0);
        glGenVertexArrays(1, &s_vao);
        rfLog("rf-vao-bind-new", 0);
        glBindVertexArray(s_vao);
        rfLog("rf-vbo-gen", 0);
        glGenBuffers(1, &s_vbo);
        rfLog("rf-vbo-bind", 0);
        glBindBuffer(GL_ARRAY_BUFFER, s_vbo);
        const float verts[] = { -1, -1, 1, -1, -1, 1, 1, 1 };
        rfLog("rf-vbo-data", 0);
        glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_STATIC_DRAW);
        rfLog("rf-vao-enable", 0);
        glEnableVertexAttribArray(0);
        rfLog("rf-vao-ptr", 0);
        glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, nullptr);
    }
    rfLog("rf-uniform", 0);

    // —— 公共 uniform 设置（迭代趟与主趟共用同一实现）——
    // 全部使用 link 后批量查询的缓存 location，零 GL 查询。
    // 注意：本函数**不调用 glUseProgram** —— 调用方负责在设置前 use 目标 program
    //（link 阶段已 use 且不 unbind；实测：纹理/VAO 操作后再次 glUseProgram(同一 id)
    //  会让 GPU 驱动崩溃 0xC0000005 偏移 0x98xx，故 useProgram() 只在真正换趟
    //  （program id 不同）时调用）。
    // 共用 lambda：迭代趟与主趟的内置 uniform 集合完全相同
    //（iChannel0-3 / uTime / uResolution / uLayerSize / uAspect / 相机 / 灯光 /
    //  用户槽位），两份拷贝必然漂移——本仓库反复踩过"两侧不同步"的坑。
    // 每趟独立的内置（iPrev / uIter / uIterCount）不在本函数内，由调用点在每次
    // draw 前单独设置（见下方迭代循环与主趟绘制段）。
    // 诊断：验证 current program 和 current context
    {
        GLint curProg = 0;
        glGetIntegerv(GL_CURRENT_PROGRAM, &curProg);
        rfLog("rf-cur-prog", (long)curProg);
        rfLog("rf-cur-ctx", (long)(intptr_t)wglGetCurrentContext());
        rfLog("rf-cur-dc", (long)(intptr_t)wglGetCurrentDC());
    }
    // —— 用户槽位 uniform 上传（独立 lambda，vals 参数化）——
    // 槽位 uniforms[i] ↔ 分量0 参数 kIdxSlots+4i；每槽占 4 float（vec4 满，vec3 前 3，
    // vec2 前 2，float 第 1）：Float→1f / Vec2→2f / Vec3→3f / Vec4→4f（颜色 RGBA）。
    // 严禁在此直接访问 params[...]：SmartRender 回调中 params 数组不可靠，会访问违规崩溃。
    // 参数化的动机：@live 追赶段按中间帧时刻覆写 live 槽位后需逐帧重传
    //（见 Solver 追赶循环），applyCommonUniforms 仍是默认上传点。
    auto uploadUserSlots = [&](const UniformLocations& L, const float* vals) {
        if (uniforms && !L.userSlots.empty()) {
            const size_t n = (std::min)(uniforms->size(), L.userSlots.size());
            for (size_t i = 0; i < n; ++i) {
                if ((int)i >= host::kMaxParams) break;
                GLint loc = L.userSlots[i];
                if (loc < 0) continue;
                const float* v = vals ? &vals[i * host::kFloatsPerSlot] : nullptr;
                float f0 = v ? v[0] : 0.0f;
                float f1 = v ? v[1] : 0.0f;
                float f2 = v ? v[2] : 0.0f;
                float f3 = v ? v[3] : 0.0f;
                switch ((*uniforms)[i].type) {
                case glsl::ParamType::Float: glUniform1f(loc, f0); break;
                case glsl::ParamType::Vec2:  glUniform2f(loc, f0, f1); break;
                case glsl::ParamType::Vec3:  glUniform3f(loc, f0, f1, f2); break;
                case glsl::ParamType::Vec4:  glUniform4f(loc, f0, f1, f2, f3); break;
                }
            }
        }
    };

    auto applyCommonUniforms = [&](const UniformLocations& L) {
        if (L.iChannel0 >= 0) {
            rfLog("rf-u-iChannel0", (long)L.iChannel0);
            glUniform1i(L.iChannel0, 0);
        }
        // 映射图层：iChannelN → 纹理单元 N+1（与上方绑定循环一致）
        for (int ci = 0; ci < host::kIdxMapChannels; ++ci) {
            if (L.iChannelN[ci] >= 0) {
                rfLog("rf-u-iChannelN", ci * 1000 + (long)L.iChannelN[ci]);
                glUniform1i(L.iChannelN[ci], ci + 1);
            }
        }
        // I2a 输入历史：iHistoryN → 纹理单元 5+N（与上方绑定循环一致）
        // （本循环须平铺在上面的 iChannelN 循环体外：否则每趟白跑
        //   3 遍——正确性无损但热路径多余 16 次 glUniform1i/帧。与绑定循环一样平铺。）
        for (int hi = 0; hi < glsl::kMaxHistory; ++hi) {
            if (L.iHistoryN[hi] >= 0) glUniform1i(L.iHistoryN[hi], 5 + hi);
        }
        if (L.uTime >= 0) {
            // 防除零：time_scale 可能为 0（某些 AE 状态下），NaN/Inf 传给 GL 驱动会崩溃
            float timeScale = (float)in_data->time_scale;
            float t = (timeScale != 0.0f) ? (float)in_data->current_time / timeScale : 0.0f;
            if (!std::isfinite(t)) t = 0.0f;  // 双重保险：NaN/Inf → 0
            rfLog("rf-u-uTime", (long)L.uTime);
            rfLog("rf-u-uTime-val", *(long*)&t);
            glUniform1f(L.uTime, t);
        }
        if (L.uResolution >= 0) {
            rfLog("rf-u-uRes", (long)L.uResolution);
            glUniform2f(L.uResolution, (float)W, (float)H);
        }
        // 全分辨率尺寸：取自 in_data（源图层的完整分辨率），**不是** W/H（W/H = src->width
        // 是下采样后的尺寸）。这是本 uniform 的全部意义——提供与预览分辨率无关的尺寸基准。
        // in_data 为 null 时（极端兜底）退化为 0，shader 侧应据此走 fallback 分支。
        if (L.uLayerSize >= 0) {
            const float lw = in_data ? (float)in_data->width : 0.0f;
            const float lh = in_data ? (float)in_data->height : 0.0f;
            glUniform2f(L.uLayerSize, lw, lh);
        }
        if (L.uAspect >= 0) {
            rfLog("rf-u-uAspect", (long)L.uAspect);
            glUniform1f(L.uAspect, (float)W / (float)H);
        }
        // —— L2 相机感知：矩阵已是列主序（aeCamera matrixToColumnMajor），GL_FALSE 直传 ——
        // cam 为空（旧调用方）时用单位阵兜底，与「无相机」语义一致。
        if (L.uHasCam >= 0) {
            glUniform1f(L.uHasCam, cam ? cam->hasCam : 0.0f);
        }
        if (L.uCamFov >= 0) {
            glUniform1f(L.uCamFov, cam ? cam->camFov : 1.0f);
        }
        if (L.uCamPos >= 0) {
            glUniform3f(L.uCamPos,
                        cam ? cam->camPos[0] : 0.0f,
                        cam ? cam->camPos[1] : 0.0f,
                        cam ? cam->camPos[2] : 0.0f);
        }
        if (L.uCamMatrix >= 0) {
            static const float kIdentity[16] = {1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};
            glUniformMatrix4fv(L.uCamMatrix, 1, GL_FALSE,
                               cam ? cam->camMatrix : kIdentity);
        }
        if (L.uWorldMatrix >= 0) {
            static const float kIdentityW[16] = {1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};
            glUniformMatrix4fv(L.uWorldMatrix, 1, GL_FALSE,
                               cam ? cam->worldMatrix : kIdentityW);
        }

        // —— L3 灯光感知 ——
        // lights 为空（复选框关闭 / 旧调用方）时注入全零 + count=0，与「无灯合成」同语义
        // （shader 的 `if (i >= n) break;` 循环立即空转，不读任何数组元素）。
        // 数组一律按 kMaxLights 全长连续写入：地址连续由「首元素位置 + 首元素下标动态
        // 访问」保证（见 aeLights.h 的数组访问约定）；未被 shader 使用的整个数组
        // location = -1，整块跳过。
        if (L.uHasLights >= 0) {
            glUniform1f(L.uHasLights, lights ? lights->hasLights : 0.0f);
        }
        if (L.uLightCount >= 0) {
            glUniform1f(L.uLightCount, lights ? lights->count : 0.0f);
        }
        {
            static const float kZeroF[kMaxLights] = {};
            static const float kZeroV3[kMaxLights * 3] = {};
            static const float kZeroV4[kMaxLights * 4] = {};
            if (L.uLightType >= 0) {
                glUniform1fv(L.uLightType, kMaxLights, lights ? lights->type : kZeroF);
            }
            if (L.uLightPos >= 0) {
                glUniform3fv(L.uLightPos, kMaxLights, lights ? lights->pos : kZeroV3);
            }
            if (L.uLightDir >= 0) {
                glUniform3fv(L.uLightDir, kMaxLights, lights ? lights->dir : kZeroV3);
            }
            if (L.uLightColor >= 0) {
                glUniform3fv(L.uLightColor, kMaxLights, lights ? lights->color : kZeroV3);
            }
            if (L.uLightParams >= 0) {
                glUniform4fv(L.uLightParams, kMaxLights, lights ? lights->params : kZeroV4);
            }
        }

        // —— 用户槽位 uniform（实现见外层 uploadUserSlots，此处默认值上传）——
        uploadUserSlots(L, userValues);
    };

    // —— 渲染：迭代趟（Stateless）/ 结算器（Solver）+ 主趟 ——
    // 两种模式共用同一入口 iterateImage 与同一份 shader 正文，差别只在"状态活多久"：
    //   Stateless（@iterations）：每帧重置，第 0 趟读输入图层——结果是 time 的纯函数，
    //     对渲染顺序完全免疫（跳帧/倒放/区间渲染全对）。
    //   Solver（@solve N / @solveHz N）：按实例持久 + 逐帧缓存——顺序播放每帧只走当帧
    //     子步数，回拖命中缓存，只有缓存窗口之外的帧才从 0 重解（见 SolverState 注释）。
    //     @solveHz：每秒 N 子步——每帧实际子步数按合成帧率
    //     推导（见下方 substepsAt），任何帧率下解算速度恒为 N 步/秒；@solve 的"每帧
    //     N 步"在高帧率合成里解算更快，这是两者的唯一差别。
    int iterCount = 0;
    // 帧时长（秒）：time_step/time_scale。uTime 同款防零（time_scale 异常状态下按
    // 25fps 兜底——25 是工程惯用合成帧率，预览侧假定帧率同此，见 shaderPreviewRenderer）。
    const double frameDur =
        (in_data->time_step != 0 && in_data->time_scale != 0)
            ? (double)in_data->time_step / (double)in_data->time_scale : (1.0 / 25.0);
    // @solveHz 下帧 f 的子步数：floor(Hz·(f+1)·帧时长) − floor(Hz·f·帧时长)。
    // 取整累积而非逐帧取整：跨帧取整误差不累积、且是帧号的纯函数——乱序渲染/回拖/
    // 渲染队列任何顺序下同一帧拿到的子步数恒相同（确定性不变）。Hz < 帧率时会出现
    // 0 子步帧（状态原样延续），每帧上限 kMaxSolveSteps 与 @solve 同顶。
    const auto substepsAt = [&](int f) -> int {
        return host::solverSubstepsAt(entry->cfg.solveHz, frameDur, f, glsl::kMaxSolveSteps);
    };
    // 当前合成帧号（Stateless 下恒 0——它没有跨帧概念；主趟的 uFrame 也用它）
    int curFrame = 0;
    // 主趟 iPrev 的绑定源；无迭代时兜底 = 输入图层（语义与"iPrev 即当前画面"一致）
    GLuint iterResultTex = s_tex;
    // live 降级追赶的显示专用纹理：缓存回滚后主趟仍要采样末帧，主趟绘制完即删
    //（声明在模式分支外——主趟在分支之后）
    GLuint liveDisplayTex = 0;
    // 单趟/单子步绘制（两模式共用）：读 srcTex、写 dstTex。
    // uStep 在两种模式下都是"绝对步号"：Stateless = 本帧趟号（每帧归零），
    // Solver = 自结算开始累计的步号（跨帧不归零）——故 `if (uStep < 0.5) 播种`
    // 在两种模式下都写对，同一份 shader 正文可两用。
    auto drawStep = [&](const UniformLocations& L, GLuint srcTex, GLuint dstTex,
                        A_long vw, A_long vh, float uIterV, float uStepV, float uFrameV) {
        glBindFramebuffer(GL_FRAMEBUFFER, s_fbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, dstTex, 0);
        glViewport(0, 0, vw, vh);
        if (L.iPrev >= 0) {
            glActiveTexture(GL_TEXTURE4);
            glBindTexture(GL_TEXTURE_2D, srcTex);
            // 采样器单元**必须每步都设**：sampler uniform 是 program 的状态，不是
            // 纹理状态（迭代趟与主趟是两个 program，各自的 iPrev 各自设）。
            // 漏设迭代趟那句 glUniform1i 的后果：
            // 迭代程序的 iPrev 于是回落到默认单元 0，而那一轮渲染里单元 0 已被
            // 分配 ping-pong 纹理的 glBindTexture 顶掉（见 Unit0TexScope）→ 每步
            // 都读到空纹理，"读上一趟输出"静默变成"读黑"，示例在 AE 里整帧全黑
            //（aerender 实测：读空时 R/G/B 恒 0，读上一趟输出为扩散团块）。
            glUniform1i(L.iPrev, 4);
        }
        if (L.uIter >= 0) glUniform1f(L.uIter, uIterV);
        if (L.uStep >= 0) glUniform1f(L.uStep, uStepV);
        if (L.uFrame >= 0) glUniform1f(L.uFrame, uFrameV);
        glBindVertexArray(s_vao);
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    };
    if (entry->cfg.mode == glsl::IterMode::Stateless) {
        iterCount = entry->cfg.stepsPerFrame;
        if (!ensureIterTextures(W, H, inDepth)) {
            // 暂存纹理分配失败（显存/上下文资源不足）：照旧往下跑只会把子步画进空句柄，
            // 产出一张无意义的画面且没人知道为什么。明确报错占位帧（失败策略）。
            const char* itMsg = Tr(S_EFFECTHOST_RENDERER_ERROR_ITER_TEX);
            rfLog("rf-iter-tex-fail", 0);
            if (errorLogCap) std::snprintf(const_cast<char*>(errorLogOut), errorLogCap, "%s", itMsg);
            emitErrorFrame(itMsg);
            return PF_Err_NONE;
        }
        rfLog("rf-iter-begin", iterCount);
        useProgram(entry->progIter);
        applyCommonUniforms(entry->ulocIter);
        if (entry->ulocIter.uIterCount >= 0)
            glUniform1f(entry->ulocIter.uIterCount, (float)iterCount);
        // uDt = 帧时长均分到每趟（物理积分的 shader 拿它做 dt，速率与合成帧率解耦）
        if (entry->ulocIter.uDt >= 0)
            glUniform1f(entry->ulocIter.uDt, (float)(frameDur / (double)iterCount));
        // 第 0 趟读输入图层纹理（s_tex）；其后在两张迭代纹理间轮换。
        // dstTex 只在 s_iterTex[0]/[1] 之间交替——**绝不可写 s_tex**：
        // 它是 iChannel0 的源，被所有趟读取，写它等于毁掉输入。
        GLuint srcTex = s_tex;
        GLuint dstTex = s_iterTex[0];
        for (int it = 0; it < iterCount; ++it) {
            drawStep(entry->ulocIter, srcTex, dstTex, W, H, (float)it, (float)it, 0.0f);
            srcTex = dstTex;
            dstTex = (dstTex == s_iterTex[0]) ? s_iterTex[1] : s_iterTex[0];
        }
        iterResultTex = srcTex;   // 末趟输出
        rfLog("rf-iter-done", iterCount);
    } else if (entry->cfg.mode == glsl::IterMode::Solver) {
        // @solveHz 下 iterCount = 请求帧的子步数（每帧不同，循环内逐帧用 substepsAt）；
        // 主趟的 uIter/uIterCount/uStep 也取这个"请求帧口径"（见主趟段）。
        const bool hzMode = entry->cfg.solveHz > 0;
        // 帧号：current_time / time_step（同一单位，AE 保证整除）
        const int frame = (in_data->time_step != 0)
                        ? (int)(in_data->current_time / in_data->time_step) : 0;
        curFrame = frame;
        iterCount = hzMode ? substepsAt(frame) : entry->cfg.stepsPerFrame;
        // 仿真网格：与渲染分辨率**解耦**（预览降采样不重置结算），按 @solveRes 取长边
        const int dim = (entry->cfg.simDim > 0) ? entry->cfg.simDim : kSolveResDefault;
        A_long simW = dim, simH = dim;
        {
            const A_long lw = in_data->width > 0 ? in_data->width : W;
            const A_long lh = in_data->height > 0 ? in_data->height : H;
            if (lw >= lh) { simW = dim; simH = (std::max)((A_long)1, dim * lh / lw); }
            else          { simH = dim; simW = (std::max)((A_long)1, dim * lw / lh); }
        }
        if (!ensureSolveScratch(simW, simH, inDepth)) {
            // 暂存纹理分配失败（显存/上下文资源不足）：子步的暂存目标不存在 → 明确报错。
            char sMsg[512];
            std::snprintf(sMsg, sizeof(sMsg), Tr(S_EFFECTHOST_RENDERER_ERROR_SOLVE_SCRATCH),
                (int)simW, (int)simH, (int)dim);
            if (errorLogCap) std::snprintf(const_cast<char*>(errorLogOut), errorLogCap, "%s", sMsg);
            emitErrorFrame(sMsg);
            return PF_Err_NONE;
        }
        // 播种步的零状态纹理（保证 iPrev 在结算每一步都是网格尺寸，见其定义处注释）
        const bool zeroOk = ensureSolveZeroTex(simW, simH, inDepth);
        if (!zeroOk) {
            // 分配失败（显存/上下文资源不足）。**不再退回"把输入图层/黑贴图当状态"**：
            // 那会让播种步拿到错误尺寸的 iPrev——即"种子全挤到
            // 角落"（不报错、不黑屏，伪装成物理 bug）。改为明确报错占位帧：用户即刻
            // 可见、视觉模型能从占位帧读出原因，error.log 同步记录。
            rfLog("solve-zero-fail", 0);
            char msg[512];
            std::snprintf(msg, sizeof(msg), Tr(S_EFFECTHOST_RENDERER_ERROR_SOLVE_ZERO_TEX),
                (int)simW, (int)simH, (int)dim);
            if (errorLogCap) std::snprintf(const_cast<char*>(errorLogOut), errorLogCap, "%s", msg);
            emitErrorFrame(msg);
            return PF_Err_NONE;
        }
        useProgram(entry->progIter);
        applyCommonUniforms(entry->ulocIter);
        // @solveHz：uIterCount 逐帧在循环内上传（每帧子步数随帧率推导而变）；
        // uDt = 1/Hz（子步等长，帧只决定装几步）。@solve：uDt = 帧时长均分。
        if (!hzMode && entry->ulocIter.uIterCount >= 0)
            glUniform1f(entry->ulocIter.uIterCount, (float)iterCount);
        if (entry->ulocIter.uDt >= 0)
            glUniform1f(entry->ulocIter.uDt, hzMode
                        ? (float)(1.0 / (double)entry->cfg.solveHz)
                        : (float)(frameDur / (double)iterCount));
        // 子步跑在**仿真网格**上，故 uResolution 必须改成网格尺寸——否则 shader 里
        // `1.0 / uResolution` 取到的是渲染尺寸的像素步长，邻域采样间距全错
        //（网格 256 而渲染 1920 时，步长小了 7.5 倍，扩散/邻域项等于没生效）。
        // uLayerSize 保持不变：它是世界空间锚点，与仿真网格无关。
        if (entry->ulocIter.uResolution >= 0)
            glUniform2f(entry->ulocIter.uResolution, (float)simW, (float)simH);
        if (entry->ulocIter.uAspect >= 0)
            glUniform1f(entry->ulocIter.uAspect, (float)simW / (float)(std::max)((A_long)1, simH));

        // —— 参数时变判定（自动判定"驱动参数"）——
        // AEGP 会话：预取本实例各参数流并判定时变（关键帧/表达式）。拿到则并入本实例的
        // 掩码载体，更新策略见 solverMaskPolicy.h：
        // 判定为时变 → 置位；判定**成功且为静态** → 清位（删光关键帧后回落静态 → 指纹
        // 标记字节 0x02→0x01 → 谱系键变 → 重解一次；此后静态值进指纹，改值即重解）；
        // 判定失败/不可得 → 沿用上次（sticky，防 AEGP 间歇失败让指纹振荡、谱系键漂移）。
        // 会话在追赶段复用（按中间帧时刻取时变槽位当帧值）。载体按 effect_ref 键控
        //（不能进谱系/按图层共享，见 SolverMaskCarrier 注释），实例销毁
        //（SEQUENCE_SETDOWN）由 forgetInstanceMaskCarrier 清理、超上限按最旧裁剪。
        // 映射图层声明位（parseSamplerChannels，bit ci = iChannel(ci+1)）
        // 随会话传入——只对已声明通道查输入图层身份（未声明的值不影响结算）。
        const uint8_t mapDeclared = glsl::parseSamplerChannels(srcStr, nullptr);
        uint32_t maskNow = 0;
        uint32_t staticNow = 0;
        ParamValueSession* psess = host::acquireParamSession(in_data, uniforms, mapDeclared, &maskNow, &staticNow);
        uint32_t varyMask = 0;
        // 载体里当前生效的通道身份快照（锁内取，供下方谱系键构造；见载体注释）
        uint8_t chanKnownNow = 0;
        uint64_t chanLayerNow[host::kIdxMapChannels] = {0, 0, 0};
        {
            CSLock maskLk(s_maskCS);   // 专用锁：SETDOWN 清理不经 s_solverCS（见 s_maskCS 注释）
            SolverMaskCarrier& carrier = s_maskCarriers[in_data->effect_ref];
            if (psess) carrier.mask = host::updateVaryingMaskSticky(carrier.mask, maskNow, staticNow);
            // 通道身份：只在成功捕获时覆写（失败沿用上次，粘滞理由见载体注释）。
            // 用户改选图层 → 下一次成功查询覆写 → 键变 → 正常重解。
            for (int ci = 0; ci < host::kIdxMapChannels; ++ci) {
                uint64_t lid = 0;
                if (host::paramSessionChannelLayerId(psess, ci, &lid)) {
                    carrier.chanLayerId[ci] = lid;
                    carrier.chanKnown |= static_cast<uint8_t>(1u << ci);
                }
            }
            varyMask = carrier.mask;
            chanKnownNow = carrier.chanKnown;
            for (int ci = 0; ci < host::kIdxMapChannels; ++ci)
                chanLayerNow[ci] = carrier.chanLayerId[ci];
            carrier.touch = ++s_maskTouch;
            // 裁剪：载体只承载掩码 + 3 个图层 ID，常态是个位数；防御性上限挡"长时间
            // 会话反复加删效果"的地址堆积（按最旧裁，与谱系 LRU 同款策略）
            if (s_maskCarriers.size() > 256) {
                auto oldest = s_maskCarriers.begin();
                for (auto it = s_maskCarriers.begin(); it != s_maskCarriers.end(); ++it)
                    if (it->second.touch < oldest->second.touch) oldest = it;
                if (oldest->first != in_data->effect_ref) s_maskCarriers.erase(oldest);
            }
        }
        // —— 谱系键（输入身份入指纹）——
        // 图层身份拿不到（AEGP 缺席/失败）→ 降级 effect_ref（per-instance，现状
        // 行为）。首个渲染帧打一条模式日志（rfLog 有节流预算，逐帧打会淹掉其它阶段）。
        uint64_t layerKey = 0;
        const bool idOk = solverLayerKey(in_data, &layerKey);
        static bool s_solverKeyModeLogged = false;
        if (!s_solverKeyModeLogged) {
            rfLog("solve-key-mode", idOk ? 0 : 1);
            s_solverKeyModeLogged = true;
        }
        if (!idOk) layerKey = kSolverLayerFallbackFlag | (uint64_t)(uintptr_t)in_data->effect_ref;
        // —— iChannel0..3 输入身份（顺序 = 数组下标，混入见 solverParamHash 头注释）——
        // 结论：
        //   · iChannel1/2/3 的身份在键计算前**可得**：AE 侧 checkout 在 renderFrame
        //     之前（MapLayerCheckout，plugin.cpp:1394 / smartRender.cpp:216），AEGP
        //     参数流查询就地上方会话（Render 回调窗口内合法）；身份 = 图层参数指向
        //     图层（项目属性，克隆无关）。声明位来自源码（parseSamplerChannels），
        //     与 checkout 的 channelsUsed 同源同口径。
        //   · iChannel0 = 本图层输入（效果链上游输出）。可稳定取到名的只有宿主图层
        //     身份（layerKey，与 SolverKey.layer 同值，此处冗余混入保持"按通道序号
        //     定长编码"的完整）；**上游在链中的位置**换不来可靠身份——AEGP 无
        //     effect_ref→序号 映射（EffectSuite4 只有 GetLayerEffectByIndex 正向枚举，
        //     AEGP_EffectRefH 无文档化的相等比较；PF 侧 PF_LayerDef 无身份字段）。
        //     故纯 iChannel0 差异的两实例残差保留（真机复验项，不猜测语义硬改）。
        //   · 未声明通道（源码未出现）记 kChannelUnused：其参数值不影响结算，改它
        //     不该触发重解。@history/iHistory 见 solverParamHash 头注释（同一残差）。
        // 身份不可得（AEGP 缺席/时变/查询失败）记 kChannelUnknown，不用 effect_ref
        // 顶替——那会破坏克隆接力（图层身份作钥匙，克隆共享谱系）。
        ChannelInputId chanIds[1 + host::kIdxMapChannels];
        chanIds[0].kind = needInputTex ? kChannelInputLayer : kChannelUnused;
        chanIds[0].layer = layerKey;   // 输入图层身份 = 宿主图层身份（见上）
        for (int ci = 0; ci < host::kIdxMapChannels; ++ci) {
            ChannelInputId& c = chanIds[1 + ci];
            if (!((mapDeclared >> ci) & 1u)) { c.kind = kChannelUnused; continue; }
            const PF_LayerDef* mld = (mapLayers && mapLayers[ci]) ? mapLayers[ci] : nullptr;
            const bool hasData = mld && mld->data && mld->width > 0 && mld->height > 0;
            if (!hasData) { c.kind = kChannelNoData; continue; }   // <none>/检出失败 → 黑常量
            if ((chanKnownNow >> ci) & 1u) {
                c.kind = kChannelMapLayer;
                c.layer = chanLayerNow[ci];   // AEGP LayerID（合成内唯一；合成维度已由 layerKey 承担）
            } else {
                c.kind = kChannelUnknown;
            }
        }
        // 诊断（每次变化打一条，允许真机日志 grep 验证身份是否取到/选层变化）：
        // kind 签名是 4 个 nibble；ch1 身份单独一条（AEGP 缺席时恒 -1）
        {
            const long kindSig = (long)chanIds[0].kind | ((long)chanIds[1].kind << 4) |
                                 ((long)chanIds[2].kind << 8) | ((long)chanIds[3].kind << 12);
            static long s_lastKindSig = -1;
            if (kindSig != s_lastKindSig) {
                rfLog("solve-chan-kind", kindSig);
                s_lastKindSig = kindSig;
            }
            const long ch1Id = (chanIds[1].kind == kChannelMapLayer)
                             ? (long)(chanIds[1].layer & 0xFFFFFFFFull) : -1;
            static long s_lastCh1Id = -2;
            if (ch1Id != s_lastCh1Id) {
                rfLog("solve-chan-id1", ch1Id);
                s_lastCh1Id = ch1Id;
            }
        }
        const SolverKey skey{layerKey, mixSolverGen(
            solverParamHash(srcStr, uniforms, userValues, simW, simH, inDepth, varyMask,
                            in_data->time_step, in_data->time_scale,
                            instanceInstanceId,
                            chanIds, 1 + host::kIdxMapChannels),
            solveGeneration)};
        CSLock slk(s_solverCS);
        // 谱系帧缓存的自清在 renderFrame 入口的**代际消费点之后**完成
        //（见 glCtxChanged 处的注释）。此处不再保留副本：代际标志是进程级 static，
        // 本实例能走到这里时它必已被某个实例消费并在入口清空，重复清是死代码；
        // 而旧位置正是漏洞本身（别的实例先消费代际、或本实例在这之前早退 → 漏清）。
        // 谱系查找/建系：指纹含谱系的一切（源码/网格/位深/静态值/时变标记/重算代数）
        // → 指纹变自然落进另一条谱系（旧谱系由全局 LRU 过期），不存在"原地重置"。
        // 克隆实例（AE 拖时间线时成批出现）落在同一条谱系上，互相接力而不是各从
        // 0 重解——per-instance 键控会导致连环 solve-reset。
        auto lit = s_solverLineages.find(skey);
        const bool newLineage = (lit == s_solverLineages.end());
        if (newLineage) {
            lit = s_solverLineages.emplace(skey, SolverState{}).first;
            lit->second.simW = simW; lit->second.simH = simH; lit->second.depth = inDepth;
            rfLog("solve-lineage-new", frame);
            perf.miss++;
        }
        SolverState& st = lit->second;
        st.lastTouch = ++s_solverTouch;
        const int lastFrame = st.firstFrame + (int)st.frames.size() - 1;
        if (!st.frames.empty() && frame >= st.firstFrame && frame <= lastFrame) {
            // 缓存命中（回拖/重复渲染该帧）：O(1)，不重算
            iterResultTex = st.frames[frame - st.firstFrame];
            rfLog("solve-hit", frame);
            perf.hit++;
        } else {
            int fromFrame;
            if (!st.frames.empty() && frame > lastFrame) {
                fromFrame = lastFrame + 1;          // 向前推进：只走缺的那些帧
            } else {
                // 目标帧落在缓存窗口之前（或被内存上限淘汰了）：从第 0 帧重解。
                // 这是唯一会"重头迭代"的路径，且只影响被淘汰的那一段。
                freeSolverFrames(st);
                st.firstFrame = 0;
                fromFrame = 0;
                rfLog("solve-rewind", frame);
                perf.rew++;
            }
            SolveProgressGuard progGuard(frame - fromFrame + 1);   // 进度条：本次要走的帧数
            // —— 时变参数（驱动参数）的追赶取值 ——
            // 顺序播放逐帧请求时各帧自带当帧参数值（AE 已按请求时刻求值），无需这里
            // 介入；**追赶**（frame > fromFrame，含冷启动多帧/淘汰后重解）要连解多帧，
            // 中间帧的时变槽位值经 AEGP 按各帧时刻取（aeParams.cpp）。取不到时本段
            // 照算（供显示）但**不入缓存**——顺序重放会逐帧请求、以各自精确值重解，
            // 近似不会被烘焙进缓存。全静态（varyMask == 0）时追赶本就精确，照常入缓存。
            const bool liveCatchUp = varyMask != 0 && frame > fromFrame;
            bool liveExact = true;                 // 本次追赶是否逐帧精确（决定入不入缓存）
            std::vector<float> liveVals;           // 请求帧值的可写副本（时变槽位逐帧覆写）
            size_t pushedThisPass = 0;             // 本段新增帧数（live 降级回滚计数；evict 删队首不影响尾部计数）
            if (liveCatchUp) {
                if (!psess) {
                    liveExact = false;             // AEGP 缺席：近似显示 + 不缓存
                    rfLog("solve-live-degrade", 1);
                } else {
                    liveVals.assign(userValues,
                                    userValues + uniforms->size() * host::kFloatsPerSlot);
                }
            }
            for (int f = fromFrame; f <= frame; ++f) {
                InterlockedExchange(&s_progFrame, static_cast<LONG>(f));
                // 时变追赶：中间帧按该帧时刻覆写时变槽位并重传；请求帧（f == frame）
                // 恢复请求值上传——上一中间帧的覆写不能残留
                if (liveCatchUp && psess) {
                    if (f < frame) {
                        if (!host::paramValueAtFrame(psess, in_data, f, varyMask, liveVals.data())) {
                            liveExact = false;
                            rfLog("solve-live-frame-fail", f);
                        }
                        uploadUserSlots(entry->ulocIter, liveVals.data());
                    } else {
                        uploadUserSlots(entry->ulocIter, userValues);
                    }
                }
                // 本帧的输入：结算的第 0 子步（播种）读**网格尺寸的零状态**——不是输入
                // 图层。输入图层按渲染尺寸分配（1920×1080 对 64×36 网格），绑它会让
                // shader 里 textureSize(iPrev) 在播种步返回错的尺寸（见 ensureSolveZeroTex
                // 的实测事故注释）；要读输入用 iChannel0。其后各步读上一帧的缓存纹理。
                // 零状态纹理分配失败已在进入循环前早退（不会走到这里拿到空句柄）。
                GLuint prevTex = st.frames.empty() ? s_solveZeroTex : st.frames.back();
                // 缓存纹理**先建**、并直接作为末子步的绘制目标——省掉"先写 scratch
                // 再整张 blit 进缓存"的那次全网格拷贝（每帧一次
                // 全网格 blit + 一次额外 FBO 挂载）。先建还有一个附带好处：分配失败
                // 时不白算子步。
                GLuint cached = newSolverTex(simW, simH, inDepth);
                if (!cached) {
                    // 分配失败（显存/上下文资源不足）：与零状态纹理同款——明确报错，
                    // 不用上一帧残影或黑贴图糊过去（那会把"资源不足"伪装成"效果不对"）。
                    rfLog("solve-tex-fail", f);
                    char msg[512];
                    std::snprintf(msg, sizeof(msg), Tr(S_EFFECTHOST_RENDERER_ERROR_SOLVE_FRAME_TEX),
                        f, (int)simW, (int)simH);
                    if (errorLogCap) std::snprintf(const_cast<char*>(errorLogOut), errorLogCap, "%s", msg);
                    if (psess) { host::releaseParamSession(psess); psess = nullptr; }
                    emitErrorFrame(msg);
                    return PF_Err_NONE;
                }
                // 本帧子步数：@solve 恒 N；@solveHz 按帧率推导（Hz < 帧率时可为 0）
                const int stepsF = hzMode ? substepsAt(f) : iterCount;
                if (hzMode && entry->ulocIter.uIterCount >= 0)
                    glUniform1f(entry->ulocIter.uIterCount, (float)stepsF);
                if (hzMode && stepsF == 0) {
                    // 0 子步帧：状态原样延续——上一状态 blit 进本帧缓存纹理（该帧仍占
                    // 一个缓存槽，uStep 不推进）。读/写各绑一张 FBO（同绑定下 blit 的
                    // 行为未定义）；prevTex 此时必为仿真纹理（第 0 帧被 substepsAt 钳到
                    // ≥1 子步，播种先于任何 0 子步帧发生）。
                    ensureSolveBlitFbos();
                    if (!s_solveBlitFbo[0] || !s_solveBlitFbo[1]) {
                        // blit FBO 建不出来（显存/上下文资源不足）：没有"状态原样延续"的手段。
                        // **不能照旧往下走**——句柄 0 = 默认帧缓冲，glFramebufferTexture2D 会报错、
                        // blit 不做有效拷贝，而未写入的 cached 会被推进缓存谱系（静默污染状态）。
                        rfLog("solve-blit-fail", f);
                        glDeleteTextures(1, &cached);
                        const char* blitMsg = Tr(S_EFFECTHOST_RENDERER_ERROR_SOLVE_BLIT);
                        if (errorLogCap) std::snprintf(const_cast<char*>(errorLogOut), errorLogCap, "%s", blitMsg);
                        if (psess) { host::releaseParamSession(psess); psess = nullptr; }
                        emitErrorFrame(blitMsg);
                        return PF_Err_NONE;
                    }
                    glBindFramebuffer(GL_READ_FRAMEBUFFER, s_solveBlitFbo[0]);
                    glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                                           GL_TEXTURE_2D, prevTex, 0);
                    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, s_solveBlitFbo[1]);
                    glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                                           GL_TEXTURE_2D, cached, 0);
                    glBlitFramebuffer(0, 0, simW, simH, 0, 0, simW, simH,
                                      GL_COLOR_BUFFER_BIT, GL_NEAREST);
                    glBindFramebuffer(GL_FRAMEBUFFER, s_fbo);   // 还给 drawStep 的常态
                    st.frames.push_back(cached);
                    ++pushedThisPass;
                    evictSolverFramesToBudget(st);
                    InterlockedExchange(&s_progDone, static_cast<LONG>(f - fromFrame + 1));
                    continue;
                }
                if (stepsF <= 0) {
                    // 不可达（parseSolveSteps 把 @solve N 钳到 [1, kMaxSolveSteps]，
                    // @solveHz 的 0 子步帧已在上方分支处理）——真出现就是声明异常，
                    // 明确报错，而不是静默把上一帧的样子当成这一帧。
                    rfLog("solve-bad-steps", stepsF);
                    glDeleteTextures(1, &cached);
                    const char* badMsg = Tr(S_EFFECTHOST_RENDERER_ERROR_SOLVE_STEPS);
                    if (errorLogCap) std::snprintf(const_cast<char*>(errorLogOut), errorLogCap, "%s", badMsg);
                    if (psess) { host::releaseParamSession(psess); psess = nullptr; }
                    emitErrorFrame(badMsg);
                    return PF_Err_NONE;
                }
                // uStep 基址（绝对步号）：@solve = 帧号×每帧子步数；@solveHz = 该帧前
                // 累计子步数 = floor(Hz×f×帧时长)——两条路都是帧号的纯函数，乱序/回拖
                // 任意顺序下同一帧的步号恒相同。**播种步的钳制也计入基址**（Hz < 帧率时
                // 基址会落 0 与播种哨兵 uStep<0.5 撞车，实测让整条谱系少跑一步），
                // 详见 solverSchedule.h 的 solverStepBase 注释。
                const long long stepBase = host::solverStepBase(
                    hzMode, entry->cfg.solveHz, frameDur, f, iterCount);
                GLuint srcT = prevTex;
                for (int k = 0; k < stepsF; ++k) {
                    // 目标纹理由纯函数给出（solverSchedule.h）：末子步写进缓存纹理、
                    // 其余在 scratch[0]/[1] 轮换，相邻步不撞同一张（单测守着这个不变式）
                    const SolverTarget tgt = solverStepTarget(k, stepsF);
                    GLuint dstT = (tgt == SolverTarget::Cache)
                                      ? cached
                                      : ((tgt == SolverTarget::Scratch0) ? s_solveScratch[0]
                                                                        : s_solveScratch[1]);
                    // uStep = 绝对步号 = 本帧基址 + 帧内子步号
                    drawStep(entry->ulocIter, srcT, dstT, simW, simH,
                             (float)k, (float)(stepBase + k), (float)f);
                    srcT = dstT;
                }
                st.frames.push_back(cached);
                ++pushedThisPass;   // live 降级回滚的计数锚点（evict 可能同时删队首，按尾部计）
                evictSolverFramesToBudget(st);
                InterlockedExchange(&s_progDone, static_cast<LONG>(f - fromFrame + 1));
            }
            // 推进完一轮再触发全局 LRU（谱系数是旧参数谱系的量级，逐帧触发不划算；
            // 新谱系起步一两帧就超全局预算的情形不存在——全局 1GiB ≫ 单谱系 512MB）
            evictLineagesToGlobalBudget(skey);
            if (!liveExact && pushedThisPass > 0) {
                // 追赶近似（AEGP 缺席/中途取值失败）：本段只供显示，不入缓存——
                // 回滚本段新增帧；末帧纹理移交 liveDisplayTex 供主趟采样（主趟后删）。
                // 顺序重放时逐帧请求自带精确值，会以 O(1)/帧 精确重建这段缓存。
                liveDisplayTex = st.frames.back();
                for (size_t r = 0; r < pushedThisPass && !st.frames.empty(); ++r) {
                    const GLuint t = st.frames.back();
                    st.frames.pop_back();
                    if (t != liveDisplayTex) glDeleteTextures(1, &t);
                }
                iterResultTex = liveDisplayTex;
                rfLog("solve-live-uncached", (long)pushedThisPass);
            } else if (!st.frames.empty()) {
                const int lf = st.firstFrame + (int)st.frames.size() - 1;
                iterResultTex = st.frames[(frame >= st.firstFrame && frame <= lf)
                                          ? frame - st.firstFrame : (int)st.frames.size() - 1];
            }
            rfLog("solve-advance", frame);
        }
        // 会话释放（缓存命中/推进两路汇合处——acquire 在分支之前，两路都必须走到这）
        if (psess) { host::releaseParamSession(psess); psess = nullptr; }
    }

    // 分段计时：iter 段到此为止（= 公共 uniform 绑定 + 帧内迭代/结算整段）
    perf.mode = (int)entry->cfg.mode;
    perf.markIter();

    // —— 主趟 ——
    // 契约要求 mainImage 必须存在（迭代趟是可选的附加入口），故主趟必然执行；
    // 上方早退分支已保证 entry->prog != 0。
    // 有迭代趟时主趟的 iPrev = 末趟结果（后处理/调色/直接透出都走它）；
    // 无迭代趟时 iPrev = 输入图层。
    // uIter 在主趟取 iterCount（= 趟数，即"最后一趟的下一个"）——shader 可据此
    // 判断"我是收尾趟"；无迭代趟时为 0。
    useProgram(entry->prog);
    applyCommonUniforms(entry->uloc);
    glBindFramebuffer(GL_FRAMEBUFFER, s_fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, s_rtTex, 0);
    rfLog("rf-viewport", 0);
    glViewport(0, 0, W, H);
    if (entry->uloc.iPrev >= 0) {
        glActiveTexture(GL_TEXTURE4);
        glBindTexture(GL_TEXTURE_2D, iterResultTex);
        glUniform1i(entry->uloc.iPrev, 4);
    }
    if (entry->uloc.uIter >= 0)
        glUniform1f(entry->uloc.uIter, (float)iterCount);
    if (entry->uloc.uIterCount >= 0)
        glUniform1f(entry->uloc.uIterCount, (float)iterCount);
    // 主趟的 uStep = "最后一步的下一个"（Stateless = 趟数；Solver@solve = 本帧末子步+1；
    // Solver@solveHz = 该帧累计子步数）——与"主趟 uIter 取趟数本身"同一约定，shader
    // 可据此判断"我是收尾趟"。
    // @solveHz 分支不能手写 floor(Hz×(帧+1)×帧时长)：会漏掉子步基址里
    // 对"第 0 帧被钳到 1 子步的播种步"的 +1 补偿（见 solverSchedule.h 的 solverStepBase）：
    // Hz < 合成帧率时该式在帧 0/1/2 恒为 0（@solveHz 8 / 25fps 手算：帧 3 才到 1）——主趟
    // uStep 恒等于"刚执行完的那个子步号"、永不推进；而面板预览的 _solveStep 计"实际执行
    // 步"（含播种），同帧已比宿主大 1（shaderPreviewRenderer.js:_solveStep→主趟 uStep）。
    // 子步自身的 uStep 一直是 solverStepBase(帧)+帧内序号（上方循环），主趟若手写公式则与
    // 自己的子步不是同一条账。改为直接复用 solverStepBase 取**下一帧的基址** = 已执行
    // 子步的累计数（solverStepBase(f) = f 之前执行过的步数 ⇒ f+1 的基址即"最后一步的
    // 下一个"），不再在 renderer 里手写第二份公式。Hz ≥ 帧率（未触发播种钳制）时该式
    // 退化为原式 floor(Hz×(帧+1)×帧时长)，逐值不变。
    // 已知残留（不在本次修法覆盖内）：Hz > 64×帧率触到 kMaxSolveSteps 硬顶时，本式
    // 与子步基址仍走未截断的 Hz 时钟，而预览按 64/帧累计——两侧步号在触顶段仍有差；
    // 修它要改 solverStepBase/solverSubstepsAt 的步号语义（子步 uStep、播种判据共用），
    // 属独立改动项。
    if (entry->uloc.uStep >= 0) {
        long long mainStep = iterCount;
        if (entry->cfg.mode == glsl::IterMode::Solver) {
            mainStep = (entry->cfg.solveHz > 0)
                ? host::solverStepBase(true, entry->cfg.solveHz, frameDur, curFrame + 1, iterCount)
                : (long long)curFrame * iterCount + iterCount;
        }
        glUniform1f(entry->uloc.uStep, (float)mainStep);
    }
    // 主趟 uDt 与迭代趟同值（收尾趟若继续积分，dt 仍是同一子步长；无迭代趟不注入）
    if (entry->uloc.uDt >= 0 && entry->cfg.mode != glsl::IterMode::None) {
        const double dt = (entry->cfg.solveHz > 0)
            ? 1.0 / (double)entry->cfg.solveHz
            : frameDur / (double)(std::max)(1, iterCount);
        glUniform1f(entry->uloc.uDt, (float)dt);
    }
    if (entry->uloc.uFrame >= 0) glUniform1f(entry->uloc.uFrame, (float)curFrame);
    rfLog("rf-bind-vao-draw", 0);
    glBindVertexArray(s_vao);
    rfLog("rf-draw-arrays", 0);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    perf.markMain();
    rfLog("rf-draw-ok", 0);

    // live 降级追赶的显示专用纹理用毕即删（主趟采样已完成；不删则降级期间每次
    // 追赶泄漏一张网格纹理，直到实例销毁才随缓存清空）
    if (liveDisplayTex) {
        glDeleteTextures(1, &liveDisplayTex);
        liveDisplayTex = 0;
    }

    // —— PBO 异步读回（glGetBufferSubData 内部隐式同步，无需显式 glFinish）——
    // 8bit 输出可以直取：让驱动按 BGRA8 读回（传输 33MB→8.3MB、CPU 零转换），
    // 其余位深保持浮点读回（逐位不变）。判据取自 output 的实际位深。
    const PixelDepth outDepth = detectDepth(output->rowbytes, output->width);
    const bool fast8 = (outDepth == PixelDepth::Bits8) &&
                       (std::getenv("AS_EFFECT_HOST_NO_U8") == nullptr);   // 逃生门：置位即回浮点路径
    rfLog("rf-pbo", 0);
    const size_t kPboSize8    = (size_t)W * H * 4;                  // BGRA8：8bit 直取
    const size_t kPboSizeFull = (size_t)W * H * 4 * sizeof(float);  // RGBA32F：浮点读回
    if (!s_pbo) {
        rfLog("rf-pbo-gen", 0);
        glGenBuffers(1, &s_pbo);
    }
    rfLog("rf-pbo-bind", 0);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, s_pbo);
    // PBO 存储**只增不减**（单调放大）——这是条结构性不变式：任何一次读回要写的字节数
    // 都不会超过已分配量，于是"PBO 比这次读回小"这种状态根本不可能存在。
    // 若按当次路径算尺寸并双向重分配：8bit 直取失败回落浮点读回时
    // 仍按 1/4 的 8bit 尺寸发 glReadPixels → 驱动写 4 倍字节（越界、内容未定义，严重
    // 时崩驱动），glGetBufferSubData 也仅拷回 1/4 帧（花屏）。单调放大即可消除整类。
    static size_t s_pboSize = 0;
    // 上下文重建后 PBO 的存储随之消失，"已分配字节数"记忆必须归零，否则
    // ensurePboCapacity 认为容量够而跳过 glBufferData，读回写进无存储的缓冲（花屏）
    if (glCtxChanged) s_pboSize = 0;
    auto ensurePboCapacity = [](size_t need) {
        if (s_pboSize >= need) return;
        rfLog("rf-pbo-data-grow", 0);
        glBufferData(GL_PIXEL_PACK_BUFFER, need, nullptr, GL_STREAM_READ);
        s_pboSize = need;
    };
    ensurePboCapacity(fast8 ? kPboSize8 : kPboSizeFull);
    bool u8Done = false;
    // —— 8bit 直取 ——
    // 字节序：GL_BGRA + GL_UNSIGNED_INT_8_8_8_8 在小端机上落成内存序 A R G B，
    // 与 AE 的 PF_Pixel 布局逐字节相同（AE/QuickTime 系惯用组合）。
    // 取舍：硬件浮点→unorm8 是"就近舍入"，原 clamp8 是 trunc(v*255+0.5)（半格向上）；
    // 两者只在 v*255 恰为 x.5 的值上差 1 个色阶。发生率实测（两路径同帧逐字节对账，
    // 结算器示例 90 帧 × 207 万像素）：7.46 亿字节里差 9,040 个 = 0.0012%，最大差 1 阶，
    // 即平均每帧约 25 个像素、单个通道差 1 级——肉眼不可辨，但不是逐位相同。
    if (fast8) {
        std::vector<unsigned char>& rb8 = s_frameBytes8;   // 直取读回缓冲（复用，避免每帧分配）
        while (glGetError() != GL_NO_ERROR) {}
        glReadPixels(0, 0, W, H, GL_BGRA, GL_UNSIGNED_INT_8_8_8_8, nullptr);
        if (glGetError() == GL_NO_ERROR) {
            rb8.resize((size_t)W * H * 4);
            glGetBufferSubData(GL_PIXEL_PACK_BUFFER, 0, kPboSize8, rb8.data());
            if (glGetError() == GL_NO_ERROR) {
                copyBgra8ToWorld8(output->data, (int32_t)output->rowbytes,
                                  (int32_t)output->width, (int32_t)output->height,
                                  rb8.data(), (int32_t)W, (int32_t)H);
                rfLog("rf-u8-direct", 0);
                {
                    const A_long cx = W / 2, cy = H / 2;
                    const unsigned char* px = reinterpret_cast<const unsigned char*>(output->data) +
                        (size_t)cy * output->rowbytes + (size_t)cx * 4;
                    rfLog("rf-wb8", ((long)px[1]) * 65536 + ((long)px[2]) * 256 + (long)px[3]);
                }
                u8Done = true;
            }
        }
        if (!u8Done) rfLog("rf-u8-fallback", 0);   // 读回格式不被支持等 → 回落浮点路径

    }
    // —— 浮点路径（16/32bit 输出，或 8bit 直取失败）——
    if (!u8Done) {
        // 8bit 直取失败时 PBO 可能只按 kPboSize8 分配过——这里必须先确保容量够浮点读回
        // （ensurePboCapacity 只增不减，天生存不下"比读回小"的状态）。
        ensurePboCapacity(kPboSizeFull);
        rfLog("rf-pbo-readpix", 0);
        glReadPixels(0, 0, W, H, GL_RGBA, GL_FLOAT, nullptr);
        rfLog("rf-pbo-readpix-ok", 0);
        // 拷回普通内存再逐像素转换：**不要** map 之后直接读。
        // glMapBufferRange 交回的是驱动映射区，在那里逐 float 标量读是未命中缓存的窄事务
        // ——实测 1080p 8bit 一帧的回写阶段要 ~0.87s，而同一份转换在普通内存上只要 6ms
        //（tests/test_pixel_convert.cpp 的标量参照实测），差的这 ~140 倍就是那层映射。
        // 换成 glGetBufferSubData 让驱动自己做一次拷贝，之后全部转换跑在缓存命中的内存上。
        // 它同样是同步点（等 GPU 传输完成），与 map 的同步语义一致，不引入额外等待。
        rfLog("rf-pbo-getsub", 0);
        std::vector<float>& readback = s_frameBack;
        readback.resize((size_t)W * H * 4);
        while (glGetError() != GL_NO_ERROR) {}   // 清掉进入前残留的错误标志（否则下面的判断会误报）
        glGetBufferSubData(GL_PIXEL_PACK_BUFFER, 0, kPboSizeFull, readback.data());
        // 失败兜底（旧 map 失败分支的等价物）：glGetBufferSubData 无返回值，只能查 GL 错误；
        // 出错时缓冲内容未定义 → 直接同步读回，避免把未初始化数据写进输出（花屏）。
        if (glGetError() != GL_NO_ERROR) {
            rfLog("rf-pbo-getsub-fallback", 0);
            glReadPixels(0, 0, W, H, GL_RGBA, GL_FLOAT, readback.data());
        }
        rfLog("rf-pbo-getsub-done", 0);
        {
            const float* fb = readback.data();
            rfLog("rf-pbo-write", 0);
            // 诊断：多点采样（中心/左上/右下）RGBA，每通道 ×32768 编码（1.0=32768，与 16bit 输出一致）
            {
                const float* fv = fb;
                int pts[3][2] = { { (int)W / 2, (int)H / 2 }, { 0, (int)H - 1 }, { (int)W - 1, 0 } };
                for (int pi = 0; pi < 3; ++pi) {
                    int px = pts[pi][0], py = pts[pi][1];
                    const float* pv = fv + ((size_t)py * W + px) * 4;
                    rfLog(pi == 0 ? "rf-smp-c" : (pi == 1 ? "rf-smp-tl" : "rf-smp-br"),
                          (long)(pv[0] * 32768.0f) * 65536 + (long)(pv[1] * 32768.0f));
                    rfLog(pi == 0 ? "rf-smp-c2" : (pi == 1 ? "rf-smp-tl2" : "rf-smp-br2"),
                          (long)(pv[2] * 32768.0f));
                }
            }
            writeOutputWorld(output, fb, W, H);
            // 诊断：写回后读取 output center 像素（区分深度）
            {
                const A_long cx = W / 2, cy = H / 2;
                const PixelDepth od = detectDepth(output->rowbytes, output->width);
                if (od == PixelDepth::Bits8) {
                    const unsigned char* p = reinterpret_cast<const unsigned char*>(output->data)
                        + (size_t)cy * output->rowbytes + (size_t)cx * 4;
                    rfLog("rf-wb8", ((long)p[1]) * 65536 + ((long)p[2]) * 256 + (long)p[3]);
                } else if (od == PixelDepth::Bits16) {
                    const A_u_short* p = reinterpret_cast<const A_u_short*>(
                        reinterpret_cast<const unsigned char*>(output->data)
                        + (size_t)cy * output->rowbytes) + (size_t)cx * 4;
                    rfLog("rf-wb16", ((long)p[1]) * 65536 + (long)p[2]);
                    rfLog("rf-wb16b", (long)p[3]);
                } else {
                    const float* p = reinterpret_cast<const float*>(
                        reinterpret_cast<const unsigned char*>(output->data)
                        + (size_t)cy * output->rowbytes) + (size_t)cx * 4;
                    rfLog("rf-wb32-r", *(const long*)&p[1]);
                    rfLog("rf-wb32-g", *(const long*)&p[2]);
                    rfLog("rf-wb32-b", *(const long*)&p[3]);
                }
            }
        }
    }   // if (!u8Done)
    rfLog("rf-pbo-unbind", 0);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, (GLuint)prevPbo);   // 还原进入时 PBO 绑定（勿硬编码 0 改写 AE 自身绑定）
    // —— 还原借用的 GL 状态（program 保持 current 是刻意设计，见 link 段注释）——
    rfLog("rf-restore", 0);
    glViewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    glBindFramebuffer(GL_FRAMEBUFFER, (GLuint)prevFbo);    // 还原进入时 FBO 绑定（勿硬编码 0 改写 AE 自身绑定）
    glPixelStorei(GL_UNPACK_ALIGNMENT, prevUnpackAlign);
    // 还原本函数变更过的绑定态。映射图层占用纹理单元 0-3、迭代趟 iPrev
    // 占单元 4 → 逐一还原各单元的 TEXTURE_2D 绑定，最后回到进入时活跃单元并
    // 还原其绑定（进入单元在 0..kTexUnitsTracked-1 内时上面的循环已还原，
    // 再绑一次同值无害）
    for (int u = 0; u < kTexUnitsTracked; ++u) {
        glActiveTexture(GL_TEXTURE0 + u);
        glBindTexture(GL_TEXTURE_2D, (GLuint)prevTexBinding2D[u]);
    }
    glActiveTexture((GLenum)prevActiveTexture);
    glBindTexture(GL_TEXTURE_2D, (GLuint)prevTexBindingEntry);
    glBindVertexArray((GLuint)prevVao);
    rfLog("rf-done", 0);

    return PF_Err_NONE;
}

// 提前创建 GL 上下文（PARAMS_SETUP 主线程调用）。
// 崩溃观察：播放时首次渲染在渲染线程上创建窗口+上下文，驱动不稳定（虚拟显示/多线程）。
// 提前到主线程创建一次并复用，渲染路径只做轻量 rebind，降低播放期驱动崩溃概率。
// 必须先 acquireAeGlContext：AE 的离屏上下文是跨环境唯一稳定方案（见
// kUseAeGlContext 注释）；否则会退化到自建 WGL 并把它缓存为全局上下文，
// 此后 AE 上下文不再被使用。GLLock 析构时释放线程绑定，渲染线程可 rebind。
void ensureGlContext(PF_InData* in_data, PF_OutData* out_data) {
    GLLock glLock(g_glCS);
    acquireAeGlContext(in_data, out_data);
    GlContext& g = glCtx();
    rfLog("ensure-ctx", g.ok ? 1 : 0);
}

// 实例销毁（PF_Cmd_SEQUENCE_SETDOWN）清理该实例的掩码/通道身份载体。
// 只清 s_maskCarriers（per-instance，effect_ref 键控）——effect_ref 地址被新实例
// 复用时若不清理，新实例会继承旧实例的 sticky 时变位与输入图层身份，按旧掩码/
// 旧身份构造指纹（错误键位/多余重解）。sticky「只置位不清位」语义本身属于既有
// 既定语义不动；这里只补"载体随实例生命周期结束"。谱系帧缓存**不**随实例清理
//（键控改造，见 s_solverLineages 注释）。用 s_maskCS 而非 s_solverCS：SETDOWN
// 不得等待渲染线程的整段解算循环（见 s_maskCS 注释）。
void forgetInstanceMaskCarrier(void* effect_ref) {
    if (!effect_ref) return;
    CSLock lk(s_maskCS);
    s_maskCarriers.erase(effect_ref);
}

// —— 映射图层 checkout 守卫 ——
// checkout：仅检出 channelsUsed 声明的 channel。PF_CHECKOUT_PARAM 在
// Render/SmartRender 两条路径均可用（compound effect 取 map 层的既定机制）；
// 用户选 <none> 时 checkout 不报错但 data==NULL → layers_ 槽位保持 nullptr，
// renderer 对「声明但无数据」的单元绑黑纹理兜底。
// 析构：CHECKIN 全部已检出参数——renderFrame 抛异常（bad_alloc 被外层
// catch 吞掉）等所有退出路径均覆盖，保证句柄不泄漏。
void MapLayerCheckout::checkout(PF_InData* in_data, uint8_t channelsUsed) {
    in_data_ = in_data;
    if (!in_data) return;
    for (int i = 0; i < host::kIdxMapChannels; ++i) {
        if (!((channelsUsed >> i) & 1)) continue;   // 未声明：不 checkout（避免无谓依赖注册）
        std::memset(&defs_[i], 0, sizeof(PF_ParamDef));
        PF_Err cerr = PF_CHECKOUT_PARAM(in_data, host::kIdxLayerBase + i,
                                        in_data->current_time, in_data->time_step,
                                        in_data->time_scale, &defs_[i]);
        if (cerr != PF_Err_NONE) {
            rfLog("map-co-fail", i);
            continue;   // 检出失败：该 channel 按无数据处理（黑纹理兜底）
        }
        mask_ |= (1u << i);
        layers_[i] = (defs_[i].u.ld.data != nullptr) ? &defs_[i].u.ld : nullptr;
        rfLog("map-co-ok", i * 100 + (layers_[i] ? 1 : 0));
    }
}

MapLayerCheckout::~MapLayerCheckout() {
    if (!in_data_) return;
    for (int i = 0; i < host::kIdxMapChannels; ++i) {
        if (mask_ & (1u << i)) {
            PF_CHECKIN_PARAM(in_data_, &defs_[i]);
        }
    }
}

// —— I2a 输入历史检出（见 renderer.h）——
// 仅 legacy PF_Cmd_RENDER 路径（非 SmartFX 宿主）使用：PF_CHECKOUT_PARAM 检出
// param 0 的偏移时刻得到的是**未加工的源图层**，不含前序效果；AE 渲染走 SmartFX，
// 历史帧改由 smartPreRender 的 checkout_layer 检出（含前序效果，见
// host::kHistoryCheckoutIdBase）。本类不得在 SMART_RENDER 路径使用。
void HistoryCheckout::checkout(PF_InData* in_data, int frames) {
    in_data_ = in_data;
    if (!in_data || frames <= 0) return;
    count_ = (std::min)(frames, (int)glsl::kMaxHistory);
    for (int i = 0; i < count_; ++i) {
        std::memset(&defs_[i], 0, sizeof(PF_ParamDef));
        // 偏移 i+1 帧：iHistory0 = 前一帧
        const A_long t = in_data->current_time -
                         static_cast<A_long>(i + 1) * in_data->time_step;
        PF_Err cerr = PF_CHECKOUT_PARAM(in_data, 0, t, in_data->time_step,
                                        in_data->time_scale, &defs_[i]);
        if (cerr != PF_Err_NONE) {
            rfLog("hist-co-fail", i * 100 + (long)cerr);
            continue;   // 检出失败：该历史按无数据处理（黑纹理兜底）
        }
        mask_ |= (1u << i);
        layers_[i] = (defs_[i].u.ld.data != nullptr) ? &defs_[i].u.ld : nullptr;
        rfLog("hist-co-ok", i * 100 + (layers_[i] ? 1 : 0));
    }
}

HistoryCheckout::~HistoryCheckout() {
    if (!in_data_) return;
    for (int i = 0; i < count_; ++i) {
        if (mask_ & (1u << i)) PF_CHECKIN_PARAM(in_data_, &defs_[i]);
    }
}

SolverProgress solverProgress() {
    SolverProgress p;
    p.active = InterlockedCompareExchange(&s_progActive, 0, 0) != 0;
    p.done   = static_cast<int>(InterlockedCompareExchange(&s_progDone, 0, 0));
    p.total  = static_cast<int>(InterlockedCompareExchange(&s_progTotal, 0, 0));
    p.frame  = static_cast<int>(InterlockedCompareExchange(&s_progFrame, 0, 0));
    return p;
}
} // namespace host
