(function (global) {
    global.AEAssetsShared = global.AEAssetsShared || {};

    var ITEMS_WARN = 750;   // 项目面板元素数超此值，reduceProject 会卡，弹警告
    var IMPORT_WARN_COUNT = 100;   // 批量导入文件数超此值，先弹确认提示
    var NOTICE_THRESHOLD = 8;    // 工程素材批量操作超此数量才显示进度条（少量静默处理）
    var SOURCE_EMOJI = { whole: '📦', comp: '🎬', layer: '🎚️', bundle: '📦' };
    // 索引字段 sourceName 的固定源文：落盘值与界面语言无关（t() 只在显示侧查询；
    // 旧数据可能是任何语言的同值文本，读侧不比较、不迁移）。
    var SOURCE_NAME_PROJECT = '工程';
    var SOURCE_NAME_BUNDLE = '工程包';

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // 路径转义进 ExtendScript 字符串字面量
    // null byte 转义：纵深防御，防止 C-string 语义下截断字符串字面量
    // U+2028/U+2029 在 ES3 字符串字面量中是行终止符，未转义会让 evalScript 解析失败
    function _escPath(p) {
        return String(p || '')
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t')
            .replace(/\0/g, '\\0')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    function _fmtSize(bytes) {
        if (!bytes) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }
    // 合成时间（秒）→ 两位小数（预览取自合成的哪个时刻；固定两位便于对齐辨认）
    function _fmtSec(t) {
        var n = Number(t);
        return isFinite(n) ? n.toFixed(2) : '0.00';
    }
    // 文件路径归一（比较用）：统一分隔符 + 小写（Windows 大小写不敏感）
    function _normFsPath(p) {
        return String(p == null ? '' : p).replace(/\\/g, '/').toLowerCase();
    }
    // 自动生成安全的素材名（去扩展名 + sanitize 非法文件名字符）
    function _autoName(s, fallback) {
        var n = String(s || fallback || 'asset');
        n = n.replace(/^.*[\\\/]/, '').replace(/\.aep$/i, '').replace(/[\/\\$%]/g, '_').replace(/[\x00-\x1f\x7f]/g, '').replace(/^\.+$/, '_');
        return n || (fallback || 'asset');
    }

    // 进度事件负载 → AENotice.update 的 opts。message 是宿主中文源文（_emitProgress /
    // _emitProgressObj，经 CSEvent 进面板），显示前过 AEHostErrors 映射：zh 原样、
    // en 变英文。progress 数值与 progressLabel 原样透传。
    // 负载两形：纯字符串（只更新 message）与 JSON 串（{message, progress, progressLabel}）。
    function progressUpdateOpts(data) {
        var opts;
        if (typeof data === 'string' && data.charAt(0) === '{') {
            try { opts = JSON.parse(data); } catch (_) { opts = { message: data }; }
        } else {
            opts = { message: data };
        }
        if (opts && typeof opts.message === 'string') {
            opts.message = (global.AEHostErrors && typeof global.AEHostErrors.localize === 'function')
                ? global.AEHostErrors.localize(opts.message)
                : String(opts.message);
        }
        return opts;
    }
    global.AEAssetsShared.progressUpdateOpts = progressUpdateOpts;

    // opts: { pane, store, dataDir, hostApi }
    function createProjectAssetView(opts) {
        var pane = opts.pane;
        var store = opts.store;
        var hostApi = opts.hostApi;
        var dataDir = opts.dataDir || '';
        var _tv = null;
        var _destroyed = false;
        var _busy = false;
        var _editing = false;  // 备注编辑中
        var _selectGen = 0;   // _onSelect 重入防护：每次选中自增，异步回调比对代龄丢弃过期者

        // 分阶段进度：监听 host 端 exportCompOrLayer 通过 PlugPlug 派发的 CSEvent，
        // 运行时更新当前进度 notice 文本。监听器一次性注册，回调按 _activeProgressNotice 路由。
        // 支持两种数据格式：
        //   1) 纯字符串 → 仅更新 message
        //   2) JSON 字符串（首字符为 '{'）→ 解析为 {message, progress, progressLabel}，透传给 AENotice
        //      progress=null 用于显式清除进度条（PSD 阶段结束后切回纯文本阶段）
        // message 是宿主中文源文，经 progressUpdateOpts 过 AEHostErrors 映射（显示文本）；
        // progress 数值与 progressLabel 原样透传。
        var _progressListenerReady = false;
        var _progressListenerCs = null;
        var _progressListenerHandler = null;
        var _activeProgressNotice = null;
        function _ensureProgressListener() {
            if (_progressListenerReady) return;
            try {
                var cs = new CSInterface();
                var handler = function (e) {
                    if (!_activeProgressNotice || !_activeProgressNotice.id || !e || !e.data) return;
                    var opts = global.AEAssetsShared.progressUpdateOpts(e.data);
                    try { global.AENotice.update(_activeProgressNotice.id, opts); } catch (_) {}
                };
                cs.addEventListener("com.ae.assets.exportProgress", handler);
                // 保存引用供 destroy 时 removeEventListener，避免 view 销毁后监听器泄漏
                _progressListenerCs = cs;
                _progressListenerHandler = handler;
                _progressListenerReady = true;
            } catch (_) { /* CSInterface 不可用时静默退化到固定文本 */ }
        }

        pane.innerHTML = '';
        pane.classList.add('assets-pane');

        // toolbar：保存 + 收集选项 + 刷新
        var tb = document.createElement('div');
        tb.className = 'assets-toolbar';
        var btnExport = _mkBtn(AEI18n.t('保存'), 'primary');
        tb.appendChild(btnExport);
        var collectLabel = document.createElement('label');
        collectLabel.className = 'toggle-wrap';
        collectLabel.title = AEI18n.t('勾选：复制素材到目标目录并重定向引用（自包含）；不勾选：只保存 .aep，素材指向原路径');
        var collectCheckbox = document.createElement('input');
        collectCheckbox.type = 'checkbox';
        collectCheckbox.className = 'switch-input';
        collectCheckbox.checked = false;  // 默认关闭
        var collectSlider = document.createElement('span');
        collectSlider.className = 'switch-slider';
        collectSlider.setAttribute('aria-hidden', 'true');
        collectLabel.appendChild(collectCheckbox);
        collectLabel.appendChild(collectSlider);
        collectLabel.appendChild(document.createTextNode(AEI18n.t('收集素材')));
        tb.appendChild(collectLabel);
        var collectPsdLabel = document.createElement('label');
        collectPsdLabel.className = 'toggle-wrap';
        collectPsdLabel.title = AEI18n.t('勾选：PSD 分图层 footage 先渲染成 PNG 再替换（自包含，丢矢量变位图，较慢）；不勾选：PSD 保留原路径（非自包含）');
        var collectPsdCheckbox = document.createElement('input');
        collectPsdCheckbox.type = 'checkbox';
        collectPsdCheckbox.className = 'switch-input';
        collectPsdCheckbox.checked = false;  // 默认关闭
        var collectPsdSlider = document.createElement('span');
        collectPsdSlider.className = 'switch-slider';
        collectPsdSlider.setAttribute('aria-hidden', 'true');
        collectPsdLabel.appendChild(collectPsdCheckbox);
        collectPsdLabel.appendChild(collectPsdSlider);
        collectPsdLabel.appendChild(document.createTextNode(AEI18n.t('收集PSD')));
        // "收集PSD"仅当"收集素材"开启时才显示；关闭时隐藏
        collectPsdLabel.style.display = collectCheckbox.checked ? '' : 'none';
        collectCheckbox.addEventListener('change', function () {
            collectPsdLabel.style.display = collectCheckbox.checked ? '' : 'none';
        });
        tb.appendChild(collectPsdLabel);
        var btnRefresh = _mkBtn('↻', 'secondary');
        btnRefresh.style.marginLeft = 'auto';
        btnRefresh.title = AEI18n.t('刷新（重新扫描磁盘）');
        tb.appendChild(btnRefresh);
        var btnCleanMissing = _mkBtn(AEI18n.t('清理索引'), 'secondary');
        btnCleanMissing.title = AEI18n.t('清理丢失索引（.aep 文件不存在但索引仍在的条目）');
        btnCleanMissing.addEventListener('click', function () {
            _cleanMissing();
        });
        var btnArchive = _mkBtn(AEI18n.t('归档区'), 'secondary');
        btnArchive.title = AEI18n.t('查看归档区（7 天后自动清理，可恢复/立即清理）');
        btnArchive.addEventListener('click', function () { _openArchivePanel(); });
        tb.appendChild(btnArchive);
        tb.appendChild(btnCleanMissing);
        var btnGarbage = _mkBtn(AEI18n.t('检测垃圾'), 'secondary');
        btnGarbage.title = AEI18n.t('扫描并清理残留文件/目录');
        btnGarbage.addEventListener('click', async function () {
            // _busy 守卫（对齐 _reload/_cleanMissing 惯例）——导出/批量导入进行中点击
            // 检测垃圾，store.load 的标准化清理链（_cleanupEmptyDirs 仅跳过索引内 targetFolder）
            // 会 rmdir 导出已 mkdir 但 .aep 未写完、addMeta 未执行的半成品目录（后续 listGarbage
            // 亦会将其判为垃圾移走）；反向同理，故检测期间亦持 _busy 互斥导入/导出等长任务
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            if (_garbageCheckBusy) return;
            _garbageCheckBusy = true;  // 提前设锁，覆盖整个 load+check 流程
            _busy = true;
            try {
                // 标准化先行：整理磁盘结构后检测垃圾，免去用户手动刷新
                var stdStats = null;
                try {
                    stdStats = await store.load();
                    if (_destroyed) return;
                    _refresh();
                } catch (_) {}
                if (_destroyed) return;
                if (stdStats && global.AEToast) {
                    var parts = [];
                    if (stdStats.imported > 0) parts.push(AEI18n.t('入库 {n} 个', { n: stdStats.imported }));
                    if (stdStats.aligned > 0) parts.push(AEI18n.t('对齐 {n} 个', { n: stdStats.aligned }));
                    if (parts.length) AEToast.success(AEI18n.t('标准化：') + parts.join((typeof AEI18n !== 'undefined' && AEI18n.punct ? AEI18n.punct('，', ', ') : '，')));
                }
                await _checkGarbage(false, true);  // skipLock=true，锁由外层管理
            } finally {
                _garbageCheckBusy = false;
                _busy = false;
            }
        });
        tb.appendChild(btnGarbage);
        pane.appendChild(tb);
        btnExport.addEventListener('click', function (e) {
            global.AEAssetsShared.showAssetsMenu(e.clientX, e.clientY, [
                { label: AEI18n.t('整工程'), action: 'whole' },
                { label: AEI18n.t('合成'), action: 'comp' },
                { label: AEI18n.t('图层'), action: 'layer' }
            ], function (act) {
                if (act === 'whole') _exportWhole();
                else if (act === 'comp') _exportCompOrLayer(false);
                else if (act === 'layer') _exportCompOrLayer(true);
            });
        });
        btnRefresh.addEventListener('click', _reload);
        // 勾选"收集PSD"二次确认：烘焙 PSD 为 PNG 不可逆且耗时，提示用户知悉
        collectPsdCheckbox.addEventListener('change', async function () {
            if (!collectPsdCheckbox.checked) return;
            var ok = await global.showConfirm(
                AEI18n.t('收集PSD'),
                AEI18n.t('勾选后，分图层 PSD 素材会先烘焙成 PNG 再替换引用（自包含，但丢失矢量信息转为位图，且耗时较长）。是否继续？'),
                'confirm'
            );
            if (!ok) collectPsdCheckbox.checked = false;
        });

        var dz = document.createElement('div');
        dz.className = 'assets-dropzone';
        pane.appendChild(dz);

        // 拖拽导入 .aep
        var _dzHandlers = {};
        _dzHandlers.dragover = function (e) {
            var dt = e.dataTransfer;
            if (dt && dt.types && (dt.types.indexOf('application/x-ae-assets') !== -1 || dt.types.indexOf('application/x-ae-folder-move') !== -1)) return;
            e.preventDefault();
            dz.classList.add('dragover');
        };
        _dzHandlers.dragleave = function () {
            dz.classList.remove('dragover');
        };
        _dzHandlers.drop = function (e) {
            e.preventDefault();
            dz.classList.remove('dragover');
            var dt = e.dataTransfer;
            if (dt && dt.types && (dt.types.indexOf('application/x-ae-assets') !== -1 || dt.types.indexOf('application/x-ae-folder-move') !== -1)) return;
            if (!dt || !dt.files || !dt.files.length) return;
            _importAepFiles(dt.files);
        };
        dz.addEventListener('dragover', _dzHandlers.dragover);
        dz.addEventListener('dragleave', _dzHandlers.dragleave);
        dz.addEventListener('drop', _dzHandlers.drop);

        var _fh = global.AEAssetsShared.createFolderViewHelpers({
            store: store,
            refresh: function () { _refresh(); },
            confirmMsg: {
                folderDeleteBody: function (fp) { return AEI18n.t('确定删除文件夹「{path}」？内含素材将被一并删除（含实体文件），不可恢复。', { path: fp }); }
            },
            importFolderToAE: _importFolderToAE,
            renderItemContextmenu: function (item, x, y) {
                var count = _tv.getSelectedCount();
                var menu;
                if (count > 1) {
                    menu = [
                        { label: AEI18n.t('导入AE ({count})', { count: count }), action: 'batchImportAE' },
                        { label: AEI18n.t('归档选中 ({count})', { count: count }), action: 'batchDelete', danger: true }
                    ];
                } else {
                    menu = [
                        { label: AEI18n.t('重命名'), action: 'rename' },
                        { label: AEI18n.t('导入AE'), action: 'importToAE' },
                        { label: AEI18n.t('打开所在位置'), action: 'openLocation' },
                        { label: AEI18n.t('归档'), action: 'delete', danger: true }
                    ];
                }
                global.AEAssetsShared.showAssetsMenu(x, y, menu, function (act) {
                    if (act === 'batchDelete') _batchDelete();
                    else if (act === 'batchImportAE') _batchImportAE();
                    else if (act === 'rename') _tv.beginRename(item.id);
                    else if (act === 'importToAE') _importToAE(item.id).catch(function (e) { if (global.AEToast) AEToast.error(AEI18n.t('导入AE失败: ') + (e.message || e)); });
                    else if (act === 'openLocation') _openLocation(item.id);
                    else if (act === 'delete') _delete(item.id);
                });
            }
        });
        // 解构文件夹管理函数，供 toolbar 按钮 / 右键用
        var _newFolder = _fh._newFolder;
        var _moveFolder = _fh._moveFolder;
        var _renameFolderPrompt = _fh._renameFolderPrompt;
        var _archiveFolderPrompt = _fh._archiveFolderPrompt;
        var _openArchivePanel = _fh._openArchivePanel;
        var _archivedCount = _fh._archivedCount || function () { return 0; };

        var _treeBaseOpts = _fh.folderTreeViewOpts;
        _tv = global.AEAssetsShared.createTreeView({
            container: dz,
            onSelect: function (id) { _onSelect(id); },
            itemLabel: function (it) { return it.name + '.aep'; },
            itemIcon: function (it) { return SOURCE_EMOJI[it.sourceType] || '📄'; },
            // 网格模式缩略图：条目有预览帧才出图，否则返回 null → 网格回落 itemIcon
            itemThumb: function (it) {
                var u = global.AEAssetsShared.previewUrlFor(dataDir, 'project-assets', it._raw || it);
                return u ? { url: u } : null;
            },
            renderDetail: function (it) { return _renderDetail(it); },
            isEditing: function () { return !!_editing || !!(_tv && _tv.isEditing && _tv.isEditing()); },
            nameForEdit: function (it) { return (it._raw || it).name || ''; },
            onRename: function (id, newBaseName) {
                // 条目本身是链接时先显式提示（重命名作用于真实目标、留悬挂链接）；
                // 用户取消 → 什么都不做（静默退出行内编辑，不报错）。whole/bundle 的实体是
                // targetFolder 目录，裸 .aep 件以 aepPath 为准
                var _rit = store.list().filter(function (x) { return x.id === id; })[0];
                var _rp = _rit ? (_rit.targetFolder || _rit.aepPath) : null;
                return _fh._withLinkGuard(_rp ? [{ path: _rp, label: _rit.name }] : [], function () {
                    return store.rename(id, newBaseName).then(function () {
                        _refresh(); _tv.select(id);
                    });
                });
            },
            onRenameFolder: function (folderPath, newName) {
                var fp = String(folderPath || '').replace(/^\/+|\/+$/g, '');
                var slashIdx = fp.lastIndexOf('/');
                var newPath = slashIdx >= 0 ? fp.slice(0, slashIdx + 1) + newName : newName;
                // 文件夹本身是链接时先显式提示（重命名作用于真实目标、留悬挂链接）；
                // 同名（newPath===fp）是无操作，不探测不弹
                var _rfp = (newPath !== fp) ? _fh._folderPhysPath(fp) : null;
                return _fh._withLinkGuard(_rfp ? [{ path: _rfp, label: fp }] : [], function () {
                    return store.renameFolder(fp, newPath).then(function () { _refresh(); });
                });
            },
            onNewItem: function (type, parentPath, name) {
                var fullPath = parentPath ? (parentPath + '/' + name) : name;
                return store.createFolder(fullPath).then(function () { _refresh(); });
            },
            onDragStart: function (item, e) {
                e.dataTransfer.setData('application/x-ae-assets', item.id);
                e.dataTransfer.effectAllowed = 'move';
            },
            onFolderDragStart: _treeBaseOpts.onFolderDragStart,
            onDragOver: _treeBaseOpts.onDragOver,
            onDrop: _treeBaseOpts.onDrop,
            onContextmenu: _treeBaseOpts.onContextmenu,
            extraFolders: _treeBaseOpts.extraFolders,
            onBlankContextmenu: _treeBaseOpts.onBlankContextmenu,
            onDetailAction: _handleDetailAction,
            // 大图标模式双击预览图 = 格子右上角 ↗ 同一个动作（导入AE）。走 _handleDetailAction
            // 而不是另调 _importToAE：act 字面量与 rowActions 同源，日后改动作只改一处。
            onPreviewActivate: function (it) { _handleDetailAction('importAE', it.id); },
            previewActionLabel: AEI18n.t('导入'),
            rowActions: function (it) { return '<span class="assets-row-act" data-act="importAE" data-id="' + _esc(it.id) + '" title="' + _esc(AEI18n.t('导入AE')) + '">↗</span>'; }
        });

        // 把 treeView 的行内编辑方法注入 folderViewMixin（去阻断化）
        if (_fh.setInlineCallbacks) _fh.setInlineCallbacks(_tv.beginNewItem, _tv.beginRenameFolder);
        if (_fh.setTreeView) _fh.setTreeView(_tv);

        // 事件委托：备注 textarea focus/blur
        pane.addEventListener('focusin', function (e) {
            if (e.target && e.target.classList.contains('assets-proj-notes')) _editing = true;
        });
        pane.addEventListener('focusout', function (e) {
            if (!e.target || !e.target.classList.contains('assets-proj-notes')) return;
            _editing = false;
            var id = e.target.getAttribute('data-id');
            if (id) _saveNotes(id);
        });
        // 事件委托：详情面板操作按钮
        function _handleDetailAction(act, id) {
            if (act === 'importAE') _importToAE(id).catch(function (e) { if (global.AEToast) AEToast.error(AEI18n.t('导入AE失败: ') + (e.message || e)); });
            else if (act === 'delete') _delete(id);
            else if (act === 'regenPreview') _regenPreview(id);
        }

        // 手工重生成预览：抓 AE 当前画面（captureCurrentFrame 走工具注册表）→ 缩图 →
        // store.regeneratePreview（落盘成功才写索引）。与 presetView 同形。
        function _regenPreview(id) {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            var SH = global.AEAssetsShared;
            if (!SH || typeof SH.captureCurrentFrame !== 'function') return;
            _busy = true;
            SH.captureCurrentFrame().then(function (frame) {
                if (!frame) throw new Error(AEI18n.t('无法从 AE 取到当前画面（AE 未运行或没有打开的合成）'));
                return SH.preparePreviewFrame(frame).then(function (prepared) {
                    if (!prepared) throw new Error(AEI18n.t('预览缩图失败'));
                    return store.regeneratePreview(id, prepared);
                });
            }).then(function (pf) {
                _busy = false;
                _refresh();
                if (global.AEToast) AEToast.success(AEI18n.t('预览已更新（取自 ') + _fmtSec(pf.time) + 's' + AEI18n.punct('）', ')'));
            }).catch(function (e) {
                _busy = false;
                if (global.AEToast) AEToast.error(AEI18n.t('预览截取失败: ') + (e && e.message ? e.message : e));
            });
        }

        function _mkBtn(text, type) {
            var b = document.createElement('button');
            b.className = 'btn btn-slice ' + (type || 'secondary');
            b.textContent = text;
            return b;
        }

        // ── hostApi.call 包装：大超时（大工程 app.open 需 15-30s）──
        // 宿主消息本地化：host/api/*.jsx 的 throw/status.message 是中文源文，
        // 上屏前经 AEHostErrors 映射成词典 key（未命中原样返回，见 shared/i18n/hostErrors.js）。
        function _hostMsg(v) {
            return (global.AEHostErrors && typeof global.AEHostErrors.localize === 'function')
                ? global.AEHostErrors.localize(v)
                : String(v == null ? '' : v);
        }

        function _call(script, timeoutMs) {
            if (!hostApi) return Promise.reject(new Error(AEI18n.t('ExtendScript 桥未就绪')));
            return hostApi.call(script, timeoutMs || 60000).then(function (resp) {
                if (!resp || resp.ok === false) throw new Error(AEI18n.t('ExtendScript 调用失败: ') + (resp && resp.error ? _hostMsg(resp.error) : ''));
                var r = resp.result;
                if (typeof r === 'string') {
                    if (!r) throw new Error(AEI18n.t('ExtendScript 返回空（脚本未执行或 JSON polyfill 缺失）'));
                    if (/^(ERROR|Error):/.test(r)) throw new Error(r);
                    if (r === 'EvalScript error.') throw new Error(AEI18n.t('ExtendScript 执行异常'));
                    try { r = JSON.parse(r); }
                    catch (_) { throw new Error(AEI18n.t('ExtendScript 返回非 JSON: ') + r.substring(0, 200)); }
                }
                if (r && r.status === 'error') {
                    var err = new Error(_hostMsg(r.message) || AEI18n.t('AE 错误'));
                    err.detail = r;   // 保留 tempPath 等，供 catch 走 AEFS 清理临时文件
                    throw err;
                }
                return r;
            });
        }

        // 裸 evalScript 包装：返回原始字符串，不做 JSON 解析/严格校验。
        // 仅供返回非 JSON 的 ad-hoc 脚本用（app.project.save() 返 "true"/""、_fileSize 返数字串）。
        // JSON 类 API 函数必须走 _call（严格，防假成功）。
        function _callRaw(script, timeoutMs) {
            if (!hostApi) return Promise.reject(new Error(AEI18n.t('ExtendScript 桥未就绪')));
            return hostApi.call(script, timeoutMs || 60000).then(function (resp) {
                if (!resp || resp.ok === false) throw new Error(AEI18n.t('ExtendScript 调用失败: ') + (resp && resp.error ? _hostMsg(resp.error) : ''));
                return resp.result;
            });
        }

        // ── 取当前工程状态 ──
        async function _ensureProjectReady() {
            var state = await _call('getProjectState({})');
            if (!state.hasFile) {
                if (global.AEToast) AEToast.error(AEI18n.t('当前工程从未保存，无法保存（请先 文件>保存）'));
                return null;
            }
            return state;
        }

        async function _handleUnsavedChanges(state) {
            // ES 侧 exportCompOrLayer 会先 app.project.save() 再切走，此处只做一次确认
            var ok = await global.showConfirm(
                AEI18n.t('保存合成/图层'),
                AEI18n.t('将保存当前工程并临时切走（完成后自动恢复）。是否继续？'),
                'confirm'
            );
            return ok;
        }

        // ── 同名检测：目标目录已存在且含 .aep → 弹确认框 ──
        async function _checkOverwrite(targetFolder, name) {
            var exists = await global.AEFS.exists(targetFolder);
            if (exists !== true) return true;  // 不存在，直接放行
            // 检查目录内是否有 .aep（避免空目录误报）
            try {
                var files = await global.AEFS.listFiles(targetFolder);
                var hasAep = files.some(function (f) { return /\.aep$/i.test(f); });
                if (!hasAep) {
                    // 目录存在但无 .aep（可能是空虚拟文件夹对应目录）→ 不弹窗，但也不阻止
                    // 让 mkdir 静默成功，后续 export 正常写入
                    return true;
                }
            } catch (_) {}
            return global.showConfirm(AEI18n.t('覆盖确认'), AEI18n.t('素材「') + name + AEI18n.t('」已存在，是否覆盖？'), 'confirm');
        }

        // ── file.path 不可用时的 fallback：FileReader → writeBlob ──
        async function _copyViaBlob(file, dstPath) {
            try {
                var buf = await new Promise(function (resolve, reject) {
                    var reader = new FileReader();
                    reader.onload = function () { resolve(reader.result); };
                    reader.onerror = function () { reject(reader.error); };
                    reader.readAsArrayBuffer(file);
                });
                return await global.AEFS.writeBlob(dstPath, new Blob([buf], { type: file.type || 'application/octet-stream' }));
            } catch (_) {
                return false;
            }
        }

        // ── 本地目录扫描（目标已在 dataDir 下，速度快）──
        // 找一个不冲突的目标目录名（同名加 _1 _2...）
        async function _ensureUniqueTargetDir(baseName) {
            var candidate = _buildPath(dataDir, 'assets', 'project-assets', baseName);
            var idx = 0;
            while (idx < 1000) {
                var exists = await global.AEFS.exists(candidate);
                if (!exists) return candidate;
                idx++;
                candidate = _buildPath(dataDir, 'assets', 'project-assets', baseName + '_' + idx);
            }
            console.warn('[Assets] _ensureUniqueTargetDir 超过 1000 次冲突，放弃: ' + baseName);
            return null;
        }

        // ── 导入外部 .aep 文件 ──
        async function _importAepFiles(files) {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            var cancelled = false;
            var notice = (files.length > NOTICE_THRESHOLD) && global.AENotice ? global.AENotice.show({
                id: 'assets-proj-import',
                title: AEI18n.t('导入工程素材'),
                message: AEI18n.t('正在检测…'),
                tone: 'info',
                dismissible: false,
                progress: 0,
                actions: [
                    { label: AEI18n.t('取消'), type: 'secondary', onClick: function () { cancelled = true; }, keepOpen: false }
                ],
                onClose: function (result) {
                    if (result && result.action === AEI18n.t('取消')) cancelled = true;
                }
            }) : null;
            // 强制让出主线程一次，浏览器先重绘出 notice，再进入后续扫描。
            // （AEFS 的 isFile 等为“同步 XHR + Promise.resolve”假异步，await 不产生 macrotask，
            //   若不主动让出，notice 会被后续假异步占满主线程而迟迟不显示）
            await new Promise(function (r) { setTimeout(r, 0); });

            try {
                // 分类：.aep 文件 vs 文件夹 vs 被忽略的非 .aep 文件
                // listFiles/listDirs 对文件路径均返回 []（空数组），无法区分空目录——空目录也没工程，统一当忽略。
                // listFiles 只返回文件不返回子目录：「只含子目录（内含工程包）」的目录须再查 listDirs，
                // 有文件或有子目录都算文件夹，否则被误判为非工程文件跳过
                var aepFiles = [], dirFiles = [];
                var skipped = 0;
                for (var i = 0; i < files.length; i++) {
                    var f = files[i];
                    if (/\.aep$/i.test(f.name)) {
                        aepFiles.push(f);
                    } else if (f.path) {
                        try {
                            var testFiles = await global.AEFS.listFilesAsync(f.path);
                            var testDirs = [];
                            if (!Array.isArray(testFiles) || testFiles.length === 0) {
                                testDirs = await global.AEFS.listDirsAsync(f.path);
                            }
                            if ((Array.isArray(testFiles) && testFiles.length > 0) || (Array.isArray(testDirs) && testDirs.length > 0)) dirFiles.push(f);
                            else skipped++;
                        } catch (_) { skipped++; }
                    } else {
                        skipped++;
                    }
                }

                // .aep + 文件夹混拖 → 拒绝
                if (aepFiles.length > 0 && dirFiles.length > 0) {
                    if (global.AEToast) AEToast.warn(AEI18n.t('不能同时拖入工程文件和文件夹'));
                    return;
                }

                if (aepFiles.length > 0) {
                    // 批量导入确认：文件数超阈值先征询，避免误拖几千个
                    if (aepFiles.length > IMPORT_WARN_COUNT) {
                        var goAep = await global.showConfirm(AEI18n.t('批量导入确认'), AEI18n.t('即将导入 ') + aepFiles.length + AEI18n.t(' 个工程文件，可能需要较长时间，是否继续？'), 'confirm');
                        if (!goAep) return;
                    }
                    // ── .aep 文件模式：每个 mkdir + copyFile，索引收集后一次批量落盘 ──
                    var total = aepFiles.length;
                    var okCount = 0, failCount = 0;
                    var pendingMetas = [];   // 已拷贝成功、待批量写入索引的条目
                    for (var fi = 0; fi < aepFiles.length; fi++) {
                        if (cancelled) break;
                        var file = aepFiles[fi];
                        var bname = global.AEAssetsShared.assetBaseName(file.name);
                        var nameBad = global.AEAssetsShared.invalidNameSeg(bname);
                        if (nameBad) { failCount++; if (global.AEToast) AEToast.warn(nameBad + ': ' + file.name); continue; }
                        var targetFolder = await _ensureUniqueTargetDir(bname);
                        if (!targetFolder) { failCount++; continue; }
                        var mkOk = await global.AEFS.mkdir(targetFolder);
                        if (mkOk !== true) { failCount++; continue; }
                        var dstPath = targetFolder + '/' + file.name;
                        var cpOk = file.path ? await global.AEFS.copyFileAsync(file.path, dstPath) : await _copyViaBlob(file, dstPath);
                        if (!cpOk) { failCount++; continue; }
                        pendingMetas.push({
                            name: bname, folder: '', aepPath: dstPath, targetFolder: targetFolder,
                            sourceType: 'import', sourceName: SOURCE_NAME_PROJECT,
                            originalProject: '', size: file.size || 0
                        });
                        var done = fi + 1;
                        if (notice && global.AENotice) {
                            global.AENotice.update('assets-proj-import', {
                                message: AEI18n.t('正在导入… {done}/{total}', { done: done, total: total }),
                                progress: Math.round(done / total * 100),
                                progressLabel: done + '/' + total
                            });
                        }
                        await new Promise(function (r) { setTimeout(r, 5); });
                    }
                    // 批量落盘：一次 flush 替代逐条 addMeta 的 N 次全量重写
                    if (pendingMetas.length) {
                        try {
                            await store.addMetaBatch(pendingMetas);
                            okCount = pendingMetas.length;
                        } catch (e) {
                            console.warn('[Assets] 批量写索引失败: ' + (e && e.message ? e.message : e));
                            failCount += pendingMetas.length;
                        }
                    }
                    _refresh();
                    if (cancelled) {
                        if (global.AEToast) AEToast.info(AEI18n.t('已取消（已导入 ') + okCount + AEI18n.t(' 个）'));
                    } else if (okCount > 0) {
                        var msg = AEI18n.t('已导入 {n} 个工程', { n: okCount });
                        if (skipped > 0) msg += AEI18n.t('，跳过 {n} 个非工程文件', { n: skipped });
                        if (global.AEToast) AEToast.success(msg);
                    } else if (failCount > 0) {
                        if (global.AEToast) AEToast.warn(AEI18n.t('导入失败: ') + failCount + '/' + total);
                    }
                    return;
                }

                // ── 文件夹模式：walkDir 递归找合法工程 ──
                var projects = [];
                var invalidDirs = [];
                var scannedDirs = 0;
                // 文件夹模式：files.length 恒为 1，无法在顶部按数量判断；
                // 扫描本身可能是最耗时的阶段，先展示进度，扫描后再按实际数量决定是否关闭。
                if (notice == null && global.AENotice) {
                    notice = global.AENotice.show({
                        id: 'assets-proj-import',
                        title: AEI18n.t('导入工程素材'),
                        message: AEI18n.t('正在扫描…'),
                        tone: 'info',
                        dismissible: false,
                        progress: 0,
                        actions: [
                            { label: AEI18n.t('取消'), type: 'secondary', onClick: function () { cancelled = true; }, keepOpen: false }
                        ],
                        onClose: function (result) {
                            if (result && result.action === AEI18n.t('取消')) cancelled = true;
                        }
                    });
                }
                if (notice && global.AENotice) global.AENotice.update('assets-proj-import', { message: AEI18n.t('正在扫描…') });
                for (var di = 0; di < dirFiles.length; di++) {
                    var srcDir = String(dirFiles[di].path || '').replace(/\\/g, '/');
                    await global.AEAssetsShared.walkDir(global.AEFS, srcDir, {
                        onProject: async function (dirPath, project) {
                            projects.push({ dirPath: dirPath, name: project.name, hasAssets: project.hasAssets, assetDir: project.assetDir });
                        },
                        onInvalid: async function (dirPath, reason) {
                            invalidDirs.push({ dirPath: dirPath, reason: reason });
                        },
                        onProgress: function () {
                            scannedDirs++;
                            if (notice && global.AENotice) {
                                global.AENotice.update('assets-proj-import', { message: AEI18n.t('正在扫描… 已检查 {n} 个目录', { n: scannedDirs }) });
                            }
                        },
                        // 扫描阶段取消：walkDir 每层入口检查，中止后续目录遍历
                        isCancelled: function () { return cancelled; }
                    });
                }

                // 扫描阶段已取消：提前收尾（外层 finally 复位 _busy / notice），不再弹确认/导入
                if (cancelled) {
                    if (global.AEToast) AEToast.info(AEI18n.t('已取消'));
                    return;
                }

                if (projects.length === 0) {
                    if (global.AEToast) AEToast.warn(invalidDirs.length ? AEI18n.t('文件夹结构无效：') + invalidDirs[0].reason : AEI18n.t('未找到任何 .aep 工程文件'));
                    return;
                }
                // 扫描完成后：实际工程数未超阈值则静默（关闭扫描进度条）
                if (projects.length <= NOTICE_THRESHOLD && notice) {
                    notice.close();
                    notice = null;
                }

                // 批量导入确认：工程数超阈值先征询
                if (projects.length > IMPORT_WARN_COUNT) {
                    var goProjects = await global.showConfirm(AEI18n.t('批量导入确认'), AEI18n.t('即将导入 ') + projects.length + AEI18n.t(' 个工程，可能需要较长时间，是否继续？'), 'confirm');
                    if (!goProjects) return;
                }

                await new Promise(function (r) { setTimeout(r, 30); });

                var totalP = projects.length;
                var okCount2 = 0, failCount2 = 0;
                var pendingMetas2 = [];   // 已拷贝成功、待批量写入索引的条目（同 .aep 文件模式的 pendingMetas）
                if (notice && global.AENotice) {
                    global.AENotice.update('assets-proj-import', {
                        message: AEI18n.t('正在导入… {done}/{total}', { done: 0, total: totalP }),
                        progress: 0,
                        progressLabel: '0/' + totalP
                    });
                }
                for (var pi = 0; pi < projects.length; pi++) {
                    if (cancelled) break;
                    var p = projects[pi];
                    var bname2 = global.AEAssetsShared.assetBaseName(p.name);
                    var nameBad2 = global.AEAssetsShared.invalidNameSeg(bname2);
                    if (nameBad2) { failCount2++; continue; }
                    var targetDir2 = await _ensureUniqueTargetDir(bname2);
                    if (!targetDir2) { failCount2++; continue; }
                    var mkOk2 = await global.AEFS.mkdir(targetDir2);
                    if (mkOk2 !== true) { failCount2++; continue; }
                    // 先拷 .aep
                    var copyOk2 = await global.AEFS.copyFileAsync(p.dirPath + '/' + p.name, targetDir2 + '/' + p.name);
                    // 工程包：再拷资产子目录（不拷根级非 .aep）
                    if (copyOk2 && p.hasAssets && p.assetDir) {
                        copyOk2 = await global.AEFS.copyDirAsync(p.dirPath + '/' + p.assetDir, targetDir2 + '/' + p.assetDir);
                    }
                    if (!copyOk2) { failCount2++; continue; }
                    // 收集 meta，循环后一次批量落盘（替代逐条 addMeta 的 N 次全量重写）
                    pendingMetas2.push({
                        name: bname2, folder: '', aepPath: targetDir2 + '/' + p.name,
                        targetFolder: targetDir2,
                        sourceType: p.hasAssets ? 'bundle' : 'import',
                        sourceName: p.hasAssets ? SOURCE_NAME_BUNDLE : SOURCE_NAME_PROJECT,
                        originalProject: '', size: 0
                    });
                    var done2 = pi + 1;
                    if (notice && global.AENotice) {
                        global.AENotice.update('assets-proj-import', {
                            message: AEI18n.t('正在导入… {done}/{total}', { done: done2, total: totalP }),
                            progress: Math.round(done2 / totalP * 100),
                            progressLabel: done2 + '/' + totalP
                        });
                    }
                    await new Promise(function (r) { setTimeout(r, 5); });
                }
                // 批量落盘：一次 flush 替代逐条 addMeta 的 N 次全量重写（同 .aep 文件模式）
                if (pendingMetas2.length) {
                    try {
                        await store.addMetaBatch(pendingMetas2);
                        okCount2 = pendingMetas2.length;
                    } catch (e) {
                        console.warn('[Assets] 批量写索引失败: ' + (e && e.message ? e.message : e));
                        failCount2 += pendingMetas2.length;
                    }
                }

                _refresh();
                if (cancelled) {
                    if (global.AEToast) AEToast.info(AEI18n.t('已取消（已导入 ') + okCount2 + AEI18n.t(' 个）'));
                } else if (okCount2 > 0) {
                    var msg2 = AEI18n.t('已导入 {n} 个工程素材', { n: okCount2 });
                    if (invalidDirs.length) msg2 += AEI18n.t('，跳过 {n} 个非法目录', { n: invalidDirs.length });
                    if (skipped > 0) msg2 += AEI18n.t('，跳过 {n} 个非工程文件', { n: skipped });
                    if (global.AEToast) AEToast.success(msg2);
                } else if (failCount2 > 0) {
                    if (global.AEToast) AEToast.warn(AEI18n.t('导入失败: ') + failCount2 + '/' + totalP);
                }
            } finally {
                _busy = false;
                if (notice) notice.close();
                notice = null;
            }
        }

        // ── 整工程导出 ──
        // 预览帧：抓当前合成一帧并缩成小图（captureCurrentFrame → preparePreviewFrame 两步）。
        // 任一步失败返回 null——预览是附加物，抓不到不影响保存。
        // 调用时机：必须在任何会切走「当前合成」的动作（exportWholeProject / exportCompOrLayer
        // 都会 app.open 副本工程或 reduceProject）**之前**。
        async function _capturePreviewSource() {
            try {
                var pvNotice = global.AENotice ? global.AENotice.show({
                    id: 'assets-proj-preview',
                    title: AEI18n.t('生成预览'),
                    message: AEI18n.t('正在截取当前合成画面…'),
                    tone: 'info',
                    dismissible: false
                }) : null;
                try {
                    var frame = await global.AEAssetsShared.captureCurrentFrame();
                    return frame ? await global.AEAssetsShared.preparePreviewFrame(frame) : null;
                } finally {
                    if (pvNotice) pvNotice.close();
                }
            } catch (e) {
                console.warn('[Assets] 工程素材预览抓帧失败: ' + (e && e.message ? e.message : e));
                return null;
            }
        }

        async function _exportWhole() {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            try {
            var state = await _ensureProjectReady();
            if (!state) return;
            var autoName = _autoName(state.projectPath, 'project');
            var name = await global.showPrompt(AEI18n.t('保存名称（文件夹名）'), autoName);
            if (!name) return;
            var nameBad = global.AEAssetsShared.invalidNameSeg(name);
            if (nameBad) { if (global.AEToast) AEToast.warn(nameBad); return; }
            var targetFolder = _buildPath(dataDir, 'assets', 'project-assets', name);
            var overwriteOk = await _checkOverwrite(targetFolder, name);
            if (!overwriteOk) return;
            // 先由面板 AEFS 建目录并校验路径（过 _checkPath），拦掉 % / 控制字符 / 引号等 jsx Folder.create 会放过、
            // 但后续 AEFS.writeFile(meta) 会拒的非法路径——防 .aep 已落盘、meta 写不进造成的不可删孤儿。
            var dirOk = await global.AEFS.mkdir(targetFolder);
            if (dirOk !== true) {
                if (global.AEToast) AEToast.error(AEI18n.t('无法创建目标目录（路径非法或 Bridge 异常）: ') + targetFolder.replace(/\\/g, '/'));
                return;
            }
            // 临时副本目录（数据目录 temp，非系统 Temp）：工程数据不写系统 Temp，AEFS 可删
            var tempDir = _buildPath(dataDir, 'temp');
            var tempDirOk = await global.AEFS.mkdir(tempDir);
            if (tempDirOk !== true) { if (global.AEToast) AEToast.error(AEI18n.t('无法创建临时目录: ') + tempDir.replace(/\\/g, '/')); return; }
            var collectAssets = collectCheckbox.checked;
            var collectPsD = collectPsdCheckbox.checked;
            // 预览帧：必须在 exportWholeProject **之前**抓——collectAssets 时 jsx 会 app.open
            // 临时副本工程再切回，之后的「当前合成」已不是用户原本那个。抓帧失败不阻断保存
            // （previewSource 保持 null，条目照常入库、无 previewFrame）。
            // 放在进度卡片**之前**：抓帧期间导出尚未开始，先弹「正在保存整工程…」会让用户
            // 以为已在导出（实测两张卡片会同时挂着）。
            var previewSource = await _capturePreviewSource();
            var notice = _showProgress(AEI18n.t('正在保存整工程…'));
            _ensureProgressListener();
            _activeProgressNotice = notice;
            var aepPath = null;
            try {
                var r = await _call('exportWholeProject({targetFolder:"' + _escPath(targetFolder) + '",projectName:"' + _escPath(name) + '",collectAssets:' + (collectAssets ? 'true' : 'false') + ',collectPsD:' + (collectPsD ? 'true' : 'false') + ',tempDir:"' + _escPath(tempDir) + '",dataRoot:"' + _escPath(dataDir) + '"})', (collectAssets && collectPsD) ? 1800000 : (collectAssets ? 300000 : 180000));
                aepPath = (r && r.aepPath) ? r.aepPath : null;
                if (!aepPath) throw new Error(AEI18n.t('保存 .aep 失败'));
                // collectAssets=true 时 jsx 切到了副本工程，需切回原工程 + 删 temp
                if (collectAssets) {
                    try {
                        await _call('restoreProject({originalPath:"' + _escPath(state.projectPath) + '"})', 60000);
                    } catch (restoreErr) {
                        var rMsg = (restoreErr && restoreErr.message) || '';
                        if (rMsg.indexOf('跳过自动回切') >= 0) {
                            if (global.AEToast) AEToast.warn(AEI18n.t('保存仍在后台进行，已跳过自动回切。请在完成后手动打开: ') + state.projectPath);
                        } else {
                            if (global.AEToast) AEToast.error(AEI18n.t('回切失败！请手动打开: ') + state.projectPath);
                        }
                    }
                    var tempPath = r && r.tempPath ? r.tempPath : '';
                    if (tempPath) { try { await global.AEFS.deleteFile(tempPath); } catch (_) {} }
                }
                // 未保存工程的 Save-As 临时副本（ES 侧不再裸 File.remove，路径经 tempSavePath 回传）。
                // 删失败不阻断——残留由 init 的 _cleanTempResidual（AEFS 删 temp 下 _export_*.aep）兜底
                var tempSavePath = r && r.tempSavePath ? r.tempSavePath : '';
                if (tempSavePath) { try { await global.AEFS.deleteFile(tempSavePath); } catch (_) {} }
                if (r && r.unredirected && r.unredirected.length) {
                    var unredMsg = AEI18n.t('以下分图层素材（PSD/AI）保留原路径未重定向，避免图层合并：') + r.unredirected.join(AEI18n.punct('、', ', '));
                    if (global.AEToast) AEToast.warn(unredMsg, { autoHideMs: 8000 });
                }
                // 消费侧：分图层 PSD/AI 兜底副本复制失败（导出包与 footage 目录缺这些
                // 文件，异地无法手动重链）——与 unredirected 提示并列不互相覆盖；旧回执/catch
                // 回执无该字段时容忍（守卫短路，不报错）
                if (r && r.copyFailed && r.copyFailed.length) {
                    if (global.AEToast) AEToast.warn(AEI18n.t('分图层素材兜底副本复制失败（导出包与 footage 目录缺这些文件，异地无法手动重链）：') + r.copyFailed.join((typeof AEI18n !== 'undefined' && AEI18n.punct ? AEI18n.punct('、', ', ', '、') : '、')), { autoHideMs: 8000 });
                }
            } catch (e) {
                if (collectAssets) {
                    try { await _call('restoreProject({originalPath:"' + _escPath(state.projectPath) + '"})', 60000); } catch (_) {}
                    var errTemp = e && e.detail && e.detail.tempPath ? e.detail.tempPath : '';
                    if (errTemp) { try { await global.AEFS.deleteFile(errTemp); } catch (_) {} }
                }
                // 失败路径同样清 Save-As 临时副本（ES 侧已不再自删）
                var errTempSave = e && e.detail && e.detail.tempSavePath ? e.detail.tempSavePath : '';
                if (errTempSave) { try { await global.AEFS.deleteFile(errTempSave); } catch (_) {} }
                if (global.AEToast) AEToast.error(AEI18n.t('保存失败: ') + (e.message || e));
                return;
            } finally {
                _activeProgressNotice = null;
                if (notice) notice.close();
            }
            // 导出本体已成功；元数据写入失败不应报"导出失败"（与 _exportCompOrLayer 一致），文件已在目标目录
            try {
                var realSize = await _fileSize(aepPath);
                await store.addMeta({
                    name: name, folder: '', aepPath: aepPath, targetFolder: targetFolder,
                    sourceType: 'whole', sourceName: '', originalProject: state.projectPath,
                    size: realSize,
                    // 预览帧（面板侧已缩好的小图，按条目 id 落盘；null = 抓帧失败/无合成）
                    previewSource: previewSource
                });
                _refresh();
                if (global.AEToast) AEToast.success(AEI18n.t('整工程已保存: ') + name);
            } catch (metaErr) {
                console.warn('[Assets] 整工程保存成功但索引失败:', metaErr);
                _refresh();
                if (global.AEToast) AEToast.warn(AEI18n.t('保存成功但索引更新失败，文件已在目标目录'));
            }
            } catch (e) {
                if (global.AEToast) AEToast.error(AEI18n.t('保存失败: ') + (e.message || e));
            } finally {
                _busy = false;
            }
        }

        // ── 合成/图层导出 ──
        async function _exportCompOrLayer(isLayer) {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            // 固定超时：打包速度主要看 reduceProject 的图层数（大图层工程会卡），不是素材大小
            // collectPsD 时 PSD 分图层逐个 saveFrameToPng 转 PNG，慢，放大超时
            var exportTimeout = collectPsdCheckbox.checked ? 1800000 : 300000;  // 30 分钟 / 5 分钟
            var restoreTimeout = 60000;   // 1 分钟
            try {
            var state = await _ensureProjectReady();
            if (!state) return;

            // 选中校验前置——先确认有可保存的合成（图层模式还要有选中图层），再问
            // 「元素数量」与「临时切走」。旧顺序在选中非法时也先弹这两次确认，用户白点一遍
            // 才被告知"没选中图层"。
            var compResp = await _call('assets_getActiveComp({})');
            var compName = compResp && compResp.compName ? compResp.compName : null;
            if (!compName) {
                if (global.AEToast) AEToast.warn(compResp && compResp.message ? compResp.message : AEI18n.t('未找到合成'));
                return;
            }
            // 合成 id（稳定键）——工程里同名合成并存时，host 按名查找会静默取到前一个
            // （保存合成路径没有图层 id 兜底，导出件会整个错）。0 = 旧 host/旧 AE 未回传。
            var compId = compResp && compResp.compId ? Number(compResp.compId) : 0;
            if (!(compId > 0)) compId = 0;
            var selLayers = compResp && compResp.selectedLayers ? compResp.selectedLayers : [];
            if (isLayer && !selLayers.length) {
                if (global.AEToast) AEToast.warn(AEI18n.t('请在时间轴中选中要保存的图层'));
                return;
            }

            // 大工程警告：项目面板元素多时 reduceProject 会卡（和素材大小无关，看元素数）
            if (state.numItems && state.numItems > ITEMS_WARN) {
                var cont = await global.showConfirm(AEI18n.t('元素数量警告'), AEI18n.t('工程含 ') + state.numItems + AEI18n.t(' 个项目元素，保存（精简工程）可能耗时较长，是否继续？'), 'confirm');
                if (!cont) return;
            }
            var ready = await _handleUnsavedChanges(state);
            if (!ready) return;

            var layerNames = '';
            var layerIndices = [];
            var layerIds = [];
            if (isLayer) {
                // 图层名协议：JSON.stringify(数组)——AE 图层名（PSD/AI 导入）可含逗号，逗号 join 必坏；
                // ES 侧 JSON.parse 优先 + 逗号 split 兜底（旧面板）。_escPath 转义 \ 和 " 保证 JSON 串安全往返
                layerNames = JSON.stringify(selLayers);
                // 首选图层 id（稳定键）——index 是层叠位置，而本函数从读取选中到 host 在副本工程里
                // 执行之间隔着 save/open（大工程数秒）与确认框，期间用户删/加/重排图层就会让位置键错位
                // （导出错层，且不越界时 fail-closed 抓不到）。id 跨保存/重载不变，host 端按 id 重新解析。
                var selIds = compResp && compResp.selectedLayerIds ? compResp.selectedLayerIds : [];
                var cleanIds = [];
                for (var si2 = 0; si2 < selIds.length; si2++) {
                    var lid = Number(selIds[si2]);
                    if (lid > 0 && Math.floor(lid) === lid) cleanIds.push(lid);
                }
                if (cleanIds.length === selLayers.length) layerIds = cleanIds;
                // 索引为次选（旧 AE 无 Layer.id 时走这条）——按名解析无法区分同名图层
                // （真机实测：选中 1 个「技能」，3 个同名层全被预合成带走）。索引为纯数字，内联进
                // 脚本无转义面；与名字长度不一致（旧 host 未回传 selectedLayerIndices）则退回名字路径。
                var selIdx = compResp && compResp.selectedLayerIndices ? compResp.selectedLayerIndices : [];
                var cleanIdx = [];
                for (var si = 0; si < selIdx.length; si++) {
                    var iv = Number(selIdx[si]);
                    if (iv > 0 && Math.floor(iv) === iv) cleanIdx.push(iv);
                }
                if (cleanIdx.length === selLayers.length) layerIndices = cleanIdx;
            }

            // 直接用合成名命名，不弹 prompt（合成/图层都用合成名）。
            // _autoName sanitize 路径分隔符/控制字符，再补 Windows 非法字符
            var name = _autoName(compName, 'asset').replace(/[:*?"'<>|]/g, '_');
            var nameBad = global.AEAssetsShared.invalidNameSeg(name);
            if (nameBad) { if (global.AEToast) AEToast.warn(nameBad); return; }
            var targetFolder = _buildPath(dataDir, 'assets', 'project-assets', name);
            var overwriteOk = await _checkOverwrite(targetFolder, name);
            if (!overwriteOk) return;
            var tempName = '_export_' + Date.now() + '.aep';
            // 面板侧 AEFS 建目录 + 路径校验（同 _exportWhole），jsx Folder.create 退为防御性兜底。
            var dirOk = await global.AEFS.mkdir(targetFolder);
            if (dirOk !== true) {
                if (global.AEToast) AEToast.error(AEI18n.t('无法创建目标目录（路径非法或 Bridge 异常）: ') + targetFolder.replace(/\\/g, '/'));
                return;
            }
            // 临时副本目录（数据目录 temp，非系统 Temp）：工程数据不写系统 Temp，AEFS 可删
            var tempDir = _buildPath(dataDir, 'temp');
            var tempDirOk = await global.AEFS.mkdir(tempDir);
            if (tempDirOk !== true) { if (global.AEToast) AEToast.error(AEI18n.t('无法创建临时目录: ') + tempDir.replace(/\\/g, '/')); return; }

            var collectAssets = collectCheckbox.checked;
            var collectPsD = collectPsdCheckbox.checked;
            // 预览帧：必须在 exportCompOrLayer **之前**抓——host 侧走 reduceProject 且会切到
            // 副本工程，之后的「当前合成」已不是用户原本那个。失败不阻断保存。
            // 放在进度卡片**之前**：抓帧期间导出尚未开始（先弹「正在保存…」会误导）。
            var previewSource = await _capturePreviewSource();
            var notice = _showProgress(isLayer ? AEI18n.t('正在保存图层…') : AEI18n.t('正在保存合成…'));
            _ensureProgressListener();
            _activeProgressNotice = notice;
            try {
                var r = await _call(
                    'exportCompOrLayer({compName:"' + _escPath(compName) + '",compId:' + compId + ',outName:"' + _escPath(name) + '",layerNames:"' + (isLayer ? _escPath(layerNames) : '') + '",layerIds:[' + layerIds.join(',') + '],layerIndices:[' + layerIndices.join(',') + '],targetFolder:"' + _escPath(targetFolder) + '",tempName:"' + _escPath(tempName) + '",collectAssets:' + (collectAssets ? 'true' : 'false') + ',collectPsD:' + (collectPsD ? 'true' : 'false') + ',tempDir:"' + _escPath(tempDir) + '",dataRoot:"' + _escPath(dataDir) + '"})',
                    exportTimeout
                );
                // 回切原工程
                try {
                    await _call('restoreProject({originalPath:"' + _escPath(state.projectPath) + '"})', restoreTimeout);
                } catch (restoreErr) {
                    var rMsg = (restoreErr && restoreErr.message) || '';
                    if (rMsg.indexOf('跳过自动回切') >= 0) {
                        // exportCompOrLayer 仍在后台跑，restoreProject 被 $_exporting 守卫拒绝——非致命
                        if (global.AEToast) AEToast.warn(AEI18n.t('保存仍在后台进行，已跳过自动回切。请在完成后手动打开: ') + state.projectPath);
                    } else {
                        if (global.AEToast) AEToast.error(AEI18n.t('回切失败！请手动打开: ') + state.projectPath);
                    }
                }
                // 删临时副本（tempPath 由 ES 侧在数据目录 temp 下生成，从返回拿）
                var tempPath = r && r.tempPath ? r.tempPath : '';
                if (tempPath) { try { await global.AEFS.deleteFile(tempPath); } catch (_) {} }

                // 导出本体已成功；元数据写入失败不应报"导出失败"
                try {
                    await store.addMeta({
                        name: name, folder: '', aepPath: r && r.aepPath ? r.aepPath : '',
                        targetFolder: targetFolder,
                        sourceType: isLayer ? 'layer' : 'comp',
                        sourceName: isLayer ? (compName + ' / ' + selLayers.join(' / ')) : compName,
                        originalProject: state.projectPath,
                        size: r && r.aepSize ? r.aepSize : 0,
                        // 预览帧（面板侧已缩好的小图，按条目 id 落盘；null = 抓帧失败/无合成）
                        previewSource: previewSource
                    });
                    _refresh();
                    if (global.AEToast) AEToast.success((isLayer ? AEI18n.t('图层已保存: ') : AEI18n.t('合成已保存: ')) + name);
                    if (r && r.unredirected && r.unredirected.length) {
                        // 分图层素材（PSD/AI）：FileSource.file readOnly + replace 必合并，
                        // 无法保留图层改路径，保留原引用（.aep 里指向原路径，非自包含）。
                        var unredMsg = AEI18n.t('以下分图层素材（PSD/AI）保留原路径未重定向，避免图层合并：') + r.unredirected.join(AEI18n.punct('、', ', '));
                        if (global.AEToast) AEToast.warn(unredMsg, { autoHideMs: 8000 });
                    }
                    // 消费侧：同 _exportWhole——兜底副本复制失败如实提示（与 unredirected 并列）
                    if (r && r.copyFailed && r.copyFailed.length) {
                        if (global.AEToast) AEToast.warn(AEI18n.t('分图层素材兜底副本复制失败（导出包与 footage 目录缺这些文件，异地无法手动重链）：') + r.copyFailed.join((typeof AEI18n !== 'undefined' && AEI18n.punct ? AEI18n.punct('、', ', ', '、') : '、')), { autoHideMs: 8000 });
                    }
                } catch (metaErr) {
                    console.warn('[Assets] 保存成功但索引失败:', metaErr);
                    _refresh();
                    if (global.AEToast) AEToast.warn(AEI18n.t('保存成功但索引更新失败，文件已在目标目录'));
                }
            } catch (e) {
                // 失败也尝试回切
                try { await _call('restoreProject({originalPath:"' + _escPath(state.projectPath) + '"})', restoreTimeout); } catch (_) {}
                // 清理 jsx 在数据目录 temp 下生成的临时副本（走 AEFS，不留在 jsx 里裸 File.remove）
                var errTemp = e && e.detail && e.detail.tempPath ? e.detail.tempPath : '';
                if (errTemp) { try { await global.AEFS.deleteFile(errTemp); } catch (_) {} }
                if (global.AEToast) AEToast.error(AEI18n.t('保存失败: ') + (e.message || e));
            } finally {
                _activeProgressNotice = null;
                if (notice) notice.close();
            }
            } catch (e) {
                if (global.AEToast) AEToast.error(AEI18n.t('保存失败: ') + (e.message || e));
            } finally {
                _busy = false;
            }
        }

        // ── 辅助：路径拼接 ──
        function _buildPath() {
            var segs = [];
            for (var i = 0; i < arguments.length; i++) {
                var s = String(arguments[i] || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                if (s && s !== '..' && s !== '.') segs.push(s);  // 仅拒精确 '..' / '.' 段防穿越，放过含 .. 的合法名
            }
            return segs.join('/');
        }

        async function _findAepInDir(dir) {
            var files = await global.AEFS.listFiles(dir);
            for (var i = 0; i < files.length; i++) {
                if (/\.aep$/i.test(files[i])) return dir + '/' + files[i];
            }
            var dirs = await global.AEFS.listDirs(dir);
            for (var j = 0; j < dirs.length; j++) {
                var sub = await _findAepInDir(dir + '/' + dirs[j]);
                if (sub) return sub;
            }
            return null;
        }

        async function _fileSize(p) {
            // 统一走 AEFS.fileSize（含 _checkPath 安全校验）
            try {
                if (global.AEFS && typeof global.AEFS.fileSize === 'function') {
                    var s = await global.AEFS.fileSize(p);
                    return s >= 0 ? s : 0;
                }
                // AEFS 不可用时回退 ExtendScript
                var r = await _callRaw('var f=new File("' + _escPath(p) + '"); f.exists ? String(f.length) : "0"', 8000);
                return parseInt(r, 10) || 0;
            } catch (_) { return 0; }
        }

        function _pickFromList(title, items) {
            return new Promise(function (resolve) {
                // 动态 <select> 列表选择模态（避 CEF Chrome 88 静态 option 重置 bug）
                var overlay = document.createElement('div');
                overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
                var box = document.createElement('div');
                box.style.cssText = 'background:var(--surface-2);border:1px solid var(--border);border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,.5);padding:16px 20px;min-width:280px;max-width:400px;';
                var h = document.createElement('div');
                h.textContent = title;
                h.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-main);margin-bottom:10px;';
                box.appendChild(h);
                var sel = document.createElement('select');
                sel.style.cssText = 'width:100%;background:var(--input-bg);border:1px solid var(--border);color:var(--text-main);padding:6px 8px;border-radius:4px;font-size:13px;margin-bottom:12px;';
                for (var i = 0; i < items.length; i++) {
                    var opt = document.createElement('option');
                    opt.value = items[i];
                    opt.textContent = items[i];
                    sel.appendChild(opt);
                }
                if (items.length > 12) sel.size = 12;
                box.appendChild(sel);
                var btnRow = document.createElement('div');
                btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
                var cancelBtn = document.createElement('button');
                cancelBtn.textContent = AEI18n.t('取消');
                cancelBtn.style.cssText = 'background:var(--btn-bg);border:1px solid var(--btn-border);color:var(--btn-text);padding:5px 14px;border-radius:4px;font-size:12px;cursor:pointer;';
                var okBtn = document.createElement('button');
                okBtn.textContent = AEI18n.t('确定');
                okBtn.style.cssText = 'background:var(--accent-soft);border:1px solid var(--accent);color:var(--accent);padding:5px 20px;border-radius:4px;font-size:12px;cursor:pointer;font-weight:600;';
                btnRow.appendChild(cancelBtn);
                btnRow.appendChild(okBtn);
                box.appendChild(btnRow);
                overlay.appendChild(box);
                document.body.appendChild(overlay);
                var done = false;
                function close(val) {
                    if (done) return; done = true;
                    // 任何关闭路径统一解绑 keydown——仅 ESC 分支解绑时，
                    // 按钮/点遮罩关闭各泄漏一个 document 监听（函数暂无调用方，启用即每次泄漏）
                    document.removeEventListener('keydown', onKey);
                    document.body.removeChild(overlay);
                    resolve(val);
                }
                cancelBtn.addEventListener('click', function () { close(null); });
                okBtn.addEventListener('click', function () { close(sel.value); });
                overlay.addEventListener('click', function (e) { if (e.target === overlay) close(null); });
                // ESC
                function onKey(e) { if (e.key === 'Escape') close(null); }
                document.addEventListener('keydown', onKey);
                sel.focus();
            });
        }

        function _showProgress(msg) {
            if (global.AENotice) return global.AENotice.show({
                id: 'assets-proj-export', title: AEI18n.t('工程素材'), message: msg, tone: 'info', dismissible: false
            });
            return null;
        }

        function _onSelect(id) {
            var gen = ++_selectGen;
            var items = store.list();
            var it = null;
            for (var i = 0; i < items.length; i++) { if (items[i].id === id) { it = items[i]; break; } }
            if (!it) return;
            // 单点 exists 无法区分「真不存在」与「通道故障」——AEFS.exists 的
            // ExtendScript 回退对 CSInterface 未定义/超时/异常均 resolve(false)，通道故障
            // 误标 missing 落盘后叠加 cleanMissing 会误删引用（只修了批量路径，
            // 单点未覆盖）。调用前快照 AEFS.lastError()，false 且 lastError 有新增 →
            // 通道故障不落 missing 标记（方向偏安全：宁可不标也不误删）
            var _errBefore = (global.AEFS && typeof global.AEFS.lastError === 'function') ? global.AEFS.lastError() : '';
            global.AEFS.exists(it.aepPath).then(function (ok) {
                if (_destroyed || gen !== _selectGen) return;
                if (ok === false && !it.missing) {
                    var _errNow = (global.AEFS && typeof global.AEFS.lastError === 'function') ? global.AEFS.lastError() : '';
                    if (_errNow && _errNow !== _errBefore) {
                        console.warn('[Assets] exists 通道故障，跳过 missing 标记: ' + _errNow);
                        return;
                    }
                    return store.setMissing(id, true).then(function () {
                        if (_destroyed || gen !== _selectGen) return;
                        // 行内重命名/新建进行中不重渲染（对齐 refView 的 修法，
                        // _editing 只覆盖备注编辑）——render 分支走 innerHTML='' 重建左树会
                        // 销毁行内编辑器（正在输入的名称静默丢失）；missing 标记已持久化，行数据
                        // 经 _raw 活引用在下一次重建时自然带出
                        if (_tv && _tv.isEditing && _tv.isEditing()) return;
                        if (_editing) { _tv.renderList(_buildRows()); }
                        else { _refresh(); _tv.select(id); }
                    });
                } else if (ok === true && it.missing) {
                    return store.setMissing(id, false).then(function () {
                        if (_destroyed || gen !== _selectGen) return;
                        // 同上——行内重命名进行中不重渲染
                        if (_tv && _tv.isEditing && _tv.isEditing()) return;
                        if (_editing) { _tv.renderList(_buildRows()); }
                        else { _refresh(); _tv.select(id); }
                    });
                }
            }).catch(function (e) {
                console.warn('[Assets] setMissing 链失败: ' + (e && e.message ? e.message : e));
            });
        }

        function _renderDetail(it) {
            if (!it) return AEI18n.html('<div class="assets-empty-state"><div class="assets-empty-state-icon">📄</div><div class="assets-empty-state-text">未选中</div></div>');
            var r = it._raw || it;
            var emoji = SOURCE_EMOJI[r.sourceType] || '📄';
            var typeLabel = { whole: AEI18n.t('工程包'), comp: AEI18n.t('合成'), layer: AEI18n.t('图层'), import: AEI18n.t('工程'), bundle: AEI18n.t('工程包') }[r.sourceType] || r.sourceType;
            // 预览区：有条目预览帧时出图（.has-img 隐藏图标块），加载失败由 img 的 onerror
            // 摘掉 has-img → 图标块露出来（回落不需要 JS 分支）
            var pvUrl = global.AEAssetsShared.previewUrlFor(dataDir, 'project-assets', r);
            var pvSub = _esc(typeLabel) + ' · ' + _fmtSize(r.size)
                + (pvUrl ? AEI18n.t(' · 预览取自 {sec}s', { sec: _fmtSec(r.previewFrame.time) }) : '');
            var pvImg = pvUrl
                ? '<img class="assets-detail-preview-img" src="' + _esc(pvUrl) + '" alt=""'
                    + ' onerror="this.parentNode.classList.remove(\'has-img\')">'
                : '';
            return '<div class="assets-detail">'
                // 预览区
                + '<div class="assets-detail-preview' + (pvUrl ? ' has-img' : '') + '">'
                + '<div class="assets-detail-preview-icon">' + _esc(emoji) + '</div>'
                + pvImg
                + '<div class="assets-detail-preview-name">' + _esc(r.name) + '.aep</div>'
                + '<div class="assets-detail-preview-sub">' + pvSub + '</div>'
                + '</div>'
                // 元数据卡片
                + '<div class="assets-detail-section">'
                + '<div class="assets-detail-section-title">' + AEI18n.t('详情') + '</div>'
                + '<div class="assets-detail-section-body">'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('名称') + '</span><span class="v">' + _esc(r.name) + '</span></div>'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('类型') + '</span><span class="v">' + _esc(typeLabel) + ' (.aep)</span></div>'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('大小') + '</span><span class="v">' + _fmtSize(r.size) + '</span></div>'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('原工程') + '</span><span class="v">' + _esc(r.originalProject || '-') + '</span></div>'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('保存时间') + '</span><span class="v">' + _esc(r.exportTime || '-') + '</span></div>'
                + (r.missing ? '<div class="assets-empty assets-empty-inline assets-empty-warn">' + AEI18n.t('.aep 文件已丢失') + '</div>' : '')
                + '</div></div>'
                // 操作按钮
                + '<div class="assets-detail-actions">'
                + '<button class="btn btn-slice secondary" data-act="importAE" data-id="' + _esc(r.id) + '">' + AEI18n.t('导入AE') + '</button>'
                // 手工重生成：与 presetView 同形——明文按钮，有无预览都显示
                + '<button class="btn btn-slice secondary" data-act="regenPreview" data-id="' + _esc(r.id) + '"'
                    + ' title="' + _esc(AEI18n.t('取 AE 当前画面重新生成预览，约需 3 秒')) + '">' + AEI18n.t('重新截取预览') + '</button>'
                + '<button class="btn btn-slice secondary" data-act="delete" data-id="' + _esc(r.id) + '">' + AEI18n.t('归档') + '</button>'
                + '</div>'
                // 备注
                + '<textarea class="assets-proj-notes" data-id="' + _esc(r.id) + '" maxlength="2000" placeholder="' + _esc(AEI18n.t('备注…')) + '">' + _esc(r.notes || '') + '</textarea>'
                + '</div>';
        }

        function _saveNotes(id) {
            var ta = pane.querySelector('.assets-proj-notes');
            var notes = ta ? ta.value : '';
            function _doSaveNotes() {
                store.updateMeta(id, { notes: notes }).then(function () {
                    // 只刷新右栏保留编辑焦点；全量 render 会替换 textarea 打断输入
                    if (_tv && _tv.refreshDetail) _tv.refreshDetail();
                }).catch(function (e) {
                    if (global.AEToast) AEToast.error(AEI18n.t('保存备注失败: ') + (e && e.message ? e.message : e));
                });
            }
            if (_busy) {
                // 批量操作中途不写（避免与批量的索引写盘抢锁），但也不能丢编辑内容：
                // 先捕获 textarea 值，延迟重试直到不忙（视图销毁后放弃）
                setTimeout(function retry() {
                    if (_destroyed) return;
                    if (_busy) { setTimeout(retry, 200); return; }
                    _doSaveNotes();
                }, 200);
                return;
            }
            _doSaveNotes();
        }

        function _delete(id) {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            var it = store.list().filter(function (x) { return x.id === id; })[0];
            if (!it) return;
            _busy = true;
            var confirmMsg = it.missing
                ? AEI18n.t('「{name}」的 .aep 文件已丢失，将移除索引条目（无实体可归档）。是否继续？', { name: it.name })
                : AEI18n.t('确定归档「{name}」？工程包将移入库内归档区，7 天后自动清理，期间可在「归档区」面板恢复。', { name: it.name });
            // 条目本身是链接时先显式提示（归档=物理搬移，作用于真实目标；missing
            // 条目无实体不探测）；取消 → 什么都不做
            var _dp = (!it.missing && (it.targetFolder || it.aepPath)) ? (it.targetFolder || it.aepPath) : null;
            _fh._withLinkGuard(_dp ? [{ path: _dp, label: it.name }] : [], function () { _deleteConfirmed(id, it, confirmMsg); })
                .then(function (go) { if (go === false) _busy = false; });
        }

        // 归档确认 + 执行链（从 _delete 原样抽出，守卫通过后调用）
        function _deleteConfirmed(id, it, confirmMsg) {
            global.showConfirm(AEI18n.t('归档工程素材'), confirmMsg, 'confirm').then(function (ok) {
                if (!ok) { _busy = false; return; }
                store.archive([id]).then(function (res) {
                    _busy = false; _refresh();
                    // 单条归档也要消费回执 failures：store._archiveInner 复制/删源/归档区创建
                    // 失败时不抛错，只把失败写进 res.failures 后 resolve——只查 missing 会弹假成功。
                    // 分档与文案对齐批量路径 _batchDelete（archived+missing 计入成功，重叠项为部分失败警告）
                    var arch = (res && res.archived) || [];
                    var miss = (res && res.missing) || [];
                    var fails = (res && res.failures) || [];
                    var doneN = arch.length + miss.length;
                    if (fails.length) {
                        var err0 = (fails[0] && fails[0].error) ? fails[0].error : AEI18n.t('未知错误');
                        if (doneN > 0) {
                            if (global.AEToast) AEToast.warn(AEI18n.t('归档完成（') + doneN + AEI18n.t(' 成功，') + fails.length + AEI18n.t(' 条部分失败警告）: ') + err0);
                        } else {
                            if (global.AEToast) AEToast.error(AEI18n.t('归档失败: ') + err0);
                        }
                        return;
                    }
                    if (miss.length) { if (global.AEToast) AEToast.info(AEI18n.t('「{name}」无实体文件，已移除索引条目', { name: it.name })); return; }
                    if (global.AEToast) AEToast.success(AEI18n.t('已归档「') + it.name + AEI18n.t('」（7 天后自动清理）'));
                }).catch(function (e) {
                    _busy = false;
                    if (e && e.code === 'CANCELLED') return;
                    if (global.AEToast) AEToast.error(AEI18n.t('归档失败: ') + (e.message || e));
                });
            });
        }

        function _openLocation(id) {
            var it = store.list().filter(function (x) { return x.id === id; })[0];
            if (!it) return;
            // whole/bundle: 打开 targetFolder（含 .aep + 资产）；裸 .aep: 打开所在目录
            var folderPath = it.targetFolder || it.aepPath.replace(/[\\/][^\\/]+$/, '');
            if (!folderPath) return;
            if (typeof CSInterface === 'undefined') { if (global.AEToast) AEToast.warn(AEI18n.t('请在 AE 中打开扩展面板')); return; }
            var safePath = _escPath(folderPath);
            new CSInterface().evalScript(
                '(function(){var f=new Folder("' + safePath + '");if(!f.exists){return "NOT_EXISTS";}return f.execute()?"OK":"FAIL";})();',
                function (res) {
                    var r = String(res || '').trim();
                    if (r === 'NOT_EXISTS') { if (global.AEToast) AEToast.warn(AEI18n.t('目录不存在: ') + folderPath); }
                    else if (r !== 'OK') { if (global.AEToast) AEToast.warn(AEI18n.t('打开目录失败: ') + folderPath); }
                }
            );
        }

        function _batchImportAE() {
            var ids = _tv.getSelectedIds();
            if (!ids.length) return;
            _importIdList(ids);
        }

        function _importFolderToAE(folderPath) {
            var fp = String(folderPath || '').replace(/^\/+|\/+$/g, '');
            var items = store.list().filter(function (it) {
                if (!fp) return !it.folder;
                return it.folder === fp || it.folder.indexOf(fp + '/') === 0;
            });
            if (!items.length) { if (global.AEToast) AEToast.warn(AEI18n.t('文件夹为空')); return; }
            _importIdList(items.map(function (x) { return x.id; }));
        }

        function _importIdList(ids) {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            var total = ids.length;
            var done = 0, failed = 0;
            var cancelled = false;
            var notice = (total > NOTICE_THRESHOLD) && global.AENotice ? global.AENotice.show({
                id: 'assets-proj-importAE',
                title: AEI18n.t('导入AE'),
                message: AEI18n.t('正在导入… {done}/{total}', { done: 0, total: total }),
                tone: 'info',
                dismissible: false,
                progress: 0,
                progressLabel: '0/' + total,
                actions: [
                    { label: AEI18n.t('取消'), type: 'secondary', onClick: function () { cancelled = true; }, keepOpen: false }
                ],
                onClose: function (result) {
                    if (result && result.action === AEI18n.t('取消')) cancelled = true;
                }
            }) : null;
            setTimeout(function () {
                (function next(i) {
                    if (cancelled || i >= ids.length) {
                        _busy = false;
                        if (notice) notice.close();
                        if (cancelled) {
                            if (global.AEToast) AEToast.info(AEI18n.t('已取消（已导入 ') + done + '/' + total + AEI18n.punct('）', ')'));
                        } else {
                            var msg = AEI18n.t('已导入AE: {done}/{total}', { done: done, total: total });
                            if (failed > 0) msg += AEI18n.t('（{n} 失败）', { n: failed });
                            if (global.AEToast) AEToast[done > 0 ? 'success' : 'error'](msg);
                        }
                        return;
                    }
                    _importToAE(ids[i], true).then(function () {
                        done++;
                        if (notice && global.AENotice) {
                            global.AENotice.update('assets-proj-importAE', {
                                message: AEI18n.t('正在导入… {done}/{total}', { done: done + failed, total: total }),
                                progress: Math.round((done + failed) / total * 100),
                                progressLabel: (done + failed) + '/' + total
                            });
                        }
                        next(i + 1);
                    }).catch(function () {
                        failed++;
                        if (notice && global.AENotice) {
                            global.AENotice.update('assets-proj-importAE', {
                                message: AEI18n.t('正在导入… {done}/{total}', { done: done + failed, total: total }),
                                progress: Math.round((done + failed) / total * 100),
                                progressLabel: (done + failed) + '/' + total
                            });
                        }
                        next(i + 1);
                    });
                })(0);
            }, 30);
        }

        function _batchDelete() {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            var ids = _tv.getSelectedIds();
            if (!ids.length) return;
            var idSet = {};
            ids.forEach(function (i) { idSet[i] = true; });
            var missingCnt = store.list().filter(function (x) { return idSet[x.id] && x.missing; }).length;
            _busy = true;
            var batchMsg;
            if (missingCnt === 0) {
                batchMsg = AEI18n.t('确定归档选中的 {n} 个素材？工程包将移入库内归档区，7 天后自动清理，期间可恢复。', { n: ids.length });
            } else if (missingCnt === ids.length) {
                batchMsg = AEI18n.t('选中的 {n} 个素材均已丢失 .aep，将移除索引条目（无实体可归档）。是否继续？', { n: ids.length });
            } else {
                batchMsg = AEI18n.t('选中的 {n} 个素材中有 {missing} 个 .aep 已丢失：实体将归档（7 天后自动清理），丢失项移除索引。是否继续？', { n: ids.length, missing: missingCnt });
            }
            // 选中条目本身是链接时先显式提示（逐条探测、一次汇总；missing 无实体不探测）；
            // 取消 → 什么都不做
            var _bents = store.list().filter(function (x) { return idSet[x.id] && !x.missing && (x.targetFolder || x.aepPath); })
                .map(function (x) { return { path: x.targetFolder || x.aepPath, label: x.name }; });
            _fh._withLinkGuard(_bents, function () { _batchDeleteConfirmed(ids, batchMsg); })
                .then(function (go) { if (go === false) _busy = false; });
        }

        // 批量归档确认 + 执行链（从 _batchDelete 原样抽出，守卫通过后调用）
        function _batchDeleteConfirmed(ids, batchMsg) {
            global.showConfirm(AEI18n.t('批量归档'), batchMsg, 'danger').then(function (ok) {
                if (!ok) { _busy = false; return; }
                var total = ids.length;
                var deleted = 0, failed = 0, partialWarn = 0;
                var cancelled = false;
                var notice = (total > NOTICE_THRESHOLD) && global.AENotice ? global.AENotice.show({
                    id: 'assets-proj-archive',
                    title: AEI18n.t('归档工程素材'),
                    message: AEI18n.t('正在归档… {done}/{total}', { done: 0, total: total }),
                    tone: 'warn',
                    dismissible: false,
                    progress: 0,
                    progressLabel: '0/' + total,
                    actions: [
                        { label: AEI18n.t('取消'), type: 'secondary', onClick: function () { cancelled = true; }, keepOpen: false }
                    ],
                    onClose: function (result) {
                        if (result && result.action === AEI18n.t('取消')) cancelled = true;
                    }
                }) : null;
                // 让浏览器先渲染 notice（store.remove 有 sync 操作会阻塞主线程）
                setTimeout(function () {
                    function _finishBatchDel() {
                        _busy = false;
                        _refresh();
                        if (notice) notice.close();
                        if (cancelled) {
                            if (global.AEToast) AEToast.info(AEI18n.t('已取消（已归档 ') + deleted + '/' + total + AEI18n.punct('）', ')'));
                        } else if (failed > 0) {
                            // 部分失败必须如实汇报（对齐 folderViewMixin._archiveFolders）；
                            // 部分删除项已计入成功，仅作附加警告、不重复计入失败数
                            var _pw = partialWarn > 0 ? AEI18n.t('，{n} 条部分失败警告', { n: partialWarn }) : '';
                            if (global.AEToast) AEToast.error(AEI18n.t('归档完成（') + deleted + AEI18n.t(' 成功，') + failed + AEI18n.t(' 失败') + _pw + AEI18n.punct('）', ')'));
                        } else if (partialWarn > 0) {
                            // 部分删除（源已不可逆变更）：条目已按完成归档，只报警告不重复计数
                            if (global.AEToast) AEToast.warn(AEI18n.t('归档完成（') + deleted + AEI18n.t(' 成功，') + partialWarn + AEI18n.t(' 条部分失败警告）'));
                        } else {
                            if (global.AEToast) AEToast.success(AEI18n.t('已归档 ') + deleted + AEI18n.t(' 个素材（7 天后自动清理）'));
                        }
                    }
                    (function next(i) {
                        if (cancelled || i >= ids.length) {
                            _finishBatchDel();
                            return;
                        }
                        // 分块调用 store.archive（每块一次索引落盘；块内逐条成败由返回结果记账）
                        var chunk = ids.slice(i, i + 10);
                        store.archive(chunk).then(function (res) {
                            // 部分删除的条目按「如实回执」同时出现在 archived/missing 与 failures 里——
                            // 两部分直接相加会重复计数（同一 id 既算成功又算失败），进度可 >100%。
                            // 按 id 去重：成功照常计；失败只计未计入成功的 id，重叠项只作「部分失败警告」
                            // （提示一次、不推进进度），进度恒 ≤ total
                            var okIds = {};
                            var okN = 0, failN = 0, partN = 0;
                            ((res && res.archived) || []).forEach(function (x) {
                                var k = (x && x.id != null) ? String(x.id) : '';
                                if (k) { if (okIds[k]) return; okIds[k] = true; }
                                okN++;
                            });
                            ((res && res.missing) || []).forEach(function (x) {
                                var k = (x && x.id != null) ? String(x.id) : '';
                                if (k) { if (okIds[k]) return; okIds[k] = true; }
                                okN++;
                            });
                            ((res && res.failures) || []).forEach(function (f) {
                                var k = (f && f.id != null) ? String(f.id) : '';
                                if (k && okIds[k]) { partN++; return; }   // 部分删除：成功已计，只报警告
                                failN++;
                            });
                            deleted += okN;
                            failed += failN;
                            partialWarn += partN;
                            _updateDelProgress();
                            setTimeout(function () { next(i + chunk.length); }, 5);
                        }).catch(function (e) {
                            if (e && (e.code === 'CANCELLED' || e.message === 'USER_CANCELLED')) {
                                cancelled = true;
                                _finishBatchDel();
                                return;
                            }
                            failed += chunk.length;
                            _updateDelProgress();
                            setTimeout(function () { next(i + chunk.length); }, 5);
                        });
                    })(0);
                }, 30);
                function _updateDelProgress() {
                    if (notice && global.AENotice) {
                        var d = deleted + failed;
                        global.AENotice.update('assets-proj-archive', {
                            message: AEI18n.t('正在归档… {done}/{total}', { done: d, total: total }),
                            progress: Math.round(d / total * 100),
                            progressLabel: d + '/' + total
                        });
                    }
                }
            });
        }

        function _importToAE(id, silent) {
            // silent=true 由 _importIdList 批量调用，_busy 由其统一管理
            if (!silent && _busy) {
                if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待'));
                return Promise.reject(new Error('busy'));
            }
            if (!silent) _busy = true;
            return new Promise(function (resolve, reject) {
                var it = store.list().filter(function (x) { return x.id === id; })[0];
                if (!it) { if (!silent) _busy = false; reject(new Error(AEI18n.t('素材不存在'))); return; }
                if (!hostApi) { if (!silent) _busy = false; reject(new Error(AEI18n.t('ExtendScript 桥未就绪'))); return; }
                // 复用素材库共享导入函数，避免各处重写 ExtendScript 脚本导致漏改
                // （如 undoGroup 顺序、重命名逻辑、_escPath 等需多处对齐）
                global.AEAssetsShared.importProjectToAE(hostApi, it.aepPath, it.name).then(function (r) {
                    if (!silent) _busy = false;
                    var displayName = r;
                    if (r.indexOf('RENAMED:') === 0) displayName = r.slice(8);
                    if (!silent && global.AEToast) AEToast.success(AEI18n.t('已导入AE: ') + displayName);
                    resolve(r);
                }).catch(function (e) {
                    if (!silent) _busy = false;
                    reject(e);
                });
            });
        }

        function _buildRows() {
            return store.list().map(function (it) {
                return { id: it.id, name: it.name, folder: it.folder, sourceType: it.sourceType, _raw: it };
            });
        }

        function _refresh() {
            if (_destroyed) return;
            if (_editing) {
                _tv.renderList(_buildRows());
            } else {
                _tv.render(_buildRows());
            }
            // 归档区按钮计数（删除=归档）
            var archN = _archivedCount();
            btnArchive.textContent = archN > 0 ? (AEI18n.t('归档区 (') + archN + ')') : AEI18n.t('归档区');
        }

        async function init() {
            var overlay = global.AEAssetsShared.createLoadingOverlay(dz);
            try {
                await store.load();
                if (_destroyed) return;
                _refresh();
                _checkGarbage(true);   // true = 自动扫描，不弹"未发现"toast
                _cleanTempResidual();
            } finally {
                overlay.hide();
            }
        }

        async function _reload() {
            if (_busy) return;
            _busy = true;
            var overlay = global.AEAssetsShared.createLoadingOverlay(dz);
            try {
                var stdStats = null;
                try { stdStats = await store.load(); }
                catch (e) {
                    // 刷新失败不能吞错后仍提示“已刷新”
                    if (global.AEToast) AEToast.error(AEI18n.t('刷新失败: ') + (e && e.message ? e.message : e));
                    return;
                }
                if (_destroyed) return;
                _refresh();
                if (global.AEToast) {
                    var parts = [];
                    if (stdStats) {
                        if (stdStats.imported > 0) parts.push(AEI18n.t('入库 {n} 个', { n: stdStats.imported }));
                        if (stdStats.aligned > 0) parts.push(AEI18n.t('对齐 {n} 个', { n: stdStats.aligned }));
                    }
                    if (parts.length) AEToast.success(AEI18n.t('已刷新：') + parts.join(AEI18n.punct('，', ', ')));
                    else AEToast.info(AEI18n.t('已刷新'));
                }
            } finally {
                overlay.hide();
                _busy = false;
            }
        }

        function destroy() {
            _destroyed = true;
            // 移除 exportProgress 监听（与 _ensureProgressListener 成对，防监听器泄漏）
            if (_progressListenerCs && _progressListenerHandler) {
                try { _progressListenerCs.removeEventListener("com.ae.assets.exportProgress", _progressListenerHandler); } catch (_) {}
                _progressListenerCs = null;
                _progressListenerHandler = null;
                _progressListenerReady = false;
            }
            dz.removeEventListener('dragover', _dzHandlers.dragover);
            dz.removeEventListener('dragleave', _dzHandlers.dragleave);
            dz.removeEventListener('drop', _dzHandlers.drop);
            if (_tv) _tv.destroy();
            pane.innerHTML = '';
        }

        var _missingCheckGen = 0;
        function onActive() {
            // 卡回到顶层时只刷新右栏（左树不变）
            if (_tv && _tv.refreshDetail) _tv.refreshDetail();
            var gen = ++_missingCheckGen;
            _checkMissing(gen);
        }
        async function _checkMissing(gen) {
            // 前置守卫：destroy 后不再发起 scanMissing——原 _destroyed 检查在
            // await 之后，拦不住 scanMissing 内部的 flushIndex 写盘（unmount 后 index.json 仍被改写）
            if (_destroyed) return;
            var items = store.list();
            if (!items.length) return;
            // 复用 store.scanMissing（批量探测 + 内存更新 + 单次 flush）：
            // 逐条 setMissing 每条全量重写 index.json（O(n²) IO），条目多时每次切卡都卡
            var r;
            try { r = await store.scanMissing(); }
            catch (_) { return; }   // 桥不可用：跳过当前轮检查，不误标
            if (_destroyed || gen !== _missingCheckGen) return;
            if (r && r.changed) {
                if (_editing) { _tv.renderList(_buildRows()); }
                else { _refresh(); }
            }
        }

        async function _cleanMissing() {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            var notice = global.AENotice ? global.AENotice.show({
                id: 'assets-proj-scan-missing',
                title: AEI18n.t('扫描丢失工程'),
                message: AEI18n.t('正在扫描丢失文件…'),
                tone: 'info',
                dismissible: false
            }) : null;
            try {
                await store.scanMissing();
            } catch (_) {}
            if (_destroyed) { _busy = false; if (notice) notice.close(); return; }
            if (notice) notice.close();
            _busy = false;
            var missing = store.listMissing();
            if (missing.length === 0) {
                if (global.AEToast) AEToast.info(AEI18n.t('没有丢失索引的工程素材'));
                return;
            }
            _refresh();
            global.showConfirm(
                AEI18n.t('清理丢失索引'),
                AEI18n.t('检测到 ') + missing.length + AEI18n.t(' 个工程素材的 .aep 文件已丢失（索引仍在）。确定清理这些索引条目？此操作仅删除索引，不影响其他工程素材。'),
                'confirm'
            ).then(function (ok) {
                if (!ok) return;
                _busy = true;
                store.cleanMissing().then(function (res) {
                    _busy = false;
                    _refresh();
                    if (global.AEToast) AEToast.success(AEI18n.t('已清理 ') + res.cleaned + AEI18n.t(' 个丢失索引'));
                }).catch(function (e) {
                    _busy = false;
                    if (global.AEToast) AEToast.error(AEI18n.t('清理失败: ') + (e && e.message ? e.message : e));
                });
            }).catch(function () { /* 用户关闭对话框，_busy 已为 false */ });
        }
        var _garbageCheckBusy = false;
        // skipLock=true 时跳过锁管理（由调用方提前设锁），用于垃圾按钮的 load+check 一体化流程
        async function _checkGarbage(silent, skipLock) {
            if (!skipLock) {
                if (_garbageCheckBusy) return;
                _garbageCheckBusy = true;
            }
            try {
                var garbage;
                try { garbage = await store.listGarbage(); } catch (e) {
                    if (!silent && global.AEToast) AEToast.error(AEI18n.t('扫描垃圾失败: ') + (e && e.message ? e.message : e));
                    return;
                }
                if (_destroyed) return;
                if (!garbage || !garbage.length) {
                    if (!silent && global.AEToast) AEToast.info(AEI18n.t('未发现残留文件'));
                    return;
                }
                var names = garbage.map(function (p) { return p.replace(/\\/g, '/').split('/').pop(); });
                var ok = await global.showConfirm(AEI18n.t('移动至垃圾区'), AEI18n.t('发现 ') + garbage.length + AEI18n.t(' 个无人认领的残留文件/目录：\n「') + names.join(AEI18n.punct('」\n「', '"\n"', '」\n「', '“\n„', '”\n“', ' »\n« ', '»\n«')) + AEI18n.t('」\n\n这些是之前标准化或删除工程后留下的旧位置残留。是否移入垃圾区文件夹（素材目录下 ___trash__）？（不会删除，可自行查看后手动删除）'), 'danger');
                if (!ok || _destroyed) return;
                var gTotal = garbage.length;
                var gcNotice = null;
                if (gTotal > NOTICE_THRESHOLD && global.AENotice) {
                    gcNotice = global.AENotice.show({
                        id: 'assets-proj-gcdel',
                        title: AEI18n.t('移动至垃圾区'),
                        message: AEI18n.t('正在移入垃圾区… {done}/{total}', { done: 0, total: gTotal }),
                        tone: 'info',
                        dismissible: false,
                        progress: 0,
                        progressLabel: '0/' + gTotal
                    });
                }
                var r;
                try {
                    r = await store.cleanGarbage(garbage, function (done, total) {
                        if (gcNotice && global.AENotice) {
                            global.AENotice.update('assets-proj-gcdel', {
                                message: AEI18n.t('正在移入垃圾区… {done}/{total}', { done: done, total: total }),
                                progress: Math.round(done / total * 100),
                                progressLabel: done + '/' + total
                            });
                        }
                    });
                } finally {
                    if (gcNotice) gcNotice.close();
                }
                if (_destroyed) return;
                if (r.failed.length) {
                    if (global.AEToast) AEToast.warn(AEI18n.t('移入垃圾区：') + r.cleaned + AEI18n.t(' 个成功，') + r.failed.length + AEI18n.t(' 个失败'));
                } else {
                    if (global.AEToast) AEToast.success(AEI18n.t('已移入垃圾区 ') + r.cleaned + AEI18n.t(' 个残留（未删除，可在素材目录 ___trash__ 文件夹内自行清理）'));
                }
            } catch (e) {
                if (!silent && global.AEToast) AEToast.error(AEI18n.t('清理失败: ') + (e && e.message ? e.message : e));
            } finally {
                if (!skipLock) _garbageCheckBusy = false;
            }
        }
        // 清理数据目录 temp 下的导出临时副本（_export_*.aep）。
        // 残留来源：导出时 panel 超时 jsx 仍在跑、或 AE 崩溃，tempPath 没被 deleteFile 清掉。
        // init 时静默清理（临时副本确定无用，不弹确认）。只删 _export_ 前缀的 .aep，不碰其他文件。
        // 两道保护（数据丢失窗口）：回切失败/面板崩溃时 AE 可能正停在副本工程上——
        //   ① 清理前经 host 探当前工程文件（app.project.file.fsName），命中即保留；
        //      探测失败（宿主忙/模态超时、桥断）时 fail-closed：当前轮一律跳过删除并留痕——
        // 无法排除「AE 正停在超龄副本上」时年龄门槛不能作为放行依据（收口）；
        //   ② 最小年龄门槛（仅在探测成功后生效）：mtime 拿不到或不足 1 小时的残留一律不删。
        async function _cleanTempResidual() {
            var tempDir = _buildPath(dataDir, 'temp');
            var exists = await global.AEFS.exists(tempDir);
            if (exists !== true) return;
            var files = [];
            try { files = await global.AEFS.listFiles(tempDir); } catch (_) { return; }
            if (!Array.isArray(files)) return;
            var targets = [];
            for (var t = 0; t < files.length; t++) {
                if (/^_export_.*\.aep$/i.test(files[t])) targets.push(files[t]);
            }
            if (targets.length === 0) return;
            // ① 当前 AE 正打开的工程：可能是回切失败的导出副本，命中绝不删
            var currentProject = '';
            try {
                var st = await _call('getProjectState({})', 10000);
                if (st && st.projectPath) currentProject = _normFsPath(st.projectPath);
            } catch (e) {
                // fail-closed：探测失败 = 无法排除「AE 正停在超龄 _export_ 副本上」
                //（宿主忙/模态导致超时正是该窗口，年龄门槛对此无鉴别力）——当前轮跳过删除，
                // 宁可留下残留下次 init 再收，也不误删正打开的工程文件。
                // 留痕：每次跳过都有 warn，持续探测失败可从日志看出清理一直被跳过的原因。
                console.warn('[Assets] 当前工程探测失败，本轮跳过 temp 残留清理（fail-closed，防误删 AE 正打开的导出副本；'
                    + targets.length + ' 个候选）: ' + (e && e.message ? e.message : e));
                return;
            }
            // ② 年龄：listFilesWithSize（Bridge 一次拿全）优先，退回逐文件 stat；
            //    拿不到年龄一律保护跳过（未知 → 不删，对齐 tempSweep 口径）
            var mtimes = {};
            try {
                var sized = await global.AEFS.listFilesWithSize(tempDir);
                if (Array.isArray(sized)) {
                    for (var s = 0; s < sized.length; s++) {
                        if (sized[s] && sized[s].name && typeof sized[s].mtimeMs === 'number') {
                            mtimes[sized[s].name] = sized[s].mtimeMs;
                        }
                    }
                }
            } catch (_) {}
            var cutoff = Date.now() - 3600000;
            var cleaned = 0;
            for (var i = 0; i < targets.length; i++) {
                var full = tempDir + '/' + targets[i];
                if (currentProject && _normFsPath(full) === currentProject) {
                    console.log('[Assets] 保留当前工程临时副本（AE 正打开）: ' + targets[i]);
                    continue;
                }
                var mt = mtimes[targets[i]];
                if (!(typeof mt === 'number' && mt > 0)) {
                    try {
                        if (typeof global.AEFS.stat === 'function') {
                            var stf = await global.AEFS.stat(full);
                            if (stf && typeof stf.mtimeMs === 'number') mt = stf.mtimeMs;
                        }
                    } catch (_) {}
                }
                if (!(typeof mt === 'number' && mt > 0) || mt >= cutoff) continue;
                try { await global.AEFS.deleteFile(full); cleaned++; } catch (_) {}
            }
            if (cleaned > 0) console.log('[Assets] 清理 temp 残留: ' + cleaned + ' 个导出临时 .aep');
        }
        function onCovered() {
            // 卡被盖住：如果正在编辑备注，主动 blur-save
            if (_editing) {
                var ta = pane.querySelector('.assets-proj-notes');
                if (ta) { var id = ta.getAttribute('data-id'); if (id) _saveNotes(id); }
                _editing = false;
            }
        }

        return { init: init, destroy: destroy, refresh: _refresh, pane: pane, onActive: onActive, onCovered: onCovered, checkGarbage: _checkGarbage };
    }

    global.AEAssetsShared.createProjectAssetView = createProjectAssetView;
})(window);
