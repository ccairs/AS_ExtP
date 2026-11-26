// test_search.cpp — 模糊匹配/类型过滤/拼音搜索单测
#include "search.h"
#include "data.h"
#include <cstdio>
#include <fstream>
#include <vector>

static int g_fail = 0;
#define CHECK(cond) do { \
    if (!(cond)) { std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); ++g_fail; } \
} while (0)

// 拼音单测：从源码树读 pinyin.txt（CMake 传入 HOTBOX_PINYIN_DICT_PATH）
static bool initPinyinFromDictFile() {
#ifdef HOTBOX_PINYIN_DICT_PATH
    std::ifstream f(HOTBOX_PINYIN_DICT_PATH, std::ios::binary);
    if (!f) return false;
    std::vector<char> data((std::istreambuf_iterator<char>(f)),
                           std::istreambuf_iterator<char>());
    return search::PinyinIndex::instance().init(data);
#else
    return false;
#endif
}

static bool hasName(const std::vector<data::Item>& v, const char* name) {
    for (const auto& it : v) if (it.name == name) return true;
    return false;
}

int run_search_tests() {
    using namespace search;

    CHECK(fuzzyMatch("blur", "高斯模糊") == false);
    CHECK(fuzzyMatch("模糊", "高斯模糊") == true);
    CHECK(fuzzyMatch("高糊", "高斯模糊") == true);  // 非连续子序列：跳过"斯模"命中
    CHECK(fuzzyMatch("模糊", "径向模糊") == true);
    CHECK(fuzzyMatch("", "任意") == true);
    CHECK(fuzzyMatch("模糊", "") == false);

    std::vector<data::Item> items = {
        { "高斯模糊", "effect", "模糊与锐化", "ADBE" },
        { "一键模糊", "script", "", "C:/s.jsx" },
        { "发光", "preset", "标题", "C:/p.ffx" },
        { "中心", "effect", "", "ADBE" },
        { "3D 空间", "effect", "", "ADBE" },
        { "Black Blurs", "preset", "", "C:/b.ffx" },
    };
    auto f = filterByType(items, "all");
    CHECK(f.size() == 6);
    f = filterByType(items, "effect");
    CHECK(f.size() == 3 && f[0].name == "高斯模糊");
    f = filterByType(items, "script");
    CHECK(f.size() == 1 && f[0].name == "一键模糊");

    // 空查询列表 = 最近使用按类型过滤（window.cpp rerunQuery 空分支复用 filterByType）：
    // 保持最近使用的时间倒序，类型过滤只收窄不重排
    std::vector<data::Item> recentItems = {
        { "高斯模糊", "effect", "", "ADBE" },
        { "一键模糊", "script", "", "C:/s.jsx" },
        { "中心", "effect", "", "ADBE" },
    };
    auto rf = filterByType(recentItems, "all");
    CHECK(rf.size() == 3 && rf[0].name == "高斯模糊" && rf[2].name == "中心");
    rf = filterByType(recentItems, "effect");
    CHECK(rf.size() == 2 && rf[0].name == "高斯模糊" && rf[1].name == "中心");

    auto q = query(items, "all", "模糊");
    CHECK(q.size() == 2);   // 高斯模糊 + 一键模糊
    q = query(items, "script", "");
    CHECK(q.size() == 1 && q[0].name == "一键模糊");

    // —— 拼音搜索（字典就绪后生效；未就绪时拼音 query 不命中、其余不回归）——
    bool py = initPinyinFromDictFile();
    PinyinIndex::instance().rebuild(items);
    py = py && PinyinIndex::instance().ready();

    // 全拼：zhongxin → 中心
    q = query(items, "all", "zhongxin");
    CHECK(!py || hasName(q, "中心"));
    // 首字母串：gsmh → 高斯模糊
    q = query(items, "all", "gsmh");
    CHECK(!py || hasName(q, "高斯模糊"));
    // 部分全拼：zhong → 中心
    q = query(items, "all", "zhong");
    CHECK(!py || hasName(q, "中心"));
    // 拼音路径同样裁尾随空格：zhongxin␠ → 中心
    q = query(items, "all", "zhongxin ");
    CHECK(!py || hasName(q, "中心"));
    // 首字母缩写：zx → 中心（fFirstChar）
    q = query(items, "all", "zx");
    CHECK(!py || hasName(q, "中心"));
    // 多音字词条：kongjian → 3D 空间
    q = query(items, "all", "kongjian");
    CHECK(!py || hasName(q, "3D 空间"));
    // 英文子串（大小写归一）：black → Black Blurs
    q = query(items, "all", "black");
    CHECK(!py || hasName(q, "Black Blurs"));
    // 拼音命中不破坏类型过滤：zhongxin 在 effect 下命中、script 下不命中
    q = query(items, "effect", "zhongxin");
    CHECK(!py || (q.size() == 1 && q[0].name == "中心"));
    q = query(items, "script", "zhongxin");
    CHECK(!py || q.empty());
    // 中文 query 原路径不回归（子序列匹配依旧工作）
    q = query(items, "all", "模糊");
    CHECK(q.size() == 2);
    q = query(items, "all", "高糊");
    CHECK(q.size() == 1 && q[0].name == "高斯模糊");
    // 英文子序列路径不回归（fuzzyMatch 并集）
    q = query(items, "all", "bkbr");
    CHECK(q.size() == 1 && q[0].name == "Black Blurs");
    // 无命中
    q = query(items, "all", "zzzzz");
    CHECK(q.empty());

    // —— 查询词首尾空白不计入匹配（trimQuery）——
    CHECK(trimQuery("") == "");
    CHECK(trimQuery("   ") == "");
    CHECK(trimQuery(" unmult ") == "unmult");
    CHECK(trimQuery("\tunmult\r\n") == "unmult");
    CHECK(trimQuery("unm ult") == "unm ult");            // 中间空白原样保留
    CHECK(trimQuery("高斯 模糊") == "高斯 模糊");        // 中文名里的空白同样保留
    CHECK(trimQuery("\xE3\x80\x80" "unmult" "\xE3\x80\x80") == "unmult");   // 全角空格 U+3000
    CHECK(trimQuery("\xC2\xA0" "unmult" "\xC2\xA0") == "unmult");           // 不换行空格 U+00A0
    CHECK(trimQuery(" \xE3\x80\x80 unmult") == "unmult");                   // 混合首尾空白
    // 截断/非法 UTF-8 按单字节处理：不把后面的字节吞进一个伪码点
    CHECK(trimQuery(std::string("\xE9") + " ") == std::string("\xE9"));
    CHECK(trimQuery(std::string("\xE9" "A") + " ") == std::string("\xE9" "A"));

    // —— 全角折半角（IME 全角输入不该变成「搜不到」）——
    CHECK(foldFullWidth("") == "");
    CHECK(foldFullWidth("unmult") == "unmult");
    // ｕｎｍｕｌｔ（U+FF55/U+FF4E/U+FF4D/U+FF55/U+FF4C/U+FF54）
    CHECK(foldFullWidth("\xEF\xBD\x95\xEF\xBD\x8E\xEF\xBD\x8D\xEF\xBD\x95\xEF\xBD\x8C\xEF\xBD\x94") == "unmult");
    CHECK(foldFullWidth("\xEF\xBC\xA1\xEF\xBC\xA2") == "AB");        // ＡＢ
    CHECK(foldFullWidth("\xEF\xBC\x81") == "!");                      // ！
    CHECK(foldFullWidth("\xE3\x80\x80") == " ");                      // 全角空格 → 半角空格
    CHECK(foldFullWidth("分形杂色") == "分形杂色");                    // 汉字与其它码点原样
    CHECK(normalizeQuery("\xE3\x80\x80" "\xEF\xBD\x95" "nmult" "\xE3\x80\x80") == "unmult");
    // 全角输入的查询走 query 也能命中
    std::vector<data::Item> wideItems = { { "Unmult", "effect", "", "K1" } };
    q = query(wideItems, "all", "\xEF\xBD\x95\xEF\xBD\x8E\xEF\xBD\x8D\xEF\xBD\x95\xEF\xBD\x8C\xEF\xBD\x94");
    CHECK(q.size() == 1);

    // 尾随空格不再让结果消失：三种敲法结果一致
    std::vector<data::Item> spaced = {
        { "Unmult", "effect", "抠像", "KNOLL UNMULT" },
        { "Unmult Glow", "effect", "", "X UNMULT GLOW" },
    };
    q = query(spaced, "all", "unmult");
    CHECK(q.size() == 2);
    q = query(spaced, "all", "unmult ");
    CHECK(q.size() == 2);
    q = query(spaced, "all", "  unmult  ");
    CHECK(q.size() == 2);
    // 纯空白查询与空查询同口径：返回类型过滤后的全量，不拿空格去匹配名字
    q = query(spaced, "all", "   ");
    CHECK(q.size() == 2);
    q = query(spaced, "effect", " ");
    CHECK(q.size() == 2);
    q = query(spaced, "script", " ");
    CHECK(q.empty());

    // —— 手误容错：编辑距离与长度门槛 ——
    CHECK(editDistance("unmult", "unmult", 2) == 0);
    CHECK(editDistance("nosie", "noise", 2) == 1);         // 相邻换位算 1 次编辑
    CHECK(editDistance("unmlut", "unmult", 2) == 1);
    CHECK(editDistance("bloor", "blur", 1) == 2);          // 超上限 → 返回 cap+1
    CHECK(editDistance("abc", "abcd", 0) == 1);
    CHECK(editDistance("", "abc", 2) == 3);
    CHECK(maxTypoDistance(3) == 0);
    CHECK(maxTypoDistance(4) == 1);
    CHECK(maxTypoDistance(6) == 1);
    CHECK(maxTypoDistance(7) == 2);
    CHECK(maxTypoDistance(11) == 3);

    // —— 手误容错：近似索引（英文换位 / 拼音手误 / 汉字同音错字）——
    std::vector<data::Item> typoItems = {
        { "Unmult", "effect", "抠像", "KNOLL UNMULT" },
        { "Fractal Noise", "effect", "杂色", "ADBE FRACTAL" },
        { "分形杂色", "effect", "杂色", "ADBE FRACTAL ZHS" },
        { "一键模糊脚本", "script", "", "C:/s.jsx" },
    };
    TypoIndex::instance().rebuild(typoItems);
    // 英文换位：unmlut → Unmult
    auto tg = TypoIndex::instance().suggest(typoItems, "all", "unmlut", 8);
    CHECK(!tg.empty() && tg[0].name == "Unmult");
    // 空格 + 换位：fractal nosie → Fractal Noise
    tg = TypoIndex::instance().suggest(typoItems, "all", "fractal nosie", 8);
    CHECK(!tg.empty() && tg[0].name == "Fractal Noise");
    // 拼音手误：femxongzase（fenxingzase 的两处错字）→ 分形杂色
    tg = TypoIndex::instance().suggest(typoItems, "all", "femxongzase", 8);
    CHECK(!py || (!tg.empty() && tg[0].name == "分形杂色"));
    // 汉字同音错字：分型杂色 → 分形杂色（拼音键相同）
    tg = TypoIndex::instance().suggest(typoItems, "all", "分型杂色", 8);
    CHECK(!py || (!tg.empty() && tg[0].name == "分形杂色"));
    // 类型过滤在近似路径同样生效
    tg = TypoIndex::instance().suggest(typoItems, "script", "unmlut", 8);
    CHECK(tg.empty());
    // 差得远、或查询太短（不做近似）→ 无结果
    tg = TypoIndex::instance().suggest(typoItems, "all", "zzzzzzzzzzzz", 8);
    CHECK(tg.empty());
    tg = TypoIndex::instance().suggest(typoItems, "all", "ab", 8);
    CHECK(tg.empty());

    // 装饰符号（【】等非汉字多字节字符）不进拼音键，否则键长被带偏、近似层对这类条目失效
    CHECK(!py || PinyinIndex::instance().pinyinKey("【转场】模糊") == "zhuanchangmohu");
    std::vector<data::Item> decoItems = { { "【转场】模糊", "preset", "", "D1" } };
    TypoIndex::instance().rebuild(decoItems);
    tg = TypoIndex::instance().suggest(decoItems, "all", "zhuanchangmohu", 8);
    CHECK(!py || (!tg.empty() && tg[0].name == "【转场】模糊"));

    // 条目名本身就是全角字符时：折全角查询无命中 → 按原文回退仍能搜到
    std::vector<data::Item> wideName = { { "４Ｋ 转场", "preset", "", "P1" } };
    q = query(wideName, "all", "４Ｋ");
    CHECK(q.size() == 1);

    // —— 最近使用优先排序（rankRecentFirst）——
    std::vector<data::Item> hits = {
        { "高斯模糊", "effect", "模糊与锐化", "ADBE GAUSS" },
        { "径向模糊", "effect", "模糊与锐化", "ADBE RADIAL" },
        { "发光", "preset", "标题", "C:/p/g.ffx" },
        { "一键模糊", "script", "", "C:/s.jsx" },
    };
    std::vector<data::Item> recent = {
        { "一键模糊", "script", "", "C:/s.jsx" },        // 最近一次
        { "径向模糊", "effect", "", "ADBE RADIAL" },     // 更早一次
    };
    auto rk = rankRecentFirst(hits, recent);
    CHECK(rk.size() == 4);
    CHECK(rk[0].name == "一键模糊");    // 用过 + 命中 → 第一行
    CHECK(rk[1].name == "径向模糊");    // 组内按最近使用顺序（时间倒序）
    CHECK(rk[2].name == "高斯模糊");    // 未用过：保持原相对顺序
    CHECK(rk[3].name == "发光");
    // 类型不同不算「用过」（同名不同类）：预设「发光」不该把效果「发光」带上来
    // —— 命中项放第二位，跨类误命中才会暴露成顺序变化
    rk = rankRecentFirst({ { "甲", "effect", "", "K1" },
                           { "发光", "effect", "", "ADBE GLOW" } },
                         { { "发光", "preset", "", "C:/p/g.ffx" } });
    CHECK(rk.size() == 2 && rk[0].name == "甲");
    // key 变但同名（预设源切换、AE 版本升级换路径）→ 按名兜底仍算「用过」
    rk = rankRecentFirst({ { "甲", "effect", "", "K1" },
                           { "Keylight (1.2)", "preset", "", "C:/new/K.ffx" } },
                         { { "Keylight (1.2)", "preset", "", "C:/old/K.ffx" } });
    CHECK(rk[0].name == "Keylight (1.2)");
    // 全部命中：顺序完全由最近使用决定（与数据原序相反）
    rk = rankRecentFirst({ { "B", "effect", "", "KB" }, { "A", "effect", "", "KA" } },
                         { { "A", "effect", "", "KA" }, { "B", "effect", "", "KB" } });
    CHECK(rk.size() == 2 && rk[0].name == "A" && rk[1].name == "B");
    // 空输入原样返回
    CHECK(rankRecentFirst({}, recent).empty());
    rk = rankRecentFirst(hits, {});
    CHECK(rk.size() == 4 && rk[0].name == "高斯模糊");

    if (py) std::printf("[search] pinyin index active\n");
    else    std::printf("[search] pinyin dict unavailable, pinyin cases skipped\n");

    return g_fail;
}
