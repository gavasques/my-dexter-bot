import CryptoKit
import DexterClientIdentity
import Foundation

// Output folders of one base: general folder (owner inventory), `Bots/<id>` and `Times/<id>` namespaces. Mirrors
// `packages/contracts/src/output-files.ts` (version 1). Owner loopback, or a paired base with the exact owner-granted scope
// (never the relay); bot/team names are display, never identity.

public enum OutputLocationKind: String, Codable, Sendable {
    /// Implicit generation 1: the host data directory (`bot-files/<botId>`, `team-files/<teamId>`), no general listing.
    case hostDataLegacy = "host_data_legacy"
    case hostDataDefault = "host_data_default"
    case ownerPath = "owner_path"
}
public enum OutputLayout: String, Codable, Sendable { case v1, legacy }
public enum OutputLocationAvailability: String, Codable, Sendable {
    case available, notCreated = "not_created", missing, replaced, unsafe, unreadable
}
public struct OutputLocationNamespaces: Codable, Equatable, Sendable { public let general: Bool, bots: Bool, teams: Bool }
public struct OutputLocation: Codable, Equatable, Sendable, Identifiable {
    public let generation: Int
    public let kind: OutputLocationKind
    public let layout: OutputLayout
    /// Absolute path on the HOST's disk. Only meaningful to Finder when the host runs on this Mac.
    public let path: String
    public let current: Bool
    public let availability: OutputLocationAvailability
    public let namespaces: OutputLocationNamespaces
    public let createdAt: Int64?
    public let retiredAt: Int64?
    public var id: Int { generation }
    var isValid: Bool {
        (1...256).contains(generation) && outputHostPathIsValid(path) && namespaces.bots && namespaces.teams
            && (layout == .v1) == namespaces.general && (kind == .hostDataLegacy) == (layout == .legacy)
            && current == (retiredAt == nil)
    }
}
/// Who may browse the base's outputs (closed: an unknown value fails decoding). It states the host's composed policy, not
/// that this client is paired or holds a scope; readiness still comes from the binding scopes (`outputFilesReadiness`).
public enum OutputRemoteBrowsing: String, Codable, Sendable {
    /// No paired channel composed; also every host before the value evolved.
    case ownerLoopbackOnly = "owner_loopback_only"
    /// Also paired app clients over the direct mTLS channel, each request gated by the exact `outputs.read`/`outputs.manage`.
    case ownerLoopbackAndPairedScoped = "owner_loopback_and_paired_scoped"
}
/// The encrypted relay never carries output routes. Absent (nil) on older hosts.
public enum OutputRelayedBrowsing: String, Codable, Sendable { case notRelayed = "not_relayed" }
public struct OutputFilesScope: Codable, Equatable, Sendable {
    public let botFileTools: String, teamFileTools: String, groupTurns: String, terminalCwd: String, engineNativeWorkspace: String
    public let contextDocuments: String, sharing: String
    public let remoteBrowsing: OutputRemoteBrowsing
    public let relayedBrowsing: OutputRelayedBrowsing?
}
public struct OutputFilesLimits: Codable, Equatable, Sendable {
    public let pageEntries: Int, scannedEntries: Int, chunkBytes: Int, exportBytes: Int64, hashedBytes: Int64, toolFileBytes: Int
    /// Paired-channel chunk cap (256 KiB) when the host composes paired browsing, null otherwise; absent on older hosts.
    public let pairedChunkBytes: Int?
}
public struct OutputFilesHost: Codable, Equatable, Sendable { public let platform: String }
public struct OutputFilesStatus: Codable, Equatable, Sendable {
    public let version: Int, hostId: String, revision: Int
    /// false until the first destination change or namespace creation persisted the ledger.
    public let persisted: Bool
    public let current: OutputLocation
    public let host: OutputFilesHost
    public let scope: OutputFilesScope
    public let limits: OutputFilesLimits
    var isValid: Bool {
        version == 1 && outputHostIDIsValid(hostId) && revision >= 1 && current.isValid && current.current
            && (1...8 * 1024 * 1024).contains(limits.chunkBytes) && (1...200).contains(limits.pageEntries)
            && scope.groupTurns == "no_file_tools" && scope.sharing == "not_implemented"
            && limits.pairedChunkBytes.map({ (1...outputPairedChunkBytes).contains($0) }) ?? true
            && (scope.remoteBrowsing == .ownerLoopbackAndPairedScoped) == (limits.pairedChunkBytes != nil)
    }
}
public struct OutputLocations: Codable, Equatable, Sendable {
    public let version: Int, hostId: String, revision: Int
    public let items: [OutputLocation]
    var isValid: Bool {
        version == 1 && outputHostIDIsValid(hostId) && (1...256).contains(items.count) && items.allSatisfy(\.isValid)
            && items.filter(\.current).count == 1 && Set(items.map(\.generation)).count == items.count
    }
}

/// `general` | `bot:<id>` | `team:<id>` (stable ids only).
public enum OutputNamespaceRef: Hashable, Sendable, Codable {
    case general, bot(String), team(String)
    public init?(rawValue: String) {
        if rawValue == "general" { self = .general; return }
        guard let colon = rawValue.firstIndex(of: ":") else { return nil }
        let kind = rawValue[..<colon], id = String(rawValue[rawValue.index(after: colon)...])
        guard outputNamespaceIDIsValid(id) else { return nil }
        switch kind { case "bot": self = .bot(id); case "team": self = .team(id); default: return nil }
    }
    public var rawValue: String {
        switch self { case .general: "general"; case .bot(let id): "bot:\(id)"; case .team(let id): "team:\(id)" }
    }
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let value = OutputNamespaceRef(rawValue: raw) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "namespace"))
        }
        self = value
    }
    public func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(rawValue) }
}
public struct OutputNamespace: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable { case general, bot, team }
    /// `orphan`: its bot/team no longer exists; the folder stays listed so older outputs never vanish.
    public enum Status: String, Codable, Sendable { case active, orphan }
    public let ref: OutputNamespaceRef
    public let kind: Kind
    public let id: String?
    /// Current bot/team name for display only.
    public let label: String?
    public let status: Status
    public let exists: Bool
    public let relativePath: String
    public var identifier: String { ref.rawValue }
}
public struct OutputNamespaces: Codable, Equatable, Sendable {
    public let version: Int, hostId: String, generation: Int
    public let items: [OutputNamespace]
    public let truncated: Bool
}
public struct OutputEntry: Codable, Equatable, Sendable, Identifiable {
    /// `blocked`: link, hardlink or special file, listed by name only and never opened.
    public enum EntryType: String, Codable, Sendable { case file, directory, blocked }
    public let name: String, path: String
    public let type: EntryType
    public let bytes: Int64?
    public let modifiedAt: Int64?
    public let mediaType: String?
    public var id: String { path }
}
public struct OutputEntriesHidden: Codable, Equatable, Sendable { public let secretLike: Int, `internal`: Int }
public struct OutputEntries: Codable, Equatable, Sendable {
    public let version: Int, hostId: String, generation: Int
    public let namespace: OutputNamespaceRef
    public let path: String
    public let exists: Bool
    public let items: [OutputEntry]
    public let nextCursor: String?
    public let hidden: OutputEntriesHidden
    public let truncated: Bool
}
public struct OutputItem: Codable, Equatable, Sendable {
    public let version: Int, hostId: String, generation: Int
    public let namespace: OutputNamespaceRef
    public let path: String, name: String
    public let bytes: Int64, modifiedAt: Int64
    public let mediaType: String
    /// Identity pin; every exported chunk is bound to it.
    public let pin: String
    public let sha256: String?
    public let exportable: Bool
    var isValid: Bool {
        version == 1 && outputHostIDIsValid(hostId) && outputHashIsValid(pin) && (sha256.map(outputHashIsValid) ?? true) && bytes >= 0
            && outputRelativePathIsValid(path) && path != "." && !name.isEmpty && path.hasSuffix(name)
    }
}

public enum OutputDestination: Equatable, Sendable, Encodable {
    case hostDataDefault
    /// A real folder on the HOST's disk (validated by the host: no links, same user, not shared-writable).
    case ownerPath(String)
    private enum CodingKeys: String, CodingKey { case kind, path }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .hostDataDefault: try container.encode("host_data_default", forKey: .kind)
        case .ownerPath(let path): try container.encode("owner_path", forKey: .kind); try container.encode(path, forKey: .path)
        }
    }
    var canonical: [String: Any] {
        switch self { case .hostDataDefault: ["kind": "host_data_default"]; case .ownerPath(let path): ["kind": "owner_path", "path": path] }
    }
    var isValid: Bool { if case .ownerPath(let path) = self { return outputHostPathIsValid(path) }; return true }
}
public struct SetOutputDestinationInput: Encodable, Equatable, Sendable {
    public let expectedHostID: String, clientRequestId: String
    public let expectedRevision: Int
    public let destination: OutputDestination
    /// Keep the same `clientRequestId` for every retry of one owner decision (lost ACK, restart): the host replays it.
    public init(status: OutputFilesStatus, destination: OutputDestination, clientRequestId: String = UUID().uuidString.lowercased()) {
        expectedHostID = status.hostId; expectedRevision = status.revision; self.destination = destination; self.clientRequestId = clientRequestId
    }
    var isValid: Bool {
        outputHostIDIsValid(expectedHostID) && outputRequestIDIsValid(clientRequestId) && expectedRevision >= 1 && destination.isValid
    }
    /// Same canonical form as the host (sorted keys, unescaped slashes): binds the receipt to this exact request.
    public var requestHash: String? {
        outputCanonicalHash(["expectedHostID": expectedHostID, "clientRequestId": clientRequestId, "expectedRevision": expectedRevision,
                             "destination": destination.canonical])
    }
}
public struct OutputDestinationReceipt: Codable, Equatable, Sendable {
    public struct Destination: Codable, Equatable, Sendable { public let kind: OutputLocationKind; public let path: String }
    public let version: Int, hostId: String, clientRequestId: String, requestHash: String
    public let previousRevision: Int, revision: Int, previousGeneration: Int, generation: Int
    public let destination: Destination
    /// Always false: existing outputs stay where they are.
    public let existingFilesMoved: Bool
    public let createdAt: Int64
    func matches(_ input: SetOutputDestinationInput) -> Bool {
        version == 1 && hostId == input.expectedHostID && clientRequestId == input.clientRequestId && requestHash == input.requestHash
            && previousRevision == input.expectedRevision && revision == previousRevision + 1 && generation > previousGeneration
            && existingFilesMoved == false && destination.kind != .hostDataLegacy && outputHostPathIsValid(destination.path)
            && { if case .ownerPath(let path) = input.destination { return destination.kind == .ownerPath && destination.path == path }; return destination.kind == .hostDataDefault }()
    }
}
public struct OutputFileExport: Equatable, Sendable { public let url: URL; public let bytes: Int64; public let sha256: String; public let mediaType: String }
public enum OutputExportFailure: Error, Equatable, Sendable { case destinationExists, notExportable, changedDuringExport, integrityMismatch, localWriteFailed }

public extension HostClient {
    func outputFilesStatus() async throws -> OutputFilesStatus {
        try requireOutputFilesOwner(.outputsRead)
        let value: OutputFilesStatus = try await request("/v1/output-files/status", timeout: 15, cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
        guard value.isValid else { throw HostClientError.contractMismatch }; return value
    }
    func outputLocations() async throws -> OutputLocations {
        try requireOutputFilesOwner(.outputsRead)
        let value: OutputLocations = try await request("/v1/output-files/locations", timeout: 15, cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
        guard value.isValid else { throw HostClientError.contractMismatch }; return value
    }
    func outputNamespaces(generation: Int? = nil) async throws -> OutputNamespaces {
        try requireOutputFilesOwner(.outputsRead)
        let query = generation.map { [URLQueryItem(name: "generation", value: String($0))] } ?? []
        let value: OutputNamespaces = try await request("/v1/output-files/namespaces", query: query, timeout: 15,
                                                         cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
        guard value.version == 1, generation.map({ $0 == value.generation }) ?? true, value.items.count <= 1001,
              Set(value.items.map(\.ref)).count == value.items.count else { throw HostClientError.contractMismatch }
        return value
    }
    func outputEntries(generation: Int? = nil, namespace: OutputNamespaceRef, path: String = ".", after: String? = nil, limit: Int = 100) async throws -> OutputEntries {
        try requireOutputFilesOwner(.outputsRead)
        guard outputRelativePathIsValid(path), (1...200).contains(limit), after.map({ !$0.isEmpty && !$0.contains("/") && $0.utf16.count <= 255 }) ?? true else {
            throw HostClientError.invalidRequest
        }
        var query = [URLQueryItem(name: "namespace", value: namespace.rawValue), URLQueryItem(name: "path", value: path), URLQueryItem(name: "limit", value: String(limit))]
        if let generation { query.append(URLQueryItem(name: "generation", value: String(generation))) }
        if let after { query.append(URLQueryItem(name: "after", value: after)) }
        let value: OutputEntries = try await request("/v1/output-files/entries", query: query, timeout: 30, cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
        guard value.version == 1, value.namespace == namespace, value.path == path, value.items.count <= limit,
              value.items.allSatisfy({ outputRelativePathIsValid($0.path) }) else { throw HostClientError.contractMismatch }
        return value
    }
    func outputItem(generation: Int? = nil, namespace: OutputNamespaceRef, path: String) async throws -> OutputItem {
        try requireOutputFilesOwner(.outputsRead)
        guard outputRelativePathIsValid(path), path != "." else { throw HostClientError.invalidRequest }
        var query = [URLQueryItem(name: "namespace", value: namespace.rawValue), URLQueryItem(name: "path", value: path)]
        if let generation { query.append(URLQueryItem(name: "generation", value: String(generation))) }
        let value: OutputItem = try await request("/v1/output-files/item", query: query, timeout: 120, cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
        guard value.isValid, value.namespace == namespace, value.path == path, generation.map({ $0 == value.generation }) ?? true else { throw HostClientError.contractMismatch }
        return value
    }
    /**
     Downloads one output file in bounded chunks bound to `item.pin` into a NEW local file (create-only: an existing
     `destination` is never replaced). Size and SHA-256 are verified before the file appears; any failure removes the
     partial file. Bytes never pass through messages, events, logs or caches.
     */
    func exportOutputFile(_ item: OutputItem, to destination: URL, progress: (@Sendable (Int64, Int64) -> Void)? = nil) async throws -> OutputFileExport {
        try requireOutputFilesOwner(.outputsRead)
        // A paired base answers at most 256 KiB per response; the owner loopback takes 8 MiB chunks.
        let chunkBytes: Int
        if case .pairedHost = accessPolicy { chunkBytes = outputPairedChunkBytes } else { chunkBytes = 8 * 1024 * 1024 }
        guard item.isValid, item.exportable, destination.isFileURL else { throw OutputExportFailure.notExportable }
        let manager = FileManager.default
        guard !manager.fileExists(atPath: destination.path) else { throw OutputExportFailure.destinationExists }
        let partial = destination.deletingLastPathComponent().appendingPathComponent(".dexter-export-\(UUID().uuidString).partial")
        guard manager.createFile(atPath: partial.path, contents: nil, attributes: [.posixPermissions: 0o600]),
              let handle = try? FileHandle(forWritingTo: partial) else { throw OutputExportFailure.localWriteFailed }
        var completed = false
        defer { try? handle.close(); if !completed { try? manager.removeItem(at: partial) } }
        var hasher = SHA256(), offset: Int64 = 0
        while offset < item.bytes {
            let query = [URLQueryItem(name: "generation", value: String(item.generation)), URLQueryItem(name: "namespace", value: item.namespace.rawValue),
                         URLQueryItem(name: "path", value: item.path), URLQueryItem(name: "pin", value: item.pin), URLQueryItem(name: "offset", value: String(offset)),
                         URLQueryItem(name: "length", value: String(chunkBytes))]
            let chunk: Data
            do { chunk = try await requestBytes("/v1/output-files/content", query: query) }
            catch HostClientError.conflict { throw OutputExportFailure.changedDuringExport }
            guard !chunk.isEmpty, Int64(chunk.count) <= item.bytes - offset else { throw OutputExportFailure.integrityMismatch }
            do { try handle.write(contentsOf: chunk) } catch { throw OutputExportFailure.localWriteFailed }
            hasher.update(data: chunk); offset += Int64(chunk.count); progress?(offset, item.bytes)
        }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard offset == item.bytes, item.sha256.map({ $0 == digest }) ?? true else { throw OutputExportFailure.integrityMismatch }
        do { try handle.synchronize(); try handle.close() } catch { throw OutputExportFailure.localWriteFailed }
        // Create-only publication: link fails if the destination appeared meanwhile; then the partial is removed.
        guard link(partial.path, destination.path) == 0 else { throw OutputExportFailure.destinationExists }
        try? manager.removeItem(at: partial)
        completed = true
        return OutputFileExport(url: destination, bytes: offset, sha256: digest, mediaType: item.mediaType)
    }
    /// Owner decision: new files go to `destination`; existing outputs never move. Unknown outcome → read the receipt.
    func setOutputDestination(_ input: SetOutputDestinationInput) async throws -> OutputDestinationReceipt {
        try requireOutputFilesOwner(.outputsManage)
        guard input.isValid else { throw HostClientError.invalidRequest }
        let value: OutputDestinationReceipt
        do { value = try await request("/v1/output-files/destination", method: "PUT", body: input, timeout: 45, localAttachmentRequest: true) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
        guard value.matches(input) else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
    /// Original receipt of a destination change. Nil means unconfirmed, never "did not happen".
    func outputDestinationReceipt(clientRequestID: String) async throws -> OutputDestinationReceipt? {
        try requireOutputFilesOwner(.outputsManage)
        guard outputRequestIDIsValid(clientRequestID) else { throw HostClientError.invalidRequest }
        do {
            let value: OutputDestinationReceipt = try await request("/v1/output-files/receipts/\(clientRequestID)", timeout: 15,
                                                                     cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
            guard value.version == 1, value.clientRequestId == clientRequestID, outputHashIsValid(value.requestHash) else { throw HostClientError.contractMismatch }
            return value
        } catch HostClientError.notFound { return nil }
    }
    /// Owner loopback, or a paired base whose approved binding carries the EXACT scope (checked before any byte is sent;
    /// the host gate checks it again). An unpaired/foreign base is refused; there is never a fallback to another base.
    var outputFilesReadiness: (read: Bool, manage: Bool) {
        switch accessPolicy {
        case .loopbackDevelopment: (true, true)
        case .pairedHost(let binding): (binding.scopes.contains(.outputsRead), binding.scopes.contains(.outputsManage))
        case .unpairedHost: (false, false)
        }
    }
    private func requireOutputFilesOwner(_ scope: ClientScope) throws {
        let ready = outputFilesReadiness
        guard scope == .outputsManage ? ready.manage : ready.read else { throw HostClientError.forbidden }
    }
}

/// `OUTPUT_FILES_LIMITS.pairedChunkBytes`: the paired listener's response cap.
let outputPairedChunkBytes = 262_144
func outputHostIDIsValid(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128 && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
}
func outputRequestIDIsValid(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil }
func outputHashIsValid(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
func outputNamespaceIDIsValid(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil }
func outputTextIsValid(_ value: String, max: Int) -> Bool {
    !value.isEmpty && value.utf16.count <= max && !value.unicodeScalars.contains { $0.value < 0x20 || (0x7f...0x9f).contains($0.value) }
}
func outputHostPathIsValid(_ value: String) -> Bool { outputTextIsValid(value, max: 1024) && value.hasPrefix("/") && !value.contains("\\") }
func outputRelativePathIsValid(_ value: String) -> Bool {
    guard outputTextIsValid(value, max: 1024), !value.contains("\\") else { return false }
    if value == "." { return true }
    return !value.hasPrefix("/") && value.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
}
private func outputCanonicalHash(_ value: [String: Any]) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) else { return nil }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
