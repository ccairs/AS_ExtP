// ── 示例：跨帧结算器（纯扩散 + 持续源）—— 三色霓虹涟漪 ──
// 用途：演示结算器契约——状态**跨帧持久**、逐帧推进。每步只做一次 9 点拉普拉斯
// 纯扩散，三个固定发射点按各自周期向三个通道注入脉冲，作为持续源。
//
// 状态布局：R/G/B 各存一份独立的扩散场（扩散是线性算子，三份场互不影响），
// 主趟按通道上色：三色分别对应三个发射点，交叠处自然混成暖白。亮度由注入与
// 扩散达成平衡，不随步数衰减；注入按脉冲给、强度有上限，不会糊成一片。
//
// 契约要点：播种只判 uStep < 0.5（绝对步号，跨帧累计）；状态只经 iPrev 传递；
// uResolution 在迭代趟里是仿真网格尺寸、在主趟里是渲染尺寸；迭代式里不掺 time。
//
// 调参：uRate 扩散强度（≤1 时正权重和为 1、保持凸组合；线性稳定上限约 1.25，
// 越大波前推得越快）；uSeedR 发射环半径（同时决定初始波纹尺度与注入范围）；
// uPulse 脉冲注入强度（越大越亮、也越快把画面填满）；uColor/uColorB/uColorC 是三个发射点的颜色。

// @solveHz 200
// @solveRes 128
uniform float uRate  = 0.5;     // @range 0.1 1.0
uniform float uSeedR = 0.032;   // @range 0.012 0.06
uniform float uPulse = 0.30;    // @range 0.05 0.8
uniform vec3  uColor  = vec3(0.30, 0.85, 1.00);   // @range 0.0 1.0
uniform vec3  uColorB = vec3(1.00, 0.32, 0.78);   // @range 0.0 1.0
uniform vec3  uColorC = vec3(1.00, 0.68, 0.26);   // @range 0.0 1.0

// 三个发射点的位置（uv，y 向上）；各自的脉冲周期/相位写在注入处
const vec2 E0 = vec2(0.29, 0.60);
const vec2 E1 = vec2(0.71, 0.60);
const vec2 E2 = vec2(0.50, 0.30);

// 各向同性距离：x 差乘网格横纵比，长度以「网格高度」为单位
float distTo(vec2 uv, vec2 p, float asp) {
    return length(vec2((uv.x - p.x) * asp, uv.y - p.y));
}

// 周期脉冲包络：每个周期开头注入，按 exp(-(步内相位/3.5)²) 衰减（3.5 步处约 e⁻¹）
float pulseEnv(float period, float phase) {
    float ph = mod(uStep + phase, period);
    return exp(-(ph * ph) / 12.25);
}

// 圆环注入掩码：半径 rad、环宽 wid（同 distTo 的距离单位）
float ringMask(float d, float rad, float wid) {
    float q = (d - rad) / wid;
    return exp(-q * q);
}

// 第 0 步的波纹初值：亮核 + 四道同心环（越外越弱）
float seedRings(float d) {
    float r = uSeedR;
    return 0.72 * exp(-pow(d / (r * 0.65), 2.0))
         + 0.42 * ringMask(d, r * 1.8, r * 0.32)
         + 0.26 * ringMask(d, r * 3.5, r * 0.44)
         + 0.16 * ringMask(d, r * 5.2, r * 0.50)
         + 0.09 * ringMask(d, r * 6.8, r * 0.60);
}

// 每步注入：窄环脉冲 + 中心小核（同一包络；环宽随 uSeedR 缩放）
float pulseSource(vec2 uv, vec2 p, float asp, float period, float phase) {
    float r = uSeedR;
    float d = distTo(uv, p, asp);
    return uPulse * pulseEnv(period, phase)
         * (ringMask(d, r, r * 0.5) + 0.55 * exp(-pow(d / (r * 1.1), 2.0)));
}

// 发射点中心的小稳态源：脉冲间隙也有微光，画面不会周期性闪灭
float steadyCore(vec2 uv, vec2 p, float asp) {
    float d = distTo(uv, p, asp) / (uSeedR * 0.9);
    return uPulse * 0.002 * exp(-d * d);
}

vec4 iterateImage(vec2 fragCoord, float time) {
    vec2 uv = fragCoord;
    vec2 px = 1.0 / uResolution;        // 结算模式下 = **仿真网格**尺寸
    float asp = uResolution.x / uResolution.y;

    if (uStep < 0.5) {
        // 第 0 步：播种（整个结算里只执行一次）
        return vec4(min(seedRings(distTo(uv, E0, asp)), 1.0),
                    min(seedRings(distTo(uv, E1, asp)), 1.0),
                    min(seedRings(distTo(uv, E2, asp)), 1.0), 1.0);
    }

    // 其后每一步：9 点拉普拉斯（轴向 0.2 / 对角 0.05 / 中心 -1，正权重和为 1）
    vec4 c = texture(iPrev, uv);
    vec3 la = vec3(0.0);
    for (int y = -1; y <= 1; ++y) {
        for (int x = -1; x <= 1; ++x) {
            vec4 t = texture(iPrev, uv + vec2(float(x), float(y)) * px);
            float w = (x == 0 && y == 0) ? -1.0
                    : ((x == 0 || y == 0) ? 0.2 : 0.05);
            la += t.rgb * w;
        }
    }
    vec3 s = c.rgb + la * uRate;

    // 持续源：三个固定点按各自周期注入（周期/相位都不同，波前互相错开）
    s.r += pulseSource(uv, E0, asp, 210.0, 0.0);
    s.g += pulseSource(uv, E1, asp, 270.0, 135.0);
    s.b += pulseSource(uv, E2, asp, 300.0, 60.0);
    s.r += steadyCore(uv, E0, asp);
    s.g += steadyCore(uv, E1, asp);
    s.b += steadyCore(uv, E2, asp);

    // 钳制是数值稳定性的必需项（防止积累越界后整片糊亮）
    return vec4(clamp(s, 0.0, 1.0), 1.0);
}

vec4 mainImage(vec2 fragCoord, float time) {
    vec2 uv = fragCoord;
    vec2 tx = 1.0 / vec2(textureSize(iPrev, 0));   // 状态纹理 = 仿真网格
    vec3 s = texture(iPrev, uv).rgb;

    // 中尺度模糊（8 方向 × 3.5 纹素）：与原始场之差留下「波前」脊线
    vec3 blur = vec3(0.0);
    for (int i = 0; i < 8; ++i) {
        float a = float(i) * 0.7854;
        blur += texture(iPrev, uv + vec2(cos(a), sin(a)) * tx * 3.5).rgb;
    }
    blur /= 8.0;
    vec3 hp = max(s - blur, 0.0);
    vec3 rip = hp / (hp + 0.012);

    // 等值带：sqrt(浓度) 的余弦相位 → 由内向外逐渐变宽的同心带（涟漪观感）。
    // 带只作用于中高浓度区，低浓度区留黑，避免出现大半径条纹。
    vec3 bandMask = smoothstep(0.07, 0.18, s);
    vec3 band = pow(0.5 + 0.5 * cos(6.2832 * 10.0 * sqrt(s)), vec3(2.2));
    vec3 fine = pow(0.5 + 0.5 * cos(6.2832 * 22.0 * sqrt(s) + 1.2), vec3(3.0));

    // 低增益光晕 + 高光核心 + 脊线 + 两级等值带（主带 + 波前外侧细纹）
    vec3 ch = 0.26 * sqrt(s) + 1.0 * s * s + 0.10 * rip + 0.04 * rip * rip
            + 2.2 * band * pow(s, vec3(0.35)) * bandMask
            + 0.55 * fine * pow(s, vec3(0.30)) * bandMask;
    vec3 col = uColor * ch.r + uColorB * ch.g + uColorC * ch.b;

    // 伪法线明暗：把总浓度当高度场做一次方向光，给平面波纹一点立体感
    vec3 lf = texture(iPrev, uv - vec2(tx.x, 0.0)).rgb;
    vec3 rt = texture(iPrev, uv + vec2(tx.x, 0.0)).rgb;
    vec3 dn = texture(iPrev, uv - vec2(0.0, tx.y)).rgb;
    vec3 up = texture(iPrev, uv + vec2(0.0, tx.y)).rgb;
    float gx = (rt.r + rt.g + rt.b - lf.r - lf.g - lf.b) / 3.0;
    float gy = (up.r + up.g + up.b - dn.r - dn.g - dn.b) / 3.0;
    vec3 n = normalize(vec3(-gx * 18.0, -gy * 18.0, 1.0));
    vec3 Ld = normalize(vec3(0.42, 0.55, 0.72));
    float diff = clamp(dot(n, Ld), 0.0, 1.0);
    float spec = pow(clamp(dot(n, normalize(Ld + vec3(0.0, 0.0, 1.0))), 0.0, 1.0), 20.0);
    col *= 0.35 + 0.95 * diff;
    col += vec3(1.0, 0.95, 0.88) * spec * 0.30;

    // 白热核心
    float tot = (s.r + s.g + s.b) / 3.0;
    col += vec3(1.0, 0.96, 0.90) * pow(clamp(tot * 1.6, 0.0, 1.0), 4.0) * 0.5;

    // 暗角 + 深蓝底色
    float rr = length((uv - 0.5) * vec2(1.12, 1.0));
    float vig = 1.0 - 0.88 * smoothstep(0.16, 0.82, rr);
    col = vec3(0.010, 0.017, 0.040) + col * vig;
    return vec4(clamp(col, 0.0, 1.0), 1.0);
}
