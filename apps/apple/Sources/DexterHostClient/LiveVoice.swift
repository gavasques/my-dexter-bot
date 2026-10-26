import Foundation

public enum LiveVoiceCatalog {
    public static let voices: [String] = [
        "alloy", "ash", "ballad", "beacon", "bossa", "brise", "cedar", "cinder", "coral", "delta", "echo",
        "flitz", "gleam", "harema", "juni", "marin", "meridian", "nira", "noeul", "nuri", "quartz", "ripple",
        "sage", "shida", "shimmer", "sillage", "stone", "tempo", "verse", "vesper", "willow"
    ]
    public static func label(_ voice: String) -> String {
        switch voice {
        case "bossa": String(localized: "Bossa · português")
        case "tempo": String(localized: "Tempo · português")
        default: voice.capitalized
        }
    }
}

/// Nonsecret owner preferences. Provider keys and audio never belong in this DTO or host metadata.
public struct LiveVoiceSettings: Codable, Equatable, Sendable {
    public let hostID: String
    public let enabled: Bool
    public let defaultVoice: String
    public let revision: Int
    public init(hostID: String, enabled: Bool, defaultVoice: String, revision: Int) {
        self.hostID = hostID; self.enabled = enabled; self.defaultVoice = defaultVoice; self.revision = revision
    }
    var isValid: Bool {
        liveHostIDIsValid(hostID) && LiveVoiceCatalog.voices.contains(defaultVoice) &&
            revision >= 0 && revision <= 9_007_199_254_740_991
    }
}

public struct LiveVoiceHistoryMessage: Codable, Equatable, Sendable {
    public let role: String
    public let text: String
    public init(role: String, text: String) { self.role = role; self.text = text }
}

/// Own-bot text context only. instructions are trusted style; documents/history are quoted contextual data.
public struct LiveVoiceContext: Codable, Equatable, Sendable {
    public let hostID: String
    public let bot: Bot
    public let threadID: String
    public let settings: LiveVoiceSettings
    public let voice: String
    public let instructions: String
    public let documents: BotDocuments?
    public let history: [LiveVoiceHistoryMessage]
    public init(hostID: String, bot: Bot, threadID: String, settings: LiveVoiceSettings, voice: String,
                instructions: String = "", documents: BotDocuments? = nil, history: [LiveVoiceHistoryMessage] = []) {
        self.hostID = hostID; self.bot = bot; self.threadID = threadID; self.settings = settings
        self.voice = voice; self.instructions = instructions; self.documents = documents; self.history = history
    }
    var isValid: Bool {
        guard liveHostIDIsValid(hostID), settings.isValid, settings.hostID == hostID, settings.enabled,
              liveHostIDIsValid(threadID), LiveVoiceCatalog.voices.contains(voice),
              instructions.utf16.count <= 1200, history.count <= 12,
              history.allSatisfy({ ["user", "assistant"].contains($0.role) && $0.text.utf16.count <= 1800 }),
              history.reduce(0, { $0 + $1.text.utf16.count }) <= 12000 else { return false }
        if let documents {
            guard documents.isValid, documents.botId == bot.id,
                  documents.soul.utf16.count + documents.user.utf16.count + documents.memory.utf16.count <= 6000 else { return false }
        }
        return voice == (bot.liveVoice ?? settings.defaultVoice)
    }
}

public struct LiveVoiceTranscriptSegment: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let role: String
    public let text: String
    public let startMS: Int?
    public let endMS: Int?
    public init(id: String, role: String, text: String, startMS: Int? = nil, endMS: Int? = nil) {
        self.id = id; self.role = role; self.text = text; self.startMS = startMS; self.endMS = endMS
    }
    var isValid: Bool {
        liveUUIDIsValid(id) && ["user", "assistant"].contains(role) && !text.isEmpty && text.utf16.count <= 8192 &&
            (startMS.map { $0 >= 0 && $0 <= 86_400_000 } ?? true) &&
            (endMS.map { $0 >= 0 && $0 <= 86_400_000 } ?? true) &&
            (startMS == nil || endMS == nil || endMS! >= startMS!)
    }
}
public typealias LiveVoiceTranscriptSegmentInput = LiveVoiceTranscriptSegment

public struct LiveVoiceTranscriptReceipt: Codable, Equatable, Sendable {
    public let hostID: String
    public let sessionID: String
    public let threadID: String
    public let messages: [Message]
    public init(hostID: String, sessionID: String, threadID: String, messages: [Message]) {
        self.hostID = hostID; self.sessionID = sessionID; self.threadID = threadID; self.messages = messages
    }
}

private struct LiveVoiceSettingsPatch: Encodable, Sendable {
    let expectedHostID: String
    let enabled: Bool
    let defaultVoice: String
    let expectedRevision: Int
}
private struct LiveVoiceTranscriptInput: Encodable, Sendable {
    let hostID: String
    let sessionID: String
    let segments: [LiveVoiceTranscriptSegment]
}

extension HostClient {
    public func getLiveVoiceSettings() async throws -> LiveVoiceSettings {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let value: LiveVoiceSettings = try await request("/v1/voice/config", timeout: 15, localAttachmentRequest: true)
        guard value.isValid else { throw HostClientError.contractMismatch }; return value
    }
    public func updateLiveVoiceSettings(hostID: String, enabled: Bool, defaultVoice: String, expectedRevision: Int) async throws -> LiveVoiceSettings {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard liveHostIDIsValid(hostID), LiveVoiceCatalog.voices.contains(defaultVoice),
              expectedRevision >= 0, expectedRevision < 9_007_199_254_740_991 else { throw HostClientError.invalidRequest }
        let value: LiveVoiceSettings = try await liveVoiceMutation("/v1/voice/config", method: "PATCH",
            body: LiveVoiceSettingsPatch(expectedHostID: hostID, enabled: enabled, defaultVoice: defaultVoice, expectedRevision: expectedRevision))
        guard value.isValid, value.hostID == hostID, value.enabled == enabled, value.defaultVoice == defaultVoice,
              value.revision == expectedRevision + 1 else { throw HostClientError.mutationOutcomeUnknown }; return value
    }
    public func getLiveVoiceContext(threadID: String) async throws -> LiveVoiceContext {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let value: LiveVoiceContext = try await request(try liveThreadPath(threadID) + "/voice/context", timeout: 15, localAttachmentRequest: true)
        guard value.threadID == threadID, value.isValid else { throw HostClientError.contractMismatch }; return value
    }
    @discardableResult
    public func saveLiveVoiceTranscript(hostID: String, threadID: String, sessionID: String,
                                        segments: [LiveVoiceTranscriptSegment]) async throws -> LiveVoiceTranscriptReceipt {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard liveHostIDIsValid(hostID), liveUUIDIsValid(sessionID), segments.count <= 128,
              Set(segments.map(\.id)).count == segments.count, segments.allSatisfy(\.isValid),
              segments.reduce(0, { $0 + $1.text.utf16.count }) <= 32768 else { throw HostClientError.invalidRequest }
        let value: LiveVoiceTranscriptReceipt = try await liveVoiceMutation(try liveThreadPath(threadID) + "/voice/transcript", method: "POST",
            body: LiveVoiceTranscriptInput(hostID: hostID, sessionID: sessionID, segments: segments))
        guard value.hostID == hostID, value.sessionID == sessionID, value.threadID == threadID,
              value.messages.count == segments.count, Set(value.messages.map(\.id)).count == value.messages.count,
              zip(value.messages, segments).allSatisfy({ message, segment in
                  message.threadId == threadID && message.role.rawValue == segment.role && message.content == segment.text &&
                    message.clientMessageId == "voice:\(sessionID):\(segment.id)" && (message.attachments?.isEmpty ?? true)
              }) else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
    private func liveVoiceMutation<Response: Decodable & Sendable>(_ path: String, method: String,
                                                                   body: any Encodable) async throws -> Response {
        do { return try await request(path, method: method, body: body, timeout: 15, localAttachmentRequest: true) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error {
            case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown
            default: throw error
            }
        }
    }
}

private func liveUUIDIsValid(_ value: String) -> Bool {
    guard let uuid = UUID(uuidString: value) else { return false }; return uuid.uuidString.lowercased() == value
}
private func liveHostIDIsValid(_ value: String) -> Bool { !value.isEmpty && value.utf16.count <= 128 }
private func liveThreadPath(_ value: String) throws -> String {
    guard liveHostIDIsValid(value), let encoded = value.addingPercentEncoding(withAllowedCharacters:
        CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")) else { throw HostClientError.invalidRequest }
    return "/v1/threads/\(encoded)"
}
