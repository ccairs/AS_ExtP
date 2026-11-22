/**
 * shaderParamMap.js — 宿主 param-map 的纯解析层
 *
 * 内容源：native/glsl-host/src/paramMap.cpp 落盘的
 *   <数据根>\temp\ae-tools\param-map\index.json
 * 契约（version 1）：
 *   { version, generated, shaders: { "<小写归一化路径>": {
 *       shaderPath, shaderName, libraryIndex, signature: { mtimeMs, size, hash },
 *       uniforms: [ { name, type, slot, propertyIndex, diskId, components[4],
 *                     componentDiskIds[4], componentNames[], default[4], hasDefault,
 *                     defaultDeclared[4],
 *                     range: { min, max, precision, declared, declaredMin, declaredMax } } ] } } }
 *   · propertyIndex = 5 + 4*slot + comp（native params.h：kIdxSlots=5 / kFloatsPerSlot=4）；槽位分量索引恒为 5..132，133 起的画布/映射图层/相机/文件索引参数不进本映射；
 *   · signature.hash = 源文件 UTF-8 字节 FNV-1a 32（8 位十六进制）；
 *   · componentNames 只列**命名分量**（float=1 / vec2=2 / vec3=3 / vec4=4），components 恒 4 项。
 *
 * 本模块只做纯计算：读盘由调用方负责（shaderTools 走注入的 AEFS，ae-tools/bootstrap 走
 * AEFS.readFileSync），故这里不出现 AEShared/AEFS/Node API。
 * 消费者（两处共用一份寻址语义，避免双实现漂移）：
 *   · modules/agent/engine/shaderTools.js —— buildSetParamScript 按 propertyIndex 寻址；
 *   · modules/ae-tools/bootstrap.js —— 内建工具 shader_params 的 list/set。
 *
 * 双环境加载：Node（测试）module.exports / CEP 面板 window.AEShaderParamMap。
 */
(function (global) {
    'use strict';

    // 契约版本：宿主 paramMap.cpp 写 "version":1；版本不符按「映射不可用」处理（fail-closed）。
    var PARAM_MAP_VERSION = 1;
    // 数据根下的相对位置（唯一来源：shaderTools 与 ae-tools 都用 paramMapPathFor 拼）。
    var PARAM_MAP_REL = '\\temp\\ae-tools\\param-map\\index.json';

    // 分量后缀 → 分量下标。宿主按类型给名字（float/vec2/vec3 用 .y/.z/.w，颜色语义用 .g/.b/.a）；
    // x/r 为 0 号分量的等价写法，收进来避免 `uColor.r` 被当成未知名字。
    var COMPONENT_SUFFIX = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };

    // ASCII 折小写：宿主路径归一用 _stricmp（C locale 只折 A-Z），JS 的 toLowerCase 会做
    // Unicode 折法，对含中文的文件名与宿主不一致 → 只折 A-Z，保持码元比较。
    function asciiFold(s) {
        var str = String(s == null ? '' : s);
        var out = '';
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            out += (c >= 65 && c <= 90) ? String.fromCharCode(c + 32) : str.charAt(i);
        }
        return out;
    }

    // Windows 路径归一（ASCII 折小写 + '/'→'\\' + 去尾部反斜杠），与宿主 normalizePathKey 同口径。
    function normalizePathKey(p) {
        var s = asciiFold(String(p == null ? '' : p)).replace(/\//g, '\\');
        while (s.length > 1 && s.charAt(s.length - 1) === '\\') s = s.slice(0, -1);
        return s;
    }

    function baseName(p) {
        var s = String(p == null ? '' : p);
        var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
        return i >= 0 ? s.slice(i + 1) : s;
    }

    // 数据根 → param-map 绝对路径。数据根为空返回空串（调用方据此报「数据目录不可用」）。
    function paramMapPathFor(dataDir) {
        var dir = String(dataDir == null ? '' : dataDir).replace(/[\\\/]+$/, '');
        if (!dir) return '';
        return dir + PARAM_MAP_REL;
    }

    // 与宿主 FNV-1a 32 同算法（按 UTF-8 字节），用于判 param-map 是否过期。
    // 不用 shaderTools 的 hashText：后者按 UTF-16 码元哈希，含中文注释的 shader 两边结果不同。
    function hashUtf8(s) {
        var str = String(s == null ? '' : s);
        var h = 0x811c9dc5;
        function mix(byte) {
            h = (h ^ (byte & 0xff)) >>> 0;
            h = Math.imul(h, 16777619) >>> 0;
        }
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 0x80) {
                mix(c);
            } else if (c < 0x800) {
                mix(0xC0 | (c >> 6));
                mix(0x80 | (c & 0x3F));
            } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length &&
                       str.charCodeAt(i + 1) >= 0xDC00 && str.charCodeAt(i + 1) <= 0xDFFF) {
                var cp = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(i + 1) - 0xDC00);
                mix(0xF0 | (cp >> 18));
                mix(0x80 | ((cp >> 12) & 0x3F));
                mix(0x80 | ((cp >> 6) & 0x3F));
                mix(0x80 | (cp & 0x3F));
                i++;
            } else {
                // 其余（含孤立代理）按 3 字节编码：宿主不会生成这种 shader，属防御分支
                mix(0xE0 | (c >> 12));
                mix(0x80 | ((c >> 6) & 0x3F));
                mix(0x80 | (c & 0x3F));
            }
        }
        var hex = h.toString(16);
        while (hex.length < 8) hex = '0' + hex;
        return hex;
    }

    // 文本 → { version, shaders }。任何失败（空文本/半截/版本不符/形状不符）返回 null。
    function parseParamMapDoc(text) {
        if (text == null || text === '') return null;
        var doc = null;
        try { doc = JSON.parse(String(text)); } catch (_) { return null; }
        if (!doc || typeof doc !== 'object') return null;
        if (doc.version !== PARAM_MAP_VERSION) return null;
        if (!doc.shaders || typeof doc.shaders !== 'object') return null;
        return doc;
    }

    // 命名分量数（componentNames 的首选口径；缺失时按 1 = 只有 0 号分量）。
    function componentCount(uniform) {
        if (uniform && uniform.componentNames && uniform.componentNames.length) {
            return uniform.componentNames.length;
        }
        return 1;
    }

    // 严格名字匹配（抽出前的既有语义，resolveParamMapTarget 专用）：
    // uniform 名 → 0；componentNames 里逐项精确等于 → 该下标。其余 -1。
    // 刻意不做后缀推导——此判据只认精确相等，加后缀会改变 buildSetParamScript 的命中面。
    function strictComponentIndex(uniform, name) {
        if (!uniform) return -1;
        if (uniform.name === name) return 0;
        var names = uniform.componentNames;
        if (names) {
            for (var i = 0; i < names.length; i++) {
                if (names[i] === name) return i;
            }
        }
        return -1;
    }

    // 名字 → 分量下标（shader_params 用）：严格匹配之外，支持 `<uniform>.<x|y|z|w|r|g|b|a>` 后缀，
    // 下标必须落在该 uniform 的命名分量数内（float 的 uSpeed.y 不视为有效分量）。
    function componentIndexForName(uniform, name) {
        if (!uniform) return -1;
        var n = String(name == null ? '' : name);
        if (!n) return -1;
        var strict = strictComponentIndex(uniform, n);
        if (strict >= 0) return strict;
        var base = String(uniform.name == null ? '' : uniform.name);
        if (!base || n.length !== base.length + 2 || n.indexOf(base) !== 0 || n.charAt(base.length) !== '.') {
            return -1;
        }
        var idx = COMPONENT_SUFFIX[n.charAt(n.length - 1).toLowerCase()];
        if (idx == null || idx >= componentCount(uniform)) return -1;
        return idx;
    }

    // uniform + 分量下标 → AE 参数索引（components 优先，缺项按 propertyIndex + 分量下标）。
    function propertyIndexOf(uniform, comp) {
        if (!uniform) return NaN;
        var c = (comp == null) ? 0 : comp;
        if (uniform.components && uniform.components[c] != null) return Number(uniform.components[c]);
        var base = Number(uniform.propertyIndex);
        if (!isFinite(base)) return NaN;
        return base + c;
    }

    // 按宿主库索引（实例参数 141 的值）找映射条目。返回 [{ key, entry }]：
    // 0 条 = 该 shader 尚未被宿主记录；多条 = 同一库索引在映射里有多份（路径不同/重复落盘）。
    function findEntriesByLibraryIndex(doc, libraryIndex) {
        var out = [];
        if (!doc || !doc.shaders || libraryIndex == null) return out;
        var want = Number(libraryIndex);
        if (!isFinite(want)) return out;
        for (var key in doc.shaders) {
            if (!Object.prototype.hasOwnProperty.call(doc.shaders, key)) continue;
            var e = doc.shaders[key];
            if (!e || e.libraryIndex == null) continue;
            if (Number(e.libraryIndex) === want) out.push({ key: key, entry: e });
        }
        return out;
    }

    // 歧义候选（给调用方列给用户/LLM 的最小字段集）。
    function ambiguousList(matches) {
        var out = [];
        for (var i = 0; i < matches.length; i++) {
            var m = matches[i];
            out.push({
                shaderPath: m.entry && m.entry.shaderPath,
                shaderName: m.entry && m.entry.shaderName,
                libraryIndex: (m.entry && m.entry.libraryIndex != null) ? Number(m.entry.libraryIndex) : -1,
                uniform: m.uniform && m.uniform.name,
                propertyIndex: propertyIndexOf(m.uniform, m.componentIndex)
            });
        }
        return out;
    }

    /**
     * uniform 名（可含 .g 等分量后缀名）→ 唯一目标。
     *
     * opts：
     *   uniformName   必填，uniform 名或 componentNames 里的分量名；
     *   shaderPath    可选，实例 shader 路径（完整路径或仅文件名都算命中）；
     *   shaderName    可选，只有文件名时的线索（与映射条目的 basename 比对）；
     *   shaderSource  可选，string = 当前源文本；function = (entry) => string|null（逐候选惰性读，
     *                 读盘语义（AEFS/失败保留）留在调用方）。
     *
     * 返回：
     *   唯一目标 → { propertyIndex, libraryIndex, componentIndex, entry, uniform }
     *   同名 uniform 落在多个不同槽位（无法判定实例） → { ambiguous: [ {shaderPath, shaderName,
     *     libraryIndex, uniform, propertyIndex} ] }
     *   无映射/全部过期/线索筛空/索引非法 → null
     *
     * 过期语义（与抽出前逐字一致）：signature.hash 存在且能拿到当前源文本时比对；
     * 拿不到源文本（文件被删/无读权限/未给 source）时保留映射，不因读失败退化为按名寻址。
     */
    function resolveParamMapTarget(doc, opts) {
        opts = opts || {};
        var name = String(opts.uniformName == null ? '' : opts.uniformName);
        if (!name || !doc || !doc.shaders) return null;

        var hintPath = opts.shaderPath ? normalizePathKey(opts.shaderPath) : '';
        var hintBase = hintPath ? baseName(hintPath)
            : (opts.shaderName ? asciiFold(String(opts.shaderName)) + '.glsl' : '');

        var matches = [];
        for (var key in doc.shaders) {
            if (!Object.prototype.hasOwnProperty.call(doc.shaders, key)) continue;
            var e = doc.shaders[key];
            if (!e || !e.uniforms || !e.uniforms.length) continue;
            for (var i = 0; i < e.uniforms.length; i++) {
                var comp = strictComponentIndex(e.uniforms[i], name);
                if (comp >= 0) {
                    matches.push({ entry: e, uniform: e.uniforms[i], componentIndex: comp });
                    break;   // 同一文件内一个名字只对应一个槽位
                }
            }
        }
        if (!matches.length) return null;

        // 有 shader 身份线索时必须命中该文件（按完整路径，或仅文件名）
        if (hintPath || hintBase) {
            var filtered = [];
            for (var j = 0; j < matches.length; j++) {
                var mp = normalizePathKey(matches[j].entry.shaderPath);
                if ((hintPath && mp === hintPath) || (hintBase && baseName(mp) === hintBase)) filtered.push(matches[j]);
            }
            if (!filtered.length) return null;
            matches = filtered;
        }

        // 过期判定：宿主 hash = 文件原文 UTF-8 字节 FNV-1a 32
        var fresh = [];
        for (var k = 0; k < matches.length; k++) {
            var m = matches[k];
            var stale = false;
            var sig = m.entry.signature;
            if (sig && sig.hash) {
                var curSrc = null;
                if (typeof opts.shaderSource === 'string') curSrc = opts.shaderSource;
                else if (typeof opts.shaderSource === 'function') {
                    try { curSrc = opts.shaderSource(m.entry); } catch (_) { curSrc = null; }
                }
                if (curSrc != null && hashUtf8(curSrc) !== String(sig.hash)) stale = true;
            }
            if (!stale) fresh.push(m);
        }
        if (!fresh.length) return null;
        matches = fresh;

        // 只有唯一槽位时才敢按索引写：多 shader 里同名 uniform 落在不同槽位、又给不出实例身份
        // → 无法判定目标，交调用方按名寻址（旧行为）或列候选。
        var targets = {};
        for (var q = 0; q < matches.length; q++) {
            var lib = (matches[q].entry.libraryIndex == null) ? -1 : Number(matches[q].entry.libraryIndex);
            targets[propertyIndexOf(matches[q].uniform, matches[q].componentIndex) + '|' + lib] = true;
        }
        if (Object.keys(targets).length !== 1) return { ambiguous: ambiguousList(matches) };

        var best = matches[0];
        var propIndex = propertyIndexOf(best.uniform, best.componentIndex);
        if (!isFinite(propIndex) || propIndex < 0) return null;
        return {
            propertyIndex: propIndex,
            libraryIndex: (best.entry.libraryIndex == null) ? -1 : Number(best.entry.libraryIndex),
            componentIndex: best.componentIndex,
            entry: best.entry,
            uniform: best.uniform
        };
    }

    var api = {
        PARAM_MAP_VERSION: PARAM_MAP_VERSION,
        PARAM_MAP_REL: PARAM_MAP_REL,
        asciiFold: asciiFold,
        normalizePathKey: normalizePathKey,
        baseName: baseName,
        paramMapPathFor: paramMapPathFor,
        hashUtf8: hashUtf8,
        parseParamMapDoc: parseParamMapDoc,
        componentCount: componentCount,
        componentIndexForName: componentIndexForName,
        propertyIndexOf: propertyIndexOf,
        findEntriesByLibraryIndex: findEntriesByLibraryIndex,
        resolveParamMapTarget: resolveParamMapTarget
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof global !== 'undefined') {
        global.AEShaderParamMap = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
