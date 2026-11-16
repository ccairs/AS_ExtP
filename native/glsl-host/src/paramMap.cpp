// paramMap.cpp —— uniform → AE 参数索引映射落盘
//
// 输出格式（version=1）：
// {
//   "version": 1,
//   "generated": "<时间戳>",
//   "shaders": {
//     "c:\\...\\effects\\foo.glsl": {
//       "shaderPath": "C:\\...\\effects\\foo.glsl",
//       "shaderName": "foo",
//       "libraryIndex": 0,
//       "signature": { "mtimeMs": 0, "size": 1234, "hash": "<hex>" },
//       "uniforms": [{
//         "name": "uAmount", "type": "float", "slot": 0,
//         "propertyIndex": 5, "diskId": 500,
//         "components": [5,6,7,8], "componentDiskIds": [500,501,502,503],
//         "componentNames": ["uAmount"],
//         "default": [1,0,0,0], "hasDefault": false,
//         "defaultDeclared": [0,0,0,0],
//         "range": { "min": -10, "max": 10, "precision": 2,
//                     "declared": false, "declaredMin": 0, "declaredMax": 1 }
//       }]
//     }
//   }
// }
//
// 字段口径：
//   · propertyIndex / components = params.h 的 5+4*slot+comp（AE 脚本参数索引）
//   · diskId / componentDiskIds = params.h 的 500+4*slot+comp（跨版本稳定键）
//   · default = 宿主实际写入槽位的默认值（params.h ecwDefault4，Float 缺省 1.0 等）
//   · defaultDeclared = GLSL 声明里的初始化器原值（诊断用）
//   · range = 原生滑条量程/精度（params.h slotSliderRange）；declared 表示有 @range
//   · hash = 文件原文 UTF-8 字节的 FNV-1a 32（十六进制 8 位），供面板判映射过期
#include "paramMap.h"
#include "effectState.h"
#include "errorLog.h"
#include "glslLoader.h"
#include "params.h"
#include <windows.h>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <map>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

namespace host {
namespace {

SRWLOCK g_paramMapLock = SRWLOCK_INIT;
// key = 归一化路径（ASCII 折小写、'/'→'\\'），value = 单个 shader 的条目 JSON
std::map<std::string, std::string> g_paramMapEntries;
constexpr std::size_t kMaxParamMapEntries = 128;

std::string normalizePathKey(const std::string& path) {
    std::string s = path;
    for (char& c : s) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
        else if (c == '/') c = '\\';
    }
    while (!s.empty() && s.back() == '\\') s.pop_back();
    return s;
}

void appendJsonEscaped(std::string& out, const std::string& s) {
    out += '"';
    for (unsigned char c : s) {
        switch (c) {
        case '"':  out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n";  break;
        case '\r': out += "\\r";  break;
        case '\t': out += "\\t";  break;
        default:
            if (c < 0x20) {
                char b[8];
                std::snprintf(b, sizeof(b), "\\u%04X", static_cast<unsigned>(c));
                out += b;
            } else {
                out += static_cast<char>(c);   // UTF-8 字节原样透传
            }
        }
    }
    out += '"';
}

void appendJsonNumber(std::string& out, double v) {
    char b[40];
    std::snprintf(b, sizeof(b), "%.9g", v);
    out += b;
}

void appendJsonFloatArray(std::string& out, const float* v, int n) {
    out += '[';
    for (int i = 0; i < n; ++i) {
        if (i) out += ',';
        appendJsonNumber(out, static_cast<double>(v[i]));
    }
    out += ']';
}

const char* typeName(glsl::ParamType t) {
    switch (t) {
    case glsl::ParamType::Vec2: return "vec2";
    case glsl::ParamType::Vec3: return "vec3";
    case glsl::ParamType::Vec4: return "vec4";
    default: return "float";
    }
}

int namedCompCount(const glsl::Param& p) {
    switch (p.type) {
    case glsl::ParamType::Vec2: return 2;
    case glsl::ParamType::Vec3: return 3;
    case glsl::ParamType::Vec4: return 4;
    default: return 1;
    }
}

// 与 plugin.cpp slotCompNameAcp 同口径（分量0 = uniform 名；颜色语义 .g/.b/.a，
// 其余向量 .y/.z/.w）。这里输出 UTF-8 供面板读取；uniform 名是 GLSL 标识符，
// 超不出 ASCII，故不做 ACP 转换（ACP 也装不下 "—" 这类字符）。
std::string componentName(const glsl::Param& p, int comp) {
    if (comp <= 0) return p.name;
    if (comp >= namedCompCount(p)) return std::string();
    static const char* const kColorSuffix[3] = {".g", ".b", ".a"};
    static const char* const kVectorSuffix[3] = {".y", ".z", ".w"};
    const bool colorLike = (p.type == glsl::ParamType::Vec4) || glsl::isColorNamed(p.name);
    const char* const* suffix = colorLike ? kColorSuffix : kVectorSuffix;
    return p.name + suffix[comp - 1];
}

std::string shaderStem(const std::string& path) {
    const std::wstring wpath = glsl::utf8ToWide(path);
    if (wpath.empty()) return std::string();
    return glsl::wideToUtf8(std::filesystem::path(wpath).stem().wstring());
}

unsigned fnv1a32(const std::string& bytes) {
    unsigned h = 2166136261u;
    for (unsigned char c : bytes) {
        h ^= static_cast<unsigned>(c);
        h *= 16777619u;
    }
    return h;
}

void warnParamMapFailureOnce(const char* why) {
    static std::atomic<bool> s_warned{false};
    if (s_warned.exchange(true, std::memory_order_relaxed)) return;
    std::string line = "param-map-write-fail ";
    line += why ? why : "";
    line += "\n";
    rawTraceLine(line.c_str());
}

// 原子落盘：同目录 .tmp → MoveFileEx(REPLACE_EXISTING)。面板可能随时读，
// 直接覆盖会读到半截 JSON（解析失败 → 回落按名寻址，属静默降级，但丢的是
// 本来已经可用的映射）。
bool writeFileAtomicW(const std::wstring& dst, const std::string& bytes) {
    if (dst.empty()) return false;
    const std::wstring tmp = dst + L".tmp";
    HANDLE h = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    const BOOL ok = WriteFile(h, bytes.data(), static_cast<DWORD>(bytes.size()),
                              &written, nullptr);
    CloseHandle(h);
    if (!ok || written != static_cast<DWORD>(bytes.size())) {
        DeleteFileW(tmp.c_str());
        return false;
    }
    if (!MoveFileExW(tmp.c_str(), dst.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(tmp.c_str());
        return false;
    }
    return true;
}

std::string buildEntryJson(const std::string& shaderPath, const std::string& shaderName,
                           int libraryIndex, const std::string& source,
                           const std::vector<glsl::Param>& uniforms) {
    // 文件签名：mtime + size + 内容哈希（源文件读失败时 size 退化为 source 长度）
    unsigned long long fileSize = static_cast<unsigned long long>(source.size());
    unsigned long long mtimeMs = 0;
    const std::wstring wpath = glsl::utf8ToWide(shaderPath);
    if (!wpath.empty()) {
        WIN32_FILE_ATTRIBUTE_DATA fad;
        if (GetFileAttributesExW(wpath.c_str(), GetFileExInfoStandard, &fad)) {
            fileSize = (static_cast<unsigned long long>(fad.nFileSizeHigh) << 32) |
                       static_cast<unsigned long long>(fad.nFileSizeLow);
            ULARGE_INTEGER t;
            t.LowPart = fad.ftLastWriteTime.dwLowDateTime;
            t.HighPart = fad.ftLastWriteTime.dwHighDateTime;
            mtimeMs = t.QuadPart / 10000ull;   // FILETIME 100ns → ms（1601 起算）
        }
    }
    char hashHex[16];
    std::snprintf(hashHex, sizeof(hashHex), "%08x", fnv1a32(source));

    std::string out;
    out.reserve(512 + uniforms.size() * 320);
    out += '{';
    out += "\"shaderPath\":";
    appendJsonEscaped(out, shaderPath);
    out += ",\"shaderName\":";
    appendJsonEscaped(out, shaderName.empty() ? shaderStem(shaderPath) : shaderName);
    out += ",\"libraryIndex\":";
    out += std::to_string(libraryIndex);
    out += ",\"signature\":{\"mtimeMs\":";
    out += std::to_string(mtimeMs);
    out += ",\"size\":";
    out += std::to_string(fileSize);
    out += ",\"hash\":";
    appendJsonEscaped(out, hashHex);
    out += "},\"uniforms\":[";
    for (std::size_t i = 0; i < uniforms.size(); ++i) {
        const glsl::Param& p = uniforms[i];
        if (i) out += ',';
        const int slot = static_cast<int>(i);
        const int comps = namedCompCount(p);
        float dv[4] = {0.0f, 0.0f, 0.0f, 0.0f};
        ecwDefault4(p, dv);
        double lo = 0.0, hi = 0.0;
        int precision = 0;
        slotSliderRange(p, &lo, &hi, &precision);

        out += '{';
        out += "\"name\":";
        appendJsonEscaped(out, p.name);
        out += ",\"type\":";
        appendJsonEscaped(out, typeName(p.type));
        out += ",\"slot\":";
        out += std::to_string(slot);
        out += ",\"propertyIndex\":";
        out += std::to_string(kIdxSlots + slot * kFloatsPerSlot);
        out += ",\"diskId\":";
        out += std::to_string(kSlotCompDiskIdBase + slot * kFloatsPerSlot);

        out += ",\"components\":[";
        for (int c = 0; c < kFloatsPerSlot; ++c) {
            if (c) out += ',';
            out += std::to_string(kIdxSlots + slot * kFloatsPerSlot + c);
        }
        out += ']';
        out += ",\"componentDiskIds\":[";
        for (int c = 0; c < kFloatsPerSlot; ++c) {
            if (c) out += ',';
            out += std::to_string(kSlotCompDiskIdBase + slot * kFloatsPerSlot + c);
        }
        out += ']';
        out += ",\"componentNames\":[";
        for (int c = 0; c < comps; ++c) {
            if (c) out += ',';
            appendJsonEscaped(out, componentName(p, c));
        }
        out += ']';

        out += ",\"default\":";
        appendJsonFloatArray(out, dv, 4);
        out += ",\"hasDefault\":";
        out += (p.hasDef ? "true" : "false");
        out += ",\"defaultDeclared\":";
        appendJsonFloatArray(out, p.def, 4);

        out += ",\"range\":{\"min\":";
        appendJsonNumber(out, lo);
        out += ",\"max\":";
        appendJsonNumber(out, hi);
        out += ",\"precision\":";
        out += std::to_string(precision);
        out += ",\"declared\":";
        out += (p.hasRange ? "true" : "false");
        out += ",\"declaredMin\":";
        appendJsonNumber(out, static_cast<double>(p.rmin));
        out += ",\"declaredMax\":";
        appendJsonNumber(out, static_cast<double>(p.rmax));
        out += "}}";
    }
    out += "]}";
    return out;
}

} // namespace

std::string paramMapDirPath() {
    const std::string root = dataRootDirPath();
    if (root.empty()) return std::string();
    return root + "\\temp\\ae-tools\\param-map";
}

std::string paramMapFilePath() {
    const std::string dir = paramMapDirPath();
    if (dir.empty()) return std::string();
    return dir + "\\index.json";
}

std::size_t paramMapEntryCount() {
    AcquireSRWLockShared(&g_paramMapLock);
    const std::size_t n = g_paramMapEntries.size();
    ReleaseSRWLockShared(&g_paramMapLock);
    return n;
}

bool writeParamMapFile(const std::string& shaderPath, const std::string& shaderName,
                       int libraryIndex, const std::string& source,
                       const std::vector<glsl::Param>& uniforms) {
    if (shaderPath.empty()) return false;
    const std::string dir = paramMapDirPath();
    if (dir.empty()) {
        warnParamMapFailureOnce("data-root-unavailable");
        return false;
    }
    std::error_code ec;
    const std::filesystem::path wdir(glsl::utf8ToWide(dir));
    std::filesystem::create_directories(wdir, ec);
    if (!std::filesystem::exists(wdir, ec)) {
        warnParamMapFailureOnce("mkdir-failed");
        return false;
    }
    const std::filesystem::path dst(glsl::utf8ToWide(paramMapFilePath()));
    if (dst.empty()) {
        warnParamMapFailureOnce("path-unavailable");
        return false;
    }

    int libIdx = libraryIndex;
    const std::string stem = shaderName.empty() ? shaderStem(shaderPath) : shaderName;
    if (libIdx < 0 && !stem.empty()) libIdx = indexForShaderNameNoRescan(stem);

    std::string entry = buildEntryJson(shaderPath, stem, libIdx, source, uniforms);
    const std::string key = normalizePathKey(shaderPath);

    // 合并 + 序列化 + 落盘在同一把锁内：写文件本身是毫秒级，调用点只在
    // 载入/切换（非逐帧）；用锁换"不会有两个写者用旧快照覆盖新条目"。
    AcquireSRWLockExclusive(&g_paramMapLock);
    g_paramMapEntries[key] = std::move(entry);
    if (g_paramMapEntries.size() > kMaxParamMapEntries) {
        auto it = g_paramMapEntries.begin();
        if (it->first == key) ++it;   // 不淘汰刚写入的条目
        if (it != g_paramMapEntries.end()) g_paramMapEntries.erase(it);
    }
    std::string doc;
    doc.reserve(256 + g_paramMapEntries.size() * 1024);
    doc += "{\"version\":1,\"generated\":";
    char stamp[24] = {0};
    isoLocalStamp(stamp, sizeof(stamp));
    size_t stampLen = std::strlen(stamp);
    while (stampLen > 0 && (stamp[stampLen - 1] == ' ' || stamp[stampLen - 1] == '\t')) {
        stamp[--stampLen] = '\0';
    }
    appendJsonEscaped(doc, stamp);
    doc += ",\"shaders\":{";
    bool first = true;
    for (const auto& kv : g_paramMapEntries) {
        if (!first) doc += ',';
        first = false;
        appendJsonEscaped(doc, kv.first);
        doc += ':';
        doc += kv.second;
    }
    doc += "}}\n";
    const bool ok = writeFileAtomicW(dst.wstring(), doc);
    ReleaseSRWLockExclusive(&g_paramMapLock);
    if (ok) {
        // 成功只记首行（真机验证用）：文件内容本身是权威，这行只是让 trace 能
        // 回答"宿主到底写过没有"，不必逐个 shader 刷屏。
        static std::atomic<bool> s_successLogged{false};
        if (!s_successLogged.exchange(true, std::memory_order_relaxed)) {
            std::string line = "param-map-ok entries=";
            line += std::to_string(paramMapEntryCount());
            line += " file=";
            line += paramMapFilePath();
            line += "\n";
            rawTraceLine(line.c_str());
        }
    } else {
        warnParamMapFailureOnce("write-failed");
    }
    return ok;
}

} // namespace host
