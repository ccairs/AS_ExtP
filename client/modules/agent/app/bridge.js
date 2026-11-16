(function (global) {
    function isCsInterfaceAvailable() {
        return typeof global.CSInterface !== 'undefined';
    }

    function getExtensionPathFromLocation(win) {
        const runtimeWindow = win || global;
        const rawUrl = runtimeWindow.location.href.split('?')[0].split('#')[0];
        const withoutProtocol = rawUrl.replace(/^file:\/\//i, '');
        let decoded = decodeURIComponent(withoutProtocol);

        if (/^\/[A-Za-z]:\//.test(decoded)) {
            decoded = decoded.substring(1);
        }

        const winPath = decoded.replace(/\//g, '\\');
        return winPath.replace(/\\client\\[^\\]*$/, '');
    }

    function getSystemPathSafe(options) {
        const csInterface = options && options.csInterface;
        const key = options && options.key;
        const runtimeWindow = (options && options.window) || global;
        const folderType = csInterface && (csInterface.FolderType || (runtimeWindow.CSInterface && runtimeWindow.CSInterface.prototype && runtimeWindow.CSInterface.prototype.FolderType) || {});

        if (!csInterface) {
            throw new Error('CS_INTERFACE_REQUIRED');
        }

        if (typeof csInterface.getSystemPath === 'function') {
            try {
                if (typeof SystemPath !== 'undefined' && SystemPath[key]) {
                    return csInterface.getSystemPath(SystemPath[key]);
                }
                const fallbackSystemPathMap = {
                    USER_DATA: 'userData',
                    EXTENSION: 'extension'
                };
                return csInterface.getSystemPath(fallbackSystemPathMap[key]);
            } catch (_) {}
        }

        if (key === 'EXTENSION') {
            if (typeof csInterface.getExtensionPath === 'function') {
                try {
                    return csInterface.getExtensionPath();
                } catch (_) {}
            }
            return getExtensionPathFromLocation(runtimeWindow);
        }

        if (key === 'USER_DATA') {
            if (typeof csInterface.getUserFolder === 'function') {
                try {
                    if (folderType.USER_DATA) {
                        return csInterface.getUserFolder(folderType.USER_DATA);
                    }
                    return csInterface.getUserFolder('USER_DATA');
                } catch (_) {
                    try {
                        if (folderType.DESKTOP) {
                            return csInterface.getUserFolder(folderType.DESKTOP);
                        }
                        return csInterface.getUserFolder('DESKTOP');
                    } catch (_) {}
                }
            }
            // USER_DATA 无 location 兜底——getExtensionPathFromLocation 返回扩展目录，不是 AppData
        }

        throw new Error(`不支持的路径API: ${key}`);
    }

    function evalScriptWithTimeout(options) {
        const csInterface = options && options.csInterface;
        const script = options && options.script;
        const timeoutMs = options && options.timeoutMs;
        const callback = options && options.callback;

        if (!csInterface || typeof callback !== 'function') {
            return;
        }

        let finished = false;
        const timer = setTimeout(() => {
            if (finished) {
                return;
            }
            finished = true;
            callback({ ok: false, result: '', error: `EVAL_TIMEOUT_${timeoutMs}` });
        }, timeoutMs);

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
            callback({ ok: false, result: '', error: `EVAL_EXCEPTION:${e.toString()}` });
        }
    }

    function checkHostBridgeState(options) {
        const csInterface = options && options.csInterface;
        const callback = options && options.callback;
        const timeoutMs = (options && options.timeoutMs) || 4000;
        const checkScript = '(function(){try{return (typeof getApplicationInfo === "function") ? "OK" : "MISSING_HOST_FUNCTIONS";}catch(e){return "ERROR:" + e.toString();}})();';

        evalScriptWithTimeout({
            csInterface,
            script: checkScript,
            timeoutMs,
            callback: (resp) => {
                if (!resp.ok) {
                    callback(resp.error || '__EMPTY_RESULT__');
                    return;
                }
                callback((resp.result && resp.result.length > 0) ? resp.result : '__EMPTY_RESULT__');
            }
        });
    }

    function loadHostScript(options) {
        const csInterface = options && options.csInterface;
        const callback = options && options.callback;
        const runtimeWindow = (options && options.window) || global;
        const timeoutMs = (options && options.timeoutMs) || 4000;

        try {
            const extensionPath = (getSystemPathSafe({ csInterface, key: 'EXTENSION', window: runtimeWindow }) || '').replace(/\\/g, '/');
            if (!extensionPath) {
                callback('ERROR:EXTENSION_PATH_EMPTY');
                return;
            }

            const hostScriptPath = `${extensionPath}/host/host.jsx`;
            // 与 client/main.js 同款——host.jsx 真机上 $.fileName 锚不到自身（实测返回
            // 裸序号，按 AE Support Files 解析），本加载点若不注入扩展根，host.jsx 会走
            // 坏回退（根目录算成 AE 应用目录）→ hostApi 全失败 + 桥自启动被守卫拦下。
            const rootJs = extensionPath.replace(/\\/g, '/').replace(/[\\/]+$/, '')
                .replace(/"/g, '\\"')
                .replace(/\u2028/g, '\\u2028')
                .replace(/\u2029/g, '\\u2029');
            const loadScript = `(function(){
            try {
                __AS_EXTP_ROOT = "${rootJs}";
                $.evalFile("${hostScriptPath.replace(/\\/g, '/').replace(/"/g, '\\"')}");
                return "LOADED";
            } catch(e) {
                return "ERROR:" + e.toString();
            }
        })();`;

            evalScriptWithTimeout({
                csInterface,
                script: loadScript,
                timeoutMs,
                callback: (resp) => {
                    if (!resp.ok) {
                        callback(resp.error || '__EMPTY_RESULT__');
                        return;
                    }
                    const result = resp.result || '';
                    if (result.indexOf('ERROR:') === 0) {
                        callback(result);
                        return;
                    }
                    callback((result.length > 0) ? result : '__EMPTY_RESULT__');
                }
            });
        } catch (e) {
            callback(`ERROR:LOAD_HOST_EXCEPTION:${e.toString()}`);
        }
    }

    function injectHostBridgeFunctions(options) {
        const csInterface = options && options.csInterface;
        const callback = options && options.callback;
        const timeoutMs = (options && options.timeoutMs) || 4000;

        const injectScript = `(function(){
        try {
            // host.jsx 加载失败时的最小兜底 mock
            // 仅注入 health check 必需的 getApplicationInfo
            // （runScriptFromFile 已删除：零调用方且为沙箱穿透面，不再兜底注入）
            if (typeof getApplicationInfo !== "function") {
                getApplicationInfo = function() {
                    return { name: app.name, version: app.version, path: app.path };
                };
            }
            return "INJECTED";
        } catch (e) {
            return "ERROR:" + e.toString();
        }
    })();`;

        evalScriptWithTimeout({
            csInterface,
            script: injectScript,
            timeoutMs,
            callback: (resp) => {
                if (!resp.ok) {
                    callback(resp.error || '__EMPTY_RESULT__');
                    return;
                }
                callback((resp.result && resp.result.length > 0) ? resp.result : '__EMPTY_RESULT__');
            }
        });
    }

    function ensureHostBridgeReady(options) {
        const csInterface = options && options.csInterface;
        const callback = options && options.callback;
        const runtimeWindow = (options && options.window) || global;
        const maxRetries = (options && options.maxRetries) || 3;

        function loadMcpTools(thenCallback) {
            try {
                // 不再依赖构建产物 window.AE_TOOLS_CODE，运行时直接读 aeTools.jsx 源注入。
                var extPath = getExtensionPathFromLocation(runtimeWindow);
                if (!extPath) {
                    thenCallback('MCP_CODE_UNAVAILABLE');
                    return;
                }
                var jsxPath = extPath + '\\client\\modules\\ae-tools\\aeTools.jsx';
                var readFn = (global.AEFS && typeof global.AEFS.readFile === 'function')
                    ? global.AEFS.readFile : null;
                if (!readFn) {
                    thenCallback('MCP_CODE_UNAVAILABLE');
                    return;
                }
                Promise.resolve(readFn(jsxPath)).then(function (code) {
                    if (!code || typeof code !== 'string' || code.length < 200) {
                        thenCallback('MCP_CODE_UNAVAILABLE');
                        return;
                    }
                    csInterface.evalScript(code, function (result) {
                        var status = String(result || '');
                        if (status === 'MCP_LOADED') {
                            thenCallback('OK');
                        } else {
                            thenCallback(status || 'MCP_LOAD_FAILED');
                        }
                    });
                }).catch(function () {
                    thenCallback('MCP_CODE_UNAVAILABLE');
                });
            } catch (e) {
                // 同步异常（如 getExtensionPathFromLocation 取 location 抛错）与下方异步
                // 失败同口径：返回 MCP_CODE_UNAVAILABLE。原 `thenCallback('OK')` 让外层
                // 健康检查报就绪但 aeTools 从未注入（假成功）。
                thenCallback('MCP_CODE_UNAVAILABLE');
            }
        }

        function doCheckHostBridgeState(retryCount) {
            checkHostBridgeState({
                csInterface,
                callback: (state) => {
                    if (state === 'OK') {
                        loadMcpTools(callback);
                        return;
                    }

                    if (state === 'MISSING_HOST_FUNCTIONS' || state === '__EMPTY_RESULT__') {
                        loadHostScript({
                            csInterface,
                            window: runtimeWindow,
                            callback: (loadState) => {
                                if ((loadState || '').indexOf('ERROR:') === 0 || loadState === '__EMPTY_RESULT__') {
                                    injectHostBridgeFunctions({
                                        csInterface,
                                        callback: (injectState) => {
                                            if ((injectState || '').indexOf('ERROR:') === 0 || injectState === '__EMPTY_RESULT__') {
                                                callback('HOST_LOAD_FAILED:' + loadState);
                                                return;
                                            }
                                            checkHostBridgeState({
                                                csInterface,
                                                callback: (injectCheckState) => {
                                                    if (injectCheckState === 'OK') {
                                                        loadMcpTools(callback);
                                                    } else {
                                                        callback('HOST_NOT_READY:' + injectCheckState);
                                                    }
                                                }
                                            });
                                        }
                                    });
                                    return;
                                }

                                checkHostBridgeState({
                                    csInterface,
                                    callback: (recheckState) => {
                                        if (recheckState === 'OK') {
                                            loadMcpTools(callback);
                                            return;
                                        }

                                        injectHostBridgeFunctions({
                                            csInterface,
                                            callback: (injectState) => {
                                                if ((injectState || '').indexOf('ERROR:') === 0 || injectState === '__EMPTY_RESULT__') {
                                                    callback('HOST_NOT_READY:' + recheckState);
                                                    return;
                                                }
                                                checkHostBridgeState({
                                                    csInterface,
                                                    callback: (injectCheckState) => {
                                                        if (injectCheckState === 'OK') {
                                                            loadMcpTools(callback);
                                                        } else {
                                                            callback('HOST_NOT_READY:' + injectCheckState);
                                                        }
                                                    }
                                                });
                                            }
                                        });
                                    }
                                });
                            }
                        });
                        return;
                    }

                    var isTimeout = (state || '').indexOf('EVAL_TIMEOUT_') === 0 || (state || '').indexOf('EVAL_EXCEPTION:') === 0;
                    if (isTimeout && retryCount < maxRetries) {
                        setTimeout(function () {
                            doCheckHostBridgeState(retryCount + 1);
                        }, 1500);
                        return;
                    }

                    callback(state);
                }
            });
        }

        doCheckHostBridgeState(0);
    }

    let csInterfaceScript = null;

    function loadCsInterfaceIfNeeded(options) {
        const callback = options && options.callback;
        const doc = (options && options.document) || global.document;

        if (typeof global.CSInterface !== 'undefined') {
            if (callback) {
                callback();
            }
            return;
        }

        csInterfaceScript = doc.createElement('script');
        csInterfaceScript.src = 'vendor/CSInterface.js';
        csInterfaceScript.onload = () => {
            setTimeout(() => {
                if (callback) {
                    callback();
                }
            }, 200);
        };
        csInterfaceScript.onerror = () => {
            setTimeout(() => {
                if (callback) {
                    callback();
                }
            }, 200);
        };
        doc.head.appendChild(csInterfaceScript);
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.hostBridgeAdapter = {
        isCsInterfaceAvailable,
        getSystemPathSafe,
        evalScriptWithTimeout,
        injectHostBridgeFunctions,
        ensureHostBridgeReady,
        loadCsInterfaceIfNeeded
    };
})(window);
