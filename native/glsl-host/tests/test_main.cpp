#include <iostream>
// 各测试文件声明的测试函数（由具体测试文件定义）
void runGlslLoaderTests();
void runUniformParserTests();
void runSamplerChannelTests();
void runErrorLogTests();
void runEffectStateTests();
void runFileSelLayoutTests();
void runAeCameraTests();
void runAeLightsTests();
void runErrorFrameTests();
void runIterationTests();
void runPixelConvertTests();
void runSlotUiLayoutTests();
void runUiNoticePolicyTests();
void runGlCtxGenTests();
void runSelWheelPolicyTests();
void runSolverMaskPolicyTests();
void runSolverKeyIdentityTests();
void runGlCacheReclaimTests();
void runSeqIdentityTests();
void runCrashForensicsTests();
void runParamMapTests();
void runAcpNameTests();
void runI18nTests();

int main() {
    runGlslLoaderTests();
    runUniformParserTests();
    runSamplerChannelTests();
    runErrorLogTests();
    runEffectStateTests();
    runFileSelLayoutTests();
    runAeCameraTests();
    runAeLightsTests();
    runErrorFrameTests();
    runIterationTests();
    runPixelConvertTests();
    runSlotUiLayoutTests();
    runUiNoticePolicyTests();
    runGlCtxGenTests();
    runSelWheelPolicyTests();
    runSolverMaskPolicyTests();
    runSolverKeyIdentityTests();
    runGlCacheReclaimTests();
    runSeqIdentityTests();
    runCrashForensicsTests();
    runParamMapTests();
    runAcpNameTests();
    runI18nTests();
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
