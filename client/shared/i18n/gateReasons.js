// AST 门拒绝的用户可见分类文案。
// 门侧 error.reason / error.alternative 是给 LLM 自修正的诊断原文（保持中文，走 llmText）；
// 面板在非源语言界面只显示这里的分类句，避免状态栏与错误卡里中英混排。
// 分类依据是门返回的结构化字段（domain / computedWrite / computedDom / officialAbsent /
// construct 前缀），不解析中文原文。
(function (global) {
    'use strict';

    function summary(error) {
        var e = error || {};
        var construct = String(e.construct || '');
        if (e.domain) return global.AEI18n.t('能力域「{domain}」未开启', { domain: e.domain });
        if (e.computedWrite) return global.AEI18n.t('集合下标不可写（AE 集合无下标赋值 API）');
        if (e.computedDom) return global.AEI18n.t('计算（动态键）成员访问被拒绝');
        if (e.officialAbsent) return global.AEI18n.t('官方 ExtendScript API 无此成员');
        if (construct.indexOf('Identifier:') === 0) return global.AEI18n.t('标识符不在能力白名单内');
        if (construct.indexOf('MemberWrite:') === 0 || construct.indexOf('Member:') === 0) {
            return global.AEI18n.t('成员不在能力白名单内');
        }
        return global.AEI18n.t('代码未通过能力白名单校验');
    }

    global.AEGateReasons = { summary: summary };
})(typeof window !== 'undefined' ? window : globalThis);
