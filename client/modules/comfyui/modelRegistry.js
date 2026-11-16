(function (global) {
    function createModelRegistry(opts) {
        opts = opts || {};
        var registry = [];
        var _schemaCache = {};       // { classType: schema }
        var _pendingFetches = {};    // 防并发重复请求: { classType: Promise }

        function load(jsonString) {
            try {
                registry = JSON.parse(jsonString || '[]');
            } catch (e) {
                console.warn('[ComfyUI] registry 解析失败:', e.message);
                registry = [];
            }
        }

        // 自动发现条目追加（伙伴节点发现）：按 id 查重（静态 load 条目优先，
        // 冲突时静默跳过并返回 false）；带 classType 的条目同时清空其 schema 缓存
        // 属正常行为（新条目尚未有缓存，无需处理）。
        function add(entry) {
            if (!entry || !entry.id) return false;
            for (var i = 0; i < registry.length; i++) {
                if (registry[i].id === entry.id) return false;
            }
            registry.push(entry);
            return true;
        }

        function listByCategory(cat) {
            return registry.filter(function (m) { return m.category === cat; });
        }

        function getById(id) {
            for (var i = 0; i < registry.length; i++) {
                if (registry[i].id === id) return registry[i];
            }
            return null;
        }

        function getSchema(modelId) {
            var m = getById(modelId);
            if (!m || !m.classType) return null;
            return _schemaCache[m.classType] || null;
        }

        function setSchema(classType, schema) {
            _schemaCache[classType] = schema;
        }

        function getPending(classType) {
            return _pendingFetches[classType] || null;
        }

        function setPending(classType, promise) {
            _pendingFetches[classType] = promise;
        }

        function clearPending(classType) {
            delete _pendingFetches[classType];
        }

        function clearSchemaCache() {
            _schemaCache = {};
            _pendingFetches = {};
        }

        function getAll() {
            return registry.slice();
        }

        return {
            load: load,
            add: add,
            listByCategory: listByCategory,
            getById: getById,
            getSchema: getSchema,
            setSchema: setSchema,
            getPending: getPending,
            setPending: setPending,
            clearPending: clearPending,
            clearSchemaCache: clearSchemaCache,
            getAll: getAll
        };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createModelRegistry = createModelRegistry;
})(window);
