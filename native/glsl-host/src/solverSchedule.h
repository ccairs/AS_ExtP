#pragma once
// solverSchedule.h —— 结算器的纯逻辑（缓存记账 + 子步目标选取），不依赖 AE SDK/GL。
//
// 结算器这条链路上"最容易静默错、又最难在 AE 外面看见"的
// 两处判断——① 每帧几字节、什么时候开始淘汰；② 每个子步写哪张纹理（ping-pong 的
// 读写不能撞同一张）。抽成 constexpr/inline 后 glsl_core_tests 能直接钉住它们
// （tests/test_pixel_convert.cpp 的 runSolverScheduleTests）。
#include <cstdint>
#include <cstddef>
#include "pixelDepth.h"

namespace host {

// —— 逐帧整缓存的预算 ——
// 为什么逐帧整缓存而不是稀疏检查点：已算过的帧回拖时必须 O(1) 命中——用户
// 明确指出"回拖不该重头迭代"。稀疏检查点是为省内存自加的限制，
// 而实测内存根本够：512² 的 RGBA16F 是 2MB/帧，一条 250 帧（10s@25fps）的
// 镜头全缓存才 500MB。故默认逐帧缓存，只在上限处从**最早的帧**开始淘汰——
// 要淘汰就淘汰最早的，因为能重解出来的只有从 0 开始的那一段，淘汰最早的
// 等于把"可重解区间"缩到最小。
constexpr size_t kSolverCacheBudgetBytes = 512ull * 1024 * 1024;   // 512MB / 条谱系

// —— 跨谱系的全局预算 ——
// 缓存不再随实例销毁而释放（键 = 图层身份 + 参数谱系，实例克隆/销毁不动它，
// 见 renderer.cpp SolverKey），旧谱系靠 LRU 过期：静态参数每改一个值就是一条
// 新谱系，参数拖动会留下一串旧谱系，必须有进程级总额兜底。全局上限取
// 单谱系上限的 2 倍：活跃谱系吃满 512MB 后，仍给新谱系留出起步空间。
constexpr size_t kSolverCacheGlobalBudgetBytes = 1024ull * 1024 * 1024;   // 1GiB / 进程

// 单帧缓存纹理的字节数。按**实际分配的内部格式**算（见 renderer.cpp newSolverTex：
// 32bit 输入 RGBA32F = 16B/像素，其余 RGBA16F = 8B/像素）——一律按 16B 记账，
// 等于让 8/16bit 项目只拿到一半预算（上面那段注释期望的"512² 2MB/帧、250 帧 500MB"
// 在旧记账下只装得下 128 帧）。
inline size_t solverFrameBytes(int32_t w, int32_t h, PixelDepth depth) {
    if (w <= 0 || h <= 0) return 0;
    // bpp 已是"每像素字节数"（RGBA 四通道合计）：RGBA32F = 4×4B，RGBA16F = 4×2B。
    // 别在这里再乘通道数——写成 w*h*4*bpp 时 512² 会算成 8MB，被
    // tests/test_pixel_convert.cpp 的 solverFrameBytes 断言当场抓住。
    const size_t bpp = (depth == PixelDepth::Bits32) ? 4u * sizeof(float) : 2u * sizeof(float);
    return static_cast<size_t>(w) * static_cast<size_t>(h) * bpp;
}

// 预算内可持有的帧数（下界 1：永远至少留一帧，否则指纹一变就退化成"每帧从 0 重解"）
inline int solverCacheCapacity(int32_t w, int32_t h, PixelDepth depth) {
    const size_t per = solverFrameBytes(w, h, depth);
    if (per == 0) return 1;
    const size_t n = kSolverCacheBudgetBytes / per;
    return (n < 1) ? 1 : static_cast<int>(n);
}

// —— 结算器子步的目标纹理 ——
// 末子步直接写进"这一帧的缓存纹理"（先分配好），其余子步在两张暂存纹理间轮换。
// 这样每帧省掉一次全网格拷贝（子步全写在 scratch 上，画完再 glBlitFramebuffer
// 整张搬进缓存纹理）。
// 不变式：相邻两步的 target 必不相同（后一步要读前一步的产物），且最后一步是 Cache。
enum class SolverTarget { Scratch0, Scratch1, Cache };

inline SolverTarget solverStepTarget(int step, int stepsPerFrame) {
    if (stepsPerFrame <= 0) return SolverTarget::Cache;   // 防御：解析器已钳到 ≥1
    if (step >= stepsPerFrame - 1) return SolverTarget::Cache;   // 末步
    return (step % 2 == 0) ? SolverTarget::Scratch0 : SolverTarget::Scratch1;
}

// —— @solveHz 每帧子步数（纯逻辑，单测钉住）——
// substepsAt(f) = floor(Hz·(f+1)·帧时长) − floor(Hz·f·帧时长)：取整累积而非逐帧取整，
// 跨帧取整误差不累积、且是帧号的纯函数（乱序渲染/回拖/渲染队列任何顺序下同一帧拿到
// 的子步数恒相同）。Hz < 帧率时会出现 0 子步帧（状态原样延续）。每帧上限 kMaxSolveSteps，
// 第 0 帧至少 1 子步（播种步是初始化而非速率，得先发生，其后的 0 子步帧才有"上一状态"
// 可延续）。与 hz 侧的 JS 同构实现（shaderPreviewRenderer 的 substepsAt）必须同口径。
inline int solverSubstepsAt(int hz, double frameDur, int f, int maxSteps) {
    if (hz <= 0) return 0;
    const double hzv = static_cast<double>(hz);
    long long a = static_cast<long long>(std::floor(hzv * (double)(f + 1) * frameDur));
    long long b = static_cast<long long>(std::floor(hzv * (double)f * frameDur));
    long long n = a - b;
    if (n < 0) n = 0;
    if (n > maxSteps) n = maxSteps;
    if (f == 0 && n < 1) n = 1;
    return static_cast<int>(n);
}

// —— @solveHz 子步绝对步号的基址（纯逻辑，单测钉住）——
// 子步拿到的 uStep = solverStepBase(...) + 帧内子步号，契约里 uStep 是**绝对步号**，
// 播种判据是 `uStep < 0.5`——基址一旦落 0，该帧第一子步就会被 shader 当成播种。
// @solveHz 下 Hz×帧时长 < 1（Hz 低于合成帧率）时，Hz 时钟
// floor(Hz·f·帧时长) 在早期帧恒为 0，而 substepsAt(0) 被钳到 1（播种先于一切 0 子步帧）
// → f=0 之后的第一个带子步的帧（f* = ceil(1/(Hz·帧时长)) − 1）基址也是 0，与播种哨兵
// 撞车：实测 @solveHz 8 / 25fps 下播种在帧 0 与帧 3 各执行一次，整条谱系**少跑一步**，
// 且 uStep 出现重复的 0（按 uStep 判周期的逻辑会在该帧误触发）。
// 播种步不计入 Hz 时钟，但它**确实执行过**——故 f>0 的基址要把它算进去（+1），
// 仅在 f==0 的播种被钳制过（Hz×帧时长 < 1）时成立；Hz ≥ 帧率时 substepsAt(0) 本就 ≥1
// 且首子步即播种，计数已含它，不得再加。
// 仍是帧号的纯函数（乱序渲染/回拖/渲染农场下同一帧的基址恒相同）。
inline long long solverStepBase(bool hzMode, int hz, double frameDur, int f, int iterCount) {
    if (!hzMode) return static_cast<long long>(f) * static_cast<long long>(iterCount);
    const long long hzClock =
        static_cast<long long>(std::floor(static_cast<double>(hz) * static_cast<double>(f) * frameDur));
    const bool seedClamped = (static_cast<double>(hz) * frameDur < 1.0);
    return hzClock + ((f > 0 && seedClamped) ? 1 : 0);
}

// —— 谱系 LRU 的受害者选取（纯逻辑，单测钉住）——
// 全局预算超限时整条谱系按 lastTouch 最旧者先淘汰；keepIdx 是本次正在渲染的
// 谱系（绝不能淘汰——它正被锁内循环使用）。返回要淘汰的下标，无可淘汰
//（只剩 keepIdx）返回 -1。调用方循环：淘汰一个 → 重算总字节 → 仍超则再选。
inline int solverLruVictim(const uint64_t* touches, size_t n, size_t keepIdx) {
    int best = -1;
    for (size_t i = 0; i < n; ++i) {
        if (i == keepIdx) continue;
        if (best < 0 || touches[i] < touches[static_cast<size_t>(best)]) best = static_cast<int>(i);
    }
    return best;
}

} // namespace host
