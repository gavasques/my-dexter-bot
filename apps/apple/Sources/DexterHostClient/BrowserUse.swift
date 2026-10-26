import Foundation

/// Public cloud-browser policy only. Keys, cookies and live session handles never belong here.
public struct BrowserUseBotPolicy: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var allowedDomains: [String]
    public var maxSteps: Int
    public var timeoutSeconds: Int
    public var profileId: String?
    public init(enabled: Bool = false, allowedDomains: [String] = [], maxSteps: Int = 20,
                timeoutSeconds: Int = 120, profileId: String? = nil) {
        self.enabled = enabled; self.allowedDomains = allowedDomains; self.maxSteps = maxSteps
        self.timeoutSeconds = timeoutSeconds; self.profileId = profileId
    }
    private enum CodingKeys: String, CodingKey { case enabled, allowedDomains, maxSteps, timeoutSeconds, profileId }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(enabled, forKey: .enabled); try container.encode(allowedDomains, forKey: .allowedDomains)
        try container.encode(maxSteps, forKey: .maxSteps); try container.encode(timeoutSeconds, forKey: .timeoutSeconds)
        // The canonical host contract requires explicit null for a fresh browser.
        try container.encode(profileId, forKey: .profileId)
    }
    public var isValid: Bool {
        (1...100).contains(maxSteps) && (30...240).contains(timeoutSeconds) && allowedDomains.count <= 32 &&
        (!enabled || !allowedDomains.isEmpty) && Set(allowedDomains).count == allowedDomains.count &&
        allowedDomains.allSatisfy(browserUseDomainIsValid) &&
        (profileId.map(browserUseUUIDIsValid) ?? true)
    }
}

public struct BrowserUseConfiguration: Codable, Equatable, Sendable {
    public let hostID: String
    public let version: Int
    public let revision: Int
    public let enabled: Bool
    public let bots: [String: BrowserUseBotPolicy]
    public init(hostID: String, version: Int = 1, revision: Int, enabled: Bool, bots: [String: BrowserUseBotPolicy]) {
        self.hostID = hostID; self.version = version; self.revision = revision; self.enabled = enabled; self.bots = bots
    }
    public var isValid: Bool {
        guard browserUseHostIDIsValid(hostID), version == 1, revision >= 0, revision <= 9_007_199_254_740_991,
              bots.count <= 500, bots.keys.allSatisfy({ $0.range(of: "^bot_[A-Za-z0-9_-]{1,124}$", options: .regularExpression) != nil }), bots.values.allSatisfy(\.isValid) else { return false }
        let profiles = bots.values.filter(\.enabled).compactMap(\.profileId)
        return Set(profiles).count == profiles.count && (try? JSONEncoder().encode(bots).count).map { $0 <= 262_144 } == true
    }
}

public struct BrowserUseCredentialStatus: Codable, Equatable, Sendable {
    public let unlocked: Bool
    public let expiresAt: Double?
}
public struct BrowserUseRuntimeStatus: Codable, Equatable, Sendable {
    public let hostID: String
    public let available: Bool
    public let activeTasks: Int
    public let cleanupPending: Bool
    public let credential: BrowserUseCredentialStatus
    public let authentication: String
    public let apiVersion: String
    var isValid: Bool {
        browserUseHostIDIsValid(hostID) && (0...500).contains(activeTasks) && authentication == "unverified" && apiVersion == "v2" &&
        (credential.expiresAt.map { $0.isFinite && $0 >= 0 } ?? true) &&
        (credential.unlocked == (credential.expiresAt != nil))
    }
}

private struct BrowserUseConfigurationPatch: Encodable, Sendable {
    let expectedHostID: String
    let expectedRevision: Int
    let enabled: Bool
    let bots: [String: BrowserUseBotPolicy]
}

extension HostClient {
    public func browserUseConfiguration() async throws -> BrowserUseConfiguration {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let value: BrowserUseConfiguration = try await request("/v1/browser-use/config", timeout: 15, localAttachmentRequest: true)
        guard value.isValid else { throw HostClientError.contractMismatch }; return value
    }
    public func browserUseStatus() async throws -> BrowserUseRuntimeStatus {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let value: BrowserUseRuntimeStatus = try await request("/v1/browser-use/status", timeout: 15, localAttachmentRequest: true)
        guard value.isValid else { throw HostClientError.contractMismatch }; return value
    }
    public func updateBrowserUseConfiguration(hostID: String, expectedRevision: Int, enabled: Bool,
                                               bots: [String: BrowserUseBotPolicy]) async throws -> BrowserUseConfiguration {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let proposed = BrowserUseConfiguration(hostID: hostID, revision: expectedRevision, enabled: enabled, bots: bots)
        guard proposed.isValid, expectedRevision < 9_007_199_254_740_991 else { throw HostClientError.invalidRequest }
        let value: BrowserUseConfiguration
        do {
            value = try await request("/v1/browser-use/config", method: "PATCH",
                body: BrowserUseConfigurationPatch(expectedHostID: hostID, expectedRevision: expectedRevision, enabled: enabled, bots: bots),
                timeout: 15, localAttachmentRequest: true)
        } catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
        guard value.isValid, value.hostID == hostID, value.revision == expectedRevision + 1,
              value.enabled == enabled, value.bots == bots else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
}

private func browserUseHostIDIsValid(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128 && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
}
private func browserUseUUIDIsValid(_ value: String) -> Bool {
    UUID(uuidString: value)?.uuidString.lowercased() == value
}
private func browserUseDomainIsValid(_ value: String) -> Bool {
    guard value == value.lowercased(), (3...253).contains(value.utf8.count),
          !value.contains(":"), !value.contains("/"), !value.contains("*"), value.contains(".") else { return false }
    let suffix = String(value.split(separator: ".").last ?? "")
    guard !["localhost", "local", "lan", "internal", "intranet", "invalid", "test", "onion", "home", "arpa"].contains(suffix),
          value.utf8.contains(where: { (97...122).contains($0) }) else { return false }
    return value.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
        !label.isEmpty && label.utf8.count <= 63 && label.first != "-" && label.last != "-" &&
        label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
    }
}
