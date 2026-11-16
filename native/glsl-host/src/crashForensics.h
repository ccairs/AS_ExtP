#pragma once
// crashForensics.h —— 崩溃取证：故障地址 → 所属模块（纯逻辑，供 VEH 与单测共用）
//
// 为什么单独抽出来：VEH 内不得堆分配/取锁（plugin.cpp），模块归属只能在
// CrashHandlerInit（正常上下文）预枚举成固定大小静态数组，VEH 里做一次线性扫描。
// 扫描函数本身是纯函数（不碰 Win32、不分配），边界行为由 tests/test_crash_forensics.cpp
// 钉住；枚举与表发布留在 plugin.cpp（只有那里知道进程与线程模型）。
#include <cstddef>
#include <cstdint>

namespace host {

// 单个模块的地址区间。base = 模块基址，size = SizeOfImage（字节）。
// nameW 按任务约定保留宽字符名；nameA 是枚举时预转的 UTF-8 文件名，
// 供 WSS/VEH 直接用 %s 落盘（VEH 内不做编码转换，那是可能触碰堆的 CRT 路径）。
struct ModuleRange {
    uintptr_t base = 0;
    uintptr_t size = 0;
    wchar_t nameW[64] = {};
    char nameA[96] = {};
};

// 在 mods[0..count) 中查找 addr 所属模块：命中返回该表项并把 addr-base 写入
// outOffset；未命中返回 nullptr 且 outOffset=0。
// 边界语义：addr == base 命中（off=0）；addr == base+size 不命中（半开区间）；
// size==0 或 base==0 的表项忽略；mods 为空/count==0 返回 nullptr。
const ModuleRange* findModuleForAddress(const ModuleRange* mods, std::size_t count,
                                        uintptr_t addr, uintptr_t* outOffset);

} // namespace host
