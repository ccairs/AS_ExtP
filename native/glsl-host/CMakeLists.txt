cmake_minimum_required(VERSION 3.20)
project(as_effect_host C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 源文件为 UTF-8（含中文注释），MSVC 需显式 /utf-8 避免代码页 936 误解析
add_compile_options("$<$<CXX_COMPILER_ID:MSVC>:/utf-8>")

if(NOT DEFINED AEFX_SDK_PATH)
    message(FATAL_ERROR "请通过 -DAEFX_SDK_PATH=<AE SDK 路径> 指定 SDK")
endif()
if(NOT DEFINED AE_PLUGIN_OUTPUT)
    set(AE_PLUGIN_OUTPUT "${CMAKE_CURRENT_LIST_DIR}/../../deploy/Plug-ins")
endif()

# —— PiPL 资源：.r → .rr(cl /EP) → .rrc(PiPLtool) → .rc(cl /EP)，再交给 rc.exe 编译 ——
# AE 依赖 PiPL 资源识别插件（缺失会导致"找不到效果"甚至崩溃），out_flags 必须与 GLOBAL_SETUP 一致。
find_program(PIPLTOOL_EXE PiPLtool.exe HINTS "${AEFX_SDK_PATH}/Examples/Resources")
if(NOT PIPLTOOL_EXE)
    message(FATAL_ERROR "找不到 PiPLtool.exe（AE SDK Examples/Resources）")
endif()
set(PIPL_R  "${CMAKE_CURRENT_SOURCE_DIR}/AS_Effect_HostPiPL.r")
set(PIPL_RR "${CMAKE_CURRENT_BINARY_DIR}/AS_Effect_HostPiPL.rr")
set(PIPL_RRC "${CMAKE_CURRENT_BINARY_DIR}/AS_Effect_HostPiPL.rrc")
set(PIPL_RC "${CMAKE_CURRENT_BINARY_DIR}/AS_Effect_HostPiPL.rc")
add_custom_command(
    OUTPUT "${PIPL_RC}"
    COMMAND "${CMAKE_CXX_COMPILER}" /nologo /I "${AEFX_SDK_PATH}/Examples/Headers" /EP "${PIPL_R}" > "${PIPL_RR}"
    COMMAND "${PIPLTOOL_EXE}" "${PIPL_RR}" "${PIPL_RRC}"
    COMMAND "${CMAKE_CXX_COMPILER}" /nologo /D MSWindows /EP "${PIPL_RRC}" > "${PIPL_RC}"
    DEPENDS "${PIPL_R}"
    COMMENT "编译 PiPL 资源 (${PIPL_RC})"
)

# —— 宿主插件（.aex）——
add_library(as_effect_host MODULE
    src/plugin.cpp
    src/crashForensics.cpp
    src/paramMap.cpp
    src/effectState.cpp
    src/smartRender.cpp
    src/glslLoader.cpp
    src/uniformParser.cpp
    src/errorLog.cpp
    src/errorFrame.cpp
    src/renderer.cpp
    src/pixelConvert.cpp
    src/aeCamera.cpp
    src/aeLights.cpp
    src/aeParams.cpp
    src/customUI.cpp
    src/i18n.cpp
    ../shared/i18n/i18nRuntime.cpp
    "${AEFX_SDK_PATH}/Examples/Util/AEFX_SuiteHelper.c"
    third_party/glad/src/glad.c
    "${PIPL_RC}"
)
# AE SDK 2023 布局：头文件在 Examples/Headers（含 adobesdk、SP 子目录）与 Examples/Util
target_include_directories(as_effect_host PRIVATE
    src
    ../shared/i18n
    third_party/glad/include
    "${AEFX_SDK_PATH}/Examples/Headers"
    "${AEFX_SDK_PATH}/Examples/Headers/adobesdk"
    "${AEFX_SDK_PATH}/Examples/Headers/SP"
    "${AEFX_SDK_PATH}/Examples/Util"
)
target_compile_definitions(as_effect_host PRIVATE
    AE_DEBUG=1
)
target_link_libraries(as_effect_host PRIVATE opengl32 gdi32 user32 psapi)
set_target_properties(as_effect_host PROPERTIES
    PREFIX ""
    SUFFIX ".aex"
)
# 复制到 AE Plug-ins 目录
add_custom_command(TARGET as_effect_host POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy
        $<TARGET_FILE:as_effect_host>
        "${AE_PLUGIN_OUTPUT}/AS_Effect_Host.aex"
    COMMENT "部署 .aex 到 ${AE_PLUGIN_OUTPUT}"
)

# —— 单元测试（纯逻辑层，不依赖 AE SDK）——
add_library(glsl_core STATIC
    src/pixelConvert.cpp
    src/glslLoader.cpp
    src/uniformParser.cpp
    src/errorLog.cpp
    src/effectState.cpp
    src/errorFrame.cpp
    src/crashForensics.cpp
    src/paramMap.cpp
)
target_include_directories(glsl_core PUBLIC src ../shared/i18n)
# errorFrame 用 GDI 光栅化（系统字体画错误文本），PUBLIC 传播给测试可执行文件
target_link_libraries(glsl_core PUBLIC gdi32 user32)

add_executable(glsl_core_tests
    tests/test_main.cpp
    tests/test_glsl_loader.cpp
    tests/test_uniform_parser.cpp
    tests/test_sampler_channels.cpp
    tests/test_error_log.cpp
    tests/test_effect_state.cpp
    tests/test_file_sel_layout.cpp
    tests/test_ae_camera.cpp
    tests/test_ae_lights.cpp
    tests/test_error_frame.cpp
    tests/test_iteration.cpp
    tests/test_pixel_convert.cpp
    tests/test_slot_ui_layout.cpp
    tests/test_ui_notice_policy.cpp
    tests/test_glctx_gen.cpp
    tests/test_sel_wheel_policy.cpp
    tests/test_solver_mask_policy.cpp
    tests/test_solver_key_identity.cpp
    tests/test_glcache_reclaim.cpp
    tests/test_seq_identity.cpp
    tests/test_crash_forensics.cpp
    tests/test_param_map.cpp
    tests/test_acp_name.cpp
    tests/test_i18n.cpp
    src/i18n.cpp
    ../shared/i18n/i18nRuntime.cpp
)
target_link_libraries(glsl_core_tests PRIVATE glsl_core)
# 种子示例目录：inputLayerNeeded 的库内示例回归测试要按真实文件判定
# （纯生成类示例必须保持"不需要输入"，否则输入侧快路径白写——见 uniformParser.cpp）
target_compile_definitions(glsl_core_tests PRIVATE
    SHADER_SEED_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../client/seed/effects"
)
enable_testing()
# 测试临时文件统一写 temp/ 子目录（见 tests/test_util.h）：固定 ctest 的工作
# 目录到 build 下，产物落 build/temp（已被模块 .gitignore 的 build/ 覆盖）
add_test(NAME glsl_core_tests COMMAND glsl_core_tests
         WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR})

# 像素深度检测单元测试（不依赖 AE SDK）
add_executable(test_depth tests/test_depth.cpp)
add_test(NAME test_depth COMMAND test_depth)
