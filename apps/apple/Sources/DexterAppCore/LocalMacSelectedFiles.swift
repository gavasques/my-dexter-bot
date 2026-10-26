#if os(macOS)
import Darwin
import Foundation
import Security

/// Owner-selected files per bot for `mac.file.read` / `mac.file.append`, kept in a private policy separate from
/// the browser/CUA `policy.json`. Selecting a file records metadata only (path, device, inode, fence): it never
/// reads the file. Nothing here grants a host tool; the daemon re-validates identity and the host still approves.
public enum LocalMacSelectedFilesError: Error, Equatable, Sendable {
    case invalidInput, unsafeFile, unsafeLocation, hostMismatch, conflict, agentMustBeStopped
    case notEnabled, alreadyEnabled, duplicateName, limitReached, writeFailed
    /// A replace may or may not have landed. Reread and ask the owner again; never repeat automatically.
    case outcomeUnknown
}

public struct LocalMacSelectedFile: Equatable, Sendable {
    public static let operations = ["mac.file.read", "mac.file.append"]
    public let name: String
    public let operations: [String]
    /// Last path component only, for previews. The full path stays in the private policy.
    public var displayName: String { (path as NSString).lastPathComponent }
    fileprivate let path: String
    fileprivate let device: String
    fileprivate let inode: String
    fileprivate let fence: String
}

public struct LocalMacSelectedFileBot: Equatable, Sendable {
    public let botID: String
    public let files: [LocalMacSelectedFile]
}

/// Metadata of one existing regular file chosen by the owner. Never opened for reading content.
public struct LocalMacSelectedFileCandidate: Equatable, Sendable {
    public var displayName: String { (path as NSString).lastPathComponent }
    fileprivate let path: String
    fileprivate let device: String
    fileprivate let inode: String
}

public struct LocalMacSelectedFilesSnapshot: Equatable, Sendable {
    /// Config carries `files.policyPath` for the generated policy. Capabilities alone do not enable files.
    public let enabled: Bool
    public let capabilities: [String]
    public let bots: [LocalMacSelectedFileBot]
    public let selection: LocalMacAgentSelection
    fileprivate let installationID: String
    fileprivate let trust: LocalMacAgentPolicySnapshot
    fileprivate let config: Data
    fileprivate let policy: Data?

    public func files(for botID: String) -> [LocalMacSelectedFile] { bots.first { $0.botID == botID }?.files ?? [] }
}

/// Result of enabling: the config changed, so callers must adopt the new selection.
public struct LocalMacSelectedFilesEnablement: Sendable {
    public let selection: LocalMacAgentSelection
    public let snapshot: LocalMacSelectedFilesSnapshot
}

public enum LocalMacSelectedFiles {
    public static let policyFileName = "selected-files.json"
    public static let maximumBots = 64
    public static let maximumFilesPerBot = 8
    public static let maximumFiles = 128
    static let namePattern = "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
    private static let policyBytes = 256 * 1024
    private static let configBytes = 16384

    // MARK: - Read

    /// Read-only. Trust of the generated layout comes from `LocalMacAgentPolicy.read`; no file is created.
    public static func read(selection: LocalMacAgentSelection, expectedInstallationID: String) throws -> LocalMacSelectedFilesSnapshot {
        let trust: LocalMacAgentPolicySnapshot
        do { trust = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: expectedInstallationID) }
        catch LocalMacAgentPolicyError.conflict { throw LocalMacSelectedFilesError.conflict }
        catch LocalMacAgentPolicyError.hostMismatch { throw LocalMacSelectedFilesError.hostMismatch }
        catch { throw LocalMacSelectedFilesError.unsafeLocation }
        let root = selection.configurationURL.deletingLastPathComponent()
        let config = try privateRead(selection.configurationURL, maximum: configBytes)
        guard let object = try? JSONSerialization.jsonObject(with: config) as? [String: Any],
              let capabilities = object["capabilities"] as? [String] else { throw LocalMacSelectedFilesError.hostMismatch }
        let enabled: Bool
        switch object["files"] {
        case nil, is NSNull: enabled = false
        case let files as [String: Any]:
            guard Set(files.keys) == ["policyPath"], files["policyPath"] as? String == policyURL(root).path else {
                throw LocalMacSelectedFilesError.hostMismatch
            }
            enabled = true
        default: throw LocalMacSelectedFilesError.hostMismatch
        }
        var info = stat()
        var policy: Data?
        if lstat(policyURL(root).path, &info) == 0 { policy = try privateRead(policyURL(root), maximum: policyBytes) }
        else if errno != ENOENT { throw LocalMacSelectedFilesError.unsafeLocation }
        let bots = try policy.map { try parse($0, installationID: expectedInstallationID, root: root) } ?? []
        // Bytes must still match the selection the caller holds (no edit between selection and read).
        guard try LocalMacAgentSelection(configurationURL: selection.configurationURL) == selection else {
            throw LocalMacSelectedFilesError.conflict
        }
        return LocalMacSelectedFilesSnapshot(enabled: enabled, capabilities: capabilities, bots: bots, selection: selection,
                                             installationID: expectedInstallationID, trust: trust, config: config, policy: policy)
    }

    /// Metadata only: open with O_NOFOLLOW for fstat, never read. Existing regular file, one link, owned by the
    /// operator, canonical path without symlinked parents, outside the generated agent root.
    public static func inspect(_ url: URL, selection: LocalMacAgentSelection) throws -> LocalMacSelectedFileCandidate {
        let path = url.path
        let root = selection.configurationURL.deletingLastPathComponent().path
        guard url.isFileURL, validPath(path), path != root, !path.hasPrefix(root + "/"),
              LocalMacAgentSetup.canonical(url), LocalMacAgentSetup.realDirectories(url.deletingLastPathComponent()) else {
            throw LocalMacSelectedFilesError.unsafeFile
        }
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw LocalMacSelectedFilesError.unsafeFile }
        defer { close(fd) }
        var opened = stat(), linked = stat()
        guard fstat(fd, &opened) == 0, opened.st_mode & S_IFMT == S_IFREG, opened.st_nlink == 1, opened.st_uid == getuid(),
              lstat(path, &linked) == 0, linked.st_dev == opened.st_dev, linked.st_ino == opened.st_ino else {
            throw LocalMacSelectedFilesError.unsafeFile
        }
        return LocalMacSelectedFileCandidate(path: path, device: deviceDecimal(opened.st_dev), inode: String(opened.st_ino))
    }

    /// Node `fs.statSync(p, {bigint: true}).dev` on macOS: libuv widens the signed 32-bit `dev_t` to uint64.
    /// Equivalent TS: `BigInt.asUintN(64, stats.dev).toString()`.
    static func deviceDecimal(_ device: dev_t) -> String { String(UInt64(bitPattern: Int64(device))) }

    // MARK: - Owner mutations (caller confirmed the owned agent stopped/exited with no live child)

    /// Explicit owner action. Policy first (exclusive create, deny-by-default), then config gains
    /// `files.policyPath` and both file capabilities. A policy without config entry is inactive.
    public static func enable(expectedSnapshot expected: LocalMacSelectedFilesSnapshot,
                              agentStopped: Bool) throws -> LocalMacSelectedFilesEnablement {
        guard agentStopped else { throw LocalMacSelectedFilesError.agentMustBeStopped }
        guard !expected.enabled else { throw LocalMacSelectedFilesError.alreadyEnabled }
        try requireUnchanged(expected)
        let root = expected.selection.configurationURL.deletingLastPathComponent()
        var current = expected
        if expected.policy == nil {
            let empty = try encode([], installationID: expected.installationID)
            try replace(empty, in: root, name: policyFileName, expectedExisting: false) { try requireUnchanged(expected) }
            current = try rereadAfterWrite(expected.selection, expected.installationID)
            guard current.policy == empty, current.config == expected.config else { throw LocalMacSelectedFilesError.outcomeUnknown }
        }
        guard var object = try? JSONSerialization.jsonObject(with: current.config) as? [String: Any],
              var capabilities = object["capabilities"] as? [String] else { throw LocalMacSelectedFilesError.hostMismatch }
        for capability in LocalMacSelectedFile.operations where !capabilities.contains(capability) { capabilities.append(capability) }
        guard capabilities.count <= 8 else { throw LocalMacSelectedFilesError.limitReached }
        object["capabilities"] = capabilities
        object["files"] = ["policyPath": policyURL(root).path]
        let config = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        guard config.count <= configBytes else { throw LocalMacSelectedFilesError.limitReached }
        let snapshotBeforeConfig = current
        try replace(config, in: root, name: expected.selection.configurationURL.lastPathComponent, expectedExisting: true) {
            try requireUnchanged(snapshotBeforeConfig)
        }
        do {
            let selection = try LocalMacAgentSelection(configurationURL: expected.selection.configurationURL)
            let snapshot = try read(selection: selection, expectedInstallationID: expected.installationID)
            guard snapshot.enabled, snapshot.config == config else { throw LocalMacSelectedFilesError.outcomeUnknown }
            return LocalMacSelectedFilesEnablement(selection: selection, snapshot: snapshot)
        } catch { throw LocalMacSelectedFilesError.outcomeUnknown }
    }

    /// Adds one alias for a bot with a fresh fence. Refuses an existing alias (remove first) or the same path twice.
    public static func addFile(botID: String, name: String, candidate: LocalMacSelectedFileCandidate, operations: [String],
                               expectedSnapshot expected: LocalMacSelectedFilesSnapshot, agentStopped: Bool) throws -> LocalMacSelectedFilesSnapshot {
        guard LocalMacAgentSetup.matches(botID, LocalMacAgentSetup.wireID), LocalMacAgentSetup.matches(name, namePattern),
              !operations.isEmpty, Set(operations).count == operations.count,
              operations.allSatisfy(LocalMacSelectedFile.operations.contains) else { throw LocalMacSelectedFilesError.invalidInput }
        // Candidate identity must still hold at write time; content is never read.
        guard try inspect(URL(fileURLWithPath: candidate.path), selection: expected.selection) == candidate else {
            throw LocalMacSelectedFilesError.unsafeFile
        }
        var bots = expected.bots
        var files = expected.files(for: botID)
        guard !files.contains(where: { $0.name == name }) else { throw LocalMacSelectedFilesError.duplicateName }
        guard !files.contains(where: { $0.path == candidate.path }) else { throw LocalMacSelectedFilesError.duplicateName }
        guard files.count < maximumFilesPerBot else { throw LocalMacSelectedFilesError.limitReached }
        guard bots.reduce(0, { $0 + $1.files.count }) < maximumFiles else { throw LocalMacSelectedFilesError.limitReached }
        files.append(LocalMacSelectedFile(name: name, operations: LocalMacSelectedFile.operations.filter(operations.contains),
                                          path: candidate.path, device: candidate.device, inode: candidate.inode, fence: try fence()))
        bots.removeAll { $0.botID == botID }
        bots.append(LocalMacSelectedFileBot(botID: botID, files: files))
        guard bots.count <= maximumBots else { throw LocalMacSelectedFilesError.limitReached }
        return try save(bots, expected: expected, agentStopped: agentStopped)
    }

    public static func removeFile(botID: String, name: String, expectedSnapshot expected: LocalMacSelectedFilesSnapshot,
                                  agentStopped: Bool) throws -> LocalMacSelectedFilesSnapshot {
        let files = expected.files(for: botID)
        guard files.contains(where: { $0.name == name }) else { throw LocalMacSelectedFilesError.invalidInput }
        var bots = expected.bots.filter { $0.botID != botID }
        let kept = files.filter { $0.name != name }
        if !kept.isEmpty { bots.append(LocalMacSelectedFileBot(botID: botID, files: kept)) }
        return try save(bots, expected: expected, agentStopped: agentStopped)
    }

    // MARK: - Private

    static func policyURL(_ root: URL) -> URL { root.appendingPathComponent(policyFileName) }

    private static func save(_ bots: [LocalMacSelectedFileBot], expected: LocalMacSelectedFilesSnapshot,
                             agentStopped: Bool) throws -> LocalMacSelectedFilesSnapshot {
        guard agentStopped else { throw LocalMacSelectedFilesError.agentMustBeStopped }
        guard expected.enabled, expected.policy != nil else { throw LocalMacSelectedFilesError.notEnabled }
        let bytes = try encode(bots, installationID: expected.installationID)
        guard bytes.count <= policyBytes else { throw LocalMacSelectedFilesError.limitReached }
        let root = expected.selection.configurationURL.deletingLastPathComponent()
        try replace(bytes, in: root, name: policyFileName, expectedExisting: true) { try requireUnchanged(expected) }
        let result = try rereadAfterWrite(expected.selection, expected.installationID)
        guard result.policy == bytes, result.config == expected.config else { throw LocalMacSelectedFilesError.outcomeUnknown }
        return result
    }

    private static func requireUnchanged(_ expected: LocalMacSelectedFilesSnapshot) throws {
        guard try read(selection: expected.selection, expectedInstallationID: expected.installationID) == expected else {
            throw LocalMacSelectedFilesError.conflict
        }
    }

    private static func rereadAfterWrite(_ selection: LocalMacAgentSelection, _ installationID: String) throws -> LocalMacSelectedFilesSnapshot {
        do { return try read(selection: selection, expectedInstallationID: installationID) }
        catch { throw LocalMacSelectedFilesError.outcomeUnknown }
    }

    private static func fence() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw LocalMacSelectedFilesError.writeFailed }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Absolute, canonical-looking string: no empty/`.`/`..` segments, no controls, bounded.
    private static func validPath(_ path: String) -> Bool {
        guard path.hasPrefix("/"), path.count > 1, path.utf8.count <= 1024, !path.hasSuffix("/"),
              !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return false }
        return !path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).contains { $0.isEmpty || $0 == "." || $0 == ".." }
    }

    private static func parse(_ bytes: Data, installationID: String, root: URL) throws -> [LocalMacSelectedFileBot] {
        func number(_ value: Any?) -> Bool {
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
            return number.doubleValue == 1
        }
        func decimal(_ value: Any?) -> String? {
            guard let text = value as? String, LocalMacAgentSetup.matches(text, "^(0|[1-9][0-9]{0,19})$"), UInt64(text) != nil else { return nil }
            return text
        }
        guard let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(object.keys) == ["version", "installationId", "bots"], number(object["version"]),
              object["installationId"] as? String == installationID,
              let rawBots = object["bots"] as? [[String: Any]], rawBots.count <= maximumBots else {
            throw LocalMacSelectedFilesError.hostMismatch
        }
        let bots = try rawBots.map { raw -> LocalMacSelectedFileBot in
            guard Set(raw.keys) == ["botId", "files"], let botID = raw["botId"] as? String,
                  LocalMacAgentSetup.matches(botID, LocalMacAgentSetup.wireID),
                  let rawFiles = raw["files"] as? [[String: Any]], (1...maximumFilesPerBot).contains(rawFiles.count) else {
                throw LocalMacSelectedFilesError.invalidInput
            }
            let files = try rawFiles.map { file -> LocalMacSelectedFile in
                guard Set(file.keys) == ["name", "path", "operations", "identity", "fence"],
                      let name = file["name"] as? String, LocalMacAgentSetup.matches(name, namePattern),
                      let path = file["path"] as? String, validPath(path),
                      path != root.path, !path.hasPrefix(root.path + "/"),
                      let operations = file["operations"] as? [String], !operations.isEmpty,
                      Set(operations).count == operations.count, operations.allSatisfy(LocalMacSelectedFile.operations.contains),
                      let identity = file["identity"] as? [String: Any], Set(identity.keys) == ["device", "inode"],
                      let device = decimal(identity["device"]), let inode = decimal(identity["inode"]),
                      let fence = file["fence"] as? String, LocalMacAgentSetup.matches(fence, "^[0-9a-f]{32}$") else {
                    throw LocalMacSelectedFilesError.invalidInput
                }
                return LocalMacSelectedFile(name: name, operations: operations, path: path, device: device, inode: inode, fence: fence)
            }
            guard Set(files.map(\.name)).count == files.count, Set(files.map(\.path)).count == files.count else {
                throw LocalMacSelectedFilesError.invalidInput
            }
            return LocalMacSelectedFileBot(botID: botID, files: files)
        }
        guard Set(bots.map(\.botID)).count == bots.count,
              bots.reduce(0, { $0 + $1.files.count }) <= maximumFiles else {
            throw LocalMacSelectedFilesError.invalidInput
        }
        return bots
    }

    private static func encode(_ bots: [LocalMacSelectedFileBot], installationID: String) throws -> Data {
        let object: [String: Any] = [
            "version": 1, "installationId": installationID,
            "bots": bots.sorted { $0.botID < $1.botID }.map { bot in
                ["botId": bot.botID, "files": bot.files.map { file in
                    ["name": file.name, "path": file.path, "operations": file.operations,
                     "identity": ["device": file.device, "inode": file.inode], "fence": file.fence] as [String: Any]
                }] as [String: Any]
            },
        ]
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    /// Atomic private replace inside the generated root: exclusive 0600 temp, fsync, CAS check, rename, dir fsync.
    /// `expectedExisting == false` never overwrites (RENAME_EXCL). Failures after rename are `outcomeUnknown`.
    private static func replace(_ bytes: Data, in root: URL, name: String, expectedExisting: Bool,
                                check: () throws -> Void) throws {
        let directory = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw LocalMacSelectedFilesError.unsafeLocation }
        defer { close(directory) }
        var opened = stat()
        guard fstat(directory, &opened) == 0, opened.st_uid == getuid(), opened.st_mode & 0o777 == 0o700 else {
            throw LocalMacSelectedFilesError.unsafeLocation
        }
        var target = stat()
        if fstatat(directory, name, &target, AT_SYMLINK_NOFOLLOW) == 0 {
            guard expectedExisting, target.st_mode & S_IFMT == S_IFREG, target.st_uid == getuid(), target.st_nlink == 1,
                  target.st_mode & 0o777 == 0o600 else { throw LocalMacSelectedFilesError.conflict }
        } else if errno != ENOENT || expectedExisting { throw LocalMacSelectedFilesError.conflict }
        let temporary = ".selected-files-\(UUID().uuidString).tmp"
        let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw LocalMacSelectedFilesError.writeFailed }
        var renamed = false
        defer { close(fd); if !renamed { unlinkat(directory, temporary, 0) } }
        let written = bytes.withUnsafeBytes { write(fd, $0.baseAddress, bytes.count) }
        guard written == bytes.count, fchmod(fd, 0o600) == 0, fsync(fd) == 0 else { throw LocalMacSelectedFilesError.writeFailed }
        try check()
        var current = stat()
        guard lstat(root.path, &current) == 0, current.st_dev == opened.st_dev, current.st_ino == opened.st_ino else {
            throw LocalMacSelectedFilesError.conflict
        }
        let result = expectedExisting
            ? renameat(directory, temporary, directory, name)
            : renameatx_np(directory, temporary, directory, name, UInt32(RENAME_EXCL))
        guard result == 0 else { throw errno == EEXIST ? LocalMacSelectedFilesError.conflict : LocalMacSelectedFilesError.writeFailed }
        renamed = true
        guard fsync(directory) == 0 else { throw LocalMacSelectedFilesError.outcomeUnknown }
    }

    private static func privateRead(_ url: URL, maximum: Int) throws -> Data {
        guard LocalMacAgentSetup.canonical(url.deletingLastPathComponent()),
              LocalMacAgentSetup.realDirectories(url.deletingLastPathComponent()) else { throw LocalMacSelectedFilesError.unsafeLocation }
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw LocalMacSelectedFilesError.unsafeLocation }
        defer { close(fd) }
        var before = stat()
        guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_uid == getuid(), before.st_nlink == 1,
              before.st_mode & 0o777 == 0o600, before.st_size > 0, before.st_size <= maximum else {
            throw LocalMacSelectedFilesError.unsafeLocation
        }
        let bytes = try FileHandle(fileDescriptor: fd, closeOnDealloc: false).read(upToCount: maximum + 1) ?? Data()
        var after = stat()
        guard bytes.count == before.st_size, fstat(fd, &after) == 0, after.st_ino == before.st_ino, after.st_size == before.st_size,
              after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec, after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec else {
            throw LocalMacSelectedFilesError.conflict
        }
        return bytes
    }
}
#endif
