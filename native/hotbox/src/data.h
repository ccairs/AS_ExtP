// data.h — 数据层：从扩展数据目录加载 效果/脚本/预设 为统一 Item 列表
#pragma once
#include <string>
#include <vector>

namespace data {

struct Item {
    std::string name;      // 显示名
    std::string type;      // "effect" | "script" | "preset"
    std::string category;  // 效果分类（脚本/预设可为空或相对路径）
    std::string key;       // effect=matchName；script/preset=绝对路径
    unsigned long long size = 0;   // 预设去重键用：.ffx 字节数（0 = 未知）
};

// 返回默认数据目录 %APPDATA%\Adobe\CEP\extensions\AS_ExtP（支持自定义标记文件）
std::string defaultDataDir();

// 编码转换（UTF-8 ↔ UTF-16）：项目约定路径统一 UTF-8，文件打开统一走宽路径
// （窄 char* 路径按 ANSI/GBK 解释，含中文的路径会乱码打不开）
std::wstring utf8ToWide(const std::string& s);
std::string wideToUtf8(const std::wstring& s);

// —— 系统 ANSI（A_char）→ UTF-8 ——
// 用于 AE 的 AEGP A_char 串（AEGP_GetEffectName / AEGP_GetEffectCategory）：SDK 约定这类
// 字符串是系统 ANSI 编码（同一 EffectSuite4 里只有 matchName 显式标注 UTF8）。
// 单串判不出编码：ANSI 双字节序列可能同时是合法 UTF-8——GBK「投影」= CD B6 D3 B0 与
// UTF-8 的 U+0376 U+04F0 是同一串字节。故成批数据先 isAnsiBatch 整批判定，判定为 ANSI 的
// 批次无条件按 codePage（调用方传 CP_ACP）解；同一批不混两种来源编码，混批时合法 UTF-8 的
// 名字也会按 codePage 再解一次（见 isAnsiBatch）。
// 失败模式：码页不可用原样返回；flags=0 下非法字节解成 U+FFFD（不报错、不中断）。
// 半截样本（调用方只取到部分条目）同样只在这批样本里判定：样本全是歧义串时会判成 UTF-8，
// 由调用方的完整性判定（data::effectEnumCacheable）挡住缓存，下次弹出重走全量。
// codePage 显式传入，供单测用固定码页钉字节口径。
std::string ansiToUtf8(const std::string& s, unsigned int codePage);

// 整批编码判定（与 ansiToUtf8 配套）：批内任一含非 ASCII 字节且不是合法 UTF-8 的串
// ⇒ 该批是 ANSI（true）。全批合法 UTF-8（含纯 ASCII 的英文 AE）⇒ false，按 UTF-8 原样用。
// 为什么按批：单串歧义无法就地判（见 ansiToUtf8），而一批数据只有一个来源编码——
// 只要有任一串证伪 UTF-8，整批即 ANSI，歧义串随之按 ANSI 解释。
bool isAnsiBatch(const std::vector<std::string>& texts);

// 数据根目录安全校验（defaultDataDir 用于指针文件内容；导出供单测覆盖）
bool isSafeDataRoot(const std::string& p);

// 数据源签名的「效果枚举有效性」判据（纯逻辑，导出供单测）——只有
// **枚举完整且非空**（fxCount>0 且 enumerationComplete）才允许把本次数据签名记成
// 有效缓存。半截枚举（AEGP_GetNextInstalledEffect 中途失败 break 返回部分 n>0）与
// 「计数>0 但一条没取到」若被记为有效，会话内不再重算，用户会一直看到残缺/空的
// 效果列表（安装效果数不变 → 签名恒命中）。返回 false 时调用方置 sigOk=false，
// 下次弹出重走全量加载（允许重试）。
inline bool effectEnumCacheable(int fxCount, bool enumerationComplete) {
    return fxCount > 0 && enumerationComplete;
}

// UTF-8 合法性校验（同样只用于 data-dir.txt 内容；与 glsl-host 对齐）。
// 为什么单列一条：被以 ANSI/GBK 保存的路径能过 isSafeDataRoot（0x80+ 字节不在其
// 黑名单里），但拿去 CreateDirectoryW/找文件只会得到乱码路径——日志与效果库会
// "静默搬去别处"。导出供单测覆盖（与 isSafeDataRoot 同规矩）。
bool isValidUtf8(const std::string& s);

// 从 JSON 文本解析 effects_cache.json → 效果 Item 列表（纯函数）。
// 起该文件是效果列表的**兜底**源：主源是 aeexec_enumerateEffects 的 AEGP
// 原生枚举，仅当它返回 0（AEGP 未就绪/失败）时由 window.cpp loadData 读这里
std::vector<Item> parseEffects(const std::string& jsonText);

// 从 JSON 文本解析 assets/presets/index.json → 预设 Item 列表（纯函数）
std::vector<Item> parsePresets(const std::string& jsonText);

// —— 预设双源（扩展库 + AE 预设目录）：扫描 / 补尺寸 / 合并去重 ——
// 去重键 = 小写名 + '\t' + 字节数，即「同名同大小 = 同一预设」。
// 为什么不只按名：AE 出厂预设里真有同名不同内容的两条（例如：
// 「百叶窗」191231/26526 字节、「放大」43417/75976 字节），只按名去重会吞掉真实条目；
// 为什么必须带大小：面板入库是把 .ffx 逐字节复制进扩展库（copyFileAsync），副本与
// 来源同名同大小，带大小才认得出副本。代价：同名且大小恰好相同的不同内容会被折叠
// （实际数据里 0 例，见上）。
std::string presetDedupeKey(const Item& it);

// 合并去重（保序）：键已出现在 preferred 的 secondary 条目丢弃。
// 结果 = preferred 原序 + secondary 未命中项原序——调用方用 preferred 表达优先级。
std::vector<Item> mergePresetsDedup(const std::vector<Item>& preferred,
                                    const std::vector<Item>& secondary);

// AE 预设目录的一项（I/O 与纯逻辑分离，便于单测纯的部分）
struct FfxFile {
    std::string absPath;            // 绝对路径
    unsigned long long size = 0;    // 字节数
};

// 递归枚举 root 下的 .ffx（跳过 . / .. 与重解析点；迭代式遍历，无递归深度风险）。
// root 为空或不可读 → 空列表（AE 预设目录缺失即"无此数据源"，不是错误）。
std::vector<FfxFile> listFfxFiles(const std::string& root);

// 由扫描结果构造 Item（纯函数）：name=文件名去 .ffx、category=相对 root 的文件夹（"/" 分隔）、
// key=绝对路径、size=字节数。category 的空/非空语义与扩展库索引的 folder 字段一致。
std::vector<Item> presetItemsFromFiles(const std::string& root, const std::vector<FfxFile>& files);

// = listFfxFiles + presetItemsFromFiles（AE 预设目录扫描入口）
std::vector<Item> scanPresetDir(const std::string& root);

// 库索引条目的 size 按真实文件校准（去重键含字节数，索引值可能是过时的）：
//   文件在 → 覆盖为实际字节数（入库后被替换/重存过的条目由此纠正）；
//   文件不在 → 置 0「未知」——不能拿过时的索引值去折叠 AE 侧同名同大小的真条目，
//   否则删掉库内 .ffx 后热盒只剩一条必然应用失败的条目、可用的 AE 预设反被顶掉。
void fillItemSizes(std::vector<Item>& items);

// —— AE 安装根 / 预设目录定位 ——
// 由插件模块路径推导安装根（<AE>\Support Files\Plug-ins\AS_Hotbox.aex → <AE>）。
// 不在 Support Files\Plug-ins 之下（例如装在 MediaCore）返回空串，调用方走 ExtendScript
// app.path 兜底——与扩展 ae-tools 的 getInstallPath(S1) 同源。
std::string aeInstallRootFromModulePath(const std::string& modulePath);

// 规范 AE 自报的安装路径（app.path，正斜杠，可能已含 Support Files）→ 安装根（反斜杠）。
// 纯函数，供单测；无法判定（空串）返回空串。
std::string normalizeAeInstallRoot(const std::string& reportedPath);

// 安装根 → Documents\Adobe 下的用户预设目录名（"Adobe After Effects 2023" → "After Effects 2023"）。
// 段名不含 "After Effects" 时返回空（无法判定即不纳入该数据源）。
std::string aeUserPresetsSubdir(const std::string& installRoot);

// 用户预设目录（%USERPROFILE%\Documents 与 OneDrive 变体下 Documents\Adobe\<subdir>\User Presets）。
// 返回首个真实存在的候选；subdir 为空或无候选存在 → 空串。
std::string userPresetsDir(const std::string& subdir);

// 安装根 → 出厂预设目录（<AE>\Support Files\Presets）；安装根为空 → 空串
std::string aeStockPresetsDir(const std::string& installRoot);

// 插件自身模块路径（GetModuleFileNameW）。失败返回空串。
std::string currentModulePath();

// 目录存在性（GetFileAttributesW；调用方据此决定是否把该目录纳入数据源）
bool dirExists(const std::string& path);

// 判定 .ffx 预设文件名（大小写不敏感；纯函数，供单测覆盖）
bool isFfxFile(const std::string& name);

// 构造脚本 Item（纯函数）：name 文件名、relPath 相对脚本根的文件夹路径、absPath 绝对路径
Item makeScriptItem(const std::string& name, const std::string& relPath, const std::string& absPath);

// 判定 .jsx / .jsxbin 脚本文件名（大小写不敏感；纯函数，供单测覆盖）
bool isScriptFile(const std::string& name);

// —— 手势槽/最近使用里 script/preset 的 key 按数据根相对持久化 ——
// 病灶：config.json gesture.slots 与 recent.json 的 key 存的是**绝对路径**；换数据目录后
// 槽位仍指向旧根（旧根在 → 操作旧副本；旧根删 → 「预设文件不存在/读取脚本失败」）。
// 约定与面板侧同源（client/shared/dataDir.js 的 toDataRelPath/fromDataRelPath）：
// 数据根**内** → 相对（正斜杠）；根外/已是相对 → 原样（用户自己的文件与换目录无关）。
// 只在**持久化边界**转换：内存里的 Item.key 恒为绝对（枚举/去重/执行全链不变）。
// effect 的 key 是 matchName（非路径），调用方不要对它调用本对函数。
// 两个都是纯函数，导出供单测覆盖（与 isSafeDataRoot 同规矩）。
std::string toRelKey(const std::string& root, const std::string& key);
std::string fromRelKey(const std::string& root, const std::string& key);

} // namespace data
