#if os(macOS)
import Foundation
import CryptoKit
import Darwin

public enum LocalHostUnlockFailure: String, Error, Equatable, Sendable {
    case invalidScope, scopeMismatch, signingIdentityUnavailable, alreadyExists, legacyPasswordRequired
    case missing, locked, unavailable, conflict, outcomeUnknown, consumed
}
public enum LocalHostUnlockStatus: String, Sendable { case missing, configured, legacyPasswordRequired, blocked }
public struct LocalHostUnlockScope: Equatable, Hashable, Sendable {
    public let bundleID: String
    public let custodyFilePath: String
    public init(bundleID: String, custodyFilePath: String) throws {
        guard !bundleID.isEmpty, bundleID.utf8.count <= 256, bundleID.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]*$", options: .regularExpression) != nil,
              !bundleID.contains(".."), custodyFilePath.hasPrefix("/"), custodyFilePath.utf8.count <= 1024,
              !custodyFilePath.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              custodyFilePath.split(separator: "/", omittingEmptySubsequences: false).dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw LocalHostUnlockFailure.invalidScope }
        self.bundleID = bundleID; self.custodyFilePath = custodyFilePath
        _ = try fileState()
    }
    public static func standard(bundleID: String) throws -> LocalHostUnlockScope {
        guard let path = LocalDeviceCustodyPreference.defaultFilePath else { throw LocalHostUnlockFailure.invalidScope }
        return try LocalHostUnlockScope(bundleID: bundleID, custodyFilePath: path)
    }
    public var keychainService: String {
        "com.dexter.local-host-unlock.v1.bundle." + unlockHash(bundleID) + ".custody." + unlockHash(custodyFilePath)
    }
    public static let keychainAccount = "local-host-unlock-32-v1"
    /// Metadata only; no ciphertext/key read, directory creation or OS isolation claim.
    func fileState() throws -> LocalHostUnlockFileState {
        var current = "/"; let parts = custodyFilePath.split(separator: "/").map(String.init)
        for (index, part) in parts.enumerated() {
            current += current == "/" ? part : "/" + part
            var value = stat()
            if lstat(current, &value) != 0 {
                guard errno == ENOENT else { throw LocalHostUnlockFailure.invalidScope }
                // A nonexistent tail is canonical only when its nearest existing ancestor is canonical.
                let ancestor = (current as NSString).deletingLastPathComponent
                guard let resolved = realpath(ancestor, nil) else { throw LocalHostUnlockFailure.invalidScope }
                defer { free(resolved) }
                guard String(cString: resolved) == ancestor else { throw LocalHostUnlockFailure.invalidScope }
                return .absent
            }
            guard value.st_mode & S_IFMT != S_IFLNK else { throw LocalHostUnlockFailure.invalidScope }
            if index < parts.count - 1 {
                guard value.st_mode & S_IFMT == S_IFDIR else { throw LocalHostUnlockFailure.invalidScope }
            } else {
                guard value.st_mode & S_IFMT == S_IFREG, value.st_uid == getuid(), value.st_nlink == 1,
                      value.st_mode & 0o777 == 0o600, value.st_size > 0, value.st_size <= 8 * 1024 * 1024 else { throw LocalHostUnlockFailure.conflict }
                guard let resolved = realpath(custodyFilePath, nil) else { throw LocalHostUnlockFailure.invalidScope }
                defer { free(resolved) }
                guard String(cString: resolved) == custodyFilePath else { throw LocalHostUnlockFailure.invalidScope }
                return .present(device: value.st_dev, inode: value.st_ino, bytes: value.st_size,
                    modified: Int64(value.st_mtimespec.tv_sec), nanoseconds: Int64(value.st_mtimespec.tv_nsec))
            }
        }
        throw LocalHostUnlockFailure.invalidScope
    }
}
enum LocalHostUnlockFileState: Equatable { case absent, present(device: Int32, inode: UInt64, bytes: Int64, modified: Int64, nanoseconds: Int64) }
private func unlockHash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
#endif
