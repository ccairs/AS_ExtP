// window.cpp — 浮窗：手势模式（6 弧段 + 中心 EDIT）↔ 搜索模式（长条搜索栏 + 线性列表 + 过滤下拉）
#include "window.h"
#include "geom.h"
#include "aeexec.h"
#include "log.h"
#include "data.h"
#include "search.h"
#include "json.h"
#include "config.h"
#include "hotkey.h"
#include "capture.h"
#include "i18n.h"
#include <windows.h>
#include <mmsystem.h>
#include <d2d1.h>
#include <dwrite.h>
#include <string>
#include <fstream>
#include <filesystem>
#include <iterator>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <unordered_set>
#include <wincodec.h>
#include <wincodecsdk.h>
#pragma comment(lib, "d2d1.lib")
#pragma comment(lib, "dwrite.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "winmm.lib")
#pragma comment(lib, "windowscodecs.lib")

// —— DPI 缩放支持 ——
// AE（PerMonitor V2 DPI Aware）进程下，所有 Win32 API 接受物理像素；
// 代码内常量（kWinW/kCx/kBarY 等）是 DIP（逻辑像素），需乘 scale 转物理像素。
// 鼠标消息坐标是物理像素，命中测试用 DIP，需除 scale。
// 在 200% 缩放下，若按 1:1 处理，窗口物理尺寸 440x440、D2D 按 192 DPI 绘制
// 440 DIP → 880 物理像素，RenderTarget 仅 440x440 → 内容被裁切到左上 1/4。
static float g_dpiScale = 1.0f;
// 前置声明：g_rt 在匿名命名空间内定义，refreshDpiScale 需提前更新其 DPI
ID2D1RenderTarget* g_rt = nullptr;   // WicBitmapRenderTarget（per-pixel alpha）
// WIC 位图 + DIB：渲染到 WIC → 转 HBITMAP → UpdateLayeredWindow 提交 per-pixel alpha
IWICImagingFactory* g_wicFactory = nullptr;
IWICBitmap* g_wicBitmap = nullptr;
ID2D1Bitmap* g_d2dBmp = nullptr;     // RT 渲染源位图（从 g_wicBitmap 创建）
HBITMAP g_dib = nullptr;             // DIB，用于 UpdateLayeredWindow 提交
void* g_dibBits = nullptr;           // DIB 位图位数据指针
HDC g_memDC = nullptr;               // 兼容 DC，SelectObject(g_dib) 后用于 ULW
int g_bmpW = 0, g_bmpH = 0;          // 当前位图尺寸（物理像素）
// 把 DIP 转 物理像素（用于 SetWindowPos / CreateWindowExW / MoveWindow 等尺寸参数）
static int phys(double dip) { return (int)(dip * g_dpiScale + 0.5); }
// 把物理像素转 DIP（用于鼠标消息坐标 → 命中测试）
static int dipOf(int physVal) { return (int)(physVal / g_dpiScale + 0.5); }
// 刷新 g_dpiScale（窗口所在显示器 DPI；fallback 96 = 1.0）
static void refreshDpiScale(HWND hwnd) {
    UINT dpi = 96;
    HMODULE u32 = GetModuleHandleW(L"user32.dll");
    if (u32) {
        typedef UINT(WINAPI* PFN_GetDpiForWindow)(HWND);
        auto pfn = (PFN_GetDpiForWindow)GetProcAddress(u32, "GetDpiForWindow");
        if (pfn && hwnd) dpi = pfn(hwnd);
        else if (pfn) {
            typedef UINT(WINAPI* PFN_GetDpiForSystem)();
            auto spfn = (PFN_GetDpiForSystem)GetProcAddress(u32, "GetDpiForSystem");
            if (spfn) dpi = spfn();
        }
    }
    if (dpi < 96) dpi = 96;
    g_dpiScale = (float)dpi / 96.0f;
    // 同步 D2D RenderTarget DPI：使 DIP 绘制坐标自动缩放到物理像素
    // （不设则默认 96，200% 缩放下 DIP(220,240) 渲染到像素(220,240) → 只画左上 1/4）
    if (g_rt) {
        g_rt->SetDpi((float)dpi, (float)dpi);
    }
}

// 按屏幕坐标取目标显示器 DPI（呼出定位专用）——refreshDpiScale(g_hwnd) 在
// SetWindowPos 之前调用读到的是窗口当前所在屏（上一屏）的 DPI：混合 DPI 双屏跨屏
// 呼出时 phys() 按上一屏 scale 计算整窗物理尺寸（窗口缩放整体错误），dipOf() 反向
// 换算命中测试错位（点中心圆进不了搜索；同屏重复呼出自愈才碰巧正常）。先按呼出点
// 定位目标屏取 DPI 再定位。GetDpiForMonitor 与既有 GetDpiForWindow 同为运行时动态
// 解析（shcore，Win8.1+；AE2023 仅支持 Win10+ 必在），MDT_EFFECTIVE_DPI(0) 与
// PerMonitor V2 进程的 GetDpiForWindow 语义一致；失败回退系统 DPI（旧口径兜底）。
static void refreshDpiScaleAtPoint(int x, int y) {
    UINT dpi = 0;
    HMONITOR mon = MonitorFromPoint({ x, y }, MONITOR_DEFAULTTONEAREST);
    if (mon) {
        HMODULE sh = GetModuleHandleW(L"shcore.dll");
        if (sh) {
            typedef HRESULT(WINAPI* PFN_GetDpiForMonitor)(HMONITOR, int, UINT*, UINT*);
            auto pfn = (PFN_GetDpiForMonitor)GetProcAddress(sh, "GetDpiForMonitor");
            if (pfn) {
                UINT dx = 0, dy = 0;
                if (SUCCEEDED(pfn(mon, 0 /* MDT_EFFECTIVE_DPI */, &dx, &dy))) dpi = dx;
            }
        }
    }
    if (dpi == 0) {   // shcore 缺失/查询失败（老系统兜底）：退回系统 DPI
        refreshDpiScale(nullptr);
        return;
    }
    if (dpi < 96) dpi = 96;
    g_dpiScale = (float)dpi / 96.0f;
    if (g_rt) {
        g_rt->SetDpi((float)dpi, (float)dpi);   // 同步 D2D RT DPI（同 refreshDpiScale）
    }
}

namespace {

// 前置声明：实现位于文件后部，paint / executeSelected 等提前调用
std::string categoryName(const std::string& t);
std::wstring truncateW(const std::wstring& s, size_t maxChars);
// 按像素宽度截断（zh-CN 保持按字符数口径，见定义）；maxHeight <= 0 表示单行判据
std::wstring truncateForWidth(const std::wstring& s, size_t zhMaxChars, IDWriteTextFormat* fmt,
                              float maxWidth, float maxHeight = 0.0f);
std::wstring truncateToWidth(const std::wstring& s, IDWriteTextFormat* fmt, float maxWidth,
                             float maxHeight = 0.0f);
void enterSearchMode(const std::string& filterType);
bool execItem(const data::Item& it, std::string* failMsg, bool* deferred = nullptr);
void abortBatch(bool quiet = false);   // 中止进行中的预设批量（Esc/关窗/重新弹出；闭合 undo group）
void enterFailDwell(const std::string& msg);   // 失败提示驻留态（环心提示 + 停留后渐隐）
void cancelFailDwell();                        // 清失败提示驻留态与其计时器（召唤入口/doHide 调用）
bool hostApiReady(std::string* errHint);
void enterSettings();
void enterProgressMode();   // 预设批量启动 → 进度卡片（手势/搜索统一转场）
void updateProgressWindowSize();   // 进度卡片窗口尺寸（错误态按文本测量自适应）
void paintSettings(ID2D1SolidColorBrush* brBorder, ID2D1SolidColorBrush* brFill,
                   ID2D1SolidColorBrush* brFillSel, ID2D1SolidColorBrush* brText,
                   ID2D1SolidColorBrush* brMuted, ID2D1SolidColorBrush* brRowHover,
                   ID2D1SolidColorBrush* brAccent);
void backToGesture();
void doHide();   // 动画退场完成后真正隐藏（WM_TIMER 调用）
void focusEdit();   // 聚焦 EDIT 输入框（延迟清 g_focusingEdit，防异步失活误关闭）
void updateSearchWindowSize();   // 搜索模式窗口高度自适应面板
void restoreGestureWindow();     // 回手势/设置：恢复 440 全高并环心对齐鼠标
bool fsReadText(const std::string& path, std::string* out);
bool fsWriteText(const std::string& path, const std::string& content);
bool readConfigSafe(const std::string& path, std::string* out);   // 读侧防线（读失败/坏 JSON 拒绝整包重建）
std::string hotboxDataPath(const std::string& file);
// config.json 写盘统一出口 / 读侧相对 key 还原（定义见文件后部）
std::string configTextForWrite(const std::string& text);
void resolveItemKeys(std::vector<data::Item>& items);
void resolveSlotKeys(std::vector<config::SlotConfig>& slots);

const int kWinW = 380, kWinH = 440;
const double kCx = 190.0, kCy = 240.0;    // 环心（窗口客户区坐标，x=WinW/2 居中）
const double kRIn = 62.0, kROut = 125.0;  // 环带内外半径（紧凑：外径减小、贴近中心圆）
const double kCornerR = 8.0;              // 弧段四角圆角半径（近似内切圆弧）
const double kCenterR = 36.0;             // 中心圆半径（paint 与 inCenter 共用，消除重复魔数）
const hotbox::SegmentLayout kLayout = { 6, 6.0, -90.0 };
const int kSegmentCount = 6;              // 手势环弧段数（与 kLayout.segCount 一致）
const int kSettingsSlot = 3;              // 正下方弧段（90° 方向）= 设置入口
const int kCaptureSlot = 0;               // 正上方弧段（-90° 方向）= 合成预览图入口（不承载槽位功能）
const double kSettingsSpan = 26.0;        // 设置段角度跨度（较窄，给左右弧段腾位）
const double kSegGap = 2.0;               // 弧段间透明缝（分隔弧段，替代描边）
const size_t kRecentMax = 100;            // 最近使用保留条数（单条 ≈ 100B，100 条约十几 KB）
const size_t kTypoMaxResults = 8;          // 手误容错一次最多列出的近似条目数

// 非均匀弧段布局：各段以等分中心角（60°）为中心展开；设置段较窄（26°）居中正下方，
// 其余段保持 60° 标准跨度——设置段省出的角度在它两侧留空隙，弧段互不重叠。
// 每段实际跨度减去 kSegGap：段间留 2° 透明缝（弧段分离），故弧段无需描边分隔——
// 否则外弧两端圆角（0°/180° 处竖直走向）的描边会在透明背景上显出竖黑线。
double segmentSpan(int i) {
    if (i == kSettingsSlot) return kSettingsSpan - kSegGap;
    return 360.0 / kLayout.segCount - kSegGap;
}
// 段 i 起始角（度）：由中心角展开半跨度，设置段中角恰为 90°（正下方）
double segmentStart(int i) {
    double center = kLayout.startDeg + i * (360.0 / kLayout.segCount);
    return center - segmentSpan(i) / 2.0;
}

// 透明窗口：ULW + per-pixel alpha（不用 colorkey 魔法色方案）

HWND g_hwnd = nullptr;
HWND g_edit = nullptr;
WNDPROC g_editOldProc = nullptr;
// EDIT 控件字体句柄（window_destroy 配对 DeleteObject；若只把 CreateFontW 存局部
// 变量仅传 WM_SETFONT，插件重载逐次泄漏 GDI 句柄）
HFONT g_editFont = nullptr;
// CoInitialize 按次计数，window_destroy 时配对 CoUninitialize 归还 apartment
// 引用（ensureD2D 失败重试路径可能多次进入）
static int s_comInitCount = 0;
bool g_visible = false;
int g_sel = -1;                   // 手势环弧段 hover
bool g_centerHover = false;       // 中心圆（搜索入口）hover 选中态
int g_pressIdx = -1;              // 手势环按下中的弧段（点击反馈：压入 + 白框）
ULONGLONG g_pressStartMs = 0;     // 弧段/中心圆按压缩入动画开始墙钟时间
// 执行散开态：executeSelected 后置 true，其他弧段渐隐消失；仅按下反馈（WM_LBUTTONDOWN）时为 false。
// 区分"按下反馈"与"执行散开"：按下时其他弧段不渐隐，松手确认执行后才渐隐，避免按下→松开闪烁。
bool g_execDispersing = false;
bool g_centerPressed = false;     // 中心圆按下中
bool g_pinned = false;   // 点击中心锁定常驻（做完整搜索模式）
// 截图三动作进行中（executeCapture 置位，含同步阻塞的渲染与保存
// 对话框全程）。**只用于豁免失活自动隐藏**——保存对话框抢走激活会产生
// WA_INACTIVE，若照常 50ms 判定关窗，用户在对话框里还没选完文件浮窗就先渐隐；
// 对话框返回后编码失败调 enterFailDwell 时 g_visible 已为 false → 失败提示被
// 直接丢弃（零回执）。独立于 g_pinned：g_pinned 在搜索/设置模式下也为 true，
// 若直接豁免 g_pinned 会让「点击面板外部关闭」在搜索/设置模式永久失效（UX 回归），
// 故单开一态，仅覆盖「捕获 + 保存对话框」这一必须豁免的窗口期。
bool g_capturing = false;
bool g_focusingEdit = false;   // SetFocus(g_edit) 进行中（拦截其触发的 WM_ACTIVATE 失活，避免误关闭）
// 执行锁：execItem 调用期间及退场动画期间为 true，防止连点触发重复执行
// （execItem 同步阻塞 UI 线程，本身不会并发；锁主要拦截 window_hide() 退场动画 150ms 内
//   排队到达的鼠标点击，避免再次触发 executeSelected/executeSearchItem）
bool g_actionLock = false;
AEGP_PluginID g_pluginID = 0L;

// —— 搜索模式：状态与数据缓存 ——
// 结果列表行高与可见行数范围（g_listRows 状态区先引用，故定义于此）
const int kRowH = 36, kMaxRowsInit = 4;                // 行高/默认可见行数（可拖拽调整）
const int kListRowsMin = 3, kListRowsMax = 9;          // 拖拽调整范围（9 行面板底贴近 440 窗口高）
enum class Mode { kGesture, kSearch, kSettings, kProgress };
Mode g_mode = Mode::kGesture;

// 搜索面板窗口高度平滑过渡：结果数变化时窗口高度不直接跳变，
// 而是在 kHeightAnimMs 内按 easeOutCubic 从当前高度插值到目标高度（先快后慢，连续感不断）
const double kHeightAnimMs = 150.0;
double g_heightFromH = 120.0;        // 高度动画起点（DIP）
double g_heightTargetH = 120.0;      // 高度动画目标（DIP）
ULONGLONG g_heightAnimStartMs = 0;   // 高度动画开始墙钟时间
bool g_inHeightAnim = false;          // 高度动画进行中
double lerp(double a, double b, double t) { return a + (b - a) * t; }
std::vector<data::Item> g_items;     // 全量数据（首次进搜索模式加载，缓存）
std::vector<data::Item> g_results;   // 当前过滤+查询结果
std::unordered_set<std::string> g_typoKeys;   // 近似匹配结果的条目 key（行首标 ≈；精确命中时清空）
int g_filterHintCount = 0;           // 「当前筛选无命中 · 切到『全部』有 N 条」的 N（0 = 不提示）
int g_resultSel = 0;                 // 选中行
int g_scrollTop = 0;                 // 结果列表可视窗口顶部行（滚轮独立滚动；选中行越界时贴边）
int g_listRows = kMaxRowsInit;       // 当前可见行数（拖拽列表下方分隔条调整）
std::string g_filterType = "all";    // "all"|"effect"|"script"|"preset"
std::string g_query;                 // 当前输入文本
bool g_filterMenuOpen = false;       // 过滤下拉是否展开
int g_filterHover = -1;              // 下拉项 hover（-1=无）
bool g_filterBtnHover = false;       // 过滤按钮 hover
int g_rowHover = -1;                 // 结果行 hover（-1=无）
bool g_statusHover = false;          // 状态行 hover（g_msg 完整内容气泡展开）
bool g_draggingScroll = false;       // 搜索列表滚动条拖动中
bool g_draggingResize = false;       // 搜索列表高度拖拽中（列表下方分隔条）
// 底边呼出防护：整窗上移后鼠标可能正压在结果行上，双击中心圆的第二击会直接执行该行。
// 进入搜索模式时记录墙钟与鼠标屏幕位；短时间内鼠标没动过的行点击视为同一记双击的第二击并吞掉。
ULONGLONG g_searchEnterMs = 0;
POINT g_searchEnterPt = { 0, 0 };
const ULONGLONG kSearchClickGraceMs = 300;
bool g_captured = false;             // 手势模式鼠标捕获中（出 UI 范围仍按方向选段）
int g_mouseX = 0, g_mouseY = 0;      // 弹出时鼠标屏幕位置（二级菜单搜索栏定位基准）
bool g_dataLoaded = false;
// 空闲预热一次性标志。不复用 g_dataLoaded——后者被 showAt 每次弹出重置
// （语义是「本次弹窗是否已加载」），预热只做一次（把首次枚举/建索引移出按键路径）
bool g_dataWarmed = false;
ULONGLONG g_initTickMs = 0;            // 插件加载墙钟（GetTickCount64）：预热延迟闸门基准
// 数据源签名缓存（loadData 脏检查用）——showAt 每次弹出重置 g_dataLoaded
// 但签名跨弹出保留，数据源未变时跳过全量重载与拼音索引重建（详见 loadData）
ULONGLONG g_dataSig = 0;
bool g_dataSigValid = false;
std::string g_msg;                     // 执行结果临时消息（状态行优先显示，下次弹出清除）

// —— 失败提示驻留态 ——
// 一级菜单（手势环）执行失败与截图三动作失败：只 hotbox_log 后立即 window_hide，
// 失败一闪而过用户看不到原因（搜索态有状态行、进度卡片有错误态可驻留，唯独手势环没有）。
// 现改为：失败文案画在环心并停留 kFailDwellMs，到点走既有退场流程（window_hide → 渐隐
// → doHide），不另造隐藏路径。停留期间保持 g_actionLock=true（沿用既有执行锁：忽略环上
// 执行动作与点击；见 WM_LBUTTONUP/window_hotkeyReleased 的 g_failActive 守卫）。
// 按热键重新召唤：window_hotkeyPressed / window_showAt 第一步 cancelFailDwell() 清态，
// 随后走正常召唤流程——代际号 g_failGen 使已入队的旧计时器消息失配，旧计时器不会在
// 稍后把新面板关掉。
std::string g_failMsg;                 // 失败文案（UTF-8，环心绘制时截断；空=无驻留）
bool g_failActive = false;             // 失败驻留中（窗口可见、不可交互、计时退场）
ULONGLONG g_failStartMs = 0;           // 驻留起始墙钟（计时器陈旧消息按已过时长校验）
ULONGLONG g_failGen = 0;               // 驻留代际：每次进入/取消自增（旧计时器语义作废）
ULONGLONG g_failTimerGen = 0;          // 当前武装计时器所属代际（0=未武装）

// —— 预设批量应用状态 ——
// applyPreset 单层数百毫秒，选中多层时整批同步执行会阻塞 AE 主线程超过
// Windows 5s 无响应阈值 → AE 被 mark "未响应"（假死）。改为定时器分块执行：
// 每块一次脚本调用（隔离选区后一次 applyPreset 应用于整块），块间 kBatchTickMs
// 让消息泵喘息，状态行/气泡显示进度。
// undo group 每块脚本内自开自闭（AE 会切断跨脚本调用维持的组，无法跨块持有）；
// 撤回按块进行，用户已确认接受（与扩展面板分块行为一致）。
struct PresetBatch {
    bool active = false;
    data::Item item;                    // 待执行项（全部成功后 recordRecent）
    std::vector<int> layers;            // 开始时快照的选中层索引（1 基；id 不可用时才作为定位键）
    std::vector<int> layerIds;          // 开始时快照的选中层 id（稳定键，与 layers 等长且全为正整数时才启用；
                                        // 空 = 引擎无 layerByID 或某个 id 取不到 → 整批退回位置键）
    double compId = 0.0;                // 开始时合成 id（中途切换/关闭即中止）
    int next = 0;                       // layers 中下一个待应用下标
    int applied = 0, failed = 0;        // 已成功/失败层数
    std::string firstError;             // 首个失败层错误（hover 气泡完整展示）
} g_batch;
std::string g_progressTitle;            // 进度卡片标题（批量启动时的条目名，doHide 清）
bool g_progressError = false;           // 进度卡片错误态（完整报错换行展示，点击/Esc 关闭）
int g_progressWinH = 84;                // 进度卡片窗口高（DIP；错误态按文本测量自适应）

// —— 手势环：槽位（自定义功能）+ 最近使用 ——
// 弧段运行时条目：固定功能项 / 类别入口（进入搜索模式并预过滤）/ 设置入口（正下方）/
// 截图入口（正上，按住弹出三花瓣子菜单）
struct GestureEntry {
    enum Kind { kItem, kCategory, kSettings, kCapture } kind = kCategory;
    data::Item item;        // kItem：功能项
    std::string catType;    // kCategory："effect"|"script"|"preset"|"all"
};
std::vector<config::SlotConfig> g_slots;   // config.json 固定槽配置（启动加载一次）
std::vector<GestureEntry> g_entries;       // 每次弹出时解析的 6 弧段内容
std::vector<data::Item> g_recent;          // 最近使用（内存，跨显示保留）
bool g_recentLoaded = false;               // 是否已从 recent.json 加载
int g_bindingSlot = -1;                    // >=0：搜索模式选择结果后 Enter 绑定到该槽
bool g_recordingHotkey = false;            // 热键录制中（设置面板触发）：按下新组合即应用
bool g_returnToSettings = false;           // 绑定/录制完成后回设置面板（而非手势环）
int g_settingsSel = 0;                     // 设置面板选中行（0-3 槽 / 4 热键 / 5 松手执行 / 6 松手停留）
int g_setHover = -1;                       // 设置面板 hover 行（鼠标悬停高亮，-1=无）
int g_pressRow = -1;                       // 设置面板按下中的行（点击反馈：压入 + 压暗）
bool g_releaseExecute = true;              // 热键松开执行选中弧段（设置行5可切换；关闭=松手仅关窗）
bool g_releaseStay = false;                // 热键松开停留（设置行6可切换；开启=松手不执行也不关窗）
ULONGLONG g_recordStartMs = 0;             // 热键录制开始墙钟（静默超时改显「可能被占用」提示；仅录制中有意义）

// —— 动画：colorkey 分层窗口无每像素 alpha，用 D2D 缩放/平移 transform 模拟弹入/缩出/滑入 ——
// 时间驱动：WM_TIMER 每 tick 按墙钟时间插值 phase，AE 主线程忙导致 tick 不均匀也不拖慢/跳帧
double g_animPhase = 1.0;                  // 0=入场起点/退场终点 1=动画完成
int g_animDir = 0;                         // +1 入场 / -1 退场 / 0 停
ULONGLONG g_animStartMs = 0;               // 主动画开始墙钟时间（GetTickCount64）
const double kAnimMs = 150.0;              // 入场/退场动画时长（毫秒）
const double kDropMs = 90.0;               // 过滤下拉展开时长（毫秒）
const double kPressMs = 90.0;              // 弧段/中心圆按压缩入动画时长（毫秒）
double g_dropT = 1.0;                      // 过滤下拉动画进度（0→1）
ULONGLONG g_dropStartMs = 0;               // 下拉动画开始墙钟时间
const UINT_PTR kAnimTimer = 2;             // 浮窗动画计时器 id（热键窗用 1）
const UINT_PTR kExecTimer = 3;             // 执行延迟计时器 id（点击动画播放后再执行）
const UINT_PTR kCheckFgTimer = 4;          // 失活后延迟检查前台窗口（点击外部关闭）
const UINT_PTR kBatchTimer = 5;            // 预设批量分块执行计时器 id（块间让 AE 消息泵喘息）
const UINT_PTR kRecordHintTimer = 6;       // 热键录制「静默 1.5s → 可能被占用」提示计时器 id
const ULONGLONG kRecordHintMs = 1500;      // 录制静默多久后改显占用提示
const UINT_PTR kFailTimer = 7;             // 失败提示驻留计时器 id（1..6 已占用）
// 失败提示停留时长：1s——失败信息只需一眼看清，停留越短越不打扰；
// 期间窗口保持可见，到点由 kFailTimer 走既有 window_hide 渐隐退场
const ULONGLONG kFailDwellMs = 1000;
const UINT kBatchTickMs = 30;              // 批量块间隔：够 AE 处理排队消息（绘制/输入）
const int kSyncPresetMax = 20;             // <此层数：一次 applyPreset 同步应用（原生多选语义，
                                           // ffx 只解析一次——与官方"将动画预设应用于"菜单同速；
                                           // 同步完成不弹进度卡片，Ctrl+Z 一次撤回全部）
// 大批量分块：每 tick 隔离选区为一块，一次调用应用于整块。与扩展面板规则一致：
// 20~60 层 10/块，>60 层 20/块（块间"选区切换+往返"来回开销不低，块宜大不宜小）
const int kBatchChunk = 10;
const int kBatchChunkLarge = 20;
const int kBatchLargeFrom = 60;            // >此层数用大块
int presetChunkSize(int total) { return total > kBatchLargeFrom ? kBatchChunkLarge : kBatchChunk; }
// —— 合成预览图子菜单：正上弧段专职入口，弧段选中即弹三瓣（PNG / 剪切板 / JPG）——
const double kCapAnimMs = 160.0;           // 子菜单花瓣弹出动画时长
const double kCapRIn = 135.0, kCapROut = 185.0;   // 花瓣环带半径（主环外径 125 之外，留 10 间隙）
// 每瓣 18° + 两处 2° 间隙 = 58°，三瓣总跨度与截图弧段一致（-119°~-61° 角度对齐）；
// 中心角 -110/-90/-70：PNG（左上）/ 剪切板（正上·最宽瓣，3 字名放得下）/ JPG（右上）
const double kCapPetalSpan = 18.0;
const double kCapPetalMid[3] = { -110.0, -90.0, -70.0 };
// 截图子菜单花瓣标签：PNG/JPG 为格式名不翻，剪切板按当前语言
std::wstring capLabel(int k) {
    if (k == 1) return TrW(S_HOTBOX_WINDOW_CAP_CLIPBOARD);
    return k == 0 ? std::wstring(L"PNG") : std::wstring(L"JPG");
}
bool g_capMenu = false;                    // 子菜单展开中（截图弧段选中驱动，未选中即收起）
int g_capSel = -1;                         // 子菜单花瓣 hover
int g_capPress = -1;                       // 按下中的花瓣（完整点击语义：UP 在同一瓣才执行）
ULONGLONG g_capOpenMs = 0;                 // 展开动画起点墙钟
int g_pendingExec = -1;                    // 待执行弧段（按压动画播完后由 kExecTimer 触发真实执行）
bool g_pendingHideCheck = false;           // WM_ACTIVATE 失活后待前台检查（延迟 50ms 确认）

// 弧段出场序号（顺时针、左侧先出右侧后出）：段4(左) → 段5(左上) → 段0(上) → 段1(右上) → 段2(右下) → 段3(正下·设置)
static const int kSegOut[kSegmentCount] = { 2, 3, 4, 5, 0, 1 };
// 分段延迟占比：最后一段从 55% 处开始，保证每段都有完整弹性动画窗口（非瞬时跳出）
const double kStagger = 0.55;

// 动画曲线：clamp / easeOutBack（末尾弹性 overshoot）/ easeOutCubic（入场，先快后慢）/ easeInCubic（退场，先快后慢）
double clamp01(double x) { return x < 0.0 ? 0.0 : (x > 1.0 ? 1.0 : x); }
double easeOutBack(double x) {
    const double c1 = 1.70158, c3 = c1 + 1.0;
    x = clamp01(x);
    double t = x - 1.0;
    return 1.0 + c3 * t * t * t + c1 * t * t;
}
double easeOutCubic(double x) {
    x = clamp01(x);
    double t = 1.0 - x;
    return 1.0 - t * t * t;
}
double easeInCubic(double x) {
    x = clamp01(x);
    return x * x * x;
}
// 第 outIdx 个出场元素的独立动画时间：延迟 kStagger*outIdx/maxIdx 后开始，phase=1 时恰好完成
double staggerT(double phase, double outIdx, double maxIdx) {
    double d = (maxIdx <= 0.0) ? 0.0 : kStagger * outIdx / maxIdx;
    return clamp01((phase - d) / (1.0 - d));
}

// 动画 tick 间隔：按屏幕刷新率半帧自适应（60Hz→8ms，120Hz→4ms，144Hz→3ms），高刷屏动画不卡
int animTimerMs() {
    DEVMODEW dm = {};
    dm.dmSize = sizeof(dm);
    DWORD freq = 60;
    if (EnumDisplaySettingsW(nullptr, ENUM_CURRENT_SETTINGS, &dm) && dm.dmDisplayFrequency > 30)
        freq = dm.dmDisplayFrequency;
    int ms = 1000 / (int)(freq * 2);
    return ms < 1 ? 1 : ms;
}

// 启动主动画：dir +1 入场（phase 0→1）/ -1 退场（phase 1→0），按墙钟时间推进
void animStart(int dir) {
    g_animDir = dir;
    g_animPhase = (dir > 0) ? 0.0 : 1.0;
    g_animStartMs = GetTickCount64();
    SetTimer(g_hwnd, kAnimTimer, animTimerMs(), nullptr);
}

// 搜索模式布局（窗口 380×440 客户区；搜索栏/列表宽 340，比 440 更紧凑）
const int kBarX = 20, kBarY = 20, kBarW = 340, kBarH = 36;    // 长条搜索栏
const int kFbtnX = 26;                                        // 过滤按钮（栏内最左）
// 过滤按钮宽度与放大镜/输入框列按当前语言标签实测自适应（中文标签下与 62px 布局一致）
int g_fbtnW = 62;
int g_magX = kFbtnX + g_fbtnW + 4;                            // 放大镜图标区（左移 4px，远离输入框）
int g_editX = g_magX + 34;
int g_editW = (kBarX + kBarW - 6) - g_editX;                  // 输入框（右留 6px；左留足空间给放大镜，避免重叠）
const int kListX = 20, kListY = 68, kListW = 340;             // 结果列表区（与搜索栏同宽）
const int kScrollX = kListX + kListW + 2, kScrollW = 8;       // 列表右侧滚动条
const int kFilterDropY = 62, kFilterDropRowH = 28;            // 过滤下拉面板（宽度按标签实测，见 filterDropWidth）

// 设置面板布局（0-3 槽位 / 4 热键 / 5 松手执行 / 6 松手停留；返回走 Esc）；紧凑行高 + 独立窗口高度（小于手势环 440）
// 44(行起点) + kSetRows*32(行) + 底部提示区 + padding
const int kSetRowY0 = 44, kSetRowH = 32;
const int kSetRows = 7;     // 行数唯一来源（绘制/键盘导航/鼠标命中均用它，防逐处字面量漂移）
const int kSetWinH = 308;   // 面板内容至 296（7 行至 268 + 提示区），留 10px 底边

// —— 主题颜色：主题同步（面板写入 theme.json）——
// 面板在启动/设置变更时把扩展主题导出为 <数据目录>\hotbox\theme.json（全部 #RRGGBB 不透明色）。
// 插件读取后按当前扩展主题绘制浮窗；缺失/非法键回退到下方硬编码暗色默认值（对齐扩展默认主题）。
// 注意：hover/选中填充用"强调色 alpha 预混到表面色"的**不透明**值而非半透明色——
// colorkey 抠色窗口（LWA_COLORKEY）+ D2D ALPHA_MODE_IGNORE 下半透明混合结果不确定，
// 半透明填充可能渲染成与弧段本体不一致的暗色/异常，导致"高亮区与弧段漂移"。
struct HotboxTheme {
    D2D1_COLOR_F surface, inputBg, border, centerFill, rowHover,
                 text, muted, edge, borderDim, accentSoft, accent;
    bool fromFile = false;
};
// 默认值 = 原硬编码暗色；theme.json 写明某键时覆盖该键（其余保持默认）
static HotboxTheme g_theme = {
    D2D1::ColorF(0x151B24u),  // surface：表面
    D2D1::ColorF(0x0E1219u),  // inputBg：输入区背景（比表面更暗）
    D2D1::ColorF(0x2A303Au),  // border
    D2D1::ColorF(0x1C2128u),  // centerFill：中心圆（btn-bg，比表面亮一档）
    D2D1::ColorF(0x1C1B19u),  // rowHover：hover（强调色 6% 预混表面）
    D2D1::ColorF(0xE4E8F0u),  // text
    D2D1::ColorF(0x697080u),  // muted
    D2D1::ColorF(0xA7ACB8u),  // edge：调暗的白色描边（介于 muted 和 text 之间）
    D2D1::ColorF(0x3A4048u),  // borderDim：暗灰非选中弧段描边（比 border 稍亮）
    D2D1::ColorF(0x2A2619u),  // accentSoft：选中填充（强调色 12% 预混表面）
    D2D1::ColorF(0xFBBF24u),  // accent：金色强调色（选中/按下边框）
    false
};

// RGB 倍数缩放（用于从表面色派生渐变/阴影；产出不透明色，安全用于 colorkey）
static inline D2D1_COLOR_F scaleColor(const D2D1_COLOR_F& c, float f) {
    return D2D1::ColorF(c.r * f, c.g * f, c.b * f);
}
static inline int hexDigit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}
// 解析 "#RRGGBB" → 不透明色；失败返回 false（调用方保持默认）
static bool parseHexColor(const std::string& s, D2D1_COLOR_F* out) {
    if (s.size() != 7 || s[0] != '#') return false;
    int rgb[3] = { 0, 0, 0 };
    for (int i = 0; i < 3; ++i) {
        int hi = hexDigit(s[1 + i * 2]);
        int lo = hexDigit(s[1 + i * 2 + 1]);
        if (hi < 0 || lo < 0) return false;
        rgb[i] = hi * 16 + lo;
    }
    *out = D2D1::ColorF(rgb[0] / 255.0f, rgb[1] / 255.0f, rgb[2] / 255.0f);
    return true;
}
// 所有颜色通道的稳定整数签名：判断主题是否变化（避免浮点逐字段比较）
static unsigned themeSignature(const HotboxTheme& t) {
    unsigned s = 2166136261u;
    auto add = [&](float c) { s = (s ^ (unsigned)(c * 255.0f)) * 16777619u; };
    add(t.surface.r); add(t.surface.g); add(t.surface.b);
    add(t.inputBg.r); add(t.inputBg.g); add(t.inputBg.b);
    add(t.border.r); add(t.border.g); add(t.border.b);
    add(t.centerFill.r); add(t.centerFill.g); add(t.centerFill.b);
    add(t.rowHover.r); add(t.rowHover.g); add(t.rowHover.b);
    add(t.text.r); add(t.text.g); add(t.text.b);
    add(t.muted.r); add(t.muted.g); add(t.muted.b);
    add(t.edge.r); add(t.edge.g); add(t.edge.b);
    add(t.borderDim.r); add(t.borderDim.g); add(t.borderDim.b);
    add(t.accentSoft.r); add(t.accentSoft.g); add(t.accentSoft.b);
    add(t.accent.r); add(t.accent.g); add(t.accent.b);
    return s;
}
// 重新读取 theme.json 覆盖 g_theme（逐键回退默认）。
// 返回 true 当主题与本插件最近一次不同（调用方据此失效缓存画刷，实现实时变色）；
// 缺失文件/解析失败视为无变化（保持现有主题），也返回 false。
bool loadTheme() {
    unsigned oldSig = themeSignature(g_theme);
    bool wasFromFile = g_theme.fromFile;
    std::string p = hotboxDataPath("theme.json");
    if (!p.empty()) {
        std::string content;
        if (fsReadText(p, &content)) {
            json::Value root;
            if (json::parse(content.c_str(), content.size(), &root)) {
                auto apply = [&](const char* key, D2D1_COLOR_F* dst) {
                    const json::Value& v = root[key];
                    if (v.type == json::Value::kString) parseHexColor(v.str, dst);
                };
                apply("background", &g_theme.surface);
                apply("inputBg",    &g_theme.inputBg);
                apply("border",     &g_theme.border);
                apply("centerFill", &g_theme.centerFill);
                apply("rowHover",   &g_theme.rowHover);
                apply("text",       &g_theme.text);
                apply("muted",      &g_theme.muted);
                apply("edge",       &g_theme.edge);
                apply("borderDim",  &g_theme.borderDim);
                apply("accentSoft", &g_theme.accentSoft);
                apply("accent",     &g_theme.accent);
                g_theme.fromFile = true;
            }
        }
    }
    if (themeSignature(g_theme) != oldSig || wasFromFile != g_theme.fromFile) {
        hotbox_log("theme: reloaded theme.json");
        return true;
    }
    return false;
}

// EDIT 背景画刷（与面板表面色一致，惰性创建）
static HBRUSH s_editBg = nullptr;
static HBRUSH editBgBrush() {
    if (!s_editBg)
        s_editBg = CreateSolidBrush(RGB((int)(g_theme.surface.r * 255.0f),
                                        (int)(g_theme.surface.g * 255.0f),
                                        (int)(g_theme.surface.b * 255.0f)));
    return s_editBg;
}

D2D1_COLOR_F cSurface()     { return g_theme.surface; }
D2D1_COLOR_F cInputBg()     { return g_theme.inputBg; }
D2D1_COLOR_F cBorder()      { return g_theme.border; }
D2D1_COLOR_F cCenterFill()  { return g_theme.centerFill; }
D2D1_COLOR_F cRowHover()    { return g_theme.rowHover; }
D2D1_COLOR_F cText()        { return g_theme.text; }
D2D1_COLOR_F cMuted()       { return g_theme.muted; }
D2D1_COLOR_F cEdge()        { return g_theme.edge; }
D2D1_COLOR_F cBorderDim()   { return g_theme.borderDim; }
D2D1_COLOR_F cAccentSoft()  { return g_theme.accentSoft; }
D2D1_COLOR_F cAccent()      { return g_theme.accent; }

ID2D1Factory* g_factory = nullptr;
// g_rt 已在文件顶部声明（refreshDpiScale 需前置更新其 DPI）
// g_radial 定义在文件后部（radialBrush 惰性创建处）；它是旧 RT 创建的设备依赖
// 资源，resizeBmp 重建 RT 前需释放，故在此前置声明
extern ID2D1RadialGradientBrush* g_radial;
IDWriteFactory* g_dw = nullptr;
IDWriteTextFormat* g_fmt = nullptr;
IDWriteTextFormat* g_fmtLeft = nullptr;    // 列表行/状态行（左对齐，居中行高）
IDWriteTextFormat* g_fmtRight = nullptr;   // 类型小标（右对齐）
IDWriteTextFormat* g_fmtWrap = nullptr;    // 状态行消息气泡（左对齐 + 自动换行，顶部对齐）
IDWriteTextFormat* g_fmtPetal = nullptr;   // 截图花瓣标签（10px 小字号：18° 花瓣截面窄，主体 12.5px 放不下三字名）
IDWriteTextFormat* g_fmtArc[4] = { nullptr, nullptr, nullptr, nullptr };   // 主环弧段标签降字号档位
// 主环弧段标签降字号档位：正常 12.5px（g_fmt）放不下长译名时自 11.5px 起按 1px 步进
// 逐级尝试，下限 9px
const float kArcLabelFontSizes[4] = { 11.5f, 10.5f, 9.5f, 9.0f };

// 重建 WIC 位图 + DIB + WicBitmapRenderTarget（窗口尺寸变化或首次创建时调用）
// ULW 模式下 per-pixel alpha 透明：D2D 渲染到 WIC → CopyFromMemory 到 DIB → UpdateLayeredWindow
static void resizeBmp(int physW, int physH) {
    if (physW < 1) physW = 1;
    if (physH < 1) physH = 1;
    // 尺寸未变则跳过重建
    if (g_wicBitmap && g_dib && g_bmpW == physW && g_bmpH == physH) return;
    g_bmpW = physW; g_bmpH = physH;

    // 释放旧资源
    if (g_rt) { g_rt->Release(); g_rt = nullptr; }
    // g_radial 是旧 RT 创建的设备依赖资源，RT 重建后不可复用；置空后
    // radialBrush() 下次绘制时会在新 RT 上惰性重建
    if (g_radial) { g_radial->Release(); g_radial = nullptr; }
    if (g_d2dBmp) { g_d2dBmp->Release(); g_d2dBmp = nullptr; }
    if (g_wicBitmap) { g_wicBitmap->Release(); g_wicBitmap = nullptr; }
    if (g_dib) { DeleteObject(g_dib); g_dib = nullptr; g_dibBits = nullptr; }

    // 创建 WIC 位图（32bpp PBGRA，预乘 alpha）
    // 失败时清掉半初始化状态安全返回：g_rt 保持空 → paint() 判空跳过渲染，窗口不崩溃
    //（AEGP 进程内运行，空指针解引用会崩掉 AE 主进程 0xC0000005）
    HRESULT hrBmp = g_wicFactory->CreateBitmap(physW, physH, GUID_WICPixelFormat32bppPBGRA,
                                               WICBitmapCacheOnDemand, &g_wicBitmap);
    if (FAILED(hrBmp) || !g_wicBitmap) {
        hotbox_log("window: CreateBitmap failed");
        g_wicBitmap = nullptr;
        g_bmpW = 0; g_bmpH = 0;
        return;
    }

    // 创建 WicBitmapRenderTarget（PREMULTIPLIED alpha 模式，启用真正的 per-pixel alpha）
    float rtDpi = g_dpiScale * 96.0f;
    D2D1_RENDER_TARGET_PROPERTIES props = D2D1::RenderTargetProperties(
        D2D1_RENDER_TARGET_TYPE_DEFAULT,
        D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED),
        rtDpi, rtDpi);
    HRESULT hrRt = g_factory->CreateWicBitmapRenderTarget(g_wicBitmap, &props, &g_rt);
    if (FAILED(hrRt) || !g_rt) {
        hotbox_log("window: CreateWicBitmapRenderTarget failed");
        if (g_wicBitmap) { g_wicBitmap->Release(); g_wicBitmap = nullptr; }
        g_bmpW = 0; g_bmpH = 0;
        return;
    }
    g_rt->SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);

    // 创建 DIB（32bit ARGB，用于 UpdateLayeredWindow 提交）
    BITMAPINFO bi = {};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = physW;
    bi.bmiHeader.biHeight = -physH;   // 负高度 = top-down（与 D2D 一致）
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    g_dib = CreateDIBSection(g_memDC, &bi, DIB_RGB_COLORS, &g_dibBits, nullptr, 0);
}

// 用 Tr 模板 + snprintf 组装 UTF-8 文本：格式串来自生成表（占位符序列与 zh 源文一致），
// 先按实际长度分配再格式化，不截断多字节文本。
template <typename... Args>
std::string trFormat(StrId id, Args... args) {
    const char* fmt = Tr(id);
    const int len = snprintf(nullptr, 0, fmt, args...);
    if (len <= 0) return std::string(fmt);
    std::string out(static_cast<size_t>(len), static_cast<char>(0));
    snprintf(&out[0], out.size() + 1, fmt, args...);
    return out;
}

// leading 对齐格式下的自然文本宽度（不含行尾空白）：按译文实测列宽用。
float measureTextW(const std::wstring& text, IDWriteTextFormat* fmt, float maxW) {
    if (!g_dw || !fmt || text.empty()) return 0.0f;
    IDWriteTextLayout* layout = nullptr;
    if (FAILED(g_dw->CreateTextLayout(text.c_str(), (UINT32)text.size(), fmt, maxW, 100.0f,
                                      &layout)) || !layout)
        return 0.0f;
    DWRITE_TEXT_METRICS metrics = {};
    float width = 0.0f;
    if (SUCCEEDED(layout->GetMetrics(&metrics))) width = metrics.widthIncludingTrailingWhitespace;
    layout->Release();
    return width;
}

// 过滤按钮与放大镜/输入框列：按钮宽度取四个「▾+类型名」标签实测最大宽 + 16px 内边距，
// 下限 62（中文标签口径不变）、上限 132（保底输入区宽度）；输入框列随按钮右移。
void layoutSearchBar() {
    static const StrId kFilterIds[4] = { S_HOTBOX_WINDOW_TYPE_ALL, S_HOTBOX_WINDOW_TYPE_EFFECT,
                                         S_HOTBOX_WINDOW_TYPE_SCRIPT, S_HOTBOX_WINDOW_TYPE_PRESET };
    float maxW = 0.0f;
    for (StrId id : kFilterIds) {
        const float w = measureTextW(std::wstring(L"▾") + TrW(id), g_fmtLeft, 400.0f);
        if (w > maxW) maxW = w;
    }
    int w = (int)(maxW + 16.5f);
    if (w < 62) w = 62;
    if (w > 132) w = 132;
    g_fbtnW = w;
    g_magX = kFbtnX + g_fbtnW + 4;
    g_editX = g_magX + 34;
    g_editW = (kBarX + kBarW - 6) - g_editX;
}

// 结果行类型小标列宽：取当前语言三种类型标签实测最大宽 + 10px 内边距，下限 70
//（中文两字标签的既有列宽）；小标用 11px 格式，这里按 12.5px 的 g_fmtLeft 量得偏大，
// 列宽只会更宽，不会裁字。
float typeColumnWidth() {
    static float s_width = 0.0f;
    if (s_width > 0.0f) return s_width;
    static const StrId kTypeIds[3] = { S_HOTBOX_WINDOW_TYPE_EFFECT, S_HOTBOX_WINDOW_TYPE_SCRIPT,
                                       S_HOTBOX_WINDOW_TYPE_PRESET };
    float maxW = 0.0f;
    for (StrId id : kTypeIds) {
        const float w = measureTextW(TrW(id), g_fmtLeft, 400.0f);
        if (w > maxW) maxW = w;
    }
    s_width = maxW + 10.0f;
    if (s_width < 70.0f) s_width = 70.0f;
    return s_width;
}

// 过滤下拉面板宽度：取四个类型标签实测最大宽 + 16px 内边距，下限 96（中文标签口径不变）。
int filterDropWidth() {
    static int s_width = 0;
    if (s_width > 0) return s_width;
    static const StrId kDropIds[4] = { S_HOTBOX_WINDOW_TYPE_ALL, S_HOTBOX_WINDOW_TYPE_EFFECT,
                                       S_HOTBOX_WINDOW_TYPE_SCRIPT, S_HOTBOX_WINDOW_TYPE_PRESET };
    float maxW = 0.0f;
    for (StrId id : kDropIds) {
        const float w = measureTextW(TrW(id), g_fmtLeft, 400.0f);
        if (w > maxW) maxW = w;
    }
    s_width = (int)(maxW + 16.5f);
    if (s_width < 96) s_width = 96;
    return s_width;
}

// 返回 false：D2D/DWrite/WIC 任一初始化失败。相关全局保持/复位为空，调用方判空降级
//（paint 的 if (!g_rt) return / ULW 的 if (g_dib...)）；失败时置空 g_factory，下次调用整体重试
bool ensureD2D(HWND hwnd) {
    if (g_factory) return true;
    HRESULT hr = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, &g_factory);
    if (FAILED(hr) || !g_factory) {
        hotbox_log("window: D2D1CreateFactory failed");
        g_factory = nullptr;
        return false;
    }
    hr = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                             reinterpret_cast<IUnknown**>(&g_dw));
    if (FAILED(hr) || !g_dw) {
        hotbox_log("window: DWriteCreateFactory failed");
        g_factory->Release(); g_factory = nullptr;
        return false;
    }
    // 界面字体族与文本 locale 跟随当前语言（zh-CN = 微软雅黑/zh-CN）；主体 12.5px
    const wchar_t* uiFont = i18n::uiFontFamilyD2D();
    const std::wstring uiLocale = i18n::widen(i18n::localeTag());
    // CreateTextFormat 失败（极端内存耗尽）时句柄为空，对空句柄调 Set* 是
    // 空指针解引用（崩掉 AE 主进程）——先判空再配置，末尾统一校验失败走整体回收
    g_dw->CreateTextFormat(uiFont, nullptr, DWRITE_FONT_WEIGHT_NORMAL,
                           DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
                           12.5f, uiLocale.c_str(), &g_fmt);
    if (g_fmt) {
        g_fmt->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
        g_fmt->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
    }
    // 列表行/状态行：左对齐；类型小标：右对齐
    g_dw->CreateTextFormat(uiFont, nullptr, DWRITE_FONT_WEIGHT_NORMAL,
                           DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
                           12.5f, uiLocale.c_str(), &g_fmtLeft);
    if (g_fmtLeft) {
        g_fmtLeft->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_LEADING);
        g_fmtLeft->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
        g_fmtLeft->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);   // 输入框单行不换行（防空格处断行被裁剪）
    }
    g_dw->CreateTextFormat(uiFont, nullptr, DWRITE_FONT_WEIGHT_NORMAL,
                           DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
                           11.0f, uiLocale.c_str(), &g_fmtRight);
    if (g_fmtRight) {
        g_fmtRight->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_TRAILING);
        g_fmtRight->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
    }
    // 状态行消息气泡：左对齐 + 顶部对齐 + 自动换行（多行完整展示长报错）
    g_dw->CreateTextFormat(uiFont, nullptr, DWRITE_FONT_WEIGHT_NORMAL,
                           DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
                           12.5f, uiLocale.c_str(), &g_fmtWrap);
    if (g_fmtWrap) {
        g_fmtWrap->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_LEADING);
        g_fmtWrap->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
        g_fmtWrap->SetWordWrapping(DWRITE_WORD_WRAPPING_WRAP);
    }
    // 截图花瓣标签：10px 小字号（同 g_fmt 居中对齐）
    g_dw->CreateTextFormat(uiFont, nullptr, DWRITE_FONT_WEIGHT_NORMAL,
                           DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
                           10.0f, uiLocale.c_str(), &g_fmtPetal);
    if (g_fmtPetal) {
        g_fmtPetal->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
        g_fmtPetal->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
    }
    // 主环弧段标签：长译名优先逐级降字号（11.5 → 10.5 → 9.5 → 9px）放下，仍放不下才由
    // fitLabel 加省略号；中文标签在 12.5px 即放得下，字号不变。
    for (int k = 0; k < 4; ++k) {
        g_dw->CreateTextFormat(uiFont, nullptr, DWRITE_FONT_WEIGHT_NORMAL,
                               DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
                               kArcLabelFontSizes[k], uiLocale.c_str(), &g_fmtArc[k]);
        if (g_fmtArc[k]) {
            g_fmtArc[k]->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
            g_fmtArc[k]->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
        }
    }
    // 任一文本格式创建失败 → 释放半初始化资源并整体置空返回 false（空格式参与
    // 后续 DrawText 同样是空指针解引用）；g_factory 置空使下次 ensureD2D 整体重试，
    // 清理模式对齐下方 WIC 工厂失败路径
    if (!g_fmt || !g_fmtLeft || !g_fmtRight || !g_fmtWrap || !g_fmtPetal || !g_fmtArc[0] ||
        !g_fmtArc[1] || !g_fmtArc[2] || !g_fmtArc[3]) {
        hotbox_log("window: CreateTextFormat failed");
        if (g_fmt) { g_fmt->Release(); g_fmt = nullptr; }
        if (g_fmtLeft) { g_fmtLeft->Release(); g_fmtLeft = nullptr; }
        if (g_fmtRight) { g_fmtRight->Release(); g_fmtRight = nullptr; }
        if (g_fmtWrap) { g_fmtWrap->Release(); g_fmtWrap = nullptr; }
        if (g_fmtPetal) { g_fmtPetal->Release(); g_fmtPetal = nullptr; }
        for (IDWriteTextFormat*& arcFmt : g_fmtArc) {
            if (arcFmt) { arcFmt->Release(); arcFmt = nullptr; }
        }
        g_dw->Release(); g_dw = nullptr;
        g_factory->Release(); g_factory = nullptr;
        return false;
    }
    // 列宽按当前语言标签实测：中文标签下过滤按钮/下拉面板/类型小标保持既有口径
    layoutSearchBar();

    // WIC factory + 兼容 DC（UpdateLayeredWindow 需要 HDC 指定位图）
    // SUCCEEDED 覆盖 S_OK/S_FALSE（S_FALSE=本线程已初始化，同样需要配对归还）
    if (SUCCEEDED(CoInitialize(nullptr))) s_comInitCount++;
    hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                          IID_PPV_ARGS(&g_wicFactory));
    if (FAILED(hr) || !g_wicFactory) {
        hotbox_log("window: CoCreateInstance(WICImagingFactory) failed");
        // 释放半初始化资源并整体置空（g_factory 为空使下次调用从头重试）
        if (g_fmt) { g_fmt->Release(); g_fmt = nullptr; }
        if (g_fmtLeft) { g_fmtLeft->Release(); g_fmtLeft = nullptr; }
        if (g_fmtRight) { g_fmtRight->Release(); g_fmtRight = nullptr; }
        if (g_fmtWrap) { g_fmtWrap->Release(); g_fmtWrap = nullptr; }
        if (g_fmtPetal) { g_fmtPetal->Release(); g_fmtPetal = nullptr; }
        for (IDWriteTextFormat*& arcFmt : g_fmtArc) {
            if (arcFmt) { arcFmt->Release(); arcFmt = nullptr; }
        }
        g_dw->Release(); g_dw = nullptr;
        g_factory->Release(); g_factory = nullptr;
        return false;
    }
    HDC screenDC = GetDC(nullptr);
    g_memDC = CreateCompatibleDC(screenDC);
    ReleaseDC(nullptr, screenDC);

    RECT rc;
    GetClientRect(hwnd, &rc);
    resizeBmp(rc.right - rc.left, rc.bottom - rc.top);
    return true;
}

// UTF-8 → UTF-16（DirectWrite 文本 / SetWindowTextW 需要）
std::wstring utf8ToWide(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w;
    w.resize(n);
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}

// UTF-16 → UTF-8（EDIT 输入 → g_query）
std::string wideToUtf8(const wchar_t* s) {
    int n = WideCharToMultiByte(CP_UTF8, 0, s, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return "";   // 空串（-1 含结尾 NUL）
    std::string out;
    out.resize(n - 1);
    WideCharToMultiByte(CP_UTF8, 0, s, -1, &out[0], n, nullptr, nullptr);
    return out;
}

// 列表行图标字符（按类型）
const wchar_t* iconFor(const std::string& type) {
    if (type == "script") return L"◇";
    if (type == "preset") return L"○";
    return L"◈";
}

// 结果列表可视窗口顶部（滚轮独立滚动维护；进入/重查时归零）
int scrollTop() {
    return g_scrollTop;
}

// 拖拽设置的窗口行数上限（滚动窗口）；实际绘制行数随结果数量收缩
int listRows()    { return g_listRows; }
// 实际显示行数：无结果显示 0（不画列表区）；否则 min(窗口上限, 结果数)。
// 不按「查询是否为空」判定——空查询会列出最近使用（rerunQuery），仍要画列表
int displayRows() {
    int n = (int)g_results.size();
    return (n < 1) ? 0 : (n < listRows() ? n : listRows());
}
// 状态行 Y 位置：无结果时不预留结果行（面板保持最小高度，仅搜索栏 + 状态行），
// 有结果时按实际显示行数排布；空↔有结果的切换由高度动画（150ms easeOutCubic）平滑过渡
int statusYStable() {
    int rows = g_results.empty() ? 0 : displayRows();
    return kListY + rows * kRowH + 6;
}
int listBottomY() { return kListY + displayRows() * kRowH; }
int statusY()     { return statusYStable(); }   // 用稳定位置，避免无结果→有结果切换时 statusY 突变闪烁
// 拖拽分隔条：面板底部（状态行下方 20px 处）横条，仅搜索中有列表时有效
int resizeBarY()  { return statusY() + 20; }

// 拖拽分隔条区域：面板底部 4px 横条（resize 手柄；空查询的最近使用列表同样可拖）
bool inResizeBar(int x, int y) {
    return !g_results.empty() &&
           x >= kListX && x <= kListX + kListW &&
           y >= resizeBarY() && y <= resizeBarY() + 4;
}

// 捕获/释放鼠标（手势模式方向跟踪：鼠标出 UI 范围仍按方向选段；
// 进入搜索/设置、隐藏时必须释放，避免锁死 AE 鼠标输入）
void captureMouse() { if (!g_captured) { SetCapture(g_hwnd); g_captured = true; } }
void releaseMouse() { if (g_captured) { g_captured = false; ReleaseCapture(); } }

// 把 EDIT 移出可视区并隐藏：非搜索模式下杜绝原生子窗口残留（colorkey 合成下
// 隐藏不彻底会在手势环两侧露出输入框的竖线/矩形）
void hideEdit() {
    if (!g_edit) return;
    MoveWindow(g_edit, -200, -200, phys(140), phys(24), TRUE);
    ShowWindow(g_edit, SW_HIDE);
}

// 可视窗口上限（行索引）；无溢出返回 -1 表示不用滚
int scrollLimit() {
    int n = (int)g_results.size();
    return (n > listRows()) ? n - listRows() : -1;
}

// 滚动窗口 clamp 到合法范围
void clampScroll() {
    int lim = scrollLimit();
    if (lim < 0) g_scrollTop = 0;
    else {
        if (g_scrollTop < 0) g_scrollTop = 0;
        if (g_scrollTop > lim) g_scrollTop = lim;
    }
}

// 选中行变化后保持其可见（最小滚动）：越上边缘 → 窗口上移；越下边缘 → 窗口下移
void ensureSelVisible() {
    clampScroll();
    if (g_resultSel < g_scrollTop) g_scrollTop = g_resultSel;
    else if (g_resultSel > g_scrollTop + listRows() - 1)
        g_scrollTop = g_resultSel - listRows() + 1;
    clampScroll();
}

// 滚动条命中判断（列表实际显示高度）
bool inScrollBar(int x, int y) {
    return x >= kScrollX && x <= kScrollX + kScrollW &&
           y >= kListY && y <= kListY + displayRows() * kRowH;
}

// 滚动条点击/拖动：由 y 坐标按比例定位选中行（可视窗口跟随选中，保证其可见）
void scrollBarToSel(int y) {
    int total = (int)g_results.size();
    if (total <= listRows()) return;
    float ratio = (float)(y - kListY) / (listRows() * kRowH);
    if (ratio < 0.0f) ratio = 0.0f;
    if (ratio > 1.0f) ratio = 1.0f;
    g_resultSel = (int)(ratio * (total - 1));
    ensureSelVisible();
    InvalidateRect(g_hwnd, nullptr, FALSE);
}

// 热键录制：组合键的功能键统一在此处理（Ctrl 组合发 WM_KEYDOWN、Alt 组合发 WM_SYSKEYDOWN，
// 两处共用；不处理 Alt 的话按 Alt+Q 时 Q 不会到达 WM_KEYDOWN，录制会"没反应"）。
// Esc 取消；修饰键自身忽略；无修饰键提示；成功 → 重注册 + 按实际生效组合写 config.json
static void recordHotkeyKey(HWND hwnd, int vk, LPARAM lp) {
    if (vk == VK_ESCAPE) {
        g_recordingHotkey = false;
        hotkey_resumeForRecording();   // 录制开始时已注销，取消须还原原组合
        g_msg = Tr(S_HOTBOX_WINDOW_HOTKEY_RECORD_CANCELED);
        InvalidateRect(hwnd, nullptr, FALSE);
        return;
    }
    if (vk == VK_CONTROL || vk == VK_MENU || vk == VK_SHIFT)
        return;   // 修饰键自身：等用户继续按真正的功能键
    // IME 键码还原——中文输入法激活时，组合键的主键到达时 VK 已被 IME 替换为
    // VK_PROCESSKEY(0xE5，CEP 侧即 keyCode 229)，直接录制会登记出永远无法触发的
    // "Ctrl+229"（实测日志 hotkey: reloaded Ctrl+229）。与面板侧 e.code 修复同源：
    // 用 lParam 扫描码（IME 不改写）经 MapVirtualKey 还原物理键 VK
    if (vk == VK_PROCESSKEY && lp) {
        UINT scan = (UINT)((lp >> 16) & 0xFF);
        UINT real = MapVirtualKeyW(scan, MAPVK_VSC_TO_VK);
        if (real) vk = (int)real;
    }
    int mods = 0;
    if (GetKeyState(VK_CONTROL) & 0x8000) mods |= 2;
    if (GetKeyState(VK_MENU) & 0x8000) mods |= 1;
    if (GetKeyState(VK_SHIFT) & 0x8000) mods |= 4;
    if (mods == 0) {
        g_msg = Tr(S_HOTBOX_WINDOW_HOTKEY_NEED_MODIFIER);
        InvalidateRect(hwnd, nullptr, FALSE);
        return;
    }
    // 先重注册拿实际生效组合（冲突会回退默认/还原原组合），再写 config.json，
    // 避免直接写请求组合导致文件与运行态不一致
    std::string p = hotboxDataPath("config.json");
    std::string cur;
    // 读失败/半截 JSON 拒绝整包重建——fsReadText 返回值不可忽略，cur 为空串时
    // setHotkey("") 折叠为空 Config，整包写回清空既有 slots 绑定。拒绝时不写盘、
    // 还原原组合（录制开始时已暂停注册），运行态与磁盘保持一致；
    // 文件不存在（首次使用）不在此列。
    if (!readConfigSafe(p, &cur)) {
        g_recordingHotkey = false;
        hotkey_resumeForRecording();   // 暂停未走到重注册出口，须还原原组合
        g_msg = Tr(S_HOTBOX_WINDOW_HOTKEY_READ_FAILED);
        InvalidateRect(hwnd, nullptr, FALSE);
        return;
    }
    int effMods = mods, effVk = vk;
    HotkeyReload rr = hotkey_reload(mods, vk, &effMods, &effVk);
    g_recordingHotkey = false;
    if (rr == HOTKEY_RELOAD_KEPT) {
        // 新组合与默认 Alt+Q 均被占用：已还原原热键，config.json 保持不动
        g_msg = Tr(S_HOTBOX_WINDOW_HOTKEY_CONFLICT_KEPT);
    } else {
        bool saved = !p.empty() && fsWriteText(p, configTextForWrite(config::setHotkey(cur, effMods, effVk)));
        if (!saved)
            g_msg = Tr(S_HOTBOX_WINDOW_HOTKEY_SAVE_FAILED);
        else
            g_msg = Tr(rr == HOTKEY_RELOAD_OK ? S_HOTBOX_WINDOW_HOTKEY_UPDATED
                                              : S_HOTBOX_WINDOW_HOTKEY_CONFLICT_DEFAULT);
    }
    InvalidateRect(hwnd, nullptr, FALSE);
}

// 过滤按钮文字（▾ 与文字无空格，紧凑显示；绘制时左对齐 + 左 padding 整体偏左）
std::string filterLabel() {
    if (g_filterType == "effect") return std::string("▾") + Tr(S_HOTBOX_WINDOW_TYPE_EFFECT);
    if (g_filterType == "script") return std::string("▾") + Tr(S_HOTBOX_WINDOW_TYPE_SCRIPT);
    if (g_filterType == "preset") return std::string("▾") + Tr(S_HOTBOX_WINDOW_TYPE_PRESET);
    return std::string("▾") + Tr(S_HOTBOX_WINDOW_TYPE_ALL);
}

// 带圆角的环形扇区路径（四角各内切一段圆角圆弧）：
// 外弧主体保留，两端经圆角过渡到侧边，侧边再经圆角过渡到内弧——端角圆润。
// 极窄段（内/外圆角相撞）退化为直角扇形。
// 起几何参数化（addSegmentGeo）：主环弧段与子菜单花瓣（不同环带半径）共用构造；
// addSegment 保持原签名（主环默认几何）
void addSegmentGeo(ID2D1GeometrySink* sink, double a1, double a2,
                   double cx, double cy, double rIn, double rOut, double cr) {
    double dOut = cr / rOut * 180.0 / hotbox::kPi;   // 外弧圆角对应角度增量（度）
    double dIn  = cr / rIn  * 180.0 / hotbox::kPi;   // 内弧圆角对应角度增量（度）
    if (a2 - a1 < 2.0 * dOut + 2.0 * dIn + 1.0) {
        // 退化：直角扇形
        double x1, y1, x2, y2, x3, y3, x4, y4;
        hotbox::polarToXY(cx, cy, rIn, a1, &x1, &y1);
        hotbox::polarToXY(cx, cy, rOut, a1, &x2, &y2);
        hotbox::polarToXY(cx, cy, rOut, a2, &x3, &y3);
        hotbox::polarToXY(cx, cy, rIn, a2, &x4, &y4);
        sink->BeginFigure(D2D1::Point2F((FLOAT)x2, (FLOAT)y2), D2D1_FIGURE_BEGIN_FILLED);
        sink->AddArc(D2D1::ArcSegment(D2D1::Point2F((FLOAT)x3, (FLOAT)y3),
                                      D2D1::SizeF((FLOAT)rOut, (FLOAT)rOut), 0.0f,
                                      D2D1_SWEEP_DIRECTION_CLOCKWISE, D2D1_ARC_SIZE_SMALL));
        sink->AddLine(D2D1::Point2F((FLOAT)x4, (FLOAT)y4));
        sink->AddArc(D2D1::ArcSegment(D2D1::Point2F((FLOAT)x1, (FLOAT)y1),
                                      D2D1::SizeF((FLOAT)rIn, (FLOAT)rIn), 0.0f,
                                      D2D1_SWEEP_DIRECTION_COUNTER_CLOCKWISE, D2D1_ARC_SIZE_SMALL));
        sink->EndFigure(D2D1_FIGURE_END_CLOSED);
        return;
    }
    // 外弧两端圆角切点（在外弧上）；侧边切点（外圆角：半径 rOut-cr；内圆角：半径 rIn+cr）
    double to1x, to1y, to2x, to2y, so2x, so2y, si2x, si2y;
    double tin2x, tin2y, tin1x, tin1y, si1x, si1y, so1x, so1y;
    hotbox::polarToXY(cx, cy, rOut, a1 + dOut, &to1x, &to1y);
    hotbox::polarToXY(cx, cy, rOut, a2 - dOut, &to2x, &to2y);
    hotbox::polarToXY(cx, cy, rOut - cr, a2, &so2x, &so2y);
    hotbox::polarToXY(cx, cy, rIn + cr, a2, &si2x, &si2y);
    hotbox::polarToXY(cx, cy, rIn, a2 - dIn, &tin2x, &tin2y);
    hotbox::polarToXY(cx, cy, rIn, a1 + dIn, &tin1x, &tin1y);
    hotbox::polarToXY(cx, cy, rIn + cr, a1, &si1x, &si1y);
    hotbox::polarToXY(cx, cy, rOut - cr, a1, &so1x, &so1y);
    const D2D1_SIZE_F rOutS = D2D1::SizeF((FLOAT)rOut, (FLOAT)rOut);
    const D2D1_SIZE_F rInS  = D2D1::SizeF((FLOAT)rIn, (FLOAT)rIn);
    const D2D1_SIZE_F rCr  = D2D1::SizeF((FLOAT)cr, (FLOAT)cr);
    sink->BeginFigure(D2D1::Point2F((FLOAT)to1x, (FLOAT)to1y), D2D1_FIGURE_BEGIN_FILLED);
    // 外弧 → 外圆角2 → 侧边2 → 内圆角2 → 内弧 → 内圆角1 → 侧边1 → 外圆角1 → 闭合
    sink->AddArc(D2D1::ArcSegment(D2D1::Point2F((FLOAT)to2x, (FLOAT)to2y), rOutS, 0.0f,
                                  D2D1_SWEEP_DIRECTION_CLOCKWISE, D2D1_ARC_SIZE_SMALL));
    sink->AddArc(D2D1::ArcSegment(D2D1::Point2F((FLOAT)so2x, (FLOAT)so2y), rCr, 0.0f,
                                  D2D1_SWEEP_DIRECTION_CLOCKWISE, D2D1_ARC_SIZE_SMALL));
    sink->AddLine(D2D1::Point2F((FLOAT)si2x, (FLOAT)si2y));
    sink->AddArc(D2D1::ArcSegment(D2D1::Point2F((FLOAT)tin2x, (FLOAT)tin2y), rCr, 0.0f,
                                  D2D1_SWEEP_DIRECTION_CLOCKWISE, D2D1_ARC_SIZE_SMALL));
    sink->AddArc(D2D1::ArcSegment(D2D1::Point2F((FLOAT)tin1x, (FLOAT)tin1y), rInS, 0.0f,
                                  D2D1_SWEEP_DIRECTION_COUNTER_CLOCKWISE, D2D1_ARC_SIZE_SMALL));
    sink->AddArc(D2D1::ArcSegment(D2D1::Point2F((FLOAT)si1x, (FLOAT)si1y), rCr, 0.0f,
                                  D2D1_SWEEP_DIRECTION_CLOCKWISE, D2D1_ARC_SIZE_SMALL));
    sink->AddLine(D2D1::Point2F((FLOAT)so1x, (FLOAT)so1y));
    sink->AddArc(D2D1::ArcSegment(D2D1::Point2F((FLOAT)to1x, (FLOAT)to1y), rCr, 0.0f,
                                  D2D1_SWEEP_DIRECTION_CLOCKWISE, D2D1_ARC_SIZE_SMALL));
    sink->EndFigure(D2D1_FIGURE_END_CLOSED);
}

void addSegment(ID2D1GeometrySink* sink, double a1, double a2) {
    addSegmentGeo(sink, a1, a2, kCx, kCy, kRIn, kROut, kCornerR);
}

// 内阴影画刷（惰性创建，window_destroy 释放）：径向渐变，环心暗 → 外缘表面色。
// 弧段按同一坐标渐变填充，内缘柔和凹陷、外缘过渡到表面色——替代"暗色描边线"式
// 内阴影（那会在透明背景上显出弧状黑线）
ID2D1RadialGradientBrush* g_radial = nullptr;
ID2D1RadialGradientBrush* radialBrush() {
    if (g_radial) return g_radial;
    ID2D1GradientStopCollection* stops = nullptr;
    D2D1_COLOR_F surf = g_theme.surface;
    D2D1_GRADIENT_STOP gs[4] = {
        { 0.00f, scaleColor(surf, 0.58f) },   // 环心附近最暗（被中心圆覆盖）
        { 0.55f, scaleColor(surf, 0.85f) },   // 弧段内缘：暗
        { 0.80f, surf },                      // 中段：表面色
        { 1.00f, surf },                      // 外缘：表面色（抗锯齿混合不触 key）
    };
    g_rt->CreateGradientStopCollection(gs, 4, &stops);
    // 渐变 stop 集合创建失败（极端内存耗尽）直接返回空——继续创建径向画刷
    // 会把 nullptr 传给 CreateRadialGradientBrush，下方 Release(nullptr) 同样是崩点；
    // 调用方判空跳过该填充
    if (!stops) return nullptr;
    g_rt->CreateRadialGradientBrush(
        D2D1::RadialGradientBrushProperties(
            D2D1::Point2F((FLOAT)kCx, (FLOAT)kCy), D2D1::Point2F(0, 0),
            (FLOAT)kROut, (FLOAT)kROut),
        stops, &g_radial);
    stops->Release();
    return g_radial;   // 创建失败时为 nullptr（调用方判空降级）
}

// 搜索模式绘制：整体面板外框 + 长条搜索栏（加粗外框 + 输入区独立边框）+ 卡片式结果列表 + 状态行 + 过滤下拉
// （替代手势弧段；整体面板框 + 卡片条目对齐 FXConsole 风格，搜索栏与列表同框）
// 整窗入场/退场动画（小缩放 + 透明度）由 paint() 的 fadeLayer/baseTx 统一处理，
// 此处所有元素直接全量绘制，不再叠加行级/裁剪动画（简化，避免动画叠加 bug）。
void paintSearch(const D2D1::Matrix3x2F& baseTx, ID2D1SolidColorBrush* brBorder,
                 ID2D1SolidColorBrush* brFill,
                 ID2D1SolidColorBrush* brFillSel, ID2D1SolidColorBrush* brText,
                 ID2D1SolidColorBrush* brMuted, ID2D1SolidColorBrush* brRowHover,
                 ID2D1SolidColorBrush* brAccent, ID2D1SolidColorBrush* brEdge) {
    // ⑩ 面板外框填充（最底层背景）：搜索栏 + 结果列表 + 状态行 框在同一面板内。
    // 先填充面板，后续的搜索栏/输入区/列表等元素依次绘制在其上，不被覆盖
    g_rt->FillRoundedRectangle(
        D2D1::RoundedRect(D2D1::RectF(9.0f, 9.0f, (FLOAT)(kBarX + kBarW + 11),
                                      (FLOAT)(statusY() + 29)),
                          12.0f, 12.0f),
        brFill);

    // ① 长条搜索栏：填充 + 暗灰描边（比外层面板的白色描边弱，层次区分）
    D2D1_ROUNDED_RECT rcBar = D2D1::RoundedRect(
        D2D1::RectF((FLOAT)kBarX, (FLOAT)kBarY,
                    (FLOAT)(kBarX + kBarW), (FLOAT)(kBarY + kBarH)), 10.0f, 10.0f);
    g_rt->FillRoundedRectangle(rcBar, brFill);
    g_rt->DrawRoundedRectangle(rcBar, brBorder, 1.0f);

    // 输入区独立背景 + 暗灰描边（EDIT 覆盖区域）：背景比搜索栏表面更暗（凹陷感）
    D2D1_ROUNDED_RECT rcInput = D2D1::RoundedRect(
        D2D1::RectF((FLOAT)(g_editX - 8), (FLOAT)(kBarY + 4),
                    (FLOAT)(kBarX + kBarW - 4), (FLOAT)(kBarY + kBarH - 4)), 7.0f, 7.0f);
    ID2D1SolidColorBrush* brInputBg = nullptr;
    ID2D1SolidColorBrush* brInputEdge = nullptr;
    g_rt->CreateSolidColorBrush(cInputBg(), &brInputBg);
    g_rt->CreateSolidColorBrush(cBorderDim(), &brInputEdge);
    // 输入区画刷创建失败（极端内存耗尽）跳过该效果——空画刷参与 Fill/Draw
    // 与 Release(nullptr) 均为空指针解引用，会崩掉 AE 主进程
    if (brInputBg) {
        g_rt->FillRoundedRectangle(rcInput, brInputBg);
        brInputBg->Release();
    }
    if (brInputEdge) {
        g_rt->DrawRoundedRectangle(rcInput, brInputEdge, 1.0f);
        brInputEdge->Release();
    }

    // ⑩ 面板外框描边（在填充与内部元素之后，勾勒面板边界）
    D2D1_ROUNDED_RECT rcPanel = D2D1::RoundedRect(
        D2D1::RectF(10.0f, 10.0f, (FLOAT)(kBarX + kBarW + 10), (FLOAT)(statusY() + 28)),
        12.0f, 12.0f);
    g_rt->DrawRoundedRectangle(rcPanel, brEdge, 1.5f);

    // ② 过滤按钮（栏内最左）：hover / 下拉展开时高亮
    bool fbtnActive = g_filterMenuOpen || g_filterBtnHover;
    D2D1_ROUNDED_RECT rcFbtn = D2D1::RoundedRect(
        D2D1::RectF((FLOAT)kFbtnX, (FLOAT)(kBarY + 5),
                    (FLOAT)(kFbtnX + g_fbtnW), (FLOAT)(kBarY + kBarH - 5)), 7.0f, 7.0f);
    g_rt->FillRoundedRectangle(rcFbtn, fbtnActive ? brFillSel : brBorder);
    if (fbtnActive) g_rt->DrawRoundedRectangle(rcFbtn, brAccent, 1.0f);   // 金色描边（对齐面板 active）
    std::wstring fbtn = utf8ToWide(filterLabel());
    // 左对齐 + 左 padding 8px：整体偏左，避免居中导致"▾全部"挤在按钮右侧
    D2D1_RECT_F rcFbtnText = D2D1::RectF((FLOAT)(kFbtnX + 8), (FLOAT)(kBarY + 5),
                                         (FLOAT)(kFbtnX + g_fbtnW), (FLOAT)(kBarY + kBarH - 5));
    g_rt->DrawText(fbtn.c_str(), (UINT32)fbtn.size(), g_fmtLeft, rcFbtnText,
                   fbtnActive ? brAccent : brText,
                   D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);

    // ③ 放大镜图标（输入框左侧，整体收在输入框边框 g_editX-8 左侧，手柄不越界）
    float magCx = (float)g_magX + 7.0f, magCy = (float)(kBarY + kBarH / 2);
    g_rt->DrawEllipse(D2D1::Ellipse(D2D1::Point2F(magCx, magCy), 4.5f, 4.5f), brMuted, 1.5f);
    g_rt->DrawLine(D2D1::Point2F(magCx + 3.0f, magCy + 3.0f),
                   D2D1::Point2F(magCx + 8.0f, magCy + 8.0f), brMuted, 1.5f);

    // ④ 结果列表：卡片式条目（圆角矩形 + 边框；选中 accent 填充，hover 提亮）
    int st = scrollTop();
    int rows = (int)g_results.size() - st;
    if (rows > displayRows()) rows = displayRows();
    if (rows < 0) rows = 0;
    for (int i = 0; i < rows; ++i) {
        int idx = st + i;
        const data::Item& it = g_results[idx];
        float y = (float)(kListY + i * kRowH);
        D2D1_ROUNDED_RECT rrCard = D2D1::RoundedRect(
            D2D1::RectF((FLOAT)(kListX + 2), y + 2.0f,
                        (FLOAT)(kListX + kListW - 2), y + (FLOAT)kRowH - 2.0f), 8.0f, 8.0f);
        if (idx == g_resultSel) {
            g_rt->FillRoundedRectangle(rrCard, brFillSel);
            g_rt->DrawRoundedRectangle(rrCard, brAccent, 1.5f);   // 选中项金色边框（对齐面板 accent）
        } else {
            if (idx == g_rowHover) g_rt->FillRoundedRectangle(rrCard, brRowHover);
            g_rt->DrawRoundedRectangle(rrCard, brBorder, 1.0f);
        }
        // 类型小标（右对齐 muted）：列宽按当前语言标签实测（中文口径仍为 70px）
        std::wstring tlabel = TrW(it.type == "effect" ? S_HOTBOX_WINDOW_TYPE_EFFECT
                                 : it.type == "script" ? S_HOTBOX_WINDOW_TYPE_SCRIPT
                                                       : S_HOTBOX_WINDOW_TYPE_PRESET);
        const float typeW = typeColumnWidth();
        D2D1_RECT_F rcType = D2D1::RectF((FLOAT)(kListX + kListW - 10) - typeW, y,
                                         (FLOAT)(kListX + kListW - 10), y + (FLOAT)kRowH);
        // 图标 + 名称（左对齐；右边界贴类型小标列左侧留 4px）
        std::wstring line = std::wstring(iconFor(it.type)) + L" " + utf8ToWide(it.name);
        if (!g_typoKeys.empty() && g_typoKeys.count(it.key)) line = L"≈ " + line;
        D2D1_RECT_F rcName = D2D1::RectF((FLOAT)(kListX + 14), y, rcType.left - 4.0f,
                                         y + (FLOAT)kRowH);
        g_rt->DrawText(line.c_str(), (UINT32)line.size(), g_fmtLeft, rcName, brText,
                       D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
        g_rt->DrawText(tlabel.c_str(), (UINT32)tlabel.size(), g_fmtRight, rcType, brMuted,
                       D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
    }

    // 恢复整体 transform（状态行/下拉跟随面板）
    g_rt->SetTransform(baseTx);

    // 滚动条：结果多于窗口行数时显示（轨道 + 滑块，位置随选中行）
    int total = (int)g_results.size();
    if (total > listRows()) {
        float trackY = (float)kListY, trackH = (float)(displayRows() * kRowH);
        float thumbH = trackH * listRows() / total;
        float thumbY = trackY + (trackH - thumbH) * scrollTop() / (total - listRows());
        g_rt->FillRoundedRectangle(
            D2D1::RoundedRect(D2D1::RectF((float)kScrollX, trackY,
                                          (float)(kScrollX + kScrollW), trackY + trackH),
                              4.0f, 4.0f),
            brBorder);
        g_rt->FillRoundedRectangle(
            D2D1::RoundedRect(D2D1::RectF((float)kScrollX, thumbY,
                                          (float)(kScrollX + kScrollW), thumbY + thumbH),
                              4.0f, 4.0f),
            brText);
    }

    // ⑤ 拖拽分隔条（resize 手柄）：面板底部横线（状态行下方），拖拽中高亮金色；无列表时隐藏
    if (!g_results.empty()) {
        float by = (float)resizeBarY();
        g_rt->DrawLine(D2D1::Point2F((FLOAT)(kListX + 10), by + 2.0f),
                       D2D1::Point2F((FLOAT)(kListX + kListW - 10), by + 2.0f),
                       g_draggingResize ? brAccent : brBorder, 1.0f);
    }

    // ⑥ 状态行（执行失败消息优先显示）：错误/警告用金色高亮，其余白色
    std::string status;
    ID2D1SolidColorBrush* brStatus = brText;
    if (!g_msg.empty()) { status = g_msg; brStatus = brAccent; }
    else if (search::normalizeQuery(g_query).empty()) {
        // 空查询（含只敲了空格）＝最近使用列表；无记录时才显示输入提示（保持干净空状态）
        status = g_results.empty()
                     ? std::string(Tr(S_HOTBOX_WINDOW_SEARCH_PLACEHOLDER))
                     : trFormat(S_HOTBOX_WINDOW_STATUS_RECENT, (int)g_results.size());
    }
    else if (!g_typoKeys.empty()) {
        // 近似匹配（手误容错）：结果行首带 ≈，状态行点明未精确命中
        status = trFormat(S_HOTBOX_WINDOW_STATUS_TYPO, (int)g_results.size());
    }
    else if (g_filterHintCount > 0) {
        // 当前类型筛选下无命中，但「全部」里有——提示切筛选
        status = trFormat(S_HOTBOX_WINDOW_STATUS_FILTER_HINT, g_filterHintCount);
    }
    else if (g_results.empty()) { status = Tr(S_HOTBOX_WINDOW_STATUS_NO_MATCH); }
    else if (g_items.empty()) { status = Tr(S_HOTBOX_WINDOW_STATUS_DATA_UNAVAILABLE); brStatus = brAccent; }
    else status = trFormat(S_HOTBOX_WINDOW_STATUS_TOTAL, (int)g_results.size());
    std::wstring wstatus = utf8ToWide(status);
    // 状态行固定宽 kListW：非中文长文案按像素宽度截断（执行失败的完整内容仍走悬停气泡）；
    // zh-CN 文案在宽度内，不额外截断（保持改造前渲染）。
    if (i18n::localeIndex() != i18n::kLocaleZhCN)
        wstatus = truncateToWidth(wstatus, g_fmtLeft, (float)kListW);
    D2D1_RECT_F rcStatus = D2D1::RectF((FLOAT)kListX, (FLOAT)statusY(),
                                       (FLOAT)(kListX + kListW), (FLOAT)(statusY() + 20));
    g_rt->DrawText(wstatus.c_str(), (UINT32)wstatus.size(), g_fmtLeft, rcStatus, brStatus,
                   D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);

    // ⑥' 状态行消息气泡：报错等信息超出状态行宽度被裁剪，hover 状态行时
    // 在其上方展开完整内容（自动换行，覆盖在结果列表上层，与过滤下拉同风格）
    if (g_statusHover && !g_msg.empty() && g_fmtWrap) {
        std::wstring full = utf8ToWide(g_msg);
        IDWriteTextLayout* tl = nullptr;
        if (g_dw->CreateTextLayout(full.c_str(), (UINT32)full.size(), g_fmtWrap,
                                   (FLOAT)(kListW - 24), 4000.0f, &tl) == S_OK && tl) {
            DWRITE_TEXT_METRICS tm = {};
            tl->GetMetrics(&tm);
            tl->Release();
            const float pad = 8.0f;
            float bh = tm.height + pad * 2.0f;
            float maxH = (FLOAT)(statusY() - 4 - kListY);   // 顶到列表区上沿，不遮搜索栏
            if (bh > maxH) bh = maxH;
            D2D1_ROUNDED_RECT rcBub = D2D1::RoundedRect(
                D2D1::RectF((FLOAT)kListX, (FLOAT)(statusY() - 4 - bh),
                            (FLOAT)(kListX + kListW), (FLOAT)(statusY() - 4)),
                8.0f, 8.0f);
            g_rt->FillRoundedRectangle(rcBub, brFill);
            g_rt->DrawRoundedRectangle(rcBub, brBorder, 1.0f);
            D2D1_RECT_F rcTxt = D2D1::RectF(rcBub.rect.left + 12.0f, rcBub.rect.top + pad,
                                            rcBub.rect.right - 12.0f, rcBub.rect.bottom - pad);
            g_rt->DrawText(full.c_str(), (UINT32)full.size(), g_fmtWrap, rcTxt, brText,
                           D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
        }
    }

    // ⑦ 过滤下拉（g_filterMenuOpen 时，4 行：全部/效果/脚本/预设）
    // colorkey 透明窗口不支持 PushLayer opacity（会与 key 色≈黑混合变黑横线），改为直接绘制不透明
    if (g_filterMenuOpen) {
        g_rt->SetTransform(baseTx);
        D2D1_ROUNDED_RECT rcPanel = D2D1::RoundedRect(
            D2D1::RectF((FLOAT)kListX, (FLOAT)kFilterDropY,
                        (FLOAT)(kListX + filterDropWidth()),
                        (FLOAT)(kFilterDropY + 4 * kFilterDropRowH)), 6.0f, 6.0f);
        g_rt->FillRoundedRectangle(rcPanel, brFill);
        g_rt->DrawRoundedRectangle(rcPanel, brBorder, 1.0f);
        static const StrId kDropIds[4] = { S_HOTBOX_WINDOW_TYPE_ALL, S_HOTBOX_WINDOW_TYPE_EFFECT,
                                           S_HOTBOX_WINDOW_TYPE_SCRIPT, S_HOTBOX_WINDOW_TYPE_PRESET };
        const int dropW = filterDropWidth();
        for (int i = 0; i < 4; ++i) {
            D2D1_RECT_F rcItem = D2D1::RectF(
                (FLOAT)kListX, (FLOAT)(kFilterDropY + i * kFilterDropRowH),
                (FLOAT)(kListX + dropW),
                (FLOAT)(kFilterDropY + (i + 1) * kFilterDropRowH));
            if (i == g_filterHover)
                g_rt->FillRoundedRectangle(D2D1::RoundedRect(rcItem, 4.0f, 4.0f), brFillSel);
            // 文字左侧留 10px 内边距，不贴边
            D2D1_RECT_F rcItemTxt = D2D1::RectF(
                (FLOAT)(kListX + 10), rcItem.top,
                (FLOAT)(kListX + dropW - 6), rcItem.bottom);
            std::wstring dropLabel = TrW(kDropIds[i]);
            g_rt->DrawText(dropLabel.c_str(), (UINT32)dropLabel.size(), g_fmtLeft, rcItemTxt,
                           brText, D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
        }
        g_rt->SetTransform(baseTx);   // 恢复整体 transform
    }

    // D2D 直接绘制输入文本、选中高亮和光标（在所有面板填充之后，避免被 brFill 覆盖）：
    // ULW 模式下 EDIT 子窗口的 GDI 绘制会被位图覆盖（EDIT alpha=0 完全透明），
    // 故 D2D 接管：用 EM_GETSEL 查选区 → 画选中背景；HitTestTextPosition 定位 caret → 画闪烁光标
    if (g_mode == Mode::kSearch && g_edit) {
        std::wstring wq = utf8ToWide(g_query);
        // 查询 EDIT 选区（selStart/selEnd 为 UTF-16 字符索引，与 wq 一致）
        DWORD selStart = 0, selEnd = 0;
        SendMessageW(g_edit, EM_GETSEL, (WPARAM)&selStart, (LPARAM)&selEnd);
        if (selStart > (DWORD)wq.size()) selStart = (DWORD)wq.size();
        if (selEnd > (DWORD)wq.size()) selEnd = (DWORD)wq.size();
        DWORD caretPos = selEnd;   // 光标在选区结束位置（无选中时 selStart==selEnd）

        float textY = (FLOAT)(kBarY + 8);
        float textH = (FLOAT)(kBarH - 12);
        // 用 TextLayout 统一测量字符位置（选中区间 + caret x），保证与绘制一致
        // 布局高度用 textH（而非 kBarH）：kBarH 会多出 12px，使居中文本整体下移 6px（偏下）
        IDWriteTextLayout* layout = nullptr;
        g_dw->CreateTextLayout(wq.c_str(), (UINT32)wq.size(), g_fmtLeft,
                               (FLOAT)g_editW, textH, &layout);
        if (layout) {
            // 选中背景：[selStart, selEnd) 区间的高亮矩形
            if (selEnd > selStart && selStart < (DWORD)wq.size()) {
                DWRITE_HIT_TEST_METRICS hm1 = {}, hm2 = {};
                FLOAT px1, py1, px2, py2;
                layout->HitTestTextPosition(selStart, FALSE, &px1, &py1, &hm1);
                layout->HitTestTextPosition(selEnd, FALSE, &px2, &py2, &hm2);
                float selX = (FLOAT)g_editX + hm1.left;
                float selW = hm2.left - hm1.left;
                g_rt->FillRectangle(
                    D2D1::RectF(selX, textY, selX + selW, textY + textH), brFillSel);
            }
            // 文本（DrawTextLayout 与上面的测量同源，位置一致）
            g_rt->DrawTextLayout(D2D1::Point2F((FLOAT)g_editX, textY), layout, brText,
                                 D2D1_DRAW_TEXT_OPTIONS_CLIP);
            // 闪烁光标：500ms 周期，前 300ms 显示；位置取 caretPos 处字符的左边界
            DWORD blink = GetTickCount() % 500;
            if (blink < 300) {
                DWRITE_HIT_TEST_METRICS hmc = {};
                FLOAT pxc, pyc;
                layout->HitTestTextPosition(caretPos, FALSE, &pxc, &pyc, &hmc);
                float caretX = (FLOAT)g_editX + hmc.left;
                g_rt->DrawLine(D2D1::Point2F(caretX, (FLOAT)(kBarY + 9)),
                               D2D1::Point2F(caretX, (FLOAT)(kBarY + kBarH - 9)),
                               brText, 1.5f);
            }
            layout->Release();
        } else if (!wq.empty()) {
            // layout 创建失败的兜底：纯文本（无选中/caret 定位）
            D2D1_RECT_F rcText = D2D1::RectF((FLOAT)g_editX, textY,
                                             (FLOAT)(g_editX + g_editW), (FLOAT)(kBarY + kBarH - 4));
            g_rt->DrawText(wq.c_str(), (UINT32)wq.size(), g_fmtLeft, rcText, brText,
                           D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
        }
    }
}

// —— 进度卡片：预设批量应用的进度/错误展示（手势/搜索统一转场）——
// 紧凑卡片（kWinW × g_progressWinH）居中于原窗口中心：
//   进行中：标题（条目名）+ 进度消息（g_msg，如"应用预设 3/7…"），全部成功自动渐隐关闭
//   错误态：g_msg 完整换行展示（部分失败/中止详情），点击卡片或 Esc 关闭
// Esc / 点击 AE（失活）→ 中止余层（已应用层可 Ctrl+Z 回退）后关闭
void updateProgressWindowSize() {
    if (!g_visible || !g_hwnd) return;
    int winH = 84;   // 进度态固定高：标题 + 状态行 + 上下留白
    if (g_progressError && !g_msg.empty() && g_dw && g_fmtWrap) {
        // 错误态：按完整消息换行后的实际高度自适应（上限 320，超出滚动不可见部分裁掉）
        std::wstring full = utf8ToWide(g_msg);
        IDWriteTextLayout* tl = nullptr;
        if (g_dw->CreateTextLayout(full.c_str(), (UINT32)full.size(), g_fmtWrap,
                                   (FLOAT)(kWinW - 48), 4000.0f, &tl) == S_OK && tl) {
            DWRITE_TEXT_METRICS tm = {};
            tl->GetMetrics(&tm);
            tl->Release();
            winH = 56 + (int)(tm.height + 0.5) + 20;
            if (winH > 320) winH = 320;
        }
    }
    g_progressWinH = winH;
    // 居中于当前窗口中心（手势环心 / 搜索面板中心），并钳制在工作区内
    RECT wr;
    GetWindowRect(g_hwnd, &wr);
    int cx = (wr.left + wr.right) / 2, cy = (wr.top + wr.bottom) / 2;
    int pW = phys(kWinW), pH = phys(winH);
    int left = cx - pW / 2, top = cy - pH / 2;
    HMONITOR mon = MonitorFromPoint({ cx, cy }, MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi = {};
    mi.cbSize = sizeof(mi);
    GetMonitorInfoW(mon, &mi);
    if (left < mi.rcWork.left) left = mi.rcWork.left;
    if (top < mi.rcWork.top) top = mi.rcWork.top;
    if (left + pW > mi.rcWork.right) left = mi.rcWork.right - pW;
    if (top + pH > mi.rcWork.bottom) top = mi.rcWork.bottom - pH;
    SetWindowPos(g_hwnd, HWND_TOPMOST, left, top, pW, pH, SWP_NOACTIVATE);
}

void paintProgress(ID2D1SolidColorBrush* brFill, ID2D1SolidColorBrush* brText,
                   ID2D1SolidColorBrush* brMuted, ID2D1SolidColorBrush* brAccent,
                   ID2D1SolidColorBrush* brEdge) {
    float w = (FLOAT)kWinW, h = (FLOAT)g_progressWinH;
    // 面板背景 + 描边（与搜索面板同风格：外框 9~10 边距、12 圆角）
    g_rt->FillRoundedRectangle(
        D2D1::RoundedRect(D2D1::RectF(9.0f, 9.0f, w - 9.0f, h - 9.0f), 12.0f, 12.0f), brFill);
    g_rt->DrawRoundedRectangle(
        D2D1::RoundedRect(D2D1::RectF(10.0f, 10.0f, w - 10.0f, h - 10.0f), 12.0f, 12.0f),
        brEdge, 1.5f);
    // 标题：条目名（左）+ 类型小标（右）；小标列宽按译文实测（中文口径仍为 42px）
    std::wstring tag = TrW(S_HOTBOX_WINDOW_TYPE_PRESET);
    float tagW = measureTextW(tag, g_fmtLeft, 200.0f) + 8.0f;
    if (tagW < 42.0f) tagW = 42.0f;
    const float tagLeft = w - 24.0f - tagW;
    const float titleRight = (tagLeft < w - 70.0f) ? tagLeft : (w - 70.0f);
    // 标题区 = 24..titleRight：zh-CN 按原 16 字符口径，其余语言按像素宽度截断
    std::wstring title = truncateForWidth(utf8ToWide(g_progressTitle), 16, g_fmtLeft,
                                          titleRight - 24.0f);
    D2D1_RECT_F rcTitle = D2D1::RectF(24.0f, 16.0f, titleRight, 38.0f);
    g_rt->DrawText(title.c_str(), (UINT32)title.size(), g_fmtLeft, rcTitle, brText,
                   D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
    D2D1_RECT_F rcTag = D2D1::RectF(tagLeft, 16.0f, w - 24.0f, 38.0f);
    g_rt->DrawText(tag.c_str(), (UINT32)tag.size(), g_fmtRight, rcTag, brMuted,
                   D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
    // 状态/错误文本：进行中单行（裁剪）；错误态完整换行（高度已按测量自适应）
    if (!g_msg.empty()) {
        std::wstring msg = utf8ToWide(g_msg);
        D2D1_RECT_F rcMsg = g_progressError
            ? D2D1::RectF(24.0f, 44.0f, w - 24.0f, h - 16.0f)
            : D2D1::RectF(24.0f, 44.0f, w - 24.0f, 66.0f);
        g_rt->DrawText(msg.c_str(), (UINT32)msg.size(), g_fmtWrap, rcMsg,
                       g_progressError ? brAccent : brMuted,
                       D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
    }
}

// ── 弧段标签宽度适配（修长名溢出弧形）——
// 标签是水平文本行，锚点在弧段中角、中外半径处。对角弧段（±30°/±150°）在该高度的
// 水平截面约 75px，远窄于正上/正下段（约 104px）；旧的固定字符数截断（CJK 8 字 ≈100px）
// + ±60 文本框会让长名（如"色相/饱和度"）越出弧形轮廓。segmentLabelWidth 按扇形环带
// 实际截面求可用宽度（几何固定 → 一次性缓存），fitLabel 用 DWrite 实测文本宽二分截断。
// 点 (x, kCy+dy) 是否在环带 [rIn,rOut] 的扇区 [a1,a2] 内（宽度扫描用；
// 圆角与段间隙忽略，由内边距吸收）。 起参数化环带半径：主环弧段与子菜单花瓣共用
static bool inSectorBand(double x, double dy, double a1, double a2, double rIn, double rOut) {
    double dx = x - kCx;
    double r2 = dx * dx + dy * dy;
    if (r2 < rIn * rIn || r2 > rOut * rOut) return false;
    double ang = std::atan2(dy, dx) * 180.0 / hotbox::kPi;
    double d1 = hotbox::angleDelta(a1, ang);
    return d1 >= 0.0 && d1 <= hotbox::angleDelta(a1, a2);
}

// 扇区标签可用水平宽度（主环弧段与子菜单花瓣共用）：锚点上下 ±9px（文本行墨迹高度）
// 三条扫描线取截面最小值，自锚点向两侧 1px 步进出界为止；两侧各留 5px 内边距，
// 下限 24px（至少容纳图标/单字+…）
static double bandLabelWidth(double rIn, double rOut, double a1, double a2,
                             double lx, double ly) {
    double wMin = 1e9;
    for (int k = -1; k <= 1; ++k) {
        double dy = (ly + 9.0 * k) - kCy;
        if (!inSectorBand(lx, dy, a1, a2, rIn, rOut)) continue;   // 该扫描线锚点已出界：跳过
        double l = lx, r = lx;
        while (l > 0.0 && inSectorBand(l - 1.0, dy, a1, a2, rIn, rOut)) l -= 1.0;
        while (r < (double)kWinW && inSectorBand(r + 1.0, dy, a1, a2, rIn, rOut)) r += 1.0;
        if (r - l < wMin) wMin = r - l;
    }
    double w = (wMin >= 1e9 ? 70.0 : wMin) - 10.0;   // 扫描线全部出界 → 保守兜底
    return w < 24.0 ? 24.0 : w;
}

// 弧段 i 标签可用宽度（几何固定 → 一次性缓存）
static double segmentLabelWidth(int i) {
    static double s_cache[kSegmentCount] = {};
    if (i < 0 || i >= kSegmentCount) return 60.0;
    if (s_cache[i] <= 0.0) {
        double mid = segmentStart(i) + segmentSpan(i) / 2.0;
        double lx = 0.0, ly = 0.0;
        hotbox::polarToXY(kCx, kCy, (kRIn + kROut) / 2.0, mid, &lx, &ly);
        double a1 = segmentStart(i), a2 = a1 + segmentSpan(i);
        s_cache[i] = bandLabelWidth(kRIn, kROut, a1, a2, lx, ly);
    }
    return s_cache[i];
}

// 子菜单花瓣 k 标签可用宽度（几何固定 → 一次性缓存）
static double capPetalLabelWidth(int k) {
    static double s_cache[3] = {};
    if (k < 0 || k > 2) return 60.0;
    if (s_cache[k] <= 0.0) {
        double lx = 0.0, ly = 0.0;
        hotbox::polarToXY(kCx, kCy, (kCapRIn + kCapROut) / 2.0, kCapPetalMid[k], &lx, &ly);
        s_cache[k] = bandLabelWidth(kCapRIn, kCapROut, kCapPetalMid[k] - kCapPetalSpan / 2.0,
                                    kCapPetalMid[k] + kCapPetalSpan / 2.0, lx, ly);
    }
    return s_cache[k];
}

// 子菜单花瓣命中：环带 [kCapRIn,kCapROut] 内按角度（主环外圈之外的上方扇区）
static int hitCapPetal(POINT pt) {
    double dx = pt.x - kCx, dy = pt.y - kCy;
    double d2 = dx * dx + dy * dy;
    if (d2 < kCapRIn * kCapRIn || d2 > kCapROut * kCapROut) return -1;
    double ang = std::atan2(dy, dx) * 180.0 / hotbox::kPi;
    for (int k = 0; k < 3; ++k) {
        double d = hotbox::angleDelta(kCapPetalMid[k] - kCapPetalSpan / 2.0, ang);
        if (d >= 0.0 && d <= kCapPetalSpan) return k;
    }
    return -1;
}

// DWrite 实测单行文本宽 ≤ maxW？（测量通道不可用返回 false，由调用方走兜底）
// fmt：测量所用格式——花瓣标签用 g_fmtPetal 小字号实测（与绘制格式一致，主环默认 g_fmt）
static bool labelFits(const std::wstring& s, float maxW, IDWriteTextFormat* fmt) {
    if (!g_dw || !fmt || s.empty()) return false;
    IDWriteTextLayout* tl = nullptr;
    if (g_dw->CreateTextLayout(s.c_str(), (UINT32)s.size(), fmt,
                               1000.0f, 30.0f, &tl) != S_OK || !tl) return false;
    DWRITE_TEXT_METRICS tm = {};
    tl->GetMetrics(&tm);
    tl->Release();
    return tm.width <= maxW;
}

// 截断标签到 maxW：二分找最大可容纳前缀（前缀 + "…"）；单字符仍超宽时原样返回
//（DrawText 的 CLIP 兜底裁切）。测量通道不可用（g_dw/g_fmt 缺失）退回字符数截断
static std::wstring fitLabel(const std::wstring& label, double maxW,
                             IDWriteTextFormat* fmt = g_fmt) {
    if (label.empty() || labelFits(label, (float)maxW, fmt)) return label;
    if (!g_dw || !fmt) return truncateW(label, 8);
    int lo = 1, hi = (int)label.size();
    while (lo < hi) {
        int mid = (lo + hi + 1) / 2;   // 偏上取：找最大可容纳前缀
        if (labelFits(label.substr(0, (size_t)mid) + L"…", (float)maxW, fmt)) lo = mid;
        else hi = mid - 1;
    }
    return label.substr(0, (size_t)lo) + L"…";
}

// 主环弧段标签格式：12.5px（g_fmt）放得下就不动；否则自 11.5px 起按 1px 步进逐级降字号
// （下限 9px），返回最先放得下的格式；全都不放下返回最小字号，由调用方 fitLabel 加省略号。
// zh-CN 固定返回 g_fmt（字号与截断位置与改造前一致）。
IDWriteTextFormat* arcLabelFormat(const std::wstring& label, double maxW) {
    if (i18n::localeIndex() == i18n::kLocaleZhCN || !g_dw || label.empty()) return g_fmt;
    if (labelFits(label, (float)maxW, g_fmt)) return g_fmt;
    IDWriteTextFormat* smallest = g_fmt;
    for (int k = 0; k < 4; ++k) {
        IDWriteTextFormat* fmt = g_fmtArc[k];
        if (!fmt) continue;
        smallest = fmt;
        if (labelFits(label, (float)maxW, fmt)) return fmt;
    }
    return smallest;
}

void paint(HWND hwnd) {
    ensureD2D(hwnd);
    if (!g_rt) return;
    // ULW 窗口尺寸变化时同步重建位图（替代原 WM_SIZE → g_rt->Resize）
    RECT rc;
    GetClientRect(hwnd, &rc);
    int w = rc.right - rc.left, h = rc.bottom - rc.top;
    if (w != g_bmpW || h != g_bmpH) resizeBmp(w, h);
    // resizeBmp 失败路径会释放旧 g_rt 并置空（WIC/RT 分配失败），此处必须复查，
    // 否则继续 BeginDraw 会空指针解引用崩掉 AE 主进程（与 resizeBmp 内注释的自我警告一致）
    if (!g_rt) return;

    g_rt->BeginDraw();
    g_rt->Clear(D2D1::ColorF(0, 0, 0, 0));   // per-pixel alpha：清成完全透明（而非魔法色）

    // 整窗全局 alpha：退场/入场渐隐，通过图层 opacity 实现（不再用 LWA_ALPHA）
    // 退场 alpha 从 1→0 渐隐；搜索/设置面板入场 alpha 从 0→1 渐显
    ID2D1Layer* fadeLayer = nullptr;
    double fadeAlpha = 1.0;
    if (g_animDir == -1) {
        // 退场：g_animPhase 从 1→0，fadeAlpha 从 1→0 线性渐隐
        // 注：不能用 easeInCubic(g_animPhase) —— g_animPhase 在退场期间是 1→0，
        // easeInCubic(0.5)=0.125 会让 alpha 在前半段（75ms）就跌到 12.5%，
        // 视觉上像瞬间消失再慢慢淡出最后一点尾迹 → 闪烁。线性才能均匀渐隐。
        fadeAlpha = g_animPhase;
    } else if (g_animPhase < 1.0 &&
               (g_mode == Mode::kSettings || g_mode == Mode::kSearch ||
                g_mode == Mode::kProgress)) {
        // 搜索/设置/进度卡片入场：g_animPhase 从 0→1，fadeAlpha 从 0→1
        fadeAlpha = easeOutCubic(g_animPhase);
    }
    if (fadeAlpha < 0.001) fadeAlpha = 0.001;
    if (fadeAlpha < 1.0) {
        g_rt->CreateLayer(nullptr, &fadeLayer);
        // CreateLayer 失败（极端内存耗尽）不 PushLayer（与收尾处 if (fadeLayer)
        // 的 PopLayer 自然配对），跳过整窗渐隐层效果——本帧按不透明绘制，下一帧重试
        if (fadeLayer) {
            D2D1_LAYER_PARAMETERS lp = {};
            lp.contentBounds = D2D1::RectF(-10000, -10000, 10000, 10000);
            lp.opacity = (FLOAT)fadeAlpha;
            g_rt->PushLayer(lp, fadeLayer);
        }
    }

    // 二级菜单（搜索面板）入场：小缩放（0.92→1）+ 透明度渐显（透明度由上方 fadeLayer 统一处理）。
    // 缩放中心用搜索栏中心（kCx, 搜索栏中心 y）——窗口按搜索栏对准鼠标定位，菜单从鼠标处展开
    D2D1::Matrix3x2F baseTx = D2D1::Matrix3x2F::Identity();
    if (g_mode == Mode::kSearch && g_animDir != -1 && g_animPhase < 1.0) {
        double s = 0.92 + 0.08 * easeOutCubic(g_animPhase);
        if (s < 0.001) s = 0.001;
        baseTx = D2D1::Matrix3x2F::Scale((float)s, (float)s,
                                         D2D1::Point2F((float)kCx,
                                                       (float)(kBarY + kBarH / 2)));
        g_rt->SetTransform(baseTx);
    }

    ID2D1SolidColorBrush *brBorder = nullptr, *brFill = nullptr, *brFillSel = nullptr,
        *brText = nullptr, *brMuted = nullptr, *brCenter = nullptr, *brRowHover = nullptr,
        *brAccent = nullptr, *brEdge = nullptr, *brBorderDim = nullptr;
    g_rt->CreateSolidColorBrush(cBorder(), &brBorder);
    g_rt->CreateSolidColorBrush(cSurface(), &brFill);
    g_rt->CreateSolidColorBrush(cAccentSoft(), &brFillSel);
    g_rt->CreateSolidColorBrush(cText(), &brText);
    g_rt->CreateSolidColorBrush(cMuted(), &brMuted);
    g_rt->CreateSolidColorBrush(cCenterFill(), &brCenter);
    g_rt->CreateSolidColorBrush(cRowHover(), &brRowHover);
    g_rt->CreateSolidColorBrush(cAccent(), &brAccent);   // 金色：选中/按下边框
    g_rt->CreateSolidColorBrush(cEdge(), &brEdge);       // 调暗的白色描边
    g_rt->CreateSolidColorBrush(cBorderDim(), &brBorderDim);   // 稍亮暗灰：弧段描边

    // 任一画刷创建失败（极端内存耗尽）安全降级——空画刷参与后续 Fill/Draw 与
    // 末尾统一 Release 均为空指针解引用，会崩掉 AE 主进程；跳过本帧绘制（EndDraw 配对
    // BeginDraw、PopLayer 配对已 Push 的 fadeLayer），窗口保持上一帧，下一帧重试
    if (!brBorder || !brFill || !brFillSel || !brText || !brMuted || !brCenter ||
        !brRowHover || !brAccent || !brEdge || !brBorderDim) {
        hotbox_log("window: CreateSolidColorBrush failed, skip paint");
        if (fadeLayer) { g_rt->PopLayer(); fadeLayer->Release(); }
        if (brBorder) brBorder->Release();
        if (brFill) brFill->Release();
        if (brFillSel) brFillSel->Release();
        if (brText) brText->Release();
        if (brMuted) brMuted->Release();
        if (brCenter) brCenter->Release();
        if (brRowHover) brRowHover->Release();
        if (brAccent) brAccent->Release();
        if (brEdge) brEdge->Release();
        if (brBorderDim) brBorderDim->Release();
        g_rt->EndDraw();
        return;
    }

    if (g_mode == Mode::kSearch) {
        // 搜索模式：长条搜索栏 + 线性结果列表 + 过滤下拉（中心圆不绘制）
        paintSearch(baseTx, brBorder, brFill, brFillSel, brText, brMuted, brRowHover, brAccent, brEdge);
    } else if (g_mode == Mode::kProgress) {
        // 进度卡片：标题 + 进度/错误（中心圆、EDIT 均不绘制）
        if (g_edit) ShowWindow(g_edit, SW_HIDE);
        paintProgress(brFill, brText, brMuted, brAccent, brEdge);
    } else if (g_mode == Mode::kSettings) {
        // 设置面板：槽位绑定列表 + 热键 + 返回（中心圆不绘制）
        paintSettings(brBorder, brFill, brFillSel, brText, brMuted, brRowHover, brAccent);
    } else {
        // 手势模式：EDIT 仅搜索模式显示，此处兜底隐藏（防中心圆残留竖线/矩形）
        if (g_edit) ShowWindow(g_edit, SW_HIDE);
        // 执行态：被点击弧段播按压动画期间，其他弧段 + 中心圆按 pressT 渐隐（小缩放 + 透明度消失）
        // 仅按下反馈（WM_LBUTTONDOWN）时 g_execDispersing=false，其他弧段不渐隐
        bool execDispersing = g_execDispersing;
        double pressT = execDispersing
            ? clamp01((double)(GetTickCount64() - g_pressStartMs) / kPressMs)
            : 0.0;
        // 执行散开：其他弧段+中心圆用 PushLayer opacity 整体渐隐（ULW per-pixel alpha 支持半透明）
        // 被点击弧段在 PushLayer 外单独绘制，保持不透明
        double disperseAlpha = 1.0;
        double disperseScale = 1.0;
        if (execDispersing) {
            disperseAlpha = 1.0 - easeInCubic(pressT);
            disperseScale = 1.0 - 0.08 * easeInCubic(pressT);   // 小缩放（1.0→0.92），不缩到 0
            if (disperseAlpha < 0.001) disperseAlpha = 0.0;
        }
        ID2D1Layer* disperseLayer = nullptr;
        if (execDispersing && disperseAlpha > 0.0) {
            g_rt->CreateLayer(nullptr, &disperseLayer);
            // CreateLayer 失败不 PushLayer（与收尾处 if (disperseLayer) 的
            // PopLayer 自然配对），跳过执行散开渐隐层——其他弧段/中心圆本帧不透明
            // 绘制，下一帧重试
            if (disperseLayer) {
                D2D1_LAYER_PARAMETERS lp = {};
                lp.contentBounds = D2D1::RectF(-10000, -10000, 10000, 10000);
                lp.opacity = (FLOAT)disperseAlpha;
                g_rt->PushLayer(lp, disperseLayer);
            }
        }
        // 入场：段按出场序号延迟 + 弹性弹出（左先右后，弹性仅手势环）；退场不缩放，靠整窗 alpha 渐隐
        for (int i = 0; i < kLayout.segCount; ++i) {
            double segScale = (g_animDir == -1) ? 1.0
                             : easeOutBack(staggerT(g_animPhase, (double)kSegOut[i],
                                                    (double)(kSegmentCount - 1)));
            if (segScale < 0.001) continue;   // 未轮到该段：跳过（首帧只有最早段可见）
            bool isSel = (i == g_sel), isPress = (i == g_pressIdx);
            // 执行散开：被点击弧段在 disperseLayer 外单独绘制；其他弧段在层内随 opacity 渐隐
            if (execDispersing && isPress) continue;
            // 执行散开且渐隐完成（disperseAlpha<=0）：其他弧段已不可见，跳过绘制避免闪现
            if (execDispersing && disperseAlpha <= 0.0) continue;
            // 执行散开：其他弧段叠加小缩放（1.0→0.92）
            if (execDispersing) segScale *= disperseScale;
            if (isPress) {
                // 按下反馈：时间驱动压入（90ms 内 1.0→0.94，先快后慢），非瞬时跳变
                double pt = clamp01((double)(GetTickCount64() - g_pressStartMs) / kPressMs);
                segScale *= 1.0 - 0.06 * easeOutCubic(pt);
            }
            // 选中态（未按下）：弧段向外凸出（径向放大 5%），hover 反馈更明显
            if (isSel && !isPress) segScale *= 1.05;
            g_rt->SetTransform(D2D1::Matrix3x2F::Scale((float)segScale, (float)segScale,
                                                       D2D1::Point2F((float)kCx, (float)kCy)));
            double a1 = segmentStart(i);
            double a2 = a1 + segmentSpan(i);
            ID2D1PathGeometry* geo = nullptr;
            ID2D1GeometrySink* sink = nullptr;
            // 几何/sink 创建失败（极端内存耗尽）跳过该弧段（对 nullptr 调
            // Open/BeginFigure/Release 均会崩掉 AE 主进程），下一帧重试
            if (FAILED(g_factory->CreatePathGeometry(&geo)) || !geo) continue;
            if (FAILED(geo->Open(&sink)) || !sink) { geo->Release(); continue; }
            addSegment(sink, a1, a2);
            sink->Close();
            sink->Release();
            // hover 选中 / 按下：金色填充 + 金色/暗灰描边（点击反馈）；
            // 非选中态用径向渐变填充（柔和内阴影：内缘暗→外缘表面色）+ 暗灰细描边。
            // 弧段间以 2° 透明缝分隔；描边用垫边防 colorkey 吃抗锯齿。
            if (isSel || isPress) {
                g_rt->FillGeometry(geo, brFillSel);
                g_rt->DrawGeometry(geo, brFillSel, 1.0f);   // 垫边（描边外缘不触 key）
                g_rt->DrawGeometry(geo, isPress ? brBorderDim : brAccent,
                                   isPress ? 1.5f : 1.5f);
            } else {
                // 径向渐变画刷创建失败（内存耗尽）跳过填充仅留描边（空画刷会崩）
                ID2D1RadialGradientBrush* brRadial = radialBrush();
                if (brRadial) g_rt->FillGeometry(geo, brRadial);
                g_rt->DrawGeometry(geo, brFillSel, 1.0f);   // 垫边
                g_rt->DrawGeometry(geo, brBorderDim, 1.0f);   // 暗灰描边（非选中态）
            }
            geo->Release();

            double mid = a1 + segmentSpan(i) / 2.0;
            double lx, ly;
            hotbox::polarToXY(kCx, kCy, (kRIn + kROut) / 2.0, mid, &lx, &ly);
            // 弧段标签：功能项（图标+名称）/ 设置入口 / 截图入口 / 类别入口（▸ 类别名）
            // 按弧段实际水平截面测宽截断（fitLabel），替代固定字符数截断
            std::wstring label;
            if ((size_t)i < g_entries.size() && g_entries[i].kind == GestureEntry::kItem) {
                const data::Item& it = g_entries[i].item;
                label = std::wstring(iconFor(it.type)) + L" " + utf8ToWide(it.name);
            } else if ((size_t)i < g_entries.size() &&
                       g_entries[i].kind == GestureEntry::kSettings) {
                label = L"⚙";   // 设置入口：仅图标
            } else if ((size_t)i < g_entries.size() &&
                       g_entries[i].kind == GestureEntry::kCapture) {
                label = TrW(S_HOTBOX_WINDOW_CAPTURE_ENTRY);   // 合成预览图入口：按下即弹三花瓣
            } else if ((size_t)i < g_entries.size()) {
                // 动态槽：类别入口
                label = L"▸ " + utf8ToWide(categoryName(g_entries[i].catType));
            } else {
                continue;
            }
            double lw = segmentLabelWidth(i) / 2.0;
            // 非中文长译名优先逐级降字号适配；仍放不下才省略号（zh 固定 g_fmt，原逻辑不变）
            IDWriteTextFormat* labelFmt = arcLabelFormat(label, lw * 2.0);
            if (labelFmt == g_fmt || !labelFits(label, (float)(lw * 2.0), labelFmt))
                label = fitLabel(label, lw * 2.0, labelFmt);
            D2D1_RECT_F rcText = D2D1::RectF((FLOAT)(lx - lw), (FLOAT)(ly - 14),
                                            (FLOAT)(lx + lw), (FLOAT)(ly + 14));
            g_rt->DrawText(label.c_str(), (UINT32)label.size(), labelFmt, rcText,
                            (isSel || isPress) ? brAccent : brMuted,
                            D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
        }

        // 中心圆（最先弹出，早于所有弧段；弹性仅入场，退场随整窗 alpha 渐隐不缩放）
        // 执行散开阶段：中心圆不缩放，仅随 disperseLayer opacity 渐隐
        {
            double cScale = (g_animDir == -1) ? 1.0
                            : easeOutBack(staggerT(g_animPhase, 0.0, (double)(kSegmentCount - 1)));
            if (cScale < 0.001) cScale = 0.001;
            if (g_centerPressed) {
                // 按下反馈：时间驱动放大（膨胀感，与选中凸出同向）
                double pt = clamp01((double)(GetTickCount64() - g_pressStartMs) / kPressMs);
                cScale *= 1.0 + 0.08 * easeOutCubic(pt);
            } else if (g_centerHover) {
                // 选中态（hover）：放大凸出（与弧段选中一致）
                cScale *= 1.05;
            }
            g_rt->SetTransform(D2D1::Matrix3x2F::Scale((float)cScale, (float)cScale,
                                                       D2D1::Point2F((float)kCx, (float)kCy)));
        }
        // 执行散开且渐隐完成（disperseAlpha<=0）：中心圆已不可见，跳过绘制避免闪现
        if (!(execDispersing && disperseAlpha <= 0.0)) {
        // hover 选中态：填充提亮 + 金色边框（与弧段选中观感一致）；按下白色边框。
        // 同色细描边垫边（colorkey 抗锯齿），防中心圆外缘在空隙里露出暗色弧线
        bool cAct = g_centerHover || g_centerPressed;
        D2D1_ELLIPSE ellC = D2D1::Ellipse(D2D1::Point2F((FLOAT)kCx, (FLOAT)kCy),
                                          (FLOAT)kCenterR, (FLOAT)kCenterR);
        g_rt->FillEllipse(ellC, cAct ? brFillSel : brCenter);
        g_rt->DrawEllipse(ellC, cAct ? brFillSel : brCenter, 1.0f);
        ID2D1SolidColorBrush* brCen = g_centerPressed ? brText : (cAct ? brAccent : brText);
        g_rt->DrawEllipse(ellC, brCen, cAct ? 1.5f : 1.0f);
        // 中心圆提示：仅放大镜（"搜索"字样去除，转场至二级菜单时图标无缝移至搜索框左侧）
        float cxf = (float)kCx, cyf = (float)kCy;
        ID2D1SolidColorBrush* cIconBr = cAct ? brAccent : brText;
        g_rt->DrawEllipse(D2D1::Ellipse(D2D1::Point2F(cxf, cyf - 4.0f), 5.5f, 5.5f), cIconBr, 1.6f);
        g_rt->DrawLine(D2D1::Point2F(cxf + 4.0f, cyf),
                       D2D1::Point2F(cxf + 10.0f, cyf + 6.0f), cIconBr, 1.6f);
        // 手势模式上方统一气泡：g_msg（带弹性动画）
        // 宽度按文本自适应（左右各 12px 内边距），居中于面板，避免固定宽条内侧留大片空白
        std::wstring bubText;
        // 气泡上限宽 kWinW-28、左右各 12px 内边距：单行文本区宽 kWinW-52
        if (!g_msg.empty())
            bubText = truncateForWidth(utf8ToWide(g_msg), 28, g_fmtLeft,
                                       (float)(kWinW - 28 - 24));
        if (!bubText.empty()) {
            // 测量文本自然宽度（2000 宽布局不换行），据此定气泡宽
            // 用 g_fmtLeft（左对齐+不换行）测量：居中格式可能使 GetMetrics 返回偏大宽度，导致气泡过宽
            float txtW = 0.0f;
            IDWriteTextLayout* tl = nullptr;
            if (SUCCEEDED(g_dw->CreateTextLayout(bubText.c_str(), (UINT32)bubText.size(),
                                                 g_fmtLeft, 2000.0f, 32.0f, &tl))) {
                DWRITE_TEXT_METRICS tm = {};
                if (SUCCEEDED(tl->GetMetrics(&tm))) txtW = tm.widthIncludingTrailingWhitespace;
                tl->Release();
            }
            float bubW = txtW + 24.0f;   // 左右各 12px 内边距
            if (bubW > (float)(kWinW - 28)) bubW = (float)(kWinW - 28);   // 上限防溢出
            D2D1_RECT_F rcBub = D2D1::RectF((float)(kCx - bubW / 2), (float)(kCy - kROut - 50.0),
                                            (float)(kCx + bubW / 2), (float)(kCy - kROut - 18.0));
            if (!g_msg.empty()) {
                // g_msg：带框气泡 + 弹性动画
                static ULONGLONG s_msgMs = 0;
                static std::string s_lastMsg;
                if (s_lastMsg != g_msg) { s_lastMsg = g_msg; s_msgMs = GetTickCount64(); }
                double t = clamp01((double)(GetTickCount64() - s_msgMs) / 200.0);
                double bs = 0.85 + 0.15 * easeOutBack(t);
                if (bs < 0.001) bs = 0.001;
                D2D1_POINT_2F bubC = D2D1::Point2F((rcBub.left + rcBub.right) / 2.0f,
                                                   (rcBub.top + rcBub.bottom) / 2.0f);
                g_rt->SetTransform(D2D1::Matrix3x2F::Scale((float)bs, (float)bs, bubC));
                // 填充外扩 1px 垫边框抗锯齿外缘（同面板处理，防透明背景上出暗色竖边）
                g_rt->FillRoundedRectangle(
                    D2D1::RoundedRect(D2D1::RectF(rcBub.left - 1.0f, rcBub.top - 1.0f,
                                                  rcBub.right + 1.0f, rcBub.bottom + 1.0f),
                                      8.0f, 8.0f),
                    brFill);
                g_rt->DrawRoundedRectangle(D2D1::RoundedRect(rcBub, 8.0f, 8.0f), brAccent, 1.5f);
                D2D1_RECT_F rcMsg = D2D1::RectF(rcBub.left + 12.0f, rcBub.top,
                                                rcBub.right - 12.0f, rcBub.bottom);
                g_rt->DrawText(bubText.c_str(), (UINT32)bubText.size(), g_fmt, rcMsg, brText,
                               D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
                g_rt->SetTransform(D2D1::Matrix3x2F::Identity());
            } else {
                // tip：静态带框气泡（扩展未启动提示）
                // 复位中心圆的缩放 transform，避免提示框随中心圆一起缩放
                g_rt->SetTransform(D2D1::Matrix3x2F::Identity());
                g_rt->FillRoundedRectangle(
                    D2D1::RoundedRect(D2D1::RectF(rcBub.left - 1.0f, rcBub.top - 1.0f,
                                                  rcBub.right + 1.0f, rcBub.bottom + 1.0f),
                                      8.0f, 8.0f),
                    brFill);
                g_rt->DrawRoundedRectangle(D2D1::RoundedRect(rcBub, 8.0f, 8.0f), brAccent, 1.5f);
                D2D1_RECT_F rcTip = D2D1::RectF(rcBub.left + 12.0f, rcBub.top,
                                               rcBub.right - 12.0f, rcBub.bottom);
                g_rt->DrawText(bubText.c_str(), (UINT32)bubText.size(), g_fmt, rcTip, brText,
                               D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
            }
        }
        }   // 闭合 if (!(execDispersing && disperseAlpha <= 0.0))

        // 关闭 disperseLayer：其他弧段+中心圆随 opacity 渐隐完成
        if (disperseLayer) {
            g_rt->PopLayer();
            disperseLayer->Release();
        }

        // 被点击弧段单独绘制（保持不透明，仅按下反馈缩放）
        if (execDispersing && g_pressIdx >= 0 && g_pressIdx < kLayout.segCount) {
            double pScale = 1.0 - 0.06 * easeOutCubic(pressT);
            if (pScale < 0.001) pScale = 0.001;
            g_rt->SetTransform(D2D1::Matrix3x2F::Scale((float)pScale, (float)pScale,
                                                       D2D1::Point2F((float)kCx, (float)kCy)));
            double a1 = segmentStart(g_pressIdx);
            double a2 = a1 + segmentSpan(g_pressIdx);
            ID2D1PathGeometry* geo = nullptr;
            ID2D1GeometrySink* sink = nullptr;
            // 几何/sink 创建失败（内存耗尽）跳过被点击弧段绘制（空指针解引用会崩）
            if (SUCCEEDED(g_factory->CreatePathGeometry(&geo)) && geo &&
                SUCCEEDED(geo->Open(&sink)) && sink) {
                addSegment(sink, a1, a2);
                sink->Close();
                sink->Release();
                g_rt->FillGeometry(geo, brFillSel);
                g_rt->DrawGeometry(geo, brFillSel, 1.0f);
                g_rt->DrawGeometry(geo, brBorderDim, 1.5f);
            }
            if (geo) geo->Release();
            double mid = a1 + segmentSpan(g_pressIdx) / 2.0;
            double lx, ly;
            hotbox::polarToXY(kCx, kCy, (kRIn + kROut) / 2.0, mid, &lx, &ly);
            std::wstring label;
            if ((size_t)g_pressIdx < g_entries.size() &&
                g_entries[g_pressIdx].kind == GestureEntry::kItem) {
                const data::Item& it = g_entries[g_pressIdx].item;
                label = std::wstring(iconFor(it.type)) + L" " + utf8ToWide(it.name);
            }
            if (!label.empty()) {
                double lw = segmentLabelWidth(g_pressIdx) / 2.0;
                // 与弧段标签同口径：非中文先降字号，zh 固定 g_fmt
                IDWriteTextFormat* labelFmt = arcLabelFormat(label, lw * 2.0);
                if (labelFmt == g_fmt || !labelFits(label, (float)(lw * 2.0), labelFmt))
                    label = fitLabel(label, lw * 2.0, labelFmt);
                D2D1_RECT_F rcText = D2D1::RectF((FLOAT)(lx - lw), (FLOAT)(ly - 14),
                                                (FLOAT)(lx + lw), (FLOAT)(ly + 14));
                g_rt->DrawText(label.c_str(), (UINT32)label.size(), labelFmt, rcText, brAccent,
                               D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
            }
        }

        // 合成预览图子菜单：三花瓣（左上/正上/右上）逐瓣 30ms 级联弹出
        if (g_capMenu) {
            ULONGLONG nowMs = GetTickCount64();
            for (int k = 0; k < 3; ++k) {
                // 逐瓣 30ms 级联延迟（浮点计算：旧整数表达式在未轮到时会下溢成
                // 巨大无符号数，clamp01 反而钳到 1，延迟从未生效）
                double t = clamp01(((double)nowMs - (double)g_capOpenMs - k * 30.0) / kCapAnimMs);
                if (t <= 0.0) continue;   // 未轮到该瓣
                double pScale = easeOutBack(t);
                // 按压反馈：按下中的花瓣压入 6%（与主环弧段按压观感一致）
                if (g_capPress == k) {
                    double pt2 = clamp01((double)(nowMs - g_pressStartMs) / kPressMs);
                    pScale *= 1.0 - 0.06 * easeOutCubic(pt2);
                }
                if (pScale < 0.001) pScale = 0.001;
                double mid = kCapPetalMid[k];
                double px = 0.0, py = 0.0;
                hotbox::polarToXY(kCx, kCy, (kCapRIn + kCapROut) / 2.0, mid, &px, &py);
                g_rt->SetTransform(D2D1::Matrix3x2F::Scale((float)pScale, (float)pScale,
                                                            D2D1::Point2F((float)px, (float)py)));
                double a1 = mid - kCapPetalSpan / 2.0, a2 = mid + kCapPetalSpan / 2.0;
                ID2D1PathGeometry* geo = nullptr;
                ID2D1GeometrySink* sink = nullptr;
                // 几何/sink 创建失败（内存耗尽）跳过该花瓣（空指针解引用会崩）
                if (FAILED(g_factory->CreatePathGeometry(&geo)) || !geo) continue;
                if (FAILED(geo->Open(&sink)) || !sink) { geo->Release(); continue; }
                addSegmentGeo(sink, a1, a2, kCx, kCy, kCapRIn, kCapROut, kCornerR);
                sink->Close();
                sink->Release();
                bool capAct = (k == g_capSel);
                if (capAct) {
                    // hover：金色填充 + 金色描边（与主环选中观感一致）
                    g_rt->FillGeometry(geo, brFillSel);
                    g_rt->DrawGeometry(geo, brFillSel, 1.0f);   // 垫边
                    g_rt->DrawGeometry(geo, brAccent, 1.5f);
                } else {
                    g_rt->FillGeometry(geo, brFill);
                    g_rt->DrawGeometry(geo, brFill, 1.0f);      // 垫边
                    g_rt->DrawGeometry(geo, brBorderDim, 1.0f);
                }
                geo->Release();
                // 标签共享花瓣变换：弹出/按压动画与花瓣同步缩放（与花瓣一体的观感）；
                // 小字号 g_fmtPetal（18° 花瓣截面窄，主体 12.5px 放不下三字名）
                std::wstring label = fitLabel(capLabel(k), capPetalLabelWidth(k), g_fmtPetal);
                double lw = capPetalLabelWidth(k) / 2.0;
                D2D1_RECT_F rcText = D2D1::RectF((FLOAT)(px - lw), (FLOAT)(py - 14),
                                                (FLOAT)(px + lw), (FLOAT)(py + 14));
                g_rt->DrawText(label.c_str(), (UINT32)label.size(), g_fmtPetal, rcText,
                               capAct ? brAccent : brText,
                               D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
            }
            g_rt->SetTransform(D2D1::Matrix3x2F::Identity());
        }

        // 失败提示：失败文案绘制在环心。中心圆本身只有放大镜
        // 图标、无文字承载位，故画一条不透明底条（同 g_msg 气泡风格：brFill 底 + 金色
        // 描边）覆盖其上，保证可读性；尺寸受内环半径 kRIn=62 约束（150×46 的角部仅轻微
        // 压到左右弧段内缘，绘制序在所有环体之后，不遮挡标签主体）。文案按环带宽度
        // 截断后交 g_fmtPetal（10px 居中，环心空间有限）自动换行，超出仍由 CLIP 兜底。
        if (g_failActive && !g_failMsg.empty()) {
            g_rt->SetTransform(D2D1::Matrix3x2F::Identity());
            const float fw = 150.0f, fh = 46.0f;
            D2D1_ROUNDED_RECT rcFail = D2D1::RoundedRect(
                D2D1::RectF((FLOAT)kCx - fw / 2, (FLOAT)kCy - fh / 2,
                            (FLOAT)kCx + fw / 2, (FLOAT)kCy + fh / 2), 8.0f, 8.0f);
            // 填充外扩 1px 垫边框抗锯齿外缘（同面板/气泡处理）
            g_rt->FillRoundedRectangle(
                D2D1::RoundedRect(D2D1::RectF(rcFail.rect.left - 1.0f, rcFail.rect.top - 1.0f,
                                              rcFail.rect.right + 1.0f, rcFail.rect.bottom + 1.0f),
                                  8.0f, 8.0f),
                brFill);
            g_rt->DrawRoundedRectangle(rcFail, brAccent, 1.5f);
            D2D1_RECT_F rcFailTxt = D2D1::RectF(rcFail.rect.left + 9.0f, rcFail.rect.top + 4.0f,
                                                rcFail.rect.right - 9.0f, rcFail.rect.bottom - 4.0f);
            IDWriteTextFormat* failFmt = g_fmtPetal ? g_fmtPetal : g_fmt;
            // 多行文本框：按像素宽度 + 可用高度截断（保留尽量多整行并补「…」）；
            // zh-CN 仍按原 40 字符口径
            std::wstring fail = truncateForWidth(utf8ToWide(g_failMsg), 40, failFmt,
                                                 rcFailTxt.right - rcFailTxt.left,
                                                 rcFailTxt.bottom - rcFailTxt.top);
            g_rt->DrawText(fail.c_str(), (UINT32)fail.size(), failFmt, rcFailTxt, brText,
                           D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
        }
    }

    g_rt->SetTransform(D2D1::Matrix3x2F::Identity());   // 复位动画缩放

    // 关闭整窗 fadeLayer（退场/设置入场渐隐）
    if (fadeLayer) {
        g_rt->PopLayer();
        fadeLayer->Release();
    }

    g_rt->EndDraw();
    brBorder->Release(); brFill->Release(); brFillSel->Release();
    brText->Release(); brMuted->Release(); brCenter->Release(); brRowHover->Release();
    brAccent->Release(); brEdge->Release(); brBorderDim->Release();

    // UpdateLayeredWindow 提交 per-pixel alpha 位图：从 WIC 位图拷到 DIB，再提交给系统
    if (g_wicBitmap && g_dib && g_dibBits) {
        WICRect wr = { 0, 0, g_bmpW, g_bmpH };
        UINT stride = g_bmpW * 4;
        UINT bufSize = stride * g_bmpH;
        g_wicBitmap->CopyPixels(&wr, stride, bufSize, (BYTE*)g_dibBits);
        SIZE sz = { g_bmpW, g_bmpH };
        POINT ptZero = { 0, 0 };
        BLENDFUNCTION bf = {};
        bf.BlendOp = AC_SRC_OVER;
        bf.SourceConstantAlpha = 255;
        bf.AlphaFormat = AC_SRC_ALPHA;
        HGDIOBJ old = SelectObject(g_memDC, g_dib);
        UpdateLayeredWindow(hwnd, nullptr, nullptr, &sz, g_memDC, &ptZero, 0, &bf, ULW_ALPHA);
        SelectObject(g_memDC, old);
    }

    // ULW 后强制 EDIT 重绘：UpdateLayeredWindow 提交的位图会覆盖子窗口之前的绘制，
    // EDIT 是原生子窗口（不随 D2D 渲染），需要重新绘制以叠加在 ULW 位图之上，
    // 否则文字和光标被 D2D 位图盖住不可见。RDW_UPDATENOW 同步发送 WM_PAINT 立即重绘
    if (g_edit && IsWindowVisible(g_edit)) {
        RedrawWindow(g_edit, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW);
    }
}

// 方向选择：按"鼠标相对环心的方向角"命中弧段（无距离上限，鼠标移出 UI 范围仍选中）。
// 仅排除中心圆与弧段之间的空隙（dist < kRIn）：那里不触发选中，避免移向弧段时误高亮
int hitSegmentAt(POINT ptClient) {
    double dx = ptClient.x - kCx, dy = ptClient.y - kCy;
    if (dx * dx + dy * dy < kRIn * kRIn) return -1;   // 空隙（中心圆到内弧之间）
    double ang = std::atan2(dy, dx) * 180.0 / hotbox::kPi;
    for (int i = 0; i < kSegmentCount; ++i) {
        double s = segmentStart(i), sp = segmentSpan(i);
        double d = hotbox::angleDelta(s, ang);
        if (d >= 0.0 && d <= sp) return i;
    }
    return -1;
}

bool inCenter(POINT ptClient) {
    double dx = ptClient.x - kCx, dy = ptClient.y - kCy;
    return (dx * dx + dy * dy) <= kCenterR * kCenterR;
}

// 松手停留态的点选域上界：环带外（r > kROut）的透明区不作弧段命中——视同空洞/间隙，
// 点击即关闭（见 LBUTTONUP 空白区分支）。按住手势保持原口径：命中域无外径上限，
// 沿弧段角度方向松手即执行该弧段（松手方向跟踪的既有语义，不改）
bool beyondRingBand(POINT ptClient) {
    double dx = ptClient.x - kCx, dy = ptClient.y - kCy;
    return dx * dx + dy * dy > kROut * kROut;
}

// 花瓣子菜单环带外（r > kCapROut）：花瓣展开时停留态点击关闭的判据。用花瓣外径而非
// 环带外径——花瓣环带内（含瓣间 2° 缝）属子菜单自己的地盘，瞄准花瓣差 2° 不该把浮窗关掉
bool beyondPetalBand(POINT ptClient) {
    double dx = ptClient.x - kCx, dy = ptClient.y - kCy;
    return dx * dx + dy * dy > kCapROut * kCapROut;
}

// —— 本地文件工具：数据/配置/最近使用全部直读直写（不依赖 bridge/扩展面板）——
// 文件流必须用宽路径打开（utf8ToWide → filesystem::path）：窄 char* 路径在
// Windows 按 ANSI 代码页（中文系统 GBK）解释，而本项目路径统一 UTF-8，
// 含中文的路径（脚本目录/用户名）会被误读成乱码路径 → 打开失败
bool fsReadText(const std::string& path, std::string* out) {
    std::ifstream f(std::filesystem::path(utf8ToWide(path)), std::ios::binary);
    if (!f) return false;
    out->assign((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    return true;
}

// 写文本文件；父目录不存在时逐级创建（%APPDATA%\...\hotbox 首次写入时可能没有）
// 原子写——先写 path+".tmp" 再 MoveFileExW(REPLACE_EXISTING) 原子替换。
// 旧 truncate 直写在写盘中断（进程崩溃/断电）会留下半截 JSON：config.json 损坏
// 叠加读侧防线拒重建 → 槽位绑定被锁死；recent.json 损坏 → 最近使用静默
// 清空。tmp 写入失败或替换失败均删除 .tmp 并返回 false（调用方已有失败提示路径）。
bool fsWriteText(const std::string& path, const std::string& content) {
    std::wstring wdir = utf8ToWide(path);
    size_t pos = wdir.find_last_of(L"\\/");
    if (pos != std::wstring::npos) wdir = wdir.substr(0, pos);
    std::wstring cur;
    size_t i = 0;
    if (wdir.size() >= 2 && wdir[1] == L':') { cur = wdir.substr(0, 2); i = 2; }  // 盘符 C:
    for (; i < wdir.size(); ++i) {
        if (wdir[i] == L'\\' || wdir[i] == L'/') {
            if (!cur.empty()) CreateDirectoryW(cur.c_str(), nullptr);  // 已存在返回 ERROR_ALREADY_EXISTS，无害
        }
        cur += wdir[i];
    }
    if (!cur.empty()) CreateDirectoryW(cur.c_str(), nullptr);
    const std::wstring wfinal = utf8ToWide(path);
    const std::wstring wtmp = wfinal + L".tmp";   // 与目标同目录，保证同一卷上可原子替换
    {
        std::ofstream f(std::filesystem::path(wtmp), std::ios::binary | std::ios::trunc);
        if (!f) return false;
        f.write(content.data(), (std::streamsize)content.size());
        if (!f) {
            f.close();
            DeleteFileW(wtmp.c_str());
            return false;
        }
        // 显式 close 并检查——write 成功后数据可能仍滞留 filebuf 缓冲，
        // 磁盘满/配额瞬态的 flush 错误只在 close 时暴露（析构隐式 close 的错误位无人
        // 检查，会把半截 .tmp 当成功送进原子替换）。close 后 failbit 保留可查询
        f.close();
        if (!f) {
            DeleteFileW(wtmp.c_str());
            return false;
        }
    }
    if (!MoveFileExW(wtmp.c_str(), wfinal.c_str(), MOVEFILE_REPLACE_EXISTING)) {
        DeleteFileW(wtmp.c_str());
        return false;
    }
    return true;
}

// 文件存在性检查：区分「config.json 不存在（首次使用，可从空配置构建）」与
// 「存在但读不出（杀软锁文件/同步盘占位，须拒绝整包重建防清空既有绑定）」
bool fileExists(const std::string& utf8Path) {
    DWORD attr = GetFileAttributesW(utf8ToWide(utf8Path).c_str());
    return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

// 读 config.json 并校验可解析，作为 setSlot/setHotkey 整包重建前的读侧防线。
// 读失败或读到半截/损坏 JSON 时 parseConfig 会折叠为空 Config，随后的整包写回会把
// 既有 slots 绑定全部清空（配置静默丢失且无提示）——此 helper 让调用方拒绝重建。
// 文件不存在 / 0 字节返回 true：无数据可丢，允许从空配置构建。
bool readConfigSafe(const std::string& path, std::string* out) {
    if (!fsReadText(path, out)) return !fileExists(path);
    if (out->empty()) return true;
    json::Value probe;
    return json::parse(out->c_str(), out->size(), &probe);
}

// —— 最近使用：加载 / 记录 / 持久化（hotbox/recent.json）——
std::string hotboxDataPath(const std::string& file) {
    std::string dir = data::defaultDataDir();
    return dir.empty() ? "" : dir + "\\hotbox\\" + file;
}

// script/preset 的 key 在**持久化边界**做「数据根相对 ↔ 绝对」
// 转换——内存/枚举/去重/执行全链始终是绝对路径。config.json 写盘统一过本函数
// （已是绝对形态的 key 借此一次性归位，否则换数据目录后老槽位仍指向旧根）。
std::string configTextForWrite(const std::string& text) {
    return config::normalizeSlotKeys(text, data::defaultDataDir());
}
// 读侧：把 Item 列表里的相对 key 还原成绝对（root 不可用/已是绝对 → 原样）
void resolveItemKeys(std::vector<data::Item>& items) {
    std::string root = data::defaultDataDir();
    for (auto& it : items) {
        if (it.type == "script" || it.type == "preset") it.key = data::fromRelKey(root, it.key);
    }
}
// 读侧（槽位形态）：SlotConfig 里的 item.key 同口径还原（只动 script/preset）
void resolveSlotKeys(std::vector<config::SlotConfig>& slots) {
    std::string root = data::defaultDataDir();
    for (auto& s : slots) {
        if (s.fixed && (s.item.type == "script" || s.item.type == "preset"))
            s.item.key = data::fromRelKey(root, s.item.key);
    }
}

void loadRecent() {
    g_recentLoaded = true;
    std::string p = hotboxDataPath("recent.json");
    if (p.empty()) return;
    std::string content;
    if (!fsReadText(p, &content)) return;
    // 内容非空但 JSON 解析失败（写盘中断留下的半截文件等）不再纯静默
    // 清空——备份保留损坏文件供人工恢复并记录告警，随后按空记录继续
    if (!content.empty()) {
        json::Value probe;
        if (!json::parse(content.c_str(), content.size(), &probe)) {
            const bool backed = CopyFileW(utf8ToWide(p).c_str(),
                                          utf8ToWide(p + ".corrupt.bak").c_str(),
                                          FALSE) != 0;   // FALSE：覆盖旧 .bak
            hotbox_log(backed
                ? "hotbox: recent.json corrupt (JSON parse failed), backed up to recent.json.corrupt.bak, recent list reset"
                : "hotbox: recent.json corrupt (JSON parse failed, backup failed), recent list reset");
        }
    }
    g_recent = config::parseRecent(content);
    // 读侧同样截断：手改/旧数据/异常写入的 recent.json 可能超上限，否则空查询列表会超出「最多 N 条」
    if (g_recent.size() > kRecentMax) g_recent.resize(kRecentMax);
    resolveItemKeys(g_recent);   // 相对 key → 绝对（内存恒绝对）
}

void saveRecent() {
    std::string p = hotboxDataPath("recent.json");
    if (p.empty()) return;
    // 落盘形态 = 数据根相对路径（内存里保持绝对；旧绝对 key 写一次即归位）
    std::vector<data::Item> out;
    out.reserve(g_recent.size());
    std::string root = data::defaultDataDir();
    for (const auto& it : g_recent) {
        data::Item c = it;
        if (c.type == "script" || c.type == "preset") c.key = data::toRelKey(root, c.key);
        out.push_back(std::move(c));
    }
    fsWriteText(p, config::buildRecent(out));   // 本地直写：不依赖 bridge
}

void recordRecent(const data::Item& it) {
    if (!g_recentLoaded) loadRecent();
    g_recent = config::pushRecent(g_recent, it, kRecentMax);
    saveRecent();
}

// —— 手势环槽位：加载固定槽配置（config.json gesture.slots）——
void loadSlotConfig() {
    std::string p = hotboxDataPath("config.json");
    if (p.empty()) return;
    std::string content;
    if (!fsReadText(p, &content)) return;
    // 内容非空但 JSON 解析失败（写盘中断留下的半截文件等）不再纯静默
    // 折叠为空槽——备份保留损坏文件供人工恢复并记录告警，随后继续空槽行为
    if (!content.empty()) {
        json::Value probe;
        if (!json::parse(content.c_str(), content.size(), &probe)) {
            const bool backed = CopyFileW(utf8ToWide(p).c_str(),
                                          utf8ToWide(p + ".corrupt.bak").c_str(),
                                          FALSE) != 0;   // FALSE：覆盖旧 .bak
            if (backed) {
                // 备份成功后删除损坏原件——否则 readConfigSafe 对该原件
                // 恒 false（文件存在但解析失败），setSlot/setHotkey 的整包重建被
                // 永久拒绝，槽位绑定/热键录制锁死，唯一出路是手工删除 config.json。
                // 备份已保全数据，删除原件让 readConfigSafe 走 fileExists=false
                // 分支（允许从空配置构建），与 JS 侧 的
                // 「备份→空态→可重建覆盖」语义一致
                DeleteFileW(utf8ToWide(p).c_str());
                hotbox_log("hotbox: config.json corrupt (JSON parse failed), backed up to "
                           "config.json.corrupt.bak, original removed, slots reset (rebuild on next bind)");
            } else {
                // 备份失败：原件是数据唯一载体，不能删——绑定锁死但数据可手工抢救
                hotbox_log("hotbox: config.json corrupt (JSON parse failed, backup failed), slots reset");
            }
        }
    }
    g_slots = config::parseSlots(content, (size_t)kSegmentCount);
    resolveSlotKeys(g_slots);   // 相对 key → 绝对（匹配/执行链全用绝对）
    g_releaseExecute = config::parseReleaseExecute(content);
    g_releaseStay = config::parseReleaseStay(content);
}

// 类别入口显示名 / 图标
std::string categoryName(const std::string& t) {
    if (t == "effect") return Tr(S_HOTBOX_WINDOW_TYPE_EFFECT);
    if (t == "script") return Tr(S_HOTBOX_WINDOW_TYPE_SCRIPT);
    if (t == "preset") return Tr(S_HOTBOX_WINDOW_TYPE_PRESET);
    return Tr(S_HOTBOX_WINDOW_TYPE_ALL);
}

// 解析 6 弧段内容：正下方（kSettingsSlot）恒为设置入口；正上方（kCaptureSlot）恒为
// 截图入口（不加载槽位绑定，config 中 arc0 旧绑定成为无害残留）；其余固定槽 → 功能项；
// 动态槽 → 依次取最近使用（跳过已固定项，防同项在环上出现两次）；耗尽 → 类别入口
void resolveGestureEntries() {
    g_entries.assign((size_t)kSegmentCount, GestureEntry{});
    static const char* kCats[] = { "effect", "script", "preset", "all" };
    auto isFixedItem = [&](const data::Item& it) {
        for (const auto& s : g_slots)
            if (s.fixed && s.item.type == it.type && s.item.key == it.key) return true;
        return false;
    };
    size_t ri = 0, ci = 0;
    for (int i = 0; i < kSegmentCount; ++i) {
        if (i == kSettingsSlot) {
            g_entries[i].kind = GestureEntry::kSettings;
        } else if (i == kCaptureSlot) {
            g_entries[i].kind = GestureEntry::kCapture;
        } else if (i < (int)g_slots.size() && g_slots[i].fixed) {
            g_entries[i].kind = GestureEntry::kItem;
            g_entries[i].item = g_slots[i].item;
        } else {
            while (ri < g_recent.size() && isFixedItem(g_recent[ri])) ++ri;
            if (ri < g_recent.size()) {
                g_entries[i].kind = GestureEntry::kItem;
                g_entries[i].item = g_recent[ri++];
            } else {
                g_entries[i].kind = GestureEntry::kCategory;
                g_entries[i].catType = kCats[ci % 4];
                ++ci;
            }
        }
    }
}

// 宽字符串截断（DirectWrite 显示用）
std::wstring truncateW(const std::wstring& s, size_t maxChars) {
    if (s.size() <= maxChars) return s;
    return s.substr(0, maxChars - 1) + L"…";
}

// 文本布局是否放得进给定区域：maxHeight <= 0 用单行自然宽度判据（不换行）；
// maxHeight > 0 用按 maxWidth 换行后的布局高度判据（多行文本框）。测量通道不可用返回 false。
bool textFits(const std::wstring& text, IDWriteTextFormat* fmt, float maxWidth, float maxHeight) {
    if (!g_dw || !fmt) return false;
    if (maxHeight <= 0.0f) return measureTextW(text, fmt, 8192.0f) <= maxWidth;
    IDWriteTextLayout* layout = nullptr;
    if (FAILED(g_dw->CreateTextLayout(text.c_str(), (UINT32)text.size(), fmt, maxWidth, 4096.0f,
                                      &layout)) || !layout)
        return false;
    DWRITE_TEXT_METRICS metrics = {};
    bool fits = false;
    if (SUCCEEDED(layout->GetMetrics(&metrics))) fits = metrics.height <= maxHeight;
    layout->Release();
    return fits;
}

// 按像素宽度截断文本（末尾补「…」）：二分找最大可容纳前缀。
// maxHeight <= 0 按单行宽度判据；> 0 按换行后的布局高度判据（多行文本框保留尽量多整行）。
// 拉丁/西里尔文本优先回退到最近的空格，避免把整句截在半个单词上；代理对不切断。
std::wstring truncateToWidth(const std::wstring& s, IDWriteTextFormat* fmt, float maxWidth,
                             float maxHeight) {
    if (s.empty() || !g_dw || !fmt || maxWidth <= 0.0f) return s;
    const std::wstring ellipsis = L"…";
    if (textFits(s, fmt, maxWidth, maxHeight)) return s;
    size_t lo = 0, hi = s.size();
    while (lo < hi) {
        const size_t mid = (lo + hi + 1) / 2;   // 偏上取：找最大可容纳前缀
        if (textFits(s.substr(0, mid) + ellipsis, fmt, maxWidth, maxHeight)) lo = mid;
        else hi = mid - 1;
    }
    // 词边界回退只对以空格分词的语言生效（ja/ko 的空格是西文分隔，按空格回退会丢掉半句）；
    // 且回退不得砍掉超过 1/4 的内容——否则宁可字符级截断也不牺牲信息量。
    const int locale = i18n::localeIndex();
    if (locale != i18n::kLocaleJaJP && locale != i18n::kLocaleKoKR) {
        const size_t space = (lo > 0) ? s.rfind(L' ', lo - 1) : std::wstring::npos;
        if (space != std::wstring::npos && space > 0 && space * 4 >= lo * 3) lo = space;
    }
    while (lo > 0 && s[lo - 1] >= 0xD800 && s[lo - 1] <= 0xDBFF) --lo;   // 不切半个代理对
    if (lo == 0) return ellipsis;
    return s.substr(0, lo) + ellipsis;
}

// 截断口径按语言分流：zh-CN 沿用按字符数截断（中文输出与改造前逐字一致）；
// 其余语言按像素宽度——拉丁/西里尔长句不会只剩前 N 个字符。
std::wstring truncateForWidth(const std::wstring& s, size_t zhMaxChars, IDWriteTextFormat* fmt,
                              float maxWidth, float maxHeight) {
    if (i18n::localeIndex() == i18n::kLocaleZhCN) return truncateW(s, zhMaxChars);
    return truncateToWidth(s, fmt, maxWidth, maxHeight);
}

// —— AE 预设目录定位（预设双源里的「AE 侧」；扩展库走索引文件，不在此列）——
// 安装根优先原生推导（插件模块路径 <AE>\Support Files\Plug-ins\... → <AE>），失败才问 AE
// （app.path，与扩展 ae-tools getInstallPath 的 S1 同源——覆盖插件被装在 MediaCore 等处的场景）。
// 成功即进程内缓存：模块路径与 app.path 在会话内都不变，而本函数在每次弹出的数据源签名里
// 都要跑。失败留重试预算（首次可能是 JS 引擎尚未就绪），用尽后不再尝试——否则每次弹出都要付
// 一次跨语言往返（把效果源改成 AEGP 原生枚举，正是为避开这类按键路径上的开销）。
static std::string g_aeRoot;
static bool g_aeRootResolved = false;
static int g_aeRootTries = 0;
static const int kAeRootRetryMax = 3;

static const std::string& aeInstallRoot() {
    if (g_aeRootResolved) return g_aeRoot;
    if (g_aeRootTries >= kAeRootRetryMax) { g_aeRootResolved = true; return g_aeRoot; }
    ++g_aeRootTries;
    std::string root = data::aeInstallRootFromModulePath(data::currentModulePath());
    const char* how = "module";
    if (root.empty()) {
        std::string out, err;
        if (aeexec_runScript("app.path ? String(app.path) : ''", &out, &err) && !out.empty()) {
            root = data::normalizeAeInstallRoot(out);
            how = "app.path";
        }
    }
    if (root.empty()) {
        hotbox_log(("ae install root unresolved (try " + std::to_string(g_aeRootTries) + "/" +
                    std::to_string(kAeRootRetryMax) + ")").c_str());
        return g_aeRoot;   // 未解析成功：本次按「无 AE 侧数据源」处理，保留重试预算
    }
    g_aeRoot = root;
    g_aeRootResolved = true;
    hotbox_log(("ae install root via " + std::string(how) + ": " + root).c_str());
    return g_aeRoot;
}

// AE 出厂预设目录（<AE>\Support Files\Presets，存在才返回）
static std::string aeStockPresetsRoot() {
    std::string d = data::aeStockPresetsDir(aeInstallRoot());
    return data::dirExists(d) ? d : std::string();
}

// AE 用户预设目录（Documents\Adobe\<AE 版本次目录>\User Presets，存在才返回）
static std::string aeUserPresetsRoot() {
    return data::userPresetsDir(data::aeUserPresetsSubdir(aeInstallRoot()));
}

// 预设的 AE 侧目录（用户预设 → 出厂预设；只含存在者，顺序即去重优先级）
static std::vector<std::string> aePresetRoots() {
    std::vector<std::string> roots;
    std::string user = aeUserPresetsRoot();
    if (!user.empty()) roots.push_back(user);
    std::string stock = aeStockPresetsRoot();
    if (!stock.empty()) roots.push_back(stock);
    return roots;
}

// ── 数据源签名（loadData 脏检查）；效果源改原生枚举 ——
// 把数据目录、AEGP 已安装效果数、presets\index.json、脚本目录树与两个 AE 预设目录树
// （出厂 + 用户预设）逐项（相对路径/最后写入时间/尺寸）混入 FNV-1a 64 位签名：内容修改 →
// 文件 mtime 变；新增/删除/改名 → 父目录 mtime 变，签名均失配。目录字符串参与签名：数据
// 目录切换、换 AE 安装后即使内容恰好同构也不误跳过（脚本/预设条目含 abs 路径）。
// 效果列表由 AEGP 原生枚举提供（无文件 mtime 可查），改用「已安装效果数」参与
// 签名：单次 AEGP 调用（微秒级），计数变化即 AE 插件集变化。AE 只在启动时扫描插件
// 目录，会话内该计数稳定，故与 mtime 口径等价。计数不可用（-1/0，AEGP 未就绪或
// 枚举失败）→ 返回 false「不可判定」，保持每次重载的兜底（避免缓存一份空/半截列表）。
// 签名本身只看计数；「枚举是否完整」由 loadData 以 data::effectEnumCacheable
// 把关——半截枚举/空列表不把签名记为有效，会话内保留重试。
static void sigMixBytes(ULONGLONG* h, const void* p, size_t n) {
    const unsigned char* b = (const unsigned char*)p;
    for (size_t i = 0; i < n; ++i) {
        *h ^= (ULONGLONG)b[i];
        *h *= 1099511628211ULL;   // FNV-1a 64 位素数
    }
}
static void sigMixFileTime(ULONGLONG* h, const FILETIME* ft, DWORD sizeLow, DWORD sizeHigh) {
    sigMixBytes(h, ft, sizeof(*ft));
    sigMixBytes(h, &sizeLow, sizeof(sizeLow));
    sigMixBytes(h, &sizeHigh, sizeof(sizeHigh));
}
// 脚本目录树签名：与 loadData 同口径遍历（跳过 . / .. 与重解析点防环，目录递归），
// 目录项也混入签名——子项增删/改名会更新父目录 mtime，删除场景由此检出。
// 同一个函数也用于 AE 预设目录（出厂 + 用户预设）
static void scriptTreeSig(ULONGLONG* h, const std::string& root) {
    if (root.empty()) return;   // 空根不得拼出 "\*"（防御：调用方应只传存在的目录）
    std::vector<std::string> pending = { root };
    for (size_t idx = 0; idx < pending.size(); ++idx) {
        std::wstring pattern = utf8ToWide(pending[idx]) + L"\\*";
        WIN32_FIND_DATAW fd;
        HANDLE hFind = FindFirstFileW(pattern.c_str(), &fd);
        if (hFind == INVALID_HANDLE_VALUE) continue;
        do {
            if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
            std::string fn = wideToUtf8(fd.cFileName);
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) continue;
            std::string rel = pending[idx] + "\\" + fn;
            sigMixBytes(h, rel.data(), rel.size());
            sigMixFileTime(h, &fd.ftLastWriteTime, fd.nFileSizeLow, fd.nFileSizeHigh);
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                pending.push_back(std::move(rel));
            }
        } while (FindNextFileW(hFind, &fd));
        FindClose(hFind);
    }
}
static bool computeDataSig(const std::string& dir, ULONGLONG* out) {
    ULONGLONG h = 14695981039346656037ULL;   // FNV-1a offset basis
    sigMixBytes(&h, dir.data(), dir.size());
    // 效果：原生枚举源的「已安装效果数」参与签名（取代原 effects_cache.json
    // mtime——该文件已降为枚举失败时的兜底）。-1（AEGP 不可用）与 0（无效果）都视为
    // 不可判定：此时无法区分「插件集真为空」与「枚举还没就绪」。
    int fxCount = aeexec_installedEffectCount();
    if (fxCount <= 0) return false;
    sigMixBytes(&h, &fxCount, sizeof(fxCount));
    // 预设索引：缺失 = 稳定空集（可判定）；存在则混入 mtime/尺寸
    WIN32_FILE_ATTRIBUTE_DATA fa = {};
    if (GetFileAttributesExW(utf8ToWide(dir + "\\assets\\presets\\index.json").c_str(),
                             GetFileExInfoStandard, &fa)) {
        sigMixFileTime(&h, &fa.ftLastWriteTime, fa.nFileSizeLow, fa.nFileSizeHigh);
    } else {
        sigMixBytes(&h, "<absent>", 8);   // 缺失标记：与任何存在状态区分
    }
    scriptTreeSig(&h, dir + "\\agent\\scripts");
    // AE 预设目录（用户预设 + 出厂预设）：与脚本同口径混入目录树，目录字符串本身也入签名
    // ——换 AE 安装/换用户目录后即使内容恰好同构也不误跳过（预设条目 key 含绝对路径）。
    // 目录缺失 = 稳定空集（aePresetRoots 只返回存在的目录，FindFirstFileW 失败即不混入），
    // 与「存在但为空」同签名：两者条目集都是空，无需区分。
    for (const std::string& r : aePresetRoots()) {
        sigMixBytes(&h, r.data(), r.size());
        scriptTreeSig(&h, r);
    }
    *out = h;
    return true;
}

// 加载全量数据（本地直读；失败静默，由状态行提示）
// 数据目录是本地路径，AEGP 与 AE 同进程直接文件访问——完全解耦扩展面板/bridge
void loadData() {
    // 数据源签名脏检查——showAt 每次弹出重置 g_dataLoaded，进搜索模式
    // 即全量重载数据并重建拼音索引（AE 主线程同步执行，条目多时呼出到可输入的卡顿每次
    // 重复支付）。数据源签名未变时跳过重载复用现有 g_items 与拼音索引；增删改任何
    // 数据源都会失配（见 computeDataSig）。 起效果源为 AEGP 原生枚举，签名用
    // 已安装效果数判定，故「无 effects_cache.json」不再等于不可判定——首次加载后，
    // 后续每次弹出命中签名直接复用（不再重复枚举）。不可判定（AEGP 未就绪）或首次
    // 加载走全量路径。签名在加载前计算：加载期间发生的写入会失配 → 下次自愈。
    std::string dir = data::defaultDataDir();
    ULONGLONG sig = 0;
    bool sigOk = !dir.empty() && computeDataSig(dir, &sig);
    if (sigOk && g_dataSigValid && sig == g_dataSig) {
        g_dataLoaded = true;   // 数据源未变：复用 g_items 与拼音索引
        return;
    }
    g_items.clear();   // 重载前清空（showAt 每次重置 g_dataLoaded → 可重复调用）
    if (dir.empty()) { g_dataLoaded = true; return; }
    auto readJson = [&](const std::string& path) -> std::string {
        std::string s;
        fsReadText(path, &s);
        return s;
    };
    // 效果：AEGP 原生枚举为主——AE 内存里的已安装效果表，与 Effects 菜单
    // 同源，无 I/O、无 ExtendScript 桥（app.effects 逐条建对象 ~40ms/条，扩展的
    // effects_cache.json 正是为绕开它而生成）。枚举为空（AEGP 未就绪/失败）时才回退
    // 扩展缓存：它是分批遍历的旧快照，且其中的分类字段热盒并不使用（UI 只显示 name、
    // 搜索只匹配 name），保留仅为原生路径不可用时的可用性兜底。
    std::vector<data::Item> fx;
    bool fxComplete = false;
    const int fxN = aeexec_enumerateEffects(fx, &fxComplete);
    if (fxN == 0) {
        fx = data::parseEffects(readJson(dir + "\\ae-tools\\effects_cache.json"));
    }
    // 半截枚举（AEGP_GetNextInstalledEffect 中途失败 break 返回部分
    // n>0）与「计数>0 但一条没取到」不得记为有效缓存——数据签名只含已安装效果
    // 数，部分枚举时计数不变，若记有效则会话内不再重算，用户一直看到残缺/空的
    // 效果列表。sigOk=false → 下次弹出重走全量加载（允许重试；本次仍用现有
    // 列表保可用性）。判据本体在 data::effectEnumCacheable（单测钉住）。
    if (!data::effectEnumCacheable(fxN, fxComplete)) sigOk = false;
    g_items.insert(g_items.end(), fx.begin(), fx.end());
    // 预设：三源合并去重（优先级 = 扩展库 > AE 用户预设 > AE 出厂预设）。
    // 扩展库：索引（assets/presets/index.json）——入库时 .ffx 被逐字节复制进数据目录；
    //        旧索引缺 size 时补查文件大小（去重键含字节数，见 data::presetDedupeKey）。
    // AE 侧：直读 AE 自己的预设目录（与 Effects & Presets 面板同源），只读不复制，
    //        应用走 layer.applyPreset(File)，与库内预设同一条路径。
    auto libPr = data::parsePresets(readJson(dir + "\\assets\\presets\\index.json"));
    data::fillItemSizes(libPr);
    std::vector<data::Item> userPr = data::scanPresetDir(aeUserPresetsRoot());
    std::vector<data::Item> stockPr = data::scanPresetDir(aeStockPresetsRoot());
    auto pr = data::mergePresetsDedup(libPr, data::mergePresetsDedup(userPr, stockPr));
    g_items.insert(g_items.end(), pr.begin(), pr.end());
    hotbox_log(("presets: lib=" + std::to_string(libPr.size()) +
                " ae_user=" + std::to_string(userPr.size()) +
                " ae_stock=" + std::to_string(stockPr.size()) +
                " merged=" + std::to_string(pr.size())).c_str());
    // 脚本：FindFirstFileW 递归枚举（仅收 .jsx/.jsxbin）
    std::vector<std::string> pending = { dir + "\\agent\\scripts" };
    std::string root = pending[0];
    for (size_t idx = 0; idx < pending.size(); ++idx) {
        std::wstring pattern = utf8ToWide(pending[idx]) + L"\\*";
        WIN32_FIND_DATAW fd;
        HANDLE h = FindFirstFileW(pattern.c_str(), &fd);
        if (h == INVALID_HANDLE_VALUE) continue;
        do {
            if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
            std::string fn = wideToUtf8(fd.cFileName);
            // 跳过 junction/符号链接（重解析点）：循环重解析点会使递归枚举的 pending
            // 无限增长，loadData 在 AE 主线程同步执行 → 永久假死（对齐 client 侧
            // quickBarScanner 的 DEPTH_MAX 防护意图）
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) continue;
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                pending.push_back(pending[idx] + "\\" + fn);
            } else if (data::isScriptFile(fn)) {
                std::string abs = pending[idx] + "\\" + fn;
                std::string rel = abs.size() > root.size() ? abs.substr(root.size() + 1) : "";
                g_items.push_back(data::makeScriptItem(fn, rel, abs));
            }
        } while (FindNextFileW(h, &fd));
        FindClose(h);
    }
    search::PinyinIndex::instance().rebuild(g_items);   // 拼音索引随数据重建（字典惰性资源加载）
    search::TypoIndex::instance().rebuild(g_items);     // 近似索引（手误容错）与数据同序重建
    g_dataSig = sig;          // 记录本次加载的签名（加载前计算值）
    g_dataSigValid = sigOk;   // 不可判定（AEGP 未就绪/效果数为 0）时不记录，保持每次重载
    g_dataLoaded = true;
}

// 重跑查询：空查询列出最近使用（按当前类型过滤，无记录则为空状态）；
// 有关键词时模糊匹配 + 最近使用优先，并收敛选中行与可视窗口。
// 查询词先裁首尾空白：EDIT 文本原样保留（绘制/光标定位用它），检索只认归一后的词——
// 空格态（只敲了空格）与空查询同口径，直接列最近使用。
void rerunQuery() {
    const std::string queryText = search::normalizeQuery(g_query);
    g_typoKeys.clear();
    g_filterHintCount = 0;
    if (queryText.empty()) {
        // 空查询：最近使用即默认列表（时间倒序，与环上动态槽同源）
        g_results = search::filterByType(g_recent, g_filterType);
        g_resultSel = 0;
        g_scrollTop = 0;
        if (g_mode == Mode::kSearch) updateSearchWindowSize();
        return;
    }
    g_results = search::query(g_items, g_filterType, queryText);
    if (g_results.empty()) {
        // 手误容错：精确/子序列/拼音都没命中时给最接近的几条（行首标 ≈，状态行点明近似）
        g_results = search::TypoIndex::instance().suggest(g_items, g_filterType, queryText,
                                                          kTypoMaxResults);
        for (const auto& it : g_results) g_typoKeys.insert(it.key);
        if (g_results.empty() && g_filterType != "all") {
            // 类型筛选把结果挡掉了：给「切到全部」的提示（条数按精确层算）
            g_filterHintCount = (int)search::query(g_items, "all", queryText).size();
        }
    } else {
        // 用过的（命中最近使用）前移到最前：输入变化后选中行归零（EN_CHANGE），
        // 排序即决定「打完字直接回车」执行哪条
        g_results = search::rankRecentFirst(g_results, g_recent);
    }
    if (g_resultSel >= (int)g_results.size()) g_resultSel = (int)g_results.size() - 1;
    if (g_resultSel < 0) g_resultSel = 0;
    ensureSelVisible();
    if (g_mode == Mode::kSearch) updateSearchWindowSize();   // 结果数变化 → 面板高度跟随
}

// 字母大小写归一：统一转小写后按 CapsLock XOR Shift 决定最终大小写——
// 尊重用户输入意图（开大写就预填大写）；Alt 键本身不影响大小写判定，
// MapVirtualKeyW 在 Alt 下返回大写的问题由"先归一化小写"规避
wchar_t applyCase(wchar_t ch) {
    if (ch >= L'A' && ch <= L'Z') ch = (wchar_t)(ch - L'A' + L'a');
    if (ch < L'a' || ch > L'z') return ch;   // 非字母不处理
    bool upper = ((GetKeyState(VK_CAPITAL) & 1) != 0) !=
                 ((GetKeyState(VK_SHIFT) & 0x8000) != 0);
    return upper ? (wchar_t)(ch - L'a' + L'A') : ch;
}

// 手势模式字母/数字键直达搜索（WM_KEYDOWN 与按住 Alt 的 WM_SYSKEYDOWN 共用）：
// 进入搜索模式并预填该字符，插入符置末尾（否则默认在开头，继续输入会插到前面）；
// 大小写按 CapsLock/Shift 状态（applyCase）；非可打印键（方向键/F 键等）忽略
void gestureKeyToSearch(int vk) {
    wchar_t ch = (wchar_t)MapVirtualKeyW((UINT)vk, MAPVK_VK_TO_CHAR);
    if (ch < 0x20 || ch == 0xFFFF) return;
    ch = applyCase(ch);
    enterSearchMode("");
    std::wstring s(1, ch);
    SetWindowTextW(g_edit, s.c_str());
    SendMessageW(g_edit, EM_SETSEL, (WPARAM)s.size(), (LPARAM)s.size());   // 光标置末尾
    g_query = wideToUtf8(s.c_str());
    rerunQuery();
}

// 功能项真实执行 + 关窗（成功记录最近使用；失败只记日志，仍关闭）。
// 在 executeSelected 按压动画播完后由 kExecTimer 调用；g_actionLock 已在 executeSelected 置位。
void doExecPendingItem() {
    int index = g_pendingExec;
    g_pendingExec = -1;
    // 不清 g_pressIdx / g_execDispersing：保持按压态与散开态直到 doHide()，
    // 让其他弧段在退场动画期间持续渐隐（g_execDispersing=true → segScale 按 pressT 渐隐到 0），
    // 避免按压态清除瞬间其他弧段从"渐隐到 0"跳回"完整显示"再被整窗 alpha 渐隐（一帧闪现）
    if (index < 0 || (size_t)index >= g_entries.size()) {
        g_actionLock = false;
        g_pressIdx = -1;
        g_execDispersing = false;
        return;
    }
    const GestureEntry& e = g_entries[index];
    std::string failMsg;
    bool deferred = false;
    if (execItem(e.item, &failMsg, &deferred)) {
        if (deferred) {
            // 预设批量：手势环转进度卡片（环心居中），完成后 batchFinish 收尾
            hotbox_log(("hotbox gesture preset batch start: " + e.item.name).c_str());
            enterProgressMode();
            return;
        }
        recordRecent(e.item);
        hotbox_log(("hotbox gesture exec ok: " + e.item.type + " " + e.item.name).c_str());
        // 保持锁至 doHide() 释放：退场动画期间拦截排队点击
        window_hide();
        return;
    }
    // 失败不立即渐隐退出——环心显示失败提示并停留
    // kFailDwellMs（原因同时写日志），到点由 kFailTimer 走既有退场流程；停留期由
    // g_actionLock 挡住重复执行，按热键重新召唤即立刻清提示并走正常召唤流程
    hotbox_log(("hotbox gesture exec fail: " + e.item.type + " " + e.item.name + " -> " + failMsg).c_str());
    enterFailDwell(std::string(Tr(S_HOTBOX_WINDOW_ERR_EXEC_FAILED_PREFIX)) + failMsg);
    return;
}

// 撤销待执行 kExecTimer（window_hide 语义提取为公共函数）——
// executeSelected 排定的 90ms（kPressMs）延迟执行在窗口退场（window_hide）或导航
// 转场（enterSearchMode/enterSettings）时已失去执行前提；不撤则定时器到点照发
// doExecPendingItem：把用户的取消/转场意图变成误执行，window_hide 还会摧毁刚
// 打开的搜索会话。守卫 g_pendingExec >= 0——正常执行流的 window_hide 由
// doExecPendingItem 在定时器触发并清 g_pendingExec 后调用，守卫恒为无操作，
// 不误杀正常执行的定时器。
static void cancelPendingExec() {
    if (g_pendingExec >= 0) {
        KillTimer(g_hwnd, kExecTimer);
        g_pendingExec = -1;
    }
}

// 清除失败提示驻留态与其计时器。任何「用户按热键召唤」的
// 入口（window_hotkeyPressed/window_showAt）第一步调用；doHide 收尾时也调用。
// 代际号自增使已入队/迟到的 WM_TIMER(kFailTimer) 失效（处理侧校验代际 + 已过时长），
// 保证旧提示的计时器绝不会在稍后把新召唤出的面板关掉。幂等，可在无驻留时安全调用。
static void cancelFailDwell() {
    if (g_hwnd) KillTimer(g_hwnd, kFailTimer);
    g_failGen++;          // 作废在途计时器语义
    g_failTimerGen = 0;   // 计时器不再武装
    g_failActive = false;
    g_failMsg.clear();
    g_failStartMs = 0;
}

// 进入失败提示驻留态（一级菜单执行失败 / 截图三动作失败共用）。
// 不再 window_hide()，而是恢复完整手势环（清执行散开态，环体重新可见），失败文案画在
// 环心（见 paint 手势分支末尾），停留 kFailDwellMs 后由 kFailTimer 走既有 window_hide
// 渐隐退场。停留期间沿用既有执行锁 g_actionLock=true：点击/松手/Enter 等执行入口全部
// 被锁守卫拦截（保留「失败不驻留」原意的最小改动——仅把「立即退场」换成「停留后按
// 既有流程退场」）；用户按热键重新召唤由 cancelFailDwell 立即清提示并走正常召唤流程。
static void enterFailDwell(const std::string& msg) {
    hotbox_log(("hotbox fail dwell: " + msg + " (" + std::to_string(kFailDwellMs) + "ms)").c_str());
    if (!g_hwnd || !g_visible) return;   // 隐藏态（异常路径）无面板可驻留，仅记日志
    // 恢复完整环体：执行散开（其他弧段/中心圆渐隐）与按压态一并复位，失败提示画在环心
    g_execDispersing = false;
    g_pressIdx = -1;
    g_failMsg = msg;
    g_failActive = true;
    g_failStartMs = GetTickCount64();
    g_failTimerGen = ++g_failGen;   // 本次驻留的计时器代际
    g_actionLock = true;   // 驻留期间保持锁：拒绝重复执行（既有锁语义）
    SetTimer(g_hwnd, kFailTimer, (UINT)kFailDwellMs, nullptr);
    InvalidateRect(g_hwnd, nullptr, FALSE);
}

// 手势环执行：功能项 → 播放按压动画后真实执行（成功记录最近使用并关窗，失败只记日志）；
// 类别入口 → 进入搜索模式并预过滤；设置入口 → 进设置面板。
// alreadyPressed：点击路径（DOWN 已在同段播按压动画）传 true——保留 DOWN 的动画起点
// 继续播完；重置起点会让弧段在松手瞬间弹回原尺寸再重新压入（视觉"弹一下"），
// 与松手执行路径的动画不一致。松手执行/键盘路径无既有按压，默认 false 从头播
void executeSelected(int index, bool alreadyPressed = false) {
    if (index < 0 || index >= kSegmentCount) return;
    if ((size_t)index >= g_entries.size()) return;
    const GestureEntry& e = g_entries[index];
    if (e.kind == GestureEntry::kSettings) {
        enterSettings();
        return;
    }
    if (e.kind == GestureEntry::kCategory) {
        enterSearchMode(e.catType);
        return;
    }
    if (e.kind == GestureEntry::kCapture) {
        // 截图弧段：子菜单由 MOUSEMOVE hover 截图弧段展开、花瓣完整点击执行，无"松手
        // 执行"语义；本分支为弧段点击/键盘路径的防御（热键松开路径已前置分流为退出）
        return;
    }
    // 防连点：执行锁定期（含退场动画、按压动画期间）拒绝新的执行
    if (g_actionLock) return;
    g_actionLock = true;
    // 按压动画：设置 pressIdx 后延迟执行，让反馈可见；alreadyPressed 时保留 DOWN 的
    // 起点继续播（UP 已清 pressIdx，此处恢复；起点不重置 → 无"弹一下"跳变）
    if (!alreadyPressed) g_pressStartMs = GetTickCount64();
    g_pressIdx = index;
    g_pendingExec = index;
    g_execDispersing = true;   // 确认执行：其他弧段开始渐隐（区别于 WM_LBUTTONDOWN 的按下反馈）
    InvalidateRect(g_hwnd, nullptr, FALSE);
    // 时间驱动的压入动画需定时器持续重绘
    if (g_animDir == 0) SetTimer(g_hwnd, kAnimTimer, animTimerMs(), nullptr);
    // 一次性定时器：kPressMs 后触发真实执行（按压动画播完）
    SetTimer(g_hwnd, kExecTimer, (UINT)kPressMs, nullptr);
}

// 合成预览图：执行三动作（k=0 PNG / k=1 剪切板 / k=2 JPG，与 capLabel 对应）。
// 渲染同步阻塞 AE 主线程（SDK 允许的"用户显式请求"场景；>2s AE 自动弹进度框可取消）。
// 剪切板保留 alpha（透明通道只能靠剪切板里的 PNG 格式送达消费者）；两个保存动作仍按
// 合成背景色拼合，观感与合成视图一致。
// 成功路径不变：直接渐隐关窗（msg 记日志）；失败走失败提示驻留态——与一级菜单
// 执行失败同一反馈（环心提示 + 停留 kFailDwellMs 再退场），不再失败也立即渐隐。
static void executeCapture(int k) {
    if (g_actionLock) return;
    g_actionLock = true;
    g_pinned = true;
    // 渲染 + 保存对话框全程豁免失活自动隐藏（对话框抢激活 → WA_INACTIVE
    // → 50ms 后判定关窗；关窗后失败提示 enterFailDwell 在 !g_visible 直接 return，
    // 用户零回执）。动作返回即清：成功走既有 window_hide、失败走可见态驻留。
    g_capturing = true;
    capture::Frame frame;
    std::string msg, err;
    bool ok = capture::renderActiveComp(&frame, &err, k == 1);
    if (ok) {
        if (k == 0) ok = capture::saveAsPng(frame, g_hwnd, &msg, &err);
        else if (k == 1) ok = capture::copyToClipboard(frame, &msg, &err);
        else ok = capture::saveAsJpg(frame, g_hwnd, &msg, &err);
    }
    g_capturing = false;   // 动作已返回（对话框已关）：恢复常规失活判定
    hotbox_log(("hotbox capture k=" + std::to_string(k) + " ok=" +
                (ok ? "1" : "0") + " " + (ok ? msg : err)).c_str());
    if (!ok) {
        const StrId failId = (k == 1) ? S_HOTBOX_WINDOW_ERR_CLIPBOARD_FAILED_PREFIX
                                      : S_HOTBOX_WINDOW_ERR_SAVE_IMAGE_FAILED_PREFIX;
        const std::string reason = err.empty() ? Tr(S_HOTBOX_WINDOW_ERR_UNKNOWN_REASON) : err;
        enterFailDwell(std::string(Tr(failId)) + reason);
        return;
    }
    window_hide();
}

// 预检 host.jsx 执行函数（applyEffectToSelectedLayers/runScriptSandboxed/
// applyPresetToSelectedLayers）是否可用；
// 不可用时自愈（evalFile 安装目录的 presetApi/effectApi/scriptRunner/json2）。可用返回 true。
// errHint 输出不可用原因（供状态行展示）。
// 会话级缓存：probe 成功后不再重复检测（否则每次执行都多一次往返 → 一级菜单加效果明显延迟）
// 失败不再永久锁死——s_checked 一次探测失败后整个 AE 会话恒报
// 「执行通道未就绪」，此后用户打开扩展面板（main.js 已 evalFile host.jsx，执行
// 函数实际已就绪）也无法自愈，唯一出路是重启 AE。改为仅成功缓存，失败按 ≥2s
// 节流重试（面板打开后下一次执行即恢复）；成功路径的「一次往返」缓存语义不变。
bool hostApiReady(std::string* errHint) {
    static bool s_ready = false;
    static ULONGLONG s_lastFailMs = 0;
    if (s_ready) return true;
    ULONGLONG nowMs = GetTickCount64();
    if (s_lastFailMs != 0 && nowMs - s_lastFailMs < 2000) {
        if (errHint) *errHint = Tr(S_HOTBOX_WINDOW_ERR_EXEC_CHANNEL_NOT_READY);
        return false;
    }
    std::string probe = "var __t=''+(typeof applyEffectToSelectedLayers)+'|'+(typeof runScriptSandboxed)+'|'+(typeof applyPresetToSelectedLayers)+'|'+(typeof getProjectState)+'|'+(typeof JSON);__t;";
    std::string pr;
    bool ready = false;
    if (aeexec_runScript(probe, &pr)) {
        hotbox_log(("hotbox func probe: " + pr).c_str());
        // probe 输出五字段：A|B|preset|getProjectState|JSON。getProjectState 定义在
        // projectAssetApi.jsx（不在自愈加载清单），恒为 undefined——只要求
        // A、B、preset 为 function 且 JSON 已加载（object）即可判 ready。
        // preset（applyPresetToSelectedLayers）漏检会让预设执行报 ReferenceError
        //（效果/脚本正常、唯独预设不可用的假就绪态）。
        if (pr.compare(0, 27, "function|function|function|") == 0 &&
            pr.find("|object") != std::string::npos) ready = true;
    }
    if (!ready) {
        // 自愈：常见安装目录逐个尝试 evalFile（面板未开 / host.jsx 未加载新模块时兜底）
        // 必须先加载 json2.jsx（ExtendScript 无原生 JSON，effectApi 的 JSON.stringify 依赖它），
        // 否则自愈后执行效果会在 JSON 处 ReferenceError → AE 弹"无法执行脚本"。
        // 自愈探测目录：系统级 Program Files 安装 + 用户级 %APPDATA% 安装（本项目
        // 默认安装位置，与 data.cpp defaultDataDir 的默认根一致）。用户级路径必须
        // 动态展开（_wgetenv 取宽串防中文用户名 ANSI 乱码），不硬编码绝对路径
        std::vector<std::string> hostApiDirs = {
            "C:/Program Files (x86)/Common Files/Adobe/CEP/extensions/AS_ExtP/host/api/",
            "C:/Program Files/Common Files/Adobe/CEP/extensions/AS_ExtP/host/api/"
        };
        if (const wchar_t* wappdata = _wgetenv(L"APPDATA"); wappdata && *wappdata) {
            hostApiDirs.push_back(wideToUtf8(wappdata) +
                                  "/Adobe/CEP/extensions/AS_ExtP/host/api/");
        }
        for (const std::string& dir : hostApiDirs) {
            std::string load =
                "var __r='';" "try{$.evalFile(" + json::buildString(dir + "json2.jsx") + ");}catch(e){__r+='E0:'+e+';';}" +
                "try{$.evalFile(" + json::buildString(dir + "presetApi.jsx") + ");}catch(e){__r+='E1:'+e+';';}" +
                "try{$.evalFile(" + json::buildString(dir + "effectApi.jsx") + ");}catch(e){__r+='E2:'+e+';';}" +
                "try{$.evalFile(" + json::buildString(dir + "scriptRunner.jsx") + ");}catch(e){__r+='E3:'+e+';';}" "'after:'+(typeof applyEffectToSelectedLayers)+'|'+(typeof runScriptSandboxed)+'|'+(typeof applyPresetToSelectedLayers)+'|'+(typeof JSON)+'|'+__r;";
            std::string r2;
            if (aeexec_runScript(load, &r2)) {
                hotbox_log(("hotbox self-load: " + r2).c_str());
                // self-load 输出：after:function|function|function|<typeof JSON>|__r，
                // 第四字段是 typeof JSON——object 表示 json2.jsx 已加载。
                if (r2.compare(0, 33, "after:function|function|function|") == 0 &&
                    r2.find("|object") != std::string::npos) {
                    ready = true;
                    break;
                }
            }
        }
    }
    if (!ready && errHint) {
        if (pr.empty()) *errHint = Tr(S_HOTBOX_WINDOW_ERR_EXECSCRIPT_UNAVAILABLE);
        else if (pr.compare(0, 27, "undefined|undefined|undefined") == 0)
            *errHint = Tr(S_HOTBOX_WINDOW_ERR_HOSTJSX_NOT_LOADED);
        else *errHint = std::string(Tr(S_HOTBOX_WINDOW_ERR_MODULE_LOAD_FAILED_PREFIX)) + pr;
    }
    if (ready) s_ready = true;
    else s_lastFailMs = nowMs;
    return ready;
}

// 批量收尾：全部成功 → 记最近使用 + 正常退场（与单次执行一致）；
// 有失败/中止 → 进度卡片切错误态（完整报错换行展示，点击/Esc 关闭），释放执行锁允许重试。
// undo group 已由每块脚本自开自闭，收尾无需补闭合。
// quiet=true：关窗/重新弹出路径——只复位状态，不更新卡片 UI（防渐隐期间闪现错误态）
void batchFinish(bool completed, const std::string& note, bool quiet = false) {
    if (!g_batch.active) return;
    g_batch.active = false;   // 先置 false：成功路径 window_hide → abortBatch 不再递归
    hotbox_log(("hotbox preset batch: applied=" + std::to_string(g_batch.applied) +
                " failed=" + std::to_string(g_batch.failed) +
                (note.empty() ? "" : " note=" + note)).c_str());
    if (completed && g_batch.failed == 0) {
        recordRecent(g_batch.item);
        window_hide();
        return;
    }
    // 失败/中止：驻留卡片报错，允许用户查看后关闭
    g_actionLock = false;
    if (quiet || !g_visible) return;
    std::string msg = completed
        ? trFormat(S_HOTBOX_WINDOW_STATUS_PARTIAL_FAIL, g_batch.applied, g_batch.failed)
        : trFormat(S_HOTBOX_WINDOW_STATUS_ABORTED, g_batch.applied,
                   (int)g_batch.layers.size());
    if (!g_batch.firstError.empty()) msg += " · " + g_batch.firstError;
    if (!note.empty()) msg += " · " + note;
    // 防异常超长：UTF-8 边界截断（与 executeSearchItem 一致）
    if (msg.size() > 480) {
        size_t cut = 480;
        while (cut > 0 && ((unsigned char)msg[cut] & 0xC0) == 0x80) --cut;
        msg = msg.substr(0, cut) + "...";
    }
    g_msg = msg;
    g_progressError = true;   // 进度卡片切错误态：完整换行展示 + 高度自适应
    updateProgressWindowSize();
    InvalidateRect(g_hwnd, nullptr, FALSE);
}

// 中止批量（Esc / 关窗 / 重新弹出时调用）：已应用层保留（可 Ctrl+Z 回退）
void abortBatch(bool quiet) {
    if (!g_batch.active) return;
    batchFinish(false, "", quiet);
}

// 分块应用脚本（批量 tick 用）：校验合成未切换/块内图层有效 → 隔离选区为本块层
// → 块内自开自闭 undo group（AE 会切断跨脚本调用维持的组，无法跨块持有；撤回按块）
// → 一次 applyPreset 应用于整块（AE 的 applyPreset 作用于"当前选中的所有层"——
// 原生多选语义与官方菜单同速，ffx 每块只解析一次；逐层单调 N 次解析实测慢 4~5 倍）
// → 末块（__E=1）按快照恢复原选区。
// 定位键：优先 chunkIds（稳定键）——块间跨多次脚本调用，位置键在用户删/加/重排图层后错位
// （会静默应用到别的层）。启用条件 = id 与位置键等长 + 引擎有 layerByID + 每个 id 为正整数；
// 启用后某个 id 查不到 → abort（绝不退回位置键，那正是错层的成因）。条件不满足整块退回位置键。
// 返回 {status: success|error|abort, message?}——abort = 合成/图层已变更，应中止余块
std::string buildPresetChunkScript(const std::string& key,
                                   const std::string& name,
                                   const std::vector<int>& chunk,
                                   const std::vector<int>& chunkIds,
                                   double compId, bool last,
                                   const std::vector<int>& reselect,
                                   const std::vector<int>& reselectIds) {
    char cid[32];
    sprintf_s(cid, "%.0f", compId);
    auto arr = [](const std::vector<int>& v) {
        std::string s = "[";
        for (size_t i = 0; i < v.size(); ++i) {
            if (i) s += ",";
            s += std::to_string(v[i]);
        }
        return s + "]";
    };
    return "var __p=" + json::buildString(key) +
           ",__n=" + json::buildString(name) +
           ",__C=" + cid +
           ",__E=" + (last ? "1" : "0") +
           ",__L=" + arr(chunk) +
           ",__LI=" + arr(chunkIds) +
           ",__R=" + arr(reselect) +
           ",__RI=" + arr(reselectIds) + ";" +
           R"js((function(){try{
function __rs(__c,__R,__RI){try{
var __u=(typeof app.project.layerByID==='function')&&__RI.length===__R.length&&__R.length>0;
var __sl=__c.selectedLayers;
for(var __a=0;__a<__sl.length;__a++)__sl[__a].selected=false;
for(var __m=0;__m<__R.length;__m++){var __l=null;
if(__u&&__RI[__m]>0){
try{__l=app.project.layerByID(__RI[__m]);}catch(_){__l=null;}
if(__l){var __sc=false;try{__sc=!!(__l.containingComp&&__l.containingComp.id===__c.id);}catch(_){}if(!__sc)__l=null;}
}else if(!__u){
try{__l=__c.layer(__R[__m]);}catch(_){__l=null;}
}
if(__l)__l.selected=true;}}catch(_){}}
var __c=app.project.activeItem;
if(!__c||!(__c instanceof CompItem)||__c.id!==__C)return JSON.stringify({status:'abort',message:)js" +
           json::buildString(Tr(S_HOTBOX_WINDOW_ERR_BATCH_COMP_CHANGED)) +
           R"js(});
var __u=(typeof app.project.layerByID==='function')&&__LI.length===__L.length&&__L.length>0;
var __ls=[];
for(var __k=0;__k<__L.length;__k++){var __l=null;
if(__u){try{__l=app.project.layerByID(__LI[__k]);}catch(_){__l=null;}
if(__l){var __sc=false;try{__sc=!!(__l.containingComp&&__l.containingComp.id===__C);}catch(_){}if(!__sc)__l=null;}}
else{try{__l=__c.layer(__L[__k]);}catch(_){__l=null;}}
if(!__l)return JSON.stringify({status:'abort',message:)js" +
           json::buildString(Tr(S_HOTBOX_WINDOW_ERR_BATCH_LAYER_CHANGED)) +
           R"js(});__ls.push(__l);}
try{var __sl=__c.selectedLayers;
for(var __a=0;__a<__sl.length;__a++)__sl[__a].selected=false;
for(var __b=0;__b<__ls.length;__b++)__ls[__b].selected=true;}catch(_){}
app.beginUndoGroup('应用预设: '+__n);
try{__ls[0].applyPreset(new File(__p));}
catch(e){try{app.endUndoGroup();}catch(_){}
if(__E){__rs(__c,__R,__RI);}
return JSON.stringify({status:'error',message:e.toString()});}
app.endUndoGroup();
if(__E){__rs(__c,__R,__RI);}
return JSON.stringify({status:'success'});
}catch(e){return JSON.stringify({status:'abort',message:e.toString()});}})())js";
}

// 执行单个功能项（手势环与搜索模式共用）：
//   效果  → host.jsx applyEffectToSelectedLayers({matchName})，加 effect.addProperty
//   预设  → 一次脚本完成校验与路径决策：
//           <kSyncPresetMax 层 → applyPreset 原生多选语义直接应用（ffx 只解析一次，
//             与官方"将动画预设应用于"菜单同速，同步完成不弹进度卡片，
//             块内自闭合 undo group，Ctrl+Z 一次撤回全部）
//           更多层 → 快照层索引 + 层 id（不开 undo group），由 kBatchTimer 分块应用 + 进度卡片
//           （每块一次调用、ffx 只解析一次、块内自开自闭 undo group——撤回按块；块间让消息泵喘息，不阻塞假死）
//   脚本  → 本地直读脚本内容 → host.jsx runScriptSandboxed(内容)（沙箱执行）
// 成功返回 true；失败时 failMsg 填错误消息（UTF-8）。
// deferred 输出 true = 预设批量已启动（转进度卡片，由 batchFinish 收尾）。
bool execItem(const data::Item& it, std::string* failMsg, bool* deferred) {
    std::string hint;
    if (!hostApiReady(&hint)) {
        if (failMsg) *failMsg = std::string(Tr(S_HOTBOX_WINDOW_ERR_EXEC_CHANNEL_NOT_READY_DETAIL)) + hint;
        return false;
    }
    std::string script;
    if (it.type == "effect") {
        // applyEffectToSelectedLayers 内部已 JSON.stringify，返回值即 JSON 文本；
        // 外层 try/catch 兜底：任何意外错误返回 "AE_ERR:..." 而非让 AE 弹"无法执行脚本"
        script = "var __p=" + json::buildString(it.key) +
                 ",__n=" + json::buildString(it.name) +
                 ";try{applyEffectToSelectedLayers({matchName:__p,effectName:__n});}catch(e){'AE_ERR:'+e.toString();}";
    } else if (it.type == "preset") {
        // 决策脚本：校验 + （同步路径：直接应用 | 批量路径：仅快照，undo group 由各块自管）
        std::string setup =
            "var __p=" + json::buildString(it.key) +
            ",__n=" + json::buildString(it.name) +
            ",__M=" + std::to_string(kSyncPresetMax) + ";" +
            R"js((function(){try{
var __c=app.project.activeItem;
if(!__c||!(__c instanceof CompItem))return JSON.stringify({status:'error',message:)js" +
           json::buildString(Tr(S_HOTBOX_WINDOW_ERR_NO_ACTIVE_COMP)) +
           R"js(});
var __s=__c.selectedLayers;
if(!__s||__s.length===0)return JSON.stringify({status:'error',message:)js" +
           json::buildString(Tr(S_HOTBOX_WINDOW_ERR_NO_LAYERS_SELECTED)) +
           R"js(});
var __f=new File(__p);
if(!__f.exists)return JSON.stringify({status:'error',message:)js" +
           json::buildString(Tr(S_HOTBOX_WINDOW_ERR_PRESET_MISSING_PREFIX)) +
           R"js(+__p});
if(__s.length<__M){
app.beginUndoGroup('应用预设: '+__n);
try{__s[0].applyPreset(__f);}
catch(e){try{app.endUndoGroup();}catch(_){}return JSON.stringify({status:'error',message:e.toString()});}
app.endUndoGroup();
return JSON.stringify({status:'success'});
}
var __idx=[],__ids=[],__ok=1;
for(var __k=0;__k<__s.length;__k++){__idx.push(__s[__k].index);
var __i=0;try{__i=Number(__s[__k].id)||0;}catch(_){__i=0;}
if(!(__i>0))__ok=0;__ids.push(__i);}
return JSON.stringify({status:'batch',compId:__c.id,indexes:__idx,layerIds:__ok?__ids:[]});
}catch(e){return JSON.stringify({status:'error',message:e.toString()});}})())js";
        std::string result, errMsg;
        if (!aeexec_runScript(setup, &result, &errMsg)) {
            if (failMsg) *failMsg = errMsg.empty()
                                        ? std::string(Tr(S_HOTBOX_WINDOW_ERR_EXEC_CALL_FAILED))
                                        : errMsg;
            return false;
        }
        json::Value v;
        bool parsed = json::parse(result.c_str(), result.size(), &v);
        if (parsed && v["status"].str == "success") return true;   // 同步路径：一次调用完成
        if (parsed && v["status"].str == "batch") {
            // 大批量：分块定时器应用（块间让消息泵喘息），窗口转进度卡片
            g_batch = {};
            g_batch.active = true;
            g_batch.item = it;
            g_batch.compId = v["compId"].num;
            for (size_t i = 0; i < v["indexes"].size(); ++i)
                g_batch.layers.push_back((int)v["indexes"][i].num);
            // 层 id 与位置键等长才启用（脚本侧已保证全为正整数，任一取不到就回空数组）
            if (v["layerIds"].size() == v["indexes"].size()) {
                for (size_t i = 0; i < v["layerIds"].size(); ++i)
                    g_batch.layerIds.push_back((int)v["layerIds"][i].num);
            }
            g_progressTitle = it.name;   // 进度卡片标题
            if (deferred) *deferred = true;
            SetTimer(g_hwnd, kBatchTimer, kBatchTickMs, nullptr);
            return true;
        }
        if (failMsg) *failMsg = parsed && !v["message"].str.empty()
                                    ? v["message"].str
                                    : std::string(Tr(S_HOTBOX_WINDOW_ERR_EXEC_FAILED));
        return false;
    } else {
        std::string content;
        if (!fsReadText(it.key, &content)) {   // 本地直读（解耦扩展面板/bridge）
            if (failMsg) *failMsg = Tr(S_HOTBOX_WINDOW_ERR_READ_SCRIPT_FAILED);
            return false;
        }
        // runScriptSandboxed 返回 "SUCCESS"/"ERROR:<msg>" 原样字符串
        script = "var __c=" + json::buildString(content) +
                 ",__n=" + json::buildString(it.name) +
                 ";try{runScriptSandboxed(__c,__n);}catch(e){'AE_ERR:'+e.toString();}";
    }
    std::string result, errMsg;
    if (!aeexec_runScript(script, &result, &errMsg)) {
        // AE 的脚本错误消息已由 aeexec 规范为 UTF-8，直接透出
        if (failMsg) *failMsg = errMsg.empty()
                                    ? std::string(Tr(S_HOTBOX_WINDOW_ERR_EXEC_CALL_FAILED))
                                    : errMsg;
        return false;
    }
    // 脚本返回 "SUCCESS"/"ERROR:<msg>"；效果/预设返回 {status:"success"|"error",message?}
    // 外层 try/catch 兜底失败返回 "AE_ERR:<msg>"
    if (result.compare(0, 7, "AE_ERR:") == 0) {
        if (failMsg) *failMsg = result.substr(7);
        return false;
    }
    if (it.type == "script") {
        if (result == "SUCCESS") return true;
        if (failMsg) {
            *failMsg = (result.compare(0, 6, "ERROR:") == 0)
                           ? result.substr(6)
                           : (std::string(Tr(S_HOTBOX_WINDOW_ERR_UNKNOWN_RESULT_PREFIX)) + result);
        }
        return false;
    }
    json::Value v;
    bool parsed = json::parse(result.c_str(), result.size(), &v);
    if (parsed && v["status"].str == "success") {
        // effectApi 契约带部分失败语义（failed/errors/errorsTruncated 逐层收集，"失败不静默"）。
        // 只看 status 会把部分图层 addProperty 失败当完全成功：记最近使用、正常关窗、无提示。
        // 部分失败按失败路径走（手势环记日志、搜索态状态行提示），消息格式对齐 batchFinish。
        int failed = (int)v["failed"].num;   // 字段缺失（旧契约/非 effect 返回）时为 0，不影响成功判定
        if (failed > 0) {
            std::string msg = trFormat(S_HOTBOX_WINDOW_STATUS_PARTIAL_FAIL,
                                       (int)v["applied"].num, failed);
            if (!v["errors"][0].str.empty()) msg += " · " + v["errors"][0].str;
            if (failMsg) *failMsg = msg;
            return false;
        }
        return true;
    }
    if (failMsg) *failMsg = parsed && !v["message"].str.empty()
                                ? v["message"].str
                                : std::string(Tr(S_HOTBOX_WINDOW_ERR_EXEC_FAILED));
    return false;
}

// 搜索模式窗口高度自适应面板（搜索栏保持贴鼠标）：窗口顶不动（搜索栏已对鼠标），
// 高度按 statusY() 动态；必要时底部 clamp 保证面板完整可见
// 过滤下拉展开时需额外容纳下拉面板高度，避免无搜索内容时窗口过矮把下拉底部裁切
void updateSearchWindowSize() {
    if (!g_visible || !g_hwnd) return;
    int winH = statusY() + 38;   // 面板底 statusY()+28 + 下边距 10
    // 过滤下拉展开时：面板高度至少容纳下拉（kFilterDropY + 4 行 + 下边距 10）
    if (g_filterMenuOpen) {
        int dropH = kFilterDropY + 4 * kFilterDropRowH + 10;
        if (winH < dropH) winH = dropH;
    }
    if (winH < 120) winH = 120;
    double targetDip = (double)winH;
    RECT wr;
    GetWindowRect(g_hwnd, &wr);
    // 当前实际高度（DIP）：动画中用插值当前值，否则取窗口实际尺寸
    double curDip;
    if (g_inHeightAnim) {
        double tnow = clamp01((double)(GetTickCount64() - g_heightAnimStartMs) / kHeightAnimMs);
        curDip = lerp(g_heightFromH, g_heightTargetH, easeOutCubic(tnow));
    } else {
        curDip = (double)(wr.bottom - wr.top) / g_dpiScale;
    }
    // 高度差 < 1 DIP：直接定到目标，避免无意义动画
    if (fabs(curDip - targetDip) < 1.0) {
        g_inHeightAnim = false;
        int pW = phys(kWinW), pH = phys(winH);
        int top = wr.top;
        HMONITOR mon = MonitorFromPoint({ g_mouseX, g_mouseY }, MONITOR_DEFAULTTONEAREST);
        MONITORINFO mi = {};
        mi.cbSize = sizeof(mi);
        GetMonitorInfoW(mon, &mi);
        // 整面板钳制（不再只保搜索栏）：空查询默认带最近使用列表，搜索栏可见但列表出屏等于没有
        top = hotbox::clampTopForHeight(top, pH, mi.rcWork.top, mi.rcWork.bottom);
        SetWindowPos(g_hwnd, HWND_TOPMOST, wr.left, top, pW, pH, SWP_NOACTIVATE);
        return;
    }
    // 启动/重定向高度动画：从当前插值高度为新起点 → 新目标（连跳时平滑接力）
    g_heightFromH = curDip;
    g_heightTargetH = targetDip;
    g_heightAnimStartMs = GetTickCount64();
    g_inHeightAnim = true;
    SetTimer(g_hwnd, kAnimTimer, animTimerMs(), nullptr);
}

// 回手势/设置模式：恢复 440 全高窗口，并按当前鼠标重新对齐环心（环心对鼠标）
void restoreGestureWindow() {
    if (!g_visible || !g_hwnd) return;
    refreshDpiScale(g_hwnd);
    int pW = phys(kWinW), pH = phys(kWinH);
    POINT pt;
    GetCursorPos(&pt);
    // 环心 x/y 精确对准当前鼠标（不钳制，允许越出屏幕）：与 window_showAt 行为一致；
    // 搜索/设置面板曾被工作区钳制移位，回手势环时环心重新归位鼠标，贴边时原位即可点中心圆
    SetWindowPos(g_hwnd, HWND_TOPMOST, pt.x - phys(kCx), pt.y - phys(kCy), pW, pH, SWP_NOACTIVATE);
    // 焦点交还主窗口：搜索/设置退出路径 EDIT 已被隐藏（焦点随之丢失），
    // 不归还的话手势模式"按字母键直达搜索"会失灵（须先点一次鼠标）
    SetFocus(g_hwnd);
}

// 设置面板紧凑窗口：保持 x 位置，高度切到 kSetWinH（小于手势环 440），y 钳制工作区
void setSettingsWindowSize() {
    if (!g_visible || !g_hwnd) return;
    refreshDpiScale(g_hwnd);
    int pW = phys(kWinW), pH = phys(kSetWinH);
    RECT wr;
    GetWindowRect(g_hwnd, &wr);
    int top = wr.top;
    int left = wr.left;
    HMONITOR mon = MonitorFromPoint({ wr.left, wr.top }, MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi = {};
    mi.cbSize = sizeof(mi);
    GetMonitorInfoW(mon, &mi);
    // x/y 钳制：手势环贴边呼出时窗口允许越出屏幕，设置面板必须完整可见（不被切）
    if (left < mi.rcWork.left) left = mi.rcWork.left;
    if (left + pW > mi.rcWork.right) left = mi.rcWork.right - pW;
    if (left < mi.rcWork.left) left = mi.rcWork.left;
    if (top + pH > mi.rcWork.bottom) top = mi.rcWork.bottom - pH;
    if (top < mi.rcWork.top) top = mi.rcWork.top;
    SetWindowPos(g_hwnd, HWND_TOPMOST, left, top, pW, pH, SWP_NOACTIVATE);
}

// 进入进度卡片（预设批量启动时由手势/搜索两路径统一调用）：
// 紧凑卡片居中于当前窗口中心，淡入；批量期间常驻（热键松开不关闭），
// 全部成功由 batchFinish → window_hide 渐隐关闭；失败驻留展示完整错误
void enterProgressMode() {
    hotbox_log("enterProgressMode");
    releaseMouse();   // 手势模式方向跟踪捕获 / 搜索模式可能的拖拽捕获
    if (g_edit) ShowWindow(g_edit, SW_HIDE);   // EDIT 原生子窗口不随 D2D 绘制，须显式隐藏
    g_filterMenuOpen = false;
    g_filterHover = -1;
    g_filterBtnHover = false;
    g_rowHover = -1;
    g_statusHover = false;
    g_mode = Mode::kProgress;
    g_inHeightAnim = false;   // 搜索路径转入进度卡片：停止高度动画，防残留插值 SetWindowPos 覆盖卡片尺寸
    g_pinned = true;   // 常驻：批量期间热键松开不关闭
    g_progressError = false;
    animStart(1);   // 淡入（150ms，paint 统一处理）
    updateProgressWindowSize();
    InvalidateRect(g_hwnd, nullptr, FALSE);
}

// 进入搜索模式（可选预过滤类别）：立即切到搜索面板 + 小缩放/透明度入场动画。
// 简化：不做圆→条形转场形变（复杂且 bug 多），直接显示面板，
// 入场用 animStart(1) 驱动的 150ms 小缩放（0.92→1）+ 透明度（0→1）渐显。
void enterSearchMode(const std::string& filterType) {
    hotbox_log(("enterSearchMode ENTER mode=" + std::to_string((int)g_mode) +
                " pinned=" + std::to_string(g_pinned ? 1 : 0) +
                " animDir=" + std::to_string(g_animDir)).c_str());
    // 退场渐隐中转入（Esc 关闭后 150ms 内按字母键，或渐隐中松开悬停
    // 类别弧段的热键 → executeSelected kCategory 分支）——先走 doHide 完成复位
    //（释放 g_actionLock、清窗口状态、隐藏窗口），再走正常打开流程。否则下方
    // animStart(1) 把退场动画反转为入场，kAnimTimer 正向完成分支不调 doHide，
    // g_actionLock 永久滞留 true → 搜索面板外观正常但 Enter/点击行全部静默失效
    //（锁在键盘路径缺守卫 + doHide 被反转吞的组合）。
    // 显示推迟到函数末尾「提交首帧后」——doHide 前的旧 ULW 表面仍带渐隐中的
    // 旧面板，立即 ShowWindow 会先把它上屏一帧（用户实报「打开闪一下上次的搜索菜单」）；
    // 这里只置逻辑可见位，供下方布局/定位按可见态执行
    if (g_animDir < 0) {
        doHide();
        g_visible = true;
    }
    // 撤销待执行 kExecTimer（导航转场失去执行前提，语义同 window_hide
    // 的）——90ms 按压窗内进搜索后定时器照发会误执行 + 关闭搜索会话
    cancelPendingExec();
    releaseMouse();   // 搜索模式用窗口内交互，释放方向跟踪捕获
    g_msg.clear();
    g_pinned = true;   // 进入搜索模式即锁定常驻：热键松开不关闭
    if (!g_dataLoaded) loadData();
    if (!filterType.empty()) g_filterType = filterType;
    g_mode = Mode::kSearch;   // 必须在窗口定位/重查前设（updateSearchWindowSize 按模式判断）
    hotbox_log(("enterSearchMode mode set -> " + std::to_string((int)g_mode)).c_str());
    if (g_edit) {
        g_query = "";
        g_results.clear();   // 先按空结果定位窗口；结果（最近使用）由 rerunQuery 填入后长高
        g_resultSel = 0;
        g_scrollTop = 0;
        g_rowHover = -1;      // 上次搜索会话的行 hover 不跨模式残留（空查询有列表时可见）
        g_statusHover = false;
        SetWindowTextW(g_edit, L"");
        MoveWindow(g_edit, phys(g_editX), phys(kBarY + 8), phys(g_editW), phys(kBarH - 12), TRUE);
    }
    // 窗口定位：搜索栏对齐鼠标 + 面板高度自适应（初始高度按空结果估，最终高度以
    // updateSearchWindowSize 为准；程序化 SetWindowTextW 触发 EN_CHANGE 时可能已按列表高度）
    if (g_visible && g_hwnd) {
        refreshDpiScale(g_hwnd);
        int winH = statusY() + 38;   // 空结果 statusY≈74 → 112 → 钳到最小 120
        if (winH < 120) winH = 120;
        RECT wr;
        GetWindowRect(g_hwnd, &wr);
        int pW = phys(kWinW);
        // 搜索栏中心对准一级菜单环心的实际屏幕位置（环心即呼出点），两菜单中心一致
        int top = (wr.top + phys(kCy)) - phys(kBarY + kBarH / 2);
        int left = wr.left;
        HMONITOR mon = MonitorFromPoint({ g_mouseX, g_mouseY }, MONITOR_DEFAULTTONEAREST);
        MONITORINFO mi = {};
        mi.cbSize = sizeof(mi);
        GetMonitorInfoW(mon, &mi);
        // x 钳制：手势环贴边呼出时窗口允许越出屏幕，搜索面板须完整可见
        if (left < mi.rcWork.left) left = mi.rcWork.left;
        if (left + pW > mi.rcWork.right) left = mi.rcWork.right - pW;
        if (left < mi.rcWork.left) left = mi.rcWork.left;
        // y 钳制按整面板高度：搜索栏对齐鼠标只是初始意图，底部呼出时整列表必须可见
        top = hotbox::clampTopForHeight(top, phys(winH), mi.rcWork.top, mi.rcWork.bottom);
        SetWindowPos(g_hwnd, HWND_TOPMOST, left, top, pW, phys(winH), SWP_NOACTIVATE);
    }
    rerunQuery();   // 空查询：填入最近使用（无记录则为空状态），高度动画跟随结果数
    // 入场动画：小缩放 + 透明度（150ms，paint() 统一处理）
    animStart(1);
    InvalidateRect(g_hwnd, nullptr, FALSE);
    // 先提交首帧再显示（与 window_showAt 同构）：
    // 隐藏窗口的 UpdateWindow 不派发 WM_PAINT（paints=0），隐藏态这一发实际是空操作——
    // 防残影真正靠的是 doHide 后的 clearLayeredSurface（隐藏期间表面恒为全透明）。
    // 三条调用保留：窗口已可见时（转场以外路径）UpdateWindow 确实同步提交首帧，且幂等无害
    UpdateWindow(g_hwnd);
    ShowWindow(g_hwnd, SW_SHOWNOACTIVATE);
    UpdateWindow(g_hwnd);
    // 显示 EDIT 并聚焦（原生子窗口不随 D2D 动画，直接显示；键盘输入即用）。
    // 必须在窗口显示之后置焦点：隐藏态 SetFocus 不生效，转场分支（doHide → 显示）
    // 会把首个按键落回 AE 而不是搜索框。
    if (g_edit) {
        ShowWindow(g_edit, SW_SHOWNOACTIVATE);
        // SetFocus(g_edit) 会让父窗口失活，触发 WM_ACTIVATE(WA_INACTIVE)；
        // 用 focusEdit() 延迟清 g_focusingEdit，避免异步送达的失活被误判为点击外部而关闭
        focusEdit();
    }
    // 底边呼出防护起点：记录进入时刻与鼠标屏幕位（行点击分支据此吞双击第二击）
    GetCursorPos(&g_searchEnterPt);
    g_searchEnterMs = GetTickCount64();
}

// 进入设置面板（手势环正下方弧段入口）：槽位绑定列表 + 热键；退出走 Esc
void enterSettings() {
    // 退场渐隐中转入（渐隐中松开悬停设置弧段的热键 → executeSelected
    // kSettings 分支）——先 doHide 复位（释放 g_actionLock），防 animStart(1)
    // 反转退场动画使 doHide 永不执行、锁永久滞留（同 enterSearchMode 注释）。
    // 显示推迟到函数末尾「提交首帧后」——doHide 前的旧 ULW 表面仍带渐隐中
    // 的旧面板，立即 ShowWindow 会先把它上屏一帧；这里只置逻辑可见位供后续布局
    if (g_animDir < 0) {
        doHide();
        g_visible = true;
    }
    // 撤销待执行 kExecTimer（导航转场失去执行前提，同 enterSearchMode）
    cancelPendingExec();
    g_mode = Mode::kSettings;
    releaseMouse();   // 设置面板用窗口内交互，释放方向跟踪捕获
    g_msg.clear();
    g_settingsSel = 0;
    g_setHover = -1;   // 复位 hover（防上次残留）
    g_pressRow = -1;   // 复位按压（防上次残留）
    g_pinned = true;   // 设置面板常驻：热键松开不关闭（配置操作不受热键影响）
    // 二级菜单入场动画：面板从中心展开
    animStart(1);
    if (g_edit) ShowWindow(g_edit, SW_HIDE);
    setSettingsWindowSize();   // 紧凑窗口：高度切到 kSetWinH（小于手势环 440）
    InvalidateRect(g_hwnd, nullptr, FALSE);
    // 先提交首帧再显示（同 enterSearchMode）。隐藏窗口的 UpdateWindow 不派发
    // WM_PAINT，隐藏态这一发是空操作——防残影靠 doHide 后的
    // clearLayeredSurface；保留调用是因为窗口可见时确实同步提交首帧，且幂等无害
    UpdateWindow(g_hwnd);
    ShowWindow(g_hwnd, SW_SHOWNOACTIVATE);
    UpdateWindow(g_hwnd);
    // 键盘焦点给面板：普通键按键不落回 AE 主窗口触发快捷键。须在显示之后置焦点：
    // 隐藏态 SetFocus 不生效，转场分支会让按键落回 AE（故 SetFocus 放在 ShowWindow 之后）
    SetFocus(g_hwnd);
}

// 回手势模式（设置面板 / 绑定流程 Esc 出口）：立即完整显示（无退场动画）
void backToGesture() {
    g_mode = Mode::kGesture;
    g_bindingSlot = -1;
    g_recordingHotkey = false;
    g_returnToSettings = false;
    g_filterMenuOpen = false;
    g_pinned = false;
    g_inHeightAnim = false;   // 离开搜索模式：停止高度动画，避免回到手势环后残留 SetWindowPos
    g_execDispersing = false;   // 离开手势环执行态：清散开态，避免残留
    g_animPhase = 1.0;             // 手势环立即完整
    g_animDir = 0;
    KillTimer(g_hwnd, kAnimTimer);
    if (g_hwnd) KillTimer(g_hwnd, kCheckFgTimer);   // 撤销待前台检查
    g_pendingHideCheck = false;
    hideEdit();                    // 移出可视区：防输入框残留竖线
    restoreGestureWindow();        // 恢复 440 全高窗口，环心对齐当前鼠标
    InvalidateRect(g_hwnd, nullptr, FALSE);
}

// 设置面板槽位行（0-3，共 4 个功能槽）→ 手势环弧段索引
// 手势环 6 弧段：正下固定为设置入口、正上专职截图入口，可绑定的只有其余 4 段
// 弧段方位：arc0=正上(-90°,截图入口) arc1=右上(-30°) arc2=右下(30°) arc4=左下(150°) arc5=左上(210°)
// 面板行序：左上→左下→右上→右下（按方位直觉排列；正上已专职截图、正下为设置，均不可绑定）
static const int kRowToArc[4] = { 5, 4, 1, 2 };
static const StrId kSlotNameIds[4] = { S_HOTBOX_WINDOW_SLOT_TOP_LEFT,
                                       S_HOTBOX_WINDOW_SLOT_BOTTOM_LEFT,
                                       S_HOTBOX_WINDOW_SLOT_TOP_RIGHT,
                                       S_HOTBOX_WINDOW_SLOT_BOTTOM_RIGHT };
static const char* slotName(int row) { return Tr(kSlotNameIds[row]); }
int slotRowToArc(int row) { return kRowToArc[row]; }
int arcToSlotRow(int arc) {
    for (int r = 0; r < 4; ++r) if (kRowToArc[r] == arc) return r;
    return -1;
}

// 设置面板布尔开关的通用激活体（行5 松手执行 / 行6 松手停留）：翻转运行态并写回
// config.json（读失败拒绝写，防整包重建丢槽位/热键；写失败回滚运行态保持内存
// 与磁盘一致）
static void toggleBoolSetting(bool& flag, std::string (*setter)(const std::string&, bool),
                              const char* onMsg, const char* offMsg) {
    bool newVal = !flag;
    std::string p = hotboxDataPath("config.json");
    std::string cur;
    if (!p.empty() && readConfigSafe(p, &cur)) {
        if (fsWriteText(p, configTextForWrite(setter(cur, newVal)))) {
            flag = newVal;
            g_msg = newVal ? onMsg : offMsg;
        } else {
            g_msg = Tr(S_HOTBOX_WINDOW_SETTINGS_SAVE_WRITE_FAILED);
        }
    } else {
        g_msg = Tr(S_HOTBOX_WINDOW_SETTINGS_SAVE_READ_FAILED);
    }
}

// 设置面板：激活当前选中行（0-3 槽位 / 4 热键 / 5 松手执行开关 / 6 松手停留开关）
void settingsActivate() {
    if (g_settingsSel < 4) {
        g_bindingSlot = slotRowToArc(g_settingsSel);
        g_returnToSettings = true;
        enterSearchMode("");
        g_msg = trFormat(S_HOTBOX_WINDOW_SETTINGS_BIND_PROMPT, slotName(g_settingsSel));
    } else if (g_settingsSel == 4) {
        g_recordingHotkey = true;
        // 暂停当前热键注册——录制期按下已生效组合（如当前就是 Ctrl+空格，
        // 想原样重录）会被 RegisterHotKey 系统级吞键（只触发被录制期忽略的 WM_HOTKEY），
        // WM_KEYDOWN 无法落地，录制器"没反应"。暂停后按键以普通键消息到达完成录制，
        // 取消（Esc）时由 hotkey_resumeForRecording 还原
        hotkey_suspend();
        g_msg = Tr(S_HOTBOX_WINDOW_SETTINGS_HOTKEY_PROMPT);
        // 录制静默超时提示：RegisterHotKey 是系统级互斥，被其他程序占用的组合根本不会
        // 送达本窗口——录制器只能表现为「按了没反应」。静默 1.5s 后把提示区改显占用可能
        // （见 WM_TIMER 的 kRecordHintTimer 与 paintSettings 的 tip 选择）
        g_recordStartMs = GetTickCount64();
        SetTimer(g_hwnd, kRecordHintTimer, 500, nullptr);
    } else if (g_settingsSel == 5) {
        toggleBoolSetting(g_releaseExecute, config::setReleaseExecute,
                          Tr(S_HOTBOX_WINDOW_SETTINGS_RELEASE_EXEC_ON),
                          Tr(S_HOTBOX_WINDOW_SETTINGS_RELEASE_EXEC_OFF));
    } else if (g_settingsSel == 6) {
        // 提示点明与「松手执行」的优先级：停留开启后松手不执行任何弧段，行5 的开/关不再参与判定
        toggleBoolSetting(g_releaseStay, config::setReleaseStay,
                          Tr(S_HOTBOX_WINDOW_SETTINGS_RELEASE_STAY_ON),
                          Tr(S_HOTBOX_WINDOW_SETTINGS_RELEASE_STAY_OFF));
    }
    InvalidateRect(g_hwnd, nullptr, FALSE);
}

// 设置面板绘制：面板框 + 标题分隔线 + 7 行（0-3 槽位 / 4 热键 / 5 松手执行 / 6 松手停留）+ 底部提示，选中行高亮
// 4 个功能槽对应环上除设置段（正下方）与截图段（正上）外的 4 个弧段
void paintSettings(ID2D1SolidColorBrush* brBorder, ID2D1SolidColorBrush* brFill,
                   ID2D1SolidColorBrush* brFillSel, ID2D1SolidColorBrush* brText,
                   ID2D1SolidColorBrush* brMuted, ID2D1SolidColorBrush* brRowHover,
                   ID2D1SolidColorBrush* brAccent) {
    D2D1_ROUNDED_RECT rcPanel = D2D1::RoundedRect(
        D2D1::RectF(10.0f, 10.0f, (FLOAT)(kWinW - 10), (FLOAT)(kSetWinH - 10)),
        10.0f, 10.0f);
    // 填充外扩 1px 垫边框抗锯齿外缘（同搜索面板，防透明背景上出暗色竖边）
    g_rt->FillRoundedRectangle(
        D2D1::RoundedRect(D2D1::RectF(9.0f, 9.0f, (FLOAT)(kWinW - 9), (FLOAT)(kSetWinH - 9)),
                          10.0f, 10.0f),
        brFill);
    g_rt->DrawRoundedRectangle(rcPanel, brBorder, 1.5f);
    // 标题 + 分隔线（分隔标题与列表区，增强结构层次）
    D2D1_RECT_F rcTitle = D2D1::RectF(26.0f, 14.0f, (FLOAT)(kWinW - 30), 30.0f);
    std::wstring setTitle = TrW(S_HOTBOX_WINDOW_SETTINGS_TITLE);
    g_rt->DrawText(setTitle.c_str(), (UINT32)setTitle.size(), g_fmtLeft, rcTitle, brText,
                   D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
    g_rt->DrawLine(D2D1::Point2F(26.0f, 36.0f), D2D1::Point2F((FLOAT)(kWinW - 26), 36.0f),
                   brBorder, 1.0f);
    for (int i = 0; i < kSetRows; ++i) {
        float y = (float)(kSetRowY0 + i * kSetRowH);
        if (i == g_pressRow) {
            // 按压反馈：整行向中心轻微收缩（90ms 先快后慢），与手势环弧段按压观感一致
            double pt = clamp01((double)(GetTickCount64() - g_pressStartMs) / kPressMs);
            double s = 1.0 - 0.04 * easeOutCubic(pt);
            if (s < 0.001) s = 0.001;
            g_rt->SetTransform(D2D1::Matrix3x2F::Scale(
                (float)s, (float)s,
                D2D1::Point2F((FLOAT)(kWinW / 2), y + (FLOAT)kSetRowH / 2)));
        }
        if (i == g_settingsSel) {
            // 选中行圆角矩形 + 左侧强调竖条：限制在面板内（right = kWinW-20，与面板外框内缩 10px）
            g_rt->FillRoundedRectangle(
                D2D1::RoundedRect(D2D1::RectF(20.0f, y + 2.0f, (FLOAT)(kWinW - 20),
                                              y + (FLOAT)kSetRowH - 2.0f), 7.0f, 7.0f),
                brFillSel);
            g_rt->DrawRoundedRectangle(
                D2D1::RoundedRect(D2D1::RectF(20.0f, y + 2.0f, (FLOAT)(kWinW - 20),
                                              y + (FLOAT)kSetRowH - 2.0f), 7.0f, 7.0f),
                brAccent, 1.0f);   // 选中行金色描边
            g_rt->FillRoundedRectangle(
                D2D1::RoundedRect(D2D1::RectF(20.0f, y + 6.0f, 24.0f,
                                              y + (FLOAT)kSetRowH - 6.0f), 2.0f, 2.0f),
                brAccent);   // 左侧强调条（选中指示更明确）
        } else if (i == g_setHover) {
            // hover 行：浅色背景反馈（弱于选中行，仅鼠标悬停）
            g_rt->FillRoundedRectangle(
                D2D1::RoundedRect(D2D1::RectF(20.0f, y + 2.0f, (FLOAT)(kWinW - 20),
                                              y + (FLOAT)kSetRowH - 2.0f), 7.0f, 7.0f),
                brRowHover);
        }
        // 按压行：金色填充 + 白色描边（与手势环弧段按下反馈一致：提亮 + 白框）
        if (i == g_pressRow) {
            g_rt->FillRoundedRectangle(
                D2D1::RoundedRect(D2D1::RectF(20.0f, y + 2.0f, (FLOAT)(kWinW - 20),
                                              y + (FLOAT)kSetRowH - 2.0f), 7.0f, 7.0f),
                brFillSel);
            g_rt->DrawRoundedRectangle(
                D2D1::RoundedRect(D2D1::RectF(20.0f, y + 2.0f, (FLOAT)(kWinW - 20),
                                              y + (FLOAT)kSetRowH - 2.0f), 7.0f, 7.0f),
                brText, 1.5f);   // 白色描边（与弧段按下反馈一致）
        }
        std::wstring text;
        if (i < 4) {
            int arc = slotRowToArc(i);   // 槽位行 → 弧段索引（跳过设置段/截图段）
            text = utf8ToWide(slotName(i)) + L"   ";
            if ((size_t)arc < g_slots.size() && g_slots[arc].fixed) {
                // 名称预算 = 行宽减去槽位前缀实测宽；zh-CN 仍按原 16 字符口径
                const float nameBudget =
                    (float)(kWinW - 60) - measureTextW(text, g_fmtLeft, 8192.0f);
                text += truncateForWidth(utf8ToWide(g_slots[arc].item.name), 16, g_fmtLeft,
                                         nameBudget);
            } else
                text += TrW(S_HOTBOX_WINDOW_SETTINGS_UNBOUND);
        } else if (i == 4) {
            text = utf8ToWide(trFormat(S_HOTBOX_WINDOW_SETTINGS_HOTKEY_ROW, hotkey_describe()));
        } else if (i == 5) {
            text = TrW(g_releaseExecute ? S_HOTBOX_WINDOW_SETTINGS_RELEASE_EXEC_ON_ROW
                                        : S_HOTBOX_WINDOW_SETTINGS_RELEASE_EXEC_OFF_ROW);
        } else if (i == 6) {
            text = TrW(g_releaseStay ? S_HOTBOX_WINDOW_SETTINGS_RELEASE_STAY_ON_ROW
                                     : S_HOTBOX_WINDOW_SETTINGS_RELEASE_STAY_OFF_ROW);
        }
        D2D1_RECT_F rcItem = D2D1::RectF(30.0f, y, (FLOAT)(kWinW - 30), y + (FLOAT)kSetRowH);
        g_rt->DrawText(text.c_str(), (UINT32)text.size(), g_fmtLeft, rcItem, brText,
                       D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
        if (i == g_pressRow) g_rt->SetTransform(D2D1::Matrix3x2F::Identity());   // 复位按压缩放
    }
    // 底部提示区：录制热键时显示带框气泡，否则显示次要操作提示（返回已并入 Esc）
    if (g_recordingHotkey || !g_msg.empty()) {
        // 录制静默 ≥kRecordHintMs：改显占用可能——RegisterHotKey 系统级互斥，被别的程序
        // 占用的组合不会送达本窗口，录制器只能表现为「按了没反应」，静默即是最可能的症状
        bool recordStalled = g_recordingHotkey && g_recordStartMs &&
                             GetTickCount64() - g_recordStartMs >= kRecordHintMs;
        D2D1_RECT_F rcBub = D2D1::RectF(26.0f, 274.0f, (FLOAT)(kWinW - 26), 296.0f);
        // 提示气泡是单行文本框：按像素宽度截断；zh-CN 仍按原 30 字符口径
        std::wstring tip = g_recordingHotkey
            ? TrW(recordStalled ? S_HOTBOX_WINDOW_SETTINGS_HOTKEY_OCCUPIED
                                : S_HOTBOX_WINDOW_SETTINGS_HOTKEY_PROMPT)
            : truncateForWidth(utf8ToWide(g_msg), 30, g_fmt,
                               (rcBub.right - 12.0f) - (rcBub.left + 12.0f));
        g_rt->FillRoundedRectangle(
            D2D1::RoundedRect(D2D1::RectF(rcBub.left - 1.0f, rcBub.top - 1.0f,
                                          rcBub.right + 1.0f, rcBub.bottom + 1.0f),
                              6.0f, 6.0f),
            brFill);
        g_rt->DrawRoundedRectangle(D2D1::RoundedRect(rcBub, 6.0f, 6.0f), brAccent, 1.5f);
        D2D1_RECT_F rcTip = D2D1::RectF(rcBub.left + 12.0f, rcBub.top,
                                        rcBub.right - 12.0f, rcBub.bottom);
        g_rt->DrawText(tip.c_str(), (UINT32)tip.size(), g_fmt, rcTip, brText,
                       D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
    } else {
        std::wstring foot = TrW(S_HOTBOX_WINDOW_SETTINGS_FOOTER);
        D2D1_RECT_F rcFoot = D2D1::RectF(20.0f, 274.0f, (FLOAT)(kWinW - 20), 296.0f);
        g_rt->DrawText(foot.c_str(), (UINT32)foot.size(), g_fmt, rcFoot,
                       brMuted, D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
    }
}

// 绑定前校验目标仍可用：陈旧最近使用记录（换 AE 版本/重装/删文件/预设换源）不得写进槽位。
// effect 按 matchName 在当前轮枚举里找；script/preset 判文件存在。数据未就绪（g_items 空 /
// 文件探测不可用）时放行——fail-open：宁可绑上后执行时提示，也不误拒真条目。
// 不按名匹配：同名不同内容的预设是两条真条目（出厂预设真实存在同名不同内容）。
bool bindingTargetUsable(const data::Item& it, std::string* why) {
    if (it.type == "effect") {
        if (g_items.empty()) return true;
        for (const auto& e : g_items) {
            if (e.type == "effect" && e.key == it.key) return true;
        }
        if (why) *why = trFormat(S_HOTBOX_WINDOW_ERR_EFFECT_NOT_INSTALLED, it.name.c_str());
        return false;
    }
    if (it.type == "script" || it.type == "preset") {
        if (it.key.empty() || !fileExists(it.key)) {
            if (why) *why = Tr(it.type == "script" ? S_HOTBOX_WINDOW_ERR_SCRIPT_MISSING
                                                   : S_HOTBOX_WINDOW_ERR_PRESET_MISSING);
            return false;
        }
    }
    return true;
}

// 绑定当前搜索结果到手势环槽位（写入 config.json gesture.slots），随后回手势模式
void bindCurrentResultToSlot() {
    if (g_bindingSlot < 0 || (size_t)g_resultSel >= g_results.size()) return;
    const data::Item& it = g_results[g_resultSel];
    // 陈旧记录只拒绝绑定、不隐藏（用户可看到并改选其他行；Esc 退出绑定流程）
    std::string unusable;
    if (!bindingTargetUsable(it, &unusable)) {
        g_msg = std::string(Tr(S_HOTBOX_WINDOW_ERR_BIND_FAILED_PREFIX)) + unusable;
        InvalidateRect(g_hwnd, nullptr, FALSE);
        return;
    }
    std::string p = hotboxDataPath("config.json");
    if (p.empty()) return;
    std::string cur;
    // 读失败/半截 JSON 拒绝整包重建——fsReadText 返回值不检查时 cur 为空串，
    // setSlot 从空 Config 构建（只剩新绑定的 1 个槽，其余槽位被静默清空）。
    // 文件不存在（首次使用）不在此列：无数据可丢，允许从空配置构建。
    bool readOk = readConfigSafe(p, &cur);
    std::string updated = readOk
                                 ? configTextForWrite(config::setSlot(cur, g_bindingSlot, it,
                                                                   (size_t)kSegmentCount))
                                 : std::string();
    bool saved = readOk && fsWriteText(p, updated);
    loadSlotConfig();   // 写盘失败也重读磁盘旧配置 → 内存/设置面板显示与磁盘状态一致
    resolveGestureEntries();
    // g_bindingSlot 是弧段索引，反查方位名用于提示
    int row = arcToSlotRow(g_bindingSlot);
    std::string msg = !readOk
                          ? std::string(Tr(S_HOTBOX_WINDOW_ERR_BIND_READ_FAILED))
                          : saved
                          ? trFormat(S_HOTBOX_WINDOW_BOUND, row >= 0 ? slotName(row) : "?",
                                     it.name.c_str())
                          : std::string(Tr(S_HOTBOX_WINDOW_ERR_BIND_WRITE_FAILED));
    g_bindingSlot = -1;
    // 绑定完成离开搜索模式：停止高度动画，防下一 tick 残留插值 SetWindowPos
    // 把回退目标（设置面板/手势环）高度覆盖成旧搜索高度
    g_inHeightAnim = false;
    if (g_returnToSettings) {
        // 从设置面板发起绑定 → 绑定完成后回设置面板（继续配置其他槽）
        g_returnToSettings = false;
        g_mode = Mode::kSettings;
        g_settingsSel = 0;
        animStart(1);   // 设置面板展开动画
    } else {
        g_mode = Mode::kGesture;
        g_animPhase = 1.0;   // 手势环立即完整
        g_animDir = 0;
        KillTimer(g_hwnd, kAnimTimer);
    }
    g_filterMenuOpen = false;
    g_pinned = (g_mode == Mode::kSettings);   // 回设置面板保持常驻；回手势环解锁
    if (g_edit) ShowWindow(g_edit, SW_HIDE);
    if (g_mode == Mode::kSettings) setSettingsWindowSize();   // 回设置面板：紧凑窗口
    else restoreGestureWindow();   // 回手势环：恢复 440 全高窗口
    g_msg = msg;
    InvalidateRect(g_hwnd, nullptr, FALSE);
}

// 搜索模式执行选中项：真实执行；成功记录最近使用并关窗，失败状态行提示（窗口保持）。
void executeSearchItem(int sel) {
    if (sel < 0 || (size_t)sel >= g_results.size()) return;
    // 防连点：执行锁定期（含退场动画）拒绝新的执行
    if (g_actionLock) return;
    g_actionLock = true;
    const data::Item& it = g_results[sel];
    std::string failMsg;
    bool deferred = false;
    if (execItem(it, &failMsg, &deferred)) {
        if (deferred) {
            // 预设批量：搜索面板转进度卡片（进度/错误统一展示），余层由 kBatchTimer 驱动；
            // 完成后 batchFinish 统一走成功（关窗）/失败（卡片错误态）路径
            hotbox_log(("hotbox preset batch start: " + it.name).c_str());
            enterProgressMode();
            return;
        }
        recordRecent(it);
        hotbox_log(("hotbox exec ok: " + it.type + " " + it.name).c_str());
        // 保持锁至 doHide() 释放：退场动画期间拦截排队点击
        window_hide();
        return;
    }
    // 失败：窗口保持，允许用户重试 → 释放锁
    g_actionLock = false;
    // g_msg 保存完整消息（状态行单行裁剪显示，hover 状态行气泡完整展示）；
    // 仅防异常超长：按 UTF-8 字符边界截断，不在多字节字符中间切开（防尾字符乱码）
    if (failMsg.size() > 480) {
        size_t cut = 480;
        while (cut > 0 && ((unsigned char)failMsg[cut] & 0xC0) == 0x80) --cut;
        failMsg = failMsg.substr(0, cut) + "...";
    }
    g_msg = std::string(Tr(S_HOTBOX_WINDOW_ERR_EXEC_FAILED_PREFIX)) + failMsg;
    hotbox_log(("hotbox exec fail: " + it.type + " " + it.name + " -> " + failMsg).c_str());
    InvalidateRect(g_hwnd, nullptr, FALSE);
}

// 自定义消息：延迟清除 g_focusingEdit。
// SetFocus(g_edit) 会让父窗口失活，触发 WM_ACTIVATE(WA_INACTIVE)——该消息可能异步送达；
// 若 SetFocus 后立即清标志，消息送达时标志已 false，会被误判为"点击外部"而关闭搜索界面。
// 用 posted 消息延迟清除：无论 WM_ACTIVATE 同步还是异步送达，处理时标志都仍为 true。
const UINT WM_APP_CLEAR_FOCUSING = WM_APP + 1;

// 聚焦 EDIT 输入框：置 g_focusingEdit 拦截其触发的父窗失活，posted 消息延迟清标志
void focusEdit() {
    if (!g_edit) return;
    g_focusingEdit = true;
    SetFocus(g_edit);
    PostMessageW(g_hwnd, WM_APP_CLEAR_FOCUSING, 0, 0);
}

// EDIT 子类化：拦截 Enter/Esc/↑↓（IME 输入仍走 EDIT 默认处理）
LRESULT CALLBACK EditSubclass(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    // 吞掉 Enter 的 WM_CHAR：Enter 语义已在 WM_KEYDOWN 处理（执行/绑定/返回），
    // 但消息泵的 TranslateMessage 会把 WM_KEYDOWN 翻译成 WM_CHAR('\r') 投回 EDIT，
    // 单行 EDIT 收到无法插入的 CR 会 MessageBeep——每次按 Enter 应用响一声系统
    // 提示音的来源。不进旧过程即无声。
    if (msg == WM_CHAR && wp == VK_RETURN) return 0;
    // 按住 Alt 时字符键发 WM_SYSCHAR（EDIT 默认不插入文本）：搜索模式中转插字符，
    // 让用户保持 Alt 也能连续输入（大小写同 applyCase，尊重 CapsLock/Shift）；
    // EM_REPLACESEL 不触发 EN_CHANGE，手动走父窗口查询更新
    if (msg == WM_SYSCHAR && g_mode == Mode::kSearch) {
        if (wp >= 0x20 && wp != 0xFFFF) {
            wchar_t c = applyCase((wchar_t)wp);
            wchar_t s[2] = { c, 0 };
            SendMessageW(hwnd, EM_REPLACESEL, TRUE, (LPARAM)s);
            SendMessageW(g_hwnd, WM_COMMAND,
                         MAKEWPARAM((WORD)GetDlgCtrlID(hwnd), EN_CHANGE), (LPARAM)hwnd);
        }
        return 0;
    }
    if (msg == WM_KEYDOWN) {
        if (g_mode == Mode::kSearch) {
            // 搜索模式：↑↓ 移动选中行；Enter 执行；Esc 回手势模式
            if (wp == VK_DOWN || wp == VK_UP) {
                // 选中行环绕（wrapSel，与滚轮同口径）：末行继续 ↓ → 首行；首行继续 ↑ →
                // 整个结果列表的末行（非可视窗口底部）；可视窗口经 ensureSelVisible
                // 贴边跟随。单条结果时环绕回自身 → 不重绘。
                int next = hotbox::wrapSel(g_resultSel, wp == VK_DOWN ? 1 : -1,
                                           (int)g_results.size());
                if (next != g_resultSel) {
                    g_resultSel = next;
                    ensureSelVisible();
                    InvalidateRect(g_hwnd, nullptr, FALSE);
                }
                return 0;
            }
            if (wp == VK_RETURN) {
                // 绑定模式：Enter 把当前结果绑定到手势环槽位；否则正常执行
                if (g_bindingSlot >= 0) bindCurrentResultToSlot();
                else executeSearchItem(g_resultSel);
                return 0;
            }
            if (wp == VK_ESCAPE) {
                // 批量应用中：先中止余层（已应用层可 Ctrl+Z 回退），再走常规 Esc 行为
                abortBatch();
                // Esc 离开搜索模式：停止高度动画，防下一 tick 残留插值 SetWindowPos
                // 把刚切回的设置面板高度覆盖成旧搜索高度（对照 backToGesture/doHide 的复位）
                g_inHeightAnim = false;
                // 搜索模式 Esc：绑定流程（来自设置）→ 回设置面板；否则直接退出热盒——
                // UX：Esc = 关闭，不再回退手势环一级菜单（与 PopupWndProc 的 Esc 分发同步，
                // 姊妹契约）。渐隐退场后会话状态由 doHide 复位 + window_showAt 弹出时
                // 权威复位，双保险；窗口高度也由 showAt 的 SetWindowPos 每次重设
                if (g_returnToSettings) {
                    g_returnToSettings = false;
                    g_mode = Mode::kSettings;
                    g_settingsSel = 0;
                    animStart(1);   // 回设置面板展开动画
                    g_bindingSlot = -1;
                    g_filterMenuOpen = false;
                    g_filterHover = -1;
                    g_filterBtnHover = false;
                    g_rowHover = -1;
                    g_pinned = true;   // 回设置面板保持常驻
                    if (g_edit) ShowWindow(g_edit, SW_HIDE);
                    // 改 setSettingsWindowSize（kSetWinH 紧凑高 + 工作区钳制）——
                    // 对齐 bindCurrentResultToSlot 的同语义出口；restoreGestureWindow
                    // 恢复 440 全高，设置面板固定按 kSetWinH 绘制，其下空白透明区（视觉残缺）
                    setSettingsWindowSize();
                    InvalidateRect(g_hwnd, nullptr, FALSE);
                } else {
                    window_hide();
                }
                return 0;
            }
        } else {
            if (wp == VK_RETURN) {
                int idx = g_sel >= 0 ? g_sel : 0;
                window_execute(idx);
                return 0;
            }
            if (wp == VK_ESCAPE) {
                window_hide();
                return 0;
            }
        }
    }
    // 鼠标点击/拖选 EDIT 时：触发父窗口重绘以同步 D2D 选中态（EDIT alpha=0 不可见，
    // 选中变化不会自动通知父窗口重绘；GetCapture()==hwnd 限定拖选中才响应 mousemove）
    LRESULT r = CallWindowProcW(g_editOldProc, hwnd, msg, wp, lp);
    if (g_mode == Mode::kSearch &&
        (msg == WM_LBUTTONDOWN || msg == WM_LBUTTONUP ||
         (msg == WM_MOUSEMOVE && GetCapture() == hwnd))) {
        InvalidateRect(g_hwnd, nullptr, FALSE);
    }
    return r;
}

LRESULT CALLBACK PopupWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_PAINT: {
            PAINTSTRUCT ps;
            BeginPaint(hwnd, &ps);
            paint(hwnd);
            EndPaint(hwnd, &ps);
            return 0;
        }
        case WM_ERASEBKGND:
            // 背景由 paint 统一 Clear（透明色），阻止系统擦除 → 防画面闪烁
            return 1;
        case WM_SIZE:
            // 窗口尺寸变化：paint 内 resizeBmp 会同步重建 WIC 位图，这里只需触发重绘
            InvalidateRect(hwnd, nullptr, FALSE);
            return 0;
        case WM_DPICHANGED: {
            // 窗口跨 DPI 屏移动（restoreGestureWindow 按鼠标重新对齐跨屏 /
            // 显示设置改缩放比）时按新 DPI 重设尺寸。先更新内部 DPI 缓存（g_dpiScale +
            // D2D RT DPI）再换算尺寸：当前物理尺寸 / 旧 scale → DIP × 新 scale，等价于
            // 系统建议矩形（lParam）的新旧 DPI 比例换算，且对 showAt 已按目标屏 DPI
            // 预算好尺寸的路径幂等（此时比例=1，不会二次缩放）；位置保持当前值——
            // 环心/搜索栏对鼠标的定位不漂移（建议矩形位置按拖拽锚点语义重定位）。
            // 搜索模式还须重排 EDIT 子窗口物理位置。不处理则窗口保持旧屏物理尺寸
            // （新屏上整体偏大/偏小）且 dipOf 命中测试持续错位。
            UINT dpi = HIWORD(wp);
            if (dpi >= 96) {
                float oldScale = g_dpiScale;
                g_dpiScale = (float)dpi / 96.0f;
                if (g_rt) g_rt->SetDpi((float)dpi, (float)dpi);
                RECT wr;
                GetWindowRect(hwnd, &wr);
                int pW = (int)(((wr.right - wr.left) / oldScale) * g_dpiScale + 0.5);
                int pH = (int)(((wr.bottom - wr.top) / oldScale) * g_dpiScale + 0.5);
                SetWindowPos(hwnd, nullptr, wr.left, wr.top, pW, pH,
                             SWP_NOZORDER | SWP_NOACTIVATE);
                if (g_mode == Mode::kSearch && g_edit && IsWindowVisible(g_edit)) {
                    MoveWindow(g_edit, phys(g_editX), phys(kBarY + 8),
                               phys(g_editW), phys(kBarH - 12), TRUE);
                }
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            return 0;
        }
        case WM_MOUSEMOVE: {
            // 鼠标消息坐标是物理像素；命中测试用 DIP（kCx/kBarY 等常量），需除 scale
            POINT ptRaw = { (short)LOWORD(lp), (short)HIWORD(lp) };
            POINT pt = { dipOf(ptRaw.x), dipOf(ptRaw.y) };
            if (g_mode == Mode::kSearch) {
                // 列表高度拖拽中：按鼠标 y 换算可见行数（3~9 行）
                if (g_draggingResize) {
                    int rows = (pt.y - kListY) / kRowH;
                    if (rows < kListRowsMin) rows = kListRowsMin;
                    if (rows > kListRowsMax) rows = kListRowsMax;
                    if (rows != g_listRows) {
                        g_listRows = rows;
                        clampScroll();   // 行数变少时滚动窗口可能越界
                        updateSearchWindowSize();   // 拖拽改行数即时长高/收缩（否则新增行被窗口裁掉）
                        InvalidateRect(hwnd, nullptr, FALSE);
                    }
                    return 0;
                }
                // 滚动条拖动中：跟随鼠标定位
                if (g_draggingScroll) {
                    scrollBarToSel(pt.y);
                    return 0;
                }
                // 过滤按钮 hover
                bool btnHover = pt.x >= kFbtnX && pt.x <= kFbtnX + g_fbtnW &&
                                pt.y >= kBarY && pt.y <= kBarY + kBarH;
                if (btnHover != g_filterBtnHover) {
                    g_filterBtnHover = btnHover;
                    InvalidateRect(hwnd, nullptr, FALSE);
                }
                // 过滤下拉 hover
                if (g_filterMenuOpen) {
                    int h = -1;
                    if (pt.x >= kListX && pt.x <= kListX + filterDropWidth() &&
                        pt.y >= kFilterDropY && pt.y < kFilterDropY + 4 * kFilterDropRowH)
                        h = (pt.y - kFilterDropY) / kFilterDropRowH;
                    if (h != g_filterHover) {
                        g_filterHover = h;
                        InvalidateRect(hwnd, nullptr, FALSE);
                    }
                } else if (g_filterHover != -1) {
                    g_filterHover = -1;
                    InvalidateRect(hwnd, nullptr, FALSE);
                }
                // 结果行 hover
                int row = -1;
                if (pt.y >= kListY && pt.y < kListY + displayRows() * kRowH &&
                    pt.x >= kListX && pt.x <= kListX + kListW) {
                    int idx = (pt.y - kListY) / kRowH + scrollTop();
                    if (idx < (int)g_results.size()) row = idx;
                }
                if (row != g_rowHover) {
                    g_rowHover = row;
                    InvalidateRect(hwnd, nullptr, FALSE);
                }
                // 状态行 hover（g_msg 非空时）：展开完整消息气泡；TRACKMOUSEEVENT
                // 一次性生效，hover 期间持续重置，鼠标离开窗口收起（WM_MOUSELEAVE）
                bool stHover = !g_msg.empty() &&
                               pt.x >= kListX && pt.x <= kListX + kListW &&
                               pt.y >= statusY() && pt.y < statusY() + 20;
                if (stHover != g_statusHover) {
                    g_statusHover = stHover;
                    InvalidateRect(hwnd, nullptr, FALSE);
                }
                if (g_statusHover) {
                    TRACKMOUSEEVENT tme = {};
                    tme.cbSize = sizeof(tme);
                    tme.dwFlags = TME_LEAVE;
                    tme.hwndTrack = hwnd;
                    TrackMouseEvent(&tme);
                }
                return 0;
            }
            if (g_mode == Mode::kSettings) {
                // 设置面板行 hover：与点击命中一致（行内横向全宽）
                int row = -1;
                if (pt.y >= kSetRowY0 && pt.x >= 20 && pt.x <= kWinW - 20) {
                    row = (pt.y - kSetRowY0) / kSetRowH;
                    if (row >= kSetRows) row = -1;
                }
                if (row != g_setHover) {
                    g_setHover = row;
                    InvalidateRect(hwnd, nullptr, FALSE);
                }
                return 0;
            }
            if (g_mode == Mode::kProgress) return 0;   // 进度卡片无 hover 交互
            // 松手停留态已释放方向跟踪捕获：按住鼠标拖出窗外再松手收不到 WM_LBUTTONUP，
            // 下压反馈会滞留在弧段/中心圆/花瓣上。鼠标消息自带的按钮状态为「未按下」即清
            //（按住拖拽中 MK_LBUTTON 置位，不误清）。按住手势捕获在身、UP 必达，无此路径
            if (g_releaseStay && !(wp & MK_LBUTTON) &&
                (g_pressIdx >= 0 || g_centerPressed || g_capPress >= 0)) {
                g_pressIdx = -1;
                g_centerPressed = false;
                g_capPress = -1;
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            // 常规 hover 更新（子菜单展开中也照常执行：花瓣显隐由弧段选中驱动，见下）
            bool cHover = inCenter(pt);
            int idx = cHover ? -1 : hitSegmentAt(pt);
            // 停留态：环带外不选中——悬停高亮须与点击口径一致，否则出现「弧段高亮着、
            // 点下去却是关闭」。截图弧段列例外：花瓣在环带外（r 135~185），该列命中域
            // 必须保持无外径上限，否则鼠标瞄花瓣稍微越界即反复展开/收起（同因）
            if (g_releaseStay && idx >= 0 && idx != kCaptureSlot && beyondRingBand(pt)) idx = -1;
            if (cHover != g_centerHover || idx != g_sel) {
                g_centerHover = cHover;
                g_sel = idx;
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            // 花瓣显隐由截图弧段选中驱动：选中（g_sel==kCaptureSlot）→ 展开，
            // 未选中 → 收起。hitSegmentAt 的命中域是弧段角度列（无外径上限，天然
            // 覆盖花瓣环带及其上方），边界与弧段选中完全一致。旧楔形区域
            //（inCapRegion）在花瓣外缘有外径边界（r=185）：不可见的空地边界，
            // 鼠标瞄准花瓣向外/斜向稍微越界即反复穿越，引发展开/收起闪烁
            //（消失的花瓣正是被瞄准的那瓣）
            bool capWant = (idx == kCaptureSlot);
            if (capWant != g_capMenu) {
                g_capMenu = capWant;
                g_capSel = -1;
                g_capPress = -1;
                if (capWant) {
                    g_capOpenMs = GetTickCount64();
                    // 展开动画需定时器驱动重绘（各动画启动点各自 SetTimer 的既定模式）：
                    // 不启动则仅本次 InvalidateRect 画一帧 t≈0（三瓣全被 continue 跳过），
                    // 鼠标静止无重绘 → 花瓣永不出现；移动产生的零星重绘画到哪停哪 →
                    // 快速划过时冻结在出场中间态
                    SetTimer(hwnd, kAnimTimer, animTimerMs(), nullptr);
                }
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            // 花瓣 hover（展开中才有意义）
            if (g_capMenu) {
                int c = hitCapPetal(pt);
                if (c != g_capSel) {
                    g_capSel = c;
                    InvalidateRect(hwnd, nullptr, FALSE);
                }
            }
            return 0;
        }
        case WM_MOUSELEAVE:
            // 鼠标离开窗口：收起状态行消息气泡（结果行 hover 维持既有行为，不在此处理）
            if (g_statusHover) {
                g_statusHover = false;
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            return 0;
        case WM_LBUTTONDOWN: {
            // 防连点：执行锁定期（退场动画期间）不响应点击，避免排队点击触发再次执行
            if (g_actionLock) return 0;
            // 进度卡片：错误态点击任意处关闭；进行中被上方执行锁拦截（此处兜底忽略）
            if (g_mode == Mode::kProgress) {
                if (g_progressError) window_hide();
                return 0;
            }
            // 物理像素 → DIP 用于命中测试
            POINT ptRaw = { (short)LOWORD(lp), (short)HIWORD(lp) };
            POINT pt = { dipOf(ptRaw.x), dipOf(ptRaw.y) };
            if (g_mode == Mode::kSettings) {
                // 设置面板行按下：记录按压反馈（压入动画），UP 松手在同一行才激活
                int row = (pt.y - kSetRowY0) / kSetRowH;
                if (pt.y >= kSetRowY0 && row >= 0 && row < kSetRows &&
                    pt.x >= 20 && pt.x <= kWinW - 20) {
                    g_pressRow = row;
                    g_pressStartMs = GetTickCount64();   // 按压缩入动画起始
                    // 时间驱动的压入动画需定时器持续重绘，否则只在按下一帧（t≈0 无压入）停住
                    SetTimer(hwnd, kAnimTimer, animTimerMs(), nullptr);
                    InvalidateRect(hwnd, nullptr, FALSE);
                }
                return 0;
            }
            if (g_mode == Mode::kSearch) {
                // 列表高度拖拽：分隔条按下开始调整
                if (inResizeBar(pt.x, pt.y)) {
                    g_draggingResize = true;
                    SetCapture(hwnd);
                    // 点父窗客户区会夺走 EDIT 焦点 → 打字/↑↓/Enter 静默失效（光标仍闪，
                    // 看似卡死）。与过滤按钮/下拉项/空白区兜底同口径：焦点还给 EDIT。
                    // 捕获在 hwnd 上、与焦点无关，拖拽不受 SetFocus 影响。
                    focusEdit();
                    return 0;
                }
                // 滚动条：按下开始拖动定位
                if (inScrollBar(pt.x, pt.y)) {
                    g_draggingScroll = true;
                    SetCapture(hwnd);   // 拖出窗外松开也须收到 WM_LBUTTONUP（与分隔条拖拽一致）
                    scrollBarToSel(pt.y);
                    focusEdit();   // 滚动条按下同样会夺走 EDIT 焦点 → 立即还给 EDIT（同分隔条）
                    return 0;
                }
                // 过滤按钮：切换下拉
                if (pt.x >= kFbtnX && pt.x <= kFbtnX + g_fbtnW &&
                    pt.y >= kBarY && pt.y <= kBarY + kBarH) {
                    g_filterMenuOpen = !g_filterMenuOpen;
                    g_filterHover = -1;
                    if (g_filterMenuOpen) {
                        // 下拉展开动画：重置进度与起始时间；主动画已停则重启计时器（运行中 SetTimer 同 id 无害）
                        g_dropT = 0.0;
                        g_dropStartMs = GetTickCount64();
                        if (g_animDir == 0) SetTimer(hwnd, kAnimTimer, animTimerMs(), nullptr);
                    }
                    updateSearchWindowSize();   // 下拉展开/收起时调整窗口高度，防无搜索内容时被裁切
                    InvalidateRect(hwnd, nullptr, FALSE);
                    focusEdit();   // 保持焦点在 EDIT（Enter 始终可用）
                    return 0;
                }
                // 下拉项点击：设过滤类型并收起
                if (g_filterMenuOpen &&
                    pt.x >= kListX && pt.x <= kListX + filterDropWidth() &&
                    pt.y >= kFilterDropY && pt.y < kFilterDropY + 4 * kFilterDropRowH) {
                    static const char* kFilterTypes[4] = { "all", "effect", "script", "preset" };
                    int i = (pt.y - kFilterDropY) / kFilterDropRowH;
                    g_filterType = kFilterTypes[i];
                    g_filterMenuOpen = false;
                    g_filterHover = -1;
                    rerunQuery();
                    InvalidateRect(hwnd, nullptr, FALSE);
                    focusEdit();
                    return 0;
                }
                // 列表行点击：绑定模式下绑定到槽位；否则选中并立即执行（FXConsole 风格：单击即应用）
                int row = (pt.y - kListY) / kRowH;
                if (pt.y >= kListY && row >= 0 && row < displayRows() &&
                    pt.x >= kListX && pt.x <= kListX + kListW) {
                    int idx = row + scrollTop();
                    if (idx < (int)g_results.size()) {
                        // 底边呼出时整窗上移，鼠标可能正压在结果行上；双击中心圆的第二击会落到这里
                        // （窗口类未设 CS_DBLCLKS，第二击仍是 WM_LBUTTONDOWN）。进入后短时间且鼠标
                        // 没动过 → 视为同一记双击的第二击，吞掉（不执行/不绑定）。
                        POINT cur = { 0, 0 };
                        GetCursorPos(&cur);
                        if (GetTickCount64() - g_searchEnterMs < kSearchClickGraceMs &&
                            cur.x == g_searchEnterPt.x && cur.y == g_searchEnterPt.y) {
                            focusEdit();
                            return 0;
                        }
                        g_resultSel = idx;
                        if (g_bindingSlot >= 0) bindCurrentResultToSlot();
                        else executeSearchItem(idx);
                    }
                    // 点列表行同样会夺走 EDIT 焦点 → 打字/↑↓/Enter 静默失效。
                    // 仅"仍停在搜索态且窗口未退场"时还给 EDIT（与下方空白区兜底同口径）：
                    // 绑定成功切回手势环/设置面板（g_mode 改变）、执行成功开始渐隐（g_animDir<0；
                    // window_hide 是异步退场，g_visible 到 doHide 才复位）、预设批量转进度卡片
                    // （g_mode=kProgress）三种情形都不强抢焦点。
                    if (g_mode == Mode::kSearch && g_visible && g_animDir >= 0) focusEdit();
                    return 0;
                }
                // 兜底：未命中过滤按钮/下拉项/列表行（空白区）→ 焦点还给 EDIT
                focusEdit();
            } else if (inCenter(pt)) {
                // 手势模式中心圆按下：记录按下反馈（放大 + 白描边），UP 松手在圆内才进入搜索
                g_centerPressed = true;
                g_pressStartMs = GetTickCount64();   // 按压动画起始
                // 时间驱动的放大动画需定时器持续重绘，否则只在按下一帧（t≈0 无放大）停住
                SetTimer(hwnd, kAnimTimer, animTimerMs(), nullptr);
                InvalidateRect(hwnd, nullptr, FALSE);
            } else {
                // 子菜单展开中：花瓣按下记录按压反馈（完整点击语义，UP 在同一瓣
                // 才执行）；截图弧段本体/间隙按下无动作（子菜单由弧段选中驱动显隐）
                if (g_capMenu) {
                    int c = hitCapPetal(pt);
                    if (c >= 0) {
                        g_capPress = c;
                        g_pressStartMs = GetTickCount64();   // 按压动画起始
                        SetTimer(hwnd, kAnimTimer, animTimerMs(), nullptr);
                        InvalidateRect(hwnd, nullptr, FALSE);
                    }
                    return 0;
                }
                // 手势模式弧段按下：记录按下态（显示压入反馈），UP 松手在段内才执行
                int idx = hitSegmentAt(pt);
                // 停留态：环带外按下不报弧段（与悬停/点击同口径，不亮压入反馈）
                if (g_releaseStay && idx >= 0 && idx != kCaptureSlot && beyondRingBand(pt)) idx = -1;
                if (idx >= 0) {
                    g_pressIdx = idx;
                    g_pressStartMs = GetTickCount64();   // 按压动画起始
                    // 时间驱动的压入动画需定时器持续重绘，否则只在按下一帧（t≈0 无压入）停住
                    SetTimer(hwnd, kAnimTimer, animTimerMs(), nullptr);
                    InvalidateRect(hwnd, nullptr, FALSE);
                }
            }
            return 0;
        }
        case WM_MOUSEWHEEL: {
            // 搜索模式：滚一格 = 选中行移一行（与 ↑↓ 同口径 wrapSel，含首/末行环绕）。
            // 选中在可视窗口内移动；已贴边继续滚 → 窗口滚动一行，选中仍为下一个
            if (g_mode != Mode::kSearch || g_results.empty()) return 0;
            int delta = GET_WHEEL_DELTA_WPARAM(wp);
            bool up = (delta > 0);
            int next = hotbox::wrapSel(g_resultSel, up ? -1 : 1, (int)g_results.size());
            if (next != g_resultSel) {
                g_resultSel = next;
                ensureSelVisible();   // 越界时窗口贴边滚动一行
            }
            g_rowHover = -1;
            InvalidateRect(hwnd, nullptr, FALSE);
            return 0;
        }
        case WM_LBUTTONUP: {
            // 失败提示驻留期忽略环上点击动作（最小交互语义——只允许按热键
            // 重新召唤/Esc/点击浮窗外部关闭）。UP 无 g_actionLock 守卫，且 executeSelected
            // 的锁守卫在 kCategory/kSettings 分支之后，不在此拦截会从 UP 漏进导航转场
            if (g_failActive) return 0;
            if (g_draggingResize) {   // 列表高度拖拽结束
                g_draggingResize = false;
                ReleaseCapture();
                return 0;
            }
            if (g_draggingScroll) {   // 滚动条拖动结束
                g_draggingScroll = false;
                ReleaseCapture();   // 对应按下时的 SetCapture
                return 0;
            }
            // 手势模式：松手在弧段即执行（中心圆切入已在 DOWN 完成）；清除按下反馈
            hotbox_log(("LBUTTONUP mode=" + std::to_string((int)g_mode) +
                        " animDir=" + std::to_string(g_animDir)).c_str());
            if (g_mode == Mode::kSettings) {
                // 设置面板：松手在同一行内才激活（槽位绑定 / 热键录制）
                bool hadPress = (g_pressRow >= 0);
                int pressRow = g_pressRow;
                g_pressRow = -1;
                if (hadPress) InvalidateRect(hwnd, nullptr, FALSE);
                POINT ptRaw = { (short)LOWORD(lp), (short)HIWORD(lp) };
                POINT pt = { dipOf(ptRaw.x), dipOf(ptRaw.y) };
                int row = (pt.y - kSetRowY0) / kSetRowH;
                if (pressRow >= 0 && row == pressRow && pt.y >= kSetRowY0 &&
                    pt.x >= 20 && pt.x <= kWinW - 20) {
                    g_settingsSel = row;
                    settingsActivate();
                }
                return 0;
            }
            if (g_mode != Mode::kGesture) return 0;
            POINT ptCapRaw = { (short)LOWORD(lp), (short)HIWORD(lp) };
            POINT ptCap = { dipOf(ptCapRaw.x), dipOf(ptCapRaw.y) };
            if (g_capMenu) {
                // 子菜单完整点击语义（与一级弧段一致）：花瓣按下 → 松手仍在同一瓣
                // 才执行；其他松开（弧段本体/间隙/瓣间移动）只清按压态，不收起不退出
                //（子菜单由 MOUSEMOVE 的移出收起管理）。坐标走本分支自有的 ptCap
                int pressCap = g_capPress;
                g_capPress = -1;
                if (pressCap >= 0) {
                    if (hitCapPetal(ptCap) == pressCap) {
                        g_capMenu = false;   // 执行前收起（反馈气泡由 executeCapture 的 g_pinned 驻留）
                        g_capSel = -1;
                        executeCapture(pressCap);
                    } else {
                        InvalidateRect(hwnd, nullptr, FALSE);   // 按压反馈复位重绘
                    }
                } else if (g_releaseStay && beyondPetalBand(ptCap)) {
                    // 停留态：花瓣展开中点花瓣环带外（无花瓣按下）同空白区语义 → 关闭。
                    // pressCap >= 0 分支优先：按下花瓣后移出为「取消」，不关窗；花瓣环带内
                    // （含瓣间 2° 缝）也不关，防瞄准花瓣的轻微偏差把浮窗关掉
                    hotbox_log("LBUTTONUP: beyond petal band (releaseStay, capMenu) -> hide");
                    window_hide();
                }
                return 0;
            }
            bool hadPress = (g_pressIdx >= 0) || g_centerPressed;
            bool pressCenter = g_centerPressed;
            int wasPressIdx = g_pressIdx;   // 点击执行路径判断"同段已在播按压动画"用
            g_pressIdx = -1;
            g_centerPressed = false;
            if (hadPress) InvalidateRect(hwnd, nullptr, FALSE);
            POINT ptRaw = { (short)LOWORD(lp), (short)HIWORD(lp) };
            POINT pt = { dipOf(ptRaw.x), dipOf(ptRaw.y) };
            // 中心圆：按下后松手仍在圆内 → 进入搜索模式（反馈动画已播完可见）
            if (pressCenter && inCenter(pt)) {
                hotbox_log("window: center released in circle -> search mode");
                enterSearchMode("");
                return 0;
            }
            int idx = inCenter(pt) ? -1 : hitSegmentAt(pt);
            // 停留态：环带外点击不作弧段命中（截图弧段列同样不例外）——落入下方空白区分支
            // 关闭。花瓣展开时由上方花瓣分支先行处理：点中花瓣仍是执行截图动作
            if (g_releaseStay && idx >= 0 && beyondRingBand(pt)) idx = -1;
            hotbox_log(("LBUTTONUP hit idx=" + std::to_string(idx)).c_str());
            // 点击执行：DOWN 已在同段播按压动画 → alreadyPressed=true 让动画无缝继续
            //（重置起点会"弹一下"）；不经 window_execute（公共 API 无该上下文）
            if (idx >= 0) {
                executeSelected(idx, /*alreadyPressed=*/ idx == wasPressIdx);
            } else if (g_releaseStay && !inCenter(pt)) {
                // 松手停留（设置行6）态下的空白区点击 = 关闭：命中测试为 -1 的区域是
                // 「环内空洞」（中心圆 r=36 与内环 r=62 之间）、「弧段间隙」（段间 2° 缝、
                // 设置段两侧空隙）与「环带外透明区」（r > kROut，见上方命中收窄）——
                // 前两处在按住手势里本就表示「不选、退出」（松手即关），停留态改鼠标
                // 操作后同语义；环带外则是停留态新增的收窄（按住手势在那里按角度执行）。
                // 不处理则该点击被 TOPMOST 窗吞掉且无反应（用户看到的是"点了没动静"）
                hotbox_log("LBUTTONUP: blank area (releaseStay) -> hide");
                window_hide();
            }
            return 0;
        }
        case WM_CTLCOLOREDIT: {
            // ULW + WS_EX_TRANSPARENT：EDIT 不绘制背景，只绘制文字和光标，
            // D2D 位图的搜索栏背景透过 EDIT 显示
            HDC hdc = (HDC)wp;
            SetTextColor(hdc, RGB((int)(g_theme.text.r * 255.0f),
                                  (int)(g_theme.text.g * 255.0f),
                                  (int)(g_theme.text.b * 255.0f)));
            SetBkMode(hdc, TRANSPARENT);
            return (LRESULT)GetStockObject(NULL_BRUSH);
        }
        case WM_COMMAND: {
            // EDIT 文本变化（EN_CHANGE）→ 更新查询并实时重跑
            if ((HWND)lp == g_edit && HIWORD(wp) == EN_CHANGE && g_mode == Mode::kSearch) {
                wchar_t buf[1024];
                GetWindowTextW(g_edit, buf, 1024);
                g_query = wideToUtf8(buf);
                rerunQuery();
                g_resultSel = 0;
                g_scrollTop = 0;
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            return 0;
        }
        case WM_KEYDOWN:
            if (g_recordingHotkey) {
                recordHotkeyKey(hwnd, (int)wp, lp);
                return 0;
            }
            if (wp == VK_ESCAPE) {
                if (g_mode == Mode::kProgress) {
                    // 进度卡片 Esc（进行中/错误态均直接关闭）：
                    // 静默中止余层（已应用层可 Ctrl+Z 回退），渐隐关闭
                    abortBatch(true);
                    window_hide();
                    return 0;
                }
                // 批量应用中：先中止余层（已应用层可 Ctrl+Z 回退），再走常规 Esc 行为
                abortBatch();
                if (g_mode == Mode::kSearch) {
                    // 搜索模式 Esc：绑定流程（来自设置）→ 回设置面板；否则直接退出热盒——
                    // UX：Esc = 关闭，不再回退手势环一级菜单（与 EditSubclass 的 Esc 分发
                    // 同步，姊妹契约）。渐隐退场后会话状态由 doHide 复位 + window_showAt
                    // 弹出时权威复位，双保险
                    if (g_returnToSettings) {
                        g_returnToSettings = false;
                        g_bindingSlot = -1;
                        g_mode = Mode::kSettings;
                        g_settingsSel = 0;
                        animStart(1);   // 回设置面板展开动画
                        g_filterMenuOpen = false;
                        g_filterHover = -1;
                        g_filterBtnHover = false;
                        g_rowHover = -1;
                        g_pinned = true;   // 回设置面板保持常驻
                        if (g_edit) ShowWindow(g_edit, SW_HIDE);
                        // 改 setSettingsWindowSize（与 EditSubclass 姊妹同步，
                        // 对齐 bindCurrentResultToSlot——kSetWinH 紧凑高 + 工作区钳制）
                        setSettingsWindowSize();
                        InvalidateRect(hwnd, nullptr, FALSE);
                    } else {
                        window_hide();
                    }
                } else if (g_mode == Mode::kSettings) {
                    backToGesture();
                } else {
                    window_hide();
                }
                return 0;
            }
            if (g_mode == Mode::kSettings) {
                // 设置面板导航：↑↓ 选择、Enter 进入（槽位绑定 / 热键录制 / 两个松手开关）
                if (wp == VK_DOWN) {
                    if (g_settingsSel < kSetRows - 1) ++g_settingsSel;
                    InvalidateRect(hwnd, nullptr, FALSE);
                    return 0;
                }
                if (wp == VK_UP) {
                    if (g_settingsSel > 0) --g_settingsSel;
                    InvalidateRect(hwnd, nullptr, FALSE);
                    return 0;
                }
                if (wp == VK_RETURN) {
                    settingsActivate();
                    return 0;
                }
            } else if (g_mode == Mode::kGesture) {
                // 手势模式按字母/数字键 → 直接进入二级搜索菜单并预填该字符
                // 执行锁守卫（与 WM_LBUTTONDOWN 对齐）——Esc 渐隐 150ms
                // 内 g_mode 仍为 kGesture（doHide 在渐隐完成才复位）且 g_actionLock
                // =true，无守卫时字母键进 enterSearchMode → animStart(1) 反转退场
                // 动画 → 正向完成分支不调 doHide → 锁永久滞留，搜索面板 Enter/
                // 点击行全部静默失效；按压 90ms 武装期内同样拦（防误执行）
                if (g_actionLock) return 0;
                gestureKeyToSearch((int)wp);
                return 0;
            }
            return 0;
        case WM_SYSKEYDOWN:
            // Alt 组合键的功能键发 WM_SYSKEYDOWN（lParam bit29=1）：录制时必须处理，
            // 否则按 Alt+Q 时 Q 不经过 WM_KEYDOWN，录制"没反应"；且不走默认处理可避免系统菜单音
            if (g_recordingHotkey) {
                recordHotkeyKey(hwnd, (int)wp, lp);
                return 0;
            }
            // 手势模式按住 Alt 时字母键同样发 WM_SYSKEYDOWN（用户须按住 Alt 保持一级菜单）：
            // 直接进入二级搜索并预填该字符，否则"按字母没反应"
            // 执行锁守卫（同 WM_KEYDOWN 手势分支，与 WM_LBUTTONDOWN 对齐）
            if (g_mode == Mode::kGesture) {
                if (g_actionLock) return 0;
                gestureKeyToSearch((int)wp);
                return 0;
            }
            return DefWindowProc(hwnd, msg, wp, lp);
        case WM_TIMER:
            if (wp == kCheckFgTimer) {
                // 失活延迟检查（点击外部关闭）：50ms 后前台窗口已确定——
                // 前台仍是本窗/EDIT → SetFocus 幽灵失活，不关；前台已是其他窗口 → 点击外部，关闭。
                // 批量进行中不关（脚本后 AE 收回前台属虚假失活，见 WM_ACTIVATE 注释）
                KillTimer(hwnd, kCheckFgTimer);
                if (g_pendingHideCheck) {
                    g_pendingHideCheck = false;
                    HWND fg = GetForegroundWindow();
                    bool fgIsOurs = (fg == g_hwnd) ||
                                    (g_edit && (fg == g_edit || IsChild(g_hwnd, fg)));
                    if (g_visible && g_capturing) {
                        // 捕获/保存对话框进行中 → 不自动隐藏（失败回执
                        // 必须留在可见面板上，见 g_capturing 声明注释）
                        hotbox_log("WM_ACTIVATE deferred: capturing -> keep visible");
                    } else if (g_visible && !fgIsOurs && !g_batch.active) {
                        hotbox_log("WM_ACTIVATE deferred: fg not ours -> hide");
                        window_hide();
                    }
                }
                return 0;
            }
            if (wp == kRecordHintTimer) {
                // 热键录制静默超时：录制已结束（成功应用/Esc 取消）→ 自清；静默满
                // kRecordHintMs → 停表重绘一次（提示区改显「按键无反应 = 该组合已被其他
                // 程序占用」，见 paintSettings 的 tip 选择）
                if (!g_recordingHotkey) {
                    KillTimer(g_hwnd, kRecordHintTimer);
                    g_recordStartMs = 0;
                    return 0;
                }
                if (g_recordStartMs && GetTickCount64() - g_recordStartMs >= kRecordHintMs) {
                    KillTimer(g_hwnd, kRecordHintTimer);
                    InvalidateRect(g_hwnd, nullptr, FALSE);
                }
                return 0;
            }
            if (wp == kFailTimer) {
                // 失败提示停留到点：走既有退场流程（window_hide → 渐隐 → doHide），
                // 不另造隐藏路径。校验三重：计时器已武装（g_failTimerGen!=0）、代际与当前
                // 驻留一致（cancelFailDwell 自增 g_failGen 使旧计时器语义作废）、已过时长
                // 足够（KillTimer+SetTimer 同 id 时可能残留已入队的旧消息，早到 tick 按
                // 剩余时长重排而不是把刚重新召唤/重新驻留的面板提前关掉）
                KillTimer(hwnd, kFailTimer);
                if (!g_failActive || g_failTimerGen == 0 || g_failTimerGen != g_failGen) return 0;
                ULONGLONG elapsed = GetTickCount64() - g_failStartMs;
                if (elapsed + 60 < kFailDwellMs) {
                    SetTimer(hwnd, kFailTimer, (UINT)(kFailDwellMs - elapsed), nullptr);
                    return 0;
                }
                window_hide();   // 既有退场：渐隐 150ms → doHide（其中清失败态）
                return 0;
            }
            if (wp == kExecTimer) {
                // 按压动画播完 → 触发真实执行（executeSelected 已置 g_actionLock 与 g_pendingExec）
                KillTimer(hwnd, kExecTimer);
                doExecPendingItem();
                return 0;
            }
            if (wp == kBatchTimer) {
                // 预设批量：每次应用一整块（隔离选区 → 块内自开自闭 undo group →
                // 一次 applyPreset 应用于块内全部层，ffx 每块只解析一次；
                // 块间 kBatchTickMs 让 AE 消息泵喘息，不假死）
                KillTimer(hwnd, kBatchTimer);
                if (!g_batch.active) return 0;
                if (!g_visible) {   // 防御：窗口已隐藏（正常路径关窗前已 abort）
                    batchFinish(false, Tr(S_HOTBOX_WINDOW_BATCH_WINDOW_CLOSED));
                    return 0;
                }
                int total = (int)g_batch.layers.size();
                int end = g_batch.next + presetChunkSize(total);
                if (end > total) end = total;
                bool last = (end >= total);
                std::vector<int> chunk(g_batch.layers.begin() + g_batch.next,
                                       g_batch.layers.begin() + end);
                std::vector<int> chunkIds;
                if (g_batch.layerIds.size() == g_batch.layers.size())
                    chunkIds.assign(g_batch.layerIds.begin() + g_batch.next,
                                    g_batch.layerIds.begin() + end);
                std::string script = buildPresetChunkScript(
                    g_batch.item.key, g_batch.item.name, chunk, chunkIds, g_batch.compId, last,
                    g_batch.layers, g_batch.layerIds);   // 末块按原快照恢复选区（优先按 id）
                std::string result, errMsg;
                bool ok = aeexec_runScript(script, &result, &errMsg);
                json::Value v;
                bool parsed = ok && json::parse(result.c_str(), result.size(), &v);
                std::string st = parsed ? v["status"].str : "";
                if (st == "success") {
                    g_batch.applied += (int)chunk.size();
                } else if (st == "error") {
                    // 整块失败：继续其余块（与逐层收集语义一致，块内无法区分到层）
                    g_batch.failed += (int)chunk.size();
                    if (g_batch.firstError.empty())
                        g_batch.firstError = v["message"].str.empty()
                                                 ? std::string(Tr(S_HOTBOX_WINDOW_ERR_APPLY_FAILED))
                                                 : v["message"].str;
                } else {   // abort / 脚本级失败 / 未知返回：中止余块
                    batchFinish(false, parsed ? v["message"].str
                                               : (errMsg.empty()
                                                      ? std::string(Tr(S_HOTBOX_WINDOW_ERR_EXEC_CALL_FAILED))
                                                      : errMsg));
                    return 0;
                }
                g_batch.next = end;
                if (g_batch.next >= total) {
                    batchFinish(true, "");
                    return 0;
                }
                g_msg = trFormat(S_HOTBOX_WINDOW_STATUS_APPLY_PROGRESS, g_batch.next, total);
                SetTimer(hwnd, kBatchTimer, kBatchTickMs, nullptr);
                InvalidateRect(hwnd, nullptr, FALSE);
                return 0;
            }
            if (wp == kAnimTimer) {
                // 时间驱动推进：按墙钟 elapsed 插值 phase（tick 间隔不均也不拖慢/跳帧）
                ULONGLONG now = GetTickCount64();
                if (g_animDir != 0) {
                    if (g_animDir > 0) {
                        g_animPhase = clamp01((double)(now - g_animStartMs) / kAnimMs);
                        if (g_animPhase >= 1.0) {
                            g_animPhase = 1.0;
                            g_animDir = 0;
                            // 入场动画结束
                            // 搜索模式入场完成：显示 EDIT 输入框并聚焦（原生子窗口不随 D2D 动画）
                            if (g_mode == Mode::kSearch && g_edit) {
                                ShowWindow(g_edit, SW_SHOWNOACTIVATE);   // 不激活直接显示，防输入框绘制闪烁
                                focusEdit();
                            }
                        }
                    } else {
                        g_animPhase = 1.0 - clamp01((double)(now - g_animStartMs) / kAnimMs);
                        if (g_animPhase <= 0.0) {
                            g_animPhase = 0.0;
                            g_animDir = 0;
                            KillTimer(hwnd, kAnimTimer);
                            doHide();
                            InvalidateRect(hwnd, nullptr, FALSE);
                            return 0;
                        }
                    }
                }
                bool needTimer = g_animDir != 0;
                // 按压动画（弧段/设置行/中心圆）未完成：继续驱动重绘
                if ((g_pressIdx >= 0 || g_pressRow >= 0 || g_centerPressed || g_capPress >= 0) &&
                    (double)(now - g_pressStartMs) < kPressMs)
                    needTimer = true;
                // 子菜单花瓣弹出动画（逐瓣 30ms 级联，最长 160+60ms）：继续驱动重绘
                if (g_capMenu &&
                    (double)(now - g_capOpenMs) < kCapAnimMs + 60.0)
                    needTimer = true;
                if (g_filterMenuOpen && g_dropT < 1.0) {
                    g_dropT = clamp01((double)(now - g_dropStartMs) / kDropMs);
                    if (g_dropT >= 1.0) g_dropT = 1.0;
                    else needTimer = true;
                }
                // 搜索面板窗口高度过渡：结果数变化时窗口高度按 easeOutCubic 插值（先快后慢）
                // 顶部 top 沿用当前窗口位置（搜索栏已对鼠标，高度变化只向下生长/收缩）
                // g_mode 守卫（双保险）：退出搜索模式的路径若漏复位 g_inHeightAnim，
                // 此处也不再按搜索高度插值 SetWindowPos（防残留动画拉错其他模式窗口高度）
                if (g_inHeightAnim && g_mode == Mode::kSearch) {
                    double t = easeOutCubic(clamp01((double)(now - g_heightAnimStartMs) / kHeightAnimMs));
                    double curDip = lerp(g_heightFromH, g_heightTargetH, t);
                    int pW = phys(kWinW);
                    int pH = phys((int)(curDip + 0.5));
                    RECT wr;
                    GetWindowRect(hwnd, &wr);
                    int top = wr.top;
                    HMONITOR mon = MonitorFromPoint({ g_mouseX, g_mouseY }, MONITOR_DEFAULTTONEAREST);
                    MONITORINFO mi = {};
                    mi.cbSize = sizeof(mi);
                    GetMonitorInfoW(mon, &mi);
                    // 整面板钳制（高度动画过程中同样适用）：底边呼出时列表不出屏
                    top = hotbox::clampTopForHeight(top, pH, mi.rcWork.top, mi.rcWork.bottom);
                    SetWindowPos(hwnd, HWND_TOPMOST, wr.left, top, pW, pH, SWP_NOACTIVATE);
                    if (t >= 1.0) g_inHeightAnim = false;
                    else needTimer = true;
                }
                // 光标闪烁低频节流——搜索模式常驻期唯一需要周期重绘的是光标
                // 闪烁（2Hz 需求），needTimer 恒真会让 kAnimTimer 以半帧率（4-8ms）
                // 常驻驱动全量 D2D 渲染 + WIC CopyPixels 逐帧 memcpy（面板常驻期间单核
                // 5-15% 占用）。活跃动画（needTimer：渐入渐出/按压/下拉/高度过渡）期间
                // 维持全帧率不降频（动画 API 语义不变）；无活跃动画时把定时器重排到光标
                // 闪烁的下一个相位边界——paint 按墙钟取相位（GetTickCount()%500，前
                // 300ms 显示/后 200ms 隐藏），边界各重绘一次即 2Hz，闪烁节律不变。
                // 各动画启动点（animStart/按压/下拉/高度过渡）各自 SetTimer 全帧率
                // 重排，交互发生即时提速，无需此处补偿。
                if (g_mode == Mode::kSearch && g_visible) {
                    if (!needTimer) {
                        DWORD phase = GetTickCount() % 500;
                        UINT wait = (phase < 300) ? (300 - phase) : (500 - phase);
                        SetTimer(hwnd, kAnimTimer, wait ? wait : 1, nullptr);
                    }
                    // needTimer：活跃动画进行中，维持既有全帧率周期不降频
                } else if (!needTimer) {
                    KillTimer(hwnd, kAnimTimer);
                }
                InvalidateRect(hwnd, nullptr, FALSE);
                return 0;
            }
            return 0;
        case WM_SETCURSOR:
            // colorkey 浮窗类未设 hCursor → 不处理会沿用上一窗口（如 AE 搜索框）的 I 形光标；
            // 客户区显式设箭头，EDIT 输入区返回 FALSE 交给子窗口设 I 形
            if (LOWORD(lp) == HTCLIENT) {
                if (g_mode == Mode::kSearch && g_edit && IsWindowVisible(g_edit)) {
                    RECT er;
                    GetWindowRect(g_edit, &er);   // 物理像素
                    POINT pt;
                    GetCursorPos(&pt);   // 物理像素
                    if (PtInRect(&er, pt)) return FALSE;   // 输入框区域：EDIT 自设 I 形
                }
                // 列表高度拖拽分隔条：上下箭头光标
                if (g_mode == Mode::kSearch) {
                    POINT pt;
                    GetCursorPos(&pt);
                    ScreenToClient(hwnd, &pt);   // 物理像素（相对客户区）
                    if (inResizeBar(dipOf(pt.x), dipOf(pt.y))) {
                        SetCursor(LoadCursor(nullptr, IDC_SIZENS));
                        return TRUE;
                    }
                }
                SetCursor(LoadCursor(nullptr, IDC_ARROW));
                return TRUE;
            }
            return DefWindowProcW(hwnd, msg, wp, lp);
        case WM_ACTIVATE: {
            // 失活来源多样：真实点击外部（应关闭）/ SetFocus 内部焦点切换（不应关闭）。
            // 两种失活无法在送达瞬间可靠区分：
            //   - SetFocus(g_edit) 的"幽灵失活"延迟送达，前台仍是本窗自身；
            //   - 真实点击外部时，GetForegroundWindow 在 WM_ACTIVATE 送达瞬间可能尚未切换完成（还是本窗）。
            // 故不立即关闭：延迟 50ms 由 kCheckFgTimer 再查一次前台窗口——
            // 前台仍是本窗 → 内部焦点切换，不关；前台已是其他窗口 → 真实点击外部，关闭。
            // 另有一类"虚假失活"：AEGP 脚本执行后 AE 收回前台激活（WM_ACTIVATE(0) 在脚本返回后
            // 紧接着送达，此时鼠标也在缩小的卡片外）。批量进行中（进度卡片驻留期）必须忽略，
            // 否则卡片弹出即被误判"点击外部"关闭、批量被静默中止（applied=0）——实测日志确认此路径。
            POINT pt;
            GetCursorPos(&pt);
            RECT wr;
            GetWindowRect(g_hwnd, &wr);
            bool mouseInside = PtInRect(&wr, pt) != 0;
            HWND fg = GetForegroundWindow();
            char fgcls[64] = "", fgtitle[160] = "";
            if (fg) { GetClassNameA(fg, fgcls, 64); GetWindowTextA(fg, fgtitle, 160); }
            hotbox_log(("WM_ACTIVATE state=" + std::to_string(LOWORD(wp)) +
                        " focusing=" + std::to_string(g_focusingEdit ? 1 : 0) +
                        " inside=" + std::to_string(mouseInside ? 1 : 0) +
                        " capturing=" + std::to_string(g_capturing ? 1 : 0) +
                        " mode=" + std::to_string((int)g_mode) +
                        " fg=" + fgcls + "|" + fgtitle).c_str());
            // 捕获进行中不武装自动隐藏检查（保存对话框/渲染抢激活产生
            // 的 WA_INACTIVE 不是"点击面板外部"；豁免理由与复位点见 g_capturing 注释）
            if (LOWORD(wp) == WA_INACTIVE && g_visible && !g_focusingEdit &&
                !g_batch.active && !g_capturing) {
                g_pendingHideCheck = true;
                SetTimer(hwnd, kCheckFgTimer, 50, nullptr);
            }
            return 0;
        }
        case WM_APP_CLEAR_FOCUSING:
            // focusEdit() 的延迟清标志：SetFocus 触发的失活消息（无论同步/异步）已被处理
            g_focusingEdit = false;
            return 0;
        case WM_CAPTURECHANGED:
            // 捕获被本窗释放或外部抢走：同步状态，防残留
            g_captured = false;
            // 子菜单期间捕获被外部抢走（极罕见）→ 撤销子菜单回普通手势态，防状态悬留
            if (g_capMenu) {
                g_capMenu = false;
                g_capSel = -1;
                g_capPress = -1;
                g_pressIdx = -1;
                g_centerPressed = false;
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            return 0;
        case WM_DESTROY:
            return 0;
        default:
            return DefWindowProcW(hwnd, msg, wp, lp);
    }
}

// 清空 ULW 表面（全透明）：隐藏后调用，防下次 ShowWindow 把上一帧画面首帧上屏。
// UpdateLayeredWindow 是直调（不依赖窗口可见性），而 WM_PAINT 不是——实测隐藏窗口
// InvalidateRect + UpdateWindow 不派发 WM_PAINT（paints=0），所以各呼出路径里
// 「显示前先在隐藏态提交首帧」的 UpdateWindow 实际是空操作：ShowWindow 上屏的永远是
// 上一次提交的位图。窗口隐藏前若是搜索面板/设置面板（停留态下更是常态），呼出就会闪
// 一下旧面板。此处把位图清零提交，隐藏期间表面恒为全透明，任何时刻 ShowWindow 都无残留；
// 随后的正常 paint（可见态）再提交手势环首帧。DIB 每次 paint 都会整幅覆写，清零无副作用
static void clearLayeredSurface() {
    if (!g_hwnd || !g_memDC || !g_dib || !g_dibBits || g_bmpW <= 0 || g_bmpH <= 0) return;
    ZeroMemory(g_dibBits, (SIZE_T)g_bmpW * 4 * (SIZE_T)g_bmpH);
    SIZE sz = { g_bmpW, g_bmpH };
    POINT ptZero = { 0, 0 };
    BLENDFUNCTION bf = {};
    bf.BlendOp = AC_SRC_OVER;
    bf.SourceConstantAlpha = 255;
    bf.AlphaFormat = AC_SRC_ALPHA;
    HGDIOBJ old = SelectObject(g_memDC, g_dib);
    UpdateLayeredWindow(g_hwnd, nullptr, nullptr, &sz, g_memDC, &ptZero, 0, &bf, ULW_ALPHA);
    SelectObject(g_memDC, old);
}

// 动画退场完成后真正隐藏并复位（WM_TIMER 回调）
void doHide() {
    hotbox_log(("doHide ENTER mode=" + std::to_string((int)g_mode) +
                " animDir=" + std::to_string(g_animDir)).c_str());
    releaseMouse();   // 隐藏时释放方向跟踪捕获
    if (g_hwnd) KillTimer(g_hwnd, kExecTimer);   // 撤销待执行定时器（防隐藏后误触发）
    if (g_hwnd) KillTimer(g_hwnd, kCheckFgTimer);   // 撤销待前台检查
    if (g_hwnd) KillTimer(g_hwnd, kBatchTimer);   // 撤销批量定时器（正常路径 abort 时已 kill）
    if (g_hwnd) KillTimer(g_hwnd, kRecordHintTimer);   // 撤销录制静默提示定时器
    if (g_hwnd) KillTimer(g_hwnd, kFailTimer);   // 撤销失败提示停留计时器（防隐藏后触发）
    g_failActive = false;   // 失败驻留态随隐藏复位（文案不跨弹出残留）
    g_failMsg.clear();
    g_failStartMs = 0;
    g_failTimerGen = 0;
    g_failGen++;   // 代际自增：任何仍在途的旧 kFailTimer 消息一并作废
    g_recordStartMs = 0;
    g_batch = {};   // 防御：清批量状态（正常路径关窗前已 abort 并闭合 undo group）
    g_pendingExec = -1;
    g_pendingHideCheck = false;
    g_inHeightAnim = false;   // 隐藏：停止高度动画，下次弹出从干净态起步
    if (g_hwnd) ShowWindow(g_hwnd, SW_HIDE);
    clearLayeredSurface();   // 隐藏后清表面：下次 ShowWindow 不会闪上一帧（见函数注释）
    g_visible = false;
    g_pinned = false;
    g_capturing = false;   // 捕获态随隐藏强制结束（防御异常路径残留豁免）
    g_mode = Mode::kGesture;       // 复位：下次弹出回到手势模式
    g_bindingSlot = -1;
    // 录制中因点击外部失活/其它路径走到 doHide 时，必须还原热键注册——
    // 若只清 g_recordingHotkey，恢复全靠 hotkey_idleTick 的空闲重试（≥2s 节流，
    // AE 忙时更久），窗口已关而全局热键在这段时间内不可用。对齐 recordHotkeyKey
    // 取消分支（Esc/读配置失败）的同一出口：先还原注册再清标志。
    if (g_recordingHotkey) {
        hotbox_log("doHide: recording active, resume hotkey registration");
        hotkey_resumeForRecording();
    }
    g_recordingHotkey = false;
    g_returnToSettings = false;
    g_capMenu = false;   // 复位子菜单态（下次弹出从干净态起步）
    g_capSel = -1;
    g_capPress = -1;
    g_msg.clear();   // 复位反馈气泡文本（引入；旧值会驻留到下次弹出一帧闪现）
    g_filterMenuOpen = false;
    g_filterHover = -1;
    g_filterBtnHover = false;
    g_rowHover = -1;
    g_setHover = -1;
    g_pressRow = -1;
    g_draggingScroll = false;
    g_draggingResize = false;
    g_scrollTop = 0;
    g_pressIdx = -1;
    g_centerPressed = false;
    g_execDispersing = false;   // 退场完成：清散开态，下次弹出从干净态起步
    g_filterType = "all";      // 与 showAt 同步复位过滤类型（showAt 是每次
                               // 弹出的权威复位点，此处为双保险——两份清单保持
                               // 一致，防其一后续再漂移）
    g_actionLock = false;   // 释放执行锁：退场完成，允许下次执行
    g_focusingEdit = false;   // 复位焦点拦截标志（防残留导致下次点击外部不关闭）
    g_progressError = false;   // 进度卡片状态复位
    g_progressWinH = 84;
    g_progressTitle.clear();
    hideEdit();   // 移出可视区并隐藏（防残留竖线/矩形）
}

} // namespace

// 空闲预热（entry.cpp IdleHook 调用）——把「首次进搜索」要付的
// AEGP 枚举 + 预设/脚本扫描 + 拼音索引构造成本挪到 AE 空闲期。只做一次：之后
// 弹出命中的数据源签名（computeDataSig）直接复用，重复呼出零重建。
// 须在 AE 空闲时被调（IdleHook 语义），主线程 → AEGP 调用合法。
// 2s 延迟闸门：插件加载水位之后才枚举，避开启动期「部分插件尚未就绪」的窗口——
// 万一仍拿到空/半截结果，computeDataSig 的「计数 <= 0 → 不可判定」会兜底重试。
// 注：定义在匿名命名空间之外（内部链接符号无法被 entry.cpp 链接）。
void window_idleWarmup() {
    if (g_dataWarmed) return;
    if (GetTickCount64() - g_initTickMs < 2000) return;   // 未到闸门：下次空闲再试
    g_dataWarmed = true;
    loadData();   // 失败/空数据由签名不可判定兜底（下次进搜索重走全量路径）
    hotbox_log(("idle warmup done: " + std::to_string(g_items.size()) + " items").c_str());
}

void window_init(AEGP_PluginID pluginID) {
    g_pluginID = pluginID;
    g_initTickMs = GetTickCount64();   // 空闲预热的 2s 延迟闸门基准
    timeBeginPeriod(1);   // 提升系统定时器分辨率，WM_TIMER 动画 tick 更稳定（配合 window_destroy 归还）
    HINSTANCE inst = GetModuleHandle(nullptr);
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = PopupWndProc;
    wc.hInstance = inst;
    wc.lpszClassName = L"AS_HotboxPopupWnd";
    RegisterClassExW(&wc);

    // 先按系统 DPI 缩放：PerMonitor V2 进程下 API 接受物理像素
    refreshDpiScale(nullptr);
    char buf[128];
    sprintf_s(buf, "window: dpi scale=%.2f", g_dpiScale);
    hotbox_log(buf);

    g_hwnd = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW, L"AS_HotboxPopupWnd", L"",
        WS_POPUP, 0, 0, phys(kWinW), phys(kWinH),
        nullptr, nullptr, inst, nullptr);
    if (!g_hwnd) {
        hotbox_log("window: create failed");
        return;
    }
    // ULW 模式：首次 ShowWindow 前必须先调一次 UpdateLayeredWindow 初始化（否则窗口不可见）
    ensureD2D(g_hwnd);
    if (g_dib && g_dibBits) {
        SIZE sz = { g_bmpW, g_bmpH };
        POINT ptZero = { 0, 0 };
        BLENDFUNCTION bf = {};
        bf.BlendOp = AC_SRC_OVER;
        bf.SourceConstantAlpha = 255;
        bf.AlphaFormat = AC_SRC_ALPHA;
        HGDIOBJ old = SelectObject(g_memDC, g_dib);
        UpdateLayeredWindow(g_hwnd, nullptr, nullptr, &sz, g_memDC, &ptZero, 0, &bf, ULW_ALPHA);
        SelectObject(g_memDC, old);
    }
    // 中心 EDIT（IME 输入免费；初始隐藏，点击中心后出现）；位置/尺寸按物理像素
    g_edit = CreateWindowExW(WS_EX_LAYERED, L"EDIT", L"",
                             WS_CHILD | ES_AUTOHSCROLL | ES_LEFT,
                             (int)phys(kCx - 70), (int)phys(kCy - 12),
                             phys(140), phys(24),
                             g_hwnd, nullptr, inst, nullptr);
    // 输入上限 1023 宽字符——EN_CHANGE 侧 GetWindowTextW 读取缓冲为
    // wchar_t[1024]（含结尾 NUL），超长输入被静默截断会造成查询/显示/选区三者
    // 不一致（EDIT 内部文本与 g_query/选区索引错位）；EM_LIMITTEXT 在输入端约束
    //（超出部分不进控件，用户可感知），而非读取端截断
    SendMessageW(g_edit, EM_LIMITTEXT, 1023, 0);
    // EDIT 设 alpha=0：ULW 父窗口下 EDIT 的 GDI 绘制会被覆盖，设完全透明让 D2D 接管文本/光标绘制，
    // EDIT 仅保留焦点和键盘输入处理
    SetLayeredWindowAttributes(g_edit, 0, 0, LWA_ALPHA);
    // 字体高度按物理像素缩放：EDIT 控件在 CEP/AEGP 线程下可能未继承 PerMonitor V2，
    // 不缩放则 -15 DIP 会被当 15 物理像素渲染 → 文字/caret 缩小到 1/scale
    // 字体句柄提为全局并在 window_destroy 配对 DeleteObject（防插件重载逐次泄漏）。
    // window_init 无重入保护（g_hwnd 直接覆盖赋值），二次调用先释放旧句柄防覆盖泄漏。
    if (g_editFont) { DeleteObject(g_editFont); g_editFont = nullptr; }
    g_editFont = CreateFontW(-phys(15), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                             CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    SendMessageW(g_edit, WM_SETFONT, (WPARAM)g_editFont, TRUE);
    g_editOldProc = (WNDPROC)SetWindowLongPtrW(g_edit, GWLP_WNDPROC,
                                               (LONG_PTR)EditSubclass);
    // 手势环固定槽配置（config.json gesture.slots； 完整配置系统，此处先读槽位）
    loadSlotConfig();
    // 主题色：读取面板导出的 hotbox/theme.json，缺失时用内置默认暗色
    loadTheme();
    hotbox_log("window: init ok");
}

void window_showAt(int screenX, int screenY) {
    if (!g_hwnd) return;
    // 任何召唤入口先清失败提示驻留态与其计时器（window_hotkeyPressed 已清，此处
    // 兜底；幂等）。保证「停留提示 → 重新召唤」不会残留旧提示，旧计时器也不会稍后
    // 关闭新面板（cancelFailDwell 代际自增 + 隐藏后 doHide 再自增）
    cancelFailDwell();
    abortBatch(true);   // 防御：上次批量未收尾（正常路径关窗时已中止），先闭合 undo group
    // 呼出前硬隐藏——窗口仍在屏上时（退场渐隐期 kAnimMs 150ms，或点击外部后的
    // 延迟判定期 kCheckFgTimer 50ms 内再次呼出）先 doHide 完成真隐藏与全量复位（顺带撤销
    // 待执行的 kExecTimer 与延迟判定期——重新呼出即取消关闭），否则下方 SetWindowPos 会先按
    // 手势环尺寸重设窗口、旧二级菜单随旧 ULW 表面留在屏上（用户实报「按快捷键打开闪一下
    // 上次的搜索菜单」）。注意 doHide 里的 clearLayeredSurface 才是消除残影的关键一环：
    // 隐藏窗的 UpdateWindow 不派发 WM_PAINT，本函数末尾的「先提交再显示」
    // 对隐藏态是空操作，ShowWindow 上屏的始终是上一次提交的位图。
    // 与 enterSearchMode/enterSettings 的转场同构。
    // 位置在 abortBatch 之后：abortBatch 的中止路径（completed=false）不会关窗，
    // 先闭合 undo group 再隐藏不会与退场动画串起来。
    if (g_visible) doHide();
    // 每次弹出重读 theme.json：扩展切换主题后立即反映（实时变色）。
    // 仅主题变化时失效两个惰性缓存画刷（径向渐变/EDIT 背景），下次绘制按新主题重建；
    // 其余颜色画刷本就逐帧读取 g_theme，无需处理。
    if (loadTheme()) {
        if (g_radial) { g_radial->Release(); g_radial = nullptr; }
        if (s_editBg) { DeleteObject(s_editBg); s_editBg = nullptr; }
    }
    g_mouseX = screenX; g_mouseY = screenY;   // 记录弹出点（二级菜单搜索栏定位基准）
    // 刷新 DPI scale：按呼出点取目标屏 DPI（refreshDpiScale(g_hwnd)
    // 在 SetWindowPos 之前读到上一屏 DPI，跨屏呼出缩放/命中测试错位，详见函数头注释）
    refreshDpiScaleAtPoint(screenX, screenY);
    // 状态复位须在 SetWindowPos 之前：窗口已可见时 SetWindowPos 会同步触发 WM_PAINT，
    // 若此时 g_mode 仍为上次 kSearch 且 g_query/g_results 残留，会闪现一帧旧二级菜单
    g_sel = -1;
    g_centerHover = false;
    g_pressIdx = -1;
    g_centerPressed = false;
    g_execDispersing = false;   // 每次弹出复位散开态（防异常残留）
    g_actionLock = false;   // 每次弹出复位执行锁（防异常残留）
    g_pinned = false;
    g_capturing = false;   // 弹出权威复位（防异常路径残留豁免）
    g_mode = Mode::kGesture;       // 每次弹出都从手势模式开始
    g_bindingSlot = -1;
    g_recordingHotkey = false;
    g_returnToSettings = false;
    g_capMenu = false;   // 复位子菜单态（doHide 已复位，弹出权威复位点双保险）
    g_capSel = -1;
    g_capPress = -1;
    g_focusingEdit = false;   // 复位焦点拦截标志（防上次残留）
    g_filterMenuOpen = false;
    g_filterHover = -1;
    g_filterBtnHover = false;
    g_rowHover = -1;
    g_statusHover = false;
    g_setHover = -1;
    g_pressRow = -1;
    g_draggingScroll = false;
    g_draggingResize = false;
    g_scrollTop = 0;
    g_query.clear();                // 清空上次搜索文本，防止搜索模式残影
    g_results.clear();              // 清空上次搜索结果
    g_typoKeys.clear();             // 近似标记与结果同生命周期
    g_filterHintCount = 0;          // 筛选提示同结果生命周期
    g_resultSel = 0;
    g_filterType = "all";           // 过滤类型同为搜索会话状态——上次选的
                                    // 「效果/脚本/预设」若跨弹出残留，按字母键直接
                                    // 进搜索（enterSearchMode 空参保留旧值）会被静默
                                    // 限域，「无匹配结果」误导性强（连搜索文本都清了
                                    // 却保留过滤，属复位清单遗漏而非设计）
    g_pendingExec = -1;             // 复位待执行弧段（防上次残留）
    g_pendingHideCheck = false;     // 复位待前台检查（防上次残留）
    g_msg.clear();                 // 上次执行消息不跨弹出残留
    g_progressTitle.clear();       // 进度卡片状态不跨弹出残留
    g_progressError = false;
    g_progressWinH = 84;
    // 窗口矩形按物理像素：cx/cy/WinW/WinH 均 ×scale
    // 环心始终精确对准鼠标（不做工作区钳制）：贴边呼出时窗口允许越出屏幕，
    // 确保鼠标原位不动即可点中中心圆进搜索；越出部分（上方提示气泡/下方空区）手势模式不绘制
    int pW = phys(kWinW), pH = phys(kWinH);
    int pCx = phys(kCx), pCy = phys(kCy);
    // 先定位（不显示）再重绘，避免复用窗口残留上一模式画面（二级菜单闪现）
    SetWindowPos(g_hwnd, HWND_TOPMOST, screenX - pCx, screenY - pCy, pW, pH,
                 SWP_NOACTIVATE);
    g_visible = true;
    // 最近使用：会话内首次弹出加载（本插件是 recent.json 唯一写入方，执行成功即同步落盘）
    if (!g_recentLoaded) loadRecent();
    resolveGestureEntries();       // 按 固定槽 + 最近使用 + 类别入口 解析 6 弧段
    g_dataLoaded = false;   // 每次弹出重置数据加载标志：下次进搜索模式重新拉取（新增脚本/预设可被发现）
    // 入场动画：从中心放大（时间驱动）
    animStart(1);
    InvalidateRect(g_hwnd, nullptr, FALSE);
    // 显示前同步提交首帧。隐藏窗口的 UpdateWindow 不派发
    // WM_PAINT（paints=0），所以「隐藏态提交首帧」这一发是空操作——ShowWindow 上屏的是
    // 上一次提交的位图。防旧帧（搜索/设置面板残留）真正靠 doHide 里的 clearLayeredSurface：
    // 隐藏期间表面恒为全透明，ShowWindow 先上屏一帧透明，随后可见态的正常 paint 提交手势环
    // 入场首帧（stagger 起点，各段 scale≈0）。三条调用保留（可见窗时有效，幂等无害）
    UpdateWindow(g_hwnd);
    ShowWindow(g_hwnd, SW_SHOWNOACTIVATE);
    // 显示后再同步补绘一次（首帧已提交，此处通常 no-op，保险 ShowWindow 自身的重绘路径）
    UpdateWindow(g_hwnd);
    hideEdit();   // 手势模式初始：输入框移出可视区（防上次搜索模式残留竖线）
    captureMouse();   // 手势模式起始即捕获：鼠标出 UI 范围仍按方向选段（热键松开时释放）
    SetFocus(g_hwnd);   // 焦点给弹窗本身，Esc 可关
}

// 热键按下统一入口（hotkey.cpp WM_HOTKEY 调用）：
// 窗口已打开（含入场动画中/常驻锁定，不含退场中）→ 再按触发键 = 关闭（开关语义，
// 两种模式一致）：
//   手势模式：关闭浮窗。非停留态若走「进二级搜索并预填主键字符」，与停留态的关闭
//             语义分裂，同一手势两种结果；现统一为关闭。想要"按住 Alt 弹出后直接打字
//             搜索"仍可：松开 Alt 后按任意字母 → WM_KEYDOWN → 进搜索预填（另一条路径）；
//   搜索模式：字符插入输入框并更新查询（同 EditSubclass 的 WM_SYSCHAR 分支，
//             Alt 被热键占用时 WM_SYSCHAR 同样不会送达）——搜索是文本输入上下文，
//             主键字符仍按字符处理，不关闭（与停留态一致）；
//   其余模式（设置/进度）：字母键无义，忽略——重弹会清空搜索、静默中止批量。
// 未打开或退场中（渐隐 150ms 内快速再呼出）→ 正常弹出。
void window_hotkeyPressed(int screenX, int screenY, int vk) {
    // 失败提示驻留期按热键 = 重新召唤。第一步清掉失败提示态
    // 与其计时器（cancelFailDwell：代际自增使旧计时器消息作废），然后直接走正常召唤
    // 流程 window_showAt（内部 doHide 硬复位旧窗口），不吞这次召唤、不残留旧提示，旧
    // 计时器也不会在稍后把新面板关掉。放在最前：驻留期 g_actionLock=true，若落到下面
    // 的手势分支会被锁守卫直接 return（正是要避免的「吞掉召唤」）。
    if (g_failActive) {
        cancelFailDwell();
        window_showAt(screenX, screenY);
        return;
    }
    // 待关闭判定期（点击外部后的 kCheckFgTimer 50ms 窗）内窗口仍在屏上，但
    // 关闭已进入流程——此间按热键按「重新呼出」处理（回落 showAt，由其 doHide 撤销待
    // 关闭与延迟判定）。旧行为下同一按键在不同毫秒数上分别表现为「塞进将关闭的搜索框」
    //（早于 window_hide）/「取消关闭后闪旧菜单」/「正常重开」，用户不可预期。
    if (g_visible && g_animDir >= 0 && !g_pendingHideCheck) {
        if (g_mode == Mode::kGesture) {
            // 执行锁守卫（对齐 WM_KEYDOWN/WM_LBUTTONDOWN 的手势分支）——
            // executeSelected 90ms 武装期内快速二次按热键不再动作；执行/退场锁定期一律拦截
            if (g_actionLock) return;
            // 已弹出时再按触发键 = 关闭（两种模式同语义，见函数头注释）
            hotbox_log(("hotkeyPressed: already open -> hide (stay=" +
                        std::to_string(g_releaseStay ? 1 : 0) + ")").c_str());
            window_hide();
        } else if (g_mode == Mode::kSearch && g_edit) {
            wchar_t ch = (wchar_t)MapVirtualKeyW((UINT)vk, MAPVK_VK_TO_CHAR);
            if (ch >= 0x20 && ch != 0xFFFF) {
                wchar_t s[2] = { applyCase(ch), 0 };
                SendMessageW(g_edit, EM_REPLACESEL, TRUE, (LPARAM)s);
                // EM_REPLACESEL 不触发 EN_CHANGE，手动走父窗口查询更新
                SendMessageW(g_hwnd, WM_COMMAND,
                             MAKEWPARAM((WORD)GetDlgCtrlID(g_edit), EN_CHANGE), (LPARAM)g_edit);
            }
        }
        return;
    }
    window_showAt(screenX, screenY);
}

void window_hide() {
    if (!g_hwnd || !g_visible) return;
    if (g_animDir < 0) return;     // 已在退场中
    // 撤销待执行 kExecTimer——executeSelected 排定的 90ms（kPressMs）延迟执行
    // 在窗口决定退场（Esc/点击外部/松开热键 → window_hide）时已失去执行前提；不撤则
    // 90ms < 150ms 渐隐期定时器必然先到期，把用户的取消意图变成误执行。落位在早退
    // 检查之后的正常路径：animStart(-1) 全文件仅本函数调用，首次取消时 animDir==0
    // 必走此路径（早退分支仅覆盖渐隐中的二次调用，且本撤销先行后不可能再见到待执行
    // 定时器）；守卫 g_pendingExec >= 0——正常执行流的 window_hide 由 doExecPendingItem
    // 在定时器触发并清 g_pendingExec 后调用，守卫恒为无操作，不误杀正常执行的定时器
    //（撤销体提取为 cancelPendingExec 公共函数，enterSearchMode/
    // enterSettings 导航转场同语义复用）
    cancelPendingExec();
    // Esc 直退路径统一置执行锁——渐隐 150ms 期间 g_mode/g_sel/g_bindingSlot
    // 全部残留（doHide 在渐隐完成后才复位），TOPMOST 渐隐窗仍接收输入：松开热键
    //（hotkeyReleased → executeSelected）或点击渐隐中的列表行（executeSearchItem）
    // 会把用户明确的「取消」意图转化为未经确认的执行（应用效果/运行脚本/绑定槽位）。
    // executeSelected/executeSearchItem/WM_LBUTTONDOWN 均有 g_actionLock 守卫，统一
    // 置锁即封死全部渐隐期执行入口；doHide 既有复位点负责释放（含各异常路径）
    g_actionLock = true;
    // 批量进行中被关窗（点击外部/热键松开）：静默中止余层并闭合 undo group，
    // 不切错误态（渐隐期间闪现错误卡片观感割裂）；已应用层保留（可 Ctrl+Z）
    abortBatch(true);
    // 退场起点复位高度动画——Esc/绑定/enterProgressMode/doHide 四条路径已
    // 各自复位，本路径漏复位：150ms 渐隐期间残留的高度插值继续 SetWindowPos 拉扯窗口
    // 高度，与退场动画相互干扰（视觉瑕疵）
    g_inHeightAnim = false;
    hotbox_log(("window_hide: mode=" + std::to_string((int)g_mode) + " pinned=" + std::to_string(g_pinned?1:0) + " focusingEdit=" + std::to_string(g_focusingEdit?1:0)).c_str());
    // 退场动画：alpha 渐隐完成后（WM_TIMER）真正隐藏
    animStart(-1);
    // EDIT 不在此处隐藏：ULW 下 EDIT 是原生子窗口，不受 D2D fadeLayer 影响，
    // 若退场开始即隐藏，文字和光标会在 150ms 渐隐期间提前消失（其余仍在淡出）→ 观感割裂。
    // 保留 EDIT 可见直到 doHide()：doHide 调 hideEdit() + ShowWindow(g_hwnd, SW_HIDE)，
    // 父窗口隐藏会连带隐藏子窗口，EDIT 与整窗同步消失。
    InvalidateRect(g_hwnd, nullptr, FALSE);
}

void window_execute(int segmentIndex) {
    executeSelected(segmentIndex);
}

bool window_isRecordingHotkey() {
    return g_recordingHotkey;
}

// config hotkey 相等判据（valid + 组合）——重试窗口的陈旧检测用
static bool sameHotkey(const config::Hotkey& a, const config::Hotkey& b) {
    return a.valid == b.valid && a.mods == b.mods && a.vk == b.vk;
}

// 处理面板写入的 hotkey-request.json 热键变更请求（IdleHook 通道）。
// 复刻弹窗录制处理器（recordHotkeyKey）的写回语义：读侧防线拒整包重建、
// hotkey_reload 三级回退、按实际生效组合写回 config.json、删除请求文件 = 应答信号。
// 两处误报窗口：
//   ① 每轮重试都重放 hotkey_reload（Unregister+Register 各一次）：写盘失败后
//      的 ~10s 重试窗口内，用户到浮窗手动录制的新组合会被下一轮陈旧请求重注册覆盖
//      （旧注释只挡住了 10s 之后的丢弃，挡不住窗口内的重放）。→ 同一请求内容只应用
//      一次 hotkey_reload，后续重试只重写 config（config::HotkeyRequestState，单测）。
//   ② 连续 5 次写失败即删请求文件：面板把"文件消失"当处理完成，若用户超时后
//      又按保存（失败计数不清零），丢弃会落在第二次轮询窗口内 → 面板见文件消失、读
//      config 旧值 → 误报「组合被占用，已回退」（本次会话实际已生效）；且删除后请求
//      永不落盘（重启回退），超时文案「稍后生效」也变成假话。→ 写盘失败**永不删除
//      请求文件**，只按节流计次打日志、下一轮继续重试直到写成功（自愈）。面板侧无
//      结果文件可写（client/shared/dataDir.js:679-727 只有 write/read/exists；
//      client/main.js:833-860 只看文件存在 + config 组合），保留文件 = 维持既有
//      超时语义，不制造假成功/假占用，也不会在轮询窗口内被静默丢弃。
void window_processHotkeyRequest() {
    std::string reqPath = hotboxDataPath("hotkey-request.json");
    if (reqPath.empty()) return;
    // 坏请求重试计数（跨 IdleHook 调用持久；文件消失时复位，防陈旧计数
    // 误伤后续新请求的半截写入窗口）
    static UINT s_badTry = 0;
    // 请求应用/重试状态（纯逻辑，config::HotkeyRequestState）
    static config::HotkeyRequestState s_reqState;
    // 首轮应用时 config.json 的 hotkey 基线——重试窗口内它若被弹窗录制改掉，
    // 说明用户手动录了新组合，陈旧请求须作废（否则重试写盘会覆盖用户刚录的组合）。
    static config::Hotkey s_reqBaseHotkey;
    // 常态快速路径：一次 stat 无文件即返回（微秒级）；stat 不受节流限制
    if (!fileExists(reqPath)) {
        s_badTry = 0;
        s_reqState.reset();
        return;
    }
    // 节流 ≥2s（防其他插件 IdleHook 叫得更频繁时多做）
    static ULONGLONG lastTick = 0;
    ULONGLONG now = GetTickCount64();
    if (now - lastTick < 2000) return;
    lastTick = now;
    // 读请求：失败（被锁/占位）→ 下轮重读自愈
    std::string req;
    if (!fsReadText(reqPath, &req)) return;
    // 解析 {mods, vk}： 的 isfinite + [1,255] 夹取防护在 config::parseHotkeyRequest
    //（对齐 parseConfig 的 hotkey 分支，提为纯函数供单测覆盖）
    config::HotkeyRequest hr = config::parseHotkeyRequest(req);
    if (!hr.valid) {
        // 解析失败/字段非法不再立即删除——面板侧对 hotkey-request.json 是
        // 非原子直写（JS 侧），读侧撞上亚毫秒写入窗口拿到的是半截文件，当坏请求
        // 删除会让热键变更静默丢失（面板轮询不到应答却误判已生效）。保留文件按
        // 节流间隔（≥2s）重试，连续 5 次（约 10s）仍非法才丢弃（真坏请求不永久
        // 驻留；半截写入毫秒级完成，首次重试即自愈）。
        if (++s_badTry >= 5) {
            DeleteFileW(utf8ToWide(reqPath).c_str());
            s_badTry = 0;
            s_reqState.reset();   // 请求作废，已应用状态不得留到下一份请求
            hotbox_log("hotkey request: still invalid after retries (discarded)");
        } else if (s_badTry == 1) {
            hotbox_log("hotkey request: parse failed, kept for retry (partial write?)");
        }
        return;
    }
    s_badTry = 0;
    int mods = hr.mods, vk = hr.vk;
    // config.json 读失败/坏 JSON → 请求保留（下轮重试），既有绑定未改动。
    // 每轮重试都记日志会刷屏（2s 一条），仅状态首次进入时记录
    static bool s_loggedUnreadable = false;
    std::string cfgPath = hotboxDataPath("config.json");
    std::string cur;
    if (!readConfigSafe(cfgPath, &cur)) {
        if (!s_loggedUnreadable) {
            s_loggedUnreadable = true;
            hotbox_log("hotkey request: config.json unreadable, request kept (retrying silently)");
        }
        return;
    }
    s_loggedUnreadable = false;
    const bool retrying = s_reqState.matches(mods, vk);
    int effMods = mods, effVk = vk;
    if (!retrying) {
        // 新请求内容：完整应用一次。三级回退：新组合 → 默认 Alt+Q → 还原原组合
        HotkeyReload rr = hotkey_reload(mods, vk, &effMods, &effVk);
        s_reqState.markApplied(mods, vk, effMods, effVk, rr != HOTKEY_RELOAD_KEPT,
                               rr == HOTKEY_RELOAD_OK ? 0 : rr == HOTKEY_RELOAD_DEFAULT ? 1 : 2);
        s_reqBaseHotkey = config::parseHotkey(cur);   // 写盘前基线（供重试陈旧检测）
    } else {
        // 同内容重试：只重试 config 写，不做 hotkey_reload——重注册会覆盖
        // 用户在此期间到浮窗手动录制的新组合（每轮重放会覆盖，窗口内挡不住）。
        effMods = s_reqState.effMods;
        effVk = s_reqState.effVk;
        const config::Hotkey curHk = config::parseHotkey(cur);
        config::Hotkey effHk;
        effHk.mods = effMods;
        effHk.vk = effVk;
        effHk.valid = true;   // hotkey_reload 输出必为合法组合（请求已钳到 [1,255]）
        // 重试期间 config hotkey 既不是首轮基线、也不是本请求已写值 → 被弹窗录制/
        // 外部改动改掉了：陈旧请求作废（否则重试写盘会把用户刚录的组合覆盖成旧值，
        // 文件留着还会在下次启动被当新请求重放）。此路径只在"用户在重试期间主动改过
        // 配置"时进入，用户操作优先；面板若仍在轮询（8×600ms）读到的也是用户刚写入
        // 的组合，不会出现"请求已生效"的假成功。
        if (!sameHotkey(curHk, s_reqBaseHotkey) && !sameHotkey(curHk, effHk)) {
            if (DeleteFileW(utf8ToWide(reqPath).c_str())) {
                s_reqState.reset();
                hotbox_log("hotkey request: config hotkey changed externally, stale request discarded");
            } else {
                hotbox_log("hotkey request: stale request discard failed (file busy), will retry");
            }
            return;
        }
    }
    // KEPT = 还原原组合，config.json 无需改动；否则按实际生效组合写回（单一写者）
    // cfgPath 为空（APPDATA 缺失）时跳过写并如实报 saved=false——
    // 空 path 会让 fsWriteText 把 .tmp 落到进程 CWD（对照 recordHotkeyKey 的 !p.empty() 防护）
    bool saved = true;
    if (s_reqState.configWriteNeeded) {
        saved = !cfgPath.empty() && fsWriteText(cfgPath, configTextForWrite(config::setHotkey(cur, effMods, effVk)));
    }
    const char* result = s_reqState.outcome == 0 ? "applied"
                       : s_reqState.outcome == 1 ? "fallback default" : "kept previous";
    if (saved) {
        // 删除请求文件 = 面板轮询的应答信号（面板见文件消失后读 config.json 比对）
        s_reqState.onWriteOk();
        if (DeleteFileW(utf8ToWide(reqPath).c_str())) {
            hotbox_log(("hotkey request: " + std::string(result) + " (" +
                        hotkey_describe() + ")").c_str());
        } else {
            // 极罕见（文件被占位）：保留状态，下一轮重写同内容后再试删除
            hotbox_log(("hotkey request: " + std::string(result) +
                        " but request file delete failed, will retry").c_str());
        }
    } else {
        // 写盘失败**不删**请求文件、不作废状态（一旦删除，
        // 面板会把"文件消失=已处理"误读，见函数头）。重试已幂等且只写盘，代价仅是
        // 每 ≥2s 一次小文件写；保留文件让面板维持既有超时语义「请求已保存，AE 空闲
        // 时自动生效」，写盘一旦恢复即自愈并删除应答。记日志仅首轮与每 30 轮
        //（约 1 分钟；2s 一条会刷屏）。
        s_reqState.onWriteFailed();
        if (s_reqState.writeFailTries == 1 || s_reqState.writeFailTries % 30 == 0) {
            hotbox_log(("hotkey request: " + std::string(result) + " (" + hotkey_describe() +
                        "), config save FAILED (try " + std::to_string(s_reqState.writeFailTries) +
                        "), request kept for retry").c_str());
        }
    }
}

void window_hotkeyReleased() {
    // 热键松开：未锁定常驻时关闭（松手停留开启时保持浮窗，见下）
    hotbox_log(("hotkeyReleased ENTER vis=" + std::to_string(g_visible ? 1 : 0) +
                " pinned=" + std::to_string(g_pinned ? 1 : 0) +
                " mode=" + std::to_string((int)g_mode) +
                " centerHover=" + std::to_string(g_centerHover ? 1 : 0) +
                " stay=" + std::to_string(g_releaseStay ? 1 : 0) +
                " sel=" + std::to_string(g_sel) +
                " animDir=" + std::to_string(g_animDir)).c_str());
    // 花瓣展开期不再挡热键松开——hover 语义下鼠标可能已离开窗口（收不到
    // MOUSEMOVE 收起），挡板会卡死窗口；松热键走正常退出，doHide 复位子菜单态。
    // 执行反馈驻留期由 g_pinned 挡住（executeCapture 设置）
    if (!g_visible || g_pinned) return;
    // 失败提示驻留期松开热键不执行也不关闭——提示须停留到计时结束（或用户主动
    // Esc/点外/再按热键重新召唤）；此处同时堵住「松开热键 → executeSelected 泄漏到
    // kCategory/kSettings 分支」的路径（锁守卫在那些分支之后）
    if (g_failActive) return;
    if (g_mode == Mode::kGesture) {
        // 松手停留（设置行6）：松手不执行也不关窗，环留在屏上等鼠标点击——
        // 点选域 = 环带（点弧段执行、点中心圆进搜索）；其余点击（环内空洞/弧段间隙/
        // 环带外透明区）与 Esc、点击浮窗外部、再按热键均为关闭出口。
        // 须释放方向跟踪捕获：捕获在系统层把鼠标消息（含窗口外的点击）全导向本窗，
        // 用户点击其他应用时目标窗口收不到激活 → WM_ACTIVATE 失活路径失效，
        // 浮窗既不关闭也吞掉这次点击。释放后显示/点击仍走正常窗口消息（TOPMOST 在光标下）
        if (g_releaseStay) {
            releaseMouse();
            // 捕获已释放：按住鼠标拖出窗外再松热键时，WM_LBUTTONUP 不再送本窗——清残留下压反馈
            g_pressIdx = -1;
            g_centerPressed = false;
            g_capPress = -1;
            InvalidateRect(g_hwnd, nullptr, FALSE);
            hotbox_log("hotkeyReleased: releaseStay on -> keep visible (mouse capture released)");
            return;
        }
        // 手势模式（按住热键弹出）：松开即按当前选择应用——
        // 鼠标在中心圆（搜索入口）= 正常退出；选中弧段 = 执行该段
        if (g_centerHover) {
            window_hide();
            return;
        }
        if (g_sel >= 0) {
            if (g_sel == kSettingsSlot || g_sel == kCaptureSlot) {
                // 设置/截图弧段：多选导航动作须鼠标按住交互（截图子菜单按下即弹、拖花瓣
                // 松手执行），松手热键不自动进入——与设置弧段同语义，按正常退出处理
                hotbox_log("hotkeyReleased: settings/capture slot -> hide");
                window_hide();
                return;
            }
            // 松手执行开关（设置行5）：关闭时松手仅关窗不执行选中弧段
            if (g_releaseExecute) {
                executeSelected(g_sel);
                return;
            }
        }
    }
    window_hide();
}

void window_destroy() {
    if (g_hwnd) KillTimer(g_hwnd, kAnimTimer);
    timeEndPeriod(1);   // 归还 timeBeginPeriod 提升的定时器分辨率
    if (g_rt) { g_rt->Release(); g_rt = nullptr; }
    if (g_d2dBmp) { g_d2dBmp->Release(); g_d2dBmp = nullptr; }
    if (g_wicBitmap) { g_wicBitmap->Release(); g_wicBitmap = nullptr; }
    if (g_dib) { DeleteObject(g_dib); g_dib = nullptr; g_dibBits = nullptr; }
    if (g_memDC) { DeleteDC(g_memDC); g_memDC = nullptr; }
    if (g_wicFactory) { g_wicFactory->Release(); g_wicFactory = nullptr; }
    if (g_radial) { g_radial->Release(); g_radial = nullptr; }
    if (g_factory) { g_factory->Release(); g_factory = nullptr; }
    if (g_dw) { g_dw->Release(); g_dw = nullptr; }
    if (g_fmt) { g_fmt->Release(); g_fmt = nullptr; }
    if (g_fmtLeft) { g_fmtLeft->Release(); g_fmtLeft = nullptr; }
    if (g_fmtRight) { g_fmtRight->Release(); g_fmtRight = nullptr; }
    if (g_fmtWrap) { g_fmtWrap->Release(); g_fmtWrap = nullptr; }
    if (g_fmtPetal) { g_fmtPetal->Release(); g_fmtPetal = nullptr; }
    for (IDWriteTextFormat*& arcFmt : g_fmtArc) {
        if (arcFmt) { arcFmt->Release(); arcFmt = nullptr; }
    }
    if (s_editBg) { DeleteObject(s_editBg); s_editBg = nullptr; }
    if (g_hwnd) { DestroyWindow(g_hwnd); g_hwnd = nullptr; }
    // EDIT 随父窗口销毁，句柄立即失效——置空防悬空（热重载场景下一次 window_init
    // 重建前，各使用点既有 if (g_edit) 判空兜底，不再对失效/被复用的句柄发消息）
    g_edit = nullptr;
    // EDIT 字体在窗口（含子控件 g_edit）销毁后释放；CoInitialize 按次配对归还
    if (g_editFont) { DeleteObject(g_editFont); g_editFont = nullptr; }
    while (s_comInitCount > 0) { CoUninitialize(); s_comInitCount--; }
}
