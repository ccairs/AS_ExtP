#pragma once
// glCtxGenPolicy.h —— GL 上下文代际自增判据的纯逻辑，不依赖 AE SDK/GL/Win32。
//
// 抽出背景：「自建降级 → 采纳 AE 上下文」这条路径上的
// 代际漏自增——用自建上下文时（s_tex/s_progs/s_iterTex/s_solveScratch/s_fbo/
// s_vao/vbo/pbo/映射与历史纹理/谱系帧纹理等名字缓存全量建立）→ 驱动 TDR/设备丢失 →
// rebind 连续失败降级（ctx-rebind-giveup）未自增 → 下一次 acquireAeGlContext 成功、
// glCtx 的 AE 分支直接采纳 AE 上下文也未自增 → renderFrame 消费点
//（glNameStale(&s_seenGlCtxGen)）看到 glCtxChanged=false：旧名字被当新上下文对象用，
// 持续黑屏/花屏且不自愈；尺寸变化/LRU 淘汰还可能把 glDelete* 打到 AE 上下文里复用了
// 同名的新活对象。判据本身很小、但写错静默且用户可见，故抽成纯函数由 glsl_core_tests
// 的 runGlCtxGenTests 钉住（tests/test_glctx_gen.cpp）。
//
// 句柄用 std::uintptr_t 表示（HGLRC 的数值身份，0 = 无/空句柄）：头文件保持零 Win32
// 依赖，renderer.cpp 侧以 reinterpret_cast 转换（HGLRC 与 uintptr_t 同宽）。
#include <cstdint>

namespace host {

struct GlCtxGenDecision {
    bool bump = false;              // 是否 ++s_glCtxGen（广播所有名字缓存作废）
    std::uintptr_t prevRc = 0;      // 自增时写入 s_glCtxGenPrevRc 的"遗弃句柄"
};

// ctx-rebind-giveup：当前绑定上下文重绑连续失败达阈值、被判失效/丢失。
// 无论原句柄来自自建还是 AE，旧名字都可能已随上下文失效——必须自增（修复点 1）。
// 遗弃句柄记原句柄：真 TDR 后新句柄必不同（消费侧天然 clear-only）；若只是瞬时
// 抖动、之后重绑又取回同一 HGLRC，消费侧凭"句柄相等 + 帧纹理身份交叉验证"走真删
// 回收（与 ctx-ae-stale-reset 的既有语义一致，不误删也不让帧纹理成显存垃圾）。
inline GlCtxGenDecision glCtxDecideRebindGiveup(std::uintptr_t abandonedRc) {
    return { true, abandonedRc };
}

// AE 分支采纳前判据（prevRc = 采纳前的 g.rc，aeRc = 即将采纳的 s_aeRc）。
// bump=true 当且仅当存在上一个句柄且与将采纳的 AE 句柄不同——这正是"从非 AE
// 上下文（自建/旧 AE）切到新 AE 上下文"的名字空间更换点（修复点 2）。
// prevRc 为 0（从未绑定过上下文，或旧句柄已被 glCtxFail 回收）时为 false：对应
// 的失效/新建事件（giveup 或自建新建）已自增过，消费点不会漏；会话首个上下文
// 时代际从 0 起、各缓存本就为空，同样无需重复自增。
// prevRc == aeRc（同一 AE 句柄重绑，如瞬态绑定失败后恢复）必须为 false：名字仍
// 指向同一上下文里的活对象，自增会让消费点错过"假阳性真删回收"判据（显存泄漏）。
inline GlCtxGenDecision glCtxDecideAeAdopt(std::uintptr_t prevRc, std::uintptr_t aeRc) {
    if (prevRc != 0 && prevRc != aeRc) return { true, prevRc };
    return { false, 0 };
}

// 写入 s_glCtxGenPrevRc 前的"遗弃句柄有效性"判据。
// 语义背景（见 renderer.cpp s_glCtxGenPrevRc 注释）：该句柄是消费点区分
// 「真 TDR（句柄必不同 → 只清不删）」与「瞬时抖动（取回同一句柄 → 身份验证后
// 真删回收）」的唯一载体。giveup/AE 采纳两条自增路径都会先记句柄、随后按
// owned 语义回收当前上下文：owned=true（自建）时 glCtxReleaseOwned 会
// **wglDeleteContext 真删**这个刚被记下的句柄——句柄值可能被系统复用给新
// HGLRC，届时消费点的"句柄相等"判据会假阳性（身份交叉验证是第二层兜底，
// 但可以根本不给它机会：已删句柄不可能是"仍有效"的旧上下文）。
// owned=true → 记 0（消费点走保守 clear-only：旧对象随被删上下文一起消失，
// 没有可回收的活对象，无泄漏敞口）；owned=false（AE 借用句柄，只丢引用不回收）
// → 照旧记原句柄，保住"瞬时抖动取回同一句柄"的真删回收判据。
// 两处自增若都无条件记原句柄，owned 场景下记的是已删句柄（残留观察项）。
inline std::uintptr_t glCtxAbandonedRcAfterOwnedRecycle(bool ownedRecycled,
                                                        std::uintptr_t abandonedRc) {
    return ownedRecycled ? 0 : abandonedRc;
}

// 句柄回收范围判据。glCtx 的 hwnd/hdc/rc 三件套只有两种来源：
//   · owned=true —— 本插件自建（CreateWindowEx/GetDC/wglCreateContext），归本插件，
//     收尾/降级时必须整组回收（否则每轮降级泄漏 1 窗口 + 1 DC + 1 HGLRC）；
//   · owned=false —— 借用的 AE 离屏设备/上下文（PF_GPUDeviceSuite），**绝不回收**：
//     wglDeleteContext 删的是 AE 自己的 GL 上下文，ReleaseDC 配错窗口句柄——
//     会直接破坏 AE 会话。只能丢引用，让 acquireAeGlContext 重查决定后续。
// （插件可删 AE 的 HGLRC）补充契约：plan 只决定「是否释放」，
// **引用清空与所有权复位是无条件的**（renderer.cpp glCtxReleaseOwned 总是把
// hwnd/hdc/rc 置空、owned=false）。owned=false 进入自建创建分支（owned 翻转
// true）之前三个句柄字段必须为空——否则 CreateWindowEx/PF/tmp 任一早退 →
// glCtxFail → 按 owned 语义 wglDeleteContext(仍是 AE 的 rc)。glCtx 的三条
// 相关路径都必须维持该不变量：AE 绑定连续失败 ≥3 的就地清空、rebind 降级
// 分支、创建分支入口；状态机回归见 tests/test_glctx_gen.cpp
//（test_create_after_ae_bindfail_never_deletes_ae_handle）。
struct GlCtxRecyclePlan {
    bool hwnd = false;
    bool hdc = false;
    bool rc = false;
};
inline GlCtxRecyclePlan glCtxDecideHandleRecycle(bool owned) {
    return owned ? GlCtxRecyclePlan{true, true, true} : GlCtxRecyclePlan{false, false, false};
}

// —— 名字缓存的「假阳性真删回收」判据 ——
// 缺陷链：上下文代际变化时，非结算名字缓存（迭代/结算暂存/渲染目标/映射与历史纹理等）
// 只置 0 不 glDelete*——真 TDR 下这是**唯一正确**做法（旧名字可能已被新上下文复用，
// 删名字会误删新上下文里的活对象；旧对象随旧上下文一起消失）。但**瞬时抖动**
//（ctx-ae-stale-reset / ctx-rebind-giveup 的假阳性：连续 makeCurrent 失败后取回同一
// HGLRC）时这些对象仍在活上下文里，只置 0 就是"无人引用也无人释放"的显存垃圾——
// 反复抖动持续累积。已有一个正确判据落在**结算帧**身份上（renderer.cpp
// solverFramesIdentityHolds + 遗弃句柄==当前句柄）；本函数把它推广成通用判据：
// 只有「代际确实变了 ∧ 遗弃句柄 == 当前绑定的句柄（ctx 没换）∧ 对象身份验证通过」
// 三者同时成立，才允许调用方 glDelete* 主动回收；否则维持只置 0 的 TDR 安全路径
//（宁漏回收，不误删——真 TDR 场景的正确性是硬约束）。
// 参数：
//   prevGen/curGen —— 缓存条目建立时记下的代际 与 当前代际（genChanged 判据）；
//   handleSame     —— 代际自增处记下的"遗弃句柄"与当前实际绑定句柄相等（第一层）；
//   identityOk     —— 调用方对该缓存对象的身份交叉验证结论（第二层；纹理 = glIsTexture
//                     + level0 尺寸与记录一致，见 renderer.cpp glTextureIdentityOk）。
inline bool glCacheReclaimAllowed(std::uint64_t prevGen, std::uint64_t curGen,
                                  bool handleSame, bool identityOk) {
    return prevGen != curGen && handleSame && identityOk;
}

} // namespace host
