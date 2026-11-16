// 扩展数据目录解析 — 统一管理 skill/memory/ae-tools 的数据路径
(function (global) {

  var _userDataDir = '';

  /**
   * 异步初始化数据目录。优先走 getSystemPath("userData")（shim 支持），
   * 兜底 ExtendScript $.getenv("APPDATA")。
   */
  function initDataDir() {
    return new Promise(function (resolve) {
      if (_userDataDir) {
        console.log('[DataDir] initDataDir 已缓存: ' + _userDataDir);
        return resolve(_userDataDir);
      }
      // ① 尝试同步 getSystemPath
      try {
        if (typeof CSInterface !== 'undefined') {
          var cs = new CSInterface();
          if (typeof cs.getSystemPath === 'function') {
            var raw = cs.getSystemPath('userData');
            console.log('[DataDir] getSystemPath raw: ' + (raw || '(empty)'));
            if (raw) {
              // getSystemPath 可能返回 file:/// URL 格式，需要清洗
              // CEP 10 实测可能返回 file:///C|/... 或 file:///C:/... 或纯路径；
              // 域环境 %APPDATA% 重定向时是 UNC：file://server/share/...（或 file:////server/...）
              var p = String(raw).trim();
              if (/^file:/i.test(p)) {
                var afterFile = p.replace(/^file:\/+/i, '');
                // 非盘符 = UNC file URL（host 段即 server）：还原 UNC 双反斜杠前缀，
                // 否则 file://server/share 会被剥成相对路径 server/share（数据根静默失效）
                p = /^[A-Za-z][:\|][\\\/]/.test(afterFile) ? afterFile : '\\\\' + afterFile;
              }
              p = decodeURIComponent(p);                          // 解码 %20 %2F 等
              p = p.replace(/\|/g, ':');                          // CEP 的 C| → C:
              p = p.replace(/\//g, '\\');                         // 最终统一反斜杠
              // 压缩重复反斜杠但保留 UNC 前缀的恰好两个（原 /\\+/→\ 会把 \\server 压成 \server）
              p = /^\\\\/.test(p) ? '\\\\' + p.replace(/^\\+/, '').replace(/\\+/g, '\\')
                                  : p.replace(/\\+/g, '\\');
              _userDataDir = p.replace(/\\+$/, '') + '\\Adobe\\CEP\\extensions\\AS_ExtP';
              console.log('[DataDir] initDataDir cleaned: ' + _userDataDir);
              return resolve(_userDataDir);
            }
          }
        }
      } catch (_) {}
      // ② 兜底 ExtendScript
      console.warn('[DataDir] getSystemPath 失败/返回空，走 ExtendScript 兜底');
      try {
        if (typeof CSInterface !== 'undefined') {
          // evalScript 回调丢失时（AE 被长任务占用/通信异常）Promise 永不 settle，
          // 整个启动链会永久挂起（main.js 卡在 32% 进度，只能重启面板）。
          // 加 10s 兜底超时（对齐 aefs 各 ES 回退 5-15s 超时惯例）：超时后走与
          // 「evalScript 返回空」一致的失败分支（dataDir 为空，上层按降级链继续启动）。
          var settled = false;
          var esTimeout = setTimeout(function () {
            if (settled) return;
            settled = true;
            console.warn('[DataDir] ExtendScript APPDATA 超时 (10s)，按返回空处理');
            resolve(_userDataDir);
          }, 10000);
          new CSInterface().evalScript('$.getenv("APPDATA")', function (result) {
            if (settled) return;  // 超时已先行 settle，丢弃迟到回调
            settled = true;
            clearTimeout(esTimeout);
            if (result && typeof result === 'string') {
              var rp = result.replace(/\//g, '\\');
              // 保留 UNC 前缀双反斜杠（\\server\share）——原 /\\+/→\ 压缩会剥掉一个，
              // 域重定向下数据根被解析成本地盘根相对路径，全链路静默失效
              rp = /^\\\\/.test(rp) ? '\\\\' + rp.replace(/^\\+/, '').replace(/\\+/g, '\\')
                                    : rp.replace(/\\+/g, '\\');
              _userDataDir = rp.replace(/\\+$/, '') + '\\Adobe\\CEP\\extensions\\AS_ExtP';
              console.log('[DataDir] ExtendScript APPDATA: ' + _userDataDir);
            } else {
              console.warn('[DataDir] ExtendScript APPDATA 返回空');
            }
            resolve(_userDataDir);
          });
        } else {
          console.warn('[DataDir] CSInterface 不可用，dataDir 为空');
          resolve('');
        }
      } catch (_) {
        console.warn('[DataDir] ExtendScript 兜底也炸了');
        resolve('');
      }
    });
  }

  function _getUserDataDir() {
    return _userDataDir;
  }

  // ── 数据根 UNC 白名单（单点真相源）─────────────
  // 企业域环境 %APPDATA% 重定向到文件服务器时数据根为 UNC（\\server\share\...）；
  // aefs._checkPath 只认盘符 → 记忆/技能/素材索引/会话缓存全链路静默失效。
  // 每次解析出「实际生效数据根」时把允许根登记给 AEFS（AEFS.setAllowedUncRoot，
  // 本文件是面板侧唯一写入方）；盘符/空值登记为空串 = 清空白名单（fail-closed）。
  // 自定义路径登记「用户配置根」而非 wrapped 子目录：main.js 保存前会对原始输入调
  // isDataDirSafe(rawSetting)，若只登记 wrapped，原始配置根会被误判成危险路径；实际
  // 数据都落在 wrapped（\\server\share\Data\AS_ExtP）内，仍是最小放行面。
  // \\?\UNC\ 扩展前缀不登记（fail-closed）：实测 Node fs.realpathSync 拒绝该前缀
  //（EISDIR/lstat 'UNC'，仅 .native 可用），bridge symlink 复核链依赖 realpathSync；
  // 普通 UNC 无需写盘前转换（Node fs 实测读写删均通，cep.fs 也吃 \\server\share）。
  function _normUncRoot(dir) {
    if (!dir || typeof dir !== 'string') return '';
    var s = dir.trim();
    if (/^[\\\/]{2}\?/.test(s)) return '';   // \\?\ / //?/ 扩展前缀：fail-closed
    if (!/^[\\\/]{2}[^\\\/]/.test(s)) return '';
    var win = s.replace(/\//g, '\\');
    // 压缩重复反斜杠但保留 UNC 前缀的恰好两个（/\\+/→\ 会剥掉一个，根形态被破坏）
    win = /^\\\\/.test(win) ? '\\\\' + win.replace(/^\\+/, '').replace(/\\+/g, '\\')
                            : win.replace(/\\+/g, '\\');
    win = win.replace(/\\+$/, '');
    var segs = win.replace(/^\\+/, '').split('\\').filter(function (x) { return !!x; });
    if (segs.length < 2) return '';
    return win;
  }

  function _registerAllowedUncRoot(dir) {
    var norm = _normUncRoot(dir);
    try {
      if (typeof AEFS !== 'undefined' && typeof AEFS.setAllowedUncRoot === 'function') {
        AEFS.setAllowedUncRoot(norm);   // 空串 = 清空白名单
      }
    } catch (_) {}
    return norm;
  }

  // 当前登记的允许根（AEFS 侧规范化形态；无/未登记 → ''，fail-closed）
  function getAllowedUncRoot() {
    try {
      if (typeof AEFS !== 'undefined' && typeof AEFS.getAllowedUncRoot === 'function') {
        return AEFS.getAllowedUncRoot() || '';
      }
    } catch (_) {}
    return '';
  }

  // 把「实际生效数据根」通知 bridge（既有 /api/set-data-dir 通道）：bridge 是独立进程，
  // safePath 的 UNC 白名单只随该同步更新（未同步=fail-closed 拒所有 UNC）。成功后
  // 记录去重值，失败不记录（bridge 未就绪时后续解析可重试补同步）。仅当 fetch 存在
  // （面板环境；单测沙箱无 fetch 时跳过）。
  // force=true：Bridge 崩溃后被心跳/自愈链重启（或断线页重连成功）时调用——新进程的
  // _allowedUncRoot 是内存态、必然为空，同值去重会把这次重登记挡掉（面板以为已同步，
  // UNC 数据根下 /fs/* 全被 4xx 拒且 AEFS 对 Bridge 4xx 不回退，全链路静默失效）。
  // 非 2xx 与 fetch 异常同样按失败处理：不记为已同步、清掉同值旧标记（允许后续解析
  // 重试补同步）并如实告警——不能因为「上次成功过」就继续假装新进程已同步。
  var _bridgeSyncedDir = '';
  function _syncDataDirToBridge(dir, force) {
    if (!dir || typeof fetch !== 'function') return;
    var normalized = String(dir).replace(/\//g, '\\').replace(/\\+$/, '');
    if (!force && _bridgeSyncedDir && normalized.toLowerCase() === _bridgeSyncedDir.toLowerCase()) return;
    // 失败时清掉「同值已同步」标记：后续 resolveDataDir 可重试（幂等重发无害），
    // 否则强制重同步失败后标记仍指向同值，重试链被去重永久挡住
    var markSyncFailed = function (why) {
      if (_bridgeSyncedDir && normalized.toLowerCase() === _bridgeSyncedDir.toLowerCase()) {
        _bridgeSyncedDir = '';
      }
      console.warn('[DataDir] 同步数据根到 Bridge 失败（' + why + '）: ' + normalized);
    };
    try {
      var url = (global.Bridge && typeof global.Bridge.getBridgeUrl === 'function')
        ? global.Bridge.getBridgeUrl() : 'http://127.0.0.1:9877';
      fetch(url + '/api/set-data-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataDir: normalized })
      }).then(function (res) {
        if (res && res.ok) {
          _bridgeSyncedDir = normalized;
          return;
        }
        // 非 2xx（如 Bridge 尚未就绪的 4xx/5xx）：纳入失败语义，不冒充已同步
        markSyncFailed('HTTP ' + ((res && res.status) || '?'));
      }).catch(function (e) {
        markSyncFailed((e && e.message) || '网络异常');
      });
    } catch (_) {}
  }

  // Bridge 恢复/重连后强制重同步当前实际数据根（忽略同值去重）。主面板在
  // 心跳检测到 offline→online 与自愈重启/断线页重连成功处各调用一次。
  function resyncDataDirToBridge() {
    var dir = '';
    try { dir = (getDataDir() || {}).dir || ''; } catch (_) {}
    if (!dir) dir = _getUserDataDir();
    if (dir) _syncDataDirToBridge(dir, true);
  }

  /**
   * 验证目录是否可写（写测试文件）
   * 前置 AEFS.isDataDirSafe 校验：危险路径（系统目录/盘根/系统盘depth1）直接返 false，不写测试文件。
   */
  function _checkWritable(dir) {
    if (!dir) return false;
    // 数据层自校验（对齐删类最严标准）：不依赖 UI 拦截，防 localStorage 篡改绕过
    if (typeof AEFS === 'undefined' || typeof AEFS.isDataDirSafe !== 'function') return false;
    if (!AEFS.isDataDirSafe(dir)) {
      console.warn('[DataDir] _checkWritable 拒危险/浅层路径: ' + dir);
      return false;
    }
    // 确保目标目录已存在：wrapped（custom\AS_ExtP）首次创建时父目录可能不存在，
    // cep.fs 回退通道的 mkdir 只建单层，直接写 /temp/ 会误判不可写
    if (typeof AEFS.mkdirSync === 'function') {
      try { AEFS.mkdirSync(dir); } catch (_) {}
    }
    // 写到 /temp/ 子路径，确保 _safeForDelete 能清理
    var testPath = dir.replace(/\\/g, '/').replace(/\/$/, '') + '/temp/_rw_test.tmp';
    // 探测会顺手把 <dir>\temp 建出来（writeFileSync 会补建父目录）。temp 自 
    // 现在不再是迁移排除项 ⇒ 空的新目录会带着这个 temp 被 inspectTargetData 判成
    // 「目标已有数据」→ 换新目录每次都弹「将先删除目标数据」的破坏性确认（纯误报）。
    // 只清「我们来之前不存在、此刻应为空」的那个 temp：rmdir 对非空目录必然失败，
    // 不碰用户有内容的 temp；探测通道故障时按「可能本来就存在」保守不动。
    var tempDir = dir.replace(/\\/g, '/').replace(/\/$/, '') + '/temp';
    var tempPreexisting = true;
    if (typeof AEFS.existsSync === 'function') {
      try { tempPreexisting = !!AEFS.existsSync(tempDir); } catch (_) { tempPreexisting = true; }
    }
    if (AEFS.writeFileSync(testPath, 'ok')) {
      AEFS.deleteFileSync(testPath);
      if (!tempPreexisting && typeof AEFS.rmdirSync === 'function') {
        try { AEFS.rmdirSync(tempDir); } catch (_) {}
      }
      return true;
    }
    // Bridge 4xx 真拒绝不回退 cep.fs（aefs.js），但 bridge 的 UNC 白名单随
    // /api/set-data-dir 同步、首次解析新 UNC 根时同步尚未发出 → AEFS.writeFileSync 被
    // bridge 400 拒成 false，会把可写的网络数据目录误判成不可写。此处对固定测试路径
    // 直接补一次 cep.fs 写探测（该目录已过 isDataDirSafe：系统目录/共享根黑名单 +
    // UNC 登记；路径固定 temp/_rw_test.tmp，写完即删，不解锁其它路径）。
    var cepFs = (typeof window !== 'undefined' && window.cep && window.cep.fs) || null;
    if (cepFs && typeof cepFs.writeFile === 'function') {
      var winTest = testPath.replace(/\//g, '\\');
      try {
        var enc = (window.cep.encoding && window.cep.encoding.UTF8 !== undefined) ? window.cep.encoding.UTF8 : 0;
        var wr = cepFs.writeFile(winTest, 'ok', enc);
        if (wr && (wr.err === undefined || wr.err === 0)) {
          if (typeof cepFs.deleteFile === 'function') { try { cepFs.deleteFile(winTest); } catch (_) {} }
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  /**
 * 数据根可用性探测：面板启动后调用一次，回答「当前生效的数据根能不能被数据层读写」。
   * 存在一类机器会让**整条数据根路径**命中 aefs._checkPath 的字符黑名单（最典型：Windows
   * 账户名含单引号，如 `C:\Users\O'Brien\...`；`%` 同理）→ 每一次读写都被入口拒绝、各模块
   * 各自降级为空数据（记忆/技能/素材/会话/画布全空），而全链只有 console.warn，**面板看起来
   * 能用、数据层整体是死的且没有任何面向用户的解释**。这里把结论变成一条可操作的事实：
   * 探测即一次真实写+删（<root>\temp\_probe_write.tmp，temp 在安全命名空间内），
   * 失败时带上数据层最后一条错误原因（AEFS.lastError）。
   * 只读不写；不改变任何语义（调用方仅据此提示）。
   * @returns {{ok: boolean, reason: string}}
   */
  function probeDataRoot(dir) {
    dir = String(dir == null ? '' : dir).replace(/\//g, '\\').replace(/\\+$/, '');
    if (!dir) return { ok: false, reason: AEI18n.t('数据根为空') };
    if (typeof AEFS === 'undefined' || typeof AEFS.writeFileSync !== 'function') {
      return { ok: false, reason: AEI18n.t('数据层缺少写入能力') };
    }
    var tempDir = dir + '\\temp';
    var tempPreexisting = true;
    if (typeof AEFS.existsSync === 'function') {
      try { tempPreexisting = !!AEFS.existsSync(tempDir); } catch (_) { tempPreexisting = true; }
    }
    var probePath = tempDir + '\\_probe_write.tmp';
    var ok = false;
    try { ok = AEFS.writeFileSync(probePath, 'ok') === true; } catch (_) { ok = false; }
    if (ok) {
      try { if (typeof AEFS.deleteFileSync === 'function') AEFS.deleteFileSync(probePath); } catch (_) {}
      if (!tempPreexisting && typeof AEFS.rmdirSync === 'function') {
        try { AEFS.rmdirSync(tempDir); } catch (_) {}
      }
      return { ok: true, reason: '' };
    }
    var why = '';
    try { if (typeof AEFS.lastError === 'function') why = String(AEFS.lastError() || ''); } catch (_) {}
    return { ok: false, reason: why || AEI18n.t('数据根不可写（路径字符/权限/磁盘）') };
  }

  /**
   * 获取数据根目录
   * @param {string} userSetting - 用户在全局设置填的路径，空字符串表示未设置
   * @returns {{ dir: string, fallback: boolean, uncRoot: string }}
   *   uncRoot = 当前登记的 UNC 白名单根（AEFS 规范化形态；盘符数据根为 ''）
   */
  function resolveDataDir(userSetting) {
    var def = _getUserDataDir();
    var result;
    if (!userSetting || !userSetting.trim()) {
      // 默认根（可能是被域重定向的 UNC）登记为允许根；盘符则清空白名单
      _registerAllowedUncRoot(def);
      result = { dir: def, fallback: false };
    } else {
      var custom = userSetting.trim().replace(/\//g, '\\');
      // 候选登记必须先于 isDataDirSafe：UNC 自定义路径本身要能过 aefs._checkPath
      // （白名单外一律「拒绝非绝对路径」）。失败回退时重登记默认根——放行面始终
      // 等于「当前实际生效数据根」。
      _registerAllowedUncRoot(custom);
      // 数据层自校验（对齐删类最严标准）：危险路径直接回退默认，不依赖 UI 拦截。
      // 防 localStorage 篡改 dataDirSetting 成系统目录后，模块 getDataDir() 仍返回安全默认值。
      if (typeof AEFS !== 'undefined' && typeof AEFS.isDataDirSafe === 'function' && !AEFS.isDataDirSafe(custom)) {
        console.warn('[DataDir] resolveDataDir 拒危险/浅层路径，回退默认: ' + custom);
        _registerAllowedUncRoot(def);
        result = { dir: def, fallback: true };
      } else {
        // 自定义目录统一包一层 AS_ExtP，避免 skills/memories 等文件夹散落在用户目录根下。
        // 校验实际数据根（wrapped），而非外层 custom——两者不一致时可能误判可写
        // （如 custom 可写但 AS_ExtP 子目录被占/无权限），测试文件 _rw_test.tmp 也随之写到 wrapped 下。
        // 注意：白名单保持登记 custom（wrapped 是其子路径，天然在内）——main.js 保存链
        // 随后会对原始输入 rawSetting 再调 isDataDirSafe，若改成只登记 wrapped 会被误判危险。
        var wrapped = custom.replace(/\\+$/, '') + '\\AS_ExtP';
        if (_checkWritable(wrapped)) {
          result = { dir: wrapped, fallback: false };
        } else {
          _registerAllowedUncRoot(def);
          result = { dir: def, fallback: true };
        }
      }
    }
    result.uncRoot = getAllowedUncRoot();
    // 实际生效数据根通知 bridge（UNC 白名单随该同步更新；盘符=清空白名单）
    _syncDataDirToBridge(result.dir);
    return result;
  }

  /**
   * 获取当前数据根目录（自动读取全局设置）
   * 模块统一调这个，不用自己传参数
   */
  var _cached = null;

  function getDataDir() {
    var setting = '';
    try {
      if (global.AE_LLM && typeof global.AE_LLM.dataDirSetting === 'string') {
        setting = global.AE_LLM.dataDirSetting;
      }
    } catch (_) {}
    // 缓存键含 _userDataDir 快照：initDataDir 完成前的早期调用（userTable 等模块
    // 装载期 fire-and-forget _load）会把 {dir:''} 写入缓存，若只比 setting 则
    // initDataDir 填充后缓存仍恒命中（''===setting ''），所有后续模块拿到空目录
    if (_cached && _cached.input === setting && _cached.base === _userDataDir) return _cached.result;
    var result = resolveDataDir(setting);
    _cached = { input: setting, base: _userDataDir, result: result };
    return result;
  }

  /** 清除缓存 + 同步全局设置（设置保存后调用） */
  function syncDataDirSetting(newSetting) {
    try { global.AE_LLM.dataDirSetting = newSetting || ''; } catch (_) {}
    _cached = null;
    // 设置变化后立即把新数据根目录写入宿主指针文件，保证 AE 原生插件随目录迁移
    var r = getDataDir();
    if (r && r.dir) writeDataDirPointer(r.dir);
  }

  // 同步原子写助手（对齐 memoryStore.js 的 .tmp → renameFileSync 模式）——
  // data-dir.txt/theme.json/hotkey-request.json 直写时，写盘窗口内进程中断留下
  // 半截文件（data-dir.txt 半截致原生宿主定位失败回退默认目录；hotkey-request.json
  // 半截致 AEGP 解析失败）。.tmp 与正式文件同目录（同白名单段，rename 也是同目录
  // 原子替换）；renameFileSync 不可用（AEFS 旧版/测试 mock）时回退直写（等同
  // 前行为），rename 失败时回退直写并清理 .tmp
  function _atomicWriteAefs(filePath, content) {
    if (typeof AEFS.renameFileSync !== 'function') return AEFS.writeFileSync(filePath, content);
    var tmpPath = filePath + '.tmp';
    if (!AEFS.writeFileSync(tmpPath, content)) return false;
    if (AEFS.renameFileSync(tmpPath, filePath)) return true;
    var directOk = AEFS.writeFileSync(filePath, content);
    try { if (AEFS.deleteFileSync) AEFS.deleteFileSync(tmpPath); } catch (_) {}
    return directOk;
  }

  // ── 数据目录相对路径 ────────────────────────────
  // 约定（本仓既有惯例，见 chatDocParse 的 temp\agent\…、背景叠加图设置项）：
  // 落在数据根**内**的文件路径按「数据根相对」持久化——换目录后仍指向新根；
  // 数据根**外**的路径（用户自己的文件）保持绝对原样（换目录与它无关）。
  // 读侧统一用 fromDataRelPath 还原成绝对再进 AEFS/file://（两处都不吃相对路径）。
  // 单一实现源：nodegenStore 与 ComfyUI 结果注入等都调这里。
  // 注：本块刻意放在「迁移收尾」小节**之前**——那边的注释与其函数是一体的，
  // 不要插到中间（有源码级断言按「函数前 1200 字符内含范围注释」钉住）。
  function _isAbsFsPath(p) {
    return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p) || /^\/\//.test(p);
  }
  function _normSlashPath(p) {
    return String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  }
  /** 绝对路径 → 数据根相对路径（根内才转；根外/已是相对/非字符串一律原样） */
  function toDataRelPath(root, p) {
    if (!p || typeof p !== 'string') return p;
    if (!root) return p;
    if (!_isAbsFsPath(p)) return p;
    var r = _normSlashPath(root);
    if (!r) return p;
    var s = _normSlashPath(p);
    // 切片后小写比较（与 _rebaseStrUnderRoot 同法：避免少数 Unicode 大小写折叠改变长度）
    if (s.length > r.length && s.charAt(r.length) === '/' && s.slice(0, r.length).toLowerCase() === r.toLowerCase()) {
      return s.slice(r.length + 1);   // 根内 → 相对（正斜杠，JSON 里无需转义）
    }
    return p;                          // 根外 → 原样
  }
  /** 数据根相对路径 → 绝对路径（已是绝对/UNC/非字符串一律原样；无根可用时原样返回） */
  function fromDataRelPath(root, p) {
    if (!p || typeof p !== 'string') return p;
    if (_isAbsFsPath(p)) return p;
    if (!root) return p;
    var r = _normSlashPath(root);
    if (!r) return p;
    return r + '/' + String(p).replace(/\\/g, '/').replace(/^\/+/, '');
  }
  /** 便捷包装：用当前生效数据根（AEShared.getDataDir()） */
  function toDataRel(p) {
    var d = getDataDir();
    return toDataRelPath(d && d.dir, p);
  }
  function fromDataRel(p) {
    var d = getDataDir();
    return fromDataRelPath(d && d.dir, p);
  }

  // ---- 迁移收尾：库索引里的绝对路径重写 ----
  // 数据目录迁移是「整份复制」，而库索引（<数据目录>\assets\<库>\index.json 这类文件）里
  // 存的是**绝对路径**：复制过来的索引仍指向旧根 → 面板在新根启动时，磁盘扫描会把新根下的
  // 同名文件当成「未登记」另起一行 → 换一次目录条目就翻一倍（真机实测：预设 92 → 184，
  // 往返多轮 276；工程素材 28 → 56）。
  // 修法：迁移收尾把复制过来的索引里**所有以旧根开头的字符串**改写成新根——同一份数据换了
  // 位置，路径跟着换，扫描自然「已登记、跳过」，不产生重复行。归档条目（路径在 ___archive__
  // 下）也是索引里的字符串，一并重写（否则换目录后归档面板显示丢失）。
  // 范围：只改 <新根>\assets\<库>\ 直接下层的 .json（库索引/清单：index.json/refs.json/
  // .folders.json…），不递归进素材载荷——工程包/<名>/ 里的 .json 是用户数据，不碰。
  // 不改旧根里的任何文件（旧根整份保留，用户自行删除）。
  function _rebaseStrUnderRoot(s, oldFwd, newFwd) {
    if (typeof s !== 'string' || !s) return null;
    var fwd = s.replace(/\\/g, '/');
    var n = oldFwd.length;
    // 按长度切片后再小写比较（而不是整串 toLowerCase 再 indexOf、再按前缀长度切片）：
    // 少数 Unicode 字符的大小写折叠会改变长度（如 İ），整串折叠后按前缀长度切片会错位；
    // 切片再折叠最坏只是「配不上」（安全侧），且输出的大小写原样保留。
    if (fwd.length < n || fwd.slice(0, n).toLowerCase() !== oldFwd) return null;
    var rest = fwd.slice(n);
    // 前缀必须是完整路径段：...\data 不得匹配 ...\data2\...
    if (rest && rest.charAt(0) !== '/') return null;
    var out = newFwd + rest;
    // 保留原书写风格（索引里两种分隔符都可能出现）
    if (s.indexOf('\\') >= 0 && s.indexOf('/') < 0) out = out.replace(/\//g, '\\');
    return out;
  }

  function rebaseLibraryIndexPaths(oldDir, newDir) {
    if (typeof AEFS === 'undefined'
        || typeof AEFS.readFileSync !== 'function' || typeof AEFS.writeFileSync !== 'function'
        || typeof AEFS.listDirsResult !== 'function' || typeof AEFS.listFilesResult !== 'function') {
      console.warn('[DataDir] 库索引路径重写跳过：数据层缺少同步读写/枚举能力');
      return Promise.resolve({ ok: true, files: 0, rewritten: 0, skipped: 'no-io' });
    }
    // 两个根都先归一（分隔符统一 + 去尾斜杠）再拼路径：调用方可能给的是
    // `D:\new\data\`（尾斜杠）或 `D:/new/data`（正斜杠），直接拼 `newDir + '\assets'`
    // 会拼出重复分隔符（`data\\assets`）。导出函数自己做归一，不依赖调用方。
    var oldFwd = String(oldDir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    var newFwd = String(newDir).replace(/\\/g, '/').replace(/\/+$/, '');
    var assetsDir = newFwd.replace(/\//g, '\\') + '\\assets';
    return AEFS.listDirsResult(assetsDir).then(function (dr) {
      // 三态口径（与全仓读盘纪律一致）：只有 NOT_FOUND 才算「真没有库」；
      // 通道故障/被拒**不得折叠成空**——否则重写会静默不发生（索引停在旧根 → 又翻倍），
      // 而回执还报成功。这类失败进 failed 列表，由上层如实 warn（与写盘失败同口径）。
      if (!dr || dr.ok !== true) {
        var code = (dr && dr.error && dr.error.code) ? dr.error.code : 'unknown';
        if (code === 'NOT_FOUND') return { ok: true, files: 0, rewritten: 0, note: 'no-libs' };
        console.warn('[DataDir] 库索引路径重读跳过：<新根>\\assets 清单读取失败 (' + code + ')');
        return { ok: false, files: 0, rewritten: 0, failed: [AEI18n.t('<assets 清单读取失败: {code}>', { code: code })] };
      }
      var libs = Array.isArray(dr.data) ? dr.data : [];
      if (!libs.length) return { ok: true, files: 0, rewritten: 0 };
      var enumFailed = [];
      return Promise.all(libs.map(function (lib) {
        var libDir = assetsDir + '\\' + lib;
        return AEFS.listFilesResult(libDir).then(function (fr) {
          if (!fr || fr.ok !== true) {
            var c = (fr && fr.error && fr.error.code) ? fr.error.code : 'unknown';
            if (c !== 'NOT_FOUND') { enumFailed.push(lib + '/ (清单读取失败: ' + c + ')'); console.warn('[DataDir] 库索引路径重写：' + lib + ' 清单读取失败 (' + c + ')'); }
            return [];
          }
          var names = Array.isArray(fr.data) ? fr.data : [];
          return names.filter(function (fn) {
            return /\.json$/i.test(fn) && fn.toLowerCase().indexOf('.corrupt.bak') < 0;
          }).map(function (fn) { return { path: libDir + '\\' + fn, name: lib + '/' + fn }; });
        }, function (e) {
          var c = (e && e.code) ? e.code : 'reject';
          enumFailed.push(lib + '/ (清单异常: ' + c + ')');
          return [];
        });
      })).then(function (lists) {
        var files = [];
        lists.forEach(function (l) { files = files.concat(l); });
        if (!files.length) {
          if (enumFailed.length) return { ok: false, files: 0, rewritten: 0, failed: enumFailed };
          return { ok: true, files: 0, rewritten: 0 };
        }
        var rewritten = 0;
        var failed = [];
        files.forEach(function (f) {
          var raw = null;
          try { raw = AEFS.readFileSync(f.path, { quietNotFound: true }); } catch (_) { raw = null; }
          if (typeof raw !== 'string' || !raw) return;
          var data = null;
          try { data = JSON.parse(raw); } catch (_) { return; }   // 非 JSON 不动（损坏件另有 .corrupt.bak 流程）
          var changed = 0;
          (function walk(node) {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) walk(node[i]); return; }
            for (var k in node) {
              if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
              var v = node[k];
              if (typeof v === 'string') {
                var nv = _rebaseStrUnderRoot(v, oldFwd, newFwd);
                if (nv !== null && nv !== v) { node[k] = nv; changed++; }
              } else if (v && typeof v === 'object') walk(v);
            }
          })(data);
          if (!changed) return;
          var ok = false;
          try { ok = _atomicWriteAefs(f.path, JSON.stringify(data, null, 2)) === true; } catch (_) { ok = false; }
          if (ok) {
            rewritten += changed;
            console.log('[DataDir] 库索引路径重写: ' + f.name + '（' + changed + ' 处旧根 → 新根）');
          } else {
            failed.push(f.name);
            console.warn('[DataDir] 库索引路径重写失败: ' + f.name);
          }
        });
        return { ok: failed.length === 0 && enumFailed.length === 0, files: files.length, rewritten: rewritten, failed: failed.concat(enumFailed) };
      });
    }, function (e) {
      // 枚举整体异常（承诺被拒/通道异常）：不得折叠为「无事可做」——如实回执失败
      var c = (e && e.code) ? e.code : 'reject';
      console.warn('[DataDir] 库索引路径重写异常：<新根>\\assets 清单 (' + c + ')');
      return { ok: false, files: 0, rewritten: 0, failed: [AEI18n.t('<assets 清单异常: {code}>', { code: c })] };
    });
  }

  /**
   * 把当前数据根目录写入宿主指针文件（%APPDATA%\...\AS_ExtP\data-dir.txt）。
   * 宿主是原生 C++ 插件，读不到 CEP 的 localStorage 设置，只能通过这个固定位置
   * 的指针文件获知自定义数据目录，据此定位 effects/ 等目录。内容为数据根目录，
   * 为空/缺失 = 宿主回退默认 APPDATA 目录。
   */
  function writeDataDirPointer(dataRootDir) {
    try {
      var base = _getUserDataDir();
      if (!base || typeof AEFS === 'undefined' || typeof AEFS.writeFileSync !== 'function') return false;
      // 目标路径为 <extensions>\AS_ExtP\data-dir.txt，含 as_extp 白名单段（SAFE_NAMESPACES），
      // 故 AEFS.writeFileSync 的 _safeForDelete 校验可放行。
      return _atomicWriteAefs(base + '\\data-dir.txt', dataRootDir || '');
    } catch (e) {
      console.warn('[DataDir] writeDataDirPointer 失败: ' + (e && e.message || e));
      return false;
    }
  }

  // ---- 多实例标记读取（不支持多实例）----
  // 宿主启动链在 temp/handoff 写 ae_extp_multi_instance.json（内容 {ts, iso, selfPid, pids}；
  // 数据目录不可用时按 token/vbs 同款回退落 %TEMP%\AS_ExtP\handoff，见 host.jsx）。
  // 面板在「候选端口全鉴权不符（401/403）/ bridge 反复断线」时读取：新鲜（≤10 分钟）
  // → 多实例冲突态（明示不支持多实例，重试不 restartBridge）；过期 → 忽略并清理。
  // 读取走 AEFS（Bridge→cep.fs→ExtendScript 三级回退，bridge 死亡时仍可读）。
  var MULTI_INSTANCE_MARKER_NAME = 'ae_extp_multi_instance.json';
  var MULTI_INSTANCE_MARKER_FRESH_MS = 10 * 60 * 1000;

  function _normDirPath(p) { return String(p || '').replace(/[\\\/]+$/, ''); }

  // 标记候选路径：数据根优先，系统 temp 兜底（host 侧两处回退对齐）
  function getMultiInstanceMarkerPaths() {
    var paths = [];
    var root = '';
    try {
      var resolved = getDataDir();
      root = (resolved && resolved.dir) || _getUserDataDir();
    } catch (_) { root = _getUserDataDir(); }
    if (root) paths.push(_normDirPath(root) + '\\temp\\handoff\\' + MULTI_INSTANCE_MARKER_NAME);
    try {
      if (global.cep && global.cep.fs && typeof global.cep.fs.getTemporaryDirectory === 'function') {
        var tmp = global.cep.fs.getTemporaryDirectory();
        if (tmp) paths.push(_normDirPath(tmp) + '\\AS_ExtP\\handoff\\' + MULTI_INSTANCE_MARKER_NAME);
      }
    } catch (_) {}
    return paths;
  }

  // 读取第一个可解析的标记（不做新鲜度判断），无则 null；返回 { marker, path }
  function readMultiInstanceMarkerSync() {
    if (typeof AEFS === 'undefined' || typeof AEFS.readFileSync !== 'function') return null;
    var paths = getMultiInstanceMarkerPaths();
    for (var i = 0; i < paths.length; i++) {
      var raw = null;
      // 探测**可选**标记——「文件不存在」是常态（单实例时恒不存在），不记 WARN
      try { raw = AEFS.readFileSync(paths[i], { quietNotFound: true }); } catch (_) { raw = null; }
      if (!raw) continue;
      var m = null;
      try { m = JSON.parse(raw); } catch (_) { m = null; }
      if (!m || typeof m !== 'object' || typeof m.ts !== 'number' || !(m.ts > 0)) continue;
      return { marker: m, path: paths[i] };
    }
    return null;
  }

  // 读取「新鲜」标记（ts 在 windowMs 内）；过期条目清理后忽略。
  // 时间戳不可解析/缺失的条目一律忽略且不删（可能是半截写入，宁留不误删）；
  // 无 Date 时钟的异常环境按新鲜返回（不因拿不到时钟误判过期）。
  function readFreshMultiInstanceMarkerSync(windowMs) {
    if (typeof AEFS === 'undefined' || typeof AEFS.readFileSync !== 'function') return null;
    var win = (typeof windowMs === 'number' && windowMs > 0) ? windowMs : MULTI_INSTANCE_MARKER_FRESH_MS;
    var nowMs = (typeof Date !== 'undefined' && typeof Date.now === 'function') ? Date.now() : 0;
    var paths = getMultiInstanceMarkerPaths();
    var best = null;
    for (var i = 0; i < paths.length; i++) {
      var raw = null;
      // 探测**可选**标记——「文件不存在」是常态（单实例时恒不存在），不记 WARN
      try { raw = AEFS.readFileSync(paths[i], { quietNotFound: true }); } catch (_) { raw = null; }
      if (!raw) continue;
      var m = null;
      try { m = JSON.parse(raw); } catch (_) { m = null; }
      if (!m || typeof m !== 'object' || typeof m.ts !== 'number' || !(m.ts > 0)) continue;
      if (nowMs && (nowMs - m.ts) > win) {
        // 过期：忽略并清理（清理失败静默——下次仍按过期忽略，不阻断冲突判定）
        try {
          if (typeof AEFS.deleteFileSync === 'function') AEFS.deleteFileSync(paths[i]);
        } catch (_) {}
        continue;
      }
      if (!best || m.ts > best.marker.ts) best = { marker: m, path: paths[i] };
    }
    return best ? best.marker : null;
  }

  // 清除全部候选路径上的标记（宿主复核确认已只剩一个实例时由 bridge 层调用）
  function clearMultiInstanceMarkerSync() {
    var removed = 0;
    if (typeof AEFS === 'undefined' || typeof AEFS.deleteFileSync !== 'function') return 0;
    var paths = getMultiInstanceMarkerPaths();
    for (var i = 0; i < paths.length; i++) {
      try {
        if (AEFS.readFileSync && AEFS.readFileSync(paths[i], { quietNotFound: true })) {
          if (AEFS.deleteFileSync(paths[i])) removed++;
        }
      } catch (_) {}
    }
    return removed;
  }

  // 迁移排除清单（根级条目，按名称匹配；运行时枚举后过滤）。
  // 手维护白名单（旧 10 项 subdirs）只迁这些子目录、且完全不迁数据根下的
  // 散文件，漏掉 comfyui/（画布悬浮面板对话历史）与 ast-gate-user-table.json
  //（用户逐条确认累积的 AST 门增补表）等可达数据；叠加「旧目录数据已完整拷贝」
  // 提示，用户照做删旧目录即永久丢失。改为运行时枚举磁盘实际条目为准——只
  // 排除下列指针/应用本体项，新增模块/新根级文件无需维护迁移表：
  //   data-dir.txt —— 宿主指针文件：原生 AEGP/热盒在默认扩展目录固定位置读取它
  //           定位数据根，切换目录时由 writeDataDirPointer 按新目录重写；把它拷进
  //           新数据根只会留下一个过期指针
  //   应用目录名（client/host/CSXS/vendor/node_modules/deploy）——扩展本体，不是用户数据。
  //           手工装法把面板直接装在数据根（CEP 用户级扩展：%APPDATA%\Adobe\CEP\extensions\
  //           AS_ExtP 下直接放 client/ host/ CSXS/ vendor/），此时数据根 = 扩展根，
  //           migrateData 运行时枚举**全部**条目就会把应用本体（含 node_modules）整份
  //           复制——保存动作被长拷贝卡住、新数据根混入应用文件。默认安装（Program Files）
  //           下这些条目不在数据根里，排除无副作用；返回结构的 excluded 会如实列出它们，
  //           不影响既有 ok 语义。
  // **temp 不排除、整份跟随迁移**（若只单独搬
  //   temp\bg-overlay）——理由是「以后加了新功能会忘掉再出 bug」：temp 里已经放过用户
  //   内容（聊天图片 temp/agent 被会话历史按数据目录相对路径引用、背景叠加图
  //   temp/bg-overlay），逐项记忆不可靠。整份迁移的代价与兜底：①迁移多拷一份缓存
  //   （体积受既有清扫预算约束）；②旧会话的聊天图片/旧日志在新目录照常可见（诊断包
  //   不再缺切换前那段）；③temp/handoff 的过期交接件由宿主启动链按 mtime>10min 的
  //   既有清扫处理，复制过去无害。
  var MIGRATE_EXCLUDED = ['data-dir.txt',
    'client', 'host', 'csxs', 'vendor', 'node_modules', 'deploy'];

  // 排除名比较大小写不敏感：Windows 文件系统不区分大小写，磁盘上出现
  // `Client`/`TEMP`/`Vendor` 等异体时，精确 indexOf 会漏排除——手工装法（数据根 =
  // 扩展根）下应用本体被当用户数据整份拷贝。判定用 toLowerCase 折叠；excluded
  // 清单仍按磁盘原名如实列出（用户看到的就是盘上真实名字）。
  function _isMigrateExcluded(n) {
    return typeof n === 'string' && MIGRATE_EXCLUDED.indexOf(n.toLowerCase()) >= 0;
  }

  // ---- 目录身份判定 -------------------------------------------
  // 迁移链只用 JS 字符串全等判「新旧是不是同一个目录」（`oldDir === newDir`）时，
  // Windows 文件系统大小写不敏感，Win32 还会归一化重复分隔符 / `.` / `..` / 段尾点空格
  // ——同一个物理目录能写出多个不同字符串。后果（真机复现）：
  //   d:\x\AS_ExtP vs D:\X\AS_ExtP 被判成「换目录」→ inspectTargetData 把源自身当目标
  //   （hasData=true）→ 用户确认覆盖后【删除阶段删掉唯一一份数据】→ 拷贝阶段源已空，
  //   桥侧「缺失源 → {copied:0,failed:0}」被面板判成功 → 回执还写「源目录未动」。
  // 归一化只用于**比较**（绝不用于构造真实路径）：统一反斜杠、丢空段/`.`、解析 `..`、
  // 段尾空白与点（Win32 段名归一化）、整体小写。
  function _normDirIdentity(p) {
    var f = String(p == null ? '' : p).replace(/\//g, '\\').trim();
    if (!f) return '';
    var segs = f.split('\\');
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      // `..` 必须先判：段尾点剥除会把 '..' 吃成空段（顺序反了会静默丢掉向上解析）
      if (segs[i] === '..') {
        if (out.length > 1 || (out.length === 1 && !/^[a-z]:$/i.test(out[0]))) out.pop();
        continue;
      }
      var s = segs[i].replace(/[ .]+$/, '');
      if (!s || s === '.') continue;
      out.push(s);
    }
    return out.join('\\').toLowerCase();
  }

  /**
   * 判定「从 oldDir 迁到 newDir」的形态：迁移 / 同一目录 / 互为父子。
   * 字符串层判定（同步、无 IO）；数据层另有物理身份正面证明（见 _proveSameDirPhysical）。
   * @returns {{kind: 'migrate'|'same'|'nested', side?: 'new-in-old'|'old-in-new'}}
   */
  function classifyDataDirMove(oldDir, newDir) {
    var a = _normDirIdentity(oldDir);
    var b = _normDirIdentity(newDir);
    if (!a || !b) return { kind: 'migrate' };
    if (a === b) return { kind: 'same' };
    if (a.length > b.length && a.slice(0, b.length + 1) === b + '\\') return { kind: 'nested', side: 'old-in-new' };
    if (b.length > a.length && b.slice(0, a.length + 1) === a + '\\') return { kind: 'nested', side: 'new-in-old' };
    return { kind: 'migrate' };
  }

  // 祖孙目录的拒绝回执（同一文案，供字符串判定与物理判定共用）
  function _nestedRefusal(move, oldDir, newDir) {
    var side = move && move.side;
    var why = (side === 'new-in-old')
      ? '目标目录在数据目录内部'
      : (side === 'old-in-new' ? '数据目录在目标目录内部' : '两者互为父子');
    console.warn('[DataDir] migrateData 拒迁移：' + why + '（' + oldDir + ' ↔ ' + newDir + '）');
    return {
      ok: false, code: 'TARGET_NESTED', side: side || null,
      error: AEI18n.t('目标目录与当前数据目录互为父子（') + why + AEI18n.t('），迁移会互相覆盖或递归拷贝，已拒绝。请选择独立的目录')
    };
  }

  // 物理同目录的**正面证明**（字符串判定拦不住的别名：junction/symlink/8.3 短名/映射盘）：
  // 往 <newDir>\temp\ 写一个带时间戳的标记文件，再读 <oldDir>\temp 的清单看它是否出现
  // ——同一个物理目录才会互相看见。只用既有能力（写 + 清单），不依赖 bridge 新端点。
  // 判据三态（与全仓读盘纪律一致）：清单 NOT_FOUND = 两边不同目录（新根 temp 是刚建出来的，
  // 若同目录则旧根 temp 必然也在）→ false；通道故障 = 探不到 → 放行既有流程（fail-open，
  // 字符串判定已挡住常见形态）；标记写入失败 = 放行。无论结论如何都清理标记文件。
  function _proveSameDirPhysical(oldDir, newDir) {
    if (typeof AEFS === 'undefined' || typeof AEFS.writeFileSync !== 'function' || typeof AEFS.listFilesResult !== 'function') {
      return Promise.resolve(false);
    }
    var markerName = '_migrate_identity_probe.tmp';
    var markerNew = newDir + '\\temp\\' + markerName;
    try {
      if (!AEFS.writeFileSync(markerNew, String(Date.now()))) return Promise.resolve(false);
    } catch (_) { return Promise.resolve(false); }
    var cleanup = function () { try { if (typeof AEFS.deleteFileSync === 'function') AEFS.deleteFileSync(markerNew); } catch (_) {} };
    return AEFS.listFilesResult(oldDir + '\\temp').then(function (fr) {
      cleanup();
      if (!fr || fr.ok !== true) return false;                     // NOT_FOUND/通道故障 → 不阻断
      var names = Array.isArray(fr.data) ? fr.data : [];
      for (var i = 0; i < names.length; i++) {
        if (String(names[i]).toLowerCase() === markerName) return true;
      }
      return false;
    }, function () { cleanup(); return false; });
  }

  // 真实路径探测（失败一律 null → 调用方放行既有流程）
  function _probeRealPath(p) {
    if (typeof AEFS === 'undefined' || typeof AEFS.realpathAsync !== 'function') return Promise.resolve(null);
    try {
      return AEFS.realpathAsync(p).then(function (rp) { return rp || null; }, function () { return null; });
    } catch (_) { return Promise.resolve(null); }
  }

  // 逐项迁移包装：目录拷贝沿用 _copyDirAefs（目标已存在则内部逐文件跳过不覆盖）
  // 拷贝前做**源目录存在性三态探测**。没有它时会踩一个谎言：源目录在拷贝那一刻
  // 已不存在（被判为同一目录的别名、枚举后被并发删除等）时，桥侧 copyDirChunked 对
  // 缺失源直接 continue → 返回 {copied:0,failed:0}，而面板 aefs.js 把 failed===0 判为
  // **成功**（空源也算成功，见 aefs.js copyDir 注释）——「一个文件都没拷」被计成
  // 「已迁移」，面板据此引导用户删旧目录。NOT_FOUND（真不在）如实失败；通道故障
  // （拿不到判定）照常尝试拷贝，保持 fail-safe 不因探测能力缺失而漏迁。
  function _migrateDirAefs(srcDir, dstDir) {
    var srcProbe = (typeof AEFS !== 'undefined' && typeof AEFS.listDirsResult === 'function')
      ? AEFS.listDirsResult(srcDir).then(function (r) {
          if (r && r.ok === false && r.error && r.error.code === 'NOT_FOUND') return { missing: true };
          return { missing: false };
        }, function () { return { missing: false }; })
      : Promise.resolve({ missing: false });
    return srcProbe.then(function (p) {
      if (p.missing) {
        console.warn('[DataDir] migrateData 源目录已不存在，如实失败（不计数为已迁移）: ' + srcDir);
        return { ok: false, skipped: false, missingSource: true };
      }
      return _copyDirAefs(srcDir, dstDir).then(function (ok) {
        return { ok: !!ok, skipped: false };
      });
    });
  }

  // 逐项迁移包装：根级文件。目标已存在则跳过不覆盖（与 copyDir 既有语义一致），
  // 且如实标记 skipped——跳过项不计入「已迁移」，否则用户按计数删旧目录会丢该文件。
  // 存在性判定走 existsResult 三态：ok:true → 跳过；NOT_FOUND → 拷；通道故障/
  // 拒绝（无法判定）→ 仍执行拷贝（fail-safe：宁可覆盖也不静默漏件，copy 失败会
  // 进 failed 如实报错，不会出现「完整拷贝」式断言）
  function _migrateFileAefs(srcFile, dstFile) {
    var existsProbe = (typeof AEFS !== 'undefined' && typeof AEFS.existsResult === 'function')
      ? AEFS.existsResult(dstFile)
      : Promise.resolve({ ok: false, error: { code: 'NOT_FOUND' } });
    return existsProbe.then(function (probe) {
      if (probe && probe.ok === true) {
        console.log('[DataDir] migrateData 跳过已存在文件（不覆盖）: ' + dstFile);
        return { ok: true, skipped: true };
      }
      return AEFS.copyFile(srcFile, dstFile).then(function (ok) {
        console.log('[DataDir] migrateData 文件: ' + srcFile + ' → ' + dstFile + ' ok=' + !!ok);
        return { ok: !!ok, skipped: false };
      });
    });
  }

  /**
 * 目标数据根探测（覆盖确认前置）：目标是否已含 AS_ExtP 数据（非排除项条目）。
   * 三态语义：ok:true = 读得（含两侧 NOT_FOUND → hasData:false）；ok:false = 通道故障/
   * 能力缺失（调用方必须按「可能已有数据」保守处理：弹覆盖确认或拒绝切换，绝不静默
 * 走跳过语义——那正是的丢改机制）。
   * @param {string} targetDir — 目标数据根（已包 AS_ExtP 层的绝对路径）
   * @returns {Promise<{ok: boolean, hasData: boolean, entries: string[], dirEntries: string[], fileEntries: string[], error?: string}>}
   */
  function inspectTargetData(targetDir) {
    targetDir = (targetDir || '').replace(/\//g, '\\');
    if (!targetDir) return Promise.resolve({ ok: false, hasData: false, entries: [], dirEntries: [], fileEntries: [], error: AEI18n.t('目标目录为空') });
    if (typeof AEFS === 'undefined'
        || typeof AEFS.listDirsResult !== 'function' || typeof AEFS.listFilesResult !== 'function') {
      return Promise.resolve({ ok: false, hasData: false, entries: [], dirEntries: [], fileEntries: [], error: AEI18n.t('数据层缺少运行时枚举能力') });
    }
    var isExcluded = _isMigrateExcluded;
    return Promise.all([AEFS.listDirsResult(targetDir), AEFS.listFilesResult(targetDir)]).then(function (lists) {
      var dirsRes = lists[0];
      var filesRes = lists[1];
      var codeOf = function (r) { return (r && r.ok === false && r.error && r.error.code) ? r.error.code : ''; };
      if (codeOf(dirsRes) === 'NOT_FOUND' && codeOf(filesRes) === 'NOT_FOUND') {
        return { ok: true, hasData: false, entries: [], dirEntries: [], fileEntries: [] };
      }
      if (!dirsRes || dirsRes.ok !== true || !filesRes || filesRes.ok !== true) {
        return { ok: false, hasData: false, entries: [], dirEntries: [], fileEntries: [],
          error: AEI18n.t('目标目录清单读取失败 (') + (codeOf(dirsRes) || codeOf(filesRes) || AEI18n.t('未知')) + ')' };
      }
      var dirEntries = (Array.isArray(dirsRes.data) ? dirsRes.data : []).filter(function (n) { return !isExcluded(n); });
      var fileEntries = (Array.isArray(filesRes.data) ? filesRes.data : []).filter(function (n) { return !isExcluded(n); });
      return { ok: true, hasData: (dirEntries.length + fileEntries.length) > 0,
        entries: dirEntries.concat(fileEntries), dirEntries: dirEntries, fileEntries: fileEntries };
    });
  }

  /**
   * 迁移数据：运行时枚举旧数据根下的实际条目（子目录 + 根级文件）逐个复制到新目录，
   * 排除瞬态/指针项（MIGRATE_EXCLUDED）；成功后旧目录保留、由用户手动删除。
   * 语义：目标已存在则跳过不覆盖；逐项失败不阻塞其它项，但任一项失败整体 ok:false；
   * 旧目录不存在（NOT_FOUND）视为无可迁移内容（ok:true, 0 项）；枚举通道故障时
   * 中止迁移（ok:false）——拿不到清单绝不假装迁完。
   * @param {string} oldDir — 当前数据目录
   * @param {string} newDir — 目标数据目录
  * @param {{overwrite?: boolean}} [opts] — 目标已含数据时
   *   不再静默跳过。overwrite:true（面板已获用户覆盖确认）→ 先删除目标数据区（排除项
   *   不动）再整份复制（镜像语义）；未传/false → 拒绝迁移并返回 code:'TARGET_HAS_DATA'
   *   （面板据此弹「是否覆盖」确认后重试）。
   * @returns {{ ok: boolean, error?: string, code?: string, migrated?: number, replaced?: number, failed?: string[], excluded?: string[], skipped?: string[] }}
   */
  // 安全发射进度事件（回调异常绝不影响迁移本体）
  function _emitProgress(cb, ev) { try { if (typeof cb === 'function') cb(ev); } catch (_) {} }

  function migrateData(oldDir, newDir, opts) {
    opts = opts || {};
    var onProgress = (typeof opts.onProgress === 'function') ? opts.onProgress : null;
    oldDir = (oldDir || '').replace(/\//g, '\\');
    newDir = (newDir || '').replace(/\//g, '\\');
    if (!oldDir || !newDir) return Promise.resolve({ ok: true, migrated: 0, failed: [], excluded: [], skipped: [] });
    // 目录身份判定（归一化比较，见 classifyDataDirMove 注释）。字符串全等在 Windows
    // 判不了「同一个目录」；互为父子的迁移会互删/递归拷贝（真机复现）。
    var _moveKind = classifyDataDirMove(oldDir, newDir);
    if (_moveKind.kind === 'same') {
      console.warn('[DataDir] migrateData 跳过：新旧数据目录为同一目录（书写差异）: ' + oldDir);
      return Promise.resolve({ ok: true, migrated: 0, failed: [], excluded: [], skipped: [],
        note: AEI18n.t('目标与当前数据目录为同一目录（仅书写差异），未做迁移') });
    }
    if (_moveKind.kind === 'nested') return Promise.resolve(_nestedRefusal(_moveKind, oldDir, newDir));
    // 数据层自校验（对齐删类最严标准）：拒把数据迁进系统目录/盘根/浅层目录。
    if (typeof AEFS !== 'undefined' && typeof AEFS.isDataDirSafe === 'function' && !AEFS.isDataDirSafe(newDir)) {
      console.warn('[DataDir] migrateData 拒危险/浅层目标路径: ' + newDir);
      return Promise.resolve({ ok: false, error: AEI18n.t('目标路径位于系统目录/盘根/浅层目录，已拒绝') });
    }
    if (!_checkWritable(newDir)) return Promise.resolve({ ok: false, error: AEI18n.t('目标目录无写入权限') });

    // 运行时枚举是漏件防线：数据层拿不到枚举/逐项拷贝能力就不迁移，
    // 绝不用静态清单冒充满迁移（宁可失败让用户重试）
    if (typeof AEFS === 'undefined'
        || typeof AEFS.listDirsResult !== 'function' || typeof AEFS.listFilesResult !== 'function'
        || typeof AEFS.copyDir !== 'function' || typeof AEFS.copyFile !== 'function') {
      console.warn('[DataDir] migrateData 中止：数据层缺少运行时枚举/逐项拷贝能力');
      return Promise.resolve({ ok: false, error: AEI18n.t('数据层缺少运行时枚举能力，已中止迁移以避免漏件') });
    }

    // AEFS.listDirsResult/listFilesResult 三态：ok(data)=读得（含空目录）；
    // NOT_FOUND=目录不存在（权威）；CHANNEL_FAILURE/REJECTED=拿不到/被拒。
    // 第三项是的物理身份正面证明（标记文件互见）——与旧根枚举同批发起，
    // 结论 true 时直接按「同一目录」返回，不进入 inspectTargetData/删除阶段。
    // 第四/五项是真实路径探测（bridge 只读 /fs/realpath，探不到 = null 放行）。
    return Promise.all([AEFS.listDirsResult(oldDir), AEFS.listFilesResult(oldDir), _proveSameDirPhysical(oldDir, newDir),
      _probeRealPath(oldDir), _probeRealPath(newDir)]).then(function (lists) {
      if (lists[2] === true) {
        console.warn('[DataDir] migrateData 跳过：物理身份探测确认新旧为同一目录: ' + oldDir + ' ↔ ' + newDir);
        return { ok: true, migrated: 0, failed: [], excluded: [], skipped: [],
          note: AEI18n.t('目标与当前数据目录是同一个目录（物理身份探测确认），未做迁移') };
      }
      // 真实路径复核——上面那条「标记互见」只能证明同一目录，证明不了
      // **物理嵌套**（junction/symlink/映射盘让「新根」实际落在旧根子树内 → 拷贝阶段会往源子树
      // 里递归写，真机到 MAX_PATH 才停）。这里对两个根各求一次真实路径（bridge 只读
      // /fs/realpath），探得到就再判一次 same/nested；探不到（旧桥/通道故障/根还不存在）放行。
      var _rpOld = lists[3];
      var _rpNew = lists[4];
      if (_rpOld && _rpNew) {
        var _physMove = classifyDataDirMove(_rpOld, _rpNew);
        if (_physMove.kind === 'same') {
          console.warn('[DataDir] migrateData 跳过：真实路径复核确认新旧为同一目录: ' + _rpOld);
          return { ok: true, migrated: 0, failed: [], excluded: [], skipped: [],
            note: AEI18n.t('目标与当前数据目录是同一个目录（真实路径复核确认），未做迁移') };
        }
        if (_physMove.kind === 'nested') {
          console.warn('[DataDir] migrateData 拒迁移：真实路径复核发现物理嵌套（' + _rpOld + ' ↔ ' + _rpNew + '）');
          return { ok: false, code: 'TARGET_NESTED', side: _physMove.side, physical: true,
            error: AEI18n.t('目标目录与当前数据目录在磁盘上互为父子（经 junction/符号链接/映射盘解析后确认：')
              + (_physMove.side === 'new-in-old' ? AEI18n.t('目标在数据目录内部') : AEI18n.t('数据目录在目标内部'))
              + AEI18n.t('），迁移会往源目录里递归拷贝，已拒绝。请选择独立的目录') };
        }
      }
      var dirsRes = lists[0];
      var filesRes = lists[1];
      var codeOf = function (r) { return (r && r.ok === false && r.error && r.error.code) ? r.error.code : ''; };
      var dirsCode = codeOf(dirsRes);
      var filesCode = codeOf(filesRes);
      // 旧目录不存在（首次设置自定义目录等）：无可迁移内容，按成功返回 0 项
      if (dirsCode === 'NOT_FOUND' && filesCode === 'NOT_FOUND') {
        console.log('[DataDir] migrateData: 旧目录不存在，无可迁移内容: ' + oldDir);
        return { ok: true, migrated: 0, failed: [], excluded: [], skipped: [] };
      }
      // 枚举失败（非真不存在）→ 中止，不得当空目录假成功
      if (!dirsRes || dirsRes.ok !== true || !filesRes || filesRes.ok !== true) {
        var why = dirsCode || filesCode || '未知';
        console.warn('[DataDir] migrateData 中止：旧目录清单读取失败 (' + why + '): ' + oldDir);
        // 带 code——面板据此给对症文案（而非一律"请检查路径是否存在、是否可写"）
        return { ok: false, code: 'SOURCE_UNREADABLE', error: AEI18n.t('无法读取旧目录内容清单（') + why + AEI18n.t('），已中止迁移以避免漏件') };
      }

      var allDirs = Array.isArray(dirsRes.data) ? dirsRes.data : [];
      var allFiles = Array.isArray(filesRes.data) ? filesRes.data : [];
      var isExcluded = _isMigrateExcluded;
      // 实际存在且被排除的条目如实计入未迁移清单（临时/指针项用户不必惊慌，但必须可见）
      var excluded = allDirs.concat(allFiles).filter(isExcluded);
      var dirs = allDirs.filter(function (n) { return !isExcluded(n); });
      var files = allFiles.filter(function (n) { return !isExcluded(n); });

      // ── 目标目录冲突处理——不再静默跳过 ──────────
      // 旧语义「目标已存在则跳过不覆盖」在「切回旧数据目录」场景会静默丢改：新目录
      // 期间写进同名文件的内容（工具库/记忆与会话索引/provider 配置等单文件库全族）
      // 全被跳过，回执仍报「已迁移」。新语义：目标已含数据时由面板弹覆盖确认
      // （opts.overwrite === true）——先删除目标数据区（排除项不动）再整份复制
      //（镜像语义，目标独有条目也清掉，新目录期间的删除不再复活）；未获确认则拒绝
      // 迁移（code=TARGET_HAS_DATA），绝不静默跳过。源目录无数据条目时无可替换内容
      // → 不删目标（否则「切回有数据的目录」会把目标清空且什么都不拷）。
      return inspectTargetData(newDir).then(function (tp) {
        if (!tp || tp.ok !== true) {
          console.warn('[DataDir] migrateData 中止：目标目录清单读取失败 (' + (tp && tp.error ? tp.error : '未知') + ')');
          return { ok: false, code: 'TARGET_UNREADABLE', error: AEI18n.t('无法读取目标目录内容清单（') + (tp && tp.error ? tp.error : AEI18n.t('未知')) + AEI18n.t('），已中止迁移（未拷贝、未删除）') };
        }
        if (!tp.hasData) return runCopyPhase(0);
        if (opts.overwrite !== true) {
          console.warn('[DataDir] migrateData 拒绝：目标目录已含 AS_ExtP 数据且未确认覆盖（' + tp.entries.length + ' 项）: ' + newDir);
          return {
            ok: false, code: 'TARGET_HAS_DATA',
            error: AEI18n.t('目标目录已存在 AS_ExtP 数据（') + tp.entries.length + AEI18n.t(' 项），需确认覆盖后才能继续'),
            targetEntries: tp.entries
          };
        }
        if (dirs.length + files.length === 0) {
          console.log('[DataDir] migrateData 覆盖模式：源目录无数据条目，不删除目标内容: ' + newDir);
          return { ok: true, migrated: 0, failed: [], excluded: excluded, skipped: [], replaced: 0,
            note: AEI18n.t('源目录无数据条目，未删除目标目录内容') };
        }
        return runDeletePhase(tp);
      });

      // 覆盖删除阶段（仅 overwrite 且目标有数据时进入）：删除目标非排除项条目——
      // 目录走 removeDirRecursive（{preConfirmed:true}：优先回收站，用户已在覆盖确认
      // 弹窗中获知「无法回收则永久删除」），散文件走 deleteFile。任一删除失败 → 中止
      // 且不开始拷贝（源目录未动；重试保存会先补齐删除再拷贝，收敛不重复）。
      // （temp 不再是排除项，随其余条目一体删除；原「temp\bg-overlay
      //  单独删、失败仅告警」的特例已一并移除。）
      function runDeletePhase(tp) {
        if (typeof AEFS.removeDirRecursive !== 'function' || typeof AEFS.deleteFile !== 'function') {
          console.warn('[DataDir] migrateData 中止：数据层缺少删除能力，覆盖无法安全执行');
          return Promise.resolve({ ok: false, code: 'NO_DELETE_CAPABILITY', error: AEI18n.t('数据层缺少删除能力，已中止覆盖（未改动任何数据）') });
        }
        var delTasks = [];
        var delNames = [];
        (tp.dirEntries || []).forEach(function (sub) {
          delNames.push(sub);
          delTasks.push(AEFS.removeDirRecursive(newDir + '\\' + sub, { preConfirmed: true }).then(
            function (ok) { return { ok: !!ok }; },
            function (e) { console.warn('[DataDir] 覆盖删除异常: ' + sub + ' — ' + (e && (e.code || e.message) || e)); return { ok: false }; }
          ));
        });
        // 散文件先走**回收站通道**
        // （AEFS.deleteFileToRecycle → 桥侧 Shell COM，与目录同源）；回收站不可用/失败时
        // 退回 AEFS.deleteFile（永久删）——与覆盖确认弹窗已明示的「优先移入回收站；
        // 无法移入时将永久删除」完全一致（永久删除不再是未告知的默认行为）。
        var _recycleFn = (typeof AEFS.deleteFileToRecycle === 'function')
          ? function (p) {
              return AEFS.deleteFileToRecycle(p).then(function (r) {
                if (r && r.ok) return { ok: true, method: r.method || 'recyclebin' };
                return AEFS.deleteFile(p).then(function (ok) { return { ok: !!ok, method: 'permanent' }; });
              }, function () {
                return AEFS.deleteFile(p).then(function (ok) { return { ok: !!ok, method: 'permanent' }; });
              });
            }
          : function (p) {
              return AEFS.deleteFile(p).then(function (ok) { return { ok: !!ok, method: 'permanent' }; });
            };
        (tp.fileEntries || []).forEach(function (file) {
          delNames.push(file);
          delTasks.push(_recycleFn(newDir + '\\' + file).then(
            function (r) { return { ok: !!(r && r.ok), method: r && r.method }; },
            function (e) { console.warn('[DataDir] 覆盖删除异常: ' + file + ' — ' + (e && (e.code || e.message) || e)); return { ok: false }; }
          ));
        });
        if (delNames.length > 0) _emitProgress(onProgress, { phase: 'delete', done: 0, total: delNames.length });
        var delDone = 0;
        function _tickDelete() {
          delDone++;
          _emitProgress(onProgress, { phase: 'delete', done: delDone, total: delNames.length });
        }
        delTasks.forEach(function (tk) {
          tk.then(_tickDelete, _tickDelete);
        });
        return Promise.all(delTasks).then(function (results) {
          var delFailed = [];
          var replaced = 0;
          for (var i = 0; i < results.length; i++) {
            if (results[i] && results[i].ok === true) replaced++;
            else delFailed.push(delNames[i]);
          }
          if (delFailed.length > 0) {
            console.warn('[DataDir] migrateData 覆盖删除失败: ' + delFailed.join(', ') + '（中止，未开始拷贝）');
            return { ok: false, code: 'DELETE_FAILED', error: AEI18n.t('覆盖失败：无法删除目标目录中的 ') + delFailed.join((typeof AEI18n !== 'undefined' && AEI18n.punct ? AEI18n.punct('、', ', ', '、') : '、')) + AEI18n.t('（源目录未动；可重试保存继续）'), replaced: replaced, failed: delFailed };
          }
          // 整份迁移 temp 后：目标 temp 已是普通删除项，随上面 dirEntries
          // 一体删除（原「单独删 bg-overlay、失败仅告警」的特例已移除）
          return runCopyPhase(replaced);
        });
      }

      // 拷贝阶段（既有逐项拷贝语义：目录内逐文件「目标已存在则跳过不覆盖」；删除阶段
      // 之后目标为空，跳过分支仅兜底并发新出现的文件）。replaced = 删除阶段已删条目数。
      function runCopyPhase(replaced) {
        var copyTargets = [];
        var names = [];
        dirs.forEach(function (sub) {
          copyTargets.push(_migrateDirAefs(oldDir + '\\' + sub, newDir + '\\' + sub));
          names.push(sub);
        });
        files.forEach(function (file) {
          copyTargets.push(_migrateFileAefs(oldDir + '\\' + file, newDir + '\\' + file));
          names.push(file);
        });

        // 整份迁移 temp 后：temp 已是普通目录项，随上面 dirs 循环一体拷贝；
        // 原「temp\bg-overlay 三态探测后单独迁」的特例已移除（那次三态复核要解决的问题
        // ——通道故障把目录静默漏迁——对普通目录项同样由 copyDir 的失败进 failed 列表兜住）。
        if (copyTargets.length > 0) _emitProgress(onProgress, { phase: 'copy', done: 0, total: copyTargets.length });
        var copyDone = 0;
        function _tickCopy() {
          copyDone++;
          _emitProgress(onProgress, { phase: 'copy', done: copyDone, total: copyTargets.length });
        }
        copyTargets.forEach(function (cp) { cp.then(_tickCopy, _tickCopy); });
        return Promise.all(copyTargets).then(function (results) {
            var migrated = 0;
            var failed = [];
            var skipped = [];
            for (var i = 0; i < results.length; i++) {
              var r = results[i];
              if (!r || r.ok !== true) failed.push(names[i]);
              else if (r.skipped) skipped.push(names[i]);
              else migrated++;
            }
            if (failed.length > 0) {
              console.warn('[DataDir] migrateData 部分失败: ' + failed.join(', ') + '（目标残留请手动清理）');
              return { ok: false, code: 'COPY_FAILED', error: AEI18n.t('迁移失败: ') + failed.join(', ')
                + (replaced > 0 ? AEI18n.t('（覆盖模式：目标目录已先删除 ') + replaced + AEI18n.t(' 项，源目录未动，可重试保存）') : ''),
                migrated: migrated, failed: failed, excluded: excluded, skipped: skipped, replaced: replaced };
            }
            // 不在代码里自动删旧目录（太危险），用户确认后手动清理
            console.log('[DataDir] migrateData 完成 ' + migrated + ' 项，未迁移 ' + (excluded.length + skipped.length) + ' 项'
              + (excluded.length + skipped.length ? ': ' + excluded.concat(skipped).join(', ') : '')
              + (replaced > 0 ? '，覆盖前删除目标 ' + replaced + ' 项' : '') + '，旧目录保留（请手动删除）: ' + oldDir);
            // 迁移收尾把复制过来的库索引里的旧根路径改写成新根——
            // 这是「换数据目录 → 条目翻倍」的唯一预防点（见 rebaseLibraryIndexPaths 注释）。
            // 重写失败不阻断迁移（数据已复制完成），但如实回执，由面板提示用户核对。
            return rebaseLibraryIndexPaths(oldDir, newDir).then(function (rb) {
              var res = { ok: true, migrated: migrated, failed: [], excluded: excluded, skipped: skipped, replaced: replaced, indexRebase: rb };
              if (rb && rb.ok === false) {
                res.warn = '库索引路径重写失败（' + (rb.failed || []).join((typeof AEI18n !== 'undefined' && AEI18n.punct ? AEI18n.punct('、', ', ', '、') : '、')) + '）：换目录后这些库可能出现重复条目，重载后请核对或重建索引';
                console.warn('[DataDir] ' + res.warn);
              }
              return res;
            });
        });
      }
    });
  }

  // ---- 热盒主题导出：把扩展主题写为 <数据目录>\hotbox\theme.json ----
  // 原生 AEGP 热盒浮窗（AS_Hotbox.aex）读不到 CEP 主题变量，只能读 theme.json。
  // 面板在启动/设置变更时把当前主题的关键不透明色导出，供热盒按扩展主题变色。

  // 解析 "#rrggbb" / "rgb()" / "rgba()" 为 [r,g,b]；其它（渐变等）返回 null
  function _hexToRgb(v) {
    if (typeof v !== 'string') return null;
    v = v.trim();
    var m = /^#([0-9a-fA-F]{6})$/.exec(v);
    if (m) {
      return [
        parseInt(m[1].substr(0, 2), 16),
        parseInt(m[1].substr(2, 2), 16),
        parseInt(m[1].substr(4, 2), 16)
      ];
    }
    m = /^rgba?\(([^)]+)\)$/.exec(v);
    if (m) {
      var parts = m[1].split(',').map(function (x) { return parseFloat(x); });
      if (parts.length >= 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
        return [parts[0], parts[1], parts[2]];
      }
    }
    return null;
  }
  function _toHex(c) {
    return '#' + c.map(function (n) {
      n = Math.round(Math.min(255, Math.max(0, n)));
      return ('0' + n.toString(16)).slice(-2);
    }).join('');
  }
  // 单通道/通道混色：a*(1-t)+b*t（t 向 b 偏移；产出不透明色，热盒 colorkey 安全）
  function _blend(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function _darken(c, f) {
    return [c[0] * (1 - f), c[1] * (1 - f), c[2] * (1 - f)];
  }

  // 由扩展主题对象（含 surface1/border/textMain/textMuted/accent/btnBg 等预设字段）构建热盒主题色。
  // 派生色（inputBg/rowHover/edge/borderDim/accentSoft）从基色派生，保持与 C++ 默认值同一比例。
  function buildHotboxTheme(theme) {
    var D = (global.AE_THEME_PRESETS && global.AE_THEME_PRESETS.default) || {};
    theme = theme || {};
    var pick = function (k) { return _hexToRgb(theme[k] != null ? theme[k] : D[k]); };
    var background = pick('surface1') || [26, 30, 36];
    var border = pick('border') || [53, 58, 68];
    var text = pick('textMain') || [240, 242, 245];
    var muted = pick('textMuted') || [122, 128, 144];
    var accent = pick('accent') || [251, 191, 36];
    var centerFill = pick('btnBg') || [42, 48, 56];   // 中心圆比表面亮一档
    return {
      background: _toHex(background),
      inputBg: _toHex(_darken(background, 0.35)),      // 输入区比表面更暗（凹陷感）
      border: _toHex(border),
      centerFill: _toHex(centerFill),
      rowHover: _toHex(_blend(background, accent, 0.06)),  // hover：强调色 6% 预混表面
      text: _toHex(text),
      muted: _toHex(muted),
      edge: _toHex(_blend(text, muted, 0.6)),             // 调暗的白色描边（介于 muted/text）
      borderDim: _toHex(_blend(border, text, 0.05)),      // 非选中弧段描边（比 border 稍亮）
      accentSoft: _toHex(_blend(background, accent, 0.12)), // 选中填充：强调色 12% 预混表面
      accent: _toHex(accent)
    };
  }

  // 写入当前主题到热盒 theme.json；返回是否成功（失败静默，热盒用内置默认色）。
  function writeHotboxTheme(theme) {
    if (typeof AEFS === 'undefined' || typeof AEFS.writeFileSync !== 'function') return false;
    var dir = getDataDir();
    var dataRoot = (dir && dir.dir) || _getUserDataDir();
    if (!dataRoot) return false;
    if (typeof AEFS.mkdirSync === 'function') {
      try { AEFS.mkdirSync(dataRoot + '\\hotbox'); } catch (_) {}
    }
    try {
      // .tmp→rename 原子写（AEGP 读取侧只见完整 JSON，半截文件按内置默认色兜底）
      return _atomicWriteAefs(dataRoot + '\\hotbox\\theme.json',
        JSON.stringify(buildHotboxTheme(theme), null, 2));
    } catch (e) {
      console.warn('[DataDir] writeHotboxTheme 失败: ' + (e && e.message || e));
      return false;
    }
  }

  // ---- 热盒热键：面板读配置 / 写变更请求（AEGP 是 config.json 唯一写者） ----
  // 面板不直接改 config.json（消灭双写漂移）：写入 hotkey-request.json 请求文件，
  // 由 AEGP IdleHook（AE 空闲时）处理：hotkey_reload 三级回退 + 按实际生效组合写回，
  // 处理完删除请求文件（文件消失 = 应答信号，面板轮询感知）。

  // 读 config.json 的 hotkey 字段 → {mods, vk}；无文件/解析失败返回 null
  function readHotboxHotkey() {
    if (typeof AEFS === 'undefined' || typeof AEFS.readFileSync !== 'function') return null;
    var dir = getDataDir();
    var dataRoot = (dir && dir.dir) || _getUserDataDir();
    if (!dataRoot) return null;
    try {
      var raw = AEFS.readFileSync(dataRoot + '\\hotbox\\config.json');
      if (!raw) return null;
      var cfg = JSON.parse(raw);
      var hk = cfg && cfg.hotkey;
      if (!hk || typeof hk.mods !== 'number' || typeof hk.vk !== 'number') return null;
      return { mods: hk.mods, vk: hk.vk };
    } catch (e) {
      return null;
    }
  }

  // 写热键变更请求 {mods, vk}（AEGP 处理后删除文件）；返回是否写入成功
  function writeHotboxHotkeyRequest(mods, vk) {
    if (typeof AEFS === 'undefined' || typeof AEFS.writeFileSync !== 'function') return false;
    var dir = getDataDir();
    var dataRoot = (dir && dir.dir) || _getUserDataDir();
    if (!dataRoot) return false;
    if (typeof AEFS.mkdirSync === 'function') {
      try { AEFS.mkdirSync(dataRoot + '\\hotbox'); } catch (_) {}
    }
    try {
      // .tmp→rename 原子写（AEGP IdleHook 只见完整请求 JSON，半截文件解析失败丢请求）
      return _atomicWriteAefs(dataRoot + '\\hotbox\\hotkey-request.json',
        JSON.stringify({ mods: mods, vk: vk }));
    } catch (e) {
      console.warn('[DataDir] writeHotboxHotkeyRequest 失败: ' + (e && e.message || e));
      return false;
    }
  }

  // 请求文件是否存在（保存后的反馈轮询用：消失 = AEGP 已处理）
  // 请求文件路径单点（面板轮询要用同一个路径做三态复核；路径拼法只此一处内联）
  function hotboxRequestPath() {
    var dir = getDataDir();
    var dataRoot = (dir && dir.dir) || _getUserDataDir();
    if (!dataRoot) return '';
    return dataRoot + '\\hotbox\\hotkey-request.json';
  }

  function hotboxRequestExists() {
    if (typeof AEFS === 'undefined' || typeof AEFS.existsSync !== 'function') return false;
    var p = hotboxRequestPath();
    if (!p) return false;
    try {
      return !!AEFS.existsSync(p);
    } catch (_) {
      return false;
    }
  }

  // ---- AEFS copyDir 封装（日志 + .gitkeep 过滤） ----

  function _copyDirAefs(srcDir, dstDir) {
    return AEFS.copyDir(srcDir, dstDir).then(function (ok) {
      console.log('[DataDir] _copyDirAefs: ' + srcDir + ' → ' + dstDir + ' ok=' + ok);
      return ok;
    });
  }

  // ---- seed: 首次启动时把种子数据拷进数据目录 ----

  // 种子源 = 扩展目录/client/seed/
  function _getSeedRoot() {
    try {
      if (typeof window !== 'undefined' && window.__ext_root) {
        return window.__ext_root.replace(/\//g, '\\') + '\\client\\seed';
      }
    } catch (_) {}
    return '';
  }

  function seedDataDir(targetDir) {
    var seed = _getSeedRoot();
    var dst = (targetDir || '').replace(/\//g, '\\');
    console.log('[DataDir] seedDataDir — seed 源: ' + (seed || '(empty)') + ', 目标: ' + (dst || '(empty)'));
    if (!seed || !dst) {
      console.warn('[DataDir] seedDataDir 跳过 — seed 或 dst 为空');
      return Promise.resolve({ ok: false, error: AEI18n.t('路径不可用') });
    }

    // seed 子目录 —— 按文件来判定：不再用 isEmptyDir 整目录判空门。
    // 判空门的漏洞：非空目录里缺的**单个文件**永远补不上（`ae_tools.json` 被删而 `ae-tools/`
    // 还有别的文件时，AE 工具模块整体不可用，面板只回泛化提示）。AEFS.copyDir 自身就是
    // **逐文件 exists 判定**（已有跳过、不覆盖同名，bridge 与回退链两路同语义）——正是
    // 「只补缺失」；失败判定沿用（failed>0 / 遍历失败 → ok:false，不假成功）。
    var subdirs = ['skills', 'memories', 'ae-tools', 'agent', 'effects'];
    return Promise.all(subdirs.map(function (sub) {
      var dstSub = dst + '\\' + sub;
      return _copyDirAefs(seed + '\\' + sub, dstSub).then(function (ok) {
        console.log('[DataDir] seed sub=' + sub + ' copyOk=' + ok);
        if (ok) return { sub: sub, ok: true }; // 已有文件被 copyDir 逐文件跳过 → 仍算成功
        // 拷贝失败（部分文件失败/通道失败/源目录遍历失败）不得假成功：
        // 仍尝试确保目标目录存在（空种子场景），但 mkdir 必须 await 且结果计入失败明细。
        if (typeof AEFS.mkdir !== 'function') {
          console.warn('[DataDir] seed sub=' + sub + ' 拷贝失败且 AEFS.mkdir 不可用');
          return { sub: sub, ok: false, reason: 'copy-failed', mkdirCreated: false };
        }
        return AEFS.mkdir(dstSub).then(function (mkOk) {
          console.log('[DataDir] seed sub=' + sub + ' copyFail, mkdir=' + mkOk);
          return { sub: sub, ok: false, reason: 'copy-failed', mkdirCreated: !!mkOk };
        }, function (err) {
          console.warn('[DataDir] seed sub=' + sub + ' mkdir 异常: ' + (err && err.message || err));
          return { sub: sub, ok: false, reason: 'copy-failed', mkdirCreated: false };
        });
      });
    })).then(function (results) {
      var seeded = 0;
      var failures = [];
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        if (r && r.ok) seeded++;
        else failures.push(r || { sub: subdirs[i], ok: false, reason: 'unknown', mkdirCreated: false });
      }
      console.log('[DataDir] seedDataDir 完成 — ' + seeded + '/' + subdirs.length + ' 个子目录已 seed'
        + (failures.length ? '，失败 ' + failures.length + ' 个: ' + failures.map(function (f) { return f.sub; }).join(', ') : ''));
      // ok 必须反映真实结果：任一子目录失败即 false（无论成败恒 true 时日志会谎报已播种）
      var out = { ok: failures.length === 0, count: seeded };
      if (failures.length) out.failures = failures;
      return out;
    });
  }

  global.AEShared = global.AEShared || {};
  global.AEShared.initDataDir = initDataDir;
  global.AEShared.seedDataDir = seedDataDir;
  global.AEShared.resolveDataDir = resolveDataDir;
  global.AEShared.getDataDir = getDataDir;
  global.AEShared.syncDataDirSetting = syncDataDirSetting;
  // Bridge 恢复/重连后强制重同步数据根（同值也重发；见 _syncDataDirToBridge force）
  global.AEShared.resyncDataDirToBridge = resyncDataDirToBridge;
  global.AEShared.migrateData = migrateData;
  // 数据根可用性探测（面板启动后一次；不可用时给出可操作提示——见函数注释）
  global.AEShared.probeDataRoot = probeDataRoot;
  // 目录身份判定（面板保存链据此区分「同一目录书写差异 / 互为父子 / 真换目录」，
  // 与数据层 migrateData 内的判定同一实现——单一真相源）
  global.AEShared.classifyDataDirMove = classifyDataDirMove;
  // 九续：迁移收尾的库索引路径重写（导出便于单测直接驱动；migrateData 内部已自动调用）
  global.AEShared.rebaseLibraryIndexPaths = rebaseLibraryIndexPaths;
  // 数据根相对路径的单一实现源（写盘前 toDataRel*、读回时 fromDataRel*）
  global.AEShared.toDataRelPath = toDataRelPath;
  global.AEShared.fromDataRelPath = fromDataRelPath;
  global.AEShared.toDataRel = toDataRel;
  global.AEShared.fromDataRel = fromDataRel;
  // 目标数据根探测（面板保存链据此弹「是否覆盖」确认，见 main.js 保存处理器）
  global.AEShared.inspectTargetData = inspectTargetData;
  global.AEShared.writeDataDirPointer = writeDataDirPointer;
  global.AEShared.buildHotboxTheme = buildHotboxTheme;
  global.AEShared.writeHotboxTheme = writeHotboxTheme;
  global.AEShared.readHotboxHotkey = readHotboxHotkey;
  global.AEShared.writeHotboxHotkeyRequest = writeHotboxHotkeyRequest;
  global.AEShared.hotboxRequestExists = hotboxRequestExists;
  // 请求文件路径单点（面板热键轮询终止前用它做三态复核，避免 existsSync 折叠误报）
  global.AEShared.hotboxRequestPath = hotboxRequestPath;
  // 多实例标记读取/清理（不支持多实例；bridge.js 在鉴权不符/反复断线时读）
  global.AEShared.MULTI_INSTANCE_MARKER_FRESH_MS = MULTI_INSTANCE_MARKER_FRESH_MS;
  global.AEShared.getMultiInstanceMarkerPaths = getMultiInstanceMarkerPaths;
  global.AEShared.readMultiInstanceMarkerSync = readMultiInstanceMarkerSync;
  global.AEShared.readFreshMultiInstanceMarkerSync = readFreshMultiInstanceMarkerSync;
  global.AEShared.clearMultiInstanceMarkerSync = clearMultiInstanceMarkerSync;
})(window);

