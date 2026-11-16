// aeexec.cpp — 包装 AEGP_UtilitySuite6::AEGP_ExecuteScript
#include "aeexec.h"
#include "log.h"
#include <windows.h>

static AEGP_PluginID S_id = 0L;
static SPBasicSuite* S_sp = nullptr;

void aeexec_init(AEGP_PluginID pluginID, SPBasicSuite* sp) {
    S_id = pluginID;
    S_sp = sp;
}

AEGP_PluginID aeexec_pluginId() { return S_id; }
SPBasicSuite* aeexec_sp() { return S_sp; }

static std::string readMem(AEGP_SuiteHandler& suites, AEGP_MemHandle h) {
    if (!h) return "";
    std::string out;
    void* p = nullptr;
    if (suites.MemorySuite1()->AEGP_LockMemHandle(h, &p) == A_Err_NONE && p) {
        out = static_cast<const char*>(p);
        suites.MemorySuite1()->AEGP_UnlockMemHandle(h);
    }
    suites.MemorySuite1()->AEGP_FreeMemHandle(h);
    return out;
}

// AEGP_ExecuteScript 契约（platform_encodingB=FALSE）输出应为 UTF-8，
// 但中文版 AE 的错误消息实际按系统 ANSI（GBK）返回（AE 2026 实测）。
// 兼容探测：合法 UTF-8 则原样返回；否则按系统 ANSI 转 UTF-8。
// 串内编码无法自证（歧义面见 data::ansiToUtf8 头注）：这里只处理「整串不是合法 UTF-8」
// 的显式 ANSI 情形；效果名/分类这类成批数据在 aeexec_enumerateEffects 用整批判定。
static std::string normalizeToUtf8(const std::string& s) {
    if (s.empty() || data::isValidUtf8(s)) return s;
    return data::ansiToUtf8(s, CP_ACP);
}

bool aeexec_runScript(const std::string& scriptUtf8, std::string* outResult,
                      std::string* outError) {
    if (!S_sp || scriptUtf8.empty()) return false;
    AEGP_SuiteHandler suites(S_sp);
    AEGP_MemHandle resultH = nullptr;
    AEGP_MemHandle errH = nullptr;
    // platform_encodingB = FALSE：脚本与结果均为 UTF-8
    A_Err err = suites.UtilitySuite6()->AEGP_ExecuteScript(
        S_id, scriptUtf8.c_str(), FALSE, &resultH, &errH);
    if (err != A_Err_NONE) {
        hotbox_log(("aeexec ExecuteScript err=" + std::to_string((long)err)).c_str());
        return false;
    }
    // 返回串统一规范为 UTF-8（中文版 AE 错误消息可能是 GBK，见 normalizeToUtf8）
    std::string result = normalizeToUtf8(readMem(suites, resultH));
    std::string errStr = normalizeToUtf8(readMem(suites, errH));
    if (outResult) *outResult = result;
    if (outError) *outError = errStr;
    if (!errStr.empty()) {
        hotbox_log(("aeexec script error: " + errStr).c_str());
        return false;
    }
    return true;
}

// 已安装效果数：单次 AEGP 调用，供数据源签名做「插件集是否变化」的廉价探测。
// 主线程调用（AEGP 无多线程支持）；失败返回 -1，与「无效果（0）」区分开。
int aeexec_installedEffectCount() {
    if (!S_sp) return -1;
    AEGP_SuiteHandler suites(S_sp);
    auto* eff = suites.EffectSuite4();
    if (!eff) return -1;
    A_long count = 0;
    if (eff->AEGP_GetNumInstalledEffects(&count) != A_Err_NONE) return -1;
    return (int)count;
}

// 原生枚举已安装效果（效果列表主数据源；effects_cache.json 仅在返回 0 时兜底）：
// AEGP_EffectSuite4::AEGP_GetNumInstalledEffects + GetNextInstalledEffect 遍历。
// name/category 是系统 ANSI（SDK 里只有 matchName 标注 UTF8）；编码按整批判定后再解码，
// 判据见 data::isAnsiBatch / data::ansiToUtf8（单串无法区分 ANSI 与合法 UTF-8 字节序列）。
int aeexec_enumerateEffects(std::vector<data::Item>& out, bool* complete) {
    if (complete) *complete = false;
    int count = aeexec_installedEffectCount();
    if (count <= 0) return 0;
    AEGP_SuiteHandler suites(S_sp);
    auto* eff = suites.EffectSuite4();
    if (!eff) return 0;
    AEGP_InstalledEffectKey key = AEGP_InstalledEffectKey_NONE;
    // 原始字节先收集：name/category 的来源编码要等整批到齐才能判（见 data::isAnsiBatch）
    struct RawEntry { std::string name, match, category; };
    std::vector<RawEntry> raw;
    // 完整性 = 循环正常走完 count 次（未因任何失败/空 key break）。
    // 半截枚举返回的条目数 >0 不得让调用方记有效缓存（见 data::effectEnumCacheable）。
    bool exhausted = true;
    for (int i = 0; i < count; ++i) {
        if (eff->AEGP_GetNextInstalledEffect(key, &key) != A_Err_NONE) { exhausted = false; break; }
        if (key == AEGP_InstalledEffectKey_NONE) { exhausted = false; break; }
        A_char nameZ[AEGP_MAX_EFFECT_NAME_SIZE] = {0};
        A_char matchZ[AEGP_MAX_EFFECT_MATCH_NAME_SIZE] = {0};
        A_char catZ[AEGP_MAX_EFFECT_CATEGORY_NAME_SIZE] = {0};
        eff->AEGP_GetEffectName(key, nameZ);
        eff->AEGP_GetEffectMatchName(key, matchZ);
        eff->AEGP_GetEffectCategory(key, catZ);
        RawEntry r;
        r.name = nameZ;
        r.match = matchZ;   // SDK 注释：matchName 已是 UTF-8
        r.category = catZ;
        if (!r.name.empty() && !r.match.empty()) raw.push_back(std::move(r));
    }
    if (complete) *complete = exhausted;
    std::vector<std::string> encTexts;
    encTexts.reserve(raw.size() * 2);
    for (const auto& r : raw) { encTexts.push_back(r.name); encTexts.push_back(r.category); }
    const bool ansi = data::isAnsiBatch(encTexts);
    for (auto& r : raw) {
        data::Item it;
        it.name = ansi ? data::ansiToUtf8(r.name, CP_ACP) : r.name;
        it.key = std::move(r.match);
        it.type = "effect";
        it.category = ansi ? data::ansiToUtf8(r.category, CP_ACP) : r.category;
        out.push_back(std::move(it));
    }
    const int n = (int)raw.size();
    hotbox_log(("aeexec_enumerateEffects: " + std::to_string(n) + " effects complete=" +
                (exhausted ? "1" : "0") + " enc=" + (ansi ? "ansi" : "utf8")).c_str());
    return n;
}
