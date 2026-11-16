// aeParams.cpp —— 参数流时变判定 + 任意时刻取值（结算器专用）
//
// 背景：@solve 的参数指纹含 uniform 值——参数一打关键帧就逐帧重解，时变驱动不可用。
// 改为**自动判定**（无需 shader 侧任何标记）：
//   · 打了关键帧/表达式的参数（时变流，AEGP_IsStreamTimevarying 含表达式判定）
//     = 驱动参数：值退出指纹、每帧读当帧值——可打关键帧做风渐强这类时变驱动；
//   · 未打关键帧的参数 = 静态参数：值留在指纹里，改值 = 从头重解（确定性调参，
//     Houdini 同款"改参回卷重放"语义；也保证换机器/渲染农场结果一致）。
// 经典 AE SDK 拿不到"自身参数在其它时刻的值"（带时间 checkout 只对图层输入存在），
// 唯一通道是 AEGP StreamSuite：
//   PFInterfaceSuite::AEGP_GetNewEffectForEffect（本实例 effect_ref → AEGP_EffectRefH）
//   → StreamSuite::AEGP_GetNewEffectStreamByIndex（参数索引 → 流）
//   → AEGP_GetNewStreamValue（任意 CompTime 求值，含表达式）。
// 官方依据与降级纪律同 aeCamera.cpp（Cheating Effect Usage of AEGP Suites；
// PFInterface 套件标注仅 FRAME_SETUP/RENDER/EVENT::DRAW 期合法，SmartRender 不在
// 列表——所有失败路径静默返回：会话拿不到 → 调用方沿用 sticky 掩码保指纹稳定、
// 追赶段按"不入缓存仅显示"降级，不影响渲染）。
#include "renderer.h"     // ParamValueSession 声明 + ensureAegpPluginId（单点注册，与相机/灯光共用）
#include "effectState.h"  // slotCompIndex
#include "params.h"       // kFloatsPerSlot
#include "AE_Effect.h"
#include "AE_GeneralPlug.h"
#include "errorLog.h"
#include <windows.h>      // InterlockedDecrement/LONG（lpLog 节流，同 camLog 手法）
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace host {

namespace {
// 取值诊断日志（节流同 camLog：默认 300 条，AS_EFFECT_HOST_LOG=1 解除）
void lpLog(const char* stage, long v0, long v1) {
    static const bool s_verbose = std::getenv("AS_EFFECT_HOST_LOG") != nullptr;
    static LONG volatile s_budget = 300;
    if (!s_verbose && InterlockedDecrement(&s_budget) < 0) return;
    const std::string path = host::diagLogFilePath("as_effect_host.log");
    if (path.empty()) return;
    host::maybeRotateDiagLog();
    lockDiagAppend();
    {
        char body[160];
        std::snprintf(body, sizeof(body), "lp-%s %ld %ld", stage, v0, v1);
        host::appendDiagLogLine(body);
    }
    unlockDiagAppend();
}
} // namespace

struct ParamValueSession {
    SPBasicSuite* pica = nullptr;
    AEGP_PluginID aegpId = 0;
    AEGP_EffectRefH fx = nullptr;                 // owned：AEGP_DisposeEffect
    // 各槽位分量的参数流（owned：AEGP_DisposeStream）。外层下标 = 槽位序号
    //（与 uniforms 同序），内层 = 分量 0..n-1；槽位流拿不到则整会话作废（保守）
    std::vector<std::vector<AEGP_StreamRefH>> streams;
    // 各槽位分量数（Float=1/Vec2=2/Vec3=3/Vec4=4）——写回 userValues 用
    std::vector<int> comps;
    // 时变掩码：bit i = 槽位 i 任一分量流时变（关键帧/表达式）
    uint32_t varyingMask = 0;
    // bit i = 槽位 i 全部分量「判定成功且非时变」（掩码载体据此允许清位，
    // 修「删光关键帧后改静态值不重解」；判定失败的分量两个掩码都不置位 → 沿用 sticky）
    uint32_t staticConfirmedMask = 0;
    // iChannel1/2/3 的输入图层身份（输入身份入结算键）：只对 acquire 传入的
    // mapDeclaredMask 置位通道查询（kIdxLayerBase+ci 的参数流 → LAYER_ID 值）。
    // chanKnown bit ci = 已捕获到**非 NONE** 的 AEGP LayerID（chanLayerId[ci] 有效）。
    // 时变流（选择随关键帧/表达式变）不取值：它进不了"静态身份"语义，纳入会让
    // 谱系键逐帧变化 → 每帧从头重解；<none>（流为 NO_DATA）也不置位——渲染侧用
    // 「检出无数据」判该态，不依赖 AEGP。任何失败静默（渲染不受影响）。
    uint8_t chanKnown = 0;
    uint64_t chanLayerId[host::kIdxMapChannels] = {0, 0, 0};
};

// 只回收会话持有的 AEGP 句柄（流 + effect ref），**不 delete 对象**。
// 失败分支里 ParamValueSession 由 unique_ptr 管生（见 acquireParamSession 的 s），
// 句柄回收必须与对象销毁分离：那里若直接调 releaseParamSession(s.get())，其结尾的
// delete s 会与 unique_ptr 析构对同一对象双重释放（堆损坏）。releaseParamSession
// = 本函数 + delete，语义不变；acquire 失败分支只用本函数（对象交给 unique_ptr）。
static void releaseParamSessionHandles(ParamValueSession* s) {
    if (!s) return;
    // 流先释放（StreamSuite），再释放 AEGP_EffectRefH（EffectSuite）
    const void* ssu = nullptr;
    if (s->pica && s->pica->AcquireSuite(kAEGPStreamSuite, kAEGPStreamSuiteVersion6, &ssu) == kSPNoError && ssu) {
        const AEGP_StreamSuite6* stream = reinterpret_cast<const AEGP_StreamSuite6*>(ssu);
        for (auto& slot : s->streams)
            for (auto st : slot)
                if (st) stream->AEGP_DisposeStream(st);
        s->pica->ReleaseSuite(kAEGPStreamSuite, kAEGPStreamSuiteVersion6);
    }
    s->streams.clear();
    if (s->pica && s->fx) {
        const void* esu = nullptr;
        if (s->pica->AcquireSuite(kAEGPEffectSuite, kAEGPEffectSuiteVersion4, &esu) == kSPNoError && esu) {
            reinterpret_cast<const AEGP_EffectSuite4*>(esu)->AEGP_DisposeEffect(s->fx);
            s->pica->ReleaseSuite(kAEGPEffectSuite, kAEGPEffectSuiteVersion4);
        }
        s->fx = nullptr;
    }
}

ParamValueSession* acquireParamSession(PF_InData* in_data,
                                       const std::vector<glsl::Param>* uniforms,
                                       uint8_t mapDeclaredMask,
                                       uint32_t* outVaryingMask,
                                       uint32_t* outStaticConfirmedMask) {
    if (outVaryingMask) *outVaryingMask = 0;
    if (outStaticConfirmedMask) *outStaticConfirmedMask = 0;
    if (!in_data || !in_data->pica_basicP || !uniforms) return nullptr;
    SPBasicSuite* pica = in_data->pica_basicP;

    std::unique_ptr<ParamValueSession> s(new ParamValueSession());
    s->pica = pica;
    if (!ensureAegpPluginId(pica, &s->aegpId)) { lpLog("no-aegp-id", 0, 0); return nullptr; }

    const void* pfsu = nullptr;
    if (pica->AcquireSuite(kAEGPPFInterfaceSuite, kAEGPPFInterfaceSuiteVersion1, &pfsu) != kSPNoError || !pfsu) {
        lpLog("pf-suite-miss", 0, 0);
        return nullptr;
    }
    const AEGP_PFInterfaceSuite1* pf = reinterpret_cast<const AEGP_PFInterfaceSuite1*>(pfsu);

    // 本实例 effect_ref → AEGP_EffectRefH（实例正确：流就是本实例的参数）
    if (pf->AEGP_GetNewEffectForEffect(s->aegpId, in_data->effect_ref, &s->fx) != A_Err_NONE || !s->fx) {
        pica->ReleaseSuite(kAEGPPFInterfaceSuite, kAEGPPFInterfaceSuiteVersion1);
        lpLog("fx-bridge-fail", 0, 0);
        return nullptr;
    }
    // 图层身份的取值时刻 = 本次渲染请求时刻（换算与 paramValueAtFrame 同款）。
    // 非时变流的取值与时刻无关（时变流下面跳过），换算失败则跳过身份查询（保守）。
    A_Time compTime = {0, 1};
    const bool compTimeOk =
        pf->AEGP_ConvertEffectToCompTime(in_data->effect_ref, in_data->current_time,
                                         in_data->time_scale, &compTime) == A_Err_NONE;
    pica->ReleaseSuite(kAEGPPFInterfaceSuite, kAEGPPFInterfaceSuiteVersion1);

    const void* ssu = nullptr;
    if (pica->AcquireSuite(kAEGPStreamSuite, kAEGPStreamSuiteVersion6, &ssu) != kSPNoError || !ssu) {
        lpLog("stream-suite-miss", 0, 0);
        // s->fx 已由上方 AEGP_GetNewEffectForEffect 取得（owned：AEGP_DisposeEffect）。
        // unique_ptr 析构只销毁 C++ 对象、不 Dispose 句柄——本分支必须走 helper 回收，
        // 否则每次会话泄漏一个 AEGP_EffectRefH（与 :137 stream-get-fail 分支同类）。
        // helper 对本分支安全：StreamSuite 刚获取失败 → 其内部 AcquireSuite 同样失败 →
        // 跳过多余的流释放；此刻 s->streams 为空。EffectSuite 独立获取，正常 Dispose fx。
        releaseParamSessionHandles(s.get());
        return nullptr;
    }
    const AEGP_StreamSuite6* stream = reinterpret_cast<const AEGP_StreamSuite6*>(ssu);

    // 预取全部槽位各分量的流 + 时变判定（一次会话一次，帧循环里只求值）
    for (size_t i = 0; i < uniforms->size() && i < 32; ++i) {
        const glsl::Param& p = (*uniforms)[i];
        const int comps = (p.type == glsl::ParamType::Float) ? 1
                        : (p.type == glsl::ParamType::Vec2)  ? 2
                        : (p.type == glsl::ParamType::Vec3)  ? 3 : 4;
        s->comps.push_back(comps);
        s->streams.push_back({});
        bool slotAllStatic = true;     // 本槽全部分量「判定成功且非时变」
        bool slotProbeFailed = false;  // 本槽任一分量判定失败（→ 不置确认静态位）
        for (int c = 0; c < comps; ++c) {
            const int pidx = slotCompIndex(static_cast<int>(i), c);
            AEGP_StreamRefH st = nullptr;
            if (pidx < 0 ||
                stream->AEGP_GetNewEffectStreamByIndex(s->aegpId, s->fx, pidx, &st) != A_Err_NONE || !st) {
                lpLog("stream-get-fail", static_cast<long>(i), c);
                // 回收已取到的流与 fx（不 delete——s 归 unique_ptr 管），再补上本分支
                // 的 StreamSuite 释放：:92 获取的 suite 只在成功路径 :122 释放，失败分支须自行回收。
                releaseParamSessionHandles(s.get());
                pica->ReleaseSuite(kAEGPStreamSuite, kAEGPStreamSuiteVersion6);
                return nullptr;
            }
            A_Boolean varying = FALSE;
            const bool varyProbeOk = (stream->AEGP_IsStreamTimevarying(st, &varying) == A_Err_NONE);
            if (varyProbeOk && varying) {
                s->varyingMask |= (1u << i);
            }
            // 逐分量记录「判定成功且非时变」——全部分量都满足时该槽位才算
            // 「确认静态」（可清位，见 solverMaskPolicy.h）。任一分量判定失败 → 该槽位
            // 既不置时变位也不置确认静态位 → 载体更新时沿用上次（sticky，防指纹振荡）。
            if (!varyProbeOk) slotProbeFailed = true;
            else if (varying) slotAllStatic = false;
            s->streams.back().push_back(st);
        }
        if (slotAllStatic && !slotProbeFailed) {
            s->staticConfirmedMask |= (1u << i);
        }
    }

    // —— iChannel1/2/3 输入图层身份（输入身份入结算键）——
    // 参数流索引恒等于 PF 参数索引（AEGP_GetNewEffectStreamByIndex 文档：0 = 输入
    // 图层、1..n = 各参数；ProjDumper 从 1 起逐参数遍历即此口径），映射图层参数在
    // kIdxLayerBase+ci。取到的流应为 LAYER_ID 类型，值 = 用户所选图层的 AEGP LayerID
    // （与 AEGP_GetLayerID 同源、合成内唯一、与渲染实例克隆无关）。三态：
    //   · LAYER_ID + 非 NONE 值 → 置 chanKnown 位（可用身份）；
    //   · NO_DATA / NONE 值 → <none>：不置位（渲染侧按检出无数据判，不靠 AEGP）；
    //   · 时变流 → 不取值：静态身份语义装不下逐帧选择，硬取会让谱系键逐帧变（每帧
    //     从 0 重解）。残差：同一图层两个同款同参实例若都选**不同**的活动图层参数，
    //     仍会合流——真机复验项。
    // 任何失败静默跳过（沿用本文件降级纪律，渲染不受影响）。
    if (mapDeclaredMask) {
        if (!compTimeOk) {
            lpLog("chan-id-notime", mapDeclaredMask, 0);
        } else {
            for (int ci = 0; ci < host::kIdxMapChannels; ++ci) {
                if (!((mapDeclaredMask >> ci) & 1u)) continue;
                AEGP_StreamRefH st = nullptr;
                const int pidx = host::kIdxLayerBase + ci;
                if (stream->AEGP_GetNewEffectStreamByIndex(s->aegpId, s->fx, pidx, &st) != A_Err_NONE || !st) {
                    lpLog("chan-id-stream-fail", ci, 0);
                    continue;
                }
                AEGP_StreamType stype = AEGP_StreamType_NO_DATA;
                A_Boolean varying = FALSE;
                const bool typeOk = stream->AEGP_GetStreamType(st, &stype) == A_Err_NONE;
                const bool varyOk = stream->AEGP_IsStreamTimevarying(st, &varying) == A_Err_NONE;
                if (typeOk && varyOk && !varying && stype == AEGP_StreamType_LAYER_ID) {
                    AEGP_StreamValue2 val;
                    std::memset(&val, 0, sizeof(val));
                    if (stream->AEGP_GetNewStreamValue(s->aegpId, st, AEGP_LTimeMode_CompTime,
                                                       &compTime, FALSE, &val) == A_Err_NONE) {
                        const AEGP_LayerIDVal lid = val.val.layer_id;
                        stream->AEGP_DisposeStreamValue(&val);
                        if (lid != AEGP_LayerIDVal_NONE) {
                            s->chanLayerId[ci] = static_cast<uint64_t>(static_cast<uint32_t>(lid));
                            s->chanKnown |= static_cast<uint8_t>(1u << ci);
                            lpLog("chan-id-ok", ci, static_cast<long>(lid));
                        }
                    } else {
                        lpLog("chan-id-val-fail", ci, 0);
                    }
                } else {
                    // 类型非 LAYER_ID / 时变 / 查询失败：都按"身份未知"处理（不置位）
                    lpLog("chan-id-skip", ci * 10000 + (typeOk ? (long)stype : 99) * 100 + (varyOk ? (varying ? 1 : 0) : 2), 0);
                }
                stream->AEGP_DisposeStream(st);
            }
        }
    }
    pica->ReleaseSuite(kAEGPStreamSuite, kAEGPStreamSuiteVersion6);
    if (outVaryingMask) *outVaryingMask = s->varyingMask;
    if (outStaticConfirmedMask) *outStaticConfirmedMask = s->staticConfirmedMask;
    lpLog("session-ok", static_cast<long>(uniforms->size()), static_cast<long>(s->varyingMask));
    return s.release();
}

bool paramSessionChannelLayerId(const ParamValueSession* s, int ci, uint64_t* outLayerId) {
    if (!s || ci < 0 || ci >= host::kIdxMapChannels) return false;
    if (!((s->chanKnown >> ci) & 1u)) return false;
    if (outLayerId) *outLayerId = s->chanLayerId[ci];
    return true;
}

bool paramValueAtFrame(ParamValueSession* s, PF_InData* in_data, int frame,
                       uint32_t varyingMask, float* userValuesInOut) {
    if (!s || !in_data || !userValuesInOut) return false;

    const void* ssu = nullptr;
    if (s->pica->AcquireSuite(kAEGPStreamSuite, kAEGPStreamSuiteVersion6, &ssu) != kSPNoError || !ssu)
        return false;
    const AEGP_StreamSuite6* stream = reinterpret_cast<const AEGP_StreamSuite6*>(ssu);

    // 帧号 → 图层时间（与 Solver 分支 curFrame 同口径：frame * time_step）
    // → PFInterface 的合成时间换算 → CompTime 求值。time_step 为 0 的极端
    // 状态按第 0 帧处理（与 Solver 分支 frame=0 兜底一致）。
    const A_long what = in_data->time_step
                      ? static_cast<A_long>((double)frame * in_data->time_step)
                      : 0;

    const void* pfsu = nullptr;
    A_Time compTime = {0, 1};
    bool ok = false;
    if (s->pica->AcquireSuite(kAEGPPFInterfaceSuite, kAEGPPFInterfaceSuiteVersion1, &pfsu) == kSPNoError && pfsu) {
        const AEGP_PFInterfaceSuite1* pf = reinterpret_cast<const AEGP_PFInterfaceSuite1*>(pfsu);
        ok = pf->AEGP_ConvertEffectToCompTime(in_data->effect_ref, what, in_data->time_scale,
                                              &compTime) == A_Err_NONE;
        s->pica->ReleaseSuite(kAEGPPFInterfaceSuite, kAEGPPFInterfaceSuiteVersion1);
    }
    if (!ok) { s->pica->ReleaseSuite(kAEGPStreamSuite, kAEGPStreamSuiteVersion6); lpLog("comp-time-fail", frame, 0); return false; }

    // 逐时变槽位逐分量求值，写回 userValuesInOut 的对应槽（4 float/槽）。
    // 静态槽位不取（常量流任何时刻值 = 请求帧值，调用方已就位）。
    bool allOk = true;
    for (size_t i = 0; i < s->streams.size() && i < 32; ++i) {
        if (!(varyingMask & (1u << i))) continue;
        for (size_t c = 0; c < s->streams[i].size(); ++c) {
            // 值结构不带类型（AEGP_StreamValue2 = {streamH, val}），一维判定走流类型：
            // 槽位参数全部是 PF_FLOAT_SLIDER → 一维流；类型意外（ARB 等）按失败处理
            AEGP_StreamType stype = AEGP_StreamType_NO_DATA;
            if (stream->AEGP_GetStreamType(s->streams[i][c], &stype) != A_Err_NONE ||
                stype != AEGP_StreamType_OneD) {
                allOk = false;
                continue;
            }
            AEGP_StreamValue2 val;
            std::memset(&val, 0, sizeof(val));
            if (stream->AEGP_GetNewStreamValue(s->aegpId, s->streams[i][c],
                                               AEGP_LTimeMode_CompTime, &compTime,
                                               FALSE,   // 表达式参与求值（取"所见值"）
                                               &val) != A_Err_NONE) {
                allOk = false;
                continue;
            }
            userValuesInOut[i * host::kFloatsPerSlot + c] = static_cast<float>(val.val.one_d);
            stream->AEGP_DisposeStreamValue(&val);
        }
    }
    s->pica->ReleaseSuite(kAEGPStreamSuite, kAEGPStreamSuiteVersion6);
    if (!allOk) lpLog("value-fail", frame, 0);
    return allOk;
}

// 释放会话（流 → AEGP_EffectRefH 逐层 dispose 后 delete 对象）。
// 句柄回收体在 releaseParamSessionHandles（acquire 失败分支单独用它，见其注释）。
void releaseParamSession(ParamValueSession* s) {
    if (!s) return;
    releaseParamSessionHandles(s);
    delete s;
}

} // namespace host
