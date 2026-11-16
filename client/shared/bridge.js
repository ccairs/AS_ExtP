/**
 * AE LLM Bridge 客户端 — CEP 面板侧
 *
 * 通过 Bridge HTTP 调用本地 Bridge Server (http://127.0.0.1:9877/fs/*)。
 * 同步方法走同步 XHR；异步方法（*Async、existsBatch、writeBlob、readBlob 等）
 * 走异步 XHR / fetch，不阻塞主线程。
 *
 * 同步 XHR 不能设 timeout——桥「TCP 可连但不响应」时，同步调用会把面板主
 * 线程永久冻结（心跳定时器/断线浮层全部失去执行机会，只能杀进程）。同步 API 的唯一
 * 消费方（AEFS 同步族）必须先经 isSyncSafe() 门禁：桥须在最近 SYNC_SAFE_MAX_STALE_MS
 * 内被一次异步探活确认有响应，否则一律走 cep.fs 本地通道。异步族不受门禁影响。
 *
 * 返回值与 AEFS 约定一致：
 *   - readFile → string|null
 *   - writeFile / mkdir / deleteFile / renameFile → boolean
 *   - exists → boolean
 *   - isFile → boolean (只读，对齐 exists 安全级别)
 *   - removeDirRecursive → boolean (⚠️ 危险：递归删整棵目录树，不可恢复)
 *   - listFiles / listDirs → string[]
 *   - *Async 系列 → Promise（与对应同步方法同语义；readFileAsync/writeFileAsync
 *     的 4xx 返回结构化拒绝对象 { __bridgeRejected: true, status, error }，见函数注释）
 *   - isAvailable → boolean
 *
 * AEFS 使用 Bridge 作为第一层（最快），不可用时自动回退 cep.fs / ExtendScript。
 *
 * 鉴权：bridge 对 /fs/*、/api/* 与 WS 通道校验
 * Bearer token。token 由 AE 宿主生成、经 evalScript 从 AE 进程内存下发（本机其他
 * 进程不可达）；本模块负责缓存 + 全局 fetch 自动附加 + 401 刷新重试。bridge 手动
 * 开发启动（无 token 交接）时不鉴权，本模块行为不变。
 */

(function (global) {

    // Bridge Server 默认监听 9877，端口被占用时服务端会自动回退到 9878-9886。
    // 客户端通过「鉴权探测」（GET /api/auth-probe，需 token）定位实际端口并缓存，
    // 避免每次调用都探测；仅 /health 会被残留/他会话 bridge 骗过。
    var BRIDGE_DEFAULT_PORT = 9877;
    var BRIDGE_PORT_RANGE = 10;     // 9877..9886，与服务端 start() 的 maxPort 对齐
    var BRIDGE_HOST = '127.0.0.1';
    var _cachedPort = null;
    var _available = false;      // 最近探测得到的 bridge 可用性缓存，供 isAvailable 读取避免同步阻塞
    var _probed = false;         // 是否已做过首次探测（区分「尚未探测」与「已确认缺失」）

    // 端口扫描节流（getBridgePort 用）：最近一次调度异步扫描的时刻，1s 冷却防扫描风暴
    var _lastScanAt = 0;

    // ── 同步 XHR 门禁（半死桥保护）──────────────────────────────
    // 同步 XHR 无 timeout（xhr.timeout 在同步模式抛 InvalidAccessError）。桥进程
    // 「TCP 可连但不响应/极慢」时，AEFS 同步族（readFileSync/writeFileSync/existsSync
    // 等走 _call）会把面板主线程永久占死——心跳 setInterval 与断线 overlay 都不再执行。
    // 门禁要求桥在最近 SYNC_SAFE_MAX_STALE_MS 内被一次「异步有响应」证据确认：
    //   · 心跳成功（main.js beat → setAvailable(true)）、端口扫描/鉴权探测命中、
    //   · WS 握手成功（markAvailable）、任意 *Async 应答到达、同步 _call 收到应答；
    //   · 在线期由 _syncLivenessTick 以 SYNC_LIVENESS_POLL_MS 节奏轻量探活维持新鲜
    //     （仅在 isSyncSafe 被查询后启动；桥停滞时证据自然过期 → 同步族落 cep.fs）。
    var SYNC_SAFE_MAX_STALE_MS = 3000;    // 「最近有响应」证据的最大年龄；超过即禁用同步桥
    var SYNC_LIVENESS_POLL_MS = 1500;     // 在线期轻量探活节奏（<< 窗口，保证正常运行门禁常开）
    var SYNC_LIVENESS_TIMEOUT_MS = 2000;  // 单次探活时限（abort 挂起的 fetch）
    var _lastResponsiveAt = 0;            // 最近一次「桥有响应」的异步证据时刻；0 = 无证据
    var _syncPollTimer = null;            // 探活定时器句柄（桥离线即停）

    // ── 多实例冲突（明确不支持多实例）──────────────────
    // bridge 是单实例资源：宿主启动时按脚本路径杀所有同路径 node 进程（host.jsx），
    // 两个 AE 实例同时开面板会互相杀桥 → 双方 401/断线乒乓。宿主启动时用 WMI 检测
    // 其它 AfterFX.exe，命中则写 temp/handoff/ae_extp_multi_instance.json（见 host.jsx）；
    // 面板在「候选端口全鉴权不符（401/403）/ bridge 反复断线」时读取该标记：
    // 新鲜（≤10 分钟）→ 冲突态（main.js 明示不支持多实例，重试不 restartBridge）。
    // 标记读取经 AEShared（dataDir.js，走 AEFS 三级回退，bridge 死亡时仍可读）。
    var MULTI_INSTANCE_FRESH_MS = 10 * 60 * 1000;
    var _multiInstanceInfo = null;       // 新鲜标记内容 {ts,iso,selfPid,pids}，无则 null
    var _multiInstanceConflict = false;  // 冲突态：读到新鲜标记（由失败/断线场景触发读取）
    var _multiInstanceCheckedAt = 0;     // 最近一次标记读取时刻（节流：2s 内不重复读盘）
    var MULTI_INSTANCE_CHECK_MIN_GAP_MS = 2000;

    // 读新鲜标记（AEShared 缺失/异常一律按「无标记」处理：不进入冲突态，行为不变）
    function _readFreshMultiInstanceMarker() {
        try {
            var shared = global.AEShared;
            if (shared && typeof shared.readFreshMultiInstanceMarkerSync === 'function') {
                return shared.readFreshMultiInstanceMarkerSync(MULTI_INSTANCE_FRESH_MS) || null;
            }
        } catch (_) {}
        return null;
    }

    /**
     * 读标记并刷新多实例冲突态（节流 2s；force=true 绕过节流，供重试/复核后立即生效）。
     * 返回当前是否冲突。调用时机限定在「桥失败/鉴权不符/断线」场景（main.js 心跳与
     * 覆盖层），在线路径不调用——标记在场 ≠ 此刻必然冲突，只有配合失败证据才提示。
     */
    function checkMultiInstanceConflict(force) {
        var now = Date.now();
        if (!force && (now - _multiInstanceCheckedAt) < MULTI_INSTANCE_CHECK_MIN_GAP_MS) {
            return _multiInstanceConflict;
        }
        _multiInstanceCheckedAt = now;
        var info = _readFreshMultiInstanceMarker();
        var was = _multiInstanceConflict;
        _multiInstanceInfo = info;
        _multiInstanceConflict = !!info;
        if (_multiInstanceConflict && !was) {
            var pids = (info && info.pids) ? info.pids.join(',') : '';
            console.warn('[Bridge] 检测到其它 AE 实例（扩展不支持多实例）pids=' + pids);
        }
        return _multiInstanceConflict;
    }

    /** 当前冲突态（读缓存，不读盘）。 */
    function isMultiInstanceConflict() {
        return _multiInstanceConflict;
    }

    /** 最近一次读到的标记内容；无标记返回 null。 */
    function getMultiInstanceInfo() {
        return _multiInstanceInfo;
    }

    // 最近一次同步 _call 被 bridge 明确拒绝（4xx 业务拒绝）的记录；null = 无拒绝
    // （成功 / 5xx / 网络异常）。同步 XHR 拿不到响应体，只能透出状态码，供 AEFS 同步链
    // （readFileSync/writeFileSync）区分「真拒绝」与「通道失败」，决定是否回退 cep.fs——
    // 4xx 拒后仍回退会绕过 bridge 的 symlink/敏感路径防护本地直读写（同步面）。
    // 每次 _call 入口重置；调用方在拿到失败返回值后立即读取（单线程无交错）。
    var _lastSyncRejection = null;

    // 最近一次同步 _call 收到 **401**（token 轮换窗口）的记录。
    // 单独成记录（不并入 _lastSyncRejection——那条链的消费面语义是「业务拒绝」，
    // getLastSyncRejection 的既有契约（含 agent/scripts 的 realpath 逃逸判定）不动）。
    // 消费方（AEFS 同步族）据此**硬失败不回退** cep.fs/ExtendScript：本地回退会绕过
    // bridge 单侧承担的 realpath/symlink 防护（该窗口内的写尤其危险）。
    // 同步通道无法在调用内等待异步 token 刷新（刷新经 evalScript，天生异步），
    // 故 401 时只触发刷新（单飞；下一次调用用新 token 自愈）并如实失败，不重试。
    // 每次 _call 入口重置；调用方在拿到失败返回值后立即读取。
    var _lastSyncUnauthorized = null;

    /**
     * 读取最近一次同步 _call 的 4xx 拒绝状态（无拒绝返回 null）。
     * 供 AEFS 同步链判断「bridge 真拒绝」还是「通道失败/文件不存在」。
     */
    function getLastSyncRejection() {
        return _lastSyncRejection;
    }

    /**
    * 读取最近一次同步 _call 的 401 记录（无则 null）。
     * 供 AEFS 同步族硬失败（token 轮换窗口不回退本地通道）。
     */
    function getLastSyncUnauthorized() {
        return _lastSyncUnauthorized;
    }

    // 主动清空同步拒绝记录。消费方在「即将发起一次新的同步调用、随后
    // 读取记录做判定」前调用——新调用若走 _call 会自行复位，但调用方可能在到达
    // Bridge 前短路（路径校验拒绝/敏感路径/通道不可用），此时记录残留上一次调用
    // 的陈旧状态，被误读为本次调用的拒绝证据。clearSyncRejection 保证读取的新鲜性。
    // 401 记录（_lastSyncUnauthorized）同源同清——两者都承载「本次调用
    // 的桥侧判定」，新鲜性要求一致。
    function clearSyncRejection() {
        _lastSyncRejection = null;
        _lastSyncUnauthorized = null;
    }

    // 最近一次异步通道调用（_callAsync 系）被 bridge 明确拒绝（4xx 业务拒绝）
    // 的记录；null = 无拒绝（成功 / 5xx / 网络异常）。与 _lastSyncRejection 同语义，
    // 供 AEFS 异步链（deleteFile/copyFile/rmdir/rename*/mkdir/removeDirRecursive 等
    // _callAsync 消费方）区分「真拒绝」与「通道失败」——4xx 拒后仍回退 cep.fs/ExtendScript
    // 会绕过 bridge 的 symlink/敏感路径防护本地直写（readFileAsync/
    // writeFileAsync，此处补齐其余方法的异步面）。
    // 每次异步调用入口重置；调用方在拿到失败返回值后立即读取，并校验 method 一致
    // （异步并发下防止读到其他方法的陈旧记录）。
    var _lastAsyncRejection = null;

    /**
     * 读取最近一次异步调用的 4xx 拒绝状态（无拒绝返回 null）。
     * 供 AEFS 异步链判断「bridge 真拒绝」还是「通道失败」，决定是否走本地回退。
     */
    function getLastAsyncRejection() {
        return _lastAsyncRejection;
    }

    // 按调用序号的 4xx 拒绝记录（seq → {method, status}）。模块级单变量
    // _lastAsyncRejection 在并发「同 method」调用时交叉污染——B 调用入口的重置会清掉
    // A 刚写入的记录（A 误判通道失败走回退），或 B 的 4xx 记录被 A 读走（A 误判真拒绝
    // 放弃回退，方向偏安全但丢失可用性）。per-seq 存储让拒绝记录随调用隔离：
    // _callAsync 每次生成递增 seq，4xx 时同时写单变量镜像（兼容既有无参读取）与
    // per-seq 槽位；消费方经 promise 上的 __callSeq 调 consumeAsyncRejection(seq)
    // 取出本次调用自己的记录（取出即删，无陈旧残留）。
    var _asyncCallSeq = 0;
    var _asyncRejections = {};

    /**
 * 按调用序号消费 4xx 拒绝记录。
     * @param {number} seq - 调用序号（Bridge 异步 API 返回 promise 上的 __callSeq）
     * @returns {{method:string, status:number}|null} 本次调用的拒绝记录；非本次调用
     *   的记录（并发交叉）或无拒绝时返回 null
     */
    function consumeAsyncRejection(seq) {
        var r = _asyncRejections[seq] || null;
        delete _asyncRejections[seq];
        return r;
    }

    /**
 * 登记「桥有响应」的异步证据（心跳/扫描/WS 握手/*Async 应答/同步 _call 应答）。
     * 同步门禁 isSyncSafe 只读该时间戳；任何会误报「有响应」的乐观路径都不得调用。
     */
    function _markBridgeResponsive() {
        _lastResponsiveAt = Date.now();
    }

    function _stopSyncLivenessPoll() {
        if (_syncPollTimer !== null) {
            try { clearTimeout(_syncPollTimer); } catch (_) {}
            _syncPollTimer = null;
        }
    }

    // 惰性启动在线期轻量探活（桥离线/无 fetch/无定时器时不启动；不重复挂）
    function _ensureSyncLivenessPoll() {
        if (_syncPollTimer !== null) return;
        if (typeof fetch !== 'function' || typeof setTimeout !== 'function') return;
        _syncPollTimer = setTimeout(_syncLivenessTick, SYNC_LIVENESS_POLL_MS);
    }

    // 轻量探活：GET /health（免 token，避免与鉴权刷新链纠缠）。必须读到响应体末尾
    // 才算「有响应」——只回响应头而体停滞的半死桥同样会冻结同步 XHR。超时 abort /
    // 网络异常都不登记证据，窗口自然过期（安全方向）。
    function _syncLivenessTick() {
        _syncPollTimer = null;
        if (!_available) return;   // 离线：停轮询（重新上线后由 isSyncSafe 再启动）
        var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        var timer = null;
        if (ctrl && typeof setTimeout === 'function') {
            timer = setTimeout(function () {
                timer = null;
                try { ctrl.abort(); } catch (_) {}
            }, SYNC_LIVENESS_TIMEOUT_MS);
        }
        var init = ctrl ? { cache: 'no-store', signal: ctrl.signal } : { cache: 'no-store' };
        fetch(getBridgeUrl() + '/health', init).then(function (res) {
            if (!res) return false;
            if (typeof res.text !== 'function') return !!res.ok;
            // res.text() 也会被同一次 abort 打断（体停滞 → reject → false）
            return res.text().then(function () { return !!res.ok; }, function () { return false; });
        }).catch(function () {
            return false;
        }).then(function (ok) {
            if (timer !== null) { try { clearTimeout(timer); } catch (_) {} }
            if (ok) _markBridgeResponsive();
            if (_available) _ensureSyncLivenessPoll();
        });
    }

    /**
    * 同步桥门禁——当前是否允许同步 XHR（AEFS 同步族）走 Bridge。
     * 条件：① 桥可用（_available，由心跳/扫描/WS 异步维护）
     *       ② 最近 SYNC_SAFE_MAX_STALE_MS 内有过「有响应」的异步证据。
     * 查询会惰性启动在线期轻量探活，正常运行（1.5s 探活 << 3s 窗口）门禁常开；
     * 桥停滞时证据过期 → 同步族落 cep.fs，不再发起无超时的同步 XHR。
     * 残余风险（面板侧无法根除——同步 XHR 不可 abort/不设 timeout）：证据刚更新后
     * 桥立即停滞、且在窗口（≤3s）内恰好发起同步调用时，该次 XHR 仍可能卡住；该窗口相比
     * 「心跳 8s 超时翻 false 前的 ~18s 白窗」已缩短近一个量级。
     * @returns {boolean}
     */
    function isSyncSafe() {
        if (!_available) return false;
        if (typeof fetch === 'function') _ensureSyncLivenessPoll();
        if (!_lastResponsiveAt) return false;
        return (Date.now() - _lastResponsiveAt) <= SYNC_SAFE_MAX_STALE_MS;
    }

    /**
     * 供外部（main.js heartbeat）同步桥可用性结果的内部接口。
     * 探测权利单一归属 heartbeat；这里只更新缓存，供 isAvailable 读取，
     * 从而既让 isAvailable 不阻塞主线程，又能反映在线/断线/恢复的真实状态。
     * @param {boolean} ok - 最近一次探测到的桥是否可用
     */
    function _setAvailable(ok) {
        _probed = true;
        if (ok) {
            _available = true;
            // 可用性翻转由异步探测（心跳/扫描/WS 握手/就绪轮询）确认，是「有响应」证据
            _markBridgeResponsive();
            // 桥在线 = 冲突结束：清冲突态（标记由宿主复核/过期清理，面板不再提示）
            _multiInstanceConflict = false;
            _multiInstanceInfo = null;
            // 注意：不把 _cachedPort 强制写回默认端口——探测可能正发生在 9878+（换端口），
            // 若覆盖会丢失实际端口导致下轮又连错。保留调用方已定位的端口。
        } else {
            _available = false;
            _cachedPort = null;
            // 离线即清「有响应」证据并停探活——同步门禁立即关闭，同步族落本地通道
            _lastResponsiveAt = 0;
            _stopSyncLivenessPoll();
        }
    }

    /**
     * 返回 Bridge Server 当前实际监听端口。
     * 只读缓存 + 节流调度后台异步扫描：命中返回缓存端口；未命中返回默认端口 9877，
     * 扫描找到实际端口后回写缓存，下次调用即命中。
     * 不再发起同步 XHR 探测：同步请求无法设超时，端口被「accept 后不响应」的
     * 进程占用时会无限挂起、冻结整个面板主线程（冷启动即卡死）；在线/离线状态由
     * heartbeat（setAvailable）、WS 握手（markAvailable）与异步扫描维护。
     */
    function getBridgePort() {
        if (_cachedPort) return _cachedPort;
        // 已探测过且确认 bridge 缺失：跳过扫描调度（缓存由 heartbeat/scanPortAsync 异步维护），
        // 避免重连热点（MCP/等）周期性扫描打爆 fetch
        if (_probed && !_available) {
            return BRIDGE_DEFAULT_PORT;
        }
        // 未首探 / believed-online 但端口缓存被清（如 clearPortCache 后）：节流调度异步扫描
        // （1s 冷却——bridge 在线时扫描毫秒级完成，重连热点下高频调 getBridgeUrl 也不会风暴）
        var now = Date.now();
        if (now - _lastScanAt >= 1000) {
            _lastScanAt = now;
            _probed = true;
            scanPortAsync();
        }
        return BRIDGE_DEFAULT_PORT;
    }

    // 端口鉴权探测结果三态（_probePortAuthAsync / scanPortAsync / waitForReady 共用）
    var PROBE_OK = 'ok';       // HTTP 200 + ok:true —— 端口可用（token 有效 / 无鉴权模式）
    var PROBE_AUTH = 'auth';   // HTTP 401/403 —— 进程是 bridge 但 token 失配：跳过，不缓存
    var PROBE_FAIL = 'fail';   // 网络异常/超时/其它状态码 —— 按端口不可用处理

    // 异步「鉴权探测」单个候选端口（fetch，不阻塞主线程）：
    // 只探 /health 不够，而 /health 明确 ok:true 且豁免 token（服务端 _pathNeedsAuth），
    // 「上一会话残留 / 另一 AE 会话」的 bridge 占着 9877 时会骗过探测：面板选中后
    // AEFS/WS 全族 401，重连每次又回到同一端口，永不恢复。改为在候选端口上做一次
    // 需要 token 的轻量请求 GET /api/auth-probe（服务端既有端点，无副作用回声），
    // 判定：
    //   'ok'   200 且响应体 ok:true（token 有效；手动开发启动无鉴权模式同样 200）
    //   'auth' 401/403 —— token 失配：跳过该端口不缓存，并触发 token 刷新（当前轮/下轮自愈）
    //   'fail' 网络异常/超时/其它状态码：与旧 /health 失败同义（端口不可用）
    // 全局 fetch 拦截器自动附加 Bearer（_bridgeToken 非空时）。
    // 探测超时沿用旧值 2s：端口被「accept 后不响应」的进程占用时 fetch 会无限
    // 挂起，不设超时扫描会卡死在该端口、永远找不到 9878+ 上的真实 bridge。
    function _probePortAuthAsync(port) {
        if (typeof fetch !== 'function') return Promise.resolve(PROBE_FAIL);
        var url = 'http://' + BRIDGE_HOST + ':' + port + '/api/auth-probe';
        var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        var timer = null;
        if (ctrl) {
            timer = setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, 2000);
        }
        var init = ctrl ? { cache: 'no-store', signal: ctrl.signal } : { cache: 'no-store' };
        return fetch(url, init).then(function (r) {
            if (!r) return PROBE_FAIL;
            if (r.status === 401 || r.status === 403) return PROBE_AUTH;
            if (r.status !== 200) return PROBE_FAIL;   // 5xx/404 等：非本桥或异常，按不可用
            return r.json().catch(function () { return null; }).then(function (j) {
                return (j && j.ok === true) ? PROBE_OK : PROBE_FAIL;
            });
        }).catch(function () {
            return PROBE_FAIL;   // 网络异常 / 探测超时 abort：按端口不可用处理
        }).then(function (res) {
            // 统一在链尾清理定时器（覆盖 headers 后 body 读取阶段）；已触发的 clearTimeout 是 no-op
            if (timer) clearTimeout(timer);
            // PROBE_OK 已完整读取响应体（j.ok===true），是「有响应」的可靠证据
            if (res === PROBE_OK) _markBridgeResponsive();
            if (res === PROBE_AUTH) {
                // token 失配：刷新面板 token（evalScript 通道）——刷新后当前轮后续端口
                // 或下一轮扫描可自愈；刷新失败（AE 不可达）则诚实判不可用
                refreshBridgeToken();
            }
            return res;
        });
    }

    // 并发扫描去重：心跳 / waitForReady 轮询 / clearPortCache 可能同时触发扫描，
    // 共用同一轮（否则 401 自愈路径每拍叠一轮 10 端口 fetch）
    var _scanInFlight = null;

    /**
     * 异步扫描 9877..9886 定位 Bridge 实际监听端口（用 fetch，不阻塞主线程）。
     * 每端口走「鉴权探测」（_probePortAuthAsync）而非仅 /health——残留/他会话
     * bridge 的 /health 恒 ok 但 token 失配，必须跳过（401/403 不缓存、继续扫下一端口），
     * 只把「鉴权可用」的端口写回缓存，否则会锁死在全族 401 的端口上。
     * 找到后用 _setAvailable(true) 更新缓存，供后续 getBridgePort/isAvailable 读取；
     * 用于桥换端口后定位（由 heartbeat 触发或 getBridgePort 探测默认端口失败时）。
     * @returns {Promise<number|null>} 找到的端口，未找到返回 null
     */
    function scanPortAsync() {
        // fetch 不可用的极端旧环境：无法扫描，按未找到处理（调用方走默认端口/降级链）
        if (typeof fetch !== 'function') return Promise.resolve(null);
        if (_scanInFlight) return _scanInFlight;
        var chain = Promise.resolve(null);
        var sawAuthFail = false;   // 当前轮扫描是否见 401/403（他会话 bridge 占端口）
        for (var p = BRIDGE_DEFAULT_PORT; p < BRIDGE_DEFAULT_PORT + BRIDGE_PORT_RANGE; p++) {
            (function (port) {
                chain = chain.then(function (res) {
                    if (res) return res;   // 已找到，跳过后续
                    return _probePortAuthAsync(port).then(function (r) {
                        if (r === PROBE_AUTH) sawAuthFail = true;
                        return r === PROBE_OK ? port : null;   // 401/403 显式跳过，不缓存
                    });
                });
            })(p);
        }
        _scanInFlight = chain.then(function (port) {
            _scanInFlight = null;
            if (port) {
                _setAvailable(true);
                _cachedPort = port;
                return port;
            }
            // 全部候选都不可用（含「全部 401」的残留实例场景）：明确上报不可用，走既有
            // 断线 overlay 自愈链。已有端口缓存（WS/心跳刚确认在线）时不覆盖——避免慢扫描
            // 结果回退掉并发回报的在线事实。
            if (!_cachedPort) _setAvailable(false);
            // 全段无鉴权可用端口且见过 401/403：读多实例标记——新鲜则进入冲突态，
            // 面板改明示「不支持多实例」并停止 restartBridge 自愈（断互杀循环）。
            if (sawAuthFail) checkMultiInstanceConflict(true);
            return null;
        }, function () {
            // 兜底：探测链上意外异常不永久锁死扫描（_probePortAuthAsync 自身已吞错）
            _scanInFlight = null;
            return null;
        });
        return _scanInFlight;
    }

    function getBridgeUrl() {
        return 'http://' + BRIDGE_HOST + ':' + getBridgePort();
    }

    /**
     * 清除端口缓存。供 WebSocket / 心跳等连接失败后调用，应对 bridge 重启换端口。
     * 不重置 _probed —— 否则下次 getBridgePort() 会重走同步 XHR 探测（bridge 缺失时
     * SYN_SENT 阻塞主线程，正是异步化改造要消灭的场景）；端口重定位改由内部调度的
     * 异步扫描完成，找到后回写 _cachedPort，下次 getBridgePort()/getBridgeUrl() 直接连上新端口。
     */
    function clearPortCache() {
        _cachedPort = null;
        scanPortAsync();
    }

    /**
     * 供外部（communicationProvider WS onopen）同步「桥已在线」事实。
     * WS 与 /health 共用同一 http.Server（bridge-server 的 'upgrade' 在同一 server 上），
     * WS 握手成功即证明该端口 HTTP 服务在线，无需等 heartbeat 首拍（bootstrap 完成后才启动、
     * 间隔 10s）——否则启动期 _available=false 空窗内，AEFS 等读 isAvailable() 的调用方
     * 会在桥实际在线时整段降级 cep.fs/ExtendScript（IO 刷屏且慢）。
     * 与 _setAvailable 同为缓存写入方，持续探测权仍归 heartbeat（下拍失败会如实翻转）。
     * @param {number} [port] - WS 实际握手成功的端口；有效时回写 _cachedPort
     */
    function markAvailable(port) {
        _setAvailable(true);
        if (typeof port === 'number'
            && port >= BRIDGE_DEFAULT_PORT
            && port < BRIDGE_DEFAULT_PORT + BRIDGE_PORT_RANGE) {
            _cachedPort = port;
        }
    }

    // ── Bridge token 鉴权 ──────────────────
    // token 由 AE 宿主生成（host.jsx startBridge → 一次性临时文件交接给 bridge），
    // 面板经 evalScript('getBridgeToken()') 从 AE 进程内存获取——本机其他进程无该
    // 通道。bridge 侧对 /fs/*、/api/* 与 WS 通道校验；token 为 null（AE 不可达 /
    // 测试沙盒）时请求照发，bridge 无鉴权模式（手动开发启动）下行为不变。
    var _bridgeToken = null;
    var _tokenFetching = null;

    function _evalGetBridgeToken() {
        return new Promise(function (resolve) {
            try {
                var cep = (global.AEPlatform && typeof global.AEPlatform.createCepBridge === 'function')
                    ? global.AEPlatform.createCepBridge() : null;
                if (!cep || !cep.isAvailable()) { resolve(null); return; }
                cep.evalScript('getBridgeToken()', 5000, function (r) {
                    // cepBridge.evalScript 回调是对象包装 { ok, result, error }（超时/
                    // 异常 ok=false，error 为 EVAL_TIMEOUT_* 等错误码）。把回参
                    // 当裸字符串消费（typeof r === 'string' 对对象恒 false）→ 恒
                    // resolve(null) → 面板永远拿不到 token → 全族 401/WS 拒绝死锁
                    // （hostApi.js 同通道按对象消费佐证）
                    if (r && typeof r === 'object') {
                        if (r.ok !== true || typeof r.result !== 'string' || !r.result) {
                            resolve(null); return;
                        }
                        // 'EvalScript error.' = CEP 宿主侧函数缺失/异常的固定回显（如 AE
                        // 会话内升级、内存旧版 host.jsx 无 getBridgeToken）——错误信息
                        // 不是 token，误当 token 缓存会让 401 刷新链永不自愈
                        if (r.result === 'EvalScript error.') { resolve(null); return; }
                        resolve(r.result);
                        return;
                    }
                    // 兼容裸字符串形态（测试 stub / 未来通道改直传）
                    if (r === 'EvalScript error.') { resolve(null); return; }
                    resolve(r && typeof r === 'string' && r ? r : null);
                });
            } catch (_) { resolve(null); }
        });
    }

    /**
     * 强制刷新 bridge token（每次 WS 连接前调用——bridge 重启后 host.jsx 会生成
     * 新 token，缓存必然陈旧）。并发去重：同时多次调用共享一次 evalScript。
     * @returns {Promise<string|null>}
     */
    function refreshBridgeToken() {
        if (_tokenFetching) return _tokenFetching;
        _tokenFetching = _evalGetBridgeToken().then(function (t) {
            _tokenFetching = null;
            if (t) _bridgeToken = t;
            return _bridgeToken;
        });
        return _tokenFetching;
    }

    /**
     * 鉴权健康探测：
     * GET /api/auth-probe——/api/* 前缀在 bridge 侧受 token 门槛保护，200/401
     * 区分「token 有效」与「进程活但 token 失配」。fetch 全局拦截器自动附加
     * Bearer（_bridgeToken 非空时；token 为 null 裸发——bridge 无鉴权模式 200、
     * 鉴权模式 401，两种结局判定都正确）。
     * 401/403 时不能继续复用同一端口——服务端 token 不会因面板刷新而改变，
     * 若该端口是「上一会话残留 / 另一 AE 会话」的 bridge（心跳 /health 仍 200），
     * 复用会永续全族 401。此处刷新 token 后清掉端口缓存并重扫，换到鉴权可用的
     * 实际端口；全部端口都不可用才 resolve false（调用方走既有断线 overlay 链）。
     * @returns {Promise<boolean>} true = 鉴权可用（或刷新后重扫到可用端口 / 桥无鉴权模式）
     */
    // 探测本身必须带超时——fetch 挂起（连接既不成功也不拒绝）时
    // 永不 settle，心跳/就绪判定链被无超时探测卡住（重试链也进不去）。AbortController
    // + 兜底 settle：即使宿主实现不响应 abort 也能在超时后 resolve false。
    var AUTH_PROBE_TIMEOUT_MS = 8000;
    function authProbeAsync() {
        return new Promise(function (resolve) {
            try {
                if (typeof fetch !== 'function') { resolve(true); return; }
                var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
                var timer = null;
                var settled = false;
                function clearProbeTimer() {
                    if (timer !== null) { try { clearTimeout(timer); } catch (_) {} timer = null; }
                }
                function settle(v) {
                    if (settled) return;
                    settled = true;
                    clearProbeTimer();
                    resolve(v);
                }
                if (typeof setTimeout === 'function') {
                    timer = setTimeout(function () {
                        timer = null;
                        if (ctrl) { try { ctrl.abort(); } catch (_) {} }
                        settle(false);
                    }, AUTH_PROBE_TIMEOUT_MS);
                }
                fetch(getBridgeUrl() + '/api/auth-probe', ctrl ? { signal: ctrl.signal } : undefined).then(function (resp) {
                    // 响应已到：超时只兜住「探测请求本身挂起」，不覆盖后续刷新/重扫链
                    clearProbeTimer();
                    if (resp && resp.status === 200) { settle(true); return; }
                    if (resp && (resp.status === 401 || resp.status === 403)) {
                        refreshBridgeToken().then(function () {
                            _cachedPort = null;              // 失配端口不再复用
                            return scanPortAsync();          // 按鉴权探测重新定位
                        }).then(function (found) {
                            settle(!!found);
                        });
                        return;
                    }
                    settle(false);
                }).catch(function () { settle(false); });
            } catch (_) { resolve(false); }
        });
    }

    // 全局 fetch 拦截：桥 URL 自动附加 Authorization: Bearer；401 → 刷新 token
    // 重试一次（__bridgeAuthRetried 防循环）。面板内桥调用点分散（本文件/main.js/
    // petWebSearch/ffmpegMovPlayer/skill-manager 等），单点拦截避免逐点改造；
    // 非桥 URL 原样透传。仅处理字符串 URL + 普通对象 headers 形态（本代码库全部
    // 调用形态；Request 对象 / Headers 实例透传不注入）。
    // token 为 null 的桥请求同样纳入 401 自愈链——无 token 直接透传时，
    // 「无 token 直接透传」，首启/预热未完成或 AE 侧换 token 的窗口里 401 无人刷新，
    // 只能等 AEFS 回退本地通道（硬失败后必须补上这条刷新路径）。
    // 刷新失败（拿不到 token）即收敛不重试；重试一次后仍 401 由调用方法按
    // 「硬失败不回退本地」映射（见 writeFileAsync/readFileAsync 等的 401 分支）。
    function _isBridgeFetchUrl(u) {
        return typeof u === 'string' && u.indexOf('http://' + BRIDGE_HOST + ':') === 0;
    }
    (function patchFetchForBridgeAuth() {
        var f = global.fetch;
        if (typeof f !== 'function' || f.__bridgeAuthPatched) return;
        var origFetch = f.bind(global);
        global.fetch = function (input, init) {
            var u = (typeof input === 'string') ? input : '';
            if (!_isBridgeFetchUrl(u)) return origFetch(input, init);
            init = Object.assign({}, init || {});
            init.headers = Object.assign({}, init.headers || {});
            if (_bridgeToken) init.headers['Authorization'] = 'Bearer ' + _bridgeToken;
            return origFetch(input, init).then(function (resp) {
                if (resp && resp.status === 401 && !init.__bridgeAuthRetried) {
                    return refreshBridgeToken().then(function (t) {
                        init.__bridgeAuthRetried = true;
                        if (!t) return resp;   // 刷新失败：收敛（把 401 交给调用方法硬失败）
                        return global.fetch(u, init);   // 重试一次（flag 已置，不再进 401 分支）
                    });
                }
                return resp;
            });
        };
        global.fetch.__bridgeAuthPatched = true;
    })();

    /**
     * 同步调用 Bridge HTTP 端点
     * @param {string} method - fs 方法名 (read/write/mkdir/list/delete/exists/rename/copy-dir)
     * @param {object} params - 请求参数
     * @returns {object|null} 解析后的 JSON 响应，失败返回 null。
     *   4xx（bridge 明确拒绝）额外记录到 _lastSyncRejection，供 getLastSyncRejection() 读取
     */
    // ── 同步调用统计（关面板耗时埋点，只测量）──────────────────────
    // beforeunload 关闭链会串行发起一批同步 XHR（七条会话 store / 画布 / 浮聊 / 桌宠）。
    // 调用次数、总耗时、单次最大值在客户端侧统计，供 shared/unloadTrace.js 随关闭记录
    // 落盘；不依赖桥侧日志（桥可能被 WMI 硬杀，退出日志不完整）。统计无行为影响。
    var _syncCallStats = { count: 0, ms: 0, maxMs: 0 };
    function _perfNow() {
        try {
            if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
                return performance.now();
            }
        } catch (_) {}
        return Date.now();
    }
    function resetSyncCallStats() { _syncCallStats = { count: 0, ms: 0, maxMs: 0 }; }
    function getSyncCallStats() {
        return {
            count: _syncCallStats.count,
            ms: Math.round(_syncCallStats.ms * 100) / 100,
            maxMs: Math.round(_syncCallStats.maxMs * 100) / 100
        };
    }

    function _call(method, params) {
        var _t0 = _perfNow();
        try {
            return _callInner(method, params);
        } finally {
            var d = _perfNow() - _t0;
            _syncCallStats.count++;
            _syncCallStats.ms += d;
            if (d > _syncCallStats.maxMs) _syncCallStats.maxMs = d;
        }
    }

    function _callInner(method, params) {
        // 每次调用入口重置拒绝记录，防止读到上一次调用的陈旧状态
        _lastSyncRejection = null;
        _lastSyncUnauthorized = null;
        if (typeof XMLHttpRequest === 'undefined') return null;
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', getBridgeUrl() + '/fs/' + method, false); // false = 同步
            xhr.setRequestHeader('Content-Type', 'application/json');
            if (_bridgeToken) xhr.setRequestHeader('Authorization', 'Bearer ' + _bridgeToken);
            // 同步 XHR 不能设 timeout（会抛 InvalidAccessError）
            xhr.send(JSON.stringify(params || {}));
            // 收到任何应答（含 4xx/5xx）都证明桥此刻有响应——续期同步门禁，
            // 避免同步突发序列（脚本树扫描/批量 IO）中途门禁过期切本地通道；
            // status===0（网络失败/桥无响应）不续期。
            if (xhr.status) _markBridgeResponsive();
            if (xhr.status === 200) {
                return JSON.parse(xhr.responseText);
            }
            // 401 = token 陈旧（bridge 重启后 host.jsx 换新 token）：触发刷新（单飞，
            // 下一次调用自愈）。取代「401 不计拒绝、允许
            // 本地回退」）：401 单独记录到 _lastSyncUnauthorized——消费方（AEFS 同步族）
            // 据此**硬失败不回退** cep.fs/ExtendScript（本地回退会绕过 bridge 的
            // realpath/symlink 防护）。同步通道无法在调用内等待异步刷新，故不重试；
            // 刷新到位后下一次调用自愈。getLastSyncRejection（业务拒绝）语义不动。
            if (xhr.status === 401) {
                _lastSyncUnauthorized = { method: method, status: 401 };
                refreshBridgeToken();
            }
            // 4xx = bridge 端点明确拒绝（403 symlink 逃逸/敏感路径/命名空间、413 超限、
            // 400 非法路径）。同步通道只透出状态码；5xx 与网络异常不记录
            // （视为通道失败，调用方可回退 cep.fs）。401 不记录（见上）。
            // bodyLimit：413 与 400 Invalid JSON（readBody 超限丢弃 body 的统一回执）
            // 标注「请求体超限」——写面内容未落盘，消费方可区分并允许本地回退。
            if (xhr.status >= 400 && xhr.status < 500 && xhr.status !== 401) {
                _lastSyncRejection = { status: xhr.status, method: method };
                if (xhr.status === 413) {
                    _lastSyncRejection.bodyLimit = true;
                } else if (xhr.status === 400) {
                    try {
                        var jSync400 = JSON.parse(xhr.responseText || '');
                        if (jSync400 && jSync400.error === 'Invalid JSON') _lastSyncRejection.bodyLimit = true;
                    } catch (_) {}
                }
            }
        } catch (e) {
            // bridge 不可用，静默失败
        }
        return null;
    }

    /**
     * 异步调用 Bridge HTTP 端点（不阻塞主线程）。
     * 与 _call 语义一致：成功解析 JSON 返回对象，失败 resolve null。
     * 慢操作（如 copy-file）用异步版，避免 sync XHR 阻塞 UI 导致无法取消。
    * 非 200 时区分 4xx（bridge 端点明确拒绝 = 真拒绝）与其他（5xx/网络异常 =
     * 通道失败）——4xx 记录到 _lastAsyncRejection 供 getLastAsyncRejection() 查询，
     * AEFS 据此不走 cep.fs/ExtendScript 回退（否则 symlink 逃逸/敏感路径的 403 拒绝
     * 会被本地回退绕过）。
    * 401（token 轮换窗口）→ 刷新 token（单飞，刷新在途时
     * 等它）→ **用同一参数重试原请求一次** → 仍 401（或刷新失败即收敛）→ 记 401
     * 拒绝记录（{method,status:401,unauthorized:true}，单变量镜像 + per-seq 槽位），
     * AEFS 据此**硬失败不回退本地通道**（本地回退会绕过 bridge 的 realpath/symlink
     * 防护）。只对 401 走这条路；403/413 等既有语义不变；5xx/网络异常仍为通道失败
     * （可回退）。重试有界（每次请求至多一次，刷新单飞不叠加）。
     * @param {string} method - fs 方法名
     * @param {object} params - 请求参数
     * @returns {Promise<object|null>}
     */
    function _callAsync(method, params) {
        // 每次调用生成递增序号——4xx 拒绝记录同时写单变量镜像（兼容既有
        // 无参 getLastAsyncRejection 读取方）与 per-seq 槽位（随调用隔离，并发同
        // method 调用不再交叉污染）；promise 上挂 __callSeq 供消费方定位本次记录
        var seq = ++_asyncCallSeq;
        var p = new Promise(function (resolve) {
            // 每次调用入口重置异步拒绝记录（对齐 _call 的 _lastSyncRejection 模式；
            // 仅重置单变量镜像，per-seq 槽位按 seq 隔离不受影响）
            _lastAsyncRejection = null;
            if (typeof XMLHttpRequest === 'undefined') return resolve(null);
            var _authRetried = false;   // 401 刷新重试有界（至多一次）
            // 401 终态记录（刷新重试后仍 401 / 刷新失败）：AEFS 据此硬失败不回退
            function recordUnauthorized() {
                var rej = { method: method, status: 401, unauthorized: true };
                _lastAsyncRejection = rej;
                _asyncRejections[seq] = rej;
                resolve(null);
            }
            function send() {
                try {
                    var xhr = new XMLHttpRequest();
                    xhr.open('POST', getBridgeUrl() + '/fs/' + method, true); // true = 异步
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    if (_bridgeToken) xhr.setRequestHeader('Authorization', 'Bearer ' + _bridgeToken);
                    xhr.onreadystatechange = function () {
                        if (xhr.readyState !== 4) return;
                        // 任何应答（含 4xx/5xx）都证明桥此刻有响应——续期同步门禁
                        if (xhr.status) _markBridgeResponsive();
                        if (xhr.status === 200) {
                            try { resolve(JSON.parse(xhr.responseText)); }
                            catch (_) { resolve(null); }
                            return;
                        }
                        // 401 = token 轮换窗口：刷新（单飞）→ 同参数重试一次；
                        // 刷新拿不到 token 即收敛（不重试，直接硬失败——重试也不可能带上
                        // 有效凭据）。重试仍 401 走下方终态记录。
                        if (xhr.status === 401 && !_authRetried) {
                            _authRetried = true;
                            refreshBridgeToken().then(function (t) {
                                if (!t) { recordUnauthorized(); return; }
                                send();
                            }, function () { recordUnauthorized(); });
                            return;
                        }
                        if (xhr.status === 401) { recordUnauthorized(); return; }
                        // 4xx = bridge 端点明确拒绝（403 symlink 逃逸/敏感路径/命名空间、
                        // 400 非法路径/业务失败、413 超限）：记录状态码供 AEFS 判真拒绝；
                        // 5xx 与网络异常不记录（视为通道失败，调用方可回退 cep.fs）
                        if (xhr.status >= 400 && xhr.status < 500) {
                            var rej = { method: method, status: xhr.status };
                            // bodyLimit 标注（同 _call）：413 / 400 Invalid JSON 是体超限类，
                            // 非业务真拒绝；写面消费方据此允许回退（内容未落盘）
                            if (xhr.status === 413) {
                                rej.bodyLimit = true;
                            } else if (xhr.status === 400) {
                                try {
                                    var jAsync400 = JSON.parse(xhr.responseText || '');
                                    if (jAsync400 && jAsync400.error === 'Invalid JSON') rej.bodyLimit = true;
                                } catch (_) {}
                            }
                            _lastAsyncRejection = rej;
                            _asyncRejections[seq] = rej;
                        }
                        resolve(null);
                    };
                    xhr.onerror = function () { resolve(null); };
                    xhr.send(JSON.stringify(params || {}));
                } catch (e) {
                    resolve(null);
                }
            }
            send();
        });
        p.__callSeq = seq;
        return p;
    }

    /**
     * 快速检测 Bridge 是否可用（读缓存，不发起任何同步网络请求）。
     * 返回布尔，保持既有同步调用方（if (isAvailable()) 等）不变。
     * 首次调用只标记已探测 + 调度后台异步扫描（fetch /health）刷新缓存；此后
     * 在线/断线/恢复状态由 main.js heartbeat（setAvailable）与 WS 握手（markAvailable）
     * 异步维护。冷启动首探不再走同步 XHR：同步请求无法设超时，端口被
     * 「accept 后不响应」的进程占用时会无限挂起、冻结整个面板主线程。
     */
    function isAvailable() {
        if (typeof XMLHttpRequest === 'undefined' && typeof fetch === 'undefined') return false;
        if (!_probed) {
            // 首次探测：异步扫描确立初始状态（此后由 heartbeat/markAvailable 维护）。
            // 扫描毫秒级完成，期间 AEFS 等调用方按「bridge 暂不可用」走 cep.fs 回退，
            // 功能不受影响（aefs._bridgeOk 只缓存 true，扫描回写 _setAvailable 后自动切回）。
            _probed = true;
            _available = false;
            scanPortAsync();
        }
        return _available;
    }

    /**
     * 等待 Bridge 就绪（异步轮询，不阻塞 UI）。
     * 每轮 poll 做真实异步探测（fetch /health）而非读 isAvailable 缓存：
     * 缓存由 heartbeat 周期刷新，但本函数常在「restartBridge 刚拉起 node / 面板冷启动」
     * 时调用，heartbeat 首拍尚未发生，读缓存只会永远拿到旧值 false，把已就绪的 bridge
     * 误判为失败（甚至诱导再次 restartBridge 杀掉健康进程）。
     * 探测成功即回写缓存（可用性 + 端口），让 isAvailable/getBridgePort 立即受益。
     * 鉴权门：/health 豁免
     * token——bridge 活着但 token 失配时 health 200 而 AEFS/WS 全族 401，就绪判定
     * 必须走 /api/auth-probe（本函数直探 / 全段扫描均按鉴权探测），否则阻断页 retry
     * 探测假成功 → restartBridge 自愈链永不触发。401 时 authProbeAsync 会刷新 token、
     * 清端口缓存并重扫（不再复用失配端口），轮询继续，刷新到位/重启重新交接后通过。
     * @param {number} [timeoutMs=5000] — 最长等多少毫秒
     * @returns {Promise<boolean>}
     */
    function waitForReady(timeoutMs) {
        return new Promise(function (resolve) {
            if (typeof fetch !== 'function') return resolve(isAvailable());
            var wait = timeoutMs || 5000;
            var deadline = Date.now() + wait;
            var delayMs = 200;
            var settled = false;
            function finish(ok) {
                if (settled) return;
                settled = true;
                resolve(ok);
            }
            // 看门狗兜底：deadline 检查挂在每轮探测 settle 之后，若某个 fetch 挂起
            // （连接既不成功也不拒绝），轮询链会停摆 → 阻断/断线页按钮永远停在「检测中...」。
            // 看门狗在 deadline 后 3s 强制判失败；正常路径总会先于看门狗 settle。
            setTimeout(function () { finish(false); }, wait + 3000);
            function attempt() {
                // 优先直探缓存端口（heartbeat/扫描定位到的换端口）：鉴权探测通过才算就绪；
                // 401/403（残留/他会话实例）或失败都丢弃该缓存端口，交由下面的扫描重新定位
                var direct = _cachedPort
                    ? _probePortAuthAsync(_cachedPort).then(function (res) {
                        return res === PROBE_OK ? _cachedPort : null;
                    })
                    : Promise.resolve(null);
                direct.then(function (port) {
                    if (!port) { _cachedPort = null; return false; }
                    _setAvailable(true);   // 直探的正是该端口且鉴权已过
                    return true;
                }).then(function (directOk) {
                    if (directOk) return finish(true);
                    // 直探不通/无缓存/鉴权未过：全段扫描定位（内部按鉴权选端口并回写缓存）
                    return scanPortAsync().then(function (found) { return !!found; });
                }).then(function (ready) {
                    if (ready) return finish(true);
                    if (Date.now() >= deadline) return finish(false);
                    delayMs = Math.min(delayMs + 100, 800);
                    setTimeout(attempt, delayMs);
                });
            }
            // 快路径同样过鉴权门：available 缓存可能来自 WS 握手等乐观路径——鉴权失败
            // （authProbeAsync 会清缓存重扫）时落完整轮询链
            if (isAvailable()) {
                authProbeAsync().then(function (authOk) {
                    if (authOk) finish(true);
                    else attempt();
                });
            } else {
                attempt();
            }
        });
    }

    /**
     * Bridge 失败体的展示文案：机器码 → 本地化一句话，原始 error 详情保留。
     * 服务端失败体形如 { ok:false, code:'READ_FAILED', error:'EACCES ...' }，
     * code 缺失时按服务端原文 error 展示（旧版 bridge / 非错误体）。
     * 语言由 AEI18n 当前语言决定；AEI18n 未装载（沙盒/早期阶段）时同样回落原文。
     * @param {string|object} codeOrBody — 错误码，或失败响应体 {code, error}
     * @param {string} [errorText] — 传错误码时另给的原始 error 文本
     * @returns {string}
     */
    function failureText(codeOrBody, errorText) {
        var code = '', raw = '';
        if (codeOrBody && typeof codeOrBody === 'object') {
            code = codeOrBody.code;
            raw = codeOrBody.error;
        } else {
            code = codeOrBody;
            raw = errorText;
        }
        raw = (raw == null) ? '' : String(raw);
        code = (code == null) ? '' : String(code);
        if (!code) return raw;
        var i18n = global.AEI18n;
        if (!i18n || typeof i18n.err !== 'function') return raw;
        // 占位符参数从原始错误文本解析；解析不到时回退原文，避免把 {max} 暴露给用户
        var params = null;
        if (code === 'BODY_TOO_LARGE') {
            var m = /max\s+(\d+)/i.exec(raw);
            if (!m) return raw;
            params = { max: m[1] };
        }
        var text = String(i18n.err(code, params, raw || code));
        if (!text) return raw;
        // 本地化文案与原文相同时不重复拼接（未知码回退 fallback 即属于这种）
        return (raw && raw !== text) ? (text + ': ' + raw) : text;
    }

    /**
     * 读文件
     * @param {string} path
     * @returns {string|null}
     */
    function readFile(path) {
        var r = _call('read', { path: path });
        return (r && r.ok && typeof r.data === 'string') ? r.data : null;
    }

    /**
     * 写文件（自动建父目录）
     * @param {string} path
     * @param {string} content
     * @returns {boolean}
     */
    function writeFile(path, content) {
        var r = _call('write', { path: path, content: content });
        return !!(r && r.ok);
    }

    /**
     * 异步写文件（不阻塞主线程）。仿 readFileAsync：用 fetch POST /fs/write，
     * 避免同步 XHR 卡住主线程。
     * 失败语义区分两类（对齐 writeBlob 的 hardReject 惯例）：
     *   - resolve({ __bridgeRejected: true, status, error }) = bridge 4xx 业务拒绝
     *     （403 symlink 逃逸/敏感路径/命名空间、413 超限），调用方不得回退本地通道
     *   - resolve(false) = 通道层失败（5xx / 非 2xx），调用方可回退
     *   - 网络异常 fetch reject（catch）= bridge 不可用，调用方可回退
     * @param {string} path
     * @param {string} content
     * @returns {Promise<boolean|object>}
     */
    function writeFileAsync(path, content) {
        if (typeof fetch !== 'function') return Promise.resolve(false);
        return fetch(getBridgeUrl() + '/fs/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: path, content: content })
        }).then(function (r) {
            // 取代「401 按通道失败允许回退」：401 =
            // token 轮换窗口。fetch 拦截器已刷新 token 并重试一次仍 401（或刷新失败）——
            // 返回结构化拒绝对象，AEFS.writeFile 据此**硬失败不回退** cep.fs/ExtendScript
            // （本地回退会绕过 bridge 的 realpath/symlink 防护本地直写）。
            if (r.status === 401) {
                return r.json().catch(function () { return null; }).then(function (j) {
                    return { __bridgeRejected: true, status: 401, unauthorized: true, error: (j && j.error) ? String(j.error) : 'unauthorized' };
                });
            }
            // 4xx = bridge 端点明确拒绝：返回结构化拒绝对象（含服务端 error 摘要），
            // 让 AEFS.writeFile 终止 cep.fs 回退——否则会绕过 symlink/敏感路径防护本地直写。
            // bodyLimit（413 / readBody 超限的 400 Invalid JSON）= 内容未落盘，AEFS 允许回退
            if (r.status >= 400 && r.status < 500) {
                return r.json().catch(function () { return null; }).then(function (j) {
                    var out = { __bridgeRejected: true, status: r.status, error: (j && j.error) ? String(j.error) : '' };
                    if (r.status === 413 || (r.status === 400 && j && j.error === 'Invalid JSON')) out.bodyLimit = true;
                    // 服务端结构化 code（如 TARGET_NOT_UTF8）透传——AEFS 据此改走
                    // ExtendScript 按原编码写回，而不是当普通拒绝硬失败
                    if (j && j.code) out.code = String(j.code);
                    if (j && j.encoding) out.encoding = String(j.encoding);
                    // 展示文案（本地化一句话 + 服务端原文），error 本身保持原样不动
                    if (out.code) out.errorText = failureText(out.code, out.error);
                    return out;
                });
            }
            if (!r.ok) return false;
            return r.json().then(function (j) {
                return !!(j && j.ok);
            });
        }).catch(function () {
            return false;  // bridge 不可用/网络异常：调用方回退
        });
    }

    /**
     * LLM 专用异步写文件（不阻塞主线程）。走 /fs/write-llm 端点：
     * 可写任意非系统绝对路径（不强制命名空间白名单），由面板侧每次强制用户确认授权。
     * 语义与 writeFileAsync 一致：成功 true，失败 false（Promise 形态）。
     * @param {string} path
     * @param {string} content
     * @returns {Promise<boolean>}
     */
    function writeFileLlmAsync(path, content) {
        if (typeof fetch !== 'function') return Promise.resolve({ ok: false, denied: false });
        return fetch(getBridgeUrl() + '/fs/write-llm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: path, content: content })
        }).then(function (r) {
            // 401 = token 轮换窗口：单独回 unauthorized（审计语义保持）——调用方据此
            // 提示「鉴权刷新中，请重试」，不误报 denied（也非服务器错误）。
            // fetch 拦截器已先刷新 token 并重试一次；此处到达即刷新后仍 401（或刷新失败），
            // AEFS.writeFileLlm 对 unauthorized 本就硬失败不回退，语义一致。
            if (r.status === 401) {
                return r.json().catch(function () { return null; }).then(function (j) {
                    return { ok: false, unauthorized: true, error: (j && j.error) ? String(j.error) : 'unauthorized' };
                });
            }
            // 4xx = bridge 端点明确拒绝（403 敏感/系统目录、400 非法路径等）：denied 且透传
            // 服务端 error 摘要（对齐 writeFileAsync 的 4xx 解析惯例）。
            // bodyLimit（413 / readBody 超限 400）标注体超限——内容未落盘，不是业务拒绝
            if (r.status >= 400 && r.status < 500) {
                return r.json().catch(function () { return null; }).then(function (j) {
                    var errText = (j && j.error) ? String(j.error) : '';
                    if (r.status === 413 || (r.status === 400 && errText === 'Invalid JSON')) {
                        return { ok: false, bodyLimit: true, error: errText || 'request body too large' };
                    }
                    var outLlm = { ok: false, denied: true, error: errText };
                    // 同上，透传结构化 code/encoding
                    if (j && j.code) outLlm.code = String(j.code);
                    if (j && j.encoding) outLlm.encoding = String(j.encoding);
                    if (outLlm.code) outLlm.errorText = failureText(outLlm.code, outLlm.error);
                    return outLlm;
                });
            }
            // 5xx = 服务器内部错误（handleFs catch 500 等）：非用户拒绝，单独标记不折叠为 denied
            if (!r.ok) {
                return r.json().catch(function () { return null; }).then(function (j) {
                    return { ok: false, serverError: true, error: (j && j.error) ? String(j.error) : '' };
                });
            }
            return r.json().then(function (j) {
                return (j && j.ok) ? { ok: true } : { ok: false, denied: true };
            });
        }).catch(function () {
            return { ok: false, denied: false };   // bridge 不可用/网络异常：调用方可回退
        });
    }

    /**
     * 异步读文件（不阻塞主线程）。仿 writeBlob：用 fetch POST /fs/read，
     * 避免同步 XHR 在读取大文件（如数百 KB 的会话历史）时卡住 UI。
     * 失败语义区分两类（对齐 writeBlob 的 hardReject 惯例）：
     *   - resolve({ __bridgeRejected: true, status, error }) = bridge 4xx 真拒绝
     *     （413 超大 / 403 symlink 逃逸或敏感路径 / 400 非法路径），AEFS 据此不回退
     *     cep.fs——否则超大文件被 cep.fs 同步整读会冻结主线程直至 OOM，或绕过
     *     symlink 防护直读敏感目标
     *   - resolve(null) = 通道层失败（5xx / 非 2xx / 响应体异常），AEFS 可回退
     *   - 网络异常 fetch reject（catch）= bridge 不可用，AEFS 可回退
     * @param {string} path
     * @returns {Promise<string|null|object>}
     */
    function readFileAsync(path, opts) {
        if (typeof fetch !== 'function') return Promise.resolve(null);
        // 范围读：`opts.charOffset`/`opts.charCount` 透传给 /fs/read，
        // 由桥侧**解码后按码元**切片（字节/码元不混用）。请求范围时把整个响应体（含 totalChars）
        // 交给上层；未请求范围时保持原样只回字符串（逐字节向后兼容）。
        var _opts = opts || {};
        var _wantRange = (typeof _opts.charOffset === 'number' && isFinite(_opts.charOffset))
            || (typeof _opts.charCount === 'number' && isFinite(_opts.charCount) && _opts.charCount > 0);
        var _body = { path: path };
        if (_wantRange) {
            if (typeof _opts.charOffset === 'number' && isFinite(_opts.charOffset)) _body.charOffset = _opts.charOffset;
            if (typeof _opts.charCount === 'number' && isFinite(_opts.charCount)) _body.charCount = _opts.charCount;
        }
        return fetch(getBridgeUrl() + '/fs/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_body)
        }).then(function (r) {
            // 401 =
            // token 轮换窗口。fetch 拦截器已刷新 token 并重试一次仍 401（或刷新失败）——
            // 返回结构化拒绝对象，AEFS.readFileResult 据此**硬失败不回退** cep.fs
            // （读写同口径：本地回退同样绕过 bridge 的 realpath/symlink 防护）。
            if (r.status === 401) {
                return r.json().catch(function () { return null; }).then(function (j) {
                    return { __bridgeRejected: true, status: 401, unauthorized: true, error: (j && j.error) ? String(j.error) : 'unauthorized' };
                });
            }
            // 4xx = bridge 端点明确拒绝（真拒绝而非通道故障）：返回结构化错误对象
            // （含服务端 error 摘要，如 413 的 "File too large ... use search or paged reading"）。
            // 读面 413 必须保持硬拒绝（本地整读会冻结/OOM），bodyLimit 仅作标注
            if (r.status >= 400 && r.status < 500) {
                return r.json().catch(function () { return null; }).then(function (j) {
                    var out = { __bridgeRejected: true, status: r.status, error: (j && j.error) ? String(j.error) : '' };
                    if (r.status === 413) out.bodyLimit = true;
                    if (j && j.code) out.code = String(j.code);
                    if (out.code) out.errorText = failureText(out.code, out.error);
                    return out;
                });
            }
            if (!r.ok) return null;
            return r.json().then(function (j) {
                if (!j || !j.ok || typeof j.data !== 'string') return null;
                // 范围响应带元数据（range/totalChars/charOffset）——整份交给上层，供 AEFS 组装
                // 「本页 + 全文长度」；非范围响应仍是纯字符串（老调用方零影响）。
                if (_wantRange && j.range === true) {
                    return { __range: true, data: j.data, totalChars: j.totalChars, charOffset: j.charOffset };
                }
                return j.data;
            });
        }).catch(function () {
            return null;  // bridge 不可用/网络异常：调用方回退
        });
    }

    /**
     * 写二进制文件（base64 编码，自动建父目录）
     * @param {string} path
     * @param {string} base64 - base64 编码的二进制内容
     * @returns {boolean}
     */
    function writeFileBase64(path, base64) {
        var r = _call('write-base64', { path: path, content: base64 });
        return !!(r && r.ok);
    }

    /**
     * 异步写二进制文件（base64 编码，自动建父目录，不阻塞主线程）。
 * 失败语义区分两类（对齐 writeFileAsync 的 __bridgeRejected 惯例）：
     *   - resolve({ __bridgeRejected: true, status, error }) = bridge 4xx 业务拒绝
     *     （403 symlink 逃逸/敏感路径/命名空间、413 超限），调用方不得回退本地通道
     *   - resolve(false) = 通道层失败（5xx / 非 2xx），调用方可回退
     *   - 网络异常 fetch reject（catch）= bridge 不可用，调用方可回退
     * @param {string} path
     * @param {string} base64 — base64 编码的二进制内容
     * @returns {Promise<boolean|object>}
     */
    function writeFileBase64Async(path, base64) {
        if (typeof fetch !== 'function') return Promise.resolve(false);
        return fetch(getBridgeUrl() + '/fs/write-base64', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: path, content: base64 })
        }).then(function (r) {
            // 401 =
            // token 轮换窗口（fetch 拦截器已刷新 token 并重试一次仍 401，或刷新失败）——
            // 返回结构化拒绝对象，AEFS.writeFileBase64 据此**硬失败不回退**本地通道。
            if (r.status === 401) {
                return r.json().catch(function () { return null; }).then(function (j) {
                    return { __bridgeRejected: true, status: 401, unauthorized: true, error: (j && j.error) ? String(j.error) : 'unauthorized' };
                });
            }
            // 4xx = bridge 端点明确拒绝：返回结构化拒绝对象（含服务端 error 摘要），
            // 让 AEFS.writeFileBase64 终止 cep.fs/ExtendScript 回退——否则会绕过
            // symlink/敏感路径防护本地直写（4xx 被折叠成 false 会走回退）。
            // bodyLimit（413 / 400 Invalid JSON）内容未落盘，AEFS 允许回退
            if (r.status >= 400 && r.status < 500) {
                return r.json().catch(function () { return null; }).then(function (j) {
                    var out = { __bridgeRejected: true, status: r.status, error: (j && j.error) ? String(j.error) : '' };
                    if (r.status === 413 || (r.status === 400 && j && j.error === 'Invalid JSON')) out.bodyLimit = true;
                    if (j && j.code) out.code = String(j.code);
                    if (out.code) out.errorText = failureText(out.code, out.error);
                    return out;
                });
            }
            if (!r.ok) return false;
            return r.json().then(function (j) {
                return !!(j && j.ok);
            });
        }).catch(function () {
            return false;  // bridge 不可用/网络异常：调用方回退
        });
    }

    /**
     * 写二进制文件（原始字节 body，免 base64/JSON 编解码，大文件快一个量级）。
     * 唯一的异步方法：用 fetch 发 Blob body（同步 XHR 发 Blob 在 CEP 不稳，且会卡主线程）。
     * 路径走 query 参数（encodeURIComponent），bridge 侧 safePath + safeForDelete 校验。
     * 失败语义区分两类（供 AEFS.writeBlob 决定是否回退 base64 链）：
     *   - reject（带 .hardReject=true）= bridge 业务拒绝（4xx 超限/安全）或 401
    * （token 轮换窗口），不可回退
     *   - resolve(false) = 通道层失败（5xx / 非 2xx / ok=false），可回退
     *   - 网络异常 fetch reject（无标记）= bridge 不可用，可回退
     * @param {string} path
     * @param {Blob} blob
     * @returns {Promise<boolean>}
     */
    function writeBlob(path, blob) {
        if (typeof fetch !== 'function' || !blob) return Promise.resolve(false);
        var u = getBridgeUrl() + '/fs/write-blob?path=' + encodeURIComponent(path);
        return fetch(u, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: blob
        }).then(function (r) {
            // 401 = token
            // 轮换窗口（fetch 拦截器已刷新并重试一次仍 401，或刷新失败）→ 与 4xx 业务
            // 拒绝同口径 reject 标记，AEFS.writeBlob 不回退 base64 链（本地回退绕过
            // bridge 的 realpath/symlink 防护）。
            if (r.status === 401) {
                var ea = new Error('writeBlob unauthorized (401，token 轮换窗口)');
                ea.hardReject = true;
                ea.unauthorized = true;
                throw ea;
            }
            // 4xx 业务拒绝（超限/安全）→ reject 标记，AEFS 据此不回退 base64（回退只会双重内存峰值）
            if (r.status >= 400 && r.status < 500) {
                var e = new Error('writeBlob rejected: ' + r.status);
                e.hardReject = true;
                e.bodyLimit = (r.status === 413);
                throw e;
            }
            if (!r.ok) return false;  // 5xx / 非 2xx：通道层失败，可回退
            return r.json().then(function (j) { return !!(j && j.ok); });
        }).catch(function (e) {
            if (e && e.hardReject) throw e;   // 透传业务拒绝给 AEFS
            return false;  // 网络异常 / bridge 不可用：吞掉，AEFS 视为可回退
        });
    }

    /**
     * 读二进制文件为 Blob（原始字节流，免 base64/JSON，大文件快一个量级）。
     * 是 writeBlob 的对称项。路径走 query，GET 方法。bridge 侧 safePath 双校验 + isFile + 上限 + waitFileStable。
     * 失败返回 null（与 readImageBase64 返回 null 语义一致，AEFS 据此回退）。
     * @param {string} path
     * @returns {Promise<Blob|null>}
     */
    function readBlob(path) {
        if (typeof fetch !== 'function') return Promise.resolve(null);
        var u = getBridgeUrl() + '/fs/read-blob?path=' + encodeURIComponent(path);
        return fetch(u, { method: 'GET' }).then(function (r) {
            if (!r.ok) return null;
            return r.blob();
        }).catch(function () { return null; });
    }

    /**
     * 建目录（递归）
     * @param {string} path
     * @returns {boolean}
     */
    function mkdir(path) {
        var r = _call('mkdir', { path: path });
        return !!(r && r.ok);
    }

    /**
     * 异步建目录（不阻塞主线程）。语义与 mkdir 一致：成功返回 true，失败/Bridge 不可用返回 false。
     * 供移动/导入等循环路径用，避免同步 XHR 累积阻塞主线程。
     * @param {string} path
     * @returns {Promise<boolean>}
     */
    function mkdirAsync(path) {
        // __callSeq 透传到外层 promise（对齐 listFilesAsync 既有范式）——
        // .then 链式返回生成新 promise 丢失 _callAsync 挂载的 __callSeq，AEFS 的
        // _bridgeAsyncRejection 拿不到 seq 恒退回单变量镜像（每次 _callAsync 入口
        // 复位、被任意后续 4xx 覆写），并发交叉污染在这九处原样存在（
        // per-seq 修复对它们未生效）。本注释适用于以下八个同款包装
        var p = _callAsync('mkdir', { path: path });
        var out = p.then(function (r) {
            return !!(r && r.ok);
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
     * 列文件
     * @param {string} path
     * @returns {string[]}
     */
    function listFiles(path) {
        var r = _call('list', { path: path });
        return (r && r.ok && Array.isArray(r.files)) ? r.files : [];
    }

    /**
     * 异步列文件（不阻塞主线程）。仿 readFileAsync：用 fetch POST /fs/list，
     * 避免同步 XHR 在列目录（如 shader 效果库刷新）时卡住 UI。
     * 失败语义三态化：成功返回文件名数组（空目录返回空数组 []），
     * 通道失败（5xx/网络异常/解析失败）与路径不存在（notFound 标记，交复核链
     * 定论 NOT_FOUND）一律 resolve null——失败与真空折叠成同一个 [] 时，
     * AEFS 无法信任空答案、每个空目录都经 ExtendScript/cep.fs 再复核一遍，
     * 启动期大预设库全树扫描产生上百次 evalScript 洪泛。
     * @param {string} path
     * @returns {Promise<string[]|null>}
     */
    function listFilesAsync(path) {
        // 改走 _callAsync（与 mkdirAsync/deleteFileAsync 等同通道）——原 fetch
        // 直连版把 4xx 真拒绝（symlink 逃逸 403 等）与通道失败同语义折叠成 []，
        // 调用方无从感知被拒；_callAsync 按 seq 记录 4xx 拒绝，AEFS 经
        // consumeAsyncRejection 二分「真拒绝」与「通道失败」。__callSeq 透传到外层
        // promise（.then 会生成新 promise 丢失挂载属性），供消费方定位本次调用的记录
        var p = _callAsync('list', { path: path });
        var out = p.then(function (r) {
            if (r && r.ok && Array.isArray(r.files) && !r.notFound) return r.files;
            return null;
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
     * 列子目录
     * @param {string} path
     * @returns {string[]}
     */
    function listDirs(path) {
        var r = _call('list', { path: path });
        return (r && r.ok && Array.isArray(r.dirs)) ? r.dirs : [];
    }

    /**
 * 异步列子目录（不阻塞主线程）。失败语义与 listFilesAsync 同（
     * 三态化）：空目录返回空数组 []（权威答案），通道失败/路径不存在返回 null。
     * 慢操作（如拖文件夹递归扫描大量子目录）用异步版，避免同步 XHR 阻塞主线程无重绘空隙。
     * @param {string} path
     * @returns {Promise<string[]|null>}
     */
    function listDirsAsync(path) {
        // 改走 _callAsync（与 listFilesAsync 同款）——原 fetch 直连版把 4xx 真拒绝
        // 折叠成 []；_callAsync 按 seq 记录 4xx 拒绝，__callSeq 透传到外层
        // promise 供 AEFS consumeAsyncRejection 二分
        var p = _callAsync('list', { path: path });
        var out = p.then(function (r) {
            if (r && r.ok && Array.isArray(r.dirs) && !r.notFound) return r.dirs;
            return null;
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
     * 列文件 + 体积/龄（异步）。供 temp 缓存体积预算量体积用。
     * 失败语义与 listFilesAsync 同族三态化：空目录/目录不存在返回 []（权威答案——
     * 端点对不存在的目录直接回空清单，没有 'list' 那套 ExtendScript 复核链），
     * 通道失败返回 null——消费方据此「整轮跳过」而不是按 0 字节算总量。
     * @param {string} path
     * @returns {Promise<Array<{name:string,size:number,mtimeMs:number}>|null>}
     */
    function listSizesAsync(path) {
        var p = _callAsync('list-sizes', { path: path });
        var out = p.then(function (r) {
            if (r && r.ok && Array.isArray(r.files)) return r.files;
            return null;
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
     * 删文件
     */
    function deleteFile(path) {
        var r = _call('delete', { path: path });
        return !!(r && r.ok);
    }

    /**
     * 删文件（异步 XHR，不阻塞主线程）。语义与 deleteFile 对齐：成功返回 true，失败/Bridge 不可用返回 false。
     */
    function deleteFileAsync(path) {
        // __callSeq 透传（原因见 mkdirAsync 注释）
        var p = _callAsync('delete', { path: path });
        var out = p.then(function (r) {
            return !!(r && r.ok);
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
    * 删文件但**优先移入回收站**（桥侧 Shell COM 通道，与
     * remove-dir-recursive 同源）。返回 { ok, method?, reason? }：
     *   ok:true  + method:'recyclebin' → 已入回收站（可恢复）
     *   ok:false + needRecycle:false  → 回收站通道不可用/失败（调用方决定是否退回永久删）
     *   ok:false                      → Bridge 不可用/超时（同上，调用方兜底）
     */
    function deleteFileRecycleAsync(path) {
        var p = _callAsync('delete', { path: path, recycle: true });
        var out = p.then(function (r) {
            if (r && r.ok) return { ok: true, method: r.method || 'recyclebin' };
            return { ok: false, needRecycle: r && r.needRecycle === false, reason: (r && r.reason) || 'bridge unavailable' };
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
     * 删空目录（非递归，目录非空会失败）
     */
    function rmdir(path) {
        var r = _call('rmdir', { path: path });
        return !!(r && r.ok);
    }

    /**
     * 异步删空目录（不阻塞主线程）。语义与 rmdir 一致：成功 true，失败 false。
     * 改走 _callAsync（独立 fetch 版会把 4xx 与通道失败同语义折叠成
     * false）——4xx 记入 _lastAsyncRejection，供 AEFS.rmdir 区分「真拒绝」与
     * 「通道失败」决定是否回退 ExtendScript。
     * @param {string} path
     * @returns {Promise<boolean>}
     */
    function rmdirAsync(path) {
        // __callSeq 透传（原因见 mkdirAsync 注释）
        var p = _callAsync('rmdir', { path: path });
        var out = p.then(function (r) {
            return !!(r && r.ok);
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
     * ⚠️ 危险文件管理函数：递归删除整棵目录树（含所有内容）。
     * 最后防线：优先移到 Windows 回收站（可恢复），失败需前端用户确认才物理删除。
     * 使用或修改前必须仔细检查安全校验链是否完整（见 bridge-server.js remove-dir-recursive 端点）。
     *
     * 三阶段协议（配合 AEFS 层弹窗）：
     *   ① 文件数 >50 且未带 opts.forceCountConfirm → {ok:false, needCountConfirm:true, count:N}
     *   ② 回收站失败且未带 opts.permanent → {ok:false, needPermanentConfirm:true, reason:...}
     *   ③ opts.permanent:true 或回收站成功 → {ok:true, method:'recyclebin'|'permanent'}
     *
     * @param {string} path
     * @param {object} [opts] - { forceCountConfirm?: boolean, permanent?: boolean }
     * @returns {object|null} 完整响应对象（AEFS 层判断 needCountConfirm/needPermanentConfirm）
     */
    function removeDirRecursive(path, opts) {
        var params = { path: path };
        if (opts && opts.forceCountConfirm) params.forceCountConfirm = true;
        if (opts && opts.permanent) params.permanent = true;
        return _call('remove-dir-recursive', params);
    }

    /**
     * 递归删目录树（异步 XHR，不阻塞主线程）。语义与 removeDirRecursive 对齐：
     * 返回 Promise<object|null>，完整响应对象由 AEFS 层判断 needCountConfirm/needPermanentConfirm。
     */
    function removeDirRecursiveAsync(path, opts) {
        var params = { path: path };
        if (opts && opts.forceCountConfirm) params.forceCountConfirm = true;
        if (opts && opts.permanent) params.permanent = true;
        return _callAsync('remove-dir-recursive', params);
    }

    /**
     * 检查路径是否存在
     * @param {string} path
     * @returns {boolean}
     */
    function exists(path) {
        var r = _call('exists', { path: path });
        return (r && r.ok) ? !!r.exists : false;
    }

    /**
     * 异步检查路径是否存在（不阻塞主线程）。
     * 供移动重名检测等循环路径用，避免同步 XHR 累积阻塞主线程。
     * 失败语义三态化（与 listFilesAsync 同族）：存在返回 true，
     * bridge 权威「不存在」（服务端 200 + exists:false）返回 false；
     * 通道失败（5xx/网络异常/4xx/响应无效）返回 null——失败与权威 false
     * 折叠成同一个 false 时，AEFS 对每个负答案都经 ExtendScript 复核一遍
     * （existsResult 的 NOT_FOUND 定论被强迫降级为逐次 evalScript 往返）。
     * @param {string} path
     * @returns {Promise<boolean|null>}
     */
    function existsAsync(path) {
        // __callSeq 透传（原因见 mkdirAsync 注释）
        var p = _callAsync('exists', { path: path });
        var out = p.then(function (r) {
            return (r && r.ok) ? !!r.exists : null;
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
     * 批量存在性探测（真异步，不阻塞主线程）。仿 readFileAsync：用 fetch POST /fs/exists-batch，
     * 一次往返校验多个路径，避免遍历几万素材时逐条同步 XHR 冻结 UI。
     * 成功时语义与 exists 对齐：任意路径校验失败（非法/逃逸/敏感）由服务端按不存在（false）返回。
     * 通道级故障（网络异常/非 2xx/响应体无效）必须 reject：resolve([]) 会被
     * AEFS.existsBatch 映射成「等长全 false」，绕过调用方全部「无法校验按存在」防护
     * （quickBarScanner 三层/store 层 catch），掉线窗口内全部素材被误标 missing——
     * reject 让 AEFS 走逐条 exists 回退（单条 exists 自带 ExtendScript 回退链）。
     * @param {string[]} paths
     * @returns {Promise<boolean[]>} 成功：与输入等长，index 一一对应；通道故障：reject
     */
    function existsBatch(paths) {
        if (typeof fetch !== 'function' || !Array.isArray(paths) || !paths.length) {
            return Promise.reject(new Error('existsBatch 前置检查失败（fetch 不可用/入参非非空数组）'));
        }
        return fetch(getBridgeUrl() + '/fs/exists-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: paths })
        }).then(function (r) {
            if (!r.ok) throw new Error('exists-batch HTTP ' + r.status);
            return r.json().then(function (j) {
                if (!j || !j.ok || !Array.isArray(j.exists)) throw new Error('exists-batch 响应无效');
                // 服务端 exists 已与输入等长；防御性补齐到输入长度（缺省按不存在）
                while (j.exists.length < paths.length) j.exists.push(false);
                return j.exists;
            });
        });
        // fetch 网络异常沿 promise 链自然 reject，不吞成 []
    }

    /**
     * 路径是否为普通文件（只读，Bridge 同步 XHR）
     * @param {string} path
     * @returns {boolean}
     */
    function isFile(path) {
        var r = _call('is-file', { path: path });
        return (r && r.ok) ? !!r.isFile : false;
    }

    /**
         * 异步检查路径是否为普通文件（不阻塞主线程）。
         * 经 _callAsync（与 existsAsync 同通道）：4xx「真拒绝」（403 symlink 逃逸等）
         * 不被折叠成 false，否则 AEFS.isFile 无法二分、无条件走 ExtendScript 回退
         * （File.exists 跟随 symlink，绕过 bridge 拒绝）。
         * 失败语义三态（与 existsAsync/listFilesAsync 同族）：是文件返回 true，
         * bridge 权威「非文件/不存在」（200 + isFile:false）返回 false；通道失败
         * 返回 null——否则失败与权威 false 折叠，每个负答案都要落到 ExtendScript 查询。
         * @param {string} path
         * @returns {Promise<boolean|null>}
         */
    function isFileAsync(path) {
        // __callSeq 透传（原因见 mkdirAsync 注释）
        var p = _callAsync('is-file', { path: path });
        var out = p.then(function (r) {
            return (r && r.ok) ? !!r.isFile : null;
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
     * 异步探测路径**本身**是否为链接（symlink/junction），并取回其真实目标（不阻塞主线程）。
    * delete/rmdir/rename 作用于 realpath 目标，面板在删除/重命名
     * 前需要这条事实来做显式提示（探测只是提示依据，不改变操作语义）。
     * 失败语义三态化（与 isFileAsync 同族），但第三态带原因：
     *   是/否链接 → { isLink, realpath }；bridge 权威「不是链接」（200 + isLink:false）→ { isLink:false, realpath:null }；
     *   通道失败/真拒绝（4xx symlink 逃逸等）→ null——调用方按「探不到」放行既有流程
     *   （fail-open：探不到 ≠ 是链接，不因提示通道故障阻断删除/重命名）。
     * @param {string} path
     * @returns {Promise<{isLink: boolean, realpath: string|null}|null>}
     */
    function isLinkAsync(path) {
        // __callSeq 透传（原因见 mkdirAsync 注释）
        var p = _callAsync('is-link', { path: path });
        var out = p.then(function (r) {
            if (!(r && r.ok)) return null;
            return { isLink: !!r.isLink, realpath: r.realpath || null };
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
    * 只读真实路径探测（消解 junction/symlink/短名/映射盘）。
     * 用于迁移前判断两个数据根是不是同一物理目录或物理上互相嵌套。
     * 失败语义：通道失败 / 4xx 真拒绝 / 旧版 bridge 无此端点 → null（调用方 fail-open）。
     * @param {string} path
     * @returns {Promise<string|null>}
     */
    function realpathAsync(path) {
        var p = _callAsync('realpath', { path: path });
        var out = p.then(function (r) {
            return (r && r.ok && typeof r.realpath === 'string' && r.realpath) ? r.realpath : null;
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
     * 拷贝目录（文本文件）
     * @param {string} src
     * @param {string} dst
     * @returns {number} 拷贝的文件数
     */
    function copyDir(src, dst) {
        var r = _call('copy-dir', { src: src, dst: dst });
        return (r && r.ok) ? (r.copied || 0) : -1;
    }

    /**
     * 重命名文件（仅同目录，原子操作）
     * @param {string} src — 源路径
     * @param {string} dst — 目标路径
     * @returns {boolean}
     */
    function renameFile(src, dst) {
        var r = _call('rename', { src: src, dst: dst });
        return !!(r && r.ok);
    }

    /**
     * 异步重命名文件（不阻塞主线程）。语义与 renameFile 一致：成功 true，失败 false。
     * @param {string} src
     * @param {string} dst
     * @returns {Promise<boolean>}
     */
    function renameFileAsync(src, dst) {
        // __callSeq 透传（原因见 mkdirAsync 注释）
        var p = _callAsync('rename', { src: src, dst: dst });
        var out = p.then(function (r) {
            return !!(r && r.ok);
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
     * 复制文件（二进制安全）
     * @param {string} src
     * @param {string} dst
     * @returns {boolean}
     */
    function copyFile(src, dst) {
        var r = _call('copy-file', { src: src, dst: dst });
        return !!(r && r.ok);
    }

    /**
     * 异步复制文件（不阻塞主线程，供批量导入长循环用）
     * @param {string} src
     * @param {string} dst
     * @returns {Promise<boolean>}
     */
    function copyFileAsync(src, dst) {
        // __callSeq 透传（原因见 mkdirAsync 注释）
        var p = _callAsync('copy-file', { src: src, dst: dst });
        var out = p.then(function (r) {
            return !!(r && r.ok);
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
     * 异步拷贝目录（不阻塞主线程，供批量导入长循环用）。
     * 服务端 copy-dir 响应携带 failed（单文件拷贝失败计数），本方法向 AEFS
     * 透传 {copied, failed} 对象（只回 copied 数字时部分失败被静默吞）。
     * 通道失败（网络异常/5xx）或 4xx 真拒绝（_callAsync 记入 getLastAsyncRejection）
     * 均返回 null，由 AEFS 按 rejection 二分决定是否走本地回退。
     * @param {string} src
     * @param {string} dst
     * @returns {Promise<{copied:number, failed:number}|null>} 成功返回统计对象，通道失败 null
     */
    function copyDirAsync(src, dst) {
        // __callSeq 透传（原因见 mkdirAsync 注释）
        var p = _callAsync('copy-dir', { src: src, dst: dst });
        var out = p.then(function (r) {
            if (r && r.ok && typeof r.copied === 'number') {
                return { copied: r.copied, failed: (typeof r.failed === 'number') ? r.failed : 0 };
            }
            return null;
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
     * 重命名目录（仅同目录，原子操作）
     * @param {string} src
     * @param {string} dst
     * @returns {boolean}
     */
    function renameDir(src, dst) {
        var r = _call('rename', { src: src, dst: dst });
        return !!(r && r.ok);
    }

    /**
     * 异步重命名目录（不阻塞主线程）。语义与 renameDir 一致：成功 true，失败 false。
     * @param {string} src
     * @param {string} dst
     * @returns {Promise<boolean>}
     */
    function renameDirAsync(src, dst) {
        // __callSeq 透传（原因见 mkdirAsync 注释）
        var p = _callAsync('rename', { src: src, dst: dst });
        var out = p.then(function (r) {
            return !!(r && r.ok);
        });
        out.__callSeq = p.__callSeq;
        return out;
    }

    /**
     * 读图片文件转 base64（同步，bridge-only，无 cep.fs/ExtendScript 回退）
     * @param {string} path — 图片绝对路径
     * @returns {{success: boolean, base64: string, size: number, mime: string}|null}
     */
    function readImageBase64(path) {
        if (typeof XMLHttpRequest === 'undefined') return null;
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', getBridgeUrl() + '/api/read-image', false);
            xhr.setRequestHeader('Content-Type', 'application/json');
            if (_bridgeToken) xhr.setRequestHeader('Authorization', 'Bearer ' + _bridgeToken);
            xhr.send(JSON.stringify({ filePath: path }));
            if (xhr.status === 200) {
                return JSON.parse(xhr.responseText);
            }
            if (xhr.status === 401) refreshBridgeToken();
        } catch (e) {}
        return null;
    }

    /**
     * 异步读图片文件转 base64（不阻塞主线程）。语义与 readImageBase64 一致：
     * 成功返回 { success, base64, size, mime }，失败返回 null（Promise 形态）。
     * @param {string} path — 图片绝对路径
     * @returns {Promise<object|null>}
     */
    function readImageBase64Async(path) {
        if (typeof fetch !== 'function') return Promise.resolve(null);
        return fetch(getBridgeUrl() + '/api/read-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: path })
        }).then(function (r) {
            if (!r.ok) return null;
            return r.json();
        }).catch(function () {
            return null;  // bridge 不可用/网络异常：调用方回退
        });
    }

    /**
     * 读系统剪贴板（异步，bridge-only，免 Ctrl+V）。
     * bridge 侧 PowerShell(-Sta) 直读：位图 → base64 PNG；Explorer 复制的文件 → 路径数组。
     * @returns {Promise<object|null>}
     *   { ok:true, kind:'image', base64, mime } / { ok:true, kind:'files', files[] } /
     *   { ok:false, error:'empty'|'ps_failed'|... } / null（bridge 不可用，调用方走回退链）
     */
    function readClipboard() {
        if (typeof fetch !== 'function') return Promise.resolve(null);
        return fetch(getBridgeUrl() + '/api/clipboard-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        }).then(function (r) {
            if (!r.ok) return null;   // 5xx/网络层异常 → 视为 bridge 不可用
            return r.json().catch(function () { return null; });
        }).catch(function () {
            return null;   // bridge 未启动/端口不通：吞掉，调用方回退浏览器通道
        });
    }

    /**
     * 解析文档/表格/PDF 为结构化文本（异步，bridge-only）。
     * 供 Agent 拖入文件时把内容注入 <context>，而非仅传路径。
     * @param {string} path — 文件绝对路径
     * @returns {Promise<{ok:boolean, text:string, format:string}|null>}
     *   { ok:true, text, format } / { ok:false, error } / null（bridge 不可用）
     */
    function parseDoc(path) {
        if (typeof fetch !== 'function') return Promise.resolve(null);
        return fetch(getBridgeUrl() + '/api/parse-doc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: path })
        }).then(function (r) {
            return r.json().catch(function () { return null; });
        }).catch(function () {
            return null;   // bridge 未启动/端口不通：吞掉
        });
    }

    // 内容解析通道：不传磁盘路径，把文件内容（base64）直接交给 bridge 解析。
    // CEP 拖拽 File 对象的本地绝对路径（file.path）各环境行为不一（实测当前环境可拿到），
    // 面板侧用 FileReader 读内容后走此端点，绕开路径限制且不落盘，作为无路径场景的兜底。
    function parseDocBytes(name, base64) {
        if (typeof fetch !== 'function') return Promise.resolve(null);
        return fetch(getBridgeUrl() + '/api/parse-doc-bytes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, data: base64 })
        }).then(function (r) {
            return r.json().catch(function () { return null; });
        }).catch(function () {
            return null;   // bridge 未启动/端口不通：吞掉
        });
    }

    // ====== 导出 ======

    global.Bridge = {
        isAvailable: isAvailable,
        // 同步 XHR 门禁（半死桥保护）——AEFS 同步族在发起同步调用前必须查询；
        // false 时一律走 cep.fs 本地通道（见 isSyncSafe 注释与残余风险说明）
        isSyncSafe: isSyncSafe,
        // 供 main.js heartbeat 同步桥可用性缓存（探测权利单一归属 heartbeat）
        setAvailable: _setAvailable,
        // 供 communicationProvider WS onopen 同步「已在线」事实（含实际端口），见 markAvailable 注释
        markAvailable: markAvailable,
        // 异步扫描定位桥实际端口（鉴权探测：跳过 401/403 的残留/他会话实例；桥换端口后由 heartbeat 触发）
        scanPortAsync: scanPortAsync,
        getBridgePort: getBridgePort,
        // 已缓存的端口（未探测，仅读缓存；诊断/回归测试用——getBridgePort 会回退默认端口，
        // 无法区分「无缓存」与「缓存的正是默认端口」）
        getCachedBridgePort: function () { return _cachedPort; },
        getBridgeUrl: getBridgeUrl,
        clearPortCache: clearPortCache,
        waitForReady: waitForReady,
        // 多实例冲突（不支持多实例）：鉴权不符/反复断线时读宿主标记并进冲突态；
        // main.js 覆盖层据此改文案、重试只重扫端口不 restartBridge（见各函数注释）
        checkMultiInstanceConflict: checkMultiInstanceConflict,
        isMultiInstanceConflict: isMultiInstanceConflict,
        getMultiInstanceInfo: getMultiInstanceInfo,
        // H1 修复：bridge token 鉴权——WS 连接前强制刷新（bridge 重启换新 token）
        refreshBridgeToken: refreshBridgeToken,
        // H1 补强：鉴权健康探测（心跳/就绪判定区分「进程在线」与「token 有效」）
        authProbeAsync: authProbeAsync,
        // 同步读缓存的 token（WS URL 拼接用；无缓存返回 null）
        getCachedBridgeToken: function () { return _bridgeToken; },
        // 最近一次同步 _call 的 4xx 拒绝状态（供 AEFS 同步链判断是否回退 cep.fs）
        getLastSyncRejection: getLastSyncRejection,
        // 清空同步拒绝记录（消费方发起判定前调用，保证读取新鲜性）
        clearSyncRejection: clearSyncRejection,
        // 最近一次同步 _call 的 401 记录（token 轮换窗口）——AEFS 同步族
        // 据此硬失败、不回退 cep.fs/ExtendScript
        getLastSyncUnauthorized: getLastSyncUnauthorized,
        // 同步调用统计（关面板耗时埋点用，无行为影响；见 _call 包装注释）
        getSyncCallStats: getSyncCallStats,
        resetSyncCallStats: resetSyncCallStats,
        // 最近一次异步调用的 4xx 拒绝状态（供 AEFS 异步链判断是否走本地回退）
        getLastAsyncRejection: getLastAsyncRejection,
        // 按调用序号消费 4xx 拒绝记录（并发同 method 调用隔离，供 AEFS list 系二分）
        consumeAsyncRejection: consumeAsyncRejection,
        readFile: readFile,
        readFileAsync: readFileAsync,
        writeFile: writeFile,
        writeFileAsync: writeFileAsync,
        writeFileBase64: writeFileBase64,
        writeFileBase64Async: writeFileBase64Async,
        writeBlob: writeBlob,
        readBlob: readBlob,
        mkdir: mkdir,
        mkdirAsync: mkdirAsync,
        listFiles: listFiles,
        listFilesAsync: listFilesAsync,
        listDirs: listDirs,
        listDirsAsync: listDirsAsync,
        listSizesAsync: listSizesAsync,
        deleteFile: deleteFile,
        deleteFileAsync: deleteFileAsync,
        deleteFileRecycleAsync: deleteFileRecycleAsync,   // 优先回收站的删文件
        rmdir: rmdir,
        rmdirAsync: rmdirAsync,
        removeDirRecursive: removeDirRecursive,
        removeDirRecursiveAsync: removeDirRecursiveAsync,
        exists: exists,
        existsAsync: existsAsync,
        existsBatch: existsBatch,
        isFile: isFile,
        isFileAsync: isFileAsync,
        isLinkAsync: isLinkAsync,
        realpathAsync: realpathAsync,
        copyDir: copyDir,
        copyDirAsync: copyDirAsync,
        copyFile: copyFile,
        copyFileAsync: copyFileAsync,
        renameFile: renameFile,
        renameFileAsync: renameFileAsync,
        renameDir: renameDir,
        renameDirAsync: renameDirAsync,
        writeFileLlmAsync: writeFileLlmAsync,
        readImageBase64: readImageBase64,
        readImageBase64Async: readImageBase64Async,
        readClipboard: readClipboard,
        parseDoc: parseDoc,
        parseDocBytes: parseDocBytes,
        // 失败体展示文案：{code, error} → 「本地化一句话: 原文」；无 code 时回原文 error
        failureText: failureText
    };

    console.log('[Bridge] CEP client loaded, available: ' + isAvailable());

    // H1 修复：加载即预热 token（cepBridge.js 先于本文件加载，AEPlatform 已可用）。
    // fire-and-forget——首连 WS / 首个敏感请求前 token 大概率已入缓存；失败（AE 忙）
    // 由 401/WS 拒绝后的刷新重试链自愈。try 包裹：测试沙盒可能缺 Promise/AEPlatform。
    try { refreshBridgeToken(); } catch (_) {}

})(window);
