// hotkey.h — 全局热键：隐藏消息窗 + RegisterHotKey
#pragma once

// 注册热键并创建隐藏窗。返回值语义 = 窗口存活即 true（仅窗口创建失败返回 false）；
// 组合被占用不再销毁窗口（返回 true），交 hotkey_idleTick 空闲重试。
// 优先读数据目录 hotbox/config.json 的 hotkey 字段，无配置回退默认 Alt+Q。
bool hotkey_register();
void hotkey_unregister();

// 注册失败后窗口保留（不再销毁），本函数由 IdleHook 周期调用（AE 空闲时）。
// 未注册成功时重试三级回退注册，组合释放后自动恢复；成功时记 auto-recovered 日志。
void hotkey_idleTick();

// 重新注册热键（录制后调用）。mods 位标志与 Win32 MOD_* 一致（1=Alt 2=Ctrl 4=Shift）。
enum HotkeyReload {
    HOTKEY_RELOAD_OK,        // 请求的新组合生效
    HOTKEY_RELOAD_DEFAULT,   // 新组合冲突 → 回退默认 Alt+Q 生效
    HOTKEY_RELOAD_KEPT       // 新组合与默认均冲突 → 还原原组合（config.json 无需改动）
};
// effMods/effVk（可空）输出实际生效组合，供调用方写回 config.json 保持文件与运行态一致。
HotkeyReload hotkey_reload(int mods, int vk, int* effMods = nullptr, int* effVk = nullptr);

// 当前热键描述文本（如 "Ctrl+Alt+K"；未配置时为 "Alt+Q"），设置面板展示用
const char* hotkey_describe();

// 录制期暂停/恢复热键注册（修吞键冲突，详见 hotkey.cpp 函数注释）
void hotkey_suspend();               // 录制开始：暂注销当前组合
void hotkey_resumeForRecording();    // 录制取消：还原原组合注册
