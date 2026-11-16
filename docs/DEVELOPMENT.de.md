# AS_ExtP Entwicklerdokumentation

[简体中文](DEVELOPMENT.md) | [English](DEVELOPMENT.en.md) | [日本語](DEVELOPMENT.ja.md) | **Deutsch** | [한국어](DEVELOPMENT.ko.md) | [Français](DEVELOPMENT.fr.md) | [Русский](DEVELOPMENT.ru.md)

Für alle, die den Quellcode lesen, ändern oder die nativen Komponenten selbst kompilieren möchten. Installation und Verwendung stehen in [README.md](../README.md).

Dieses Dokument richtet sich an die Weiterentwicklung: Es folgen technische Architektur, Vorbereitung und Prüfung der Umgebung, Deployment, Lokalisierung (Localization), das Kompilieren der nativen Komponenten und Entwicklungsmaterial zur Hotbox.

Lizenzhinweise zu Komponenten Dritter, Herkunft der Assets und Regeln zur Weitergabe stehen in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) (wird mit dem Quellcodebaum und dem vollständigen Release-Paket verteilt); die MIT-Lizenz dieses Projekts steht in [LICENSE](../LICENSE).

## 1. Technische Architektur

AS_ExtP nutzt eine Architektur aus **CEP-Bedienfeld (CEF / Chrome 88) + lokaler Node-Bridge**:

```
CEP-Bedienfeld (CEF, file://)
  │  8 Funktionsmodule + features (Schnellleiste / Desktop-Pet / Anzeige für externe Zugriffsrechte)
  │  Gemeinsame Basis: AEFS · Bridge · ToolRegistry · AST-Gate (PromptBuilder in client/llm/, ContextManager in client/modules/agent/engine/, Container-Kontext in client/core/)
  ├── CSInterface.evalScript()  ──►  AE-Engine (host.jsx + host/api/*.jsx) führt ExtendScript aus
  ├── Node Bridge (127.0.0.1:9877, HTTP + WebSocket)
  │     ├─ Dateisystem (vollständiges Lesen und Schreiben, inklusive Binärkanal)
  │     ├─ Verwaltung externer MCP-Prozesse
  │     └─ /mcp-Endpunkt (Streamable-HTTP-Transport im Extern-Modus)
  └── Extern-Modus: externer Agent ⇄ stdio / HTTP ⇄ Bridge-Relay ⇄ Bedienfeld ⇄ AE
```

- **Dateisystem (AEFS)**: `client/shared/aefs.js` bietet einheitliches Lesen und Schreiben von Dateien mit einem mehrstufigen Rückfall **Bridge → cep.fs → ExtendScript** und mehrstufigen Pfadprüfungen (Ablehnung von `%`, Steuerzeichen, `..`-Traversal, nicht absoluten Pfaden und DOS-Gerätenamen; Schreib- und Löschvorgänge sind auf eine Allowlist sicherer Verzeichnisse beschränkt).
- **AST-Kompiliergate**: Alle von der KI erzeugten oder vom Benutzer gespeicherten Skripte durchlaufen vor der Ausführung ein gemeinsames statisches Kompiliergate – ExtendScript-Dialektvorverarbeitung → acorn-Parser (ES3) → Prüfung von Typen und Mitgliedern gegen die Allowlist → Neuausgabe und Ausführung. Geprüft und ausgeführt wird derselbe Code; es gibt kein Zeitfenster für ein „Umschreiben nach der Prüfung“. Alle vier Eingänge (Tool-Aufrufe des Agenten, Vorschaubereich, JSON-Tooldefinitionen, Skriptbaum / Schnellleiste) laufen hier zusammen; hochriskante Formen werden am Gate abgefangen und dem Modell zur Umschreibung zurückgegeben. Unter „Agent-Moduleinstellungen → AST-Gate-Fähigkeiten“ lassen sich Kanalvertrauen, die Schalter der Fähigkeitsbereiche und die Allowlist-Ergänzungen einsehen. Skriptbaum und Schnellleiste (`user-library`) laufen im Audit-Modus: Das Gate erzeugt nur eine Liste gefährlicher Stellen und schreibt den Code nicht um (siehe `client/modules/ast-gate/run.js`).
- **Datenordner**: Das Erweiterungsstammverzeichnis ist schreibgeschützt, die Laufzeitdaten liegen in `%APPDATA%\Adobe\CEP\extensions\AS_ExtP` (Skripte, Skills, Gedächtnis, Tools, Effekte, Vorgaben und weitere). In den globalen Einstellungen lässt sich ein eigener Ort festlegen: Der Wechsel ist eine **vollständige Kopie** (enthält das Ziel bereits Daten, erscheint zuerst eine Überschreibbestätigung; nach der Bestätigung werden die Zieldaten gelöscht und dann kopiert). Zum Abschluss werden in den kopierten **Bibliotheksindizes** (`assets/<Bibliothek>/*.json`) absolute Pfade, die mit dem alten Stamm beginnen, **auf den neuen Stamm umgeschrieben** – sonst würde ein Scan beim Start im neuen Verzeichnis gleichnamige Dateien als „nicht registriert“ erneut aufnehmen (Fälle doppelter Einträge gab es bei Vorgaben und Projekt-Assets). Der alte Ordner wird nicht automatisch gelöscht und muss vom Benutzer nach Prüfung selbst bereinigt werden. **Beim Anlegen neuer Bibliotheken beachten**: Im Index keine absoluten Pfade auf Dateien innerhalb der Bibliothek ablegen (relative Pfade speichern oder zur Laufzeit aus dem Datenordner berechnen); müssen absolute Pfade gespeichert werden, ist beim Abschluss der Migration dieselbe Umschreibung nötig (siehe `rebaseLibraryIndexPaths` in `client/shared/dataDir.js`).
- **Prompt-Bus**: Der endgültige Prompt an das LLM wird in vier Schichten zusammengesetzt (System-Prompt-Gerüst → PromptBuilder-Pipeline → Einspielen der Verlaufsnachrichten → Verpackung des User-Prompts); die Module beteiligen sich über die standardisierten Injektionspunkte und verketten keine Zeichenketten selbst.
- **Node-Bridge**: Dient Dateioperationen und der Verwaltung von MCP-Prozessen, beendet sich bei Untätigkeit selbst und wird bei geöffnetem Bedienfeld per Heartbeat am Leben gehalten. HTTP-Endpunkt und stdio-Eingang des Extern-Modus teilen denselben Protokollkern; Tool-Aufrufe werden einheitlich über das Bedienfeld seriell ausgeführt (die AE-Skript-Engine ist ein einzelner Thread).
- **Diagnoseprotokoll**: Die Protokolle von Bedienfeld / Bridge / Host / nativen Komponenten verwenden einheitliche ISO-Zeitstempel und eine Obergrenze der Dateigröße (Fehlerzeilen der Bridge tragen zusätzlich die Markierung `[ERR]`). Beim Export des Diagnosepakets wird einheitlich anonymisiert und wiederholte Zeilen werden nach Signatur zusammengefasst (bei gleicher Signatur über der Schwelle bleibt nur die erste Zeile stehen, mit Gesamtzahl und Zeitspanne); der Export erfolgt in den globalen Einstellungen.

### AEFS-Ausnahmeliste

Datei-I/O auf der Bedienfeldseite (CEP) läuft ausschließlich über AEFS; eine Prüfung des gesamten Repositories zeigt Ausnahmen nur auf der Host- / ExtendScript-Seite, insgesamt **zwei Kategorien mit sieben Aufrufstellen zum Löschen von Dateien** (keine Ausnahme im JS der Bedienfeldseite):

1. **Selbstbereinigung der Startkette (5 Stellen, strukturell nicht über AEFS möglich)**: `_sweepHandoffLeftovers` in `host/host.jsx` (entfernt verwaiste Handoff-Token, vbs-Dateien und `.axd`-Erkennungsskripte für mehrere Instanzen), das Löschen von `vbsFile` am Ende von `startBridge`, `_runAxDetectionProbe`, das das in diesem Lauf geschriebene `.axd`-Erkennungsskript löscht, `_clearMultiInstanceMarker`, das `ae_extp_multi_instance.json` löscht, und `_writeHostLoadErrors`, das die Handshake-Datei nur bei fehlenden Fehlern löscht – AEFS ist ein Modul der Bedienfeldseite, und seine Löschschnittstelle ist auf Bridge / CEP angewiesen, während diese Aufrufe genau dann laufen, wenn „noch keine Bridge existiert“ oder der Startselbsttest ausläuft. Pfad = Datenordner `temp/handoff` (Rückfall: temporäres Systemverzeichnis); gelöscht werden ausschließlich von der Startkette erzeugte Dateien (Handoff-Token / vbs / `.axd`-Erkennungsskripte, Multi-Instanz-Markierung, Fehlerbericht des letzten Ladens). Schutz = exakte Dateinamen-Regexe, nur Dateien werden gelöscht (gleichnamige Verzeichnisse übersprungen), und der Bereinigungslauf erfasst nur Reste, deren `mtime` mehr als 10 Minuten zurückliegt.
2. **„Erst aufräumen, dann kopieren“ im Exportablauf (2 Stellen, zeitlich ungünstig für AEFS)**: je eine Stelle in `exportWholeProject` / `exportCompOrLayer` von `host/api/projectAssetApi.jsx`, die vor dem erneuten Kopieren gleichnamigen Filmmaterials die alte Kopie im Paket entfernt. Der Löschpunkt liegt mitten im Ablauf auf der ES-Seite (vor dem Kopieren); eine Übergabe an das Bedienfeld brächte eine „Wettlaufsituation zwischen Aufräumen und Export“. Daher bleibt das Löschen auf der Host-Seite, doch vorher wird mit `_ensureUnderRoot(dstPath, footageDir.fsName)` die `_checkPath`-Prüfung und die Containerbestimmung von AEFS nachgebildet (Ablehnung von `%`, Steuerzeichen, Anführungszeichen, DOS-Gerätenamen und `..`-Segmenten; der Pfad muss unterhalb von footageDir liegen); bei Überschreitung wird nur protokolliert und nicht gelöscht.

## 2. Vorbereitung und Prüfung der Umgebung

> **Die beiden Bezugswege haben unterschiedliche Voraussetzungen**: Das **vollständige Release-Paket ist sofort einsatzbereit** (enthält die Node-Laufzeit, npm-Abhängigkeiten und vorkompilierte `.aex`); nach dem Entpacken genügt ein Doppelklick auf `tools\install.bat`. Dieser Abschnitt kann dann übersprungen werden. **Ein Quellcode-Klon ist nicht sofort einsatzbereit** und braucht das unten genannte Node, `npm ci`, `check-env.bat` (lädt Node / ffmpeg herunter) sowie bei Bedarf das Kompilieren der nativen Komponenten.

- Node.js **≥ 20.18** (das CEF der Bedienfeldseite ist Chrome 88 ohne Node-Laufzeit: Im Bedienfeld existieren `require` / `process` nicht, Datei-I/O läuft ausschließlich über AEFS)
- Abhängigkeiten installieren: `npm ci`; oder Doppelklick auf `tools\check-env.bat` (prüft Node, Abhängigkeiten, ffmpeg und AE-Version Punkt für Punkt und gibt Hinweise zum Nachholen)
- `npm run lint` – ESLint-Prüfung (`eslint.config.js`)
- `npm run audit:theme` / `npm run audit:family` – Prüfung auf fest codierte Themenwerte und ausgestorbene Fehlermodus-Familien (CI-Gate)
- Die CI des öffentlichen Repositories (`.github/workflows/ci.yml`) hat zwei Jobs: `lint-and-audits` führt `npm ci` → `lint` → die beiden Prüfungen aus; `release-tree-check` führt auf einer sauberen Auscheckung ohne installierte Abhängigkeiten `node tools/release-check.js --public . --public-only` aus (öffentlicher Baum ohne Binärdateien, ohne `node_modules` / `vendor`, NOTICES vollständig). Jeder fehlgeschlagene Schritt führt zu einem roten Lauf

## 3. Deployment in CEP

Die beiden Skripte haben unterschiedliche Aufgaben:

- **Erstinstallation / normale Benutzer**: Doppelklick auf `tools\install.bat`. Erkennt automatisch installierte After Effects-Versionen, lädt Node und ffmpeg herunter, schreibt `PlayerDebugMode` und stellt native Komponenten automatisch bereit, sobald `deploy\Plug-ins\*.aex` gefunden werden.
- **Update-Deployment in der Entwicklungsphase**: Nach Änderungen an `host` / `client` / `CSXS` oder an nativen Komponenten genügt ein Doppelklick auf `tools\deploy.bat` (Administratorrechte erforderlich; kopiert diese Teile nach `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\AS_ExtP`). Es lädt nichts herunter, ändert die Registrierung nicht, setzt ein vorhandenes `vendor\` voraus und weist bei Fehlen darauf hin, zuerst `tools\check-env.bat` auszuführen.

Beide Skripte ergänzen ein fehlendes `vendor\node_modules` durch Kopieren aus dem `node_modules` im Wurzelverzeichnis des Quellcodes – die Bridge im Deployment löst ihre Abhängigkeiten aus `vendor\node_modules` auf (Analyse von docx- / xlsx- / pdf-Anhängen).

## 4. Lokalisierung (Localization)

Die Oberfläche des Bedienfelds wird durch eine kleine Laufzeit und generierte Sprachpakete lokalisiert. Der chinesische Quelltext ist der Schlüssel (`t('源文')`), daher fallen nicht übersetzte Zeichenketten auf den chinesischen Quelltext zurück, statt zu verschwinden.

> `i18n/`, `tools/i18n/` und `tests/` existieren nur im Maintainer-Repository und sind nicht im öffentlichen Baum; der öffentliche Baum enthält nur die generierten Sprachpakete unter `client/shared/i18n/locales/`. Die folgenden Befehle richten sich an Maintainer.

### Sprachauswahl

- Globale Einstellungen → **Oberflächensprache** (`globalUiLocale`): wird zusammen mit den anderen globalen Einstellungen unter `uiLocale` gespeichert und nach `localStorage['ae_ui_locale']` gespiegelt; Letzteres ist die beim Start gelesene Quelle.
- Auswahlwerte: **Sprache der After Effects-Oberfläche übernehmen** (`auto`), 简体中文 (`zh-CN`), English (`en-US`), 日本語 (`ja-JP`), Deutsch (`de-DE`), 한국어 (`ko-KR`), Français (`fr-FR`), Русский (`ru-RU`).
- `auto` wird über `getHostEnvironment().appLocale` von CEP aufgelöst, bei fehlendem Wert fällt es auf `navigator.language` zurück. Bekannte, aber nicht unterstützte Hostsprachen werden als `en-US` aufgelöst; ist nichts lesbar, bleibt `zh-CN`.
- Das Speichern eines anderen Werts lädt das Bedienfeld neu (die Einstellungszeile weist darauf hin); weitere Schritte sind nicht nötig.

### Dateien

| Pfad | Funktion |
| --- | --- |
| `i18n/keys.json` | Alle zur Laufzeit abgefragten Schlüssel (Zeichenkettenliterale aus `AEI18n.t(...)` / `AEI18n.html(...)` plus Texte aus `client/index.html`), erzeugt von `scan-keys.js` |
| `i18n/translations/en-US.json` | Übersetzungen für `en-US` (Quelltext → Übersetzung) |
| `client/shared/i18n/locales/en-US.js` | Generiertes Sprachpaket, statisch geladen |
| `client/scripts.manifest.js` | Ladereihenfolge: Das Sprachpaket steht an erster Stelle der i18n-Gruppe und übergibt das Wörterbuch über `AEI18nPending` an `i18nCore` |
| `client/shared/i18n/i18nCore.js` | Laufzeit: `t` / `html` / `err`, Sprachauflösung, statische DOM-Übersetzung |
| `client/shared/i18n/i18nHtml.js` | Sammelt und übersetzt Textknoten und Allowlist-Attribute in HTML-Vorlagen |
| `client/shared/i18n/errorCodes.js` | Meldungstabelle für Fehlercodes |

`i18n/` und `tools/i18n/` werden nur auf der Entwicklungsseite verwendet und sind nicht im öffentlichen Baum; der öffentliche Baum enthält nur die generierten Sprachpakete unter `client/shared/i18n/locales/`.

### Befehle

```bash
node tools/i18n/scan-keys.js                 # Quellcodebaum neu durchsuchen → i18n/keys.json
node tools/i18n/build-locale.js en-US        # Übersetzungen prüfen → client/shared/i18n/locales/en-US.js
node tools/i18n/check-coverage.js en-US      # Gate: alle Schlüssel vorhanden, keine überzähligen (bei Abweichung Exit-Code 1)
```

`build-locale.js` schreibt keine Datei und endet mit Exit-Code 1, wenn eine Übersetzung leer ist, die Menge der `{placeholder}` nicht zum Quelltext passt oder ein Schlüssel nicht in `keys.json` steht. Nach Änderungen an Oberflächentexten im Maintainer-Repository die drei Befehle in der genannten Reihenfolge ausführen und danach `npm test` und `npm run lint` laufen lassen.

### Unterstützte Sprachen

`zh-CN` (Quelltext), `en-US`, `ja-JP`, `de-DE`, `ko-KR`, `fr-FR`, `ru-RU`. Die Laufzeit akzeptiert alle sieben IDs; die Sprachauswahl des Bedienfelds listet stets sieben Einträge, unabhängig von den tatsächlich mitgelieferten Sprachpaketen. `en-US`, `ja-JP`, `de-DE`, `ko-KR`, `fr-FR` und `ru-RU` sind vollständig (je 3450 Schlüssel, Abdeckung 100 %).

### Umfang und Grenzen

- **Zeile mit Umgebungsfakten (`ENV_LINE`, erzeugt von `envLine()` in `client/modules/agent/engine/prompts.js`)**: Der System-Prompt nennt die Oberflächensprache des Hosts AE (`中文版` / `英文版` / `日文版` / `德文版` / `韩文版` / `法文版` / `俄文版`); der Wert stammt aus `getHostEnvironment().appLocale`, die einzige Quelle liegt in `client/modules/agent/engine/prompts.js`. Die Zeile beschreibt eine Tatsache des Hosts und ist unabhängig von der Oberflächensprache des Bedienfelds und von der Sprache der Modellantworten.
- **ExtendScript-Meldungen**: Fehler aus `host/*.jsx` bleiben auf Chinesisch. Sie werden über `CSInterface.evalScript()` als reine Zeichenketten übergeben und nehmen an der Sprachaushandlung nicht teil; daher erscheinen diese Meldungen auch bei englischer Oberfläche auf Chinesisch. Nur die Fehlercode-Zuordnung auf der Bedienfeldseite ist lokalisiert.
- **Diagnosen des AST-Gates**: `error.reason` / `error.alternative` in `client/modules/ast-gate/` bleiben auf Chinesisch – sie sind die Selbstkorrektur-Eingabe (`llmText`), die an das LLM zurückgeht. In anderen Sprachen als dem Quelltext zeigt die Oberfläche des Bedienfelds (Statusleiste, Laufzeit-Fehlerkarte, Schnellleiste) die lokalisierten Kategoriesätze aus `client/shared/i18n/gateReasons.js`; die chinesischen Originaldetails erscheinen nur, wenn die Oberflächensprache vereinfachtes Chinesisch ist.
- **Installationsskripte**: `tools/install.bat`, `tools/check-env.bat` und `tools/deploy.bat` geben nur ASCII-Englisch aus (die Skripte wechseln auf `chcp 437`). Skriptkommentare dürfen auf Chinesisch verfasst sein; der öffentliche Baum behält technische Kommentare, erzählende Kommentare werden über eine Zuordnung für die Veröffentlichung umgeschrieben oder entfernt.
- **Oberfläche der nativen Komponenten**: Die für Benutzer sichtbaren Texte von `native/hotbox` (AS_Hotbox) und `native/glsl-host` (AS_Effect Host) – Filter und Einstellungen der Hotbox, Namen der Effektparameter, About, Fehleranzeige und Dateidialoge – folgen der **Oberflächensprache des Hosts AE** (`PF_AppGetLanguage`) und sind unabhängig von der im Bedienfeld eingestellten Oberflächensprache; bei einer nicht unterstützten Host-Sprache erfolgt ein Rückfall auf Englisch, bei nicht lesbarer Host-Sprache ein Rückfall auf Chinesisch. Protokolle und interne Diagnosen werden nicht übersetzt; Warnungen mit technischen Tokens (z. B. `[uniform limit reached]`) bleiben auf Englisch, alle übrigen Warnungen für Benutzer sind bereits lokalisiert.

## 5. Kompilieren der nativen Komponenten

Beide nativen Komponenten sind C++- / CMake-Projekte und **erfordern Visual Studio 2022 (mit MSVC) sowie das Adobe After Effects SDK** – das SDK wird laut seiner Lizenz nicht mit dem Repository verteilt und muss selbst von Adobe bezogen werden.

### 5.1 GLSL-Effekt-Host (`native/glsl-host/`)

```powershell
cmake -S native/glsl-host -B native/glsl-host/build -DAEFX_SDK_PATH="<AE-SDK-Pfad>"
cmake --build native/glsl-host/build --config Release
```

### 5.2 AE Hotbox (`native/hotbox/`)

```powershell
cmake -S native/hotbox -B native/hotbox/build -DAEFX_SDK_PATH="<AE-SDK-Pfad>"
cmake --build native/hotbox/build --config Release
```

Die Artefakte landen standardmäßig in `deploy/Plug-ins/` (überschreibbar mit `-DAE_PLUGIN_OUTPUT=<Verzeichnis>`). Die `.aex`-Datei in das Verzeichnis `Support Files\Plug-ins\` von AE kopieren und **AE vollständig beenden und neu starten**, danach wirkt es. Die Unit-Tests der nativen Logik laufen mit `ctest` im Build-Verzeichnis und benötigen AE nicht.

## 6. Entwicklungsmaterial zur Hotbox

> Dieser Abschnitt beschreibt Build / Deployment / Fehlersuche der Hotbox; die Benutzung steht in der README im Abschnitt „Native Komponenten → AE Hotbox“.

#### .aex bauen

Voraussetzungen: AE 2023+ SDK, Visual Studio 2022, CMake 3.20+.

```powershell
# Im Wurzelverzeichnis des Repositories
cmake -S native/hotbox -B native/hotbox/build `
  -DAEFX_SDK_PATH="<AE-SDK-Pfad>" `
  -DAE_PLUGIN_OUTPUT="<Repository>\deploy\Plug-ins"
cmake --build native/hotbox/build --config Release
```

Artefakt: `deploy\Plug-ins\AS_Hotbox.aex`.

#### In AE bereitstellen

1. **AE vollständig beenden** (ein neues Plug-in wird erst nach einem Neustart geladen).
2. `AS_Hotbox.aex` in das Verzeichnis `Support Files\Plug-ins\` von AE kopieren:

```powershell
Copy-Item "<Repository>\deploy\Plug-ins\AS_Hotbox.aex" `
  "<AE-Installationsverzeichnis>\Support Files\Plug-ins\" -Force
```

3. Zugleich sicherstellen, dass die CEP-Erweiterung bereitgestellt ist (`tools\deploy.bat` oder `tools\install.bat`): Die Hotbox liest die Skript- und Vorgabenindizes im Datenordner der Erweiterung und liest die Vorgabenverzeichnisse von AE direkt (Ermittlungsregeln siehe unten unter „Datenquellen“).
4. AE starten.

#### Laden prüfen

Nach dem Start von AE das Protokoll `<Datenordner>\temp\logs\as_hotbox.log` prüfen; es sollte enthalten:

```
EntryPointFunc OK
window: init ok
hotkey: registered Alt+Q
```

Ist die Tastenkombination belegt, erscheint im Protokoll `hotkey: configured ... in use, fallback default` und es wird auf `Alt+Q` zurückgefallen; ist auch `Alt+Q` belegt, erscheint `hotkey: default Alt+Q also failed`: Das Plug-in lädt weiterhin, die Tastenkombination ist jedoch nicht verfügbar (im Einstellungsbedienfeld ändern).

---


#### Konfigurationsdatei

Die Konfiguration liegt in `<Datenordner>\hotbox\config.json`:

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

- `slots`: entspricht genau den 6 Bogensegmenten des Gestenrings (`null` = dynamischer Platz). Oben (Screenshot-Eingang) und unten (Einstellungs-Eingang) sind fest reservierte Segmente und nehmen an der Platzbindung nicht teil; die 4 Zeilen im Einstellungsbedienfeld entsprechen den übrigen 4 Segmenten (oben links / unten links / oben rechts / unten rechts); die Zuordnung von Bogensegment zu Array-Index ist mit dem Layout festgelegt.
- `hotkey.mods`: Bitflags, 1=Alt 2=Ctrl 4=Shift (wie `MOD_*` in Win32).
- `hotkey.vk`: virtueller Tastencode (z. B. 81 = 'Q').
- `releaseExecute`: ob beim Loslassen der Tastenkombination das gewählte Bogensegment ausgeführt wird (Einstellungszeile 5, Standard true).
- `releaseStay`: ob das schwebende Fenster beim Loslassen der Tastenkombination stehen bleibt (Einstellungszeile 6, Standard false; Verwendung siehe „AE Hotbox“ in der README).

Die Liste der zuletzt verwendeten Einträge liegt in `<Datenordner>\hotbox\recent.json`.

> Der **Datenordner** ist standardmäßig `%APPDATA%\Adobe\CEP\extensions\AS_ExtP`.

---

### Datenquellen

Die Hotbox liest lokale Dateien direkt (AEGP läuft im selben Prozess wie AE; keine Abhängigkeit von der Bridge, ein geöffnetes Erweiterungsbedienfeld ist nicht erforderlich):

| Daten | Quelle | Beschreibung |
|------|------|------|
| Effekte | native AEGP-Aufzählung (`AEGP_EffectSuite4`) | Die Tabelle der installierten Effekte im AE-Speicher, gleiche Quelle wie das Menü „Effekt“; übernommen werden Anzeigename + matchName |
| Skripte | `agent\scripts\` rekursiv | `.jsx` / `.jsxbin` |
| Vorgaben (Erweiterungsbibliothek) | `assets\presets\index.json` | vom Bedienfeld aufgenommene `.ffx` (die Dateien liegen im Bibliotheksverzeichnis); Name + Ordner + ffx-Pfad |
| Vorgaben (AE-Werksvorgaben) | `<AE>\Support Files\Presets\` rekursiv | gleiche Quelle wie das Bedienfeld „Effekte und Vorgaben“ von AE |
| Vorgaben (AE-Benutzervorgaben) | `文档\Adobe\After Effects <Version>\User Presets\` rekursiv | Ziel von „Animationsvorgabe speichern“ in AE; fehlt das Verzeichnis, wird es nicht berücksichtigt |

- **Zusammenführung der drei Vorgabenquellen**: Priorität = Erweiterungsbibliothek > AE-Benutzervorgaben > AE-Werksvorgaben; Deduplizierungsschlüssel = Name in Kleinbuchstaben + Dateigröße in Byte, also
  „gleicher Name und gleiche Größe = dieselbe Vorgabenkopie“ (beim Aufnehmen kopiert das Bedienfeld das `.ffx` Byte für Byte in die Bibliothek; Kopie und Quelle haben denselben Namen und dieselbe Größe).
  Eine Deduplizierung nur nach Namen wäre falsch: Unter den AE-Werksvorgaben gibt es tatsächlich zwei Einträge mit gleichem Namen und unterschiedlichem Inhalt (etwa „百叶窗“ mit 191231/26526 Byte,
  „放大“ mit 43417/75976 Byte); eine Deduplizierung nur nach Namen würde echte Einträge verschlucken. Einträge der AE-Seite werden nur gelesen, nicht kopiert; das Anwenden läuft über
  `layer.applyPreset(File)`, denselben Weg wie Vorgaben aus der Bibliothek (daher lassen sich auch AE-Vorgaben an Plätze des Gestenrings binden).
- **Die Größe auf Bibliotheksseite richtet sich nach der realen Datei**: Das `size` im Index ist eine Momentaufnahme vom Zeitpunkt der Aufnahme und wird beim Neuladen anhand der tatsächlichen Bytezahl der Datei abgeglichen;
  fehlt die Datei (oder zeigt der Pfad auf ein Verzeichnis), gilt sie als „unbekannt“ – ein veralteter Wert darf nicht dazu führen, dass ein echter Eintrag der AE-Seite mit gleichem Namen und gleicher Größe zusammengefaltet wird,
  sonst bliebe nach dem Löschen des `.ffx` in der Bibliothek nur ein Eintrag übrig, dessen Anwenden zwangsläufig scheitert, und eine nutzbare AE-Vorgabe würde von ihm verdrängt.
- **Archivierte Einträge gelangen nicht in die Hotbox**: Einträge mit `archived=true` im Index (die Dateien liegen bereits in `___archive__` und werden nach 7 Tagen physisch gelöscht)
  werden nach derselben Regel wie in der Schnellleiste des Bedienfelds ausgeschlossen, damit sie keine echten Einträge der AE-Seite mit gleichem Namen verdrängen.
- **Ermittlung der AE-Vorgabenverzeichnisse**: vorzugsweise aus dem Modulpfad des Plug-ins selbst abgeleitet (`<AE>\Support Files\Plug-ins\...` → Installationsstamm),
  bei einer Installation an nicht standardmäßigen Orten wie MediaCore wird ersatzweise `app.path` von AE abgefragt (dieselbe Quelle wie
  `getInstallPath` der Erweiterung `ae-tools`). Ist beides nicht verfügbar, wird nur die Erweiterungsbibliothek verwendet; die übrigen Funktionen sind nicht betroffen.
- Die Effektliste wird im AE-Prozess aufgezählt (nicht über ExtendScript, ohne einen Index auf dem Datenträger zu lesen): Neu installierte Plug-ins sind ohne Erzeugen eines Caches durchsuchbar.
- `ae-tools\effects_cache.json` ist nicht mehr die Hauptquelle der Effektliste und dient nur als Rückfall, wenn die native Aufzählung leer bleibt (AEGP nicht bereit).
- Aktualisierungsregel: Bleibt die Signatur der Datenquellen (Zahl der installierten Effekte + `mtime` von `index.json` + Verzeichnisbaum der Skripte + Verzeichnisbäume der beiden AE-Vorgabenverzeichnisse) unverändert,
  werden bei wiederholtem Aufrufen die Liste und der Pinyin-Index aus dem Speicher wiederverwendet; Hinzufügen, Löschen und Ändern von Skripten / Vorgaben sowie das Speichern einer Vorgabe in das Benutzervorgabenverzeichnis aus AE heraus
  führen zu einer abweichenden Signatur und lösen ein automatisches Neuladen aus (ohne AE-Neustart). Die Signaturdurchläufe erfolgen bei jedem Öffnen, der vollständige Scan der Werksverzeichnisse nur bei abweichender Signatur;
  beide Kosten sind linear zur Zahl der Vorgaben- / Skripteinträge und summieren sich nicht mit der Zahl der Aufrufe.
- Nach dem Laden des Plug-ins werden die Daten bei der ersten Untätigkeit (≥ 2 s) einmal vorgewärmt (Aufzählung + Pinyin-Index), damit die Kosten des ersten Ladens nicht im Tastenpfad liegen.

#### Zeichenkodierung

- Pfade und Namen im Projekt sind durchgehend UTF-8-Narrow-Strings; Dateien werden ausschließlich über Wide-Character-APIs geöffnet (`utf8ToWide` in `native/hotbox/src/data.h` und die Aufrufe mit breiten Pfaden in `log.h`) – schmale `char*`-Pfade interpretiert das System als ANSI/GBK, Pfade mit chinesischen Zeichen lassen sich dann nicht öffnen.
- `A_char`-Zeichenketten von AEGP (Effektname / Kategorie) sind laut SDK-Konvention System-ANSI; an einer einzelnen Zeichenkette lässt sich die Kodierung nicht bestimmen, daher wird bei Stapeldaten zuerst der ganze Stapel als ANSI / UTF-8 bestimmt und dann dekodiert (`isAnsiBatch` / `ansiToUtf8` in `data.h`). Neue Datenquellen müssen derselben Regel folgen; `A_char` nicht direkt als UTF-8 behandeln und nicht direkt zu Pfaden zusammensetzen.

---

### Fehlersuche

#### Protokollspeicherort

`<Datenordner>\temp\logs\as_hotbox.log` – protokolliert das Laden des Plug-ins, die Registrierung der Tastenkombination, Ausführungsergebnisse und Fehlermeldungen. Der Datenordner ist standardmäßig `%APPDATA%\Adobe\CEP\extensions\AS_ExtP` (siehe Abschnitt „Konfigurationsdatei“); wird der Datenordner geändert, wandert das Protokoll mit.

#### Häufige Probleme

| Symptom | Prüfung |
|------|------|
| Keine Reaktion auf die Tastenkombination | Protokoll prüfen: ob `hotkey: registered ...` erfolgreich war; ob AE im Vordergrund ist (im Hintergrund wird nicht ausgelöst) |
| Tastenkombination belegt | Im Protokoll erscheint `hotkey: configured ... in use, fallback default` (Rückfall auf die Standardkombination) oder `hotkey: default Alt+Q also failed`; im Einstellungsbedienfeld eine neue Kombination aufnehmen. Reagiert das Drücken beim Aufnehmen **überhaupt nicht**, ist die Kombination von einem anderen Programm belegt (systemweite Exklusivität, die Taste kommt nicht an): Kombination wechseln oder das belegende Programm beenden |
| Das schwebende Fenster zeigt `扩展未启动` | Die CEP-Erweiterung ist nicht bereitgestellt; `tools\deploy.bat` ausführen oder das AS_ExtP-Bedienfeld in AE öffnen |
| Keine Suchergebnisse | Wurde ein Suchbegriff eingegeben (eine leere Abfrage listet keine Einträge); liegen Skripte in `agent\scripts\`; existiert `assets\presets\index.json` |
| Anwenden eines Effekts schlägt fehl | Ist eine Ebene ausgewählt; ist eine Komposition geöffnet |
| Das schwebende Fenster schließt nach dem Loslassen der Tastenkombination nicht | „`松手停留` (Loslassen bleibt)“ im Einstellungsbedienfeld ist an (`releaseStay` in config.json); mit Esc / Klick außerhalb des Fensters / erneutem Drücken der Tastenkombination schließen oder die Einstellung ausschalten |
| Absturz beim Beenden von AE | Im Protokoll prüfen, ob `DeathHook` erscheint; die Ereignisanzeige prüfen |
| Fehlerhafte Positionierung bei mehreren Monitoren | Das Fenster wird auf den Arbeitsbereich des Monitors unter dem Mauszeiger begrenzt (clamp); auf einem zweiten Monitor sollte es diesen nicht verlassen |
| Probleme bei der chinesischen Eingabe | Das Suchfeld nutzt ein Win32-EDIT-Steuerelement, IME-Vorschläge und Kandidaten sind verfügbar; Enter während einer laufenden IME-Komposition löst nicht vorzeitig aus |

#### Ablauf der erneuten Bereitstellung

Nach Änderungen am C++-Code:

```powershell
# 1. AE beenden
# 2. Neu bauen
cmake --build native/hotbox/build --config Release
# 3. .aex nach AE kopieren (überschreiben)
Copy-Item "deploy\Plug-ins\AS_Hotbox.aex" "<AE-Installationsverzeichnis>\Support Files\Plug-ins\" -Force
# 4. AE starten (vollständiger Neustart nötig; im Task-Manager prüfen, dass AfterFX.exe beendet ist)
```

Nach Änderungen an ExtendScript (`host/api/effectApi.jsx` und andere):

```powershell
# deploy.bat ausführen, um die host-Dateien im CEP-Erweiterungsverzeichnis zu aktualisieren
tools\deploy.bat
# Kein Neustart in AE nötig; das neue Skript wird beim nächsten Aufruf geladen
```

---

### Technische Architektur

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ native/hotbox/  AEGP-Plug-in (C++20 + MSVC, GeneralPlug)                                     │
│  ├─ Hotkey-Engine   RegisterHotKey + verstecktes Nachrichtenfenster ← WM_HOTKEY              │
│  │              → GetCursorPos liefert die Mausposition                                      │
│  ├─ Schwebefenster  WS_POPUP + WS_EX_TOPMOST + Transparenz als Layered Window                │
│  │              ├─ Gestenmodus: Mittelkreis + Ring aus Bogensegmenten (Direct2D)             │
│  │              └─ Suchmodus: breite Suchleiste + lineare Liste + Typfilter                  │
│  ├─ Ausführungskanal   AEGP_UtilitySuite6::AEGP_ExecuteScript                                │
│  │              → effectApi.jsx / scriptRunner.jsx                                           │
│  └─ Datenschicht     Dateien prozessintern direkt lesen (std::ifstream + GetFileAttributesW) │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Zentrale Einschränkungen:
- Der Ausführungskanal `AEGP_ExecuteScript` blockiert den AE-Hauptthread synchron → daher vor allem kurze Skripte; während der Ausführung erscheint ein Statushinweis.
- Daten werden ohne Bridge gelesen und geschrieben: Das Plug-in liest die Konfigurationsdateien und Skriptindizes im Datenordner direkt im Prozess; die Bridge dient nur der Bedienfeldseite.
- Die Skriptausführung läuft ausschließlich über die Sandbox-Verpackung (`runScriptSandboxed`); einen Schalter zum Umgehen gibt es nicht.
