// aeLights.cpp —— 渲染期 AEGP 查询（合成灯光 → LightUniforms）
// 官方依据：Cheating Effect Usage of AEGP Suites（效果可借 PF_InData::pica_basicP
// 调 AEGP 套件读取相机/灯光信息）+ effect-details/accessing-camera-light-information.md
// （"You can also use many of the other functions from AE_GeneralPlug.h"）。
//
// 与相机那条线的**关键差异**：SDK 有 AEGP_GetEffectCamera 可直取活动相机，但
// **没有 AEGP_GetEffectLight**（AE_GeneralPlug.h:4142-4171 的 PFInterfaceSuite1
// 里不存在），灯光必须自己从合成枚举：GetEffectLayer → GetLayerParentComp →
// GetCompNumLayers/GetCompLayerByIndex → 按 ObjectType 筛灯 → 逐灯读流与变换。
//
// 本文件所有失败路径一律静默返回默认值——灯光感知是纯增量能力，任何 AEGP
// 不可用（SmartRender 回调超范围/套件缺席/AE 早期启动阶段）都不能影响渲染。
#include "aeLights.h"
#include "renderer.h"   // queryLightUniforms / ensureAegpPluginId 声明（PF_InData 依赖 AE SDK 头）
#include <windows.h>    // InterlockedDecrement/LONG（ltLog 节流，同 camLog/rfLog/srLog 手法）
#include "AE_Effect.h"
#include "AE_GeneralPlug.h"
#include "errorLog.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace host {

// 灯光诊断日志：默认写 <数据根>\temp\logs\as_effect_host.log（与 camLog/rfLog 同款追加互斥）。
// 节流：默认仅前 400 条落盘（覆盖一次方向定标实测：三行基向量 × 若干灯）；
// AS_EFFECT_HOST_LOG=1 解除限制。
//
// 本机 AE 运行期 fopen("a") 追加**静默失败**（见 errorLog.h
// 的 rawTrace 注释；rfLog/rfDiag 早已备有同款旁路）。实测证据：本次灯光验证中
// as_effect_host.log 始终停留在旧会话时间戳，而 as_effect_host_trace.log 正常增长。
// 只走 fopen 会让本探针在真实渲染期**完全不可见**——而方向定标恰恰只能靠它，
// 整个探针等于白写。故与 rfDiag 同策略：诊断模式（AS_EFFECT_HOST_LOG=1）下追加
// Win32 直写（rawTraceLine → as_effect_host_trace.log）；fopen 保留作尽力而为
//（能写成功时 as_effect_host.log 同样有份，两处内容一致，便于按习惯 grep）。
//
// 刷屏控制：rawTrace 路径按**内容去重**（thread_local 记上一条）——定标期间灯不动，
// 基向量恒定，首帧打出全部行后即静默，只有真正变化（转灯/改强度）才再落盘。
// 这样诊断模式下全量开启也不会被逐帧刷爆 trace 日志（同 rfDiag 的 s_lastDiag 手法）。
static void ltLog(const char* stage, const char* label, double v0, double v1, double v2) {
    static const bool s_verbose = std::getenv("AS_EFFECT_HOST_LOG") != nullptr;
    static LONG volatile s_budget = 400;
    if (!s_verbose && InterlockedDecrement(&s_budget) < 0) return;
    const std::string path = host::diagLogFilePath("as_effect_host.log");
    if (path.empty()) return;

    char body[192];
    const int n = std::snprintf(body, sizeof(body), "lt-%s [%s] %.6g %.6g %.6g\n",
                                stage, label, v0, v1, v2);
    if (n <= 0) return;

    if (s_verbose) {
        static thread_local std::string s_last;
        if (s_last != body) {          // 内容变化才落盘（灯静止时零刷屏）
            s_last = body;
            host::rawTraceLine(body);  // 时间戳由 rawTraceLine 统一加
        }
    }

    // 体积上限：本函数的写入同样受 as_effect_host.log 的 16MB 轮转约束
    host::maybeRotateDiagLog();
    lockDiagAppend();
    // body 末尾自带换行（rawTraceLine 直接吃整行）；直写函数自己补换行 → 去尾避免空行
    {
        std::string oneLine(body);
        if (!oneLine.empty() && oneLine[oneLine.size() - 1] == '\n') {
            oneLine.erase(oneLine.size() - 1);
        }
        host::appendDiagLogLine(oneLine.c_str());
    }
    unlockDiagAppend();
}

// —— AEGP 套件借用守卫 ——
// 本次查询要借 4 个套件（PFInterface/Layer/Light/Stream），早退路径多达十余处；
// 逐一手写 ReleaseSuite（aeCamera.cpp 的手法）在本函数规模下极易漏放。
// 守卫析构统一释放，覆盖全部早退与异常路径（与 MapLayerCheckout 同款 RAII 纪律）。
class SuiteGuard {
public:
    explicit SuiteGuard(SPBasicSuite* pica) : pica_(pica) {}
    ~SuiteGuard() {
        if (!pica_) return;
        // 逆序释放（后借的先还）
        for (int i = n_ - 1; i >= 0; --i) pica_->ReleaseSuite(names_[i], vers_[i]);
    }
    SuiteGuard(const SuiteGuard&) = delete;
    SuiteGuard& operator=(const SuiteGuard&) = delete;

    bool acquire(const char* name, int32_t version, const void** out) {
        if (!pica_ || n_ >= kMaxSuites) return false;
        const void* su = nullptr;
        if (pica_->AcquireSuite(name, version, &su) != kSPNoError || !su) return false;
        names_[n_] = name;
        vers_[n_] = version;
        ++n_;
        *out = su;
        return true;
    }

private:
    static constexpr int kMaxSuites = 4;
    SPBasicSuite* pica_ = nullptr;
    const char* names_[kMaxSuites] = {};
    int32_t vers_[kMaxSuites] = {};
    int n_ = 0;
};

// 读一个 OneD 流（强度/锥角/锥形羽化/衰减参数）。失败或流类型不符时返回 false
// 且不修改 out（调用方保留默认值）。
// pre_expressionB = false：取**表达式求值后**的最终值（灯光常用表达式驱动强度，
// 读原始值会拿到未求值的常量）。
static bool readOneD(const AEGP_StreamSuite6* ss, AEGP_LayerH layer,
                     AEGP_LayerStream which, const A_Time* compTime, double* out) {
    if (!ss) return false;
    AEGP_StreamVal2 val;
    AEGP_StreamType st = AEGP_StreamType_NO_DATA;
    std::memset(&val, 0, sizeof(val));
    if (ss->AEGP_GetLayerStreamValue(layer, which, AEGP_LTimeMode_CompTime, compTime,
                                     false, &val, &st) != A_Err_NONE) {
        return false;
    }
    if (st != AEGP_StreamType_OneD) return false;
    *out = val.one_d;
    return true;
}

// 读颜色流。AEGP_ColorVal 分量域 [0,1]（AE_GeneralPlug.h:152-154），
// 结构体成员顺序为 alphaF, redF, greenF, blueF。
static bool readColor(const AEGP_StreamSuite6* ss, AEGP_LayerH layer,
                      AEGP_LayerStream which, const A_Time* compTime, double rgb[3]) {
    if (!ss) return false;
    AEGP_StreamVal2 val;
    AEGP_StreamType st = AEGP_StreamType_NO_DATA;
    std::memset(&val, 0, sizeof(val));
    if (ss->AEGP_GetLayerStreamValue(layer, which, AEGP_LTimeMode_CompTime, compTime,
                                     false, &val, &st) != A_Err_NONE) {
        return false;
    }
    if (st != AEGP_StreamType_COLOR) return false;
    rgb[0] = val.color.redF;
    rgb[1] = val.color.greenF;
    rgb[2] = val.color.blueF;
    return true;
}

// 单盏灯的原始读数（未归一化，AE 世界坐标）。收集完成后再按截断规则排序输出。
struct RawLight {
    float  type = 0.0f;         // shader 侧常量
    bool   isAmbient = false;
    double posAE[3] = {0, 0, 0};      // 世界位置（AE 原值，Y 向下）
    double basisRow2[3] = {0, 0, 0};  // layer→world 第 2 行 = 发射方向（已定标，见 aeLights.h）
    double rgb[3] = {0, 0, 0};
    double intensity = 0.0;
    double coneAngle = 0.0, coneFeather = 0.0;
    double falloffStart = 0.0, falloffDist = 0.0;
};

// 合成图层扫描上限：防御性上限——每层至少 2 次 AEGP 调用，超大合成（数千层）
// 会让每帧查询开销失控。触发即在诊断日志打一条，便于发现被截。
static constexpr A_long kMaxLayersScanned = 2000;

LightUniforms queryLightUniforms(PF_InData* in_data) {
    LightUniforms lu;
    if (!in_data || !in_data->pica_basicP) {
        ltLog("no-pica", "pica_basicP null", 0, 0, 0);
        return lu;
    }
    SPBasicSuite* pica = in_data->pica_basicP;

    // AEGP plugin id：与相机线共用同一 id 与失败短路标志（进程级一次）
    if (!ensureAegpPluginId(pica, nullptr)) return lu;

    SuiteGuard suites(pica);
    const void* su = nullptr;

    // —— PFInterface：合成时间换算 + 本图层（枚举的起点，唯一入口）——
    if (!suites.acquire(kAEGPPFInterfaceSuite, kAEGPPFInterfaceSuiteVersion1, &su)) {
        ltLog("pf-suite-miss", "acquire", 0, 0, 0);
        return lu;
    }
    const AEGP_PFInterfaceSuite1* pf = reinterpret_cast<const AEGP_PFInterfaceSuite1*>(su);

    A_Time compTime = {0, 1};
    if (pf->AEGP_ConvertEffectToCompTime(in_data->effect_ref,
                                         in_data->current_time,
                                         in_data->time_scale,
                                         &compTime) != A_Err_NONE) {
        ltLog("comp-time-err", "convert", 0, 0, 0);
        return lu;
    }

    AEGP_LayerH selfLayer = nullptr;
    if (pf->AEGP_GetEffectLayer(in_data->effect_ref, &selfLayer) != A_Err_NONE || !selfLayer) {
        ltLog("self-layer-err", "aegp", 0, 0, 0);
        return lu;
    }

    // —— LayerSuite：合成句柄 + 图层枚举 + 层→世界变换 ——
    if (!suites.acquire(kAEGPLayerSuite, kAEGPLayerSuiteVersion9, &su)) {
        ltLog("layer-suite-miss", "acquire", 0, 0, 0);
        return lu;
    }
    const AEGP_LayerSuite9* layerSuite = reinterpret_cast<const AEGP_LayerSuite9*>(su);

    AEGP_CompH compH = nullptr;
    if (layerSuite->AEGP_GetLayerParentComp(selfLayer, &compH) != A_Err_NONE || !compH) {
        ltLog("parent-comp-err", "aegp", 0, 0, 0);
        return lu;
    }

    A_long numLayers = 0;
    if (layerSuite->AEGP_GetCompNumLayers(compH, &numLayers) != A_Err_NONE) {
        ltLog("num-layers-err", "aegp", 0, 0, 0);
        return lu;
    }
    const bool truncatedScan = (numLayers > kMaxLayersScanned);
    if (truncatedScan) {
        ltLog("scan-capped", "numLayers", (double)numLayers, (double)kMaxLayersScanned, 0);
        numLayers = kMaxLayersScanned;
    }

    // —— 本图层原点（AE 世界原值）——
    // 灯位置必须相对图层原点，才能与 uCamPos / uWorldMatrix 落在同一空间
    // （shader 侧把 uLightPos 与图层世界位置相减才成立）。此处自算而非依赖
    // queryCameraUniforms 的返回值：两条链路保持解耦，任一条失败不牵连另一条；
    // 且「相机复选框关闭」时相机那次查询根本不执行，灯光仍需拿到原点。
    // 换算路径与相机侧完全同源：GetLayerToWorldXform → convertWorldMatrix →
    // worldMatrixOriginAE（同一个纯函数）。
    double layerOAE[3] = {0, 0, 0};
    {
        A_Matrix4 selfMat;
        std::memset(&selfMat, 0, sizeof(selfMat));
        if (layerSuite->AEGP_GetLayerToWorldXform(selfLayer, &compTime, &selfMat) == A_Err_NONE) {
            float selfWorld[16];
            convertWorldMatrix(selfMat.mat, selfWorld);
            worldMatrixOriginAE(selfWorld, layerOAE);
        }
    }

    // —— LightSuite：灯型 ——
    if (!suites.acquire(kAEGPLightSuite, kAEGPLightSuiteVersion2, &su)) {
        ltLog("light-suite-miss", "acquire", 0, 0, 0);
        return lu;
    }
    const AEGP_LightSuite2* lightSuite = reinterpret_cast<const AEGP_LightSuite2*>(su);

    // —— StreamSuite：逐参数取值（AEGP_GetLayerStreamValue 一步到位，无需递归走流树）——
    if (!suites.acquire(kAEGPStreamSuite, kAEGPStreamSuiteVersion6, &su)) {
        ltLog("stream-suite-miss", "acquire", 0, 0, 0);
        return lu;
    }
    const AEGP_StreamSuite6* streamSuite = reinterpret_cast<const AEGP_StreamSuite6*>(su);

    // —— 枚举筛灯 ——
    std::vector<RawLight> collected;
    collected.reserve(8);
    A_long totalLights = 0, skippedInactive = 0, skippedSolo = 0;

    // Solo 预扫：AE 的 solo 不反映到 VIDEO_ACTIVE（真机实测，见 aeLights.h 的
    // lightIncluded 注释），故需要先知道「本合成是否有任一图层被 solo」——
    // 有则只有自身被 solo 的灯参与照明（对齐 AE 渲染器的可见性规则）。
    bool compHasSolo = false;
    for (A_long s = 0; s < numLayers; ++s) {
        AEGP_LayerH soloLayerH = nullptr;
        if (layerSuite->AEGP_GetCompLayerByIndex(compH, s, &soloLayerH) != A_Err_NONE || !soloLayerH) {
            continue;
        }
        AEGP_LayerFlags soloFlags = 0;
        if (layerSuite->AEGP_GetLayerFlags(soloLayerH, &soloFlags) == A_Err_NONE &&
            (soloFlags & AEGP_LayerFlag_SOLO) != 0) {
            compHasSolo = true;
            break;
        }
    }

    for (A_long i = 0; i < numLayers; ++i) {
        AEGP_LayerH layerH = nullptr;
        if (layerSuite->AEGP_GetCompLayerByIndex(compH, i, &layerH) != A_Err_NONE || !layerH) {
            continue;
        }
        AEGP_ObjectType otype = AEGP_ObjectType_NONE;
        if (layerSuite->AEGP_GetLayerObjectType(layerH, &otype) != A_Err_NONE) continue;
        if (otype != AEGP_ObjectType_LIGHT) continue;
        ++totalLights;

        // 可见性：眼睛开关（VIDEO_ACTIVE=0x1）+ Solo（SOLO=0x4000，AE_GeneralPlug.h:940/954）。
        // 关掉的灯不参与照明；有 solo 时只有被 solo 的灯参与——两条都由 lightIncluded
        // 单点判定（纯函数，可单测）。
        AEGP_LayerFlags flags = 0;
        if (layerSuite->AEGP_GetLayerFlags(layerH, &flags) == A_Err_NONE) {
            const bool videoActive = (flags & AEGP_LayerFlag_VIDEO_ACTIVE) != 0;
            const bool isSolo = (flags & AEGP_LayerFlag_SOLO) != 0;
            if (!lightIncluded(videoActive, isSolo, compHasSolo)) {
                if (!videoActive) ++skippedInactive;
                else ++skippedSolo;
                continue;
            }
        }

        AEGP_LightType ltype = AEGP_LightType_NONE;
        if (lightSuite->AEGP_GetLightType(layerH, &ltype) != A_Err_NONE) continue;
        const float shaderType = lightTypeToShader(static_cast<long>(ltype));
        if (shaderType < 0.0f) continue;   // NONE / 未知灯型：跳过，不占配额

        RawLight rl;
        rl.type = shaderType;
        rl.isAmbient = (ltype == AEGP_LightType_AMBIENT);

        // 层→世界变换：平移列即灯位置；第 2 行即发射方向（已定标，见 aeLights.h）。
        // 环境光无空间属性，跳过变换查询（省一次调用，也避免其矩阵未定义时污染方向）。
        A_Matrix4 mat;
        std::memset(&mat, 0, sizeof(mat));
        if (!rl.isAmbient &&
            layerSuite->AEGP_GetLayerToWorldXform(layerH, &compTime, &mat) == A_Err_NONE) {
            rl.posAE[0] = mat.mat[3][0];
            rl.posAE[1] = mat.mat[3][1];
            rl.posAE[2] = mat.mat[3][2];
            rl.basisRow2[0] = mat.mat[2][0];
            rl.basisRow2[1] = mat.mat[2][1];
            rl.basisRow2[2] = mat.mat[2][2];
            // 方向定标探针：同时打印三行基向量——锁定「沿哪个轴发光、符号如何」
            // 正是靠这组观测（与相机矩阵当年 ocean_4/cube_2 的定标手法一致）。
            ltLog("basis-row0", "x y z", mat.mat[0][0], mat.mat[0][1], mat.mat[0][2]);
            ltLog("basis-row1", "x y z", mat.mat[1][0], mat.mat[1][1], mat.mat[1][2]);
            ltLog("basis-row2", "x y z", mat.mat[2][0], mat.mat[2][1], mat.mat[2][2]);
            ltLog("pos-ae", "x y z(down)", rl.posAE[0], rl.posAE[1], rl.posAE[2]);
        }

        readOneD(streamSuite, layerH, AEGP_LayerStream_INTENSITY, &compTime, &rl.intensity);
        readColor(streamSuite, layerH, AEGP_LayerStream_COLOR, &compTime, rl.rgb);
        if (ltype == AEGP_LightType_SPOT) {
            readOneD(streamSuite, layerH, AEGP_LayerStream_CONE_ANGLE, &compTime, &rl.coneAngle);
            readOneD(streamSuite, layerH, AEGP_LayerStream_CONE_FEATHER, &compTime, &rl.coneFeather);
        }
        if (!rl.isAmbient) {
            readOneD(streamSuite, layerH, AEGP_LayerStream_LIGHT_FALLOFF_START, &compTime, &rl.falloffStart);
            readOneD(streamSuite, layerH, AEGP_LayerStream_LIGHT_FALLOFF_DISTANCE, &compTime, &rl.falloffDist);
        }
        ltLog("light-found", "type intensity", shaderType, rl.intensity, (double)collected.size());

        collected.push_back(rl);
        // 收集上限（防御性，非截断规则本身）：留足余量，使「环境光优先保留」这条
        // 规则不会被提前中断——若上限取 2×kMaxLights（16），一盏排在 17 盏之后的
        // 环境光会被漏掉，规则形同虚设。64 盏（约数 KB）远超实际使用，且外层
        // 2000 层扫描上限已给出上界；真正触发即打日志，便于发现。
        if (collected.size() >= 64) {
            ltLog("collect-capped", "collected", (double)collected.size(), 0, 0);
            break;
        }
    }

    if (collected.empty()) {
        // hasLights 保持 0、count 保持 0 → shader 循环空转，行为与「无灯合成」一致
        ltLog("no-lights", "totalLights inactive solo", (double)totalLights, (double)skippedInactive,
              (double)skippedSolo);
        return lu;
    }

    // —— 截断规则（v1）：环境光优先保留，其余按合成顺序取满 ——
    // 动机：若按纯合成顺序截断，可能把环境光切掉 → 画面直接全黑，且现象难以归因。
    // 未超限时**保持合成顺序**输出（可读性与诊断友好）；超限时环境光前置。
    const bool needTruncate = (collected.size() > (size_t)kMaxLights);
    int emitted = 0;
    auto emit = [&](const RawLight& rl) {
        if (emitted >= kMaxLights) return;
        const int i = emitted;
        lu.type[i] = rl.type;

        // 位置/方向归一化：与相机同一空间（相对本图层原点、GL y-up）。
        float pos[3] = {0, 0, 0};
        float dir[3] = {0, 0, 0};
        if (!rl.isAmbient) {
            lightPosRelYUp(rl.posAE, layerOAE, pos);
            lightDirYUp(rl.basisRow2, dir);
        }
        lu.pos[i * 3 + 0] = pos[0];
        lu.pos[i * 3 + 1] = pos[1];
        lu.pos[i * 3 + 2] = pos[2];
        lu.dir[i * 3 + 0] = dir[0];
        lu.dir[i * 3 + 1] = dir[1];
        lu.dir[i * 3 + 2] = dir[2];

        float col[3] = {0, 0, 0};
        lightColorPremul(rl.rgb, rl.intensity, col);
        lu.color[i * 3 + 0] = col[0];
        lu.color[i * 3 + 1] = col[1];
        lu.color[i * 3 + 2] = col[2];

        lu.params[i * 4 + 0] = static_cast<float>(rl.coneAngle);
        lu.params[i * 4 + 1] = static_cast<float>(rl.coneFeather);
        lu.params[i * 4 + 2] = static_cast<float>(rl.falloffStart);
        lu.params[i * 4 + 3] = static_cast<float>(rl.falloffDist);
        ++emitted;
    };

    if (!needTruncate) {
        for (const RawLight& rl : collected) emit(rl);
    } else {
        for (const RawLight& rl : collected) if (rl.isAmbient) emit(rl);
        for (const RawLight& rl : collected) if (!rl.isAmbient) emit(rl);
        ltLog("truncated", "collected emitted", (double)collected.size(), (double)emitted, 0);
    }

    lu.count = static_cast<float>(emitted);
    lu.hasLights = (emitted > 0) ? 1.0f : 0.0f;
    ltLog("query-done", "lights emitted inactive", (double)totalLights, (double)emitted,
          (double)skippedInactive);
    if (skippedSolo) ltLog("skip-solo", "skippedSolo", (double)skippedSolo, 0, 0);
    return lu;
}

} // namespace host
