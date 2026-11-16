# Уведомления о сторонних компонентах / Third-Party Notices

[简体中文](THIRD-PARTY-NOTICES.md) | [English](THIRD-PARTY-NOTICES.en.md) | [日本語](THIRD-PARTY-NOTICES.ja.md) | [Deutsch](THIRD-PARTY-NOTICES.de.md) | [한국어](THIRD-PARTY-NOTICES.ko.md) | [Français](THIRD-PARTY-NOTICES.fr.md) | **Русский**

> Это перевод на русский язык, предоставленный для ознакомления. Тексты лицензий ниже приведены на английском языке; юридическую силу имеет [китайский оригинал](THIRD-PARTY-NOTICES.md) и английские тексты лицензий.

AS_ExtP распространяется по лицензии MIT (см. [LICENSE](../LICENSE)). В этом документе перечислены сторонние компоненты, которые проект распространяет или вызывает, и их лицензии.

**Формы распространения**: проект можно получить двумя способами, и обязательства по сторонним компонентам для них разные. **Полный пакет Release работает сразу** — в нём есть предкомпилированные нативные компоненты (`.aex`), встроенная среда выполнения Node.js и зависимости npm; распакуйте архив и дважды щёлкните `tools\install.bat`, устанавливать Node, выполнять `npm ci` или собирать ничего не нужно. Распространяя такой пакет, предоставляйте вместе с ним этот документ и соответствующие файлы лицензий. **Репозиторий исходников не содержит** указанных бинарников и зависимостей (ограничения по размеру и распространению); после клонирования выполните `npm ci` и дополните их с помощью `tools\check-env.bat` / `tools\install.bat`, а нативные компоненты соберите самостоятельно. FFmpeg этим проектом **не распространяется** (его нет ни в пакете Release, ни в репозитории исходников): `tools\check-env.bat` / `tools\install.bat` скачивают фиксированную версию из вышестоящего репозитория на локальную машину.

## 1. Бинарные компоненты

### FFmpeg 8.1.2 — GPL-3.0-or-later (не распространяется этим проектом)

| Пункт | Описание |
| --- | --- |
| Способ получения | **Не распространяется этим проектом.** `tools\check-env.bat` / `tools\install.bat` скачивают `8.1.2-essentials_build` из вышестоящего Release на локальную машину и проверяют загрузку по закреплённому значению SHA-256 (`db580001…`) |
| Расположение на локальной машине | `vendor/ffmpeg/ffmpeg.exe`, `vendor/ffmpeg/ffprobe.exe` (нет ни в репозитории исходников, ни в пакете Release) |
| Полные тексты лицензий | В вышестоящем zip приложены `LICENSE.md` / `COPYING.GPLv3` / `COPYING.GPLv2` / `COPYING.LGPLv2.1` / `COPYING.LGPLv3` (в зависимости от того, что фактически присутствует). После распаковки `tools\check-env.bat` / `tools\install.bat` сохраняют их вместе с `SOURCE.txt` (адрес загрузки, SHA-256, указания на соответствующий исходный код) в `vendor/ffmpeg/`; сам бинарник проект по-прежнему не распространяет — при повторном распространении предоставляйте эти тексты и указания о получении исходного кода вместе с ним |
| Источник и указания на соответствующий исходный код | `8.1.2-essentials_build` от Gyan Doshi (`GyanD/codexffmpeg`, тег GitHub Release `8.1.2`), статически слинкован с GPL-компонентами libx264 / libx265 и др.; записанный в этом Release коммит вышестоящего исходного кода — `FFmpeg/FFmpeg@38b88335f9`, архив исходников — `ffmpeg-8.1.2.tar.xz` с ffmpeg.org |
| Назначение | Вызывается как отдельный процесс (интерфейс командной строки) для транскодирования видео и извлечения кадров в библиотеке ассетов; не слинкован с исходным кодом AS_ExtP |

> Этот проект не участвует в распространении указанного бинарника и не несёт обязательств GPL по его распространению; при успешной установке скрипт выводит одну строку с напоминанием о GPL и сохраняет тексты вышестоящих лицензий в `vendor/ffmpeg/`. Если вы распространяете дальше каталог, содержащий ffmpeg, обязательства GPL-3.0-or-later выполняете вы сами (приложить лицензию, предоставить соответствующий исходный код).

### Node.js 22.23.2 — MIT

| Пункт | Описание |
| --- | --- |
| Способ распространения | Распространяется в составе полного пакета Release (в репозитории исходников отсутствует; при клонировании исходников установите Node ≥ 20.18 самостоятельно) |
| Расположение | `vendor/node/node.exe` |
| Полный текст лицензии | `vendor/node/LICENSE` — оригинальный файл из официального `node-v22.23.2-win-x64.zip`, содержащий лицензионные уведомления встроенных в Node компонентов. Скрипт установки проверяет этот дистрибутив по закреплённому значению SHA-256 `1177b413…` (`tools/install.bat`, `tools/check-env.bat`); значение совпадает с вышестоящим `SHASUMS256.txt`, а хеш `node.exe` внутри пакета совпадает с хешем `node.exe` в этом каталоге (`0d0f5e39…`) |
| Назначение | Среда выполнения локального Bridge и MCP-сервера stdio |

## 2. Зависимости npm (`vendor/node_modules/`, распространяются в составе полного пакета Release)

Кроме пакетов, отмеченных ※ в таблице ниже, каждый каталог пакета содержит собственный файл лицензии (полные тексты лицензий пакетов ※ — в приложении ниже); таблица является сводной, версии приведены по `package-lock.json`. **Обязательных зависимостей GPL / AGPL / LGPL нет** (`jszip` лицензирован как `MIT OR GPL-3.0-or-later`, проект использует его по MIT). Полный пакет Release содержит этот каталог и собственные файлы лицензий пакетов; в клоне исходников этого каталога нет — установите его в корневой `node_modules` командой `npm ci` по `package-lock.json`, а скрипты развёртывания (`deploy.bat` / `install.bat`) скопируют его в `vendor/node_modules`. Во время работы `client/shared/ae-bridge.js` направляет `NODE_PATH` в `vendor/node_modules` (так же `client/shared/ext-mcp-server.js`); обычный механизм разрешения модулей Node сначала находит ближайший `node_modules`, а `NODE_PATH` служит резервом, поэтому зависимости разрешаются и в клоне исходников (корневой `node_modules`), и в развёрнутом виде (только `vendor/node_modules`). `xmlbuilder` 10.1.1 установлен вложенно в `vendor/node_modules/mammoth/node_modules/xmlbuilder/` (входит в состав mammoth), остальные пакеты находятся в корне `vendor/node_modules/`.

| Пакет | Версия | Лицензия |
| --- | --- | --- |
| @wwek/xlsx | 0.20.3 | Apache-2.0 |
| @xmldom/xmldom | 0.8.13 | MIT |
| argparse | 1.0.10 | MIT |
| base64-js | 1.5.1 | MIT |
| bluebird | 3.4.7 | MIT |
| core-util-is | 1.0.3 | MIT |
| dingbat-to-unicode | 1.0.1 | BSD-2-Clause ※ |
| duck | 0.1.12 | BSD-2-Clause (в поле вышестоящего пакета указано только «BSD», фактический текст — двухпунктовая BSD) |
| immediate | 3.0.6 | MIT |
| inherits | 2.0.4 | ISC |
| isarray | 1.0.0 | MIT ※ |
| jszip | 3.10.1 | MIT OR GPL-3.0-or-later (проект использует по MIT) |
| lie | 3.3.0 | MIT |
| lop | 0.4.2 | BSD-2-Clause |
| mammoth | 1.12.1 | BSD-2-Clause |
| option | 0.2.4 | BSD-2-Clause |
| pako | 1.0.11 | MIT AND Zlib ※ (в пакете только текст MIT, полный текст Zlib — в приложении) |
| path-is-absolute | 1.0.1 | MIT |
| process-nextick-args | 2.0.1 | MIT |
| readable-stream | 2.3.8 | MIT |
| safe-buffer | 5.1.2 | MIT |
| setimmediate | 1.0.5 | MIT |
| sprintf-js | 1.0.3 | BSD-3-Clause |
| string_decoder | 1.1.1 | MIT |
| underscore | 1.13.8 | MIT |
| unpdf | 1.8.0 | MIT; встроен Mozilla PDF.js 6.1.200 (Apache-2.0) ※ |
| util-deprecate | 1.0.2 | MIT |
| xmlbuilder | 10.1.1 | MIT |

※ = вышестоящий пакет не содержит полного текста этой лицензии (или не прилагает его к пакету); полный текст — в приложении ниже. Файл `dist/pdfjs.mjs` пакета `unpdf@1.8.0` — это serverless-сборка Mozilla PDF.js (встроенная версия 6.1.200), эта часть лицензирована по Apache-2.0; вышестоящий пакет `unpdf` содержит только собственный текст MIT, текст Apache-2.0 не приложен.

## 3. Сторонние библиотеки исходного кода, распространяемые с деревом исходников

Перечисленные ниже библиотеки включены в публичный репозиторий в виде исходного кода; **glad** и **PinIn4Cpp** на этапе сборки статически компилируются в `.aex` пакета Release (то есть распространяются с Release в бинарной форме), а их тексты лицензий предоставляются вместе с деревом исходников, что выполняет требование разрешительных лицензий «сохранять уведомления об авторских правах и разрешениях вместе с копиями»:

| Библиотека | Расположение | Версия | Лицензия | Текст лицензии | Назначение |
| --- | --- | --- | --- | --- | --- |
| marked | `client/vendor/marked/` | 12.0.2 | MIT | `LICENSE` в дереве | Рендеринг Markdown |
| Prism.js | `client/vendor/prism/` | 1.29.0 (предположительно) | MIT | `LICENSE` в дереве | Подсветка кода |
| js-xss | `client/vendor/xss/` | 1.0.15 (предположительно) | MIT | `LICENSE` в дереве; в bundle дополнительно встроен cssfilter (MIT), полный текст — в приложении | Очистка HTML |
| anime.js | `client/vendor/anime/` | 3.2.2 | MIT (© 2019 Julian Garnier; в заголовке вышестоящего min-файла ошибочно указан 2023) | Уведомление в заголовке файла; полный текст — в приложении | Анимация интерфейса |
| acorn (es3-parser) | `client/vendor/es3-parser/` | 8.18.0 | MIT (© 2012-2022 by various contributors) | Уведомление внутри `acorn.js` + `README.md` об источнике (полный текст лицензии — в приложении) | Парсер ES3 для шлюза компиляции AST |
| CSInterface.js | `client/vendor/CSInterface.js` | 8.0.0 (урезанная реализация) | Лицензионное соглашение Adobe SDK (не OSS); в файле сохранены заголовок об авторских правах Adobe и номер версии | `CSInterface.LICENSE.pdf` в дереве (оригинал соглашения, см. ниже) | Интерфейс хоста CEP |
| glad | `native/glsl-host/third_party/glad/` | 0.1.36 (генератор) | MIT + Khronos Apache-2.0 | `LICENSE` в дереве (вышестоящий оригинал из трёх частей: glad / Khronos Specifications / EGL headers); `include/KHR/khrplatform.h` содержит исходный текст лицензии Khronos | Загрузчик OpenGL |
| PinIn4Cpp | `native/hotbox/third_party/PinIn4Cpp/` | 1.5.8 | MIT (© 2025 KagiyamaHina) | `LICENSE` в дереве; в `licenses/` два текста MIT — PinIn (© 2019 Juntong Liu) и pinyin-data (© 2016 mozillazg) | Сопоставление пиньиня в Hotbox |
| json2 (адаптация json2.js Крокфорда) | `host/api/json2.jsx` | Без отметки версии | Public Domain | Уведомление в заголовке файла (общественное достояние, обязательств по тексту лицензии нет) | Полифилл JSON для ExtendScript (в ES3 нет встроенного JSON) |
| Feather Icons / Lucide | CSS `data:` SVG и встроенные `<svg>` в `client/` | — | MIT (Feather, © 2013-2023 Cole Bemis) / ISC (Lucide) | Полный текст — в приложении | Встроенные иконки интерфейса (часть path дословно взята из вышестоящего проекта) |

«—» = в упакованном min-файле номер версии не указан. **Версии Prism и js-xss определены предположительно**: Prism — побайтным сравнением `prism-core.min.js` с официальным `components/prism-core.min.js` из вышестоящего `prismjs@1.29.0` (`prism-clike` / `prism-javascript` и файлы тем совпадают с официальными); js-xss — совпадением SHA-256 `xss.min.js` (`2072387B…3261E`) с официальным артефактом вышестоящего `xss@1.0.15`, а наличие в bundle `singleQuotedAttributeValue` (введено в 1.0.15) и отсутствие `filterXSSWithResult` (введено в 1.0.16) служат подтверждением нижней и верхней границы версии. Остальные версии сверены напрямую со строкой версии в файле / `package-lock`.

**Локальные изменения Prism**: в `client/vendor/prism/prism-core.min.js` относительно вышестоящей версии 1.29.0 есть два отличия — внутри `highlightAllUnder` вместо перезаписываемого хуком `env.container` используется контейнер, переданный параметром функции; в конец файла добавлено `window.Prism=Prism;` (глобальная привязка в среде CEP). Изменения не меняют лицензионных обязательств; при обновлении Prism их нужно применить заново.

**CSInterface.js**: Adobe copyright (`Copyright (c) 2012-2017 Adobe Systems Inc.`); в заголовке файла указано, что файл разрешено использовать, изменять и распространять по прилагаемому лицензионному соглашению Adobe. Оригинал этого соглашения (`GenSDK_IHC-en_US-20120323_1224.pdf` из каталога `License/` репозитория Adobe CEP-Resources) размещён в дереве как `client/vendor/CSInterface.LICENSE.pdf` (95,659 B, SHA-256 `32E81408…5383`), и проект использует этот файл по данному соглашению в составе расширения CEP. Файл в дереве — урезанная под нужды проекта реализация (357 строк, 16 методов: `evalScript` / `getHostEnvironment` / `getSystemPath` / `getExtensionPath` / регистрация событий и др.), а не полный текст официального выпуска Adobe (официальная версия v8 — около 1200 строк, дополнительно содержит `setPanelFlyoutMenu` / `updatePanelMenuItem` / `getExtensions` / `getNetworkPreferences` и др.); заголовок об авторских правах и обозначение версии `v8.0.0` сохранены как в вышестоящем проекте, чтобы показать, что интерфейс и способ использования происходят из Adobe CEP SDK.

Кроме CSInterface.js (соглашение Adobe, не OSS), остальные библиотеки распространяются по разрешительным лицензиям типа MIT / BSD; glad дополнительно содержит часть Khronos под Apache-2.0 (отмечено в той же таблице), что совместимо с лицензией MIT этого проекта.

## 4. Зависимости этапа сборки и содержимое Adobe в артефактах сборки (сам SDK не распространяется)

| Компонент | Лицензия | Описание |
| --- | --- | --- |
| Adobe After Effects SDK | Соглашение Adobe SDK | Требуется для компиляции двух нативных компонентов в `native/` (хост GLSL-эффектов / AE Hotbox); сборщик получает его у Adobe самостоятельно; **сам SDK и его текст лицензии не распространяются ни с репозиторием исходников, ни с пакетом Release**; шаги сборки — в [DEVELOPMENT.md](DEVELOPMENT.md) |
| Артефакты сборки `deploy/Plug-ins/*.aex` | Артефакты сборки этого проекта; подпадают под соглашение Adobe SDK | Полный пакет Release содержит `AS_Effect_Host.aex` (около 643 KB) и `AS_Hotbox.aex` (около 1.5 MB). На этапе сборки в них как единицы трансляции включаются неизменённые примеры исходного кода из `Examples/Util` SDK (`AEFX_SuiteHelper.c`, `AEGP_SuiteHandler.cpp`, `MissingSuiteError.cpp`), а также статически слинкованы glad (MIT) и PinIn4Cpp (MIT, включая данные пиньиня pinyin-data); на эти два бинарника лицензия MIT этого проекта не распространяется. Перед повторным распространением или коммерческим использованием самостоятельно уточните условия соглашения с Adobe (при необходимости обратитесь в поддержку разработчиков Adobe). |

> Кроме `.aex`, остальное содержимое полного пакета Release (исходный код, Node.js, зависимости npm) объявлено в этом документе и в LICENSE каждого пакета; `.aex` — единственный бинарный артефакт, скомпилированный этим проектом в рамках данного документа (`vendor/node/node.exe` в пакете — среда выполнения Node.js из вышестоящего проекта, см. раздел 1).

## 5. Материалы, не являющиеся кодом, и источники содержимого

В содержимом, которое проект распространяет вместе с деревом исходников, есть три некодовых актива; **сторонних библиотек изображений, шрифтов и сторонних аудиоматериалов в нём нет**:

| Содержимое | Расположение | Объём | Источник | Описание |
| --- | --- | --- | --- | --- |
| Кадры спрайтов питомца (16 PNG) | `client/features/deepseekPet/sprites/` | около 108.7 MB | Изготовлены автором проекта инструментами генерации ИИ; два элемента `potHead` / `eat` добавлены из самостоятельно сделанных кадров спрайтов, хранящихся вне репозитория | Оригинальная анимация персонажа |
| Видео-пасхалка `appear.webm` | Там же | около 1.8 MB | Сделано автором проекта (сгенерировано ИИ), **содержит сгенерированную ИИ китайскую речь** | Полноэкранная анимация появления, запускаемая при открытии пасхалки питомца |
| Таблица состояний `manifest.json` | Там же | 1.9 KB | Написана автором проекта | Спецификация сетки кадров |

**Шрифты**: все шрифты интерфейса подключаются по имени из установленных на локальной машине — системный стек шрифтов (например, Segoe UI / Microsoft YaHei / Yu Gothic UI / Malgun Gothic / Noto Sans KR / Consolas и др.) с резервными общими семействами `sans-serif` / `serif` / `monospace`; `@font-face` не используется, шрифты не встраиваются в base64 и не загружаются удалённо, файлов шрифтов в поставке нет. Оба нативных компонента используют шрифт Drawbot хоста AE по умолчанию и системный шрифт DirectWrite (`Microsoft YaHei UI`), шрифты в них также не встроены, поэтому у проекта не возникает обязательств по лицензиям на шрифты.

**Описание образа персонажа**: персонаж — антропоморфный кит в фанатском стиле сообщества; мотив (кит, тёмно-синяя палитра) близок к бренд-образу DeepSeek. Публичное название и текст в интерфейсе — «大肥鱼桌宠» и «大肥鱼» (слова DeepSeek в них нет), слово-триггер пасхалки — «大肥鱼». Этот проект не имеет с DeepSeek официальных отношений аффилированности, спонсорства или авторизации, **не получил лицензию на его товарные знаки или авторские права** и не копировал его официальный логотип или словесный товарный знак. При возражении правообладателя образ будет своевременно удалён или заменён: удаление `client/features/deepseekPet/sprites/` убирает образ (недоступной остаётся только функция питомца), либо при экспорте добавьте `--without-sprites`. Идентификаторы в коде по-прежнему `deepseekPet` / `AEDeepseekPet` (каталоги модуля и пространство имён, не текст интерфейса).

**Границы лицензирования**: перечисленные материалы предоставляются вместе с проектом по MIT; части, связанные с бренд-образом DeepSeek, выходят за пределы того, что проект может лицензировать, и связанные с ними риски пользователь несёт сам.

**Документы и данные**: `client/shared/aeApiReference.txt` (китайская компиляция API сценариев AE, используется `queryAeApi`) создан из справочной компиляции этого проекта; в самом файле источник указан как «整理来源：AE脚本API参考», и **предположительно он составлен по официальной документации Adobe по сценариям** (исходного URL в файле нет); при возражении правообладателя он будет удалён или заменён собственной сводкой. `client/shared/aeMatchName.json` — полученное с реальной установки AE сопоставление matchName → отображаемое имя, то есть фактические данные.

**Встроенные иконки интерфейса**: часть path иконок в CSS `data:` SVG и встроенных `<svg>` в `client/` дословно взята из Feather Icons (MIT) и Lucide (ISC); это объявлено в разделе 3, полные тексты лицензий — в приложении.

## 6. Компоненты, получаемые из вышестоящих проектов во время работы и не распространяемые этим проектом

| Компонент | Лицензия | Описание |
| --- | --- | --- |
| Официальная библиотека шаблонов ComfyUI (`Comfy-Org/workflow_templates`) | MIT (© 2023-present Comfy Org) | Функция «официальные шаблоны» во время работы получает индекс шаблонов с `raw.githubusercontent.com` / `cdn.jsdelivr.net` и кэширует его в локальном каталоге данных; **не распространяется ни с репозиторием исходников, ни с пакетом Release** |
| Сервер ComfyUI | Его собственная лицензия | Внешняя программа, которую пользователь предоставляет сам; проект обращается к ней только по сети |
| API крупных платформ LLM | Условия обслуживания каждой платформы | Внешние сервисы, ключ для которых пользователь предоставляет сам; проект только отправляет сетевые запросы |

## Приложение: компоненты, для которых вышестоящие пакеты не приложили текст лицензии

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

BSD-2-Clause. Пакет npm не содержит файла лицензии (`package.json` объявляет `BSD-2-Clause`); ниже приведён полный текст из `js/LICENSE` вышестоящего репозитория `mwilliamson/dingbat-to-unicode`:

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

В заголовке min-файла сохранены только копирайт и название лицензии (`(c) 2023 Julian Garnier` / `Released under the MIT license`, полного текста лицензии в нём нет). Примечание: в LICENSE вышестоящего `anime.js@3.2.2` указан `2019`, что расходится с заголовком min-файла; ниже текст приведён по вышестоящему LICENSE (за основу взят 2019):

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

### acorn@8.18.0 (`client/vendor/es3-parser/`, в дереве — es3-parser)

В dist-артефакте acorn внутри файла сохранено только упоминание авторов и названия лицензии, полного текста лицензии там нет (в `README.md` этого каталога есть описание источника). Ниже текст приведён по LICENSE вышестоящего пакета npm `acorn@8.18.0` (файл `AUTHORS`, на который указывает строка копирайта, в этом дереве не приложен — см. вышестоящий репозиторий):

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

Полный текст лицензии предоставляется вместе с деревом исходников: `native/glsl-host/third_party/glad/LICENSE` (оригинал вышестоящего `Dav1dde/glad` v0.1.36; в дереве — 3,077 B, вышестоящая LF-версия — 3,014 B, в дереве файл получен с CRLF). Файл содержит три части:

- **сам glad**: MIT, `Copyright (c) 2013-2021 David Herberth`;
- **The Khronos Specifications**: `Copyright (c) 2013-2020 The Khronos Group Inc.`, `Licensed under the Apache License, Version 2.0`;
- **The EGL Specification and various headers**: `Copyright (c) 2007-2016 The Khronos Group Inc.` (лицензия Khronos в стиле MIT).

`include/KHR/khrplatform.h` содержит исходный текст лицензии Khronos (`Copyright (c) 2008-2018 The Khronos Group Inc.`).

### pako 1.0.11 (`vendor/node_modules/pako/`, лицензия Zlib)

Лицензия pako — `MIT AND Zlib`: полный текст MIT приложен к пакету (`pako/LICENSE`), а вышестоящий текст части Zlib к пакету npm не приложен; ниже стандартный полный текст из `LICENSE` официального репозитория zlib:

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

### PDF.js 6.1.200 (Apache-2.0, встроен в `vendor/node_modules/unpdf/dist/pdfjs.mjs`)

`unpdf@1.8.0` предоставляет в своём составе serverless-сборку Mozilla PDF.js 6.1.200 (`dist/pdfjs.mjs`, около 1.6 MB); этот файл лицензирован по Apache-2.0, а вышестоящий пакет `unpdf` не прилагает текст этой лицензии. Уведомление об авторских правах вышестоящего проекта: `Copyright 2012 Mozilla Foundation` и участники PDF.js. Лицензия MIT этого проекта не распространяется на встроенный код; при распространении полного пакета Release, содержащего `vendor/node_modules/unpdf/`, этот раздел и полный текст Apache-2.0 ниже должны предоставляться вместе с ним.

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

### cssfilter (встроен в bundle `client/vendor/xss/`)

В упакованный файл `client/vendor/xss/xss.min.js` встроен cssfilter (зависимость фильтрации CSS для js-xss, MIT):

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

### Feather Icons (встроенные иконки в `client/`)

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

### Lucide (встроенные иконки в `client/`)

Ниже полный текст `LICENSE` вышестоящего `lucide-icons/lucide` (год в строке копирайта обновляется вместе с вышестоящей версией; перечисленные в нём иконки производны от Feather, текст MIT для Feather приложен):

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
