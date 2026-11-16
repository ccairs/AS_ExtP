// acpName.h —— 参数名 UTF-8 → ACP（系统代码页）有界拷贝与可表示性判定。
//
// AE 以 CP_ACP 解释 PF_ParamDef.name，缓冲为 PF_MAX_EFFECT_PARAM_NAME_LEN + 1 = 32 字节。
// 整串转 ACP 后再按字节截断（strncpy 语义）会在 DBCS 代码页（如 CP936）上把 2 字节字符
// 切一半，效果控件显示半个字/替换字符。copyAcpBounded 先转 UTF-16，再逐字符转 ACP：
// 只有整字符放得下才写入，末尾补 NUL。
// 输出不变量：字节数 ≤ dstSize-1；每个字符（UTF-16 代理对视为一个）完整；输入合法时
// 与「整串转 ACP 且未超限」的结果逐字节相同。
// acpRepresentable 判断整串能否在当前代码页完整表示：不可表示（会被替换成默认字符或
// 只能靠 best-fit 映射）时，调用方回退到可表示的文案（见 plugin.cpp 的参数名 wrapper）。
#pragma once

#include <windows.h>

#include <cstddef>
#include <cstring>
#include <string>

namespace host {

// 把 UTF-8 文本按 ACP 有界拷贝到 dst：最多 dstSize-1 字节，在完整字符边界截断，末尾 NUL。
// 返回写入的字节数（不含 NUL）。dst 为空或 dstSize == 0 返回 0；utf8 为空/非法时写空串。
inline size_t copyAcpBounded(const char* utf8, char* dst, size_t dstSize) {
    if (!dst || dstSize == 0) return 0;
    dst[0] = '\0';
    if (!utf8 || !*utf8) return 0;

    const int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
    if (wlen <= 1) return 0;
    std::wstring wide(static_cast<size_t>(wlen), L'\0');
    if (MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &wide[0], wlen) != wlen) return 0;
    wide.resize(static_cast<size_t>(wlen - 1));   // 去掉尾零

    const size_t limit = dstSize - 1;
    size_t used = 0;
    for (size_t i = 0; i < wide.size();) {
        // UTF-16 代理对是一个字符：必须成对交给 WideCharToMultiByte，否则会切半个码点
        size_t units = 1;
        if (wide[i] >= 0xD800 && wide[i] <= 0xDBFF && i + 1 < wide.size() &&
            wide[i + 1] >= 0xDC00 && wide[i + 1] <= 0xDFFF) {
            units = 2;
        }
        char acp[8] = {0};   // 单字符的 ACP 字节：DBCS 最多 2，留余量
        const int n = WideCharToMultiByte(CP_ACP, 0, &wide[i], static_cast<int>(units),
                                          acp, static_cast<int>(sizeof(acp)), nullptr, nullptr);
        if (n <= 0) break;                                // 不可转换：停在此前边界
        if (used + static_cast<size_t>(n) > limit) break;  // 放不下：停在此前边界
        std::memcpy(dst + used, acp, static_cast<size_t>(n));
        used += static_cast<size_t>(n);
        i += units;
    }
    dst[used] = '\0';
    return used;
}

// 整串能否在当前系统代码页（CP_ACP）中完整表示：
// GB18030（54936）与 UTF-8（65001）能表示全部 Unicode，直接判可表示（这两个代码页
// 也不接受 WC_NO_BEST_FIT_CHARS）；其余代码页逐字符转换，任一字符转换失败或
// usedDefault 为真 → false（会被替换成 '?' 或只能靠 best-fit 改写）。
// 空串/nullptr 返回 true（没有字符会丢失）。
inline bool acpRepresentable(const char* utf8) {
    if (!utf8 || !*utf8) return true;
    const UINT acp = GetACP();
    if (acp == 54936 || acp == 65001) return true;
    const int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
    if (wlen <= 1) return true;
    std::wstring wide(static_cast<size_t>(wlen), L'\0');
    if (MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &wide[0], wlen) != wlen) return false;
    wide.resize(static_cast<size_t>(wlen - 1));   // 去掉尾零

    const DWORD flags = WC_NO_BEST_FIT_CHARS;
    for (size_t i = 0; i < wide.size();) {
        // 代理对是一个字符：成对交给转换函数才能得到「该码点是否可表示」的结论
        size_t units = 1;
        if (wide[i] >= 0xD800 && wide[i] <= 0xDBFF && i + 1 < wide.size() &&
            wide[i + 1] >= 0xDC00 && wide[i + 1] <= 0xDFFF) {
            units = 2;
        }
        char acp[8] = {0};   // 单字符的 ACP 字节：DBCS 最多 2，留余量
        BOOL usedDefault = FALSE;
        const int n = WideCharToMultiByte(CP_ACP, flags, &wide[i], static_cast<int>(units),
                                          acp, static_cast<int>(sizeof(acp)),
                                          nullptr, &usedDefault);
        if (n <= 0 || usedDefault) return false;
        i += units;
    }
    return true;
}

} // namespace host
