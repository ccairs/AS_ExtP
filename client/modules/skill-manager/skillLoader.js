(function(global) {

    // 结束 --- 后接受文件尾（无尾换行的合法 SKILL.md 会整体解析失败，
    // frontmatter 为 null）。(?:$|\n) 用非捕获组保持组号不变（组2 仍为 body）
    var YAML_FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:$|\n)([\s\S]*)$/;
    // | / |- / |+ 块标量指示符（行内 `key: |`，或 `key:` 下一行单独成行）
    var BLOCK_SCALAR_RE = /^\|[-+]?$/;

    function parseFrontmatter(content) {
        if (typeof content !== 'string') return { frontmatter: null, body: content || '' };
        var match = content.match(YAML_FRONTMATTER_RE);
        if (!match) return { frontmatter: null, body: content || '' };

        var rawYaml = match[1];
        var body = match[2] || '';
        var frontmatter = parseSimpleYaml(rawYaml);
        return { frontmatter: frontmatter, body: body };
    }

    function _indentOf(line) {
        var m = line.match(/^ */);
        return m ? m[0].length : 0;
    }

    // 结束 | 多行块：按非空内容行的最小缩进剥离公共缩进。
    // chomping 变体按 YAML 语义区分——`|-` strip（去全部尾换行，原行为）、
    // `|` clip（保留单个尾换行）、`|+` keep（保留全部尾换行）。三种变体统一
    // 按 strip 处理，第三方 SKILL.md 的 `|`/`|+` 块尾部换行静默丢失。
    // （本项目 serializeSkillMd 不写块标量——prompt 走正文、字段走引号字符串，
    // 块标量仅出现在外部来源，读侧修正不影响自有回环。）
    function _finishMultiline(result, block) {
        var minIndent = -1;
        for (var i = 0; i < block.lines.length; i++) {
            if (block.lines[i].trim() === '') continue;
            var ind = _indentOf(block.lines[i]);
            if (minIndent < 0 || ind < minIndent) minIndent = ind;
        }
        if (minIndent < 0) { result[block.key] = ''; return; }
        var vals = [];
        for (var j = 0; j < block.lines.length; j++) {
            vals.push(block.lines[j].trim() === '' ? '' : block.lines[j].slice(minIndent));
        }
        var chomp = block.chomp || '';
        if (chomp !== '+') {
            while (vals.length && vals[vals.length - 1] === '') vals.pop();
        }
        var joined = vals.join('\n');
        if (chomp === '' || chomp === '+') joined += '\n';
        result[block.key] = joined;
    }

    function parseSimpleYaml(yamlStr) {
        // null-prototype 承载——SKILL.md 来自不可信外部来源，`__proto__:`
        // 键在普通 {} 上会被原型 setter 拦截（数组值时改写 result 原型、原始值时静默
        // 丢失键），与 skillRegistry/toolRegistry 的既有原型污染防护同一类问题。
        var result = Object.create(null);
        var lines = yamlStr.split('\n');
        var currentKey = null;
        var currentKeyIndent = 0;
        var currentArray = null;
        var currentMultiline = null;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var trimmed = line.trim();

            // | 多行块：空行与比 key 更深缩进的行均为内容；
            // 遇到缩进不深于 key 的非空行即结束，该行回落为普通属性行继续解析
            if (currentMultiline !== null) {
                if (trimmed !== '' && _indentOf(line) <= currentMultiline.indent) {
                    _finishMultiline(result, currentMultiline);
                    currentMultiline = null;
                } else {
                    currentMultiline.lines.push(line);
                    continue;
                }
            } else if (trimmed === '' || trimmed.startsWith('#')) {
                continue;
            }

            if (trimmed.startsWith('|')) {
                if (currentKey && BLOCK_SCALAR_RE.test(trimmed)) {
                    currentMultiline = { key: currentKey, lines: [], indent: currentKeyIndent, chomp: trimmed.slice(1) };
                    continue;
                }
            }

            if (currentArray !== null && trimmed.startsWith('- ')) {
                var arrItem = trimmed.substring(2).trim();
                // 数组项与键值对（下方引号剥离逻辑）对称剥引号：
                // 序列化侧写 `- "foo"`，不剥则回读为字面 `"foo"`，引号逐轮累积腐化
                if (arrItem.length >= 2 && ((arrItem.charAt(0) === '"' && arrItem.charAt(arrItem.length - 1) === '"')
                    || (arrItem.charAt(0) === "'" && arrItem.charAt(arrItem.length - 1) === "'"))) {
                    arrItem = arrItem.slice(1, -1);
                }
                currentArray.push(arrItem);
                continue;
            }

            var colonIdx = line.indexOf(':');
            if (colonIdx >= 0) {
                var key = line.substring(0, colonIdx).trim();
                var value = line.substring(colonIdx + 1).trim();

                if (currentArray !== null) {
                    currentArray = null;
                }

                if (value === '') {
                    // 前瞻：跳过空行与注释行找第一个有效行，判断数组项 / | 块标量 / 普通空值。
                    // 只看紧邻下一行会把 "allowed-tools:\n\n  - x" 误判为空值，数组静默丢失
                    var look = i + 1;
                    while (look < lines.length && (lines[look].trim() === '' || lines[look].trim().charAt(0) === '#')) look++;
                    var nextNonEmpty = look < lines.length ? lines[look] : null;
                    if (nextNonEmpty && nextNonEmpty.trim().startsWith('- ')) {
                        currentArray = [];
                        currentKey = key;
                        currentKeyIndent = _indentOf(line);
                        result[key] = currentArray;
                        i = look - 1; // 跳过空行，下一轮直接处理数组首项
                    } else if (nextNonEmpty && BLOCK_SCALAR_RE.test(nextNonEmpty.trim())) {
                        currentKey = key;
                        currentKeyIndent = _indentOf(line);
                        currentMultiline = { key: key, lines: [], indent: currentKeyIndent, chomp: nextNonEmpty.trim().slice(1) };
                        i = look; // 跳到 | 行（for 自增后从其下一行开始收集内容）
                    } else {
                        currentKey = key;
                        currentKeyIndent = _indentOf(line);
                        result[key] = '';
                    }
                } else if (BLOCK_SCALAR_RE.test(value)) {
                    // 行内 `key: |` 形式（标准 YAML 块标量写法）
                    currentKey = key;
                    currentKeyIndent = _indentOf(line);
                    currentMultiline = { key: key, lines: [], indent: currentKeyIndent, chomp: value.slice(1) };
                } else if (value.startsWith('"') && value.endsWith('"')) {
                    result[key] = value.slice(1, -1);
                    currentArray = null;
                } else if (value.startsWith("'") && value.endsWith("'")) {
                    result[key] = value.slice(1, -1);
                    currentArray = null;
                } else if (value === 'true') {
                    result[key] = true;
                    currentArray = null;
                } else if (value === 'false') {
                    result[key] = false;
                    currentArray = null;
                } else if (/^-?\d+(\.\d+)?$/.test(value)) {
                    result[key] = parseFloat(value);
                    currentArray = null;
                } else {
                    result[key] = value;
                    currentArray = null;
                }
            }
        }

        if (currentMultiline !== null) {
            _finishMultiline(result, currentMultiline);
        }

        return result;
    }

    // kebab-case 归一化（扫描时"文件夹名 → 技能 id"用）。
    // 顺序不可颠倒：先转小写再替换非法字符。若写作
    // `replace(/[^a-z0-9-]/g,'-').toLowerCase()`——大写字母先被替换成连字符再转小写，
    // `My Skill` 归一成 `-y--kill` 照样过不了校验：等于只救了全小写名字。
    // 连续非法字符折成一个 `-`（`my--skill`、`AE_Tools` 都收敛成合法形态）并去掉首尾 `-`。
    // 返回空串表示原名不含任何 ASCII 字母数字（如纯中文）——能否回落由调用方决定。
    function kebabSlug(value) {
        var s = String(value === undefined || value === null ? '' : value).toLowerCase();
        return s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    function validateSkillDef(skillDef) {
        var errors = [];

        if (!skillDef.id || typeof skillDef.id !== 'string') {
            errors.push('MISSING_ID');
        } else if (skillDef.id.length > 64) {
            errors.push('ID_TOO_LONG: max 64 chars, got ' + skillDef.id.length);
        } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillDef.id)) {
            errors.push('INVALID_ID_FORMAT: ' + skillDef.id + ' (must be kebab-case: lowercase, hyphens only between segments)');
        }

        if (!skillDef.name || typeof skillDef.name !== 'string') {
            errors.push('MISSING_NAME');
        } else if (skillDef.name.length > 64) {
            errors.push('NAME_TOO_LONG: max 64 chars, got ' + skillDef.name.length);
        }

        if (!skillDef.description || typeof skillDef.description !== 'string') {
            errors.push('MISSING_DESCRIPTION');
        } else if (skillDef.description.length > 1024) {
            errors.push('DESCRIPTION_TOO_LONG: max 1024 chars, got ' + skillDef.description.length);
        }

        if (!skillDef.prompt && skillDef.body) {
            skillDef.prompt = skillDef.body;
        }

        if (!skillDef.prompt || typeof skillDef.prompt !== 'string' || skillDef.prompt.trim().length === 0) {
            errors.push('MISSING_PROMPT');
        }

        return errors;
    }

    // 从 SKILL.md 文本解析 skill 定义（安装链路 installFromContent 使用）
    function parseSkillMd(content, sourcePath) {
        if (!content) return null;

        var parsed = parseFrontmatter(content);
        var fm = parsed.frontmatter || {};
        var rawMeta = fm.metadata || null;
        if (typeof rawMeta === 'string') { try { rawMeta = JSON.parse(rawMeta); } catch (_) {} }

        return {
            id: fm.name || null,
            name: fm.name || null,
            description: fm.description || '',
            prompt: parsed.body || '',
            body: parsed.body || '',
            allowedTools: Array.isArray(fm['allowed-tools']) ? fm['allowed-tools'] : null,
            license: fm.license || null,
            compatibility: fm.compatibility || null,
            metadata: rawMeta,
            category: fm.category || 'general',
            version: fm.version || null,
            sourcePath: sourcePath || null
        };
    }

    function createSkillInstaller() {
        function installFromContent(content, sourcePath, registry, scope) {
            var skillDef = parseSkillMd(content, sourcePath);
            if (!skillDef) {
                return { ok: false, error: 'PARSE_FAILED' };
            }
            // 与 installFromPath/loadSkill 一致：安装前做结构校验，缺 id/name/description/prompt 或格式非法则拒绝
            var validationErrors = validateSkillDef(skillDef);
            if (validationErrors.length > 0) {
                return { ok: false, error: 'VALIDATE_FAILED: ' + validationErrors.join('; ') };
            }
            skillDef.skillPath = sourcePath || 'inline';
            skillDef.scope = scope || 'global';
            var result = registry.register(skillDef);
            if (!result.ok) {
                return { ok: false, error: result.error, detail: result.detail };
            }
            return { ok: true, entry: result.entry };
        }

        return {
            installFromContent: installFromContent
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createSkillInstaller = createSkillInstaller;
    global.AE_LLM.parseSkillFrontmatter = parseFrontmatter;
    global.AE_LLM.validateSkillDef = validateSkillDef;
    global.AE_LLM.kebabSlug = kebabSlug;

})(window);
