// AS_ExtP 脚本加载器（· W3 脚本清单化）
// 以 document.write 在解析期同步注入 scripts.manifest.js 声明的脚本，
// 加载语义与原 index.html 内静态 <script src> 标签完全等价：
//   - 解析器阻塞、严格按清单顺序执行（经典 script，无 defer/async）
//   - 失败即控制台报错并中断后续注入（与静态标签缺失文件的行为一致：
//     单个静态标签 404 时后续标签仍会执行；此处选择继续注入以贴近原行为，
//     同时打印明确错误便于排查）
// 注意：本文件必须作为最后一个 <script> 放在 index.html 原 217 个标签的位置。
(function (global) {
    var manifest = global.SCRIPTS_MANIFEST;
    if (!manifest || !manifest.files || !manifest.files.length) {
        console.error('[loader] SCRIPTS_MANIFEST 缺失或为空，脚本未加载');
        return;
    }
    for (var i = 0; i < manifest.files.length; i++) {
        document.write('<script src="' + manifest.files[i] + '"><\/script>');
    }
})(window);
