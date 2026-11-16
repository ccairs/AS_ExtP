(function (global) {
    function createCepBridge() {
        return {
            isAvailable() {
                return typeof CSInterface !== 'undefined' || typeof global.CSInterface !== 'undefined';
            },
            create() {
                if (!this.isAvailable()) {
                    return null;
                }
                return new (typeof CSInterface !== 'undefined' ? CSInterface : global.CSInterface)();
            },
            evalScript(script, timeoutMs, callback) {
                const csInterface = this.create();
                if (!csInterface) {
                    callback({ ok: false, result: '', error: 'CSINTERFACE_UNAVAILABLE' });
                    return;
                }

                // timeoutMs 为 undefined/0 时使用默认值，避免 setTimeout(fn, 0) 立即超时
                const effectiveTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 10000;
                let finished = false;
                const timer = setTimeout(() => {
                    if (finished) {
                        return;
                    }
                    finished = true;
                    callback({ ok: false, result: '', error: 'EVAL_TIMEOUT_' + effectiveTimeout });
                }, effectiveTimeout);

                try {
                    csInterface.evalScript(script, (result) => {
                        if (finished) {
                            return;
                        }
                        finished = true;
                        clearTimeout(timer);
                        callback({ ok: true, result: typeof result === 'string' ? result : '', error: null });
                    });
                } catch (e) {
                    if (finished) {
                        return;
                    }
                    finished = true;
                    clearTimeout(timer);
                    callback({ ok: false, result: '', error: 'EVAL_EXCEPTION:' + e.toString() });
                }
            }
        };
    }

    global.AEPlatform = global.AEPlatform || {};
    global.AEPlatform.createCepBridge = createCepBridge;
})(window);
