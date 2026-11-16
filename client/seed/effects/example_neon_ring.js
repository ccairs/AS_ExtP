// 霓虹圆环效果（JS 编排示例）
// 演示 JS 效果契约：buildShader(params) 返回 GLSL 字符串
// params: { uStrength } 由面板注入（uniform 默认值）
// 设计：uStrength 作为 JS 参数 → 计算 intensityFactor（JS 数学）→ 硬编码到 GLSL；
//       uColor/uSpeed 作为 uniform（AE 滑块可调），在 GLSL 内使用
/* exported buildShader */
function buildShader(params) {
    var strength = params.uStrength || 0.8;

    // 根据 strength 动态生成强度系数（JS 数学计算示例：strength 越大，强度系数越高）
    var intensityFactor = (strength * 2.0).toFixed(3);

    // 动态拼接 GLSL（数组 join 生成多行代码）
    return [
        'uniform float uStrength;',
        'uniform vec3 uColor;',
        'uniform float uSpeed;',
        '',
        'vec4 mainImage(vec2 fragCoord, float time) {',
        '  vec2 p = (fragCoord - 0.5) * vec2(uAspect, 1.0);',
        '  float d = length(p);',
        '  float ring = smoothstep(0.30, 0.28, d) - smoothstep(0.28, 0.26, d);',
        '  // 强度随时间脉动（uSpeed 滑块控制脉动频率）',
        '  float pulse = 0.5 + 0.5 * sin(time * uSpeed * 3.0);',
        '  vec3 neon = uColor * ring * uStrength * ' + intensityFactor + ' * (0.7 + 0.3 * pulse);',
        '  return vec4(neon, 1.0);',
        '}'
    ].join('\n');
}
