import Foundation
import Capacitor
import Photos
import CryptoKit
import Network
import BackgroundTasks
import UniformTypeIdentifiers

// Apple Photos album sync (docs/plans/step-10.md 2.4). Parents only; the JS side decides.
//
// Bridge `TinyglowPhotoSync`:
//   authorizationStatus()                      -> { status }
//   requestAuthorization()                     -> { status }   the only call that shows the prompt
//   listAlbums()                               -> { albums: [{ id, title, count }] }   user albums
//   listPendingAssets({ albumId, limit })      -> { assets: [{ id, createdAt }], remaining, albumExists }
//   exportAssets({ ids })                      -> { files: [...], failed: [{ id, reason }] }
//   discardFiles({ paths })                    -> {}           deletes exported files (Caches/ll-sync-export only)
//   recordOutcomes({ albumId, outcomes })      -> {}
//   ledgerSummary({ albumId })                 -> { done, duplicate, failed, skipped }
//   resetLedger({ albumId? })                  -> {}           no albumId: every ledger and every exported copy
//   conditions()                               -> { wifi, expensive, lowPowerMode, thermalState }
//   scheduleBackgroundRefresh()                -> {}
//   completeBackgroundTask({ taskId, success })-> {}
//   events: backgroundSync { taskId } | backgroundSyncExpired { taskId }
//
// Privacy: asset identifiers exist only in JS memory and in the ledger file. Nothing in this file
// writes a path, file name, URL or identifier to any log or to any other file.

// MARK: - Ledger

/// Per-album ledger of asset outcomes. Application Support/ll-sync/<sha256(albumId)>.json,
/// atomic writes, protected until first unlock, directory excluded from backup.
final class LLSyncLedger {
    static let shared = LLSyncLedger()
    private let queue = DispatchQueue(label: "com.tesarsoft.tinyglow.sync.ledger")

    struct Entry: Codable { var o: String; var n: Int }
    struct File: Codable { var v: Int; var entries: [String: Entry] }

    private var directory: URL? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        return support.appendingPathComponent("ll-sync", isDirectory: true)
    }

    private func prepareDirectory() -> URL? {
        guard var dir = directory else { return nil }
        let fm = FileManager.default
        if !fm.fileExists(atPath: dir.path) {
            guard (try? fm.createDirectory(at: dir, withIntermediateDirectories: true)) != nil else { return nil }
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        return dir
    }

    private func fileURL(_ albumId: String, in dir: URL) -> URL {
        let digest = SHA256.hash(data: Data(albumId.utf8)).map { String(format: "%02x", $0) }.joined()
        return dir.appendingPathComponent("\(digest).json")
    }

    private func load(_ albumId: String) -> File {
        guard let dir = prepareDirectory(),
              let data = try? Data(contentsOf: fileURL(albumId, in: dir)),
              let file = try? JSONDecoder().decode(File.self, from: data), file.v == 1
        else { return File(v: 1, entries: [:]) }
        return file
    }

    private func save(_ file: File, _ albumId: String) {
        guard let dir = prepareDirectory(), let data = try? JSONEncoder().encode(file) else { return }
        try? data.write(to: fileURL(albumId, in: dir),
                        options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func entries(_ albumId: String) -> [String: Entry] {
        queue.sync { load(albumId).entries }
    }

    func record(_ albumId: String, _ outcomes: [(id: String, outcome: String)]) {
        queue.sync {
            var file = load(albumId)
            for (id, outcome) in outcomes {
                switch outcome {
                case "done": file.entries[id] = Entry(o: "d", n: file.entries[id]?.n ?? 0)
                case "duplicate": file.entries[id] = Entry(o: "u", n: file.entries[id]?.n ?? 0)
                case "skipped": file.entries[id] = Entry(o: "s", n: file.entries[id]?.n ?? 0)
                case "failed":
                    let n = (file.entries[id]?.n ?? 0) + 1
                    file.entries[id] = Entry(o: n >= 3 ? "s" : "f", n: n)
                default: break
                }
            }
            save(file, albumId)
        }
    }

    func summary(_ albumId: String) -> [String: Int] {
        let e = entries(albumId).values
        return [
            "done": e.filter { $0.o == "d" }.count,
            "duplicate": e.filter { $0.o == "u" }.count,
            "failed": e.filter { $0.o == "f" }.count,
            "skipped": e.filter { $0.o == "s" }.count,
        ]
    }

    func reset(_ albumId: String?) {
        queue.sync {
            guard let dir = directory else { return }
            let fm = FileManager.default
            if let albumId = albumId {
                try? fm.removeItem(at: fileURL(albumId, in: dir))
            } else if let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) {
                files.forEach { try? fm.removeItem(at: $0) }
            }
        }
    }
}

// MARK: - Background task and conditions

final class LLPhotoSync {
    static let shared = LLPhotoSync()
    static let taskIdentifier = "com.tesarsoft.tinyglow.sync"

    private let lock = NSLock()
    private var buffered: [(String, [String: Any])] = []
    private var sink: ((String, [String: Any]) -> Void)?
    private var current: (id: String, task: BGAppRefreshTask)?

    private let monitor = NWPathMonitor()
    private var path: NWPath?
    private var monitorStarted = false

    func startMonitor() {
        lock.lock()
        if monitorStarted { lock.unlock(); return }
        monitorStarted = true
        lock.unlock()
        monitor.pathUpdateHandler = { [weak self] p in
            guard let self = self else { return }
            self.lock.lock(); self.path = p; self.lock.unlock()
        }
        monitor.start(queue: DispatchQueue(label: "com.tesarsoft.tinyglow.sync.path"))
    }

    func latestPath() -> NWPath? {
        startMonitor()
        for _ in 0..<20 {
            lock.lock(); let p = path; lock.unlock()
            if let p = p { return p }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return nil
    }

    func attach(_ sink: @escaping (String, [String: Any]) -> Void) {
        lock.lock()
        self.sink = sink
        let pending = buffered
        buffered = []
        lock.unlock()
        for (name, data) in pending { sink(name, data) }
    }

    private func emit(_ name: String, _ data: [String: Any]) {
        lock.lock()
        if let sink = sink {
            lock.unlock()
            sink(name, data)
        } else {
            buffered.append((name, data))
            lock.unlock()
        }
    }

    func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: LLPhotoSync.taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Called by the BGTaskScheduler launch handler registered in AppDelegate.
    func handle(_ task: BGAppRefreshTask) {
        let id = UUID().uuidString
        lock.lock()
        let previous = current
        current = (id, task)
        lock.unlock()
        previous?.task.setTaskCompleted(success: false)
        schedule()
        task.expirationHandler = { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let was = self.current
            if was?.id == id { self.current = nil }
            self.lock.unlock()
            guard was?.id == id else { return }
            self.emit("backgroundSyncExpired", ["taskId": id])
            task.setTaskCompleted(success: false)
        }
        emit("backgroundSync", ["taskId": id])
    }

    func complete(taskId: String, success: Bool) {
        lock.lock()
        let was = current
        if was?.id == taskId { current = nil }
        lock.unlock()
        if let was = was, was.id == taskId { was.task.setTaskCompleted(success: success) }
        schedule()
    }
}

// MARK: - Plugin

@objc(TinyglowPhotoSyncPlugin)
public class TinyglowPhotoSyncPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TinyglowPhotoSyncPlugin"
    public let jsName = "TinyglowPhotoSync"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorizationStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listAlbums", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listPendingAssets", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportAssets", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recordOutcomes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ledgerSummary", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetLedger", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "conditions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleBackgroundRefresh", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "completeBackgroundTask", returnType: CAPPluginReturnPromise),
    ]

    private static let work = DispatchQueue(label: "com.tesarsoft.tinyglow.sync.work", qos: .utility)

    override public func load() {
        LLPhotoSync.shared.startMonitor()
        LLPhotoSync.shared.attach { [weak self] name, data in
            // Retained until the JS side registers a listener (the app may be launched in the background).
            self?.notifyListeners(name, data: data, retainUntilConsumed: true)
        }
    }

    private static func statusString(_ s: PHAuthorizationStatus) -> String {
        switch s {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .limited: return "limited"
        @unknown default: return "denied"
        }
    }

    private static func iso(_ date: Date?) -> Any {
        guard let date = date else { return NSNull() }
        return ISO8601DateFormatter().string(from: date)
    }

    // MARK: authorization

    @objc func authorizationStatus(_ call: CAPPluginCall) {
        call.resolve(["status": Self.statusString(PHPhotoLibrary.authorizationStatus(for: .readWrite))])
    }

    /// The only place the system prompt can appear. JS calls this from enable() and nowhere else.
    @objc func requestAuthorization(_ call: CAPPluginCall) {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
            call.resolve(["status": Self.statusString(status)])
        }
    }

    // MARK: albums

    private static func imageOptions(newestFirst: Bool = false) -> PHFetchOptions {
        let o = PHFetchOptions()
        o.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        if newestFirst { o.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)] }
        return o
    }

    @objc func listAlbums(_ call: CAPPluginCall) {
        Self.work.async {
            let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            guard status == .authorized || status == .limited else {
                call.resolve(["albums": []])
                return
            }
            // User albums only: shared (iCloud) and smart albums are not offered (D12).
            let result = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil)
            var albums: [(String, String, Int)] = []
            result.enumerateObjects { c, _, _ in
                let count = PHAsset.fetchAssets(in: c, options: Self.imageOptions()).count
                albums.append((c.localIdentifier, c.localizedTitle ?? "", count))
            }
            albums.sort { $0.1.localizedStandardCompare($1.1) == .orderedAscending }
            call.resolve(["albums": albums.map { ["id": $0.0, "title": $0.1, "count": $0.2] }])
        }
    }

    @objc func listPendingAssets(_ call: CAPPluginCall) {
        guard let albumId = call.getString("albumId"), !albumId.isEmpty else { call.reject("bad-args"); return }
        let limit = max(1, min(500, call.getInt("limit") ?? 50))
        Self.work.async {
            let collections = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [albumId], options: nil)
            guard let collection = collections.firstObject else {
                call.resolve(["assets": [], "remaining": 0, "albumExists": false])
                return
            }
            let ledger = LLSyncLedger.shared.entries(albumId)
            let assets = PHAsset.fetchAssets(in: collection, options: Self.imageOptions(newestFirst: true))
            var picked: [[String: Any]] = []
            var remaining = 0
            assets.enumerateObjects { asset, _, _ in
                if let e = ledger[asset.localIdentifier] {
                    if e.o == "d" || e.o == "u" || e.o == "s" || e.n >= 3 { return }
                }
                if picked.count < limit {
                    picked.append(["id": asset.localIdentifier, "createdAt": Self.iso(asset.creationDate)])
                } else {
                    remaining += 1
                }
            }
            call.resolve(["assets": picked, "remaining": remaining, "albumExists": true])
        }
    }

    // MARK: export

    private static var uploadsDirectory: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("ll-sync-export", isDirectory: true)
    }

    private static func mimeAndExtension(_ uti: String) -> (String, String)? {
        switch uti {
        case "public.heic": return ("image/heic", "heic")
        case "public.heif": return ("image/heif", "heif")
        case "public.jpeg": return ("image/jpeg", "jpg")
        case "public.png": return ("image/png", "png")
        case "org.webmproject.webp": return ("image/webp", "webp")
        default: return nil
        }
    }

    private enum ExportError: Error { case unavailable, icloud, write, unsupported }

    /// Streams the original resource to disk, hashing as it goes. Blocks the calling (work) queue.
    private static func export(_ asset: PHAsset, into dir: URL) -> Result<[String: Any], ExportError> {
        guard asset.mediaType == .image else { return .failure(.unsupported) }
        let resources = PHAssetResource.assetResources(for: asset)
        // The unedited capture (D12), never the edited rendition.
        guard let resource = resources.first(where: { $0.type == .photo }) else { return .failure(.unavailable) }
        guard let (mime, ext) = mimeAndExtension(resource.uniformTypeIdentifier) else { return .failure(.unsupported) }

        let fm = FileManager.default
        let url = dir.appendingPathComponent("\(UUID().uuidString).\(ext)")
        guard fm.createFile(atPath: url.path, contents: nil,
                            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]),
              let handle = try? FileHandle(forWritingTo: url) else { return .failure(.write) }

        var hasher = SHA256()
        var writeFailed = false
        var requestError: Error?
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true  // iCloud originals
        let done = DispatchSemaphore(value: 0)
        PHAssetResourceManager.default().requestData(for: resource, options: options, dataReceivedHandler: { chunk in
            guard !writeFailed else { return }
            hasher.update(data: chunk)
            do { try handle.write(contentsOf: chunk) } catch { writeFailed = true }
        }, completionHandler: { error in
            requestError = error
            done.signal()
        })
        done.wait()
        try? handle.close()

        func fail(_ e: ExportError) -> Result<[String: Any], ExportError> {
            try? fm.removeItem(at: url)
            return .failure(e)
        }
        if writeFailed { return fail(.write) }
        if let error = requestError as NSError? {
            if error.domain == PHPhotosErrorDomain {
                var network = error.code == PHPhotosError.networkAccessRequired.rawValue
                if #available(iOS 16.0, *), error.code == PHPhotosError.networkError.rawValue { network = true }
                if network { return fail(.icloud) }
            }
            return fail(.unavailable)
        }
        let size = (try? fm.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        guard size > 0 else { return fail(.write) }
        let sha = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        return .success([
            "path": url.path,
            "name": resource.originalFilename,
            "mime": mime,
            "size": size,
            "sha256": sha,
            "takenAt": iso(asset.creationDate),
        ])
    }

    @objc func exportAssets(_ call: CAPPluginCall) {
        guard let ids = call.getArray("ids", String.self), !ids.isEmpty, ids.count <= 100 else {
            call.reject("bad-args")
            return
        }
        Self.work.async {
            guard let dir = Self.uploadsDirectory else { call.reject("write"); return }
            let fm = FileManager.default
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            Self.sweepOldExports(dir)
            let fetched = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
            var byId: [String: PHAsset] = [:]
            fetched.enumerateObjects { a, _, _ in byId[a.localIdentifier] = a }

            var files: [[String: Any]] = []
            var failed: [[String: Any]] = []
            for id in ids {
                guard let asset = byId[id] else { failed.append(["id": id, "reason": "unavailable"]); continue }
                switch Self.export(asset, into: dir) {
                case .success(var file):
                    file["id"] = id
                    files.append(file)
                case .failure(let e):
                    failed.append(["id": id, "reason": "\(e)"])
                }
            }
            call.resolve(["files": files, "failed": failed])
        }
    }

    /// Exports older than three days are leftovers (a Wi-Fi-only upload can wait, but not that long).
    private static func sweepOldExports(_ dir: URL) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])
        else { return }
        let cutoff = Date(timeIntervalSinceNow: -3 * 24 * 3600)
        for f in files {
            let m = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            if let m = m, m < cutoff { try? fm.removeItem(at: f) }
        }
    }

    /// Deletes exported files once uploaded. Only files directly inside Caches/ll-sync-export qualify.
    @objc func discardFiles(_ call: CAPPluginCall) {
        let paths = call.getArray("paths", String.self) ?? []
        Self.work.async {
            if let dir = Self.uploadsDirectory?.standardizedFileURL {
                for raw in paths {
                    let candidate = (URL(string: raw)?.isFileURL == true ? URL(string: raw)! : URL(fileURLWithPath: raw))
                        .standardizedFileURL
                    if candidate.deletingLastPathComponent().path == dir.path {
                        try? FileManager.default.removeItem(at: candidate)
                    }
                }
            }
            call.resolve()
        }
    }

    // MARK: ledger

    @objc func recordOutcomes(_ call: CAPPluginCall) {
        guard let albumId = call.getString("albumId"), !albumId.isEmpty,
              let raw = call.getArray("outcomes") else { call.reject("bad-args"); return }
        let outcomes: [(id: String, outcome: String)] = raw.compactMap {
            guard let item = $0 as? [String: Any],
                  let id = item["id"] as? String, let o = item["outcome"] as? String else { return nil }
            return (id, o)
        }
        Self.work.async {
            LLSyncLedger.shared.record(albumId, outcomes)
            call.resolve()
        }
    }

    @objc func ledgerSummary(_ call: CAPPluginCall) {
        guard let albumId = call.getString("albumId"), !albumId.isEmpty else { call.reject("bad-args"); return }
        Self.work.async { call.resolve(LLSyncLedger.shared.summary(albumId)) }
    }

    @objc func resetLedger(_ call: CAPPluginCall) {
        let albumId = call.getString("albumId")
        Self.work.async {
            LLSyncLedger.shared.reset(albumId)
            // Sign-out / account deletion (no album): the exported working copies go too.
            if albumId == nil, let dir = Self.uploadsDirectory { try? FileManager.default.removeItem(at: dir) }
            call.resolve()
        }
    }

    // MARK: conditions and background

    @objc func conditions(_ call: CAPPluginCall) {
        Self.work.async {
            let path = LLPhotoSync.shared.latestPath()
            let onWifi = path.map {
                $0.status == .satisfied && ($0.usesInterfaceType(.wifi) || $0.usesInterfaceType(.wiredEthernet))
            } ?? false
            let thermal: String
            switch ProcessInfo.processInfo.thermalState {
            case .nominal: thermal = "nominal"
            case .fair: thermal = "fair"
            case .serious: thermal = "serious"
            case .critical: thermal = "critical"
            @unknown default: thermal = "serious"
            }
            call.resolve([
                "wifi": onWifi,
                "expensive": path?.isExpensive ?? false,
                "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
                "thermalState": thermal,
            ])
        }
    }

    @objc func scheduleBackgroundRefresh(_ call: CAPPluginCall) {
        LLPhotoSync.shared.schedule()
        call.resolve()
    }

    @objc func completeBackgroundTask(_ call: CAPPluginCall) {
        guard let taskId = call.getString("taskId") else { call.reject("bad-args"); return }
        LLPhotoSync.shared.complete(taskId: taskId, success: call.getBool("success") ?? false)
        call.resolve()
    }
}
