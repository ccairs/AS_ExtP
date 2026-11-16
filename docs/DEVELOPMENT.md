# AS_ExtP 开发者文档

**简体中文** | [English](DEVELOPMENT.en.md) | [日本語](DEVELOPMENT.ja.md) | [Deutsch](DEVELOPMENT.de.md) | [한국어](DEVELOPMENT.ko.md) | [Français](DEVELOPMENT.fr.md) | [Русский](DEVELOPMENT.ru.md)

面向要读源码、改代码或自行编译原生组件的人。安装与使用见 [README.md](../README.md)。

本文档面向二次开发：依次为技术架构、环境准备与校验、部署、本地化（Localization）、原生组件编译与 Hotbox 开发资料。

第三方组件许可、素材来源与分发口径见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)（随源码树与 Release 完整包分发）；本项目的 MIT 许可见 [LICENSE](../LICENSE)。

## 1. 技术架构

AS_ExtP 是 **CEP 面板（CEF / Chrome 88） + 本地 Node Bridge** 架构：

```
CEP 面板 (CEF, file://)
  │  8 个功能模块 + features（快速执行栏 / 桌宠 / 外接授权指示器）
  │  共享/基础层：AEFS · Bridge · ToolRegistry · AST 门（PromptBuilder 在 client/llm/，ContextManager 在 client/modules/agent/engine/，容器上下文在 client/core/）
  ├── CSInterface.evalScript()  ──►  AE 引擎（host.jsx + host/api/*.jsx）执行 ExtendScript
  ├── Node Bridge (127.0.0.1:9877, HTTP + WebSocket)
  │     ├─ 文件系统（全读全写，含二进制通道）
  │     ├─ 外部 MCP 进程管理
  │     └─ /mcp 端点（外接模式的 Streamable HTTP 传输）
  └── 外接模式：外部 Agent ⇄ stdio / HTTP ⇄ Bridge relay ⇄ 面板 ⇄ AE
```

- **文件系统（AEFS）**：`client/shared/aefs.js` 提供统一文件读写，采用 **Bridge → cep.fs → ExtendScript** 多层回退，并针对路径做了多层安全检查（拒绝 `%`、控制字符、`..` 穿越、非绝对路径、DOS 设备名；写 / 删操作限定在安全目录白名单内）。
- **AST 编译门**：所有由 AI 生成或用户保存的脚本在执行前都先经一条统一的静态编译门——ExtendScript 方言预处理 → acorn（ES3）解析 → 类型与成员白名单校验 → 重发射执行。校验与执行的是同一份代码，不存在「校验后改写」的时间窗。四个入口（Agent 工具调用、预览区、JSON 工具定义、脚本树 / 快速执行栏）全部收口于此，高危形态在门侧拦截并回喂模型改写；可在「Agent 模块设置 → AST 门能力配置」中查看通道信任、能力域开关与白名单增补表。其中脚本树 / 快速执行栏（`user-library`）走审计模式：门只产出危险清单，不改写代码（见 `client/modules/ast-gate/run.js`）。
- **数据目录**：扩展根目录只读，运行数据存于 `%APPDATA%\Adobe\CEP\extensions\AS_ExtP`（脚本、技能、记忆、工具、效果、预设等）。可在全局设置里改到自定义位置：切换＝**整份复制**（目标已含数据会先弹覆盖确认，确认后先删目标数据再拷贝），收尾会把复制过来的**库索引**（`assets/<库>/*.json`）里以旧根开头的绝对路径**重写为新根**——否则新目录启动时按盘面扫描会把同名文件当「未登记」重复入库（预设 / 工程素材有重复入库案例）；旧目录不自动删除，需用户核对后自行清理。**新增库时注意**：索引里不要存库内文件的绝对路径（存相对路径，或运行时按数据目录现算）；确需存绝对路径的，迁移收尾必须做同样的重写（见 `client/shared/dataDir.js` 的 `rebaseLibraryIndexPaths`）。
- **提示词总线**：给 LLM 的最终提示词经四层拼装（System Prompt 骨架 → PromptBuilder 管线 → 历史消息注入 → User Prompt 包装），各模块通过标准注入点参与，不直接拼接字符串。
- **Node Bridge**：服务于文件操作与 MCP 进程管理，空闲自动退出，面板开启时心跳保活。外接模式的 HTTP 端点与 stdio 入口共用同一套协议核心，工具调用统一经面板串行执行（AE 脚本引擎单线程）。
- **诊断日志**：面板 / Bridge / 宿主 / 原生组件各进程日志统一 ISO 时间戳与单文件体积上限（Bridge 错误行另带 `[ERR]` 标记）；导出诊断包时统一脱敏、并按签名折叠重复行（同签名达到阈值只保留首条，标注总次数与时间跨度），可在全局设置导出。

### AEFS 例外清单

面板侧（CEP）文件 I/O 一律走 AEFS；全仓复查后，例外集中在 host / ExtendScript 侧，共**两类七处文件删除调用点**（面板侧 JS 零例外）：

1. **启动链自清理（5 处，结构上不可能走 AEFS）**：`host/host.jsx` 的 `_sweepHandoffLeftovers`（清扫无主交接 token、vbs 与多实例探测脚本 `.axd`）、`startBridge` 尾部删 `vbsFile`、`_runAxDetectionProbe` 删本次写的 `.axd` 探测脚本、`_clearMultiInstanceMarker` 删 `ae_extp_multi_instance.json`、`_writeHostLoadErrors` 在无失败时删握手文件——AEFS 是面板侧模块、删接口依赖桥 / CEP，而这些调用跑的时机正是「桥还没有」或启动自检的收尾阶段。路径 = 数据目录 `temp/handoff`（兜底系统临时目录），删的都是启动链自产文件（交接 token / vbs / `.axd` 探测脚本、多实例标记、上次加载错误报告）；防线 = 精确文件名正则、只删文件（跳过同名目录），清扫项只回收 `mtime` 超过 10 分钟的残留。
2. **导出流程「清旧再拷」（2 处，时序上不宜走 AEFS）**：`host/api/projectAssetApi.jsx` 的 `exportWholeProject` / `exportCompOrLayer` 各一处，重新复制同名 footage 前清掉包内旧副本。删除点在 ES 侧流程中间（copy 之前），交给面板会引入「清理与导出之间的竞态」；故保留 host 侧删除，但删前用 `_ensureUnderRoot(dstPath, footageDir.fsName)` 复刻 AEFS 的 `_checkPath` 与容器判定（拒 `%`、控制字符、引号、DOS 设备名、`..` 段；必须是 footageDir 子路径），越界只记日志不删。

## 2. 环境准备与校验

> **两种获取方式的前提不同**：**Release 完整包开箱即用**（已含 Node 运行时、npm 依赖与预编译 `.aex`），解压后双击 `tools\install.bat` 即完成部署，本节可以跳过；**源码克隆不是开箱即用**，需要下面的 Node、`npm ci`、`check-env.bat`（下载 Node / ffmpeg）以及按需的原生组件编译。

- Node.js **≥ 20.18**（面板侧 CEF 为 Chrome 88，无 Node 运行时：面板内 `require` / `process` 不存在，文件 I/O 一律走 AEFS）
- 装依赖：`npm ci`；或双击 `tools\check-env.bat`（逐项体检 Node、依赖、ffmpeg 与 AE 版本并给出补齐指引）
- `npm run lint` — ESLint 检查（`eslint.config.js`）
- `npm run audit:theme` / `npm run audit:family` — 主题硬编码与失效模式族审计（CI 卡口）
- 公开仓 CI（`.github/workflows/ci.yml`）分两个作业：`lint-and-audits` 跑 `npm ci` → `lint` → 两项审计；`release-tree-check` 在未装依赖的干净检出上跑 `node tools/release-check.js --public . --public-only`（公开树零二进制、不含 `node_modules` / `vendor`、NOTICES 完整）。任一步失败即红

## 3. 部署到 CEP

两个脚本分工不同：

- **首次安装 / 普通用户**：双击 `tools\install.bat`。自动探测已安装的 AE、下载 Node 与 ffmpeg、写 `PlayerDebugMode`，并在检测到 `deploy\Plug-ins\*.aex` 时自动部署原生组件。
- **开发期更新部署**：改了 `host` / `client` / `CSXS` 或原生件后，双击 `tools\deploy.bat`（需管理员权限，把这几项拷到 `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\AS_ExtP`）。它不做下载与注册表设置，要求 `vendor\` 已存在，缺失时会提示先跑 `tools\check-env.bat`。

两个脚本都会在 `vendor\node_modules` 缺失时，从源码目录的根 `node_modules` 复制补齐——部署态的 Bridge 从 `vendor\node_modules` 解析依赖（docx / xlsx / pdf 附件解析）。

## 4. 本地化（Localization）

面板界面由一个小型运行时加生成的语言包实现本地化。中文源文即键（`t('源文')`），因此未翻译的字符串会回退为中文源文而不是消失。

> `i18n/`、`tools/i18n/` 与 `tests/` 只存在于维护者仓库，不进公开树；公开树只带 `client/shared/i18n/locales/` 下生成的语言包。以下命令面向维护者。

### 语言选择

- 全局设置 → **界面语言**（`globalUiLocale`）：与其他全局设置一起存在 `uiLocale` 下，并镜像到 `localStorage['ae_ui_locale']`，后者是启动时的取值来源。
- 可选值：**跟随 After Effects 界面语言**（`auto`）、简体中文（`zh-CN`）、English（`en-US`）、日本語（`ja-JP`）、Deutsch（`de-DE`）、한국어（`ko-KR`）、Français（`fr-FR`）、Русский（`ru-RU`）。
- `auto` 由 CEP 的 `getHostEnvironment().appLocale` 解析，取不到时回退 `navigator.language`。已知但不支持的宿主语言解析为 `en-US`；无法读取时保持 `zh-CN`。
- 保存为其他值会重新加载面板（设置行有说明），无需其他步骤。

### 文件

| 路径 | 作用 |
| --- | --- |
| `i18n/keys.json` | 运行时查询到的全部键（`AEI18n.t(...)` / `AEI18n.html(...)` 的字符串字面量，加上 `client/index.html` 的文本），由 `scan-keys.js` 生成 |
| `i18n/translations/en-US.json` | `en-US` 的译文（源文 → 译文） |
| `client/shared/i18n/locales/en-US.js` | 生成的语言包，静态加载 |
| `client/scripts.manifest.js` | 加载顺序：语言包排在 i18n 组首位，通过 `AEI18nPending` 把字典交给 `i18nCore` |
| `client/shared/i18n/i18nCore.js` | 运行时：`t` / `html` / `err`、语言解析、静态 DOM 翻译 |
| `client/shared/i18n/i18nHtml.js` | 收集并翻译 HTML 模板内的文本节点与白名单属性 |
| `client/shared/i18n/errorCodes.js` | 错误码消息表 |

`i18n/` 与 `tools/i18n/` 只在开发侧使用，不进公开树；公开树只带 `client/shared/i18n/locales/` 下的生成语言包。

### 命令

```bash
node tools/i18n/scan-keys.js                 # 重新扫描源码树 → i18n/keys.json
node tools/i18n/build-locale.js en-US        # 校验译文 → client/shared/i18n/locales/en-US.js
node tools/i18n/check-coverage.js en-US      # 门禁：键齐全、无多余键（不一致时退出码 1）
```

`build-locale.js` 在译文为空、`{placeholder}` 集合与源文不一致、或键不在 `keys.json` 中时不写文件并以退出码 1 结束。改完界面文案后，在维护者仓库按上述顺序运行这三条命令，再跑 `npm test` 与 `npm run lint`。

### 支持的语言

`zh-CN`（源文）、`en-US`、`ja-JP`、`de-DE`、`ko-KR`、`fr-FR`、`ru-RU`。运行时接受全部七个 id；面板的语言选择器固定列出七项，与实际随包分发的语言包无关。`en-US`、`ja-JP`、`de-DE`、`ko-KR`、`fr-FR`、`ru-RU` 均完整（各 3450 键，覆盖率 100%）。

### 范围与限制

- **运行环境事实行（`ENV_LINE`，由 `client/modules/agent/engine/prompts.js` 的 `envLine()` 生成）**：系统提示词写明宿主 AE 的界面语言（`中文版` / `英文版` / `日文版` / `德文版` / `韩文版` / `法文版` / `俄文版`），取值来自 `getHostEnvironment().appLocale`；唯一来源在 `client/modules/agent/engine/prompts.js`。它描述宿主事实，与面板界面语言、模型回答语言都无关。
- **ExtendScript 消息**：`host/*.jsx` 抛出的错误保持中文。它们经 `CSInterface.evalScript()` 以纯字符串传递，不参与语言协商，因此英文界面下这些消息仍显示中文；只有面板侧的错误码映射是本地化的。
- **AST 门诊断**：`client/modules/ast-gate/` 的 `error.reason` / `error.alternative` 保持中文——它们是回喂给 LLM 的自纠输入（`llmText`）。非源文语言下，面板表面（状态栏、运行错误卡、快速执行栏）显示 `client/shared/i18n/gateReasons.js` 里的本地化类别句；仅当界面语言为简体中文时才显示中文原始详情。
- **安装脚本**：`tools/install.bat`、`tools/check-env.bat` 与 `tools/deploy.bat` 只输出 ASCII 英文（脚本切到 `chcp 437`）。脚本注释可以是中文；公开树保留技术性注释，叙述性注释经发布注释映射改写或删除。
- **原生组件界面**：`native/hotbox`（AS_Hotbox）与 `native/glsl-host`（AS_Effect Host）的用户可见文字——热盒过滤/设置、效果参数名、About、错误帧、文件对话框——跟随 **After Effects 宿主界面语言**（`PF_AppGetLanguage`），与面板的界面语言设置相互独立；宿主语言不受支持时回落英文，读取不到宿主语言时回落中文。日志与内部诊断不翻；含技术 token 的警告（如 `[uniform limit reached]`）保留英文，其余面向用户的告警已本地化。

## 5. 原生组件编译

两个原生组件都是 C++ / CMake 工程，**需要 Visual Studio 2022（含 MSVC）与 Adobe After Effects SDK**——SDK 依其许可不随仓库分发，需自行从 Adobe 获取。

### 5.1 GLSL 效果宿主（`native/glsl-host/`）

```powershell
cmake -S native/glsl-host -B native/glsl-host/build -DAEFX_SDK_PATH="<AE SDK 路径>"
cmake --build native/glsl-host/build --config Release
```

### 5.2 AE Hotbox（`native/hotbox/`）

```powershell
cmake -S native/hotbox -B native/hotbox/build -DAEFX_SDK_PATH="<AE SDK 路径>"
cmake --build native/hotbox/build --config Release
```

产物默认输出到 `deploy/Plug-ins/`（可用 `-DAE_PLUGIN_OUTPUT=<目录>` 覆盖）。把 `.aex` 复制到 AE 的 `Support Files\Plug-ins\` 目录并**完全退出重启 AE** 后生效。原生逻辑的单元测试用 `ctest` 在构建目录内运行，不需要 AE 参与。

## 6. Hotbox 开发资料

> 本节为 Hotbox 的构建 / 部署 / 排障说明；用户用法见 README「原生组件 → AE Hotbox」一节。

#### 构建 .aex

前置：AE 2023+ SDK、Visual Studio 2022、CMake 3.20+。

```powershell
# 在仓库根目录
cmake -S native/hotbox -B native/hotbox/build `
  -DAEFX_SDK_PATH="<AE SDK 路径>" `
  -DAE_PLUGIN_OUTPUT="<仓库>\deploy\Plug-ins"
cmake --build native/hotbox/build --config Release
```

产物：`deploy\Plug-ins\AS_Hotbox.aex`。

#### 部署到 AE

1. **完全退出 AE**（新插件必须重启才加载）。
2. 复制 `AS_Hotbox.aex` 到 AE 的 `Support Files\Plug-ins\` 目录：

```powershell
Copy-Item "<仓库>\deploy\Plug-ins\AS_Hotbox.aex" `
  "<AE 安装目录>\Support Files\Plug-ins\" -Force
```

3. 同时确保 CEP 扩展已部署（`tools\deploy.bat` 或 `tools\install.bat`）：热盒读扩展数据目录里的脚本与预设索引，并直读 AE 自己的预设目录（定位规则见下「数据来源」）。
4. 启动 AE。

#### 验证加载

启动 AE 后查看日志 `<数据目录>\temp\logs\as_hotbox.log`，应出现：

```
EntryPointFunc OK
window: init ok
hotkey: registered Alt+Q
```

若热键被占用，日志会出现 `hotkey: configured ... in use, fallback default`，回退到 `Alt+Q`；若 `Alt+Q` 也被占用，则 `hotkey: default Alt+Q also failed`，插件仍加载但热键不可用（需在设置面板改键）。

---


#### 配置文件

配置存储在 `<数据目录>\hotbox\config.json`：

```json
{
  "gesture": {
    "slots": [
      null,
      {"type":"effect","key":"ADBE Gaussian Blur 2","name":"高斯模糊"},
      null,
      null,
      null,
      {"type":"script","key":"C:\\abs\\path\\script.jsx","name":"脚本"}
    ]
  },
  "hotkey": {"mods": 1, "vk": 81},
  "releaseExecute": true,
  "releaseStay": false
}
```

- `slots`：与手势环 6 弧段一一对应（`null` = 动态槽）。正上（截图入口）与正下（设置入口）为专用弧段，不参与槽位绑定；设置面板的 4 行对应其余 4 段（左上 / 左下 / 右上 / 右下），弧段与数组下标的对应随布局固定。
- `hotkey.mods`：位标志，1=Alt 2=Ctrl 4=Shift（与 Win32 `MOD_*` 一致）。
- `hotkey.vk`：虚拟键码（如 81 = 'Q'）。
- `releaseExecute`：松手是否执行选中弧段（设置行5，默认 true）。
- `releaseStay`：松手是否停留浮窗（设置行6，默认 false；用法见 README「AE Hotbox」）。

最近使用列表存储在 `<数据目录>\hotbox\recent.json`。

> **数据目录**默认为 `%APPDATA%\Adobe\CEP\extensions\AS_ExtP`。

---

### 数据来源

热盒直接读本地文件（AEGP 与 AE 同进程；不依赖 bridge，也不要求扩展面板处于打开状态）：

| 数据 | 来源 | 说明 |
|------|------|------|
| 效果 | AEGP 原生枚举（`AEGP_EffectSuite4`） | AE 内存里的已安装效果表，与 Effects 菜单同源；取显示名 + matchName |
| 脚本 | `agent\scripts\` 递归 | `.jsx` / `.jsxbin` |
| 预设（扩展库） | `assets\presets\index.json` | 面板入库的 `.ffx`（实体在库目录内）；名称 + 文件夹 + ffx 路径 |
| 预设（AE 出厂） | `<AE>\Support Files\Presets\` 递归 | 与 AE 的 Effects & Presets 面板同源 |
| 预设（AE 用户） | `文档\Adobe\After Effects <版本>\User Presets\` 递归 | AE「保存动画预设」的落点；目录不存在即不纳入 |

- **预设三源合并**：优先级 = 扩展库 > AE 用户预设 > AE 出厂预设；去重键 = 小写名 + 文件字节数，即
  「同名同大小 = 同一预设副本」（面板入库是把 `.ffx` 逐字节复制进库，副本与来源同名同大小）。
  不能只按名去重：AE 出厂预设里真有同名不同内容的两条（如「百叶窗」191231/26526 字节、
  「放大」43417/75976 字节），只按名会吞掉真实条目。AE 侧条目只读不复制，应用走
  `layer.applyPreset(File)`，与库内预设同一条路径（因此 AE 预设也能绑到手势环槽位）。
- **库侧 size 以真实文件为准**：索引里的 `size` 是入库那一刻的快照，重载时按文件实际字节数校准；
  文件已不在（或路径指向目录）则按「未知」处理——不拿过时值去折叠 AE 侧同名同大小的真条目，
  否则删掉库内 `.ffx` 后热盒只剩一条必然应用失败的条目、可用的 AE 预设反被它顶掉。
- **归档条目不进热盒**：索引里 `archived=true` 的条目（实体已移入 `___archive__`，7 天后物理清理）
  与面板快捷栏同一口径地排除，避免它们顶掉 AE 侧的同名真条目。
- **AE 预设目录定位**：优先由插件自身模块路径推导（`<AE>\Support Files\Plug-ins\...` → 安装根），
  装在 MediaCore 等非标准位置时才回退问 AE 的 `app.path`（与扩展 `ae-tools` 的
  `getInstallPath` 同源）。两者都不可得时只用扩展库，其余功能不受影响。
- 效果列表在 AE 进程内枚举取得（不经 ExtendScript、不读磁盘索引）：新装插件无需生成任何缓存即可被搜索到。
- `ae-tools\effects_cache.json` 不再是效果列表的主数据源，仅当原生枚举返回空（AEGP 未就绪）时兜底。
- 刷新口径：数据源签名（已安装效果数 + `index.json` mtime + 脚本目录树 + 两个 AE 预设目录树）未变时，
  重复呼出直接复用内存里的列表与拼音索引；脚本/预设增删改、以及在 AE 里另存预设到用户预设目录，
  都会让签名失配并自动重载（无需重启 AE）。签名遍历在每次弹出时执行，出厂目录全量扫描只在签名失配时发生，
  二者成本与预设 / 脚本条目数线性相关，不随弹出次数累积。
- 插件加载后首次空闲（≥2s）预热一次数据（枚举 + 拼音索引），把首次加载成本移出按键路径。

#### 编码约束

- 项目内部路径与名称统一 UTF-8 窄串；文件打开一律走宽字符 API（`native/hotbox/src/data.h` 的 `utf8ToWide` 与 `log.h` 的宽路径调用）——窄 `char*` 路径会被系统按 ANSI/GBK 解释，含中文的路径会打不开。
- AE 的 AEGP `A_char` 串（效果名 / 分类）按 SDK 约定是系统 ANSI；单串无法判定编码，故成批数据先整批判定 ANSI / UTF-8 再解码（`data.h` 的 `isAnsiBatch` / `ansiToUtf8`）。新增数据来源必须沿用同一口径，勿把 `A_char` 直接当 UTF-8 或直接拼路径。

---

### 排障

#### 日志位置

`<数据目录>\temp\logs\as_hotbox.log` — 记录插件加载、热键注册、执行结果、错误信息。数据目录默认 `%APPDATA%\Adobe\CEP\extensions\AS_ExtP`（见「配置文件」一节）；改了数据目录，日志跟着走。

#### 常见问题

| 现象 | 排查 |
|------|------|
| 按热键无反应 | 查日志：`hotkey: registered ...` 是否成功；AE 是否前台（非前台不触发） |
| 热键被占用 | 日志出现 `hotkey: configured ... in use, fallback default`（回退默认组合）或 `hotkey: default Alt+Q also failed`；在设置面板录制新组合。若录制时按键**完全没反应**，说明该组合已被其他程序占用（系统级互斥，按键不会送达）：换组合或退出占用程序 |
| 浮窗提示"扩展未启动" | CEP 扩展未部署；运行 `tools\deploy.bat` 或在 AE 中打开 AS_ExtP 面板 |
| 搜索无结果 | 是否输入了关键词（空查询不列条目）；`agent\scripts\` 是否有脚本；`assets\presets\index.json` 是否存在 |
| 应用效果失败 | 是否有选中图层；合成是否打开 |
| 松手后浮窗不关闭 | 设置面板「松手停留」为开（config.json `releaseStay`）；Esc / 点击浮窗外部 / 再按热键关闭，或在设置面板置关 |
| 关闭 AE 崩溃 | 查日志 `DeathHook` 是否出现；查事件查看器 |
| 多显示器定位异常 | 浮窗按鼠标所在显示器工作区 clamp；副屏鼠标处应不越出副屏 |
| 中文输入异常 | 搜索框使用 Win32 EDIT 控件，IME 联想/候选可用；组合输入中按 Enter 不会提前执行 |

#### 重新部署流程

修改 C++ 代码后：

```powershell
# 1. 退出 AE
# 2. 重新构建
cmake --build native/hotbox/build --config Release
# 3. 复制 .aex 到 AE（覆盖）
Copy-Item "deploy\Plug-ins\AS_Hotbox.aex" "<AE 安装目录>\Support Files\Plug-ins\" -Force
# 4. 启动 AE（必须完全重启，任务管理器确认 AfterFX.exe 进程退出）
```

修改 ExtendScript（`host/api/effectApi.jsx` 等）后：

```powershell
# 运行 deploy.bat 更新 CEP 扩展目录的 host 文件
tools\deploy.bat
# AE 中无需重启，下次调用自动加载新脚本
```

---

### 技术架构

```
┌────────────────────────────────────────────────────────────┐
│ native/hotbox/  AEGP 插件（C++20 + MSVC，GeneralPlug）       │
│  ├─ 热键引擎   RegisterHotKey + 隐藏消息窗 ← WM_HOTKEY      │
│  │              → GetCursorPos 取鼠标坐标                    │
│  ├─ 浮窗       WS_POPUP + WS_EX_TOPMOST + 分层窗口透明       │
│  │              ├─ 手势模式：中心圆 + 弧段切片环（Direct2D）  │
│  │              └─ 搜索模式：长条搜索栏 + 线性列表 + 过滤下拉 │
│  ├─ 执行通道   AEGP_UtilitySuite6::AEGP_ExecuteScript        │
│  │              → effectApi.jsx / scriptRunner.jsx           │
│  └─ 数据层     进程内直接读文件（std::ifstream + GetFileAttributesW） │
└────────────────────────────────────────────────────────────┘
```

关键约束：
- 执行通道 `AEGP_ExecuteScript` 同步阻塞 AE 主线程 → 短脚本为主，执行中有状态提示。
- 数据读写不经过 bridge：插件在进程内直接读数据目录下的配置文件与脚本索引，bridge 只服务面板侧。
- 脚本执行一律走沙箱包装（`runScriptSandboxed`），不提供绕过开关。
