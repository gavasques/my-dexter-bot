import Foundation
import Testing
@testable import DexterAssistantRuntimeSetup
#if os(macOS)
import Darwin

actor SpyInspector: RuntimeMetadataInspecting {
    let values: [String: RuntimeCandidate]
    var calls = 0
    init(_ values: [String: RuntimeCandidate] = [:]) { self.values = values }
    func inspect(command: String, provider: AssistantProvider, requirements: RuntimeRequirements) async -> RuntimeCandidate {
        calls += 1
        return values[command] ?? RuntimeCandidate(command: command, state: .missing)
    }
}
actor SpyResolver: OfficialArtifactResolving {
    let artifact: OfficialArtifact; var calls = 0
    init(_ artifact: OfficialArtifact) { self.artifact = artifact }
    func resolve(provider: AssistantProvider, architecture: String) async throws -> OfficialArtifact { calls += 1; return artifact }
}
actor SpyDownloader: ArtifactDownloading {
    let bytes: Data; let error: SetupError?; let delay: Bool
    var calls = 0; var started = false
    init(_ bytes: Data, error: SetupError? = nil, delay: Bool = false) { self.bytes = bytes; self.error = error; self.delay = delay }
    func download(_ artifact: OfficialArtifact, to destination: URL, maximumBytes: Int64) async throws {
        calls += 1; started = true
        if delay { try await Task.sleep(for: .seconds(30)) }
        if let error { throw error }
        guard bytes.count <= maximumBytes else { throw SetupError.oversized }
        try bytes.write(to: destination, options: .withoutOverwriting)
    }
}
struct SyntheticValidator: ArtifactValidating {
    let error: SetupError?
    let replaceStage: Bool
    let escape: URL?
    init(error: SetupError? = nil, replaceStage: Bool = false, escape: URL? = nil) { self.error = error; self.replaceStage = replaceStage; self.escape = escape }
    func materializeAndValidate(_ artifact: OfficialArtifact, downloaded: URL, stage: URL,
                                requirements: RuntimeRequirements) async throws -> RuntimeSetupResult {
        if let error { throw error }
        let command = stage.appendingPathComponent(artifact.provider.rawValue)
        try FileManager.default.copyItem(at: downloaded, to: command)
        let hash = try fileDigest(command)
        if let escape { try FileManager.default.removeItem(at: command); try FileManager.default.createSymbolicLink(at: command, withDestinationURL: escape) }
        if replaceStage {
            let moved = stage.appendingPathExtension("moved")
            try FileManager.default.moveItem(at: stage, to: moved)
            try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        return RuntimeSetupResult(command: command.path, version: artifact.version, sha256: hash,
            capabilities: RuntimeCapabilities(text: true, nativeVoice: requirements.nativeVoice, voices: requirements.nativeVoice ? ["cove"] : []))
    }
}
struct Fixture {
    let base: URL; let config: SetupConfiguration; let bytes = Data("synthetic dexter executable bytes; never executed".utf8)
    let capture = SetupCapture(hostID: "owned-local-test", bundleID: "bot.dexter.test", selectionGeneration: "generation-1", windowID: "window-1", requestID: "request-1")
    init(maximumBytes: Int64 = 768 * 1024 * 1024) throws {
        base = try scratchDirectory()
        config = SetupConfiguration(managedRoot: base.appendingPathComponent("managed"), maximumDownloadBytes: maximumBytes)
    }
    var artifact: OfficialArtifact { OfficialArtifact(provider: .claude, version: "2.1.296", architecture: config.architecture,
        url: URL(string: "https://downloads.claude.ai/claude-code-releases/2.1.296/\(config.architecture == "arm64" ? "darwin-arm64" : "darwin-x64")/claude")!,
        sha256: digest(bytes), expectedBytes: Int64(bytes.count)) }
    func runtime(downloader: SpyDownloader? = nil, validator: SyntheticValidator = .init()) -> AssistantRuntimeSetup {
        AssistantRuntimeSetup(configuration: config, inspector: SpyInspector(), resolver: SpyResolver(artifact),
            downloader: downloader ?? SpyDownloader(bytes), validator: validator)
    }
    func cleanup() { try? FileManager.default.removeItem(at: base) }
}

@Test func compatibleCandidateIsReusedAndSavedOlderChoiceIsPreserved() async throws {
    let f = try Fixture(); defer { f.cleanup() }
    let old = f.base.appendingPathComponent("older-cli"); let modern = f.base.appendingPathComponent("new-cli")
    try f.bytes.write(to: old); try f.bytes.write(to: modern)
    let good = RuntimeCandidate(command: modern.path, resolvedCommand: modern.path, sha256: digest(f.bytes), version: "2.1.296",
                                state: .compatible, capabilities: .init(text: true))
    let inspector = SpyInspector([old.path: RuntimeCandidate(command: old.path, version: "1.0.55", state: .needsUpdate), modern.path: good])
    let resolver = SpyResolver(f.artifact); let downloader = SpyDownloader(f.bytes)
    let runtime = AssistantRuntimeSetup(configuration: f.config, inspector: inspector, resolver: resolver,
        downloader: downloader, validator: SyntheticValidator(), candidates: [.claude: [old.path, modern.path]])
    let inspection = await runtime.inspect(provider: .claude, selectedCommand: old.path)
    #expect(inspection.selectedCommand == old.path)
    #expect(inspection.candidates.first?.state == .needsUpdate)
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude, preferredCommand: old.path)
    #expect(plan.action == .reuse)
    let receipt = try await runtime.install(plan: plan, currentCapture: { f.capture })
    #expect(receipt.state == .committed); #expect(receipt.result?.command == modern.path)
    #expect(await resolver.calls == 0); #expect(await downloader.calls == 0)
}

@Test func installCommitsAtomicallyAndRepeatsWithoutRedownloadOrJournalRewrite() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let downloader = SpyDownloader(f.bytes); let runtime = f.runtime(downloader: downloader)
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    let first = try await runtime.install(plan: plan, currentCapture: { f.capture })
    #expect(first.state == .committed); #expect(first.result?.authentication == "unknown")
    let store = try LocalSetupStore(root: f.config.managedRoot, create: false)
    let journal = f.config.managedRoot.appendingPathComponent(store.journalName(f.capture.requestID))
    let before = try Data(contentsOf: journal); let metadata = try journal.resourceValues(forKeys: [.contentModificationDateKey])
    let second = try await runtime.install(plan: plan, currentCapture: { f.capture })
    #expect(second == first); #expect(await downloader.calls == 1)
    #expect(try Data(contentsOf: journal) == before)
    #expect(try journal.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate == metadata.contentModificationDate)
    #expect(try await runtime.reconcile(requestID: f.capture.requestID, requestHash: plan.requestHash) == first)
    #expect(try FileManager.default.contentsOfDirectory(atPath: f.config.managedRoot.path).filter { $0.hasPrefix(".stage") }.isEmpty)
}

@Test func lostCommitAcknowledgementRecoversReadOnlyWithoutReinstall() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let downloader = SpyDownloader(f.bytes)
    let runtime = AssistantRuntimeSetup(configuration: f.config, inspector: SpyInspector(), resolver: SpyResolver(f.artifact),
        downloader: downloader, validator: SyntheticValidator(), afterCommit: { throw SetupError.storageFailure })
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    let unknown = try await runtime.install(plan: plan, currentCapture: { f.capture })
    #expect(unknown.state == .unknown); #expect(unknown.result == nil)
    let filesBefore = try FileManager.default.contentsOfDirectory(atPath: f.config.managedRoot.path)
    let reconciled = try await runtime.reconcile(requestID: f.capture.requestID, requestHash: plan.requestHash)
    #expect(reconciled?.state == .committed); #expect(reconciled?.result?.sha256 == digest(f.bytes))
    #expect(try await runtime.recoverableReceipts(provider: .claude) == [reconciled!])
    #expect(try await runtime.recoverableReceipts(provider: .codex).isEmpty)
    let reopened = f.runtime(downloader: downloader)
    let replay = try await reopened.install(plan: plan, currentCapture: { f.capture })
    #expect(replay == reconciled); #expect(await downloader.calls == 1)
    #expect(try FileManager.default.contentsOfDirectory(atPath: f.config.managedRoot.path) == filesBefore)
}

@Test func failedDownloadIsDurableAndSameRequestNeverRetries() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let download = SpyDownloader(f.bytes, error: .downloadFailed); let runtime = f.runtime(downloader: download)
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    let failed = try await runtime.install(plan: plan, currentCapture: { f.capture })
    #expect(failed.state == .failed); #expect(failed.error == .downloadFailed)
    #expect(try await runtime.install(plan: plan, currentCapture: { f.capture }) == failed)
    #expect(await download.calls == 1)
}

@Test func exactHashConflictAndTamperedPlanAreRejected() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let runtime = f.runtime()
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    _ = try await runtime.install(plan: plan, currentCapture: { f.capture })
    await #expect(throws: SetupError.requestConflict) { try await runtime.reconcile(requestID: f.capture.requestID, requestHash: String(repeating: "b", count: 64)) }
    let changed = try SetupPlan(capture: f.capture, provider: .claude, requirements: .init(nativeVoice: true), reuseCandidate: nil, artifact: f.artifact)
    await #expect(throws: SetupError.requestConflict) { try await runtime.install(plan: changed, currentCapture: { f.capture }) }
    let bytes = try JSONEncoder().encode(plan)
    var object = try #require(JSONSerialization.jsonObject(with: bytes) as? [String: Any]); object["requestHash"] = String(repeating: "f", count: 64)
    let tampered = try JSONDecoder().decode(SetupPlan.self, from: JSONSerialization.data(withJSONObject: object))
    await #expect(throws: SetupError.planChanged) { try await runtime.install(plan: tampered, currentCapture: { f.capture }) }
}

actor LiveCapture {
    var calls = 0; let initial: SetupCapture
    init(_ capture: SetupCapture) { initial = capture }
    func read() -> SetupCapture {
        calls += 1
        return calls < 2 ? initial : SetupCapture(hostID: "changed-host", bundleID: initial.bundleID,
            selectionGeneration: initial.selectionGeneration, windowID: initial.windowID, requestID: initial.requestID)
    }
}
@Test func liveScopeChangeAfterDownloadPreventsCommit() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let runtime = f.runtime(); let capture = LiveCapture(f.capture)
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    let receipt = try await runtime.install(plan: plan, currentCapture: { await capture.read() })
    #expect(receipt.state == .failed); #expect(receipt.error == .scopeChanged)
    #expect(try FileManager.default.contentsOfDirectory(atPath: f.config.managedRoot.path).allSatisfy { !$0.hasPrefix("claude-") })
}

@Test func cancellationAndReopenNeverRedownloadOrCommit() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let downloader = SpyDownloader(f.bytes, delay: true); let runtime = f.runtime(downloader: downloader)
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    let work = Task { try await runtime.install(plan: plan, currentCapture: { f.capture }) }
    let deadline = Date().addingTimeInterval(3)
    while !(await downloader.started) && Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
    if !(await downloader.started) { work.cancel(); let premature = try await work.value; Issue.record("Download never started: \(premature)"); return }
    await runtime.cancel(requestID: f.capture.requestID)
    let cancelled = try await work.value
    #expect(cancelled.state == .cancelled); #expect(cancelled.error == .cancelled)
    let reopen = f.runtime(downloader: downloader)
    #expect(try await reopen.install(plan: plan, currentCapture: { f.capture }) == cancelled)
    #expect(await downloader.calls == 1)
}

@Test(arguments: [SetupError.wrongArchitecture, .signatureRejected, .notarizationRejected, .versionMismatch])
func validatorFailureLeavesNoCommittedArtifact(error: SetupError) async throws {
    let f = try Fixture(); defer { f.cleanup() }; let runtime = f.runtime(validator: .init(error: error))
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    let receipt = try await runtime.install(plan: plan, currentCapture: { f.capture })
    #expect(receipt.state == .failed); #expect(receipt.error == error)
    #expect(try FileManager.default.contentsOfDirectory(atPath: f.config.managedRoot.path).allSatisfy { !$0.hasPrefix("claude-") && !$0.hasPrefix(".stage-") })
}

@Test func mismatchedDigestTruncationAndOversizedPayloadAreRejected() async throws {
    let f = try Fixture(); defer { f.cleanup() }
    let bad = SpyDownloader(Data(repeating: 65, count: f.bytes.count))
    let runtime = f.runtime(downloader: bad); let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    #expect(try await runtime.install(plan: plan, currentCapture: { f.capture }).error == .checksumMismatch)
    let g = try Fixture(); defer { g.cleanup() }; let short = g.runtime(downloader: SpyDownloader(Data("short".utf8)))
    let shortPlan = try await short.prepare(capture: g.capture, provider: .claude)
    #expect(try await short.install(plan: shortPlan, currentCapture: { g.capture }).error == .truncated)
    let h = try Fixture(maximumBytes: 10); defer { h.cleanup() }; let over = h.runtime()
    let overPlan = try await over.prepare(capture: h.capture, provider: .claude)
    #expect(try await over.install(plan: overPlan, currentCapture: { h.capture }).error == .oversized)
}

@Test func stageReplacementRaceAndSymlinkEscapeAreRejected() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let replaced = f.runtime(validator: .init(replaceStage: true))
    let plan = try await replaced.prepare(capture: f.capture, provider: .claude)
    #expect(try await replaced.install(plan: plan, currentCapture: { f.capture }).error == .artifactChanged)
    let g = try Fixture(); defer { g.cleanup() }; let outside = g.base.appendingPathComponent("outside")
    try g.bytes.write(to: outside)
    let escaped = g.runtime(validator: .init(escape: outside))
    let other = try await escaped.prepare(capture: g.capture, provider: .claude)
    #expect(try await escaped.install(plan: other, currentCapture: { g.capture }).error == .unsafePath)
    #expect(try Data(contentsOf: outside) == g.bytes)
}

@Test func managedRootAndReceiptSymlinksCannotEscape() async throws {
    let f = try Fixture(); defer { f.cleanup() }
    let outside = f.base.appendingPathComponent("outside")
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    try FileManager.default.createSymbolicLink(at: f.config.managedRoot, withDestinationURL: outside)
    let runtime = f.runtime(); let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    await #expect(throws: SetupError.unsafePath) { try await runtime.install(plan: plan, currentCapture: { f.capture }) }
    #expect(try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty)
}

@Test func unsafeRedirectsPathsAndSourcesAreDenied() throws {
    let approved = URL(string: "https://downloads.claude.ai/claude-code-releases/2.1.296/darwin-arm64/claude")!
    for value in ["https://evil.example/claude", "https://downloads.claude.ai.evil.example/claude-code-releases/x", "http://downloads.claude.ai/claude-code-releases/x",
                  "https://user@downloads.claude.ai/claude-code-releases/x", "https://downloads.claude.ai/claude-code-releases/%2e%2e/auth"] {
        #expect(!OfficialSourcePolicy.allowsRedirect(from: approved, to: URL(string: value)!, provider: .claude))
    }
    #expect(!OfficialSourcePolicy.allowsRedirect(from: approved, to: URL(string: "https://downloads.claude.ai/claude-code-releases/other")!, provider: .claude))
    #expect(OfficialSourcePolicy.allowsRedirect(from: approved, to: approved, provider: .claude))
}

@Test func archiveLinksTraversalAndMultipleEntriesAreDenied() throws {
    for entry in ["../codex", "/codex", "a/codex", "-codex"] {
        #expect(throws: SetupError.unsafeArchive) {
            try validateSingleArchiveEntry(listing: Data((entry + "\n").utf8), verbose: Data(("-rwx 0 100 " + entry + "\n").utf8), expected: entry)
        }
    }
    for mode in ["l", "h", "d"] {
        #expect(throws: SetupError.unsafeArchive) { try validateSingleArchiveEntry(listing: Data("codex-aarch64-apple-darwin\n".utf8),
            verbose: Data((mode + "rwx 0 100 codex-aarch64-apple-darwin\n").utf8), expected: "codex-aarch64-apple-darwin") }
    }
    #expect(throws: SetupError.unsafeArchive) { try validateSingleArchiveEntry(listing: Data("codex-aarch64-apple-darwin\nother\n".utf8),
        verbose: Data("-rwx 0 100 codex-aarch64-apple-darwin\n".utf8), expected: "codex-aarch64-apple-darwin") }
}

@Test func machOAndVendorValidationRejectWrongArchitectureAndUnsignedFileWithoutExecution() throws {
    let f = try Fixture(); defer { f.cleanup() }; let file = f.base.appendingPathComponent("macho")
    var header = Data(repeating: 0, count: 64)
    header.replaceSubrange(0..<4, with: [0xcf, 0xfa, 0xed, 0xfe]); header.replaceSubrange(4..<8, with: [0x0c, 0, 0, 0x01]); header[12] = 2
    try header.write(to: file)
    try validateMachO(file, architecture: "arm64")
    #expect(throws: SetupError.wrongArchitecture) { try validateMachO(file, architecture: "x86_64") }
    #expect(throws: SetupError.signatureRejected) { try validateVendorSignature(file, provider: .claude) }
}

@Test func authenticationSecretsAndCallerEnvironmentNeverEnterMetadataOrReceipts() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let file = f.base.appendingPathComponent("synthetic-claude")
    let flags = claudeRequiredFlags.joined(separator: " ") + " "
    let script = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  case \"$HOME\" in *dexter-assistant-metadata-*) ;; *) exit 11;; esac\n  [ -z \"${ANTHROPIC_API_KEY:-}\" ] || exit 12\n  [ -z \"${OPENAI_API_KEY:-}\" ] || exit 13\n  [ -z \"${CODEX_HOME:-}\" ] || exit 14\n  printf '2.1.296 (synthetic fixture)\\n'\nelse\n  printf '%s\\n' '\(flags)'\nfi\n"
    try Data(script.utf8).write(to: file); _ = chmod(file.path, 0o700)
    let inspected = await LocalRuntimeMetadataInspector().inspect(command: file.path, provider: .claude, requirements: .init())
    #expect(inspected.state == .compatible); #expect(inspected.authentication == "unknown")
    let runtime = f.runtime(); let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    let receipt = try await runtime.install(plan: plan, currentCapture: { f.capture })
    let serialized = try #require(String(data: JSONEncoder().encode(receipt), encoding: .utf8))
    #expect(!serialized.contains("HOME")); #expect(!serialized.contains("TOKEN")); #expect(!serialized.contains("auth.json"))
    #expect(!serialized.contains("stdout")); #expect(!serialized.contains("stderr"))
}

@Test func uncertainWriteAheadReceiptRemainsUnknownAndCannotRedownload() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let downloader = SpyDownloader(f.bytes); let runtime = f.runtime(downloader: downloader)
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    let store = try LocalSetupStore(root: f.config.managedRoot, create: true)
    try store.writeJournal(Journal(plan: plan, receipt: SetupReceipt(requestID: f.capture.requestID, requestHash: plan.requestHash, state: .preparing),
        versionDirectory: store.versionName(f.artifact)))
    #expect(try await runtime.reconcile(requestID: f.capture.requestID, requestHash: plan.requestHash)?.state == .unknown)
    #expect(try await runtime.install(plan: plan, currentCapture: { f.capture }).state == .unknown)
    #expect(await downloader.calls == 0)
}

@Test func mutatedReceiptProviderResultAndArtifactAreNotAccepted() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let runtime = f.runtime()
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    let receipt = try await runtime.install(plan: plan, currentCapture: { f.capture })
    let store = try LocalSetupStore(root: f.config.managedRoot, create: false)
    var journal = try #require(try store.readJournal(f.capture.requestID))
    let result = try #require(receipt.result)
    journal.receipt = SetupReceipt(requestID: receipt.requestID, requestHash: receipt.requestHash, state: .committed,
        result: RuntimeSetupResult(command: result.command.replacingOccurrences(of: "/claude", with: "/codex"), version: result.version,
                                   sha256: result.sha256, capabilities: result.capabilities))
    try store.writeJournal(journal)
    await #expect(throws: SetupError.artifactChanged) { try await runtime.reconcile(requestID: receipt.requestID, requestHash: receipt.requestHash) }
    let other = f.base.appendingPathComponent("other")
    try Data("original outside data".utf8).write(to: other)
    let target = f.config.managedRoot.appendingPathComponent(store.journalName(receipt.requestID))
    try FileManager.default.removeItem(at: target); try FileManager.default.createSymbolicLink(at: target, withDestinationURL: other)
    await #expect(throws: SetupError.unsafePath) { try await runtime.reconcile(requestID: receipt.requestID, requestHash: receipt.requestHash) }
    #expect(try String(contentsOf: other, encoding: .utf8) == "original outside data")
}

@Test func staticCodexSchemaRequiresRealMethodsAndVoiceContract() throws {
    let f = try Fixture(); defer { f.cleanup() }
    let schema = f.base.appendingPathComponent("schema"); try FileManager.default.createDirectory(at: schema, withIntermediateDirectories: false)
    let methods = ["thread/start", "thread/resume", "turn/start", "turn/interrupt", "thread/realtime/start", "thread/realtime/stop", "thread/realtime/appendText", "thread/realtime/appendSpeech"]
    let requests: [String: Any] = ["oneOf": methods.map { ["properties": ["method": ["const": $0]]] }, "experimentalApi": true]
    try JSONSerialization.data(withJSONObject: requests).write(to: schema.appendingPathComponent("ClientRequest.json"))
    #expect(try codexCapabilities(schema: schema) == .init(text: true))
    let v2 = schema.appendingPathComponent("v2"); try FileManager.default.createDirectory(at: v2, withIntermediateDirectories: false)
    let start: [String: Any] = ["properties": Dictionary(uniqueKeysWithValues: ["threadId", "clientManagedHandoffs", "transport", "initialItems", "voice"].map { ($0, [:] as [String: String]) }),
        "definitions": ["RealtimeConversationVersion": ["enum": ["v3"]], "ThreadRealtimeStartTransport": ["enum": ["webrtc"]], "RealtimeVoice": ["enum": ["cove"]]]]
    try JSONSerialization.data(withJSONObject: start).write(to: v2.appendingPathComponent("ThreadRealtimeStartParams.json"))
    for name in ["ThreadRealtimeSdpNotification", "ThreadRealtimeStartedNotification", "ThreadRealtimeTranscriptDoneNotification", "ThreadRealtimeItemAddedNotification", "ThreadRealtimeClosedNotification"] {
        try Data("{}".utf8).write(to: v2.appendingPathComponent(name + ".json"))
    }
    #expect(try codexCapabilities(schema: schema) == .init(text: true, nativeVoice: true, voices: ["cove"]))
    try FileManager.default.removeItem(at: v2.appendingPathComponent("ThreadRealtimeClosedNotification.json"))
    #expect(try !codexCapabilities(schema: schema).nativeVoice)
    let invalid: [String: Any] = ["oneOf": [["properties": ["method": ["const": "turn/start"]]]], "description": methods.joined(separator: " ")]
    try JSONSerialization.data(withJSONObject: invalid).write(to: schema.appendingPathComponent("ClientRequest.json"))
    #expect(try !codexCapabilities(schema: schema).text)
}
#else
@Test func iOSDoesNotExposeAnInstaller() throws {
    #expect(throws: SetupError.unavailable) { try AssistantRuntimeSetup.production() }
}
#endif
