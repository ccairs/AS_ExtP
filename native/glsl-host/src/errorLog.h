#pragma once
// errorLog.h —— 纯 C++，与 AE SDK 无关
#include <cstddef>
#include <string>
#include <cstdint>
namespace host {
// 追加写入错误日志文件；失败静默
void appendErrorLog(const std::string& dir, const std::string& msg);
// 清空错误日志文件（重载成功后调用，让面板读到"已恢复"）；失败静默
void clearErrorLog(const std::string& dir);
// 读取错误日志全文（不存在返回空串）
std::string readErrorLog(const std::string& dir);
// 目录级清空的代际计数——append 侧的去重方（各渲染线程的
// thread_local s_lastError）检出代际变化即强制重写，防止「实例 A 重载成功
// 清空全文件后，实例 B 的持续同错误因去重跳过而永久消失」的诊断链断裂
uint64_t errorLogGeneration();

// 诊断日志（as_effect_host.log）追加互斥——logCmd（plugin.cpp）/
// rfLog（renderer.cpp）/ srLog（smartRender.cpp）/ camLog（aeCamera.cpp）/
// ltLog（aeLights.cpp）及 GPU 信息段曾共用 fopen("a")，CRT _O_APPEND 是
// 「写前 seek 到尾」而非 FILE_APPEND_DATA 的内核原子追加语义，多线程并发写
// 互相覆盖偶发丢行。三处追加段统一经此轻量互斥（SRWLOCK，最小方案；
// errorLog.h 是三 TU 共同可见的头）。成对调用，锁内只做追加不做多余事。
// 追加改走 appendDiagLogLine（Win32 直写，内核原子），本互斥保留：
// 一是与轮转段（maybeRotateDiagLog 的删-关-重开）互斥，二是给跨 TU 写入方一致的
// 串行点，锁序纪律不变。
void lockDiagAppend();
void unlockDiagAppend();

// Win32 直写探针：绕开 CRT stdio 写 <数据根>\temp\logs\as_effect_host_trace.log——
// 实测 fopen("a") 追加在 AE 进程运行期静默失败（exit 上下文可写，根因待查），
// 滚轮链路等关键诊断改经此直写。每次独立开关句柄无泄漏；仅诊断用，勿入热路径。
// 体积上限：每次写按 1/64 采样查一次大小，超 4MB 保留尾部 512KB（
// 不设上限则实测 ~39KB/小时且无任何清理路径，长期挂机可无限增长）。
void rawTrace(const char* tag, long v);
void rawTraceLine(const char* line);

// ── 诊断日志（as_effect_host.log）追加：Win32 直写 ──
// 为什么不再用 fopen("a")：本机实测 AE 进程运行期 CRT 追加**静默失败**（errno 13），
// 后果是这个文件恒 0 字节——它本是「效果到底渲染了没有」的第一手证据，形同虚设
//（trace 通道因为是 Win32 直写所以一直正常，两边证据长期不对称）。
// CreateFileA(FILE_APPEND_DATA) + WriteFile：FILE_APPEND_DATA 是**内核原子追加**语义
//（lockDiagAppend 因此从"补 CRT 非原子"退化为纯串行点，保留作轮转互斥）。
// 时间戳与换行由本函数统一补（与 rawTraceLine 同规）：调用方只给裸 body，
// body 内含换行 = 多行块共享一个时间戳（GPU 信息段依赖该语义）。
// 失败：按 GetLastError 去重留一行 rawTrace 探针后返回 false——诊断通道不得反过来
// 影响宿主，也绝不刷屏。
bool appendDiagLogLine(const char* body);

// 诊断日志文件绝对路径：<数据根>\temp\logs\<name>（目录不存在则创建）。
// 日志统一落数据目录，不再写系统临时目录；
// 数据根不可解析 → 返回空串，调用方放弃写盘（不允许回落 %TEMP%）。
std::string diagLogFilePath(const char* name);

// 诊断直写唯一实现（宽路径）——把 utf8Line（len 字节，可含换行）追加到
// UTF-8 路径 utf8Path，返回是否整段写成功。
// 为什么必须是宽路径：数据根默认在 %APPDATA%\Adobe\CEP\extensions\AS_ExtP，中文
// 用户名（或用户自定义的中文目录）下 CreateFileA 按 ANSI 解释 UTF-8 字节 → 打开
// 失败 → 诊断日志整段静默丢失（appendDiagLineAt 是唯一的
// CreateFileA）。utf8ToWide 失败（非法
// UTF-8）同样返回 false。lastError 可选：传出 Win32 错误码（失败探针按码去重），
// 成功时为 0。导出本函数是给测试用非 ASCII 路径直接钉住宽路径行为。
bool appendDiagLineAt(const std::string& utf8Path, const char* utf8Line, size_t len,
                      unsigned long* lastError);

// ── 诊断文件体积上限 ──
// 通用「超限保留尾部」轮转：UTF-8 路径入参（内部转宽路径，含中文的数据目录可用），
// 纯 Win32 无 CRT 流依赖；超限时读尾部 keepBytes 重写整文件（首行可能被截半，
// 从第一个换行后开始保留）。返回是否真的轮转过；任何失败静默返回 false——
// 诊断通道不得反过来影响宿主。
// 为什么保留尾部而不是清空：这些是探针日志，定位只看最近一段，清空会连同
// 故障现场的最后一批证据一起丢掉。
bool rotateLogFileKeepTail(const std::string& utf8Path,
                           unsigned long long maxBytes, unsigned long long keepBytes);

// 文件是否超过 maxBytes（宽路径；不存在/查询失败 → false）。
// ⚠️ 调用方必须用它作前置判定：rotateLogFileKeepTail 的 false 同时表示
// 「未超限」与「轮转失败」两种含义，拿它当"失败"用会在未超限时误触发兜底
// 路径（缺陷：plugin.cpp 的兜底 DeleteFileA 因此
// 每 256 次写就清空一次日志）。需要区分时先 logFileExceeds 再轮转。
bool logFileExceeds(const std::string& utf8Path, unsigned long long maxBytes);

// as_effect_host.log 的体积检查（定义在 plugin.cpp：轮转需与崩溃预开句柄协调）。
// ⚠️ 所有写入方都要调：logCmd（plugin.cpp）/ rfLog（renderer.cpp）/ srLog
//（smartRender.cpp）/ camLog（aeCamera.cpp）/ GPU 信息段（renderer.cpp）。
// 若只有 logCmd 一个调用点，则 logCmd 自身对高频命令有 300 次/进程的节流，
// 叠加「每 256 次写才查一次」→ 一个会话最多查 3 次大小，16MB 上限形同虚设。
void maybeRotateDiagLog();

// ── 行时间戳 ──
// 写入 buf：`YYYY-MM-DDTHH:mm:ss `（含尾随空格，可直接作 %s 前缀），cap 建议 ≥ 24。
// 为什么必须带日期：面板侧「导出诊断日志」会把各进程日志拼成一份包，跨段按时间
// 对齐是定位跨进程问题的前提；而日志**要么完全没有时间戳**
//（rfLog / srLog / logCmd / GPU 信息段 / rawTraceLine 都是裸行），**要么只有时刻**
//（ui_debug / as_hotbox 的 HH:mm:ss），跨天即无法与面板/bridge 的 ISO 行对齐。
void isoLocalStamp(char* buf, size_t cap);

// ── 一次性诊断（脚本切 GLSL 后画面不变）；定位完成后整段删除 ──
// 为什么必须走 rawTraceLine：logCmd/rfLog/srLog 都经 fopen("a")，而该通道在 AE
// 运行期静默失败（见上方注释），主日志拿不到当前实例的任何数据——实测当前实例
// 一条未写、文件 mtime 停在上一次 AE 启动前。
// diagState 带同状态去重：只有"签名变化"才落一行，故无需节流也不会刷屏；
// 签名 = 标签 + 索引 + 源指纹(长度/哈希) + 前 8 槽分量0值。
unsigned srcHash32(const char* p, size_t n);
void diagState(const char* tag, int idx, unsigned srcHash, int srcLen,
               const float* vals, int nSlots, int stride);
void diagLine(const char* line);
} // namespace host
