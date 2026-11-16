#pragma once
// aeCamera.h —— AE 合成相机/3D 图层变换感知（纯数据层）
// 渲染回调内一次性查询（queryCameraUniforms，声明在 renderer.h——PF_InData
// 为匿名 struct typedef 无法前向声明，SDK 依赖头统一走 renderer.h），
// 结果经 renderFrame 注入为内置 uniform。**宿主侧已归一化为 GL y-up 约定**：
//   uHasCam     (float)  合成有活动相机 = 1，否则 = 0
//   uCamFov     (float)  视场系数 = 1 / tan(垂直半视场) = distToPlane/(image_plane_height/2)，
//                        与 uCamMatrix 配用可让 shader 透视与 AE 相机一致；
//                        无相机 / 像平面参数不可得时 = 1.0（≈90° 垂直视场兜底）
//   uCamPos     (vec3)   相机位置相对本图层原点（= uWorldMatrix[3].xyz），
//                        GL y-up 世界坐标（Y 向上为正），单位像素
//   uCamMatrix  (mat4)   列 [0]/[1]/[2] = 相机基向量（右/上/前；前 = 视线方向），
//                        GL y-up 世界坐标；列 [3].xyz = 相机世界绝对位置（y-up）。
//                        相机空间约定 x 右 / y 上 / z 前，M*vec4(p,1) 直接可用
//   uWorldMatrix(mat4)   本图层 层空间→世界空间（两空间均为 GL y-up 约定），
//                        列 [3].xyz = 图层原点（图层左上角）的世界位置（y-up）
// shader 未声明这些 uniform 时被驱动剔除（location = -1），零开销。
//
// —— 归一化的依据（勿回退为原始直传）——
// AEGP_GetEffectCameraMatrix 原始语义（官方文档未写明，SDK 无示例，由
// ocean_4/cube_2 实测反推锁定）：AE 行向量矩阵，行 0/1/2 = 相机基向量
//   行 0 = 图像向右（image right）   行 1 = 图像向下（image down，非"上"！）
//   行 2 = 视线方向（AE 相机沿自身 +Z 看，与 GL 相机 -Z 前向相反）
// 均以 AE 世界坐标表示（右手系 X 右 / Y 向下 / Z 向屏幕内，原点合成左上角，
// 单位像素）。定标证据链：ocean_4 直用原始值（无翻转）静态画面正立但相机
// Y 移动/俯仰全反（用户实测）；cube_2 按旧契约「y 分量取反」转换产生镜像
// 画面。三组观测与上述语义完全吻合，与其它语义假设均矛盾。
// 「直传原始值 + 让每个 LLM shader 自行换算」已被实证为错误率 100% 的设计
//（U 列是图像向下需整体取反、前向是 +F 而非 -F，两处细节 LLM 必错），
// 故归一化收敛到宿主侧单点实现。
//
// 本头文件不含 AE SDK 头（CameraUniforms/转换函数为纯数据/纯函数，
// 供单测在不依赖 SDK 的 glsl_core 测试目标中直接包含）。
#include <cstdint>

namespace host {

// 相机/3D 变换快照：纯值语义，无 AEGP 句柄生命周期问题，跨线程传递安全
struct CameraUniforms {
    float hasCam = 0.0f;            // uHasCam
    float camFov = 1.0f;            // uCamFov（1/tan(垂直半视场)；兜底 1.0）
    float camPos[3] = {0, 0, 0};    // uCamPos（相对图层原点，y-up）
    float camMatrix[16];            // uCamMatrix（GLSL 列主序，已归一化）
    float worldMatrix[16];          // uWorldMatrix（GLSL 列主序，已归一化）

    // 矩阵默认单位阵（无相机/AEGP 不可用时的兜底，shader 侧恒可用）
    CameraUniforms() {
        for (int i = 0; i < 16; ++i) camMatrix[i] = 0.0f, worldMatrix[i] = 0.0f;
        for (int i = 0; i < 4; ++i) camMatrix[i * 4 + i] = 1.0f, worldMatrix[i * 4 + i] = 1.0f;
    }
};

// 纯函数：AE 相机像平面参数 → uCamFov（= 1/tan(垂直半视场) = distToPlane/(planeH/2)）。
// 两个入参来自 AEGP_GetEffectCameraMatrix 的出参（单位像素）：dist_to_image_plane
// 与 image_plane_height。垂直半视场 = atan((planeH/2)/distToPlane)，取其正切倒数
// 即上式；shader 侧的射线项用「边到边 ±1」坐标（ndc = uv*2.0，uv 为半程 0.5）：
// uCamFov 对应整幅画面边到边的跨度，配半程 0.5 的 uv 会使视场减半。契约 glslApiReference.txt
// 的配方与此同款，面板预览注入同一个量。
// （uFov 手动值做不到：其滑块范围对应的视场远宽于 AE 相机）。
// 参数非法（<=0：查询失败或降采样异常）返回 1.0（≈90° 垂直视场兜底）。
inline float cameraFovFromPlane(double distToPlane, double planeH) {
    if (distToPlane <= 0.0 || planeH <= 0.0) return 1.0f;
    return static_cast<float>(distToPlane / (planeH * 0.5));
}

// 纯函数：A_Matrix4（AE mat[r][c] 行向量惯例，v' = v*M）→ GLSL 列主序 float[16]。
// 数学上需转置（GLSL 列向量 v' = M*v 与 AE 的 v*M 等价 ⇔ GLSL 矩阵 = M^T），
// 转置与布局转换一步完成：out[col*4+row] = m[col][row]。
// 校验锚点：AE 平移在 row3（m[3][0..2]）→ 落 GLSL 第 3 列（out[12..14]）。
// 仅作内部基元；对外注入的矩阵一律经 convertCameraMatrix/convertWorldMatrix
// 归一化（见上），勿直接使用本函数的产物注入 uniform。
inline void matrixToColumnMajor(const double m[4][4], float out[16]) {
    for (int r = 0; r < 4; ++r)
        for (int c = 0; c < 4; ++c)
            out[c * 4 + r] = static_cast<float>(m[c][r]);
}

// AE 世界 → GL y-up 世界的坐标翻转 F = diag(1,-1,1)：
//   位置/方向分量映射 (x,y,z) → (x,-y,z)。y-up 世界：X 右 / Y 向上 / Z 向屏幕内。
inline void flipY3(const double v[3], float out[3]) {
    out[0] = static_cast<float>(v[0]);
    out[1] = static_cast<float>(-v[1]);
    out[2] = static_cast<float>(v[2]);
}

// 相机位置归一化：camPos/layerO 均为 AE 世界坐标（像素），
// 输出 = (camPos - layerO) 经 Y 翻转 → 相对图层原点的 y-up 场景锚定坐标。
inline void camPosRelYUp(const double camPos[3], const double layerO[3], float out[3]) {
    const double rel[3] = { camPos[0] - layerO[0], camPos[1] - layerO[1], camPos[2] - layerO[2] };
    flipY3(rel, out);
}

// 相机矩阵归一化：AE 原始相机矩阵（行 0/1/2 = 图像右/图像下/视线方向，AE 世界
// 坐标）→ GLSL 列主序 y-up 矩阵：
//   列 0 = F·行0                       （右）
//   列 1 = F·(−行1) = (−m10, m11, −m12)（上 = 图像向上；行 1 是图像向下，须整体取反）
//   列 2 = F·行2                       （前 = 视线方向，+F 前向而非 GL 相机的 −Z）
//   列 3 = F·camPos                    （相机世界绝对位置，y-up）
// shader 标准配方：rd = normalize(uCamMatrix[2].xyz*fov + uCamMatrix[0].xyz*ndc.x + uCamMatrix[1].xyz*ndc.y)
//   （ndc = uv * 2.0，uv 为半程 0.5 的中心归一化坐标——见 cameraFovFromPlane 上方说明）
inline void convertCameraMatrix(const double m[4][4], const double camPos[3], float out[16]) {
    for (int i = 0; i < 16; ++i) out[i] = 0.0f;
    // 列 0：右（y 翻转）
    out[0 * 4 + 0] = static_cast<float>(m[0][0]);
    out[0 * 4 + 1] = static_cast<float>(-m[0][1]);
    out[0 * 4 + 2] = static_cast<float>(m[0][2]);
    // 列 1：上 = −flipY(图像向下) = (−x, +y, −z)
    out[1 * 4 + 0] = static_cast<float>(-m[1][0]);
    out[1 * 4 + 1] = static_cast<float>(m[1][1]);
    out[1 * 4 + 2] = static_cast<float>(-m[1][2]);
    // 列 2：前 = 视线方向（y 翻转）
    out[2 * 4 + 0] = static_cast<float>(m[2][0]);
    out[2 * 4 + 1] = static_cast<float>(-m[2][1]);
    out[2 * 4 + 2] = static_cast<float>(m[2][2]);
    // 列 3：相机世界位置（y 翻转）
    flipY3(camPos, out + 3 * 4);
    out[3 * 4 + 3] = 1.0f;
}

// 图层矩阵归一化：AE 层→世界（层空间与世界空间均为 AE y-down）→ 两空间均
// y-up 的等价变换 D = F·C·F（F = diag(1,-1,1,1)，C = 行向量矩阵的列主序转置）。
// 元素级：D[r][c] = s_r·s_c·C[r][c]，s = (1,-1,1,1)——行列号恰一方为 1 时取负。
// 平移（列 3）y 分量取反 → uWorldMatrix[3].xyz = 图层原点的 y-up 世界位置；
// 基向量（列 0..2）y 分量取反 → 层内 y-up 方向映射到世界 y-up 方向。
inline void convertWorldMatrix(const double m[4][4], float out[16]) {
    for (int r = 0; r < 4; ++r) {
        const float sr = (r == 1) ? -1.0f : 1.0f;
        for (int c = 0; c < 4; ++c) {
            const float sc = (c == 1) ? -1.0f : 1.0f;
            out[c * 4 + r] = sr * sc * static_cast<float>(m[c][r]);
        }
    }
}

// 纯函数：从已归一化的 uWorldMatrix（GLSL 列主序、y-up）反推本图层原点在
// **AE 世界坐标**下的原值（Y 向下、单位像素），供「世界量相对图层原点」的减法使用。
// 即 convertWorldMatrix 对平移列 y 取反的逆运算：AE_y = −(y-up_y)。
// 提取为独立函数的原因：相机位置（aeCamera.cpp）与灯光位置（aeLights.cpp）都要
// 这个原点，两处必须是同一次换算的同一结果——否则灯与相机落在不同空间，
// shader 侧把 uLightPos 与 uCamPos/uWorldMatrix 混算会得到错的相对向量。
inline void worldMatrixOriginAE(const float worldMatrix[16], double out[3]) {
    out[0] = static_cast<double>(worldMatrix[3 * 4 + 0]);
    out[1] = -static_cast<double>(worldMatrix[3 * 4 + 1]);
    out[2] = static_cast<double>(worldMatrix[3 * 4 + 2]);
}

} // namespace host
