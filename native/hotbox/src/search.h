// search.h — 模糊匹配与类型过滤（拼音索引部分依赖 PinIn4Cpp，其余纯函数可单测）
#pragma once
#include "data.h"
#include <memory>
#include <string>
#include <unordered_set>
#include <vector>

namespace search {

// 子序列匹配，不区分大小写（与 AEQuickBarScanner._fuzzyMatch 同规则）
bool fuzzyMatch(const std::string& query, const std::string& target);

// 查询词归一：裁掉首尾空白，中间空白原样保留（"unmult " 与 "unmult" 等价，
// "高斯 模糊" 不折成 "高斯模糊"）。可裁空白：ASCII 空格/制表/换行/回车/垂直制表/换页、
// 全角空格 U+3000、不换行空格 U+00A0。非法 UTF-8 字节按单字节处理，不吞相邻字符。
std::string trimQuery(const std::string& text);

// 全角 → 半角：U+FF01–U+FF5E 折成对应 ASCII 可见字符，U+3000 折成空格，其余码点原样。
// 用于 IME 全角输入（"ｕｎｍｕｌｔ" 与 "unmult" 同效）；只折查询词，不动条目名。
std::string foldFullWidth(const std::string& text);

// 检索用的查询词归一 = 先折全角、再裁首尾空白；空查询判定也用它。
std::string normalizeQuery(const std::string& text);

// 类型过滤："all" 返回全量；否则只保留 type 匹配的项
std::vector<data::Item> filterByType(const std::vector<data::Item>& items,
                                     const std::string& type);

// 查询：queryText 归一（折全角 + 裁首尾空白）后为空则返回过滤后全量；否则返回命中的项
// （保持原顺序）。命中 = 原子序列匹配 ∪ 拼音匹配（zhongxin→中心 / gsmh→高斯模糊；
// 拼音未就绪时仅子序列）。折全角后无命中时按原文再匹配一次（条目名本身就带全角字符
// 的条目仍能按原文搜到）。
std::vector<data::Item> query(const std::vector<data::Item>& items,
                              const std::string& type, const std::string& queryText);

// —— 手误容错（近似匹配）—————————————————————————————————————————
// 只在精确/子序列/拼音都没命中时用：返回与查询「最接近」的若干条。
// 比较基 = 小写字母数字名（"Fractal Noise" → fractalnoise，全角字母先折半角）与全拼串
// （汉字取首读音，ASCII 字母数字原样小写，其余码点丢弃）。查询含汉字时先把查询本身也
// 转成全拼再比——同音错字（分型杂色）因此能命中分形杂色；拼音手误（femxongzase）按编辑
// 距离命中 fenxingzase。

// 编辑距离（最优字符串对齐变体：相邻换位算 1 次编辑，不跨段换位链）；
// 长度差超 cap 或结果超 cap 时返回 cap+1
size_t editDistance(const std::string& a, const std::string& b, size_t cap);

// 查询键长度 → 允许的最大编辑距离；键长 ≤3 返回 0（不做近似）。
// 长度按归一后的键算（汉字按全拼字母数，如 "高斯模糊" = 9）。
size_t maxTypoDistance(size_t len);

// 近似索引：键随 rebuild 建一次（与 PinyinIndex 同一次数据加载时机）。
// suggest 的 items 必须是 rebuild 时那一份（同一份 g_items）——键按位置对齐，长度相同
// 但内容不同的列表会被静默错标。
class TypoIndex {
public:
    static TypoIndex& instance();
    void rebuild(const std::vector<data::Item>& items);
    // 距离 ≤ 上限的条目按距离升序返回（同距离保持条目原序），最多 maxCount 条
    std::vector<data::Item> suggest(const std::vector<data::Item>& items,
                                    const std::string& type,
                                    const std::string& queryText,
                                    size_t maxCount);
private:
    TypoIndex();
    ~TypoIndex();
    TypoIndex(const TypoIndex&) = delete;
    TypoIndex& operator=(const TypoIndex&) = delete;
    class Impl;
    std::unique_ptr<Impl> impl_;
};

// 最近使用优先排序：results 中命中 recent 的项稳定前移到最前，组内按 recent 顺序
// （时间倒序），其余项保持原有相对顺序；recent 为空时原样返回。
// 身份判定 = 同 type 且（key 相同 或 名相同）——key 是主身份（与 pushRecent 去重同源）；
// 名兜底覆盖 key 会变的场景：同一预设从 AE 预设目录换成扩展库副本、AE 版本升级后
// 预设路径整体改变（验收清单已记「换 AE 版本后预设绑定失效」），这些情况下用户认定的
// 「用过」不该丢。同名不同类的项（效果 vs 预设）不互相带出。
std::vector<data::Item> rankRecentFirst(const std::vector<data::Item>& results,
                                        const std::vector<data::Item>& recent);

// —— 拼音索引（进程级单例；内部持有 PinIn4Cpp 字典与条目名树）——
// dictData：pinyin-data 的 pinyin.txt 全文（.aex 从 RCDATA 资源加载；单测从文件读）
// init 失败（字典格式非法）时索引保持未就绪，搜索退化为纯子序列匹配
class PinyinIndexImpl;   // 隐藏 PinIn4Cpp 头，避免污染其他编译单元
class PinyinIndex {
public:
    static PinyinIndex& instance();
    bool init(const std::vector<char>& dictData);
    void rebuild(const std::vector<data::Item>& items);   // 数据加载后调用（可重复）
    bool ready() const;                                    // 字典+索引均就绪
    // 匹配：query 须为小写；返回命中的条目名集合（小写键）
    const std::unordered_set<std::string>& match(const std::string& queryLower);
    // 全拼键：汉字取首读音，ASCII 字母数字小写，其余码点丢弃（字典查不到的多字节字符
    // 也丢弃——PinIn 会把输入串原样返回，收下会把键长与编辑距离带偏）。
    // 字典未就绪时汉字部分为空（ASCII 部分照常）。
    std::string pinyinKey(const std::string& text) const;
private:
    PinyinIndex();
    ~PinyinIndex();
    PinyinIndex(const PinyinIndex&) = delete;
    PinyinIndex& operator=(const PinyinIndex&) = delete;
    std::unique_ptr<PinyinIndexImpl> impl_;
};

} // namespace search
