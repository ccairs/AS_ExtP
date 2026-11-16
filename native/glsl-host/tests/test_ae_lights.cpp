// aeLights 纯逻辑层单测：灯型映射 + 位置/方向/颜色归一化 + 默认全零 + 原点反推。
// aeLights.h 不依赖 AE SDK，本测试直接进 glsl_core_tests（aeLights.cpp 的 AEGP
// 查询部分依赖 SDK 头与 AE 运行时，不在单测覆盖范围——实测经 ltLog 日志定标）。
// 入口走 test_main.cpp 的 runAeLightsTests（同目录测试统一注册模式，无独立 main）。
#undef NDEBUG
#include <cassert>
#include <cmath>
#include <iostream>
#include "aeLights.h"

// 灯型映射：与 AEGP_LightType 数值一一对应（PARALLEL=0/SPOT=1/POINT=2/AMBIENT=3），
// NONE(-1) 与未知值返回 -1（调用方据此跳过，不占配额）。
// 锚点：SDK 若调整枚举顺序，本测试与 lightTypeToShader 一起暴露——灯型错位会
// 让 shader 用错光照模型（点光当平行光算），是静默的视觉错误。
static void test_light_type_mapping() {
    assert(host::lightTypeToShader(0) == host::kLightTypeParallel);
    assert(host::lightTypeToShader(1) == host::kLightTypeSpot);
    assert(host::lightTypeToShader(2) == host::kLightTypePoint);
    assert(host::lightTypeToShader(3) == host::kLightTypeAmbient);
    // NONE = -1（AEGP_LightType_NONE）与任意越界值 → -1.0f：调用方跳过该灯
    assert(host::lightTypeToShader(-1) == -1.0f);
    assert(host::lightTypeToShader(4) == -1.0f);
    assert(host::lightTypeToShader(999) == -1.0f);
    std::cout << "PASS test_light_type_mapping\n";
}

// 灯位置归一化：AE 世界（Y 向下）相对图层原点 → y-up。
// 灯在图层原点上方 100px（AE y = -100）→ y-up 中应为 +100（向上为正）。
// 与 camPosRelYUp 同源：灯与相机必须落在完全同一个空间，否则 shader 侧把
// uLightPos 与 uWorldMatrix/uCamPos 混算会得到错的相对向量。
static void test_light_pos_rel_y_up() {
    const double lightPos[3] = {50.0, -100.0, -722.0};
    const double layerO[3] = {10.0, 40.0, 0.0};
    float out[3];
    host::lightPosRelYUp(lightPos, layerO, out);
    assert(out[0] == 40.0f);    // 50 - 10
    assert(out[1] == 140.0f);   // -(-100 - 40) = +140
    assert(out[2] == -722.0f);
    // 与相机同源的一致性锚点：同一组入参下两个函数必须给出逐位相同的输出
    float camOut[3];
    host::camPosRelYUp(lightPos, layerO, camOut);
    assert(out[0] == camOut[0] && out[1] == camOut[1] && out[2] == camOut[2]);
    std::cout << "PASS test_light_pos_rel_y_up\n";
}

// 方向归一化：layer→world 第 2 行（灯的局部 Z 轴在 AE 世界中的表示）→ y-up 单位向量。
// Y 分量取反 + 归一化。注意：**轴与符号本身尚未定标**（见 aeLights.h 的未定标警告），
// 本测试只锁定「Y 翻转 + 归一化」这两条已确定的变换，不锁定轴的选择。
static void test_light_dir_y_up() {
    float out[3];
    // 单位 +Z：y 分量为 0，翻转后不变
    const double z[3] = {0.0, 0.0, 1.0};
    host::lightDirYUp(z, out);
    assert(out[0] == 0.0f && out[1] == 0.0f && out[2] == 1.0f);
    // +Y（AE 向下）→ y-up 中为 (0,-1,0)
    const double y[3] = {0.0, 1.0, 0.0};
    host::lightDirYUp(y, out);
    assert(out[0] == 0.0f && out[1] == -1.0f && out[2] == 0.0f);
    // 非单位长度必须归一化：(3,4,0) → (3,-4,0) → 长度 5 → (0.6,-0.8,0)
    const double un[3] = {3.0, 4.0, 0.0};
    host::lightDirYUp(un, out);
    assert(fabs(out[0] - 0.6f) < 1e-6f);
    assert(fabs(out[1] + 0.8f) < 1e-6f);
    assert(fabs(out[2]) < 1e-6f);
    // 零向量不除零（矩阵未取到时保持全零，shader 侧得到零方向但不产生 NaN）
    const double zero[3] = {0.0, 0.0, 0.0};
    host::lightDirYUp(zero, out);
    assert(out[0] == 0.0f && out[1] == 0.0f && out[2] == 0.0f);
    std::cout << "PASS test_light_dir_y_up\n";
}

// 颜色预乘强度：宿主侧预乘（shader 侧直接用），强度为负/非法钳到 0。
static void test_light_color_premul() {
    const double rgb[3] = {0.2, 0.4, 0.6};
    float out[3];
    host::lightColorPremul(rgb, 2.0, out);
    assert(fabs(out[0] - 0.4f) < 1e-6f);
    assert(fabs(out[1] - 0.8f) < 1e-6f);
    assert(fabs(out[2] - 1.2f) < 1e-6f);
    // 强度 0（或负值防御）→ 全零：等价于"该灯无贡献"，与 shader 侧求和语义一致
    host::lightColorPremul(rgb, 0.0, out);
    assert(out[0] == 0.0f && out[1] == 0.0f && out[2] == 0.0f);
    host::lightColorPremul(rgb, -5.0, out);
    assert(out[0] == 0.0f && out[1] == 0.0f && out[2] == 0.0f);
    std::cout << "PASS test_light_color_premul\n";
}

// 默认构造：全零兜底（无灯光/AEGP 不可用/复选框关闭）——count=0 使 shader 的
// `if (i >= n) break;` 循环空转，任何数组元素都不会被读到，故数组零值只是防御。
static void test_default_all_zero() {
    host::LightUniforms lu;
    assert(lu.hasLights == 0.0f);
    assert(lu.count == 0.0f);
    for (int i = 0; i < host::kMaxLights; ++i) assert(lu.type[i] == 0.0f);
    for (int i = 0; i < host::kMaxLights * 3; ++i) {
        assert(lu.pos[i] == 0.0f);
        assert(lu.dir[i] == 0.0f);
        assert(lu.color[i] == 0.0f);
    }
    for (int i = 0; i < host::kMaxLights * 4; ++i) assert(lu.params[i] == 0.0f);
    std::cout << "PASS test_default_all_zero\n";
}

// 图层原点反推：worldMatrixOriginAE 是 convertWorldMatrix 对平移列取反的逆运算。
// 往返一致性锚点——aeCamera.cpp 的相机位置与 aeLights.cpp 的灯位置都依赖本函数，
// 两处必须是同一次换算的同一结果（否则灯与相机落在不同空间）。
static void test_world_origin_roundtrip() {
    const double m[4][4] = {
        {1, 0, 0, 0},
        {0, 1, 0, 0},
        {0, 0, 1, 0},
        {30, 31, 32, 1},   // AE 行向量惯例：平移在 row3
    };
    float wm[16];
    host::convertWorldMatrix(m, wm);
    // convertWorldMatrix：平移列 y 取反 → uWorldMatrix[3] = (30, -31, 32, 1)
    assert(wm[12] == 30.0f && wm[13] == -31.0f && wm[14] == 32.0f);
    double origin[3];
    host::worldMatrixOriginAE(wm, origin);
    // 反推应逐位回到 AE 原值
    assert(origin[0] == 30.0); assert(origin[1] == 31.0); assert(origin[2] == 32.0);
    std::cout << "PASS test_world_origin_roundtrip\n";
}

// 可见性纳入规则（Solo）：
//   · 眼睛开关优先：关掉的灯永不纳入；
//   · 合成中有任一图层被 solo → 只有自身被 solo 的灯纳入（AE 渲染器只渲染被 solo 的层）；
//   · 两者都不拦 → 纳入。
// 这条规则是「solo 期间 shader 看到的灯 = AE 画面里的灯」的唯一口径；
// 回退（去掉 comp_has_solo 分支）会让被 solo 排除的灯继续参与照明——真机已复现该不一致。
static void test_light_included_solo_rule() {
    // 无 solo：只受眼睛开关约束
    assert(host::lightIncluded(true, false, false) == true);
    assert(host::lightIncluded(false, false, false) == false);
    assert(host::lightIncluded(true, true, false) == true);   // 只 solo 一盏灯时其自身仍纳入
    // 有 solo（别的图层被 solo）：未被 solo 的灯全部排除
    assert(host::lightIncluded(true, false, true) == false);
    assert(host::lightIncluded(false, false, true) == false);
    // 有 solo：被 solo 的灯纳入
    assert(host::lightIncluded(true, true, true) == true);
    // 眼睛开关关 + 自身 solo + 有 solo → 仍排除（眼睛开关是硬闸）
    assert(host::lightIncluded(false, true, true) == false);
    std::cout << "PASS test_light_included_solo_rule\n";
}

void runAeLightsTests() {
    test_light_type_mapping();
    test_light_pos_rel_y_up();
    test_light_dir_y_up();
    test_light_color_premul();
    test_default_all_zero();
    test_world_origin_roundtrip();
    test_light_included_solo_rule();
}
