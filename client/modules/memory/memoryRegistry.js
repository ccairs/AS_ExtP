(function (global) {

  // 类型按"记忆关于什么"统一维度：lesson=踩坑经验/API 实测行为，
  // project=项目约定进展，preference=用户身份偏好与习惯纠正（旧 user/feedback 已合并）
  var VALID_TYPES = ['lesson', 'project', 'preference'];
  var VALID_SCOPES = ['script', 'agent', 'shader', 'both'];

  // 写入时间戳口径：UTC ISO（toISOString），与面板/
  // bridge 日志同口径；展示层（面板展开详情 / memory_read / memory_list）再转本地
  // 时间。时间戳在 registry 层盖（add/update 知其语义），store 只负责序列化——
  // 因此 store.write 的直调方（测试等）不受影响、老行为不变
  function _nowIso() {
    return new Date().toISOString();
  }

  function createMemoryRegistry(store) {
    var _store = store;
    // null-prototype：name 经 kebab-case 校验后仍可取 'constructor'/'toString' 等
    // Object.prototype 属性名，普通对象上 get() 会命中原型链返回假条目（如 Object
    // 构造函数），update() 更会污染全局对象并向磁盘写垃圾 .md（与 serverLifecycle
    // 的 null-proto 状态表防护对齐）
    var _map = Object.create(null); // { name: entry }
    // 索引读取失败标记——供上层（bootstrap 的 memory_list、面板空态）如实
    // 说明"索引读失败"而非误导性的"暂无记忆"（后者会诱导用户/LLM 重建数据）。
    // 首次失败即置位（重试窗口内也如此），重试成功即清除
    var _indexReadFailed = false;
    // 索引重试间隔（首次读失败 → 1.5s 后重读一次）
    var INDEX_RETRY_DELAY_MS = 1500;

    function _isIndexSentinel(e) {
      return !!(e && e.message && String(e.message).indexOf('MEMORY_INDEX_READ_FAILED') === 0);
    }

    function _isEntrySentinel(e) {
      return !!(e && e.message && String(e.message).indexOf('MEMORY_READ_FAILED') === 0);
    }

    /**
     * Load entries from a raw list (as returned by store.list()) into _map.
     */
    function _loadList(list) {
      for (var i = 0; i < list.length; i++) {
        var name = list[i].name;
        var entry;
        try {
          entry = _store.read(name);
        } catch (e) {
          // 单条读失败不再炸毁整个 init—— 引入的通道故障哨兵
          // （杀毒瞬时锁定 .md 等）若无守卫会冲出循环，其后全部记忆不加载（单条失败应当
          // 仅跳过该条）。哨兵（message 前缀匹配，判定方式对齐 memoryStore.read
          // 的重抛条件）→ 告警 + 跳过该条；其余异常按现状上抛（read 内部已吞
          // 非哨兵异常，保守兜底）
          if (_isEntrySentinel(e)) {
            console.warn('[MemoryRegistry] init 跳过读取失败的记忆条目（通道故障）: ' + name);
            continue;
          }
          throw e;
        }
        if (entry) {
          _map[name] = entry;
        }
      }
      resolveBacklinks();
      console.log('[MemoryRegistry] ' + 'init loaded ' + Object.keys(_map).length + ' memories');
    }

    /**
         * 索引读失败（哨兵）后 1.5s 重试一次；成功则正常建索引，仍失败才置
         * _indexReadFailed 标记并保留 _map 现状继续（_map 为空才建空表——重试
         * 窗口内新建的条目不被失败重试抹掉）。返回 Promise（与 init 同形状），
         * 调用方（bootstrap .then、controller.init）保持向后兼容。环境无
         * setTimeout（极端 mock）时跳过重试，保持「以空集继续」语义。
         */
    function _retryInit() {
      return new Promise(function (resolve, reject) {
        if (typeof setTimeout !== 'function') {
          console.warn('[MemoryRegistry] 无 setTimeout 可用，跳过索引重试（本次以空记忆集继续）');
          _map = Object.create(null);
          resolve();
          return;
        }
        setTimeout(function () {
          var list;
          try {
            list = _store.list();
          } catch (e) {
            if (_isIndexSentinel(e)) {
              // 两次都失败：置失败标记 + 保留 _map 现状。重试窗口（1.5s）内用户完全
              // 可能已 memory_create 建了新条目（内存条目已进 _map、磁盘 .md 已写；
              // 索引读失败下索引行多半没写成功）——若无条件重建空表，该条会从本
              // 会话视图消失且索引缺失，重启后成不可见孤儿。只补不抹：_map 已有
              // 内容原样保留；确实为空时才以空表继续（保持"以空集继续"旧语义）。
              // 数据不丢：既有 .md 完好，重启面板/下次 refresh 再自愈；上层据
              // _indexReadFailed 显示如实文案
              console.warn('[MemoryRegistry] init 索引重试仍失败（通道故障），保留当前已载入条目: ' + e.message);
              _indexReadFailed = true;
              if (Object.keys(_map).length === 0) {
                _map = Object.create(null);
              }
              resolve();
              return;
            }
            reject(e);
            return;
          }
          _indexReadFailed = false;
          _map = Object.create(null);
          _loadList(list);
          resolve();
        }, INDEX_RETRY_DELAY_MS);
      });
    }

    /**
     * Load all memories from disk into _map, then build backlinks
     */
    function init() {
      _map = Object.create(null);
      // list() 哨兵承接——init 是同步函数，_store.list() 抛出的
      // MEMORY_INDEX_READ_FAILED 哨兵（姊妹位：MEMORY.md 存在但
      // readFileSync 通道故障）在返回 Promise 之前同步逃逸，bootstrap 的
      // .catch 挂不上、异常穿到 main.js 外层 catch，_map 停留空状态——
      // 本会话记忆假性清空（设计目标在其声称的承接点落空）。
      // 承接后不直接以空集定论——1.5s 后重试一次（瞬时通道故障自愈）；
      // 仍失败才以空 map 继续并置 _indexReadFailed（数据不丢）；
      // 非哨兵异常按现状上抛
      var list;
      try {
        list = _store.list();
      } catch (e) {
        if (_isIndexSentinel(e)) {
          console.warn('[MemoryRegistry] init 索引读取失败（通道故障），' + (INDEX_RETRY_DELAY_MS / 1000) + 's 后重试: ' + e.message);
          _indexReadFailed = true;
          return _retryInit();
        }
        throw e;
      }
      _indexReadFailed = false;
      _loadList(list);
      return Promise.resolve();
    }

    /**
     * 本次 init/refresh 的索引读取是否最终失败（供上层文案区分
     * "真的没有记忆"与"索引读不出来"）
     */
    function isIndexReadFailed() {
      return _indexReadFailed;
    }

    function get(name) {
      return _map[name] || null;
    }

    function getAll() {
      var result = [];
      var keys = Object.keys(_map);
      for (var i = 0; i < keys.length; i++) {
        result.push(_map[keys[i]]);
      }
      return result;
    }

    /**
     * Filter by type
     */
    function getByType(type) {
      if (!type) return getAll();
      var result = [];
      var keys = Object.keys(_map);
      for (var i = 0; i < keys.length; i++) {
        if (_map[keys[i]].type === type) {
          result.push(_map[keys[i]]);
        }
      }
      return result;
    }

    /**
     * Keyword search: split query by spaces, case-insensitive OR substring match.
     * Results sorted by match count descending.
     * Optional scopeFilter narrows results to entries matching the given scope.
     */
    function search(query, scopeFilter) {
      if (!query || typeof query !== 'string') return _filterByScope(getAll(), scopeFilter);
      var trimmed = query.trim();
      if (!trimmed) return _filterByScope(getAll(), scopeFilter);
      var words = [];
      var rawWords = trimmed.toLowerCase().split(/\s+/);
      for (var w = 0; w < rawWords.length; w++) {
        if (rawWords[w].length > 0) {
          words.push(rawWords[w]);
        }
      }
      if (words.length === 0) return _filterByScope(getAll(), scopeFilter);

      // OR match + sort by match count descending
      var scored = [];
      var keys = Object.keys(_map);
      for (var i = 0; i < keys.length; i++) {
        var entry = _map[keys[i]];
        var haystack = (entry.name + ' ' + entry.description + ' ' + (entry.content || '')).toLowerCase();
        var matchCount = 0;
        for (var w = 0; w < words.length; w++) {
          if (haystack.indexOf(words[w]) !== -1) {
            matchCount++;
          }
        }
        if (matchCount > 0) {
          scored.push({ entry: entry, score: matchCount });
        }
      }
      scored.sort(function (a, b) { return b.score - a.score; });
      var result = [];
      for (var si = 0; si < scored.length; si++) {
        result.push(scored[si].entry);
      }
      return _filterByScope(result, scopeFilter);
    }

    /**
     * Filter entries by scope. If no scopeFilter, returns entries unchanged.
     * An entry matches if its scope equals scopeFilter or is 'both'.
     */
    function _filterByScope(entries, scopeFilter) {
      if (!scopeFilter) return entries;
      var filtered = [];
      for (var i = 0; i < entries.length; i++) {
        var s = entries[i].scope || 'both';
        if (s === scopeFilter || s === 'both') {
          filtered.push(entries[i]);
        }
      }
      return filtered;
    }

    /**
     * Build/re-build all backlinks.
     * For each entry A with links to B, add A to B.backlinks.
     */
    function resolveBacklinks() {
      var keys = Object.keys(_map);
      for (var i = 0; i < keys.length; i++) {
        _map[keys[i]].backlinks = [];
      }

      for (var i = 0; i < keys.length; i++) {
        var entry = _map[keys[i]];
        if (!entry.links || !entry.links.length) continue;
        for (var j = 0; j < entry.links.length; j++) {
          var target = entry.links[j];
          if (_map[target]) {
            if (_map[target].backlinks.indexOf(entry.name) === -1) {
              _map[target].backlinks.push(entry.name);
            }
          }
        }
      }
      console.log('[MemoryRegistry] resolveBacklinks done');
    }

    /**
     * Incremental backlink maintenance after a write operation.
     * oldLinks: the entry's links BEFORE the change (empty array for new entries)
     * newEntry: the entry AFTER the change
     */
    function _maintainBacklinks(oldLinks, newEntry) {
      if (!newEntry) return;
      var newLinks = newEntry.links || [];
      oldLinks = oldLinks || [];

      // Find newly added links
      for (var i = 0; i < newLinks.length; i++) {
        if (oldLinks.indexOf(newLinks[i]) === -1) {
          if (_map[newLinks[i]] && _map[newLinks[i]].backlinks.indexOf(newEntry.name) === -1) {
            _map[newLinks[i]].backlinks.push(newEntry.name);
          }
        }
      }

      // Find removed links
      for (var j = 0; j < oldLinks.length; j++) {
        if (newLinks.indexOf(oldLinks[j]) === -1) {
          if (_map[oldLinks[j]]) {
            var idx = _map[oldLinks[j]].backlinks.indexOf(newEntry.name);
            if (idx !== -1) {
              _map[oldLinks[j]].backlinks.splice(idx, 1);
            }
          }
        }
      }
    }

    /**
     * Scan all existing entries for forward links pointing to `targetName`,
     * and add their names to target's backlinks.
     */
    function _scanForwardLinksFor(targetName) {
      var keys = Object.keys(_map);
      for (var i = 0; i < keys.length; i++) {
        var other = _map[keys[i]];
        if (other.name === targetName) continue; // skip self
        if (other.links && other.links.indexOf(targetName) !== -1) {
          var target = _map[targetName];
          if (target && target.backlinks.indexOf(other.name) === -1) {
            target.backlinks.push(other.name);
          }
        }
      }
    }

    /**
     * Add a new memory entry.
     * Validates name format (kebab-case), checks for duplicates,
     * writes to Map then persists via Store.
     * Scans existing entries for forward [[links]] to build complete backlinks.
     */
    function add(entry) {
      if (!entry || !entry.name) return { ok: false, error: 'MISSING_NAME' };

      // Validate name format: kebab-case
      if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(entry.name)) {
        return { ok: false, error: 'INVALID_NAME: 仅支持小写字母、数字、连字符，以字母开头 (kebab-case)，不能以连字符结尾' };
      }

      if (_map[entry.name]) {
        var existing = _map[entry.name];
        return { ok: false, error: 'DUPLICATE: 记忆 [' + entry.name + '] 已存在 — ' + (existing.description || '') };
      }

      // 查重不能只查内存 _map——未入索引的同名 .md（索引丢失/手工放置）在
      // _map 必然未命中，store.write 会静默覆盖磁盘内容。内存未命中时调 store.exists
      // 复核磁盘，已存在则拒绝（含处置提示），杜绝静默覆盖；store 未注入 exists（极端
      // mock 环境）时跳过复核。
      if (typeof _store.exists === 'function' && _store.exists(entry.name)) {
        return { ok: false, error: 'DUPLICATE: 磁盘已存在未入索引的同名记忆文件 [' + entry.name + '.md]，已拒绝覆盖 — 请更换名称，或先删除/归档该文件后重试' };
      }

      if (!entry.description) return { ok: false, error: 'MISSING_DESCRIPTION' };
      if (!entry.type || VALID_TYPES.indexOf(entry.type) === -1) entry.type = 'project';
      // scope 不拒绝、只归一：LLM 经 memory_create 可写入任意值，非法值回退 'both'
      if (!entry.scope || VALID_SCOPES.indexOf(entry.scope) === -1) entry.scope = 'both';
      if (!entry.content) entry.content = '';
      if (!entry.links) entry.links = [];
      if (!entry.backlinks) entry.backlinks = [];
      if (!entry.filePath) entry.filePath = 'memories/' + entry.name + '.md';
      // 新建条目：创建时间=修改时间=本次写入时刻（无历史可保留，调用方传什么都被
      // 本次时刻覆盖——时间是派生事实，不作为入参）
      entry.created = _nowIso();
      entry.updated = entry.created;

      // Persist to disk first — if this fails, don't update memory
      var writeResult = _store.write(entry);
      if (!writeResult.ok) {
        return { ok: false, error: 'WRITE_FAILED: ' + (writeResult.error || 'unknown') };
      }

      _map[entry.name] = entry;
      _maintainBacklinks([], entry);
      // Scan existing entries for forward links to this new entry
      _scanForwardLinksFor(entry.name);
      console.log('[MemoryRegistry] ' + 'add: ' + entry.name);
      // 透传 store.write 的 INDEX_UPDATE_FAILED 降级告警（对齐 remove 写法）
      // 写法）——只判 ok 会把「文件已写、索引未收录」吞成纯成功，LLM 收到"已创建"
      // 但条目重启后从 list() 不可见（幽灵 .md）
      if (writeResult.warning) {
        return { ok: true, warning: writeResult.warning };
      }
      return { ok: true };
    }

    /**
     * 索引读失败态下的"查无此条"错误不可回 NOT_FOUND——条目可能就在磁盘上
     * 没载入，误导文案会诱导调用方改用 add（又被"磁盘已存在未入索引"拒绝）。
     * 与 isIndexReadFailed() 同判据，文案与 bootstrap/面板空态同口径同风格。
     */
    function _indexReadFailedError(name, verb) {
      return 'INDEX_READ_FAILED: 记忆索引读取失败（可重启面板重试），无法' + verb + ' ['
        + name + ']（未执行任何写盘）。磁盘上的记忆文件未受影响，本次未能载入。';
    }

    /**
     * Update an existing memory entry (partial update).
     * Only modifies the fields provided. If content changes,
     * re-parses to extract updated [[links]].
     */
    function update(name, partial) {
      if (!name || !_map[name]) {
        if (_indexReadFailed) return { ok: false, error: _indexReadFailedError(name, '更新') };
        return { ok: false, error: 'NOT_FOUND: 记忆 [' + name + '] 不存在' };
      }

      if (!partial || typeof partial !== 'object') {
        return { ok: false, error: 'MISSING_PARAMS: 至少需要提供一个要更新的字段' };
      }

      // 先整体校验再变更：任一字段非法直接返回，避免"前几个字段先改、后某个字段校验失败"留下半套变更
      if (partial.type !== undefined && partial.type !== null
        && VALID_TYPES.indexOf(String(partial.type)) === -1) {
        return { ok: false, error: 'INVALID_TYPE: ' + partial.type + ' (有效值: ' + VALID_TYPES.join(', ') + ')' };
      }
      if (partial.scope !== undefined && partial.scope !== null
        && VALID_SCOPES.indexOf(String(partial.scope)) === -1) {
        return { ok: false, error: 'INVALID_SCOPE: ' + partial.scope + ' (有效值: script, agent, shader, both)' };
      }

      var hasUpdate = false;
      var entry = _map[name];
      var oldLinks = (entry.links || []).slice();
      // 字段快照：写盘失败时回滚内存，保持与磁盘一致（对齐 add() 的"先落盘成功再提交"语义）
      var oldDescription = entry.description;
      var oldType = entry.type;
      var oldContent = entry.content;
      var oldScope = entry.scope;
      var oldFmRaw = entry._fmRaw;
      var oldUpdated = entry.updated;

      if (partial.description !== undefined && partial.description !== null) {
        entry.description = String(partial.description);
        hasUpdate = true;
      }
      if (partial.type !== undefined && partial.type !== null) {
        entry.type = String(partial.type);
        hasUpdate = true;
      }
      if (partial.content !== undefined && partial.content !== null) {
        entry.content = String(partial.content);
        // Re-extract [[links]] from new content
        var linkRegex = /\[\[([^\]]+)\]\]/g;
        entry.links = [];
        var match;
        while ((match = linkRegex.exec(entry.content)) !== null) {
          var linkTarget = match[1].trim();
          // Handle Wiki-style pipe: [[target|display]]
          var pipeIdx = linkTarget.indexOf('|');
          if (pipeIdx !== -1) {
            linkTarget = linkTarget.substring(0, pipeIdx).trim();
          }
          if (linkTarget && entry.links.indexOf(linkTarget) === -1) {
            entry.links.push(linkTarget);
          }
        }
        hasUpdate = true;
      }
      if (partial.scope !== undefined && partial.scope !== null) {
        entry.scope = String(partial.scope);
        hasUpdate = true;
      }

      if (!hasUpdate) {
        return { ok: false, error: 'NO_CHANGE: 未提供任何要更新的字段' };
      }

      // Invalidate _fmRaw so generateMarkdown regenerates from fields
      entry._fmRaw = '';

      // 修改时间=最近一次落盘写入时刻（重复保存同一内容也会推进，与文件 mtime 同
      // 语义）；created 不在此补写——标时间戳前创建的旧文件没有创建时刻可考，
      // 就地假造一个"创建于今天"比留空更误导（空值在展示层呈现为「未记录」）
      entry.updated = _nowIso();

      // Persist to disk
      var writeResult = _store.write(entry);
      if (!writeResult.ok) {
        // 写盘失败回滚全部字段：否则 UI/LLM 显示新值、磁盘是旧值，重启后"回退"
        entry.description = oldDescription;
        entry.type = oldType;
        entry.content = oldContent;
        entry.scope = oldScope;
        entry.links = oldLinks;
        entry._fmRaw = oldFmRaw;
        entry.updated = oldUpdated;
        return { ok: false, error: 'WRITE_FAILED: ' + (writeResult.error || 'unknown') };
      }

      _maintainBacklinks(oldLinks, entry);
      console.log('[MemoryRegistry] ' + 'update: ' + name);
      // 同 add——update 路径同样透传索引更新失败告警，三写路径行为一致
      if (writeResult.warning) {
        return { ok: true, warning: writeResult.warning };
      }
      return { ok: true };
    }

    /**
     * Remove a memory entry from disk and Map.
     * Cleans up backlinks AND forward links in other entries.
     */
    function remove(name) {
      if (!name || !_map[name]) {
        // 与 update 同判据——索引读失败态下不得回"不存在"（条目可能仍在磁盘）
        if (_indexReadFailed) return { ok: false, error: _indexReadFailedError(name, '删除') };
        return { ok: false, error: 'NOT_FOUND: 记忆 [' + name + '] 不存在' };
      }

      // 1. Remove from disk first
      var removeResult = _store.remove(name);
      if (!removeResult.ok) {
        return { ok: false, error: 'REMOVE_FAILED: ' + (removeResult.error || 'unknown') };
      }
      // 透传索引清理降级告警（文件已删、索引行残留），供 LLM 工具/面板提示用户
      var removeWarning = removeResult.warning || '';

      // 2. Remove this entry from all other entries' backlinks（backlinks 由 _map 派生，条目已删即悬空）。
      //    注意：他人 content 中的 [[name]] 前向链接不在此剪除——links 从 content 派生，
      //    只改内存不落盘会在 refresh 后"复活"造成前后不一致；悬空目标在 resolveBacklinks/
      //    _maintainBacklinks 中均被 _map 存在性检查安全忽略。
      var keys = Object.keys(_map);
      for (var i = 0; i < keys.length; i++) {
        var other = _map[keys[i]];
        if (other.backlinks) {
          var idx = other.backlinks.indexOf(name);
          if (idx !== -1) {
            other.backlinks.splice(idx, 1);
          }
        }
      }

      // 3. Remove from memory
      delete _map[name];
      console.log('[MemoryRegistry] ' + 'remove: ' + name);
      if (removeWarning) {
        return { ok: true, warning: removeWarning };
      }
      return { ok: true };
    }

    /**
     * Reload all entries from disk (for manual sync)
     */
    function refresh() {
      return init();
    }

    /**
     * Clear the in-memory Map (for destroy/unmount)
     */
    function clear() {
      _map = Object.create(null);
    }

    function hasRule(scope) {
      return typeof _store.readRule === 'function' ? !!_store.readRule(scope) : false;
    }

    function getRule(scope) {
      return typeof _store.readRule === 'function' ? _store.readRule(scope) : null;
    }

    function setRule(scope, content) {
      return typeof _store.writeRule === 'function' ? _store.writeRule(scope, content) : false;
    }

    return {
      init: init,
      isIndexReadFailed: isIndexReadFailed,
      get: get,
      getAll: getAll,
      getByType: getByType,
      search: search,
      add: add,
      update: update,
      remove: remove,
      refresh: refresh,
      clear: clear,
      resolveBacklinks: resolveBacklinks,
      hasRule: hasRule,
      getRule: getRule,
      setRule: setRule
    };
  }

  global.AEMemory = global.AEMemory || {};
  global.AEMemory.createMemoryRegistry = createMemoryRegistry;
})(window);
