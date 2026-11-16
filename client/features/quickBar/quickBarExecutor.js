// quickBarExecutor.js — 4 类执行
(function (global) {
    'use strict';

    function _getHostApi() {
        try {
            if (global.AEPlatform && global.AEPlatform.hostApi) return global.AEPlatform.hostApi;
        } catch (_) {}
        return null;
    }

    function _getCachedSettings() {
        // 从全局 AE_LLM 读取 Agent 模块暴露的设置
        var settings = {};
        try {
            if (global.AE_LLM && global.AE_LLM._aeToolTimeoutMs) {
                settings.executionTimeoutMs = Number(global.AE_LLM._aeToolTimeoutMs) || 30000;
            }
        } catch (_) {}
        return settings;
    }

    // ===== 脚本执行（含安全闸门 + 沙箱）=====
    function executeScripts(items, options) {
        return new Promise(function (resolve) {
            if (!items || items.length === 0) {
                resolve({ ok: 0, fail: 0, errors: [] });
                return;
            }

            // 安全闸门：沙箱未就绪
            if (!(global.AE_LLM && global.AE_LLM._agentSafetyReady)) {
                resolve({
                    ok: 0,
                    fail: items.length,
                    errors: [AEI18n.t('安全措施未就绪，拒绝执行脚本')]
                });
                return;
            }

            // 总确认已由 quickBarIndex._executeItems 处理（联动 Agent 的 skipRunConfirm）
            var settings = _getCachedSettings();
            _runScriptsSerially(items, settings, resolve, options);
        });
    }

    function _runScriptsSerially(items, settings, resolve, options) {
        options = options || {};
        var results = { ok: 0, fail: 0, errors: [] };
        var idx = 0;

        function next() {
            if (idx >= items.length) {
                resolve(results);
                return;
            }
            if (options.isCancelled && options.isCancelled()) {
                // 取消出口必须**如实带 cancelled 标记**：
                // 四个取消出口都只回 `{ok, fail, errors}` 时，UI 只能靠「ok 与 fail 均为 0」反推取消
                // ⇒ 中途取消时（已有成功项）走的是**成功分支**，报「完成: 成功 N 项」，被跳过的项零痕迹。
                results.cancelled = true;
                resolve(results);
                return;
            }
            var item = items[idx++];
            if (options.onProgress) {
                try { options.onProgress(idx, item); } catch (_) {}
            }
            _runOneScript(item, settings).then(function (r) {
                if (r.ok) results.ok++;
                else { results.fail++; results.errors.push(item.name + ': ' + r.error); }
                next();
            }).catch(function (e) {
                results.fail++;
                results.errors.push(item.name + ': ' + (e && e.message ? e.message : e));
                next();
            });
        }
        next();
    }

    function _runOneScript(item, settings) {
        return new Promise(function (resolve) {
            if (!global.AEFS || typeof global.AEFS.readFile !== 'function') {
                resolve({ ok: false, error: AEI18n.t('AEFS 未就绪') });
                return;
            }
            global.AEFS.readFile(item.path).then(function (content) {
                if (!content || typeof content !== 'string') {
                    resolve({ ok: false, error: AEI18n.t('无法读取文件内容') });
                    return;
                }
                // hasSandboxBypass/hasDanger regex 并入 AST 审计
                // 确认层（_evalScript 内经门收口点）——文本层误伤注释/字符串的
                // 形态消亡；危险检测不再以 allowWrite 为前置（无权限也弹，防呆）
                _evalScript(content, settings, resolve, item.name);
            }).catch(function (e) {
                resolve({ ok: false, error: AEI18n.t('读取文件失败: {detail}', { detail: e && e.message ? e.message : e }) });
            });
        });
    }

    function _evalScript(content, settings, resolve, scriptName) {
        var _gateLib;
        try {
            // AST 编译门：库脚本走 user-library 审计模式（Task 6：
            // dangers 危险清单 + 确认层，emitted=原文——所存即所跑）
            _gateLib = (global.AE_LLM && typeof global.AE_LLM._runSandboxedScript === 'function')
                ? global.AE_LLM._runSandboxedScript(content, { source: 'user-library' })
                : { ok: true, emitted: content };
        } catch (e) {
            resolve({ ok: false, error: AEI18n.t('沙箱包装失败: {detail}', { detail: e && e.message ? e.message : e }) });
            return;
        }
        if (!_gateLib.ok) {
            var _src = (AEI18n.getLocale ? AEI18n.getLocale() : 'zh-CN') === (AEI18n.SOURCE_LOCALE || 'zh-CN');
            var _detail = _gateLib.displayText;
            if (!_src && global.AEGateReasons && typeof global.AEGateReasons.summary === 'function') {
                _detail = global.AEGateReasons.summary(_gateLib.error) || _detail;
            }
            resolve({ ok: false, error: AEI18n.t('AST 门拒绝: {detail}', { detail: _detail }) });
            return;
        }
        // bypass['user-library'] ON → 审计检测与确认弹窗整体停用
        //（run.js bypass 分支：emitted=原文、无 dangers）+ 桥 allowSet 全开
        //（核三域放行；硬拒/敏感路径照拦）
        if (_gateLib.bypassed === true) {
            _execWrapped(_gateLib.emitted, settings, resolve, { system: true, socket: true, file: true });
            return;
        }
        // 审计确认层（并入 hasSandboxBypass 硬拒 + hasDanger 条件
        // 确认）：dangers 非空 → per-script 记忆（锚定内容哈希）→ 无记忆弹确认
        //（「此脚本不再提醒」勾选）。确认取代旧硬拒（如实陈述 + 用户决定，
        // 运行时沙箱仍兜底）； + 落定 6：确认 = 当次授权
        // ——dangers 能力类并集经 allowSetFromDangers 产 allow-set 传核
        //（system/socket/file 域真实放行——File 经核内包装构造器，敏感路径
        // 黑名单与硬拒照拦）。
        // 记忆模块缺席（模块未载）= 维持直跑过渡态。
        var dangers = _gateLib.dangers || [];
        var _dangerMem = global.AE_LLM && global.AE_LLM._scriptDangerMemory;
        if (dangers.length > 0 && _dangerMem && typeof _dangerMem.confirmExecution === 'function') {
            _dangerMem.confirmExecution(scriptName || '', content, dangers).then(function (ok) {
                if (!ok) { resolve({ ok: false, error: AEI18n.t('用户取消') }); return; }
                var _allowSet = _dangerMem.allowSetFromDangers ? _dangerMem.allowSetFromDangers(dangers) : null;
                _execWrapped(_gateLib.emitted, settings, resolve, _allowSet);
            }).catch(function (e) {
                resolve({ ok: false, error: AEI18n.t('安全确认异常: {detail}', { detail: e && e.message ? e.message : e }) });
            });
            return;
        }
        _execWrapped(_gateLib.emitted, settings, resolve, null);
    }

    function _execWrapped(emitted, settings, resolve, allowSet) {
        // 执行桥统一改道宿主执行核（createHandler 桥 →
        // aeTools.jsx executeExtendScript——shadow + 核内 undo + allow-set；
        // {status} JSON 协议经桥翻译为 成功/沙箱拦截/失败 三态）。undoName
        // 保持「快速命令」。_wrapScriptForAE 已随 落定 4 删除。
        if (!(global.AE_LLM && typeof global.AE_LLM._aeCreateHandler === 'function')) {
            resolve({ ok: false, error: AEI18n.t('执行桥未就绪（ae-tools 模块加载失败）') });
            return;
        }
        var handler = global.AE_LLM._aeCreateHandler('result = executeExtendScript(__args);', {
            name: '快速命令',
            wrapUndo: true,
            undoInCore: true,
            timeoutMs: Number(settings.executionTimeoutMs) || 30000,
            // 弹窗域：quickBar = 用户手动运行通道 → 恒注入
            // dialog:true（核侧真弹窗）；审计确认当次授权（allowSet）随行合并
            allowSet: function () {
                var _as = { dialog: true };
                if (allowSet && typeof allowSet === 'object') {
                    if (allowSet.system === true) _as.system = true;
                    if (allowSet.socket === true) _as.socket = true;
                    if (allowSet.file === true) _as.file = true;
                }
                return _as;
            }
        });
        handler({ code: emitted }).then(function (resp) {
            var msg = (resp && resp.content && resp.content[0] && typeof resp.content[0].text === 'string')
                ? resp.content[0].text : '';
            if (resp && resp.success) {
                resolve({ ok: true, error: null });
            } else if (msg.indexOf('[AE_LLM]') >= 0) {
                // detail 是执行核的宿主拒绝串（中文源文）：上屏前经 AEHostErrors 映射；
                // zh 原样、en 变英文。ERROR: 前缀是协议标记，先剥掉再查表。
                var detail = msg.replace(/^ERROR:/, '');
                if (global.AEHostErrors && typeof global.AEHostErrors.localize === 'function') {
                    detail = global.AEHostErrors.localize(detail);
                }
                resolve({ ok: false, error: AEI18n.t('沙箱拦截: {detail}', { detail: detail }) });
            } else {
                resolve({ ok: false, error: msg || AEI18n.t('未知返回') });
            }
        }).catch(function (e) {
            resolve({ ok: false, error: AEI18n.t('执行异常: {detail}', { detail: e && e.message ? e.message : e }) });
        });
    }

    function _escPath(p) {
        if (!p) return '';
        // 与 assets/index.js 的 _escPath 对齐：转义反斜杠、双引号、换行、回车、Tab，
        // 防止用户提供的 name/path 含控制字符破坏 ExtendScript 字符串字面量
        // null byte 转义：纵深防御，防止 C-string 语义下截断字符串字面量
        // U+2028/U+2029 在 ES3 字符串字面量中是行终止符，未转义会让 evalScript 解析失败
        return String(p)
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t')
            .replace(/\0/g, '\\0')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    // ===== 预设应用（复用 AEAssetsShared.applyPresetToAE）=====
    function executePresets(items, options) {
        options = options || {};
        return new Promise(function (resolve) {
            if (!items || items.length === 0) {
                resolve({ ok: 0, fail: 0, errors: [] });
                return;
            }
            var hostApi = _getHostApi();
            if (!hostApi) {
                resolve({ ok: 0, fail: items.length, errors: [AEI18n.t('ExtendScript 桥未就绪')] });
                return;
            }
            // 复用素材库共享应用函数，避免各处重写 ExtendScript 调用导致漏改
            if (!global.AEAssetsShared || typeof global.AEAssetsShared.applyPresetToAE !== 'function') {
                resolve({ ok: 0, fail: items.length, errors: [AEI18n.t('素材库共享应用函数未就绪')] });
                return;
            }

            var results = { ok: 0, fail: 0, errors: [], layers: 0 };
            var idx = 0;

            function next() {
                if (idx >= items.length) { resolve(results); return; }
                if (options.isCancelled && options.isCancelled()) { results.cancelled = true; resolve(results); return; }
                var item = items[idx];
                if (options.onProgress) { try { options.onProgress(idx + 1, item); } catch (_) {} }
                idx++;

                // 图层级进度透传（分块异步应用，onLayerProgress 由 applyPresetToAE 每块边界回调）
                var layerHooks = null;
                if (options.onLayerProgress) {
                    layerHooks = {
                        onLayerProgress: function (done, total) {
                            try { options.onLayerProgress(idx, item, done, total); } catch (_) {}
                        }
                    };
                }

                // 校验 ffxPath 存在
                if (global.AEFS && typeof global.AEFS.exists === 'function') {
                    global.AEFS.exists(item.path).then(function (ok) {
                        if (ok === false) {
                            results.fail++;
                            results.errors.push(item.name + ': ' + AEI18n.t('预设文件已丢失'));
                            next();
                        } else {
                            _applyOnePreset(item, hostApi, results, next, layerHooks);
                        }
                    }).catch(function () {
                        // exists 失败时按"存在"处理，交由共享函数的主机端校验兜底
                        _applyOnePreset(item, hostApi, results, next, layerHooks);
                    });
                } else {
                    _applyOnePreset(item, hostApi, results, next, layerHooks);
                }
            }
            next();
        });
    }

    function _applyOnePreset(item, hostApi, results, next, layerHooks) {
        global.AEAssetsShared.applyPresetToAE(hostApi, item.path, item.name, {
            onLayerProgress: (layerHooks && layerHooks.onLayerProgress) || null
        }).then(function (r) {
            // 累计实际应用到的图层数（部分失败时已应用的层也计入）
            if (r && r.applied > 0) results.layers += r.applied;
            if (r && r.failed > 0) {
                results.fail++;
                var errs = (r.errors || []).slice(0, 3).join('; ');
                results.errors.push(item.name + ': ' + AEI18n.t('{n} 个图层失败', { n: r.failed }) + (errs ? ' (' + errs + ')' : ''));
            } else {
                results.ok++;
            }
            next();
        }).catch(function (e) {
            results.fail++;
            results.errors.push(item.name + ': ' + (e && e.message ? e.message : e));
            next();
        });
    }

    // ===== 工程素材导入（复用 AEAssetsShared.importProjectToAE）=====
    function executeProjects(items, options) {
        options = options || {};
        return new Promise(function (resolve) {
            if (!items || items.length === 0) {
                resolve({ ok: 0, fail: 0, errors: [] });
                return;
            }
            var hostApi = _getHostApi();
            if (!hostApi) {
                resolve({ ok: 0, fail: items.length, errors: [AEI18n.t('ExtendScript 桥未就绪')] });
                return;
            }
            // 复用素材库共享导入函数，避免各处重写 ExtendScript 脚本导致漏改
            // （如 undoGroup 顺序、重命名逻辑、_escPath 等需多处对齐）
            if (!global.AEAssetsShared || typeof global.AEAssetsShared.importProjectToAE !== 'function') {
                resolve({ ok: 0, fail: items.length, errors: [AEI18n.t('素材库共享导入函数未就绪')] });
                return;
            }

            var results = { ok: 0, fail: 0, errors: [] };
            var idx = 0;

            function next() {
                if (idx >= items.length) { resolve(results); return; }
                if (options.isCancelled && options.isCancelled()) { results.cancelled = true; resolve(results); return; }
                var item = items[idx];
                if (options.onProgress) { try { options.onProgress(idx + 1, item); } catch (_) {} }
                idx++;

                global.AEAssetsShared.importProjectToAE(hostApi, item.path, item.name).then(function (r) {
                    // r 为 "xxx" 或 "RENAMED:xxx"，均视为成功
                    // 对齐素材库 projectAssetView：AE 中已有同名条目被重命名时弹出警告
                    var renamed = false, displayName = r;
                    if (r.indexOf('RENAMED:') === 0) {
                        renamed = true;
                        displayName = r.slice(8);
                    }
                    if (renamed && global.AEToast) {
                        setTimeout(function () {
                            AEToast.warn(AEI18n.t('AE 中已有同名条目，已重命名为: {name}', { name: displayName }));
                        }, 400);
                    }
                    results.ok++;
                    next();
                }).catch(function (e) {
                    results.fail++;
                    results.errors.push(item.name + ': ' + (e && e.message ? e.message : e));
                    next();
                });
            }
            next();
        });
    }

    // ===== 素材导入（复用 AEAssetsShared.importFilesToAE）=====
    function executeRefs(items, options) {
        options = options || {};
        return new Promise(function (resolve) {
            if (!items || items.length === 0) {
                resolve({ ok: 0, fail: 0, errors: [] });
                return;
            }
            var hostApi = _getHostApi();
            if (!hostApi) {
                resolve({ ok: 0, fail: items.length, errors: [AEI18n.t('ExtendScript 桥未就绪')] });
                return;
            }

            if (global.AEAssetsShared && typeof global.AEAssetsShared.importFilesToAE === 'function') {
                if (options.onProgress) { try { options.onProgress(1, items[0]); } catch (_) {} }
                if (options.isCancelled && options.isCancelled()) { resolve({ ok: 0, fail: 0, errors: [AEI18n.t('已取消')], cancelled: true }); return; }
                var mapped = items.map(function (it) { return { path: it.path, folder: it._keepFolder ? (it.folder || '') : '' }; });
                global.AEAssetsShared.importFilesToAE(hostApi, mapped).then(function (r) {
                    // 对齐素材库 refView：AE 中已有同名文件夹被重命名时弹出警告
                    if (r.renames && r.renames.length && global.AEToast) {
                        setTimeout(function () {
                            var parts = r.renames.map(function (x) { return x.orig + ' → ' + x.renamed; });
                            AEToast.warn(AEI18n.t('AE 中已有同名文件夹，已重命名: {list}', { list: parts.join(AEI18n.punct('、', ', ')) }));
                        }, 400);
                    }
                    resolve({
                        ok: r.ok || 0,
                        fail: r.fail || 0,
                        errors: r.fail > 0 ? [AEI18n.t('部分素材导入失败')] : []
                    });
                }).catch(function (e) {
                    resolve({
                        ok: 0,
                        fail: items.length,
                        errors: [AEI18n.t('导入失败: {detail}', { detail: e && e.message ? e.message : e })]
                    });
                });
            } else {
                // Fallback：逐项 ImportOptions
                _importRefsFallback(hostApi, items, options, resolve);
            }
        });
    }

    function _importRefsFallback(hostApi, items, options, resolve) {
        options = options || {};
        var results = { ok: 0, fail: 0, errors: [] };
        var idx = 0;
        function next() {
            if (idx >= items.length) { resolve(results); return; }
            if (options.isCancelled && options.isCancelled()) { results.cancelled = true; resolve(results); return; }
            var item = items[idx];
            if (options.onProgress) { try { options.onProgress(idx + 1, item); } catch (_) {} }
            idx++;
            var script =
                'var f=new File("' + _escPath(item.path) + '");' +
                'if(!f.exists){"ERROR:文件不存在"}else{(function(){' +
                'try{app.beginUndoGroup("导入素材");' +
                'var o=new ImportOptions(f);var i=app.project.importFile(o);' +
                'return i?"OK":"ERROR:导入返回空";' +
                '}catch(e){return "ERROR:"+e.message;}' +
                'finally{try{app.endUndoGroup();}catch(_){}}' +
                '})()}';
            hostApi.call(script, 60000).then(function (resp) {
                if (!resp || resp.ok === false) {
                    results.fail++;
                    results.errors.push(item.name + ': ' + AEI18n.t('调用失败')
                        + (resp && resp.error ? ' (' + resp.error + ')' : ''));
                } else {
                    var r = String(resp.result || '');
                    // 空串/EvalScript error. 一律视为失败，避免假阳性（对齐 _applyOnePreset）
                    if (r === '' || r === 'EvalScript error.') {
                        results.fail++;
                        results.errors.push(item.name + ': ' + AEI18n.t('主机返回无效结果'));
                    } else if (/^(ERROR|Error):/.test(r)) {
                        results.fail++;
                        results.errors.push(item.name + ': ' + r);
                    } else {
                        results.ok++;
                    }
                }
                next();
            }).catch(function (e) {
                results.fail++;
                results.errors.push(item.name + ': ' + (e && e.message ? e.message : e));
                next();
            });
        }
        next();
    }

    // ===== 调度入口 =====
    function execute(category, items, options) {
        if (category === 'scripts') return executeScripts(items, options);
        if (category === 'presets') return executePresets(items, options);
        if (category === 'projects') return executeProjects(items, options);
        if (category === 'refs') return executeRefs(items, options);
        return Promise.resolve({ ok: 0, fail: 0, errors: ['unknown-category'] });
    }

    global.AEQuickBarExecutor = {
        execute: execute,
        executeScripts: executeScripts,
        executePresets: executePresets,
        executeProjects: executeProjects,
        executeRefs: executeRefs
    };
})(window);
