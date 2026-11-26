// search.cpp — 模糊匹配实现 + 拼音索引（PinIn4Cpp）
#include "search.h"
#include "PinIn4Cpp/TreeSearcher.h"
#include <algorithm>
#include <cctype>
#include <cwchar>
#include <utility>

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

// UTF-8 码点字节数：首字节声明长度 + 续字节须为 10xxxxxx；截断或含非法续字节时按单字节，
// 保证遍历不越界、也不会把相邻字符吞进一个伪码点
static size_t utf8CharLen(const std::string& s, size_t i) {
    unsigned char c = (unsigned char)s[i];
    size_t len = 1;
    if ((c & 0xE0) == 0xC0) len = 2;
    else if ((c & 0xF0) == 0xE0) len = 3;
    else if ((c & 0xF8) == 0xF0) len = 4;
    if (i + len > s.size()) return 1;
    for (size_t k = 1; k < len; ++k) {
        if (((unsigned char)s[i + k] & 0xC0) != 0x80) return 1;
    }
    return len;
}

// 位置 i 起的一个码点是否属于首尾可裁空白
static bool isTrimSpaceAt(const std::string& s, size_t i, size_t len) {
    unsigned char c = (unsigned char)s[i];
    if (len == 1) {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f';
    }
    if (len == 2 && c == 0xC2 && (unsigned char)s[i + 1] == 0xA0) return true;   // U+00A0
    if (len == 3 && c == 0xE3 && (unsigned char)s[i + 1] == 0x80 &&
        (unsigned char)s[i + 2] == 0x80) return true;                           // U+3000
    return false;
}

std::string trimQuery(const std::string& text) {
    size_t i = 0;
    size_t begin = 0;
    size_t end = 0;
    bool any = false;
    while (i < text.size()) {
        size_t len = utf8CharLen(text, i);
        if (!isTrimSpaceAt(text, i, len)) {
            if (!any) begin = i;
            any = true;
            end = i + len;
        }
        i += len;
    }
    return any ? text.substr(begin, end - begin) : std::string();
}

// UTF-8 码点值（调用方已用 utf8CharLen 校验长度与续字节）
static unsigned int decodeUtf8(const std::string& s, size_t i, size_t len) {
    if (len == 1) return (unsigned char)s[i];
    unsigned int cp = (unsigned char)s[i] & (0x7Fu >> len);
    for (size_t k = 1; k < len; ++k) cp = (cp << 6) | ((unsigned char)s[i + k] & 0x3Fu);
    return cp;
}

std::string foldFullWidth(const std::string& text) {
    std::string out;
    out.reserve(text.size());
    size_t i = 0;
    while (i < text.size()) {
        size_t len = utf8CharLen(text, i);
        unsigned int cp = decodeUtf8(text, i, len);
        if (cp == 0x3000) out.push_back(' ');
        else if (cp >= 0xFF01 && cp <= 0xFF5E) out.push_back((char)(cp - 0xFEE0));
        else out.append(text, i, len);
        i += len;
    }
    return out;
}

std::string normalizeQuery(const std::string& text) {
    return trimQuery(foldFullWidth(text));
}

// 小写字母数字键：先折全角再丢掉空白、标点与非 ASCII 字节（"Fractal Noise" → fractalnoise，
// "４Ｋ 转场" → 4k）
static std::string alnumLower(const std::string& sIn) {
    const std::string s = foldFullWidth(sIn);
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        if (c < 0x80 && std::isalnum(c)) out.push_back((char)std::tolower(c));
    }
    return out;
}

size_t editDistance(const std::string& a, const std::string& b, size_t cap) {
    const size_t n = a.size();
    const size_t m = b.size();
    if (a == b) return 0;
    if (n == 0) return m <= cap ? m : cap + 1;
    if (m == 0) return n <= cap ? n : cap + 1;
    // 长度差已超上限：不可能落回 cap 内
    const size_t diff = n > m ? n - m : m - n;
    if (diff > cap) return cap + 1;
    // 三行滚动 DP：prev 上一行、prev2 上上行（相邻换位用）
    std::vector<size_t> prev(m + 1), cur(m + 1), prev2(m + 1, 0);
    for (size_t j = 0; j <= m; ++j) prev[j] = j;
    for (size_t i = 1; i <= n; ++i) {
        cur[0] = i;
        for (size_t j = 1; j <= m; ++j) {
            size_t v = prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1);
            if (prev[j] + 1 < v) v = prev[j] + 1;
            if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
            if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1]) {
                size_t t = prev2[j - 2] + 1;
                if (t < v) v = t;
            }
            cur[j] = v;
        }
        std::swap(prev2, prev);
        std::swap(prev, cur);
    }
    return prev[m] <= cap ? prev[m] : cap + 1;
}

size_t maxTypoDistance(size_t len) {
    if (len <= 3) return 0;
    if (len <= 6) return 1;
    if (len <= 10) return 2;
    return 3;
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

    // 键：逐码点取拼音。ASCII 字母数字收下；汉字查首读音，只收 ASCII 字母组成的读音。
    // PinIn 对字典里查不到的字符返回输入串本身，非 ASCII 结果一律丢弃——全角标点、假名、
    // 符号因此不会以原始 UTF-8 字节混进键。
    std::string key(const std::string& text) const {
        std::string out;
        size_t i = 0;
        while (i < text.size()) {
            size_t len = utf8CharLen(text, i);
            unsigned char c = (unsigned char)text[i];
            if (c < 0x80) {
                if (std::isalnum(c)) out.push_back((char)std::tolower(c));
                i += 1;
                continue;
            }
            std::string py;
            if (dict_) {
                try {
                    std::vector<std::string> v = dict_->GetPinyin(text.substr(i, len), false);
                    if (!v.empty()) py = v.front();
                } catch (...) { py.clear(); }
            }
            bool asciiLetters = !py.empty();
            for (unsigned char ch : py) {
                if (!std::isalpha(ch)) { asciiLetters = false; break; }
            }
            if (asciiLetters) {
                for (auto& ch : py) ch = (char)std::tolower((unsigned char)ch);
                out += py;
            }
            i += len;
        }
        return out;
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

std::string PinyinIndex::pinyinKey(const std::string& text) const {
    return impl_->key(text);
}

// —— 近似索引（手误容错）———————————————————————————————————————
// 条目键与 items 同序；只在数据加载后 rebuild 一次（g_items 顺序不变）。
class TypoIndex::Impl {
public:
    void rebuild(const std::vector<data::Item>& items) {
        names_.clear();
        pinyins_.clear();
        names_.reserve(items.size());
        pinyins_.reserve(items.size());
        PinyinIndex& pinyinIndex = PinyinIndex::instance();
        for (const auto& it : items) {
            names_.push_back(alnumLower(it.name));
            pinyins_.push_back(pinyinIndex.pinyinKey(it.name));
        }
        ready_ = true;
    }

    bool ready() const { return ready_; }

    std::vector<data::Item> suggest(const std::vector<data::Item>& items, const std::string& type,
                                    const std::string& queryText, size_t maxCount) const {
        std::vector<data::Item> out;
        if (!ready_ || maxCount == 0 || items.size() != names_.size()) return out;
        const std::string text = normalizeQuery(queryText);
        if (text.empty()) return out;
        const std::string qName = alnumLower(text);
        const std::string qPinyin = PinyinIndex::instance().pinyinKey(text);
        if (qName.empty() && qPinyin.empty()) return out;
        const size_t qLen = qName.size() > qPinyin.size() ? qName.size() : qPinyin.size();
        const size_t cap = maxTypoDistance(qLen);
        if (cap == 0) return out;
        std::vector<std::pair<size_t, size_t>> hits;   // 距离 + 条目下标
        for (size_t i = 0; i < items.size(); ++i) {
            if (type != "all" && items[i].type != type) continue;
            size_t best = cap + 1;
            if (!qName.empty() && !names_[i].empty()) best = editDistance(qName, names_[i], cap);
            // 汉字条目的拼音键与名字键不同；相同（纯 ASCII 名）时不重复算
            if (!qPinyin.empty() && !pinyins_[i].empty() &&
                (qPinyin != qName || pinyins_[i] != names_[i])) {
                size_t v = editDistance(qPinyin, pinyins_[i], cap);
                if (v < best) best = v;
            }
            if (best <= cap) hits.emplace_back(best, i);
        }
        std::stable_sort(hits.begin(), hits.end(),
                         [](const std::pair<size_t, size_t>& x, const std::pair<size_t, size_t>& y) {
                             return x.first < y.first;
                         });
        if (hits.size() > maxCount) hits.resize(maxCount);
        out.reserve(hits.size());
        for (const auto& h : hits) out.push_back(items[h.second]);
        return out;
    }

private:
    std::vector<std::string> names_;
    std::vector<std::string> pinyins_;
    bool ready_ = false;
};

TypoIndex& TypoIndex::instance() {
    static TypoIndex s;
    return s;
}

TypoIndex::TypoIndex() : impl_(std::make_unique<Impl>()) {}
TypoIndex::~TypoIndex() = default;
void TypoIndex::rebuild(const std::vector<data::Item>& items) { impl_->rebuild(items); }
std::vector<data::Item> TypoIndex::suggest(const std::vector<data::Item>& items,
                                           const std::string& type,
                                           const std::string& queryText,
                                           size_t maxCount) {
    return impl_->suggest(items, type, queryText, maxCount);
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

// 单次匹配：子序列 ∪ 拼音索引（text 已归一为小写口径）
static std::vector<data::Item> matchAll(const std::vector<data::Item>& filtered,
                                       const std::string& text) {
    // 拼音命中集合（就绪时一次搜索；未就绪时为空集，仅走子序列）
    const std::unordered_set<std::string>* pinyinHits = nullptr;
    if (PinyinIndex::instance().ready()) {
        // 索引内条目名与 query 双侧小写归一；类型过滤在下方逐条比对
        pinyinHits = &PinyinIndex::instance().match(toLower(text));
    }
    std::vector<data::Item> out;
    for (const auto& it : filtered) {
        bool hit = fuzzyMatch(text, it.name);
        if (!hit && pinyinHits) hit = pinyinHits->count(toLower(it.name)) > 0;
        if (hit) out.push_back(it);
    }
    return out;
}

std::vector<data::Item> query(const std::vector<data::Item>& items,
                              const std::string& type, const std::string& queryText) {
    std::vector<data::Item> filtered = filterByType(items, type);
    const std::string text = normalizeQuery(queryText);
    if (text.empty()) return filtered;
    std::vector<data::Item> out = matchAll(filtered, text);
    // 折全角后没命中：再用原文跑一遍——条目名里本来就是全角字符时
    // （"４Ｋ 转场"、"模糊（"）按原文仍能命中
    const std::string raw = trimQuery(queryText);
    if (out.empty() && raw != text) out = matchAll(filtered, raw);
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
