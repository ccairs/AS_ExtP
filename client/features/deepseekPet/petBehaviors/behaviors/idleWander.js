// idleWander.js — 空闲后随机走动
(function (global) {
    'use strict';

    function createIdleWander() {
        var _petApiRef = null;
        // 实例级打断标志——onInterrupt 置位后，moveTo 迟到 resolve 的收尾
        // 回调不再切 idle（该调用链会覆盖顶替者如 crashOverride 的 crash 循环动画）
        var _interrupted = false;

        return {
            id: 'idleWander',
            type: 'idle',
            priority: 10,
            condition: function (ctx) {
                return ctx.petState === 'idle' && !ctx.inSleepMode && !ctx.isDragging;
            },
            action: function (petApi) {
                _petApiRef = petApi;
                _interrupted = false;
                // 目标点交给 movement.wander 选：它按序列帧的位移预算决定方向与距离
                // （本行为不自己算随机坐标：那样可能落在预算外——桌宠走完预算就停下、
                //   序列帧还在播；也可能只差几像素——几乎原地播完整段动画）
                // 注意：不在此处 setState('walk')，由 wander → _setState('walk') 统一设置
                // 否则会用陈旧 _targetX emit 一次 walk:enter，造成方向闪烁（修复）
                return petApi.wander().then(function () {
                    // 打断后的迟到收尾不切 idle——此时 setState('idle') 会
                    // emit idle:enter → playQueued('idle') 覆盖顶替者（crashOverride
                    // 的 crash 循环等）的动画；拖拽有 isDragging 守卫、点击/长按有
                    // 非循环排队，本路径只能在此自设 _interrupted 守卫
                    if (_interrupted) return;
                    petApi.setState('idle');
                });
            },
            onInterrupt: function () {
                // 置打断标志，wander 迟到 resolve 的收尾回调据此跳过 setState
                _interrupted = true;
                // 打断时切 idle，moveTo 的 interval 检测到 _state==='idle' 后自动清理并 settle Promise
                if (_petApiRef) {
                    _petApiRef.setState('idle');
                    _petApiRef = null;
                }
            }
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.defaultBehaviors = global.AEDeepseekPet.defaultBehaviors || {};
    global.AEDeepseekPet.defaultBehaviors.idleWander = createIdleWander;
})(window);
