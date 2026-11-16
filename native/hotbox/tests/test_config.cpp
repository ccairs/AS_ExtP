// test_config.cpp — 配置解析单测（槽位/最近使用，纯函数）
#include "config.h"
#include <cstdio>

static int g_fail = 0;
#define CHECK(cond) do { \
    if (!(cond)) { std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); ++g_fail; } \
} while (0)

int run_config_tests() {
    using namespace config;

    // —— parseSlots：固定槽 + 动态槽（null/缺失）——
    std::string cfg = R"({"gesture":{"slots":[
        {"type":"effect","key":"ADBE Gaussian Blur","name":"高斯模糊"},
        null,
        {"type":"script","key":"C:/s.jsx","name":"脚本"}
    ]}})";
    auto slots = parseSlots(cfg, 6);
    CHECK(slots.size() == 6);
    CHECK(slots[0].fixed && slots[0].item.name == "高斯模糊"
          && slots[0].item.key == "ADBE Gaussian Blur" && slots[0].item.type == "effect");
    CHECK(!slots[1].fixed);                          // null → 动态槽
    CHECK(slots[2].fixed && slots[2].item.name == "脚本" && slots[2].item.type == "script");
    CHECK(!slots[3].fixed && !slots[4].fixed && !slots[5].fixed);   // 缺失 → 动态槽

    // 空/坏配置 → 全动态槽
    auto empty = parseSlots("", 6);
    CHECK(empty.size() == 6);
    for (const auto& s : empty) CHECK(!s.fixed);
    auto bad = parseSlots("not json", 4);
    CHECK(bad.size() == 4);
    for (const auto& s : bad) CHECK(!s.fixed);

    // 槽数量裁剪：配置多于需求槽时截断
    auto trimmed = parseSlots(R"({"gesture":{"slots":[
        {"type":"effect","key":"A","name":"x"},
        {"type":"effect","key":"B","name":"y"}]}})", 6);
    CHECK(trimmed.size() == 6 && trimmed[0].fixed && trimmed[1].fixed && !trimmed[2].fixed);

    // —— parseRecent / buildRecent 往返 ——
    std::vector<data::Item> items = {
        { "高斯模糊", "effect", "", "ADBE Gaussian Blur" },
        { "脚本", "script", "", "C:/s.jsx" },
    };
    std::string json = buildRecent(items);
    auto back = parseRecent(json);
    CHECK(back.size() == 2);
    CHECK(back[0].name == "高斯模糊" && back[0].key == "ADBE Gaussian Blur"
          && back[0].type == "effect");
    CHECK(back[1].name == "脚本" && back[1].key == "C:/s.jsx");
    CHECK(parseRecent("").empty());
    CHECK(parseRecent("garbage").empty());

    // —— pushRecent：去重前移 + 上限 ——
    auto r1 = pushRecent({}, items[0], 12);
    CHECK(r1.size() == 1 && r1[0].key == "ADBE Gaussian Blur");
    auto r2 = pushRecent(r1, items[1], 12);           // 追加新项 → 最前
    CHECK(r2.size() == 2 && r2[0].key == "C:/s.jsx");
    auto r3 = pushRecent(r2, items[0], 12);           // 已有项 → 去重前移
    CHECK(r3.size() == 2 && r3[0].key == "ADBE Gaussian Blur" && r3[1].key == "C:/s.jsx");
    auto r4 = pushRecent(r2, items[0], 1);            // 上限 1
    CHECK(r4.size() == 1 && r4[0].key == "ADBE Gaussian Blur");
    // 容量 100（kRecentMax 当前值）：连推 101 条后仍 100，最新在前、最早的 K0 被挤出
    std::vector<data::Item> many;
    for (int i = 0; i < 101; ++i) {
        many = pushRecent(many, data::Item{ "n" + std::to_string(i), "effect", "",
                                            "K" + std::to_string(i) }, 100);
    }
    CHECK(many.size() == 100);
    CHECK(many[0].key == "K100" && many[99].key == "K1");

    // —— setSlot：更新单槽保留其他槽 / 清空槽 ——
    std::string cfg2 = R"({"gesture":{"slots":[null,{"type":"script","key":"C:/s.jsx","name":"脚本"}]}})";
    data::Item fx = { "径向模糊", "effect", "", "ADBE Radial Blur" };
    std::string updated = setSlot(cfg2, 0, fx, 6);
    auto s2 = parseSlots(updated, 6);
    CHECK(s2.size() == 6);
    CHECK(s2[0].fixed && s2[0].item.name == "径向模糊" && s2[0].item.type == "effect");
    CHECK(s2[1].fixed && s2[1].item.name == "脚本");      // 槽 1 保留
    CHECK(!s2[2].fixed && !s2[3].fixed);                  // 其余动态

    // 清空槽位（key 空）→ 动态槽
    std::string cleared = setSlot(updated, 0, data::Item{}, 6);
    auto s3 = parseSlots(cleared, 6);
    CHECK(!s3[0].fixed && s3[1].fixed);

    // 非法原始配置 → 从空配置构建，仅目标槽有效
    std::string fromScratch = setSlot("garbage", 2, fx, 6);
    auto s4 = parseSlots(fromScratch, 6);
    CHECK(s4.size() == 6 && !s4[0].fixed && s4[2].fixed && s4[2].item.name == "径向模糊");

    // —— setSlot / setHotkey 互不丢字段 ——
    std::string withHk = setHotkey(cfg2, 3, 'K');   // mods 位：1=Alt 2=Ctrl 4=Shift（与 Win32 MOD_* 一致）
    auto c1 = parseConfig(withHk);
    CHECK(c1.hotkey.valid && c1.hotkey.mods == 3 && c1.hotkey.vk == 'K');
    std::string withBoth = setSlot(withHk, 0, fx, 6);       // 更新槽不丢 hotkey
    auto c2 = parseConfig(withBoth);
    CHECK(c2.hotkey.valid && c2.hotkey.vk == 'K');
    CHECK(c2.slots.size() >= 6 && c2.slots[0].fixed && c2.slots[0].item.name == "径向模糊");
    std::string hkAgain = setHotkey(withBoth, 1, 'Q');       // 更新热键不丢槽
    auto c3 = parseConfig(hkAgain);
    CHECK(c3.hotkey.mods == 1 && c3.hotkey.vk == 'Q');
    CHECK(c3.slots[0].fixed && c3.slots[0].item.key == "ADBE Radial Blur");
    CHECK(!parseHotkey("garbage").valid);

    // —— 无修饰键热键视为非法（防系统级吞掉裸键）——
    CHECK(!parseHotkey(R"({"hotkey":{"mods":0,"vk":81}})").valid);   // mods=0 手改文件
    CHECK(!parseHotkey(R"({"hotkey":{"mods":1,"vk":0}})").valid);    // vk=0
    CHECK(parseHotkey(R"({"hotkey":{"mods":1,"vk":81}})").valid);    // 正常组合
    CHECK(!parseConfig(setHotkey("", 0, 'Q')).hotkey.valid);        // setHotkey 同口径

    // ── 热键请求 {mods, vk} 解析（isfinite + [1,255] 夹取后才整值比较）——
    auto hr1 = parseHotkeyRequest(R"({"mods":1,"vk":81})");
    CHECK(hr1.valid && hr1.mods == 1 && hr1.vk == 81);
    auto hrw = parseHotkeyRequest(R"({"mods":8,"vk":81})");         // MOD_WIN 组合（位 8）
    CHECK(hrw.valid && hrw.mods == 8);
    auto hrMax = parseHotkeyRequest(R"({"mods":15,"vk":255})");     // 合法上界
    CHECK(hrMax.valid && hrMax.vk == 255);
    // 有限但超 int 范围的值：夹取后拒绝（(int) 转换 UB 防护，json 层只拦 ERANGE/inf）
    CHECK(!parseHotkeyRequest(R"({"mods":1e20,"vk":81})").valid);
    CHECK(!parseHotkeyRequest(R"({"mods":1,"vk":1e20})").valid);
    CHECK(!parseHotkeyRequest(R"({"mods":-1e20,"vk":81})").valid);
    CHECK(!parseHotkeyRequest(R"({"mods":100000000000000000000,"vk":81})").valid);
    // 非整数 / 越界 / 非法值
    CHECK(!parseHotkeyRequest(R"({"mods":1.5,"vk":81})").valid);
    CHECK(!parseHotkeyRequest(R"({"mods":0,"vk":81})").valid);      // 无修饰键
    CHECK(!parseHotkeyRequest(R"({"mods":1,"vk":0})").valid);
    CHECK(!parseHotkeyRequest(R"({"mods":1,"vk":256})").valid);     // vk 上界 255
    CHECK(!parseHotkeyRequest(R"({"mods":300,"vk":81})").valid);    // mods 越界（合法组合 ≤15）
    CHECK(parseHotkeyRequest(R"({"mods":1,"vk":81.0})").valid);     // 整值浮点写法合法
    // 缺字段 / 类型不符
    CHECK(!parseHotkeyRequest(R"({"vk":81})").valid);               // 缺 mods
    CHECK(!parseHotkeyRequest(R"({"mods":1})").valid);              // 缺 vk
    CHECK(!parseHotkeyRequest(R"({"mods":"1","vk":81})").valid);    // 字符串类型
    // 场景：面板非原子写的半截 JSON → invalid（读侧保留重试而非当坏请求删除）
    CHECK(!parseHotkeyRequest(R"({"mods":4,"vk")").valid);
    CHECK(!parseHotkeyRequest("{").valid);
    CHECK(!parseHotkeyRequest("").valid);
    CHECK(!parseHotkeyRequest("garbage").valid);

    // —— releaseExecute / releaseStay：布尔开关字段（缺失/非布尔 → 各自默认）——
    CHECK(parseReleaseExecute("") == true);            // 缺失 → 默认开（保持既有松手行为）
    CHECK(parseReleaseStay("") == false);              // 缺失 → 默认关（保持既有松手行为）
    CHECK(!parseReleaseExecute(R"({"releaseExecute":false})"));
    CHECK(parseReleaseStay(R"({"releaseStay":true})"));
    CHECK(parseReleaseExecute(R"({"releaseExecute":"false"})"));   // 非布尔 → 默认
    CHECK(!parseReleaseStay(R"({"releaseStay":1})"));              // 非布尔 → 默认
    CHECK(!parseReleaseStay("garbage"));                           // 坏 JSON → 默认
    auto sw = parseConfig(R"({"releaseExecute":false,"releaseStay":true})");
    CHECK(!sw.releaseExecute && sw.releaseStay);

    // —— setReleaseStay / setReleaseExecute：合并写入不丢字段，两开关各自独立 ——
    std::string stayCfg = setReleaseStay(hkAgain, true);   // hkAgain：槽位0 固定 + hotkey(1,'Q')
    auto c4 = parseConfig(stayCfg);
    CHECK(c4.releaseStay);
    CHECK(c4.releaseExecute);                              // 未显式改的开关保留默认
    CHECK(c4.hotkey.valid && c4.hotkey.mods == 1 && c4.hotkey.vk == 'Q');
    CHECK(c4.slots.size() >= 6 && c4.slots[0].fixed && c4.slots[0].item.name == "径向模糊");
    auto c5 = parseConfig(setReleaseExecute(stayCfg, false));
    CHECK(c5.releaseStay && !c5.releaseExecute);           // 关松手执行不影响停留
    CHECK(c5.hotkey.valid && c5.hotkey.vk == 'Q');
    auto c6 = parseConfig(setReleaseStay("", false));      // 空原始配置 → 从空配置构建
    CHECK(!c6.releaseStay && c6.releaseExecute);           // 关停留不动松手执行（默认开）
    CHECK(parseReleaseStay(setReleaseStay("garbage", true)));   // 非法原始配置 → 从空配置构建
    // 反向对称：槽位/热键写入不丢 releaseStay（合并写入各方向都不丢字段）
    data::Item glow = { "发光", "effect", "", "ADBE Glo2" };
    auto c7 = parseConfig(setSlot(stayCfg, 1, glow, 6));
    CHECK(c7.releaseStay && c7.slots[1].fixed && c7.slots[1].item.key == "ADBE Glo2");
    auto c8 = parseConfig(setHotkey(stayCfg, 1, 'K'));
    CHECK(c8.releaseStay && c8.hotkey.vk == 'K');

    // —— 观察项修复：热键显示名与面板 _fmtHotkey 同口径（数字/F 键不再显示 VK 数字）——
    CHECK(hotkeyLabel(1, 81) == "Alt+Q");                 // 默认组合
    CHECK(hotkeyLabel(3, 72) == "Ctrl+Alt+H");            // mods 3 = Ctrl|Alt
    CHECK(hotkeyLabel(7, 112) == "Ctrl+Alt+Shift+F1");    // 全修饰 + F1
    CHECK(hotkeyLabel(4, 50) == "Shift+2");               // 数字主键（VK 数字回落会显示 Shift+50）
    CHECK(hotkeyLabel(2, 116) == "Ctrl+F5");              // F 键（VK 数字回落会显示 Ctrl+116）
    CHECK(hotkeyLabel(5, 123) == "Alt+Shift+F12");        // F12 边界
    CHECK(hotkeyLabel(2, 124) == "Ctrl+124");             // F13 起不在白名单 → 数字回落（面板同口径）
    CHECK(hotkeyLabel(2, 48) == "Ctrl+0" && hotkeyLabel(2, 57) == "Ctrl+9");   // 数字边界
    CHECK(hotkeyLabel(2, 32) == "Ctrl+空格");             // VK_SPACE
    CHECK(hotkeyLabel(2, 33) == "Ctrl+33");               // 非白名单 vk → 数字回落（同面板测试口径）

    // —— 热键请求节流重试状态（同内容只写盘 / 写失败永不丢弃）——
    {
        HotkeyRequestState st;
        CHECK(!st.applied && !st.matches(1, 81));          // 初始未应用
        st.markApplied(1, 81, 1, 81, true, 0);             // 首轮应用 OK（outcome=applied）
        CHECK(st.matches(1, 81));                          // 同内容 → 重试路径（只重写 config）
        CHECK(!st.matches(2, 81) && !st.matches(1, 82));   // 新内容/新组合 → 必须重新应用
        CHECK(st.effMods == 1 && st.effVk == 81 && st.configWriteNeeded);
        // 第 5 次失败不得丢请求；只计次（日志节流），状态不得作废
        for (int i = 0; i < 7; ++i) st.onWriteFailed();
        CHECK(st.writeFailTries == 7);
        CHECK(st.applied && st.matches(1, 81));
        // 重试期间新请求到达：markApplied 重置失败计次（旧请求的失败不误伤新请求）
        st.markApplied(2, 82, 2, 82, true, 1);
        CHECK(st.writeFailTries == 0 && st.matches(2, 82) && !st.matches(1, 81));
        CHECK(st.outcome == 1);
        // KEPT：还原原组合，config 无需写盘
        st.markApplied(3, 75, 3, 75, false, 2);
        CHECK(!st.configWriteNeeded);
        // 写成功清零计次
        st.onWriteFailed();
        st.onWriteOk();
        CHECK(st.writeFailTries == 0);
        // reset：请求文件消失（处理完成/作废）后状态清空
        st.reset();
        CHECK(!st.applied && !st.matches(3, 75) && st.writeFailTries == 0);
    }

    // —— slots 里 script/preset 的 key 归一为数据根相对（写盘出口）——
    {
        std::string root = "C:\\Users\\me\\AS_ExtP";
        std::string cfg2 = R"({"gesture":{"slots":[
            {"type":"script","key":"C:\\Users\\me\\AS_ExtP\\agent\\scripts\\a.jsx","name":"脚本A"},
            {"type":"preset","key":"D:\\other\\p.ffx","name":"外部预设"},
            {"type":"effect","key":"ADBE Gaussian Blur","name":"效果"},
            null
        ]}})";
        std::string norm = normalizeSlotKeys(cfg2, root);
        // 根内 → 相对；根外（用户自己的文件）→ 原样；effect 的 matchName 不动
        CHECK(norm.find("agent/scripts/a.jsx") != std::string::npos);
        CHECK(norm.find("C:\\\\Users") == std::string::npos);            // JSON 里未转换的绝对 key 形态
        CHECK(norm.find("D:\\\\other\\\\p.ffx") != std::string::npos);    // 根外 → 保留绝对（JSON 转义形态）
        CHECK(norm.find("ADBE Gaussian Blur") != std::string::npos);
        // 幂等：再归一一次内容不变（相对 key 不再转换）
        CHECK(normalizeSlotKeys(norm, root) == norm);
        // 还原链：归一后的文本经 parseSlots + fromRelKey → 回到原绝对路径
        auto back = parseSlots(norm, 6);
        CHECK(back[0].fixed && data::fromRelKey(root, back[0].item.key)
              == "C:/Users/me/AS_ExtP/agent/scripts/a.jsx");
        CHECK(back[1].fixed && back[1].item.key == "D:\\other\\p.ffx");   // 根外原样
        // 空 root → 不转换（降级安全；文本形态会因 buildConfig 重序而不同，比 key）
        auto keep = parseSlots(normalizeSlotKeys(cfg2, ""), 6);
        CHECK(keep[0].fixed && keep[0].item.key == "C:\\Users\\me\\AS_ExtP\\agent\\scripts\\a.jsx");
    }
    return g_fail;
}
