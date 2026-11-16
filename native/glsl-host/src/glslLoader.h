#pragma once
// glslLoader.h —— 纯 C++，与 AE SDK 无关
#include <chrono>
#include <string>
namespace glsl {
// 监听一个 .glsl 文件的内容，判断是否需要重新加载
// 内容比对取代 mtime 原因：
//   1) Windows 系统时钟 tick（~15.6ms）粒度下快速连续写入 mtime 可能相同 → 漏检；
//   2) 写盘截断窗口内读空时，若 mtime 已被消费，变更会被静默丢弃且不再重试。
// 内容比对两者都规避：空读不消费状态（hasSeen_ 保持 false），下一帧自动重试。
// 读盘节流：needsReload 随渲染每帧调用，全量读盘是每帧磁盘 I/O——先用文件属性
// （size+mtime）做快路径，属性未变时跳过读盘；每 2s 强制重读一次内容兜底
// "同尺寸同 mtime 的连续写入"极小概率漏检（内容比对语义不丢失，仅延迟上限 2s）。
class FileWatcher {
public:
    void setPath(const std::string& p) { path_ = p; hasSeen_ = false; }
    // 返回 true 表示文件内容已变化（或首次调用且文件非空）；
    // 变化时可用 lastContent() 取到触发重载的内容（避免调用方二次读文件撞写盘窗口）
    bool needsReload();
    const std::string& lastContent() const { return lastContent_; }
    // 最近一次 needsReload() 的 stat 观测：文件缺失或大小为 0。空读不消费
    // 状态（hasSeen_/lastContent_ 保持）是防写盘截窗设计；指针文件类调用方
    // （data-dir.txt，删除/清空 = 恢复默认根）用此标志区分"文件实质消失"与
    // "内容变化"，另行回退——本观测不改变 needsReload 的任何既有语义。
    bool emptyOrMissing() const { return emptyOrMissing_; }
private:
    std::string path_;
    bool hasSeen_ = false;
    bool emptyOrMissing_ = false;   // 最近 stat 观测：文件缺失或 size==0
    std::string lastContent_;
    unsigned long long lastSize_ = 0;      // 上次读到内容时的文件属性快照
    unsigned long long lastWrite_ = 0;
    std::chrono::steady_clock::time_point lastVerify_{};   // 上次内容校验时刻
};
// 读取文件全文；失败返回空串
std::string readFile(const std::string& path);

// 编码转换（UTF-8 ↔ UTF-16）：项目约定内部路径统一 UTF-8，文件打开统一走宽路径
// （窄 char* 路径按 ANSI/GBK 解释，含中文的路径会乱码打不开）
std::wstring utf8ToWide(const std::string& s);
std::string wideToUtf8(const std::wstring& s);
} // namespace glsl
