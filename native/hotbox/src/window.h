// window.h — 浮窗：手势弧段 + 中心 EDIT 搜索（实现搜索模式）
#pragma once
#include "AEConfig.h"
#include "AEGP_SuiteHandler.h"

void window_init(AEGP_PluginID pluginID);
void window_showAt(int screenX, int screenY);
void window_hotkeyPressed(int screenX, int screenY, int vk);   // 热键按下：已打开→主键作字符输入；未打开/退场中→弹出
void window_hide();
void window_destroy();
void window_execute(int segmentIndex);
void window_hotkeyReleased();
bool window_isRecordingHotkey();   // 热键录制中：WM_HOTKEY 应忽略（RegisterHotKey 吞键，防旧组合重置录制状态）
void window_processHotkeyRequest();   // 处理面板热键请求文件（IdleHook 周期调用，AE 空闲时）
void window_idleWarmup();   // 首次空闲预热数据（AEGP 枚举 + 拼音索引，一次性）
