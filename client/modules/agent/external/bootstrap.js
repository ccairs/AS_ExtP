/**
 * bootstrap.js — 外接模式模块装配（面板启动即初始化，与 UI 挂载解耦）
 *
 * 加载时机：main.js 启动流程（与工具注册同步）——WS 常连 + ext_panel_hello 随面板在线；
 * 授权门控（外部访问授权总开关）在 ext_dispatch 按调用检查（通道开关语义：激活后面板
 * 生命周期内持续有效，切走 Agent 模块不断连；激活态与模式档位解耦——进出外接档不改动
 * 开关，仅状态卡总开关可控）。
 *
 * 装配内容：
 *   1. 策略层（extPolicy）变更 → extBridgeClient.notifyToolsChanged（动态清单同步）
 *   2. Bridge WS 连接（断线自动重连）
 *   3. UI 初始化钩子（外接模式 tab 挂载时调用 view.init）
 */
(function (global) {
    'use strict';

    function initExternalModule() {
        var ext = global.AEExternal;
        if (!ext || !ext.policy || !ext.bridgeClient) {
            console.warn('[ext-mcp] module files not loaded');
            return { ok: false, error: 'FILES_MISSING' };
        }

        // per-tool 禁用原只存 toolRegistry 内存态（_disabledModules），重启面板即
        // 静默恢复暴露。装配时把 extPolicy 持久化的禁用表回放进注册表（真相源 = extPolicy
        // localStorage，与该页档位/组/per-server 同键；回放优先走 registry.deserialize）。
        if (typeof ext.policy.applyToolSettings === 'function') {
            try { ext.policy.applyToolSettings(); } catch (e) {
                console.warn('[ext-mcp] applyToolSettings failed: ' + (e && e.message ? e.message : e));
            }
        }

        // 超时任务查询工具 ext_task_get 注册。任务表在
        // extBridgeClient（超时登记、迟到结果落表），工具注册需 toolRegistry 已装配
        // ——initExternalModule 由 main.js 在 registry 创建之后调用。注册失败不阻断
        // 外接装配（超时回包仍带 taskId，仅该 id 无法事后查询）。
        if (typeof ext.bridgeClient.registerExtTaskTool === 'function') {
            try {
                var taskReg = ext.bridgeClient.registerExtTaskTool(global.AE_LLM && global.AE_LLM.toolRegistry);
                if (!taskReg || taskReg.ok !== true) {
                    console.warn('[ext-mcp] ext_task_get not registered: ' + ((taskReg && taskReg.error) || 'UNKNOWN'));
                }
            } catch (e) {
                console.warn('[ext-mcp] ext_task_get registration error: ' + (e && e.message ? e.message : e));
            }
        }

        // 策略变更（组/per-server/档位/激活/toast）→ 组与 server 变更推送工具清单变化
        ext.policy.onSettingsChange(function (change) {
            if (change.kind === 'group' || change.kind === 'server') {
                ext.bridgeClient.notifyToolsChanged();
            }
            // 激活态/档位/toast 变化：无协议联动（门控按调用检查），仅 UI 状态刷新由各自监听器处理。
            // per-tool（kind 'tool'）的清单通知由 UI 变更点显式调用（view.js 的 bc.notifyToolsChanged），
            // 此处不重复推送——同一变更双推送会给外部进程发两次清单变化。
        });

        // per-tool 开关（extPolicy.setToolDisabled，内部同步 toolRegistry 镜像）由 UI 调用；
        // 变更后同样推送清单变化（UI 调用点负责调用 notifyToolsChanged）
        ext.bridgeClient.connect();

        console.log('[ext-mcp] external module initialized');
        return { ok: true };
    }

    global.AEExternal = global.AEExternal || {};
    global.AEExternal.init = initExternalModule;
})(window);
