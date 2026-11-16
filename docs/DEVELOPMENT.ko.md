# AS_ExtP 개발자 문서

[简体中文](DEVELOPMENT.md) | [English](DEVELOPMENT.en.md) | [日本語](DEVELOPMENT.ja.md) | [Deutsch](DEVELOPMENT.de.md) | **한국어** | [Français](DEVELOPMENT.fr.md) | [Русский](DEVELOPMENT.ru.md)

소스 코드를 읽거나, 코드를 수정하거나, 네이티브 구성 요소를 직접 컴파일하려는 사람을 대상으로 합니다. 설치와 사용 방법은 [README.md](../README.md)를 참조하십시오.

이 문서는 2차 개발을 대상으로 하며, 기술 아키텍처, 환경 준비와 검증, 배포, 현지화(Localization), 네이티브 구성 요소 컴파일, Hotbox 개발 자료 순으로 설명합니다.

서드파티 구성 요소 라이선스, 소재 출처, 배포 기준은 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)(소스 트리와 Release 전체 패키지에 함께 배포됩니다)를 참조하고, 이 프로젝트의 MIT 라이선스는 [LICENSE](../LICENSE)를 참조하십시오.

## 1. 기술 아키텍처

AS_ExtP는 **CEP 패널(CEF / Chrome 88) + 로컬 Node Bridge** 아키텍처입니다:

```
CEP 패널 (CEF, file://)
  │  8개 기능 모듈 + features(빠른 실행 막대 / 데스크톱 펫 / 외부 접근 권한 표시기)
  │  공유/기반 계층: AEFS · Bridge · ToolRegistry · AST 게이트(PromptBuilder는 client/llm/, ContextManager는 client/modules/agent/engine/, 컨테이너 컨텍스트는 client/core/)
  ├── CSInterface.evalScript()  ──►  AE 엔진(host.jsx + host/api/*.jsx)이 ExtendScript 실행
  ├── Node Bridge (127.0.0.1:9877, HTTP + WebSocket)
  │     ├─ 파일 시스템(전체 읽기/쓰기, 바이너리 채널 포함)
  │     ├─ 외부 MCP 프로세스 관리
  │     └─ /mcp 엔드포인트(외부 모드의 Streamable HTTP 전송)
  └── 외부 모드: 외부 Agent ⇄ stdio / HTTP ⇄ Bridge relay ⇄ 패널 ⇄ AE
```

- **파일 시스템(AEFS)**: `client/shared/aefs.js`가 통합 파일 읽기/쓰기를 제공하며 **Bridge → cep.fs → ExtendScript** 다단계 폴백을 사용합니다. 경로에 대해서는 다중 안전 검사를 수행합니다(`%`, 제어 문자, `..` 상위 이동, 비절대 경로, DOS 장치 이름을 거부하고, 쓰기 / 삭제 작업은 안전 폴더 허용 목록 안으로 제한합니다).
- **AST 컴파일 게이트**: AI가 생성하거나 사용자가 저장한 모든 스크립트는 실행 전에 하나의 통합 정적 컴파일 게이트를 거칩니다 — ExtendScript 방언 전처리 → acorn(ES3) 파싱 → 타입 및 구성원 허용 목록 검증 → 재방출 실행. 검증과 실행이 같은 코드를 대상으로 하므로 “검증 후 변조”가 가능한 시간 창이 없습니다. 네 진입점(Agent 도구 호출, 미리 보기 영역, JSON 도구 정의, 스크립트 트리 / 빠른 실행 막대)이 모두 여기로 모이며, 고위험 형태는 게이트에서 차단되어 모델에 다시 전달되고 수정됩니다. “에이전트 모듈 설정 → AST 게이트 능력 구성”에서 채널 신뢰, 능력 영역 스위치, 허용 목록 추가 표를 확인할 수 있습니다. 이 중 스크립트 트리 / 빠른 실행 막대(`user-library`)는 감사 모드를 사용합니다: 게이트는 위험 목록만 산출하고 코드를 변조하지 않습니다(`client/modules/ast-gate/run.js` 참조).
- **데이터 폴더**: 확장 루트 폴더는 읽기 전용이며, 실행 데이터는 `%APPDATA%\Adobe\CEP\extensions\AS_ExtP`에 저장됩니다(스크립트, 스킬, 메모리, 도구, 효과, 사전 설정 등). 전역 설정에서 사용자 정의 위치로 변경할 수 있습니다: 전환 = **전체 복사**(대상에 이미 데이터가 있으면 덮어쓰기 확인을 먼저 띄우고, 확인하면 대상 데이터를 먼저 삭제한 뒤 복사합니다). 마무리 단계에서는 복사해 온 **라이브러리 인덱스**(`assets/<라이브러리>/*.json`) 안의, 이전 루트로 시작하는 절대 경로를 **새 루트로 다시 씁니다** — 그렇게 하지 않으면 새 폴더에서 시작할 때 디스크 스캔이 같은 이름의 파일을 “미등록”으로 보고 중복 등록합니다(사전 설정 / 프로젝트 에셋에 중복 등록 사례가 있습니다). 이전 폴더는 자동으로 삭제되지 않으므로 사용자가 확인한 뒤 직접 정리해야 합니다. **새 라이브러리를 추가할 때 주의**: 인덱스에 라이브러리 내부 파일의 절대 경로를 저장하지 마십시오(상대 경로로 저장하거나 실행 시 데이터 폴더를 기준으로 계산하십시오). 절대 경로를 저장해야 한다면 마이그레이션 마무리에서 같은 재작성 처리를 반드시 해야 합니다(`client/shared/dataDir.js`의 `rebaseLibraryIndexPaths` 참조).
- **프롬프트 버스**: LLM에 전달되는 최종 프롬프트는 네 계층으로 조립됩니다(System Prompt 골격 → PromptBuilder 파이프라인 → 기록 메시지 주입 → User Prompt 래핑). 각 모듈은 표준 주입점을 통해 참여하며 문자열을 직접 연결하지 않습니다.
- **Node Bridge**: 파일 작업과 MCP 프로세스 관리를 담당하며, 유휴 상태가 되면 자동으로 종료되고 패널이 열려 있는 동안 하트비트로 유지됩니다. 외부 모드의 HTTP 엔드포인트와 stdio 진입점은 같은 프로토콜 코어를 공유하며, 도구 호출은 모두 패널을 거쳐 직렬로 실행됩니다(AE 스크립트 엔진은 단일 스레드입니다).
- **진단 로그**: 패널 / Bridge / 호스트 / 네이티브 구성 요소 각 프로세스의 로그는 ISO 타임스탬프와 단일 파일 크기 상한을 공통으로 사용하며(Bridge 오류 줄에는 `[ERR]` 표시가 추가됩니다), 진단 패키지를 내보낼 때 일괄 마스킹하고 서명 기준으로 중복 줄을 접습니다(같은 서명이 임계값에 도달하면 첫 줄만 남기고 총 횟수와 시간 범위를 표시합니다). 전역 설정에서 내보낼 수 있습니다.

### AEFS 예외 목록

패널 측(CEP) 파일 I/O는 모두 AEFS를 사용합니다. 저장소 전체를 재검토한 결과 예외는 host / ExtendScript 측에 집중되어 있으며, 총 **두 종류 일곱 곳의 파일 삭제 호출 지점**이 있습니다(패널 측 JS는 예외가 없습니다):

1. **시작 체인 자체 정리(5곳, 구조상 AEFS를 쓸 수 없음)**: `host/host.jsx`의 `_sweepHandoffLeftovers`(주인 없는 핸드오프 token, vbs, 다중 인스턴스 탐지 스크립트 `.axd` 정리), `startBridge` 끝부분의 `vbsFile` 삭제, `_runAxDetectionProbe`의 이번에 기록한 `.axd` 탐지 스크립트 삭제, `_clearMultiInstanceMarker`의 `ae_extp_multi_instance.json` 삭제, `_writeHostLoadErrors`의 실패가 없을 때 핸드셰이크 파일 삭제 — AEFS는 패널 측 모듈이고 삭제 인터페이스가 Bridge / CEP에 의존하는데, 이 호출들이 실행되는 시점이 바로 “Bridge가 아직 없는” 시점이거나 시작 자체 점검의 마무리 단계입니다. 경로 = 데이터 폴더 `temp/handoff`(폴백은 시스템 임시 폴더)이며, 삭제 대상은 모두 시작 체인이 스스로 만든 파일입니다(핸드오프 token / vbs / `.axd` 탐지 스크립트, 다중 인스턴스 표시, 지난번 로드 오류 보고서). 방어선 = 정확한 파일 이름 정규식, 파일만 삭제(같은 이름의 폴더는 건너뜀), 정리 항목은 `mtime`이 10분을 넘은 잔여물만 회수합니다.
2. **내보내기 흐름의 “기존 사본 정리 후 복사”(2곳, 시점상 AEFS를 쓰기 어려움)**: `host/api/projectAssetApi.jsx`의 `exportWholeProject` / `exportCompOrLayer`에 각각 한 곳씩 있으며, 같은 이름의 푸티지를 다시 복사하기 전에 패키지 안의 이전 사본을 지웁니다. 삭제 지점이 ES 측 흐름 중간(copy 이전)에 있어 패널에 맡기면 “정리와 내보내기 사이의 경쟁 상태”가 생깁니다. 따라서 host 측 삭제는 유지하되, 삭제 전에 `_ensureUnderRoot(dstPath, footageDir.fsName)`로 AEFS의 `_checkPath`와 컨테이너 판정을 그대로 재현합니다(`%`, 제어 문자, 따옴표, DOS 장치 이름, `..` 세그먼트를 거부하고 footageDir 하위 경로여야 합니다). 범위를 벗어나면 로그만 남기고 삭제하지 않습니다.

## 2. 환경 준비와 검증

> **두 가지 취득 방식의 전제가 다릅니다**: **Release 전체 패키지는 바로 사용할 수 있으며**(Node 런타임, npm 의존성, 미리 컴파일한 `.aex`가 포함되어 있고, 압축을 푼 뒤 `tools\install.bat`을 두 번 클릭하면 배포가 끝나므로 이 절은 건너뛸 수 있습니다). 반면 **소스 클론은 바로 사용할 수 없으며**, 아래의 Node, `npm ci`, `check-env.bat`(Node / ffmpeg 내려받기), 그리고 필요에 따른 네이티브 구성 요소 컴파일이 필요합니다.

- Node.js **≥ 20.18**(패널 측 CEF는 Chrome 88이며 Node 런타임이 없습니다: 패널 안에는 `require` / `process`가 없고 파일 I/O는 모두 AEFS를 사용합니다)
- 의존성 설치: `npm ci`. 또는 `tools\check-env.bat`을 두 번 클릭합니다(Node, 의존성, ffmpeg, AE 버전을 항목별로 점검하고 보완 안내를 제공합니다).
- `npm run lint` — ESLint 검사(`eslint.config.js`)
- `npm run audit:theme` / `npm run audit:family` — 테마 하드코딩과 사라진 고장 모드 패밀리 감사(CI 게이트)
- 공개 저장소 CI(`.github/workflows/ci.yml`)는 두 개의 작업으로 나뉩니다: `lint-and-audits`는 `npm ci` → `lint` → 두 가지 감사를 실행하고, `release-tree-check`는 의존성을 설치하지 않은 깨끗한 체크아웃에서 `node tools/release-check.js --public . --public-only`를 실행합니다(공개 트리에 바이너리 없음, `node_modules` / `vendor` 미포함, NOTICES 완비). 어느 단계라도 실패하면 빨간색으로 표시됩니다

## 3. CEP에 배포

두 스크립트의 역할이 다릅니다:

- **최초 설치 / 일반 사용자**: `tools\install.bat`을 두 번 클릭합니다. 설치된 AE를 자동으로 탐지하고, Node와 ffmpeg를 내려받고, `PlayerDebugMode`를 기록하며, `deploy\Plug-ins\*.aex`가 감지되면 네이티브 구성 요소를 자동으로 배포합니다.
- **개발 중 업데이트 배포**: `host` / `client` / `CSXS` 또는 네이티브 파일을 변경한 뒤 `tools\deploy.bat`을 두 번 클릭합니다(관리자 권한이 필요하며, 이 항목들을 `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\AS_ExtP`로 복사합니다). 내려받기와 레지스트리 설정은 하지 않으며 `vendor\`가 이미 있어야 하고, 없으면 `tools\check-env.bat`을 먼저 실행하라고 안내합니다.

두 스크립트 모두 `vendor\node_modules`가 없으면 소스 폴더의 루트 `node_modules`에서 복사해 채웁니다. 배포 상태의 Bridge는 `vendor\node_modules`에서 의존성을 해석합니다(docx / xlsx / pdf 첨부 파일 파싱).

## 4. 현지화(Localization)

패널 인터페이스는 소형 런타임과 생성된 언어 팩으로 현지화됩니다. 중국어 원문이 곧 키이므로(`t('源文')`), 번역되지 않은 문자열은 사라지지 않고 중국어 원문으로 폴백됩니다.

> `i18n/`, `tools/i18n/`, `tests/`는 유지 관리자 저장소에만 있고 공개 트리에는 포함되지 않습니다. 공개 트리에는 `client/shared/i18n/locales/` 아래의 생성된 언어 팩만 포함됩니다. 아래 명령은 유지 관리자를 대상으로 합니다.

### 언어 선택

- 전역 설정 → **인터페이스 언어**(`globalUiLocale`): 다른 전역 설정과 함께 `uiLocale` 아래에 저장되고 `localStorage['ae_ui_locale']`로 미러링되며, 후자가 시작 시 값을 읽는 원천입니다.
- 선택 가능한 값: **After Effects 인터페이스 언어 따르기**(`auto`), 简体中文(`zh-CN`), English(`en-US`), 日本語(`ja-JP`), Deutsch(`de-DE`), 한국어(`ko-KR`), Français(`fr-FR`), Русский(`ru-RU`).
- `auto`는 CEP의 `getHostEnvironment().appLocale`로 해석하며, 값을 얻지 못하면 `navigator.language`로 폴백합니다. 알려져 있지만 지원하지 않는 호스트 언어는 `en-US`로 해석됩니다. 읽을 수 없으면 `zh-CN`을 유지합니다.
- 다른 값을 저장하면 패널이 다시 로드됩니다(설정 행에 설명이 있습니다). 그 밖의 절차는 필요하지 않습니다.

### 파일

| 경로 | 역할 |
| --- | --- |
| `i18n/keys.json` | 런타임이 조회하는 모든 키(`AEI18n.t(...)` / `AEI18n.html(...)`의 문자열 리터럴과 `client/index.html`의 텍스트), `scan-keys.js`가 생성 |
| `i18n/translations/en-US.json` | `en-US` 번역(원문 → 번역) |
| `client/shared/i18n/locales/en-US.js` | 생성된 언어 팩, 정적으로 로드 |
| `client/scripts.manifest.js` | 로드 순서: 언어 팩이 i18n 그룹의 맨 앞에 오며, `AEI18nPending`을 통해 사전을 `i18nCore`에 전달 |
| `client/shared/i18n/i18nCore.js` | 런타임: `t` / `html` / `err`, 언어 해석, 정적 DOM 번역 |
| `client/shared/i18n/i18nHtml.js` | HTML 템플릿 안의 텍스트 노드와 허용 목록 속성을 수집해 번역 |
| `client/shared/i18n/errorCodes.js` | 오류 코드 메시지 표 |

`i18n/`와 `tools/i18n/`는 개발 측에서만 사용하며 공개 트리에는 포함되지 않습니다. 공개 트리에는 `client/shared/i18n/locales/` 아래의 생성된 언어 팩만 포함됩니다.

### 명령

```bash
node tools/i18n/scan-keys.js                 # 소스 트리 다시 스캔 → i18n/keys.json
node tools/i18n/build-locale.js en-US        # 번역 검증 → client/shared/i18n/locales/en-US.js
node tools/i18n/check-coverage.js en-US      # 게이트: 키 누락 없음, 불필요한 키 없음(불일치 시 종료 코드 1)
```

`build-locale.js`는 번역이 비어 있거나, `{placeholder}` 집합이 원문과 다르거나, 키가 `keys.json`에 없으면 파일을 쓰지 않고 종료 코드 1로 끝납니다. 인터페이스 문구를 수정한 뒤에는 유지 관리자 저장소에서 위 순서대로 세 명령을 실행하고, 이어서 `npm test`와 `npm run lint`를 실행합니다.

### 지원 언어

`zh-CN`(원문), `en-US`, `ja-JP`, `de-DE`, `ko-KR`, `fr-FR`, `ru-RU`. 런타임은 일곱 개 id를 모두 받아들이며, 패널의 언어 선택기는 실제로 패키지에 포함된 언어 팩과 무관하게 일곱 항목을 고정으로 나열합니다. `en-US`, `ja-JP`, `de-DE`, `ko-KR`, `fr-FR`, `ru-RU`는 모두 완전합니다(각 3450키, 커버리지 100%).

### 범위와 제한

- **실행 환경 사실 줄(`ENV_LINE`, `client/modules/agent/engine/prompts.js`의 `envLine()`이 생성)**: 시스템 프롬프트에 호스트 AE의 인터페이스 언어(`中文版` / `英文版` / `日文版` / `德文版` / `韩文版` / `法文版` / `俄文版`)를 명시하며, 값은 `getHostEnvironment().appLocale`에서 가져옵니다. 유일한 출처는 `client/modules/agent/engine/prompts.js`입니다. 이 줄은 호스트의 사실을 서술하며 패널 인터페이스 언어, 모델 응답 언어와는 무관합니다.
- **ExtendScript 메시지**: `host/*.jsx`가 던지는 오류는 중국어를 유지합니다. 이 오류는 `CSInterface.evalScript()`를 통해 순수 문자열로 전달되어 언어 협상에 참여하지 않으므로, 영어 인터페이스에서도 중국어로 표시됩니다. 현지화되는 것은 패널 측 오류 코드 매핑뿐입니다.
- **AST 게이트 진단**: `client/modules/ast-gate/`의 `error.reason` / `error.alternative`는 중국어를 유지합니다 — LLM에 다시 전달되는 자체 수정 입력(`llmText`)이기 때문입니다. 원문 언어가 아닌 언어에서는 패널 표면(상태 표시줄, 실행 오류 카드, 빠른 실행 막대)에 `client/shared/i18n/gateReasons.js`의 현지화된 범주 문장이 표시됩니다. 중국어 원문 세부 정보는 인터페이스 언어가 简体中文일 때만 표시됩니다.
- **설치 스크립트**: `tools/install.bat`, `tools/check-env.bat`, `tools/deploy.bat`는 ASCII 영어만 출력합니다(스크립트가 `chcp 437`로 전환됩니다). 스크립트 주석은 중국어일 수 있습니다. 공개 트리는 기술적 주석을 유지하며, 서술형 주석은 배포 주석 매핑을 거쳐 다시 쓰이거나 삭제됩니다.
- **네이티브 구성 요소 인터페이스**: `native/hotbox`(AS_Hotbox)와 `native/glsl-host`(AS_Effect Host)의 사용자 표시 텍스트(핫박스 필터/설정, 효과 매개 변수 이름, About, 오류 프레임, 파일 대화 상자)는 **After Effects 호스트 인터페이스 언어**(`PF_AppGetLanguage`)를 따르며 패널의 인터페이스 언어 설정과는 무관합니다. 호스트 언어가 지원되지 않으면 영어로, 호스트 언어를 읽을 수 없으면 중국어로 대체됩니다. 로그와 내부 진단은 번역하지 않습니다. 기술 토큰이 포함된 경고(예: `[uniform limit reached]`)는 영어를 유지하며, 그 밖의 사용자 대상 경고는 현지화되어 있습니다.

## 5. 네이티브 구성 요소 컴파일

두 네이티브 구성 요소는 모두 C++ / CMake 프로젝트이며 **Visual Studio 2022(MSVC 포함)와 Adobe After Effects SDK가 필요합니다** — SDK는 라이선스에 따라 저장소에 함께 배포되지 않으므로 Adobe에서 직접 받아야 합니다.

### 5.1 GLSL 효과 호스트(`native/glsl-host/`)

```powershell
cmake -S native/glsl-host -B native/glsl-host/build -DAEFX_SDK_PATH="<AE SDK 경로>"
cmake --build native/glsl-host/build --config Release
```

### 5.2 AE 핫박스(`native/hotbox/`)

```powershell
cmake -S native/hotbox -B native/hotbox/build -DAEFX_SDK_PATH="<AE SDK 경로>"
cmake --build native/hotbox/build --config Release
```

산출물은 기본적으로 `deploy/Plug-ins/`에 출력됩니다(`-DAE_PLUGIN_OUTPUT=<폴더>`로 덮어쓸 수 있습니다). `.aex`를 AE의 `Support Files\Plug-ins\` 폴더로 복사하고 **AE를 완전히 종료한 뒤 다시 시작해야** 적용됩니다. 네이티브 로직의 단위 테스트는 빌드 폴더 안에서 `ctest`로 실행하며 AE가 필요하지 않습니다.

## 6. Hotbox 개발 자료

> 이 절은 Hotbox의 빌드 / 배포 / 문제 해결 설명입니다. 사용자용 사용법은 README의 “네이티브 구성 요소 → AE 핫박스” 절을 참조하십시오.

#### .aex 빌드

사전 준비: AE 2023+ SDK, Visual Studio 2022, CMake 3.20+.

```powershell
# 저장소 루트에서
cmake -S native/hotbox -B native/hotbox/build `
  -DAEFX_SDK_PATH="<AE SDK 경로>" `
  -DAE_PLUGIN_OUTPUT="<저장소>\deploy\Plug-ins"
cmake --build native/hotbox/build --config Release
```

산출물: `deploy\Plug-ins\AS_Hotbox.aex`.

#### AE에 배포

1. **AE를 완전히 종료합니다**(새 플러그인은 다시 시작해야 로드됩니다).
2. `AS_Hotbox.aex`를 AE의 `Support Files\Plug-ins\` 폴더로 복사합니다:

```powershell
Copy-Item "<저장소>\deploy\Plug-ins\AS_Hotbox.aex" `
  "<AE 설치 폴더>\Support Files\Plug-ins\" -Force
```

3. CEP 확장도 배포되어 있어야 합니다(`tools\deploy.bat` 또는 `tools\install.bat`). 핫박스는 확장 데이터 폴더의 스크립트와 사전 설정 인덱스를 읽고, AE 자체의 사전 설정 폴더도 직접 읽습니다(탐색 규칙은 아래 “데이터 원천” 참조).
4. AE를 시작합니다.

#### 로드 확인

AE를 시작한 뒤 로그 `<데이터 폴더>\temp\logs\as_hotbox.log`를 확인합니다. 다음이 나타나야 합니다:

```
EntryPointFunc OK
window: init ok
hotkey: registered Alt+Q
```

단축키가 이미 사용 중이면 로그에 `hotkey: configured ... in use, fallback default`가 나타나고 `Alt+Q`로 폴백합니다. `Alt+Q`마저 사용 중이면 `hotkey: default Alt+Q also failed`가 나타나며, 플러그인은 로드되지만 단축키를 쓸 수 없습니다(설정 패널에서 키를 변경해야 합니다).

---


#### 구성 파일

구성은 `<데이터 폴더>\hotbox\config.json`에 저장됩니다:

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

- `slots`: 제스처 링의 6개 호와 일대일로 대응합니다(`null` = 동적 슬롯). 정위(스크린샷 진입점)와 정하(설정 진입점)는 전용 호이며 슬롯 바인딩에 참여하지 않습니다. 설정 패널의 4개 행은 나머지 4개 호(좌상 / 좌하 / 우상 / 우하)에 대응하며, 호와 배열 인덱스의 대응은 레이아웃에 따라 고정됩니다.
- `hotkey.mods`: 비트 플래그, 1=Alt 2=Ctrl 4=Shift(Win32 `MOD_*`와 동일).
- `hotkey.vk`: 가상 키 코드(예: 81 = 'Q').
- `releaseExecute`: 단축키를 뗄 때 선택한 호를 실행할지 여부(설정 행 5, 기본 true).
- `releaseStay`: 단축키를 뗄 때 플로팅 창을 유지할지 여부(설정 행 6, 기본 false. 사용법은 README “AE 핫박스” 참조).

최근 사용 목록은 `<데이터 폴더>\hotbox\recent.json`에 저장됩니다.

> **데이터 폴더**의 기본값은 `%APPDATA%\Adobe\CEP\extensions\AS_ExtP`입니다.

---

### 데이터 원천

핫박스는 로컬 파일을 직접 읽습니다(AEGP가 AE와 같은 프로세스에서 실행되며, Bridge에 의존하지 않고 확장 패널이 열려 있을 필요도 없습니다):

| 데이터 | 원천 | 설명 |
|------|------|------|
| 효과 | AEGP 네이티브 열거(`AEGP_EffectSuite4`) | AE 메모리에 있는 설치된 효과 표이며, Effects 메뉴와 같은 원천입니다. 표시 이름 + matchName을 사용 |
| 스크립트 | `agent\scripts\` 재귀 | `.jsx` / `.jsxbin` |
| 사전 설정(확장 라이브러리) | `assets\presets\index.json` | 패널이 라이브러리에 등록한 `.ffx`(실제 파일은 라이브러리 폴더 안에 있음). 이름 + 폴더 + ffx 경로 |
| 사전 설정(AE 기본 제공) | `<AE>\Support Files\Presets\` 재귀 | AE의 Effects & Presets 패널과 같은 원천 |
| 사전 설정(AE 사용자) | `文档\Adobe\After Effects <버전>\User Presets\` 재귀 | AE “애니메이션 사전 설정 저장”의 저장 위치. 폴더가 없으면 포함하지 않음 |

- **사전 설정 세 원천 병합**: 우선순위 = 확장 라이브러리 > AE 사용자 사전 설정 > AE 기본 제공 사전 설정. 중복 제거 키 = 소문자 이름 + 파일 바이트 수, 즉
  “이름과 크기가 같으면 같은 사전 설정 사본”입니다(패널이 라이브러리에 등록할 때 `.ffx`를 바이트 단위로 복사하므로 사본은 원본과 이름과 크기가 같습니다).
  이름만으로 중복 제거하면 안 됩니다: AE 기본 제공 사전 설정에는 이름이 같고 내용이 다른 항목이 실제로 두 개 있습니다(예: “百叶窗” 191231/26526 바이트,
  “放大” 43417/75976 바이트). 이름만 기준으로 하면 실제 항목이 사라집니다. AE 측 항목은 읽기만 하고 복사하지 않으며, 적용은
  `layer.applyPreset(File)` 경로를 쓰며 라이브러리 내 사전 설정과 동일한 경로입니다(따라서 AE 사전 설정도 제스처 링 슬롯에 바인딩할 수 있습니다).
- **라이브러리 측 size는 실제 파일 기준**: 인덱스의 `size`는 등록 시점의 스냅숏이며, 다시 로드할 때 파일의 실제 바이트 수로 보정합니다.
  파일이 더 이상 없거나 경로가 폴더를 가리키면 “알 수 없음”으로 처리합니다 — 지난값으로 AE 측의 같은 이름·같은 크기 실제 항목을 접지 않습니다.
  그렇게 하지 않으면 라이브러리의 `.ffx`를 지운 뒤 핫박스에는 반드시 적용에 실패하는 항목 하나만 남고, 쓸 수 있는 AE 사전 설정은 그 항목에 밀려 사라집니다.
- **보관 처리된 항목은 핫박스에 포함되지 않음**: 인덱스에서 `archived=true`인 항목(실제 파일이 `___archive__`로 이동되었고 7일 뒤 물리적으로 정리됩니다)은
  패널 빠른 실행 막대와 같은 기준으로 제외하여, AE 측의 같은 이름 실제 항목을 밀어내지 않게 합니다.
- **AE 사전 설정 폴더 탐색**: 플러그인 자체 모듈 경로에서 유도하는 것을 우선합니다(`<AE>\Support Files\Plug-ins\...` → 설치 루트).
  MediaCore 같은 비표준 위치에 설치된 경우에만 AE의 `app.path`를 묻는 방식으로 폴백합니다(확장 `ae-tools`의
  `getInstallPath`와 같은 원천). 둘 다 얻을 수 없으면 확장 라이브러리만 사용하며 나머지 기능은 영향을 받지 않습니다.
- 효과 목록은 AE 프로세스 안에서 열거해 얻습니다(ExtendScript를 거치지 않고 디스크 인덱스도 읽지 않습니다). 새로 설치한 플러그인은 어떤 캐시도 생성하지 않고 검색됩니다.
- `ae-tools\effects_cache.json`은 더 이상 효과 목록의 주 데이터 원천이 아니며, 네이티브 열거가 비어 있을 때(AEGP 미준비)만 폴백으로 쓰입니다.
- 갱신 기준: 데이터 원천 서명(설치된 효과 수 + `index.json` mtime + 스크립트 폴더 트리 + 두 AE 사전 설정 폴더 트리)이 변하지 않으면
  반복 호출 시 메모리에 있는 목록과 병음 인덱스를 그대로 재사용합니다. 스크립트 / 사전 설정의 추가·삭제·변경, 그리고 AE에서 사용자 사전 설정 폴더로 사전 설정을 다른 이름으로 저장하는 경우
  서명이 어긋나 자동으로 다시 로드됩니다(AE 재시작 불필요). 서명 순회는 팝업할 때마다 수행하고, 기본 제공 폴더 전체 스캔은 서명이 어긋날 때만 발생합니다.
  두 작업의 비용은 사전 설정 / 스크립트 항목 수에 비례하며 팝업 횟수에 따라 누적되지 않습니다.
- 플러그인 로드 후 처음 유휴 상태(≥2초)가 되면 데이터를 한 번 예열합니다(열거 + 병음 인덱스). 첫 로드 비용을 키 입력 경로에서 빼냅니다.

#### 인코딩 제약

- 프로젝트 내부 경로와 이름은 UTF-8 좁은 문자열로 통일하며, 파일 열기는 모두 와이드 문자 API를 사용합니다(`native/hotbox/src/data.h`의 `utf8ToWide`와 `log.h`의 와이드 경로 호출). 좁은 `char*` 경로는 시스템이 ANSI/GBK로 해석하므로 중국어가 포함된 경로는 열리지 않습니다.
- AE의 AEGP `A_char` 문자열(효과 이름 / 분류)은 SDK 규약상 시스템 ANSI입니다. 문자열 하나만으로는 인코딩을 판정할 수 없으므로, 일괄 데이터는 먼저 전체 묶음 단위로 ANSI / UTF-8을 판정한 뒤 디코딩합니다(`data.h`의 `isAnsiBatch` / `ansiToUtf8`). 새 데이터 원천을 추가할 때도 같은 기준을 따라야 하며, `A_char`를 UTF-8로 간주하거나 경로에 바로 이어 붙이지 마십시오.

---

### 문제 해결

#### 로그 위치

`<데이터 폴더>\temp\logs\as_hotbox.log` — 플러그인 로드, 단축키 등록, 실행 결과, 오류 정보를 기록합니다. 데이터 폴더의 기본값은 `%APPDATA%\Adobe\CEP\extensions\AS_ExtP`입니다(“구성 파일” 절 참조). 데이터 폴더를 변경하면 로그도 함께 따라갑니다.

#### 자주 묻는 문제

| 증상 | 확인 사항 |
|------|------|
| 단축키를 눌러도 반응 없음 | 로그에서 `hotkey: registered ...`의 성공 여부를 확인합니다. AE가 전면에 있는지도 확인합니다(전면이 아니면 트리거되지 않습니다) |
| 단축키가 이미 사용 중 | 로그에 `hotkey: configured ... in use, fallback default`(기본 조합으로 폴백) 또는 `hotkey: default Alt+Q also failed`가 나타납니다. 설정 패널에서 새 조합을 녹화하십시오. 녹화할 때 키를 눌러도 **전혀 반응이 없으면** 그 조합을 다른 프로그램이 이미 점유한 것입니다(시스템 수준 배타, 키 입력이 전달되지 않음). 다른 조합으로 바꾸거나 점유한 프로그램을 종료하십시오 |
| 플로팅 창에 `扩展未启动` 안내 | CEP 확장이 배포되지 않았습니다. `tools\deploy.bat`을 실행하거나 AE에서 AS_ExtP 패널을 여십시오 |
| 검색 결과 없음 | 검색어를 입력했는지(빈 쿼리는 항목을 나열하지 않습니다), `agent\scripts\`에 스크립트가 있는지, `assets\presets\index.json`이 존재하는지 확인합니다 |
| 효과 적용 실패 | 레이어가 선택되어 있는지, 컴포지션이 열려 있는지 확인합니다 |
| 단축키를 뗀 뒤에도 플로팅 창이 닫히지 않음 | 설정 패널의 `松手停留`(손 떼고 대기)가 켜져 있습니다(config.json `releaseStay`). Esc / 플로팅 창 바깥 클릭 / 단축키 다시 누르기로 닫거나, 설정 패널에서 끄십시오 |
| AE 종료 시 충돌 | 로그에 `DeathHook`이 나타나는지 확인하고, 이벤트 뷰어를 확인합니다 |
| 다중 모니터 위치 이상 | 플로팅 창은 마우스가 있는 모니터의 작업 영역에 맞춰 clamp됩니다. 보조 화면의 마우스 위치에서 보조 화면을 벗어나지 않아야 합니다 |
| 중국어 입력 이상 | 검색 상자는 Win32 EDIT 컨트롤을 사용하며 IME 연상/후보를 쓸 수 있습니다. 조합 입력 중에 Enter를 눌러도 미리 실행되지 않습니다 |

#### 재배포 절차

C++ 코드를 수정한 뒤:

```powershell
# 1. AE 종료
# 2. 다시 빌드
cmake --build native/hotbox/build --config Release
# 3. .aex를 AE로 복사(덮어쓰기)
Copy-Item "deploy\Plug-ins\AS_Hotbox.aex" "<AE 설치 폴더>\Support Files\Plug-ins\" -Force
# 4. AE 시작(반드시 완전히 다시 시작, 작업 관리자에서 AfterFX.exe 프로세스 종료 확인)
```

ExtendScript(`host/api/effectApi.jsx` 등)를 수정한 뒤:

```powershell
# deploy.bat 실행으로 CEP 확장 폴더의 host 파일 갱신
tools\deploy.bat
# AE는 다시 시작하지 않아도 되며, 다음 호출 시 새 스크립트가 자동으로 로드됨
```

---

### 기술 아키텍처

```
┌────────────────────────────────────────────────────────────┐
│ native/hotbox/  AEGP 플러그인(C++20 + MSVC, GeneralPlug)   │
│  ├─ 핫키 엔진   RegisterHotKey + 숨은 메시지 창 ← WM_HOTKEY │
│  │              → GetCursorPos로 마우스 좌표 읽기          │
│  ├─ 플로팅 창   WS_POPUP + WS_EX_TOPMOST + 계층 창 투명    │
│  │              ├─ 제스처 모드: 중심 원 + 호 조각 링(Direct2D) │
│  │              └─ 검색 모드: 긴 검색 바 + 선형 목록 + 필터 드롭다운 │
│  ├─ 실행 채널   AEGP_UtilitySuite6::AEGP_ExecuteScript     │
│  │              → effectApi.jsx / scriptRunner.jsx         │
│  └─ 데이터 계층 프로세스 내 직접 읽기(std::ifstream + GetFileAttributesW) │
└────────────────────────────────────────────────────────────┘
```

핵심 제약:
- 실행 채널 `AEGP_ExecuteScript`는 AE 메인 스레드를 동기적으로 블록합니다 → 짧은 스크립트 위주로 사용하며 실행 중에는 상태가 표시됩니다.
- 데이터 읽기/쓰기는 bridge를 거치지 않습니다. 플러그인이 프로세스 안에서 데이터 폴더의 구성 파일과 스크립트 인덱스를 직접 읽으며, bridge는 패널 측만 담당합니다.
- 스크립트 실행은 모두 샌드박스 래핑(`runScriptSandboxed`)을 거치며 우회 스위치는 제공하지 않습니다.
