// json2.jsx — JSON polyfill for ExtendScript (ES3, no native JSON)
// Adapted from Douglas Crockford's json2.js (public domain).
// ExtendScript (AE 23.x 等) 的引擎无原生 JSON 全局，导致 bootstrap 脚本第一行
// JSON.parse(args) 就抛 ReferenceError，所有工具执行在用户代码跑之前就崩。
// host.jsx 启动时最先 evalFile 本文件，给引擎补上 JSON。
// 守卫：若引擎已自带原生 JSON，则不覆盖。

if (typeof JSON !== "object") {
    JSON = {};
}

(function () {
    "use strict";

    function f(n) {
        return n < 10 ? "0" + n : n;
    }

    if (typeof Date.prototype.toJSON !== "function") {
        Date.prototype.toJSON = function () {
            return isFinite(this.valueOf())
                ? this.getUTCFullYear() + "-" +
                    f(this.getUTCMonth() + 1) + "-" +
                    f(this.getUTCDate()) + "T" +
                    f(this.getUTCHours()) + ":" +
                    f(this.getUTCMinutes()) + ":" +
                    f(this.getUTCSeconds()) + "Z"
                : null;
        };
    }

    var gap,
        indent,
        rep;

    // 需转义的控制字符与替换表。用 \uXXXX 写死，避免源码里出现裸控制字符。
    var escapable = new RegExp("[\\\\\\\"\\x00-\\x1f\\x7f-\\x9f\\u00ad\\u0600-\\u0604\\u070f\\u17b4\\u17b5\\u200c-\\u200f\\u2028-\\u202f\\u2060-\\u206f\\ufeff\\ufff0-\\uffff]", "g");
    var replacements = {
        "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r",
        "\"": "\\\"", "\\": "\\\\"
    };

    function quote(string) {
        escapable.lastIndex = 0;
        return escapable.test(string)
            ? "\"" + string.replace(escapable, function (a) {
                var c = replacements[a];
                return typeof c === "string"
                    ? c
                    : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
            }) + "\""
            : "\"" + string + "\"";
    }

    function str(key, holder) {
        var i, k, v, length, mind = gap, partial, value = holder[key];

        if (value && typeof value === "object" && typeof value.toJSON === "function") {
            value = value.toJSON(key);
        }
        if (typeof rep === "function") {
            value = rep.call(holder, key, value);
        }

        switch (typeof value) {
            case "string":
                return quote(value);
            case "number":
                return isFinite(value) ? String(value) : "null";
            case "boolean":
            case "null":
                return String(value);
            case "object":
                if (!value) {
                    return "null";
                }
                gap += indent;
                partial = [];
                if (Object.prototype.toString.apply(value) === "[object Array]") {
                    length = value.length;
                    for (i = 0; i < length; i += 1) {
                        partial[i] = str(i, value) || "null";
                    }
                    v = partial.length === 0
                        ? "[]"
                        : gap
                            ? "[\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "]"
                            : "[" + partial.join(",") + "]";
                    gap = mind;
                    return v;
                }
                if (rep && typeof rep === "object") {
                    length = rep.length;
                    for (i = 0; i < length; i += 1) {
                        if (typeof rep[i] === "string") {
                            k = rep[i];
                            v = str(k, value);
                            if (v) {
                                partial.push(quote(k) + (gap ? ": " : ":") + v);
                            }
                        }
                    }
                } else {
                    for (k in value) {
                        if (Object.prototype.hasOwnProperty.call(value, k)) {
                            v = str(k, value);
                            if (v) {
                                partial.push(quote(k) + (gap ? ": " : ":") + v);
                            }
                        }
                    }
                }
                v = partial.length === 0
                    ? "{}"
                    : gap
                        ? "{\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "}"
                        : "{" + partial.join(",") + "}";
                gap = mind;
                return v;
        }
        return undefined;
    }

    if (typeof JSON.stringify !== "function") {
        JSON.stringify = function (value, replacer, space) {
            var i;
            gap = "";
            indent = "";
            if (typeof space === "number") {
                for (i = 0; i < space; i += 1) {
                    indent += " ";
                }
            } else if (typeof space === "string") {
                indent = space;
            }
            rep = replacer;
            if (replacer && typeof replacer !== "function"
                    && (typeof replacer !== "object" || typeof replacer.length !== "number")) {
                throw new Error("JSON.stringify");
            }
            return str("", { "": value });
        };
    }

    if (typeof JSON.parse !== "function") {
        // 与标准 json2 一致的非法字符过滤。用 \uXXXX 写死，避免裸控制字符。
        var cx = new RegExp("[\\u0000\\u00ad\\u0600-\\u0604\\u070f\\u17b4\\u17b5\\u200c-\\u200f\\u2028-\\u202f\\u2060-\\u206f\\ufeff\\ufff0-\\uffff]", "g");
        var text;
        var reviver;

        function walk(holder, key) {
            var k, v, value = holder[key];
            if (value && typeof value === "object") {
                for (k in value) {
                    if (Object.prototype.hasOwnProperty.call(value, k)) {
                        v = walk(value, k);
                        if (v !== undefined) {
                            value[k] = v;
                        } else {
                            delete value[k];
                        }
                    }
                }
            }
            return reviver.call(holder, key, value);
        }

        JSON.parse = function (textArg, reviverArg) {
            var j;
            text = String(textArg);
            cx.lastIndex = 0;
            if (cx.test(text)) {
                text = text.replace(cx, function (a) {
                    return "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
                });
            }
            // Crockford json2 原版第二阶段：token 白名单校验。分 3 步 replace + 1 步
            // 测试（拆分多步是原版为规避旧 IE/Safari 正则引擎缺陷的写法，逐字保留）：
            // ① JSON 反斜杠对（\" \\ \uXXXX 等）换成 "@"；② 字符串/true/false/null/
            // 数字等简单值 token 换成 "]"；③ 删掉 冒号/逗号/文本开头 之后的开括号。
            // 最后剩余字符只允许是 空白 / ] / , / : / { / }。任何意外形式（()、=、
            // new、裸标识符等）都会使测试失败，从而在进入 new Function 之前拒绝，
            // 杜绝把任意合法 JS 表达式当 JSON 执行。
            if (/^[\],:{}\s]*$/.test(
                    text
                        .replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
                        .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
                        .replace(/(?:^|:|,)(?:\s*\[)+/g, "")
                )) {
                try {
                    // ExtendScript 支持 new Function，用它解析比 eval 安全（隔离作用域）。
                    var parseFn = new Function("return (" + text + ");");
                    j = parseFn();
                } catch (e) {
                    throw new SyntaxError("JSON.parse: " + e.toString());
                }
                if (typeof reviverArg === "function") {
                    reviver = reviverArg;
                    return walk({ "": j }, "");
                }
                return j;
            }
            throw new SyntaxError("JSON");
        };
    }
}());
