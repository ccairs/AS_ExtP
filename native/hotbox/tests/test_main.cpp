// test_main.cpp — 测试入口（返回值 = 失败数；0 = 全部通过）
#include <cstdio>

int run_geom_tests();
int run_json_tests();
int run_data_tests();
int run_search_tests();
int run_config_tests();
int run_log_wide_tests();
int run_i18n_tests();

int main() {
    int fail = run_geom_tests();
    fail += run_json_tests();
    fail += run_data_tests();
    fail += run_search_tests();
    fail += run_config_tests();
    fail += run_log_wide_tests();
    fail += run_i18n_tests();
    if (fail == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILED\n", fail);
    return fail;
}
