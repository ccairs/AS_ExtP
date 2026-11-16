// aeCamera.cpp —— 渲染期 AEGP 查询（相机/图层 3D 变换 → CameraUniforms）
// 官方依据：Cheating Effect Usage of AEGP Suites（效果可借 PF_InData::pica_basicP
// 调 AEGP 套件读取相机/灯光信息，AEGP_PFInterfaceSuite 是入口）。
// 本文件所有失败路径一律静默返回默认值——相机感知是纯增量能力，任何 AEGP
// 不可用（SmartRender 回调超范围/套件缺席/AE 早期启动阶段）都不能影响渲染。
#include "aeCamera.h"
#include "renderer.h"   // queryCameraUniforms 声明（PF_InData 依赖 AE SDK 头）
#include <windows.h>    // InterlockedDecrement/LONG（camLog 节流，同 rfLog/srLog 手法）
#include "AE_Effect.h"
#include "AE_GeneralPlug.h"
#include "errorLog.h"
#include <cstdio>
#include <string>
#include <cstring>

namespace host {

// AEGP plugin id：惰性注册（首次渲染调用时）。注册失败置位短路标志，
// 避免每帧重复尝试 AcquireSuite/RegisterWithAEGP。
// 进程级状态（未声明 THREADED_RENDERING，渲染回调实际串行；即便并发，
// 两次 RegisterWithAEGP 也只是拿到两个 id，取其一即正确）。
static AEGP_PluginID s_aegpId = 0;
static bool s_aegpRegisterFailed = false;

// 相机诊断日志：与 rfLog 同文件（<数据根>\temp\logs\as_effect_host.log）同款追加互斥。
// 节流：默认仅前 300 条落盘（实测校准矩阵方向语义足够；AS_EFFECT_HOST_LOG=1
// 解除限制），避免播放期每帧 4 次 AEGP 查询的日志刷屏。
static void camLog(const char* stage, const char* label, double v0, double v1, double v2) {
    static const bool s_verbose = std::getenv("AS_EFFECT_HOST_LOG") != nullptr;
    static LONG volatile s_budget = 300;
    if (!s_verbose && InterlockedDecrement(&s_budget) < 0) return;
    const std::string path = host::diagLogFilePath("as_effect_host.log");
    if (path.empty()) return;
    // 体积上限：本函数的写入同样受 as_effect_host.log 的 16MB 轮转约束
    host::maybeRotateDiagLog();
    lockDiagAppend();
    {
        char body[160];
        std::snprintf(body, sizeof(body), "cam-%s [%s] %.6g %.6g %.6g", stage, label, v0, v1, v2);
        host::appendDiagLogLine(body);   // 时间戳由直写函数统一补
    }
    unlockDiagAppend();
}

// 供 aeLights.cpp 复用的注册入口（声明在 renderer.h，理由同 queryCameraUniforms：
// AEGP_PluginID/SPBasicSuite 是 SDK 类型，纯数据头文件不引 SDK）。
// 抽出的动机：灯光查询与相机查询是两条独立链路，若各自调用 AEGP_RegisterWithAEGP
// 会拿到**两个 plugin id**——功能上无害（见上方注释），但两个 id 各自被 AE 记账，
// 且两处短路标志互相看不见，失败时日志会重复、状态不一致。此处单点注册、单点短路。
bool ensureAegpPluginId(SPBasicSuite* pica, AEGP_PluginID* out_id) {
    if (out_id) *out_id = 0;
    if (!pica) return false;
    if (s_aegpId == 0 && !s_aegpRegisterFailed) {
        const void* su = nullptr;
        if (pica->AcquireSuite(kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6, &su) == kSPNoError && su) {
            AEGP_PluginID id = 0;
            const AEGP_UtilitySuite6* utils = reinterpret_cast<const AEGP_UtilitySuite6*>(su);
            if (utils->AEGP_RegisterWithAEGP(nullptr, "AS_Effect_Host_AEGP", &id) == A_Err_NONE && id != 0) {
                s_aegpId = id;
            }
            pica->ReleaseSuite(kAEGPUtilitySuite, kAEGPUtilitySuiteVersion6);
        }
        if (s_aegpId == 0) {
            s_aegpRegisterFailed = true;
            camLog("register-failed", "aegp", 0, 0, 0);
            return false;
        }
        camLog("registered", "aegp", (double)s_aegpId, 0, 0);
    }
    if (s_aegpId == 0) return false;
    if (out_id) *out_id = s_aegpId;
    return true;
}

CameraUniforms queryCameraUniforms(PF_InData* in_data) {
    CameraUniforms cu;
    // 诊断盲区补点：本入口两条静默路径无日志——
    // pica_basicP 为空时直接返回，零日志无法与「未调用」区分。实测中
    // SmartRender 走了 164 帧却零 cam- 条目，本日志即为此定位。
    if (!in_data || !in_data->pica_basicP) {
        camLog("no-pica", "pica_basicP null", 0, 0, 0);
        return cu;
    }
    SPBasicSuite* pica = in_data->pica_basicP;

    // —— 惰性注册 AEGP plugin id（单点注册，aeLights.cpp 共用同一 id 与短路标志）——
    if (!ensureAegpPluginId(pica, nullptr)) return cu;

    // —— PFInterface 套件（相机/图层/合成时间换算的唯一入口）——
    const void* su = nullptr;
    if (pica->AcquireSuite(kAEGPPFInterfaceSuite, kAEGPPFInterfaceSuiteVersion1, &su) != kSPNoError || !su) {
        camLog("pf-suite-miss", "acquire", 0, 0, 0);
        return cu;
    }
    const AEGP_PFInterfaceSuite1* pf = reinterpret_cast<const AEGP_PFInterfaceSuite1*>(su);

    // 图层时间（in_data->current_time/time_scale）→ 合成时间（相机查询入参）
    A_Time compTime = {0, 1};
    if (pf->AEGP_ConvertEffectToCompTime(in_data->effect_ref,
                                          in_data->current_time,
                                          in_data->time_scale,
                                          &compTime) != A_Err_NONE) {
        pica->ReleaseSuite(kAEGPPFInterfaceSuite, kAEGPPFInterfaceSuiteVersion1);
        camLog("comp-time-err", "convert", 0, 0, 0);
        return cu;
    }

    // —— 活动相机（无相机的 2D 合成返回 null layerH，uHasCam 保持 0）——
    AEGP_LayerH camLayer = nullptr;
    A_Err e = pf->AEGP_GetEffectCamera(in_data->effect_ref, &compTime, &camLayer);
    if (e != A_Err_NONE) {
        // SmartRender 等回调不在官方允许列表时的预期失败——静默降级
        pica->ReleaseSuite(kAEGPPFInterfaceSuite, kAEGPPFInterfaceSuiteVersion1);
        camLog("get-camera-err", "aegp", (double)e, 0, 0);
        return cu;
    }
    if (camLayer) cu.hasCam = 1.0f;

    // —— 相机几何矩阵（原始语义见 aeCamera.h 定标注释：行 0/1/2 = 图像右/图像下/视线方向）——
    A_Matrix4 camMat;
    A_FpLong distToPlane = 0;
    A_short planeW = 0, planeH = 0;
    std::memset(&camMat, 0, sizeof(camMat));
    bool hasCamMat = false;
    if (camLayer &&
        pf->AEGP_GetEffectCameraMatrix(in_data->effect_ref, &compTime,
                                       &camMat, &distToPlane, &planeW, &planeH) == A_Err_NONE) {
        hasCamMat = true;
        // 视场系数：相机位移/旋转在画面上的位移量由等效焦距决定，AE 与 shader
        // 不一致的根因即此——手动 uFov 的滑块范围够不到 AE 相机的实际视场。
        cu.camFov = cameraFovFromPlane(distToPlane, static_cast<double>(planeH));
        camLog("cam-fov", "dist planeH fov",
               distToPlane, static_cast<double>(planeH), static_cast<double>(cu.camFov));
        camLog("cam-matrix-row3", "m30 m31 m32",
               camMat.mat[3][0], camMat.mat[3][1], camMat.mat[3][2]);
    }

    // —— LayerSuite：层→世界矩阵（本图层 + 相机层）——
    const void* lsu = nullptr;
    if (pica->AcquireSuite(kAEGPLayerSuite, kAEGPLayerSuiteVersion9, &lsu) == kSPNoError && lsu) {
        const AEGP_LayerSuite9* layerSuite = reinterpret_cast<const AEGP_LayerSuite9*>(lsu);
        // 本图层 layer→world（2D 图层同样有效：z=0 平面）
        AEGP_LayerH layer = nullptr;
        if (pf->AEGP_GetEffectLayer(in_data->effect_ref, &layer) == A_Err_NONE && layer) {
            A_Matrix4 worldMat;
            std::memset(&worldMat, 0, sizeof(worldMat));
            if (layerSuite->AEGP_GetLayerToWorldXform(layer, &compTime, &worldMat) == A_Err_NONE) {
                convertWorldMatrix(worldMat.mat, cu.worldMatrix);
                camLog("world-matrix-row3", "m30 m31 m32",
                       worldMat.mat[3][0], worldMat.mat[3][1], worldMat.mat[3][2]);
            }
        }
        // 相机层 layer→world：平移分量即相机世界位置（AE 世界坐标原值，
        // Y 向下、单位像素）——归一化注入（见 aeCamera.h）：
        //   uCamPos     = 相对图层原点的 y-up 坐标
        //   uCamMatrix  = 列 右/上/前（y-up），列 3 = 相机绝对位置（y-up）
        if (camLayer) {
            A_Matrix4 camWorldMat;
            std::memset(&camWorldMat, 0, sizeof(camWorldMat));
            if (layerSuite->AEGP_GetLayerToWorldXform(camLayer, &compTime, &camWorldMat) == A_Err_NONE) {
                const double camPosAE[3] = { camWorldMat.mat[3][0], camWorldMat.mat[3][1], camWorldMat.mat[3][2] };
                // 图层原点（AE）：由已归一化的 uWorldMatrix 反推原值（纯函数，
                // 与 aeLights 共用同一实现——灯与相机必须落在同一空间）
                double layerOAE[3];
                worldMatrixOriginAE(cu.worldMatrix, layerOAE);
                camPosRelYUp(camPosAE, layerOAE, cu.camPos);
                // 相机矩阵查询失败时保持单位阵兜底（有相机但矩阵不可得，极少见）
                if (hasCamMat) convertCameraMatrix(camMat.mat, camPosAE, cu.camMatrix);
                camLog("cam-pos-row3", "px py pz", camPosAE[0], camPosAE[1], camPosAE[2]);
                camLog("cam-pos-rel", "x y z(up)", cu.camPos[0], cu.camPos[1], cu.camPos[2]);
            }
        }
        pica->ReleaseSuite(kAEGPLayerSuite, kAEGPLayerSuiteVersion9);
    }

    pica->ReleaseSuite(kAEGPPFInterfaceSuite, kAEGPPFInterfaceSuiteVersion1);
    return cu;
}

} // namespace host
