import Foundation
import CryptoKit

public enum DeviceRouteStatus: String, Codable, Sendable { case active, suspended, revoked }
public struct DeviceConversationRoute: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let botId: String
    public let deviceId: String
    public let tool: String
    public let fingerprint: String
    public let generation: Int
    public let pinRevision: Int
    public let schemaHash: String
    public let operationVersion: String
    public let revision: Int
    public let status: DeviceRouteStatus
    public let minimumGrantRevision: Int
    public let needsFreshGrant: Bool
    public var isValid: Bool {
        [id, botId, deviceId, tool].allSatisfy(routeID) && id.hasPrefix("dvr_") && tool.hasPrefix("mac.")
        && [generation, pinRevision, revision, minimumGrantRevision].allSatisfy { $0 > 0 && $0 <= 9_007_199_254_740_991 }
        && pinRevision >= generation && routeHash(fingerprint) && routeHash(schemaHash)
        && operationVersion.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil
    }
}
public struct DeviceRoutesPage: Decodable, Sendable {
    public let botId: String
    public let routes: [DeviceConversationRoute]
}
public struct DeviceRoutePatch: Codable, Equatable, Sendable {
    public let expectedHostId: String
    public let clientRequestId: String
    public let botId: String
    public let deviceId: String
    public let tool: String
    public let expectedRevision: Int?
    public let status: DeviceRouteStatus
    public init(expectedHostId: String, clientRequestId: String, botId: String, deviceId: String,
                tool: String, expectedRevision: Int?, status: DeviceRouteStatus) {
        self.expectedHostId = expectedHostId; self.clientRequestId = clientRequestId; self.botId = botId
        self.deviceId = deviceId; self.tool = tool; self.expectedRevision = expectedRevision; self.status = status
    }
    public var isValid: Bool {
        [expectedHostId, clientRequestId, botId, deviceId, tool].allSatisfy(routeID)
        && tool.range(of: "^mac\\.[a-z][a-z0-9_.]{1,100}$", options: .regularExpression) != nil
        && (expectedRevision.map { $0 > 0 && $0 < 9_007_199_254_740_991 } ?? true)
    }
    private enum Keys: String, CodingKey { case expectedHostId, clientRequestId, botId, deviceId, tool, expectedRevision, status }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(expectedHostId, forKey: .expectedHostId); try c.encode(clientRequestId, forKey: .clientRequestId)
        try c.encode(botId, forKey: .botId); try c.encode(deviceId, forKey: .deviceId); try c.encode(tool, forKey: .tool)
        try c.encode(status, forKey: .status)
        if let expectedRevision { try c.encode(expectedRevision, forKey: .expectedRevision) } else { try c.encodeNil(forKey: .expectedRevision) }
    }
}
public struct DeviceRouteReceipt: Codable, Equatable, Sendable {
    public let schema: String
    public let hostId: String
    public let ownerId: String
    public let clientRequestId: String
    public let requestHash: String
    public let request: DeviceRoutePatch
    public let route: DeviceConversationRoute
    public let committedAt: Int64
    public func matches(_ expected: DeviceRoutePatch, ownerID: String) -> Bool {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard expected.isValid, schema == "dexter.device-route-receipt/1", hostId == expected.expectedHostId,
              self.ownerId == ownerID, clientRequestId == expected.clientRequestId, request == expected,
              route.isValid, route.botId == expected.botId, route.deviceId == expected.deviceId,
              route.tool == expected.tool, route.status == expected.status,
              route.revision == (expected.expectedRevision ?? 0)+1, committedAt >= 0,
              let data = try? encoder.encode(expected) else { return false }
        return requestHash == SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
private func routeID(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil }
private func routeHash(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
private func routePath(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? "" }
extension HostClient {
    public func deviceRoutes(botID: String) async throws -> DeviceRoutesPage {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard routeID(botID) else { throw HostClientError.invalidRequest }
        let page: DeviceRoutesPage = try await request("/v1/device-routes", query: [URLQueryItem(name: "botId", value: botID)], localAttachmentRequest: true)
        guard page.botId == botID, page.routes.count <= 1024, Set(page.routes.map(\.id)).count == page.routes.count,
              page.routes.allSatisfy({ $0.botId == botID && $0.isValid }) else { throw HostClientError.contractMismatch }
        return page
    }
    public func patchDeviceRoute(_ input: DeviceRoutePatch, ownerID: String) async throws -> DeviceRouteReceipt {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard input.isValid, routeID(ownerID) else { throw HostClientError.invalidRequest }
        let receipt: DeviceRouteReceipt
        do { receipt = try await request("/v1/device-routes", method: "PATCH", body: input, timeout: 15, localAttachmentRequest: true) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
        guard receipt.matches(input, ownerID: ownerID) else { throw HostClientError.mutationOutcomeUnknown }; return receipt
    }
    /// Reads only the original immutable receipt; never resends the mutation.
    public func deviceRouteReceipt(requestID: String, expectedInput: DeviceRoutePatch, ownerID: String) async throws -> DeviceRouteReceipt {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard routeID(requestID), requestID == expectedInput.clientRequestId else { throw HostClientError.invalidRequest }
        let receipt: DeviceRouteReceipt = try await request("/v1/device-routes/receipts/\(routePath(requestID))", localAttachmentRequest: true)
        guard receipt.matches(expectedInput, ownerID: ownerID) else { throw HostClientError.contractMismatch }; return receipt
    }
}
