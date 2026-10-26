import Foundation
import CryptoKit

public struct BotGroup: Codable, Equatable, Identifiable, Sendable {
    public static let maximumMembers = 8
    public let id: String; public let hostId: String; public let name: String; public let revision: Int
    public let archived: Bool; public let members: [GroupMember]; public let createdAt: Int64; public let updatedAt: Int64
    public var activeBotIDs: [String] { members.filter(\.active).map(\.botId) }
    public init(id: String, hostId: String, name: String, revision: Int, members: [GroupMember], archived: Bool = false, createdAt: Int64 = 0, updatedAt: Int64 = 0) {
        self.id=id; self.hostId=hostId; self.name=name; self.revision=revision; self.members=members; self.archived=archived; self.createdAt=createdAt; self.updatedAt=updatedAt
    }
    enum CodingKeys: String, CodingKey { case id,hostId,name,revision,members,createdAt,updatedAt,archived }
    public init(from decoder: Decoder) throws { let c=try decoder.container(keyedBy:CodingKeys.self); id=try c.decode(String.self,forKey:.id); hostId=try c.decode(String.self,forKey:.hostId); name=try c.decode(String.self,forKey:.name); revision=try c.decode(Int.self,forKey:.revision); members=try c.decode([GroupMember].self,forKey:.members); createdAt=try c.decode(Int64.self,forKey:.createdAt); updatedAt=try c.decode(Int64.self,forKey:.updatedAt); archived=try c.decodeIfPresent(Bool.self,forKey:.archived) ?? false }

}
public typealias CollectiveGroup = BotGroup
public typealias BotGroupMember = GroupMember
public enum GroupMemberHistory: String, Codable, Equatable, Sendable { case all; case fromJoin = "from_join" }
public typealias GroupHistory = GroupMemberHistory
public enum GroupMessageOrigin: String, Codable, Equatable, Sendable { case human, bot }
public enum GroupRecipientState: String, Codable, Equatable, Sendable { case queued, admitting, running; case awaitingApproval = "awaiting_approval"; case completed, cancelled, revoked, failed, unknown }
public enum GroupDispatchState: String, Codable, Equatable, Sendable { case queued, held, running; case awaitingApproval = "awaiting_approval"; case completed, partial, cancelled, failed, unknown }
public struct GroupMember: Codable, Equatable, Sendable {
    public let botId: String; public let active: Bool; public let joinedRevision: Int; public let visibleAfter: Int64; public let history: GroupMemberHistory
    public init(botId: String, active: Bool, joinedRevision: Int, visibleAfter: Int64 = 0, history: GroupMemberHistory = .fromJoin) { self.botId=botId; self.active=active; self.joinedRevision=joinedRevision; self.visibleAfter=visibleAfter; self.history=history }
}
public struct GroupConversation: Codable, Equatable, Identifiable, Sendable {
    public let id: String; public let groupId: String; public let createdAt: Int64
    public init(id: String, groupId: String, createdAt: Int64 = 0) { self.id=id; self.groupId=groupId; self.createdAt=createdAt }
}
public struct GroupMessage: Codable, Equatable, Identifiable, Sendable {
    public let id: String; public let cursor: Int64; public let groupId: String; public let conversationId: String
    public let origin: GroupMessageOrigin; public let authorBotId: String?; public let content: String; public let contentHash: String
    public let membershipRevision: Int; public let dispatchId: String?; public let recipientId: String?; public let turnId: String?; public let createdAt: Int64
    public init(id: String, cursor: Int64, groupId: String, conversationId: String, origin: GroupMessageOrigin, authorBotId: String?, content: String, contentHash: String = "", membershipRevision: Int = 1, dispatchId: String? = nil, recipientId: String? = nil, turnId: String? = nil, createdAt: Int64 = 0) {
        self.id=id; self.cursor=cursor; self.groupId=groupId; self.conversationId=conversationId; self.origin=origin; self.authorBotId=authorBotId; self.content=content; self.contentHash=contentHash; self.membershipRevision=membershipRevision; self.dispatchId=dispatchId; self.recipientId=recipientId; self.turnId=turnId; self.createdAt=createdAt
    }
}
public enum GroupRecipients: Codable, Equatable, Sendable {
    case one(String), selected([String]), all
    enum CodingKeys: String, CodingKey { case kind, botId, botIds }
    public init(from decoder: Decoder) throws { let c=try decoder.container(keyedBy: CodingKeys.self); switch try c.decode(String.self,forKey:.kind) {
        case "one": self = .one(try c.decode(String.self,forKey:.botId)); case "selected": self = .selected(try c.decode([String].self,forKey:.botIds)); case "all": self = .all; default: throw HostClientError.contractMismatch
    } }
    public func encode(to encoder: Encoder) throws { var c=encoder.container(keyedBy: CodingKeys.self); switch self {
        case .one(let id): try c.encode("one",forKey:.kind); try c.encode(id,forKey:.botId)
        case .selected(let ids): try c.encode("selected",forKey:.kind); try c.encode(ids,forKey:.botIds)
        case .all: try c.encode("all",forKey:.kind)
    } }
}
public struct GroupRecipient: Codable, Equatable, Identifiable, Sendable {
    public let id: String; public let dispatchId: String; public let botId: String; public let joinedRevision: Int; public let visibleAfter: Int64; public let state: GroupRecipientState
    public let threadId: String?; public let turnId: String?; public let responseMessageId: String?; public let reason: String?; public let observedTurnIds: [String]
}
public struct GroupDispatch: Codable, Equatable, Identifiable, Sendable {
    private let pageCursor: Int64?
    public var cursor: Int64 { pageCursor ?? 0 }
    public let id: String; public let groupId: String; public let conversationId: String; public let inputMessageId: String; public let clientRequestId: String; public let inputHash: String
    public let membershipRevision: Int; public let membershipSnapshot: [GroupMember]; public let recipientBotIds: [String]; public let recipients: [GroupRecipient]
    public let revision: Int; public let deadlineAt: Int64; public let state: GroupDispatchState; public let stopRequested: Bool; public let createdAt: Int64; public let updatedAt: Int64
    enum CodingKeys: String, CodingKey { case pageCursor="cursor"; case id,groupId,conversationId,inputMessageId,clientRequestId,inputHash,membershipRevision,membershipSnapshot,recipientBotIds,recipients,revision,deadlineAt,state,stopRequested,createdAt,updatedAt }
    public var terminal: Bool { [.completed,.partial,.cancelled,.failed,.unknown].contains(state) }
    public var canResume: Bool { state == .held && !stopRequested && deadlineAt > Int64(Date().timeIntervalSince1970 * 1000) && recipients.allSatisfy { $0.state == .queued && $0.turnId == nil } }
}
public struct GroupPage<Item: Decodable & Sendable>: Decodable, Sendable { public let items: [Item]; public let nextCursor: Int64? }
public struct GroupReceipt<Result: Decodable & Sendable>: Decodable, Sendable {
    public let id: String; public let operation: String; public let scopeId: String; public let clientRequestId: String; public let inputHash: String
    public let previousRevision: Int; public let revision: Int; public let result: Result; public let createdAt: Int64
}
public struct GroupMutation: Codable, Equatable, Sendable {
    public let expectedHostId: String; public let clientRequestId: String; public let expectedRevision: Int
    public let name: String?; public let botIds: [String]?; public let historyBotIds: [String]?; public let content: String?; public let recipients: GroupRecipients?
    public init(expectedHostId: String, clientRequestId: String = UUID().uuidString.lowercased(), expectedRevision: Int, name: String? = nil, botIds: [String]? = nil, historyBotIds: [String]? = nil, content: String? = nil, recipients: GroupRecipients? = nil) {
        self.expectedHostId=expectedHostId; self.clientRequestId=clientRequestId; self.expectedRevision=expectedRevision; self.name=name; self.botIds=botIds; self.historyBotIds=historyBotIds; self.content=content; self.recipients=recipients
    }
    public var inputHash: String? { let encoder=JSONEncoder(); encoder.outputFormatting=[.sortedKeys,.withoutEscapingSlashes]; guard let data=try? encoder.encode(self) else {return nil}; return SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined() }

}
public struct GroupDispatchResponse: Decodable, Sendable { public let dispatch: GroupDispatch }
extension HostClient {
    private func groupOwner() throws { guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden } }
    public func groupPage<T: Decodable & Sendable>(_ path: String, after: Int64? = nil, limit: Int = 50) async throws -> GroupPage<T> {
        try groupOwner(); guard (1...50).contains(limit), (after ?? 0) >= 0 else { throw HostClientError.invalidRequest }
        let page: GroupPage<T> = try await request(path, query: [URLQueryItem(name: "after", value: String(after ?? 0)), URLQueryItem(name: "limit", value: String(limit))], timeout: 15)
        guard page.items.count <= limit, page.nextCursor.map({ $0 > (after ?? 0) }) ?? true else { throw HostClientError.contractMismatch }; return page
    }
    public func listGroups(after: Int64? = nil) async throws -> GroupPage<CollectiveGroup> { try await groupPage("/v1/groups", after: after) }
    public func getGroup(id: String) async throws -> CollectiveGroup { try groupOwner(); return try await request("/v1/groups/" + groupID(id),timeout:15) }
    public func groupConversations(groupID id: String, after: Int64? = nil) async throws -> GroupPage<GroupConversation> { try await groupPage("/v1/groups/" + groupID(id) + "/conversations",after:after) }
    public func groupMessages(conversationID id: String, after: Int64? = nil) async throws -> GroupPage<GroupMessage> { try await groupPage("/v1/group-conversations/" + groupID(id) + "/messages",after:after) }
    public func groupDispatches(conversationID id: String, after: Int64? = nil) async throws -> GroupPage<GroupDispatch> { try await groupPage("/v1/group-conversations/" + groupID(id) + "/dispatches",after:after) }
    public func getGroupDispatch(id: String) async throws -> GroupDispatch { try groupOwner(); return try await request("/v1/group-dispatches/" + groupID(id),timeout:15) }
    public func groupMutation<T: Decodable & Sendable>(_ path: String, method: String = "POST", input: GroupMutation) async throws -> T {
        try groupOwner(); guard !input.expectedHostId.isEmpty, !input.clientRequestId.isEmpty, input.expectedRevision >= 0 else { throw HostClientError.invalidRequest }
        do { return try await request(path,method:method,body:input,timeout:15) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let e as HostClientError { switch e { case .offline,.hostFailure,.contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw e } }
    }
    public func groupReceipt<T: Decodable & Sendable>(_ path: String) async throws -> T { try groupOwner(); return try await request(path,timeout:15) }
}
public func groupID(_ id: String) throws -> String {
    let allowed=CharacterSet(charactersIn:"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.")
    guard !id.isEmpty, id.utf8.count <= 128, id.unicodeScalars.allSatisfy({allowed.contains($0)}) else { throw HostClientError.invalidRequest }; return id
}
