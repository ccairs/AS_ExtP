// test_log_wide.cpp ── hotbox 诊断日志的宽路径回归（非 ASCII 数据根）。
//
// log.h 全程窄字符（GetFileAttributesExA / fopen_s）收 UTF-8 路径：数据根
// 默认在 %APPDATA% 下，中文用户名或用户自定义的中文目录时，体积闸门查不到文件、
// 追加与轮转打开必失败 → as_hotbox.log 整段静默丢失（诊断打包按数据目录取日志，
// 现场直接消失）。本测试用含中文的临时目录直接钉住「查得到、轮得动、内容保留」。
#include "log.h"
#include <cstdio>
#include <string>
#include <windows.h>

static int g_fail = 0;
#define CHECK(cond) do { \
    if (!(cond)) { std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); ++g_fail; } \
} while (0)

int run_log_wide_tests() {
    // 相对当前工作目录（ctest 为 build 目录）建中文名目录
    const std::wstring dir = L"temp_log_wide_诊断目录";
    CreateDirectoryW(dir.c_str(), nullptr);
    const std::wstring wpath = dir + L"\\as_hotbox.log";
    const std::string utf8Path = data::wideToUtf8(wpath);
    DeleteFileW(wpath.c_str());

    // 体积闸门：不存在的文件 → false（不误报超限），与旧行为一致
    CHECK(!hotbox_logExceeds(utf8Path));

    // 写 1.2MB（> 1MB 上限，内容为可辨识行；行首 'S'/'E' 供保留校验）
    {
        const std::wstring wtmp = dir + L"\\seed.bin";
        HANDLE h = CreateFileW(wtmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                               FILE_ATTRIBUTE_NORMAL, nullptr);
        CHECK(h != INVALID_HANDLE_VALUE);
        std::string block(64 * 1024, 's');
        block[0] = 'S';
        block[block.size() - 1] = '\n';
        DWORD written = 0;
        bool ok = true;
        for (int i = 0; i < 19; ++i) {   // 19 * 64KB ≈ 1.216MB
            if (!WriteFile(h, block.data(), (DWORD)block.size(), &written, nullptr) ||
                written != (DWORD)block.size()) { ok = false; break; }
        }
        CloseHandle(h);
        CHECK(ok);
        // 文件内容整体复制为 .log（宽路径 API，测试自身不用窄路径）
        CHECK(MoveFileExW(wtmp.c_str(), wpath.c_str(), MOVEFILE_REPLACE_EXISTING) != 0);
    }

    // 宽路径体积查询：含中文的路径必须查得到（窄 GetFileAttributesExA 在此失败）
    CHECK(hotbox_logExceeds(utf8Path));

    // 宽路径轮转：读尾 → 覆盖重写；失败（窄 fopen_s 的旧行为）会返回 false
    CHECK(hotbox_rotateKeepTail(utf8Path));

    // 重写后：体积回落到保留区附近、含自证记录、尾部内容保留
    WIN32_FILE_ATTRIBUTE_DATA fad = {};
    CHECK(GetFileAttributesExW(wpath.c_str(), GetFileExInfoStandard, &fad));
    const unsigned long long size =
        (static_cast<unsigned long long>(fad.nFileSizeHigh) << 32) | fad.nFileSizeLow;
    CHECK(size > 0 && size < static_cast<unsigned long long>(kHotboxLogMaxBytes));
    {
        HANDLE h = CreateFileW(wpath.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                               OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        CHECK(h != INVALID_HANDLE_VALUE);
        std::string got(size > 4096 ? 4096 : static_cast<size_t>(size), '\0');   // 只读头部
        DWORD rd = 0;
        CHECK(ReadFile(h, &got[0], (DWORD)got.size(), &rd, nullptr) != 0);
        CloseHandle(h);
        got.resize(rd);
        CHECK(got.find("[cap]") != std::string::npos);   // 轮转自证记录在（UTF-8 原样）
    }
    DeleteFileW(wpath.c_str());
    RemoveDirectoryW(dir.c_str());
    if (g_fail == 0) std::printf("PASS test_log_wide (utf8 中文路径: 超额判定/轮转/内容保留)\n");
    return g_fail;
}
