import Foundation

enum DeviceRequestValidation {
    static func check(body:Data,timeoutSeconds:Double) throws {
        guard body.count <= 65_536, timeoutSeconds.isFinite, (0.001...120).contains(timeoutSeconds),
              let value = try? JSONSerialization.jsonObject(with:body), value is [String:Any] else { throw IdentityFailure.invalidInput }
    }
}

/// Fully validates the request before the supplied lifecycle can access identity storage.
/// No networking, DNS resolution or Keychain work occurs during preparation.
public struct PreparedDeviceRequest: Sendable {
    public let route: DeviceRoute
    public let body: Data
    public let host: PinnedHost
    public let timeoutSeconds: Double
    public let expectedClientFingerprint: String
    public init(route:String?,bodyBase64:String?,hostURL:String?,hostCertificateDER:String?,hostFingerprint:String?,timeoutSeconds:Double?,expectedClientFingerprint:String?) throws {
        guard let expectedClientFingerprint,
              expectedClientFingerprint.utf8.count == 64,
              expectedClientFingerprint.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw IdentityFailure.invalidInput }
        guard let route = route.flatMap(DeviceRoute.init(rawValue:)),
              let body = bodyBase64.flatMap({Data(base64Encoded:$0)}),
              let url = hostURL.flatMap(URL.init(string:)),
              let der = hostCertificateDER.flatMap({Data(base64Encoded:$0)}), let fingerprint = hostFingerprint else { throw IdentityFailure.invalidInput }
        let timeout = timeoutSeconds ?? 30
        try DeviceRequestValidation.check(body:body,timeoutSeconds:timeout)
        self.route = route; self.body = body; self.host = try PinnedHost(url:url,certificateDER:der,fingerprint:fingerprint); self.timeoutSeconds = timeout
        self.expectedClientFingerprint = expectedClientFingerprint
    }
    /// Shared CLI/library entry: preparation always precedes any lifecycle/storage access.
    public static func execute(lifecycle:IdentityLifecycle,route:String?,bodyBase64:String?,hostURL:String?,hostCertificateDER:String?,hostFingerprint:String?,timeoutSeconds:Double?,expectedClientFingerprint:String?) async throws -> Data {
        let request = try PreparedDeviceRequest(route:route,bodyBase64:bodyBase64,hostURL:hostURL,
            hostCertificateDER:hostCertificateDER,hostFingerprint:hostFingerprint,timeoutSeconds:timeoutSeconds,expectedClientFingerprint:expectedClientFingerprint)
        return try await request.perform(lifecycle:lifecycle)
    }
    public func perform(lifecycle:IdentityLifecycle) async throws -> Data {
        if Task.isCancelled { throw IdentityFailure.cancelled }
        let identity = try await lifecycle.loadOnly()
        guard identity.fingerprint == expectedClientFingerprint else { throw IdentityFailure.conflict }
        return try await NativeDeviceTransport(identity:identity,host:host).post(route:route,body:body,timeoutSeconds:timeoutSeconds)
    }
}
