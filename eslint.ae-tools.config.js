// 补充配置：`eslint.config.js` 块①的 ignores 含 `client/modules/ae-tools/**`，
// 而该目录正是团队模式改动最重的目录（readOnly 注册、createHandler 接队列、ctx.laneId）。
// 只跑主配置 ⇒ 对该目录是**空判决**（0 error / 0 warning 不代表没问题，只是没检查）。
// 本文件复用主配置、仅去掉那一条 ignores，得到等价口径下的**真实**判决。
// 用法：npx eslint --config eslint.ae-tools.config.js client/modules/ae-tools
// 注意：块③ 仍排除 ae-tools 下的 *.jsx（ExtendScript 无法用现代规则检查），此处不动。
'use strict';

const base = require('./eslint.config.js');

module.exports = base.map(function (block) {
    if (Array.isArray(block.files) && block.files.indexOf('client/**/*.js') !== -1
        && Array.isArray(block.ignores)) {
        return Object.assign({}, block, {
            ignores: block.ignores.filter(function (p) { return p !== 'client/modules/ae-tools/**'; })
        });
    }
    return block;
});
