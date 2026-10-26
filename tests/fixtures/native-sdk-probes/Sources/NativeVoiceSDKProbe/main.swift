import Foundation
import DexterHostClient

actor LostACK: HTTPTransport {
    let underlying=URLSessionTransport(); var drop=true; var methods:[String]=[]
    func send(_ request: URLRequest) async throws -> TransportResponse { try await sendWithoutRedirects(request) }
    func sendWithoutRedirects(_ request: URLRequest) async throws -> TransportResponse {
        methods.append(request.httpMethod ?? "GET")
        let result=try await underlying.sendWithoutRedirects(request)
        if request.httpMethod != "GET" && drop { drop=false; throw HostClientError.offline }
        return result
    }
    func audit() -> [String] {methods}
}
@main struct Probe {
    static func check(_ condition: Bool, _ label: String) throws { if !condition { throw NSError(domain:label,code:1) } }
    static func main() async throws {
        let args=CommandLine.arguments, url=URL(string:args[1])!, thread=args[2], host=args[3], bot=args[4]
        let client=HostClient(baseURL:url), startTransport=LostACK(), startClient=HostClient(baseURL:url,transport:startTransport)
        let status=try await client.nativeVoiceStatus(threadID:thread)
        try check(status.supported && status.voices.contains("cove") && status.billing == "subscription_cli", "actual status")
        let preferenceStatus=try await client.nativeVoicePreferences(botID:bot)
        try check(preferenceStatus.preference.voice == nil, "default native preference nil")
        let prefTransport=LostACK(),prefClient=HostClient(baseURL:url,transport:prefTransport)
        let pref=PatchNativeVoicePreference(expectedHostId:host,expectedBotId:bot,expectedBotRevision:status.botRevision,expectedRevision:0,clientRequestId:"swift-preference",voice:"cove")
        do {_ = try await prefClient.patchNativeVoicePreferences(botID:bot,input:pref);throw NSError(domain:"preference lost ACK missing",code:5)} catch HostClientError.mutationOutcomeUnknown {}
        let prefReceipt=try await prefClient.nativeVoicePreferenceReceipt(botID:bot,clientRequestID:pref.clientRequestId)
        try client.validateNativeVoicePreferenceReceipt(prefReceipt,botID:bot,input:pref)
        try check(prefReceipt.preference.voice == "cove" && prefReceipt.preference.revision == 1,"preference GET-only")
        try check(await prefTransport.audit() == ["PATCH","GET"],"no preference replay")
        let input=StartNativeVoice(expectedHostId:host,expectedBotId:bot,expectedBotRevision:status.botRevision,expectedSelectionRevision:status.selectionRevision,
            clientRequestId:"swift-start",generation:UUID().uuidString.lowercased(),sdpOffer:"v=0\nSYNTHETIC_PRIVATE_OFFER",voice:"cove")
        do { _ = try await startClient.startNativeVoice(threadID:thread,input:input); throw NSError(domain:"start lost ACK missing",code:2) } catch HostClientError.mutationOutcomeUnknown {}
        let started=try await startClient.nativeVoiceReceipt(threadID:thread,clientRequestID:input.clientRequestId)
        try client.validateNativeVoiceStartReceipt(started,threadID:thread,input:input)
        do {try input.validateReceipt(started,threadID:"wrong_thread");throw NSError(domain:"receipt scope accepted",code:6)} catch HostClientError.contractMismatch {}
        try check(started.session.id == input.sessionId && started.session.state == .active && started.receipt.operation == "start", "start GET-only receipt")
        try check(await startTransport.audit() == ["POST","GET"], "start was never replayed")
        let exchange=try await client.nativeVoiceExchange(sessionID:input.sessionId,expectedHostID:host,generation:input.generation)
        try check(exchange.sdpAnswer == "v=0\nSYNTHETIC_PRIVATE_ANSWER", "memory-only exchange")
        let first=try await client.nativeVoiceEvents(sessionID:input.sessionId,after:0,limit:1)
        try check(first.items.count == 1 && (first.nextCursor ?? 0) > 0, "event first page")
        let second=try await client.nativeVoiceEvents(sessionID:input.sessionId,after:first.nextCursor!,limit:50)
        try check(!second.items.isEmpty && second.items.allSatisfy{$0.cursor > first.items[0].cursor}, "positive after uses query, not path")
        try check(second.items.allSatisfy{$0.generation == input.generation && $0.sessionId == input.sessionId && $0.text?.contains("SYNTHETIC_PRIVATE") != true}, "scope and media exclusion")
        let current=try await client.nativeVoiceSession(id:input.sessionId),stopTransport=LostACK(),stopClient=HostClient(baseURL:url,transport:stopTransport)
        let stop=StopNativeVoice(expectedHostId:host,expectedBotId:bot,generation:input.generation,clientRequestId:"swift-stop",expectedRevision:current.revision)
        do { _ = try await stopClient.stopNativeVoice(sessionID:input.sessionId,input:stop); throw NSError(domain:"stop lost ACK missing",code:3) } catch HostClientError.mutationOutcomeUnknown {}
        let stopped=try await stopClient.nativeVoiceReceipt(threadID:thread,clientRequestID:stop.clientRequestId)
        try client.validateNativeVoiceStopReceipt(stopped,sessionID:input.sessionId,input:stop)
        try check(stopped.session.terminal && stopped.receipt.operation == "stop", "stop GET-only receipt")
        try check(await stopTransport.audit() == ["POST","GET"], "stop never replayed")
        do { _ = try await client.nativeVoiceExchange(sessionID:input.sessionId,expectedHostID:host,generation:input.generation); throw NSError(domain:"closed exchange available",code:4) } catch HostClientError.notFound {}
        let clear=PatchNativeVoicePreference(expectedHostId:host,expectedBotId:bot,expectedBotRevision:status.botRevision,expectedRevision:1,clientRequestId:"swift-clear",voice:nil)
        let cleared=try await client.patchNativeVoicePreferences(botID:bot,input:clear)
        try check(cleared.preference.voice == nil,"explicit nullable preference reset")
        let history=try await client.nativeVoiceHistory(threadID:thread,limit:1)
        try check(history.items.count == 1 && history.items[0].session.id == input.sessionId && history.items[0].durationMs >= 0,"real lifecycle history")
        let emptyPage=try await client.nativeVoiceHistory(threadID:thread,after:history.items[0].session.cursor,limit:1)
        try check(emptyPage.items.isEmpty,"positive history after")
        prefClient.close()
        print("NATIVE_VOICE_SDK_REAL_HTTP_PASS start/stop commit-then-lost-ACK GET-only, positive cursor query, ephemeral exchange, scope decoding")
        client.close();startClient.close();stopClient.close()
    }
}
