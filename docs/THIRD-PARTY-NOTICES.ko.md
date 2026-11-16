# 서드파티 구성 요소 고지 / Third-Party Notices

[简体中文](THIRD-PARTY-NOTICES.md) | [English](THIRD-PARTY-NOTICES.en.md) | [日本語](THIRD-PARTY-NOTICES.ja.md) | [Deutsch](THIRD-PARTY-NOTICES.de.md) | **한국어** | [Français](THIRD-PARTY-NOTICES.fr.md) | [Русский](THIRD-PARTY-NOTICES.ru.md)

> 이 문서는 한국어 번역본입니다. 법적 효력은 [중국어 원문](THIRD-PARTY-NOTICES.md)과 아래 영어 원문으로 수록된 라이선스 전문을 따릅니다.

AS_ExtP는 MIT 라이선스로 배포됩니다([LICENSE](../LICENSE) 참조). 이 문서는 이 프로젝트가 배포하거나 호출하는 서드파티 구성 요소와 그 라이선스를 나열합니다.

**배포 형태 설명**: 이 프로젝트의 취득 방식은 두 가지이며 서드파티 의무가 서로 다릅니다. **Release 전체 패키지는 바로 사용할 수 있습니다** — 미리 컴파일된 네이티브 구성 요소(`.aex`), 내장 Node.js 런타임, npm 의존성이 포함되어 있어 압축을 푼 뒤 `tools\install.bat`을 두 번 클릭하면 사용할 수 있고, Node 설치나 `npm ci`, 컴파일이 필요하지 않습니다. 이 패키지를 배포할 때는 이 문서와 해당 라이선스 파일을 함께 제공하십시오. **소스 저장소에는 위 바이너리와 의존성이 포함되지 않습니다**(용량 및 배포 제한). 클론한 뒤에는 `npm ci`를 직접 실행하고 `tools\check-env.bat` / `tools\install.bat`으로 보완해야 하며, 네이티브 구성 요소는 직접 컴파일해야 합니다. FFmpeg는 이 프로젝트가 **배포하지 않습니다**(Release 패키지와 소스 저장소 모두 포함하지 않음). `tools\check-env.bat` / `tools\install.bat`이 업스트림 고정 버전을 로컬로 내려받습니다.

## 1. 바이너리 구성 요소

### FFmpeg 8.1.2 — GPL-3.0-or-later (이 프로젝트는 배포하지 않음)

| 항목 | 설명 |
| --- | --- |
| 취득 방식 | **이 프로젝트에서 배포하지 않습니다**. `tools\check-env.bat` / `tools\install.bat`이 업스트림 Release에서 `8.1.2-essentials_build`를 로컬로 내려받으며, 내려받기 전에 고정된 SHA-256(`db580001…`)으로 검증합니다 |
| 로컬 위치 | `vendor/ffmpeg/ffmpeg.exe`, `vendor/ffmpeg/ffprobe.exe` (소스 저장소와 Release 패키지 모두 포함하지 않음) |
| 라이선스 전문 | 업스트림 zip에 동봉된 `LICENSE.md` / `COPYING.GPLv3` / `COPYING.GPLv2` / `COPYING.LGPLv2.1` / `COPYING.LGPLv3` (실제 존재하는 파일 기준). `tools\check-env.bat` / `tools\install.bat`은 압축을 푼 뒤 이 파일들을 `SOURCE.txt`(다운로드 주소, SHA-256, 대응 소스 코드 안내)와 함께 `vendor/ffmpeg/`에 보존합니다. 이 프로젝트는 해당 바이너리를 여전히 배포하지 않으며, 재배포 시에는 이 텍스트들과 소스 코드 취득 안내를 함께 제공하십시오 |
| 출처와 대응 소스 코드 안내 | Gyan Doshi(`GyanD/codexffmpeg`)가 제공하는 `8.1.2-essentials_build`(GitHub Release 태그 `8.1.2`)로, libx264 / libx265 등 GPL 구성 요소를 정적 링크합니다. 해당 Release에 기록된 업스트림 소스 커밋은 `FFmpeg/FFmpeg@38b88335f9`이며, 소스 패키지는 ffmpeg.org의 `ffmpeg-8.1.2.tar.xz`를 참조하십시오 |
| 용도 | 독립 프로세스(명령줄 인터페이스)로 호출하며, 에셋 라이브러리의 영상 트랜스코딩과 프레임 추출에 사용합니다. AS_ExtP 소스 코드에는 링크되지 않습니다 |

> 이 프로젝트는 해당 바이너리 배포에 참여하지 않으며 그 GPL 배포 의무를 지지 않습니다. 설치 스크립트가 성공하면 GPL 안내를 한 줄 출력하고 업스트림 라이선스 텍스트를 `vendor/ffmpeg/`에 보존합니다. ffmpeg가 포함된 디렉터리를 재배포하는 경우에는 GPL-3.0-or-later 의무(라이선스 첨부, 대응 소스 코드 제공)를 직접 충족해야 합니다.

### Node.js 22.23.2 — MIT

| 항목 | 설명 |
| --- | --- |
| 배포 방식 | Release 전체 패키지와 함께 배포합니다(소스 저장소에는 없음. 소스 클론 시에는 Node ≥ 20.18을 직접 설치하십시오) |
| 위치 | `vendor/node/node.exe` |
| 라이선스 전문 | `vendor/node/LICENSE` — 공식 `node-v22.23.2-win-x64.zip` 내의 원본으로, Node에 내장된 각 구성 요소의 라이선스 고지를 포함합니다. 설치 스크립트는 고정된 SHA-256 `1177b413…`으로 해당 배포 패키지를 검증하며(`tools/install.bat`, `tools/check-env.bat`), 이 값은 업스트림 `SHASUMS256.txt`와 일치합니다. 패키지 내 `node.exe`와 이 디렉터리의 `node.exe` 해시도 일치합니다(`0d0f5e39…`) |
| 용도 | 로컬 Bridge와 stdio MCP 서버의 런타임 |

## 2. npm 의존성 (`vendor/node_modules/`, Release 전체 패키지와 함께 배포)

아래 표에서 ※로 표시된 패키지를 제외하면 각 패키지 디렉터리에 라이선스 파일이 포함되어 있습니다(※ 패키지의 라이선스 전문은 아래 부록 참조). 아래 표는 요약이며 버전은 `package-lock.json`을 기준으로 합니다. **강제 GPL / AGPL / LGPL 의존성은 없습니다**(`jszip`은 `MIT OR GPL-3.0-or-later` 이중 라이선스이며, 이 프로젝트는 MIT로 사용합니다). Release 전체 패키지에는 이 디렉터리와 각 패키지의 라이선스 파일이 포함됩니다. 소스 클론에는 이 디렉터리가 없으며, `npm ci`로 `package-lock.json`에 따라 루트 `node_modules`에 설치하고 배포 스크립트(`deploy.bat` / `install.bat`)가 `vendor/node_modules`로 복사합니다. 실행 시 `client/shared/ae-bridge.js`가 `NODE_PATH`를 `vendor/node_modules`로 지정하며(`client/shared/ext-mcp-server.js`도 동일), Node의 일반 해석은 가까운 `node_modules`를 먼저 찾고 `NODE_PATH`를 폴백으로 사용하므로 소스 클론(루트 `node_modules`)과 배포 상태(`vendor/node_modules`만 존재) 모두에서 의존성을 해석할 수 있습니다. `xmlbuilder` 10.1.1은 `vendor/node_modules/mammoth/node_modules/xmlbuilder/`에 중첩 설치되어 있으며(mammoth에 포함), 나머지 패키지는 `vendor/node_modules/` 최상위에 있습니다.

| 패키지 | 버전 | 라이선스 |
| --- | --- | --- |
| @wwek/xlsx | 0.20.3 | Apache-2.0 |
| @xmldom/xmldom | 0.8.13 | MIT |
| argparse | 1.0.10 | MIT |
| base64-js | 1.5.1 | MIT |
| bluebird | 3.4.7 | MIT |
| core-util-is | 1.0.3 | MIT |
| dingbat-to-unicode | 1.0.1 | BSD-2-Clause ※ |
| duck | 0.1.12 | BSD-2-Clause (업스트림 필드에는 'BSD'만 기재되어 있고 실제 전문은 2조항 BSD) |
| immediate | 3.0.6 | MIT |
| inherits | 2.0.4 | ISC |
| isarray | 1.0.0 | MIT ※ |
| jszip | 3.10.1 | MIT OR GPL-3.0-or-later (이 프로젝트는 MIT로 사용) |
| lie | 3.3.0 | MIT |
| lop | 0.4.2 | BSD-2-Clause |
| mammoth | 1.12.1 | BSD-2-Clause |
| option | 0.2.4 | BSD-2-Clause |
| pako | 1.0.11 | MIT AND Zlib ※ (패키지에는 MIT 텍스트만 첨부되어 있으며 Zlib 전문은 부록 참조) |
| path-is-absolute | 1.0.1 | MIT |
| process-nextick-args | 2.0.1 | MIT |
| readable-stream | 2.3.8 | MIT |
| safe-buffer | 5.1.2 | MIT |
| setimmediate | 1.0.5 | MIT |
| sprintf-js | 1.0.3 | BSD-3-Clause |
| string_decoder | 1.1.1 | MIT |
| underscore | 1.13.8 | MIT |
| unpdf | 1.8.0 | MIT; Mozilla PDF.js 6.1.200 내장(Apache-2.0) ※ |
| util-deprecate | 1.0.2 | MIT |
| xmlbuilder | 10.1.1 | MIT |

※ = 업스트림 패키지에 해당 라이선스 전문이 첨부되지 않은 경우(또는 패키지와 함께 제공되지 않은 경우)이며, 해당 라이선스 전문은 아래 부록을 참조하십시오. `unpdf@1.8.0`의 `dist/pdfjs.mjs`는 Mozilla PDF.js의 서버리스 빌드(내장 버전 6.1.200)이며 이 부분은 Apache-2.0으로 라이선스됩니다. 업스트림 `unpdf` 패키지에는 자체 MIT 텍스트만 첨부되어 있고 Apache-2.0 텍스트는 첨부되어 있지 않습니다.

## 3. 소스 트리와 함께 배포되는 서드파티 소스 코드 라이브러리

다음 라이브러리는 소스 코드 형태로 공개 저장소에 포함되어 있습니다. 이 중 **glad**와 **PinIn4Cpp**는 빌드 시점에 Release 패키지의 `.aex`로 정적 컴파일되며(즉 바이너리 형태로 Release와 함께 배포됨), 해당 라이선스 텍스트는 소스 트리와 함께 제공되어 허용적 라이선스의 '사본과 함께 저작권 및 라이선스 고지를 유지' 요구를 충족합니다:

| 라이브러리 | 위치 | 버전 | 라이선스 | 라이선스 텍스트 | 용도 |
| --- | --- | --- | --- | --- | --- |
| marked | `client/vendor/marked/` | 12.0.2 | MIT | 트리 내 `LICENSE` | Markdown 렌더링 |
| Prism.js | `client/vendor/prism/` | 1.29.0(추정) | MIT | 트리 내 `LICENSE` | 코드 하이라이트 |
| js-xss | `client/vendor/xss/` | 1.0.15(추정) | MIT | 트리 내 `LICENSE`. bundle에는 cssfilter(MIT)가 추가로 인라인되어 있으며 전문은 부록 참조 | HTML 정화 |
| anime.js | `client/vendor/anime/` | 3.2.2 | MIT (© 2019 Julian Garnier. 업스트림 min 파일 헤더에 2023으로 잘못 기재됨) | 파일 헤더 주기. 전문은 부록 참조 | 인터페이스 애니메이션 |
| acorn(es3-parser) | `client/vendor/es3-parser/` | 8.18.0 | MIT (© 2012-2022 by various contributors) | `acorn.js` 파일 내 주기 + 출처 `README.md`(라이선스 전문은 부록 참조) | AST 컴파일 게이트의 ES3 파서 |
| CSInterface.js | `client/vendor/CSInterface.js` | 8.0.0(간소화 구현) | Adobe SDK 라이선스 계약(비 OSS). 파일에 Adobe 저작권 헤더와 버전 번호 유지 | 트리 내 `CSInterface.LICENSE.pdf`(계약 원문, 아래 참조) | CEP 호스트 인터페이스 |
| glad | `native/glsl-host/third_party/glad/` | 0.1.36(생성기) | MIT + Khronos Apache-2.0 | 트리 내 `LICENSE`(업스트림 원본, glad / Khronos Specifications / EGL headers 세 부분 포함). `include/KHR/khrplatform.h`에 Khronos 라이선스 원문 포함 | OpenGL 로더 |
| PinIn4Cpp | `native/hotbox/third_party/PinIn4Cpp/` | 1.5.8 | MIT (© 2025 KagiyamaHina) | 트리 내 `LICENSE`. `licenses/`에 PinIn(© 2019 Juntong Liu)과 pinyin-data(© 2016 mozillazg) 두 MIT 텍스트 포함 | 핫박스 병음 매칭 |
| json2(Crockford json2.js 각색) | `host/api/json2.jsx` | 버전 표기 없음 | Public Domain | 파일 헤더 주기(퍼블릭 도메인, 라이선스 텍스트 의무 없음) | ExtendScript의 JSON polyfill(ES3에는 네이티브 JSON 없음) |
| Feather Icons / Lucide | `client/` 아래 CSS `data:` SVG와 인라인 `<svg>` | — | MIT(Feather, © 2013-2023 Cole Bemis) / ISC(Lucide) | 전문은 부록 참조 | 인터페이스 인라인 아이콘(일부 path는 업스트림에서 그대로 가져옴) |

'—' = 번들된 min 파일에 버전 번호가 표기되지 않은 경우입니다. **Prism / js-xss의 버전은 추정치**입니다. Prism은 `prism-core.min.js`를 업스트림 `prismjs@1.29.0` 공식 `components/prism-core.min.js`와 바이트 단위로 비교해 확인했으며(`prism-clike` / `prism-javascript`와 테마 파일도 공식과 일치), js-xss는 `xss.min.js`의 SHA-256 `2072387B…3261E`가 업스트림 `xss@1.0.15` 공식 산출물과 일치함을 확인하고 bundle에 `singleQuotedAttributeValue`(1.0.15에서 도입)가 포함되고 `filterXSSWithResult`(1.0.16에서 도입)가 포함되지 않은 점을 버전 상하한 근거로 삼았습니다. 나머지 버전은 모두 파일 내 버전 문자열 / `package-lock`과 직접 대조했습니다.

**Prism 로컬 수정**: `client/vendor/prism/prism-core.min.js`는 업스트림 1.29.0과 두 가지 차이가 있습니다. `highlightAllUnder` 내부에서 훅으로 재정의할 수 있는 `env.container` 대신 함수 인수의 컨테이너를 사용하고, 파일 끝에 `window.Prism=Prism;`을 추가했습니다(CEP 환경에서 전역으로 마운트). 수정은 라이선스 의무를 바꾸지 않으며, Prism을 업그레이드할 때는 다시 적용해야 합니다.

**CSInterface.js**: Adobe 저작권(`Copyright (c) 2012-2017 Adobe Systems Inc.`)이며, 파일 헤더에는 함께 제공되는 Adobe 라이선스 계약에 따라 사용, 수정, 배포할 수 있다고 명시되어 있습니다. 해당 계약 원문(`GenSDK_IHC-en_US-20120323_1224.pdf`, Adobe CEP-Resources 저장소 `License/` 디렉터리에서 취득)은 `client/vendor/CSInterface.LICENSE.pdf`(95,659 B, SHA-256 `32E81408…5383`)로 트리에 배치되어 있으며, 이 프로젝트는 해당 계약에 따라 CEP 확장과 함께 이 파일을 사용합니다. 트리에 포함된 파일은 프로젝트 필요에 맞게 간소화한 구현(357행, 16개 메서드: `evalScript` / `getHostEnvironment` / `getSystemPath` / `getExtensionPath` / 이벤트 등록 등)이며 Adobe 공식 배포판 전문이 아닙니다(공식 v8은 약 1200행이며 `setPanelFlyoutMenu` / `updatePanelMenuItem` / `getExtensions` / `getNetworkPreferences` 등이 추가로 포함됨). 파일 헤더의 저작권과 `v8.0.0` 버전 표기는 업스트림 그대로 유지하여 인터페이스와 사용법이 Adobe CEP SDK에서 비롯되었음을 밝힙니다.

CSInterface.js(Adobe 계약, 비 OSS)를 제외하면 나머지 라이브러리는 모두 MIT / BSD 계열 허용적 라이선스입니다. glad는 Khronos 부분의 Apache-2.0을 추가로 포함하며(같은 표에 기재), 이 프로젝트의 MIT 라이선스와 호환됩니다.

## 4. 빌드 시점 의존성과 컴파일 산출물의 Adobe 콘텐츠(SDK 본체는 배포하지 않음)

| 구성 요소 | 라이선스 | 설명 |
| --- | --- | --- |
| Adobe After Effects SDK | Adobe SDK 계약 | `native/`의 네이티브 구성 요소 두 개(GLSL 효과 호스트 / AE 핫박스)를 컴파일할 때 필요하며 빌드하는 사람이 Adobe에서 직접 취득해야 합니다. **SDK 본체와 그 라이선스 텍스트는 소스 저장소나 Release 패키지와 함께 배포되지 않습니다**. 빌드 단계는 [DEVELOPMENT.md](DEVELOPMENT.md) 참조 |
| 컴파일 산출물 `deploy/Plug-ins/*.aex` | 이 프로젝트의 빌드 산출물. Adobe SDK 계약의 적용을 받음 | Release 전체 패키지에는 `AS_Effect_Host.aex`(약 643KB)와 `AS_Hotbox.aex`(약 1.5MB)가 포함됩니다. 빌드 시점에 SDK `Examples/Util`의 수정되지 않은 예제 소스(`AEFX_SuiteHelper.c`, `AEGP_SuiteHandler.cpp`, `MissingSuiteError.cpp`)를 컴파일 단위로 포함하고 glad(MIT)와 PinIn4Cpp(MIT, pinyin-data 병음 데이터 포함)를 정적 링크합니다. 이 두 바이너리는 이 프로젝트의 MIT 라이선스 적용 범위에 속하지 않습니다. 재배포하거나 상업적으로 사용하기 전에 Adobe와의 계약 조건을 직접 확인하십시오(필요하면 Adobe 개발자 지원에 문의). |

> `.aex`를 제외하면 Release 전체 패키지의 나머지 내용(소스 코드, Node.js, npm 의존성)은 이 문서와 각 패키지의 LICENSE 고지를 따릅니다. `.aex`는 이 문서 범위에서 이 프로젝트가 컴파일한 유일한 바이너리 산출물입니다(패키지 내 `vendor/node/node.exe`는 업스트림 Node.js 런타임이며 1절 참조).

## 5. 비코드 에셋과 콘텐츠 출처

이 프로젝트가 소스 트리와 함께 배포하는 내용에는 비코드 에셋이 세 가지 있습니다. **서드파티 이미지 라이브러리, 글꼴, 서드파티 오디오 에셋은 포함하지 않습니다**:

| 콘텐츠 | 위치 | 크기 | 출처 | 설명 |
| --- | --- | --- | --- | --- |
| 데스크톱 펫 시퀀스 프레임(PNG 16개) | `client/features/deepseekPet/sprites/` | 약 108.7MB | 프로젝트 작성자가 AI 생성 도구로 제작. `potHead` / `eat` 두 건은 저장소 외부에서 직접 만든 시퀀스 프레임을 병합 | 자체 제작 캐릭터 애니메이션 |
| 이스터 에그 영상 `appear.webm` | 위와 같음 | 약 1.8MB | 프로젝트 작성자 제작(AI 생성). **AI가 생성한 중국어 음성 포함** | 데스크톱 펫 이스터 에그를 열었을 때의 전체 화면 등장 애니메이션 |
| 상태 표 `manifest.json` | 위와 같음 | 1.9KB | 프로젝트 작성자 작성 | 프레임 그리드 사양 |

**글꼴**: 인터페이스 글꼴은 모두 이름으로 로컬에 설치된 글꼴을 참조합니다. 시스템 글꼴 스택(예: Segoe UI / Microsoft YaHei / Yu Gothic UI / Malgun Gothic / Noto Sans KR / Consolas 등)과 `sans-serif` / `serif` / `monospace` 일반 패밀리를 대체값으로 사용하며, `@font-face`를 쓰지 않고 base64 글꼴을 내장하지 않으며 글꼴을 원격에서 로드하지도 않습니다. 패키지와 함께 배포되는 글꼴 파일도 없습니다. 두 네이티브 구성 요소는 AE 호스트 Drawbot 기본 글꼴과 시스템 DirectWrite 글꼴(`Microsoft YaHei UI`)을 사용하며 역시 글꼴을 번들하지 않으므로, 이 프로젝트에는 글꼴 라이선스 의무가 발생하지 않습니다.

**캐릭터 이미지 설명**: 캐릭터는 고래를 의인화한 커뮤니티 2차 창작 스타일이며, 모티프(고래, 짙은 남색 배색)가 DeepSeek 브랜드 이미지와 유사합니다. 대외 명칭과 인터페이스 내 문구에는 DeepSeek 표기가 없고 '大肥鱼桌宠', '大肥鱼'를 사용합니다. 이스터 에그 트리거 단어는 '大肥鱼'입니다. 이 프로젝트는 DeepSeek 공식과 어떠한 제휴, 후원, 라이선스 관계도 없으며 **그 상표나 저작권 라이선스를 취득하지 않았고** 공식 로고나 문자 상표를 복제하지도 않았습니다. 이 이미지에 대해 권리자가 이의를 제기하면 즉시 제거하거나 교체합니다. `client/features/deepseekPet/sprites/`를 삭제하면 이미지가 제거되며(데스크톱 펫 기능만 사용할 수 없게 됨), 내보낼 때 `--without-sprites`를 추가해도 됩니다. 코드 내 식별자는 여전히 `deepseekPet` / `AEDeepseekPet`입니다(모듈 디렉터리와 네임스페이스이며 인터페이스 문구가 아님).

**라이선스 경계**: 위 에셋은 이 프로젝트와 함께 MIT로 제공됩니다. DeepSeek 브랜드 이미지에 관련된 부분은 이 프로젝트가 라이선스를 부여할 수 있는 범위에 속하지 않으며, 사용자가 관련 위험을 직접 부담합니다.

**문서와 데이터**: `client/shared/aeApiReference.txt`(AE 스크립트 API 중국어 정리본, `queryAeApi`에서 사용)는 이 프로젝트의 참고 정리본에서 생성되었으며, 파일 자체에 '整理来源：AE脚本API参考'라고 적혀 있습니다. **Adobe 공식 스크립트 문서를 바탕으로 정리한 것으로 보이며**(파일 내에 원본 URL 없음), 권리자가 이의를 제기하면 제거하거나 자체 요약본으로 교체합니다. `client/shared/aeMatchName.json`은 AE에서 실제로 내보낸 matchName → 표시 이름 매핑으로 사실적 데이터입니다.

**인터페이스 인라인 아이콘**: `client/` 아래 CSS `data:` SVG와 인라인 `<svg>`의 일부 아이콘 path는 Feather Icons(MIT)와 Lucide(ISC)에서 그대로 가져왔으며, 3절에 고지되어 있습니다. 라이선스 전문은 부록 참조.

## 6. 실행 시점에 업스트림에서 취득하며 이 프로젝트가 배포하지 않는 구성 요소

| 구성 요소 | 라이선스 | 설명 |
| --- | --- | --- |
| ComfyUI 공식 템플릿 라이브러리(`Comfy-Org/workflow_templates`) | MIT (© 2023-present Comfy Org) | '공식 템플릿' 기능이 실행 시 `raw.githubusercontent.com` / `cdn.jsdelivr.net`에서 템플릿 인덱스를 가져와 로컬 데이터 폴더에 캐시합니다. **소스 저장소나 Release 패키지와 함께 배포되지 않습니다** |
| ComfyUI 서버 | 해당 제품 자체 라이선스 | 사용자가 직접 준비하는 외부 프로그램이며, 이 프로젝트는 네트워크로만 호출합니다 |
| 주요 LLM 플랫폼 API | 각 플랫폼의 서비스 약관 | 사용자가 키를 직접 준비하는 외부 서비스이며, 이 프로젝트는 네트워크 요청만 보냅니다 |

## 부록: 업스트림에 라이선스 텍스트가 첨부되지 않은 구성 요소

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

BSD-2-Clause. npm 패키지에 라이선스 파일이 첨부되어 있지 않습니다(`package.json`에 `BSD-2-Clause`로 선언됨). 아래 전문은 업스트림 저장소 `mwilliamson/dingbat-to-unicode`의 `js/LICENSE`에서 가져왔습니다:

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

min 파일 헤더에는 저작권과 라이선스 이름만 남아 있습니다(`(c) 2023 Julian Garnier` / `Released under the MIT license`, 라이선스 전문 없음). 참고: 업스트림 `anime.js@3.2.2`의 LICENSE에는 `2019`로 적혀 있어 min 파일 헤더와 일치하지 않습니다. 아래는 업스트림 LICENSE에 따라 보충 수록하며 2019를 기준으로 합니다:

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

### acorn@8.18.0 (`client/vendor/es3-parser/`, es3-parser로 벤더링됨)

acorn의 dist 산출물은 파일 내에 저자와 라이선스 이름만 주기되어 있고 라이선스 전문은 없습니다(해당 디렉터리의 `README.md`에 출처 설명이 있음). 아래는 업스트림 npm 패키지 `acorn@8.18.0`의 LICENSE에 따라 보충 수록합니다(원문 저작권 행이 가리키는 `AUTHORS` 파일은 이 트리에 포함되지 않았으며 업스트림 저장소 참조):

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

라이선스 전문은 소스 트리와 함께 제공됩니다: `native/glsl-host/third_party/glad/LICENSE`(업스트림 `Dav1dde/glad` v0.1.36 원본, 트리 내 3,077 B. 업스트림 LF 버전은 3,014 B이고 트리 내 파일은 CRLF 체크아웃). 이 파일은 세 부분으로 구성됩니다:

- **glad 본체**: MIT, `Copyright (c) 2013-2021 David Herberth`;
- **The Khronos Specifications**: `Copyright (c) 2013-2020 The Khronos Group Inc.`, `Licensed under the Apache License, Version 2.0`;
- **The EGL Specification and various headers**: `Copyright (c) 2007-2016 The Khronos Group Inc.`(Khronos의 MIT 형식 라이선스).

`include/KHR/khrplatform.h`에는 Khronos 라이선스 원문이 포함되어 있습니다(`Copyright (c) 2008-2018 The Khronos Group Inc.`).

### pako 1.0.11 (`vendor/node_modules/pako/`, Zlib 라이선스)

pako의 라이선스는 `MIT AND Zlib`입니다. MIT 전문은 패키지와 함께 제공되며(`pako/LICENSE`), Zlib 부분의 업스트림 텍스트는 npm 패키지에 첨부되어 있지 않습니다. 아래는 zlib 공식 저장소 `LICENSE`의 표준 전문입니다:

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

### PDF.js 6.1.200 (Apache-2.0, `vendor/node_modules/unpdf/dist/pdfjs.mjs`에 내장)

`unpdf@1.8.0`은 Mozilla PDF.js 6.1.200의 서버리스 빌드(`dist/pdfjs.mjs`, 약 1.6MB)를 패키지와 함께 제공합니다. 이 파일은 Apache-2.0으로 라이선스되며, 업스트림 `unpdf` 패키지에는 해당 라이선스 텍스트가 첨부되어 있지 않습니다. 업스트림 저작권 고지: `Copyright 2012 Mozilla Foundation` 및 PDF.js 기여자. 이 프로젝트의 MIT 라이선스는 해당 내장 코드를 포함하지 않으며, `vendor/node_modules/unpdf/`를 포함한 Release 전체 패키지를 배포할 때는 이 단락과 아래 Apache-2.0 전문을 함께 제공해야 합니다.

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

### cssfilter (`client/vendor/xss/` bundle에 인라인)

`client/vendor/xss/xss.min.js`의 번들 파일에 cssfilter(js-xss의 CSS 필터링 의존성, MIT)가 인라인되어 있습니다:

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

### Feather Icons (`client/` 인라인 아이콘)

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

### Lucide (`client/` 인라인 아이콘)

다음은 업스트림 `lucide-icons/lucide`의 `LICENSE` 전문입니다(저작권 행의 연도는 업스트림 버전에 따라 갱신되며, 여기에 나열된 아이콘은 Feather에서 파생되어 Feather MIT 전문이 함께 실려 있음):

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
