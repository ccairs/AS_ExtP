// crashForensics 单元测试：故障地址 → 模块归属的边界语义。
// 纯逻辑（不碰 Win32），对应 plugin.cpp VEH 内唯一的线性扫描。
#undef NDEBUG
#include <cassert>
#include <cstdint>
#include <cstring>
#include <iostream>
#include "crashForensics.h"

namespace {

host::ModuleRange makeRange(uintptr_t base, uintptr_t size, const char* name) {
    host::ModuleRange m;
    m.base = base;
    m.size = size;
    std::strncpy(m.nameA, name, sizeof(m.nameA) - 1);
    m.nameA[sizeof(m.nameA) - 1] = '\0';
    return m;
}

// a) 首尾边界：base 命中 off=0；末字节命中；base+size 不命中（半开区间）
void test_boundaries() {
    host::ModuleRange mods[2] = {
        makeRange(0x1000, 0x1000, "first.dll"),
        makeRange(0x3000, 0x500, "second.dll"),
    };
    uintptr_t off = 999;

    const host::ModuleRange* m = host::findModuleForAddress(mods, 2, 0x1000, &off);
    assert(m == &mods[0]);
    assert(off == 0);                                   // 首地址

    off = 999;
    m = host::findModuleForAddress(mods, 2, 0x1FFF, &off);
    assert(m == &mods[0]);
    assert(off == 0xFFF);                               // 末字节

    off = 999;
    assert(host::findModuleForAddress(mods, 2, 0x2000, &off) == nullptr);
    assert(off == 0);                                   // 未命中时清 0

    off = 999;
    m = host::findModuleForAddress(mods, 2, 0x34FF, &off);
    assert(m == &mods[1]);
    assert(off == 0x4FF);                               // 第二段末字节

    assert(host::findModuleForAddress(mods, 2, 0x3500, nullptr) == nullptr);
}

// b) 模块外/表间隙/首地址之前 → nullptr
void test_outside_and_gaps() {
    host::ModuleRange mods[2] = {
        makeRange(0x1000, 0x100, "a.dll"),
        makeRange(0x2000, 0x100, "b.dll"),
    };
    uintptr_t off = 123;
    assert(host::findModuleForAddress(mods, 2, 0x0FFF, &off) == nullptr);
    assert(off == 0);
    assert(host::findModuleForAddress(mods, 2, 0x1100, &off) == nullptr);   // a 尾后
    assert(host::findModuleForAddress(mods, 2, 0x1FFF, &off) == nullptr);   // 间隙
    assert(host::findModuleForAddress(mods, 2, 0xFFFFFFFFu, &off) == nullptr);
    assert(off == 0);
}

// c) 空表 / 空指针 / size==0 / base==0 → nullptr（不把哨兵项当命中）
void test_degenerate_tables() {
    uintptr_t off = 7;
    assert(host::findModuleForAddress(nullptr, 3, 0x1000, &off) == nullptr);
    assert(off == 0);
    assert(host::findModuleForAddress(nullptr, 0, 0x1000, &off) == nullptr);

    host::ModuleRange mods[3];
    mods[0] = makeRange(0, 0x1000, "null-base.dll");   // 枚举失败哨兵
    mods[1] = makeRange(0x1000, 0, "zero-size.dll");   // 枚举失败哨兵
    mods[2] = makeRange(0x2000, 0x100, "ok.dll");
    assert(host::findModuleForAddress(mods, 1, 0x10, nullptr) == nullptr);
    assert(host::findModuleForAddress(mods, 2, 0x1000, nullptr) == nullptr);
    off = 7;
    const host::ModuleRange* m = host::findModuleForAddress(mods, 3, 0x2001, &off);
    assert(m == &mods[2]);
    assert(off == 1);
}

// d) 地址取整型上限附近不因 base+size 溢出而误判
void test_no_unsigned_overflow() {
    host::ModuleRange mods[1] = {
        makeRange(0xFFFFFFFFFFFFF000ull, 0x1000ull, "top.dll"),
    };
    assert(host::findModuleForAddress(mods, 1, 0xFFFFFFFFFFFFFFFFull, nullptr) ==
           &mods[0]);   // 末字节命中
    assert(host::findModuleForAddress(mods, 1, 0xFFFFFFFFFFFFEFFFull, nullptr) == nullptr);
}

// e) 表项乱序时按线性扫描仍能命中（表按枚举顺序，不做排序假设）
void test_unordered_table() {
    host::ModuleRange mods[2] = {
        makeRange(0x5000, 0x100, "late.dll"),
        makeRange(0x1000, 0x100, "early.dll"),
    };
    uintptr_t off = 0;
    const host::ModuleRange* m = host::findModuleForAddress(mods, 2, 0x1050, &off);
    assert(m == &mods[1]);
    assert(off == 0x50);
}

} // namespace

void runCrashForensicsTests() {
    test_boundaries();
    test_outside_and_gaps();
    test_degenerate_tables();
    test_no_unsigned_overflow();
    test_unordered_table();
    std::cout << "ALL CRASH FORENSICS TESTS PASSED\n";
}
