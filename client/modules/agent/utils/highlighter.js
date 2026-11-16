(function (global) {
    function isPrismReady() {
        return !!(global.Prism && global.Prism.languages && global.Prism.languages.javascript && global.Prism.highlight);
    }

    function loadPrismJs(options) {
        const opts = options || {};
        const {
            setLoaded,
            getLoadAttempts,
            setLoadAttempts,
            updateStatus,
            onReady
        } = opts;

        if (isPrismReady()) {
            if (typeof setLoaded === 'function') setLoaded(true);
            if (typeof updateStatus === 'function') updateStatus('Prism: loaded');
            if (typeof onReady === 'function') onReady();
            return;
        }

        const attempts = (typeof getLoadAttempts === 'function' ? getLoadAttempts() : 0) + 1;
        if (typeof setLoadAttempts === 'function') setLoadAttempts(attempts);

        if (attempts > 30) {
            if (typeof updateStatus === 'function') updateStatus('Prism: load failed');
            return;
        }

        if (typeof updateStatus === 'function') updateStatus('Prism: waiting... (' + attempts + ')');
        setTimeout(function () {
            if (typeof setLoaded === 'function') setLoaded(isPrismReady());
            loadPrismJs(opts);
        }, 100);
    }

    function highlightCode(options) {
        const opts = options || {};
        const {
            code,
            forceReload,
            lastHighlightedCode,
            setLastHighlightedCode,
            updateStatus,
            onPrismMissing,
            setHighlightedHtml
        } = opts;

        if (!code) {
            setHighlightedHtml('');
            setLastHighlightedCode('');
            return;
        }

        if (code === lastHighlightedCode && !forceReload && isPrismReady()) {
            return;
        }

        if (!isPrismReady()) {
            // 不在此处记录 lastHighlightedCode：Prism 就绪后的重试若发现
            // code === lastHighlightedCode 会提前返回，高亮将永久丢失
            if (typeof updateStatus === 'function') updateStatus('Prism: loading...');
            if (typeof onPrismMissing === 'function') onPrismMissing();
            return;
        }

        setLastHighlightedCode(code);

        if (typeof updateStatus === 'function') updateStatus('Prism: OK');

        try {
            const highlighted = global.Prism.highlight(code, global.Prism.languages.javascript, 'javascript');
            setHighlightedHtml(highlighted + '\n');
        } catch (e) {
            if (typeof updateStatus === 'function') {
                updateStatus('Prism error: ' + (e && e.message ? e.message : 'unknown'));
            }
        }
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.previewHighlighter = {
        isPrismReady,
        loadPrismJs,
        highlightCode
    };
})(window);
