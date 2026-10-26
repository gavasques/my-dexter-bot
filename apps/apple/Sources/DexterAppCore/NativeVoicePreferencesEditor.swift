#if os(macOS)
import DexterHostClient
import Foundation
import Observation

/// Owner UI setting for the next native call. It does not modify the bot engine, grants, or active call.
/// An uncertain PATCH retains the exact input and can only be reconciled by reading its receipt.
@MainActor @Observable public final class NativeVoicePreferencesEditor {
    public let hostID: String
    public let botID: String
    public let connectionScope: UUID?
    public private(set) var baseline: NativeVoicePreferenceStatus?
    public private(set) var preference: NativeVoicePreference?
    public private(set) var pending: PatchNativeVoicePreference?
    public private(set) var receipt: NativeVoicePreferenceReceipt?
    public private(set) var busy = false
    public private(set) var error: HostClientError?
    public private(set) var saved = false
    @ObservationIgnored private let client: HostClient
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    @ObservationIgnored private let botRevision: @MainActor () -> Int?

    public init(hostID: String, botID: String, client: HostClient, connectionScope: UUID? = nil,
                isCurrent: @escaping @MainActor () -> Bool, botRevision: @escaping @MainActor () -> Int?) {
        self.hostID = hostID; self.botID = botID; self.client = client; self.connectionScope = connectionScope
        self.isCurrent = isCurrent; self.botRevision = botRevision
    }
    public convenience init?(bot: Bot, model: DexterAppModel) {
        guard model.canEditBotProfiles, let hostID = model.approvalPolicyHostID,
              let client = model.makeLocalMcpClient() else { return nil }
        let scope = model.nativeComposerScope, address = model.hostAddress
        self.init(hostID: hostID, botID: bot.id, client: client, connectionScope: scope, isCurrent: { [weak model] in
            guard let model else { return false }
            return model.canEditBotProfiles && model.isOnline && model.nativeComposerScope == scope
                && model.hostAddress == address && model.approvalPolicyHostID == hostID
        }, botRevision: { [weak model] in model?.bots.first { $0.id == bot.id }?.revision })
    }
    public var canSave: Bool { isCurrent() && !busy && pending == nil && baseline?.supported == true && botRevision() != nil }
    public var message: String? {
        if pending != nil { return String(localized: "Não foi possível confirmar a voz salva. Confira antes de fazer outra alteração.") }
        if baseline?.supported == false { return String(localized: "Atualize o programa Codex nos Ajustes para escolher a voz da ligação.") }
        if saved { return String(localized: "Voz salva para a próxima ligação.") }
        if let error { return error.localizedDescription }
        return nil
    }
    public func load() async {
        guard !busy, pending == nil, isCurrent() else { return }
        busy = true; defer { busy = false }
        do {
            let value = try await client.nativeVoicePreferences(botID: botID)
            guard isCurrent(), value.preference.hostId == hostID, value.preference.botId == botID,
                  value.preference.revision >= 0 else { throw HostClientError.contractMismatch }
            baseline = value; preference = value.preference; error = nil
        } catch { self.error = error as? HostClientError ?? .offline }
    }
    @discardableResult public func save(voice: String?) async -> Bool {
        guard canSave, let baseline, let preference, let revision = botRevision(),
              voice == nil || baseline.voices.contains(voice!) else { return false }
        let input = PatchNativeVoicePreference(expectedHostId: hostID, expectedBotId: botID, expectedBotRevision: revision,
            expectedRevision: preference.revision, clientRequestId: UUID().uuidString.lowercased(), voice: voice)
        pending = input; busy = true; saved = false; error = nil
        defer { busy = false }
        do {
            let value = try await client.patchNativeVoicePreferences(botID: botID, input: input)
            try client.validateNativeVoicePreferenceReceipt(value, botID: botID, input: input)
            receipt = value; pending = nil; saved = true
            self.preference = value.preference
            return true
        } catch {
            let safe = error as? HostClientError ?? .mutationOutcomeUnknown
            if [.invalidConfiguration, .remotePairingUnavailable, .invalidRequest, .forbidden, .notFound, .conflict, .notReady].contains(safe) {
                pending = nil
            }
            self.error = safe; return false
        }
    }
    public func reconcile() async {
        guard !busy, let input = pending else { return }
        busy = true; defer { busy = false }
        do {
            let value = try await client.nativeVoicePreferenceReceipt(botID: botID, clientRequestID: input.clientRequestId)
            try client.validateNativeVoicePreferenceReceipt(value, botID: botID, input: input)
            receipt = value; pending = nil; error = nil; saved = true
            preference = value.preference
        } catch { self.error = error as? HostClientError ?? .offline }
    }
}
#endif
