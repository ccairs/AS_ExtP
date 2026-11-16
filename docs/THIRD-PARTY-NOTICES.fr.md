# Mentions des composants tiers / Third-Party Notices

[简体中文](THIRD-PARTY-NOTICES.md) | [English](THIRD-PARTY-NOTICES.en.md) | [日本語](THIRD-PARTY-NOTICES.ja.md) | [Deutsch](THIRD-PARTY-NOTICES.de.md) | [한국어](THIRD-PARTY-NOTICES.ko.md) | **Français** | [Русский](THIRD-PARTY-NOTICES.ru.md)

> Ce document est une traduction française fournie à titre informatif. Les textes de licence ci-dessous sont reproduits en anglais ; l'[original chinois](THIRD-PARTY-NOTICES.md) fait foi.

AS_ExtP est publié sous licence MIT (voir [LICENSE](../LICENSE)). Ce document énumère les composants tiers que ce projet distribue ou appelle, ainsi que leurs licences.

**Formes de distribution** : le projet peut être obtenu de deux manières, avec des obligations tierces différentes. **Le paquet Release complet est utilisable immédiatement** — il contient les composants natifs précompilés (`.aex`), un environnement d’exécution Node.js intégré et les dépendances npm ; décompressez-le et double-cliquez sur `tools\install.bat` pour l’utiliser, sans installer Node, exécuter `npm ci` ni compiler. Si vous redistribuez ce paquet, fournissez-le avec le présent document et les fichiers de licence correspondants. **Le dépôt source ne contient pas** les binaires et dépendances ci-dessus (limites de taille et de distribution) ; après clonage, exécutez `npm ci` vous-même et complétez l’installation avec `tools\check-env.bat` / `tools\install.bat`, les composants natifs devant être compilés par vos soins. FFmpeg n’est **pas distribué** par ce projet (ni le paquet Release ni le dépôt source ne le contiennent) ; `tools\check-env.bat` / `tools\install.bat` téléchargent sur la machine une version amont figée.

## 1. Composants binaires

### FFmpeg 8.1.2 — GPL-3.0-or-later (non distribué par ce projet)

| Élément | Description |
| --- | --- |
| Acquisition | **Non distribué par ce projet.** `tools\check-env.bat` / `tools\install.bat` téléchargent `8.1.2-essentials_build` depuis la Release amont vers la machine locale et vérifient le téléchargement d’après le SHA-256 figé (`db580001…`) |
| Emplacement local | `vendor/ffmpeg/ffmpeg.exe`, `vendor/ffmpeg/ffprobe.exe` (absents du dépôt source et du paquet Release) |
| Textes de licence intégraux | L’archive zip amont contient `LICENSE.md` / `COPYING.GPLv3` / `COPYING.GPLv2` / `COPYING.LGPLv2.1` / `COPYING.LGPLv3` (selon ce qui est réellement présent). Après extraction, `tools\check-env.bat` / `tools\install.bat` les conservent avec `SOURCE.txt` (adresse de téléchargement, SHA-256, indications sur le code source correspondant) dans `vendor/ffmpeg/` ; ce projet ne distribue toujours pas ce binaire ; en cas de redistribution, fournissez ces textes avec les indications d’obtention du code source |
| Source et indications sur le code source correspondant | `8.1.2-essentials_build` fourni par Gyan Doshi (`GyanD/codexffmpeg`, étiquette de Release GitHub `8.1.2`), liant statiquement des composants GPL tels que libx264 / libx265 ; le commit du code source amont enregistré par cette Release est `FFmpeg/FFmpeg@38b88335f9`, l’archive source étant `ffmpeg-8.1.2.tar.xz` sur ffmpeg.org |
| Usage | Appelé comme processus séparé (interface en ligne de commande) pour le transcodage vidéo et l’extraction d’images dans la bibliothèque d’actifs ; non lié au code source d’AS_ExtP |

> Ce projet ne participe pas à la distribution de ce binaire et n’assume aucune obligation de distribution GPL à son égard ; une installation par script réussie affiche une ligne de rappel GPL et conserve les textes de licence amont dans `vendor/ffmpeg/`. Si vous redistribuez un dossier contenant ffmpeg, il vous incombe de satisfaire les obligations GPL-3.0-or-later (joindre la licence, fournir le code source correspondant).

### Node.js 22.23.2 — MIT

| Élément | Description |
| --- | --- |
| Mode de distribution | Distribué avec le paquet Release complet (absent du dépôt source ; pour un clone source, installez Node ≥ 20.18 vous-même) |
| Emplacement | `vendor/node/node.exe` |
| Texte de licence intégral | `vendor/node/LICENSE` — l’original contenu dans `node-v22.23.2-win-x64.zip` officiel, avec les mentions de licence des composants intégrés à Node. Le script d’installation vérifie ce paquet de distribution avec le SHA-256 figé `1177b413…` (`tools/install.bat`, `tools/check-env.bat`), valeur identique à celle du `SHASUMS256.txt` amont ; le `node.exe` du paquet et celui de ce dossier ont le même hachage (`0d0f5e39…`) |
| Usage | Environnement d’exécution du Bridge local et du serveur MCP stdio |

## 2. Dépendances npm (`vendor/node_modules/`, distribuées avec le paquet Release complet)

Sauf les paquets marqués ※ dans le tableau ci-dessous, chaque dossier de paquet contient son propre fichier de licence (le texte intégral des licences des paquets ※ figure dans l’annexe ci-dessous) ; le tableau est un récapitulatif, les versions étant celles de `package-lock.json`. **Aucune dépendance GPL / AGPL / LGPL obligatoire** (`jszip` est sous double licence `MIT OR GPL-3.0-or-later`, utilisé ici sous MIT). Le paquet Release complet contient ce dossier et le fichier de licence de chaque paquet ; un clone source ne contient pas ce dossier — installez les dépendances dans le `node_modules` racine avec `npm ci` d’après `package-lock.json`, puis les scripts de déploiement (`deploy.bat` / `install.bat`) les copient vers `vendor/node_modules`. À l’exécution, `client/shared/ae-bridge.js` pointe `NODE_PATH` vers `vendor/node_modules` (idem dans `client/shared/ext-mcp-server.js`) ; la résolution standard de Node rencontre d’abord le `node_modules` le plus proche, `NODE_PATH` servant de repli, si bien que le clone source (`node_modules` racine) comme le déploiement (seulement `vendor/node_modules`) résolvent leurs dépendances. `xmlbuilder` 10.1.1 est installé de façon imbriquée dans `vendor/node_modules/mammoth/node_modules/xmlbuilder/` (fourni par mammoth), les autres paquets se trouvant à la racine de `vendor/node_modules/`.

| Paquet | Version | Licence |
| --- | --- | --- |
| @wwek/xlsx | 0.20.3 | Apache-2.0 |
| @xmldom/xmldom | 0.8.13 | MIT |
| argparse | 1.0.10 | MIT |
| base64-js | 1.5.1 | MIT |
| bluebird | 3.4.7 | MIT |
| core-util-is | 1.0.3 | MIT |
| dingbat-to-unicode | 1.0.1 | BSD-2-Clause ※ |
| duck | 0.1.12 | BSD-2-Clause (le champ amont n’indique que « BSD » ; le texte réel est la BSD à deux clauses) |
| immediate | 3.0.6 | MIT |
| inherits | 2.0.4 | ISC |
| isarray | 1.0.0 | MIT ※ |
| jszip | 3.10.1 | MIT OR GPL-3.0-or-later (utilisé ici sous MIT) |
| lie | 3.3.0 | MIT |
| lop | 0.4.2 | BSD-2-Clause |
| mammoth | 1.12.1 | BSD-2-Clause |
| option | 0.2.4 | BSD-2-Clause |
| pako | 1.0.11 | MIT AND Zlib ※ (le paquet ne joint que le texte MIT ; texte intégral de Zlib en annexe) |
| path-is-absolute | 1.0.1 | MIT |
| process-nextick-args | 2.0.1 | MIT |
| readable-stream | 2.3.8 | MIT |
| safe-buffer | 5.1.2 | MIT |
| setimmediate | 1.0.5 | MIT |
| sprintf-js | 1.0.3 | BSD-3-Clause |
| string_decoder | 1.1.1 | MIT |
| underscore | 1.13.8 | MIT |
| unpdf | 1.8.0 | MIT ; intègre Mozilla PDF.js 6.1.200 (Apache-2.0) ※ |
| util-deprecate | 1.0.2 | MIT |
| xmlbuilder | 10.1.1 | MIT |

※ = le paquet amont ne contient pas le texte intégral de cette licence (ou ne le joint pas au paquet) ; son texte intégral figure dans l’annexe ci-dessous. Le fichier `dist/pdfjs.mjs` de `unpdf@1.8.0` est une compilation serverless de Mozilla PDF.js (version intégrée 6.1.200), cette partie étant sous Apache-2.0 ; le paquet `unpdf` amont ne joint que son propre texte MIT, sans le texte Apache-2.0.

## 3. Bibliothèques tierces distribuées avec l’arborescence du code source

Les bibliothèques suivantes sont incluses sous forme de source dans le dépôt public ; **glad** et **PinIn4Cpp** y sont compilés statiquement dans les `.aex` du paquet Release au moment de la construction (ils sont donc distribués sous forme binaire avec la Release), leurs textes de licence étant fournis avec l’arborescence, ce qui satisfait l’exigence des licences permissives de conserver les mentions de copyright et de licence avec les copies :

| Bibliothèque | Emplacement | Version | Licence | Texte de licence | Usage |
| --- | --- | --- | --- | --- | --- |
| marked | `client/vendor/marked/` | 12.0.2 | MIT | `LICENSE` dans l’arborescence | Rendu Markdown |
| Prism.js | `client/vendor/prism/` | 1.29.0 (déduite) | MIT | `LICENSE` dans l’arborescence | Coloration syntaxique |
| js-xss | `client/vendor/xss/` | 1.0.15 (déduite) | MIT | `LICENSE` dans l’arborescence ; le bundle intègre en outre cssfilter (MIT), texte intégral en annexe | Assainissement du HTML |
| anime.js | `client/vendor/anime/` | 3.2.2 | MIT (© 2019 Julian Garnier ; l’en-tête du fichier min indique 2023 par erreur) | Mention dans l’en-tête du fichier ; texte intégral en annexe | Animation de l’interface |
| acorn (es3-parser) | `client/vendor/es3-parser/` | 8.18.0 | MIT (© 2012-2022 by various contributors) | Mention dans le fichier `acorn.js` + `README.md` de provenance (texte intégral de la licence en annexe) | Analyseur ES3 du portail de compilation AST |
| CSInterface.js | `client/vendor/CSInterface.js` | 8.0.0 (implémentation allégée) | Contrat de licence Adobe SDK (non OSS) ; le fichier conserve l’en-tête de copyright Adobe et le numéro de version | `CSInterface.LICENSE.pdf` dans l’arborescence (l’original du contrat, voir ci-dessous) | Interface hôte CEP |
| glad | `native/glsl-host/third_party/glad/` | 0.1.36 (générateur) | MIT + Khronos Apache-2.0 | `LICENSE` dans l’arborescence (original amont, en trois parties : glad / Khronos Specifications / EGL headers) ; `include/KHR/khrplatform.h` contient le texte original de la licence Khronos | Chargeur OpenGL |
| PinIn4Cpp | `native/hotbox/third_party/PinIn4Cpp/` | 1.5.8 | MIT (© 2025 KagiyamaHina) | `LICENSE` dans l’arborescence ; `licenses/` contient deux textes MIT, PinIn (© 2019 Juntong Liu) et pinyin-data (© 2016 mozillazg) | Correspondance pinyin du Hotbox |
| json2 (adaptation de json2.js de Crockford) | `host/api/json2.jsx` | Aucune version indiquée | Public Domain | Mention dans l’en-tête du fichier (domaine public, aucune obligation de texte de licence) | Polyfill JSON pour ExtendScript (ES3 n’a pas de JSON natif) |
| Feather Icons / Lucide | SVG `data:` CSS et `<svg>` en ligne sous `client/` | — | MIT (Feather, © 2013-2023 Cole Bemis) / ISC (Lucide) | Texte intégral en annexe | Icônes en ligne de l’interface (certains `path` repris mot pour mot de l’amont) |

« — » = aucune version n’est indiquée dans le fichier min empaqueté. **Les versions de Prism et de js-xss sont déduites** : celle de Prism a été confirmée par comparaison octet par octet entre `prism-core.min.js` et le fichier officiel `components/prism-core.min.js` de `prismjs@1.29.0` (`prism-clike` / `prism-javascript` et le fichier de thème sont conformes aux fichiers officiels) ; celle de js-xss a été confirmée par l’identité du SHA-256 `2072387B…3261E` de `xss.min.js` avec l’artefact officiel de `xss@1.0.15`, et corroborée par les bornes de version : le bundle contient `singleQuotedAttributeValue` (introduit en 1.0.15) et non `filterXSSWithResult` (introduit en 1.0.16). Les autres versions ont été vérifiées directement sur la chaîne de version du fichier / le `package-lock`.

**Modifications locales de Prism** : `client/vendor/prism/prism-core.min.js` présente deux différences avec la version amont 1.29.0 — dans `highlightAllUnder`, le conteneur est transmis par le paramètre de fonction au lieu de `env.container`, que les hooks pouvaient réécrire ; à la fin du fichier, ajout de `window.Prism=Prism;` (montage global pour l’environnement CEP). Ces modifications ne changent rien aux obligations de licence et doivent être réappliquées lors d’une mise à jour de Prism.

**CSInterface.js** : copyright Adobe (`Copyright (c) 2012-2017 Adobe Systems Inc.`), l’en-tête du fichier déclarant autoriser son utilisation, sa modification et sa distribution selon le contrat de licence Adobe qui l’accompagne. Le texte original de ce contrat (`GenSDK_IHC-en_US-20120323_1224.pdf`, repris du dossier `License/` du dépôt Adobe CEP-Resources) a été placé dans l’arborescence sous `client/vendor/CSInterface.LICENSE.pdf` (95,659 B, SHA-256 `32E81408…5383`) ; ce projet utilise ce fichier selon ce contrat, dans le cadre de l’extension CEP. Le fichier livré est une implémentation allégée selon les besoins du projet (357 lignes, 16 méthodes : `evalScript` / `getHostEnvironment` / `getSystemPath` / `getExtensionPath`, enregistrement d’événements, etc.), et non le texte intégral de la distribution officielle d’Adobe (la v8 officielle compte environ 1200 lignes et comporte en outre `setPanelFlyoutMenu` / `updatePanelMenuItem` / `getExtensions` / `getNetworkPreferences`, etc.) ; l’en-tête de copyright et l’identifiant de version `v8.0.0` sont conservés tels quels d’après l’amont, pour indiquer que l’interface et l’usage proviennent du SDK Adobe CEP.

À l’exception de CSInterface.js (contrat Adobe, non OSS), toutes les autres bibliothèques sont sous licences permissives de type MIT / BSD ; glad comporte en outre la partie Apache-2.0 de Khronos (déjà signalée dans le tableau), compatible avec la licence MIT de ce projet.

## 4. Dépendances de construction et contenu Adobe dans les artefacts compilés (le SDK lui-même n’est pas distribué)

| Composant | Licence | Description |
| --- | --- | --- |
| SDK Adobe After Effects | Contrat Adobe SDK | Nécessaire pour compiler les deux composants natifs de `native/` (hôte d’effets GLSL / Hotbox AE) ; l’obtention auprès d’Adobe incombe au constructeur ; **le SDK lui-même et son texte de licence ne sont pas distribués avec le dépôt source ni le paquet Release** ; les étapes de construction figurent dans [DEVELOPMENT.md](DEVELOPMENT.md) |
| Artefacts compilés `deploy/Plug-ins/*.aex` | Artefacts de construction de ce projet ; soumis au contrat Adobe SDK | Le paquet Release complet contient `AS_Effect_Host.aex` (environ 643 KB) et `AS_Hotbox.aex` (environ 1.5 MB). À la construction, des sources d’exemple non modifiées de `Examples/Util` du SDK (`AEFX_SuiteHelper.c`, `AEGP_SuiteHandler.cpp`, `MissingSuiteError.cpp`) sont compilées comme unités de traduction, et glad (MIT) ainsi que PinIn4Cpp (MIT, avec les données pinyin de pinyin-data) sont liés statiquement ; ces deux binaires ne relèvent pas de la licence MIT de ce projet. Avant toute redistribution ou utilisation commerciale, vérifiez vous-même les clauses de votre contrat avec Adobe (contactez l’assistance développeurs Adobe si nécessaire) |

> Hormis les fichiers `.aex`, le reste du contenu du paquet Release complet (code source, Node.js, dépendances npm) est déclaré par le présent document et les fichiers LICENSE de chaque paquet ; les `.aex` sont les seuls artefacts binaires compilés par ce projet dans le périmètre de ce document (le `vendor/node/node.exe` du paquet est l’environnement d’exécution Node.js amont, voir la section 1).

## 5. Actifs non logiciels et provenance des contenus

Le contenu distribué par ce projet avec l’arborescence du code source comprend trois actifs non logiciels ; **il ne contient aucune banque d’images, police ou ressource audio tierce** :

| Contenu | Emplacement | Taille | Source | Description |
| --- | --- | --- | --- | --- |
| Séquences d’images de la mascotte (16 PNG) | `client/features/deepseekPet/sprites/` | environ 108.7 MB | Réalisées par l’auteur du projet avec des outils de génération par IA ; les deux éléments `potHead` / `eat` proviennent de séquences faites maison fusionnées depuis l’extérieur du dépôt | Animation de personnage originale |
| Vidéo easter egg `appear.webm` | Idem ci-dessus | environ 1.8 MB | Réalisée par l’auteur du projet (génération par IA) ; elle **contient une voix chinoise générée par IA** | Animation d’apparition plein écran à l’ouverture de l’easter egg de la mascotte |
| Table d’états `manifest.json` | Idem ci-dessus | 1.9 KB | Rédigée par l’auteur du projet | Spécification de la grille d’images |

**Polices** : toutes les polices de l’interface sont des polices installées localement et référencées par leur nom — la pile de polices système (Segoe UI / Microsoft YaHei / Yu Gothic UI / Malgun Gothic / Noto Sans KR / Consolas, etc.) avec repli sur les familles génériques `sans-serif` / `serif` / `monospace` ; aucun `@font-face`, aucune police intégrée en base64, aucun chargement distant, et aucun fichier de police distribué avec le paquet. Les deux composants natifs utilisent la police Drawbot par défaut de l’hôte AE et la police système DirectWrite (`Microsoft YaHei UI`), sans embarquer de police non plus : ce projet n’a donc aucune obligation de licence en matière de polices.

**Mention sur le personnage** : le personnage est une baleine anthropomorphe de style fan-art communautaire, dont le motif (baleine, palette bleu nuit) s’approche de l’image de marque DeepSeek ; son nom externe et les textes de l’interface sont « 大肥鱼桌宠 » et « 大肥鱼 » (sans le mot DeepSeek), et le mot déclencheur de l’easter egg est « 大肥鱼 ». Ce projet n’a aucun lien d’affiliation, de parrainage ou de licence avec DeepSeek officiel, **n’a obtenu aucune licence de marque ni de droit d’auteur** de sa part, et n’a pas copié son logo officiel ni sa marque verbale. Si un ayant droit conteste ce personnage, il sera retiré ou remplacé sans délai : supprimer `client/features/deepseekPet/sprites/` retire le personnage (seule la fonction mascotte devient indisponible), ou ajouter `--without-sprites` lors de l’export. Les identifiants dans le code restent `deepseekPet` / `AEDeepseekPet` (dossiers de module et espaces de noms, et non textes de l’interface).

**Périmètre de licence** : les actifs ci-dessus sont fournis avec ce projet sous MIT ; les parties relevant de l’image de marque DeepSeek ne relèvent pas de ce que ce projet peut concéder, et l’utilisateur assume les risques correspondants.

**Documents et données** : `client/shared/aeApiReference.txt` (compilation en chinois de l’API de script AE, utilisée par `queryAeApi`) a été généré à partir du document de référence de ce projet ; le fichier indique lui-même provenir de « 整理来源：AE脚本API参考 » (référence de l’API de script AE) et **semble compilé d’après la documentation officielle de script Adobe** (le fichier ne contient aucune URL d’origine) ; en cas d’opposition d’un ayant droit, il sera retiré ou remplacé par un résumé propre. `client/shared/aeMatchName.json` est une correspondance matchName → nom affiché exportée d’une installation réelle d’AE, et constitue une donnée factuelle.

**Icônes en ligne de l’interface** : certains `path` d’icônes des SVG `data:` CSS et des `<svg>` en ligne sous `client/` sont repris mot pour mot de Feather Icons (MIT) et de Lucide (ISC) ; ils sont déclarés à la section 3 et les textes intégraux des licences figurent en annexe.

## 6. Composants récupérés auprès de l’amont à l’exécution et non distribués par ce projet

| Composant | Licence | Description |
| --- | --- | --- |
| Bibliothèque de modèles officiels ComfyUI (`Comfy-Org/workflow_templates`) | MIT (© 2023-present Comfy Org) | La fonction « Modèles officiels » récupère l’index des modèles depuis `raw.githubusercontent.com` / `cdn.jsdelivr.net` à l’exécution et le met en cache dans le dossier de données local ; **non distribué avec le dépôt source ni le paquet Release** |
| Serveur ComfyUI | Sa propre licence | Programme externe fourni par l’utilisateur ; ce projet ne l’appelle que par le réseau |
| API des grandes plateformes LLM | Conditions de service de chaque plateforme | Service externe dont l’utilisateur fournit la clé ; ce projet n’émet que des requêtes réseau |

## Annexe : composants dont l’amont ne joint pas le texte de licence

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

BSD-2-Clause. Le paquet npm ne joint pas de fichier de licence (`package.json` déclare `BSD-2-Clause`) ; le texte intégral ci-dessous provient du fichier `js/LICENSE` du dépôt amont `mwilliamson/dingbat-to-unicode` :

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

L’en-tête du fichier min ne conserve que le copyright et le nom de la licence (`(c) 2023 Julian Garnier` / `Released under the MIT license`), sans le texte intégral. Remarque : le fichier LICENSE de `anime.js@3.2.2` amont indique `2019`, ce qui diffère de l’en-tête du fichier min ; le texte ci-dessous est ajouté d’après le fichier LICENSE amont (2019 faisant foi) :

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

### acorn@8.18.0 (`client/vendor/es3-parser/`, fourni sous le nom es3-parser)

L’artefact dist d’acorn ne conserve dans le fichier qu’une mention de l’auteur et du nom de la licence, sans le texte intégral (le `README.md` de ce dossier en documente la provenance). Le texte ci-dessous est ajouté d’après le fichier LICENSE du paquet npm amont `acorn@8.18.0` (le fichier `AUTHORS` référencé par la ligne de copyright d’origine n’est pas joint à cette arborescence ; voir le dépôt amont) :

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

Le texte intégral de la licence est fourni avec l’arborescence du code source : `native/glsl-host/third_party/glad/LICENSE` (l’original de `Dav1dde/glad` v0.1.36 en amont, 3,077 B dans l’arborescence ; la version LF amont fait 3,014 B, l’arborescence contenant une copie de travail en CRLF). Ce fichier comporte trois parties :

- **glad proprement dit** : MIT, `Copyright (c) 2013-2021 David Herberth` ;
- **The Khronos Specifications** : `Copyright (c) 2013-2020 The Khronos Group Inc.`, `Licensed under the Apache License, Version 2.0` ;
- **The EGL Specification and various headers** : `Copyright (c) 2007-2016 The Khronos Group Inc.` (licence de type MIT de Khronos).

`include/KHR/khrplatform.h` contient le texte original de la licence Khronos (`Copyright (c) 2008-2018 The Khronos Group Inc.`).

### pako 1.0.11 (`vendor/node_modules/pako/`, licence Zlib)

pako est sous licence `MIT AND Zlib` : le texte intégral MIT est fourni avec le paquet (`pako/LICENSE`), tandis que le texte amont de la partie Zlib n’est pas joint au paquet npm ; ci-dessous le texte standard intégral du `LICENSE` du dépôt officiel de zlib :

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

### PDF.js 6.1.200 (Apache-2.0, intégré dans `vendor/node_modules/unpdf/dist/pdfjs.mjs`)

`unpdf@1.8.0` fournit avec le paquet une compilation serverless de Mozilla PDF.js 6.1.200 (`dist/pdfjs.mjs`, environ 1.6 MB) ; ce fichier est sous Apache-2.0 et le paquet `unpdf` amont ne joint pas ce texte de licence. Mention de copyright amont : `Copyright 2012 Mozilla Foundation` et les contributeurs de PDF.js. La licence MIT de ce projet ne couvre pas ce code intégré ; en distribuant un paquet Release complet contenant `vendor/node_modules/unpdf/`, fournissez ce paragraphe avec le texte intégral Apache-2.0 ci-dessous.

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

### cssfilter (intégré dans le bundle `client/vendor/xss/`)

Le fichier empaqueté `client/vendor/xss/xss.min.js` intègre cssfilter (dépendance de filtrage CSS de js-xss, MIT) :

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

### Feather Icons (icônes en ligne sous `client/`)

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

### Lucide (icônes en ligne sous `client/`)

Ci-dessous le `LICENSE` intégral de `lucide-icons/lucide` amont (l’année de la ligne de copyright suit les versions amont ; les icônes qui y sont listées dérivent de Feather, dont le texte MIT intégral est joint) :

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
