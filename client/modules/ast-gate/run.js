// ast-gate/run.js — AST 编译门：门共享入口（四通道收口点）
// （client/modules/ast-gate/，双端模块：CEP 面板 window / Node globalThis）
//
// AE_LLM._runSandboxedScript(code, opts) 是全部 authored 代码执行通道的
// 唯一门入口（面板侧；执行核统一后
// 本函数仍是策略层）：
//   source=agent-tool  Agent 工具管线 executeExtendScript（args.code）
//   source=llm-preview 预览区 runScript（LLM submit_script 写入的代码）
//   source=ae-tool     JSON 定义工具（含种子桩）执行期过门（bootstrap createHandler）
// source=user-library 脚本树/quickBar 库文件——审计模式（dangers
//            危险清单 + 调用方确认层，emitted=原文）
//
// 弹窗族通道规则（「弹窗 = 通道固有属性」）：alert/confirm/
// prompt + ScriptUI 类族（tables DIALOG_IDS——Window/Panel/Button 等，FlashPlayer
// 刻意排除——外部 swf 执行面）在 DIALOG_SOURCES（llm-preview/user-library——
// 用户手动点运行的通道）放行且核侧真弹窗（服务层恒传帧载荷 dialog:true；Window
// 实例类型链 'ui-object'——任意静态键可读/写/调）；agent-tool/ae-tool（LLM
// 自动执行、无人在场）静态拒 + 核侧 shadow（alert→$.writeln 重定向、
// confirm/prompt throw——纵深兜 bypass/旁路）。不走能力域配置（全局域开关
// 无法表达 per-source 区分），bypass 不放行（对齐逃逸形态零例外）。
//
// 返回统一形态：
//   {ok:true, emitted[, dangers]}            —— 强制 source：emitted = 重发射产物
//                                            （执行它，校验与执行同一份——TOCTOU
//                                            消失）；user-library：emitted = 原文，
//                                            dangers = 审计危险清单（确认层输入）
//   {ok:false, rejected:true, error, displayText, llmText}
//                                          —— 结构化拒绝（4.5）+ 双格式文案
//                                            （displayText 面板用 / llmText 回喂 LLM 用）
//
// 能力域 policy（终版：四 source 统一读 astGateConfig.domains——llm-preview
// 一并注入， 的 agent-tool/ae-tool 限定废止；config.js 缺席的旧测试沙箱回退
// mirror 开关并保留该限定）。扩权后代码依然过门：
// 仅 system.callSystem 单成员放行，其余成员/计算键/赋值全拒。
(function (global) {
    'use strict';

    var AEGate = global.AEGate;

    // 面板侧 acorn 自举：vendored acorn 是 UMD（window.acorn），validate.js 的
    // gate() 读 AEGate._acorn——此处幂等注入（Node 测试端已自行 require 注入）
    if (AEGate && !AEGate._acorn && typeof global.acorn !== 'undefined') {
        AEGate._acorn = global.acorn;
    }

    function isGateMandatory(source) {
        return source === 'agent-tool' || source === 'llm-preview' || source === 'ae-tool';
    }

    function runSandboxedScript(code, opts) {
        opts = opts || {};
        var source = opts.source || 'agent-tool';

        // 通道信任层：bypass = 该通道
        // 四域能力全开 + 确认/审计层停用——「免打扰但不是免检」。门本身照跑：
        // 逃逸形态（eval/Function/with/constructor META）零例外前置拒、成员白名单
        // fail-closed 保持（未收录即拒）、emitted=门产物（重发射照常）。核侧
        // 执行携带全开帧载荷（system/socket/file——file 经包装构造器与域开启
        // 一致；execute()/changePath()/scheduleTask 等硬拒照拦）。（核侧三域
        // 载体由 args.__allow 改为授权帧载荷——
        // run.js 只经 allowSet 传入，不写 args）
        var _bypassed = !!(AEGate && AEGate.config && AEGate.config.isBypassed(source));

        // user-library：审计模式（信任根降级
        // 取代原「跳过门」）——AST 全量检测产 dangers 危险清单，不改写
        // （emitted=原文，所存即所跑）、不硬拒（确认层职责在调用方 UI——
        // dangers 非空 → 弹窗确认，per-script 记忆锚定内容哈希）。
        // 审计器缺席（模块未全载）时降级为纯直通（维持过渡态，运行时沙箱兜底）。
        if (!isGateMandatory(source)) {
            if (_bypassed) {
                // bypass ON：审计检测与确认弹窗整体停用（打扰面全消）——唯一
                // early return；emitted=原文（审计分支本不过门）
                return { ok: true, emitted: String(code), bypassed: true };
            }
            var _aud = (AEGate && typeof AEGate.audit === 'function')
                ? AEGate.audit(code)
                : { dangers: [] };
            return { ok: true, emitted: String(code), dangers: (_aud && _aud.dangers) || [] };
        }

        // 能力域层：四 source 统一。policyOverride = 当次授权
        // 重过门通道（Task 4 llm-preview 弹窗确认后注入）。bypass ON → policy
        // 强制四域全开后照常过门（落定 1 三次修正终版——门照跑，逃逸形态/
        // 成员白名单/重发射全部保持）。
        // config.js 缺席（旧测试沙箱未载该文件）时回退 mirror——
        // mirror 在面板端将由 config 单点维护（旧设置 UI 收割后
        // 成立；过渡期 ae-tools/index.js 旧 toggle 仍直写 mirror/旧键——门
        // 侧读 config 不受影响，核侧消费方暂现口径不一致，方向 fail-safe）；
        // 缺席降级仅为兼容既有 m2-pipeline/m2b 系 vm 沙箱（它们手动设
        // AE_LLM.allowAEToolsSystemCall 断言 agent-tool/ae-tool 通道 syscall
        // 过门——纯 config 读取会令 policy 变 null 而全红；llm-preview 仍拒的
        // 契约同步保持）
        var policy = _bypassed
            ? { syscallAllowed: true, socketAllowed: true, fileAllowed: true, menuAllowed: true }
            : ((AEGate && AEGate.config)
                ? AEGate.config.getEffectivePolicy(opts.policyOverride)
                : (((source === 'agent-tool' || source === 'ae-tool') &&
                    global.AE_LLM && global.AE_LLM.allowAEToolsSystemCall)
                    ? { syscallAllowed: true } : null));

        var verdict = AEGate.gate(code, { policy: policy, source: source });
        if (!verdict.ok) {
            var e = verdict.error || {};
            // Identifier 级拒绝不能引导 propose——
            // 补表只覆盖「类型成员」面（加成员 / 新增类型 / 改写已有条目判定），全局
            // 标识符仍由维护者改种子表发版；旧文案只说「只能加成员」也是死路。
            // error.officialAbsent（validate 命中 MEMBER_REPLACEMENTS）表示
            // 「官方 API 无此成员」——补表会把不存在的成员收进能力表，尾注必须改口；
            // 其它普通未收录（unknown 来源、同名成员在别的接收者上）补表语义仍成立，保持原文案。
            var _tailGuide;
            if ((e.construct || '').indexOf('Identifier:') === 0) {
                _tailGuide = '若该标识符是官方 ExtendScript API 且非硬拒项，需维护者补表发版（propose 只处理类型成员：加成员/新增类型/改写既有条目判定，不能加全局标识符）。';
            } else if (e.officialAbsent) {
                _tailGuide = '该成员不是官方 ExtendScript API，不要提议补表；请按「替代方案」里的官方调用改写代码。';
            } else if (e.computedWrite) {
                _tailGuide = '该拒绝是集合下标写策略：AE 集合无下标赋值 API，propose 只处理类型成员、改不了该策略。下标只读；写入请对元素操作（coll[i].member = …）。';
            } else if (e.computedDom) {
                _tailGuide = '该拒绝是计算（动态键）策略：propose 只处理类型成员，改不了 computed 策略。数组/集合用数值下标取元素（集合按名取元素用对应 API，如 comp.layer(name)/layers.byName(name)）；命名类型上的动态键改写为静态成员访问（集合索引缺口由维护者补 tables.COLLECTIONS 登记）。';
            } else {
                _tailGuide = '若该成员是官方 ExtendScript API 且非硬拒项，可调用 propose_table_entry 提议（须附官方文档出处 URL）：默认给已有类型加成员；门内缺这个类型时用 newType=true 新增类型；已有条目判定记错（如返回类型记成 u）用 override=true 改写。经审查与用户确认后生效。';
            }
            return {
                ok: false,
                rejected: true,
                error: e,
                // 面板/日志用：单行
                displayText: 'AST 门拒绝 [' + (e.construct || 'unknown') + '] 第 ' +
                    (e.line || 0) + ' 行第 ' + (e.column || 0) + ' 列：' + (e.reason || ''),
                // 回喂 LLM 用：多行 + 改写引导（拒绝回路——LLM 自修正的输入质量）
                llmText: 'AST 编译门拒绝执行此代码（能力白名单校验未通过）：\n' +
                    '- 位置：第 ' + (e.line || 0) + ' 行，第 ' + (e.column || 0) + ' 列\n' +
                    '- 结构：' + (e.construct || 'unknown') + '\n' +
                    '- 原因：' + (e.reason || '未知') + '\n' +
                    (e.alternative ? '- 替代方案：' + e.alternative + '\n' : '') +
                    (e.domain ? '- 能力域：本次拒绝由「' + e.domain + '」能力域未开启引起——可提示用户在「Agent 模块设置 > AST 门能力配置」开启后重试，或改用参数式工具\n' : '') +
                    '请按上述位置与原因修改代码后重新调用；文件/系统/网络类需求请改用对应的参数式工具；' + _tailGuide
            };
        }
        // lineMap 透传（产物行 → 原文行）——运行时错误回指数据通道；
        // user-library 审计分支（上方）emitted=原文，无映射语义不产 lineMap。
        // bypassed 标志——调用方据此跳过确认层（拒绝返回不带：域拒绝在
        // bypass ON 时不发生，逃逸形态拒绝与 bypass 无关）
        // noExecutableStatement 透传（产物的 AST 里没有可执行语句）——
        // 调用方据此拒绝"空代码"，免得宿主把「什么都没执行」回成「执行成功」
        return {
            ok: true, emitted: verdict.emitted, lineMap: verdict.lineMap || null, bypassed: _bypassed,
            noExecutableStatement: verdict.noExecutableStatement === true
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM._runSandboxedScript = runSandboxedScript;
})(typeof window !== 'undefined' ? window : globalThis);
