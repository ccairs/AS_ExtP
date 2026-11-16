// Release 构建（/DNDEBUG）会把 assert 编译为空操作——断言须保持生效
#undef NDEBUG
#include <cassert>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <windows.h>
#include "errorLog.h"
#include "test_util.h"

// error.log 代际计数契约——clearErrorLog 递增（渲染路径的去重方据此
// 检出「他实例清空本目录日志」并强制重写），appendErrorLog 不递增（追加不动
// 去重基准）。多实例场景：实例 A 重载成功清空全文件后，实例 B 的持续同错误
// 依赖代际变化重写，否则从 error.log 永久消失（诊断链断裂）。
static void test_generation_counter() {
    std::string dir = "test_errlog_dir";
    std::filesystem::create_directories(dir);
    auto g0 = host::errorLogGeneration();
    host::appendErrorLog(dir, "first error");
    assert(host::errorLogGeneration() == g0);              // append 不递增
    assert(host::readErrorLog(dir).find("first error") != std::string::npos);
    host::clearErrorLog(dir);
    auto g1 = host::errorLogGeneration();
    assert(g1 == g0 + 1);                                  // clear 递增 1
    assert(host::readErrorLog(dir).empty());               // 文件已截断
    host::clearErrorLog(dir);
    assert(host::errorLogGeneration() == g1 + 1);          // 连续 clear 单调递增
    std::filesystem::remove_all(dir);
    std::cout << "PASS test_generation_counter\n";
}

// 基础读写契约：append 追加有序、read 拼接全文、多次 append 代际不变
static void test_append_read_roundtrip() {
    std::string dir = "test_errlog_dir2";
    std::filesystem::create_directories(dir);
    host::appendErrorLog(dir, "err A");
    host::appendErrorLog(dir, "err B");
    std::string all = host::readErrorLog(dir);
    assert(all.find("err A") != std::string::npos);
    assert(all.find("err B") != std::string::npos);
    assert(all.find("err A") < all.find("err B"));         // 追加有序
    auto g = host::errorLogGeneration();
    host::appendErrorLog(dir, "err C");
    assert(host::errorLogGeneration() == g);               // append 不干扰代际
    assert(host::readErrorLog(dir).find("err C") != std::string::npos);
    std::filesystem::remove_all(dir);
    std::cout << "PASS test_append_read_roundtrip\n";
}

// ── 诊断文件体积上限 ──
// 为什么值得钉：trace 日志若无上限且无清理路径（实测 ~39KB/小时、1.13MB/29 小时），
// as_effect_host.log 的 16MB 上限只有一个被节流的调用点（一个会话最多查 3 次）。
// 这个函数是五个写入方共用的唯一上限实现，它的语义漂移会同时让三处日志失控。
static std::string readAll(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

static std::string makeLines(int n, const char* tag) {
    std::string s;
    for (int i = 0; i < n; ++i) {
        char buf[24];
        std::snprintf(buf, sizeof(buf), "%s-line-%02d ", tag, i);
        s += buf;
        s += std::string(80, 'y');   // 每行 ~95B
        s += "\n";
    }
    return s;
}

static void test_rotate_keep_tail() {
    const std::string path = glsltest::tempPath("test_rotate_keep_tail.log");
    std::filesystem::remove(path);
    // 文件不存在：不创建、静默返回 false
    assert(!host::rotateLogFileKeepTail(path, 1024, 256));
    assert(!std::filesystem::exists(path));

    const std::string content = makeLines(20, "old");
    glsltest::writeFile(path, content);
    const auto full = static_cast<unsigned long long>(content.size());
    // 未超限（maxBytes 恰好等于大小）：不动
    assert(!host::rotateLogFileKeepTail(path, full, 256));
    assert(std::filesystem::file_size(path) == content.size());
    // 参数退化（max <= keep）：不动，防把文件截成空
    assert(!host::rotateLogFileKeepTail(path, 256, 256));
    assert(std::filesystem::file_size(path) == content.size());

    // 超限 → 保留尾部 256B 重写
    assert(host::rotateLogFileKeepTail(path, 512, 256));
    const std::string tail = readAll(path);
    assert(tail.size() <= 256);                              // 体积被压回上限之内
    assert(tail.find("old-line-00") == std::string::npos);    // 头部行已丢
    assert(tail.find("old-line-19") != std::string::npos);    // 末行保留（尾部窗口内）
    // 首行一定是完整行（尾部窗口的首行多半被截半，实现从第一个换行之后保留）
    assert(tail.rfind("old-line-", 0) == 0);
    assert(!host::rotateLogFileKeepTail(path, 512, 256));     // 已在上限内：幂等不重复轮转
    std::filesystem::remove(path);
    std::cout << "PASS test_rotate_keep_tail\n";
}

// 崩溃预开句柄场景：轮转必须不破坏「FILE_APPEND_DATA 句柄继续可写」——
// 为此关-删-重开句柄（delete-pending 会让追加从此全部失败），
// 现实现改为截断重写，本测试钉住「截断后追加落到新内容之后」
static void test_rotate_with_open_append_handle() {
    const std::string path = glsltest::tempPath("test_rotate_append_open.log");
    glsltest::writeFile(path, makeLines(20, "old"));
    HANDLE h = CreateFileW(std::filesystem::path(path).wstring().c_str(), FILE_APPEND_DATA,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    assert(h != INVALID_HANDLE_VALUE);                        // 模拟 g_crashLogH
    assert(host::rotateLogFileKeepTail(path, 512, 256));       // 句柄在手仍能轮转
    DWORD w = 0;
    assert(WriteFile(h, "crash-line\n", 11, &w, nullptr) && w == 11);
    CloseHandle(h);
    const std::string after = readAll(path);
    assert(after.find("crash-line") != std::string::npos);     // 追加写成功
    assert(after.find("old-line-00") == std::string::npos);    // 且是在轮转后的内容之后
    assert(after.rfind("crash-line\n", std::string::npos) != std::string::npos);
    std::filesystem::remove(path);
    std::cout << "PASS test_rotate_with_open_append_handle\n";
}

// logFileExceeds：体积闸门的独立谓词。为什么必须独立存在——rotateLogFileKeepTail
// 的返回值同时表示「未超限」（多数情况）与「轮转失败」，而 plugin.cpp 的兜底
// 「删-关-重开」只在**轮转失败**时才该跑——兜底
// 分支直接吃 rotate 的 false，结果每 256 次写就把日志整份删掉（比不轮转更糟）。
static void test_log_file_exceeds() {
    const std::string path = glsltest::tempPath("test_log_exceeds.log");
    std::filesystem::remove(path);
    assert(!host::logFileExceeds(path, 100));    // 不存在 → false，不是"超限"
    assert(!host::logFileExceeds(path, 0));      // 空路径/不存在同样 false

    glsltest::writeFile(path, std::string(200, 'z'));
    assert(host::logFileExceeds(path, 100));     // 200 > 100
    assert(!host::logFileExceeds(path, 200));    // 恰好等于上限 → 不算超（严格大于）
    assert(!host::logFileExceeds(path, 500));

    // 未超限时：谓词 false 且轮转不动文件——两者语义必须自洽
    const auto before = std::filesystem::file_size(path);
    assert(!host::logFileExceeds(path, 500));
    assert(!host::rotateLogFileKeepTail(path, 500, 100));
    assert(std::filesystem::file_size(path) == before);
    std::filesystem::remove(path);
    std::cout << "PASS test_log_file_exceeds\n";
}

// 行时间戳：诊断包要把各进程日志拼成一份，跨段按时间对齐依赖
// 「带日期」的 ISO 前缀——native 各写入方若告缺时间戳或仅有 HH:mm:ss，跨段无法对齐。
static void test_iso_local_stamp() {
    char ts[24];
    host::isoLocalStamp(ts, sizeof(ts));
    const std::string s(ts);
    // 形如 "YYYY-MM-DDTHH:MM:SS "：19 字符 + 尾随空格
    assert(s.size() == 20);
    assert(s[4] == '-' && s[7] == '-' && s[10] == 'T');
    assert(s[13] == ':' && s[16] == ':' && s[19] == ' ');
    for (int i = 0; i < 20; i++) {
        if (i == 4 || i == 7 || i == 10 || i == 13 || i == 16 || i == 19) continue;
        assert(s[i] >= '0' && s[i] <= '9');   // 其余位必须是数字（补零到位）
    }
    // 年份与月份字段可解析且在合理范围（避免误写成 day/month 顺序）
    const int year = std::stoi(s.substr(0, 4));
    const int month = std::stoi(s.substr(5, 2));
    const int day = std::stoi(s.substr(8, 2));
    const int hour = std::stoi(s.substr(11, 2));
    assert(year >= 2020 && year <= 2200);
    assert(month >= 1 && month <= 12);
    assert(day >= 1 && day <= 31);
    assert(hour >= 0 && hour <= 23);

    // cap 不足：写空串而不是截断（半截日期会让排查误读）
    char tiny[8];
    std::memset(tiny, 'X', sizeof(tiny));
    host::isoLocalStamp(tiny, sizeof(tiny));
    assert(tiny[0] == '\0');
    // 边界：cap == 21 恰好可容纳
    char exact[21];
    host::isoLocalStamp(exact, sizeof(exact));
    assert(std::string(exact).size() == 20);
    // 空指针不崩
    host::isoLocalStamp(nullptr, 24);
    std::cout << "PASS test_iso_local_stamp\n";
}

// 诊断直写必须走宽路径——数据根默认在 %APPDATA% 下，中文用户名/中文
// 自定义目录时窄 CreateFileA 按 ANSI 解释 UTF-8 字节直接失败，rawTraceLine /
// appendDiagLogLine 的日志整段静默丢失。本测试用含中文的目录直接钉住行为。
static void test_diag_append_wide_path() {
    // 目录/文件名含非 ASCII：用宽字符构造（测试进程窄路径按 ANSI 解释不可靠）
    const std::wstring wdir = L"temp/诊断日志-中文目录";
    std::filesystem::remove_all(std::filesystem::path(wdir));
    std::filesystem::create_directories(std::filesystem::path(wdir));
    const std::wstring wpath = wdir + L"/as_effect_host_trace.log";
    // UTF-8 路径（与 diagLogFilePath/调用方口径一致）
    const int n = WideCharToMultiByte(CP_UTF8, 0, wpath.c_str(), -1, nullptr, 0, nullptr, nullptr);
    assert(n > 0);
    std::string utf8Path(static_cast<size_t>(n - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, wpath.c_str(), -1, &utf8Path[0], n, nullptr, nullptr);

    const std::string line = "12:00:00 wheel-hit 3 1\n";
    unsigned long gle = 1;
    assert(host::appendDiagLineAt(utf8Path, line.data(), line.size(), &gle));
    assert(gle == 0);
    // 追加语义：第二次写在文件尾
    assert(host::appendDiagLineAt(utf8Path, line.data(), line.size(), nullptr));
    {
        std::ifstream f(std::filesystem::path(wpath), std::ios::binary);
        std::ostringstream ss;
        ss << f.rdbuf();
        const std::string all = ss.str();
        assert(all.find("wheel-hit") != std::string::npos);
        assert(all.find("wheel-hit") != all.rfind("wheel-hit"));   // 出现两次（追加）
    }
    // 非法/空路径：静默 false，不崩（诊断通道不得反过来影响宿主）
    assert(!host::appendDiagLineAt("", line.data(), line.size(), nullptr));
    assert(!host::appendDiagLineAt(utf8Path, nullptr, 3, nullptr));
    std::filesystem::remove_all(std::filesystem::path(wdir));
    std::cout << "PASS test_diag_append_wide_path\n";
}

void runErrorLogTests() {
    test_generation_counter();
    test_append_read_roundtrip();
    test_rotate_keep_tail();
    test_rotate_with_open_append_handle();
    test_log_file_exceeds();
    test_iso_local_stamp();
    test_diag_append_wide_path();
}
