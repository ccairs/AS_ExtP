// test_glctx_gen.cpp —— 上下文代际自增判据的纯逻辑单测（不依赖 AE SDK/GL/Win32）
//
// 缺陷链：
//   自建上下文在用（s_tex/s_progs/…/谱系帧纹理等名字缓存全量建立，seen=G）
//   → 驱动 TDR/设备丢失 → rebind 连续失败达阈值降级（只置 g.ok=false 会让
//   代际不变）→ 下一次 acquireAeGlContext 成功、glCtx 的 AE 分支采纳 AE 上下文
//   （该路径代际也不变）→ renderFrame 消费点 glCtxChanged=false：旧名字被当新
//   上下文对象用，持续黑/花屏且不自愈；LRU/尺寸变化还可能 glDelete* 删到 AE
//   上下文里复用了同名的新活对象。
//
// 本测把 renderer.cpp 的代际事件（自建新建 / AE 绑定失败失效 / rebind 降级 /
// AE 采纳）与消费点抽成状态机，钉住三件事：
//   ① 报告链（自建 → 降级 → 采纳 AE）上代际必须变化；
//   ② rebind 降级无条件自增（修复点 1）；
//   ③ 同一 AE 句柄重绑不得假阳性自增（否则消费点误走回收判据 → 帧纹理显存泄漏），
//      而 ctx-ae-stale-reset 的既有行为（prevRc=被遗弃句柄 + 自增）保持不变。
// 追加：降级收尾只回收本插件自建句柄（owned），AE 借用句柄只丢引用——
//   降级不回收三件套时，下一次创建分支覆写 → 每轮泄漏 1 窗口 + 1 DC + 1 HGLRC。
// 追加：AE 绑定连续失败 ≥3 清缓存后必须同时丢掉本实例的 g.rc/g.hdc
//   引用，且 owned=false 进入自建创建分支前三字段必为空——否则 owned 翻转后任一早退
//   会让 glCtxFail 的 wglDeleteContext 删掉 AE 自己的 HGLRC。状态机不变量由
//   GenModel::startSelfBuild 断言，完整缺陷链见 test_create_after_ae_bindfail_...。
#undef NDEBUG
#include <cassert>
#include <cstdint>
#include <iostream>

#include "glCtxGenPolicy.h"

namespace {

// renderer.cpp glCtx 的代际模型：事件序列 → 代际/遗弃句柄/当前句柄
//（句柄用 HGLRC 的数值身份 std::uintptr_t 表示，0 = 空）
struct GenModel {
    std::uint64_t gen = 0;               // s_glCtxGen
    std::uintptr_t prevRc = 0;           // s_glCtxGenPrevRc（消费点判"假阳性真删回收"用）
    std::uintptr_t rc = 0;               // g.rc（当前/最后绑定句柄）
    std::uintptr_t hdc = 0;              // g.hdc（与 rc 同组，引用必须一起丢）
    std::uintptr_t deletedRc = 0;        // 被真删（wglDeleteContext）的句柄；0 = 未删
    bool owned = false;                  // g.owned（句柄是否归本插件自建）

    // ctx-ok 路径：自建上下文新建成功（既有行为：prevRc=空的 0 + 自增）
    void selfBuiltCreate(std::uintptr_t newRc) {
        prevRc = 0;
        ++gen;
        rc = newRc;
        hdc = newRc + 1;                 // 自建 DC 与 HGLRC 同属本插件
        owned = true;
    }
    // ctx-ae-stale-reset：AE 绑定连续失败达阈值（既有行为：prevRc=被遗弃句柄 + 自增）。
    // 还必须就地清空本实例的 g.rc/g.hdc——若只清 s_ae*，
    // AE 的 HGLRC 引用留在单例上，下一次调用走自建创建分支即被 owned=true 带进
    // glCtxFail 的 wglDeleteContext（删掉 AE 自己的离屏上下文）。
    void aeBindFailReset(std::uintptr_t abandonedRc) {
        prevRc = abandonedRc;
        ++gen;
        rc = 0;
        hdc = 0;
    }
    // 修复点 1：ctx-rebind-giveup；owned 三件套真回收（rc 清空）、
    // AE 句柄只丢引用——生产侧两条分支都清空 g.rc/g.hdc（owned 走 glCtxReleaseOwned
    // 真删，AE 只丢引用防创建分支覆写），判据共用 host::glCtxDecideHandleRecycle。
    void rebindGiveup() {
        const host::GlCtxGenDecision d = host::glCtxDecideRebindGiveup(rc);
        if (d.bump) {
            // owned 分支下方随即真删本句柄——已删句柄不得留在 prevRc
            //（句柄值复用会造成消费点"句柄相等"假阳性）；AE 句柄照旧记录。
            prevRc = host::glCtxAbandonedRcAfterOwnedRecycle(owned, d.prevRc);
            ++gen;
        }
        // 生产侧：plan.rc=true → glCtxReleaseOwned 真删三件套；false → 只丢引用。
        // 两种来源的共同点 = g.rc/g.hdc 不再挂在单例上（创建分支不会覆写泄漏）。
        const host::GlCtxRecyclePlan plan = host::glCtxDecideHandleRecycle(owned);
        if (plan.rc && rc) deletedRc = rc;
        rc = 0;
        hdc = 0;
        owned = false;
    }
    // 修复点 2：AE 分支采纳（按判据决定是否自增）
    void aeAdopt(std::uintptr_t aeRc, std::uintptr_t aeHdc = 0x2) {
        const host::GlCtxGenDecision d = host::glCtxDecideAeAdopt(rc, aeRc);
        if (d.bump) {
            prevRc = host::glCtxAbandonedRcAfterOwnedRecycle(owned, d.prevRc);   // 
            ++gen;
        }
        // 生产侧（renderer.cpp AE 采纳段）：采纳前 glCtxReleaseOwned(g)——owned 时
        // 真删自建三件套，AE 句柄只丢引用（判据同 glCtxDecideHandleRecycle）
        const host::GlCtxRecyclePlan plan = host::glCtxDecideHandleRecycle(owned);
        if (plan.rc && rc) deletedRc = rc;
        rc = aeRc;
        hdc = aeHdc;
        owned = false;          // 采纳的 AE 句柄不归本插件
    }
    // 自建创建分支入口（renderer.cpp :1187-1188 + 显式清空）。
    // 不变量：owned=false（AE 借用引用）状态进入本分支前 rc/hdc 必为空。
    // 违反时模型直接断言失败（缺陷形态即"不清引用却翻转 owned"）。
    void startSelfBuild() {
        assert(owned || (rc == 0 && hdc == 0));
        rc = 0;
        hdc = 0;
        owned = true;
    }
    // glCtxFail → glCtxReleaseOwned：owned=true 真删（wglDeleteContext），
    // owned=false 只丢引用；两种情形三字段一律清空。
    void fail() {
        const host::GlCtxRecyclePlan plan = host::glCtxDecideHandleRecycle(owned);
        if (plan.rc && rc) deletedRc = rc;
        rc = 0;
        hdc = 0;
        owned = false;
    }
    // renderFrame 消费点：glNameStale(&seen)
    bool consumerSeesChange(std::uint64_t seen) const { return seen != gen; }
};

void test_reported_chain_selfbuilt_giveup_then_ae() {
    constexpr std::uintptr_t selfRc = 0x1000;
    constexpr std::uintptr_t aeRc   = 0x2000;
    GenModel m;
    m.selfBuiltCreate(selfRc);
    const std::uint64_t namesSeen = m.gen;        // 名字缓存建立时的代际
    m.rebindGiveup();                             // TDR：连续 30 次重绑失败降级
    assert(m.gen == namesSeen + 1);               // 修复点 1：降级必须自增
    // 自建句柄在该分支随即被真删 → 遗弃句柄记 0（已删句柄不做消费点
    // "句柄相等"判据的载体；记 selfRc，句柄值被系统复用时会假阳性）。
    assert(m.deletedRc == selfRc);
    assert(m.prevRc == 0);
    m.aeAdopt(aeRc);                              // acquire 成功，直接采纳 AE 上下文
    assert(m.gen != namesSeen);                   // 修复点 2：消费点必须看到变化
    assert(m.consumerSeesChange(namesSeen));      // glCtxChanged=true → 全部名字缓存清零
    assert(m.rc == aeRc);
    std::cout << "PASS test_reported_chain_selfbuilt_giveup_then_ae\n";
}

void test_giveup_always_bumps_without_prior_ae_adopt() {
    // 即便句柄为空（防御场景）判据也必须自增：宁多清一轮缓存，不可漏
    GenModel m;
    m.rebindGiveup();
    assert(m.gen == 1 && m.prevRc == 0);
    // 已采纳 AE 后降级：同样自增，遗弃句柄供消费点区分真假重建
    constexpr std::uintptr_t aeRc = 0x3000;
    GenModel n;
    n.aeAdopt(aeRc);
    const std::uint64_t seen = n.gen;
    n.rebindGiveup();
    assert(n.gen == seen + 1 && n.prevRc == aeRc);
    std::cout << "PASS test_giveup_always_bumps_without_prior_ae_adopt\n";
}

void test_ae_adopt_from_null_has_no_false_bump() {
    // 会话首个上下文：缓存为空，采纳无需自增（此时无失效/新建事件）
    constexpr std::uintptr_t aeRc = 0x4000;
    GenModel m;
    m.aeAdopt(aeRc);
    assert(m.gen == 0);
    assert(m.prevRc == 0);
    std::cout << "PASS test_ae_adopt_from_null_has_no_false_bump\n";
}

void test_same_ae_handle_readopt_no_false_bump() {
    // 瞬态绑定失败（未达阈值）后重绑同一 AE 句柄：名字仍指向同一上下文活对象
    constexpr std::uintptr_t aeRc = 0x5000;
    GenModel m;
    m.aeAdopt(aeRc);
    const std::uint64_t seen = m.gen;             // 名字缓存建立
    m.aeAdopt(aeRc);                              // 同一句柄重绑
    assert(m.gen == seen);                        // 不得假阳性自增
    assert(!m.consumerSeesChange(seen));          // 消费点不得误清
    // ctx-ae-stale-reset 既有语义保持：被遗弃句柄 + 自增；
    // 若之后取回同一句柄，消费点凭 prevRc==curRc + 帧纹理身份验证走真删回收
    m.aeBindFailReset(aeRc);
    assert(m.gen == seen + 1 && m.prevRc == aeRc);
    m.aeAdopt(aeRc);
    assert(m.gen == seen + 1);                    // 采纳不再二次自增
    assert(m.prevRc == aeRc);                     // 判据未被采纳覆盖 → 可回收
    std::cout << "PASS test_same_ae_handle_readopt_no_false_bump\n";
}

void test_selfbuilt_after_giveup_resets_prev_rc() {
    // 降级后 AE 不可用、改走自建新建：prevRc 必须回 0（新句柄必不同，clear-only）
    constexpr std::uintptr_t selfRc = 0x6000;
    constexpr std::uintptr_t newSelfRc = 0x7000;
    GenModel m;
    m.selfBuiltCreate(selfRc);
    m.rebindGiveup();
    assert(m.prevRc == 0);              // 自建句柄已真删 → 不记
    m.selfBuiltCreate(newSelfRc);
    assert(m.prevRc == 0 && m.rc == newSelfRc);
    std::cout << "PASS test_selfbuilt_after_giveup_resets_prev_rc\n";
}

// （观察级收口）：s_glCtxGenPrevRc 的记录判据——只有"句柄未被真删"时才有
// 记录价值。owned=true（自建）时 giveup/AE 采纳两条路径都会 wglDeleteContext 真删
// 刚记下的句柄：已删句柄若被系统复用给新 HGLRC，消费点的"句柄相等"判据会假阳性
//（身份交叉验证是第二层兜底，但可以根本不给它机会）；记 0 → 消费点走保守
// clear-only（被删上下文里的对象已随上下文消失，没有可回收的活对象，不泄漏）。
// owned=false（AE 借用句柄，只丢引用不回收）必须照旧记录——那正是"瞬时抖动取回
// 同一句柄 → 身份验证后真删回收帧纹理"判据的唯一载体（同句柄重绑不得假阳性自增）。
void test_abandoned_rc_recorded_only_for_borrowed_handles() {
    constexpr std::uintptr_t selfRc = 0xB000;
    constexpr std::uintptr_t aeRc1  = 0xB100;
    constexpr std::uintptr_t aeRc2  = 0xB200;
    // ① 自建 giveup：真删 + 记 0
    GenModel a;
    a.selfBuiltCreate(selfRc);
    a.rebindGiveup();
    assert(a.deletedRc == selfRc && a.prevRc == 0);
    // ② AE 采纳后 giveup（owned=false，只丢引用）：照旧记原句柄（真删回收判据）
    GenModel b;
    b.aeAdopt(aeRc1);
    b.rebindGiveup();
    assert(b.deletedRc == 0 && b.prevRc == aeRc1);
    // ③ 自建在用时采纳 AE：被遗弃的自建句柄真删 → 记 0
    GenModel c;
    c.selfBuiltCreate(selfRc);
    c.aeAdopt(aeRc1);
    assert(c.deletedRc == selfRc && c.prevRc == 0);
    // ④ AE 句柄被替换（采纳第二个 AE 句柄）：前一个只丢引用 → 记原句柄
    GenModel d;
    d.aeAdopt(aeRc1);
    d.aeAdopt(aeRc2);
    assert(d.deletedRc == 0 && d.prevRc == aeRc1);
    // 纯判据边界
    assert(host::glCtxAbandonedRcAfterOwnedRecycle(true, 0xC0C0) == 0);
    assert(host::glCtxAbandonedRcAfterOwnedRecycle(false, 0xC0C0) == 0xC0C0);
    std::cout << "PASS test_abandoned_rc_recorded_only_for_borrowed_handles\n";
}

// 降级收尾的句柄回收判据——自建三件套必须真回收（只置
// g.ok=false，下一次创建分支覆写三字段：每轮降级泄漏 1 窗口 + 1 DC + 1 HGLRC）；
// AE 借用句柄绝不回收（wglDeleteContext/ReleaseDC 会破坏 AE 自己的上下文），
// 只丢引用。生产侧 glCtxReleaseOwned 消费同一判据（glCtxDecideHandleRecycle）。
void test_giveup_recycles_owned_handles_only() {
    GenModel m;
    m.selfBuiltCreate(0x8000);
    const std::uint64_t seenSelf = m.gen;
    m.rebindGiveup();
    assert(m.rc == 0 && m.hdc == 0);   // 自建句柄已回收 → 创建分支不会覆写泄漏
    assert(m.deletedRc == 0x8000);     // 自建 HGLRC 真删（不泄漏）
    assert(m.prevRc == 0);             // 已删句柄不记（记 0x8000 → 判据假阳性口）
    assert(m.gen == seenSelf + 1);

    GenModel n;
    n.aeAdopt(0x9000);
    const std::uint64_t seen = n.gen;
    n.rebindGiveup();
    assert(n.gen == seen + 1);         // 降级仍须广播代际
    assert(n.rc == 0 && n.hdc == 0);   // AE 句柄只丢引用，不回收
    assert(n.deletedRc == 0);          // 绝不 wglDeleteContext(AE 的 HGLRC)
    assert(n.prevRc == 0x9000);

    // 纯判据边界：owned=false 三件套一律不回收；owned=true 整组回收
    const host::GlCtxRecyclePlan ae = host::glCtxDecideHandleRecycle(false);
    assert(!ae.hwnd && !ae.hdc && !ae.rc);
    const host::GlCtxRecyclePlan self = host::glCtxDecideHandleRecycle(true);
    assert(self.hwnd && self.hdc && self.rc);
    std::cout << "PASS test_giveup_recycles_owned_handles_only\n";
}

// 完整缺陷链（插件可删 AE 的 HGLRC）：
//   AE 分支采纳（g.rc = AE 的 HGLRC，owned=false）→ wglMakeCurrent 连续失败 ≥3：
//   只清 s_aeHdc/s_aeRc/s_aeGot 时，g.rc/g.hdc 原样留在单例上 → 下一次调用因
//   s_ae* 为空落进自建创建分支：glCtxReleaseOwned 对 owned=false 不释放也**不清空**，
//   随即 g.owned=true → CreateWindowEx/ChoosePixelFormat/tmp 上下文任一早退 →
//   glCtxFail → glCtxReleaseOwned(owned=true) → wglDeleteContext(仍是 AE 的 g.rc)：
//   插件把 AE 自己的离屏上下文删了（AE 后续 GPU 合成/效果集体失效）。
// 修复后的不变量（三处共同保证）：owned=false 进入创建分支前 rc/hdc 必为空——
//   ① glCtxReleaseOwned 无条件清空三字段（只按 plan 决定是否释放）；
//   ② AE 绑定失败 ≥3 分支就地清空 g.rc/g.hdc（与 rebind 降级分支对齐）；
//   ③ 创建入口在 owned=true 之前显式清空。
// 模型 startSelfBuild 内建该断言；本测试再走完整链条验证不会删到 AE 句柄。
void test_create_after_ae_bindfail_never_deletes_ae_handle() {
    constexpr std::uintptr_t aeRc  = 0xA000;
    constexpr std::uintptr_t aeHdc = 0xA002;
    GenModel m;
    m.aeAdopt(aeRc, aeHdc);
    m.aeBindFailReset(aeRc);              // 连续 3 次绑定失败：s_ae* 清空
    assert(m.rc == 0 && m.hdc == 0);      // ① 修复点：AE 引用就地丢干净
    m.startSelfBuild();                   // 自建创建分支入口（内建不变量断言 ②）
    m.fail();                             // CreateWindowEx 失败 → glCtxFail
    assert(m.deletedRc == 0);             // 没有任何句柄被 wglDeleteContext
    assert(m.deletedRc != aeRc);          // 尤其绝不删 AE 的 HGLRC

    // 反例（缺陷形态钉住）：若创建前未丢 AE 引用、owned 已翻转 true，
    // fail 必真删 AE 的 HGLRC——证明不变量①/②/③是唯一防线，不可回退。
    GenModel bad;
    bad.rc = aeRc;
    bad.hdc = aeHdc;
    bad.owned = true;                     // 缺陷形态：引用未清就带进 owned=true
    bad.fail();
    assert(bad.deletedRc == aeRc);        // 缺陷真实存在（模型级反例）
    std::cout << "PASS test_create_after_ae_bindfail_never_deletes_ae_handle\n";
}

} // namespace

void runGlCtxGenTests() {
    test_reported_chain_selfbuilt_giveup_then_ae();
    test_giveup_always_bumps_without_prior_ae_adopt();
    test_ae_adopt_from_null_has_no_false_bump();
    test_same_ae_handle_readopt_no_false_bump();
    test_selfbuilt_after_giveup_resets_prev_rc();
    test_abandoned_rc_recorded_only_for_borrowed_handles();
    test_giveup_recycles_owned_handles_only();
    test_create_after_ae_bindfail_never_deletes_ae_handle();
    std::cout << "ALL GLCTX GEN TESTS PASSED\n";
}
