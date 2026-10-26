import Foundation
import CryptoKit

public enum NativeVoiceCode: String, Codable, Sendable {
    case unsupported = "native_voice_unsupported", authNeeded = "auth_needed", modelUnsupported = "model_unsupported", audioClientMissing = "audio_client_missing"
    case scopeChanged = "scope_changed", hostStopping = "host_stopping", providerFailed = "provider_failed", protocolError = "protocol_error", timeout
    case receiptCapacity = "receipt_capacity", handoffMissingTranscript = "handoff_missing_transcript"
}
public enum NativeVoiceState: String, Codable, Sendable { case starting, active, stopping, closed, failed, unknown }
public struct NativeVoiceStatus: Codable, Sendable {
    public let hostId: String; public let botId: String; public let threadId: String
    public let botRevision: Int; public let selectionRevision: Int; public let supported: Bool; public let code: NativeVoiceCode?
    public let authentication: String; public let billing: String; public let `protocol`: String; public let transport: String
    public let voices: [String]; public let cliVersion: String?; public let activeSessionId: String?
}
public struct NativeVoiceSession: Codable, Sendable, Identifiable {
    public let id: String; public let hostId: String; public let botId: String; public let threadId: String; public let generation: String
    public let botRevision: Int; public let selectionRevision: Int; public let selection: EngineSelection; public let voice: String?
    public let state: NativeVoiceState; public let revision: Int; public let code: NativeVoiceCode?
    public let createdAt: Int64; public let updatedAt: Int64; public let expiresAt: Int64
    public let cursor: Int64; public let startedAt: Int64?; public let endedAt: Int64?; public let turnIds: [String]
    public var terminal: Bool { [.closed, .failed, .unknown].contains(state) }
}
public struct NativeVoiceReceipt: Codable, Sendable, Identifiable {
    public let id: String; public let operation: String; public let clientRequestId: String; public let threadId: String
    public let sessionId: String; public let generation: String; public let hostId: String; public let requestHash: String; public let createdAt: Int64
}
public struct NativeVoiceMutation: Codable, Sendable { public let receipt: NativeVoiceReceipt; public let session: NativeVoiceSession }
public struct NativeVoiceEvent: Codable, Sendable {
    public let cursor: Int64; public let sessionId: String; public let generation: String; public let kind: String
    public let role: String?; public let text: String?; public let turnId: String?; public let state: String?; public let code: NativeVoiceCode?
}
public struct NativeVoiceEvents: Codable, Sendable { public let items: [NativeVoiceEvent]; public let nextCursor: Int64? }
public struct NativeVoicePreference: Codable, Sendable {
    public let hostId: String; public let botId: String; public let revision: Int; public let voice: String?; public let updatedAt: Int64
}
public struct NativeVoicePreferenceStatus: Codable, Sendable {
    public let preference: NativeVoicePreference; public let supported: Bool; public let voices: [String]; public let cliVersion: String?
}
public struct NativeVoicePreferenceReceipt: Codable, Sendable {
    public let id: String; public let hostId: String; public let botId: String; public let clientRequestId: String
    public let requestHash: String; public let previousRevision: Int; public let preference: NativeVoicePreference; public let createdAt: Int64
}
public struct PatchNativeVoicePreference: Codable, Sendable {
    public let expectedHostId: String; public let expectedBotId: String; public let expectedBotRevision: Int
    public let expectedRevision: Int; public let clientRequestId: String; public let voice: String?
    public init(expectedHostId: String, expectedBotId: String, expectedBotRevision: Int, expectedRevision: Int, clientRequestId: String, voice: String?) {
        self.expectedHostId=expectedHostId; self.expectedBotId=expectedBotId; self.expectedBotRevision=expectedBotRevision
        self.expectedRevision=expectedRevision; self.clientRequestId=clientRequestId; self.voice=voice
    }
    enum CodingKeys: String, CodingKey { case expectedHostId,expectedBotId,expectedBotRevision,expectedRevision,clientRequestId,voice }
    public func encode(to encoder: any Encoder) throws {
        var c=encoder.container(keyedBy:CodingKeys.self)
        try c.encode(expectedHostId,forKey:.expectedHostId);try c.encode(expectedBotId,forKey:.expectedBotId);try c.encode(expectedBotRevision,forKey:.expectedBotRevision)
        try c.encode(expectedRevision,forKey:.expectedRevision);try c.encode(clientRequestId,forKey:.clientRequestId)
        if let voice {try c.encode(voice,forKey:.voice)} else {try c.encodeNil(forKey:.voice)}
    }
}
public struct NativeVoiceTranscriptReference: Codable, Sendable {
    public let turnId: String; public let inputMessageId: String; public let outputMessageId: String?; public let state: String
}
public struct NativeVoiceHistoryItem: Codable, Sendable {
    public let session: NativeVoiceSession; public let durationMs: Int64; public let transcriptRefs: [NativeVoiceTranscriptReference]
}
public struct NativeVoiceHistory: Codable, Sendable { public let items: [NativeVoiceHistoryItem]; public let nextCursor: Int64? }
/// Private media negotiation. Keep in memory; never defaults, transcript, logs or fixtures with real SDP.
public struct NativeVoiceExchange: Codable, Sendable { public let sessionId: String; public let generation: String; public let sdpAnswer: String; public let expiresAt: Int64 }
public struct StartNativeVoice: Codable, Sendable {
    public let expectedHostId: String; public let expectedBotId: String; public let expectedBotRevision: Int; public let expectedSelectionRevision: Int
    public let clientRequestId: String; public let expectedRevision: Int; public let sessionId: String; public let generation: String
    public let sdpOffer: String; public let voice: String?
    public init(expectedHostId: String, expectedBotId: String, expectedBotRevision: Int, expectedSelectionRevision: Int,
                clientRequestId: String, sessionId: String = UUID().uuidString.lowercased(), generation: String, sdpOffer: String, voice: String? = nil) {
        self.expectedHostId=expectedHostId; self.expectedBotId=expectedBotId; self.expectedBotRevision=expectedBotRevision; self.expectedSelectionRevision=expectedSelectionRevision
        self.clientRequestId=clientRequestId; expectedRevision=0; self.sessionId=sessionId; self.generation=generation; self.sdpOffer=sdpOffer; self.voice=voice
    }
}
public struct StopNativeVoice: Codable, Sendable {
    public let expectedHostId: String; public let expectedBotId: String; public let generation: String; public let clientRequestId: String; public let expectedRevision: Int
    public init(expectedHostId: String, expectedBotId: String, generation: String, clientRequestId: String, expectedRevision: Int) {
        self.expectedHostId=expectedHostId; self.expectedBotId=expectedBotId; self.generation=generation; self.clientRequestId=clientRequestId; self.expectedRevision=expectedRevision
    }
}
extension StartNativeVoice {
    /// Validate POST or GET-only reconciliation against the original in-memory request.
    public func validateReceipt(_ value: NativeVoiceMutation, threadID: String) throws {
        let r=value.receipt,s=value.session
        guard r.operation=="start",r.hostId==expectedHostId,r.threadId==threadID,r.sessionId==sessionId,
              r.generation==generation,r.clientRequestId==clientRequestId,
              s.id==sessionId,s.hostId==expectedHostId,s.botId==expectedBotId,s.threadId==threadID,s.generation==generation,
              s.botRevision==expectedBotRevision,s.selectionRevision==expectedSelectionRevision,s.selection.engine == "codex",
              r.requestHash == (try nativeVoiceHash(self,scopeKey:"threadId",scope:threadID)) else {throw HostClientError.contractMismatch}
    }
}
extension StopNativeVoice {
    public func validateReceipt(_ value: NativeVoiceMutation, sessionID: String) throws {
        let r=value.receipt,s=value.session
        guard r.operation=="stop",r.hostId==expectedHostId,r.sessionId==sessionID,r.generation==generation,r.clientRequestId==clientRequestId,
              s.id==sessionID,s.hostId==expectedHostId,s.botId==expectedBotId,s.generation==generation,r.threadId==s.threadId,
              s.revision>=expectedRevision,r.requestHash == (try nativeVoiceHash(self,scopeKey:"sessionId",scope:sessionID)) else {throw HostClientError.contractMismatch}
    }
}
extension PatchNativeVoicePreference {
    public func validateReceipt(_ value: NativeVoicePreferenceReceipt, botID: String) throws {
        guard expectedBotId==botID,value.hostId==expectedHostId,value.botId==botID,value.clientRequestId==clientRequestId,
              value.preference.hostId==expectedHostId,value.preference.botId==botID,value.preference.voice==voice,
              value.previousRevision==expectedRevision,value.preference.revision==expectedRevision+1,
              value.requestHash == (try nativeVoiceHash(self,scopeKey:"botId",scope:botID)) else {throw HostClientError.contractMismatch}
    }
}
extension HostClient {
    public func validateNativeVoiceStartReceipt(_ result: NativeVoiceMutation, threadID: String, input: StartNativeVoice) throws {
        try input.validateReceipt(result,threadID:threadID)
    }
    public func validateNativeVoiceStopReceipt(_ result: NativeVoiceMutation, sessionID: String, input: StopNativeVoice) throws {
        try input.validateReceipt(result,sessionID:sessionID)
    }
    public func validateNativeVoicePreferenceReceipt(_ result: NativeVoicePreferenceReceipt, botID: String, input: PatchNativeVoicePreference) throws {
        try input.validateReceipt(result,botID:botID)
    }
    private func nativeVoiceOwner() throws { guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden } }
    private func nativeVoiceMutation<Input: Encodable>(_ path: String, input: Input) async throws -> NativeVoiceMutation {
        do { return try await request(path, method: "POST", body: input, timeout: 30, localAttachmentRequest: true) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError { switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error } }
    }
    public func nativeVoicePreferences(botID: String) async throws -> NativeVoicePreferenceStatus {
        try nativeVoiceOwner();return try await request("/v1/bots/\(nativeVoicePath(botID))/native-voice/preferences",timeout:15,localAttachmentRequest:true)
    }
    public func patchNativeVoicePreferences(botID: String, input: PatchNativeVoicePreference) async throws -> NativeVoicePreferenceReceipt {
        try nativeVoiceOwner()
        let value: NativeVoicePreferenceReceipt
        do {value=try await request("/v1/bots/\(nativeVoicePath(botID))/native-voice/preferences",method:"PATCH",body:input,timeout:15,localAttachmentRequest:true)}
        catch is CancellationError {throw HostClientError.mutationOutcomeUnknown}
        catch let error as HostClientError {switch error {case .offline,.hostFailure,.contractMismatch:throw HostClientError.mutationOutcomeUnknown;default:throw error}}
        do {try input.validateReceipt(value,botID:botID)} catch {throw HostClientError.mutationOutcomeUnknown}
        return value
    }
    public func nativeVoicePreferenceReceipt(botID: String, clientRequestID: String) async throws -> NativeVoicePreferenceReceipt {
        try nativeVoiceOwner();return try await request("/v1/bots/\(nativeVoicePath(botID))/native-voice/preferences/receipts/\(nativeVoicePath(clientRequestID))",timeout:15,localAttachmentRequest:true)
    }
    public func nativeVoiceHistory(threadID: String, after: Int64=0, limit: Int=50) async throws -> NativeVoiceHistory {
        try nativeVoiceOwner();guard after>=0,(1...50).contains(limit) else {throw HostClientError.invalidRequest}
        return try await request("/v1/threads/\(nativeVoicePath(threadID))/native-voice/sessions",query:[URLQueryItem(name:"after",value:String(after)),URLQueryItem(name:"limit",value:String(limit))],timeout:15,localAttachmentRequest:true)
    }
    public func nativeVoiceStatus(threadID: String) async throws -> NativeVoiceStatus { try nativeVoiceOwner(); return try await request("/v1/threads/\(nativeVoicePath(threadID))/native-voice/status", timeout: 15, localAttachmentRequest: true) }
    public func startNativeVoice(threadID: String, input: StartNativeVoice) async throws -> NativeVoiceMutation {
        try nativeVoiceOwner()
        let result: NativeVoiceMutation = try await nativeVoiceMutation("/v1/threads/\(nativeVoicePath(threadID))/native-voice/start", input: input)
        do {try input.validateReceipt(result,threadID:threadID)} catch {throw HostClientError.mutationOutcomeUnknown}
        return result
    }
    /// Recover a lost start/stop response by GET only. Caller retains exact request IDs; no automatic POST replay.
    public func nativeVoiceReceipt(threadID: String, clientRequestID: String) async throws -> NativeVoiceMutation {
        try nativeVoiceOwner(); return try await request("/v1/threads/\(nativeVoicePath(threadID))/native-voice/receipts/\(nativeVoicePath(clientRequestID))", timeout: 15, localAttachmentRequest: true)
    }
    public func nativeVoiceSession(id: String) async throws -> NativeVoiceSession { try nativeVoiceOwner(); return try await request("/v1/native-voice/sessions/\(nativeVoicePath(id))", timeout: 15, localAttachmentRequest: true) }
    public func nativeVoiceEvents(sessionID: String, after: Int64 = 0, limit: Int = 50) async throws -> NativeVoiceEvents {
        try nativeVoiceOwner(); guard after >= 0, (1...50).contains(limit) else { throw HostClientError.invalidRequest }
        return try await request("/v1/native-voice/sessions/\(nativeVoicePath(sessionID))/events", query: [URLQueryItem(name: "after", value: String(after)), URLQueryItem(name: "limit", value: String(limit))], timeout: 15, localAttachmentRequest: true)
    }
    public func nativeVoiceExchange(sessionID: String, expectedHostID: String, generation: String) async throws -> NativeVoiceExchange {
        try nativeVoiceOwner()
        let value: NativeVoiceExchange = try await request("/v1/native-voice/sessions/\(nativeVoicePath(sessionID))/exchange", query: [URLQueryItem(name: "expectedHostId", value: expectedHostID), URLQueryItem(name: "generation", value: generation)], timeout: 15, localAttachmentRequest: true)
        guard value.sessionId == sessionID, value.generation == generation, value.sdpAnswer.utf8.count <= 65_536,
              value.sdpAnswer.hasPrefix("v=0"), value.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) else { throw HostClientError.contractMismatch }
        return value
    }
    public func stopNativeVoice(sessionID: String, input: StopNativeVoice) async throws -> NativeVoiceMutation {
        try nativeVoiceOwner()
        let result: NativeVoiceMutation = try await nativeVoiceMutation("/v1/native-voice/sessions/\(nativeVoicePath(sessionID))/stop", input: input)
        do {try input.validateReceipt(result,sessionID:sessionID)} catch {throw HostClientError.mutationOutcomeUnknown}
        return result
    }
}

private func nativeVoicePath(_ value: String) throws -> String { try groupID(value) }

private func nativeVoiceHash<T: Encodable>(_ input: T, scopeKey: String, scope: String) throws -> String {
    let encoder=JSONEncoder(); encoder.outputFormatting=[.sortedKeys,.withoutEscapingSlashes]
    let data=try encoder.encode(input)
    guard var object=try JSONSerialization.jsonObject(with:data) as? [String:Any] else { throw HostClientError.invalidRequest }
    object[scopeKey]=scope
    let canonical=try JSONSerialization.data(withJSONObject:object,options:[.sortedKeys,.withoutEscapingSlashes])
    return SHA256.hash(data:canonical).map{String(format:"%02x",$0)}.joined()
}
