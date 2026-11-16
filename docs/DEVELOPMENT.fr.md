# Documentation développeur AS_ExtP

[简体中文](DEVELOPMENT.md) | [English](DEVELOPMENT.en.md) | [日本語](DEVELOPMENT.ja.md) | [Deutsch](DEVELOPMENT.de.md) | [한국어](DEVELOPMENT.ko.md) | **Français** | [Русский](DEVELOPMENT.ru.md)

Destiné à ceux qui veulent lire le code source, modifier le code ou compiler eux-mêmes les composants natifs. Installation et utilisation : voir [README.md](../README.md).

Ce document s’adresse au développement secondaire : il couvre successivement l’architecture technique, la préparation et la vérification de l’environnement, le déploiement, la localisation (Localization), la compilation des composants natifs et les ressources de développement du Hotbox.

Les licences des composants tiers, l’origine des ressources et les conditions de distribution figurent dans [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) (distribué avec l’arborescence source et le paquet Release complet) ; la licence MIT de ce projet figure dans [LICENSE](../LICENSE).

## 1. Architecture technique

AS_ExtP repose sur une architecture **panneau CEP (CEF / Chrome 88) + Bridge Node local** :

```
Panneau CEP (CEF, file://)
  │  8 modules fonctionnels + features (barre d’accès rapide / mascotte / indicateur d’autorisation d’accès externe)
  │  Couche partagée / de base : AEFS · Bridge · ToolRegistry · portail AST (PromptBuilder dans client/llm/, ContextManager dans client/modules/agent/engine/, contexte de conteneur dans client/core/)
  ├── CSInterface.evalScript()  ──►  moteur AE (host.jsx + host/api/*.jsx) exécute ExtendScript
  ├── Bridge Node (127.0.0.1:9877, HTTP + WebSocket)
  │     ├─ système de fichiers (lecture et écriture complètes, canal binaire inclus)
  │     ├─ gestion des processus MCP externes
  │     └─ point d’accès /mcp (transport Streamable HTTP du mode externe)
  └── mode externe : Agent externe ⇄ stdio / HTTP ⇄ relay du Bridge ⇄ panneau ⇄ AE
```

- **Système de fichiers (AEFS)** : `client/shared/aefs.js` fournit une lecture-écriture de fichiers unifiée, avec un repli multiniveau **Bridge → cep.fs → ExtendScript** et plusieurs contrôles de sécurité sur les chemins (refus de `%`, des caractères de contrôle, de la remontée `..`, des chemins non absolus et des noms de périphériques DOS ; les opérations d’écriture et de suppression sont limitées à la liste blanche des dossiers sûrs).
- **Portail de compilation AST** : tout script généré par l’IA ou enregistré par l’utilisateur passe d’abord, avant exécution, par un portail de compilation statique unifié — prétraitement du dialecte ExtendScript → analyse acorn (ES3) → validation des types et de la liste blanche des membres → réémission puis exécution. La validation et l’exécution portent sur le même code : aucune fenêtre temporelle de « réécriture après validation » n’existe. Les quatre points d’entrée (appel d’outil par l’Agent, zone d’aperçu, définition d’outil JSON, arborescence des scripts / barre d’accès rapide) y convergent tous ; les formes à haut risque sont interceptées côté portail et renvoyées au modèle pour réécriture ; « Paramètres du module Agent → Capacités du portail AST » permet de consulter la confiance par canal, les interrupteurs de domaine de capacité et la table des ajouts à la liste blanche. L’arborescence des scripts / la barre d’accès rapide (`user-library`) suivent le mode audit : le portail ne produit qu’une liste de dangers, sans réécrire le code (voir `client/modules/ast-gate/run.js`).
- **Dossier de données** : le dossier racine de l’extension est en lecture seule ; les données d’exécution sont stockées dans `%APPDATA%\Adobe\CEP\extensions\AS_ExtP` (scripts, compétences, mémoire, outils, effets, préréglages, etc.). Les paramètres globaux permettent de le déplacer vers un emplacement personnalisé : le changement équivaut à une **copie intégrale** (si la cible contient déjà des données, une confirmation d’écrasement s’affiche d’abord ; après confirmation, les données de la cible sont supprimées avant la copie) ; en fin d’opération, les chemins absolus commençant par l’ancienne racine dans l’**index des bibliothèques** copié (`assets/<bibliothèque>/*.json`) sont **réécrits avec la nouvelle racine** — sinon, au démarrage depuis le nouveau dossier, l’analyse du disque considérera les fichiers de même nom comme « non enregistrés » et les réimportera en doublon (des cas de doublons existent pour les préréglages et les actifs de projet) ; l’ancien dossier n’est pas supprimé automatiquement, l’utilisateur doit le vérifier puis le nettoyer lui-même. **Lors de l’ajout d’une bibliothèque** : ne stockez pas de chemin absolu vers un fichier de la bibliothèque dans l’index (stockez un chemin relatif, ou calculez-le à l’exécution depuis le dossier de données) ; s’il faut vraiment un chemin absolu, la fin de la migration doit effectuer la même réécriture (voir `rebaseLibraryIndexPaths` dans `client/shared/dataDir.js`).
- **Bus d’invites** : l’invite finale remise au LLM est assemblée en quatre couches (squelette System Prompt → pipeline PromptBuilder → injection de l’historique des messages → habillage du User Prompt) ; les modules y participent via les points d’injection standard, sans concaténer de chaînes directement.
- **Bridge Node** : assure les opérations de fichiers et la gestion des processus MCP ; il s’arrête automatiquement en cas d’inactivité et reste maintenu en vie par un battement tant que le panneau est ouvert. Le point d’accès HTTP du mode externe et l’entrée stdio partagent le même cœur de protocole ; les appels d’outils passent uniformément par le panneau en exécution séquentielle (le moteur de scripts d’AE est mono-thread).
- **Journaux de diagnostic** : les journaux des processus panneau / Bridge / hôte / composants natifs partagent l’horodatage ISO et une taille maximale par fichier (les lignes d’erreur du Bridge portent en plus la marque `[ERR]`) ; l’export du paquet de diagnostic applique un masquage uniforme et replie les lignes répétées par signature (au-delà d’un seuil, seule la première ligne d’une même signature est conservée, avec le nombre total et l’intervalle de temps) ; l’export se fait depuis les paramètres globaux.

### Liste des exceptions AEFS

Les entrées-sorties de fichiers du panneau (CEP) passent toujours par AEFS ; après un examen complet du dépôt, les exceptions se concentrent du côté host / ExtendScript, soit **sept points d’appel de suppression de fichiers en deux catégories** (aucune exception dans le JS du panneau) :

1. **Auto-nettoyage de la chaîne de démarrage (5 points, structurellement impossibles à faire passer par AEFS)** : `_sweepHandoffLeftovers` de `host/host.jsx` (nettoie les jetons de transfert orphelins, les scripts vbs et les scripts de détection multi-instance `.axd`), la suppression de `vbsFile` en fin de `startBridge`, la suppression par `_runAxDetectionProbe` du script de détection `.axd` écrit lors de cet appel, la suppression par `_clearMultiInstanceMarker` de `ae_extp_multi_instance.json`, et la suppression par `_writeHostLoadErrors` du fichier de poignée de main en l’absence d’échec — AEFS est un module du panneau et son interface de suppression dépend du Bridge / de CEP, or ces appels s’exécutent précisément lorsque « il n’y a pas encore de Bridge » ou dans la phase finale de l’autotest de démarrage. Chemin = `temp/handoff` du dossier de données (repli sur le dossier temporaire système) ; les fichiers supprimés sont tous produits par la chaîne de démarrage (jetons de transfert / vbs / scripts de détection `.axd`, marqueur multi-instance, rapport d’erreurs de chargement précédent) ; garde-fous = expression régulière sur le nom de fichier exact, suppression de fichiers uniquement (les dossiers de même nom sont ignorés), et les éléments du balayage ne récupèrent que les résidus dont le `mtime` dépasse 10 minutes.
2. **« Nettoyer puis copier » du flux d’export (2 points, qu’il n’est pas judicieux de faire passer par AEFS pour des raisons de séquencement)** : une occurrence dans `exportWholeProject` et une dans `exportCompOrLayer` de `host/api/projectAssetApi.jsx`, qui suppriment l’ancienne copie contenue dans le paquet avant de recopier un footage de même nom. Le point de suppression se situe au milieu du flux côté ES (avant la copie) ; le confier au panneau introduirait une « course entre le nettoyage et l’export » ; la suppression reste donc côté host, mais elle est précédée d’un `_ensureUnderRoot(dstPath, footageDir.fsName)` qui reproduit `_checkPath` et la vérification de conteneur d’AEFS (refus de `%`, des caractères de contrôle, des guillemets, des noms de périphériques DOS et des segments `..` ; le chemin doit être un sous-chemin de footageDir) ; en cas de dépassement, seule une entrée de journal est écrite, sans suppression.

## 2. Préparation et vérification de l’environnement

> **Les deux méthodes d’obtention n’ont pas les mêmes prérequis** : le **paquet Release complet est prêt à l’emploi** (runtime Node, dépendances npm et `.aex` précompilés déjà inclus) ; décompressez-le et double-cliquez sur `tools\install.bat` pour terminer le déploiement, cette section peut alors être ignorée ; un **clone du code source n’est pas prêt à l’emploi** : il exige Node, `npm ci` et `check-env.bat` (téléchargement de Node / ffmpeg) décrits ci-dessous, ainsi que la compilation des composants natifs si nécessaire.

- Node.js **≥ 20.18** (le CEF du panneau est Chrome 88, sans runtime Node : `require` / `process` n’existent pas dans le panneau, et les entrées-sorties de fichiers passent toujours par AEFS)
- Installer les dépendances : `npm ci` ; ou double-cliquez sur `tools\check-env.bat` (vérifie un par un Node, les dépendances, ffmpeg et la version d’AE, avec des indications pour combler les manques)
- `npm run lint` — vérification ESLint (`eslint.config.js`)
- `npm run audit:theme` / `npm run audit:family` — audit des couleurs de thème codées en dur et des familles de modes de défaillance éteintes (garde-fou de CI)
- La CI du dépôt public (`.github/workflows/ci.yml`) comporte deux travaux : `lint-and-audits` exécute `npm ci` → `lint` → les deux audits ; `release-tree-check` exécute `node tools/release-check.js --public . --public-only` sur une copie de travail propre sans dépendances installées (arborescence publique sans aucun binaire, sans `node_modules` / `vendor`, NOTICES complet). Tout échec à une étape fait échouer la CI

## 3. Déploiement dans CEP

Les deux scripts n’ont pas le même rôle :

- **Première installation / utilisateurs** : double-cliquez sur `tools\install.bat`. Il détecte automatiquement les AE installés, télécharge Node et ffmpeg, écrit `PlayerDebugMode` et déploie automatiquement les composants natifs lorsqu’il détecte `deploy\Plug-ins\*.aex`.
- **Mise à jour de déploiement en cours de développement** : après modification de `host` / `client` / `CSXS` ou des composants natifs, double-cliquez sur `tools\deploy.bat` (droits d’administrateur requis ; il copie ces éléments dans `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\AS_ExtP`). Il ne télécharge rien et ne touche pas au registre ; il exige que `vendor\` existe et, à défaut, invite à lancer `tools\check-env.bat` d’abord.

Les deux scripts complètent `vendor\node_modules` par copie depuis le `node_modules` racine du dossier source lorsqu’il manque — une fois déployé, le Bridge résout ses dépendances depuis `vendor\node_modules` (analyse des pièces jointes docx / xlsx / pdf).

## 4. Localisation (Localization)

L’interface du panneau est localisée par un petit runtime et des paquets de langue générés. Le texte source chinois sert de clé (`t('源文')`), si bien qu’une chaîne non traduite revient au texte source chinois au lieu de disparaître.

> `i18n/`, `tools/i18n/` et `tests/` n’existent que dans le dépôt des mainteneurs et n’entrent pas dans l’arborescence publique ; celle-ci ne contient que les paquets de langue générés sous `client/shared/i18n/locales/`. Les commandes ci-dessous s’adressent aux mainteneurs.

### Choix de la langue

- Paramètres globaux → **Langue de l’interface** (`globalUiLocale`) : stockée avec les autres paramètres globaux sous `uiLocale` et répliquée dans `localStorage['ae_ui_locale']`, cette dernière étant la source de la valeur au démarrage.
- Valeurs possibles : **Suivre la langue de l’interface d’After Effects** (`auto`), 简体中文 (`zh-CN`), English (`en-US`), 日本語 (`ja-JP`), Deutsch (`de-DE`), 한국어 (`ko-KR`), Français (`fr-FR`), Русский (`ru-RU`).
- `auto` est résolu par `getHostEnvironment().appLocale` de CEP, avec repli sur `navigator.language` si la valeur est indisponible. Une langue d’hôte connue mais non prise en charge est résolue en `en-US` ; si la lecture échoue, `zh-CN` est conservé.
- Enregistrer une autre valeur recharge le panneau (la ligne de réglage le précise) ; aucune autre étape n’est nécessaire.

### Fichiers

| Chemin | Rôle |
| --- | --- |
| `i18n/keys.json` | toutes les clés interrogées à l’exécution (littéraux de chaîne de `AEI18n.t(...)` / `AEI18n.html(...)`, plus le texte de `client/index.html`), générées par `scan-keys.js` |
| `i18n/translations/en-US.json` | traductions de `en-US` (texte source → traduction) |
| `client/shared/i18n/locales/en-US.js` | paquet de langue généré, chargé statiquement |
| `client/scripts.manifest.js` | ordre de chargement : le paquet de langue est placé en tête du groupe i18n et transmet le dictionnaire à `i18nCore` via `AEI18nPending` |
| `client/shared/i18n/i18nCore.js` | runtime : `t` / `html` / `err`, résolution de la langue, traduction statique du DOM |
| `client/shared/i18n/i18nHtml.js` | collecte et traduit les nœuds de texte et les attributs autorisés des modèles HTML |
| `client/shared/i18n/errorCodes.js` | table des messages d’erreur |

`i18n/` et `tools/i18n/` ne servent que côté développement et n’entrent pas dans l’arborescence publique ; celle-ci ne contient que les paquets de langue générés sous `client/shared/i18n/locales/`.

### Commandes

```bash
node tools/i18n/scan-keys.js                 # réanalyser l’arborescence source → i18n/keys.json
node tools/i18n/build-locale.js en-US        # valider les traductions → client/shared/i18n/locales/en-US.js
node tools/i18n/check-coverage.js en-US      # garde-fou : toutes les clés présentes, aucune superflue (code de sortie 1 en cas d’écart)
```

`build-locale.js` n’écrit aucun fichier et se termine avec le code de sortie 1 lorsque la traduction est vide, lorsque l’ensemble des `{placeholder}` diffère de celui du texte source, ou lorsqu’une clé n’est pas dans `keys.json`. Après modification d’un texte d’interface, exécutez dans le dépôt des mainteneurs les trois commandes ci-dessus dans cet ordre, puis `npm test` et `npm run lint`.

### Langues prises en charge

`zh-CN` (texte source), `en-US`, `ja-JP`, `de-DE`, `ko-KR`, `fr-FR`, `ru-RU`. Le runtime accepte les sept identifiants ; le sélecteur de langue du panneau liste toujours sept entrées, indépendamment des paquets de langue effectivement distribués. `en-US`, `ja-JP`, `de-DE`, `ko-KR`, `fr-FR` et `ru-RU` sont complets (3450 clés chacun, couverture de 100 %).

### Portée et limites

- **Ligne de faits sur l’environnement d’exécution (`ENV_LINE`, générée par `envLine()` de `client/modules/agent/engine/prompts.js`)** : l’invite système indique la langue de l’interface de l’AE hôte (`中文版` / `英文版` / `日文版` / `德文版` / `韩文版` / `法文版` / `俄文版`), valeur issue de `getHostEnvironment().appLocale` ; la source unique est `client/modules/agent/engine/prompts.js`. Elle décrit un fait de l’hôte, sans rapport avec la langue de l’interface du panneau ni avec la langue de réponse du modèle.
- **Messages ExtendScript** : les erreurs levées par `host/*.jsx` restent en chinois. Elles transitent par `CSInterface.evalScript()` sous forme de chaînes brutes et ne participent pas à la négociation de langue : même avec une interface en anglais, ces messages s’affichent donc en chinois ; seule la correspondance des codes d’erreur côté panneau est localisée.
- **Diagnostics du portail AST** : `error.reason` / `error.alternative` de `client/modules/ast-gate/` restent en chinois — ce sont des entrées d’autocorrection renvoyées au LLM (`llmText`). Dans une langue autre que celle du texte source, la surface du panneau (barre d’état, carte d’erreur d’exécution, barre d’accès rapide) affiche la phrase de catégorie localisée de `client/shared/i18n/gateReasons.js` ; le détail original en chinois n’apparaît que si la langue de l’interface est le chinois simplifié.
- **Scripts d’installation** : `tools/install.bat`, `tools/check-env.bat` et `tools/deploy.bat` n’émettent que de l’anglais ASCII (les scripts passent en `chcp 437`). Les commentaires des scripts peuvent être en chinois ; l’arborescence publique conserve les commentaires techniques, les commentaires narratifs étant réécrits ou supprimés via la table de correspondance des commentaires de publication.
- **Interface des composants natifs** : les textes visibles par l’utilisateur de `native/hotbox` (AS_Hotbox) et de `native/glsl-host` (AS_Effect Host) — filtres et réglages de la Hotbox, noms des paramètres d’effet, À propos, fenêtres d’erreur, boîtes de dialogue de fichiers — suivent la **langue de l’interface de l’After Effects hôte** (`PF_AppGetLanguage`) et sont indépendants de la langue d’interface du panneau ; une langue hôte non prise en charge retombe sur l’anglais, une langue hôte illisible retombe sur le chinois. Les journaux et les diagnostics internes ne sont pas traduits ; les avertissements contenant un jeton technique (par exemple `[uniform limit reached]`) restent en anglais ; les autres avertissements destinés à l’utilisateur sont localisés.

## 5. Compilation des composants natifs

Les deux composants natifs sont des projets C++ / CMake et **exigent Visual Studio 2022 (avec MSVC) ainsi que le SDK Adobe After Effects** — le SDK n’est pas distribué avec le dépôt en raison de sa licence et doit être obtenu auprès d’Adobe.

### 5.1 Hôte d’effets GLSL (`native/glsl-host/`)

```powershell
cmake -S native/glsl-host -B native/glsl-host/build -DAEFX_SDK_PATH="<chemin du SDK AE>"
cmake --build native/glsl-host/build --config Release
```

### 5.2 AE Hotbox (`native/hotbox/`)

```powershell
cmake -S native/hotbox -B native/hotbox/build -DAEFX_SDK_PATH="<chemin du SDK AE>"
cmake --build native/hotbox/build --config Release
```

Les produits sont écrits par défaut dans `deploy/Plug-ins/` (remplaçable par `-DAE_PLUGIN_OUTPUT=<dossier>`). Copiez le `.aex` dans le dossier `Support Files\Plug-ins\` d’AE puis **quittez complètement AE et redémarrez-le** pour qu’il prenne effet. Les tests unitaires de la logique native s’exécutent avec `ctest` dans le dossier de build, sans AE.

## 6. Ressources de développement Hotbox

> Cette section décrit la compilation / le déploiement / le dépannage du Hotbox ; pour l’usage utilisateur, voir la section « Composants natifs → AE Hotbox » du README.

#### Compiler le .aex

Prérequis : SDK AE 2023+, Visual Studio 2022, CMake 3.20+.

```powershell
# depuis la racine du dépôt
cmake -S native/hotbox -B native/hotbox/build `
  -DAEFX_SDK_PATH="<chemin du SDK AE>" `
  -DAE_PLUGIN_OUTPUT="<dépôt>\deploy\Plug-ins"
cmake --build native/hotbox/build --config Release
```

Produit : `deploy\Plug-ins\AS_Hotbox.aex`.

#### Déploiement dans AE

1. **Quittez complètement AE** (un nouveau plug-in ne se charge qu’après redémarrage).
2. Copiez `AS_Hotbox.aex` dans le dossier `Support Files\Plug-ins\` d’AE :

```powershell
Copy-Item "<dépôt>\deploy\Plug-ins\AS_Hotbox.aex" `
  "<dossier d’installation d’AE>\Support Files\Plug-ins\" -Force
```

3. Assurez-vous aussi que l’extension CEP est déployée (`tools\deploy.bat` ou `tools\install.bat`) : le Hotbox lit les scripts et l’index des préréglages du dossier de données de l’extension, et lit directement les dossiers de préréglages propres à AE (règles de localisation dans « Sources des données » ci-dessous).
4. Lancez AE.

#### Vérifier le chargement

Après le démarrage d’AE, consultez le journal `<dossier de données>\temp\logs\as_hotbox.log` ; les lignes suivantes doivent apparaître :

```
EntryPointFunc OK
window: init ok
hotkey: registered Alt+Q
```

Si le raccourci est déjà pris, le journal affiche `hotkey: configured ... in use, fallback default` et retombe sur `Alt+Q` ; si `Alt+Q` est aussi pris, le journal affiche `hotkey: default Alt+Q also failed` : le plug-in se charge quand même mais le raccourci est inutilisable (il faut le modifier dans le panneau de paramètres).

---


#### Fichier de configuration

La configuration est stockée dans `<dossier de données>\hotbox\config.json` :

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

- `slots` : correspondent un à un aux 6 segments d’arc de l’anneau gestuel (`null` = emplacement dynamique). Le segment du haut (entrée de capture) et celui du bas (entrée des paramètres) sont des segments dédiés qui ne participent pas à l’association d’emplacements ; les 4 lignes du panneau de paramètres correspondent aux 4 segments restants (haut gauche / bas gauche / haut droite / bas droite), la correspondance entre segments d’arc et indices du tableau étant fixée par la disposition.
- `hotkey.mods` : indicateurs de bits, 1=Alt 2=Ctrl 4=Shift (identiques aux `MOD_*` de Win32).
- `hotkey.vk` : code de touche virtuel (par ex. 81 = « Q »).
- `releaseExecute` : exécuter ou non le segment d’arc sélectionné au relâchement du raccourci (ligne 5 des paramètres, true par défaut).
- `releaseStay` : rester ou non dans la fenêtre flottante au relâchement du raccourci (ligne 6 des paramètres, false par défaut ; usage dans « AE Hotbox » du README).

La liste des éléments récents est stockée dans `<dossier de données>\hotbox\recent.json`.

> Le **dossier de données** est par défaut `%APPDATA%\Adobe\CEP\extensions\AS_ExtP`.

---

### Sources des données

Le Hotbox lit directement les fichiers locaux (l’AEGP tourne dans le même processus qu’AE ; il ne dépend pas du Bridge et n’exige pas que le panneau de l’extension soit ouvert) :

| Donnée | Source | Description |
|------|------|------|
| Effets | énumération native AEGP (`AEGP_EffectSuite4`) | table des effets installés en mémoire d’AE, même source que le menu Effet ; le nom affiché et le matchName sont récupérés |
| Scripts | récursif dans `agent\scripts\` | `.jsx` / `.jsxbin` |
| Préréglages (bibliothèque de l’extension) | `assets\presets\index.json` | les `.ffx` enregistrés depuis le panneau (le fichier réel se trouve dans le dossier de la bibliothèque) ; nom + dossier + chemin du ffx |
| Préréglages (usine AE) | récursif dans `<AE>\Support Files\Presets\` | même source que le panneau Effects & Presets d’AE |
| Préréglages (utilisateur AE) | récursif dans `文档\Adobe\After Effects <version>\User Presets\` | destination d’« Enregistrer l’animation prédéfinie » d’AE ; un dossier absent n’est pas pris en compte |

- **Fusion des trois sources de préréglages** : priorité = bibliothèque de l’extension > préréglages utilisateur d’AE > préréglages d’usine d’AE ; clé de dédoublonnage = nom en minuscules + nombre d’octets du fichier, soit
  « même nom et même taille = même copie de préréglage » (l’enregistrement depuis le panneau copie le `.ffx` octet par octet dans la bibliothèque : la copie a le même nom et la même taille que la source).
  Le dédoublonnage ne peut pas se faire sur le nom seul : les préréglages d’usine d’AE en contiennent réellement deux de même nom au contenu différent (par ex. « 百叶窗 » 191231 / 26526 octets,
  « 放大 » 43417 / 75976 octets) ; un dédoublonnage par nom seul supprimerait de vraies entrées. Les entrées côté AE sont lues sans être copiées, l’application passant par
  `layer.applyPreset(File)`, le même chemin que pour les préréglages de la bibliothèque (les préréglages d’AE peuvent donc aussi être associés à un emplacement de l’anneau gestuel).
- **La taille côté bibliothèque suit le fichier réel** : le `size` de l’index est un instantané pris au moment de l’enregistrement ; au rechargement, il est recalé sur le nombre d’octets réel du fichier ;
  si le fichier n’existe plus (ou si le chemin pointe vers un dossier), la valeur est traitée comme « inconnue » — une valeur périmée ne doit pas servir à replier une vraie entrée d’AE de même nom et de même taille,
  sinon, après suppression du `.ffx` dans la bibliothèque, le Hotbox ne garderait qu’une entrée dont l’application échoue forcément, et le préréglage d’AE utilisable serait évincé par celle-ci.
- **Les entrées archivées n’entrent pas dans le Hotbox** : les entrées dont l’index porte `archived=true` (le fichier réel a été déplacé dans `___archive__` et est physiquement supprimé après 7 jours)
  sont exclues selon la même règle que la barre d’accès rapide du panneau, pour éviter qu’elles ne remplacent une vraie entrée d’AE de même nom.
- **Localisation du dossier de préréglages d’AE** : elle est d’abord déduite du chemin du module du plug-in lui-même (`<AE>\Support Files\Plug-ins\...` → racine d’installation),
  une installation dans un emplacement non standard comme MediaCore ne fait que retomber sur `app.path` d’AE (même source que
  `getInstallPath` de l’extension `ae-tools`). Si aucune des deux voies n’aboutit, seule la bibliothèque de l’extension est utilisée, le reste des fonctions n’étant pas affecté.
- La liste des effets est obtenue par énumération dans le processus d’AE (sans passer par ExtendScript, sans lire d’index sur disque) : un plug-in fraîchement installé est donc trouvable sans générer le moindre cache.
- `ae-tools\effects_cache.json` n’est plus la source principale de la liste des effets ; il ne sert de repli que lorsque l’énumération native renvoie un résultat vide (AEGP non prêt).
- Règle d’actualisation : tant que la signature des sources de données (nombre d’effets installés + mtime de `index.json` + arborescence des scripts + arborescences des deux dossiers de préréglages d’AE) ne change pas,
  les ouvertures répétées réutilisent directement la liste et l’index pinyin en mémoire ; l’ajout, la suppression ou la modification de scripts / préréglages, ainsi que l’enregistrement d’un préréglage dans le dossier des préréglages utilisateur depuis AE,
  provoquent une non-concordance de la signature et un rechargement automatique (sans redémarrer AE). Le parcours de signature s’exécute à chaque apparition, alors que le balayage complet du dossier d’usine n’a lieu qu’en cas de non-concordance ;
  le coût des deux est linéaire par rapport au nombre d’entrées de préréglages / scripts et ne s’accumule pas avec le nombre d’ouvertures.
- Après le chargement du plug-in, la première période d’inactivité (≥ 2 s) préchauffe une fois les données (énumération + index pinyin), ce qui retire le coût du premier chargement du chemin de la frappe au clavier.

#### Contraintes d’encodage

- Les chemins et noms internes au projet sont uniformément des chaînes étroites UTF-8 ; l’ouverture de fichiers passe toujours par les API à caractères larges (`utf8ToWide` de `native/hotbox/src/data.h` et les appels à chemin large de `log.h`) — un chemin étroit `char*` est interprété par le système en ANSI/GBK, et un chemin contenant du chinois ne s’ouvre pas.
- Les chaînes AEGP `A_char` d’AE (nom d’effet / catégorie) sont, par convention du SDK, en ANSI système ; une chaîne isolée ne permettant pas de déterminer l’encodage, les données par lots sont d’abord qualifiées globalement en ANSI / UTF-8 puis décodées (`isAnsiBatch` / `ansiToUtf8` de `data.h`). Toute nouvelle source de données doit suivre la même règle : ne pas traiter `A_char` comme de l’UTF-8, ni concaténer directement un chemin avec.

---

### Dépannage

#### Emplacement des journaux

`<dossier de données>\temp\logs\as_hotbox.log` — consigne le chargement du plug-in, l’enregistrement du raccourci, les résultats d’exécution et les erreurs. Le dossier de données est par défaut `%APPDATA%\Adobe\CEP\extensions\AS_ExtP` (voir la section « Fichier de configuration ») ; si le dossier de données change, les journaux suivent.

#### Problèmes courants

| Symptôme | Vérification |
|------|------|
| aucune réaction à l’appui sur le raccourci | consultez le journal : `hotkey: registered ...` a-t-il réussi ? AE est-il au premier plan (hors premier plan, rien n’est déclenché) ? |
| raccourci déjà pris | le journal affiche `hotkey: configured ... in use, fallback default` (repli sur la combinaison par défaut) ou `hotkey: default Alt+Q also failed` ; enregistrez une nouvelle combinaison dans le panneau de paramètres. Si, à l’enregistrement, l’appui sur les touches **ne produit aucune réaction**, la combinaison est déjà prise par un autre programme (exclusion au niveau du système, les touches n’arrivent pas) : changez de combinaison ou quittez le programme qui l’occupe |
| la fenêtre flottante affiche `扩展未启动` | l’extension CEP n’est pas déployée ; exécutez `tools\deploy.bat` ou ouvrez le panneau AS_ExtP dans AE |
| la recherche ne renvoie rien | un mot-clé a-t-il été saisi (une requête vide ne liste aucune entrée) ? `agent\scripts\` contient-il des scripts ? `assets\presets\index.json` existe-t-il ? |
| l’application de l’effet échoue | y a-t-il un calque sélectionné ? la composition est-elle ouverte ? |
| la fenêtre flottante ne se ferme pas au relâchement du raccourci | « `松手停留` (Maintien au relâchement) » est activé dans le panneau de paramètres (`releaseStay` de config.json) ; fermez avec Esc / un clic hors de la fenêtre / un nouvel appui sur le raccourci, ou désactivez l’option dans le panneau de paramètres |
| AE plante à la fermeture | vérifiez si `DeathHook` apparaît dans le journal ; consultez l’Observateur d’événements |
| positionnement anormal en multi-écran | la fenêtre flottante est contrainte (clamp) à l’espace de travail de l’écran où se trouve la souris ; sur un écran secondaire, elle ne doit pas déborder de cet écran |
| saisie de chinois anormale | le champ de recherche utilise un contrôle EDIT Win32, la saisie prédictive / les candidats IME sont disponibles ; pendant une composition IME, appuyer sur Enter n’exécute pas l’élément par avance |

#### Procédure de redéploiement

Après modification du code C++ :

```powershell
# 1. quitter AE
# 2. recompiler
cmake --build native/hotbox/build --config Release
# 3. copier le .aex dans AE (écrasement)
Copy-Item "deploy\Plug-ins\AS_Hotbox.aex" "<dossier d’installation d’AE>\Support Files\Plug-ins\" -Force
# 4. lancer AE (redémarrage complet obligatoire, vérifier dans le gestionnaire de tâches que le processus AfterFX.exe est terminé)
```

Après modification d’ExtendScript (`host/api/effectApi.jsx` et similaires) :

```powershell
# exécuter deploy.bat pour mettre à jour les fichiers host du dossier de l’extension CEP
tools\deploy.bat
# aucun redémarrage d’AE n’est nécessaire : le nouveau script est chargé à l’appel suivant
```

---

### Architecture technique

```
┌───────────────────────────────────────────────────────────────────────────┐
│ native/hotbox/  plug-in AEGP (C++20 + MSVC, GeneralPlug)                  │
│  ├─ raccourcis  RegisterHotKey + fenêtre de messages cachée ← WM_HOTKEY   │
│  │        → GetCursorPos : coordonnées de la souris                       │
│  ├─ fenêtre flottante  WS_POPUP + WS_EX_TOPMOST + fenêtre en couches transparente      │
│  │        ├─ gestuel : cercle central + anneau d’arcs (Direct2D)          │
│  │        └─ recherche : barre longue + liste linéaire + filtre déroulant │
│  ├─ canal d’exécution  AEGP_UtilitySuite6::AEGP_ExecuteScript             │
│  │        → effectApi.jsx / scriptRunner.jsx                              │
│  └─ données  lecture en processus (std::ifstream + GetFileAttributesW)    │
└───────────────────────────────────────────────────────────────────────────┘
```

Contraintes clés :
- Le canal d’exécution `AEGP_ExecuteScript` bloque de façon synchrone le thread principal d’AE → privilégier les scripts courts, avec une indication d’état pendant l’exécution.
- La lecture-écriture des données ne passe pas par le Bridge : le plug-in lit directement dans le processus les fichiers de configuration et l’index des scripts du dossier de données ; le Bridge ne sert que le côté panneau.
- L’exécution de scripts passe toujours par l’enveloppe de bac à sable (`runScriptSandboxed`) ; aucun commutateur de contournement n’est fourni.
