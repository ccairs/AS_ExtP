(function (global) {
    global.AEAssetsShared = global.AEAssetsShared || {};

    // 宿主消息本地化：host/api/*.jsx 的 throw/status.message 是中文源文，
    // 上屏前经 AEHostErrors 映射成词典 key（未命中原样返回，见 shared/i18n/hostErrors.js）。
    function _hostMsg(v) {
        return (global.AEHostErrors && typeof global.AEHostErrors.localize === 'function')
            ? global.AEHostErrors.localize(v)
            : String(v == null ? '' : v);
    }

    // ── 共享：批量导入素材到 AE 并复现文件夹层级 ──
    // 一次 ExtendScript 调用：建文件夹树 + 导所有文件 + 归位
    // items: [{path: string, folder: string}, ...]
    // 返回 Promise<{ok: number, fail: number}>
    global.AEAssetsShared.importFilesToAE = function (hostApi, items) {
        if (!hostApi) return Promise.reject(new Error(AEI18n.t('ExtendScript 桥未就绪')));
        if (!items || !items.length) return Promise.resolve({ ok: 0, fail: 0, renames: [] });
        var itemsJson = JSON.stringify(
            items.map(function (it) {
                // 压缩连续斜杠：脚本侧 folders 缓存键按空段跳过后重拼（"a//b" 的键是 "a/b"），
                // 面板侧若只去首尾斜杠，folders["a//b"] 查不到缓存 → 导入素材落 AE 根目录
                var oi = { path: it.path, folder: String(it.folder || '').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '') };
                // 序列帧：asSequence 时，AE 侧将首帧按图像序列导入
                if (it.asSequence) oi.asSequence = true;
                return oi;
            })
        );
        // U+2028/U+2029（行/段分隔符）在 ES3 字符串字面量中非法且 JSON.stringify 不转义它们，
        // 含此字符的路径/名称会让整个 evalScript 解析失败（报"返回格式异常"）；
        // 显式转成 \uXXXX 转义（对照 ae-tools/bootstrap.js 的同款处理）
        itemsJson = itemsJson.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
        // ExtendScript：直接嵌入 JSON 作为 JS 字面量（JSON 即合法 JS）
        // __u 标志 + catch 内补 endUndoGroup（对齐 importProjectToAE）：
        // 建文件夹/导入异常时也闭合撤销组，不在 AE 留下未闭合的 undo group
        var script =
            '(function(){' +
                'var __u=false;' +
                'try{' +
                'app.beginUndoGroup("导入素材");__u=true;' +
                'var items=' + itemsJson + ';' +
                'var folders={},ren=[];' +
                'for(var i=0;i<items.length;i++){' +
                    'var fp=items[i].folder;' +
                    'if(!fp)continue;' +
                    'var segs=fp.split("/");' +
                    'var cur=app.project.rootFolder;' +
                    'var acc="";' +
                    'for(var s=0;s<segs.length;s++){' +
                        'if(!segs[s])continue;' +
                        'acc=acc?acc+"/"+segs[s]:segs[s];' +
                        'if(folders[acc]){cur=folders[acc];continue;}' +
                        // 检测同名文件夹：存在则找 _N 后缀
                        'var exists=false;' +
                        'for(var k=1;k<=cur.items.length;k++){' +
                            'if(cur.items[k] instanceof FolderItem&&cur.items[k].name===segs[s]){exists=true;break;}' +
                        '}' +
                        'var fld;' +
                        'if(!exists){' +
                            'fld=cur.items.addFolder(segs[s]);' +
                        '}else{' +
                            'var sfx=1,nn;' +
                            'while(1){' +
                                'nn=segs[s]+"_"+sfx;' +
                                'var dup=false;' +
                                'for(var d=1;d<=cur.items.length;d++){' +
                                    'if(cur.items[d] instanceof FolderItem&&cur.items[d].name===nn){dup=true;break;}' +
                                '}' +
                                'if(!dup)break;' +
                                'sfx++;' +
                            '}' +
                            'fld=cur.items.addFolder(nn);' +
                            'ren.push(segs[s]+">"+nn);' +
                        '}' +
                        'folders[acc]=fld;' +
                        'cur=fld;' +
                    '}' +
                '}' +
                'var ok=0,fail=0;' +
                'for(var j=0;j<items.length;j++){' +
                    'var f=new File(items[j].path);' +
                    'if(!f.exists){fail++;continue;}' +
                    'try{' +
                        'var imp;' +
                        'if(items[j].asSequence){' +
                            'var io=new ImportOptions(f);' +
                            'try{io.sequence=true;}catch(_){}' +
                            'imp=app.project.importFile(io);' +
                        '}else{' +
                            'imp=app.project.importFile(new ImportOptions(f));' +
                        '}' +
                        'if(imp){' +
                            'if(items[j].folder&&folders[items[j].folder])imp.parentFolder=folders[items[j].folder];' +
                            'ok++;' +
                        '}else{fail++;}' +
                    '}catch(e){fail++;}' +
                '}' +
                'var rn=ren.length?",RENAMED:"+ren.join("|"):"";' +
                'app.endUndoGroup();__u=false;' +
                'return"OK:"+ok+(fail>0?",FAIL:"+fail:"")+rn;' +
                '}catch(e){' +
                    'if(__u){try{app.endUndoGroup();}catch(_){}}' +
                    'return"ERROR:"+e.message;' +
                '}' +
            '})()';
        return hostApi.call(script, 120000).then(function (resp) {
            if (!resp || resp.ok === false) throw new Error(AEI18n.t('调用失败'));
            var r = String(resp.result || '');
            if (/^(ERROR|Error):/.test(r)) throw new Error(r);
            var m = r.match(/^OK:(\d+)(?:,FAIL:(\d+))?(?:,RENAMED:(.+))?/);
            if (!m) throw new Error(AEI18n.t('返回格式异常: ') + r);
            var renames = [];
            if (m[3]) {
                renames = m[3].split('|').map(function (x) {
                    var p = x.split('>');
                    return { orig: p[0], renamed: p[1] };
                });
            }
            return { ok: parseInt(m[1], 10), fail: parseInt(m[2] || '0', 10), renames: renames };
        });
    };

    // ── 共享：导入单个工程素材（.aep）到 AE ──
    // 与 importFilesToAE 不同：.aep 的 importFile 会创建自己的内部撤销组，
    // 不能外包 beginUndoGroup（否则 AE 报"撤销组不匹配"）。
    // 这里采用「先导入，再单独 begin/end 包裹改名」的策略。
    // 返回 Promise<string>：成功时 resolve 主机返回字符串
    //   "xxx"        —— 导入成功且未重命名
    //   "RENAMED:xxx"—— 导入成功但 AE 中已有同名条目，已重命名
    // 失败时 reject(new Error('错误信息'))
    // 调用方负责自己的 busy/toast/批量进度，本函数只做核心 ExtendScript 调用。
    function _escPath(p) {
        // 与 projectAssetView/quickBarExecutor 的 _escPath 对齐，
        // 含 null byte 转义作纵深防御，防止 C-string 语义下截断字符串字面量
        return String(p || '')
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t')
            .replace(/\0/g, '\\0')
            // U+2028/U+2029 在 ES3 字符串字面量中是行终止符，未转义会让 evalScript 解析失败
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    global.AEAssetsShared.importProjectToAE = function (hostApi, aepPath, baseName) {
        if (!hostApi) return Promise.reject(new Error(AEI18n.t('ExtendScript 桥未就绪')));
        baseName = baseName == null ? '' : String(baseName);
        // AE 原生导入 .aep 得到的条目名是「文件名（含扩展名）」（用户实测：导入 总合成.aep →
        // 项目面板出现 总合成.aep）。若把名字统一成不含扩展名的条目名，导入后 .aep 会凭空消失，
        // 与 AE 惯例和面板显示（itemLabel = 名字 + .aep）都不一致。这里补回 .aep；重名后缀插在
        // 扩展名之前（总合成_1.aep），不是缀在末尾（总合成.aep_1）。baseName 为空时回退文件名。
        var fileBase = String(aepPath || '').replace(/^.*[\\\/]/, '');
        var wantName = baseName ? (/\.aep$/i.test(baseName) ? baseName : baseName + '.aep') : fileBase;
        var escName = _escPath(wantName);
        var escPath = _escPath(aepPath);
        var script =
            '(function(){' +
            'var f=new File("' + escPath + '");' +
            'if(!f.exists)return"ERROR:文件不存在";' +
            'var __u=false;' +
            'try{' +
            // importFile 导入 .aep 会创建自己的内部撤销组，不能包裹在外部 undoGroup 内，
            // 否则 AE 报"撤销组不匹配"。先导入，再单独 begin/end 包裹改名操作。
            'var o=new ImportOptions(f);var i=app.project.importFile(o);' +
            'if(!i)return"ERROR:导入返回空结果";' +
            'app.beginUndoGroup("导入素材改名：' + escName + '");__u=true;' +
            'var bn="' + escName + '"||f.name;' +
            'var stem=bn,ext="";' +
            'var dot=bn.lastIndexOf(".");' +
            'if(dot>0){stem=bn.substring(0,dot);ext=bn.substring(dot);}' +
            'var fn=bn,renamed=false;' +
            'var sfx=1;' +
            'while(1){' +
                'var dup=false;' +
                'for(var k=1;k<=app.project.rootFolder.items.length;k++){' +
                    'if(app.project.rootFolder.items[k]!==i&&app.project.rootFolder.items[k].name===fn){dup=true;break;}' +
                '}' +
                'if(!dup)break;' +
                'fn=stem+"_"+sfx+ext;' +
                'sfx++;' +
            '}' +
            'if(fn!==bn)renamed=true;' +
            'i.name=fn;' +
            'app.endUndoGroup();__u=false;' +
            'return(renamed?"RENAMED:":"")+fn;' +
            '}catch(e){' +
            'if(__u){try{app.endUndoGroup();}catch(_){}}' +
            'return"ERROR:"+e.message;' +
            '}' +
            '})()';
        return hostApi.call(script, 60000).then(function (resp) {
            if (!resp || resp.ok === false) throw new Error(AEI18n.t('调用失败'));
            var r = String(resp.result || '');
            if (r === '' || r === 'EvalScript error.') throw new Error(AEI18n.t('ExtendScript 返回无效结果'));
            if (/^(ERROR|Error):/.test(r)) throw new Error(r);
            return r;
        });
    };

    // ── 共享：应用预设（.ffx）到 AE 选中图层 ──
    // 分块异步应用：beginPresetApply 快照选中层（不动 undo group），随后按块调
    // applyPresetToLayersRange——块内把选区设为该块层后仅调用一次 applyPreset
    // （AE 的 applyPreset 作用于全部选中层，一次即应用到整块）并自开自闭
    // undo group，块间经 CEP 事件循环让 AE 消息泵喘息、进度可见（防用户误判
    // 卡死重启 AE）。整批同步会阻塞 AE 主线程（层数越多越久）；逐块调用则
    // 每块一轮"选区切换+往返+undo group 开闭"的来回开销——分块是两者间的
    // 平衡。撤回按块进行（AE 会切断跨调用的 undo group，硬约束），单块小批量
    // （<20 层）仍是一次性撤回。
    // 块大小：total<20 → 全部一块（一次性应用+撤回）；20~60 → 10；>60 → 20。
    // 实测块间"来回"（选区切换+脚本往返+undo group 开闭）开销不低，块宜大
    // 不宜小：20 层以内干脆一次同步完成（与官方菜单同速），超过才分块防假死。
    // hooks.onLayerProgress(done, total)：每块完成后回调（done 为累计层数，可选）。
    // 返回 Promise<{applied: number, failed: number, errors: string[]}>
    // 失败时 reject(new Error('错误信息'))
    // 调用方负责自己的 busy/toast/批量进度，本函数只做核心 ExtendScript 调用。
    var _presetApplyBusy = false;
    var _PRESET_SYNC_MAX = 20;             // <此层数：单次往返直接应用完（beginPresetApply 快路径）
    function _presetChunkSize(total) {
        if (total < 20) return total;      // 小批量：一块全包（一次性应用+撤回）
        if (total <= 60) return 10;        // 中批量：10 层/块
        return 20;                         // 大批量：20 层/块
    }
    global.AEAssetsShared.applyPresetToAE = function (hostApi, ffxPath, presetName, hooks) {
        if (!hostApi) return Promise.reject(new Error(AEI18n.t('ExtendScript 桥未就绪')));
        // 分块协议跨多次 evalScript，两个调用方并发交错会破坏块定位与选区恢复
        // （快速栏/素材库/Agent 工具共用本函数），直接拒绝
        if (_presetApplyBusy) return Promise.reject(new Error(AEI18n.t('正在应用预设，请等待')));
        _presetApplyBusy = true;
        hooks = hooks || {};
        var escPath = _escPath(ffxPath);
        var escName = _escPath(presetName);

        function _release(v) { _presetApplyBusy = false; return v; }
        function _releaseThrow(e) { _presetApplyBusy = false; throw e; }

        // syncMax：小批量（<20 层）时 beginPresetApply 单次往返直接应用完（快路径）
        var beginScript = 'beginPresetApply({ffxPath:"' + escPath + '",presetName:"' + escName +
            '",syncMax:' + _PRESET_SYNC_MAX + '})';
        var p = hostApi.call(beginScript, 60000).then(function (resp) {
            if (!resp || resp.ok === false) throw new Error(AEI18n.t('调用失败'));
            var r = resp.result;
            // 空串/EvalScript error./非 JSON 一律视为失败，避免假阳性
            if (typeof r !== 'string' || r === '' || r === 'EvalScript error.') {
                throw new Error(AEI18n.t('主机返回无效结果'));
            }
            var parsed;
            try { parsed = JSON.parse(r); }
            catch (_) { throw new Error(AEI18n.t('返回解析失败')); }
            if (!parsed || parsed.status !== 'success') {
                // 快路径：已在脚本内一次应用完（undo group 已闭合，Ctrl+Z 一次撤回）
                if (parsed && parsed.status === 'done') {
                    if (hooks.onLayerProgress) {
                        try { hooks.onLayerProgress(parsed.applied, parsed.applied); } catch (_) {}
                    }
                    return { applied: parsed.applied || 0, failed: 0, errors: [] };
                }
                throw new Error(_hostMsg(parsed && parsed.message) || AEI18n.t('AE 错误'));
            }
            var compId = Number(parsed.compId);
            var indexes = parsed.indexes || [];
            // 稳定键——分块跨多次 evalScript，期间用户删/加/重排图层会让位置键错位
            // （预设静默应用到别的层，且撤回按块走、难复原）。ids 与 indexes 等长且全为正整数
            // 时按 id 分块；indexes 照旧一并带上（旧 host .jsx 不认 layerIds 时仍走位置键）。
            var ids = parsed.layerIds || [];
            var useIds = ids.length === indexes.length && ids.length > 0;
            if (useIds) {
                for (var ci = 0; ci < ids.length; ci++) { if (!(Number(ids[ci]) > 0)) { useIds = false; break; } }
            }
            var applied = 0;
            var failed = 0;
            var errors = [];
            var MAX_ERRORS = 20;  // 失败明细最多收集 20 条，防止批量失败返回体撑爆
            var i = 0;  // 层游标（始终停在块边界）
            var chunkSize = _presetChunkSize(indexes.length);

            // 中止余块（abort/传输失败）：已完成的块各自闭合了 undo group，
            // 无需补闭合，直接按部分结果收尾
            function _abort(message) {
                failed = indexes.length - applied;
                if (message && errors.length < MAX_ERRORS) errors.push(message);
                return { applied: applied, failed: failed, errors: errors };
            }

            function stepChunk() {
                if (i >= indexes.length) {
                    return { applied: applied, failed: failed, errors: errors };
                }
                var chunk = indexes.slice(i, i + chunkSize);
                var chunkIds = useIds ? ids.slice(i, i + chunkSize) : [];
                var last = (i + chunk.length >= indexes.length);
                var script = 'applyPresetToLayersRange({ffxPath:"' + escPath + '",presetName:"' + escName +
                    '",compId:' + compId + ',indexes:[' + chunk.join(',') + '],layerIds:[' + chunkIds.join(',') + ']' +
                    ',last:' + (last ? 'true' : 'false') +
                    ',reselect:[' + indexes.join(',') + '],reselectIds:[' + (useIds ? ids.join(',') : '') + ']})';
                return hostApi.call(script, 60000).then(function (resp2) {
                    var r2 = (resp2 && resp2.ok !== false) ? resp2.result : null;
                    if (typeof r2 !== 'string' || r2 === '' || r2 === 'EvalScript error.') {
                        return _abort(AEI18n.t('主机返回无效结果'));
                    }
                    var p2;
                    try { p2 = JSON.parse(r2); }
                    catch (_) { return _abort(AEI18n.t('返回解析失败')); }
                    if (p2 && p2.status === 'success') {
                        applied += (p2.applied || chunk.length);
                    } else if (p2 && p2.status === 'error') {
                        // 整块失败：继续其余块（失败粒度为块，块内不细分）
                        failed += chunk.length;
                        if (errors.length < MAX_ERRORS) errors.push(_hostMsg(p2.message) || AEI18n.t('应用失败'));
                    } else {
                        // abort（合成/图层已变更）：中止余块
                        return _abort(_hostMsg(p2 && p2.message) || AEI18n.t('批量中止'));
                    }
                    i += chunk.length;
                    if (hooks.onLayerProgress) {
                        try { hooks.onLayerProgress(i, indexes.length); } catch (_) {}
                    }
                    return stepChunk();
                }).catch(function (e) {
                    return _abort(AEI18n.t('执行异常: ') + (e && e.message ? e.message : e));
                });
            }

            return stepChunk();
        });
        return p.then(_release, _releaseThrow);
    };

    // ── 共享：应用预设（.ffx）到 AE 指定图层（通过 compName + layerIndex/layerName 定位）──
    // 调用 aeTools.jsx 的 applyPreset（与 AE 工具模块的 applyPreset 工具同源）。
    // 返回 Promise<{applied: 1, failed: 0, errors: [], layer: {index, name}}>
    // 失败时 reject(new Error('错误信息'))
    global.AEAssetsShared.applyPresetToLayer = function (hostApi, ffxPath, layerTarget) {
        if (!hostApi) return Promise.reject(new Error(AEI18n.t('ExtendScript 桥未就绪')));
        var escPath = _escPath(ffxPath);
        var parts = ['presetPath:"' + escPath + '"'];
        if (layerTarget && layerTarget.compName) {
            parts.push('compName:"' + _escPath(layerTarget.compName) + '"');
        }
        if (layerTarget && layerTarget.layerIndex !== undefined && layerTarget.layerIndex !== null) {
            parts.push('layerIndex:' + Number(layerTarget.layerIndex));
        }
        if (layerTarget && layerTarget.layerName) {
            parts.push('layerName:"' + _escPath(layerTarget.layerName) + '"');
        }
        // applyPreset 返回对象（非 JSON 字符串），用 JSON.stringify 包装让 evalScript 返回可解析的字符串
        var script = 'JSON.stringify(applyPreset({' + parts.join(',') + '}))';
        return hostApi.call(script, 60000).then(function (resp) {
            if (!resp || resp.ok === false) throw new Error(AEI18n.t('调用失败'));
            var r = resp.result;
            if (typeof r !== 'string' || r === '' || r === 'EvalScript error.') {
                throw new Error(AEI18n.t('主机返回无效结果'));
            }
            if (r.indexOf('{') === 0) {
                var parsed;
                try { parsed = JSON.parse(r); }
                catch (_) { throw new Error(AEI18n.t('返回解析失败')); }
                if (parsed && parsed.status === 'error') throw new Error(_hostMsg(parsed.message) || AEI18n.t('AE 错误'));
                // applyPreset 返回 { status, message, layer: {index, name} }，统一为 {applied, failed, errors, layer}
                return {
                    applied: 1,
                    failed: 0,
                    errors: [],
                    layer: (parsed && parsed.layer) ? { index: parsed.layer.index, name: parsed.layer.name } : null
                };
            }
            if (/^(ERROR|Error):/.test(r)) throw new Error(r);
            throw new Error(AEI18n.t('未知返回: ') + r.slice(0, 60));
        });
    };

    var mounted = false;
    var _cardStack = null;
    var _refStore = null, _refView = null;
    var _projStore = null, _projView = null;
    var _presetStore = null, _presetView = null;

    function _makePane() {
        var p = document.createElement('div');
        p.className = 'assets-pane';
        return p;
    }

    // 懒 init：首次成为顶层时调 view.init()，带 _inited 守卫（await 前置位，失败复位可重试）
    function _lazyInit(topId) {
        var view = null;
        if (topId === 'refs') view = _refView;
        else if (topId === 'proj') view = _projView;
        else if (topId === 'presets') view = _presetView;
        if (!view || view._inited) return;
        view._inited = true;   // await 前置位，防重入
        view.init().catch(function (e) {
            console.error('[Assets] view init 失败:', topId, e);
            view._inited = false;   // 失败复位，切回可重试
            if (global.AEToast) AEToast.error(topId + AEI18n.t(' 模块初始化失败'));
        });
    }

    function mount(containerContext) {
        if (mounted) return;
        var panel = document.getElementById('assetsPanel');
        if (panel) panel.classList.remove('hidden');
        try {
            var dataDir = '';
            try { dataDir = global.AEShared.getDataDir().dir; } catch (_) {}
            var hostApi = (containerContext && containerContext.hostApi) || (global.AEPlatform && global.AEPlatform.hostApi);

            // 创建 store+view（不急切 init）。先建 pane，既传给 createXxxView（view 用 opts.pane 接收）
            // 又传给 cards[].pane（CardStack 包进卡片）。view 返回对象须含 pane。
            var refPane = _makePane();
            var projPane = _makePane();
            var presetPane = _makePane();
            // 优先复用 bootstrap.js 已创建的 store 实例（LLM 工具与 UI 共用一份内存，
            // 避免 LLM 写入后 UI 仍持旧缓存导致状态不一致）
            if (global.AEAssetsShared._sharedStores) {
                _refStore = global.AEAssetsShared._sharedStores.refStore;
                _projStore = global.AEAssetsShared._sharedStores.projStore;
                _presetStore = global.AEAssetsShared._sharedStores.presetStore;
            } else {
                _refStore = global.AEAssetsShared.createRefStore({ dataDir: dataDir });
                _projStore = global.AEAssetsShared.createProjectAssetStore({ dataDir: dataDir, hostApi: hostApi });
                _presetStore = global.AEAssetsShared.createPresetStore({ dataDir: dataDir });
                // 回写共享实例（key 与 bootstrap.js 一致）：bootstrap 若后执行会复用/覆盖同一容器，
                // 不回写会导致 UI 与 LLM 各持一份内存（双实例窗口）
                global.AEAssetsShared._sharedStores = {
                    refStore: _refStore,
                    projStore: _projStore,
                    presetStore: _presetStore
                };
            }

            _refView = global.AEAssetsShared.createRefView({ pane: refPane, store: _refStore, dataDir: dataDir, hostApi: hostApi });
            _projView = global.AEAssetsShared.createProjectAssetView({ pane: projPane, store: _projStore, dataDir: dataDir, hostApi: hostApi });
            _presetView = global.AEAssetsShared.createPresetView({ pane: presetPane, store: _presetStore, dataDir: dataDir, hostApi: hostApi });

            _cardStack = global.AEAssetsShared.createCardStack({
                container: panel,
                cards: [
                    { id: 'presets', label: AEI18n.t('预设'), pane: presetPane, view: _presetView },
                    { id: 'proj', label: AEI18n.t('工程素材'), pane: projPane, view: _projView },
                    { id: 'refs', label: AEI18n.t('素材'), pane: refPane, view: _refView }
                ],
                initialTopId: 'refs',
                onChange: function (topId) { _lazyInit(topId); }
            });
            _cardStack.mount();
            mounted = true;
        } catch (e) {
            console.error('[Assets] mount 初始化失败:', e);
            // cardStack 已建则统一 destroy（其内部遍历 cards 调 view.destroy，避免双 destroy view）
            if (_cardStack) { try { _cardStack.destroy(); } catch (_) {} _cardStack = null; }
            else {
                // createCardStack 自身抛错（如 container 缺失）：逐个 destroy 已建 view
                [_refView, _projView, _presetView].forEach(function (v) { if (v && v.destroy) { try { v.destroy(); } catch (_) {} } });
            }
            _refStore = _projStore = _presetStore = null;
            _refView = _projView = _presetView = null;
            if (panel) panel.classList.add('hidden');
            if (global.AEToast) AEToast.error(AEI18n.t('素材库初始化失败'));
        }
    }

    function unmount() {
        if (!mounted) return;
        mounted = false;
        if (_cardStack) { try { _cardStack.destroy(); } catch (_) {} _cardStack = null; }
        _refStore = _projStore = _presetStore = null;
        _refView = _projView = _presetView = null;
        var panel = document.getElementById('assetsPanel');
        if (panel) panel.classList.add('hidden');
    }

    // 打开目录（ExtendScript Folder.execute；非 CEP 运行时没有 CSInterface）
    function _openDataDir(dir) {
        if (!dir) return;
        if (typeof CSInterface === 'undefined' || !CSInterface) {
            if (global.AEToast) global.AEToast.warn(AEI18n.t('请在 AE 中打开扩展面板'));
            return;
        }
        var safe = String(dir)
            .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
            .replace(/\r/g, '\\r').replace(/\n/g, '\\n');
        try {
            new CSInterface().evalScript(
                '(function(){var f=new Folder("' + safe + '");if(!f.exists){return "NOT_EXISTS";}return f.execute()?"OK":"FAIL";})();',
                function (res) {
                    var r = String(res || '').trim();
                    if (r === 'NOT_EXISTS') { if (global.AEToast) global.AEToast.warn(AEI18n.t('目录不存在: ') + dir); }
                    else if (r !== 'OK') { if (global.AEToast) global.AEToast.warn(AEI18n.t('打开目录失败: ') + dir); }
                }
            );
        } catch (_) {
            if (global.AEToast) global.AEToast.warn(AEI18n.t('打开目录失败: ') + dir);
        }
    }

    // 复制文本到剪贴板（textarea + execCommand：CEF 88 下比 navigator.clipboard 可靠）
    function _copyText(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = String(text == null ? '' : text);
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            return true;
        } catch (_) { return false; }
    }

    // 转码缓存体积（AEFS.listFilesWithSize 只走 Bridge；不可用返回 null）。
    // 只统计 tc_*.webm 产物，与清缓存按钮的过滤口径一致。
    function _queryCacheSize(dir) {
        var AEFS = global.AEFS;
        if (!AEFS || typeof AEFS.listFilesWithSize !== 'function') return Promise.resolve(null);
        var outDir = String(dir || '').replace(/[\\\/]+$/, '') + '/temp/transcoded';
        return Promise.resolve(AEFS.listFilesWithSize(outDir)).then(function (list) {
            if (!Array.isArray(list)) return null;
            var bytes = 0, count = 0;
            for (var i = 0; i < list.length; i++) {
                var e = list[i];
                if (!e || typeof e.name !== 'string') continue;
                if (e.name.indexOf('tc_') !== 0 || !/\.webm$/i.test(e.name)) continue;
                bytes += Number(e.size) || 0;
                count++;
            }
            return { bytes: bytes, count: count };
        }).catch(function () { return null; });
    }

    function _fmtBytes(n) {
        var b = Number(n) || 0;
        if (!b) return '0 B';
        if (b < 1024) return b + ' B';
        if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
        if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
        return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    function showSettingsModal() {
        var modalBody = document.querySelector('#settingsModal .modal-body');
        if (!modalBody) return;

        var dataDir = '';
        try { dataDir = global.AEShared.getDataDir().dir; } catch (_) {}

        // 缓存的转码分辨率选项
        var resOpts = [
            { v: '0', label: AEI18n.t('原尺寸') },
            { v: '1920', label: AEI18n.t('1080p（1920×1080）') },
            { v: '1280', label: AEI18n.t('720p（1280×720）') },
            { v: '854', label: AEI18n.t('480p（854×480）') }
        ];
        var curRes = '854';
        try { var s = localStorage.getItem('assets.transcodeMaxWidth'); if (s != null) curRes = s; } catch (_) {}
        // 自动转码开关（默认开；'0' 为关闭）——关闭后预览区不再为无法解码的视频发起转码
        var autoTranscode = true;
        try { var at = localStorage.getItem('assets.autoTranscode'); if (at === '0') autoTranscode = false; } catch (_) {}
        var dirText = dataDir || AEI18n.t('（未获取到数据目录）');

        // 注意：innerHTML 用替换（非追加），防跨模块 DOM 污染
        // 分组排版走 st-panel 共用样式，三组：数据 / 预览与转码 / 转码缓存；
        // 字段说明统一放字段的 title（悬停查看），面板内只保留名称与状态
        var html = '<div id="assetsSettingsContainer" class="st-panel">';
        // ── 数据 ──
        html += '<div class="st-section">';
        html += AEI18n.html('<div class="st-section-title">数据</div>');
        html += AEI18n.html('<div class="st-field" title="索引、预览图与转码缓存均保存在该目录">');
        html += AEI18n.html('<label for="assetsSettingsDataDir">数据目录</label>');
        html += '<div class="assets-settings-path-row">';
        html += '<span class="assets-settings-path" id="assetsSettingsDataDir" title="' + _esc(dataDir) + '">' + _esc(dirText) + '</span>';
        html += '<button class="btn secondary assets-settings-mini-btn" id="assetsSettingsOpenDir"' + (dataDir ? '' : ' disabled') + '>' + AEI18n.t('打开') + '</button>';
        html += '<button class="btn secondary assets-settings-mini-btn" id="assetsSettingsCopyDir"' + (dataDir ? '' : ' disabled') + '>' + AEI18n.t('复制') + '</button>';
        html += '</div>';
        html += '</div></div>';
        // ── 预览与转码 ──
        html += '<div class="st-section">';
        html += AEI18n.html('<div class="st-section-title">预览与转码</div>');
        html += AEI18n.html('<div class="st-field" title="无法直接预览的视频（如 HEVC）自动转码为代理缓存；关闭后详情与全屏只提示、不发起转码（已有缓存也不复用），网格缩略图不转码。仅控制素材库预览，不影响 Agent 附件预览">');
        html += '<div class="assets-settings-toggle-row">';
        html += AEI18n.html('<span class="assets-settings-toggle-label">自动转码</span>');
        html += '<label class="toggle-wrap"><input type="checkbox" class="switch-input" id="assetsSettingsAutoTranscode"' + (autoTranscode ? ' checked' : '') + '>';
        html += '<span class="switch-slider" aria-hidden="true"></span></label>';
        html += '</div></div>';
        html += AEI18n.html('<div class="st-field" id="assetsSettingsResField" title="按此上限宽度生成代理缓存；切换分辨率不会命中旧缓存">');
        html += AEI18n.html('<label for="assetsSettingsRes">缓存最高分辨率');
        html += '<span class="assets-settings-state" id="assetsSettingsResState"></span></label>';
        html += '<select id="assetsSettingsRes"></select>';
        html += '</div></div>';
        // ── 转码缓存 ──
        html += '<div class="st-section">';
        html += AEI18n.html('<div class="st-section-title">转码缓存</div>');
        html += AEI18n.html('<div class="st-field" title="代理缓存位于数据目录 temp/transcoded；清理入口在素材库工具栏「清缓存」">');
        html += '<div class="assets-settings-status-row">';
        html += AEI18n.html('<span class="assets-settings-status-label">当前占用</span>');
        html += AEI18n.html('<span class="assets-settings-status is-muted" id="assetsSettingsCacheSize">计算中…</span>');
        html += '</div>';
        html += '</div></div>';
        html += AEI18n.html('<div class="btn-row"><button class="btn secondary" id="assetsSettingsAboutBtn">关于模块</button></div>');
        html += '</div>';
        modalBody.innerHTML = html;

        // 数据目录：打开 / 复制
        var openDirBtn = document.getElementById('assetsSettingsOpenDir');
        if (openDirBtn) openDirBtn.addEventListener('click', function () { _openDataDir(dataDir); });
        var copyDirBtn = document.getElementById('assetsSettingsCopyDir');
        if (copyDirBtn) copyDirBtn.addEventListener('click', function () {
            if (!dataDir) return;
            var ok = _copyText(dataDir);
            if (global.AEToast) {
                if (ok) global.AEToast.info(AEI18n.t('数据目录路径已复制'));
                else global.AEToast.warn(AEI18n.t('复制失败，请手动选择路径'));
            }
        });

        // 动态填充 <select> 选项（CEF 88 静态 option 在隐藏容器有渲染 bug）
        var sel = document.getElementById('assetsSettingsRes');
        if (sel) {
            for (var ri = 0; ri < resOpts.length; ri++) {
                var opt = document.createElement('option');
                opt.value = resOpts[ri].v;
                opt.textContent = resOpts[ri].label;
                if (resOpts[ri].v === curRes) opt.selected = true;
                sel.appendChild(opt);
            }
            sel.addEventListener('change', function () {
                try { localStorage.setItem('assets.transcodeMaxWidth', sel.value); } catch (_) {}
            });
        }

        // 自动转码开关 + 分辨率字段联动（关闭自动转码时分辨率不生效，置灰并标注状态）
        var autoCb = document.getElementById('assetsSettingsAutoTranscode');
        var resField = document.getElementById('assetsSettingsResField');
        var resState = document.getElementById('assetsSettingsResState');
        function _syncResEnabled() {
            var on = autoCb ? autoCb.checked : true;
            if (sel) sel.disabled = !on;
            if (resField) {
                if (on) resField.classList.remove('is-disabled');
                else resField.classList.add('is-disabled');
            }
            if (resState) resState.textContent = on ? '' : AEI18n.t('（自动转码已关闭）');
        }
        if (autoCb) autoCb.addEventListener('change', function () {
            // 即时生效（只影响后续预览，不清理既有缓存）
            try { localStorage.setItem('assets.autoTranscode', autoCb.checked ? '1' : '0'); } catch (_) {}
            _syncResEnabled();
        });
        _syncResEnabled();

        // 缓存占用：面板打开时异步统计一次（Bridge 体积清单不可用时显示「大小未知」）
        var cacheEl = document.getElementById('assetsSettingsCacheSize');
        if (cacheEl) {
            _queryCacheSize(dataDir).then(function (info) {
                if (!cacheEl.isConnected) return;
                if (!info) {
                    cacheEl.textContent = AEI18n.t('大小未知');
                    cacheEl.classList.add('is-muted');
                    return;
                }
                if (!info.count) {
                    cacheEl.textContent = AEI18n.t('暂无缓存');
                    cacheEl.classList.add('is-muted');
                    return;
                }
                cacheEl.textContent = _fmtBytes(info.bytes) + ' · ' + info.count + AEI18n.t(' 个文件');
                cacheEl.classList.remove('is-muted');
            });
        }

        var aboutBtn = document.getElementById('assetsSettingsAboutBtn');
        if (aboutBtn) aboutBtn.addEventListener('click', function () {
            global.showAboutModal('module', { name: AEI18n.t('素材库'), desc: AEI18n.t('管理预设（.ffx）、工程素材（.aep）、普通素材（纯引用）。预设与工程素材为实体文件，普通素材为虚拟引用层。') });
        });

        if (typeof global.openModal === 'function') global.openModal('settingsModal');
    }

    // 简易 HTML 转义（数据目录路径可能含 & < > "）
    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    var assetsModule = {
        id: 'assets',
        // 读取时才翻译：本文件会整份加载进无 AEI18n 的沙箱，顶层求值会抛 ReferenceError
        get title() { return AEI18n.t('素材库'); },
        get description() { return AEI18n.t('管理预设、工程素材、普通素材'); },
        panelId: 'assetsPanel',

        mount: mount,
        unmount: unmount,
        showSettings: function () { showSettingsModal(); },
        // 切换顶层卡片（QuickBar -> 按钮调用）
        switchTo: function (topId) {
            if (_cardStack && typeof _cardStack.switchTo === 'function') {
                _cardStack.switchTo(topId);
            }
        }
    };

    global.AEModules = global.AEModules || {};
    global.AEModules.assetsModule = assetsModule;
})(window);
