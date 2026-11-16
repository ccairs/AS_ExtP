#include "AEConfig.h"
#include "AE_GeneralPlug.h"
#include "AEGP_SuiteHandler.h"
#include "entry.h"          // DllExport 宏（SDK Examples/Util/entry.h）
#include "log.h"
#include "aeexec.h"
#include "hotkey.h"
#include "window.h"
#include "i18n.h"

static AEGP_PluginID S_my_id = 0L;

static A_Err DeathHook(AEGP_GlobalRefcon /*plugin_refconP*/, AEGP_DeathRefcon /*refconP*/) {
    hotbox_log("DeathHook");
    hotkey_unregister();
    window_destroy();
    return A_Err_NONE;
}

// AE 空闲回调（忙时不调用，零定时器零线程）：热键注册失败自动重试 + 面板热键请求处理
// + 数据预热。max_sleepPL 单位 1/60 秒，120 = 2s：AE 空闲时隔 ≥2s 才回调。
// WM_HOTKEY 是投递消息（热键响应不受 idle 睡眠影响），三个处理函数内部各自闸门。
static A_Err IdleHook(AEGP_GlobalRefcon /*plugin_refconP*/, AEGP_IdleRefcon /*refconP*/,
                      A_long* max_sleepPL) {
    *max_sleepPL = 120;
    hotkey_idleTick();                 // 注册失败时重试（组合释放后 auto-recovered）
    window_processHotkeyRequest();     // 处理面板热键请求（保存即生效，无需重启）
    window_idleWarmup();               // 首次空闲预热效果枚举/索引（一次性）
    return A_Err_NONE;
}

extern "C" {

DllExport A_Err
EntryPointFunc(SPBasicSuite* pica_basicP, A_long /*major*/, A_long /*minor*/,
               AEGP_PluginID aegp_plugin_id, AEGP_GlobalRefcon* /*plugin_refconP*/) {
    A_Err err = A_Err_NONE;
    S_my_id = aegp_plugin_id;
    aeexec_init(aegp_plugin_id, pica_basicP);

    AEGP_SuiteHandler suites(pica_basicP);
    // 语言在插件初始化时定一次：取宿主 UI 语言 tag（PF_AppGetLanguage，PFAppSuite6）。
    // 取不到 tag（无宿主/套件缺失）由 setLocaleTag 回退 zh-CN；AS_EXTP_NATIVE_LOCALE
    // 环境变量覆盖在 setLocaleTag 内部优先。AppSuite6() 获取失败时抛异常
    //（AEGP_SuiteHandler 的 MissingSuiteError），此处吞掉并按无宿主 tag 处理。
    char langTag[PF_APP_LANG_TAG_SIZE] = { 0 };
    try {
        if (auto* app6 = suites.AppSuite6()) app6->PF_AppGetLanguage(langTag);
    } catch (...) {
        langTag[0] = 0;
    }
    i18n::setLocaleTag(langTag);
    hotbox_log(("i18n: host=" + std::string(langTag) + " override=" + i18n::localeOverride() +
                " resolved=" + i18n::localeTag()).c_str());
    err = suites.RegisterSuite5()->AEGP_RegisterDeathHook(
        S_my_id, DeathHook, NULL);
    A_Err idleErr = suites.RegisterSuite5()->AEGP_RegisterIdleHook(
        S_my_id, IdleHook, NULL);
    if (idleErr != A_Err_NONE)
        hotbox_log("IdleHook register ERR (auto-recover/request channel disabled)");
    hotbox_log(err == A_Err_NONE ? "EntryPointFunc OK" : "EntryPointFunc ERR");

    window_init(aegp_plugin_id);
    if (!hotkey_register()) {
        hotbox_log("hotkey register failed, plugin still loads");
    }
    return err;
}

} // extern "C"
