(function (global) {
    // 全局设置默认值：仅用于主面板全局配置
    const GLOBAL_DEFAULTS = {
        apiKey: '',
        openrouterApiKey: '',
        deepseekApiKey: '',
        kimiApiKey: '',
        anthropicApiKey: '',
        defaultPlatform: 'deepseek',
        defaultModel: 'deepseek-v4-pro',
        themePreset: 'default',
        uiLocale: 'auto',
        debugMode: false,
        soundVolume: 1,
        bgOverlayImage: '',
        bgOverlayOpacity: 30,
        bgOverlayBlendMode: 'normal',
        bgOverlayFillMode: 'cover',
        bgOverlayGrayscale: false,
        bgOverlayContrast: 100,
        bgOverlayOffsetX: 0,
        bgOverlayOffsetY: 0,
        customThemeColors: null
    };

    var THEME_PRESETS = global.AE_THEME_PRESETS || {};
    // THEME_PRESETS 已移至 shared/theme-presets.js，此处仅引用

    // 自定义主题变量分组元数据来自 shared/theme-presets.js（唯一清单；后续 panelTheme 工具取同一份）
    var THEME_VAR_GROUPS = global.AE_THEME_VAR_GROUPS || [];
    var THEME_PRESET_LABELS = global.AE_THEME_PRESET_LABELS || {};

    // GLOBAL_MODELS is deprecated. Dynamic provider/model lists come from global.AE_LLM.providerRegistry
    // global.AE_LLM.MODELS compatibility map is built by buildModelsCompatibilityMap after registry init
    let appContainer = null;
    // 启动早期（createAppContainer 之前）创建的统一设置仓库引用：自定义数据目录须在
    // 各模块 init 之前同步，而 loadGlobalSettings/saveGlobalSettings 经 getSettingsStore
    // 取库——appContainer 未就绪时回退到此引用（bootstrap 创建后立即赋值，与容器内
    // dependencies.settingsStore 为同一实例）
    let earlySettingsStore = null;
    let activeGlobalSettings = { ...GLOBAL_DEFAULTS };
    let moduleTransitionRunning = false;
    // 面板主题方案库实例（bootstrap 期创建；工具与 UI 共用同一实例）
    let panelTheme = null;
    const GLOBAL_SETTINGS_PATCH_KEY = 'ae_global_settings_patch_v1';

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.MODELS = {};

    // 将主题预设映射为 CSS 变量，驱动整个容器面板视觉风格（委托 themeApplier）
    function applyTheme(themePreset, customColors) {
        if (themePreset === 'custom' && !customColors) {
            customColors = activeGlobalSettings.customThemeColors || null;
        }
        global.applyThemePreset(themePreset, customColors);
    }

    // --- 颜色解析工具 ---
    function isHexColor(v) {
        return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
    }
    function parseRgba(str) {
        var m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(str);
        if (!m) return null;
        return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10), a: m[4] != null ? parseFloat(m[4]) : 1 };
    }
    function parseRgbTriplet(str) {
        var m = /^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/.exec(str);
        if (!m) return null;
        return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
    }
    function rgbToHex(r, g, b) {
        return '#' + [r, g, b].map(function (n) {
            var h = Math.max(0, Math.min(255, Math.round(n))).toString(16);
            return h.length < 2 ? '0' + h : h;
        }).join('');
    }
    function hexToRgb(hex) {
        var m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
        if (!m) return { r: 0, g: 0, b: 0 };
        return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
    }

    // 解析 linear-gradient(ANGLEdeg, rgba(...), rgba(...))
    function parseLinearGradient(str) {
        if (typeof str !== 'string') return null;
        var m = /linear-gradient\(\s*(\d+)\s*deg\s*,\s*(rgba?\([^)]+\))\s*,\s*(rgba?\([^)]+\))\s*\)/i.exec(str);
        if (!m) return null;
        var angle = parseInt(m[1], 10);
        var c1 = parseRgba(m[2].trim());
        var c2 = parseRgba(m[3].trim());
        if (!c1 || !c2) return null;
        return { angle: angle, c1: c1, c2: c2 };
    }

    // 解析 0 0 0 1px rgba(r,g,b,a1), 0 0 Npx rgba(r,g,b,a2)
    function parseBoxShadow(str) {
        if (typeof str !== 'string') return null;
        var rgbaMatches = str.match(/rgba?\([^)]+\)/gi);
        if (!rgbaMatches || rgbaMatches.length < 2) return null;
        var c1 = parseRgba(rgbaMatches[0]);
        var c2 = parseRgba(rgbaMatches[1]);
        if (!c1 || !c2) return null;
        if (c1.r !== c2.r || c1.g !== c2.g || c1.b !== c2.b) return null;
        var blurMatch = str.match(/0\s+0\s+(\d+)px/);
        var blur = blurMatch ? parseInt(blurMatch[1], 10) : 20;
        return { r: c1.r, g: c1.g, b: c1.b, ringAlpha: c1.a, glowBlur: blur, glowAlpha: c2.a };
    }

    // 自定义主题临时颜色（"确定"后暂存，保存全局设置时写入）
    var _tempCustomColors = null;
    // 自定义主题滑块拖动预览状态
    var _ctDragging = false;

    // 构建自定义主题颜色编辑面板（仅生成 DOM 结构，不填充值）
    function buildCustomThemePanel() {
        var panel = document.getElementById('customThemePanel');
        // 幂等：静态方案列表容器已在 panel 内，不能用 childNodes.length 判空（会让调色分组永不构建）
        if (!panel || panel.querySelector('.custom-theme-group')) return;
        THEME_VAR_GROUPS.forEach(function (group) {
            var gEl = document.createElement('div');
            gEl.className = 'custom-theme-group';
            var title = document.createElement('div');
            title.className = 'custom-theme-group-title';
            title.textContent = group.title;
            gEl.appendChild(title);
            var grid = document.createElement('div');
            grid.className = 'custom-theme-grid';
            group.vars.forEach(function (v) {
                var item = document.createElement('div');
                item.className = 'custom-theme-item';
                var label = document.createElement('label');
                label.textContent = v.label;
                item.appendChild(label);
                var wrap = document.createElement('div');
                wrap.className = 'custom-theme-color-wrap';
                wrap.dataset.themeVar = v.key;
                grid.appendChild(item);
                item.appendChild(wrap);
            });
            gEl.appendChild(grid);
            panel.appendChild(gEl);
        });
    }

    // 将颜色对象填充到面板输入控件，根据值类型自动选择取色器/滑块/纯文本
    function populateCustomThemePanel(colors) {
        var panel = document.getElementById('customThemePanel');
        if (!panel) return;
        var source = colors || THEME_PRESETS.default;
        // 预设已不存派生键（由 themeApplier 计算），回退视图补全派生项
        var fallback = global.AEAgentApp && global.AEAgentApp.themeApplier
            ? global.AEAgentApp.themeApplier.deriveThemeColors(THEME_PRESETS.default) : THEME_PRESETS.default;
        var wraps = panel.querySelectorAll('.custom-theme-color-wrap');
        wraps.forEach(function (wrap) {
            var key = wrap.dataset.themeVar;
            var val = source[key] != null ? source[key] : (fallback[key] || '');
            wrap.innerHTML = '';

            var textInput = document.createElement('input');
            textInput.type = 'text';
            textInput.value = val;
            textInput.dataset.themeVar = key;
            textInput.className = 'custom-theme-text';

            if (isHexColor(val)) {
                var ci = document.createElement('input');
                ci.type = 'color';
                ci.value = val;
                ci.className = 'custom-theme-picker';
                ci.addEventListener('input', function () { textInput.value = ci.value; previewCustomTheme(); });
                textInput.addEventListener('input', function () {
                    if (isHexColor(textInput.value)) ci.value = textInput.value;
                    previewCustomTheme();
                });
                wrap.appendChild(ci);
                wrap.appendChild(textInput);
            } else {
                var rgba = parseRgba(val);
                if (rgba) {
                    var ci2 = document.createElement('input');
                    ci2.type = 'color';
                    ci2.value = rgbToHex(rgba.r, rgba.g, rgba.b);
                    ci2.className = 'custom-theme-picker';
                    var slider = document.createElement('input');
                    slider.type = 'range';
                    slider.min = '0'; slider.max = '1'; slider.step = '0.01';
                    slider.value = rgba.a;
                    slider.className = 'custom-theme-alpha';
                    slider.title = AEI18n.t('透明度');
                    var aLabel = document.createElement('span');
                    aLabel.className = 'custom-theme-alpha-label';
                    aLabel.textContent = Math.round(rgba.a * 100) + '%';
                    function syncRgba() {
                        var rgb = hexToRgb(ci2.value);
                        var a = parseFloat(slider.value);
                        textInput.value = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + a + ')';
                        aLabel.textContent = Math.round(a * 100) + '%';
                        previewCustomTheme();
                    }
                    ci2.addEventListener('input', syncRgba);
                    slider.addEventListener('input', syncRgba);
                    textInput.addEventListener('input', function () {
                        var p = parseRgba(textInput.value);
                        if (p) { ci2.value = rgbToHex(p.r, p.g, p.b); slider.value = p.a; aLabel.textContent = Math.round(p.a * 100) + '%'; }
                        previewCustomTheme();
                    });
                    wrap.appendChild(ci2);
                    var aPre = document.createElement('span');
                    aPre.className = 'custom-theme-alpha-pre';
                    aPre.textContent = AEI18n.t('透');
                    wrap.appendChild(aPre);
                    wrap.appendChild(slider);
                    wrap.appendChild(aLabel);
                    wrap.appendChild(textInput);
                } else {
                    var triplet = parseRgbTriplet(val);
                    if (triplet) {
                        var ci3 = document.createElement('input');
                        ci3.type = 'color';
                        ci3.value = rgbToHex(triplet.r, triplet.g, triplet.b);
                        ci3.className = 'custom-theme-picker';
                        ci3.addEventListener('input', function () {
                            var rgb = hexToRgb(ci3.value);
                            textInput.value = rgb.r + ',' + rgb.g + ',' + rgb.b;
                            previewCustomTheme();
                        });
                        textInput.addEventListener('input', function () {
                            var p = parseRgbTriplet(textInput.value);
                            if (p) ci3.value = rgbToHex(p.r, p.g, p.b);
                            previewCustomTheme();
                        });
                        wrap.appendChild(ci3);
                        wrap.appendChild(textInput);
                    } else {
                        var grad = parseLinearGradient(val);
                        if (grad) {
                            wrap.classList.add('multi-row');
                            textInput.style.display = 'none';

                            // 角度行
                            var rowA = document.createElement('div');
                            rowA.className = 'ct-sub-row';
                            var aLab = document.createElement('span');
                            aLab.className = 'ct-sub-label'; aLab.textContent = AEI18n.t('角度');
                            var aSlider = document.createElement('input');
                            aSlider.type = 'range'; aSlider.min = '0'; aSlider.max = '360'; aSlider.step = '1';
                            aSlider.value = grad.angle; aSlider.className = 'custom-theme-alpha';
                            var aVal = document.createElement('span');
                            aVal.className = 'custom-theme-alpha-label'; aVal.textContent = grad.angle + '°';
                            rowA.appendChild(aLab); rowA.appendChild(aSlider); rowA.appendChild(aVal);

                            // 色1行
                            var rowC1 = document.createElement('div');
                            rowC1.className = 'ct-sub-row';
                            var c1Lab = document.createElement('span');
                            c1Lab.className = 'ct-sub-label'; c1Lab.textContent = AEI18n.t('色1');
                            var c1Picker = document.createElement('input');
                            c1Picker.type = 'color';
                            c1Picker.value = rgbToHex(grad.c1.r, grad.c1.g, grad.c1.b);
                            c1Picker.className = 'custom-theme-picker';
                            var c1Slider = document.createElement('input');
                            c1Slider.type = 'range'; c1Slider.min = '0'; c1Slider.max = '1'; c1Slider.step = '0.01';
                            c1Slider.value = grad.c1.a; c1Slider.className = 'custom-theme-alpha';
                            var c1Pre = document.createElement('span');
                            c1Pre.className = 'custom-theme-alpha-pre'; c1Pre.textContent = AEI18n.t('透');
                            var c1Val = document.createElement('span');
                            c1Val.className = 'custom-theme-alpha-label'; c1Val.textContent = Math.round(grad.c1.a * 100) + '%';
                            rowC1.appendChild(c1Lab); rowC1.appendChild(c1Picker); rowC1.appendChild(c1Pre); rowC1.appendChild(c1Slider); rowC1.appendChild(c1Val);

                            // 色2行
                            var rowC2 = document.createElement('div');
                            rowC2.className = 'ct-sub-row';
                            var c2Lab = document.createElement('span');
                            c2Lab.className = 'ct-sub-label'; c2Lab.textContent = AEI18n.t('色2');
                            var c2Picker = document.createElement('input');
                            c2Picker.type = 'color';
                            c2Picker.value = rgbToHex(grad.c2.r, grad.c2.g, grad.c2.b);
                            c2Picker.className = 'custom-theme-picker';
                            var c2Slider = document.createElement('input');
                            c2Slider.type = 'range'; c2Slider.min = '0'; c2Slider.max = '1'; c2Slider.step = '0.01';
                            c2Slider.value = grad.c2.a; c2Slider.className = 'custom-theme-alpha';
                            var c2Pre = document.createElement('span');
                            c2Pre.className = 'custom-theme-alpha-pre'; c2Pre.textContent = AEI18n.t('透');
                            var c2Val = document.createElement('span');
                            c2Val.className = 'custom-theme-alpha-label'; c2Val.textContent = Math.round(grad.c2.a * 100) + '%';
                            rowC2.appendChild(c2Lab); rowC2.appendChild(c2Picker); rowC2.appendChild(c2Pre); rowC2.appendChild(c2Slider); rowC2.appendChild(c2Val);

                            function syncGradient() {
                                var a = parseInt(aSlider.value, 10);
                                var r1 = hexToRgb(c1Picker.value);
                                var a1 = parseFloat(c1Slider.value);
                                var r2 = hexToRgb(c2Picker.value);
                                var a2 = parseFloat(c2Slider.value);
                                textInput.value = 'linear-gradient(' + a + 'deg, rgba(' + r1.r + ',' + r1.g + ',' + r1.b + ',' + a1 + '), rgba(' + r2.r + ',' + r2.g + ',' + r2.b + ',' + a2 + '))';
                                aVal.textContent = a + '°';
                                c1Val.textContent = Math.round(a1 * 100) + '%';
                                c2Val.textContent = Math.round(a2 * 100) + '%';
                                previewCustomTheme();
                            }
                            [aSlider, c1Picker, c1Slider, c2Picker, c2Slider].forEach(function (el) {
                                el.addEventListener('input', syncGradient);
                            });
                            wrap.appendChild(rowA); wrap.appendChild(rowC1); wrap.appendChild(rowC2);
                            wrap.appendChild(textInput);
                        } else {
                            var shadow = parseBoxShadow(val);
                            if (shadow) {
                                wrap.classList.add('multi-row');
                                textInput.style.display = 'none';

                                // 颜色行
                                var sRow1 = document.createElement('div');
                                sRow1.className = 'ct-sub-row';
                                var sLab = document.createElement('span');
                                sLab.className = 'ct-sub-label'; sLab.textContent = AEI18n.t('颜色');
                                var sPicker = document.createElement('input');
                                sPicker.type = 'color';
                                sPicker.value = rgbToHex(shadow.r, shadow.g, shadow.b);
                                sPicker.className = 'custom-theme-picker';
                                sRow1.appendChild(sLab); sRow1.appendChild(sPicker);

                                // 描边透明度行
                                var sRow2 = document.createElement('div');
                                sRow2.className = 'ct-sub-row';
                                var ringLab = document.createElement('span');
                                ringLab.className = 'ct-sub-label'; ringLab.textContent = AEI18n.t('描边');
                                var ringSlider = document.createElement('input');
                                ringSlider.type = 'range'; ringSlider.min = '0'; ringSlider.max = '1'; ringSlider.step = '0.01';
                                ringSlider.value = shadow.ringAlpha; ringSlider.className = 'custom-theme-alpha';
                                var ringPre = document.createElement('span');
                                ringPre.className = 'custom-theme-alpha-pre'; ringPre.textContent = AEI18n.t('透');
                                var ringVal = document.createElement('span');
                                ringVal.className = 'custom-theme-alpha-label'; ringVal.textContent = Math.round(shadow.ringAlpha * 100) + '%';
                                sRow2.appendChild(ringLab); sRow2.appendChild(ringPre); sRow2.appendChild(ringSlider); sRow2.appendChild(ringVal);

                                // 光晕行（模糊半径 + 透明度）
                                var sRow3 = document.createElement('div');
                                sRow3.className = 'ct-sub-row';
                                var glowLab = document.createElement('span');
                                glowLab.className = 'ct-sub-label'; glowLab.textContent = AEI18n.t('光晕');
                                var blurSlider = document.createElement('input');
                                blurSlider.type = 'range'; blurSlider.min = '0'; blurSlider.max = '60'; blurSlider.step = '1';
                                blurSlider.value = shadow.glowBlur; blurSlider.className = 'custom-theme-alpha';
                                var glowPre = document.createElement('span');
                                glowPre.className = 'custom-theme-alpha-pre'; glowPre.textContent = AEI18n.t('透');
                                var glowSlider = document.createElement('input');
                                glowSlider.type = 'range'; glowSlider.min = '0'; glowSlider.max = '1'; glowSlider.step = '0.01';
                                glowSlider.value = shadow.glowAlpha; glowSlider.className = 'custom-theme-alpha';
                                var glowVal = document.createElement('span');
                                glowVal.className = 'custom-theme-alpha-label'; glowVal.textContent = Math.round(shadow.glowAlpha * 100) + '%';
                                sRow3.appendChild(glowLab); sRow3.appendChild(blurSlider); sRow3.appendChild(glowPre); sRow3.appendChild(glowSlider); sRow3.appendChild(glowVal);

                                function syncShadow() {
                                    var rgb = hexToRgb(sPicker.value);
                                    var ra = parseFloat(ringSlider.value);
                                    var blur = parseInt(blurSlider.value, 10);
                                    var ga = parseFloat(glowSlider.value);
                                    textInput.value = '0 0 0 1px rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + ra + '), 0 0 ' + blur + 'px rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + ga + ')';
                                    ringVal.textContent = Math.round(ra * 100) + '%';
                                    glowVal.textContent = Math.round(ga * 100) + '%';
                                    previewCustomTheme();
                                }
                                [sPicker, ringSlider, blurSlider, glowSlider].forEach(function (el) {
                                    el.addEventListener('input', syncShadow);
                                });
                                wrap.appendChild(sRow1); wrap.appendChild(sRow2); wrap.appendChild(sRow3);
                                wrap.appendChild(textInput);
                            } else {
                                textInput.addEventListener('input', function () { previewCustomTheme(); });
                                wrap.appendChild(textInput);
                            }
                        }
                    }
                }
            }
        });
    }

    // 从面板读取所有自定义颜色值（仅从 .custom-theme-text 读取最终值）
    function readCustomThemeColorsFromUI() {
        var panel = document.getElementById('customThemePanel');
        if (!panel) return null;
        var result = {};
        var inputs = panel.querySelectorAll('input.custom-theme-text[data-theme-var]');
        inputs.forEach(function (inp) {
            result[inp.dataset.themeVar] = inp.value;
        });
        return result;
    }

    // 实时预览自定义主题
    function previewCustomTheme() {
        var colors = readCustomThemeColorsFromUI();
        if (colors) applyTheme('custom', colors);
    }

    // 显示/隐藏"编辑颜色"按钮
    function toggleCustomThemePanel(show) {
        var btn = document.getElementById('customThemeBtn');
        if (btn) btn.hidden = !show;
    }

    // 主题键以 panelTheme 为唯一事实源：把它的当前状态贴回 activeGlobalSettings。
    // 独立成函数 + 调用方 typeof 守卫，原因同 applyThemeKeysAfterSave：保存回调会被
    // 函数体抽取型套件放进受控形参表
    // 执行，那里没有本模块顶层绑定，直接引用 panelTheme 会抛 ReferenceError 并吞掉后续步骤。
    function resyncThemeState() {
        if (!panelTheme) return;
        Object.assign(activeGlobalSettings, panelTheme.getSettingsPatch());
    }

    // 「保存全局设置」成功后的主题键收尾：手改颜色走合并写，档位走 setPresetKey，
    // 最后把整个编辑草稿提交落盘（弹窗里的主题编辑都是预览态，这里是唯一提交点）。
    // 单独成函数的原因见调用点注释（函数体抽取型测试的作用域里没有本模块顶层绑定）。
    async function applyThemeKeysAfterSave() {
        if (!panelTheme) return;
        var editedColors = _tempCustomColors;
        _tempCustomColors = null;
        if (editedColors) await panelTheme.setColors(editedColors);
        var domPresetEl = document.getElementById('globalThemePreset');
        var domPreset = domPresetEl ? domPresetEl.value : '';
        if (domPreset && domPreset !== panelTheme.getState().themePreset) {
            var pr = await panelTheme.setPresetKey(domPreset);
            if (pr && pr.ok !== true && global.AEToast) {
                global.AEToast.show((pr && pr.message) || AEI18n.t('主题档位保存失败'), 'error');
            }
        }
        if (typeof panelTheme.commitDraft === 'function') {
            var cr = await panelTheme.commitDraft();
            if (cr && cr.ok !== true && global.AEToast) {
                global.AEToast.show((cr && cr.message) || AEI18n.t('主题保存失败'), 'error');
            }
        }
    }

    // 面板主题方案库装配：注入 settings 读写与主题 applier（外观应用仍走 applyTheme → themeApplier）。
    // toolRegistry 必须由调用方传入：它声明在 bootstrap 函数作用域内，IIFE 顶层看不见。
    function initPanelTheme(registry) {
        if (!global.AEShared || typeof global.AEShared.createPanelTheme !== 'function') {
            console.warn('[Main] panelTheme 未加载，跳过面板主题方案库初始化');
            return Promise.resolve(null);
        }
        panelTheme = global.AEShared.createPanelTheme({
            load: loadGlobalSettings,
            persist: saveGlobalSettings,
            applyTheme: function (preset, colors) { applyTheme(preset, colors); },
            presets: THEME_PRESETS,
            labels: THEME_PRESET_LABELS,
            editableKeys: global.AE_THEME_EDITABLE_KEYS || []
        });
        global.AE_LLM.panelTheme = panelTheme;
        // 广播 → 同步主面板状态与控件：防「保存全局设置」用陈旧 DOM/内存值回滚 Agent 的改动
        panelTheme.subscribe(syncThemeState);
        return panelTheme.init().then(function (st) {
            syncThemeState(st);
            if (registry && global.AEShared && typeof global.AEShared.initPanelThemeTools === 'function') {
                var reg = global.AEShared.initPanelThemeTools({
                    toolRegistry: registry,
                    panelTheme: panelTheme
                });
                if (!reg || reg.ok !== true) {
                    console.warn('[Main] panelTheme 工具注册失败: ' + JSON.stringify(reg));
                }
            }
            return st;
        });
    }

    // panelTheme 广播的订阅方：把主题状态同步进 activeGlobalSettings 与相关控件
    function syncThemeState(st) {
        if (!panelTheme) return;
        st = st || panelTheme.getState();
        if (!st) return;
        Object.assign(activeGlobalSettings, panelTheme.getSettingsPatch());
        _tempCustomColors = null;   // 丢弃未保存的临时编辑（已被 Agent 的新值取代）
        var themeEl = document.getElementById('globalThemePreset');
        if (themeEl) {
            themeEl.value = st.themePreset;
            // 程序化赋值不触发 change，customSelect 需手动刷新可见文案（同 applyGlobalSettingsToUI）
            if (typeof global.refreshCustomSelect === 'function') global.refreshCustomSelect(themeEl);
        }
        toggleCustomThemePanel(st.themePreset === 'custom');
        // 「预览中 · 保存后生效」提示：只在草稿相对已保存状态确实有改动时出现，
        // 否则用户会以为每次打开设置都在预览
        var draftHint = document.getElementById('themeDraftHint');
        if (draftHint) draftHint.hidden = !st.draftDirty;
        renderSchemeList(st);
        var modal = document.getElementById('customThemeModal');
        // 正在拖滑块时不重填：重填会换掉节点、把这次拖动打断（_ctDragging 由 pointerdown 置位、
        // 文档级 pointerup 复位），外观已在实时预览里，等下一次广播再同步即可
        if (modal && modal.style.display === 'flex' && !_ctDragging) {
            populateCustomThemePanel(panelTheme.effectiveColors());
            bindCustomThemeSliderPreview();
        }
    }

    // 方案列表渲染（自定义主题弹窗顶部）。卡片由 JS 运行时创建——CEF 下静态 option/select 会重置
    // 选中值，且方案列表运行期可变。样式全用主题变量（.custom-theme-scheme-*）。
    // 每张卡一整条色卡带（scheme.swatches，5 格来自 panelTheme.getState()），点卡片 = 应用该方案。
    var _schemeListSig = '';
    function renderSchemeList(st) {
        var box = document.getElementById('customThemeSchemeList');
        if (!box || !panelTheme) return;
        st = st || panelTheme.getState();
        // 每次广播都整表重建会丢按钮焦点、并可能把一次点击拆在 mousedown/mouseup 之间
        // （节点被换掉）——签名不变就不重建。色卡跟着方案配色走，签名必须带上它，
        // 否则改完颜色「确定」后卡片预览还停在旧色。
        var sig = st.themePreset + '|' + st.schemes.map(function (s) {
            return s.id + ':' + s.name + ':' + (s.active ? '1' : '0') + ':' + (s.swatches || []).join(';');
        }).join(',');
        if (sig === _schemeListSig && box.childNodes.length) return;
        _schemeListSig = sig;
        box.innerHTML = '';
        var title = document.createElement('div');
        title.className = 'custom-theme-group-title';
        title.textContent = AEI18n.t('配色方案');
        box.appendChild(title);
        if (!st.schemes.length) {
            var empty = document.createElement('div');
            empty.className = 'custom-theme-empty';
            empty.textContent = AEI18n.t('暂无方案。点「新建方案」把当前颜色存成一套。');
            box.appendChild(empty);
        }
        var grid = document.createElement('div');
        grid.className = 'custom-theme-scheme-grid' + (st.schemes.length ? '' : ' is-empty');
        st.schemes.forEach(function (s) {
            grid.appendChild(_schemeCard(s));
        });
        grid.appendChild(_schemeAddBtn());
        box.appendChild(grid);
    }

    // 一张方案卡：整宽色卡带 + 名称行（当前方案带强调点，右侧「改名 / 删除」）
    function _schemeCard(s) {
        var card = document.createElement('div');
        card.className = 'custom-theme-scheme-card' + (s.active ? ' active' : '');
        // 卡片本身即「应用」动作；div 不能嵌套 button（改名/删除在里面），故走 role + 键盘绑定
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', (s.active ? AEI18n.t('当前方案：') : AEI18n.t('应用方案：')) + s.name);
        card.title = s.active ? AEI18n.t('当前生效方案') : AEI18n.t('点击应用此方案');

        var prev = document.createElement('div');
        prev.className = 'custom-theme-scheme-preview';
        (s.swatches || []).forEach(function (color) {
            var cell = document.createElement('span');
            cell.style.background = color || 'transparent';
            prev.appendChild(cell);
        });
        card.appendChild(prev);

        var foot = document.createElement('div');
        foot.className = 'custom-theme-scheme-card-foot';
        if (s.active) {
            var dot = document.createElement('i');
            dot.className = 'custom-theme-scheme-dot';
            foot.appendChild(dot);
        }
        var name = document.createElement('span');
        name.className = 'custom-theme-scheme-name';
        name.textContent = s.name;
        foot.appendChild(name);
        foot.appendChild(_schemeMiniBtn(AEI18n.t('改名'), false, function (e) { e.stopPropagation(); _beginRenameScheme(card, s); }));
        foot.appendChild(_schemeMiniBtn(AEI18n.t('删除'), true, function (e) { e.stopPropagation(); deleteScheme(s); }));
        card.appendChild(foot);

        function apply() {
            if (s.active) return;                                   // 已是当前方案，「应用」是空操作
            if (card.classList.contains('editing')) return;          // 正在内联改名时不响应点击应用
            // blur 收尾编辑的那一次点击是「点一下退出编辑」的动作本身，不该顺带把方案应用了——
            // 点空白就切主题太意外。一次性标记 + 超时兜底（Tab 移焦后过一会儿再点仍应正常应用）
            if (card._schemeSkipClick) { card._schemeSkipClick = false; return; }
            panelTheme.applyPreset(s.id).then(function (r) {
                _schemeResult(r, AEI18n.t('已切换到方案「{name}」', { name: s.name }));
            });
        }
        card.addEventListener('click', apply);
        card.addEventListener('keydown', function (e) {
            // 只认卡片自己被聚焦时的按键：焦点在「改名/删除」或改名输入框上时 keydown 会冒泡上来，
            // 不挡掉会让一次回车既触发按钮/提交改名，又应用方案
            if (e.target !== card) return;
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                apply();
            }
        });
        return card;
    }

    function _schemeMiniBtn(label, danger, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'custom-theme-scheme-mini' + (danger ? ' danger' : '');
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    }

    // 新建方案：虚线卡位，与其它方案卡并排（点它就地变成输入框，不再弹命名弹窗）
    function _schemeAddBtn() {
        var el = document.createElement('div');
        el.className = 'custom-theme-scheme-card add';
        // 编辑态要塞进 <input>，故与方案卡一样用 div + role（button 里嵌 input 非法且焦点行为不可靠）
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', AEI18n.t('新建配色方案'));
        el.title = AEI18n.t('新建配色方案');
        var icon = document.createElement('span');
        icon.className = 'custom-theme-scheme-add-icon';
        icon.textContent = '+';
        el.appendChild(icon);
        var label = document.createElement('span');
        label.className = 'custom-theme-scheme-add-label';
        label.textContent = AEI18n.t('新建方案');
        el.appendChild(label);
        el.addEventListener('click', function () { _beginCreateScheme(el); });
        el.addEventListener('keydown', function (e) {
            if (e.target !== el) return;
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                _beginCreateScheme(el);
            }
        });
        return el;
    }

    // 内联重命名：把名称 span 就地换成输入框——回车/blur 提交、Esc 取消。
    // 口径对齐本仓既有三处行内改名（script-tree / assets-treeView / shaderUI）：
    // 空名或没改 = 放弃编辑，非法名在 blur 时同样放弃且**不抢回焦点**（否则点击空白
    // 会 blur→提交→focus 循环成焦点陷阱）；提交成功后广播会整表重建，输入框随之消失。
    function _beginRenameScheme(card, s) {
        if (!card || card.classList.contains('editing')) return;
        var nameEl = card.querySelector('.custom-theme-scheme-name');
        if (!nameEl) return;
        var host = nameEl.parentNode;       // 名称 span 在 .custom-theme-scheme-card-foot 里，不是卡片直属子节点
        if (!host) return;
        card.classList.add('editing');
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'custom-theme-scheme-rename';
        input.value = s.name;
        input.maxLength = 24;               // 与 panelTheme.NAME_MAX 对齐（超长名 store 侧一律拒收）
        input.spellcheck = false;
        host.replaceChild(input, nameEl);
        input.focus();
        input.select();

        var settled = false;                // Enter / Esc / blur 会连着来，只认第一次
        function cancel() {
            if (settled) return;
            settled = true;
            _restoreSchemeName(card, host, nameEl, input);
        }
        function submit() {
            if (settled) return;
            var next = input.value.trim();
            if (!next || next === s.name) { cancel(); return; }     // 空名 / 没改动 = 放弃
            settled = true;
            panelTheme.renamePreset(s.id, next).then(function (r) {
                if (r && r.ok === true) {
                    _schemeResult(r, AEI18n.t('方案已改名为「{name}」', { name: r.scheme ? r.scheme.name : next }));
                } else {
                    _restoreSchemeName(card, host, nameEl, input);   // 落盘失败：复原原名，如实报错
                    _schemeResult(r, AEI18n.t('方案已改名为「{name}」', { name: next }));
                }
            });
        }
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', function () {
            card._schemeSkipClick = true;
            setTimeout(function () { card._schemeSkipClick = false; }, 300);
            submit();
        });
        // 输入框里的点击不能冒泡成卡片的「应用方案」
        input.addEventListener('click', function (e) { e.stopPropagation(); });
    }

    function _restoreSchemeName(card, host, nameEl, input) {
        card.classList.remove('editing');
        if (input.parentNode === host) host.replaceChild(nameEl, input);
    }

    // 内联新建：虚线卡位就地变成输入框，回车/blur 提交（存下当前生效色并切到新方案）、Esc 取消
    function _beginCreateScheme(card) {
        if (!card || card.classList.contains('editing')) return;
        card.classList.add('editing');
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'custom-theme-scheme-add-input';
        input.placeholder = AEI18n.t('输入方案名，回车新建');
        input.maxLength = 24;
        input.spellcheck = false;
        card.appendChild(input);
        input.focus();

        var settled = false;
        function cancel() {
            if (settled) return;
            settled = true;
            _closeCreateScheme(card, input);
        }
        function submit() {
            if (settled) return;
            var name = input.value.trim();
            if (!name) { cancel(); return; }
            settled = true;
            panelTheme.savePreset(name, null, true).then(function (r) {
                if (r && r.ok === true) {
                    // created=false 表示同名命中既有方案（savePreset 的幂等语义：同名更新而非新建），
                    // 措辞必须如实反映，否则用户以为新建了、其实旧方案的颜色已被覆盖
                    _schemeResult(r, r.created
                        ? AEI18n.t('已新建方案「{name}」', { name: r.scheme ? r.scheme.name : name })
                        : AEI18n.t('已更新方案「{name}」', { name: r.scheme ? r.scheme.name : name }));
                } else {
                    _closeCreateScheme(card, input);
                    _schemeResult(r, AEI18n.t('已新建方案「{name}」', { name: name }));
                }
            });
        }
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', function () { submit(); });
    }

    function _closeCreateScheme(card, input) {
        card.classList.remove('editing');
        if (input.parentNode === card) card.removeChild(input);
    }

    function _schemeResult(r, okMsg) {
        if (!global.AEToast) return;
        // 草稿态（全局设置弹窗开着）：操作只预览，落盘要等「保存」，文案必须如实说明
        if (r && r.ok === true) global.AEToast.show(okMsg + (r.draft ? AEI18n.t('（预览中，保存后生效）') : ''), 'success');
        else global.AEToast.show((r && r.message) || AEI18n.t('操作失败'), 'error');
    }

    // 确认弹窗：组件缺席时**拒绝执行**（fail-closed）。删除方案不可撤销，
    // 不能走「没确认就删了」的路径——与桌宠面板删除、数据目录切换的既有口径一致。
    function _askConfirm(title, msg, beep) {
        if (typeof global.showConfirm === 'function') return global.showConfirm(title, msg, beep || 'confirm');
        if (global.AEToast) global.AEToast.show(AEI18n.t('当前环境不支持确认弹窗，操作已取消'), 'warn');
        return Promise.resolve(false);
    }

    function deleteScheme(s) {
        _askConfirm(AEI18n.t('删除配色方案'),
            AEI18n.t('确定删除方案「{name}」？{note}', {
                name: s.name,
                note: s.active ? AEI18n.t('它是当前生效方案，删除后面板回到默认主题。') : ''
            }),
            'danger').then(function (ok) {
            if (!ok) return null;
            return panelTheme.deletePreset(s.id);
        }).then(function (r) {
            if (r) _schemeResult(r, AEI18n.t('已删除方案「{name}」', { name: s.name }));
        });
    }

    // 调色面板滑块拖动预览绑定（开弹窗与 Agent 同步重填后都要重绑）
    function bindCustomThemeSliderPreview() {
        var ctSliders = document.querySelectorAll('#customThemePanel input[type="range"]');
        ctSliders.forEach(function (slider) {
            slider.addEventListener('pointerdown', function () {
                _ctDragging = true;
                document.body.classList.add('ct-previewing');
            });
        });
    }

    // 打开自定义主题弹窗（底色调色板取**当前生效色**，含草稿里的未保存改动）
    function openCustomThemeModal() {
        buildCustomThemePanel();
        var colors = _tempCustomColors
            || (panelTheme ? panelTheme.effectiveColors() : null)
            || activeGlobalSettings.customThemeColors;
        if (!colors) {
            colors = JSON.parse(JSON.stringify(THEME_PRESETS.default));
        }
        populateCustomThemePanel(colors);
        applyTheme('custom', colors);
        bindCustomThemeSliderPreview();
        openModal('customThemeModal');
    }

    // 确定关闭弹窗：把面板编辑结果**合并**进完整主题对象（调色面板只覆盖 26 项可编辑键，
    // 方案里的非白名单键必须保留）后交给 panelTheme 落盘。
    function closeCustomThemeModal() {
        var edited = readCustomThemeColorsFromUI();
        if (edited && panelTheme) {
            var merged = panelTheme.effectiveColors();
            for (var k in edited) {
                if (Object.prototype.hasOwnProperty.call(edited, k)) merged[k] = edited[k];
            }
            _tempCustomColors = merged;
        } else {
            _tempCustomColors = edited;
        }
        closeModal('customThemeModal');
        if (_tempCustomColors && panelTheme) {
            panelTheme.setColors(_tempCustomColors).then(function (r) {
                _tempCustomColors = null;
                if (r && r.ok === true && global.AEToast) {
                    global.AEToast.show(r.draft ? AEI18n.t('已更新配色（预览中，保存后生效）') : AEI18n.t('已更新当前配色方案'), 'success');
                } else if (r && r.ok !== true && global.AEToast) {
                    global.AEToast.show((r && r.message) || AEI18n.t('主题保存失败'), 'error');
                }
            });
        }
    }

    // 取消关闭弹窗（丢弃编辑，恢复已保存的预览）
    function cancelCustomThemeModal() {
        _tempCustomColors = null;
        var savedColors = activeGlobalSettings.customThemeColors;
        applyTheme(activeGlobalSettings.themePreset || 'default', savedColors);
        closeModal('customThemeModal');
    }

    // 背景叠加层：img 元素，opacity + mix-blend-mode
    function applyBgOverlay(settings) {
        var layer = document.getElementById('bgOverlayLayer');
        if (!layer) return;

        var img = settings.bgOverlayImage || '';
        var blend = settings.bgOverlayBlendMode || 'normal';
        var opacity = (settings.bgOverlayOpacity != null ? settings.bgOverlayOpacity : 30) / 100;
        var fill = settings.bgOverlayFillMode || 'cover';
        var ox = settings.bgOverlayOffsetX != null ? settings.bgOverlayOffsetX : 0;
        var oy = settings.bgOverlayOffsetY != null ? settings.bgOverlayOffsetY : 0;
        var scale = settings.bgOverlayScale != null ? settings.bgOverlayScale : 100;

        // 滤镜
        var filterParts = [];
        if (settings.bgOverlayGrayscale) filterParts.push('grayscale(100%)');
        var ct = settings.bgOverlayContrast != null ? settings.bgOverlayContrast : 100;
        if (ct !== 100) filterParts.push('contrast(' + ct + '%)');
        var filterStr = filterParts.length ? filterParts.join(' ') : '';

        // opacity + mix-blend-mode
        layer.style.opacity = opacity.toString();
        layer.style.mixBlendMode = blend;
        layer.style.filter = filterStr;
        layer.style.objectFit = (fill === 'cover' || fill === 'contain') ? fill : 'fill';
        layer.style.objectPosition = 'calc(50% + ' + ox + '%) calc(50% + ' + oy + '%)';
        layer.style.transform = scale !== 100 ? 'scale(' + (scale / 100) + ')' : '';

        if (img) {
            var dataDir = global.AEShared && typeof global.AEShared.getDataDir === 'function'
                ? global.AEShared.getDataDir().dir : '';
            var absPath = dataDir ? (dataDir.replace(/\\+$/, '') + '\\' + img.replace(/^\\+/, '')) : img;
            var imgUrl = global.AEShared && typeof global.AEShared.toFileUrl === 'function'
                ? global.AEShared.toFileUrl(absPath) : absPath;
            layer.src = imgUrl;
            layer.style.display = '';
        } else {
            layer.src = '';
            layer.style.display = 'none';
            layer.style.transform = '';
        }
    }

    // 清理 temp/bg-overlay 目录中未被 keepRel（相对路径）引用的图片。
    // 图片删除统一延后到保存/关闭时执行：换图/清除只改内存与预览，
    // 若立即删文件，未保存关闭时恢复的旧路径会指向已删除的文件，叠加层无法恢复。
    function _cleanBgOverlayDir(keepRel) {
        var dataDir = global.AEShared && typeof global.AEShared.getDataDir === 'function'
            ? global.AEShared.getDataDir().dir : '';
        if (!dataDir || typeof AEFS === 'undefined'
            || typeof AEFS.listFiles !== 'function' || typeof AEFS.deleteFile !== 'function') {
            return;
        }
        var dirAbs = dataDir.replace(/\\+$/, '') + '\\temp\\bg-overlay';
        var keepAbs = keepRel ? (dataDir.replace(/\\+$/, '') + '\\' + String(keepRel).replace(/^\\+/, '')) : '';
        AEFS.listFiles(dirAbs).then(function (names) {
            if (!Array.isArray(names)) return;
            names.forEach(function (name) {
                var fileAbs = dirAbs + '\\' + name;
                if (fileAbs !== keepAbs) {
                    try { AEFS.deleteFile(fileAbs); } catch (_) {}
                }
            });
        }).catch(function () {});
    }

    // ── 数据目录热切换：迁移成功后必须重载面板，新目录才真正生效 ──
    // memory/provider 走 getDataDir() 惰性取目录，但素材库三库
    // （assets/bootstrap.js 把 dataDir 字符串快照传给 refStore/projStore/presetStore，
    // UI mount 复用 _sharedStores）、Agent 会话 store（agent/engine/bootstrap.js）、
    // ComfyUI 画布 store（comfyui/canvas/canvasIndex.js mount）都在启动时固化目录。
    // 保存设置的热切换只做 migrateData + 切指针 + 通知 bridge，不重建这些 store：
    // 重载前新增素材/会话/画布仍写入旧目录，重启后「切换点之后的新增」形同消失，
    // 用户按旧提示删旧目录即永久丢失。故迁移成功且设置落盘后：无在跑任务/未发送
    // 草稿 → 延迟自动重载（bootstrap 按新设置初始化全部模块）；有 → 只提示，由
    // 用户稍后手动重载（不打断任务，也不静默写旧目录）。
    var PANEL_RELOAD_AFTER_MIGRATION_MS = 2000;   // 仅在「弹窗不可用」的退回路径使用（空闲自动重载）
    var PANEL_RELOAD_ON_CONFIRM_MS = 300;         // 用户点确认后：留一点时间让弹窗关闭动画走完

    // 在跑任务 / 未发送草稿探测：返回原因清单（空数组 = 可安全重载）
    function _panelReloadBusyReasons() {
        var reasons = [];
        // ① Agent 正在跑一轮（LLM 流式/工具执行；bridge.isBusy 是引擎对外门面）
        try {
            var br = global.AEEngine && global.AEEngine.bridge;
            if (br && typeof br.isBusy === 'function' && br.isBusy()) reasons.push(AEI18n.t('Agent 任务正在执行'));
        } catch (_) {}
        // ② Agent 注入队列还有未发送消息（内存队列，重载即丢）
        try {
            var br2 = global.AEEngine && global.AEEngine.bridge;
            var q = (br2 && typeof br2.getInjectQueue === 'function') ? br2.getInjectQueue() : null;
            if (q && q.length > 0) reasons.push(AEI18n.t('Agent 有 {n} 条排队待发送消息', { n: q.length }));
        } catch (_) {}
        // ③ 未发送的输入草稿（输入框文本 / 待发送文件 chips）
        try {
            var input = document.getElementById('aeAgentInput');
            if (input && typeof input.value === 'string' && input.value.trim()) reasons.push(AEI18n.t('Agent 输入框有未发送内容'));
        } catch (_) {}
        try {
            var chips = document.getElementById('aeAgentFileChips');
            if (chips && chips.children && chips.children.length > 0) reasons.push(AEI18n.t('Agent 有未发送的附件'));
        } catch (_) {}
        // ④ ComfyUI 画布有生成中的任务
        try {
            var mgr = global.AEComfyUI && global.AEComfyUI._genSessionManager;
            var active = (mgr && typeof mgr.getActiveSessions === 'function') ? mgr.getActiveSessions() : null;
            if (active && active.length > 0) reasons.push(AEI18n.t('ComfyUI 有 {n} 个生成任务进行中', { n: active.length }));
        } catch (_) {}
        return reasons;
    }

    // 调度一次 location.reload()（延迟 ms 后执行；环境不支持返回 false）
    function _schedulePanelReload(ms) {
        try {
            if (typeof location === 'undefined' || !location || typeof location.reload !== 'function') return false;
            setTimeout(function () {
                try { location.reload(); } catch (_) {}
            }, ms);
            return true;
        } catch (_) { return false; }
    }

    /**
     * 数据目录迁移成功后的**重载确认**（弹窗把迁移详情与「需要重载」讲清楚，
     * **点确认才重载**）。
     * 保存链经 global.__aePromptReloadAfterDataDirMigration 调用（保存处理器会被单测切片
     * 求值，只能经 global 注入；测试可桩掉本函数）。
     * @param {string} detail — 迁移详情（已迁移 N 项 / 未迁移清单 / 覆盖删除数）
     * @param {string} oldDir / newDir — 旧、新数据根
     * @returns {Promise<{reloaded:boolean, busy:string[], viaModal:boolean}>}
     *   reloaded=true：用户已确认（或弹窗不可用的退回路径已调度）→ location.reload() 即将发生；
     *   用户点取消 → reloaded=false 且 busy 为在跑任务清单（如实告知、不落盘任何自动动作）。
     */
    function _promptReloadAfterDataDirMigration(detail, oldDir, newDir) {
        var busy = _panelReloadBusyReasons();
        var head = AEI18n.t('数据已迁移至：{dir}（{detail}）。', { dir: newDir, detail: detail });
        var tail = AEI18n.t('重载前面板新增的内容仍会写入旧目录，请勿删除旧目录：{dir}。重载后请核对数据无误，再手动删除旧目录。',
            { dir: oldDir });
        // 弹窗不可用（Agent 模态未挂载/环境不支持）→ 退回旧行为：空闲延迟自动重载；忙则只提示
        if (typeof global.showConfirm !== 'function') {
            var fb = head + AEI18n.t('重载面板前新数据仍会写入旧目录，请勿删除旧目录：{dir}。重载后请核对数据无误再手动删除旧目录。',
                { dir: oldDir });
            if (busy.length) {
                if (global.AEToast) {
                    global.AEToast.show(fb + AEI18n.t('检测到') + busy.join(AEI18n.punct('；', '; ', '、')) + AEI18n.t('，本次未自动重载，请稍后手动重载面板。'), 'warn', { autoHideMs: 0 });
                }
                return Promise.resolve({ reloaded: false, busy: busy, viaModal: false });
            }
            var scheduled = _schedulePanelReload(PANEL_RELOAD_AFTER_MIGRATION_MS);
            if (global.AEToast) {
                global.AEToast.show(fb + (scheduled ? AEI18n.t('面板即将自动重载。') : ''), scheduled ? 'success' : 'warn', { autoHideMs: 0 });
            }
            return Promise.resolve({ reloaded: scheduled, busy: scheduled ? [] : [AEI18n.t('当前环境不支持自动重载')], viaModal: false });
        }
        // 必须明确写出「点按钮会发生什么」——按钮实际标签是
        // 「确定」/「取消」，正文与标题都用真实标签说清：点确定＝立即重载面板（重启），
        // 点取消＝不重载、面板继续按旧目录读写。
        var modalMsg = AEI18n.t('点「确定」：立即重载面板（重启后按新数据目录初始化，三库/会话/画布随之切换）。\n点「取消」：暂不重载，面板继续按旧目录读写，稍后可手动重载。\n\n')
            + head + '\n\n' + tail;
        if (busy.length) {
            modalMsg += '\n\n' + AEI18n.t('检测到：{busy}。点「确定」将立即重载并中断这些任务。',
                { busy: busy.join(AEI18n.punct('；', '; ', '、')) });
        }
        return Promise.resolve(global.showConfirm(AEI18n.t('数据已迁移 — 点「确定」重载面板'), modalMsg, 'confirm'))
            .then(function (ok) {
                if (ok) {
                    var okScheduled = _schedulePanelReload(PANEL_RELOAD_ON_CONFIRM_MS);
                    // 环境不支持自动重载时不得静默——用户以为按了确定就会重载，
                    // 实际什么都没发生（迁移后不重载 = 继续按旧目录读写）
                    if (!okScheduled && global.AEToast) {
                        global.AEToast.show(head + AEI18n.t('当前环境不支持自动重载，请手动重载面板（重载前请勿删除旧目录：') + oldDir + AEI18n.punct('）。', ').'), 'warn', { autoHideMs: 0 });
                    }
                    return { reloaded: okScheduled, busy: busy, viaModal: true };
                }
                // 取消：不重载（面板继续按旧目录写），但把安全提醒留下——旧目录在新数据落定前不能删
                if (global.AEToast) {
                    global.AEToast.show(head + AEI18n.t('本次未重载面板，新增内容仍会写入旧目录，请勿删除旧目录：') + oldDir
                        + AEI18n.t('；重载并核对数据无误后再删除。'), 'warn', { autoHideMs: 0 });
                }
                return { reloaded: false, busy: busy, viaModal: true };
            }, function () {
                return { reloaded: false, busy: busy, viaModal: true };
            });
    }
    // 挂 global 供保存链处理器访问（处理器切片求值时 global 由调用方注入）
    global.__aePromptReloadAfterDataDirMigration = _promptReloadAfterDataDirMigration;

    // 从容器上下文获取统一设置仓库（全局/模块设置都通过它持久化）
    // 容器尚未创建时回退 earlySettingsStore：启动期同步数据目录（任何模块 init 之前）
    // 就需要读全局设置，此时 appContainer 仍为 null，不能因此拿到空仓库退化成默认目录
    function getSettingsStore() {
        if (appContainer) {
            var ctxStore = appContainer.getContext().settingsStore;
            if (ctxStore) return ctxStore;
        }
        return earlySettingsStore;
    }

    function readGlobalSettingsPatch() {
        try {
            var raw = localStorage.getItem(GLOBAL_SETTINGS_PATCH_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (_) {
            return {};
        }
    }

    function getGlobalSettingsPatch(next) {
        next = next || {};
        // 刻意**不含**主题键（themePreset / customThemeColors）：主题的唯一事实源是 panelTheme，
        // 而 loadGlobalSettings 会把本 patch 合并**覆盖**在 store 之上——一旦这里残留主题键，
        // 一个陈旧的 patch 就能在每次启动时遮蔽 panelTheme 的结果。
        return {
            debugMode: !!next.debugMode,
            dataDir: next.dataDir || '',
            soundVolume: typeof next.soundVolume === 'number' ? next.soundVolume : 1,
            uiLocale: next.uiLocale || 'auto',
        };
    }

    function writeGlobalSettingsPatch(next) {
        try {
            localStorage.setItem(GLOBAL_SETTINGS_PATCH_KEY, JSON.stringify(getGlobalSettingsPatch(next)));
        } catch (_) {}
    }

    function clearGlobalSettingsPatch() {
        try { localStorage.removeItem(GLOBAL_SETTINGS_PATCH_KEY); } catch (_) {}
    }

    // 读取全局设置；当设置仓库不可用时回退到默认值
    async function loadGlobalSettings() {
        const store = getSettingsStore();
        var settings;
        if (!store || typeof store.getGlobalSettings !== 'function') {
            settings = { ...GLOBAL_DEFAULTS };
        } else {
            settings = await store.getGlobalSettings(GLOBAL_DEFAULTS);
        }
        var patch = readGlobalSettingsPatch();
        return { ...settings, ...patch };
    }

    // 写入全局设置到持久层（供所有模块共享）
    // 返回写入结果 true/false——settingsStore.writeRaw 捕获 localStorage 配额满/
    // 加密异常后返回 false，此处透传给调用方（保存回调据此保持弹窗开启 + error toast，
    // 不再静默当作保存成功）；patch 仅在真正写入成功后清除
    async function saveGlobalSettings(next) {
        const store = getSettingsStore();
        if (!store || typeof store.setGlobalSettings !== 'function') {
            // 设置仓库不可用分支按失败返回 false——裸 return undefined 时调用方 if (saved === false)
            // 判不出失败（undefined 被当成功继续走关弹窗/成功提示）。仅落了 localStorage
            // patch 兜底不算完整持久化，按失败返回 false（当前时序 appContainer 先于设置
            // 弹窗可用、settingsStore 恒注入，此分支实际不可达，防未来回归）
            writeGlobalSettingsPatch(next);
            return false;
        }
        const ok = await store.setGlobalSettings(next);
        if (ok === false) return false;
        clearGlobalSettingsPatch();
        return true;
    }

    // 弹窗代际守卫：closeModal 的 220ms 过渡定时器不可取消，关闭后 220ms 内重开
    // 同一弹窗会被迟到定时器 display='none' 隐藏（逻辑已开、视觉不可见，"点了没反应"）。
    // openModal 递增代际使在途关闭定时器失效；closeModal 的定时器只在本代际仍是自己时生效。
    const _modalGen = {};

    // 打开指定遮罩弹窗并触发过渡动画
    function openModal(maskId) {
        const mask = document.getElementById(maskId);
        if (!mask) {
            return;
        }
        if (typeof aeBeep === 'function') aeBeep('open');
        _modalGen[maskId] = (_modalGen[maskId] || 0) + 1;
        mask.style.display = 'flex';
        requestAnimationFrame(() => {
            mask.style.opacity = '1';
            const modal = mask.querySelector('.modal');
            if (modal) {
                modal.style.opacity = '1';
                modal.style.transform = 'translateY(0) scale(1)';
            }
        });
    }

    function closeModal(maskId) {
        const mask = document.getElementById(maskId);
        if (!mask) {
            return;
        }
        if (typeof aeBeep === 'function') aeBeep('close');
        const modal = mask.querySelector('.modal');
        mask.style.opacity = '0';
        if (modal) {
            modal.style.opacity = '0';
            modal.style.transform = 'translateY(10px) scale(.98)';
        }
        const gen = _modalGen[maskId] = (_modalGen[maskId] || 0) + 1;
        setTimeout(() => {
            if (_modalGen[maskId] !== gen) return;
            mask.style.display = 'none';
        }, 220);
    }

    function showAboutModal(type, moduleInfo) {
        const mask = document.getElementById('aboutModal');
        const titleEl = document.getElementById('aboutTitle');
        const bodyEl = document.getElementById('aboutBody');
        if (!mask || !titleEl || !bodyEl) return;

        var extVersion = '1.0.4';
        var moduleVersion = '1.0';

        if (type === 'extension') {
            titleEl.textContent = AEI18n.t('关于扩展平台');
            bodyEl.innerHTML =
              '<div class="about-info">' +
              '<div class="about-section">' +
              AEI18n.html('<h4>扩展平台信息</h4>') +
              AEI18n.html('<p>平台名称：<span class="val">AS_ExtP 扩展平台</span></p>') +
              AEI18n.html('<p>平台版本：<span class="val">v') + extVersion + '</span></p>' +
              AEI18n.html('<p>适用软件：<span class="val">Adobe After Effects</span></p>') +
              AEI18n.html('<p>技术栈：<span class="val">CEP + Node.js + LLM</span></p>') +
              '</div>' +
              '<div class="about-disclaimer">' +
              AEI18n.html('<strong>AI 免责声明</strong><br>') +
              AEI18n.t('本平台集成大型语言模型（LLM）生成 After Effects 脚本代码。AI 生成的代码可能存在错误、') +
              AEI18n.t('不符合最佳实践或导致意外行为。请在运行生成的脚本前仔细审查代码，并在安全环境中进行测试。') +
              AEI18n.t('开发者不对因使用本平台生成的代码而造成的任何数据丢失、项目损坏或其他损失承担责任。') +
              AEI18n.t('使用本平台即表示您同意自行承担所有风险。') +
              '</div>' +
              '</div>';
        } else {
            var name = (moduleInfo && moduleInfo.name) || AEI18n.t('模块');
            var desc = (moduleInfo && moduleInfo.desc) || AEI18n.t('功能模块');
            titleEl.textContent = AEI18n.t('关于模块');
            bodyEl.innerHTML =
              '<div class="about-info">' +
              '<div class="about-section">' +
              AEI18n.html('<h4>模块信息</h4>') +
              AEI18n.html('<p>模块名称：<span class="val">') + name + '</span></p>' +
              AEI18n.html('<p>模块版本：<span class="val">v') + moduleVersion + '</span></p>' +
              AEI18n.html('<p>功能：<span class="val">') + desc + '</span></p>' +
              '</div>' +
              '<div class="about-disclaimer">' +
              AEI18n.html('<strong>AI 免责声明</strong><br>') +
              AEI18n.t('本模块使用大型语言模型（LLM）生成 After Effects 脚本代码。AI 生成的代码可能存在错误、') +
              AEI18n.t('不符合最佳实践或导致意外行为。请在运行生成的脚本前仔细审查代码，并在安全环境中进行测试。') +
              AEI18n.t('开发者不对因使用本模块生成的代码而造成的任何数据丢失、项目损坏或其他损失承担责任。') +
              AEI18n.t('使用本模块即表示您同意自行承担所有风险。') +
              '</div>' +
              '</div>';
        }

        openModal('aboutModal');
    }

    // —— 热盒快捷键（面板侧）：热盒被热键冲突卡死弹不出时，在全局设置改键自救——
    // 事实源是 <数据目录>\hotbox\config.json，唯一写者为 AEGP：面板只写
    // hotkey-request.json 请求文件（AEGP IdleHook 空闲时处理，删文件 = 应答信号），
    // 保存后轮询请求文件消失 → 读 config.json 实际组合 → toast 反馈（含回退结果）。
    var _hotkeyPending = null;    // 待保存组合 {mods, vk}（保存时写请求；未保存关闭丢弃）
    var _hotkeyRecording = false; // 录制中：document keydown（capture）吞键，防泄漏给其他快捷键处理器
    var _hotboxNativeMissing = false; // 热盒原生件缺位（置灰态；_refreshHotkeyInput 据此不回填）
    var _hotkeyPollTimer = 0;     // 保存后反馈轮询句柄（600ms × 8，随弹窗关闭清理）
    var _hotkeyHintTimer = 0;     // "需包含修饰键"提示的短暂回显计时器

    // 组合显示（与 C++ describeKeys 对齐：Ctrl+Alt+Shift 顺序；字母/数字/F1-F12/空格）
    function _fmtHotkey(mods, vk) {
        var s = '';
        if (mods & 2) s += 'Ctrl+';
        if (mods & 1) s += 'Alt+';
        if (mods & 4) s += 'Shift+';
        if (vk >= 65 && vk <= 90) s += String.fromCharCode(vk);
        else if (vk >= 48 && vk <= 57) s += String.fromCharCode(vk);
        else if (vk >= 112 && vk <= 123) s += 'F' + (vk - 111);
        else if (vk === 32) s += AEI18n.t('空格');
        else s += String(vk);
        return s;
    }

    // 读 config.json 当前组合回填输入框（null → 清空，显示 placeholder "Alt+Q（默认）"）
    // 热盒原生件缺位时**不回填**——输入框内显示缺件提示（见 _applyHotboxNativeGate）
    function _refreshHotkeyInput() {
        if (_hotboxNativeMissing) return;
        var el = document.getElementById('globalHotboxHotkey');
        if (!el) return;
        var hk = (global.AEShared && typeof global.AEShared.readHotboxHotkey === 'function')
            ? global.AEShared.readHotboxHotkey() : null;
        el.value = hk ? _fmtHotkey(hk.mods, hk.vk) : '';
    }

    function _stopHotkeyFeedbackPoll() {
        if (_hotkeyPollTimer) {
            clearInterval(_hotkeyPollTimer);
            _hotkeyPollTimer = 0;
        }
    }

    // 保存后反馈轮询：请求文件消失 = AEGP 已处理 → 读 config.json 实际组合对比请求，
    // 相同 → 已生效；不同 → 冲突回退（AEGP 三级回退：新组合→默认→保留原组合），如实展示。
    // 超时（AE 忙碌/插件未加载）→ 请求文件保留，AE 空闲后仍会被处理，不丢请求。
    // 终止判定加**三态复核**——hotboxRequestExists 走 existsSync（把通道故障折叠成
    // false =「已处理」），故障瞬间会读到一个尚未生效的配置并误报「组合被占用，已回退为…」。
    // 现在只有 existsResult 明确 NOT_FOUND 才认定「已处理」并读配置；探不到就继续等，
    // 由 ticks 上限给出诚实的「AE 忙碌或插件未加载」提示。
    function _finishHotkeyPoll(req) {
        var cur = (global.AEShared && typeof global.AEShared.readHotboxHotkey === 'function')
            ? global.AEShared.readHotboxHotkey() : null;
        if (cur && cur.mods === req.mods && cur.vk === req.vk) {
            if (global.AEToast) global.AEToast.show(AEI18n.t('热盒快捷键已生效：') + _fmtHotkey(req.mods, req.vk), 'success');
        } else {
            var eff = cur ? _fmtHotkey(cur.mods, cur.vk) : AEI18n.t('Alt+Q（默认）');
            if (global.AEToast) global.AEToast.show(AEI18n.t('组合被占用，已回退为：') + eff, 'warn');
        }
    }

    function _hotkeyPollTimeout() {
        _stopHotkeyFeedbackPoll();
        if (global.AEToast) global.AEToast.show(AEI18n.t('AE 忙碌或插件未加载，请求已保存，AE 空闲时自动生效'), 'warn');
    }

    function _startHotkeyFeedbackPoll(req) {
        _stopHotkeyFeedbackPoll();
        var ticks = 0;
        var confirming = false;
        _hotkeyPollTimer = setInterval(function () {
            ticks++;
            var exists = global.AEShared && typeof global.AEShared.hotboxRequestExists === 'function'
                && global.AEShared.hotboxRequestExists();
            if (exists) {
                if (ticks >= 8) _hotkeyPollTimeout();
                return;
            }
            if (confirming) return;                    // 复核在途：不重复发起
            var reqPath = (global.AEShared && typeof global.AEShared.hotboxRequestPath === 'function')
                ? global.AEShared.hotboxRequestPath() : '';
            if (!reqPath || typeof AEFS === 'undefined' || typeof AEFS.existsResult !== 'function') {
                _stopHotkeyFeedbackPoll();             // 无三态能力（旧 mock/异常环境）→ 旧行为
                _finishHotkeyPoll(req);
                return;
            }
            confirming = true;
            AEFS.existsResult(reqPath).then(function (r) {
                confirming = false;
                var trulyGone = !!(r && r.ok === false && r.error && r.error.code === 'NOT_FOUND');
                if (!trulyGone) {
                    if (ticks >= 8) _hotkeyPollTimeout();   // 还在/探不到 → 不误报，按超时如实提示
                    return;
                }
                _stopHotkeyFeedbackPoll();
                _finishHotkeyPoll(req);
            }, function () {
                confirming = false;
                if (ticks >= 8) _hotkeyPollTimeout();
            });
        }, 600);
    }

    // ── 热盒原生件探测 ────────────
    // 缺件（AS_Hotbox.aex 不在 AE 的 Plug-ins 下——从源码安装、或没重跑 install.bat）时：
    // ① 「热盒快捷键」输入框与录制/默认两键**真置灰**（disabled + CSS 视觉降透明度，
    //    仅设 disabled 在本面板样式下看不出差别）；
    // ② 缺件提示语**放进输入框内**（placeholder 承载，不再单独占一行）。
    // 探测器在宿主侧（probeNativeHotbox，app.path 下 Plug-ins 按存在性择优）；三态——
    // HOTBOX_MISSING 置灰 / HOTBOX_OK 还原 / 其它（UNKNOWN、探测不可用）不动 UI（失败开放：
    // 旧版宿主、evalScript 超时都不该把可用功能置灰）。
    // 说明：函数体只认字面量 id 与字面量文案（不引外部常量）——保证「按标记提取 + 受控 DOM
    // 执行」可测，也避免提取执行时因作用域缺失被 catch 静默吞掉。
    function _applyHotboxNativeGate(state) {
        try {
            var input = document.getElementById('globalHotboxHotkey');
            var recordBtn = document.getElementById('recordHotboxHotkeyBtn');
            var resetBtn = document.getElementById('resetHotboxHotkeyBtn');
            if (state === 'HOTBOX_MISSING') {
                _hotboxNativeMissing = true;
                if (input) {
                    input.disabled = true;
                    input.value = '';   // 清空值 → 输入框内显示缺件提示（placeholder 承载）
                    input.placeholder = AEI18n.t('未安装热盒组件（AS_Hotbox.aex）');
                }
                if (recordBtn) recordBtn.disabled = true;
                if (resetBtn) resetBtn.disabled = true;
            } else if (state === 'HOTBOX_OK') {
                _hotboxNativeMissing = false;
                if (input) {
                    input.disabled = false;
                    input.placeholder = AEI18n.t('Alt+Q（默认）');
                }
                if (recordBtn) recordBtn.disabled = false;
                if (resetBtn) resetBtn.disabled = false;
            }
        } catch (_) {}
    }

    function _probeHotboxNative() {
        try {
            var hostApi = global.AEPlatform && global.AEPlatform.hostApi;
            if (!hostApi || typeof hostApi.call !== 'function') return;
            hostApi.call('(function(){return (typeof probeNativeHotbox==="function")?probeNativeHotbox():"HOTBOX_UNKNOWN";})();', 4000)
                .then(function (resp) {
                    var r = (resp && typeof resp === 'object' && resp.result !== undefined) ? resp.result : resp;
                    _applyHotboxNativeGate(String(r == null ? '' : r));
                }, function () {});
        } catch (_) {}
    }

    // ── 数据目录迁移进度弹窗（单独一个进度条弹窗）──────────────
    // 迁移（覆盖删除每项一次回收站 PowerShell + 整份复制）要数秒；只在完成后才弹
    // 重载确认，用户看着像卡住。这里在迁移期间显示进度，结束（成功/失败）即隐藏。
    // 说明：函数体只认字面量 id（不引外部常量）——保持「按标记提取 + 受控 DOM 执行」可测。
    function _showDataDirProgress() {
        try {
            var mask = document.getElementById('dataDirProgressModal');
            if (mask) {
                mask.style.display = 'flex';
                // `.modal-mask` CSS 默认 opacity:0，
                // 只设 display 会得到一个**看不见但仍挡点击**的透明遮罩（迁移期间面板点不动）。
                // 按 openModal 的同款做法显式置 1，并复位内层 .modal（closeModal 会写 0/位移）。
                mask.style.opacity = '1';
                var box = mask.querySelector('.modal');
                if (box) {
                    box.style.opacity = '1';
                    box.style.transform = 'translateY(0) scale(1)';
                }
                console.log('[Main] 迁移进度弹窗：显示');
            }
            _updateDataDirProgress({ phase: 'start', done: 0, total: 0 });
            _startDataDirProgressWatchdog();   // 停滞看门狗（20s 无事件 → 弹窗内给提示）
        } catch (_) {}
    }
    function _updateDataDirProgress(ev) {
        // 有进度事件即视为"活着"——复位看门狗并收掉停滞提示
        _dataDirProgressLastEvAt = Date.now();
        try {
            var _hintEl = document.getElementById('dataDirProgressHint');
            if (_hintEl && _hintEl.style.display !== 'none') _hintEl.style.display = 'none';
        } catch (_) {}
        try {
            var bar = document.getElementById('dataDirProgressBar');
            var txt = document.getElementById('dataDirProgressText');
            var total = (ev && typeof ev.total === 'number') ? ev.total : 0;
            var done = (ev && typeof ev.done === 'number') ? ev.done : 0;
            // 无极值夹具：total 未知时给一条 4% 的“活动”条（有事件就动，不假装百分比）
            var pct = total > 0 ? Math.max(4, Math.min(100, Math.round(done / total * 100))) : 4;
            if (bar) bar.style.width = pct + '%';
            if (txt) {
                var label = (ev && ev.phase === 'delete') ? AEI18n.t('正在删除目标目录数据')
                    : (ev && ev.phase === 'copy') ? AEI18n.t('正在复制数据') : AEI18n.t('准备中');
                txt.textContent = label + (total > 0 ? '（' + done + '/' + total + '）' : '…');
            }
        } catch (_) {}
    }
    function _hideDataDirProgress() {
        _stopDataDirProgressWatchdog();
        try {
            var mask = document.getElementById('dataDirProgressModal');
            if (mask) {
                mask.style.display = 'none';
                mask.style.opacity = '0';
                console.log('[Main] 迁移进度弹窗：收起');
            }
        } catch (_) {}
    }

    // ── 进度停滞看门狗 + 逃生口 ─────────────────────────────────────────
    // 病灶（记账）：bridge 异步调用无超时，桥「TCP 可连但不响应」时 migrateData
    // 永不 settle → finally 不执行 → 这个全屏进度遮罩**永久卡死且无取消入口**（只能杀面板）。
    // 处置（不假装失败）：① 看门狗——超过 20s 没有进度事件就在弹窗里给出可操作提示；
    // ② 「关闭」按钮只收起弹窗（不取消迁移：迁移可能仍在后台进行，完成后照常弹重载确认）。
    // 为什么不给迁移加超时：整份复制大目录可能合法地跑很久，超时判失败会误报。
    var _dataDirProgressWatchdog = 0;
    var _dataDirProgressLastEvAt = 0;
    var _DATA_DIR_PROGRESS_STALL_MS = 20000;
    function _stopDataDirProgressWatchdog() {
        if (_dataDirProgressWatchdog) { clearInterval(_dataDirProgressWatchdog); _dataDirProgressWatchdog = 0; }
    }
    function _startDataDirProgressWatchdog() {
        _stopDataDirProgressWatchdog();
        _dataDirProgressLastEvAt = Date.now();
        _dataDirProgressWatchdog = setInterval(function () {
            try {
                if (Date.now() - _dataDirProgressLastEvAt < _DATA_DIR_PROGRESS_STALL_MS) return;
                var hint = document.getElementById('dataDirProgressHint');
                if (hint) {
                    hint.textContent = AEI18n.t('已有 20 秒没有新进度——桥可能无响应（卡在旧副本上）。')
                        + AEI18n.t('可以点「关闭」继续使用面板：迁移若仍在后台进行，完成后会照常提示。');
                    hint.style.display = 'block';
                }
            } catch (_) {}
        }, 2000);
    }
    // 逃生口接线（放在进度弹窗助手旁边；测试沙箱里该元素为 null → 静默跳过）
    (function () {
        try {
            var closeBtn = document.getElementById('dataDirProgressCloseBtn');
            if (!closeBtn || typeof closeBtn.addEventListener !== 'function') return;
            closeBtn.addEventListener('click', function () {
                console.warn('[Main] 用户手动关闭迁移进度弹窗（迁移可能仍在后台进行；不取消迁移）');
                _hideDataDirProgress();
            });
        } catch (_) {}
    })();

    // ── 迁移失败文案按原因分派 ─────────────────────────────────────────
    // 病灶：除 TARGET_HAS_DATA 外一律追加「请检查路径是否存在、是否可写」，
    // 对「目标文件被占用删不掉」「清单读不到（通道故障）」「互为父子」等情形答非所问，
    // 把排查引向错方向（与数据根归因同族）。code 由 dataDir.migrateData 给出；
    // 未列出的 code / 无 code → 保留原兜底文案（宁可泛化，不可误导）。
    // 一致性闸：本表键与 dataDir 里出现的 code 须双向覆盖。
    function _dataDirMigrateErrTail(result) {
        var code = (result && result.code) ? String(result.code) : '';
        var tails = {
            TARGET_HAS_DATA: AEI18n.t('。请重新点击保存，按弹窗确认覆盖。'),
            TARGET_NESTED: AEI18n.t('。目标与当前数据目录互为父子，请另选一个独立目录。'),
            DELETE_FAILED: AEI18n.t('。目标里的文件删不掉（可能被其它程序占用）；已中止且未拷贝，关闭占用后可重试。'),
            COPY_FAILED: AEI18n.t('。有文件没能复制过去（可能被占用/权限不足）；旧目录未动，处理后可重试。'),
            SOURCE_UNREADABLE: AEI18n.t('。读不到当前数据目录的内容清单（可能是桥/数据层通道故障）；已中止，未拷贝也未删除。'),
            TARGET_UNREADABLE: AEI18n.t('。读不到目标目录的内容清单（可能是桥/数据层通道故障）；已中止，未拷贝也未删除。'),
            NO_DELETE_CAPABILITY: AEI18n.t('。当前环境缺少删除能力，无法安全覆盖；未改动任何数据。')
        };
        return tails[code] || AEI18n.t('，请检查路径是否存在、是否可写。');
    }

    // 将当前全局设置回填到主面板设置表单，并立即应用主题
    function applyGlobalSettingsToUI() {
        const themeEl = document.getElementById('globalThemePreset');
        const debugBtn = document.getElementById('globalDebugToggleBtn');
        const lowPerfBtn = document.getElementById('globalLowPerfToggleBtn');

        if (themeEl) {
            themeEl.value = activeGlobalSettings.themePreset || 'default';
        }
        var localeEl = document.getElementById('globalUiLocale');
        if (localeEl && localeEl.options.length === 0) {
            // Chrome 88：静态 <option> 在隐藏容器里会重置选中值，选项一律运行时创建。
            // auto 的文案随界面语言变化；语言自称（简体中文/English/日本語/Deutsch/한국어/…）不翻译。
            var autoLabel = global.AEI18n ? global.AEI18n.t('跟随 After Effects 界面语言') : '跟随 After Effects 界面语言';
            var opts = [['auto', autoLabel], ['zh-CN', '简体中文'], ['en-US', 'English'], ['ja-JP', '日本語'], ['de-DE', 'Deutsch'], ['ko-KR', '한국어'], ['fr-FR', 'Français'], ['ru-RU', 'Русский']];
            for (var li = 0; li < opts.length; li++) {
                var o = document.createElement('option');
                o.value = opts[li][0];
                o.textContent = opts[li][1];
                localeEl.appendChild(o);
            }
        }
        if (localeEl) localeEl.value = activeGlobalSettings.uiLocale || 'auto';
        if (debugBtn) {
            debugBtn.checked = !!activeGlobalSettings.debugMode;
        }
        if (lowPerfBtn) {
            lowPerfBtn.checked = !!activeGlobalSettings.lowPerfMode;
        }
        var dataDirEl = document.getElementById('globalDataDir');
        if (dataDirEl) dataDirEl.value = activeGlobalSettings.dataDir || '';

        var volEl = document.getElementById('globalSoundVolume');
        if (volEl) {
            volEl.value = Math.round((activeGlobalSettings.soundVolume != null ? activeGlobalSettings.soundVolume : 1) * 100);
        }
        var volLabel = document.getElementById('globalSoundVolumeLabel');
        if (volLabel) {
            volLabel.textContent = Math.round((activeGlobalSettings.soundVolume != null ? activeGlobalSettings.soundVolume : 1) * 100) + '%';
        }
        global.__aeSoundVolume = activeGlobalSettings.soundVolume != null ? activeGlobalSettings.soundVolume : 1;

        // 背景叠加层设置回填
        var bgPathEl = document.getElementById('globalBgOverlayPath');
        if (bgPathEl) bgPathEl.value = activeGlobalSettings.bgOverlayImage || '';
        var bgOpacityEl = document.getElementById('globalBgOverlayOpacity');
        if (bgOpacityEl) bgOpacityEl.value = activeGlobalSettings.bgOverlayOpacity != null ? activeGlobalSettings.bgOverlayOpacity : 30;
        var bgOpacityLabel = document.getElementById('globalBgOverlayOpacityLabel');
        if (bgOpacityLabel) bgOpacityLabel.value = activeGlobalSettings.bgOverlayOpacity != null ? activeGlobalSettings.bgOverlayOpacity : 30;
        var bgContrastEl = document.getElementById('globalBgOverlayContrast');
        if (bgContrastEl) bgContrastEl.value = activeGlobalSettings.bgOverlayContrast != null ? activeGlobalSettings.bgOverlayContrast : 100;
        var bgContrastLabel = document.getElementById('globalBgOverlayContrastLabel');
        if (bgContrastLabel) bgContrastLabel.value = activeGlobalSettings.bgOverlayContrast != null ? activeGlobalSettings.bgOverlayContrast : 100;
        var bgBlendEl = document.getElementById('globalBgOverlayBlend');
        if (bgBlendEl) bgBlendEl.value = activeGlobalSettings.bgOverlayBlendMode || 'normal';
        var bgFillEl = document.getElementById('globalBgOverlayFill');
        if (bgFillEl) bgFillEl.value = activeGlobalSettings.bgOverlayFillMode || 'cover';
        var bgGrayscaleEl = document.getElementById('globalBgOverlayGrayscale');
        if (bgGrayscaleEl) bgGrayscaleEl.checked = !!activeGlobalSettings.bgOverlayGrayscale;
        var bgOffsetXEl = document.getElementById('globalBgOverlayOffsetX');
        if (bgOffsetXEl) bgOffsetXEl.value = activeGlobalSettings.bgOverlayOffsetX != null ? activeGlobalSettings.bgOverlayOffsetX : 0;
        var bgOffsetXLabel = document.getElementById('globalBgOverlayOffsetXLabel');
        if (bgOffsetXLabel) bgOffsetXLabel.value = activeGlobalSettings.bgOverlayOffsetX != null ? activeGlobalSettings.bgOverlayOffsetX : 0;
        var bgOffsetYEl = document.getElementById('globalBgOverlayOffsetY');
        if (bgOffsetYEl) bgOffsetYEl.value = activeGlobalSettings.bgOverlayOffsetY != null ? activeGlobalSettings.bgOverlayOffsetY : 0;
        var bgOffsetYLabel = document.getElementById('globalBgOverlayOffsetYLabel');
        if (bgOffsetYLabel) bgOffsetYLabel.value = activeGlobalSettings.bgOverlayOffsetY != null ? activeGlobalSettings.bgOverlayOffsetY : 0;
        var bgScaleEl = document.getElementById('globalBgOverlayScale');
        if (bgScaleEl) bgScaleEl.value = activeGlobalSettings.bgOverlayScale != null ? activeGlobalSettings.bgOverlayScale : 100;
        var bgScaleLabel = document.getElementById('globalBgOverlayScaleLabel');
        if (bgScaleLabel) bgScaleLabel.value = activeGlobalSettings.bgOverlayScale != null ? activeGlobalSettings.bgOverlayScale : 100;

        applyTheme(activeGlobalSettings.themePreset || 'default');
        _tempCustomColors = null;
        toggleCustomThemePanel((activeGlobalSettings.themePreset || 'default') === 'custom');
        applyBgOverlay(activeGlobalSettings);
        // 同步数据目录设置
        if (global.AEShared && typeof global.AEShared.syncDataDirSetting === 'function') {
            global.AEShared.syncDataDirSetting(activeGlobalSettings.dataDir || '');
        }
        // 热盒快捷键：config.json 是事实源（AEGP 唯一写者），每次回填重读。
        // 须在 syncDataDirSetting 之后读（getDataDir 跟随已同步的设置，否则启动首拍读旧目录）；
        // 同时清录制/待保存状态（打开弹窗、未保存关闭、保存完成三条路径都经过这里）
        _hotkeyPending = null;
        _hotkeyRecording = false;
        _refreshHotkeyInput();
        // 回填用的下拉框为程序化赋值（不触发 change），customSelect 不会感知，
        // 需手动刷新自定义下拉的可见文案，否则重进仍显示上次手动选的未保存主题
        if (typeof global.refreshCustomSelect === 'function') {
            ['globalThemePreset', 'globalBgOverlayBlend', 'globalBgOverlayFill', 'globalUiLocale'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) global.refreshCustomSelect(el);
            });
        }
        renderSchemeList();
    }
    // 从全局设置表单读取扩展级设置。LLM Key/默认模型由「模型管理」模块维护。
    function readGlobalSettingsFromUI() {
        const debugBtn = document.getElementById('globalDebugToggleBtn');
        const dataDirEl = document.getElementById('globalDataDir');
        const lowPerfBtn = document.getElementById('globalLowPerfToggleBtn');
        var next = {};
        var k;
        for (k in activeGlobalSettings) {
            if (Object.prototype.hasOwnProperty.call(activeGlobalSettings, k)) {
                next[k] = activeGlobalSettings[k];
            }
        }
        // 主题键（themePreset / customThemeColors / customThemePresets / activeCustomThemePresetId）
        // **不从这里读**：唯一写入口是 panelTheme（手改颜色 → setColors，档位下拉 → 保存后的
        // setPresetKey），这里沿用 activeGlobalSettings 里已被 syncThemeState 同步的值。
        // 若在此写 next.themePreset，数据目录迁移那段 await 期间 Agent 的改动会被陈旧 DOM 值覆盖。
        // 直接读勾选框：拨动它不产生任何副作用（调试模式在保存时统一生效），
        // activeGlobalSettings.debugMode 只是上次保存的值
        next.debugMode = debugBtn ? !!debugBtn.checked : !!activeGlobalSettings.debugMode;
        next.dataDir = dataDirEl ? dataDirEl.value.trim() : '';
        next.lowPerfMode = lowPerfBtn ? !!lowPerfBtn.checked : !!activeGlobalSettings.lowPerfMode;
        var localeEl2 = document.getElementById('globalUiLocale');
        next.uiLocale = localeEl2 && localeEl2.value ? localeEl2.value : 'auto';
        var volEl = document.getElementById('globalSoundVolume');
        if (volEl) {
            next.soundVolume = Math.max(0, Math.min(1, parseInt(volEl.value, 10) / 100));
        } else {
            next.soundVolume = activeGlobalSettings.soundVolume != null ? activeGlobalSettings.soundVolume : 1;
        }
        // 背景叠加层设置读取（bgOverlayImage 由文件选择器写入 activeGlobalSettings，不从 UI 读取）
        // CP-4：数值字段 parseInt 无 NaN 防护——清空输入框时 parseInt('') = NaN，随保存
        // 序列化为 null 落盘（消费方拿 null 计算出错）。NaN 时不写入（保留
        // activeGlobalSettings 既有值，next 已从其拷贝），重开弹窗即恢复原值
        var bgOpacityEl = document.getElementById('globalBgOverlayOpacity');
        if (bgOpacityEl) {
            var bgOpacity = parseInt(bgOpacityEl.value, 10);
            if (!isNaN(bgOpacity)) next.bgOverlayOpacity = bgOpacity;
        }
        var bgContrastEl = document.getElementById('globalBgOverlayContrast');
        if (bgContrastEl) {
            var bgContrast = parseInt(bgContrastEl.value, 10);
            if (!isNaN(bgContrast)) next.bgOverlayContrast = bgContrast;
        }
        var bgBlendEl = document.getElementById('globalBgOverlayBlend');
        if (bgBlendEl) next.bgOverlayBlendMode = bgBlendEl.value;
        var bgFillEl = document.getElementById('globalBgOverlayFill');
        if (bgFillEl) next.bgOverlayFillMode = bgFillEl.value;
        var bgGrayscaleEl = document.getElementById('globalBgOverlayGrayscale');
        if (bgGrayscaleEl) next.bgOverlayGrayscale = !!bgGrayscaleEl.checked;
        var bgOffsetXEl = document.getElementById('globalBgOverlayOffsetX');
        if (bgOffsetXEl) {
            var bgOffsetX = parseInt(bgOffsetXEl.value, 10);
            if (!isNaN(bgOffsetX)) next.bgOverlayOffsetX = bgOffsetX;
        }
        var bgOffsetYEl = document.getElementById('globalBgOverlayOffsetY');
        if (bgOffsetYEl) {
            var bgOffsetY = parseInt(bgOffsetYEl.value, 10);
            if (!isNaN(bgOffsetY)) next.bgOverlayOffsetY = bgOffsetY;
        }
        var bgScaleEl = document.getElementById('globalBgOverlayScale');
        if (bgScaleEl) {
            var bgScale = parseInt(bgScaleEl.value, 10);
            if (!isNaN(bgScale)) next.bgOverlayScale = bgScale;
        }
        // 主题键（themePreset / customThemeColors / customThemePresets / activeCustomThemePresetId）
        // 的唯一写入口是 panelTheme：这里沿用 activeGlobalSettings 里已被 syncThemeState 同步的值，
        // 不再从 _tempCustomColors 覆盖——否则 Agent 改过的配色会被陈旧临时值回滚。
        return next;
    }

    function getAppShell() {
        return document.querySelector('.app');
    }

    function clearModuleTransitionClasses() {
        var app = getAppShell();
        var homeView = document.getElementById('homeView');
        var moduleView = document.getElementById('moduleView');

        if (app) {
            app.classList.remove('module-transitioning');
            app.classList.remove('module-transition-assembling');
            app.classList.remove('module-transition-impact');
        }
        if (homeView) {
            homeView.classList.remove('module-depth-exit');
            homeView.classList.remove('module-home-return');
        }
        if (moduleView) {
            moduleView.classList.remove('module-entering');
            moduleView.classList.remove('module-leaving');
        }
    }

    function triggerReadyGlitch(panel) {
        if (!panel) return;
        panel.classList.remove('module-ready-tv');
        void panel.offsetWidth;
        panel.classList.add('module-ready-tv');
        panel.addEventListener('animationend', function onReadyGlitchEnd() {
            panel.classList.remove('module-ready-tv');
            panel.removeEventListener('animationend', onReadyGlitchEnd);
        });
    }

    async function navigateHome() {
        if (moduleTransitionRunning) return;

        moduleTransitionRunning = true;
        clearModuleTransitionClasses();

        // CP-3：状态栏模块名先于 await 切换（先切视觉状态，对齐 navigateToModule 在
        // 挂载 try 块内同步更新的时序）——置于末尾时任一 await 抛错即被跳过，
        // HUD 停留旧模块名
        _hud.moduleLabel = AEI18n.t('主面板');
        _updateHudModule();

        var app = getAppShell();
        var homeView = document.getElementById('homeView');
        var moduleView = document.getElementById('moduleView');

        if (homeView) {
            homeView.classList.remove('hidden');
            void homeView.offsetWidth;
            homeView.classList.add('module-home-return');
        }
        if (moduleView) moduleView.classList.add('module-leaving');
        if (app) app.classList.add('module-transitioning');

        setTimeout(function () {
            try {
                if (appContainer) appContainer.deactivate();
            } catch (e) {
                console.error('[Main] 模块停用失败: ' + (e && e.message ? e.message : e));
            }
            if (moduleView) moduleView.classList.add('hidden');
            closeModal('settingsModal');
        }, 720);

        try {
            await new Promise(function (resolve) { setTimeout(resolve, 780); });
            clearModuleTransitionClasses();
            activeGlobalSettings = await loadGlobalSettings();
            global.AE_ExtP_LowPerfMode = !!activeGlobalSettings.lowPerfMode;
            applyTheme(activeGlobalSettings.themePreset || 'default');
            applyBgOverlay(activeGlobalSettings);
        } catch (e) {
            // CP-3：返回主面板后的设置/主题刷新失败仅记录（transition 锁已在 finally
            // 释放）——异常不在此捕获就直接逃逸到点击回调（unhandled rejection）
            console.error('[Main] 返回主面板后刷新全局设置失败: ' + (e && e.message ? e.message : e));
        } finally {
            moduleTransitionRunning = false;
        }
    }

    function navigateToModule(moduleId) {
        if (!appContainer || moduleTransitionRunning) return;

        var moduleDef = appContainer.getModule(moduleId);
        if (!moduleDef) return;

        moduleTransitionRunning = true;
        clearModuleTransitionClasses();

        var app = getAppShell();
        var homeView = document.getElementById('homeView');
        var moduleView = document.getElementById('moduleView');
        var activePanel = null;
        var mountFailed = false;
        var aborted = false;
        // 模块间切换时 moduleView 已可见：module-entering 必须与显示新面板同一同步 tick 加上，
        // 否则新面板会先以自然态全显，180ms 后再加 module-entering 才 snap 到动画 from 态 → 闪烁。
        var moduleViewAlreadyVisible = moduleView && !moduleView.classList.contains('hidden');

        try {
            if (homeView) homeView.classList.add('module-depth-exit');

            var moduleContent = document.querySelector('.module-content');
            if (moduleContent) {
                var allPanels = moduleContent.querySelectorAll('[data-module-panel]');
                for (var i = 0; i < allPanels.length; i++) allPanels[i].classList.add('hidden');
            }

            appContainer.activate(moduleId);

            if (moduleDef.panelId) {
                activePanel = document.getElementById(moduleDef.panelId);
                if (activePanel) activePanel.classList.remove('hidden');
            }

            var moduleViewTitle = document.getElementById('moduleViewTitle');
            if (moduleViewTitle) moduleViewTitle.textContent = moduleDef.title ? moduleDef.title : moduleId;

            // 更新底部状态栏当前模块名
            _hud.moduleLabel = moduleDef.title ? moduleDef.title : moduleId;
            _updateHudModule();

            if (typeof initCustomSelects === 'function') initCustomSelects();

            var statusPanel = document.getElementById('aeAgentStatusPanel');
            if (statusPanel) statusPanel.classList.remove('is-generating');
            var _aeCtrl = window.AEEngine && typeof window.AEEngine.getController === 'function' && window.AEEngine.getController();
            if (_aeCtrl && typeof _aeCtrl.syncView === 'function') {
                _aeCtrl.syncView();
            }
        } catch (e) {
            console.error('[Main] 模块挂载失败: ' + (e && e.message ? e.message : e));
            mountFailed = true;
            aborted = true;
            clearModuleTransitionClasses();
            // 挂载失败后 HUD 模块名残留——catch 恢复 homeView 但状态栏
            // 停留旧模块名（上一个成功模块名），对齐 navigateHome 的重置口径
            _hud.moduleLabel = AEI18n.t('主面板');
            _updateHudModule();
            if (homeView) {
                homeView.classList.remove('module-depth-exit');
                homeView.classList.remove('hidden');
            }
            if (moduleView) moduleView.classList.add('hidden');
            moduleTransitionRunning = false;
        }

        function applyEntering() {
            if (aborted || mountFailed) return;
            if (app) app.classList.add('module-transitioning');
            if (moduleView) {
                moduleView.classList.remove('hidden');
                // 强制 reflow，确保 clearModuleTransitionClasses 移除的 module-entering 能重新触发动画
                void moduleView.offsetWidth;
                moduleView.classList.add('module-entering');
            }
            // 面板此刻才拿到布局盒：上面那次 syncView 跑在 moduleView 仍 display:none 时，凡依赖
            // 可见几何的渲染都会空转（Agent 引擎的 debugRebuildPending 延迟重建按"列表可见"判据，
            // 而调试模式只能在主面板的全局设置里保存（保存瞬间 Agent 面板不可见），该标记要等到这里才消费得掉）。补一次同步——渲染是增量的，
            // 无待办时早退，成本可忽略。走 whenEnterAnimIdle 与 bootstrap 恢复初始会话同一约定
            //（注意：面板入场动画在 mount 后 500ms 才起播，此刻判定通常为"未在动画中"而立即执行；
            // 该钩子是为覆盖"动画已在跑"的情形，不保证一定排在动画之后）。
            var _nudgeEnterSync = function () {
                var c = window.AEEngine && typeof window.AEEngine.getController === 'function' && window.AEEngine.getController();
                if (c && typeof c.syncView === 'function') c.syncView();
            };
            if (window.AEAgentApp && typeof window.AEAgentApp.whenEnterAnimIdle === 'function') {
                window.AEAgentApp.whenEnterAnimIdle(_nudgeEnterSync);
            } else {
                _nudgeEnterSync();
            }
        }

        if (moduleViewAlreadyVisible) {
            // 模块间切换：moduleView 已可见，立即加 module-entering，避免新面板先全显再闪播
            applyEntering();
        } else {
            // 首页 → 模块：moduleView 初始隐藏，延迟到与 remove hidden 同帧加 module-entering
            setTimeout(applyEntering, 180);
        }

        setTimeout(function () {
            if (aborted || mountFailed) {
                moduleTransitionRunning = false;
                return;
            }
            if (homeView) homeView.classList.add('hidden');
        }, 520);

        setTimeout(function () {
            if (aborted || mountFailed) {
                moduleTransitionRunning = false;
                return;
            }
            triggerReadyGlitch(activePanel);
        }, 1120);

        setTimeout(function () {
            if (aborted || mountFailed) {
                moduleTransitionRunning = false;
                return;
            }
            clearModuleTransitionClasses();
            moduleTransitionRunning = false;
        }, 1320);
    }

    // ── 多实例冲突提示态（不支持多实例）─────────────────
    // 宿主启动时在 temp/handoff 写标记（见 host.jsx）；bridge.js 在「候选端口全鉴权
    // 不符 / bridge 反复断线」时读标记并置冲突态。命中后覆盖层改为明确告知：本扩展
    // 不支持多实例；重试只重扫端口 + 请宿主 WMI 复核，不 restartBridge（两个实例
    // 互杀 bridge 的循环源头）。标记过期或宿主复核确认只剩一个实例 → 恢复既有自愈路径。
    var MULTI_INSTANCE_CONFLICT_TITLE = '检测到多个 AE 实例';
    var MULTI_INSTANCE_CONFLICT_MSG = '检测到另一个 AE 实例也在使用本扩展；本扩展不支持多实例，请只保留一个 AE 实例（关闭其它 AE 或其中一处面板）后点重试。';
    var _multiInstanceOverlayWatchId = null;

    function _isMultiInstanceConflictNow() {
        try {
            return !!(typeof Bridge !== 'undefined' && Bridge
                && typeof Bridge.checkMultiInstanceConflict === 'function'
                && Bridge.checkMultiInstanceConflict());
        } catch (_) { return false; }
    }

    // ── 宿主 API 加载失败归因──────────────────────────────────
    // host.jsx 的 loadHostApiModules 把每个模块的失败原因写入 temp/handoff/
    // ae_extp_host_load_errors.json（面板可读；多实例标记同目录先例），成功则删除。
    // host.jsx 整体 evalFile 失败（evalScript 回调 "ERR:…"）发生在该文件执行前，
    // 落盘来不及——回调文本本身即归因。
    // 面板若只 console.log 回调，Bridge 起不来时用户与诊断日志都拿不到宿主侧原因。
    var HOST_LOAD_ERRORS_FILE = 'ae_extp_host_load_errors.json';
    var _hostLoadFailureNote = '';

    // 与 dataDir.js getMultiInstanceMarkerPaths 同源：数据根 temp/handoff 优先、
    // 系统 temp\AS_ExtP\handoff 兜底（host.jsx _handoffDir 两处回退对齐）
    function _hostLoadErrorPaths() {
        var paths = [];
        try {
            var resolved = global.AEShared && typeof global.AEShared.getDataDir === 'function'
                ? global.AEShared.getDataDir() : null;
            var root = resolved && resolved.dir;
            if (root) paths.push(String(root).replace(/[\\\/]+$/, '') + '\\temp\\handoff\\' + HOST_LOAD_ERRORS_FILE);
        } catch (_) {}
        try {
            if (global.cep && global.cep.fs && typeof global.cep.fs.getTemporaryDirectory === 'function') {
                var tmp = global.cep.fs.getTemporaryDirectory();
                if (tmp) paths.push(String(tmp).replace(/[\\\/]+$/, '') + '\\AS_ExtP\\handoff\\' + HOST_LOAD_ERRORS_FILE);
            }
        } catch (_) {}
        return paths;
    }

    // 读失败产物；无文件/坏 JSON/无 errors 数组 → []（不抛）
    function _readHostLoadErrorsSync() {
        var paths = _hostLoadErrorPaths();
        for (var i = 0; i < paths.length; i++) {
            var raw = null;
            try {
                if (global.AEFS && typeof global.AEFS.readFileSync === 'function') {
                    raw = global.AEFS.readFileSync(paths[i]);
                }
                if (!raw && global.cep && global.cep.fs && typeof global.cep.fs.readFile === 'function') {
                    var enc = global.cep.encoding && global.cep.encoding.UTF8 !== undefined ? global.cep.encoding.UTF8 : 0;
                    var rr = global.cep.fs.readFile(paths[i], enc);
                    if (rr && rr.err === 0 && rr.data) raw = rr.data;
                }
            } catch (_) { raw = null; }
            if (!raw) continue;
            try {
                var data = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
                if (data && Array.isArray(data.errors) && data.errors.length) return data.errors;
            } catch (_) {}
        }
        return [];
    }

    // 汇总归因：写入模块级 note 供 Bridge 失败浮层追加 + 诊断日志（console.warn 带逐条明细）
    function _setHostLoadFailure(reason, errors) {
        errors = errors || [];
        var detail = errors.map(function (e) {
            return (e && e.module ? e.module : '?') + '：' + (e && e.error ? e.error : AEI18n.t('未知错误'));
        }).join('；');
        var text = reason + (detail ? '（' + detail + '）' : '');
        if (text.length > 300) text = text.slice(0, 300) + '…';
        _hostLoadFailureNote = text;
        console.warn('[AE] ' + text);
        for (var i = 0; i < errors.length; i++) {
            console.warn('[AE]   宿主模块 ' + (errors[i] && errors[i].module) + ': ' + (errors[i] && errors[i].error));
        }
    }

    // Bridge 失败浮层追加宿主加载失败原因（多实例冲突态优先，不叠加）；幂等可重复调用
    function _applyHostLoadFailureCopy(overlay, conflictOn) {
        if (!overlay || typeof overlay.querySelector !== 'function') return;
        var msgEl = overlay.querySelector('.boot-block-msg');
        if (!msgEl) return;
        var old = null;
        try { old = msgEl.querySelector('#bridgeHostFailNote'); } catch (_) { old = null; }
        if (old && old.parentNode) old.parentNode.removeChild(old);
        if (!_hostLoadFailureNote || conflictOn) return;
        try {
            var p = document.createElement('p');
            p.id = 'bridgeHostFailNote';
            p.style.marginTop = '8px';
            p.style.color = 'rgba(251,191,36,.8)';
            p.textContent = _hostLoadFailureNote;
            msgEl.appendChild(p);
        } catch (_) {}
    }

    // 覆盖层文案切换（DOM 复用：首次进入时快照默认文案，退出冲突态时还原）
    function _applyMultiInstanceOverlayCopy(overlay, on) {
        if (!overlay || typeof overlay.querySelector !== 'function') return;
        var titleEl = overlay.querySelector('.boot-block-title');
        var msgEl = overlay.querySelector('.boot-block-msg');
        if (!titleEl || !msgEl) return;
        if (titleEl.__defaultHtml === undefined) titleEl.__defaultHtml = titleEl.innerHTML;
        if (msgEl.__defaultHtml === undefined) msgEl.__defaultHtml = msgEl.innerHTML;
        if (on) {
            titleEl.textContent = AEI18n.t(MULTI_INSTANCE_CONFLICT_TITLE);
            msgEl.textContent = AEI18n.t(MULTI_INSTANCE_CONFLICT_MSG);
        } else {
            titleEl.innerHTML = titleEl.__defaultHtml;
            msgEl.innerHTML = msgEl.__defaultHtml;
        }
        // 追加宿主加载失败归因（退出冲突态还原默认文案后重新挂回；冲突态不叠加）
        _applyHostLoadFailureCopy(overlay, on);
    }

    // 覆盖层显示期间轮询标记：宿主单实例启动/复核清标记、或标记过期后，文案自动回落，
    // 重试随之恢复既有自愈路径（这里只切文案，不做任何重启动作）。
    function _startMultiInstanceOverlayWatch(overlay) {
        _stopMultiInstanceOverlayWatch();
        _multiInstanceOverlayWatchId = setInterval(function () {
            try { _applyMultiInstanceOverlayCopy(overlay, _isMultiInstanceConflictNow()); } catch (_) {}
        }, 2000);
    }
    function _stopMultiInstanceOverlayWatch() {
        if (_multiInstanceOverlayWatchId) {
            clearInterval(_multiInstanceOverlayWatchId);
            _multiInstanceOverlayWatchId = null;
        }
    }

    // 多实例冲突态的重试：只重扫端口，再请宿主复核（refreshMultiInstanceMarker 走 WMI，
    // 不杀进程）。复核为 SINGLE → 清标记并回落既有自愈路径（含 restartBridge）；
    // MULTI/UNKNOWN → 保持冲突态、只让用户重试——绝不进互杀循环。
    function _retryMultiInstanceConflict(setBusy, setDone, onRecovered, onSingleInstance) {
        setBusy(AEI18n.t('重新检测...'));
        var scan = (typeof Bridge !== 'undefined' && Bridge && typeof Bridge.scanPortAsync === 'function')
            ? Bridge.scanPortAsync()
            : Promise.resolve(null);
        scan.then(function (port) {
            if (port) { onRecovered(); return; }
            setBusy(AEI18n.t('复核 AE 实例...'));
            var _cepBridge = (global.AEPlatform && typeof global.AEPlatform.createCepBridge === 'function')
                ? global.AEPlatform.createCepBridge() : null;
            if (!_cepBridge || !_cepBridge.isAvailable()) { setDone(); return; }
            try {
                _cepBridge.evalScript('refreshMultiInstanceMarker()', 15000, function (r) {
                    var res = (r && typeof r === 'object') ? r.result : r;
                    var single = (res === 'SINGLE');
                    if (single && typeof Bridge !== 'undefined' && Bridge
                        && typeof Bridge.checkMultiInstanceConflict === 'function') {
                        Bridge.checkMultiInstanceConflict(true);   // 宿主已清标记 → 立即同步本地面板态
                    }
                    if (single) { onSingleInstance(); return; }   // 只剩一个实例：恢复既有自愈路径
                    setDone();   // 仍多实例/复核不可用：保持冲突态（不重启互杀）
                });
            } catch (_) { setDone(); }
        }).catch(function () { setDone(); });
    }

    // 跳过二次确认（启动失败页 / 断线页共用）：
    // 确认层文案列明 Bridge 独占能力（见 index.html 该覆盖层的注释），两个阻断页的
    // 「跳过」都经此确认——断线页同样需要警告，与启动页强度一致。
    // 返回「隐藏确认层」函数：父覆盖层关闭（含桥自愈自动撤除）时兜底调用，
    // 防确认层在桥已恢复后残留浮层。
    function _showBridgeSkipConfirm(onConfirmed) {
        var confirmOverlay = document.getElementById('bridgeSkipConfirmOverlay');
        var backBtn = document.getElementById('skipConfirmBackBtn');
        var okBtn = document.getElementById('skipConfirmOkBtn');
        if (!confirmOverlay || !backBtn || !okBtn) {
            // 元素缺失兜底：直接按确认处理（不阻断降级路径）
            onConfirmed();
            return function () {};
        }
        confirmOverlay.removeAttribute('aria-hidden');
        function cleanupConfirm() {
            confirmOverlay.setAttribute('aria-hidden', 'true');
            backBtn.removeEventListener('click', onBack);
            okBtn.removeEventListener('click', onOk);
        }
        function onBack() { cleanupConfirm(); }
        function onOk() { cleanupConfirm(); onConfirmed(); }
        backBtn.addEventListener('click', onBack);
        okBtn.addEventListener('click', onOk);
        return cleanupConfirm;
    }

    // MCP 实例（bootstrap 里 initMCP 的返回值）的模块级把手。
    // 为什么要有它：bootstrap 里的 `mcp` 是那个函数的局部变量，而「遮罩自愈」「多实例轮询」
    // 等回调在别的函数作用域里——直接写 `mcp` 就是未声明标识符，运行期每秒抛一次
    // ReferenceError 被 try/catch 吞掉（现场表现：WS 握手这条主判据从未生效，全靠
    // Bridge.isAvailable() 兜底；`npm run lint` 也因此常年 4 条 no-undef）。
    // 的自愈语义本来就是「哪怕桥是外部拉起的，遮罩自己撤」，主判据接上后判得更准。
    var _mcpInstance = null;

    // 遮罩自愈的唯一就绪判据（每秒问一次）：**任一**信号说就绪就算就绪——
    // 先问 MCP 的 WS 握手态（最早、最直接），没连再问 Bridge.isAvailable()
    // （由 WS 握手/心跳维护，正是 AEFS 的判据）。OR 而非 AND 是刻意的：两个信号都可能假阴性
    // （WS 套接字掉线而 HTTP 尚通；或反过来），而这一链的坏方向是「桥其实已就绪但遮罩不撤」
    // 所以宁可任一为真就闭。
    // 任何一路抛错都只当作「没问到」，绝不外泄——自愈轮询是装饰性兜底，不能反过来炸掉遮罩。
    function _bridgeReadyForSelfHeal() {
        try {
            if (_mcpInstance && _mcpInstance.communicationProvider
                && typeof _mcpInstance.communicationProvider.isBridgeConnected === 'function'
                && _mcpInstance.communicationProvider.isBridgeConnected()) {
                return true;
            }
        } catch (_) {}
        try {
            if (typeof Bridge !== 'undefined' && typeof Bridge.isAvailable === 'function') {
                return !!Bridge.isAvailable();
            }
        } catch (_) {}
        return false;
    }

    // Bridge 自启动失败时阻塞 UI，重试时先探测再自动拉起，或跳过
    function showBridgeFailOverlay() {
        return new Promise(function (resolve) {
            var overlay = document.getElementById('bridgeFailOverlay');
            if (overlay) overlay.removeAttribute('aria-hidden');

            var retryBtn = document.getElementById('bridgeRetryBtn');
            var skipBtn = document.getElementById('bridgeSkipBtn');

            // overlay 复用同一 DOM：重置按钮状态，防上次 retry 成功路径残留 disabled
            if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = AEI18n.t('↻ 重新检测'); }
            // 多实例冲突态：显示期间同步文案并轮询（标记过期/宿主复核为单实例后自动回落）
            _applyMultiInstanceOverlayCopy(overlay, _isMultiInstanceConflictNow());
            _startMultiInstanceOverlayWatch(overlay);

            // 自愈轮询句柄——桥在遮罩挂起期间就绪（WS 握手已连 / isAvailable 为真）即自动撤除
            var _selfHealTimer = null;
            var _hideSkipConfirm = null;   // 二次确认层隐藏句柄（自愈撤页时兜底关闭，防残留）
            function cleanup() {
                _stopMultiInstanceOverlayWatch();
                if (_selfHealTimer) { clearInterval(_selfHealTimer); _selfHealTimer = null; }
                if (_hideSkipConfirm) { _hideSkipConfirm(); _hideSkipConfirm = null; }
                if (overlay) overlay.setAttribute('aria-hidden', 'true');
                if (retryBtn) retryBtn.removeEventListener('click', onRetry);
                if (skipBtn) skipBtn.removeEventListener('click', onSkip);
            }

            function restoreRetryBtn() {
                if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = AEI18n.t('↻ 重新检测'); }
            }

            // 既有自愈路径：探测 → restartBridge → 轮询（单实例或宿主复核确认后走这里）
            function runNormalRetry() {
                if (retryBtn) { retryBtn.disabled = true; retryBtn.textContent = AEI18n.t('检测中...'); }
                // 先短探测：bridge 可能正在启动中，直接 restart 会杀掉半启动进程重来
                var probe = (typeof Bridge !== 'undefined' && Bridge.waitForReady)
                    ? Bridge.waitForReady(1500)
                    : Promise.resolve(false);
                probe.then(function (up) {
                    if (up) { cleanup(); resolve(true); return; }
                    // 确认没起来 → 通过 evalScript 调 host.jsx 的 restartBridge() 拉起 node 进程
                    // startBridge 内部会先 taskkill 9877 端口的残留进程，再用 VBS/cmd 重新启动
                    if (retryBtn) { retryBtn.textContent = AEI18n.t('重启中...'); }
                    // CP-5：restartBridge 的裸 evalScript 无超时——宿主 JSX 忙死/回调丢失时
                    // 按钮永久停在「重启中...」。改用 cepBridge.evalScript 超时包装（15s，
                    // cepBridge.js 在 manifest 中先于 main.js 加载，此处必可用）；
                    // 超时/异常均正常回调，回调后照旧轮询 waitForReady（node 可能已被拉起）
                    var _cepBridge = (global.AEPlatform && typeof global.AEPlatform.createCepBridge === 'function')
                        ? global.AEPlatform.createCepBridge() : null;
                    if (_cepBridge && _cepBridge.isAvailable()) {
                        _cepBridge.evalScript('restartBridge()', 15000, function (/*r*/) {
                            // restartBridge 返回后 node 进程刚启动，HTTP 可能还没就绪 → 轮询等待
                            if (typeof Bridge !== 'undefined' && Bridge.waitForReady) {
                                Bridge.waitForReady(6000).then(function (ok) {
                                    if (ok) { cleanup(); resolve(true); }
                                    else { restoreRetryBtn(); }
                                });
                            } else {
                                restoreRetryBtn();
                            }
                        });
                    } else {
                        // CSInterface 不可用（极罕见），退化到纯检测
                        if (typeof Bridge !== 'undefined' && Bridge.isAvailable) {
                            var ok = false;
                            try { ok = !!Bridge.isAvailable(); } catch (_) { ok = false; }
                            if (ok) { cleanup(); resolve(true); }
                            else { restoreRetryBtn(); }
                        } else {
                            setTimeout(restoreRetryBtn, 500);
                        }
                    }
                });
            }

            // 冲突态重试只重扫端口 + 宿主复核；仅复核为单实例才回落 runNormalRetry
            function onRetry() {
                if (_isMultiInstanceConflictNow()) {
                    if (retryBtn) { retryBtn.disabled = true; }
                    _retryMultiInstanceConflict(
                        function (txt) { if (retryBtn) retryBtn.textContent = txt; },
                        restoreRetryBtn,
                        function () { cleanup(); resolve(true); },
                        runNormalRetry
                    );
                    return;
                }
                runNormalRetry();
            }

            function onSkip() {
                // 二次确认（共享确认层，文案列明桥独占能力）；确认后进入降级模式
                _hideSkipConfirm = _showBridgeSkipConfirm(function () {
                    cleanup();
                    resolve(false);
                });
            }

            if (retryBtn) retryBtn.addEventListener('click', onRetry);
            if (skipBtn) skipBtn.addEventListener('click', onSkip);

            // 遮罩自愈——挂起期间每秒复核桥就绪信号（WS 握手已连 / isAvailable 为真即闭）。
            // 实测：桥 08.9s 就已连上，但启动门两段等待先后假阴性 → 失败遮罩
            // 误弹且只能靠用户点「重新检测」才能撤；现在桥一起来遮罩自己消失，无需用户操作。
            // 判据拆到 _bridgeReadyForSelfHeal()（模块级）——直接引 bootstrap 的局部
            // `mcp`，跨作用域即未声明，握手这条主判据从未跑到过（见该函数上方注释）。
            _selfHealTimer = setInterval(function () {
                if (_bridgeReadyForSelfHeal()) {
                    console.log('[Main] Bridge online while fail overlay shown — auto-dismiss');
                    cleanup();
                    resolve(true);
                }
            }, 1000);
        });
    }

    // Bridge 运行时断线阻塞 UI（与启动阻断页同风格；跳过同走二次确认）
    // resolve(true) = 已恢复；resolve(false) = 用户跳过
    // 单飞保护：overlay 显示期间（含心跳自动弹出与 HUD 手动入口并发）复用同一 Promise，
    // 防止对 retry/skip 按钮二次绑定监听器（一次点击触发两次 restart）
    var _disconnectOverlayPromise = null;
    // 阻断页外部恢复句柄——overlay 显示期间 bridge 被外部拉起（其他实例重试成功/
    // 用户手动启动 node）时，心跳恢复分支据此主动关页，阻断页不再永久遮挡 UI
    var _disconnectOverlayForceRestore = null;
    function showBridgeDisconnectOverlay() {
        if (_disconnectOverlayPromise) return _disconnectOverlayPromise;
        _disconnectOverlayPromise = new Promise(function (resolve) {
            var overlay = document.getElementById('bridgeDisconnectOverlay');
            if (overlay) overlay.removeAttribute('aria-hidden');

            var retryBtn = document.getElementById('disconnectRetryBtn');
            var skipBtn = document.getElementById('disconnectSkipBtn');
            var _hideSkipConfirm = null;   // 二次确认层隐藏句柄（自愈/恢复撤页时兜底关闭，防残留）

            // overlay 复用同一 DOM：重置按钮状态，防上次 retry 成功路径残留 disabled「重启中...」
            if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = AEI18n.t('↻ 重新检测'); }
            // 多实例冲突态：显示期间同步文案并轮询（标记过期/宿主复核为单实例后自动回落）
            _applyMultiInstanceOverlayCopy(overlay, _isMultiInstanceConflictNow());
            _startMultiInstanceOverlayWatch(overlay);

            function cleanup() {
                _stopMultiInstanceOverlayWatch();
                _disconnectOverlayPromise = null;
                _disconnectOverlayForceRestore = null;
                if (_hideSkipConfirm) { _hideSkipConfirm(); _hideSkipConfirm = null; }
                if (overlay) overlay.setAttribute('aria-hidden', 'true');
                if (retryBtn) retryBtn.removeEventListener('click', onRetry);
                if (skipBtn) skipBtn.removeEventListener('click', onSkip);
            }

            // 恢复统一出口：关页 + 直接把「已恢复」写入心跳状态机（_bridgeNotifyRestored 由 startBridgeHeartbeat 注入）。
            // 不能靠立即触发一拍 beat 来翻转状态：重新检测确认在线后紧接的 beat 若瞬时失败
            // （fetch 连接复用竞态 / node 刚就绪窗口），wasOnline 会卡在 false，
            // 之后 bridge 再断线时「!online && wasOnline」永不成立 → 断线页永不弹出。
            // 「重新检测成功」本身是权威事实，直接同步 wasOnline/dismissed/HUD/toast；beat 只做周期巡检。
            // settled 幂等守卫：心跳外部恢复与 retry 在途回调可能竞争同一出口，
            // 双触发会重复 cleanup + 重复恢复 toast；先到者胜出，迟到者直接返回。
            var settled = false;
            function restored() {
                if (settled) return;
                settled = true;
                cleanup();
                if (_bridgeNotifyRestored) { try { _bridgeNotifyRestored(); } catch (_) {} }
                resolve(true);
            }
            // 暴露恢复出口给心跳状态机（恢复分支检测到阻断页在显时调用；
            // restored 内部已发恢复 toast 并同步 wasOnline/dismissed/HUD，调用方不再重复发）
            _disconnectOverlayForceRestore = restored;

            // 既有自愈路径：探测 → restartBridge → 轮询（单实例或宿主复核确认后走这里）
            function runNormalRetry() {
                if (retryBtn) { retryBtn.disabled = true; retryBtn.textContent = AEI18n.t('检测中...'); }
                // 先短探测（与启动阻断页两段式一致）：bridge 可能正在自动重启中（如 MCP 崩溃循环），
                // 直接 restart 会杀掉半启动进程重来
                var probe = (typeof Bridge !== 'undefined' && Bridge.waitForReady)
                    ? Bridge.waitForReady(1500)
                    : Promise.resolve(false);
                probe.then(function (up) {
                    if (up) { restored(); return; }
                    // 确认没起来 → 通过 evalScript 调 host.jsx 的 restartBridge() 重新拉起 node 进程
                    // startBridge 内部会先 taskkill 9877 端口的残留进程，再用 VBS/cmd 重新启动
                    if (retryBtn) { retryBtn.textContent = AEI18n.t('重启中...'); }
                    // CP-5：与启动阻断页同款——裸 evalScript 无超时会让按钮永久停在
                    // 「重启中...」，改用 cepBridge.evalScript 超时包装（15s）
                    var _cepBridge = (global.AEPlatform && typeof global.AEPlatform.createCepBridge === 'function')
                        ? global.AEPlatform.createCepBridge() : null;
                    if (_cepBridge && _cepBridge.isAvailable()) {
                        _cepBridge.evalScript('restartBridge()', 15000, function (/*r*/) {
                            // restartBridge 返回后 node 进程刚启动，HTTP 可能还没就绪 → 轮询等待
                            if (typeof Bridge !== 'undefined' && Bridge.waitForReady) {
                                Bridge.waitForReady(6000).then(function (ok) {
                                    if (ok) { restored(); }
                                    else { if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = AEI18n.t('↻ 重新检测'); } }
                                });
                            } else {
                                if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = AEI18n.t('↻ 重新检测'); }
                            }
                        });
                    } else {
                        // CSInterface 不可用（极罕见），退化到纯检测
                        if (typeof Bridge !== 'undefined' && Bridge.isAvailable) {
                            var ok = false;
                            try { ok = !!Bridge.isAvailable(); } catch (_) { ok = false; }
                            if (ok) { restored(); }
                            else { if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = AEI18n.t('↻ 重新检测'); } }
                        } else {
                            setTimeout(function () {
                                if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = AEI18n.t('↻ 重新检测'); }
                            }, 500);
                        }
                    }
                });
            }

            // 冲突态重试只重扫端口 + 宿主复核；仅复核为单实例才回落 runNormalRetry
            function onRetry() {
                if (_isMultiInstanceConflictNow()) {
                    if (retryBtn) { retryBtn.disabled = true; }
                    _retryMultiInstanceConflict(
                        function (txt) { if (retryBtn) retryBtn.textContent = txt; },
                        function () { if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = AEI18n.t('↻ 重新检测'); } },
                        restored,
                        runNormalRetry
                    );
                    return;
                }
                runNormalRetry();
            }

            function onSkip() {
                // 二次确认（与启动失败页对齐，不再直接跳过）
                _hideSkipConfirm = _showBridgeSkipConfirm(function () {
                    cleanup();
                    resolve(false);
                });
            }

            if (retryBtn) retryBtn.addEventListener('click', onRetry);
            if (skipBtn) skipBtn.addEventListener('click', onSkip);
        });
        // 本行漏写时——
        // 函数于是只在「已有在途 Promise」时返回，首次弹出返回 undefined → 两个调用点
        // 的 `.then(...)` 同步抛 TypeError「Cannot read property 'then' of undefined」
        // （面板弹红 toast；且 3091 调用点的 .then 永不执行 → overlayShowing 卡 true
        // → 本次会话断线页不再自动弹出、dismissed 永不置位）。单飞 Promise 必须返回。
        return _disconnectOverlayPromise;
    }

    // 效果列表缓存：首屏后检查，无缓存且未跳过 → 弹提示卡片征询是否生成。
    // 用户跳过则记 localStorage flag 不再弹；模块设置里有手动入口可重新触发。
    function triggerEffectsCacheCheck() {
        try {
            if (!global.AEEffectsCache || !global.AENotice) return;
            global.AEEffectsCache.init();
            if (!global.AEEffectsCache.checkOnBoot()) return;

            global.AENotice.show({
                id: 'effects-cache-prompt',
                icon: '📦',
                title: AEI18n.t('效果列表缓存'),
                message: AEI18n.t('检测到已安装大量 AE 效果。<code>queryEnvironment</code> 工具首次查询可用效果时会很慢。是否现在生成缓存？生成期间 AE 会间歇性卡顿。'),
                tone: 'info',
                actions: [
                    {
                        label: AEI18n.t('现在生成'),
                        type: 'primary',
                        onClick: function () { startEffectsCacheGeneration(); }
                    },
                    {
                        label: AEI18n.t('跳过'),
                        type: 'secondary',
                        onClick: function () { global.AEEffectsCache.skip(); }
                    }
                ]
            });
        } catch (e) {
            console.warn('[Main] effects cache check failed: ' + e);
        }
    }

    // 触发效果缓存生成：用 AENotice 进度卡片报进度，完成后提示。
    // force=true 走 regenerate（先删旧缓存再生成），用于模块设置"生成/重新生成"。
    function startEffectsCacheGeneration(force) {
        try {
            if (!global.AEEffectsCache || !global.AENotice) {
                console.warn('[Main] effects cache module unavailable');
                return;
            }
            var noticeId = 'effects-cache-progress';
            global.AENotice.show({
                id: noticeId,
                icon: '📦',
                title: AEI18n.t('效果列表缓存'),
                message: AEI18n.t('正在生成效果列表缓存…'),
                tone: 'info',
                dismissible: false,
                progress: 0,
                progressLabel: AEI18n.t('准备中…')
            });
            var gen = force
                ? global.AEEffectsCache.regenerate
                : global.AEEffectsCache.startGeneration;
            gen.call(global.AEEffectsCache, function (done, total) {
                var pct = Math.round(done / Math.max(total, 1) * 100);
                global.AENotice.update(noticeId, {
                    progress: pct,
                    progressLabel: done + ' / ' + total + '  (' + pct + '%)'
                });
            }).then(function (res) {
                if (res && res.ok) {
                    global.AENotice.update(noticeId, {
                        message: AEI18n.t('效果缓存已生成（{n} 个效果）', { n: res.total }),
                        progress: 100,
                        progressLabel: AEI18n.t('完成')
                    });
                    setTimeout(function () { global.AENotice.close(noticeId); }, 2500);
                } else {
                    global.AENotice.update(noticeId, {
                        message: AEI18n.t('效果缓存生成失败：') + (res && res.error ? res.error : AEI18n.t('未知错误')),
                        progress: 0,
                        progressLabel: AEI18n.t('失败')
                    });
                }
            }).catch(function (e) {
                global.AENotice.update(noticeId, {
                    message: AEI18n.t('效果缓存生成异常：') + e,
                    progress: 0,
                    progressLabel: AEI18n.t('失败')
                });
            });
        } catch (e) {
            console.warn('[Main] effects cache generation failed: ' + e);
        }
    }

    // 模块卡片 stagger 入场动画
    function staggerModuleCards() {
        var cards = document.querySelectorAll('.module-card');
        for (var i = 0; i < cards.length; i++) {
            cards[i].classList.remove('stagger-in');
            void cards[i].offsetWidth;
            cards[i].style.animationDelay = (i * 0.06) + 's';
            cards[i].classList.add('stagger-in');
        }
    }


    // 根据已注册模块动态渲染主面板入口卡片
    function renderHomePanel() {
        const host = document.getElementById('moduleCardList');
        if (!host || !appContainer) {
            return;
        }
        host.innerHTML = '';
        const modules = appContainer.listModules();

        modules.forEach((moduleDef) => {
            const card = document.createElement('div');
            card.className = 'module-card';
            card.dataset.moduleId = moduleDef.id;

            const title = document.createElement('div');
            title.className = 'module-card-title';
            title.textContent = moduleDef.title || moduleDef.id;

            const desc = document.createElement('div');
            desc.className = 'module-card-desc';
            desc.textContent = moduleDef.description || AEI18n.t('进入该模块后可查看模块内独立设置与功能面板。');

            const action = document.createElement('button');
            action.className = 'btn';
            action.textContent = AEI18n.t('进入模块');

            card.addEventListener('click', () => {
                navigateToModule(moduleDef.id);
            });
            action.addEventListener('click', (e) => {
                e.stopPropagation();
                navigateToModule(moduleDef.id);
            });

            card.appendChild(title);
            card.appendChild(desc);
            card.appendChild(action);
            host.appendChild(card);
        });
    }

    // 绑定主面板交互：全局设置开关、保存、主题预览、返回主面板
    function bindHomeEvents() {
        const openGlobalSettingsBtn = document.getElementById('openGlobalSettingsBtn');
        const closeGlobalSettingsBtn = document.getElementById('closeGlobalSettingsBtn');
        const saveGlobalSettingsBtn = document.getElementById('saveGlobalSettingsBtn');
        const globalThemePreset = document.getElementById('globalThemePreset');
        const backToHomeBtn = document.getElementById('backToHomeBtn');
        // 全局文件选择锁由 shared/pickGuard.js 统一管理（AEPickGuard.isBusy）
        // 调用方仅在 onPicked 回调内自行校验"面板是否仍打开"
        const _isGlobalSettingsOpen = function () {
            const m = document.getElementById('globalSettingsModal');
            return !!(m && m.style.display !== 'none');
        };
        // 打开弹窗时已保存的背景叠加图路径快照，用于关闭/保存时决定清理哪些 temp/bg-overlay 文件
        var _bgOverlayImageAtOpen = '';
        // 调试模式：不需要「打开时的日志栏快照」——拨动开关不产生任何副作用
        //（未保存关闭时无从泄漏），日志栏只在保存生效那刻跟随新值。

        if (openGlobalSettingsBtn) {
            openGlobalSettingsBtn.addEventListener('click', async () => {
                activeGlobalSettings = await loadGlobalSettings();
                _bgOverlayImageAtOpen = activeGlobalSettings.bgOverlayImage || '';
                global.AE_ExtP_LowPerfMode = !!activeGlobalSettings.lowPerfMode;
                applyGlobalSettingsToUI();
                // 主题区进入编辑草稿：档位切换 / 方案增删改名 / 改色都只改内存并即时预览，
                // 点「保存」才落盘（applyThemeKeysAfterSave → commitDraft），未保存关闭回滚。
                if (panelTheme && typeof panelTheme.beginDraft === 'function') panelTheme.beginDraft();
                openModal('globalSettingsModal');
                // 模态框显示、布局完成后重新对齐黄点到音量条（隐藏态下 offset 为 0，直接同步会错位）
                if (global.__aeSyncVolProjectile) {
                    requestAnimationFrame(function () { global.__aeSyncVolProjectile(); });
                }
            });
        }

        if (closeGlobalSettingsBtn) {
            closeGlobalSettingsBtn.addEventListener('click', async () => {
                if (global.AEPickGuard && global.AEPickGuard.isBusy()) {
                    // toast 类型拼错 'warning' 会丢失 warn 样式/音效/时长（toast 只认 'warn'）
                    if (global.AEToast) global.AEToast.show(AEI18n.t('请先完成文件选择'), 'warn');
                    return;
                }
                closeModal('globalSettingsModal');
                // 未保存关闭：从存储重新加载已保存的设置，恢复全部 UI 到已保存状态
                //（含调试模式勾选框——拨动它没有任何运行时副作用，故无需回滚任何东西）
                _tempCustomColors = null;
                activeGlobalSettings = await loadGlobalSettings();
                applyGlobalSettingsToUI();
                // 主题草稿回滚：弹窗里的档位/方案/改色都是预览态，未保存关闭一律回到打开弹窗之前
                //（discardDraft 会同时回滚内存态与已应用的外观，并把下拉/方案列表刷回基线）
                if (panelTheme && typeof panelTheme.discardDraft === 'function') await panelTheme.discardDraft();
                // 清理本次会话换图产生但未保存的临时图片（保留已保存设置引用的那张）
                _cleanBgOverlayDir(_bgOverlayImageAtOpen);
                // 未保存关闭：丢弃录制/待保存热键组合（_hotkeyPending 重置在 applyGlobalSettingsToUI），
                // 停掉未完成的反馈轮询（请求文件若已写出则保留，AE 空闲后仍会被处理）
                _hotkeyRecording = false;
                _hotkeyPending = null;
                _stopHotkeyFeedbackPoll();
            });
        }

        var browseDataDirBtn = document.getElementById('browseGlobalDataDirBtn');
        if (browseDataDirBtn) {
            browseDataDirBtn.addEventListener('click', function () {
                if (!global.AEPickGuard) return;
                global.AEPickGuard.pickFolder({ title: AEI18n.t('选择扩展数据目录') }, function (path) {
                    // 二次防御：若面板已关闭（如被其他途径关掉），放弃 DOM 写入，避免与已重载的状态漂移
                    if (!_isGlobalSettingsOpen()) return;
                    if (!path) return;
                    var el = document.getElementById('globalDataDir');
                    if (el) el.value = path;
                });
            });
        }

        // 在 OS 文件管理器中打开一个目录（ExtendScript Folder.execute）。
        // 转义链与 projectAssetView 等处 _escPath 对齐：反斜杠/引号防注入，
        // U+2028/U+2029 是 ES3 字面量行终止符（NTFS/macOS 文件名合法字符），
        // 不转义会让 evalScript 解析失败。抽成公共助手供多处复用。
        var _openFolderInOS = function (dirPath, onFail) {
            if (!dirPath) return;
            if (typeof CSInterface === 'undefined') return;
            var safePath = String(dirPath).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
            new CSInterface().evalScript(
                '(function(){var f=new Folder("' + safePath + '");if(!f.exists){return "NOT_EXISTS";}return f.execute()?"OK":"FAIL";})();',
                function (res) {
                    var r = String(res || '').trim();
                    if (r === 'OK') return;
                    // 仅对脚本显式返回的失败弹提示；取消 AE 权限等返回空/错误的情况静默忽略
                    if (typeof onFail === 'function') onFail(r);
                }
            );
        };

        // 导出诊断日志（用户支持工作流）：把各进程日志尾部 + 环境信息打成一个文件，
        // 用户只需把该文件发回来。脱敏在打包时由 diagLog 统一施加（见 shared/diagLog.js）。
        var exportDiagLogBtn = document.getElementById('exportDiagLogBtn');
        if (exportDiagLogBtn) {
            exportDiagLogBtn.addEventListener('click', function () {
                var dl = global.AEDiagLog;
                if (!dl || typeof dl.exportBundle !== 'function') {
                    if (global.AEToast) global.AEToast.show(AEI18n.t('诊断日志模块未就绪'), 'warn');
                    return;
                }
                var doExport = function () {
                    exportDiagLogBtn.disabled = true;
                    // 先把内存缓冲刷进文件，保证包里的面板日志是最新的（flush 会等完在途写）
                    Promise.resolve(dl.flush && dl.flush())
                        .then(function () { return dl.exportBundle(); })
                        .then(function (res) {
                            exportDiagLogBtn.disabled = false;
                            if (!res || !res.ok) {
                                if (global.AEToast) {
                                    global.AEToast.show(AEI18n.t('导出失败：') + ((res && res.reason) || AEI18n.t('未知原因')), 'warn');
                                }
                                return;
                            }
                            if (global.AEToast) {
                                global.AEToast.show(AEI18n.t('诊断日志已导出，正在打开所在文件夹…'), 'info', { autoHideMs: 4000 });
                            }
                            // 导出后直接打开所在目录：用户下一步就是把那个文件发出去，
                            // 不打开的话他得自己去翻数据目录（多数用户不知道路径在哪）
                            _openFolderInOS(dl.diagDir && dl.diagDir(), function (r) {
                                if (global.AEToast) {
                                    global.AEToast.show(r === 'NOT_EXISTS'
                                        ? AEI18n.t('导出成功，但目录不存在：') + res.path
                                        : AEI18n.t('导出成功，但打开目录失败，文件在：') + res.path, 'warn', { autoHideMs: 8000 });
                                }
                            });
                        })
                        .catch(function (e) {
                            exportDiagLogBtn.disabled = false;
                            if (global.AEToast) global.AEToast.show(AEI18n.t('导出异常：') + (e && e.message || e), 'warn');
                        });
                };

                // 确认弹窗（项目统一弹窗）：导出会打包日志，先让用户明确知道将要发生什么
                if (typeof global.showConfirm === 'function') {
                    global.showConfirm(AEI18n.t('导出诊断日志'),
                        AEI18n.t('将把面板、bridge、AE 宿主与原生插件的日志尾部打包成一个文件')
                        + AEI18n.t('（密钥等敏感串已自动打码），并在资源管理器中打开所在文件夹。\n\n')
                        + AEI18n.t('继续导出？')).then(function (ok) { if (ok) doExport(); });
                } else {
                    doExport();   // 弹窗不可用时不阻断（符合项目 fallback 约定）
                }
            });
        }

        // 打开扩展数据目录（OS 文件管理器）。优先打开输入框中的路径，为空则打开当前生效数据目录。
        var openDataDirBtn = document.getElementById('openGlobalDataDirBtn');
        if (openDataDirBtn) {
            openDataDirBtn.addEventListener('click', function () {
                var dirEl = document.getElementById('globalDataDir');
                var path = (dirEl ? dirEl.value.trim() : '')
                    || (global.AEShared && typeof global.AEShared.getDataDir === 'function'
                        ? global.AEShared.getDataDir().dir : '');
                if (!path) {
                    if (global.AEToast) global.AEToast.show(AEI18n.t('数据目录为空，无法打开。'), 'warn');
                    return;
                }
                _openFolderInOS(path, function (r) {
                    if (r === 'NOT_EXISTS') {
                        if (global.AEToast) global.AEToast.show(AEI18n.t('目录不存在：') + path, 'warn');
                    } else if (r === 'FAIL') {
                        if (global.AEToast) global.AEToast.show(AEI18n.t('打开目录失败：') + path, 'warn');
                    }
                });
            });
        }

        // —— 热盒快捷键：录制 / 默认 / 保存请求（写入 hotkey-request.json，AEGP 空闲时处理） ——
        var recordHotkeyBtn = document.getElementById('recordHotboxHotkeyBtn');
        var resetHotkeyBtn = document.getElementById('resetHotboxHotkeyBtn');
        var hotkeyInput = document.getElementById('globalHotboxHotkey');

        if (recordHotkeyBtn) {
            recordHotkeyBtn.addEventListener('click', function () {
                _hotkeyRecording = true;
                _hotkeyPending = null;
                if (hotkeyInput) {
                    hotkeyInput.value = AEI18n.t('按下组合键，Esc 取消');
                    // 点「录制」按钮**不会**让面板取得键盘焦点——
                    // 此时按 Esc 被 AE 主程序吃掉（面板收不到 keydown，录制卡住只能再点左侧
                    // 输入框才救得回来）。开始录制时显式把焦点交给只读输入框（与手动点它同一
                    // 条路径），键盘事件即落到面板：Esc 取消、组合键照常被 document capture 吞。
                    try { hotkeyInput.focus(); } catch (_) {}
                }
            });
        }
        if (resetHotkeyBtn) {
            resetHotkeyBtn.addEventListener('click', function () {
                _hotkeyRecording = false;
                _hotkeyPending = { mods: 1, vk: 0x51 };   // Alt+Q（默认）
                if (hotkeyInput) hotkeyInput.value = 'Alt+Q';
            });
        }
        // 录制期吞键（capture + stopPropagation：不泄漏给面板内其他快捷键处理器）
        document.addEventListener('keydown', function (e) {
            if (!_hotkeyRecording) return;
            e.preventDefault();
            e.stopPropagation();
            var vk = e.keyCode;
            if (vk === 27) {   // Esc 取消
                _hotkeyRecording = false;
                _refreshHotkeyInput();
                return;
            }
            if (vk === 16 || vk === 17 || vk === 18) return;   // 纯修饰键：继续等主键
            // 主键白名单：字母/数字/F1-F12/空格（规避 OEM 键布局差异导致 CEP keyCode 与 Win32 VK 不一致；
            // 空格优先按 e.code 物理键判定并归一为 VK_SPACE=32——中文 IME 激活时 keydown 的
            // keyCode 可能是 229（VK_PROCESSKEY），但 e.code 不受 IME 影响）
            var isSpace = e.code === 'Space' || vk === 32;
            var vkMain = isSpace ? 32 : vk;
            var ok = (vk >= 65 && vk <= 90) || (vk >= 48 && vk <= 57) || (vk >= 112 && vk <= 123) || isSpace;
            if (!ok) return;
            var mods = 0;
            if (e.ctrlKey) mods |= 2;
            if (e.altKey) mods |= 1;
            if (e.shiftKey) mods |= 4;
            if (mods === 0) {   // 无修饰键：短暂提示后继续录制
                if (hotkeyInput) {
                    hotkeyInput.value = AEI18n.t('需包含 Ctrl/Alt/Shift');
                    if (_hotkeyHintTimer) clearTimeout(_hotkeyHintTimer);
                    _hotkeyHintTimer = setTimeout(function () {
                        _hotkeyHintTimer = 0;
                        if (_hotkeyRecording && hotkeyInput) hotkeyInput.value = AEI18n.t('按下组合键，Esc 取消');
                    }, 1500);
                }
                return;
            }
            _hotkeyRecording = false;
            if (_hotkeyHintTimer) { clearTimeout(_hotkeyHintTimer); _hotkeyHintTimer = 0; }
            _hotkeyPending = { mods: mods, vk: vkMain };
            if (hotkeyInput) hotkeyInput.value = _fmtHotkey(mods, vkMain);
        }, true);

        if (saveGlobalSettingsBtn) {
            // 保存链在途锁。整链首个 await（inspectTargetData 桥调用）之前还没关弹窗，
            // 双击/连按 Enter 可以重入：两次 migrateData、两个覆盖确认互相打架（进度弹窗被
            // 提前收起、目标可能半份）。锁在 finally 释放——任何提前 return/抛错都不会锁死保存键。
            var _globalSettingsSaving = false;
            saveGlobalSettingsBtn.addEventListener('click', async () => {
                if (_globalSettingsSaving) {
                    console.warn('[Main] 保存已在进行中，忽略重复点击');
                    return;
                }
                _globalSettingsSaving = true;
                // 保存链整链异常兜底——迁移/同步/写入任何一步抛错会成为 unhandled
                // rejection（弹窗不关、无提示）。统一 error toast + 保持弹窗开启供重试
                try {
                    if (global.AEPickGuard && global.AEPickGuard.isBusy()) {
                        // toast 类型拼错 'warning' 会丢失 warn 样式/音效/时长（toast 只认 'warn'）
                        if (global.AEToast) global.AEToast.show(AEI18n.t('请先完成文件选择'), 'warn');
                        return;
                    }
                    var next = readGlobalSettingsFromUI();
                    var rawSetting = (next.dataDir || '').trim();
                    var resolveDir = global.AEShared && typeof global.AEShared.resolveDataDir === 'function'
                        ? global.AEShared.resolveDataDir : null;
                    var newDir;
                    // 保留 resolveDataDir 的 fallback 标志——不可写/危险自定义
                    // 路径会被静默回退默认目录，只取 .dir 丢弃标志时照常「保存成功」
                    //（检查分支见下方 rawDangerous 之后）
                    var dirFallback = false;
                    if (rawSetting) {
                        // 自定义路径 → resolveDataDir 统一包 AS_ExtP 子目录
                        var resolved = resolveDir ? resolveDir(rawSetting) : { dir: rawSetting };
                        newDir = resolved.dir;
                        dirFallback = resolved.fallback === true;
                    } else {
                        // 留空 = 恢复默认 AppData 目录
                        newDir = resolveDir ? resolveDir('').dir : '';
                    }
                    // 取当前实际数据目录（已包 AS_ExtP），作为迁移源 + 变更比较基准
                    var oldDir = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                        ? global.AEShared.getDataDir().dir : '';
                    // 安全检查：基于用户原始输入 rawSetting 判定危险（净化前），
                    // 与数据层 resolveDataDir/migrateData 的 isDataDirSafe 判定一致（单一真相源）。
                    // 必须放在 if(newDir!==oldDir) 外层：resolveDataDir 已把危险路径回退成默认目录，
                    // 若在内部用 newDir 判，dangerous 恒为 false 且 newDir===oldDir 时整个分支都不进入。
                    var rawDangerous = !!rawSetting && typeof AEFS !== 'undefined' && typeof AEFS.isDataDirSafe === 'function'
                        && !AEFS.isDataDirSafe(rawSetting);
                    if (rawDangerous) {
                        console.error('[Main] 拒绝危险数据目录: ' + rawSetting);
                        // resolveDataDir 已把候选根登记并同步给 bridge（UNC 白名单/bridge
                        // 数据根）——拒绝分支必须同步回真实生效目录：否则不关弹窗的这段时间里
                        // UNC 数据根下的 IO 会被 fail-closed 拒绝，直到重开设置弹窗才自愈
                        try {
                            if (global.AEShared && typeof global.AEShared.syncDataDirSetting === 'function') {
                                global.AEShared.syncDataDirSetting(activeGlobalSettings.dataDir || '');
                            }
                        } catch (_) {}
                        var dirElDanger = document.getElementById('globalDataDir');
                        if (dirElDanger) {
                            dirElDanger.value = activeGlobalSettings.dataDir || '';
                            dirElDanger.style.borderColor = '#ef6666';
                            dirElDanger.style.boxShadow = '0 0 8px rgba(239,102,102,.3)';
                            setTimeout(function () {
                                dirElDanger.style.borderColor = '';
                                dirElDanger.style.boxShadow = '';
                            }, 3000);
                        }
                        // 危险弹窗仅警示：向用户说明为何被拦截，确认后仍不放行（安全层硬性拒绝）
                        // 按真实原因归因（一律说「系统目录或盘根」时，相对路径、含引号/%
                        // 字符、UNC 深度不足都会被误指，把排查引向错方向）。归因不出来才用兜底文案。
                        var _dirWhy = (typeof AEFS !== 'undefined' && typeof AEFS.explainDataDirSafety === 'function')
                            ? String(AEFS.explainDataDirSafety(rawSetting) || '') : '';
                        var dangerMsg = AEI18n.t('该路径不可用作数据目录：{why}。\n\n被拒路径：\n「{path}」\n\n选择此类路径可能导致系统文件被覆盖或用户资料被误删。请选择独立的用户数据目录（如「D:\\AE_Data」）。', {
                            why: _dirWhy || AEI18n.t('位于系统目录或盘符根目录'),
                            path: rawSetting
                        });
                        if (typeof global.showConfirm === 'function') {
                            global.showConfirm(AEI18n.t('危险操作 - 数据目录被拦截'), dangerMsg, 'danger').then(function () {
                                if (global.AEToast) global.AEToast.show(AEI18n.t('已拒绝危险数据目录，未做任何更改。'), 'warn');
                            });
                        } else {
                            if (global.AEToast) global.AEToast.show(AEI18n.t('拒绝此路径：') + (_dirWhy || AEI18n.t('位于系统目录或根目录')) + AEI18n.t('，存在数据安全风险。请选择独立的用户数据目录（如 D:\\AE_Data）。'), 'error');
                        }
                        return;
                    }
                    // 不可写目录被 resolveDataDir 静默回退默认——丢弃
                    // fallback 标志假报成功，设置里存着新路径而运行时仍用旧目录；目录
                    // 恢复可写时 getDataDir 立即切换、迁移却只在保存动作触发 → 数据
                    // 滞留旧目录形同「消失」。按迁移失败同款处理：不更新数据目录
                    // 状态、不落盘该路径，恢复输入框旧值并明示当前实际生效目录
                    if (dirFallback) {
                        console.error('[Main] 数据目录不可写，已拒绝切换: ' + rawSetting);
                        // 同危险分支——被拒的候选根不能留在 bridge/UNC 白名单上
                        try {
                            if (global.AEShared && typeof global.AEShared.syncDataDirSetting === 'function') {
                                global.AEShared.syncDataDirSetting(activeGlobalSettings.dataDir || '');
                            }
                        } catch (_) {}
                        if (global.AEToast) global.AEToast.show(AEI18n.t('数据目录不可写，已保持原目录：') + oldDir + AEI18n.t('（请检查 ') + rawSetting + AEI18n.t(' 的写入权限）'), 'error');
                        var dirElFb = document.getElementById('globalDataDir');
                        if (dirElFb) {
                            dirElFb.value = activeGlobalSettings.dataDir || '';
                            dirElFb.style.borderColor = '#ef6666';
                            dirElFb.style.boxShadow = '0 0 8px rgba(239,102,102,.3)';
                            setTimeout(function () {
                                dirElFb.style.borderColor = '';
                                dirElFb.style.boxShadow = '';
                            }, 3000);
                        }
                        return;
                    }
                    // CP-2：记录已执行的迁移——副作用（拷贝数据/切指针）先于持久化发生，
                    // 持久化失败时据此向用户明示半迁移态（否则直接关弹窗后目录选择
                    // 静默回退，用户无从得知需重试）
                    var migrated = false;
                    // 目录身份判定（字符串归一化，与数据层 migrateData 内同一实现）。
                    // 只比字符串全等时——Windows 大小写不敏感，`d:\x` vs `D:\X`、尾斜杠、
                    // `\.`/`..` 都会被当成「换目录」→ inspectTargetData 把源自身当目标 →
                    // 用户确认覆盖后【删除阶段删掉唯一一份数据】（真机复现）。互为父子的目标同理会互删/递归拷贝。
                    var _dirMove = (global.AEShared && typeof global.AEShared.classifyDataDirMove === 'function')
                        ? global.AEShared.classifyDataDirMove(oldDir, newDir) : { kind: 'migrate' };
                    if (_dirMove.kind === 'nested') {
                        var _nestWhy = (_dirMove.side === 'new-in-old')
                            ? AEI18n.t('目标目录在当前数据目录内部') : AEI18n.t('当前数据目录在目标目录内部');
                        console.error('[Main] 拒绝互为父子的数据目录: ' + oldDir + ' ↔ ' + newDir);
                        // resolveDataDir 已把候选根登记/同步给 bridge——拒绝分支必须同步回真实
                        // 生效目录，否则被拒的这段时间里 UNC 白名单/bridge 数据根指着别处
                        try {
                            if (global.AEShared && typeof global.AEShared.syncDataDirSetting === 'function') {
                                global.AEShared.syncDataDirSetting(activeGlobalSettings.dataDir || '');
                            }
                        } catch (_) {}
                        var _nestMsg = AEI18n.t('目标目录与当前数据目录互为父子（{why}），迁移会互相覆盖或递归拷贝，已拒绝。\n\n当前数据目录：\n「{current}」\n\n目标目录：\n「{target}」\n\n请选择独立的用户数据目录（如「D:\\AE_Data」）。', {
                            why: _nestWhy,
                            current: oldDir,
                            target: newDir
                        });
                        var _nestEl = document.getElementById('globalDataDir');
                        if (_nestEl) {
                            _nestEl.value = activeGlobalSettings.dataDir || '';
                            _nestEl.style.borderColor = '#ef6666';
                            _nestEl.style.boxShadow = '0 0 8px rgba(239,102,102,.3)';
                            setTimeout(function () {
                                _nestEl.style.borderColor = '';
                                _nestEl.style.boxShadow = '';
                            }, 3000);
                        }
                        if (typeof global.showConfirm === 'function') {
                            global.showConfirm(AEI18n.t('危险操作 - 数据目录被拦截'), _nestMsg, 'danger').then(function () {
                                if (global.AEToast) global.AEToast.show(AEI18n.t('已拒绝互为父子的数据目录，未做任何更改。'), 'warn');
                            });
                        } else if (global.AEToast) {
                            global.AEToast.show(AEI18n.t('拒绝此路径：与当前数据目录互为父子，迁移会互相覆盖。请选择独立目录。'), 'error');
                        }
                        return;
                    }
                    if (_dirMove.kind === 'same') {
                        // 同一目录的书写差异：不迁移、不重载，按「未变更」保存
                        console.log('[Main] 数据目录仅书写差异，跳过迁移: ' + newDir + ' ≈ ' + oldDir);
                        newDir = oldDir;
                    }
                    if (newDir && newDir !== oldDir) {
                        // 目标目录已含 AS_ExtP 数据 → 弹窗询问
                        // 是否覆盖；确认后先删目标数据再整份复制（镜像），取消则不做任何切换
                        // （输入回退、设置不落盘）。探测不可用/失败按「可能已有数据」保守处理
                        // ——绝不静默走旧的跳过语义（同名文件被跳过 = 另一个目录期间的改动
                        // 静默丢失）。确认弹窗不可用时同样拒绝切换（不静默覆盖、也不静默跳过）。
                        var _overwrite = false;
                        var _targetIns = null;
                        try {
                            _targetIns = (global.AEShared && typeof global.AEShared.inspectTargetData === 'function')
                                ? await global.AEShared.inspectTargetData(newDir) : null;
                        } catch (_insErr) { _targetIns = null; }
                        var _needOvConfirm = !_targetIns || _targetIns.ok !== true || _targetIns.hasData === true;
                        if (_needOvConfirm) {
                            var _ovNames = (_targetIns && Array.isArray(_targetIns.entries)) ? _targetIns.entries : [];
                            var _ovList = _ovNames.length
                                ? AEI18n.t('（{count} 项：{names}{more}）', {
                                    count: _ovNames.length,
                                    names: _ovNames.slice(0, 10).join(AEI18n.punct('、', ', ')),
                                    more: _ovNames.length > 10
                                        ? AEI18n.t(' 等 {count} 项', { count: _ovNames.length }) : ''
                                })
                                : AEI18n.t('（清单不可读，按已有数据处理）');
                            var _ovMsg = AEI18n.t('目标目录已存在 AS_ExtP 数据{list}。\n\n继续将先删除目标目录中的现有数据（优先移入回收站；无法移入时将永久删除，不可恢复），再用当前目录「{current}」的数据整份覆盖。\n\n目标路径：\n「{target}」\n\n此操作不可撤销，是否覆盖？', {
                                list: _ovList,
                                current: oldDir,
                                target: newDir
                            });
                            if (typeof global.showConfirm !== 'function') {
                                console.error('[Main] 目标目录已含数据但确认弹窗不可用，拒绝切换: ' + newDir);
                                if (global.AEToast) global.AEToast.show(AEI18n.t('目标目录已存在数据，但确认弹窗不可用，已取消切换（未做任何更改）。'), 'error');
                                var _ovNoConfirmEl = document.getElementById('globalDataDir');
                                if (_ovNoConfirmEl) _ovNoConfirmEl.value = activeGlobalSettings.dataDir || '';
                                return;
                            }
                            var _ovOk = false;
                            try { _ovOk = await global.showConfirm(AEI18n.t('数据目录已存在数据 - 是否覆盖？'), _ovMsg, 'danger'); } catch (_) { _ovOk = false; }
                            if (!_ovOk) {
                                console.log('[Main] 用户取消覆盖目标目录数据，未切换: ' + newDir);
                                var _ovResetEl = document.getElementById('globalDataDir');
                                if (_ovResetEl) _ovResetEl.value = activeGlobalSettings.dataDir || '';
                                if (global.AEToast) global.AEToast.show(AEI18n.t('已取消切换：目标目录未做任何更改，数据目录仍为「') + oldDir + AEI18n.punct('」。', '".', '」。', '“.', '”.', ' ».', '».'), 'warn');
                                return;
                            }
                            _overwrite = true;
                        }
                        // 与其他设置的保存一致——**点保存即退出全局设置弹窗**，
                        // 随后由进度弹窗接管（留在弹窗里既挡住进度、也不像"保存完成"）。
                        // 取消覆盖确认等更早的 return 分支不会走到这里，弹窗仍开着可继续改。
                        closeModal('globalSettingsModal');
                        // 迁移期间显示**进度条弹窗**（覆盖删除 + 整份复制要数秒，
                        // 只在完成后才弹重载确认，看着像卡住）。进度由迁移层 onProgress 回调驱动。
                        _showDataDirProgress();
                        // 路径变更 → 先验证权限，再迁移数据
                        var result;
                        try {
                            result = (global.AEShared && typeof global.AEShared.migrateData === 'function')
                                ? await global.AEShared.migrateData(oldDir, newDir, {
                                    overwrite: _overwrite,
                                    onProgress: _updateDataDirProgress
                                })
                                : { ok: false, error: AEI18n.t('dataDir 模块未就绪') };
                        } finally {
                            _hideDataDirProgress();   // 成功/失败/异常都必须收起进度弹窗（不得残留）
                        }
                        if (!result || !result.ok) {
                            if (oldDir !== newDir) {
                                var _migErr = (result && result.error) ? result.error : AEI18n.t('未知错误');
                                // 失败文案按 code 分派——除 TARGET_HAS_DATA 外一律追加
                                // 「请检查路径是否存在、是否可写」，对「文件被占用」「清单读不到」
                                // 「互为父子」等情形答非所问
                                var _migErrTail = _dataDirMigrateErrTail(result);
                                console.error('[Main] 数据迁移失败: ' + _migErr);
                                // 迁移分支已「保存即关弹窗」——失败把弹窗开回来（可继续改/重试）
                                try { openModal('globalSettingsModal'); } catch (_) {}
                                if (global.AEToast) global.AEToast.show(AEI18n.t('数据迁移失败：') + _migErr + _migErrTail, 'error');
                            }
                            var dirEl = document.getElementById('globalDataDir');
                            if (dirEl) {
                                dirEl.value = activeGlobalSettings.dataDir || '';
                                dirEl.style.borderColor = '#ef6666';
                                dirEl.style.boxShadow = '0 0 8px rgba(239,102,102,.3)';
                                setTimeout(function () {
                                    dirEl.style.borderColor = '';
                                    dirEl.style.boxShadow = '';
                                }, 3000);
                            }
                            return;
                        }
                        migrated = true;
                    }
                    activeGlobalSettings = next;
                    // 数据目录变更路径上，next 是**迁移 await 之前**（本函数开头）抓的快照；那些 await
                    // （inspectTargetData / showConfirm / migrateData，秒级）期间 Agent 可能已改过主题：
                    // syncThemeState 只刷了当时那个 activeGlobalSettings 对象，被这里的重新赋值丢弃。
                    // 若不重贴一次，紧接着的 saveGlobalSettings(activeGlobalSettings) 会把陈旧的
                    // themePreset / 方案库 / 快照写回盘上——Agent 的改动在重启后消失（且只需一次
                    // 「保存全局设置」即可触发）。主题键以 panelTheme 为唯一事实源，这里以它为准。
                    // 同样走 typeof 守卫 + 独立函数：本回调会被函数体抽取型套件放进受控作用域执行。
                    if (typeof resyncThemeState === 'function') resyncThemeState();
                    // 同步 lowPerfMode 到全局，供各模块读取
                    global.AE_ExtP_LowPerfMode = !!next.lowPerfMode;
                    // 实时通知桌宠 controller 切换低性能模式（FPS 降级即时生效）
                    if (global.AEDeepseekPet && global.AEDeepseekPet.controller && typeof global.AEDeepseekPet.controller.setLowPerfMode === 'function') {
                        global.AEDeepseekPet.controller.setLowPerfMode(!!next.lowPerfMode);
                    }
                    // 实时通知 agent 模块：开启低性能模式时停止粒子引擎
                    if (global.AEAgent && typeof global.AEAgent.setLowPerfMode === 'function') {
                        global.AEAgent.setLowPerfMode(!!next.lowPerfMode);
                    }
                    if (global.AEShared && typeof global.AEShared.syncDataDirSetting === 'function') {
                        global.AEShared.syncDataDirSetting(next.dataDir || '');
                        // 同步新数据目录到 Bridge Server（错误日志路径跟随；
                        // 统一入口强制重发，非 2xx/异常按失败告警且可重试）
                        try {
                            if (typeof global.AEShared.resyncDataDirToBridge === 'function') {
                                global.AEShared.resyncDataDirToBridge();
                            }
                        } catch (_) {}
                    }
                    // 写入失败（writeRaw 捕获配额满/加密异常后返回 false）——error toast
                    // + 保持弹窗开启供重试，不继续走清背景图/关弹窗/成功提示
                    // CP-2：迁移已执行时明示半迁移态——数据已拷贝/指针已切换，但设置未落盘，
                    // 直接关弹窗并重启会让目录选择静默回退；重试不会重复迁移（此时
                    // getDataDir 已指向新目录，newDir === oldDir 跳过迁移）可自愈
                    var saved = await saveGlobalSettings(activeGlobalSettings);
                    // 主题键交给 panelTheme 落盘（写入口唯一化）。**必须走 typeof 守卫 + 独立函数**：
                    // 本回调被若干「函数体抽取型」套件
                    // 放进受控形参表里执行，那里没有本模块的顶层绑定
                    // （panelTheme / _tempCustomColors），直接引用会抛 ReferenceError 并吞掉其后全部步骤。
                    if (saved !== false && typeof applyThemeKeysAfterSave === 'function') {
                        await applyThemeKeysAfterSave();
                    }
                    if (saved === false) {
                        console.error('[Main] 全局设置写入持久层失败');
                        // 迁移分支已按「保存即关弹窗」——失败时把弹窗开回来，
                        // 保住的「失败仍可继续重试」语义（字段值仍在，点保存即可重试）
                        if (migrated) { try { openModal('globalSettingsModal'); } catch (_) {} }
                        if (global.AEToast) global.AEToast.show(migrated
                            ? AEI18n.t('全局设置保存失败（存储配额满或加密异常）。数据已复制到新目录「') + newDir + AEI18n.t('」，请重试保存完成切换（不会重复迁移）；若直接关闭弹窗并重启，数据目录将回退为「') + oldDir + AEI18n.punct('」。', '".', '」。', '“.', '”.', ' ».', '».')
                            : AEI18n.t('全局设置保存失败：写入持久层失败（存储配额满或加密异常），请重试。'), 'error');
                        return;
                    }
                    // 调试模式：落盘成功后才应用（拨动开关不产生任何副作用）——调试日志栏、
                    // 调试项可见性、引擎侧已渲染消息的重建登记都在 AEAgent.setDebugMode 里。
                    // 位置在持久化之后：写失败时弹窗保持开启可重试，运行时态不得先行改变。
                    // 单独 try：应用失败**不得**被下方 catch 当成「保存失败」——设置其实已落盘，
                    // 谎报失败会让用户重试一次已经成功的保存；如实说明"已保存、本次未生效"。
                    if (global.AEAgent && typeof global.AEAgent.setDebugMode === 'function') {
                        try {
                            global.AEAgent.setDebugMode(!!activeGlobalSettings.debugMode);
                        } catch (_dbgApplyErr) {
                            var _dbgApplyMsg = _dbgApplyErr && _dbgApplyErr.message ? _dbgApplyErr.message : _dbgApplyErr;
                            console.error('[Main] 调试模式已保存但应用失败: ' + _dbgApplyMsg);
                            if (global.AEToast) {
                                global.AEToast.show(AEI18n.t('调试模式已保存，但本次未生效（应用失败，详见控制台日志）'), 'warn');
                            }
                        }
                    }
                    // 迁移成功提示放在持久化成功之后——副作用先行时先弹「已迁移」，
                    // 随后保存失败，用户先后收到成功与失败两条互相矛盾的提示
                    if (migrated) {
                        console.log('[Main] 数据迁移成功: ' + oldDir + ' → ' + newDir);
                        // 不再断言旧目录数据已全部拷贝——migrateData 现在按运行时枚举，
                        // 如实返回 migrated/excluded/skipped；文案按计数陈述（含未迁移项清单）。
                        // 结果对象缺计数字段（旧返回形态/测试 mock）时只陈述事实，不做完整性断言
                        var _nm = [];
                        if (result && Array.isArray(result.excluded)) _nm = _nm.concat(result.excluded);
                        if (result && Array.isArray(result.skipped)) _nm = _nm.concat(result.skipped);
                        var _detail = (result && typeof result.migrated === 'number')
                            ? (_nm.length
                                ? AEI18n.t('已迁移 {done} 项，未迁移 {left} 项：{names}', {
                                    done: result.migrated,
                                    left: _nm.length,
                                    names: _nm.join(AEI18n.punct('、', ', '))
                                })
                                : AEI18n.t('已迁移 {done} 项', { done: result.migrated }))
                            : AEI18n.t('旧目录内容已复制');
                        // 覆盖模式下如实报告目标侧被删除的条目数（镜像前先清的目标数据）
                        if (result && typeof result.replaced === 'number' && result.replaced > 0) {
                            _detail += AEI18n.t('（覆盖：目标目录原有 {count} 项已先删除）', { count: result.replaced });
                        }
                        // 九续：库索引里的旧根路径重写失败时如实告知（数据已复制完、迁移成功，
                        // 但换目录后这些库可能出现重复条目）——warn 由 dataDir 侧给出，不在这里编造
                        if (result && typeof result.warn === 'string' && result.warn) {
                            _detail += AEI18n.t('。注意：{warn}', { warn: result.warn });
                        }
                        // 数据层给的事实性备注（如「源目录无数据条目，未删除目标内容」、
                        // 「仅书写差异未迁移」）如实透出——丢弃它会让用户误判目标目录状态
                        if (result && typeof result.note === 'string' && result.note) {
                            _detail += AEI18n.punct('（', ' (') + result.note + AEI18n.punct('）', ')');
                        }
                        // 三库/会话/画布 store 仍是旧目录字符串快照，重载面板前
                        // 新增数据仍写入旧目录；删除必须以「重载 + 核对」为前提。
                        // 不再 2 秒自动重载（toast 来不及读）——改由
                        // _promptReloadAfterDataDirMigration 弹窗讲清详情与「需要重载」，
                        // **点确认才重载**；点取消则只留一条 warn 提醒（勿删旧目录）。
                        var _promptFn = (typeof global.__aePromptReloadAfterDataDirMigration === 'function')
                            ? global.__aePromptReloadAfterDataDirMigration : null;
                        if (_promptFn) {
                            try {
                                await _promptFn(_detail, oldDir, newDir);
                            } catch (_rErr) {
                                console.error('[Main] 重载确认弹窗异常: ' + (_rErr && _rErr.message ? _rErr.message : _rErr));
                                if (global.AEToast) {
                                    global.AEToast.show(AEI18n.t('数据已迁移至：') + newDir + AEI18n.punct('（', ' (') + _detail + AEI18n.punct('）。', ').')
                                        + AEI18n.t('请手动重载面板；重载前请勿删除旧目录：') + oldDir, 'warn', { autoHideMs: 0 });
                                }
                            }
                        } else if (global.AEToast) {
                            // 注入缺失（异常环境）：至少把事实与提醒如实说出去
                            global.AEToast.show(AEI18n.t('数据已迁移至：') + newDir + AEI18n.punct('（', ' (') + _detail + AEI18n.punct('）。', ').')
                                + AEI18n.t('重载面板前新数据仍会写入旧目录，请勿删除旧目录：') + oldDir
                                + AEI18n.t('。重载后请核对数据无误再手动删除旧目录。'), 'warn', { autoHideMs: 0 });
                        }
                    }
                    // 热盒热键请求（须在 syncDataDirSetting 之后 → 写进新数据目录）：
                    // 与 config.json 当前值不同才写请求；AEGP IdleHook 空闲时处理，删文件 = 应答
                    if (_hotkeyPending) {
                        var curHk = (global.AEShared && typeof global.AEShared.readHotboxHotkey === 'function')
                            ? global.AEShared.readHotboxHotkey() : null;
                        var hkChanged = !curHk || curHk.mods !== _hotkeyPending.mods || curHk.vk !== _hotkeyPending.vk;
                        if (hkChanged) {
                            var hkWritten = (global.AEShared && typeof global.AEShared.writeHotboxHotkeyRequest === 'function')
                                && global.AEShared.writeHotboxHotkeyRequest(_hotkeyPending.mods, _hotkeyPending.vk);
                            if (hkWritten) {
                                _startHotkeyFeedbackPoll(_hotkeyPending);
                            } else {
                                if (global.AEToast) global.AEToast.show(AEI18n.t('热盒快捷键请求写入失败，热键未更改。'), 'error');
                            }
                        }
                        _hotkeyPending = null;
                    }
                    // 清理不再被引用的旧背景图（换图/清除的文件删除在此真正落盘）
                    _cleanBgOverlayDir(activeGlobalSettings.bgOverlayImage || '');
                    _bgOverlayImageAtOpen = activeGlobalSettings.bgOverlayImage || '';
                    applyGlobalSettingsToUI();
                    // 语言设置写 localStorage 作为启动期唯一事实源；写成功即重载面板（设置行常显「切换后重载面板生效」）。
                    // 不弹二次确认：showConfirm 由 Agent 模块提供，全局设置保存时可能尚未挂载；
                    // 保存本身就是显式动作，重载与会话持久化互不依赖（会话落 AEFS/store）。
                    var prevLocale = global.AEI18n ? global.AEI18n.getLocaleSetting() : 'auto';
                    var nextLocale = activeGlobalSettings.uiLocale || 'auto';
                    if (global.AEI18n) {
                        global.AEI18n.setLocaleSetting(nextLocale);
                        if (nextLocale !== prevLocale) global.location.reload();
                    }
                    // 迁移路径已在弹重载确认前关过（见上方 closeModal）——此处只补非迁移路径
                    if (!migrated) closeModal('globalSettingsModal');
                    if (global.AEToast) global.AEToast.show(AEI18n.t('全局设置已保存'), 'success');
                } catch (e) {
                    // 兜底迁移/同步链抛出的任何异常——否则成为 unhandled rejection，
                    // 弹窗不关且无提示；现统一 error toast + 保持弹窗开启
                    console.error('[Main] 全局设置保存失败: ' + (e && e.message ? e.message : e));
                    // 迁移分支过了首个 await 就先关了设置弹窗（保存即退出）——若异常发生在
                    // 关闭之后、migrated 置位之前，弹窗会一直关着（要用户自己找齿轮重开）。
                    // 与「迁移失败 / 持久化失败」两分支的重开口径对齐。
                    if (!migrated) { try { openModal('globalSettingsModal'); } catch (_) {} }
                    if (global.AEToast) global.AEToast.show(AEI18n.t('全局设置保存失败：') + (e && e.message ? e.message : e), 'error');
                } finally {
                    _globalSettingsSaving = false;
                }
            });
        }

        if (globalThemePreset) {
            globalThemePreset.addEventListener('change', () => {
                const preset = globalThemePreset.value || 'default';
                toggleCustomThemePanel(preset === 'custom');
                // 档位切换只改**草稿**并立即预览（不落盘），落盘统一发生在「保存全局设置」。
                // 这里若读 readGlobalSettingsFromUI() 取 preview.themePreset，而该函数按设计
                // **不返回主题键**（见其注释），于是拿到的恒是上次保存的档位——换档位看不见任何
                // 变化、必须点保存才生效（用户实报）。改为经 panelTheme（唯一事实源）切草稿。
                if (panelTheme && typeof panelTheme.setPresetKey === 'function') {
                    panelTheme.setPresetKey(preset).then(function (r) {
                        if (r && r.ok !== true) {
                            if (global.AEToast) global.AEToast.show((r && r.message) || AEI18n.t('主题档位切换失败'), 'error');
                            // 失败：档位未变，把下拉回填到 store 的真实档位（程序化赋值不触发 change）
                            globalThemePreset.value = panelTheme.getState().themePreset;
                            if (typeof global.refreshCustomSelect === 'function') global.refreshCustomSelect(globalThemePreset);
                        }
                    });
                } else {
                    applyTheme(preset);
                }
            });
        }

        var soundVolSlider = document.getElementById('globalSoundVolume');
        if (soundVolSlider) {
            var _volPreviewTimer = 0;
            soundVolSlider.addEventListener('input', () => {
                var v = Math.max(0, Math.min(1, parseInt(soundVolSlider.value, 10) / 100));
                global.__aeSoundVolume = v;
                var label = document.getElementById('globalSoundVolumeLabel');
                if (label) label.textContent = Math.round(v * 100) + '%';
                // 节流预览：拖动中每 250ms 播放一次，松手时再播一次
                if (!_volPreviewTimer) {
                    _volPreviewTimer = setTimeout(() => { _volPreviewTimer = 0; }, 250);
                    if (typeof aeBeep === 'function' && v > 0) aeBeep('soft');
                }
            });
            soundVolSlider.addEventListener('change', () => {
                if (_volPreviewTimer) { clearTimeout(_volPreviewTimer); _volPreviewTimer = 0; }
                var v = Math.max(0, Math.min(1, parseInt(soundVolSlider.value, 10) / 100));
                if (typeof aeBeep === 'function' && v > 0) aeBeep('soft');
            });
        }

        // ---- 音效音量：长按音量标识蓄力，松开发射黄点设置音量 ----
        var volIndicator = document.getElementById('globalSoundVolumeIndicator');
        var volProjectile = document.getElementById('globalSoundVolumeProjectile');
        if (volIndicator && soundVolSlider) {
            var _MAX_CHARGE_MS = 1500; // 蓄满 100% 所需时长
            var _chargeStart = 0;
            var _chargeRaf = 0;
            var _volIndicatorIcon = volIndicator.querySelector('.vol-indicator-icon');
            var _chargeRing = volIndicator.querySelector('.vol-charge-ring');
            var _thumbW = 16; // 与 CSS thumb 宽度一致
            var _projW = 16; // 发射黄点 vol-projectile 尺寸（与 CSS 一致）

            // 隐藏原生滑块黄点，让发射黄点成为滑块上唯一的可见点，避免两套位置对不上
            soundVolSlider.classList.add('vol-hiding-thumb');

            // 计算数值 v(0~1) 对应的滑块 thumb 中心坐标（相对定位父级 flex div），
            // 返回黄点左上角（left/top），使其中心精确对准 thumb 中心。
            // 用 offsetLeft/offsetWidth 取 CSS 布局坐标，避免 modal 的 transform:scale 影响 getBoundingClientRect 造成错位。
            function _thumbCenter(v) {
                var sliderLeft = soundVolSlider.offsetLeft;
                var sliderTop = soundVolSlider.offsetTop;
                var sliderW = soundVolSlider.offsetWidth;
                var sliderH = soundVolSlider.offsetHeight;
                var x = sliderLeft + (sliderW - _thumbW) * v + _thumbW / 2 - _projW / 2;
                var y = sliderTop + sliderH / 2 - _projW / 2;
                return { left: x, top: y };
            }

            // 把黄点作为滑块可见点，摆放到数值 v 对应的位置
            function _placeProjectile(v) {
                if (!volProjectile) return;
                var c = _thumbCenter(v);
                volProjectile.style.transition = 'none';
                volProjectile.style.left = c.left + 'px';
                volProjectile.style.top = c.top + 'px';
                volProjectile.style.opacity = '1';
                volProjectile.style.transform = 'scale(1)';
            }

            // 暴露黄点定位同步：在模态框显示、布局完成后调用，避免隐藏态下 offset 为 0 导致初始位置错位
            global.__aeSyncVolProjectile = function () {
                var v = global.__aeSoundVolume != null ? global.__aeSoundVolume : 1;
                _placeProjectile(Math.max(0, Math.min(1, v)));
            };

            function _setCharge(c) {
                // 长按旋转音量标识瞄准，蓄力越久转得越多（最大 60°）
                if (_volIndicatorIcon) {
                    // 图标蓄力震动：正弦水平抖动叠加到旋转 transform，随蓄力 0→±2px。
                    // 只作用于图标（不带动蓄力环）；蓄力期间关掉 .05s 过渡，保证抖动清晰不糊。
                    _volIndicatorIcon.style.transform = 'rotate(' + (-c * 60) + 'deg) translateX(' +
                        (Math.sin(performance.now() / 20) * c * 2) + 'px)';
                    _volIndicatorIcon.style.transition = c > 0 ? 'none' : '';
                }
                if (_chargeRing) _chargeRing.style.setProperty('--charge', c);
                volIndicator.classList.toggle('charging', c > 0);
            }

            function _fire() {
                var held = Math.min(Date.now() - _chargeStart, _MAX_CHARGE_MS);
                var c = held / _MAX_CHARGE_MS;
                var value = Math.max(0, Math.min(100, Math.round(c * 100)));
                soundVolSlider.value = value;
                var v = value / 100;
                global.__aeSoundVolume = v;
                var label = document.getElementById('globalSoundVolumeLabel');
                if (label) label.textContent = Math.round(v * 100) + '%';
                if (typeof aeBeep === 'function' && v > 0) aeBeep('soft');
                if (volProjectile) _animateProjectile(c);
            }

            function _animateProjectile(c) {
                // 起点基于 offset 布局坐标（与 _thumbCenter 同坐标系），避免 modal transform 错位。
                // 图标 offsetParent 即定位父级 flex div，与黄点 absolute 定位容器一致。
                var r = volIndicator.offsetWidth / 2;
                // 发射方向决定：黄点沿图标当前旋转角方向射出（图标旋转角即发射角）
                var rotDeg = -c * 60; // 与 _setCharge 中图标旋转同源
                var phi = (rotDeg * Math.PI) / 180;
                var sx = volIndicator.offsetLeft + volIndicator.offsetWidth / 2 - _projW / 2 + r * Math.cos(phi);
                var sy = volIndicator.offsetTop + volIndicator.offsetHeight / 2 - _projW / 2 + r * Math.sin(phi);
                // 落点：黄点最终停稳的位置 = 滑块 thumb 中心，由数值精确定位，保证与音量位置一致
                var target = _thumbCenter(c);
                var ex = Math.max(sx, target.left);
                var ey = target.top;
                // 弧线：二次贝塞尔，控制点取中点上方，形成上抛弧线落到音量条
                var arcH = Math.min(60, Math.max(20, (ex - sx) * 0.25));
                var cx = (sx + ex) / 2;
                var cy = Math.min(sy, ey) - arcH;
                // 动画时长随发射距离变化：距离越短越快（160ms~700ms）
                var dist = Math.abs(ex - sx);
                var dur = Math.max(160, Math.min(700, 160 + dist * 0.9));
                var t0 = performance.now();
                volProjectile.style.transition = 'none';
                volProjectile.style.opacity = '1';
                volProjectile.style.transform = 'scale(1)';
                (function step(now) {
                    var p = Math.min(1, (now - t0) / dur);
                    var u = 1 - p;
                    volProjectile.style.left = (u * u * sx + 2 * u * p * cx + p * p * ex) + 'px';
                    volProjectile.style.top = (u * u * sy + 2 * u * p * cy + p * p * ey) + 'px';
                    if (p < 1) {
                        requestAnimationFrame(step);
                    } else {
                        // 落地：同一个黄点停稳在 thumb 位置，作为滑块上唯一的可见点
                        _placeProjectile(c);
                    }
                })(performance.now());
            }

            var _charging = false;   // 本次按下有效标志——别处按下拖到图标上释放的 pointerup 不触发
            volIndicator.addEventListener('pointerdown', function (e) {
                if (e.button !== 0) return;
                e.preventDefault();
                // 原生滑块黄点已全局隐藏，发射黄点即为滑块唯一可见点；蓄力期间隐藏，松手发射时再出现
                if (volProjectile) volProjectile.style.opacity = '0';
                try { volIndicator.setPointerCapture(e.pointerId); } catch (_) {}
                _chargeStart = Date.now();
                _charging = true;
                _setCharge(0);
                if (typeof aeChargeStart === 'function') aeChargeStart(); // 蓄力音效开始
                if (_chargeRaf) cancelAnimationFrame(_chargeRaf);
                (function tick() {
                    var c = Math.min(1, (Date.now() - _chargeStart) / _MAX_CHARGE_MS);
                    _setCharge(c);
                    if (typeof aeChargeUpdate === 'function') aeChargeUpdate(c); // 蓄力音效随进度变响
                    _chargeRaf = requestAnimationFrame(tick); // 蓄满后继续跑，图标保持抖动直到松手
                })();
            });
            function _endCharge() {
                // 非本次按下的 pointerup 直接忽略——弹窗空白处按下后拖到图标上
                // 释放时，_chargeStart 为 0（或极早的陈旧值），_fire 会把音量瞬间顶满 100%
                if (!_charging) return;
                _charging = false;
                if (_chargeRaf) { cancelAnimationFrame(_chargeRaf); _chargeRaf = 0; }
                if (typeof aeChargeStop === 'function') aeChargeStop(); // 蓄力音效停止
                _fire();
                _setCharge(0);
            }
            volIndicator.addEventListener('pointerup', _endCharge);
            volIndicator.addEventListener('pointercancel', _endCharge);

            // 拖动滑块时，同步黄点作为可见点跟随数值
            soundVolSlider.addEventListener('input', function () {
                var v = Math.max(0, Math.min(1, parseInt(soundVolSlider.value, 10) / 100));
                _placeProjectile(v);
            });
            // 初始化：恢复当前音量对应的黄点位置
            var _initV = global.__aeSoundVolume != null ? global.__aeSoundVolume : 1;
            _placeProjectile(Math.max(0, Math.min(1, _initV)));
        }

        // ---- 背景叠加层：文件选择 / 清除 / 实时预览 ----
        var browseBgOverlayBtn = document.getElementById('browseBgOverlayBtn');
        if (browseBgOverlayBtn) {
            browseBgOverlayBtn.addEventListener('click', function () {
                if (!global.AEPickGuard) return;
                global.AEPickGuard.pickFile({ title: AEI18n.t('选择背景图片') }, function (srcPath) {
                    // 二次防御：若面板已关闭，放弃后续 DOM 写入与背景应用，避免脏数据
                    if (!_isGlobalSettingsOpen()) return;
                    if (!srcPath) return;
                    // 拷贝到数据目录 temp/bg-overlay/ 下（temp 在安全命名空间内）
                    var dataDir = global.AEShared && typeof global.AEShared.getDataDir === 'function'
                        ? global.AEShared.getDataDir().dir : '';
                    if (!dataDir || typeof AEFS === 'undefined' || typeof AEFS.copyFile !== 'function') {
                        if (global.AEToast) global.AEToast.show(AEI18n.t('文件系统不可用，无法拷贝图片'), 'error');
                        return;
                    }
                    var fileName = srcPath.replace(/\\/g, '/').split('/').pop();
                    var dirRel = 'temp\\bg-overlay';
                    var dirAbs = dataDir.replace(/\\+$/, '') + '\\' + dirRel;
                    // 确保目录存在，随后列目录做同名唯一化：copyFile 为无条件覆盖语义，
                    // 直接用源文件名会在用户选了另一张同名图又未保存关闭时，静默改写已保存
                    // 背景图的内容（未保存关闭的快照恢复只保路径存活，不保内容）。
                    AEFS.mkdir(dirAbs).then(function () {
                        // 三态取清单（不再是 listFiles 的「失败折叠成 []」）。折叠成空表
                        // 会让「同名唯一化」把已保存的背景图当成不存在 → copyFile 无条件覆盖
                        // 语义直接**静默改写已保存图的内容**。
                        // 只有 ok(data) 与 NOT_FOUND（新目录）才继续；其余失败如实拒绝本次设置。
                        return (typeof AEFS.listFilesResult === 'function')
                            ? AEFS.listFilesResult(dirAbs)
                            : AEFS.listFiles(dirAbs).then(function (names) { return { ok: true, data: names }; });
                    }).then(function (fr) {
                        var chCode = (fr && fr.ok !== true && fr.error && fr.error.code) ? fr.error.code : '';
                        if (!fr || fr.ok !== true) {
                            if (chCode === 'NOT_FOUND') { fr = { ok: true, data: [] }; }   // 目录刚建/不存在：无同名可冲突
                            else {
                                console.warn('[Main] 背景图目录清单读取失败 (' + (chCode || '未知') + ')，拒绝设置以避免覆盖已保存图: ' + dirAbs);
                                if (global.AEToast) global.AEToast.show(AEI18n.t('背景图目录清单读取失败（') + (chCode || AEI18n.t('通道故障')) + AEI18n.t('），为避免覆盖已保存的背景图已取消本次设置，请重试'), 'error');
                                return;
                            }
                        }
                        var names = Array.isArray(fr.data) ? fr.data : [];
                        var taken = {};
                        (Array.isArray(names) ? names : []).forEach(function (n) { taken[String(n)] = true; });
                        var dot = fileName.lastIndexOf('.');
                        var stem = dot > 0 ? fileName.substring(0, dot) : fileName;
                        var ext = dot > 0 ? fileName.substring(dot) : '';
                        var unique = fileName;
                        for (var i = 1; taken[unique] && i <= 999; i++) unique = stem + '-' + i + ext;
                        // 999 个同名候选全部冲突时，unique 保持最后一个冲突名，
                        // copyFile 的无条件覆盖语义会静默改写已保存背景图内容（防
                        // 覆盖机制失效）——显式拒绝并提示，不再静默回退覆盖语义
                        if (taken[unique]) {
                            if (global.AEToast) global.AEToast.show(AEI18n.t('同名背景图超过 999 个，请先清理背景图临时目录'), 'error');
                            return;
                        }
                        var dstRel = dirRel + '\\' + unique;
                        var dstAbs = dirAbs + '\\' + unique;
                        return AEFS.copyFile(srcPath, dstAbs).then(function (ok) {
                            if (!ok) {
                                if (global.AEToast) global.AEToast.show(AEI18n.t('图片拷贝失败，请检查文件是否可读'), 'error');
                                return;
                            }
                            // 异步拷贝完成后再校验一次面板状态（拷贝期间用户可能关闭面板）
                            if (!_isGlobalSettingsOpen()) return;
                            // 旧图的删除延后到保存/关闭时（_cleanBgOverlayDir），避免未保存关闭时旧路径指向已删除文件
                            activeGlobalSettings.bgOverlayImage = dstRel;
                            var pathEl = document.getElementById('globalBgOverlayPath');
                            if (pathEl) pathEl.value = dstRel;
                            applyBgOverlay(activeGlobalSettings);
                            if (global.AEToast) global.AEToast.show(AEI18n.t('背景图片已设置'), 'success');
                        });
                    });
                });
            });
        }

        var clearBgOverlayBtn = document.getElementById('clearBgOverlayBtn');
        if (clearBgOverlayBtn) {
            clearBgOverlayBtn.addEventListener('click', function () {
                // 仅清除预览（内存 + UI）；图片文件的删除延后到保存/关闭时（_cleanBgOverlayDir），
                // 否则未保存关闭时恢复旧路径会指向已被删除的文件，叠加层无法恢复
                activeGlobalSettings.bgOverlayImage = '';
                var pathEl = document.getElementById('globalBgOverlayPath');
                if (pathEl) pathEl.value = '';
                applyBgOverlay(activeGlobalSettings);
            });
        }

        // 实时预览：透明度 / 对比度 / 混合模式 / 填充模式 / 黑白
        function _previewBgOverlay() {
            var preview = readGlobalSettingsFromUI();
            applyBgOverlay(preview);
        }
        var bgOpacitySlider = document.getElementById('globalBgOverlayOpacity');
        var bgOpacityInput = document.getElementById('globalBgOverlayOpacityLabel');
        if (bgOpacitySlider) {
            bgOpacitySlider.addEventListener('input', function () {
                if (bgOpacityInput) bgOpacityInput.value = bgOpacitySlider.value;
                _previewBgOverlay();
            });
        }
        if (bgOpacityInput) {
            bgOpacityInput.addEventListener('input', function () {
                var v = parseInt(bgOpacityInput.value, 10);
                if (!isNaN(v)) {
                    bgOpacityInput.value = v;
                    bgOpacitySlider.value = Math.max(0, Math.min(100, v));
                }
                _previewBgOverlay();
            });
        }
        var bgContrastSlider = document.getElementById('globalBgOverlayContrast');
        var bgContrastInput = document.getElementById('globalBgOverlayContrastLabel');
        if (bgContrastSlider) {
            bgContrastSlider.addEventListener('input', function () {
                if (bgContrastInput) bgContrastInput.value = bgContrastSlider.value;
                _previewBgOverlay();
            });
        }
        if (bgContrastInput) {
            bgContrastInput.addEventListener('input', function () {
                var v = parseInt(bgContrastInput.value, 10);
                if (!isNaN(v)) {
                    bgContrastInput.value = v;
                    bgContrastSlider.value = Math.max(0, Math.min(200, v));
                }
                _previewBgOverlay();
            });
        }
        var bgBlendSelect = document.getElementById('globalBgOverlayBlend');
        if (bgBlendSelect) bgBlendSelect.addEventListener('change', _previewBgOverlay);
        var bgFillSelect = document.getElementById('globalBgOverlayFill');
        if (bgFillSelect) bgFillSelect.addEventListener('change', _previewBgOverlay);
        var bgGrayscaleToggle = document.getElementById('globalBgOverlayGrayscale');
        if (bgGrayscaleToggle) bgGrayscaleToggle.addEventListener('change', _previewBgOverlay);
        var bgOffsetXSlider = document.getElementById('globalBgOverlayOffsetX');
        var bgOffsetXInput = document.getElementById('globalBgOverlayOffsetXLabel');
        if (bgOffsetXSlider) {
            bgOffsetXSlider.addEventListener('input', function () {
                if (bgOffsetXInput) bgOffsetXInput.value = bgOffsetXSlider.value;
                _previewBgOverlay();
            });
        }
        if (bgOffsetXInput) {
            bgOffsetXInput.addEventListener('input', function () {
                var v = parseInt(bgOffsetXInput.value, 10);
                if (!isNaN(v)) {
                    bgOffsetXInput.value = v;
                    bgOffsetXSlider.value = Math.max(-100, Math.min(100, v));
                }
                _previewBgOverlay();
            });
        }
        var bgOffsetYSlider = document.getElementById('globalBgOverlayOffsetY');
        var bgOffsetYInput = document.getElementById('globalBgOverlayOffsetYLabel');
        if (bgOffsetYSlider) {
            bgOffsetYSlider.addEventListener('input', function () {
                if (bgOffsetYInput) bgOffsetYInput.value = bgOffsetYSlider.value;
                _previewBgOverlay();
            });
        }
        if (bgOffsetYInput) {
            bgOffsetYInput.addEventListener('input', function () {
                var v = parseInt(bgOffsetYInput.value, 10);
                if (!isNaN(v)) {
                    bgOffsetYInput.value = v;
                    bgOffsetYSlider.value = Math.max(-100, Math.min(100, v));
                }
                _previewBgOverlay();
            });
        }
        var bgScaleSlider = document.getElementById('globalBgOverlayScale');
        var bgScaleInput = document.getElementById('globalBgOverlayScaleLabel');
        if (bgScaleSlider) {
            bgScaleSlider.addEventListener('input', function () {
                if (bgScaleInput) bgScaleInput.value = bgScaleSlider.value;
                _previewBgOverlay();
            });
        }
        if (bgScaleInput) {
            bgScaleInput.addEventListener('input', function () {
                var v = parseInt(bgScaleInput.value, 10);
                if (!isNaN(v)) {
                    bgScaleInput.value = v;
                    bgScaleSlider.value = Math.max(10, Math.min(400, v));
                }
                _previewBgOverlay();
            });
        }

        // 拖动滑块时隐藏弹窗，让用户直接看到实际面板背景效果
        var _bgOverlayDragging = false;
        var bgOverlayRangeSliders = document.querySelectorAll('#bgOverlaySettingsModal input[type="range"]');
        bgOverlayRangeSliders.forEach(function (slider) {
            slider.addEventListener('pointerdown', function () {
                _bgOverlayDragging = true;
                document.body.classList.add('bg-overlay-previewing');
            });
        });
        document.addEventListener('pointerup', function () {
            if (_bgOverlayDragging) {
                _bgOverlayDragging = false;
                document.body.classList.remove('bg-overlay-previewing');
            }
        });

        // 长按「预览」按钮隐藏弹窗，让用户直接看到实际面板背景效果
        var bgOverlayPreviewBtn = document.getElementById('bgOverlayPreviewBtn');
        if (bgOverlayPreviewBtn) {
            bgOverlayPreviewBtn.addEventListener('pointerdown', function (e) {
                e.preventDefault();
                document.body.classList.add('bg-overlay-previewing');
            });
            bgOverlayPreviewBtn.addEventListener('pointerup', function () {
                document.body.classList.remove('bg-overlay-previewing');
            });
            bgOverlayPreviewBtn.addEventListener('pointerleave', function () {
                document.body.classList.remove('bg-overlay-previewing');
            });
        }

        // 背景叠加层设置弹窗
        var openBgOverlaySettingsBtn = document.getElementById('openBgOverlaySettingsBtn');
        if (openBgOverlaySettingsBtn) {
            openBgOverlaySettingsBtn.addEventListener('click', function () {
                openModal('bgOverlaySettingsModal');
            });
        }
        var closeBgOverlaySettingsBtn = document.getElementById('closeBgOverlaySettingsBtn');
        if (closeBgOverlaySettingsBtn) {
            closeBgOverlaySettingsBtn.addEventListener('click', function () {
                closeModal('bgOverlaySettingsModal');
            });
        }
        var closeBgOverlayDoneBtn = document.getElementById('closeBgOverlayDoneBtn');
        if (closeBgOverlayDoneBtn) {
            closeBgOverlayDoneBtn.addEventListener('click', function () {
                closeModal('bgOverlaySettingsModal');
            });
        }
        var bgOverlaySettingsModal = document.getElementById('bgOverlaySettingsModal');
        if (bgOverlaySettingsModal) {
            bgOverlaySettingsModal.addEventListener('click', function (e) {
                if (e.target && e.target.id === 'bgOverlaySettingsModal') closeModal('bgOverlaySettingsModal');
            });
        }

        // 自定义主题弹窗事件
        var customThemeBtn = document.getElementById('customThemeBtn');
        if (customThemeBtn) {
            customThemeBtn.addEventListener('click', function () { openCustomThemeModal(); });
        }
        var closeCustomThemeBtn = document.getElementById('closeCustomThemeBtn');
        if (closeCustomThemeBtn) {
            // 头部「关闭」= 取消：closeCustomThemeModal 与「确定」同义（会写盘），
            // 用它会让「关掉弹窗」顺手把预览值落盘、空方案库时还会凭空 fork 一套方案
            closeCustomThemeBtn.addEventListener('click', function () { cancelCustomThemeModal(); });
        }
        var applyCustomThemeBtn = document.getElementById('applyCustomThemeBtn');
        if (applyCustomThemeBtn) {
            applyCustomThemeBtn.addEventListener('click', function () { closeCustomThemeModal(); });
        }
        var cancelCustomThemeBtn = document.getElementById('cancelCustomThemeBtn');
        if (cancelCustomThemeBtn) {
            cancelCustomThemeBtn.addEventListener('click', function () { cancelCustomThemeModal(); });
        }
        var resetCustomThemeBtn = document.getElementById('resetCustomThemeBtn');
        if (resetCustomThemeBtn) {
            resetCustomThemeBtn.addEventListener('click', function () {
                var defaultColors = JSON.parse(JSON.stringify(THEME_PRESETS.default));
                populateCustomThemePanel(defaultColors);
                applyTheme('custom', defaultColors);
                bindCustomThemeSliderPreview();   // 重填后重绑滑块拖动预览（与开弹窗同一条路径）
            });
        }
        var customThemeModal = document.getElementById('customThemeModal');
        if (customThemeModal) {
            customThemeModal.addEventListener('click', function (e) {
                // 点遮罩 = 取消（closeCustomThemeModal 现在会写盘：它与「确定」同义，
                // 误触遮罩不该把预览值落盘、也不该在空方案库时凭空 fork 一套方案）
                if (e.target && e.target.id === 'customThemeModal') cancelCustomThemeModal();
            });
        }

        // 拖动自定义主题滑块时暂停模糊/压暗，面板半透明，实时看实际效果
        document.addEventListener('pointerup', function () {
            if (_ctDragging) {
                _ctDragging = false;
                document.body.classList.remove('ct-previewing');
            }
        });

        // 长按「按住预览」按钮暂停模糊/压暗，面板半透明
        var customThemePreviewBtn = document.getElementById('customThemePreviewBtn');
        if (customThemePreviewBtn) {
            customThemePreviewBtn.addEventListener('pointerdown', function (e) {
                e.preventDefault();
                document.body.classList.add('ct-previewing');
            });
            customThemePreviewBtn.addEventListener('pointerup', function () {
                document.body.classList.remove('ct-previewing');
            });
            customThemePreviewBtn.addEventListener('pointerleave', function () {
                document.body.classList.remove('ct-previewing');
            });
        }

        var closeSettingsBtn = document.getElementById('closeSettingsBtn');
        if (closeSettingsBtn) {
            closeSettingsBtn.addEventListener('click', function () {
                closeModal('settingsModal');
            });
        }

        // 统一的模块设置按钮 — 根据当前激活模块分派
        var openSettingsBtn = document.getElementById('openSettingsBtn');
        if (openSettingsBtn) {
            openSettingsBtn.addEventListener('click', function () {
                if (!appContainer) return;
                var activeId = appContainer.getActiveModuleId();
                if (!activeId) return;
                var mod = appContainer.getModule(activeId);
                if (mod && typeof mod.showSettings === 'function') {
                    mod.showSettings();
                }
            });
        }

        var aboutExtensionBtn = document.getElementById('aboutExtensionBtn');
        if (aboutExtensionBtn) {
            aboutExtensionBtn.addEventListener('click', () => showAboutModal('extension'));
        }

        var closeAboutBtn = document.getElementById('closeAboutBtn');
        if (closeAboutBtn) {
            closeAboutBtn.addEventListener('click', () => closeModal('aboutModal'));
        }

        var aboutModal = document.getElementById('aboutModal');
        if (aboutModal) {
            aboutModal.addEventListener('click', function (e) {
                if (e.target && e.target.id === 'aboutModal') closeModal('aboutModal');
            });
        }

        if (backToHomeBtn) {
            backToHomeBtn.addEventListener('click', () => {
                navigateHome();
            });
        }

        var refreshModuleBtn = document.getElementById('refreshModuleBtn');
        if (refreshModuleBtn) {
            refreshModuleBtn.addEventListener('click', () => {
                if (!appContainer) return;
                var activeId = appContainer.getActiveModuleId();
                if (!activeId) return;
                var moduleDef = appContainer.getModule(activeId);
                // deactivate→activate 两步必须兜底——unmount 抛错时若异常
                // 直接逃逸，activate 永不执行，面板可见但模块已卸载（完全僵死）。
                // 对照 navigateToModule 的挂载兜底：停用失败仅记录，finally 保证
                // 重新挂载始终执行；重挂载失败同样记录，不阻断扫光反馈
                try {
                    appContainer.deactivate();
                } catch (e) {
                    console.error('[Main] 刷新模块-停用失败: ' + (e && e.message ? e.message : e));
                } finally {
                    try {
                        appContainer.activate(activeId);
                    } catch (e) {
                        console.error('[Main] 刷新模块-重新挂载失败: ' + (e && e.message ? e.message : e));
                    }
                }
                if (moduleDef && moduleDef.panelId) {
                    var panel = document.getElementById(moduleDef.panelId);
                    if (panel) {
                        panel.classList.remove('hidden');
                        // 边缘光扫过反馈
                        panel.classList.add('panel-refresh-sweep');
                        panel.addEventListener('animationend', function onSweepEnd() {
                            panel.classList.remove('panel-refresh-sweep');
                            panel.removeEventListener('animationend', onSweepEnd);
                        });
                    }
                }
            });
        }

        document.addEventListener('click', function(e) {
            if (e.target && e.target.classList.contains('toggle-pwd')) {
                var targetId = e.target.getAttribute('data-target');
                var input = document.getElementById(targetId);
                if (input) {
                    input.type = input.type === 'password' ? 'text' : 'password';
                }
                return;
            }
            var tag = e.target.tagName.toLowerCase();
            var interactive = ['button', 'input', 'select', 'textarea', 'a', 'label'].indexOf(tag) !== -1;
            if (!interactive && !e.target.closest('button, a, input, select, textarea, [role="button"], .module-card')) {
                var stripe = document.querySelector('.hud-top-stripe');
                if (stripe) {
                    stripe.classList.remove('flash');
                    void stripe.offsetWidth;
                    stripe.classList.add('flash');
                }
            }
        });

        // 全局禁用浏览器原生右键菜单
        document.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });

    }


    // ── 底部状态栏实时数据 ──
    // Bridge 状态/时长 + Agent 上下文用量 + 当前模块 + 时钟。
    // 时钟秒级更新，其余随 10s 心跳刷新；模块切换时立即更新模块名。
    var _hud = {
        bridgeOnline: false,
        bridgeAuthFailed: false,   // H1 补强：进程在线但 token 失配（HUD 三态：在线/鉴权失败/离线）
        bridgeUptime: 0,
        moduleLabel: AEI18n.t('主面板')
    };

    function _fmtUptime(sec) {
        sec = Math.max(0, Math.floor(sec || 0));
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        var s = sec % 60;
        if (h > 0) return h + 'h' + (m < 10 ? '0' : '') + m + 'm';
        if (m > 0) return m + 'm' + (s < 10 ? '0' : '') + s + 's';
        return s + 's';
    }

    function _fmtCtx(used, max) {
        if (!max || max <= 0) return used + ' tokens';
        var pct = Math.round((used / max) * 100);
        var usedK = (used / 1000).toFixed(used >= 10000 ? 0 : 1);
        var maxK = (max / 1000).toFixed(0);
        return usedK + 'K/' + maxK + 'K (' + pct + '%)';
    }

    // ── 顶栏状态标签（主面板「SYS OK」/ 模块视图「SIG ACTIVE」）──
    // 两枚标签若是写死的绿点装饰：桥 401/离线时照旧显示绿色 OK，与底部 BRIDGE 段
    // （同屏可见、三态如实）自相矛盾。
    // 现改为与底部同源：数据源就是 _hud，随 10s 心跳的三态改写文案/点色/悬停提示，
    // 不新增任何轮询。健康态保留各自原文案（SYS OK / SIG ACTIVE），异常态统一
    // 前缀 + AUTH / DOWN，便于一眼看出是同一件事（桥）出的问题。
    var BRIDGE_TAGS = [
        { tag: 'sysTag', dot: 'sysTagDot', text: 'sysTagText', ok: 'SYS OK', fail: 'SYS AUTH', down: 'SYS DOWN' },
        { tag: 'sigTag', dot: 'sigTagDot', text: 'sigTagText', ok: 'SIG ACTIVE', fail: 'SIG AUTH', down: 'SIG DOWN' }
    ];

    function _updateBridgeTags() {
        var online = _hud.bridgeOnline;
        var authFailed = !!_hud.bridgeAuthFailed;
        var dot = online ? 'green' : (authFailed ? 'amber' : 'red');
        var title = online
            ? AEI18n.t('Bridge 在线{uptime}', {
                uptime: _hud.bridgeUptime
                    ? AEI18n.t('（已运行 {time}）', { time: _fmtUptime(_hud.bridgeUptime) })
                    : ''
            })
            : (authFailed
                ? AEI18n.t('Bridge 鉴权失败（进程在线、token 失配）：AEFS/外部通道全族 401 — 点底部 BRIDGE 状态重新检测')
                : AEI18n.t('Bridge 离线：本地对话/AE 操作可用，联网搜索、外接、转码等受限 — 点底部 BRIDGE 状态重新检测'));
        for (var i = 0; i < BRIDGE_TAGS.length; i++) {
            var spec = BRIDGE_TAGS[i];
            var tagEl = document.getElementById(spec.tag);
            if (!tagEl) continue;   // 标签是装饰性 chrome，缺了不阻断心跳
            var dotEl = document.getElementById(spec.dot);
            var textEl = document.getElementById(spec.text);
            tagEl.title = title;
            if (dotEl) dotEl.className = 'diamond-dot ' + dot;
            if (textEl) textEl.textContent = online ? spec.ok : (authFailed ? spec.fail : spec.down);
        }
    }

    function _updateHudClock() {
        var el = document.getElementById('hudClock');
        if (!el) return;
        var d = new Date();
        function pad(n) { return n < 10 ? '0' + n : '' + n; }
        el.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function _updateHudBridge() {
        var stateEl = document.getElementById('hudBridgeState');
        var upEl = document.getElementById('hudBridgeUptime');
        var dotEl = document.getElementById('hudBridgeDot');
        var statusEl = document.getElementById('hudBridgeStatus');
        if (_hud.bridgeOnline) {
            if (stateEl) stateEl.textContent = AEI18n.t('在线');
            if (upEl) upEl.textContent = _fmtUptime(_hud.bridgeUptime);
            if (dotEl) dotEl.style.color = '#4f9';
            if (statusEl) { statusEl.style.cursor = ''; statusEl.title = ''; }
        } else if (_hud.bridgeAuthFailed) {
            // 鉴权失败（H1 补强三态）：bridge 进程活着（uptime 保留）但 token 失配，
            // AEFS/WS 全族 401——区别于进程离线，提示用户可点击重试（restartBridge
            // 重新交接 token 通常可自愈；仍失败则需重启 AE 使新版 host.jsx 生效）
            if (stateEl) stateEl.textContent = AEI18n.t('鉴权失败');
            if (upEl) upEl.textContent = _fmtUptime(_hud.bridgeUptime);
            if (dotEl) dotEl.style.color = '#fa0';
            if (statusEl) { statusEl.style.cursor = 'pointer'; statusEl.title = AEI18n.t('Bridge 鉴权失败 — 点击重新检测（重启 bridge 重新交接 token）'); }
        } else {
            if (stateEl) stateEl.textContent = AEI18n.t('离线');
            if (upEl) upEl.textContent = '';
            if (dotEl) dotEl.style.color = '#f66';
            // 离线时 BRIDGE 状态可点击 → 手动打开断线页（重试拉起 / 跳过）
            if (statusEl) { statusEl.style.cursor = 'pointer'; statusEl.title = AEI18n.t('Bridge 离线 — 点击重新检测'); }
        }
        // 顶栏两枚状态标签与底部同源刷新（三态在此收口，故只挂这一处）
        _updateBridgeTags();
    }

    function _updateHudCtx() {
        var el = document.getElementById('hudCtxUsage');
        if (!el) return;
        try {
            var ctrl = global.AEEngine && typeof global.AEEngine.getController === 'function' && global.AEEngine.getController();
            if (ctrl && typeof ctrl.getContextTokenStats === 'function') {
                var stats = ctrl.getContextTokenStats();
                if (stats && stats.totalTokens > 0) {
                    el.textContent = _fmtCtx(stats.totalTokens, stats.maxTokens);
                    return;
                }
            }
        } catch (_) {}
        el.textContent = AEI18n.t('空闲');
    }

    // 底部 CTX 文本是 Agent 上下文用量条的镜像：心跳（10s）之外，bootstrap 在用量变化时
    // 广播 `ae:ctx-usage-changed`（含切模式/lane 后的槽位重绘），这里同源刷新，避免两处
    // 数字差一拍（团队/独立上下文进度条混在一起、切过去还是旧的）。
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('ae:ctx-usage-changed', function () { _updateHudCtx(); });
    }

    function _updateHudModule() {
        var el = document.getElementById('hudActiveModule');
        if (!el) return;
        el.textContent = _hud.moduleLabel;
    }

    // Bridge 恢复/重连成功后强制重同步数据根：Bridge 侧 UNC 白名单
    // （_allowedUncRoot）是进程内存态，Bridge 崩溃被自愈重启后新进程白名单为空，
    // 而面板 _bridgeSyncedDir 同值去重会挡掉重发 → UNC 数据根下所有 /fs/* 被 4xx 拒
    // （AEFS 对 Bridge 4xx 明确不回退），记忆/会话/技能/素材全静默失效。
    // 心跳每次探测成功都发没有意义：只在 offline→online 转换与断线页重连成功处调用。
    function _resyncDataDirAfterBridgeRecover() {
        try {
            if (global.AEShared && typeof global.AEShared.resyncDataDirToBridge === 'function') {
                global.AEShared.resyncDataDirToBridge();
            }
        } catch (_) {}
    }

    // Bridge 心跳保活：面板运行时周期性探 /health，重置 bridge idle 退出计时。
    // 同时用返回的 ok/uptime 刷新底部状态栏的 BRIDGE 段。
    // 附带断线检测：在线→离线（且未被用户跳过）→ 弹断线 overlay；离线→在线 → 弹恢复 toast。
    function startBridgeHeartbeat() {
        var HEARTBEAT_INTERVAL = 10000;  // 10s，远小于 bridge 的 30s idle 阈值
        // Bridge 端口可能因 9877 被占而回退到 9878-9886，用 Bridge.getBridgeUrl() 动态获取
        function bridgeHealthUrl() {
            return (global.Bridge && global.Bridge.getBridgeUrl ? global.Bridge.getBridgeUrl() : 'http://127.0.0.1:9877') + '/health';
        }
        var wasOnline = false;        // 上次心跳状态（首次心跳只初始化，不触发状态变化通知）
        var firstBeat = true;
        var dismissed = false;         // 用户跳过当前断线事件，Bridge 恢复时重置
        var overlayShowing = false;    // 断线 overlay 显示中，避免重复弹

        function handleStateChange(online) {
            if (online && !wasOnline) {
                // 恢复
                dismissed = false;
                // 阻断页显示期间 bridge 被外部拉起（其他面板实例重试/用户手动启动 node）时，
                // 恢复方向若只发 toast 不关页，阻断页永久遮挡 UI。此处若阻断页在显
                // （_disconnectOverlayForceRestore 非空 = overlay promise 在途），主动走
                // restored 出口关页 + resolve 存量 promise；restored 内部经 _bridgeNotifyRestored
                // 已发恢复 toast 并同步状态机，else 分支才自行发 toast（两路互斥，不重复）
                if (_disconnectOverlayForceRestore) {
                    try { _disconnectOverlayForceRestore(); } catch (_) {}
                } else if (global.AEToast) {
                    global.AEToast.show(AEI18n.t('Bridge 服务已恢复'), 'success');
                    // 无断线页在显时的恢复出口：强制重同步数据根（断线页路径由
                    // _bridgeNotifyRestored 统一发，两路互斥不重复）
                    _resyncDataDirAfterBridgeRecover();
                } else {
                    _resyncDataDirAfterBridgeRecover();
                }
            } else if (!online && wasOnline && !dismissed && !overlayShowing) {
                // 断线（首次检测到，且未被用户跳过）
                overlayShowing = true;
                showBridgeDisconnectOverlay().then(function (restored) {
                    overlayShowing = false;
                    if (!restored) {
                        dismissed = true;  // 用户跳过，不再弹（直到 Bridge 恢复后再次断线）
                    }
                });
            }
            wasOnline = online;  // 更新上次心跳状态（必须，否则恢复时 !wasOnline 不成立）
        }

        function beat() {
            // /health 无 token 鉴权（X-Bridge-Token 校验已整体回退，bridge.js 从未导出
            // getToken，bridge-server 也无对应校验），仅靠 Origin 校验（拒外部网页/null
            // origin）保护——心跳为无自定义头的简单 GET，token 校验在此路径上永不生效
            // fetch 必须带超时——挂起的 fetch 永不 reject，.catch 只接网络错误；
            // bridge 事件循环卡死（TCP 存活但不响应，即消除的故障模式）时，
            // 无超时会导致断线检测在最需要时失效，且每轮 setInterval 堆一个 pending fetch。
            // 8s < 10s 心跳间隔：同屏至多一个在途探测；abort 走 reject → 复用下方 catch 的离线分支。
            var hbCtrl = (typeof AbortController === 'function') ? new AbortController() : null;
            var hbTimer = hbCtrl ? setTimeout(function () { try { hbCtrl.abort(); } catch (_) {} }, 8000) : null;
            fetch(bridgeHealthUrl(), hbCtrl ? { signal: hbCtrl.signal } : undefined).then(function (res) {
                return res.json();
            }).then(function (data) {
                if (hbTimer) clearTimeout(hbTimer);
                var healthOk = !!(data && data.ok);
                var settle = function (online, authFailed) {
                    _hud.bridgeOnline = online;
                    _hud.bridgeAuthFailed = !!authFailed;
                    _hud.bridgeUptime = (data && data.uptime) ? Math.round(data.uptime) : 0;
                    _updateHudBridge();
                    // 同步可用性缓存到 Bridge，供 isAvailable 读取（单一探测源）
                    if (global.Bridge && typeof global.Bridge.setAvailable === 'function') {
                        global.Bridge.setAvailable(online);
                    }
                    if (firstBeat) { wasOnline = online; firstBeat = false; }
                    else { handleStateChange(online); }
                };
                // 鉴权门：/health 豁免 token——bridge 活着
                // 但 token 失配时 health 200 而 AEFS/WS 全族 401，原心跳仍显示在线 → 断线
                // 阻断与 restartBridge 自愈链永不触发。authRequired 时用 /api/auth-probe
                // 二次确认：401/403 → authProbeAsync 刷新 token、清端口缓存并重扫（跳过残留
                // /他会话 401 端口），全不可用才按离线走既有 overlay + retry 重启 bridge
                if (healthOk && data.authRequired
                    && global.Bridge && typeof global.Bridge.authProbeAsync === 'function') {
                    global.Bridge.authProbeAsync().then(function (authOk) {
                        settle(authOk, !authOk);
                    });
                } else {
                    settle(healthOk, false);
                }
            }).catch(function () {
                if (hbTimer) clearTimeout(hbTimer);
                _hud.bridgeOnline = false;
                _hud.bridgeAuthFailed = false;
                _hud.bridgeUptime = 0;
                _updateHudBridge();
                if (global.Bridge && typeof global.Bridge.setAvailable === 'function') {
                    global.Bridge.setAvailable(false);
                }
                if (firstBeat) { wasOnline = false; firstBeat = false; }
                else { handleStateChange(false); }
                // 心跳失败可能因 bridge 重启换端口：clearPortCache 内部会异步扫描定位实际端口
                // （桥换到 9878+ 时找到后回写缓存，下轮 beat 自动连上新端口；且不再重置 _probed，
                // 避免下轮 getBridgeUrl() 重走同步 XHR 探测阻塞主线程）
                if (global.Bridge && typeof global.Bridge.clearPortCache === 'function') {
                    global.Bridge.clearPortCache();
                }
                /* bridge 不在则静默，文件操作会回退 cep.fs */
            });
            // 心跳同时刷新上下文用量（bridge 状态在上面 then 里更新）
            _updateHudCtx();
        }
        // 立即开始首拍：waitForReady 已全异步化（fetch 探测），无同步 XHR 可抢；
        // 且首拍能立刻刷新 _available 缓存，缩短「跳过 bridge 降级运行」期的缓存空窗。
        // 同时注入「已恢复」通知器：断线页重新检测成功后直接同步状态机（见 _bridgeNotifyRestored 注释），
        // toast 在通知器里发；下拍 beat 成功时 wasOnline 已是 true，恢复分支不触发、不会重复发 toast。
        _bridgeNotifyRestored = function () {
            wasOnline = true;      // 重新检测已确认在线：权威翻转，beat 巡检失败也不回退此事实前的状态
            dismissed = false;     // 重新武装断线提醒（覆盖「跳过后手动重试成功」场景的残留）
            _hud.bridgeOnline = true;
            _hud.bridgeAuthFailed = false;
            _updateHudBridge();
            if (global.AEToast) global.AEToast.show(AEI18n.t('Bridge 服务已恢复'), 'success');
            // 断线页重连/自愈重启成功也是换进程（或至少是重连）：强制重同步数据根，
            // 新 Bridge 进程的 UNC 白名单必须重新登记（同值去重不得挡）
            _resyncDataDirAfterBridgeRecover();
        };
        beat();
        _heartbeatIntervalId = setInterval(beat, HEARTBEAT_INTERVAL);
        // 时钟秒级更新，独立于心跳
        _updateHudClock();
        _clockIntervalId = setInterval(_updateHudClock, 1000);

        // 手动入口：点击左下角「BRIDGE: 离线」打开断线页（含启动时跳过、跳过自动弹出后想反悔的场景）。
        // 单飞保护在 showBridgeDisconnectOverlay 内：与心跳自动弹出并发时复用同一 Promise，不重复绑监听。
        var hudBridgeStatus = document.getElementById('hudBridgeStatus');
        if (hudBridgeStatus) {
            hudBridgeStatus.addEventListener('click', function () {
                if (_hud.bridgeOnline) return;   // 在线时点击无效
                showBridgeDisconnectOverlay().then(function () { /* 手动入口不关心 restored 结果 */ });
            });
        }
    }

    // 存储定时器 ID，供 beforeunload 清理
    var _heartbeatIntervalId = null;
    var _clockIntervalId = null;
    // 「Bridge 已恢复」通知器（startBridgeHeartbeat 注入）：断线页重新检测成功后调用，
    // 直接把 wasOnline/dismissed/HUD/toast 同步到位——不依赖下一拍 beat（beat 瞬时失败会让
    // wasOnline 卡 false，之后真断线时断线分支条件永不成立、不再弹窗）
    var _bridgeNotifyRestored = null;

    function getProviderList() {
        var registry = global.AE_LLM && global.AE_LLM.providerRegistry;
        return registry && registry.listProviders ? registry.listProviders(false) : [];
    }

    function getModelList(providerId) {
        var registry = global.AE_LLM && global.AE_LLM.providerRegistry;
        return registry && registry.listModels ? registry.listModels(providerId) : [];
    }

    function buildModelsCompatibilityMap() {
        var map = {};
        var providers = getProviderList();
        for (var i = 0; i < providers.length; i++) {
            var models = getModelList(providers[i].id);
            map[providers[i].id] = [];
            for (var j = 0; j < models.length; j++) {
                map[providers[i].id].push(models[j].id);
            }
        }
        return map;
    }

    async function initLlmProviders() {
        if (!global.AE_LLM || !global.AE_LLM.providerRegistry) return;

        var registry = global.AE_LLM.providerRegistry;
        try {
            // init() 内部已调用 loadUserProviders()，切勿再重复调用，
            // 否则 providers.json 首次加载会跑两轮（日志/写空配置重复）。
            await registry.init(global.AE_LLM.BUILTIN_LLM_PROVIDERS || []);
            var loadError = registry.getLoadError();
            if (loadError) {
                console.warn('[LLM Providers] providers.json load failed: ' + loadError);
            }
            // Build compatibility map for modules that still use MODELS[platform]
            global.AE_LLM.MODELS = buildModelsCompatibilityMap();
        } catch (e) {
            console.warn('[LLM Providers] init failed: ' + (e && e.message ? e.message : String(e)));
        }
    }

    // 应用启动流程：创建容器、注册模块、恢复全局设置并渲染主面板
    async function bootstrap() {
        try {
        console.log('[Main] bootstrap start');
        // loader.js 的 document.write 无法感知脚本加载失败（文件头注释声称
        // 「失败即控制台报错」与实现不符，404 静默无感知）。main.js 是清单最后一个
        // 文件、执行时其余脚本均已加载完毕——开头校验关键命名空间存在性，缺失即
        // 打印明确的「脚本未加载」日志（配合 CP-4/CP-5 逐项防御，缺失子系统降级
        // 而非整体「启动失败」）
        (function verifyLoadedScripts() {
            var required = ['AEBoot', 'AEPlatform', 'AEShared', 'AECore', 'AE_LLM', 'AEModules', 'AEMemory'];
            var missing = [];
            for (var vi = 0; vi < required.length; vi++) {
                if (!global[required[vi]]) missing.push(required[vi]);
            }
            if (missing.length > 0) {
                console.error('[Main] 关键脚本未加载（loader 注入可能 404 或执行失败）: ' + missing.join(', ') + '——对应功能不可用');
                if (global.AEToast && typeof global.AEToast.show === 'function') {
                    try { global.AEToast.show(AEI18n.t('部分脚本加载失败: ') + missing.join(', '), 'error'); } catch (_) {}
                }
            }
        })();
        // 等启动动画 phase1 绘制到屏幕再开始真实初始化，
        // 否则 bootstrap 太快跑完，进度条瞬间满、UI 还没出来就收起。
        global.AEBoot.setProgress(2, AEI18n.t('准备启动…'));
        await new Promise(function (resolve) {
            requestAnimationFrame(function () { requestAnimationFrame(resolve); });
        });
        global.AEBoot.setProgress(5, AEI18n.t('创建基础设施…'));
        const bridge = global.AEPlatform.createCepBridge();
        const hostApi = global.AEPlatform.createHostApi(bridge);
        global.AEPlatform.hostApi = hostApi;  // 挂载到全局供 QuickBar 等独立模块使用
        const settingsStore = global.AEShared.createSettingsStore();
        // 供容器创建前的 getSettingsStore 回退（启动期数据目录同步用，见 earlySettingsStore 声明）
        earlySettingsStore = settingsStore;
        const status = global.AEShared.createStatusFacade();
        const theme = global.AEShared.createThemeManager();
        const effects = global.AEShared.createUiEffects();
        const utils = global.AEShared.utils;

        function startMCPBridge() {
            var attempts = 0;
            function tryLoad() {
                attempts++;
                var cs;
                try { cs = new CSInterface(); } catch(e) { cs = null; }
                if (!cs || typeof cs.evalScript !== 'function') {
                    if (attempts < 50) {
                        setTimeout(tryLoad, 200);
                    } else {
                        console.warn('[AE] CSInterface never became available after ' + attempts + ' attempts');
                    }
                    return;
                }

                var extPath = window.__ext_root;
                if (!extPath) {
                    // __ext_root 由 mcp-manager/bootstrap.js 在模块装载期写入——若本函数
                    // 先跑（模块装载顺序/缓存差异），一次性放弃会让 host.jsx 永不加载、
                    // 桥不自启动（真机：另一加载点用 $.fileName 回退 → 根目录算成 AE 应用目录）。
                    // 与 CSInterface 同款重试，共用 attempts 预算。
                    if (attempts < 50) {
                        setTimeout(tryLoad, 200);
                    } else {
                        console.warn('[AE] Cannot determine extension path (__ext_root not set after ' + attempts + ' attempts)');
                    }
                    return;
                }
                var loadJsxPath = extPath.replace(/\\/g, '/') + '/host/host.jsx';
                // loadJsxPath 拼进 ExtendScript 字符串字面量：转义双引号与 U+2028/U+2029
                // （ES3 字面量行终止符），未转义会让整条 evalScript 解析失败、host.jsx
                // 静默不加载——对齐 hostApi._getApiDir / openDataDirBtn 的完整转义链
                var q = loadJsxPath.replace(/"/g, '\\"')
                    .replace(/\u2028/g, '\\u2028')
                    .replace(/\u2029/g, '\\u2029');
                // 把扩展根注入 ExtendScript 全局 __AS_EXTP_ROOT——host.jsx 真机上
                // $.fileName 锚不到自身（实测返回 AE 应用目录），据其推导的 vendor node /
                // bridge / host/api 路径全会错（桥不启动 + cmd 兜底失败弹 AE 模态框）。
                var rootJs = extPath.replace(/\\/g, '/').replace(/[\\/]+$/, '')
                    .replace(/"/g, '\\"')
                    .replace(/\u2028/g, '\\u2028')
                    .replace(/\u2029/g, '\\u2029');
                var loadApiScript = 'try { __AS_EXTP_ROOT = "' + rootJs + '"; $.evalFile("' + q + '"); "HOST_LOADED"; } catch(e) { "ERR:" + e.toString(); }';
                cs.evalScript(loadApiScript, function(result) {
                    console.log('[AE] Host API load: ' + result);
                    // 失败归因不再只 console.log——整体加载失败（回调 ERR:…）
                    // 直接用回调文本；加载成功则读 host.jsx 落的模块级失败产物
                    //（temp/handoff/ae_extp_host_load_errors.json），写入 Bridge 失败浮层
                    // 文案（showBridgeFailOverlay 追加）+ console.warn 逐条明细。
                    var res = String(result == null ? '' : result);
                    if (res === 'HOST_LOADED') {
                        var hostErrs = _readHostLoadErrorsSync();
                        if (hostErrs.length) {
                            _setHostLoadFailure(AEI18n.t('宿主 API 模块加载失败: '), hostErrs);
                        } else {
                            _hostLoadFailureNote = '';
                        }
                        _probeHotboxNative();   // 宿主就绪后探测热盒原生件（缺件→置灰热键行）
                    } else {
                        _setHostLoadFailure(AEI18n.t('宿主脚本 host.jsx 加载失败: ') + res);
                    }
                });
            }
            tryLoad();
        }
        startMCPBridge();

        // 创建 App 层共享基础设施
        var toolRegistry = global.AE_LLM.createToolRegistry();
        global.AE_LLM.toolRegistry = toolRegistry;

        var promptBuilder = null;
        if (global.AE_LLM && typeof global.AE_LLM.createPromptBuilder === 'function') {
            promptBuilder = global.AE_LLM.createPromptBuilder();
            global.AE_LLM.promptBuilder = promptBuilder;
        }

        var toolExecutor = global.AE_LLM.createToolExecutor({
            toolRegistry: toolRegistry,
            hostApi: hostApi
        });
        global.AE_LLM.toolExecutor = toolExecutor;

        // 初始化 MCP 模块
        console.log('[Main] bootstrap: before MCP init');
        global.AEBoot.setProgress(18, AEI18n.t('初始化 MCP 模块…'));
        // initMCP 补异常隔离（对照同函数内 initAssetsTools 等五处 init 的
        // 同款 try/catch）——单一子系统失败直接炸出 bootstrap 时，整个面板进
        // 「启动失败」页、8 模块全不可用。失败时 mcp 置 null 降级继续启动，
        // 下游 mcp/serverManager 消费点均已有空值守卫
        var mcp = null;
        try {
            mcp = await global.AE_LLM.initMCP({
                bridge: bridge,
                hostApi: hostApi,
                settingsStore: settingsStore,
                toolRegistry: toolRegistry,
                toolExecutor: toolExecutor
            });
        } catch (e) {
            console.error('[Main] initMCP error:', e);
        }
        // 把手交给模块级变量：启动门/遮罩自愈在别的函数作用域里，拿不到这个局部 `mcp`
        // （失败时同样赋值——保持 null/失败对象，下游判据的守卫会如实跳过 MCP 那一路）
        _mcpInstance = mcp;
        var serverManager = (mcp && mcp.serverManager) || null;

        console.log('[Main] bootstrap: after MCP init');
        // 初始化数据目录（ExtendScript 异步拿 AppData，后续模块需要）
        if (global.AEShared && typeof global.AEShared.initDataDir === 'function') {
            global.AEBoot.setProgress(32, AEI18n.t('解析数据目录…'));
            var dataDir = await global.AEShared.initDataDir();
            console.log('[Main] dataDir resolved: ' + (dataDir || '(empty)'));

            // 用户增补表（AST 门白名单）冷启动重放：ast-gate/userTable.js 随 scripts.manifest
            // 在 initDataDir 之前装载，模块 init 的 fire-and-forget _load() 遇到空数据目录只能
            // 落空（其设计是不固化结果、等下次调用重读），而启动链没有后续调用时——
            // 重启后盘上增补表静默不生效，门只剩 seed 表（实测：ast-gate-user-table.json
            // 已收录 Layer.Effects，重启后仍报「类型 Layer 未收录成员 Effects」）。
            // 数据目录就绪后补一次 load()，把盘上增补重放进类型表。
            if (global.AEGate && global.AEGate.userTable && typeof global.AEGate.userTable.load === 'function') {
                try {
                    global.AEGate.userTable.load();
                } catch (_) { /* 增补表加载失败不阻断启动：门仍按 seed 表 fail-closed 运行 */ }
            }

            // 等 Bridge 就绪。优先用 MCP Bridge 的 WebSocket 握手信号（桥与 /health 同源同端口，
            // WS onopen 即代表 HTTP 可用，见 communicationProvider.waitForBridgeConnected），
            // 取代冷启动时易因 HTTP 探测 fetch 挂起而误判的 waitForReady 轮询；
            // 拿不到 WS 信号（MCP 未初始化等）时退回原有 HTTP 轮询。
            if ((mcp && mcp.communicationProvider && typeof mcp.communicationProvider.waitForBridgeConnected === 'function')
                || (typeof Bridge !== 'undefined' && Bridge.waitForReady)) {
                global.AEBoot.setProgress(40, AEI18n.t('等待 Bridge 服务…'));
                var bridgeOk = false;
                if (mcp && mcp.communicationProvider && typeof mcp.communicationProvider.waitForBridgeConnected === 'function') {
                    bridgeOk = await mcp.communicationProvider.waitForBridgeConnected(4000);
                    console.log('[Main] Bridge ready (ws): ' + bridgeOk);
                }
                if (!bridgeOk && typeof Bridge !== 'undefined' && Bridge.waitForReady) {
                    bridgeOk = await Bridge.waitForReady(3000);
                    console.log('[Main] Bridge ready (poll): ' + bridgeOk);
                }
                // 冷启动链（VBS→wscript→node→WS onopen）真机实测 ~4–5s，上面 4s 的 WS 等待
                // 可能差 ~1s 落空（实测：WS 08.9s 连上、等待 07.9s 判假阴性），随后的
                // 鉴权轮询在 token 交接时序下又可能整体假阴性 → 失败遮罩被误弹。补一轮 WS 等待
                // （冷启动窗口）+ isAvailable 复核（该标志由 WS 握手/心跳维护，正是 AEFS 的判据）。
                if (!bridgeOk && mcp && mcp.communicationProvider && typeof mcp.communicationProvider.waitForBridgeConnected === 'function') {
                    bridgeOk = await mcp.communicationProvider.waitForBridgeConnected(5000);
                    console.log('[Main] Bridge ready (ws retry): ' + bridgeOk);
                }
                if (!bridgeOk && mcp && mcp.communicationProvider && typeof mcp.communicationProvider.isBridgeConnected === 'function') {
                    try { bridgeOk = !!mcp.communicationProvider.isBridgeConnected(); } catch (_) { bridgeOk = false; }
                    console.log('[Main] Bridge ready (ws state): ' + bridgeOk);
                }
                if (!bridgeOk && typeof Bridge !== 'undefined' && typeof Bridge.isAvailable === 'function') {
                    try { bridgeOk = !!Bridge.isAvailable(); } catch (_) { bridgeOk = false; }
                    console.log('[Main] Bridge ready (isAvailable fallback): ' + bridgeOk);
                }
                if (!bridgeOk) {
                    // Bridge 自启动失败 — 阻塞 UI，等待用户手动启动后重试
                    bridgeOk = await showBridgeFailOverlay();
                    console.log('[Main] Bridge after retry: ' + bridgeOk);
                }
                if (!bridgeOk) {
                    console.warn('[Main] Bridge unavailable - continuing with reduced functionality');
                }
                // Bridge 就绪后同步数据目录（含用户自定义路径），Bridge 据此定位错误日志
                if (bridgeOk) {
                    try {
                        var resolvedDir = global.AEShared.getDataDir();
                        if (resolvedDir && resolvedDir.dir) {
                            // 写宿主指针文件：数据目录确定后，让原生插件随自定义目录定位 effects/
                            if (typeof global.AEShared.writeDataDirPointer === 'function') {
                                try { global.AEShared.writeDataDirPointer(resolvedDir.dir); } catch (_) {}
                            }
                            // /4：走统一同步入口（force 重发 + 非 2xx/异常按失败告警
                            // 且保留重试可能），不再直接 fetch 吞掉非 2xx
                            if (typeof global.AEShared.resyncDataDirToBridge === 'function') {
                                global.AEShared.resyncDataDirToBridge();
                            }
                        }
                    } catch (e) {
                        console.warn('[Main] 同步数据目录到 Bridge 异常: ' + e);
                    }
                }
            }
        }
        // 全局设置（含自定义数据目录）必须在任何模块 init 之前读取并同步到
        // AEShared。initLlmProviders / initMemoryTools / initAssetsTools / initSkillTools
        // 等都在启动期调用 getDataDir()（providerRegistry 读写 providers.json、memory
        // 装载索引、assetRefs/presetStore 构造时快照目录、skill 扫描目录）——原同步点
        // 在 register 链之后（下方 activeGlobalSettings = await loadGlobalSettings() →
        // applyGlobalSettingsToUI），晚于上述 init，getDataDir() 恒返回默认目录：
        // 自定义数据目录在启动期完全不生效，providerRegistry 甚至「读默认/写自定义」
        // （用户新增的 provider 重启后消失，再保存会覆盖自定义目录中的文件）。
        // 此处提前读设置 + 同步（settingsStore 已在本函数基础设施段创建，且早于
        // initDataDir）；低性能模式等全局赋值同步搬来（照 register 链后既有写法）。
        // 下方 loadGlobalSettings()/applyGlobalSettingsToUI() 保留：幂等重读 + UI 回填。
        // 读设置失败时降级为默认（仅告警），不得让启动链挂掉。
        try {
            activeGlobalSettings = await loadGlobalSettings();
            global.AE_ExtP_LowPerfMode = !!activeGlobalSettings.lowPerfMode;
            if (global.AEShared && typeof global.AEShared.syncDataDirSetting === 'function') {
                global.AEShared.syncDataDirSetting(activeGlobalSettings.dataDir || '');
            }
            console.log('[Main] 启动期已同步数据目录: ' + (global.AEShared.getDataDir ? (global.AEShared.getDataDir().dir || '(empty)') : '(n/a)'));
            // 数据根落在 UNC 网络共享（域环境 %APPDATA% 被重定向）时
            // 给一次客观提示，不阻断使用。启动链路仅此处触发一次；走既有 AEToast 通道，
            // 不新增组件。uncRoot 由 dataDir.js 解析时登记（AEFS 白名单同一真相源）。
            try {
                var _ddRes = global.AEShared.getDataDir ? global.AEShared.getDataDir() : null;
                var _uncRoot = (_ddRes && _ddRes.uncRoot) || '';
                if (_uncRoot && global.AEToast && typeof global.AEToast.show === 'function') {
                    var _shareName = _uncRoot.replace(/^\/+/, '').split('/').slice(0, 2).join('\\');
                    global.AEToast.show(AEI18n.t('数据目录位于网络共享（\\\\') + _shareName + AEI18n.t('）：读写可能较慢，且断网时不可用'), 'warn', { autoHideMs: 8000 });
                }
            } catch (_) {}
        } catch (e) {
            console.warn('[Main] 启动期同步全局设置/数据目录失败，按默认目录降级: ' + (e && e.message ? e.message : e));
        }
        // 首次启动/每次启动：向**当前生效**的数据目录补种种子数据。
        // ① 目标取 active dir（恒用 initDataDir() 的默认根 → 自定义数据目录
        // 永远拿不到补种）；② 播种改逐文件判定（由 seedDataDir 内 AEFS.copyDir 的逐文件
        // exists 语义承担；不再整目录判空）。失败不得静默也不得谎报。
        try {
            var _seedTarget = (global.AEShared.getDataDir ? (global.AEShared.getDataDir().dir || '') : '');
            if (_seedTarget && global.AEShared.seedDataDir) {
                var seedResult = await global.AEShared.seedDataDir(_seedTarget);
                if (seedResult && seedResult.ok) {
                    console.log('[Main] seeded ' + seedResult.count + ' dir(s) → ' + _seedTarget);
                } else {
                    var seedFailNames = (seedResult && seedResult.failures || []).map(function (f) { return f && f.sub ? f.sub : String(f); }).join(', ');
                    console.warn('[Main] seed 失败 — 成功 ' + ((seedResult && seedResult.count) || 0) + ' 个'
                        + (seedFailNames ? '，失败子目录: ' + seedFailNames : '')
                        + (seedResult && seedResult.error ? '（' + seedResult.error + '）' : '')
                        + '；技能/记忆/效果库可能为空，请检查数据目录写入权限与磁盘空间');
                }
            }
        } catch (e) {
            console.warn('[Main] seed 异常（不阻断启动）: ' + (e && e.message ? e.message : e));
        }
        // 数据根可用性探测（一次真实写+删）。有一类机器（Windows 账户名含引号/`%`，
        // 如 C:\Users\O'Brien）会让**默认数据根整条路径**命中数据层 _checkPath 的字符黑名单
        // → 每次读写都被入口拒绝、各模块各自降级成空数据（面板看着能用、数据层整体是死的），
        // 全链只有 console.warn，用户看不到。这里把结论变成一条可操作的持续提示：
        // 改到不含特殊字符的路径（如 D:\AE_Data）即可恢复全部功能。
        try {
            var _probeDir = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                ? (global.AEShared.getDataDir().dir || '') : '';
            var _rootProbe = (_probeDir && global.AEShared && typeof global.AEShared.probeDataRoot === 'function')
                ? global.AEShared.probeDataRoot(_probeDir) : { ok: true, reason: '' };
            if (_rootProbe && _rootProbe.ok === false) {
                console.error('[Main] 数据根不可用: ' + _probeDir + ' — ' + _rootProbe.reason);
                if (global.AEToast && typeof global.AEToast.show === 'function') {
                    global.AEToast.show(AEI18n.t('数据目录不可用：') + _probeDir + AEI18n.punct('（', ' (') + _rootProbe.reason + AEI18n.punct('）。', ').')
                        + AEI18n.t('记忆/技能/素材/会话/画布均无法读写。请在「设置」里把数据目录改到不含特殊字符的路径（例如 D:\\AE_Data）后重试。'),
                        'error', { autoHideMs: 0 });
                }
            } else if (_probeDir) {
                console.log('[Main] 数据根可用性探测通过: ' + _probeDir);
            }
        } catch (_) {}
        // 初始化 LLM Provider 注册表
        global.AEBoot.setProgress(55, AEI18n.t('加载 LLM 平台…'));
        await initLlmProviders();
        // 初始化 AE 工具模块
        global.AEBoot.setProgress(65, AEI18n.t('初始化 AE 工具…'));
        // initAETools 同款异常隔离——工具注册子集缺失不阻断面板启动
        try {
            await global.AE_LLM.initAETools({
                toolRegistry: toolRegistry,
                // 「执行超时」兜底取值源——Agent 界面未挂载时该设置也须生效
                // （详见 ae-tools/bootstrap.js initAETools 内注释）
                settingsStore: settingsStore
            });
        } catch (e) {
            console.error('[Main] initAETools error:', e);
        }

        // 初始化记忆模块工具（LLM 工具在启动时注册，不依赖 UI 挂载）
        // initMemoryTools 同款异常隔离——记忆工具缺失不阻断面板启动
        try {
            await global.AEMemory.initMemoryTools({
                toolRegistry: toolRegistry,
                promptBuilder: promptBuilder
            });
        } catch (e) {
            console.error('[Main] initMemoryTools error:', e);
        }

        // 初始化素材库 LLM 工具（asset_library 单工具：library=asset_refs/project_assets/presets）
        // 启动时创建 store 实例并 load，UI mount 时复用同一份实例；load 后顺带做一次归档清扫
        if (global.AEAssetsShared && typeof global.AEAssetsShared.initAssetsTools === 'function') {
            try {
                await global.AEAssetsShared.initAssetsTools({
                    toolRegistry: toolRegistry,
                    hostApi: hostApi
                });
                console.log('[Main] assets LLM tools initialized');
            } catch (e) {
                console.error('[Main] initAssetsTools error:', e);
            }
        }

        // 初始化 Agent 脚本列表 LLM 工具（script_manager：读/写/删除/运行 AE）
        // 安全门禁依赖 AEScriptSecurity（scriptSecurity.js 已在 index.html 中先于 script-tree.js 加载）
        if (global.AEScriptManager && typeof global.AEScriptManager.initScriptManagerTools === 'function') {
            try {
                global.AEScriptManager.initScriptManagerTools({
                    toolRegistry: toolRegistry,
                    hostApi: hostApi
                });
                console.log('[Main] script_manager LLM tool initialized');
            } catch (e) {
                console.error('[Main] initScriptManagerTools error:', e);
            }
        }

        // 初始化 MCP 管理 LLM 工具（mcp_servers / mcp_control）
        // serverManager 已由 initMCP 创建并挂到 global.AE_LLM.serverManager
        if (global.AEMcpManager && typeof global.AEMcpManager.initMcpManagerTools === 'function') {
            try {
                global.AEMcpManager.initMcpManagerTools({
                    toolRegistry: toolRegistry,
                    serverManager: serverManager
                });
                console.log('[Main] mcp manager LLM tools initialized');
            } catch (e) {
                console.error('[Main] initMcpManagerTools error:', e);
            }
        }

        // 初始化 ComfyUI LLM 工具（AI 生图/生视频，不依赖 UI 挂载）
        if (global.AEComfyUI && typeof global.AEComfyUI.initComfyuiTools === 'function') {
            try {
                global.AEComfyUI.initComfyuiTools({
                    toolRegistry: toolRegistry,
                    settingsStore: settingsStore,
                    hostApi: hostApi
                });
                console.log('[Main] ComfyUI LLM tools initialized');
            } catch (e) {
                console.error('[Main] initComfyuiTools error:', e);
            }
        }

        // 平台侧文件工具（readFile/read_image/read_video/writeFile）统一在 platformTools.js 中注册。
        // 注册时序保持：在 initAETools 之后调用，以覆盖同名 ExtendScript 工具。
        // readFile/read_image/read_video 为只读；writeFile 为可写（Agent / Script / Shader 三档，走 AEFS 安全链）。
        if (global.AEShared && typeof global.AEShared.initPlatformFileTools === 'function') {
            global.AEShared.initPlatformFileTools({ toolRegistry: toolRegistry });
        } else {
            console.warn('[Main] platformTools 未加载，跳过 readFile/read_image/read_video/writeFile 工具注册');
        }

        // 面板主题方案库（Agent 可调的工具面）：init 必须在工具注册前完成——handler 依赖已初始化状态
        if (global.AEShared && typeof global.AEShared.createPanelTheme === 'function') {
            try {
                await initPanelTheme(toolRegistry);
                console.log('[Main] panelTheme init done');
            } catch (e) {
                console.error('[Main] initPanelTheme error:', e);
            }
        } else {
            console.warn('[Main] panelTheme 未加载，跳过面板主题方案库初始化');
        }

        console.log('[Main] bootstrap: after AE+Memory init');

        var llmChannel = null;
        var skillRegistry = null;

        if (global.AE_LLM && typeof global.AE_LLM.createLlmChannel === 'function') {
            llmChannel = global.AE_LLM.createLlmChannel();
            global.AE_LLM.llmChannel = llmChannel;
        }
        if (global.AE_LLM && typeof global.AE_LLM.createSkillRegistry === 'function') {
            skillRegistry = global.AE_LLM.createSkillRegistry();
            global.AE_LLM.skillRegistry = skillRegistry;
        }

        // 初始化 Skill 工具（启动时注册，不依赖 UI 挂载）
        console.log('[Main] bootstrap: before initSkillTools');
        global.AEBoot.setProgress(78, AEI18n.t('加载技能模块…'));
        if (global.AESkillManager && typeof global.AESkillManager.initSkillTools === 'function') {
            try {
                await global.AESkillManager.initSkillTools({
                    skillRegistry: skillRegistry,
                    toolRegistry: toolRegistry,
                    promptBuilder: promptBuilder,
                    settingsStore: settingsStore
                });
                console.log('[Main] bootstrap: initSkillTools done');
            } catch (e) {
                console.error('[AE_MAIN] initSkillTools crashed:', e);
                console.warn('[Main] initSkillTools error: ' + (e && e.message ? e.message : String(e)));
            }
        }

        // 外接模式（EXT-MCP）：面板侧 Bridge 客户端常连 + ext_* 消息路由。
        // 启动即初始化（面板在线 ≠ 已授权——授权门控在 ext_dispatch 按调用检查外接模式激活态，
        // 通道开关语义）。异常隔离：外接模块缺失不阻断面板启动。
        if (global.AEExternal && typeof global.AEExternal.init === 'function') {
            try {
                global.AEExternal.init();
                console.log('[Main] external MCP module initialized');
            } catch (e) {
                console.error('[Main] external MCP module init error:', e);
            }
        }

        // 外部访问授权常驻指示（全局边光 + 置顶提示条）：状态驱动，授权关闭时
        // 不创建任何节点。异常隔离：装饰性组件失败不阻断面板启动。
        if (global.AEExtIndicator && typeof global.AEExtIndicator.init === 'function') {
            try {
                global.AEExtIndicator.init();
            } catch (e) {
                console.error('[Main] ext indicator init error:', e);
            }
        }

        console.log('[Main] bootstrap: before createAppContainer');
        global.AEBoot.setProgress(88, AEI18n.t('注册模块…'));

        appContainer = global.AECore.createAppContainer({
            dependencies: {
                bridge,
                hostApi,
                settingsStore,
                status,
                theme,
                effects,
                utils,
                llmChannel,
                toolRegistry,
                toolExecutor,
                serverManager,
                skillRegistry,
                promptBuilder
            }
        });

        // register 链逐模块防御——loader 注入的某个模块脚本加载失败（404 等）
        // 时 global.AEModules.xxxModule 为 undefined，moduleManager.register 对 undefined
        // 抛「非法模块定义」→ 整条链中断、整个 bootstrap 落入启动失败页，7 个健康模块陪葬。
        // 逐个 try/catch 跳过缺失模块（与 CP-12 的命名空间校验互补）
        var _moduleKeys = ['agentModule', 'skillManagerModule', 'mcpManagerModule', 'comfyuiModule',
            'memoryModule', 'aeToolsModule', 'modelManagerModule', 'assetsModule'];
        for (var _mk = 0; _mk < _moduleKeys.length; _mk++) {
            try {
                appContainer.register(global.AEModules[_moduleKeys[_mk]]);
            } catch (e) {
                console.error('[Main] register module failed (' + _moduleKeys[_mk] + '):', e);
            }
        }

        activeGlobalSettings = await loadGlobalSettings();
        // 暴露 lowPerfMode 到全局，供各模块在 init 时读取
        // （各模块无法直接访问 settingsStore，通过全局变量传递）
        global.AE_ExtP_LowPerfMode = !!activeGlobalSettings.lowPerfMode;
        applyGlobalSettingsToUI();
        console.log('[Main] bootstrap: before renderHomePanel');
        global.AEBoot.setProgress(95, AEI18n.t('渲染主面板…'));
        renderHomePanel();
        console.log('[Main] bootstrap: after renderHomePanel');
        if (typeof initCustomSelects === 'function') initCustomSelects();
        bindHomeEvents();
        global.AECube.init(navigateToModule);
        // 首次打开的 AI 免责声明闸门不在这里——它挡在 bootstrap 之前（见文件尾部的
        // startWithDisclaimerGate）：本函数只在闸门放行后才被调用，故下方时序与改动前一致。
        global.AEBoot.finish(staggerModuleCards);
        global.AEApp = global.AEApp || {};
        global.AEApp.navigateHome = navigateHome;
        global.AEApp.navigateToModule = navigateToModule;
        global.AEApp.startEffectsCacheGeneration = startEffectsCacheGeneration;
        global.AEEasterEgg.init(function () {
            global.AEBoot.finish(function () {
                staggerModuleCards();
                // 启动动画彩蛋结束后，将 ALL CLEAR 原地替换为像素沙盒按钮
                // cloneNode 清掉旧的 NERV 10连击计数器，避免再次触发彩蛋
                var oldAllClear = document.querySelector('.hud-all-clear');
                if (oldAllClear) {
                    var btn = oldAllClear.cloneNode(false);
                    btn.id = 'sandboxEggBtn';
                    btn.textContent = '▣ PIXEL SANDBOX';
                    btn.style.cursor = 'pointer';
                    btn.title = AEI18n.t('像素物理沙盒');
                    btn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        if (typeof window.aeBeep === 'function') window.aeBeep('konami');
                        if (window.AEPixelSandbox && typeof window.AEPixelSandbox.open === 'function') {
                            window.AEPixelSandbox.open();
                        }
                    });
                    oldAllClear.parentNode.replaceChild(btn, oldAllClear);
                }
            });
        });

        global.AEAppContainer = appContainer;
        global.showAboutModal = showAboutModal;
        global.openModal = openModal;
        global.closeModal = closeModal;

        // 桌宠模块启动（彩蛋功能）：
        // - enableDeepseekPet === true → 启动桌宠（controller.init + 行为注册）
        // - enableDeepseekPet === false → 仅初始化彩蛋监听器，等待"大肥鱼"触发
        // 失败不影响主流程，仅打印警告
        if (global.AEDeepseekPet && typeof global.AEDeepseekPet.bootstrap === 'function') {
            try {
                global.AEDeepseekPet.bootstrap({
                    settingsStore: settingsStore,
                    appContainer: appContainer
                });
            } catch (petErr) {
                console.warn('[Main] pet bootstrap failed: ' + (petErr && petErr.message ? petErr.message : petErr));
            }
        }

        // QuickBar 全局快速执行栏启动（独立 fixed 层级，不影响主流程）
        if (global.AEQuickBar && typeof global.AEQuickBar.bootstrap === 'function') {
            try {
                global.AEQuickBar.bootstrap();
            } catch (qbErr) {
                console.warn('[Main] QuickBar bootstrap failed: ' + (qbErr && qbErr.message ? qbErr.message : qbErr));
            }
        }

        console.log('[Main] bootstrap: complete');

        // 关闭耗时埋点转存：把上一轮关面板时 beforeunload 写进 localStorage 的记录
        // 追加到 <数据目录>\temp\logs\unload-timing.log（同步一次，几 KB；失败静默保留
        // localStorage 记录，下次启动再试）。只测量，不影响任何业务路径。
        if (global.AEUnloadTrace && typeof global.AEUnloadTrace.reportOnce === 'function') {
            try { global.AEUnloadTrace.reportOnce(); } catch (_) {}
        }

        // 自定义工具与内建工具重名检查（只报不修）：ae-tools 的初始化早于 agent/engine、
        // memory、skill、comfyui 等模块，注册期判据永远不命中——必须等到此处（全部模块
        // 已 bootstrap、注册表已齐）才扫得出存量冲突。手编 JSON/历史遗留才会命中；
        // 新建路径已由 UI/LLM 两道写入门拒绝。
        if (global.AE_LLM && typeof global.AE_LLM._aeCheckBuiltinNameConflicts === 'function') {
            try {
                global.AE_LLM._aeCheckBuiltinNameConflicts(toolRegistry);
            } catch (e) {
                console.warn('[Main] 工具名冲突检查失败: ' + (e && e.message ? e.message : e));
            }
        }

        // bootstrap 完成后统一触发 MCP shortDescription 生成。
        // 启动期间 onConnected 只注册工具不生成（因 llmChannel/AEAppContainer 尚未就绪），
        // 此处补扫待处理队列，此时所有依赖均已就绪，避免 401 时序问题。
        if (serverManager && typeof serverManager.generateMissingShortDescsForAll === 'function') {
            try {
                serverManager.generateMissingShortDescsForAll();
            } catch (e) {
                console.warn('[Main] MCP shortDesc scan failed: ' + (e && e.message ? e.message : e));
            }
        }

        // Bridge 心跳保活：面板运行时每 10s 探一次 /health，重置 bridge 的 idle 退出计时。
        // 否则 bridge 在无 WS 客户端（纯文件操作）时 5s 自动退出，导致 MCP 等依赖 WS 的功能失效需重启 AE。
        // 面板关闭/刷新后心跳停止，bridge 仍会在 5s 后正常退出。
        startBridgeHeartbeat();

        // 面板关闭前清理：清除定时器，关闭 WebSocket，通知 Bridge 快速退出
        window.addEventListener('beforeunload', function () {
            // 关面板耗时埋点（只测量）：begin/mark/commit 写 localStorage，下次启动转存
            // temp/logs/unload-timing.log；ut 缺失/异常不影响下面既有清理逻辑。
            var ut = global.AEUnloadTrace;
            if (ut) ut.begin('main');
            if (_heartbeatIntervalId) { clearInterval(_heartbeatIntervalId); _heartbeatIntervalId = null; }
            if (_clockIntervalId) { clearInterval(_clockIntervalId); _clockIntervalId = null; }
            // 停止所有 MCP 服务端进程并关闭 WebSocket（Bridge 检测到 WS 断开后 5s 内退出）
            if (mcp && mcp.communicationProvider && typeof mcp.communicationProvider.stopAll === 'function') {
                try { mcp.communicationProvider.stopAll(); } catch (_) {}
            }
            if (ut) ut.mark('main.stopAll');
            // 桌宠三库（聊天历史/记忆/设置）防抖窗口内未落盘的数据：flush 优先走 AEFS
            // 同步写通道（writeFileSync→renameFileSync，Bridge 同步 XHR/cep.fs 原生同步
            // 调用，beforeunload 内可完成），同步不可用时各库自回落异步（边界见各库注释）
            if (global.AEDeepseekPet && typeof global.AEDeepseekPet.flush === 'function') {
                try { global.AEDeepseekPet.flush(); } catch (_) {}
            }
            if (ut) { ut.mark('main.pet'); ut.commit(); }
        });
        // 首屏初始化底部状态栏（模块名/上下文；bridge 段由首轮心跳填充）
        _updateHudModule();
        _updateHudCtx();

        // 效果列表缓存检查：首屏渲染后异步触发，无缓存且未跳过 → 弹提示卡片征询
        setTimeout(triggerEffectsCacheCheck, 1500);
    } catch (e) {
        console.error('[Main] bootstrap FATAL:', e);
        console.warn('[Main] bootstrap FATAL: ' + (e && e.message ? e.message : String(e)));
        // 启动失败也要收起启动动画，否则会卡住遮挡错误界面
        try { global.AEBoot.setProgress(100, AEI18n.t('启动失败')); global.AEBoot.finish(); } catch (_) {}
        // 尝试显示错误提示，让用户知道出了问题
        try {
            var home = document.getElementById('homeView');
            if (home) {
                // 异常消息不再未转义拼进 innerHTML（理论 XSS：脚本名/路径/
                // 文件名中的 HTML 片段会被浏览器解析）——静态骨架保持 innerHTML，
                // 动态消息改 textContent 安全写入
                home.innerHTML = AEI18n.html('<div style="padding:40px;text-align:center;color:#ef6666;"><h3>启动失败</h3><p style="color:var(--text-muted);"></p><p style="font-size:11px;color:var(--text-muted);margin-top:20px;">请查看调试日志或重启 After Effects 后重试。</p></div>');
                var _fatalP = home.querySelector('p');
                if (_fatalP) _fatalP.textContent = (e && e.message ? e.message : String(e));
                home.classList.remove('hidden');
            }
        } catch (_) {}
    }
    }

    // 全局错误兜底——error 与 unhandledrejection 两级监听。
    // 两级兜底，异步故障对用户完全静默且无聚合日志。兜底统一走 console.error
    //（logger.js 已包装 console.error，debugMode 下进调试日志栏）+ AEToast 错误
    // 提示（10s 限频，防错误风暴刷屏吞掉正常提示）
    function installGlobalErrorGuards() {
        var _lastErrToastAt = 0;
        // 布局噪声：`ResizeObserver loop …` 是**浏览器内部**的提示，不是应用故障——CEF 的原生视频
        // 控件自己观察尺寸、在一次通知循环里反复微调，Chromium 跑满 100 轮就放弃并派发这条错误
        //（打开视频全屏必现）。实测：页面里没有任何 JS 侧 ResizeObserver 实例存活（CDP queryObjects
        // 逐个枚举），把 `<video controls>` 关掉即不再出现；渲染结果不受影响（布局最终收敛、播放照常），
        // 用户也没有可执行的动作。故不弹 toast、不记 ERROR——否则点一次视频全屏就刷一条红提示。
        // 首次仍留一条 warn 便于取证，同类后续静默（一次全屏就能出十几条）。
        var LAYOUT_NOISE_RE = /^ResizeObserver loop (limit exceeded|completed with undelivered notifications)/;
        var _layoutNoiseLogged = false;
        function reportUnhandledError(kind, message) {
            if (LAYOUT_NOISE_RE.test(String(message))) {
                if (!_layoutNoiseLogged) {
                    _layoutNoiseLogged = true;
                    try {
                        console.warn('[Main] 已静默的布局噪声（浏览器内部 ResizeObserver，非应用故障）: ' + message);
                    } catch (_) {}
                }
                return;
            }
            try { console.error('[Main] ' + kind + ': ' + message); } catch (_) {}
            var now = Date.now();
            if (global.AEToast && typeof global.AEToast.show === 'function' && now - _lastErrToastAt > 10000) {
                _lastErrToastAt = now;
                try { global.AEToast.show(AEI18n.t('发生未处理的错误，详见调试日志: ') + message, 'error'); } catch (_) {}
            }
        }
        window.addEventListener('error', function (evt) {
            var msg = (evt && evt.message) ? evt.message : String(evt);
            reportUnhandledError('未捕获异常', msg);
        });
        window.addEventListener('unhandledrejection', function (evt) {
            var reason = evt && evt.reason;
            var msg = (reason && reason.message) ? reason.message : String(reason);
            reportUnhandledError('未处理的 Promise 拒绝', msg);
        });
    }

    installGlobalErrorGuards();

    // 首次打开：AI 免责声明闸门**先于一切扩展初始化**（先弹阻断、再加载扩展）。
    // 闸门只用静态 DOM + localStorage，不依赖 bootstrap 的任何产出；未确认就关面板 = 扩展没加载
    // （不连桥、不注册模块、不渲染主面板、不起桌宠/QuickBar）。
    // 已确认过 / 闸门脚本缺失 / 闸门自身抛错 → 立即进入 bootstrap（fail-open，绝不把人锁在门外）。
    (function startWithDisclaimerGate() {
        var gate = null;
        if (global.AEFirstRunDisclaimer && typeof global.AEFirstRunDisclaimer.maybeShow === 'function') {
            try {
                gate = global.AEFirstRunDisclaimer.maybeShow();
            } catch (e) {
                gate = null;
                console.warn('[Main] first-run disclaimer failed: ' + (e && e.message ? e.message : e));
            }
        }
        if (gate && typeof gate.then === 'function') {
            // 确认放行、以及闸门自身出错，都要进 bootstrap（后者宁可漏拦也不能白屏）
            gate.then(function () { bootstrap(); }, function (e) {
                console.warn('[Main] first-run disclaimer error: ' + (e && e.message ? e.message : e));
                bootstrap();
            });
        } else {
            bootstrap();
        }
    })();
})(window);
