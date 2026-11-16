(function (global) {
    'use strict';
    // 内容锚定文本编辑：预览区局部修改的唯一实现，
    // script 侧（submit_script）与 shader 侧（submit_shader）共用同一份——两份实现
    // 漂移是历代审计的高频缺陷源，匹配语义属正确性核心，不允许复制。
    //
    // **为什么局部编辑不再走行号**：行号只是"读取时的标注"（get_current_script /
    // get_current_shader 逐行带号）。一旦落笔依据是行号，两类漂移必然改错行且改得静默：
    //   ① 模型自己数错（数行号是弱项，aider 官方文档原话："GPT is terrible at
    //      working with source code line numbers"，其编辑格式因此不要求模型给行号）；
    //   ② 落库内容被流水线改过行数（script 侧 cleanScriptContent：剥围栏 + 末尾 trim
    //      + 压缩形态 restoreNewlines 重排 + __LINE__ 换行；shader 侧 stripFences 含
    //      trim），模型按自己草稿数出来的行号与预览区实际行号不是同一坐标系。
    // 故局部编辑按内容匹配：oldText 必须在当前内容里**逐字符唯一命中**。与主流同款——
    // Claude Code 的 Edit（old_string/new_string 精确串替换，且明令行号前缀不得进串）、
    // OpenAI Codex apply_patch（@@ 上下文锚定 + 上下文行，语法里根本没有行号）。
    // 行号仍保留在读取侧：用来"指着某一处说话"，不用来落笔。
    //
    // 契约（两个工具 handler 只消费这些纯函数，不含各自的行号/合并逻辑）：
    //   normalize(text)                  换行归一（\r\n | \r → \n）
    //   countLines(text)                 行数（与读取工具同口径：'' → 0）
    //   countMatches(content, needle)    命中次数（含重叠——重叠即歧义，必须报歧义）
    //   nearMissLines(content, needle)   首行去空白后相同的行号（≤3，供模型自纠缩进）
    //   applyEdits(content, edits)       逐处应用，失败给结构化原因
    //   applyEditsWithRefine(...)        双阶段匹配（原文未命中 → oldText 过提交流水线再试）
    //   parseRequest(args)               从工具参数取编辑请求（互斥校验 + 形状校验）
    //   formatFailure(fail, readTool)    失败原因 → 回喂模型的中文指引（两侧同一措辞）
    //
    // applyEdits 语义：
    //   - edits: [{ oldText, newText }]，按序应用，后一处在前一处的结果上匹配——第一处带上
    //     唯一上下文改掉某段后，第二处可用更短的锚点命中剩余那处（相邻同形行的连续修改是
    //     常见需求）；每处的 line 是「该步内容坐标系」里的行号（多段编辑时是中间坐标，
    //     非最终坐标——要最终坐标请用读取工具重读）。
    //   - 每处必须唯一命中：0 处 → NOT_FOUND（附近似行诊断），>1 → AMBIGUOUS（附全部
    //     命中行号，要求补上下文）。不做 replaceAll——批量改写是另一个动作，让它显式
    //     走整份提交或多处 edits，比一个开关静默改一片安全。
    //   - oldText 缺失/纯空白/与 newText 相同 → 拒绝：无意义（无改动）或明显误用
    //     （纯空白锚点会命中任意空行）。
    // 返回：
    //   { ok: true, content, results: [{ line, oldLines, newLines }] }
    //   { ok: false, index, code, message, count?, lines?, nearLines?, wsLine? }
    var MAX_EDITS = 20;   // 单次编辑处数上限（防一次调用改一片——批量改写请走整份提交）
    var WS_DIAG_MAX = 512 * 1024;   // 去空白诊断的内容上限：超过则跳过（诊断只是提示，不值得拖 UI）

    function normalize(text) {
        return String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    function countLines(text) {
        var s = String(text == null ? '' : text);
        return s ? s.split('\n').length : 0;
    }

    // 片段占用的行数（与 countLines 的区别：尾随换行不再多算一行）。回执里的
    // oldLines/newLines 与删除措辞都用它——'var b = 2;\n' 是"替换 1 行"而不是 2 行
    // （按 countLines 报会把删除整行说成"删除 2 行"）。
    function lineSpan(text) {
        var s = String(text == null ? '' : text);
        if (!s) return 0;
        return countLines(s) - (/\n$/.test(s) ? 1 : 0);
    }

    // 围栏状态：'none' 无围栏行 / 'wrapped' 整串被围栏包住（首非空行与末非空行都是围栏行）/
    // 'open' 只有开围栏、没有收围栏（模型漏写收尾围栏的常见笔误）/ 'inner' 围栏在正文中间。
    // 局部编辑只在 'wrapped' 与 'open' 时剥围栏——'inner' 时按「首尾围栏之间」取内容会静默
    // 丢掉围栏外文本、替换范围缩小（实测）；'open' 若不剥，围栏行会
    // 直接落进预览区（shader 侧必编译失败，模型只会以为自己的 GLSL 写错—— 实测）。
    function isFenceLine(line) {
        return /^\s*(?:`{3,}|~{3,})/.test(String(line == null ? '' : line));
    }

    function fenceState(text) {
        var lines = normalize(text).split('\n');
        var first = -1, last = -1;
        for (var i = 0; i < lines.length; i++) { if (lines[i].trim()) { first = i; break; } }
        for (var j = lines.length - 1; j >= 0; j--) { if (lines[j].trim()) { last = j; break; } }
        if (first === -1) return 'none';
        if (isFenceLine(lines[first])) {
            if (last > first && isFenceLine(lines[last])) return 'wrapped';
            return 'open';
        }
        for (var k = first; k <= last; k++) { if (isFenceLine(lines[k])) return 'inner'; }
        return 'none';
    }

    // 剥编辑片段的围栏：'wrapped' → 围栏之间的正文；'open' → 开围栏行之后的内容；
    // 'inner'/'none' → 原样返回（中部围栏是正文，不能剥）
    function stripEditFences(text) {
        var s = normalize(text);
        var state = fenceState(s);
        if (state !== 'wrapped' && state !== 'open') return s;
        var lines = s.split('\n');
        var first = -1, last = -1;
        for (var i = 0; i < lines.length; i++) { if (lines[i].trim()) { first = i; break; } }
        for (var j = lines.length - 1; j >= 0; j--) { if (lines[j].trim()) { last = j; break; } }
        return (state === 'open') ? lines.slice(first + 1).join('\n') : lines.slice(first + 1, last).join('\n');
    }

    // 命中次数（含重叠）：needle='aa' 在 'aaa' 里算 2 处——重叠本身即歧义，须报歧义
    function countMatches(content, needle) {
        if (!needle) return 0;
        var n = 0, i = content.indexOf(needle);
        while (i !== -1) { n++; i = content.indexOf(needle, i + 1); }
        return n;
    }

    // 命中统计（AMBIGUOUS 诊断用）：count=命中数（含重叠）、lines=命中的 1-based 行号
    // （去重、最多 cap 条）、distinctLines=去重后的命中行总数（不封顶——"同行重叠"的判据
    // 是命中数 > 去重行数，用封顶后的长度判会把"截断"误报成"同行重叠"（实测）。
    function matchStats(content, needle, cap) {
        var limit = cap || 8;
        var lines = [], distinct = {}, distinctCount = 0, count = 0;
        var i = content.indexOf(needle);
        while (i !== -1) {
            count++;
            var ln = lineOfIndex(content, i);
            if (!distinct[ln]) { distinct[ln] = true; distinctCount++; }
            if (lines.length < limit && lines[lines.length - 1] !== ln) lines.push(ln);
            i = content.indexOf(needle, i + 1);
        }
        return { count: count, lines: lines, distinctLines: distinctCount };
    }

    // 兼容旧签名（读侧/测试按行号列表用）
    function matchLines(content, needle, limit) {
        return matchStats(content, needle, limit).lines;
    }

    function lineOfIndex(content, idx) {
        var line = 1;
        for (var i = 0; i < idx && i < content.length; i++) {
            if (content.charCodeAt(i) === 10) line++;
        }
        return line;
    }

    // 首行去掉空白后相同的行号：模型多半只是缩进抄错，给它坐标让它自己对齐
    function nearMissLines(content, needle, limit) {
        var first = normalize(needle).split('\n')[0].trim();
        if (!first) return [];
        var lines = content.split('\n'), out = [], cap = limit || 3;
        for (var i = 0; i < lines.length && out.length < cap; i++) {
            if (lines[i].trim() === first) out.push(i + 1);
        }
        return out;
    }

    // 去空白后整段命中的起始行：缩进/换行差异比首行差异更常见的错法，
    // 给出"内容在，但空白不同"的坐标（仅诊断用，不做模糊替换——静默改缩进不可接受）。
    // 两道约束：① 命中起点必须是**token 边界**——某行的首个
    // 非空白字符，或前一字符是空白。否则 'e x' 去空白成 'ex' 会命中 'textureOffset' 词内，
    // 给出根本不存在的"空白差异"坐标；同时行中锚点（'a = 1;\nvar b = 2;'）只要起于空白之后
    // 仍然给坐标（只按行首判定会把这类真差异一并挡掉）；② 内容过大时直接放弃（诊断不值得拖 UI）。
    function whitespaceMatchLine(content, needle) {
        if (content.length > WS_DIAG_MAX) return 0;
        var sq = function (s) { return String(s).replace(/\s+/g, ''); };
        var sqNeedle = sq(needle);
        if (!sqNeedle) return 0;
        var pos = sq(content).indexOf(sqNeedle);
        if (pos === -1) return 0;
        var seen = 0, line = 1, lineStart = true;
        for (var i = 0; i < content.length; i++) {
            var ch = content.charAt(i);
            if (ch === '\n') { line++; lineStart = true; continue; }
            if (!/\s/.test(ch)) {
                if (seen === pos) {
                    var prev = i > 0 ? content.charAt(i - 1) : '';
                    return (lineStart || prev === '' || /\s/.test(prev)) ? line : 0;
                }
                lineStart = false;
                seen++;
            }
        }
        return 0;
    }

    function fail(code, message, extra) {
        var out = { ok: false, index: (extra && extra.index) || 0, code: code, message: message };
        if (extra) {
            if (extra.index != null) out.index = extra.index;
            if (extra.count != null) out.count = extra.count;
            if (extra.lines) out.lines = extra.lines;
            if (extra.overlap) out.overlap = true;
            if (extra.nearLines && extra.nearLines.length) out.nearLines = extra.nearLines;
            if (extra.wsLine) out.wsLine = extra.wsLine;
            if (extra.needle) out.needle = extra.needle;
        }
        return out;
    }

    // 单处应用（content 已归一换行；edits 元素形状由 parseRequest 校验过）
    function applyOne(content, edit, index) {
        var oldText = normalize(edit.oldText);
        var newText = normalize(edit.newText == null ? '' : edit.newText);
        if (!oldText) return fail('EMPTY_OLD', '第 ' + (index + 1) + ' 处编辑缺少 oldText（或为空）：局部编辑必须给出要替换的原文。', { index: index });
        if (!oldText.trim()) return fail('BLANK_OLD', '第 ' + (index + 1) + ' 处编辑的 oldText 是纯空白——无法定位（会命中任意空行），请给出完整的一段代码原文。', { index: index });
        if (oldText === newText) return fail('NO_CHANGE', '第 ' + (index + 1) + ' 处编辑的 oldText 与 newText 完全相同——没有要改的内容。', { index: index });
        var hits = countMatches(content, oldText);
        if (hits === 0) {
            return fail('NOT_FOUND', '', {
                index: index,
                nearLines: nearMissLines(content, oldText),
                wsLine: whitespaceMatchLine(content, oldText),
                needle: oldText
            });
        }
        if (hits > 1) {
            var stats = matchStats(content, oldText, 8);
            return fail('AMBIGUOUS', '', {
                index: index,
                count: hits,
                lines: stats.lines,
                overlap: hits > stats.distinctLines,   // 同行重叠命中（去重行数少于命中数）
                needle: oldText
            });
        }
        var idx = content.indexOf(oldText);
        var line = lineOfIndex(content, idx);
        var oldLines = lineSpan(oldText);
        var newLines = lineSpan(newText);
        // 删除语义的精确描述（回执文案用）：锚点自带尾换行 → 整行（或整段）消失；
        // 锚点不含尾换行且**占满整行**（行首起、行尾止）→ 留下一个空行；否则只是行内片段，
        // 该行其余内容保留（行内锚点说"留下空行"即假陈述）。
        var startsAtLineStart = (idx === 0 || content.charAt(idx - 1) === '\n');
        var endsAtLineEnd = (idx + oldText.length === content.length) || (content.charAt(idx + oldText.length) === '\n');
        return {
            ok: true,
            content: content.slice(0, idx) + newText + content.slice(idx + oldText.length),
            result: {
                // 锚点命中行号（坐标系=应用该处时的内容；多段编辑时是中间坐标，不是最终坐标
                // ——要最终坐标用读取工具重读。字段名带 anchor 前缀以免被当成"改动后位置"）
                anchorLine: line,
                oldLines: oldLines,
                newLines: newLines,
                anchorHadNewline: /\n$/.test(oldText),
                wholeLineNoNewline: startsAtLineStart && endsAtLineEnd && !/\n$/.test(oldText)
            }
        };
    }

    function applyEdits(rawContent, rawEdits) {
        var content = normalize(rawContent);
        var edits = rawEdits || [];
        if (!edits.length) return fail('NO_EDITS', '未提供任何编辑（edits 为空）。');
        if (edits.length > MAX_EDITS) {
            return fail('TOO_MANY_EDITS', 'edits 一次最多 ' + MAX_EDITS + ' 处（收到 ' + edits.length + ' 处）；更多改动请走整份提交。');
        }
        var results = [];
        for (var i = 0; i < edits.length; i++) {
            var one = applyOne(content, edits[i], i);
            if (!one.ok) return one;
            content = one.content;
            results.push(one.result);
        }
        return { ok: true, content: content, results: results };
    }

    // 双阶段匹配：先按模型给的原文匹配；**未命中**时把 oldText 过一遍提交流水线（refine）
    // 再匹配一次。必要性：预览区内容是流水线产物（script 侧已 ES3 化 + 剥围栏 + 重排；
    // shader 侧剥围栏 + trim），模型凭记忆写出的 oldText 可能是"改写前"的形态
    // （const/箭头/带围栏）——直接判未命中会让它白跑一轮；对齐落库形态后再判，命中率
    // 显著提高。两次都失败时回第一次的失败（原文口径的诊断更贴近模型输入）。
    //
    // **只 refine 失败的那一处**：批内任一处未命中时，若把
    // 所有 oldText 一起 refine 后整批重跑——pass1 已唯一命中、位置已定的那些处，其锚点被
    // 字符级改写（const→var 等）后可能在**另一个位置**唯一命中（实测：字符串内的
    // 'const A = 1;' 被改写成 'var A = 1;' 后落到真正的 var 行），静默改错位置。
    // 现在逐处推进：只对报错那一处 refine，其余保持原文锚点，最多尝试 edits 数轮。
    //
    // **歧义不 refine**：refine 是字符级改写，若拿它去救"命中多处"
    // 的输入，可能把锚点变成另一个字符串、在模型从未指名的位置唯一命中并写入。歧义必须原样
    // 回喂，让模型补上下文。
    function applyEditsWithRefine(content, edits, refine) {
        if (!refine) return applyEdits(content, edits);
        var batch = edits.slice();
        var refinedAt = {};
        for (var attempt = 0; attempt <= edits.length; attempt++) {
            var res = applyEdits(content, batch);
            if (res.ok) return res;
            if (res.code !== 'NOT_FOUND') return res;
            var k = res.index;
            if (k == null || refinedAt[k]) return res;
            var alt = String(refine(batch[k].oldText));
            if (alt === batch[k].oldText) return res;
            refinedAt[k] = true;
            batch[k] = { oldText: alt, newText: batch[k].newText };
        }
        return applyEdits(content, batch);
    }

    // 工具参数 → 编辑请求：{ mode: 'full' } | { mode: 'edit', edits: [...] } | { error: {code,message} }
    // 顶层 oldText/newText 与 edits 互斥（同时传无法判断以谁为准，且多半是模型没想清楚）；
    // 整份提交参数（script/code，名由调用方给）与局部编辑同样互斥——静默忽略一方会让模型
    // 以为改动已按另一种方式生效，是"静默改错"的同类风险。
    function parseRequest(args, fullParamName) {
        args = args || {};
        var hasTop = (args.oldText != null) || (args.newText != null);
        var hasArr = (args.edits != null);
        if (hasTop && hasArr) {
            return { error: { code: 'BOTH_FORMS', message: 'oldText/newText 与 edits 不能同时传：单处编辑用 oldText/newText，多处编辑用 edits:[{oldText,newText}]，二选一。' } };
        }
        if ((hasTop || hasArr) && fullParamName) {
            var fullText = args[fullParamName];
            if (fullText != null && String(fullText).trim() !== '') {
                return { error: { code: 'BOTH_FORMS', message: '同时传了 ' + fullParamName + ' 与 ' + (hasArr ? 'edits' : 'oldText/newText') + '：整份提交与局部编辑二选一（局部编辑时不需要传 ' + fullParamName + '，不传它才是整份提交）。' } };
            }
        }
        if (hasArr) {
            if (!Array.isArray(args.edits) || !args.edits.length) {
                return { error: { code: 'BAD_EDITS', message: 'edits 必须是非空数组：[{oldText, newText}, ...]。' } };
            }
            var list = [];
            for (var i = 0; i < args.edits.length; i++) {
                var e = args.edits[i];
                if (!e || typeof e !== 'object' || Array.isArray(e)) {
                    return { error: { code: 'BAD_EDITS', message: 'edits[' + i + '] 必须是 {oldText, newText} 对象。' } };
                }
                var badType = badFieldTypes(e, 'edits[' + i + ']');
                if (badType) return { error: badType };
                list.push({ oldText: e.oldText, newText: e.newText });
            }
            return { mode: 'edit', edits: list };
        }
        if (hasTop) {
            if (args.oldText == null || String(args.oldText) === '') {
                return { error: { code: 'EMPTY_OLD', message: '传了 newText 但没有 oldText：局部编辑必须给出要替换的原文（oldText）。' } };
            }
            var badTop = badFieldTypes(args, '');
            if (badTop) return { error: badTop };
            return { mode: 'edit', edits: [{ oldText: args.oldText, newText: args.newText }] };
        }
        return { mode: 'full' };
    }

    // 字段类型校验：oldText 必须是字符串、newText 必须是字符串或空（缺省=删除）。
    // 不靠 String() 强转——oldText:true 会变成 'true' 这个完全不同的锚点，newText:{} 会把
    // '[object Object]' 写进预览区。
    function badFieldTypes(holder, where) {
        var prefix = where ? where + ' 的 ' : '';
        if (holder.oldText != null && typeof holder.oldText !== 'string') {
            return { code: 'BAD_TYPES', message: prefix + 'oldText 必须是字符串（收到 ' + (typeof holder.oldText) + '）：它是要与预览区逐字符匹配的原文。' };
        }
        if (holder.newText != null && typeof holder.newText !== 'string') {
            return { code: 'BAD_TYPES', message: prefix + 'newText 必须是字符串（收到 ' + (typeof holder.newText) + '）：它是要写入预览区的替换文本，删除请传空串。' };
        }
        return null;
    }

    // 失败原因 → 回喂模型的中文指引。readTool 由调用方给（script/shader 两个模式
    // 的读回工具不同名，硬编码会把模型指向未注册的工具—— 同类问题）。
    function formatFailure(failObj, readTool) {
        var tool = readTool || '读取工具';
        var m = failObj.message || '';
        if (failObj.code === 'NOT_FOUND') {
            // 两项诊断并列输出（不二选一）：去空白坐标与"首行相同"的行号各指一类错法，
            // 同时给能让模型一轮对齐（wsLine 非零不压掉 nearLines）
            var diags = [];
            if (failObj.wsLine) diags.push('去空白后可在第 ' + failObj.wsLine + ' 行起匹配——多半是缩进或换行与原文不一致');
            if (failObj.nearLines && failObj.nearLines.length) diags.push('第 ' + failObj.nearLines.join('/') + ' 行内容相同但缩进或空行不同');
            return 'oldText 未在预览区找到（逐字符匹配，含缩进与空行）。' + (diags.length ? diags.join('；') + '；' : '')
                + '请先调用 ' + tool + ' 读回当前内容，原样复制要改的整段作为 oldText 后重试'
                + '（读回内容每行开头的 "N: " 是行号标注、不属于代码，不要带进 oldText）。';
        }
        if (failObj.code === 'AMBIGUOUS') {
            var lines = failObj.lines || [];
            var listText = '第 ' + lines.join('/') + ' 行';
            if (failObj.overlap) listText += '（含同行重叠命中）';
            // 行号列表有上限（8）：真被截断时说明清楚，别让模型以为列表已穷尽
            if (lines.length >= 8 && failObj.count > lines.length) listText += '，仅列前 8 处，共 ' + failObj.count + ' 处';
            return 'oldText 在预览区命中 ' + failObj.count + ' 处（' + listText + '），无法确定改哪一处。'
                + '请在 oldText 里多带前后几行上下文使其唯一后重试（或用 edits 逐处给出各自的上下文）。';
        }
        return m || ('编辑未应用（' + failObj.code + '）。');
    }

    // 操作目的描述（回执文案用）：替换 / 删除（newText 为空）。删除时按锚点与行的关系给准话
    // 锚点自带尾换行 = 整行/整段消失；锚点占满整行但没带换行 =
    // 该行留一个空行（总行数不减）；否则只是行内片段，该行其余内容保留。
    function describeEdit(results) {
        var parts = [];
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            if (r.newLines) {
                parts.push(r.oldLines + ' 行 → ' + r.newLines + ' 行');
            } else if (r.wholeLineNoNewline) {
                parts.push('删除 ' + r.oldLines + ' 行（该行留下一个空行）');
            } else if (!r.anchorHadNewline) {
                parts.push('删除 ' + r.oldLines + ' 行（行内片段，该行其余内容保留）');
            } else {
                parts.push('删除 ' + r.oldLines + ' 行');
            }
        }
        return parts.join('，');
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.textEdits = {
        MAX_EDITS: MAX_EDITS,
        WS_DIAG_MAX: WS_DIAG_MAX,
        normalize: normalize,
        countLines: countLines,
        lineSpan: lineSpan,
        countMatches: countMatches,
        lineOfIndex: lineOfIndex,
        matchLines: matchLines,
        matchStats: matchStats,
        nearMissLines: nearMissLines,
        whitespaceMatchLine: whitespaceMatchLine,
        isFenceLine: isFenceLine,
        fenceState: fenceState,
        stripEditFences: stripEditFences,
        applyOne: applyOne,
        applyEdits: applyEdits,
        applyEditsWithRefine: applyEditsWithRefine,
        parseRequest: parseRequest,
        formatFailure: formatFailure,
        describeEdit: describeEdit
    };
})(typeof global !== 'undefined' ? global : window);
