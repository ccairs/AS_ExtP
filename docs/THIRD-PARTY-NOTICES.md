# 第三方组件声明 / Third-Party Notices

**简体中文** | [English](THIRD-PARTY-NOTICES.en.md) | [日本語](THIRD-PARTY-NOTICES.ja.md) | [Deutsch](THIRD-PARTY-NOTICES.de.md) | [한국어](THIRD-PARTY-NOTICES.ko.md) | [Français](THIRD-PARTY-NOTICES.fr.md) | [Русский](THIRD-PARTY-NOTICES.ru.md)

AS_ExtP 以 MIT 许可发布（见 [LICENSE](../LICENSE)）。本文档列出本项目分发或调用的第三方组件及其许可。

**分发形态说明**：本项目有两种获取方式，第三方义务不同。**Release 完整包开箱即用**——内含预编译原生组件（`.aex`）、内置 Node.js 运行时与 npm 依赖，解压后双击 `tools\install.bat` 即可使用，不需要安装 Node、`npm ci` 或编译；分发该包时请连同本文档与相应许可文件一并提供。**源码仓库不含**上述二进制与依赖（体积与分发限制），克隆后需自行 `npm ci` 并用 `tools\check-env.bat` / `tools\install.bat` 补齐，原生组件需自行编译。FFmpeg 本项目**不分发**（Release 包与源码仓库均不含），由 `tools\check-env.bat` / `tools\install.bat` 从上游固定版本下载到本机。

## 一、二进制组件

### FFmpeg 8.1.2 — GPL-3.0-or-later（本项目不分发）

| 项 | 说明 |
| --- | --- |
| 获取方式 | **不由本项目分发**。`tools\check-env.bat` / `tools\install.bat` 从上游 Release 下载 `8.1.2-essentials_build` 到本机，下载前按钉死的 SHA-256（`db580001…`）校验 |
| 本机位置 | `vendor/ffmpeg/ffmpeg.exe`、`vendor/ffmpeg/ffprobe.exe`（源码仓库与 Release 包均不含） |
| 许可全文 | 上游 zip 内随附 `LICENSE.md` / `COPYING.GPLv3` / `COPYING.GPLv2` / `COPYING.LGPLv2.1` / `COPYING.LGPLv3`（以实际存在为准）。`tools\check-env.bat` / `tools\install.bat` 解压后会把它们连同 `SOURCE.txt`（下载地址、SHA-256、对应源码指引）保留在 `vendor/ffmpeg/`；本项目仍不分发该二进制，再分发时请连同这些文本与源码获取说明一并提供 |
| 来源与对应源码指引 | Gyan Doshi（`GyanD/codexffmpeg`）提供的 `8.1.2-essentials_build`（GitHub Release 标签 `8.1.2`），静态链接 libx264 / libx265 等 GPL 组件；该 Release 记录的上游源码提交为 `FFmpeg/FFmpeg@38b88335f9`，源码包见 ffmpeg.org 的 `ffmpeg-8.1.2.tar.xz` |
| 用途 | 以独立进程调用（命令行接口），用于素材库的视频转码与抽帧；未链接进 AS_ExtP 源码 |

> 本项目不参与该二进制的分发，不承担其 GPL 分发义务；脚本安装成功时会打印一行 GPL 提示，并把上游许可文本保留在 `vendor/ffmpeg/`。若你把含 ffmpeg 的目录再分发出去，需自行满足 GPL-3.0-or-later 的义务（附许可、提供对应源码）。

### Node.js 22.23.2 — MIT

| 项 | 说明 |
| --- | --- |
| 分发方式 | 随 Release 完整包分发（源码仓库不含；源码克隆请自装 Node ≥ 20.18） |
| 位置 | `vendor/node/node.exe` |
| 许可全文 | `vendor/node/LICENSE` —— 官方 `node-v22.23.2-win-x64.zip` 内的原件，含 Node 内置各组件的许可声明。安装脚本用钉死的 SHA-256 `1177b413…` 校验该发行包（`tools/install.bat`、`tools/check-env.bat`），该值与上游 `SHASUMS256.txt` 一致；包内 `node.exe` 与本目录的 `node.exe` 哈希一致（`0d0f5e39…`） |
| 用途 | 本地 Bridge 与 stdio MCP 服务器的运行时 |

## 二、npm 依赖（`vendor/node_modules/`，随 Release 完整包分发）

除下表标注 ※ 的包外，各包目录内均自带许可文件（※ 包的许可全文见下方附录）；下表为汇总，版本以 `package-lock.json` 为准。**无强制 GPL / AGPL / LGPL 依赖**（`jszip` 为 `MIT OR GPL-3.0-or-later` 双许可，本项目按 MIT 使用）。Release 完整包内含本目录与各包自带许可文件；源码克隆不含本目录，用 `npm ci` 依 `package-lock.json` 安装到根 `node_modules`，部署脚本（`deploy.bat` / `install.bat`）会复制到 `vendor/node_modules`。运行期由 `client/shared/ae-bridge.js` 把 `NODE_PATH` 指向 `vendor/node_modules`（`client/shared/ext-mcp-server.js` 同）；Node 的常规解析先命中就近的 `node_modules`，`NODE_PATH` 作兜底，因此源码克隆（根 `node_modules`）与部署态（只有 `vendor/node_modules`）都能解析依赖。`xmlbuilder` 10.1.1 以嵌套形式安装在 `vendor/node_modules/mammoth/node_modules/xmlbuilder/`（mammoth 自带），其余包在 `vendor/node_modules/` 顶层。

| 包 | 版本 | 许可 |
| --- | --- | --- |
| @wwek/xlsx | 0.20.3 | Apache-2.0 |
| @xmldom/xmldom | 0.8.13 | MIT |
| argparse | 1.0.10 | MIT |
| base64-js | 1.5.1 | MIT |
| bluebird | 3.4.7 | MIT |
| core-util-is | 1.0.3 | MIT |
| dingbat-to-unicode | 1.0.1 | BSD-2-Clause ※ |
| duck | 0.1.12 | BSD-2-Clause（上游字段只写 "BSD"，实文为两条款 BSD） |
| immediate | 3.0.6 | MIT |
| inherits | 2.0.4 | ISC |
| isarray | 1.0.0 | MIT ※ |
| jszip | 3.10.1 | MIT OR GPL-3.0-or-later（本项目按 MIT 使用） |
| lie | 3.3.0 | MIT |
| lop | 0.4.2 | BSD-2-Clause |
| mammoth | 1.12.1 | BSD-2-Clause |
| option | 0.2.4 | BSD-2-Clause |
| pako | 1.0.11 | MIT AND Zlib ※（包内只附 MIT 文本，Zlib 全文见附录） |
| path-is-absolute | 1.0.1 | MIT |
| process-nextick-args | 2.0.1 | MIT |
| readable-stream | 2.3.8 | MIT |
| safe-buffer | 5.1.2 | MIT |
| setimmediate | 1.0.5 | MIT |
| sprintf-js | 1.0.3 | BSD-3-Clause |
| string_decoder | 1.1.1 | MIT |
| underscore | 1.13.8 | MIT |
| unpdf | 1.8.0 | MIT；内嵌 Mozilla PDF.js 6.1.200（Apache-2.0）※ |
| util-deprecate | 1.0.2 | MIT |
| xmlbuilder | 10.1.1 | MIT |

※ = 上游包未附该许可的完整文本（或未随包附带），其许可全文见下方附录。`unpdf@1.8.0` 的 `dist/pdfjs.mjs` 是 Mozilla PDF.js 的 serverless 构建（内嵌版本 6.1.200），该部分按 Apache-2.0 授权；上游 `unpdf` 包只附自身 MIT 文本，未附 Apache-2.0 文本。

## 三、随源码树分发的第三方源码库

下列库以源码形式包含在公开仓库内；其中 **glad** 与 **PinIn4Cpp** 在构建期被静态编译进 Release 包的 `.aex`（即以二进制形态随 Release 分发），其许可文本随源码树提供，满足宽松许可「随副本保留版权与许可声明」的要求：

| 库 | 位置 | 版本 | 许可 | 许可文本 | 用途 |
| --- | --- | --- | --- | --- | --- |
| marked | `client/vendor/marked/` | 12.0.2 | MIT | 树内 `LICENSE` | Markdown 渲染 |
| Prism.js | `client/vendor/prism/` | 1.29.0（推定） | MIT | 树内 `LICENSE` | 代码高亮 |
| js-xss | `client/vendor/xss/` | 1.0.15（推定） | MIT | 树内 `LICENSE`；bundle 另内联 cssfilter（MIT），全文见附录 | HTML 消毒 |
| anime.js | `client/vendor/anime/` | 3.2.2 | MIT（© 2019 Julian Garnier；上游 min 文件头误写 2023） | 文件头注记；全文见附录 | 界面动画 |
| acorn（es3-parser） | `client/vendor/es3-parser/` | 8.18.0 | MIT（© 2012-2022 by various contributors） | `acorn.js` 文件内注记 + 来源 `README.md`（许可全文见附录） | AST 编译门的 ES3 解析器 |
| CSInterface.js | `client/vendor/CSInterface.js` | 8.0.0（精简实现） | Adobe SDK 许可协议（非 OSS）；文件保留 Adobe 版权头与版本号 | 树内 `CSInterface.LICENSE.pdf`（协议原件，见下） | CEP 宿主接口 |
| glad | `native/glsl-host/third_party/glad/` | 0.1.36（生成器） | MIT + Khronos Apache-2.0 | 树内 `LICENSE`（上游原件，含 glad / Khronos Specifications / EGL headers 三段）；`include/KHR/khrplatform.h` 自带 Khronos 许可原文 | OpenGL 加载器 |
| PinIn4Cpp | `native/hotbox/third_party/PinIn4Cpp/` | 1.5.8 | MIT（© 2025 KagiyamaHina） | 树内 `LICENSE`；`licenses/` 含 PinIn（© 2019 Juntong Liu）与 pinyin-data（© 2016 mozillazg）两份 MIT 文本 | 热盒拼音匹配 |
| json2（Crockford json2.js 改编） | `host/api/json2.jsx` | 无版本标注 | Public Domain | 文件头注记（公共领域，无许可文本义务） | ExtendScript 的 JSON polyfill（ES3 无原生 JSON） |
| Feather Icons / Lucide | `client/` 下 CSS `data:` SVG 与内联 `<svg>` | — | MIT（Feather，© 2013-2023 Cole Bemis）/ ISC（Lucide） | 全文见附录 | 界面内联图标（部分 path 逐字取自上游） |

「—」= 打包 min 文件内未标注版本号。**Prism / js-xss 的版本为推定**：Prism 以 `prism-core.min.js` 与上游 `prismjs@1.29.0` 官方 `components/prism-core.min.js` 逐字节比对确认（`prism-clike` / `prism-javascript` 与主题文件同官方一致）；js-xss 以 `xss.min.js` 的 SHA-256 `2072387B…3261E` 与上游 `xss@1.0.15` 官方产物一致确认，并以 bundle 含 `singleQuotedAttributeValue`（1.0.15 引入）、不含 `filterXSSWithResult`（1.0.16 引入）作为版本上下界佐证。其余版本均与文件内版本串 / `package-lock` 直接核对。

**Prism 本地改动**：`client/vendor/prism/prism-core.min.js` 与上游 1.29.0 有两处差异——`highlightAllUnder` 内改用函数入参容器代替钩子可改写的 `env.container`；文件末尾追加 `window.Prism=Prism;`（CEP 环境挂载全局）。改动不改变许可义务，升级 Prism 时需重新套用。

**CSInterface.js**：Adobe 版权（`Copyright (c) 2012-2017 Adobe Systems Inc.`），文件头声明允许按其随附的 Adobe 许可协议使用、修改与分发。该协议原文（`GenSDK_IHC-en_US-20120323_1224.pdf`，取自 Adobe CEP-Resources 仓库 `License/` 目录）已随树落位为 `client/vendor/CSInterface.LICENSE.pdf`（95,659 B，SHA-256 `32E81408…5383`），本项目按该协议随 CEP 扩展使用此文件。随树文件是按项目需要精简过的实现（357 行、16 个方法：`evalScript` / `getHostEnvironment` / `getSystemPath` / `getExtensionPath` / 事件注册等），并非 Adobe 官方发行版全文（官方 v8 约 1200 行，另含 `setPanelFlyoutMenu` / `updatePanelMenuItem` / `getExtensions` / `getNetworkPreferences` 等）；文件头版权与 `v8.0.0` 版本标识按上游原样保留，用以说明其接口与用法源自 Adobe CEP SDK。

除 CSInterface.js（Adobe 协议，非 OSS）外，其余库均为 MIT / BSD 类宽松许可；glad 另含 Khronos 部分的 Apache-2.0（同表已注明），与本项目的 MIT 许可兼容。

## 四、构建期依赖与编译产物中的 Adobe 内容（SDK 本体不分发）

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| Adobe After Effects SDK | Adobe SDK 协议 | 编译 `native/` 两个原生组件（GLSL 效果宿主 / AE 热盒）时需要，由构建者自行从 Adobe 获取；**SDK 本体与其许可文本不随源码仓库或 Release 包分发**，构建步骤见 [DEVELOPMENT.md](DEVELOPMENT.md) |
| 编译产物 `deploy/Plug-ins/*.aex` | 本项目构建产物；受 Adobe SDK 协议约束 | Release 完整包内含 `AS_Effect_Host.aex`（约 643 KB）与 `AS_Hotbox.aex`（约 1.5 MB）。构建期会把 SDK `Examples/Util` 的未修改示例源码（`AEFX_SuiteHelper.c`、`AEGP_SuiteHandler.cpp`、`MissingSuiteError.cpp`）作为编译单元编入，并静态链接 glad（MIT）与 PinIn4Cpp（MIT，含 pinyin-data 拼音数据）；这两个二进制不属于本项目 MIT 许可的适用范围。再分发或商业使用前，请自行确认与 Adobe 的协议条款（必要时联系 Adobe 开发者支持）。 |

> 除 `.aex` 外，Release 完整包内的其余内容（源码、Node.js、npm 依赖）均按本文件与各包 LICENSE 声明；`.aex` 是本文件范围内唯一由本项目编译的二进制产物（包内的 `vendor/node/node.exe` 为上游 Node.js 运行时，见第一节）。

## 五、非代码素材与内容来源

本项目随源码树分发的内容里有三块非代码资产；**不含任何第三方图库、字体或第三方音频素材**：

| 内容 | 位置 | 体积 | 来源 | 说明 |
| --- | --- | --- | --- | --- |
| 桌宠序列帧（16 个 PNG） | `client/features/deepseekPet/sprites/` | 约 108.7 MB | 项目作者用 AI 生成工具制作；`potHead` / `eat` 两件由仓库外的自制序列帧并入 | 原创角色动画 |
| 彩蛋视频 `appear.webm` | 同上 | 约 1.8 MB | 项目作者制作（AI 生成），**含 AI 生成的中文语音** | 桌宠彩蛋点开后的全屏出场动画 |
| 状态表 `manifest.json` | 同上 | 1.9 KB | 项目作者编写 | 帧网格规格 |

**字体**：界面字体全部为按名称引用本机已安装字体——系统字体栈（如 Segoe UI / Microsoft YaHei / Yu Gothic UI / Malgun Gothic / Noto Sans KR / Consolas 等）与 `sans-serif` / `serif` / `monospace` 通用族兜底；不使用 `@font-face`、不内嵌 base64 字体、不远程加载字体，也没有随包分发的字体文件。两个原生组件使用 AE 宿主 Drawbot 默认字体与系统 DirectWrite 字体（`Microsoft YaHei UI`），同样不捆绑字体，因此本项目不产生字体许可义务。

**角色形象说明**：角色为鲸鱼拟人化的社区二创风格，母题（鲸鱼、深蓝配色）与 DeepSeek 品牌形象相近；对外名称与界面内文案为「大肥鱼桌宠」「大肥鱼」（不含 DeepSeek 字样），彩蛋触发词为「大肥鱼」。本项目与 DeepSeek 官方无任何关联、赞助或授权关系，**未取得其商标或著作权许可**，也未复制其官方标识或文字商标。该形象如涉权利人异议，将予以及时移除或替换：删除 `client/features/deepseekPet/sprites/` 即移除形象（仅桌宠功能不可用），或导出时加 `--without-sprites`。代码内标识仍为 `deepseekPet` / `AEDeepseekPet`（模块目录与命名空间，非界面文案）。

**许可边界**：上述素材随本项目按 MIT 提供；涉及 DeepSeek 品牌形象的部分不在本项目可授权范围内，使用者自行承担相关风险。

**文档与数据**：`client/shared/aeApiReference.txt`（AE 脚本 API 中文整理，供 `queryAeApi` 使用）由本项目的参考整理稿生成，文件自述「整理来源：AE脚本API参考」，**疑据 Adobe 官方脚本文档整理**（文件内无原始 URL）；如涉权利人异议，将移除或替换为自有摘要。`client/shared/aeMatchName.json` 为 AE 实机导出的 matchName → 显示名映射，属事实性数据。

**界面内联图标**：`client/` 下 CSS `data:` SVG 与内联 `<svg>` 中的部分图标 path 逐字取自 Feather Icons（MIT）与 Lucide（ISC），已在第三节声明，许可全文见附录。

## 六、运行期从上游获取、本项目不分发的组件

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| ComfyUI 官方模板库（`Comfy-Org/workflow_templates`） | MIT（© 2023-present Comfy Org） | 「官方模板」功能运行时从 `raw.githubusercontent.com` / `cdn.jsdelivr.net` 拉取模板索引并缓存于本机数据目录；**不随源码仓库或 Release 包分发** |
| ComfyUI 服务端 | 其自身许可 | 用户自备的外部程序，本项目只通过网络调用 |
| 各大 LLM 平台 API | 各平台服务条款 | 用户自备密钥的外部服务，本项目只发起网络请求 |

## 附录：上游未附许可文本的组件

### isarray@1.0.0

MIT License

```
Copyright (c) 2013 Julian Gruber <julian@juliangruber.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### dingbat-to-unicode@1.0.1

BSD-2-Clause。npm 包未随包附带许可文件（`package.json` 声明 `BSD-2-Clause`）；以下全文取自上游仓库 `mwilliamson/dingbat-to-unicode` 的 `js/LICENSE`：

```
Copyright (c) 2021, Michael Williamson
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### anime.js 3.2.2（`client/vendor/anime/`）

min 文件头只保留版权与许可名称（`(c) 2023 Julian Garnier` / `Released under the MIT license`，未含许可全文）。注：上游 `anime.js@3.2.2` 的 LICENSE 写 `2019`，与 min 文件头不一致；以下按上游 LICENSE 补录（以 2019 为准）：

MIT License

```
Copyright (c) 2019 Julian Garnier

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### acorn@8.18.0（`client/vendor/es3-parser/`，vendored 为 es3-parser）

acorn 的 dist 产物只在文件内保留了作者与许可名称注记，未含许可全文（该目录 `README.md` 有来源说明）。以下按上游 npm 包 `acorn@8.18.0` 的 LICENSE 补录（原文版权行指向的 `AUTHORS` 文件本树未附，见上游仓库）：

MIT License

```
Copyright (C) 2012-2022 by various contributors (see AUTHORS)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### glad 0.1.36（`native/glsl-host/third_party/glad/`）

许可全文随源码树提供：`native/glsl-host/third_party/glad/LICENSE`（上游 `Dav1dde/glad` v0.1.36 原件，树内 3,077 B；上游 LF 版为 3,014 B，树内为 CRLF 检出）。该文件含三段：

- **glad 本体**：MIT，`Copyright (c) 2013-2021 David Herberth`；
- **The Khronos Specifications**：`Copyright (c) 2013-2020 The Khronos Group Inc.`，`Licensed under the Apache License, Version 2.0`；
- **The EGL Specification and various headers**：`Copyright (c) 2007-2016 The Khronos Group Inc.`（Khronos MIT 式许可）。

`include/KHR/khrplatform.h` 自带 Khronos 许可原文（`Copyright (c) 2008-2018 The Khronos Group Inc.`）。

### pako 1.0.11（`vendor/node_modules/pako/`，Zlib 许可）

pako 的许可为 `MIT AND Zlib`：MIT 全文随包提供（`pako/LICENSE`），Zlib 部分的上游文本未随 npm 包附带，以下为 zlib 官方仓库 `LICENSE` 的标准全文：

```
Copyright (C) 1995-2017 Jean-loup Gailly and Mark Adler

This software is provided 'as-is', without any express or implied
warranty.  In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

Jean-loup Gailly        Mark Adler
jloup@gzip.org          madler@alumni.caltech.edu
```

### PDF.js 6.1.200（Apache-2.0，内嵌于 `vendor/node_modules/unpdf/dist/pdfjs.mjs`）

`unpdf@1.8.0` 随包提供 Mozilla PDF.js 6.1.200 的 serverless 构建（`dist/pdfjs.mjs`，约 1.6 MB）；该文件按 Apache-2.0 授权，上游 `unpdf` 包未随附该许可文本。上游版权声明：`Copyright 2012 Mozilla Foundation` 及 PDF.js 贡献者。本项目的 MIT 许可不覆盖该内嵌代码；分发含 `vendor/node_modules/unpdf/` 的 Release 完整包时，须连同本段与下方的 Apache-2.0 全文一并提供。

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

### cssfilter（`client/vendor/xss/` bundle 内联）

`client/vendor/xss/xss.min.js` 的打包文件内联了 cssfilter（js-xss 的 CSS 过滤依赖，MIT）：

```
The MIT License (MIT)

Copyright (c) 2015 老雷

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Feather Icons（`client/` 内联图标）

```
The MIT License (MIT)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Lucide（`client/` 内联图标）

以下为上游 `lucide-icons/lucide` 的 `LICENSE` 全文（版权行年份随上游版本更新；其中列出的图标派生自 Feather，附 Feather MIT 全文）：

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
