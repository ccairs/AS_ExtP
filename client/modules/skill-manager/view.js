(function(global) {

    function escHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function estimateTokens(text) {
        if (!text) return 0;
        return Math.max(1, Math.ceil(text.length / 4));
    }

    // ════════════════════════════════════════════════════════
    // 私网/回环 host 判定（SSRF 防护，与 llmTools.js 同源拷贝——
    //  等价移植自 shared/bridge-server.js 的 _isPrivateHost/_parseIpv4Like/
    //  _isPrivateIpv4Long）。bridge 侧另有 _safeLookup 在连接期做 DNS 解析复查，
    //  CEP 直连 fetch 无此防线——字符串判定是唯一闸门，故在 bridge 版基础上补齐
    //  WHATWG URL 的变体写法（percent-decode / 全角句点 / 尾随点 / IPv6 压缩与
    //  IPv4 内嵌展开，均经 Node URL 实测与字面内网地址等价）。两文件须可各自
    //  独立加载（本文件在单测沙箱内常脱离 llmTools.js 运行），故不跨文件引用。
    // 独立加载约束由「委托优先 + 本地回退」承接（对齐 模式）——
    //  llmTools.js 在 scripts.manifest 中先于本文件加载，运行时优先委托其单一实现
    //  （AESkillManager._internal）；脱离 llmTools.js 的沙箱回退下方本地副本。
    // 守卫簇单点实现，改动只落一处。
    // ════════════════════════════════════════════════════════

    // 手写 hostname 提取（ES5/CEP 无 URL API）：剥 userinfo/port，IPv6 去方括号
    function _extractHttpsHost(url) {
        var m = String(url || '').match(/^https:\/\/([^\/?#]*)/);
        if (!m) return '';
        var auth = m[1];
        // userinfo（user:pass@host）：取最后一个 @ 之后的尾段——
        // https://public.example@127.0.0.1/ 的实际 host 是 127.0.0.1
        var at = auth.lastIndexOf('@');
        if (at >= 0) auth = auth.slice(at + 1);
        // IPv6 字面量：[::1] / [::1]:8080 → 去方括号
        var v6 = auth.match(/^\[(.+)\]/);
        if (v6) return v6[1].toLowerCase();
        // 域名/IPv4：剥尾随 :port（host 部分不含冒号）
        var cut = auth.lastIndexOf(':');
        if (cut >= 0) auth = auth.slice(0, cut);
        return auth.toLowerCase();
    }

    // 单段 percent-decode（host 专用）：Chromium 解析 host 前先 percent-decode，
    // %31%32%37.0.0.1 与 127.0.0.1 同 host，判定前须同样解码
    function _percentDecode(s) {
        return String(s).replace(/%([0-9a-fA-F]{2})/g, function (_, h) {
            return String.fromCharCode(parseInt(h, 16));
        });
    }

    // inet_aton 布局的 IPv4 字面量解析：支持 127.1 / 0x7f000001 / 0177.0.0.1 /
    // 2130706433 等 WHATWG URL 会解析成内网地址的变体写法；非 IPv4 字面量返回 null
    function _parseIpv4Like(hostname) {
        var parts = String(hostname || '').split('.');
        if (parts.length < 1 || parts.length > 4) return null;
        function parseSeg(segStr, max) {
            var n;
            if (/^0[xX][0-9a-fA-F]+$/.test(segStr)) n = parseInt(segStr.slice(2), 16);
            else if (/^0[0-7]+$/.test(segStr)) n = parseInt(segStr.slice(1), 8);
            else if (/^0$/.test(segStr) || /^[1-9][0-9]*$/.test(segStr)) n = parseInt(segStr, 10);
            else return null;
            return (n >= 0 && n <= max) ? n : null;
        }
        var vals = [];
        for (var i = 0; i < parts.length; i++) {
            // 尾段位宽随段数收窄：4 段→255，3 段→65535，2 段→16777215，1 段→完整 32 位
            var isLast = (i === parts.length - 1);
            var max = isLast
                ? (parts.length === 1 ? 0xFFFFFFFF : Math.pow(256, 5 - parts.length) - 1)
                : 255;
            var v = parseSeg(parts[i], max);
            if (v === null) return null;
            vals.push(v);
        }
        // inet_aton 布局：首段是顶字节，中间段各占一字节，尾段整体占剩余低位字节
        if (vals.length === 1) return vals[0];
        var val = vals[0];
        for (var k = 1; k < vals.length - 1; k++) val = val * 256 + vals[k];
        return val * Math.pow(256, 4 - vals.length + 1) + vals[vals.length - 1];
    }

    function _isPrivateIpv4Long(long) {
        // 数值比较（long 可能 > 2^31，位运算会溢出截断）
        return (long >= 0x7F000000 && long <= 0x7FFFFFFF)      // 127.0.0.0/8
            || (long >= 0x00000000 && long <= 0x000000FF)      // 0.0.0.0/8
            || (long >= 0x0A000000 && long <= 0x0AFFFFFF)      // 10.0.0.0/8
            || (long >= 0xAC100000 && long <= 0xAC1FFFFF)      // 172.16.0.0/12
            || (long >= 0xC0A80000 && long <= 0xC0A8FFFF)      // 192.168.0.0/16
            || (long >= 0xA9FE0000 && long <= 0xA9FEFFFF);     // 169.254.0.0/16
    }

    // IPv6 字面量归一为 8 组数值数组（'::' 压缩展开、末位 IPv4 内嵌折两组）；非法
    // 返回 null。::1 的非压缩写法（0:0:0:0:0:0:0:1）与 IPv4 内嵌写法（::ffff:7f00:1）
    // 只能靠归一后判定，不能只匹 '::1' 字面量
    function _expandIpv6(host) {
        var h = String(host || '');
        var head = [], tail = [];
        var hasDc = h.indexOf('::') >= 0;
        if (hasDc) {
            var halves = h.split('::');
            if (halves.length !== 2) return null; // 只允许一个 '::'
            if (halves[0]) head = halves[0].split(':');
            if (halves[1]) tail = halves[1].split(':');
        } else {
            head = h.split(':');
        }
        // 文本组数（IPv4 内嵌计 2 组）
        function groupCount(pieces) {
            var n = 0;
            for (var i = 0; i < pieces.length; i++) n += pieces[i].indexOf('.') >= 0 ? 2 : 1;
            return n;
        }
        var total = groupCount(head) + groupCount(tail);
        if (hasDc ? total > 7 : total !== 8) return null;
        var groups = [];
        function pushPieces(pieces) {
            for (var i = 0; i < pieces.length; i++) {
                var seg = pieces[i];
                if (seg.indexOf('.') >= 0) {
                    // IPv4 内嵌只允许出现在末位
                    if (i !== pieces.length - 1) return false;
                    var v4 = _parseIpv4Like(seg);
                    if (v4 === null) return false;
                    groups.push(Math.floor(v4 / 65536), v4 % 65536);
                } else {
                    if (!/^[0-9a-f]{1,4}$/.test(seg)) return false;
                    groups.push(parseInt(seg, 16));
                }
            }
            return true;
        }
        if (!pushPieces(head)) return null;
        if (hasDc) {
            for (var z = 0; z < 8 - total; z++) groups.push(0);
        }
        if (!pushPieces(tail)) return null;
        return groups.length === 8 ? groups : null;
    }

    function _isPrivateIpv6Groups(g) {
        var i, allZero = true;
        for (i = 0; i < 8; i++) { if (g[i] !== 0) { allZero = false; break; } }
        // ::（未指定地址）与 ::1（回环）
        if (allZero) return true;
        if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 &&
            g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) return true;
        // fc00::/7 ULA（fc/fd 开头）
        if ((g[0] & 0xFE00) === 0xFC00) return true;
        // fe80::/10 链路本地 + fec0::/10 site-local
        if ((g[0] & 0xFFC0) === 0xFE80 || (g[0] & 0xFFC0) === 0xFEC0) return true;
        // IPv4-mapped ::ffff:a.b.c.d → 按 IPv4 私网段判定
        if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xFFFF) {
            return _isPrivateIpv4Long(g[6] * 65536 + g[7]);
        }
        return false;
    }

    // 单点委托入口——llmTools.js 的守卫簇单一实现（加载顺序见 manifest）
    function _skillLlmInternal() {
        return (global.AESkillManager && global.AESkillManager._internal) || null;
    }

    function _isPrivateHost(hostname) {
        var impl = _skillLlmInternal();
        if (impl && typeof impl.isPrivateHost === 'function') return impl.isPrivateHost(hostname);
        return _isPrivateHostLocal(hostname);
    }

    // 本地回退副本（独立加载/沙箱场景；与 llmTools.js 单点实现行为等价，由
    // 一致性测试看护）
    function _isPrivateHostLocal(hostname) {
        hostname = String(hostname || '').toLowerCase();
        // WHATWG URL 变体归一（均在 URL 解析后与字面内网地址等价）
        hostname = _percentDecode(hostname);                        // %31%32%37.0.0.1 → 127.0.0.1
        hostname = hostname.replace(/[\u3002\uff0e\uff61]/g, '.');  // 全角句点 → '.'（127。0。0。1）
        while (hostname.charAt(hostname.length - 1) === '.') hostname = hostname.slice(0, -1); // 尾随点
        if (hostname === 'localhost') return true;
        if (hostname.indexOf(':') >= 0) {
            // zone id（fe80::1%eth0）：剥 % 后缀再归一（Chromium 拒绝带 zone 的 https
            // host，此处防御性剥除后按段判定）
            var zi = hostname.indexOf('%');
            if (zi >= 0) hostname = hostname.slice(0, zi);
            var g6 = _expandIpv6(hostname);
            return g6 !== null && _isPrivateIpv6Groups(g6);
        }
        var long = _parseIpv4Like(hostname);
        return long !== null && _isPrivateIpv4Long(long);
    }

    function createSkillView(options) {
        options = options || {};
        var registry = options.registry || null;
        var skillInstaller = options.skillInstaller || null;
        var settingsStore = options.settingsStore || null;
        var currentFilter = 'all';
        var currentModuleId = options.moduleId || '';
        var availableModules = options.availableModules || [];
        var onSkillListChanged = options.onSkillListChanged || null;
        var listeners = [];
        // renderList 每次 innerHTML 重建的列表元素属临时 DOM：监听走独立通道 tmpListeners
        // （对齐 mcp-manager 的 tmpOn 模式），renderList 重建前与模块 destroy 时清理。
        // 若复用持久 listeners 数组，长会话反复渲染会累积大量指向已销毁 DOM 的监听器引用
        // （数组持有引用导致旧 DOM 与监听器永不释放）。持久容器（render 的 containerEl）仍走 on()。
        var tmpListeners = [];

        function on(el, event, handler) {
            if (!el) return;
            el.addEventListener(event, handler);
            listeners.push({ el: el, event: event, handler: handler });
        }

        function tmpOn(el, event, handler) {
            if (!el) return;
            el.addEventListener(event, handler);
            tmpListeners.push({ el: el, event: event, handler: handler });
        }

        function offAll() {
            while (listeners.length > 0) {
                var item = listeners.pop();
                item.el.removeEventListener(item.event, item.handler);
            }
        }

        function offTmpAll() {
            while (tmpListeners.length > 0) {
                var item = tmpListeners.pop();
                item.el.removeEventListener(item.event, item.handler);
            }
        }

        // 弹窗（编辑/安装/确认）监听走独立通道 dlgListeners：弹窗关闭即解绑。
        // 若复用持久 listeners 数组，关闭路径只移除 DOM 不解绑，数组持有引用导致
        // 旧弹窗 DOM 与监听器永不释放（反复开-关持续累积，仅模块 destroy 时清理）。
        // 也不并入 tmpListeners：后者随 renderList 重建清理，弹窗开着时误清会让按钮失灵。
        var dlgListeners = [];

        function dlgOn(el, event, handler) {
            if (!el) return;
            el.addEventListener(event, handler);
            dlgListeners.push({ el: el, event: event, handler: handler });
        }

        function offDlgAll() {
            while (dlgListeners.length > 0) {
                var item = dlgListeners.pop();
                item.el.removeEventListener(item.event, item.handler);
            }
        }

        // 作用域多选胶囊样式已由共享组件 AEScopePicker(client/shared/scopePicker.js) 接管，此处不再使用

        function setRegistry(reg) {
            registry = reg;
        }

        function setInstaller(installer) {
            skillInstaller = installer;
        }

        function setSettingsStore(store) {
            settingsStore = store;
        }

        function _notifyChange() {
            if (typeof onSkillListChanged === 'function') {
                onSkillListChanged();
            }
        }

        function getSkills() {
            if (!registry || typeof registry.getAll !== 'function') return [];
            return registry.getAll() || [];
        }

        function getFilteredSkills() {
            var skills = getSkills();
            if (currentFilter === 'all') return skills;
            if (currentFilter === 'global') {
                return skills.filter(function(s) {
                    return s.scope && s.scope.type === 'global';
                });
            }
            if (currentFilter === 'module') {
                return skills.filter(function(s) {
                    return s.scope && s.scope.type === 'module';
                });
            }
            return skills;
        }

        function applyFilter(filterName) {
            currentFilter = filterName;
            renderList();
            updateFilterButtons();
        }

        function updateFilterButtons() {
            var container = document.getElementById('skillMgmtBody');
            if (!container) return;
            var btns = container.querySelectorAll('.mgmt-filter-btn');
            for (var i = 0; i < btns.length; i++) {
                var btn = btns[i];
                var f = btn.getAttribute('data-filter');
                if (f === currentFilter) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            }
        }

        // 过滤按钮上的计数（全部/全局/模块）只在 render() 首次渲染时写入，
        // 删除/安装 skill 后须重新计算，否则按钮数值停留在旧值。
        // 文案与 render() 同一批模板 key：两处都走 t()，否则这里整段改写 textContent
        // 会把首次渲染的译文覆盖回中文。
        function updateFilterCounts() {
            var container = document.getElementById('skillMgmtBody');
            if (!container) return;
            var btns = container.querySelectorAll('.mgmt-filter-btn');
            if (!btns.length) return;

            var skills = getSkills();
            var globalCount = 0;
            var moduleCount = 0;
            for (var i = 0; i < skills.length; i++) {
                var s = skills[i];
                if (s.scope && s.scope.type === 'global') globalCount++;
                else if (s.scope && s.scope.type === 'module') moduleCount++;
            }

            var labels = { all: '全部 ({n})', global: '全局 ({n})', module: '模块 ({n})' };
            var counts = { all: skills.length, global: globalCount, module: moduleCount };
            for (var j = 0; j < btns.length; j++) {
                var f = btns[j].getAttribute('data-filter');
                if (counts.hasOwnProperty(f)) {
                    btns[j].textContent = AEI18n.t(labels[f], { n: counts[f] });
                }
            }
        }

        function renderList() {
            updateFilterCounts();
            var body = document.getElementById('skillMgmtBody');
            if (!body) return;

            var skills = getFilteredSkills();
            var listContainer = body.querySelector('.mgmt-list-container');
            if (!listContainer) return;

            // 重建前清理上一批列表监听：下方空列表/表格两条路径都会整体替换 innerHTML，
            // 旧元素即将销毁，先摘除监听并清空 tmpListeners，使其任一时刻至多持有一批
            offTmpAll();

            if (skills.length === 0) {
                listContainer.innerHTML = AEI18n.html('<div class="mgmt-empty">暂无 Skill。点击上方"安装 Skill"添加。</div>');
                return;
            }

            var html = '<div class="mgmt-table-wrap"><table class="mgmt-table"><thead><tr>';
            html += AEI18n.html('<th class="col-name">名称</th><th class="col-desc">描述</th><th class="col-cat">分类</th><th class="col-scope">作用域</th><th class="col-tokens">Token</th><th class="col-toggle">启用</th><th class="col-actions">操作</th>');
            html += '</tr></thead><tbody>';

            for (var i = 0; i < skills.length; i++) {
                var s = skills[i];
                var scopeLabel = (s.scope && s.scope.type === 'global') ? '全局' : '模块';
                var scopeClass = (s.scope && s.scope.type === 'global') ? 'global' : 'module';
                var scopeTitle = scopeLabel;
                if (s.scope && s.scope.type === 'module') {
                    var sMods = s.scope.moduleIds || (s.scope.moduleId ? [s.scope.moduleId] : []);
                    if (sMods.length) scopeTitle += ' (' + sMods.join(', ') + ')';
                    var sModes = s.scope.agentModes || (s.scope.mode ? [s.scope.mode] : []);
                    if (sMods.indexOf('agent') >= 0 && sModes.length) {
                        // 模式名走共享映射（外接显示「外接」，不是裸 id external-mcp）
                        var spLblS = global.AEScopePicker;
                        var sModeNames = (spLblS && typeof spLblS.modeShortLabels === 'function')
                            ? spLblS.modeShortLabels(sModes) : sModes;
                        scopeTitle += ' · Agent:' + sModeNames.join('/');
                    }
                }

                html += '<tr data-skill-id="' + escHtml(s.id) + '">';
                html += '<td class="mgmt-name" title="' + escHtml(s.id) + '">' + escHtml(s.name || s.id) + '</td>';
                html += '<td class="mgmt-desc" title="' + escHtml(s.description || '') + '">' + escHtml((s.description || '').substring(0, 80)) + '</td>';
                html += '<td class="mgmt-badge-cell"><span class="mgmt-badge">' + escHtml(s.category || '-') + '</span></td>';
                html += '<td class="mgmt-badge-cell"><span class="mgmt-badge ' + scopeClass + '" title="' + escHtml(scopeTitle) + '">' + scopeLabel + '</span></td>';
                html += '<td class="mgmt-num">~' + estimateTokens(s.prompt) + '</td>';
                html += '<td class="mgmt-toggle-cell"><label class="toggle-wrap"><input type="checkbox" class="switch-input skill-toggle" data-skill-id="' + escHtml(s.id) + '"' + (s.enabled !== false ? ' checked' : '') + '><span class="switch-slider"></span></label></td>';
                html += '<td class="mgmt-actions-cell"><div class="action-row" style="gap:4px;flex-wrap:nowrap;"><button class="btn secondary skill-edit-btn" data-skill-id="' + escHtml(s.id) + '" style="padding:5px 10px;font-size:11px;">' + AEI18n.t('编辑') + '</button><button class="btn secondary skill-uninstall-btn" data-skill-id="' + escHtml(s.id) + '" style="padding:5px 10px;font-size:11px;color:#ef6666;border-color:rgba(239,102,102,.3);">' + AEI18n.t('卸载') + '</button></div></td>';
                html += '</tr>';
            }

            html += '</tbody></table></div>';
            listContainer.innerHTML = html;

            bindListEvents(listContainer);
        }

        function bindListEvents(container) {
            var toggles = container.querySelectorAll('.skill-toggle');
            for (var i = 0; i < toggles.length; i++) {
                tmpOn(toggles[i], 'change', function(e) {
                    var skillId = this.getAttribute('data-skill-id');
                    var enabled = !!this.checked;
                    toggleSkill(skillId, enabled);
                });
            }

            var editBtns = container.querySelectorAll('.skill-edit-btn');
            for (var k = 0; k < editBtns.length; k++) {
                tmpOn(editBtns[k], 'click', function(e) {
                    e.stopPropagation();
                    var skillId = this.getAttribute('data-skill-id');
                    showEditDialog(skillId);
                });
            }

            var uninstallBtns = container.querySelectorAll('.skill-uninstall-btn');
            for (var u = 0; u < uninstallBtns.length; u++) {
                tmpOn(uninstallBtns[u], 'click', function(e) {
                    e.stopPropagation();
                    var skillId = this.getAttribute('data-skill-id');
                    uninstallSkill(skillId);
                });
            }
        }

        function uninstallSkill(skillId) {
            if (!registry || !registry.get) return;
            var skill = registry.get(skillId);
            if (!skill) return;

            var name = skill.name || skillId;
            _showConfirmModal(
                AEI18n.t('卸载 Skill'),
                AEI18n.t('确定卸载 <b>{name}</b> 吗？将删除文件夹和索引，不可恢复。', { name: escHtml(name) }),
                function () {
                    // 1. 从内存注册表移除
                    registry.unregister(skillId);

                    var skillsDir = _getSkillsDir();
                    var skillDir = skillsDir
                        ? (skillsDir + '\\' + _skillDirName(skill, skillId)) : '';

                    // 卸载后的公共收尾：清理 _disabledSkills 僵尸条目 + 刷新列表
                    function _afterRemoved() {
                        // 3. 清理 _disabledSkills 僵尸条目（与 LLM 删除路径 _modeDelete 对齐）：
                        // 禁用中的 skill 卸载后遗留条目，会让重装的 skill 被 bootstrap 恢复成禁用
                        // 读-改-写必须并入 serializeDisabledSkillsUpdate 共享串行化链
                        //（与 toggleSkill / llmTools setEnabled、delete 同域）。链外
                        // fire-and-forget 写与链内并发 toggle 各自基于同一快照整包回写、
                        // 后写者覆盖先写者——卸载清理会被并发 toggle 复活成僵尸禁用项
                        if (settingsStore && typeof settingsStore.getModuleSettings === 'function') {
                            _serializeDisabled(function () {
                                return settingsStore.getModuleSettings(currentModuleId, {}).then(function (moduleSettings) {
                                    if (moduleSettings && Array.isArray(moduleSettings._disabledSkills)) {
                                        var di = moduleSettings._disabledSkills.indexOf(skillId);
                                        if (di >= 0) {
                                            moduleSettings._disabledSkills.splice(di, 1);
                                            return settingsStore.setModuleSettings(currentModuleId, moduleSettings);
                                        }
                                    }
                                    return null;
                                });
                            }).then(function (writeOk) {
                                // 写盘失败 resolve false（配额满/加密异常）被
                                // 静默吞掉——僵尸禁用条目残留磁盘，重装同名 skill 会被 bootstrap
                                // 恢复成禁用。console.warn 如实留痕（卸载主流程不受影响）
                                if (writeOk === false) {
                                    console.warn('[SkillView] 清理已卸载 Skill "' + name + '" 的禁用条目失败（写入返回 false）：重装后可能被恢复为禁用');
                                }
                            }).catch(function () { /* 清理失败不影响卸载主流程 */ });
                        }

                        // 4. 刷新
                        _notifyChange();
                        renderList();
                        updateFilterButtons();
                        if (global.AEToast && typeof global.AEToast.show === 'function') {
                            // AEToast.show 内部已做 HTML 转义，这里直接传原始名，避免双重转义
                            global.AEToast.show('Skill "' + name + AEI18n.t('" 已卸载'), 'success');
                        }
                    }

                    // 删除失败：恢复注册并如实提示——不能静默渲染"已卸载"
                    //（文件仍在磁盘，重启后会重新加载）
                    function _failRestore(msg) {
                        try { if (typeof registry.register === 'function') registry.register(skill); } catch (_) {}
                        if (global.AEToast && typeof global.AEToast.error === 'function') {
                            global.AEToast.error(msg);
                        }
                        renderList();
                        updateFilterButtons();
                    }

                    // 2. 递归删除整个技能目录（数据目录唯一源）：
                    // 目录化后技能是「SKILL.md + techniques/、reference/ 等附件」的目录树，
                    // 只删 SKILL.md + 非递归 rmdir——目录含附件时 rmdir 静默失败，
                    // 附件残留在磁盘上（重启后可能以残缺技能重新加载）。
                    // skillFs.removeTree 内部按 removeDirRecursive → 逐文件 delete+rmdir →
                    // 同步兜底三级降级；「目录本来就不存在」返回 ok:true,removed:false
                    //（已被手动删除/回滚残留）→ 视为已卸载，与旧 anyFileFound 语义一致。
                    var fsMod = _skillFsModule();
                    if (fsMod && typeof fsMod.removeTree === 'function'
                        && skillDir && typeof AEFS !== 'undefined') {
                        fsMod.removeTree(AEFS, skillDir).then(function (removeRes) {
                            if (removeRes && removeRes.ok === true) {
                                _afterRemoved();
                                return;
                            }
                            _failRestore(AEI18n.t('卸载失败：删除技能目录失败（{error}，已恢复列表）', {
                                error: (removeRes && removeRes.error) || AEI18n.t('未知错误')
                            }));
                        }, function (err) {
                            _failRestore(AEI18n.t('卸载失败：删除技能目录异常（{error}，已恢复列表）', {
                                error: (err && err.message) || err
                            }));
                        });
                        return;
                    }

                    // 旧路径（无 skillFs / 独立加载回落）：删 SKILL.md + 非递归 rmdir。
                    // AEFS 同步 API 失败返回 false 而非抛错：deleteFileSync 失败必须提示并恢复，
                    // 不能静默渲染"已卸载"（文件仍在，重启后会重新加载）
                    var candidateDirs = [];
                    if (skillDir) candidateDirs.push(skillDir);

                    var delOk = false;
                    var anyFileFound = false;
                    for (var p = 0; p < candidateDirs.length; p++) {
                        var legacyDir = candidateDirs[p];
                        var skillMd = legacyDir + '\\SKILL.md';
                        var fileExists = false;
                        try { fileExists = typeof AEFS.existsSync === 'function' && !!AEFS.existsSync(skillMd); } catch (_) { fileExists = false; }
                        if (!fileExists) continue;
                        anyFileFound = true;
                        var ok = false;
                        try { ok = AEFS.deleteFileSync(skillMd) === true; } catch (_) { ok = false; }
                        if (!ok) { delOk = false; break; }
                        try { AEFS.rmdirSync(legacyDir); } catch (_) {} // 非递归，目录非空会失败——天然安全
                        delOk = true;
                    }
                    // 所有候选位置都没有文件（已被手动删除/回滚残留）→ 视为已删除
                    if (!anyFileFound) delOk = true;

                    if (!delOk) {
                        _failRestore(AEI18n.t('卸载失败：SKILL.md 删除失败（已恢复列表）'));
                        return;
                    }
                    _afterRemoved();
                }
            );
        }

        function _showConfirmModal(title, message, onConfirm) {
            var existing = document.getElementById('skillConfirmModal');
            if (existing) existing.parentNode.removeChild(existing);

            var overlay = document.createElement('div');
            overlay.className = 'modal-mask';
            overlay.id = 'skillConfirmModal';
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
            overlay.style.zIndex = '101';

            var box = document.createElement('div');
            box.className = 'modal confirm-modal';
            box.style.opacity = '1';
            box.style.transform = 'none';
            box.innerHTML =
                '<div class="modal-head"><span>' + escHtml(title) + '</span></div>'
                + '<div class="modal-body">'
                + '<p style="margin:0;font-size:13px;line-height:1.6;color:var(--btn-text);">' + message + '</p>'
                + '</div>'
                + '<div class="btn-row" style="padding:12px 20px;border-top:1px solid rgba(255,255,255,.06);display:flex;gap:8px;justify-content:flex-end;">'
                + '<button class="btn secondary" id="skillConfirmCancelBtn">' + AEI18n.t('取消') + '</button>'
                + '<button class="btn" id="skillConfirmOkBtn" style="border-color:rgba(239,102,102,.4);color:#ef6666;">' + AEI18n.t('确认卸载') + '</button>'
                + '</div>';

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            var close = function () {
                offDlgAll();
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            };

            dlgOn(overlay, 'click', function (e) { if (e.target === overlay) close(); });
            document.getElementById('skillConfirmCancelBtn').addEventListener('click', close);
            document.getElementById('skillConfirmOkBtn').addEventListener('click', function () {
                close();
                onConfirm();
            });
        }

        // toggle 串行化：getModuleSettings 的读在 settingsStore 写锁外返回快照，
        // 两个并发 toggle 各自基于同一快照改 _disabledSkills 再整体覆盖写回，
        // 后写者会丢掉先写者的数组项（读-改-写竞态）。用 promise 链把读-改-写
        // 串成原子序列（对齐 settingsStore._serializedWrite 模式），后到 toggle
        // 基于先到者写完后的最新值修改，不再丢更新。
        var _toggleChain = Promise.resolve();
        function _serializedToggle(fn) {
            var run = _toggleChain.then(fn, fn);
            // 防止链断裂：吞掉 run 中的错误，由调用方自行处理
            _toggleChain = run.catch(function() {});
            return run;
        }
        // 优先与 LLM 侧（llmTools.js setEnabled/delete）共享 AESkillManager 上
        // 的同一条串行化链，UI toggle 与 LLM setEnabled 并发写 _disabledSkills 不再
        // 互相丢更新；llmTools 未加载的独立环境（单测）回退本地链，语义不变。
        function _serializeDisabled(fn) {
            var shared = (global.AESkillManager && typeof global.AESkillManager.serializeDisabledSkillsUpdate === 'function')
                ? global.AESkillManager.serializeDisabledSkillsUpdate
                : null;
            return shared ? shared(fn) : _serializedToggle(fn);
        }

        async function toggleSkill(skillId, enabled) {
            if (!registry) return;
            if (typeof registry.setSkillEnabled === 'function') {
                registry.setSkillEnabled(skillId, enabled);
            }
            // 启用状态影响 Skill 工具静态描述（stub 名单）与 <available_skills>，
            // 与安装/卸载/编辑路径一致，变更后立即刷新工具描述
            _notifyChange();
            if (settingsStore && typeof settingsStore.setModuleSettings === 'function') {
                // setModuleSettings 写失败是 resolve false（配额满/加密异常），不是 reject——
                // 内层需 return 写盘结果，否则外层只 catch rejection，false 被静默吞掉。
                // 写盘结果、外层 === false 时按 llmTools setEnabled 同款文案弹错（本次会话已生效）。
                var _persistOk = await _serializeDisabled(async function () {
                    try {
                        var moduleSettings = await settingsStore.getModuleSettings(currentModuleId, {});
                        var disabledSkills = moduleSettings._disabledSkills || [];
                        if (enabled) {
                            var idx = disabledSkills.indexOf(skillId);
                            if (idx >= 0) disabledSkills.splice(idx, 1);
                        } else {
                            if (disabledSkills.indexOf(skillId) < 0) disabledSkills.push(skillId);
                        }
                        moduleSettings._disabledSkills = disabledSkills;
                        return await settingsStore.setModuleSettings(currentModuleId, moduleSettings);
                    } catch (e) {
                        // 持久化异常须告知（与 llmTools setEnabled 一致）：否则是未捕获 rejection，
                        // 且开关看似生效、重启后回退。异常已在此弹错，不返回 false，
                        // 避免外层再弹一次（只有 resolve false 才轮到外层）
                        if (global.AEToast && typeof global.AEToast.error === 'function') {
                            global.AEToast.error(AEI18n.t('开关状态保存失败: ') + (e && e.message ? e.message : String(e)) + AEI18n.t('（本次会话已生效，重启后回退）'));
                        }
                        return;
                    }
                });
                if (_persistOk === false) {
                    // 写失败：内存开关已生效，如实告知不会在重启后保留
                    if (global.AEToast && typeof global.AEToast.error === 'function') {
                        global.AEToast.error(AEI18n.t('开关状态保存失败（本地存储写入被拒绝）：「') + skillId + AEI18n.t('」本次会话已生效，重启后回退'));
                    }
                }
            }
        }

        function showEditDialog(skillId) {
            var existing = document.getElementById('skillEditModal');
            if (existing) existing.parentNode.removeChild(existing);

            var skill = registry && registry.get ? registry.get(skillId) : null;
            if (!skill) return;

            var currentScopeType = (skill.scope && skill.scope.type === 'global') ? 'global' : 'module';
            var currentMods = [];
            var currentModes = [];
            if (skill.scope && skill.scope.type === 'module') {
                currentMods = skill.scope.moduleIds || (skill.scope.moduleId ? [skill.scope.moduleId] : []);
                currentModes = skill.scope.agentModes || (skill.scope.mode ? [skill.scope.mode] : []);
            }

            var overlay = document.createElement('div');
            overlay.className = 'modal-mask';
            overlay.id = 'skillEditModal';
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
            overlay.style.zIndex = '100';

            var box = document.createElement('div');
            box.className = 'modal';
            box.style.opacity = '1';
            box.style.transform = 'none';
            box.style.width = 'min(560px, 92vw)';

            box.innerHTML = AEI18n.html('<div class="modal-head"><span>编辑 Skill</span><button class="icon-btn" id="skillEditCloseBtn">关闭</button></div>')
                + '<div class="modal-body">'
                + '<div class="row"><label>' + AEI18n.t('名称') + '</label><input type="text" id="skillEditName" value="' + escHtml(skill.name || '') + '"></div>'
                + '<div class="row"><label>' + AEI18n.t('描述') + '</label><input type="text" id="skillEditDesc" value="' + escHtml(skill.description || '') + '"></div>'
                + '<div class="row"><label>' + AEI18n.t('分类') + '</label><input type="text" id="skillEditCategory" value="' + escHtml(skill.category || '') + '" placeholder="general"></div>'
                + AEI18n.html('<div class="row"><label>正文内容 (Prompt)</label><textarea id="skillEditBody" rows="14" style="font-family:monospace;font-size:12px;resize:vertical;">') + escHtml(skill.prompt || skill.body || '') + '</textarea></div>'
                + AEI18n.html('<div class="row"><label>作用域</label>')
                + '<label class="toggle-wrap"><input type="checkbox" class="switch-input" id="skillEditScopeToggle"' + (currentScopeType === 'module' ? ' checked' : '') + '><span class="switch-slider"></span><span style="margin-left:8px;font-size:12px;color:var(--text-muted);">' + AEI18n.t('限定模块') + '</span></label>'
                + '</div>'
                + '<div class="row" id="skillEditModuleRow" style="' + (currentScopeType === 'module' ? '' : 'display:none;') + '">'
                + AEI18n.html('<label>目标模块</label><div id="skillEditScopePickerContainer"></div></div>')
                + '</div>'
                + '<div class="btn-row" style="padding:12px 20px;border-top:1px solid rgba(255,255,255,.06);display:flex;gap:8px;align-items:center;justify-content:flex-end;">'
                + '<span class="status-inline" id="skillEditStatus" style="display:none;margin-right:auto;max-width:260px;"></span>'
                + AEI18n.html('<button class="btn secondary" id="skillEditCancelBtn">取消</button>')
                + AEI18n.html('<button class="btn" id="skillEditConfirmBtn">保存</button>')
                + '</div>';

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            overlay._editingSkillId = skillId;

            // 目标模块容纳框：共享组件 AEScopePicker（点击弹窗逐模块+模式添加）
            var scopeEditPicker = null;
            var scopeEditContainer = document.getElementById('skillEditScopePickerContainer');
            if (scopeEditContainer && global.AEScopePicker) {
                scopeEditPicker = global.AEScopePicker.create({
                    container: scopeEditContainer,
                    modules: availableModules,
                    value: { moduleIds: currentMods, agentModes: currentModes }
                });
                overlay._editingScopePicker = scopeEditPicker;
            }

            dlgOn(overlay, 'click', function(e) {
                if (e.target === overlay) hideEditDialog();
            });

            var closeEditBtn = document.getElementById('skillEditCloseBtn');
            if (closeEditBtn) dlgOn(closeEditBtn, 'click', hideEditDialog);
            var cancelBtn = document.getElementById('skillEditCancelBtn');
            if (cancelBtn) dlgOn(cancelBtn, 'click', hideEditDialog);

            var confirmBtn = document.getElementById('skillEditConfirmBtn');
            if (confirmBtn) dlgOn(confirmBtn, 'click', confirmEdit);

            var scopeToggleEdit = document.getElementById('skillEditScopeToggle');
            if (scopeToggleEdit) {
                dlgOn(scopeToggleEdit, 'change', function() {
                    var moduleRow = document.getElementById('skillEditModuleRow');
                    if (moduleRow) moduleRow.style.display = this.checked ? '' : 'none';
                });
            }
        }

        function hideEditDialog() {
            // 弹窗监听随关闭解绑（modal 不在时也执行，清理异常路径残留）
            offDlgAll();
            var modal = document.getElementById('skillEditModal');
            if (modal && modal.parentNode) {
                if (modal._editingScopePicker) { try { modal._editingScopePicker.destroy(); } catch (_) {} modal._editingScopePicker = null; }
                modal.parentNode.removeChild(modal);
            }
        }

        function confirmEdit() {
            var modal = document.getElementById('skillEditModal');
            if (!modal) return;
            var skillId = modal._editingSkillId;
            if (!registry || !registry.updateSkill) return;

            var nameEl = document.getElementById('skillEditName');
            var descEl = document.getElementById('skillEditDesc');
            var catEl = document.getElementById('skillEditCategory');
            var bodyEl = document.getElementById('skillEditBody');
            var scopeToggleEdit3 = document.getElementById('skillEditScopeToggle');
            var statusEl = document.getElementById('skillEditStatus');

            var scopeType = (scopeToggleEdit3 && scopeToggleEdit3.checked) ? 'module' : 'global';

            var updates = {};
            if (nameEl) updates.name = nameEl.value.trim();
            if (descEl) updates.description = descEl.value.trim();
            if (catEl) updates.category = catEl.value.trim();
            if (bodyEl) updates.prompt = bodyEl.value;

            if (scopeType === 'module') {
                // 目标模块容纳框：读取共享组件的模块 + agent 模式
                var mods = [];
                var modes = [];
                if (modal._editingScopePicker) {
                    var svEdit = modal._editingScopePicker.getValue();
                    mods = svEdit.moduleIds || [];
                    modes = svEdit.agentModes || [];
                }
                var newScope = { type: 'module', moduleIds: mods.length ? mods : ['agent'] };
                // 勾选"全部模式"或未限定模式时，不写 agentModes（= agent/script/shader 全部生效）
                if (mods.indexOf('agent') >= 0 && modes.length) newScope.agentModes = modes;
                updates.scope = newScope;
            } else {
                updates.scope = { type: 'global' };
            }

            var result = registry.updateSkill(skillId, updates);
            if (result.ok) {
                // 写回 SKILL.md 文件，刷新/重启后自动重新加载。
                // 失败须提示并保留弹窗（内存已更新、重启后回退），否则静默丢编辑；
                // 点"保存"可重试（updateSkill 幂等）
                if (!_writeSkillToDisk(skillId)) {
                    if (statusEl) {
                        statusEl.textContent = AEI18n.t('保存失败: SKILL.md 磁盘写入失败（本次已生效，重启后回退）');
                        statusEl.style.color = '#ff6b6b';
                        statusEl.style.display = 'inline-flex';
                    }
                    return;
                }
                hideEditDialog();
                _notifyChange();
                renderList();
                updateFilterButtons();
            } else {
                if (statusEl) {
                    // detail 优先（如「name 不能包含双引号（"）」的具体原因），
                    // 无 detail 的旧错误码路径（NOT_FOUND/长度超限）仍显示 error 码
                    statusEl.textContent = AEI18n.t('保存失败: ') + (result.detail || result.error || AEI18n.t('未知错误'));
                    statusEl.style.color = '#ff6b6b';
                    statusEl.style.display = 'inline-flex';
                }
            }
        }

        // ── 磁盘读写辅助 ──

        function _getDataDir() {
            // 统一数据目录由 AEShared 提供；不可用时返回空串，由调用方兜底处理。
            // （旧兜底 _getExtensionRoot 扩展目录源已随统一数据目录重构移除，
            //   其兜底还会拼出 ...\skills\skills 双重目录）
            return (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                ? global.AEShared.getDataDir().dir
                : '';
        }

        function _getSkillsDir() {
            var d = _getDataDir();
            return d ? d + '\\skills' : '';
        }

        function _writeCepFile(path, content) {
            var fp = (path || '').replace(/\//g, '\\');
            // 同步原子写（.tmp → renameFileSync，对齐 memoryStore 的同款助手）——
            // 直写中断留半截 SKILL.md，重启后 skill 加载失败。renameFileSync 仅
            // Bridge 可用，失败回退直写并清理 .tmp
            var ok;
            if (typeof AEFS.renameFileSync !== 'function') {
                ok = AEFS.writeFileSync(fp, content);
            } else {
                var tmpPath = fp + '.tmp';
                ok = AEFS.writeFileSync(tmpPath, content) && AEFS.renameFileSync(tmpPath, fp);
                if (!ok) {
                    ok = AEFS.writeFileSync(fp, content);
                    try { if (AEFS.deleteFileSync) AEFS.deleteFileSync(tmpPath); } catch (_) {}
                }
            }
            if (!ok) console.warn('[SkillView] write failed: ' + fp);
            return ok;
        }

        // 序列化/scope 注入用 skillCreator.js 的共享实现（serializeSkillMd / injectScopeToSkillMd），
        // 避免与 LLM 安装链路各持一份副本漂移

        // 技能目录名：扫描加载的技能文件夹名 ≠ id 时（kebab 归一化），磁盘操作按
        // 真实文件夹名走——否则卸载删不掉、编辑写错目录（共享实现见 skillCreator）
        function _skillDirName(entry, fallbackId) {
            if (global.AE_LLM && typeof global.AE_LLM.resolveSkillDirName === 'function') {
                return global.AE_LLM.resolveSkillDirName(entry, fallbackId);
            }
            return (entry && entry.id) ? entry.id : String(fallbackId || '');
        }

        function _writeSkillToDisk(skillId, rawContent) {
            if (!registry) return false;
            var skill = registry.get(skillId);
            if (!skill) return false;
            var skillsDir = _getSkillsDir();
            if (!skillsDir) return false;
            var inject = global.AE_LLM && global.AE_LLM.injectScopeToSkillMd;
            var serialize = global.AE_LLM && global.AE_LLM.serializeSkillMd;
            if (typeof inject !== 'function' || typeof serialize !== 'function') {
                console.warn('[SkillView] skillCreator 共享 API 不可用，跳过写盘: ' + skillId);
                return false;
            }
            var skillMdPath = skillsDir + '\\' + _skillDirName(skill, skillId) + '\\SKILL.md';
            // 如果提供了原始内容，注入 scope 后写入（保留原始 frontmatter）
            // 否则从 registry 重建
            var content = rawContent
                ? inject(rawContent, skill.scope)
                : serialize(skill);
            return _writeCepFile(skillMdPath, content);
        }

        // 安装落盘统一出口：磁盘写入失败时回滚注册并报错——否则 UI 报"安装成功"但
        // 磁盘无文件，重启后 skill 消失（内存/磁盘不一致；与 llmTools install 回滚对齐）
        function _finishInstallToDisk(result, content, setStatus) {
            if (_writeSkillToDisk(result.entry.id, content)) return true;
            try { registry.unregister(result.entry.id); } catch (_) {}
            setStatus(AEI18n.t('安装失败: SKILL.md 磁盘写入失败（已回滚注册）'), true);
            return false;
        }

        function showInstallWizard() {
            var existing = document.getElementById('skillInstallModal');
            if (existing) existing.parentNode.removeChild(existing);

            var overlay = document.createElement('div');
            overlay.className = 'modal-mask';
            overlay.id = 'skillInstallModal';
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
            overlay.style.zIndex = '100';

            var box = document.createElement('div');
            box.className = 'modal skill-install-modal';
            box.style.opacity = '1';
            box.style.transform = 'none';

            box.innerHTML =
                AEI18n.html('<div class="modal-head"><span>安装新 Skill</span><button class="icon-btn" id="skillInstallCloseBtn">关闭</button></div>')
                + '<div class="modal-body skill-install-body">'
                + '<div class="skill-install-tabs">'
                + AEI18n.html('<button class="skill-install-tab active" data-tab="file">文件路径</button>')
                + AEI18n.html('<button class="skill-install-tab" data-tab="url">URL 安装</button>')
                + AEI18n.html('<button class="skill-install-tab" data-tab="paste">粘贴内容</button>')
                + '</div>'
                + '<div class="skill-install-panel">'
                + '<div class="skill-install-field" id="skillTabFile">'
                + AEI18n.html('<input type="text" id="skillFilePath" placeholder="选择包含 SKILL.md 的文件夹">')
                + AEI18n.html('<button class="btn secondary" id="skillFileBrowseBtn">浏览…</button>')
                + '</div>'
                + '<div class="skill-install-field" id="skillTabUrl" style="display:none;">'
                // 目录化技能：GitHub tree/blob 目录链接可整目录安装（SKILL.md + 附件），
                // raw SKILL.md 链接走单文件安装（该来源无法枚举同目录附件）
                + AEI18n.html('<input type="text" id="skillUrl" placeholder="技能目录或 SKILL.md 链接，如 https://github.com/anthropics/skills/tree/main/skills/pdf">')
                + '</div>'
                + '<div class="skill-install-field" id="skillTabPaste" style="display:none;">'
                + '<textarea id="skillPasteContent" rows="8" placeholder="---&#10;name: my-skill&#10;description: ...&#10;---&#10;&#10;# Skill Content&#10;..."></textarea>'
                + '</div>'
                + '</div>'
                + '<div class="skill-install-options">'
                + AEI18n.html('<label class="toggle-wrap"><input type="checkbox" class="switch-input" id="skillInstallScopeToggle"><span class="switch-slider"></span><span>限定模块</span></label>')
                + '<div id="skillInstallModuleWrap" style="display:none;margin-top:8px;flex:1;min-width:0;width:100%;"><div id="skillInstallScopePickerContainer" style="width:100%;"></div></div>'
                + '</div>'
                + '</div>'
                + '<div class="skill-install-footer">'
                + '<span class="status-inline" id="skillInstallStatus" style="display:none;"></span>'
                + '<button class="btn" id="skillInstallConfirmBtn">' + AEI18n.t('确认安装') + '</button>'
                + '</div>';

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            dlgOn(overlay, 'click', function(e) {
                if (e.target === overlay) hideInstallWizard();
            });
            var closeBtn = document.getElementById('skillInstallCloseBtn');
            if (closeBtn) dlgOn(closeBtn, 'click', hideInstallWizard);

            var confirmBtn = document.getElementById('skillInstallConfirmBtn');
            if (confirmBtn) dlgOn(confirmBtn, 'click', confirmInstall);

            var tabBtns = box.querySelectorAll('.skill-install-tab');
            for (var i = 0; i < tabBtns.length; i++) {
                (function(tab) {
                    dlgOn(tab, 'click', function() {
                        switchModalTab(tab.getAttribute('data-tab'), box);
                    });
                })(tabBtns[i]);
            }

            var browseBtn = document.getElementById('skillFileBrowseBtn');
            if (browseBtn) {
                dlgOn(browseBtn, 'click', function () { _browseSkillFolder(); });
            }

            var scopeToggle = document.getElementById('skillInstallScopeToggle');
            if (scopeToggle) {
                dlgOn(scopeToggle, 'change', function() {
                    // 控制外层 wrap 的显示
                    var moduleWrap = document.getElementById('skillInstallModuleWrap');
                    if (moduleWrap) moduleWrap.style.display = this.checked ? '' : 'none';
                });
            }

            // 目标模块容纳框：共享组件 AEScopePicker（点击弹窗逐模块+模式添加）
            var scopeInstallContainer = document.getElementById('skillInstallScopePickerContainer');
            if (scopeInstallContainer && global.AEScopePicker) {
                overlay._installScopePicker = global.AEScopePicker.create({
                    container: scopeInstallContainer,
                    modules: availableModules,
                    value: { moduleIds: [], agentModes: [] }
                });
            }
        }

        // 下载进行态（installFromUrl 与下载弹窗取消按钮共享）——「当前请求」的 abort
        // 控制器 + 「用户取消」标志（区分用户取消与超时，两者都让 fetch 以 AbortError
        // reject，catch 分支据此提示不同文案且均不落 Bridge 代理重试）。
        // 目录化改造后：abort 指向当前单个请求（每个请求自带 20s reqTimer 超时），
        // 单文件整包下载另挂 60s 总预算 timer（既有语义），abortedBy 记录中止来源
        // 以便文案如实区分「请求 20s 超时」与「整包 60s 超时」。
        var _dl = { abort: null, timer: null, reqTimer: null, reqTimeoutMs: 0, writing: false, cancelled: false, abortedBy: '' };

        function _showDownloadProgress() {
            var existing = document.getElementById('skillDownloadModal');
            if (existing) existing.parentNode.removeChild(existing);
            var overlay = document.createElement('div');
            overlay.className = 'modal-mask';
            overlay.id = 'skillDownloadModal';
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
            overlay.style.zIndex = '101';
            var box = document.createElement('div');
            box.className = 'modal';
            box.style.opacity = '1';
            box.style.transform = 'none';
            box.style.width = 'min(380px, 90vw)';
            box.innerHTML =
                AEI18n.html('<div class="modal-head"><span>正在下载</span></div>')
                + '<div class="modal-body" style="text-align:center;">'
                + '<div style="color:var(--text-muted);font-size:12px;word-break:break-all;margin-bottom:16px;line-height:1.5;" id="skillDownloadUrl"></div>'
                + '<div style="height:3px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden;">'
                + '<div style="height:100%;width:40%;background:linear-gradient(90deg,transparent,var(--accent),transparent);border-radius:2px;animation:dl-progress-scan 1.4s ease-in-out infinite;"></div>'
                + '</div>'
                + AEI18n.html('<div style="margin-top:12px;color:var(--text-muted);font-size:11px;opacity:.6;">通过系统网络下载，请稍候…</div>')
                // 取消按钮——下载悬挂时弹窗不再只能干等；点击 abort 进行中的
                // fetch（reject AbortError 由 catch 分支统一收尾提示）
                + AEI18n.html('<div style="margin-top:14px;"><button id="skillDownloadCancelBtn" style="padding:5px 18px;font-size:12px;border:1px solid rgba(255,255,255,.15);border-radius:4px;background:transparent;color:var(--text-muted,#999);cursor:pointer;">取消</button></div>')
                + '<style>@keyframes dl-progress-scan{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}</style>'
                + '</div>';
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            var urlEl = document.getElementById('skillDownloadUrl');
            var urlInput = document.getElementById('skillUrl');
            if (urlEl && urlInput) urlEl.textContent = urlInput.value.trim();
            // 绑定取消——置 cancelled 标志并 abort；后续提示文案由 catch 的
            // AbortError 分支区分（fetch 已结束时 abort 无副作用）
            var cancelBtn = document.getElementById('skillDownloadCancelBtn');
            if (cancelBtn) cancelBtn.addEventListener('click', function () {
                _dl.cancelled = true;
                if (_dl.abort) { try { _dl.abort.abort(); } catch (_) {} }
                _hideDownloadProgress();
            });
        }

        function _hideDownloadProgress() {
            // 所有下载结束路径（成功/失败/取消/超时）都经过这里，顺带清理
            // 超时定时器与 abort 引用，防止悬挂引用与到点误触发
            if (_dl.timer) { clearTimeout(_dl.timer); _dl.timer = null; }
            if (_dl.reqTimer) { clearTimeout(_dl.reqTimer); _dl.reqTimer = null; }
            _dl.abort = null;
            var modal = document.getElementById('skillDownloadModal');
            if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
        }

        // 经遮罩/关闭按钮退出向导或模块卸载（destroy）时中止进行中的下载。
        // 取消意图与「当前是否有 abort 控制器」解耦：目录安装进入写盘阶段后 _dl.abort
        // 为 null，此时关闭向导仍必须算取消——写盘完成后由流程复查 cancelled 决定回滚，
        // 不能出现「用户点了关闭、安装却静默成功」。
        function _cancelPendingDownload() {
            // 取消意图 = 「有进行中的请求」或「正在写盘」：写盘阶段 _dl.abort 已为 null，
            // 但关向导仍必须算取消（写盘完成后复查 _dl.cancelled 回滚）。
            // 两者都没有（正常完成路径先清 abort/写盘标记）→ no-op，不误置 cancelled。
            if (!_dl.abort && !_dl.writing) return;
            _dl.cancelled = true;
            if (_dl.abort) { try { _dl.abort.abort(); } catch (_) {} }
        }

        // ── 目录化技能（多文件）安装的下载通道 ──
        // 新增模块（skillRemote / skillFs）由并行任务实现，本文件一律按全局惰性读取：
        // view.js 独立加载（无 llmTools / 无这两个模块）时所有新调用都必须回落旧路径，
        // 不得因模块缺失抛错。
        function _skillFsModule() {
            return (global.AE_LLM && global.AE_LLM.skillFs) || null;
        }
        function _skillRemoteModule() {
            return (global.AE_LLM && global.AE_LLM.skillRemote) || null;
        }

        // 下载进度文案：目录安装逐文件下载时刷新弹窗 #skillDownloadUrl 文本
        //（单文件安装仍先显示 URL 首行；整体替换为进度文案是允许的）
        function _setDownloadProgress(text) {
            var el = document.getElementById('skillDownloadUrl');
            if (el) el.textContent = text;
        }

        // 流程中止/超时错误统一走 AbortError 通道（单文件下载既有 catch 分支判定不变），
        // 用 _dl.abortedBy 区分「用户取消 / 请求 20s 超时 / 整包 60s 超时」三种文案
        function _flowAbortError(kind) {
            var e = new Error(kind === 'cancel' ? '已取消下载' : '下载超时');
            e.name = 'AbortError';
            if (kind === 'cancel') e._skillCancelled = true;
            return e;
        }

        // 每个异步步骤前复查流程是否已被取消/中止：取消后不再发起后续请求、
        // 不再进入落盘阶段（目录包下载中途取消不会装出半套文件）
        function _assertFlowActive() {
            if (_dl.cancelled) throw _flowAbortError('cancel');
            if (_dl.abortedBy) throw _flowAbortError('timeout');
        }

        // 单请求生命周期：per-request AbortController + 20s 超时，期间 _dl.abort
        // 指向它——弹窗取消按钮 / 向导关闭 / 模块卸载（_cancelPendingDownload）都能
        // 立即中止当前请求。CEP 88 无 AbortController 的极端环境退回无超时旧行为
        //（不能因 API 缺失抛错，view.js 须可独立加载）。
        var _SKILL_REQ_TIMEOUT_MS = 20000;
        function _beginRequest(timeoutMs) {
            var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
            if (_dl.reqTimer) { clearTimeout(_dl.reqTimer); _dl.reqTimer = null; }
            _dl.abort = ctrl;
            // 单文件流程沿用旧的 60s 预算（慢网单个 SKILL.md 不应比改造前更早超时）；
            // 目录安装逐文件 20s（大包总时长另有整包取消语义，不设 60s 总预算）
            var ms = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : _SKILL_REQ_TIMEOUT_MS;
            _dl.reqTimeoutMs = ms;
            if (ctrl) {
                _dl.reqTimer = setTimeout(function () {
                    _dl.reqTimer = null;
                    // 请求已结束（_dl.abort 已换人/清空）：迟到的定时器不得误标超时
                    if (_dl.abort !== ctrl) return;
                    if (!_dl.abortedBy) _dl.abortedBy = 'request';
                    try { ctrl.abort(); } catch (_) {}
                }, ms);
            }
            return ctrl;
        }
        function _endRequest(ctrl) {
            if (_dl.reqTimer) { clearTimeout(_dl.reqTimer); _dl.reqTimer = null; }
            if (_dl.abort === ctrl) _dl.abort = null;
        }

        // 下载失败统一收尾：单文件既有文案逐字保留（2MB / 重定向 / Bridge / 取消 /
        // 超时），目录安装的 code 映射文案（_remoteError 标记）原样透出
        function _mapDownloadFailure(err, setStatus) {
            _hideDownloadProgress();
            if (err && err.name === 'AbortError') {
                if (_dl.cancelled) {
                    setStatus(AEI18n.t('获取失败：已取消下载'), true);
                    return;
                }
                var secs = (_dl.abortedBy === 'flow') ? 60 : Math.round((_dl.reqTimeoutMs || _SKILL_REQ_TIMEOUT_MS) / 1000);
                setStatus(AEI18n.t('获取失败：下载超时（') + secs + AEI18n.t('s），请检查网络后重试'), true);
                return;
            }
            // 大小超限是确定性失败——同一 URL 走 Bridge 代理必然同样超限，不重试
            if (err && err._skillSizeLimit) {
                setStatus(AEI18n.t('获取失败：内容超过 2MB 上限，请确认链接指向 SKILL.md'), true);
                return;
            }
            // 重定向目标非法/超跳数——确定性失败（代理同样会拒），不落代理重试
            if (err && err._skillRedirectInvalid) {
                setStatus(AEI18n.t('获取失败：') + err.message, true);
                return;
            }
            if (err && err._skillBridgeOffline) {
                setStatus(AEI18n.t('获取失败：网络不可用'), true);
                return;
            }
            if (err && err._skillBridgeHttp) {
                setStatus(AEI18n.t('获取失败：Bridge 不可用或网络错误'), true);
                return;
            }
            if (err && err._skillBridgeResult) {
                setStatus(AEI18n.t('获取失败：') + err.message, true);
                return;
            }
            if (err && err._remoteError) {
                // 目录安装的 code 映射文案已是完整中文（含操作建议），原样展示
                setStatus(err.message, true);
                return;
            }
            setStatus(AEI18n.t('获取失败：') + ((err && err.message) ? err.message : AEI18n.t('下载错误')), true);
        }

        // 供各下载 helper 判定 AbortError。注意：本 helper 必须定义在
        // _mapDownloadFailure 之后——源码断言以文件里「首个
        // err.name === 'AbortError'」为锚点，要求其后紧邻 _dl.cancelled 且在
        // CSInterface 判断之前；把本函数或任何同字面量挪到前面会让该回归断言失效。
        function _isAbortError(err) {
            return !!(err && err.name === 'AbortError');
        }

        // 扫描给定目录下包含 SKILL.md 的一级子目录，返回子目录名数组（失败或无匹配返回空数组）
        function _scanSubdirSkills(dirPath) {
            if (typeof AEFS === 'undefined' || typeof AEFS.listDirs !== 'function') return Promise.resolve([]);
            return AEFS.listDirs(dirPath).then(function (subDirs) {
                if (!Array.isArray(subDirs) || subDirs.length === 0) return [];
                var checks = [];
                for (var i = 0; i < subDirs.length; i++) {
                    (function (subName) {
                        checks.push(
                            AEFS.exists(dirPath + '/' + subName + '/SKILL.md').then(function (ok) {
                                return ok ? subName : null;
                            })
                        );
                    })(subDirs[i]);
                }
                return Promise.all(checks).then(function (results) {
                    return results.filter(function (n) { return n !== null; });
                });
            }).catch(function () { return []; });
        }

        // 选中目录后立即校验：含 SKILL.md / 含多个 skill 子目录 / 都没有
        function _validateSelectedFolder(path) {
            var statusEl = document.getElementById('skillInstallStatus');
            if (!statusEl) return;
            var normalized = path.replace(/\\/g, '/').replace(/\/?$/, '');
            var setStatus = function (msg, isError) {
                statusEl.textContent = msg;
                statusEl.style.display = msg ? 'inline-flex' : 'none';
                if (isError) {
                    statusEl.style.color = '#ef6666';
                    statusEl.style.borderColor = 'rgba(239,102,102,.3)';
                    statusEl.style.background = 'rgba(239,102,102,.08)';
                } else {
                    statusEl.style.color = '';
                    statusEl.style.borderColor = '';
                    statusEl.style.background = '';
                }
            };
            setStatus(AEI18n.t('正在校验路径...'), false);
            AEFS.exists(normalized + '/SKILL.md').then(function (ok) {
                if (ok) {
                    setStatus(AEI18n.t('已找到 SKILL.md，可点击确认安装'), false);
                } else {
                    return _scanSubdirSkills(normalized).then(function (subNames) {
                        if (subNames.length > 0) {
                            var preview = subNames.slice(0, 3).join(', ') + (subNames.length > 3 ? (' 等 ' + subNames.length + ' 个') : '');
                            setStatus(AEI18n.t('检测到 ') + subNames.length + AEI18n.t(' 个 Skill 子文件夹：') + preview + AEI18n.t('。请选择其中具体的一个。'), true);
                        } else {
                            setStatus(AEI18n.t('所选文件夹未包含 SKILL.md'), true);
                        }
                    });
                }
            }).catch(function () { setStatus('', false); });
        }

        function _browseSkillFolder() {
            if (!global.AEPickGuard) return;
            global.AEPickGuard.pickFolder({ title: AEI18n.t('选择 Skill 目录') }, function (path) {
                if (!path) return;
                var input = document.getElementById('skillFilePath');
                if (input) input.value = path;
                _validateSelectedFolder(path);
            });
        }

        function hideInstallWizard() {
            var modal = document.getElementById('skillInstallModal');
            // 守卫：仅当安装向导 modal 仍在 DOM（本次调用对应仍开着的向导）时才解绑
            // 弹窗监听。installFromPath/installFromUrl 的异步回调可能迟到——向导早已
            // 被用户关闭，dlgListeners 已被随后打开的编辑弹窗重新注册，迟到的关闭若
            // 无条件 offDlgAll 会误清编辑弹窗监听（DOM 仍在但控件失灵）。
            // 向导正常关闭（modal 在 DOM）时照旧全量解绑，不回归开-关-开累积目标。
            if (modal) offDlgAll();
            // 向导关闭（遮罩/关闭按钮）时中止进行中的下载，防静默安装
            _cancelPendingDownload();
            _hideDownloadProgress();
            if (modal && modal.parentNode) {
                if (modal._installScopePicker) { try { modal._installScopePicker.destroy(); } catch (_) {} modal._installScopePicker = null; }
                modal.parentNode.removeChild(modal);
            }
        }

        function switchModalTab(tabName, boxEl) {
            var tabs = ['file', 'url', 'paste'];
            for (var i = 0; i < tabs.length; i++) {
                var content = boxEl.querySelector('#skillTab' + (tabs[i].charAt(0).toUpperCase() + tabs[i].slice(1)));
                if (content) content.style.display = tabs[i] === tabName ? '' : 'none';
            }
            var tBtns = boxEl.querySelectorAll('.skill-install-tab');
            for (var j = 0; j < tBtns.length; j++) {
                var b = tBtns[j];
                var t = b.getAttribute('data-tab');
                if (t === tabName) b.classList.add('active');
                else b.classList.remove('active');
            }
        }

        function confirmInstall() {
            var box = document.querySelector('#skillInstallModal .modal');
            var activeTabEl = box ? box.querySelector('.skill-install-tab.active') : null;
            var activeTab = activeTabEl ? activeTabEl.getAttribute('data-tab') : 'file';
            var statusEl = document.getElementById('skillInstallStatus');
            var setStatus = function(msg, isError) {
                if (statusEl) {
                    statusEl.textContent = msg;
                    statusEl.style.display = msg ? 'inline-flex' : 'none';
                    if (isError) {
                        statusEl.style.color = '#ef6666';
                        statusEl.style.borderColor = 'rgba(239,102,102,.3)';
                        statusEl.style.background = 'rgba(239,102,102,.08)';
                    } else {
                        statusEl.style.color = '';
                        statusEl.style.borderColor = '';
                        statusEl.style.background = '';
                    }
                }
            };

            // 读取作用域（toggle 开关）
            var scopeToggle2 = document.getElementById('skillInstallScopeToggle');
            var scopeType = (scopeToggle2 && scopeToggle2.checked) ? 'module' : 'global';
            var scope = { type: scopeType };
            if (scopeType === 'module') {
                // 目标模块容纳框：读取共享组件的模块 + agent 模式
                var installModalEl = document.getElementById('skillInstallModal');
                var mods2 = [];
                var modes2 = [];
                if (installModalEl && installModalEl._installScopePicker) {
                    var svInst = installModalEl._installScopePicker.getValue();
                    mods2 = svInst.moduleIds || [];
                    modes2 = svInst.agentModes || [];
                }
                scope.moduleIds = mods2.length ? mods2 : ['agent'];
                // 勾选"全部模式"或未限定模式时，不写 agentModes（全部模式）
                if (scope.moduleIds.indexOf('agent') >= 0 && modes2.length) scope.agentModes = modes2;
            }

            if (activeTab === 'file') {
                var filePath = document.getElementById('skillFilePath');
                if (!filePath || !filePath.value.trim()) {
                    setStatus(AEI18n.t('请输入 Skill 目录路径'), true);
                    return;
                }
                installFromPath(filePath.value.trim(), scope, setStatus);
            } else if (activeTab === 'url') {
                var urlEl = document.getElementById('skillUrl');
                if (!urlEl || !urlEl.value.trim()) {
                    setStatus(AEI18n.t('请输入技能目录链接或 SKILL.md 链接'), true);
                    return;
                }
                installFromUrl(urlEl.value.trim(), scope, setStatus);
            } else if (activeTab === 'paste') {
                var pasteEl = document.getElementById('skillPasteContent');
                if (!pasteEl || !pasteEl.value.trim()) {
                    setStatus(AEI18n.t('请粘贴 SKILL.md 内容'), true);
                    return;
                }
                installFromContent(pasteEl.value.trim(), scope, setStatus);
            }
        }

        function installFromPath(path, scope, setStatus) {
            if (!skillInstaller || typeof skillInstaller.installFromContent !== 'function') {
                setStatus(AEI18n.t('Skill 安装器未就绪'), true);
                return;
            }
            scope = scope || { type: 'global' };
            setStatus(AEI18n.t('正在读取...'));

            // AEFS 异步版自带 Bridge → cep.fs → ExtendScript 全回退链
            var normalizedDir = path.replace(/\\/g, '/').replace(/\/?$/, '');
            var srcPath = normalizedDir + '/SKILL.md';

            // 旧行为（无 skillFs / 独立加载回落）：只装 SKILL.md，不复制附件目录
            // cep.fs 沙箱只能读扩展目录内文件，外部路径走 ExtendScript
            function doInstallLegacy(content) {
                var result = skillInstaller.installFromContent(content, path, registry, scope);
                if (result.ok) {
                    if (!_finishInstallToDisk(result, content, setStatus)) return;
                    setStatus(AEI18n.t('安装成功: ') + (result.entry ? result.entry.name : ''));
                    hideInstallWizard();
                    _notifyChange();
                    renderList();
                    updateFilterButtons();
                } else {
                    setStatus(result.detail || (AEI18n.t('安装失败: ') + result.error), true);
                }
            }

            function doInstall(content) {
                var fsMod = _skillFsModule();
                var skillsDir = _getSkillsDir();
                // 目录化技能：整棵目录复制到 <skills>\<id>\（SKILL.md + techniques/
                // reference/ 等附件）。skillFs 不可用（独立加载/旧环境）→ 回落旧行为。
                var canCopyTree = !!(fsMod && typeof fsMod.copyTree === 'function'
                    && skillsDir && typeof AEFS !== 'undefined');
                if (!canCopyTree) {
                    doInstallLegacy(content);
                    return;
                }
                var result = skillInstaller.installFromContent(content, path, registry, scope);
                if (!result || !result.ok) {
                    setStatus((result && (result.detail || (AEI18n.t('安装失败: ') + result.error))) || AEI18n.t('安装失败'), true);
                    return;
                }
                var targetDir = skillsDir + '\\' + result.entry.id;
                // 已存在但未注册的目标目录：拒绝合并（避免新旧附件混杂 + 失败清理误删既有目录）
                _targetDirExistsView(targetDir).then(function (dirExists) {
                    if (dirExists === true) {
                        try { registry.unregister(result.entry.id); } catch (_) {}
                        setStatus(AEI18n.t('安装失败：目标技能目录已存在（') + targetDir + AEI18n.t('），请先卸载或手动清理后重试'), true);
                        return;
                    }
                    setStatus(AEI18n.t('正在复制技能目录…'));
                fsMod.copyTree(AEFS, normalizedDir, targetDir).then(function (copyRes) {
                    if (!copyRes || copyRes.ok !== true) {
                        // 复制失败：回滚注册 + 清掉可能的半套目录，如实报错
                        try { registry.unregister(result.entry.id); } catch (_) {}
                        _cleanupSkillDir(fsMod, targetDir);
                        setStatus(AEI18n.t('安装失败：复制技能目录失败（')
                            + ((copyRes && copyRes.error) || AEI18n.t('未知错误')) + AEI18n.punct('）', ')'), true);
                        return;
                    }
                    // 复制成功后再写注入 scope 的 SKILL.md（覆盖来源里的原始 scope，
                    // 磁盘是重启后作用域的唯一事实源）；落盘失败回滚注册并清目录
                    if (!_finishInstallToDisk(result, content, setStatus)) {
                        _cleanupSkillDir(fsMod, targetDir);
                        return;
                    }
                    setStatus(AEI18n.t('安装成功: ') + (result.entry ? result.entry.name : ''));
                    hideInstallWizard();
                    _notifyChange();
                    renderList();
                    updateFilterButtons();
                }, function (err) {
                    try { registry.unregister(result.entry.id); } catch (_) {}
                    _cleanupSkillDir(fsMod, targetDir);
                    setStatus(AEI18n.t('安装失败：复制技能目录失败（')
                        + ((err && err.message) || err) + '）', true);
                });
                });
            }

            AEFS.readFile(srcPath).then(function (content) {
                if (content && content.trim()) {
                    doInstall(content);
                } else {
                    // 选中目录未直接含 SKILL.md，扫描一级子目录以提供更精准的错误提示
                    _scanSubdirSkills(normalizedDir).then(function (subNames) {
                        if (subNames.length > 0) {
                            var preview = subNames.slice(0, 3).join(', ') + (subNames.length > 3 ? (' 等 ' + subNames.length + ' 个') : '');
                            setStatus(AEI18n.t('检测到 ') + subNames.length + AEI18n.t(' 个 Skill 子文件夹：') + preview + AEI18n.t('。请直接选择其中一个具体子文件夹。'), true);
                        } else {
                            setStatus(AEI18n.t('无法读取 SKILL.md，请确认路径正确'), true);
                        }
                    });
                }
            });
        }

        // 校验下载 URL：仅允许 https，拒绝 shell 元字符防止命令注入
        // 委托优先（llmTools.js 单点实现），独立加载回退本地副本
        function _validateDownloadUrl(url) {
            var impl = _skillLlmInternal();
            if (impl && typeof impl.validateDownloadUrl === 'function') return impl.validateDownloadUrl(url);
            return _validateDownloadUrlLocal(url);
        }
        function _validateDownloadUrlLocal(url) {
            if (!url || typeof url !== 'string') return false;
            // 仅允许 https:// 协议
            if (!/^https:\/\/.+/.test(url)) return false;
            // 拒绝 shell 元字符：& | ; ` $ ! 换行 回车 " < > ^（cmd.exe 引号/I/O/转义）
            // % 不再整体拒绝：合法 percent-encoding（%XX）在 fetch/JSON 代理传输下无 shell 语义，
            // 且编码 URL 常见——直连可用而 Bridge 代理被拒会造成不一致
            if (/[&|;`$!\n\r"<>^]/.test(url)) return false;
            // raw %（非 %XX 编码序列）仍拒：畸形 URL + cmd 环境变量展开残留风险
            if (/%(?![0-9a-fA-F]{2})/.test(url)) return false;
            // 拒绝 null byte
            if (/\x00/.test(url)) return false;
            // 限制长度
            if (url.length > 4096) return false;
            // 私网/回环 host 拒绝——installFromUrl 先走 CEP Chromium fetch
            // 直连（Bridge 代理路径的 _isPrivateHost 防护被直连整体绕过），内网响应体
            // 落盘 SKILL.md 后进入 LLM 上下文（SSRF 读原语→数据回读外泄通道）。
            // 判定助手为本文件顶层与 llmTools.js 同源拷贝（见文件头部块）；
            // host 不可提取（空/畸形）同样拒绝
            var host = _extractHttpsHost(url);
            if (!host || _isPrivateHost(host)) return false;
            return true;
        }

        // URL 安装下载内容大小上限（2MB，与 skill md 场景相称）：
        // 超大响应整体进入内存后还要进入解析与落盘，可致内存耗尽
        var _SKILL_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024;
        // 目录安装的二进制附件单文件上限（与 skillRemote 的 maxBinaryFileBytes 对齐）：
        // base64 后体积 +33%，8MB 原文在 CEF 内存里可接受；超限由 skillRemote 侧
        // 也兜一层（FILE_TOO_LARGE），此处是直连前的头预检，避免全量拉取
        var _SKILL_BINARY_MAX_BYTES = 8 * 1024 * 1024;

        // 解析响应头 content-length（无头/不可解析返回 null）：可信时用于提前拒绝，
        // 避免全量拉取响应体
        // 委托优先（llmTools.js 单点实现），独立加载回退本地副本
        function _declaredContentLength(res) {
            var impl = _skillLlmInternal();
            if (impl && typeof impl.declaredContentLength === 'function') return impl.declaredContentLength(res);
            return _declaredContentLengthLocal(res);
        }
        function _declaredContentLengthLocal(res) {
            try {
                if (!res || !res.headers || typeof res.headers.get !== 'function') return null;
                var raw = res.headers.get('content-length');
                if (!raw) return null;
                var n = parseInt(String(raw), 10);
                return isNaN(n) ? null : n;
            } catch (_) { return null; }
        }

        // 大小超限专用错误：_skillSizeLimit 标记供 catch 区分——超限是确定性失败，
        // 不落 Bridge 代理重试（同一 URL 必然同样超限）
        // 委托优先（单点实现双标记 code + _skillSizeLimit），独立加载回退本地副本
        function _skillSizeLimitError() {
            var impl = _skillLlmInternal();
            if (impl && typeof impl.sizeLimitError === 'function') return impl.sizeLimitError();
            return _skillSizeLimitErrorLocal();
        }
        // 本地回退副本：独立加载场景 catch 仅按 _skillSizeLimit 判定（code 标记归
        // 单点实现侧使用），消息与单点实现语义一致
        function _skillSizeLimitErrorLocal() {
            var e = new Error('内容超过 2MB 上限');
            e._skillSizeLimit = true;
            return e;
        }

        // 读取响应体并施加大小上限：优先流式累计（超限即取消读取，防内存耗尽），
        // body 不可流读（CEP fetch 降级环境/单测 mock）时退化为 text() 后长度校验
        // 委托优先（llmTools.js 单点实现），独立加载回退本地副本
        //（promise 递归与单点 async/await 结构不同，行为等价）
        function _readBodyWithLimit(res) {
            var impl = _skillLlmInternal();
            if (impl && typeof impl.readBodyWithLimit === 'function') return impl.readBodyWithLimit(res);
            return _readBodyWithLimitLocal(res);
        }
        function _readBodyWithLimitLocal(res) {
            if (res.body && typeof res.body.getReader === 'function' && typeof TextDecoder === 'function') {
                return new Promise(function (resolve, reject) {
                    var reader = res.body.getReader();
                    var decoder = new TextDecoder('utf-8');
                    var text = '';
                    var bytes = 0;
                    function fail() {
                        try { reader.cancel(); } catch (_) {}
                        reject(_skillSizeLimitError());
                    }
                    function pump() {
                        reader.read().then(function (step) {
                            if (step.done) {
                                text += decoder.decode();
                                resolve(text);
                                return;
                            }
                            // value 为 Uint8Array，按字节累计
                            bytes += (step.value && step.value.length) || 0;
                            if (bytes > _SKILL_DOWNLOAD_MAX_BYTES) {
                                fail();
                                return;
                            }
                            text += decoder.decode(step.value, { stream: true });
                            pump();
                        }).catch(function (e) { reject(e); });
                    }
                    pump();
                });
            }
            return res.text().then(function (t) {
                if (t && t.length > _SKILL_DOWNLOAD_MAX_BYTES) throw _skillSizeLimitError();
                return t;
            });
        }

        // 重定向安全直连下载。fetch 默认 redirect:'follow' 自动跟随 30x，
        // _validateDownloadUrl 只校验初始 URL——重定向跳 http://127.0.0.1/ 等私网地址
        // 无人复查（私网防护被整体绕过）。改 redirect:'manual' 手动逐跳跟随：每个
        // Location 重新过 _validateDownloadUrl（https 协议 + 私网 host + 元字符），
        // 非法即抛可识别错误（确定性失败，不落代理重试）；最多 5 跳。CEP Chromium
        // manual 模式对跨源重定向返回 opaqueredirect（status=0、读不到 Location 头）——
        // 拿不到 Location 的 30x/status 0 按直连失败处理，落既有 Bridge 代理回退链路
        //（代理侧有逐跳 _isPrivateHost 复查）。
        var _REDIRECT_MAX_HOPS = 5;
        function _skillRedirectError(msg) {
            var e = new Error(msg);
            e._skillRedirectInvalid = true;
            return e;
        }
        // 委托优先（llmTools._fetchRedirectValidatedCore 单点实现）——
        // fetchHop 注入本侧超时/取消语义（整链共享一个 AbortController，60s 从
        // 下载开始起算；llmTools 侧是每跳独立超时预算，两侧既有语义均不变）。
        // 独立加载回退下方本地副本（递归式，行为等价）
        function _fetchDirectValidated(url, opts) {
            var impl = _skillLlmInternal();
            if (impl && typeof impl.fetchRedirectValidated === 'function') {
                return impl.fetchRedirectValidated(url, function (u) {
                    var init = { redirect: 'manual' };   // 不自动跟随
                    if (opts && opts.signal) init.signal = opts.signal;
                    return fetch(u, init);
                });
            }
            return _fetchDirectValidatedLocal(url, opts);
        }
        function _fetchDirectValidatedLocal(url, opts) {
            var current = url;
            var hops = 0;
            function attempt() {
                var init = { redirect: 'manual' };   // 不自动跟随
                if (opts && opts.signal) init.signal = opts.signal;
                return fetch(current, init).then(function (res) {
                    var st = res.status;
                    if (st !== 0 && !(st >= 300 && st < 400)) return res;   // 非重定向 → 交给调用方
                    var loc = null;
                    try { loc = (res.headers && typeof res.headers.get === 'function') ? res.headers.get('location') : null; } catch (_) {}
                    if (!loc) throw new Error('REDIRECT_UNINSPECTABLE');   // opaqueredirect：无法逐跳校验 → 代理回退
                    if (hops++ >= _REDIRECT_MAX_HOPS) throw _skillRedirectError('重定向次数超过 ' + _REDIRECT_MAX_HOPS + ' 次');
                    if (!_validateDownloadUrl(loc)) throw _skillRedirectError('重定向目标不合法（仅支持 HTTPS 公网链接）: ' + loc);
                    current = loc;
                    return attempt();
                });
            }
            return attempt();
        }

        // ════════════════════════════════════════════════════════
        // 目录化技能（多文件）安装的下载通道
        //   skillRemote（GitHub/jsDelivr 技能包解析与下载编排）与 skillFs（本地技能树
        //   操作）由并行任务实现，本文件一律按 global.AE_LLM 惰性读取：view.js 独立
        //   加载（无 llmTools / 无这两个模块）时所有新调用都必须回落旧路径，不得因
        //   模块缺失抛错。
        // ════════════════════════════════════════════════════════

        // 目录安装/单文件安装共用的文本下载通道（从原 installFromUrl 的 fetch 链抽取）：
        //   直连（redirect manual 逐跳校验，见 _fetchDirectValidated）
        //   → res.ok 检查 → content-length 2MB 预检 → 流式限长读取
        //   直连不可用（网络错误/opaqueredirect）→ 既有 Bridge /api/download-url 文本代理
        // 取消/超时/超限/非法重定向均为确定性失败，不落代理重试（理由：
        // 取消重试违背用户意图，超时大概率再超时，同一 URL 代理必然同样超限）。
        function _fetchRemoteText(url, timeoutMs) {
            var ctrl = null;
            return Promise.resolve().then(function () {
                _assertFlowActive();
                ctrl = _beginRequest(timeoutMs);
                return _fetchDirectValidated(url, _dl.abort ? { signal: _dl.abort.signal } : undefined);
            }).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                // content-length 头预检——声明大小已超限时提前拒绝，避免全量拉取
                var declared = _declaredContentLength(res);
                if (declared !== null && declared > _SKILL_DOWNLOAD_MAX_BYTES) {
                    throw _skillSizeLimitError();
                }
                // 流式累计读取（超限即中断），替代无上限的 res.text()
                return _readBodyWithLimit(res);
            }).then(function (content) {
                _endRequest(ctrl);
                return content;
            }, function (err) {
                _endRequest(ctrl);
                if (_dl.cancelled) throw _flowAbortError('cancel');
                if (_isAbortError(err)) throw err;
                if (err && (err._skillSizeLimit || err._skillRedirectInvalid)) throw err;
                // 直连不可用 → 既有 Bridge 文本代理（保留 token 头与 abort 语义；超时档位
                // 沿用本流程的请求超时——单文件 60s / 目录包 20s，不能让代理回退静默降档）
                return _fetchViaBridgeText(url, timeoutMs);
            });
        }

        // Bridge /api/download-url 文本代理（替代 certutil system.callSystem）：
        // 代理 fetch 同挂当前请求的 abort 控制器——取消按钮/向导关闭在代理阶段同样
        // 生效（只 abort 直连控制器会让代理 fetch 无限挂起）。
        function _fetchViaBridgeText(url, timeoutMs) {
            return Promise.resolve().then(function () {
                _assertFlowActive();
                if (typeof CSInterface === 'undefined') {
                    var eOff = new Error('网络不可用');
                    eOff._skillBridgeOffline = true;
                    throw eOff;
                }
                var dlHeaders = { 'Content-Type': 'application/json' };
                var dlToken = (global.Bridge && typeof global.Bridge.getToken === 'function') ? global.Bridge.getToken() : null;
                if (dlToken) dlHeaders['X-Bridge-Token'] = dlToken;
                var ctrl = _beginRequest(timeoutMs);
                var init = {
                    method: 'POST',
                    headers: dlHeaders,
                    body: JSON.stringify({ url: url })
                };
                if (ctrl) init.signal = ctrl.signal;
                var bridgeBase = (global.Bridge && global.Bridge.getBridgeUrl ? global.Bridge.getBridgeUrl() : 'http://127.0.0.1:9877');
                return fetch(bridgeBase + '/api/download-url', init).then(function (res) {
                    return res.json();
                }).then(function (result) {
                    _endRequest(ctrl);
                    if (_dl.cancelled) throw _flowAbortError('cancel');
                    if (result && result.ok && result.content) {
                        // Bridge 代理路径按返回 content 长度判断——
                        // 超大内容不进入解析与落盘
                        if (String(result.content).length > _SKILL_DOWNLOAD_MAX_BYTES) {
                            throw _skillSizeLimitError();
                        }
                        return result.content;
                    }
                    var eResult = new Error((result && result.error) || '下载错误');
                    eResult._skillBridgeResult = true;
                    throw eResult;
                }, function (err) {
                    _endRequest(ctrl);
                    if (_dl.cancelled) throw _flowAbortError('cancel');
                    if (_isAbortError(err)) throw err;
                    var eHttp = new Error('Bridge 不可用或网络错误');
                    eHttp._skillBridgeHttp = true;
                    throw eHttp;
                });
            });
        }

        // GitHub Trees/Contents、jsDelivr flat 目录列表：文本通道 + JSON.parse
        function _fetchRemoteJson(url) {
            return _fetchRemoteText(url).then(function (text) {
                try {
                    return JSON.parse(text);
                } catch (e) {
                    var err = new Error('目录列表返回非 JSON 数据: ' + url);
                    err._skillJsonInvalid = true;
                    throw err;
                }
            });
        }

        function _binarySizeLimitError(url) {
            var e = new Error('二进制附件超过 8MB 上限: ' + url);
            e._skillBinarySizeLimit = true;
            return e;
        }

        function _binaryUnavailableError(url) {
            var e = new Error('二进制附件直连下载失败（Bridge 代理是文本通道，不支持二进制）: ' + url);
            e._skillBinaryUnavailable = true;
            return e;
        }

        // 二进制附件下载（技能目录里的图片/字体等）：仅直连可用——Bridge
        // /api/download-url 是文本通道，二进制会被 UTF-8 解码破坏，故不做代理回退。
        // 上限 8MB（与 skillRemote.maxBinaryFileBytes 对齐），返回 base64 交给
        // skillFs.writePackage 落盘（CEP 无 Node Buffer）。
        function _fetchRemoteBinaryBase64(url) {
            var ctrl = null;
            return Promise.resolve().then(function () {
                _assertFlowActive();
                ctrl = _beginRequest();
                return _fetchDirectValidated(url, _dl.abort ? { signal: _dl.abort.signal } : undefined);
            }).then(function (res) {
                if (!res.ok) throw new Error('二进制下载失败: HTTP ' + res.status);
                var declared = _declaredContentLength(res);
                if (declared !== null && declared > _SKILL_BINARY_MAX_BYTES) {
                    throw _binarySizeLimitError(url);
                }
                if (typeof res.arrayBuffer !== 'function') {
                    throw _binaryUnavailableError(url);
                }
                return res.arrayBuffer();
            }).then(function (buf) {
                _endRequest(ctrl);
                if (_dl.cancelled) throw _flowAbortError('cancel');
                if (buf && buf.byteLength > _SKILL_BINARY_MAX_BYTES) {
                    throw _binarySizeLimitError(url);
                }
                return _arrayBufferToBase64(buf);
            }, function (err) {
                _endRequest(ctrl);
                if (_dl.cancelled) throw _flowAbortError('cancel');
                if (_isAbortError(err)) throw err;
                if (err && (err._skillSizeLimit || err._skillRedirectInvalid
                    || err._skillBinarySizeLimit || err._skillBinaryUnavailable)) throw err;
                throw _binaryUnavailableError(url);
            });
        }

        // ArrayBuffer → base64（CEP 无 Node Buffer；分块避免 apply 参数上限）
        function _arrayBufferToBase64(buf) {
            if (!buf) return '';
            var bytes = new Uint8Array(buf);
            var CHUNK = 8192;
            var binary = '';
            for (var i = 0; i < bytes.length; i += CHUNK) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            return btoa(binary);
        }

        // URL 是否看起来指向 SKILL.md（决定单文件安装文案是否补「仅安装了 SKILL.md」）
        function _looksLikeSkillMdUrl(url) {
            return /\/SKILL\.md(?:[?#].*)?$/i.test(String(url || ''));
        }

        // 目录安装失败统一包装：message 已是完整中文（含操作建议），_mapDownloadFailure
        // 按 _remoteError 标记原样展示，不再套「获取失败：」前缀
        function _remoteError(message) {
            var e = new Error(message);
            e._remoteError = true;
            return e;
        }

        function _remoteListErrorText(resolved) {
            var code = (resolved && resolved.code) || 'LIST_FAILED';
            var detail = (resolved && resolved.error) || AEI18n.t('未知原因');
            if (code === 'NO_SKILL_MD') {
                return AEI18n.t('无法读取技能目录：该目录下未找到 SKILL.md');
            }
            return AEI18n.t('无法读取技能目录（GitHub 与 jsDelivr 均不可用）：{detail}', { detail: detail });
        }

        function _remoteDownloadErrorText(pkg) {
            var code = (pkg && pkg.code) || 'DOWNLOAD_FAILED';
            var detail = (pkg && pkg.error) || '';
            var failedPath = (pkg && pkg.path) || '';
            if (code === 'TOO_MANY_FILES' || code === 'FILE_TOO_LARGE' || code === 'TOTAL_TOO_LARGE') {
                return AEI18n.t('下载技能包失败：文件数量或体积超过上限{detail}，请改用「文件路径」选项从本地文件夹安装', {
                    detail: detail ? '（' + detail + '）' : ''
                });
            }
            if (code === 'BINARY_UNSUPPORTED') {
                return AEI18n.t('下载技能包失败：技能包含二进制附件，当前下载通道不支持{detail}，请改用「文件路径」选项从本地文件夹安装', {
                    detail: detail ? '（' + detail + '）' : ''
                });
            }
            if (code === 'DOWNLOAD_FAILED') {
                return AEI18n.t('下载附件失败：{file}', { file: failedPath || detail || AEI18n.t('未知文件') });
            }
            return AEI18n.t('下载技能包失败：{detail}', { detail: detail || code });
        }

        // 删除技能目录（回滚用）：尽力而为，不抛错——不掩盖主错误
        function _cleanupSkillDir(fsMod, dir) {
            if (!fsMod || typeof fsMod.removeTree !== 'function' || typeof AEFS === 'undefined') {
                return Promise.resolve();
            }
            return Promise.resolve().then(function () {
                return fsMod.removeTree(AEFS, dir);
            }).then(null, function () {});
        }

        // 目标技能目录是否已存在（写盘/复制前检查）：已存在但未注册 = 上次安装残留或
        // 手工目录。直接合并会让新旧附件版本混杂；安装失败回滚的 removeTree 还会把
        // 预先存在的目录递归删掉（skillFs.removeTree 用 preConfirmed 跳过确认）。
        // 返回 true/false/null（null = 探测不了 → 保持旧行为继续）。
        function _targetDirExistsView(dir) {
            if (typeof AEFS === 'undefined' || !dir) return Promise.resolve(null);
            // 优先三态 existsResult：NOT_FOUND = 权威「不存在」；REJECTED/CHANNEL_FAILURE
            // = 探测不到（不能当不存在，否则会合并/覆盖未知状态的既有目录）
            try {
                if (typeof AEFS.existsResult === 'function') {
                    return Promise.resolve(AEFS.existsResult(dir)).then(function (tr) {
                        if (tr && tr.ok === true) return tr.data === true;
                        if (tr && tr.code === 'NOT_FOUND') return false;
                        return null;
                    }, function () { return null; });
                }
                if (typeof AEFS.exists === 'function') {
                    return Promise.resolve(AEFS.exists(dir)).then(function (r) {
                        if (r === true || r === false) return r;
                        try {
                            if (typeof AEFS.existsSync === 'function') {
                                var s = AEFS.existsSync(dir);
                                if (s === true || s === false) return s;
                            }
                        } catch (_) {}
                        return null;
                    }, function () { return null; });
                }
                if (typeof AEFS.existsSync === 'function') return Promise.resolve(!!AEFS.existsSync(dir));
            } catch (_) {}
            return Promise.resolve(null);
        }

        // 目录包落盘：注册（frontmatter 校验/重名拒绝）→ SKILL.md 注入 scope →
        // 整包写盘（skillFs.writePackage 负责 SKILL.md 最后写 + 自动建父目录）。
        // 写盘失败回滚注册并 removeTree 清理已写入的部分（writePackage 中途失败会
        // 留下半套文件，不回滚就是「重启后技能残缺」的脏数据）。
        function _finishRemoteInstall(url, pkg, resolved, scope, setStatus) {
            var fsMod = _skillFsModule();
            var entries = (pkg && pkg.entries) || [];
            var mdText = null;
            var attachments = [];
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                if (!entry || !entry.path) continue;
                // 主文件识别大小写不敏感（Windows 上 bootstrap 读 <dir>\SKILL.md 不区分
                // 大小写）；写盘统一规范名 SKILL.md，bootstrap/卸载/get 口径一致。
                if (String(entry.path).toLowerCase() === 'skill.md') {
                    if (!entry.binary && typeof entry.text === 'string') mdText = entry.text;
                } else {
                    attachments.push(entry);
                }
            }
            if (mdText === null) {
                return Promise.reject(_remoteError(AEI18n.t('安装失败：技能目录中缺少 SKILL.md 或它不是文本文件')));
            }
            // 取消后不再落盘（下载完成瞬间点取消也要拦住注册/写盘）
            _assertFlowActive();
            var result = skillInstaller.installFromContent(mdText, url, registry, scope);
            if (!result || !result.ok) {
                return Promise.reject(_remoteError(result && result.detail
                    ? result.detail
                    : ('安装失败: ' + ((result && result.error) || 'INSTALL_FAILED'))));
            }
            var skillsDir = _getSkillsDir();
            if (!skillsDir || typeof AEFS === 'undefined') {
                try { registry.unregister(result.entry.id); } catch (_) {}
                return Promise.reject(_remoteError(AEI18n.t('安装失败：数据目录未初始化，无法写入技能目录')));
            }
            var targetDir = skillsDir + '\\' + result.entry.id;
            var inject = (global.AE_LLM && typeof global.AE_LLM.injectScopeToSkillMd === 'function')
                ? global.AE_LLM.injectScopeToSkillMd : null;
            // SKILL.md 放最后写（writePackage 契约）：附件全部成功才算安装成功
            var finalEntries = attachments.slice();
            finalEntries.push({ path: 'SKILL.md', text: inject ? inject(mdText, scope) : mdText });
            // 已存在但未注册的目标目录：拒绝合并（失败回滚会误删既有目录），如实报错
            return _targetDirExistsView(targetDir).then(function (dirExists) {
                if (dirExists === true) {
                    try { registry.unregister(result.entry.id); } catch (_) {}
                    throw _remoteError(AEI18n.t('安装失败：目标技能目录已存在（{dir}），请先卸载或手动清理后重试', { dir: targetDir }));
                }
                // 写盘前最后一次取消复查（取消后不再落盘）
                _assertFlowActive();
                _dl.writing = true;
                return Promise.resolve().then(function () {
                    return fsMod.writePackage(AEFS, targetDir, finalEntries);
                }).then(null, function (e) {
                    _dl.writing = false;
                    return { ok: false, error: (e && e.message) ? e.message : String(e) };
                }).then(function (writeRes) {
                    _dl.writing = false;
                    if (!writeRes || writeRes.ok !== true) {
                        try { registry.unregister(result.entry.id); } catch (_) {}
                        return _cleanupSkillDir(fsMod, targetDir).then(function () {
                            throw _remoteError(AEI18n.t('安装失败：写入技能文件失败（{error}）', {
                                error: (writeRes && writeRes.error) || AEI18n.t('未知错误')
                            }));
                        });
                    }
                    // 写盘不可中断：写盘期间用户取消（关向导/点取消）→ 回滚本次写入并报取消，
                    // 不能装完再静默报成功
                    if (_dl.cancelled) {
                        try { registry.unregister(result.entry.id); } catch (_) {}
                        return _cleanupSkillDir(fsMod, targetDir).then(function () {
                            throw _flowAbortError('cancel');
                        });
                    }
                    _hideDownloadProgress();
                    // 远端 notes/warnings（非法条目被丢弃、ref 歧义、CDN 回退等）不得静默丢弃
                    var noteText = '';
                    try {
                        var notes = ((resolved && resolved.notes) || []).concat((pkg && pkg.warnings) || [])
                            .filter(function (n) { return n; });
                        if (notes.length) {
                            for (var ni = 0; ni < notes.length; ni++) {
                                console.warn('[SkillView] 来源提示：' + notes[ni]);
                            }
                            noteText = '；提示：' + notes.slice(0, 2).join('；').slice(0, 200);
                        }
                    } catch (_) {}
                    setStatus(AEI18n.t('安装成功: ') + (result.entry.name || result.entry.id)
                        + AEI18n.t('（附件 ') + attachments.length + AEI18n.t(' 个）') + noteText);
                    hideInstallWizard();
                    _notifyChange();
                    renderList();
                    updateFilterButtons();
                });
            });
        }

        // 目录安装流程（GitHub tree/blob、jsDelivr 目录链接）：
        //   解析来源 → 枚举目录文件 → 逐个下载（文本/二进制）→ 注册 → 整包写盘。
        // 任一环节失败整体回滚，不留下「SKILL.md 装上了、附件缺失」的半装状态。
        // 取消语义：每个异步步骤前 _assertFlowActive；取消后不再发起请求、不再落盘。
        function _installFromRemoteRepo(url, src, scope, setStatus) {
            if (!skillInstaller || typeof skillInstaller.installFromContent !== 'function') {
                setStatus(AEI18n.t('Skill 安装器未就绪'), true);
                return;
            }
            var remote = _skillRemoteModule();
            _showDownloadProgress();
            _dl.cancelled = false;
            _dl.abortedBy = '';
            _dl.writing = false;
            _dl.abort = null;
            // 目录包按文件逐个 20s 超时（上限 200 文件 / 20MB），不设单文件流程的
            // 60s 总预算——大技能包会被腰斩；取消按钮/向导关闭仍可随时中止当前请求
            if (_dl.timer) { clearTimeout(_dl.timer); _dl.timer = null; }
            _setDownloadProgress(AEI18n.t('正在读取技能目录…'));

            // 目录枚举失败但 URL 本身就是 SKILL.md（raw/blob 链接）时的降级哨兵：
            // 回退单文件安装，回执由 _installSingleFileFromUrl 统一补「仅安装了 SKILL.md」。
            // 官方技能目录的安装链接正是 raw SKILL.md；GitHub API/jsDelivr 列表接口
            // 不可达而 raw CDN 可达时，整体失败会让原本可用的安装方式倒退（降级必须可见）。
            var SINGLE_FALLBACK = { __singleFileFallback: true };
            // 目录枚举结果需跨 then 传给落盘阶段（resolved 是第一个 then 的形参，第二个
            // then 里不可见——误传会导致「resolved is not defined」）
            var resolvedSource = null;
            Promise.resolve().then(function () {
                return remote.resolveRemoteSkill(src, { fetchJson: _fetchRemoteJson });
            }).then(function (resolved) {
                _assertFlowActive();
                resolvedSource = resolved;
                if (!resolved || resolved.ok !== true) {
                    if (_looksLikeSkillMdUrl(url)) {
                        _hideDownloadProgress();
                        _installSingleFileFromUrl(url, scope, setStatus);
                        return SINGLE_FALLBACK;
                    }
                    throw _remoteError(_remoteListErrorText(resolved));
                }
                var files = resolved.files || [];
                _setDownloadProgress(AEI18n.t('已读取技能目录，共 {n} 个文件，正在下载…', { n: files.length }));
                return remote.downloadSkillPackage(files, resolved.bases || {}, {
                    fetchText: _fetchRemoteText,
                    fetchBinary: _fetchRemoteBinaryBase64
                }, {
                    onProgress: function (p) {
                        if (!p) return;
                        _setDownloadProgress(AEI18n.t('正在下载附件 {done}/{total}：{path}', {
                            done: p.done, total: p.total, path: p.path
                        }));
                    }
                });
            }).then(function (pkg) {
                if (pkg === SINGLE_FALLBACK) return;   // 已转入单文件安装流程，其自带收尾
                _assertFlowActive();
                if (!pkg || pkg.ok !== true) {
                    throw _remoteError(_remoteDownloadErrorText(pkg));
                }
                return _finishRemoteInstall(url, pkg, resolvedSource, scope, setStatus);
            }).then(function () {
                // 成功/失败文案均由 _finishRemoteInstall 内处理
            }, function (err) {
                _mapDownloadFailure(err, setStatus);
            });
        }

        // 安装向导 URL tab 入口：先按来源分流（目录化技能 / 单文件），两条路径都先
        // 过 _validateDownloadUrl（安全检查前置，避免非法 URL 先发网络请求）。
        function installFromUrl(url, scope, setStatus) {
            if (!registry) {
                setStatus(AEI18n.t('Skill 注册表未就绪'), true);
                return;
            }
            scope = scope || { type: 'global' };
            if (!_validateDownloadUrl(url)) {
                setStatus(AEI18n.t('获取失败：URL 不合法，仅支持 HTTPS 链接，请勿包含特殊字符'), true);
                return;
            }
            var remote = _skillRemoteModule();
            var remoteFs = _skillFsModule();
            var src = null;
            if (remote && typeof remote.parseSourceUrl === 'function') {
                try { src = remote.parseSourceUrl(url); } catch (_) { src = null; }
            }
            // 目录安装要求 skillRemote 的解析/下载 + skillFs 的整包写盘同时就绪；
            // 任一缺失（并行开发未落地 / 独立加载）→ 回落既有单文件流程，不抛错
            if (src && src.kind === 'repo'
                && typeof remote.resolveRemoteSkill === 'function'
                && typeof remote.downloadSkillPackage === 'function'
                && remoteFs && typeof remoteFs.writePackage === 'function') {
                _installFromRemoteRepo(url, src, scope, setStatus);
                return;
            }
            _installSingleFileFromUrl(url, scope, setStatus);
        }

        // 单文件流程（原 installFromUrl 主体的守卫语义逐条保留）：URL 指向单个
        // SKILL.md，或来源无法枚举同目录附件（skillRemote 未就绪 / 非 GitHub 链接）。
        function _installSingleFileFromUrl(url, scope, setStatus) {
            if (!registry) {
                setStatus(AEI18n.t('Skill 注册表未就绪'), true);
                return;
            }
            scope = scope || { type: 'global' };
            // 安全检查前置（与 llmTools _downloadSkillMd 一致）：先校验再发任何网络请求，
            // 避免非法 URL 先走直连、失败后才被拦的不一致路径
            if (!_validateDownloadUrl(url)) {
                setStatus(AEI18n.t('获取失败：URL 不合法，仅支持 HTTPS 链接，请勿包含特殊字符'), true);
                return;
            }
            _showDownloadProgress();

            // 单文件安装装不到同目录附件：仅当 URL 确实指向 SKILL.md 时才提示
            //（HTML 页面/压缩包链接不是这个语义，别误导）；文案补在安装结果后
            var singleNote = _looksLikeSkillMdUrl(url)
                ? '（该来源无法枚举同目录附件，仅安装了 SKILL.md）' : '';

            function doInstallFromUrl(content) {
                _hideDownloadProgress();
                // 用户在直连/代理下载阶段点了取消：即使响应此刻已到达也不再进入安装
                //（取消只 abort 直连 fetch 时，代理响应照常落地成"静默安装"）
                if (_dl.cancelled) return;
                if (!content) {
                    setStatus(AEI18n.t('获取失败：内容为空'), true);
                    return;
                }
                if (!skillInstaller || typeof skillInstaller.installFromContent !== 'function') {
                    setStatus(AEI18n.t('Skill 安装器未就绪'), true);
                    return;
                }
                var result = skillInstaller.installFromContent(content, url, registry, scope);
                if (result.ok) {
                    // 落盘失败文案也补「仅安装了 SKILL.md」提示：与来源语义一致
                    if (!_finishInstallToDisk(result, content, function (msg, isError) {
                        setStatus(msg + singleNote, isError);
                    })) return;
                    setStatus(AEI18n.t('安装成功: ') + (result.entry ? result.entry.name : '') + singleNote);
                    hideInstallWizard();
                    _notifyChange();
                    renderList();
                    updateFilterButtons();
                } else {
                    setStatus((result.detail || (AEI18n.t('安装失败: ') + result.error)) + singleNote, true);
                }
            }

            // 60s 总预算（既有语义）：无超时的 fetch 在网络悬挂时永久挂着（弹窗也
            // 关不掉）。单请求另有 per-request 20s 超时（_beginRequest），两者共用
            // 「中止当前请求」的收尾路径；AbortController 不可用的环境退回无超时旧行为
            _dl.cancelled = false;
            _dl.abortedBy = '';
            _dl.writing = false;
            _dl.abort = null;
            if (_dl.timer) { clearTimeout(_dl.timer); _dl.timer = null; }
            if (typeof AbortController === 'function') {
                _dl.timer = setTimeout(function () {
                    _dl.timer = null;
                    if (!_dl.abortedBy) _dl.abortedBy = 'flow';
                    if (_dl.abort) { try { _dl.abort.abort(); } catch (_) {} }
                }, 60000);
            }

            // 下载通道抽为可复用 helper（目录安装同用）：重定向安全直连 + 2MB 上限 +
            // 直连失败落 Bridge 文本代理；取消/超时/超限语义不变
            // 单文件流程沿用旧 60s 单请求预算（慢网单个 SKILL.md 不应比改造前更早超时）
            _fetchRemoteText(url, 60000).then(function (content) {
                doInstallFromUrl(content);
            }, function (err) {
                _mapDownloadFailure(err, setStatus);
            });
        }

        function installFromContent(content, scope, setStatus) {
            if (!skillInstaller || typeof skillInstaller.installFromContent !== 'function') {
                setStatus(AEI18n.t('Skill 安装器未就绪'), true);
                return;
            }
            scope = scope || { type: 'global' };
            var result = skillInstaller.installFromContent(content, 'inline', registry, scope);
            if (result.ok) {
                // 写入原始内容并注入 scope，保留全部 frontmatter 字段
                if (!_finishInstallToDisk(result, content, setStatus)) return;
                setStatus(AEI18n.t('安装成功: ') + (result.entry ? result.entry.name : ''));
                hideInstallWizard();
                _notifyChange();
                renderList();
                updateFilterButtons();
            } else {
                setStatus(result.detail || (AEI18n.t('安装失败: ') + result.error), true);
            }
        }

        async function render(containerEl) {
            if (!containerEl) return;

            var allSkills = getSkills();
            var globalCount = 0;
            var moduleCount = 0;
            for (var i = 0; i < allSkills.length; i++) {
                var s = allSkills[i];
                if (s.scope && s.scope.type === 'global') globalCount++;
                else if (s.scope && s.scope.type === 'module') moduleCount++;
            }

            var html = '';
            // 与 MCP 模块一致：外包 .mgmt-tools-panel 提供全高背景，
            // 空列表时背景才能延伸覆盖下方提示区
            html += '<div class="mgmt-tools-panel">';
            html += '<div class="mgmt-filter-bar">';
            html += '<div class="mgmt-filter-group">';
            html += '<button class="mgmt-filter-btn active" data-filter="all">' + escHtml(AEI18n.t('全部 ({n})', { n: allSkills.length })) + '</button>';
            html += '<button class="mgmt-filter-btn" data-filter="global">' + escHtml(AEI18n.t('全局 ({n})', { n: globalCount })) + '</button>';
            html += '<button class="mgmt-filter-btn" data-filter="module">' + escHtml(AEI18n.t('模块 ({n})', { n: moduleCount })) + '</button>';
            html += '</div>';
            html += '<div class="mgmt-actions">';
            html += AEI18n.html('<button class="btn" id="skillInstallBtn">安装 Skill</button>');
            html += '</div>';
            html += '</div>';

            html += '<div class="mgmt-list-container" id="skillListContainer"></div>';
            var dataSkillsDir = _getSkillsDir();
            html += '<div style="margin-top:12px;padding:8px 12px;border-radius:4px;background:rgba(var(--accent-rgb),.04);border:1px solid rgba(var(--accent-rgb),.08);font-size:11px;color:var(--text-muted);line-height:1.6;">';
            html += AEI18n.html('💡 手动添加 Skill：将包含 SKILL.md 的文件夹放入数据目录 <code style="color:var(--accent);background:rgba(var(--accent-rgb),.08);padding:1px 4px;border-radius:2px;font-size:10px;">') + escHtml(dataSkillsDir || AEI18n.t('（数据目录未初始化）')) + AEI18n.html('</code>，重启即可自动加载。文件夹名即技能 id，大写/空格/下划线会自动归一化（<code>My Skill</code> → <code>my-skill</code>）；纯中文等不含字母数字的名字归一化后为空、无法加载，请改用含字母数字的文件夹名（中文显示名写在 SKILL.md 的 <code>name</code> 字段）。');
            html += '</div>';
            html += '</div>';

            containerEl.innerHTML = html;

            bindEvents(containerEl);
            renderList();
        }

        function bindEvents(containerEl) {
            var filterBtns = containerEl.querySelectorAll('.mgmt-filter-btn');
            for (var i = 0; i < filterBtns.length; i++) {
                (function(btn) {
                    on(btn, 'click', function() {
                        var f = btn.getAttribute('data-filter');
                        if (f) applyFilter(f);
                    });
                })(filterBtns[i]);
            }

            var installBtn = document.getElementById('skillInstallBtn');
            if (installBtn) {
                on(installBtn, 'click', showInstallWizard);
            }

        }

        function destroy() {
            offAll();
            offTmpAll();
            offDlgAll();
            // 编辑/安装/确认/下载进度四个弹窗都直接挂在 document.body 下，且监听已随
            // offDlgAll 解绑：切换模块时弹窗若仍开着，留在 DOM 会成为无法关闭的全屏
            // 死弹窗永久遮挡界面——生命周期清理需跟上 appendChild(document.body) 的移出
            // 模块卸载时同样中止进行中的下载，防离屏静默安装
            _cancelPendingDownload();
            _hideDownloadProgress();
            var editModal = document.getElementById('skillEditModal');
            if (editModal && editModal.parentNode) {
                if (editModal._editingScopePicker) { try { editModal._editingScopePicker.destroy(); } catch (_) {} }
                editModal.parentNode.removeChild(editModal);
            }
            var installModal = document.getElementById('skillInstallModal');
            if (installModal && installModal.parentNode) {
                if (installModal._installScopePicker) { try { installModal._installScopePicker.destroy(); } catch (_) {} }
                installModal.parentNode.removeChild(installModal);
            }
            var confirmModal = document.getElementById('skillConfirmModal');
            if (confirmModal && confirmModal.parentNode) confirmModal.parentNode.removeChild(confirmModal);
        }

        return {
            render: render,
            renderList: renderList,
            setRegistry: setRegistry,
            setInstaller: setInstaller,
            setSettingsStore: setSettingsStore,
            applyFilter: applyFilter,
            destroy: destroy
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createSkillView = createSkillView;

})(window);
