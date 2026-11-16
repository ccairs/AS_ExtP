// ── 示例：极光夜空（纯生成类）──
// 用途：全片幅由时间与参数算出，不依赖任何输入图层，可当背景板、转场底、遮罩源。
//
// 画面分层（由远及近）：夜空渐变 → 银河星尘 → 星点 → 远景帘幕 → 主帘幕 → 三层山脊剪影 → 暗角。
// 帘幕 = 起伏下缘曲线（低频褶皱处提亮）+ 每列不同长度的向上弥散 + 垂直射线
//        + 疏密包络（沿 x 留出缺口，形成主次）。
//
// 参数：uSpeed 流动速度；uScale 帘幕疏密；uDetail 射线层数；
//       uColorLo 帘幕顶部冷色；uColorHi 帘幕底缘亮色；uGlow 极光与地平线辉光；uStars 星点密度。

uniform float uSpeed  = 0.35;                      // @range 0.0 2.0
uniform float uScale  = 2.6;                       // @range 0.5 8.0
uniform float uDetail = 3.0;                       // @range 1.0 6.0
uniform vec3  uColorLo = vec3(0.16, 0.19, 0.72);   // @range 0.0 1.0
uniform vec3  uColorHi = vec3(0.32, 1.00, 0.58);   // @range 0.0 1.0
uniform float uGlow    = 0.65;                     // @range 0.0 2.0
uniform float uStars   = 0.65;                     // @range 0.0 1.5

// 二维哈希，返回 0..1。噪声与星点都由它派生，保证同一帧确定、随时间平滑变化。
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// 双线性插值的值噪声，0..1。
float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 分形叠加噪声，octaves 为层数（上限 6，用 float 以便由参数控制）。
float fbm(vec2 p, float octaves) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 6; i++) {
        if (float(i) >= octaves) break;
        v += amp * vnoise(p);
        p = p * 2.02 + vec2(13.7, 7.3);
        amp *= 0.5;
    }
    return v;
}

// 单层星点：每个网格单元最多一颗，位置/亮度/闪烁由单元哈希决定。
float starLayer(vec2 p, float cells, float thresh, float sizeScale, float t) {
    vec2 sp = p * cells;
    vec2 gi = floor(sp);
    vec2 gf = fract(sp) - 0.5;
    float h = hash12(gi);
    if (h > thresh) return 0.0;
    vec2 o = vec2(hash12(gi + 11.3), hash12(gi + 27.7)) - 0.5;
    float b = 0.30 + 0.70 * hash12(gi + 5.9);
    float d = length(gf - o * 0.72);
    float r = (0.010 + 0.045 * b) * sizeScale;
    float tw = 0.70 + 0.30 * sin(t * 1.6 + h * 57.0);
    return (1.0 - smoothstep(0.0, r, d)) * b * tw;
}

// 帘幕下缘曲线（相对基准的高度）：大尺度 S 形褶皱 + 少量高频抖动。
float curtainEdge(float x, float t, float seed) {
    return 0.078 * sin(x * 1.15 + t * 0.42 + seed * 0.7)
         + 0.045 * sin(x * 2.35 - t * 0.28 + 1.3)
         + 0.110 * (fbm(vec2(x * 1.15, seed * 3.0 + t * 0.08), 2.0) - 0.5)
         + 0.026 * (fbm(vec2(x * 4.2 + seed * 2.0, seed + t * 0.12), 2.0) - 0.5);
}

// 极光帘幕：返回 vec2(亮度, 帘幕内归一化高度)，高度 0 在下缘、1 在顶部。
vec2 curtain(vec2 p, float t, float seed, float band, float tall) {
    float x = p.x * uScale + seed;

    // 大尺度褶皱的斜率 → 褶皱侧向处视线更厚，提亮
    float slope = abs(curtainEdge(x + 0.18, t, seed) - curtainEdge(x - 0.18, t, seed)) / 0.36;
    float fold = 1.0 + 4.2 * smoothstep(0.08, 0.50, slope);

    // 射线场：先算，下缘的参差与垂帘长度都要用它
    float px = x * 30.0 + t * 0.55 + p.y * 2.5;
    float fine = fbm(vec2(px, seed * 5.0 - t * 0.14), max(1.0, uDetail - 1.0));
    float ray = pow(clamp(fine * 1.6, 0.0, 1.0), 1.8);
    float bunch = pow(vnoise(vec2(x * 3.2 - t * 0.16, seed * 2.0 + 3.0)), 1.6);
    float alongY = 0.55 + 0.90 * vnoise(vec2(x * 3.0 + seed, p.y * 7.0 - t * 0.22));
    float rays = ray * (0.25 + 1.5 * bunch) * alongY;

    // 下缘：低频起伏 + 高频参差；亮射线处垂得更低（悬挂的光帘）
    float rag = 0.026 * (vnoise(vec2(x * 34.0, seed + 4.0)) - 0.5);
    float d = p.y - (band + curtainEdge(x, t, seed) + rag);
    float rayLen = 0.09 + 0.30 * pow(vnoise(vec2(x * 2.6 + seed, seed * 2.0 + t * 0.05)), 1.3);
    float sheet = smoothstep(-0.020 - 0.085 * ray, 0.004, d) * exp(-max(d, 0.0) / (rayLen * tall));
    float topFade = 1.0 - 0.65 * smoothstep(0.26, 0.60, d);   // 顶端收一点，拉开天空层次

    // 疏密包络：沿 x 留出缺口 + 构图偏置，让帘幕有主次
    float env = 0.10 + 1.28 * smoothstep(0.30, 0.72,
                fbm(vec2(x * 0.50 + seed * 4.0, seed + t * 0.015), 2.0));
    float focus = 0.45 + 1.10 * exp(-(p.x - 0.30) * (p.x - 0.30) / 0.3025);
    float sheetI = sheet * (0.10 + 1.55 * rays);
    // 下缘亮线：极光最有辨识度的一笔
    float hem = exp(-max(d, 0.0) * 26.0) * smoothstep(-0.030, 0.0, d);
    float i = (sheetI * env * focus + hem * env * focus * 0.70) * fold * topFade;
    return vec2(i, clamp(d / 0.78, 0.0, 1.0));
}

// 山脊噪声：1-|2n-1| 把噪声折成尖峰，叠 3 层得到锯齿状山脊线，返回约 0..0.96。
float ridgeNoise(float x, float seed) {
    float v = 0.0;
    float amp = 0.55;
    float f = 1.0;
    for (int i = 0; i < 3; i++) {
        float n = vnoise(vec2(x * f + seed * 5.0, seed * 2.0 + 0.5));
        v += amp * (1.0 - abs(2.0 * n - 1.0));
        amp *= 0.5;
        f *= 2.3;
    }
    return v;
}

vec4 mainImage(vec2 uv, float time) {
    vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);   // 等比坐标，避免非方形画幅下形状变形
    float t = time * uSpeed;
    float horizon = -0.30;

    // 1) 夜空渐变：地平线偏青灰，天顶深靛蓝
    float sky = clamp((p.y - horizon) / (0.60 - horizon), 0.0, 1.0);
    vec3 col = mix(vec3(0.055, 0.095, 0.170), vec3(0.010, 0.016, 0.052), pow(sky, 0.75));

    // 2) 银河：斜向的低对比星尘带，只当背景纹理，不抢主体
    float dust = fbm(vec2(p.x * 2.4 + 3.0, p.y * 6.0 + 1.0), 4.0);
    float bandY = (p.y - 0.20 - 0.30 * p.x) / 0.30;
    float band = exp(-bandY * bandY);
    col += vec3(0.10, 0.12, 0.20) * dust * band * 0.60;

    // 3) 星点：多而暗的一层 + 少而亮的一层，靠近地平线被大气吃掉
    float vis = smoothstep(horizon - 0.01, horizon + 0.16, p.y);
    col += vec3(0.80, 0.88, 1.00) * starLayer(p, 150.0, uStars * 0.075, 0.70, t) * vis;
    col += vec3(1.00, 0.94, 0.86) * starLayer(p + vec2(31.0, 7.0), 52.0, uStars * 0.16, 1.70, t * 0.8) * vis;

    // 4) 极光：远景帘幕（蓝紫、慢、弥散）垫在主帘幕（绿、亮、有褶皱）之后
    vec2 farC = curtain(p + vec2(2.3, 0.02), t * 0.55, 9.0, 0.075, 1.35);
    vec2 mainC = curtain(p, t, 0.0, 0.015, 1.0);
    vec3 farCol = mix(uColorLo, vec3(0.34, 0.52, 1.00), 0.35);
    float farI = farC.x * 0.85 * smoothstep(0.0, 0.35, farC.y);
    col += farCol * farI;
    vec3 mainCol = mix(uColorHi, uColorLo, smoothstep(0.04, 0.70, mainC.y));
    col += mainCol * mainC.x * 1.35;
    // 下缘亮线偏白：极光最有辨识度的一笔
    col += mix(uColorHi, vec3(1.0, 1.0, 0.94), 0.45) *
           clamp(mainC.x, 0.0, 2.0) * (1.0 - smoothstep(0.0, 0.06, mainC.y)) * 0.55;

    // 5) 极光在大气里的辉光：沿地平线的柔光带
    float hazeY = (p.y - horizon) / 0.14;
    float haze = exp(-hazeY * hazeY);
    col += mix(uColorHi, uColorLo, 0.35) * haze * (mainC.x * 0.60 + farI * 0.35) * uGlow;

    // 6) 三层山脊剪影（由远及近）：只占画面下缘，越近越黑，脊线留一条细亮边
    float rf = horizon + 0.100 + (ridgeNoise(p.x * 1.50, 2.0) - 0.48) * 0.22;
    float farMask = 1.0 - smoothstep(rf - 0.0015, rf + 0.0015, p.y);
    vec3 farRock = mix(vec3(0.060, 0.082, 0.135), vec3(0.030, 0.044, 0.082),
                       1.0 - smoothstep(rf - 0.10, rf, p.y));
    farRock *= 0.78 + 0.50 * fbm(vec2(p.x * 3.2, p.y * 7.0 + 2.0), 3.0);
    farRock += mix(uColorHi, uColorLo, 0.5) * 0.22 * exp(-max(rf - p.y, 0.0) * 150.0)
             * (0.55 + 0.9 * vnoise(vec2(p.x * 4.0, 1.0)));
    col = mix(col, farRock, farMask);

    float rm = horizon + 0.018 + (ridgeNoise(p.x * 1.90 + 3.0, 4.0) - 0.48) * 0.18;
    float midMask = 1.0 - smoothstep(rm - 0.0015, rm + 0.0015, p.y);
    vec3 midRock = mix(vec3(0.026, 0.037, 0.068), vec3(0.012, 0.018, 0.036),
                       1.0 - smoothstep(rm - 0.09, rm, p.y));
    midRock *= 0.80 + 0.45 * fbm(vec2(p.x * 4.5 + 7.0, p.y * 9.0), 3.0);
    midRock += mix(uColorHi, uColorLo, 0.4) * 0.20 * exp(-max(rm - p.y, 0.0) * 190.0)
             * (0.55 + 0.9 * vnoise(vec2(p.x * 5.5, 3.0)));
    col = mix(col, midRock, midMask);

    // 7) 近山：近黑剪影，脊线细亮边，脊上带树梢锯齿
    float trees = 0.026 * pow(vnoise(vec2(p.x * 70.0, 3.0)), 3.0)
                + 0.007 * pow(vnoise(vec2(p.x * 210.0, 11.0)), 2.0);
    float rn = horizon - 0.075 + (ridgeNoise(p.x * 2.40 + 6.0, 7.0) - 0.48) * 0.16 + trees;
    float nearMask = 1.0 - smoothstep(rn - 0.0015, rn + 0.0015, p.y);
    float rim = exp(-max(rn - p.y, 0.0) * 300.0);
    vec3 nearRock = vec3(0.006, 0.009, 0.018);
    nearRock += mix(uColorHi, uColorLo, 0.3) * 0.30 * rim * (0.25 + 1.2 * clamp(mainC.x, 0.0, 1.0));
    nearRock += mix(uColorHi, uColorLo, 0.5) * 0.04 * exp(-max(rn - p.y, 0.0) * 40.0);   // 山脊上方雾气
    col = mix(col, nearRock, nearMask);

    // 8) 暗角 + 柔和压缩（保色相，不把极光亮部压成白块）
    vec2 q = uv - 0.5;
    col *= clamp(1.0 - 0.85 * dot(q, q) * 1.15, 0.0, 1.0);
    col = 1.0 - exp(-col * 1.35);
    col = pow(col, vec3(0.95));

    // 9) 抖动：压掉深色渐变上的色带
    col += (hash12(uv * vec2(1373.0, 911.0)) - 0.5) / 255.0;
    return vec4(col, 1.0);
}
