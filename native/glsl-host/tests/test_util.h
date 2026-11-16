#pragma once
// test_util.h —— glsl_core_tests 共享测试工具
// 测试临时文件统一放运行目录下的 temp/ 子目录（直接写在 cwd 会让测试产物
// 散落仓库根目录污染工作区：test_state_*.glsl / test_effect_*.glsl 均为运行
// 时生成，每次跑测试重新生成，跟踪它们无意义）。temp/ 已加入 .gitignore；
// ctest 运行时 WORKING_DIRECTORY 为 build 目录（模块 .gitignore 已忽略），
// 手动运行时为用户 cwd（根 .gitignore 的 /temp/ 兜底）。
#include <filesystem>
#include <fstream>
#include <string>

namespace glsltest {

// 返回 "temp/<name>" 并确保 temp 目录存在。name 为相对 temp 的文件名
//（如 "test_state_a.glsl"）或子目录内路径（如 "test_nv3_data_root/data-dir.txt"，
// 父目录一并创建）。std::filesystem 对正反斜杠均接受。
inline std::string tempPath(const std::string& name) {
    std::error_code ec;
    std::filesystem::create_directories("temp", ec);   // 幂等，已存在不报错
    const std::string parent = std::filesystem::path("temp/" + name).parent_path().string();
    if (!parent.empty()) std::filesystem::create_directories(parent, ec);
    return "temp/" + name;
}

// 写文本文件（覆盖写，binary 模式避免 Windows 换行转换干扰内容比对）。
inline void writeFile(const std::string& path, const std::string& content) {
    std::ofstream f(path, std::ios::binary);
    f << content;
}

} // namespace glsltest
