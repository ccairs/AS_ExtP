// json.cpp — 极简递归下降 JSON 解析器
#include "json.h"
#include <cctype>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace json {

const Value& Value::operator[](const std::string& key) const {
    static const Value kMissing;
    if (type != kObject) return kMissing;
    for (const auto& kv : obj) if (kv.first == key) return kv.second;
    return kMissing;
}
const Value& Value::operator[](size_t i) const {
    static const Value kMissing;
    if (type != kArray || i >= arr.size()) return kMissing;
    return arr[i];
}

namespace {

struct Parser {
    const char* p;
    const char* end;
    // 递归深度上限：防深嵌套输入（恶意/损坏 JSON）递归下降栈溢出崩掉宿主进程。
    // 正常配置文件嵌套 <10 层，64 层留足余量。
    int depth = 0;
    static const int kMaxDepth = 64;

    void skipWs() { while (p < end && std::isspace((unsigned char)*p)) ++p; }
    bool eof() { return p >= end; }

    bool parseValue(Value* out) {
        skipWs();
        if (eof()) return false;
        switch (*p) {
            case '{': return parseObject(out);
            case '[': return parseArray(out);
            case '"': return parseString(out);
            case 't': return parseLiteral("true", out, Value::kBool, true);
            case 'f': return parseLiteral("false", out, Value::kBool, false);
            case 'n': return parseLiteral("null", out, Value::kNull, false);
            default:  return parseNumber(out);
        }
    }
    bool parseLiteral(const char* lit, Value* out, Value::Type t, bool b) {
        size_t n = std::char_traits<char>::length(lit);
        if (static_cast<size_t>(end - p) < n || std::memcmp(p, lit, n) != 0) return false;
        p += n;
        out->type = t;
        out->b = b;
        return true;
    }

    bool parseString(Value* out) {
        if (*p != '"') return false;
        ++p;
        std::string s;
        while (p < end) {
            char c = *p++;
            if (c == '"') { out->type = Value::kString; out->str = std::move(s); return true; }
            if (c == '\\') {
                if (p >= end) return false;
                char e = *p++;
                switch (e) {
                    case '"': s += '"'; break;
                    case '\\': s += '\\'; break;
                    case '/': s += '/'; break;
                    case 'b': s += '\b'; break;
                    case 'f': s += '\f'; break;
                    case 'n': s += '\n'; break;
                    case 'r': s += '\r'; break;
                    case 't': s += '\t'; break;
                    case 'u': {
                        if (end - p < 4) return false;
                        unsigned cp = 0;
                        for (int i = 0; i < 4; ++i) {
                            char h = p[i];
                            cp <<= 4;
                            if (h >= '0' && h <= '9') cp |= (unsigned)(h - '0');
                            else if (h >= 'a' && h <= 'f') cp |= (unsigned)(h - 'a' + 10);
                            else if (h >= 'A' && h <= 'F') cp |= (unsigned)(h - 'A' + 10);
                            else return false;
                        }
                        p += 4;
                        // 代理对：\uD800-\uDBFF 后跟 \uDC00-\uDFFF → 合并为 0x10000 以上
                        // 码点（4 字节 UTF-8）。JSON.stringify 对非 BMP 字符（emoji 等）
                        // 就输出这种形式，不合并会得到非法 CESU-8（显示乱码）。
                        // 孤立代理保持原 3 字节行为（向后兼容）。
                        if (cp >= 0xD800 && cp <= 0xDBFF && end - p >= 6 &&
                            p[0] == '\\' && p[1] == 'u') {
                            unsigned lo = 0;
                            bool loOk = true;
                            for (int i = 0; i < 4; ++i) {
                                char h = p[2 + i];
                                lo <<= 4;
                                if (h >= '0' && h <= '9') lo |= (unsigned)(h - '0');
                                else if (h >= 'a' && h <= 'f') lo |= (unsigned)(h - 'a' + 10);
                                else if (h >= 'A' && h <= 'F') lo |= (unsigned)(h - 'A' + 10);
                                else { loOk = false; break; }
                            }
                            if (loOk && lo >= 0xDC00 && lo <= 0xDFFF) {
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                                p += 6;
                            }
                        }
                        if (cp < 0x80) s += (char)cp;
                        else if (cp < 0x800) { s += (char)(0xC0 | (cp >> 6)); s += (char)(0x80 | (cp & 0x3F)); }
                        else if (cp < 0x10000) { s += (char)(0xE0 | (cp >> 12)); s += (char)(0x80 | ((cp >> 6) & 0x3F)); s += (char)(0x80 | (cp & 0x3F)); }
                        else { s += (char)(0xF0 | (cp >> 18)); s += (char)(0x80 | ((cp >> 12) & 0x3F)); s += (char)(0x80 | ((cp >> 6) & 0x3F)); s += (char)(0x80 | (cp & 0x3F)); }
                        break;
                    }
                    default: return false;
                }
            } else {
                if ((unsigned char)c < 0x20) return false;
                s += c;
            }
        }
        return false;
    }

    bool parseNumber(Value* out) {
        const char* start = p;
        if (p < end && *p == '-') ++p;
        if (p >= end || !std::isdigit((unsigned char)*p)) return false;   // 符号后必须有数字
        while (p < end && std::isdigit((unsigned char)*p)) ++p;
        if (p < end && *p == '.') {
            ++p;
            if (p >= end || !std::isdigit((unsigned char)*p)) return false; // 小数点后必须有数字
            while (p < end && std::isdigit((unsigned char)*p)) ++p;
        }
        if (p < end && (*p == 'e' || *p == 'E')) {
            ++p;
            if (p < end && (*p == '+' || *p == '-')) ++p;
            if (p >= end || !std::isdigit((unsigned char)*p)) return false; // 指数必须有数字
            while (p < end && std::isdigit((unsigned char)*p)) ++p;
        }
        out->type = Value::kNumber;
        // strtod 溢出防护——1e999 等超范围输入返回 ±HUGE_VAL（inf）并置
        // errno=ERANGE，非有限值流入下游的 double→int 转换（如 config 的
        // mods/vk）是 UB；按解析失败处理（调用方回退默认/空态）
        errno = 0;
        double d = std::strtod(start, nullptr);
        if (errno == ERANGE || !std::isfinite(d)) return false;
        out->num = d;
        return true;
    }

    bool parseObject(Value* out) {
        if (depth >= kMaxDepth) return false;
        ++depth;
        ++p;
        out->type = Value::kObject;
        skipWs();
        if (!eof() && *p == '}') { --depth; ++p; return true; }
        while (true) {
            skipWs();
            if (eof() || *p != '"') { --depth; return false; }
            Value key;
            if (!parseString(&key)) { --depth; return false; }
            skipWs();
            if (eof() || *p != ':') { --depth; return false; }
            ++p;
            Value val;
            if (!parseValue(&val)) { --depth; return false; }
            out->obj.emplace_back(key.str, std::move(val));
            skipWs();
            if (eof()) { --depth; return false; }
            if (*p == ',') { ++p; continue; }
            if (*p == '}') { --depth; ++p; return true; }
            --depth;
            return false;
        }
    }

    bool parseArray(Value* out) {
        if (depth >= kMaxDepth) return false;
        ++depth;
        ++p;
        out->type = Value::kArray;
        skipWs();
        if (!eof() && *p == ']') { --depth; ++p; return true; }
        while (true) {
            Value val;
            if (!parseValue(&val)) { --depth; return false; }
            out->arr.push_back(std::move(val));
            skipWs();
            if (eof()) { --depth; return false; }
            if (*p == ',') { ++p; continue; }
            if (*p == ']') { --depth; ++p; return true; }
            --depth;
            return false;
        }
    }
};

} // namespace

bool parse(const char* data, size_t len, Value* out) {
    if (!data || !out) return false;
    Parser ps{ data, data + len };
    if (!ps.parseValue(out)) return false;
    ps.skipWs();
    return ps.eof();
}

std::string buildString(const std::string& s) {
    std::string out = "\"";
    for (size_t i = 0; i < s.size(); ++i) {
        // U+2028/U+2029（UTF-8 三字节 \xE2\x80\xA8/\xE2\x80\xA9）：ES3 行终止符，
        // 出现在字符串字面量内即 SyntaxError（经 buildString 拼入脚本的脚本内容/
        // 效果名含此字符会让 AEGP_ExecuteScript 解析失败）。与 host 侧 json2.jsx
        // 的 escapable 集合对齐，输出 \u2028/\u2029；其余多字节序列原样透传。
        // UTF-8 自同步性保证 0xE2 只能作为码点首字节出现，不会误伤其他中文字符。
        if (i + 2 < s.size() && (unsigned char)s[i] == 0xE2 && (unsigned char)s[i + 1] == 0x80 &&
            ((unsigned char)s[i + 2] == 0xA8 || (unsigned char)s[i + 2] == 0xA9)) {
            out += ((unsigned char)s[i + 2] == 0xA8) ? "\\u2028" : "\\u2029";
            i += 2;
            continue;
        }
        char c = s[i];
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if ((unsigned char)c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", (unsigned)(unsigned char)c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    out += "\"";
    return out;
}

} // namespace json
