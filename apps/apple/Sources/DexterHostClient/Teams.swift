import Foundation

/// Owner-local team context. Membership grants no bot or tool permissions.
public struct Team: Codable, Equatable, Identifiable, Sendable {
    public static let maximumCount = 100
    public static let maximumMembers = 32
    public let id: String
    public let ownerId: String
    public let name: String
    public let avatarEmoji: String?
    public let avatarImage: AvatarImage?
    public let roleDescription: String
    public let coordinatorBotId: String?
    public let botIds: [String]
    public let rules: String
    public let memory: String
    public let revision: Int
    public let createdAt: Int64
    public let updatedAt: Int64

    public init(id: String, ownerId: String, name: String, avatarEmoji: String? = nil, avatarImage: AvatarImage? = nil,
                roleDescription: String = "", coordinatorBotId: String?, botIds: [String],
                rules: String = "", memory: String = "", revision: Int, createdAt: Int64, updatedAt: Int64) {
        self.id = id; self.ownerId = ownerId; self.name = name; self.avatarEmoji = avatarEmoji; self.avatarImage = avatarImage
        self.roleDescription = roleDescription; self.coordinatorBotId = coordinatorBotId; self.botIds = botIds
        self.rules = rules; self.memory = memory; self.revision = revision; self.createdAt = createdAt; self.updatedAt = updatedAt
    }
    var isValid: Bool {
        teamSafeID(id) && teamSafeID(ownerId) && teamNameValid(name) && teamEmojiValid(avatarEmoji) && (avatarImage?.isValid ?? true)
        && roleDescription.utf16.count <= 2_000 && rules.utf16.count <= 8_192 && memory.utf16.count <= 8_192
        && revision >= 0 && revision <= 9_007_199_254_740_991 && createdAt >= 0 && updatedAt >= createdAt
        && botIds.count <= Self.maximumMembers && Set(botIds).count == botIds.count && botIds.allSatisfy(teamSafeID)
        && (coordinatorBotId.map { botIds.contains($0) } ?? true)
    }
}

public struct CreateTeamInput: Encodable, Equatable, Sendable {
    public let expectedHostID: String
    public let clientRequestId: String
    public let name: String
    public let avatarEmoji: String?
    public let avatarImageId: String?
    public let roleDescription: String
    public let coordinatorBotId: String
    public let botIds: [String]
    public let rules: String
    public let memory: String
    public init(expectedHostID: String, clientRequestId: String, name: String, avatarEmoji: String? = nil, avatarImageId: String? = nil,
                roleDescription: String = "", coordinatorBotId: String, botIds: [String], rules: String = "", memory: String = "") {
        self.expectedHostID = expectedHostID; self.clientRequestId = clientRequestId; self.name = name
        self.avatarEmoji = avatarEmoji; self.avatarImageId = avatarImageId; self.roleDescription = roleDescription; self.coordinatorBotId = coordinatorBotId
        self.botIds = botIds; self.rules = rules; self.memory = memory
    }
    public var isValid: Bool {
        teamSafeID(expectedHostID) && UUID(uuidString: clientRequestId)?.uuidString.lowercased() == clientRequestId
        && teamNameValid(name) && teamEmojiValid(avatarEmoji) && (avatarImageId.map(avatarImageUUID) ?? true) && roleDescription.utf16.count <= 2_000
        && rules.utf16.count <= 8_192 && memory.utf16.count <= 8_192 && !botIds.isEmpty
        && botIds.count <= Team.maximumMembers && Set(botIds).count == botIds.count
        && botIds.allSatisfy(teamSafeID) && botIds.contains(coordinatorBotId)
    }
    func matches(_ team: Team) -> Bool {
        team.name == name && team.avatarEmoji == avatarEmoji && team.avatarImage?.id == avatarImageId && team.roleDescription == roleDescription
        && team.coordinatorBotId == coordinatorBotId && Set(team.botIds) == Set(botIds) && team.rules == rules && team.memory == memory
    }
}

public struct PatchTeamInput: Encodable, Equatable, Sendable {
    public let expectedHostID: String
    public let expectedRevision: Int
    public let name: String?
    public let avatarEmoji: BotAvatarEmojiPatch
    public let avatarImageId: AvatarImageIDPatch
    public let roleDescription: String?
    public let coordinatorBotId: String?
    public let botIds: [String]?
    public let rules: String?
    public let memory: String?
    public init(expectedHostID: String, expectedRevision: Int, name: String? = nil,
                avatarEmoji: BotAvatarEmojiPatch = .unchanged, avatarImageId: AvatarImageIDPatch = .unchanged, roleDescription: String? = nil,
                coordinatorBotId: String? = nil, botIds: [String]? = nil, rules: String? = nil, memory: String? = nil) {
        self.expectedHostID = expectedHostID; self.expectedRevision = expectedRevision; self.name = name
        self.avatarEmoji = avatarEmoji; self.avatarImageId = avatarImageId; self.roleDescription = roleDescription; self.coordinatorBotId = coordinatorBotId
        self.botIds = botIds; self.rules = rules; self.memory = memory
    }
    public var isValid: Bool {
        guard teamSafeID(expectedHostID), expectedRevision >= 0, expectedRevision < 9_007_199_254_740_991,
              name.map(teamNameValid) ?? true, roleDescription.map({ $0.utf16.count <= 2_000 }) ?? true,
              rules.map({ $0.utf16.count <= 8_192 }) ?? true, memory.map({ $0.utf16.count <= 8_192 }) ?? true,
              coordinatorBotId.map(teamSafeID) ?? true else { return false }
        if case .set(let emoji) = avatarEmoji, !teamEmojiValid(emoji) { return false }
        if case .set(let id) = avatarImageId, !avatarImageUUID(id) { return false }
        if let botIds {
            guard !botIds.isEmpty, botIds.count <= Team.maximumMembers, Set(botIds).count == botIds.count,
                  botIds.allSatisfy(teamSafeID), coordinatorBotId.map({ botIds.contains($0) }) ?? true else { return false }
        }
        return true
    }
    enum CodingKeys: String, CodingKey { case expectedHostID, expectedRevision, name, avatarEmoji, avatarImageId, roleDescription, coordinatorBotId, botIds, rules, memory }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(expectedHostID, forKey: .expectedHostID); try c.encode(expectedRevision, forKey: .expectedRevision)
        try c.encodeIfPresent(name, forKey: .name); try c.encodeIfPresent(roleDescription, forKey: .roleDescription)
        switch avatarEmoji { case .unchanged: break; case .set(let value): try c.encode(value, forKey: .avatarEmoji); case .clear: try c.encodeNil(forKey: .avatarEmoji) }
        switch avatarImageId { case .unchanged: break; case .set(let value): try c.encode(value, forKey: .avatarImageId); case .clear: try c.encodeNil(forKey: .avatarImageId) }
        try c.encodeIfPresent(coordinatorBotId, forKey: .coordinatorBotId); try c.encodeIfPresent(botIds, forKey: .botIds)
        try c.encodeIfPresent(rules, forKey: .rules); try c.encodeIfPresent(memory, forKey: .memory)
    }
    func matches(_ team: Team) -> Bool {
        if let name, team.name != name { return false }
        if let roleDescription, team.roleDescription != roleDescription { return false }
        switch avatarEmoji { case .unchanged: break; case .set(let value): if team.avatarEmoji != value { return false }; case .clear: if team.avatarEmoji != nil { return false } }
        switch avatarImageId { case .unchanged: break; case .set(let value): if team.avatarImage?.id != value { return false }; case .clear: if team.avatarImage != nil { return false } }
        if let coordinatorBotId, team.coordinatorBotId != coordinatorBotId { return false }
        if let botIds, Set(team.botIds) != Set(botIds) { return false }
        if let rules, team.rules != rules { return false }; if let memory, team.memory != memory { return false }
        return true
    }
}

public struct CreateTeamThreadInput: Encodable, Equatable, Sendable {
    public let expectedHostID: String
    public let expectedRevision: Int
    public let clientRequestId: String
    public init(expectedHostID: String, expectedRevision: Int, clientRequestId: String) {
        self.expectedHostID = expectedHostID; self.expectedRevision = expectedRevision; self.clientRequestId = clientRequestId
    }
    var isValid: Bool {
        teamSafeID(expectedHostID) && expectedRevision >= 0 && expectedRevision <= 9_007_199_254_740_991
        && UUID(uuidString: clientRequestId)?.uuidString.lowercased() == clientRequestId
    }
}
public struct TeamThreadResponse: Decodable, Equatable, Sendable {
    public let teamId: String
    public let teamRevision: Int
    public let thread: HostThread
}

extension HostClient {
    public func listTeams() async throws -> [Team] {
        try requireTeamOwner()
        let response: TeamItems<Team> = try await request("/v1/teams", timeout: 15)
        guard response.items.count <= Team.maximumCount, Set(response.items.map(\.id)).count == response.items.count,
              response.items.allSatisfy(\.isValid) else { throw HostClientError.contractMismatch }
        return response.items
    }
    public func getTeam(id: String) async throws -> Team {
        try requireTeamOwner()
        let value: Team = try await request(teamPath(id), timeout: 15)
        guard value.id == id, value.isValid else { throw HostClientError.contractMismatch }; return value
    }
    public func createTeam(_ input: CreateTeamInput) async throws -> Team {
        try requireTeamOwner(); guard input.isValid else { throw HostClientError.invalidRequest }
        let value: Team = try await teamMutation("/v1/teams", method: "POST", body: input)
        guard value.isValid, input.matches(value) else { throw HostClientError.mutationOutcomeUnknown }; return value
    }
    public func patchTeam(id: String, input: PatchTeamInput) async throws -> Team {
        try requireTeamOwner(); guard input.isValid else { throw HostClientError.invalidRequest }
        let value: Team = try await teamMutation(teamPath(id), method: "PATCH", body: input)
        guard value.id == id, value.isValid, value.revision == input.expectedRevision + 1, input.matches(value)
        else { throw HostClientError.mutationOutcomeUnknown }; return value
    }
    public func listTeamThreads(teamID: String) async throws -> [HostThread] {
        try requireTeamOwner()
        let response: TeamItems<HostThread> = try await request(teamPath(teamID) + "/threads", timeout: 15)
        guard response.items.count <= 500, Set(response.items.map(\.id)).count == response.items.count,
              response.items.allSatisfy({ teamSafeID($0.id) && teamSafeID($0.botId) && $0.teamID == teamID })
        else { throw HostClientError.contractMismatch }; return response.items
    }
    /// Same owner-local GET as `listTeamThreads`, keeping the host's display-only `summaries`.
    public func listTeamThreadHistory(teamID: String) async throws -> HostThreadHistory {
        try requireTeamOwner()
        let response: HostThreadListResponse = try await request(teamPath(teamID) + "/threads", timeout: 15)
        guard response.items.count <= 500,
              response.items.allSatisfy({ teamSafeID($0.id) && teamSafeID($0.botId) && $0.teamID == teamID })
        else { throw HostClientError.contractMismatch }
        return try HostThreadHistory.validating(listed: response.items, kept: response.items, summaries: response.summaries, cap: nil)
    }
    public func createTeamThread(teamID: String, input: CreateTeamThreadInput) async throws -> TeamThreadResponse {
        try requireTeamOwner(); guard input.isValid else { throw HostClientError.invalidRequest }
        let value: TeamThreadResponse = try await teamMutation(teamPath(teamID) + "/threads", method: "POST", body: input)
        guard value.teamId == teamID, value.teamRevision == input.expectedRevision,
              value.thread.teamID == teamID, teamSafeID(value.thread.id), teamSafeID(value.thread.botId)
        else { throw HostClientError.mutationOutcomeUnknown }; return value
    }
    private func requireTeamOwner() throws {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
    }
    private func teamMutation<T: Decodable & Sendable>(_ path: String, method: String, body: any Encodable) async throws -> T {
        do { return try await request(path, method: method, body: body, timeout: 15) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
    }
}
private struct TeamItems<T: Decodable & Sendable>: Decodable, Sendable { let items: [T] }
private func teamPath(_ id: String) throws -> String {
    guard teamSafeID(id) else { throw HostClientError.invalidRequest }
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
    guard let encoded = id.addingPercentEncoding(withAllowedCharacters: allowed) else { throw HostClientError.invalidRequest }
    return "/v1/teams/\(encoded)"
}
private func teamSafeID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 256 && !value.contains("/") && !value.contains("\\")
    && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
}
private func teamNameValid(_ value: String) -> Bool { !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf16.count <= 120 }
private func teamEmojiValid(_ value: String?) -> Bool {
    guard let value else { return true }
    return value.count == 1 && value.utf16.count <= 16 && value.unicodeScalars.contains { $0.value > 127 && $0.properties.isEmoji }
}
