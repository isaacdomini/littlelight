import Foundation
import Capacitor

// Background raw-body PUT uploader (docs/plans/step-9.md 2.6; ranged parts: docs/plans/step-12.md 2.9).
//
// Bridge `TinyglowUploader`:
//   upload({ url, path, offset?, length?, wifiOnly? }) -> { id }
//                                        PUT bytes [offset, offset+length) of the file (no multipart,
//                                        no extra headers). No range, or a range covering the whole
//                                        file: the file itself is the body. Any other range is copied
//                                        to Caches/ll-uploads/parts/<id>.part first (a background
//                                        URLSession needs a file body) and that copy is deleted when
//                                        the task completes, fails or is cancelled.
//                                        wifiOnly: true uses a second background session that never
//                                        uses cellular (app.tinyglow.upload.wifi).
//   cancel({ id })                       cancel a running upload (searches both sessions)
//   pendingParts()                       -> { count }  part files still on disk (diagnostics, tests)
//   events: progress { id, sent, total } | done { id, status } | error { id, message }
//
// Rejections: bad-args, file-unreadable, bad-range (outside the file), no-space (not enough free
// space for the part copy), part-write (copy failed).
//
// Privacy: the presigned URL (carries X-Amz-Signature) and the file path are never logged and are
// not stored anywhere by this code. Error messages carry only an NSURLError code.

final class LLUploadSession: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    static let identifier = "app.tinyglow.upload"
    static let wifiIdentifier = "app.tinyglow.upload.wifi"
    static let shared = LLUploadSession(identifier: identifier, cellular: true)
    static let wifi = LLUploadSession(identifier: wifiIdentifier, cellular: false)
    static let all = [shared, wifi]

    static func forIdentifier(_ id: String) -> LLUploadSession? { all.first { $0.identifier == id } }

    let identifier: String
    private let cellular: Bool

    private init(identifier: String, cellular: Bool) {
        self.identifier = identifier
        self.cellular = cellular
        super.init()
    }

    private let lock = NSLock()
    private var buffered: [(String, [String: Any])] = []
    private var sink: ((String, [String: Any]) -> Void)?
    private var backgroundCompletion: (() -> Void)?
    private var lastProgress: [String: Date] = [:]

    private(set) lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.allowsCellularAccess = cellular
        config.waitsForConnectivity = true
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        config.httpShouldSetCookies = false
        config.urlCache = nil
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    /// Reattach to a session the system relaunched the app for.
    func handleBackgroundEvents(completion: @escaping () -> Void) {
        lock.lock(); backgroundCompletion = completion; lock.unlock()
        _ = session
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
            if name != "progress" { buffered.append((name, data)) }
            lock.unlock()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard let id = task.taskDescription else { return }
        let now = Date()
        lock.lock()
        let last = lastProgress[id]
        let finalChunk = totalBytesSent >= totalBytesExpectedToSend
        let emitNow = finalChunk || last == nil || now.timeIntervalSince(last!) > 0.25
        if emitNow { lastProgress[id] = now }
        lock.unlock()
        if emitNow {
            emit("progress", ["id": id, "sent": totalBytesSent, "total": totalBytesExpectedToSend])
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription else { return }
        lock.lock(); lastProgress.removeValue(forKey: id); lock.unlock()
        // The part copy (if this task had one) is no longer needed, whatever the outcome.
        if let dir = LLPartFile.directory() { LLPartFile.remove(id: id, in: dir) }
        if let error = error as NSError? {
            if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
            emit("error", ["id": id, "message": "network:\(error.code)"])
            return
        }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        emit("done", ["id": id, "status": status])
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock()
        let completion = backgroundCompletion
        backgroundCompletion = nil
        lock.unlock()
        if let completion = completion { DispatchQueue.main.async { completion() } }
    }

    /// Ids of every task the sessions still know (queued, running or finishing). Async: the
    /// session's task table lives in nsurlsessiond.
    static func liveTaskIds(_ completion: @escaping (Set<String>) -> Void) {
        let group = DispatchGroup()
        let lock = NSLock()
        var ids = Set<String>()
        for s in all {
            group.enter()
            s.session.getAllTasks { tasks in
                lock.lock()
                for t in tasks { if let id = t.taskDescription { ids.insert(id) } }
                lock.unlock()
                group.leave()
            }
        }
        group.notify(queue: .global(qos: .utility)) { completion(ids) }
    }
}

@objc(TinyglowUploaderPlugin)
public class TinyglowUploaderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TinyglowUploaderPlugin"
    public let jsName = "TinyglowUploader"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "upload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pendingParts", returnType: CAPPluginReturnPromise),
    ]

    /// Part copies are written off the bridge thread, one at a time (disk-bound anyway).
    private static let work = DispatchQueue(label: "app.tinyglow.upload.parts", qos: .utility)

    override public func load() {
        for session in LLUploadSession.all {
            session.attach { [weak self] name, data in
                // done / error are retained until the JS side registers a listener.
                self?.notifyListeners(name, data: data, retainUntilConsumed: name != "progress")
            }
            _ = session.session  // reattach to tasks that outlived the previous process
        }
        // Part copies whose task is gone (the process died between completion and deletion, or
        // the task was never created) are leftovers: sweep them once the task table is known.
        LLUploadSession.liveTaskIds { live in
            guard let dir = LLPartFile.directory() else { return }
            LLPartFile.sweep(dir, keeping: live)
        }
    }

    @objc func upload(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString),
              url.scheme == "http" || url.scheme == "https",
              let rawPath = call.getString("path"), !rawPath.isEmpty else {
            call.reject("bad-args")
            return
        }
        let fileURL: URL
        if let candidate = URL(string: rawPath), candidate.isFileURL {
            fileURL = candidate
        } else {
            fileURL = URL(fileURLWithPath: rawPath)
        }
        let fm = FileManager.default
        guard fm.isReadableFile(atPath: fileURL.path),
              let sizeNumber = (try? fm.attributesOfItem(atPath: fileURL.path))?[.size] as? NSNumber else {
            call.reject("file-unreadable")
            return
        }
        let fileSize = sizeNumber.int64Value

        // Range: both optional; absent means the whole file. Int64 so a 2 GiB offset is exact.
        let offset = Self.int64(call, "offset") ?? 0
        let length = Self.int64(call, "length") ?? max(0, fileSize - offset)
        let range: Range<Int64>
        switch LLPartFile.range(fileSize: fileSize, offset: offset, length: length) {
        case .success(let r): range = r
        case .failure(.badArgs): call.reject(fileSize == 0 ? "file-unreadable" : "bad-args"); return
        case .failure(.outOfBounds): call.reject("bad-range"); return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let id = UUID().uuidString
        let target = (call.getBool("wifiOnly") ?? false) ? LLUploadSession.wifi : LLUploadSession.shared

        func start(_ body: URL) {
            let task = target.session.uploadTask(with: request, fromFile: body)
            task.taskDescription = id
            task.resume()
            call.resolve(["id": id])
        }

        if LLPartFile.isWholeFile(fileSize: fileSize, range: range) {
            start(fileURL)
            return
        }
        guard let dir = LLPartFile.directory() else { call.reject("part-write"); return }
        Self.work.async {
            do { try LLPartFile.prepareDirectory(dir) } catch { call.reject("part-write"); return }
            let part = LLPartFile.url(for: id, in: dir)
            switch LLPartFile.write(range: range, of: fileURL, to: part) {
            case nil: start(part)
            case .noSpace?: call.reject("no-space")
            case .source?, .shortRead?: call.reject("file-unreadable")
            case .write?: call.reject("part-write")
            }
        }
    }

    /// Capacitor stores JSON numbers as NSNumber; read them as Int64 (a Double loses nothing below 2^53).
    private static func int64(_ call: CAPPluginCall, _ key: String) -> Int64? {
        guard let any = call.options[key] else { return nil }
        if let n = any as? NSNumber { return n.int64Value }
        return nil
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("bad-args"); return }
        let group = DispatchGroup()
        for s in LLUploadSession.all {
            group.enter()
            s.session.getAllTasks { tasks in
                tasks.filter { $0.taskDescription == id }.forEach { $0.cancel() }
                group.leave()
            }
        }
        group.notify(queue: .main) {
            // The delegate deletes the part on the cancel callback; this covers a task that never started.
            if let dir = LLPartFile.directory() { LLPartFile.remove(id: id, in: dir) }
            call.resolve()
        }
    }

    /// Number of part copies currently on disk (0 when nothing is uploading). Tests and the
    /// Settings diagnostics use it; it never returns names or paths.
    @objc func pendingParts(_ call: CAPPluginCall) {
        Self.work.async {
            var count = 0
            if let dir = LLPartFile.directory(),
               let entries = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) {
                count = entries.filter { LLPartFile.id(of: $0) != nil }.count
            }
            call.resolve(["count": count])
        }
    }
}

final class TinyglowViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TinyglowUploaderPlugin())
        bridge?.registerPluginInstance(TinyglowPhotoSyncPlugin())
        bridge?.registerPluginInstance(TinyglowPasskeysPlugin())
    }
}
