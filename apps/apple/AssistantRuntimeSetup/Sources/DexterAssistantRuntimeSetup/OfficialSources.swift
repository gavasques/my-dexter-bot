import Foundation
#if os(macOS)
import Darwin

public enum OfficialSourcePolicy {
    public static func allows(_ url: URL, provider: AssistantProvider) -> Bool {
        guard url.scheme == "https", url.user == nil, url.password == nil, url.port == nil,
              url.fragment == nil, url.query == nil, !url.path.contains(".."),
              !url.absoluteString.lowercased().contains("%2f"), !url.absoluteString.lowercased().contains("%2e") else { return false }
        switch provider {
        case .claude: return url.host == "downloads.claude.ai" && url.path.hasPrefix("/claude-code-releases/")
        case .codex: return url.host == "releases.openai.com" && url.path.hasPrefix("/codex/")
        }
    }
    public static func allowsRedirect(from original: URL, to redirected: URL, provider: AssistantProvider) -> Bool {
        allows(redirected, provider: provider) && original.host == redirected.host && original.path == redirected.path
    }
    public static func validate(_ artifact: OfficialArtifact) throws {
        guard validVersion(artifact.version), validDigest(artifact.sha256),
              ["arm64", "x86_64"].contains(artifact.architecture), allows(artifact.url, provider: artifact.provider),
              artifact.expectedBytes == nil || (artifact.expectedBytes! > 0 && artifact.expectedBytes! <= 1024 * 1024 * 1024) else { throw SetupError.unsafeSource }
        let target = artifact.architecture == "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
        let platform = artifact.architecture == "arm64" ? "darwin-arm64" : "darwin-x64"
        switch artifact.provider {
        case .claude:
            guard artifact.format == .executable, artifact.archiveEntry == nil,
                  artifact.url.path == "/claude-code-releases/\(artifact.version)/\(platform)/claude" else { throw SetupError.unsafeSource }
        case .codex:
            guard artifact.format == .singleExecutableTarGzip, artifact.archiveEntry == "codex-" + target,
                  artifact.url.path == "/codex/releases/\(artifact.version)/codex-\(target).tar.gz" else { throw SetupError.unsafeSource }
        }
    }
}

/// Ephemeral session, no cookies/auth/cache, exact official sources and bounded streaming to an exclusive file.
public struct OfficialURLSessionDownloader: ArtifactDownloading {
    public init() {}
    public func download(_ artifact: OfficialArtifact, to destination: URL, maximumBytes: Int64) async throws {
        try OfficialSourcePolicy.validate(artifact)
        try await fetch(artifact.url, provider: artifact.provider, destination: destination,
                        maximumBytes: maximumBytes, expectedBytes: artifact.expectedBytes, seconds: 180)
    }
    func fetch(_ url: URL, provider: AssistantProvider, destination: URL, maximumBytes: Int64,
               expectedBytes: Int64? = nil, seconds: TimeInterval = 25) async throws {
        guard OfficialSourcePolicy.allows(url, provider: provider) else { throw SetupError.unsafeSource }
        let delegate = DownloadDelegate(url: url, provider: provider, destination: destination, limit: maximumBytes, expected: expectedBytes)
        try await withTaskCancellationHandler {
            try await delegate.start(seconds: seconds)
        } onCancel: { delegate.cancel() }
    }
}
private final class DownloadDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let original: URL; private let provider: AssistantProvider; private let destination: URL
    private let limit: Int64; private let expected: Int64?
    private var continuation: CheckedContinuation<Void, any Error>?
    private var session: URLSession?; private var task: URLSessionDataTask?; private var fd: Int32 = -1
    private var directoryFD: Int32 = -1
    private var bytes: Int64 = 0; private var responseLength: Int64?; private var failure: SetupError?
    private var cancelled = false
    init(url: URL, provider: AssistantProvider, destination: URL, limit: Int64, expected: Int64?) {
        original = url; self.provider = provider; self.destination = destination; self.limit = limit; self.expected = expected
    }
    func start(seconds: TimeInterval) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            lock.lock(); defer { lock.unlock() }
            if cancelled { continuation.resume(throwing: SetupError.cancelled); return }
            let parent: Int32
            do { parent = try LocalSetupStore.openDirectory(destination.deletingLastPathComponent().path, create: false) }
            catch { continuation.resume(throwing: SetupError.unsafePath); return }
            fd = openat(parent, destination.lastPathComponent, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0 else { close(parent); continuation.resume(throwing: SetupError.unsafePath); return }
            directoryFD = parent
            self.continuation = continuation
            let config = URLSessionConfiguration.ephemeral
            config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCache = nil
            config.urlCredentialStorage = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
            config.timeoutIntervalForRequest = min(seconds, 20); config.timeoutIntervalForResource = seconds
            let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
            let session = URLSession(configuration: config, delegate: self, delegateQueue: queue); self.session = session
            var request = URLRequest(url: original); request.httpMethod = "GET"
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            let task = session.dataTask(with: request); self.task = task; task.resume()
        }
    }
    func cancel() { lock.lock(); cancelled = true; failure = .cancelled; task?.cancel(); lock.unlock() }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // TLS uses system trust. A release endpoint may not prompt for or read account credentials.
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, OfficialSourcePolicy.allowsRedirect(from: original, to: url, provider: provider) else {
            lock.lock(); failure = .redirectDenied; lock.unlock(); completionHandler(nil); task.cancel(); return
        }
        completionHandler(request)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock(); defer { lock.unlock() }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.url == original else { failure = .downloadFailed; completionHandler(.cancel); return }
        let length = response.expectedContentLength
        if length > limit { failure = .oversized; completionHandler(.cancel); return }
        if let expected, length >= 0 && length != expected { failure = .truncated; completionHandler(.cancel); return }
        responseLength = length >= 0 ? length : nil; completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock(); defer { lock.unlock() }
        guard failure == nil else { dataTask.cancel(); return }
        bytes += Int64(data.count)
        guard bytes <= limit else { failure = .oversized; dataTask.cancel(); return }
        let successful = data.withUnsafeBytes { buffer -> Bool in
            guard let base = buffer.baseAddress else { return true }
            var offset = 0
            while offset < data.count {
                let written = Darwin.write(fd, base.advanced(by: offset), data.count - offset)
                if written < 0 && errno == EINTR { continue }
                guard written > 0 else { return false }; offset += written
            }
            return true
        }
        if !successful { failure = .storageFailure; dataTask.cancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        lock.lock()
        var result = failure
        if result == nil && error != nil { result = (error as? URLError)?.code == .timedOut ? .timedOut : .downloadFailed }
        if result == nil && (bytes == 0 || (expected != nil && bytes != expected!) || (responseLength != nil && bytes != responseLength!)) { result = .truncated }
        if fd >= 0 {
            if fsync(fd) != 0 && result == nil { result = .storageFailure }
            if result != nil {
                var actual = stat(); var entry = stat()
                if fstat(fd, &actual) == 0 && fstatat(directoryFD, destination.lastPathComponent, &entry, AT_SYMLINK_NOFOLLOW) == 0,
                   actual.st_dev == entry.st_dev, actual.st_ino == entry.st_ino { _ = unlinkat(directoryFD, destination.lastPathComponent, 0) }
            }
            close(fd); fd = -1
        }
        if directoryFD >= 0 { close(directoryFD); directoryFD = -1 }
        let callback = continuation; continuation = nil; self.task = nil; self.session = nil
        lock.unlock(); session.finishTasksAndInvalidate()
        if let result { callback?.resume(throwing: result) }
        else { callback?.resume() }
    }
}
public struct OfficialReleaseResolver: OfficialArtifactResolving {
    public init() {}
    public func resolve(provider: AssistantProvider, architecture: String) async throws -> OfficialArtifact {
        guard ["arm64", "x86_64"].contains(architecture) else { throw SetupError.wrongArchitecture }
        let scratch = try scratchDirectory(); defer { try? FileManager.default.removeItem(at: scratch) }
        let downloader = OfficialURLSessionDownloader()
        switch provider {
        case .claude:
            let channel = scratch.appendingPathComponent("channel")
            try await downloader.fetch(URL(string: "https://downloads.claude.ai/claude-code-releases/latest")!, provider: .claude,
                                       destination: channel, maximumBytes: 1024)
            let version = try String(contentsOf: channel, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            guard validVersion(version) else { throw SetupError.unsafeSource }
            let manifestURL = URL(string: "https://downloads.claude.ai/claude-code-releases/\(version)/manifest.json")!
            let manifest = scratch.appendingPathComponent("manifest")
            try await downloader.fetch(manifestURL, provider: .claude, destination: manifest, maximumBytes: 1024 * 1024)
            let json = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any]
            let platforms = json?["platforms"] as? [String: Any]
            let platform = architecture == "arm64" ? "darwin-arm64" : "darwin-x64"
            guard json?["version"] as? String == version, let entry = platforms?[platform] as? [String: Any],
                  let hash = entry["checksum"] as? String, let size = entry["size"] as? Int64 else { throw SetupError.unsafeSource }
            let artifact = OfficialArtifact(provider: .claude, version: version, architecture: architecture,
                url: URL(string: "https://downloads.claude.ai/claude-code-releases/\(version)/\(platform)/claude")!, sha256: hash, expectedBytes: size)
            try OfficialSourcePolicy.validate(artifact); return artifact
        case .codex:
            let manifest = scratch.appendingPathComponent("release")
            try await downloader.fetch(URL(string: "https://releases.openai.com/codex/channels/latest")!, provider: .codex,
                                       destination: manifest, maximumBytes: 1024 * 1024)
            let json = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any]
            guard let tag = json?["tag_name"] as? String, tag.hasPrefix("rust-v"), let assets = json?["assets"] as? [[String: Any]] else { throw SetupError.unsafeSource }
            let version = String(tag.dropFirst(6)); let target = architecture == "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
            let name = "codex-\(target).tar.gz"
            let matches = assets.filter { $0["name"] as? String == name }
            guard matches.count == 1, let hash = matches[0]["digest"] as? String, hash.hasPrefix("sha256:") else { throw SetupError.unsafeSource }
            let url = URL(string: "https://releases.openai.com/codex/releases/\(version)/\(name)")!
            guard matches[0]["browser_download_url"] as? String == url.absoluteString else { throw SetupError.unsafeSource }
            let artifact = OfficialArtifact(provider: .codex, version: version, architecture: architecture, url: url,
                sha256: String(hash.dropFirst(7)), format: .singleExecutableTarGzip, archiveEntry: "codex-" + target)
            try OfficialSourcePolicy.validate(artifact); return artifact
        }
    }
}
#endif
