// i18nRuntime.h —— 两个原生插件共享的本地化运行时（纯 Win32，不依赖 AE SDK）。
//
// 语言在插件初始化阶段设定一次，运行期不再变：localeIndex() 决定生成文案表的行，
// localeTag() 是规范化后的标签（诊断/日志用）。两个插件各自编译一份本文件，无进程级共享状态。
#pragma once

#include <string>

namespace i18n {

// 表行顺序，与生成物 i18nStrings.inc 的行序一一对应，不可调整（生成器按同一顺序写表）。
enum {
    kLocaleZhCN = 0,
    kLocaleEnUS,
    kLocaleJaJP,
    kLocaleDeDE,
    kLocaleKoKR,
    kLocaleFrFR,
    kLocaleRuRU,
    kLocaleCount
};

// 设定当前语言。tag 是宿主语言标签（PF_AppGetLanguage 的返回值，形如 "ja_JP"）：
// 取分隔符（'_' 或 '-'）前的语言前缀做大小写不敏感匹配，命中则用该语言的规范 tag；
// 前缀检测到但不在支持列表内 → en-US；nullptr、空串或纯空白 → zh-CN。
// 环境变量 AS_EXTP_NATIVE_LOCALE 非空时优先于 tag，同样按上述规则映射。
// 单线程调用（插件初始化期），重复调用会整体替换当前语言。
void setLocaleTag(const char* tag);

// 当前语言的规范 tag（"zh-CN" / "en-US" / "ja-JP" / "de-DE" / "ko-KR" / "fr-FR" / "ru-RU"）。
// 返回静态存储，生命周期 = 进程。
const char* localeTag();

// 当前语言在文案表里的行下标，取值 0..kLocaleCount-1。
int localeIndex();

// 环境变量 AS_EXTP_NATIVE_LOCALE 的原始值（去掉首尾空白）；未设置、空串或超长时返回空串。
// 调用方据此在日志里区分「语言来自覆盖」与「来自宿主检测」。
std::string localeOverride();

// UTF-8 → UTF-16。nullptr 或空串返回空串；含非法 UTF-8 字节时按替换字符解码，
// 不失败、不截断（调用方用于 DrawText/CreateFont 等需要可绘制文本的路径）。
std::wstring widen(const char* utf8);

// 热盒自绘（DirectWrite/D2D）与效果宿主错误帧（GDI）的界面字体族名，按当前语言选择。
// zh-CN 用雅黑、ja-JP 用 Yu Gothic、ko-KR 用 Malgun Gothic、其余用 Segoe UI。
const wchar_t* uiFontFamilyD2D();
const wchar_t* uiFontFamilyGDI();

} // namespace i18n
