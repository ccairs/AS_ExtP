# サードパーティ製コンポーネントに関する表示 / Third-Party Notices

[简体中文](THIRD-PARTY-NOTICES.md) | [English](THIRD-PARTY-NOTICES.en.md) | **日本語** | [Deutsch](THIRD-PARTY-NOTICES.de.md) | [한국어](THIRD-PARTY-NOTICES.ko.md) | [Français](THIRD-PARTY-NOTICES.fr.md) | [Русский](THIRD-PARTY-NOTICES.ru.md)

> 本ファイルは日本語訳です。法的効力は[簡体字中国語の原文](THIRD-PARTY-NOTICES.md)および以下に英語原文のまま掲載するライセンス本文に基づきます。

AS_ExtP は MIT ライセンスでリリースされています（[LICENSE](../LICENSE) を参照）。本ドキュメントは、本プロジェクトが配布または呼び出すサードパーティ製コンポーネントと、そのライセンスを一覧にしたものです。

**配布形態の説明**：本プロジェクトには 2 つの入手方法があり、サードパーティに対する義務が異なります。**Release 完全パッケージはすぐに使えます**——ビルド済みのネイティブコンポーネント（`.aex`）、同梱の Node.js ランタイム、npm 依存関係を含み、展開して `tools\install.bat` をダブルクリックするだけで使用できます。Node のインストール、`npm ci`、ビルドは不要です。このパッケージを配布する際は、本ドキュメントと該当するライセンスファイルを併せて提供してください。**ソースリポジトリには**上記のバイナリと依存関係が**含まれていません**（サイズと配布の制約による）。クローン後は自身で `npm ci` を実行し、`tools\check-env.bat` / `tools\install.bat` で補完する必要があり、ネイティブコンポーネントは自身でビルドしてください。FFmpeg は本プロジェクトでは**配布しません**（Release パッケージにもソースリポジトリにも含まれません）。`tools\check-env.bat` / `tools\install.bat` がアップストリームの固定バージョンを本機へダウンロードします。

## 1. バイナリコンポーネント

### FFmpeg 8.1.2 — GPL-3.0-or-later（本プロジェクトは配布しません）

| 項目 | 説明 |
| --- | --- |
| 入手方法 | **本プロジェクトは配布しません**。`tools\check-env.bat` / `tools\install.bat` がアップストリームの Release から `8.1.2-essentials_build` を本機へダウンロードし、ダウンロード前に固定の SHA-256（`db580001…`）で検証します |
| 本機の位置 | `vendor/ffmpeg/ffmpeg.exe`、`vendor/ffmpeg/ffprobe.exe`（ソースリポジトリと Release パッケージのいずれにも含まれません） |
| ライセンス全文 | アップストリームの zip に `LICENSE.md` / `COPYING.GPLv3` / `COPYING.GPLv2` / `COPYING.LGPLv2.1` / `COPYING.LGPLv3` が同梱されています（実際に存在するものに準じます）。`tools\check-env.bat` / `tools\install.bat` は展開後、これらを `SOURCE.txt`（ダウンロード URL、SHA-256、対応するソースの案内）とともに `vendor/ffmpeg/` に残します。本プロジェクトは引き続きこのバイナリを配布しません。再配布する際は、これらのテキストとソースの入手方法を併せて提供してください |
| 出所と対応ソースの案内 | Gyan Doshi（`GyanD/codexffmpeg`）提供の `8.1.2-essentials_build`（GitHub Release タグ `8.1.2`）で、libx264 / libx265 などの GPL コンポーネントを静的リンクしています。この Release が記録するアップストリームのソースコミットは `FFmpeg/FFmpeg@38b88335f9`、ソースパッケージは ffmpeg.org の `ffmpeg-8.1.2.tar.xz` です |
| 用途 | 独立したプロセス（コマンドラインインターフェース）として呼び出し、アセットライブラリの動画トランスコードとフレーム抽出に使用します。AS_ExtP のソースにはリンクされていません |

> 本プロジェクトはこのバイナリの配布に関与せず、その GPL 配布義務を負いません。スクリプトによるインストールが成功すると GPL の注意を 1 行表示し、アップストリームのライセンステキストを `vendor/ffmpeg/` に残します。ffmpeg を含むディレクトリを再配布する場合は、GPL-3.0-or-later の義務（ライセンスの添付、対応するソースの提供）を自身で満たす必要があります。

### Node.js 22.23.2 — MIT

| 項目 | 説明 |
| --- | --- |
| 配布方法 | Release 完全パッケージに同梱して配布します（ソースリポジトリには含まれません。ソースのクローンでは Node ≥ 20.18 を自身でインストールしてください） |
| 位置 | `vendor/node/node.exe` |
| ライセンス全文 | `vendor/node/LICENSE` —— 公式の `node-v22.23.2-win-x64.zip` 内の原本で、Node に組み込まれた各コンポーネントのライセンス表示を含みます。インストールスクリプトは固定の SHA-256 `1177b413…` でこの配布パッケージを検証し（`tools/install.bat`、`tools/check-env.bat`）、その値はアップストリームの `SHASUMS256.txt` と一致します。パッケージ内の `node.exe` と本ディレクトリの `node.exe` のハッシュは一致します（`0d0f5e39…`） |
| 用途 | ローカル Bridge と stdio MCP サーバーのランタイム |

## 2. npm 依存関係（`vendor/node_modules/`、Release 完全パッケージに同梱して配布）

下表で ※ を付したパッケージを除き、各パッケージのディレクトリにはライセンスファイルが同梱されています（※ を付したパッケージのライセンス全文は下記の付録を参照）。下表は要約であり、バージョンは `package-lock.json` に準じます。**強制的な GPL / AGPL / LGPL 依存関係はありません**（`jszip` は `MIT OR GPL-3.0-or-later` のデュアルライセンスで、本プロジェクトは MIT として使用します）。Release 完全パッケージには本ディレクトリと各パッケージ同梱のライセンスファイルが含まれます。ソースのクローンには本ディレクトリが含まれないため、`npm ci` で `package-lock.json` に従ってルートの `node_modules` にインストールし、デプロイスクリプト（`deploy.bat` / `install.bat`）が `vendor/node_modules` へコピーします。実行時は `client/shared/ae-bridge.js` が `NODE_PATH` を `vendor/node_modules` に向けます（`client/shared/ext-mcp-server.js` も同様）。Node の通常の解決では近い `node_modules` が先にヒットし、`NODE_PATH` はフォールバックとして機能するため、ソースのクローン（ルートの `node_modules`）とデプロイ状態（`vendor/node_modules` のみ）のどちらでも依存関係を解決できます。`xmlbuilder` 10.1.1 は `vendor/node_modules/mammoth/node_modules/xmlbuilder/` にネスト形式でインストールされ（mammoth が同梱）、その他のパッケージは `vendor/node_modules/` のトップレベルにあります。

| パッケージ | バージョン | ライセンス |
| --- | --- | --- |
| @wwek/xlsx | 0.20.3 | Apache-2.0 |
| @xmldom/xmldom | 0.8.13 | MIT |
| argparse | 1.0.10 | MIT |
| base64-js | 1.5.1 | MIT |
| bluebird | 3.4.7 | MIT |
| core-util-is | 1.0.3 | MIT |
| dingbat-to-unicode | 1.0.1 | BSD-2-Clause ※ |
| duck | 0.1.12 | BSD-2-Clause（アップストリームのフィールドは "BSD" とのみ記載、実際の文面は 2 条項 BSD） |
| immediate | 3.0.6 | MIT |
| inherits | 2.0.4 | ISC |
| isarray | 1.0.0 | MIT ※ |
| jszip | 3.10.1 | MIT OR GPL-3.0-or-later（本プロジェクトは MIT として使用） |
| lie | 3.3.0 | MIT |
| lop | 0.4.2 | BSD-2-Clause |
| mammoth | 1.12.1 | BSD-2-Clause |
| option | 0.2.4 | BSD-2-Clause |
| pako | 1.0.11 | MIT AND Zlib ※（パッケージ内には MIT のテキストのみ、Zlib の全文は付録を参照） |
| path-is-absolute | 1.0.1 | MIT |
| process-nextick-args | 2.0.1 | MIT |
| readable-stream | 2.3.8 | MIT |
| safe-buffer | 5.1.2 | MIT |
| setimmediate | 1.0.5 | MIT |
| sprintf-js | 1.0.3 | BSD-3-Clause |
| string_decoder | 1.1.1 | MIT |
| underscore | 1.13.8 | MIT |
| unpdf | 1.8.0 | MIT、Mozilla PDF.js 6.1.200（Apache-2.0）を内包 ※ |
| util-deprecate | 1.0.2 | MIT |
| xmlbuilder | 10.1.1 | MIT |

※ = アップストリームのパッケージが該当ライセンスの全文を添付していない（またはパッケージに同梱していない）ことを示し、そのライセンス全文は下記の付録を参照してください。`unpdf@1.8.0` の `dist/pdfjs.mjs` は Mozilla PDF.js の serverless ビルド（内包バージョン 6.1.200）で、この部分は Apache-2.0 でライセンスされています。アップストリームの `unpdf` パッケージは自身の MIT テキストのみを添付し、Apache-2.0 のテキストは添付していません。

## 3. ソースツリーとともに配布するサードパーティのソースライブラリ

以下のライブラリはソース形式で公開リポジトリに含まれています。うち **glad** と **PinIn4Cpp** はビルド時に Release パッケージの `.aex` へ静的コンパイルされ（つまりバイナリ形態で Release とともに配布され）、そのライセンステキストはソースツリーとともに提供されるため、寛容なライセンスの「複製物とともに著作権表示とライセンス表示を保持する」という要件を満たしています：

| ライブラリ | 位置 | バージョン | ライセンス | ライセンステキスト | 用途 |
| --- | --- | --- | --- | --- | --- |
| marked | `client/vendor/marked/` | 12.0.2 | MIT | ツリー内 `LICENSE` | Markdown レンダリング |
| Prism.js | `client/vendor/prism/` | 1.29.0（推定） | MIT | ツリー内 `LICENSE` | コードハイライト |
| js-xss | `client/vendor/xss/` | 1.0.15（推定） | MIT | ツリー内 `LICENSE`。バンドルには cssfilter（MIT）もインライン化されており、全文は付録を参照 | HTML サニタイズ |
| anime.js | `client/vendor/anime/` | 3.2.2 | MIT（© 2019 Julian Garnier、アップストリームの min ファイルのヘッダーは誤って 2023 と記載） | ファイルヘッダーの注記。全文は付録を参照 | インターフェースアニメーション |
| acorn（es3-parser） | `client/vendor/es3-parser/` | 8.18.0 | MIT（© 2012-2022 by various contributors） | `acorn.js` ファイル内の注記 + 出所 `README.md`（ライセンス全文は付録を参照） | AST コンパイルゲートの ES3 パーサー |
| CSInterface.js | `client/vendor/CSInterface.js` | 8.0.0（簡略化した実装） | Adobe SDK ライセンス契約（非 OSS）。ファイル内に Adobe の著作権ヘッダーとバージョン番号を保持しています | ツリー内 `CSInterface.LICENSE.pdf`（契約の原本、下記を参照） | CEP ホストインターフェース |
| glad | `native/glsl-host/third_party/glad/` | 0.1.36（ジェネレーター） | MIT + Khronos Apache-2.0 | ツリー内 `LICENSE`（アップストリームの原本、glad / Khronos Specifications / EGL headers の 3 段構成）。`include/KHR/khrplatform.h` に Khronos ライセンスの原文を内蔵 | OpenGL ローダー |
| PinIn4Cpp | `native/hotbox/third_party/PinIn4Cpp/` | 1.5.8 | MIT（© 2025 KagiyamaHina） | ツリー内 `LICENSE`。`licenses/` に PinIn（© 2019 Juntong Liu）と pinyin-data（© 2016 mozillazg）の 2 つの MIT テキストを収録 | Hotbox のピンイン照合 |
| json2（Crockford json2.js の改変） | `host/api/json2.jsx` | バージョン表記なし | Public Domain | ファイルヘッダーの注記（パブリックドメイン、ライセンステキストの義務なし） | ExtendScript の JSON polyfill（ES3 にネイティブ JSON なし） |
| Feather Icons / Lucide | `client/` 配下の CSS `data:` SVG とインライン `<svg>` | — | MIT（Feather、© 2013-2023 Cole Bemis）/ ISC（Lucide） | 全文は付録を参照 | インターフェースのインラインアイコン（一部のパスはアップストリームからそのまま引用） |

「—」= パッケージ化された min ファイル内にバージョン番号の記載がないことを示します。**Prism / js-xss のバージョンは推定です**：Prism は `prism-core.min.js` をアップストリームの `prismjs@1.29.0` 公式 `components/prism-core.min.js` とバイト単位で比較して確認し（`prism-clike` / `prism-javascript` とテーマファイルも公式と一致）、js-xss は `xss.min.js` の SHA-256 `2072387B…3261E` がアップストリーム `xss@1.0.15` の公式成果物と一致することで確認し、さらにバンドルが `singleQuotedAttributeValue`（1.0.15 で導入）を含み、`filterXSSWithResult`（1.0.16 で導入）を含まないことをバージョンの下限・上限の裏付けとしています。その他のバージョンは、ファイル内のバージョン文字列 / `package-lock` と直接照合しています。

**Prism のローカル変更**：`client/vendor/prism/prism-core.min.js` はアップストリームの 1.29.0 と 2 点異なります——`highlightAllUnder` 内では、フックで書き換え可能な `env.container` の代わりに関数の引数のコンテナを使用し、ファイル末尾に `window.Prism=Prism;` を追加しています（CEP 環境でグローバルに公開するため）。この変更はライセンス義務を変えず、Prism を更新する際は再度適用する必要があります。

**CSInterface.js**：Adobe の著作権表示（`Copyright (c) 2012-2017 Adobe Systems Inc.`）があり、ファイルヘッダーには、同梱の Adobe ライセンス契約に従って使用・変更・配布できる旨が記されています。この契約の原文（`GenSDK_IHC-en_US-20120323_1224.pdf`、Adobe CEP-Resources リポジトリの `License/` ディレクトリから取得）は、ツリー内の `client/vendor/CSInterface.LICENSE.pdf` として配置されています（95,659 B、SHA-256 `32E81408…5383`）。本プロジェクトはこの契約に従い、CEP 拡張の一部として本ファイルを使用します。ツリー内のファイルはプロジェクトの必要に応じて簡略化した実装（357 行、16 メソッド：`evalScript` / `getHostEnvironment` / `getSystemPath` / `getExtensionPath` / イベント登録など）であり、Adobe 公式配布版の全文ではありません（公式 v8 は約 1200 行で、`setPanelFlyoutMenu` / `updatePanelMenuItem` / `getExtensions` / `getNetworkPreferences` などを含みます）。ファイルヘッダーの著作権表示と `v8.0.0` のバージョン表記はアップストリームのまま保持しており、そのインターフェースと使い方が Adobe CEP SDK に由来することを示しています。

CSInterface.js（Adobe の契約、非 OSS）を除き、その他のライブラリはいずれも MIT / BSD 系の寛容なライセンスです。glad はさらに Khronos 部分の Apache-2.0 を含み（同表に記載）、本プロジェクトの MIT ライセンスと互換です。

## 4. ビルド時の依存関係とビルド成果物に含まれる Adobe のコンテンツ（SDK 本体は配布しません）

| コンポーネント | ライセンス | 説明 |
| --- | --- | --- |
| Adobe After Effects SDK | Adobe SDK 契約 | `native/` の 2 つのネイティブコンポーネント（GLSL エフェクトホスト / AE Hotbox）をビルドする際に必要で、ビルドする人が Adobe から自身で入手します。**SDK 本体とそのライセンステキストは、ソースリポジトリにも Release パッケージにも含まれません**。ビルド手順は [DEVELOPMENT.md](DEVELOPMENT.md) を参照してください |
| ビルド成果物 `deploy/Plug-ins/*.aex` | 本プロジェクトのビルド成果物。Adobe SDK 契約の制約を受けます | Release 完全パッケージには `AS_Effect_Host.aex`（約 643 KB）と `AS_Hotbox.aex`（約 1.5 MB）が含まれます。ビルド時には SDK `Examples/Util` の未変更のサンプルソース（`AEFX_SuiteHelper.c`、`AEGP_SuiteHandler.cpp`、`MissingSuiteError.cpp`）をコンパイル単位として組み込み、glad（MIT）と PinIn4Cpp（MIT、pinyin-data のピンインデータを含む）を静的リンクします。これら 2 つのバイナリは、本プロジェクトの MIT ライセンスの適用範囲に含まれません。再配布または商用利用の前に、Adobe との契約条件を自身で確認してください（必要に応じて Adobe の開発者サポートへ問い合わせてください）。 |

> `.aex` を除き、Release 完全パッケージ内のその他の内容（ソース、Node.js、npm 依存関係）は本ドキュメントと各パッケージの LICENSE の表示に従います。`.aex` は本ドキュメントの範囲で唯一、本プロジェクトがビルドしたバイナリ成果物です（パッケージ内の `vendor/node/node.exe` はアップストリームの Node.js ランタイムで、第 1 節を参照してください）。

## 5. コード以外の素材とコンテンツの出所

本プロジェクトがソースツリーとともに配布する内容のうち、コード以外の資産は 3 つです。**サードパーティの画像ライブラリ、フォント、サードパーティの音声素材は一切含みません**：

| 内容 | 位置 | サイズ | 出所 | 説明 |
| --- | --- | --- | --- | --- |
| デスクトップペットの連番フレーム（PNG 16 個） | `client/features/deepseekPet/sprites/` | 約 108.7 MB | プロジェクト作者が AI 生成ツールで制作。`potHead` / `eat` の 2 点はリポジトリ外の自作連番フレームを統合したものです | オリジナルキャラクターのアニメーション |
| イースターエッグ動画 `appear.webm` | 同上 | 約 1.8 MB | プロジェクト作者が制作（AI 生成）、**AI 生成の中国語音声を含みます** | デスクトップペットのイースターエッグを開いた後の全画面登場アニメーション |
| 状態テーブル `manifest.json` | 同上 | 1.9 KB | プロジェクト作者が作成 | フレームグリッドの仕様 |

**フォント**：インターフェースのフォントはすべて、名前で本機にインストール済みのフォントを参照しています——システムフォントスタック（Segoe UI / Microsoft YaHei / Yu Gothic UI / Malgun Gothic / Noto Sans KR / Consolas など）と、`sans-serif` / `serif` / `monospace` の汎用ファミリーをフォールバックとして使用します。`@font-face` は使用せず、base64 フォントの埋め込みも、フォントのリモート読み込みも行わず、パッケージに同梱するフォントファイルもありません。2 つのネイティブコンポーネントは AE ホストの Drawbot のデフォルトフォントとシステムの DirectWrite フォント（`Microsoft YaHei UI`）を使用し、同様にフォントを同梱しないため、本プロジェクトにフォントのライセンス義務は発生しません。

**キャラクターイメージについて**：キャラクターはクジラを擬人化したコミュニティによる二次創作風のもので、モチーフ（クジラ、深い青の配色）は DeepSeek のブランドイメージに近いものです。対外的な名称とインターフェース内の文言は「ふとっちょフィッシュ」（原文では「大肥鱼桌宠」「大肥鱼」）で、DeepSeek の文字は含みません。イースターエッグのトリガーワードは「大肥鱼」です。本プロジェクトは DeepSeek 公式といかなる提携・スポンサー・許諾の関係もなく、**その商標または著作権の許諾を得ていません**。公式のロゴや文字商標を複製したこともありません。このキャラクターについて権利者から異議があった場合は、速やかに削除または差し替えます：`client/features/deepseekPet/sprites/` を削除すればキャラクターは除去され（デスクトップペット機能のみ使用できなくなります）、書き出し時に `--without-sprites` を付ける方法もあります。コード内の識別子は引き続き `deepseekPet` / `AEDeepseekPet` です（モジュールディレクトリと名前空間であり、インターフェースの文言ではありません）。

**ライセンスの境界**：上記の素材は本プロジェクトとともに MIT で提供されます。DeepSeek のブランドイメージに関わる部分は本プロジェクトが許諾できる範囲に含まれず、利用者が関連するリスクを自ら負担します。

**ドキュメントとデータ**：`client/shared/aeApiReference.txt`（AE スクリプト API の中国語版整理で、`queryAeApi` が使用）は本プロジェクトの参考資料の整理稿から生成されたもので、ファイル自身に「整理来源：AE脚本API参考」と記されていますが、**Adobe 公式のスクリプトドキュメントに基づいて整理した疑いがあります**（ファイル内に元の URL はありません）。権利者から異議があった場合は、削除するか独自の要約に差し替えます。`client/shared/aeMatchName.json` は AE 実機から書き出した matchName → 表示名のマッピングで、事実データに属します。

**インターフェースのインラインアイコン**：`client/` 配下の CSS `data:` SVG とインライン `<svg>` の一部のアイコンパスは、Feather Icons（MIT）と Lucide（ISC）からそのまま引用しており、第 3 節で表示しています。ライセンス全文は付録を参照してください。

## 6. 実行時にアップストリームから取得し、本プロジェクトが配布しないコンポーネント

| コンポーネント | ライセンス | 説明 |
| --- | --- | --- |
| ComfyUI 公式テンプレートライブラリ（`Comfy-Org/workflow_templates`） | MIT（© 2023-present Comfy Org） | 「公式テンプレート」機能が実行時に `raw.githubusercontent.com` / `cdn.jsdelivr.net` からテンプレートのインデックスを取得し、本機のデータディレクトリにキャッシュします。**ソースリポジトリにも Release パッケージにも含まれません** |
| ComfyUI サーバー | それ自体のライセンス | 利用者が自身で用意する外部プログラムで、本プロジェクトはネットワーク経由で呼び出すのみです |
| 各社 LLM プラットフォームの API | 各プラットフォームの利用規約 | 利用者が自身でキーを用意する外部サービスで、本プロジェクトはネットワーク要求を送るのみです |

## 付録：アップストリームがライセンステキストを添付していないコンポーネント

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

BSD-2-Clause。npm パッケージはライセンスファイルを同梱していません（`package.json` の宣言は `BSD-2-Clause`）。以下の全文はアップストリームリポジトリ `mwilliamson/dingbat-to-unicode` の `js/LICENSE` から取得したものです：

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

min ファイルのヘッダーには著作権とライセンス名のみが残されています（`(c) 2023 Julian Garnier` / `Released under the MIT license`、ライセンス全文は含みません）。注記：アップストリーム `anime.js@3.2.2` の LICENSE は `2019` と記載されており、min ファイルのヘッダーと一致しません。以下はアップストリームの LICENSE に基づく補記です（2019 を採用）：

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

### acorn@8.18.0（`client/vendor/es3-parser/`、es3-parser としてベンダリング）

acorn の dist 成果物は、ファイル内に作者とライセンス名の注記のみを残しており、ライセンス全文は含みません（同ディレクトリの `README.md` に出所の説明があります）。以下はアップストリームの npm パッケージ `acorn@8.18.0` の LICENSE に基づく補記です（原文の著作権行が参照する `AUTHORS` ファイルは本ツリーに含まれません。アップストリームのリポジトリを参照してください）：

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

ライセンス全文はソースツリーとともに提供されます：`native/glsl-host/third_party/glad/LICENSE`（アップストリーム `Dav1dde/glad` v0.1.36 の原本、ツリー内は 3,077 B。アップストリームの LF 版は 3,014 B で、ツリー内は CRLF のチェックアウトです）。このファイルは 3 つの部分から成ります：

- **glad 本体**：MIT、`Copyright (c) 2013-2021 David Herberth`。
- **The Khronos Specifications**：`Copyright (c) 2013-2020 The Khronos Group Inc.`、`Licensed under the Apache License, Version 2.0`。
- **The EGL Specification and various headers**：`Copyright (c) 2007-2016 The Khronos Group Inc.`（Khronos の MIT 形式ライセンス）。

`include/KHR/khrplatform.h` には Khronos ライセンスの原文が含まれています（`Copyright (c) 2008-2018 The Khronos Group Inc.`）。

### pako 1.0.11（`vendor/node_modules/pako/`、Zlib ライセンス）

pako のライセンスは `MIT AND Zlib` です。MIT の全文はパッケージに同梱されており（`pako/LICENSE`）、Zlib 部分のアップストリームのテキストは npm パッケージに添付されていません。以下は zlib 公式リポジトリの `LICENSE` の標準的な全文です：

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

### PDF.js 6.1.200（Apache-2.0、`vendor/node_modules/unpdf/dist/pdfjs.mjs` に埋め込み）

`unpdf@1.8.0` は Mozilla PDF.js 6.1.200 の serverless ビルド（`dist/pdfjs.mjs`、約 1.6 MB）を同梱しています。このファイルは Apache-2.0 でライセンスされ、アップストリームの `unpdf` パッケージはそのライセンステキストを添付していません。アップストリームの著作権表示：`Copyright 2012 Mozilla Foundation` および PDF.js の貢献者。本プロジェクトの MIT ライセンスはこの埋め込みコードを対象に含みません。`vendor/node_modules/unpdf/` を含む Release 完全パッケージを配布する際は、本段落と下記の Apache-2.0 全文を併せて提供する必要があります。

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

### cssfilter（`client/vendor/xss/` のバンドルにインライン化）

`client/vendor/xss/xss.min.js` のバンドルファイルには cssfilter（js-xss の CSS フィルタリング依存関係、MIT）がインライン化されています：

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

### Feather Icons（`client/` のインラインアイコン）

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

### Lucide（`client/` のインラインアイコン）

以下はアップストリーム `lucide-icons/lucide` の `LICENSE` 全文です（著作権行の年はアップストリームのバージョンに追随して更新されます。ここに列挙するアイコンは Feather に由来し、Feather の MIT 全文を併記します）：

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
