(function (global) {
    // 画布 undo/redo 历史栈：纯栈管理 + serialize/restore 回调注入。
    // serialize() 产出「当前状态快照对象」（可为按引用拼装的浅对象，见 canvasIndex 接线）；
    // **解耦在 push 内完成**——一次 JSON.stringify + parse 回独立对象入栈，历史条目不与源
    // 共享引用（审计：不得为省一次 stringify 退回共享引用）。restore(snap) 由调用方全量重建画布。
    //
    // 模型：操作后 push。undoStack 顶 = 当前状态。
    //   push  → 推当前状态入 undoStack，清空 redoStack（新操作使 redo 失效）
    //   undo  → 弹栈顶入 redoStack，restore 新栈顶（= 回到上一状态）
    //   redo  → 弹 redoStack 顶入 undoStack，restore 之
    //   restore 进行中 suppress=true，抑制其内部 markDirty 回灌触发的新 push
    //
    // 去重：与栈顶内容相同的快照不推（避免无变化占栈 / 防抖重复）。
    // 栈上限 maxSize，超限 shift 最旧。
    function createHistory(opts) {
        opts = opts || {};
        var MAX = opts.maxSize || 50;
        var serialize = opts.serialize;
        var restore = opts.restore;

        var undoStack = [];
        var redoStack = [];
        var suppress = false;   // restore 中抑制 push
        var _topKey = null;     // 栈顶快照的 JSON 串，用于 O(1) 去重比对

        function _key(snap) {
            try { return JSON.stringify(snap); } catch (e) { return ''; }
        }

        function push() {
            if (suppress || !serialize) return;
            var s = serialize();
            if (!s) return;
            // 一次序列化即解耦（审计）：JSON 串同时充当 ①与栈顶比对的去重键
            // ②入栈快照本体——parse 回独立对象，历史条目与源对象彻底解耦，后续编辑/改动
            // 源（graph/分组）不会污染旧快照。不得为省 CPU 直接入栈共享引用（旧快照会被
            // 后续修改污染），也不得退回「上游深拷贝 + 这里再 _key」的两次 stringify。
            var k = _key(s);
            if (!k) return;   // 不可序列化（循环引用等）：不入栈（旧行为会把共享引用推入栈）
            if (undoStack.length && k === _topKey) return;  // 与栈顶相同，跳过
            undoStack.push(JSON.parse(k));
            _topKey = k;
            if (undoStack.length > MAX) undoStack.shift();
            redoStack = [];
        }

        function undo() {
            if (undoStack.length <= 1) return false;  // 至少保留初始状态
            var current = undoStack.pop();
            redoStack.push(current);
            var prev = undoStack[undoStack.length - 1];
            suppress = true;
            try { restore(prev); } finally { suppress = false; }
            _topKey = _key(prev);
            return true;
        }

        function redo() {
            if (!redoStack.length) return false;
            var next = redoStack.pop();
            undoStack.push(next);
            suppress = true;
            try { restore(next); } finally { suppress = false; }
            _topKey = _key(next);
            return true;
        }

        function canUndo() { return undoStack.length > 1; }
        function canRedo() { return redoStack.length > 0; }

        // 重置栈（加载新画布 / 切换图时清空旧历史）
        function reset() {
            undoStack = [];
            redoStack = [];
            _topKey = null;
        }

        return {
            push: push,
            undo: undo,
            redo: redo,
            canUndo: canUndo,
            canRedo: canRedo,
            reset: reset
        };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createCanvasHistory = createHistory;
})(window);
