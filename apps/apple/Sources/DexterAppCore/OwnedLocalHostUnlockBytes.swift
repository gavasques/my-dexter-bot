#if os(macOS)
import Foundation
import Darwin

/// One-shot 32-byte buffer. No String/Codable/data property, logs, defaults, argv, clipboard or environment.
/// The consume pointer is borrowed only during the synchronous closure; explicit copies belong to their caller.
@MainActor public final class OwnedLocalHostUnlockBytes: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    nonisolated(unsafe) private let storage: UnsafeMutableRawPointer
    private var available = true
    public let creationId: String?
    public var hasValue: Bool { available }
    var clearedStorageIsZero: Bool { !available && UnsafeRawBufferPointer(start: storage, count: 32).allSatisfy { $0 == 0 } }
    public init?(bytes: Data, creationId: String? = nil) {
        guard bytes.count == 32 else { return nil }
        self.creationId = creationId
        storage = .allocate(byteCount: 32, alignment: 16)
        bytes.withUnsafeBytes { input in storage.copyMemory(from: input.baseAddress!, byteCount: 32) }
    }
    public func consume<T>(_ operation: (UnsafeRawBufferPointer) throws -> T) throws -> T {
        guard available else { throw LocalHostUnlockFailure.consumed }
        defer { clear() }
        return try operation(UnsafeRawBufferPointer(start: storage, count: 32))
    }
    public func clear() { _ = memset_s(storage, 32, 0, 32); available = false }
    public nonisolated var description: String { "OwnedLocalHostUnlockBytes(redacted)" }
    public nonisolated var debugDescription: String { "OwnedLocalHostUnlockBytes(redacted)" }
    public nonisolated var customMirror: Mirror { Mirror(self, children: ["value": "redacted"], displayStyle: .class) }
    deinit { _ = memset_s(storage, 32, 0, 32); storage.deallocate() }
}
#endif
