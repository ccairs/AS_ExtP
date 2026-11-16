// petEventBus.js — 桌宠模块事件总线，解耦各子模块通信
(function (global) {
    'use strict';

    function createEventBus() {
        var listeners = {};

        function on(event, callback) {
            if (!event || typeof callback !== 'function') return function () {};
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(callback);
            return function () { off(event, callback); };
        }

        function once(event, callback) {
            if (!event || typeof callback !== 'function') return function () {};
            var wrapper = function (data) {
                off(event, wrapper);
                try { callback(data); } catch (e) { console.warn('[PetEventBus] once handler error: ' + e); }
            };
            return on(event, wrapper);
        }

        function off(event, callback) {
            if (!event || !listeners[event]) return;
            if (!callback) { delete listeners[event]; return; }
            var arr = listeners[event];
            for (var i = arr.length - 1; i >= 0; i--) {
                if (arr[i] === callback) arr.splice(i, 1);
            }
            if (arr.length === 0) delete listeners[event];
        }

        function emit(event, data) {
            if (!event || !listeners[event]) return;
            var arr = listeners[event].slice();
            for (var i = 0; i < arr.length; i++) {
                try { arr[i](data); } catch (e) { console.warn('[PetEventBus] handler error for "' + event + '": ' + e); }
            }
        }

        function clear() { listeners = {}; }

        return { on: on, once: once, off: off, emit: emit, clear: clear };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createEventBus = createEventBus;
})(window);
