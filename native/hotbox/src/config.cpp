// config.cpp — 热盒配置实现
#include "config.h"
#include "json.h"
#include <cmath>

namespace config {

Config parseConfig(const std::string& configJson) {
    Config out;
    if (configJson.empty()) return out;
    json::Value root;
    if (!json::parse(configJson.c_str(), configJson.size(), &root)) return out;
    // gesture.slots
    const json::Value& slots = root["gesture"]["slots"];
    if (slots.type == json::Value::kArray) {
        for (size_t i = 0; i < slots.size(); ++i) {
            const json::Value& s = slots[i];
            if (s.type != json::Value::kObject) {          // null / 缺省 → 动态槽
                out.slots.push_back(SlotConfig{});
                continue;
            }
            std::string type = s["type"].str;
            std::string key = s["key"].str;
            std::string name = s["name"].str;
            if (key.empty()) {                             // 无效槽 → 动态槽
                out.slots.push_back(SlotConfig{});
                continue;
            }
            SlotConfig sc;
            sc.fixed = true;
            sc.item.type = type.empty() ? "effect" : type;
            sc.item.key = key;
            sc.item.name = name;
            out.slots.push_back(std::move(sc));
        }
    }
    // hotkey（无修饰键的全局热键会系统级吞掉裸键，视为非法 → 保持默认）
    const json::Value& hk = root["hotkey"];
    if (hk.type == json::Value::kObject && hk["vk"].type == json::Value::kNumber) {
        // 非有限值（inf/nan）不参与 double→int 转换（超范围浮点转整型是
        // UB）——按 0 处理走 invalid 分支保持默认热键（json 层已拦 strtod 溢出，
        // 此处为纵深防御，对齐本函数"非法 → 保持默认"的既有风格）
        double m = hk["mods"].num, v = hk["vk"].num;
        out.hotkey.mods = std::isfinite(m) ? (int)m : 0;
        out.hotkey.vk = std::isfinite(v) ? (int)v : 0;
        out.hotkey.valid = out.hotkey.vk > 0 && out.hotkey.mods > 0;
    }
    // releaseExecute（缺失/非布尔 → 默认开）
    const json::Value& re = root["releaseExecute"];
    if (re.type == json::Value::kBool) out.releaseExecute = re.b;
    // releaseStay（缺失/非布尔 → 默认关，即保持既有松手行为）
    const json::Value& rs = root["releaseStay"];
    if (rs.type == json::Value::kBool) out.releaseStay = rs.b;
    return out;
}

std::string buildConfig(const Config& c) {
    std::string slotsJson = "[";
    for (size_t i = 0; i < c.slots.size(); ++i) {
        if (i) slotsJson += ",";
        if (c.slots[i].fixed) {
            slotsJson += "{\"type\":" + json::buildString(c.slots[i].item.type) +
                         ",\"key\":" + json::buildString(c.slots[i].item.key) +
                         ",\"name\":" + json::buildString(c.slots[i].item.name) + "}";
        } else {
            slotsJson += "null";
        }
    }
    slotsJson += "]";
    std::string out = "{\"gesture\":{\"slots\":" + slotsJson + "}";
    if (c.hotkey.valid) {
        out += ",\"hotkey\":{\"mods\":" + std::to_string(c.hotkey.mods) +
               ",\"vk\":" + std::to_string(c.hotkey.vk) + "}";
    }
    out += ",\"releaseExecute\":" + std::string(c.releaseExecute ? "true" : "false");
    out += ",\"releaseStay\":" + std::string(c.releaseStay ? "true" : "false");
    out += "}";
    return out;
}

std::vector<SlotConfig> parseSlots(const std::string& configJson, size_t slotCount) {
    Config c = parseConfig(configJson);
    if (c.slots.size() < slotCount) c.slots.resize(slotCount);
    if (c.slots.size() > slotCount) c.slots.resize(slotCount);
    return c.slots;
}

Hotkey parseHotkey(const std::string& configJson) {
    return parseConfig(configJson).hotkey;
}

bool parseReleaseExecute(const std::string& configJson) {
    return parseConfig(configJson).releaseExecute;
}

bool parseReleaseStay(const std::string& configJson) {
    return parseConfig(configJson).releaseStay;
}

// 解析面板写入的热键请求 {mods, vk}（原内联在 window_processHotkeyRequest）。
// double→int 转换防护（对齐 parseConfig 的 hotkey 分支并补范围夹取）：isfinite + [1,255]
// 夹取通过后才做整值比较——有限但超 int 范围的值（如 1e20）直接 (int) 转换是 UB
// （MSVC 碰巧无害，不可移植）。坏 JSON / 缺字段 / 非整数 / 越界均落 invalid（调用方
// 按语义保留重试或计数后丢弃）。mods 上限 255：合法组合是 MOD_ALT/
// CONTROL/SHIFT/WIN 位掩码（≤15），面板侧不会写出更大值。
HotkeyRequest parseHotkeyRequest(const std::string& requestJson) {
    HotkeyRequest out;
    if (requestJson.empty()) return out;
    json::Value root;
    if (!json::parse(requestJson.c_str(), requestJson.size(), &root)) return out;
    double m = root["mods"].num, v = root["vk"].num;
    if (std::isfinite(m) && std::isfinite(v) &&
        m >= 1 && m <= 255 && v >= 1 && v <= 255 &&
        m == (int)m && v == (int)v) {
        out.mods = (int)m;
        out.vk = (int)v;
        out.valid = true;
    }
    return out;
}

std::vector<data::Item> parseRecent(const std::string& recentJson) {
    std::vector<data::Item> out;
    if (recentJson.empty()) return out;
    json::Value root;
    if (!json::parse(recentJson.c_str(), recentJson.size(), &root)) return out;
    const json::Value& items = root["items"];
    for (size_t i = 0; i < items.size(); ++i) {
        const json::Value& it = items[i];
        data::Item item;
        item.type = it["type"].str;
        item.key = it["key"].str;
        item.name = it["name"].str;
        if (!item.type.empty() && !item.key.empty()) out.push_back(std::move(item));
    }
    return out;
}

std::string buildRecent(const std::vector<data::Item>& items) {
    std::string out = "{\"items\":[";
    for (size_t i = 0; i < items.size(); ++i) {
        if (i) out += ",";
        out += "{\"type\":" + json::buildString(items[i].type) +
               ",\"key\":" + json::buildString(items[i].key) +
               ",\"name\":" + json::buildString(items[i].name) + "}";
    }
    out += "]}";
    return out;
}

std::vector<data::Item> pushRecent(std::vector<data::Item> items, const data::Item& item,
                                   size_t maxItems) {
    std::vector<data::Item> out;
    if (maxItems == 0) return out;
    out.push_back(item);
    for (const auto& it : items) {
        if (out.size() >= maxItems) break;              // 先检查上限再追加
        if (it.key == item.key && it.type == item.type) continue;   // 去重
        out.push_back(it);
    }
    return out;
}

std::string setSlot(const std::string& configJson, int slotIndex, const data::Item& item,
                    size_t slotCount) {
    Config c = parseConfig(configJson);
    if (c.slots.size() < slotCount) c.slots.resize(slotCount);   // 保留既有槽位
    if (slotIndex >= 0 && (size_t)slotIndex < c.slots.size()) {
        if (item.key.empty()) {
            c.slots[slotIndex].fixed = false;
            c.slots[slotIndex].item = data::Item{};
        } else {
            c.slots[slotIndex].fixed = true;
            c.slots[slotIndex].item = item;
        }
    }
    return buildConfig(c);
}

std::string setHotkey(const std::string& configJson, int mods, int vk) {
    Config c = parseConfig(configJson);
    c.hotkey.mods = mods;
    c.hotkey.vk = vk;
    c.hotkey.valid = vk > 0 && mods > 0;
    return buildConfig(c);
}

std::string setReleaseExecute(const std::string& configJson, bool enabled) {
    Config c = parseConfig(configJson);
    c.releaseExecute = enabled;
    return buildConfig(c);
}

std::string setReleaseStay(const std::string& configJson, bool enabled) {
    Config c = parseConfig(configJson);
    c.releaseStay = enabled;
    return buildConfig(c);
}

// slots 里的 script/preset key → 数据根相对形态（写盘出口统一调用）
std::string normalizeSlotKeys(const std::string& configJson, const std::string& dataRoot) {
    Config c = parseConfig(configJson);
    for (auto& s : c.slots) {
        if (s.fixed && (s.item.type == "script" || s.item.type == "preset")) {
            s.item.key = data::toRelKey(dataRoot, s.item.key);
        }
    }
    return buildConfig(c);
}

} // namespace config
