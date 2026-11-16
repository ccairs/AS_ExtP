#pragma once
// selWheelPolicy.h —— 滚轮目标表的匹配/剔除/超时修剪纯逻辑（不依赖 AE SDK/Win32）。
//
// 文件选择器的滚轮目标（WH_MOUSE_LL 拦截
// 列表区域的判定表）用 effect_ref 认归属，但同一控件的 ref 在不同 DRAW 间实测会变
//（文件自身注释多处记录，见 customUI.cpp 的 selWheelUpsertTarget/selWheelConsumeImpl）。
// 登记按控件矩形去重并刷新 ref；剔除若按 ref 匹配（旧 selWheelRemoveTarget），折叠/
// 关窗时大概率删不掉 → 陈旧目标与钩子线程残留整个 AE 会话：用户在旧列表区域滚轮被
// 吞（面板不滚、滚动量落到别的实例）。本头文件把三条口径抽成纯函数，由
// tests/test_sel_wheel_policy.cpp 钉住：
//   ① 认同一目标 = 控件矩形相等（绝不按 ref 认同）；
//   ② 剔除：给了矩形就只按矩形（与登记同口径）；没有矩形（ECW 关闭路径）才按 ref；
//   ③ 陈旧修剪：now-lastSeen 超时即删（32 位无符号差，GetTickCount 回绕安全），
//      钩子线程据此在无任何 DRAW 回调时也能收敛并自停。
#include <cstddef>
#include <cstdint>
#include <iterator>

namespace host {

// 控件矩形（ECW 客户区逻辑坐标；字段与 AE PF_Rect 的 A_long 同构，
// long 在 Windows 为 32 位——本头文件因此无需包含任何 SDK/Win32 头）
struct SelWheelRect {
    long left = 0, top = 0, right = 0, bottom = 0;
};

inline SelWheelRect selWheelRectOf(long left, long top, long right, long bottom) {
    return SelWheelRect{left, top, right, bottom};
}

inline bool selWheelRectEq(const SelWheelRect& a, const SelWheelRect& b) {
    return a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom;
}

// 陈旧判定：GetTickCount 口径的 32 位无符号差（回绕安全——49.7 天回绕后
// now-lastSeen 仍正确）。严格大于：恰好等于超时不算陈旧（测试钉住边界）。
inline bool selWheelStale(std::uint32_t now, std::uint32_t lastSeen, std::uint32_t timeoutMs) {
    return static_cast<std::uint32_t>(now - lastSeen) > timeoutMs;
}

// 屏幕命中测试：在所有 screenValid 且屏幕矩形包含 (x,y) 的目标中取 lastSeen 最新者
//（多实例同屏时旧目标 screen 仍可能覆盖光标，取最新 = 正在绘制/悬停的那个；与
// customUI 旧内联循环同口径）。返回下标；无命中返回 npos。
// 命中判定**只看 screenValid 与矩形，不看 lastSeen 是否超时**——指针停在
// 列表上不动超过 3s 时 DRAW/悬停/命中都不会刷新 lastSeen，若先按超时修剪就会把
// 光标下的活目标删掉（随后滚轮被放行给参数面板，目标表空还会让钩子线程自停、
// 无 DRAW 则持续失效）。调用方必须**先**跑本函数、命中即刷新并消费；仅在未命中时
// 才调 selWheelPruneStale。
// T 需有 screenValid(bool)/screen(SelWheelRect)/lastSeen（32 位无符号）。
template <typename It>
std::size_t selWheelHitIndex(It first, It last, long x, long y) {
    constexpr std::size_t kNoHit = static_cast<std::size_t>(-1);
    const typename std::iterator_traits<It>::value_type* best = nullptr;
    std::size_t bestIdx = kNoHit;
    std::size_t i = 0;
    for (It it = first; it != last; ++it, ++i) {
        if (!it->screenValid) continue;
        if (x < it->screen.left || x >= it->screen.right ||
            y < it->screen.top || y >= it->screen.bottom) continue;
        if (!best || static_cast<std::uint32_t>(it->lastSeen) >
                         static_cast<std::uint32_t>(best->lastSeen)) {
            best = &*it;
            bestIdx = i;
        }
    }
    return bestIdx;
}

// 按矩形找同一条目（登记去重 / 悬停刷新定位共用；找不到返回 last）。
// T 需有 clientRect（SelWheelRect）成员。
template <typename It>
It selWheelFindByRect(It first, It last, const SelWheelRect& r) {
    for (It it = first; it != last; ++it) {
        if (selWheelRectEq(it->clientRect, r)) return it;
    }
    return last;
}

// 稀疏剔除 stale 条目，返回新尾（[out,last) 为被剔除项，调用方 erase）。
// T 需有 lastSeen（32 位无符号）成员。
template <typename It>
It selWheelPruneStale(It first, It last, std::uint32_t now, std::uint32_t timeoutMs) {
    It out = first;
    for (It it = first; it != last; ++it) {
        if (selWheelStale(now, static_cast<std::uint32_t>(it->lastSeen), timeoutMs)) continue;
        if (out != it) *out = *it;
        ++out;
    }
    return out;
}

// 剔除目标/待滚条目：rect 非空 → **只**按矩形（与登记同口径；ref 不稳定，若同时
// 按 ref 匹配，可能误删 ref 恰好相等的另一目标——矩形才是稳定身份）；rect 为空 →
// 按 effectRef（实例销毁/ECW 关闭时没有可靠矩形可用，只能 ref 兜底 + 超时修剪）。
// T 需有 clientRect 与 effectRef 成员。返回新尾，调用方 erase。
template <typename It>
It selWheelRemoveTargets(It first, It last, const SelWheelRect* rect, const void* ref) {
    It out = first;
    for (It it = first; it != last; ++it) {
        const bool drop = rect ? selWheelRectEq(it->clientRect, *rect)
                               : (static_cast<const void*>(it->effectRef) == ref);
        if (drop) continue;
        if (out != it) *out = *it;
        ++out;
    }
    return out;
}

// —— 命中目标的窗口有效性三态 ——
// 缺陷链：命中分支若无条件 `t.lastSeen = now` 续命，**已死实例**（ECW 已关闭但
// ref 抖动导致剔除失败）只要旧屏幕矩形仍压住光标，每次滚轮都给它续命、永不修剪：
// 光标停在该区域时滚轮被吞（局部死区），且目标表永不为空 → 钩子线程不收敛（自停
// 机制失效）。修法（方案②）：命中分支先判「目标窗口是否还活着」，只给活目标续命并
// 消费；死目标不续命、不消费（落入未命中路径跑既有 pruneStaleMiss，3s 阈值即刻收敛）。
// 判据可注入（生产传 IsWindow 包装、单测传假函数），本函数保持零 Win32 依赖。
//   · h == 0 → Unknown：没有可判的窗口（目标尚未校准出 calibRoot）——**保留现状**
//     作为降级：照常续命 + 消费，靠既有 3s 阈值修剪兜底（宁放行不错删）。
//   · isWindowFn(h) 为真 → Alive：窗口仍存在（ECW 还开着）→ 照常续命 + 消费。
//   · 为假 → Dead：窗口已销毁（ECW 已关，或宿主窗口换新）——**硬证据**，不再续命。
// 只判存在性（IsWindow），**不**组合 IsWindowVisible（最小正确原则）：可见性判据会
// 把"存在但不可见"的残留宿主误判为死目标（折叠/隐藏态窗口仍可能承载活控件），而它对
// "HWND 值被系统复用给别的可见窗口"这一残余风险并无改善；IsWindow 为假才是无可争议的
// "窗口已销毁"。HWND 复用残余由 3s 阈值继续兜底（Dead 分支不刷新 lastSeen → 可修剪），
// 不引入更复杂的判据。
enum class SelWheelHandleState { Alive, Dead, Unknown };

inline SelWheelHandleState selWheelHandleState(std::uintptr_t h, bool (*isWindowFn)(std::uintptr_t)) {
    if (h == 0) return SelWheelHandleState::Unknown;
    if (isWindowFn && isWindowFn(h)) return SelWheelHandleState::Alive;
    return SelWheelHandleState::Dead;
}

} // namespace host
