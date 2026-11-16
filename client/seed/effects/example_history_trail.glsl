// ── 示例：输入历史拖尾（@history）──
// 当前帧与前面 4 帧的输入一起参与计算，做「主体 + 多重回声」构图：
//   · 当前帧 = 主体：居中、冷白、保留完整的亮部结构；
//   · 前 1..4 帧 = 回声层：各自按帧龄做 UV 偏移与径向缩放（越早的帧错得越远、放得越大），
//     取各自的局部高反差轮廓，按帧龄上色（青 → 洋红 → 金 → 紫），加色叠在暗底上。
//   有运动素材时回声层沿运动轨迹散开，形成带色相渐变的彩色拖尾；
//   静态素材上是同一画面错位叠出的多层轮廓，一眼能看出层次。
// 预览里历史帧与当前帧是同一张，看不到累积过程；拖尾要叠在运动素材上或给图层位置/缩放打关键帧看。
//
// 参数：uDecay 回声衰减；uTrail 整体强度；uGlow 辉光；uVignette 暗角；
//       uTint 整体偏色；uColorLo 暗底色；uColorHi 暖端色。

// @history 4
uniform float uDecay    = 0.70;                     // @range 0.0 0.95
uniform float uTrail    = 1.00;                     // @range 0.0 2.0
uniform float uGlow     = 0.90;                     // @range 0.0 2.0
uniform float uVignette = 0.80;                     // @range 0.0 1.0
uniform vec3  uTint     = vec3(1.00, 0.97, 0.93);   // @range 0.0 1.0
uniform vec3  uColorLo  = vec3(0.03, 0.05, 0.15);   // @range 0.0 1.0
uniform vec3  uColorHi  = vec3(1.00, 0.74, 0.36);   // @range 0.0 1.0

float luma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// 帧龄色阶：0 = 当前帧（冷白），1 = 最远的回声层（紫）。
vec3 ageColor(float a) {
    vec3 c0 = vec3(0.88, 0.94, 1.00);   // 当前帧：冷白
    vec3 c1 = vec3(0.24, 0.95, 1.00);   // 前 1 帧：青
    vec3 c2 = vec3(1.00, 0.30, 0.84);   // 前 2 帧：洋红
    vec3 c3 = vec3(1.00, 0.72, 0.24);   // 前 3 帧：金
    vec3 c4 = vec3(0.54, 0.38, 1.00);   // 前 4 帧：紫
    float t = clamp(a, 0.0, 1.0) * 4.0;
    vec3 c = mix(c0, c1, clamp(t, 0.0, 1.0));
    c = mix(c, c2, clamp(t - 1.0, 0.0, 1.0));
    c = mix(c, c3, clamp(t - 2.0, 0.0, 1.0));
    return mix(c, c4, clamp(t - 3.0, 0.0, 1.0));
}

// 回声层：偏移 + 缩放取样，用局部差分提取轮廓并按帧龄染色。
vec3 echo(vec2 uv, vec2 tx, sampler2D tex, vec2 offset, float scale, float age, float weight) {
    vec2 euv = 0.5 + (uv - 0.5) * scale + offset;
    float c = luma(texture(tex, euv).rgb);
    float ex = luma(texture(tex, euv + vec2(3.0, 0.0) * tx).rgb);
    float ey = luma(texture(tex, euv + vec2(0.0, 3.0) * tx).rgb);
    float edge = clamp((abs(c - ex) + abs(c - ey)) * 5.5, 0.0, 1.0);
    float body = smoothstep(0.25, 0.85, c) * 0.10;          // 轮廓内部留一点微光
    return ageColor(age) * (edge + body) * weight;
}

vec4 mainImage(vec2 uv, float time) {
    vec2 tx = 1.0 / max(uResolution, vec2(1.0));

    // —— 主体：当前帧，冷白、清晰 ——
    vec3 main = texture(iChannel0, uv).rgb;
    float lm = clamp(luma(main), 0.0, 1.0);
    vec3 col = mix(vec3(lm), main, 0.20) * ageColor(0.0)
             * (0.012 + 0.30 * pow(smoothstep(0.20, 0.90, lm), 1.5));

    // —— 回声层：越早的帧错得越远、放得越大、颜色越偏紫 ——
    float d = clamp(uDecay, 0.05, 0.95);
    col += echo(uv, tx, iHistory0, vec2( 0.060,  0.014), 1.000, 0.28, 0.95);
    col += echo(uv, tx, iHistory1, vec2( 0.125,  0.034), 1.045, 0.52, 0.80 * d);
    col += echo(uv, tx, iHistory2, vec2(-0.165, -0.050), 1.090, 0.76, 0.66 * d * d);
    col += echo(uv, tx, iHistory3, vec2(-0.245, -0.086), 1.140, 1.00, 0.52 * d * d * d);

    // —— 辉光：主体亮部外扩一圈 ——
    vec3 soft = texture(iChannel0, uv + vec2(14.0, 0.0) * tx).rgb
              + texture(iChannel0, uv - vec2(14.0, 0.0) * tx).rgb
              + texture(iChannel0, uv + vec2(0.0, 22.0) * tx).rgb
              + texture(iChannel0, uv - vec2(0.0, 22.0) * tx).rgb;
    soft *= 0.25;
    col += soft * mix(ageColor(0.1), uColorHi, 0.4) * smoothstep(0.60, 0.96, luma(soft)) * uGlow * 0.45;

    // —— 暗底 + 暗角 + 压缩 ——
    vec2 q = (uv - 0.5) * vec2(uAspect, 1.0);
    float vig = 1.0 - uVignette * smoothstep(0.15, 1.00, length(q));
    col *= vig * uTrail;
    col += uColorLo * 0.55 * (1.0 - vig);
    col = pow(clamp(col, 0.0, 4.0), vec3(1.30)) * 0.95;   // 压中间调，保住暗底
    col = 1.0 - exp(-col * 1.75);
    col = pow(col, vec3(0.85));

    float a = max(max(texture(iChannel0, uv).a, texture(iHistory0, uv).a),
              max(max(texture(iHistory1, uv).a, texture(iHistory2, uv).a), texture(iHistory3, uv).a));
    return vec4(col * uTint, a);
}
