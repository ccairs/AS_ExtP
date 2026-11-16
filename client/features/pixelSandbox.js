/**
 * 像素物理沙盒 彩蛋
 * 触发：Konami Code ↑↑↓↓←→←→BA
 * 快捷键关闭：ESC
 */
(function () {
    'use strict';

    var KONAMI = [
        'ArrowUp', 'ArrowUp',
        'ArrowDown', 'ArrowDown',
        'ArrowLeft', 'ArrowRight',
        'ArrowLeft', 'ArrowRight',
        'KeyB', 'KeyA'
    ];
    var konamiIdx = 0;
    var sandboxOpen = false;
    var bodyOverflow = '';
    // 关闭退场定时器句柄：openSandbox 入口清掉在途的迟到清理
    // （关闭后 220ms 内快速重开时，迟到的 display='none' 会把刚打开的沙盒藏掉）
    var _closeTimer = null;

    function isInputFocused() {
        var el = document.activeElement;
        if (!el) return false;
        var tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    function openSandbox() {
        if (sandboxOpen) return;
        // 取消在途的关闭退场定时器，防迟到的 display='none' 藏掉刚重开的沙盒
        if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
        sandboxOpen = true;

        // 防止滚动穿透
        bodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        var mask = document.getElementById('sandboxModal');
        var iframe = document.getElementById('sandboxIframe');
        iframe.src = 'features/pixel-sandbox.html';
        mask.style.display = 'flex';
        requestAnimationFrame(function () {
            mask.style.opacity = '1';
            var modal = mask.querySelector('.modal');
            if (modal) {
                // 重置拖拽残留的内联样式，恢复 flex 居中
                modal.style.position = '';
                modal.style.left = '';
                modal.style.top = '';
                modal.style.margin = '';
                modal.style.opacity = '1';
                modal.style.transform = 'translateY(0) scale(1)';
            }
        });
    }

    function closeSandbox() {
        if (!sandboxOpen) return;
        sandboxOpen = false;

        document.body.style.overflow = bodyOverflow;

        var mask = document.getElementById('sandboxModal');
        var modal = mask.querySelector('.modal');
        if (modal) {
            modal.style.opacity = '0';
            modal.style.transform = 'translateY(10px) scale(0.98)';
        }
        mask.style.opacity = '0';
        _closeTimer = setTimeout(function () {
            _closeTimer = null;
            mask.style.display = 'none';
            // 释放 iframe 内存
            document.getElementById('sandboxIframe').src = 'about:blank';
        }, 220);
    }

    // 关闭按钮
    document.getElementById('closeSandboxBtn').addEventListener('click', closeSandbox);

    // ESC 关闭（父页面）
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && sandboxOpen) {
            closeSandbox();
        }
    });

    // ESC 关闭（iframe 内 focus → postMessage 过来）
    window.addEventListener('message', function (e) {
        if (e.data === 'sandbox-close' && sandboxOpen) {
            closeSandbox();
        }
    });

    // 暴露给全局（供彩蛋回调等外部触发）
    window.AEPixelSandbox = { open: openSandbox, close: closeSandbox };

    // Konami Code 监听
    document.addEventListener('keydown', function (e) {
        if (sandboxOpen) return;  // 已打开，不重复触发
        if (isInputFocused()) return;  // 输入框中不触发

        if (e.code === KONAMI[konamiIdx]) {
            konamiIdx++;
            if (konamiIdx === KONAMI.length) {
                konamiIdx = 0;
                if (typeof window.aeBeep === 'function') window.aeBeep('konami');
                openSandbox();
            }
        } else {
            // 允许从序列中间重试（按错第一个键重新开始）
            konamiIdx = (e.code === KONAMI[0]) ? 1 : 0;
        }
    });
})();