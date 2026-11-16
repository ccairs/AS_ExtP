# AS_ExtP 開発者ドキュメント

[简体中文](DEVELOPMENT.md) | [English](DEVELOPMENT.en.md) | **日本語** | [Deutsch](DEVELOPMENT.de.md) | [한국어](DEVELOPMENT.ko.md) | [Français](DEVELOPMENT.fr.md) | [Русский](DEVELOPMENT.ru.md)

ソースコードを読み、コードを変更し、あるいはネイティブコンポーネントを自分でビルドする人向けです。インストールと使い方は [README.md](../README.md) を参照してください。

本ドキュメントは二次開発向けで、技術アーキテクチャ、環境の準備と検証、配置、ローカライゼーション（Localization）、ネイティブコンポーネントのビルド、Hotbox 開発資料の順に説明します。

サードパーティコンポーネントのライセンス、素材の出所、配布の方針は [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) を参照してください（ソースツリーと Release 完全パッケージに同梱されます）。本プロジェクトの MIT ライセンスは [LICENSE](../LICENSE) を参照してください。

## 1. 技術アーキテクチャ

AS_ExtP は **CEP パネル（CEF / Chrome 88） + ローカル Node Bridge** のアーキテクチャです：

```
CEP パネル (CEF, file://)
  │  8 つの機能モジュール + features（クイック実行バー / デスクトップペット / 外部接続認可インジケーター）
  │  共有／基盤レイヤー：AEFS · Bridge · ToolRegistry · AST ゲート（PromptBuilder は client/llm/、ContextManager は client/modules/agent/engine/、コンテナコンテキストは client/core/）
  ├── CSInterface.evalScript()  ──►  AE エンジン（host.jsx + host/api/*.jsx）が ExtendScript を実行
  ├── Node Bridge (127.0.0.1:9877, HTTP + WebSocket)
  │     ├─ ファイルシステム（全読み書き、バイナリチャネルを含む）
  │     ├─ 外部 MCP プロセスの管理
  │     └─ /mcp エンドポイント（外部接続モードの Streamable HTTP 転送）
  └── 外部接続モード：外部 Agent ⇄ stdio / HTTP ⇄ Bridge relay ⇄ パネル ⇄ AE
```

- **ファイルシステム（AEFS）**：`client/shared/aefs.js` が統一的なファイル読み書きを提供し、**Bridge → cep.fs → ExtendScript** の多段フォールバックを採用しています。パスに対しては多段の安全チェックを行います（`%`、制御文字、`..` による遡り、非絶対パス、DOS デバイス名を拒否。書き込み／削除の操作は安全なディレクトリの許可リスト内に限定）。
- **AST コンパイルゲート**：AI が生成したスクリプト、またはユーザーが保存したスクリプトは、実行前にすべて共通の静的コンパイルゲートを通ります——ExtendScript 方言の前処理 → acorn（ES3）による解析 → 型とメンバーの許可リスト検証 → 再出力して実行。検証と実行は同一のコードで、「検証後に書き換える」時間窓はありません。4 つの入口（Agent のツール呼び出し、プレビュー領域、JSON ツール定義、スクリプトツリー／クイック実行バー）はすべてここに集約され、危険な形態はゲート側でブロックしてモデルに差し戻し、書き換えさせます。「Agent モジュール設定 → AST ゲートの権限設定」でチャネルの信頼、権限ドメインのスイッチ、許可リストの追加テーブルを確認できます。このうちスクリプトツリー／クイック実行バー（`user-library`）は監査モードで、ゲートは危険リストを出力するだけでコードは書き換えません（`client/modules/ast-gate/run.js` を参照）。
- **データディレクトリ**：拡張機能のルートディレクトリは読み取り専用で、実行データは `%APPDATA%\Adobe\CEP\extensions\AS_ExtP` に保存されます（スクリプト、スキル、記憶、ツール、エフェクト、プリセットなど）。グローバル設定で任意の場所に変更できます：切り替えは**全体のコピー**です（移行先にデータがある場合は先に上書き確認のダイアログが表示され、確認後に移行先のデータを削除してからコピーします）。最後に、コピーしてきた**ライブラリ索引**（`assets/<ライブラリ>/*.json`）内の旧ルートで始まる絶対パスを**新しいルートに書き換え**ます——そうしないと、新しいディレクトリの起動時にディスクを走査した際、同名のファイルが「未登録」として重複登録されます（プリセット／プロジェクトアセットで重複登録の事例があります）。旧ディレクトリは自動では削除されないため、ユーザーが確認したうえで自身で削除してください。**ライブラリを追加する際の注意**：索引にはライブラリ内ファイルの絶対パスを保存しないでください（相対パスを保存するか、実行時にデータディレクトリから算出してください）。絶対パスを保存する必要がある場合は、移行の最後に同じ書き換えが必須です（`client/shared/dataDir.js` の `rebaseLibraryIndexPaths` を参照）。
- **プロンプトバス**：LLM に渡す最終プロンプトは 4 層で組み立てます（System Prompt の骨格 → PromptBuilder のパイプライン → 履歴メッセージの注入 → User Prompt のラップ）。各モジュールは標準の注入ポイントを介して参加し、文字列を直接連結しません。
- **Node Bridge**：ファイル操作と MCP プロセスの管理を担い、アイドル時には自動で終了し、パネルが開いている間はハートビートで維持されます。外部接続モードの HTTP エンドポイントと stdio 入口は同一のプロトコルコアを共有し、ツール呼び出しはすべてパネルを経由して直列に実行されます（AE のスクリプトエンジンは単一スレッドです）。
- **診断ログ**：パネル／Bridge／ホスト／ネイティブコンポーネントの各プロセスのログは、ISO タイムスタンプと単一ファイルのサイズ上限を統一しています（Bridge のエラー行には `[ERR]` マークが付きます）。診断パッケージの書き出し時には一括でマスク処理を行い、シグネチャごとに重複行をまとめます（同じシグネチャがしきい値に達した場合は先頭の 1 件のみを残し、合計回数と時間範囲を付記します）。グローバル設定から書き出せます。

### AEFS 例外リスト

パネル側（CEP）のファイル I/O はすべて AEFS を経由します。リポジトリ全体を再点検した結果、例外は host / ExtendScript 側に集中しており、**2 種類・7 か所のファイル削除呼び出し**があります（パネル側の JS は例外ゼロ）：

1. **起動チェーンの自己クリーンアップ（5 か所、構造上 AEFS を経由できない）**：`host/host.jsx` の `_sweepHandoffLeftovers`（持ち主のいない引き継ぎトークン、vbs、多重起動検出スクリプト `.axd` を掃除）、`startBridge` の末尾での `vbsFile` の削除、`_runAxDetectionProbe` での今回書き込んだ `.axd` 検出スクリプトの削除、`_clearMultiInstanceMarker` での `ae_extp_multi_instance.json` の削除、`_writeHostLoadErrors` での失敗がない場合のハンドシェイクファイルの削除——AEFS はパネル側のモジュールであり、削除インターフェイスは Bridge / CEP に依存しますが、これらの呼び出しが走るのは「まだ Bridge がない」時か、起動時の自己点検の締めくくりの段階です。パス = データディレクトリの `temp/handoff`（フォールバックとしてシステムの一時ディレクトリ）、削除するのはいずれも起動チェーンが自ら生成したファイル（引き継ぎトークン / vbs / `.axd` 検出スクリプト、多重起動マーカー、前回の読み込みエラーレポート）です。防御線 = 厳密なファイル名の正規表現、ファイルのみを削除（同名のディレクトリはスキップ）、掃除の対象は `mtime` が 10 分を超えた残存物のみ。
2. **書き出しフローの「旧版を消してからコピー」（2 か所、時系列上 AEFS を経由すべきでない）**：`host/api/projectAssetApi.jsx` の `exportWholeProject` / `exportCompOrLayer` に各 1 か所、同名のフッテージを再コピーする前にパッケージ内の旧コピーを削除します。削除の位置は ES 側フローの途中（コピーの前）で、パネルに任せると「クリーンアップと書き出しの間の競合」が入り込みます。そのため host 側での削除を残しますが、削除前に `_ensureUnderRoot(dstPath, footageDir.fsName)` で AEFS の `_checkPath` とコンテナ判定を再現します（`%`、制御文字、引用符、DOS デバイス名、`..` セグメントを拒否。footageDir の子パスであること）。範囲外の場合はログを残すだけで削除しません。

## 2. 環境の準備と検証

> **2 つの入手方法では前提が異なります**：**Release 完全パッケージはすぐに使えます**（Node ランタイム、npm の依存関係、ビルド済みの `.aex` を同梱）。展開後に `tools\install.bat` をダブルクリックすれば配置が完了するため、この節は読み飛ばせます。**ソースのクローンはすぐには使えません**。以下に示す Node、`npm ci`、`check-env.bat`（Node / ffmpeg のダウンロード）が必要で、必要に応じてネイティブコンポーネントもビルドします。

- Node.js **≥ 20.18**（パネル側の CEF は Chrome 88 で、Node ランタイムはありません。パネル内では `require` / `process` が存在せず、ファイル I/O はすべて AEFS を経由します）
- 依存関係のインストール：`npm ci`。または `tools\check-env.bat` をダブルクリックします（Node、依存関係、ffmpeg、AE のバージョンを項目ごとに点検し、不足分の補い方を示します）
- `npm run lint` — ESLint によるチェック（`eslint.config.js`）
- `npm run audit:theme` / `npm run audit:family` — テーマのハードコードと失効した故障モード族の監査（CI のゲート）
- 公開リポジトリの CI（`.github/workflows/ci.yml`）は 2 つのジョブに分かれます：`lint-and-audits` は `npm ci` → `lint` → 2 つの監査を実行し、`release-tree-check` は依存関係をインストールしていないクリーンなチェックアウトで `node tools/release-check.js --public . --public-only` を実行します（公開ツリーにバイナリがゼロ、`node_modules` / `vendor` を含まない、NOTICES が完全）。いずれかの手順が失敗した時点で失敗（赤）になります

## 3. CEP への配置

2 つのスクリプトは役割が異なります：

- **初回インストール / 一般ユーザー**：`tools\install.bat` をダブルクリックします。インストール済みの AE を自動検出し、Node と ffmpeg をダウンロードし、`PlayerDebugMode` を書き込み、`deploy\Plug-ins\*.aex` を検出するとネイティブコンポーネントを自動で配置します。
- **開発期の更新配置**：`host` / `client` / `CSXS` やネイティブコンポーネントを変更したあと、`tools\deploy.bat` をダブルクリックします（管理者権限が必要で、これらを `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\AS_ExtP` にコピーします）。ダウンロードとレジストリ設定は行わず、`vendor\` が存在していることが前提です。存在しない場合は先に `tools\check-env.bat` を実行するよう通知します。

どちらのスクリプトも、`vendor\node_modules` が存在しない場合はソースディレクトリのルート `node_modules` からコピーして補完します——配置後の Bridge は `vendor\node_modules` から依存関係を解決します（docx / xlsx / pdf 添付ファイルの解析）。

## 4. ローカライゼーション（Localization）

パネルの表示は、小さなランタイムと生成された言語パックでローカライズしています。中国語の原文がそのままキーになります（`t('源文')`）。そのため未翻訳の文字列は消えずに中国語の原文へフォールバックします。

> `i18n/`、`tools/i18n/`、`tests/` はメンテナー用リポジトリにのみ存在し、公開ツリーには含まれません。公開ツリーに入るのは `client/shared/i18n/locales/` 配下で生成された言語パックだけです。以下のコマンドはメンテナー向けです。

### 言語の選択

- グローバル設定 → **表示言語**（`globalUiLocale`）：他のグローバル設定とともに `uiLocale` の下に保存され、`localStorage['ae_ui_locale']` にミラーされます。起動時は後者から値を取得します。
- 選択できる値：**After Effects の表示言語に合わせる**（`auto`）、简体中文（`zh-CN`）、English（`en-US`）、日本語（`ja-JP`）、Deutsch（`de-DE`）、한국어（`ko-KR`）、Français（`fr-FR`）、Русский（`ru-RU`）。
- `auto` は CEP の `getHostEnvironment().appLocale` で解決し、取得できない場合は `navigator.language` にフォールバックします。既知だが未対応のホスト言語は `en-US` として解決されます。読み取れない場合は `zh-CN` のままです。
- 別の値を保存するとパネルが再読み込みされます（設定行に説明があります）。ほかの手順は不要です。

### ファイル

| パス | 役割 |
| --- | --- |
| `i18n/keys.json` | 実行時に照会されるすべてのキー（`AEI18n.t(...)` / `AEI18n.html(...)` の文字列リテラルに、`client/index.html` のテキストを加えたもの）。`scan-keys.js` が生成 |
| `i18n/translations/en-US.json` | `en-US` の訳文（原文 → 訳文） |
| `client/shared/i18n/locales/en-US.js` | 生成された言語パック。静的読み込み |
| `client/scripts.manifest.js` | 読み込み順：言語パックは i18n グループの先頭に置き、`AEI18nPending` を介して辞書を `i18nCore` に渡す |
| `client/shared/i18n/i18nCore.js` | ランタイム：`t` / `html` / `err`、言語の解決、静的 DOM の翻訳 |
| `client/shared/i18n/i18nHtml.js` | HTML テンプレート内のテキストノードと許可リスト属性を収集して翻訳 |
| `client/shared/i18n/errorCodes.js` | エラーコードのメッセージ表 |

`i18n/` と `tools/i18n/` は開発側でのみ使用し、公開ツリーには含まれません。公開ツリーに入るのは `client/shared/i18n/locales/` 配下で生成された言語パックだけです。

### コマンド

```bash
node tools/i18n/scan-keys.js                 # ソースツリーを再スキャン → i18n/keys.json
node tools/i18n/build-locale.js en-US        # 訳文を検証 → client/shared/i18n/locales/en-US.js
node tools/i18n/check-coverage.js en-US      # ゲート：キーが揃っていること、余分なキーがないこと（不一致時は終了コード 1）
```

`build-locale.js` は、訳文が空の場合、`{placeholder}` の集合が原文と一致しない場合、またはキーが `keys.json` にない場合にはファイルを書き込まず、終了コード 1 で終了します。UI の文言を変更したら、メンテナー用リポジトリで上記の順にこの 3 つのコマンドを実行し、続けて `npm test` と `npm run lint` を実行してください。

### 対応言語

`zh-CN`（原文）、`en-US`、`ja-JP`、`de-DE`、`ko-KR`、`fr-FR`、`ru-RU`。ランタイムは 7 つの id をすべて受け付けます。パネルの言語選択には常に 7 項目が並び、実際に同梱される言語パックとは関係ありません。`en-US`、`ja-JP`、`de-DE`、`ko-KR`、`fr-FR`、`ru-RU` はいずれも完全です（各 3450 キー、カバレッジ 100％）。

### 対象範囲と制限

- **実行環境の事実を示す行（`ENV_LINE`、`client/modules/agent/engine/prompts.js` の `envLine()` が生成）**：システムプロンプトにはホストである AE の表示言語を明記します（`中文版` / `英文版` / `日文版` / `德文版` / `韩文版` / `法文版` / `俄文版`）。値は `getHostEnvironment().appLocale` から取得し、唯一の出所は `client/modules/agent/engine/prompts.js` です。これはホストの事実を記述するもので、パネルの表示言語やモデルの回答言語とは関係ありません。
- **ExtendScript のメッセージ**：`host/*.jsx` が送出するエラーは中国語のままです。これらは `CSInterface.evalScript()` を通じて純粋な文字列として渡され、言語のネゴシエーションには参加しないため、英語の UI でも中国語のまま表示されます。ローカライズされているのはパネル側のエラーコードのマッピングだけです。
- **AST ゲートの診断**：`client/modules/ast-gate/` の `error.reason` / `error.alternative` は中国語のままです——これらは LLM に差し戻す自己修正用の入力（`llmText`）です。原文以外の言語では、パネル上の表示（ステータスバー、実行エラーカード、クイック実行バー）に `client/shared/i18n/gateReasons.js` のローカライズされたカテゴリ文を表示します。中国語の原文の詳細が表示されるのは、UI の言語が簡体字中国語の場合だけです。
- **インストールスクリプト**：`tools/install.bat`、`tools/check-env.bat`、`tools/deploy.bat` は ASCII の英語のみを出力します（スクリプトは `chcp 437` に切り替えます）。スクリプトのコメントは中国語でもかまいません。公開ツリーでは技術的なコメントは残し、説明的なコメントは公開用コメントのマッピングで書き換えるか削除します。
- **ネイティブコンポーネントの UI**：`native/hotbox`（AS_Hotbox）と `native/glsl-host`（AS_Effect Host）のユーザーに表示されるテキスト——Hotbox のフィルター／設定、エフェクトのパラメーター名、About、エラーフレーム、ファイルダイアログ——は、**After Effects ホストの表示言語**（`PF_AppGetLanguage`）に追従し、パネルの表示言語設定とは独立しています。ホストの言語が未対応の場合は英語に、ホストの言語を取得できない場合は中国語にフォールバックします。ログと内部診断は翻訳しません。技術トークンを含む警告（`[uniform limit reached]` など）は英語のまま残し、それ以外のユーザー向けの警告は既にローカライズされています。

## 5. ネイティブコンポーネントのビルド

2 つのネイティブコンポーネントはいずれも C++ / CMake のプロジェクトで、**Visual Studio 2022（MSVC を含む）と Adobe After Effects SDK が必要**です——SDK はそのライセンスによりリポジトリに同梱されないため、Adobe から自分で入手してください。

### 5.1 GLSL エフェクトホスト（`native/glsl-host/`）

```powershell
cmake -S native/glsl-host -B native/glsl-host/build -DAEFX_SDK_PATH="<AE SDK パス>"
cmake --build native/glsl-host/build --config Release
```

### 5.2 AE Hotbox（`native/hotbox/`）

```powershell
cmake -S native/hotbox -B native/hotbox/build -DAEFX_SDK_PATH="<AE SDK パス>"
cmake --build native/hotbox/build --config Release
```

生成物はデフォルトで `deploy/Plug-ins/` に出力されます（`-DAE_PLUGIN_OUTPUT=<ディレクトリ>` で変更できます）。`.aex` を AE の `Support Files\Plug-ins\` ディレクトリにコピーし、**AE を完全に終了して再起動**すると有効になります。ネイティブロジックの単体テストは `ctest` でビルドディレクトリ内で実行し、AE は不要です。

## 6. Hotbox 開発資料

> この節は Hotbox のビルド／配置／トラブルシューティングの説明です。ユーザー向けの使い方は README の「ネイティブコンポーネント → AE Hotbox」を参照してください。

#### .aex のビルド

前提：AE 2023+ SDK、Visual Studio 2022、CMake 3.20+。

```powershell
# リポジトリのルートで
cmake -S native/hotbox -B native/hotbox/build `
  -DAEFX_SDK_PATH="<AE SDK パス>" `
  -DAE_PLUGIN_OUTPUT="<リポジトリ>\deploy\Plug-ins"
cmake --build native/hotbox/build --config Release
```

生成物：`deploy\Plug-ins\AS_Hotbox.aex`。

#### AE への配置

1. **AE を完全に終了**します（新しいプラグインは再起動しないと読み込まれません）。
2. `AS_Hotbox.aex` を AE の `Support Files\Plug-ins\` ディレクトリにコピーします：

```powershell
Copy-Item "<リポジトリ>\deploy\Plug-ins\AS_Hotbox.aex" `
  "<AE インストールディレクトリ>\Support Files\Plug-ins\" -Force
```

3. 同時に、CEP 拡張機能が配置済みであることを確認します（`tools\deploy.bat` または `tools\install.bat`）：Hotbox は拡張機能のデータディレクトリにあるスクリプトとプリセットの索引を読み、AE 自身のプリセットディレクトリも直接読みます（位置の決め方は後述の「データソース」を参照）。
4. AE を起動します。

#### 読み込みの確認

AE を起動したら、ログ `<データディレクトリ>\temp\logs\as_hotbox.log` を確認します。次のように表示されていれば正常です：

```
EntryPointFunc OK
window: init ok
hotkey: registered Alt+Q
```

ホットキーが使用中の場合、ログには `hotkey: configured ... in use, fallback default` が出力され、`Alt+Q` にフォールバックします。`Alt+Q` も使用中の場合は `hotkey: default Alt+Q also failed` となり、プラグインは読み込まれますがホットキーは使えません（設定パネルでキーを変更してください）。

---


#### 設定ファイル

設定は `<データディレクトリ>\hotbox\config.json` に保存されます：

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

- `slots`：ジェスチャーリングの 6 つの弧の区画に 1 対 1 で対応します（`null` = 動的スロット）。真上（スクリーンショットの入口）と真下（設定の入口）は専用の区画で、スロットの割り当てには参加しません。設定パネルの 4 行は残りの 4 区画（左上 / 左下 / 右上 / 右下）に対応し、区画と配列の添字の対応はレイアウトに応じて固定です。
- `hotkey.mods`：ビットフラグで、1=Alt 2=Ctrl 4=Shift（Win32 の `MOD_*` と一致）。
- `hotkey.vk`：仮想キーコード（例：81 = 'Q'）。
- `releaseExecute`：ホットキーを離したときに選択中の区画を実行するか（設定行 5、デフォルト true）。
- `releaseStay`：ホットキーを離したあとフローティングウィンドウに留まるか（設定行 6、デフォルト false。使い方は README の「AE Hotbox」を参照）。

最近使用のリストは `<データディレクトリ>\hotbox\recent.json` に保存されます。

> **データディレクトリ**のデフォルトは `%APPDATA%\Adobe\CEP\extensions\AS_ExtP` です。

---

### データソース

Hotbox はローカルファイルを直接読みます（AEGP は AE と同じプロセスで動作し、Bridge に依存せず、拡張パネルが開いている必要もありません）：

| データ | ソース | 説明 |
|------|------|------|
| エフェクト | AEGP ネイティブ列挙（`AEGP_EffectSuite4`） | AE のメモリ上にあるインストール済みエフェクトのテーブルで、Effects メニューと同じ出所。表示名 + matchName を取得 |
| スクリプト | `agent\scripts\` を再帰 | `.jsx` / `.jsxbin` |
| プリセット（拡張ライブラリ） | `assets\presets\index.json` | パネルから取り込んだ `.ffx`（実体はライブラリディレクトリ内）。名前 + フォルダー + ffx パス |
| プリセット（AE 付属） | `<AE>\Support Files\Presets\` を再帰 | AE の Effects & Presets パネルと同じ出所 |
| プリセット（AE ユーザー） | `文档\Adobe\After Effects <バージョン>\User Presets\` を再帰 | AE の「アニメーションプリセットを保存」の保存先。ディレクトリが存在しない場合は対象外 |

- **3 系統のプリセットの統合**：優先順位 = 拡張ライブラリ > AE のユーザープリセット > AE の付属プリセット。重複排除のキー = 小文字の名前 + ファイルのバイト数、つまり
  「同名で同じサイズ = 同一プリセットの複製」です（パネルからの取り込みは `.ffx` をバイト単位でライブラリにコピーするため、複製は出所と同名・同サイズになります）。
  名前だけで重複排除はできません。AE の付属プリセットには同名で内容が異なる項目が実際に 2 件あります（例：「百叶窗」191231/26526 バイト、
  「放大」43417/75976 バイト）。名前だけで判定すると実在する項目を失います。AE 側の項目は読み取りのみでコピーせず、適用は
  `layer.applyPreset(File)` を経由し、ライブラリ内のプリセットと同じ経路です（そのため AE のプリセットもジェスチャーリングのスロットに割り当てられます）。
- **ライブラリ側の size は実ファイルを基準**：索引の `size` は取り込み時点の記録で、再読み込み時にファイルの実バイト数で補正し、
  ファイルが既に存在しない（またはパスがディレクトリを指す）場合は「不明」として扱います——古い値で AE 側の同名・同サイズの実在項目をまとめて除外してはいけません。
  そうしないと、ライブラリ内の `.ffx` を削除したあと、Hotbox には必ず適用に失敗する項目だけが残り、使える AE のプリセットがそれに置き換えられてしまいます。
- **アーカイブ済みの項目は Hotbox に出さない**：索引で `archived=true` の項目（実体は `___archive__` に移動済みで、7 日後に物理削除）
  はパネルのクイック実行バーと同じ基準で除外し、AE 側の同名の実在項目を置き換えないようにします。
- **AE のプリセットディレクトリの特定**：プラグイン自身のモジュールパスから導出することを優先し（`<AE>\Support Files\Plug-ins\...` → インストールルート）、
  MediaCore など標準外の場所にインストールされている場合にのみ、AE の `app.path` に問い合わせます（拡張機能の `ae-tools` の
  `getInstallPath` と同じ出所）。どちらも取得できない場合は拡張ライブラリのみを使い、その他の機能には影響しません。
- エフェクト一覧は AE のプロセス内で列挙して取得します（ExtendScript を経由せず、ディスク上の索引も読みません）。新しくインストールしたプラグインは、キャッシュを一切生成しなくても検索できます。
- `ae-tools\effects_cache.json` はエフェクト一覧の主なデータソースではなくなり、ネイティブの列挙が空を返した場合（AEGP が未準備）にのみフォールバックとして使います。
- 更新の基準：データソースのシグネチャ（インストール済みエフェクト数 + `index.json` の mtime + スクリプトのディレクトリツリー + 2 つの AE プリセットディレクトリツリー）が変わっていない場合、
  繰り返し呼び出してもメモリ上の一覧とピンイン索引をそのまま再利用します。スクリプト／プリセットの追加・削除・変更、および AE でプリセットをユーザープリセットディレクトリに保存した場合は、
  シグネチャが一致しなくなり自動で再読み込みされます（AE の再起動は不要）。シグネチャの走査は呼び出すたびに実行し、付属ディレクトリの全走査はシグネチャが一致しない場合にのみ行い、
  どちらのコストもプリセット／スクリプトの項目数に比例し、呼び出し回数が増えても累積しません。
- プラグインの読み込み後、最初のアイドル時（2 秒以上）にデータを 1 度だけ事前準備します（列挙 + ピンイン索引）。初回読み込みのコストをキー入力の経路から外します。

#### エンコーディングの制約

- プロジェクト内部のパスと名称は UTF-8 のナロウ文字列で統一します。ファイルを開く処理はすべてワイド文字 API を使用します（`native/hotbox/src/data.h` の `utf8ToWide` と `log.h` のワイドパス呼び出し）——ナロウな `char*` のパスはシステムが ANSI/GBK として解釈するため、中国語を含むパスは開けません。
- AE の AEGP `A_char` 文字列（エフェクト名 / 分類）は SDK の規約によりシステム ANSI です。1 つの文字列だけではエンコーディングを判定できないため、まとまったデータはまずバッチ全体で ANSI / UTF-8 を判定してからデコードします（`data.h` の `isAnsiBatch` / `ansiToUtf8`）。新しいデータソースを追加する場合も同じ基準に従ってください。`A_char` をそのまま UTF-8 として扱ったり、そのままパスに連結したりしないでください。

---

### トラブルシューティング

#### ログの場所

`<データディレクトリ>\temp\logs\as_hotbox.log` — プラグインの読み込み、ホットキーの登録、実行結果、エラー情報を記録します。データディレクトリのデフォルトは `%APPDATA%\Adobe\CEP\extensions\AS_ExtP` です（「設定ファイル」の節を参照）。データディレクトリを変更すると、ログもそれに追従します。

#### よくある問題

| 症状 | 確認方法 |
|------|------|
| ホットキーを押しても反応しない | ログを確認：`hotkey: registered ...` が成功しているか。AE が最前面にあるか（最前面でないと動作しません） |
| ホットキーが使用中 | ログに `hotkey: configured ... in use, fallback default`（デフォルトの組み合わせにフォールバック）または `hotkey: default Alt+Q also failed` が出ている。設定パネルで新しい組み合わせを記録します。記録時にキーを押しても**まったく反応しない**場合は、その組み合わせが他のプログラムに使用されています（システムレベルの排他で、キー入力が届きません）：組み合わせを変えるか、使用しているプログラムを終了してください |
| フローティングウィンドウに`扩展未启动`と表示される | CEP 拡張機能が配置されていません。`tools\deploy.bat` を実行するか、AE で AS_ExtP パネルを開いてください |
| 検索しても結果が出ない | キーワードを入力したか（空のクエリでは項目を表示しません）。`agent\scripts\` にスクリプトがあるか。`assets\presets\index.json` が存在するか |
| エフェクトの適用に失敗する | レイヤーが選択されているか。コンポジションが開いているか |
| ホットキーを離してもフローティングウィンドウが閉じない | 設定パネルの `松手停留`（離した後の待機）がオン（config.json の `releaseStay`）。`Esc`／フローティングウィンドウの外側をクリック／ホットキーの再押下で閉じるか、設定パネルでオフにしてください |
| AE の終了時にクラッシュする | ログに `DeathHook` が出ているか確認します。イベントビューアーも確認してください |
| マルチディスプレイで位置がおかしい | フローティングウィンドウはマウスがあるディスプレイのワークエリアに合わせてクランプされます。サブディスプレイ上のマウス位置からはみ出さないのが正常です |
| 中国語の入力がおかしい | 検索ボックスは Win32 の EDIT コントロールを使用しており、IME の変換候補を利用できます。変換中に `Enter` を押しても先に実行されることはありません |

#### 再配置の手順

C++ のコードを変更したあと：

```powershell
# 1. AE を終了
# 2. 再ビルド
cmake --build native/hotbox/build --config Release
# 3. .aex を AE にコピー（上書き）
Copy-Item "deploy\Plug-ins\AS_Hotbox.aex" "<AE インストールディレクトリ>\Support Files\Plug-ins\" -Force
# 4. AE を起動（完全な再起動が必要。タスクマネージャーで AfterFX.exe の終了を確認）
```

ExtendScript（`host/api/effectApi.jsx` など）を変更したあと：

```powershell
# deploy.bat を実行して CEP 拡張機能ディレクトリの host ファイルを更新
tools\deploy.bat
# AE の再起動は不要。次回の呼び出しで新しいスクリプトが自動的に読み込まれる
```

---

### 技術アーキテクチャ

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ native/hotbox/  AEGP プラグイン（C++20 + MSVC、GeneralPlug）                              │
│  ├─ ホットキーエンジン   RegisterHotKey + 非表示メッセージウィンドウ ← WM_HOTKEY          │
│  │              → GetCursorPos でマウス座標を取得                                         │
│  ├─ フローティングウィンドウ   WS_POPUP + WS_EX_TOPMOST + レイヤードウィンドウ透過        │
│  │              ├─ ジェスチャーモード：中央の円 + 弧の区画リング（Direct2D）              │
│  │              └─ 検索モード：横長の検索バー + リニアなリスト + フィルタードロップダウン │
│  ├─ 実行チャネル   AEGP_UtilitySuite6::AEGP_ExecuteScript                                 │
│  │              → effectApi.jsx / scriptRunner.jsx                                        │
│  └─ データ層     プロセス内でファイルを直接読み取る（std::ifstream + GetFileAttributesW） │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

主な制約：
- 実行チャネル `AEGP_ExecuteScript` は AE のメインスレッドを同期的にブロックします → 短いスクリプトを基本とし、実行中は状態を表示します。
- データの読み書きは Bridge を経由しません：プラグインはプロセス内でデータディレクトリ配下の設定ファイルとスクリプト索引を直接読み、Bridge はパネル側にのみ使われます。
- スクリプトの実行はすべてサンドボックスでラップし（`runScriptSandboxed`）、迂回するスイッチは提供しません。
