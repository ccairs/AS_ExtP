// behaviors/index.js — 聚合所有默认行为，确保全部加载
(function (global) {
    'use strict';

    // 确保所有行为文件已加载（通过 index.html 的 script 标签按序引入）
    // 此文件仅做存在性检查，不重复定义
    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.defaultBehaviors = global.AEDeepseekPet.defaultBehaviors || {};
})(window);
