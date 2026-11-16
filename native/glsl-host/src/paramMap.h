#pragma once
// paramMap.h —— 宿主侧 uniform → AE 参数索引映射落盘
//
// 背景：AE 的参数名是 cosmetic 字段，PF_UpdateParamUI 改的名字不随工程持久化，
// 脚本侧读到的名字可能仍是注册态旧名（0500 症状）。名称不可靠时，脚本要按
// propertyIndex 寻址——索引是 AE 的稳定契约（见 params.h：5+4*slot+comp）。
//
// 本模块把「当前载入过的 shader 文件」的 uniform 映射写成 JSON，供面板
// （client/modules/agent/engine/shaderTools.js）优先按索引寻址。
//
// 落盘位置：<数据根>\temp\ae-tools\param-map\index.json
//   （数据根解析见 effectState.cpp dataRootDirPath；目录不可用直接失败，不回落）
// 调用约束：只在正常上下文（PARAMS_SETUP / UPDATE_PARAMS_UI / 用户文件切换）调用，
// 不得在渲染线程或 VEH 内调用；写失败只记 trace 日志，不抛异常、不影响宿主行为。
#include <cstddef>
#include <string>
#include <vector>
#include "uniformParser.h"

namespace host {

// 目录 / 文件绝对路径（数据根不可解析时返回空串）
std::string paramMapDirPath();
std::string paramMapFilePath();

// 把 shaderPath 的 uniform 映射合并进 index.json。
//   shaderName   为空时从文件名推导（不含扩展名）
//   libraryIndex 该文件在当前库列表中的 0 基下标；<0 时按名字查当前列表
//   source       文件原文（用于签名 hash；可为空，为空时哈希空串）
// 返回是否写盘成功。失败静默（首次失败落一行 trace）。
bool writeParamMapFile(const std::string& shaderPath, const std::string& shaderName,
                       int libraryIndex, const std::string& source,
                       const std::vector<glsl::Param>& uniforms);

// 当前进程内已缓存的条目数（诊断用）
std::size_t paramMapEntryCount();

} // namespace host
