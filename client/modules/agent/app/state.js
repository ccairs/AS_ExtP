(function (global) {
    function createStatusState() {
        return {
            hideTimer: null,
            stickyTimeoutTimer: null,
            currentStickyRequestId: 0,
            debugMode: false
        };
    }

    function createScriptListUiState() {
        return {
            expanded: false,
            minHeightPx: 55,
            maxHeightPx: 720,
            openHeightPx: 220
        };
    }

    function createTreeState() {
        return {
            flatNodes: [],
            collapsedSet: {},
            selectedSet: {},
            lastClickedPath: '',
            searchQuery: '',
            dragSourcePath: '',
            dragSourceType: '',
            contextTarget: null,
            ignoredNonScript: 0
        };
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.state = {
        createStatusState,
        createScriptListUiState,
        createTreeState
    };
})(window);
