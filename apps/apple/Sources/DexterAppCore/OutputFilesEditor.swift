#if os(macOS)
import DexterHostClient
import Foundation
import Observation

/// Where a base's output folders live. A configured VPS base is ALWAYS the base, even while offline: the app never falls
/// back to this Mac silently (no double writing, no outputs split between bases).
public enum OutputFilesBase: Equatable, Sendable {
    /// The host child this app launched on this Mac (owner loopback). Its paths exist on this Mac's disk.
    case thisMac
    /// A remote base (VPS) reached through pairing. Its paths exist only on the remote disk.
    case remote(hostID: String)
    /// The one base whose outputs the owner sees: the configured VPS when there is one, otherwise this Mac.
    public static func resolve(configuredRemoteHostID: String?, localHostConfigured: Bool) -> OutputFilesBase? {
        if let configuredRemoteHostID { return .remote(hostID: configuredRemoteHostID) }
        return localHostConfigured ? .thisMac : nil
    }
}
/// How the owner can open a folder or file. A remote path string is never handed to Finder.
public enum OutputFilesAccess: Equatable, Sendable { case revealInFinder(URL), downloadOnly, unavailable }

/// Focused owner editor for output folders (no UI). Binds to one base and one host identity; destination changes keep
/// the same request id until their outcome is known; nothing is persisted locally.
@MainActor @Observable public final class OutputFilesEditor {
    public enum Notice: Equatable, Sendable {
        case loadFailed, baseOffline, remoteBrowsingUnavailable, hostChanged, conflict, invalidFolder, destinationUnknown, destinationSaved, exportFailed
    }
    public let base: OutputFilesBase
    public private(set) var status: OutputFilesStatus?
    public private(set) var locations: [OutputLocation] = []
    public private(set) var namespaces: [OutputNamespace] = []
    public private(set) var namespacesGeneration: Int?
    public private(set) var browsing: OutputEntries?
    public private(set) var busy = false
    public private(set) var notice: Notice?
    /// The owner's destination decision whose outcome is not known yet; every retry reuses it exactly.
    public private(set) var pendingDestination: SetOutputDestinationInput?
    public private(set) var lastReceipt: OutputDestinationReceipt?
    @ObservationIgnored private let client: HostClient
    @ObservationIgnored private var hostID: String?

    public init(base: OutputFilesBase, client: HostClient) {
        self.base = base; self.client = client
        if case .remote(let hostID) = base { self.hostID = hostID }
    }

    /// The client must belong to the chosen base: this Mac's loopback host, or a paired binding of that VPS installation.
    /// Anything else is refused before any request (never a fallback to another base).
    public var clientMatchesBase: Bool {
        switch (base, client.accessPolicy) {
        case (.thisMac, .loopbackDevelopment): true
        case (.remote(let hostID), .pairedHost(let binding)): binding.installationID == hostID
        default: false
        }
    }
    /// Owner-granted scopes of this client for output folders (paired: exact `outputs.read` / `outputs.manage`).
    public var canBrowse: Bool { clientMatchesBase && client.outputFilesReadiness.read }
    public var canManageDestination: Bool { clientMatchesBase && client.outputFilesReadiness.manage }
    public var canChooseDestination: Bool { status != nil && !busy && pendingDestination == nil && canManageDestination }

    private func record(_ error: Error) {
        switch error as? HostClientError {
        case .offline?, .notReady?: notice = .baseOffline
        case .forbidden?, .remotePairingUnavailable?: notice = base == .thisMac ? .loadFailed : .remoteBrowsingUnavailable
        default: notice = .loadFailed
        }
    }
    private func accept(_ status: OutputFilesStatus) -> Bool {
        if let hostID, hostID != status.hostId { notice = .hostChanged; return false }
        hostID = status.hostId; return true
    }

    /// Status, ledger and namespaces of the current generation from THIS base only.
    public func reload() async {
        guard !busy else { return }
        guard canBrowse else { notice = base == .thisMac ? .loadFailed : .remoteBrowsingUnavailable; return }
        busy = true; defer { busy = false }
        do {
            let status = try await client.outputFilesStatus()
            guard accept(status) else { return }
            let locations = try await client.outputLocations(), namespaces = try await client.outputNamespaces()
            guard locations.hostId == status.hostId, namespaces.hostId == status.hostId else { notice = .hostChanged; return }
            self.status = status; self.locations = locations.items; self.namespaces = namespaces.items; namespacesGeneration = namespaces.generation
            if notice == .loadFailed || notice == .baseOffline || notice == .remoteBrowsingUnavailable { notice = nil }
        } catch { record(error) }
    }
    /// Namespaces of an older generation (outputs written before a destination change stay reachable).
    public func loadNamespaces(generation: Int) async {
        guard !busy, let hostID else { return }
        busy = true; defer { busy = false }
        do {
            let value = try await client.outputNamespaces(generation: generation)
            guard value.hostId == hostID else { notice = .hostChanged; return }
            namespaces = value.items; namespacesGeneration = value.generation
        } catch { record(error) }
    }
    public func browse(namespace: OutputNamespaceRef, path: String = ".", generation: Int? = nil, after: String? = nil) async {
        guard !busy, let hostID else { return }
        busy = true; defer { busy = false }
        do {
            let value = try await client.outputEntries(generation: generation, namespace: namespace, path: path, after: after)
            guard value.hostId == hostID else { notice = .hostChanged; return }
            browsing = value
        } catch { record(error) }
    }

    /// Owner decision: NEW files go to `destination`; existing outputs never move. An unknown outcome is settled by
    /// reading the original receipt; a different choice is refused until then.
    public func chooseDestination(_ destination: OutputDestination) async {
        guard !busy, let status, canManageDestination else { return }
        if let pending = pendingDestination {
            await settlePending()
            if pendingDestination != nil, pending.destination != destination { notice = .destinationUnknown; return }
            if pendingDestination == nil { return }
        }
        let input = pendingDestination ?? SetOutputDestinationInput(status: status, destination: destination)
        pendingDestination = input
        busy = true
        do {
            let receipt = try await client.setOutputDestination(input)
            busy = false; await finish(receipt)
        } catch HostClientError.mutationOutcomeUnknown {
            busy = false; await settlePending()
        } catch HostClientError.conflict {
            busy = false; pendingDestination = nil; notice = .conflict; await reload()
        } catch HostClientError.invalidRequest {
            busy = false; pendingDestination = nil; notice = .invalidFolder
        } catch {
            busy = false; pendingDestination = nil; record(error)
        }
    }
    /// Reads the original receipt of the pending decision (same request id); never re-sends a different request.
    public func settlePending() async {
        guard let pending = pendingDestination, !busy else { return }
        busy = true
        let receipt = try? await client.outputDestinationReceipt(clientRequestID: pending.clientRequestId)
        busy = false
        if let receipt, receipt.requestHash == pending.requestHash, receipt.hostId == pending.expectedHostID { await finish(receipt) }
        else { notice = .destinationUnknown }
    }
    /// Retries the SAME pending request (host replays the original receipt if it was applied).
    public func retryPendingDestination() async {
        guard let pending = pendingDestination else { return }
        await chooseDestination(pending.destination)
    }
    private func finish(_ receipt: OutputDestinationReceipt) async {
        lastReceipt = receipt; pendingDestination = nil; notice = .destinationSaved
        await reload()
        if notice == .loadFailed || notice == .baseOffline { return }
        notice = .destinationSaved
    }

    /// Finder only for this Mac's own host and an available location; a remote base offers download only.
    public func access(location: OutputLocation, namespace: OutputNamespace? = nil, entryPath: String? = nil) -> OutputFilesAccess {
        guard location.availability == .available else { return .unavailable }
        guard base == .thisMac else { return .downloadOnly }
        var components: [String] = []
        if let namespace {
            if namespace.kind == .general, location.layout != .v1 { return .unavailable }
            components += namespace.relativePath.split(separator: "/").map(String.init)
        } else if location.layout != .v1 { return .unavailable }
        if let entryPath, entryPath != "." { components += entryPath.split(separator: "/", omittingEmptySubsequences: false).map(String.init) }
        guard location.path.hasPrefix("/"), components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") }) else { return .unavailable }
        return .revealInFinder(components.reduce(URL(fileURLWithPath: location.path, isDirectory: true)) { $0.appendingPathComponent($1) })
    }

    /// Real binary export (chunked, pinned, verified) into a NEW local file chosen by the owner.
    public func export(_ item: OutputItem, to destination: URL) async -> OutputFileExport? {
        guard !busy, let hostID, item.hostId == hostID else { return nil }
        busy = true; defer { busy = false }
        do { return try await client.exportOutputFile(item, to: destination) }
        catch { notice = .exportFailed; return nil }
    }
}
#endif
