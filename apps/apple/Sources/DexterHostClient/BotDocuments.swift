import Foundation

/// Read-only host policy for writes to this bot's private documents. It is not an authorization token.
public struct BotDocumentsAutomation: Codable, Equatable, Sendable {
    public enum Mode: String, Codable, Equatable, Sendable { case automatic, ask, denied, expired }
    public let version: String
    public let scope: String
    public let updates: Mode
    public let append: Mode
    public let clear: String
    public let restore: String

    public init(updates: Mode, append: Mode) {
        version = "own-documents.v1"; scope = "own_private"
        self.updates = updates; self.append = append
        clear = "exact_owner"; restore = "exact_owner"
    }

    private enum CodingKeys: String, CodingKey { case version, scope, updates, append, clear, restore }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard try values.decode(String.self, forKey: .version) == "own-documents.v1",
              try values.decode(String.self, forKey: .scope) == "own_private",
              try values.decode(String.self, forKey: .clear) == "exact_owner",
              try values.decode(String.self, forKey: .restore) == "exact_owner" else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unsupported document automation policy"))
        }
        self.init(updates: try values.decode(Mode.self, forKey: .updates), append: try values.decode(Mode.self, forKey: .append))
    }
}

/// Owner-authored documents belonging to one bot. Revision is independent of its profile.
public struct BotDocuments: Codable, Equatable, Sendable {
    public static let maximumUTF16Length = 8192
    public let botId: String
    public let revision: Int
    public let soul: String
    public let user: String
    public let memory: String
    public let memoryHead: BotMemoryRevision?
    public let receipt: DocumentMutationReceipt?
    public let updatedAt: Double?
    /// Absent on older hosts and unsupported policies. Absence never means that automatic writes are allowed.
    public let automation: BotDocumentsAutomation?

    public init(botId: String, revision: Int, soul: String, user: String, memory: String, updatedAt: Double? = nil, memoryHead: BotMemoryRevision? = nil, receipt: DocumentMutationReceipt? = nil, automation: BotDocumentsAutomation? = nil) {
        self.botId = botId; self.revision = revision; self.soul = soul
        self.user = user; self.memory = memory; self.updatedAt = updatedAt; self.memoryHead = memoryHead; self.receipt = receipt
        self.automation = automation
    }

    private enum CodingKeys: String, CodingKey { case botId, revision, soul, user, memory, memoryHead, receipt, updatedAt, automation }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        botId = try values.decode(String.self, forKey: .botId)
        revision = try values.decode(Int.self, forKey: .revision)
        soul = try values.decode(String.self, forKey: .soul)
        user = try values.decode(String.self, forKey: .user)
        memory = try values.decode(String.self, forKey: .memory)
        memoryHead = try values.decodeIfPresent(BotMemoryRevision.self, forKey: .memoryHead)
        receipt = try values.decodeIfPresent(DocumentMutationReceipt.self, forKey: .receipt)
        updatedAt = try values.decodeIfPresent(Double.self, forKey: .updatedAt)
        // A future or malformed display-only policy does not hide otherwise valid documents.
        // It becomes unknown, so the UI cannot announce automatic authorization by inference.
        automation = try? values.decodeIfPresent(BotDocumentsAutomation.self, forKey: .automation)
    }

    var isValid: Bool {
        revision >= 0 && revision <= 9_007_199_254_740_991 &&
        [soul, user, memory].allSatisfy { $0.utf16.count <= Self.maximumUTF16Length } &&
        (updatedAt.map { $0.isFinite && $0 >= 0 } ?? true)
    }
}

public struct PutBotDocumentsInput: Encodable, Equatable, Sendable {
    public let clientRequestId: String?
    public let sourceReference: String?
    public let expectedRevision: Int
    public let soul: String
    public let user: String
    public let memory: String

    public init(expectedRevision: Int, soul: String, user: String, memory: String, clientRequestId: String? = nil, sourceReference: String? = nil) {
        self.clientRequestId = clientRequestId; self.sourceReference = sourceReference
        self.expectedRevision = expectedRevision; self.soul = soul
        self.user = user; self.memory = memory
    }

    public var isValid: Bool {
        expectedRevision >= 0 && expectedRevision < 9_007_199_254_740_991 &&
        [soul, user, memory].allSatisfy { $0.utf16.count <= BotDocuments.maximumUTF16Length } &&
        (clientRequestId.map(validDocumentRequestID) ?? true) && (sourceReference?.utf16.count ?? 0) <= 512
    }
}

extension HostClient {
    public func getBotDocuments(botID: String) async throws -> BotDocuments {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let value: BotDocuments = try await request(botDocumentsPath(botID), timeout: 15)
        guard value.botId == botID, value.isValid else { throw HostClientError.contractMismatch }
        return value
    }

    public func updateBotDocuments(botID: String, input: PutBotDocumentsInput) async throws -> BotDocuments {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard input.isValid else { throw HostClientError.invalidRequest }
        let path = try botDocumentsPath(botID)
        let value: BotDocuments
        do { value = try await request(path, method: "PUT", body: input, timeout: 15) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error {
            case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown
            default: throw error
            }
        }
        guard value.botId == botID, value.isValid, value.revision == input.expectedRevision + 1,
              value.soul == input.soul, value.user == input.user, value.memory == input.memory,
              input.clientRequestId == nil || value.receipt?.operationKey == "owner:\(input.clientRequestId!)" else {
            throw HostClientError.mutationOutcomeUnknown
        }
        return value
    }
}

private func botDocumentsPath(_ botID: String) throws -> String {
    guard !botID.isEmpty else { throw HostClientError.invalidRequest }
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
    guard let segment = botID.addingPercentEncoding(withAllowedCharacters: allowed) else { throw HostClientError.invalidRequest }
    return "/v1/bots/\(segment)/documents"
}

/// Host identity and declared reference are separate. A reference is not proof of a true source.
public struct BotMemorySource: Codable, Equatable, Sendable {
    public let kind: String
    public let ownerId: String?
    public let clientRequestId: String?
    public let actionId: String?
    public let threadId: String?
    public let turnId: String?
    public let callId: String?
    public let reference: String?
}
public struct BotMemoryPin: Codable, Equatable, Sendable {
    public let path: String
    public let sha256: String
    public let commit: String
}
public struct BotMemoryRevision: Codable, Equatable, Sendable {
    public let botId: String
    public let revision: Int
    public let pin: BotMemoryPin
    public let source: BotMemorySource
    public let restoredFrom: Int?
    public let updatedAt: Double
}
public struct BotMemoryVersion: Codable, Equatable, Sendable {
    public let botId: String
    public let revision: Int
    public let pin: BotMemoryPin
    public let source: BotMemorySource
    public let restoredFrom: Int?
    public let updatedAt: Double
    public let markdown: String
}
public struct BotMemoryHistory: Codable, Equatable, Sendable {
    public let items: [BotMemoryRevision]
    public let nextCursor: String?
}
public struct DocumentMutationReceipt: Codable, Equatable, Sendable {
    public let botId: String
    public let operationKey: String
    public let requestHash: String
    public let operation: String
    public let revision: Int
    public let source: BotMemorySource
    public let committedAt: Double
}
public struct RestoreBotMemoryInput: Codable, Equatable, Sendable {
    public let expectedRevision: Int
    public let fromRevision: Int
    public let clientRequestId: String
    public let sourceReference: String?
    public init(expectedRevision: Int, fromRevision: Int, clientRequestId: String, sourceReference: String? = nil) {
        self.expectedRevision = expectedRevision; self.fromRevision = fromRevision
        self.clientRequestId = clientRequestId; self.sourceReference = sourceReference
    }
}

extension HostClient {
    public func getBotMemoryHistory(botID: String, before: String? = nil) async throws -> BotMemoryHistory {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        if let before { guard before.range(of: #"^r[1-9][0-9]{0,15}$"#, options: .regularExpression) != nil else { throw HostClientError.invalidRequest } }
        // Query items, never inside the path: a "?" in the path is percent-encoded and the host answers 404.
        let query = [URLQueryItem(name: "limit", value: "20")] + (before.map { [URLQueryItem(name: "before", value: $0)] } ?? [])
        let value: BotMemoryHistory = try await request(try botDocumentsPath(botID) + "/memory/history", query: query, timeout: 15)
        guard value.items.count <= 20, value.items.allSatisfy({ $0.botId == botID && $0.revision > 0 }) else { throw HostClientError.contractMismatch }
        return value
    }
    public func getBotMemoryRevision(botID: String, revision: Int) async throws -> BotMemoryVersion {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard revision > 0 else { throw HostClientError.invalidRequest }
        let value: BotMemoryVersion = try await request(try botDocumentsPath(botID) + "/memory/revisions/\(revision)", timeout: 15)
        guard value.botId == botID, value.revision == revision, value.markdown.utf16.count <= BotDocuments.maximumUTF16Length else { throw HostClientError.contractMismatch }
        return value
    }
    public func restoreBotMemory(botID: String, input: RestoreBotMemoryInput) async throws -> BotDocuments {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard input.expectedRevision >= 0, input.expectedRevision < 9_007_199_254_740_991, input.fromRevision > 0,
              input.fromRevision <= input.expectedRevision, validDocumentRequestID(input.clientRequestId), (input.sourceReference?.utf16.count ?? 0) <= 512 else { throw HostClientError.invalidRequest }
        let path = try botDocumentsPath(botID) + "/memory/restore"
        let value: BotDocuments
        do { value = try await request(path, method: "POST", body: input, timeout: 15) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
        guard value.botId == botID, value.isValid, value.revision == input.expectedRevision + 1,
              value.memoryHead?.restoredFrom == input.fromRevision,
              value.receipt?.operationKey == "owner:\(input.clientRequestId)", value.receipt?.operation == "restore" else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
    /// GET only: use the original ID after ambiguous acknowledgment or after reopening the app.
    public func getBotDocumentReceipt(botID: String, clientRequestID: String) async throws -> BotDocuments {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard validDocumentRequestID(clientRequestID) else { throw HostClientError.invalidRequest }
        let key = "owner:\(clientRequestID)"
        let value: BotDocuments = try await request(try botDocumentsPath(botID) + "/receipts/\(key)", timeout: 15)
        guard value.botId == botID, value.isValid, value.receipt?.botId == botID,
              value.receipt?.operationKey == key, value.receipt?.revision == value.revision else { throw HostClientError.contractMismatch }
        return value
    }
}
private func validDocumentRequestID(_ value: String) -> Bool {
    value.range(of: #"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"#, options: .regularExpression) != nil
}
