import Foundation

// Connection setup requests (`packages/contracts/src/connection-workflows.ts`, version 1). A request is created only by the
// host, from an exact-approved `connections.request` or `mcp.authorize`, with the bot/thread/turn taken from the
// capability; this client never creates one and never chooses its bot. Completing it records the owner's explicit
// selection (already granted through the existing access routes) and lets the host create one continuation of the
// original task. Any doubt about a POST is settled by GET of the same request, never by sending it again.

public enum ConnectionWorkflowState: String, Codable, Equatable, Sendable {
    case awaitingUser = "awaiting_user", ready, cancelled, expired, stopped, conflict
    public var isOpen: Bool { self == .awaitingUser }
}

/// What the request asks for: one managed service of the pinned catalog, or one native MCP instance of a pinned generation.
public enum ConnectionWorkflowTarget: Codable, Equatable, Sendable {
    case managed(serviceId: String, catalogPin: String)
    case nativeMCP(serverId: String, instancePin: String)

    private enum CodingKeys: String, CodingKey, CaseIterable { case kind, serviceId, catalogPin, serverId, instancePin }
    private struct AnyKey: CodingKey {
        let stringValue: String
        let intValue: Int? = nil
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    public init(from decoder: any Decoder) throws {
        let keys = Set(try decoder.container(keyedBy: AnyKey.self).allKeys.map(\.stringValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .kind) {
        case "managed":
            guard keys == ["kind", "serviceId", "catalogPin"] else { throw HostClientError.contractMismatch }
            self = .managed(serviceId: try values.decode(String.self, forKey: .serviceId), catalogPin: try values.decode(String.self, forKey: .catalogPin))
        case "native_mcp":
            guard keys == ["kind", "serverId", "instancePin"] else { throw HostClientError.contractMismatch }
            self = .nativeMCP(serverId: try values.decode(String.self, forKey: .serverId), instancePin: try values.decode(String.self, forKey: .instancePin))
        default: throw HostClientError.contractMismatch
        }
    }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .managed(let service, let pin): try c.encode("managed", forKey: .kind); try c.encode(service, forKey: .serviceId); try c.encode(pin, forKey: .catalogPin)
        case .nativeMCP(let server, let pin): try c.encode("native_mcp", forKey: .kind); try c.encode(server, forKey: .serverId); try c.encode(pin, forKey: .instancePin)
        }
    }
    var isValid: Bool {
        switch self {
        case .managed(let service, let pin): connectionWorkflowIDIsValid(service) && connectionHashIsValid(pin)
        case .nativeMCP(let server, let pin): connectionWorkflowIDIsValid(server) && connectionHashIsValid(pin)
        }
    }
}

/// One exact tool of a selection, pinned by the manifest hash the host published for it.
public struct ConnectionWorkflowTool: Codable, Equatable, Sendable {
    public let name: String
    public let manifestHash: String
    public init(name: String, manifestHash: String) { self.name = name; self.manifestHash = manifestHash }
}

/// One explicit connection (account or native instance) at an exact revision, with exact tools. Never a wildcard.
public struct ConnectionWorkflowSelection: Codable, Equatable, Sendable {
    public let connectionId: String
    public let expectedRevision: Int
    public let tools: [ConnectionWorkflowTool]
    public init(connectionId: String, expectedRevision: Int, tools: [ConnectionWorkflowTool]) {
        self.connectionId = connectionId; self.expectedRevision = expectedRevision; self.tools = tools
    }
    var isValid: Bool {
        connectionWorkflowIDIsValid(connectionId) && expectedRevision >= 1 && expectedRevision <= 9_007_199_254_740_991
            && (1...256).contains(tools.count) && Set(tools.map(\.name)).count == tools.count
            && tools.allSatisfy { connectionWorkflowIDIsValid($0.name) && connectionHashIsValid($0.manifestHash) }
    }
}

/// `GET /v1/connections/setup-requests/:id/choices`: the connections this request may use right now (the request bot's
/// profile, the requested service or native instance, active only), each with the exact pins `complete` checks — the
/// gateway connection at its revision and each active tool's manifest hash — and whether the bot holds a grant for that
/// tool now. Reading choices grants nothing; there is no "all future accounts".
public struct ConnectionWorkflowChoices: Codable, Equatable, Sendable {
    public struct Choice: Codable, Equatable, Sendable, Identifiable {
        public struct Tool: Codable, Equatable, Sendable {
            public let name: String
            public let manifestHash: String
            public let effect: ConnectionToolEffect
            /// The request's bot holds a non-deny grant for this tool on this connection.
            public let enabled: Bool
        }
        public let connectionId: String
        /// Gateway connection revision (not the managed account revision).
        public let expectedRevision: Int
        public let label: String
        public let tools: [Tool]
        public var id: String { connectionId }
        var isValid: Bool {
            connectionWorkflowIDIsValid(connectionId) && expectedRevision >= 1 && expectedRevision <= 9_007_199_254_740_991
                && !label.isEmpty && label.utf16.count <= 200 && tools.count <= 256 && Set(tools.map(\.name)).count == tools.count
                && tools.allSatisfy { connectionWorkflowIDIsValid($0.name) && connectionHashIsValid($0.manifestHash) }
        }
        /// Exactly the tools the bot holds on this connection, as the complete body expects; nil when it holds none.
        public var enabledSelection: ConnectionWorkflowSelection? {
            let tools = tools.filter(\.enabled).map { ConnectionWorkflowTool(name: $0.name, manifestHash: $0.manifestHash) }
            return tools.isEmpty ? nil : ConnectionWorkflowSelection(connectionId: connectionId, expectedRevision: expectedRevision, tools: tools)
        }
    }
    public let requestId: String
    public let revision: Int
    public let choices: [Choice]
    /// Client request ids of the managed logins already started for this request, oldest first: after closing and
    /// reopening, the same attempt is read back (GET) instead of creating a new provider link.
    public let authorizationRequestIds: [String]
    private enum CodingKeys: String, CodingKey { case requestId, revision, choices, authorizationRequestIds }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId); revision = try c.decode(Int.self, forKey: .revision)
        choices = try c.decode([Choice].self, forKey: .choices)
        authorizationRequestIds = try c.decodeIfPresent([String].self, forKey: .authorizationRequestIds) ?? []
    }
    var isValid: Bool {
        connectionWorkflowIDIsValid(requestId) && revision >= 1 && choices.count <= 64
            && Set(choices.map(\.connectionId)).count == choices.count && choices.allSatisfy(\.isValid)
            && authorizationRequestIds.count <= 64 && authorizationRequestIds.allSatisfy(connectionWorkflowIDIsValid)
    }
}

public struct ConnectionWorkflow: Codable, Equatable, Sendable, Identifiable {
    public let version: Int
    public let id: String, hostId: String, botId: String, threadId: String, originTurnId: String, actionId: String
    public let clientRequestId: String, requestHash: String
    public let target: ConnectionWorkflowTarget
    public let revision: Int
    public let state: ConnectionWorkflowState
    public let expiresAt: Int64, createdAt: Int64
    public let selections: [ConnectionWorkflowSelection]
    /// Set by the host when it created the one continuation of the original task; never inferred by the app.
    public let continuationTurnId: String?

    var isValid: Bool {
        version == 1 && [id, hostId, botId, threadId, originTurnId, actionId].allSatisfy(connectionWorkflowIDIsValid)
            && connectionWorkflowUUIDIsValid(clientRequestId) && connectionHashIsValid(requestHash) && target.isValid
            && revision >= 1 && revision <= 9_007_199_254_740_991 && expiresAt >= 0 && createdAt >= 0
            && selections.count <= 5 && selections.allSatisfy(\.isValid) && (continuationTurnId.map(connectionWorkflowIDIsValid) ?? true)
    }
}

/// List envelope of `GET /v1/connections/setup-requests` (host: `{requests}`).
public struct ConnectionWorkflows: Codable, Equatable, Sendable {
    public let requests: [ConnectionWorkflow]
    /// Malformed entries remain non-actionable; valid siblings are still shown, with an incomplete-list notice.
    public let invalidRequestCount: Int
    private enum CodingKeys: String, CodingKey { case requests }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try c.decode([JSONValue].self, forKey: .requests)
        guard raw.count <= 500 else { throw HostClientError.contractMismatch }
        let decoder = JSONDecoder(), encoder = JSONEncoder()
        requests = raw.compactMap { item in
            guard let data = try? encoder.encode(item), let value = try? decoder.decode(ConnectionWorkflow.self, from: data), value.isValid else { return nil }
            return value
        }
        invalidRequestCount = raw.count - requests.count
    }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(requests, forKey: .requests)
    }
}

public struct CompleteConnectionWorkflowInput: Encodable, Equatable, Sendable {
    public let expectedHostID: String, clientRequestId: String
    public let expectedRevision: Int
    public let selections: [ConnectionWorkflowSelection]
    public init(workflow: ConnectionWorkflow, selections: [ConnectionWorkflowSelection], clientRequestId: String = UUID().uuidString.lowercased()) {
        expectedHostID = workflow.hostId; self.clientRequestId = clientRequestId; expectedRevision = workflow.revision; self.selections = selections
    }
    var isValid: Bool {
        connectionWorkflowIDIsValid(expectedHostID) && connectionWorkflowUUIDIsValid(clientRequestId) && expectedRevision >= 1
            && (1...5).contains(selections.count) && Set(selections.map(\.connectionId)).count == selections.count && selections.allSatisfy(\.isValid)
    }
}

public struct CancelConnectionWorkflowInput: Encodable, Equatable, Sendable {
    public let expectedHostID: String, clientRequestId: String
    public let expectedRevision: Int
    public init(workflow: ConnectionWorkflow, clientRequestId: String = UUID().uuidString.lowercased()) {
        expectedHostID = workflow.hostId; self.clientRequestId = clientRequestId; expectedRevision = workflow.revision
    }
    var isValid: Bool { connectionWorkflowIDIsValid(expectedHostID) && connectionWorkflowUUIDIsValid(clientRequestId) && expectedRevision >= 1 }
}

extension HostClient {
    /// Open and recent setup requests of this base (owner). 404 means this base has no such route yet.
    public func connectionSetupRequests() async throws -> ConnectionWorkflows {
        try requireConnections(.connectionsRead)
        let value: ConnectionWorkflows = try await request("/v1/connections/setup-requests", timeout: 15, localAttachmentRequest: true)
        guard value.requests.count <= 500, Set(value.requests.map(\.id)).count == value.requests.count, value.requests.allSatisfy(\.isValid),
              Set(value.requests.map(\.hostId)).count <= 1 else { throw HostClientError.contractMismatch }
        return value
    }
    /// GET of one request: also the only reconciliation of an uncertain complete or cancel.
    public func connectionSetupRequest(id: String) async throws -> ConnectionWorkflow {
        try requireConnections(.connectionsRead)
        guard connectionWorkflowIDIsValid(id) else { throw HostClientError.invalidRequest }
        let value: ConnectionWorkflow = try await request("/v1/connections/setup-requests/\(connectionPathSegment(id))", timeout: 15, localAttachmentRequest: true)
        guard value.isValid, value.id == id else { throw HostClientError.contractMismatch }
        return value
    }
    /// GET of the current choices of one request (pins re-read each time; reading grants nothing).
    public func connectionSetupChoices(id: String) async throws -> ConnectionWorkflowChoices {
        try requireConnections(.connectionsRead)
        guard connectionWorkflowIDIsValid(id) else { throw HostClientError.invalidRequest }
        let value: ConnectionWorkflowChoices = try await request("/v1/connections/setup-requests/\(connectionPathSegment(id))/choices", timeout: 15, localAttachmentRequest: true)
        guard value.isValid, value.requestId == id else { throw HostClientError.contractMismatch }
        return value
    }
    /// One POST: the host validates the current grants, manifests and accounts of each selection and creates at most one
    /// continuation. Any doubt is `mutationOutcomeUnknown`: read `connectionSetupRequest(id:)`, never re-send.
    public func completeConnectionSetupRequest(id: String, _ input: CompleteConnectionWorkflowInput) async throws -> ConnectionWorkflow {
        try requireConnections(.connectionsManage)
        guard connectionWorkflowIDIsValid(id), input.isValid else { throw HostClientError.invalidRequest }
        let value: ConnectionWorkflow = try await connectionsMutation("/v1/connections/setup-requests/\(connectionPathSegment(id))/complete", method: "POST", body: input)
        guard value.isValid, value.id == id, value.hostId == input.expectedHostID, value.revision > input.expectedRevision else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
    /// Recusar: one POST that makes the request (and any late handoff) inert. Never undoes an access already granted.
    public func cancelConnectionSetupRequest(id: String, _ input: CancelConnectionWorkflowInput) async throws -> ConnectionWorkflow {
        try requireConnections(.connectionsManage)
        guard connectionWorkflowIDIsValid(id), input.isValid else { throw HostClientError.invalidRequest }
        let value: ConnectionWorkflow = try await connectionsMutation("/v1/connections/setup-requests/\(connectionPathSegment(id))/cancel", method: "POST", body: input)
        guard value.isValid, value.id == id, value.hostId == input.expectedHostID, value.revision > input.expectedRevision else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
}

func connectionWorkflowIDIsValid(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9_.:-]{1,128}$", options: .regularExpression) != nil }
func connectionWorkflowUUIDIsValid(_ value: String) -> Bool {
    value.range(of: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", options: .regularExpression) != nil
}
