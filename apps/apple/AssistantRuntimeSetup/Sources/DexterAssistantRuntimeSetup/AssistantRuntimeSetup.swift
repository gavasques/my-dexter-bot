import Foundation
#if os(macOS)
import Darwin
#endif

/// Human setup service. This actor grants no bot authority and never writes preferences, auth or shell profiles.
public actor AssistantRuntimeSetup {
    private let configuration: SetupConfiguration
    private let inspector: any RuntimeMetadataInspecting
    private let resolver: any OfficialArtifactResolving
    private let downloader: any ArtifactDownloading
    private let validator: any ArtifactValidating
    private let candidates: [AssistantProvider: [String]]
    private var active: [String: Task<SetupReceipt, any Error>] = [:]
    // A synthetic fault boundary used by tests; production is nil.
    private let afterCommit: (@Sendable () throws -> Void)?
    public init(configuration: SetupConfiguration, inspector: any RuntimeMetadataInspecting,
                resolver: any OfficialArtifactResolving, downloader: any ArtifactDownloading,
                validator: any ArtifactValidating, candidates: [AssistantProvider: [String]] = [:]) {
        self.configuration = configuration; self.inspector = inspector; self.resolver = resolver
        self.downloader = downloader; self.validator = validator; self.candidates = candidates; self.afterCommit = nil
    }
    init(configuration: SetupConfiguration, inspector: any RuntimeMetadataInspecting,
         resolver: any OfficialArtifactResolving, downloader: any ArtifactDownloading,
         validator: any ArtifactValidating, candidates: [AssistantProvider: [String]] = [:], afterCommit: @escaping @Sendable () throws -> Void) {
        self.configuration = configuration; self.inspector = inspector; self.resolver = resolver
        self.downloader = downloader; self.validator = validator; self.candidates = candidates; self.afterCommit = afterCommit
    }
    public static func production(configuration: SetupConfiguration = .userDefault) throws -> AssistantRuntimeSetup {
        #if os(macOS)
        guard ["arm64", "x86_64"].contains(configuration.architecture), configuration.managedRoot.isFileURL else { throw SetupError.unsafePath }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return AssistantRuntimeSetup(configuration: configuration, inspector: LocalRuntimeMetadataInspector(),
            resolver: OfficialReleaseResolver(), downloader: OfficialURLSessionDownloader(), validator: OfficialMacArtifactValidator(),
            candidates: [.claude: [home + "/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
                         .codex: [home + "/.local/bin/codex",
                                  home + "/.codex/packages/standalone/current/bin/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]])
        #else
        throw SetupError.unavailable
        #endif
    }
    public func inspect(provider: AssistantProvider, selectedCommand: String? = nil,
                        requirements: RuntimeRequirements = .init()) async -> RuntimeInspection {
        await inspect(provider: provider, selectedCommand: selectedCommand, requirements: requirements, firstCompatibleOnly: false)
    }
    private func inspect(provider: AssistantProvider, selectedCommand: String?, requirements: RuntimeRequirements,
                         firstCompatibleOnly: Bool) async -> RuntimeInspection {
        #if os(macOS)
        var paths = ([selectedCommand].compactMap { $0 } + (candidates[provider] ?? []))
        paths += managedCandidates(provider: provider)
        var seen = Set<String>(); paths = paths.filter { seen.insert($0).inserted }
        var found: [RuntimeCandidate] = []
        for command in paths.prefix(configuration.candidateLimit) {
            if Task.isCancelled { break }
            found.append(await inspector.inspect(command: command, provider: provider, requirements: requirements))
            // Preparation needs one exact candidate. Do not execute other installed CLIs after finding it.
            if firstCompatibleOnly && found.last?.state == .compatible { break }
        }
        let state: RuntimeState = found.contains { $0.state == .compatible } ? .compatible :
            found.contains { $0.state == .needsUpdate } ? .needsUpdate :
            found.contains { $0.state == .unknown } ? .unknown :
            found.contains { $0.state == .failed } ? .failed : .missing
        return RuntimeInspection(provider: provider, selectedCommand: selectedCommand, candidates: found, state: state)
        #else
        return RuntimeInspection(provider: provider, selectedCommand: selectedCommand, candidates: [], state: .unavailable)
        #endif
    }
    public func prepare(capture: SetupCapture, provider: AssistantProvider, preferredCommand: String? = nil,
                        requirements: RuntimeRequirements = .init(),
                        progress: RuntimeSetupProgress = { _ in }) async throws -> SetupPlan {
        #if os(macOS)
        try capture.validate(); try Task.checkCancellation()
        await progress(.inspecting)
        let status = await inspect(provider: provider, selectedCommand: preferredCommand, requirements: requirements, firstCompatibleOnly: true)
        try Task.checkCancellation()
        if let compatible = status.candidates.first(where: { $0.state == .compatible }) {
            return try SetupPlan(capture: capture, provider: provider, requirements: requirements, reuseCandidate: compatible, artifact: nil)
        }
        await progress(.resolvingRelease)
        let artifact = try await resolver.resolve(provider: provider, architecture: configuration.architecture)
        try OfficialSourcePolicy.validate(artifact)
        guard artifact.provider == provider, artifact.architecture == configuration.architecture else { throw SetupError.wrongArchitecture }
        return try SetupPlan(capture: capture, provider: provider, requirements: requirements, reuseCandidate: nil, artifact: artifact)
        #else
        throw SetupError.unavailable
        #endif
    }
    /// currentCapture must consult live UI/host state on every invocation. An earlier captured snapshot cannot authorize commit.
    public func install(plan: SetupPlan, currentCapture: @escaping @Sendable () async throws -> SetupCapture,
                        progress: @escaping RuntimeSetupProgress = { _ in }) async throws -> SetupReceipt {
        #if os(macOS)
        try plan.validate()
        if active[plan.capture.requestID] != nil { throw SetupError.busy }
        let task = Task { try await self.perform(plan: plan, currentCapture: currentCapture, progress: progress) }
        active[plan.capture.requestID] = task
        defer { active[plan.capture.requestID] = nil }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
        #else
        throw SetupError.unavailable
        #endif
    }
    public func cancel(requestID: String) { active[requestID]?.cancel() }
    /// Bounded, read-only recovery index. Entries carry the exact request ID/hash; this does not reinstall or write acknowledgements.
    public func recoverableReceipts(provider: AssistantProvider) throws -> [SetupReceipt] {
        #if os(macOS)
        guard FileManager.default.fileExists(atPath: configuration.managedRoot.path) else { return [] }
        let store = try LocalSetupStore(root: configuration.managedRoot, create: false)
        return try store.recoverableJournals(provider: provider).compactMap { journal in
            try verifyJournal(journal, requestID: journal.plan.capture.requestID, requestHash: journal.plan.requestHash)
            return try reconcile(requestID: journal.plan.capture.requestID, requestHash: journal.plan.requestHash)
        }
        #else
        throw SetupError.unavailable
        #endif
    }
    public func reconcile(requestID: String, requestHash: String) throws -> SetupReceipt? {
        #if os(macOS)
        guard validDigest(requestHash) else { throw SetupError.requestConflict }
        guard FileManager.default.fileExists(atPath: configuration.managedRoot.path) else { return nil }
        let store = try LocalSetupStore(root: configuration.managedRoot, create: false)
        guard let journal = try store.readJournal(requestID) else { return nil }
        try verifyJournal(journal, requestID: requestID, requestHash: requestHash)
        if journal.receipt.state == .preparing || journal.receipt.state == .unknown {
            if let version = journal.versionDirectory, let record = try store.record(version),
               record.artifact == journal.plan.artifact, record.result == journal.receipt.result,
               try validatedResult(record.result, provider: journal.plan.provider, requirements: journal.plan.requirements) {
                return SetupReceipt(requestID: requestID, requestHash: requestHash, state: .committed, result: record.result)
            }
            return SetupReceipt(requestID: requestID, requestHash: requestHash, state: .unknown, error: .commitUnknown)
        }
        if journal.receipt.state == .committed {
            guard let result = journal.receipt.result,
                  try validatedResult(result, provider: journal.plan.provider, requirements: journal.plan.requirements) else { throw SetupError.artifactChanged }
            if let version = journal.versionDirectory {
                guard let record = try store.record(version), record.artifact == journal.plan.artifact,
                      record.result == result else { throw SetupError.artifactChanged }
            } else {
                guard journal.plan.action == .reuse, result.sha256 == journal.plan.reuseCandidate?.sha256,
                      result.command == journal.plan.reuseCandidate?.resolvedCommand,
                      result.version == journal.plan.reuseCandidate?.version,
                      result.capabilities == journal.plan.reuseCandidate?.capabilities else { throw SetupError.artifactChanged }
            }
        }
        return journal.receipt
        #else
        throw SetupError.unavailable
        #endif
    }
    #if os(macOS)
    private func perform(plan: SetupPlan, currentCapture: @escaping @Sendable () async throws -> SetupCapture,
                         progress: RuntimeSetupProgress) async throws -> SetupReceipt {
        // A pre-admission refusal cannot have installed anything. Persist its terminal receipt under
        // the same lock as installation, so replay after reopening cannot turn cancelled into a new effect.
        let admissionFailure: SetupError?
        do { try await assertScope(plan, currentCapture); admissionFailure = nil }
        catch {
            admissionFailure = error is CancellationError ? .cancelled : (error as? SetupError ?? .scopeChanged)
        }
        let store = try LocalSetupStore(root: configuration.managedRoot, create: true)
        try store.lock(); defer { store.unlock() }
        if let old = try store.readJournal(plan.capture.requestID) {
            await progress(.reconciling)
            try verifyJournal(old, requestID: plan.capture.requestID, requestHash: plan.requestHash)
            guard old.plan == plan else { throw SetupError.requestConflict }
            return try reconcile(requestID: plan.capture.requestID, requestHash: plan.requestHash) ?? old.receipt
        }
        if let admissionFailure {
            let refused = receipt(plan, admissionFailure == .cancelled ? .cancelled : .failed, error: admissionFailure)
            try store.writeJournal(Journal(plan: plan, receipt: refused, versionDirectory: plan.artifact.map(store.versionName)))
            return refused
        }
        var journal = Journal(plan: plan, receipt: receipt(plan, .preparing), versionDirectory: plan.artifact.map(store.versionName))
        try store.writeJournal(journal)
        var committed = false
        do {
            switch plan.action {
            case .reuse:
                await progress(.reusing)
                guard let candidate = plan.reuseCandidate, let command = candidate.resolvedCommand else { throw SetupError.planChanged }
                let fresh = await inspector.inspect(command: command, provider: plan.provider, requirements: plan.requirements)
                guard fresh.state == .compatible, fresh.sha256 == candidate.sha256, fresh.version == candidate.version,
                      fresh.resolvedCommand == command, fresh.capabilities == candidate.capabilities,
                      let hash = fresh.sha256, let version = fresh.version else { throw SetupError.artifactChanged }
                try await assertScope(plan, currentCapture); try store.assertCurrent()
                let result = RuntimeSetupResult(command: command, version: version, sha256: hash, capabilities: fresh.capabilities)
                journal.receipt = receipt(plan, .committed, result: result); try store.writeJournal(journal)
                return journal.receipt
            case .download:
                guard let artifact = plan.artifact, let version = journal.versionDirectory else { throw SetupError.planChanged }
                try OfficialSourcePolicy.validate(artifact)
                guard artifact.architecture == configuration.architecture, artifact.provider == plan.provider else { throw SetupError.wrongArchitecture }
                if let existing = try store.record(version) {
                    await progress(.verifying)
                    guard existing.artifact == artifact,
                          try validatedResult(existing.result, provider: plan.provider, requirements: plan.requirements) else { throw SetupError.artifactChanged }
                    try await assertScope(plan, currentCapture)
                    journal.receipt = receipt(plan, .committed, result: existing.result); try store.writeJournal(journal); return journal.receipt
                }
                let (stageName, handle) = try store.createStage()
                defer { store.removeOwnStage(stageName, handle: handle); close(handle) }
                let stage = store.root.appendingPathComponent(stageName, isDirectory: true)
                let download = stage.appendingPathComponent("download")
                await progress(.downloading)
                try await downloader.download(artifact, to: download, maximumBytes: configuration.maximumDownloadBytes)
                try await assertScope(plan, currentCapture); try store.assertStage(stageName, handle: handle)
                await progress(.verifying)
                let downloadedIdentity = try binaryIdentity(download, maximumBytes: configuration.maximumDownloadBytes)
                if let expected = artifact.expectedBytes, downloadedIdentity.bytes != expected { throw SetupError.truncated }
                guard try fileDigest(download, maximumBytes: configuration.maximumDownloadBytes) == artifact.sha256 else { throw SetupError.checksumMismatch }
                let staged = try await validator.materializeAndValidate(artifact, downloaded: download, stage: stage, requirements: plan.requirements)
                try await assertScope(plan, currentCapture); try store.assertStage(stageName, handle: handle)
                guard staged.command == stage.appendingPathComponent(plan.provider.rawValue).path,
                      staged.version == artifact.version, try validatedResult(staged, provider: plan.provider, requirements: plan.requirements) else { throw SetupError.artifactChanged }
                let result = RuntimeSetupResult(command: store.root.appendingPathComponent(version).appendingPathComponent(plan.provider.rawValue).path,
                    version: staged.version, sha256: staged.sha256, capabilities: staged.capabilities)
                try store.write(ArtifactRecord(artifact: artifact, result: result), name: "artifact.json", directory: handle)
                guard unlinkat(handle, "download", 0) == 0 else { throw SetupError.storageFailure }
                // Write-ahead association permits read-only recovery when commit's acknowledgement is lost.
                journal.receipt = receipt(plan, .preparing, result: result); try store.writeJournal(journal)
                await progress(.committing)
                try await assertScope(plan, currentCapture); try store.assertStage(stageName, handle: handle)
                try store.commitStage(stageName, handle: handle, version: version); committed = true
                try afterCommit?()
                journal.receipt = receipt(plan, .committed, result: result); try store.writeJournal(journal)
                return journal.receipt
            }
        } catch {
            let code = (error as? SetupError) ?? (error is CancellationError ? .cancelled : .storageFailure)
            if committed || code == .commitUnknown {
                // Never retry a potentially committed mutation. The caller must reconcile this exact request.
                return receipt(plan, .unknown, error: .commitUnknown)
            }
            journal.receipt = receipt(plan, code == .cancelled ? .cancelled : .failed, error: code)
            do { try store.writeJournal(journal) } catch { return receipt(plan, .unknown, error: .commitUnknown) }
            return journal.receipt
        }
    }
    private func assertScope(_ plan: SetupPlan, _ current: @Sendable () async throws -> SetupCapture) async throws {
        try Task.checkCancellation(); let capture = try await current(); try capture.validate()
        guard capture == plan.capture else { throw SetupError.scopeChanged }; try Task.checkCancellation()
    }
    private func receipt(_ plan: SetupPlan, _ state: SetupReceiptState, result: RuntimeSetupResult? = nil, error: SetupError? = nil) -> SetupReceipt {
        SetupReceipt(requestID: plan.capture.requestID, requestHash: plan.requestHash, state: state, result: result, error: error)
    }
    private func verifyJournal(_ journal: Journal, requestID: String, requestHash: String) throws {
        try journal.plan.validate()
        guard journal.plan.capture.requestID == requestID, journal.plan.requestHash == requestHash,
              journal.receipt.requestID == requestID, journal.receipt.requestHash == requestHash,
              journal.versionDirectory == journal.plan.artifact.map({ "\($0.provider.rawValue)-\($0.version)-\($0.architecture)-\($0.sha256.prefix(16))" }) else { throw SetupError.requestConflict }
        if let artifact = journal.plan.artifact { try OfficialSourcePolicy.validate(artifact); guard artifact.provider == journal.plan.provider else { throw SetupError.requestConflict } }
        if let result = journal.receipt.result {
            if let version = journal.versionDirectory {
                guard result.command == configuration.managedRoot.appendingPathComponent(version).appendingPathComponent(journal.plan.provider.rawValue).path,
                      result.version == journal.plan.artifact?.version else { throw SetupError.artifactChanged }
            }
        }
    }
    private func validatedResult(_ result: RuntimeSetupResult, provider: AssistantProvider, requirements: RuntimeRequirements) throws -> Bool {
        guard result.command.hasPrefix("/"), validVersion(result.version), validDigest(result.sha256),
              result.capabilities.satisfies(requirements), result.capabilities.voices.count <= 64 else { return false }
        return try fileDigest(URL(fileURLWithPath: result.command)) == result.sha256
    }
    private func managedCandidates(provider: AssistantProvider) -> [String] {
        guard let entries = try? FileManager.default.contentsOfDirectory(at: configuration.managedRoot,
                 includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles]) else { return [] }
        return entries.sorted { $0.lastPathComponent > $1.lastPathComponent }.prefix(64).compactMap { entry in
            guard entry.lastPathComponent.hasPrefix(provider.rawValue + "-"),
                  let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
                  values.isDirectory == true, values.isSymbolicLink != true else { return nil }
            return entry.appendingPathComponent(provider.rawValue).path
        }
    }
    #endif
}
