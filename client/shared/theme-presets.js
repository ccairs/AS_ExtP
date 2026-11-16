(function (global) {
    'use strict';

    // 主题预设数据唯一源
    // main.js 和 agent/main.js 共同引用此对象，避免重复定义和色值不一致
    // 另含面板侧主题数据：可编辑核心色分组（THEME_VAR_GROUPS）与档位显示名（THEME_PRESET_LABELS）。
    // 派生键（rgb 三元组 / soft 变体）不存储：由 themeApplier.deriveThemeColors 从核心色计算，
    // 存量 customThemeColors 数据中的旧派生键优先级更高（applier 按 theme.X || 派生 兜底）。
    // 例外：borderRgb / dangerSoft 为存储键 —— 其值与对应核心色并非算法派生关系
    // （default 下 borderRgb=42,48,58 ≠ border #353a44 的 53,58,68；dangerSoft 源色 255,80,80 ≠ danger #ff8a8a）。
    var THEME_PRESETS = {
        default: {
            // --- 原有 15 个变量（色值不变）---
            appBg: '#1a1e24',
            surface1: '#1a1e24',
            surface2: 'rgba(24,30,36,0.7)',
            surface3: 'rgba(20,26,32,0.6)',
            border: '#353a44',
            textMain: '#f0f2f5',
            textMuted: '#7a8090',
            accent: '#fbbf24',
            inputBg: 'rgba(20,26,32,.6)',
            btnBg: '#2a3038',
            btnBorder: '#4a5058',
            btnText: '#c8ced8',
            btnHoverBg: '#353a44',

            // --- 主按钮（.btn.run：运行脚本/发送/生成/反馈）专用配色 ---
            // 暗金底 + 金描边 + 奶油字签名配色。
            // 之所以单列成键而不是写死在 CSS：custom 档要能跟着自定义 accent 走（不然白主题下
            // 还是金按钮），而「没改 accent」时又必须与默认档逐字一致。
            // 内置三档用各自原本的按钮配色，custom 改过 accent 时由 themeApplier.deriveRunColors 派生。
            runBg: '#6a4a20',
            runBorder: '#d4a844',
            runText: '#fef3c7',
            runHoverBg: '#7a5624',

            // --- 已存在于 :root CSS，现纳入主题切换 ---
            danger: '#ff8a8a',
            dangerSoft: 'rgba(255,80,80,.18)',
            signalGreen: '#4ade80',

            // --- 语义状态色扩展：各模块分散定义的同义色，
            //     danger/#ef4444/#f85149/#ff6b6b … 一共 35 个红、21 个橙、15 个绿。
            //     这里按「角色」归一：值取该族里出现最多的那支，多数站点换上去像素不变。
            //     内置三档用同一组值（这些硬编码本来就是不分档位的）。
            dangerVivid: '#ef4444',
            dangerDeep: '#991b1b',
            warningVivid: '#f0b429',
            link: '#58a6ff',
            reason: '#b388ff',
            drag: '#54a8b8',

            // --- 视觉代理高亮（亮蓝色，其它主题使用各自的强调色系）---
            visionProxy: '#3b82f6',

            // --- 全新变量 ---
            accent2: '#f97316',
            accentPurple: '#8f6dce',
            warning: '#fbbf24',

            // --- 管理面板/弹窗/Agent顶栏表面色（保持原硬编码值不变）---
            borderRgb: '42,48,58',
            surfacePanel: 'rgba(12,16,22,0.7)',
            surfaceBar: 'rgba(14,18,24,0.8)',
            surfaceTableWrap: 'rgba(10,14,20,0.6)',
            surfaceModal: 'rgba(20,24,32,0.96)',
            surfaceCard: '#0c1016',
            borderModal: 'rgba(255,255,255,0.08)',
            borderModalLight: 'rgba(255,255,255,0.06)',
            agentTopbarBg: 'linear-gradient(135deg, rgba(24,30,36,0.9), rgba(20,26,32,0.85))',
            agentTopbarHighlightBg: 'linear-gradient(135deg, rgba(28,34,42,0.9), rgba(22,28,36,0.85))',
            agentTopbarHighlightShadow: '0 0 0 1px rgba(84,168,184,0.5), 0 0 20px rgba(84,168,184,0.2)'
        },

        eva01: {
            // --- 紫色主调表面色（提亮 + 降饱和，降低视觉疲劳）---
            appBg: '#181424',
            surface1: '#1C1826',
            surface2: '#201C2C',
            surface3: '#282038',
            border: '#6A5290',
            textMain: '#EEE3F7',
            textMuted: '#AA92C0',
            inputBg: '#2A2440',
            btnBg: '#3a2818',
            btnBorder: '#f8a409',
            btnText: '#e8c8a0',
            btnHoverBg: '#4a3220',

            // --- 主按钮（.btn.run）：沿用本档原本的按钮配色（见 default 档同名注释）---
            runBg: '#3a2818',
            runBorder: '#f8a409',
            runText: '#e8c8a0',
            runHoverBg: '#4a3220',

            // --- 主强调色：初号机眼睛荧光绿（中等饱和）---
            accent: '#4dd947',

            // --- 次要强调色：插入栓橙（中等饱和）---
            accent2: '#f8a409',

            // --- 紫色点缀：仅用于激活/选中态边框（提亮 + 降饱和）---
            accentPurple: '#A48CDA',

            // --- 状态色 ---
            danger: '#e85a5a',
            dangerSoft: 'rgba(232,90,90,.15)',
            signalGreen: '#4dd947',
            warning: '#d97028',

            // --- 语义状态色扩展：与 default 同值（这些硬编码本来就不分档位）---
            dangerVivid: '#ef4444',
            dangerDeep: '#991b1b',
            warningVivid: '#f0b429',
            link: '#58a6ff',
            reason: '#b388ff',
            drag: '#54a8b8',

            // --- 视觉代理高亮（亮蓝紫，与紫色主调区分于绿色强调）---
            visionProxy: '#8f9bff',

            // --- 管理面板/弹窗/Agent顶栏表面色（紫色主调，同步提亮降饱和）---
            borderRgb: '106,82,144',
            surfacePanel: 'rgba(32,28,44,0.7)',
            surfaceBar: 'rgba(28,24,38,0.8)',
            surfaceTableWrap: 'rgba(40,32,56,0.6)',
            surfaceModal: 'rgba(28,24,38,0.96)',
            surfaceCard: '#1C1826',
            borderModal: 'rgba(106,82,144,0.2)',
            borderModalLight: 'rgba(106,82,144,0.15)',
            agentTopbarBg: 'linear-gradient(135deg, rgba(28,24,38,0.9), rgba(32,28,44,0.85))',
            agentTopbarHighlightBg: 'linear-gradient(135deg, rgba(32,28,44,0.9), rgba(28,24,38,0.85))',
            agentTopbarHighlightShadow: '0 0 0 1px rgba(77,217,71,0.5), 0 0 20px rgba(77,217,71,0.2)'
        },

        eva02: {
            // --- 表面色：利用全部深色档位拉开层级（armor-black -> bg -> bg-sec -> panel -> surface -> border）---
            appBg: '#111111',
            surface1: '#1C1316',
            surface2: '#281B1D',
            surface3: '#322124',
            border: '#534246',
            textMain: '#F3F1ED',
            textMuted: '#9D8F88',
            inputBg: '#1E1518',

            // --- 按钮：暗橙底 + 亮橙描边/文字 ---
            btnBg: '#3A1C08',
            btnBorder: '#D87A15',
            btnText: '#D87A15',
            btnHoverBg: '#4A240C',

            // --- 主按钮（.btn.run）：沿用本档原本的按钮配色（见 default 档同名注释）---
            runBg: '#3A1C08',
            runBorder: '#D87A15',
            runText: '#D87A15',
            runHoverBg: '#4A240C',

            // --- 主强调色：鲜红 #D62828（装甲红，交互/hover/focus）---
            accent: '#D62828',

            // --- 次要强调色：橙色 #F68A1F（选中态/按钮边框）---
            accent2: '#F68A1F',

            // --- 点缀色：鲜红（复选框/开关）---
            accentPurple: '#D62828',

            // --- 状态色 ---
            danger: '#E34848',
            dangerSoft: 'rgba(227,72,72,.15)',
            signalGreen: '#5BD36D',
            warning: '#FFD54A',

            // --- 语义状态色扩展：与 default 同值（这些硬编码本来就不分档位）---
            dangerVivid: '#ef4444',
            dangerDeep: '#991b1b',
            warningVivid: '#f0b429',
            link: '#58a6ff',
            reason: '#b388ff',
            drag: '#54a8b8',

            // --- 视觉代理高亮（亮天蓝，与红/橙主色形成对比）---
            visionProxy: '#4dc3ff',

            // --- 管理面板/弹窗/Agent顶栏表面色（与主表面对齐）---
            borderRgb: '83,66,70',
            surfacePanel: 'rgba(36,23,25,0.7)',
            surfaceBar: 'rgba(24,16,18,0.8)',
            surfaceTableWrap: 'rgba(45,29,32,0.6)',
            surfaceModal: 'rgba(45,29,32,0.96)',
            surfaceCard: '#181012',
            borderModal: 'rgba(83,66,70,0.2)',
            borderModalLight: 'rgba(83,66,70,0.15)',
            agentTopbarBg: 'linear-gradient(135deg, rgba(24,16,18,0.9), rgba(36,23,25,0.85))',
            agentTopbarHighlightBg: 'linear-gradient(135deg, rgba(36,23,25,0.9), rgba(24,16,18,0.85))',
            agentTopbarHighlightShadow: '0 0 0 1px rgba(214,40,40,0.5), 0 0 20px rgba(214,40,40,0.2)'
        }
    };

    // 档位显示名（与 index.html 的 #globalThemePreset 下拉文案一致，由测试跨文件钉住）。
    // custom 不是 THEME_PRESETS 的成员——它是「自定义」编辑档/下拉项的显示名。
    // 取值为 getter：本文件在模块装载期求值，直接调 AEI18n.t 会让无 AEI18n 的裸沙箱装载即抛。
    var THEME_PRESET_LABELS = {
        get default() { return AEI18n.t('默认'); },
        get eva01() { return AEI18n.t('初号机'); },
        get eva02() { return AEI18n.t('二号机'); },
        get custom() { return AEI18n.t('自定义'); }
    };

    // 自定义主题面板可编辑的核心色分组（26 项 = 20 核心 + 6 语义状态色）——**唯一清单**：
    // main.js 用它构建调色面板；Agent 主题工具（panel_theme，随 panelTheme 一并接入）取同一份做入参白名单。
    // 只暴露核心色：rgb 三元组 / soft 变体由 themeApplier.deriveThemeColors 派生；
    // 低频表面色（surfaceCard/Panel/Bar/TableWrap/Modal）、弹窗边框、Agent 顶栏项不进清单。
    // title/label 是 getter：本文件在模块装载期求值，直接调 AEI18n.t 会让无 AEI18n 的裸沙箱装载即抛。
    var THEME_VAR_GROUPS = [
        { get title() { return AEI18n.t('背景色'); }, vars: [
            { key: 'appBg', get label() { return AEI18n.t('应用背景'); } },
            { key: 'surface1', get label() { return AEI18n.t('弹窗菜单底'); } },
            { key: 'surface2', get label() { return AEI18n.t('卡片容器底'); } },
            { key: 'surface3', get label() { return AEI18n.t('悬停控件底'); } },
            { key: 'inputBg', get label() { return AEI18n.t('输入框背景'); } }
        ] },
        { get title() { return AEI18n.t('边框'); }, vars: [
            { key: 'border', get label() { return AEI18n.t('结构边框'); } },
            { key: 'btnBorder', get label() { return AEI18n.t('控件边框'); } }
        ] },
        { get title() { return AEI18n.t('文字'); }, vars: [
            { key: 'textMain', get label() { return AEI18n.t('主文字'); } },
            { key: 'textMuted', get label() { return AEI18n.t('次要文字'); } }
        ] },
        { get title() { return AEI18n.t('强调色'); }, vars: [
            { key: 'accent', get label() { return AEI18n.t('聚焦/激活'); } },
            { key: 'accent2', get label() { return AEI18n.t('标题/Tab'); } },
            { key: 'accentPurple', get label() { return AEI18n.t('紫色点缀'); } }
        ] },
        { get title() { return AEI18n.t('按钮'); }, vars: [
            { key: 'btnBg', get label() { return AEI18n.t('按钮背景'); } },
            { key: 'btnText', get label() { return AEI18n.t('按钮文字'); } },
            { key: 'btnHoverBg', get label() { return AEI18n.t('悬停背景'); } }
        ] },
        { get title() { return AEI18n.t('状态色'); }, vars: [
            { key: 'danger', get label() { return AEI18n.t('危险'); } },
            { key: 'dangerVivid', get label() { return AEI18n.t('强错误红'); } },
            { key: 'dangerDeep', get label() { return AEI18n.t('深错误底'); } },
            { key: 'dangerSoft', get label() { return AEI18n.t('危险底色'); } },
            { key: 'warning', get label() { return AEI18n.t('警告'); } },
            { key: 'warningVivid', get label() { return AEI18n.t('强警告橙'); } },
            { key: 'signalGreen', get label() { return AEI18n.t('信号绿'); } },
            { key: 'link', get label() { return AEI18n.t('链接/信息'); } },
            { key: 'reason', get label() { return AEI18n.t('推理紫'); } },
            { key: 'drag', get label() { return AEI18n.t('拖拽高亮'); } },
            { key: 'visionProxy', get label() { return AEI18n.t('视觉代理高亮'); } }
        ] }
    ];

    var THEME_EDITABLE_KEYS = (function () {
        var keys = [];
        for (var i = 0; i < THEME_VAR_GROUPS.length; i++) {
            var vars = THEME_VAR_GROUPS[i].vars;
            for (var j = 0; j < vars.length; j++) keys.push(vars[j].key);
        }
        return keys;
    })();

    global.AE_THEME_PRESETS = THEME_PRESETS;
    global.AE_THEME_PRESET_LABELS = THEME_PRESET_LABELS;
    global.AE_THEME_VAR_GROUPS = THEME_VAR_GROUPS;
    global.AE_THEME_EDITABLE_KEYS = THEME_EDITABLE_KEYS;
})(window);
