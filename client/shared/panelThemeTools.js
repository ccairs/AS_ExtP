// 面板主题工具（单件 panel_theme：读现状 / 改主题色 / 管理配色方案）。
//
// 为什么合成一件 + 转 stub：
//   三件工具（panel_theme_get / panel_theme_set_colors / panel_theme_manage_presets）若都以
//   stub:false 完整定义，每轮注入 1877 字符 / flat 470 token / CJK 752 token。
//   合成一件并转 stub：每轮只注入 name + 短描述；
//   完整 schema 由 tool_search 按需取回（执行侧 stub 闸门强制先 search：toolExecutionPipeline
//   的 TOOL_NOT_SEARCHED，提示词侧同款铁律）。
//
// 「面板限定」两道闸（不变）：
//   门一：scope = { type:'module', moduleIds:['agent'] } —— 外接投影（extTools.scopeAllowsExternal）
//         与执行期（toolExecutor.checkAccess）都要求 module 作用域显式含 'external-mcp'，本条不含 → 拒。
//   门二：本工具不进 extPolicy.TOOL_GROUPS 任何 fixed 名单 → groupOfTool 为 null → 外接
//         NOT_IN_EXTERNAL_WHITELIST（该组的组集合有冻结断言，新增组会连带改快照，故不新增组）。
//
// 工具只作用于面板 UI 主题：不写 AE 工程、不经 ExtendScript、不产生撤销组。
(function (global) {
    'use strict';

    var TOOL_SCOPE = { type: 'module', moduleIds: ['agent'] };
    var SOURCE = 'panel-theme';
    var CATEGORY = 'panel';

    // 动作集合：get / set_colors 对应原 panel_theme_get / panel_theme_set_colors，
    // 其余五个对应原 panel_theme_manage_presets 的 action。
    var ACTIONS = ['get', 'set_colors', 'save', 'apply', 'rename', 'delete', 'reset_default'];

    // 20 键清单只在 colors.description 里出现一份（曾被 set_colors 与 manage_presets 各抄一份；
    // 体积棘轮校验）。
    var COLORS_DESC = '核心色键（20 项；语义状态色另 6 项也可读写）：'
        + 'appBg/surface1/surface2/surface3/inputBg/border/btnBorder/textMain/textMuted/'
        + 'accent/accent2/accentPurple/btnBg/btnText/btnHoverBg/danger/dangerSoft/signalGreen/warning/visionProxy。'
        + '值形如 "#ff8a3d" / "rgba(255,138,61,0.2)" / "255,138,61"；未传的键不动。';

    function ok(payload) {
        return {
            success: true, isError: false,
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
        };
    }

    function fail(message, extra) {
        return {
            success: false, isError: true,
            content: [{ type: 'text', text: extra ? message + '\n' + JSON.stringify(extra, null, 2) : message }]
        };
    }

    function errText(r) {
        if (r && r.message) return r.message;
        return '操作失败：' + ((r && r.error) || 'UNKNOWN');
    }

    function toast(msg) {
        try {
            if (global.AEToast && typeof global.AEToast.show === 'function') global.AEToast.show(msg, 'info');
        } catch (_) {}
    }

    function _summary(action, r) {
        if (action === 'save') return (r.created ? '已新建方案「' : '已更新方案「') + r.scheme.name + '」';
        if (action === 'apply') return '已切换到方案「' + r.scheme.name + '」';
        if (action === 'rename') return '方案已改名为「' + r.scheme.name + '」';
        if (action === 'delete') {
            return '已删除方案「' + r.deleted.name + '」' + (r.fellBackToDefault ? '，主题回落默认预设' : '');
        }
        if (action === 'reset_default') return '已切回默认预设（方案库保留）';
        return '已完成';
    }

    // 报错前缀带动作名：合成一件后，不写动作就看不出是哪条分支炸的
    function _errPrefix(action) {
        return 'panel_theme 执行错误' + (action ? '（' + action + '）' : '') + '：';
    }

    function initPanelThemeTools(config) {
        config = config || {};
        var registry = config.toolRegistry;
        var theme = config.panelTheme
            || (global.AE_LLM && global.AE_LLM.panelTheme)
            || null;
        if (!registry || typeof registry.register !== 'function') {
            return { ok: false, error: 'MISSING_TOOL_REGISTRY' };
        }
        if (!theme || typeof theme.getState !== 'function') {
            return { ok: false, error: 'MISSING_PANEL_THEME' };
        }

        var result = registry.register({
            name: 'panel_theme',
            description: '面板主题：action=get 读现状（预设档 / 生效方案 / 26 项可编辑色当前值 / 方案清单）；'
                + 'set_colors 改色（传 colors 即生效并保存；内置预设时自动新建方案再改）；'
                + 'save/apply/rename/delete/reset_default 管理配色方案（save 同名即更新；'
                + 'delete 删当前方案则回落默认主题；reset_default 回默认预设、方案库保留）。'
                + '只改面板外观，不动 AE 工程；被忽略的键、格式错误、对比度过低提示都在结果里回报。',
            shortDescription: '面板主题：读现状/改主题色/管理配色方案',
            input_schema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ACTIONS,
                        // 七个动作的语义只在上面的 description 里说一遍（枚举值本身自明）
                        description: '动作（语义见工具说明）'
                    },
                    colors: {
                        type: 'object',
                        description: COLORS_DESC + '（set_colors 必传，save 可选）',
                        additionalProperties: true
                    },
                    name: { type: 'string', description: '目标方案名或 id（set_colors/save/apply/rename/delete）' },
                    newName: { type: 'string', description: 'rename 时的新名字（1–24 字符）' },
                    apply: { type: 'boolean', description: 'save 时是否立即应用（默认 true）' }
                },
                required: ['action']
            },
            handler: function (args) {
                args = args || {};
                var action = args.action;

                if (action === 'get') {
                    try {
                        var st = theme.getState();
                        return ok({
                            summary: '面板主题现状：' + st.presetLabel
                                + (st.activeScheme ? '（方案「' + st.activeScheme.name + '」）' : '（内置预设）'),
                            preset: st.themePreset,
                            presetLabel: st.presetLabel,
                            scheme: st.activeScheme,
                            colors: st.colors,
                            schemes: st.schemes
                        });
                    } catch (e) {
                        return fail(_errPrefix(action) + (e && e.message ? e.message : e));
                    }
                }

                if (action === 'set_colors') {
                    return Promise.resolve(theme.setColors(args.colors, { preset: args.name, draft: false })).then(function (r) {
                        if (!r || r.ok !== true) return fail(errText(r), r && r.ignored ? { ignored: r.ignored } : null);
                        var lead = (r.forked ? '已新建方案「' + r.scheme.name + '」并应用' : '已应用方案「' + r.scheme.name + '」')
                            + '：改了 ' + r.appliedKeys.length + ' 项';
                        if (r.applied === false) {
                            // 写入已落盘但外观未生效（applier 抛错）：如实说明，不谎报已应用
                            lead = '已保存到方案「' + r.scheme.name + '」，但面板外观未能生效（应用环节报错）';
                        }
                        toast('Agent 已更新面板主题：' + r.scheme.name);
                        if (r.warning) lead += '。注意：' + r.warning;
                        return ok({
                            summary: lead,
                            appliedKeys: r.appliedKeys,
                            ignored: r.ignored,
                            scheme: r.scheme,
                            forked: r.forked,
                            applied: r.applied !== false,
                            warning: r.warning || ''
                        });
                    }, function (e) {
                        return fail(_errPrefix(action) + (e && e.message ? e.message : e));
                    });
                }

                var p;
                // draft:false = 外部写入即时落盘：若「全局设置」弹窗正开着未保存的主题草稿，
                // 先丢弃草稿再写，避免把预览态连同这次写入一起落盘（Agent 写入契约是 fail-closed 落盘）
                if (action === 'save') p = theme.savePreset(args.name, args.colors, args.apply, { draft: false });
                else if (action === 'apply') p = theme.applyPreset(args.name, { draft: false });
                else if (action === 'rename') p = theme.renamePreset(args.name, args.newName, { draft: false });
                else if (action === 'delete') p = theme.deletePreset(args.name, { draft: false });
                else if (action === 'reset_default') p = theme.resetToDefault({ draft: false });
                else {
                    return fail('未知 action：「' + action + '」。合法值：' + ACTIONS.join(' / ') + '。');
                }
                return Promise.resolve(p).then(function (r) {
                    if (!r || r.ok !== true) return fail(errText(r));
                    var out = { summary: _summary(action, r), action: r.action || action };
                    if (r.scheme) out.scheme = r.scheme;
                    if (r.deleted) out.deleted = r.deleted;
                    if (typeof r.created === 'boolean') out.created = r.created;
                    if (typeof r.fellBackToDefault === 'boolean') out.fellBackToDefault = r.fellBackToDefault;
                    if (typeof r.pointerCleared === 'boolean') out.pointerCleared = r.pointerCleared;
                    if (r.ignored && r.ignored.length) out.ignored = r.ignored;
                    if (r.applied === false) out.applied = false;
                    // 每次成功变更都给面板内可见反馈（面板外观可能变了，用户要知道原因）
                    toast('面板主题：' + out.summary);
                    return ok(out);
                }, function (e) {
                    return fail(_errPrefix(action) + (e && e.message ? e.message : e));
                });
            },
            scope: TOOL_SCOPE, stub: true, source: SOURCE, category: CATEGORY
        });

        if (!result || result.ok !== true) {
            return { ok: false, error: 'REGISTER_FAILED', details: [result && result.error] };
        }
        return { ok: true, registered: ['panel_theme'] };
    }

    global.AEShared = global.AEShared || {};
    global.AEShared.initPanelThemeTools = initPanelThemeTools;
})(window);
