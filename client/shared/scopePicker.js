// 目标模块容纳框 + 弹窗选择器（MCP / Skill 共用）
//
// 交互模型：
//   - 一个容纳框，内部以胶囊展示已选「模块（+ 其模式）」。
//   - 点击容纳框弹出窗口。
//   - 弹窗左侧列出真实模块（agent、AE-tool 等），右侧显示当前模块的模式子内容。
//     仅 agent 模块有模式（agent/script/shader），其余模块无模式。
//   - 勾选某模块的模式（或「全部模式」）即自动加入待选集合；切换模块不丢失，可批量勾选多个模块。
//   - 底部「确认」一次性导入所有配置过的模块；「取消」丢弃本次改动。
//   - 每个胶囊带 × 可单独删除。
//
// 数据模型（与底层保持兼容）：use moduleIds(平铺) + agentModes(仅 agent)。
//   - moduleIds: 容纳框内所有模块 id 的平铺数组。
//   - agentModes: 当 agent 被选中且限定具体模式时填写；为空表示 agent 全部模式生效。
//   - 外接是 Agent 模块的模式之一（'external-mcp'，见 MODE_DEFS）：勾它就写进 agentModes，
//     展开时与 agent/script/shader 一样直接当 moduleId 用。旧形态/手写配置把外接写在
//     moduleIds 里（模块级成员）时，setValue 会折进 Agent 的模式，语义不变。
//
// 用法：
//   var picker = AEScopePicker.create({
//       container: <element>,            // 容纳框渲染位置
//       modules: [{id, title}],          // 可用模块列表
//       value: { moduleIds: [], agentModes: [] },  // 初始值
//       onChange: function(value) {}     // 可选：值变化回调
//   });
//   picker.getValue()  -> { moduleIds, agentModes }
//   picker.setValue(v)
//   picker.destroy()

(function (global) {
    'use strict';

    function _ensureCss() {
        if (global.document.getElementById('aescope-picker-css')) return;
        var style = global.document.createElement('style');
        style.id = 'aescope-picker-css';
        style.textContent = ''
            // ---- 容纳框 ----
            + '.aescope-box{display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%;padding:8px 10px;border:1px solid var(--btn-border, #3a4150);border-radius:8px;background:var(--surface-3, rgba(24,30,36,0.9));cursor:pointer;transition:border-color .15s;min-height:36px;box-sizing:border-box;}'
            + '.aescope-box:hover{border-color:var(--accent);}'
            + '.aescope-capsule{display:inline-flex;align-items:center;gap:4px;background:rgba(var(--accent-rgb),.15);border:1px solid var(--accent);color:var(--accent);border-radius:999px;padding:3px 6px 3px 10px;font-size:11px;line-height:1.4;max-width:100%;}'
            + '.aescope-capsule .aescope-cap-title{font-weight:600;white-space:nowrap;}'
            + '.aescope-capsule .aescope-cap-modes{color:var(--text-muted);white-space:nowrap;}'
            + '.aescope-capsule .aescope-cap-x{background:none;border:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;opacity:.7;border-radius:50%;}'
            + '.aescope-capsule .aescope-cap-x:hover{opacity:1;background:rgba(255,255,255,.12);}'
            + '.aescope-box .aescope-add-hint{color:var(--text-muted);font-size:12px;margin-left:2px;}'
            + '.aescope-box.is-empty{justify-content:center;border-style:dashed;min-height:64px;}'
            + '.aescope-box .aescope-empty-plus{font-size:22px;line-height:1;color:var(--text-muted);font-weight:400;}'
            // ---- 弹窗 ----
            + '.aescope-modal{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);}'
            + '.aescope-modal .aescope-dialog{width:min(480px,92vw);background:var(--surface-1, #0e1118);border:1px solid var(--btn-border);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.55);overflow:hidden;display:flex;flex-direction:column;animation:aescope-pop .18s cubic-bezier(.2,.9,.3,1.15);}'
            + '@keyframes aescope-pop{from{opacity:0;transform:translateY(10px) scale(.97);}to{opacity:1;transform:none;}}'
            + '.aescope-modal .aescope-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.07);}'
            + '.aescope-modal .aescope-head-left{display:flex;flex-direction:column;gap:2px;}'
            + '.aescope-modal .aescope-title{font-size:15px;font-weight:600;color:var(--text-main);}'
            + '.aescope-modal .aescope-subtitle{font-size:12px;color:var(--text-muted);}'
            + '.aescope-modal .aescope-close{background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;line-height:1;padding:4px 8px;border-radius:6px;transition:all .12s;}'
            + '.aescope-modal .aescope-close:hover{color:var(--text-main);background:rgba(255,255,255,.08);}'
            + '.aescope-modal .aescope-body{display:flex;gap:0;min-height:320px;max-height:62vh;}'
            + '.aescope-modal .aescope-col{display:flex;flex-direction:column;min-width:0;flex:1;}'
            + '.aescope-modal .aescope-col-label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--text-muted);padding:12px 16px 6px;letter-spacing:.3px;}'
            + '.aescope-modal .aescope-col-label .aescope-count{font-weight:500;opacity:.7;}'
            + '.aescope-modal .aescope-modules{border-right:1px solid rgba(255,255,255,.07);overflow-y:auto;padding:0 8px 10px;}'
            + '.aescope-modal .aescope-module{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:10px 12px;background:transparent;color:var(--text-main);cursor:pointer;font-size:13px;transition:all .12s;border:none;border-bottom:1px solid rgba(255,255,255,.06);position:relative;}'
            + '.aescope-modal .aescope-module:last-child{border-bottom:none;}'
            + '.aescope-modal .aescope-module:hover{background:rgba(var(--accent-rgb),.08);}'
            + '.aescope-modal .aescope-module.selected{background:rgba(var(--accent-rgb),.12);color:var(--accent);}'
            + '.aescope-modal .aescope-module.selected::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent);border-radius:0 2px 2px 0;}'
            + '.aescope-modal .aescope-module-title{flex:1;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
            + '.aescope-modal .aescope-module.selected .aescope-module-title{font-weight:600;}'
            + '.aescope-modal .aescope-module-added{font-size:10px;color:var(--text-muted);background:rgba(255,255,255,.08);padding:1px 7px;border-radius:999px;flex:none;}'
            + '.aescope-modal .aescope-module.selected .aescope-module-added{color:var(--accent);background:rgba(var(--accent-rgb),.15);}'
            + '.aescope-modal .aescope-modes{overflow-y:auto;padding:0 14px 12px;}'
            + '.aescope-modal .aescope-modes-wrap{display:flex;flex-direction:column;gap:4px;}'
            // 模式条目：整行可点，左侧全局复选框（.check-wrap），横线隔离，非胶囊
            + '.aescope-modal .aescope-mode{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;padding:9px 10px;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,.06);transition:all .12s;}'
            + '.aescope-modal .aescope-mode:last-child{border-bottom:none;}'
            + '.aescope-modal .aescope-mode:hover{background:rgba(var(--accent-rgb),.08);}'
            + '.aescope-modal .aescope-mode .check-wrap{display:flex;align-items:center;gap:9px;flex:1;font-size:13px;color:var(--text-main);line-height:1.4;margin:0;}'
            + '.aescope-modal .aescope-mode input:checked + span{color:var(--accent);font-weight:600;}'
            + '.aescope-modal .aescope-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 18px;border-top:1px solid rgba(255,255,255,.07);}'
            + '.aescope-modal .aescope-foot-summary{font-size:12px;color:var(--text-muted);}'
            + '.aescope-modal .aescope-foot-actions{display:flex;gap:8px;}';
        global.document.head.appendChild(style);
    }

    // Agent 模块的模式列表 = 面板的四个运行模式。外接（'external-mcp'）是其中之一：
    // 它既是对外接通道的可见性（extTools 的 scopeAllowsExternal / extBridgeClient 以
    // 'external-mcp' 作 moduleId 比对），展开时又直接当作 moduleId 用——所以模式 id 就用
    // 模块 id 本身（与 agent/script/shader 同款：模式名 = 它展开成的 moduleId）。
    // label/short 是 getter：本文件在模块装载期求值，直接调 AEI18n.t 会让无 AEI18n 的裸沙箱装载即抛。
    var MODE_DEFS = [
        { id: 'agent', get label() { return AEI18n.t('Agent 模式'); }, short: 'Agent' },
        { id: 'script', get label() { return AEI18n.t('Script 模式'); }, short: 'Script' },
        { id: 'shader', get label() { return AEI18n.t('Shader 模式'); }, short: 'Shader' },
        { id: 'external-mcp', get label() { return AEI18n.t('外接模式'); }, get short() { return AEI18n.t('外接'); } }
    ];
    var AGENT_MODULE = 'agent';
    var EXTERNAL_MODE = 'external-mcp';

    // 模式短标签：胶囊与各模块的作用域提示共用这一份映射——
    // 各显示点自己拼裸 id 时，外接会显示成 external-mcp（用户看不到「外接」这个词）。
    function modeShortLabels(ids) {
        var out = [];
        var list = ids || [];
        for (var i = 0; i < list.length; i++) {
            var md = null;
            for (var j = 0; j < MODE_DEFS.length; j++) {
                if (MODE_DEFS[j].id === list[i]) { md = MODE_DEFS[j]; break; }
            }
            out.push(md ? md.short : String(list[i] == null ? '' : list[i]));
        }
        return out;
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function AEScopePicker(opts) {
        var container = opts.container;
        var modules = opts.modules || [];
        var onChange = opts.onChange || function () {};
        // 内部状态：容纳框内的条目 [{ moduleId, modes: [] }]，modes 为空表示全部模式
        var entries = [];
        // 弹窗内的「待选集合」：{ moduleId: modes[] }，勾选某模块的模式即加入，确认时合并进 entries
        var sel = {};

        // 容纳框预览视图 = 已提交 entries + 弹窗待选 sel（sel 优先/新增）
        function _mergedEntries() {
            var out = entries.slice();
            for (var k in sel) {
                var e = { moduleId: k, modes: (sel[k] || []).slice() };
                var dup = false;
                for (var i = 0; i < out.length; i++) {
                    if (out[i].moduleId === k) { out[i] = e; dup = true; break; }
                }
                if (!dup) out.push(e);
            }
            return out;
        }

        _ensureCss();

        // ---- 渲染容纳框 ----
        // 容纳框始终是一个带边框的 .aescope-box 容器（内容为空时显示提示文案）
        function renderBox() {
            if (!container) return;
            container.innerHTML = '';
            var box = global.document.createElement('div');
            box.className = 'aescope-box';
            var merged = _mergedEntries();
            if (!merged.length) {
                var plus = global.document.createElement('span');
                plus.className = 'aescope-empty-plus';
                plus.textContent = '+';
                box.appendChild(plus);
                box.classList.add('is-empty');
                container.appendChild(box);
                return;
            }
            for (var i = 0; i < merged.length; i++) {
                var e = merged[i];
                var mod = _findModule(e.moduleId);
                var cap = global.document.createElement('span');
                cap.className = 'aescope-capsule';
                var title = mod ? mod.title : e.moduleId;
                var capHtml = '<span class="aescope-cap-title">' + esc(title) + '</span>';
                if (e.moduleId === AGENT_MODULE && e.modes && e.modes.length) {
                    capHtml += '<span class="aescope-cap-modes">· ' + esc(modeShortLabels(e.modes).join(' / ')) + '</span>';
                }
                capHtml += '<button type="button" class="aescope-cap-x" data-idx="' + i + '" title="' + AEI18n.t('移除') + '">×</button>';
                cap.innerHTML = capHtml;
                cap.querySelector('.aescope-cap-x').addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    var idx = parseInt(this.getAttribute('data-idx'), 10);
                    var e2 = merged[idx];
                    for (var zi = 0; zi < entries.length; zi++) {
                        if (entries[zi].moduleId === e2.moduleId) { entries.splice(zi, 1); break; }
                    }
                    if (sel && Object.prototype.hasOwnProperty.call(sel, e2.moduleId)) delete sel[e2.moduleId];
                    renderBox();
                    _emit();
                });
                box.appendChild(cap);
            }
            container.appendChild(box);
        }

        function _findModule(id) {
            for (var i = 0; i < modules.length; i++) if (modules[i].id === id) return modules[i];
            return null;
        }

        container.addEventListener('click', openModal);

        function _emit() {
            onChange(getValue());
        }

        // ---- 弹窗 ----
        function openModal() {
            var modal = global.document.createElement('div');
            modal.className = 'aescope-modal';
            // 动态 z-index：取当前页面上最高 z-index 的弹窗遮罩 +1，避免被宿主弹窗（z-index 递增）遮挡
            var topZ = 9999;
            var masks = global.document.querySelectorAll('.modal-mask, .aescope-modal');
            for (var zi = 0; zi < masks.length; zi++) {
                var cz = parseInt(global.getComputedStyle(masks[zi]).zIndex, 10);
                if (!isNaN(cz) && cz >= topZ) topZ = cz + 1;
            }
            modal.style.zIndex = String(topZ);
            modal.innerHTML = ''
                + '<div class="aescope-dialog">'
                + '<div class="aescope-head">'
                + '<div class="aescope-head-left">'
                + AEI18n.html('<span class="aescope-title">选择目标模块</span>')
                + AEI18n.html('<span class="aescope-subtitle">先选模块，再设置其生效模式</span>')
                + '</div>'
                + AEI18n.html('<button type="button" class="aescope-close" title="关闭">×</button>')
                + '</div>'
                + '<div class="aescope-body">'
                + '<div class="aescope-col aescope-modules"></div>'
                + '<div class="aescope-col aescope-modes">'
                + AEI18n.html('<div class="aescope-col-label" id="aescope-modes-label">生效模式</div>')
                + '<div class="aescope-modes-wrap"></div>'
                + '</div>'
                + '</div>'
                + '<div class="aescope-foot">'
                + '<span class="aescope-foot-summary"></span>'
                + '<div class="aescope-foot-actions">'
                + AEI18n.html('<button type="button" class="btn secondary" data-act="cancel">取消</button>')
                + AEI18n.html('<button type="button" class="btn" data-act="confirm">确认</button>')
                + '</div>'
                + '</div>'
                + '</div>';
            global.document.body.appendChild(modal);

            var modulesEl = modal.querySelector('.aescope-modules');
            var modesWrapEl = modal.querySelector('.aescope-modes-wrap');
            var modesLabelEl = modal.querySelector('#aescope-modes-label');
            var footSummaryEl = modal.querySelector('.aescope-foot-summary');
            var selectedModuleId = null;
            var modeChecks = {}; // modeId -> checkbox

            // 打开弹窗时清空待选集合（entries 保持不变；取消/关闭即丢弃 sel）
            sel = {};

            // 该模块是否已选中（已在 entries 或待选 sel 中）
            function _isAdded(id) {
                for (var ii = 0; ii < entries.length; ii++) if (entries[ii].moduleId === id) return true;
                if (sel && Object.prototype.hasOwnProperty.call(sel, id)) return true;
                return false;
            }
            // 读取该模块当前生效模式；未选中返回 null（表示尚未配置）
            function _selModes(id) {
                if (sel && Object.prototype.hasOwnProperty.call(sel, id)) return (sel[id] || []).slice();
                for (var ii = 0; ii < entries.length; ii++) if (entries[ii].moduleId === id) return (entries[ii].modes || []).slice();
                return null;
            }

            // 渲染左侧模块列表
            function renderModules() {
                modulesEl.innerHTML = '';
                // 列头 + 数量
                var head = global.document.createElement('div');
                head.className = 'aescope-col-label';
                head.innerHTML = AEI18n.html('可用模块 <span class="aescope-count">') + modules.length + '</span>';
                modulesEl.appendChild(head);
                // 默认选中第一个模块
                if (selectedModuleId == null && modules.length) {
                    selectedModuleId = modules[0].id;
                }
                for (var i = 0; i < modules.length; i++) {
                    (function (m) {
                        var isSel = m.id === selectedModuleId;
                        var isAdded = _isAdded(m.id);
                        var btn = global.document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'aescope-module' + (isSel ? ' selected' : '');
                        btn.innerHTML = '<span class="aescope-module-title">' + esc(m.title) + '</span>'
                            + (isAdded ? AEI18n.html('<span class="aescope-module-added">已选</span>') : '');
                        btn.addEventListener('click', function () {
                            selectedModuleId = m.id;
                            renderModules();
                            renderModes();
                        });
                        modulesEl.appendChild(btn);
                    })(modules[i]);
                }
            }

            // 渲染右侧模式（仅 agent 有模式；其余模块无模式，只显示一个「全部模式」）
            function renderModes() {
                modesWrapEl.innerHTML = '';
                var mod = _findModule(selectedModuleId);
                var modName = mod ? mod.title : '';
                var curModes = _selModes(selectedModuleId); // null = 尚未配置
                if (selectedModuleId !== AGENT_MODULE) {
                    // 无模式的模块：只显示一个「全部模式」，默认不勾选
                    modesLabelEl.textContent = modName + AEI18n.t(' · 无模式');
                    var allCb = _makeModeCb('__all__', '全部模式', curModes !== null);
                    modesWrapEl.appendChild(allCb.el);
                    modeChecks = { __all__: allCb.input };
                    _renderFootSummary();
                    return;
                }
                modesLabelEl.textContent = modName + AEI18n.t(' · 生效模式');
                // 全部模式 = 未限定任何具体模式（仅已明确选空时勾选；尚未配置时不默认勾选）
                var isAll = (curModes !== null) && (curModes.length === 0);
                var allCb = _makeModeCb('__all__', '全部模式', isAll);
                modesWrapEl.appendChild(allCb.el);
                modeChecks = { __all__: allCb.input };
                for (var mi = 0; mi < MODE_DEFS.length; mi++) {
                    var mc = _makeModeCb(MODE_DEFS[mi].id, MODE_DEFS[mi].label, curModes && curModes.indexOf(MODE_DEFS[mi].id) >= 0);
                    modesWrapEl.appendChild(mc.el);
                    modeChecks[MODE_DEFS[mi].id] = mc.input;
                }
                _renderFootSummary();
            }

            function _makeModeCb(id, label, checked) {
                var lab = global.document.createElement('label');
                lab.className = 'aescope-mode check-wrap';
                lab.innerHTML = '<input type="checkbox" data-mode="' + id + '"' + (checked ? ' checked' : '') + '><span>' + esc(label) + '</span>';
                var input = lab.querySelector('input');
                input.addEventListener('change', function () {
                    if (this.dataset.mode === '__all__' && this.checked) {
                        // 选全部 → 取消其它具体模式
                        for (var k in modeChecks) {
                            if (k !== '__all__' && modeChecks[k]) modeChecks[k].checked = false;
                        }
                    } else if (this.checked) {
                        // 选具体模式 → 取消全部
                        if (modeChecks.__all__) modeChecks.__all__.checked = false;
                    }
                    // 勾选/取消模式即实时更新该模块的待选状态
                    _applyActive();
                });
                return { el: lab, input: input };
            }

            // 把当前模块的勾选状态写入待选集合，并刷新徽标 / 容纳框 / 摘要
            function _applyActive() {
                if (selectedModuleId == null) return;
                var allChecked = !!(modeChecks.__all__ && modeChecks.__all__.checked);
                var modes = [];
                if (!allChecked) {
                    for (var k in modeChecks) {
                        if (k !== '__all__' && modeChecks[k] && modeChecks[k].checked) modes.push(k);
                    }
                }
                if (allChecked || modes.length) {
                    sel[selectedModuleId] = (selectedModuleId === AGENT_MODULE) ? modes.slice() : [];
                } else {
                    delete sel[selectedModuleId];
                }
                renderModules();
                renderBox();
                _renderFootSummary();
            }

            // 底部摘要：显示当前已选模块数量（entries + 待选 sel）
            function _renderFootSummary() {
                if (!footSummaryEl) return;
                var n = _mergedEntries().length;
                footSummaryEl.textContent = n ? (AEI18n.t('已选 ') + n + AEI18n.t(' 个模块')) : AEI18n.t('未限定模块（全局可用）');
            }

            // 关闭：丢弃待选集合，恢复为已提交的 entries
            function close() {
                sel = {};
                renderBox();
                if (modal.parentNode) modal.parentNode.removeChild(modal);
            }
            modal.querySelector('.aescope-close').addEventListener('click', close);
            modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
            modal.querySelector('[data-act="cancel"]').addEventListener('click', close);

            // 确认：把待选集合合并进 entries 并关闭
            modal.querySelector('[data-act="confirm"]').addEventListener('click', function () {
                entries = _mergedEntries();
                sel = {};
                renderBox();
                _emit();
                close();
            });

            renderModules();
            renderModes();
        }

        // ---- 初始化 ----
        function setValue(v) {
            entries = [];
            var moduleIds = ((v && v.moduleIds) || []).slice();
            var agentModes = ((v && v.agentModes) || []).slice();
            // 外接以模块级成员形态写在 moduleIds 里时（手写配置/旧版本写入）→ 折进 Agent 的
            // 模式：展开结果仍是 external-mcp，语义不变；少了这步，选择器会把裸 id 当模块胶囊
            // 显示，用户再保存也回不到新模式。
            var hasLegacyExt = false;
            var kept = [];
            for (var li = 0; li < moduleIds.length; li++) {
                if (moduleIds[li] === EXTERNAL_MODE) hasLegacyExt = true;
                else kept.push(moduleIds[li]);
            }
            if (hasLegacyExt) {
                moduleIds = kept;
                if (agentModes.indexOf(EXTERNAL_MODE) < 0) agentModes.push(EXTERNAL_MODE);
                if (moduleIds.indexOf(AGENT_MODULE) < 0) moduleIds.push(AGENT_MODULE);
            }
            for (var i = 0; i < moduleIds.length; i++) {
                var mid = moduleIds[i];
                var modes = (mid === AGENT_MODULE) ? agentModes.slice() : [];
                // 去重：同模块只保留一项
                var dup = false;
                for (var j = 0; j < entries.length; j++) if (entries[j].moduleId === mid) { dup = true; break; }
                if (!dup) entries.push({ moduleId: mid, modes: modes });
            }
            renderBox();
        }

        function getValue() {
            var moduleIds = [];
            var agentModes = [];
            for (var i = 0; i < entries.length; i++) {
                moduleIds.push(entries[i].moduleId);
                if (entries[i].moduleId === AGENT_MODULE) agentModes = (entries[i].modes || []).slice();
            }
            return { moduleIds: moduleIds, agentModes: agentModes };
        }

        function destroy() {
            if (container) container.removeEventListener('click', openModal);
        }

        if (opts.value) setValue(opts.value);
        else renderBox();

        return { getValue: getValue, setValue: setValue, destroy: destroy };
    }

    global.AEScopePicker = { create: AEScopePicker, modeShortLabels: modeShortLabels };
})(typeof self !== 'undefined' ? self : this);