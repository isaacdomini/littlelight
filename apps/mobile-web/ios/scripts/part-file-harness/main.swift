import Foundation

// Host-side test of LLPartFile (ios/App/App/LLPartFile.swift): part slicing, the shorter last
// part, byte-exact copies, no-copy whole-file detection, deletion and the orphan sweep.
// Lives in its own folder as main.swift (top-level code). Run: sh apps/mobile-web/ios/scripts/part-file-harness.sh (compiles both files with swiftc on
// macOS; no simulator, no Xcode project). Exit 1 on the first failed check.

var failures = 0
func check(_ ok: Bool, _ what: String) {
    if ok { print("PASS  \(what)") } else { failures += 1; print("FAIL  \(what)") }
}

let MIB: Int64 = 1 << 20
let PART: Int64 = 16 * MIB  // UPLOAD_PART_BYTES

// --- split: mirrors partCountFor = ceil(bytes / 16 MiB), last part shorter ------------------------
do {
    let s60 = LLPartFile.split(fileSize: 60 * MIB, partSize: PART)
    check(s60.count == 4, "60 MiB splits into 4 parts")
    check(s60.map { $0.length } == [PART, PART, PART, 12 * MIB], "60 MiB: three 16 MiB parts and a 12 MiB last part")
    check(s60.map { $0.offset } == [0, PART, 2 * PART, 3 * PART], "60 MiB: contiguous offsets")
    let exact = LLPartFile.split(fileSize: 32 * MIB, partSize: PART)
    check(exact.count == 2 && exact.last?.length == PART, "32 MiB: exactly two full parts (no empty tail)")
    check(LLPartFile.split(fileSize: 1, partSize: PART).count == 1, "1 byte: one part")
    check(LLPartFile.split(fileSize: 0, partSize: PART).isEmpty, "0 bytes: no parts")
    let twoGiB: Int64 = 2 * 1024 * MIB
    check(LLPartFile.split(fileSize: twoGiB, partSize: PART).count == 128, "2 GiB: 128 parts (the api's maximum)")
}

// --- range validation ----------------------------------------------------------------------------
do {
    check(LLPartFile.range(fileSize: 100, offset: 0, length: 100) == .success(0..<100), "full range accepted")
    check(LLPartFile.range(fileSize: 100, offset: 90, length: 10) == .success(90..<100), "last part up to the end accepted")
    check(LLPartFile.range(fileSize: 100, offset: 90, length: 11) == .failure(.outOfBounds), "past the end rejected")
    check(LLPartFile.range(fileSize: 100, offset: 100, length: 1) == .failure(.outOfBounds), "offset at EOF rejected")
    check(LLPartFile.range(fileSize: 100, offset: -1, length: 1) == .failure(.badArgs), "negative offset rejected")
    check(LLPartFile.range(fileSize: 100, offset: 0, length: 0) == .failure(.badArgs), "zero length rejected")
    check(LLPartFile.isWholeFile(fileSize: 100, range: 0..<100), "offset 0 + full length is the whole file (no copy)")
    check(!LLPartFile.isWholeFile(fileSize: 100, range: 0..<50), "a prefix is not the whole file")
}

// --- copies: byte-exact parts of a 5 MiB + 3 byte file with a 2 MiB part size -------------------
let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ll-part-harness-\(UUID().uuidString)", isDirectory: true)
try! FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: tmp) }

let size: Int64 = 5 * MIB + 3
var bytes = [UInt8](repeating: 0, count: Int(size))
var seed: UInt32 = 0x9E3779B9
for i in 0..<bytes.count { seed = seed &* 1664525 &+ 1013904223; bytes[i] = UInt8(truncatingIfNeeded: seed >> 24) }
let source = tmp.appendingPathComponent("source.mov")
try! Data(bytes).write(to: source)
let partsDir = LLPartFile.directory(in: tmp)
try! LLPartFile.prepareDirectory(partsDir)
check(FileManager.default.fileExists(atPath: partsDir.path), "parts directory created at Caches/ll-uploads/parts")

let plan = LLPartFile.split(fileSize: size, partSize: 2 * MIB)
check(plan.count == 3 && plan[2].length == MIB + 3, "5 MiB + 3 B with 2 MiB parts: 3 parts, last 1 MiB + 3 B")
var ids: [String] = []
for (i, p) in plan.enumerated() {
    let id = "task-\(i)"
    ids.append(id)
    let dest = LLPartFile.url(for: id, in: partsDir)
    let r = LLPartFile.write(range: p.offset..<(p.offset + p.length), of: source, to: dest, availableBytes: Int64.max)
    check(r == nil, "part \(i + 1) written")
    let written = try! Data(contentsOf: dest)
    check(Int64(written.count) == p.length, "part \(i + 1) has \(p.length) bytes")
    check(written == Data(bytes[Int(p.offset)..<Int(p.offset + p.length)]), "part \(i + 1) is byte-exact")
    check(LLPartFile.id(of: dest) == id, "part file name maps back to the task id")
}
check((try? FileManager.default.contentsOfDirectory(atPath: partsDir.path))?.count == 3, "three part files on disk while uploading")

// no space: refused, nothing left behind
do {
    let dest = LLPartFile.url(for: "no-space", in: partsDir)
    let r = LLPartFile.write(range: 0..<MIB, of: source, to: dest, availableBytes: MIB)  // < length + headroom
    check(r == .noSpace, "too little free space is refused")
    check(!FileManager.default.fileExists(atPath: dest.path), "no-space leaves no file")
}
// short read: a range the file cannot satisfy (validation would catch it; the copy must too)
do {
    let dest = LLPartFile.url(for: "short", in: partsDir)
    let r = LLPartFile.write(range: (size - 10)..<(size + 10), of: source, to: dest, availableBytes: Int64.max)
    check(r == .shortRead, "a short read fails")
    check(!FileManager.default.fileExists(atPath: dest.path), "a failed copy is removed")
}
// missing source
do {
    let dest = LLPartFile.url(for: "missing", in: partsDir)
    let r = LLPartFile.write(range: 0..<10, of: tmp.appendingPathComponent("nope.mov"), to: dest, availableBytes: Int64.max)
    check(r == .source, "a missing source fails as .source")
}

// --- deletion: after a task completes its part goes; the source stays --------------------------
LLPartFile.remove(id: ids[0], in: partsDir)
check(!FileManager.default.fileExists(atPath: LLPartFile.url(for: ids[0], in: partsDir).path), "completed part deleted")
check(FileManager.default.fileExists(atPath: source.path), "the source file is untouched")
LLPartFile.remove(id: "never-existed", in: partsDir)
check(true, "removing an unknown id is a no-op")

// --- sweep: parts without a live task go, live ones stay, stale ones go regardless -------------
do {
    let stray = partsDir.appendingPathComponent("notes.txt")
    try! Data("x".utf8).write(to: stray)
    let removed = LLPartFile.sweep(partsDir, keeping: [ids[1]])
    let left = (try? FileManager.default.contentsOfDirectory(atPath: partsDir.path)) ?? []
    check(removed == 2, "sweep removed the orphan part and the stray file")
    check(left == ["\(ids[1]).part"], "sweep kept the part of the live task")
    let old = Date(timeIntervalSinceNow: LLPartFile.orphanAge + 60)
    check(LLPartFile.sweep(partsDir, keeping: [ids[1]], now: old) == 1, "a part older than a day is swept even when its task is live")
    check(((try? FileManager.default.contentsOfDirectory(atPath: partsDir.path)) ?? []).isEmpty, "parts directory empty after the uploads")
}

print(failures == 0 ? "PASS all part-file checks" : "FAIL \(failures) check(s)")
exit(failures == 0 ? 0 : 1)
