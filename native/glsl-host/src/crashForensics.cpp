#include "crashForensics.h"

namespace host {

const ModuleRange* findModuleForAddress(const ModuleRange* mods, std::size_t count,
                                        uintptr_t addr, uintptr_t* outOffset) {
    if (outOffset) *outOffset = 0;
    if (!mods || count == 0) return nullptr;
    for (std::size_t i = 0; i < count; ++i) {
        const ModuleRange& m = mods[i];
        // base==0 / size==0 是枚举失败项的哨兵，不能当成"地址 0 命中"。
        if (m.base == 0 || m.size == 0) continue;
        // 写成 addr - base 而不是 base + size 比较：避免极端地址下的无符号回绕。
        if (addr >= m.base && (addr - m.base) < m.size) {
            if (outOffset) *outOffset = addr - m.base;
            return &m;
        }
    }
    return nullptr;
}

} // namespace host
