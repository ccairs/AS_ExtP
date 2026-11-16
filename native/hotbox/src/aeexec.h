// aeexec.h — AEGP_UtilitySuite6::AEGP_ExecuteScript 包装
#pragma once
#include "AEConfig.h"
#include "AEGP_SuiteHandler.h"
#include <string>
#include <vector>
#include "data.h"

void aeexec_init(AEGP_PluginID pluginID, SPBasicSuite* sp);

// 在 AE 进程内执行 ExtendScript（UTF-8）。返回 true 且 outResult 为返回串；
// outError 可选：脚本执行失败时的错误消息（已规范化为 UTF-8）。
bool aeexec_runScript(const std::string& scriptUtf8, std::string* outResult,
                      std::string* outError = nullptr);

// 原生枚举 AE 已安装效果（AEGP_EffectSuite4）：效果列表的主数据源（AE 内存里的已安装
// 效果表，与 Effects 菜单同源；扩展维护的 effects_cache.json 仅在本函数返回 0 时兜底）。
// 返回效果数（0 = 枚举失败或无效果）；out 追加 data::Item（type="effect"，key=matchName）。
// name/category 以 UTF-8 返回（A_char 按整批判定后解码，判据见 data::isAnsiBatch）；
// key（matchName）按 SDK 标注的 UTF-8 原样返回，不做编码转换。
// complete（可选）：枚举是否**完整**走完 count 次——AEGP_GetNextInstalledEffect
// 中途失败 break 时为 false（此时返回值 n>0 只是半截列表）；调用方不得把半截/空枚举
// 记为有效缓存签名（见 data::effectEnumCacheable）。
int aeexec_enumerateEffects(std::vector<data::Item>& out, bool* complete = nullptr);

// 已安装效果数（AEGP_GetNumInstalledEffects 单次调用，微秒级）：数据源签名用来判定
// 「AE 插件集是否变化」。返回 -1 = AEGP 不可用/查询失败（与 0「无效果」区分：调用方
// 须把两者都当作不可判定，见 window.cpp computeDataSig）
int aeexec_installedEffectCount();

// 套件入口（capture.cpp 渲染/编码复用）
AEGP_PluginID aeexec_pluginId();
SPBasicSuite* aeexec_sp();
