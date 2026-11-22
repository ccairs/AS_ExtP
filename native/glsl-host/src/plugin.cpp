#include "AEConfig.h"
#ifdef AE_OS_WIN
#include <windows.h>
#include <dbghelp.h>
#include <psapi.h>
#pragma comment(lib, "dbghelp.lib")
#pragma comment(lib, "psapi.lib")
#endif
#include "entry.h"
#include "AE_Effect.h"
#include "AE_EffectCB.h"
#include "AE_EffectSuites.h"
#include "AE_EffectPixelFormat.h"
#include "AE_EffectGPUSuites.h"
#include "AE_Macros.h"
#include "PrSDKAESupport.h"
#include "Param_Utils.h"
#include "AEFX_SuiteHelper.h"
#include "params.h"
#include "solverKeyIdentity.h"   // 实例 id 铸号规则（24 位、恒非零）
#include "seqIdentity.h"         // 实例身份载体（序列数据；见该文件头）
#include "effectState.h"
#include "renderer.h"
#include "aeCamera.h"
#include "smartRender.h"
#include "glslLoader.h"
#include "uniformParser.h"
#include "errorLog.h"
#include "customUI.h"
#include "paramMap.h"          // uniform→参数索引映射落盘
#include "crashForensics.h"    // 崩溃取证：故障地址→模块归属（VEH 只读纯函数）
#include "acpName.h"           // 参数名 ACP 有界拷贝（按字符边界截断，见该文件头）
#include "i18n.h"              // 用户可见文案（参数名/About，运行时按宿主语言取）
#include "AE_EffectUI.h"
#include <algorithm>
#include <atomic>
#include <cstring>
#include <cstdio>
#include <cwchar>
#include <map>
#include <new>
#include <string>

// AE 在 Windows 上以系统代码页(CP_ACP/GBK)解释 PF_ParamDef.name，
// 源码以 /utf-8 编译故字面量为 UTF-8，需转换后再传给 AE。
// error.log 等供 Web 面板读取的字符串仍保持 UTF-8，不经过此函数。
static std::string utf8ToAcp(const char* utf8) {
    if (!utf8 || !*utf8) return {};
    // 动态缓冲（两段式查询长度）——固定 128 wchar 在超长文本（如
    // 深层 effects 目录路径拼进 ABOUT）下 MultiByteToWideChar 返回 0 触发
    // 截断回退：整段 UTF-8 字节原样返回，AE 按 ACP 解释即乱码。先查询所需
    // 长度再精确分配，任意长度完整转换；长度不含尾零（显式传长度，输出无
    // 内嵌 NUL，与 std::string 构造语义一致）。
    const int wn = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
    if (wn <= 1) return utf8;
    std::wstring wide(static_cast<size_t>(wn - 1), L'\0');
    if (MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &wide[0], wn) <= 0) return utf8;
    const int an = WideCharToMultiByte(CP_ACP, 0, wide.c_str(), static_cast<int>(wide.size()),
                                       nullptr, 0, nullptr, nullptr);
    if (an <= 0) return utf8;
    std::string acp(static_cast<size_t>(an), '\0');
    if (WideCharToMultiByte(CP_ACP, 0, wide.c_str(), static_cast<int>(wide.size()),
                            &acp[0], an, nullptr, nullptr) <= 0) return utf8;
    return acp;
}

// —— 参数名文案：当前语言在 ACP 下不可表示时回退 en-US ——
// AE 以 CP_ACP 解释参数名，代码页表达不了的字符会变成 '?'（如中文 Windows 上的谚文）。
// 参数名优先保证可读：当前语言整串可表示则用当前语言，否则用英文文案（拉丁可表示）。
// 只用于 PF_ParamDef.name 缓冲；错误文本/对话框标题等仍走 Tr。
static const char* paramNameText(StrId id) {
    const char* text = Tr(id);
    if (host::acpRepresentable(text)) return text;
    return TrIn(i18n::kLocaleEnUS, id);
}

// 参数名 ACP 有界拷贝（含回退）：见 paramNameText / acpName.h。
static size_t copyParamNameAcp(StrId id, char* dst, size_t size) {
    return host::copyAcpBounded(paramNameText(id), dst, size);
}

// 动态「映射图层 %d」：模板按同一回退规则取，再格式化并落到 ACP 缓冲。
static size_t copyMapLayerNameAcp(int index, char* dst, size_t size) {
    char utf8[128];
    std::snprintf(utf8, sizeof(utf8), paramNameText(S_EFFECTHOST_PLUGIN_PARAM_MAP_LAYER), index);
    return host::copyAcpBounded(utf8, dst, size);
}

// 命名用分量数 slotNamedCompCount（由 uniform 类型决定）：Float=1 / Vec2=2 /
// Vec3=3 / Vec4=4。用于分量命名/注册（超出类型有效数的分量名 "—"）。注意与
// customUI.cpp 的 drawCompCount 不同——后者返回**视觉行数**
// （params.h slotUiRows：Vec2=2/Vec3=3 行，颜色名与其余类型 1 行），旧语义
// "一行内并排几个分量列"（Vec4 归 1 那版）已随"每分量独占一行"改版废除。
static int slotNamedCompCount(const glsl::Param& p) {
    switch (p.type) {
    case glsl::ParamType::Vec2: return 2;
    case glsl::ParamType::Vec3: return 3;
    case glsl::ParamType::Vec4: return 4;
    default: return 1;   // Float
    }
}

// 槽位分量名（ACP）：分量0 = 空串（显示名由画布按当前 uniform 自绘）；
// 分量1/2/3 = 名 + 语义后缀；超出该 uniform 类型有效分量数的分量（未用分量）名 = "—"。
//
// 后缀按语义选取：颜色语义（面板画成取色器）→ .g / .b / .a；其余向量 → .y / .z / .w。
// 「颜色语义」判定必须与 customUI.cpp kindFor 的控件选型同口径：kindFor 对 Vec4
// 恒用 Swatch（色块），Vec2/Vec3 仅在 glsl::isColorNamed 时用 Swatch；故此处
// = (type == Vec4) || glsl::isColorNamed(p.name)。
// 用途：分量名随参数定义下发，供 param-map 表达分量语义；脚本/AI 侧寻址用索引或
// matchName 槽位（隐藏参数的运行期改名不反映到脚本属性模型）。
//
// 单点维护：PARAMS_SETUP 注册与 SyncParamUI 运行时同步共用，避免两处命名发散。
static std::string slotCompNameAcp(const glsl::Param& p, int comp) {
    // comp<=0 返回 uniform 原名：当前调用方只按空名取值（分量0 的注册名恒为空串），
    // 该分支留给按原名寻址的调用方。
    if (comp <= 0) return utf8ToAcp(p.name.c_str());
    if (comp >= slotNamedCompCount(p)) return utf8ToAcp("—");
    static const char* const kColorSuffix[3] = {".g", ".b", ".a"};
    static const char* const kVectorSuffix[3] = {".y", ".z", ".w"};
    const bool colorLike = (p.type == glsl::ParamType::Vec4) || glsl::isColorNamed(p.name);
    const char* const* suf = colorLike ? kColorSuffix : kVectorSuffix;
    return utf8ToAcp((p.name + suf[comp - 1]).c_str());
}

// —— 崩溃捕获系统：SEH 向量异常处理器 + 阶段跟踪 + minidump ——
// 一次崩溃即可定位：异常代码、崩溃地址、最后执行的代码阶段、调用栈 minidump
// 非 static：renderer.cpp 的 rfLog 也写入此缓冲，崩溃日志显示精确阶段。
// 修复：改为固定缓冲 + 内容复制——logCmd 的调用点可能传入临时 std::string 的
// c_str()（evt-type/arb-fn 诊断串），保存指针随临时串析构即悬空，crashLog 崩溃
// 阶段 %s 读取悬空指针是未定义行为；strncpy_s 复制（截断保尾零）从根上消除。
thread_local char g_curStageBuf[64] = "init";
static thread_local void* g_curStagePtr = nullptr;

// 崩溃路径只用栈缓冲 + 预开句柄——VEH 可能在堆锁持有中触发（如
// malloc/free 内部访问违规），crashLog 的 fopen/fprintf/fclose（CRT
// 流 API 内部走堆）与 vectoredHandler 的 CreateFileA + std::string
// 拼路径（堆分配）都可能再取堆锁，把可记录的崩溃恶化为进程挂死。
// 改为进程启动（CrashHandlerInit，正常上下文）时预构造路径并预开句柄，
// VEH 内仅 _snprintf（纯栈格式化）+ WriteFile 内核调用。
static HANDLE g_crashLogH = INVALID_HANDLE_VALUE;  // 崩溃日志预开追加句柄（FILE_APPEND_DATA）
static HANDLE g_dumpH = INVALID_HANDLE_VALUE;      // minidump 预开句柄（OPEN_ALWAYS：启动不清掉上次 dump）
// VEH 注册句柄（GLOBAL_SETDOWN 注销用，见 EffectMain 的 setdown 分支）
static PVOID g_vehHandle = nullptr;
// 轮转段专用轻量锁——并发越闸（每 256 次写入放行一次检查，两个
// 线程可在不同计数上先后越闸）时无锁「关-删-重开」会让后到者对已关闭句柄
// 二次 CloseHandle——若期间 OS 复用该句柄值即误关无关活句柄（进程级不稳定）；
// 或把刚重开的日志再次删除。SRWLOCK 串行化整个轮转段；与 VEH 的 WriteFile
// 竞态窗口内写入失败即丢（同旧注释口径，崩溃瞬间的丢行可接受）。
static SRWLOCK g_crashLogRotateLock = SRWLOCK_INIT;

// —— 崩溃取证：线程 id + 故障地址所属模块 ——
// 已确认事实：崩溃日志的 stage 常是 init——g_curStageBuf 是 thread_local，
// 只在 logCmd/rfLog 里更新，而崩溃常发生在没进过宿主回调的线程。真机 dmp 解析
// 显示故障地址在 Adobe wrservices.dll（base+0x8FBE8），宿主不在活链上。故本项目
// 只做取证：模块名/基址/偏移足以判断"是不是我们"。
// VEH 纪律：不得堆分配、不得取锁。模块表在 CrashHandlerInit（正常
// 上下文）用 EnumProcessModulesEx/GetModuleInformation 预枚举成固定大小静态
// 数组；VEH 里只做 host::findModuleForAddress 的线性扫描。表指针用原子发布，
// 刷新时在正常上下文 new 一张新表再发布——旧表故意不释放（VEH 可能仍在读，
// 进程生命周期内至多两份），因此 VEH 永远不会看到半张表。
static constexpr int kMaxModuleRanges = 512;
struct ModuleTable {
    uint32_t count = 0;
    host::ModuleRange mods[kMaxModuleRanges];
};
static std::atomic<const ModuleTable*> g_moduleTable{nullptr};
static ModuleTable g_moduleTableBoot;   // CrashHandlerInit 的静态存储（不走堆）

// 枚举并填充 t；返回条目数。只在正常上下文调用（EnumProcessModulesEx/
// GetModuleInformation/GetModuleFileNameW 都可能触碰加载器与堆锁）。
static uint32_t buildModuleTable(ModuleTable* t) {
    if (!t) return 0;
    t->count = 0;
    HMODULE mods[kMaxModuleRanges];
    DWORD needed = 0;
    if (!EnumProcessModulesEx(GetCurrentProcess(), mods, (DWORD)sizeof(mods), &needed,
                              LIST_MODULES_ALL)) {
        return 0;
    }
    DWORD n = needed / (DWORD)sizeof(HMODULE);
    if (n > (DWORD)kMaxModuleRanges) n = (DWORD)kMaxModuleRanges;
    for (DWORD i = 0; i < n; ++i) {
        MODULEINFO mi;
        if (!GetModuleInformation(GetCurrentProcess(), mods[i], &mi, sizeof(mi))) continue;
        if (!mi.lpBaseOfDll || mi.SizeOfImage == 0) continue;
        host::ModuleRange& e = t->mods[t->count];
        e.base = reinterpret_cast<uintptr_t>(mi.lpBaseOfDll);
        e.size = static_cast<uintptr_t>(mi.SizeOfImage);
        e.nameW[0] = L'\0';
        e.nameA[0] = '\0';
        const DWORD cap = (DWORD)(sizeof(e.nameW) / sizeof(e.nameW[0]));
        // 表项只需文件名（wrservices.dll），全路径没人看且 64 wchar 装不下。
        if (GetModuleFileNameW(mods[i], e.nameW, cap) > 0) {
            e.nameW[cap - 1] = L'\0';
            const wchar_t* leaf = std::wcsrchr(e.nameW, L'\\');
            const wchar_t* base = leaf ? leaf + 1 : e.nameW;
            WideCharToMultiByte(CP_UTF8, 0, base, -1, e.nameA, (int)sizeof(e.nameA),
                                nullptr, nullptr);
            e.nameA[sizeof(e.nameA) - 1] = '\0';
        }
        ++t->count;
    }
    return t->count;
}

// 首次静态初始化：**不在这里枚举模块**——本函数在静态构造期（DllMain/加载器锁内）
// 运行，EnumProcessModulesEx 在该上下文有死锁加载器锁的风险（MS 文档明示"不要在
// DllMain 调用"），会让 AE 启动挂死。这里只发布空表：首次加效果之前发生的崩溃走
// `module=? allocBase=…` 分支（满足"至少给 AllocationBase"），真实模块表在
// GLOBAL_SETUP / PARAMS_SETUP 的正常主线程上下文刷新（见 refreshModuleTableAfterLoad）。
static void initModuleTableAtStartup() {
    g_moduleTableBoot.count = 0;
    g_moduleTable.store(&g_moduleTableBoot, std::memory_order_release);
}

// 插件加载后再刷新一次（仅一次）：CrashHandlerInit 跑在 DllMain 期，AE 的服务
// DLL（如 wrservices.dll）可能尚未加载；PARAMS_SETUP 是用户真正使用效果时的
// 主线程正常上下文，此刻模块集已稳定。失败/已刷新过即返回。
static void refreshModuleTableAfterLoad() {
    static std::atomic<bool> s_done{false};
    bool expected = false;
    if (!s_done.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) return;
    ModuleTable* t = new (std::nothrow) ModuleTable();
    if (!t) return;
    if (buildModuleTable(t) == 0) {
        delete t;   // 未发布，可安全释放
        return;
    }
    g_moduleTable.store(t, std::memory_order_release);
    // 旧表（g_moduleTableBoot）故意不释放：可能仍有线程在 VEH 里扫描它。
}

static void crashLog(const char* type, DWORD code, void* addr) {
    if (g_crashLogH == INVALID_HANDLE_VALUE) return;
    // 栈缓冲 + WriteFile（预开句柄的追加语义由内核保证），不走 CRT 流
    const uintptr_t a = reinterpret_cast<uintptr_t>(addr);
    uintptr_t off = 0;
    const ModuleTable* table = g_moduleTable.load(std::memory_order_acquire);
    const host::ModuleRange* mod = table
        ? host::findModuleForAddress(table->mods, table->count, a, &off) : nullptr;
    // 扫不到模块时至少给 AllocationBase（VirtualQuery 是内核调用，不取堆锁）：
    // 可由外部模块列表反查归属。命中时也给 allocBase，便于识别"同分配区内偏移"。
    MEMORY_BASIC_INFORMATION mbi;
    const uintptr_t allocBase =
        (VirtualQuery(addr, &mbi, sizeof(mbi)) == sizeof(mbi))
            ? reinterpret_cast<uintptr_t>(mbi.AllocationBase) : 0;
    char buf[384];
    int n;
    if (mod) {
        // 格式示例：thread=44696 module=wrservices.dll base=0x7FFB5E8D0000 off=0x8FBE8
        n = std::snprintf(buf, sizeof(buf),
            "!!! CRASH type=%s code=0x%08X addr=0x%p stage=%s thread=%lu "
            "module=%s base=0x%llX off=0x%llX\n",
            type, (unsigned)code, addr, g_curStageBuf,
            (unsigned long)GetCurrentThreadId(), mod->nameA,
            (unsigned long long)mod->base, (unsigned long long)off);
    } else {
        n = std::snprintf(buf, sizeof(buf),
            "!!! CRASH type=%s code=0x%08X addr=0x%p stage=%s thread=%lu "
            "module=? allocBase=0x%llX\n",
            type, (unsigned)code, addr, g_curStageBuf,
            (unsigned long)GetCurrentThreadId(), (unsigned long long)allocBase);
    }
    if (n <= 0 || n >= (int)sizeof(buf)) n = (n <= 0) ? 0 : (int)sizeof(buf) - 1;
    DWORD written = 0;
    WriteFile(g_crashLogH, buf, (DWORD)n, &written, nullptr);
}

static LONG WINAPI vectoredHandler(PEXCEPTION_POINTERS ep) {
    // 只捕获真正的崩溃异常（不捕获 C++ 异常 0xE06D7363）
    DWORD code = ep->ExceptionRecord->ExceptionCode;
    if (code == 0xE06D7363) return EXCEPTION_CONTINUE_SEARCH;
    // 只捕获致命异常
    if (code == 0xC0000005 ||  // 访问违规
        code == 0xC0000409 ||  // 栈缓冲溢出
        code == 0xC000001D ||  // 非法指令
        code == 0xC0000094 ||  // 除零
        code == 0xC00000FD ||  // 栈溢出
        code == 0x80000003) {  // 断点
        crashLog("SEH", code, ep->ExceptionRecord->ExceptionAddress);
        // 写 minidump：句柄已预开（VEH 内不 CreateFile），每次崩溃截断
        // 从头覆盖写（SetFilePointer/SetEndOfFile 为轻量内核调用，不取堆锁）。
        // MiniDumpWriteDump 保留是取舍：其内部（dbghelp）仍可能取堆锁/加载
        // 器锁——但调用栈定位价值高，且文本日志已先行落盘（三要素：异常
        // 代码/地址/阶段），即使 dump 阶段挂死诊断链也不断
        if (g_dumpH != INVALID_HANDLE_VALUE) {
            SetFilePointer(g_dumpH, 0, nullptr, FILE_BEGIN);
            SetEndOfFile(g_dumpH);
            MINIDUMP_EXCEPTION_INFORMATION mei;
            mei.ThreadId = GetCurrentThreadId();
            mei.ExceptionPointers = ep;
            mei.ClientPointers = FALSE;
            MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(),
                              g_dumpH, MiniDumpNormal, &mei, nullptr, nullptr);
        }
    }
    return EXCEPTION_CONTINUE_SEARCH;
}

// 自动注册向量异常处理器（全局构造）
static struct CrashHandlerInit {
    CrashHandlerInit() {
        // 预开崩溃日志/dump 句柄——VEH 内不再调用任何可能取堆锁的
        // 文件 API。日志句柄 OPEN_ALWAYS + FILE_APPEND_DATA（追加语义，与
        // rfLog/logCmd 的 fopen("a") 并存；16MB 轮转时由 host::maybeRotateDiagLog
        // 截断重写，失败才退回删-关-重开）；dump 句柄 OPEN_ALWAYS：启动不动上次
        // 崩溃的 dump，崩溃时才截断覆盖
        // 崩溃日志句柄加 FILE_SHARE_DELETE——轮转的 DeleteFileA 可
        // 在句柄仍打开时成功（文件置 delete-pending，关闭最后的句柄即物理
        // 删除），轮转不再被自身常驻句柄阻塞（失败重试窗口只剩 rfLog/logCmd
        // fopen("a") 的毫秒级瞬态，失败时句柄保持有效、256 次写入后重试，
        // 崩溃日志记录不再因一次轮转失败停摆）
        // 路径经 utf8ToWide 走 CreateFileW——diagLogFilePath 返回 UTF-8，
        // 窄 CreateFileA 在中文字符的数据根（默认 %APPDATA% 带中文用户名）下打不开，
        // 崩溃日志/dump 会静默丢失（崩溃诊断恰是最不可缺失的一环）。此处是正常
        // 初始化上下文，转宽与堆分配无 VEH 约束问题。
        const std::string logPath = host::diagLogFilePath("as_effect_host.log");
        const std::string dumpPath = host::diagLogFilePath("as_effect_host.dmp");
        const std::wstring wLogPath = glsl::utf8ToWide(logPath);
        const std::wstring wDumpPath = glsl::utf8ToWide(dumpPath);
        if (!wLogPath.empty()) {
            g_crashLogH = CreateFileW(wLogPath.c_str(), FILE_APPEND_DATA,
                                      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                      nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
            g_dumpH = CreateFileW(wDumpPath.c_str(), GENERIC_WRITE,
                                  FILE_SHARE_READ, nullptr, OPEN_ALWAYS,
                                  FILE_ATTRIBUTE_NORMAL, nullptr);
        }
        // 探针：静态初始化到达 + 句柄状态（1=logH 位，10=dumpH 位）
        host::rawTrace("init", (g_crashLogH != INVALID_HANDLE_VALUE ? 1L : 0L)
                             + (g_dumpH != INVALID_HANDLE_VALUE ? 10L : 0L));
        // 崩溃取证：预枚举模块表（正常上下文），再由 VEH 只读扫描
        initModuleTableAtStartup();
        // 保存注册句柄（GLOBAL_SETDOWN 注销 VEH 用）
        g_vehHandle = AddVectoredExceptionHandler(1, vectoredHandler);
    }
} g_crashInit;

// 阶段跟踪宏：设置当前阶段，崩溃时 vectoredHandler 会记录
#define STAGE(s) do { strncpy_s(g_curStageBuf, sizeof(g_curStageBuf), (s), _TRUNCATE); g_curStagePtr = nullptr; } while(0)

// —— 诊断日志 ——
// 高频命令（ARBITRARY_CALLBACK/EVENT，自定义 UI 下可达千次/秒）只记前 N 次，
// 防止 fopen/fprintf/fclose 的 I/O 开销本身拖垮 UI 线程（实测打开参数列表后
// ARBITRARY_CALLBACK 风暴导致严重卡顿，根因之一就是每次回调两次磁盘写）。
// 自动截断：日志纯追加不自清，播放期渲染诊断（rf-*）增长快；每 256 次写入检查
// 一次文件大小，超限时保留尾部 2MB 重写（清空会把崩溃
// 现场的最后一批证据一起丢掉，而这些日志的全部价值就是那段现场；重写实现见
// errorLog.cpp 的 rotateLogFileKeepTail，失败时退回「删-关-重开」兜底）。
static constexpr ULONGLONG kMaxLogBytes = 16ull * 1024 * 1024;  // 16MB
static constexpr ULONGLONG kKeepLogBytes = 2ull * 1024 * 1024;   // 超限后保留尾部 2MB

// as_effect_host.log 的体积检查（公开为 host::maybeRotateDiagLog）。
// 【为什么必须公开】本文件内的 static 只有 logCmd 一个调用点，而 logCmd
// 对高频命令有 300 次/进程的节流 → 叠加「每 256 次调用才查一次大小」，一个 AE
// 会话最多做 3 次检查；而真正往这个文件写字的 rfLog(预算 4000)/srLog(2000)/
// camLog(300)/GPU 信息段根本不经过这里 → 16MB 上限形同虚设（实测攒到 6.7MB/36 天）。
// 现五个写入方全部调用本函数，节流只影响「检查频率」不再决定「能否检查」。
namespace host {
void maybeRotateDiagLog() {
    // 轮转计数改原子——UI 线程与渲染线程并发 ++s_n 非原子（读-改-写撕裂）
    static LONG volatile s_n = 0;
    if ((InterlockedIncrement(&s_n) & 255) != 0) return;  // 每 256 次写检查一次
    const std::string path = host::diagLogFilePath("as_effect_host.log");
    if (path.empty()) return;
    // 必须先判超限再轮转：rotateLogFileKeepTail 的 false 同时表示「未超限」与
    // 「轮转失败」，直接拿它进兜底分支会在**未超限**时也删文件——
    // 抓到的真实缺陷（那样等于每 256 次写清空一次日志，比不轮转更糟）。
    if (!logFileExceeds(path, kMaxLogBytes)) return;
    if (!rotateLogFileKeepTail(path, kMaxLogBytes, kKeepLogBytes)) {
        // 保留尾部失败（读/重写被占用等）→ 退回旧「删-关-重开」路径，保证崩溃
        // 日志句柄在轮转后仍可写（失败时句柄保持有效，256 次写后重试）。
        // 轮转需先关预开崩溃日志句柄——delete-pending 文件无法再打开，
        // 直接 DeleteFileA 会让 rfLog/logCmd 的 fopen("a") 追加从此全部失败
        //（日志静默停摆）。先 DeleteFileA（成功 = 唯一剩余句柄是本
        // 句柄，文件置 delete-pending），再原子摘取并关闭（物理删除），最后重开；
        // InterlockedExchangePointer 原子摘取防并发读（VEH 的 crashLog）期间被
        // 重复关闭。轮转段独立轻量锁串行化。
        AcquireSRWLockExclusive(&g_crashLogRotateLock);
        // 宽路径（与 CrashHandlerInit 口径一致）——中文字符数据根下
        // DeleteFileA/CreateFileA 会静默失败，兜底轮转形同虚设
        const std::wstring wPath = glsl::utf8ToWide(path);
        if (!wPath.empty() && DeleteFileW(wPath.c_str())) {
            HANDLE hOld = reinterpret_cast<HANDLE>(InterlockedExchangePointer(
                    reinterpret_cast<PVOID volatile*>(&g_crashLogH),
                    reinterpret_cast<PVOID>(INVALID_HANDLE_VALUE)));
            if (hOld != INVALID_HANDLE_VALUE) {
                CloseHandle(hOld);
            }
            g_crashLogH = CreateFileW(wPath.c_str(), FILE_APPEND_DATA,
                                      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                      nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        }
        ReleaseSRWLockExclusive(&g_crashLogRotateLock);
    }
}
} // namespace host

static void logCmd(const char* stage, PF_Cmd cmd) {
    // 同时更新阶段跟踪（节流后依然更新，崩溃定位不受影响）。
    // 修复：复制内容到固定缓冲——stage 可能是调用方临时 std::string 的 c_str()，
    // 直接保存指针会随临时串析构悬空（见 g_curStageBuf 声明处注释）。
    strncpy_s(g_curStageBuf, sizeof(g_curStageBuf), stage, _TRUNCATE);
    // 高频命令节流：进程内每种只记 kMax 次 enter/exit。
    // 渲染类命令（RENDER/SMART_*/UPDATE_PARAMS_UI）在播放期每帧触发（ECW 打开时
    // 时间变化也会发 UPDATE_PARAMS_UI），逐帧磁盘写是 I/O 风暴——与
    // ARBITRARY_CALLBACK/EVENT 风暴同款的历史卡顿根因；
    // AS_EFFECT_HOST_LOG=1 解除全部节流（驱动问题深度诊断用）
    // 节流计数改原子——UI 线程（ARBITRARY_CALLBACK/EVENT）与渲染线程
    // （RENDER/SMART_*）并发 ++ 非原子（读-改-写撕裂），日志条目偶发丢失/超发
    static LONG volatile s_arbLogged = 0, s_evtLogged = 0, s_rdrLogged = 0;
    constexpr int kMax = 300;
    static const bool s_verbose = std::getenv("AS_EFFECT_HOST_LOG") != nullptr;
    const bool highFreq = !s_verbose &&
        (cmd == PF_Cmd_ARBITRARY_CALLBACK || cmd == PF_Cmd_EVENT ||
         cmd == PF_Cmd_RENDER || cmd == PF_Cmd_SMART_RENDER ||
         cmd == PF_Cmd_SMART_PRE_RENDER || cmd == PF_Cmd_UPDATE_PARAMS_UI);
    if (highFreq) {
        LONG volatile& n = (cmd == PF_Cmd_ARBITRARY_CALLBACK) ? s_arbLogged
                       : (cmd == PF_Cmd_EVENT) ? s_evtLogged : s_rdrLogged;
        if (InterlockedIncrement(&n) > kMax) return;
    }
    host::maybeRotateDiagLog();
    const std::string path = host::diagLogFilePath("as_effect_host.log");
    if (path.empty()) return;
    // 探针：logCmd 到达即 Win32 直写（fopen 在 AE 运行期静默失效，对照用）。
    // 按 cmd 值**去重**（同值只记首次）：每到达一次写一行时，cmd 22 不在上方
    // 高频节流集合内 —— 实测它一个命令号占据 trace 日志 56%（单个 64KB 窗口内 1200 行
    // 同一值），把真正的探针行淹没，并使 4MB 轮转窗口被垃圾撑满、历史保留时间骤降。
    // 去重保留了本探针唯一能回答的问题（"哪些命令到达过"），只丢掉同一值的纯重复。
    // 64 位位图 + InterlockedOr64：与原子计数同款纪律（UI 线程与渲染线程并发
    // 调用本函数），位图原子置位保证同一 cmd 只有一个线程能"首次见到"。
    static volatile LONG64 s_lcSeenBits = 0;
    if (cmd >= 0 && cmd < 64) {
        LONG64 bit = (LONG64)1 << cmd;
        if ((InterlockedOr64(&s_lcSeenBits, bit) & bit) == 0) {
            host::rawTrace("lc", static_cast<long>(cmd));
        }
    }
    // 追加段互斥——与 rfLog/srLog/GPU 信息段（renderer.cpp/
    // smartRender.cpp）并发写交错丢行；追加改走 Win32 直写
    //（appendDiagLogLine，内核原子），互斥退化为轮转互斥，纪律不变
    host::lockDiagAppend();
    {
        char body[128];
        std::snprintf(body, sizeof(body), "%s cmd=%d", stage, static_cast<int>(cmd));
        // 失败探针（GetLastError 去重）已下沉到 appendDiagLogLine 内
        host::appendDiagLogLine(body);
    }
    host::unlockDiagAppend();
}

// —— Render 前向声明（Task 6 替换为 GL 渲染）——
static PF_Err Render(PF_InData* in_data, PF_OutData* out_data,
                     PF_ParamDef* params[], PF_LayerDef* output);

// —— ARBITRARY DATA 回调前向声明（选择器/画布共用 v2 定长句柄；定义在 Render 之后）——
static PF_Err HandleArbitrary(PF_InData* in_data, PF_OutData* out_data, PF_ArbParamsExtra* extra);

// 透传占位：无效果文件时拷贝输入到输出（逐行，取 rowbytes 最小值防越界）
static PF_Err PassThrough(PF_ParamDef* params[], PF_LayerDef* output) {
    PF_LayerDef* src = &params[0]->u.ld;
    if (src && output && src->data && output->data) {
        A_long rows = (std::min)(src->height, output->height);
        A_long bytes = (std::min)(src->rowbytes, output->rowbytes);
        if (bytes > 0) {
            for (A_long y = 0; y < rows; ++y) {
                std::memcpy(
                    reinterpret_cast<A_u_char*>(output->data) + y * output->rowbytes,
                    reinterpret_cast<const A_u_char*>(src->data) + y * src->rowbytes,
                    bytes);
            }
        }
    }
    return PF_Err_NONE;
}

// —— 全局效果状态：见 effectState.h（host::globalState()，MFR 下多线程共享）——
// N1 修复：uniforms/源码等按文件路径缓存于 fileCache；每实例选中索引存各自的
// 尾部隐藏原生参数 kIdxFileIndexParam（见 instanceFileIndex），不再有进程级
// selectedFileIndex 镜像。

// 效果文件所在目录（error.log 写入位置，面板同目录读取）
static std::string effectsDir() {
    return host::effectsDirPath();
}

// 预加载效果文件（PARAMS_SETUP 时调用）：ECW 首次刷新（UPDATE_PARAMS_UI）
// 发生在第一次 RENDER 之前，若此时不预加载，uniform 列表为空会把所有滑块置灰。
// 结果进 per-file 缓存（fileCache），返回快照供 PARAMS_SETUP 注册槽位默认值。
static host::ShaderSnapshot loadEffectFile() {
    // 先刷新 popup 选项（扫描 effects/ 目录），再按默认选中预加载
    host::refreshPopupChoices();
    host::ShaderSnapshot snap = host::getShaderForIndex(host::kDefaultFileIndex, /*checkReload=*/true);
    logCmd("load-path", (int)snap.path.size());
    logCmd("load-src", (int)snap.source.size());
    logCmd("load-parsed", (int)snap.uniforms.size());
    // 预置默认文件的签名与参数映射：UPDATE_PARAMS_UI 已无槽位行可重建，首次同步只
    // 校准画布高度；param-map 先落盘，面板在用户还没切文件时也能按索引寻址。
    if (!snap.path.empty()) {
        host::setEntrySignature(snap.path, host::uniformSignature(snap.uniforms));
        // 默认文件的映射先落盘（面板在用户还没切文件时也能
        // 按索引寻址；PARAMS_SETUP 是主线程正常上下文）
        host::writeParamMapFile(snap.path, std::string(), host::kDefaultFileIndex,
                                snap.source, snap.uniforms);
    }
    return snap;
}

// 读取本实例当前选中文件索引 —— 实现已移到 customUI.cpp（host::InstanceFileIndex）：
// 选择器的 handle 布局（v2）与身份读写都住在那里，避免同一份解析逻辑散落两处。
// 参数缺失（理论上不应发生，参数表恒注册）回退选择器 handle 的 v[0]，再回退
// kDefaultFileIndex；越界钳制由 shaderPathForIndex 统一完成（回退第一个库文件）。
using host::InstanceFileIndex;
using host::InstanceShaderName;

// 本实例该取哪个文件的快照：**身份名优先**（库增删只改"名字→位置"的映射，实例不随
// 位置位移而换成另一个 shader），名字缺失/已删时回退位置索引。
// 与 instanceFileIndex 的分工：那个是"参数里写着的数字"，这个是"实际渲染谁"。
static host::ShaderSnapshot instanceShaderSnapshot(PF_InData* in_data, PF_ParamDef* params[],
                                                   bool forRender, int* outResolvedIdx) {
    const int idx = InstanceFileIndex(in_data, params);
    const std::string name = InstanceShaderName(in_data, params);
    return host::getShaderByIdentity(name, idx, /*checkReload=*/true, forRender, outResolvedIdx);
}

// —— 文件索引变更核对（PF_Cmd_UPDATE_PARAMS_UI 期）——
// 自绘选择器点击（customUI.cpp handleFileSelectorClick）切换文件时，除了写
// kIdxFileIndexParam，还有一件事是「让渲染更新」：显式要求 AE 使缓存失效并重渲染
// （PF_OutFlag_FORCE_RERENDER）。文件内容是 AE 看不见的外部依赖（不在任何参数里），
// 光靠参数值变化在部分场景下不足以让 AE 丢弃上一文件已缓存的帧。
// 脚本写 fx.property(kIdxFileIndexParam).setValue(N)（或表达式、工程恢复）绕过点击
// 分支：AE 侧参数值确实已变（UPDATE_PARAMS_UI 读得到 → ECW 槽位名/选择器显示都跟着
// 变），但没有任何一方要求重渲染 → 画面停留在上一文件。
// 本函数把两条路径对齐，挂在 UPDATE_PARAMS_UI。**不要**据此认为脚本改动只在这里可见：
// 挂了 PF_ParamFlag_SUPERVISE
// 的参数在脚本写入时**同样派发** PF_Cmd_USER_CHANGED_PARAM，"脚本写入不触发"
// 的记录是错的。本分支仍不可少——工程恢复、表达式求值等不派发 UCP 的变更来源只能在这里
// 兜住；且 FORCE_RERENDER 在 PF_Cmd_UPDATE_PARAMS_UI 期合法（AE_Effect.h:886 列出的
// 三个合法阶段之一）。
//
// 【基线为什么是实例内存值、而不是选择器 handle f[0]】——
// AE SDK 明确禁止本阶段做非 cosmetic 改动：「WARNING: When handling
// PF_Cmd_UPDATE_PARAMS_UI, you can call PF_UpdateParamUI() for any param(s), but not
// PF_ChangeFlag_CHANGED_VALUE -- only cosmetic changes can be made in response to this
// command」（AE_Effect.h:1111-1113）。在本阶段写 ARBITRARY handle f[0] 并置
// CHANGED_VALUE——AE 丢弃该值写入，f[0] 恒回旧索引 → 「prev != idx」每次
// UPDATE_PARAMS_UI 都成立 → 逐帧 FORCE_RERENDER：AE 反复使缓存失效并重建 ECW，
// 实测即「切文件后疯狂滚动 / 反复重建效果控件面板」（用户已实测该失败模式）。
// 点击路径不受影响：它在 DO_CLICK 里写 f[0]，该阶段 CHANGED_VALUE 合法（AE_Effect.h:2254）。
// 现基线改用实例内存（effect_ref 键控：仅在 UPDATE_PARAMS_UI 上下文读写，该上下文内
// effect_ref 稳定；实例销毁 PF_Cmd_SEQUENCE_SETDOWN 清除，防地址复用误判）。
static std::map<void*, int> g_reconciledIdx;

static void reconcileFileIndexChange(PF_InData* in_data, PF_OutData* out_data,
                                     PF_ParamDef* params[]) {
    if (!in_data || !out_data || !params) return;
    if (!params[host::kIdxFileIndexParam]) return;   // 参数表恒注册，缺项即理论不该发生
    const int idx = InstanceFileIndex(in_data, params);
    auto it = g_reconciledIdx.find(in_data->effect_ref);
    if (it == g_reconciledIdx.end()) {
        // 首次见到本实例：只记基线不触发——AE 装载/工程恢复后的首帧本就是新渲染，
        // 无需额外强制（也避免 ECW 打开时白白重建一次、把「参数」分组顶开）
        g_reconciledIdx.emplace(in_data->effect_ref, idx);
        return;
    }
    if (it->second == idx) return;   // 索引未变：纯 no-op（不逐帧强刷）
    const int prevIdx = it->second;
    it->second = idx;
    // 一次性诊断（zzdiag-）：索引变更事件本身（不节流——只在真变化时触发）
    {
        char zb[96];
        std::snprintf(zb, sizeof(zb), "zzdiag-reconcile prev=%d new=%d\n", prevIdx, idx);
        host::diagLine(zb);
    }
    // 索引变更（脚本/表达式/工程恢复）：预载新文件条目，使随后的 ECW 重绘与渲染
    // 直接读到该文件的 uniforms/源码（点击路径同样先载再刷新，避免「还要点一下
    // 别的参数面板才更新」）；再与点击路径同款显式要求 AE 重渲染。
    // 预载**按身份解析出的那个文件**（库位移后 idx 可能已指向别的文件）
    int resolvedIdx = -1;
    host::ShaderSnapshot snap =
        instanceShaderSnapshot(in_data, params, /*forRender=*/false, &resolvedIdx);
    // 脚本/表达式/工程恢复切文件后，立即把新文件的映射落盘——
    // 面板下一次 set_param 就能按索引寻址（UPDATE_PARAMS_UI 是主线程上下文）。
    if (!snap.path.empty()) {
        host::writeParamMapFile(snap.path, std::string(), resolvedIdx,
                                snap.source, snap.uniforms);
    }
    // 与点击路径的行为对齐：脚本切文件也要把槽位值重置为新文件声明的默认值
    // （手动点击选择器由 handleFileSelectorClick 重置，脚本路径没有这一步——
    //  脚本切完渲染/槽位名都跟随，但 property(5..132) 仍是上一文件留下的旧值）。
    // 本阶段（UPDATE_PARAMS_UI）SDK 禁止写参数值/置 CHANGED_VALUE（AE_Effect.h:1111-
    // 1113 只允许 cosmetic 改动；上一轮在此写值曾被 AE 丢弃并引发逐帧重渲染），
    // 故只登记 per-instance「待重置」（零参数写入、不注入合成输入、不挂定时器）；
    // 用户在 ECW 里的下一次真实有效事件（DO_CLICK → customUI.cpp handleClick）
    // 消费该标记并执行重置——重置规则与手动点击共用同一单点实现
    //（customUI.cpp resetSlotsToFileDefaults）。取舍：用户不交互则不重置（保旧值）。
    host::RequestSlotResetForFileIndex(in_data, out_data, params);
    // 与点击路径同款：脚本切文件也要「让画面更新」——只做点击路径时，
    // 脚本/表达式写入的索引在 AE 侧只改了参数值，没人要求重渲染 → 画面停在旧文件。
    out_data->out_flags |= PF_OutFlag_FORCE_RERENDER;
    // 诊断：AS_EFFECT_HOST_LOG=1 时改 Win32 直写（rfLog 预算早被渲染诊断耗尽，
    // 主日志里看不到本行——本行「逐帧出现」即坐实索引核对循环的取证通道）
    if (std::getenv("AS_EFFECT_HOST_LOG") != nullptr) {
        char rbuf[64];
        std::snprintf(rbuf, sizeof(rbuf), "ui-idx-reconcile idx=%d", idx);
        host::rawTraceLine(rbuf);
    }
    host::rfLog("ui-idx-reconcile", idx);
}

// —— 重建判定诊断（logUiRebuild）与「隐藏槽位行」A/B 探针（hideSlotRowsProbe）——
// 均已删除：槽位分量全部不在 ECW 里出现，没有「重建判定」需要观测。

// 映射图层行的「已应用声明位」基线（effect_ref 键控内存值，见 SyncParamUI 映射
// 图层段）：仅在 UPDATE_PARAMS_UI 上下文读写，实例销毁 PF_Cmd_SEQUENCE_SETDOWN
// 清除（防 effect_ref 地址复用误判），与 g_reconciledIdx / s_selAppliedH 同款口径。
static std::map<void*, unsigned> g_layerAppliedBits;

// —— param-map 已写基线（effect_ref 键控）——
// key = shaderPath + "|" + uniformSignature。只在 UPDATE_PARAMS_UI（主线程）读写；
// 首见实例、切文件（路径变化）、结构变化或真实热重载（snap.reloaded）时才写盘。
// 不用"每帧都写"：index.json 是整文件重写，逐帧写会变成 UI 卡顿源。
static std::map<void*, std::string> g_paramMapApplied;

// 注册态里「映射图层」行的声明位（addSlot 的 declared 取自 snap0.channelsUsed）：
// 图层行基线的初值——不拿 params[] 回声比对（AE 不回写 cosmetic 字段，见 SyncParamUI
// 映射图层段）。
static unsigned registeredChannelBits() {
    static const unsigned s_bits =
        static_cast<unsigned>(host::getShaderForIndex(host::kDefaultFileIndex, false).channelsUsed) &
        ((1u << host::kIdxMapChannels) - 1u);
    return s_bits;
}


// —— 分组折叠位：不写回、不学习 ——
// 四修的"捕获回声 → 学习 → 趟末全量重申"学习器已撤销，取舍依据（四修构建
// trace 日志）：
//   ① 写回**不被 AE 采纳**。grp-bits-adopt echo=4 base=4：本插件写"折叠"（base=6）
//      后回声仍是展开（echo=4）→ 断路器按设计采信回声 → 用户折叠态被改写成展开，
//      此后每次发射都主动写"展开" → 症状 = "所有参数都展开"（写回反噬成它的反面）。
//   ② 写回自身就是 ECW 重建源。每次都发 3 个 PF_UpdateParamUI(GROUP_START)，而门控
//      （本趟发射过 ‖ 入口偏离）在偏离态下恒真 → 逐趟重建 → 面板持续重排/滚动 →
//      症状 = "不断地向下滚动"。这两条正是用户报告"上次修完更糟"的两个组成。
// 结论（与 SDK AE_Effect.h:404-407 一致）：分组 twirl 态是 **AE 的领域**——PF 侧
// 既可动态改（flags 白名单含 COLLAPSE_TWIRLY）也不保证生效/保持，任何"读回声 →
// 写回 → 再读"的对抗都会把 AE 的偶发状态固化成插件决策。故**分组**不再写
// PF_ParamFlag_COLLAPSE_TWIRLY（「映射图层」组注册期保留 START_COLLAPSED；
// 「参数」组注册即展开，见组注册处）。
// 只读回声探针（grp-echo / emit-pass）已删除；
// 若需重启"AE 因何展开「参数」组"的定位，需重建上述只读回声探针，按其输出判读。

// 说明：四修的 emitGroupTwirlBits（把基线折叠位写回 AE）+ captureGroupTwirlState
// （学习器 + 循环断路器）已整体删除，理由见上方注释（写回不被 AE 采纳、
// 反噬为"全部展开"，且自身即 ECW 重建源 → "持续滚动"）。

// 按当前 uniform 列表同步可见 UI：映射图层行的启用态/名字，以及画布高度。
// AE 限制：ui_flags 中 INVISIBLE/NO_ECW_UI 只能注册期设定，运行时不可逆
// （官方文档：仅 Premiere 支持动态切换）。AE 中可运行时修改的是
// PF_PUI_DISABLED（置灰）、ui_height 与 name（经 PF_UpdateParamUI，见 SDK Supervisor 样例）。
// 槽位分量全部 NO_ECW_UI 且不可见 → 它们不参与任何运行时下发；显示由画布自绘，
// 因此名字/值不依赖回调时机（复制图层/工程恢复不发 UPDATE_PARAMS_UI 也能首屏正确）。
//
// 注意：PF_UpdateParamUI 是"纯外观"改动，不入撤销栈、也不随工程持久化——
// 效果被删除后重加（AE 从工程数据恢复参数，不重跑 PARAMS_SETUP）时，
// 恢复的是 PARAMS_SETUP 时定义的状态。
//
// 每次 PF_UpdateParamUI 都会让 AE 重建 ECW，且**更新折叠组内的参数会把该组顶开**
// （AE 必须显示被更新的行）。故本函数只在**真变化**时下发：映射图层行的声明位。
// 画布高度不在本函数：短内容收缩由 SyncCanvasUI（UPDATE_PARAMS_UI）下发、DRAW 自修。
// 画布注册期挂 SKIP_REVEAL_WHEN_UNHIDDEN，高度变化不 twirl down 父组、不滚动。
static PF_Err SyncParamUI(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[]) {
    PF_ParamUtilsSuite3* pus = nullptr;
    PF_Err err = AEFX_AcquireSuite(in_data, out_data, kPFParamUtilsSuite,
                                   kPFParamUtilsSuiteVersion3,
                                   nullptr, reinterpret_cast<void**>(&pus));
    if (err != PF_Err_NONE || !pus) return PF_Err_INTERNAL_STRUCT_DAMAGED;
    // uniforms 取自本实例选中文件（选择器 handle → 路径 → per-file 缓存快照），
    // 不再读全局 gs.uniforms——多实例（不同文件）各自的 ECW 互不串扰
    int idx = 0;
    host::ShaderSnapshot snap = instanceShaderSnapshot(in_data, params, /*forRender=*/false, &idx);
    const std::vector<glsl::Param>& uniformsCopy = snap.uniforms;
    const size_t n = uniformsCopy.size();
    host::rfLog("ui-sync", (long)n);   // 逐帧路径：走 rfLog 节流（UPDATE_PARAMS_UI 每帧触发时避免磁盘 I/O 风暴）
    // 把本实例当前文件的 uniform→参数索引映射落盘。这里是主线程
    // 正常上下文（SDK 约束：SyncParamUI 只允许 UPDATE_PARAMS_UI），满足"不得在
    // 渲染线程/VEH 写盘"。首见实例/切文件/结构变化/真实热重载才写；写失败只记
    // trace，不影响 UI（基线照样推进，避免每帧重试同一失败）。
    {
        const std::string mapKey = snap.path.empty()
            ? std::string()
            : snap.path + "|" + host::uniformSignature(snap.uniforms);
        auto mit = g_paramMapApplied.find(in_data->effect_ref);
        if (!snap.path.empty() &&
            (mit == g_paramMapApplied.end() || mit->second != mapKey || snap.reloaded)) {
            host::writeParamMapFile(snap.path, std::string(), idx, snap.source, snap.uniforms);
            g_paramMapApplied[in_data->effect_ref] = mapKey;
        }
    }
    // —— 槽位分量：无可见行，零下发 ——
    // 128 个分量注册期全部 PF_PUI_NO_ECW_UI（不出现在 ECW）→ 本函数不对它们做任何
    // PF_UpdateParamUI：名字/启用态/行高都已不是显示依据，显示完全由画布自绘
    // （customUI.cpp drawCanvas）。这也是"点击不滚动"的结构前提：ECW 里没有任何
    // 可被 reveal 的槽位行。

    // —— 映射图层行启用态（iChannel1/2/3）：shader 声明才启用 ——
    // 先声明后选图层；热重载增删声明 → ECW 行即时启用/置灰。
    // **行无法隐藏**（V1 判定：LAYER 未挂 PF_PUI_CONTROL → ui_height 不生效——依据 SDK 注 AE_Effect.h:2290 + 代码复核，本仓库无真机日志）——未声明的
    // 行**常显但 DISABLED**；行名注册期恒为「映射图层 N」，改名「—」只在该声明位
    // 由有变无时发生。
    // 行置灰时旧工程已选的图层值保留（持久化），只是不 checkout 不渲染；
    // shader 加回声明即恢复。
    // 变化检测基线 = 本实例「上次经 PF_UpdateParamUI 应用的声明位」（effect_ref
    // 键控内存值，与 reconcileFileIndexChange / SyncFileSelectorUI 同款口径），
    // **初值 = 注册态声明位**（registeredChannelBits）：不在首见实例上退化为 params[]
    // 回声比对（AE 对 PF_PUI_CONTROL 参数的 ui_height 不回写，LAYER 又未挂
    // PF_PUI_CONTROL——AE_Effect.h:2290 标注 ui_width/ui_height "不采用"）。
    // 首见实例（新建图层加效果）与注册态一致 → 差值恒空 → 零发射。
    const unsigned wantBits = static_cast<unsigned>(snap.channelsUsed) &
                              ((1u << host::kIdxMapChannels) - 1u);
    const auto lit = g_layerAppliedBits.find(in_data->effect_ref);
    const unsigned lprev = (lit != g_layerAppliedBits.end())
        ? lit->second : registeredChannelBits();
    // 本趟结束要写回的基线：未变化的位置保持原值，变化的位置**只有下发成功才推进**
    //（失败保持"待下发"→ 下趟重试）。
    unsigned appliedBits = lprev;
    for (int i = 0; i < host::kIdxMapChannels; ++i) {
        const int pidx = host::kIdxLayerBase + i;
        PF_ParamDef ldef = *params[pidx];  // 复制当前定义，仅改 UI 字段
        // 动态参数名：模板按「ACP 不可表示 → en-US」回退后格式化，再按字符边界落 ACP
        char lnameAcp[32];
        copyMapLayerNameAcp(i + 1, lnameAcp, sizeof(lnameAcp));
        const bool declared = (snap.channelsUsed >> i) & 1;
        PF_ParamUIFlags lui = ldef.ui_flags;
        std::string lnameWant;
        if (declared) {
            lui &= ~PF_PUI_DISABLED;                        // 启用
            lnameWant = lnameAcp;
        } else {
            lui |= PF_PUI_DISABLED;                         // 置灰兜底
            lnameWant = utf8ToAcp("—");
        }
        // ui_height 不改写：LAYER 行本就无法隐藏（V1 判定：行常显但 DISABLED，
        // 依据同 params.h），高度更新只添 reveal 风险、无视觉收益；注册期已统一
        // kLayerUiHeight。
        // 声明位未变即纯 no-op（比对内存基线，不碰回声）。
        const bool lchanged = (declared != (((lprev) >> i) & 1));
        if (lchanged) {
            PF_STRNNCPY(ldef.name, lnameWant.c_str(), sizeof(ldef.name));
            ldef.ui_flags = lui;
            // 成功才记该位基线：此前无条件写 wantBits——一次 PF_UpdateParamUI 失败
            // 就让该行永久停在错误的名字/启用态（基线已推进 → lchanged 恒 false →
            // 永不下发）。而契约恰恰告诉用户/模型"判别看行是否置灰"——行态失真的
            // 判据本身也会失真。
            if (pus->PF_UpdateParamUI(in_data->effect_ref, pidx, &ldef) == PF_Err_NONE) {
                appliedBits = (appliedBits & ~(1u << i)) | (declared ? (1u << i) : 0u);
            }
        }
    }
    g_layerAppliedBits[in_data->effect_ref] = appliedBits;

    // —— 分组折叠位：不再写回 ——
    // 四修在此处的"趟末全量重申基线"（emitGroupTwirlBits）已整体删除：实测该
    // 写回不被 AE 采纳（trace: grp-bits-adopt echo=4 base=4 —— 写"折叠"后回声仍
    // 是展开 → 断路器采信展开 → 此后每次都主动写"展开"），且它自身每次都是 3 个
    // PF_UpdateParamUI（AE 重建 ECW）→ 逐趟重排/滚动。分组 twirl 态交还 AE 管理，
    // 见上方「分组折叠位：不写回、不学习」注释与该写回"不被 AE 采纳"的实测 trace 证据。

    // 画布高度：注册值是 15 行上限；短内容由 SyncCanvasUI（UPDATE_PARAMS_UI）收缩，
    // 复制/切图层后 AE 按注册高度重建 ECW 时由 DRAW 入口的自修补发（customUI.cpp
    // repairCanvasHeightIfNeeded）。即使补发被丢弃，视口按实得高度工作（滚动可到达，
    // 不裁切），不会留下不可用状态。

    AEFX_ReleaseSuite(in_data, out_data, kPFParamUtilsSuite, kPFParamUtilsSuiteVersion3, nullptr);
    return PF_Err_NONE;
}

// —— 实例身份铸号（载体是序列数据，见 seqIdentity.h）——
// SEQUENCE_SETUP 每次「效果被应用到图层」都发（真机日志核实每实例一条）→ 新实例
// 在这里铸一个**非零** id 存进序列数据。**24 位**（host::makeInstanceId，见
// solverKeyIdentity.h）是历史遗留的保守上限（当年 id 走 FLOAT_SLIDER 参数，真机实测
// AE 按 float32 存取、52 位往返丢低位撞号）；序列数据是整块字节拷贝，位数本可放宽，
// 但 24 位足以区分会话内实例，且 makeInstanceId 已有单测扫过全空间，保持不变。
// 混法：tick 低 12 位（跨会话/进程重启区分）⊕ 进程内自增计数器低 12 位
//（同一 tick 内多个新实例也互不相同）。
// 线程：仅 SEQUENCE_SETUP/RESETUP（主线程）调用；原子计数器是防御性兜底
//（任何线程调用都安全）。
static uint64_t freshInstanceId() {
    static std::atomic<uint32_t> s_seq{0};
    const uint64_t tick = GetTickCount64();
    const uint32_t seq  = s_seq.fetch_add(1, std::memory_order_relaxed);
    return static_cast<uint64_t>(host::makeInstanceId(tick, seq));
}

// 入口点必须导出（extern "C" DllExport）：PiPL 中 CodeWin64X86 指定的
// 符号名 "EffectMain" 需要能从 .aex 导出表中解析，否则报 48::72。
extern "C" DllExport PF_Err EffectMain(
    PF_Cmd cmd, PF_InData* in_data, PF_OutData* out_data,
    PF_ParamDef* params[], PF_LayerDef* output, void* extra) {
    (void)extra;
    PF_Err err = PF_Err_NONE;
    logCmd("enter", cmd);
    try {
        switch (cmd) {
        case PF_Cmd_ABOUT: {
            // ABOUT 无 params（读不到本实例选择器值），展示 effects 目录
            // （N1 后选中文件是 per-instance 状态，不再有全局"当前文件"）
            char aboutUtf8[1024];
            std::snprintf(aboutUtf8, sizeof(aboutUtf8), Tr(S_EFFECTHOST_PLUGIN_ABOUT),
                effectsDir().c_str());
            PF_STRNNCPY(out_data->return_msg, utf8ToAcp(aboutUtf8).c_str(), sizeof(out_data->return_msg));
            break;
        }
        case PF_Cmd_GLOBAL_SETUP:
            // 语言在初始化期固定一次：GLOBAL_SETUP 早于 PARAMS_SETUP，参数名注册读到
            // 的是已解析语言；取不到宿主语言（空 tag）时运行时回退 zh-CN。
            {
                AEFX_SuiteScoper<PFAppSuite6, true> appSuite(
                    in_data, kPFAppSuite, kPFAppSuiteVersion6);
                char langTag[PF_APP_LANG_TAG_SIZE] = {0};
                if (appSuite.get()) appSuite->PF_AppGetLanguage(langTag);
                i18n::setLocaleTag(langTag);
            }
            // 崩溃取证：此时不在 DllMain/加载器锁内，枚举模块表安全；只执行一次
            // （PARAMS_SETUP 还有一次幂等刷新兜底，见 refreshModuleTableAfterLoad）。
            refreshModuleTableAfterLoad();
            out_data->my_version = PF_VERSION(1, 0, 0, 0, 0);
            // 对齐 SDK 示例（SDK_Invert_ProcAmp）：不使用 USE_OUTPUT_EXTENT
            // （未实现 extent rect 处理时声明该 flag 有风险）
            out_data->out_flags =
                PF_OutFlag_WIDE_TIME_INPUT |
                PF_OutFlag_PIX_INDEPENDENT |
                PF_OutFlag_DEEP_COLOR_AWARE |
                PF_OutFlag_NON_PARAM_VARY |
                PF_OutFlag_SEND_UPDATE_PARAMS_UI |
                PF_OutFlag_CUSTOM_UI;   // 32 槽位自绘控件（PF_PUI_CONTROL）必需；PiPL 需同步该位
            // WIDE_TIME_INPUT：@history N 在 smartPreRender 用 checkout_layer 的 what_time
            // 检出前 N 帧输入（含前序效果；SMART_RENDER 按 checkout_id 取回）；legacy
            // PF_Cmd_RENDER 路径仍用 PF_CHECKOUT_PARAM（renderer.cpp HistoryCheckout，
            // 该通道给未加工源图层）。
            // SDK 明文要求按非当前时刻取参数必须声明本位：「Set this flag if the effect calls
            // get_param to inquire a parameter at a time besides the current one (e.g. to get the
            // previous video frame)」（AE_Effect.h:505-508），且应在 GLOBAL_SETUP 发出
            //（枚举定义见 AE_Effect.h:865）。不声明时 AE 不保证提供/失效邻帧输入 → @history
            // 拖尾可能沿用缓存旧帧（上游早帧改动不生效）。代价：参数/上游变化时 AE 会把
            // 失效范围按时间依赖扩大（正确性代价，属预期）。PiPL 需同步该位。
            // 不用 PF_OutFlag2_AUTOMATIC_WIDE_TIME_INPUT（AE_Effect.h:790-803）：它要求用
            // PF_HaveInputsChangedOverTimeSpan 校验「缓存的时间相关数据」，本效果的结算帧
            // 缓存（renderer.cpp 谱系表）不满足该义务——经典位即本需求的正解。
            // NON_PARAM_VARY：效果输出随 time 变化（输入静止+参数恒定也不缓存），
            // 否则 AE 缓存第一帧导致时间动画冻结。PiPL 需同步该位。
            // SEND_UPDATE_PARAMS_UI：ECW 打开/时间变化时收到 UPDATE_PARAMS_UI，
            // 用于同步槽位可见性与名称（Task 8）。PiPL 需同步该位。
            // FLOAT_COLOR_AWARE：支持 32bit float 像素（renderer 已实现 PF_Pixel32 读写分支）
            // SUPPORTS_SMART_RENDER：支持 SmartRender 回调（智能渲染基础 + 32bit 必需）
            // 注意：不声明 SUPPORTS_THREADED_RENDERING —— 实测 MFR 多线程下 GPU 驱动
            //   在 glUseProgram 崩溃（0xC0000005），根因是单 GL 上下文跨线程切换时
            //   驱动内部状态损坏。AE 会显示"未针对多帧渲染优化"提示，但不影响功能。
            //   后续如需 MFR，需改为每线程独立 GL 上下文 + 共享 shader（复杂度高）。
            // PARAM_GROUP_START_COLLAPSED_FLAG：允许折叠分组展开
            out_data->out_flags2 = PF_OutFlag2_PARAM_GROUP_START_COLLAPSED_FLAG |
                                   PF_OutFlag2_FLOAT_COLOR_AWARE |
                                   PF_OutFlag2_SUPPORTS_SMART_RENDER;
            // L2 相机感知：SDK 强制要求——用 AEGP PF_Interface Suite 访问相机层
            // 的效果必须声明 I_USE_3D_CAMERA（AE_Effect.h:743「This bit must be
            // set if the effect ever uses the AEGP PF_Interface suite to access
            // camera layers」）。作用：① ECW 效果名旁显示摄像机标志（Comp Camera
            // attribute，官方文档「Cameras affect only 3D and 2D layers with an
            // effect with a Comp Camera attribute」）；② 告知 AE 本效果依赖相机
            // → 相机/图层 3D 属性变动触发重渲（缓解缓存失效风险）。PiPL 须同步该位。
            out_data->out_flags2 |= PF_OutFlag2_I_USE_3D_CAMERA;
            // L3 灯光感知：SDK 强制要求——用 AEGP PF_Interface Suite 访问灯光层的效果
            // 必须声明 I_USE_3D_LIGHTS（AE_Effect.h:906「1L << 2」，适用 GLOBAL_SETUP +
            // QUERY_DYNAMIC_FLAGS）。作用与相机位同源：告知 AE 本效果依赖合成灯光 →
            // 灯光属性变动触发重渲（缓解缓存失效）。**SDK 文档陷阱**：AE_Effect.h:750-751
            // 对本位的说明文字是从相机那段复制粘贴来的（写成 "access camera layers"），
            // 照字面搜 "light" 会错过这条。PiPL 须同步该位（AS_Effect_HostPiPL.r）。
            out_data->out_flags2 |= PF_OutFlag2_I_USE_3D_LIGHTS;
            // 探针：声明 GPU 渲染支持，触发 GPU_DEVICE_SETUP 回调（诊断 GPU 框架）。
            // 注意：暂不设置 PreRender 的 GPU_RENDER_POSSIBLE，故仍走 CPU 渲染路径，
            // 仅用于读取 what_gpu / offscreen_opengl_context 的诊断信息。
            out_data->out_flags2 |= PF_OutFlag2_SUPPORTS_GPU_RENDER_F32;
            logCmd("global-setup-done", 0);
            break;
        case PF_Cmd_GLOBAL_SETDOWN:
            // setdown 分支处理两处生命周期缺口：VEH 未注销、崩溃日志/
            // dump 预开句柄不关闭（仅显式卸载 .aex 场景有意义的生命周期缺口，
            // AE 正常退出由进程清理兜底，但显式卸载后 VEH 指向已卸载代码即是
            // 崩溃源）。GL 资源不在此拆除：setdown 上下文无 GL 绑定保证
            //（借用 AE 离屏上下文需 wglMakeCurrent，此处不可安全获取），句柄
            // 与纹理交由进程退出统一回收；做最小处理：VEH 注销 + 日志链关闭。
            logCmd("global-setdown", cmd);
            // 滚轮钩子装在专用线程上：卸载前停掉并清空目标，避免 DLL 卸载后
            // 线程仍执行已卸载代码（见 customUI.cpp ShutdownWheelHook 注释）
            host::ShutdownWheelHook();
            if (g_vehHandle) {
                RemoveVectoredExceptionHandler(g_vehHandle);
                g_vehHandle = nullptr;
            }
            // 句柄关闭走轮转锁 + 原子摘取（防与 host::maybeRotateDiagLog 轮转段并发）
            AcquireSRWLockExclusive(&g_crashLogRotateLock);
            {
                HANDLE hLog = reinterpret_cast<HANDLE>(InterlockedExchangePointer(
                        reinterpret_cast<PVOID volatile*>(&g_crashLogH),
                        reinterpret_cast<PVOID>(INVALID_HANDLE_VALUE)));
                if (hLog != INVALID_HANDLE_VALUE) {
                    CloseHandle(hLog);
                }
            }
            if (g_dumpH != INVALID_HANDLE_VALUE) {
                CloseHandle(g_dumpH);
                g_dumpH = INVALID_HANDLE_VALUE;
            }
            ReleaseSRWLockExclusive(&g_crashLogRotateLock);
            break;
        case PF_Cmd_PARAMS_SETUP: {
            logCmd("ps-start", 0);
            // 崩溃取证：此时 AE 的服务 DLL（wrservices.dll 等）已加载，刷新一次
            // VEH 模块表（正常上下文；只执行一次，见 refreshModuleTableAfterLoad）
            refreshModuleTableAfterLoad();
            // 预加载效果文件：让 ECW 首次 UPDATE_PARAMS_UI 就拿到正确 uniform 列表
            // 结果进 per-file 缓存；快照同时供下方槽位注册取默认值（默认文件的
            // uniform 列表；实例实际选中文件由 AE 随后从工程恢复，UI 由 SyncParamUI 同步）
            host::ShaderSnapshot snap0 = loadEffectFile();
            logCmd("ps-loaded", 0);
            // 探针：主动查询 AE 的 GPU 设备套件（不创建自建 GL 上下文，避免崩溃）。
            // 目的：诊断 offscreen_opengl_context 是否可用、当前 GPU 框架，判断后续改造方案。
            {
                try {
                    AEFX_SuiteScoper<PF_GPUDeviceSuite1> gpuSuite(
                        in_data, kPFGPUDeviceSuite, kPFGPUDeviceSuiteVersion1, out_data);
                    A_u_long deviceCount = 0;
                    PF_Err gerr = gpuSuite->GetDeviceCount(in_data->effect_ref, &deviceCount);
                    logCmd("gpu-device-count", (int)deviceCount);
                    logCmd("gpu-count-err", (int)gerr);
                    for (A_u_long di = 0; di < deviceCount; ++di) {
                        PF_GPUDeviceInfo devInfo;
                        AEFX_CLR_STRUCT(devInfo);
                        PF_Err ierr = gpuSuite->GetDeviceInfo(in_data->effect_ref, di, &devInfo);
                        logCmd("gpu-idx", (int)di);
                        logCmd("gpu-info-err", (int)ierr);
                        logCmd("gpu-offscreen-ctx", (int)(intptr_t)devInfo.offscreen_opengl_contextPV);
                        logCmd("gpu-offscreen-dc", (int)(intptr_t)devInfo.offscreen_opengl_devicePV);
                        logCmd("gpu-compatible", (int)devInfo.compatibleB);
                        logCmd("gpu-framework", (int)devInfo.device_framework);
                    }
                } catch (...) {
                    logCmd("gpu-suite-throw", 0);
                }
            }
            logCmd("ps-gpu-probe-done", 0);
            // 主线程提前创建 GL 上下文（优先 AE 离屏上下文）：渲染线程只做轻量
            // rebind，避免首次播放渲染时在渲染线程建上下文（驱动不稳定，
            // 见 renderer.cpp ensureGlContext 注释）
            host::ensureGlContext(in_data, out_data);
            logCmd("ps-uniforms", (int)snap0.uniforms.size());

            PF_ParamDef def;

            // —— 「Shader 文件」分组：自绘文件选择器（默认展开）——
            AEFX_CLR_STRUCT(def);
            def.param_type = PF_Param_GROUP_START;
            copyParamNameAcp(S_EFFECTHOST_PLUGIN_PARAM_SHADER_FILE,
                             def.name, sizeof(def.name));
            def.uu.id = host::kIdxFileGroupStart;
            err = PF_ADD_PARAM(in_data, -1, &def);
            logCmd("ps-file-group-start", (int)err);
            if (err != PF_Err_NONE) return err;

            // 文件选择器（自绘控件）：ARBITRARY_DATA + PF_PUI_CONTROL（句柄布局见
            // fileSelLayout.h；展开/滚动会话态存 v[1]/v[2]，v[0] 为只写不读的遗留索引）。
            // 必须 ARBITRARY——实测 AE 对标准参数类型不采用 ui_height，展开/折叠会整体失效。
            // 选中索引真相源是尾部隐藏原生参数 kIdxFileIndexParam（PF_PUI_NO_ECW_UI）。
            AEFX_CLR_STRUCT(def);
            PF_ArbitraryH selDflt = nullptr;
            float selZero[4] = {0.0f, 0.0f, 0.0f, 0.0f};
            err = host::AllocFileSelHandle(in_data, out_data, selZero, &selDflt);
            if (err != PF_Err_NONE) return err;
            // PF_ADD_ARBITRARY2 宏内失败直接 return（Param_Utils.h），包 lambda
            // 拦截以便回收已分配的 dephault（AE 未接管时泄漏）
            auto addFileSel = [&]() -> PF_Err {
                // SKIP_REVEAL_WHEN_UNHIDDEN：选择器高度 24↔177 动态变化（hide/show
                // 模式），压制 AE 原生 reveal 的"展开父组 + 滚动到该参数"（同槽位行）
                // CANNOT_TIME_VARY：选择器不是可动画的值；不挂会在参数名左侧画出
                // 关键帧秒表（同「重算结算器」行：
                // 选择器这些年一直带着同一个多余的秒表）
                char nameAcp[32];   // 参数名 ACP 缓冲：不可表示时回退 en-US（见 acpName.h）
                copyParamNameAcp(S_EFFECTHOST_PLUGIN_PARAM_GLSL_FILE,
                                 nameAcp, sizeof(nameAcp));
                PF_ADD_ARBITRARY2(nameAcp,
                                  host::kSlotUiWidth, host::kFileSelCollapsedH,
                                  PF_ParamFlag_SKIP_REVEAL_WHEN_UNHIDDEN |
                                  PF_ParamFlag_CANNOT_TIME_VARY,
                                  PF_PUI_CONTROL | PF_PUI_DONT_ERASE_CONTROL,
                                  selDflt, host::kFileSelUiId, host::kSlotRefcon);
                return PF_Err_NONE;
            };
            err = addFileSel();
            logCmd("ps-file-selector", (int)err);
            if (err != PF_Err_NONE) {
                PF_DISPOSE_HANDLE(selDflt);
                return err;
            }

            AEFX_CLR_STRUCT(def);
            def.param_type = PF_Param_GROUP_END;
            def.uu.id = host::kIdxFileGroupEnd;
            err = PF_ADD_PARAM(in_data, -1, &def);
            logCmd("ps-file-group-end", (int)err);
            if (err != PF_Err_NONE) return err;

            // —— 「参数」分组：128 个槽位分量（纯数值容器）+ 一个自绘画布 ——
            // 每槽 4 个分量各注册为 PF_Param_FLOAT_SLIDER，**全部** PF_PUI_NO_ECW_UI：
            // 值/disk ID/量程/默认值照旧（脚本读写、时间线关键帧、渲染不受影响）。
            // 值类型固定（不随 uniform 类型变化）→ AE 缓存/重加不重跑 PARAMS_SETUP
            // 均不影响；控件形态由画布按当前 uniform 类型自绘（见 customUI.cpp）。
            // 组内唯一的可见行是画布（kIdxCanvas），高度按 uniform 行数同步。
            auto addSlot = [&](int i) -> PF_Err {
                const bool active = (i < static_cast<int>(snap0.uniforms.size()));
                float dv[4] = {0.0f, 0.0f, 0.0f, 0.0f};
                if (active) {
                    // 默认值规则与文件切换重置共用单点实现（见 params.h ecwDefault4）：
                    // Float 无初始化器默认 1.0；vec4 无初始化器默认全 1.0；vec2/vec3
                    // 无初始化器保持 0；有初始化器取解析值。
                    host::ecwDefault4(snap0.uniforms[i], dv);
                }
                for (int c = 0; c < host::kFloatsPerSlot; ++c) {
                    AEFX_CLR_STRUCT(def);
                    def.param_type = PF_Param_FLOAT_SLIDER;
                    // 命名：分量0 = **空**（显示名由画布按当前 uniform 自绘）；
                    // 分量1/2/3 = 名.g/.b/.a 或 名.y/.z/.w（仅脚本按分量寻址用）；
                    // 未用分量为 "—"。
                    const std::string slotName = (c == 0)
                        ? std::string()
                        : (active ? slotCompNameAcp(snap0.uniforms[i], c) : utf8ToAcp("—"));
                    PF_STRNNCPY(def.name, slotName.c_str(), sizeof(def.name));
                    // 全部 4 分量都是**隐藏数值容器**：标准参数类型不采用 ui_height，
                    // 用 NO_ECW_UI 注册即完全不出现在 ECW。值/disk ID/量程/默认值照旧
                    // 注册 → 脚本读写、时间线关键帧与渲染路径不受影响
                    //（AE_Effect.h:2194：NO_ECW_UI 在 AE 不影响时间线关键帧轨）。
                    def.ui_flags  = PF_PUI_NO_ECW_UI;
                    def.ui_width  = host::kSlotUiWidth;
                    def.ui_height = 0;
                    // fs_d.value/dephault 是 PF_FpShort(float)：显式窄化到目标类型，
                    // 别用 PF_FpLong 的 cast 让编译器在赋值处隐式收窄（/W4 C4244）
                    def.u.fs_d.value    = def.u.fs_d.dephault = static_cast<PF_FpShort>(dv[c]);
                    // valid（可接受输入范围）保持宽：脚本/AI 写入任意数值不被 AE 钳制。
                    def.u.fs_d.valid_min  = static_cast<PF_FpShort>(host::kSlotSliderValidMin);
                    def.u.fs_d.valid_max  = static_cast<PF_FpShort>(host::kSlotSliderValidMax);
                    // slider（滑条宽度所代表的量程）与 valid **分离**，按 uniform 类型/命名
                    // 给有用量程 + 显示精度：两者若共用 ±1e9，
                    // AE 原生参数对话框显示"滑块范围 -1000000000 至 1000000000"、滑条
                    // 1px ≈ 1e7 完全不可微调。规则与理由见 params.h slotSliderRange。
                    // 未激活槽位没有 uniform 可依据，维持宽量程（该行本就置灰不显示）。
                    if (active) {
                        double slo = 0.0, shi = 1.0;
                        int sprec = 3;
                        host::slotSliderRange(snap0.uniforms[i], &slo, &shi, &sprec);
                        def.u.fs_d.slider_min = static_cast<PF_FpShort>(slo);
                        def.u.fs_d.slider_max = static_cast<PF_FpShort>(shi);
                        def.u.fs_d.precision  = static_cast<A_short>(sprec);
                    } else {
                        def.u.fs_d.slider_min = def.u.fs_d.valid_min;
                        def.u.fs_d.slider_max = def.u.fs_d.valid_max;
                    }
                    def.uu.id = host::kSlotCompDiskIdBase + i * host::kFloatsPerSlot + c;
                    err = PF_ADD_PARAM(in_data, -1, &def);
                    logCmd("ps-slot-add", i);
                    if (err != PF_Err_NONE) return err;
                }
                return PF_Err_NONE;
            };

            AEFX_CLR_STRUCT(def);
            def.param_type = PF_Param_GROUP_START;
            copyParamNameAcp(S_EFFECTHOST_PLUGIN_PARAM_GROUP_PARAMS,
                             def.name, sizeof(def.name));
            // **注册即展开**：AE 的分组 twirl 位对显示无效（只能靠"行更新触发的
            // reveal"改变），任何 ECW 重建都把折叠位重置为注册默认（展开）。
            // 边界：手动收起后，下一次 ECW 重建会重置回展开——折叠选择不被记录。
            // 分组自身的 twirl flag 不写、不读：它对 ECW 显示无效，写回还会反噬成
            // "全部展开"并逐趟重建（见「分组折叠位：不写回、不学习」注释）。
            def.flags = 0;
            def.uu.id = host::kGroupStartDiskId;                        // 盘 ID 固定 4
            err = PF_ADD_PARAM(in_data, -1, &def);
            logCmd("ps-group-start", (int)err);
            if (err != PF_Err_NONE) return err;

            for (int i = 0; i < host::kMaxParams; ++i) {
                err = addSlot(i);
                if (err != PF_Err_NONE) return err;
            }
            logCmd("ps-slots", host::kMaxParams);

            // —— 自绘画布：组内唯一可见行，承载全部 uniform（见 params.h kIdxCanvas）——
            // ARBITRARY_DATA + PF_PUI_CONTROL：AE 只对 ARBITRARY+CONTROL 采纳 ui_height
            // （AE_Effect.h:2290-2291）。
            // CANNOT_TIME_VARY：画布不是值、做不了关键帧——不挂会在标题左侧画出秒表。
            // 参数名为空串：AE 仍画一行空标题 + twirly，即「参数」组里的容器行。
            // 高度注册为 kCanvasViewH（15 行上限的视口）：短内容由 SyncCanvasUI
            //（UPDATE_PARAMS_UI）收缩到内容高度、DRAW 里按实况自修；复制/恢复出的
            // 实例上 AE 可能丢弃运行期高度，实得高度即视口（按实得行数滚动，不裁切）。
            {
                const A_short initialH = static_cast<A_short>(host::kCanvasViewH);
                PF_ArbitraryH cvDflt = nullptr;
                float cvZero[4] = {0.0f, 0.0f, 0.0f, 0.0f};
                err = host::AllocFileSelHandle(in_data, out_data, cvZero, &cvDflt);
                logCmd("ps-canvas-alloc", (int)err);
                if (err != PF_Err_NONE) return err;
                // PF_ADD_ARBITRARY2 宏内失败直接 return（Param_Utils.h），包 lambda
                // 拦截以便回收已分配的 dephault（AE 未接管时泄漏）
                auto addCanvas = [&]() -> PF_Err {
                    AEFX_CLR_STRUCT(def);
                    PF_ADD_ARBITRARY2("",
                                      host::kCanvasWidth, initialH,
                                      PF_ParamFlag_SKIP_REVEAL_WHEN_UNHIDDEN |
                                      PF_ParamFlag_CANNOT_TIME_VARY,
                                      PF_PUI_CONTROL | PF_PUI_DONT_ERASE_CONTROL,
                                      cvDflt, host::kCanvasUiId, host::kSlotRefcon);
                    return PF_Err_NONE;
                };
                err = addCanvas();
                logCmd("ps-canvas-add", (int)err);
                if (err != PF_Err_NONE) {
                    PF_DISPOSE_HANDLE(cvDflt);
                    return err;
                }
            }

            AEFX_CLR_STRUCT(def);
            def.param_type = PF_Param_GROUP_END;
            def.uu.id = host::kGroupEndDiskId;                          // 盘 ID 固定 133
            err = PF_ADD_PARAM(in_data, -1, &def);
            logCmd("ps-group-end", (int)err);
            if (err != PF_Err_NONE) return err;

            // —— 「映射图层」分组：iChannel1/2/3 原生图层下拉（默认折叠）——
            // shader 声明 iChannel1/2/3 时可各选一个合成图层作纹理输入。
            // AE 原生下拉：合成增删图层自动同步、随工程持久化、可被表达式引用。
            // **行高恒定**（kLayerUiHeight，运行时不再改写——LAYER 行本就无法隐藏，
            // 见 `.h` 里的 V1 判定注）；未声明的行只加 DISABLED 置灰，启用态由
            // SyncParamUI 按当前文件声明同步（热重载「想变就变」）。
            // 盘 ID 全部固定（params.h kLayerBaseDiskId 等）：索引随画布插入而位移，
            // 用索引当盘 ID 会让旧工程的图层选择落到别的参数上。
            AEFX_CLR_STRUCT(def);
            def.param_type = PF_Param_GROUP_START;
            copyParamNameAcp(S_EFFECTHOST_PLUGIN_PARAM_GROUP_MAP_LAYERS,
                             def.name, sizeof(def.name));
            def.flags = PF_ParamFlag_START_COLLAPSED;
            def.uu.id = host::kLayerGroupStartDiskId;                   // 盘 ID 固定 134
            err = PF_ADD_PARAM(in_data, -1, &def);
            logCmd("ps-layer-group-start", (int)err);
            if (err != PF_Err_NONE) return err;

            for (int i = 0; i < host::kIdxMapChannels; ++i) {
                AEFX_CLR_STRUCT(def);
                const bool declared = (snap0.channelsUsed >> i) & 1;
                // 行高统一注册、运行时不再改写：
                // LAYER 行无法隐藏（V1 判定：行常显），未声明的行只加 DISABLED 置灰——
                // **行名注册期恒为「映射图层 N」**，改名「—」只在 SyncParamUI 里、该声明位
                // 由有变无时发生。
                def.ui_height = static_cast<A_short>(host::kLayerUiHeight);
                if (!declared) def.ui_flags |= PF_PUI_DISABLED;
                // SKIP_REVEAL_WHEN_UNHIDDEN：注册期压制 reveal（同画布；
                // PF_ADD_LAYER 宏不触碰 flags，此处先行设置即可）
                def.flags = PF_ParamFlag_SKIP_REVEAL_WHEN_UNHIDDEN;
                char lnameAcp[32];
                copyMapLayerNameAcp(i + 1, lnameAcp, sizeof(lnameAcp));
                // PF_ADD_LAYER：param_type=PF_Param_LAYER + u.ld.dephault=PF_LayerDefault_NONE
                //（默认不选图层；checkout 时 data==NULL → 黑透明采样）。宏内部
                // 检出错误会直接 return（与上方槽位/选择器的 PF_ADD_PARAM 同款约定）。
                PF_ADD_LAYER(lnameAcp, PF_LayerDefault_NONE,
                             host::kLayerBaseDiskId + i);
                logCmd("ps-layer-add", i);
            }

            AEFX_CLR_STRUCT(def);
            def.param_type = PF_Param_GROUP_END;
            def.uu.id = host::kLayerGroupEndDiskId;                     // 盘 ID 固定 138
            err = PF_ADD_PARAM(in_data, -1, &def);
            logCmd("ps-layer-group-end", (int)err);
            if (err != PF_Err_NONE) return err;

            // —— 「启用三维摄像机」复选框（L2 相机联动总开关）——
            // 默认勾选；取消时渲染路径跳过 AEGP 查询（见 Render/SmartRender），
            // shader 侧收到的 uHasCam/uCamFov/uCamPos/uCamMatrix/uWorldMatrix 与
            // 「无相机合成」同语义（0/单位阵）。
            {
                char camAcp[32];   // 参数名 ACP 缓冲：不可表示时回退 en-US（见 acpName.h）
                copyParamNameAcp(S_EFFECTHOST_PLUGIN_PARAM_CAM3D_ENABLE,
                                 camAcp, sizeof(camAcp));
                PF_ADD_CHECKBOXX(camAcp, 1 /*默认勾选*/, 0, host::kCamEnableDiskId);
            }
            logCmd("ps-cam-enable", host::kIdxCamEnable);

            // —— 选中文件索引真相源（脚本可读写；PF_PUI_NO_ECW_UI → 不在 ECW 出现）——
            // ExtendScript: fx.property(kIdxFileIndexParam+1).setValue(索引)
            // UI 点击、脚本写入、渲染/SmartRender/SyncParamUI 读取全部统一到本参数。
            // 加挂 PF_ParamFlag_SUPERVISE——目的是把「索引变了」升格成
            // PF_Cmd_USER_CHANGED_PARAM（该阶段写参数值与置 FORCE_RERENDER 均合法：
            // AE_Effect.h:2250 / :886），从而在**无用户交互**的情况下也能把槽位值重置为
            // 新文件声明的默认值（脚本切文件后画面死黑的根因，见 customUI.cpp
            // ApplySlotDefaultsNow 注释）。SDK 两处原文口径不一致：标志表（AE_Effect.h:413）
            // 「If this is passed, PF_Cmd_USER_CHANGED_PARAM will be sent when this
            // parameter changes」是无条件表述，命令表（AE_Effect.h:1089）则写「whenever
            // the user interacts with a standard param controller」；实际行为：
            // **脚本写值同样派发本命令**（连续两次纯脚本 setValue 各产生一对 zzdiag-ucp，
            // 无任何用户交互）。SDK 标志表（:413「参数变化即派发」）表述正确，命令表
            //（:1089「用户操作标准控件时派发」）表述不完整；仓库旧记录已作废。
            AEFX_CLR_STRUCT(def);
            def.param_type = PF_Param_FLOAT_SLIDER;
            copyParamNameAcp(S_EFFECTHOST_PLUGIN_PARAM_GLSL_INDEX,
                             def.name, sizeof(def.name));
            def.ui_flags  = PF_PUI_NO_ECW_UI;
            def.flags     = PF_ParamFlag_SUPERVISE;
            def.ui_width  = host::kSlotUiWidth;
            def.ui_height = 0;
            def.u.fs_d.value    = def.u.fs_d.dephault = static_cast<PF_FpLong>(host::kDefaultFileIndex);
            def.u.fs_d.valid_min  = static_cast<PF_FpShort>(host::kFileSelValidMin);
            def.u.fs_d.valid_max  = static_cast<PF_FpShort>(host::kFileSelValidMax);
            def.u.fs_d.slider_min = def.u.fs_d.valid_min;
            def.u.fs_d.slider_max = def.u.fs_d.valid_max;
            def.uu.id = host::kFileSelDiskId;
            err = PF_ADD_PARAM(in_data, -1, &def);
            logCmd("ps-file-index-add", (int)err);
            if (err != PF_Err_NONE) return err;

            // —— 「启用三维灯光」复选框（L3 灯光联动总开关）——
            // 默认勾选；取消时渲染路径跳过 AEGP 合成枚举（见 Render/SmartRender），
            // shader 侧收到的 uHasLights/uLightCount 与整个灯光数组均为零值，
            // 与「无灯合成」及面板预览同语义。
            // 【必须追加在文件索引参数之后】AE 按 disk ID 恢复旧工程参数值，插在
            // 文件索引之前会让旧工程存下的那份索引被本复选框误读——严格遵守
            // params.h 的「只能在尾部追加」纪律。ECW 观感不受影响
            //（文件索引挂 PF_PUI_NO_ECW_UI 不显示）。
            {
                char lightsAcp[32];   // 参数名 ACP 缓冲：不可表示时回退 en-US（见 acpName.h）
                copyParamNameAcp(S_EFFECTHOST_PLUGIN_PARAM_LIGHTS3D_ENABLE,
                                 lightsAcp, sizeof(lightsAcp));
                PF_ADD_CHECKBOXX(lightsAcp, 1 /*默认勾选*/, 0, host::kLightEnableDiskId);
            }
            logCmd("ps-light-enable", host::kIdxLightEnable);

            // —— 「重算代数」隐藏计数器（见 params.h kIdxSolveGen）——
            // 手动「重算结算器」按钮每点一次 +1：值真变 → AE 失效该帧缓存 → 重渲。
            // 不加 PF_ParamFlag_SUPERVISE（本参数由插件自己写，不需要 USER_CHANGED_PARAM）。
            AEFX_CLR_STRUCT(def);
            def.param_type = PF_Param_FLOAT_SLIDER;
            copyParamNameAcp(S_EFFECTHOST_PLUGIN_PARAM_SOLVE_GEN,
                             def.name, sizeof(def.name));
            def.ui_flags  = PF_PUI_NO_ECW_UI;
            // CANNOT_TIME_VARY：内部计数器，被关键帧驱动会让结算指纹每帧变、状态永不累积
            def.flags     = PF_ParamFlag_CANNOT_TIME_VARY;
            def.ui_width  = host::kSlotUiWidth;
            def.ui_height = 0;
            def.u.fs_d.value    = def.u.fs_d.dephault = 0;
            def.u.fs_d.valid_min  = 0;
            def.u.fs_d.valid_max  = static_cast<PF_FpShort>(host::kSolveGenValidMax);
            def.u.fs_d.slider_min = 0;
            def.u.fs_d.slider_max = static_cast<PF_FpShort>(host::kSolveGenValidMax);
            def.uu.id = host::kSolveGenDiskId;
            err = PF_ADD_PARAM(in_data, -1, &def);
            logCmd("ps-solve-gen-add", (int)err);
            if (err != PF_Err_NONE) return err;

            // —— 「重算结算器」按钮控件（见 params.h kIdxSolveBtn）——
            // 纯 UI 的自绘控件：位置在参数表末尾（= 视觉上「启用三维灯光」的下一行，
            // 隐藏的 kIdxSolveGen 不占行）。点击只做两件事：让 kIdxSolveGen 的计数器 +1
            // （缓存失效载体）与置 FORCE_RERENDER；结算状态复位由渲染路径据指纹变化完成。
            {
                PF_ArbitraryH btnDflt = nullptr;
                float btnZero[4] = {0.0f, 0.0f, 0.0f, 0.0f};
                err = host::AllocFileSelHandle(in_data, out_data, btnZero, &btnDflt);
                if (err != PF_Err_NONE) return err;
                auto addSolveBtn = [&]() -> PF_Err {
                    // CANNOT_TIME_VARY：按钮不是值、做不了关键帧——不挂这个标志时 AE 会
                    // 在参数名左侧画出**关键帧秒表**（用户实测报"为啥有个秒表"）。
                    // 语义见 AE_Effect.h:396-398「no keyframe controller will appear」。
                    char nameAcp[32];   // 参数名 ACP 缓冲：不可表示时回退 en-US（见 acpName.h）
                    copyParamNameAcp(S_EFFECTHOST_PLUGIN_PARAM_SOLVE_BUTTON,
                                     nameAcp, sizeof(nameAcp));
                    PF_ADD_ARBITRARY2(nameAcp,
                                      host::kSlotUiWidth, host::kSolveBtnH,
                                      PF_ParamFlag_SKIP_REVEAL_WHEN_UNHIDDEN |
                                      PF_ParamFlag_CANNOT_TIME_VARY,
                                      PF_PUI_CONTROL | PF_PUI_DONT_ERASE_CONTROL,
                                      btnDflt, host::kSolveBtnUiId, host::kSolveBtnRefcon);
                    return PF_Err_NONE;
                };
                err = addSolveBtn();
                logCmd("ps-solve-btn-add", (int)err);
                if (err != PF_Err_NONE) {
                    PF_DISPOSE_HANDLE(btnDflt);
                    return err;
                }
            }

            // —— 「实例身份」不在参数表里 ——
            // 曾在此注册隐藏 FLOAT_SLIDER 身份参数（disk 213）。真机复验证伪
            // 其前提「PARAMS_SETUP 每实例执行一次」：**每 AE 会话只发一次**（同一会话
            // 两次 addProperty 只有一行 params-setup-done），新实例参数初值一律取注册期
            // dephault（AE_Effect.h:416-423 明文）→ 参数路给不出每实例不同初值。
            // 身份现在走序列数据：SEQUENCE_SETUP 每实例铸号、FLATTEN/RESETUP 随渲染
            // 工程拷贝接力——见 seqIdentity.h（全部真机证据）与下方 SEQUENCE_* 分支。

            // 注册自定义 UI 事件（ECW 的 DRAW/DO_CLICK/DRAG/ADJUST_CURSOR 才会派发）
            {
                PF_CustomUIInfo ci;
                AEFX_CLR_STRUCT(ci);
                ci.events = PF_CustomEFlag_EFFECT;
                err = (*(in_data->inter.register_ui))(in_data->effect_ref, &ci);
                logCmd("ps-register-ui", (int)err);
                if (err != PF_Err_NONE) return err;
            }

            out_data->num_params = host::kNumParams;
            logCmd("params-setup-done", out_data->num_params);
            break;
        }
        case PF_Cmd_UPDATE_PARAMS_UI:
            logCmd("ui-enter", cmd);   // 传真实 cmd：ECW 打开/时间变化时逐帧触发，走高频节流
            // 不再把选择器值同步到全局（无全局镜像）；SyncParamUI 直接按本实例
            // 选中索引（kIdxFileIndexParam）取该文件的 uniform 列表同步槽位
            // 应用文件选择器待定的高度变更（展开/折叠/刷新后行数变化）
            err = host::SyncFileSelectorUI(in_data, out_data, params);
            // 应用画布高度变更（短内容收缩到内容行数；注册高度是 15 行上限）
            err = host::SyncCanvasUI(in_data, out_data, params);
            // 选中索引已是单一真相源（kIdxFileIndexParam）——无需双向对账，
            // SyncParamUI 直接按 instanceFileIndex 取该文件的 uniform 列表
            // 例外：索引若由脚本/表达式/工程恢复写入（非点击路径），需在此补上
            // 点击路径的「让渲染更新」动作（见 reconcileFileIndexChange 注释）
            reconcileFileIndexChange(in_data, out_data, params);
            err = SyncParamUI(in_data, out_data, params);
            // 中键滚轮消费兜底：钩子队列的 pending 在 ECW 不重绘（InvalidateRect
            // 主框架实测不触发 ECW 的 DRAW 派发）时由 UPDATE_PARAMS_UI 消费——
            // 它在 ECW 打开期间持续到达（时间变化/参数变化逐帧触发），是滚轮
            // 后唯一可靠的本实例事件上下文
            err = host::selWheelConsume(in_data, out_data, params);
            host::rfLog("ui-done", (int)err);
            break;
        case PF_Cmd_USER_CHANGED_PARAM: {
            // 索引参数（kIdxFileIndexParam）已挂 PF_ParamFlag_SUPERVISE：本分支即
            //「GLSL 文件参数改变 → 自动取新文件默认值并应用」的**合法落地阶段**
            //（写参数值见 AE_Effect.h:2250，置 FORCE_RERENDER 见 :886），
            // 不需要用户点击、不需要外部工具、也不会出现「画面是 A 而控件数字是 B」的偏移。
            // 诊断（zzdiag-）：无论是否派发本命令、派发的是哪个参数都留一行——这是判定
            // SDK 标志表（:413「参数变化即派发」）与命令表（:1089「用户操作标准控件时派发」）
            // 两种口径孰对孰错的唯一取证通道（脚本写索引后 trace 里是否出现 zzdiag-ucp）。
            PF_UserChangedParamExtra* ucpExtra =
                reinterpret_cast<PF_UserChangedParamExtra*>(extra);
            const int changedIdx = ucpExtra ? static_cast<int>(ucpExtra->param_index) : -1;
            {
                char zb[64];
                std::snprintf(zb, sizeof(zb), "zzdiag-ucp idx=%d\n", changedIdx);
                host::diagLine(zb);
            }
            if (changedIdx == host::kIdxFileIndexParam) {
                // —— 身份捕获（索引位移修复的核心）——
                // 本阶段是"索引刚被改写"的合法写值窗口（用户点击与脚本写入都会到这里，
                // 实测见上方注释），此刻用**当前列表**把索引解析成文件名写进选择器的
                // ARBITRARY_DATA。此后库增删只改变"名字→位置"的映射，本实例始终指向
                // 同一个文件；名字所指文件被删时按名解析失败 → 渲染走透传，而不会静默
                // 换成另一个 shader（这正是位置型索引的固有危害）。
                if (params && params[host::kIdxFileSelector] && params[host::kIdxFileIndexParam]) {
                    const int selIdx =
                        static_cast<int>(params[host::kIdxFileIndexParam]->u.fs_d.value);
                    const std::string selName = host::shaderNameAtIndex(selIdx);
                    host::WriteFileSelSelection(in_data, params[host::kIdxFileSelector]->u.arb_d.value,
                                                selIdx, selName);
                    // 关键：ARBITRARY 数据的原地写入必须置 CHANGED_VALUE 才被 AE 接受——
                    // 否则 AE 在下一个回调会重新 unflatten 工程里那份旧数据，本次写入
                    // 被静默丢弃（首轮上机实测：捕获跑了但渲染仍按位置走）。
                    // 与点击路径的 finishChange（customUI.cpp:274）同一机制。
                    params[host::kIdxFileSelector]->uu.change_flags |= PF_ChangeFlag_CHANGED_VALUE;
                }
                const int applied = host::ApplySlotDefaultsNow(in_data, out_data, params);
                // 脚本切文件（本分支是脚本/表达式写索引的落地阶段）后
                // 立即落盘新文件的映射——AI 下一步 set_param 就能按索引寻址，不必
                // 等 ECW 打开后的 UPDATE_PARAMS_UI。主线程正常上下文，写失败只记 trace。
                {
                    int resolvedIdx = -1;
                    host::ShaderSnapshot ucpSnap =
                        instanceShaderSnapshot(in_data, params, /*forRender=*/false, &resolvedIdx);
                    if (!ucpSnap.path.empty()) {
                        host::writeParamMapFile(ucpSnap.path, std::string(), resolvedIdx,
                                                ucpSnap.source, ucpSnap.uniforms);
                        if (in_data) {
                            g_paramMapApplied[in_data->effect_ref] =
                                ucpSnap.path + "|" + host::uniformSignature(ucpSnap.uniforms);
                        }
                    }
                }
                // 与 UPDATE_PARAMS_UI 的索引核对基线对齐：本分支已把新索引连同槽位值一起
                // 落地，那边不应再当成「脚本改索引」而重复登记待重置 / 重复 FORCE_RERENDER
                if (in_data && applied >= 0) g_reconciledIdx[in_data->effect_ref] = applied;
                {
                    char zb[64];
                    std::snprintf(zb, sizeof(zb), "zzdiag-ucp-applied idx=%d\n", applied);
                    host::diagLine(zb);
                }
            }
            break;
        }
        case PF_Cmd_SEQUENCE_SETUP:
        case PF_Cmd_SEQUENCE_RESETUP: {
            // 实例身份（载体见 seqIdentity.h）。语义：
            //   · SETUP —— 每次「效果被应用到图层」都发（真机日志每实例一条）→
            //     新实例在此铸非零 id；
            //   · RESETUP —— 数据回灌（工程装载 / 渲染工程拷贝 / duplicate）→
            //     有数据就**沿用其中的 id**（谱系接力不失效）。
            // **RESETUP 绝不重铸**：同一实例的渲染克隆各铸一号 = 谱系碎裂
            //（帧缓存永不命中、结算器跨帧状态丢失），比「两实例合流」严重得多。
            // 数据缺失/不可用（渲染专用工程等退化情形）→ id=0（身份未知 → 调用方
            // 按旧行为共享谱系），同样不铸号。
            if (!out_data) return PF_Err_INTERNAL_STRUCT_DAMAGED;
            const bool isSetup = (cmd == PF_Cmd_SEQUENCE_SETUP);
            uint64_t id = 0;
            bool hasData = false;
            if (in_data && in_data->sequence_data) {
                // DH(h) = *(h)：序列数据句柄由宿主**自动加锁**（AE_Effect.h:2713-2720
                // 「always locked for you before your plugin is called」）——SDK 样本
                // （PathMaster/Gamma_Table）同款直取，不再自行 lock/unlock（自行解锁
                // 会把宿主的锁计数提前放掉）。
                const void* bytes = DH(in_data->sequence_data);
                if (bytes) hasData = host::seqIdentityReadId(bytes, sizeof(host::AsSeqIdentity), &id);
            }
            if (hasData && !isSetup) {
                // 数据有效（含 id=0 的占位）→ 原样沿用：AE 视 in_data 句柄为本实例
                // 现役数据（SDK Gamma_Table 样本的 RESETUP 非空即 no-op，同款）。
                logCmd("seq-resetup-keep", (int)(id & 0xFFFFFFFF));
                break;
            }
            if (isSetup && (!hasData || id == 0)) id = freshInstanceId();   // 新实例铸号
            if (out_data && out_data->sequence_data) PF_DISPOSE_HANDLE(out_data->sequence_data);
            out_data->sequence_data = PF_NEW_HANDLE(sizeof(host::AsSeqIdentity));
            if (!out_data->sequence_data) return PF_Err_INTERNAL_STRUCT_DAMAGED;
            {
                host::AsSeqIdentity* p =
                    static_cast<host::AsSeqIdentity*>(PF_LOCK_HANDLE(out_data->sequence_data));
                if (p) {
                    host::seqIdentityInit(p, id, 0);
                    PF_UNLOCK_HANDLE(out_data->sequence_data);
                }
            }
            logCmd(isSetup ? "seq-setup-new" : "seq-resetup-new", (int)(id & 0xFFFFFFFF));
            break;
        }
        case PF_Cmd_SEQUENCE_FLATTEN:
            // 本效果是 POD 序列数据（内部无指针悬挂）→ 无需
            // PF_OutFlag_SEQUENCE_DATA_NEEDS_FLATTENING；AE 在渲染工程拷贝时仍会
            // 发本命令（真机日志可见），对 POD 是无副作用的通知——不改所有权、
            // 不换句柄，原样放行（SDK Gamma_Table 样本根本没有本分支，同理）。
            break;
        case PF_Cmd_SEQUENCE_SETDOWN:
            // 效果从图层移除（实例销毁）——清理该实例的 UI 会话状态
            // （编辑框归属/挂起的延迟合成点击/条目），防悬空条目被 250ms 后注入的
            // 合成点击误操作 ECW 重排后的其他实例（详见 customUI.cpp ShutdownInstanceUI）
            logCmd("seq-setdown", cmd);
            err = host::ShutdownInstanceUI(in_data);
            // 索引核对基线随实例销毁清除（effect_ref 键控；防地址被新实例复用时
            // 误读旧索引 → 新实例首帧被当成「切文件」多触发一次 FORCE_RERENDER）
            if (in_data) g_reconciledIdx.erase(in_data->effect_ref);
            // 映射图层行的已应用声明位基线同款清除（防地址复用误判 → 图层行显隐不再更新）
            if (in_data) g_layerAppliedBits.erase(in_data->effect_ref);
            // param-map 已写基线同款清除（防地址复用后新实例被误判"已写过"）
            if (in_data) g_paramMapApplied.erase(in_data->effect_ref);
            // 时变掩码/通道身份载体同款清除（renderer.cpp s_maskCarriers，
            // effect_ref 键控）——防地址被新实例复用时继承旧实例的 sticky 时变位/
            // 输入图层身份，按旧掩码构造指纹。只清载体这一张 per-instance 表，
            // 不动 sticky 语义，也不动键控的谱系帧缓存（见下）。
            if (in_data) host::forgetInstanceMaskCarrier(in_data->effect_ref);
            // 结算器帧缓存**不**在此清理：缓存按谱系键控
            //（图层身份 ⊕ 参数指纹，见 renderer.cpp SolverKey），实例销毁不动谱系
            // 表——AE 拖时间线时成批克隆短命渲染实例，随实例清缓存等于回拖必重解。
            // 删图层的谱系由全局 LRU 过期；顺带消灭了在此等解算临界区导致的
            // "删图层时 AE 卡住"。
            //
            // 序列数据（实例身份，见 seqIdentity.h）：AE 13.5+ 起**由效果自己
            // 在 SETDOWN 释放**（AE_Effect.h:1046-1050：这是唯一释放点，AE 也可能
            // 绕过它）——不释放就是每删一个实例漏一个句柄。
            if (in_data && in_data->sequence_data) {
                PF_DISPOSE_HANDLE(in_data->sequence_data);
                if (out_data) out_data->sequence_data = nullptr;
            }
            break;
        case PF_Cmd_RENDER:
            err = Render(in_data, out_data, params, output);
            break;
        case PF_Cmd_EVENT: {
            // 诊断：记录事件类型（节流）——定位打开参数列表后的事件风暴
            static int s_evtTypeLogged[PF_Event_NUM_EVENTS + 1] = {0};
            PF_EventExtra* ev = reinterpret_cast<PF_EventExtra*>(extra);
            int et = ev ? static_cast<int>(ev->e_type) : -1;
            if (et >= 0 && et <= PF_Event_NUM_EVENTS && s_evtTypeLogged[et] < 20) {
                ++s_evtTypeLogged[et];
                logCmd((std::string("evt-type") + std::to_string(et)).c_str(), PF_Cmd_EVENT);
            }
            // ECW 自定义 UI 事件（DRAW / DO_CLICK / DRAG / ADJUST_CURSOR / ACTIVATE /
            // DEACTIVATE / CLOSE_CONTEXT / IDLE）：HandleUIEvent 按事件类型分发，各处理器
            // 再按 effect_win.index 认领自绘控件（文件选择器 / 参数画布 / 重算按钮）；
            // 其余参数索引一律返回 NONE 交回 AE 默认处理。
            err = host::HandleUIEvent(in_data, out_data, params, extra);
            break;
        }
        case PF_Cmd_ARBITRARY_CALLBACK:
            // ARBITRARY_DATA 参数（文件选择器 / 参数画布 / 重算按钮）的生命周期回调（持久化/复制等）
            err = HandleArbitrary(in_data, out_data, reinterpret_cast<PF_ArbParamsExtra*>(extra));
            break;
        case PF_Cmd_SMART_PRE_RENDER:
            err = host::smartPreRender(in_data, out_data, params, extra);
            break;
        case PF_Cmd_SMART_RENDER:
            err = host::smartRender(in_data, out_data, params, extra);
            break;
        default:
            break;
        }
    } catch (...) {
        logCmd("catch-exception", (int)cmd);
        err = PF_Err_INTERNAL_STRUCT_DAMAGED;
    }
    logCmd("exit", (int)cmd);
    return err;
}

// —— 渲染：加载效果文件 → 热重载 → 解析 uniform → GL 渲染 ——
// 输入：params[0]->u.ld（PF_LayerDef）；输出：output（PF_LayerDef）
static PF_Err Render(PF_InData* in_data, PF_OutData* out_data,
                     PF_ParamDef* params[], PF_LayerDef* output) {
    (void)out_data;

    // 诊断：回放时是否逐帧重渲染、current_time 是否递增（时间动画依赖）
    // 逐帧诊断统一走 rfLog（节流落盘，见 renderer.cpp 注释）
    thread_local A_long s_renderSeq = 0;
    host::rfLog("render-seq", ++s_renderSeq);
    host::rfLog("cur-time", (long)in_data->current_time);
    host::rfLog("time-scl", (long)in_data->time_scale);

    // 本实例选中文件直接读 params 选择器 handle（AE 已在 PARAMS_SETUP 后恢复了
    // 保存的选择器值；渲染线程只读，不碰 AE 参数内存），取该文件的 per-file 缓存快照
    // （含 FileWatcher 热重载检测）——多实例交替渲染互不覆盖
    // forRender=true——渲染路径才有权消费 renderConsumePending 补确认
    //（「重载成功即清 error.log」在本回调执行，UI 调用方吃掉标记即漏执行）
    int selIdx = 0;
    host::ShaderSnapshot snap = instanceShaderSnapshot(in_data, params, /*forRender=*/true, &selIdx);
    bool reloaded = snap.reloaded;
    // [临时诊断] Render 侧取文件取证：params[] 读到的索引 / 解析出的文件路径 /
    // 源码长度 / uniform 数（见 rfDiag）
    {
        char d[640];
        std::snprintf(d, sizeof(d), "diag-render idx=%d unis=%u srclen=%u path=%s",
                      selIdx, static_cast<unsigned>(snap.uniforms.size()),
                      static_cast<unsigned>(snap.source.size()), snap.path.c_str());
        host::rfDiag(d);
    }
    // 画布高度下发在 UPDATE_PARAMS_UI（主线程）与 DRAW 入口的自修；渲染线程不得
    // 调用该套件（仅限主线程 UI 上下文，SDK 约定）。
    // 尚无效果文件：透传输入（文件被删除/清空时保留上次成功源码回退渲染）
    if (snap.source.empty()) { host::rfLog("pass-through", 0); return PassThrough(params, output); }
    const std::string& effectSourceCopy = snap.source;
    const std::vector<glsl::Param>& uniformsCopy = snap.uniforms;

    char errBuf[1024] = {0};
    // 诊断：记录输入/输出像素格式 + 输入是否有效 + 当前线程 GL 上下文
    // （gl-ctx=0 说明该线程未绑定 GL 上下文，渲染会静默失效产生黑帧）
    PF_LayerDef* src = &params[0]->u.ld;
    host::rfLog("in-null", (src && src->data) ? 1 : 0);
    host::rfLog("gl-ctx", (long)(intptr_t)wglGetCurrentContext());
    host::rfLog("src-bpp", (long)(src && src->rowbytes && src->width ? src->rowbytes / src->width : 0));
    host::rfLog("out-bpp", (long)(output && output->rowbytes && output->width ? output->rowbytes / output->width : 0));
    host::rfLog("wh", (long)((src ? src->width : 0) * 10000 + (src ? src->height : 0)));
    // 槽位值：Render 回调中 params 数组有效，直接读取（SmartRender 路径用 checkout 检出）。
    // 每槽 4 分量各为 1 个 PF_FloatSliderDef（分量 c → 5+4i+c）。
    // 都是 AE 原生参数，由 AE 保证访问时序，无需 ARBITRARY 句柄式的 4×4B 原子读。
    std::vector<float> userValues;
    userValues.resize(uniformsCopy.size() * host::kFloatsPerSlot, 0.0f);
    for (size_t i = 0; i < uniformsCopy.size(); ++i) {
        float* dst = &userValues[i * host::kFloatsPerSlot];
        for (int c = 0; c < host::kFloatsPerSlot; ++c) {
            const int pidx = host::slotCompIndex(static_cast<int>(i), c);
            if (pidx >= 0 && params[pidx]) {
                dst[c] = static_cast<float>(params[pidx]->u.fs_d.value);
            }
        }
    }
    // 一次性诊断（zzdiag-）：本次渲染用的索引/源指纹/前 8 槽分量0 值（Render 路径）
    host::diagState("zzdiag-render", InstanceFileIndex(in_data, params),
                    host::srcHash32(effectSourceCopy.c_str(), effectSourceCopy.size()),
                    static_cast<int>(effectSourceCopy.size()),
                    userValues.data(), static_cast<int>(uniformsCopy.size()), host::kFloatsPerSlot);
    // 映射图层 checkout：仅检出 snap.channelsUsed 声明的
    // channel；守卫析构时 CHECKIN（覆盖 renderFrame 抛异常等所有退出路径）。
    host::MapLayerCheckout mapCheckout;
    mapCheckout.checkout(in_data, snap.channelsUsed);
    // I2a 输入历史（@history N）——legacy PF_Cmd_RENDER 路径专用：PF_CHECKOUT_PARAM
    // 检出 param 0 得到的是未加工的源图层（不含前序效果）。AE 走 SmartFX，
    // 历史帧由 smartPreRender 的 checkout_layer 检出（见 smartRender.cpp）。
    host::HistoryCheckout histCheckout;
    histCheckout.checkout(in_data, snap.iterCfg.historyFrames);
    // 相机/3D 变换查询（渲染回调内合法窗口；AEGP 不可用时内部静默降级单位阵）
    // 「启用三维摄像机」复选框（kIdxCamEnable，默认勾选）关闭时跳过 AEGP 查询，
    // 传 null → renderFrame 注入无相机默认值（uHasCam=0 + 单位阵；面板预览另有自己的
    // 可操控虚拟相机 uHasCam=1，此处只对齐「无相机合成」语义）。
    const bool camEnabled =
        params && params[host::kIdxCamEnable] && params[host::kIdxCamEnable]->u.bd.value;
    host::CameraUniforms cam;
    if (camEnabled) cam = host::queryCameraUniforms(in_data);
    host::rfLog("cam-enabled", camEnabled ? 1 : 0);   // 诊断：与 SmartRender 路径对称
    // 灯光/合成联动查询（渲染回调内合法窗口；AEGP 不可用时内部静默降级全零）
    // 「启用三维灯光」复选框（kIdxLightEnable，默认勾选）关闭时跳过枚举，
    // 传 null → renderFrame 注入无灯默认值（hasLights=0/count=0/数组全零）。
    const bool lightEnabled =
        params && params[host::kIdxLightEnable] && params[host::kIdxLightEnable]->u.bd.value;
    host::LightUniforms lights;
    if (lightEnabled) lights = host::queryLightUniforms(in_data);
    host::rfLog("light-enabled", lightEnabled ? 1 : 0);
    // 「重算代数」（手动重算的缓存失效载体）：Render 回调里 params 有效，直接读。
    const double solveGen = (params && params[host::kIdxSolveGen])
                          ? static_cast<double>(params[host::kIdxSolveGen]->u.fs_d.value) : 0.0;
    // 「实例身份」：真相源＝序列数据（SEQUENCE_SETUP 每实例铸号，FLATTEN/
    // RESETUP 随渲染工程拷贝接力；见 seqIdentity.h）。取不到返回 0 = 旧行为。
    const uint64_t instanceId = host::InstanceInstanceId(in_data);
    PF_Err e = host::renderFrame(in_data, out_data, src, output,
                                 effectSourceCopy.c_str(), &uniformsCopy,
                                 errBuf, sizeof(errBuf),
                                 userValues.empty() ? nullptr : userValues.data(),
                                 mapCheckout.mapLayers(), camEnabled ? &cam : nullptr,
                                 lightEnabled ? &lights : nullptr,
            histCheckout.layers(), histCheckout.count(), solveGen, instanceId);
    host::rfLog("render-err", (long)e);
    if (errBuf[0]) host::rfLog("render-msg", (unsigned char)errBuf[0]);
    // Task 7 错误容错：编译/渲染错误写入 error.log（面板同目录读取）；
    // 重载成功（无错误）则清空，让面板读到"已恢复"。
    // 去重：同一条错误只在首次出现时追加，避免播放时每帧刷屏。
    // thread_local：MFR 各线程独立去重。
    // 去重叠加代际校验——error.log 是目录级共享文件，任一实例重载
    // 成功 clearErrorLog 会清空全文件；其他持续失败实例的 s_lastError 仍等于
    // 自身 errBuf，纯内容去重会跳过 append，其错误从 error.log 永久消失
    //（诊断链断裂）。代际计数由 clearErrorLog 递增，检出变化即强制重写。
    thread_local std::string s_lastError;
    thread_local uint64_t s_lastErrGen = host::errorLogGeneration();
    if (errBuf[0]) {
        if (errBuf != s_lastError || s_lastErrGen != host::errorLogGeneration()) {
            host::appendErrorLog(effectsDir(), errBuf);
            s_lastError = errBuf;
            s_lastErrGen = host::errorLogGeneration();
        }
    } else if (reloaded) {
        std::string dir = effectsDir();
        if (!dir.empty()) {
            host::clearErrorLog(dir);
            // 解析告警回写（vec 数组不支持等）：不构成渲染失败，但需面板可见，
            // 须在 clearErrorLog 之后写入，否则会被"重载成功即清"冲掉
            // （与 smartRender.cpp 的错误日志段一致；快照已含 parseWarning，无需再锁）
            if (!snap.parseWarning.empty()) host::appendErrorLog(dir, snap.parseWarning);
        }
        s_lastError.clear();
    }
    // 诊断：采样输出首像素与中心像素（验证是否真的写入了数据）
    // 0×0 退化输出（width/height 为 0，data 缓冲零长度）下 d[0..2]
    // 与 d[mid+0..2] 是 3 字节越界读——采样前判空
    if (output && output->data && output->width > 0 && output->height > 0) {
        const unsigned char* d = reinterpret_cast<const unsigned char*>(output->data);
        host::rfLog("px0", (long)d[0] * 1000000 + (long)d[1] * 1000 + (long)d[2]);
        A_long mid = (output->height / 2) * output->rowbytes + (output->width / 2) * 4;
        host::rfLog("pxmid", (long)d[mid + 0] * 1000000 + (long)d[mid + 1] * 1000 + (long)d[mid + 2]);
    }
    return e;
}

// —— ARBITRARY DATA 回调（PF_Cmd_ARBITRARY_CALLBACK）——
// 文件选择器与参数画布两个 ARBITRARY_DATA 参数共用本回调。句柄是 v2 定长布局
// （魔数 8 + 4×float + 名字长度 2 + 名字 256 = 282B，见 fileSelLayout.h）：
// v[0] = 位置索引、v[1]/v[2] = 展开/滚动、name = 身份名；画布的句柄只作占位（全零）。
static PF_Err HandleArbitrary(PF_InData* in_data, PF_OutData* out_data, PF_ArbParamsExtra* extra) {
    if (!extra) return PF_Err_NONE;
    PF_Err err = PF_Err_NONE;
    const float kZero4[4] = {0.0f, 0.0f, 0.0f, 0.0f};
    // v2 定长（含身份名，见 fileSelLayout.h）。整块 memcpy 即正确：所有 handle
    // 都经 AllocFileSelHandle 按同一 sizeof 分配，UNFLATTEN 会把 v1 升级成 v2。
    constexpr size_t kBytes = sizeof(host::FileSelHandle);
    switch (extra->which_function) {
    case PF_Arbitrary_NEW_FUNC:
        err = host::AllocFileSelHandle(in_data, out_data, kZero4, extra->u.new_func_params.arbPH);
        break;
    case PF_Arbitrary_DISPOSE_FUNC:
        if (extra->u.dispose_func_params.arbH) PF_DISPOSE_HANDLE(extra->u.dispose_func_params.arbH);
        break;
    case PF_Arbitrary_COPY_FUNC: {
        PF_ArbitraryH dst = nullptr;
        err = host::AllocFileSelHandle(in_data, out_data, kZero4, &dst);
        if (!err && dst && extra->u.copy_func_params.src_arbH) {
            float* d = reinterpret_cast<float*>(PF_LOCK_HANDLE(dst));
            const float* s = reinterpret_cast<const float*>(PF_LOCK_HANDLE(extra->u.copy_func_params.src_arbH));
            if (d && s) std::memcpy(d, s, kBytes);
            if (s) PF_UNLOCK_HANDLE(extra->u.copy_func_params.src_arbH);
            if (d) PF_UNLOCK_HANDLE(dst);
        }
        if (!err) *(extra->u.copy_func_params.dst_arbPH) = dst;
        break;
    }
    case PF_Arbitrary_FLAT_SIZE_FUNC:
        *(extra->u.flat_size_func_params.flat_data_sizePLu) = static_cast<A_u_long>(kBytes);
        break;
    case PF_Arbitrary_FLATTEN_FUNC:
        if (extra->u.flatten_func_params.buf_sizeLu >= static_cast<A_u_long>(kBytes)
            && extra->u.flatten_func_params.arbH && extra->u.flatten_func_params.flat_dataPV) {
            const float* s = reinterpret_cast<const float*>(PF_LOCK_HANDLE(extra->u.flatten_func_params.arbH));
            if (s) {
                std::memcpy(extra->u.flatten_func_params.flat_dataPV, s, kBytes);
                PF_UNLOCK_HANDLE(extra->u.flatten_func_params.arbH);
            }
        }
        break;
    case PF_Arbitrary_UNFLATTEN_FUNC: {
        PF_ArbitraryH h = nullptr;
        err = host::AllocFileSelHandle(in_data, out_data, kZero4, &h);
        if (!err && h && extra->u.unflatten_func_params.flat_dataPV) {
            // v1(16B) → 升级为 v2：只保留位置索引、身份为空，旧工程行为不变；
            // 首次改索引时由 UCP/点击捕获身份，之后库增删不再影响本实例。
            // 长度异常/魔数不符 → fileSelDeserialize 返回全零 handle（不把垃圾当名字）。
            host::FileSelHandle up;
            host::fileSelDeserialize(extra->u.unflatten_func_params.flat_dataPV,
                               static_cast<size_t>(extra->u.unflatten_func_params.buf_sizeLu), up);
            host::FileSelHandle* d = reinterpret_cast<host::FileSelHandle*>(PF_LOCK_HANDLE(h));
            if (d) {
                std::memcpy(d, &up, sizeof(host::FileSelHandle));
                PF_UNLOCK_HANDLE(h);
            }
        }
        if (!err) *(extra->u.unflatten_func_params.arbPH) = h;
        break;
    }
    case PF_Arbitrary_COMPARE_FUNC: {
        *(extra->u.compare_func_params.compareP) = PF_ArbCompare_EQUAL;
        if (extra->u.compare_func_params.a_arbH && extra->u.compare_func_params.b_arbH) {
            const void* a = PF_LOCK_HANDLE(extra->u.compare_func_params.a_arbH);
            const void* b = PF_LOCK_HANDLE(extra->u.compare_func_params.b_arbH);
            // 按 fileSelEqual 比较——**排除 v[3] seqlock 版本号**。
            // 整块 memcmp 把版本号算进内容：每次改选（WriteFileSelSelection 让
            // 版本 ±2）后，哪怕内容与另一句柄逐字节相同也会报 NOT_EQUAL，AE 据此做多余
            // 的"参数已变化"处理（无功能损失，纯噪声）。语义内容其余字节照旧全比。
            if (a && b && !host::fileSelEqual(*reinterpret_cast<const host::FileSelHandle*>(a),
                                              *reinterpret_cast<const host::FileSelHandle*>(b))) {
                *(extra->u.compare_func_params.compareP) = PF_ArbCompare_NOT_EQUAL;
            }
            if (a) PF_UNLOCK_HANDLE(extra->u.compare_func_params.a_arbH);
            if (b) PF_UNLOCK_HANDLE(extra->u.compare_func_params.b_arbH);
        }
        break;
    }
    case PF_Arbitrary_PRINT_SIZE_FUNC:
        *(extra->u.print_size_func_params.print_sizePLu) = 32;
        break;
    case PF_Arbitrary_PRINT_FUNC: {
        char* buf = extra->u.print_func_params.print_bufferPC;
        const A_u_long sizeLu = extra->u.print_func_params.print_sizeLu;
        if (buf && sizeLu > 0) {
            const float* s = extra->u.print_func_params.arbH
                ? reinterpret_cast<const float*>(PF_LOCK_HANDLE(extra->u.print_func_params.arbH)) : nullptr;
            if (s) {
                std::snprintf(buf, sizeLu, "%g", static_cast<double>(s[0]));
                PF_UNLOCK_HANDLE(extra->u.print_func_params.arbH);
            } else {
                buf[0] = 0;
            }
        }
        break;
    }
    default:
        break;
    }
    return err;
}

// —— 插件注册入口（新版 entry 机制 v2）——
extern "C" DllExport PF_Err PluginDataEntryFunction2(
    PF_PluginDataPtr inPtr,
    PF_PluginDataCB2 inPluginDataCallBackPtr,
    SPBasicSuite* inSPBasicSuitePtr,
    const char* inHostName,
    const char* inHostVersion) {
    (void)inSPBasicSuitePtr; (void)inHostName; (void)inHostVersion;
    PF_Err result = PF_Err_INVALID_CALLBACK;
    result = PF_REGISTER_EFFECT_EXT2(
        inPtr, inPluginDataCallBackPtr,
        "AS_Effect Host",           // Name
        "AS_Effect_Host",           // Match Name
        "AS_ExtP",                  // Category
        AE_RESERVED_INFO,           // Reserved Info
        "EffectMain",               // Entry point
        "https://www.adobe.com");   // Support URL
    return result;
}
