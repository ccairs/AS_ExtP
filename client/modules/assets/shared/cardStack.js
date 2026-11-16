(function (global) {
    global.AEAssetsShared = global.AEAssetsShared || {};

    // 槽位状态机纯函数：点第 k 槽（0-indexed），新 slots = 原 slots 左移 k 位（取模 n）。
    // 被挤出顶部的 k 张按原相对顺序填末尾 k 个槽。越界/负索引返回原数组副本。
    function nextSlots(slots, clickedSlot) {
        if (!Array.isArray(slots) || slots.length === 0) return [];
        var n = slots.length;
        var k = clickedSlot;
        if (typeof k !== 'number' || k < 0 || k >= n) return slots.slice();
        return slots.slice(k).concat(slots.slice(0, k));
    }

    function createCardStack(opts) {
        opts = opts || {};
        var container = opts.container;
        var cards = opts.cards || [];
        var initialTopId = opts.initialTopId || (cards[0] && cards[0].id);
        var onChange = opts.onChange || function () {};

        if (!container) throw new Error('createCardStack: container 必填');
        if (cards.length < 2) throw new Error('createCardStack: 至少 2 张卡');

        // slots: [top, mid, bottom, ...]；初始按 initialTopId 排
        var _slots = [];
        var _byId = {};
        cards.forEach(function (c) { _byId[c.id] = c; });
        // 初始顺序：initialTopId 第一，其余按 cards 原序
        _slots.push(_byId[initialTopId]);
        cards.forEach(function (c) { if (c.id !== initialTopId) _slots.push(c); });

        var _handle = null;
        var _animating = false;
        var _stopPulse = null;   // 点击冲击波停止函数（switchTo/destroy 时调）
        var _lastDir = 0;        // 上次切换方向：1=右拖/正向，-1=左拖/反向，0=初始/无方向
        // 切卡生命周期定时器登记——switchTo/_schedCover/_schedActive 的 120/270ms
        // 回调会触达 view.onCovered/onActive（onActive → scanMissing → flushIndex 写盘），
        // destroy 统一清除，防 unmount 后回调仍触发
        var _lifecycleTimers = [];
        function _schedLifecycle(fn, ms) {
            _lifecycleTimers.push(setTimeout(fn, ms));
        }
        function _clearLifecycleTimers() {
            for (var i = 0; i < _lifecycleTimers.length; i++) clearTimeout(_lifecycleTimers[i]);
            _lifecycleTimers = [];
        }

        // 构建 DOM
        container.innerHTML = '';
        var stack = document.createElement('div');
        stack.className = 'assets-cardstack';
        _handle = document.createElement('div');
        _handle.className = 'assets-cardstack-handle';
        stack.appendChild(_handle);
        cards.forEach(function (c, i) {
            var card = document.createElement('div');
            card.className = 'assets-card';
            card.setAttribute('data-card-id', c.id);
            var spine = document.createElement('div');
            spine.className = 'assets-card-spine';
            spine.setAttribute('data-index', String(i + 1));
            spine.textContent = c.label;
            card.appendChild(spine);
            var content = document.createElement('div');
            content.className = 'assets-card-content';
            content.appendChild(c.pane);
            card.appendChild(content);
            // 鼠标跟随边缘发光条
            ['top', 'bottom', 'left', 'right'].forEach(function (edge) {
                var g = document.createElement('div');
                g.className = 'assets-card-glow assets-card-glow-' + edge;
                card.appendChild(g);
            });
            stack.appendChild(card);
            c._dom = card;
            c._spine = spine;
        });
        // 临时卡：循环补位用，只带 spine（动态标题），无 pane。右拖从左滑入 bot 显示 top 标题，
        // 左拖从右滑入 top 显示 bot 标题。动画结束后真实卡对换到位、临时卡隐藏。
        var _temp = document.createElement('div');
        _temp.className = 'assets-card assets-card-temp';
        var _tempSpine = document.createElement('div');
        _tempSpine.className = 'assets-card-spine';
        _temp.appendChild(_tempSpine);
        stack.appendChild(_temp);
        container.appendChild(stack);

        function _applySlots() {
            // 0=top, 1=mid, 2=bot。退场卡（右拖→bot / 左拖→top）保持 op0，由入场动画淡入
            _slots.forEach(function (c, i) {
                var d = c._dom;
                var targetClass = i === 0 ? 'slot-top' : (i === 1 ? 'slot-mid' : 'slot-bot');
                d.classList.remove('slot-top', 'slot-mid', 'slot-bot', 'dark-zone');
                d.classList.add(targetClass);
                var isExiting = (_lastDir === 1 && i === 2) || (_lastDir === -1 && i === 0);
                d.style.opacity = isExiting ? '0' : '';
            });
        }
        _applySlots();

        // 竖条点击切换（点 mid/bot 的 spine）
        cards.forEach(function (c) {
            c._spine.addEventListener('click', function () {
                var idx = _slots.indexOf(c);
                if (idx > 0) {
                    if (typeof aeBeep === 'function') aeBeep('toggle');
                    switchTo(c.id);
                }
            });
        });

        // 顶层卡片鼠标靠近边缘发光
        _bindCardGlow();
        // 点击产生沿边缘绕行的冲击波
        _bindCardPulse();

        function switchTo(id) {
            if (_animating) return;
            if (_coasting) _stopCoast();
            var idx = _slots.findIndex ? _slots.findIndex(function (c) { return c.id === id; })
                : (function () { for (var i = 0; i < _slots.length; i++) if (_slots[i].id === id) return i; return -1; })();
            if (idx <= 0) return;
            _animating = true;
            // 方向：idx=1 正向(右拖式)，idx=n-1 反向(左拖式/点 bot)，其余 0
            _lastDir = (idx === 1) ? 1 : (idx === _slots.length - 1) ? -1 : 0;
            var oldTop = _slots[0];
            if (oldTop && oldTop._dom) {
                var els = oldTop._dom.querySelectorAll('.assets-card-glow');
                for (var i = 0; i < els.length; i++) els[i].style.opacity = '0';
            }
            if (_stopPulse) _stopPulse();
            // 阶段1内容淡出由 CSS transition 自动处理（.assets-card:not(.slot-top) .assets-card-content opacity→0，120ms）
            // 阶段1完成后（120ms）调 onCovered——此时内容已淡出，清 media src 不会让视频瞬黑（spec 3.1/7）
            _schedLifecycle(function () {
                if (oldTop.view && oldTop.view.onCovered) oldTop.view.onCovered();
            }, 120);
            // 重排 slots（直跳：左移 idx 位）+ 应用新槽位（触发阶段2/3/4a 的 transform/opacity 过渡）
            _slots = nextSlots(_slots, idx);
            _applySlots();
            _updateHandleTitle();
            onChange(_slots[0].id);
            // 对换：退场卡（op0）淡入到位 + 临时卡淡出。250ms 后卡片 transform 过渡基本完成
            setTimeout(function () {
                _slots.forEach(function (c) {
                    if (c._dom.style.opacity === '0') c._dom.style.opacity = '';
                });
                _temp.style.opacity = '0';
                _temp.style.transform = '';
                _temp.style.zIndex = '';
            }, 250);
            // 阶段3完成后（~270ms）调 onActive——新顶层卡已浮上，内容开始淡入（阶段5）
            _schedLifecycle(function () {
                if (_slots[0].view && _slots[0].view.onActive) _slots[0].view.onActive();
            }, 270);
            // 用户可见完成（450ms：阶段3 250ms + 阶段5 200ms）释放 _animating
            // 阶段4b（黑暗区填位）若仍在途，新切换会重排 slots，4b 的卡直接接受新目标（CSS transition 重定向），不可见故不跳变
            setTimeout(function () { _animating = false; }, 450);
        }

        // ── 拖拽/惯性跨格提交的切卡生命周期 ──
        // 时序对齐 switchTo：旧顶层等内容淡出（120ms）后再 onCovered 清 media src（防视频瞬黑），
        // 新顶层浮上、内容淡入（270ms）时 onActive。
        // 触发时校验卡当前槽位：连续快速拖拽会产生多轮提交，旧定时器晚到时该卡可能已重新登顶
        // （cover 跳过）或已换位（active 跳过）——onCovered/onActive 均为幂等清理/恢复，错位触发
        // 有害（激活非顶层媒体），过期跳过无害（destroy 虽已清定时器，快速切卡轮次间的竞态仍靠槽位校验兜底）
        function _schedCover(card) {
            _schedLifecycle(function () {
                if (_slots[0] === card) return;
                if (card.view && card.view.onCovered) card.view.onCovered();
            }, 120);
        }
        function _schedActive(card) {
            _schedLifecycle(function () {
                if (_slots[0] !== card) return;
                if (card.view && card.view.onActive) card.view.onActive();
            }, 270);
        }

        function _bindCardGlow() {
            var GLOW_MAX_SIZE = 220;
            var GLOW_MIN_SIZE = 60;
            var THRESHOLD = 200;
            function _hideGlows(d) {
                var els = d.querySelectorAll('.assets-card-glow');
                for (var i = 0; i < els.length; i++) els[i].style.opacity = '0';
            }
            stack.addEventListener('mousemove', function (e) {
                var top = _slots[0];
                if (!top) return;
                var d = top._dom;
                if (!d.contains(e.target)) return;
                var rect = d.getBoundingClientRect();
                var px = e.clientX - rect.left;
                var py = e.clientY - rect.top;
                var w = rect.width || 1;
                var h = rect.height || 1;
                var dt = py, db = h - py, dl = px, dr = w - px;
                _hideGlows(d);
                function _show(edge, pos, horizontal) {
                    var el = d.querySelector('.assets-card-glow-' + edge);
                    if (!el) return;
                    var dist = horizontal ? py : px;
                    if (edge === 'bottom') dist = h - py;
                    if (edge === 'right') dist = w - px;
                    if (dist > THRESHOLD) return;
                    var intensity = 1 - dist / THRESHOLD;
                    var size = Math.round(GLOW_MIN_SIZE + (GLOW_MAX_SIZE - GLOW_MIN_SIZE) * intensity);
                    el.style.opacity = String(intensity);
                    var half = size / 2;
                    // 不 clamp：left/top 允许负值或超出，使 radial-gradient 中心（元素 50% = left + half = pos）
                    // 始终对准鼠标投影点。鼠标在角落时 gradient 中心落在角落，溢出部分由 .assets-card
                    // 的 overflow:hidden 裁剪——这样四条边在角落交汇处都能亮，无需四角发光点补光。
                    if (horizontal) {
                        el.style.width = size + 'px';
                        el.style.left = (pos - half) + 'px';
                    } else {
                        el.style.height = size + 'px';
                        el.style.top = (pos - half) + 'px';
                    }
                }
                if (dt < THRESHOLD) _show('top', px, true);
                if (db < THRESHOLD) _show('bottom', px, true);
                if (dl < THRESHOLD) _show('left', py, false);
                if (dr < THRESHOLD) _show('right', py, false);
            });
            stack.addEventListener('mouseleave', function () {
                var top = _slots[0];
                if (top && top._dom) _hideGlows(top._dom);
            });
        }

        // 点击顶层卡：从震源（点击位置最近边缘点）沿边缘双向扩散，波峰带渐弱拖尾
        function _bindCardPulse() {
            var DURATION = 720;         // 总持续 ms
            var TRAVEL = 300;           // 波峰传播距离 px（不绕圈，传到即衰没）
            var TAIL_LEN = 110;         // 拖尾长度 px
            var MAX_THICK = 4;          // 起始粗细 px（先粗后细）
            var MIN_SCALE = 0.3;        // 末尾 scaleY（≈1.2px）
            var MAX_DIST = 180;         // 距边缘距离上限：起始粗细/亮度按此归一化
            var _cw = null, _ccw = null, _raf = 0, _t0 = 0, _ctx = null;

            // 周长参数 s（顺时针，0=左上角）映射到矩形边缘坐标 + 亮段朝向
            function _pointOnEdge(s, w, h) {
                var P = 2 * (w + h);
                s = ((s % P) + P) % P;          // 归一化到 [0,P)
                if (s < w) return { x: s, y: 0, angle: 0 };          // 顶边 →
                s -= w;
                if (s < h) return { x: w, y: s, angle: 90 };          // 右边 ↓
                s -= h;
                if (s < w) return { x: w - s, y: h, angle: 180 };     // 底边 ←
                s -= w;
                return { x: 0, y: h - s, angle: 270 };                // 左边 ↑
            }
            function _stop() {
                if (_raf) {
                    if (window.cancelAnimationFrame) cancelAnimationFrame(_raf);
                    else clearTimeout(_raf);
                    _raf = 0;
                }
                if (_cw && _cw.parentNode) _cw.parentNode.removeChild(_cw);
                if (_ccw && _ccw.parentNode) _ccw.parentNode.removeChild(_ccw);
                _cw = _ccw = null;
                _ctx = null;
            }
            _stopPulse = _stop;

            stack.addEventListener('click', function (e) {
                var top = _slots[0];
                if (!top) return;
                var d = top._dom;
                if (!d.contains(e.target)) return;
                var rect = d.getBoundingClientRect();
                // pulse 是 .assets-card 子元素，absolute 定位相对 padding box；getBoundingClientRect 返 border box。
                // 不扣 border 的话右/下边波峰会落在 padding box 外被 overflow:hidden 裁掉，只有左/上边可见。
                var px = e.clientX - rect.left - d.clientLeft;
                var py = e.clientY - rect.top - d.clientTop;
                var w = d.clientWidth || rect.width || 1;
                var h = d.clientHeight || rect.height || 1;
                // 震源：点击位置到最近边缘的投影点
                var dt = py, db = h - py, dl = px, dr = w - px;
                var minD = Math.min(dt, db, dl, dr);
                var s0;
                if (minD === dt) s0 = px;                       // 顶边
                else if (minD === dr) s0 = w + py;              // 右边
                else if (minD === db) s0 = w + h + (w - px);    // 底边
                else s0 = 2 * (w + h) - py;                     // 左边
                _stop();
                _cw = document.createElement('div');
                _cw.className = 'assets-card-pulse cw';
                d.appendChild(_cw);
                _ccw = document.createElement('div');
                _ccw.className = 'assets-card-pulse ccw';
                d.appendChild(_ccw);
                // 起始粗细/亮度与「点击位置到边缘距离」绑定：贴边点击冲击最强，越靠中心越弱
                var dRatio = Math.min(minD, MAX_DIST) / MAX_DIST;
                var scale0 = 1 - dRatio * (1 - MIN_SCALE);
                var op0 = 1 - dRatio * 0.7;
                _ctx = { s0: s0, w: w, h: h, scale0: scale0, op0: op0 };
                _t0 = Date.now();
                var half = MAX_THICK / 2;
                function step() {
                    if (!_cw) { _raf = 0; return; }
                    var elapsed = Date.now() - _t0;
                    var t = elapsed / DURATION;
                    if (t >= 1) { _stop(); return; }
                    var ease = 1 - Math.pow(1 - t, 3);           // 先快后慢
                    var scale = _ctx.scale0 - (_ctx.scale0 - MIN_SCALE) * ease;  // 先粗后细（起始粗细由距离决定）
                    var op = _ctx.op0 * Math.pow(1 - t, 1.3);     // 渐弱（起始亮度由距离决定）
                    var off = TRAVEL * ease;
                    // 顺时针波峰：右端（transform-origin 100% 50%）锚定波峰位置，拖尾向后方延伸
                    var pc = _pointOnEdge(_ctx.s0 + off, _ctx.w, _ctx.h);
                    _cw.style.transform = 'translate(' + (pc.x - TAIL_LEN) + 'px,' + (pc.y - half) + 'px) rotate(' + pc.angle + 'deg) scaleY(' + scale + ')';
                    _cw.style.opacity = String(op);
                    // 逆时针波峰：左端（transform-origin 0% 50%）锚定波峰位置
                    var pn = _pointOnEdge(_ctx.s0 - off, _ctx.w, _ctx.h);
                    _ccw.style.transform = 'translate(' + pn.x + 'px,' + (pn.y - half) + 'px) rotate(' + pn.angle + 'deg) scaleY(' + scale + ')';
                    _ccw.style.opacity = String(op);
                    _raf = (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(step);
                }
                step();
            });
        }

        function mount() {
            // 同步触发初始 onChange（初始化首屏 view）
            onChange(_slots[0].id);
            _buildHandleBars();
            // 延迟重建：mount 时 handle 可能尚未布局完（clientWidth=0），导致竖条数按 fallback 200 算、
            // 虽 flex:1 1 0 仍填满但密度不足。rAF 后拿到真实宽度重建一次。
            (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () { _buildHandleBars(); });
        }
        function destroy() {
            // 先清生命周期定时器——120/270ms 回调触发的 onActive → scanMissing →
            // flushIndex 会在 unmount 后继续写 index.json（destroy 不清定时器时，面板销毁后仍落盘）
            _clearLifecycleTimers();
            if (_stopPulse) _stopPulse();
            _stopCoast();   // 拖拽惯性滑行中 destroy：停掉 rAF 循环，防操作已脱离 DOM 的元素
            cards.forEach(function (c) {
                if (c.view && c.view.destroy) { try { c.view.destroy(); } catch (_) {} }
            });
            container.innerHTML = '';
        }

        // 手柄竖条（频谱样式）
        var _bars = [];
        var _barCount = 0;
        var _titleEl = null;
        function _buildHandleBars() {
            _handle.innerHTML = '';
            _bars = [];
            // 左侧标题：当前顶层卡 label，便于区分面板
            _titleEl = document.createElement('span');
            _titleEl.className = 'assets-cardstack-handle-title';
            _handle.appendChild(_titleEl);
            // 右侧竖条容器：吃掉剩余宽度
            var wrap = document.createElement('div');
            wrap.className = 'assets-cardstack-handle-bars';
            _handle.appendChild(wrap);
            _barCount = 60;
            for (var i = 0; i < _barCount; i++) {
                var b = document.createElement('div');
                b.className = 'assets-cardstack-handle-bar';
                wrap.appendChild(b);
                _bars.push(b);
            }
            _animateBars(0);
            _updateHandleTitle();
        }
        function _updateHandleTitle() {
            if (_titleEl && _slots[0]) _titleEl.textContent = _slots[0].label;
        }
        // 频谱竖条高度随相位起伏：山形包络（中间高两端归 0）× 流动波形（相位由拖动偏移驱动）。
        // 拖动时相位变化，波形像在流动跳动；静止时相位 0，呈静态山形。
        function _animateBars(phase) {
            var n = _barCount;
            if (!n) return;
            for (var i = 0; i < n; i++) {
                var t = n <= 1 ? 0.5 : i / (n - 1);   // 0~1 位置
                var env = Math.sin(t * Math.PI);       // 山形包络，两端 0 中间 1
                env = env * env * (3 - 2 * env);       // smoothstep 缓动
                // 流动波：减 phase——右拖 phase↑ 时波形向右流（与拖动方向一致）
                var wave = 0.55 + 0.45 * Math.sin(t * Math.PI * 4 - phase);
                var h = env * wave * 14;
                if (_bars[i]) _bars[i].style.height = h.toFixed(1) + 'px';
            }
        }

        // 手柄拖拽：线性 transform 映射 + rAF 合并 + 松手惯性滑行 + 吸附
        var _dragging = false;
        var _dragStartX = 0;
        var _dragOffset = 0;        // 当前线性偏移（px）
        var _rafPending = false;
        var _lastMoveX = 0;
        var _velSamples = [];       // 惯性速度采样：{t,x}，保留最近 ~100ms
        var _coasting = false;      // 松手后惯性滑行中
        var _coastVelocity = 0;     // 当前滑行速度（px/frame）
        var _coastRafId = 0;        // 滑行 rAF 句柄
        _handle.addEventListener('pointerdown', function (e) {
            if (_animating) return;
            _stopCoast();          // 中断滑行，开始新拖拽
            _dragging = true;
            _dragStartX = e.clientX;
            _lastMoveX = e.clientX;
            _dragOffset = 0;
            _velSamples = [{ t: Date.now(), x: e.clientX }];
            _handle.classList.add('dragging');
            try { _handle.setPointerCapture(e.pointerId); } catch (_) {}
            // 拖拽中卡片 transition:none，直接由 _dragOffset 写 transform（临时卡同理，否则追不上真实卡）
            cards.forEach(function (c) { c._dom.style.transition = 'none'; });
            _temp.style.transition = 'none';
            e.preventDefault();
        });
        _handle.addEventListener('pointermove', function (e) {
            if (!_dragging) return;
            _lastMoveX = e.clientX;
            // 速度采样：push 后裁掉 100ms 前的旧样本，保留最近一段位移用于松手时估算惯性
            var now = Date.now();
            _velSamples.push({ t: now, x: e.clientX });
            while (_velSamples.length > 2 && _velSamples[0].t < now - 100) _velSamples.shift();
            if (_rafPending) return;
            _rafPending = true;
            (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () {
                _rafPending = false;
                if (!_dragging) return;
                _dragOffset = _lastMoveX - _dragStartX;
                _applyDragOffset();
            });
        });
        // 把 _dragOffset 实时映射到三卡的视觉状态（spec 237 行：拖拽中实时映射阶段2-4 进度，松手吸附补播剩余）。
        // 静止槽位：top=x0/op1，mid=x-24/op.7，bot=x-48/op.5（纵深堆叠，逐级左移露 spine tab）。
        // 右拖(f>0)：top 向右滑出消失，mid 从深处浮上 top，bot 从更深处浮上 mid。
        // 左拖(f<0)：top 纵深退到 mid+左移露标题，mid 退到 bot，bot 从右滑入 top。
        var _segW = 0;
        function _applyDragOffset() {
            _segW = (stack.clientWidth || 600) / 6;
            var frac = _dragOffset / _segW;
            // 循环轮转：|frac|>=1 时提交一格——重排 slots + 消化一格偏移，frac 回到 (-1,1) 继续连续拖动。
            var committed = 0;   // 跨格提交次数（>0 时循环结束给最终顶层补 onActive）
            while (Math.abs(frac) >= 1) {
                var sign = frac > 0 ? 1 : -1;
                var n = _slots.length;
                var idx = sign > 0 ? 1 : (n - 1);   // 右拖 mid 升 top(idx=1)，左拖 bot 升 top(idx=n-1)
                _lastDir = sign;
                // 跨格提交即一次切卡，旧顶层补 onCovered（对齐 switchTo 的生命周期契约，
                // 否则被盖住卡的媒体不清停、详情区视频持续解码出声）
                _schedCover(_slots[0]);
                committed++;
                _slots = nextSlots(_slots, idx);
                _dragStartX += sign * _segW;
                _dragOffset = _lastMoveX - _dragStartX;
                frac = _dragOffset / _segW;
                cards.forEach(function (c) { c._dom.style.transform = ''; c._dom.style.opacity = ''; });
                _applySlots();
                _updateHandleTitle();
                onChange(_slots[0].id);
            }
            // 跨格提交后的最终顶层补 onActive。连续跨格的中间层只短暂登顶，
            // 逐次激活/清停会造成媒体启停抖动，故仅最终顶层激活（中间层保持被盖住态）；
            // 松手吸附（_finalizeSnap）换卡走 switchTo 自带生命周期，回弹不换顶层无需回调
            if (committed > 0) _schedActive(_slots[0]);
            var f = Math.max(-1, Math.min(1, frac));   // 右拖>0，左拖<0
            var af = Math.abs(f);
            // 频谱竖条高度随拖动相位起伏（拖动越快/越多起伏越明显）
            _animateBars(_dragOffset * 0.05);
            _slots.forEach(function (c, i) {
                var d = c._dom;
                // 卡体始终不透明（opacity:1），靠 translateX 错位 + z-index 区分层次；只有滑出/滑入的卡淡出可见
                if (i === 0) {
                    // top：右拖向右滑出消失(op→0)；左拖左移退到 mid 位(x:0→-24) 露 spine
                    if (f >= 0) {
                        d.style.transform = 'translateX(' + (af * 100) + '%)';
                        d.style.opacity = 1 - af;
                    } else {
                        d.style.transform = 'translateX(' + (-24 * af) + 'px)';
                        d.style.opacity = 1;
                    }
                } else if (i === 1) {
                    // mid：右拖左移归位浮上 top(x:-24→0)；左拖退到 bot 位(x:-24→-48)
                    if (f >= 0) {
                        d.style.transform = 'translateX(' + (-24 + 24 * f) + 'px)';
                        d.style.opacity = 1;
                    } else {
                        d.style.transform = 'translateX(' + (-24 - 24 * af) + 'px)';
                        d.style.opacity = 1;
                    }
                } else {
                    // bot：右拖升 mid(x:-48→-24)；左拖原地淡出(op→0)，top 由临时卡补位
                    if (f >= 0) {
                        d.style.transform = 'translateX(' + (-48 + 24 * af) + 'px)';
                        d.style.opacity = 1;
                    } else {
                        d.style.transform = 'translateX(-48px)';
                        d.style.opacity = 1 - af;
                    }
                }
            });
            // 临时卡补位：右拖从左滑入 bot(显示 top 标题)；左拖从右滑入 top(显示 bot 标题)
            // 层级：右拖时临时页作为底卡（z-index 5，低于 slot-bot 10），不盖上面浮上的真实页；
            // 左拖时作为新顶卡（z-index 35，高于 slot-top 30）浮在最上层。
            var cw = (stack.clientWidth || 600) - 48;
            if (f >= 0) {
                _temp.style.zIndex = '5';
                _tempSpine.textContent = _slots[0] ? _slots[0].label : '';
                _temp.style.transform = 'translateX(' + (-cw * 0.8 + (cw * 0.8 - 48) * af) + 'px)';
                _temp.style.opacity = String(af);
            } else {
                _temp.style.zIndex = '35';
                _tempSpine.textContent = _slots[2] ? _slots[2].label : '';
                _temp.style.transform = 'translateX(' + (cw * 0.8 * (1 - af)) + 'px)';
                _temp.style.opacity = String(af);
            }
        }
        _handle.addEventListener('pointerup', function (e) {
            if (!_dragging) return;
            _dragging = false;
            _handle.classList.remove('dragging');
            // 同步用最后 pointer 位置算 _dragOffset——不依赖 rAF 回调（快速拖动时 up 可能早于最后一帧 rAF，
            // 导致 _dragOffset 过时/为 0，吸附 steps=0 误判回弹不切换）
            _dragOffset = _lastMoveX - _dragStartX;
            _segW = (stack.clientWidth || 600) / 6;
            // 惯性：用松手前最近 ~100ms 的位移估算速度（px/ms），预测松手后还会滑行的距离（flick）
            var flick = 0;
            if (_velSamples.length >= 2) {
                var s0 = _velSamples[0], s1 = _velSamples[_velSamples.length - 1];
                var dt = s1.t - s0.t;
                if (dt > 0) {
                    var v = (s1.x - s0.x) / dt;   // px/ms，与拖动方向同号
                    flick = v * 300;              // 预测 300ms 惯性滑行距离
                    var cap = _segW * 3;
                    if (flick > cap) flick = cap;
                    if (flick < -cap) flick = -cap;
                }
            }
            // flick 足够大 → 先惯性滑行再吸附；否则直接吸附（原地回弹或切一格）
            if (Math.abs(flick) > _segW * 0.15) {
                _startCoast(flick);
            } else {
                cards.forEach(function (c) { c._dom.style.transition = ''; c._dom.style.transform = ''; c._dom.style.opacity = ''; });
                _temp.style.transition = '';
                _finalizeSnap();
            }
        });
        // ── 惯性滑行 + 吸附 ──
        // 松手后 flick 转成衰减的 rAF 循环，卡片继续按速度滑动（过阈值实时转 slots），
        // 速度衰减到阈值以下时吸附到最近槽位。
        function _startCoast(flickPx) {
            _coasting = true;
            _coastVelocity = flickPx / 18;   // 300ms 预测 → 每帧位移（~16.67ms/帧 ≈ 18帧）
            var FRICTION = 0.90;             // 每帧衰减系数
            var STOP_THRESH = 0.3;           // 速度低于此值停止滑行

            function step() {
                if (!_coasting) return;
                _coastVelocity *= FRICTION;
                if (Math.abs(_coastVelocity) < STOP_THRESH) {
                    // 滑行结束 → 恢复 transition，吸附到最近槽位
                    _coasting = false;
                    _coastRafId = 0;
                    cards.forEach(function (c) { c._dom.style.transition = ''; c._dom.style.transform = ''; c._dom.style.opacity = ''; });
                    _temp.style.transition = '';
                    _finalizeSnap();
                    return;
                }
                _lastMoveX += _coastVelocity;
                _dragOffset = _lastMoveX - _dragStartX;
                _applyDragOffset();
                _coastRafId = (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(step);
            }
            _coastRafId = (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(step);
        }
        function _stopCoast() {
            _coasting = false;
            if (_coastRafId) {
                if (window.cancelAnimationFrame) cancelAnimationFrame(_coastRafId);
                else clearTimeout(_coastRafId);
                _coastRafId = 0;
            }
            // 完整清理：拖拽/滑行写下的 transition:'none' 与每帧 inline transform/opacity 若不清，
            // inline 样式优先级高于 class，卡片会冻结在滑行被打断瞬间的位置（switchTo 只改 class）。
            // 清空后卡片回到 CSS 的槽位样式并经 transition 动画归位；
            // .assets-card-temp 静息态 opacity:0，清空即回隐藏。吸附收尾由调用方（自然停止分支/_finalizeSnap）负责。
            cards.forEach(function (c) { c._dom.style.transition = ''; c._dom.style.transform = ''; c._dom.style.opacity = ''; });
            _temp.style.transition = '';
            _temp.style.transform = '';
            _temp.style.opacity = '';
            _temp.style.zIndex = '';
        }
        // 吸附：按 _dragOffset 四舍五入到最近槽位数，然后调用 switchTo 或回弹。
        function _finalizeSnap() {
            var steps = Math.round(_dragOffset / _segW);
            if (steps !== 0) {
                var n = _slots.length;
                var norm = ((steps % n) + n) % n;
                if (norm > 0) {
                    switchTo(_slots[norm].id);
                } else {
                    _lastDir = 0;
                    _applySlots();   // 拖满整圈回原位
                    _temp.style.opacity = '0';
                    _temp.style.transform = '';
                    _temp.style.zIndex = '';
                }
            } else {
                _lastDir = 0;
                _applySlots();   // 回弹到原位
                _temp.style.opacity = '0';
                _temp.style.transform = '';
                _temp.style.zIndex = '';
            }
            _dragOffset = 0;
        }

        _handle.addEventListener('pointercancel', function () {
            if (!_dragging) return;
            _dragging = false;
            _stopCoast();
            _velSamples = [];
            _handle.classList.remove('dragging');
            cards.forEach(function (c) { c._dom.style.transition = ''; c._dom.style.transform = ''; c._dom.style.opacity = ''; });
            _temp.style.transition = '';
            _lastDir = 0;
            _applySlots();   // 回弹
            _temp.style.opacity = '0';
            _temp.style.transform = '';
            _temp.style.zIndex = '';
        });

        return { mount: mount, switchTo: switchTo, destroy: destroy };
    }

    global.AEAssetsShared.nextSlots = nextSlots;
    global.AEAssetsShared.createCardStack = createCardStack;
})(window);
