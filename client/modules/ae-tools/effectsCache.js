// effectsCache.js — AE 效果列表缓存管理
// app.effects 全量遍历在装了大量插件时极慢（1510 个 ≈ 60s，索引单次 ~40ms），
// 故首次让用户选择是否生成缓存：分批遍历 + 原子落盘，之后工具直接读缓存秒回。
//
// 状态机：absent（无缓存）→ generating（生成中）→ ready（就绪）；skipped（用户跳过）
// 防未完成读取：生成期写 .tmp，完成后原子 rename 到正式文件；读侧只认正式文件。
// 进度：内存 + localStorage 存百分比，handler 据此提示 LLM。
(function (global) {
    var CACHE_FILENAME = 'effects_cache.json';
    var TMP_FILENAME = 'effects_cache.json.tmp';
    var SKIP_FLAG_KEY = 'as_extp_effects_cache_skipped';
    var PROGRESS_KEY = 'as_extp_effects_cache_progress';

    var BATCH_SIZE = 20;        // 每批遍历数（~0.8s，AE 小卡可接受）
    var BATCH_INTERVAL_MS = 1200; // 批间隔，让 AE 主线程喘息

    var state = 'absent';        // absent | generating | ready | skipped
    var progress = 0;            // 0..100
    var generating = false;

    function dataDir() {
        if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
            return global.AEShared.getDataDir().dir || '';
        }
        return '';
    }
    function cachePath() { return dataDir() + '\\ae-tools\\' + CACHE_FILENAME; }
    function tmpPath() { return dataDir() + '\\ae-tools\\' + TMP_FILENAME; }

    function skipFlag() {
        try { return localStorage.getItem(SKIP_FLAG_KEY) === '1'; } catch (_) { return false; }
    }
    function setSkipFlag(v) {
        try {
            if (v) localStorage.setItem(SKIP_FLAG_KEY, '1');
            else localStorage.removeItem(SKIP_FLAG_KEY);
        } catch (_) {}
    }

    function loadProgress() {
        try {
            var raw = localStorage.getItem(PROGRESS_KEY);
            if (raw) { var p = parseInt(raw, 10); if (p >= 0 && p <= 100) return p; }
        } catch (_) {}
        return 0;
    }
    function saveProgress(p) {
        try { localStorage.setItem(PROGRESS_KEY, String(p)); } catch (_) {}
    }
    function clearProgress() {
        try { localStorage.removeItem(PROGRESS_KEY); } catch (_) {}
    }

    // 残留 tmp 提升：上一轮 rename 失败把唯一完整副本留在 .tmp，refreshState
    // 只认正式文件 → 状态恒 absent 且无恢复路径（用户只能重新全量生成）；
    // 发现「无正式 + 有 tmp」时尝试一次 rename 提升。AEFS.renameFile 是异步的，
    // 当前轮同步返回仍 absent，成功后下次 refreshState 命中正式文件转 ready。
    // 一次性守卫：提升失败不反复重试（避免每次 getState 刷屏 + 无效 IO），
    // 下一轮 generate 开始时会重置（新 tmp 重新获得提升机会）。
    var tmpPromoteTried = false;
    var tmpPromoteInFlight = false;

    function _hasTmp() {
        try {
            if (typeof AEFS !== 'undefined' && AEFS && typeof AEFS.existsSync === 'function') {
                return !!AEFS.existsSync(tmpPath());
            }
        } catch (_) {}
        return false;
    }

    function _tryPromoteTmp() {
        if (tmpPromoteTried || tmpPromoteInFlight) return;
        tmpPromoteTried = true;
        tmpPromoteInFlight = true;
        try {
            Promise.resolve(AEFS.renameFile(tmpPath(), cachePath())).then(function (ok) {
                tmpPromoteInFlight = false;
                if (ok) {
                    console.log('[EffectsCache] 残留 .tmp 已提升为正式缓存（上次 rename 失败恢复）');
                    state = 'ready';
                    progress = 100;
                    saveProgress(100);
                    setSkipFlag(false);
                } else {
                    console.warn('[EffectsCache] 残留 .tmp 提升失败，保持 absent（不反复重试）');
                }
            }, function (e) {
                tmpPromoteInFlight = false;
                console.warn('[EffectsCache] 残留 .tmp 提升异常，保持 absent（不反复重试）: ' + e);
            });
        } catch (e) {
            tmpPromoteInFlight = false;
            console.warn('[EffectsCache] 残留 .tmp 提升异常，保持 absent（不反复重试）: ' + e);
        }
    }

    // 判定当前状态（基于磁盘文件 + skip flag + 生成中标志）
    function refreshState() {
        // 生成中回读 localStorage 进度（generate 循环只写不更新内存 progress）：
        // 消费方（LLM 提示/设置弹窗）在生成期间调 getProgress() 才能拿到真实进度而非恒 0
        if (generating) { state = 'generating'; progress = loadProgress(); return; }
        // 同步探测缓存文件是否存在（用 AEFS.existsSync）
        try {
            var exists = false;
            if (typeof AEFS !== 'undefined' && AEFS.existsSync) {
                exists = AEFS.existsSync(cachePath());
            }
            if (exists) { state = 'ready'; progress = 100; return; }
        } catch (_) {}
        // 无正式 + 有 .tmp：tmp 是上次 rename 失败保下的唯一完整副本，尝试提升一次
        //（失败保持 absent，不删 tmp、不反复重试；见 _tryPromoteTmp 注释）
        if (_hasTmp()) _tryPromoteTmp();
        if (skipFlag()) { state = 'skipped'; return; }
        // 有 .tmp 不主动删除：它可能是上次 rename 失败时保下的**唯一完整副本**
        //（正式缓存已为 rename 让路被删，见 generate 的 rename 重试）。读侧只认
        // 正式文件；提升由上方 _tryPromoteTmp 负责（异步、一次性）。
        // 对齐 bootstrap saveToolsToJson「失败不清理 .tmp」的兜底。
        state = 'absent';
        progress = loadProgress();
    }

    function getState() { refreshState(); return state; }
    function getProgress() { refreshState(); return progress; }

    // 读缓存 JSON（仅 ready 状态有效）。返回 {categories,total...} 或 null
    async function read() {
        refreshState();
        if (state !== 'ready') return null;
        try {
            var raw = await AEFS.readFile(cachePath());
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            console.warn('[EffectsCache] read failed: ' + e);
            return null;
        }
    }

    // 拿 CSInterface 跑 ExtendScript，返回 Promise<string result>
    // 超时保护：AE 主线程被模态框/长任务占用时回调可能永不返回，无超时会让 generating
    // 恒 true、refreshState 永远短路（与 bootstrap createHandler/injectCodeToAE 同款防护）。
    // 超时按批次失败处理：ERR: 前缀走 runBatch 现有 error 路径 → generate catch 清理复位。
    function evalScript(code) {
        return new Promise(function (resolve) {
            // 延迟夹取 120s：与超时归一口径同源（ae-tools/bootstrap.js createHandler 的
            // `timeoutMs > 120000 → 120000` 夹取；写盘侧上游补读只判 `_ms >= 3000`
            // 不夹上限，此处兜底防未来写盘侧放宽/测试直塞导致 setTimeout 超 2^31-1 溢出）。
            var timeoutMs = Math.min(120000, (global.AE_LLM && typeof global.AE_LLM._aeToolTimeoutMs === 'number')
                ? global.AE_LLM._aeToolTimeoutMs : 30000);
            var finished = false;
            var timer = setTimeout(function () {
                if (finished) return;
                finished = true;
                console.warn('[EffectsCache] evalScript timeout after ' + (timeoutMs / 1000) + 's');
                resolve('ERR:EVAL_TIMEOUT');
            }, timeoutMs);
            try {
                if (typeof CSInterface === 'undefined') { clearTimeout(timer); resolve(''); return; }
                var cs = new CSInterface();
                cs.evalScript(code, function (r) {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    resolve(String(r || ''));
                });
            } catch (e) {
                if (!finished) { finished = true; clearTimeout(timer); }
                resolve('ERR:' + e);
            }
        });
    }

    // 跑一批：从 offset 开始遍历 BATCH_SIZE 个，返回 {items, total, nextOffset}
    // ExtendScript 侧 getEffectsBatch 已注入 AE
    function runBatch(offset) {
        var code = '(function(){ try { return getEffectsBatch(' + offset + ',' + BATCH_SIZE + '); } catch(e){ return "ERR:"+e; } })()';
        return evalScript(code).then(function (r) {
            if (!r || r.indexOf('ERR:') === 0) {
                return { items: [], total: 0, nextOffset: offset, error: r };
            }
            try { return JSON.parse(r); }
            catch (e) { return { items: [], total: 0, nextOffset: offset, error: 'PARSE_ERR' }; }
        });
    }

    // 分批生成全量缓存。onProgress(done,total) 回调。
    // 结果累计在内存，全部完成后写 .tmp 再 rename 到正式名（原子落盘）；中途失败不保留进度。
    async function generate(onProgress) {
        if (generating) return { ok: false, error: 'ALREADY_GENERATING' };
        generating = true;
        tmpPromoteTried = false; // 新一轮生成的 .tmp 重新获得提升机会（上次失败不永久封死）
        state = 'generating';
        progress = 0;
        saveProgress(0);
        var allItems = [];
        var offset = 0;
        var total = 0;
        try {
            // 先拿总数
            var first = await runBatch(0);
            // error 为空串也是错（CSInterface 不可用/回调空 → evalScript resolve ''）。
            // truthy 判错会放行空串 → total:0 空缓存落盘并置 ready，
            // LLM 查询 availableEffects 永远拿到空列表
            if (first.error !== undefined && first.error !== null) throw new Error('first batch failed: ' + first.error);
            total = first.total || 0;
            allItems = first.items.slice();
            offset = first.nextOffset;
            if (onProgress) onProgress(allItems.length, total);
            saveProgress(Math.round(allItems.length / Math.max(total, 1) * 100));

            while (offset < total) {
                await sleep(BATCH_INTERVAL_MS);
                var batch = await runBatch(offset);
                if (batch.error !== undefined && batch.error !== null) throw new Error('batch @' + offset + ' failed: ' + batch.error);
                allItems = allItems.concat(batch.items);
                offset = batch.nextOffset;
                if (onProgress) onProgress(allItems.length, total);
                saveProgress(Math.round(allItems.length / Math.max(total, 1) * 100));
                if (batch.items.length === 0) break; // 防死循环
            }

            // 按分类分组，原子落盘
            var grouped = groupByCategory(allItems);
            var payload = {
                version: 1,
                total: allItems.length,
                totalCategories: grouped.categories.length,
                categories: grouped.categories,
                generatedAt: new Date().toISOString()
            };
            var jsonStr = JSON.stringify(payload);
            var writeOk = await AEFS.writeFile(tmpPath(), jsonStr);
            if (!writeOk) throw new Error('write tmp failed');
            var renameOk = await AEFS.renameFile(tmpPath(), cachePath());
            if (!renameOk) {
                // rename 通道对已存在的目标文件可能失败：此时新数据已安全写入 tmp，
                // 删旧缓存后重试一次，将"无缓存窗口"压缩到最小
                try { await AEFS.deleteFile(cachePath()); } catch (_) {}
                renameOk = await AEFS.renameFile(tmpPath(), cachePath());
            }
            if (!renameOk) throw new Error('rename failed');

            state = 'ready';
            progress = 100;
            saveProgress(100);
            setSkipFlag(false); // 成功后清跳过标记
            return { ok: true, total: allItems.length };
        } catch (e) {
            console.warn('[EffectsCache] generate failed: ' + e);
            // 失败不清理 .tmp：rename 兜底也失败时它已是唯一完整副本（旧缓存已为
            // rename 让路删除），留盘可手工恢复（对齐 bootstrap saveToolsToJson 的
            // 兜底）。refreshState 同样不再清理 .tmp，回退状态不会把副本删掉。
            generating = false; // 先落 flag 再重算，否则 refreshState 被 generating 短路成死调用
            refreshState();
            return { ok: false, error: String(e) };
        } finally {
            generating = false;
        }
    }

    function groupByCategory(items) {
        var groups = {};
        var order = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var cat = it.c || 'Uncategorized';
            if (!groups[cat]) { groups[cat] = []; order.push(cat); }
            groups[cat].push({ name: it.n, matchName: it.m });
        }
        var cats = [];
        for (var k = 0; k < order.length; k++) {
            var c = order[k];
            cats.push({ category: c, count: groups[c].length, effects: groups[c] });
        }
        return { categories: cats };
    }

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    // 主动触发生成（弹卡片"生成"按钮 / 模块设置手动入口调用）
    function startGeneration(onProgress) {
        return generate(onProgress);
    }

    // 标记跳过
    function skip() {
        setSkipFlag(true);
        refreshState();
    }

    // 强制重新生成（模块设置"重新生成"）
    async function regenerate(onProgress) {
        setSkipFlag(false);
        // 不预删正式缓存也不预删 .tmp：
        // - 正式缓存靠 generate 的 tmp→rename 原子替换，预删会让中途失败摧毁旧缓存；
        // - .tmp 可能是上次 rename 兜底失败保留的唯一完整副本（见 generate catch），
        //   预删等于摧毁兜底；generate 的 writeFile 本就会覆盖它。且预删发生在
        //   generate 的 ALREADY_GENERATING 检查之前——并发重试时会在在途 generate 的
        //   writeFile(tmp)→rename 之间删掉 tmp，造成正式+临时双丢。只清进度即可。
        clearProgress();
        return generate(onProgress);
    }

    // bootstrap 后调用：检查状态，无缓存且未跳过 → 弹卡片让用户选
    // 返回是否需要弹卡片（调用方负责用 AENotice 渲染，或传回调）
    function checkOnBoot() {
        refreshState();
        return (state === 'absent');
    }

    // ── queryEnvironment 工具的 availableEffects 缓存通道（自 bootstrap.js 提取共享）──
    // app.effects 全量遍历会卡死 AE（1510 个 ≈ 60s），故 queryEnvironment 的
    // availableEffects target 不直调 ExtendScript，改读本模块缓存。
    // 缓存就绪 → 返回缓存（支持 filter/category 过滤）；未就绪 → 返回提示给 LLM。
    // bootstrap 注册与 controller 重新注册（saveTool/toggleToolEnabled）统一走这里，
    // 防止重新注册丢失缓存通道后 LLM 调用直通 jsx 层被拒。
    function createEffectsCacheHandler() {
        return function (args) {
            args = args || {};
            var cache = global.AEEffectsCache;
            if (!cache) {
                return Promise.resolve({
                    success: false, isError: true,
                    content: [{ type: 'text', text: '效果缓存模块未加载。' }]
                });
            }
            var st = cache.getState();
            // 缓存未就绪（generating / absent / skipped）：返回**降级说明**而不是报错
            // 旧行为是 isError=true 的失败回执——模型拿到一个不可用目标后
            // 只能自行绕路重试（真机会话里它反复换路径猜）。这里如实给三件事：为什么没有
            // 列表、怎么生成、在没有列表时怎么继续（queryAeApi 查 matchName / 原生挂载）。
            // 语义仍是 success，因为「本 target 当前不可用」是已预期状态，不是工具故障；
            // 回执用 status=unavailable 与真实结果（status=success）区分，不伪造空列表。
            if (st !== 'ready') {
                var _degrade = {
                    status: 'unavailable',
                    target: 'availableEffects',
                    cached: false,
                    reason: (st === 'generating') ? 'generating'
                        : (st === 'skipped' ? 'user_skipped' : 'cache_not_generated'),
                    message: (st === 'generating')
                        ? ('效果列表缓存正在生成（' + cache.getProgress() + '%），本次未返回列表；稍后重试本 target。')
                        : ('效果列表缓存未生成（' + (st === 'skipped' ? '用户已跳过' : '尚未生成') + '），本次未返回列表。'),
                    howToGenerate: 'AS_ExtP 面板 → AE 工具 → 设置 → 效果列表缓存 → 生成（分批遍历；生成期间 AE 会短暂卡顿，进度在面板进度卡片显示）。',
                    alternatives: [
                        '用 queryAeApi 查 matchName：queryAeApi(query="高斯", mode="fuzzy")（内置效果/属性词典，不需要缓存）',
                        '已知 matchName 时用 executeExtendScript 原生挂载：layer.property("ADBE Effect Parade").addProperty(matchName)',
                        '缓存生成后再调 queryEnvironment(target="availableEffects", effectFilter=...) 查完整列表（含插件效果）'
                    ]
                };
                if (st === 'generating') _degrade.progress = cache.getProgress();
                return Promise.resolve({
                    success: true,
                    content: [{ type: 'text', text: JSON.stringify(_degrade) }]
                });
            }
            return cache.read().then(function (data) {
                if (!data) {
                    return { success: false, isError: true, content: [{ type: 'text', text: '效果缓存读取失败，请重新生成。' }] };
                }
                var searchFilter = String(args.filter || '').toLowerCase();
                var categoryFilter = String(args.category || '').toLowerCase();
                var categories = data.categories || [];
                // 收集所有匹配效果为扁平列表
                var allEffects = [];
                for (var i = 0; i < categories.length; i++) {
                    var cat = categories[i];
                    if (categoryFilter && cat.category.toLowerCase().indexOf(categoryFilter) < 0) continue;
                    var effs = cat.effects || [];
                    for (var j = 0; j < effs.length; j++) {
                        var e = effs[j];
                        if (searchFilter && e.name.toLowerCase().indexOf(searchFilter) < 0 && e.matchName.toLowerCase().indexOf(searchFilter) < 0) continue;
                        allEffects.push({ name: e.name, matchName: e.matchName, category: cat.category });
                    }
                }
                // 分页
                var offset = (typeof args.itemOffset === "number" && args.itemOffset > 0) ? Math.floor(args.itemOffset) : 0;
                var limit = (typeof args.itemLimit === "number" && args.itemLimit > 0) ? Math.floor(args.itemLimit) : 20;
                if (limit > 100) limit = 100;
                var totalCount = allEffects.length;
                if (offset > totalCount) offset = totalCount;
                var endIdx = offset + limit;
                if (endIdx > totalCount) endIdx = totalCount;
                var paged = allEffects.slice(offset, endIdx);
                // 分页参数名检查（与 aeTools.jsx _checkPagingArgs 对齐）：此工具用 itemOffset/itemLimit
                var _fxWarnings = [];
                if (args.layerOffset !== undefined || args.layerLimit !== undefined) {
                    _fxWarnings.push('此 target 使用 itemOffset/itemLimit 分页，传入的 layerOffset/layerLimit 被忽略');
                }
                return {
                    success: true,
                    content: [{ type: 'text', text: JSON.stringify({
                        status: 'success',
                        effects: paged,
                        count: paged.length,
                        totalCount: totalCount,
                        itemOffset: offset,
                        itemLimit: limit,
                        hasMore: (offset + limit) < totalCount,
                        cached: true,
                        warnings: _fxWarnings.length > 0 ? _fxWarnings : undefined
                    }) }]
                };
            }).catch(function (e) {
                return { success: false, isError: true, content: [{ type: 'text', text: '效果缓存读取异常: ' + e }] };
            });
        };
    }

    // 包装 queryEnvironment 的注册 handler：availableEffects target 走缓存，其余
    // target（installPath/renderQueue/sceneSummary）透传原 handler 调 jsx 函数。
    // bootstrap 注册路径与 controller 重新注册路径（_saveTool/_toggleToolEnabled）共用。
    function wrapQueryEnvironmentHandler(innerHandler) {
        var _cacheHandler = createEffectsCacheHandler();
        // ctx（handler 第二参）必须**原样透传**：AE 队列的占用者归因读 `ctx.laneId`，
        // 丢掉它会让 queryEnvironment 永远以 laneId='single' 记账——等待/超时文案把 lane 记错
        //（三处包装器共用本函数：bootstrap 注册路径 + controller 的两条重新注册路径）。
        return function (args, ctx) {
            if (args && args.target === 'availableEffects') {
                // 走缓存：effectFilter 映射到缓存 handler 期望的 filter 参数
                var _cacheArgs = {
                    filter: args.effectFilter || args.filter || '',
                    category: args.category || '',
                    itemOffset: args.itemOffset,
                    itemLimit: args.itemLimit,
                    // 透传：cache handler 会对其"忽略+警告"，避免 LLM 误以为分页生效
                    layerOffset: args.layerOffset,
                    layerLimit: args.layerLimit
                };
                return _cacheHandler(_cacheArgs);
            }
            return innerHandler(args, ctx);
        };
    }

    global.AEEffectsCache = {
        init: function () { refreshState(); },
        getState: getState,
        getProgress: getProgress,
        read: read,
        startGeneration: startGeneration,
        regenerate: regenerate,
        skip: skip,
        checkOnBoot: checkOnBoot,
        wrapQueryEnvironmentHandler: wrapQueryEnvironmentHandler
    };
})(typeof window !== 'undefined' ? window : this);
