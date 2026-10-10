import Foundation
import Capacitor

// Background raw-body PUT uploader (docs/plans/step-9.md 2.6).
//
// Bridge `TinyglowUploader`:
//   upload({ url, path, wifiOnly? }) -> { id }
//                                        PUT the file bytes (no multipart, no extra headers).
//                                        wifiOnly: true uses a second background session that never
//                                        uses cellular (com.tesarsoft.tinyglow.upload.wifi).
//   cancel({ id })                       cancel a running upload (searches both sessions)
//   events: progress { id, sent, total } | done { id, status } | error { id, message }
//
// Privacy: the presigned URL (carries X-Amz-Signature) and the file path are never logged and are
// not stored anywhere by this code. Error messages carry only an NSURLError code.

final class LLUploadSession: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    static let identifier = "com.tesarsoft.tinyglow.upload"
    static let wifiIdentifier = "com.tesarsoft.tinyglow.upload.wifi"
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
}

@objc(TinyglowUploaderPlugin)
public class TinyglowUploaderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TinyglowUploaderPlugin"
    public let jsName = "TinyglowUploader"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "upload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        for session in LLUploadSession.all {
            session.attach { [weak self] name, data in
                // done / error are retained until the JS side registers a listener.
                self?.notifyListeners(name, data: data, retainUntilConsumed: name != "progress")
            }
            _ = session.session  // reattach to tasks that outlived the previous process
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
        guard FileManager.default.isReadableFile(atPath: fileURL.path) else {
            call.reject("file-unreadable")
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let id = UUID().uuidString
        let target = (call.getBool("wifiOnly") ?? false) ? LLUploadSession.wifi : LLUploadSession.shared
        let task = target.session.uploadTask(with: request, fromFile: fileURL)
        task.taskDescription = id
        task.resume()
        call.resolve(["id": id])
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
        group.notify(queue: .main) { call.resolve() }
    }
}

final class TinyglowViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TinyglowUploaderPlugin())
        bridge?.registerPluginInstance(TinyglowPhotoSyncPlugin())
    }
}
