import Foundation
import Observation
import DexterHostClient

/// Retained by the owner model across sheet reopen. No engine can obtain this administrative client.
@MainActor @Observable public final class DeviceConversationRoutesSession {
    public let hostID: String
    public let ownerID: String
    public private(set) var routes: [DeviceConversationRoute] = []
    public private(set) var botID: String?
    public private(set) var isBusy = false
    public private(set) var error: HostClientError?
    public private(set) var pending: DeviceRoutePatch?
    public private(set) var lastReceipt: DeviceRouteReceipt?
    @ObservationIgnored private let client: HostClient
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    @ObservationIgnored private var sequence: UInt64 = 0
    public var canMutate: Bool { isCurrent() && !isBusy && pending == nil }
    public var isAvailable: Bool { isCurrent() }
    public init(hostID: String, ownerID: String, client: HostClient, isCurrent: @escaping @MainActor () -> Bool) {
        self.hostID = hostID; self.ownerID = ownerID; self.client = client; self.isCurrent = isCurrent
    }
    public func route(deviceID: String, tool: String) -> DeviceConversationRoute? {
        routes.first { $0.deviceId == deviceID && $0.tool == tool }
    }
    public func load(botID: String) async {
        guard isCurrent(), !isBusy else { return }
        sequence &+= 1; let read = sequence
        if self.botID != botID { routes = []; lastReceipt = nil }
        self.botID = botID; isBusy = true; error = nil
        defer { if sequence == read { isBusy = false } }
        do {
            let page = try await client.deviceRoutes(botID: botID)
            guard isCurrent(), !Task.isCancelled, sequence == read, self.botID == botID else { return }
            routes = page.routes
        } catch {
            guard isCurrent(), sequence == read else { return }
            self.error = (error as? HostClientError) ?? .offline
        }
    }
    /// A deliberate owner click records one exact request before transport entry. Never auto-retries.
    public func set(deviceID: String, tool: String, status: DeviceRouteStatus) async {
        guard canMutate, let botID else { return }
        let current = route(deviceID: deviceID, tool: tool)
        guard current?.status != .revoked, status == .active || current != nil else { error = .forbidden; return }
        let request = DeviceRoutePatch(expectedHostId: hostID, clientRequestId: UUID().uuidString.lowercased(),
            botId: botID, deviceId: deviceID, tool: tool, expectedRevision: current?.revision, status: status)
        pending = request; isBusy = true; error = nil; sequence &+= 1
        do {
            let receipt = try await client.patchDeviceRoute(request, ownerID: ownerID)
            guard isCurrent(), pending == request else { return }
            lastReceipt = receipt; pending = nil
            isBusy = false; await load(botID: botID)
        } catch {
            guard isCurrent(), pending == request else { isBusy = false; return }
            let failure = (error as? HostClientError) ?? .mutationOutcomeUnknown
            switch failure {
            case .invalidConfiguration, .remotePairingUnavailable, .invalidRequest, .forbidden, .notFound, .notReady, .conflict, .approvalExpired:
                pending = nil; isBusy = false; await load(botID: botID); self.error = failure
            default:
                self.error = .mutationOutcomeUnknown
            }
        }
        isBusy = false
    }
    /// Resolves lost ACK through GET of the saved request. A list/revision alone cannot prove this request.
    public func check() async {
        guard isCurrent(), !isBusy else { return }
        guard let request = pending else { if let botID { await load(botID: botID) }; return }
        isBusy = true; error = nil
        do {
            let receipt = try await client.deviceRouteReceipt(requestID: request.clientRequestId, expectedInput: request, ownerID: ownerID)
            guard isCurrent(), pending == request else { isBusy = false; return }
            lastReceipt = receipt; pending = nil; isBusy = false; await load(botID: request.botId)
        } catch {
            guard isCurrent() else { isBusy = false; return }
            self.error = .mutationOutcomeUnknown
        }
        isBusy = false
    }
}
