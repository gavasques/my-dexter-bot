import CryptoKit
import Foundation
import LocalAuthentication
import Security

public enum AvatarImageKeyStatus: String, Sendable { case configured, missing, unavailable }
public enum AvatarImageKeyValidation {
    public static func isValid(_ value: String) -> Bool {
        (16...512).contains(value.utf8.count) && value.hasPrefix("sk-")
        && value.unicodeScalars.allSatisfy { (33...126).contains($0.value) }
    }
}

/// Dedicated host-scoped custody. Keys never cross the Dexter host API or enter avatar metadata.
@MainActor public protocol AvatarImageAPIKeyStore: AnyObject {
    func status(hostID: String) -> AvatarImageKeyStatus
    func load(hostID: String) throws -> String
    func save(_ key: String, hostID: String) throws
    func remove(hostID: String) throws
}

@MainActor public final class ScopedAvatarImageAPIKeychain: AvatarImageAPIKeyStore {
    public static let service = "com.dexter.openai.avatar.api-key"
    public init() {}
    private func query(hostID: String, interaction: Bool = false) throws -> [CFString: Any] {
        guard !hostID.isEmpty, hostID.utf8.count <= 128,
              !hostID.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
        else { throw AvatarImageFailure.invalidConfiguration }
        let digest = SHA256.hash(data: Data(hostID.utf8)).map { String(format: "%02x", $0) }.joined()
        let context = LAContext(); context.interactionNotAllowed = !interaction
        var value: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: Self.service,
            kSecAttrAccount: "host-" + digest, kSecAttrSynchronizable: false, kSecUseAuthenticationContext: context]
        #if os(macOS)
        value[kSecUseDataProtectionKeychain] = false
        #else
        value[kSecUseDataProtectionKeychain] = true
        #endif
        return value
    }
    private func item(hostID: String, data: Bool, interaction: Bool = false) throws -> [CFString: Any]? {
        var request = try query(hostID: hostID, interaction: interaction)
        request[kSecReturnAttributes] = true; request[kSecMatchLimit] = kSecMatchLimitOne
        if data { request[kSecReturnData] = true }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let value = result as? [CFString: Any],
              value[kSecAttrService] as? String == Self.service,
              value[kSecAttrAccount] as? String == request[kSecAttrAccount] as? String,
              value[kSecAttrSynchronizable] as? Bool != true else { throw AvatarImageFailure.keyUnavailable }
        return value
    }
    public func status(hostID: String) -> AvatarImageKeyStatus {
        do { return try item(hostID: hostID, data: false) == nil ? .missing : .configured }
        catch { return .unavailable }
    }
    public func load(hostID: String) throws -> String {
        // Secret bytes are requested only after the human explicitly starts generation.
        guard let item = try item(hostID: hostID, data: true, interaction: true) else { throw AvatarImageFailure.keyMissing }
        guard let bytes = item[kSecValueData] as? Data, let key = String(data: bytes, encoding: .utf8),
              AvatarImageKeyValidation.isValid(key) else { throw AvatarImageFailure.keyUnavailable }
        return key
    }
    public func save(_ key: String, hostID: String) throws {
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard AvatarImageKeyValidation.isValid(key) else { throw AvatarImageFailure.invalidConfiguration }
        let request = try query(hostID: hostID, interaction: true)
        if try item(hostID: hostID, data: false, interaction: true) != nil {
            guard SecItemUpdate(request as CFDictionary, [kSecValueData: Data(key.utf8)] as CFDictionary) == errSecSuccess
            else { throw AvatarImageFailure.keyUnavailable }
        } else {
            var attributes = request
            attributes[kSecValueData] = Data(key.utf8); attributes[kSecAttrLabel] = "Dexter · OpenAI Avatar"
            #if !os(macOS)
            attributes[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            #endif
            guard SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess else { throw AvatarImageFailure.keyUnavailable }
        }
    }
    public func remove(hostID: String) throws {
        let status = SecItemDelete(try query(hostID: hostID, interaction: true) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw AvatarImageFailure.keyUnavailable }
    }
}

/// Isolated QA implementation: no access to existing keys or accounts.
@MainActor public final class InMemoryAvatarImageAPIKeyStore: AvatarImageAPIKeyStore {
    private var keys: [String: String] = [:]
    public init() {}
    public func status(hostID: String) -> AvatarImageKeyStatus { keys[hostID] == nil ? .missing : .configured }
    public func load(hostID: String) throws -> String {
        guard let value = keys[hostID] else { throw AvatarImageFailure.keyMissing }; return value
    }
    public func save(_ key: String, hostID: String) throws {
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !hostID.isEmpty, hostID.utf8.count <= 128, AvatarImageKeyValidation.isValid(key)
        else { throw AvatarImageFailure.invalidConfiguration }
        keys[hostID] = key
    }
    public func remove(hostID: String) throws { keys.removeValue(forKey: hostID) }
}
