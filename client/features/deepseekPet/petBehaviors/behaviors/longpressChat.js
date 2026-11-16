// longpressChat.js — 长按弹出对话气泡
(function (global) {
    'use strict';

    function createLongpressChat() {
        return {
            id: 'longpressChat',
            type: 'longpress',
            priority: 10,
            condition: function () { return true; },
            action: function (petApi) {
                petApi.openChat();
                return petApi.wait(500);
            }
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.defaultBehaviors = global.AEDeepseekPet.defaultBehaviors || {};
    global.AEDeepseekPet.defaultBehaviors.longpressChat = createLongpressChat;
})(window);
