cmake_minimum_required(VERSION 3.20)
project(as_hotbox CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 源文件为 UTF-8（含中文宽字符串），MSVC 需 /utf-8 避免代码页 936 误解析
add_compile_options("$<$<CXX_COMPILER_ID:MSVC>:/utf-8>")

if(NOT DEFINED AEFX_SDK_PATH)
    message(FATAL_ERROR "请通过 -DAEFX_SDK_PATH=<AE SDK 路径> 指定 SDK")
endif()
if(NOT DEFINED AE_PLUGIN_OUTPUT)
    set(AE_PLUGIN_OUTPUT "${CMAKE_CURRENT_LIST_DIR}/../../deploy/Plug-ins")
endif()

# —— PiPL 资源：.r → .rr(cl /EP) → .rrc(PiPLtool) → .rc(cl /EP)，再交给 rc.exe 编译 ——
find_program(PIPLTOOL_EXE PiPLtool.exe HINTS "${AEFX_SDK_PATH}/Examples/Resources")
if(NOT PIPLTOOL_EXE)
    message(FATAL_ERROR "找不到 PiPLtool.exe（AE SDK Examples/Resources）")
endif()
set(PIPL_R   "${CMAKE_CURRENT_SOURCE_DIR}/AS_HotboxPiPL.r")
set(PIPL_RR  "${CMAKE_CURRENT_BINARY_DIR}/AS_HotboxPiPL.rr")
set(PIPL_RRC "${CMAKE_CURRENT_BINARY_DIR}/AS_HotboxPiPL.rrc")
set(PIPL_RC  "${CMAKE_CURRENT_BINARY_DIR}/AS_HotboxPiPL.rc")
add_custom_command(
    OUTPUT "${PIPL_RC}"
    COMMAND "${CMAKE_CXX_COMPILER}" /nologo /I "${AEFX_SDK_PATH}/Examples/Headers" /EP "${PIPL_R}" > "${PIPL_RR}"
    COMMAND "${PIPLTOOL_EXE}" "${PIPL_RR}" "${PIPL_RRC}"
    COMMAND "${CMAKE_CXX_COMPILER}" /nologo /D MSWindows /EP "${PIPL_RRC}" > "${PIPL_RC}"
    DEPENDS "${PIPL_R}"
    COMMENT "编译 PiPL 资源 (${PIPL_RC})"
)

# —— PinIn4Cpp（拼音搜索，third_party 源码集成，见 src/search.cpp）——
set(PININ4CPP_INSTALL OFF CACHE BOOL "" FORCE)
add_subdirectory(third_party/PinIn4Cpp)

# —— GeneralPlug（.aex）——
add_library(as_hotbox MODULE
    src/entry.cpp
    src/aeexec.cpp
    src/capture.cpp
    src/hotkey.cpp
    src/window.cpp
    src/json.cpp
    src/data.cpp
    src/search.cpp
    src/config.cpp
    src/i18n.cpp
    ../shared/i18n/i18nRuntime.cpp
    src/pinyin_dict.rc
    "${AEFX_SDK_PATH}/Examples/Util/AEGP_SuiteHandler.cpp"
    "${AEFX_SDK_PATH}/Examples/Util/MissingSuiteError.cpp"
    "${PIPL_RC}"
)
target_link_libraries(as_hotbox PRIVATE user32 d2d1 dwrite PinIn4Cpp::PinIn4Cpp)
target_include_directories(as_hotbox PRIVATE
    src
    ../shared/i18n
    "${AEFX_SDK_PATH}/Examples/Headers"
    "${AEFX_SDK_PATH}/Examples/Headers/adobesdk"
    "${AEFX_SDK_PATH}/Examples/Headers/SP"
    "${AEFX_SDK_PATH}/Examples/Util"
)
set_target_properties(as_hotbox PROPERTIES
    PREFIX ""
    SUFFIX ".aex"
)
# 复制到 deploy/Plug-ins（与 glsl-host 一致，再由部署步骤拷进 AE）
add_custom_command(TARGET as_hotbox POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy
        $<TARGET_FILE:as_hotbox>
        "${AE_PLUGIN_OUTPUT}/AS_Hotbox.aex"
    COMMENT "部署 .aex 到 ${AE_PLUGIN_OUTPUT}"
)

# —— 单元测试（不依赖 AE SDK；拼音单测从源码树读 pinyin.txt）——
add_executable(hotbox_core_tests
    tests/test_main.cpp
    tests/test_geom.cpp
    tests/test_json.cpp
    tests/test_data.cpp
    tests/test_search.cpp
    tests/test_config.cpp
    tests/test_log_wide.cpp
    tests/test_i18n.cpp
    src/json.cpp
    src/data.cpp
    src/search.cpp
    src/config.cpp
    src/i18n.cpp
    ../shared/i18n/i18nRuntime.cpp
)
target_link_libraries(hotbox_core_tests PRIVATE PinIn4Cpp::PinIn4Cpp)
target_include_directories(hotbox_core_tests PRIVATE src ../shared/i18n)
target_compile_definitions(hotbox_core_tests PRIVATE
    HOTBOX_PINYIN_DICT_PATH="${CMAKE_CURRENT_SOURCE_DIR}/third_party/PinIn4Cpp/test_data/pinyin.txt"
)
enable_testing()
add_test(NAME hotbox_core_tests COMMAND hotbox_core_tests)
