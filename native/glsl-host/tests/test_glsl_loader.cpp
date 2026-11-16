// Release 构建（/DNDEBUG）会把 assert 编译为空操作——断言须保持生效
#undef NDEBUG
#include <cassert>
#include <iostream>
#include "glslLoader.h"
#include "test_util.h"

// 用真实临时文件验证内容比对的热重载行为（临时文件统一放 temp/，见 test_util.h）
static void test_hot_reload() {
    const std::string path = glsltest::tempPath("test_effect_reload.glsl");
    glsltest::writeFile(path, "void main() {}\n");
    glsl::FileWatcher w;
    w.setPath(path);
    assert(w.needsReload());          // 首次：文件非空 → true
    assert(!w.needsReload());         // 未变化 → false
    // 快速重写（无 sleep）：mtime 粒度盲区下的漏检场景，内容比对必须检测到
    glsltest::writeFile(path, "void main() { gl_FragColor = vec4(1.0); }\n");
    assert(w.needsReload());          // 内容变化 → true
    assert(!w.needsReload());         // 再次 → false
    std::cout << "PASS test_hot_reload\n";
}

// 写盘截断窗口（文件瞬时 0 字节）下空读不消费状态，写入内容后仍能检测到（自愈）
static void test_empty_read_self_heal() {
    const std::string path = glsltest::tempPath("test_effect_empty.glsl");
    glsltest::writeFile(path, "");   // 空文件：等价于写盘截断窗口的读空
    glsl::FileWatcher w;
    w.setPath(path);
    assert(!w.needsReload());         // 空读 → 不重载，且不消费状态
    glsltest::writeFile(path, "void main() {}\n");
    assert(w.needsReload());          // 写入内容后仍能检测到
    std::cout << "PASS test_empty_read_self_heal\n";
}

static void test_missing_file() {
    glsl::FileWatcher w;
    w.setPath("no_such_file.glsl");
    assert(!w.needsReload());         // 文件不存在 → false
    std::cout << "PASS test_missing_file\n";
}

static void test_read_file() {
    const std::string path = glsltest::tempPath("test_effect_read.glsl");
    glsltest::writeFile(path, "uniform float uA;\nvoid main() {}\n");
    std::string s = glsl::readFile(path);
    assert(s.find("uA") != std::string::npos);
    // 不存在的文件返回空串
    assert(glsl::readFile("no_such_read.glsl").empty());
    std::cout << "PASS test_read_file\n";
}

void runGlslLoaderTests() {
    test_hot_reload();
    test_empty_read_self_heal();
    test_missing_file();
    test_read_file();
    std::cout << "ALL glsl loader tests passed\n";
}
