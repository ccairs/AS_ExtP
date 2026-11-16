(function (global) {

  var TOOL_NAMES = [
    'memory_list', 'memory_read', 'memory_search',
    'memory_create', 'memory_update', 'memory_delete',
    'get_rule', 'set_rule'
  ];

  // 用户规则注入上限（字符）：规则常驻每轮 system prompt，无上限会随规则增长
  // 无限挤占上下文预算。超长截断并提示完整内容可经 get_rule 获取（存储保留全文）
  var RULE_PROMPT_MAX_CHARS = 8000;

  var _registry = null;

  /**
   * 索引读失败态判据（复用 registry.isIndexReadFailed 单一来源）。
   * 失败态下本体条目集不可信：update/delete 入口据此拒绝并回如实文案，不尝试写盘。
   */
  function _isIndexReadFailed() {
    return !!(_registry && typeof _registry.isIndexReadFailed === 'function' && _registry.isIndexReadFailed());
  }

  function _indexReadFailedToolResult(name, verb) {
    return {
      success: false,
      isError: true,
      content: [{
        type: 'text',
        text: '记忆索引读取失败（可重启面板重试），无法' + verb + ' [' + name + ']（未执行任何写盘）。磁盘上的记忆文件未受影响，本次未能载入。'
      }]
    };
  }

  /**
   * Extract [[link]] references from content text.
   */
  function _extractLinks(content) {
    var linkRegex = /\[\[([^\]]+)\]\]/g;
    var links = [];
    var match;
    while ((match = linkRegex.exec(content || '')) !== null) {
      var linkTarget = match[1].trim();
      var pipeIdx = linkTarget.indexOf('|');
      if (pipeIdx !== -1) {
        linkTarget = linkTarget.substring(0, pipeIdx).trim();
      }
      if (linkTarget && links.indexOf(linkTarget) === -1) {
        links.push(linkTarget);
      }
    }
    return links;
  }

  // 时间戳（存储口径为 UTC ISO，即 toISOString 输出）→ 本地时间
  // （YYYY-MM-DD HH:mm，对齐 agent 侧 fmtTime 风格）。未记录/手改成不可解析的值
  // 回空串，调用方按「未记录」呈现
  function _formatStamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // 列表摘要只带日期（条目多时逐行缀完整时刻会明显撑大输出）
  function _stampDate(iso) {
    var full = _formatStamp(iso);
    return full ? full.slice(0, 10) : '';
  }

  function _formatEntrySummary(entry) {
    var updatedDate = _stampDate(entry.updated);
    return '- [' + (entry.name || '?') + '] (' + (entry.type || '?') + ') ' + (entry.description || '')
      + (updatedDate ? ' · 更新 ' + updatedDate : '');
  }

  function _formatEntryFull(entry) {
    var lines = [];
    lines.push('--- 记忆：' + (entry.name || '?') + ' ---');
    lines.push('类型：' + (entry.type || '?'));
    lines.push('创建：' + (_formatStamp(entry.created) || '未记录'));
    lines.push('更新：' + (_formatStamp(entry.updated) || '未记录'));
    lines.push('描述：' + (entry.description || ''));
    lines.push('');
    lines.push(entry.content || '(无正文)');
    lines.push('');
    var linkList = (entry.links && entry.links.length > 0) ? entry.links.join(', ') : '无';
    var backlinkList = (entry.backlinks && entry.backlinks.length > 0) ? entry.backlinks.join(', ') : '无';
    lines.push('🔗 引用了：' + linkList);
    lines.push('🔗 被引用：' + backlinkList);
    return lines.join('\n');
  }

  function _getMemoriesDir() {
    var d = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
      ? global.AEShared.getDataDir().dir
      : '';
    if (!d) {
      console.error('[MemoryBootstrap] getDataDir 为空，无法加载 memories');
      return '';
    }
    var dir = d + '\\memories';
    console.log('[MemoryBootstrap] memoriesDir: ' + dir);
    return dir;
  }

  /**
   * Initialize memory tools at app bootstrap time.
   * Registers 8 LLM tools into toolRegistry so they're always available.
   * Also initializes the memory store + registry for data access.
   */
  function initMemoryTools(config) {
    var toolRegistry = config.toolRegistry;
    var promptBuilder = config.promptBuilder || (global.AE_LLM && global.AE_LLM.promptBuilder);
    if (!toolRegistry) {
      console.warn('[MemoryBootstrap] MISSING_TOOL_REGISTRY');
      return { ok: false, error: 'MISSING_TOOL_REGISTRY' };
    }

    // 传目录函数而非启动快照——数据目录可免重启热切换（main.js 迁移 + 切指针），
    // store 每次路径拼接现算，记忆不会再写回旧目录
    var store = global.AEMemory.createMemoryStore(_getMemoriesDir);
    _registry = global.AEMemory.createMemoryRegistry(store);

    // --- memory_list ---
    toolRegistry.register({
      name: 'memory_list',
      description: '列出全部记忆，可按 type 过滤（lesson/project/preference）。',
      shortDescription: '列出全部记忆（可按 type/scope 过滤）',
      input_schema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: '可选过滤：lesson, project, preference',
            enum: ['lesson', 'project', 'preference']
          },
          scope: { type: 'string', description: '可选过滤：script, agent, shader, both', enum: ['script', 'agent', 'shader', 'both'] }
        }
      },
      handler: function (args) {
        try {
          var type = (args && args.type) ? args.type : null;
          var scope = (args && args.scope) ? args.scope : null;
          var list = type ? _registry.getByType(type) : _registry.getAll();
          if (scope && list) {
            list = list.filter(function (entry) {
              var s = entry.scope || 'both';
              return s === scope || s === 'both';
            });
          }
          if (!list || list.length === 0) {
            // 索引读失败（重试后仍失败）时不得回"暂无记忆"——那会诱导 LLM/用户
            // 在数据仍在磁盘上的情况下重建记忆；如实说明失败态与恢复方式
            if (_registry && typeof _registry.isIndexReadFailed === 'function' && _registry.isIndexReadFailed()) {
              return { success: false, isError: true, content: [{ type: 'text', text: '记忆索引读取失败（可重启面板重试）。磁盘上的记忆文件未受影响，本次未能载入。' }] };
            }
            return { success: true, isError: false, content: [{ type: 'text', text: '暂无记忆。使用 memory_create 创建第一条吧。' }] };
          }
          var lines = ['找到 ' + list.length + ' 条记忆：'];
          for (var i = 0; i < list.length; i++) {
            lines.push(_formatEntrySummary(list[i]));
          }
          return { success: true, isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (e) {
          console.warn('[MemoryBootstrap] ' + 'memory_list error: ' + e);
          return { success: false, isError: true, content: [{ type: 'text', text: 'memory_list 执行错误: ' + e }] };
        }
      },
      scope: { type: 'global' },
      stub: true,
      source: 'memory',
      category: 'memory'
    });

    // --- memory_read ---
    toolRegistry.register({
      name: 'memory_read',
      description: '读取一条记忆的完整内容（含正文和关联链接）。',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '记忆的 slug 标识（kebab-case）' }
        },
        required: ['name']
      },
      handler: function (args) {
        try {
          var name = (args && args.name && String(args.name).trim()) ? String(args.name).trim() : '';
          if (!name) {
            return { success: false, isError: true, content: [{ type: 'text', text: '缺少参数 name' }] };
          }
          var entry = _registry.get(name);
          if (!entry) {
            // 索引读失败态下不得回"不存在"——条目可能就在磁盘上
            // 只是没载入，误导性文案会让 LLM/用户以为该名字可用（乃至重建）。复用
            // registry.isIndexReadFailed() 同一失败判据（与 memory_list/面板空态一致）
            if (_registry && typeof _registry.isIndexReadFailed === 'function' && _registry.isIndexReadFailed()) {
              return { success: false, isError: true, content: [{ type: 'text', text: '记忆索引读取失败（可重启面板重试），无法确认 [' + name + '] 是否存在。磁盘上的记忆文件未受影响，本次未能载入。' }] };
            }
            return { success: false, isError: true, content: [{ type: 'text', text: '记忆 [' + name + '] 不存在。用 memory_list 查看可用记忆。' }] };
          }
          return { success: true, isError: false, content: [{ type: 'text', text: _formatEntryFull(entry) }] };
        } catch (e) {
          console.warn('[MemoryBootstrap] ' + 'memory_read error: ' + e);
          return { success: false, isError: true, content: [{ type: 'text', text: 'memory_read 执行错误: ' + e }] };
        }
      },
      scope: { type: 'global' },
      stub: false,
      source: 'memory',
      category: 'memory'
    });

    // --- memory_search ---
    toolRegistry.register({
      name: 'memory_search',
      description: '按关键词搜索记忆，匹配名称、描述和正文。空格分隔多词，匹配越多排名越前（至少一词匹配）。',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（空格分隔多词）' },
          scope: { type: 'string', description: '可选过滤：script, agent, shader, both', enum: ['script', 'agent', 'shader', 'both'] }
        },
        required: ['query']
      },
      handler: function (args) {
        try {
          var query = (args && args.query && String(args.query).trim()) ? String(args.query).trim() : '';
          if (!query) {
            return { success: false, isError: true, content: [{ type: 'text', text: '缺少搜索关键词' }] };
          }
          var results = _registry.search(query, (args && args.scope) ? args.scope : null);
          if (!results || results.length === 0) {
            // 索引读失败态下"未找到"同样是误导——本次搜索根本
            // 没跑在完整数据上；复用 isIndexReadFailed() 判据（与 memory_list 一致）
            if (_registry && typeof _registry.isIndexReadFailed === 'function' && _registry.isIndexReadFailed()) {
              return { success: false, isError: true, content: [{ type: 'text', text: '记忆索引读取失败（可重启面板重试），本次未能搜索。磁盘上的记忆文件未受影响，本次未能载入。' }] };
            }
            return { success: true, isError: false, content: [{ type: 'text', text: '搜索 "' + query + '" 未找到匹配的记忆。' }] };
          }
          var lines = ['搜索 "' + query + '" 找到 ' + results.length + ' 条记忆：'];
          for (var i = 0; i < results.length; i++) {
            lines.push(_formatEntrySummary(results[i]));
          }
          return { success: true, isError: false, content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (e) {
          console.warn('[MemoryBootstrap] ' + 'memory_search error: ' + e);
          return { success: false, isError: true, content: [{ type: 'text', text: 'memory_search 执行错误: ' + e }] };
        }
      },
      scope: { type: 'global' },
      stub: false,
      source: 'memory',
      category: 'memory'
    });

    // --- memory_create ---
    toolRegistry.register({
      name: 'memory_create',
      shortDescription: '创建一条新记忆（三类：踩坑经验/项目约定/用户偏好）',
      description: '创建一条新记忆。name 为 kebab-case slug。type 按内容选：lesson=踩坑经验/API实测行为, project=项目约定进展, preference=用户身份偏好与纠正。content 支持 Markdown。',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'kebab-case slug，唯一标识（如 my-coding-pref）' },
          description: { type: 'string', description: '一句话描述，LLM 用此判断是否相关' },
          type: { type: 'string', description: '记忆类型：lesson=踩坑经验/API实测行为, project=项目约定进展, preference=用户身份偏好与纠正', enum: ['lesson', 'project', 'preference'] },
          content: { type: 'string', description: 'markdown 正文。建议包含 **Why:** 和 **How to apply:** 段落。' },
          scope: { type: 'string', description: '可见范围：script(脚本模式) / agent(Agent模式) / shader(Shader模式) / both(通用)，默认 both', enum: ['script', 'agent', 'shader', 'both'] }
        },
        required: ['name', 'description', 'type', 'content']
      },
      handler: function (args) {
        try {
          if (!args) return { success: false, isError: true, content: [{ type: 'text', text: '缺少参数' }] };

          var links = _extractLinks(args.content);

          // 归一化为 kebab-case（registry.add 要求 /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/，
          // 只 toLowerCase/trim 的话含空格/下划线的名字会 INVALID_NAME 失败）
          var slug = String(args.name || '').toLowerCase().trim()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
          var newEntry = {
            name: slug,
            description: args.description || '',
            type: args.type || 'project',
            scope: args.scope || 'both',
            content: args.content || '',
            links: links,
            backlinks: [],
            // 对象字面量求值期 newEntry 尚不可用（var 提升为 undefined），须引用局部变量 slug
            filePath: 'memories/' + slug + '.md'
          };

          var result = _registry.add(newEntry);
          if (!result.ok) {
            return { success: false, isError: true, content: [{ type: 'text', text: result.error }] };
          }
          return { success: true, isError: false, content: [{ type: 'text', text: '✅ 记忆 [' + newEntry.name + '] 已创建。scope: ' + newEntry.scope }] };
        } catch (e) {
          console.warn('[MemoryBootstrap] ' + 'memory_create error: ' + e);
          return { success: false, isError: true, content: [{ type: 'text', text: 'memory_create 执行错误: ' + e }] };
        }
      },
      scope: { type: 'global' },
      stub: true,
      source: 'memory',
      category: 'memory'
    });

    // --- memory_update ---
    toolRegistry.register({
      name: 'memory_update',
      shortDescription: '修改已有记忆的字段（未传字段不变）',
      description: '修改已有记忆的部分字段。只传要改的字段即可，未传字段保持不变。修改 content 时会自动重新解析 [[links]]。',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '要修改的记忆 slug' },
          description: { type: 'string', description: '新描述（可选）' },
          type: { type: 'string', description: '新类型（可选）', enum: ['lesson', 'project', 'preference'] },
          content: { type: 'string', description: '新正文（可选）' },
          scope: { type: 'string', description: '新可见范围（可选）', enum: ['script', 'agent', 'shader', 'both'] }
        },
        required: ['name']
      },
      handler: function (args) {
        try {
          if (!args || !args.name) return { success: false, isError: true, content: [{ type: 'text', text: '缺少参数 name' }] };
          // 对齐 memory_read 的判空：trim 后再查，避免 LLM 参数带首尾空格时误报 NOT_FOUND
          var name = String(args.name).trim();
          if (!name) return { success: false, isError: true, content: [{ type: 'text', text: '缺少参数 name' }] };
          // 索引读失败态入口闸门——_map 未载入时 registry.update 会误报
          // NOT_FOUND（记忆 [x] 不存在），诱导 LLM 转而 memory_create 又被磁盘查重
          // 拒绝、整会话无法编辑。失败态如实说明且不尝试写盘（对齐 memory_read/list）
          if (_isIndexReadFailed()) return _indexReadFailedToolResult(name, '更新');
          var result = _registry.update(name, {
            description: args.description,
            type: args.type,
            content: args.content,
            scope: args.scope
          });
          if (!result.ok) {
            return { success: false, isError: true, content: [{ type: 'text', text: result.error }] };
          }
          return { success: true, isError: false, content: [{ type: 'text', text: '✅ 记忆 [' + name + '] 已更新。' }] };
        } catch (e) {
          console.warn('[MemoryBootstrap] ' + 'memory_update error: ' + e);
          return { success: false, isError: true, content: [{ type: 'text', text: 'memory_update 执行错误: ' + e }] };
        }
      },
      scope: { type: 'global' },
      stub: true,
      source: 'memory',
      category: 'memory'
    });

    // --- memory_delete ---
    toolRegistry.register({
      name: 'memory_delete',
      shortDescription: '删除一条记忆（不可逆，清理 backlinks）',
      description: '删除一条记忆（不可逆）。同时移除磁盘文件和索引，并清理其他记忆 backlinks 中对该条目的引用（他人正文中的 [[链接]] 文本保留，悬空目标会被安全忽略）。',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '要删除的记忆 slug' }
        },
        required: ['name']
      },
      handler: function (args) {
        try {
          if (!args || !args.name) return { success: false, isError: true, content: [{ type: 'text', text: '缺少参数 name' }] };
          // 对齐 memory_read 的判空：trim 后再查，避免 LLM 参数带首尾空格时误报 NOT_FOUND
          var name = String(args.name).trim();
          if (!name) return { success: false, isError: true, content: [{ type: 'text', text: '缺少参数 name' }] };
          // 与 memory_update 同款入口闸门——失败态不回"不存在"、不尝试删盘
          if (_isIndexReadFailed()) return _indexReadFailedToolResult(name, '删除');
          var result = _registry.remove(name);
          if (!result.ok) {
            return { success: false, isError: true, content: [{ type: 'text', text: result.error }] };
          }
          // 索引清理降级告警透传给 LLM（文件已删、重启后 list 可能残留幽灵条目，
          // 可提示用户手工处理），正常路径文案不变
          var deleteText = '✅ 记忆 [' + name + '] 已删除。';
          if (result.warning) {
            deleteText = '⚠️ ' + result.warning;
          }
          return { success: true, isError: false, content: [{ type: 'text', text: deleteText }] };
        } catch (e) {
          console.warn('[MemoryBootstrap] ' + 'memory_delete error: ' + e);
          return { success: false, isError: true, content: [{ type: 'text', text: 'memory_delete 执行错误: ' + e }] };
        }
      },
      scope: { type: 'global' },
      stub: true,
      source: 'memory',
      category: 'memory'
    });

    // Rule tools
    toolRegistry.register({
      name: 'get_rule',
      description: '读取用户规则。规则会在每次对话中自动注入给 LLM。scope 可选：script（脚本模式）/ agent（Agent 模式）/ shader（Shader 模式），不填默认 script。',
      shortDescription: '读取用户规则（规则已自动注入，一般无需调用）',
      input_schema: {
        type: 'object',
        properties: { scope: { type: 'string', description: 'script、agent 或 shader', enum: ['script', 'agent', 'shader'] } },
        required: []
      },
      handler: function (args) {
        try {
          var scope = (args && args.scope) ? args.scope : 'script';
          var rule = _registry.hasRule(scope) ? _registry.getRule(scope) : null;
          // 判空必须判**规则内容**而非规则对象：`if (!rule)`
          // 只在"规则不存在"时回占位文案；"规则存在但 content 为空串"会走 else 回空文本，
          // 于是两种截然不同的状态在 LLM 侧不可区分（实测 shader 档回 (暂无…) 占位、
          // script/agent 档回空串——同一工具语义分叉，且分叉原因对调用方不可见）。
          var ruleContent = (rule && typeof rule.content === 'string') ? rule.content.trim() : '';
          if (!ruleContent) return { success: true, isError: false, content: [{ type: 'text', text: '(暂无 ' + scope + ' 模式规则)' }] };
          return { success: true, isError: false, content: [{ type: 'text', text: rule.content }] };
        } catch (e) { return { success: false, isError: true, content: [{ type: 'text', text: 'get_rule error: ' + e }] }; }
      },
      scope: { type: 'global' },
      stub: true,
      source: 'memory',
      category: 'memory'
    });

    toolRegistry.register({
      name: 'set_rule',
      shortDescription: '设置/覆盖当前模式的用户规则',
      description: '设置/覆盖用户规则。每个 scope 只有一条规则，再次调用会覆盖。规则会在每次对话中自动注入给 LLM。',
      input_schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'script（脚本模式）、agent（Agent模式）或 shader（Shader模式）', enum: ['script', 'agent', 'shader'] },
          content: { type: 'string', description: '规则内容（Markdown 格式）。写清楚 LLM 在该模式下应遵守的行为规范。' }
        },
        required: ['scope', 'content']
      },
      handler: function (args) {
        try {
          // 对齐其余 handler 的判空：缺参数直接返回，避免 args.scope 解引用抛 TypeError
          // 且 content 缺失时先写空规则再报错的"半写入"不一致。
          // scope 缺失也要报参数名：走 setRule(undefined) 只会得到笼统的"写入规则失败"，LLM 无法自纠
          if (!args || !args.content || !args.scope) {
            return { success: false, isError: true, content: [{ type: 'text', text: '缺少参数：scope 和 content 均必填（scope: script/agent/shader）' }] };
          }
          var ok = _registry.setRule(args.scope, args.content);
          if (!ok) return { success: false, isError: true, content: [{ type: 'text', text: '写入规则失败' }] };
          var _ruleMsg = '✅ ' + args.scope + ' 模式规则已更新（' + args.content.length + ' 字符）';
          if (args.content.length > RULE_PROMPT_MAX_CHARS) {
            _ruleMsg += '。⚠️ 超过 ' + RULE_PROMPT_MAX_CHARS + ' 字符，注入 LLM 时将截断（完整内容可经 get_rule 读取）';
          }
          return { success: true, isError: false, content: [{ type: 'text', text: _ruleMsg }] };
        } catch (e) { return { success: false, isError: true, content: [{ type: 'text', text: 'set_rule error: ' + e }] }; }
      },
      scope: { type: 'global' },
      stub: true,
      source: 'memory',
      category: 'memory'
    });

    console.log('[MemoryBootstrap] ' + 'Registered ' + TOOL_NAMES.length + ' memory tools');

    // Register rule injection via promptBuilder
    if (promptBuilder) {
      promptBuilder.register(function (prompt, context) {
        // 子任务上下文（安全审查 / ComfyUI 画布等）经 ctx.noUserRules 显式声明
        // 不注入——用户规则是面向主对话循环的行为引导，灌入安全评审员会让用户
        // 偏好影响审查独立性；静默跳过
        if (context && context.noUserRules === true) return prompt;
        if (!context || typeof context.getSettings !== 'function') {
          // 剩余告警仅覆盖真正未知的调用方（如未来新增对话主循环忘传
          // getSettings——规则会静默丢失，需诊断）；已知子任务一律走显式标记
          console.warn('[MemoryBootstrap] Rule injector: context.getSettings not available, skipping');
          return prompt;
        }
        var settings = context.getSettings();
        // 规则按模式三态选档：agent / shader / script（其余一律归 script）
        var runtimeMode = settings && settings.runtimeMode;
        var scope = (runtimeMode === 'agent' || runtimeMode === 'shader') ? runtimeMode : 'script';
        if (!_registry.hasRule || !_registry.hasRule(scope)) return prompt;
        var rule = _registry.getRule(scope);
        if (!rule || !rule.content) return prompt;
        var ruleContent = rule.content;
        // 注入上限：超长规则截断到 RULE_PROMPT_MAX_CHARS（完整内容仍在存储中，
        // LLM 可经 get_rule 按需读取被截断部分）
        if (ruleContent.length > RULE_PROMPT_MAX_CHARS) {
          ruleContent = ruleContent.slice(0, RULE_PROMPT_MAX_CHARS)
            + '\n(规则超过 ' + RULE_PROMPT_MAX_CHARS + ' 字符已截断，完整内容可调用 get_rule 获取)';
        }
        return prompt + '\n\n## 用户规则\n' + ruleContent;
      }, 30);
      console.log('[MemoryBootstrap] Rule prompt injector registered');
    }

    // Initialize (load from disk)
    _registry.init().then(function () {
      console.log('[MemoryBootstrap] ' + 'Memory registry initialized with ' + _registry.getAll().length + ' entries');
    }).catch(function (e) {
      console.warn('[MemoryBootstrap] ' + 'Registry init error: ' + e);
    });

    return { ok: true, toolNames: TOOL_NAMES };
  }

  /**
   * Get the shared memory registry instance (for controller/view use)
   */
  function getMemoryRegistry() {
    return _registry;
  }

  global.AEMemory = global.AEMemory || {};
  global.AEMemory.initMemoryTools = initMemoryTools;
  global.AEMemory.getMemoryRegistry = getMemoryRegistry;
  global.AEMemory._extractLinks = _extractLinks;
})(window);
