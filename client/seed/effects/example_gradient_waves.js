// 渐变波浪效果（JS 编排示例）
// 演示循环生成 GLSL 代码片段：多层波浪叠加
// params: { uLayers, uFrequency } 由面板注入（JS 编排参数，非 uniform）
// 设计：uLayers/uFrequency 作为 JS 参数 → 控制循环次数和频率 → 硬编码到 GLSL；
//       uSpeed 作为 uniform（AE 滑块可调），在 GLSL 内使用
/* exported buildShader */
function buildShader(params) {
    var layers = params.uLayers || 4;
    var frequency = params.uFrequency || 8.0;

    // 限制层数（防御性）
    var n = Math.max(1, Math.min(8, Math.floor(layers)));

    // 循环生成多层波浪的 GLSL 片段（每层不同相位和衰减）
    var waveLines = [];
    for (var i = 0; i < n; i++) {
        var phase = (i * 0.7).toFixed(3);
        var scale = (1.0 - i * 0.1).toFixed(3);
        waveLines.push('  wave += ' + scale + ' * sin((p.x + p.y) * ' + frequency.toFixed(3) + ' + time * uSpeed + ' + phase + ');');
    }

    return [
        'uniform float uSpeed;',
        '',
        'vec4 mainImage(vec2 fragCoord, float time) {',
        '  vec2 p = fragCoord * vec2(uAspect, 1.0);',
        '  float wave = 0.0;',
        waveLines.join('\n'),
        '  wave = wave * 0.5 + 0.5;',
        '  vec3 col = mix(vec3(0.1, 0.2, 0.5), vec3(0.8, 0.4, 0.9), wave);',
        '  return vec4(col, 1.0);',
        '}'
    ].join('\n');
}
