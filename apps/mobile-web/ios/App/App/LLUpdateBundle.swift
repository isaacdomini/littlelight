import Foundation
import CryptoKit

// Live updates core (docs/plans/step-14.md 2.7, task 14.7). Foundation + CryptoKit only, so
// `ios/scripts/update-bundle-harness.sh` compiles it on the host without the app or Capacitor.
// Mirrors packages/shared/src/app-update.ts (constants, content id, path and base-URL rules) and
// android/.../update/UpdateBundle.java. Nothing here logs: no URL, path, signature or manifest
// ever reaches a log line.

enum LLUpdateOutcome: String {
    case staged
    case upToDate = "up_to_date"
    case alreadyStaged = "already_staged"
    case nativeTooOld = "native_too_old"
    case wifiRequired = "wifi_required"
    case constrained
    case noSpace = "no_space"
    case network
    case verifyFailed = "verify_failed"
    case rejected
}

struct LLUpdateFile: Equatable {
    let path: String
    let sha256: String
    let size: Int64
}

struct LLUpdateManifest {
    let version: String
    let webVersion: String
    let minNativeBuildIos: Int
    let minNativeBuildAndroid: Int
    let files: [LLUpdateFile]
    let baseUrl: String?
    var totalBytes: Int64 { files.reduce(0) { $0 + $1.size } }
}

enum LLUpdateRules {
    static let schema = 1
    static let maxFiles = 2_000
    static let maxBundleBytes: Int64 = 64 * 1024 * 1024
    static let cellularMaxBytes: Int64 = 2 * 1024 * 1024
    static let freeSpaceMarginBytes: Int64 = 64 * 1024 * 1024
    static let readyTimeout: TimeInterval = 10
    /// Fallback when the first page load is never observed.
    static let readyFallbackTimeout: TimeInterval = 25
    /// Launches of an unconfirmed bundle (killed before `notifyAppReady`) before it counts as failed.
    static let maxBootAttempts = 3
    static let maxFailedRemembered = 20
    static let fileTimeout: TimeInterval = 20
    static let concurrentDownloads = 4
    static let excludePrefixes = ["app-update/", ".well-known/", "email-templates/"]
    static let manifestPath = "app-update/manifest.json"
    /// `staged` marker meaning "the next launch runs the bundled web" (never a valid version).
    static let builtinMarker = "builtin"

    // MARK: hashing and content id

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func sha256Hex(fileAt url: URL) -> (hex: String, size: Int64)? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        var size: Int64 = 0
        while true {
            let chunk = handle.readData(ofLength: 1 << 20)
            if chunk.isEmpty { break }
            size += Int64(chunk.count)
            hasher.update(data: chunk)
        }
        return (hasher.finalize().map { String(format: "%02x", $0) }.joined(), size)
    }

    /// sha256 of the UTF-8 of `"\(path)\n\(sha256)\n"` per file, sorted by path in UTF-16
    /// code-unit order (same as JS `<` and Java `compareTo`), first 16 hex characters.
    static func contentId(_ files: [LLUpdateFile]) -> String {
        let sorted = files.sorted { $0.path.utf16.lexicographicallyPrecedes($1.path.utf16) }
        var text = ""
        for f in sorted { text += f.path + "\n" + f.sha256 + "\n" }
        return String(sha256Hex(Data(text.utf8)).prefix(16))
    }

    // MARK: rules

    static func isVersion(_ s: String) -> Bool { matches(s, "^[0-9a-f]{16}$") }
    static func isSha256(_ s: String) -> Bool { matches(s, "^[0-9a-f]{64}$") }
    static func isWebVersion(_ s: String) -> Bool { matches(s, "^[0-9A-Za-z.+-]{1,32}$") }

    private static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }

    /// Relative, no `..` segment, no NUL (the shared rules), and on the device also no empty or
    /// `.` segment and no backslash, so a path can only name a file inside the bundle directory.
    static func isSafePath(_ p: String) -> Bool {
        guard !p.isEmpty, p.utf16.count <= 512, !p.hasPrefix("/"),
              !p.unicodeScalars.contains("\u{0}"), !p.contains("\\") else { return false }
        for seg in p.split(separator: "/", omittingEmptySubsequences: false) {
            if seg.isEmpty || seg == "." || seg == ".." { return false }
        }
        return true
    }

    static func isExcluded(_ p: String) -> Bool { excludePrefixes.contains { p.hasPrefix($0) } }

    private static let localHttpHosts: Set<String> = ["localhost", "127.0.0.1", "10.0.2.2"]

    /// `http(s)://host[:port][/path]`, no credentials, query, fragment or trailing `/`;
    /// `https` unless the host is localhost / 127.0.0.1 / 10.0.2.2 (`isAppUpdateBaseUrl`).
    static func isValidBaseUrl(_ s: String) -> Bool {
        guard !s.contains("?"), !s.contains("#"), !s.hasSuffix("/"),
              let c = URLComponents(string: s), let scheme = c.scheme?.lowercased(),
              let host = c.host?.lowercased(), !host.isEmpty,
              c.user == nil, c.password == nil else { return false }
        if scheme == "https" { return true }
        return scheme == "http" && localHttpHosts.contains(host)
    }

    /// `encodeURIComponent` per segment, joined with `/` (`appUpdateFileUrl`).
    static func fileURL(base: String, path: String) -> URL? {
        var allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        allowed.insert(charactersIn: "-_.!~*'()")
        var encoded: [String] = []
        for seg in path.split(separator: "/", omittingEmptySubsequences: false) {
            guard let e = String(seg).addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
            encoded.append(e)
        }
        return URL(string: base + "/" + encoded.joined(separator: "/"))
    }

    // MARK: signature

    /// ECDSA P-256 / SHA-256, DER signature, SPKI DER key (both standard base64).
    static func verifySignature(message: Data, signatureBase64: String, spkiBase64: String) -> Bool {
        guard let sigDer = Data(base64Encoded: signatureBase64), sigDer.count <= 72,
              let spki = Data(base64Encoded: spkiBase64),
              let key = try? P256.Signing.PublicKey(derRepresentation: spki),
              let sig = try? P256.Signing.ECDSASignature(derRepresentation: sigDer) else { return false }
        return key.isValidSignature(sig, for: message)
    }

    /// `keyId` selects one trusted key; an unknown id or a bad signature is false.
    static func verifyEnvelope(manifestJson: String, signature: String, keyId: String,
                               trusted: [String: String]) -> Bool {
        guard let spki = trusted[keyId] else { return false }
        return verifySignature(message: Data(manifestJson.utf8), signatureBase64: signature, spkiBase64: spki)
    }

    // MARK: parsing

    private static func int(_ any: Any?) -> Int64? {
        guard let n = any as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d.rounded() == d, abs(d) <= 9_007_199_254_740_991 else { return nil }
        return n.int64Value
    }

    /// Strict parse of a manifest (`requireBaseUrl`: the signed envelope; else the builtin
    /// `public/app-update/manifest.json`). Also checks that `version` is the content id of `files`.
    static func parse(_ data: Data, requireBaseUrl: Bool) -> LLUpdateManifest? {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              int(obj["schema"]) == Int64(schema),
              let version = obj["version"] as? String, isVersion(version),
              let webVersion = obj["webVersion"] as? String, isWebVersion(webVersion),
              let mnb = obj["minNativeBuild"] as? [String: Any],
              let minIos = int(mnb["ios"]), minIos >= 1, minIos <= Int64(Int32.max),
              let minAndroid = int(mnb["android"]), minAndroid >= 1, minAndroid <= Int64(Int32.max),
              obj["builtAt"] is String,
              let rawFiles = obj["files"] as? [Any], !rawFiles.isEmpty, rawFiles.count <= maxFiles else { return nil }
        var baseUrl: String?
        if requireBaseUrl {
            guard let b = obj["baseUrl"] as? String, isValidBaseUrl(b) else { return nil }
            baseUrl = b
        }
        var files: [LLUpdateFile] = []
        var seen = Set<String>()
        var total: Int64 = 0
        for raw in rawFiles {
            guard let f = raw as? [String: Any],
                  let path = f["path"] as? String, isSafePath(path), !isExcluded(path),
                  let sha = f["sha256"] as? String, isSha256(sha),
                  let size = int(f["size"]), size >= 0, size <= maxBundleBytes,
                  !seen.contains(path) else { return nil }
            seen.insert(path)
            total += size
            files.append(LLUpdateFile(path: path, sha256: sha, size: size))
        }
        guard seen.contains("index.html"), total <= maxBundleBytes, contentId(files) == version else { return nil }
        return LLUpdateManifest(version: version, webVersion: webVersion, minNativeBuildIos: Int(minIos),
                                minNativeBuildAndroid: Int(minAndroid), files: files, baseUrl: baseUrl)
    }

    // MARK: network policy (D4)

    struct NetworkFacts {
        var online: Bool
        var expensive: Bool      // cellular / personal hotspot (NWPath.isExpensive)
        var constrained: Bool    // Low Data Mode (NWPath.isConstrained)
        var lowPower: Bool
        var thermalHot: Bool     // .serious or .critical
    }

    /// nil = go ahead. Only consulted when bytes have to be downloaded.
    static func networkDecision(bytes: Int64, _ n: NetworkFacts) -> LLUpdateOutcome? {
        guard bytes > 0 else { return nil }
        if n.constrained || n.lowPower || n.thermalHot { return .constrained }
        if !n.online { return .network }
        if n.expensive && bytes > cellularMaxBytes { return .wifiRequired }
        return nil
    }

    static func hasSpace(available: Int64?, needed: Int64) -> Bool {
        guard let available = available else { return false }
        return available >= needed + freeSpaceMarginBytes
    }
}

// MARK: - State (`<bundles>/state.json`)

/// No URLs, no timestamps, no identifiers: version ids and counters only.
struct LLUpdateState: Codable, Equatable {
    /// "<CFBundleShortVersionString>(<CFBundleVersion>)" the state belongs to; another value = new binary.
    var binary: String = ""
    /// OTA version this process runs (nil = the bundled web).
    var current: String?
    /// Version (or `builtinMarker`) the next launch switches to.
    var staged: String?
    /// Last good version before `current` (rollback target).
    var previous: String?
    var good: [String] = []
    var failed: [String] = []
    /// Launches of `current` without `notifyAppReady` (crash/kill protection besides the watchdog).
    var attempts: Int = 0
}

struct LLLaunch: Equatable {
    var resetAll = false
    var active: String?
    var watchdog = false
    var failedNow: String?
}

enum LLUpdateDecision: Equatable {
    case done(LLUpdateOutcome)
    case stageBuiltin
    case download
}

enum LLUpdateMachine {
    /// Runs once per WebView start, before Capacitor reads the persisted path.
    static func launch(_ s: inout LLUpdateState, binary: String, exists: (String) -> Bool) -> LLLaunch {
        var out = LLLaunch()
        if s.binary != binary {
            // New native binary (Capacitor drops the persisted path too): start from the bundled web.
            let failed = s.failed
            s = LLUpdateState()
            s.binary = binary
            s.failed = failed
            out.resetAll = true
            return out
        }
        promoteStaged(&s, exists: exists)
        if let cur = s.current, !exists(cur) {
            s.current = fallback(s, exists: exists)
            s.previous = nil
            s.attempts = 0
        }
        if let cur = s.current, !s.good.contains(cur) {
            s.attempts += 1
            if s.attempts > LLUpdateRules.maxBootAttempts {
                out.failedNow = cur
                _ = rollback(&s, exists: exists)
            }
        }
        out.active = s.current
        out.watchdog = s.current.map { !s.good.contains($0) } ?? false
        return out
    }

    private static func fallback(_ s: LLUpdateState, exists: (String) -> Bool) -> String? {
        if let p = s.previous, p != s.current, s.good.contains(p), exists(p) { return p }
        return nil
    }

    /// staged -> current (launch and `applyNow`). Returns whether anything changed.
    @discardableResult
    static func promoteStaged(_ s: inout LLUpdateState, exists: (String) -> Bool) -> Bool {
        guard let st = s.staged else { return false }
        s.staged = nil
        if st == LLUpdateRules.builtinMarker {
            if let cur = s.current, s.good.contains(cur) { s.previous = cur }
            s.current = nil
            s.attempts = 0
            return true
        }
        guard exists(st) else { return true }
        if let cur = s.current, s.good.contains(cur), cur != st { s.previous = cur }
        s.current = st
        s.attempts = 0
        return true
    }

    static func ready(_ s: inout LLUpdateState) {
        s.attempts = 0
        if let cur = s.current, !s.good.contains(cur) { s.good.append(cur) }
        let keep = keepSet(s)
        s.good = s.good.filter { keep.contains($0) }
    }

    /// Watchdog expiry or too many unconfirmed launches: `current` joins `failed`; returns the
    /// rollback target (previous good version, or nil = the bundled web).
    @discardableResult
    static func rollback(_ s: inout LLUpdateState, exists: (String) -> Bool) -> String? {
        guard let cur = s.current else { return nil }
        if !s.failed.contains(cur) { s.failed.append(cur) }
        if s.failed.count > LLUpdateRules.maxFailedRemembered {
            s.failed.removeFirst(s.failed.count - LLUpdateRules.maxFailedRemembered)
        }
        s.good.removeAll { $0 == cur }
        if s.staged == cur { s.staged = nil }
        let target = fallback(s, exists: exists)
        s.current = target
        s.previous = nil
        s.attempts = 0
        return target
    }

    /// Order of 2.7 after signature/parse: native_too_old, rejected, up_to_date, already_staged.
    static func decide(_ s: inout LLUpdateState, version: String, minNativeBuild: Int, nativeBuild: Int,
                       builtinVersion: String?) -> LLUpdateDecision {
        if minNativeBuild > nativeBuild { return .done(.nativeTooOld) }
        if s.failed.contains(version) { return .done(.rejected) }
        let running = s.current ?? builtinVersion
        if version == running {
            s.staged = nil   // the server went back to what runs now: drop a pending switch
            return .done(.upToDate)
        }
        if version == s.staged { return .done(.alreadyStaged) }
        if version == builtinVersion {
            if s.staged == LLUpdateRules.builtinMarker { return .done(.alreadyStaged) }
            return .stageBuiltin
        }
        return .download
    }

    static func commitStaged(_ s: inout LLUpdateState, version: String) { s.staged = version }

    /// Version the persisted Capacitor path must point at (nil = bundled web).
    static func nextLaunchVersion(_ s: LLUpdateState) -> String? {
        if let st = s.staged { return st == LLUpdateRules.builtinMarker ? nil : st }
        return s.current
    }

    /// Bundles to keep on disk: current + previous (+ staged until the next launch).
    static func keepSet(_ s: LLUpdateState) -> Set<String> {
        var k = Set<String>()
        for v in [s.current, s.previous, s.staged] { if let v = v, v != LLUpdateRules.builtinMarker { k.insert(v) } }
        return k
    }

    /// "Reset app files": back to the bundled web; `failed` is kept so a broken bundle is not re-offered.
    static func reset(_ s: inout LLUpdateState) {
        let binary = s.binary, failed = s.failed
        s = LLUpdateState()
        s.binary = binary
        s.failed = failed
    }
}

// MARK: - File layout

/// `<root>/<version>/` (complete bundles, each with `app-update/manifest.json`), `<root>/tmp-<version>/`
/// (being assembled) and `<root>/state.json`. On iOS root = `Library/NoCloud/ionic_built_snapshots`.
final class LLUpdateStore {
    let root: URL
    private let fm = FileManager.default

    init(root: URL) { self.root = root }

    func bundleDir(_ version: String) -> URL { root.appendingPathComponent(version, isDirectory: true) }
    private var stateURL: URL { root.appendingPathComponent("state.json") }

    func load() -> LLUpdateState {
        guard let data = try? Data(contentsOf: stateURL),
              let s = try? JSONDecoder().decode(LLUpdateState.self, from: data) else { return LLUpdateState() }
        return s
    }

    func save(_ s: LLUpdateState) {
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(s) else { return }
        try? data.write(to: stateURL, options: .atomic)
    }

    func hasBundle(_ version: String) -> Bool {
        guard LLUpdateRules.isVersion(version) else { return false }
        let dir = bundleDir(version)
        return fm.fileExists(atPath: dir.appendingPathComponent("index.html").path)
            && fm.fileExists(atPath: dir.appendingPathComponent(LLUpdateRules.manifestPath).path)
    }

    /// Deletes version directories outside `keep` and `tmp-*` older than `tmpMaxAge`.
    func prune(keep: Set<String>, now: Date = Date(), tmpMaxAge: TimeInterval = 86_400) {
        guard let entries = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        for url in entries {
            let name = url.lastPathComponent
            if LLUpdateRules.isVersion(name) {
                if !keep.contains(name) { try? fm.removeItem(at: url) }
            } else if name.hasPrefix("tmp-") {
                let mod = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                if now.timeIntervalSince(mod) >= tmpMaxAge { try? fm.removeItem(at: url) }
            }
        }
    }

    func deleteAllBundles() {
        guard let entries = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for url in entries where url.lastPathComponent != "state.json" { try? fm.removeItem(at: url) }
    }

    func deleteBundle(_ version: String) {
        guard LLUpdateRules.isVersion(version) else { return }
        try? fm.removeItem(at: bundleDir(version))
    }
}

// MARK: - Staging

/// A directory holding a web build plus its `app-update/manifest.json` (the bundled `public/` or an OTA bundle).
struct LLUpdateSource {
    let dir: URL
    let bySha: [String: String]   // sha256 -> path

    static func open(_ dir: URL) -> LLUpdateSource? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent(LLUpdateRules.manifestPath)),
              let m = LLUpdateRules.parse(data, requireBaseUrl: false) else { return nil }
        var map: [String: String] = [:]
        for f in m.files where map[f.sha256] == nil { map[f.sha256] = f.path }
        return LLUpdateSource(dir: dir, bySha: map)
    }
}

enum LLUpdateStageError: Error { case network, verify, io }

enum LLUpdateStager {
    struct Plan {
        var local: [(LLUpdateFile, URL)] = []
        var remote: [LLUpdateFile] = []
        var remoteBytes: Int64 { remote.reduce(0) { $0 + $1.size } }
    }

    /// Files already on the device (same sha256 in a source) are copied; the rest download.
    static func plan(_ m: LLUpdateManifest, sources: [LLUpdateSource]) -> Plan {
        var p = Plan()
        for f in m.files {
            if let (src, path) = sources.lazy.compactMap({ s in s.bySha[f.sha256].map { (s, $0) } }).first {
                p.local.append((f, src.dir.appendingPathComponent(path)))
            } else {
                p.remote.append(f)
            }
        }
        return p
    }

    /// Builds `<root>/tmp-<version>/`, verifies every file's sha256 and size, then renames it to
    /// `<root>/<version>/`. Nothing partial is ever left under a version name.
    static func assemble(_ m: LLUpdateManifest, manifestJson: Data, plan: Plan, store: LLUpdateStore,
                         fetch: @escaping (URL) throws -> Data) throws {
        let fm = FileManager.default
        guard let base = m.baseUrl else { throw LLUpdateStageError.verify }
        let tmp = store.root.appendingPathComponent("tmp-" + m.version, isDirectory: true)
        try? fm.removeItem(at: tmp)
        do {
            try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
            func target(_ f: LLUpdateFile) throws -> URL {
                let url = tmp.appendingPathComponent(f.path)
                guard url.standardizedFileURL.path.hasPrefix(tmp.standardizedFileURL.path + "/") else { throw LLUpdateStageError.verify }
                try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                return url
            }
            func ok(_ url: URL, _ f: LLUpdateFile) -> Bool {
                guard let h = LLUpdateRules.sha256Hex(fileAt: url) else { return false }
                return h.hex == f.sha256 && h.size == f.size
            }
            var remote = plan.remote
            for (f, src) in plan.local {
                let dst = try target(f)
                try? fm.removeItem(at: dst)
                if (try? fm.copyItem(at: src, to: dst)) != nil, ok(dst, f) { continue }
                try? fm.removeItem(at: dst)
                remote.append(f)   // local copy unreadable or changed: download it instead
            }
            // Downloads, `concurrentDownloads` in flight; the first failure cancels the rest.
            let queue = OperationQueue()
            queue.maxConcurrentOperationCount = LLUpdateRules.concurrentDownloads
            let lock = NSLock()
            var failure: LLUpdateStageError?
            for f in remote {
                let dst = try target(f)
                queue.addOperation {
                    lock.lock(); let stop = failure != nil; lock.unlock()
                    if stop { return }
                    var err: LLUpdateStageError?
                    if let url = LLUpdateRules.fileURL(base: base, path: f.path), let data = try? fetch(url) {
                        if Int64(data.count) != f.size || LLUpdateRules.sha256Hex(data) != f.sha256 {
                            err = .verify
                        } else if (try? data.write(to: dst)) == nil {
                            err = .io
                        }
                    } else {
                        err = .network
                    }
                    if let e = err {
                        lock.lock(); if failure == nil { failure = e }; lock.unlock()
                        queue.cancelAllOperations()
                    }
                }
            }
            queue.waitUntilAllOperationsAreFinished()
            if let e = failure { throw e }
            // Bytes as stored, once more, then the bundle's identity.
            for f in remote where !ok(tmp.appendingPathComponent(f.path), f) { throw LLUpdateStageError.verify }
            let mdir = tmp.appendingPathComponent("app-update", isDirectory: true)
            try fm.createDirectory(at: mdir, withIntermediateDirectories: true)
            try manifestJson.write(to: mdir.appendingPathComponent("manifest.json"))
            let dest = store.bundleDir(m.version)
            try? fm.removeItem(at: dest)
            try fm.moveItem(at: tmp, to: dest)
        } catch {
            try? fm.removeItem(at: tmp)
            throw (error as? LLUpdateStageError) ?? LLUpdateStageError.io
        }
    }
}
