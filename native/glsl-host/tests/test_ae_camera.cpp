// aeCamera 纯逻辑层单测：matrixToColumnMajor 方向语义 + CameraUniforms 默认单位阵。
// aeCamera.h 不依赖 AE SDK，本测试直接进 glsl_core_tests（aeCamera.cpp 的 AEGP
// 查询部分依赖 SDK 头与 AE 运行时，不在单测覆盖范围——实测经 camLog 日志校准）。
// 入口走 test_main.cpp 的 runAeCameraTests（同目录测试统一注册模式，无独立 main）。
#undef NDEBUG
#include <cassert>
#include <cmath>
#include <iostream>
#include "aeCamera.h"

// 行主序转列主序：out[col*4+row] = m[col][row]（数学转置 + 布局转换一步完成）
// ——AE 行向量惯例 v*M 对应 GLSL 列向量 M*v 的方向语义锁定（L2 方向语义
// 实测校准的回归锚点；曾把公式写成 m[row][col]（仅换布局未转置数学矩阵），
// 被 test_translation_lands_in_col3 抓获）
static void test_matrix_to_column_major() {
    // 非对称矩阵：每个元素唯一定位，转置关系逐位验证
    double m[4][4] = {
        { 0,  1,  2,  3},
        {10, 11, 12, 13},
        {20, 21, 22, 23},
        {30, 31, 32, 33},
    };
    float out[16];
    host::matrixToColumnMajor(m, out);
    for (int r = 0; r < 4; ++r)
        for (int c = 0; c < 4; ++c)
            assert(out[c * 4 + r] == static_cast<float>(m[c][r]));
    // 抽查：m[3][0]（行向量平移 x）应落在 GLSL 第 3 列第 0 行（out[12]）
    assert(out[12] == 30.0f);
    std::cout << "PASS test_matrix_to_column_major\n";
}

// 平移矩阵转换：AE 行向量惯例下平移在 row3（m[3][0..2]），
// 转列主序后应位于第 3 列（out[12..14]）——uCamPos 提取路径同源，锁定一致性
static void test_translation_lands_in_col3() {
    double m[4][4] = {
        {1, 0, 0, 0},
        {0, 1, 0, 0},
        {0, 0, 1, 0},
        {100, 200, 300, 1},
    };
    float out[16];
    host::matrixToColumnMajor(m, out);
    assert(out[12] == 100.0f && out[13] == 200.0f && out[14] == 300.0f);
    assert(out[15] == 1.0f);
    std::cout << "PASS test_translation_lands_in_col3\n";
}

// 默认构造：单位阵兜底（无相机/AEGP 不可用时 shader 侧恒可用）
static void test_default_identity() {
    host::CameraUniforms cu;
    assert(cu.hasCam == 0.0f);
    assert(cu.camFov == 1.0f);   // 无相机兜底：1/tan(90°/2) = 1
    assert(cu.camPos[0] == 0 && cu.camPos[1] == 0 && cu.camPos[2] == 0);
    for (int i = 0; i < 4; ++i) {
        assert(cu.camMatrix[i * 4 + i] == 1.0f);
        assert(cu.worldMatrix[i * 4 + i] == 1.0f);
    }
    // 非对角元素全零
    for (int r = 0; r < 4; ++r)
        for (int c = 0; c < 4; ++c)
            if (r != c) {
                assert(cu.camMatrix[c * 4 + r] == 0.0f);
                assert(cu.worldMatrix[c * 4 + r] == 0.0f);
            }
    std::cout << "PASS test_default_identity\n";
}

// —— 宿主侧归一化（契约见 aeCamera.h 注释）——

// 相机矩阵归一化：默认相机（AE 原始行 0/1/2 = 图像右 (1,0,0) / 图像下 (0,1,0) /
// 视线 (0,0,1)）→ 列 右 (1,0,0) / 上 (0,1,0) / 前 (0,0,1)，列 3 = 相机位置 y 翻转。
// 这是定标语义的回归锚点：行 1 是「图像向下」，转换后列 1 必须是「上」。
static void test_convert_camera_matrix_identity() {
    const double ident[4][4] = {
        {1, 0, 0, 0},
        {0, 1, 0, 0},
        {0, 0, 1, 0},
        {0, 0, 0, 1},
    };
    const double camPos[3] = {960.0, 540.0, -722.0};
    float out[16];
    host::convertCameraMatrix(ident, camPos, out);
    // 列 0 = 右 (1,0,0,0)
    assert(out[0] == 1.0f && out[1] == 0.0f && out[2] == 0.0f && out[3] == 0.0f);
    // 列 1 = 上 (0,1,0,0)——原始行 1 是图像向下 (0,1,0)，取负翻 y 后仍是 (0,1,0)
    assert(out[4] == 0.0f && out[5] == 1.0f && out[6] == 0.0f && out[7] == 0.0f);
    // 列 2 = 前 (0,0,1,0)——视线方向 +F 前向（非 GL 相机 -Z）
    assert(out[8] == 0.0f && out[9] == 0.0f && out[10] == 1.0f && out[11] == 0.0f);
    // 列 3 = 相机绝对位置 (960, -540, -722, 1)——y 翻转为 y-up
    assert(out[12] == 960.0f && out[13] == -540.0f && out[14] == -722.0f && out[15] == 1.0f);
    std::cout << "PASS test_convert_camera_matrix_identity\n";
}

// 相机矩阵归一化：俯仰相机锁定「上/前」列的符号细节。
// 原始行（AE 世界，Y 向下）：上抬 θ 的水平相机
//   行 1（图像下）= (0, cosθ, sinθ)   行 2（视线）= (0, -sinθ, cosθ)
// 期望（y-up）：
//   列 1（上）= (0, cosθ, -sinθ)——上抬时「上」向屏幕外（-z）倾
//   列 2（前）= (0, sinθ, cosθ) ——上抬时视线向 +y 抬头
// 俯仰方向回归锚点：旧契约（直传原始值）曾致 ocean_4 俯仰相反（用户实测）。
static void test_convert_camera_matrix_pitch() {
    const float th = 0.5f;
    const double ct = cos(th), st = sin(th);
    const double m[4][4] = {
        {1,  0,  0, 0},
        {0,  ct, st, 0},
        {0, -st, ct, 0},
        {0,  0,  0, 1},
    };
    const double camPos[3] = {0, 0, 0};
    float out[16];
    host::convertCameraMatrix(m, camPos, out);
    // 列 1（上）
    assert(out[4] == 0.0f);
    assert(fabs(out[5] - ct) < 1e-6f);
    assert(fabs(out[6] + st) < 1e-6f);   // -sinθ
    // 列 2（前）
    assert(out[8] == 0.0f);
    assert(fabs(out[9] - st) < 1e-6f);   // +sinθ：上抬相机前向 y 分量为正（y-up）
    assert(fabs(out[10] - ct) < 1e-6f);
    std::cout << "PASS test_convert_camera_matrix_pitch\n";
}

// 相机位置归一化：AE 世界（Y 向下）相对图层原点 → y-up。
// 相机在图层原点上方 100px（AE y = -100）：y-up 中应为 +100（向上为正）——
// 垂直视差回归锚点：旧契约（直传原值）曾致 ocean_4 上下移动相反（用户实测）。
static void test_cam_pos_rel_y_up() {
    const double camPos[3] = {50.0, -100.0, -722.0};
    const double layerO[3] = {10.0, 40.0, 0.0};
    float out[3];
    host::camPosRelYUp(camPos, layerO, out);
    assert(out[0] == 40.0f);    // 50 - 10
    assert(out[1] == 140.0f);   // -(-100 - 40) = +140：相机在图层上方 → y-up 为正
    assert(out[2] == -722.0f);
    std::cout << "PASS test_cam_pos_rel_y_up\n";
}

// 图层矩阵归一化：平移 y 取反（列 3）、基向量共轭（列 0..2 的 y 分量取反、
// 列 1 整列除 [1][1] 外取反）。锚点：uWorldMatrix[3].xyz = 图层原点 y-up 世界位置。
static void test_convert_world_matrix() {
    // 非对称矩阵逐位校验：D[r][c] = s_r·s_c·m[c][r]
    const double m[4][4] = {
        { 0,  1,  2,  3},
        {10, 11, 12, 13},
        {20, 21, 22, 23},
        {30, 31, 32, 33},
    };
    float out[16];
    host::convertWorldMatrix(m, out);
    const float s[4] = {1, -1, 1, 1};
    for (int r = 0; r < 4; ++r)
        for (int c = 0; c < 4; ++c)
            assert(out[c * 4 + r] == s[r] * s[c] * static_cast<float>(m[c][r]));
    // 平移锚点：AE m[3][1]=31 → y-up 列 3 第 1 行 = -31
    assert(out[3 * 4 + 1] == -31.0f);
    std::cout << "PASS test_convert_world_matrix\n";
}

// 端到端一致性：单位原始矩阵 + 默认相机下，标准配方
//   rd = col2*fov + col0*uv.x + col1*uv.y, ro = uCamPos/scale
// 画面顶部（uv.y=+1）光线向 +y（y-up 场景向上）——锁定「不镜像、不颠倒」。
static void test_standard_recipe_upright() {
    const double ident[4][4] = {
        {1, 0, 0, 0},
        {0, 1, 0, 0},
        {0, 0, 1, 0},
        {0, 0, 0, 1},
    };
    const double camPos[3] = {0, 0, -700.0};
    float cm[16], cp[3];
    host::convertCameraMatrix(ident, camPos, cm);
    const double layerO[3] = {0, 0, 0};
    host::camPosRelYUp(camPos, layerO, cp);
    // 场景比例 100：相机在场景 z=-7（图层前方），看向 +z
    assert(fabs(cp[2] / 100.0f + 7.0f) < 1e-6f);
    // 画面顶部光线：fov=1, uv=(0,1) → col2 + col1 = (0,1,1)：y 分量 > 0（向上）
    const float rdTopY = cm[2 * 4 + 1] * 1.0f + cm[1 * 4 + 1] * 1.0f;
    assert(rdTopY > 0.0f);
    // 画面底部（uv.y=-1）→ (0,-1,1)：y < 0（向下看海面类内容）
    const float rdBotY = cm[2 * 4 + 1] * 1.0f - cm[1 * 4 + 1] * 1.0f;
    assert(rdBotY < 0.0f);
    // 视线 +z 前向（场景在相机前方）：col2.z = 1
    assert(cm[2 * 4 + 2] == 1.0f);
    std::cout << "PASS test_standard_recipe_upright\n";
}

// uCamFov 换算：1/tan(垂直半视场) = distToPlane/(planeH/2)。
// 锚点：AE 默认 50mm 相机在 1920x1080 合成上 dist_to_image_plane≈2666.7、
// image_plane_height=1080 → uCamFov≈4.938（垂直视场 22.9°）。非法入参一律 1.0。
static void test_camera_fov_from_plane() {
    const float f = host::cameraFovFromPlane(2666.6667, 1080.0);
    assert(fabs(f - 4.93827f) < 1e-4f);
    // 垂直半视场 = atan(1/uCamFov) = atan(0.2025) ≈ 0.1998 rad（11.45°，即 vFOV 22.9°）
    assert(fabs(atan(1.0f / f) - 0.19980f) < 1e-4f);
    // 非法入参（查询失败/降采样异常）→ 1.0 兜底
    assert(host::cameraFovFromPlane(0.0, 1080.0) == 1.0f);
    assert(host::cameraFovFromPlane(2666.6667, 0.0) == 1.0f);
    assert(host::cameraFovFromPlane(-100.0, 1080.0) == 1.0f);
    std::cout << "PASS test_camera_fov_from_plane\n";
}

void runAeCameraTests() {
    test_matrix_to_column_major();
    test_translation_lands_in_col3();
    test_default_identity();
    test_camera_fov_from_plane();
    test_convert_camera_matrix_identity();
    test_convert_camera_matrix_pitch();
    test_cam_pos_rel_y_up();
    test_convert_world_matrix();
    test_standard_recipe_upright();
}
