import DexterHostClient
import Foundation
import Observation

public struct GroupPendingMutation: Equatable, Sendable {
    public var clientRequestId: String { input.clientRequestId }
    public let operation: String; public let path: String; public let receiptPath: String; public let input: GroupMutation
}
public typealias GroupUnconfirmedRequest = GroupPendingMutation
/// Retained by the model. Each callback is pinned to connection generation, host identity and selected scope.
@MainActor @Observable public final class GroupConversationCoordinator {
    public let model: DexterAppModel
    public private(set) var groups: [CollectiveGroup] = []
    public private(set) var conversations: [GroupConversation] = []
    public private(set) var messages: [GroupMessage] = []
    public private(set) var dispatches: [GroupDispatch] = []
    public private(set) var selectedGroupID: String?
    public private(set) var selectedConversationID: String?
    public private(set) var busy = false
    public private(set) var notice: String?
    public private(set) var pending: GroupPendingMutation?
    public private(set) var receiptMissing = false
    public private(set) var groupsCursor: Int64?
    public private(set) var conversationsCursor: Int64?
    public private(set) var messagesCursor: Int64?
    public private(set) var dispatchesCursor: Int64?
    @ObservationIgnored private var hostScope: UUID
    @ObservationIgnored private var hostAddress: String
    @ObservationIgnored private var hostID: String?
    @ObservationIgnored private var client: HostClient?
    @ObservationIgnored private var generation = UUID()
    public init(model: DexterAppModel) { self.model=model; hostScope=model.nativeComposerScope; hostAddress=model.hostAddress; hostID=model.approvalPolicyHostID }
    public var isBoundToCurrentHost: Bool { hostScope == model.nativeComposerScope && hostAddress == model.hostAddress && hostID == model.approvalPolicyHostID }
    public var scopeMatches: Bool { isBoundToCurrentHost && model.canEditBotProfiles && model.isOnline && hostID != nil }
    public func invalidate() { generation=UUID(); client?.close(); client=nil; busy=false; groups=[]; conversations=[]; messages=[]; dispatches=[]; selectedGroupID=nil; selectedConversationID=nil; notice=String(localized: "A conexão mudou. Abra os grupos da base atual.") }
    public var selectedGroup: CollectiveGroup? { groups.first { $0.id == selectedGroupID } }
    public var activeDispatch: GroupDispatch? { dispatches.last { !$0.terminal } }
    public var canMutate: Bool { scopeMatches && !busy && pending == nil }
    public var conversation: GroupConversation? { conversations.first { $0.id == selectedConversationID } }
    public var hasMore: Bool { messagesCursor != nil }
    public var error: String? { notice }
    public var unconfirmed: GroupUnconfirmedRequest? { pending }
    public var canEdit: Bool { canMutate }
    public func clearError() { notice = nil }
    public var canSend: Bool { canMutate && selectedGroup?.archived == false && selectedConversationID != nil && activeDispatch == nil }
    private func accepts(_ token: UUID) -> Bool { generation == token && scopeMatches && !Task.isCancelled }
    private func localClient() -> HostClient? { guard isBoundToCurrentHost,scopeMatches else{return nil}; if client == nil {client=model.makeLocalMcpClient()}; return client }
    private func merge<T: Identifiable>(_ items: [T], into values: inout [T]) { for item in items { if let i=values.firstIndex(where:{$0.id==item.id}) { values[i]=item } else { values.append(item) } } }
    public func loadGroups(more: Bool = false) async {
        guard let client=localClient(), scopeMatches, !busy, !more || groupsCursor != nil else { return }
        busy=true; let token=generation; defer { if generation == token {busy=false} }
        do { let page=try await client.listGroups(after:more ? groupsCursor : nil); guard accepts(token), page.items.allSatisfy({$0.hostId==hostID}) else {return}; if more {merge(page.items,into:&groups)} else {groups=page.items}; groupsCursor=page.nextCursor }
        catch { if accepts(token) {notice=String(localized: "Não foi possível carregar os grupos. Atualize para tentar novamente.")} }
    }
    public func select(groupID: String, conversationID: String? = nil) async {
        guard !busy, pending == nil, let client=localClient(), scopeMatches else {return}
        generation=UUID(); selectedGroupID=groupID; selectedConversationID=conversationID; conversations=[]; messages=[]; dispatches=[]; conversationsCursor=nil; messagesCursor=nil; dispatchesCursor=nil
        busy=true; let token=generation; defer { if generation == token {busy=false} }
        do { let group=try await client.getGroup(id:groupID); guard accepts(token), group.hostId==hostID else {return}; merge([group],into:&groups)
            let page=try await client.groupConversations(groupID:groupID); guard accepts(token), page.items.allSatisfy({$0.groupId==groupID}) else {return}; conversations=page.items; conversationsCursor=page.nextCursor
            selectedConversationID=conversationID ?? page.items.last?.id
        } catch {if accepts(token) {notice=String(localized: "Não foi possível carregar o grupo.")}}
        if accepts(token) {busy=false; await refresh()}
    }
    public func selectConversation(id: String) async { guard !busy, pending == nil, conversations.contains(where:{$0.id==id}) else {return}; generation=UUID(); selectedConversationID=id; messages=[]; dispatches=[]; messagesCursor=nil; dispatchesCursor=nil; await refresh() }
    public func loadMoreConversations() async {
        guard !busy, let id=selectedGroupID, let after=conversationsCursor, let client=localClient(), scopeMatches else {return}
        busy=true; let token=generation; defer {if generation == token {busy=false}}
        do {let page=try await client.groupConversations(groupID:id,after:after); guard accepts(token), page.items.allSatisfy({$0.groupId==id}) else{return}; merge(page.items,into:&conversations); conversationsCursor=page.nextCursor} catch {if accepts(token){notice=String(localized: "Não foi possível carregar mais conversas.")}}
    }
    public func refresh(loadMoreMessages: Bool = false, loadMoreDispatches: Bool = false) async {
        guard !busy, let client=localClient(), scopeMatches, let g=selectedGroupID, let c=selectedConversationID else {return}
        busy=true; let token=generation; defer {if generation == token {busy=false}}
        do {
            let group=try await client.getGroup(id:g); guard accepts(token),group.hostId==hostID else{return}; merge([group],into:&groups)
            if !loadMoreDispatches {
                let after=loadMoreMessages ? messagesCursor : messages.last?.cursor
                if !loadMoreMessages || after != nil {let page=try await client.groupMessages(conversationID:c,after:after); guard accepts(token),page.items.allSatisfy({$0.groupId==g && $0.conversationId==c}) else{return}; merge(page.items,into:&messages); messagesCursor=page.nextCursor}
            }
            if !loadMoreMessages {
                let after=loadMoreDispatches ? dispatchesCursor : dispatches.map(\.cursor).max()
                if !loadMoreDispatches || after != nil {let page=try await client.groupDispatches(conversationID:c,after:after); guard accepts(token),page.items.allSatisfy({$0.groupId==g && $0.conversationId==c}) else{return}; merge(page.items,into:&dispatches); dispatchesCursor=page.nextCursor}
            }
            for old in dispatches where !old.terminal {let d=try await client.getGroupDispatch(id:old.id); guard accepts(token),d.groupId==g && d.conversationId==c else{return}; merge([d],into:&dispatches)}
        } catch {if accepts(token){notice=String(localized: "Não foi possível atualizar a conversa. Confira o host.")}}
    }
    public func refreshUntilSettled() async { let token=generation; for _ in 0..<600 {guard accepts(token) else{return}; await refresh(); guard activeDispatch != nil else{return}; try? await Task.sleep(for:.milliseconds(500))} }
    public func create(name: String, botIDs: [String], historyBotIDs: [String] = []) async -> BotGroup? {
        guard canMutate,let hostID else{return nil}; let accepted = await submit(.init(operation:"create",path:"/v1/groups",receiptPath:"/v1/groups/receipts/",input:.init(expectedHostId:hostID,expectedRevision:0,name:name,botIds:botIDs,historyBotIds:historyBotIDs)))
        return accepted ? selectedGroup : nil
    }
    @discardableResult public func update(group: CollectiveGroup, name: String, botIDs: [String], historyBotIDs: [String]) async -> Bool {
        guard canMutate,let hostID,group.hostId==hostID,(try? groupID(group.id)) != nil else{return false}; return await submit(.init(operation:"update",path:"/v1/groups/\(group.id)",receiptPath:"/v1/groups/\(group.id)/receipts/",input:.init(expectedHostId:hostID,expectedRevision:group.revision,name:name,botIds:botIDs,historyBotIds:historyBotIDs)))
    }
    @discardableResult public func archive(_ group: BotGroup) async -> Bool { guard canMutate, let hostID, group.hostId==hostID else{return false}; return await submit(.init(operation:"delete",path:"/v1/groups/\(group.id)",receiptPath:"/v1/groups/\(group.id)/receipts/",input:.init(expectedHostId:hostID,expectedRevision:group.revision))) }
    public func createConversation() async {guard canMutate,let g=selectedGroup,let hostID else{return}; await submit(.init(operation:"conversation",path:"/v1/groups/\(g.id)/conversations",receiptPath:"/v1/groups/\(g.id)/receipts/",input:.init(expectedHostId:hostID,expectedRevision:g.revision)))}
    @discardableResult public func send(content: String, recipients: GroupRecipients) async -> Bool {guard canSend,let g=selectedGroup,let c=selectedConversationID,let hostID else{return false}; return await submit(.init(operation:"send",path:"/v1/group-conversations/\(c)/send",receiptPath:"/v1/group-conversations/\(c)/send-receipts/",input:.init(expectedHostId:hostID,expectedRevision:g.revision,content:content,recipients:recipients)))}
    public func stop(_ dispatch: GroupDispatch) async {await mutateDispatch(dispatch,operation:"stop")}
    public func resume(_ dispatch: GroupDispatch) async {guard dispatch.canResume else{return}; await mutateDispatch(dispatch,operation:"resume")}
    private func mutateDispatch(_ d: GroupDispatch, operation: String) async {guard canMutate,let hostID,d.groupId==selectedGroupID,d.conversationId==selectedConversationID else{return}; await submit(.init(operation:operation,path:"/v1/group-dispatches/\(d.id)/\(operation)",receiptPath:"/v1/group-dispatches/\(d.id)/receipts/",input:.init(expectedHostId:hostID,expectedRevision:d.revision)))}
    @discardableResult public func update(_ group: BotGroup, name: String, botIDs: [String], historyBotIDs: [String]) async -> Bool { await update(group: group, name: name, botIDs: botIDs, historyBotIDs: historyBotIDs) }
    public func open(groupID: String) async { await select(groupID: groupID); if selectedGroupID == groupID && selectedConversationID == nil && canMutate { await createConversation() } }
    public func loadMore() async { await refresh(loadMoreMessages: true) }
    public func refreshDispatches() async { await refresh() }
    public func canStop(_ d: GroupDispatch) -> Bool { canMutate && !d.terminal && !d.stopRequested && d.groupId == selectedGroupID && d.conversationId == selectedConversationID }
    public func canResume(_ d: GroupDispatch) -> Bool { canMutate && d.canResume && d.membershipRevision == selectedGroup?.revision && d.groupId == selectedGroupID && d.conversationId == selectedConversationID }
    public func stop(dispatchID: String) async { if let d=dispatches.first(where:{$0.id==dispatchID}),canStop(d) { await stop(d) } }
    public func resume(dispatchID: String) async { if let d=dispatches.first(where:{$0.id==dispatchID}),canResume(d) { await resume(d) } }
    private func apply(_ p: GroupPendingMutation, client: HostClient, read: Bool, token: UUID) async throws {
        let path=p.receiptPath+p.input.clientRequestId
        switch p.operation {
        case "create","update","delete": let r: GroupReceipt<CollectiveGroup> = read ? try await client.groupReceipt(path) : try await client.groupMutation(p.path,method:p.operation=="update" ? "PATCH":p.operation=="delete" ? "DELETE":"POST",input:p.input); guard accepts(token) else { throw CancellationError() }; guard r.clientRequestId==p.input.clientRequestId,r.inputHash==p.input.inputHash,r.operation==p.operation,r.result.hostId==hostID,r.revision==p.input.expectedRevision+1 else{throw HostClientError.mutationOutcomeUnknown}; merge([r.result],into:&groups); selectedGroupID=r.result.id
        case "conversation": let r: GroupReceipt<GroupConversation> = read ? try await client.groupReceipt(path) : try await client.groupMutation(p.path,input:p.input); guard accepts(token) else { throw CancellationError() }; guard r.clientRequestId==p.input.clientRequestId,r.inputHash==p.input.inputHash,r.operation==p.operation,r.result.groupId==selectedGroupID else{throw HostClientError.mutationOutcomeUnknown}; merge([r.result],into:&conversations); selectedConversationID=r.result.id; messages=[]; dispatches=[]
        case "send": let r: GroupDispatchResponse = read ? try await client.groupReceipt(path) : try await client.groupMutation(p.path,input:p.input); guard accepts(token) else { throw CancellationError() }; guard r.dispatch.clientRequestId==p.input.clientRequestId,r.dispatch.inputHash==p.input.inputHash,r.dispatch.groupId==selectedGroupID,r.dispatch.conversationId==selectedConversationID else{throw HostClientError.mutationOutcomeUnknown}; merge([r.dispatch],into:&dispatches)
        default: let r: GroupDispatchChange = read ? try await client.groupReceipt(path) : try await client.groupMutation(p.path,input:p.input); guard accepts(token) else { throw CancellationError() }; guard r.receipt.clientRequestId==p.input.clientRequestId,r.receipt.inputHash==p.input.inputHash,r.receipt.operation==p.operation,r.dispatch.groupId==selectedGroupID,r.dispatch.conversationId==selectedConversationID else{throw HostClientError.mutationOutcomeUnknown}; merge([r.dispatch],into:&dispatches)
        }
    }
    @discardableResult private func submit(_ p: GroupPendingMutation, exactRetry: Bool = false) async -> Bool {
        guard !busy,let client=localClient(),scopeMatches,p.input.expectedHostId==hostID,pending==nil || exactRetry && pending==p else{return false}
        pending=p; busy=true; receiptMissing=false; notice=nil; let token=generation
        defer { if generation == token { busy=false } }
        do {try await apply(p,client:client,read:false,token:token); guard accepts(token) else{return false}; pending=nil; busy=false; await refresh(); return true}
        catch {guard accepts(token) else{return false}; busy=false; if error as? HostClientError == .mutationOutcomeUnknown {notice=String(localized: "A confirmação não chegou. Consulte o recibo antes de repetir a solicitação.")} else {pending=nil;notice=String(localized: "O host recusou a alteração. Atualize o estado antes de tentar novamente.")}; return false}
    }
    /// Lost acknowledgements are reconciled by GET only. Missing receipt requires an explicit exact retry.
    public func reconcile() async {
        guard !busy,let p=pending,let client=localClient(),scopeMatches else{return}; busy=true;let token=generation
        defer { if generation == token { busy=false } }
        do {try await apply(p,client:client,read:true,token:token);guard accepts(token) else{return}; pending=nil;receiptMissing=false;busy=false;await refresh()}
        catch {guard accepts(token) else{return};busy=false;receiptMissing=error as? HostClientError == .notFound;notice=receiptMissing ? String(localized: "Recibo ausente no host. Repetir usa exatamente os mesmos dados e ID.") : String(localized: "Não foi possível consultar o recibo. A solicitação foi preservada.")}
    }
    public func retryExactRequest() async {guard receiptMissing,let p=pending else{return};await submit(p,exactRetry:true)}
}
private struct GroupDispatchChange: Decodable, Sendable {let receipt: GroupReceipt<GroupDispatch>;let dispatch: GroupDispatch}
