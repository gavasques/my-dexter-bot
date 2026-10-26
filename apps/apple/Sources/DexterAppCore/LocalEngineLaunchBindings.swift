#if os(macOS)
import CryptoKit
import Darwin
import Foundation

/// A private, immutable set of exact launcher aliases. Selected programs may share a directory with other versions;
/// the child PATH must resolve every selected name to its own captured target. This is not an OS sandbox.
struct LocalEngineLaunchBindings: Equatable, Sendable {
    let root: URL
    let directory: URL
    let names: [String: LocalEngineFileIdentity]

    init(root: URL, chosen: [LocalEngineKind: LocalEngineCandidate]) throws {
        guard root.isFileURL, LocalEngineDiscovery.normalizedDirectory(root.path) != nil else { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
        var names: [String: LocalEngineFileIdentity] = [:]
        for (kind, candidate) in chosen {
            for name in kind.launcherNames {
                guard names[name] == nil || names[name] == candidate.identity else { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
                names[name] = candidate.identity
            }
        }
        guard !names.isEmpty else { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
        struct Pin: Encodable { let name: String; let target: String; let device: UInt64; let inode: UInt64 }
        let material = names.keys.sorted().map { name in
            let identity = names[name]!
            return Pin(name: name, target: identity.resolvedPath, device: identity.device, inode: identity.inode)
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let hash = SHA256.hash(data: try encoder.encode(material)).map { String(format: "%02x", $0) }.joined()
        self.root = root; directory = root.appendingPathComponent(hash, isDirectory: true); self.names = names
    }

    /// Writes only missing aliases in an owned namespace. Existing different/foreign entries refuse; no target is
    /// copied, modified or deleted. FD-relative symlink creation prevents writing into a replaced directory.
    func prepare() throws {
        let parent = root.deletingLastPathComponent()
        guard parent.resolvingSymlinksInPath() == parent else { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
        for identity in names.values {
            guard LocalEngineDiscovery.fileIdentity(identity.resolvedPath) == identity else { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
        }
        if mkdir(root.path, 0o700) != 0, errno != EEXIST { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
        let parentFD = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard parentFD >= 0 else { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }; defer { close(parentFD) }
        try checkDirectory(parentFD, path: root)
        let name = directory.lastPathComponent
        if mkdirat(parentFD, name, 0o700) != 0, errno != EEXIST { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
        let fd = openat(parentFD, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }; defer { close(fd) }
        try checkDirectory(fd, path: directory)
        let entries = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        guard Set(entries).isSubset(of: Set(names.keys)) else { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
        // Validate every existing alias before creating any missing one.
        for name in entries { try checkAlias(fd, name: name, expected: names[name]!) }
        for name in names.keys.sorted() {
            let expected = names[name]!
            try checkDirectory(parentFD, path: root); try checkDirectory(fd, path: directory)
            if symlinkat(expected.resolvedPath, fd, name) != 0, errno != EEXIST { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
            try checkAlias(fd, name: name, expected: expected)
        }
        guard fsync(fd) == 0, fsync(parentFD) == 0 else { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
        try checkDirectory(fd, path: directory)
    }

    private func checkDirectory(_ fd: Int32, path: URL) throws {
        var opened = stat(), live = stat()
        guard fstat(fd, &opened) == 0, lstat(path.path, &live) == 0,
              opened.st_mode & S_IFMT == S_IFDIR, opened.st_uid == getuid(), opened.st_mode & 0o077 == 0,
              opened.st_dev == live.st_dev, opened.st_ino == live.st_ino, live.st_mode & S_IFMT == S_IFDIR else {
            throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied)
        }
    }
    private func checkAlias(_ fd: Int32, name: String, expected: LocalEngineFileIdentity) throws {
        var info = stat()
        guard fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0, info.st_mode & S_IFMT == S_IFLNK,
              info.st_uid == getuid(), info.st_size > 0, info.st_size <= 2048 else { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
        var buffer = [CChar](repeating: 0, count: 2049)
        let count = readlinkat(fd, name, &buffer, 2048)
        guard count > 0, count <= 2048 else { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
        let value = String(decoding: buffer.prefix(Int(count)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
        guard value == expected.resolvedPath, LocalEngineDiscovery.fileIdentity(value) == expected else { throw LocalHostFailure.invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
    }
}
#endif
