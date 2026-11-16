(function(global) {

    function createSkillRegistry() {
        // null-prototype 表：kebab-case 合法 id 包含 'constructor'（Object.prototype 键），
        // 普通 {} 上 skills['constructor'] 恒为真值——register 误报 DUPLICATE_ID、
        // get/hasSkill 命中继承函数。与 toolRegistry.js 的原型污染防护同一类问题。
        var skills = Object.create(null);
        var _disabledModules = Object.create(null);

        function validateSkillId(id) {
            if (typeof id !== 'string' || id.length === 0 || id.length > 64) return false;
            if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) return false;
            return true;
        }

        function register(skillDef) {
            if (!skillDef || !skillDef.id) return { ok: false, error: 'MISSING_ID' };
            if (!validateSkillId(skillDef.id)) return { ok: false, error: 'INVALID_ID_FORMAT', detail: 'Must be kebab-case, max 64 chars' };
            if (typeof skillDef.name !== 'string' || skillDef.name.length === 0 || skillDef.name.length > 64) {
                return { ok: false, error: 'INVALID_NAME', detail: 'Name must be 1-64 chars' };
            }
            if (typeof skillDef.description !== 'string' || skillDef.description.length === 0 || skillDef.description.length > 1024) {
                return { ok: false, error: 'INVALID_DESCRIPTION', detail: 'Description must be 1-1024 chars' };
            }
            if (skills[skillDef.id]) {
                return { ok: false, error: 'DUPLICATE_ID', detail: 'Skill "' + skillDef.id + '" 已存在' };
            }

            var scope = parseScope(skillDef.scope);
            var entry = {
                id: skillDef.id,
                name: skillDef.name,
                description: skillDef.description,
                scope: scope,
                skillPath: skillDef.skillPath || '',
                prompt: skillDef.prompt || '',
                allowedTools: Array.isArray(skillDef.allowedTools) ? skillDef.allowedTools.slice() : null,
                license: skillDef.license || null,
                compatibility: skillDef.compatibility || null,
                // version 缺失会让 createSkill overwrite / update 重写拿到 undefined，
                // 序列化时静默丢字段（磁盘是重启后的事实源 → 重启后 version 消失）
                version: skillDef.version || null,
                metadata: skillDef.metadata || null,
                installedAt: skillDef.installedAt || Date.now(),
                updatedAt: skillDef.updatedAt || Date.now(),
                category: skillDef.category || 'general',
                enabled: skillDef.enabled !== false
            };

            skills[skillDef.id] = entry;

            if (!_disabledModules[skillDef.id]) {
                _disabledModules[skillDef.id] = {};
            }

            return { ok: true, entry: entry };
        }

        function unregister(skillId) {
            if (!skills[skillId]) return { ok: false, error: 'NOT_FOUND' };
            delete skills[skillId];
            delete _disabledModules[skillId];
            return { ok: true };
        }

        function get(skillId) {
            return skills[skillId] || null;
        }

        function getAll() {
            var list = [];
            var keys = Object.keys(skills);
            for (var i = 0; i < keys.length; i++) {
                list.push(skills[keys[i]]);
            }
            list.sort(function(a, b) {
                if (a.name < b.name) return -1;
                if (a.name > b.name) return 1;
                return 0;
            });
            return list;
        }

        function getEnabledForModule(moduleId) {
            var list = [];
            var keys = Object.keys(skills);
            for (var i = 0; i < keys.length; i++) {
                var skill = skills[keys[i]];
                if (!skill.enabled) continue;
                if (!isAccessibleByModule(skill, moduleId)) continue;
                if (isModuleDisabled(skill.id, moduleId)) continue;
                list.push(skill);
            }
            return list;
        }

        // 模块作用域展开为实际 moduleId（agent/script/shader）集合：
        // - 支持模块多选 moduleIds；
        // - agent 模块可再按模式(agentModes)收窄：存在时仅展开所选模式；
        //   未指定 agentModes（全部模式）时 agent/script/shader 三种都覆盖。
        function _scopeModuleIds(scope) {
            if (scope.type !== 'module') return [];
            var mods = scope.moduleIds || (scope.moduleId ? [scope.moduleId] : []);
            var out = [];
            for (var i = 0; i < mods.length; i++) {
                var m = mods[i];
                if (m === 'agent') {
                    if (scope.agentModes && scope.agentModes.length) {
                        for (var j = 0; j < scope.agentModes.length; j++) out.push(scope.agentModes[j]);
                    } else {
                        out.push('agent', 'script', 'shader');
                    }
                } else {
                    out.push(m);
                }
            }
            return out;
        }

        function isAccessibleByModule(skill, moduleId) {
            if (skill.scope.type === 'global') return true;
            if (skill.scope.type !== 'module') return false;
            return _scopeModuleIds(skill.scope).indexOf(moduleId) >= 0;
        }

        function setModuleEnabled(skillId, moduleId, enabled) {
            if (!skills[skillId]) return { ok: false, error: 'SKILL_NOT_FOUND' };
            if (!_disabledModules[skillId]) {
                _disabledModules[skillId] = {};
            }
            if (enabled) {
                delete _disabledModules[skillId][moduleId];
            } else {
                _disabledModules[skillId][moduleId] = true;
            }
            return { ok: true };
        }

        function isModuleDisabled(skillId, moduleId) {
            if (!_disabledModules[skillId]) return false;
            return !!_disabledModules[skillId][moduleId];
        }

        function setSkillEnabled(skillId, enabled) {
            if (!skills[skillId]) return { ok: false, error: 'NOT_FOUND' };
            skills[skillId].enabled = !!enabled;
            return { ok: true };
        }

        function updateSkill(skillId, updates) {
            if (!skills[skillId]) return { ok: false, error: 'NOT_FOUND' };
            var skill = skills[skillId];
            // 先整体校验再变更：任一字段非法直接返回，避免"前几个字段已变更、后某个
            // 字段校验失败"留下半套变更（内存已变、磁盘未写、调用方却收到失败）
            if (updates.name !== undefined
                && (typeof updates.name !== 'string' || updates.name.length === 0 || updates.name.length > 64)) {
                return { ok: false, error: 'INVALID_NAME' };
            }
            if (updates.description !== undefined
                && (typeof updates.description !== 'string' || updates.description.length === 0 || updates.description.length > 1024)) {
                return { ok: false, error: 'INVALID_DESCRIPTION' };
            }
            // name/description 含双引号时，写盘链路 serializeSkillMd 的
            // sanitizeYamlValue 会把 " 静默替换为 '——内存与磁盘漂移，重启后名字改变。
            // update 前置拒绝（view 编辑弹窗 / LLM update 均经此入口），由调用方提示
            if (updates.name !== undefined && String(updates.name).indexOf('"') >= 0) {
                return { ok: false, error: 'INVALID_NAME', detail: 'name 不能包含双引号（"）——磁盘序列化会静默替换为单引号，重启后名字改变' };
            }
            if (updates.description !== undefined && String(updates.description).indexOf('"') >= 0) {
                return { ok: false, error: 'INVALID_DESCRIPTION', detail: 'description 不能包含双引号（"）——磁盘序列化会静默替换为单引号，重启后描述改变' };
            }
            if (updates.name !== undefined) {
                skill.name = updates.name;
            }
            if (updates.description !== undefined) {
                skill.description = updates.description;
            }
            if (updates.prompt !== undefined) skill.prompt = updates.prompt;
            if (updates.allowedTools !== undefined) skill.allowedTools = Array.isArray(updates.allowedTools) ? updates.allowedTools.slice() : null;
            if (updates.category !== undefined) skill.category = updates.category;
            if (updates.scope !== undefined) skill.scope = parseScope(updates.scope);
            skill.updatedAt = Date.now();
            return { ok: true, entry: skill };
        }

        function parseScope(scope) {
            if (!scope) return { type: 'global' };
            if (typeof scope === 'string' && scope === 'global') return { type: 'global' };
            // 支持 "module:moduleId" 前缀语法（与 llmTools 的 _querySkills/_fmtGet 输出一致）
            if (typeof scope === 'string' && scope.indexOf('module:') === 0) {
                var mid = scope.slice('module:'.length);
                return mid ? { type: 'module', moduleIds: [mid], moduleId: mid } : { type: 'global' };
            }
            if (typeof scope === 'string') return { type: 'module', moduleIds: [scope], moduleId: scope };
            if (typeof scope === 'object' && scope.type === 'module') {
                var out = { type: 'module' };
                // 模块多选；兼容旧单一 moduleId
                if (Array.isArray(scope.moduleIds) && scope.moduleIds.length) {
                    out.moduleIds = scope.moduleIds.slice();
                } else if (scope.moduleId) {
                    out.moduleIds = [scope.moduleId];
                } else {
                    return { type: 'global' };
                }
                // 保留 moduleId 便捷引用（= 首项），兼容旧代码/tests 只读 scope.moduleId
                out.moduleId = out.moduleIds[0];
                // agent 模式多选；兼容旧单一 mode。
                // 白名单含 'external-mcp'（外接）：它是 Agent 模块的模式之一（面板第四个运行
                // 模式），展开时与 agent/script/shader 一样直接当 moduleId 用；漏了它会把用户
                // 勾的外接静默丢掉（保存/重启后 skill 就对外接不可见）。
                if (Array.isArray(scope.agentModes) && scope.agentModes.length) {
                    var modes = scope.agentModes.filter(function(m) {
                        return m === 'agent' || m === 'script' || m === 'shader' || m === 'external-mcp';
                    });
                    if (modes.length) out.agentModes = modes;
                } else if (scope.mode && (scope.mode === 'agent' || scope.mode === 'script' || scope.mode === 'shader' || scope.mode === 'external-mcp')) {
                    out.agentModes = [scope.mode];
                }
                return out;
            }
            return { type: 'global' };
        }

        function getCount() {
            return Object.keys(skills).length;
        }

        function hasSkill(skillId) {
            return !!skills[skillId];
        }

        return {
            register: register,
            unregister: unregister,
            get: get,
            getAll: getAll,
            getEnabledForModule: getEnabledForModule,
            isAccessibleByModule: isAccessibleByModule,
            setModuleEnabled: setModuleEnabled,
            isModuleDisabled: isModuleDisabled,
            setSkillEnabled: setSkillEnabled,
            updateSkill: updateSkill,
            getCount: getCount,
            hasSkill: hasSkill,
            parseScope: parseScope
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createSkillRegistry = createSkillRegistry;

})(window);
