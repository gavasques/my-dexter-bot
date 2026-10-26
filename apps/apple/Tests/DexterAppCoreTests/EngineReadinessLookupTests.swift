import Foundation
import XCTest
import DexterHostClient
@testable import DexterAppCore

/// All positive data here is synthetic. Real installed metadata is never reconstructed from a summary.
@MainActor
final class EngineReadinessLookupTests: XCTestCase {
    private func model(_ transport: CatalogTransport) -> DexterAppModel {
        DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:4317")!, transport: transport), storage: CatalogMemoryStorage())
    }
    private func health(_ id: String = "synthetic-host-a") -> Data {
        Data("""
        {"protocolVersion":1,"mode":"local-development","hostId":"\(id)","remotePairing":"not_implemented","engineRouting":"connected","state":{},"runtime":{"state":"running","engines":["claude","codex","grok"]}}
        """.utf8)
    }
    private func catalog(installed: Bool = true, available: Bool = true) -> Data {
        Data("""
        {"items":[{"id":"codex","available":\(available),"installed":\(installed),"adapterSupported":true,"version":"0.141.0","defaultModel":"gpt-5.4","models":[{"id":"gpt-5.4","label":"GPT-5.4","reasoningEfforts":["low","medium","high"],"speeds":[]}],"reasoningEfforts":["low","medium","high"],"speeds":[],"providerID":"openai","catalogSource":"native_model_list"},{"id":"grok","available":false,"installed":true,"adapterSupported":false,"models":[],"defaultModel":null,"reasoningEfforts":[],"speeds":[]}]}
        """.utf8)
    }
    private func enqueue(_ transport: CatalogTransport, id: String = "synthetic-host-a", result: Data? = nil) async {
        await transport.push("/health", health(id))
        await transport.push("/v1/engines/catalog", result ?? catalog())
    }

    func testActualSDKDecodesSyntheticSelectedCLIContractWithoutVoiceOrLoginClaim() async throws {
        let transport = CatalogTransport()
        await transport.push("/v1/engines/catalog", catalog())
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:4317")!, transport: transport)
        let entries = try await client.engineCatalog()
        let codex = try XCTUnwrap(entries.first { $0.id == "codex" })
        XCTAssertEqual(codex.version, "0.141.0")
        XCTAssertEqual(codex.defaultModel, "gpt-5.4")
        XCTAssertEqual(codex.models.first?.reasoningEfforts, ["low", "medium", "high"])
        XCTAssertEqual(EngineReadiness(entry: codex), .availableLoginUnconfirmed)
        XCTAssertEqual(EngineReadiness(entry: entries.last), .foundUnsupported)
        let requests = await transport.requests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.timeoutInterval, 15)
        XCTAssertEqual(requests.first?.cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertEqual(requests.first?.httpMethod, "GET")
        XCTAssertNil(requests.first?.url?.query)
    }

    func testFailedHealthOrCatalogIsUnknownAndRetryActuallyRequeriesBoth() async throws {
        let transport = CatalogTransport(); let model = model(transport)
        XCTAssertEqual(model.engineReadiness(for: .codex), .notReported)
        await transport.fail("/health", .timedOut)
        await model.refreshEngineCatalog()
        XCTAssertEqual(model.engineCatalogLookup, .failed(.offline))
        XCTAssertNotNil(model.engineCatalogNotice)
        XCTAssertEqual(model.engineReadiness(for: .codex), .notReported)
        await enqueue(transport, result: Data("{invalid".utf8))
        await model.refreshEngineCatalog()
        XCTAssertEqual(model.engineCatalogLookup, .failed(.contractMismatch))
        XCTAssertEqual(model.engineReadiness(for: .codex), .notReported)
        await enqueue(transport)
        await model.refreshEngineCatalog()
        XCTAssertEqual(model.engineCatalogLookup, .loaded)
        XCTAssertNil(model.engineCatalogNotice)
        XCTAssertEqual(model.engineReadiness(for: .codex), .availableLoginUnconfirmed)
        XCTAssertEqual(model.engineReadiness(for: .grok), .foundUnsupported)
        XCTAssertEqual(model.engineReadiness(for: .antigravity), .notReported)
        let paths = await transport.paths()
        XCTAssertEqual(paths, ["/health", "/health", "/v1/engines/catalog", "/health", "/v1/engines/catalog"])
    }

    func testLoadingAndCancellationNeverBecomeAbsentOrStayLoading() async throws {
        let transport = CatalogTransport(); let model = model(transport)
        await transport.push("/health", health())
        await transport.holdCatalog()
        let lookup = Task { await model.refreshEngineCatalog() }
        await transport.waitUntilHeld()
        XCTAssertEqual(model.engineCatalogLookup, .loading)
        XCTAssertEqual(model.engineReadiness(for: .codex), .checking)
        lookup.cancel()
        await transport.releaseCatalog(catalog(installed: false, available: false))
        await lookup.value
        XCTAssertEqual(model.engineCatalogLookup, .notLoaded)
        XCTAssertEqual(model.engineReadiness(for: .codex), .notReported)
        await transport.fail("/health", .cancelled)
        await model.refreshEngineCatalog()
        XCTAssertEqual(model.engineCatalogLookup, .notLoaded)
    }

    func testLateOldCatalogDoesNotOverwriteLatestLookupOrChangedAuthority() async throws {
        for newHost in ["synthetic-host-a", "synthetic-host-b"] {
            let transport = CatalogTransport(); let model = model(transport)
            await transport.push("/health", health())
            await transport.holdCatalog()
            let old = Task { await model.refreshEngineCatalog() }
            await transport.waitUntilHeld()
            await enqueue(transport, id: newHost)
            await model.refreshEngineCatalog()
            await transport.releaseCatalog(catalog(installed: false, available: false))
            await old.value
            XCTAssertEqual(model.engineCatalogLookup, .loaded)
            XCTAssertEqual(model.engineReadiness(for: .codex), .availableLoginUnconfirmed)
            let metadataOnly = await awaitPathsAreMetadataOnly(transport); XCTAssertTrue(metadataOnly)
        }
    }

    func testHostSwitchDropsFactsAndCannotImportLateAbsentResult() async throws {
        let transport = CatalogTransport(); let model = model(transport)
        let oldCoordinator = model.groupCoordinator
        await transport.push("/health", health()); await transport.holdCatalog()
        let old = Task { await model.refreshEngineCatalog() }
        await transport.waitUntilHeld()
        model.hostAddress = "https://example.invalid"; model.configureHost()
        XCTAssertEqual(model.engineCatalogLookup, .notLoaded)
        XCTAssertFalse(oldCoordinator === model.groupCoordinator, "preserve Groups current-host factory guard")
        await transport.releaseCatalog(catalog(installed: false, available: false))
        await old.value
        XCTAssertEqual(model.engineReadiness(for: .codex), .notReported)
        XCTAssertEqual(model.engineCatalog, [])
        let metadataOnly = await awaitPathsAreMetadataOnly(transport); XCTAssertTrue(metadataOnly)
    }

    func testOnboardingRetryRefreshesCatalogEvenIfProjectionListsFail() async throws {
        let transport = CatalogTransport(); let model = model(transport)
        await enqueue(transport)
        await model.refresh() // synthetic bots/actions reads fail; catalog is still a separate valid observation.
        XCTAssertFalse(model.isOnline)
        XCTAssertNotNil(model.errorMessage)
        XCTAssertEqual(model.engineCatalogLookup, .loaded)
        XCTAssertEqual(model.engineReadiness(for: .codex), .availableLoginUnconfirmed)
        let paths = await transport.paths()
        XCTAssertEqual(Array(paths.prefix(2)), ["/health", "/v1/engines/catalog"])
        XCTAssertFalse(paths.contains { $0.contains("thread") || $0.contains("login") || $0.contains("native-voice") })
    }

    func testFreshCatalogSupersedesOlderUnavailableTurnButNotNewerTurnOrAuthentication() throws {
        let entries = try JSONDecoder().decode(EngineCatalog.self, from: catalog()).items
        let identity = OnboardingHostIdentity(hostID: "synthetic-host-a", mode: .localDevelopment, clientDeviceID: nil)
        func readiness(_ observedAt: Int64, authentication: OnboardingEngineAuthentication = .unknown) -> OnboardingReadiness {
            OnboardingReadiness(.init(host: .online(identity), routing: .connected(routedEngines: [.codex]), selectedEngine: .codex,
                engines: [.codex: .init(authentication: authentication, unavailable: true, observedAt: observedAt)],
                catalog: .init(entries: entries, observedAt: 100)))
        }
        XCTAssertFalse(readiness(1).steps.contains(.engineUnavailable(.codex)))
        XCTAssertTrue(readiness(1).steps.contains(.engineLoginUnknown(.codex)))
        XCTAssertTrue(readiness(101).steps.contains(.engineUnavailable(.codex)))
        XCTAssertTrue(readiness(1, authentication: .required).steps.contains(.engineLoginRequired(.codex)))
        XCTAssertEqual(readiness(1).conversation, .unconfirmed)
        let noEntry = OnboardingReadiness(.init(host: .online(identity), routing: .connected(routedEngines: [.codex]), selectedEngine: .codex,
            engines: [.codex: .init(unavailable: true, observedAt: 1)], catalog: .init(entries: [], observedAt: 100)))
        XCTAssertFalse(noEntry.steps.contains(.engineUnavailable(.codex)), "empty catalog is unknown, not absence")
    }

    func testOnlyExplicitCatalogMissingCanShowNotFoundAndFailureClearsItsCertainty() async throws {
        let transport = CatalogTransport(); let model = model(transport)
        await enqueue(transport, result: catalog(installed: false, available: false))
        await model.refreshEngineCatalog()
        XCTAssertEqual(model.engineReadiness(for: .codex), .notFound)
        await transport.fail("/health", .cannotConnectToHost)
        await model.refreshEngineCatalog()
        XCTAssertEqual(model.engineReadiness(for: .codex), .notReported)
        XCTAssertFalse(model.engineReadiness(for: .codex).canRun)
        let metadataOnly = await awaitPathsAreMetadataOnly(transport); XCTAssertTrue(metadataOnly)
    }

    private func awaitPathsAreMetadataOnly(_ transport: CatalogTransport) async -> Bool {
        let requests = await transport.requests()
        return requests.allSatisfy { $0.httpMethod == "GET" && ["/health", "/v1/engines/catalog"].contains($0.url?.path ?? "") }
    }
}

@MainActor
private final class CatalogMemoryStorage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }
    func writeData(_ data: Data) { self.data = data }
    func removeData() { data = nil }
}

private actor CatalogTransport: HTTPTransport {
    private enum Outcome { case data(Data), error(URLError.Code), hold }
    private var queue: [String: [Outcome]] = [:]
    private var log: [URLRequest] = []
    private var held: CheckedContinuation<TransportResponse, any Error>?
    private var heldWaiter: CheckedContinuation<Void, Never>?
    func push(_ path: String, _ data: Data) { queue[path, default: []].append(.data(data)) }
    func fail(_ path: String, _ code: URLError.Code) { queue[path, default: []].append(.error(code)) }
    func holdCatalog() { queue["/v1/engines/catalog", default: []].append(.hold) }
    func requests() -> [URLRequest] { log }
    func paths() -> [String] { log.compactMap { $0.url?.path } }
    func waitUntilHeld() async {
        if held != nil { return }
        await withCheckedContinuation { heldWaiter = $0 }
    }
    func releaseCatalog(_ data: Data) { held?.resume(returning: .init(statusCode: 200, data: data)); held = nil }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        log.append(request)
        let path = request.url?.path ?? ""
        guard var items = queue[path], !items.isEmpty else { throw URLError(.cannotConnectToHost) }
        let outcome = items.removeFirst(); queue[path] = items
        switch outcome {
        case .data(let data): return .init(statusCode: 200, data: data)
        case .error(let code): throw URLError(code)
        case .hold:
            return try await withCheckedThrowingContinuation { held = $0; heldWaiter?.resume(); heldWaiter = nil }
        }
    }
}
