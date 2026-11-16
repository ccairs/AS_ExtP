(function (global) {
    global.AEAssetsShared = global.AEAssetsShared || {};

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

    var IMPORT_WARN_COUNT = 100;   // 批量导入文件数超此值，先弹确认提示
    var NOTICE_THRESHOLD = 20;    // 预设批量操作超此数量才显示进度条（少量静默处理）
    // 索引字段 source.layerName 的「外部导入」标记：落盘值与界面语言无关，
    // 详情显示时再经 AEI18n.t 翻译（旧数据里已可能是英文，t() 未命中即原样返回）。
    var EXTERNAL_IMPORT_LAYER = '外部导入';

    // opts: { pane, store, dataDir, hostApi }
    function createPresetView(opts) {
        var pane = opts.pane;
        var store = opts.store;
        var hostApi = opts.hostApi;
        var dataDir = opts.dataDir || '';
        var _tv = null;
        var _destroyed = false;
        var _busy = false;
        var _editing = false;   // 备注编辑中（focusin 设 true，focusout 设 false）
        var _selectGen = 0;   // _onSelect 重入防护：每次选中自增，异步回调比对代龄丢弃过期者
        var _activeSavePathModalClose = null;   // 保存路径弹窗的关闭句柄（destroy 时关闭）

        // 复制文本到剪贴板（textarea + execCommand，CEF Chrome 88 可靠）
        // execCommand 未执行时返回 false 而不抛异常，按返回值判定结果
        function _copyToClipboard(text) {
            var ta = null;
            try {
                ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;left:-9999px;';
                document.body.appendChild(ta);
                ta.select();
                return document.execCommand('copy') === true;
            } catch (_) {
                return false;
            } finally {
                try { if (ta && ta.parentNode) document.body.removeChild(ta); } catch (_) {}
            }
        }

        // 弹窗图标（内联 SVG，描边用 currentColor）
        var _ICON_COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
        var _ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

        // 保存前目标目录确认弹窗：路径行 + 复制图标 + 取消/确认按钮。
        // global.showConfirm 的 message 只渲染纯文本，本弹窗需要路径行与按钮，故自建 .modal-mask 模态。
        // resolve(true) = 继续保存流程；resolve(false) = 取消本次保存（取消/Esc/点遮罩/视图卸载）。
        function _showSavePathModal(savePath) {
            return new Promise(function (resolve) {
                var doc = global.document;
                if (!doc || !doc.body) { resolve(true); return; }   // 无 DOM 的异常装载态不阻断保存
                var overlay = doc.createElement('div');
                overlay.className = 'modal-mask';
                overlay.style.display = 'flex';
                overlay.style.opacity = '1';
                overlay.style.zIndex = '101';
                var box = doc.createElement('div');
                box.className = 'modal confirm-modal assets-save-path-modal';
                box.style.opacity = '1';
                box.style.transform = 'none';
                box.innerHTML = ''
                    + AEI18n.html('<div class="modal-head"><span>保存预设 · 目标目录</span></div>')
                    + '<div class="modal-body">'
                    + AEI18n.html('<p class="assets-save-path-desc">AE 的保存对话框不会自动定位到素材库目录。可在对话框的「文件名」栏粘贴下面的路径并回车进入该目录，再输入文件名保存；否则预设不会出现在素材库。右侧按钮可复制该路径。</p>')
                    + '<div class="assets-save-path-row">'
                    + '<code class="assets-save-path">' + _esc(savePath) + '</code>'
                    + AEI18n.html('<button type="button" class="btn secondary assets-save-path-copy" data-act="copyPath" title="复制路径" aria-label="复制路径">') + _ICON_COPY + '</button>'
                    + '</div>'
                    + AEI18n.html('<div class="assets-save-path-tip" data-role="copyTip">可点右侧按钮复制路径</div>')
                    + '<div class="btn-row">'
                    + AEI18n.html('<button type="button" class="btn secondary" data-act="cancelSave">取消</button>')
                    + AEI18n.html('<button type="button" class="btn primary" data-act="confirmSave">打开保存对话框</button>')
                    + '</div>'
                    + '</div>';
                overlay.appendChild(box);

                var copyBtn = box.querySelector('[data-act="copyPath"]');
                var cancelBtn = box.querySelector('[data-act="cancelSave"]');
                var okBtn = box.querySelector('[data-act="confirmSave"]');
                var tipEl = box.querySelector('[data-role="copyTip"]');

                var settled = false;
                function close(ok) {
                    if (settled) return;
                    settled = true;
                    if (_activeSavePathModalClose === close) _activeSavePathModalClose = null;
                    try { doc.removeEventListener('keydown', onKey); } catch (_) {}
                    try { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); } catch (_) {}
                    resolve(!!ok);
                }
                _activeSavePathModalClose = close;   // 交给 destroy 关闭
                function onKey(e) {
                    if (!e) return;
                    // 只处理 Esc 关闭；Enter 不拦截，由按钮原生行为分发
                    if (e.key === 'Escape' || e.keyCode === 27) {
                        if (e.preventDefault) e.preventDefault();
                        close(false);
                    }
                }
                function _setTip(text, cls) {
                    if (!tipEl) return;
                    tipEl.textContent = text;
                    tipEl.className = 'assets-save-path-tip' + (cls ? ' ' + cls : '');
                }

                if (copyBtn) copyBtn.addEventListener('click', function () {
                    var ok = _copyToClipboard(savePath);
                    if (ok) {
                        copyBtn.innerHTML = _ICON_CHECK;
                        copyBtn.classList.add('is-copied');
                        copyBtn.title = AEI18n.t('已复制');
                        if (copyBtn.setAttribute) copyBtn.setAttribute('aria-label', AEI18n.t('已复制'));
                        _setTip(AEI18n.t('路径已复制，可在保存对话框的「文件名」栏粘贴。'), 'is-ok');
                    } else {
                        _setTip(AEI18n.t('复制失败，请手动选中路径或手动输入路径。'), 'is-warn');
                    }
                });
                if (cancelBtn) cancelBtn.addEventListener('click', function () { close(false); });
                if (okBtn) okBtn.addEventListener('click', function () { close(true); });
                overlay.addEventListener('click', function (e) { if (e && e.target === overlay) close(false); });
                doc.addEventListener('keydown', onKey);

                doc.body.appendChild(overlay);
                // 焦点落在确认按钮：复制为可选操作，弹窗的主动作是打开保存对话框
                try { if (okBtn && okBtn.focus) okBtn.focus(); } catch (_) {}
            });
        }

        pane.innerHTML = '';
        pane.classList.add('assets-pane');

        // toolbar
        var tb = document.createElement('div');
        tb.className = 'assets-toolbar';
        var btnSave = _mkBtn(AEI18n.t('保存预设'), 'primary');
        tb.appendChild(btnSave);
        var btnRefresh = _mkBtn('↻', 'secondary');
        btnRefresh.style.marginLeft = 'auto';
        btnRefresh.title = AEI18n.t('刷新（重新扫描磁盘）');
        tb.appendChild(btnRefresh);
        var btnArchive = _mkBtn(AEI18n.t('归档区'), 'secondary');
        btnArchive.title = AEI18n.t('查看归档区（7 天后自动清理，可恢复/立即清理）');
        btnArchive.addEventListener('click', function () { _openArchivePanel(); });
        var btnCleanMissing = _mkBtn(AEI18n.t('清理索引'), 'secondary');
        btnCleanMissing.title = AEI18n.t('清理丢失索引（.ffx 文件不存在但索引仍在的条目）');
        tb.appendChild(btnArchive);
        tb.appendChild(btnCleanMissing);
        pane.appendChild(tb);

        var dz = document.createElement('div');
        dz.className = 'assets-dropzone';
        pane.appendChild(dz);

        // 拖拽导入 .ffx
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
            _importFfxFiles(dt.files);
        };
        dz.addEventListener('dragover', _dzHandlers.dragover);
        dz.addEventListener('dragleave', _dzHandlers.dragleave);
        dz.addEventListener('drop', _dzHandlers.drop);

        var _fh = global.AEAssetsShared.createFolderViewHelpers({
            store: store,
            refresh: function () { _refresh(); },
            confirmMsg: {
                folderDeleteBody: function (fp) { return AEI18n.t('确定删除文件夹「{path}」？内含预设将被一并删除（含实体文件），不可恢复。', { path: fp }); }
            },
            renderItemContextmenu: function (item, x, y) {
                var count = _tv.getSelectedCount();
                var menu;
                if (count > 1) {
                    menu = [
                        { label: AEI18n.t('应用到选中图层 ({count})', { count: count }), action: 'batchApply' },
                        { label: AEI18n.t('归档选中 ({count})', { count: count }), action: 'batchDelete', danger: true }
                    ];
                } else {
                    menu = [
                        { label: AEI18n.t('应用到选中图层'), action: 'apply' },
                        { label: AEI18n.t('重命名'), action: 'rename' },
                        { label: AEI18n.t('打开所在位置'), action: 'openLocation' },
                        { label: AEI18n.t('归档'), action: 'delete', danger: true }
                    ];
                }
                global.AEAssetsShared.showAssetsMenu(x, y, menu, function (act) {
                    if (act === 'batchDelete') _batchDelete();
                    else if (act === 'batchApply') _batchApply();
                    else if (act === 'apply') _apply(item.id);
                    else if (act === 'rename') _tv.beginRename(item.id);
                    else if (act === 'openLocation') _openLocation(item.id);
                    else if (act === 'delete') _delete(item.id);
                });
            }
        });
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
            itemLabel: function (it) { return it.name + '.ffx'; },
            itemIcon: function () { return '✨'; },
            // 网格模式缩略图：条目有预览帧才出图，否则返回 null → 网格回落 itemIcon（✨）
            itemThumb: function (it) {
                var u = global.AEAssetsShared.previewUrlFor(dataDir, 'presets', it._raw || it);
                return u ? { url: u } : null;
            },
            renderDetail: function (it) { return _renderDetail(it); },
            isEditing: function () { return !!_editing || !!(_tv && _tv.isEditing && _tv.isEditing()); },
            nameForEdit: function (it) { return (it._raw || it).name || ''; },
            onRename: function (id, newBaseName) {
                // 条目本身是链接时先显式提示（重命名作用于真实目标、留悬挂链接）；
                // 用户取消 → 什么都不做（静默退出行内编辑，不报错）
                var _rit = store.list().filter(function (x) { return x.id === id; })[0];
                var _rents = (_rit && _rit.ffxPath) ? [{ path: _rit.ffxPath, label: _rit.name }] : [];
                return _fh._withLinkGuard(_rents, function () {
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
                // createFolder 失败返回 false（非 reject），须检查 ok 防 mkdir 失败静默"成功"
                return store.createFolder(fullPath).then(function (ok) {
                    if (!ok) {
                        if (global.AEToast) AEToast.error(AEI18n.t('创建文件夹失败'));
                        return;
                    }
                    _refresh();
                }).catch(function (e) {
                    if (global.AEToast) AEToast.error(AEI18n.t('创建文件夹失败: ') + (e && e.message ? e.message : e));
                });
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
            // 大图标模式双击预览图 = 格子右上角 ↗ 同一个动作（应用预设到选中图层）。
            // 走 _handleDetailAction 而不是另调 _apply：act 字面量与 rowActions 同源，
            // 日后改动作只改一处。
            onPreviewActivate: function (it) { _handleDetailAction('apply', it.id); },
            previewActionLabel: AEI18n.t('应用'),
            rowActions: function (it) { return '<span class="assets-row-act" data-act="apply" data-id="' + _esc(it.id) + '" title="' + _esc(AEI18n.t('应用到选中图层')) + '">↗</span>'; }
        });

        if (_fh.setInlineCallbacks) _fh.setInlineCallbacks(_tv.beginNewItem, _tv.beginRenameFolder);
        if (_fh.setTreeView) _fh.setTreeView(_tv);

        // 事件委托：focus/blur on textarea/input（委托 pane，innerHTML 重建不丢监听）
        pane.addEventListener('focusin', function (e) {
            var t = e.target;
            if (t && t.classList.contains('assets-presets-notes')) _editing = true;
        });
        pane.addEventListener('focusout', function (e) {
            var t = e.target;
            if (!t || !t.classList.contains('assets-presets-notes')) return;
            _editing = false;
            // 失焦保存：从 data-id 取 id（不读 _tv.getSelected()，防竞态）
            var id = t.getAttribute('data-id');
            if (!id) return;
            _saveNotes(id);
        });

        btnSave.addEventListener('click', function () { _savePreset(); });
        btnRefresh.addEventListener('click', _reload);
        btnCleanMissing.addEventListener('click', _cleanMissing);

        function _mkBtn(text, type) {
            var b = document.createElement('button');
            b.className = 'btn btn-slice ' + (type || 'secondary');
            b.textContent = text;
            return b;
        }

        // 宿主消息本地化：host/api/*.jsx 的 throw/status.message 是中文源文，
        // 上屏前经 AEHostErrors 映射成词典 key（未命中原样返回，见 shared/i18n/hostErrors.js）。
        function _hostMsg(v) {
            return (global.AEHostErrors && typeof global.AEHostErrors.localize === 'function')
                ? global.AEHostErrors.localize(v)
                : String(v == null ? '' : v);
        }

        // ── hostApi.call 包装（大超时：executeCommand(3075) 阻塞至对话框关闭）──
        function _call(script, timeoutMs) {
            if (!hostApi) return Promise.reject(new Error(AEI18n.t('ExtendScript 桥未就绪')));
            return hostApi.call(script, timeoutMs || 60000).then(function (resp) {
                if (!resp || resp.ok === false) throw new Error(AEI18n.t('ExtendScript 调用失败: ') + (resp && resp.error ? _hostMsg(resp.error) : ''));
                var r = resp.result;
                if (typeof r === 'string') {
                    // 空串 = jsx 抛未捕获异常（常见于干净 AE 缺 JSON polyfill，createHandler 的 catch 里 JSON.stringify 也抛）→ evalScript 返回空。
                    // "EvalScript error." = 同上。二者都不能当成功，否则 _apply 会 toast 假成功。
                    if (!r) throw new Error(AEI18n.t('ExtendScript 返回空（脚本未执行或 JSON polyfill 缺失）'));
                    if (/^(ERROR|Error):/.test(r)) throw new Error(r);
                    if (r === 'EvalScript error.') throw new Error(AEI18n.t('ExtendScript 执行异常'));
                    try { r = JSON.parse(r); }
                    catch (_) { throw new Error(AEI18n.t('ExtendScript 返回非 JSON: ') + r.substring(0, 200)); }
                }
                if (r && r.status === 'error') throw new Error(_hostMsg(r.message) || AEI18n.t('AE 错误'));
                return r;
            });
        }

        // ── 保存预设 ──
        async function _savePreset() {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            try {
            // 1. 取选中信息（校验有选中 + 记标志位）
            var info;
            try {
                info = await _call('getSelectionInfo({})', 10000);
            } catch (e) {
                if (global.AEToast) AEToast.error(AEI18n.t('取选中信息失败: ') + (e.message || e));
                return;
            }
            if (!info || !info.propertyPath) {
                if (global.AEToast) AEToast.warn(AEI18n.t('请先在 AE 中选中属性或效果'));
                return;
            }

            // 2. 确保 presets 目录存在，扫描已有 .ffx
            var baseDir = _buildPath(dataDir, 'assets', 'presets');
            var mkOk = await global.AEFS.mkdir(baseDir);
            if (mkOk !== true) {
                if (global.AEToast) AEToast.error(AEI18n.t('无法创建目录: ') + baseDir);
                return;
            }
            var before = await _listFfxRecursive(baseDir);

            // 3. 弹窗告知目标目录；用户确认后打开 AE 原生保存对话框，取消则结束本次保存
            var hintPath = baseDir.replace(/\\/g, '/');
            var proceed = await _showSavePathModal(hintPath);
            if (!proceed) {
                if (global.AEToast) AEToast.info(AEI18n.t('已取消保存预设'));
                return;
            }
            // 弹窗期间 AE 仍可交互：确认后重取选中信息，元数据以保存时的选区为准
            try {
                var infoNow = await _call('getSelectionInfo({})', 10000);
                if (!infoNow || !infoNow.propertyPath) {
                    if (global.AEToast) AEToast.warn(AEI18n.t('请先在 AE 中选中属性或效果'));
                    return;
                }
                info = infoNow;
            } catch (e) {
                if (global.AEToast) AEToast.error(AEI18n.t('取选中信息失败: ') + (e.message || e));
                return;
            }
            try {
                await _call('savePresetViaMenu({})', 120000);
            } catch (e) {
                if (global.AEToast) AEToast.error(AEI18n.t('保存失败: ') + (e.message || e));
                return;
            }

            // 4. 扫描新增 .ffx
            var after = await _listFfxRecursive(baseDir);
            var newFiles = [];
            for (var j = 0; j < after.length; j++) {
                if (before.indexOf(after[j]) === -1) newFiles.push(after[j]);
            }
            if (!newFiles.length) {
                _copyToClipboard(baseDir.replace(/\\/g, '/'));
                if (global.AEToast) AEToast.warn(AEI18n.t('未检测到新预设文件'));
                return;
            }

            // 5. 预览帧：抓当前合成一帧、缩成小图备用。放在 addMeta 之前——此刻合成仍是用户
            //    保存时那一个（AE 原生保存对话框不改合成状态），且帧随条目一次写入，不产生
            //    第二次索引写；同一张图应用到本批全部新条目。
            //    抓帧失败不阻断保存：previewSource 保持 null，条目照常入库（无 previewFrame）。
            var previewSource = null;
            try {
                var pvNotice = global.AENotice ? global.AENotice.show({
                    id: 'assets-preset-preview',
                    title: AEI18n.t('生成预览'),
                    message: AEI18n.t('正在截取当前合成画面…'),
                    tone: 'info',
                    dismissible: false
                }) : null;
                try {
                    var frame = await global.AEAssetsShared.captureCurrentFrame();
                    if (frame) previewSource = await global.AEAssetsShared.preparePreviewFrame(frame);
                } finally {
                    if (pvNotice) pvNotice.close();
                }
            } catch (e) {
                console.warn('[Assets] 预设预览抓帧失败: ' + (e && e.message ? e.message : e));
            }

            // 6. 逐个注册到 index.json
            var count = 0;
            for (var k = 0; k < newFiles.length; k++) {
                var relPath = String(newFiles[k]).replace(/\\/g, '/');
                var ffxPath = baseDir + '/' + relPath;
                // newFiles[k] 可能是 'sub/foo.ffx'（用户在子目录保存），需拆出 folder 与 baseName
                var slashIdx = relPath.lastIndexOf('/');
                var relFolder = slashIdx >= 0 ? relPath.slice(0, slashIdx) : '';
                var ffxName = slashIdx >= 0 ? relPath.slice(slashIdx + 1) : relPath;
                var presetName = global.AEAssetsShared.presetBaseName
                    ? global.AEAssetsShared.presetBaseName(ffxName)
                    : ffxName.replace(/\.ffx$/i, '');
                var ffxSize = 0;
                try {
                    var blobResult = await global.AEFS.readBlob(ffxPath);
                    if (blobResult && blobResult.success) ffxSize = blobResult.size || 0;
                } catch (_) {}

                try {
                    await store.addMeta({
                        name: presetName,
                        folder: relFolder,
                        ffxPath: ffxPath,
                        source: {
                            layerName: (info.layers ? info.layers.map(function (l) { return l.name; }).join(', ') : ''),
                            propertyPath: info.propertyPath || ''
                        },
                        hasKeyframes: !!info.hasKeyframes,
                        hasExpressions: !!info.hasExpressions,
                        hasEffects: !!info.hasEffects,
                        size: ffxSize,
                        // 预览帧（面板侧已缩好的小图，按条目 id 落盘；null = 本次抓帧失败/无合成）
                        previewSource: previewSource
                    });
                    count++;
                } catch (e) {
                    console.warn('[Assets] addMeta 失败: ' + ffxPath + ' ' + (e.message || e));
                }
            }

            if (count > 0) {
                _refresh();
                if (global.AEToast) AEToast.success(AEI18n.t('已保存 ') + count + AEI18n.t(' 个预设'));
            } else {
                // addMeta 全部失败（newFiles 非空但 count=0）：不提示会让用户误以为保存成功
                if (global.AEToast) AEToast.error(AEI18n.t('预设文件已保存，但 ') + newFiles.length + AEI18n.t(' 个索引注册失败'));
            }
            } finally {
                _busy = false;
            }
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
        async function _scanTargetDir(dirPath, out) {
            var list = await global.AEFS.listFiles(dirPath);
            if (Array.isArray(list)) {
                for (var l = 0; l < list.length; l++) {
                    out.push({ name: list[l], path: dirPath + '/' + list[l] });
                }
            }
            var subDirs = await global.AEFS.listDirs(dirPath);
            if (Array.isArray(subDirs)) {
                for (var d = 0; d < subDirs.length; d++) {
                    await _scanTargetDir(dirPath + '/' + subDirs[d], out);
                }
            }
        }

        // ── 递归收集源目录中的 .ffx 文件（仅 .ffx，跳过其他干扰文件）──
        async function _collectFfxFromDir(dirPath, relativePath, out, isCancelled) {
            // 扫描阶段取消检查：入口即止，递归调用自然短路
            if (isCancelled && isCancelled()) return;
            var files = [];
            try { files = await global.AEFS.listFilesAsync(dirPath); } catch (_) {}
            if (Array.isArray(files)) {
                for (var i = 0; i < files.length; i++) {
                    if (/\.ffx$/i.test(files[i])) {
                        out.push({
                            name: files[i],
                            srcPath: dirPath + '/' + files[i],
                            relFolder: relativePath || ''
                        });
                    }
                }
            }
            var subDirs = [];
            try { subDirs = await global.AEFS.listDirsAsync(dirPath); } catch (_) {}
            if (Array.isArray(subDirs)) {
                for (var d = 0; d < subDirs.length; d++) {
                    var subRel = relativePath ? (relativePath + '/' + subDirs[d]) : subDirs[d];
                    await _collectFfxFromDir(dirPath + '/' + subDirs[d], subRel, out, isCancelled);
                }
            }
        }

        // ── 拖入导入 .ffx 文件 ──
        async function _importFfxFiles(files) {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            var total = files.length;
            var okCount = 0, failCount = 0;
            var cancelled = false;
            var notice = (total > NOTICE_THRESHOLD) && global.AENotice ? global.AENotice.show({
                id: 'assets-preset-import',
                title: AEI18n.t('导入预设'),
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
            // 强制让出主线程一次，浏览器先重绘出 notice，再进入后续扫描。
            // （AEFS 的 isFile 等为“同步 XHR + Promise.resolve”假异步，await 不产生 macrotask，
            //   若不主动让出，notice 会被后续假异步占满主线程而迟迟不显示）
            await new Promise(function (r) { setTimeout(r, 0); });

            // CEF 拖文件夹：dt.files 只有 1 条（文件夹本身）
            // 仅复制 .ffx 文件并保留文件夹层级，其他干扰文件不复制
            // 注意：AEFS.listFiles 对普通文件路径也返回 []（服务端 readdirSync 抛 ENOTDIR 后兜底），
            // 必须先用 isFile 排除普通文件，否则单文件拖入会被误判为空文件夹。
            if (files.length === 1 && files[0].path) {
                var maybeDir = String(files[0].path || '').replace(/\\/g, '/');
                // 文件夹模式标志——进入文件夹导入分支后置位，中途异常据此直接
                // 收尾汇报而非吞错跌落多文件模式（同一文件夹被当普通文件全数跳过）
                var inFolderMode = false;
                try {
                    var isSingleFile = await global.AEFS.isFile(maybeDir);
                    var testList = (isSingleFile === true) ? null : await global.AEFS.listFilesAsync(maybeDir);
                    if (Array.isArray(testList)) {
                        inFolderMode = true;
                        var srcDir = maybeDir;
                        var dirName = srcDir.replace(/\/+$/, '').split('/').pop();
                        var nameBad = global.AEAssetsShared.invalidNameSeg(dirName, true);
                        if (nameBad) { _busy = false; if (notice) notice.close(); if (global.AEToast) AEToast.warn(nameBad); return; }
                        var dstDir = _buildPath(dataDir, 'assets', 'presets', dirName);
                        // 先探测是否已存在——mkdir 对已存在目录同样返回 true，不区分会在
                        // 取消清理时误删用户已有的同名空目录
                        var dstExisted = false;
                        try { dstExisted = (await global.AEFS.existsAsync(dstDir)) === true; } catch (_) {}
                        var mkOk = await global.AEFS.mkdir(dstDir);
                        if (mkOk !== true) { _busy = false; if (notice) notice.close(); if (global.AEToast) AEToast.error(AEI18n.t('无法创建目录')); return; }
                        // 取消/异常收尾只清理本次新建且仍为空的 dstDir（rmdir 拒绝非空，
                        // 已导入部分文件的目录自然保留），防幽灵空目录被下次 load 收进 _emptyDirs
                        var _cleanupDstDir = async function () {
                            if (dstExisted) return;
                            try { await global.AEFS.rmdir(dstDir); } catch (_) {}
                        };
                        // 递归收集源目录中的 .ffx 文件（仅 .ffx，不复制其他干扰文件）
                        // 文件夹模式：files.length 恒为 1，无法在顶部按数量判断；
                        // 扫描本身可能是最耗时的阶段，先展示进度，扫描后再按实际数量决定是否关闭。
                        if (notice == null && global.AENotice) {
                            notice = global.AENotice.show({
                                id: 'assets-preset-import',
                                title: AEI18n.t('导入预设'),
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
                        var ffxFiles = [];
                        await _collectFfxFromDir(srcDir, '', ffxFiles, function () { return cancelled; });
                        // 扫描阶段已取消：提前收尾，不再走空检查/确认弹窗/导入循环
                        if (cancelled) {
                            await _cleanupDstDir();   // 清理本次新建的空 dstDir，防幽灵目录残留
                            _busy = false; if (notice) notice.close(); notice = null;
                            if (global.AEToast) AEToast.info(AEI18n.t('已取消'));
                            return;
                        }
                        if (ffxFiles.length === 0) {
                            await _cleanupDstDir();   // 无文件导入，清理本次新建的空 dstDir
                            _busy = false; if (notice) notice.close(); notice = null; _refresh();
                            if (global.AEToast) AEToast.warn(AEI18n.t('未找到 .ffx 文件'));
                            return;
                        }
                        // 扫描完成后：实际文件数未超阈值则静默（关闭扫描进度条）
                        if (ffxFiles.length <= NOTICE_THRESHOLD && notice) {
                            notice.close();
                            notice = null;
                        }
                        // 批量导入确认：文件数超阈值先征询
                        if (ffxFiles.length > IMPORT_WARN_COUNT) {
                            var goFolder = await global.showConfirm(AEI18n.t('批量导入确认'), AEI18n.t('即将导入 ') + ffxFiles.length + AEI18n.t(' 个 .ffx 预设，可能需要较长时间，是否继续？'), 'confirm');
                            if (!goFolder) { await _cleanupDstDir(); _busy = false; if (notice) notice.close(); _refresh(); return; }   // 放弃导入，清理空 dstDir
                        }
                        var pendingMetas = [];   // 已拷贝成功、待批量写入索引的条目
                        for (var si = 0; si < ffxFiles.length; si++) {
                            if (cancelled) break;
                            var ffxItem = ffxFiles[si];
                            // 创建子文件夹（保留文件夹层级）
                            if (ffxItem.relFolder) {
                                try { await global.AEFS.mkdir(_buildPath(dstDir, ffxItem.relFolder)); } catch (_) {}
                            }
                            var dstFfxPath = ffxItem.relFolder
                                ? (dstDir + '/' + ffxItem.relFolder + '/' + ffxItem.name)
                                : (dstDir + '/' + ffxItem.name);
                            var pname = global.AEAssetsShared.presetBaseName
                                ? global.AEAssetsShared.presetBaseName(ffxItem.name)
                                : ffxItem.name.replace(/\.ffx$/i, '');
                            // 校验先于复制（对齐多文件模式）：校验失败不落盘，避免孤儿 .ffx 被 _discoverOrphans 自动入库
                            var nameBad2 = global.AEAssetsShared.invalidNameSeg(pname);
                            if (nameBad2) { failCount++; continue; }
                            var cpOk = await global.AEFS.copyFileAsync(ffxItem.srcPath, dstFfxPath);
                            if (!cpOk) { failCount++; continue; }
                            var ffxSize = 0;
                            try {
                                var blobResult = await global.AEFS.readBlob(dstFfxPath);
                                if (blobResult && blobResult.success) ffxSize = blobResult.size || 0;
                            } catch (_) {}
                            pendingMetas.push({
                                name: pname, folder: '', ffxPath: dstFfxPath,
                                source: { layerName: EXTERNAL_IMPORT_LAYER, propertyPath: '' },
                                hasKeyframes: false, hasExpressions: false, hasEffects: false,
                                size: ffxSize
                            });
                            var doneFfx = pendingMetas.length + failCount;
                            if (notice && global.AENotice) {
                                global.AENotice.update('assets-preset-import', {
                                    message: AEI18n.t('正在导入… {done}/{total}', { done: doneFfx, total: ffxFiles.length }),
                                    progress: Math.round(doneFfx / ffxFiles.length * 100),
                                    progressLabel: doneFfx + '/' + ffxFiles.length
                                });
                            }
                            // 让出主线程给浏览器处理取消点击（sync Bridge copyFile 阻塞无 macrotask 间隙）
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
                        _busy = false;
                        if (notice) notice.close();
                        _refresh();
                        if (cancelled) {
                            if (global.AEToast) AEToast.info(AEI18n.t('已取消（已导入 ') + okCount + AEI18n.t(' 个）'));
                        } else if (okCount > 0) {
                            if (global.AEToast) AEToast.success(AEI18n.t('已导入 ') + okCount + AEI18n.t(' 个预设'));
                        } else if (failCount > 0) {
                            // 全部复制失败须如实报错（对齐本函数多文件模式的 failCount 分支）：
                            // 否则会误报"未导入任何 .ffx 文件"（暗示没扫描到文件，而非复制失败）
                            if (global.AEToast) AEToast.warn(AEI18n.t('导入失败: ') + failCount + '/' + ffxFiles.length);
                        } else {
                            if (global.AEToast) AEToast.warn(AEI18n.t('未导入任何 .ffx 文件'));
                        }
                        return;
                    }
                } catch (e) {
                    // 异常路径同样清理本次新建且仍为空的 dstDir（var 已提升，
                    // 未执行到赋值点（如 isFile 抛错）时为 undefined，守卫跳过）
                    if (_cleanupDstDir) _cleanupDstDir();
                    // 文件夹模式执行中的异常直接进收尾汇报——吞错后跌落多文件
                    // 模式会把同一文件夹当普通文件按 .ffx 过滤全数跳过，误报「未导入任何
                    // .ffx 文件」（索引写入失败等真实错误被掩盖）；探测阶段异常（inFolderMode
                    // 未置位）维持跌落多文件模式（原设计：单文件导入走多文件路径兜底）
                    if (inFolderMode) {
                        _busy = false;
                        if (notice) { notice.close(); notice = null; }
                        _refresh();
                        if (global.AEToast) AEToast.error(AEI18n.t('导入文件夹失败: ') + (e && e.message ? e.message : e));
                        return;
                    }
                }
            }

            try {
                var baseDir = _buildPath(dataDir, 'assets', 'presets');
                // 批量导入确认：文件数超阈值先征询
                if (files.length > IMPORT_WARN_COUNT) {
                    var goMulti = await global.showConfirm(AEI18n.t('批量导入确认'), AEI18n.t('即将导入 ') + files.length + AEI18n.t(' 个 .ffx 预设，可能需要较长时间，是否继续？'), 'confirm');
                    if (!goMulti) return;   // 外层 finally 复位 _busy 并关闭 notice
                }
                var mkOk = await global.AEFS.mkdir(baseDir);
                if (mkOk !== true) { _busy = false; if (notice) notice.close(); if (global.AEToast) AEToast.error(AEI18n.t('无法创建预设目录')); return; }
                var map = global.AEAssetsShared.deriveFolderMap(files);
                var pendingMetas2 = [];   // 已拷贝成功、待批量写入索引的条目
                var skipCount = 0;        // 非 .ffx 文件（不复制、不索引）
                for (var i = 0; i < files.length; i++) {
                    if (cancelled) break;
                    var file = files[i];
                    // 仅收 .ffx（与单文件夹模式 _collectFfxFromDir 的过滤一致），
                    // 防止拖入的任意文件混进预设库污染索引
                    if (!/\.ffx$/i.test(file.name)) { skipCount++; continue; }
                    var path = file.path;
                    var name = global.AEAssetsShared.presetBaseName
                        ? global.AEAssetsShared.presetBaseName(file.name)
                        : file.name.replace(/\.ffx$/i, '');
                    var nameBad = global.AEAssetsShared.invalidNameSeg(name);
                    if (nameBad) { failCount++; if (global.AEToast) AEToast.warn(nameBad + ': ' + file.name); continue; }
                    // 跨目录多选时 fileFolders 是相对子目录：文件按层级落盘（presetStore 为物理目录），
                    // 不能只拷到根——否则索引 folder 与磁盘位置脱节、留下预建的空目录
                    var relFolder = map.fileFolders[i] || '';
                    if (relFolder) {
                        var fBad = global.AEAssetsShared.invalidFolderPath(relFolder);
                        if (fBad) { failCount++; if (global.AEToast) AEToast.warn(fBad + ': ' + relFolder); continue; }
                        var subMkOk = await global.AEFS.mkdir(baseDir + '/' + relFolder);
                        if (subMkOk !== true) { failCount++; continue; }
                    }
                    var dstPath = relFolder ? (baseDir + '/' + relFolder + '/' + file.name) : (baseDir + '/' + file.name);
                    var cpOk;
                    if (path) {
                        cpOk = await global.AEFS.copyFileAsync(path, dstPath);
                    } else {
                        cpOk = await _copyViaBlob(file, dstPath);
                    }
                    if (!cpOk) { failCount++; continue; }
                    var ffxSize = 0;
                    try {
                        var blobResult = await global.AEFS.readBlob(dstPath);
                        if (blobResult && blobResult.success) ffxSize = blobResult.size || 0;
                    } catch (_) {}
                    pendingMetas2.push({
                        name: name, folder: relFolder, ffxPath: dstPath,
                        source: { layerName: EXTERNAL_IMPORT_LAYER, propertyPath: '' },
                        hasKeyframes: false, hasExpressions: false, hasEffects: false,
                        size: ffxSize
                    });
                    var done = pendingMetas2.length + failCount + skipCount;
                    if (notice && global.AENotice) {
                        global.AENotice.update('assets-preset-import', {
                            message: AEI18n.t('正在导入… {done}/{total}', { done: done, total: total }),
                            progress: Math.round(done / total * 100),
                            progressLabel: done + '/' + total
                        });
                    }
                    await new Promise(function (r) { setTimeout(r, 5); });
                }
                // 批量落盘：一次 flush 替代逐条 addMeta 的 N 次全量重写
                if (pendingMetas2.length) {
                    try {
                        await store.addMetaBatch(pendingMetas2);
                        okCount = pendingMetas2.length;
                    } catch (e) {
                        console.warn('[Assets] 批量写索引失败: ' + (e && e.message ? e.message : e));
                        failCount += pendingMetas2.length;
                    }
                }
            } finally {
                _busy = false;
                if (notice) notice.close();
                notice = null;
            }
            _refresh();
            if (cancelled) {
                var msg = AEI18n.t('已取消（已导入 {n} 个）', { n: okCount });
                if (failCount > 0) msg += AEI18n.t('，{n} 失败', { n: failCount });
                if (global.AEToast) AEToast.info(msg);
            } else if (okCount > 0) {
                var msg2 = AEI18n.t('已导入 {n} 个预设', { n: okCount });
                if (skipCount > 0) msg2 += AEI18n.t('，跳过 {n} 个非 .ffx 文件', { n: skipCount });
                if (global.AEToast) AEToast.success(msg2);
            } else if (failCount > 0) {
                if (global.AEToast) AEToast.warn(AEI18n.t('导入失败: ') + failCount + '/' + total);
            } else if (skipCount > 0) {
                if (global.AEToast) AEToast.warn(AEI18n.t('未导入任何 .ffx 文件（跳过 ') + skipCount + AEI18n.t(' 个非 .ffx 文件）'));
            } else {
                if (global.AEToast) AEToast.warn(AEI18n.t('未导入任何文件'));
            }
        }

        // 递归列出目录下所有 .ffx 文件名（仅文件名，非全路径）
        async function _listFfxRecursive(dir) {
            var result = [];
            try {
                var files = await global.AEFS.listFiles(dir);
                for (var i = 0; i < files.length; i++) {
                    if (/\.ffx$/i.test(files[i])) result.push(files[i]);
                }
                var subdirs = await global.AEFS.listDirs(dir);
                for (var d = 0; d < subdirs.length; d++) {
                    var sub = await _listFfxRecursive(dir + '/' + subdirs[d]);
                    for (var s = 0; s < sub.length; s++) {
                        result.push(subdirs[d] + '/' + sub[s]);
                    }
                }
            } catch (_) {}
            return result;
        }

        // ── 应用预设到当前选中图层（无确认弹窗，包 undoGroup）──
        async function _apply(id) {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            try {
            var it = store.list().filter(function (x) { return x.id === id; })[0];
            if (!it) return;
            // 校验 .ffx 存在
            var exists = await global.AEFS.exists(it.ffxPath);
            if (exists === false) {
                if (global.AEToast) AEToast.error(AEI18n.t('预设文件已丢失: ') + it.ffxPath);
                return;
            }
            var notice = _showProgress(AEI18n.t('正在应用预设: {name} …', { name: it.name }));
            try {
                // 复用素材库共享应用函数，避免各处重写 ExtendScript 调用导致漏改；
                // onLayerProgress 按块边界回调（分块异步应用），多图层时更新进度
                var r = await global.AEAssetsShared.applyPresetToAE(hostApi, it.ffxPath, it.name, {
                    onLayerProgress: function (done, total) {
                        if (!global.AENotice || total <= 1) return;
                        global.AENotice.update('assets-preset-op', {
                            message: AEI18n.t('正在应用预设: {name}（图层 {done}/{total}）…', { name: it.name, done: done, total: total }),
                            progress: Math.round(done / total * 100)
                        });
                    }
                });
                if (r && r.failed > 0) {
                    var errs = (r.errors || []).slice(0, 3).join('; ');
                    if (global.AENotice) AENotice.show({
                        id: 'assets-preset-apply', title: AEI18n.t('应用预设部分失败'),
                        message: AEI18n.t('成功 {applied} / 失败 {failed}。{errors}', { applied: r.applied, failed: r.failed, errors: errs }),
                        tone: 'warn', dismissible: true
                    });
                } else {
                    if (global.AEToast) AEToast.success(AEI18n.t('已应用到 ') + (r && r.applied ? r.applied : 0) + AEI18n.t(' 个图层'));
                }
            } catch (e) {
                if (global.AEToast) AEToast.error(AEI18n.t('应用失败: ') + (e.message || e));
            } finally {
                if (notice) notice.close();
            }
            } finally {
                _busy = false;
            }
        }

        // ── 批量应用选中预设到当前选中图层（串行叠加，顺序=选中先后）──
        // 每个预设独立 undo group（小批量各自一次撤回，分块按块撤回）；
        // 单个失败继续下一个，结束汇总。执行期间 _busy 锁防并发。
        async function _batchApply() {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            var selIds = _tv.getSelectedIds() || [];   // 已按选中先后排序
            if (selIds.length === 0) return;
            var byId = {};
            var all = store.list();
            for (var d = 0; d < all.length; d++) byId[all[d].id] = all[d];
            var items = [];
            for (var e = 0; e < selIds.length; e++) {
                if (byId[selIds[e]]) items.push(byId[selIds[e]]);
            }
            if (items.length === 0) return;
            _busy = true;
            var ok = 0, fail = 0, layers = 0;
            var firstErr = '';
            var notice = _showProgress(AEI18n.t('正在应用预设 ({done}/{total}) …', { done: 0, total: items.length }));
            async function applyOne(it, idx) {
                if (global.AENotice) global.AENotice.update('assets-preset-op', {
                    message: AEI18n.t('正在应用预设 ({done}/{total}): {name} …', { done: idx + 1, total: items.length, name: it.name }),
                    progress: Math.round(idx / items.length * 100)
                });
                var r = await global.AEAssetsShared.applyPresetToAE(hostApi, it.ffxPath, it.name, {
                    onLayerProgress: function (done, total) {
                        if (!global.AENotice || total <= 1) return;
                        global.AENotice.update('assets-preset-op', {
                            message: AEI18n.t('正在应用预设 ({done}/{total}): {name}（图层 {layer}/{layers}）…',
                                { done: idx + 1, total: items.length, name: it.name, layer: done, layers: total })
                        });
                    }
                });
                // 块级失败不打 reject：applyPresetToAE 对整块 error 会 resolve {applied,failed,errors}
                // （见 assets/index.js 的 stepChunk）。无条件 ok++ 会把整块失败粉饰成成功，
                // 最终 fail===0 弹绿色「已应用 N 个预设到 0 个图层」。分档对齐兄弟位
                // quickBarExecutor._applyOnePreset：failed>0 计入失败并汇总首错，否则才算成功
                layers += (r && r.applied) || 0;
                if (r && r.failed > 0) {
                    fail++;
                    if (!firstErr) {
                        var errs = (r.errors || []).slice(0, 3).map(_hostMsg).join('; ');
                        firstErr = (it.name || '') + ': ' + AEI18n.t('{n} 个图层失败', { n: r.failed }) + (errs ? ' (' + errs + ')' : '');
                    }
                } else {
                    ok++;
                }
            }
            try {
                for (var i = 0; i < items.length; i++) {
                    try { await applyOne(items[i], i); }
                    catch (e) {
                        fail++;
                        if (!firstErr) firstErr = (items[i].name || '') + ': ' + _hostMsg(e && e.message ? e.message : e);
                    }
                }
            } finally {
                _busy = false;
                if (notice) notice.close();
            }
            if (fail === 0) {
                if (global.AEToast) AEToast.success(AEI18n.t('已应用 ') + items.length + AEI18n.t(' 个预设到 ') + layers + AEI18n.t(' 个图层'));
            } else if (ok === 0) {
                if (global.AEToast) AEToast.error(AEI18n.t('批量应用失败: ') + firstErr);
            } else {
                if (global.AENotice) AENotice.show({
                    id: 'assets-preset-batch', title: AEI18n.t('批量应用部分失败'),
                    message: AEI18n.t('成功 {applied} / 失败 {failed}。{errors}', { applied: ok, failed: fail, errors: firstErr }),
                    tone: 'warn', dismissible: true
                });
            }
        }

        // ── 辅助：路径拼接（拒 .. 段防穿越）──
        function _buildPath() {
            var segs = [];
            for (var i = 0; i < arguments.length; i++) {
                var s = String(arguments[i] || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                // 仅拒精确 '..' / '.' 段防穿越（与 projectAssetView._buildPath / AEFS._checkPath 一致），
                // 放过含 .. 子串的合法名（如 foo..bar）
                if (s && s !== '..' && s !== '.') segs.push(s);
            }
            return segs.join('/');
        }

        function _showProgress(msg) {
            if (global.AENotice) return global.AENotice.show({
                id: 'assets-preset-op', title: AEI18n.t('预设'), message: msg, tone: 'info', dismissible: false
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
            global.AEFS.exists(it.ffxPath).then(function (ok) {
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
                        if (_editing) { _tv.renderList(store.list().map(function (x) { return { id: x.id, name: x.name, folder: x.folder, _raw: x }; })); }
                        else { _refresh(); _tv.select(id); }
                    });
                } else if (ok === true && it.missing) {
                    return store.setMissing(id, false).then(function () {
                        if (_destroyed || gen !== _selectGen) return;
                        // 同上——行内重命名进行中不重渲染
                        if (_tv && _tv.isEditing && _tv.isEditing()) return;
                        if (_editing) { _tv.renderList(store.list().map(function (x) { return { id: x.id, name: x.name, folder: x.folder, _raw: x }; })); }
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
            var flagsHtml = '';
            if (r.hasKeyframes || r.hasExpressions || r.hasEffects) {
                flagsHtml = '<div class="assets-presets-flags">' +
                    (r.hasKeyframes ? '<span class="assets-badge on">KF</span>' : '') +
                    (r.hasExpressions ? '<span class="assets-badge on">EXP</span>' : '') +
                    (r.hasEffects ? '<span class="assets-badge on">FX</span>' : '') +
                    '</div>';
            }
            // 预览区：有条目预览帧时出图（.has-img 隐藏图标块），加载失败由 img 的 onerror
            // 摘掉 has-img → 图标块露出来（回落不需要 JS 分支）
            var pvUrl = global.AEAssetsShared.previewUrlFor(dataDir, 'presets', r);
            var pvSub = _fmtSize(r.size) + (pvUrl ? AEI18n.t(' · 预览取自 {sec}s', { sec: _fmtSec(r.previewFrame.time) }) : '');
            // 索引里的「外部导入」是标记（固定源文），显示时按当前语言翻译；真实图层名按原值显示。
            var srcLayer = (r.source && r.source.layerName) || '-';
            var srcLayerLabel = srcLayer === EXTERNAL_IMPORT_LAYER ? AEI18n.t('外部导入') : srcLayer;
            var pvImg = pvUrl
                ? '<img class="assets-detail-preview-img" src="' + _esc(pvUrl) + '" alt=""'
                    + ' onerror="this.parentNode.classList.remove(\'has-img\')">'
                : '';
            return '<div class="assets-detail">'
                // 预览区
                + '<div class="assets-detail-preview' + (pvUrl ? ' has-img' : '') + '">'
                + '<div class="assets-detail-preview-icon">✨</div>'
                + pvImg
                + '<div class="assets-detail-preview-name">' + _esc(r.name) + '.ffx</div>'
                + '<div class="assets-detail-preview-sub">' + pvSub + '</div>'
                + flagsHtml
                + '</div>'
                // 元数据卡片
                + '<div class="assets-detail-section">'
                + '<div class="assets-detail-section-title">' + AEI18n.t('详情') + '</div>'
                + '<div class="assets-detail-section-body">'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('名称') + '</span><span class="v">' + _esc(r.name) + '</span></div>'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('来源图层') + '</span><span class="v">' + _esc(srcLayerLabel) + '</span></div>'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('属性') + '</span><span class="v">' + _esc(r.source && r.source.propertyPath ? r.source.propertyPath : '-') + '</span></div>'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('大小') + '</span><span class="v">' + _fmtSize(r.size) + '</span></div>'
                + '<div class="assets-detail-row"><span class="k">' + AEI18n.t('创建') + '</span><span class="v">' + _esc(r.createdAt || '') + '</span></div>'
                + '</div></div>'
                // 操作按钮
                + '<div class="assets-detail-actions">'
                + '<button class="btn btn-slice secondary" data-act="apply" data-id="' + _esc(r.id) + '">' + AEI18n.t('应用到选中图层') + '</button>'
                // 手工重生成：取 AE 当前画面覆盖旧预览，语义做成明文按钮
                // （悬浮 ↻ 不明显，改常规按钮更易看见）。有无预览都显示——无预览正是要补的场景
                + '<button class="btn btn-slice secondary" data-act="regenPreview" data-id="' + _esc(r.id) + '"'
                    + ' title="' + _esc(AEI18n.t('取 AE 当前画面重新生成预览，约需 3 秒')) + '">' + AEI18n.t('重新截取预览') + '</button>'
                + '<button class="btn btn-slice secondary" data-act="delete" data-id="' + _esc(r.id) + '">' + AEI18n.t('归档') + '</button>'
                + '</div>'
                // 备注
                + '<textarea class="assets-presets-notes" data-id="' + _esc(r.id) + '" data-act="notes" maxlength="2000" placeholder="' + _esc(AEI18n.t('备注…')) + '">' + _esc(r.notes || '') + '</textarea>'
                + (r.missing ? AEI18n.html('<div class="assets-empty assets-empty-inline assets-empty-warn">.ffx 文件已丢失</div>') : '')
                + '</div>';
        }

        function _handleDetailAction(act, id) {
            if (act === 'apply') _apply(id);
            else if (act === 'delete') _delete(id);
            else if (act === 'regenPreview') _regenPreview(id);
        }

        // 手工重生成预览：抓 AE 当前画面（captureCurrentFrame 走工具注册表）→ 缩图 →
        // store.regeneratePreview（落盘成功才写索引）。抓帧期间 AE 主线程被占（1080p
        // 实测约 3.5s），用 _busy 挡住并发点击；失败只提示，不动旧预览。
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

        function _delete(id) {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            var it = store.list().filter(function (x) { return x.id === id; })[0];
            if (!it) return;
            _busy = true;
            // 条目本身是链接时先显式提示（归档=物理搬移，作用于真实目标）；取消 → 什么都不做
            _fh._withLinkGuard([{ path: it.ffxPath, label: it.name }], function () { _deleteConfirmed(id, it); })
                .then(function (go) { if (go === false) _busy = false; });
        }

        // 归档确认 + 执行链（从 _delete 原样抽出，守卫通过后调用）
        function _deleteConfirmed(id, it) {
            global.showConfirm(AEI18n.t('归档预设'), AEI18n.t('确定归档预设「') + it.name + AEI18n.t('」？.ffx 将移入库内归档区，7 天后自动清理，期间可在「归档区」面板恢复。'), 'confirm').then(function (ok) {
                if (!ok) { _busy = false; return; }
                store.archive([id]).then(function (res) {
                    _busy = false; _refresh();
                    // 单条归档也要消费回执 failures：store._archiveInner 复制/删源/归档区创建
                    // 失败时不抛错，只把失败写进 res.failures 后 resolve——不查会弹假成功。
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
                    if (miss.length) { if (global.AEToast) AEToast.info(AEI18n.punct('「', '"', '「', '„', '“', '« ', '«') + it.name + AEI18n.t('」无实体文件，已移除索引条目')); return; }
                    if (global.AEToast) AEToast.success(AEI18n.t('已归档「') + it.name + AEI18n.t('」（7 天后自动清理）'));
                })
                    .catch(function (e) { _busy = false; if (global.AEToast) AEToast.error(AEI18n.t('归档失败: ') + (e.message || e)); });
            });
        }

        function _openLocation(id) {
            var it = store.list().filter(function (x) { return x.id === id; })[0];
            if (!it || !it.ffxPath) return;
            var folderPath = it.ffxPath.replace(/[\\/][^\\/]+$/, '');
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

        function _batchDelete() {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            var ids = _tv.getSelectedIds();
            if (!ids.length) return;
            _busy = true;
            // 选中条目本身是链接时先显式提示（逐条探测、一次汇总）；取消 → 什么都不做
            var _bsel = {};
            for (var _bi = 0; _bi < ids.length; _bi++) _bsel[ids[_bi]] = true;
            var _bents = store.list().filter(function (x) { return _bsel[x.id] && x.ffxPath; })
                .map(function (x) { return { path: x.ffxPath, label: x.name }; });
            _fh._withLinkGuard(_bents, function () { _batchDeleteConfirmed(ids); })
                .then(function (go) { if (go === false) _busy = false; });
        }

        // 批量归档确认 + 执行链（从 _batchDelete 原样抽出，守卫通过后调用）
        function _batchDeleteConfirmed(ids) {
            global.showConfirm(AEI18n.t('批量归档'), AEI18n.t('确定归档选中的 ') + ids.length + AEI18n.t(' 个预设？.ffx 将移入库内归档区，7 天后自动清理，期间可恢复。'), 'danger').then(function (ok) {
                if (!ok) { _busy = false; return; }
                var total = ids.length;
                var deleted = 0, failed = 0, missingRemoved = 0, partialWarn = 0;
                var cancelled = false;
                var notice = (total > NOTICE_THRESHOLD) && global.AENotice ? global.AENotice.show({
                    id: 'assets-preset-archive',
                    title: AEI18n.t('归档预设'),
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
                setTimeout(function () {
                    (function next(i) {
                        if (cancelled || i >= ids.length) {
                            _busy = false; _refresh();
                            if (notice) notice.close();
                            if (cancelled) {
                                if (global.AEToast) AEToast.info(AEI18n.t('已取消（已归档 ') + deleted + '/' + total + AEI18n.punct('）', ')'));
                            } else if (failed > 0) {
                                // 部分失败必须如实汇报（对齐 folderViewMixin._archiveFolders）；
                                // 假失败警告项已计入成功，仅作附加警告、不重复计入失败数
                                var _pw2 = partialWarn > 0 ? AEI18n.t('，{n} 条部分失败警告', { n: partialWarn }) : '';
                                if (global.AEToast) AEToast.error(AEI18n.t('归档完成（') + deleted + AEI18n.t(' 成功，') + failed + AEI18n.t(' 失败') + _pw2 + AEI18n.punct('）', ')'));
                            } else if (partialWarn > 0) {
                                // 归档副本清理/原文件删除通道假失败（源已不存在）：条目已按完成归档，只报警告
                                if (global.AEToast) AEToast.warn(AEI18n.t('归档完成（') + deleted + AEI18n.t(' 成功，') + partialWarn + AEI18n.t(' 条部分失败警告）'));
                            } else {
                                var _mi2 = missingRemoved ? AEI18n.t('；另移除丢失索引 {n} 条（无实体可归档）', { n: missingRemoved }) : '';
                                if (global.AEToast) AEToast.success(AEI18n.t('已归档 ') + deleted + AEI18n.t(' 个预设') + _mi2 + AEI18n.t('（7 天后自动清理）'));
                            }
                            return;
                        }
                        // 分块调用 store.archive（每块一次索引落盘；块内逐条成败由返回结果记账）
                        var chunk = ids.slice(i, i + 20);
                        store.archive(chunk).then(function (res) {
                            // 数据安全修复：假失败警告条目与 archived 同 id 重叠（删除通道回报
                            // 失败但源已不存在，已按移动完成处理）——成功与失败直接相加会重复
                            // 计数、进度 >100%。按 id 去重（对齐 projectAssetView._batchDelete
                            // 的部分失败计数）：成功照常计；重叠项只作「部分失败警告」不推进进度
                            var arch = (res && res.archived) ? res.archived : null;
                            var miss = (res && res.missing) ? res.missing : [];
                            var fails = (res && res.failures) ? res.failures : [];
                            var okIds = {};
                            var _ri;
                            for (_ri = 0; _ri < (arch || []).length; _ri++) {
                                var _ok = arch[_ri];
                                if (_ok && _ok.id != null) okIds[String(_ok.id)] = true;
                            }
                            for (_ri = 0; _ri < miss.length; _ri++) {
                                var _mk = miss[_ri];
                                if (_mk && _mk.id != null) okIds[String(_mk.id)] = true;
                            }
                            var failN = 0, partN = 0;
                            for (_ri = 0; _ri < fails.length; _ri++) {
                                var _fk = (fails[_ri] && fails[_ri].id != null) ? String(fails[_ri].id) : '';
                                if (_fk && okIds[_fk]) { partN++; continue; }   // 重叠：成功已计，只报警告
                                failN++;
                            }
                            deleted += arch ? arch.length : chunk.length;
                            missingRemoved += miss.length;
                            failed += failN;
                            partialWarn += partN;
                            _updatePd();
                            setTimeout(function () { next(i + chunk.length); }, 5);
                        }).catch(function () {
                            failed += chunk.length;
                            _updatePd();
                            setTimeout(function () { next(i + chunk.length); }, 5);
                        });
                    })(0);
                }, 30);
                function _updatePd() {
                    if (notice && global.AENotice) {
                        var d = deleted + failed;
                        global.AENotice.update('assets-preset-archive', {
                            message: AEI18n.t('正在归档… {done}/{total}', { done: d, total: total }),
                            progress: Math.round(d / total * 100),
                            progressLabel: d + '/' + total
                        });
                    }
                }
            });
        }

        function _saveNotes(id) {
            // 先捕获输入值：_busy 延迟重试期间 DOM 可能被重建/换选中，迟读会存错条目内容
            var ta = pane.querySelector('.assets-presets-notes');
            var notes = ta ? ta.value : '';
            function _doSave() {
                store.updateMeta(id, { notes: notes }).then(function () {
                    if (_tv && _tv.refreshDetail) _tv.refreshDetail();
                }).catch(function (e) { if (global.AEToast) AEToast.error(AEI18n.t('保存失败: ') + (e.message || e)); });
            }
            if (_busy) {
                // 批量操作进行中不写盘（避免与批量的索引写盘抢锁），但也不能丢编辑内容：
                // 捕获值后延迟重试直到不忙（对齐 projectAssetView._saveNotes 模式），视图销毁后放弃
                setTimeout(function retry() {
                    if (_destroyed) return;
                    if (_busy) { setTimeout(retry, 200); return; }
                    _doSave();
                }, 200);
                return;
            }
            _doSave();
        }

        function _refresh() {
            if (_destroyed) return;
            if (_editing) {
                _tv.renderList(store.list().map(function (it) {
                    return { id: it.id, name: it.name, folder: it.folder, _raw: it };
                }));
            } else {
                _tv.render(store.list().map(function (it) {
                    return { id: it.id, name: it.name, folder: it.folder, _raw: it };
                }));
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
            } finally {
                overlay.hide();
            }
        }

        async function _reload() {
            if (_busy) return;
            _busy = true;
            var overlay = global.AEAssetsShared.createLoadingOverlay(dz);
            try {
                var before = store.list().length;
                try { await store.load(); }
                catch (e) {
                    // 刷新失败不能吞错后仍提示"已刷新"（对齐 projectAssetView._reload）
                    if (global.AEToast) AEToast.error(AEI18n.t('刷新失败: ') + (e && e.message ? e.message : e));
                    return;
                }
                if (_destroyed) return;
                _refresh();
                var delta = store.list().length - before;
                if (global.AEToast) {
                    if (delta > 0) AEToast.success(AEI18n.t('已刷新，发现 ') + delta + AEI18n.t(' 个新预设'));
                    else AEToast.info(AEI18n.t('已刷新'));
                }
            } finally {
                overlay.hide();
                _busy = false;
            }
        }

        async function _cleanMissing() {
            if (_busy) { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); return; }
            _busy = true;
            var notice = global.AENotice ? global.AENotice.show({
                id: 'assets-preset-scan-missing',
                title: AEI18n.t('扫描丢失预设'),
                message: AEI18n.t('正在扫描丢失文件…'),
                tone: 'info',
                dismissible: false
            }) : null;
            try {
                // 主动扫描检测 ffx 文件是否存在，更新 missing 标记
                await store.scanMissing();
            } catch (_) {}
            if (_destroyed) { _busy = false; if (notice) notice.close(); return; }
            if (notice) notice.close();
            _busy = false;
            var missing = store.listMissing();
            if (missing.length === 0) {
                if (global.AEToast) AEToast.info(AEI18n.t('没有丢失索引的预设'));
                return;
            }
            _refresh();
            global.showConfirm(
                AEI18n.t('清理丢失索引'),
                AEI18n.t('检测到 ') + missing.length + AEI18n.t(' 个预设的 .ffx 文件已丢失（索引仍在）。确定清理这些索引条目？此操作仅删除索引，不影响其他预设。'),
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
            });
        }

        function destroy() {
            _destroyed = true;
            // 保存路径弹窗挂在 document.body（不在 pane 内），视图卸载时关闭
            if (_activeSavePathModalClose) {
                try { _activeSavePathModalClose(); } catch (_) {}
                _activeSavePathModalClose = null;
            }
            dz.removeEventListener('dragover', _dzHandlers.dragover);
            dz.removeEventListener('dragleave', _dzHandlers.dragleave);
            dz.removeEventListener('drop', _dzHandlers.drop);
            if (_tv) _tv.destroy();
            pane.innerHTML = '';
        }

        function onActive() {
            // onCovered 已 blur-save 编辑；树数据在被盖住期间不变，不重建树避免切卡闪屏。
            // 列表刷新由卡内增删改操作各自触发 _refresh。
        }
        function onCovered() {
            // CEF 88 点竖条不夺焦，编辑中切卡须主动 blur-save
            if (_editing) {
                var ta = pane.querySelector('.assets-presets-notes');
                if (ta) { var id = ta.getAttribute('data-id'); if (id) _saveNotes(id); }
                _editing = false;
            }
        }

        return { init: init, destroy: destroy, refresh: _refresh, pane: pane, onActive: onActive, onCovered: onCovered };
    }

    global.AEAssetsShared.createPresetView = createPresetView;
})(window);
