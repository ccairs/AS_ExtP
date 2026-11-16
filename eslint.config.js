// 三分区：CEF 面板侧 / Node 工具侧 / 排除 ES3 宿主代码
module.exports = [
    // ① CEF 面板侧浏览器代码
    {
        files: ['client/**/*.js'],
        ignores: ['client/vendor/**', 'client/modules/ae-tools/**'],
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'script',
            globals: {
                // 白名单命名空间
                AECore: 'writable', AEModules: 'writable', AE_LLM: 'writable',
                AEEngine: 'writable', AEAgent: 'writable', AEApp: 'writable',
                AEAppContainer: 'writable', AEShared: 'writable',
                // CEP 宿主
                cep: 'readonly', CSInterface: 'writable', __adobe_cep__: 'readonly',
                window: 'readonly', document: 'readonly', navigator: 'readonly',
                XMLHttpRequest: 'readonly', Blob: 'readonly', File: 'readonly',
                TextDecoder: 'readonly', CustomEvent: 'readonly', requestAnimationFrame: 'readonly',
                localStorage: 'readonly', fetch: 'readonly', AbortController: 'readonly',
                // 浏览器标准全局
                setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
                clearInterval: 'readonly', console: 'readonly', atob: 'readonly', btoa: 'readonly',
                crypto: 'readonly', cancelAnimationFrame: 'readonly', DOMParser: 'readonly',
                Event: 'readonly', MouseEvent: 'readonly', FileReader: 'readonly',
                FormData: 'readonly', Image: 'readonly', location: 'readonly',
                WebSocket: 'readonly', URL: 'readonly', TextEncoder: 'readonly',
                MutationObserver: 'readonly', ResizeObserver: 'readonly',
                PerformanceObserver: 'readonly', performance: 'readonly',
                getComputedStyle: 'readonly',
                confirm: 'readonly', prompt: 'readonly', self: 'readonly',
                EventSource: 'readonly', setImmediate: 'readonly',
                // 常见静默依赖（按需增删）
                process: 'readonly', Buffer: 'readonly', module: 'readonly', require: 'readonly',
                __dirname: 'readonly', __filename: 'readonly',
                // IIFE 通用模式：typeof global !== 'undefined' ? global : window
                global: 'readonly',
                // 项目/第三方全局命名空间
                anime: 'readonly', AEFS: 'writable', AEToast: 'writable', AENotice: 'writable',
                // i18n 运行时（shared/i18n/i18nCore.js 建 AEI18n，i18nHtml.js 挂 .html；
                // 清单保证两者先于一切模块装载，调用点按全局裸引用）
                AEI18n: 'readonly',
                // client/vendor/prism/*.min.js 注入的全局（其它模块经 window.Prism/global.Prism 取，
                // 只有 ae-tools/view.js:533-534 用裸 Prism ⇒ 该目录一旦纳入 lint 就是 4 处误报）
                Prism: 'readonly',
                Bridge: 'writable', SystemPath: 'readonly', nodeRequire: 'readonly',
                // AE 宿主注入（ExtendScript eval 提供的全局函数）
                aeBeep: 'readonly', aeChargeStart: 'readonly', aeChargeStop: 'readonly',
                aeChargeUpdate: 'readonly', aeCubeEnter: 'readonly', aeCubeOpen: 'readonly',
                aeCubeSpinStart: 'readonly', aeCubeSpinStop: 'readonly', aeCubeSpinUpdate: 'readonly',
                aeSlotSpin: 'readonly',
                // agent/app/main.js 顶层全局函数/变量（跨 agent 模块引用）
                // chip 解析/插入族声明在 if (scriptPreviewEl) 块内（与预览区右键加 chip 同处），
                // 发送路径在块外引用它们——登记在此（同 _resolveCodeChipTokens 先例）
                _appendFileChip: 'readonly', _renderCodeChipOverlay: 'readonly',
                _resolveCodeChipTokens: 'readonly', applyScriptListToggleUi: 'readonly',
                _hasChipTokens: 'readonly', _resolveChipTokens: 'readonly',
                _insertChipToken: 'readonly', _addLayerRefChips: 'readonly',
                // @ 文件引用补全的插入回调在块外（bindEvents 里建工厂处）取语法模块——同上登记
                _chipTokens: 'readonly',
                // 粘贴/输入法插入前把光标吸出 chip：监听器在块外（与图片粘贴监听同处），
                // 吸附函数随 chip 族声明在块内——同上登记
                _snapCaretOutOfTokens: 'readonly',
                cachedSettings: 'readonly',
                // agent/app/statusBar.js 提供的 window 全局（main.js/settings.js 裸调用）
                clearStatusTimers: 'readonly', hideStatus: 'readonly',
                enforcePreviewFillHeight: 'readonly', evalScriptWithTimeout: 'readonly',
                generatedScript: 'readonly', getCurrentSettingsFromUI: 'readonly',
                getDefaultScriptDir: 'readonly', getSettings: 'readonly', saveSettings: 'readonly',
                initCustomSelects: 'readonly', isDangerousScriptDir: 'readonly',
                llmPreviewHighlighter: 'readonly', modalAnimationState: 'readonly',
                normalizeScriptDir: 'readonly', openModal: 'readonly', refreshList: 'readonly',
                resizeParticleCanvas: 'readonly', showAboutModal: 'readonly',
                showConfirm: 'readonly', showConfirmEx: 'readonly', showPrompt: 'readonly', showGateConfigModal: 'readonly', showStatus: 'readonly',
                startRunPulse: 'readonly', stopRunPulse: 'readonly',
                syncDebugOnlySettingsVisibility: 'readonly', togglePreviewDrawer: 'readonly'
            }
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', {
                args: 'none',
                varsIgnorePattern: '^_',
                argsIgnorePattern: '^_',
                ignoreRestSiblings: true,
                caughtErrors: 'none'
            }],
            // ── 零误报的确定性缺陷规则 ──
            'no-fallthrough': 'error',               // switch 漏 break 静默穿透
            'no-self-assign': 'error',               // x = x 手滑
            'no-self-compare': 'error',              // a === a 恒真（写错变量名典型）
            'no-constant-binary-expression': 'error' // 恒真/恒假条件（|| 'b' 类）
            // 不启用 complexity：存量大函数集中在协议适配器与表单构建器，
            // 拆分属纯风险改动；如日后维护，可按模块热点渐进重构。
        }
    },
    // ② Node 侧
    {
        files: ['client/shared/bridge-server.js', 'tools/**/*.js'],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly', module: 'readonly', exports: 'readonly', process: 'readonly',
                Buffer: 'readonly', __dirname: 'readonly', __filename: 'readonly', console: 'readonly',
                // Node 运行时全局（定时器 / 微任务 / 数据结构）
                setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
                clearInterval: 'readonly', setImmediate: 'readonly', clearImmediate: 'readonly',
                global: 'readonly', queueMicrotask: 'readonly', structuredClone: 'readonly',
                // Node 20+ 提供、且部分工具脚本模拟浏览器时用到的全局
                atob: 'readonly', btoa: 'readonly', Blob: 'readonly', File: 'readonly',
                TextEncoder: 'readonly', TextDecoder: 'readonly', URL: 'readonly',
                fetch: 'readonly', performance: 'readonly', AbortController: 'readonly',
                // 模拟 CEP 浏览器环境时定义/使用的全局
                window: 'readonly', document: 'readonly', navigator: 'readonly',
                CSInterface: 'writable', localStorage: 'readonly',
                // Node 20+ 的全局 WebSocket
                WebSocket: 'readonly'
            }
        },
        rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', {
            args: 'none',
            varsIgnorePattern: '^_',
            argsIgnorePattern: '^_',
            ignoreRestSiblings: true,
            caughtErrors: 'none'
        }],
        // 同①的确定性缺陷规则（Node 侧同样适用）
        'no-fallthrough': 'error',
        'no-self-assign': 'error',
        'no-self-compare': 'error',
        'no-constant-binary-expression': 'error' }
    },
    // ③ 排除 ES3 宿主代码（ExtendScript 无法用现代规则检查）
    {
        ignores: [
            'host/**', 'client/modules/ae-tools/**/aeTools.jsx', '**/*.jsx',
            'client/vendor/**', 'native/**', 'node_modules/**'
        ]
    }
];