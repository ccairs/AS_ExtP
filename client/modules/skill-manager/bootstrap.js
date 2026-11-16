(function (global) {

  // CEP 10 Chrome 88 确认无 Node.js（require/process/Buffer/cep_node 全 undefined）
  (function () {
    try {
      console.log('[Env] CEF=' + (navigator.userAgent.match(/Chrome\/(\d+)/) || ['','?'])[1]
        + ' | cep_node=' + (typeof window.__adobe_cep__ !== 'undefined' ? 'bridge-only' : 'none')
        + ' | require=' + (typeof require !== 'undefined' ? 'ok' : 'none'));
    } catch (_) {}
  })();

  // 统一数据目录：AppData\skills\（用户安装的 skill 落在此处；
  // seed 无内置 skill，首装前该目录可能不存在）
  function _getSkillsDir() {
    var d = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
      ? global.AEShared.getDataDir().dir
      : '';
    if (!d) {
      console.error('[SkillBootstrap] getDataDir 为空，无法加载 skills');
      return '';
    }
    var dir = d + '\\skills';
    console.log('[SkillBootstrap] skillsDir: ' + dir);
    return dir;
  }

  function _readSkillMd(path) {
    return AEFS.readFileSync(path);
  }

  function _fetchSkillMd(name, dir) {
    var d = dir || _getSkillsDir();
    if (!d) return Promise.resolve('');
    return Promise.resolve(_readSkillMd(d + '\\' + name + '\\SKILL.md'));
  }

  function _parseSkillMd(text, name) {
    if (!text) return null;
    var parsed = global.AE_LLM && global.AE_LLM.parseSkillFrontmatter
      ? global.AE_LLM.parseSkillFrontmatter(text)
      : { frontmatter: {}, body: text };
    var fm = parsed.frontmatter || {};
    var metadata = fm.metadata || null;
    if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch (_) {} }
    // id 由文件夹名过一遍 kebab 归一化后再给注册表校验（`My Skill` → `my-skill`）：
    // id 直接取文件夹名原文、不做归一化时——大写/空格/下划线名字的目录被
    // 整体丢弃，只在控制台留一行 register failed。归一化结果为空（原名不含 ASCII 字母
    // 数字，如纯中文）时回落原文，注册照旧失败且原因不变。
    // skillPath 保持真实文件夹名：id ≠ 文件夹名时，落盘/删除按它定位（resolveSkillDirName）。
    var slug = (global.AE_LLM && typeof global.AE_LLM.kebabSlug === 'function')
      ? global.AE_LLM.kebabSlug(name) : '';
    var skillId = slug || name;
    if (skillId !== name) {
      console.log('[SkillBootstrap] id 归一化: "' + name + '" → "' + skillId + '"');
    }
    return {
      id: skillId, name: fm.name || name, description: fm.description || '',
      skillPath: name, prompt: parsed.body || '', body: parsed.body || '',
      license: fm.license || null, compatibility: fm.compatibility || null,
      metadata: metadata,
      allowedTools: Array.isArray(fm['allowed-tools']) ? fm['allowed-tools'].slice() : null,
      scope: (metadata && metadata.ae_llm && metadata.ae_llm.scope)
        ? metadata.ae_llm.scope : (fm.scope || { type: 'global' }),
      category: fm.category || 'general', version: fm.version || null, enabled: true
    };
  }

  async function _resolveSkillNames(dir) {
        dir = dir || _getSkillsDir();
        if (!dir) return [];
        // AEFS 异步版自带 Bridge → ExtendScript 全回退链，无需手写兜底
        var subDirs = await AEFS.listDirs(dir);
        var names = [];
        for (var i = 0; i < subDirs.length; i++) {
            var mdPath = dir + '\\' + subDirs[i] + '\\SKILL.md';
            var md = _readSkillMd(mdPath);
            // 读失败（null，通道故障折叠值）不静默跳过——existsSync 复核
            // SKILL.md 在场时仍计入名单（后续 _fetchSkillMd 重读，通道恢复即可用；
            // 持续失败由解析路径 warn 区分「读失败」与「真没有」）。启动加载期
            // Bridge 未就绪曾致部分/全部 skill 表现为「被删」
            if (md || (md === null && typeof AEFS.existsSync === 'function' && AEFS.existsSync(mdPath))) {
                names.push(subDirs[i]);
            }
        }
        // 归一化后两个目录可能抢同一 id（`My Skill` 与 `my-skill`）：名字本身已是规范形态的
        // 先注册（另一个按既有 DUPLICATE_ID 拒绝）。排序固定注册顺序——加载链的读是同步的
        // （AEFS.readFileSync 包 Promise.resolve），注册按本数组顺序发生，否则"谁生效"会随
        // readdir 顺序在重启间漂移
        var slugFn = (global.AE_LLM && typeof global.AE_LLM.kebabSlug === 'function')
          ? global.AE_LLM.kebabSlug
          : function (x) { return x; };
        names.sort(function (a, b) {
          var aExact = slugFn(a) === a;
          var bExact = slugFn(b) === b;
          if (aExact !== bExact) return aExact ? -1 : 1;
          return a < b ? -1 : (a > b ? 1 : 0);
        });
        console.log('[SkillBootstrap] scanned: ' + (names.length > 0 ? names.join(', ') : '(none)'));
        return names;
    }

  function initSkillTools(config) {
    var skillRegistry = config.skillRegistry;
    var toolRegistry = config.toolRegistry;
    var promptBuilder = config.promptBuilder || (global.AE_LLM && global.AE_LLM.promptBuilder);

    if (!skillRegistry) {
      console.warn('[SkillBootstrap] MISSING_SKILL_REGISTRY');
      return Promise.resolve({ ok: false, error: 'MISSING_SKILL_REGISTRY' });
    }

    // Register Skill tool
    var skillToolHandle = null;
    if (toolRegistry && global.AE_LLM && typeof global.AE_LLM.createSkillInjector === 'function') {
      // getSkillsDir：Skill 加载结果要给出技能目录的绝对 Base directory（附件按需读取），
      // 同时供 Skill 工具的 file 参数定位技能目录（见 skillInjector 的 _skillDir）
      var skillInjector = global.AE_LLM.createSkillInjector({
        registry: skillRegistry,
        getSkillsDir: _getSkillsDir
      });
      global.AE_LLM.skillInjector = skillInjector;
      skillToolHandle = skillInjector.registerSkillTool(toolRegistry);
    }

    // skillCreator：仅作 createSkill 核心工厂保留（被 skill_manager 工具的 create mode 复用）
    // 不再单独注册 createSkill 工具（已并入 skill_manager 粗粒度工具）
    var skillCreator = null;
    if (global.AE_LLM && typeof global.AE_LLM.createSkillCreator === 'function') {
      skillCreator = global.AE_LLM.createSkillCreator({
        skillRegistry: skillRegistry,
        getSkillsDir: _getSkillsDir,
        onChanged: function () {
          if (skillToolHandle && typeof skillToolHandle.updateDescription === 'function') {
            skillToolHandle.updateDescription();
          }
        }
      });
      global.AE_LLM.skillCreator = skillCreator;
    }

    // skillInstaller：bootstrap 阶段就创建（早于模块挂载），让 skill_manager 工具
    // 在 main.js 启动期即可注册，LLM 不必依赖用户打开 skill 面板才能调用
    var skillInstaller = null;
    if (global.AE_LLM && typeof global.AE_LLM.createSkillInstaller === 'function') {
      skillInstaller = global.AE_LLM.createSkillInstaller();
      global.AE_LLM.skillInstaller = skillInstaller;
    }

    // 注册 skill_manager 工具（CRUD + 启用/禁用 + 安装）
    // 依赖已齐：skillRegistry / skillCreator / skillInstaller / settingsStore 都在 bootstrap 早期就绪
    if (global.AESkillManager && typeof global.AESkillManager.initSkillManagerTools === 'function') {
      var smResult = global.AESkillManager.initSkillManagerTools({
        toolRegistry: toolRegistry,
        skillRegistry: skillRegistry,
        skillCreator: skillCreator,
        skillInstaller: skillInstaller,
        settingsStore: config.settingsStore,
        getSkillsDir: _getSkillsDir,
        onChanged: function () {
          if (skillToolHandle && typeof skillToolHandle.updateDescription === 'function') {
            skillToolHandle.updateDescription();
          }
        }
      });
      if (smResult && smResult.ok) {
        console.log('[SkillBootstrap] skill_manager LLM tool registered');
      } else {
        console.warn('[SkillBootstrap] skill_manager registration failed: ' + (smResult && smResult.error ? smResult.error : 'unknown'));
      }
    }


    // promptBuilder <available_skills> hook
    if (promptBuilder) {
      promptBuilder.register(function (prompt, ctx) {
        // 子任务上下文（安全审查等）经 ctx.noSkills 显式声明不注入（
        // 「审查员的提示词应该保持干净」）：技能清单是面向能调 Skill 工具的主对话/画布助手的
        // 能力索引，审查员不调工具，清单进上下文只是无关内容。
        if (ctx && ctx.noSkills === true) return prompt;
        var moduleId = (ctx && ctx.moduleId) ? ctx.moduleId : '';
        // 运行模式：面板内 controller 的 moduleId 恒为 'agent'，
        // 但 Script/Shader 轮的**执行侧** moduleId 分别是 'script'/'shader'。提示词侧必须
        // 按当前轮模式过滤，才能保证「<available_skills> 列出的技能 = 当前模式实际可调用的
        // 技能」——否则限某模式的技能会「可调用但摘要不列」或「摘要列了却调不动」。
        // 键名是专用 runMode（不是通用 mode）；只接受四种合法模式值，其它/缺席一律回落
        // moduleId（无 mode 的调用方：画布助手等行为不变；审查类子任务先被 noSkills 挡掉）。
        var runMode = (ctx && ctx.runMode) ? String(ctx.runMode) : '';
        if (runMode !== 'agent' && runMode !== 'script' && runMode !== 'shader' && runMode !== 'external-mcp') {
          runMode = '';
        }
        var filterId = runMode || moduleId;
        var skills = filterId ? skillRegistry.getEnabledForModule(filterId) : skillRegistry.getAll();
        if (!skills || !skills.length) return prompt;
        // name/description 来自不可信的 SKILL.md frontmatter（块标量
        // description 可携带多行内容），注入 system prompt 前必须单行化并剥离伪造的
        // XML 边界标记——否则可提前闭合 </available_skills> 越界注入任意正文，或
        // 换行伪造额外技能条目，安装成功即常驻每轮 system prompt（越过加载闸门）
        // 描述超长截断：description 无长度约束，超长描述常驻每轮 system prompt 会
        // 持续挤占上下文（name 不截断，保证 Skill 工具可按名调用）
        var SKILL_DESC_MAX_CHARS = 200;
        function _sanitizeForPrompt(s, maxLen) {
          var v = String(s == null ? '' : s);
          v = v.replace(/[\r\n]+/g, ' ');
          v = v.replace(/<\/?(available_skills|skill)>/gi, '');
          if (maxLen && v.length > maxLen) v = v.slice(0, maxLen - 1) + '…';
          return v;
        }
        // 名单长度上限：**无条件列出每个**启用且
        // 可访问的技能（`- name: description`），名单随技能数线性增长——实测 300 个技能时这一段
        // 约 **69KB**，而它**每轮**都进系统提示词（浪费的是 token/上下文，不是构建时间）。
        // 口径与 Skill 工具描述一致：只列前 N 个 + **明示总数** + 指向 `skill_manager mode=list`
        //（该分支无 scope 参数时列全部，且在外接白名单内）⇒ 长名单不再挤占上下文，能力也不丢。
        var SKILL_PROMPT_LIST_MAX = 40;
        var lines = ['', '<available_skills>'];
        var _listed = 0;
        var _totalSkills = 0;
        for (var i = 0; i < skills.length; i++) {
          if (skills[i].enabled === false) continue;
          // getAll 返回的数据不经过 getEnabledForModule 过滤，需手动检查 scope
          if (!filterId && !skillRegistry.isAccessibleByModule(skills[i], '')) continue;
          _totalSkills++;
          if (_listed >= SKILL_PROMPT_LIST_MAX) continue;   // 超出上限只计数、不再入提示词
          lines.push('- ' + _sanitizeForPrompt(skills[i].name) + ': ' + _sanitizeForPrompt(skills[i].description, SKILL_DESC_MAX_CHARS));
          _listed++;
        }
        if (lines.length <= 2) return prompt;
        if (_totalSkills > _listed) {
          lines.push('- …（共 ' + _totalSkills + ' 个技能，此处只列前 ' + _listed
            + ' 个；其余用 skill_manager mode=list 查询，或直接用 executeSkill 调用）');
        }
        lines.push('</available_skills>');
        return prompt + '\n' + lines.join('\n');
      }, 50);
    }

    // Load all skills from disk via AEFS
    // 统一数据目录 <dataDir>\skills 为运行时唯一源（skill 均为用户创建/安装，seed 不再内置）。
    var appDataDir = _getSkillsDir();
    return _resolveSkillNames(appDataDir).then(function (appDataNames) {
      var loadedIds = [];
      var promises = [];

      function loadFrom(dir, name) {
        return _fetchSkillMd(name, dir).then(function (text) {
          var def = _parseSkillMd(text, name);
          if (def) {
            var r = skillRegistry.register(def);
            if (r && r.ok) {
              loadedIds.push(name);
              console.log('[SkillBootstrap] registered: ' + name);
            } else {
              console.warn('[SkillBootstrap] register failed: ' + name + ' ' + JSON.stringify(r));
            }
          } else {
            console.warn('[SkillBootstrap] missing SKILL.md: ' + name);
          }
        });
      }

      for (var i = 0; i < appDataNames.length; i++) {
        promises.push(loadFrom(appDataDir, appDataNames[i]));
      }
      return Promise.all(promises).then(function () {
        console.log('[SkillBootstrap] done, ' + loadedIds.length + ' skills loaded');

        // 从持久化设置恢复启用/禁用状态
        var settingsStore = config.settingsStore;
        var restoreDone = Promise.resolve();
        if (settingsStore && typeof settingsStore.getModuleSettings === 'function') {
          restoreDone = settingsStore.getModuleSettings('skill-manager').then(function (moduleSettings) {
            var disabledSkills = (moduleSettings && moduleSettings._disabledSkills) || [];
            for (var di = 0; di < disabledSkills.length; di++) {
              skillRegistry.setSkillEnabled(disabledSkills[di], false);
            }
            if (disabledSkills.length > 0) {
              console.log('[SkillBootstrap] Restored ' + disabledSkills.length + ' disabled skills');
            }
          }).catch(function () {});
        }
        return restoreDone.then(function () {
          // Skill 工具注册先于磁盘加载（注册时 registry 为空），加载完成后
          // 同步一次静态描述，避免 def.description 停留在 "No skills available."
          if (skillToolHandle && typeof skillToolHandle.updateDescription === 'function') {
            skillToolHandle.updateDescription();
          }
          return { ok: true, count: loadedIds.length };
        });
      });
    });
  }

  global.AESkillManager = global.AESkillManager || {};
  global.AESkillManager.initSkillTools = initSkillTools;
})(window);
