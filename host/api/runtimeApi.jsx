// runScriptFromFile 已删除：全库核实零真实调用方（生产路径走 AEFS.readFile + bootstrap 桥交核执行——
// 起 _wrapScriptForAE 已删），
// 且其在 host 顶层作用域 eval 文件内容、对面板 shadow 沙箱免疫，是确定的沙箱穿透面。
// 面板/引擎各处黑名单仍保留 runScriptFromFile 拦截——防 CEP 缓存的旧 host 残留注册被 LLM 捡拾。
function getApplicationInfo() {
    return {
        name: app.name,
        version: app.version,
        path: app.path
    };
}

// 热盒原生件（AS_Hotbox.aex）存在性探测——面板据此把「热盒快捷键」
// 行置灰并给出可执行提示（从源码安装、或没重跑 install.bat 的用户最常踩：热键录了、
// 请求文件写了没人处理，只回一句「AE 忙碌或插件未加载」）。
// 返回三态：HOTBOX_OK / HOTBOX_MISSING / HOTBOX_UNKNOWN（探测自身不可靠时一律 UNKNOWN，
// 面板按「不动 UI」处理——失败开放：旧宿主/超时不该把可用功能置灰）。
// Plug-ins 目录按**存在性择优**：注册表 InstallPath 在 AE 2023 实测为 "...\Support Files\"
// （AfterFX.exe 所在目录），版本间布局不一，与 install.bat 的 :DeployAex 同口径。
function probeNativeHotbox() {
    try {
        var bases = [];
        try { if (app.path) bases.push(String(app.path)); } catch (e0) {}
        try { if (Folder.startup) bases.push(String(Folder.startup.fsName)); } catch (e1) {}
        var cands = [];
        for (var i = 0; i < bases.length; i++) {
            var b = bases[i].replace(/\\/g, '/').replace(/\/+$/, '');
            cands.push(b + '/Plug-ins');
            cands.push(b + '/Support Files/Plug-ins');
            // Folder.startup 形如 .../Support Files/Scripts/Startup → 上溯到 Support Files
            cands.push(b.replace(/\/Scripts\/Startup$/, '') + '/Plug-ins');
        }
        for (var j = 0; j < cands.length; j++) {
            var f = new Folder(cands[j]);
            if (f.exists) {
                return new File(f.fsName + '/AS_Hotbox.aex').exists ? 'HOTBOX_OK' : 'HOTBOX_MISSING';
            }
        }
        return 'HOTBOX_UNKNOWN';   // 找不到 Plug-ins 目录（非常规安装）→ 不改 UI
    } catch (e) {
        return 'HOTBOX_UNKNOWN';
    }
}
