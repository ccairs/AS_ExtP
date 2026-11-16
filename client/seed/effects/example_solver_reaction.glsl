// ── 示例：Gray-Scott 反应扩散（结算器 demo）—— 螺旋珊瑚 ──
// 用途：演示结算器契约——状态**跨帧持久**、逐帧推进。第 0 步沿一条螺旋线播种
// （B 活化子），其后每子步做一次反应扩散，播放几秒就能长出经典珊瑚/迷宫纹。
//
// 契约要点：播种只判 uStep < 0.5（绝对步号，跨帧累计；判 uIter 会让种子每帧重撒）；
// 状态只经 iPrev 传递；迭代式里不掺 time；uResolution 在迭代趟里是仿真网格尺寸。
// 时间演化只能来自状态本身，所以纹样是「养殖」出来的，不是 time 的纯函数。
//
// 播种：一条两圈半左右的阿基米德螺旋（线宽约 2 格）+ 中心核 + 三个散点。
// 螺旋让第 1 秒起就有完整构图；种子之间留空，不形成均匀噪声。
//
// 调参：uFeed/uKill 决定形态（默认 0.055/0.062 是珊瑚/迷宫区）；uSpeed 是每步
// 推进量，显式积分的线性稳定上限约 1.25（默认 1.0 留余量，超过会失稳）；
// uColorB/uColorMagenta/uColorGold 是青、洋红、金三档。
//   · 0.0367/0.0649 → 分裂细胞，长得慢、斑点稀疏
//   · 0.026/0.051   → 游走斑点，更慢
// 网格越大纹路越细，代价是每帧状态纹理更大（可缓存帧数相应变少）。

// @solveHz 800
// @solveRes 256
uniform float uFeed  = 0.055;   // @range 0.010 0.090
uniform float uKill  = 0.062;   // @range 0.040 0.070
uniform float uSpeed = 1.0;     // @range 0.2 1.0
uniform vec3  uColorB       = vec3(0.25, 0.85, 1.00);   // @range 0.0 1.0
uniform vec3  uColorMagenta = vec3(0.85, 0.30, 0.85);   // @range 0.0 1.0
uniform vec3  uColorGold    = vec3(1.00, 0.75, 0.30);   // @range 0.0 1.0

// 确定性哈希（播种撒点用；不用 time，保证从同一起点出发）
float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// 到「两圈半阿基米德螺旋」的距离（在宽高比校正后的坐标里算）
float spiralDist(vec2 uv, float asp) {
    vec2 p = (uv - 0.5) * vec2(asp, 1.0);
    float th = atan(p.y, p.x);
    if (th < 0.0) th += 6.2831853;
    float r = length(p);
    float d = 1.0;
    for (int m = 0; m < 3; ++m) {
        float a = th + float(m) * 6.2831853;
        float R = 0.05 + 0.0268 * a;
        if (R < 0.43) d = min(d, abs(r - R));
    }
    return d;
}

vec4 iterateImage(vec2 fragCoord, float time) {
    vec2 uv = fragCoord;
    vec2 px = 1.0 / uResolution;        // 结算模式下 uResolution = 仿真网格尺寸
    float asp = uResolution.x / uResolution.y;

    if (uStep < 0.5) {
        // 第 0 步：A（底物）= 1 处处、B（活化子）= 0，沿螺旋线 + 中心核 + 三个散点撒 B。
        // 布局固定（不含 time），且本步在整个结算里只跑一次。
        float b = 1.0 - smoothstep(0.004, 0.013, spiralDist(uv, asp));
        vec2 c = uv - 0.5;
        b = max(b, 1.0 - smoothstep(0.010, 0.022, length(c * vec2(asp, 1.0))));
        for (int i = 0; i < 3; ++i) {
            float fi = float(i);
            vec2 o = vec2(cos(fi * 2.0944 + 0.7), sin(fi * 2.0944 + 0.7)) * 0.30;
            float rad = 0.009 + 0.005 * hash21(vec2(fi, 3.0));
            b = max(b, 1.0 - smoothstep(rad, rad * 2.4, length((c - o) * vec2(asp, 1.0))));
        }
        return vec4(1.0, b, 0.0, 1.0);
    }

    // 其后每个子步：一步 Gray-Scott 反应扩散
    // 9 点拉普拉斯（轴向 0.2 / 对角 0.05 / 中心 -1，正权重和为 1）
    vec4 c = texture(iPrev, uv);
    float la = 0.0, lb = 0.0;
    for (int y = -1; y <= 1; ++y) {
        for (int x = -1; x <= 1; ++x) {
            vec4 t = texture(iPrev, uv + vec2(float(x), float(y)) * px);
            float w = (x == 0 && y == 0) ? -1.0
                    : ((x == 0 || y == 0) ? 0.2 : 0.05);
            la += t.r * w;
            lb += t.g * w;
        }
    }
    float r = c.r * c.g * c.g;                 // 反应项
    float na = c.r + (1.0 * la - r + uFeed * (1.0 - c.r)) * uSpeed;
    float nb = c.g + (0.5 * lb + r - (uKill + uFeed) * c.g) * uSpeed;
    // 钳制是数值稳定性的必需项：越界会被下一子步放大，整片糊成噪声
    return vec4(clamp(na, 0.0, 1.0), clamp(nb, 0.0, 1.0), 0.0, 1.0);
}

vec4 mainImage(vec2 fragCoord, float time) {
    vec2 uv = fragCoord;
    vec2 tx = 1.0 / vec2(textureSize(iPrev, 0));   // 状态纹理 = 仿真网格
    vec4 st = texture(iPrev, uv);
    float a = st.r;
    float b = st.g;

    // B 场梯度 → 伪法线：给珊瑚表面做方向光与高光，出立体感
    float gx = texture(iPrev, uv + vec2(tx.x, 0.0)).g - texture(iPrev, uv - vec2(tx.x, 0.0)).g;
    float gy = texture(iPrev, uv + vec2(0.0, tx.y)).g - texture(iPrev, uv - vec2(0.0, tx.y)).g;
    vec3 n = normalize(vec3(-gx * 24.0, -gy * 24.0, 1.0));
    vec3 Ld = normalize(vec3(0.42, 0.38, 0.82));
    float diff = clamp(dot(n, Ld), 0.0, 1.0);
    float spec = pow(clamp(dot(n, normalize(Ld + vec3(0.0, 0.0, 1.0))), 0.0, 1.0), 28.0);
    spec *= smoothstep(0.05, 0.26, b);   // 只有纹样区有高光（平坦底噪不该被点亮）

    // 多档配色：深蓝 → 青 → 洋红 → 金；浓度越高越暖
    float tier = clamp((b - 0.05) / 0.34, 0.0, 1.0);
    vec3 col = mix(vec3(0.010, 0.020, 0.045), uColorB * 0.35, smoothstep(0.0, 0.30, tier));
    col = mix(col, uColorB, smoothstep(0.22, 0.52, tier));
    col = mix(col, uColorMagenta, smoothstep(0.52, 0.82, tier));
    col = mix(col, uColorGold, smoothstep(0.84, 1.00, tier));

    // 底物残留做低频明暗（A 被吃掉的地方稍暗，缝隙更深）
    col *= 0.55 + 0.45 * smoothstep(0.15, 0.85, a);
    // 方向光 + 高光：珊瑚表面的伪法线明暗
    col *= 0.32 + 1.05 * diff;
    col += vec3(1.0, 0.96, 0.88) * spec * 0.55;
    // 边缘提亮：B 梯度大的地方更亮，纹路有发光观感
    col += uColorB * pow(clamp(length(vec2(gx, gy)) * 45.0, 0.0, 1.0), 2.0) * 0.30;

    // 暗角 + 极暗的静态冷色底噪（留白区域不出现纯黑死区）
    float rr = length((uv - 0.5) * vec2(1.12, 1.0));
    float vig = 1.0 - 0.68 * smoothstep(0.28, 1.05, rr);
    float grain = hash21(uv * 731.0);
    vec3 base = vec3(0.008, 0.014, 0.030) + vec3(0.006, 0.010, 0.016) * grain;
    col = base + col * vig;
    return vec4(clamp(col, 0.0, 1.0), 1.0);
}
