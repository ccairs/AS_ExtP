(function (global) {

  function createMemoryController(context) {

    // Reuse the shared registry initialized by bootstrap.js
    var registry = global.AEMemory.getMemoryRegistry();

    /**
     * Extract [[link]] references from content text.
     * Handles Wiki-style pipe: [[target|display]] → target.
     * Returns deduplicated array of link targets.
     */
    function _extractLinks(content) {
      var linkRegex = /\[\[([^\]]+)\]\]/g;
      var links = [];
      var match;
      while ((match = linkRegex.exec(content || '')) !== null) {
        var linkTarget = match[1].trim();
        // Handle Wiki-style pipe: [[target|display text]] → target
        var pipeIdx = linkTarget.indexOf('|');
        if (pipeIdx !== -1) {
          linkTarget = linkTarget.substring(0, pipeIdx).trim();
        }
        if (linkTarget && links.indexOf(linkTarget) === -1) {
          links.push(linkTarget);
        }
      }
      return links;
    }

    return {
      init: function () {
        // 等待共享 registry 的 init 完成——索引首次读失败会在 registry 内
        // 1.5s 后自动重试一次；不等就渲染，视图会先闪「暂无记忆」误导空态
        // （重试成功即恢复正常列表）。registry.init 本就返回 Promise，此处保持
        // 同步抛错转 rejected Promise，维持 UI mount 流的 Promise 契约。
        if (!registry || typeof registry.init !== 'function') return Promise.resolve();
        try {
          return Promise.resolve(registry.init());
        } catch (e) {
          return Promise.reject(e);
        }
      },
      destroy: function () {
        // Registry is shared — do NOT clear it on unmount.
        // UI-only cleanup here if needed.
      },
      getRegistry: function () { return registry; },
      _extractLinks: _extractLinks
    };
  }

  global.AEMemory = global.AEMemory || {};
  global.AEMemory.createMemoryController = createMemoryController;
})(window);
