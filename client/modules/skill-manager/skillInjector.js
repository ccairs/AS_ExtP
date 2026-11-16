(function(global) {

    // 附件读取单次返回上限（与 platformTools.readFile 的 20000 上限同口径）：
    // 工具结果兜底截断阈值是 32K 字符，超过会被管线再截一次（结构化字段丢失）。
    var SKILL_FILE_MAX_CHARS = 20000;

    function createSkillInjector(config) {
        config = config || {};
        var registry = config.registry || null;
        // 技能根目录（<数据目录>\skills）注入点：bootstrap 显式传，独立加载/旧装配
        // 下回落到 AEShared.getDataDir()。拿不到目录时加载结果回落旧文本格式，
        // 不阻断技能正文注入（附件能力降级，正文不受影响）。
        var getSkillsDir = (typeof config.getSkillsDir === 'function') ? config.getSkillsDir : null;
        var aefs = config.aefs || null;

        function _skillsRoot() {
            if (getSkillsDir) {
                try {
                    var injected = getSkillsDir();
                    if (injected) return String(injected).replace(/[\\/]+$/, '');
                } catch (_) {}
            }
            try {
                var dataDir = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                    ? global.AEShared.getDataDir() : null;
                if (dataDir && dataDir.dir) {
                    return String(dataDir.dir).replace(/[\\/]+$/, '') + '\\skills';
                }
            } catch (_) {}
            return '';
        }

        // 技能在磁盘上的真实目录：扫描加载的技能文件夹名可能 ≠ id（kebab 归一化），
        // 与落盘/删除同源使用 skillCreator.resolveSkillDirName（见其注释的三条判定）。
        function _skillDir(skill) {
            if (!skill) return '';
            var root = _skillsRoot();
            if (!root) return '';
            var dirName = (global.AE_LLM && typeof global.AE_LLM.resolveSkillDirName === 'function')
                ? global.AE_LLM.resolveSkillDirName(skill, skill.id)
                : String(skill.id || '');
            if (!dirName) return '';
            return root + '\\' + dirName;
        }

        function _getAefs() {
            return aefs || global.AEFS || null;
        }

        // 描述与错误提示共用的可见技能名列表（enabled + 作用域过滤）。
        // 列 name 而非 id：<available_skills> 与工具描述展示的都是 name，
        // executeSkill 的解析顺序与此保持一致（先 id 后 name）。
        function _visibleSkillNames(moduleId) {
            if (!registry) return [];
            var skills = moduleId ? registry.getEnabledForModule(moduleId) : registry.getAll();
            var names = [];
            for (var i = 0; i < skills.length; i++) {
                if (skills[i].enabled === false) continue;
                // 未知调用方（无 moduleId）只暴露全局 skill——模块级 skill 名不进共享描述，
                // 否则其他模块能在工具描述里看到本不对其开放的 skill 名
                if (!moduleId && !registry.isAccessibleByModule(skills[i], '')) continue;
                names.push(skills[i].name);
            }
            return names;
        }

        // 名单总量有界。
        // 为什么需要：Skill 的**外接**描述末尾会被追加一条救急注记（「技能详情不在系统提示词中，
        // 须用 skill_manager 查询」——见 extTools.js 的 EXTERNAL_DESC_NOTES.Skill），而描述本身
        // 按技能**全量**拼接（名字 ≤64 字、条数无上限）时，技能一多，描述越 2048 就被客户端
        // **静默截断**（无日志、/mcp UI 仍显示全文），截断点在后 → **注记整条被吞**（实测：
        // 64 字名 30 个时全丢；17 字名 104 个时同样全丢）。仓库既定约定是「指路句放最前，
        // 任何截断形态下都可见」（shaderTools.js:469-472），此处按同一精神把名单收成有界清单：
        // 最多列 SKILL_LIST_MAX 个（64 字名 × 20 + 固定前后缀 + 注记 ≈ 1.5K < 2048），
        // 其余以计数指路；且越界时**不静默**——明写「共 N 个」并指向 skill_manager。
        var SKILL_LIST_MAX = 20;
        function buildSkillsToolDescription(moduleId) {
            var names = _visibleSkillNames(moduleId);
            if (names.length === 0) return 'No skills available.';
            var shown = names.slice(0, SKILL_LIST_MAX);
            var more = names.length > shown.length
                ? ' …（共 ' + names.length + ' 个，完整名单用 skill_manager mode=list）'
                : '';
            return 'Invoke a skill by name. Available: ' + shown.join(', ') + more
                + '. See <available_skills> in system prompt for details.';
        }

        // 技能解析 + 访问闸门（executeSkill / 附件读取共用，避免两条链路各写一份判定）。
        // 顺序：先 id（目录名）精确匹配，再按 name 匹配（描述与 <available_skills> 展示的是
        // name，id 与 name 可能不同），随后统一过 enabled / 作用域 / 模块级禁用。
        function _resolveAccessibleSkill(command, moduleId) {
            if (!registry) return { error: 'Skill registry not available' };
            var skill = registry.get(command);
            if (!skill) {
                var all = registry.getAll();
                for (var i = 0; i < all.length; i++) {
                    if (all[i].name === command) { skill = all[i]; break; }
                }
            }
            if (!skill) {
                // 名单在**错误回执**里同样要有界：只收口
                // 工具描述，而这条回执是同一份名单的第二个出口——实测 300 技能时 6636 字符，
                // 超外接通道 2000 预算后被头部截断，尾部（绝大部分名单）丢失。与描述同口径：
                // 最多列 SKILL_LIST_MAX 个 + 明示总数 + 指向 skill_manager mode=list。
                var _names = _visibleSkillNames(moduleId);
                var _shown = _names.slice(0, SKILL_LIST_MAX);
                var _more = _names.length > _shown.length
                    ? ' …（共 ' + _names.length + ' 个，完整名单用 skill_manager mode=list）' : '';
                return { error: 'Skill "' + command + '" not found. Available: ' + _shown.join(', ') + _more };
            }
            if (skill.enabled === false) return { error: 'Skill "' + command + '" is currently disabled.' };
            // 先查作用域可访问性，再查模块级禁用：无权限模块统一收到 not accessible，
            // 不因"disabled for module X"报错差异探测到本不对其开放的 skill 的存在
            // 空 moduleId 同样过作用域闸门（fail-closed）——可见性契约
            // （工具描述 / <available_skills> 对未知调用方只暴露全局 skill）只在
            // 描述层生效，执行侧 moduleId 短路使空 moduleId 可执行任意模块级 skill。
            // isAccessibleByModule(skill, '') 对模块级 skill 恒 false，语义正好对齐。
            if (!registry.isAccessibleByModule(skill, moduleId)) {
                return { error: 'Skill "' + command + '" is not accessible from module "' + (moduleId || 'unknown') + '".' };
            }
            if (moduleId && registry.isModuleDisabled && registry.isModuleDisabled(skill.id, moduleId)) {
                return { error: 'Skill "' + command + '" is disabled for module "' + moduleId + '".' };
            }
            return { skill: skill };
        }

        // 加载结果的展示文本。
        //
        // 对齐 DSH 等现代 Agent 的 skill 协议：技能是**目录**（SKILL.md +
        // techniques/、reference/ 等附件），加载时给出绝对 Base directory，由调用方用
        // 自己的文件工具按需读取附件（progressive disclosure，附件正文不进上下文）。
        // 目录解析不出（旧装配/测试直接注册的 entry）时回落旧的 `--- SKILL ---` 文本，
        // 保持既有调用方与断言不变。
        function buildSkillDisplay(skill, prompt) {
            var dir = _skillDir(skill);
            if (!dir) {
                return '--- SKILL: ' + skill.name + ' ---\n\n' + prompt + '\n\n--- END SKILL: ' + skill.name + ' ---\n\nFollow the above instructions when completing the current task.';
            }
            // name 来自不可信 frontmatter：剥掉尖括号防止闭合 <skill_content> 标签
            var safeName = String(skill.name || skill.id || '').replace(/[<>]/g, '');
            return '<skill_content name="' + safeName + '">\n'
                + '<skill_resources>\n'
                + 'Base directory for this skill: ' + dir + '\n'
                + 'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.\n'
                + '</skill_resources>\n'
                + '<skill_instructions>\n'
                + prompt
                + '\n</skill_instructions>\n'
                + '</skill_content>\n\n'
                + 'Follow the above instructions when completing the current task.';
        }

        function executeSkill(command, moduleId) {
            var resolved = _resolveAccessibleSkill(command, moduleId);
            if (resolved.error) return { success: false, error: resolved.error };
            var skill = resolved.skill;
            var prompt = skill.prompt || skill.body || '';
            return {
                success: true,
                result: prompt,
                skillName: skill.name,
                display: buildSkillDisplay(skill, prompt)
            };
        }

        // 读取技能目录内附件（Skill 工具的 file 参数）。
        // 安全边界：相对路径 + 目录内限定 + 敏感路径判定都在 skillFs.readSkillFile 收口；
        // 这里只做参数形态校验与结果包装。
        async function executeSkillFile(command, moduleId, file, opts) {
            var resolved = _resolveAccessibleSkill(command, moduleId);
            if (resolved.error) return { success: false, error: resolved.error };
            var skill = resolved.skill;
            var dir = _skillDir(skill);
            if (!dir) return { success: false, error: 'Skill "' + skill.name + '" 的磁盘目录不可用（数据目录未就绪或该技能未落盘）' };
            var skillFs = (global.AE_LLM && global.AE_LLM.skillFs) ? global.AE_LLM.skillFs : null;
            if (!skillFs || typeof skillFs.readSkillFile !== 'function') {
                return { success: false, error: '附件读取不可用（skillFs 未加载），请用 readFile 工具按绝对路径读取: ' + dir };
            }
            var fsApi = _getAefs();
            if (!fsApi) return { success: false, error: '附件读取不可用（AEFS 未就绪）' };
            opts = opts || {};
            var offset = (typeof opts.offset === 'number' && isFinite(opts.offset) && opts.offset >= 0) ? Math.floor(opts.offset) : 0;
            var maxChars = (typeof opts.maxChars === 'number' && isFinite(opts.maxChars) && opts.maxChars >= 1)
                ? Math.min(Math.floor(opts.maxChars), SKILL_FILE_MAX_CHARS) : SKILL_FILE_MAX_CHARS;
            var r;
            try {
                r = await skillFs.readSkillFile(fsApi, dir, file, { offset: offset, maxChars: maxChars });
            } catch (e) {
                return { success: false, error: '附件读取异常: ' + (e && e.message ? e.message : String(e)) };
            }
            if (!r || !r.ok) {
                var code = (r && r.code) || 'READ_FAILED';
                var codeErr = (r && r.error) || '';
                if (code === 'NOT_FOUND') {
                    return { success: false, error: '附件不存在: ' + file + '（技能目录: ' + dir + '）' };
                }
                if (code === 'BINARY') {
                    return { success: false, error: '附件是二进制文件，无法按文本读取。请用 readFile/read_image 工具按绝对路径读取: ' + dir + '\\' + String(file).replace(/\//g, '\\') };
                }
                return { success: false, error: '附件读取失败（' + code + '）: ' + codeErr };
            }
            var text = String(r.text || '');
            // 技能名来自不可信 frontmatter、file 来自 LLM 入参：拼进工具输出前统一净化
            //（剥尖括号防伪造边界标记 + 截断），与 buildSkillDisplay 的 name 处理同口径
            var headName = String(skill.name || skill.id || '').replace(/[<>]/g, '').replace(/[\r\n]+/g, ' ').slice(0, 64);
            var headFile = String(file || '').replace(/[<>]/g, '').replace(/[\r\n]+/g, ' ').slice(0, 200);
            var head = '--- SKILL FILE: ' + headName + '/' + headFile
                + ' (字符 ' + r.offset + '-' + (r.offset + text.length) + ' / ' + r.total + ') ---\n';
            var tail = r.hasMore
                ? '\n\n--- 仅显示当前页；继续读取请在 Skill 工具传 offset=' + (r.offset + text.length) + ' ---'
                : '';
            return { success: true, result: text, display: head + text + tail };
        }

        function registerSkillTool(toolRegistry) {
            if (!toolRegistry || typeof toolRegistry.register !== 'function') return null;

            function updateDescription() {
                var def = toolRegistry.get('Skill');
                if (def) {
                    def.description = buildSkillsToolDescription();
                }
            }

            toolRegistry.register({
                name: 'Skill',
                description: buildSkillsToolDescription(),
                // 按调用模块动态生成描述：getLlmToolDefinitions(moduleId) 时逐模块列出可用技能，
                // 模块级 skill 名不再泄漏进其他模块的工具列表
                buildDescription: buildSkillsToolDescription,
                input_schema: {
                    type: 'object',
                    properties: {
                        command: {
                            type: 'string',
                            description: 'The skill name to load (see <available_skills> in system prompt)'
                        },
                        file: {
                            type: 'string',
                            description: AEI18n.t('可选：加载技能后读取该技能目录内的附件（相对路径，如 techniques/foo.md、reference/bar.md）。省略则只加载 SKILL.md 正文并按 Base directory 自行读取附件。')
                        },
                        offset: {
                            type: 'number',
                            description: AEI18n.t('可选（配合 file）：字符偏移，默认 0。上一页返回的末尾位置可续读')
                        },
                        maxChars: {
                            type: 'number',
                            description: AEI18n.t('可选（配合 file）：单次最多返回字符数，默认 20000，上限 20000')
                        }
                    },
                    required: ['command']
                },
                handler: function(args, execCtx) {
                    // execCtx.moduleId 由 toolExecutor 从 execute(name, args, moduleId) 透传，
                    // 使 per-skill 作用域/模块禁用检查在执行侧真正生效
                    var cmd = (args && args.command) ? args.command : '';
                    var callerModule = (execCtx && execCtx.moduleId) || '';
                    var file = (args && typeof args.file === 'string') ? args.file.trim() : '';
                    if (file) {
                        return executeSkillFile(cmd, callerModule, file, {
                            offset: args && args.offset,
                            maxChars: args && args.maxChars
                        }).then(function(result) {
                            if (!result.success) {
                                return { success: false, isError: true, content: [{ type: 'text', text: result.error }] };
                            }
                            return { success: true, isError: false, content: [{ type: 'text', text: result.display }] };
                        });
                    }
                    var result = executeSkill(cmd, callerModule);
                    if (!result.success) {
                        return { success: false, isError: true, content: [{ type: 'text', text: result.error }] };
                    }
                    return { success: true, isError: false, content: [{ type: 'text', text: result.display }] };
                },
                scope: { type: 'global' },
                stub: true,
                source: 'skill-manager',
                category: 'skill'
            });

            return { updateDescription: updateDescription };
        }

        return {
            buildSkillsToolDescription: buildSkillsToolDescription,
            executeSkill: executeSkill,
            executeSkillFile: executeSkillFile,
            registerSkillTool: registerSkillTool
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createSkillInjector = createSkillInjector;

})(window);
