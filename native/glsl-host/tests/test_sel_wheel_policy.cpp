// test_sel_wheel_policy.cpp —— 滚轮目标表匹配/剔除/超时修剪的纯逻辑单测。
//
// 缺陷链：effect_ref 在同一控件的不同 DRAW 间会变；登记（upsert）按控件矩形去重并
// 把条目 ref 刷成当前值，剔除（remove）却只按 ref 匹配 → 折叠/关窗时删不掉：
// 陈旧目标残留，钩子线程只在 targets 空时才停 → WH_MOUSE_LL 与陈旧屏幕矩形残留整个
// AE 会话，用户在旧列表区域滚轮被吞。本测钉住修复后的三条口径（实现见
// selWheelPolicy.h，production 直接调用同一函数）。
// 命中判定不得先于修剪（陈旧活目标仍在光标下时必须命中并
// 消费）；pending 与目标同口径超时修剪（幸存条目不得跨实例消费）。
// 命中分支不得无条件续命——已死实例（ECW 已关闭但 ref
// 抖动导致剔除失败）只要旧矩形压住光标就被每次滚轮续命、永不修剪（局部死区 +
// 钩子线程不收敛）。命中先判目标窗口有效性（selWheelHandleState 三态）：Dead →
// 不续命不消费（既有 3s 阈值即刻收敛）；Alive/Unknown(0) → 照常续命（降级）。
#undef NDEBUG
#include <cassert>
#include <cstdint>
#include <iostream>
#include <vector>

#include "selWheelPolicy.h"

namespace {

struct FakeTarget {
    void* effectRef = nullptr;
    host::SelWheelRect clientRect;
    host::SelWheelRect screen;      // 屏幕矩形（命中判定用；默认 = clientRect）
    bool screenValid = true;
    std::uint32_t lastSeen = 0;
};

using host::selWheelRectOf;

static FakeTarget mk(void* ref, long l, long t, long r, long b, std::uint32_t lastSeen) {
    FakeTarget f;
    f.effectRef = ref;
    f.clientRect = selWheelRectOf(l, t, r, b);
    f.screen = f.clientRect;
    f.screenValid = true;
    f.lastSeen = lastSeen;
    return f;
}

// ① 认同一目标按矩形（不受 ref 变化影响）；ref 不同但矩形相同 = 同一条目
static void test_find_by_rect_not_ref() {
    std::vector<FakeTarget> v = {
        mk((void*)0x1, 10, 20, 200, 300, 100),
        mk((void*)0x2, 10, 400, 200, 680, 100),
    };
    const host::SelWheelRect r = selWheelRectOf(10, 20, 200, 300);
    auto it = host::selWheelFindByRect(v.begin(), v.end(), r);
    assert(it != v.end() && it->effectRef == (void*)0x1);
    // 同矩形不同 ref 也命中（ref 不稳定，矩形才是身份）
    v[0].effectRef = (void*)0x99;
    it = host::selWheelFindByRect(v.begin(), v.end(), r);
    assert(it == v.begin() && it->effectRef == (void*)0x99);
    // 找不到 → last
    assert(host::selWheelFindByRect(v.begin(), v.end(), selWheelRectOf(0, 0, 1, 1)) == v.end());
    std::cout << "PASS test_find_by_rect_not_ref\n";
}

// ② 剔除：给了矩形只按矩形——ref 不同也能删（修复核心：折叠 DRAW 的 ref 可能
//    与登记时不同）；且不得因另一目标 ref 恰好相等而误删它
static void test_remove_by_rect_wins_over_ref() {
    std::vector<FakeTarget> v = {
        mk((void*)0x1, 10, 20, 200, 300, 100),   // 实例 A（矩形）
        mk((void*)0x2, 10, 400, 200, 680, 100),  // 实例 B（矩形，ref 与 A 剔除入参相同）
    };
    const host::SelWheelRect r2 = selWheelRectOf(10, 400, 200, 680);
    v.erase(host::selWheelRemoveTargets(v.begin(), v.end(), &r2, (void*)0x2), v.end());
    assert(v.size() == 1);
    assert(v[0].effectRef == (void*)0x1);        // 矩形不匹配者保留
    // ref 不同也按矩形删（只按 ref 匹配 → 删不掉，陈旧目标残留）
    const host::SelWheelRect r1 = selWheelRectOf(10, 20, 200, 300);
    v.erase(host::selWheelRemoveTargets(v.begin(), v.end(), &r1, (void*)0x77), v.end());
    assert(v.empty());
    std::cout << "PASS test_remove_by_rect_wins_over_ref\n";
}

// ③ 无矩形（ECW 关闭路径）才按 ref 兜底；且只删匹配项
static void test_remove_by_ref_fallback() {
    std::vector<FakeTarget> v = {
        mk((void*)0x1, 10, 20, 200, 300, 100),
        mk((void*)0x2, 10, 400, 200, 680, 100),
        mk((void*)0x1, 10, 700, 200, 900, 100),
    };
    v.erase(host::selWheelRemoveTargets(v.begin(), v.end(), nullptr, (void*)0x1), v.end());
    assert(v.size() == 1 && v[0].effectRef == (void*)0x2);
    std::cout << "PASS test_remove_by_ref_fallback\n";
}

// ④ 超时修剪：严格大于才陈旧（边界相等保留）；DWORD 回绕安全
static void test_prune_stale_and_wraparound() {
    const std::uint32_t now = 10000;
    std::vector<FakeTarget> v = {
        mk((void*)0x1, 10, 0, 20, 20, now - 100),       // 新鲜
        mk((void*)0x1, 11, 0, 21, 20, now - 3000),      // 恰好等于超时：不算陈旧
        mk((void*)0x2, 12, 0, 22, 20, now - 3001),      // 超 1ms：陈旧
        mk((void*)0x2, 13, 0, 23, 20, 0),               // 极旧：陈旧
    };
    v.erase(host::selWheelPruneStale(v.begin(), v.end(), now, 3000), v.end());
    assert(v.size() == 2);
    assert(v[0].clientRect.left == 10 && v[1].clientRect.left == 11);

    // 回绕：lastSeen 接近 2^32、now 回绕后较小，差值仍正确
    const std::uint32_t wrappedNow = 5;
    std::vector<FakeTarget> w = {
        mk((void*)0x1, 10, 0, 20, 20, 0xFFFFFFF0u),     // now-lastSeen = 21
    };
    assert(host::selWheelStale(wrappedNow, w[0].lastSeen, 20));       // 21 > 20 → 陈旧
    assert(!host::selWheelStale(wrappedNow, w[0].lastSeen, 21));      // 恰好相等 → 不陈旧
    assert(host::selWheelStale(10, 0xFFFFFFF6u, 20) == false);        // diff=20 → 不陈旧
    assert(host::selWheelStale(11, 0xFFFFFFF6u, 20) == true);         // diff=21 → 陈旧
    std::cout << "PASS test_prune_stale_and_wraparound\n";
}

// ⑤ 空输入/全陈旧：返回原/空范围，调用方 erase 语义自洽
static void test_prune_edge_ranges() {
    std::vector<FakeTarget> empty;
    assert(host::selWheelPruneStale(empty.begin(), empty.end(), 1, 0) == empty.end());
    std::vector<FakeTarget> v = { mk((void*)0x1, 0, 0, 1, 1, 0) };
    auto e = host::selWheelPruneStale(v.begin(), v.end(), 5, 1);
    assert(e == v.begin());                    // 全部陈旧 → 新尾 = begin
    v.erase(e, v.end());
    assert(v.empty());
    std::cout << "PASS test_prune_edge_ranges\n";
}

// ⑥：命中判定独立于 lastSeen——指针停在列表上 >3s（无 DRAW/悬停刷新）
// 时目标 lastSeen 已过时，但光标仍在其矩形内，必须先命中并消费；
// 先按超时修剪，活目标会被删掉（滚轮放行给参数面板 + 目标表空自停钩子）。
static void test_hit_ignores_staleness() {
    const long x = 50, y = 60;
    std::vector<FakeTarget> v = {
        mk((void*)0x1, 0, 0, 100, 100, 1),                          // 陈旧但光标在其上
        mk((void*)0x2, 200, 200, 300, 300, 0xFFFFFFFFu),            // 新鲜但光标不在
    };
    assert(host::selWheelHitIndex(v.begin(), v.end(), x, y) == 0);
    // 重叠矩形：取 lastSeen 最新者（多实例同屏旧目标不抢）
    std::vector<FakeTarget> w = {
        mk((void*)0x1, 0, 0, 100, 100, 10),
        mk((void*)0x2, 0, 0, 100, 100, 20),
    };
    assert(host::selWheelHitIndex(w.begin(), w.end(), x, y) == 1);
    // screenValid=false 不参与命中；无命中返回 npos
    std::vector<FakeTarget> u = { mk((void*)0x1, 0, 0, 100, 100, 10) };
    u[0].screenValid = false;
    assert(host::selWheelHitIndex(u.begin(), u.end(), x, y) == static_cast<std::size_t>(-1));
    assert(host::selWheelHitIndex(v.begin(), v.end(), 5000, 5000) == static_cast<std::size_t>(-1));
    std::cout << "PASS test_hit_ignores_staleness\n";
}

// ⑦：pending 与目标同口径超时修剪（严格大于才陈旧；消费点丢弃 A 实例
// ECW 关闭后 ref 抖动删不掉的幸存条目，防被 B 实例的 UPDATE_PARAMS_UI 消费）
static void test_pending_prune_stale() {
    struct P { std::uint32_t lastSeen; int delta; };
    const std::uint32_t now = 10000;
    std::vector<P> p = {
        { now - 500, 3 },     // 新鲜：保留
        { now - 3000, 3 },    // 恰等于超时：保留（与目标口径一致）
        { now - 3001, -3 },   // 超 1ms：丢弃
    };
    p.erase(host::selWheelPruneStale(p.begin(), p.end(), now, 3000), p.end());
    assert(p.size() == 2);
    assert(p[1].lastSeen == now - 3000);
    std::cout << "PASS test_pending_prune_stale\n";
}

// 命中目标的 HWND 有效性三态——命中分支只给活目标续命/消费；
//    IsWindow=false（已死实例：ECW 已关但剔除失败）→ 不续命 → 既有 3s 阈值可修剪
//    （模型级复刻 customUI.cpp selWheelMouseProc 命中段：Dead → pruneStaleMiss 后
//    放行，Alive/Unknown → lastSeen=now 后消费）。

// 假 IsWindow：句柄在白名单里 = 窗口存在
static bool fakeIsWindow(std::uintptr_t h) { return h == 0x1111 || h == 0x2222; }

// 命中分支的策略合成（与生产同序，见 customUI.cpp 命中段注释）：
// 返回 true = 续命 + 消费；false = 不续命、不消费（走未命中路径修剪）
static bool hitRefreshes(std::uintptr_t hwnd) {
    return host::selWheelHandleState(hwnd, fakeIsWindow) != host::SelWheelHandleState::Dead;
}

static void test_hit_handle_state_three_way() {
    // 三态判据本体
    assert(host::selWheelHandleState(0x1111, fakeIsWindow) == host::SelWheelHandleState::Alive);
    assert(host::selWheelHandleState(0x3333, fakeIsWindow) == host::SelWheelHandleState::Dead);   // 窗口已销毁
    assert(host::selWheelHandleState(0, fakeIsWindow) == host::SelWheelHandleState::Unknown);     // 无句柄 → 降级
    assert(host::selWheelHandleState(0x1111, nullptr) == host::SelWheelHandleState::Dead);        // 判据缺席：非零句柄视为死（保守）

    // 有效句柄（Alive）→ 续命 → 即便 lastSeen 已超时也**不得**被修剪（语义保持：
    // 指针停在列表上 >3s 的活目标仍在光标下，必须先命中并消费）
    const std::uint32_t now = 10000;
    {
        std::vector<FakeTarget> v = { mk((void*)0x1, 0, 0, 100, 100, now - 5000) };
        if (hitRefreshes(0x1111)) v[0].lastSeen = now;                    // 命中分支
        v.erase(host::selWheelPruneStale(v.begin(), v.end(), now, 3000), v.end());
        assert(v.size() == 1);                                            // 活目标存活（续命生效）
    }
    // IsWindow=false（Dead）→ 不续命 → 旧 lastSeen 照旧超时，修剪即刻收敛（修复核心：
    // 无条件 lastSeen=now → 死目标每滚一次续一次命 → 永不修剪，局部死区不收敛）
    {
        std::vector<FakeTarget> v = { mk((void*)0x2, 0, 0, 100, 100, now - 5000) };
        if (hitRefreshes(0x9999)) v[0].lastSeen = now;                    // 死目标不得走这里
        const auto e = host::selWheelPruneStale(v.begin(), v.end(), now, 3000);
        assert(e == v.begin());                                           // 全部陈旧 → 被修剪
        v.erase(e, v.end());
        assert(v.empty());                                                // 死目标收敛
    }
    // 句柄 0（Unknown）→ 保留现状（续命 + 3s 阈值降级）：续命后存活
    {
        std::vector<FakeTarget> v = { mk((void*)0x3, 0, 0, 100, 100, now - 5000) };
        if (hitRefreshes(0)) v[0].lastSeen = now;                         // 降级路径照常续命
        v.erase(host::selWheelPruneStale(v.begin(), v.end(), now, 3000), v.end());
        assert(v.size() == 1);
    }
    // 死目标在**未超时**时不会被修剪（3s 阈值语义不被本修复改变：只停止续命）
    {
        std::vector<FakeTarget> v = { mk((void*)0x4, 0, 0, 100, 100, now - 2999) };
        if (hitRefreshes(0x9999)) v[0].lastSeen = now;
        v.erase(host::selWheelPruneStale(v.begin(), v.end(), now, 3000), v.end());
        assert(v.size() == 1);
    }
    std::cout << "PASS test_hit_handle_state_three_way\n";
}

// 滚轮档数归一与行号钳制（画布滚轮）：一次 WM_MOUSEWHEEL 可能携带多档或不足
// 一档（高分辨率滚轮/触控板），画布每档 1 行；方向 = 向前滚（正 delta）偏移减。
static void test_notch_and_clamp() {
    // 整档：+120 → 1 档；−360 → −3 档
    {
        int raw = 0;
        assert(host::selWheelTakeNotches(raw, 120) == 1 && raw == 0);
        assert(host::selWheelTakeNotches(raw, -360) == -3 && raw == 0);
        assert(host::selWheelTakeNotches(raw, 240) == 2 && raw == 0);
    }
    // 不足一档：不消费、余量累积，凑满一档才返回非零
    {
        int raw = 0;
        assert(host::selWheelTakeNotches(raw, 40) == 0 && raw == 40);
        assert(host::selWheelTakeNotches(raw, 40) == 0 && raw == 80);
        assert(host::selWheelTakeNotches(raw, 40) == 1 && raw == 0);
    }
    // 负向余量：−40 −40 −40 → −1 档（整除向零取整，余量同样保持）
    {
        int raw = 0;
        assert(host::selWheelTakeNotches(raw, -40) == 0 && raw == -40);
        assert(host::selWheelTakeNotches(raw, -40) == 0 && raw == -80);
        assert(host::selWheelTakeNotches(raw, -40) == -1 && raw == 0);
    }
    // 跨事件余量：+60 ×4 = +240 → 中途凑满一档
    {
        int raw = 0;
        assert(host::selWheelTakeNotches(raw, 60) == 0 && raw == 60);
        assert(host::selWheelTakeNotches(raw, 60) == 1 && raw == 0);
    }
    // 钳制：两端截断，中间平移；maxScroll=0 时恒 0
    assert(host::selWheelClampRow(0, -1, 5) == 0);
    assert(host::selWheelClampRow(0, 1, 5) == 1);
    assert(host::selWheelClampRow(3, -2, 5) == 1);
    assert(host::selWheelClampRow(5, 3, 5) == 5);
    assert(host::selWheelClampRow(5, -5, 5) == 0);
    assert(host::selWheelClampRow(2, 9, 0) == 0);
    assert(host::selWheelClampRow(-3, 1, 5) == 0);
    std::cout << "PASS test_notch_and_clamp\n";
}

} // namespace

void runSelWheelPolicyTests() {
    test_find_by_rect_not_ref();
    test_remove_by_rect_wins_over_ref();
    test_remove_by_ref_fallback();
    test_prune_stale_and_wraparound();
    test_prune_edge_ranges();
    test_hit_ignores_staleness();
    test_pending_prune_stale();
    test_hit_handle_state_three_way();
    test_notch_and_clamp();
    std::cout << "ALL SEL WHEEL POLICY TESTS PASSED\n";
}
