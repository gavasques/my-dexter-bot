import CryptoKit
import Foundation
import LocalAuthentication
import Security

public enum BrowserUseKeyStatus: String, Sendable { case configured, missing, unavailable }
public enum BrowserUseKeyFailure: Error, Equatable, Sendable {
    case invalidConfiguration, keyMissing, keyUnavailable, bridgeUnavailable, bridgeUnconfirmed
}
public enum BrowserUseKeyValidation {
    public static func isValid(_ key: String) -> Bool {
        (16...512).contains(key.utf8.count) && key.unicodeScalars.allSatisfy { (33...126).contains($0.value) }
    }
}

/// A single host-scoped Browser Use key. No enumeration of unrelated Keychain items.
@MainActor public protocol BrowserUseAPIKeyStore: AnyObject {
    func status(hostID: String) -> BrowserUseKeyStatus
    func load(hostID: String) throws -> String
    func save(_ key: String, hostID: String) throws
    func remove(hostID: String) throws
}

/// Dedicated classic Mac Keychain namespace, non-synchronizing. API credentials never enter
/// Codable host config, defaults, argv, environment, clipboard exports or the bot's context.
@MainActor public final class ScopedBrowserUseAPIKeychain: BrowserUseAPIKeyStore {
    public static let service = "com.dexter.browseruse.api-key"
    public init() {}
    private func query(hostID: String, interaction: Bool = false) throws -> [CFString: Any] {
        guard !hostID.isEmpty, hostID.utf8.count <= 128,
              !hostID.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { throw BrowserUseKeyFailure.invalidConfiguration }
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
        request[kSecReturnAttributes] = true
        if data { request[kSecReturnData] = true }
        request[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let value = result as? [CFString: Any],
              value[kSecAttrService] as? String == Self.service,
              value[kSecAttrAccount] as? String == request[kSecAttrAccount] as? String,
              value[kSecAttrSynchronizable] as? Bool != true else { throw BrowserUseKeyFailure.keyUnavailable }
        return value
    }
    public func status(hostID: String) -> BrowserUseKeyStatus {
        do { return try item(hostID: hostID, data: false) == nil ? .missing : .configured }
        catch { return .unavailable }
    }
    public func load(hostID: String) throws -> String {
        // Human Unlock only. Listing settings never requests kSecReturnData.
        guard let item = try item(hostID: hostID, data: true, interaction: true) else { throw BrowserUseKeyFailure.keyMissing }
        guard let bytes = item[kSecValueData] as? Data, let key = String(data: bytes, encoding: .utf8),
              BrowserUseKeyValidation.isValid(key) else { throw BrowserUseKeyFailure.keyUnavailable }
        return key
    }
    public func save(_ key: String, hostID: String) throws {
        guard BrowserUseKeyValidation.isValid(key) else { throw BrowserUseKeyFailure.invalidConfiguration }
        let request = try query(hostID: hostID, interaction: true)
        if try item(hostID: hostID, data: false, interaction: true) != nil {
            guard SecItemUpdate(request as CFDictionary, [kSecValueData: Data(key.utf8)] as CFDictionary) == errSecSuccess else { throw BrowserUseKeyFailure.keyUnavailable }
        } else {
            var attributes = request
            attributes[kSecValueData] = Data(key.utf8); attributes[kSecAttrLabel] = "Dexter · Browser Use"
            #if !os(macOS)
            attributes[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            #endif
            guard SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess else { throw BrowserUseKeyFailure.keyUnavailable }
        }
    }
    public func remove(hostID: String) throws {
        let result = SecItemDelete(try query(hostID: hostID, interaction: true) as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else { throw BrowserUseKeyFailure.keyUnavailable }
    }
}

/// Injectable QA custody; never touches real accounts or Keychain.
@MainActor public final class InMemoryBrowserUseAPIKeyStore: BrowserUseAPIKeyStore {
    private var keys: [String: String] = [:]
    public init() {}
    public func status(hostID: String) -> BrowserUseKeyStatus { keys[hostID] == nil ? .missing : .configured }
    public func load(hostID: String) throws -> String {
        guard let key = keys[hostID] else { throw BrowserUseKeyFailure.keyMissing }; return key
    }
    public func save(_ key: String, hostID: String) throws {
        guard BrowserUseKeyValidation.isValid(key) else { throw BrowserUseKeyFailure.invalidConfiguration }; keys[hostID] = key
    }
    public func remove(hostID: String) throws { keys.removeValue(forKey: hostID) }
}

extension DexterAppModel {
    /// Current owner projection only. A UI-supplied address cannot substitute for host identity.
    public var browserUseHostID: String? { canEditBotProfiles ? nativeProjectionHostID : nil }
}
