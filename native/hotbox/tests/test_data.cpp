// test_data.cpp — 数据解析单测（纯函数 + 一处临时目录扫描用例）
#include "data.h"
#include <cstdio>
#include <string>
#include <vector>
#include <windows.h>

static int g_fail = 0;
#define CHECK(cond) do { \
    if (!(cond)) { std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); ++g_fail; } \
} while (0)

// 写指定字节数的文件（临时目录扫描用例用；失败返回 false → 调用方 SKIP）
static bool writeFileBytes(const std::wstring& path, int bytes) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    char buf[16] = {0};
    DWORD written = 0;
    BOOL ok = WriteFile(h, buf, (DWORD)bytes, &written, nullptr);
    CloseHandle(h);
    return ok != 0 && written == (DWORD)bytes;
}

// 按名找条目（找不到返回 nullptr）
static const data::Item* findByName(const std::vector<data::Item>& v, const std::string& nm) {
    for (const auto& it : v) if (it.name == nm) return &it;
    return nullptr;
}

int run_data_tests() {
    using namespace data;

    std::string fx = R"({"version":1,"total":2,"categories":[
        {"category":"模糊与锐化","count":2,"effects":[
            {"name":"高斯模糊","matchName":"ADBE Gaussian Blur 2"},
            {"name":"径向模糊","matchName":"ADBE Radial Blur"}]}]})";
    auto items = parseEffects(fx);
    CHECK(items.size() == 2);
    CHECK(items[0].type == "effect" && items[0].category == "模糊与锐化");
    CHECK(items[0].name == "高斯模糊" && items[0].key == "ADBE Gaussian Blur 2");

    std::string pr = R"({"items":[{"id":"1","name":"发光标题.ffx","folder":"标题","ffxPath":"C:/x/发光标题.ffx"}]})";
    auto presets = parsePresets(pr);
    CHECK(presets.size() == 1);
    CHECK(presets[0].type == "preset" && presets[0].category == "标题");
    CHECK(presets[0].name == "发光标题.ffx" && presets[0].key == "C:/x/发光标题.ffx");

    Item s = makeScriptItem("模糊脚本", "工具/模糊", "C:/abs/工具/模糊.jsx");
    CHECK(s.type == "script" && s.name == "模糊脚本");
    CHECK(s.key == "C:/abs/工具/模糊.jsx");

    CHECK(parseEffects("").empty());
    CHECK(parsePresets("not json").empty());

    // isSafeDataRoot 段级归一化 + 8.3 短名段拒绝
    // 拒绝：尾随空格/点绕过系统目录黑名单（Windows 文件系统剥尾语义）
    CHECK(!isSafeDataRoot(R"(C:\Windows \x)"));
    CHECK(!isSafeDataRoot(R"(C:\Windows.\x)"));
    CHECK(!isSafeDataRoot(R"(C:\Program Files.\y)"));
    CHECK(!isSafeDataRoot("C:/Program Files /y"));
    // 拒绝：正斜杠 windows.old（原仅匹配 \windows.old 子串）+ 反斜杠回归
    CHECK(!isSafeDataRoot("C:/Windows.old/x"));
    CHECK(!isSafeDataRoot(R"(C:\Windows.old\x)"));
    // 拒绝：8.3 短名段（解析后可能指向系统目录）
    CHECK(!isSafeDataRoot(R"(C:\PROGRA~1\x)"));
    CHECK(!isSafeDataRoot(R"(D:\progra~2\data)"));
    // 放行：合法数据目录（防误伤回归）
    CHECK(isSafeDataRoot(R"(D:\AE_Data\AS_ExtP)"));
    CHECK(isSafeDataRoot(R"(D:\my..draft\x)"));      // 段中含 ".." 子串不拦（仅剥段尾）
    CHECK(isSafeDataRoot(R"(E:\proj\v2~final\data)")); // ~ 后非数字，非 8.3 形态
    CHECK(isSafeDataRoot(R"(D:\data \x)"));          // 普通段尾空格剥除后放行

    // isValidUtf8（与 glsl-host 对齐）：data-dir.txt 被以 ANSI/GBK 保存时
    // 那串字节能过 isSafeDataRoot（0x80+ 不在其黑名单），却只会得到乱码路径——
    // 必须在进入路径拼接前拦下并回退默认根。
    CHECK(isValidUtf8("D:\\AE_Data\\AS_ExtP"));                  // 纯 ASCII
    CHECK(isValidUtf8("D:\\\xE6\x95\xB0\xE6\x8D\xAE\\AS_ExtP"));  // 合法 UTF-8「数据」（裸字节，不依赖源码编码）
    CHECK(isValidUtf8(""));                                     // 空串合法（调用方另有 empty 判定）
    CHECK(!isValidUtf8("\xCE\xC4"));                             // GBK「文」：0xC4 非续字节 → 非法
    CHECK(!isValidUtf8("D:\\\xD6\xD0\xCE\xC4"));                 // GBK 中文段
    // 反例提醒：GBK「目录」(C4 BF C2 BC) 恰好**能**解码成合法 UTF-8（Ŀ¼）——校验只能拦
    // 完全解不开的字节流，解得开但语义错的乱码仍需靠"路径不存在→回退"链路兜住。
    CHECK(!isValidUtf8("D:\\\xE6\x95"));                         // UTF-8 截断（缺续字节）
    CHECK(!isValidUtf8("D:\\\xC0\xAF"));                         // 过短编码（0xC0 0xAF = 斜杠）
    CHECK(!isValidUtf8("D:\\\xED\xA0\x80"));                     // 代理区 U+D800
    CHECK(!isValidUtf8("D:\\\xF4\x90\x80\x80"));                 // 超范围（> U+10FFFF）
    CHECK(!isValidUtf8("D:\\\xFF"));                              // 首字节非法

    // isScriptFile 后缀判定（回归：.jsxbin 按 6 字符比较永不命中，
    // 且 4~5 字符文件名上 size-6 无符号下溢 → compare 抛 out_of_range 崩溃）
    CHECK(isScriptFile("tool.jsx"));
    CHECK(isScriptFile("模糊.JSX"));
    CHECK(isScriptFile("pack.jsxbin"));
    CHECK(isScriptFile("PACK.JSXBIN"));
    CHECK(!isScriptFile("a.js"));        // 4 字符：不得越界/崩溃
    CHECK(!isScriptFile("todo"));        // 4 字符非脚本
    CHECK(!isScriptFile("ab"));          // 过短
    CHECK(!isScriptFile("jsx"));         // 3 字符过短
    CHECK(!isScriptFile("a.jsx.txt"));   // 后缀不对

    // ————— 预设双源（扩展库 + AE 预设目录） —————
    // 索引 size → Item.size（去重键用）；缺失/非法按 0（未知）处理，由 fillItemSizes 补查
    // 归档条目（archived=true）不进热盒：实体在 ___archive__、7 天后被物理清理，
    // 若不滤掉会在合并里顶掉 AE 侧同名同大小的真条目（库优先）→ 清理后变成"预设文件不存在"
    {
        auto pr2 = parsePresets(
            R"({"items":[{"name":"a","ffxPath":"C:/x/a.ffx","size":1234},)"
            R"({"name":"b","ffxPath":"C:/x/b.ffx"},)"
            R"({"name":"c","ffxPath":"C:/x/c.ffx","size":-5},)"
            R"({"name":"d","ffxPath":"C:/x/d.ffx","size":"1234"},)"
            R"({"name":"归档的","ffxPath":"C:/x/___archive__/归档的.ffx","size":9,"archived":true},)"
            R"({"name":"未归档","ffxPath":"C:/x/未归档.ffx","size":8,"archived":false}]})");
        CHECK(pr2.size() == 5);       // 6 条里滤掉 1 条归档
        CHECK(pr2[0].size == 1234);
        CHECK(pr2[1].size == 0);      // 缺 size
        CHECK(pr2[2].size == 0);      // 非正数
        CHECK(pr2[3].size == 0);      // 字符串不是数字（类型不符即未知）
        CHECK(pr2[4].name == "未归档");  // archived=false 照常进
    }

    // 去重键 = 小写名 + 字节数
    {
        Item a; a.name = "Fade In"; a.size = 1234;
        Item b; b.name = "fade in"; b.size = 1234;
        Item c; c.name = "Fade In"; c.size = 1235;
        CHECK(presetDedupeKey(a) == presetDedupeKey(b));
        CHECK(presetDedupeKey(a) != presetDedupeKey(c));
    }

    // 合并去重：库优先；同名同字节数折叠；同名不同字节数都保留
    // （真机 AE 出厂预设里确有「百叶窗」191231/26526、「放大」43417/75976 两组同名不同内容——
    //  只按名去重会吞掉真实条目，故键必须带字节数）
    {
        Item lib; lib.type = "preset"; lib.name = "百叶窗"; lib.size = 191231;
        lib.key = "C:/data/百叶窗.ffx";
        Item aeSame; aeSame.type = "preset"; aeSame.name = "百叶窗"; aeSame.size = 191231;
        aeSame.key = R"(E:\AE\Presets\Wipes\百叶窗.ffx)";
        Item aeOther; aeOther.type = "preset"; aeOther.name = "百叶窗"; aeOther.size = 26526;
        aeOther.key = R"(E:\AE\Presets\Mir\百叶窗.ffx)";
        Item aeOnly; aeOnly.type = "preset"; aeOnly.name = "放大"; aeOnly.size = 43417;
        aeOnly.key = R"(E:\AE\Presets\Transform\放大.ffx)";
        auto m = mergePresetsDedup({lib}, {aeSame, aeOther, aeOnly});
        CHECK(m.size() == 3);                        // aeSame（同名同大小副本）被折叠
        CHECK(m[0].key == "C:/data/百叶窗.ffx");      // 保留 preferred 侧条目
        CHECK(m[1].size == 26526);                   // 同名不同大小保留（真不同内容）
        CHECK(m[2].name == "放大");

        // 三源顺序 = 优先级：扩展库 > AE 用户预设 > AE 出厂预设
        Item user; user.type = "preset"; user.name = "我的淡入"; user.size = 10;
        user.key = "C:/u/我的淡入.ffx";
        Item stock; stock.type = "preset"; stock.name = "淡入"; stock.size = 20;
        stock.key = R"(E:\AE\Presets\Text\淡入.ffx)";
        Item stockDup = lib;                         // 出厂侧的同名同大小副本
        stockDup.key = R"(E:\AE\Presets\Wipes\百叶窗.ffx)";
        auto m2 = mergePresetsDedup({lib}, mergePresetsDedup({user}, {stock, stockDup}));
        CHECK(m2.size() == 3);
        CHECK(m2[0].key == "C:/data/百叶窗.ffx");     // 库条目仍在最前
        CHECK(m2[1].key == "C:/u/我的淡入.ffx");      // 用户预设次之
        CHECK(m2[2].key == R"(E:\AE\Presets\Text\淡入.ffx)");   // 出厂预设最后（stockDup 被折叠）

        // 无库条目（本机库为空）时 AE 侧全量保留
        auto m3 = mergePresetsDedup({}, {aeOther, aeOnly});
        CHECK(m3.size() == 2 && m3[0].size == 26526 && m3[1].name == "放大");
    }

    // 扫描结果 → Item：name 去 .ffx、category 相对 root（"/" 分隔）、key 绝对路径、size 字节数
    {
        std::vector<FfxFile> files = {
            { R"(E:\AE\Presets\Text\Fade In.ffx)", 111 },
            { R"(E:\AE\Presets\Fade Up.FFX)", 222 },
            { R"(E:\AE\Presets\Transitions\Wipes\Wipe.ffx)", 333 },
            { R"(E:\Other\Outsider.ffx)", 444 },              // 不属于 root：不猜 category
        };
        auto items4 = presetItemsFromFiles(R"(E:\AE\Presets)", files);
        CHECK(items4.size() == 4);
        CHECK(items4[0].type == "preset" && items4[0].name == "Fade In");
        CHECK(items4[0].category == "Text" && items4[0].size == 111);
        CHECK(items4[0].key == R"(E:\AE\Presets\Text\Fade In.ffx)");
        CHECK(items4[1].name == "Fade Up" && items4[1].category.empty());   // 根下直放：无分类
        CHECK(items4[2].category == "Transitions/Wipes");                   // 多级子目录
        CHECK(items4[3].category.empty());                                  // root 外：不猜
        // root 写法（尾随分隔符 / 正斜杠）不影响结果
        auto items5 = presetItemsFromFiles("E:/AE/Presets/", { { "E:/AE/Presets/A/b.ffx", 5 } });
        CHECK(items5.size() == 1 && items5[0].category == "A" && items5[0].name == "b");
        // 同前缀的兄弟目录（Presets 与 Presets2）不算 root 内：前缀必须落在分隔符上
        auto items7 = presetItemsFromFiles(R"(E:\AE\Presets)",
                                          { { R"(E:\AE\Presets2\x.ffx)", 6 } });
        CHECK(items7.size() == 1 && items7[0].category.empty() && items7[0].name == "x");
        // 非 .ffx 混入（调用方绕过 isFfxFile 时）被丢弃
        auto items6 = presetItemsFromFiles(R"(E:\AE\Presets)", { { R"(E:\AE\Presets\x.jsx)", 5 } });
        CHECK(items6.empty());
    }

    // .ffx 后缀判定（4 字符后缀，长度不足即不比较——同 isScriptFile 的下溢防护口径）
    {
        CHECK(isFfxFile("a.ffx"));
        CHECK(isFfxFile("模糊.FFX"));
        CHECK(!isFfxFile("ffx"));          // 3 字符过短（不得越界）
        CHECK(!isFfxFile("a.ffxt"));       // 后缀不对
        CHECK(!isFfxFile("a.ffx.txt"));
        CHECK(!isFfxFile("a.jsx"));
        CHECK(!isFfxFile(""));
    }

    // AE 安装根推导：模块路径 <AE>\Support Files\Plug-ins\... → <AE>
    {
        CHECK(aeInstallRootFromModulePath(
                  R"(E:\Adobe\Adobe After Effects 2023\Support Files\Plug-ins\AS_Hotbox.aex)") ==
              R"(E:\Adobe\Adobe After Effects 2023)");
        // 插件目录下还有子文件夹 / 正斜杠 / 段名大小写：都应认
        CHECK(aeInstallRootFromModulePath(
                  R"(E:\AE\Support Files\Plug-ins\vendor\AS_Hotbox.aex)") == R"(E:\AE)");
        CHECK(aeInstallRootFromModulePath(
                  "D:/Adobe/Adobe After Effects 2026/support files/PLUG-INS/x.aex") ==
              R"(D:\Adobe\Adobe After Effects 2026)");
        // 非 Support Files\Plug-ins 位置：不猜（调用方走 app.path 兜底）
        CHECK(aeInstallRootFromModulePath(
                  R"(C:\Program Files\Adobe\Common\Plug-ins\7.0\MediaCore\AS_Hotbox.aex)").empty());
        CHECK(aeInstallRootFromModulePath(R"(C:\x\Plug-ins\AS_Hotbox.aex)").empty());          // 缺 Support Files
        CHECK(aeInstallRootFromModulePath(R"(C:\x\Support Files\AS_Hotbox.aex)").empty());     // 缺 Plug-ins
        CHECK(aeInstallRootFromModulePath("").empty());
    }

    // AE 自报路径（app.path）规范：正斜杠 → 反斜杠、剥尾随分隔符、含 Support Files 时截到其前
    {
        CHECK(normalizeAeInstallRoot("E:/Adobe/Adobe After Effects 2023") ==
              R"(E:\Adobe\Adobe After Effects 2023)");
        CHECK(normalizeAeInstallRoot("E:/Adobe/Adobe After Effects 2023/") ==
              R"(E:\Adobe\Adobe After Effects 2023)");
        CHECK(normalizeAeInstallRoot("E:/Adobe/Adobe After Effects 2023/Support Files") ==
              R"(E:\Adobe\Adobe After Effects 2023)");
        CHECK(normalizeAeInstallRoot("E:/Adobe/Adobe After Effects 2023/Support Files/") ==
              R"(E:\Adobe\Adobe After Effects 2023)");
        CHECK(normalizeAeInstallRoot("   ").empty());
        CHECK(normalizeAeInstallRoot("relative/path").empty());   // 无盘符：不可判定
        CHECK(normalizeAeInstallRoot("").empty());
    }

    // 用户预设目录名映射 + 出厂预设目录拼接 + 存在性探测
    {
        CHECK(aeUserPresetsSubdir(R"(E:\Adobe\Adobe After Effects 2023)") == "After Effects 2023");
        CHECK(aeUserPresetsSubdir(R"(E:\Adobe\Adobe After Effects 2023\)") == "After Effects 2023");
        CHECK(aeUserPresetsSubdir("E:/Adobe/Adobe After Effects CC 2019") == "After Effects CC 2019");
        CHECK(aeUserPresetsSubdir(R"(F:\Tools\After Effects 2023)") == "After Effects 2023");  // 无 Adobe 前缀
        CHECK(aeUserPresetsSubdir(R"(E:\Program Files\Adobe\Photoshop 2023)").empty());        // 非 AE：不猜
        CHECK(aeUserPresetsSubdir("").empty());
        CHECK(aeStockPresetsDir(R"(E:\Adobe\Adobe After Effects 2023)") ==
              R"(E:\Adobe\Adobe After Effects 2023\Support Files\Presets)");
        CHECK(aeStockPresetsDir("").empty());
        CHECK(userPresetsDir("").empty());       // subdir 为空不去翻 Documents
        CHECK(!dirExists(""));
        CHECK(!dirExists(R"(Z:\__as_hotbox_no_such_dir__)"));   // 不存在 → false（不抛异常）
    }

    // listFfxFiles / scanPresetDir：真机文件系统往返（%TEMP% 建临时树，做完即删）。
    // 覆盖纯函数用例碰不到的两处：.ffx 过滤（大小写）与 nFileSize 取值口径。
    {
        wchar_t tmp[MAX_PATH] = {0};
        DWORD n = GetTempPathW(MAX_PATH, tmp);
        if (n == 0 || n >= MAX_PATH) {
            std::printf("SKIP scanPresetDir: GetTempPathW failed\n");
        } else {
            std::wstring base = std::wstring(tmp) + L"as_hotbox_scan_" +
                                std::to_wstring(GetCurrentProcessId());
            std::wstring sub = base + L"\\子目录";
            RemoveDirectoryW(sub.c_str());     // 前一轮残留（非空会失败，忽略）
            RemoveDirectoryW(base.c_str());
            BOOL mk = CreateDirectoryW(base.c_str(), nullptr);
            DWORD mkErr = mk ? 0 : GetLastError();
            if (!mk && mkErr != ERROR_ALREADY_EXISTS) {
                std::printf("SKIP scanPresetDir: CreateDirectoryW failed (%lu)\n", mkErr);
            } else {
                CreateDirectoryW(sub.c_str(), nullptr);
                bool wrote = writeFileBytes(base + L"\\a.ffx", 7) &&
                             writeFileBytes(base + L"\\b.FFX", 11) &&
                             writeFileBytes(base + L"\\note.txt", 3) &&
                             writeFileBytes(sub + L"\\c.ffx", 13);
                if (!wrote) {
                    std::printf("SKIP scanPresetDir: WriteFile failed\n");
                } else {
                    auto scanned = scanPresetDir(wideToUtf8(base));
                    CHECK(scanned.size() == 3);          // note.txt 不计
                    const Item* a = findByName(scanned, "a");
                    const Item* b = findByName(scanned, "b");
                    const Item* c = findByName(scanned, "c");
                    CHECK(a && a->size == 7 && a->category.empty());
                    CHECK(b && b->size == 11 && b->category.empty());   // .FFX 大写同样收
                    CHECK(c && c->size == 13 && c->category == wideToUtf8(L"子目录"));
                    CHECK(a && a->key == wideToUtf8(base + L"\\a.ffx"));
                    CHECK(a && a->type == "preset");
                    // 不存在的目录 = 无此数据源（空列表，不抛异常）
                    CHECK(listFfxFiles(wideToUtf8(base + L"\\__nope__")).empty());
                    CHECK(scanPresetDir("").empty());

                    // fillItemSizes：库侧 size 按真实文件校准（索引里的值可能过时）
                    // ① 文件在 → 覆盖为真实字节数（去重键含 size，过时值会让同名副本折叠错位）
                    // ② 文件不在 → 置 0「未知」（不拿过时值去折叠 AE 侧同名同大小的真条目）
                    // ③ 目录不当文件（size 归 0）
                    std::vector<Item> calib = scanned;
                    for (auto& ci : calib) if (ci.name == "a") ci.size = 999;   // 造过时值
                    Item ghost;
                    ghost.type = "preset";
                    ghost.name = "ghost";
                    ghost.key = wideToUtf8(base + L"\\ghost.ffx");   // 不存在
                    ghost.size = 7;                                  // 过时的索引值
                    Item dirAsFile;
                    dirAsFile.type = "preset";
                    dirAsFile.name = "dir";
                    dirAsFile.key = wideToUtf8(base);                 // 目录
                    dirAsFile.size = 5;
                    calib.push_back(ghost);
                    calib.push_back(dirAsFile);
                    fillItemSizes(calib);
                    const Item* calibA = findByName(calib, "a");
                    const Item* calibGhost = findByName(calib, "ghost");
                    const Item* calibDir = findByName(calib, "dir");
                    CHECK(calibA && calibA->size == 7);               // 校准回真实大小
                    CHECK(calibGhost && calibGhost->size == 0);       // 文件不在 → 未知
                    CHECK(calibDir && calibDir->size == 0);           // 目录 → 未知
                }
                DeleteFileW((base + L"\\a.ffx").c_str());
                DeleteFileW((base + L"\\b.FFX").c_str());
                DeleteFileW((base + L"\\note.txt").c_str());
                DeleteFileW((sub + L"\\c.ffx").c_str());
                RemoveDirectoryW(sub.c_str());
                RemoveDirectoryW(base.c_str());
            }
        }
    }

    // 数据签名缓存有效性判据——半截枚举（complete=false，n 可 >0）与
    // 空列表（n=0）都不得记有效，否则会话内不再重算、残缺血列表固化。
    CHECK(effectEnumCacheable(120, true));     // 完整且非空：可缓存
    CHECK(!effectEnumCacheable(120, false));   // 半截枚举（n>0 但没走完）：不缓存
    CHECK(!effectEnumCacheable(0, true));      // 空列表：不缓存
    CHECK(!effectEnumCacheable(0, false));
    CHECK(!effectEnumCacheable(-1, true));     // AEGP 不可用（-1）：不缓存

    // 数据根相对 key —— 根内 → 相对；根外/已相对/空根 → 原样；
    // 大小写不敏感；同前缀不同目录（AE_Data2）不误判。
    {
        std::string root = "C:\\AE_Data";
        CHECK(toRelKey(root, "C:\\AE_Data\\agent\\scripts\\a.jsx") == "agent/scripts/a.jsx");
        CHECK(toRelKey(root, "c:\\ae_data\\agent\\x.jsx") == "agent/x.jsx");        // 大小写不敏感
        CHECK(toRelKey(root, "C:\\AE_Data") == "C:\\AE_Data");                       // 根自身不转
        CHECK(toRelKey(root, "D:\\other\\p.ffx") == "D:\\other\\p.ffx");            // 根外 → 原样
        CHECK(toRelKey(root, "C:\\AE_Data2\\p.ffx") == "C:\\AE_Data2\\p.ffx");     // 同前缀不误判
        CHECK(toRelKey(root, "agent/scripts/a.jsx") == "agent/scripts/a.jsx");         // 已相对 → 原样
        CHECK(toRelKey("", "C:\\AE_Data\\a.jsx") == "C:\\AE_Data\\a.jsx");         // 空根 → 不转
        CHECK(toRelKey(root, "ADBE Gaussian Blur") == "ADBE Gaussian Blur");           // effect matchName 不受影响
        CHECK(fromRelKey(root, "agent/scripts/a.jsx") == "C:/AE_Data/agent/scripts/a.jsx");
        CHECK(fromRelKey(root, "agent\\scripts\\a.jsx") == "C:/AE_Data/agent/scripts/a.jsx");  // 反斜杠相对串也认
        CHECK(fromRelKey(root, "C:\\abs\\p.ffx") == "C:\\abs\\p.ffx");              // 已绝对 → 原样
        CHECK(fromRelKey(root, "") == "");                                             // 空值安全
        CHECK(fromRelKey("", "agent/a.jsx") == "agent/a.jsx");                         // 根不可用 → 原样（同改造前）
        // 往返：转相对再还原 → 同一文件（分隔符归正斜杠）
        std::string p0 = "C:\\AE_Data\\assets\\presets\\p.ffx";
        CHECK(fromRelKey(root, toRelKey(root, p0)) == "C:/AE_Data/assets/presets/p.ffx");
    }

    // —— AEGP A_char 串解码（效果名/分类）：按中文 Windows 实测字节钉口径 ——
    // GBK 双字节里存在结构上合法的 UTF-8 序列（投影 = CD B6 D3 B0 按 UTF-8 恰解成
    // U+0376 U+04F0），所以「逐串合法 UTF-8 就原样」会把这类名字留成错编码；
    // 成批数据先 isAnsiBatch 判来源编码，判定为 ANSI 再整批按码页转。
    CHECK(isValidUtf8(std::string("\xCD\xB6\xD3\xB0", 4)));        // 投影 GBK：单串探测此处失效
    CHECK(!isValidUtf8(std::string("\xB1\xE4\xBB\xBB", 4)));       // 变换 GBK：不是合法 UTF-8
    CHECK(ansiToUtf8(std::string("\xCD\xB6\xD3\xB0", 4), 936) ==
          std::string("\xE6\x8A\x95\xE5\xBD\xB1", 6));             // 投影 → UTF-8
    CHECK(ansiToUtf8(std::string("\xB1\xE4\xBB\xBB", 4), 936) ==
          std::string("\xE5\x8F\x98\xE6\x8D\xA2", 6));             // 变换 → UTF-8
    CHECK(ansiToUtf8("ADBE Drop Shadow", 936) == "ADBE Drop Shadow");   // ASCII 原样
    CHECK(ansiToUtf8("", 936).empty());
    CHECK(ansiToUtf8(std::string("\xCD\xB6\xD3\xB0", 4), 12345) ==
          std::string("\xCD\xB6\xD3\xB0", 4));                     // 码页不可用：原样返回
    {
        // 一批只有一个来源编码：任一非 ASCII 串证伪 UTF-8 ⇒ 整批 ANSI，歧义串随之按 ANSI 解
        std::vector<std::string> utf8Only = {std::string("\xE6\x8A\x95\xE5\xBD\xB1", 6),
                                             "ADBE Drop Shadow"};
        CHECK(!isAnsiBatch(utf8Only));
        std::vector<std::string> ansiWithAmbiguous = {std::string("\xB1\xE4\xBB\xBB", 4),
                                                      std::string("\xCD\xB6\xD3\xB0", 4)};
        CHECK(isAnsiBatch(ansiWithAmbiguous));
        std::vector<std::string> ambiguousOnly = {std::string("\xCD\xB6\xD3\xB0", 4)};
        CHECK(!isAnsiBatch(ambiguousOnly));                        // 只有歧义串时不足以判定
        std::vector<std::string> asciiOnly = {"ADBE Drop Shadow", "UnMult"};
        CHECK(!isAnsiBatch(asciiOnly));                            // 全 ASCII：两种编码字节相同
        std::vector<std::string> withCategory = {std::string("\xE6\x8A\x95\xE5\xBD\xB1", 6),
                                                 std::string("\xC4\xA3\xBA\xFD", 4)};   // 分类「模糊」
        CHECK(isAnsiBatch(withCategory));                          // 分类串同样参与判定
        std::vector<std::string> empty;
        CHECK(!isAnsiBatch(empty));
    }
    // 混批：整批复用同一个来源编码，ANSI 批里的合法 UTF-8 名字会被按码页再解一次（取舍已在 data.h 注明）
    {
        std::string utf8Name("\xE6\x8A\x95\xE5\xBD\xB1", 6);       // UTF-8「投影」
        std::vector<std::string> mixed = {std::string("\xB1\xE4\xBB\xBB", 4), utf8Name};
        CHECK(isAnsiBatch(mixed));                                 // 有证伪串 ⇒ 整批按 ANSI 解
        CHECK(ansiToUtf8(utf8Name, 936) != utf8Name);              // 该名字被再解一次（非幂等）
    }
    // CP_ACP 宏值为 0：生产调用传的就是 0，本机码页为 936 时与固定码页同解
    if (GetACP() == 936) {
        CHECK(ansiToUtf8(std::string("\xCD\xB6\xD3\xB0", 4), CP_ACP) ==
              std::string("\xE6\x8A\x95\xE5\xBD\xB1", 6));
    }
    // 非法/截断字节不报失败：flags=0 下 CP936 解成默认替换字符 '?'（不抛错、不中断）
    CHECK(ansiToUtf8(std::string("\x81", 1), 936) == std::string("?", 1));

    return g_fail;
}
