// data.cpp — 数据层实现
#include "data.h"
#include "json.h"
#include <cmath>
#include <cstdlib>
#include <cctype>
#include <fstream>
#include <filesystem>
#include <string>
#include <unordered_set>
#include <vector>
#include <windows.h>

namespace data {

static std::string trimStr(const std::string& s) {
    size_t b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos) return "";
    size_t e = s.find_last_not_of(" \t\r\n");
    return s.substr(b, e - b + 1);
}
static std::string lowerStr(std::string s) {
    for (auto& c : s) c = (char)std::tolower((unsigned char)c);
    return s;
}
// UTF-8 合法性校验（只用于 data-dir.txt 的内容）：被以 ANSI/GBK 保存的路径能过
// isSafeDataRoot（0x80 以上的字节不在其黑名单里），但拿去做 CreateDirectoryW /
// 找文件只会得到一串 U+FFFD 乱码路径——日志和效果库会"静默搬去别处"，比直接
// 回退默认根更难查。与 glsl-host 的 resolveDataRoot 同口径（那边用
// utf8ToWide(MB_ERR_INVALID_CHARS) 判定非法并回退默认根 + 在 effects/error.log
// 留一句提示；hotbox 静默回退——本函数在日志路径解析链上，不能反过来记日志）。
// 导出供单测覆盖（与 isSafeDataRoot 同规矩）。
bool isValidUtf8(const std::string& s) {
    const unsigned char* p = reinterpret_cast<const unsigned char*>(s.data());
    const size_t n = s.size();
    for (size_t i = 0; i < n;) {
        const unsigned char c = p[i];
        size_t extra = 0;
        unsigned int cp = 0;
        if (c < 0x80) { i++; continue; }
        else if ((c & 0xE0) == 0xC0) { extra = 1; cp = c & 0x1Fu; }
        else if ((c & 0xF0) == 0xE0) { extra = 2; cp = c & 0x0Fu; }
        else if ((c & 0xF8) == 0xF0) { extra = 3; cp = c & 0x07u; }
        else return false;                       // 续字节/5-6 字节序列：非法
        if (i + extra >= n) return false;        // 截断
        for (size_t k = 1; k <= extra; k++) {
            const unsigned char cc = p[i + k];
            if ((cc & 0xC0) != 0x80) return false;
            cp = (cp << 6) | (cc & 0x3Fu);
        }
        if (extra == 1 && cp < 0x80u) return false;                       // 过短编码
        if (extra == 2 && cp < 0x800u) return false;
        if (extra == 3 && (cp < 0x10000u || cp > 0x10FFFFu)) return false; // 超范围
        if (cp >= 0xD800u && cp <= 0xDFFFu) return false;                  // 代理区
        i += extra + 1;
    }
    return true;
}
// 与客户端 AEFS.isDataDirSafe 对齐的安全校验（防外部篡改指针文件）：
// ① 格式：拒 %、控制字符、引号、DOS 设备名段、相对逃逸
// ② 系统目录：转小写后匹配 Windows/Program Files/ProgramData/Users 等关键词（补齐 Users）
// 非 static 导出供 test_data.cpp 单测覆盖
bool isSafeDataRoot(const std::string& p) {
    // 绝对路径：必须以盘符开头，且盘符后紧跟 \ 或 /（与客户端 ^[A-Za-z]:/ 一致，拒 X:foo 无分隔符写法）
    if (p.size() < 3 || !(isalpha((unsigned char)p[0]) && p[1] == ':')) return false;
    if (p[2] != '\\' && p[2] != '/') return false;
    if (p.find("..\\") != std::string::npos || p.find("../") != std::string::npos) return false;
    if (p.size() == 3) return false; // 盘根 C:\（保留原有盘根兜底）
    for (size_t i = 0; i < p.size(); i++) {
        unsigned char c = (unsigned char)p[i];
        if (c == '%' || c == '"' || c == '\'') return false;
        if (c <= 0x1F || c == 0x7F) return false;
    }
    // DOS 设备名段（NUL/CON/PRN/AUX/COM1-9/LPT1-9，段内去扩展名判断）
    {
        std::string lc = lowerStr(p);
        size_t start = 0;
        while (start <= lc.size()) {
            size_t cut = lc.find_first_of("\\/", start);
            std::string seg = lc.substr(start, (cut == std::string::npos ? lc.size() : cut) - start);
            size_t dot = seg.find('.');
            std::string base = (dot == std::string::npos) ? seg : seg.substr(0, dot);
            if (base == "nul" || base == "con" || base == "conin$" || base == "conout$" ||
                base == "prn" || base == "aux" ||
                (base.size() == 4 && base.substr(0, 3) == "com" && base[3] >= '1' && base[3] <= '9') ||
                (base.size() == 4 && base.substr(0, 3) == "lpt" && base[3] >= '1' && base[3] <= '9')) return false;
            if (cut == std::string::npos) break;
            start = cut + 1;
        }
    }
    // 独立 . / .. 段 → 目录穿越（与客户端 _checkPath ③ 一致，含尾部无斜杠的 ..）
    {
        size_t start = 0;
        while (start <= p.size()) {
            size_t cut = p.find_first_of("\\/", start);
            std::string seg = p.substr(start, (cut == std::string::npos ? p.size() : cut) - start);
            if (seg == "." || seg == "..") return false;
            if (cut == std::string::npos) break;
            start = cut + 1;
        }
    }
    // 系统目录：与客户端 _isSystemOrRootDir 同口径 —— 盘符后第一段匹配
    // Windows/Program Files/(x86)/ProgramData 直接拒；Users 仅拒 depth≤2
    // （C:\Users / C:\Users\<profile>，不挡 C:\Users\<profile>\...\AE_Data 深处自定义目录）。
    // 额外纵深：任意位置含 \windows.old / \system volume information 也拒。
    // 段级归一化后再判定：
    //   ① / → \（拦 "C:/Windows.old/x" 正斜杠绕过 \windows.old 子串检查）
    //   ② 剥每段尾随 . 与空格（Windows 剥尾语义，拦 "C:\Windows \x"/"C:\Windows.\x"；
    //      段中含 ".." 子串不受影响——仅剥尾部）
    //   ③ 拒 8.3 短名段（progra~1/window~1 形态：解析后可能指向系统目录，
    //      合法数据目录不会含 8.3 短名段）
    {
        std::string norm = p;
        for (size_t i = 0; i < norm.size(); i++) if (norm[i] == '/') norm[i] = '\\';
        {
            std::string out;
            size_t start = 0;
            while (start <= norm.size()) {
                size_t cut = norm.find('\\', start);
                std::string seg = norm.substr(start, (cut == std::string::npos ? norm.size() : cut) - start);
                size_t e = seg.find_last_not_of(". ");
                seg = (e == std::string::npos) ? std::string() : seg.substr(0, e + 1);
                if (!out.empty()) out += '\\';
                out += seg;
                if (cut == std::string::npos) break;
                start = cut + 1;
            }
            norm = out;
        }
        std::string fc = lowerStr(norm);
        // ③ 8.3 短名段：^[a-z0-9]{1,6}~[0-9]{1,2}$
        {
            size_t start = 0;
            while (start <= fc.size()) {
                size_t cut = fc.find('\\', start);
                std::string seg = fc.substr(start, (cut == std::string::npos ? fc.size() : cut) - start);
                size_t tilde = seg.find('~');
                if (tilde != std::string::npos && tilde >= 1 && tilde <= 6
                    && seg.size() - tilde - 1 >= 1 && seg.size() - tilde - 1 <= 2) {
                    bool ok = true;
                    for (size_t i = 0; i < tilde; i++)
                        if (!isalnum((unsigned char)seg[i])) { ok = false; break; }
                    for (size_t i = tilde + 1; i < seg.size() && ok; i++)
                        if (!isdigit((unsigned char)seg[i])) { ok = false; }
                    if (ok) return false;
                }
                if (cut == std::string::npos) break;
                start = cut + 1;
            }
        }
        size_t colon = fc.find(':');
        std::string tail = (colon == std::string::npos) ? fc : fc.substr(colon + 1);
        size_t s0 = tail.find_first_not_of("\\/");
        if (s0 == std::string::npos) return false; // 盘符后无内容（盘根兜底）
        size_t cut = tail.find_first_of("\\/", s0);
        std::string first = tail.substr(s0, (cut == std::string::npos) ? std::string::npos : cut - s0);
        if (first == "windows" || first == "program files" || first == "program files (x86)" || first == "programdata") return false;
        // 深度 = 盘符后的非空路径段数（与客户端 _depthOk 一致：忽略首尾/连续斜杠，
        // 避免 C:\Boot\ 这类带尾斜杠路径被误判为 depth≥2 而放行）
        size_t dep = 0;
        bool inSeg = false;
        for (size_t i = s0; i < tail.size(); i++) {
            if (tail[i] == '\\' || tail[i] == '/') inSeg = false;
            else if (!inSeg) { dep++; inSeg = true; }
        }
        if (first == "users" && dep <= 2) return false;
        // 系统盘(C:) 深度兜底：depth≥2（挡 C:\Boot/C:\Recovery/C:\$Recycle.Bin 等黑名单列不全的浅层系统目录，
        // 与客户端 isDataDirSafe 的 minDepth=2 一致）；非系统盘 depth≥1 恒满足（盘根已在上方拒绝）。
        if (fc[0] == 'c' && dep < 2) return false;
        if (fc.find("\\windows.old") != std::string::npos ||
            fc.find("\\system volume information") != std::string::npos) return false;
    }
    return true;
}

// 返回当前数据根目录（含 AS_ExtP）。默认 %APPDATA%\Adobe\CEP\extensions\AS_ExtP，
// 若固定位置指针文件（data-dir.txt）存在且合法则返回自定义数据根目录 —— 跟随
// 「扩展数据目录」设置，与客户端 AEShared.getDataDir() 保持一致。
// 返回值统一 UTF-8：getenv 窄串是 ANSI(GBK) 编码（中文用户名乱码），必须
// _wgetenv 拿宽串；data-dir.txt 由扩展端写入（UTF-8），安全校验按字节匹配不受影响
std::string defaultDataDir() {
    const wchar_t* wappdata = _wgetenv(L"APPDATA");
    if (!wappdata) return "";
    std::wstring wdef = std::wstring(wappdata) + L"\\Adobe\\CEP\\extensions\\AS_ExtP";
    std::ifstream f(std::filesystem::path(wdef) / L"data-dir.txt", std::ios::binary);
    if (!f) return wideToUtf8(wdef);
    std::string ptr((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    ptr = trimStr(ptr);
    // 非法 UTF-8（GBK 保存的中文路径）与非法路径同待遇：回退默认根，理由见 isValidUtf8 头注
    if (ptr.empty() || !isSafeDataRoot(ptr) || !isValidUtf8(ptr)) return wideToUtf8(wdef);
    return ptr;
}

std::wstring utf8ToWide(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w;
    w.resize(n);
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}

std::string wideToUtf8(const std::wstring& s) {
    if (s.empty()) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0, nullptr, nullptr);
    std::string out;
    out.resize(n);
    WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), &out[0], n, nullptr, nullptr);
    return out;
}

std::string ansiToUtf8(const std::string& s, unsigned int codePage) {
    if (s.empty()) return s;
    int n = MultiByteToWideChar(codePage, 0, s.c_str(), (int)s.size(), nullptr, 0);
    if (n <= 0) return s;   // 码页不可用：原样返回，调用方按原字节使用
    std::wstring w;
    w.resize(n);
    if (MultiByteToWideChar(codePage, 0, s.c_str(), (int)s.size(), &w[0], n) <= 0) return s;
    return wideToUtf8(w);
}

bool isAnsiBatch(const std::vector<std::string>& texts) {
    for (const auto& t : texts) {
        bool nonAscii = false;
        for (size_t i = 0; i < t.size(); ++i) {
            if ((unsigned char)t[i] >= 0x80) { nonAscii = true; break; }
        }
        // 含非 ASCII 的串必须能证伪 UTF-8 才算「这批是 ANSI」；纯 ASCII 串在两种编码下字节相同
        if (nonAscii && !isValidUtf8(t)) return true;
    }
    return false;
}

std::vector<Item> parseEffects(const std::string& jsonText) {
    std::vector<Item> out;
    if (jsonText.empty()) return out;
    json::Value root;
    if (!json::parse(jsonText.c_str(), jsonText.size(), &root)) return out;
    const json::Value& cats = root["categories"];
    for (size_t i = 0; i < cats.size(); ++i) {
        const json::Value& cat = cats[i];
        std::string catName = cat["category"].str;
        const json::Value& effects = cat["effects"];
        for (size_t j = 0; j < effects.size(); ++j) {
            Item it;
            it.name = effects[j]["name"].str;
            it.type = "effect";
            it.category = catName;
            it.key = effects[j]["matchName"].str;
            if (!it.name.empty() && !it.key.empty()) out.push_back(std::move(it));
        }
    }
    return out;
}

std::vector<Item> parsePresets(const std::string& jsonText) {
    std::vector<Item> out;
    if (jsonText.empty()) return out;
    json::Value root;
    if (!json::parse(jsonText.c_str(), jsonText.size(), &root)) return out;
    const json::Value& items = root["items"];
    for (size_t i = 0; i < items.size(); ++i) {
        const json::Value& it = items[i];
        // 归档条目（archived=true，实体已移入 ___archive__ 且 7 天后被物理清理）不进热盒——
        // 与面板 quickBarScanner 的自检同口径、与 presetStore 的 _isArch 同判据。
        // 不滤掉的后果在预设双源合并后被放大：库优先会让归档条目顶掉 AE 侧同名同大小的
        // 真条目，等归档清理掉就成了"预设文件不存在"。
        const json::Value& arch = it["archived"];
        if (arch.type == json::Value::kBool && arch.b) continue;
        Item item;
        item.name = it["name"].str;
        item.type = "preset";
        item.category = it["folder"].str;
        item.key = it["ffxPath"].str;
        // size 参与去重键（见 presetDedupeKey）：索引缺 size 时留 0，由 fillItemSizes 补查。
        // 非有限/超范围值不转换（对齐 config.cpp 的 double→整型防护），按未知处理。
        const json::Value& sz = it["size"];
        if (sz.type == json::Value::kNumber && std::isfinite(sz.num) && sz.num > 0 &&
            sz.num < 1.8e19) {
            item.size = (unsigned long long)sz.num;
        }
        if (!item.name.empty() && !item.key.empty()) out.push_back(std::move(item));
    }
    return out;
}

Item makeScriptItem(const std::string& name, const std::string& relPath, const std::string& absPath) {
    Item it;
    it.name = name;
    it.type = "script";
    it.category = relPath;   // 相对文件夹路径
    it.key = absPath;
    return it;
}

// 判定 .jsx / .jsxbin 脚本文件（小写后缀比较）。
// .jsxbin 是 7 字符：按 6 字符比较永不命中，且 size-6 在 4~5 字符
// 文件名上无符号下溢 → compare 抛 out_of_range 崩溃（见 test_data.cpp 回归用例）
bool isScriptFile(const std::string& name) {
    std::string lower = name;
    for (auto& ch : lower) if (ch >= 'A' && ch <= 'Z') ch = (char)(ch - 'A' + 'a');
    if (lower.size() >= 7 && lower.compare(lower.size() - 7, 7, ".jsxbin") == 0) return true;
    return lower.size() >= 4 && lower.compare(lower.size() - 4, 4, ".jsx") == 0;
}

// 判定 .ffx 预设文件（同 isScriptFile 的写法与下溢防护：4 字符后缀，长度不足即不比较）
bool isFfxFile(const std::string& name) {
    std::string lower = name;
    for (auto& ch : lower) if (ch >= 'A' && ch <= 'Z') ch = (char)(ch - 'A' + 'a');
    return lower.size() >= 4 && lower.compare(lower.size() - 4, 4, ".ffx") == 0;
}

// ================= 数据根相对 key =================
// 与面板侧 client/shared/dataDir.js 的 toDataRelPath/fromDataRelPath 同一约定：
// 数据根内 → 相对（正斜杠）；根外/已是相对/空根 → 原样。大小写不敏感比较（Windows
// 路径身份）。只在持久化边界（config.json / recent.json 读写）调用。

namespace {
// 反斜杠 → 正斜杠 + 去尾斜杠（比较与相对化都用正斜杠形态）
std::string normSlashes(const std::string& p) {
    std::string s;
    s.reserve(p.size());
    for (char c : p) s.push_back(c == '\\' ? '/' : c);
    while (!s.empty() && s.back() == '/') s.pop_back();
    return s;
}
// 绝对路径判据：盘符（X:）/ UNC（\\ 或 //）
bool isAbsPath(const std::string& p) {
    if (p.size() >= 2 && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z')) && p[1] == ':') return true;
    if (p.size() >= 2 && p[0] == '\\' && p[1] == '\\') return true;
    if (p.size() >= 2 && p[0] == '/' && p[1] == '/') return true;
    return false;
}
// 大小写不敏感前缀比较（按字节 ASCII 折叠；路径段比较只关心 ASCII 大小写）
bool prefixEqCI(const std::string& s, const std::string& prefix) {
    if (s.size() < prefix.size()) return false;
    for (size_t i = 0; i < prefix.size(); ++i) {
        char a = s[i], b = prefix[i];
        if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
        if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
        if (a != b) return false;
    }
    return true;
}
}  // namespace

std::string toRelKey(const std::string& root, const std::string& key) {
    if (root.empty() || key.empty()) return key;
    if (!isAbsPath(key)) return key;              // 已是相对（或非路径）→ 原样
    std::string r = normSlashes(root);
    if (r.empty()) return key;
    std::string k = normSlashes(key);
    // 完整路径段匹配：...\data 不得匹配 ...\data2\...
    if (k.size() > r.size() && k[r.size()] == '/' && prefixEqCI(k, r)) {
        return k.substr(r.size() + 1);
    }
    return key;                                   // 根外 → 原样
}

std::string fromRelKey(const std::string& root, const std::string& key) {
    if (key.empty() || isAbsPath(key)) return key;
    std::string r = normSlashes(root);
    if (r.empty()) return key;                    // 根不可用：原样（与改造前行为一致）
    std::string k = normSlashes(key);
    size_t i = 0;
    while (i < k.size() && k[i] == '/') ++i;      // 去掉开头多余分隔符
    return r + "/" + k.substr(i);
}

// ================= 预设双源（扩展库 + AE 预设目录） =================

// 去重键：小写名 + '\t' + 字节数。语义与代价见 data.h「同名同大小 = 同一预设」。
// 用 '\t' 分隔（文件名不允许含制表符，不会与名字撞键）。
std::string presetDedupeKey(const Item& it) {
    return lowerStr(it.name) + "\t" + std::to_string(it.size);
}

std::vector<Item> mergePresetsDedup(const std::vector<Item>& preferred,
                                    const std::vector<Item>& secondary) {
    std::vector<Item> out = preferred;
    std::unordered_set<std::string> seen;
    seen.reserve(preferred.size() + secondary.size());
    for (const auto& it : preferred) seen.insert(presetDedupeKey(it));
    for (const auto& it : secondary) {
        if (seen.insert(presetDedupeKey(it)).second) out.push_back(it);
    }
    return out;
}

std::vector<FfxFile> listFfxFiles(const std::string& root) {
    std::vector<FfxFile> out;
    if (root.empty()) return out;      // 空根 = 无此数据源（AE 预设目录缺失是常态，不是错误）
    // 与 window.cpp 脚本树枚举同口径：迭代式（pending 队列）+ 跳过重解析点防止
    // junction/符号链接造成的无限增长；该路径在 AE 主线程同步执行。
    std::vector<std::string> pending = { root };
    for (size_t idx = 0; idx < pending.size(); ++idx) {
        std::wstring pattern = utf8ToWide(pending[idx]) + L"\\*";
        WIN32_FIND_DATAW fd;
        HANDLE h = FindFirstFileW(pattern.c_str(), &fd);
        if (h == INVALID_HANDLE_VALUE) continue;   // 目录不存在/不可读：跳过
        do {
            if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) continue;
            std::string fn = wideToUtf8(fd.cFileName);
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                pending.push_back(pending[idx] + "\\" + fn);
            } else if (isFfxFile(fn)) {
                FfxFile f;
                f.absPath = pending[idx] + "\\" + fn;
                f.size = ((unsigned long long)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
                out.push_back(std::move(f));
            }
        } while (FindNextFileW(h, &fd));
        FindClose(h);
    }
    return out;
}

std::vector<Item> presetItemsFromFiles(const std::string& root, const std::vector<FfxFile>& files) {
    std::vector<Item> out;
    out.reserve(files.size());
    std::string base = root;
    for (auto& c : base) if (c == '/') c = '\\';
    while (base.size() > 3 && base.back() == '\\') base.pop_back();
    for (const auto& f : files) {
        // 前缀比较用分隔符归一化（'/'→'\'）副本：调用方可能传正斜杠路径，比较失败会把
        // 属于该 root 的条目误判成「root 外」而丢掉 folder（key 仍保留调用方给的原样路径）
        std::string abs = f.absPath;
        for (auto& c : abs) if (c == '/') c = '\\';
        size_t slash = abs.find_last_of('\\');
        std::string fn = (slash == std::string::npos) ? abs : abs.substr(slash + 1);
        if (fn.empty() || !isFfxFile(fn)) continue;
        Item it;
        it.type = "preset";
        it.name = fn.substr(0, fn.size() - 4);      // 去 .ffx（isFfxFile 已保证后缀存在）
        it.key = f.absPath;
        it.size = f.size;
        // category = 相对 root 的文件夹（"/" 分隔，与扩展库索引的 folder 字段同形）。
        // 前缀必须落在分隔符上（abs[base.size()] == '\\'）：否则同前缀的兄弟目录
        // （root=E:\AE\Presets 遇上 E:\AE\Presets2\x.ffx）会被误判成"root 内"。
        // 前缀不匹配（调用方传了不属于该 root 的路径）时留空——不猜，避免出现 lib 侧
        // _inPresets 那种"索引被篡改后 category 指向别处"的错位。
        if (!base.empty() && abs.size() > base.size() + 1 && abs[base.size()] == '\\' &&
            lowerStr(abs.substr(0, base.size())) == lowerStr(base)) {
            std::string rel = abs.substr(base.size() + 1);
            size_t rs = rel.find_last_of('\\');
            if (rs != std::string::npos) {
                std::string folder = rel.substr(0, rs);
                for (auto& c : folder) if (c == '\\') c = '/';
                it.category = folder;
            }
        }
        out.push_back(std::move(it));
    }
    return out;
}

std::vector<Item> scanPresetDir(const std::string& root) {
    return presetItemsFromFiles(root, listFfxFiles(root));
}

// 索引 size 按真实文件校准（语义与代价见 data.h）：去重键含字节数，而索引里的 size 是
// 入库那一刻的快照——文件被替换/删除后它就是错的。库通常几十~几百条，每次重载各查一次
// 属性即可（重载由数据源签名闸门控制，不是每次弹出）。
void fillItemSizes(std::vector<Item>& items) {
    for (auto& it : items) {
        WIN32_FILE_ATTRIBUTE_DATA fad = {};
        if (!it.key.empty() &&
            GetFileAttributesExW(utf8ToWide(it.key).c_str(), GetFileExInfoStandard, &fad) &&
            !(fad.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
            it.size = ((unsigned long long)fad.nFileSizeHigh << 32) | fad.nFileSizeLow;
        } else {
            it.size = 0;   // 文件不在（或不是文件）：按"未知"处理，不参与折叠
        }
    }
}

// ================= AE 安装根 / 预设目录定位 =================

// 由插件模块路径推导安装根：段序列里找「Support Files」+「Plug-ins」相邻段，其前即安装根。
// 为什么用模块路径而不是问 AE：热盒每次弹出都要算数据源签名（含预设目录树），走
// AEGP_ExecuteScript 问 app.path 是同步跨语言往返；模块路径是零成本且对"正在运行的这个
// AE"天然精确（插件就装在它自己的 Plug-ins 下）。装在 MediaCore 等别处时返回空，
// 由调用方用 app.path 兜底（与扩展 ae-tools getInstallPath 的 S1 同源）。
std::string aeInstallRootFromModulePath(const std::string& modulePath) {
    if (modulePath.empty()) return "";
    std::string p = modulePath;
    for (auto& c : p) if (c == '/') c = '\\';
    std::vector<std::string> segs;
    size_t start = 0;
    while (start <= p.size()) {
        size_t cut = p.find('\\', start);
        segs.push_back(p.substr(start, cut == std::string::npos ? std::string::npos : cut - start));
        if (cut == std::string::npos) break;
        start = cut + 1;
    }
    // i 从 1 起：盘符段（"E:"）之前没有安装根可言
    for (size_t i = 1; i + 1 < segs.size(); ++i) {
        if (lowerStr(segs[i]) != "support files" || lowerStr(segs[i + 1]) != "plug-ins") continue;
        std::string root;
        for (size_t k = 0; k < i; ++k) {
            if (k) root += '\\';
            root += segs[k];
        }
        return root;
    }
    return "";
}

// 规范 AE 自报路径（app.path，正斜杠）→ 安装根：统一反斜杠、剥尾随分隔符、
// 已含 Support Files 段时截到其前、非「盘符:」开头的绝对路径一律判为不可判定。
std::string normalizeAeInstallRoot(const std::string& reportedPath) {
    std::string p = trimStr(reportedPath);
    if (p.empty()) return "";
    for (auto& c : p) if (c == '/') c = '\\';
    while (p.size() > 3 && p.back() == '\\') p.pop_back();
    size_t at = lowerStr(p).find("\\support files");
    if (at != std::string::npos) {
        p = p.substr(0, at);
        while (p.size() > 3 && p.back() == '\\') p.pop_back();
    }
    if (p.size() < 3 || p[1] != ':') return "";   // 非绝对路径（无盘符）
    return p;
}

// 安装根 → Documents\Adobe 下的用户预设目录名："Adobe After Effects 2023" → "After Effects 2023"。
// 段名不含 "After Effects" 时返回空（无法判定即不纳入该数据源，而不是猜一个目录）。
std::string aeUserPresetsSubdir(const std::string& installRoot) {
    if (installRoot.empty()) return "";
    std::string p = installRoot;
    for (auto& c : p) if (c == '/') c = '\\';
    while (p.size() > 3 && p.back() == '\\') p.pop_back();
    size_t cut = p.find_last_of('\\');
    std::string seg = (cut == std::string::npos) ? p : p.substr(cut + 1);
    if (seg.empty()) return "";
    if (lowerStr(seg).rfind("adobe ", 0) == 0) seg = seg.substr(6);   // 剥 "Adobe " 前缀，保留原大小写
    if (lowerStr(seg).find("after effects") == std::string::npos) return "";
    return seg;
}

// 用户预设目录（AE 的"User Presets"分类）：Documents 可能被 OneDrive 重定向，
// 故按 USERPROFILE → OneDrive 变体的顺序取首个真实存在的候选（不引 shell32：
// 已知文件夹 API 需 CoTaskMemFree/额外链接，这里用环境变量即可覆盖主流布局）。
std::string userPresetsDir(const std::string& subdir) {
    if (subdir.empty()) return "";
    static const wchar_t* kDocEnvs[] = {
        L"USERPROFILE", L"OneDrive", L"OneDriveCommercial", L"OneDriveConsumer"
    };
    for (const wchar_t* e : kDocEnvs) {
        const wchar_t* v = _wgetenv(e);
        if (!v || !*v) continue;
        std::string cand = wideToUtf8(v) + "\\Documents\\Adobe\\" + subdir + "\\User Presets";
        if (dirExists(cand)) return cand;
    }
    return "";
}

std::string aeStockPresetsDir(const std::string& installRoot) {
    if (installRoot.empty()) return "";
    return installRoot + "\\Support Files\\Presets";
}

// 插件自身模块路径：以本函数地址反查所属模块（MSDN 的 GetModuleHandleEx 用法），
// 避免为了拿 hInstance 去动 DllMain/entry.cpp。
std::string currentModulePath() {
    HMODULE hm = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            reinterpret_cast<LPCWSTR>(&currentModulePath), &hm) || !hm) {
        return "";
    }
    std::vector<wchar_t> buf(4096);
    DWORD n = GetModuleFileNameW(hm, buf.data(), (DWORD)buf.size());
    if (n == 0 || n >= (DWORD)buf.size()) return "";   // 0=失败；达容量=被截断（不返回半截路径）
    return wideToUtf8(std::wstring(buf.data(), n));
}

bool dirExists(const std::string& path) {
    if (path.empty()) return false;
    DWORD a = GetFileAttributesW(utf8ToWide(path).c_str());
    return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

} // namespace data
