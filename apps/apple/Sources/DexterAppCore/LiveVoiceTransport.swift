import Foundation

@MainActor public protocol LiveVoiceTransport: AnyObject {
    func send(_ data: Data) async throws
    func receive() async throws -> Data
    func cancel()
}

public typealias LiveVoiceTransportFactory = @MainActor (_ apiKey: String) throws -> any LiveVoiceTransport

/// Ephemeral direct trusted-Mac connection. Authorization is never exposed by the controller.
@MainActor public final class OpenAILiveWebSocketTransport: LiveVoiceTransport {
    private let delegate: LiveWebSocketPolicy
    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    public init(apiKey: String) throws {
        guard !apiKey.isEmpty, apiKey.utf8.count <= 512,
              apiKey.unicodeScalars.allSatisfy({ (33...126).contains($0.value) }),
              let endpoint = URL(string: "wss://api.openai.com/v1/live/sessions") else {
            throw LiveVoiceFailure.invalidConfiguration
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil; configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil; configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20; configuration.timeoutIntervalForResource = 60 * 60
        delegate = LiveWebSocketPolicy()
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        var request = URLRequest(url: endpoint)
        request.setValue("Bearer " + apiKey, forHTTPHeaderField: "Authorization")
        socket = session.webSocketTask(with: request)
        socket.maximumMessageSize = 1_048_576
        socket.resume()
    }
    public func send(_ data: Data) async throws {
        guard data.count <= 1_048_576, let string = String(data: data, encoding: .utf8) else {
            throw LiveVoiceFailure.invalidConfiguration
        }
        do { try await socket.send(.string(string)) }
        catch { throw LiveVoiceFailure.connectionUnavailable }
    }
    public func receive() async throws -> Data {
        do {
            switch try await socket.receive() {
            case .string(let string): return Data(string.utf8)
            case .data(let data): return data
            @unknown default: throw LiveVoiceFailure.protocolRejected
            }
        } catch { throw LiveVoiceFailure.connectionUnavailable }
    }
    public func cancel() { socket.cancel(with: .normalClosure, reason: nil); session.invalidateAndCancel() }
}

/// Redirects are refused even when their destination would otherwise appear legitimate.
private final class LiveWebSocketPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.host == "api.openai.com",
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.performDefaultHandling, nil)
    }
}
