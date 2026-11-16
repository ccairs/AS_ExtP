// log.h — 追加式日志到 <数据根>\temp\logs\as_hotbox.log（与 glsl-host 的
// as_effect_host.log 同风格）。不落 %TEMP%：系统临时目录会被清理策略
// 清空、多用户机器上要按人去翻，且诊断包要从两处取；现统一落数据目录。
// 带本地时间戳：排查"新旧进程重叠时长"类问题需要绝对时间（仅靠会话边界只能推断）
//
// 体积上限：日志长期追加会无限增长，需有体积闸门。
// 现补采样式体积闸门——写入前每 64 次查一次大小，超限保留**尾部**（不整份清空：
// 定位只看最近一段，清空会把崩溃现场的最后一批证据一起丢掉）。口径与其余日志一致。
//
// 为什么在这里用 Win32 GetFileAttributesEx 而不是 CRT 的 fseek/ftell：
// 该头被多处 TU 内联包含，且写入是"逐行 fopen/fclose"，没有长驻句柄，
// 用一个独立的体积查询函数即可，不引入新依赖、不影响既有追加路径。
//
// 全部路径调用一律宽字符——GetFileAttributesExW /
// _wfopen_s + data::utf8ToWide。GetFileAttributesExA/fopen_s 收 UTF-8 路径按
// ANSI(GBK) 解释，数据根含中文（默认 %APPDATA% 带中文用户名）时体积闸门查不到文件、
// 追加打开失败 → as_hotbox.log 整段静默丢失（与 glsl-host 的同根因）。
// 写入内容仍是 UTF-8 字节（FILE* 按字节写），不受宽路径影响。
#pragma once
#include <cstdio>
#include <cstdlib>
#include <string>
#include <windows.h>
#include "data.h"   // defaultDataDir / utf8ToWide：日志落点与面板/宿主同源（跟随 data-dir.txt）

// 保留尾部口径（与 glsl-host 的 as_effect_host.log 同量级但更小——hotbox 是启动器，
// 日志量远低于渲染宿主）
static const DWORD kHotboxLogMaxBytes = 1024 * 1024;      // 1MB 上限
static const DWORD kHotboxLogKeepBytes = 512 * 1024;      // 超限后保留末尾 512KB

inline bool hotbox_logExceeds(const std::string& p) {
    WIN32_FILE_ATTRIBUTE_DATA fad;
    // 宽路径（utf8ToWide）——含中文的数据根不再查不到
    if (!GetFileAttributesExW(data::utf8ToWide(p).c_str(), GetFileExInfoStandard, &fad)) return false;
    // 高位为 0 说明 < 4GB，本项目日志远低于此
    if (fad.nFileSizeHigh != 0) return true;
    return fad.nFileSizeLow > kHotboxLogMaxBytes;
}

// 保留尾部轮转：读尾部 → 覆盖重写。读失败/写失败均静默返回 false（日志不能反过来影响功能）。
inline bool hotbox_rotateKeepTail(const std::string& p) {
    // 宽路径打开（_wfopen_s）——窄 fopen_s 在含中文的数据根下必失败，
    // 轮转静默 no-op、日志无限增长
    const std::wstring wp = data::utf8ToWide(p);
    FILE* rf = nullptr;
    if (_wfopen_s(&rf, wp.c_str(), L"rb") != 0 || !rf) return false;
    std::string tail;
    bool ok = false;
    if (fseek(rf, 0, SEEK_END) == 0) {
        long size = ftell(rf);
        if (size > 0) {
            long start = size - static_cast<long>(kHotboxLogKeepBytes);
            if (start < 0) start = 0;
            if (fseek(rf, start, SEEK_SET) == 0) {
                tail.resize(static_cast<size_t>(size - start));
                size_t got = fread(&tail[0], 1, tail.size(), rf);
                tail.resize(got);
                ok = true;
            }
        }
    }
    fclose(rf);
    if (!ok) return false;

    FILE* wf = nullptr;
    if (_wfopen_s(&wf, wp.c_str(), L"wb") != 0 || !wf) return false;
    SYSTEMTIME st;
    GetLocalTime(&st);
    // 自证记录：否则"日志变短了"无从判断是轮转还是丢失
    fprintf(wf, "[cap] %04d-%02d-%02dT%02d:%02d:%02d 超上限，已保留末尾\n",
            st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    fwrite(tail.data(), 1, tail.size(), wf);
    fclose(wf);
    return true;
}

inline void hotbox_log(const char* msg) {
    // 落点解析一次（进程内缓存）：本函数被热键/窗口消息高频调用，不能每次读指针文件。
    static const std::string s_path = []() -> std::string {
        const std::string root = data::defaultDataDir();
        if (!root.empty()) {
            const std::wstring wroot = data::utf8ToWide(root);
            // 逐级创建：数据根必然存在（面板建的），temp\logs 未必；失败静默
            CreateDirectoryW((wroot + L"\\temp").c_str(), nullptr);
            CreateDirectoryW((wroot + L"\\temp\\logs").c_str(), nullptr);
            return root + "\\temp\\logs\\as_hotbox.log";
        }
        // 不回落 %TEMP%：口径是「数据目录不可用 → 直接不写，
        // 例外：无」，glsl-host 侧同样（diagLogFilePath 返回空串即放弃写盘）。
        // 不设 %TEMP% 兜底：唯一触发条件（进程环境块里没有 APPDATA）
        // 在正常启动 AE 时不可能出现——留着只会让两个插件的落盘行为不一致。
        // 返回空串 → 下方 `if (s_path.empty()) return;` 直接静默跳过。
        return std::string();
    }();
    if (s_path.empty()) return;
    const std::string& p = s_path;

    // 采样式体积闸门：tick 初值 0 → **首次调用必查**（否则短命进程每次只写几行、
    // 永不累积到 64 次，文件跨进程增长却始终不被检查），之后每 64 次查一次，
    // 检查是幂等的，偶发漏查由下一次补上。
    static unsigned int tick = 0;
    if ((tick++ & 63u) == 0u && hotbox_logExceeds(p)) {
        hotbox_rotateKeepTail(p);
    }

    // 宽路径追加（_wfopen_s）——数据根含中文时旧 fopen_s 静默失败，
    // as_hotbox.log 整段丢失
    FILE* f = nullptr;
    if (_wfopen_s(&f, data::utf8ToWide(p).c_str(), L"a") == 0 && f) {
        SYSTEMTIME st;
        GetLocalTime(&st);
        // ISO 本地时间（带日期）：只有 HH:mm:ss 时跨天排查无法与面板/bridge 的
        // ISO 行无法按时间对齐（诊断包会把各进程日志拼成一份）
        fprintf(f, "%04d-%02d-%02dT%02d:%02d:%02d %s\n",
                st.wYear, st.wMonth, st.wDay,
                st.wHour, st.wMinute, st.wSecond, msg);
        fclose(f);
    }
}
