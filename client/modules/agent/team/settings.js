(function (global) {
    'use strict';
    // 团队设置的**读取访问器**。归一的唯一实现在 `engine/settings.js`（`normalizeTeam`），
    // 本文件只负责「按需取到那一份归一结果」，不重复定义默认值——两处默认值就是两个真相源，
    // 迟早出现「设置页显示的值与运行时实际用的值不一致」。
    //
    // 取设置的通道由挂载方注入（`setProvider`）：engine/bootstrap 在装配时注册一个读全局设置的回调；
    // 测试可直接喂一个普通对象。provider 缺席/抛错时一律返回**关闭态**（fail-closed：宁可团队不启用，
    // 也不能在拿不到设置时凭空启用三条 lane）。

    var _provider = null;
    // 重入哨兵：provider 是宿主注入的「读全局设置」回调，
    // 它可能间接回到 snapshot()/isEnabled()（例如经 UI 采集链 → readTeamFromUI）。
    // 那样会形成无界递归——实测每轮 +9 帧、栈深 400+ 仍增长，面板主线程被占死。
    // 这里 fail-closed：重入时按「拿不到设置」返回 null（= 关闭态），并留一条告警便于定位。
    var _resolving = false;

    function setProvider(fn) {
        _provider = (typeof fn === 'function') ? fn : null;
    }

    function resolveSettings(engineSettings) {
        if (engineSettings && typeof engineSettings === 'object') return engineSettings;
        if (!_provider) return null;
        if (_resolving) {
            console.warn('[TeamSettings] 设置读取重入（provider 间接回调 snapshot/isEnabled）——按关闭态返回，不递归');
            return null;
        }
        _resolving = true;
        try {
            var s = _provider();
            return (s && typeof s === 'object') ? s : null;
        } catch (_) {
            return null;
        } finally {
            _resolving = false;
        }
    }

    // team 段（已归一）。拿不到设置或段缺失都返回 null——调用方据此走关闭态。
    function readTeam(engineSettings) {
        var s = resolveSettings(engineSettings);
        if (!s || !s.team || typeof s.team !== 'object') return null;
        return s.team;
    }

    function isEnabled(engineSettings) {
        var t = readTeam(engineSettings);
        return !!(t && t.enabled === true);
    }

    // lane 的模型参数（只有 model / platform / reasoningEffort，无温度维度）。
    // 未归一的输入不在这里兜默认值：直接透传，缺字段由调用方按 lane 定义处理。
    function laneParams(engineSettings, id) {
        var t = readTeam(engineSettings);
        var lanes = (t && t.lanes) ? t.lanes : null;
        var l = (lanes && id && lanes[id]) ? lanes[id] : null;
        if (!l) return null;
        return {
            model: typeof l.model === 'string' ? l.model : '',
            platform: typeof l.platform === 'string' ? l.platform : '',
            reasoningEffort: typeof l.reasoningEffort === 'string' ? l.reasoningEffort : ''
        };
    }

    // 子 Agent 闸：上限/保活/最大轮数。
    function subagent(engineSettings) {
        var t = readTeam(engineSettings);
        var s = (t && t.subagent && typeof t.subagent === 'object') ? t.subagent : null;
        if (!s) return null;
        return {
            maxConcurrent: Number(s.maxConcurrent) || 0,
            keepAliveMs: Number(s.keepAliveMs) || 0,
            maxLoops: Number(s.maxLoops) || 0
        };
    }

    // 整段快照（UI 渲染用；返回副本，调用方不得就地改）
    // baseMode：`enabled` 之外**必须**带上它——UI 侧多处用快照重建 team 段再落盘，
    // 漏了它就会把「团队关掉后该回到哪一档」抹成默认值（退出团队落错档）。
    function snapshot(engineSettings) {
        var enabled = isEnabled(engineSettings);
        var t = readTeam(engineSettings);
        var lanes = {};
        var ids = (global.AEAgentTeam && global.AEAgentTeam.lanes) ? global.AEAgentTeam.lanes.ids : [];
        for (var i = 0; i < ids.length; i++) lanes[ids[i]] = laneParams(engineSettings, ids[i]);
        return {
            enabled: enabled,
            baseMode: (t && typeof t.baseMode === 'string') ? t.baseMode : 'script',
            lanes: lanes,
            subagent: subagent(engineSettings)
        };
    }

    global.AEAgentTeam = global.AEAgentTeam || {};
    global.AEAgentTeam.settings = {
        setProvider: setProvider,
        isEnabled: isEnabled,
        laneParams: laneParams,
        subagent: subagent,
        snapshot: snapshot
    };
})(typeof window !== 'undefined' ? window : globalThis);
