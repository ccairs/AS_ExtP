#include "smartRender.h"
#include "renderer.h"
#include "params.h"
#include "effectState.h"
#include "customUI.h"   // ReadFileSelSelection：按身份名解析所需
#include "errorLog.h"
#include "glslLoader.h"
#include "uniformParser.h"
#include <string>
#include <cstring>
#include <cstdio>
#include <algorithm>
#include <cstdlib>

namespace host {

// 诊断日志（与 plugin.cpp logCmd 一致的实现，避免头文件依赖）
// 读盘节流：srLog 随 SmartRender 每帧调用多次，逐帧磁盘写是 I/O 风暴
// （与 logCmd/rfLog 的节流策略一致）；AS_EFFECT_HOST_LOG=1 解除限制
static void srLog(const char* stage, long val) {
    static const bool s_verbose = std::getenv("AS_EFFECT_HOST_LOG") != nullptr;
    // 节流计数改原子——MFR 下多个渲染线程并发 --s_budget 非原子
    //（读-改-写撕裂），日志条目偶发丢失/超发（与 rfLog/logCmd 同款修复）
    static LONG volatile s_budget = 2000;
    if (!s_verbose && InterlockedDecrement(&s_budget) < 0) return;
    const std::string path = host::diagLogFilePath("as_effect_host.log");
    if (path.empty()) return;
    // 体积上限：本函数的写入同样受 as_effect_host.log 的 16MB 轮转约束
    //（每次写入都过体积闸门：只由 logCmd 触发时它被节流到 300 次/进程，
    //  16MB 上限形同虚设——srLog 预算 2000 次，是大头写入方之一）
    host::maybeRotateDiagLog();
    // 追加段互斥——与 logCmd/rfLog/GPU 信息段并发写交错丢行；
    // 追加改 Win32 直写（appendDiagLogLine，内核原子），互斥退化为
    // 轮转互斥，纪律不变
    host::lockDiagAppend();
    {
        char body[128];
        std::snprintf(body, sizeof(body), "%s cmd=%ld", stage, val);
        host::appendDiagLogLine(body);
    }
    host::unlockDiagAppend();
}

namespace {
// 解析本实例当前选中的 shader 快照。SmartFX 的 SMART_PRE_RENDER / SMART_RENDER
// 都不传 params 数组：文件名与索引参数和其他非图层参数一样经 PF_CHECKOUT_PARAM
// 检出（SDK SmartFX「When To Access Layer Parameters」允许在任意阶段检出非图层
// 参数；图层输入才只能在 PreRender 检出）。
// forRender 语义见 effectState.h：只有 SMART_RENDER 传 true，让重载补确认
//（「重载成功即清 error.log」）落在渲染路径；SMART_PRE_RENDER 传 false，避免
// 预渲染提前吃掉该标记。
host::ShaderSnapshot checkoutInstanceShaderSnapshot(PF_InData* in_data, bool forRender,
                                                    int* outResolvedIdx) {
    int selIdx = host::kDefaultFileIndex;
    if (in_data) {
        PF_ParamDef idxDef;
        std::memset(&idxDef, 0, sizeof(idxDef));
        PF_Err cerr = PF_CHECKOUT_PARAM(in_data, host::kIdxFileIndexParam,
                                        in_data->current_time, in_data->time_step,
                                        in_data->time_scale, &idxDef);
        if (cerr == PF_Err_NONE) {
            selIdx = static_cast<int>(idxDef.u.fs_d.value);
            PF_CHECKIN_PARAM(in_data, &idxDef);
        }
    }
    std::string selName;
    if (in_data) {
        PF_ParamDef selDef;
        std::memset(&selDef, 0, sizeof(selDef));
        PF_Err serr = PF_CHECKOUT_PARAM(in_data, host::kIdxFileSelector,
                                        in_data->current_time, in_data->time_step,
                                        in_data->time_scale, &selDef);
        if (serr == PF_Err_NONE) {
            int ignored = -1;
            host::ReadFileSelSelection(in_data, selDef.u.arb_d.value, &ignored, &selName);
            PF_CHECKIN_PARAM(in_data, &selDef);
        }
    }
    int resolved = selIdx;
    host::ShaderSnapshot snap;
    if (in_data) {
        snap = host::getShaderByIdentity(selName, selIdx, /*checkReload=*/true, forRender,
                                         &resolved);
    }
    if (outResolvedIdx) *outResolvedIdx = resolved;
    return snap;
}

// iHistory 检出帧数（@history N，钳制到 kMaxHistory）。SMART_PRE_RENDER 只需要帧数。
int preRenderHistoryFrames(PF_InData* in_data) {
    int ignored = -1;
    const host::ShaderSnapshot snap =
        checkoutInstanceShaderSnapshot(in_data, /*forRender=*/false, &ignored);
    return (std::min)(snap.iterCfg.historyFrames, static_cast<int>(glsl::kMaxHistory));
}

// 输入历史取回守卫：SMART_RENDER 按 checkout id 取回的输入世界必须与
// SMART_PRE_RENDER 的请求一一对应并归还；析构统一 checkin，覆盖 renderFrame
// 抛异常/早退等所有退出路径（与 smartRender 内 WorldCheckinGuard 同款纪律）。
struct HistoryCheckinGuard {
    PF_InData* in_data;
    PF_SmartRenderExtra* sre;
    PF_EffectWorld* const* worlds;
    int count;
    ~HistoryCheckinGuard() {
        if (!sre || !sre->cb) return;
        for (int i = 0; i < count; ++i) {
            if (worlds[i]) {
                sre->cb->checkin_layer_pixels(in_data->effect_ref,
                                              host::kHistoryCheckoutIdBase + i);
            }
        }
    }
};
} // namespace

PF_Err smartPreRender(PF_InData* in_data, PF_OutData* out_data,
                      PF_ParamDef* params[], void* extra) {
    (void)out_data; (void)params;
    srLog("smart-pre-enter", 0);
    PF_PreRenderExtra* pre = reinterpret_cast<PF_PreRenderExtra*>(extra);
    if (!pre || !pre->cb) { srLog("smart-pre-no-extra", 0); return PF_Err_INTERNAL_STRUCT_DAMAGED; }
    if (!pre->input || !pre->output) { srLog("smart-pre-null-io", 0); return PF_Err_INTERNAL_STRUCT_DAMAGED; }

    // 检出输入层 0（SMART_RENDER 中用 checkout_layer_pixels 获取像素）
    PF_CheckoutResult result;
    std::memset(&result, 0, sizeof(result));
    PF_Err err = pre->cb->checkout_layer(
        in_data->effect_ref,
        0,                              // layer_index
        0,                              // checkout_idL
        &pre->input->output_request,    // 请求与输出一致
        in_data->current_time,
        in_data->time_step,
        in_data->time_scale,
        &result);
    srLog("smart-pre-checkout", (long)err);
    if (err) return err;

    // —— I2a 输入历史：按偏移时刻检出本实例输入图层 ——
    // 历史帧必须是「效果输入」在那些时刻的样子（含前序效果），与 iChannel0 同源。
    // SmartFX 规定图层输入只能在 PreRender 检出，且只能用 checkout_layer 的
    // what_time——PF_CHECKOUT_PARAM 检出图层给的是未加工的源图层（见 renderer.h
    // HistoryCheckout 注释），拿它当历史会与当前帧语义不一致。
    // 帧数取本实例选中 shader 的 @history N：未声明则不请求，不产生邻帧依赖。
    // checkout id 与 SMART_RENDER 的取回一一对应（host::kHistoryCheckoutIdBase）。
    const int historyCount = preRenderHistoryFrames(in_data);
    for (int hi = 0; hi < historyCount; ++hi) {
        const A_long histTime = in_data->current_time -
                                static_cast<A_long>(hi + 1) * in_data->time_step;
        PF_CheckoutResult histResult;
        std::memset(&histResult, 0, sizeof(histResult));
        const PF_Err herr = pre->cb->checkout_layer(
            in_data->effect_ref,
            0,                                          // layer_index（本效果输入）
            host::kHistoryCheckoutIdBase + hi,          // checkout_id（iHistoryN）
            &pre->input->output_request,                // 请求与当前输入一致
            histTime,
            in_data->time_step,
            in_data->time_scale,
            &histResult);
        srLog("smart-pre-hist", hi * 100 + ((herr == PF_Err_NONE) ? 1 : 0));
    }

    // 输出范围 = 输入范围（像素效果不改变尺寸）
    pre->output->result_rect = result.result_rect;
    pre->output->max_result_rect = result.max_result_rect;
    pre->output->flags = 0;
    srLog("smart-pre-done", 0);
    return PF_Err_NONE;
}

PF_Err smartRender(PF_InData* in_data, PF_OutData* out_data,
                   PF_ParamDef* params[], void* extra) {
    (void)out_data;
    srLog("smart-render-enter", 0);
    PF_SmartRenderExtra* sre = reinterpret_cast<PF_SmartRenderExtra*>(extra);
    if (!sre || !sre->cb) { srLog("smart-render-no-extra", 0); return PF_Err_INTERNAL_STRUCT_DAMAGED; }
    PF_Err err = PF_Err_NONE;

    // 热重载：SmartRender 声明后 AE 不再调用 Render，必须在此检测文件变化。
    // 选中索引真相源 = 尾部隐藏原生参数 kIdxFileIndexParam（脚本/UI 都写
    // 这里，随工程持久化）；再取该文件的 per-file 缓存快照——不再写任何全局镜像，
    // 多实例交替渲染互不覆盖。选择器 ARBITRARY handle f[0] 已降级为只写不读的
    // 遗留载体，不再作为索引来源；SmartRender 中 params 数组不可靠，文件名/索引/
    // 快照解析统一走 checkoutInstanceShaderSnapshot（SMART_PRE_RENDER 共用同一解析）。
    // forRender=true——渲染路径才有权消费 renderConsumePending 补确认
    //（「重载成功即清 error.log」在本回调执行，UI 调用方吃掉标记即漏执行）
    int selIdx = host::kDefaultFileIndex;
    host::ShaderSnapshot snap = checkoutInstanceShaderSnapshot(in_data, /*forRender=*/true, &selIdx);
    bool reloaded = snap.reloaded;
    // [临时诊断] SmartRender 侧取文件取证：checkout 到的索引 / 解析出的文件路径 /
    // 源码长度 / uniform 数（见 rfDiag）
    {
        char d[640];
        std::snprintf(d, sizeof(d), "diag-smart idx=%d unis=%u srclen=%u path=%s",
                      selIdx, static_cast<unsigned>(snap.uniforms.size()),
                      static_cast<unsigned>(snap.source.size()), snap.path.c_str());
        host::rfDiag(d);
    }

    // 检出输入像素
    // checked-out world 归还守卫——renderFrame 内部的大额堆分配
    // （8K 帧 RGBA float ≈530MB×2 + PBO + 纹理）可能抛 bad_alloc，异常会被
    // plugin.cpp 最外层 catch(...) 吞掉后直接返回，checkin 永不执行
    // → SDK 的 checkout/checkin 配对被打破，checked-out 输入 world 悬挂泄漏
    // （重复触发可致渲染管线挂起）。RAII 守卫保证任何退出路径（含异常栈
    // 展开）都归还输入 world；归还后置 armed=false 防重复 checkin。
    struct WorldCheckinGuard {
        PF_InData* in_data;
        PF_SmartRenderExtra* sre;
        bool armed;
        ~WorldCheckinGuard() {
            if (armed && sre && sre->cb) {
                sre->cb->checkin_layer_pixels(in_data->effect_ref, 0);
            }
        }
    };
    PF_EffectWorld* inputWorld = nullptr;
    err = sre->cb->checkout_layer_pixels(in_data->effect_ref, 0, &inputWorld);
    srLog("smart-render-checkin-pix", (long)err);
    if (err || !inputWorld) return PF_Err_INTERNAL_STRUCT_DAMAGED;
    WorldCheckinGuard worldGuard{in_data, sre, /*armed=*/true};

    // 检出输出
    PF_EffectWorld* outputWorld = nullptr;
    err = sre->cb->checkout_output(in_data->effect_ref, &outputWorld);
    if (err || !outputWorld) {
        // 守卫负责归还输入 world
        return PF_Err_INTERNAL_STRUCT_DAMAGED;
    }

    // 渲染目标：本实例文件的快照（getShaderForIndex 已在锁内拷贝，锁外使用）
    const std::string& effectSourceCopy = snap.source;
    const std::vector<glsl::Param>& uniformsCopy = snap.uniforms;

    // 无效果文件：透传（逐行拷贝，取 rowbytes 最小值防越界）
    if (effectSourceCopy.empty()) {
        A_long rows = (std::min)(inputWorld->height, outputWorld->height);
        A_long bytes = (std::min)(inputWorld->rowbytes, outputWorld->rowbytes);
        for (A_long y = 0; y < rows; ++y) {
            std::memcpy(
                reinterpret_cast<unsigned char*>(outputWorld->data) + y * outputWorld->rowbytes,
                reinterpret_cast<const unsigned char*>(inputWorld->data) + y * inputWorld->rowbytes,
                bytes);
        }
        // 输入 world 由守卫统一归还（函数返回时析构，与本行早退点同时序）
        return PF_Err_NONE;
    }

    // GL 渲染：PF_EffectWorld 是 PF_LayerDef 的 typedef（AE_Effect.h，同一类型）
    char errBuf[1024] = {0};
    PF_LayerDef* src = reinterpret_cast<PF_LayerDef*>(inputWorld);
    PF_LayerDef* out = reinterpret_cast<PF_LayerDef*>(outputWorld);

    // —— I2a 输入历史取回（SMART_PRE_RENDER 已按同一 checkout id 请求）——
    // 取回的是各偏移时刻的**效果输入**（含前序效果，与 iChannel0 同源）。
    // 取回失败/未请求（例如 shader 在 PreRender 与 Render 之间换了 @history 数量）
    // 的槽位按「无数据」传 nullptr，renderFrame 绑黑透明纹理兜底。
    // 守卫在函数返回时统一 checkin（一请求一取回一一对应）。
    const int historyCount = (std::min)(snap.iterCfg.historyFrames,
                                        static_cast<int>(glsl::kMaxHistory));
    PF_EffectWorld* histWorlds[glsl::kMaxHistory] = {nullptr, nullptr, nullptr, nullptr};
    const PF_LayerDef* histLayers[glsl::kMaxHistory] = {nullptr, nullptr, nullptr, nullptr};
    for (int hi = 0; hi < historyCount; ++hi) {
        PF_EffectWorld* world = nullptr;
        const PF_Err herr = sre->cb->checkout_layer_pixels(
            in_data->effect_ref, host::kHistoryCheckoutIdBase + hi, &world);
        if (herr != PF_Err_NONE || !world) {
            srLog("smart-hist-pix-fail", hi * 100 + static_cast<long>(herr));
            continue;
        }
        histWorlds[hi] = world;
        histLayers[hi] = reinterpret_cast<const PF_LayerDef*>(world);
    }
    HistoryCheckinGuard histGuard{in_data, sre, histWorlds, historyCount};
    // 槽位值：SMART_RENDER 回调中 params 数组不可靠，必须用 PF_CHECKOUT_PARAM 检出。
    // 每槽 4 分量各为 1 个 PF_FloatSliderDef（分量 c → 5+4i+c），
    // 各自 checkout 后合成。
    std::vector<float> userValues;
    userValues.resize(uniformsCopy.size() * host::kFloatsPerSlot, 0.0f);
    for (size_t i = 0; i < uniformsCopy.size(); ++i) {
        float* dst = &userValues[i * host::kFloatsPerSlot];
        for (int c = 0; c < host::kFloatsPerSlot; ++c) {
            const int pidx = host::slotCompIndex(static_cast<int>(i), c);
            if (pidx < 0) continue;
            PF_ParamDef pdef;
            std::memset(&pdef, 0, sizeof(pdef));
            PF_Err cerr = PF_CHECKOUT_PARAM(in_data, pidx,
                                            in_data->current_time, in_data->time_step,
                                            in_data->time_scale, &pdef);
            if (cerr == PF_Err_NONE) {
                dst[c] = static_cast<float>(pdef.u.fs_d.value);
                PF_CHECKIN_PARAM(in_data, &pdef);
            }
        }
    }
    // 一次性诊断（zzdiag-）：本次渲染用的源指纹与前 8 槽分量0 值（SmartRender 路径）
    host::diagState("zzdiag-smart", -1, host::srcHash32(effectSourceCopy.c_str(), effectSourceCopy.size()),
                    static_cast<int>(effectSourceCopy.size()),
                    userValues.data(), static_cast<int>(uniformsCopy.size()), host::kFloatsPerSlot);
    // 映射图层 checkout：与 Render 同款，对 snap.channelsUsed
    // 声明的 channel PF_CHECKOUT_PARAM（SmartRender 回调里 params 不可靠，必须
    // checkout——与上方 selector checkout 同模式）。守卫析构时 CHECKIN 全部已检出
    // 参数，覆盖 renderFrame 抛异常（bad_alloc 被外层 catch 吞掉）与下方所有
    // 早退 return（V4 纪律：checkout/checkin 严格配对，句柄不泄漏）。
    MapLayerCheckout mapCheckout;
    mapCheckout.checkout(in_data, snap.channelsUsed);
    // 相机/3D 变换查询。SmartRender 不在官方 PFInterfaceSuite 允许列表
    //（FRAME_SETUP/RENDER/DRAW）——queryCameraUniforms 内部失败静默降级单位阵，
    // 渲染不受影响；若实测 SmartRender 下查询恒失败，再评估 PreRender 期预查。
    // 「启用三维摄像机」复选框（params 数组在本回调不可靠，checkout 检出，
    // 与上方 selector 同模式；检出失败回退默认勾选）：关闭时跳过查询。
    bool camEnabled = true;
    {
        PF_ParamDef cbd;
        std::memset(&cbd, 0, sizeof(cbd));
        PF_Err cerr = PF_CHECKOUT_PARAM(in_data, host::kIdxCamEnable,
                                        in_data->current_time, in_data->time_step,
                                        in_data->time_scale, &cbd);
        if (cerr == PF_Err_NONE) {
            camEnabled = cbd.u.bd.value != 0;
            PF_CHECKIN_PARAM(in_data, &cbd);
        }
    }
    CameraUniforms cam;
    if (camEnabled) cam = queryCameraUniforms(in_data);
    // 诊断：复选框值落盘——零 cam- 条目时区分
    //「复选框关 → 未调用」与「调用了但静默失败」。srLog budget 2000/会话，
    // 每帧 5 条左右，覆盖整段实测会话足够。
    srLog("cam-enabled", camEnabled ? 1 : 0);
    // 灯光/合成联动查询。与上方相机同款约束与同款降级——SmartRender 不在
    // PFInterfaceSuite 的官方允许列表内，queryLightUniforms 内部失败静默返回全零；
    // 复选框同样经 checkout 检出（params 数组在本回调不可靠）。
    bool lightEnabled = true;
    {
        PF_ParamDef lbd;
        std::memset(&lbd, 0, sizeof(lbd));
        PF_Err lerr = PF_CHECKOUT_PARAM(in_data, host::kIdxLightEnable,
                                        in_data->current_time, in_data->time_step,
                                        in_data->time_scale, &lbd);
        if (lerr == PF_Err_NONE) {
            lightEnabled = lbd.u.bd.value != 0;
            PF_CHECKIN_PARAM(in_data, &lbd);
        }
    }
    LightUniforms lights;
    if (lightEnabled) lights = queryLightUniforms(in_data);
    srLog("light-enabled", lightEnabled ? 1 : 0);
    // 「重算代数」（手动重算的缓存失效载体）：本回调里 params 数组不可靠（与上面
    // 相机/灯光开关同款约束），必须 PF_CHECKOUT_PARAM 检出后传入。
    double solveGen = 0.0;
    {
        PF_ParamDef gbd;
        std::memset(&gbd, 0, sizeof(gbd));
        PF_Err gerr = PF_CHECKOUT_PARAM(in_data, host::kIdxSolveGen,
                                        in_data->current_time, in_data->time_step,
                                        in_data->time_scale, &gbd);
        if (gerr == PF_Err_NONE) {
            solveGen = static_cast<double>(gbd.u.fs_d.value);
            PF_CHECKIN_PARAM(in_data, &gbd);
        }
    }
    // 「实例身份」（载体见 seqIdentity.h）：真相源与 params 无关（序列数据），
    // 本回调里 in_data->sequence_data 可能为 NULL → InstanceInstanceId 内部退到
    // PF_EffectSequenceDataSuite 取只读句柄。取不到返回 0 = 旧行为（所有实例共享谱系）。
    const uint64_t instanceId = host::InstanceInstanceId(in_data);
    err = renderFrame(in_data, out_data, src, out,
                      effectSourceCopy.c_str(), &uniformsCopy,
                      errBuf, sizeof(errBuf),
                      userValues.empty() ? nullptr : userValues.data(),
                      mapCheckout.mapLayers(), camEnabled ? &cam : nullptr,
                      lightEnabled ? &lights : nullptr,
                      historyCount > 0 ? histLayers : nullptr, historyCount,
                      solveGen, instanceId);
    srLog("smart-render-frame", (long)err);
    // 诊断：首 3 槽检出值（uSpeed / uScale / uColor.r，×10000 取整）
    if (userValues.size() >= 9) {
        srLog("smart-uval0", (long)(userValues[0] * 10000.0f));
        srLog("smart-uval1", (long)(userValues[4] * 10000.0f));
        srLog("smart-uval2", (long)(userValues[8] * 10000.0f));
    }

    // checkin 输入像素（SDK 示例 SDK_Invert_ProcAmp.cpp 要求渲染后 checkin）
    // 正常路径在此手动归还并解除守卫（时序不变：渲染完立即
    // 归还）；守卫兜底其余退出路径——renderFrame 抛异常（bad_alloc 被
    // plugin.cpp 最外层 catch 吞掉的路径）、checkout_output 失败、透传早退。
    worldGuard.armed = false;
    sre->cb->checkin_layer_pixels(in_data->effect_ref, 0);

    // 错误日志（与 Render 回调一致的去重逻辑）
    // 去重叠加代际校验（与 plugin.cpp Render 路径同款）——任一实例
    // 重载成功清空目录级 error.log 后，本线程的持续同错误须强制重写
    static thread_local std::string s_lastError;
    static thread_local uint64_t s_lastErrGen = errorLogGeneration();
    if (errBuf[0]) {
        if (errBuf != s_lastError || s_lastErrGen != errorLogGeneration()) {
            // effectsDir 复用 effectState 的目录解析（跟随自定义数据目录指针）
            std::string dir = host::effectsDirPath();
            if (!dir.empty()) appendErrorLog(dir, errBuf);
            s_lastError = errBuf;
            s_lastErrGen = errorLogGeneration();
        }
    } else if (reloaded) {
        std::string dir = host::effectsDirPath();
        if (!dir.empty()) {
            clearErrorLog(dir);
            // 解析告警回写（vec 数组不支持等）：不构成渲染失败，但需面板可见，
            // 须在 clearErrorLog 之后写入，否则会被"重载成功即清"冲掉
            // （快照已含 parseWarning，无需再锁）
            if (!snap.parseWarning.empty()) appendErrorLog(dir, snap.parseWarning);
        }
        s_lastError.clear();
    }

    return err;
}

} // namespace host
