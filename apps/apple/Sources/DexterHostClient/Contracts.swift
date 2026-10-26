import Foundation

/// Matches ECMAScript `String.prototype.trim()` for the host's device-name contract.
/// In particular, U+FEFF is trimmed and U+0085 is preserved.
public enum DeviceNameNormalizer {
    public static let maximumUTF16Length = 120

    public static func normalize(_ value: String) -> String {
        let scalars = value.unicodeScalars
        var lower = scalars.startIndex
        var upper = scalars.endIndex

        while lower < upper, isECMAScriptTrimWhitespace(scalars[lower]) {
            scalars.formIndex(after: &lower)
        }
        while lower < upper {
            let previous = scalars.index(before: upper)
            guard isECMAScriptTrimWhitespace(scalars[previous]) else { break }
            upper = previous
        }
        return String(scalars[lower..<upper])
    }

    public static func isValid(_ value: String) -> Bool {
        let normalized = normalize(value)
        return !normalized.isEmpty && normalized.utf16.count <= maximumUTF16Length
    }

    private static func isECMAScriptTrimWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x0009...0x000D, 0x0020, 0x00A0, 0x1680,
             0x2000...0x200A, 0x2028...0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            true
        default:
            false
        }
    }
}

public enum EngineID: String, Codable, CaseIterable, Sendable {
    case claude
    case codex
    case grok
    case muse
    case antigravity
    public var displayName: String { switch self { case .claude: "Claude"; case .codex: "Codex"; case .grok: "Grok"; case .muse: "Muse"; case .antigravity: "Antigravity" } }
}

/// Host-authoritative execution choice. Nil controls use the CLI's default.
public struct EngineSelection: Codable, Equatable, Sendable {
    public var engine: String
    public var model: String?
    public var reasoningEffort: String?
    public var speed: String?
    public init(engine: String, model: String? = nil, reasoningEffort: String? = nil, speed: String? = nil) {
        self.engine = engine; self.model = model; self.reasoningEffort = reasoningEffort; self.speed = speed
    }
    enum CodingKeys: String, CodingKey { case engine, model, reasoningEffort, speed }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(engine, forKey: .engine)
        try c.encode(model, forKey: .model)
        try c.encode(reasoningEffort, forKey: .reasoningEffort)
        try c.encode(speed, forKey: .speed)
    }
}
public struct ThreadEngineSelection: Codable, Equatable, Sendable {
    public let selection: EngineSelection
    public let override: EngineSelection?
    public let revision: Int
    public let handoffStatus: String
    public let updatedBot: Bot?
}
public enum EngineSelectionScope: String, Codable, Sendable {
    case thread
    case threadAndBot = "thread_and_bot"
}
public struct PatchThreadEngineSelection: Encodable, Sendable {
    public let expectedRevision: Int
    public let selection: EngineSelection?
    public let scope: EngineSelectionScope
    public let expectedBotRevision: Int?
    public init(expectedRevision: Int, selection: EngineSelection?, scope: EngineSelectionScope = .thread, expectedBotRevision: Int? = nil) {
        self.expectedRevision = expectedRevision; self.selection = selection; self.scope = scope; self.expectedBotRevision = expectedBotRevision
    }
    enum CodingKeys: String, CodingKey { case expectedRevision, selection, scope, expectedBotRevision }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(expectedRevision, forKey: .expectedRevision)
        if let selection { try c.encode(selection, forKey: .selection) } else { try c.encodeNil(forKey: .selection) }
        try c.encode(scope, forKey: .scope)
        try c.encodeIfPresent(expectedBotRevision, forKey: .expectedBotRevision)
    }
}

public struct EngineCatalogModel: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let label: String?
    public let reasoningEfforts: [String]
    public let speeds: [String]
}
public struct EngineCatalogEntry: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let available: Bool
    public let models: [EngineCatalogModel]
    public let defaultModel: String?
    public let reasoningEfforts: [String]
    public let speeds: [String]
    public let installed: Bool?
    public let version: String?
    public let adapterSupported: Bool?
    public let unavailableReason: String?
    public let providerID: String?
    public let providerLabel: String?
    public let catalogSource: String?
}
public struct EngineCatalog: Codable, Equatable, Sendable { public let items: [EngineCatalogEntry] }

public struct Bot: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let profileId: String
    public let engine: EngineID
    public let ownerId: String
    public let createdAt: Int64
    public let roleDescription: String
    public let avatarEmoji: String?
    public let avatarImage: AvatarImage?
    public let avatarAppearance: BotAvatarAppearance?
    public let canSeeBots: Bool
    public let canReceiveOrders: Bool
    public let canSendActions: Bool
    public let isMaster: Bool
    public let revision: Int
    public let defaultSelection: EngineSelection?
    public let liveVoice: String?

    public init(id: String, name: String, profileId: String, engine: EngineID, ownerId: String, createdAt: Int64,
                roleDescription: String = "", avatarEmoji: String? = nil, avatarImage: AvatarImage? = nil, avatarAppearance: BotAvatarAppearance? = nil, canSeeBots: Bool = false,
                canReceiveOrders: Bool = false, canSendActions: Bool = false, isMaster: Bool = false, revision: Int = 0, defaultSelection: EngineSelection? = nil, liveVoice: String? = nil) {
        self.id = id; self.name = name; self.profileId = profileId; self.engine = engine
        self.ownerId = ownerId; self.createdAt = createdAt; self.roleDescription = roleDescription
        self.avatarEmoji = avatarEmoji; self.avatarImage = avatarImage; self.avatarAppearance = avatarAppearance; self.canSeeBots = canSeeBots; self.canReceiveOrders = canReceiveOrders
        self.canSendActions = canSendActions; self.isMaster = isMaster; self.revision = revision; self.defaultSelection = defaultSelection
        self.liveVoice = liveVoice
    }
    enum CodingKeys: String, CodingKey {
        case id, name, profileId, engine, ownerId, createdAt, roleDescription, avatarEmoji, avatarImage, avatarAppearance
        case canSeeBots, canReceiveOrders, canSendActions, isMaster, revision, defaultSelection, liveVoice
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); name = try c.decode(String.self, forKey: .name)
        profileId = try c.decode(String.self, forKey: .profileId); engine = try c.decode(EngineID.self, forKey: .engine)
        ownerId = try c.decode(String.self, forKey: .ownerId); createdAt = try c.decode(Int64.self, forKey: .createdAt)
        roleDescription = try c.decodeIfPresent(String.self, forKey: .roleDescription) ?? ""
        avatarEmoji = try c.decodeIfPresent(String.self, forKey: .avatarEmoji)
        avatarImage = try c.decodeIfPresent(AvatarImage.self, forKey: .avatarImage)
        avatarAppearance = try c.decodeIfPresent(BotAvatarAppearance.self, forKey: .avatarAppearance)
        if let avatarImage, !avatarImage.isValid {
            throw DecodingError.dataCorruptedError(forKey: .avatarImage, in: c, debugDescription: "Invalid avatar image")
        }
        canSeeBots = try c.decodeIfPresent(Bool.self, forKey: .canSeeBots) ?? false
        canReceiveOrders = try c.decodeIfPresent(Bool.self, forKey: .canReceiveOrders) ?? false
        canSendActions = try c.decodeIfPresent(Bool.self, forKey: .canSendActions) ?? false
        isMaster = try c.decodeIfPresent(Bool.self, forKey: .isMaster) ?? false
        defaultSelection = try c.decodeIfPresent(EngineSelection.self, forKey: .defaultSelection)
        revision = try c.decodeIfPresent(Int.self, forKey: .revision) ?? 0
        guard revision >= 0 else { throw DecodingError.dataCorruptedError(forKey: .revision, in: c, debugDescription: "Invalid bot revision") }
        liveVoice = try c.decodeIfPresent(String.self, forKey: .liveVoice)
        if let liveVoice, !LiveVoiceCatalog.voices.contains(liveVoice) {
            throw DecodingError.dataCorruptedError(forKey: .liveVoice, in: c, debugDescription: "Invalid bot voice")
        }
    }
}

public enum BotDelegationState: String, Codable, Sendable {
    case pending, running, completed, cancelled, failed, unknown

    public var canCancel: Bool { self == .pending || self == .running }
}

public struct BotDelegation: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let sourceBotId: String
    public let targetBotId: String
    public let sourceThreadId: String
    public let targetThreadId: String
    public let sourceTurnId: String
    public let targetTurnId: String
    public let parentId: String?
    public let rootId: String
    public let depth: Int
    public let deadlineAt: Int64
    public let createdAt: Int64
    public let updatedAt: Int64
    public let state: BotDelegationState
    public let result: String?
}

public enum BotAvatarEmojiPatch: Equatable, Sendable { case unchanged, set(String), clear }
public enum BotLiveVoicePatch: Equatable, Sendable { case unchanged, set(String), clear }

public struct PatchBotInput: Encodable, Equatable, Sendable {
    public let expectedRevision: Int
    public let name: String?
    public let roleDescription: String?
    public let avatarEmoji: BotAvatarEmojiPatch
    public let avatarImageId: AvatarImageIDPatch
    public let avatarAppearance: BotAvatarAppearancePatch
    public let canSeeBots: Bool?
    public let canReceiveOrders: Bool?
    public let canSendActions: Bool?
    public let isMaster: Bool?
    public let defaultSelection: EngineSelection?
    public let liveVoice: BotLiveVoicePatch
    public init(expectedRevision: Int, name: String? = nil, roleDescription: String? = nil,
                avatarEmoji: BotAvatarEmojiPatch = .unchanged, avatarImageId: AvatarImageIDPatch = .unchanged, avatarAppearance: BotAvatarAppearancePatch = .unchanged, canSeeBots: Bool? = nil,
                canReceiveOrders: Bool? = nil, canSendActions: Bool? = nil, isMaster: Bool? = nil, defaultSelection: EngineSelection? = nil, liveVoice: BotLiveVoicePatch = .unchanged) {
        self.expectedRevision = expectedRevision; self.name = name; self.roleDescription = roleDescription
        self.avatarEmoji = avatarEmoji; self.avatarImageId = avatarImageId; self.avatarAppearance = avatarAppearance; self.canSeeBots = canSeeBots; self.canReceiveOrders = canReceiveOrders
        self.canSendActions = canSendActions; self.isMaster = isMaster; self.defaultSelection = defaultSelection
        self.liveVoice = liveVoice
    }
    enum CodingKeys: String, CodingKey { case expectedRevision, name, roleDescription, avatarEmoji, avatarImageId, avatarAppearance, canSeeBots, canReceiveOrders, canSendActions, isMaster, defaultSelection, liveVoice }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(expectedRevision, forKey: .expectedRevision)
        try c.encodeIfPresent(name, forKey: .name); try c.encodeIfPresent(roleDescription, forKey: .roleDescription)
        switch avatarEmoji { case .unchanged: break; case .set(let value): try c.encode(value, forKey: .avatarEmoji); case .clear: try c.encodeNil(forKey: .avatarEmoji) }
        switch avatarImageId {
        case .unchanged: break
        case .set(let value):
            guard avatarImageUUID(value) else {
                throw EncodingError.invalidValue(value, EncodingError.Context(codingPath: encoder.codingPath, debugDescription: "Invalid avatar image ID"))
            }
            try c.encode(value, forKey: .avatarImageId)
        case .clear: try c.encodeNil(forKey: .avatarImageId)
        }
        switch avatarAppearance {
        case .unchanged: break
        case .set(let value): try c.encode(value, forKey: .avatarAppearance)
        case .clear: try c.encodeNil(forKey: .avatarAppearance)
        }
        try c.encodeIfPresent(defaultSelection, forKey: .defaultSelection)
        switch liveVoice {
        case .unchanged: break
        case .set(let value):
            guard LiveVoiceCatalog.voices.contains(value) else {
                throw EncodingError.invalidValue(value, EncodingError.Context(codingPath: encoder.codingPath, debugDescription: "Invalid bot voice"))
            }
            try c.encode(value, forKey: .liveVoice)
        case .clear: try c.encodeNil(forKey: .liveVoice)
        }
        try c.encodeIfPresent(canSeeBots, forKey: .canSeeBots); try c.encodeIfPresent(canReceiveOrders, forKey: .canReceiveOrders)
        try c.encodeIfPresent(canSendActions, forKey: .canSendActions); try c.encodeIfPresent(isMaster, forKey: .isMaster)
    }
}

public enum HostConversationAudience: String, Codable, Equatable, Hashable, Sendable { case `private`, group }
public struct HostThread: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let botId: String
    public let createdAt: Int64
    public let teamID: String?
    private let storedAudience: HostConversationAudience?
    public let groupID: String?
    public let groupConversationID: String?
    public var audience: HostConversationAudience { storedAudience ?? (groupID == nil ? .private : .group) }
    public var isPrivateConversation: Bool { audience == .private && groupID == nil && teamID == nil && !id.hasPrefix("thr_team_") && !id.hasPrefix("thr_group_") }

    public init(id: String, botId: String, createdAt: Int64, teamID: String? = nil, audience: HostConversationAudience = .private, groupID: String? = nil, groupConversationID: String? = nil) {
        self.id = id
        self.botId = botId
        self.createdAt = createdAt
        self.teamID = teamID; storedAudience=audience; self.groupID=groupID; self.groupConversationID=groupConversationID
    }
    enum CodingKeys: String, CodingKey { case id, botId, createdAt; case teamID = "teamId"; case storedAudience = "audience"; case groupID = "groupId"; case groupConversationID = "groupConversationId" }
}

/// Image bytes are stored separately by the host. Transcript entries contain only these references.
public struct ChatAttachment: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let threadId: String
    public let mediaType: String
    public let sha256: String
    public let bytes: Int
    public let width: Int
    public let height: Int

    public init(id: String, threadId: String, mediaType: String, sha256: String, bytes: Int, width: Int, height: Int) {
        self.id = id; self.threadId = threadId; self.mediaType = mediaType; self.sha256 = sha256
        self.bytes = bytes; self.width = width; self.height = height
    }
}

public struct ChatAttachmentUpload: Encodable, Equatable, Sendable {
    public let clientAttachmentId: String
    public let mediaType = "image/png"
    public let dataBase64: String

    public init(clientAttachmentId: String, data: Data) {
        self.clientAttachmentId = clientAttachmentId; dataBase64 = data.base64EncodedString()
    }
}

public struct Message: Codable, Equatable, Identifiable, Sendable {
    public let cursor: Int64
    public let id: String
    public let threadId: String
    public let clientMessageId: String
    public let role: MessageRole
    public let content: String
    public let createdAt: Int64
    public let attachments: [ChatAttachment]?

    public init(cursor: Int64, id: String, threadId: String, clientMessageId: String, role: MessageRole, content: String, createdAt: Int64, attachments: [ChatAttachment]? = nil) {
        self.cursor = cursor
        self.id = id
        self.threadId = threadId
        self.clientMessageId = clientMessageId
        self.role = role
        self.content = content
        self.createdAt = createdAt
        self.attachments = attachments
    }
}

public enum MessageRole: String, Codable, Sendable {
    case user
    case assistant
}

public struct CreateBotInput: Codable, Equatable, Sendable {
    public let name: String
    public let profileId: String
    public let engine: EngineID
    public let avatarImageId: String?
    public let avatarAppearance: BotAvatarAppearance?

    public init(name: String, profileId: String, engine: EngineID, avatarImageId: String? = nil, avatarAppearance: BotAvatarAppearance? = nil) {
        self.name = name
        self.profileId = profileId
        self.engine = engine
        self.avatarImageId = avatarImageId
        self.avatarAppearance = avatarAppearance
    }
}

public struct TurnSubmission: Codable, Equatable, Sendable {
    public let clientRequestId: String
    public let content: String
    public let attachmentIds: [String]?

    public init(content: String, clientRequestId: String = UUID().uuidString.lowercased(), attachmentIds: [String]? = nil) {
        self.clientRequestId = clientRequestId
        self.content = content
        self.attachmentIds = attachmentIds?.isEmpty == false ? attachmentIds : nil
    }
}

public enum TurnState: String, Codable, Sendable {
    case queued
    case running
    case completed
    case interrupted
    case failed
    case unknown

    public var isTerminal: Bool {
        switch self {
        case .queued, .running: false
        case .completed, .interrupted, .failed, .unknown: true
        }
    }
}

public struct Turn: Codable, Equatable, Identifiable, Sendable {
    public let cursor: Int64
    public let id: String
    public let threadId: String
    public let botId: String
    public let engine: EngineID
    public let clientRequestId: String
    public let inputMessageId: String
    public let outputMessageId: String?
    public let state: TurnState
    public let code: String?
    public let outputChars: Int
    public let outputTruncated: Bool
    public let createdAt: Int64
    public let startedAt: Int64?
    public let finishedAt: Int64?
    public let updatedAt: Int64
}

public enum TurnEventKind: String, Codable, Sendable {
    case turnQueued = "turn.queued"
    case turnStarted = "turn.started"
    case textDelta = "text.delta"
    case toolRequested = "tool.requested"
    case toolResolved = "tool.resolved"
    case turnCompleted = "turn.completed"
    case turnInterrupted = "turn.interrupted"
    case turnFailed = "turn.failed"
    case turnUnknown = "turn.unknown"
}

public struct TurnEvent: Codable, Equatable, Identifiable, Sendable {
    public let cursor: Int64
    public let turnId: String
    public let threadId: String
    public let kind: TurnEventKind
    public let text: String?
    public let data: JSONValue?
    public let createdAt: Int64

    public var id: Int64 { cursor }
}

public struct ActionRequest: Codable, Equatable, Sendable {
    public let botId: String
    public let threadId: String
    public let tool: String
    public let destination: String
    public let arguments: [String: JSONValue]
    public let idempotencyKey: String

    public init(botId: String, threadId: String, tool: String, destination: String, arguments: [String: JSONValue], idempotencyKey: String) {
        self.botId = botId
        self.threadId = threadId
        self.tool = tool
        self.destination = destination
        self.arguments = arguments
        self.idempotencyKey = idempotencyKey
    }
}

public enum ActionState: String, Codable, Sendable {
    case awaitingApproval = "awaiting_approval"
    case ready
    case running
    case succeeded
    case denied
    case blocked
    case unknown
}

public enum ActionReason: String, Codable, Sendable {
    case userDenied = "user_denied"
    case approvalExpired = "approval_expired"
    case permissionChanged = "permission_changed"
    case hostInterrupted = "host_interrupted"
    case executorError = "executor_error"
}

public struct Action: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let request: ActionRequest
    public let requestHash: String
    public let grantRevision: Int
    public let state: ActionState
    public let createdAt: Int64
    public let updatedAt: Int64
    public let approvalExpiresAt: Int64?
    public let decidedBy: String?
    public let result: JSONValue?
    public let reason: ActionReason?
    public let authorization: ActionAuthorization?
    public let approvalRequirement: ActionApprovalRequirement?
    public let approvalType: ActionApprovalType?

    public init(
        id: String,
        request: ActionRequest,
        requestHash: String,
        grantRevision: Int,
        state: ActionState,
        createdAt: Int64,
        updatedAt: Int64,
        approvalExpiresAt: Int64?,
        decidedBy: String?,
        result: JSONValue?,
        reason: ActionReason?,
        authorization: ActionAuthorization? = nil,
        approvalRequirement: ActionApprovalRequirement? = nil,
        approvalType: ActionApprovalType? = nil
    ) {
        self.id = id
        self.request = request
        self.requestHash = requestHash
        self.grantRevision = grantRevision
        self.state = state
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.approvalExpiresAt = approvalExpiresAt
        self.decidedBy = decidedBy
        self.result = result
        self.reason = reason
        self.authorization = authorization
        self.approvalRequirement = approvalRequirement
        self.approvalType = approvalType
    }
}

public enum HostEventKind: String, Codable, Sendable {
    case botCreated = "bot.created"
    case botUpdated = "bot.updated"
    case threadCreated = "thread.created"
    case messageAppended = "message.appended"
    case grantChanged = "grant.changed"
    case deviceRegistered = "device.registered"
    case deviceSeen = "device.seen"
    case deviceRenamed = "device.renamed"
    case deviceRevoked = "device.revoked"
    case actionCreated = "action.created"
    case actionDecided = "action.decided"
    case actionStarted = "action.started"
    case actionSucceeded = "action.succeeded"
    case actionBlocked = "action.blocked"
    case actionUnknown = "action.unknown"
}

public enum DevicePlatform: String, Codable, Sendable {
    case macos
    case ios
}

public enum DevicePresence: String, Codable, Sendable {
    case online
    case stale
    case revoked
}

/// Public host projection. Pairing claims, certificate pins, private keys, and offer secrets are never part
/// of this contract; `paired` only reports whether the host has an active device identity binding.
public struct DeviceView: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let ownerId: String
    public let name: String
    public let platform: DevicePlatform
    public let capabilities: [String]
    public let lastSeenAt: Int64
    public let revokedAt: Int64?
    public let presence: DevicePresence
    public let paired: Bool
    /// Binding role from the host's unified device projection (`agent-mac`, `client-mac`, `client-ios`, `unpaired`).
    /// `nil` when the response omits it; a paired macOS device without a role is not assumed to be an executor.
    public let role: String?

    public init(
        id: String,
        ownerId: String,
        name: String,
        platform: DevicePlatform,
        capabilities: [String],
        lastSeenAt: Int64,
        revokedAt: Int64?,
        presence: DevicePresence,
        paired: Bool,
        role: String? = nil
    ) {
        self.id = id
        self.ownerId = ownerId
        self.name = name
        self.platform = platform
        self.capabilities = capabilities
        self.lastSeenAt = lastSeenAt
        self.revokedAt = revokedAt
        self.presence = presence
        self.paired = paired
        self.role = role
    }
}

public struct RenameDeviceInput: Codable, Equatable, Sendable {
    public let name: String

    public init(name: String) {
        self.name = name
    }
}

public struct HostEvent: Codable, Equatable, Identifiable, Sendable {
    public let cursor: Int64
    public let id: String
    public let kind: HostEventKind
    public let botId: String?
    public let threadId: String?
    public let entityId: String
    public let createdAt: Int64
    public let audience: HostConversationAudience?
    public let groupId: String?
    public let groupConversationId: String?

    public var identity: Int64 { cursor }
    public var identifiableID: String { id }
}

public struct CursorPage<Item: Codable & Sendable>: Codable, Sendable {
    public let items: [Item]
    public let nextCursor: Int64

    public init(items: [Item], nextCursor: Int64) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

public struct PairedHealthClient: Codable, Sendable {
    public let deviceId: String, role: String, scopes: [String]
    public let pinGeneration: Int, bindingRevision: Int
}
public struct HostHealth: Codable, Sendable {
    public let protocolVersion: Int, mode: String, engineRouting: String, remotePairing: String
    public let hostId: String?, state: JSONValue?, runtime: JSONValue?
    public let installationId: String?, client: PairedHealthClient?
}
public struct SelfRevokeAcknowledgment: Codable, Sendable { public let deviceId: String, status: String }
public struct DeviceGrant: Codable, Sendable {
    public let botId: String, tool: String, destination: String, policy: String
    public let expiresAt: Int64?, revision: Int
}
public struct DeviceGrantEntry: Codable, Sendable { public let botId: String, tool: String, destination: String; public let grant: DeviceGrant? }
public struct DeviceGrantsPage: Codable, Sendable { public let botId: String; public let items: [DeviceGrantEntry] }
public struct DeviceGrantInput: Encodable, Sendable {
    public let botId: String, tool: String, destination: String, policy: String
    public let expiresAt: Int64?, expectedRevision: Int?
    public init(botId: String, tool: String, destination: String, policy: String, expiresAt: Int64?, expectedRevision: Int?) {
        self.botId = botId; self.tool = tool; self.destination = destination; self.policy = policy; self.expiresAt = expiresAt; self.expectedRevision = expectedRevision
    }
    enum CodingKeys: String, CodingKey { case botId,tool,destination,policy,expiresAt,expectedRevision }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy:CodingKeys.self)
        try c.encode(botId,forKey:.botId); try c.encode(tool,forKey:.tool); try c.encode(destination,forKey:.destination); try c.encode(policy,forKey:.policy)
        try c.encode(expiresAt,forKey:.expiresAt); try c.encode(expectedRevision,forKey:.expectedRevision)
    }
}

public enum DoctorReadyStatus: String, Codable, Sendable {
    case initialized
    case notInitialized = "not_initialized"
}

/// Mirrors the CLI's ready/doctor JSON response; it reports setup metadata, not inference proof.
public struct DoctorReadyResponse: Codable, Sendable {
    public let status: DoctorReadyStatus
    public let dataDir: String
    public let node: String
    public let protocolVersion: Int
    public let schema: Int?
    public let counts: [String: Int]?
    public let engineInference: String?
    public let remotePairing: String?
}

public enum ApprovalDecision: String, Codable, Sendable {
    case allow
    case deny
}

public struct ApprovalDecisionInput: Codable, Equatable, Sendable {
    public let decision: ApprovalDecision
    public let requestHash: String

    public init(decision: ApprovalDecision, requestHash: String) {
        self.decision = decision
        self.requestHash = requestHash
    }
}

public struct ItemEnvelope<Item: Codable & Sendable>: Codable, Sendable {
    public let items: [Item]
}

public struct TurnEventsPage: Codable, Sendable {
    public let items: [TurnEvent]
    public let nextCursor: Int64
}

public struct HostEventsPage: Codable, Sendable {
    public let items: [HostEvent]
    public let nextCursor: Int64
}

public struct MessagesPage: Codable, Sendable {
    public let items: [Message]
    public let nextCursor: Int64
}

public struct TurnsPage: Codable, Sendable {
    public let items: [Turn]
    public let nextCursor: Int64
}

public struct HostContracts: Codable, Sendable {
    public let protocolVersion: Int
    public let schemas: [String:JSONValue]
}
public struct AppendMessageInput: Codable, Sendable {
    public let clientMessageId: String, content: String
    public init(clientMessageId: String, content: String) { self.clientMessageId = clientMessageId; self.content = content }
}
public struct ResumeQueuedAcknowledgment: Codable, Sendable { public let resumed: Int }

// Owner-local immutable Skills registry. Markdown is plain text, never executable UI content.
public struct SkillLock: Codable, Equatable, Hashable, Sendable {
    public let id: String, version: String, sha256: String, commit: String, path: String
    public var identity: String { id + "@" + version }
    public var isValid: Bool {
        SkillRegistrationInput.validID(id) && SkillRegistrationInput.validVersion(version)
            && sha256.range(of: "^[0-9a-f]{64}\\z", options: .regularExpression) != nil
            && commit.range(of: "^[0-9a-f]{40,64}\\z", options: .regularExpression) != nil
            && !path.isEmpty && path.utf16.count <= 512
    }
}
public struct SkillVersion: Codable, Equatable, Sendable { public let lock: SkillLock; public let markdown: String }
public struct SkillsPage: Codable, Sendable { public let items: [SkillLock]; public let next: String? }

public enum SkillScope: Codable, Equatable, Hashable, Sendable {
    case global, bot(String)
    public var kind: String { switch self { case .global: "global"; case .bot: "bot" } }
    public var botID: String? { if case .bot(let id) = self { return id }; return nil }
    public var isValid: Bool {
        guard let botID else { return true }
        return botID.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\\z", options: .regularExpression) != nil
    }
    enum CodingKeys: String, CodingKey { case kind, botId }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "global":
            guard !c.contains(.botId) else { throw DecodingError.dataCorruptedError(forKey: .botId, in: c, debugDescription: "Invalid skill scope") }
            self = .global
        case "bot": self = .bot(try c.decode(String.self, forKey: .botId))
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Invalid skill scope")
        }
        guard isValid else { throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Invalid skill scope") }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind); try c.encodeIfPresent(botID, forKey: .botId)
    }
}
public struct SkillActivation: Codable, Equatable, Sendable {
    public let scope: SkillScope, skillId: String
    public let lock: SkillLock?
    public var isValid: Bool { scope.isValid && SkillRegistrationInput.validID(skillId) && (lock.map { $0.isValid && $0.id == skillId } ?? true) }
}
public struct SkillActivationsPage: Codable, Sendable { public let items: [SkillActivation]; public let next: String? }
public struct SkillRegistrationInput: Encodable, Equatable, Sendable {
    public let id: String, version: String, markdown: String
    public init(id: String, version: String, markdown: String) { self.id = id; self.version = version; self.markdown = markdown }
    public var isValid: Bool { Self.validID(id) && Self.validVersion(version) && !markdown.isEmpty && markdown.utf16.count <= 32768 }
    public static func validID(_ id: String) -> Bool { id.range(of: "^[A-Za-z0-9_-]{1,128}\\z", options: .regularExpression) != nil }
    public static func validVersion(_ version: String) -> Bool { version.utf16.count <= 64 && version.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+\\z", options: .regularExpression) != nil }
}
public struct SkillActivationExpected: Codable, Equatable, Sendable {
    public let version: String, sha256: String
    public init(lock: SkillLock) { version = lock.version; sha256 = lock.sha256 }
}
public struct SkillActivationInput: Encodable, Sendable {
    public let scope: SkillScope, expected: SkillActivationExpected?, version: String?
    public init(scope: SkillScope, expected: SkillActivationExpected?, version: String?) { self.scope = scope; self.expected = expected; self.version = version }
    enum CodingKeys: String, CodingKey { case scope, expected, version }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(scope, forKey: .scope)
        if let expected { try c.encode(expected, forKey: .expected) } else { try c.encodeNil(forKey: .expected) }
        if let version { try c.encode(version, forKey: .version) } else { try c.encodeNil(forKey: .version) }
    }
}
