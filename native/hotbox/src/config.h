// config.h — 热盒配置：手势环槽位（自定义功能）+ 热键 + 最近使用（纯函数，可单测）
#pragma once
#include "data.h"
#include "i18n.h"
#include <string>
#include <vector>

namespace config {

// 手势环槽位：固定功能槽（config.gesture.slots 配置）或动态槽
// （fixed=false → 由最近使用/类别入口在运行时决定）
struct SlotConfig {
    bool fixed = false;   // true = 固定功能项
    data::Item item;      // fixed=true 时的功能项
};

// 热键（mods 位标志与 Win32 MOD_* 一致：1=Alt 2=Ctrl 4=Shift）
struct Hotkey {
    int mods = 0;
    int vk = 0;
    bool valid = false;
};

// 热键显示文本（纯函数，单测覆盖）：与面板侧 _fmtHotkey（client/main.js）同口径——
// 修饰键前缀 Ctrl/Alt/Shift 按序 + 主键名：A-Z 字母、0-9 数字、F1-F12（VK 112..123）、
// 空格（VK 32），其余 VK 一律十进制数字回落。
// 原生侧（hotkey.cpp describeKeys）只认 A-Z 与空格，
// 数字键/F 键在设置面板热键行与日志里显示为 "Ctrl+49"/"Ctrl+116"，与面板录制回显
// （"Ctrl+1"/"Ctrl+F5"）不一致；本函数为两侧唯一口径（面板 _fmtHotkey 与之对齐）。
inline std::string hotkeyLabel(int mods, int vk) {
    std::string s;
    if (mods & 2) s += "Ctrl+";
    if (mods & 1) s += "Alt+";
    if (mods & 4) s += "Shift+";
    if ((vk >= 'A' && vk <= 'Z') || (vk >= '0' && vk <= '9')) {
        s += (char)vk;                          // A-Z / 0-9
    } else if (vk >= 112 && vk <= 123) {
        s += "F" + std::to_string(vk - 111);    // F1-F12（VK_F1=112，与面板同边界）
    } else if (vk == 32) {
        s += Tr(S_HOTBOX_CONFIG_KEY_SPACE);          // VK_SPACE
    } else {
        s += std::to_string(vk);                // 非白名单 → 数字回落（如 Ctrl+33）
    }
    return s;
}

// 面板热键请求（hotkey-request.json 的 {mods, vk}）解析结果
struct HotkeyRequest {
    int mods = 0;
    int vk = 0;
    bool valid = false;
};

// 面板热键请求的节流重试状态（纯逻辑，单测覆盖）。
// 背景：config.json 写失败时请求文件会保留、按 ≥2s 节流重试；若每轮重试都
// 重新执行 hotkey_reload（Unregister+Register），且连续 5 次失败后直接删请求文件
//（面板把"文件消失"当处理完成 → 误报成功/占用）。本状态把两条纪律编码成可测
// 逻辑，window_processHotkeyRequest 只做 I/O 与调用：
//   ① 同一请求内容（mods/vk 相同）只应用一次 hotkey_reload；后续重试只重写 config
//      ——失败窗口内用户到浮窗手动录制的新组合不会被陈旧请求的下一轮重注册覆盖；
//   ② 写盘失败永不导致状态/请求作废（只累计 writeFailTries 供日志节流）——请求
//      文件必须保留，面板维持既有超时语义而不是被"文件消失"骗成已处理。
struct HotkeyRequestState {
    bool applied = false;          // 当前请求内容是否已执行过 hotkey_reload
    int mods = 0, vk = 0;          // 已应用请求的组合（判别是否同一条请求）
    int effMods = 0, effVk = 0;    // 首轮 hotkey_reload 的实际生效组合（重试写盘复用）
    bool configWriteNeeded = true; // KEPT（还原原组合）时为 false，config 无需改动
    int outcome = 0;               // 0=applied 1=fallback default 2=kept previous（仅日志）
    unsigned writeFailTries = 0;   // config 写连续失败次数（仅日志节流，永不触发丢弃）

    // 当前请求内容是否已应用（true = 这是一次重试：只写盘，不再 hotkey_reload）
    bool matches(int m, int v) const { return applied && mods == m && vk == v; }

    // 首轮应用成功落账：重置写盘失败计次（新请求不复用旧请求的失败计数）
    void markApplied(int m, int v, int em, int ev, bool writeNeeded, int oc) {
        applied = true;
        mods = m;
        vk = v;
        effMods = em;
        effVk = ev;
        configWriteNeeded = writeNeeded;
        outcome = oc;
        writeFailTries = 0;
    }

    void onWriteOk() { writeFailTries = 0; }
    // 写盘失败：只计数。不得在此（或调用方）删除请求文件/reset——见上方 ②
    void onWriteFailed() { ++writeFailTries; }

    void reset() { *this = HotkeyRequestState{}; }
};

// 完整配置：gesture.slots + hotkey + releaseExecute + releaseStay（setSlot/setHotkey/
// setReleaseExecute/setReleaseStay 合并写入互不丢字段）
struct Config {
    std::vector<SlotConfig> slots;
    Hotkey hotkey;
    bool releaseExecute = true;   // 手势环：热键松开是否执行选中弧段（关闭=松手仅关窗）
    bool releaseStay = false;     // 手势环：热键松开是否停留（开启=松手不执行也不关窗）
};

// 解析 config.json 文本 → 完整配置
Config parseConfig(const std::string& configJson);

// 序列化完整配置 → config.json 文本
std::string buildConfig(const Config& c);

// 解析 config.json 文本中的 gesture.slots（最多 slotCount 槽；缺失/null 槽为动态槽）
std::vector<SlotConfig> parseSlots(const std::string& configJson, size_t slotCount);

// 解析 config.json 文本中的 hotkey 字段
Hotkey parseHotkey(const std::string& configJson);

// 解析 config.json 文本中的 releaseExecute 字段（缺失/非法 → 默认 true）
bool parseReleaseExecute(const std::string& configJson);

// 解析 config.json 文本中的 releaseStay 字段（缺失/非法 → 默认 false）
bool parseReleaseStay(const std::string& configJson);

// 解析面板写入的热键请求 hotkey-request.json 文本 {mods, vk}
//（原内联在 window_processHotkeyRequest，提为纯函数供单测覆盖）
HotkeyRequest parseHotkeyRequest(const std::string& requestJson);

// 最近使用列表（时间倒序）
std::vector<data::Item> parseRecent(const std::string& recentJson);

// 序列化最近使用为 JSON 文本（写入 hotbox/recent.json）
std::string buildRecent(const std::vector<data::Item>& items);

// 最近使用去重前移：item 已存在则移除旧位置，插入最前，最多 maxItems 条
std::vector<data::Item> pushRecent(std::vector<data::Item> items, const data::Item& item,
                                   size_t maxItems);

// 把 slotIndex 槽位设为固定功能（保留其他槽位与 hotkey）；item.key 为空则清空该槽为动态槽。
// 返回合并后的 config.json 文本；原始 configJson 非法时从空配置构建。
std::string setSlot(const std::string& configJson, int slotIndex, const data::Item& item,
                    size_t slotCount);

// 写入 hotkey 字段（保留 gesture.slots）；返回合并后的 config.json 文本
std::string setHotkey(const std::string& configJson, int mods, int vk);

// 写入 releaseExecute 字段（保留 gesture.slots 与 hotkey）；返回合并后的 config.json 文本
std::string setReleaseExecute(const std::string& configJson, bool enabled);

// 写入 releaseStay 字段（保留 gesture.slots / hotkey / releaseExecute）；返回合并后的
// config.json 文本
std::string setReleaseStay(const std::string& configJson, bool enabled);

// 把 gesture.slots 里 script/preset 的 key 归一到「数据根相对」
// 形态（effect 的 matchName 不动）。config.json 的所有写盘出口都过一遍本函数——
// 新绑定写成相对路径，已是绝对形态的 key 也借此一次性归位（否则换数据目录后
// 老槽位仍指向旧根）。读侧由调用方用 data::fromRelKey 还原成绝对再进内存。
// 纯函数（root 由调用方给出），导出供单测。
std::string normalizeSlotKeys(const std::string& configJson, const std::string& dataRoot);

} // namespace config
