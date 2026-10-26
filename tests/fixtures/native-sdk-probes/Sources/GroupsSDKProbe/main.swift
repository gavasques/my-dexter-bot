import Foundation
import DexterHostClient
import DexterAppCore

actor LostACKTransport: HTTPTransport {
    private let underlying=URLSessionTransport()
    private var drop=true
    private var methods:[String]=[]
    func send(_ r: URLRequest) async throws -> TransportResponse {
        methods.append(r.httpMethod ?? "GET")
        let response=try await underlying.sendWithoutRedirects(r)
        if r.httpMethod != "GET" && drop { drop=false; throw HostClientError.offline }
        return response
    }
    func audit() -> [String] { methods }
}
@MainActor final class IsolatedStorage: DexterAppStateStorage { var data:Data?;func readData()->Data?{data};func writeData(_ value:Data){data=value};func removeData(){data=nil} }
@main struct Probe {
    static func check(_ v: Bool,_ label:String) throws { if !v { throw NSError(domain:label,code:1) } }
    @MainActor static func main() async throws {
        let args=CommandLine.arguments
        let client=HostClient(baseURL:URL(string:args[1])!)
        let groupID=args[2],conversationID=args[3],hostID=args[4],botID=args[5]
        let g1=try await client.listGroups(); try check(g1.items.count==50 && (g1.nextCursor ?? 0)>0,"groups page1")
        let g2=try await client.listGroups(after:g1.nextCursor); try check(g2.items.count==5 && g2.nextCursor==nil && Set(g1.items.map(\.id)).isDisjoint(with:g2.items.map(\.id)),"groups after")
        let c1=try await client.groupConversations(groupID:groupID); try check(c1.items.count==50 && (c1.nextCursor ?? 0)>0,"conversations page1")
        let c2=try await client.groupConversations(groupID:groupID,after:c1.nextCursor); try check(c2.items.count==5 && c2.nextCursor==nil && c2.items.allSatisfy{$0.groupId==groupID},"conversations after")
        let m1=try await client.groupMessages(conversationID:conversationID); try check(m1.items.count==50 && (m1.nextCursor ?? 0)>0,"messages page1")
        let m2=try await client.groupMessages(conversationID:conversationID,after:m1.nextCursor); try check(m2.items.count==5 && m2.nextCursor==nil && m2.items.allSatisfy{$0.cursor > m1.nextCursor! && $0.origin == .human},"messages after")
        let d1=try await client.groupDispatches(conversationID:conversationID); try check(d1.items.count==50 && (d1.nextCursor ?? 0)>0,"dispatches page1")
        let d2=try await client.groupDispatches(conversationID:conversationID,after:d1.nextCursor); try check(d2.items.count==5 && d2.nextCursor==nil && d2.items.allSatisfy{$0.cursor > d1.nextCursor! && $0.state == .queued},"dispatches after")
        let transport=LostACKTransport(),ackClient=HostClient(baseURL:URL(string:args[1])!,transport:transport)
        let create=GroupMutation(expectedHostId:hostID,clientRequestId:"swift-lost-create-ack",expectedRevision:0,name:"Swift acknowledged by receipt",botIds:[botID],historyBotIds:[])
        do {let _:GroupReceipt<BotGroup> = try await ackClient.groupMutation("/v1/groups",input:create);throw NSError(domain:"lost ACK not injected",code:2)} catch HostClientError.mutationOutcomeUnknown {}
        let receipt:GroupReceipt<BotGroup> = try await ackClient.groupReceipt("/v1/groups/receipts/"+create.clientRequestId)
        try check(receipt.inputHash==create.inputHash && receipt.clientRequestId==create.clientRequestId && receipt.result.name==create.name && receipt.result.hostId==hostID,"lost create ACK GET receipt")
        try check(await transport.audit()==["POST","GET"],"no create mutation replay")
        let sendTransport=LostACKTransport(),sendClient=HostClient(baseURL:URL(string:args[1])!,transport:sendTransport)
        let send=GroupMutation(expectedHostId:hostID,clientRequestId:"swift-lost-send-ack",expectedRevision:1,content:"Native Swift SDK synthetic send",recipients:.one(botID))
        do {let _:GroupDispatchResponse = try await sendClient.groupMutation("/v1/group-conversations/\(conversationID)/send",input:send);throw NSError(domain:"send lost ACK not injected",code:3)} catch HostClientError.mutationOutcomeUnknown {}
        let result:GroupDispatchResponse = try await sendClient.groupReceipt("/v1/group-conversations/\(conversationID)/send-receipts/"+send.clientRequestId)
        try check(result.dispatch.inputHash==send.inputHash && result.dispatch.clientRequestId==send.clientRequestId && result.dispatch.recipientBotIds==[botID],"lost send ACK exact dispatch")
        try check(await sendTransport.audit()==["POST","GET"],"no send replay")
        var settled=result.dispatch
        for _ in 0..<100 { if settled.terminal {break};try await Task.sleep(for:.milliseconds(20));settled=try await client.getGroupDispatch(id:settled.id) }
        try check(settled.terminal,"group settles")
        let laneID=settled.recipients[0].threadId!
        let lane=try await client.getThread(id:laneID)
        try check(lane.audience == .group && lane.groupID == groupID && !lane.isPrivateConversation,"explicit durable Group thread audience")
        do {_ = try await client.listMessages(threadID:laneID);throw NSError(domain:"Group leaked through private message API",code:4)} catch HostClientError.forbidden {}
        let privateThreads=try await client.listThreads(botID:botID)
        try check(privateThreads.count==1 && privateThreads[0].id==args[6] && privateThreads.allSatisfy(\.isPrivateConversation),"SDK private list excludes Group lanes")
        let model=DexterAppModel(client:client,storage:IsolatedStorage())
        await model.refresh();try check(model.isOnline,"actual AppModel refresh")
        let scoped=model.groupCoordinator
        await scoped.select(groupID:groupID,conversationID:conversationID)
        try check(scoped.selectedConversationID==conversationID && scoped.scopeMatches,"per-host Group coordinator")
        model.selectBot(id:botID);let opened=await model.openConversationForSelectedBot(botID)
        try check(opened && model.selectedThreadID==args[6] && model.selectedThread?.isPrivateConversation == true,"actual AppModel group to private latest")
        await model.refresh();try check(model.messages.allSatisfy{!$0.content.contains("HOST GROUP TRANSCRIPT") && !$0.content.contains("Native Swift SDK synthetic send")},"private projection has no Group input/reply")
        model.hostAddress=args[7];model.configureHost();await model.refresh()
        let switched=model.groupCoordinator
        try check(switched !== scoped && switched.isBoundToCurrentHost && !scoped.scopeMatches && switched.groups.isEmpty,"host switch derives fresh coordinator")
        print("NATIVE_APP_PROJECTION_PASS Group marker, private APIs deny lanes, latest private unchanged, per-host coordinator refresh")
        print("NATIVE_SDK_REAL_HTTP_PASS four routes page1=50 page2=5 after>0; enums decoded; lost create/send ACK recovered by GET only")
        client.close();ackClient.close();sendClient.close()
    }
}
