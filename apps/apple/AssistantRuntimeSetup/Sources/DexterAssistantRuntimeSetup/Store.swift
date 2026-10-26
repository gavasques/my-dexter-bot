import Foundation
#if os(macOS)
import Darwin

struct ArtifactRecord: Codable, Sendable, Equatable { let artifact: OfficialArtifact; let result: RuntimeSetupResult }
struct Journal: Codable, Sendable { let plan: SetupPlan; var receipt: SetupReceipt; let versionDirectory: String? }

/// Directory-relative exclusive writes and rename prevent link traversal and replacing immutable versions.
final class LocalSetupStore: @unchecked Sendable {
    let root: URL
    private let fd: Int32
    private let identity: FileIdentity
    private var lockFD: Int32 = -1
    init(root: URL, create: Bool) throws {
        guard root.isFileURL, root.path.hasPrefix("/"), !root.path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { throw SetupError.unsafePath }
        self.root = root
        fd = try Self.openDirectory(root.path, create: create)
        var status = stat(); guard fstat(fd, &status) == 0 else { close(fd); throw SetupError.storageFailure }
        guard status.st_uid == getuid(), status.st_mode & 0o077 == 0 else { close(fd); throw SetupError.unsafePath }
        identity = FileIdentity(status)
    }
    deinit { unlock(); close(fd) }
    static func openDirectory(_ path: String, create: Bool) throws -> Int32 {
        guard path.hasPrefix("/"), !path.contains("\0") else { throw SetupError.unsafePath }
        var current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard current >= 0 else { throw SetupError.storageFailure }
        do {
            for part in path.split(separator: "/").map(String.init) {
                guard part != "." && part != ".." else { throw SetupError.unsafePath }
                if create && mkdirat(current, part, 0o700) != 0 && errno != EEXIST { throw SetupError.storageFailure }
                let next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard next >= 0 else { throw SetupError.unsafePath }; close(current); current = next
            }
            return current
        } catch { close(current); throw error }
    }
    func assertCurrent() throws {
        let current = try Self.openDirectory(root.path, create: false); defer { close(current) }
        var status = stat(); guard fstat(current, &status) == 0,
            status.st_dev == identity.device, status.st_ino == identity.inode else { throw SetupError.artifactChanged }
    }
    func lock() throws {
        try assertCurrent()
        let candidate = openat(fd, ".install-lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard candidate >= 0 else { throw SetupError.unsafePath }
        var status = stat()
        guard fstat(candidate, &status) == 0, status.st_mode & S_IFMT == S_IFREG, status.st_uid == getuid(), status.st_nlink == 1,
              flock(candidate, LOCK_EX | LOCK_NB) == 0 else { close(candidate); throw SetupError.busy }
        lockFD = candidate
    }
    func unlock() { if lockFD >= 0 { _ = flock(lockFD, LOCK_UN); close(lockFD); lockFD = -1 } }
    func journalName(_ requestID: String) -> String { "receipt-" + digest(Data(requestID.utf8)) + ".json" }
    func readJournal(_ requestID: String) throws -> Journal? { try read(journalName(requestID), as: Journal.self) }
    func recoverableJournals(provider: AssistantProvider) throws -> [Journal] {
        try assertCurrent()
        guard let directory = fdopendir(dup(fd)) else { throw SetupError.storageFailure }; defer { closedir(directory) }
        var names: [String] = []; var count = 0
        while let entry = readdir(directory) {
            count += 1; guard count <= 4096 else { throw SetupError.oversized }
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if name.range(of: "^receipt-[a-f0-9]{64}\\.json$", options: .regularExpression) != nil { names.append(name) }
        }
        var journals: [Journal] = []
        for name in names.sorted() {
            guard let journal = try read(name, as: Journal.self), name == journalName(journal.plan.capture.requestID) else { throw SetupError.requestConflict }
            if journal.plan.provider == provider && [.preparing, .unknown].contains(journal.receipt.state) {
                journals.append(journal)
                // Never silently hide a pending operation. The caller must resolve an incomplete index.
                guard journals.count <= 64 else { throw SetupError.oversized }
            }
        }
        return journals
    }
    func writeJournal(_ journal: Journal) throws { try write(journal, name: journalName(journal.plan.capture.requestID)) }
    func read<T: Decodable>(_ name: String, as: T.Type, directory: Int32? = nil) throws -> T? {
        try assertCurrent(); try safeName(name)
        let handle = openat(directory ?? fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if handle < 0 && errno == ENOENT { return nil }; guard handle >= 0 else { throw SetupError.unsafePath }; defer { close(handle) }
        var status = stat()
        guard fstat(handle, &status) == 0, status.st_mode & S_IFMT == S_IFREG, status.st_uid == getuid(), status.st_nlink == 1,
              status.st_size > 0 && status.st_size <= 1024 * 1024 else { throw SetupError.unsafePath }
        let file = FileHandle(fileDescriptor: handle, closeOnDealloc: false)
        guard let bytes = try file.readToEnd(), bytes.count == status.st_size else { throw SetupError.storageFailure }
        return try JSONDecoder().decode(T.self, from: bytes)
    }
    func write<T: Encodable>(_ value: T, name: String, directory: Int32? = nil) throws {
        try assertCurrent(); try safeName(name); let directory = directory ?? fd
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(value); guard data.count <= 1024 * 1024 else { throw SetupError.oversized }
        let temporary = ".write-" + UUID().uuidString
        let handle = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard handle >= 0 else { throw SetupError.storageFailure }
        defer { close(handle); _ = unlinkat(directory, temporary, 0) }
        try FileHandle(fileDescriptor: handle, closeOnDealloc: false).write(contentsOf: data)
        guard fsync(handle) == 0, renameat(directory, temporary, directory, name) == 0, fsync(directory) == 0 else { throw SetupError.storageFailure }
    }
    func createStage() throws -> (String, Int32) {
        try assertCurrent(); let name = ".stage-" + UUID().uuidString
        guard mkdirat(fd, name, 0o700) == 0 else { throw SetupError.storageFailure }
        let stage = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard stage >= 0 else { throw SetupError.unsafePath }; return (name, stage)
    }
    func assertStage(_ name: String, handle: Int32) throws {
        try assertCurrent(); var path = stat(); var actual = stat()
        guard fstatat(fd, name, &path, AT_SYMLINK_NOFOLLOW) == 0, fstat(handle, &actual) == 0,
              path.st_mode & S_IFMT == S_IFDIR, path.st_uid == getuid(), path.st_mode & 0o077 == 0,
              path.st_ino == actual.st_ino && path.st_dev == actual.st_dev else { throw SetupError.artifactChanged }
    }
    func commitStage(_ stage: String, handle: Int32, version: String) throws {
        try assertStage(stage, handle: handle); try safeName(version)
        guard fsync(handle) == 0, renameatx_np(fd, stage, fd, version, UInt32(RENAME_EXCL)) == 0,
              fsync(fd) == 0 else { throw SetupError.commitUnknown }
        try assertCurrent()
    }
    func record(_ version: String) throws -> ArtifactRecord? {
        try assertCurrent(); try safeName(version)
        let dir = openat(fd, version, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if dir < 0 && errno == ENOENT { return nil }; guard dir >= 0 else { throw SetupError.unsafePath }; defer { close(dir) }
        return try read("artifact.json", as: ArtifactRecord.self, directory: dir)
    }
    func removeOwnStage(_ name: String, handle: Int32) {
        guard (try? assertStage(name, handle: handle)) != nil else { return }
        // Only these three files can belong to our stage; never recursive cleanup of an untrusted directory.
        for entry in ["download", "claude", "codex", "artifact.json"] { _ = unlinkat(handle, entry, 0) }
        _ = unlinkat(fd, name, AT_REMOVEDIR)
    }
    func versionName(_ artifact: OfficialArtifact) -> String { "\(artifact.provider.rawValue)-\(artifact.version)-\(artifact.architecture)-\(artifact.sha256.prefix(16))" }
    private func safeName(_ value: String) throws {
        guard !value.isEmpty, value.utf8.count <= 240, value != ".", value != "..", !value.contains("/"), !value.contains("\0") else { throw SetupError.unsafePath }
    }
}
#endif
