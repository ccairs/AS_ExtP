(function (global) {

  var LINK_REGEX = /\[\[([^\]]+)\]\]/g;

  var VALID_SCOPES = ['script', 'agent', 'shader', 'both'];

  // 磁盘 frontmatter 原样读回的 scope 可能含任意值，归一兜底为 'both'
  function _normalizeScope(scope) {
    return VALID_SCOPES.indexOf(scope) !== -1 ? scope : 'both';
  }

  // 旧类型归一：reference→lesson、user/feedback→preference。
  // 磁盘上仍是旧值的条目读入即映射为新类型；下次 update 落盘时会重建
  // frontmatter（update 清空 _fmRaw）写回新值，实现自愈
  function _normalizeType(type) {
    if (type === 'reference') return 'lesson';
    if (type === 'user' || type === 'feedback') return 'preference';
    return type;
  }

  // 时间戳字段（metadata.created/updated）读侧归一：非字符串（字段缺失/被手改成
  // 嵌套对象等异常形态）回空串——空串即「未记录」，与时间标注上线前的旧文件同语义，
  // 展示层据此显示「未记录」而不是崩在 getTime 上
  function _normalizeStamp(v) {
    return (typeof v === 'string') ? v.trim() : '';
  }

  // Escape a string for safe double-quoted YAML value interpolation
  function _yamlSafe(str) {
    if (str == null) return '""';
    str = String(str);
    var escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    // Escape newlines / control chars that break YAML double-quoted strings
    escaped = escaped.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    return '"' + escaped + '"';
  }

  // _yamlSafe 的逆操作——读侧双引号值按写侧转义表逆向还原
  // （\\→\、\"→"、\n→换行、\r→回车、\t→tab）。读侧只剥外层引号不反转义时，
  // 含特殊字符的 description 每轮 write→read 多一层转义，逐轮腐化。
  // 左到右单趟扫描：转义序列被消费后不再参与后续匹配，避免 \\\\ 双重还原
  function _yamlUnescape(str) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var ch = str.charAt(i);
      if (ch === '\\' && i + 1 < str.length) {
        var next = str.charAt(i + 1);
        if (next === '\\') { out += '\\'; i++; continue; }
        if (next === '"') { out += '"'; i++; continue; }
        if (next === 'n') { out += '\n'; i++; continue; }
        if (next === 'r') { out += '\r'; i++; continue; }
        if (next === 't') { out += '\t'; i++; continue; }
      }
      out += ch;
    }
    return out;
  }

  // Guard: AEFS 统一 IO，不依赖 cep.fs
  function _haveCep() {
    return typeof AEFS !== 'undefined';
  }

  // ── 同步原子写助手（对齐 nodegenStore.js 的 .tmp → renameFileSync 模式）──
  // 先写 <file>.tmp 再 rename 到正式名，写盘窗口内进程中断不再留下半截 .md/
  // 索引。同步 rename 通道（renameFileSync）仅 Bridge 可用，Bridge 挂掉时 rename
  // 恒 false，先删旧文件会把仅存的好数据删掉——此处改为回退直写正式文件（等同
  // 不先写 .tmp 的行为），并清理 .tmp。renameFileSync 不可用时直接回退直写。
  function _atomicWriteFileSync(filePath, content) {
    if (typeof AEFS.renameFileSync !== 'function') return AEFS.writeFileSync(filePath, content);
    var tmpPath = filePath + '.tmp';
    if (!AEFS.writeFileSync(tmpPath, content)) return false;
    if (AEFS.renameFileSync(tmpPath, filePath)) return true;
    var directOk = AEFS.writeFileSync(filePath, content);
    try { if (AEFS.deleteFileSync) AEFS.deleteFileSync(tmpPath); } catch (_) {}
    return directOk;
  }

  function createMemoryStore(baseDir) {
    // 兼容「目录函数」入参——数据目录支持免重启热切换（main.js 保存设置即
    // 迁移数据 + 切 getDataDir 指针），启动时固化的字符串快照会把新记忆写回旧目录。
    // 传函数时每次路径拼接现算；传字符串（旧调用/测试）行为不变。
    var _getDir = (typeof baseDir === 'function') ? baseDir : function () { return baseDir; };
    var _dirEnsured = false;
    var _dirOk = false;
    // 「已确保目录存在」缓存对应的目录快照：目录切换后 mkdir/exists 结论失效，重新探测
    var _ensuredDir = null;

    function _dir() {
      return (_getDir() || '').replace(/\//g, '\\');
    }

    // Validate name doesn't contain path traversal characters or chars rejected by AEFS _checkPath.
    // 对齐 _checkPath：拒 %/控制字符/引号/路径分隔符/.. /.段/DOS 设备名。
    // 名称会拼进 _dir() + '\\' + name + '.md'，若含非法字符 _checkPath 拒绝导致 writeFileSync 失败。
    function _validateName(name) {
      if (!name || typeof name !== 'string') return false;
      if (name.indexOf('%') !== -1) return false;  // URL 编码攻击
      for (var i = 0; i < name.length; i++) {
        var c = name.charCodeAt(i);
        if (c <= 0x1F || c === 0x7F) return false;  // 控制字符
        if (c === 0x22 || c === 0x27) return false;  // 引号 " '
      }
      if (/[\\\/\:\*\?\"\<\>\|]/.test(name)) return false;  // 路径分隔符/Windows 非法字符
      if (name === '.' || name === '..') return false;  // . / .. 段
      var upper = name.replace(/\..*$/, '').toUpperCase();
      if (upper === 'NUL' || upper === 'CON' || upper === 'PRN' || upper === 'AUX' ||
          /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) return false;  // DOS 设备名
      return true;
    }

    function _filePath(name) {
      if (!_validateName(name)) {
        throw new Error('INVALID_NAME: 名称包含非法字符 — ' + name);
      }
      return _dir() + '\\' + name + '.md';
    }

    function _indexPath() {
      return _dir() + '\\MEMORY.md';
    }

    /**
     * Ensure the memories directory exists. Cached per directory: the cache is
     * invalidated when the (possibly hot-switched) data dir changes.
     * Returns true if directory is confirmed to exist.
     */
    function _ensureDir() {
      var dir = _dir();
      if (_dirEnsured && _ensuredDir === dir) return _dirOk;
      _dirEnsured = true;
      _ensuredDir = dir;
      // 同步创建（cep.fs.mkdir / Bridge）。常见失败原因：目录已存在，或 cep.fs.mkdir 不可用
      if (AEFS.mkdirSync(dir)) { _dirOk = true; return _dirOk; }
      // mkdirSync 失败：用 existsSync（cep.fs readdir/readFile）复核目录是否真的已存在
      if (AEFS.existsSync(dir)) { _dirOk = true; return _dirOk; }
      // 同步通道都无法确认（如 readdir 不可用）：触发异步 mkdir（ExtendScript 兜底）尝试创建，
      // 不阻塞当前调用——真实不存在时 write 会自然失败暴露问题，下次调用时目录通常已建好
      console.warn('[MemoryStore] 同步建/复核目录失败，触发异步 mkdir: ' + dir);
      AEFS.mkdir(dir).then(function (ok) {
        console[ok ? 'log' : 'warn']('[MemoryStore] 异步 mkdir ' + (ok ? '成功' : '失败') + ': ' + dir);
      }).catch(function (e) {
        console.warn('[MemoryStore] 异步 mkdir 异常: ' + dir + ' ' + e);
      });
      _dirOk = true;
      return _dirOk;
    }

    /**
     * Parse YAML frontmatter from raw markdown string.
     * Checks for exact '---' delimiter (not '----' etc.)
     * Also extract [[link]] references from body text.
     * Input: raw .md file text
     * Output: { frontmatter: {}, body: string, links: string[], _fmRaw: string }
     */
    function parseFrontmatter(raw) {
      var frontmatter = {};
      var body = raw || '';
      var links = [];
      var fmText = '';

      if (!raw || typeof raw !== 'string') return { frontmatter: frontmatter, body: body, links: links, _fmRaw: '' };

      var trimmed = raw.replace(/^\s+/, '');
      // Strict: '---' must be followed by newline or end-of-string
      if (/^---(\r?\n|$)/.test(trimmed)) {
        // Find the closing '---' (must be at start of a line)
        var lines = trimmed.split(/\r?\n/);
        var fmLines = [];
        var bodyStart = 0;
        for (var i = 1; i < lines.length; i++) {
          if (lines[i] === '---') {
            bodyStart = i + 1;
            break;
          }
          fmLines.push(lines[i]);
        }

        if (bodyStart > 0) {
          fmText = fmLines.join('\n');
          body = lines.slice(bodyStart).join('\n').trim();

          // Parse YAML subset line by line
          var currentKey = null;

          for (var i = 0; i < fmLines.length; i++) {
            var line = fmLines[i];
            var colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;

            var leadingSpaces = line.search(/\S/);
            if (leadingSpaces === -1) continue;

            var key = line.substring(0, colonIdx).trim();
            var value = line.substring(colonIdx + 1).trim();

            // Strip surrounding quotes if present
            var wasQuoted = false;
            if (value.length >= 2
              && ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"')
               || (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'"))) {
              // 双引号包裹值在剥引号后按写侧 _yamlSafe 转义表反转义——
              // 只剥不还原会让含引号/反斜杠/换行的值每轮 write→read 多一层
              // 转义，逐轮腐化。单引号包裹保持现状（写侧不产出该形态）
              var wasDoubleQuoted = value.charAt(0) === '"';
              value = value.substring(1, value.length - 1);
              if (wasDoubleQuoted) value = _yamlUnescape(value);
              wasQuoted = true;
            }

            if (leadingSpaces === 0) {
              currentKey = key;
              // 带引号的空串（description: ""）是显式字符串值，读侧保持 ''——
              // 落入 {} 分支会让空描述跨重启腐化为 [object Object]（read 的
              // fm.description || '' 拦不住空对象），再经 _yamlSafe/索引行永久写坏；
              // 仅裸 key 无值（metadata:）才建嵌套对象承载缩进子字段
              if (value.length > 0 || wasQuoted) {
                frontmatter[key] = value;
              } else {
                frontmatter[key] = {};
              }
            } else {
              if (currentKey && typeof frontmatter[currentKey] === 'object') {
                frontmatter[currentKey][key] = value;
              }
            }
          }
        }
      } else {
        // No frontmatter — the whole raw string is body
        body = raw;
      }

      // Extract [[links]]
      var match;
      LINK_REGEX.lastIndex = 0;
      while ((match = LINK_REGEX.exec(body)) !== null) {
        var linkTarget = match[1].trim();
        // Handle Wiki-style pipe: [[target|display]] → target
        var pipeIdx = linkTarget.indexOf('|');
        if (pipeIdx !== -1) {
          linkTarget = linkTarget.substring(0, pipeIdx).trim();
        }
        if (linkTarget && links.indexOf(linkTarget) === -1) {
          links.push(linkTarget);
        }
      }

      return { frontmatter: frontmatter, body: body, links: links, _fmRaw: fmText || '' };
    }

    /**
     * Generate complete .md file content from an entry object
     */
    function generateMarkdown(entry) {
      var lines = [];

      if (entry._fmRaw) {
        lines.push('---');
        lines.push(entry._fmRaw);
        lines.push('---');
      } else {
        lines.push('---');
        lines.push('name: ' + _yamlSafe(entry.name));
        lines.push('description: ' + _yamlSafe(entry.description));
        lines.push('metadata:');
        lines.push('  type: ' + _yamlSafe(entry.type || 'project'));
        if (entry.scope) {
          lines.push('  scope: ' + _yamlSafe(entry.scope));
        }
        // 时间戳仅在有名值时输出（空串=未记录，不写 `created: ""` 占位）——
        // 标时间戳上线前创建的旧条目保持无该行，下次 update 只补 updated
        if (entry.created) {
          lines.push('  created: ' + _yamlSafe(entry.created));
        }
        if (entry.updated) {
          lines.push('  updated: ' + _yamlSafe(entry.updated));
        }
        lines.push('---');
      }
      lines.push('');
      if (entry.content) {
        lines.push(entry.content);
      }
      return lines.join('\n');
    }

    /**
     * Read a single memory entry from disk.
     * Returns full entry object including parsed links, or null if not found.
     * Includes _fmRaw to preserve frontmatter through write cycles.
     */
    function read(name) {
      if (!name) return null;
      if (!_haveCep()) return null;
      _ensureDir();
      try {
        var fp = _filePath(name);
        var raw = AEFS.readFileSync(fp);
        if (!raw) {
          // 区分「读失败」与「不存在/空文件」——null 是通道故障折叠值，
          // existsSync 复核文件在场时抛错（调用方工具层承接为可见错误，LLM 不再
          // 收到误导性的 NOT_FOUND）；空串/真不存在维持旧语义返回 null
          if (raw === null && typeof AEFS.existsSync === 'function' && AEFS.existsSync(fp)) {
            throw new Error('MEMORY_READ_FAILED: 读取失败（通道故障）: ' + name);
          }
          console.warn('[MemoryStore] read failed: ' + name);
          return null;
        }
        var parsed = parseFrontmatter(raw);
        var fm = parsed.frontmatter;

        // frontmatter name 与传入 name（索引 slug，即 .md 文件名）不一致时，
        // 以传入 name 为唯一权威回填 entry.name——update 链路 read→改字段→write 用
        // entry.name 拼落盘路径，沿用 fm.name 会把更新内容写到另一文件名，索引与
        // 旧文件保持旧内容（重启即丢 + 双文件分叉）。写路径永远用索引名，不一致时告警。
        var resolvedName = fm.name || name;
        if (resolvedName !== name) {
          console.warn('[MemoryStore] frontmatter name "' + resolvedName + '" 与索引名 "' + name + '" 不一致，已以索引名为准回填');
          resolvedName = name;
        }

        return {
          name: resolvedName,
          description: fm.description || '',
          type: _normalizeType((fm.metadata && fm.metadata.type) || 'project'),
          scope: _normalizeScope(fm.metadata && fm.metadata.scope),
          created: _normalizeStamp(fm.metadata && fm.metadata.created),
          updated: _normalizeStamp(fm.metadata && fm.metadata.updated),
          content: parsed.body,
          filePath: 'memories/' + name + '.md',
          links: parsed.links,
          backlinks: [],
          _fmRaw: parsed._fmRaw
        };
      } catch (e) {
        // 通道故障哨兵重抛（其余异常维持吞错返回 null 的旧语义——
        // parse 等本地异常不该炸工具层）
        if (e && e.message && String(e.message).indexOf('MEMORY_READ_FAILED') === 0) throw e;
        console.warn('[MemoryStore] read exception: ' + name + ' ' + e);
        return null;
      }
    }

    /**
     * Write a memory entry to .md file, and update MEMORY.md index.
     * Returns { ok: true } on success, { ok: false, error: string } on failure.
     */
    function write(entry) {
      if (!entry || !entry.name) return { ok: false, error: 'MISSING_ENTRY' };
      if (!_haveCep()) return { ok: false, error: 'NO_CEP' };
      if (!_ensureDir()) return { ok: false, error: 'DIR_ERROR' };

      try {
        var md = generateMarkdown(entry);
        var fp = _filePath(entry.name);

        // 原子写（.tmp → renameFileSync）——直写中断留半截 .md，重启后
        // parseFrontmatter 读出残缺条目
        if (!_atomicWriteFileSync(fp, md)) {
          var errMsg = 'WRITE_FAILED: ' + fp;
          console.warn('[MemoryStore] ' + errMsg);
          return { ok: false, error: errMsg };
        }

        var idxOk = _updateIndexEntry(entry.name, entry.description);
        if (!idxOk) {
            // 文件已写但 MEMORY.md 索引未收录（极罕见：Bridge 与 cep.fs 同时失败）：
            // 保持"部分成功"降级语义，返回成功并告警——若返回失败，调用方会把整个写入判为失败
            // 且不登记 _map，磁盘留下无法通过 memory_read 访问的孤儿 .md，比索引缺失更糟
            console.warn('[MemoryStore] index update failed for: ' + entry.name + ' (file is written)');
            return { ok: true, warning: 'INDEX_UPDATE_FAILED' };
        }

        console.log('[MemoryStore] write ok: ' + entry.name);
        return { ok: true };
      } catch (e) {
        console.warn('[MemoryStore] write exception: ' + entry.name + ' ' + e);
        return { ok: false, error: 'EXCEPTION: ' + e };
      }
    }

    /**
     * 索引行解析（与 list() 同款）：返回行的链接目标 slug，非索引行返回 null。
     */
    function _indexLineSlug(line) {
      var m = line.match(/^-\s*\[([^\]]+)\]\(([^)]+\.md)\)/);
      return m ? m[2].replace(/\.md$/, '') : null;
    }

    /**
     * Update one line in MEMORY.md index, appending if not found.
     */
    function _updateIndexEntry(name, description) {
      var idxPath = _indexPath();
      var lines = [];
      var raw = AEFS.readFileSync(idxPath);
      // readFileSync 失败返 null、空文件返 ''：只有 null 才是读失败。
      // 空索引（删光最后一条后 _removeIndexEntry 会写出空文件）是合法读，
      // 若按 falsy 判失败会跳过追加 → 新条目永不入索引。
      if (raw !== null && raw !== undefined) {
        lines = raw.split('\n');
      } else if (AEFS.existsSync(idxPath)) {
        // 索引文件存在却读失败（通道故障）：宁可不更新索引也不能用单行覆盖，
        // 否则其余条目的索引行全部丢失，重启后这些 .md 成不可见孤儿。
        // 返回 false 走 write() 的 INDEX_UPDATE_FAILED 降级语义（文件已写、告警）。
        console.warn('[MemoryStore] index read failed, skip update: ' + idxPath);
        return false;
      }

      // 索引行单行化：description 含换行会破坏 MEMORY.md 行格式导致 list() 正则解析失败
      var desc = description ? String(description).replace(/[\n\r]+/g, ' ').trim() : '';
      var newLine = '- [' + name + '](' + name + '.md)' + (desc ? ' - ' + desc : '');

      // 精确匹配：解析行结构比对链接目标，避免 description 中偶现的 "(xxx.md)" 子串误命中他人索引行
      var found = false;
      for (var i = 0; i < lines.length; i++) {
        if (_indexLineSlug(lines[i]) === name) {
          lines[i] = newLine;
          found = true;
          break;
        }
      }

      if (!found) {
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
        lines.push(newLine);
      }

      // 索引同样原子写——MEMORY.md 半截会导致 list() 正则漏解析其余条目
      return _atomicWriteFileSync(idxPath, lines.join('\n'));
    }

    function _removeIndexEntry(name) {
      var idxPath = _indexPath();
      var raw = AEFS.readFileSync(idxPath);
      // 对齐 _updateIndexEntry 的读失败防护：readFileSync 失败返 null、空文件返 ''。
      // 只有 null/undefined 才是「索引读失败」≠「文件不存在」——
      // 读失败但文件存在时若当 true 返回，remove 会静默报成功跳过清理，索引行残留
      // 成重启后 list() 的幽灵条目；文件真不存在（外部被删）返回 true，无需清理。
      if (raw === null || raw === undefined) {
        return !AEFS.existsSync(idxPath);
      }
      var lines = raw.split('\n');
      // 与 _updateIndexEntry 同款精确匹配，只删本条目自己的索引行
      var filtered = [];
      for (var i = 0; i < lines.length; i++) {
        if (_indexLineSlug(lines[i]) === name) continue;
        filtered.push(lines[i]);
      }
      // 索引原子写的姊妹位置：remove 清索引行同样走 .tmp→renameFileSync
      //（_updateIndexEntry 已原子；此处在写中断会留半截 MEMORY.md，重启后
      // list() 正则漏解析其余条目）
      return _atomicWriteFileSync(idxPath, filtered.join('\n'));
    }

    function remove(name) {
      if (!name) return { ok: false, error: 'MISSING_NAME' };
      if (!_haveCep()) return { ok: false, error: 'NO_CEP' };
      _ensureDir();
      try {
        var fp = _filePath(name);
        // 文件存在但删除失败（占用/锁定/通道故障）必须报错：否则索引行被清、
        // 调用方收到"已删除"，磁盘却残留 .md（重启后成不可见孤儿文件）。
        // 文件本就不存在（外部被删）则继续清索引行，属正常清理。
        var existed = AEFS.existsSync(fp);
        if (existed && !AEFS.deleteFileSync(fp)) {
          return { ok: false, error: 'DELETE_FAILED: ' + fp };
        }
        var idxOk = _removeIndexEntry(name);
        if (!idxOk) {
          // .md 已删（不可恢复）但索引行清理失败（索引读/写通道故障）——
          // 对齐 write() 的 INDEX_UPDATE_FAILED 降级语义：返回成功 + warning，
          // 注明重启后 list() 会出现幽灵条目，供 LLM 工具/面板透传给用户
          console.warn('[MemoryStore] index cleanup failed for: ' + name + ' (file is deleted)');
          return { ok: true, warning: 'INDEX_CLEANUP_FAILED: 文件已删除但索引行清理失败，重启后可能出现幽灵条目: ' + name };
        }
        console.log('[MemoryStore] remove ok: ' + name);
        return { ok: true };
      } catch (e) {
        console.warn('[MemoryStore] remove exception: ' + name + ' ' + e);
        return { ok: false, error: 'REMOVE_ERROR: ' + e };
      }
    }

    function exists(name) {
      if (!name) return false;
      if (!_haveCep()) return false;
      try {
        var fp = _filePath(name);
        // existsSync 先行——存在性探测语义对口，
        // 消除「readFileSync 探不存在文件 → AEFS 误记 readFileSync 全部通道失败」
        // 噪音（建前查重每条新记忆必经）。文件在但读不出（读通道故障）时
        // existsSync 仍探得 → 按存在（「无法校验按存在」fail-safe 原语义保持，
        // quickBarScanner 同款先例）——查重据此拒绝 create，防覆盖磁盘
        // 上未入索引的同名手工 .md。existsSync 不可用（极端 mock 环境）回退
        // readFileSync !== null 旧行为。
        if (typeof AEFS.existsSync !== 'function') return AEFS.readFileSync(fp) !== null;
        return AEFS.existsSync(fp);
      } catch (e) {
        return false;
      }
    }

    function list(scopeFilter) {
      if (!_haveCep()) return [];
      _ensureDir();
      var result = [];

      var idxPath = _indexPath();
      var raw = AEFS.readFileSync(idxPath);
      // 索引读失败（null，通道故障折叠值）不折叠为空列表——existsSync
      // 复核：文件在但读不出时抛错（调用方 memory 工具 catch 承接 / registry.init
      // 的哨兵守卫承接——init 为同步函数，其 .catch 挂不上同步 throw，
      // 哨兵由 init 内 try/catch 消化后以空集继续），全部记忆不再对 UI 与 LLM
      // 「假性消失」；真不存在/空文件维持空列表语义
      if (raw === null) {
        if (typeof AEFS.existsSync === 'function' && AEFS.existsSync(idxPath)) {
          throw new Error('MEMORY_INDEX_READ_FAILED: 索引读取失败（通道故障），已中止以防空列表覆盖: ' + idxPath);
        }
        raw = '';
      }
      if (raw) {
        var lines = raw.split('\n');
        var lineRegex = /^-\s*\[([^\]]+)\]\(([^)]+\.md)\)\s*(-\s*(.*))?/;
        for (var i = 0; i < lines.length; i++) {
          var match = lines[i].match(lineRegex);
          if (match) {
            var slug = match[2].replace(/\.md$/, '');
            var desc = (match[4] || '').trim();
            if (scopeFilter) {
              var entry = read(slug);
              if (!entry) continue;
              if (entry.scope !== scopeFilter && entry.scope !== 'both') continue;
            }
            result.push({
              name: slug,
              description: desc,
              type: 'project'
            });
          }
        }
      }

      return result;
    }

    // Validate scope to prevent path traversal
    function _validateScope(scope) {
      return scope === 'script' || scope === 'agent' || scope === 'shader';
    }

    function readRule(scope) {
      if (!_validateScope(scope)) return null;
      if (!_haveCep()) return null;
      try {
        var rulesDir = _dir() + '\\rules';
        var path = rulesDir + '\\' + scope + '.md';
        var raw = AEFS.readFileSync(path);
        if (!raw) return null;
        var parsed = parseFrontmatter(raw);
        return { content: parsed.body, scope: scope, type: 'rule' };
      } catch (e) {
        console.warn('[MemoryStore] readRule exception: ' + scope + ' ' + e);
        return null;
      }
    }

    function writeRule(scope, content) {
      if (!_validateScope(scope)) return false;
      if (!_haveCep()) return false;
      try {
        var rulesDir = _dir() + '\\rules';
        var path = rulesDir + '\\' + scope + '.md';
        // 空内容视为未设置：删除规则文件，回到默认空状态。
        // 文件本就不存在视为成功；存在但删除失败（占用/锁定/通道故障）必须返回 false，
        // 否则用户以为规则已清空、重启后规则"复活"
        // 存在性判定用 existsSync（对齐 remove() 350 行口径）——readFileSync
        // 在"Bridge 返回 null 且 cep.fs 读失败"的通道故障路径同样返回 null，会被
        // 误判为"文件不存在"→清空路径 return true 虚假成功，磁盘规则原样残留。
        // 改判后文件存在即走删除，删除通道故障由 deleteFileSync 返回 false 如实上报
        if (!content || !content.trim()) {
          if (!AEFS.existsSync(path)) return true;
          return AEFS.deleteFileSync(path);
        }
        AEFS.mkdirSync(rulesDir);
        var yaml = '---\ntype: rule\nscope: ' + scope + '\n---\n\n' + content;
        // 规则文件同样走原子写（对齐同文件 write 的 修复）——
        // 直写中断留半截 rule .md，重启后 parseFrontmatter 读出残缺规则；规则路径漏改
        return _atomicWriteFileSync(path, yaml);
      } catch (e) {
        console.warn('[MemoryStore] writeRule exception: ' + scope + ' ' + e);
        return false;
      }
    }

    return {
      read: read,
      write: write,
      remove: remove,
      list: list,
      exists: exists,
      readRule: readRule,
      writeRule: writeRule,
      _parseFrontmatter: parseFrontmatter,
      _generateMarkdown: generateMarkdown
    };
  }

  global.AEMemory = global.AEMemory || {};
  global.AEMemory.createMemoryStore = createMemoryStore;
})(window);
