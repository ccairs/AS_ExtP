#pragma once
// effectState.h —— 效果状态（MFR 下多线程共享读写）
// N1 修复后的状态划分（原为进程级单例，多实例互相覆盖）：
//   - per-instance（每实例独立）：选中文件索引存 AE 原生参数值（kIdxFileIndexParam
//     的 PF_Param_FLOAT_SLIDER fs_d.value，随工程持久化），所有使用点从本实例
//     params/checkout 读取，不再有全局 selectedFileIndex 镜像；
//   - per-file（进程级共享，正确共享）：源码/uniforms/解析告警/结构签名/FileWatcher
//     按文件路径缓存于 GlobalState.fileCache——同文件必然同解析结果，多实例共享无串扰；
//   - 进程级共享：popupChoices（effects/ 目录列表，全实例同目录）。
#include <string>
#include <vector>
#include <map>
#include <windows.h>
#include "params.h"
#include "uniformParser.h"
#include "glslLoader.h"

namespace host {

// 进程级共享状态（MFR 下多线程共享读写，需 CRITICAL_SECTION 保护）
// 注：避免使用 std::mutex，其在 DLL 环境中可能因 CRT ABI 不一致导致崩溃
struct ShaderFileEntry {
    std::string source;                    // 该文件当前生效源码（空 = 加载失败/空文件）
    std::vector<glsl::Param> uniforms;     // 该文件当前生效参数列表（≤ kMaxParams）
    uint8_t channelsUsed = 0;              // 映射图层声明 bitmask（bit0=iChannel1 … bit2=iChannel3）
    glsl::IterConfig iterCfg;              // 迭代/结算配置（@iterations/@solve/@history/@solveRes）
    std::string parseWarning;              // 解析告警（uniform 数组不支持、未绑定的采样器等）
    // 结构签名（"type|name;..." 串）：条目（重）加载时由 loadEffectFile 写入，记录本次
    // 解析出的 uniform 类型/顺序/数量。可见行由画布按当前 uniform 逐行自绘，不按签名
    // 重建任何参数行；param-map 的比对键直接取 uniformSignature(snap.uniforms)。
    std::string uiSignature;
    bool loaded = false;                   // 是否已成功加载（source 非空）
    // 重载消费权交还——UI 线程（SyncParamUI，ECW 打开时 UPDATE_PARAMS_UI）
    // 也会以 checkReload=true 抢先消费 watcher 状态（needsReload 置 hasSeen_），
    // 渲染路径随后 needsReload() 恒 false → snap.reloaded 永假 → error.log 的
    // 陈旧错误永不清除（「重载成功即清」只在渲染路径执行）。真实重载消费后
    // 置位此标记，下一次 checkReload 调用强制 snap.reloaded=true 补一次消费
    //（clearErrorLog/告警回写均幂等，重复消费无害）。
    bool renderConsumePending = false;
    glsl::FileWatcher watcher;             // 该文件的热重载监听（needsReload 消费内容）
};

struct GlobalState {
    CRITICAL_SECTION mutex;                // 线程安全保护（Win32 原生，无 CRT 依赖）
    std::vector<std::string> popupChoices; // effects/*.glsl 库文件名（不含扩展名，按字母序）
    // 按文件绝对路径缓存的解析结果（多实例共享：同文件 → 同 uniforms）
    std::map<std::string, ShaderFileEntry> fileCache;
};

// CRITICAL_SECTION 的 RAII 封装（替代 std::lock_guard，避免 CRT ABI 问题）
struct CSLock {
    CRITICAL_SECTION* cs;
    CSLock(CRITICAL_SECTION& c) : cs(&c) { EnterCriticalSection(cs); }
    ~CSLock() { if (cs) LeaveCriticalSection(cs); }
    CSLock(const CSLock&) = delete;
    CSLock& operator=(const CSLock&) = delete;
};

GlobalState& globalState();

// uniform 结构签名（"type|name;..." 串）：SyncParamUI/loadEffectFile 检测结构变化用
std::string uniformSignature(const std::vector<glsl::Param>& params);

// —— 按路径/索引取文件条目快照（锁内拷贝，锁外使用）——
struct ShaderSnapshot {
    std::string path;                      // 空串 = 无有效文件（空库）
    std::string source;                    // 空 = 文件缺失/空 → 渲染走透传
    std::vector<glsl::Param> uniforms;     // 该文件的 uniform 列表
    uint8_t channelsUsed = 0;              // 映射图层声明 bitmask（透出给面板显隐/渲染 checkout）
    glsl::IterConfig iterCfg;              // 迭代/结算配置（ECW 据此决定「重算」按钮显隐）
    std::string parseWarning;              // 解析告警
    std::string uiSignature;               // 条目当前签名（与 uniforms 对应）
    bool reloaded = false;                 // 本次调用发生了文件（重）读
    bool uniformsChanged = false;          // （重）读导致 uniform 列表变化
};

// 索引 → 文件绝对路径：越界钳制回第一个库文件（kDefaultFileIndex），
// 空库返回空串（渲染走透传）。读 popupChoices 需短暂持锁。
std::string shaderPathForIndex(int idx);

// 取条目快照。checkReload=true 走 FileWatcher 检测文件变化并重读（Render/
// SmartRender/点击切换路径）；false 仅在条目未加载时直接读文件一次（ECW 绘制
// 等只读路径，热重载由渲染路径驱动）。
// forRender=true 限定 Render/SmartRender 调用方——renderConsumePending
// 补确认标记（见 ShaderFileEntry 注释）只允许渲染路径消费（「重载成功即清
// error.log」在渲染回调执行）；UI 调用方（SyncParamUI/文件切换等）不得吃掉。
ShaderSnapshot getShaderForPath(const std::string& path, bool checkReload, bool forRender = false);
ShaderSnapshot getShaderForIndex(int idx, bool checkReload, bool forRender = false);

// 读取指定文件指定槽位的 uniform（只拷贝 1 个 Param，避免每帧 DRAW × 32 控件
// 全量拷贝 uniforms 列表——其 std::string 成员会堆分配）。条目不存在时惰性
// 加载（直接读文件，不消费 watcher 状态）。
bool shaderUniformAt(const std::string& path, int slot, glsl::Param* out);

// 该文件的迭代/结算模式（ECW 的「重算」按钮只在 Solver 模式下显示）。
// 与 shaderUniformAt 同款：锁内查缓存条目，条目不存在时惰性加载一次文件。
glsl::IterMode shaderIterMode(const std::string& path);

// 写条目结构签名（loadEffectFile 在 PARAMS_SETUP 预载时写入）
void setEntrySignature(const std::string& path, const std::string& sig);

// effects/ 目录扫描：返回 .glsl 文件名（不含扩展名）按字母序
// 扩展名大小写不敏感（.glsl/.GLSL/.Glsl... 均收录）。
std::vector<std::string> scanEffectsDir();

// 目录参数化版本（供单测用可控临时目录直接覆盖；scanEffectsDir
// 传 effectsDirPath()）。语义同 scanEffectsDir，不做任何目录存在性以外的 I/O。
std::vector<std::string> scanEffectsDirIn(const std::string& dir);

// 名字 → 当前库列表中的位置（大小写不敏感：列表本身即按 _stricmp 排序）。
// 未命中返回 -1。用于"实例记住文件名"后按名解析，库位移不再影响已有实例。
// NoRescan 变体不做目录重扫 —— 供 DRAW 等热路径使用（每帧每控件都会调用，
// 而重扫是"枚举目录 + 排序"；热路径上列表由渲染/快照路径负责保持新鲜）。
int indexForShaderName(const std::string& name);
int indexForShaderNameNoRescan(const std::string& name);

// 第 idx 项的名字（不含扩展名）。越界/空库 → 空串。
std::string shaderNameAtIndex(int idx);

// 名字 → 绝对路径。未命中返回空串（渲染走透传，而不是静默换另一个文件）。
std::string shaderPathForName(const std::string& name);

// 在给定库列表里做 name → (0 基下标, 绝对路径) 解析——大小写不敏感，
// 与 indexForShaderNameNoRescan / shaderPathForName 命中分支同口径；未命中返回 -1
// 且 outPath 清空。纯函数（无锁无 I/O，供单测直接覆盖）：getShaderByIdentity
// 单次重扫后在同一份 popupChoices 快照上用它一次完成解析，把 3 次目录
// 枚举（入口 maybeRescan + indexForShaderName 内 + shaderPathForName 内）降为 1 次，
// 且下标与路径不会因并发刷新而漂移（单锁内取自同一列表）。dir 为空（数据根解析
// 失败）时命中下标仍返回、路径为空串（调用方 getShaderForPath("") → 空快照透传）。
int resolveShaderNameInList(const std::vector<std::string>& names,
                            const std::string& dir,
                            const std::string& name,
                            std::string* outPath);

// 身份优先取快照：name 非空且在当前列表命中 → 取该文件；
// 否则按 fallbackIdx 位置回退（v1 旧工程 / 名字所指文件已删）。
// outResolvedIndex 返回实际生效的位置（-1 = 名字与位置都没命中，快照为空）。
ShaderSnapshot getShaderByIdentity(const std::string& name, int fallbackIdx,
                                   bool checkReload, bool forRender,
                                   int* outResolvedIndex);

// 「实例记住的库文件已不存在」告警的写点（同名去重 + error.log 代际
// 校验，语义见 effectState.cpp）。返回本次是否真的写了 error.log。
// dir 参数化供单测用可控临时目录直接覆盖；生产路径 logMissingIdentityOnce
// 传 effectsDirPath()（渲染每帧调用，不能逐帧写盘）。
bool logMissingIdentityOnceAt(const std::string& dir, const std::string& name);

// 重扫 effects/ 目录刷新选择器选项列表（全部为库文件）；返回选项数
int refreshPopupChoices();

// —— 库目录自检：库成员变化后自动跟上（无需人工点 ↻）——
// 库列表若只在 PARAMS_SETUP（挂效果/开工程）与自定义 UI 的 ↻ 两处刷新，则
// "保存了新 shader"之后没人点 ↻ 就一直是旧列表——索引也就一直指不到新文件。
// 判据 = 重新扫描并与当前 popupChoices 逐项比对，**不用目录 mtime**：
// NTFS 目录内新建文件后目录 last_write_time 可能不变
//（延迟回写，实测第一次新建后 stat 值原封不动），拿它当判据会漏掉新增。
// 返回本次是否发生了变更提交（含导出重写）。调用点见 getShaderForIndex
//（RENDER 与 PARAMS_SETUP 同路，故最迟下一帧渲染即自愈）。
bool maybeRescanEffectsDir();


// —— 库索引导出（面板 LLM 取"效果控件里那份列表"的唯一通道）——
// AE 的效果参数没有字符串类型，文件名传不出插件；选择器是 ARBITRARY_DATA，
// 脚本读不到其条目。故把宿主内存中的 popupChoices（= ECW 选择器显示的那份）
// 落成面板可读的文本。索引即该列表的 0 基下标——与 shaderPathForIndex 的
// 钳制口径一致，是"写进 kIdxFileIndexParam 才不会指错文件"的唯一依据。
// 文件名 library-index.txt（.txt 不会被 scanEffectsDir 收进库，也不进
// shader_library 的 .glsl/.js 面）。
constexpr const char* kLibraryIndexFileName = "library-index.txt";

// 纯文本生成（无 I/O，供单测）。每行 "<0基序号>\t<库文件名不含扩展名>"。
std::string libraryIndexDumpText(const std::vector<std::string>& names);

// 写盘。dir 为 UTF-8 的 effects 目录；写失败静默返回 false（不得影响渲染/UI）。
bool writeLibraryIndexDump(const std::string& dir, const std::vector<std::string>& names);

// effects/ 目录绝对路径
std::string effectsDirPath();

// 数据根目录绝对路径（含 AS_ExtP）：读 data-dir.txt 指针，自定义则用自定义目录
// （解析结果经 FileWatcher 缓存，指针文件变化即时失效重读）
std::string dataRootDirPath();

// 解析数据根并缓存（dataRootDirPath 的实现核心）。defRoot = data-dir.txt
// 所在的默认根目录。导出供测试用可控路径覆盖缓存生效/失效回归。
std::string resolveDataRoot(const std::string& defRoot);

// —— 槽位参数索引（单分组布局 + 每槽 4 分量）——
// 每个槽位由 4 个原生参数承载（均为 PF_Param_FLOAT_SLIDER）——
//   分量 c 的索引 = 5 + 4*i + c（kIdxSlots + i*kFloatsPerSlot + c，i = 0..31，c = 0..3）
// 4 个分量全部 PF_PUI_NO_ECW_UI：纯数值容器，不出现在 ECW；控件由「参数」组内的
// 自绘画布逐行绘制（见 params.h kIdxCanvas）。脚本按索引或 matchName（disk ID
// 500+4i+c）寻址；分量0 的 .name 恒为空串。
// 槽位序号（0..31）→ 该槽位分量0 的 AE 参数索引（恒为 5+4i）；非法槽位返回 -1
int slotParamIndex(int slot);
// 槽位序号（0..31）+ 分量号（0..3）→ 该分量的 AE 参数索引（恒为 5+4i+c）；
// 非法入参返回 -1
int slotCompIndex(int slot, int comp);
// AE 参数索引 → 槽位序号；只有分量0 的索引（5, 9, 13, …）映射为槽位，其余返回 -1
int slotFromIndex(int idx);

} // namespace host
