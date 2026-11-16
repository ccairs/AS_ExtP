(function (global) {
    // 画布状态持久化：graph.json 读写 + 自动存盘。
    // _result 中的图片路径会持久化，结果图本身在 _comfyui_output 目录。
    // opts: { dir, graph }

    // ── 原子写公共助手（对齐 ae-tools/effectsCache.js 的 .tmp → rename 模式）──
    // 先写 <file>.tmp 再 rename 到正式名，写盘窗口内进程中断不再留下半截文件。
    // renameFile 不可用（极端降级环境/仅 mock writeFile 的旧测试）时回退直写。
    // 全失败返回 false（调用方保持 dirty 待重试）。
    // rename 失败后的重试不再「删旧
    // 正式文件」——旧文件先挪 .recovery-<ts> 旁路，rename 成功才删旁路；仍失败
    // 则两份内容都留在盘上（tmp 改名 .recovery 留存、旁路旧文件尽力放回原位）。
    // retryOk==false 时 _cleanupTmp() 会删掉唯一幸存的新内容副本（旧正式文件
    // 已删）——graph.json 整块画布不可恢复丢失。
    function atomicWriteFile(filePath, content) {
        var AEFS = global.AEFS;
        if (!AEFS || typeof AEFS.writeFile !== 'function') return Promise.resolve(false);
        // 覆盖写前备份（typeof 守卫：本函数被测试单独抽取执行时助手不在
        // 作用域 → 退化为不备份，与既有降级口径一致）
        var backup = (typeof backupBeforeOverwrite === 'function')
            ? backupBeforeOverwrite(filePath) : Promise.resolve(false);
        if (typeof AEFS.renameFile !== 'function') {
            return backup.then(function () { return AEFS.writeFile(filePath, content); });
        }
        var tmpPath = filePath + '.tmp';
        var _inRetry = false;   // 重试阶段 tmp 可能成为新内容唯一副本，兜底不得清理
        var _recoverySeq = 0;
        function _nextRecoveryPath() {
            _recoverySeq = (_recoverySeq + 1) % 1000000000;
            return filePath + '.recovery-' + Date.now() + '-' + _recoverySeq;
        }
        function _cleanupTmp() {
            try { if (AEFS.deleteFile) AEFS.deleteFile(tmpPath).catch(function () {}); } catch (_) {}
        }
        function _preserveBothCopies(asidePath, movedOk) {
            var keepPath = _nextRecoveryPath();
            var park = AEFS.renameFile(tmpPath, keepPath).catch(function () {});
            var restore = movedOk ? AEFS.renameFile(asidePath, filePath).catch(function () {}) : null;
            return Promise.all([park, restore || Promise.resolve()]).then(function () { return false; });
        }
        return backup.then(function () {
            return AEFS.writeFile(tmpPath, content);
        }).then(function (writeOk) {
            if (!writeOk) return false;
            return AEFS.renameFile(tmpPath, filePath).then(function (renameOk) {
                if (renameOk) return true;
                // rename 失败先复核 tmp 仍在——并发写交错时（前一次写的
                // rename 恰在本调用 write 之后消费了同名 tmp），失败原因是 tmp 缺失
                // 而非目标已存在，此时删掉正式文件会毁掉并发者刚落位的好数据。
                // tmp 不在 → 放弃本次写入（调用方 dirty 保留自愈），绝不删正式文件。
                var recheck = (typeof AEFS.exists === 'function')
                    ? AEFS.exists(tmpPath) : Promise.resolve(true);
                return recheck.then(function (tmpAlive) {
                    if (!tmpAlive) return false;
                    var asidePath = _nextRecoveryPath();
                    _inRetry = true;
                    var moveAside = AEFS.renameFile(filePath, asidePath).then(function (ok) { return ok; },
                        function () { return false; });
                    return moveAside.then(function (movedOk) {
                        return AEFS.renameFile(tmpPath, filePath).then(function (retryOk) {
                            if (!retryOk) return _preserveBothCopies(asidePath, movedOk);
                            if (movedOk && AEFS.deleteFile) {
                                try { AEFS.deleteFile(asidePath).catch(function () {}); } catch (_) {}
                            }
                            return true;
                        });
                    });
                });
            });
        }).catch(function () {
            if (!_inRetry) _cleanupTmp();   // 重试阶段 tmp 是唯一副本，绝不清理
            return false;
        });
    }

    // 同步版原子写（saveSync/flush 用）。与异步版的差异：rename 失败时不走
    // "删旧重试"——同步 rename 通道（renameFileSync）仅 Bridge 可用，Bridge 挂掉时
    // rename 恒 false，先删旧文件会把仅存的好数据删掉（异步版有 ExtendScript
    // rename 兜底故无此风险）。此处回退直写正式文件，并清理 .tmp。
    function atomicWriteFileSync(filePath, content) {
        var AEFS = global.AEFS;
        if (!AEFS || typeof AEFS.writeFileSync !== 'function') return false;
        if (typeof backupBeforeOverwriteSync === 'function') backupBeforeOverwriteSync(filePath);
        if (typeof AEFS.renameFileSync !== 'function') return AEFS.writeFileSync(filePath, content);
        var tmpPath = filePath + '.tmp';
        if (!AEFS.writeFileSync(tmpPath, content)) return false;
        if (AEFS.renameFileSync(tmpPath, filePath)) return true;
        var directOk = AEFS.writeFileSync(filePath, content);
        try { if (AEFS.deleteFileSync) AEFS.deleteFileSync(tmpPath); } catch (_) {}
        return directOk;
    }

    // ── 损坏文件保留为 <file>.corrupt.bak ──
    // load 侧解析失败时先把损坏文件挪到 .bak（旧数据可手工恢复），再走空态；
    // 后续用户操作落盘覆盖的是新数据，不影响 .bak。rename 失败（如 .bak 已存在，
    // rename 通道对已存在目标可能失败）时删旧 .bak 重试一次；再失败回退 copyFile
    // （原件留在原位，由下次原子写替换）；任何失败仅返回 false 不抛（空态流程不因
    // 备份失败而中断）。
    function backupCorruptFile(filePath) {
        var AEFS = global.AEFS;
        var bakPath = filePath + '.corrupt.bak';
        if (!AEFS) return Promise.resolve(false);
        if (typeof AEFS.renameFile === 'function') {
            return AEFS.renameFile(filePath, bakPath).then(function (ok) {
                if (ok) return true;
                var del = (typeof AEFS.deleteFile === 'function')
                    ? AEFS.deleteFile(bakPath) : Promise.resolve(true);
                return del.then(function () {
                    return AEFS.renameFile(filePath, bakPath);
                }, function () { return false; }).then(function (ok2) {
                    // rename 双失败（.bak 被占用/通道异常）回退 copyFile——
                    // 损坏原件留在原位虽会被随后的空态重建覆盖，但 .bak 里已有副本可恢复
                    if (ok2) return true;
                    if (typeof AEFS.copyFile !== 'function') {
                        console.warn('[ComfyUI Canvas] 损坏文件备份失败: ' + filePath);
                        return false;
                    }
                    return AEFS.copyFile(filePath, bakPath).then(function (cpOk) {
                        if (!cpOk) console.warn('[ComfyUI Canvas] 损坏文件备份失败: ' + filePath);
                        return cpOk;
                    });
                });
            }, function () {
                console.warn('[ComfyUI Canvas] 损坏文件备份失败: ' + filePath);
                return false;
            });
        }
        if (typeof AEFS.copyFile === 'function') {
            return AEFS.copyFile(filePath, bakPath).then(function (ok) {
                if (!ok) console.warn('[ComfyUI Canvas] 损坏文件备份失败: ' + filePath);
                return ok;
            }, function () {
                console.warn('[ComfyUI Canvas] 损坏文件备份失败: ' + filePath);
                return false;
            });
        }
        return Promise.resolve(false);
    }

    // ── 覆盖写前的正式文件备份（<file>.bak）──
    // 读失败被折叠成「空」后，任何一次落盘都会把原文件覆盖成空/新内容。
    // 覆盖前先把现存的正式文件复制为 <file>.bak（命名与兜底思路对齐会话索引的 .bak
    // 写法），原内容至少可手工恢复。备份失败（源不存在/通道故障/备份通道不可用）
    // 仅告警不阻塞写入。exists/copyFile 任一不可用（降级 mock/旧 AEFS）→ 跳过备份
    //（对齐 renameFile 不可用回退直写的既有降级口径）。graph.json 与 canvases.json
    // 的写盘共用本助手（注册表经 AEComfyUI.atomicWriteFile 复用）。
    function backupBeforeOverwrite(filePath) {
        var AEFS = global.AEFS;
        if (!AEFS || typeof AEFS.copyFile !== 'function' || typeof AEFS.exists !== 'function') {
            return Promise.resolve(false);
        }
        return AEFS.exists(filePath).then(function (there) {
            if (!there) return false;
            return AEFS.copyFile(filePath, filePath + '.bak').then(function (ok) {
                if (!ok) console.warn('[ComfyUI Canvas] 覆盖写前备份失败（不阻塞写入）: ' + filePath);
                return ok;
            }, function () { return false; });
        }, function () { return false; });
    }

    // 同步版（saveSync/flush 用）——copyFileSync/existsSync 不可用时跳过备份
    function backupBeforeOverwriteSync(filePath) {
        var AEFS = global.AEFS;
        if (!AEFS || typeof AEFS.copyFileSync !== 'function' || typeof AEFS.existsSync !== 'function') return false;
        try {
            if (!AEFS.existsSync(filePath)) return false;
            return !!AEFS.copyFileSync(filePath, filePath + '.bak');
        } catch (_) { return false; }
    }

    // ── 存盘失败的用户可见提示 ──
    // save/saveSync/flushSyncNow 的写失败只留 console.warn：磁盘满/只读时
    // 连续编辑一小时全部静默失败，关面板也只在 console 留痕（只有切画布调用点给 toast，
    // canvasIndex.js:3202/3262）。对齐 sessionStore._noteSaveFailure 的提示通道
    //（AEToast.show error），去重口径改为「一次性标记」：同一失败期只提示一次（1.5s 防抖
    // 连续失败不刷屏），任一路径成功落盘即复位——恢复后再次失败可再提示一次。
    // 仅提示，不自动重试、不改写 dirty 语义（dirty 保持待下次防抖重试）。
    var _saveFailureNoted = false;
    function noteSaveFailure() {
        if (_saveFailureNoted) return;
        _saveFailureNoted = true;
        try {
            if (global.AEToast && typeof global.AEToast.show === 'function') {
                global.AEToast.show(AEI18n.t('画布保存失败（磁盘空间/文件占用/权限），最近改动可能未落盘，请检查后重试'), 'error', { autoHideMs: 6000 });
            }
        } catch (_) {}
        console.warn('[ComfyUI Canvas] 画布存盘失败（已向用户提示，dirty 保持待重试）');
    }
    function clearSaveFailure() {
        // 成功落盘即复位标记：恢复后再次失败可再提示一次
        _saveFailureNoted = false;
    }

    // ── 持久化边界的数据目录相对化 ─────────────────────────────
    // 落盘形态存「数据根相对路径」（换目录后仍指向新根），加载时还原成绝对。
    // 单一实现源 = client/shared/dataDir.js（AEShared.toDataRelPath/fromDataRelPath）；
    // 未注入（旧测试沙箱/降级环境）时退化为恒等 → 行为与改造前一致。
    function _mapParamPaths(obj, conv) {
        if (typeof obj === 'string') return conv(obj);
        if (!obj || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) {
            for (var i = 0; i < obj.length; i++) obj[i] = _mapParamPaths(obj[i], conv);
            return obj;
        }
        for (var k in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
            obj[k] = _mapParamPaths(obj[k], conv);
        }
        return obj;
    }
    function _relConv(root, toRel) {
        var f = global.AEShared && (toRel ? global.AEShared.toDataRelPath : global.AEShared.fromDataRelPath);
        if (typeof f !== 'function') return function (s) { return s; };
        return function (s) { return f(root, s); };
    }

    function createNodegenStore(opts) {
        opts = opts || {};
        var dir = opts.dir || '';
        var filePath = opts.file || (dir + '/nodegen/graph.json');
        var graph = opts.graph;
        var dirty = false;
        var _dirtySeq = 0;   // 单调版本号：save 完成回调只在期间无新修改时才清 dirty（防异步清脏竞态吞改动）
        var saveTimer = null;
        // （petHistory._writeInFlight 姊妹位）：在途异步写计数。异步 save 与
        // saveSync/flush 共用 <file>.tmp 路径——同步直写会与在途异步写的 writeFile/rename
        // 交错，旧快照可后到 rename 覆盖新内容（见 flush 注释）。计数在写 Promise 落定
        // （含失败）后递减；flush 在有在途写时改为排队异步写、不同步直写。
        var _writeInFlight = 0;
        // 加载在途锁。store 是单实例 + setFile 换目标，
        // setFile 后到该 filePath 的 load 落定前，graph 是 _clearRuntime 清空的中间态；
        // beforeunload 的 flushSyncNow 不做 dirty 判断，会把空/上一画布快照同步原子写进
        // 目标画布文件（旧 flush 因 dirty=false 不写），原内容只剩 .bak。setFile 进入加载
        // 态，load 落定（成功 / NOT_FOUND 空态 / 损坏已备份后的 clearReadFailure）才允许
        // 卸载同步写；新建空画布经 setFile(path, {ready:true}) 直接就绪（文件全新，无内容可毁）。
        var _loading = false;
        var _loadedFile = null;   // 最近一次加载落定/确认就绪的 filePath（诊断用）
        // 读失败态（三态读的失败支）/ 未就绪只读锁——一旦置位，save/saveSync/
        // flush 一律拒绝落盘（返回 false）。读取通道故障或解析失败时若把结果折叠成
        // 「空画布/空注册表」，随后任意一次编辑（1.5s 防抖存盘）就把原 graph.json 覆盖掉
        // ——原内容不可恢复。
        // 粒度修正：本 store 是「每画布一个实例」不成立，而是**单实例 + setFile
        // 换目标**（canvasIndex 全模块只 createNodegenStore 一次）。因此两个锁的语义必须
        // 分开：_readFailed 是**文件级**（针对当前 filePath 的一次读失败），换文件即由
        // setFile 复位、由下一次 load 重新判定；_readOnly 是**模块/会话级**（canvasIndex
        // 注册表读取失败时置位），不随换文件解除。语义含糊地把 _readFailed 也当
        // 会话级永久锁，导致单个坏画布文件把切换/新建/改名/删除全部锁死。
        var _readFailed = false;
        var _readError = null;   // { code, message, channel, backupOk? }
        var _readOnly = false;   // canvasIndex 显式置位（如注册表读取失败 → 画布未就绪）

        function _writeBlocked() {
            if (!_readFailed && !_readOnly) return false;
            console.warn('[ComfyUI Canvas] 画布未就绪（读取失败），已禁止覆盖写防原文件丢失: ' + filePath);
            return true;
        }
        function isReadFailed() { return _readFailed || _readOnly; }
        function getReadError() { return _readError; }
        // 只读/未就绪置位（模块/会话级：成功 load 不解除；直到本次会话重启）
        function setReadOnly(reason) {
            _readOnly = true;
            if (!_readError) _readError = { code: 'READ_ONLY', message: String(reason || '画布未就绪'), channel: null };
        }
        // 粒度修正：文件级读失败锁复位——canvasIndex 在确认「该画布文件损坏且
        // 原文已成功备份为 .corrupt.bak（backupOk）」后调用，让坏文件按既有 .corrupt 惯例
        // 让位给新内容（空画布继续可写）。只清 _readFailed；注册表级 _readOnly 时返回 false
        // 且不复位（注册表未就绪则任何文件都不得写）。
        function clearReadFailure(reason) {
            if (_readOnly) return false;
            _readFailed = false;
            _readError = null;
            // canvasIndex 确认「损坏原文已备份、按空画布继续」→ 当前文件视为
            // 加载完成（空态即当前内容），卸载同步写恢复可用
            _loading = false;
            _loadedFile = filePath;
            console.warn('[ComfyUI Canvas] 画布读失败锁复位（' + (reason || '调用方确认可覆盖') + '）: ' + filePath);
            return true;
        }

        // 序列化快照供存盘。_result（生成结果图片路径）需要持久化，
        // 以便切换画布后切回来时能恢复缩略图预览。
        function serializeForSave(g, groups) {
            var snap = (g || graph).serialize();
            if (groups && groups.length) snap.groups = JSON.parse(JSON.stringify(groups));
            // 落盘形态 = 数据根相对路径（换目录后仍指向新根）；
            // _frameHTMLs 是渲染缓存（内含绝对 file:// URL，换目录后必失效）不落盘——
            // 加载后由 canvasIndex 从 _result/_placeholders 重建。
            var conv = _relConv(dir, true);
            var nodes = (snap && snap.nodes) || [];
            for (var i = 0; i < nodes.length; i++) {
                var pr = nodes[i] && nodes[i].params;
                if (!pr) continue;
                delete pr._frameHTMLs;
                _mapParamPaths(pr, conv);
            }
            return snap;
        }

        // 历史栈专用快照：nodes/edges/groups 按实时引用拼装、**不做深拷贝**——解耦改由
        // 历史栈侧「一次 JSON.stringify + parse 回对象」完成（见 canvasHistory.push 注释）。
        // 历史链若走 serializeForSave（graph.serialize 深拷贝
        // stringify+parse，groups 再各拷一次）后又被栈顶去重键二次 stringify，同一份数据
        // 序列化两次；本方法只拼装，序列化只发生一次。仅限「同一 tick 内立即序列化」的
        // 消费者（canvasIndex 历史栈接线）使用，不得跨 tick 持有、不得直接入栈共享引用。
        function snapshotForHistory(g, groups) {
            var gg = g || graph;
            var snap = { nodes: gg.nodes(), edges: gg.edges() };
            if (groups && groups.length) snap.groups = groups;
            return snap;
        }

        // 把快照灌回空 graph，返回 {ids, idMap, groups}。
        // 关键：addNodeWithId 复用快照原始 id（identity map，避免 reload 换 id）；
        // idMap 仍用于边/分组/imageOrder 的重连校验，保证端点不指向不存在的 id（ghost edge）。
        function applyToGraph(snapshot, g) {
            g = g || graph;
            var addedIds = [];
            var idMap = {};  // 旧快照 id → 新图 id
            var edgeIdMap = {};  // 旧边 id → 新边 id（用于重映射 imageOrder）
            var nodes = (snapshot && snapshot.nodes) || [];
            for (var i = 0; i < nodes.length; i++) {
                var sn = nodes[i];
                try {
                    var id = g.addNodeWithId(sn.type, sn.id, { x: sn.x || 0, y: sn.y || 0 });
                    idMap[sn.id] = id;  // addNodeWithId 用原始 ID → identity map
                    var node = g.getNode(id);
                    if (node) {
                        // 落盘存的是数据根相对路径 → 还原成绝对（已是绝对的原样）
                        node.params = _mapParamPaths(JSON.parse(JSON.stringify(sn.params || {})), _relConv(dir, false));
                        node.note = sn.note || '';
                        node.color = sn.color || '';
                        node.title = sn.title || '';   // 恢复内联重命名（缺失时重载后标题回退为类型名）
                    }
                    addedIds.push(id);
                } catch (e) {
                    console.error('[ComfyUI Canvas] applyToGraph: 节点 ' + (i) + ' (type=' + sn.type + ') 创建失败:', (e && e.message) || e);
                }
            }
            var edges = (snapshot && snapshot.edges) || [];
            for (var j = 0; j < edges.length; j++) {
                try {
                    var nf = idMap[edges[j].from], nt = idMap[edges[j].to];
                    if (!nf || !nt) { console.warn('[ComfyUI Canvas] 恢复连线失败: 端点缺失', edges[j]); continue; }
                    // 端口迁移：videoGen 输出端口 'video' → 'videoOut'（原名与输入端口 'video' 同名，
                    // portTypeOf 先命中 inputs 导致输出被遮蔽为 video[]）。旧 graph.json 中从 videoGen
                    // 连出的边 fromPort='video'，不改写会被误解析成输入端口类型、取值恒 undefined。
                    var fromPort = edges[j].fromPort;
                    var fromNode = g.getNode(nf);
                    if (fromNode && fromNode.type === 'videoGen' && fromPort === 'video') fromPort = 'videoOut';
                    g.connect(nf, fromPort, nt, edges[j].toPort);
                    // 连接成功后，最后一条边就是刚创建的 → 取它的 id 做映射
                    var newEdges = g.edges();
                    if (newEdges.length) edgeIdMap[edges[j].id] = newEdges[newEdges.length - 1].id;
                }
                catch (e) { console.warn('[ComfyUI Canvas] 恢复连线失败:', e.message); }
            }
            // 重映射 imageOrder / videoOrder：旧边 ID → 新边 ID（两者结构同构，edge id 序列）
            for (var k = 0; k < nodes.length; k++) {
                try {
                    var mappedId = idMap[nodes[k].id];
                    if (!mappedId) continue;
                    var p = (g.getNode(mappedId) || {}).params;
                    if (p) {
                        var orderKeys = ['imageOrder', 'videoOrder'];
                        for (var oki = 0; oki < orderKeys.length; oki++) {
                            var ord = p[orderKeys[oki]];
                            if (ord && ord.length) {
                                var remapped = [];
                                for (var oi = 0; oi < ord.length; oi++) {
                                    var newEid = edgeIdMap[ord[oi]];
                                    if (newEid) remapped.push(newEid);
                                }
                                p[orderKeys[oki]] = remapped.length ? remapped : ord;
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[ComfyUI Canvas] applyToGraph: order 重映射失败:', (e && e.message) || e);
                }
            }
            // 重映射分组的 childIds：旧节点 ID → 新节点 ID
            if (snapshot.groups && snapshot.groups.length) {
                for (var gi = 0; gi < snapshot.groups.length; gi++) {
                    try {
                        var grp = snapshot.groups[gi];
                        var newChildIds = [];
                        for (var ci = 0; ci < (grp.childIds || []).length; ci++) {
                            var nid = idMap[grp.childIds[ci]];
                            if (nid) newChildIds.push(nid);
                        }
                        grp.childIds = newChildIds;
                        grp.childGroupIds = grp.childGroupIds || [];
                    } catch (e) {
                        console.warn('[ComfyUI Canvas] applyToGraph: 分组 childIds 重映射失败:', (e && e.message) || e);
                    }
                }
            }
            return { ids: addedIds, idMap: idMap, groups: snapshot.groups || [] };
        }

        var _groupsRef = null;  // 外部注入的分组数组引用
        var _onDirty = null;   // 外部注入的脏标记回调（画布历史栈借此触发防抖 push）

        function setGroupsRef(groups) { _groupsRef = groups; }
        function setOnDirty(fn) { _onDirty = fn; }
        // 切换画布文件：改写存盘目标 + 清存盘定时器（防旧定时器到点以新画布数据触发存盘）。
        // 不再无条件清 dirty——切换前 flush 同步失败（AEFS 不可用/写通道失败）时，
        // 旧画布的未保存改动不再被静默标记为已存；脏标记交由 save() 的 seq 守卫完成
        // 回调与 load() 的完成复位清理（setFile 后调用方必经 load/_renderLoadedCanvas 重建）。
        // 粒度修正：_readFailed 是「针对旧文件」的读失败——换目标后由下一次
        // load 重新判定，故此处复位（_readOnly 模块级锁不解除）；否则一次坏文件会让
        // 之后所有画布的编辑都被 _writeBlocked() 静默拒绝落盘。
        // opts.ready=true 表示调用方明确该文件无需加载即为当前内容（新建空画布）。
        // 其余调用进入加载态——直到 load 落定前 flushSyncNow/flush 不得把中间态空图写盘。
        function setFile(path, opts) {
            filePath = path || filePath;
            if (!_readOnly) { _readFailed = false; _readError = null; }
            if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
            if (opts && opts.ready) {
                _loading = false;
                _loadedFile = filePath;
            } else {
                _loading = true;
                _loadedFile = null;
            }
        }
        function getFile() { return filePath; }

        // 异步存盘：fire-and-forget，仅在写盘成功时清 dirty（防静默丢）
        // dirtySeq 版本守卫：写盘在途期间若有新修改（seq 已递增），完成回调不得清 dirty——
        // 否则新修改既不在本次快照里、防抖定时器到点见 dirty=false 又跳过 → 静默丢失
        function save(g) {
            if (_writeBlocked()) return false;
            if (!global.AEFS || !global.AEFS.writeFile) { console.warn('[ComfyUI Canvas] 存盘失败: AEFS 不可用'); noteSaveFailure(); return false; }
            try {
                var seq = _dirtySeq;
                var snap = serializeForSave(g, _groupsRef);
                var content = JSON.stringify(snap);
                // 原子写（.tmp → rename）——写盘窗口内进程中断不再留下半截
                // graph.json（损坏时会被空画布静默重置并覆盖，丢失全部画布数据）
                var p;
                try {
                    p = atomicWriteFile(filePath, content);
                } catch (e) {
                    console.warn('[ComfyUI Canvas] 存盘异常:', (e && e.message) || e);
                    noteSaveFailure();   // 写失败首次即用户可见（去重）
                    return false;
                }
                _writeInFlight++;
                Promise.resolve(p).then(function (ok) {
                    _writeInFlight--;
                    if (ok) { if (seq === _dirtySeq) dirty = false; clearSaveFailure(); }
                    else { console.warn('[ComfyUI Canvas] 存盘失败(原子写), dirty 保持待重试'); noteSaveFailure(); }
                }, function (e) {
                    _writeInFlight--;
                    console.warn('[ComfyUI Canvas] 存盘失败(原子写), dirty 保持待重试:', (e && e.message) || e);
                    noteSaveFailure();
                });
                return true;
            } catch (e) {
                console.warn('[ComfyUI Canvas] 存盘异常:', e.message);
                noteSaveFailure();
                return false;
            }
        }

        function saveSync(g) {
            if (_writeBlocked()) return false;
            if (!global.AEFS || !global.AEFS.writeFileSync) { noteSaveFailure(); return false; }
            try {
                // 同步路径同样原子写（.tmp → renameSync；rename 通道不可用回退直写）
                var ok = atomicWriteFileSync(filePath, JSON.stringify(serializeForSave(g, _groupsRef)));
                if (!ok) { console.warn('[ComfyUI Canvas] 同步存盘失败(原子写), dirty 保持'); noteSaveFailure(); return false; }
                dirty = false;
                clearSaveFailure();
                return true;
            } catch (e) {
                console.warn('[ComfyUI Canvas] 同步存盘异常:', e.message);
                noteSaveFailure();
                return false;
            }
        }

        // 异步加载快照，灌回 graph，回调 (result, err)——result 恒为 {ids, idMap, groups}
        //（保持既有回调形状，损坏/失败分支仍给空 result，避免调用方解引用崩）；
        // err 非空表示本次加载失败（三态读的失败支），调用方须中止加载流程并保持只读。
        // 完成（含各失败分支的空态收尾）一律复位 dirty——setFile 不再清脏后，
        // 旧画布残留的脏标记须由加载终态收掉，否则新画布无修改也会被判脏触发空写
        // 读取改三态——readFile 把 NOT_FOUND 与 CHANNEL_FAILURE 都折叠成
        // null（据此走空画布，1.5s 后的防抖存盘把原 graph.json 覆盖成空，
        // 画布内容不可恢复）。有 readFileResult 时：NOT_FOUND（真没有）→ 空画布
        // 语义不变；CHANNEL_FAILURE/REJECTED（拿不到/不该读）→ 上抛 err 并置读失败态
        // 禁止一切覆盖写。解析失败/applyToGraph 异常同样上抛（损坏原文先留 .corrupt.bak）。
        function load(g, cb) {
            g = g || graph;
            var EMPTY = { ids: [], idMap: {}, groups: [] };
            // 捕获本次 load 的目标文件——落定时只在「仍是当前 filePath」才解除
            // 加载态。快速切换时旧文件的迟到回调不得把新文件的在途加载误标成就绪
            //（否则 beforeunload 仍会把新画布中间态写进其文件）。
            var loadFile = filePath;
            // 本次 load 的落定只作用于**发起时捕获的
            // loadFile**。若只守卫 _loading/_loadedFile，_readFailed/_readError 与
            // dirty 无条件改写：setFile 切到 B 后 A 迟到失败 → B 被锁（save/flush/
            // flushSyncNow 全拒绝，最后一次编辑丢失）；A 迟到成功 → 清掉 B 真实的读失败锁
            // （B 读不出文件可被空/中间态快照覆盖）；dirty 被清 → B 的在途修改不再触发防抖
            // 存盘。迟到落定一律不写任何状态、不回调（canvasIndex 各 load 回调均带
            // _loadToken 守卫，过期回调本就立即 return）。
            function done(result, err) {
                if (loadFile !== filePath) return;
                if (err) {
                    _readFailed = true;
                    _readError = err;
                } else {
                    _readFailed = false;
                    _readError = null;
                }
                dirty = false;
                _loading = false;
                _loadedFile = err ? null : loadFile;
                if (cb) cb(result || EMPTY, err || null);
            }
            function readFatal(code, message, channel, extra) {
                // 日志归到本次读取的目标（loadFile）：迟到落定时当前 filePath 可能已是另一
                // 画布，用 filePath 会把 A 的失败记到 B 头上
                console.warn('[ComfyUI Canvas] 画布读取失败（' + code + '）：' + loadFile + ' — ' + message + '，本次未加载，已禁止覆盖写');
                var err = { code: code, message: String(message == null ? '' : message), channel: channel || null };
                // 粒度修正：附加判据随 err 上抛（如 PARSE_FAILED 的 backupOk）——
                // canvasIndex 据此区分「损坏但原文已备份 → 可按空画布重置」与
                // 「通道故障/备份失败 → 只标记该画布不可用、绝不覆盖」
                if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) err[k] = extra[k]; } }
                done(EMPTY, err);
            }
            function consume(text) {
                if (!text) { done(EMPTY, null); return; }   // 0 字节/空文件：数据已失，维持空画布旧语义
                var snap = null;
                try { snap = JSON.parse(text); }
                catch (e) {
                    // 解析失败先把损坏文件保留为 .corrupt.bak（cb 等备份完成后再
                    // 触发，避免与备份竞态）；随后按读失败上抛，不再落空画布——
                    // 旧语义渲染空画布后任意编辑即覆盖，本次不写入，原文件保留在 .bak
                    // 备份目标必须是本次 load 捕获的 loadFile——
                    // 迟到落定时 filePath 已切到 B，会把 B 的文件挪成 B.corrupt.bak
                    console.warn('[ComfyUI Canvas] graph.json 解析失败，已保留损坏文件为 ' + loadFile + '.corrupt.bak，中止本次加载:', e.message);
                    backupCorruptFile(loadFile).then(function (backupOk) {
                        // backupOk=false（rename/copyFile 全失败）时 canvasIndex 不得放行写入：
                        // 否则原文件是损坏内容唯一副本，覆盖即不可恢复
                        readFatal('PARSE_FAILED', 'graph.json 解析失败: ' + ((e && e.message) || e), null, { backupOk: !!backupOk });
                    });
                    return;
                }
                var result;
                try {
                    result = applyToGraph(snap, g);
                } catch (e) {
                    // applyToGraph 半途失败时 graph 已是部分态（继续渲染/落盘即写坏原文件）
                    console.error('[ComfyUI Canvas] applyToGraph 失败:', (e && e.message) || e);
                    readFatal('APPLY_FAILED', 'fill graph 失败: ' + ((e && e.message) || e));
                    return;
                }
                done(result || EMPTY, null);
            }
            if (!global.AEFS || (!global.AEFS.readFile && !global.AEFS.readFileResult)) { done(EMPTY, null); return; }
            if (typeof global.AEFS.readFileResult === 'function') {
                var pr = global.AEFS.readFileResult(filePath);
                if (!pr || typeof pr.then !== 'function') { done(EMPTY, null); return; }
                pr.then(function (r) {
                    if (!r || r.ok !== true) {
                        var e = r && r.error;
                        var code = (e && e.code) || 'CHANNEL_FAILURE';
                        if (code === 'NOT_FOUND') { done(EMPTY, null); return; }   // 真不存在 → 空画布（旧语义）
                        readFatal(code, (e && e.message) || '读取通道失败', e && e.channel);
                        return;
                    }
                    consume(r.data);
                }, function (err) {
                    readFatal('CHANNEL_FAILURE', (err && err.message) || err || '读取异常', null);
                });
                return;
            }
            var p = global.AEFS.readFile(filePath);
            if (!p || typeof p.then !== 'function') { done(EMPTY, null); return; }
            p.then(function (text) { consume(text); }, function (err) {
                // 旧式折叠路径（无 readFileResult 的降级 AEFS/mock）：reject 已是通道故障，
                // 保留旧「空画布」语义会重演覆盖链，故按读失败上抛
                console.error('[ComfyUI Canvas] readFile rejected:', (err && err.message) || err);
                readFatal('CHANNEL_FAILURE', (err && err.message) || err || 'readFile rejected', null);
            });
        }

        function markDirty() {
            dirty = true;
            _dirtySeq++;
            // 通知画布历史栈（防抖 push 一份快照）。restore 内部 suppress 时不回灌。
            if (_onDirty) { try { _onDirty(); } catch (e) {} }
            if (saveTimer) return;
            saveTimer = setTimeout(function () {
                saveTimer = null;
                if (dirty) save();
            }, 1500);  // 防抖 1.5s
        }

        // 静默置脏——只置 dirty/_dirtySeq 并调度落盘，不触发 _onDirty。
        // undo/redo restore 链的置脏经此通道：restore 走 applyToGraph 全量
        // 重建（节点/边 id 重分配），onDirty 触发的 800ms 防抖 push 与栈顶 _topKey 必然
        // 不等（含旧 id），去重失效 → redoStack 被清空 + undo 栈被逻辑等价的重复快照
        // 污染（表现为 undo 后 redo 失效、下一次 undo 需按两次）。
        function markDirtySilent() {
            dirty = true;
            _dirtySeq++;
            if (saveTimer) return;
            saveTimer = setTimeout(function () {
                saveTimer = null;
                if (dirty) save();
            }, 1500);
        }

        // ── 关面板同步兜底（收口，仅卸载路径调用）────────────────────
        // 页面销毁（beforeunload/关窗）时在途异步链（backup→writeFile→rename，走 Bridge
        // fetch）必被中断——flush() 在 _writeInFlight>0 时只排队一次异步写，该排队写同样
        // 活不过卸载窗口，最后一次编辑仍丢。本入口无视在途计数，用同步原子写
        // （atomicWriteFileSync → AEFS.writeFileSync/renameFileSync；AEFS.writeFileSync
        // 内部已含 cep.fs 原生同步兜底，见 client/shared/aefs.js:552）把当前快照落盘。
        // 与在途异步写共用 <file>.tmp 的竞态在本场景可接受：页面销毁会中断异步链，
        // 不存在它随后落下旧快照的动作；若同步通道不可用（旧 mock/降级环境）则退回
        // save() 异步排队（与既有降级口径一致，尽力而为）。
        // 读失败/未就绪锁优先：拒绝任何覆盖写。不做 dirty 判断——卸载是
        // 最后机会，直接落当前快照；无修改时同内容重写无副作用。
        function flushSyncNow() {
            if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
            if (_writeBlocked()) return false;
            // （数据丢失）：该 filePath 尚未加载完成（setFile 后 load 落定前，
            // graph 已被 _clearRuntime 清空/仍是上一画布中间态）→ 拒绝卸载同步写。
            // 否则关面板会把空快照原子写进目标画布文件，原内容只剩 .bak 且 store 不
            // 自动恢复。load 落定 / 新建就绪 / 损坏已备份重置后才放行。
            if (_loading) {
                console.warn('[ComfyUI Canvas] 画布尚未加载完成，卸载同步写拒绝（防空快照覆盖原文件）: ' + filePath);
                return false;
            }
            try {
                if (global.AEFS && typeof global.AEFS.writeFileSync === 'function') {
                    var ok = atomicWriteFileSync(filePath, JSON.stringify(serializeForSave(null, _groupsRef)));
                    if (ok) { dirty = false; clearSaveFailure(); }
                    else { console.warn('[ComfyUI Canvas] 卸载同步存盘失败(原子写)'); noteSaveFailure(); }
                    return ok;
                }
            } catch (e) {
                console.warn('[ComfyUI Canvas] 卸载同步存盘异常: ' + ((e && e.message) || e));
                noteSaveFailure();
                return false;
            }
            return save();
        }

        // 卸载/切画布前落盘（保证落盘完成）；Bridge/cep.fs 不可用才回退异步。
        // 返回同步结果——false 表示 dirty 未落盘（AEFS 不可用或写通道失败），
        // 切换画布的调用方据此提示"旧画布存盘失败"；异步 save 路径返回 true 仅代表
        // 已发起（结果由 seq 守卫回调处理），fire-and-forget 语义不变
        // 收口：卸载（关面板）不用本方法，用 flushSyncNow——有在途异步写时
        // 本方法只排队异步写，卸载窗口内必丢。
        function flush() {
            if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
            if (dirty) {
                if (_writeBlocked()) return false;   // 读失败/未就绪：拒绝覆盖写
                // 加载在途时不得落盘（unmount/切画布入口同受保护）——graph 是
                // 中间态，写盘即把空/旧快照盖进目标文件。返回 false 由调用方如实提示。
                if (_loading) {
                    console.warn('[ComfyUI Canvas] 画布尚未加载完成，同步存盘拒绝（防空快照覆盖原文件）: ' + filePath);
                    return false;
                }
                // 有在途异步写时不得同步直写——两者共用 <file>.tmp，交错时序可
                // 为「saveSync 写 tmp+rename 落位新快照 → 在途旧快照的 writeFile 后到覆盖
                // tmp、rename 再把旧内容盖回正式文件」，而 saveSync 又把 dirty 清成 false
                // → 旧快照成为最终内容且不再重试（静默回退）。对齐 petHistory.flush 的
                // _writeInFlight 守卫：排队一次异步写（同一原子通道，写序自愈由 seq/rename
                // 复核兜底：失败不清 dirty，见 save 回调），返回 false 表示本次未同步确认
                // 落盘——beforeunload 等卸载窗口内该排队写可能来不及完成，取舍见 canvasIndex 退出钩子。
                if (_writeInFlight > 0) { save(); return false; }
                if (global.AEFS && global.AEFS.writeFileSync) { return saveSync(); }
                return save();
            }
            return true;
        }

        return {
            serializeForSave: serializeForSave,
            // 历史栈专用浅快照（一次序列化由 canvasHistory.push 完成）
            snapshotForHistory: snapshotForHistory,
            applyToGraph: applyToGraph,
            save: save,
            saveSync: saveSync,
            load: load,
            markDirty: markDirty,
            markDirtySilent: markDirtySilent,
            flush: flush,
            // 收口：卸载专用同步落盘（canvasIndex beforeunload 钩子调用）
            flushSyncNow: flushSyncNow,
            setGroupsRef: setGroupsRef,
            setOnDirty: setOnDirty,
            setFile: setFile,
            getFile: getFile,
            // 读失败态查询/未就绪置位——canvasIndex 据此中止渲染并保持只读
            isReadFailed: isReadFailed,
            getReadError: getReadError,
            setReadOnly: setReadOnly,
            // 粒度修正：损坏文件已备份后的文件级锁复位（模块级 _readOnly 下无效）
            clearReadFailure: clearReadFailure
        };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createNodegenStore = createNodegenStore;
    // 原子写/损坏备份助手导出——canvasIndex 的 canvases.json 注册表复用
    // （本文件先于 canvasIndex.js 加载，见 scripts.manifest.js 顺序）
    global.AEComfyUI.atomicWriteFile = atomicWriteFile;
    global.AEComfyUI.backupCorruptFile = backupCorruptFile;
})(window);
