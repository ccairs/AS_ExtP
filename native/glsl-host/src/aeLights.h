#pragma once
// aeLights.h —— AE 合成灯光感知（纯数据层）
// 渲染回调内一次性查询（queryLightUniforms，声明在 renderer.h——PF_InData
// 为匿名 struct typedef 无法前向声明，SDK 依赖头统一走 renderer.h），
// 结果经 renderFrame 注入为内置 uniform。**宿主侧已归一化为 GL y-up 约定**，
// 与 uCamPos/uWorldMatrix 同一空间，shader 侧可直接把灯光位置与图层世界位置
// 相减求光照方向：
//   uHasLights      (float)  合成中有启用灯光 = 1，否则 = 0
//   uLightCount     (float)  有效灯数（≤ kMaxLights）
//   uLightType[N]   (float)  0=平行光 1=聚光 2=点光 3=环境光
//   uLightPos[N]    (vec3)   灯位置相对本图层原点，GL y-up 世界坐标，单位像素
//                            （与 uCamPos 同约定，可与 uWorldMatrix 直接做减法）
//   uLightDir[N]    (vec3)   灯的朝向单位向量，GL y-up
//   uLightColor[N]  (vec3)   **已预乘强度**（color × intensity），shader 直接用
//   uLightParams[N] (vec4)   (coneAngle, coneFeather, falloffStart, falloffDistance)
// shader 未声明这些 uniform 时被驱动剔除（location = -1），零开销。
//
// —— 数组必须动态下标访问（勿用常量下标）——
// 若 shader 只读 uLightPos[0]，其余元素可能被判 inactive 而不分配连续位置，
// glUniform3fv 从首元素连续写入就越界。标准写法：
//   int n = int(uLightCount + 0.5);
//   for (int i = 0; i < 8; ++i) { if (i >= n) break; ... uLightPos[i] ... }
// 以 uLightCount 为循环上界并动态索引 → 数组整体活跃，位置连续可写。
//
// 本头文件不含 AE SDK 头（LightUniforms/转换函数为纯数据/纯函数，供单测在
// 不依赖 SDK 的 glsl_core 测试目标中直接包含）。
#include "aeCamera.h"   // 复用 flipY3 / camPosRelYUp（AE 世界 → GL y-up 的同一套归一化基元）
#include <cmath>
#include <cstdint>

namespace host {

// 灯光数上限：GLSL 数组必须编译期定长，故为宿主编译期常量，运行期/脚本不可改。
// 8 盏覆盖绝大多数监看与产品镜头；uniform 占用约 8×14 float ≈ 448 字节，可忽略。
constexpr int kMaxLights = 8;

// shader 侧灯型常量（数值与 AEGP_LightType 的 PARALLEL/SPOT/POINT/AMBIENT 一一对应，
// 使宿主侧转换成为恒等映射；AEGP_LightType_NONE = -1 不在本表内，见 lightTypeToShader）
enum LightTypeF : int {
    kLightTypeParallel = 0,
    kLightTypeSpot     = 1,
    kLightTypePoint    = 2,
    kLightTypeAmbient  = 3,
};

// 灯光快照：纯值语义，无 AEGP 句柄生命周期问题，跨线程传递安全
// （与 CameraUniforms 同构——未声明 uniform 的 shader 完全不受影响）
struct LightUniforms {
    float hasLights = 0.0f;                 // uHasLights
    float count     = 0.0f;                 // uLightCount
    float type[kMaxLights];                 // uLightType[N]
    float pos[kMaxLights * 3];              // uLightPos[N]
    float dir[kMaxLights * 3];              // uLightDir[N]
    float color[kMaxLights * 3];            // uLightColor[N]（已预乘强度）
    float params[kMaxLights * 4];           // uLightParams[N]

    // 全零兜底（无灯光 / AEGP 不可用 / 复选框关闭）：count=0 → shader 循环空转，
    // type 全 0 但不会被读到；与「无灯合成」语义一致。
    LightUniforms() {
        for (int i = 0; i < kMaxLights; ++i) type[i] = 0.0f;
        for (int i = 0; i < kMaxLights * 3; ++i) pos[i] = dir[i] = color[i] = 0.0f;
        for (int i = 0; i < kMaxLights * 4; ++i) params[i] = 0.0f;
    }
};

// 纯函数：AEGP_LightType → shader 侧常量。
// AEGP_LightType 取值（AE_GeneralPlug.h:196-207）：NONE=-1 / PARALLEL=0 / SPOT=1 /
// POINT=2 / AMBIENT=3。返回 -1.0f 表示该灯不受支持（NONE 或未知）——调用方应跳过，
// 不要写入槽位（避免占用配额）。
inline float lightTypeToShader(long aegp_light_type) {
    switch (aegp_light_type) {
        case kLightTypeParallel: return static_cast<float>(kLightTypeParallel);
        case kLightTypeSpot:     return static_cast<float>(kLightTypeSpot);
        case kLightTypePoint:    return static_cast<float>(kLightTypePoint);
        case kLightTypeAmbient:  return static_cast<float>(kLightTypeAmbient);
        default:                 return -1.0f;
    }
}

// 纯函数：灯世界位置归一化。lightPosAE / layerOAE 均为 AE 世界坐标（Y 向下，像素），
// 输出 = (lightPos − layerO) 经 Y 翻转 → 相对本图层原点的 y-up 坐标。
// 与 camPosRelYUp 同源语义（同一个减法 + 同一个 flipY3），故直接复用后者，
// 保证灯与相机落在完全同一个空间——shader 侧才能把二者混算。
inline void lightPosRelYUp(const double lightPosAE[3], const double layerOAE[3], float out[3]) {
    camPosRelYUp(lightPosAE, layerOAE, out);
}

// 纯函数：灯朝向归一化。入参 basisRow 为该灯 layer→world 矩阵的**第 2 行**
// （AE 行向量惯例 v*M：行 0/1/2 = 灯的局部 X/Y/Z 轴在 AE 世界坐标中的表示），
// 输出 GL y-up 单位向量。
//
// 行 2 = 灯的**发射方向**（光行进方向，即指向其目标点的方向），
// 与相机行 2 = 视线方向同约定。auto-orient 开（AE 默认）时注入值 = normalize(POI − 灯位置)：
// 灯位 (0,0,-1333)/POI(500,500,0) → 注入 (0.331,-0.332,0.883)；(1400,540,-1333)/(960,540,0)
// → (-0.313,0,0.950)，两例逐位吻合。auto-orient 关时 = 灯自身局部 +Z（Orientation 0 → 注入 (0,0,1)）。
// AEGP 里灯的「目标点」就是其 ADBE Anchor Point。故 shader 侧「指向光源」向量 = −uLightDir
// （契约配方成立）；AE 自身渲染同向（Standard 3D 参照：平行光置板前朝目标点照射 → 朝向观察者的面被照亮）。
inline void lightDirYUp(const double basisRow[3], float out[3]) {
    flipY3(basisRow, out);
    const float len = out[0] * out[0] + out[1] * out[1] + out[2] * out[2];
    if (len > 0.0f) {
        const float inv = 1.0f / sqrtf(len);
        out[0] *= inv; out[1] *= inv; out[2] *= inv;
    }
}

// 纯函数：AE 颜色（AEGP_ColorVal 的 r/g/b，域 [0,1]，AE_GeneralPlug.h:152-154）
// 预乘强度 → shader 侧 uLightColor。宿主侧预乘的理由：强度与颜色在 shader 里
// 总是成对相乘，预乘省一次逐灯乘法，且让「强度=0」天然等于「无贡献」。
// 强度为负/非法时钳到 0（AE 不允许负强度，此处仅作防御）。
// 注：返回值与 AE 自身渲染出的亮度**不可比**（色彩空间/曝光/预乘策略未必一致），
// 只保证灯与灯之间的相对关系正确。
inline void lightColorPremul(const double rgb[3], double intensity, float out[3]) {
    const double k = (intensity > 0.0) ? intensity : 0.0;
    out[0] = static_cast<float>(rgb[0] * k);
    out[1] = static_cast<float>(rgb[1] * k);
    out[2] = static_cast<float>(rgb[2] * k);
}

// 纯函数：灯是否纳入本次注入（镜像 AE 渲染器的可见性规则）。
//
// AE 的 Solo 不反映到 AEGP_LayerFlag_VIDEO_ACTIVE
// （solo 一盏灯后另一盏仍为 active），而 AE 渲染器只渲染被 solo 的图层——不过滤即出现
// 「shader 看到的灯 ≠ AE 画面」。规则：眼睛开关关闭不纳入；合成中任一图层被 solo 时，
// 只有自身被 solo 的灯纳入（被 solo 的是非灯图层 ⇒ 全排除 ⇒ 调用方得 hasLights=0）。
inline bool lightIncluded(bool video_active, bool is_solo, bool comp_has_solo) {
    if (!video_active) return false;
    if (comp_has_solo && !is_solo) return false;
    return true;
}

} // namespace host
