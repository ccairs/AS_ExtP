// ── 示例：Gray-Scott 反应扩散（帧内迭代 demo）──
// 用途：演示「帧内多趟迭代」契约。状态存在纹理的 RG 通道：R = 底物 A、G = 活化子 B。
// 第 0 趟用输入画面播种（亮部密、暗部留黑），其后每趟读上一趟做一步反应扩散，
// 主趟取末趟结果上色。全部趟数在同一帧内跑完，效果是 time 的纯函数：跳帧、倒放、
// 区间渲染结果一致，也不依赖渲染调用顺序。
//
// 播种：对输入画面做两级模糊得到低频亮度，亮度决定种斑密度与尺度（亮部成片、
// 暗部留黑）；哈希噪声给出有机种斑形状。迭代把种斑边缘推成发光纹路。
// 上色：多尺度 B 平均把被纹路围合的区域填成暗青体积，脊线冷白高光，暗部近黑。
//
// 调参：uFeed/uKill 决定形态（默认 0.030/0.057 密珊瑚纹；0.055/0.062 稀疏斑块；
// 0.039/0.058 迷宫纹）。uSpeed 是每步推进量，显式欧拉稳定上限 1.25。
// uScale 是种斑与胞状结构的特征尺度（像素），uSeed 是播种阈值偏置（越大亮部覆盖越多）；
// uColorB 是脊线基色。
// 受单帧趟数限制，本示例呈现的是纹样的起始期；要长满画面的完整 Coral 纹，
// 用结算器路线的 example_solver_reaction.glsl（同一算法的跨帧版）。

// @iterations 64
uniform float uFeed  = 0.030;   // @range 0.010 0.090
uniform float uKill  = 0.057;   // @range 0.040 0.070
uniform float uSpeed = 1.15;    // @range 0.2 1.25
uniform vec3  uColorB = vec3(0.25, 0.85, 1.0);   // @range 0.0 1.0
uniform float uScale = 46.0;    // @range 12.0 96.0
uniform float uSeed  = 0.50;    // @range 0.0 1.0

// 确定性哈希：只依赖坐标，不用 time 播种
float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// 二维值噪声：用于种斑边界与区域分布
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 两级模糊的亮度：既取画面大结构，又保留块面差异
float softLuma(vec2 fragCoord, vec2 px) {
    float near = 0.0, far = 0.0;
    for (int i = 0; i < 8; ++i) {
        float a = float(i) * 0.7854;
        vec2 dir = vec2(cos(a), sin(a));
        near += dot(texture(iChannel0, fragCoord + dir * px * 16.0).rgb, vec3(0.299, 0.587, 0.114));
        far  += dot(texture(iChannel0, fragCoord + dir * px * 56.0).rgb, vec3(0.299, 0.587, 0.114));
    }
    return near * 0.35 / 8.0 + far * 0.65 / 8.0;
}

// 分区密度 0..1：亮部接近 1，暗部接近 0，边界用噪声打碎成有机形状
float zoneDensity(vec2 p, float lum) {
    float macro = vnoise(p / (uScale * 4.0) + 5.0);
    return smoothstep(0.50, 0.74, lum + (macro - 0.5) * 0.26 + (uSeed - 0.5) * 0.40);
}

vec4 iterateImage(vec2 fragCoord, float time) {
    vec2 px = 1.0 / uResolution;

    if (uIter < 0.5) {
        // —— 第 0 趟：按输入画面播种 ——
        vec2 p = fragCoord * uResolution;
        float lum = softLuma(fragCoord, px);
        float density = zoneDensity(p, lum);

        // 主体：亮部的有机团块（大尺度、可辨认），暗部留黑
        float bigN = vnoise(p / (uScale * 2.2)) * 0.72
                   + vnoise(p / (uScale * 1.1) + 31.7) * 0.28;
        float mass = smoothstep(0.44, 0.56, bigN) * smoothstep(0.04, 0.24, density);
        // 团块内的次级结构：中等尺度种斑，让主体内部不是空壳
        float midN = vnoise(p / (uScale * 0.62) + 77.1) * 0.78
                   + vnoise(p / (uScale * 0.31) + 15.3) * 0.22;
        float detail = smoothstep(0.52, 0.62, midN) * smoothstep(0.28, 0.62, density) * 0.85;
        float b = clamp(mass + detail, 0.0, 1.0);

        return vec4(1.0 - 0.15 * b, b, 0.0, 1.0);
    }

    // —— 后续趟：一步 Gray-Scott 反应扩散 ——
    // 9 点拉普拉斯（正交 0.2 / 对角 0.05 / 中心 -1，权重和为 0）
    float la = 0.0, lb = 0.0;
    for (int y = -1; y <= 1; ++y) {
        for (int x = -1; x <= 1; ++x) {
            vec4 t = texture(iPrev, fragCoord + vec2(float(x), float(y)) * px);
            float w = (x == 0 && y == 0) ? -1.0
                    : ((x == 0 || y == 0) ? 0.2 : 0.05);
            la += t.r * w;
            lb += t.g * w;
        }
    }
    vec4 s = texture(iPrev, fragCoord);
    float r = s.r * s.g * s.g;                 // 反应项
    float na = s.r + (1.0 * la - r + uFeed * (1.0 - s.r)) * uSpeed;
    float nb = s.g + (0.5 * lb + r - (uKill + uFeed) * s.g) * uSpeed;
    // 钳制是数值稳定性的必需项：越界会被下一趟放大（整片糊成噪声）
    return vec4(clamp(na, 0.0, 1.0), clamp(nb, 0.0, 1.0), 0.0, 1.0);
}

vec4 mainImage(vec2 fragCoord, float time) {
    // 末趟结果在 iPrev 的 G 通道
    float b = texture(iPrev, fragCoord).g;
    vec2 px = 1.0 / uResolution;
    vec2 p = fragCoord * uResolution;

    // 邻近平均：抹平孤立小种点留下的亮点，只让连成片的纹路进入主体着色
    float bSoft = b;
    bSoft += texture(iPrev, fragCoord + vec2(px.x * 2.0, 0.0)).g;
    bSoft += texture(iPrev, fragCoord - vec2(px.x * 2.0, 0.0)).g;
    bSoft += texture(iPrev, fragCoord + vec2(0.0, px.y * 2.0)).g;
    bSoft += texture(iPrev, fragCoord - vec2(0.0, px.y * 2.0)).g;
    bSoft = bSoft * 0.2;

    // 边缘 = B 的梯度（纹路脊线）；12/44/96 纹素三个半径的平均 = 纹路周围的柔光与体积感
    float gx = texture(iPrev, fragCoord + vec2(px.x, 0.0)).g
             - texture(iPrev, fragCoord - vec2(px.x, 0.0)).g;
    float gy = texture(iPrev, fragCoord + vec2(0.0, px.y)).g
             - texture(iPrev, fragCoord - vec2(0.0, px.y)).g;
    float edge = length(vec2(gx, gy));

    float haloN = 0.0, haloW = 0.0, haloX = 0.0;
    for (int i = 0; i < 8; ++i) {
        float a = float(i) * 0.7854;
        vec2 dir = vec2(cos(a), sin(a));
        haloN += texture(iPrev, fragCoord + dir * px * 12.0).g;
        haloW += texture(iPrev, fragCoord + dir * px * 44.0).g;
        haloX += texture(iPrev, fragCoord + dir * px * 96.0).g;
    }
    haloN = haloN / 8.0;
    haloW = haloW / 8.0;
    haloX = haloX / 8.0;

    vec3 base = texture(iChannel0, fragCoord).rgb;
    float lum = dot(base, vec3(0.299, 0.587, 0.114));
    float zone = zoneDensity(p, softLuma(fragCoord, px));

    // 负空间：近黑，只透出一丝底图冷调
    vec3 col = vec3(0.004, 0.007, 0.013);
    col += base * 0.022 * (0.35 + 0.65 * zone);

    // 组织体积：多尺度 B 平均判断「被纹路围合的区域」，填成暗而有色的体积
    float reach = haloX * 1.10 + haloW * 0.70 + haloN * 0.50;
    float vol = smoothstep(0.004, 0.060, reach);
    // 主体包围区：远处负空间的 reach 为 0，体积雾不会整体抬亮画面
    float subject = smoothstep(0.006, 0.060, reach);
    float body = smoothstep(0.015, 0.16, bSoft);
    float mass = clamp(vol * 1.00 + body * 0.25, 0.0, 1.0) * subject;

    // 伪法线：B 的梯度给体积一点方向性明暗，读作凹凸组织而不是线稿
    float lit = clamp(0.55 + gx * 2.2 + gy * 2.2, 0.0, 1.2);

    vec3 tissue = mix(vec3(0.017, 0.060, 0.112), vec3(0.048, 0.170, 0.240),
                      smoothstep(0.02, 0.30, haloN + bSoft * 0.50));
    tissue *= 0.55 + 0.75 * lit;
    tissue = mix(tissue, mix(vec3(0.050, 0.260, 0.360), uColorB * 0.65, zone * 0.60),
                 smoothstep(0.40, 0.95, bSoft) * 0.55);
    col = mix(col, tissue, mass * (0.55 + 0.45 * zone));
    // 脊线：冷白细亮线；浓度最高的脊线只点一点暖金/洋红
    vec3 ridge = mix(uColorB, vec3(0.90, 0.97, 1.0), 0.55);
    col += ridge * smoothstep(0.02, 0.16, edge) * 1.20;
    col += uColorB * smoothstep(0.10, 0.30, edge) * 0.40;
    float hot = smoothstep(0.62, 0.90, bSoft) * smoothstep(0.12, 0.26, edge);
    col += vec3(1.0, 0.78, 0.42) * hot * 0.18;                 // 少量暖金
    col += vec3(1.0, 0.30, 0.62) * pow(hot, 3.0) * 0.10;       // 更浓处一点洋红

    // 暗角与极轻颗粒（压住暗部色带）
    vec2 q = fragCoord - 0.5;
    col *= 1.0 - 0.75 * dot(q, q);
    col += (hash21(fragCoord * uResolution) - 0.5) * 0.010;
    return vec4(col, 1.0);
}
