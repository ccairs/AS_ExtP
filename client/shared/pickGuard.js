// 全局文件/文件夹选择锁
// 统一封装 ExtendScript 的 File.openDialog / Folder.selectDialog 调用，
// 提供全局互斥锁，避免多个选择框并发或回调操作已关闭面板造成脏数据。
// 选择框弹出期间显示全屏模糊黑屏遮罩，阻断所有 HTML 层交互（含 notice/toast/modal/主面板）。
// 调用方仍需在 onPicked 回调内自行校验"上下文是否还活着"（如面板是否仍打开）。
(function (global) {
    'use strict';

    var _busy = false;
    var _overlay = null;
    var _timer = null;
    // 兜底超时：ExtendScript 选择框回调丢失（AE 崩溃/无响应）时自动恢复界面，防止遮罩永久卡住导致扩展变黑
    var PICK_TIMEOUT = 120 * 1000;

    // 懒创建全屏遮罩（首次 lock 时创建，之后复用）
    function _ensureOverlay() {
        if (_overlay) return _overlay;
        if (typeof document === 'undefined' || !document.body) return null;
        _overlay = document.createElement('div');
        _overlay.id = 'aepick-overlay';
        // z-index 用 int32 最大值，确保覆盖所有元素（notice 9000 / modal 9999 / customSelect 2147483647）
        // 注意：ExtendScript 选择框是 OS 级窗口，不受此遮罩影响
        _overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;'
            + 'background:rgba(0,0,0,0.45);'
            + 'backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);'
            + 'display:none;cursor:default;'
            + 'align-items:center;justify-content:center;';
        // 居中提示卡片
        _overlay.innerHTML = '<div style="padding:28px 40px;border-radius:14px;'
            + 'background:rgba(28,30,38,0.92);color:#e8eaf0;font-size:15px;'
            + 'box-shadow:0 10px 40px rgba(0,0,0,0.4);text-align:center;line-height:1.6;'
            + 'border:1px solid rgba(255,255,255,0.08);max-width:80vw;">'
            + AEI18n.html('请在弹出的对话框中操作…<br>')
            + AEI18n.html('<span style="font-size:13px;color:#9ca3af;">完成后将自动返回</span>')
            + '<button type="button" style="display:block;margin:14px auto 0;padding:6px 16px;'
            + 'border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);'
            + 'color:#cbd0da;font-size:13px;cursor:pointer;">'
            + AEI18n.t('对话框已关闭，点击恢复')
            + '</button>'
            + '</div>';
        // 点击遮罩/按钮强制恢复界面：OS 对话框正常弹出时用户点不到 HTML 层，
        // 因此点击只会发生在对话框已消失/崩溃后，用于手动脱困
        _overlay.addEventListener('click', function () {
            if (!_busy) return;
            console.warn('[AEPickGuard] 用户手动恢复界面');
            _unlock();
        });
        document.body.appendChild(_overlay);
        return _overlay;
    }

    function isBusy() {
        return _busy;
    }

    // 转义 ExtendScript 字符串字面量中的双引号、反斜杠和换行符
    // U+2028/U+2029 是 ES3 字符串字面量中的行终止符，未转义会让整条 evalScript 解析失败
    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    // 锁定：显示遮罩 + 设置标志 + 启动兜底超时
    function _lock() {
        _busy = true;
        var ov = _ensureOverlay();
        if (ov) ov.style.display = 'flex';
        _clearTimer();
        _timer = setTimeout(function () {
            _timer = null;
            console.warn('[AEPickGuard] 选择框回调超时，已自动恢复界面（AE 可能崩溃或无响应）');
            _unlock();
        }, PICK_TIMEOUT);
    }
    // 解锁：隐藏遮罩 + 清除标志 + 取消兜底定时器
    function _unlock() {
        _clearTimer();
        _busy = false;
        if (_overlay) _overlay.style.display = 'none';
    }

    function _clearTimer() {
        if (_timer) { clearTimeout(_timer); _timer = null; }
    }

    // 通用包装：管理锁 + 调用 evalScript + 回调释放锁
    // multiSelect=true 时 onPicked(paths) 收到路径数组（空数组=取消/失败），否则 onPicked(path) 收到单个路径字符串
    function _wrap(script, onPicked, multiSelect) {
        if (_busy) return false; // 防并发
        if (typeof CSInterface === 'undefined') {
            // 非宿主环境（如浏览器调试）：直接回调空结果
            try { onPicked(multiSelect ? [] : ''); } catch (e) { console.error('[AEPickGuard] onPicked error:', e); }
            return true;
        }
        _lock();
        try {
            new CSInterface().evalScript(script, function (res) {
                _unlock();
                try {
                    if (multiSelect) {
                        // ExtendScript 用换行拼接返回，按换行拆分（Windows 文件名不允许换行符，分隔安全）
                        var arr = [];
                        if (res) {
                            var s = String(res).trim();
                            if (s) arr = s.split('\n').filter(function (x) { return x.length > 0; });
                        }
                        onPicked(arr);
                    } else {
                        onPicked(res ? String(res).trim() : '');
                    }
                } catch (e) { console.error('[AEPickGuard] onPicked error:', e); }
            });
        } catch (e) {
            _unlock();
            console.error('[AEPickGuard] evalScript error:', e);
            try { onPicked(multiSelect ? [] : ''); } catch (_) {}
        }
        return true;
    }

    // 弹文件选择框
    // options: { title, filter, multiSelect }
    // onPicked: 单选时 (path) 空串表示取消或失败；多选时 (paths) 空数组表示取消或失败
    // 返回 true=已启动选择框，false=已有选择框进行中
    function pickFile(options, onPicked) {
        options = options || {};
        var title = _esc(options.title || '选择文件');
        var filter = _esc(options.filter || 'Images:*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp');
        var multi = !!options.multiSelect;
        var es = '(function(){var f=File.openDialog("' + title + '","' + filter + '",' + (multi ? 'true' : 'false') + ');'
            + (multi
                ? 'if(!f||!f.length)return"";var a=[];for(var i=0;i<f.length;i++){a.push(String(f[i].fsName));}return a.join("\\n");'
                : 'return f?String(f.fsName):"";')
            + '})();';
        return _wrap(es, onPicked, multi);
    }

    // 弹文件夹选择框
    // options: { title }
    // onPicked(path): path 为空串表示取消或失败
    function pickFolder(options, onPicked) {
        options = options || {};
        var title = _esc(options.title || '选择目录');
        var es = '(function(){var d=Folder.desktop;if(d&&d.exists&&typeof d.selectDlg==="function"){var f=d.selectDlg("' + title + '");return f?String(f.fsName):"";}var f=Folder.selectDialog("' + title + '");return f?String(f.fsName):"";})();';
        return _wrap(es, onPicked);
    }

    global.AEPickGuard = {
        isBusy: isBusy,
        pickFile: pickFile,
        pickFolder: pickFolder
    };
})(typeof window !== 'undefined' ? window : this);
