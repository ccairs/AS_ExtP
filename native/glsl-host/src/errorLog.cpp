#include "errorLog.h"
#include "effectState.h"
#include "glslLoader.h"
#include <atomic>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <iterator>
#include <windows.h>

namespace host {

// clearErrorLog 每次清空递增——渲染路径的去重 thread_local 检出
// 代际变化即重置自身强制重写（error.log 为目录级共享文件，任一实例的
// 「重载成功即清」不得吞掉其他实例的持续错误）
static std::atomic<uint64_t> s_errorLogGeneration{0};

// error.log 全部落盘点统一经此互斥串行——appendErrorLog 的轮转是
// 读-改-写（读旧文件尾部 → trunc 重写 → 追加），与并发线程的 append/clear
// 交错会互相覆盖/损坏（多实例渲染线程 + UI 线程 + resolveDataRoot 告警五处
// 调用点全走这两个函数）。锁内只做文件 I/O 不做多余事。SRWLOCK 而非
// std::mutex：DLL 环境的 CRT ABI 纪律（见 effectState.h 注释）。锁序单向
//（gs.mutex → 此锁，errorLog 内不回调 effectState），无死锁环
static SRWLOCK s_logMutex = SRWLOCK_INIT;

// 诊断日志（as_effect_host.log）追加互斥（见 errorLog.h 注释）——
// 与上方 error.log 的 s_logMutex 相互独立（不同文件、互不嵌套，无锁序环）
static SRWLOCK s_diagAppendMutex = SRWLOCK_INIT;

void lockDiagAppend() { AcquireSRWLockExclusive(&s_diagAppendMutex); }
void unlockDiagAppend() { ReleaseSRWLockExclusive(&s_diagAppendMutex); }

// —— Win32 直写探针（见 errorLog.h 注释）——
// CreateFileW+WriteFile+CloseHandle 全 Win32 无 CRT stdio 依赖；FILE_APPEND_DATA
// 单次 WriteFile 内核原子追加（多线程交错不产生行内撕裂）。路径一律 UTF-8 入参
// → utf8ToWide → 宽 API（窄 CreateFileA 在含中文的数据目录下静默失败，
// 诊断日志整段丢失；轮转段早已是宽路径范本）。
// —— 诊断文件「超限保留尾部」轮转（契约见 errorLog.h）——
// 独立轻量锁：与 s_logMutex（error.log）/ s_diagAppendMutex（追加段）均不嵌套，
// 无锁序环。锁内只做文件 I/O。宽路径：UTF-8 入参经 utf8ToWide——窄路径在含中文的
// TEMP/数据目录下 GetFileAttributesExA 会直接查不到（旧 maybeTruncateLog 同款隐患）。
static SRWLOCK s_rotateLock = SRWLOCK_INIT;

bool logFileExceeds(const std::string& utf8Path, unsigned long long maxBytes) {
    if (utf8Path.empty()) return false;
    const std::wstring wpath = glsl::utf8ToWide(utf8Path);
    if (wpath.empty()) return false;
    WIN32_FILE_ATTRIBUTE_DATA fd;
    if (!GetFileAttributesExW(wpath.c_str(), GetFileExInfoStandard, &fd)) return false;
    const unsigned long long sz =
        (static_cast<unsigned long long>(fd.nFileSizeHigh) << 32) | fd.nFileSizeLow;
    return sz > maxBytes;
}

bool rotateLogFileKeepTail(const std::string& utf8Path,
                           unsigned long long maxBytes, unsigned long long keepBytes) {
    if (utf8Path.empty() || keepBytes == 0 || maxBytes <= keepBytes) return false;
    if (!logFileExceeds(utf8Path, maxBytes)) return false;   // 无锁快速路径：绝大多数写都不超限
    const std::wstring wpath = glsl::utf8ToWide(utf8Path);
    if (wpath.empty()) return false;
    AcquireSRWLockExclusive(&s_rotateLock);
    bool rotated = false;
    HANDLE hr = CreateFileW(wpath.c_str(), GENERIC_READ,
                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hr != INVALID_HANDLE_VALUE) {
        std::string tail;
        tail.resize(static_cast<size_t>(keepBytes));
        LARGE_INTEGER off;
        off.QuadPart = -static_cast<LONGLONG>(keepBytes);
        DWORD got = 0;
        if (SetFilePointerEx(hr, off, nullptr, FILE_END)
            && ReadFile(hr, &tail[0], static_cast<DWORD>(keepBytes), &got, nullptr) && got > 0) {
            tail.resize(got);
            // 尾部首行大概率是被截半的行：从第一个换行之后开始保留
            const size_t nl = tail.find('\n');
            if (nl != std::string::npos && nl + 1 < tail.size()) tail.erase(0, nl + 1);
            // CREATE_ALWAYS 截断重写：写入方若持有 FILE_APPEND_DATA 句柄（崩溃日志
            // 预开句柄同款），截断后其追加位置自动落到新 EOF，无需关-删-重开
            HANDLE hw = CreateFileW(wpath.c_str(), GENERIC_WRITE,
                                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                    nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (hw != INVALID_HANDLE_VALUE) {
                DWORD wrote = 0;
                WriteFile(hw, tail.data(), static_cast<DWORD>(tail.size()), &wrote, nullptr);
                CloseHandle(hw);
                rotated = true;
            }
        }
        CloseHandle(hr);
    }
    ReleaseSRWLockExclusive(&s_rotateLock);
    return rotated;
}

// 探针日志（trace）体积上限：每 64 次写采样查一次，否则零上限且无任何清理
// 路径，实测 ~39KB/小时（一次 8000x5000 预览渲染 +~140B），长期挂机无限增长
static constexpr unsigned long long kTraceMaxBytes  = 4ull * 1024 * 1024;
static constexpr unsigned long long kTraceKeepBytes = 512ull * 1024;

// 行时间戳（见 errorLog.h 说明）。cap 不足 21 时写空串而非截断——宁可无戳，
// 也不要输出半截日期让排查时误读。
void isoLocalStamp(char* buf, size_t cap) {
    if (!buf || cap == 0) return;
    if (cap < 21) { buf[0] = '\0'; return; }
    SYSTEMTIME st;
    GetLocalTime(&st);
    std::snprintf(buf, cap, "%04d-%02d-%02dT%02d:%02d:%02d ",
                  st.wYear, st.wMonth, st.wDay,
                  st.wHour, st.wMinute, st.wSecond);
}

namespace {
// 目录确保（每个目录只做一次）：日志写入方（logCmd/rfLog/srLog/camLog/ltLog）
// 在渲染期高频调用，不能每行落一次文件系统探测。SRWLOCK 串行化 s_doneDir 的
// 读写——MFR 下多渲染线程可能同时首次进入，std::string 并发读写是 UB，
// 不能用无锁标记（本文件其余锁的纪律见文件头注释）。
void ensureDirOnceW(const std::string& dir) {
    static SRWLOCK s_dirLock = SRWLOCK_INIT;
    static std::string s_doneDir;
    AcquireSRWLockShared(&s_dirLock);
    const bool done = (s_doneDir == dir);
    ReleaseSRWLockShared(&s_dirLock);
    if (done) return;
    AcquireSRWLockExclusive(&s_dirLock);
    if (s_doneDir != dir) {
        const std::wstring wdir = glsl::utf8ToWide(dir);
        if (!wdir.empty()) {
            std::error_code ec;
            std::filesystem::create_directories(std::filesystem::path(wdir), ec);
        }
        s_doneDir = dir;   // 建目录失败也记账：不给每一行日志都重试一次失败调用
    }
    ReleaseSRWLockExclusive(&s_dirLock);
}
} // namespace

std::string diagLogFilePath(const char* name) {
    if (!name || !*name) return "";
    const std::string root = dataRootDirPath();
    if (root.empty()) return "";
    const std::string dir = root + "\\temp\\logs";
    ensureDirOnceW(dir);
    return dir + "\\" + name;
}

// 诊断直写唯一实现（宽路径）——实现与错误码语义见 errorLog.h 声明处。
bool appendDiagLineAt(const std::string& utf8Path, const char* utf8Line, size_t len,
                      unsigned long* lastError) {
    if (lastError) *lastError = 0;
    if (utf8Path.empty() || (!utf8Line && len != 0)) return false;
    const std::wstring wpath = glsl::utf8ToWide(utf8Path);
    if (wpath.empty()) {   // 非法 UTF-8 路径（utf8ToWide 挂 MB_ERR_INVALID_CHARS）
        if (lastError) *lastError = ERROR_INVALID_NAME;
        return false;
    }
    HANDLE h = CreateFileW(wpath.c_str(), FILE_APPEND_DATA,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
        if (lastError) *lastError = GetLastError();
        return false;
    }
    DWORD wrote = 0;
    const BOOL ok = WriteFile(h, utf8Line, static_cast<DWORD>(len), &wrote, nullptr);
    if (!ok && lastError) *lastError = GetLastError();
    CloseHandle(h);
    return ok == TRUE && wrote == static_cast<DWORD>(len);
}

void rawTraceLine(const char* line) {
    const std::string p = diagLogFilePath("as_effect_host_trace.log");
    if (p.empty() || !line) return;
    static LONG volatile s_n = 0;
    if ((InterlockedIncrement(&s_n) & 63) == 0) {
        rotateLogFileKeepTail(p, kTraceMaxBytes, kTraceKeepBytes);
    }
    // 时间戳在此处统一加（本函数是所有 trace 行的唯一收口点）：调用方传的是裸行
    //（rawTrace 的 "tag value\n"、uiDebug 的 "wheel-…"），加在这里才不会有漏网的。
    char ts[24];
    isoLocalStamp(ts, sizeof(ts));
    std::string out;
    out.reserve(strlen(ts) + strlen(line) + 1);
    out += ts;
    out += line;
    // CreateFileW（appendDiagLineAt），含中文的数据根不再丢日志
    appendDiagLineAt(p, out.data(), out.size(), nullptr);
}
void rawTrace(const char* tag, long v) {
    if (!tag) return;
    char buf[96];
    int n = std::snprintf(buf, sizeof(buf), "%s %ld\n", tag, v);
    if (n > 0) rawTraceLine(buf);
}

// 诊断日志（as_effect_host.log）追加：Win32 直写。契约与动机见 errorLog.h。
bool appendDiagLogLine(const char* body) {
    if (!body || !*body) return false;
    const std::string p = diagLogFilePath("as_effect_host.log");
    if (p.empty()) return false;
    char ts[24];
    isoLocalStamp(ts, sizeof(ts));
    std::string out;
    out.reserve(std::strlen(ts) + std::strlen(body) + 2);
    out += ts;
    out += body;
    out += '\n';
    // 直写统一走宽路径（见 appendDiagLineAt）；失败探针按错误码去重
    //（位图取低 6 位，与 logCmd 的 lc 探针同款纪律）：碰撞只会少记一条，不会
    // 刷屏——诊断路径宁可漏一条也不许刷。
    unsigned long gle = 0;
    if (!appendDiagLineAt(p, out.data(), out.size(), &gle)) {
        static volatile LONG64 s_seen = 0;
        const int slot = static_cast<int>(gle & 63);
        if ((InterlockedOr64(&s_seen, (LONG64)1 << slot) & ((LONG64)1 << slot)) == 0) {
            rawTrace("diag-append-fail", static_cast<long>(gle));
        }
        return false;
    }
    return true;
}

// 日志大小兜底：超限时保留尾部 512KB 重写（对齐 bridge-server.js 侧 error.log 轮转策略），
// 防长期渲染错误刷屏无限追加撑爆磁盘。正常错误日志远小于 1MB，轮转路径不会走到。
static const long long kMaxLogBytes = 1024 * 1024;
static const long long kKeepTailBytes = 512 * 1024;

// dir 为 UTF-8 路径：窄 ofstream/ifstream 按 ANSI(GBK) 解释，含中文的数据目录
// 会打不开（错误日志静默丢失）→ 统一转宽路径
static std::filesystem::path errorLogPath(const std::string& dir) {
    return std::filesystem::path(glsl::utf8ToWide(dir + "/error.log"));
}

void appendErrorLog(const std::string& dir, const std::string& msg) {
    AcquireSRWLockExclusive(&s_logMutex);
    const std::filesystem::path path = errorLogPath(dir);
    {
        std::ifstream f(path, std::ios::binary | std::ios::ate);
        if (f) {
            std::streampos sz = f.tellg();
            if (sz > static_cast<std::streampos>(kMaxLogBytes)) {
                f.seekg(-static_cast<std::streamoff>(kKeepTailBytes), std::ios::end);
                std::string tail((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
                std::ofstream t(path, std::ios::binary | std::ios::trunc);
                if (t) t << "[log rotated: kept last 512KB]\n" << tail;
            }
        }
    }
    std::ofstream f(path, std::ios::app);
    if (f) f << msg << std::endl;
    ReleaseSRWLockExclusive(&s_logMutex);
}
void clearErrorLog(const std::string& dir) {
    AcquireSRWLockExclusive(&s_logMutex);
    std::ofstream f(errorLogPath(dir), std::ios::trunc);
    // 先写后计数：append 侧读到的代际若已递增，文件必然已被本次清空截断
    s_errorLogGeneration.fetch_add(1, std::memory_order_relaxed);
    ReleaseSRWLockExclusive(&s_logMutex);
}
uint64_t errorLogGeneration() {
    return s_errorLogGeneration.load(std::memory_order_relaxed);
}
std::string readErrorLog(const std::string& dir) {
    std::ifstream f(errorLogPath(dir));
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// ── 一次性诊断（脚本切 GLSL 后画面不变）；定位完成后整段删除 ──
unsigned srcHash32(const char* p, size_t n) {
    unsigned h = 2166136261u;   // FNV-1a：用于把"渲染/编译实际使用的源"反查回磁盘文件
    for (size_t i = 0; i < n; ++i) {
        h ^= static_cast<unsigned char>(p[i]);
        h *= 16777619u;
    }
    return h;
}

void diagLine(const char* line) {
    if (!line || !line[0]) return;
    rawTraceLine(line);
}

void diagState(const char* tag, int idx, unsigned srcHash, int srcLen,
               const float* vals, int nSlots, int stride) {
    if (!tag) return;
    char buf[320];
    int off = std::snprintf(buf, sizeof(buf), "%s idx=%d len=%d hash=%08x u=",
                            tag, idx, srcLen, srcHash);
    if (off < 0) return;
    for (int i = 0; i < 8; ++i) {
        if (off >= static_cast<int>(sizeof(buf)) - 24) break;
        long v = -99999;
        if (vals && stride > 0 && i < nSlots) v = static_cast<long>(vals[i * stride] * 10000.0f);
        off += std::snprintf(buf + off, sizeof(buf) - off, "%ld,", v);
        if (off < 0) return;
    }
    if (off < static_cast<int>(sizeof(buf)) - 2) {
        std::snprintf(buf + off, sizeof(buf) - off, "\n");
    }
    // 同状态去重：诊断期状态切换远少于渲染帧数，故只在签名变化时落盘
    static SRWLOCK s_lk = SRWLOCK_INIT;
    static char s_last[sizeof(buf)] = {0};
    AcquireSRWLockExclusive(&s_lk);
    const bool changed = (std::strcmp(buf, s_last) != 0);
    if (changed) {
        std::strncpy(s_last, buf, sizeof(s_last) - 1);
        s_last[sizeof(s_last) - 1] = 0;
    }
    ReleaseSRWLockExclusive(&s_lk);
    if (changed) rawTraceLine(buf);
}
} // namespace host
