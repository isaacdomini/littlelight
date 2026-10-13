import Foundation

// Host-side test of LLUpdateBundle.swift + LLUpdateKeys.swift (docs/plans/step-14.md 2.7, 14.7):
// content id vectors (shared JSDoc), path and base-URL rules, file URLs, signature verification
// (dev key, tamper, key selection), manifest parsing, minNativeBuild, the launch/stage/rollback
// state machine, staging (local reuse, download, tampered file, network failure) and pruning.
// Compiled twice by update-bundle-harness.sh: with -D DEBUG (full run) and without (Release:
// the dev key must not be trusted). Args: vector files (fixture, then e2e/ota/vectors.json if any).

var failures = 0
func check(_ name: String, _ ok: Bool) {
    print("\(ok ? "PASS" : "FAIL") \(name)")
    if !ok { failures += 1 }
}

let E = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
func F(_ p: String, _ s: String, _ n: Int64 = 0) -> LLUpdateFile { LLUpdateFile(path: p, sha256: s, size: n) }

struct Vectors {
    let name: String
    let keyId: String
    let spki: String?
    let manifestJson: String
    let signature: String
    let expectedVersion: String?
    let files: [String: Data]
    let tampered: (String, String)?
    let tamperedFile: (String, Data)?

    static func load(_ path: String) -> Vectors? {
        guard let data = FileManager.default.contents(atPath: path),
              let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let mj = o["manifestJson"] as? String, let sig = o["signature"] as? String else { return nil }
        var files: [String: Data] = [:]
        for (k, v) in (o["files"] as? [String: String]) ?? [:] { files[k] = Data(base64Encoded: v) }
        var tampered: (String, String)?
        if let t = o["tampered"] as? [String: Any], let tm = t["manifestJson"] as? String {
            tampered = (tm, (t["signature"] as? String) ?? sig)
        }
        var tf: (String, Data)?
        if let t = o["tamperedFile"] as? [String: Any], let p = t["path"] as? String,
           let c = (t["contentBase64"] as? String).flatMap({ Data(base64Encoded: $0) }) { tf = (p, c) }
        return Vectors(name: (path as NSString).lastPathComponent, keyId: (o["keyId"] as? String) ?? "dev",
                       spki: o["spkiBase64"] as? String, manifestJson: mj, signature: sig,
                       expectedVersion: o["expectedVersion"] as? String, files: files, tampered: tampered, tamperedFile: tf)
    }
}

let vectorPaths = Array(CommandLine.arguments.dropFirst())
let vectors = vectorPaths.compactMap(Vectors.load)
check("vector files load (\(vectorPaths.count))", !vectors.isEmpty && vectors.count == vectorPaths.count)

#if DEBUG
print("-- Debug build: dev key trusted")
#else
print("-- Release build: dev key must not be trusted")
for v in vectors {
    check("[\(v.name)] release: dev-signed manifest rejected",
          !LLUpdateRules.verifyEnvelope(manifestJson: v.manifestJson, signature: v.signature, keyId: v.keyId, trusted: LLUpdateKeys.trusted))
}
check("release: only the prod key is trusted", Array(LLUpdateKeys.trusted.keys) == ["prod-2026-10"])
exit(failures == 0 ? 0 : 1)
#endif

#if DEBUG
// ---- content id (packages/shared/src/app-update.ts JSDoc vectors)
check("content id: index.html + empty hash", LLUpdateRules.contentId([F("index.html", E)]) == "da529e6871940b56")
let v2 = [F("index.html", "b633a587c652d02386c4f16f8c6f6aab7352d97f16367c3c40576214372dd628"),
          F("assets/app-1.js", "0a286891c11c056e1ab5bfc25bf5d6b2f5b06d38eac10944f678fd8a2e70c393")]
check("content id: two files", LLUpdateRules.contentId(v2) == "2f80d966699add55")
check("content id: order independent", LLUpdateRules.contentId(v2.reversed()) == "2f80d966699add55")
let v3 = [F("index.html", String(repeating: "0", count: 64)), F("Z.txt", String(repeating: "1", count: 64)),
          F("a.txt", String(repeating: "2", count: 64))]
check("content id: code-unit order Z < a < index", LLUpdateRules.contentId(v3) == "0d576c52526db35a")
check("sha256 of empty", LLUpdateRules.sha256Hex(Data()) == E)

// ---- path rules
for p in ["index.html", "assets/app-1.js", "a b/c+d.js", "x/.hidden", "é/ü.txt"] { check("path ok: \(p)", LLUpdateRules.isSafePath(p)) }
for p in ["", "/index.html", "../x", "a/../b", "a/..", "..", "a\u{0}b", "a//b", "./a", "a/./b", "a\\b", "a/", String(repeating: "a", count: 513)] {
    check("path refused: \(p.debugDescription.prefix(40))", !LLUpdateRules.isSafePath(p))
}
check("excluded prefixes", LLUpdateRules.isExcluded("app-update/manifest.json") && LLUpdateRules.isExcluded(".well-known/apple-app-site-association")
      && LLUpdateRules.isExcluded("email-templates/x.html") && !LLUpdateRules.isExcluded("assets/app-update/x.js"))

// ---- base URL and file URLs
for u in ["https://tinyglow.app", "https://tinyglow.app/web", "http://localhost:18090", "http://10.0.2.2:18090", "http://127.0.0.1"] {
    check("baseUrl ok: \(u)", LLUpdateRules.isValidBaseUrl(u))
}
for u in ["http://tinyglow.app", "https://tinyglow.app/", "https://tinyglow.app?x=1", "https://tinyglow.app#f", "https://u:p@tinyglow.app", "ftp://tinyglow.app", "tinyglow.app", ""] {
    check("baseUrl refused: \(u)", !LLUpdateRules.isValidBaseUrl(u))
}
check("file URL: plain", LLUpdateRules.fileURL(base: "https://tinyglow.app", path: "assets/app-1.js")?.absoluteString == "https://tinyglow.app/assets/app-1.js")
check("file URL: encodeURIComponent per segment",
      LLUpdateRules.fileURL(base: "https://h.test/web", path: "assets/a b+c.js")?.absoluteString == "https://h.test/web/assets/a%20b%2Bc.js")
check("file URL: unreserved kept, unicode encoded",
      LLUpdateRules.fileURL(base: "https://h.test", path: "x/(a)!~*'-_.é")?.absoluteString == "https://h.test/x/(a)!~*'-_.%C3%A9")

// ---- network policy (D4)
let wifi = LLUpdateRules.NetworkFacts(online: true, expensive: false, constrained: false, lowPower: false, thermalHot: false)
var cell = wifi; cell.expensive = true
var lowData = wifi; lowData.constrained = true
var lowPower = wifi; lowPower.lowPower = true
var hot = wifi; hot.thermalHot = true
var offline = wifi; offline.online = false
check("net: nothing to download needs no network", LLUpdateRules.networkDecision(bytes: 0, offline) == nil && LLUpdateRules.networkDecision(bytes: 0, lowData) == nil)
check("net: wifi any size", LLUpdateRules.networkDecision(bytes: 60 << 20, wifi) == nil)
check("net: cellular <= 2 MiB ok", LLUpdateRules.networkDecision(bytes: 2 << 20, cell) == nil)
check("net: cellular > 2 MiB -> wifi_required", LLUpdateRules.networkDecision(bytes: (2 << 20) + 1, cell) == .wifiRequired)
check("net: low data / low power / hot -> constrained", [lowData, lowPower, hot].allSatisfy { LLUpdateRules.networkDecision(bytes: 1, $0) == .constrained })
check("net: offline -> network", LLUpdateRules.networkDecision(bytes: 1, offline) == .network)
check("space: needs bytes + 64 MiB", LLUpdateRules.hasSpace(available: (64 << 20) + 10, needed: 10) && !LLUpdateRules.hasSpace(available: (64 << 20) + 9, needed: 10) && !LLUpdateRules.hasSpace(available: nil, needed: 0))

// ---- manifest parsing
func manifestJSON(_ files: [[String: Any]], version: String? = nil, schema: Any = 1, baseUrl: String? = "https://tinyglow.app",
                  minIos: Any = 1, extra: [String: Any] = [:]) -> Data {
    let lf = files.compactMap { f -> LLUpdateFile? in
        guard let p = f["path"] as? String, let s = f["sha256"] as? String else { return nil }
        return F(p, s)
    }
    var o: [String: Any] = ["schema": schema, "version": version ?? LLUpdateRules.contentId(lf), "webVersion": "1.0.0",
                            "minNativeBuild": ["ios": minIos, "android": 1], "builtAt": "2026-10-13T00:00:00.000Z", "files": files]
    if let b = baseUrl { o["baseUrl"] = b }
    for (k, v) in extra { o[k] = v }
    return try! JSONSerialization.data(withJSONObject: o)
}
let goodFiles: [[String: Any]] = [["path": "index.html", "sha256": E, "size": 0], ["path": "assets/a.js", "sha256": String(repeating: "a", count: 64), "size": 10]]
check("parse: good manifest", LLUpdateRules.parse(manifestJSON(goodFiles), requireBaseUrl: true)?.totalBytes == 10)
check("parse: builtin needs no baseUrl", LLUpdateRules.parse(manifestJSON(goodFiles, baseUrl: nil), requireBaseUrl: false) != nil)
check("parse: signed needs baseUrl", LLUpdateRules.parse(manifestJSON(goodFiles, baseUrl: nil), requireBaseUrl: true) == nil)
check("parse: http baseUrl refused", LLUpdateRules.parse(manifestJSON(goodFiles, baseUrl: "http://tinyglow.app"), requireBaseUrl: true) == nil)
check("parse: version must be the content id", LLUpdateRules.parse(manifestJSON(goodFiles, version: "0123456789abcdef"), requireBaseUrl: true) == nil)
check("parse: schema 2 refused", LLUpdateRules.parse(manifestJSON(goodFiles, schema: 2), requireBaseUrl: true) == nil)
check("parse: bool schema refused", LLUpdateRules.parse(manifestJSON(goodFiles, schema: true), requireBaseUrl: true) == nil)
check("parse: minNativeBuild 0 refused", LLUpdateRules.parse(manifestJSON(goodFiles, minIos: 0), requireBaseUrl: true) == nil)
check("parse: minNativeBuild 1.5 refused", LLUpdateRules.parse(manifestJSON(goodFiles, minIos: 1.5), requireBaseUrl: true) == nil)
func refused(_ name: String, _ files: [[String: Any]]) { check("parse refused: \(name)", LLUpdateRules.parse(manifestJSON(files), requireBaseUrl: true) == nil) }
refused("no index.html", [["path": "a.html", "sha256": E, "size": 0]])
refused("duplicate path", goodFiles + [["path": "assets/a.js", "sha256": E, "size": 0]])
refused("excluded prefix", goodFiles + [["path": ".well-known/assetlinks.json", "sha256": E, "size": 0]])
refused("manifest path listed", goodFiles + [["path": "app-update/manifest.json", "sha256": E, "size": 0]])
refused("..", goodFiles + [["path": "assets/../../etc", "sha256": E, "size": 0]])
refused("absolute", goodFiles + [["path": "/etc/passwd", "sha256": E, "size": 0]])
refused("NUL", goodFiles + [["path": "a\u{0}.js", "sha256": E, "size": 0]])
refused("uppercase sha", goodFiles + [["path": "b.js", "sha256": E.uppercased(), "size": 0]])
refused("negative size", goodFiles + [["path": "b.js", "sha256": E, "size": -1]])
refused("bool size", goodFiles + [["path": "b.js", "sha256": E, "size": true]])
refused("file over 64 MiB", goodFiles + [["path": "b.js", "sha256": E, "size": (64 << 20) + 1]])
refused("total over 64 MiB", goodFiles + [["path": "b.js", "sha256": E, "size": 64 << 20]])
refused("over 2000 files", [["path": "index.html", "sha256": E, "size": 0]] + (0..<2000).map { ["path": "f\($0)", "sha256": E, "size": 0] })
check("parse: 2000 files ok", LLUpdateRules.parse(manifestJSON([["path": "index.html", "sha256": E, "size": 0]] + (0..<1999).map { ["path": "f\($0)", "sha256": E, "size": 0] }), requireBaseUrl: true) != nil)
check("parse: not JSON", LLUpdateRules.parse(Data("{".utf8), requireBaseUrl: false) == nil)

// ---- signature (vectors)
for v in vectors {
    let n = v.name
    if let spki = v.spki { check("[\(n)] vector key is the compiled-in dev key", spki == LLUpdateKeys.trusted["dev"]) }
    check("[\(n)] signature verifies", LLUpdateRules.verifyEnvelope(manifestJson: v.manifestJson, signature: v.signature, keyId: v.keyId, trusted: LLUpdateKeys.trusted))
    check("[\(n)] wrong keyId (prod) -> fails", !LLUpdateRules.verifyEnvelope(manifestJson: v.manifestJson, signature: v.signature, keyId: "prod-2026-10", trusted: LLUpdateKeys.trusted))
    check("[\(n)] unknown keyId -> fails", !LLUpdateRules.verifyEnvelope(manifestJson: v.manifestJson, signature: v.signature, keyId: "nope", trusted: LLUpdateKeys.trusted))
    if let (tm, ts) = v.tampered {
        check("[\(n)] tampered manifest -> fails", !LLUpdateRules.verifyEnvelope(manifestJson: tm, signature: ts, keyId: v.keyId, trusted: LLUpdateKeys.trusted))
    }
    var flipped = Data(v.manifestJson.utf8); flipped[flipped.count / 2] ^= 0x01
    check("[\(n)] one flipped byte -> fails", !LLUpdateRules.verifySignature(message: flipped, signatureBase64: v.signature, spkiBase64: LLUpdateKeys.trusted["dev"]!))
    var sig = Data(base64Encoded: v.signature)!; sig[sig.count - 1] ^= 0x01
    check("[\(n)] flipped signature byte -> fails", !LLUpdateRules.verifySignature(message: Data(v.manifestJson.utf8), signatureBase64: sig.base64EncodedString(), spkiBase64: LLUpdateKeys.trusted["dev"]!))
    check("[\(n)] garbage signature -> fails", !LLUpdateRules.verifyEnvelope(manifestJson: v.manifestJson, signature: "AAAA", keyId: v.keyId, trusted: LLUpdateKeys.trusted))
    let m = LLUpdateRules.parse(Data(v.manifestJson.utf8), requireBaseUrl: true)
    check("[\(n)] manifest parses", m != nil)
    if let e = v.expectedVersion { check("[\(n)] version == expected content id", m?.version == e) }
}

// ---- state machine
let all: (String) -> Bool = { _ in true }
let none: (String) -> Bool = { _ in false }
let A = "aaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbb", C = "cccccccccccccccc", BUILTIN = "1111111111111111"
var s = LLUpdateState()
var l = LLUpdateMachine.launch(&s, binary: "1.0.0(1)", exists: all)
check("sm: first launch = new binary, builtin", l.resetAll && l.active == nil && !l.watchdog && s.binary == "1.0.0(1)")
check("sm: decide too old", LLUpdateMachine.decide(&s, version: B, minNativeBuild: 2, nativeBuild: 1, builtinVersion: BUILTIN) == .done(.nativeTooOld))
check("sm: decide builtin == running -> up_to_date", LLUpdateMachine.decide(&s, version: BUILTIN, minNativeBuild: 1, nativeBuild: 1, builtinVersion: BUILTIN) == .done(.upToDate))
check("sm: decide B -> download", LLUpdateMachine.decide(&s, version: B, minNativeBuild: 1, nativeBuild: 1, builtinVersion: BUILTIN) == .download)
LLUpdateMachine.commitStaged(&s, version: B)
check("sm: next launch path = B", LLUpdateMachine.nextLaunchVersion(s) == B)
check("sm: decide B again -> already_staged", LLUpdateMachine.decide(&s, version: B, minNativeBuild: 1, nativeBuild: 1, builtinVersion: BUILTIN) == .done(.alreadyStaged))
l = LLUpdateMachine.launch(&s, binary: "1.0.0(1)", exists: all)
check("sm: relaunch promotes B with watchdog", l.active == B && l.watchdog && s.current == B && s.staged == nil && s.attempts == 1)
LLUpdateMachine.ready(&s)
check("sm: ready marks B good", s.good == [B] && s.attempts == 0)
l = LLUpdateMachine.launch(&s, binary: "1.0.0(1)", exists: all)
check("sm: good bundle -> no watchdog", l.active == B && !l.watchdog)
check("sm: decide B while on B -> up_to_date", LLUpdateMachine.decide(&s, version: B, minNativeBuild: 1, nativeBuild: 1, builtinVersion: BUILTIN) == .done(.upToDate))
LLUpdateMachine.commitStaged(&s, version: C)
l = LLUpdateMachine.launch(&s, binary: "1.0.0(1)", exists: all)
check("sm: C promoted, previous = B", l.active == C && l.watchdog && s.previous == B)
check("sm: keep set = {B, C}", LLUpdateMachine.keepSet(s) == [B, C])
let target = LLUpdateMachine.rollback(&s, exists: all)
check("sm: watchdog rollback -> B, C failed", target == B && s.current == B && s.failed == [C] && s.previous == nil && LLUpdateMachine.nextLaunchVersion(s) == B)
check("sm: C never re-offered -> rejected", LLUpdateMachine.decide(&s, version: C, minNativeBuild: 1, nativeBuild: 1, builtinVersion: BUILTIN) == .done(.rejected))
l = LLUpdateMachine.launch(&s, binary: "1.0.0(1)", exists: all)
check("sm: relaunch after rollback stays on B", l.active == B && !l.watchdog)
// up_to_date clears a pending switch
LLUpdateMachine.commitStaged(&s, version: A)
check("sm: server back to running B drops staged A", LLUpdateMachine.decide(&s, version: B, minNativeBuild: 1, nativeBuild: 1, builtinVersion: BUILTIN) == .done(.upToDate) && s.staged == nil)
// server goes back to the builtin web
check("sm: builtin offered while on OTA -> stageBuiltin", LLUpdateMachine.decide(&s, version: BUILTIN, minNativeBuild: 1, nativeBuild: 1, builtinVersion: BUILTIN) == .stageBuiltin)
s.staged = LLUpdateRules.builtinMarker
check("sm: builtin staged -> next launch path nil", LLUpdateMachine.nextLaunchVersion(s) == nil)
check("sm: builtin staged twice -> already_staged", LLUpdateMachine.decide(&s, version: BUILTIN, minNativeBuild: 1, nativeBuild: 1, builtinVersion: BUILTIN) == .done(.alreadyStaged))
l = LLUpdateMachine.launch(&s, binary: "1.0.0(1)", exists: all)
check("sm: builtin promoted, previous = B", l.active == nil && s.previous == B && !l.watchdog)
// broken bundle killed before ready, launch after launch
var k = LLUpdateState(); k.binary = "x"; k.staged = A
for i in 1...3 { l = LLUpdateMachine.launch(&k, binary: "x", exists: all); check("sm: unconfirmed launch \(i) keeps A", l.active == A && l.watchdog) }
l = LLUpdateMachine.launch(&k, binary: "x", exists: all)
check("sm: 4th unconfirmed launch -> A failed, builtin", l.failedNow == A && l.active == nil && k.failed == [A])
// missing bundle dir
var m1 = LLUpdateState(); m1.binary = "x"; m1.current = B; m1.good = [B]
l = LLUpdateMachine.launch(&m1, binary: "x", exists: none)
check("sm: current dir missing -> builtin", l.active == nil && m1.current == nil)
var m2 = LLUpdateState(); m2.binary = "x"; m2.current = B; m2.staged = C; m2.good = [B]
l = LLUpdateMachine.launch(&m2, binary: "x", exists: { $0 == B })
check("sm: staged dir missing -> stays on B", l.active == B && m2.staged == nil)
// new binary
var nb = LLUpdateState(); nb.binary = "1.0.0(1)"; nb.current = B; nb.good = [B]; nb.failed = [C]
l = LLUpdateMachine.launch(&nb, binary: "1.0.1(2)", exists: all)
check("sm: new binary resets to builtin, keeps failed", l.resetAll && nb.current == nil && nb.good.isEmpty && nb.failed == [C] && nb.binary == "1.0.1(2)")
// reset
var r = LLUpdateState(); r.binary = "x"; r.current = B; r.previous = A; r.staged = C; r.good = [A, B]; r.failed = [C]
LLUpdateMachine.reset(&r)
check("sm: reset -> builtin, failed kept", r.current == nil && r.previous == nil && r.staged == nil && r.good.isEmpty && r.failed == [C] && r.binary == "x")
// failed list is bounded
var fl = LLUpdateState(); fl.binary = "x"
for i in 0..<25 { fl.current = String(format: "%016x", i); _ = LLUpdateMachine.rollback(&fl, exists: all) }
check("sm: failed list bounded to 20", fl.failed.count == 20 && fl.failed.first == String(format: "%016x", 5))
// state.json round trip
let tmpRoot = FileManager.default.temporaryDirectory.appendingPathComponent("ll-update-harness-\(UUID().uuidString)", isDirectory: true)
defer { try? FileManager.default.removeItem(at: tmpRoot) }
let store = LLUpdateStore(root: tmpRoot.appendingPathComponent("bundles", isDirectory: true))
store.save(r)
check("state.json round trip", store.load() == r)
let stateText = String(data: try! Data(contentsOf: store.root.appendingPathComponent("state.json")), encoding: .utf8) ?? ""
check("state.json holds no URL or path", !stateText.contains("http") && !stateText.contains("/Users") && !stateText.contains("tmp"))

// ---- staging with the vectors
if let v = vectors.first, let m = LLUpdateRules.parse(Data(v.manifestJson.utf8), requireBaseUrl: true) {
    let fm = FileManager.default
    var fetched: [String] = []
    let fetchLock = NSLock()
    func fetcher(_ overrides: [String: Data] = [:], fail: Bool = false) -> (URL) throws -> Data {
        return { url in
            fetchLock.lock(); fetched.append(url.absoluteString); fetchLock.unlock()
            if fail { throw LLUpdateStageError.network }
            for f in m.files where LLUpdateRules.fileURL(base: m.baseUrl!, path: f.path) == url {
                if let o = overrides[f.path] { return o }
                if let d = v.files[f.path] { return d }
            }
            throw LLUpdateStageError.network
        }
    }
    // builtin source: index.html differs, assets/app-1.js identical (reused, not downloaded)
    let builtin = tmpRoot.appendingPathComponent("public", isDirectory: true)
    try! fm.createDirectory(at: builtin.appendingPathComponent("assets"), withIntermediateDirectories: true)
    try! fm.createDirectory(at: builtin.appendingPathComponent("app-update"), withIntermediateDirectories: true)
    let oldIndex = Data("<html>A</html>".utf8)
    try! oldIndex.write(to: builtin.appendingPathComponent("index.html"))
    let shared = "assets/app-1.js"
    if let d = v.files[shared] { try! d.write(to: builtin.appendingPathComponent(shared)) }
    let bfiles = [F("index.html", LLUpdateRules.sha256Hex(oldIndex), Int64(oldIndex.count)),
                  F(shared, LLUpdateRules.sha256Hex(v.files[shared] ?? Data()), Int64(v.files[shared]?.count ?? 0))]
    let bjson: [String: Any] = ["schema": 1, "version": LLUpdateRules.contentId(bfiles), "webVersion": "1.0.0",
                                "minNativeBuild": ["ios": 1, "android": 1], "builtAt": "2026-10-13T00:00:00.000Z",
                                "files": bfiles.map { ["path": $0.path, "sha256": $0.sha256, "size": $0.size] }]
    try! JSONSerialization.data(withJSONObject: bjson).write(to: builtin.appendingPathComponent("app-update/manifest.json"))
    let src = LLUpdateSource.open(builtin)
    check("stage: builtin source opens", src != nil)
    let plan = LLUpdateStager.plan(m, sources: [src].compactMap { $0 })
    check("stage: unchanged file reused from builtin", plan.local.count == 1 && plan.remote.count == m.files.count - 1
          && plan.remoteBytes == m.files.filter { $0.path != shared }.reduce(0) { $0 + $1.size })
    let mj = Data(v.manifestJson.utf8)

    // tampered file -> verify, nothing staged
    if let (tp, td) = v.tamperedFile {
        let p2 = LLUpdateStager.plan(m, sources: [])
        var err: Error?
        do { try LLUpdateStager.assemble(m, manifestJson: mj, plan: p2, store: store, fetch: fetcher([tp: td])) } catch { err = error }
        check("stage: tampered file -> verify_failed", (err as? LLUpdateStageError) == .verify)
        check("stage: tampered leaves no bundle and no tmp", !store.hasBundle(m.version)
              && !fm.fileExists(atPath: store.root.appendingPathComponent("tmp-" + m.version).path))
    }
    // network failure -> network, nothing staged
    var nerr: Error?
    do { try LLUpdateStager.assemble(m, manifestJson: mj, plan: plan, store: store, fetch: fetcher(fail: true)) } catch { nerr = error }
    check("stage: network failure -> network, nothing staged", (nerr as? LLUpdateStageError) == .network && !store.hasBundle(m.version)
          && !fm.fileExists(atPath: store.root.appendingPathComponent("tmp-" + m.version).path))
    // success
    fetched = []
    var serr: Error?
    do { try LLUpdateStager.assemble(m, manifestJson: mj, plan: plan, store: store, fetch: fetcher()) } catch { serr = error }
    check("stage: success", serr == nil && store.hasBundle(m.version))
    check("stage: downloads only the missing files", fetched.count == plan.remote.count && !fetched.contains { $0.hasSuffix(shared) })
    check("stage: percent-encoded URLs requested", fetched.allSatisfy { !$0.contains(" ") })
    let dir = store.bundleDir(m.version)
    check("stage: every file sha256 + size as listed", m.files.allSatisfy { f in
        LLUpdateRules.sha256Hex(fileAt: dir.appendingPathComponent(f.path)).map { $0.hex == f.sha256 && $0.size == f.size } ?? false })
    check("stage: bundle carries its signed manifest", (try? Data(contentsOf: dir.appendingPathComponent(LLUpdateRules.manifestPath))) == mj)
    check("stage: staged bundle is itself a source", LLUpdateSource.open(dir)?.bySha.count == Set(m.files.map { $0.sha256 }).count)
    // corrupted local source falls back to a download
    if let d = v.files[shared] {
        var bad = d; bad.append(0x20)
        try! bad.write(to: builtin.appendingPathComponent(shared))
        store.deleteBundle(m.version)
        fetched = []
        var cerr: Error?
        do { try LLUpdateStager.assemble(m, manifestJson: mj, plan: plan, store: store, fetch: fetcher()) } catch { cerr = error }
        check("stage: changed local copy re-downloaded", cerr == nil && store.hasBundle(m.version) && fetched.contains { $0.hasSuffix("app-1.js") })
    }
    // prune
    for name in [A, B, C] {
        try! fm.createDirectory(at: store.bundleDir(name), withIntermediateDirectories: true)
    }
    let oldTmp = store.root.appendingPathComponent("tmp-" + A, isDirectory: true)
    let newTmp = store.root.appendingPathComponent("tmp-" + B, isDirectory: true)
    try! fm.createDirectory(at: oldTmp, withIntermediateDirectories: true)
    try! fm.createDirectory(at: newTmp, withIntermediateDirectories: true)
    try! fm.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -2 * 86_400)], ofItemAtPath: oldTmp.path)
    store.prune(keep: [m.version, B])
    let left = Set((try? fm.contentsOfDirectory(atPath: store.root.path)) ?? [])
    check("prune: keeps current/previous, tmp < 1 day and state.json", left == [m.version, B, "tmp-" + B, "state.json"])
    store.deleteAllBundles()
    check("deleteAllBundles keeps only state.json", Set((try? fm.contentsOfDirectory(atPath: store.root.path)) ?? []) == ["state.json"])
} else {
    check("stage: first vector parses", false)
}

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
#endif
