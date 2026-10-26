import CryptoKit
import Foundation
import LocalAuthentication
import Security

public enum LiveKeyStatus: String, Sendable { case configured, missing, unavailable }

/// Closed, local audio stages; no device names, key values or raw error text.
public enum LiveVoiceAudioStage: String, Sendable, Equatable {
    case inputFormat, conversion, engineStart, playback
}

public enum LiveVoiceFailure: Error, Sendable, Equatable {
    case invalidConfiguration, keyMissing, keyUnavailable, microphoneDenied, audioUnavailable
    case audio(LiveVoiceAudioStage, osStatus: Int32? = nil)
    case connectionUnavailable, protocolRejected, sessionTimeout, audioBacklog, delegationUnavailable

    public var message: String {
        switch self {
        case .invalidConfiguration: String(localized: "A configuração de voz ao vivo não é válida. Confira o bot, a conversa e a voz.")
        case .keyMissing: String(localized: "Adicione sua chave OpenAI nos ajustes de Voz ao vivo.")
        case .keyUnavailable: String(localized: "A chave OpenAI está indisponível. Desbloqueie o Mac ou salve a chave novamente nos ajustes.")
        case .microphoneDenied: String(localized: "Permita o microfone para o Dexter nos Ajustes do Sistema e tente novamente.")
        case .audioUnavailable: String(localized: "Não foi possível iniciar o áudio. Confira o microfone e a saída de som do Mac.")
        case .audio(.inputFormat, _): String(localized: "O microfone não disponibilizou um formato de áudio válido. Confira a entrada de som do Mac e tente novamente.")
        case .audio(.conversion, _): String(localized: "Não foi possível processar o áudio do microfone. Inicie uma nova sessão de voz.")
        case .audio(.engineStart, _): String(localized: "Não foi possível iniciar o áudio. Confira o microfone e a saída de som do Mac.")
        case .audio(.playback, _): String(localized: "Não foi possível reproduzir a voz. Confira a saída de som do Mac e tente novamente.")
        case .connectionUnavailable: String(localized: "Não foi possível conectar a voz ao vivo. Confira a rede e a chave OpenAI e tente novamente.")
        case .protocolRejected: String(localized: "A OpenAI recusou ou encerrou a sessão de voz. Confira o acesso ao GPT-Live 1 e tente novamente.")
        case .sessionTimeout: String(localized: "A sessão de voz não confirmou a conexão a tempo. Tente novamente.")
        case .audioBacklog: String(localized: "O áudio acumulou atraso. A sessão foi encerrada; inicie uma nova sessão.")
        case .delegationUnavailable: String(localized: "O bot não conseguiu concluir esta ação. A conversa e suas permissões continuam no host.")
        }
    }
}

/// Only this host's explicit Live key. Implementations never enumerate other Keychain items.
@MainActor public protocol LiveAPIKeyStore: AnyObject {
    func status(hostID: String) -> LiveKeyStatus
    func load(hostID: String) throws -> String
    func save(_ key: String, hostID: String) throws
    func remove(hostID: String) throws
}

/// Separate namespace with no iCloud synchronization or portable defaults/JSON representation.
/// The local ad-hoc Mac build explicitly uses the classic user Keychain with the creator app's ACL.
/// Classic Keychain is protected by macOS; it does not provide the DPK ThisDeviceOnly contract.
@MainActor public final class ScopedLiveAPIKeychain: LiveAPIKeyStore {
    public static let service = "com.dexter.bot.live.openai.api-key.v1"
    public init() {}

    private func query(hostID: String, allowInteraction: Bool = false) throws -> [CFString: Any] {
        guard !hostID.isEmpty, hostID.utf8.count <= 2_048,
              !hostID.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw LiveVoiceFailure.invalidConfiguration
        }
        let digest = SHA256.hash(data: Data(hostID.utf8)).map { String(format: "%02x", $0) }.joined()
        let authentication = LAContext()
        authentication.interactionNotAllowed = !allowInteraction
        var request: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: Self.service,
                                       kSecAttrAccount: "host-" + digest, kSecAttrSynchronizable: false,
                                       kSecUseAuthenticationContext: authentication]
        #if os(macOS)
        request[kSecUseDataProtectionKeychain] = false
        #else
        request[kSecUseDataProtectionKeychain] = true
        #endif
        return request
    }

    private func item(hostID: String, includingData: Bool, allowInteraction: Bool = false) throws -> [CFString: Any]? {
        var request = try query(hostID: hostID, allowInteraction: allowInteraction)
        request[kSecReturnAttributes] = true
        if includingData { request[kSecReturnData] = true }
        request[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let item = result as? [CFString: Any],
              item[kSecAttrService] as? String == Self.service,
              item[kSecAttrAccount] as? String == request[kSecAttrAccount] as? String,
              item[kSecAttrSynchronizable] as? Bool != true else {
            throw LiveVoiceFailure.keyUnavailable
        }
        #if !os(macOS)
        guard item[kSecAttrAccessible] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,
              let synchronized = item[kSecAttrSynchronizable] as? Bool, !synchronized else {
            throw LiveVoiceFailure.keyUnavailable
        }
        #endif
        return item
    }

    public func status(hostID: String) -> LiveKeyStatus {
        do { return try item(hostID: hostID, includingData: false) == nil ? .missing : .configured }
        catch { return .unavailable }
    }

    public func load(hostID: String) throws -> String {
        // Called only from the user's explicit Live start, never from discovery or availability checks.
        guard let item = try item(hostID: hostID, includingData: true, allowInteraction: true) else { throw LiveVoiceFailure.keyMissing }
        guard let data = item[kSecValueData] as? Data, let key = String(data: data, encoding: .utf8),
              Self.isValid(key) else { throw LiveVoiceFailure.keyUnavailable }
        return key
    }

    public func save(_ key: String, hostID: String) throws {
        let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isValid(normalized) else { throw LiveVoiceFailure.invalidConfiguration }
        // Human Save may show the OS ACL/unlock prompt, including after an app signature changes.
        let request = try query(hostID: hostID, allowInteraction: true)
        if try item(hostID: hostID, includingData: false, allowInteraction: true) != nil {
            let status = SecItemUpdate(request as CFDictionary,
                                       [kSecValueData: Data(normalized.utf8)] as CFDictionary)
            guard status == errSecSuccess else { throw LiveVoiceFailure.keyUnavailable }
        } else {
            var attributes = request
            attributes[kSecValueData] = Data(normalized.utf8)
            #if !os(macOS)
            attributes[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            #endif
            attributes[kSecAttrLabel] = "Dexter · OpenAI Live"
            guard SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess else {
                throw LiveVoiceFailure.keyUnavailable
            }
        }
    }

    public func remove(hostID: String) throws {
        let status = SecItemDelete(try query(hostID: hostID, allowInteraction: true) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw LiveVoiceFailure.keyUnavailable }
    }

    private static func isValid(_ key: String) -> Bool {
        (16...512).contains(key.utf8.count) && key.unicodeScalars.allSatisfy { (33...126).contains($0.value) }
    }
}

/// QA seam: no Keychain, inherited account, filesystem or credential discovery.
@MainActor public final class InMemoryLiveAPIKeyStore: LiveAPIKeyStore {
    private var keys: [String: String] = [:]
    public init() {}
    public func status(hostID: String) -> LiveKeyStatus { keys[hostID] == nil ? .missing : .configured }
    public func load(hostID: String) throws -> String {
        guard let key = keys[hostID] else { throw LiveVoiceFailure.keyMissing }; return key
    }
    public func save(_ key: String, hostID: String) throws { keys[hostID] = key }
    public func remove(hostID: String) throws { keys.removeValue(forKey: hostID) }
}
