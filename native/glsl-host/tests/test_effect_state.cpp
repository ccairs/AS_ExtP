// Release 构建（/DNDEBUG）会把 assert 编译为空操作——断言须保持生效
#undef NDEBUG
#include <cassert>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include "effectState.h"
#include "errorLog.h"     // 告警代际测试用 readErrorLog/clearErrorLog
#include "test_util.h"

// —— N1 回归测试：per-file 条目缓存（多实例不同 .glsl 互不串扰）——
// 把 effectSource/uniforms 挂在进程级单例时：先取 A 再取 B 会把 A 的
// uniforms 覆盖掉。新实现按文件路径各自缓存，交替访问互不影响。

// 测试临时文件统一放 temp/ 子目录（直接写 cwd 会让产物散落仓库根目录
// 污染工作区），见 test_util.h
static const std::string kFileA = glsltest::tempPath("test_state_a.glsl");
static const std::string kFileB = glsltest::tempPath("test_state_b.glsl");

static void writeFile(const std::string& path, const std::string& content) {
    std::ofstream f(path, std::ios::binary);
    f << content;
}

// 首次加载：源码/uniforms/告警进条目，reloaded=true，uniformsChanged=true
// （空列表 → 解析出非空列表，与旧 reloadEffectFile 的比较语义一致）
static void test_first_load() {
    writeFile(kFileA, "uniform float uA;\nvoid main() {}\n");
    host::ShaderSnapshot s = host::getShaderForPath(kFileA, true);
    assert(s.path == kFileA);
    assert(s.source.find("uA") != std::string::npos);
    assert(s.uniforms.size() == 1);
    assert(s.uniforms[0].name == "uA");
    assert(s.uniforms[0].type == glsl::ParamType::Float);
    assert(s.reloaded);
    assert(s.uniformsChanged);
    std::cout << "PASS test_first_load\n";
}

// 二次获取：内容未变 → 不重载（watcher 快路径）
static void test_no_reload_when_unchanged() {
    host::getShaderForPath(kFileA, true);
    host::ShaderSnapshot s = host::getShaderForPath(kFileA, true);
    assert(!s.reloaded);
    assert(!s.uniformsChanged);
    std::cout << "PASS test_no_reload_when_unchanged\n";
}

// 热重载：内容变化（新增 uniform）→ 重读 + uniformsChanged
static void test_hot_reload() {
    writeFile(kFileA, "uniform float uA;\nuniform vec3 uB;\nvoid main() {}\n");
    host::ShaderSnapshot s = host::getShaderForPath(kFileA, true);
    assert(s.reloaded);
    assert(s.uniformsChanged);
    assert(s.uniforms.size() == 2);
    assert(s.uniforms[1].name == "uB");
    assert(s.uniforms[1].type == glsl::ParamType::Vec3);
    std::cout << "PASS test_hot_reload\n";
}

// N1 核心：两个不同文件交替访问，uniforms 各自独立、互不覆盖
static void test_multi_file_no_crosstalk() {
    writeFile(kFileA, "uniform float uA;\nvoid main() {}\n");
    writeFile(kFileB, "uniform vec3 uZ;\nuniform float uY;\nvoid main() {}\n");
    // 模拟两实例交替渲染/绘制：A、B、A、B
    for (int i = 0; i < 2; ++i) {
        host::ShaderSnapshot sa = host::getShaderForPath(kFileA, true);
        host::ShaderSnapshot sb = host::getShaderForPath(kFileB, true);
        assert(sa.uniforms.size() == 1);
        assert(sa.uniforms[0].name == "uA");
        assert(sa.uniforms[0].type == glsl::ParamType::Float);
        assert(sb.uniforms.size() == 2);
        assert(sb.uniforms[0].name == "uZ");
        assert(sb.uniforms[0].type == glsl::ParamType::Vec3);
        assert(sb.uniforms[1].name == "uY");
        assert(sa.source.find("uA") != std::string::npos);
        assert(sb.source.find("uZ") != std::string::npos);
    }
    std::cout << "PASS test_multi_file_no_crosstalk\n";
}

// 逐槽访问（ECW 绘制路径）：不同文件同槽位得到各自的 uniform
static void test_uniform_at_per_file() {
    glsl::Param pa, pb;
    assert(host::shaderUniformAt(kFileA, 0, &pa));
    assert(host::shaderUniformAt(kFileB, 0, &pb));
    assert(pa.name == "uA");
    assert(pa.type == glsl::ParamType::Float);
    assert(pb.name == "uZ");
    assert(pb.type == glsl::ParamType::Vec3);
    // 槽位越界 → false
    assert(!host::shaderUniformAt(kFileA, 1, &pa));
    assert(!host::shaderUniformAt(kFileA, -1, &pa));
    // 空路径 → false
    assert(!host::shaderUniformAt("", 0, &pa));
    std::cout << "PASS test_uniform_at_per_file\n";
}

// 惰性加载：未经过 getShaderForPath 的文件，shaderUniformAt 直接读文件
static void test_uniform_at_lazy_load() {
    const std::string path = glsltest::tempPath("test_state_lazy.glsl");
    writeFile(path, "uniform vec2 uLazy;\nvoid main() {}\n");
    glsl::Param p;
    assert(host::shaderUniformAt(path, 0, &p));
    assert(p.name == "uLazy");
    assert(p.type == glsl::ParamType::Vec2);
    std::cout << "PASS test_uniform_at_lazy_load\n";
}

// 缺失文件：path 回填但 source 空（渲染走透传语义）
static void test_missing_file() {
    host::ShaderSnapshot s = host::getShaderForPath("no_such_state.glsl", true);
    assert(s.path == "no_such_state.glsl");
    assert(s.source.empty());
    assert(s.uniforms.empty());
    assert(!s.reloaded);
    // 空路径快照全空
    host::ShaderSnapshot empty = host::getShaderForPath("", true);
    assert(empty.path.empty());
    assert(empty.source.empty());
    std::cout << "PASS test_missing_file\n";
}

// 结构签名：setEntrySignature 写入后快照可见（loadEffectFile 预置/SyncParamUI 回写）
static void test_entry_signature() {
    host::ShaderSnapshot s = host::getShaderForPath(kFileA, true);
    const std::string sig = host::uniformSignature(s.uniforms);
    host::setEntrySignature(kFileA, sig);
    host::ShaderSnapshot s2 = host::getShaderForPath(kFileA, true);
    assert(s2.uiSignature == sig);
    // 签名格式："type|name;..."（Float=0）
    assert(sig == "0|uA;");
    // 不存在的条目写入无效果（不崩溃）
    host::setEntrySignature("no_such_entry.glsl", "x");
    std::cout << "PASS test_entry_signature\n";
}

// —— SyncParamUI「结构签名」判定基线回归（切文件后 ECW 反复重建的定位）——
// SyncParamUI 用 `uniformSignature(快照.uniforms) != 快照.uiSignature` 决定是否
// forceRedraw（重建槽位行）。若签名读写的 key 不一致（如 getShaderForIndex 的
// snap.path 与 setEntrySignature 用的路径大小写/分隔符/盘符不同），每次比对都会
// 判「结构变化」→ 逐帧 PF_UpdateParamUI → AE 反复重建 ECW。
// 本测试钉死两条契约：①同一文件反复取快照，写入后的签名恒稳定（无逐帧漂移/重置）；
// ②不同文件各持自己的签名（per-file 条目 key = 绝对路径，互不串扰）。
static void test_entry_signature_stable_across_snapshots() {
    const std::string fa = glsltest::tempPath("test_state_sig_a.glsl");
    const std::string fb = glsltest::tempPath("test_state_sig_b.glsl");
    writeFile(fa, "uniform float uA;\nuniform vec3 uB;\nvoid main() {}\n");
    writeFile(fb, "uniform vec2 uOnly;\nvoid main() {}\n");
    // ① 首次：条目签名空 → 首次同步会判一次「结构变化」（预期：切文件只这一次）
    host::ShaderSnapshot a0 = host::getShaderForPath(fa, true);
    assert(a0.path == fa);                 // snap.path 即 fileCache key
    assert(a0.uiSignature.empty());
    const std::string sigA = host::uniformSignature(a0.uniforms);
    host::setEntrySignature(a0.path, sigA);
    // 反复取快照（模拟 ECW 打开期逐帧 UPDATE_PARAMS_UI）：签名恒等于写入值
    for (int i = 0; i < 8; ++i) {
        host::ShaderSnapshot a = host::getShaderForPath(fa, true);
        assert(a.uiSignature == sigA);
        assert(host::uniformSignature(a.uniforms) == a.uiSignature);   // 比对恒相等 → 不再 forceRedraw
    }
    // ② per-file 隔离：写 B 的签名不影响 A；两文件签名各自独立
    host::ShaderSnapshot b = host::getShaderForPath(fb, true);
    const std::string sigB = host::uniformSignature(b.uniforms);
    assert(sigB != sigA);
    host::setEntrySignature(fb, sigB);
    assert(host::getShaderForPath(fb, true).uiSignature == sigB);
    assert(host::getShaderForPath(fa, true).uiSignature == sigA);   // A 不受 B 影响
    std::cout << "PASS test_entry_signature_stable_across_snapshots\n";
}

// —— 数据根目录解析缓存（生效/失效/回退）——
// dataRootDirPath 全程无缓存时，每帧渲染 + 每 ECW 控件 DRAW 各读一次
// data-dir.txt（I/O 风暴）。新实现 FileWatcher 缓存：指针文件属性未变走零
// 读盘快路径，内容变化立即失效重读。用可控的临时默认根覆盖 resolveDataRoot。
static void test_data_root_cache() {
    // 临时默认根放 temp/ 下（直接建在工作目录会散落仓库根目录）
    const std::string dir = glsltest::tempPath("test_nv3_data_root");
    const std::string ptrFile = dir + "\\data-dir.txt";
    std::filesystem::create_directories(dir);
    auto writePtr = [&](const char* content) {
        std::ofstream f(ptrFile, std::ios::binary);
        f << content;
    };
    // ① 首次：指针文件缺失 → 回退默认根
    std::remove(ptrFile.c_str());
    assert(host::resolveDataRoot(dir) == dir);
    // ② 写入合法自定义根 → 属性变化立即失效重读（缓存"生效"后修改即感知）
    writePtr("D:\\nv3_custom_root");
    assert(host::resolveDataRoot(dir) == "D:\\nv3_custom_root");
    // ③ 内容未变：重复调用返回缓存值（快路径，不重读不改判）
    assert(host::resolveDataRoot(dir) == "D:\\nv3_custom_root");
    // ④ 内容变化 → 缓存失效，重读生效（长度不同保证 stat 快路径命中）
    writePtr("E:\\nv3_other_root_x");
    assert(host::resolveDataRoot(dir) == "E:\\nv3_other_root_x");
    // ⑤ 非法路径（系统目录，isSafeDataRoot 拒绝）→ 回退默认根
    // （长度须与④不同：watcher stat 快路径按 size+mtime 判变化，连续两次同长度
    //  写入且 mtime 粒度内未推进时，变化会被快路径整段吞掉——本测试曾因此
    //  偶发挂在本断言，5 连跑 4 败；④/⑥/⑦ 各写长度本就互异，唯⑤遗漏）
    writePtr("C:\\Windows\\System32\\drivers");
    assert(host::resolveDataRoot(dir) == dir);
    // ⑥ 删除/清空（自定义根生效状态下）→ 回退默认根。回归修复：watcher 的
    // 空读不消费状态（防截窗），曾使缓存永久锁定旧自定义根；旧断言在⑤已回
    // 退默认后才写空文件，属顺序假阳性，未覆盖真实场景
    writePtr("F:\\nv3_root_a");   // 长度与⑤内容不同，保证 stat 快路径失效
    assert(host::resolveDataRoot(dir) == "F:\\nv3_root_a");
    std::remove(ptrFile.c_str());   // 删除文件
    assert(host::resolveDataRoot(dir) == dir);
    writePtr("G:\\nv3_root_bb");  // 清空前先回到自定义根（长度与 F 不同）
    assert(host::resolveDataRoot(dir) == "G:\\nv3_root_bb");
    writePtr("");                    // 文件存在但内容为空
    assert(host::resolveDataRoot(dir) == dir);
    // ⑦ 文件重建（与删除前同内容）→ 自定义根再生效（watcher 重置后强制重读，
    // hasSeen_ 快路径不吞重建事件）
    writePtr("F:\\nv3_root_a");
    assert(host::resolveDataRoot(dir) == "F:\\nv3_root_a");
    // 清理临时目录（缓存条目随进程退出，无残留影响）
    std::error_code ec;
    std::filesystem::remove_all(dir, ec);
    std::cout << "PASS test_data_root_cache\n";
}

// —— 映射图层（iChannel1/2/3）：channelsUsed 进快照 + 热重载更新 ——
// ShaderFileEntry/ShaderSnapshot 增加 channelsUsed，
// 两条加载路径（checkReload 与惰性）均与 parseUniforms 并行调用 parseSamplerChannels。
static void test_channels_used_snapshot_and_reload() {
    const std::string path = glsltest::tempPath("test_state_chan.glsl");
    // 首次加载（checkReload 路径）：声明进快照
    writeFile(path, "uniform sampler2D iChannel1;\nuniform float uA;\nvoid main() {}\n");
    host::ShaderSnapshot s = host::getShaderForPath(path, true);
    assert(s.channelsUsed == 0x1);
    // 热重载：换成 iChannel2 + iChannel3 → bitmask 更新（长度不同保证 watcher 检出）
    writeFile(path, "uniform sampler2D iChannel2;\nuniform sampler2D iChannel3;\nvoid main() {}\n");
    s = host::getShaderForPath(path, true);
    assert(s.reloaded);
    assert(s.channelsUsed == 0x6);
    // 再热重载：全部删掉 → 归零
    writeFile(path, "uniform float uOnly;\nvoid main() {}\n");
    s = host::getShaderForPath(path, true);
    assert(s.reloaded);
    assert(s.channelsUsed == 0x0);
    std::cout << "PASS test_channels_used_snapshot_and_reload\n";
}

// 惰性加载路径（ensureEntryLoaded）同样填充 channelsUsed
static void test_channels_used_lazy_load() {
    const std::string path = glsltest::tempPath("test_state_chan_lazy.glsl");
    writeFile(path, "uniform sampler2D iChannel3;\nuniform vec2 uB;\nvoid main() {}\n");
    // 不经 getShaderForPath 的 checkReload，直接 shaderUniformAt 触发惰性加载
    glsl::Param p;
    assert(host::shaderUniformAt(path, 0, &p));
    assert(p.name == "uB");
    // 惰性加载后快照透出 channelsUsed
    host::ShaderSnapshot s = host::getShaderForPath(path, false);
    assert(!s.reloaded);
    assert(s.channelsUsed == 0x4);
    std::cout << "PASS test_channels_used_lazy_load\n";
}

// 非法命名采样器告警并入 parseWarning（error.log 可见）
static void test_sampler_warning_into_snapshot() {
    const std::string path = glsltest::tempPath("test_state_chan_warn.glsl");
    writeFile(path, "uniform sampler2D uMyTex;\nuniform float uA;\nvoid main() {}\n");
    host::ShaderSnapshot s = host::getShaderForPath(path, true);
    assert(s.channelsUsed == 0x0);
    assert(s.parseWarning.find("uMyTex") != std::string::npos);
    std::cout << "PASS test_sampler_warning_into_snapshot\n";
}

// 多文件隔离：不同文件的 channelsUsed 各自独立（per-file 缓存）
static void test_channels_used_per_file() {
    const std::string fa = glsltest::tempPath("test_state_chan_a.glsl");
    const std::string fb = glsltest::tempPath("test_state_chan_b.glsl");
    writeFile(fa, "uniform sampler2D iChannel1;\nvoid main() {}\n");
    writeFile(fb, "uniform sampler2D iChannel2;\nuniform sampler2D iChannel3;\nvoid main() {}\n");
    for (int i = 0; i < 2; ++i) {   // 交替访问互不覆盖
        host::ShaderSnapshot sa = host::getShaderForPath(fa, true);
        host::ShaderSnapshot sb = host::getShaderForPath(fb, true);
        assert(sa.channelsUsed == 0x1);
        assert(sb.channelsUsed == 0x6);
    }
    std::cout << "PASS test_channels_used_per_file\n";
}

// ── renderConsumePending 补消费限定渲染路径 ——
// UI 调用方（forRender=false，对应 SyncParamUI/handleFileSelectorClick）不得
// 吃掉补确认标记——任意 checkReload 调用方都能消费时，UI 抢先吃掉后渲染
// 路径永远等不到 reloaded=true，「重载成功即清 error.log」漏执行（诊断延迟）。
static void test_render_consume_pending_render_only() {
    const std::string path = glsltest::tempPath("test_state_r12nv9.glsl");
    writeFile(path, "uniform float uA;\nvoid main() {}\n");
    // 首次加载（真实重载）→ renderConsumePending 置位（补确认标记）
    host::ShaderSnapshot s = host::getShaderForPath(path, true);
    assert(s.reloaded);
    // UI 调用方：不得消费补确认标记（reloaded=false，标记保留给渲染路径）
    host::ShaderSnapshot ui = host::getShaderForPath(path, true, /*forRender=*/false);
    assert(!ui.reloaded);
    // 连续多次 UI 调用（模拟 ECW 打开时 UPDATE_PARAMS_UI 逐帧触发）：标记仍不被吃掉
    host::ShaderSnapshot ui2 = host::getShaderForPath(path, true, /*forRender=*/false);
    assert(!ui2.reloaded);
    // 渲染调用方：消费标记（reloaded=true，用于执行「重载成功即清」）
    host::ShaderSnapshot rd = host::getShaderForPath(path, true, /*forRender=*/true);
    assert(rd.reloaded);
    // 标记已消费：再次渲染调用不再补 reloaded（幂等，仅补一次）
    host::ShaderSnapshot rd2 = host::getShaderForPath(path, true, /*forRender=*/true);
    assert(!rd2.reloaded);
    std::cout << "PASS test_render_consume_pending_render_only\n";
}

// —— 方案③ 槽位索引边界（slotCompIndex / slotParamIndex / slotFromIndex）——
// 布局：分量 c 的索引 = 5 + 4i + c（i=0..31，c=0..3）；slotFromIndex 仅映射分量0
// （可见行），隐藏分量与非槽位参数返回 -1（handleDraw/handleClick 据此走 AE 默认）。
static void test_slot_index_boundaries() {
    // 分量索引：首槽分量0 / 末槽分量3
    assert(host::slotCompIndex(0, 0) == 5);
    assert(host::slotCompIndex(31, 3) == 132);
    // slotParamIndex(i) == slotCompIndex(i, 0)（32 槽全覆盖）
    for (int i = 0; i < host::kMaxParams; ++i) {
        assert(host::slotParamIndex(i) == host::slotCompIndex(i, 0));
    }
    // 索引 → 槽位：仅分量0（5,9,…,129）映射为槽位
    assert(host::slotFromIndex(5) == 0);
    assert(host::slotFromIndex(129) == 31);
    // 隐藏分量（6 = 槽0 分量1）与非槽位参数（133 = 「参数」组 END）返回 -1
    assert(host::slotFromIndex(6) == -1);
    assert(host::slotFromIndex(133) == -1);
    // 越界入参返回 -1
    assert(host::slotCompIndex(-1, 0) == -1);
    assert(host::slotCompIndex(host::kMaxParams, 0) == -1);
    assert(host::slotCompIndex(0, -1) == -1);
    assert(host::slotCompIndex(0, host::kFloatsPerSlot) == -1);
    assert(host::slotParamIndex(-1) == -1);
    assert(host::slotParamIndex(host::kMaxParams) == -1);
    assert(host::slotFromIndex(-1) == -1);
    assert(host::slotFromIndex(0) == -1);                                        // kIdxFileGroupStart
    assert(host::slotFromIndex(4) == -1);                                        // kIdxGroupStart
    assert(host::slotFromIndex(host::kIdxSlots + host::kSlotsSpan) == -1);       // 133
    std::cout << "PASS test_slot_index_boundaries\n";
}

// —— 滑条量程与"有效输入范围"分离（params.h slotSliderRange）——
// 滑条量程与 valid_min/max 共用 ±1e9（见 plugin.cpp addSlot）时，
// 导致 AE 原生参数对话框显示"滑块范围 -1000000000 至 1000000000"，且整条滑条宽度
// 映射 ±1e9（1px ≈ 1e7）、PF_FpShort 在 1e9 量级分辨率仅约 64 —— 微调无从谈起。
static void test_slot_slider_range() {
    glsl::Param p;
    p.type = glsl::ParamType::Float;
    p.name = "uAmount";
    double lo = 0.0, hi = 0.0;
    int prec = 0;

    // ① 通用标量/向量 → -10..10；跨度 20（>2 且 ≤100）→ 精度 2
    host::slotSliderRange(p, &lo, &hi, &prec);
    assert(lo == -10.0 && hi == 10.0);
    assert(prec == 2);

    // ② 颜色语义：vec4 恒颜色（与 customUI kindFor / 分量后缀分流同口径）→ 0..1
    p.type = glsl::ParamType::Vec4;
    p.name = "uTint";
    host::slotSliderRange(p, &lo, &hi, &prec);
    assert(lo == 0.0 && hi == 1.0);
    assert(prec == 3);                                // 跨度 1 ≤ 2
    // 颜色语义：名字含 color 的 vec3 → 0..1
    p.type = glsl::ParamType::Vec3;
    p.name = "uColorTint";
    host::slotSliderRange(p, &lo, &hi, &prec);
    assert(lo == 0.0 && hi == 1.0);

    // ③ 角度语义（词干派生同 isAngleNamed）→ -360..360；跨度 720 > 100 → 精度 1
    const char* angleNames[] = {"uAngle", "rotation", "uRot", "rotSpeed",
                                "uDeg", "degrees", "degToRad", "angleDeg"};
    for (const char* n : angleNames) {
        p.type = glsl::ParamType::Float;
        p.name = n;
        host::slotSliderRange(p, &lo, &hi, &prec);
        assert(lo == -360.0 && hi == 360.0);
        assert(prec == 1);
    }

    // ④ 非角度/非颜色的词干误报不成立（proton 的 "rot"、triangle 的 "angle"）
    p.name = "proton";
    host::slotSliderRange(p, &lo, &hi, &prec);
    assert(lo == -10.0 && hi == 10.0);

    // ⑤ uniform 声明的 @range 优先（与自绘滑条的 rangeFor 同口径）：LLM 可指定量程
    p.name = "uAmount";
    p.hasRange = true;
    p.rmin = -100.0f;
    p.rmax = 100.0f;
    host::slotSliderRange(p, &lo, &hi, &prec);
    assert(lo == -100.0 && hi == 100.0);
    assert(prec == 1);                                // 跨度 200 > 100 → 精度 1

    // ⑥ 退化量程（min == max）防除零：hi 抬到 lo+1（滑条宽度映射不做除零）
    p.rmin = 5.0f;
    p.rmax = 5.0f;
    host::slotSliderRange(p, &lo, &hi, &prec);
    assert(lo == 5.0 && hi == 6.0);
    std::cout << "PASS test_slot_slider_range\n";
}

// —— 库索引导出：面板 LLM 取"效果控件里那份列表"的唯一通道 ——
// 索引必须与 shaderPathForIndex 的钳制口径一致（0 基 + 仅 .glsl + 大小写不敏感
// 排序），否则面板给出的序号会指到别的文件。故这里钉死文本契约本身。

// 数据行 = 首个字符是数字的行（头部三行均以 '#' 开头，面板解析时跳过）
static int countDataLines(const std::string& text) {
    int n = 0;
    size_t pos = 0;
    while (pos < text.size()) {
        size_t eol = text.find('\n', pos);
        if (eol == std::string::npos) eol = text.size();
        if (eol > pos && std::isdigit(static_cast<unsigned char>(text[pos]))) n++;
        pos = eol + 1;
    }
    return n;
}

static void test_library_index_dump() {
    // 空库：仍产出可解析的头部（面板据 count 判定"宿主尚无库文件"）
    std::string empty = host::libraryIndexDumpText({});
    assert(empty.find("# count: 0\n") != std::string::npos);
    assert(empty.find("# generated: ") != std::string::npos);
    assert(countDataLines(empty) == 0);   // 只有 # 注释行，无数据行

    // 顺序即序号：第 i 行的数值必须是 i（面板直接拿它写 kIdxFileIndexParam）
    std::vector<std::string> names = {"blackhole", "blackhole_10", "lightball"};
    std::string t = host::libraryIndexDumpText(names);
    assert(t.find("\n0\tblackhole\n") != std::string::npos);
    assert(t.find("\n1\tblackhole_10\n") != std::string::npos);
    assert(t.find("\n2\tlightball\n") != std::string::npos);
    assert(t.find("# count: 3\n") != std::string::npos);
    // 头部三行 + 三数据行，末尾必带换行（面板按行切分不依赖尾行终止）
    assert(!t.empty() && t.back() == '\n');
    assert(t.find("2\tlightball\n") == t.size() - std::string("2\tlightball\n").size());

    // 落盘：写到真实目录，内容与纯函数一致（面板读的就是这份）
    const std::string dumpPath = glsltest::tempPath(host::kLibraryIndexFileName);
    const std::string dir = std::filesystem::path(dumpPath).parent_path().string();
    assert(host::writeLibraryIndexDump(dir, names));
    std::ifstream in(dumpPath, std::ios::binary);
    assert(in.good());
    std::string got((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    assert(got.find("\n2\tlightball\n") != std::string::npos);
    // 空目录路径必须安全失败（不得抛、不得写到奇怪位置）
    assert(!host::writeLibraryIndexDump("", names));

    std::cout << "PASS test_library_index_dump\n";
}

// 回归：effects/ 扫描的扩展名大小写不敏感。
// 只认 .glsl / .GLSL 两个字面量时：用户在资源管理器把 Foo.glsl 改名为
// Foo.Glsl（Windows 文件系统不敏感）后，刷新列表即消失 → 实例按名解析不到 →
// 渲染透传并误报「库文件已不存在」。scanEffectsDirIn 直接吃可控目录，避免动
// APPDATA 下真实数据根（effectsDirPath 的解析链）。
static void test_scan_effects_dir_extension_case() {
    const std::string dir = glsltest::tempPath("test_nv3_scan_case");
    std::error_code ec;
    std::filesystem::remove_all(dir, ec);
    std::filesystem::create_directories(dir, ec);
    const char* kFiles[] = {
        "alpha.glsl", "beta.GLSL", "gamma.Glsl", "delta.gLSL", "epsilon.GlSl",
        "not_effect.txt", "still.txt.glslx",   // 非 .glsl 后缀：不得收录
    };
    for (const char* f : kFiles) {
        std::ofstream out(dir + "\\" + f, std::ios::binary);
        out << "void main() {}\n";
    }
    // 目录名带 .glsl 后缀：is_regular_file 过滤，不得当文件收录
    std::filesystem::create_directories(dir + "\\adir.glsl", ec);

    std::vector<std::string> names = host::scanEffectsDirIn(dir);
    assert(names.size() == 5);
    // 按 _stricmp 排序：alpha, beta, delta, epsilon, gamma
    assert(names[0] == "alpha");
    assert(names[1] == "beta");
    assert(names[2] == "delta");
    assert(names[3] == "epsilon");
    assert(names[4] == "gamma");

    // 空目录 / 不存在目录：安全返回空列表（不得抛）
    assert(host::scanEffectsDirIn("").empty());
    assert(host::scanEffectsDirIn(dir + "\\no_such_dir").empty());

    std::filesystem::remove_all(dir, ec);
    std::cout << "PASS test_scan_effects_dir_extension_case\n";
}

// getShaderByIdentity 单次重扫后的纯解析逻辑（name → 下标 + 路径）。
// 在该函数内调用 indexForShaderName + shaderPathForName 时，二者各自再触发
// 一次目录重扫（连入口共 3 次目录枚举；渲染路径每帧调用是纯浪费）。新实现改为
// 入口单次重扫 + 本纯函数在同一份 popupChoices 快照上一次解析。口径必须与
// shaderPathForName 命中分支一致：大小写不敏感、未命中 -1/空路径（透传，绝不
// 静默换文件）、dir 为空（数据根解析失败）时命中下标仍返回但路径为空。
static void test_resolve_shader_name_in_list() {
    const std::vector<std::string> names = {"Alpha", "beta", "Gamma"};
    const std::string dir = "D:\\data\\effects";
    std::string path;
    assert(host::resolveShaderNameInList(names, dir, "beta", &path) == 1);
    assert(path == dir + "\\beta.glsl");
    // 大小写不敏感（与 indexForShaderNameNoRescan 的 nameEqualsCI 同口径）
    assert(host::resolveShaderNameInList(names, dir, "GAMMA", &path) == 2);
    assert(path == dir + "\\Gamma.glsl");
    assert(host::resolveShaderNameInList(names, dir, "alpha", &path) == 0);
    assert(path == dir + "\\Alpha.glsl");
    // 未命中：-1 + 空路径（getShaderByIdentity 走"库文件已不存在"透传契约）
    assert(host::resolveShaderNameInList(names, dir, "nope", &path) == -1);
    assert(path.empty());
    // 空名字 / 空列表
    assert(host::resolveShaderNameInList(names, dir, "", &path) == -1);
    assert(path.empty());
    assert(host::resolveShaderNameInList({}, dir, "beta", &path) == -1);
    // dir 为空（数据根解析失败）：命中下标仍返回，路径为空串 → getShaderForPath("")
    // 返回空快照透传（与 shaderPathForName 的 dir.empty() 分支同语义）
    assert(host::resolveShaderNameInList(names, "", "Alpha", &path) == 0);
    assert(path.empty());
    // outPath=nullptr 允许（下标仍返回，路径不写）
    assert(host::resolveShaderNameInList(names, dir, "beta", nullptr) == 1);
    std::cout << "PASS test_resolve_shader_name_in_list\n";
}

// 「实例记住的库文件已不存在」告警的去重 + error.log 代际校验。
// 只做 thread_local 名字去重时：别的实例重载成功 clearErrorLog 清空全文件后，
// 本实例的同名诊断因去重跳过而永不写回（诊断链断裂）。
// 行为测试：同名第二次不写；clearErrorLog（代际 +1）后同名必须写回。
static void test_missing_identity_log_generation() {
    const std::string dir = glsltest::tempPath("test_missing_identity_dir");
    std::filesystem::create_directories(dir);
    const std::string name = "ghost_identity_probe";   // 唯一名：thread_local 去重按名键控

    assert(host::logMissingIdentityOnceAt(dir, name));       // 首写
    std::string first = host::readErrorLog(dir);
    assert(!first.empty() && first.find(name) != std::string::npos);
    assert(!host::logMissingIdentityOnceAt(dir, name));      // 同名同代际：去重跳过
    assert(host::readErrorLog(dir).size() == first.size());  // 文件未增长

    // 别的实例重载成功 → 目录级清空 + 代际递增
    host::clearErrorLog(dir);
    assert(host::readErrorLog(dir).empty());
    // 代际变化 → 本实例的持续诊断必须写回（此处返回 false 会让 error.log 永久空白）
    assert(host::logMissingIdentityOnceAt(dir, name));
    assert(host::readErrorLog(dir).find(name) != std::string::npos);
    // 不同名字不受同名去重影响
    assert(host::logMissingIdentityOnceAt(dir, name + "_2"));

    std::filesystem::remove_all(dir);
    std::cout << "PASS test_missing_identity_log_generation\n";
}

void runEffectStateTests() {
    test_first_load();
    test_no_reload_when_unchanged();
    test_hot_reload();
    test_multi_file_no_crosstalk();
    test_uniform_at_per_file();
    test_uniform_at_lazy_load();
    test_missing_file();
    test_entry_signature();
    test_entry_signature_stable_across_snapshots();
    test_data_root_cache();
    test_channels_used_snapshot_and_reload();
    test_channels_used_lazy_load();
    test_sampler_warning_into_snapshot();
    test_channels_used_per_file();
    test_render_consume_pending_render_only();
    test_slot_index_boundaries();
    test_slot_slider_range();
    test_library_index_dump();
    test_scan_effects_dir_extension_case();
    test_resolve_shader_name_in_list();
    test_missing_identity_log_generation();
    std::cout << "ALL effect state tests passed\n";
}
