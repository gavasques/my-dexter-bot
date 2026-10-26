import Foundation
import CryptoKit

public enum AssistantProvider: String, Codable, Sendable, CaseIterable { case claude, codex }
public enum RuntimeState: String, Codable, Sendable { case compatible, needsUpdate, missing, failed, unknown, unavailable }
public enum SetupAction: String, Codable, Sendable { case reuse, download }
public enum SetupReceiptState: String, Codable, Sendable { case preparing, committed, failed, cancelled, unknown }
/// Observable work only. Progress is not an acknowledgement and is never persisted as a receipt.
public enum RuntimeSetupStep: String, Sendable, Equatable {
    case inspecting, resolvingRelease, reusing, downloading, verifying, committing, reconciling
}
public typealias RuntimeSetupProgress = @Sendable (RuntimeSetupStep) async -> Void
public enum SetupError: String, Error, Codable, Sendable {
    case unavailable, invalidCapture, scopeChanged, requestConflict, planChanged, noCompatibleCandidate
    case unsafePath, unsafeSource, redirectDenied, downloadFailed, truncated, oversized, checksumMismatch
    case wrongArchitecture, signatureRejected, notarizationRejected, versionMismatch, incompatible
    case unsafeArchive, timedOut, cancelled, busy, storageFailure, commitUnknown, artifactChanged
}
public struct SetupCapture: Codable, Sendable, Equatable {
    public let hostID: String
    public let bundleID: String
    public let selectionGeneration: String
    public let windowID: String
    public let requestID: String
    public init(hostID: String, bundleID: String, selectionGeneration: String, windowID: String, requestID: String) {
        self.hostID = hostID; self.bundleID = bundleID; self.selectionGeneration = selectionGeneration
        self.windowID = windowID; self.requestID = requestID
    }
    func validate() throws {
        guard [hostID, bundleID, selectionGeneration, windowID, requestID].allSatisfy({
            !$0.isEmpty && $0.utf8.count <= 256 && !$0.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
        }) else { throw SetupError.invalidCapture }
    }
}
public struct RuntimeRequirements: Codable, Sendable, Equatable {
    public let nativeVoice: Bool
    public init(nativeVoice: Bool = false) { self.nativeVoice = nativeVoice }
}
public struct RuntimeCapabilities: Codable, Sendable, Equatable {
    public let text: Bool
    public let nativeVoice: Bool
    public let voices: [String]
    public init(text: Bool, nativeVoice: Bool = false, voices: [String] = []) {
        self.text = text; self.nativeVoice = nativeVoice; self.voices = voices
    }
    public static let unknown = RuntimeCapabilities(text: false)
    func satisfies(_ requirements: RuntimeRequirements) -> Bool { text && (!requirements.nativeVoice || nativeVoice) }
}
public struct RuntimeCandidate: Codable, Sendable, Equatable {
    public let command: String
    public let resolvedCommand: String?
    public let sha256: String?
    public let version: String?
    public let state: RuntimeState
    public let capabilities: RuntimeCapabilities
    public let error: SetupError?
    public var authentication: String { "unknown" }
    public init(command: String, resolvedCommand: String? = nil, sha256: String? = nil, version: String? = nil,
                state: RuntimeState, capabilities: RuntimeCapabilities = .unknown, error: SetupError? = nil) {
        self.command = command; self.resolvedCommand = resolvedCommand; self.sha256 = sha256; self.version = version
        self.state = state; self.capabilities = capabilities; self.error = error
    }
}
public struct RuntimeInspection: Codable, Sendable, Equatable {
    public let provider: AssistantProvider
    public let selectedCommand: String?
    public let candidates: [RuntimeCandidate]
    public let state: RuntimeState
}
public enum ArtifactFormat: String, Codable, Sendable { case executable, singleExecutableTarGzip }
public struct OfficialArtifact: Codable, Sendable, Equatable {
    public let provider: AssistantProvider
    public let version: String
    public let architecture: String
    public let url: URL
    public let sha256: String
    public let expectedBytes: Int64?
    public let format: ArtifactFormat
    public let archiveEntry: String?
    public init(provider: AssistantProvider, version: String, architecture: String, url: URL, sha256: String,
                expectedBytes: Int64? = nil, format: ArtifactFormat = .executable, archiveEntry: String? = nil) {
        self.provider = provider; self.version = version; self.architecture = architecture; self.url = url
        self.sha256 = sha256; self.expectedBytes = expectedBytes; self.format = format; self.archiveEntry = archiveEntry
    }
}
public struct SetupPlan: Codable, Sendable, Equatable {
    public let capture: SetupCapture
    public let provider: AssistantProvider
    public let action: SetupAction
    public let requirements: RuntimeRequirements
    public let reuseCandidate: RuntimeCandidate?
    public let artifact: OfficialArtifact?
    public let requestHash: String
    init(capture: SetupCapture, provider: AssistantProvider, requirements: RuntimeRequirements,
         reuseCandidate: RuntimeCandidate?, artifact: OfficialArtifact?) throws {
        self.capture = capture; self.provider = provider; self.requirements = requirements
        self.reuseCandidate = reuseCandidate; self.artifact = artifact
        self.action = reuseCandidate == nil ? .download : .reuse
        self.requestHash = try Self.hash(capture, provider, requirements, reuseCandidate, artifact)
    }
    func validate() throws {
        try capture.validate()
        guard requestHash == (try Self.hash(capture, provider, requirements, reuseCandidate, artifact)),
              (action == .reuse && reuseCandidate != nil && artifact == nil) ||
                (action == .download && artifact != nil && reuseCandidate == nil) else { throw SetupError.planChanged }
    }
    private static func hash(_ capture: SetupCapture, _ provider: AssistantProvider, _ requirements: RuntimeRequirements,
                             _ reuse: RuntimeCandidate?, _ artifact: OfficialArtifact?) throws -> String {
        struct Input: Encodable { let capture: SetupCapture; let provider: AssistantProvider; let requirements: RuntimeRequirements
            let reuse: RuntimeCandidate?; let artifact: OfficialArtifact? }
        return try digestJSON(Input(capture: capture, provider: provider, requirements: requirements, reuse: reuse, artifact: artifact))
    }
}
public struct RuntimeSetupResult: Codable, Sendable, Equatable {
    public let command: String
    public let version: String
    public let sha256: String
    public let capabilities: RuntimeCapabilities
    public var authentication: String { "unknown" }
    public init(command: String, version: String, sha256: String, capabilities: RuntimeCapabilities) {
        self.command = command; self.version = version; self.sha256 = sha256; self.capabilities = capabilities
    }
}
public struct SetupReceipt: Codable, Sendable, Equatable {
    public let requestID: String
    public let requestHash: String
    public let state: SetupReceiptState
    public let result: RuntimeSetupResult?
    public let error: SetupError?
    public init(requestID: String, requestHash: String, state: SetupReceiptState, result: RuntimeSetupResult? = nil, error: SetupError? = nil) {
        self.requestID = requestID; self.requestHash = requestHash; self.state = state; self.result = result; self.error = error
    }
}
public struct SetupConfiguration: Sendable {
    public let managedRoot: URL
    public let architecture: String
    public let candidateLimit: Int
    public let maximumDownloadBytes: Int64
    public init(managedRoot: URL, architecture: String = SetupConfiguration.nativeArchitecture,
                candidateLimit: Int = 12, maximumDownloadBytes: Int64 = 768 * 1024 * 1024) {
        self.managedRoot = managedRoot; self.architecture = architecture
        self.candidateLimit = min(max(candidateLimit, 1), 24)
        self.maximumDownloadBytes = min(max(maximumDownloadBytes, 1), 1024 * 1024 * 1024)
    }
    public static var nativeArchitecture: String {
        #if arch(arm64)
        "arm64"
        #else
        "x86_64"
        #endif
    }
    public static var userDefault: SetupConfiguration {
        #if os(macOS)
        SetupConfiguration(managedRoot: FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Dexter/AssistantRuntimes", isDirectory: true))
        #else
        // A type-only default. production/install always throw unavailable on iOS and never create this path.
        SetupConfiguration(managedRoot: FileManager.default.temporaryDirectory.appendingPathComponent("dexter-assistant-unavailable"))
        #endif
    }
}
public protocol RuntimeMetadataInspecting: Sendable {
    func inspect(command: String, provider: AssistantProvider, requirements: RuntimeRequirements) async -> RuntimeCandidate
}
public protocol OfficialArtifactResolving: Sendable {
    func resolve(provider: AssistantProvider, architecture: String) async throws -> OfficialArtifact
}
public protocol ArtifactDownloading: Sendable {
    func download(_ artifact: OfficialArtifact, to destination: URL, maximumBytes: Int64) async throws
}
public protocol ArtifactValidating: Sendable {
    func materializeAndValidate(_ artifact: OfficialArtifact, downloaded: URL, stage: URL,
                                requirements: RuntimeRequirements) async throws -> RuntimeSetupResult
}
func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func digestJSON<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return digest(try encoder.encode(value))
}
func validVersion(_ value: String) -> Bool {
    value.range(of: #"^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[a-z0-9.]{1,32})?$"#, options: .regularExpression) != nil
}
func validDigest(_ value: String) -> Bool { value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }
