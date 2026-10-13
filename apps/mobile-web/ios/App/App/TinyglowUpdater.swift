import Foundation
import UIKit
import WebKit
import Capacitor

// Live updates (docs/plans/step-14.md 2.7, task 14.7): the signed OTA web bundle.
//
//   info()                                   -> { nativeVersion, nativeBuild, builtinVersion, currentVersion,
//                                                 currentSource, stagedVersion, androidPushConfigured }
//   stage({ manifestJson, signature, keyId }) -> { outcome, version?, bytes? }
//   notifyAppReady()                          -> cancels the watchdog, marks the running bundle good
//   applyNow()                                -> reloads into the staged bundle (JS checks idle first)
//   reset()                                   -> back to the bundled web, deletes every OTA bundle
//
// Built on Capacitor's own persisted `serverBasePath` (KeyValueStore "serverBasePath", mapped by
// CAPBridgeViewController.instanceDescriptor() to Library/NoCloud/ionic_built_snapshots/<last path
// component>, ignored and cleared on a new binary). `LLUpdater.prepareLaunch()` runs from
// TinyglowViewController.instanceDescriptor(), i.e. before Capacitor reads that key, so the launch
// decision (promote staged, roll back, new binary) and the key always agree.
//
// Never logs: no URL, path, signature, manifest or file name (outcomes travel to JS only).

enum LLUpdater {
    static let serverBasePathKey = "serverBasePath"
    private static let lock = NSLock()
    private static var launchResult = LLLaunch()

    static let store: LLUpdateStore? = {
        guard let lib = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first else { return nil }
        let root = lib.appendingPathComponent("NoCloud", isDirectory: true)
            .appendingPathComponent("ionic_built_snapshots", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return LLUpdateStore(root: root)
    }()

    static var nativeVersion: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "" }
    static var nativeBuild: Int { Int(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "") ?? 0 }
    static var binary: String { "\(nativeVersion)(\(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""))" }
    static var builtinDir: URL? { Bundle.main.url(forResource: "public", withExtension: nil) }

    static let builtinVersion: String? = {
        guard let dir = builtinDir,
              let data = try? Data(contentsOf: dir.appendingPathComponent(LLUpdateRules.manifestPath)),
              let m = LLUpdateRules.parse(data, requireBaseUrl: false) else { return nil }
        return m.version
    }()

    /// Lock-protected read-modify-write of state.json.
    @discardableResult
    static func withState<T>(_ body: (inout LLUpdateState, LLUpdateStore) -> T) -> T? {
        guard let store = store else { return nil }
        lock.lock(); defer { lock.unlock() }
        var s = store.load()
        let before = s
        let result = body(&s, store)
        if s != before { store.save(s) }
        persistKey(s, store)
        return result
    }

    private static func persistKey(_ s: LLUpdateState, _ store: LLUpdateStore) {
        if let v = LLUpdateMachine.nextLaunchVersion(s) {
            KeyValueStore.standard[serverBasePathKey] = store.bundleDir(v).path
        } else {
            KeyValueStore.standard[serverBasePathKey] = nil as String?
        }
    }

    /// Before the WebView exists (TinyglowViewController.instanceDescriptor()).
    static func prepareLaunch() {
        let result = withState { s, store -> LLLaunch in
            let r = LLUpdateMachine.launch(&s, binary: binary, exists: store.hasBundle)
            if r.resetAll {
                store.deleteAllBundles()
            } else {
                if let f = r.failedNow { store.deleteBundle(f) }
                store.prune(keep: LLUpdateMachine.keepSet(s))
            }
            return r
        }
        lock.lock(); launchResult = result ?? LLLaunch(); lock.unlock()
    }

    static var launch: LLLaunch { lock.lock(); defer { lock.unlock() }; return launchResult }

    static func setWatchdogDone() { lock.lock(); launchResult.watchdog = false; lock.unlock() }

    /// Directory the WebView should serve for `version` (nil = bundled web).
    static func servingPath(_ version: String?) -> String? {
        if let v = version, let store = store { return store.bundleDir(v).path }
        return builtinDir?.path
    }
}

@objc(TinyglowUpdaterPlugin)
public class TinyglowUpdaterPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TinyglowUpdaterPlugin"
    public let jsName = "TinyglowUpdater"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notifyAppReady", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyNow", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise),
    ]

    private static let stageQueue = DispatchQueue(label: "app.tinyglow.update.stage", qos: .utility)
    private static let stateQueue = DispatchQueue(label: "app.tinyglow.update.state")

    // Watchdog (main thread only).
    private var armed = false
    private var pendingUntilActive = false
    private var timer: DispatchWorkItem?
    private var loadingObservation: NSKeyValueObservation?
    private var activeObserver: NSObjectProtocol?

    override public func load() {
        if LLUpdater.launch.watchdog { arm() }
        loadingObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] webView, _ in
            guard !webView.isLoading else { return }
            DispatchQueue.main.async { self?.pageFinished() }
        }
        activeObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self, self.armed, self.pendingUntilActive else { return }
            self.pendingUntilActive = false
            self.schedule(LLUpdateRules.readyTimeout)
        }
    }

    deinit {
        loadingObservation?.invalidate()
        if let o = activeObserver { NotificationCenter.default.removeObserver(o) }
    }

    // MARK: watchdog

    private func arm() {
        DispatchQueue.main.async {
            self.armed = true
            self.pendingUntilActive = false
            self.schedule(LLUpdateRules.readyFallbackTimeout)
        }
    }

    private func disarm() {
        armed = false
        pendingUntilActive = false
        timer?.cancel()
        timer = nil
    }

    private func pageFinished() {
        guard armed else { return }
        schedule(LLUpdateRules.readyTimeout)
    }

    private func schedule(_ seconds: TimeInterval) {
        timer?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.expired() }
        timer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    }

    private func expired() {
        guard armed else { return }
        // A suspended app cannot run its JS: wait until it is in the foreground again.
        guard UIApplication.shared.applicationState == .active else { pendingUntilActive = true; return }
        disarm()
        LLUpdater.setWatchdogDone()
        Self.stateQueue.async {
            var failed: String?
            let target = LLUpdater.withState { s, _ -> String? in
                failed = s.current
                return LLUpdateMachine.rollback(&s, exists: { LLUpdater.store?.hasBundle($0) ?? false })
            } ?? nil
            DispatchQueue.main.async {
                self.serve(target)
                Self.stateQueue.async { if let f = failed { LLUpdater.store?.deleteBundle(f) } }
            }
        }
    }

    /// Main thread. Points the WebView at `version` (nil = bundled web) and reloads.
    private func serve(_ version: String?) {
        guard let vc = bridge?.viewController as? CAPBridgeViewController,
              let path = LLUpdater.servingPath(version) else { return }
        vc.setServerBasePath(path: path)
    }

    // MARK: methods

    @objc func info(_ call: CAPPluginCall) {
        Self.stateQueue.async {
            let s = LLUpdater.withState { s, _ in s } ?? LLUpdateState()
            let builtin = LLUpdater.builtinVersion ?? "unknown"
            var staged: Any = NSNull()
            if let st = s.staged { staged = st == LLUpdateRules.builtinMarker ? builtin : st }
            call.resolve([
                "nativeVersion": LLUpdater.nativeVersion,
                "nativeBuild": LLUpdater.nativeBuild,
                "builtinVersion": builtin,
                "currentVersion": s.current ?? builtin,
                "currentSource": s.current == nil ? "builtin" : "ota",
                "stagedVersion": staged,
                "androidPushConfigured": true,
            ])
        }
    }

    @objc func stage(_ call: CAPPluginCall) {
        guard let manifestJson = call.getString("manifestJson"), manifestJson.utf8.count <= 1_048_576,
              let signature = call.getString("signature"),
              let keyId = call.getString("keyId") else { call.reject("bad-args"); return }
        Self.stageQueue.async {
            let (outcome, version, bytes) = Self.runStage(manifestJson: manifestJson, signature: signature, keyId: keyId)
            var ret: [String: Any] = ["outcome": outcome.rawValue]
            if let v = version { ret["version"] = v }
            if let b = bytes { ret["bytes"] = b }
            call.resolve(ret)
        }
    }

    private static func runStage(manifestJson: String, signature: String, keyId: String)
        -> (LLUpdateOutcome, String?, Int64?) {
        guard LLUpdateRules.verifyEnvelope(manifestJson: manifestJson, signature: signature, keyId: keyId,
                                           trusted: LLUpdateKeys.trusted) else { return (.verifyFailed, nil, nil) }
        let json = Data(manifestJson.utf8)
        guard let m = LLUpdateRules.parse(json, requireBaseUrl: true), let store = LLUpdater.store else {
            return (.verifyFailed, nil, nil)
        }
        let decision = stateQueue.sync {
            LLUpdater.withState { s, _ in
                LLUpdateMachine.decide(&s, version: m.version, minNativeBuild: m.minNativeBuildIos,
                                       nativeBuild: LLUpdater.nativeBuild, builtinVersion: LLUpdater.builtinVersion)
            } ?? .done(.network)
        }
        switch decision {
        case .done(let o):
            return (o, m.version, o == .upToDate || o == .alreadyStaged ? 0 : nil)
        case .stageBuiltin:
            stateQueue.sync { LLUpdater.withState { s, _ in s.staged = LLUpdateRules.builtinMarker } }
            return (.staged, m.version, 0)
        case .download:
            break
        }

        // Local sources: the bundled web, then every OTA bundle on disk.
        var sources: [LLUpdateSource] = []
        if let dir = LLUpdater.builtinDir, let src = LLUpdateSource.open(dir) { sources.append(src) }
        let keep = stateQueue.sync { LLUpdater.withState { s, _ in LLUpdateMachine.keepSet(s) } ?? [] }
        for v in keep where store.hasBundle(v) {
            if let src = LLUpdateSource.open(store.bundleDir(v)) { sources.append(src) }
        }
        let plan = LLUpdateStager.plan(m, sources: sources)
        let bytes = plan.remoteBytes

        if let blocked = LLUpdateRules.networkDecision(bytes: bytes, networkFacts()) {
            return (blocked, m.version, bytes)
        }
        let available = (try? store.root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
            .volumeAvailableCapacityForImportantUsage
        guard LLUpdateRules.hasSpace(available: available, needed: m.totalBytes) else { return (.noSpace, m.version, bytes) }

        do {
            try LLUpdateStager.assemble(m, manifestJson: json, plan: plan, store: store, fetch: download)
        } catch LLUpdateStageError.verify {
            return (.verifyFailed, m.version, bytes)
        } catch {
            return (.network, m.version, bytes)
        }
        stateQueue.sync {
            LLUpdater.withState { s, store in
                LLUpdateMachine.commitStaged(&s, version: m.version)
                store.prune(keep: LLUpdateMachine.keepSet(s))
            }
        }
        return (.staged, m.version, bytes)
    }

    private static func networkFacts() -> LLUpdateRules.NetworkFacts {
        let path = LLPhotoSync.shared.latestPath()
        let thermal = ProcessInfo.processInfo.thermalState
        return LLUpdateRules.NetworkFacts(
            online: path?.status == .satisfied,
            expensive: path?.isExpensive ?? true,
            constrained: path?.isConstrained ?? false,
            lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled,
            thermalHot: thermal == .serious || thermal == .critical
        )
    }

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = LLUpdateRules.fileTimeout
        c.timeoutIntervalForResource = LLUpdateRules.fileTimeout
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.httpMaximumConnectionsPerHost = LLUpdateRules.concurrentDownloads
        c.httpAdditionalHeaders = ["Accept-Encoding": "identity"]
        return URLSession(configuration: c)
    }()

    /// Synchronous GET (called from the stager's download operations). Foreground session only.
    private static func download(_ url: URL) throws -> Data {
        var request = URLRequest(url: url)
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        let done = DispatchSemaphore(value: 0)
        var result: Data?
        let task = session.dataTask(with: request) { data, response, error in
            if error == nil, (response as? HTTPURLResponse)?.statusCode == 200 { result = data }
            done.signal()
        }
        task.resume()
        if done.wait(timeout: .now() + LLUpdateRules.fileTimeout + 5) == .timedOut {
            task.cancel()
            throw LLUpdateStageError.network
        }
        guard let data = result else { throw LLUpdateStageError.network }
        return data
    }

    @objc func notifyAppReady(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.disarm() }
        LLUpdater.setWatchdogDone()
        Self.stateQueue.async {
            LLUpdater.withState { s, store in
                LLUpdateMachine.ready(&s)
                store.prune(keep: LLUpdateMachine.keepSet(s))
            }
            call.resolve()
        }
    }

    @objc func applyNow(_ call: CAPPluginCall) {
        Self.stateQueue.async {
            var target: String?
            let changed = LLUpdater.withState { s, store -> Bool in
                guard s.staged != nil else { return false }
                LLUpdateMachine.promoteStaged(&s, exists: store.hasBundle)
                target = s.current
                return true
            } ?? false
            guard changed else { call.resolve(); return }
            let needsWatchdog = LLUpdater.withState { s, _ in s.current.map { !s.good.contains($0) } ?? false } ?? false
            DispatchQueue.main.async {
                if needsWatchdog {
                    self.armed = true
                    self.pendingUntilActive = false
                    self.schedule(LLUpdateRules.readyFallbackTimeout)
                } else {
                    self.disarm()
                }
                self.serve(target)
                call.resolve()
            }
        }
    }

    @objc func reset(_ call: CAPPluginCall) {
        Self.stateQueue.async {
            LLUpdater.withState { s, _ in LLUpdateMachine.reset(&s) }
            DispatchQueue.main.async {
                self.disarm()
                self.serve(nil)
                call.resolve()
                Self.stateQueue.async { LLUpdater.store?.deleteAllBundles() }
            }
        }
    }
}
