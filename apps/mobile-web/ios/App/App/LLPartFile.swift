import Foundation

// Ranged upload parts for the background uploader (docs/plans/step-12.md 2.9).
//
// A background `URLSession` upload task needs a file body, so one part of a large video (16 MiB,
// `UPLOAD_PART_BYTES`) is copied to `Caches/ll-uploads/parts/<task id>.part` before the task is
// created and deleted as soon as the task completes, fails or is cancelled. A whole-file upload
// (offset 0, length == size, or no range at all) never copies.
//
// Foundation only, no Capacitor import: `ios/scripts/part-file-harness.sh` compiles this file
// with a host-side test. Nothing here logs paths or sizes.

enum LLPartFile {
    static let partsDirectoryName = "parts"
    static let fileExtension = "part"
    /// Copy chunk: bounded memory even for a 16 MiB part.
    static let chunkBytes = 1 << 20
    /// Free space that must remain after writing a part (the WebView and the picker need room too).
    static let headroomBytes: Int64 = 64 << 20
    /// Orphan parts (no task owns them) older than this are swept even if the task table was unreadable.
    static let orphanAge: TimeInterval = 24 * 3600

    enum RangeError: Error, Equatable { case badArgs, outOfBounds }

    /// Validated byte range of a part inside a file of `fileSize` bytes.
    static func range(fileSize: Int64, offset: Int64, length: Int64) -> Result<Range<Int64>, RangeError> {
        guard fileSize >= 0, offset >= 0, length >= 1 else { return .failure(.badArgs) }
        guard offset < fileSize, length <= fileSize - offset else { return .failure(.outOfBounds) }
        return .success(offset..<(offset + length))
    }

    /// True when the range is the whole file: upload straight from the source, no copy.
    static func isWholeFile(fileSize: Int64, range: Range<Int64>) -> Bool {
        range.lowerBound == 0 && range.upperBound == fileSize
    }

    /// `[offset, length]` of every part of a `fileSize`-byte file split into `partSize` parts
    /// (mirror of `partCountFor` in `@tinyglow/shared`: the last part may be shorter).
    static func split(fileSize: Int64, partSize: Int64) -> [(offset: Int64, length: Int64)] {
        guard fileSize > 0, partSize > 0 else { return [] }
        var parts: [(Int64, Int64)] = []
        var offset: Int64 = 0
        while offset < fileSize {
            let length = min(partSize, fileSize - offset)
            parts.append((offset, length))
            offset += length
        }
        return parts
    }

    // MARK: locations

    static func directory(in caches: URL) -> URL {
        caches.appendingPathComponent("ll-uploads", isDirectory: true)
            .appendingPathComponent(partsDirectoryName, isDirectory: true)
    }

    static func directory() -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first.map(directory(in:))
    }

    static func url(for id: String, in dir: URL) -> URL {
        dir.appendingPathComponent("\(id).\(fileExtension)", isDirectory: false)
    }

    /// The task id a part file belongs to (its base name), or nil for anything else in the directory.
    static func id(of url: URL) -> String? {
        guard url.pathExtension == fileExtension else { return nil }
        let name = url.deletingPathExtension().lastPathComponent
        return name.isEmpty ? nil : name
    }

    static func prepareDirectory(_ dir: URL) throws {
        let fm = FileManager.default
        if !fm.fileExists(atPath: dir.path) {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        var d = dir
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? d.setResourceValues(values)
    }

    // MARK: copy

    enum WriteError: Error, Equatable { case source, noSpace, write, shortRead }

    /// Bytes available on the volume of `url` for "important" usage, or nil when unknown.
    static func availableBytes(at url: URL) -> Int64? {
        let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage
    }

    /// Copies `range` of `source` to `dest` in `chunkBytes` reads. `dest` is created fresh
    /// (protected until first unlock) and removed again on any failure.
    /// Returns nil on success, otherwise the reason.
    static func write(range: Range<Int64>, of source: URL, to dest: URL,
                      availableBytes: Int64? = nil) -> WriteError? {
        let fm = FileManager.default
        let length = range.upperBound - range.lowerBound
        if let free = availableBytes ?? LLPartFile.availableBytes(at: dest.deletingLastPathComponent()),
           free < length + headroomBytes {
            return .noSpace
        }
        guard let input = try? FileHandle(forReadingFrom: source) else { return .source }
        defer { try? input.close() }
        do { try input.seek(toOffset: UInt64(range.lowerBound)) } catch { return .source }

        try? fm.removeItem(at: dest)
        guard fm.createFile(atPath: dest.path, contents: nil,
                            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]),
              let output = try? FileHandle(forWritingTo: dest) else { return .write }
        var closed = false
        func fail(_ e: WriteError) -> WriteError? {
            if !closed { try? output.close(); closed = true }
            try? fm.removeItem(at: dest)
            return e
        }
        var remaining = length
        while remaining > 0 {
            let want = Int(min(Int64(chunkBytes), remaining))
            let chunk: Data
            do {
                guard let read = try input.read(upToCount: want), !read.isEmpty else { return fail(.shortRead) }
                chunk = read
            } catch { return fail(.source) }
            do { try output.write(contentsOf: chunk) } catch { return fail(.write) }
            remaining -= Int64(chunk.count)
        }
        do { try output.close(); closed = true } catch { return fail(.write) }
        return nil
    }

    // MARK: cleanup

    static func remove(id: String, in dir: URL) {
        try? FileManager.default.removeItem(at: url(for: id, in: dir))
    }

    /// Deletes every part file whose id is not in `live` (the tasks the sessions still know), plus
    /// anything older than `orphanAge` regardless. Returns the number of files removed.
    @discardableResult
    static func sweep(_ dir: URL, keeping live: Set<String>, now: Date = Date()) -> Int {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])
        else { return 0 }
        var removed = 0
        for entry in entries {
            let modified = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            let stale = modified.map { now.timeIntervalSince($0) > orphanAge } ?? true
            let owned = id(of: entry).map { live.contains($0) } ?? false
            if !owned || stale {
                if (try? fm.removeItem(at: entry)) != nil { removed += 1 }
            }
        }
        return removed
    }
}
