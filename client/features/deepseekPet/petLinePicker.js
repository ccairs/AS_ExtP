// petLinePicker.js — 台词池取样：洗牌袋 + 最近若干条排除
// 一轮内每句只播一次；轮末重洗，最近 N 条不进入新一轮，跨轮也不会相邻重样。
// 语料按文本比较（各池读取时都按当前语言重新求值），池子或语料变化时袋子自动作废。
(function (global) {
    'use strict';

    // Fisher-Yates，原地洗牌
    function _shuffle(list) {
        for (var i = list.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var temp = list[i];
            list[i] = list[j];
            list[j] = temp;
        }
        return list;
    }

    function _min(a, b) { return a < b ? a : b; }

    // 语料签名：首句 + 条数 + 末句。台词池是字面量数组，切换界面语言时文本整体变化
    function _signatureOf(pool) {
        return pool.length + '#' + pool[0] + '#' + pool[pool.length - 1];
    }

    function createLinePicker(options) {
        var opts = options || {};
        // 最近多少条不进入候选；池子不足时自动收缩，最小的池子也能取到词
        var recentLimit = (typeof opts.recentLimit === 'number' && opts.recentLimit >= 1)
            ? opts.recentLimit
            : 12;

        var _key = null;        // 池子标识（day / night / dream）
        var _signature = null;  // 当前语料签名
        var _bag = [];          // 待播队列，已洗牌
        var _recent = [];       // 最近播过的池内台词，最新在后
        var _said = [];         // 最近说过的全部台词（含外部生成的），最新在后

        function _toSet(pool) {
            var set = {};
            for (var i = 0; i < pool.length; i++) set[pool[i]] = true;
            return set;
        }

        // 参与排除的条数上限：至少给候选留两条
        function _excludeCap(poolLength) {
            var room = poolLength - 2;
            return room > 0 ? _min(recentLimit, room) : 0;
        }

        // 保留的最近记录条数：排除为空时也记住最后一句，跨轮衔接靠它
        function _keepCap(poolLength) {
            var cap = _excludeCap(poolLength);
            return cap > 0 ? cap : 1;
        }

        function _keepInPool(poolSet) {
            var kept = [];
            for (var i = 0; i < _recent.length; i++) {
                if (poolSet[_recent[i]]) kept.push(_recent[i]);
            }
            _recent = kept;
        }

        function _remember(text) {
            var line = String(text == null ? '' : text).trim();
            if (!line) return;
            _said.push(line);
            while (_said.length > recentLimit) _said.shift();
        }

        function _refill(pool, poolSet) {
            var i;
            _keepInPool(poolSet);

            var cap = _excludeCap(pool.length);
            var excluded = {};
            for (i = _recent.length - cap; i < _recent.length; i++) {
                if (i >= 0) excluded[_recent[i]] = true;
            }

            var candidates = [];
            for (i = 0; i < pool.length; i++) {
                if (!excluded[pool[i]]) candidates.push(pool[i]);
            }
            if (!candidates.length) candidates = pool.slice();

            _bag = _shuffle(candidates);

            // 跨轮衔接：新一轮第一句不与上一句相同
            var lastSaid = _recent.length ? _recent[_recent.length - 1] : null;
            if (lastSaid && _bag.length > 1 && _bag[0] === lastSaid) {
                var swap = 1 + Math.floor(Math.random() * (_bag.length - 1));
                var head = _bag[0];
                _bag[0] = _bag[swap];
                _bag[swap] = head;
            }
        }

        // 取下一句：同一 key 下按洗牌袋顺序播，换 key 重开一轮
        function pick(pool, key) {
            if (!pool || !pool.length) return '';
            var poolSet = _toSet(pool);
            var poolKey = key == null ? '' : String(key);
            var signature = _signatureOf(pool);

            if (poolKey !== _key) {
                // 换池：旧袋作废；最近记录保留，"最近说过"衔接同一语言下的两个池
                _key = poolKey;
                _signature = signature;
                _bag = [];
            } else if (signature !== _signature) {
                // 同池但语料文本变了（切换界面语言）：袋子与最近记录都失效
                _signature = signature;
                _bag = [];
                _recent = [];
                _said = [];
            }

            if (!_bag.length) _refill(pool, poolSet);

            var line = _bag.shift();
            _recent.push(line);
            var keep = _keepCap(pool.length);
            while (_recent.length > keep) _recent.shift();
            _remember(line);
            return line;
        }

        // 外部生成的台词（如 LLM 现写的）不进洗牌袋，只计入"最近说过"
        function remember(text) {
            _remember(text);
        }

        // 最近说过的台词，最新在后
        function recent(limit) {
            var n = (typeof limit === 'number' && limit > 0) ? limit : _said.length;
            return (n >= _said.length) ? _said.slice() : _said.slice(_said.length - n);
        }

        function reset() {
            _key = null;
            _signature = null;
            _bag = [];
            _recent = [];
            _said = [];
        }

        return { pick: pick, remember: remember, recent: recent, reset: reset };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createLinePicker = createLinePicker;
})(window);
