@testable import DexterAppCore
import DexterHostClient
import DexterClientIdentity
import Foundation
import SwiftUI

/// In-process transport only: no listener, socket, real host, engine, credential or account.
/// Do not open Settings/profile/team editors: their private credential flows are outside this lab.
@main @MainActor struct NavigationSyntheticApp: App {
    @State private var model: DexterAppModel
    init() {
        // Owner-local views construct an independent HostClient. Intercept that URLSession
        // as well as the injected conversation transport; never contact a loopback listener.
        precondition(URLProtocol.registerClass(NavigationSyntheticURLProtocol.self))
        let pairing = PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(), identityStorage: { _ in NavigationUnavailableIdentity() })
        let voice = LiveVoiceController(keyStore: InMemoryLiveAPIKeyStore(),
            transportFactory: { _ in throw LiveVoiceFailure.connectionUnavailable }, audio: UnavailableLiveVoiceAudio())
        _model = State(initialValue: DexterAppModel(
            client: HostClient(baseURL: URL(string: "http://127.0.0.1:54914")!, transport: NavigationSyntheticTransport()),
            storage: NavigationSyntheticStorage(), pairing: pairing, liveVoiceController: voice))
    }
    var body: some Scene {
        WindowGroup("Dexter · Navegação D12–D14 · Sintético") {
            DexterRootView().environment(model).environment(\.locale, Locale(identifier: "pt_BR"))
        }
        // Match the product scene; do not impose an artificial minimum on resize evidence.
        .windowResizability(.contentSize)
    }
}
private final class NavigationSyntheticURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.scheme == "http" && request.url?.host == "127.0.0.1" && request.url?.port == 54914
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { client?.urlProtocol(self, didFailWithError: HostClientError.forbidden); return }
        let status = url.path == "/v1/automations/status" && request.httpMethod == "GET" ? 200 : 403
        let body: [String: Any] = status == 200
            ? ["hostId": "qa-navigation-host", "configured": false, "running": false, "admission": "disabled", "inFlight": 0, "lastOutcome": "none", "completedTicks": 0, "accepted": 0, "replayed": 0, "deferred": 0]
            : ["error": "forbidden"]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]),
              let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
private struct NavigationUnavailableIdentity: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.unavailable }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.unavailable }
}
@MainActor private final class NavigationSyntheticStorage: DexterAppStateStorage {
    private var bytes: Data?
    func readData() -> Data? { bytes }
    func writeData(_ data: Data) { bytes = data }
    func removeData() { bytes = nil }
}
private actor NavigationSyntheticTransport: HTTPTransport {
    func send(_ request: URLRequest) async throws -> TransportResponse {
        guard let url = request.url, url.scheme == "http", url.host == "127.0.0.1", url.port == 54914 else { throw HostClientError.forbidden }
        let path = url.path, method = request.httpMethod ?? "GET"
        let body: [String: Any]
        let bots = [("qa-c", "Coordenação", "Coordenador"), ("qa-m", "Analista", "Revisão de preços"), ("qa-x", "Designer", "Imagens"), ("qa-s", "Solo", "Bot independente")]
        let teamIDs = ["qa-a", "qa-b"]
        let teams = teamIDs.enumerated().map { i, id in
            ["id": id, "ownerId": "qa-owner", "name": i == 0 ? "Comércio" : "Pesquisa", "roleDescription": "Time sintético", "coordinatorBotId": "qa-c", "botIds": i == 0 ? ["qa-m", "qa-c", "qa-x"] : ["qa-c", "qa-m"], "rules": "", "memory": "", "revision": 0, "createdAt": 1, "updatedAt": 1] as [String: Any]
        }
        let botIDs = bots.map { $0.0 }
        let threadIDs = botIDs.map { "qa-private-\($0)" } + teamIDs.map { "qa-team-\($0)" }
        if method == "GET", path == "/health" {
            body = ["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": "qa-navigation-host", "state": [:]]
        } else if method == "GET", path == "/v1/bots" {
            body = ["items": bots.map { ["id": $0.0, "name": $0.1, "roleDescription": $0.2, "profileId": "qa-profile", "engine": "claude", "ownerId": "qa-owner", "createdAt": 1] as [String: Any] }]
        } else if method == "GET", path == "/v1/teams" {
            body = ["items": teams]
        } else if method == "GET", let index = teamIDs.firstIndex(where: { path == "/v1/teams/\($0)" }) {
            body = teams[index]
        } else if method == "GET", let id = botIDs.first(where: { path == "/v1/bots/\($0)/threads" }) {
            body = ["items": [["id": "qa-private-\(id)", "botId": id, "createdAt": 1]]]
        } else if method == "GET", let id = teamIDs.first(where: { path == "/v1/teams/\($0)/threads" }) {
            body = ["items": [["id": "qa-team-\(id)", "botId": "qa-c", "teamId": id, "createdAt": 1]]]
        } else if method == "GET", let id = threadIDs.first(where: { path == "/v1/threads/\($0)" }) {
            if id.hasPrefix("qa-team-") { body = ["id": id, "botId": "qa-c", "teamId": String(id.dropFirst(8)), "createdAt": 1] }
            else { body = ["id": id, "botId": String(id.dropFirst(11)), "createdAt": 1] }
        } else if method == "GET", let id = threadIDs.first(where: { path == "/v1/threads/\($0)/messages" }) {
            body = ["items": [["cursor": 1, "id": "qa-message-\(id)", "threadId": id, "clientMessageId": "qa-input-\(id)", "role": "assistant", "content": "Conversa sintética: \(id)", "createdAt": 1]], "nextCursor": 1]
        } else if method == "GET", path == "/v1/events" {
            body = ["items": botIDs.enumerated().map { i, id in ["id": "qa-event-\(id)", "cursor": i + 1, "kind": "thread.created", "botId": id, "entityId": "qa-private-\(id)", "createdAt": 1] as [String: Any] }, "nextCursor": botIDs.count]
        } else if method == "GET", threadIDs.contains(where: { path == "/v1/threads/\($0)/turns" }) {
            body = ["items": [], "nextCursor": 0]
        } else if method == "GET", path == "/v1/actions" || path == "/v1/devices" { body = ["items": []] }
        else if method == "GET", path == "/v1/automations/status" {
            body = ["hostId": "qa-navigation-host", "configured": false, "running": false, "admission": "disabled", "inFlight": 0, "lastOutcome": "none", "completedTicks": 0, "accepted": 0, "replayed": 0, "deferred": 0]
        } else if method == "POST", path == "/v1/automations/list" || path == "/v1/automations/history" {
            body = ["items": [], "nextCursor": NSNull()]
        } else if method == "POST", path == "/v1/automations/calendar" {
            let input = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any] ?? [:]
            body = ["items": [], "truncated": false, "from": input["from"] ?? 1, "to": input["to"] ?? 2]
        } else { throw HostClientError.forbidden }
        return TransportResponse(statusCode: 200, data: try JSONSerialization.data(withJSONObject: body))
    }
}
