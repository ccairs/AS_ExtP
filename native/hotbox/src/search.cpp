// search.cpp — 模糊匹配实现 + 拼音索引（PinIn4Cpp）
#include "search.h"
#include "PinIn4Cpp/TreeSearcher.h"
#include <cctype>
#include <cwchar>

#ifdef _WIN32
#include <windows.h>
#endif

namespace search {

bool fuzzyMatch(const std::string& query, const std::string& target) {
    if (query.empty()) return true;
    if (target.empty()) return false;
    size_t qi = 0;
    for (size_t ti = 0; ti < target.size() && qi < query.size(); ++ti) {
        char q = query[qi];
        char t = target[ti];
        if (q >= 'A' && q <= 'Z') q = (char)(q - 'A' + 'a');
        if (t >= 'A' && t <= 'Z') t = (char)(t - 'A' + 'a');
        if (t == q) ++qi;
    }
    return qi == query.size();
}

static std::string toLower(const std::string& s) {
    std::string out = s;
    for (auto& c : out) c = (char)std::tolower((unsigned char)c);
    return out;
}

#ifdef _WIN32
// 从本模块 RCDATA 资源 PINYIN_DICT（pinyin_dict.rc）读拼音字典；失败返回 false
static bool loadDictFromResource(std::vector<char>& out) {
    HMODULE hMod = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            (LPCWSTR)&loadDictFromResource, &hMod))
        return false;
    HRSRC hRes = FindResourceW(hMod, L"PINYIN_DICT", (LPCWSTR)RT_RCDATA);
    if (!hRes) return false;
    HGLOBAL hG = LoadResource(hMod, hRes);
    if (!hG) return false;
    const char* p = (const char*)LockResource(hG);
    DWORD size = SizeofResource(hMod, hRes);
    if (!p || !size) return false;
    out.assign(p, p + size);
    return true;
}
#else
static bool loadDictFromResource(std::vector<char>&) { return false; }
#endif

// —— 拼音索引实现 ————————————————————————————————————————————
// 字典(PinIn) 进程内一次解析；条目树(TreeSearcher) 随 rebuild 重建（共享字典）。
// put/查询 双侧小写归一（TreeSearcher 大小写敏感）；fFirstChar 开启首字母匹配（gsmh/zx）。
class PinyinIndexImpl {
public:
    bool init(const std::vector<char>& dictData) {
        if (dict_) return true;   // 已就绪，忽略重复 init
        try {
            dict_ = std::make_shared<PinInCpp::PinIn>(dictData);
            if (dict_->empty()) { dict_.reset(); return false; }
        } catch (...) {
            dict_.reset();
            return false;
        }
        return true;
    }

    void rebuild(const std::vector<data::Item>& items) {
        if (!dict_) return;
        tree_ = std::make_unique<PinInCpp::TreeSearcher>(PinInCpp::Logic::CONTAIN, dict_);
        // 首字母匹配：拼音串每字可只消费首字母（gsmh → 高斯模糊）
        PinInCpp::PinIn::Config cfg = dict_->config();
        cfg.fFirstChar = true;
        cfg.commit();
        for (const auto& it : items) tree_->put(toLower(it.name));
        ready_ = true;
    }

    bool ready() const { return ready_; }
    bool dictLoaded() const { return dict_ != nullptr; }

    const std::unordered_set<std::string>& match(const std::string& queryLower) {
        static const std::unordered_set<std::string> kEmpty;
        if (!ready_ || queryLower.empty()) return kEmpty;
        lastHits_.clear();
        for (const auto& name : tree_->ExecuteSearch(queryLower)) lastHits_.insert(name);
        return lastHits_;
    }

private:
    std::shared_ptr<PinInCpp::PinIn> dict_;
    std::unique_ptr<PinInCpp::TreeSearcher> tree_;
    std::unordered_set<std::string> lastHits_;
    bool ready_ = false;
};

PinyinIndex& PinyinIndex::instance() {
    static PinyinIndex s;
    return s;
}

PinyinIndex::PinyinIndex() : impl_(std::make_unique<PinyinIndexImpl>()) {}
PinyinIndex::~PinyinIndex() = default;

bool PinyinIndex::init(const std::vector<char>& dictData) { return impl_->init(dictData); }
bool PinyinIndex::ready() const { return impl_->ready(); }
const std::unordered_set<std::string>& PinyinIndex::match(const std::string& q) { return impl_->match(q); }

// rebuild：字典未初始化时先从模块资源加载（.aex 内嵌 pinyin.txt；单测用 init 直供）
void PinyinIndex::rebuild(const std::vector<data::Item>& items) {
    if (!impl_->dictLoaded()) {
        std::vector<char> d;
        if (!loadDictFromResource(d)) return;   // 无资源（单测环境）→ 保持未就绪
        if (!impl_->init(d)) return;            // 字典损坏 → 退化纯子序列匹配
    }
    impl_->rebuild(items);
}

// —— 查询 ————————————————————————————————————————————————————
std::vector<data::Item> filterByType(const std::vector<data::Item>& items,
                                     const std::string& type) {
    std::vector<data::Item> out;
    for (const auto& it : items) {
        if (type == "all" || it.type == type) out.push_back(it);
    }
    return out;
}

std::vector<data::Item> query(const std::vector<data::Item>& items,
                              const std::string& type, const std::string& queryText) {
    std::vector<data::Item> filtered = filterByType(items, type);
    if (queryText.empty()) return filtered;
    // 拼音命中集合（就绪时一次搜索；未就绪时为空集，仅走子序列）
    const std::unordered_set<std::string>* pinyinHits = nullptr;
    if (PinyinIndex::instance().ready()) {
        // 索引内条目名与 query 双侧小写归一；类型过滤在下方逐条比对
        pinyinHits = &PinyinIndex::instance().match(toLower(queryText));
    }
    std::vector<data::Item> out;
    for (const auto& it : filtered) {
        bool hit = fuzzyMatch(queryText, it.name);
        if (!hit && pinyinHits) hit = pinyinHits->count(toLower(it.name)) > 0;
        if (hit) out.push_back(it);
    }
    return out;
}

// —— 最近使用优先排序 ————————————————————————————————————————
// 两轮收集：先按最近使用顺序（时间倒序）取出命中的结果，再按原序补上其余。
// 不用排序器是为了天然稳定——未用过项的相对顺序完全不变，同一次最近使用命中的
// 多项（同名兜底可能命中多条）也保持数据原序。
std::vector<data::Item> rankRecentFirst(const std::vector<data::Item>& results,
                                        const std::vector<data::Item>& recent) {
    if (results.size() < 2 || recent.empty()) return results;
    std::vector<data::Item> out;
    out.reserve(results.size());
    std::vector<bool> taken(results.size(), false);
    for (const auto& rec : recent) {
        for (size_t i = 0; i < results.size(); ++i) {
            if (taken[i]) continue;
            const data::Item& it = results[i];
            if (it.type != rec.type) continue;
            if (it.key != rec.key && it.name != rec.name) continue;
            taken[i] = true;
            out.push_back(it);
        }
    }
    for (size_t i = 0; i < results.size(); ++i) {
        if (!taken[i]) out.push_back(results[i]);
    }
    return out;
}

} // namespace search
