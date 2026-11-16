#include "glslLoader.h"
#include <filesystem>
#include <fstream>
#include <sstream>
#include <utility>
#include <windows.h>

namespace glsl {
namespace {
// 文件属性 → (size, mtime) 两个 64 位键值
void attrKeys(const WIN32_FILE_ATTRIBUTE_DATA& fa,
              unsigned long long& sz, unsigned long long& wt) {
    sz = (static_cast<unsigned long long>(fa.nFileSizeHigh) << 32) | fa.nFileSizeLow;
    wt = (static_cast<unsigned long long>(fa.ftLastWriteTime.dwHighDateTime) << 32) |
         fa.ftLastWriteTime.dwLowDateTime;
}
} // namespace

bool FileWatcher::needsReload() {
    // 快路径：文件属性（size+mtime）未变且距上次内容校验 <2s → 跳过读盘。
    // needsReload 随渲染每帧调用，全量读盘 + 逐字节比较是每帧磁盘 I/O
    // （30fps 播放即 30+ 次读/秒）；属性查询只一次系统调用，便宜得多。
    // 每 2s 强制重读一次内容：兜底"同尺寸同 mtime 的连续写入"漏检
    // （见 glslLoader.h 注释——内容比对语义不丢失，仅延迟上限 2s）。
    // 写盘截断窗口读空仍不消费状态（hasSeen_ 不变），下次自动重试。
    WIN32_FILE_ATTRIBUTE_DATA fa{};   // 值初始化：hasAttr 为假时内容无意义，勿依赖
    const bool hasAttr = !path_.empty() &&
        GetFileAttributesExW(utf8ToWide(path_).c_str(), GetFileExInfoStandard, &fa) != FALSE;
    // 观测记录：文件缺失或大小为 0（emptyOrMissing()，供指针文件类调用方回退
    // 默认根；不影响下方任何判定）
    emptyOrMissing_ = !hasAttr ||
        (((static_cast<unsigned long long>(fa.nFileSizeHigh) << 32) | fa.nFileSizeLow) == 0ULL);
    const auto now = std::chrono::steady_clock::now();
    if (hasAttr && hasSeen_) {
        unsigned long long sz = 0, wt = 0;
        attrKeys(fa, sz, wt);
        if (sz == lastSize_ && wt == lastWrite_ &&
            now - lastVerify_ < std::chrono::seconds(2)) {
            return false;
        }
    }
    lastVerify_ = now;
    std::string cur = readFile(path_);
    if (cur.empty()) return false;   // 不存在/写盘窗口读空 → 不消费状态，下次重试
    if (!hasSeen_ || cur != lastContent_) {
        hasSeen_ = true;
        lastContent_ = std::move(cur);
        if (hasAttr) attrKeys(fa, lastSize_, lastWrite_);
        return true;
    }
    if (hasAttr) attrKeys(fa, lastSize_, lastWrite_);   // 内容未变（如 touch）：记录新属性快照
    return false;
}

std::string readFile(const std::string& path) {
    // 窄 char 路径在 Windows 按 ANSI(GBK) 解释：本项目路径统一 UTF-8，
    // 含中文的数据目录/文件名会乱码打不开 → 统一转宽路径打开
    std::ifstream f(std::filesystem::path(utf8ToWide(path)), std::ios::binary);
    if (!f) return "";
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

std::wstring utf8ToWide(const std::string& s) {
    if (s.empty()) return L"";
    // MB_ERR_INVALID_CHARS——非法 UTF-8（典型：记事本 ANSI/GBK 保存的
    // 中文路径，0x80-0xFF 双字节流不构成合法 UTF-8 序列）不再静默替换为
    // U+FFFD 乱码路径（后续按该乱码路径打开必失败且无诊断），返回空串交
    // 调用方按非法输入处理（resolveDataRoot 据此拒绝 data-dir.txt 内容）
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.c_str(), (int)s.size(), nullptr, 0);
    if (n <= 0) return L"";
    std::wstring w;
    w.resize(n);
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}

std::string wideToUtf8(const std::wstring& s) {
    if (s.empty()) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0, nullptr, nullptr);
    std::string out;
    out.resize(n);
    WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), &out[0], n, nullptr, nullptr);
    return out;
}
} // namespace glsl
