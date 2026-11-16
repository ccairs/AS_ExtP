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

// 类型过滤："all" 返回全量；否则只保留 type 匹配的项
std::vector<data::Item> filterByType(const std::vector<data::Item>& items,
                                     const std::string& type);

// 查询：query 为空返回过滤后全量；否则返回命中的项（保持原顺序）。
// 命中 = 原子序列匹配 ∪ 拼音匹配（zhongxin→中心 / gsmh→高斯模糊；拼音未就绪时仅子序列）
std::vector<data::Item> query(const std::vector<data::Item>& items,
                              const std::string& type, const std::string& queryText);

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
private:
    PinyinIndex();
    ~PinyinIndex();
    PinyinIndex(const PinyinIndex&) = delete;
    PinyinIndex& operator=(const PinyinIndex&) = delete;
    std::unique_ptr<PinyinIndexImpl> impl_;
};

} // namespace search
