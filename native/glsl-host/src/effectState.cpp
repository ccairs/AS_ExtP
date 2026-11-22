#include "effectState.h"
#include "glslLoader.h"
#include "errorLog.h"
#include "uniformParser.h"
#include "i18n.h"
#include <cstdio>
#include <cstdlib>
#include <cctype>
#include <cwctype>
#include <filesystem>
#include <algorithm>
#include <fstream>
#include <string>

namespace host {

GlobalState& globalState() {
    // 不依赖 NRVO：return gs 按值返回若拷贝省略不生效，按字节拷贝已初始化的
    // CRITICAL_SECTION 属未定义行为（Debug /Od 构建真实走拷贝）。改为先默认构造 s，
    // 再由 s_init 原地初始化锁——同一函数内两个 static 按声明顺序初始化，
    // magic static 保证线程安全（与 renderer.cpp 的 g_glCS/g_glCSInit 同构）。
    static GlobalState s;
    static bool s_init = [&]() { InitializeCriticalSection(&s.mutex); return true; }();
    return s;
}

// —— 数据根目录解析：跟随「扩展数据目录」设置 ——
// 宿主是原生插件，读不到 CEP 面板的 localStorage 设置，只能通过固定位置的
// 指针文件（%APPDATA%\...\AS_ExtP\data-dir.txt）获知用户自定义的数据根目录。
// 内容为数据根目录（如 D:\AE_Data\AS_ExtP），空/缺失/非法 = 回退默认 APPDATA。
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
// 与客户端 AEFS.isDataDirSafe 对齐的安全校验（防外部篡改指针文件）：
// ① 格式：拒 %、控制字符、引号、DOS 设备名段、相对逃逸
// ② 系统目录：转小写后匹配 Windows/Program Files/ProgramData/Users 等关键词（补齐 Users）
static bool isSafeDataRoot(const std::string& p) {
    if (p.size() < 3) return false;
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
// 数据根目录绝对路径（含 AS_ExtP）：默认 %APPDATA%\Adobe\CEP\extensions\AS_ExtP，
// 若指针文件存在且合法则返回自定义根目录。
// getenv 窄串是 ANSI(GBK)（中文用户名乱码），须 _wgetenv 拿宽串再转 UTF-8
// （与 hotbox data.cpp 一致）：本项目内部路径统一 UTF-8，文件访问统一走宽路径
//
// 解析结果缓存。每次调用都完整读一遍 data-dir.txt（ifstream
// 开/读/关）——调用链 renderer.cpp 每帧渲染 + customUI.cpp 每 ECW 控件每次
// DRAW 各一次，播放期每秒数百次磁盘打开（I/O 风暴）。改用 FileWatcher 监视
// 指针文件：属性（size+mtime）未变走零读盘快路径，内容变化立即失效重读
// （客户端改 data-dir.txt 即时生效；同 size 同 mtime 的连续写入由 watcher 的
// 2s 强制内容校验兜底）。按指针文件路径各自独立缓存（测试可用可控路径直接
// 覆盖 resolveDataRoot）。
struct DataRootCacheEntry {
    glsl::FileWatcher watcher;   // 指针文件监视（stat 快路径 + 2s 内容校验）
    std::string resolved;        // 最近一次解析结果
    bool seeded = false;         // 是否已绑定 watcher 路径（首次调用初始化）
};
// 构造即用（函数局部静态），不用文件作用域全局：本缓存经 resolveDataRoot
// 被 **DLL 静态初始化期**调用（plugin.cpp 的 CrashHandlerInit 预开崩溃句柄 →
// diagLogFilePath → dataRootDirPath），而文件作用域 std::map 的动态初始化跨 TU
// 顺序未定义；早于它构造时取下标 = 在未初始化内存上操作 → DLL 初始化例程失败
// （LoadLibrary 1114，AE 报「由于无法初始化，因此无法应用此效果」(25::3)）。
static std::map<std::string, DataRootCacheEntry>& dataRootCacheImpl() {
    static std::map<std::string, DataRootCacheEntry> m;
    return m;
}

std::string resolveDataRoot(const std::string& defRoot) {
    const std::string ptrFile = defRoot + "\\data-dir.txt";
    auto& gs = globalState();
    // 锁内解析：MFR 渲染线程与 UI 线程并发调用（stat 命中时纳秒级，开销可忽略）
    CSLock lk(gs.mutex);
    DataRootCacheEntry& c = dataRootCacheImpl()[ptrFile];
    if (!c.seeded) {
        c.watcher.setPath(ptrFile);
        c.seeded = true;
        c.resolved = defRoot;   // 缺失/空指针文件的默认值
    }
    if (c.watcher.needsReload()) {
        // 首次或指针文件变化：内容已由 watcher 读入（避免二次读文件撞写盘
        // 截断窗口）；非法/空 → 回退默认根
        const std::string ptr = trimStr(c.watcher.lastContent());
        // 读取后先做 UTF-8 合法性校验。isSafeDataRoot 只拒 %/引号/控制
        // 字符，GBK（ANSI 记事本）写的中文路径字节 0x80-0xFF 不受检；若放行，
        // utf8ToWide 会把它替换成 U+FFFD → scanEffectsDir 打不开静默返回空
        // → 选择器空、渲染透传、error.log 无任何记录。非空内容转宽得空串
        // = 非法 UTF-8（utf8ToWide 挂 MB_ERR_INVALID_CHARS）：拒绝回退默认根，
        // error.log 记录并提示用 UTF-8 保存（写默认根的 effects/，即回退后
        // 面板实际读取的目录；不可调 effectsDirPath——会经 dataRootDirPath
        // 重入本函数并死锁于 gs.mutex）
        if (!ptr.empty() && glsl::utf8ToWide(ptr).empty()) {
            appendErrorLog(defRoot + "\\effects",
                Tr(S_EFFECTHOST_EFFECTSTATE_ERROR_DATADIR_UTF8));
            c.resolved = defRoot;
        } else {
            c.resolved = (ptr.empty() || !isSafeDataRoot(ptr)) ? defRoot : ptr;
        }
    }
    // 指针文件被删除/清空时必须回退默认根——既有契约
    // "指针文件删除 → 宿主回退默认目录"。watcher 的空读不消费状态是防写盘
    // 截窗设计，单靠 needsReload 会把 resolved 永久锁定旧自定义根（文件已
    // 不存在仍读旧根）。截窗瞬态回退与每帧读、空即回退的行为一致。
    if (c.resolved != defRoot && c.watcher.emptyOrMissing()) {
        c.resolved = defRoot;
        // 重置 watcher：旧内容已随文件消失作废——文件重建（即使内容与旧值
        // 相同）时强制重读，否则 hasSeen_ 属性快路径会吞掉重建事件
        c.watcher.setPath(ptrFile);
    }
    return c.resolved;
}

std::string dataRootDirPath() {
    const wchar_t* wappdata = _wgetenv(L"APPDATA");
    if (!wappdata) return "";
    std::string def = glsl::wideToUtf8(
        std::wstring(wappdata) + L"\\Adobe\\CEP\\extensions\\AS_ExtP");
    return resolveDataRoot(def);
}

// effects/ 目录绝对路径：数据根目录\effects
std::string effectsDirPath() {
    std::string root = dataRootDirPath();
    if (root.empty()) return "";
    return root + "\\effects";
}

// uniform 结构签名（"type|name;..." 串）：SyncParamUI 检测 uniform 结构
// （类型/顺序/数量）变化的核心机制（自 plugin.cpp 迁入：loadEffectFile 与
// SyncParamUI 共用同一算法，且 effectState 需在测试中直接覆盖）
std::string uniformSignature(const std::vector<glsl::Param>& params) {
    std::string sig;
    for (size_t i = 0; i < params.size(); ++i) {
        sig += static_cast<char>('0' + static_cast<int>(params[i].type));
        sig += '|';
        sig += params[i].name;
        sig += ';';
    }
    return sig;
}

// 索引 → 文件绝对路径（全部为库文件）。越界钳制回第一个库文件（kDefaultFileIndex，
// 与旧 syncSelectedFileIndex 的"回退第一个库文件，而非静默透传无效果"语义一致）；
// 空库返回空串（渲染走透传）。一次加锁完成读取：避免 refreshPopupChoices 并发
// 重建 popupChoices 时读到 idx 与 name 不一致（idx 指向旧列表位置，name 取自新列表）
std::string shaderPathForIndex(int idx) {
    auto& gs = globalState();
    std::string dir = effectsDirPath();
    if (dir.empty()) return "";
    CSLock lk(gs.mutex);
    if (idx < 0 || idx >= (int)gs.popupChoices.size()) {
        idx = kDefaultFileIndex;
    }
    if (idx < (int)gs.popupChoices.size()) {
        return dir + "\\" + gs.popupChoices[idx] + ".glsl";
    }
    return "";   // 空库 → 无文件可渲染（走透传）
}

// 扫描 effects/ 目录下 .glsl 文件（不含扩展名，按字母序）
// error.log 等非 .glsl 已自动过滤；active.glsl 不再特殊（历史残留
// 降级为普通库文件，可由用户在自绘选择器里删除/改名）。
// 目录路径为 UTF-8：窄 string 构造的 fs 路径按 ANSI(GBK) 解释，含中文的
// 自定义数据目录会扫描为空 → 统一转宽路径；文件名同理走 wstring → UTF-8
// 扩展名大小写不敏感比较：Windows 文件系统不区分大小写——用户在
// 资源管理器把 Foo.glsl 改名为 Foo.Glsl 后，若只认 ".glsl"/".GLSL" 两个字面量，
// 列表刷新即消失，实例按名解析不到 → 渲染透传并误报「库文件已不存在」。
// 逐字符 towlower 后与 L".glsl" 全等；非 ASCII 字符不可能匹配，无风险。
static bool hasGlslExtension(const std::filesystem::path& p) {
    std::wstring ext = p.extension().wstring();
    for (auto& c : ext) c = static_cast<wchar_t>(std::towlower(c));
    return ext == L".glsl";
}

// dir 参数化版本：供单测用可控临时目录覆盖（免动 APPDATA 真实数据根）；
// scanEffectsDir 只是传 effectsDirPath() 的薄封装，扫描/排序语义与之完全一致。
std::vector<std::string> scanEffectsDirIn(const std::string& dir) {
    std::vector<std::string> names;
    if (dir.empty()) return names;
    std::error_code ec;
    const std::filesystem::path wdir(glsl::utf8ToWide(dir));
    if (!std::filesystem::exists(wdir, ec)) return names;
    for (auto& entry : std::filesystem::directory_iterator(wdir, ec)) {
        if (ec) break;
        if (!entry.is_regular_file()) continue;
        auto p = entry.path();
        if (hasGlslExtension(p)) {
            names.push_back(glsl::wideToUtf8(p.stem().wstring()));
        }
    }
    std::sort(names.begin(), names.end(), [](const std::string& a, const std::string& b) {
        // 大小写不敏感排序，与 ECW 选择器顺序一致
        return _stricmp(a.c_str(), b.c_str()) < 0;
    });
    return names;
}

std::vector<std::string> scanEffectsDir() {
    return scanEffectsDirIn(effectsDirPath());
}

// 重扫 effects/ 目录，刷新选择器选项列表（全部为库文件，无 active 占位项）
// 返回选项总数。选中索引不再有全局镜像（N1）：各使用方持本实例索引，
// 经 shaderPathForIndex 自行钳制（越界回退第一个库文件）。
// 每次重扫后同步导出库索引（见 libraryIndexDumpText）——这是面板 LLM 得知
// "效果控件里有哪些文件、序号各是几"的唯一通道（AE 效果参数无字符串类型，
// 文件名传不出插件；选择器是 ARBITRARY_DATA，脚本读不到条目）。
int refreshPopupChoices() {
    auto files = scanEffectsDir();
    // 先留一份用于导出：popupChoices 在锁内 move 走，且导出必须在锁外做 I/O
    //（全局锁内不做文件读写，多实例渲染期会互相放大成卡顿）
    std::vector<std::string> snapshot = files;
    auto& gs = globalState();
    {
        CSLock lk(gs.mutex);
        gs.popupChoices = std::move(files);
    }
    writeLibraryIndexDump(effectsDirPath(), snapshot);
    return (int)snapshot.size();
}

// —— 库目录自检（见 effectState.h）——
// 判据是"重扫后与当前列表逐项比对"，**刻意不用目录 mtime**：NTFS 上目录的
// last_write_time 延迟回写，实测新建文件后立即 stat 值原封不动（第一次新建尤其明显），
// 拿它当判据会漏掉新增——而"新增 shader 没被感知"正是本函数要消灭的问题。
// 成本 = 一次目录枚举 + 排序（与既有的 ↻ 同量级，相比渲染耗时可忽略），
// 只有真变了才提交并重写 library-index.txt（避免每帧一次磁盘写）。
bool maybeRescanEffectsDir() {
    const std::string dir = effectsDirPath();
    if (dir.empty()) return false;
    std::vector<std::string> files = scanEffectsDir();
    auto& gs = globalState();
    std::vector<std::string> snapshot;
    {
        CSLock lk(gs.mutex);
        if (files == gs.popupChoices) return false;   // 未变：快路径，无写盘
        snapshot = files;                             // 锁外写盘用
        gs.popupChoices = std::move(files);
    }
    writeLibraryIndexDump(dir, snapshot);
    return true;
}

// —— 库索引导出（见 effectState.h）——
std::string libraryIndexDumpText(const std::vector<std::string>& names) {
    std::string out;
    out.reserve(names.size() * 24 + 160);
    char stamp[24] = {0};
    isoLocalStamp(stamp, sizeof(stamp));
    out += "# AS_Effect_Host library index\n";
    out += "# generated: ";
    out += stamp;
    out += "\n";
    out += "# count: ";
    out += std::to_string(static_cast<int>(names.size()));
    out += "\n";
    out += "# format: <0-based index>\t<name without extension>\n";
    for (size_t i = 0; i < names.size(); ++i) {
        out += std::to_string(static_cast<int>(i));
        out += '\t';
        out += names[i];
        out += '\n';
    }
    return out;
}

// 宽路径 ofstream：与 error.log 同机制——窄路径按 ANSI(GBK) 解释，含中文的
// 数据目录会静默打不开，面板就会一直读到陈旧内容。
bool writeLibraryIndexDump(const std::string& dir, const std::vector<std::string>& names) {
    if (dir.empty()) return false;
    try {
        const std::filesystem::path path(glsl::utf8ToWide(dir + "/" + kLibraryIndexFileName));
        std::ofstream f(path, std::ios::binary | std::ios::trunc);
        if (!f) return false;
        f << libraryIndexDumpText(names);
        return f.good();
    } catch (...) {
        return false;   // 导出失败不得影响选择器刷新与渲染
    }
}

// —— per-file 条目缓存（N1 修复核心）——
// 若把 effectSource/uniforms/parseWarning/uiSignature 挂在进程级单例上，
// 多实例（多图层选不同 .glsl）互相覆盖：A 实例的 ECW 按 B 实例的 uniform
// 列表绘制、值取 A 的槽位；且 Render/SmartRender 每实例把本实例选择器值写进
// 全局索引，交替覆盖。改为按文件路径缓存：同文件必然同解析结果，共享正确；
// 实例差异只体现在各自的选择器参数 handle（随工程持久化）上。

// 获取/惰性创建条目（必须持 gs.mutex 调用）
static ShaderFileEntry& obtainEntry(GlobalState& gs, const std::string& path) {
    auto it = gs.fileCache.find(path);
    if (it == gs.fileCache.end()) {
        it = gs.fileCache.emplace(path, ShaderFileEntry{}).first;
        // watcher 绑定本文件路径：hasSeen_=false → 首次 needsReload 即读入
        it->second.watcher.setPath(path);
    }
    return it->second;
}

// 锁外完成整文件读 + 解析，锁内提交条目——gs.mutex 是全局锁（多实例
// 渲染/UI 共享），旧 ensureEntryLoaded 在锁内整文件读盘 + 正则解析（毫秒级），
// 多实例交替渲染/播放期互相放大成卡顿。并发下后写者胜：另一线程可能已重载
// 同一文件（同源内容无害），已 loaded 则放弃本次提交。
static void loadEntryOutsideLock(GlobalState& gs, const std::string& path) {
    std::string src = glsl::readFile(path);          // 锁外 I/O
    if (src.empty()) return;   // 缺失/空文件：保持未加载，下次再试（旧语义）
    std::string parseWarn, chanWarn;
    std::vector<glsl::Param> parsed = glsl::parseUniforms(src, &parseWarn);   // 锁外解析
    const uint8_t chans = glsl::parseSamplerChannels(src, &chanWarn);
    if (!chanWarn.empty()) parseWarn += chanWarn;   // 采样器告警并入 parseWarning（error.log 可见）
    CSLock lk(gs.mutex);
    ShaderFileEntry& e = obtainEntry(gs, path);
    if (e.loaded) return;   // 并发方已提交：直接用其结果
    e.uniforms = std::move(parsed);
    e.channelsUsed = chans;
    e.iterCfg = glsl::parseIterConfig(src);   // 迭代/结算配置（与 channelsUsed 同源同期）
    e.parseWarning = std::move(parseWarn);
    e.source = std::move(src);
    e.loaded = true;
}

ShaderSnapshot getShaderForPath(const std::string& path, bool checkReload, bool forRender) {
    ShaderSnapshot snap;
    if (path.empty()) return snap;
    snap.path = path;
    auto& gs = globalState();
    // 锁内只保留 watcher 状态消费（needsReload 有 size+mtime 快路径，
    // 文件未变时零读盘）、条目提交与快照拷贝；I/O 与正则解析全部移出锁。
    bool reloadTriggered = false;
    std::string reloadSrc;
    bool needLoad = false;
    {
        CSLock lk(gs.mutex);
        ShaderFileEntry& e = obtainEntry(gs, path);
        if (checkReload) {
            // 上次真实重载的消费若来自 UI 线程（ECW 打开时 UPDATE_PARAMS_UI
            // 抢先消费 watcher 状态），渲染路径的 needsReload() 恒 false、
            // snap.reloaded 永假 → error.log 陈旧错误永不清除。补一次消费：
            // 强制 reloaded=true 交给渲染路径执行「重载成功即清」（幂等）
            // 补消费限定渲染路径（forRender=true，Render/SmartRender
            // 调用方）——否则任意 checkReload 调用方都能吃掉标记，UI 调用方
            //（SyncParamUI/文件切换点击）拿到 reloaded=true 却不执行「重载成功
            // 即清」，标记即被清空，渲染路径永远等不到（诊断延迟）。UI 调用方
            // 不消费，标记保留至下一次渲染调用。
            if (forRender && e.renderConsumePending) {
                snap.reloaded = true;
                e.renderConsumePending = false;
            }
            if (e.watcher.needsReload()) {
                reloadTriggered = true;
                // 拷贝触发内容（锁外解析）；直接用 watcher 已读到的内容而非
                // 二次读文件——若二次读撞上写盘截断窗口读空，本次变更会被
                // 永久漏载
                reloadSrc = e.watcher.lastContent();
            } else if (!e.loaded) {
                needLoad = true;   // 未触发重载的调用方负责惰性加载（旧 if-else 语义）
            }
        } else if (!e.loaded) {
            needLoad = true;       // 只读路径（ECW 绘制等）：条目未加载时读一次
        }
    }
    if (reloadTriggered && !reloadSrc.empty()) {
        // 锁外解析（正则全量跑）→ 锁内提交
        std::string parseWarn, chanWarn;
        std::vector<glsl::Param> parsed = glsl::parseUniforms(reloadSrc, &parseWarn);
        const uint8_t chans = glsl::parseSamplerChannels(reloadSrc, &chanWarn);
        if (!chanWarn.empty()) parseWarn += chanWarn;
        CSLock lk(gs.mutex);
        ShaderFileEntry& e = obtainEntry(gs, path);
        if (parsed != e.uniforms) snap.uniformsChanged = true;
        e.uniforms = std::move(parsed);
        e.channelsUsed = chans;                   // 热重载时随 parseUniforms 一并更新
        e.iterCfg = glsl::parseIterConfig(reloadSrc);
        e.parseWarning = std::move(parseWarn);
        e.source = reloadSrc;
        e.loaded = true;
        snap.reloaded = true;
        // 真实重载消费置补确认标记——下一次 checkReload 调用再补一次
        // reloaded（若本次消费来自渲染线程，补消费是多执行一次幂等的
        // clearErrorLog/告警回写；来自 UI 线程则正是修复目标）
        e.renderConsumePending = true;
    } else if (needLoad) {
        loadEntryOutsideLock(gs, path);
    }
    //（reloadTriggered 且 reloadSrc 为空 = 写盘截断窗口读空：watcher 未消费
    //  状态，下次自动重试）
    {
        CSLock lk(gs.mutex);
        ShaderFileEntry& e = obtainEntry(gs, path);
        snap.source = e.source;
        snap.uniforms = e.uniforms;
        snap.channelsUsed = e.channelsUsed;
        snap.iterCfg = e.iterCfg;
        snap.parseWarning = e.parseWarning;
        snap.uiSignature = e.uiSignature;
    }
    return snap;
}

ShaderSnapshot getShaderForIndex(int idx, bool checkReload, bool forRender) {
    // 取用点即自检点：RENDER 与 PARAMS_SETUP 都经这里拿快照，故库成员变化后
    // 最迟在下一帧渲染时自行跟上（index→path 的钳制也随即用上新列表）。
    maybeRescanEffectsDir();
    return getShaderForPath(shaderPathForIndex(idx), checkReload, forRender);
}

// —— 身份（文件名）↔ 位置 ——
// 与 scanEffectsDir 的排序口径一致：大小写不敏感比较（_stricmp / lowerStr 同源）。
static bool nameEqualsCI(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        if (std::tolower(static_cast<unsigned char>(a[i])) !=
            std::tolower(static_cast<unsigned char>(b[i]))) return false;
    }
    return true;
}

int indexForShaderNameNoRescan(const std::string& name) {
    if (name.empty()) return -1;
    auto& gs = globalState();
    CSLock lk(gs.mutex);
    for (size_t i = 0; i < gs.popupChoices.size(); ++i) {
        if (nameEqualsCI(gs.popupChoices[i], name)) return static_cast<int>(i);
    }
    return -1;
}

int indexForShaderName(const std::string& name) {
    if (name.empty()) return -1;
    maybeRescanEffectsDir();
    return indexForShaderNameNoRescan(name);
}

// 给定列表上的 name → (下标, 路径) 纯逻辑（与 shaderPathForName 命中
// 分支同口径：dir\name.glsl，扩展名固定 .glsl）。未命中 -1 + 清路径。抽成纯函数
// 供单测覆盖；getShaderByIdentity 在单次重扫后用它在同一份 popupChoices 快照上
// 一次完成解析（不再二次枚举目录，见 resolveShaderNameNoRescan）。
int resolveShaderNameInList(const std::vector<std::string>& names,
                            const std::string& dir,
                            const std::string& name,
                            std::string* outPath) {
    if (outPath) outPath->clear();
    if (name.empty()) return -1;
    for (size_t i = 0; i < names.size(); ++i) {
        if (nameEqualsCI(names[i], name)) {
            if (outPath && !dir.empty()) *outPath = dir + "\\" + names[i] + ".glsl";
            return static_cast<int>(i);
        }
    }
    return -1;
}

// 内部：不重扫目录的 name → (下标, 路径)。nameEqualsCI 与 popupChoices 必须在
// 同一把锁内取（目录解析 effectsDirPath 自身会取 gs.mutex，故先算 dir 再进锁）。
static int resolveShaderNameNoRescan(const std::string& name, std::string* outPath) {
    if (outPath) outPath->clear();
    if (name.empty()) return -1;
    const std::string dir = effectsDirPath();   // 锁外：dataRoot 解析会取 gs.mutex
    auto& gs = globalState();
    CSLock lk(gs.mutex);
    return resolveShaderNameInList(gs.popupChoices, dir, name, outPath);
}

std::string shaderNameAtIndex(int idx) {
    maybeRescanEffectsDir();
    auto& gs = globalState();
    CSLock lk(gs.mutex);
    if (idx < 0 || idx >= static_cast<int>(gs.popupChoices.size())) return "";
    return gs.popupChoices[static_cast<size_t>(idx)];
}

std::string shaderPathForName(const std::string& name) {
    const int idx = indexForShaderName(name);
    if (idx < 0) return "";
    const std::string dir = effectsDirPath();
    if (dir.empty()) return "";
    auto& gs = globalState();
    CSLock lk(gs.mutex);
    if (idx >= static_cast<int>(gs.popupChoices.size())) return "";
    return dir + "\\" + gs.popupChoices[static_cast<size_t>(idx)] + ".glsl";
}

// 身份缺失的去重告警：getShaderByIdentity 在渲染路径上每帧调用，不能逐帧写盘
//（与 ltLog/rfLog 同款的"只在新状态落一行"策略）。按名字去重：同名只报一次。
// 去重状态改 thread_local——renderFrame 可能被 MFR 多线程并发调用
//（getShaderByIdentity 无锁、只读缓存快照），进程级 static std::string 的
// 读-改-写无同步保护属数据竞争（UB）；thread_local 与 plugin.cpp 的 s_lastError
// 同款，最坏回归只是每线程各报一次（日志去重的语义损失可接受，UB 不可接受）。
// 去重叠加 error.log 代际校验（与 plugin.cpp 的
// 同款）。error.log 是**目录级共享**文件，别的实例重载成功会 clearErrorLog 清空
// 全文件并递增代际；本实例的 thread_local 标记仍等于自身 name，纯名字去重会跳过
// append → 这条"文件已不存在"诊断从 error.log 永久消失（诊断链断裂，与
// 修掉的持续编译错误是同一族缺口）。代际变化即强制重写。
// 参数化 dir 的版本供单测用可控临时目录直接覆盖（生产调用只传 effectsDirPath()）。
bool logMissingIdentityOnceAt(const std::string& dir, const std::string& name) {
    static thread_local std::string s_lastMissing;
    static thread_local uint64_t s_lastMissingGen = 0;
    const uint64_t gen = errorLogGeneration();
    if (s_lastMissing == name && s_lastMissingGen == gen) return false;
    s_lastMissing = name;
    s_lastMissingGen = gen;
    // 文件名代入模板；文件名长度受文件系统上限约束，缓冲留足余量。
    char msg[1024];
    std::snprintf(msg, sizeof(msg), Tr(S_EFFECTHOST_EFFECTSTATE_ERROR_LIB_FILE_MISSING),
                  name.c_str());
    appendErrorLog(dir, msg);
    return true;
}

static void logMissingIdentityOnce(const std::string& name) {
    logMissingIdentityOnceAt(effectsDirPath(), name);
}

ShaderSnapshot getShaderByIdentity(const std::string& name, int fallbackIdx,
                                   bool checkReload, bool forRender,
                                   int* outResolvedIndex) {
    // 整次调用只重扫一次目录。逐处枚举则是 3 次（本行 +
    // indexForShaderName 内 + shaderPathForName 内）——本函数在渲染路径每帧每实例
    // 调用，"枚举目录 + 排序"×3 是纯浪费。重扫语义保留：入口这一次保证库成员
    // 变化最迟本次调用被吸收；解析与取路径改由
    // resolveShaderNameNoRescan 在同一份 popupChoices 快照上单锁一次完成
    //（下标与路径不会因并发刷新而漂移）。真正需要重扫的其他入口
    //（getShaderForIndex / shaderNameAtIndex / refreshPopupChoices 等）照旧重扫。
    maybeRescanEffectsDir();
    std::string resolvedPath;
    const int byName = resolveShaderNameNoRescan(name, &resolvedPath);
    // 一次性诊断：只在"身份名/解析结果"变化时落一行（渲染路径每帧调用，不能逐帧写）
    if (byName >= 0) {
        if (outResolvedIndex) *outResolvedIndex = byName;
        return getShaderForPath(resolvedPath, checkReload, forRender);
    }
    // 两种情况必须分开，否则会把"文件没了"重新变成"静默换成另一个 shader"：
    //   ① 名字为空 = 从未捕获身份（v1 旧工程）→ 回退位置解释，与改动前一致；
    //   ② 名字非空但查不到 = 该文件已被删除/改名 → **返回空快照走透传**，并把
    //      现场写进 error.log（get_render_error 可见）。宁可画面空，也不能悄悄
    //      渲染成另一个 shader —— 后者正是本次修复要消灭的症状。
    if (name.empty()) {
        if (outResolvedIndex) *outResolvedIndex = fallbackIdx;
        return getShaderForIndex(fallbackIdx, checkReload, forRender);
    }
    logMissingIdentityOnce(name);
    if (outResolvedIndex) *outResolvedIndex = -1;
    ShaderSnapshot empty;
    return empty;
}

// ECW 的「重算」按钮据此决定显隐（Solver 模式才显示）。与 shaderUniformAt 同款：
// 锁内查缓存条目，未加载时锁外读盘解析一次再重锁取值。
glsl::IterMode shaderIterMode(const std::string& path) {
    if (path.empty()) return glsl::IterMode::None;
    auto& gs = globalState();
    {
        CSLock lk(gs.mutex);
        ShaderFileEntry& e = obtainEntry(gs, path);
        if (e.loaded) return e.iterCfg.mode;
    }
    loadEntryOutsideLock(gs, path);
    CSLock lk(gs.mutex);
    return obtainEntry(gs, path).iterCfg.mode;
}

bool shaderUniformAt(const std::string& path, int slot, glsl::Param* out) {
    if (path.empty()) return false;
    auto& gs = globalState();
    {
        CSLock lk(gs.mutex);
        ShaderFileEntry& e = obtainEntry(gs, path);
        if (e.loaded) {
            if (slot < 0 || slot >= (int)e.uniforms.size()) return false;
            *out = e.uniforms[slot];
            return true;
        }
    }
    // 未加载条目——锁外读盘+解析后重锁取值（旧 ensureEntryLoaded 的
    // 锁内慢路径移出；此路径为 ECW 绘制每次 DRAW 高频触发）
    loadEntryOutsideLock(gs, path);
    CSLock lk(gs.mutex);
    ShaderFileEntry& e = obtainEntry(gs, path);
    if (slot < 0 || slot >= (int)e.uniforms.size()) return false;
    *out = e.uniforms[slot];
    return true;
}

void setEntrySignature(const std::string& path, const std::string& sig) {
    if (path.empty()) return;
    auto& gs = globalState();
    CSLock lk(gs.mutex);
    auto it = gs.fileCache.find(path);
    if (it != gs.fileCache.end()) {
        it->second.uiSignature = sig;
    }
}

// —— 槽位参数索引（单分组布局，见 effectState.h 注释）——
// PARAMS_SETUP 在主线程执行，此后不变，普通 int 足够（无并发写）。
// 单分组：32 槽位 × 4 分量全部注册进「参数」组，分量索引恒为
// kIdxSlots + slot*kFloatsPerSlot + comp；4 个分量全部隐藏（PF_PUI_NO_ECW_UI），
// 显示由画布自绘。
int slotCompIndex(int slot, int comp) {
    if (slot < 0 || slot >= kMaxParams) return -1;
    if (comp < 0 || comp >= kFloatsPerSlot) return -1;
    return kIdxSlots + slot * kFloatsPerSlot + comp;
}
int slotParamIndex(int slot) {
    return slotCompIndex(slot, 0);
}
// 只映射槽位分量0 索引（5, 9, 13, … 129）——分量1..3（隐藏容器）不参与 ECW 绘制，
// 返回 -1 让 handleDraw/handleClick 对其直接走 AE 默认（不画不响应）。
int slotFromIndex(int idx) {
    if (idx < kIdxSlots || idx >= kIdxSlots + kMaxParams * kFloatsPerSlot) return -1;
    const int off = idx - kIdxSlots;
    if (off % kFloatsPerSlot != 0) return -1;
    return off / kFloatsPerSlot;
}

} // namespace host
