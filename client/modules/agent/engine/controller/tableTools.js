// tableTools.js — propose_table_entry 工具（提议-确认-落表闭环编排）
// 防线三层：机械预审（userTable.precheck，硬）→ 审核员 LLM
//（软——initTableTools 注入或 global.AEEngine.reviewTableProposal 全局解析，
// engine/bootstrap.js 生产接线位）→ 用户确认（showConfirmEx，信任根）。
// 频控：仅同键去重——会话内同 Type.member 一次（闭包 Set，拒绝发生在
// 预审后/审核前——不重复消耗审核与确认）；无总量上限。
// 返回形态对齐 scriptTools（{success, result: JSON.stringify({status,...})}）。
// 审核员 fail-closed 三连（红线 ⑤）：未注入/请求失败/解析失败均拒绝提议——
// 工具不可用而非降级直落（无审核 = 无落表）。
(function (global) {
    'use strict';

    var _deps = null; // { reviewTableProposal }（测试注入位；生产走全局解析）

    function initTableTools(deps) {
        _deps = deps || null;
    }

    // 审核员解析：注入优先，全局回退（bootstrap 暴露 AEEngine.reviewTableProposal
    // ——reviewAeTool 同款 settings/apiKey 解析管道，共用配置）
    function _resolveReviewer() {
        if (_deps && typeof _deps.reviewTableProposal === 'function') return _deps.reviewTableProposal;
        if (global.AEEngine && typeof global.AEEngine.reviewTableProposal === 'function') {
            return global.AEEngine.reviewTableProposal;
        }
        return null;
    }

    // 会话同键去重（handler 实例生命周期 = 会话）
    // handler 由 controller 在工具注册期构建一次并跨会话复用（controller.js
    // buildProposeTableEntryHandler），模块级 _proposed 因此跨会话残留——换会话后
    // 「同键可重新提议」的回执（见下方拒绝文案）不成立。由 controller 在
    // switchSession/新建会话处与 permissionPolicy.resetSession 同点调 resetSession()
    var _proposed = {};

    // 会话边界重置（controller.switchSession/新建会话调用；清空同键去重表）
    function resetSession() {
        _proposed = {};
    }

    function _ret(ok, status, message) {
        return { success: ok, result: JSON.stringify({ status: status, message: message }) };
    }

    // ── 决策层：什么该问用户、什么可以直接落 ────────
    // 前提：用户看不懂类型系统/API 是否真实，把技术判断推给他是无效防线。于是：
    //   · 只读标量属性（返回 string/number/boolean，非能力域、非改写、非造类型）
    //     → 自动收录：最坏结果是脚本读到一个不存在的成员而报错，不需要人判断。
    //   · 其余（改工程的方法/可写属性、碰文件/系统、改写既有判定、新增类型）
    //     → 仍然弹确认：这些问的是「要不要给这个能力」，用户答得了。
    // 硬拒族更早一步就被预审拒掉，不进入本层。
    var _SAFE_AUTO_RET = /^(string|number|boolean)(\|(string|number|boolean))*$/;
    function isAutoAcceptable(pc, a) {
        if (!pc || pc.ok !== true) return false;
        if (pc.domain) return false;                       // 能力域（文件/系统/菜单）
        if (pc.kind === 'override' || pc.kind === 'newType') return false;
        if (a.isMethod === true || a.writable === true) return false;
        return _SAFE_AUTO_RET.test(String(a.returnType || '').replace(/\s+/g, ''));
    }

    // control（可选，controller 注册时注入）：{ getAbortSignal, getStopRequested }
    // 本工具在工具循环内执行，停止检查在工具返回之后——审核请求若不绑
    // 运行轮 signal，用户停止后它仍会跑到超时（requestTimeoutMs），且通过后仍弹
    // 确认框。getAbortSignal/getStopRequested 惰性读取 controller 闭包状态
    // （对照 toolExecutionPipeline 的审查路径 opts.getActiveAbortController）。
    // 两个 getter 都接受 handler 第二参（execCtx）——工具注册表只有一份且
    // last-wins ⇒ 本 handler 可能由另一条 runtime（团队 lane / 子 Agent）注册，闭包里的
    // 停止判据不是本次执行者的；controller 注入的实现据此优先取 execCtx 判据
    //（见 engine/controller.js 的 stopRequestedForCtx）。旧注入忽略多出的实参，行为不变。
    function buildProposeTableEntryHandler(control) {
        control = control || {};
        var _getSignal = typeof control.getAbortSignal === 'function' ? control.getAbortSignal : null;
        var _getStopRequested = typeof control.getStopRequested === 'function' ? control.getStopRequested : null;
        function _stopped(execCtx) {
            if (_getStopRequested && _getStopRequested(execCtx)) return true;
            var sig = _getSignal ? _getSignal(execCtx) : null;
            return !!(sig && sig.aborted);
        }
        return function (args, execCtx) {
            var a = args || {};
            var UT = global.AEGate && global.AEGate.userTable;
            if (!UT || typeof UT.precheck !== 'function') {
                return Promise.resolve(_ret(false, 'error', 'AST 门增补层未就绪（ast-gate/userTable.js 未加载），无法提议'));
            }
            // ① 机械预审（三档 + 类型伪造 + 出处强制）
            var pc = UT.precheck(a);
            if (!pc.ok) return Promise.resolve(_ret(false, 'rejected', pc.message));
            var key = a.typeName + '.' + a.memberName;
            if (_proposed[key]) {
                return Promise.resolve(_ret(false, 'rejected', '「' + key + '」本会话已提议过（无论成败不重复提议——如需重新提议请换会话或经管理面删除既有条目）'));
            }
            _proposed[key] = 1;
            // ② 审核员 LLM（fail-closed：未注入/失败/判 false 均拒）
            var reviewer = _resolveReviewer();
            if (!reviewer) {
                return Promise.resolve(_ret(false, 'error', '补表审查员未就绪（reviewTableProposal 未注入），拒绝提议以保安全'));
            }
            var reviewP;
            try {
                reviewP = reviewer({
                    typeName: a.typeName, memberName: a.memberName, returnType: a.returnType,
                    isMethod: a.isMethod === true, writable: a.writable === true,
                    // 新增类型/改写既有条目——审核员需要知道这不是普通加成员
                    newType: a.newType === true, override: a.override === true,
                    sourceUrl: a.sourceUrl, reason: a.reason,
                    // 绑定运行轮 signal——停止时审核请求随之中止（不再跑到超时）
                    signal: _getSignal ? _getSignal(execCtx) : null
                });
            } catch (e) {
                return Promise.resolve(_ret(false, 'error', '审查员调用异常: ' + (e && e.message ? e.message : String(e))));
            }
            return Promise.resolve(reviewP).then(function (review) {
                // 弹确认框前复查停止——审核请求在途期间用户已点停止时，
                // 不得再弹确认框（按停止语义返回，与 requestStop 口径一致）
                if (_stopped(execCtx)) {
                    return _ret(false, 'stopped', '已停止。');
                }
                if (!review || review.valid !== true) {
                    var errs = (review && review.errors && review.errors.length)
                        ? review.errors.map(function (x) { return x.message; }).join('; ') : '审查未通过';
                    return _ret(false, 'rejected', '审核员拒绝该提议: ' + errs);
                }
                // 低风险面直接落表（不弹窗）——用户看不懂 API 真伪，这类不需要他判断。
                // 自动路径还须尊重审查员意见——high 风险或带警示时
                // 回落确认框。自动化的前提是「没人需要判断」，不是「跳过审查结论」。
                if (isAutoAcceptable(pc, a) && review.riskLevel !== 'high'
                    && !(review.warnings && review.warnings.length)) {
                    return UT.add(a, { reviewed: true }).then(function (addR) {
                        if (!addR.ok) return _ret(false, 'error', addR.message);
                        return _ret(true, 'ok', '已自动收录 ' + key
                            + '（只读标量属性、不接触文件/系统，无需逐条确认），立即生效。请重新执行原代码。'
                            + '如需撤销：Agent 模块设置 > AST 门能力配置。');
                    });
                }
                // ③ 用户确认（信任根——结构化信息非话术：签名 + 域 + 风险摘要 + 出处）
                var domLine = pc.domain
                    ? AEI18n.t('能力域标记: {domain}（收录≠无条件放行——域关时仍拒）', { domain: pc.domain })
                    : AEI18n.t('能力域标记: 无（自由收录）');
                var warnLine = (review.warnings && review.warnings.length)
                    ? AEI18n.t('审查警示: {list}', { list: review.warnings.map(function (x) { return x.message; }).join('; ') })
                    : AEI18n.t('审查风险: {level}', { level: review.riskLevel || 'low' });
                var entryLine = a.typeName + '.' + a.memberName + ' → ' + a.returnType
                    + (a.isMethod ? AEI18n.t('（方法）') : AEI18n.t('（属性）'))
                    + (a.writable ? AEI18n.t('，可写') : AEI18n.t('，只读'));
                var msg = AEI18n.t('提议向 AST 门白名单增补成员:\n\n条目: {entry}\n{domainLine}\n{warnLine}\n官方文档出处: {sourceUrl}\n用途说明: {reason}\n\n确认后立即生效（后续代码可直接使用该成员；可在「Agent 模块设置 > AST 门能力配置」管理面删除）。', {
                    entry: entryLine,
                    domainLine: domLine,
                    warnLine: warnLine,
                    sourceUrl: a.sourceUrl,
                    reason: a.reason || ''
                });
                var confirmTitle = AEI18n.t('补表提议确认');
                var confirmP = (typeof global.showConfirmEx === 'function')
                    ? global.showConfirmEx(confirmTitle, msg, 'confirm')
                    : (typeof global.showConfirm === 'function')
                        ? global.showConfirm(confirmTitle, msg)
                        : Promise.resolve(false); // 无弹窗环境 = 拒（fail-closed）
                return confirmP.then(function (r) {
                    var ok = (r && typeof r === 'object') ? r.ok : r;
                    // 取消回执带上弹窗里给用户看的那行风险信息（同一条 warnLine）——
                    // 用户是在"看到警示"的前提下否决的，只回一句「用户取消」LLM 无从知道
                    // 该往哪改（补出处？收紧用途？换成员？），只能原样重提
                    if (!ok) {
                        return _ret(false, 'rejected', '用户取消了本次补表提议（未落表）。' + warnLine
                            + '。如仍需该成员，请先处理上述风险点（例如补充可核验的官方文档出处、收紧用途说明），再重新提议。');
                    }
                    // ④ 落表 + 即时生效
                    return UT.add(a, { reviewed: true }).then(function (addR) {
                        if (!addR.ok) return _ret(false, 'error', addR.message);
                        return _ret(true, 'ok', '已收录 ' + key + (addR.domain ? '（file 域管辖——域关时仍拒）' : '') + '，立即生效。请重新执行原代码。');
                    });
                });
            }, function (e) {
                return _ret(false, 'error', '审查员请求失败: ' + (e && e.message ? e.message : String(e)));
            });
        };
    }

    global.AEAgentTableTools = {
        initTableTools: initTableTools,
        buildProposeTableEntryHandler: buildProposeTableEntryHandler,
        resetSession: resetSession
    };
})(typeof window !== 'undefined' ? window : globalThis);
