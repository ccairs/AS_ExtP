(function (global) {
    'use strict';

    var ACTIVE = null;

    function buildOptions(inst) {
        inst.list.innerHTML = '';
        var opts = inst.el.options;
        for (var i = 0; i < opts.length; i++) {
            var o = document.createElement('div');
            o.className = 'cs-opt';
            if (opts[i].selected) o.classList.add('active');
            if (opts[i].disabled) o.classList.add('disabled');
            o.textContent = opts[i].textContent || opts[i].label || '';
            (function (idx, el) {
                el.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    inst.pick(idx);
                });
            })(i, o);
            inst.list.appendChild(o);
        }
        updateLabel(inst);
    }

    function updateLabel(inst) {
        var sel = inst.el.selectedIndex;
        if (sel >= 0 && inst.el.options[sel]) {
            inst.label.textContent = inst.el.options[sel].textContent || '';
        }
    }

    function open(inst) {
        if (inst.isOpen) return;
        // 原生 select 被禁用时，自定义按钮也不可展开下拉
        if (inst.el.disabled) return;
        if (ACTIVE && ACTIVE !== inst) close(ACTIVE);
        var rect = inst.btn.getBoundingClientRect();
        var w = Math.max(rect.width, 80);
        // 移到 body 下，逃逸所有层叠上下文
        if (inst.list.parentNode !== document.body) {
            document.body.appendChild(inst.list);
        }
        inst.list.setAttribute('style',
            'position:fixed;' +
            'left:' + Math.round(rect.left) + 'px;' +
            'top:' + Math.round(rect.bottom + 4) + 'px;' +
            'width:' + Math.round(w) + 'px;' +
            'max-height:220px;' +
            'opacity:1;transform:translateY(0);pointer-events:auto;' +
            'z-index:2147483647;'
        );
        inst.box.classList.add('cs-open');
        inst.arrow.classList.add('cs-open');
        inst.isOpen = true;
        var cur = inst.list.querySelector('.cs-opt.active');
        if (cur) cur.scrollIntoView({ block: 'nearest' });
        ACTIVE = inst;
    }

    function close(inst) {
        if (!inst.isOpen) return;
        inst.box.classList.remove('cs-open');
        inst.arrow.classList.remove('cs-open');
        // 放回原位
        inst.box.appendChild(inst.list);
        inst.list.removeAttribute('style');
        // 关闭后设为 display:none，防止 .cs-list 的绝对定位选项列表
        // 污染祖先滚动容器的 scrollHeight（虚假滚动条 bug）
        inst.list.style.display = 'none';
        inst.isOpen = false;
        if (ACTIVE === inst) ACTIVE = null;
    }

    document.addEventListener('mousedown', function (e) {
        if (!ACTIVE) return;
        var el = e.target;
        while (el) {
            if (el === ACTIVE.box || el === ACTIVE.list) return;
            el = el.parentElement;
        }
        close(ACTIVE);
    }, true);

    function createInstance(selectEl) {
        if (selectEl._cs) return selectEl._cs;

        var cs = window.getComputedStyle(selectEl);

        // 结构: <span>.cs-wrap > button.cs-btn + div.cs-list
        var wrap = document.createElement('span');
        wrap.className = 'cs-wrap';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cs-btn';
        btn.tabIndex = 0;
        // 继承原生 select 的字体
        if (cs.fontSize) btn.style.fontSize = cs.fontSize;

        var label = document.createElement('span');
        label.className = 'cs-label';

        var arrow = document.createElement('span');
        arrow.className = 'cs-arrow';
        arrow.innerHTML = '&#x25BE;';

        btn.appendChild(label);
        btn.appendChild(arrow);

        var list = document.createElement('div');
        list.className = 'cs-list';
        // 初始隐藏：避免关闭状态下 .cs-list(position:absolute) 的选项高度
        // 污染祖先滚动容器(如 .modal-body)的 scrollHeight，导致出现"虚假"滚动条
        list.style.display = 'none';

        wrap.appendChild(btn);
        wrap.appendChild(list);

        var inst = {
            el: selectEl,
            box: wrap,
            btn: btn,
            label: label,
            arrow: arrow,
            list: list,
            isOpen: false,
            pick: function (idx) {
                if (selectEl.options[idx] && selectEl.options[idx].disabled) return;
                selectEl.selectedIndex = idx;
                buildOptions(inst);
                close(inst);
                selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            },
            refresh: function () { buildOptions(inst); }
        };

        buildOptions(inst);

        // 原生 select 起初可能就处于禁用态（如内置平台的只读字段）
        function syncDisabled() {
            var on = !!inst.el.disabled;
            inst.btn.disabled = on;
            inst.btn.classList.toggle('cs-disabled', on);
        }
        syncDisabled();

        btn.addEventListener('mousedown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (inst.isOpen) close(inst); else open(inst);
        });

        btn.addEventListener('keydown', function (e) {
            var key = e.key;
            if (key === 'Enter' || key === ' ') {
                e.preventDefault();
                if (inst.isOpen) {
                    // 展开态 Enter/空格提交当前高亮项（只 close 会让键盘导航
                    // 无法提交，方向键高亮与 selectedIndex 脱钩）。
                    // .cs-opt 与原生 options 一一对应（buildOptions 逐项生成）。
                    var act = inst.list.querySelector('.cs-opt.active');
                    if (act) {
                        var rows = inst.list.querySelectorAll('.cs-opt');
                        for (var ai = 0; ai < rows.length; ai++) {
                            if (rows[ai] === act) { inst.pick(ai); break; }
                        }
                    } else {
                        close(inst);
                    }
                } else {
                    open(inst);
                }
            } else if (key === 'ArrowDown') {
                e.preventDefault();
                if (!inst.isOpen) open(inst);
                var cur = inst.list.querySelector('.cs-opt.active');
                var nxt = cur ? cur.nextElementSibling : inst.list.firstElementChild;
                if (nxt && !nxt.classList.contains('disabled')) {
                    if (cur) cur.classList.remove('active');
                    nxt.classList.add('active');
                    nxt.scrollIntoView({ block: 'nearest' });
                }
            } else if (key === 'ArrowUp') {
                e.preventDefault();
                if (!inst.isOpen) open(inst);
                var cur2 = inst.list.querySelector('.cs-opt.active');
                var prv = cur2 ? cur2.previousElementSibling : inst.list.lastElementChild;
                if (prv && !prv.classList.contains('disabled')) {
                    if (cur2) cur2.classList.remove('active');
                    prv.classList.add('active');
                    prv.scrollIntoView({ block: 'nearest' });
                }
            } else if (key === 'Escape') {
                // Esc 关闭同时重建选项，把高亮复位回 selectedIndex
                //（方向键移动过 .active 后关闭，不应残留脱钩的高亮）
                close(inst);
                buildOptions(inst);
            }
        });

        // 监听原生 change
        selectEl.addEventListener('change', function () {
            buildOptions(inst);
        });

        // 监听 option 动态变更（如异步加载选项列表后填充 option）
        if (typeof MutationObserver !== 'undefined') {
            var optObserver = new MutationObserver(function () {
                buildOptions(inst);
            });
            optObserver.observe(selectEl, { childList: true, subtree: true });
        }

        // 插入、隐藏原生
        selectEl.parentNode.insertBefore(wrap, selectEl);
        selectEl.style.display = 'none';
        selectEl.setAttribute('aria-hidden', 'true');

        selectEl._cs = inst;
        return inst;
    }

    function initAll(root) {
        root = root || document;
        var arr = root.querySelectorAll('select');
        for (var i = 0; i < arr.length; i++) {
            if (arr[i]._cs) continue;
            if (arr[i].classList.contains('cs-skip')) continue;
            createInstance(arr[i]);
        }
    }

    function initOne(el) { return createInstance(el); }
    function refreshOne(el) {
        if (el._cs) el._cs.refresh();
    }

    global.initCustomSelects = initAll;
    global.initCustomSelect = initOne;
    global.refreshCustomSelect = refreshOne;

    // MutationObserver：自动转换动态添加的 <select>，并同步 disabled 状态
    if (typeof MutationObserver !== 'undefined') {
        var observer = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var mutation = mutations[i];
                // disabled 属性变化 -> 同步自定义按钮的禁用态
                if (mutation.type === 'attributes' && mutation.attributeName === 'disabled') {
                    var t = mutation.target;
                    if (t && t._cs && t.tagName === 'SELECT') {
                        if (t.disabled) {
                            t._cs.btn.disabled = true;
                            t._cs.btn.classList.add('cs-disabled');
                        } else {
                            t._cs.btn.disabled = false;
                            t._cs.btn.classList.remove('cs-disabled');
                        }
                    }
                    continue;
                }
                var added = mutation.addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var node = added[j];
                    if (node.nodeType !== 1) continue;
                    if (node.tagName === 'SELECT' && !node._cs && !node.classList.contains('cs-skip')) {
                        createInstance(node);
                    }
                    if (node.querySelectorAll) {
                        var nested = node.querySelectorAll('select');
                        for (var k = 0; k < nested.length; k++) {
                            if (!nested[k]._cs && !nested[k].classList.contains('cs-skip')) {
                                createInstance(nested[k]);
                            }
                        }
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    }
})(window);
