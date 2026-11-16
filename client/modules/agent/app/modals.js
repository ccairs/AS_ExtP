// Agent 模态对话框（showConfirm / showPrompt / showGateConfigModal——
// AST 门能力配置弹窗：通道信任 bypass×4 + 能力域 domains×4 + 危险脚本记忆管理）
// 从 app/main.js 拆出：
//   - statusState 经 AEAgentApp.statusBar.state 取引用（须在 statusBar.js 之后加载）
//   - showConfirm/showPrompt 保留 window 挂载（engine/bootstrap 等经 opts 注入、
//     main.js 内多处裸调用，且在 eslint 全局白名单中）
(function (global) {
    function _statusState() {
        return global.AEAgentApp && global.AEAgentApp.statusBar ? global.AEAgentApp.statusBar.state : null;
    }

    // showConfirm/showPrompt 共用同一 #confirmModal DOM 单例。并发调用时后弹者会
    // 覆盖先弹者的按钮 onclick 绑定，导致先弹的 Promise 永不 resolve（调用方永久
    // 挂起）。这里做队列化互斥（不丢操作）：busy 时把「弹窗请求参数 + resolve」
    // 封装成执行体入队，当前弹窗 settle 且 DOM 复位完成后（_modalSettled）再
    // shift 出队下一个执行，保证每个调用方最终都能拿到 resolve。
    var _modalQueue = [];
    var _modalBusy = false;

    function _modalEnqueue(run, onFail) {
        if (_modalBusy) {
            _modalQueue.push({ run: run, onFail: onFail });
            return;
        }
        _modalBusy = true;
        _modalSafeRun(run, onFail);
    }

    // 执行体异常只影响当次调用，不能让队列永久卡在 busy；同时在内部消化，
    // 不再向上 rethrow——rethrow 会经 Promise executor 变成 reject，而调用方
    // 普遍只挂 .then（无 .catch），产生 unhandled rejection 且半渲染的弹窗
    // （遮罩已显示、按钮未绑定）点击无反应。这里复位遮罩 DOM 并按取消语义
    // （confirm→false / prompt→null）收尾，队列继续出队
    function _modalSafeRun(run, onFail) {
        try {
            run();
        } catch (e) {
            try {
                var mask = document.getElementById('confirmModal');
                if (mask) {
                    mask.style.display = 'none';
                    mask.style.opacity = '0';
                    var modal = mask.querySelector('.modal');
                    if (modal) {
                        modal.classList.remove('danger-confirm');
                        modal.style.opacity = '0';
                        modal.style.transform = 'translateY(10px) scale(.98)';
                    }
                }
            } catch (_) {}
            _modalSettled();
            if (typeof onFail === 'function') onFail(e);
            console.error('[Agent] modal executor error:', e);
        }
    }

    // 当前弹窗 settle 且 DOM 复位完成后调用：出队下一个请求或解除 busy
    function _modalSettled() {
        if (_modalQueue.length > 0) {
            var next = _modalQueue.shift();
            _modalSafeRun(next.run, next.onFail);
            return;
        }
        _modalBusy = false;
    }

    function showConfirm(title, message, type) {
        return new Promise(function (resolve) {
            _modalEnqueue(function () {
                _runConfirm(title, message, type, resolve);
            }, function () { resolve(false); });
        });
    }

    // showConfirmEx（审计确认层）：带可选勾选框的确认弹窗。
    // opts.checkLabel —— 勾选框文案（如「此脚本不再提醒」）：
    //   有 checkLabel → resolve {ok:boolean, checked:boolean}（checked=关闭时勾选态）
    //   无 checkLabel → resolve boolean（与 showConfirm 完全同构）
    function showConfirmEx(title, message, type, opts) {
        return new Promise(function (resolve) {
            _modalEnqueue(function () {
                _runConfirm(title, message, type, resolve, opts);
            }, function () {
                resolve((opts && opts.checkLabel) ? { ok: false, checked: false } : false);
            });
        });
    }

    function _runConfirm(title, message, type, resolve, opts) {
        var checkLabel = opts && opts.checkLabel ? String(opts.checkLabel) : '';
        // 统一 type 枚举（对齐 toast 模式）：'confirm'(默认，普通黄色) | 'danger'(红色危险)。
        // 危险形态完全由 type 控制，通过叠加 danger-confirm 类切换红色背景/按钮/顶条 + danger 音效。
        // type 仅作枚举，音效与枚举解耦：danger→danger 音效，其余→soft 音效。
        var isDanger = type === 'danger';
        // showConfirm 内部 HTML 转义：转义 & < > "（引号防属性/事件注入）。
        // title/message 可能含外部数据（AE 脚本异常、文件名、工具名等），进 innerHTML 前必须转义。
        function _confirmEscape(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }
        if (typeof aeBeep === 'function') aeBeep(isDanger ? 'danger' : 'warn');
            const mask = document.getElementById('confirmModal');
            const titleEl = document.getElementById('confirmTitle');
            const messageEl = document.getElementById('confirmMessage');
            const cancelBtn = document.getElementById('confirmCancelBtn');
            const okBtn = document.getElementById('confirmOkBtn');

            if (_statusState() && _statusState().debugMode) {
                showStatus(AEI18n.t('[弹窗] showConfirm: title="{title}", elements:{elements}', {
                    title: title,
                    elements: String(!!mask && !!titleEl && !!messageEl && !!cancelBtn && !!okBtn)
                }), 'info', { showAnyway: true });
            }

            if (!mask || !titleEl || !messageEl || !cancelBtn || !okBtn) {
                if (_statusState() && _statusState().debugMode) {
                    showStatus(AEI18n.t('[弹窗] 元素未找到，回退到原生confirm'), 'error', { showAnyway: true });
                }
                var natOk = confirm(message);
                // 原生 confirm 无勾选框形态——checked 恒 false（不记忆）
                resolve(checkLabel ? { ok: natOk, checked: false } : natOk);
                // 原生 confirm 同步返回，此处直接收尾（含出队下一个），否则 busy 永不解除
                _modalSettled();
                return;
            }

            // 危险形态由顶部 type 枚举决定（isDanger 已在函数顶部计算），不再用标题正则自动判断。
            // 图标优先级：danger(红色警示三角) > 标题含删除语义(红色删除图标，历史行为) > 黄色警告。
            // 删除语义按语言无关的关键词判定：zh 标题为「删除…」，en 标题为「Delete …」。
            var autoDeleteIcon = /删除|\bdelete\b/i.test(title);
            var redIcon = isDanger
                ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f85149" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
                : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f85149" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
            var useRed = isDanger || autoDeleteIcon;
            var iconSvg = useRed
                ? redIcon
                : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f0b429" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

            // Render title with icon box
            titleEl.innerHTML = '<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;flex-shrink:0;margin-right:8px;vertical-align:middle;' +
                (useRed
                    ? 'background:radial-gradient(circle at 30% 30%,rgba(218,54,51,0.18),rgba(218,54,51,0.05));box-shadow:0 0 10px rgba(218,54,51,0.08)'
                    : 'background:radial-gradient(circle at 30% 30%,rgba(240,180,41,0.18),rgba(240,180,41,0.05));box-shadow:0 0 10px rgba(240,180,41,0.08)')
                + '">' + iconSvg + '</span><span>' + _confirmEscape(title) + '</span>';

            // Render message with filename highlighting (「...」→ code style, （...）→ code style)
            // 安全：title/message 先 HTML 转义（含引号），再做「」/（）包裹。
            // message 可能含 AE 脚本返回的异常字符串（service.js 沙箱拦截反射），未转义进 innerHTML = 反射型 XSS。
            // danger 模式用红色高亮（强化警示），普通模式用暗色 code。
            var msgCodeStyle = isDanger
                ? 'color:#f85149;background:rgba(248,81,73,.08)'
                : 'color:#e6edf3;background:#21262d';
            var msgHtml = _confirmEscape(message)
                .replace(/「([^」]+)」/g, '<code style="' + msgCodeStyle + ';padding:1px 6px;border-radius:3px;font-size:12px;font-weight:500">$1</code>')
                .replace(/（([^）]+)）/g, '<code style="' + msgCodeStyle + ';padding:1px 6px;border-radius:3px;font-size:12px;font-weight:500">$1</code>');
            messageEl.innerHTML = msgHtml;

            // 勾选框行（checkLabel 存在时， 审计确认层）：DOM 创建
            //（checkLabel 为模块内静态文案，无注入面；勾选态在 finish 读取）。
            // 下一次弹窗重写 messageEl.innerHTML 时自然销毁，无需显式清理
            var checkEl = null;
            if (checkLabel) {
                var checkRow = document.createElement('label');
                checkRow.style.cssText = 'display:flex;align-items:center;gap:7px;margin-top:12px;cursor:pointer;font-size:12px;color:#8b949e;user-select:none;';
                checkEl = document.createElement('input');
                checkEl.type = 'checkbox';
                // 不设 accent-color：清理时漏掉的一处——
                // assets.css 的注释写明「不要再加回该属性」（CEP 11 = Chromium 88 不支持，
                // 留着等于埋一个「换宿主就改外观」的开关），且内联样式对 audit:theme 不可见。
                checkEl.style.cssText = 'cursor:pointer;margin:0;';
                checkRow.appendChild(checkEl);
                checkRow.appendChild(document.createTextNode(checkLabel));
                messageEl.appendChild(checkRow);
            }

            // Hint text for delete actions
            var hintEl = document.getElementById('confirmHint');
            if (isDanger) {
                if (!hintEl) {
                    hintEl = document.createElement('span');
                    hintEl.id = 'confirmHint';
                    hintEl.style.cssText = 'font-size:10px;color:#f85149;opacity:0.7;display:flex;align-items:center;gap:4px;margin-right:auto;';
                    var btnRow = mask.querySelector('.btn-row');
                    if (btnRow) btnRow.insertBefore(hintEl, btnRow.firstChild);
                }
                hintEl.innerHTML = AEI18n.html('<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> 不可恢复');
                hintEl.style.display = 'flex';
            } else if (hintEl) {
                hintEl.style.display = 'none';
            }

            // danger 模式：确认按钮文案改为"我已知晓，继续"（复原在 cleanup）
            if (isDanger) okBtn.textContent = AEI18n.t('我已知晓，继续');

            mask.style.display = 'flex';
            requestAnimationFrame(() => {
                mask.style.opacity = '1';
                const modal = mask.querySelector('.modal');
                if (modal) {
                    // 危险枚举：叠加 danger-confirm 类切换红色背景/按钮/顶条
                    modal.classList.toggle('danger-confirm', isDanger);
                    modal.style.opacity = '1';
                    modal.style.transform = 'translateY(0) scale(1)';
                }
            });

            var onKey = function (e) { if (e.key === 'Escape' || e.keyCode === 27) { finish(false); } };

            var cleanup = function () {
                cancelBtn.onclick = null;
                okBtn.onclick = null;
                document.removeEventListener('keydown', onKey);
                mask.style.display = 'none';
                mask.style.opacity = '0';
                var modal = mask.querySelector('.modal');
                if (modal) {
                    // 复原危险枚举类与按钮文案，避免影响后续普通 showConfirm
                    modal.classList.remove('danger-confirm');
                    if (isDanger) okBtn.textContent = AEI18n.t('确定');
                    modal.style.opacity = '0';
                    modal.style.transform = 'translateY(10px) scale(.98)';
                }
            };

            // 统一收尾：Escape / 取消 / 确认三条关闭路径都经 finish 完成
            // settle + DOM 复位 + 出队下一个（下一个弹窗必须等 DOM 复位完成后再上）
            var finish = function (value) {
                cleanup();
                resolve(checkLabel ? { ok: value, checked: !!(checkEl && checkEl.checked) } : value);
                _modalSettled();
            };

            cancelBtn.onclick = function () { finish(false); };
            okBtn.onclick = function () { finish(true); };
            document.addEventListener('keydown', onKey);
    }

    // 打开输入弹窗并返回 Promise<string|null>
    function showPrompt(title, defaultValue) {
        return new Promise(function (resolve) {
            _modalEnqueue(function () {
                _runPrompt(title, defaultValue, resolve);
            }, function () { resolve(null); });
        });
    }

    function _runPrompt(title, defaultValue, resolve) {
            const mask = document.getElementById('confirmModal');
            const titleEl = document.getElementById('confirmTitle');
            const messageEl = document.getElementById('confirmMessage');
            const cancelBtn = document.getElementById('confirmCancelBtn');
            const okBtn = document.getElementById('confirmOkBtn');

            if (_statusState() && _statusState().debugMode) {
                showStatus(AEI18n.t('[弹窗] showPrompt: title="{title}", elements:{elements}', {
                    title: title,
                    elements: String(!!mask && !!titleEl && !!messageEl && !!cancelBtn && !!okBtn)
                }), 'info', { showAnyway: true });
            }

            if (!mask || !titleEl || !messageEl || !cancelBtn || !okBtn) {
                if (_statusState() && _statusState().debugMode) {
                    showStatus(AEI18n.t('[弹窗] 元素未找到，回退到原生prompt'), 'error', { showAnyway: true });
                }
                resolve(prompt(title, defaultValue));
                // 原生 prompt 同步返回，此处直接收尾（含出队下一个），否则 busy 永不解除
                _modalSettled();
                return;
            }

            titleEl.textContent = title;
            // 上一次 danger confirm 残留的「不可恢复」提示（hintEl 常驻 btn-row，
            // showConfirm 的 cleanup 不隐藏它）不能出现在输入弹窗中
            var hintEl = document.getElementById('confirmHint');
            if (hintEl) hintEl.style.display = 'none';
            // 用 DOM 创建 textarea 避免 innerHTML 注入，defaultValue 走 .value 无需转义
            var ta = document.createElement('textarea');
            ta.id = 'promptInput';
            ta.className = 'text-input';
            ta.rows = 5;
            ta.style.cssText = 'width:100%;resize:vertical';
            ta.value = defaultValue || '';
            messageEl.innerHTML = '';
            messageEl.appendChild(ta);
            mask.style.display = 'flex';
            requestAnimationFrame(() => {
                mask.style.opacity = '1';
                const modal = mask.querySelector('.modal');
                if (modal) {
                    modal.style.opacity = '1';
                    modal.style.transform = 'translateY(0) scale(1)';
                }
            });

            const input = document.getElementById('promptInput');
            if (input) {
                input.focus();
                input.select();
            }

            var onKey2 = function (e) { if (e.key === 'Escape' || e.keyCode === 27) { finish(null); } };

            var cleanup = function () {
                cancelBtn.onclick = null;
                okBtn.onclick = null;
                document.removeEventListener('keydown', onKey2);
                mask.style.display = 'none';
                mask.style.opacity = '0';
                var modal = mask.querySelector('.modal');
                if (modal) {
                    modal.style.opacity = '0';
                    modal.style.transform = 'translateY(10px) scale(.98)';
                }
            };

            // 统一收尾：Escape / 取消 / 确认三条关闭路径都经 finish 完成
            // settle + DOM 复位 + 出队下一个（下一个弹窗必须等 DOM 复位完成后再上）
            var finish = function (value) {
                cleanup();
                resolve(value);
                _modalSettled();
            };

            cancelBtn.onclick = function () { finish(null); };
            okBtn.onclick = function () {
                var value = input ? input.value : null;
                finish(value);
            };
            document.addEventListener('keydown', onKey2);
    }

    // showGateConfigModal：AST 门能力配置弹窗
    // 两组（ae-settings-card）：通道信任（bypass×4）+ 能力域（domains×4）+
    // 已确认危险脚本（scriptDangerMemory 管理面）+ 白名单增补表。
    // 勾选只改暂存值，点「保存」才一次性落盘（读-改-写全量替换语义）；
    // ×/Esc/取消 = 丢弃。agent-tool/llm-preview 通道开启前与能力域开启前弹
    // 确认（跑的是 LLM 生成代码，信任风险高于用户自建脚本——免打扰不是
    // 免检）；ae-tool/user-library 从轻不弹。bypass 语义如实陈述：门校验照跑，
    // 敏感路径黑名单与硬拒原语仍拦。文案：面向非技术用户的大白话。
    // hint 读时才翻译：本文件会整份加载进无 AEI18n 的沙箱，顶层求值会抛 ReferenceError
    var GATE_SOURCES = [
        { key: 'agent-tool', get name() { return AEI18n.t('Agent 工具'); }, get hint() { return AEI18n.t('Agent 模式与外接模式下 LLM 生成并执行的自定义代码（主要操作通道）'); } },
        { key: 'llm-preview', get name() { return AEI18n.t('LLM 预览区'); }, get hint() { return AEI18n.t('跑的是 LLM 生成代码，信任风险高于用户自建脚本'); } },
        { key: 'ae-tool', get name() { return AEI18n.t('自定义工具'); }, get hint() { return AEI18n.t('你/AI 创建或安装的工具'); } },
        { key: 'user-library', get name() { return AEI18n.t('脚本库'); }, get hint() { return AEI18n.t('你或 AI 保存至脚本库的脚本'); } }
    ];
    // can / extraHint 同样是读时才翻译：能力域说明拼进设置行与开启确认的正文，
    // 顶层求值会在无 AEI18n 的沙箱抛 ReferenceError。
    var GATE_DOMAINS = [
        { key: 'system', get name() { return AEI18n.t('运行系统指令'); }, get can() { return AEI18n.t('调用系统命令行、启动外部程序'); }, get extraHint() { return ''; } },
        { key: 'socket', get name() { return AEI18n.t('联网'); }, get can() { return AEI18n.t('连接网络、收发数据'); }, get extraHint() { return ''; } },
        { key: 'file', get name() { return AEI18n.t('读写文件'); }, get can() { return AEI18n.t('读取和写入电脑文件'); }, get extraHint() { return AEI18n.t('；系统关键位置仍受保护'); } },
        { key: 'menu', get name() { return AEI18n.t('点击菜单'); }, get can() { return AEI18n.t('自动执行 AE 菜单栏命令'); }, get extraHint() { return ''; } }
    ];
    // 描述/警告文案在调用点求值：顶层求值会在无 AEI18n 的沙箱抛 ReferenceError（同 GATE_SOURCES）。
    function _gateBypassDesc() {
        return AEI18n.t('默认情况下，AI 生成的脚本每次运行前都会先询问你。勾选某一项 = 提前授权这一类脚本：以后直接运行，不再逐次询问，并自动放开全部权限。');
    }
    function _gateBypassWarn() {
        return AEI18n.t('开启后，AI 写的这类脚本会直接运行，不再每次先征求你的同意，并自动拥有全部权限（运行系统命令、联网、读写文件等）。\n\n万一 AI 写出有问题的代码，也可能在你不知情时运行。只有充分信任当前使用的 AI 模型时才建议开启。\n\n最危险的写法和系统关键位置仍会被强制拦截，但不应依赖这层保护。');
    }
    // 开启能力域的确认正文在调用点内联（能力域名与能力说明作为参数代入），
    // 不在这里拼字符串：拼好的串不再是字面量，抽 key 与覆盖率都看不到它。

    function showGateConfigModal() {
        var existing = document.getElementById('gateConfigModal');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

        var gateCfg = global.AEGate && global.AEGate.config;
        var cfg = gateCfg ? gateCfg.read()
            : { bypass: {}, domains: {} };

        function toggleRow(id, name, hint, checked) {
            return '<div class="ae-settings-toggle-row">'
                + '<div class="ae-settings-toggle-info">'
                + '<span class="ae-settings-toggle-label">' + name + '</span>'
                + '<span class="ae-settings-toggle-hint">' + hint + '</span>'
                + '</div>'
                + '<label class="toggle-wrap">'
                + '<input type="checkbox" id="' + id + '" class="switch-input"' + (checked ? ' checked' : '') + '>'
                + '<span class="switch-slider" aria-hidden="true"></span>'
                + '</label>'
                + '</div>';
        }
        function domainRow(d, checked) {
            return '<div class="ae-settings-toggle-row">'
                + '<div class="ae-settings-toggle-info">'
                + '<span class="ae-settings-toggle-label">' + d.name + '</span>'
                + '<span class="ae-settings-toggle-hint"><span id="gateDomainState-' + d.key + '">'
                + (checked ? AEI18n.t('已开启') : AEI18n.t('默认关')) + '</span> · ' + AEI18n.t('允许脚本') + d.can + d.extraHint + '</span>'
                + '</div>'
                + '<label class="toggle-wrap">'
                + '<input type="checkbox" id="gateDomain-' + d.key + '" class="switch-input"' + (checked ? ' checked' : '') + '>'
                + '<span class="switch-slider" aria-hidden="true"></span>'
                + '</label>'
                + '</div>';
        }

        // 卡片壳（details/summary 点击展开——原生交互）：配置两组（通道信任/能力域）
        // 默认展开，管理两组（记忆/增补表）默认收起——首屏不超高，长列表按需展开
        function cardHead(icon, title, open) {
            return '<details class="ae-settings-card"' + (open ? ' open' : '') + '>'
                + '<summary class="ae-settings-card-head"><span class="ae-settings-card-icon">' + icon + '</span>'
                + '<div class="ae-settings-card-title">' + title + '</div>'
                + '<span class="ae-settings-card-arrow" aria-hidden="true"></span></summary>'
                + '<div class="ae-settings-card-body">';
        }

        var html = AEI18n.html('<div class="modal-head"><span>AST 门能力配置</span><button class="icon-btn" id="gateConfigCloseBtn">关闭</button></div>')
            + '<div class="modal-body ae-scrollbar">'

            // ── 组一：通道信任（bypass）——默认全关 ──
            + cardHead('🔓', AEI18n.t('通道信任'), true)
            + '<p class="ae-settings-card-desc">' + _gateBypassDesc() + '</p>';
        for (var i = 0; i < GATE_SOURCES.length; i++) {
            var src = GATE_SOURCES[i];
            html += toggleRow('gateBypass-' + src.key, src.name, src.hint,
                !!(cfg.bypass && cfg.bypass[src.key] === true));
        }
        html += '</div></details>'

            // ── 组二：能力域（正常通道的受控放行）──
            + cardHead('🛡️', AEI18n.t('能力域（受控放行）'), true)
            + AEI18n.html('<p class="ae-settings-card-desc">开关某类权限：开启的权限对所有脚本放行（运行时仍会弹窗')
            + AEI18n.html('确认与安全校验）；上方通道信任已开启的脚本自动拥有全部权限，不走本组开关。</p>');
        for (var j = 0; j < GATE_DOMAINS.length; j++) {
            var dom = GATE_DOMAINS[j];
            html += domainRow(dom, !!(cfg.domains && cfg.domains[dom.key] === true));
        }
        html += '</div></details>'

            // ── 组三：已确认危险脚本（记忆管理）──
            + cardHead('🧠', AEI18n.t('已确认危险脚本'), false)
            + AEI18n.html('<p class="ae-settings-card-desc">确认弹窗勾选过「此脚本不再提醒」的脚本（锚定内容哈希，')
            + AEI18n.html('脚本内容一变记忆即失效重新弹）。清除后这些脚本再次运行时会重新弹确认。</p>')
            + AEI18n.html('<div class="ae-cache-status-row"><span class="ae-cache-status-label">已确认条数</span>')
            + '<span id="gateMemoryCount">…</span></div>'
            + AEI18n.html('<div class="ae-settings-actions"><button class="btn" id="gateMemoryClearBtn">清除全部</button></div>')
            + '</div></details>'

            // ── 组四：白名单增补表（双层表管理——种子只读 ∪ 增补可增删回滚）──
            + cardHead('📋', AEI18n.t('白名单增补表'), false)
            + AEI18n.html('<p class="ae-settings-card-desc">经补表提议（propose_table_entry）确认收录的成员，即时生效。')
            + AEI18n.html('删除后该成员恢复默认拒绝；文件写语义成员收录时带 file 域标记（能力域关闭时仍拒）。</p>')
            + '<div id="gateUserTableList" class="gate-mem-list">…</div>'
            + '<div class="ae-settings-actions">'
            + AEI18n.html('<button class="btn secondary" id="gateUserTableClearBtn">清除全部（回滚到纯种子）</button>')
            // 三层收口：actions → 卡片 body → details（card-body 曾漏闭合，靠浏览器
            // 片段末尾自动补——底栏因此被兜进卡片/滚动容器内，随内容滚走）
            + '</div></div></details>'

            // modal-body 收口：底栏挂在 modal 根（body 之外）——body 是滚动容器
            // （overflow-y:auto），底栏在其外才能常驻弹窗底部，内容再长也不随滚动卷走
            + '</div>'

            // 底部按钮行：通道信任/能力域勾选暂存，「保存」才落盘
            + '<div class="gate-config-footer">'
            + AEI18n.html('<span id="gateConfigDirtyHint" class="gate-config-dirty-hint" hidden>有未保存的修改</span>')
            + '<div class="gate-config-footer-btns">'
            + AEI18n.html('<button class="btn secondary" id="gateConfigCancelBtn">取消</button>')
            + AEI18n.html('<button class="btn run" id="gateConfigSaveBtn">保存</button>')
            + '</div></div>';

        var overlay = document.createElement('div');
        overlay.className = 'modal-mask';
        overlay.id = 'gateConfigModal';
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
        overlay.style.zIndex = '110';

        var box = document.createElement('div');
        box.className = 'modal gate-config-modal';
        box.style.opacity = '1';
        box.style.transform = 'none';

        box.innerHTML = html;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        // 关闭：×按钮 / Esc（对齐 _showPersonaEditor 模式——监听随关闭移除防泄漏）
        var escHandler = function (e) {
            if (e.key === 'Escape' || e.keyCode === 27) {
                // 顶层确认弹窗在场时让位（其 onKey 收尾 finish(false)，若此处同时
                // close() 用户被整体踢出配置流程）。正向判定 === 'flex'：真实 DOM 中
                // confirmModal 初始由 CSS 隐藏（内联 style 为空串），负向 !== 'none'
                // 会吞掉首次 confirm 前 gate 弹窗的 Esc
                var cm = document.getElementById('confirmModal');
                if (cm && cm.style.display === 'flex') return;
                requestClose();
            }
        };
        function close() {
            document.removeEventListener('keydown', escHandler);
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }
        // 有未保存修改时先确认再关（防误触 ×/Esc/取消 静默丢修改）；pendingClose 防重入
        var pendingClose = false;
        function requestClose() {
            if (pendingClose) return;
            if (!isDirty()) { close(); return; }
            pendingClose = true;
            showConfirm(AEI18n.t('未保存的修改'), AEI18n.t('配置有未保存的修改，关闭后将丢弃。确定关闭吗？'), 'confirm').then(function (ok) {
                pendingClose = false;
                if (ok) close();
            });
        }
        var closeBtn = document.getElementById('gateConfigCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', requestClose);
        document.addEventListener('keydown', escHandler);

        // ── 暂存机制：勾选只改内存，点「保存」才一次性落盘 ──
        var draft = {
            bypass: {},
            domains: {}
        };
        for (var sk = 0; sk < GATE_SOURCES.length; sk++) {
            draft.bypass[GATE_SOURCES[sk].key] = !!(cfg.bypass && cfg.bypass[GATE_SOURCES[sk].key] === true);
        }
        for (var dk = 0; dk < GATE_DOMAINS.length; dk++) {
            draft.domains[GATE_DOMAINS[dk].key] = !!(cfg.domains && cfg.domains[GATE_DOMAINS[dk].key] === true);
        }
        var dirtyHintEl = document.getElementById('gateConfigDirtyHint');
        function isDirty() {
            for (var s2 = 0; s2 < GATE_SOURCES.length; s2++) {
                if (draft.bypass[GATE_SOURCES[s2].key] !== !!(cfg.bypass && cfg.bypass[GATE_SOURCES[s2].key] === true)) return true;
            }
            for (var d2 = 0; d2 < GATE_DOMAINS.length; d2++) {
                if (draft.domains[GATE_DOMAINS[d2].key] !== !!(cfg.domains && cfg.domains[GATE_DOMAINS[d2].key] === true)) return true;
            }
            return false;
        }
        function updateDirty() {
            if (dirtyHintEl) dirtyHintEl.hidden = !isDirty();
        }

        // 通道信任行：勾选只改暂存；agent-tool/llm-preview 开启前弹安全警告（确认后
        // 进暂存，取消回退勾选）；ae-tool/user-library 从轻不弹。关闭方向（收回信任）不弹。
        for (var bi = 0; bi < GATE_SOURCES.length; bi++) {
            (function (src) {
                var el = document.getElementById('gateBypass-' + src.key);
                if (!el) return;
                el.addEventListener('change', function () {
                    var on = el.checked;
                    if (on && (src.key === 'agent-tool' || src.key === 'llm-preview')) {
                        showConfirm(AEI18n.t('安全警告'), _gateBypassWarn(), 'confirm').then(function (ok) {
                            if (!ok) { el.checked = false; return; }
                            draft.bypass[src.key] = true;
                            updateDirty();
                        });
                        return;
                    }
                    draft.bypass[src.key] = on;
                    updateDirty();
                });
            })(GATE_SOURCES[bi]);
        }

        // 能力域行：开启方向弹 danger 确认（取消回退勾选），关闭方向不弹；
        // 勾选只改暂存 + 生效策略标记随动
        for (var di = 0; di < GATE_DOMAINS.length; di++) {
            (function (dom) {
                var el = document.getElementById('gateDomain-' + dom.key);
                if (!el) return;
                var stateEl = document.getElementById('gateDomainState-' + dom.key);
                el.addEventListener('change', function () {
                    var on = el.checked;
                    if (on) {
                        var warn = AEI18n.t('开启「{name}」后，脚本将可以{can}。\n\n这一设置对所有脚本生效，不只是当前这一个。', { name: dom.name, can: dom.can });
                        showConfirm(AEI18n.t('确认开启'), warn, 'danger').then(function (ok) {
                            if (!ok) { el.checked = false; return; }
                            draft.domains[dom.key] = true;
                            if (stateEl) stateEl.textContent = AEI18n.t('已开启');
                            updateDirty();
                        });
                        return;
                    }
                    draft.domains[dom.key] = false;
                    if (stateEl) stateEl.textContent = AEI18n.t('默认关');
                    updateDirty();
                });
            })(GATE_DOMAINS[di]);
        }

        // 保存：暂存 → 一次性落盘（AEGate.config.write 全量替换语义）+ Toast + 关闭
        var saveBtn = document.getElementById('gateConfigSaveBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', function () {
                if (gateCfg) {
                    var c = gateCfg.read();
                    c.bypass = draft.bypass;
                    c.domains = draft.domains;
                    // 消费落盘回执——setItem 失败若被吞，仍会弹「已保存」；用户若在
                    // 收回危险能力（关域/清 bypass），重启后会回到更宽松的旧配置而以为已保存
                    var _wr = (typeof gateCfg.writeEx === 'function') ? gateCfg.writeEx(c) : { ok: true, cfg: gateCfg.write(c) };
                    if (global.AEToast && _wr && _wr.ok === false) {
                        global.AEToast.show(AEI18n.t('AST 门配置已在本会话生效，但写入持久层失败（重启后回到旧配置），请重试保存'), 'warn');
                    } else if (global.AEToast) {
                        global.AEToast.show(AEI18n.t('AST 门配置已保存'), 'success');
                    }
                } else if (global.AEToast) {
                    global.AEToast.show(AEI18n.t('AST 门配置已保存'), 'success');
                }
                close();
            });
        }
        // 取消：丢弃暂存直接关闭（脏数据经 requestClose 确认）
        var cancelBtn = document.getElementById('gateConfigCancelBtn');
        if (cancelBtn) cancelBtn.addEventListener('click', requestClose);

        // 记忆管理：条数显示（listConfirmed）+ 清除全部（clearAll 后刷新）
        var mem = global.AE_LLM && global.AE_LLM._scriptDangerMemory;
        var countEl = document.getElementById('gateMemoryCount');
        var clearBtn = document.getElementById('gateMemoryClearBtn');
        function refreshCount() {
            if (!countEl || !mem || typeof mem.listConfirmed !== 'function') return;
            mem.listConfirmed().then(function (list) {
                countEl.textContent = (list ? list.length : 0) + AEI18n.t(' 条');
            }).catch(function () {});
        }
        if (!mem || typeof mem.listConfirmed !== 'function' || typeof mem.clearAll !== 'function') {
            // 记忆模块缺席容忍：无记忆 = 0 条，清除不可用
            if (countEl) countEl.textContent = AEI18n.t('0 条');
            if (clearBtn) clearBtn.disabled = true;
        } else {
            refreshCount();
            if (clearBtn) {
                clearBtn.addEventListener('click', function () {
                    var doClear = function () {
                        mem.clearAll().then(function (r) {
                            // clearAll 返回 {ok}——读失败/写盘失败时提示，不谎报清除成功
                            if (r && r.ok === false) {
                                if (global.AEToast) global.AEToast.error(AEI18n.t('清除失败：') + (r.message || AEI18n.t('记忆写盘失败')));
                                refreshCount();
                                return;
                            }
                            refreshCount();
                        }).catch(function () {});
                    };
                    // 清除全部记忆不可恢复（危险脚本会重新弹安全警告）——对齐同卡
                    // 「增补表 · 清除全部」的 showConfirm 写法。降级按仓库惯例：
                    // showConfirm 缺席（极老环境）不弹直接执行。
                    var confirmFn = (typeof global.showConfirm === 'function') ? global.showConfirm : null;
                    if (!confirmFn) { doClear(); return; }
                    confirmFn(AEI18n.t('确认清除'),
                        AEI18n.t('确定清除全部危险脚本确认记忆吗？清除后所有危险脚本会重新弹出安全警告，此操作不可恢复。'))
                        .then(function (ok) { if (ok) doClear(); });
                });
            }
        }

        // ──  增补表管理面：列表渲染 + 删除单条 + 清除全部（回滚纯种子）──
        var _ut = (global.AEGate && global.AEGate.userTable) || null;
        var _utEl = document.getElementById('gateUserTableList');
        if (_utEl && _ut && typeof _ut.getAdditions === 'function') {
            // 增补条目经 propose_table_entry 工具由 LLM 写入，tn/mn/e.t/e.d 均不可信
            // （直拼 innerHTML 构成 XSS，data-ut 属性位同样需引号转义；
            // getAttribute 返回解码值，删除回调仍拿到原始键名）
            var _utEsc = function (s) {
                return String(s == null ? '' : s)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            };
            // 三类用户态：新增类型 / 增补成员 / 改写既有条目。
            // 旧模块只有 getAdditions（v1）——回落成单一增补列表，行为同改前。
            var _utRow = function (main, meta, delAttr) {
                return '<div class="gate-mem-row"><span>' + main
                    + '</span><span class="gate-mem-meta">' + _utEsc(meta)
                    + '</span><button class="btn-link" ' + delAttr + '>' + AEI18n.t('删除') + '</button></div>';
            };
            var _renderUT = function (state) {
                var adds = (state && state.additions) ? state.additions : (state || {});
                var nts = (state && state.newTypes) ? state.newTypes : {};
                var ovs = (state && state.overrides) ? state.overrides : {};
                var rows = [];
                var tn, mn;
                for (tn in nts) {
                    if (!Object.prototype.hasOwnProperty.call(nts, tn)) continue;
                    rows.push(_utRow(AEI18n.t('[新增类型] ') + _utEsc(tn),
                        String((nts[tn] && nts[tn].createdAt) || '').slice(0, 10),
                        'data-utt="' + _utEsc(tn) + '"'));
                }
                for (tn in ovs) {
                    if (!Object.prototype.hasOwnProperty.call(ovs, tn)) continue;
                    for (mn in ovs[tn]) {
                        if (!Object.prototype.hasOwnProperty.call(ovs[tn], mn)) continue;
                        var oe = ovs[tn][mn];
                        rows.push(_utRow(AEI18n.t('[改写] ') + _utEsc(tn) + '.' + _utEsc(mn)
                            + ' → ' + _utEsc(oe && oe.t ? oe.t : '?'),
                            String((oe && oe.createdAt) || '').slice(0, 10),
                            'data-ut="' + _utEsc(tn) + '||' + _utEsc(mn) + '"'));
                    }
                }
                for (tn in adds) {
                    if (!Object.prototype.hasOwnProperty.call(adds, tn)) continue;
                    for (mn in adds[tn]) {
                        if (!Object.prototype.hasOwnProperty.call(adds[tn], mn)) continue;
                        var e = adds[tn][mn];
                        rows.push(_utRow(_utEsc(tn) + '.' + _utEsc(mn)
                            + ' → ' + _utEsc(e && e.t ? e.t : '?')
                            + (e && e.d ? AEI18n.t('（{domain} 域）', { domain: _utEsc(e.d) }) : ''),
                            String((e && e.createdAt) || '').slice(0, 10),
                            'data-ut="' + _utEsc(tn) + '||' + _utEsc(mn) + '"'));
                    }
                }
                _utEl.innerHTML = rows.length ? rows.join('') : AEI18n.html('<div class="gate-mem-empty">暂无增补条目</div>');
                // 分开取两组（类型行与成员行属性名不同）；NodeList 转数组以便拼接
                var _q = function (sel) {
                    if (!_utEl.querySelectorAll) return [];
                    return Array.prototype.slice.call(_utEl.querySelectorAll(sel) || []);
                };
                var btns = _q('[data-utt]').concat(_q('[data-ut]'));
                for (var bi = 0; bi < btns.length; bi++) {
                    (function (btn) {
                        btn.addEventListener('click', function () {
                            var utt = btn.getAttribute('data-utt');
                            if (utt) {
                                // 删除整个新增类型（连带其成员条目）
                                _ut.removeType(utt).then(function (r) {
                                    if (r && r.ok === false) {
                                        if (global.AEToast) global.AEToast.error(AEI18n.t('删除失败：') + (r.message || AEI18n.t('写盘失败')));
                                        return;
                                    }
                                    if (global.AEToast) global.AEToast.show(AEI18n.t('已删除新增类型 ') + utt, 'success');
                                    _refreshUT();
                                }).catch(function () {});
                                return;
                            }
                            var parts = btn.getAttribute('data-ut').split('||');
                            _ut.remove(parts[0], parts[1]).then(function (r) {
                                // remove 返回 {ok}——读失败/写盘失败时提示，不谎报已删除
                                if (r && r.ok === false) {
                                    if (global.AEToast) global.AEToast.error(AEI18n.t('删除失败：') + (r.message || AEI18n.t('写盘失败')));
                                    return;
                                }
                                if (global.AEToast) global.AEToast.show(AEI18n.t('已删除 ') + parts[0] + '.' + parts[1] + AEI18n.t('（恢复默认拒绝）'), 'success');
                                _refreshUT();
                            }).catch(function () {});
                        });
                    })(btns[bi]);
                }
            };
            var _refreshUT = function () {
                var p = (typeof _ut.getState === 'function')
                    ? _ut.getState() : _ut.getAdditions();
                p.then(_renderUT).catch(function () {
                    _utEl.innerHTML = AEI18n.html('<div class="gate-mem-empty">增补表读取失败</div>');
                });
            };
            _refreshUT();
            var _utClearBtn = document.getElementById('gateUserTableClearBtn');
            if (_utClearBtn && typeof _ut.clearAll === 'function') {
                _utClearBtn.addEventListener('click', function () {
                    showConfirm(AEI18n.t('确认清除'), AEI18n.t('确定删除全部增补条目并回滚到纯种子白名单吗？')).then(function (ok) {
                        if (!ok) return;
                        _ut.clearAll().then(function (r) {
                            // clearAll 返回 {ok}——失败时提示且不渲染成已清空
                            if (r && r.ok === false) {
                                if (global.AEToast) global.AEToast.error(AEI18n.t('清除失败：') + (r.message || AEI18n.t('写盘失败')));
                                return;
                            }
                            if (global.AEToast) global.AEToast.show(AEI18n.t('已回滚到纯种子白名单'), 'success');
                            _renderUT({});
                        }).catch(function () {});
                    });
                });
            }
        } else if (_utEl) {
            // 增补层缺席容忍（userTable.js 未载——旧沙箱/异常装载）：降级提示不炸
            _utEl.innerHTML = AEI18n.html('<div class="gate-mem-empty">增补层未加载（ast-gate/userTable.js）</div>');
        }
    }

    global.showConfirm = showConfirm;
    global.showConfirmEx = showConfirmEx;
    global.showPrompt = showPrompt;
    global.showGateConfigModal = showGateConfigModal;
    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.modals = { showConfirm, showConfirmEx, showPrompt, showGateConfigModal };
})(window);
