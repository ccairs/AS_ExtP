// json.h — 极简 JSON 解析器（够用即可：对象/数组/字符串/数字/布尔/null）
#pragma once
#include <string>
#include <vector>

namespace json {

struct Value {
    enum Type { kNull, kBool, kNumber, kString, kArray, kObject } type = kNull;
    bool b = false;
    double num = 0.0;
    std::string str;
    std::vector<Value> arr;
    std::vector<std::pair<std::string, Value>> obj;

    const Value& operator[](const std::string& key) const;
    const Value& operator[](size_t i) const;
    size_t size() const { return type == kArray ? arr.size() : (type == kObject ? obj.size() : 0); }
};

bool parse(const char* data, size_t len, Value* out);

std::string buildString(const std::string& s);

} // namespace json
