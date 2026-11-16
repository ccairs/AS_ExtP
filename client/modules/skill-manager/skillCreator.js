/**
 * skillCreator.js — LLM 创作 Skill 的无 UI 核心
 *
 * 职责：参数校验 → SKILL.md 序列化 → AEFS 落盘 → skillRegistry 注册/更新。
 * 所有文件 IO 只走 AEFS 异步版（自带 Bridge → cep.fs → ExtendScript 回退链，
 * 且 writeFile 会自动创建父目录），不直接触碰 cep.fs / Node / ExtendScript。
 *
 * 由 bootstrap.js 以真实依赖装配；测试中以 mock AEFS 注入。
 */
(function (global) {

    /**
     * 净化 YAML 双引号标量值。
     *
     * 为什么不能反斜杠转义：skillLoader 的 YAML 子集解析器（skillLoader.js
     * parseSimpleYaml）对双引号值只做去首尾引号，不做 \" / \n 反转义。
     * 若序列化时写入 \" 或 \n 转义序列，回读会得到字面反斜杠字符（数据腐化）。
     * 唯一无损方案：保证值单行且不含双引号 —— 写什么读回什么。
     */
    function sanitizeYamlValue(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/"/g, "'")
            .replace(/ {2,}/g, ' ')
            .trim();
    }

    /**
     * 把 skill 定义序列化为 SKILL.md 文本。
     * frontmatter 值全部经 sanitizeYamlValue 净化；正文（prompt）原样输出 ——
     * frontmatter 正则锚定文件头（^---\s*\n…\n---\s*\n），正文中的 --- 行不干扰解析。
     */
    function serializeSkillMd(skill) {
        skill = skill || {};
        var lines = ['---'];
        lines.push('name: "' + sanitizeYamlValue(skill.name || skill.id) + '"');
        lines.push('description: "' + sanitizeYamlValue(skill.description) + '"');
        if (skill.category && skill.category !== 'general') {
            lines.push('category: "' + sanitizeYamlValue(skill.category) + '"');
        }
        if (skill.license) lines.push('license: "' + sanitizeYamlValue(skill.license) + '"');
        if (skill.version) lines.push('version: "' + sanitizeYamlValue(skill.version) + '"');
        // compatibility 由 parseSkillMd 读入、registry entry 持有，缺此行会让
        // UI 编辑/LLM update 重写 SKILL.md 时静默丢失该字段
        if (skill.compatibility) lines.push('compatibility: "' + sanitizeYamlValue(skill.compatibility) + '"');
        if (Array.isArray(skill.allowedTools) && skill.allowedTools.length > 0) {
            lines.push('allowed-tools:');
            for (var i = 0; i < skill.allowedTools.length; i++) {
                lines.push('  - "' + sanitizeYamlValue(skill.allowedTools[i]) + '"');
            }
        }
        // scope 存进 metadata.ae_llm（与 bootstrap._parseSkillMd 的读取路径一致）
        var meta = {};
        if (skill.metadata && typeof skill.metadata === 'object') {
            var mk = Object.keys(skill.metadata);
            for (var mi = 0; mi < mk.length; mi++) { meta[mk[mi]] = skill.metadata[mk[mi]]; }
        }
        if (skill.scope) {
            meta.ae_llm = meta.ae_llm || {};
            meta.ae_llm.scope = skill.scope;
        }
        if (Object.keys(meta).length > 0) {
            lines.push('metadata: ' + JSON.stringify(meta));
        }
        lines.push('---');
        lines.push('');
        lines.push(skill.prompt || '');
        return lines.join('\n');
    }

    /**
     * 把 scope 注入 SKILL.md frontmatter 的 metadata.ae_llm.scope。
     *
     * 安装链路（UI view.js 与 LLM llmTools.js）落盘时必须注入：磁盘是重启后的
     * 事实源（bootstrap 按目录重扫），漏注入会让模块级 skill 静默回落 global。
     * 幂等：content 已含相同 scope 时重写结果不变。
     */
    function injectScopeToSkillMd(rawContent, scope) {
        if (!rawContent || !scope) return rawContent;
        var fmMatch = rawContent.match(/^---\s*\n([\s\S]*?)\n---/);
        if (!fmMatch) {
            // 没有 frontmatter，重建一个
            return '---\nmetadata: {"ae_llm":{"scope":' + JSON.stringify(scope) + '}}\n---\n\n' + rawContent;
        }
        var fmBlock = fmMatch[1];
        var rest = rawContent.substring(fmMatch[0].length);
        // [ \t]* 限定同行空白：\s* 会匹配换行，把 metadata: 空值后的下一行
        //（license: MIT / 缩进子键等）卷进替换范围，导致该行被静默删除（数据丢失）
        var metaMatch = fmBlock.match(/^metadata:[ \t]*(.+)$/m);
        var newFmBlock;
        if (metaMatch && /^\|[-+]?$/.test(metaMatch[1].trim())) {
            // 块标量形态 metadata（metadata: | / |- / |+）——下方 JSON.parse
            // 对 '|' 单字符必然抛错走 catch 整行替换，块标量的后续缩进内容行会残留成
            // 孤立行，破坏 frontmatter 结构。跳过注入原样返回（scope 不落盘，重启后
            // 回落 global，好过结构损坏）
            return rawContent;
        }
        if (metaMatch) {
            try {
                var meta = JSON.parse(metaMatch[1].trim());
                meta.ae_llm = meta.ae_llm || {};
                meta.ae_llm.scope = scope;
                // 替换串必须是函数：字符串形式的替换串会把 JSON 内容中的 $&/$$/$`
                // 当作替换模式展开（$& 注入整行原文、$$ 折叠为 $），写出损坏的 metadata
                newFmBlock = fmBlock.replace(metaMatch[0], function () { return 'metadata: ' + JSON.stringify(meta); });
            } catch (_) {
                newFmBlock = fmBlock.replace(metaMatch[0], function () { return 'metadata: {"ae_llm":{"scope":' + JSON.stringify(scope) + '}}'; });
            }
        } else {
            newFmBlock = fmBlock + '\nmetadata: {"ae_llm":{"scope":' + JSON.stringify(scope) + '}}';
        }
        return '---\n' + newFmBlock + '\n---' + rest;
    }

    /**
     * 技能在磁盘上的目录名（凡按 id 拼路径的落盘/删除/卸载都必须先经此解析）。
     *
     * 两条链路 skillPath 的含义不同，只有一条能当目录名用：
     *  - 扫描加载（bootstrap 扫 <数据目录>\skills 一层子目录）：skillPath = 真实文件夹名。
     *    文件夹名经 kebab 归一化后可能 ≠ id（`My Skill` → id `my-skill`，目录仍是 `My Skill`），
     *    此时若按 id 拼路径会写错目录 → 卸载后磁盘残留、"重启复活"的幽灵技能。
     *  - 安装链路：skillPath = 来源 URL / 本地路径 / 'inline'，不是目录名（该链路 id 即目录名）。
     * 故仅在 skillPath 是"单段目录名"时采信它，否则回落 id。与 serializeSkillMd /
     * injectScopeToSkillMd 同一分工：一份判定供 UI 与 LLM 两条链路共用。
     */
    function resolveSkillDirName(entry, fallbackId) {
        var id = (entry && entry.id) ? String(entry.id) : String(fallbackId || '');
        var sp = (entry && entry.skillPath) ? String(entry.skillPath) : '';
        if (!sp || sp === '.' || sp === '..' || sp === 'inline') return id;
        if (/[\\/:*?"<>|]/.test(sp)) return id;
        return sp;
    }

    // ── SKILL.md 原子写助手（对齐 nodegenStore.js 的 .tmp → rename 模式）──
    // 先写 <file>.tmp 再 rename 到正式名，写盘窗口内进程中断不再留下半截 SKILL.md。
    // renameFile 不可用（极端降级环境/仅 mock writeFile 的旧测试）时回退直写。
    // （姊妹位，与 llmTools.js / providerRegistry.js / nodegenStore.js
    // 同族收口）：rename 失败后的重试不再「删旧正式文件」——旧文件先挪 .recovery-<ts>
    // 旁路，rename 成功才删旁路；仍失败则两份内容都留在盘上（tmp 改名 .recovery
    // 留存、旁路旧文件尽力放回原位）。「删旧 + rename 失败 + catch 清 tmp」
    // 会把新旧内容一同销毁（两份同毁，overwrite/create 覆盖场景旧 SKILL.md 全丢）。
    function _atomicWriteFile(aefs, filePath, content) {
        if (typeof aefs.renameFile !== 'function') return aefs.writeFile(filePath, content);
        var tmpPath = filePath + '.tmp';
        var _inRetry = false;   // 重试阶段 tmp 可能成为新内容唯一副本，兜底不得清理
        var _recoverySeq = 0;
        function _nextRecoveryPath() {
            _recoverySeq = (_recoverySeq + 1) % 1000000000;
            return filePath + '.recovery-' + Date.now() + '-' + _recoverySeq;
        }
        function _cleanupTmp() {
            try { if (aefs.deleteFile) aefs.deleteFile(tmpPath).catch(function () {}); } catch (_) {}
        }
        function _preserveBothCopies(asidePath, movedOk) {
            var keepPath = _nextRecoveryPath();
            var park = aefs.renameFile(tmpPath, keepPath).catch(function () {});
            var restore = movedOk ? aefs.renameFile(asidePath, filePath).catch(function () {}) : null;
            return Promise.all([park, restore || Promise.resolve()]).then(function () { return false; });
        }
        return aefs.writeFile(tmpPath, content).then(function (writeOk) {
            if (!writeOk) return false;
            return aefs.renameFile(tmpPath, filePath).then(function (renameOk) {
                if (renameOk) return true;
                // rename 失败先复核 tmp 仍在——并发写交错时（另一路写
                // 恰好消费了同名 tmp），失败原因是 tmp 缺失而非目标已存在，动正式
                // 文件会毁掉并发者刚落位的好数据
                var recheck = (typeof aefs.exists === 'function')
                    ? aefs.exists(tmpPath) : Promise.resolve(true);
                return recheck.then(function (tmpAlive) {
                    if (!tmpAlive) return false;
                    var asidePath = _nextRecoveryPath();
                    _inRetry = true;
                    var moveAside = aefs.renameFile(filePath, asidePath).then(function (ok) { return ok; },
                        function () { return false; });
                    return moveAside.then(function (movedOk) {
                        return aefs.renameFile(tmpPath, filePath).then(function (retryOk) {
                            if (!retryOk) return _preserveBothCopies(asidePath, movedOk);
                            if (movedOk && aefs.deleteFile) {
                                try { aefs.deleteFile(asidePath).catch(function () {}); } catch (_) {}
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

    /**
     * 创建 Skill 核心工厂（依赖注入）。
     * deps:
     *   skillRegistry  — 必填，内存注册表
     *   getSkillsDir   — 必填，返回 <数据目录>\skills 的函数
     *   aefs           — 可选，默认 global.AEFS（测试注入 mock）
     *   onChanged      — 可选，创建/覆盖成功后回调（用于刷新 Skill 工具描述）
     */
    function createSkillCreator(deps) {
        deps = deps || {};
        var skillRegistry = deps.skillRegistry || null;
        var getSkillsDir = typeof deps.getSkillsDir === 'function' ? deps.getSkillsDir : function () { return ''; };
        var aefs = deps.aefs || global.AEFS;
        var onChanged = typeof deps.onChanged === 'function' ? deps.onChanged : function () {};

        function _fail(code, detail) {
            return { ok: false, error: code, detail: detail || '' };
        }

        /**
         * 创建（或覆盖）一个 Skill。
         * @param {object} args { name, description, prompt, category?, overwrite?, scope? }
         *   scope 可选：'global' | moduleId(string) | { type:'global' } | { type:'module', moduleId:'xxx' }
         *   缺省为 { type: 'global' }。传入字符串非 'global' 时视为 module scope，moduleId=该字符串。
         * @returns {Promise<{ok:boolean, error?:string, detail?:string, id?:string, path?:string, overwritten?:boolean, message?:string}>}
         */
        async function createSkill(args) {
            args = args || {};
            if (!skillRegistry) return _fail('NO_REGISTRY', 'skillRegistry 未注入');
            if (!aefs || typeof aefs.writeFile !== 'function') return _fail('NO_AEFS', 'AEFS 不可用，无法写文件');

            var name = String(args.name === undefined || args.name === null ? '' : args.name).trim();
            var description = sanitizeYamlValue(args.description);
            var prompt = String(args.prompt === undefined || args.prompt === null ? '' : args.prompt);
            var category = args.category ? sanitizeYamlValue(args.category) : 'general';
            var overwrite = args.overwrite === true;

            // scope 规范化：复用 registry.parseScope（若不可用则本地兜底）
            var scope;
            if (typeof skillRegistry.parseScope === 'function') {
                scope = skillRegistry.parseScope(args.scope);
            } else if (args.scope && typeof args.scope === 'object') {
                scope = args.scope;
            } else if (typeof args.scope === 'string' && args.scope !== 'global') {
                scope = { type: 'module', moduleId: args.scope };
            } else {
                scope = { type: 'global' };
            }

            // 与安装链路同一套校验规则（kebab-case id / description ≤1024 / prompt 必填）
            var validate = global.AE_LLM && global.AE_LLM.validateSkillDef;
            if (validate) {
                var errors = validate({ id: name, name: name, description: description, prompt: prompt });
                if (errors.length) return _fail('INVALID_SKILL', errors.join('; '));
            }

            var exists = skillRegistry.hasSkill(name);
            if (exists && !overwrite) {
                return _fail('DUPLICATE_ID', 'Skill "' + name + '" 已存在。确认覆盖请设 overwrite: true，或换一个 name。');
            }

            // 覆盖时保留磁盘上已有的扩展字段（allowedTools/license/version/metadata）：
            // updateSkill 分支不会清空这些内存字段，若序列化时丢弃会造成内存保留、
            // 磁盘丢失的不一致——重启后字段消失
            var existing = exists ? skillRegistry.get(name) : null;

            var content = serializeSkillMd({
                name: name, description: description, category: category, scope: scope, prompt: prompt,
                allowedTools: existing ? existing.allowedTools : undefined,
                license: existing ? existing.license : undefined,
                version: existing ? existing.version : undefined,
                compatibility: existing ? existing.compatibility : undefined,
                metadata: existing ? existing.metadata : undefined
            });

            // 序列化校验：用系统解析器回读，确认无损（防 YAML 注入 / 解析器差异），失败不落盘
            var parser = global.AE_LLM && global.AE_LLM.parseSkillFrontmatter;
            if (parser) {
                var back = parser(content);
                var fm = back.frontmatter || {};
                if (fm.name !== name || fm.description !== description) {
                    return _fail('SERIALIZE_MISMATCH', 'SKILL.md 序列化自检失败（回读不一致），未写入磁盘。');
                }
            }

            // 落盘：先 mkdir 再 writeFile（AEFS 异步版自带完整回退链；writeFile 内部也会 ensureParent）
            var dir = getSkillsDir();
            if (!dir) return _fail('NO_SKILLS_DIR', '数据目录未就绪，无法定位 skills 目录');
            // 覆盖已存在的技能时写回它的真实目录：扫描加载的技能文件夹名可能 ≠ id
            //（kebab 归一化），按 id 新建目录会留下两份 SKILL.md（重启后撞 DUPLICATE_ID）
            var skillDir = dir + '\\' + resolveSkillDirName(existing, name);
            var mdPath = skillDir + '\\SKILL.md';
            var mkOk = await aefs.mkdir(skillDir);
            if (!mkOk) return _fail('MKDIR_FAILED', '无法创建目录: ' + skillDir);
            // 原子写（.tmp → rename）——直写中断留半截 SKILL.md，重启后加载失败
            var wOk = await _atomicWriteFile(aefs, mdPath, content);
            if (!wOk) return _fail('WRITE_FAILED', 'SKILL.md 写入失败: ' + mdPath);

            // 注册/更新内存 registry（磁盘已是事实源，此步失败则回滚文件保持一致）
            var regResult;
            if (exists) {
                regResult = skillRegistry.updateSkill(name, {
                    name: name, description: description, prompt: prompt, category: category, scope: scope
                });
            } else {
                regResult = skillRegistry.register({
                    id: name, name: name, description: description, prompt: prompt,
                    skillPath: name, scope: scope, category: category, enabled: true
                });
            }
            if (!regResult || !regResult.ok) {
                // 回滚删文件仅限“新建”分支。overwrite 分支的 SKILL.md 是用户已存在的
                // 文件且内容刚被覆盖——此时 deleteFile 等于把旧内容也彻底删掉（回滚变毁灭）。
                // 磁盘是事实源，registry 更新失败会在下次 load 自愈；覆盖分支保留文件仅报错。
                if (!exists) {
                    try { await aefs.deleteFile(mdPath); } catch (_) {}
                    // 一并清理已创建的空目录，避免残留孤儿目录（容错：不存在/删除失败不致命）
                    try { if (typeof aefs.rmdirSync === 'function') aefs.rmdirSync(skillDir); } catch (_) {}
                }
                return _fail(
                    (regResult && regResult.error) ? regResult.error : 'REGISTER_FAILED',
                    (regResult && regResult.detail) ? regResult.detail : ''
                );
            }

            onChanged();
            return {
                ok: true,
                id: name,
                overwritten: exists,
                path: mdPath,
                message: 'Skill "' + name + '" 已' + (exists ? '覆盖更新' : '创建') + '并注册。'
                    + '后续对话可通过 Skill 工具（command: "' + name + '"）加载使用；'
                    + '本会话剩余轮次的工具列表已固定，新 Skill 从下一轮对话起可见。'
            };
        }

        /**
         * 把 createSkill 注册为 LLM 工具。
         * scope 为 global：Agent / Script / Shader 三种模式均可用。
         */
        function registerTool(toolRegistry) {
            if (!toolRegistry || typeof toolRegistry.register !== 'function') return false;
            toolRegistry.register({
                name: 'createSkill',
                description: '创作一个新 Skill（领域知识技能）：生成 SKILL.md 落盘并立即注册。'
                    + 'name 必须 kebab-case（如 ae-text-animator）；'
                    + 'description 一句话说明用途（会展示在 <available_skills> 列表）；'
                    + 'prompt 为 Markdown 正文，之后通过 Skill 工具按 name 加载。'
                    + '同名已存在时需 overwrite=true 才会覆盖。',
                input_schema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: AEI18n.t('Skill ID，kebab-case（小写字母/数字/连字符），≤64 字符，如 ae-text-animator')
                        },
                        description: {
                            type: 'string',
                            description: AEI18n.t('一句话描述（≤1024 字符），展示在可用技能列表中')
                        },
                        prompt: {
                            type: 'string',
                            description: AEI18n.t('Markdown 正文（SKILL.md body），加载后作为领域指令注入对话')
                        },
                        category: {
                            type: 'string',
                            description: AEI18n.t('可选分类，默认 general')
                        },
                        overwrite: {
                            type: 'boolean',
                            description: AEI18n.t('同名 Skill 已存在时是否覆盖，默认 false')
                        }
                    },
                    required: ['name', 'description', 'prompt']
                },
                handler: function (args) {
                    return createSkill(args).then(function (r) {
                        if (!r.ok) {
                            return {
                                success: false, isError: true,
                                content: [{ type: 'text', text: r.error + (r.detail ? ' — ' + r.detail : '') }]
                            };
                        }
                        return {
                            success: true, isError: false,
                            content: [{ type: 'text', text: r.message + '\n路径: ' + r.path }]
                        };
                    });
                },
                scope: { type: 'global' },
                source: 'skill-manager',
                category: 'skill'
            });
            return true;
        }

        return {
            createSkill: createSkill,
            registerTool: registerTool,
            serializeSkillMd: serializeSkillMd
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.serializeSkillMd = serializeSkillMd;
    global.AE_LLM.injectScopeToSkillMd = injectScopeToSkillMd;
    global.AE_LLM.resolveSkillDirName = resolveSkillDirName;
    // 原子写文件助手导出：skillFs.writePackage 写 SKILL.md 时复用（同一份 .tmp→rename
    // 与 .recovery 兜底逻辑，不复制第二份——两份拷贝漂移是本仓反复踩过的坑）
    global.AE_LLM.atomicWriteFile = _atomicWriteFile;
    global.AE_LLM.createSkillCreator = createSkillCreator;

})(window);
