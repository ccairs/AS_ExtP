/**
 * aeApiReference.txt 解析器与查询引擎
 *
 * 启动时把纯文本 API 参考解析成结构化索引，供 queryAeApi 工具按需查询。
 *
 * 解析规则（与 aeApiReference.txt 格式检查脚本 checkApiRefFormat.js 对齐）：
 *   - 对象标题: ## XXX 对象（描述）
 *   - 章节标题: 【属性】/【方法】
 *   - 方法条目: Object.methodName()，后续缩进行为其描述
 *   - 属性条目: Object.propertyName，后续缩进行为其描述
 *   - 描述行: 4 空格 + → 开头
 *   - 分隔符: =====================
 */
(function (global) {
    var ns = global.AEEngine;
    if (!ns) { ns = {}; global.AEEngine = ns; }
    ns.apiReference = ns.apiReference || null;

    // 解析后的结构化数据
    //   objects: { 'app': {name, description, members: [...]}, ... }
    //   memberIndex: { 'app.project': {object, member}, ... }（精确查找用）
    //   rawText: 原始文本（兜底全文搜索）
    var _index = null;
    var _rawText = '';

    // ── 解析 ──
    function parse(text) {
        var lines = text.split(/\r?\n/);
        var objects = {};
        var memberIndex = {};

        var currentObject = null;       // {name, description, members:[]}
        var currentMember = null;       // {object, name, kind, signature, params, description, returnType}
        var currentSection = null;      // 'property' | 'method'

        // 对象标题: ## XXX 对象（描述）
        var OBJ_TITLE_RE = /^## (.+?) 对象（(.+?)）$/;
        // 章节标题
        var SEC_PROP_RE = /^【属性】$/;
        var SEC_METHOD_RE = /^【方法】$/;
        // 方法名行: Object.methodName()
        var METHOD_RE = /^([a-zA-Z][a-zA-Z0-9]*)\.([a-zA-Z0-9]+)\(\)$/;
        // 属性名行: Object.propertyName
        var PROPERTY_RE = /^([a-zA-Z][a-zA-Z0-9]*)\.([a-zA-Z0-9]+)$/;
        // 描述行: 4 空格 + → 内容
        var DESC_RE = /^    → (.*)$/;
        // 分隔符
        var SEP_RE = /^=+$/;

        // 字段标记别名：中文版（现状）与 ASCII 版（英文参考文档）并存。
        // 解析器只认标记前缀，因此参考文档可以逐语言重建而不改解析逻辑。
        var FIELD_MARKS = [
            ['签名:', 'signature'],
            ['@sig:', 'signature'],
            ['参数:', 'params'],
            ['@params:', 'params'],
            ['返回:', 'returnType'],
            ['@returns:', 'returnType']
        ];

        function flushMember() {
            if (!currentMember || !currentObject) return;
            currentObject.members.push(currentMember);
            var fullKey = currentMember.object + '.' + currentMember.name;
            memberIndex[fullKey] = {
                object: currentMember.object,
                member: currentMember
            };
            currentMember = null;
        }

        function flushObject() {
            flushMember();
            if (currentObject) {
                objects[currentObject.name] = currentObject;
            }
            currentObject = null;
            currentSection = null;
        }

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];

            // 空行：结束当前 member
            if (line.trim() === '') {
                flushMember();
                continue;
            }

            // 分隔符：结束当前对象
            if (SEP_RE.test(line)) {
                flushObject();
                continue;
            }

            // 文件头注释（# 开头但非 ##）
            if (/^# /.test(line) && !/^## /.test(line)) {
                continue;
            }

            // 对象标题
            var objMatch = line.match(OBJ_TITLE_RE);
            if (objMatch) {
                flushObject();
                currentObject = {
                    name: objMatch[1],
                    description: objMatch[2],
                    members: []
                };
                continue;
            }

            // 章节标题
            if (SEC_PROP_RE.test(line)) {
                flushMember();
                currentSection = 'property';
                continue;
            }
            if (SEC_METHOD_RE.test(line)) {
                flushMember();
                currentSection = 'method';
                continue;
            }

            // 方法名行
            var methodMatch = line.match(METHOD_RE);
            if (methodMatch) {
                flushMember();
                if (!currentObject) continue;
                currentMember = {
                    object: methodMatch[1],
                    name: methodMatch[2],
                    kind: 'method',
                    signature: '',
                    params: '',
                    description: '',
                    returnType: ''
                };
                continue;
            }

            // 属性名行
            var propMatch = line.match(PROPERTY_RE);
            if (propMatch) {
                flushMember();
                if (!currentObject) continue;
                currentMember = {
                    object: propMatch[1],
                    name: propMatch[2],
                    kind: 'property',
                    signature: '',
                    params: '',
                    description: '',
                    returnType: ''
                };
                continue;
            }

            // 描述行
            var descMatch = line.match(DESC_RE);
            if (descMatch && currentMember) {
                var content = descMatch[1];
                var mark = null;
                for (var mi = 0; mi < FIELD_MARKS.length; mi++) {
                    if (content.indexOf(FIELD_MARKS[mi][0]) === 0) { mark = FIELD_MARKS[mi]; break; }
                }
                if (mark) {
                    currentMember[mark[1]] = content.substring(mark[0].length).trim();
                } else {
                    // 累积描述行（多行描述用 \n 连接）
                    if (currentMember.description) {
                        currentMember.description += '\n' + content;
                    } else {
                        currentMember.description = content;
                    }
                }
                continue;
            }

            // 对象标题下方的直接描述行（无章节标题的对象，如 LightLayer 等）
            if (descMatch && currentObject && !currentSection && !currentMember) {
                if (!currentObject.intro) currentObject.intro = '';
                if (currentObject.intro) {
                    currentObject.intro += '\n' + descMatch[1];
                } else {
                    currentObject.intro = descMatch[1];
                }
                continue;
            }
        }

        flushObject();

        return {
            objects: objects,
            memberIndex: memberIndex,
            rawText: text
        };
    }

    // ── 查询：精确匹配 ──
    function queryExact(query) {
        // 支持 "Object.member" 或 "member" 形式
        if (query.indexOf('.') !== -1) {
            var hit = _index.memberIndex[query];
            if (hit) {
                return [formatMember(hit.member)];
            }
            // 尝试去掉括号（如 "Property.setValueAtTime" 已能直接命中，但 "Property.setValueAtTime()" 需要 strip）
            var stripped = query.replace(/\(\)$/, '');
            hit = _index.memberIndex[stripped];
            if (hit) return [formatMember(hit.member)];
            return [];
        }
        // 仅 member 名：在所有成员中查找
        var results = [];
        var objs = _index.objects;
        for (var objName in objs) {
            if (!Object.prototype.hasOwnProperty.call(objs, objName)) continue;
            var obj = objs[objName];
            for (var i = 0; i < obj.members.length; i++) {
                if (obj.members[i].name === query) {
                    results.push(formatMember(obj.members[i]));
                }
            }
        }
        return results;
    }

    // ── 查询：整对象 ──
    function queryObject(objectName) {
        var obj = _index.objects[objectName];
        if (!obj) return [];
        var lines = [];
        lines.push('## ' + obj.name + ' 对象（' + obj.description + '）');
        if (obj.intro) {
            lines.push(obj.intro);
            lines.push('');
        }
        // 按章节分组输出
        var properties = [];
        var methods = [];
        for (var i = 0; i < obj.members.length; i++) {
            if (obj.members[i].kind === 'method') {
                methods.push(obj.members[i]);
            } else {
                properties.push(obj.members[i]);
            }
        }
        if (properties.length > 0) {
            lines.push('【属性】');
            for (var p = 0; p < properties.length; p++) {
                lines.push(formatMember(properties[p]));
            }
            lines.push('');
        }
        if (methods.length > 0) {
            lines.push('【方法】');
            for (var m = 0; m < methods.length; m++) {
                lines.push(formatMember(methods[m]));
            }
        }
        return [lines.join('\n')];
    }

    // ── 查询：模糊（关键词分词匹配） ──
    function queryFuzzy(query) {
        // 分词：按空格、点号、括号切分，过滤空串
        var rawTokens = query.split(/[\s.()]+/);
        var tokens = [];
        for (var t = 0; t < rawTokens.length; t++) {
            var tok = rawTokens[t].trim();
            if (tok) tokens.push(tok.toLowerCase());
        }
        if (tokens.length === 0) return [];

        // 评分每个成员
        var scored = [];
        var objs = _index.objects;
        for (var objName in objs) {
            if (!Object.prototype.hasOwnProperty.call(objs, objName)) continue;
            var obj = objs[objName];
            // 对象名本身也参与匹配
            var objNameLower = objName.toLowerCase();
            for (var i = 0; i < obj.members.length; i++) {
                var m = obj.members[i];
                var fullKey = (m.object + '.' + m.name).toLowerCase();
                var memberNameLower = m.name.toLowerCase();
                var descLower = (m.description || '').toLowerCase();

                var score = 0;
                for (var k = 0; k < tokens.length; k++) {
                    var token = tokens[k];
                    if (fullKey.indexOf(token) !== -1) score += 5;        // 完整路径命中
                    else if (memberNameLower.indexOf(token) !== -1) score += 3; // 成员名命中
                    else if (objNameLower.indexOf(token) !== -1) score += 2;    // 对象名命中
                    else if (descLower.indexOf(token) !== -1) score += 1;       // 描述命中
                }
                if (score > 0) {
                    scored.push({ score: score, member: m });
                }
            }
        }

        // 按分数降序
        scored.sort(function (a, b) { return b.score - a.score; });

        // 取前 8 个
        var results = [];
        var limit = Math.min(8, scored.length);
        for (var j = 0; j < limit; j++) {
            results.push(formatMember(scored[j].member));
        }
        return results;
    }

    // ── 格式化成员为可读文本 ──
    function formatMember(m) {
        var lines = [];
        var header = m.object + '.' + m.name + (m.kind === 'method' ? '()' : '');
        lines.push(header);
        if (m.signature) lines.push('    → 签名: ' + m.signature);
        if (m.params) lines.push('    → 参数: ' + m.params);
        if (m.description) lines.push('    → ' + m.description);
        if (m.returnType) lines.push('    → 返回: ' + m.returnType);
        return lines.join('\n');
    }

    // ── 对外查询入口 ──
    function query(queryStr, mode) {
        if (!_index) {
            return {
                success: false,
                error: 'API 参考未加载',
                content: []
            };
        }
        var q = (queryStr || '').trim();
        if (!q) {
            return {
                success: false,
                error: '查询不能为空',
                content: []
            };
        }
        var m = mode || 'fuzzy';
        var results;
        if (m === 'exact') {
            results = queryExact(q);
        } else if (m === 'object') {
            results = queryObject(q);
        } else {
            results = queryFuzzy(q);
        }
        // 合并效果/属性 matchName 结果（object 模式只看对象模型，不合并）
        if (m !== 'object') {
            var mnHits = queryMatchName(q);
            if (mnHits.length > 0) {
                results = mnHits.concat(results);
            }
        }
        return {
            success: true,
            count: results.length,
            content: results
        };
    }

    // ── matchName 词典（效果/属性匹配名，数据见 client/shared/aeMatchName.json） ──
    // _matchNames: { '小写关键字': [entry...] }，entry = { mn, en, zh }
    // 关键字含 matchName 本身 + 英文显示名 + 中文显示名，中英文均可查询。
    var _matchNames = null;

    function initMatchNames(data) {
        if (!data || typeof data !== 'object') return;
        _matchNames = {};
        for (var mn in data) {
            if (!Object.prototype.hasOwnProperty.call(data, mn)) continue;
            var e = data[mn] || {};
            var entry = { mn: mn, en: String(e.en || ''), zh: String(e.zh || '') };
            var keys = [mn.toLowerCase()];
            if (entry.en) keys.push(entry.en.toLowerCase());
            if (entry.zh) keys.push(entry.zh.toLowerCase());
            for (var k = 0; k < keys.length; k++) {
                var key = keys[k];
                if (!_matchNames[key]) _matchNames[key] = [];
                _matchNames[key].push(entry);
            }
        }
        console.log('[apiReference] matchName 词典加载: ' + Object.keys(_matchNames).length + ' 个关键字');
    }

    function formatMatchName(e) {
        var line = 'matchName: ' + e.mn;
        var names = [];
        if (e.en && e.en !== e.mn) names.push(e.en);
        if (e.zh) names.push(e.zh);
        if (names.length > 0) line += '（' + names.join(' / ') + '）';
        return line;
    }

    function queryMatchName(q) {
        if (!_matchNames) return [];
        var ql = String(q || '').trim().toLowerCase();
        if (!ql) return [];
        var out = [];
        var seen = {};
        function push(entry) {
            if (seen[entry.mn]) return;
            seen[entry.mn] = true;
            out.push(formatMatchName(entry));
        }
        // 精确命中（中/英/原名任一完全匹配）
        var exact = _matchNames[ql];
        if (exact) {
            for (var i = 0; i < exact.length; i++) push(exact[i]);
            return out;
        }
        // 模糊：分词后任一 token 包含命中
        var tokens = ql.split(/[\s.()]+/).filter(function (t) { return t; });
        if (tokens.length === 0) return out;
        for (var key in _matchNames) {
            if (!Object.prototype.hasOwnProperty.call(_matchNames, key)) continue;
            for (var t = 0; t < tokens.length; t++) {
                if (key.indexOf(tokens[t]) !== -1) {
                    var arr = _matchNames[key];
                    for (var j = 0; j < arr.length; j++) push(arr[j]);
                    break;
                }
            }
            if (out.length >= 8) break;
        }
        return out;
    }

    // ── 列出所有对象（供 LLM 发现可用 API 范围） ──
    function listObjects() {
        if (!_index) return [];
        var list = [];
        var objs = _index.objects;
        for (var name in objs) {
            if (!Object.prototype.hasOwnProperty.call(objs, name)) continue;
            var obj = objs[name];
            list.push({
                name: obj.name,
                description: obj.description,
                propertyCount: obj.members.filter(function (m) { return m.kind === 'property'; }).length,
                methodCount: obj.members.filter(function (m) { return m.kind === 'method'; }).length
            });
        }
        return list;
    }

    // ── 初始化入口 ──
    function init(text) {
        _rawText = text;
        _index = parse(text);
        ns.apiReference = text;  // 兼容旧代码
        ns.apiIndex = _index;    // 暴露索引供调试
        console.log('[apiReference] 解析完成: ' +
            Object.keys(_index.objects).length + ' 个对象, ' +
            Object.keys(_index.memberIndex).length + ' 个成员');
        return _index;
    }

    function isReady() {
        return _index !== null;
    }

    // 导出
    ns.apiReferenceModule = {
        init: init,
        initMatchNames: initMatchNames,
        isReady: isReady,
        query: query,
        listObjects: listObjects,
        parse: parse  // 暴露供测试
    };
})(window);
