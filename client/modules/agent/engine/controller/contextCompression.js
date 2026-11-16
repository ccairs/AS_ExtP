(function (global) {
    'use strict';
    // 上下文压缩/消息编辑辅助层拆分。由 controller.js 组装区经 AEEngine.createContextCompression() 创建。
    // 纯迁移自 controller.js 内联的 _cmIndexForStateIndex / _notifyMsg /
    // _persistAndRerenderAfterTruncation / _clipText / _matchAnyTerm / _foldArchiveMessage。
    // 函数名去 _ 前缀（controller.js 调用点同步改）。
    // opts 注入（对应 controller.js createController 作用域闭包变量）：
    //   state：编辑/截断相关函数读取 state.messages
    //   showStatus：notifyMsg 走 opts.showStatus 提示（可能为 undefined，运行时判空）
    //   chatViewHelpers：getActiveStore/getActiveCm/syncView
    //   getInjectQueue：返回 _injectQueue 数组（持久化截断后原地清空，可变状态经惰性 getter 注入）
    //   view：resetRenderedCount/clearStreaming
    function createContextCompression(opts) {
        // state.messages 下标 → contextManager 消息下标换算。
        // state.messages 与 contextManager 保持 1:1 镜像（工具循环/本地消息均已对齐），
        // 例外一：_local 本地消息（/help 等，仅 UI 展示，不进 contextManager），换算时跳过；
        // 例外二：cm 的 pruneByTokens 溢出裁剪只删 cm 头部消息（UI 保留完整历史），
        // 二者头部错位 P 条（P = state 非 _local 数 - cm 数）。换算时扣除该偏移，
        // 否则编辑/重生成会 updateMessage/truncateFrom 到错误的 cm 消息（数据错位损坏）。
        function cmIndexForStateIndex(stateIdx) {
            var cmCount = opts.chatViewHelpers.getActiveCm().list().length;
            var nonLocal = 0;
            for (var n = 0; n < opts.state.messages.length; n++) {
                if (!opts.state.messages[n]._local) nonLocal++;
            }
            var offset = Math.max(0, nonLocal - cmCount);
            var cmIdx = -1;
            for (var k = 0; k <= stateIdx && k < opts.state.messages.length; k++) {
                if (!opts.state.messages[k]._local) cmIdx++;
            }
            return cmIdx - offset;
        }

        function notifyMsg(msg, type) {
            if (typeof opts.showStatus === 'function') {
                opts.showStatus(msg, type || 'info', { autoHideMs: 3000 });
            }
        }

        // 编辑/截断后把数据层对齐到同一真相（contextManager 为准）：
        // ① contextManager 消息数组 + token 统计（getTokenStats 实时重算，随更新/截断自动变化）
        //    —— updateMessage/truncateFrom 内部已同步消息数组（持久化由文件 sessionStore 承担）；
        // ② sessionStore 文件持久化（_doSave 同步更新 _index 的 messageCount/updatedAt；.tokens
        //    是使用量记录，与消息截断无关，不改写）——这里 save + flush 立即落盘；
        // ③ UI 全量重渲染（resetRenderedCount + syncView，token 用量环经 onStateChange 刷新）。
        function persistAndRerenderAfterTruncation() {
            var store = opts.chatViewHelpers.getActiveStore();
            var cm = opts.chatViewHelpers.getActiveCm();
            if (store && cm && typeof store.save === 'function') {
                store.save(cm.getSessionId(), cm.list());
                if (typeof store.flush === 'function') store.flush();
            }
            opts.getInjectQueue().length = 0;
            if (opts.view && typeof opts.view.resetRenderedCount === 'function') opts.view.resetRenderedCount();
            if (opts.view && typeof opts.view.clearStreaming === 'function') opts.view.clearStreaming();
            // 这次已是全量重建（按当前 debug 态重绘），调试开关登记的那次待重建随之作废——
            // 不清掉的话，下一条合格 syncView 会再整表重建一次（还把列表强拉到底）。
            // 本路径是"重建时列表里仍有活元素（编辑框）"的情形：chatViewHelpers 的闸门挡下消费，
            // 所以这里必须显式清。
            if (opts.state) opts.state.debugRebuildPending = false;
            opts.chatViewHelpers.syncView();
        }

        function clipText(s, n) {
            s = String(s || '').trim();
            if (s.length > n) return s.slice(0, n) + '...';
            return s;
        }

        function matchAnyTerm(text, terms) {
            var low = String(text || '').toLowerCase();
            for (var i = 0; i < terms.length; i++) {
                if (terms[i] && low.indexOf(terms[i]) !== -1) return true;
            }
            return false;
        }

        // 归档消息折叠为 LLM 可读文本：工具组折叠为 "[工具调用] name(args)"，
        // 与 foldOldToolGroups 的摘要形态一致；每条消息限制长度防 token 爆涨。
        function foldArchiveMessage(m) {
            if (!m) return '';
            var role = m.role || 'assistant';
            var parts = [];
            if (role === 'user') {
                // 剥离 <context> 动态上下文前缀（与 view 的 stripContextBlock 一致）：
                // 前缀含时间/AE snapshot，对回看历史无价值，不剥则 500 字符截断后
                // 正文可能被前缀整段挤光
                var ut = clipText(String(m.text || '').replace(/^<context>[\s\S]*?<\/context>\s*\n*/, ''), 500);
                if (ut) parts.push('用户: ' + ut);
                var imgs = (m.images || []).filter(function (p) { return typeof p === 'string' && p.indexOf('data:') !== 0; });
                if (imgs.length) {
                    // 附件路径按「发出去时可消费」的绝对形态给出：
                    // 归档里存的仍是相对路径，这里只在折叠输出时转当前数据目录绝对路径，
                    // 使 read_early_history 的结果可直接用于 ComfyUI 的 file_path。
                    var _absOf = (global.AEEngine && typeof global.AEEngine.absAttachmentPath === 'function')
                        ? global.AEEngine.absAttachmentPath
                        : function (p) { return p; };
                    var _imgsAbs = [];
                    for (var ii = 0; ii < imgs.length; ii++) _imgsAbs.push(_absOf(imgs[ii]));
                    parts.push('  [附件图片] ' + _imgsAbs.join(', '));
                }
                var vids = (m.videos || []).filter(function (p) { return typeof p === 'string' && p.indexOf('data:') !== 0; });
                if (vids.length) parts.push('  [附件视频] ' + vids.join(', '));
            } else if (role === 'assistant') {
                if (m.toolCalls && m.toolCalls.length) {
                    var calls = [];
                    for (var ci = 0; ci < m.toolCalls.length; ci++) {
                        var tc = m.toolCalls[ci];
                        // 兼容 OpenAI 结构 { function: { name, arguments } } 与扁平 { name, arguments }
                        var tcName = tc.name || (tc.function && tc.function.name) || 'unknown';
                        var tcArgs = tc.arguments !== undefined ? tc.arguments : (tc.function && tc.function.arguments);
                        var argsStr = tcArgs !== undefined ? JSON.stringify(tcArgs) : '';
                        if (argsStr.length > 200) argsStr = argsStr.slice(0, 200) + '...';
                        calls.push('[工具调用] ' + tcName + '(' + argsStr + ')');
                    }
                    if (calls.length) parts.push('助手: ' + calls.join(' '));
                }
                var at = clipText(m.text, 500);
                if (at) parts.push('助手: ' + at);
                // thinking-only 消息（仅 reasoningContent 无正文）：不折叠思考则整条
                // 变空串被 read_early_history 跳过，归档里该消息凭空消失。
                // 思考内容截短到 300——归档供回看决策脉络，非逐字复盘
                if (!at && m.reasoningContent) parts.push('助手: [思考] ' + clipText(m.reasoningContent, 300));
            } else if (role === 'tool') {
                var rt = clipText(m.text, 300);
                if (rt) parts.push('  → [' + (m.toolName || 'tool') + '] ' + rt);
            } else if (role === 'system-result') {
                var sv = clipText((m.visibleText || '') + (m.detailText ? '\n' + m.detailText : ''), 500);
                if (sv) parts.push('[系统结果] ' + sv);
            } else {
                var ot = clipText(m.text, 300);
                if (ot) parts.push(role + ': ' + ot);
            }
            return parts.join('\n');
        }

        return { cmIndexForStateIndex: cmIndexForStateIndex, notifyMsg: notifyMsg, persistAndRerenderAfterTruncation: persistAndRerenderAfterTruncation, clipText: clipText, matchAnyTerm: matchAnyTerm, foldArchiveMessage: foldArchiveMessage };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createContextCompression = createContextCompression;
})(typeof global !== 'undefined' ? global : window);