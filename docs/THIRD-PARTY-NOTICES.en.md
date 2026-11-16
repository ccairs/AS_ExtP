# Third-Party Notices

[简体中文](THIRD-PARTY-NOTICES.md) | **English** | [日本語](THIRD-PARTY-NOTICES.ja.md) | [Deutsch](THIRD-PARTY-NOTICES.de.md) | [한국어](THIRD-PARTY-NOTICES.ko.md) | [Français](THIRD-PARTY-NOTICES.fr.md) | [Русский](THIRD-PARTY-NOTICES.ru.md)

> This is an English translation of the [Simplified Chinese original](THIRD-PARTY-NOTICES.md). The license texts below are reproduced verbatim in English and are the authoritative texts of their respective licenses.

AS_ExtP is released under the MIT license (see [LICENSE](../LICENSE)). This document lists the third-party components that this project distributes or invokes, together with their licenses.

**Distribution forms**: this project can be obtained in two ways, and the third-party obligations differ. **The full Release package is ready to run out of the box** — it contains the prebuilt native components (`.aex`), a bundled Node.js runtime and the npm dependencies; extract it and double-click `tools\install.bat` (no Node install, `npm ci` or build needed); when redistributing that package, provide this document and the corresponding license files together with it. **The source repository does not contain** the binaries and dependencies above (size and distribution limits); after cloning, run `npm ci` yourself and fill them in with `tools\check-env.bat` / `tools\install.bat`, and build the native components yourself. This project **does not distribute** FFmpeg (neither the Release package nor the source repository contains it); `tools\check-env.bat` / `tools\install.bat` download a pinned upstream version to the local machine.

## 1. Binary components

### FFmpeg 8.1.2 — GPL-3.0-or-later (not distributed by this project)

| Item | Description |
| --- | --- |
| How obtained | **Not distributed by this project**. `tools\check-env.bat` / `tools\install.bat` download `8.1.2-essentials_build` from the upstream Release to the local machine, verifying the pinned SHA-256 (`db580001…`) before the download |
| Local location | `vendor/ffmpeg/ffmpeg.exe`, `vendor/ffmpeg/ffprobe.exe` (in neither the source repository nor the Release package) |
| Full license text | The upstream zip ships `LICENSE.md` / `COPYING.GPLv3` / `COPYING.GPLv2` / `COPYING.LGPLv2.1` / `COPYING.LGPLv3` (subject to what is actually present). After extraction, `tools\check-env.bat` / `tools\install.bat` keep them in `vendor/ffmpeg/` together with `SOURCE.txt` (download address, SHA-256, pointer to the corresponding source); this project still does not distribute that binary, so when redistributing it provide these texts and the source-availability instructions as well |
| Source and corresponding-source pointer | `8.1.2-essentials_build` provided by Gyan Doshi (`GyanD/codexffmpeg`) (GitHub Release tag `8.1.2`), statically linking libx264 / libx265 and other GPL components; the upstream source commit recorded by that release is `FFmpeg/FFmpeg@38b88335f9`, and the source package is `ffmpeg-8.1.2.tar.xz` on ffmpeg.org |
| Purpose | Invoked as a separate process (command-line interface) for video transcoding and frame extraction in the asset library; not linked into the AS_ExtP source |

> This project takes no part in distributing that binary and bears no GPL distribution obligation for it; on a successful install the script prints one GPL notice and keeps the upstream license texts in `vendor/ffmpeg/`. If you redistribute a directory containing ffmpeg, you must satisfy the GPL-3.0-or-later obligations yourself (include the licenses and provide the corresponding source).

### Node.js 22.23.2 — MIT

| Item | Description |
| --- | --- |
| Distribution | Distributed with the full Release package (absent from the source repository; for a source clone, install Node ≥ 20.18 yourself) |
| Location | `vendor/node/node.exe` |
| Full license text | `vendor/node/LICENSE` — the original from the official `node-v22.23.2-win-x64.zip`, containing the license notices of the components bundled with Node. The install script verifies that distribution package against the pinned SHA-256 `1177b413…` (`tools/install.bat`, `tools/check-env.bat`); the value matches the upstream `SHASUMS256.txt`; the `node.exe` inside the package has the same hash as the `node.exe` in this directory (`0d0f5e39…`) |
| Purpose | Runtime for the local Bridge and the stdio MCP server |

## 2. npm dependencies (`vendor/node_modules/`, distributed with the full Release package)

Except for the packages marked ※ in the table below, every package directory contains its own license file (the full license texts of the ※ packages are in the appendix below); the table is a summary and versions follow `package-lock.json`. **There are no mandatory GPL / AGPL / LGPL dependencies** (`jszip` is dual-licensed `MIT OR GPL-3.0-or-later` and is used under MIT here). The full Release package contains this directory and each package's own license file; a source clone does not contain this directory, so run `npm ci` to install it into the root `node_modules` according to `package-lock.json`, and the deployment scripts (`deploy.bat` / `install.bat`) copy it to `vendor/node_modules`. At runtime `client/shared/ae-bridge.js` points `NODE_PATH` at `vendor/node_modules` (`client/shared/ext-mcp-server.js` likewise); Node's normal resolution hits the nearest `node_modules` first with `NODE_PATH` as the fallback, so both a source clone (root `node_modules`) and a deployed install (only `vendor/node_modules`) resolve their dependencies. `xmlbuilder` 10.1.1 is installed nested at `vendor/node_modules/mammoth/node_modules/xmlbuilder/` (shipped with mammoth); the other packages sit at the top level of `vendor/node_modules`.

| Package | Version | License |
| --- | --- | --- |
| @wwek/xlsx | 0.20.3 | Apache-2.0 |
| @xmldom/xmldom | 0.8.13 | MIT |
| argparse | 1.0.10 | MIT |
| base64-js | 1.5.1 | MIT |
| bluebird | 3.4.7 | MIT |
| core-util-is | 1.0.3 | MIT |
| dingbat-to-unicode | 1.0.1 | BSD-2-Clause ※ |
| duck | 0.1.12 | BSD-2-Clause (the upstream field says only "BSD"; the actual text is the two-clause BSD license) |
| immediate | 3.0.6 | MIT |
| inherits | 2.0.4 | ISC |
| isarray | 1.0.0 | MIT ※ |
| jszip | 3.10.1 | MIT OR GPL-3.0-or-later (used under MIT here) |
| lie | 3.3.0 | MIT |
| lop | 0.4.2 | BSD-2-Clause |
| mammoth | 1.12.1 | BSD-2-Clause |
| option | 0.2.4 | BSD-2-Clause |
| pako | 1.0.11 | MIT AND Zlib ※ (the package contains only the MIT text; the full Zlib text is in the appendix) |
| path-is-absolute | 1.0.1 | MIT |
| process-nextick-args | 2.0.1 | MIT |
| readable-stream | 2.3.8 | MIT |
| safe-buffer | 5.1.2 | MIT |
| setimmediate | 1.0.5 | MIT |
| sprintf-js | 1.0.3 | BSD-3-Clause |
| string_decoder | 1.1.1 | MIT |
| underscore | 1.13.8 | MIT |
| unpdf | 1.8.0 | MIT; embeds Mozilla PDF.js 6.1.200 (Apache-2.0) ※ |
| util-deprecate | 1.0.2 | MIT |
| xmlbuilder | 10.1.1 | MIT |

※ = the upstream package does not include the full text of that license (or does not ship it with the package); the full text is in the appendix below. `dist/pdfjs.mjs` in `unpdf@1.8.0` is the serverless build of Mozilla PDF.js (embedded version 6.1.200), and that part is licensed under Apache-2.0; the upstream `unpdf` package includes only its own MIT text, not the Apache-2.0 text.

## 3. Third-party source libraries distributed with the source tree

The following libraries are included in source form in the public repository; of these, **glad** and **PinIn4Cpp** are compiled statically into the Release package's `.aex` at build time (i.e. distributed in binary form with the Release), and their license texts are provided with the source tree, which satisfies the permissive licenses' requirement to keep the copyright and license notices with each copy:

| Library | Location | Version | License | License text | Purpose |
| --- | --- | --- | --- | --- | --- |
| marked | `client/vendor/marked/` | 12.0.2 | MIT | in-tree `LICENSE` | Markdown rendering |
| Prism.js | `client/vendor/prism/` | 1.29.0 (inferred) | MIT | in-tree `LICENSE` | Code highlighting |
| js-xss | `client/vendor/xss/` | 1.0.15 (inferred) | MIT | in-tree `LICENSE`; the bundle also inlines cssfilter (MIT), full text in the appendix | HTML sanitization |
| anime.js | `client/vendor/anime/` | 3.2.2 | MIT (© 2019 Julian Garnier; the upstream minified file header wrongly says 2023) | Header notice; full text in the appendix | UI animation |
| acorn (es3-parser) | `client/vendor/es3-parser/` | 8.18.0 | MIT (© 2012-2022 by various contributors) | Notice inside `acorn.js` + provenance `README.md` (full license text in the appendix) | ES3 parser for the AST compile gate |
| CSInterface.js | `client/vendor/CSInterface.js` | 8.0.0 (reduced implementation) | Adobe SDK License Agreement (not OSS); the file keeps Adobe's copyright header and version number | in-tree `CSInterface.LICENSE.pdf` (the original agreement, see below) | CEP host interface |
| glad | `native/glsl-host/third_party/glad/` | 0.1.36 (generator) | MIT + Khronos Apache-2.0 | in-tree `LICENSE` (upstream original, covering three parts: glad / Khronos Specifications / EGL headers); `include/KHR/khrplatform.h` carries the original Khronos license | OpenGL loader |
| PinIn4Cpp | `native/hotbox/third_party/PinIn4Cpp/` | 1.5.8 | MIT (© 2025 KagiyamaHina) | in-tree `LICENSE`; `licenses/` holds two MIT texts, PinIn (© 2019 Juntong Liu) and pinyin-data (© 2016 mozillazg) | Pinyin matching for the hotbox |
| json2 (adapted from Crockford's json2.js) | `host/api/json2.jsx` | no version marked | Public Domain | Header notice (public domain, no license-text obligation) | JSON polyfill for ExtendScript (ES3 has no native JSON) |
| Feather Icons / Lucide | CSS `data:` SVGs and inline `<svg>` under `client/` | — | MIT (Feather, © 2013-2023 Cole Bemis) / ISC (Lucide) | Full text in the appendix | Inline UI icons (some paths taken verbatim from upstream) |

"—" = no version number is marked in the bundled minified file. **The Prism / js-xss versions are inferred**: Prism was confirmed by a byte-for-byte comparison of `prism-core.min.js` with the official `components/prism-core.min.js` of upstream `prismjs@1.29.0` (`prism-clike` / `prism-javascript` and the theme files match the official ones as well); js-xss was confirmed by matching the SHA-256 `2072387B…3261E` of `xss.min.js` with the official artifact of upstream `xss@1.0.15`, with the bundle containing `singleQuotedAttributeValue` (introduced in 1.0.15) and not containing `filterXSSWithResult` (introduced in 1.0.16) as corroborating evidence for the version bounds. All other versions were checked directly against the version string in the file / `package-lock`.

**Local Prism changes**: `client/vendor/prism/prism-core.min.js` differs from upstream 1.29.0 in two places — inside `highlightAllUnder` it uses the container passed as a function argument instead of the hook-rewritable `env.container`; a `window.Prism=Prism;` statement is appended at the end of the file (mounting it globally in the CEP environment). The changes do not alter the license obligations and must be reapplied when upgrading Prism.

**CSInterface.js**: Adobe copyright (`Copyright (c) 2012-2017 Adobe Systems Inc.`); the file header grants use, modification and distribution under the Adobe license agreement shipped with it. That agreement (`GenSDK_IHC-en_US-20120323_1224.pdf`, taken from the `License/` directory of the Adobe CEP-Resources repository) has been placed in the tree as `client/vendor/CSInterface.LICENSE.pdf` (95,659 B, SHA-256 `32E81408…5383`), and this project uses the file under that agreement as part of the CEP extension. The file in the tree is an implementation reduced to the project's needs (357 lines, 16 methods: `evalScript` / `getHostEnvironment` / `getSystemPath` / `getExtensionPath` / event registration, etc.), not the full text of Adobe's official distribution (official v8 is about 1200 lines and also includes `setPanelFlyoutMenu` / `updatePanelMenuItem` / `getExtensions` / `getNetworkPreferences`, etc.); the copyright header and the `v8.0.0` version identifier are kept as upstream, to indicate that its interface and usage derive from the Adobe CEP SDK.

Apart from CSInterface.js (Adobe agreement, not OSS), the other libraries are under MIT / BSD-style permissive licenses; glad additionally contains Apache-2.0 for the Khronos parts (noted in the same table), which is compatible with this project's MIT license.

## 4. Build-time dependencies and Adobe content in the compiled artifacts (the SDK itself is not distributed)

| Component | License | Description |
| --- | --- | --- |
| Adobe After Effects SDK | Adobe SDK agreement | Required to compile the two native components under `native/` (the GLSL effect host / AE hotbox), and obtained from Adobe by the builder; **neither the SDK itself nor its license text is distributed with the source repository or the Release package**; the build steps are in [DEVELOPMENT.md](DEVELOPMENT.md) |
| Compiled artifacts `deploy/Plug-ins/*.aex` | Build output of this project; subject to the Adobe SDK agreement | The full Release package contains `AS_Effect_Host.aex` (about 643 KB) and `AS_Hotbox.aex` (about 1.5 MB). At build time the unmodified example sources from the SDK's `Examples/Util` (`AEFX_SuiteHelper.c`, `AEGP_SuiteHandler.cpp`, `MissingSuiteError.cpp`) are compiled in as compilation units, and glad (MIT) and PinIn4Cpp (MIT, with the pinyin-data pinyin data) are linked statically; these two binaries are outside the scope of this project's MIT license. Before redistributing them or using them commercially, verify the terms of your agreement with Adobe yourself (contact Adobe developer support if necessary). |

> Apart from the `.aex` files, everything else in the full Release package (source, Node.js, npm dependencies) is covered by this document and each package's LICENSE; the `.aex` files are the only binary artifacts compiled by this project within the scope of this document (`vendor/node/node.exe` in the package is the upstream Node.js runtime, see section 1).

## 5. Non-code assets and content provenance

Three non-code assets are distributed with the source tree; **no third-party image library, font or third-party audio asset is included**:

| Content | Location | Size | Source | Description |
| --- | --- | --- | --- | --- |
| Desktop pet sprite frames (16 PNGs) | `client/features/deepseekPet/sprites/` | ~108.7 MB | Made by the project author with AI generation tools; `potHead` / `eat` were merged in from self-made frame sequences outside the repository | Original character animation |
| Easter-egg video `appear.webm` | Same as above | ~1.8 MB | Made by the project author (AI-generated), **contains AI-generated Chinese speech** | Full-screen entrance animation played after the desktop pet's easter egg is opened |
| State manifest `manifest.json` | Same as above | 1.9 KB | Written by the project author | Frame grid specification |

**Fonts**: every font in the UI refers by name to fonts already installed on the machine — the system font stack (e.g. Segoe UI / Microsoft YaHei / Yu Gothic UI / Malgun Gothic / Noto Sans KR / Consolas) with the `sans-serif` / `serif` / `monospace` generic families as fallback; no `@font-face` is used, no base64 font is embedded, no font is loaded remotely, and no font file is distributed with the package. The two native components use the AE host's default Drawbot font and a system DirectWrite font (`Microsoft YaHei UI`) and bundle no fonts either, so this project incurs no font licensing obligation.

**Character statement**: the character is an anthropomorphic whale in a community-derivative style; its motifs (whale, deep blue palette) resemble the DeepSeek brand image. Its public name and in-app wording are "大肥鱼桌宠" / "大肥鱼" ("Big Fat Fish desktop pet" / "Big Fat Fish", with no DeepSeek wording), and the easter-egg trigger word is "大肥鱼". This project has no affiliation, sponsorship or authorization relationship with DeepSeek, **holds no license to its trademarks or copyright**, and has not copied its official logo or word mark. Should a rights holder object to the character, it will be removed or replaced promptly: deleting `client/features/deepseekPet/sprites/` removes the character (only the desktop pet stops working), or add `--without-sprites` when exporting. The identifiers in code remain `deepseekPet` / `AEDeepseekPet` (module directory and namespace, not UI wording).

**License boundary**: the assets above are provided under MIT with this project; the parts involving the DeepSeek brand image are outside what this project can license, and users assume the related risk.

**Documentation and data**: `client/shared/aeApiReference.txt` (a Chinese compilation of the AE scripting API, used by `queryAeApi`) was generated from this project's own reference notes; the file's own note reads "整理来源：AE脚本API参考" (compiled from: AE Scripting API Reference) and is **presumed to have been compiled from Adobe's official scripting documentation** (the file contains no original URL); should a rights holder object, it will be removed or replaced with a summary of our own. `client/shared/aeMatchName.json` is a matchName → display-name mapping exported from a real AE installation and is factual data.

**Inline UI icons**: some icon paths in the CSS `data:` SVGs and inline `<svg>` elements under `client/` are taken verbatim from Feather Icons (MIT) and Lucide (ISC); they are declared in section 3 and their full license texts are in the appendix.

## 6. Components fetched from upstream at runtime and not distributed by this project

| Component | License | Description |
| --- | --- | --- |
| ComfyUI official template library (`Comfy-Org/workflow_templates`) | MIT (© 2023-present Comfy Org) | The "official templates" feature fetches the template index from `raw.githubusercontent.com` / `cdn.jsdelivr.net` at runtime and caches it in the local data directory; **not distributed with the source repository or the Release package** |
| ComfyUI server | Its own license | An external program supplied by the user; this project only calls it over the network |
| Major LLM platform APIs | Each platform's terms of service | External services for which the user supplies the key; this project only issues network requests |

## Appendix: components whose upstream does not include the license text

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

BSD-2-Clause. The npm package ships no license file (`package.json` declares `BSD-2-Clause`); the full text below is taken from `js/LICENSE` in the upstream repository `mwilliamson/dingbat-to-unicode`:

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

### anime.js 3.2.2 (`client/vendor/anime/`)

The minified file header keeps only the copyright and license name (`(c) 2023 Julian Garnier` / `Released under the MIT license`), not the full license text. Note: the LICENSE of upstream `anime.js@3.2.2` says `2019`, which disagrees with the minified file header; the text below is supplied from the upstream LICENSE (2019 is authoritative):

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

### acorn@8.18.0 (`client/vendor/es3-parser/`, vendored as es3-parser)

The acorn dist artifact keeps only the author and license-name notice inside the file, without the full license text (that directory's `README.md` documents the provenance). The text below is supplied from the LICENSE of the upstream npm package `acorn@8.18.0` (the `AUTHORS` file referenced by the original copyright line is not included in this tree; see the upstream repository):

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

### glad 0.1.36 (`native/glsl-host/third_party/glad/`)

The full license text is provided with the source tree: `native/glsl-host/third_party/glad/LICENSE` (the original from upstream `Dav1dde/glad` v0.1.36, 3,077 B in this tree; the upstream LF version is 3,014 B, while this tree is a CRLF checkout). The file has three parts:

- **glad itself**: MIT, `Copyright (c) 2013-2021 David Herberth`;
- **The Khronos Specifications**: `Copyright (c) 2013-2020 The Khronos Group Inc.`, `Licensed under the Apache License, Version 2.0`;
- **The EGL Specification and various headers**: `Copyright (c) 2007-2016 The Khronos Group Inc.` (Khronos MIT-style license).

`include/KHR/khrplatform.h` carries the original Khronos license text (`Copyright (c) 2008-2018 The Khronos Group Inc.`).

### pako 1.0.11 (`vendor/node_modules/pako/`, Zlib license)

pako's license is `MIT AND Zlib`: the full MIT text is supplied with the package (`pako/LICENSE`); the upstream text for the Zlib part is not included with the npm package, so the standard text from the zlib official repository's `LICENSE` follows:

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

### PDF.js 6.1.200 (Apache-2.0, embedded in `vendor/node_modules/unpdf/dist/pdfjs.mjs`)

`unpdf@1.8.0` ships the serverless build of Mozilla PDF.js 6.1.200 (`dist/pdfjs.mjs`, about 1.6 MB); that file is licensed under Apache-2.0, and the upstream `unpdf` package does not carry that license text. Upstream copyright notice: `Copyright 2012 Mozilla Foundation` and the PDF.js contributors. This project's MIT license does not cover that embedded code; when distributing a full Release package that contains `vendor/node_modules/unpdf/`, this section and the full Apache-2.0 text below must be provided with it.

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

### cssfilter (inlined in the `client/vendor/xss/` bundle)

The bundle of `client/vendor/xss/xss.min.js` inlines cssfilter (js-xss's CSS filtering dependency, MIT):

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

### Feather Icons (inline icons under `client/`)

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

### Lucide (inline icons under `client/`)

The following is the full `LICENSE` of upstream `lucide-icons/lucide` (the year in the copyright line is updated with upstream releases; the icons it lists are derived from Feather, with the full Feather MIT text below):

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
