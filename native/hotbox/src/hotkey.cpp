// hotkey.cpp — 隐藏窗接收 WM_HOTKEY，触发浮窗显示；热键由 config.json hotkey 驱动
#include "hotkey.h"
#include "log.h"
#include "window.h"
#include "config.h"
#include "data.h"
#include <windows.h>
#include <filesystem>
#include <fstream>
#include <iterator>

// 默认热键：Alt+Q（无配置或冲突回退时使用）
#define DEFAULT_HOTKEY_MODS (MOD_ALT)
#define DEFAULT_HOTKEY_VK   'Q'

namespace {
const wchar_t* kHkWndClass = L"AS_HotboxHotkeyWnd";
HWND g_hk = nullptr;
UINT g_hkId = 1;
UINT g_mods = DEFAULT_HOTKEY_MODS;
UINT g_vk = DEFAULT_HOTKEY_VK;
bool g_registered = false;          // 当前组合注册成功？（false = 未注册，idleTick 空闲重试）
ULONGLONG g_lastRetryTick = 0;      // 上次重试墙钟（GetTickCount64），≥2s 节流防刷
}

// 从数据目录 hotbox/config.json 读取 hotkey 字段；无配置/非法保持默认
static void loadHotkeyFromConfig() {
    std::string dir = data::defaultDataDir();
    if (dir.empty()) return;
    std::string p = dir + "\\hotbox\\config.json";
    // dir 为 UTF-8，文件流须宽路径打开（窄路径按 ANSI/GBK 解释会乱码）
    std::ifstream f(std::filesystem::path(data::utf8ToWide(p)), std::ios::binary);
    if (!f) return;
    std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    config::Hotkey hk = config::parseHotkey(content);
    if (hk.valid) {
        g_mods = (UINT)hk.mods;
        g_vk = (UINT)hk.vk;
    }
}

// 热键描述文本（日志/设置面板提示用）：Ctrl+Alt+Q 风格。
// 显示名口径统一在 config::hotkeyLabel（纯函数、与面板 _fmtHotkey 同口径、单测钉住）：
// 只认 A-Z 与空格时，数字键/F 键显示为 VK 数字（"Ctrl+49"/"Ctrl+116"），
// 与面板录制回显不一致。
static std::string describeKeys(UINT mods, UINT vk) {
    return config::hotkeyLabel((int)mods, (int)vk);
}

// 注册当前热键（MOD_NOREPEAT 防按住连发）；成败同步维护 g_registered。
// 已知取舍（机制固有）：RegisterHotKey 是系统级抢占——注册存续期间
// 该组合键全局被吞，AE 后台时用户在浏览器/Word 等其他应用按下此组合不会送达目标应用，
// 仅被 HkWndProc 的前台过滤"事后忽略"（本次输入静默丢失，无法归还）。彻底规避须改用
// 低级键盘钩子（WH_KEYBOARD_LL 按前台过滤后再决定吞键），属大改动（独立 hook 线程/
// 安全软件误报/卸载时序），收益有限故不采用；热键冲突或介意全局占用时用户可改组合。
static bool doRegister() {
    g_registered = RegisterHotKey(g_hk, g_hkId, g_mods | MOD_NOREPEAT, g_vk) != 0;
    return g_registered;
}

// 三级回退注册：配置组合 → 默认 Alt+Q → 放弃（g_registered 留 false 交 idleTick 重试）。
// 配置组合 == 默认组合时跳过第二次同组合注册（避免两条误导性失败日志）。
// verbose=false 供 idleTick 周期重试用：失败静默（防刷屏），成功由调用方记 auto-recovered。
static bool tryRegisterWithFallback(bool verbose) {
    if (doRegister()) return true;
    if (g_mods != DEFAULT_HOTKEY_MODS || g_vk != DEFAULT_HOTKEY_VK) {
        if (verbose)
            hotbox_log(("hotkey: configured " + describeKeys(g_mods, g_vk) + " in use, fallback default").c_str());
        g_mods = DEFAULT_HOTKEY_MODS;
        g_vk = DEFAULT_HOTKEY_VK;
        if (doRegister()) return true;
    }
    if (verbose) hotbox_log("hotkey: default Alt+Q also failed (in use?)");
    return false;
}

LRESULT CALLBACK HkWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_HOTKEY && wp == g_hkId) {
        // 录制新热键时按下旧组合：RegisterHotKey 会吞键并触发浮窗重置录制状态 → 忽略
        if (window_isRecordingHotkey()) {
            hotbox_log("hotkey: ignored (recording)");
            return 0;
        }
        // 仅在 AE 处于前台时触发浮窗，避免在其他应用中误触
        // （hotbox 是 AE 进程内的插件，比较前台窗口进程 ID 与当前进程 ID 即可）
        // 注意：此过滤只是"事后忽略"——RegisterHotKey 已在系统层截获该组合键，
        // 前台非 AE 时其他应用本次同样收不到该输入（取舍详见 doRegister 处注释）
        HWND fg = GetForegroundWindow();
        DWORD fgPid = 0;
        GetWindowThreadProcessId(fg, &fgPid);
        if (fgPid != GetCurrentProcessId()) {
            hotbox_log("hotkey: ignored (AE not foreground)");
            return 0;
        }
        POINT pt;
        GetCursorPos(&pt);
        // 未打开→按下即显示；已打开→主键按普通字符键处理（进搜索），不再重置重弹。
        // 随后轮询组合键释放
        window_hotkeyPressed(pt.x, pt.y, (int)g_vk);
        SetTimer(g_hk, 1, 50, nullptr);
        return 0;
    }
    if (msg == WM_TIMER && wp == 1) {
        // 组合释放（修饰键与主键均未按下）→ 通知浮窗（未锁定则隐藏）
        bool modDown = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0 ||
                       (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 ||
                       (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
        // 组合含 Win 键时把 Win 一并纳入释放检测——只查 Alt/Ctrl/Shift 时，
        // MOD_WIN 组合（如 Win+Q）按住 Win 只松主键被误判「组合已释放」，浮窗在
        // Win 尚未松开时提前执行/关闭。按 g_mods 位动态检测（未含 MOD_WIN 的组合
        // 不多查，避免无关按 Win 干扰原判定）；GetAsyncKeyState 无合并的 Win 虚拟键，
        // 左右各查一次。
        if (g_mods & MOD_WIN) {
            modDown = modDown ||
                      (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 ||
                      (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
        }
        bool keyDown = (GetAsyncKeyState((int)g_vk) & 0x8000) != 0;
        if (!modDown && !keyDown) {
            KillTimer(g_hk, 1);
            window_hotkeyReleased();
        }
        return 0;
    }
    return DefWindowProc(hwnd, msg, wp, lp);
}

bool hotkey_register() {
    HINSTANCE inst = GetModuleHandle(nullptr);
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = HkWndProc;
    wc.hInstance = inst;
    wc.lpszClassName = kHkWndClass;
    RegisterClassExW(&wc);

    g_hk = CreateWindowExW(0, kHkWndClass, L"", 0, 0, 0, 0, 0,
                           HWND_MESSAGE, nullptr, inst, nullptr);
    if (!g_hk) {
        hotbox_log("hotkey: create hwnd failed");
        return false;
    }
    loadHotkeyFromConfig();
    if (tryRegisterWithFallback(true)) {
        hotbox_log(("hotkey: registered " + describeKeys(g_mods, g_vk)).c_str());
    }
    // 注册失败不再 DestroyWindow：保留隐藏窗交 idleTick 空闲重试（旧 AE 退出后自动恢复）。
    // 返回值语义 = 窗口存活即 true；仅窗口创建失败返回 false
    return true;
}

// 未注册成功时由 IdleHook 周期调用（AE 空闲时），组合释放后自动恢复注册
void hotkey_idleTick() {
    if (g_registered || !g_hk) return;
    // 录制期禁止重试注册——录制开始时 hotkey_suspend 置 g_registered=false，
    // 若此处自动重注册成功，已生效组合重新系统级吞键，录制器又回到"按键没反应"
    if (window_isRecordingHotkey()) return;
    ULONGLONG now = GetTickCount64();
    if (now - g_lastRetryTick < 2000) return;
    g_lastRetryTick = now;
    if (tryRegisterWithFallback(false)) {
        hotbox_log(("hotkey: registered " + describeKeys(g_mods, g_vk) + " (auto-recovered)").c_str());
    }
}

// 录制期暂停热键注册。按下的键 = 当前已注册组合（如已生效的 Ctrl+空格）时，
// RegisterHotKey 会在系统层拦截并吞掉该键（只触发本窗口 WM_HOTKEY，而录制期按
// HkWndProc 规则忽略之），WM_KEYDOWN 永远到不了录制器——同一组合无法在原生录制中
// 重新登记。录制开始时暂注销，让按键以普通键消息落地完成录制，随后按录制结果
// （或取消时还原原组合）重新注册。
void hotkey_suspend() {
    if (g_hk && g_registered) {
        UnregisterHotKey(g_hk, g_hkId);
        g_registered = false;
    }
}

// 暂停后的取消出口（Esc / 配置读取失败）：直接还原原组合；也失败则三级回退
// （与 hotkey_idleTick 同语义；完全失败留 g_registered=false 交 idleTick 兜底）
void hotkey_resumeForRecording() {
    if (!g_hk || g_registered) return;
    tryRegisterWithFallback(true);
}

HotkeyReload hotkey_reload(int mods, int vk, int* effMods, int* effVk) {
    if (!g_hk) return HOTKEY_RELOAD_KEPT;
    UINT prevMods = g_mods, prevVk = g_vk;
    UnregisterHotKey(g_hk, g_hkId);
    g_mods = (UINT)mods;
    g_vk = (UINT)vk;
    if (doRegister()) {
        hotbox_log(("hotkey: reloaded " + describeKeys(g_mods, g_vk)).c_str());
        if (effMods) *effMods = (int)g_mods;
        if (effVk) *effVk = (int)g_vk;
        return HOTKEY_RELOAD_OK;
    }
    g_mods = DEFAULT_HOTKEY_MODS;
    g_vk = DEFAULT_HOTKEY_VK;
    if (doRegister()) {
        hotbox_log("hotkey: reload conflict, fallback default");
        if (effMods) *effMods = (int)g_mods;
        if (effVk) *effVk = (int)g_vk;
        return HOTKEY_RELOAD_DEFAULT;
    }
    // 默认也被占用 → 还原原组合（不假定原组合曾注册成功：初始注册失败场景下它本就被占用）
    g_mods = prevMods;
    g_vk = prevVk;
    doRegister();
    if (g_registered) {
        hotbox_log("hotkey: reload conflict (default in use too), kept previous");
    } else {
        // 还原也失败（原组合仍被占用）：g_registered=false 交 idleTick 空闲重试兜底
        hotbox_log("hotkey: reload conflict (default in use too), kept previous (re-register failed, idle retry pending)");
    }
    if (effMods) *effMods = (int)g_mods;
    if (effVk) *effVk = (int)g_vk;
    return HOTKEY_RELOAD_KEPT;
}

const char* hotkey_describe() {
    static std::string desc;
    desc = describeKeys(g_mods, g_vk);   // 每次重新计算（reload 后反映新组合）
    return desc.c_str();
}

void hotkey_unregister() {
    if (g_hk) {
        KillTimer(g_hk, 1);
        UnregisterHotKey(g_hk, g_hkId);
        DestroyWindow(g_hk);
        g_hk = nullptr;
    }
    g_registered = false;   // 窗口已销毁，重试通道随之关闭
}
