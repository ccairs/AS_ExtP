# Hinweise zu Drittanbieter-Komponenten / Third-Party Notices

[简体中文](THIRD-PARTY-NOTICES.md) | [English](THIRD-PARTY-NOTICES.en.md) | [日本語](THIRD-PARTY-NOTICES.ja.md) | **Deutsch** | [한국어](THIRD-PARTY-NOTICES.ko.md) | [Français](THIRD-PARTY-NOTICES.fr.md) | [Русский](THIRD-PARTY-NOTICES.ru.md)

> Dieses Dokument ist eine deutsche Übersetzung. Maßgeblich sind das [chinesische Original](THIRD-PARTY-NOTICES.md) und die unten im englischen Wortlaut wiedergegebenen Lizenztexte.

AS_ExtP wird unter der MIT-Lizenz veröffentlicht (siehe [LICENSE](../LICENSE)). Dieses Dokument listet die von diesem Projekt verteilten oder aufgerufenen Komponenten Dritter und ihre Lizenzen auf.

**Formen der Verteilung**: Dieses Projekt lässt sich auf zwei Wegen beziehen, mit unterschiedlichen Pflichten gegenüber Dritten. **Das vollständige Release-Paket ist sofort einsatzbereit** – es enthält vorkompilierte native Komponenten (`.aex`), eine mitgelieferte Node.js-Laufzeit und npm-Abhängigkeiten; nach dem Entpacken genügt ein Doppelklick auf `tools\install.bat`, eine Node-Installation, `npm ci` oder Kompilieren sind nicht nötig. Wird dieses Paket weitergegeben, sind dieses Dokument und die zugehörigen Lizenzdateien mitzuliefern. **Das Quellcode-Repository enthält** die genannten Binärdateien und Abhängigkeiten **nicht** (Größe und Vertriebsgrenzen); nach dem Klonen sind sie mit `npm ci` und `tools\check-env.bat` / `tools\install.bat` zu ergänzen, die nativen Komponenten sind selbst zu kompilieren. FFmpeg wird von diesem Projekt **nicht verteilt** (weder im Release-Paket noch im Quellcode-Repository enthalten) und von `tools\check-env.bat` / `tools\install.bat` in einer festgelegten Upstream-Version auf den lokalen Rechner geladen.

## 1. Binärkomponenten

### FFmpeg 8.1.2 – GPL-3.0-or-later (von diesem Projekt nicht verteilt)

| Punkt | Beschreibung |
| --- | --- |
| Bezug | **Wird von diesem Projekt nicht verteilt**. `tools\check-env.bat` / `tools\install.bat` laden `8.1.2-essentials_build` aus dem Upstream-Release auf den lokalen Rechner und prüfen den Download vorab gegen die festgelegte SHA-256 (`db580001…`) |
| Ort auf dem Rechner | `vendor/ffmpeg/ffmpeg.exe`, `vendor/ffmpeg/ffprobe.exe` (weder im Quellcode-Repository noch im Release-Paket enthalten) |
| Lizenzvolltext | Dem zip des Upstream liegen `LICENSE.md` / `COPYING.GPLv3` / `COPYING.GPLv2` / `COPYING.LGPLv2.1` / `COPYING.LGPLv3` bei (maßgeblich ist, was tatsächlich vorhanden ist). Nach dem Entpacken belassen `tools\check-env.bat` / `tools\install.bat` diese Dateien zusammen mit `SOURCE.txt` (Download-Adresse, SHA-256, Hinweis auf den zugehörigen Quellcode) in `vendor/ffmpeg/`; dieses Projekt verteilt die Binärdatei weiterhin nicht, bei einer Weitergabe sind diese Texte und die Angaben zum Bezug des Quellcodes mitzuliefern |
| Herkunft und Hinweis auf den zugehörigen Quellcode | `8.1.2-essentials_build` von Gyan Doshi (`GyanD/codexffmpeg`) (GitHub-Release-Tag `8.1.2`), statisch gegen GPL-Komponenten wie libx264 / libx265 gelinkt; der in diesem Release verzeichnete Upstream-Quellcode-Commit ist `FFmpeg/FFmpeg@38b88335f9`, das Quellcode-Paket ist `ffmpeg-8.1.2.tar.xz` von ffmpeg.org |
| Zweck | Aufruf als eigener Prozess (Kommandozeilenschnittstelle) für Videotranskodierung und das Extrahieren von Einzelbildern in der Asset-Bibliothek; nicht in den AS_ExtP-Quellcode gelinkt |

> Dieses Projekt ist an der Verteilung dieser Binärdatei nicht beteiligt und übernimmt daraus keine GPL-Vertriebspflichten; nach erfolgreicher Installation gibt das Skript eine GPL-Zeile aus und belässt die Upstream-Lizenztexte in `vendor/ffmpeg/`. Wer ein Verzeichnis mit ffmpeg weitergibt, muss die Pflichten aus GPL-3.0-or-later selbst erfüllen (Lizenz beilegen, zugehörigen Quellcode bereitstellen).

### Node.js 22.23.2 – MIT

| Punkt | Beschreibung |
| --- | --- |
| Vertriebsform | Wird mit dem vollständigen Release-Paket verteilt (im Quellcode-Repository nicht enthalten; bei einem Quellcode-Klon Node ≥ 20.18 selbst installieren) |
| Ort | `vendor/node/node.exe` |
| Lizenzvolltext | `vendor/node/LICENSE` – das Original aus dem offiziellen `node-v22.23.2-win-x64.zip`, einschließlich der Lizenzhinweise der in Node eingebauten Komponenten. Das Installationsskript prüft das Distributionspaket mit der festgelegten SHA-256 `1177b413…` (`tools/install.bat`, `tools/check-env.bat`); der Wert stimmt mit der `SHASUMS256.txt` des Upstream überein; die `node.exe` im Paket hat denselben Hash wie die `node.exe` in diesem Verzeichnis (`0d0f5e39…`) |
| Zweck | Laufzeit für die lokale Bridge und den stdio-MCP-Server |

## 2. npm-Abhängigkeiten (`vendor/node_modules/`, mit dem vollständigen Release-Paket verteilt)

Außer den in der Tabelle mit ※ markierten Paketen enthalten alle Paketverzeichnisse ihre Lizenzdatei selbst (die Lizenzvolltexte der ※-Pakete stehen im Anhang); die Tabelle ist eine Übersicht, maßgeblich für die Versionen ist `package-lock.json`. **Es gibt keine zwingenden GPL- / AGPL- / LGPL-Abhängigkeiten** (`jszip` ist doppelt lizenziert als `MIT OR GPL-3.0-or-later`, dieses Projekt nutzt es unter MIT). Das vollständige Release-Paket enthält dieses Verzeichnis und die mitgelieferten Lizenzdateien der Pakete; ein Quellcode-Klon enthält es nicht, `npm ci` installiert die Pakete gemäß `package-lock.json` in das `node_modules` im Wurzelverzeichnis, die Deployment-Skripte (`deploy.bat` / `install.bat`) kopieren sie nach `vendor/node_modules`. Zur Laufzeit setzt `client/shared/ae-bridge.js` `NODE_PATH` auf `vendor/node_modules` (ebenso `client/shared/ext-mcp-server.js`); Nodes reguläre Auflösung trifft zuerst das nächstgelegene `node_modules`, `NODE_PATH` dient als Rückfallebene, sodass Abhängigkeiten sowohl im Quellcode-Klon (`node_modules` im Wurzelverzeichnis) als auch im deployten Zustand (nur `vendor/node_modules`) aufgelöst werden. `xmlbuilder` 10.1.1 ist verschachtelt unter `vendor/node_modules/mammoth/node_modules/xmlbuilder/` installiert (von mammoth mitgeliefert), die übrigen Pakete liegen direkt unter `vendor/node_modules/`.

| Paket | Version | Lizenz |
| --- | --- | --- |
| @wwek/xlsx | 0.20.3 | Apache-2.0 |
| @xmldom/xmldom | 0.8.13 | MIT |
| argparse | 1.0.10 | MIT |
| base64-js | 1.5.1 | MIT |
| bluebird | 3.4.7 | MIT |
| core-util-is | 1.0.3 | MIT |
| dingbat-to-unicode | 1.0.1 | BSD-2-Clause ※ |
| duck | 0.1.12 | BSD-2-Clause (das Upstream-Feld nennt nur „BSD“, der Text ist die BSD-Lizenz mit zwei Klauseln) |
| immediate | 3.0.6 | MIT |
| inherits | 2.0.4 | ISC |
| isarray | 1.0.0 | MIT ※ |
| jszip | 3.10.1 | MIT OR GPL-3.0-or-later (dieses Projekt nutzt es unter MIT) |
| lie | 3.3.0 | MIT |
| lop | 0.4.2 | BSD-2-Clause |
| mammoth | 1.12.1 | BSD-2-Clause |
| option | 0.2.4 | BSD-2-Clause |
| pako | 1.0.11 | MIT AND Zlib ※ (das Paket enthält nur den MIT-Text, der vollständige Zlib-Text steht im Anhang) |
| path-is-absolute | 1.0.1 | MIT |
| process-nextick-args | 2.0.1 | MIT |
| readable-stream | 2.3.8 | MIT |
| safe-buffer | 5.1.2 | MIT |
| setimmediate | 1.0.5 | MIT |
| sprintf-js | 1.0.3 | BSD-3-Clause |
| string_decoder | 1.1.1 | MIT |
| underscore | 1.13.8 | MIT |
| unpdf | 1.8.0 | MIT; eingebettetes Mozilla PDF.js 6.1.200 (Apache-2.0) ※ |
| util-deprecate | 1.0.2 | MIT |
| xmlbuilder | 10.1.1 | MIT |

※ = Das Upstream-Paket enthält den vollständigen Text dieser Lizenz nicht (oder hat ihn nicht mitgeliefert); der vollständige Text steht im Anhang. `dist/pdfjs.mjs` aus `unpdf@1.8.0` ist ein serverless-Build von Mozilla PDF.js (eingebettete Version 6.1.200); dieser Teil steht unter Apache-2.0. Das Upstream-Paket `unpdf` enthält nur seinen eigenen MIT-Text, nicht den Apache-2.0-Text.

## 3. Mit dem Quellcodebaum verteilte Quellcodebibliotheken Dritter

Die folgenden Bibliotheken sind als Quellcode im öffentlichen Repository enthalten; **glad** und **PinIn4Cpp** werden zur Buildzeit statisch in die `.aex` des Release-Pakets kompiliert (also in Binärform mit dem Release verteilt). Ihre Lizenztexte werden mit dem Quellcodebaum bereitgestellt und erfüllen damit die Anforderung der permissiven Lizenzen, Copyright- und Lizenzhinweise mit jeder Kopie beizubehalten:

| Bibliothek | Ort | Version | Lizenz | Lizenztext | Zweck |
| --- | --- | --- | --- | --- | --- |
| marked | `client/vendor/marked/` | 12.0.2 | MIT | `LICENSE` im Baum | Markdown-Rendering |
| Prism.js | `client/vendor/prism/` | 1.29.0 (geschätzt) | MIT | `LICENSE` im Baum | Syntaxhervorhebung |
| js-xss | `client/vendor/xss/` | 1.0.15 (geschätzt) | MIT | `LICENSE` im Baum; das Bundle bettet zusätzlich cssfilter (MIT) ein, Volltext im Anhang | HTML-Bereinigung |
| anime.js | `client/vendor/anime/` | 3.2.2 | MIT (© 2019 Julian Garnier; der Dateikopf der Upstream-min-Datei nennt fälschlich 2023) | Hinweis im Dateikopf; Volltext im Anhang | Oberflächenanimation |
| acorn (es3-parser) | `client/vendor/es3-parser/` | 8.18.0 | MIT (© 2012-2022 by various contributors) | Hinweis in der Datei `acorn.js` + Quell-`README.md` (Lizenzvolltext im Anhang) | ES3-Parser des AST-Kompiliergates |
| CSInterface.js | `client/vendor/CSInterface.js` | 8.0.0 (reduzierte Implementierung) | Adobe-SDK-Lizenzvereinbarung (kein OSS); die Datei behält den Adobe-Copyright-Kopf und die Versionsnummer | `CSInterface.LICENSE.pdf` im Baum (Original der Vereinbarung, siehe unten) | CEP-Host-Schnittstelle |
| glad | `native/glsl-host/third_party/glad/` | 0.1.36 (Generator) | MIT + Khronos Apache-2.0 | `LICENSE` im Baum (Upstream-Original mit den drei Abschnitten glad / Khronos Specifications / EGL headers); `include/KHR/khrplatform.h` enthält den Khronos-Lizenztext selbst | OpenGL-Loader |
| PinIn4Cpp | `native/hotbox/third_party/PinIn4Cpp/` | 1.5.8 | MIT (© 2025 KagiyamaHina) | `LICENSE` im Baum; `licenses/` enthält zwei MIT-Texte: PinIn (© 2019 Juntong Liu) und pinyin-data (© 2016 mozillazg) | Pinyin-Abgleich der Hotbox |
| json2 (Adaption von Crockfords json2.js) | `host/api/json2.jsx` | keine Versionsangabe | Public Domain | Hinweis im Dateikopf (gemeinfrei, keine Pflicht zu einem Lizenztext) | JSON-Polyfill für ExtendScript (ES3 hat kein natives JSON) |
| Feather Icons / Lucide | CSS-`data:`-SVG und inline-`<svg>` unter `client/` | – | MIT (Feather, © 2013-2023 Cole Bemis) / ISC (Lucide) | Volltext im Anhang | Inline-Symbole der Oberfläche (einige Pfade wörtlich vom Upstream übernommen) |

„–“ = Im gepackten min-File ist keine Versionsnummer angegeben. **Die Versionen von Prism / js-xss sind geschätzt**: Bei Prism wurde `prism-core.min.js` byteweise mit der offiziellen `components/prism-core.min.js` aus `prismjs@1.29.0` verglichen und stimmt überein (`prism-clike` / `prism-javascript` und die Themendateien entsprechen dem offiziellen Stand); bei js-xss stimmt die SHA-256 von `xss.min.js` (`2072387B…3261E`) mit dem offiziellen Artefakt von `xss@1.0.15` überein, und das Bundle enthält `singleQuotedAttributeValue` (in 1.0.15 eingeführt), aber nicht `filterXSSWithResult` (in 1.0.16 eingeführt), was die Version nach oben und unten eingrenzt. Alle übrigen Versionen wurden direkt mit der Versionszeichenkette in der Datei / `package-lock` abgeglichen.

**Lokale Änderungen an Prism**: `client/vendor/prism/prism-core.min.js` weicht an zwei Stellen von Upstream 1.29.0 ab – in `highlightAllUnder` wird statt `env.container` (das ein Hook ändern könnte) ein als Parameter übergebener Container verwendet; am Dateiende wurde `window.Prism=Prism;` angehängt (Mounten des globalen Objekts in der CEP-Umgebung). Die Änderungen berühren die Lizenzpflichten nicht und sind bei einem Prism-Update erneut anzuwenden.

**CSInterface.js**: Adobe-Copyright (`Copyright (c) 2012-2017 Adobe Systems Inc.`); der Dateikopf erklärt, dass die Datei gemäß der beiliegenden Adobe-Lizenzvereinbarung verwendet, geändert und verteilt werden darf. Der Originaltext dieser Vereinbarung (`GenSDK_IHC-en_US-20120323_1224.pdf`, aus dem Verzeichnis `License/` entnommen des Adobe-Repositories CEP-Resources) liegt als `client/vendor/CSInterface.LICENSE.pdf` im Baum (95,659 B, SHA-256 `32E81408…5383`); dieses Projekt verwendet die Datei im Rahmen dieser Vereinbarung für die CEP-Erweiterung. Die Datei im Baum ist eine für die Anforderungen des Projekts reduzierte Implementierung (357 Zeilen, 16 Methoden: `evalScript` / `getHostEnvironment` / `getSystemPath` / `getExtensionPath` / Ereignisregistrierung und weitere) und nicht der vollständige Text der offiziellen Adobe-Ausgabe (die offizielle v8 hat etwa 1200 Zeilen und enthält zusätzlich `setPanelFlyoutMenu` / `updatePanelMenuItem` / `getExtensions` / `getNetworkPreferences` und weitere). Copyright-Kopf und Versionskennung `v8.0.0` sind wie im Upstream belassen, um zu belegen, dass Schnittstelle und Verwendung aus dem Adobe CEP SDK stammen.

Außer CSInterface.js (Adobe-Vereinbarung, kein OSS) stehen alle übrigen Bibliotheken unter permissiven Lizenzen vom Typ MIT / BSD; glad enthält zusätzlich den Apache-2.0-Teil von Khronos (in derselben Tabelle vermerkt), der mit der MIT-Lizenz dieses Projekts vereinbar ist.

## 4. Abhängigkeiten zur Buildzeit und Adobe-Inhalte in den kompilierten Artefakten (das SDK selbst wird nicht verteilt)

| Komponente | Lizenz | Beschreibung |
| --- | --- | --- |
| Adobe After Effects SDK | Adobe-SDK-Vereinbarung | Wird zum Kompilieren der beiden nativen Komponenten unter `native/` (GLSL-Effekt-Host / AE-Hotbox) benötigt und vom Erstellenden selbst bei Adobe zu beziehen; **das SDK selbst und seine Lizenztexte werden weder mit dem Quellcode-Repository noch mit dem Release-Paket verteilt**; die Build-Schritte stehen in [DEVELOPMENT.md](DEVELOPMENT.md) |
| Build-Artefakt `deploy/Plug-ins/*.aex` | Build-Artefakt dieses Projekts; unterliegt der Adobe-SDK-Vereinbarung | Das vollständige Release-Paket enthält `AS_Effect_Host.aex` (ca. 643 KB) und `AS_Hotbox.aex` (ca. 1.5 MB). Zur Buildzeit werden unveränderte Beispielquellen aus `Examples/Util` des SDK (`AEFX_SuiteHelper.c`, `AEGP_SuiteHandler.cpp`, `MissingSuiteError.cpp`) als Übersetzungseinheiten einkompiliert und glad (MIT) sowie PinIn4Cpp (MIT, mit den Pinyin-Daten von pinyin-data) statisch gelinkt; diese beiden Binärdateien fallen nicht unter die MIT-Lizenz dieses Projekts. Vor Weitergabe oder kommerzieller Nutzung die Bedingungen der Vereinbarung mit Adobe selbst prüfen (bei Bedarf den Adobe-Entwicklersupport kontaktieren). |

> Abgesehen von den `.aex` gelten für alle übrigen Inhalte des vollständigen Release-Pakets (Quellcode, Node.js, npm-Abhängigkeiten) die Angaben in diesem Dokument und die LICENSE-Dateien der jeweiligen Pakete; die `.aex` sind das einzige in diesem Dokument erfasste Binärartefakt, das von diesem Projekt kompiliert wird (die `vendor/node/node.exe` im Paket ist die Node.js-Laufzeit des Upstream, siehe Abschnitt 1).

## 5. Nicht-Code-Assets und Herkunft der Inhalte

Die mit dem Quellcodebaum verteilten Inhalte umfassen drei Nicht-Code-Assets; **es sind keine Bildbibliotheken, Schriften oder Audioassets Dritter enthalten**:

| Inhalt | Ort | Größe | Herkunft | Beschreibung |
| --- | --- | --- | --- | --- |
| Bildsequenz des Desktop-Pets (16 PNG) | `client/features/deepseekPet/sprites/` | ca. 108.7 MB | Vom Projektautor mit KI-Generierungswerkzeugen erstellt; `potHead` / `eat` wurden aus selbst erstellten Bildsequenzen außerhalb des Repositories übernommen | Eigene Figurenanimation |
| Easter-Egg-Video `appear.webm` | ebenda | ca. 1.8 MB | Vom Projektautor erstellt (KI-generiert), **enthält KI-generierte chinesische Sprachausgabe** | Vollbild-Auftrittsanimation nach dem Öffnen des Desktop-Pet-Easter-Eggs |
| Statustabelle `manifest.json` | ebenda | 1.9 KB | Vom Projektautor verfasst | Spezifikation des Frame-Rasters |

**Schriften**: Alle Schriften der Oberfläche werden ausschließlich über ihren Namen auf dem Rechner installierter Schriften referenziert – der Systemschriftstapel (etwa Segoe UI / Microsoft YaHei / Yu Gothic UI / Malgun Gothic / Noto Sans KR / Consolas) sowie die generischen Familien `sans-serif` / `serif` / `monospace` als Rückfallebene; es wird kein `@font-face` verwendet, keine base64-Schrift eingebettet, keine Schrift aus der Ferne geladen, und es liegen keine Schriftdateien im Paket. Die beiden nativen Komponenten verwenden die Drawbot-Standardschrift des AE-Hosts und die DirectWrite-Systemschrift (`Microsoft YaHei UI`); auch sie bündeln keine Schrift, sodass für dieses Projekt keine Schriftlizenzpflichten entstehen.

**Zur Figurenzeichnung**: Die Figur ist eine anthropomorphe, im Stil einer Community-Ableitung gestaltete Wal-Figur; Motiv (Wal, dunkelblaue Farbgebung) und DeepSeek-Markenbild sind ähnlich. Der öffentliche Name und die Texte in der Oberfläche lauten „大肥鱼桌宠“ und „大肥鱼“ (ohne den Schriftzug DeepSeek), das Auslösewort des Easter Eggs ist „大肥鱼“. Dieses Projekt steht in keiner Verbindung, Sponsoring- oder Lizenzbeziehung zu DeepSeek und hat **keine Lizenz an dessen Marke oder Urheberrecht** erhalten; offizielle Kennzeichen oder Wortmarken wurden nicht kopiert. Erhebt ein Rechteinhaber Einspruch gegen die Figur, wird sie umgehend entfernt oder ersetzt: Das Löschen von `client/features/deepseekPet/sprites/` entfernt die Figur (nur die Desktop-Pet-Funktion entfällt), alternativ beim Export `--without-sprites` angeben. Die Bezeichner im Code bleiben `deepseekPet` / `AEDeepseekPet` (Modulverzeichnis und Namensraum, keine Oberflächentexte).

**Lizenzgrenze**: Die genannten Assets werden mit diesem Projekt unter MIT bereitgestellt; die Teile, die das DeepSeek-Markenbild betreffen, liegen außerhalb dessen, was dieses Projekt lizenzieren kann – das Risiko trägt der Benutzer selbst.

**Dokumente und Daten**: `client/shared/aeApiReference.txt` (eine chinesische Zusammenstellung der AE-Skript-API für `queryAeApi`) wurde aus einem Referenzskript dieses Projekts erzeugt; die Datei nennt selbst als Quelle „整理来源：AE脚本API参考“ (Zusammenstellung aus der AE-Skript-API-Referenz) und wurde **vermutlich anhand der offiziellen Adobe-Skriptdokumentation zusammengestellt** (die Datei enthält keine ursprüngliche URL); bei Einspruch eines Rechteinhabers wird sie entfernt oder durch eine eigene Zusammenfassung ersetzt. `client/shared/aeMatchName.json` ist eine auf einem realen AE-Export beruhende Zuordnung von matchName zu Anzeigename und stellt faktische Daten dar.

**Inline-Symbole der Oberfläche**: Einige Symbolpfade in den CSS-`data:`-SVGs und inline-`<svg>` unter `client/` sind wörtlich Feather Icons (MIT) und Lucide (ISC) entnommen; sie sind in Abschnitt 3 aufgeführt, die Lizenzvolltexte stehen im Anhang.

## 6. Zur Laufzeit vom Upstream bezogene Komponenten, die dieses Projekt nicht verteilt

| Komponente | Lizenz | Beschreibung |
| --- | --- | --- |
| Offizielle ComfyUI-Vorlagenbibliothek (`Comfy-Org/workflow_templates`) | MIT (© 2023-present Comfy Org) | Die Funktion „Offizielle Vorlagen“ lädt zur Laufzeit den Vorlagenindex von `raw.githubusercontent.com` / `cdn.jsdelivr.net` und speichert ihn im lokalen Datenordner zwischen; **wird weder mit dem Quellcode-Repository noch mit dem Release-Paket verteilt** |
| ComfyUI-Server | Dessen eigene Lizenz | Ein vom Benutzer bereitgestelltes externes Programm; dieses Projekt ruft es nur über das Netzwerk auf |
| APIs der LLM-Plattformen | Nutzungsbedingungen der jeweiligen Plattform | Externe Dienste mit vom Benutzer bereitgestellten Schlüsseln; dieses Projekt stellt nur Netzwerkanfragen |

## Anhang: Komponenten, deren Lizenztext der Upstream nicht beifügt

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

BSD-2-Clause. Das npm-Paket enthält keine Lizenzdatei (die `package.json` deklariert `BSD-2-Clause`); der folgende Volltext stammt aus der `js/LICENSE` des Upstream-Repositories `mwilliamson/dingbat-to-unicode`:

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

Der Dateikopf der min-Datei enthält nur Copyright und Lizenznamen (`(c) 2023 Julian Garnier` / `Released under the MIT license`), nicht den Lizenzvolltext. Hinweis: Die LICENSE von `anime.js@3.2.2` im Upstream nennt `2019`, was nicht zum Kopf der min-Datei passt; der folgende Text folgt der Upstream-LICENSE (maßgeblich ist 2019):

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

### acorn@8.18.0 (`client/vendor/es3-parser/`, als es3-parser eingebunden)

Das dist-Artefakt von acorn enthält nur einen Hinweis auf Autor und Lizenznamen in der Datei, nicht den Lizenzvolltext (die `README.md` im Verzeichnis beschreibt die Herkunft). Der folgende Text ergänzt die LICENSE des Upstream-npm-Pakets `acorn@8.18.0` (die in der Copyright-Zeile genannte Datei `AUTHORS` liegt diesem Baum nicht bei, siehe Upstream-Repository):

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

Der Lizenzvolltext liegt mit dem Quellcodebaum vor: `native/glsl-host/third_party/glad/LICENSE` (Original von `Dav1dde/glad` v0.1.36, im Baum 3,077 B; die LF-Fassung des Upstream hat 3,014 B, im Baum liegt ein CRLF-Checkout). Die Datei enthält drei Abschnitte:

- **glad selbst**: MIT, `Copyright (c) 2013-2021 David Herberth`;
- **The Khronos Specifications**: `Copyright (c) 2013-2020 The Khronos Group Inc.`, `Licensed under the Apache License, Version 2.0`;
- **The EGL Specification and various headers**: `Copyright (c) 2007-2016 The Khronos Group Inc.` (MIT-artige Lizenz von Khronos).

Die Datei `include/KHR/khrplatform.h` enthält den Khronos-Lizenztext selbst (`Copyright (c) 2008-2018 The Khronos Group Inc.`).

### pako 1.0.11 (`vendor/node_modules/pako/`, Zlib-Lizenz)

Die Lizenz von pako lautet `MIT AND Zlib`: Der MIT-Volltext liegt im Paket bei (`pako/LICENSE`), der Upstream-Text für den Zlib-Teil fehlt im npm-Paket; das Folgende ist der Standardvolltext der `LICENSE` des offiziellen zlib-Repositories:

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

### PDF.js 6.1.200 (Apache-2.0, eingebettet in `vendor/node_modules/unpdf/dist/pdfjs.mjs`)

Das Paket `unpdf@1.8.0` liefert einen serverless-Build von Mozilla PDF.js 6.1.200 mit (`dist/pdfjs.mjs`, ca. 1.6 MB); die Datei steht unter Apache-2.0, das Upstream-Paket `unpdf` enthält diesen Lizenztext nicht. Der Upstream-Copyright-Hinweis nennt `Copyright 2012 Mozilla Foundation` und die PDF.js-Beitragenden. Die MIT-Lizenz dieses Projekts erfasst diesen eingebetteten Code nicht; wer ein vollständiges Release-Paket mit `vendor/node_modules/unpdf/` weitergibt, muss diesen Abschnitt und den folgenden Apache-2.0-Volltext mitliefern.

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

### cssfilter (in das Bundle unter `client/vendor/xss/` eingebettet)

Die gepackte Datei `client/vendor/xss/xss.min.js` bettet cssfilter ein (die CSS-Filter-Abhängigkeit von js-xss, MIT):

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

### Feather Icons (Inline-Symbole unter `client/`)

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

### Lucide (Inline-Symbole unter `client/`)

Das Folgende ist der Volltext der `LICENSE` aus dem Upstream `lucide-icons/lucide` (die Jahreszahl der Copyright-Zeile ändert sich mit der Upstream-Version; die darin aufgeführten Symbole stammen von Feather, der Feather-MIT-Volltext ist beigefügt):

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
