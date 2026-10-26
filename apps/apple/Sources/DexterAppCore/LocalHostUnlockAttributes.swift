#if os(macOS)
import Foundation
import Security
import CryptoKit

public struct LocalHostUnlockCreationInfo: Equatable, Sendable {
    public let creationId: String
    public let requestHash: String
}

/// Pure exact attribute builder. Authentication context is attached only by the native backend.
public enum LocalHostUnlockAttributes {
    public static func query(scope: LocalHostUnlockScope, accessGroup: String, returnsValue: Bool) -> [CFString: Any] {
        var query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: scope.keychainService,
            kSecAttrAccount: LocalHostUnlockScope.keychainAccount, kSecAttrAccessGroup: accessGroup,
            kSecAttrSynchronizable: false, kSecUseDataProtectionKeychain: true,
            kSecReturnAttributes: true, kSecMatchLimit: kSecMatchLimitOne]
        if returnsValue { query[kSecReturnData] = true }
        return query
    }
    public static func creation(scope: LocalHostUnlockScope, accessGroup: String, creationId: String? = nil) throws -> [CFString: Any] {
        var attributes: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: scope.keychainService,
         kSecAttrAccount: LocalHostUnlockScope.keychainAccount, kSecAttrAccessGroup: accessGroup,
         kSecAttrSynchronizable: false, kSecUseDataProtectionKeychain: true,
         kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
         kSecAttrLabel: "Dexter · Local host unlock"]
        if let creationId { attributes[kSecAttrGeneric] = try creationMetadata(scope: scope, creationId: creationId) }
        return attributes
    }
    static func normalizedCreationId(_ value: String) throws -> String {
        guard let id = UUID(uuidString: value) else { throw LocalHostUnlockFailure.invalidScope }; return id.uuidString.lowercased()
    }
    static func creationMetadata(scope: LocalHostUnlockScope, creationId: String) throws -> Data {
        let id = try normalizedCreationId(creationId)
        let hash = SHA256.hash(data: Data((scope.keychainService + "\n" + id).utf8)).map { String(format: "%02x", $0) }.joined()
        return try JSONSerialization.data(withJSONObject: ["schema": "dexter.local-host-unlock-creation/1", "creationId": id, "requestHash": hash], options: [.sortedKeys])
    }
    static func creationInfo(_ value: [CFString: Any], scope: LocalHostUnlockScope) throws -> LocalHostUnlockCreationInfo {
        guard let metadata = value[kSecAttrGeneric] as? Data, metadata.count <= 512,
              let json = try? JSONSerialization.jsonObject(with: metadata) as? [String: Any], Set(json.keys) == ["schema", "creationId", "requestHash"],
              json["schema"] as? String == "dexter.local-host-unlock-creation/1", let id = json["creationId"] as? String,
              try normalizedCreationId(id) == id, let hash = json["requestHash"] as? String,
              let expected = try JSONSerialization.jsonObject(with: creationMetadata(scope: scope, creationId: id)) as? [String: Any],
              expected["requestHash"] as? String == hash else { throw LocalHostUnlockFailure.conflict }
        return .init(creationId: id, requestHash: hash)
    }
    static func validate(_ value: [CFString: Any], scope: LocalHostUnlockScope, accessGroup: String, returnsValue: Bool) throws {
        guard value[kSecAttrService] as? String == scope.keychainService,
              value[kSecAttrAccount] as? String == LocalHostUnlockScope.keychainAccount,
              value[kSecAttrAccessGroup] as? String == accessGroup,
              value[kSecAttrAccessible] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,
              let sync = value[kSecAttrSynchronizable] as? NSNumber, CFGetTypeID(sync) == CFBooleanGetTypeID(), sync.boolValue == false,
              returnsValue || value[kSecValueData] == nil else { throw LocalHostUnlockFailure.conflict }
        if let domain = value[kSecUseDataProtectionKeychain] as? NSNumber {
            guard CFGetTypeID(domain) == CFBooleanGetTypeID(), domain.boolValue else { throw LocalHostUnlockFailure.conflict }
        }
        if returnsValue { guard let bytes = value[kSecValueData] as? Data, bytes.count == 32 else { throw LocalHostUnlockFailure.conflict } }
        _ = try creationInfo(value, scope: scope)
    }
}
#endif
