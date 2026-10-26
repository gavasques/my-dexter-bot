import Foundation

/// Finite, host-issued identity for one actual human settings window. It grants no model tools or credentials.
public struct OwnerConfigurationSession: Codable, Equatable, Sendable {
    public let sessionID: String
    public let hostID: String
    public let ownerID: String
    public let botID: String
    public let profileID: String
    public let botRevision: Int
    public let windowID: String
    public let expiresAt: Int64
}
public enum OwnerConfigurationOperation: String, Codable, Sendable {
    case mcpSelection = "mcp.select_instances"
    case memoryPolicy = "memory.policy.update"
    case memoryCapture = "memory.capture.propose"
    case memoryMaintenance = "memory.maintenance.propose"
    var route: String {
        switch self {
        case .mcpSelection: "mcp/proposals"
        case .memoryPolicy: "memory/policy/proposals"
        case .memoryCapture: "memory/capture/proposals"
        case .memoryMaintenance: "memory/maintenance/proposals"
        }
    }
    var tool: String {
        switch self {
        case .mcpSelection: "dexter.harness.mcp.select_instances"
        case .memoryPolicy: "dexter.memory.policy.update"
        case .memoryCapture: "dexter.harness.memory.append"
        case .memoryMaintenance: "dexter.harness.documents.update"
        }
    }
}

/// Retain this original value after POST or closing a sheet. Reconciliation uses GET only, never a new request ID.
public struct OwnerConfigurationProposal: Equatable, Sendable {
    public let requestID: String
    public let operation: OwnerConfigurationOperation
    public let input: JSONValue
    public let body: JSONValue
    public let bodyHash: String
    private init(operation: OwnerConfigurationOperation, input: JSONValue, requestID: String) throws {
        guard McpRegistrationJSON.validID(requestID) else { throw HostClientError.invalidRequest }
        let field = operation == .mcpSelection ? "plan" : operation == .memoryCapture ? "jobId" : "input"
        let rawInput: JSONValue
        if operation == .memoryCapture {
            guard case .object(let value) = input, case .string(let jobID)? = value["jobId"], ownerConfigurationHash(jobID) else { throw HostClientError.invalidRequest }
            rawInput = .string(jobID)
        } else { rawInput = input }
        let body = JSONValue.object(["clientRequestId": .string(requestID), field: rawInput])
        guard try McpRegistrationJSON.canonical(body).utf8.count <= 262_144 else { throw HostClientError.invalidRequest }
        self.requestID = requestID; self.operation = operation; self.input = input; self.body = body
        bodyHash = McpRegistrationJSON.hash(.object(["operation": .string(operation.rawValue), "input": input]))
    }
    public init(mcpPlan: McpInstanceSelectionPlan, requestID: String = UUID().uuidString.lowercased()) throws {
        guard mcpPlan.isValid else { throw HostClientError.invalidRequest }
        try self.init(operation: .mcpSelection, input: ownerConfigurationJSON(mcpPlan), requestID: requestID)
    }
    public init(memoryPolicy: MemoryRoutinePolicyInput, requestID: String = UUID().uuidString.lowercased()) throws {
        guard memoryPolicy.isValid else { throw HostClientError.invalidRequest }
        try self.init(operation: .memoryPolicy, input: ownerConfigurationJSON(memoryPolicy), requestID: requestID)
    }
    public init(captureJobID: String, requestID: String = UUID().uuidString.lowercased()) throws {
        try self.init(operation: .memoryCapture, input: .object(["jobId": .string(captureJobID)]), requestID: requestID)
    }
    public init(maintenance: MemoryMaintenanceInput, requestID: String = UUID().uuidString.lowercased()) throws {
        guard maintenance.isValid else { throw HostClientError.invalidRequest }
        try self.init(operation: .memoryMaintenance, input: ownerConfigurationJSON(maintenance), requestID: requestID)
    }
}
public struct OwnerConfigurationIntent: Codable, Equatable, Sendable {
    public let kind: String
    public let ownerId: String
    public let windowId: String
    public let clientRequestId: String
    public let operation: OwnerConfigurationOperation
    public let bodyHash: String
}
public struct OwnerConfigurationRequestReceipt: Codable, Equatable, Sendable {
    public let action: Action?
    public let intent: OwnerConfigurationIntent?
}

public struct McpInstanceSelectionInstance: Codable, Equatable, Sendable, Identifiable {
    public var id: String { serverId }
    public let serverId: String
    public let generation: String
    public let instancePin: String
    public let configurationPin: String
    public let connectionId: String
    public let connectionRevision: Int
    var isValid: Bool { UUID(uuidString: generation) != nil && ownerConfigurationHash(instancePin) && ownerConfigurationHash(configurationPin) && connectionRevision > 0 }
}
public struct McpInstanceSelectionTarget: Codable, Equatable, Sendable {
    public let serverId: String
    public let generation: String
    public let instancePin: String
    public let configurationPin: String
    public let connectionId: String
    public let connectionRevision: Int
    public let toolIds: [String]
    public init(instance: McpInstanceSelectionInstance, toolIDs: [String]) {
        serverId = instance.serverId; generation = instance.generation; instancePin = instance.instancePin
        configurationPin = instance.configurationPin; connectionId = instance.connectionId
        connectionRevision = instance.connectionRevision; toolIds = toolIDs
    }
    var isValid: Bool { UUID(uuidString: generation) != nil && ownerConfigurationHash(instancePin) && ownerConfigurationHash(configurationPin) && connectionRevision > 0 && ownerConfigurationTools(toolIds) }
}
public struct McpInstanceSelectionChoice: Codable, Equatable, Sendable {
    public let serverId: String
    public let toolIds: [String]
    public init(serverID: String, toolIDs: [String]) { serverId = serverID; toolIds = toolIDs }
}
public enum McpInstanceSelectionMode: String, Codable, Sendable { case explicit; case allConnected = "all_connected" }
public struct McpInstanceSelectionInput: Codable, Equatable, Sendable {
    public let mode: McpInstanceSelectionMode
    public let expectedInventoryPin: String
    public let expectedSelectionPin: String
    public let expectedRevision: Int
    public let instances: [McpInstanceSelectionChoice]
    public init(review: McpInstanceSelectionReview, mode: McpInstanceSelectionMode, instances: [McpInstanceSelectionChoice]) {
        self.mode = mode; expectedInventoryPin = review.inventoryPin; expectedSelectionPin = review.selectionPin
        expectedRevision = review.revision; self.instances = instances
    }
}
public struct McpInstanceSelectionPlan: Codable, Equatable, Sendable {
    public let version: Int
    public let mode: McpInstanceSelectionMode
    public let inventoryPin: String
    public let selectionPin: String
    public let expectedRevision: Int
    public let targets: [McpInstanceSelectionTarget]
    public var isValid: Bool {
        version == 1 && expectedRevision >= 0 && expectedRevision < 9_007_199_254_740_991 &&
        ownerConfigurationHash(inventoryPin) && ownerConfigurationHash(selectionPin) && targets.count <= 32 &&
        Set(targets.map(\.serverId)).count == targets.count && targets.allSatisfy(\.isValid) && targets.reduce(0, { $0 + $1.toolIds.count }) <= 256
    }
}
public struct McpInstanceSelectionReview: Codable, Equatable, Sendable {
    public struct Selected: Codable, Equatable, Sendable { public let serverId: String; public let connectionId: String; public let toolIds: [String] }
    public struct Unavailable: Codable, Equatable, Sendable { public let serverId: String; public let reason: String }
    public let botId: String
    public let profileId: String
    public let revision: Int
    public let inventoryPin: String
    public let selectionPin: String
    public let instances: [McpInstanceSelectionInstance]
    public let selected: [Selected]
    public let unavailableInstances: [Unavailable]
    public let authenticatedSubject: String
}
public struct McpInstanceSelectionCatalog: Decodable, Sendable {
    public let instance: McpInstanceSelectionInstance
    public let tools: [McpToolSummary]
    public let inventoryPin: String
    public let selectionPin: String
    public let revision: Int
}
public struct McpInstanceSelectionOutcome: Codable, Equatable, Sendable {
    public struct Receipt: Codable, Equatable, Sendable {
        public let version: Int; public let operation: String; public let receiptId: String; public let actionId: String
        public let hubRequestHash: String; public let originHash: String; public let requestHash: String
        public let botId: String; public let profileId: String; public let revision: Int; public let plan: McpInstanceSelectionPlan
        public let steps: [JSONValue]; public let retainedGrants: [JSONValue]; public let phase: String; public let code: String?; public let createdAt: Int64
    }
    public let receipt: Receipt
    public let current: String
    public let matchingStepStates: Int
    public let totalSteps: Int
    public let replayed: Bool
    public let grantsReplayed: Bool
    public let authenticationVerified: Bool
}
public struct McpInstanceSelectionReceiptObservation: Codable, Equatable, Sendable {
    public let action: Action
    public let selection: McpInstanceSelectionOutcome?
}

public struct MemoryRoutinePolicy: Codable, Equatable, Sendable {
    public let revision: Int; public let epoch: Int; public let enabled: Bool; public let maintenanceEnabled: Bool
    public let minIntervalMs: Int; public let maxNotesPerDay: Int; public let maxNoteCharacters: Int
    public let actionId: String?; public let botRevision: Int; public let profileId: String; public let grantRevision: Int; public let updatedAt: Int64
}
public struct MemoryRoutinePolicyInput: Codable, Equatable, Sendable {
    public let expectedRevision: Int; public let enabled: Bool; public let maintenanceEnabled: Bool
    public let minIntervalMs: Int; public let maxNotesPerDay: Int; public let maxNoteCharacters: Int
    public init(expectedRevision: Int, enabled: Bool, maintenanceEnabled: Bool, minIntervalMs: Int = 60000, maxNotesPerDay: Int = 4, maxNoteCharacters: Int = 512) {
        self.expectedRevision = expectedRevision; self.enabled = enabled; self.maintenanceEnabled = maintenanceEnabled
        self.minIntervalMs = minIntervalMs; self.maxNotesPerDay = maxNotesPerDay; self.maxNoteCharacters = maxNoteCharacters
    }
    public var isValid: Bool { expectedRevision >= 0 && expectedRevision < 9_007_199_254_740_991 && (enabled || !maintenanceEnabled) &&
        (60000...86400000).contains(minIntervalMs) && (1...16).contains(maxNotesPerDay) && (1...512).contains(maxNoteCharacters) }
}
public struct MemoryRoutinePolicyStatus: Codable, Equatable, Sendable {
    public let policy: MemoryRoutinePolicy; public let effectiveEnabled: Bool; public let mode: String; public let extractor: String
    public let semanticExtractor: String; public let candidateMeaning: String; public let automaticMemoryWrites: Bool
    public let dreaming: String; public let source: String; public let journal: JSONValue
}
public struct MemoryRoutinePolicyReceipt: Codable, Equatable, Sendable {
    public let actionId: String; public let botId: String; public let ownerId: String; public let actionRequestHash: String
    public let inputHash: String; public let previousRevision: Int; public let policy: MemoryRoutinePolicy
    public let withdrawnJobIds: [String]; public let committedAt: Int64
}
public struct MemoryRoutinePolicyReceiptObservation: Codable, Equatable, Sendable { public let action: Action; public let policyReceipt: MemoryRoutinePolicyReceipt? }
public struct MemoryRoutineJob: Codable, Equatable, Sendable, Identifiable {
    public struct Source: Codable, Equatable, Sendable {
        public let turnId: String; public let threadId: String; public let inputMessageId: String; public let outputMessageId: String
        public let finishedAt: Int64; public let outputHash: String; public let outputCharacters: Int; public let role: String
    }
    public let id: String; public let botId: String; public let profileId: String; public let botRevision: Int; public let epoch: Int; public let policyRevision: Int
    public let kind: String; public let state: String; public let source: Source?; public let note: String?; public let baseRevision: Int
    public let soulHash: String; public let userHash: String; public let memoryHash: String; public let nextMemoryHash: String?
    public let actionId: String?; public let proposalTurnId: String?; public let createdAt: Int64; public let updatedAt: Int64
    public let receipt: DocumentMutationReceipt?
}
public struct MemoryRoutineJobObservation: Codable, Equatable, Sendable { public let job: MemoryRoutineJob; public let documents: BotDocuments? }
public struct MemoryMaintenanceInput: Codable, Equatable, Sendable {
    public let expectedRevision: Int; public let memoryHash: String; public let nextMemoryHash: String
    public init(preview: MemoryMaintenancePreview) { expectedRevision = preview.expectedRevision; memoryHash = preview.memoryHash; nextMemoryHash = preview.nextMemoryHash }
    public var isValid: Bool { expectedRevision >= 0 && expectedRevision < 9_007_199_254_740_991 && ownerConfigurationHash(memoryHash) && ownerConfigurationHash(nextMemoryHash) }
}
public struct MemoryMaintenancePreview: Codable, Equatable, Sendable {
    public struct Removed: Codable, Equatable, Sendable { public let sha256: String; public let characters: Int; public let sample: String; public let sampleTruncated: Bool }
    public let expectedRevision: Int; public let memoryHash: String; public let nextMemoryHash: String; public let removed: [Removed]
}

extension HostClient {
    public func openOwnerConfiguration(bot: Bot, expectedHostID: String, windowID: UUID) async throws -> OwnerConfigurationSession {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let window = windowID.uuidString.lowercased()
        let value: OwnerConfigurationSession = try await request("/v1/bots/\(try ownerConfigurationSegment(bot.id))/configuration-session", method: "POST",
            body: JSONValue.object(["expectedHostID": .string(expectedHostID), "expectedOwnerID": .string(bot.ownerId),
                "expectedBotRevision": .integer(Int64(bot.revision)), "windowID": .string(window)]), timeout: 15)
        guard value.hostID == expectedHostID, value.ownerID == bot.ownerId, value.botID == bot.id, value.profileID == bot.profileId,
              value.botRevision == bot.revision, value.windowID == window, UUID(uuidString: value.sessionID) != nil else { throw HostClientError.contractMismatch }
        return value
    }
    public func ownerMcpSelection(_ session: OwnerConfigurationSession) async throws -> McpInstanceSelectionReview {
        let value: McpInstanceSelectionReview = try await request(try ownerConfigurationPath(session) + "/mcp/selection", timeout: 15)
        guard value.botId == session.botID, value.profileId == session.profileID, value.revision >= 0, value.instances.count <= 32,
              value.instances.allSatisfy(\.isValid), ownerConfigurationHash(value.inventoryPin), ownerConfigurationHash(value.selectionPin),
              value.authenticatedSubject == "unverified" else { throw HostClientError.contractMismatch }; return value
    }
    public func ownerMcpCatalog(_ session: OwnerConfigurationSession, serverID: String) async throws -> McpInstanceSelectionCatalog {
        let value: McpInstanceSelectionCatalog = try await request(try ownerConfigurationPath(session) + "/mcp/catalog/" + ownerConfigurationSegment(serverID), timeout: 15)
        guard value.instance.serverId == serverID, value.instance.isValid, value.tools.count <= 256 else { throw HostClientError.contractMismatch }; return value
    }
    public func ownerMcpPlan(_ session: OwnerConfigurationSession, input: McpInstanceSelectionInput) async throws -> McpInstanceSelectionPlan {
        guard input.instances.count <= 32, input.instances.allSatisfy({ ownerConfigurationTools($0.toolIds) }) else { throw HostClientError.invalidRequest }
        let value: McpInstanceSelectionPlan = try await request(try ownerConfigurationPath(session) + "/mcp/plan", method: "POST", body: input, timeout: 15)
        guard value.isValid, value.expectedRevision == input.expectedRevision, value.inventoryPin == input.expectedInventoryPin,
              value.selectionPin == input.expectedSelectionPin, value.mode == input.mode else { throw HostClientError.contractMismatch }; return value
    }
    public func ownerMemoryPolicy(_ session: OwnerConfigurationSession) async throws -> MemoryRoutinePolicyStatus {
        let value: MemoryRoutinePolicyStatus = try await request(try ownerConfigurationPath(session) + "/memory/policy", timeout: 15)
        guard (!value.effectiveEnabled || value.policy.profileId == session.profileID), value.mode == "candidate_review_only", !value.automaticMemoryWrites,
              value.dreaming == "not_implemented", value.semanticExtractor == "unconfigured",
              ["literal_excerpt", "injected", "unconfigured"].contains(value.extractor) else { throw HostClientError.contractMismatch }; return value
    }
    public func ownerMemoryJobs(_ session: OwnerConfigurationSession, limit: Int = 16) async throws -> [MemoryRoutineJob] {
        guard (1...16).contains(limit) else { throw HostClientError.invalidRequest }
        struct Page: Decodable, Sendable { let items: [MemoryRoutineJob] }
        let value: Page = try await request(try ownerConfigurationPath(session) + "/memory/jobs", query: [URLQueryItem(name: "limit", value: String(limit))], timeout: 15)
        guard value.items.count <= limit, value.items.allSatisfy({ $0.botId == session.botID && ($0.note?.utf16.count ?? 0) <= 512 }) else { throw HostClientError.contractMismatch }; return value.items
    }
    public func ownerMemoryJob(_ session: OwnerConfigurationSession, jobID: String) async throws -> MemoryRoutineJobObservation {
        guard ownerConfigurationHash(jobID) else { throw HostClientError.invalidRequest }
        let value: MemoryRoutineJobObservation = try await request(try ownerConfigurationPath(session) + "/memory/jobs/" + jobID, timeout: 15)
        guard value.job.id == jobID, value.job.botId == session.botID, (value.job.note?.utf16.count ?? 0) <= 512,
              value.documents == nil || value.documents?.botId == session.botID else { throw HostClientError.contractMismatch }; return value
    }
    public func ownerMemoryMaintenancePreview(_ session: OwnerConfigurationSession) async throws -> MemoryMaintenancePreview {
        let value: MemoryMaintenancePreview = try await request(try ownerConfigurationPath(session) + "/memory/maintenance-preview", timeout: 15)
        guard ownerConfigurationHash(value.memoryHash), ownerConfigurationHash(value.nextMemoryHash), value.expectedRevision >= 0,
              value.removed.allSatisfy({ $0.sample.utf16.count <= 256 && ownerConfigurationHash($0.sha256) }) else { throw HostClientError.contractMismatch }; return value
    }
    public func proposeOwnerConfiguration(_ session: OwnerConfigurationSession, original: OwnerConfigurationProposal,
        beforeDispatch: (@MainActor @Sendable () throws -> Void)? = nil) async throws -> Action {
        let value: Action = try await ownerConfigurationMutation(try ownerConfigurationPath(session) + "/" + original.operation.route, body: original.body, beforeDispatch: beforeDispatch)
        guard value.request.botId == session.botID, value.request.tool == original.operation.tool else { throw HostClientError.mutationOutcomeUnknown }; return value
    }
    public func ownerConfigurationRequestReceipt(_ session: OwnerConfigurationSession, original: OwnerConfigurationProposal) async throws -> OwnerConfigurationRequestReceipt {
        let value: OwnerConfigurationRequestReceipt = try await request(try ownerConfigurationPath(session) + "/requests/" + ownerConfigurationSegment(original.requestID), timeout: 15)
        if let action = value.action, let intent = value.intent {
            guard action.request.botId == session.botID, action.request.tool == original.operation.tool,
                  intent.kind == "owner_settings_proposal_v1", intent.ownerId == session.ownerID, intent.windowId == session.windowID,
                  intent.clientRequestId == original.requestID, intent.operation == original.operation, intent.bodyHash == original.bodyHash else { throw HostClientError.contractMismatch }
        } else if value.action != nil || value.intent != nil { throw HostClientError.contractMismatch }
        return value
    }
    public func ownerMcpReceipt(_ session: OwnerConfigurationSession, actionID: String) async throws -> McpInstanceSelectionReceiptObservation {
        let value: McpInstanceSelectionReceiptObservation = try await request(try ownerConfigurationPath(session) + "/mcp/receipts/" + ownerConfigurationSegment(actionID), timeout: 15)
        guard value.action.id == actionID, value.action.request.botId == session.botID else { throw HostClientError.contractMismatch }
        if let selection = value.selection {
            guard selection.receipt.actionId == actionID, selection.receipt.botId == session.botID, selection.receipt.plan.isValid,
                  selection.receipt.hubRequestHash == value.action.requestHash, !selection.grantsReplayed, !selection.authenticationVerified,
                  ["pending", "completed", "partial"].contains(selection.receipt.phase) else { throw HostClientError.contractMismatch }
        }; return value
    }
    public func ownerMemoryPolicyReceipt(_ session: OwnerConfigurationSession, actionID: String) async throws -> MemoryRoutinePolicyReceiptObservation {
        let value: MemoryRoutinePolicyReceiptObservation = try await request(try ownerConfigurationPath(session) + "/memory/policy/receipts/" + ownerConfigurationSegment(actionID), timeout: 15)
        guard value.action.id == actionID, value.action.request.botId == session.botID else { throw HostClientError.contractMismatch }
        if let receipt = value.policyReceipt {
            guard receipt.actionId == actionID, receipt.botId == session.botID, receipt.ownerId == session.ownerID,
                  receipt.actionRequestHash == value.action.requestHash else { throw HostClientError.contractMismatch }
        }; return value
    }
    /// One explicit human decision on the displayed exact action. No automatic decision retry or model request.
    public func decideOwnerConfiguration(_ session: OwnerConfigurationSession, original: OwnerConfigurationProposal, action: Action, decision: ApprovalDecision) async throws -> Action {
        let receipt = try await ownerConfigurationRequestReceipt(session, original: original)
        guard receipt.action?.id == action.id, receipt.action?.request == action.request, receipt.action?.requestHash == action.requestHash else { throw HostClientError.forbidden }
        let value: Action = try await ownerConfigurationMutation("/v1/actions/" + ownerConfigurationSegment(action.id) + "/decisions",
            body: ApprovalDecisionInput(decision: decision, requestHash: action.requestHash))
        guard value.id == action.id, value.requestHash == action.requestHash, value.request == action.request else { throw HostClientError.mutationOutcomeUnknown }; return value
    }
    private func ownerConfigurationPath(_ session: OwnerConfigurationSession) throws -> String {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard UUID(uuidString: session.sessionID) != nil, UUID(uuidString: session.windowID) != nil else { throw HostClientError.invalidRequest }
        return "/v1/owner-configuration/sessions/" + (try ownerConfigurationSegment(session.sessionID))
    }
    private func ownerConfigurationMutation<Response: Decodable & Sendable>(_ path: String, body: any Encodable,
        beforeDispatch: (@MainActor @Sendable () throws -> Void)? = nil) async throws -> Response {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        do { return try await request(path, method: "POST", body: body, timeout: 15, beforeDispatch: beforeDispatch) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
    }
}
private func ownerConfigurationJSON(_ value: some Encodable) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)) }
private func ownerConfigurationSegment(_ value: String) throws -> String {
    guard McpRegistrationJSON.validID(value) else { throw HostClientError.invalidRequest }; return value
}
private func ownerConfigurationHash(_ value: String) -> Bool { value.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil }
private func ownerConfigurationTools(_ values: [String]) -> Bool { values.count <= 256 && Set(values).count == values.count && values == values.sorted() && values.allSatisfy { !$0.isEmpty && $0.utf16.count <= 128 } }
