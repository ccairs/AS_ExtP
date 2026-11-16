// firstRunDisclaimer.js — 首次打开面板的 AI 免责声明闸门
//
// 本项目（面板 + 原生件 + 桥 + 文档）完全由 AI 编写，作者不承担
// 使用后果；故首次打开面板必须弹一个**阻隔**弹窗讲清楚，展示满 6 秒后，才允许在弹窗
// 底部输入框里输入**当前界面语言**对应的确认词放行（见 CONFIRM_WORDS）。确认过一次就不再弹。
// 弹窗顶部先给语言选择：落盘后整面板重载，闸门按新语言重建。
//
// 四条刻意设计（别顺手"优化"掉）：
//   1) 失败一律放行（fail-open）：DOM 缺失、document/localStorage 不可用等任何异常都不锁
//      死用户——免责声明弹窗弹不出来是小事，把人永久挡在产品外面更严重。故只有"完整拿到
//      弹窗 DOM 且未被确认过"才真正阻隔。
//   2) 倒计时按**挂钟**算（deadline = 开始时刻 + 6000ms），不按 tick 次数：面板被切到后台
//      时 CEF 会节流定时器，按 tick 计数会让用户枯等远不止 6 秒。
//   3) 没有任何关闭途径：不绑 Esc、不绑点遮罩关闭（modal 的其它弹窗都能关，这个是闸门）。
//   4) 焦点圈：.modal-mask 只挡鼠标不挡键盘——不拦 Tab 的话，用户在闸门里 Tab+Enter 就能
//      在背后操作面板（scopePicker 还会按"页面最高 z-index+1"开在闸门之上）。
(function (global) {
    'use strict';

    var ACCEPT_KEY = 'as_extp_ai_disclaimer_accepted';  // 值 = 确认时间 ISO 串（非空即视为已确认）
    var HOLD_MS = 6000;          // 阻隔时长：满 6 秒才解锁输入框
    // 确认词按界面语言取值：用户必须打出**当前语言**的写法（英文界面下打不出「我确认」）。
    // 提示句把它作为 {word} 参数传入，placeholder 与放行判定同源（confirmWord()）。
    var CONFIRM_WORDS = [
        { id: 'zh-CN', word: '我确认' },        // 源语言：与本地化前逐字节一致
        { id: 'en-US', word: 'I confirm' },
        { id: 'ja-JP', word: '確認します' },
        { id: 'de-DE', word: 'Ich bestätige' },
        { id: 'ko-KR', word: '확인합니다' },
        { id: 'fr-FR', word: 'Je confirme' },
        { id: 'ru-RU', word: 'Я подтверждаю' }
    ];
    var SOURCE_LOCALE = 'zh-CN';   // 未知 / 取不到语言时回落到这一档
    var MASK_ID = 'firstRunDisclaimerModal';
    var INPUT_ID = 'disclaimerInput';
    var BTN_ID = 'disclaimerConfirmBtn';
    var HINT_ID = 'disclaimerHint';
    var FILL_ID = 'disclaimerProgressFill';
    var LOCALE_ID = 'disclaimerLocale';
    var LOCALE_LABEL_ID = 'disclaimerLocaleLabel';
    // 选项文案是语言自称，任何界面语言下都不翻译
    var LOCALE_OPTIONS = [
        ['zh-CN', '简体中文'],
        ['en-US', 'English'],
        ['ja-JP', '日本語'],
        ['de-DE', 'Deutsch'],
        ['ko-KR', '한국어'],
        ['fr-FR', 'Français'],
        ['ru-RU', 'Русский']
    ];

    var _shown = false;
    var _accepted = false;
    var _memoryAccepted = false;   // localStorage 不可用时的会话内兜底（见 readAccepted）
    var _holdMs = HOLD_MS;         // 实际阻隔时长（单测经 _setHoldMs 缩短，生产恒为 HOLD_MS）
    var _deadline = 0;             // 挂钟解锁时刻（ms）
    var _tickTimer = null;
    var _unlockTimer = null;
    var _input = null;
    var _btn = null;
    var _localeEl = null;
    var _onInput = null;
    var _onKeydown = null;
    var _onBtnClick = null;
    var _onLocaleChange = null;
    var _onTabTrap = null;
    var _waiters = [];

    function _doc() {
        return (typeof document !== 'undefined' && document) ? document : null;
    }

    function _byId(id) {
        var d = _doc();
        return (d && d.getElementById) ? d.getElementById(id) : null;
    }

    function _storage() {
        var ls = global.localStorage;
        return (ls && typeof ls.getItem === 'function') ? ls : null;
    }

    // 当前界面语言（i18nCore 已归一化为 SUPPORTED 之一）；取不到按空串处理
    function _locale() {
        var i18n = global.AEI18n;
        if (!i18n || typeof i18n.getLocale !== 'function') return '';
        try { return String(i18n.getLocale() || '').trim(); } catch (_) { return ''; }
    }

    function _confirmEntry() {
        var id = _locale();
        for (var i = 0; i < CONFIRM_WORDS.length; i++) {
            if (CONFIRM_WORDS[i].id === id) return CONFIRM_WORDS[i];
        }
        // getLocale 已归一化；这里再兜一次大小写差异，别把 '' / 未知值当别国语言
        var lower = id.toLowerCase();
        for (var j = 0; j < CONFIRM_WORDS.length; j++) {
            if (CONFIRM_WORDS[j].id.toLowerCase() === lower) return CONFIRM_WORDS[j];
        }
        return CONFIRM_WORDS[0];
    }

    function confirmWord() { return _confirmEntry().word; }

    // 放行判定契约（_syncConfirmBtn 与 _tryConfirm 共用，别在别处重写比较）：
    //   1) 先 trim，首尾空白不算错；
    //   2) zh-CN 严格逐字相等——汉字没有大小写，不做任何模糊匹配；
    //   3) 其余语言大小写不敏感（en/de 手打 "i confirm" / "ICH BESTÄTIGE" 都放行）。
    function _matchesConfirmWord(val) {
        var s = String(val == null ? '' : val).trim();
        var entry = _confirmEntry();
        if (s === entry.word) return true;
        if (entry.id === SOURCE_LOCALE) return false;
        return s.toLowerCase() === entry.word.toLowerCase();
    }

    function readAccepted() {
        if (_memoryAccepted) return true;
        var ls = _storage();
        if (!ls) return false;
        try { return !!ls.getItem(ACCEPT_KEY); } catch (_) { return false; }
    }

    // 确认动作：先置内存位（本地存储写失败也不能把用户锁在弹窗里），再尽力落盘
    function markAccepted() {
        _accepted = true;
        _memoryAccepted = true;
        var ls = _storage();
        if (ls) {
            try { ls.setItem(ACCEPT_KEY, new Date().toISOString()); } catch (_) {}
        }
    }

    function isAccepted() {
        return _accepted || readAccepted();
    }

    // 闸门是否正在拦人（全局入口可按此暂缓响应）
    function isBlocking() {
        return _shown && !_accepted;
    }

    function _setHint(text, tone) {
        var hint = _byId(HINT_ID);
        if (!hint) return;
        hint.textContent = text;
        hint.className = 'disclaimer-hint' + (tone ? ' ' + tone : '');
    }

    function _setProgress(ratio) {
        var fill = _byId(FILL_ID);
        if (fill && fill.style) fill.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
    }

    function _remainingMs() {
        return Math.max(0, _deadline - Date.now());
    }

    function _holdHint() {
        _setHint(AEI18n.t('请阅读以上内容 —— {n} 秒后可输入「{word}」', {
            n: Math.ceil(_remainingMs() / 1000),
            word: confirmWord()
        }));
    }

    // 语言选择行：标签走 t()（en 下 Language），选项是语言自称
    function _setLocaleLabelText() {
        var label = _byId(LOCALE_LABEL_ID);
        if (label) label.textContent = AEI18n.t('界面语言');
    }

    // Chrome 88：隐藏容器里的静态 <option> 会重置选中值，选项一律运行时创建。
    // 已建过就只回填选中项（重载前的重复调用不叠加选项）。
    function _fillLocaleSelect() {
        var sel = _localeEl;
        var d = _doc();
        if (!sel || !d || typeof d.createElement !== 'function') return;
        if (!(sel.options && sel.options.length)) {
            for (var i = 0; i < LOCALE_OPTIONS.length; i++) {
                var opt = d.createElement('option');
                opt.value = LOCALE_OPTIONS[i][0];
                opt.textContent = LOCALE_OPTIONS[i][1];
                if (sel.appendChild) sel.appendChild(opt);
            }
        }
        var cur = _locale();
        if (cur) sel.value = cur;
    }

    // 语言切换：先写 localStorage（重载后 i18nCore 读同一键重建全量译文），再整面板重载——
    // 静态 shell / 字典 / 提示句一次性按新语言重建，不走「已翻译节点再翻一次」的差量路径。
    // 重载不可用（宿主异常 / 测试沙箱）时退一步：只刷新本弹窗的确认词、提示与按钮态，正文保持原样。
    function _applyLocaleChoice(choice) {
        var i18n = global.AEI18n;
        var cur = _locale();
        if (i18n && typeof i18n.setLocaleSetting === 'function') {
            try { i18n.setLocaleSetting(choice); } catch (_) {}
        }
        if (!choice || choice === cur) return;
        var loc = global.location;
        if (loc && typeof loc.reload === 'function') {
            try { loc.reload(); return; } catch (_) {}
        }
        if (i18n && typeof i18n.setLocale === 'function') {
            try { i18n.setLocale(choice); } catch (_) {}
        }
        _refreshGateText();
    }

    function _refreshGateText() {
        _setLocaleLabelText();
        if (_input) _input.placeholder = confirmWord();
        if (!_shown) return;
        if (_input && _input.disabled) _holdHint();
        else _setHint(AEI18n.t('请在下方输入「{word}」三个字，确认后进入系统', { word: confirmWord() }));
        _syncConfirmBtn();
    }

    function _handleLocaleChange() {
        var sel = _localeEl;
        var choice = (sel && typeof sel.value === 'string') ? sel.value.trim() : '';
        if (!choice) return;
        _applyLocaleChoice(choice);
    }

    function _syncConfirmBtn() {
        if (!_btn) return;
        var val = _input && typeof _input.value === 'string' ? _input.value : '';
        _btn.disabled = !_input || !!_input.disabled || !_matchesConfirmWord(val);
    }

    function _tick() {
        var left = _remainingMs();
        if (left <= 0) { _unlock(); return; }
        _setProgress(_holdMs > 0 ? 1 - left / _holdMs : 1);
        _holdHint();
    }

    function _unlock() {
        if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
        if (_unlockTimer) { clearTimeout(_unlockTimer); _unlockTimer = null; }
        _setProgress(1);
        if (_input) {
            _input.disabled = false;
            try { _input.focus(); } catch (_) {}
        }
        _setHint(AEI18n.t('请在下方输入「{word}」三个字，确认后进入系统', { word: confirmWord() }));
        _syncConfirmBtn();
    }

    function _tryConfirm() {
        if (!_shown || _accepted) return;
        if (!_input || _input.disabled) return;                    // 6 秒未满，输入框还没解锁
        var val = typeof _input.value === 'string' ? _input.value : '';
        if (!_matchesConfirmWord(val)) {
            _setHint(AEI18n.t('请准确输入「{word}」三个字（当前内容不是这三字）', { word: confirmWord() }), 'bad');
            return;
        }
        _finish();
    }

    function _finish() {
        markAccepted();
        _teardown();
        var mask = _byId(MASK_ID);
        if (mask) {
            mask.style.opacity = '0';
            var modal = mask.querySelector ? mask.querySelector('.modal') : null;
            if (modal && modal.style) {
                modal.style.opacity = '0';
                modal.style.transform = 'translateY(10px) scale(.98)';
            }
            // 与 main.js closeModal 同款 220ms 过渡后收起（过渡完再 display:none，避免"闪一下"）
            setTimeout(function () { if (mask.style) mask.style.display = 'none'; }, 220);
        }
        _shown = false;
        var waiters = _waiters;
        _waiters = [];
        for (var i = 0; i < waiters.length; i++) {
            try { waiters[i](true); } catch (_) {}
        }
        if (typeof global.aeBeep === 'function') {
            try { global.aeBeep('success'); } catch (_) {}
        }
    }

    // 焦点圈：Tab 默认会走到遮罩后面的按钮（.modal-mask 只挡鼠标不挡键盘焦点），
    // 用户在闸门里按 Tab+Enter 就能在背后点开「关于/设置」甚至 scopePicker（它按
    // 页面最高 z-index+1 开窗，会盖到闸门之上）——阻隔就名存实亡了。
    // 挂在 document 捕获阶段（焦点已在 body 时弹窗自身的监听收不到），只在闸门内的
    // 三站（语言选择 → 输入框 → 确认按钮）间循环，焦点在闸门外时拉回第一站。
    function _focusRing() {
        var ring = [];
        // 语言下拉转成自定义下拉后原生 select 是 display:none，焦点只落在自定义按钮上
        if (_localeEl) ring.push((_localeEl._cs && _localeEl._cs.btn) || _localeEl);
        if (_input) ring.push(_input);
        if (_btn) ring.push(_btn);
        return ring;
    }

    function _bindTabTrap() {
        var d = _doc();
        if (!d || !d.addEventListener) return;
        _onTabTrap = function (e) {
            if (!e || (e.key !== 'Tab' && e.keyCode !== 9)) return;
            if (e.preventDefault) e.preventDefault();
            var ring = _focusRing();
            if (!ring.length) return;
            var at = -1;
            for (var i = 0; i < ring.length; i++) {
                if (d.activeElement === ring[i]) { at = i; break; }
            }
            var next = ring[(at + 1) % ring.length];
            if (next && next.focus) { try { next.focus(); } catch (_) {} }
        };
        try { d.addEventListener('keydown', _onTabTrap, true); } catch (_) { _onTabTrap = null; }
    }

    function _teardown() {
        if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
        if (_unlockTimer) { clearTimeout(_unlockTimer); _unlockTimer = null; }
        var d = _doc();
        if (_onTabTrap && d && d.removeEventListener) {
            try { d.removeEventListener('keydown', _onTabTrap, true); } catch (_) {}
        }
        if (_input) {
            if (_onInput) {
                if (_input.removeEventListener) _input.removeEventListener('input', _onInput);
                else if (_input.oninput === _onInput) _input.oninput = null;
            }
            if (_onKeydown) {
                if (_input.removeEventListener) _input.removeEventListener('keydown', _onKeydown);
                else if (_input.onkeydown === _onKeydown) _input.onkeydown = null;
            }
        }
        if (_btn && _onBtnClick) {
            if (_btn.removeEventListener) _btn.removeEventListener('click', _onBtnClick);
            else if (_btn.onclick === _onBtnClick) _btn.onclick = null;
        }
        if (_localeEl && _onLocaleChange) {
            if (_localeEl.removeEventListener) _localeEl.removeEventListener('change', _onLocaleChange);
            else if (_localeEl.onchange === _onLocaleChange) _localeEl.onchange = null;
        }
        _input = null;
        _btn = null;
        _localeEl = null;
        _onInput = null;
        _onKeydown = null;
        _onBtnClick = null;
        _onLocaleChange = null;
        _onTabTrap = null;
    }

    function _waitForAccept() {
        if (_accepted || isAccepted()) return Promise.resolve(true);
        return new Promise(function (resolve) { _waiters.push(resolve); });
    }

    // 主入口：未确认过才弹；已确认 / 环境拿不到弹窗时立即 resolve（fail-open）
    function maybeShow() {
        if (_shown) return _waitForAccept();
        if (isAccepted()) return Promise.resolve(true);
        var mask = _byId(MASK_ID);
        if (!mask) return Promise.resolve(true);

        _shown = true;
        _accepted = false;
        mask.style.display = 'flex';
        var applied = false;
        var applyOpen = function () {
            if (applied || !_shown) return;
            applied = true;
            mask.style.opacity = '1';
            var modal = mask.querySelector ? mask.querySelector('.modal') : null;
            if (modal && modal.style) {
                modal.style.opacity = '1';
                modal.style.transform = 'translateY(0) scale(1)';
            }
        };
        // 淡入走 rAF（与 main.js openModal 同款）；另加一次性兜底——rAF 被节流/不触发时
        // 只剩 display:flex，会留下「看不见但仍挡点击」的透明遮罩（迁移进度弹窗踩过同款）
        if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(applyOpen);
        setTimeout(applyOpen, 300);
        _bindTabTrap();

        _localeEl = _byId(LOCALE_ID);
        if (_localeEl) {
            _fillLocaleSelect();
            // 首启闸门早于 bootstrap：全局 initCustomSelects() 尚未运行，不转换的话
            // 这里会成为面板里唯一的原生 select（弹层由系统绘制，样式与交互和其它下拉不一致）。
            if (!_localeEl._cs && typeof global.initCustomSelect === 'function') {
                try { global.initCustomSelect(_localeEl); } catch (err) {
                    console.warn('[FirstRunDisclaimer] 语言下拉转换失败，保留原生 select: ' + (err && err.message ? err.message : err));
                }
            }
            _setLocaleLabelText();
            _onLocaleChange = function () { _handleLocaleChange(); };
            if (_localeEl.addEventListener) _localeEl.addEventListener('change', _onLocaleChange);
            else _localeEl.onchange = _onLocaleChange;
        }

        _input = _byId(INPUT_ID);
        _btn = _byId(BTN_ID);
        if (_input) {
            _input.value = '';
            _input.disabled = true;
            _input.placeholder = confirmWord();
            _onInput = function () { _syncConfirmBtn(); };
            if (_input.addEventListener) _input.addEventListener('input', _onInput);
            else _input.oninput = _onInput;
            // Enter 提交：中文输入法候选框的 Enter（isComposing / keyCode 229）不算
            _onKeydown = function (e) {
                if (!e || e.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter' || e.keyCode === 13) {
                    if (e.preventDefault) e.preventDefault();
                    _tryConfirm();
                }
            };
            if (_input.addEventListener) _input.addEventListener('keydown', _onKeydown);
            else _input.onkeydown = _onKeydown;
        }
        if (_btn) {
            _btn.disabled = true;
            _onBtnClick = function () { _tryConfirm(); };
            if (_btn.addEventListener) _btn.addEventListener('click', _onBtnClick);
            else _btn.onclick = _onBtnClick;
        }
        _deadline = Date.now() + _holdMs;
        _setProgress(0);
        _tick();
        _tickTimer = setInterval(_tick, 200);
        _unlockTimer = setTimeout(_unlock, _holdMs);
        return _waitForAccept();
    }

    // 重测用（控制台执行后重载面板即可再见弹窗）；不对外暴露为界面功能
    function reset() {
        var ls = _storage();
        if (ls) { try { ls.removeItem(ACCEPT_KEY); } catch (_) {} }
        _accepted = false;
        _memoryAccepted = false;
        _shown = false;
        _holdMs = HOLD_MS;
    }

    global.AEFirstRunDisclaimer = {
        maybeShow: maybeShow,
        isAccepted: isAccepted,
        isBlocking: isBlocking,
        reset: reset,
        _CONFIRM_WORD: confirmWord,     // 调试导出：按当前界面语言返回确认词
        _HOLD_MS: HOLD_MS,
        _ACCEPT_KEY: ACCEPT_KEY,
        // 单测专用：缩短阻隔时长，免得每个用例真等 6 秒（生产代码不调用）
        _setHoldMs: function (ms) { _holdMs = Math.max(0, Number(ms) || 0); }
    };
})(window);
